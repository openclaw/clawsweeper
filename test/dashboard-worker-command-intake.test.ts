import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import http from "node:http";

import { ExactReviewCommandIntakeStore } from "../dashboard/exact-review-command-intake.ts";
import { convergeCommandAcknowledgement } from "../dashboard/exact-review-queue.ts";
import { directReReviewIntake } from "../src/repair/direct-re-review-admission.ts";
import {
  assert,
  ExactReviewQueue,
  ExactReviewLifecycleProjectionStore,
  MemoryKv,
  MemoryDurableNamespace,
  MemoryDurableStorage,
  test,
  summarizeBayJourneyTimings,
  worker,
} from "./dashboard-worker-harness.ts";

const COMMAND_BODY = "@clawsweeper re-review\n\nPlease check the current head.";
const COMMAND_UPDATED_AT = "2026-08-12T16:25:26Z";
const COMMAND_COMMENT_ID = 9_001;
const ITEM_NUMBER = 42;
const HEAD_SHA = "a".repeat(40);

test("command intake migrations, watermarks, receipts, and revisions stay idempotent", () => {
  const storage = new MemoryDurableStorage();
  const store = new ExactReviewCommandIntakeStore(storage);
  store.ensureSchemaSync();
  const first = intakeFixture({ updatedAt: "2026-08-12T16:25:26Z", body: COMMAND_BODY });
  const second = intakeFixture({
    updatedAt: "2026-08-12T16:25:27Z",
    body: `${COMMAND_BODY}\nOne more detail.`,
  });
  const now = Date.parse("2026-08-12T16:30:00Z");

  assert.deepEqual(store.admit(first, now), {
    accepted: true,
    deduped: false,
    commandVersionId: first.commandVersionId,
  });
  assert.deepEqual(store.admit(first, now + 1), {
    accepted: true,
    deduped: true,
    commandVersionId: first.commandVersionId,
  });
  assert.equal(store.admit(second, now + 2)?.accepted, true);
  assert.deepEqual(
    store.due(now + 2).map((record) => record.intake.commandVersionId),
    [second.commandVersionId],
  );
  assert.equal(receiptOutcome(storage, first.commandVersionId), "superseded");
  assert.equal(receiptOutcome(storage, second.commandVersionId), "pending");

  const due = store.due(now + 2)[0]!;
  store.defer(due, now + 2, "rate_limited");
  const nextAttemptAt = store.nextAttemptAt();
  assert.ok(nextAttemptAt !== null && nextAttemptAt >= now + 2 + 15_000);
  assert.ok(nextAttemptAt !== null && nextAttemptAt <= now + 2 + 15 * 60_000);
  assert.equal(store.allocateItemRevision("openclaw/openclaw#42", 1, 0, 0), 1);
  assert.equal(store.allocateItemRevision("openclaw/openclaw#42", 1, 0, 0), 2);
  assert.deepEqual(
    Array.from(
      storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('exact_review_command_intakes', 'exact_review_command_receipts', 'exact_review_command_watermarks', 'exact_review_item_revisions') ORDER BY name",
      ),
      (row) => row.name,
    ),
    [
      "exact_review_command_intakes",
      "exact_review_command_receipts",
      "exact_review_command_watermarks",
      "exact_review_item_revisions",
    ],
  );
});

test("signed command intake rejects nonpublic visibility before storing command content", async () => {
  for (const outcome of ["terminal", "retryable"] as const) {
    const storage = new MemoryDurableStorage();
    const retryAt = Date.now() + 60_000;
    let probes = 0;
    const queue = new ExactReviewQueue(
      { storage },
      {
        hostedPublicTargetProbe: async () => {
          probes += 1;
          return { outcome, retryAt };
        },
      },
    );
    const intake = intakeFixture({ updatedAt: COMMAND_UPDATED_AT, body: COMMAND_BODY });
    const body = JSON.stringify(intake);
    const secret = "synthetic-intake-proof";
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/command-intake", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );
    assert.equal(response.status, outcome === "terminal" ? 422 : 503);
    assert.equal(probes, 1);
    if (outcome === "retryable") assert.ok(Number(response.headers.get("retry-after")) > 0);
    for (const table of [
      "exact_review_command_intakes",
      "exact_review_command_receipts",
      "exact_review_command_watermarks",
      "exact_review_command_bay_journeys",
      "exact_review_item_revisions",
    ]) {
      assert.equal(
        Number(Array.from(storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`))[0]?.count),
        0,
        table,
      );
    }
    assert.equal(await storage.getAlarm(), null);
  }
});

test("admitted public commands recheck visibility before consuming credentials", async () => {
  const intake = intakeFixture({ updatedAt: COMMAND_UPDATED_AT, body: COMMAND_BODY });
  const request = () =>
    new Request("https://clawsweeper-exact-review-queue/command-intake", {
      method: "POST",
      body: JSON.stringify(intake),
    });

  const terminalStorage = new MemoryDurableStorage();
  let terminalPublic = true;
  const terminalQueue = new ExactReviewQueue(
    { storage: terminalStorage },
    { hostedPublicTargetProbe: async () => (terminalPublic ? "public" : "terminal") },
  );
  const terminalAccepted = await terminalQueue.fetch(request());
  assert.equal(terminalAccepted.status, 202);
  assert.equal((await terminalAccepted.json()).accepted, true);
  assert.equal(commandReceiptOutcome(terminalStorage), "pending");
  terminalPublic = false;
  await terminalQueue.alarm();
  assert.equal(commandReceipt(terminalStorage)?.outcome, "rejected");
  assert.equal(commandReceipt(terminalStorage)?.detail, "private_target_unsupported");
  terminalPublic = true;
  const terminalRedelivery = await terminalQueue.fetch(request());
  assert.equal(terminalRedelivery.status, 202);
  assert.deepEqual(await terminalRedelivery.json(), {
    ok: true,
    accepted: false,
    reason: "private_target_unsupported",
    command_version_id: intake.commandVersionId,
  });

  const transientStorage = new MemoryDurableStorage();
  let transientPublic = true;
  let probes = 0;
  const transientQueue = new ExactReviewQueue(
    { storage: transientStorage },
    {
      hostedPublicTargetProbe: async () => {
        probes += 1;
        return transientPublic ? "public" : "retryable";
      },
    },
  );
  const transientAccepted = await transientQueue.fetch(request());
  assert.equal(transientAccepted.status, 202);
  assert.equal((await transientAccepted.json()).accepted, true);
  transientPublic = false;
  for (let attempts = 1; attempts < 16; attempts += 1) {
    transientStorage.sql.exec(
      "UPDATE exact_review_command_intakes SET next_attempt_at = 0 WHERE command_version_id = ?",
      intake.commandVersionId,
    );
    await transientQueue.alarm();
    assert.equal(commandReceiptOutcome(transientStorage), "pending");
    assert.equal(commandIntakeAttempts(transientStorage, intake.commandVersionId), attempts);
  }
  transientStorage.sql.exec(
    "UPDATE exact_review_command_intakes SET next_attempt_at = 0 WHERE command_version_id = ?",
    intake.commandVersionId,
  );
  await transientQueue.alarm();
  assert.equal(probes, 17);
  assert.equal(commandReceipt(transientStorage)?.outcome, "rejected");
  assert.equal(commandReceipt(transientStorage)?.detail, "target_visibility_unverified_exhausted");
  assert.equal(commandIntakeRecord(transientStorage, intake.commandVersionId), null);
  transientPublic = true;
  const transientRedelivery = await transientQueue.fetch(request());
  assert.equal(transientRedelivery.status, 202);
  assert.deepEqual(await transientRedelivery.json(), {
    ok: true,
    accepted: false,
    reason: "target_visibility_unverified_exhausted",
    command_version_id: intake.commandVersionId,
  });
});

test("command intake rejects an ineligible hosted target before durable intake", async () => {
  const storage = new MemoryDurableStorage();
  let visibilityProbes = 0;
  const queue = new ExactReviewQueue(
    { storage },
    {
      hostedTargetPredicate: () => false,
      hostedPublicTargetProbe: async () => {
        visibilityProbes += 1;
        return "public";
      },
    },
  );
  const intake = intakeFixture({
    updatedAt: COMMAND_UPDATED_AT,
    body: COMMAND_BODY,
    targetRepo: "outside/public-repo",
  });
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/command-intake", {
      method: "POST",
      body: JSON.stringify(intake),
    }),
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "private_target_unsupported" });
  assert.equal(visibilityProbes, 0);
  assert.equal(
    Number(
      Array.from(storage.sql.exec("SELECT COUNT(*) AS count FROM exact_review_command_intakes"))[0]
        ?.count ?? 0,
    ),
    0,
  );
  assert.equal(
    Number(
      Array.from(storage.sql.exec("SELECT COUNT(*) AS count FROM exact_review_command_receipts"))[0]
        ?.count ?? 0,
    ),
    0,
  );
});

test("Worker forwards its eligibility fact without a second queue lookup", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    {
      hostedTargetPredicate: () => {
        throw new Error("queue repeated hosted target eligibility lookup");
      },
    },
  );
  const namespace = new MemoryDurableNamespace(queue);
  const intake = intakeFixture({
    updatedAt: COMMAND_UPDATED_AT,
    body: COMMAND_BODY,
    targetRepo: "partner/configured-repo",
  });
  const body = JSON.stringify(intake);
  const secret = "prepared-hosted-target-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  let workerEligibilityChecks = 0;

  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/command-intake", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      EXACT_REVIEW_QUEUE: namespace,
      hostedTargetPredicate: () => {
        workerEligibilityChecks += 1;
        return true;
      },
    },
  );

  assert.equal(response.status, 202);
  assert.equal((await response.json()).accepted, true);
  assert.equal(workerEligibilityChecks, 1);
  assert.equal(
    Number(
      Array.from(storage.sql.exec("SELECT COUNT(*) AS count FROM exact_review_command_intakes"))[0]
        ?.count ?? 0,
    ),
    1,
  );
});

test("a verified same-timestamp edit fences an older receipt before enqueue effects", () => {
  const storage = new MemoryDurableStorage();
  const store = new ExactReviewCommandIntakeStore(storage);
  store.ensureSchemaSync();
  const now = Date.parse("2026-08-12T16:30:00Z");
  const first = intakeFixture({ updatedAt: COMMAND_UPDATED_AT, body: COMMAND_BODY });
  const edited = intakeFixture({
    updatedAt: COMMAND_UPDATED_AT,
    body: `${COMMAND_BODY}\nEdited in the same timestamp tick.`,
  });
  assert.equal(store.admit(first, now)?.accepted, true);
  const firstRecord = store.due(now)[0]!;
  assert.equal(store.markVerified(firstRecord, now + 1), true);
  const verifiedFirst = {
    ...first.decision,
    sourceCommentVerified: true as const,
    sourceHeadSha: HEAD_SHA,
    sourceHeadVerified: true as const,
    sourceAuthoritySeq: 1,
  };
  store.advance(first.commandVersionId, "enqueue_pending", now + 1, verifiedFirst);
  assert.equal(store.admit(edited, now + 2)?.accepted, true);
  const editedRecord = store
    .due(now + 2)
    .find((record) => record.intake.commandVersionId === edited.commandVersionId)!;
  assert.equal(store.markVerified(editedRecord, now + 3), true);

  assert.equal(receiptOutcome(storage, first.commandVersionId), "superseded");
  assert.equal(store.isCurrent({ ...firstRecord, stage: "enqueue_pending" }), false);
  assert.deepEqual(
    store.due(now + 3).map((record) => record.intake.commandVersionId),
    [edited.commandVersionId],
  );
});

test("durable command intake survives target throttling before queue admission", async (t) => {
  const fixture = await startGithubLoopback();
  t.after(() => fixture.close());

  await assert.rejects(
    mainEquivalentOldCommandPath(fixture.origin),
    /old command dispatch failed: 403/,
  );
  assert.equal(fixture.acknowledgements.length, 1);
  assert.equal(fixture.durableIntakes, 0);

  fixture.acknowledgements.length = 0;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const env = {
    GITHUB_API_URL: fixture.origin,
    CLAWSWEEPER_WEBHOOK_SECRET: "command-intake-test-secret",
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23command-intake-test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
  };
  const queue = new ExactReviewQueue({ storage }, env);
  const namespace = new MemoryDurableNamespace(queue);
  const payload = commandWebhookPayload();
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", env.CLAWSWEEPER_WEBHOOK_SECRET)
    .update(body)
    .digest("hex")}`;

  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "delivery-command-1",
        "x-hub-signature-256": signature,
      },
      body,
    }),
    { ...env, EXACT_REVIEW_QUEUE: namespace },
    {},
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    ok: true,
    accepted: true,
    deduped: false,
    command_version_id: commandVersionId(),
    bay_journey_delivery_id: "delivery-command-1",
  });
  assert.equal(fixture.acknowledgements.length, 0);

  fixture.throttleSourceComment = true;
  await queue.alarm();
  assert.equal(fixture.sourceCommentReads, 1);
  assert.equal(fixture.acknowledgements.length, 0);
  assert.equal(commandReceiptOutcome(storage), "pending");

  const deferred = Array.from(
    storage.sql.exec(
      "SELECT next_attempt_at FROM exact_review_command_intakes WHERE command_version_id = ?",
      commandVersionId(),
    ),
  )[0];
  const throttledState = (await storage.get("exact-review-queue")) as {
    dispatcher?: { githubCredentialCircuits?: Record<string, { retryAt: number }> };
  };
  const targetCircuit =
    throttledState.dispatcher?.githubCredentialCircuits?.["target_app:openclaw"];
  assert.ok(targetCircuit);
  assert.ok(Number(deferred?.next_attempt_at) > targetCircuit.retryAt);
  assert.ok(Number(deferred?.next_attempt_at) <= targetCircuit.retryAt + 30_000);

  fixture.throttleSourceComment = false;
  storage.sql.exec("UPDATE exact_review_command_intakes SET next_attempt_at = 0");
  const state = (await storage.get("exact-review-queue")) as {
    dispatcher?: { githubCredentialCircuits?: Record<string, { retryAt: number }> };
  };
  for (const circuit of Object.values(state.dispatcher?.githubCredentialCircuits || {})) {
    circuit.retryAt = 0;
  }
  await storage.put("exact-review-queue", state);
  await queue.alarm();

  const queued = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: Record<string, unknown> }>;
  };
  const item = queued.items[`openclaw/openclaw#${ITEM_NUMBER}`];
  assert.ok(item, JSON.stringify({ queued, receipt: commandReceipt(storage) }));
  assert.equal(item.decision.sourceDeliveryId, commandVersionId());
  assert.equal(item.decision.sourceHeadSha, HEAD_SHA);
  assert.equal(item.decision.sourceCommentVerified, true);
  assert.equal(commandReceiptOutcome(storage), "completed");
  assert.equal(fixture.acknowledgements.length, 1);
  assert.match(
    fixture.acknowledgements[0]!.body,
    /clawsweeper-command-status:42:re_review:command-/,
  );
  assert.equal(fixture.reactions, 1);

  const redelivery = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "delivery-command-1-redelivery",
        "x-hub-signature-256": signature,
      },
      body,
    }),
    { ...env, EXACT_REVIEW_QUEUE: namespace },
    {},
  );
  assert.equal(redelivery.status, 202);
  assert.equal((await redelivery.json()).deduped, true);
  assert.equal(fixture.acknowledgements.length, 1);
});

test("hosted durable command intake keeps the GitHub delivery identity for Bay journey completion", async (t) => {
  const fixture = await startGithubLoopback();
  t.after(() => fixture.close());
  const storage = new MemoryDurableStorage();
  const statusStore = new MemoryKv();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const env = {
    GITHUB_API_URL: fixture.origin,
    CLAWSWEEPER_WEBHOOK_SECRET: "bay-journey-command-intake-test-secret",
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23bay-journey-command-intake-test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
    STATUS_STORE: statusStore,
  };
  const queue = new ExactReviewQueue({ storage }, env);
  const namespace = new MemoryDurableNamespace(queue);
  const payload = commandWebhookPayload();
  const commandAt = new Date(Date.now() - 120_000).toISOString();
  payload.comment.created_at = commandAt;
  payload.comment.updated_at = commandAt;
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", env.CLAWSWEEPER_WEBHOOK_SECRET)
    .update(body)
    .digest("hex")}`;
  const commandDeliveryId = "github-command-delivery-1";
  const { STATUS_STORE: _statusStore, ...envWithoutStatusStore } = env;

  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": commandDeliveryId,
        "x-hub-signature-256": signature,
      },
      body,
    }),
    { ...envWithoutStatusStore, EXACT_REVIEW_QUEUE: namespace },
    {},
  );
  assert.equal(accepted.status, 202);
  const redelivery = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "github-command-delivery-1-redelivery",
        "x-hub-signature-256": signature,
      },
      body,
    }),
    { ...env, EXACT_REVIEW_QUEUE: namespace },
    {},
  );
  assert.equal(redelivery.status, 202);
  const redeliveryResult = await redelivery.json();
  assert.equal(redeliveryResult.deduped, true);
  assert.equal(redeliveryResult.bay_journey_delivery_id, commandDeliveryId);
  const stateAfterRedelivery = JSON.parse(
    (await statusStore.get("openclaw-bay:journey-state:v1")) || "{}",
  );
  assert.equal(stateAfterRedelivery.journeys.length, 1);
  assert.equal(stateAfterRedelivery.journeys[0]?.source_delivery_id, commandDeliveryId);
  const intake = directReReviewIntake({
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: ITEM_NUMBER,
    itemKind: "pull_request",
    installationId: 123,
    sourceCommentId: COMMAND_COMMENT_ID,
    sourceCommentUpdatedAt: commandAt,
    commandBodyDigest: createHash("sha256").update(COMMAND_BODY).digest("hex"),
    commandOrigin: "hosted_webhook",
    additionalPrompt: "",
    bayJourneyDeliveryId: commandDeliveryId,
  });
  assert.equal(
    commandIntakeRecord(storage, intake.commandVersionId)?.intake.decision.bayJourneyDeliveryId,
    commandDeliveryId,
  );

  fixture.sourceCommentUpdatedAt = commandAt;
  await queue.alarm();
  await queue.alarm();
  const queueState = (await storage.get("exact-review-queue")) as {
    items: Record<string, { key: string; revision: number }>;
  };
  const item = queueState.items[`openclaw/openclaw#${ITEM_NUMBER}`];
  assert.ok(item);
  const identity = {
    canonicalTargetKey: `openclaw/openclaw#${ITEM_NUMBER}`,
    fenceKey: item.key,
    revision: item.revision,
  };
  const projection = lifecycle.read(
    identity.canonicalTargetKey,
    identity.fenceKey,
    identity.revision,
  );
  assert.equal(projection?.admission.bayJourneyDeliveryId, commandDeliveryId);
  const completionCommentId = 90_002;
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "canonical:fixture",
    observedAt: Date.parse(commandAt) + 1,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "router:fixture",
    observedAt: Date.parse(commandAt) + 2,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: Date.parse(commandAt) + 3,
  });
  const authorized = lifecycle.authorizeCommandAcknowledgement({
    ...identity,
    statusMarker: intake.decision.commandStatusMarker,
    statusCommentId: projection?.admission.statusCommentId ?? null,
    observedAt: Date.parse(commandAt) + 4,
  });
  assert.equal(authorized.allowed, true);

  const completedAt = new Date(Date.now() - 60_000).toISOString();
  const acknowledgementBody = JSON.stringify({
    canonical_target_key: identity.canonicalTargetKey,
    fence_key: identity.fenceKey,
    revision: identity.revision,
    status_marker: intake.decision.commandStatusMarker,
    ...(projection?.admission.statusCommentId
      ? { status_comment_id: projection.admission.statusCommentId }
      : {}),
    command_comment_id: COMMAND_COMMENT_ID,
    completion_comment_id: completionCommentId,
    completed_at: completedAt,
    observed_at: Date.now(),
  });
  const acknowledgementSignature = `sha256=${createHmac("sha256", env.CLAWSWEEPER_WEBHOOK_SECRET)
    .update(acknowledgementBody)
    .digest("hex")}`;
  const acknowledgement = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/command-ack/observed",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": acknowledgementSignature,
        },
        body: acknowledgementBody,
      },
    ),
    { ...env, EXACT_REVIEW_QUEUE: namespace },
    {},
  );
  assert.equal(acknowledgement.status, 200);
  assert.equal((await acknowledgement.json()).bay_journey_delivery_id, commandDeliveryId);
  const stateAfterAcknowledgement = JSON.parse(
    (await statusStore.get("openclaw-bay:journey-state:v1")) || "{}",
  );
  assert.equal(stateAfterAcknowledgement.journeys.length, 1);
  assert.equal(stateAfterAcknowledgement.journeys[0]?.source_delivery_id, commandDeliveryId);
  assert.equal(
    summarizeBayJourneyTimings(stateAfterAcknowledgement.journeys, new Date().toISOString()).overall
      .samples,
    1,
  );

  const completionBody = JSON.stringify({
    action: "edited",
    repository: payload.repository,
    issue: payload.issue,
    comment: {
      id: completionCommentId,
      body: [
        `<!-- clawsweeper-command-ack:${COMMAND_COMMENT_ID} -->`,
        intake.decision.commandStatusMarker,
        "<!-- clawsweeper-command-progress:start -->",
        "- State: Complete",
        "<!-- clawsweeper-command-progress:end -->",
      ].join("\n"),
      created_at: completedAt,
      updated_at: completedAt,
      user: { login: "clawsweeper[bot]" },
    },
  });
  const completionSignature = `sha256=${createHmac("sha256", env.CLAWSWEEPER_WEBHOOK_SECRET)
    .update(completionBody)
    .digest("hex")}`;
  const completion = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "github-completion-delivery-1",
        "x-hub-signature-256": completionSignature,
      },
      body: completionBody,
    }),
    { ...env, EXACT_REVIEW_QUEUE: namespace },
    {},
  );
  assert.equal(completion.status, 202);
  assert.deepEqual(await completion.json(), {
    ok: true,
    accepted: false,
    reason: "recorded Bay journey completion",
  });

  const state = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1")) || "{}");
  assert.equal(state.journeys.length, 1);
  assert.equal(state.journeys[0]?.source_delivery_id, commandDeliveryId);
  assert.ok(state.journeys[0]?.triggered_at);
  assert.ok(state.journeys[0]?.completed_at);
  assert.equal(
    summarizeBayJourneyTimings(state.journeys, new Date().toISOString()).overall.samples,
    1,
  );
});

test("command acknowledgement ignores forged markers and paginates to the trusted receipt", async (t) => {
  const fixture = await startGithubLoopback();
  t.after(() => fixture.close());
  const intake = intakeFixture({ updatedAt: COMMAND_UPDATED_AT, body: COMMAND_BODY });
  const ackMarker = `<!-- clawsweeper-command-ack:${COMMAND_COMMENT_ID} -->`;
  fixture.seedAcknowledgement({
    id: 30_000,
    body: `${ackMarker}\n${intake.decision.commandStatusMarker}`,
    login: "contributor",
  });
  for (let index = 0; index < 99; index += 1) {
    fixture.seedAcknowledgement({
      id: 31_000 + index,
      body: `unrelated comment ${index}`,
      login: "contributor",
    });
  }
  fixture.seedAcknowledgement({
    id: 40_000,
    body: `${ackMarker}\n${intake.decision.commandStatusMarker}\nExact review queued.`,
    login: "clawsweeper[bot]",
  });

  const result = await convergeCommandAcknowledgement({
    env: { GITHUB_API_URL: fixture.origin },
    token: Promise.resolve("loopback-token"),
    decision: intake.decision,
    sourceCommentId: COMMAND_COMMENT_ID,
  });

  assert.equal(result, 40_000);
  assert.equal(fixture.acknowledgements.length, 101);
  assert.equal(
    fixture.acknowledgements.some((comment) => comment.id === 30_000),
    true,
  );
});

async function mainEquivalentOldCommandPath(origin: string) {
  const acknowledgement = await fetch(
    `${origin}/repos/openclaw/openclaw/issues/${ITEM_NUMBER}/comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "<!-- clawsweeper-command-ack:9001 -->\nrouter queued" }),
    },
  );
  assert.equal(acknowledgement.status, 201);
  const dispatch = await fetch(`${origin}/repos/openclaw/clawsweeper/dispatches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event_type: "clawsweeper_comment" }),
  });
  if (!dispatch.ok) throw new Error(`old command dispatch failed: ${dispatch.status}`);
}

function commandWebhookPayload() {
  return {
    action: "created",
    repository: {
      full_name: "openclaw/openclaw",
      default_branch: "main",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    installation: { id: 123 },
    issue: {
      number: ITEM_NUMBER,
      state: "open",
      user: { login: "contributor" },
      pull_request: { url: `https://api.github.com/repos/openclaw/openclaw/pulls/${ITEM_NUMBER}` },
    },
    comment: {
      id: COMMAND_COMMENT_ID,
      body: COMMAND_BODY,
      author_association: "CONTRIBUTOR",
      user: { login: "contributor" },
      created_at: COMMAND_UPDATED_AT,
      updated_at: COMMAND_UPDATED_AT,
      html_url: `https://github.com/openclaw/openclaw/pull/${ITEM_NUMBER}#issuecomment-${COMMAND_COMMENT_ID}`,
    },
  };
}

function commandVersionId() {
  const bodyDigest = createHash("sha256").update(COMMAND_BODY).digest("hex");
  return `command-${COMMAND_COMMENT_ID}-${Date.parse(COMMAND_UPDATED_AT).toString(36)}-${bodyDigest}`;
}

function intakeFixture(options: { updatedAt: string; body: string; targetRepo?: string }) {
  return directReReviewIntake({
    targetRepo: options.targetRepo ?? "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: ITEM_NUMBER,
    itemKind: "pull_request",
    installationId: 123,
    sourceCommentId: COMMAND_COMMENT_ID,
    sourceCommentUpdatedAt: options.updatedAt,
    commandBodyDigest: createHash("sha256").update(options.body).digest("hex"),
    commandOrigin: "hosted_webhook",
    additionalPrompt: "",
  });
}

function commandReceiptOutcome(storage: MemoryDurableStorage) {
  return commandReceipt(storage)?.outcome;
}

function commandReceipt(storage: MemoryDurableStorage) {
  const row = Array.from(
    storage.sql.exec(
      "SELECT outcome, detail FROM exact_review_command_receipts WHERE command_version_id = ?",
      commandVersionId(),
    ),
  )[0];
  return row;
}

function commandIntakeRecord(storage: MemoryDurableStorage, commandVersion: string) {
  const row = Array.from(
    storage.sql.exec(
      "SELECT record_json FROM exact_review_command_intakes WHERE command_version_id = ?",
      commandVersion,
    ),
  )[0] as { record_json?: string } | undefined;
  return row?.record_json ? JSON.parse(row.record_json) : null;
}

function commandIntakeAttempts(storage: MemoryDurableStorage, commandVersion: string) {
  return Number(commandIntakeRecord(storage, commandVersion)?.attempts);
}

function receiptOutcome(storage: MemoryDurableStorage, commandVersion: string) {
  return Array.from(
    storage.sql.exec(
      "SELECT outcome FROM exact_review_command_receipts WHERE command_version_id = ?",
      commandVersion,
    ),
  )[0]?.outcome;
}

async function startGithubLoopback() {
  const acknowledgements: Array<{
    id: number;
    body: string;
    created_at: string;
    issue_url: string;
    user: { login: string };
  }> = [];
  let nextCommentId = 20_000;
  const state = {
    acknowledgements,
    durableIntakes: 0,
    throttleSourceComment: false,
    sourceCommentReads: 0,
    sourceCommentUpdatedAt: COMMAND_UPDATED_AT,
    reactions: 0,
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const body = await readJson(request);
    if (url.pathname === `/repos/openclaw/openclaw/issues/comments/${COMMAND_COMMENT_ID}`) {
      state.sourceCommentReads += 1;
      if (state.throttleSourceComment) {
        response.writeHead(403, {
          "content-type": "application/json",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
        });
        response.end(JSON.stringify({ message: "API rate limit exceeded for installation" }));
        return;
      }
      return sendJson(response, 200, {
        id: COMMAND_COMMENT_ID,
        body: COMMAND_BODY,
        updated_at: state.sourceCommentUpdatedAt,
        issue_url: `https://api.github.com/repos/openclaw/openclaw/issues/${ITEM_NUMBER}`,
      });
    }
    if (url.pathname === `/repos/openclaw/openclaw/pulls/${ITEM_NUMBER}`) {
      return sendJson(response, 200, {
        state: "open",
        updated_at: COMMAND_UPDATED_AT,
        head: { sha: HEAD_SHA },
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/installation") {
      return sendJson(response, 200, { id: 123 });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return sendJson(response, 200, { id: 777 });
    }
    if (url.pathname === "/repos/openclaw/openclaw") {
      return sendJson(response, 200, {
        full_name: "openclaw/openclaw",
        private: false,
        visibility: "public",
      });
    }
    if (/^\/app\/installations\/(?:123|777)\/access_tokens$/.test(url.pathname)) {
      return sendJson(response, 201, { token: "loopback-token" });
    }
    if (url.pathname === `/repos/openclaw/openclaw/issues/${ITEM_NUMBER}/comments`) {
      if (request.method === "GET") {
        const page = Math.max(1, Number(url.searchParams.get("page") || 1));
        const perPage = Math.max(1, Number(url.searchParams.get("per_page") || 100));
        return sendJson(
          response,
          200,
          acknowledgements.slice((page - 1) * perPage, page * perPage),
        );
      }
      if (request.method === "POST") {
        const comment = {
          id: nextCommentId++,
          body: String(body.body || ""),
          created_at: new Date().toISOString(),
          issue_url: `https://api.github.com/repos/openclaw/openclaw/issues/${ITEM_NUMBER}`,
          user: { login: "clawsweeper[bot]" },
        };
        acknowledgements.push(comment);
        return sendJson(response, 201, comment);
      }
    }
    const acknowledgement = url.pathname.match(
      /^\/repos\/openclaw\/openclaw\/issues\/comments\/(\d+)$/,
    );
    if (acknowledgement) {
      const id = Number(acknowledgement[1]);
      const index = acknowledgements.findIndex((comment) => comment.id === id);
      if (request.method === "PATCH" && index >= 0) {
        acknowledgements[index] = { ...acknowledgements[index]!, body: String(body.body || "") };
        return sendJson(response, 200, acknowledgements[index]);
      }
      if (request.method === "DELETE" && index >= 0) {
        acknowledgements.splice(index, 1);
        response.writeHead(204).end();
        return;
      }
    }
    if (
      url.pathname === `/repos/openclaw/openclaw/issues/comments/${COMMAND_COMMENT_ID}/reactions`
    ) {
      state.reactions += 1;
      return sendJson(response, 201, { id: state.reactions, content: "eyes" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      return sendJson(response, 200, { state: "active" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      if (request.headers.authorization) {
        response.writeHead(204).end();
      } else {
        sendJson(response, 403, { message: "API rate limit exceeded for installation" });
      }
      return;
    }
    sendJson(response, 404, { message: `unhandled ${request.method} ${url.pathname}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return Object.assign(state, {
    origin: `http://127.0.0.1:${address.port}`,
    seedAcknowledgement: (comment: { id: number; body: string; login: string }) => {
      acknowledgements.push({
        id: comment.id,
        body: comment.body,
        created_at: new Date(comment.id).toISOString(),
        issue_url: `https://api.github.com/repos/openclaw/openclaw/issues/${ITEM_NUMBER}`,
        user: { login: comment.login },
      });
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  });
}

async function readJson(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function sendJson(response: http.ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
