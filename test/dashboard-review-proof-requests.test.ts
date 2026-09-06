import { createHash } from "node:crypto";
import { stableJson } from "../src/stable-json.ts";
import {
  assert,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  leasedExactReviewQueueItem,
  worker,
} from "./dashboard-worker-harness.ts";
import { publicExactReviewQueueProjection } from "../dashboard/worker.ts";
import {
  exactReviewDecisionFrom,
  exactReviewEditedSemanticInput,
} from "../dashboard/exact-review-decision.ts";
import type { InlineProofScenario } from "../src/repair/direct-re-review-admission.ts";

async function fixture(allowed?: InlineProofScenario[]) {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(42, "123");
  Object.assign(item.decision, {
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceHeadSha: "a".repeat(40),
    ...(allowed === undefined ? {} : { proofAllowedScenarios: allowed }),
  });
  Object.assign(item.leaseDecision, item.decision);
  Object.assign(item, { leasePhase: "review" });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const lease = {
    itemKey: item.key,
    leaseId: item.leaseId,
    leaseRevision: item.leaseRevision,
    claimGeneration: item.claimGeneration,
    runId: item.claimedRunId,
    runAttempt: item.claimedRunAttempt,
    sourceHeadSha: "a".repeat(40),
  };
  const plan = (text = "test") => {
    const proofPlan = {
      claim: text,
      actions: [{ type: "send", atMs: 0, text }],
      modelReplies: ["reply"],
      settings: { streaming: "off", nativeCommands: false },
      maxDurationMs: 1000,
      expectations: ["reply"],
    };
    return {
      lease,
      operation: "request",
      scenario: "telegram-bot-e2e-proof",
      proofPlan,
      planSha256: createHash("sha256").update(stableJson(proofPlan)).digest("hex"),
    };
  };
  const post = async (body: unknown, route = "/review-proof", instance = queue) => {
    const response = await instance.fetch(
      new Request("https://queue" + route, { method: "POST", body: JSON.stringify(body) }),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  return { storage, queue, lease, plan, post };
}

test("capabilities expose only the active lease allowlist without tokens or budget", async () => {
  for (const allowed of [undefined, [], ["web-ui-chat-proof"], ["telegram-bot-e2e-proof"]] as (
    | InlineProofScenario[]
    | undefined
  )[]) {
    const f = await fixture(allowed);
    const body = { operation: "capabilities", lease: f.lease };
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/proof", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(f.queue) },
      {},
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      allowedScenarios: allowed ?? ["web-ui-chat-proof", "telegram-bot-e2e-proof"],
    });
    assert.equal(
      (f.queue as any).readStateSync().items[f.lease.itemKey].reviewProofRequests,
      undefined,
    );
    for (const [key, value] of Object.entries({
      leaseId: "wrong",
      leaseRevision: 2,
      claimGeneration: 2,
      runId: "456",
      runAttempt: 2,
      sourceHeadSha: "b".repeat(40),
    }))
      assert.equal(
        (await f.post({ ...body, lease: { ...f.lease, [key]: value } })).status,
        409,
        key,
      );
    assert.equal((await f.post({ ...body, scenario: "web-ui-chat-proof" })).status, 400);
    if (allowed && !allowed.includes("telegram-bot-e2e-proof")) {
      assert.equal((await f.post(f.plan())).status, 403);
      assert.equal((await f.post({ ...f.plan(), operation: "poll" })).status, 403);
    }
  }
});

test("decision parsing preserves empty scope and rejects widening malformed scopes", async () => {
  const f = await fixture();
  await f.post({ operation: "capabilities", lease: f.lease });
  const decision = (f.queue as any).readStateSync().items[f.lease.itemKey].decision;
  assert.deepEqual(
    exactReviewDecisionFrom({ ...decision, proofAllowedScenarios: [] })?.proofAllowedScenarios,
    [],
  );
  for (const value of [
    null,
    "auto",
    ["unknown"],
    ["web-ui-chat-proof", "web-ui-chat-proof"],
    ["web-ui-chat-proof", "telegram-bot-e2e-proof", "unknown"],
  ])
    assert.equal(exactReviewDecisionFrom({ ...decision, proofAllowedScenarios: value }), null);
  const edited = {
    ...decision,
    sourceAction: "edited",
    sourceBaseSha: "b".repeat(40),
    sourceIsDraft: false,
    sourceContentRevision: "c".repeat(64),
  };
  const unrestricted = await exactReviewEditedSemanticInput(edited);
  const restricted = await exactReviewEditedSemanticInput({ ...edited, proofAllowedScenarios: [] });
  assert.ok(unrestricted && restricted);
  assert.notEqual(unrestricted.fingerprint, restricted.fingerprint);
});

test("scope restriction fences existing polls, updates and producer redemption", async () => {
  const f = await fixture();
  const admitted = await f.post(f.plan());
  const requestId = admitted.body.record.requestId;
  const state = (f.queue as any).readStateSync();
  const item = state.items[f.lease.itemKey];
  item.reviewProofRequests[0].producer = {
    workflowSha: "b".repeat(40),
    harnessSha: "b".repeat(40),
    workflowPath: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    workflowRef: "main",
    repositoryId: "123",
    bodySha256: "c".repeat(64),
    baseSha: "d".repeat(40),
    targetBranch: "main",
  };
  item.leaseDecision.proofAllowedScenarios = [];
  item.decision.proofAllowedScenarios = [];
  await (f.queue as any).writeState(state);
  assert.equal((await f.post({ ...f.plan(), operation: "poll" })).status, 403);
  assert.equal(
    (
      await f.post(
        { lease: f.lease, requestId, state: "inconclusive", reason: "test" },
        "/review-proof/update",
      )
    ).status,
    403,
  );
  for (const route of ["/review-proof/producer-record", "/review-proof/redeem"])
    assert.equal(
      (
        await f.post(
          { requestId, runId: "987", runAttempt: 1, planSha256: f.plan().planSha256 },
          route,
        )
      ).status,
      409,
    );
  item.leaseDecision.proofAllowedScenarios = ["telegram-bot-e2e-proof"];
  item.revision = f.lease.leaseRevision + 1;
  await (f.queue as any).writeState(state);
  assert.equal((await f.post({ operation: "capabilities", lease: f.lease })).status, 409);
});

test("review proof is durable, plan-bound, at-most-once and limited to three plans", async () => {
  const f = await fixture();
  const first = await f.post(f.plan());
  assert.equal(first.status, 200);
  assert.equal(first.body.dispatch, true);
  const restarted = new ExactReviewQueue({ storage: f.storage }, {});
  const second = await f.post(f.plan(), "/review-proof", restarted);
  assert.equal(second.body.dispatch, false);
  assert.equal(second.body.record.requestId, first.body.record.requestId);
  assert.equal((await f.post(f.plan("two"))).body.dispatch, true);
  assert.equal((await f.post(f.plan("three"))).body.dispatch, true);
  assert.equal((await f.post(f.plan("four"))).body.error, "review_proof_budget_exhausted");
});

test("review proof rejects every stale owner field and forged plan digest", async () => {
  const f = await fixture();
  for (const [key, value] of Object.entries({
    leaseId: "wrong",
    leaseRevision: 2,
    claimGeneration: 2,
    runId: "456",
    runAttempt: 2,
    sourceHeadSha: "b".repeat(40),
  })) {
    const result = await f.post({ ...f.plan(), lease: { ...f.lease, [key]: value } });
    assert.equal(result.status, 409, key);
    assert.equal(result.body.error, "lease_not_active", key);
  }
  assert.equal((await f.post({ ...f.plan(), planSha256: "0".repeat(64) })).status, 400);
  assert.equal((await f.post({ ...f.plan(), operation: "update" })).status, 400);
});

test("review proof poll cannot dispatch and completion feeds original record only", async () => {
  const f = await fixture();
  assert.equal((await f.post({ ...f.plan(), operation: "poll" })).status, 404);
  const admitted = await f.post(f.plan());
  const requestId = admitted.body.record.requestId;
  assert.equal(
    (
      await f.post(
        { lease: f.lease, requestId, state: "pending", runId: "987" },
        "/review-proof/update",
      )
    ).body.record.state,
    "pending",
  );
  assert.equal(
    (
      await f.post(
        { lease: f.lease, requestId, state: "pending", runId: "988" },
        "/review-proof/update",
      )
    ).status,
    409,
  );
  const result = { observations: [{ actual: "reply", expected: "reply" }] };
  await f.post({ lease: f.lease, requestId, state: "completed", result }, "/review-proof/update");
  const polled = await f.post({ ...f.plan(), operation: "poll" });
  assert.equal(polled.body.dispatch, false);
  assert.equal(polled.body.record.state, "completed");
  assert.deepEqual(polled.body.record.result, result);
});

for (const operation of ["prepared", "completed"]) {
  test(`expired proof rejects ${operation} update and persists the deadline fence`, async () => {
    const f = await fixture();
    const admitted = await f.post(f.plan());
    const requestId = admitted.body.record.requestId;
    const state = (f.queue as any).readStateSync();
    state.items[f.lease.itemKey].reviewProofRequests[0].expiresAt = Date.now() - 1;
    await (f.queue as any).writeState(state);
    const response = await f.post(
      {
        lease: f.lease,
        requestId,
        ...(operation === "prepared"
          ? { operation, producer: {} }
          : {
              state: "completed",
              result: { observations: [] },
            }),
      },
      "/review-proof/update",
    );
    assert.equal(response.status, 409);
    assert.notEqual(response.body.ok, true);
    const restarted = new ExactReviewQueue({ storage: f.storage }, {});
    const polled = await f.post({ ...f.plan(), operation: "poll" }, "/review-proof", restarted);
    assert.equal(polled.body.record.state, "inconclusive");
    assert.equal(polled.body.record.reason, "proof_deadline_expired");
    assert.equal(polled.body.record.result, undefined);
  });
}

test("producer redemption is same-run idempotent and denies replays and owner loss", async () => {
  const f = await fixture();
  const first = await f.post(f.plan());
  const requestId = first.body.record.requestId;
  const producer = {
    workflowSha: "b".repeat(40),
    harnessSha: "b".repeat(40),
    workflowPath: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    workflowRef: "main",
    repositoryId: "123",
    bodySha256: "c".repeat(64),
    baseSha: "d".repeat(40),
    targetBranch: "main",
  };
  assert.equal(
    (
      await f.post(
        { lease: f.lease, requestId, operation: "prepared", producer },
        "/review-proof/update",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.post(
        {
          lease: f.lease,
          requestId,
          operation: "prepared",
          producer: { ...producer, workflowSha: "e".repeat(40), harnessSha: "e".repeat(40) },
        },
        "/review-proof/update",
      )
    ).status,
    409,
  );
  const redemption = { requestId, runId: "987", runAttempt: 1, planSha256: f.plan().planSha256 };
  assert.equal((await f.post(redemption, "/review-proof/redeem")).status, 200);
  assert.equal((await f.post(redemption, "/review-proof/redeem")).status, 200);
  assert.equal((await f.post({ ...redemption, runId: "988" }, "/review-proof/redeem")).status, 409);
  assert.equal(
    (await f.post({ ...redemption, runAttempt: 2 }, "/review-proof/redeem")).status,
    409,
  );
  const completed = await fixture();
  const completedId = (await completed.post(completed.plan())).body.record.requestId;
  await completed.post(
    { lease: completed.lease, requestId: completedId, operation: "prepared", producer },
    "/review-proof/update",
  );
  await completed.post({ ...redemption, requestId: completedId }, "/review-proof/redeem");
  await completed.post(
    {
      lease: completed.lease,
      requestId: completedId,
      state: "completed",
      result: { observations: [] },
    },
    "/review-proof/update",
  );
  assert.equal(
    (await completed.post({ ...redemption, requestId: completedId }, "/review-proof/redeem"))
      .status,
    409,
  );
  await f.post(
    {
      item_key: f.lease.itemKey,
      lease_id: f.lease.leaseId,
      lease_revision: f.lease.leaseRevision,
      claim_generation: f.lease.claimGeneration,
      run_id: f.lease.runId,
      run_attempt: f.lease.runAttempt,
      source_head_sha: f.lease.sourceHeadSha,
      phase: "finalizing",
    },
    "/heartbeat",
  );
  assert.equal((await f.post(redemption, "/review-proof/redeem")).status, 409);
});

test("public proof endpoint cannot accept a reviewer-forged completion", async () => {
  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/proof", {
      method: "POST",
      body: JSON.stringify({
        operation: "update",
        state: "completed",
        result: { outcome: "pass" },
      }),
    }),
    {},
    { waitUntil() {} },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_review_proof_request" });
});

test("manual proof head binding cannot be silently replaced by latest PR head", async () => {
  const f = await fixture();
  await f.post(f.plan()); // Initialize the existing queue tables.
  const body = "@clawsweeper proof";
  const updatedAt = new Date().toISOString();
  const intake = {
    commandVersionId: "test-bound-head",
    sourceCommentId: 42,
    sourceCommentUpdatedAt: updatedAt,
    commandBodyDigest: createHash("sha256").update(body).digest("hex"),
    decision: {
      targetRepo: "openclaw/openclaw",
      itemNumber: 42,
      itemKind: "pull_request",
      sourceHeadSha: "a".repeat(40),
      targetBranch: "main",
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    Response.json(
      String(url).includes("/comments/")
        ? {
            issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/42",
            updated_at: updatedAt,
            body,
          }
        : { state: "open", head: { sha: "b".repeat(40) }, updated_at: updatedAt },
    )) as typeof fetch;
  try {
    assert.equal(
      await (f.queue as any).verifyCommandIntake({ intake }, Promise.resolve("fixture-token")),
      null,
    );
    delete (intake.decision as any).sourceHeadSha;
    const ordinary = await (f.queue as any).verifyCommandIntake(
      { intake },
      Promise.resolve("fixture-token"),
    );
    assert.equal(ordinary.sourceHeadSha, "b".repeat(40));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue status and Bay projections do not expose review proof capabilities or content", async () => {
  const f = await fixture();
  const baseline = (await (await f.queue.fetch(new Request("https://queue/stats"))).json()) as any;
  const privateMarker = "private-proof-plan-content";
  const admitted = await f.post(f.plan(privateMarker));
  const requestId = admitted.body.record.requestId;
  const response = await f.queue.fetch(new Request("https://queue/stats"));
  const stats = await response.json();
  const publicStats = publicExactReviewQueueProjection(stats, new Set(["openclaw/openclaw"]));
  const env = { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(f.queue) };
  const publicResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/exact-review-queue"),
    env,
    {},
  );
  for (const text of [
    JSON.stringify(stats),
    JSON.stringify(publicStats),
    await publicResponse.text(),
  ]) {
    for (const forbidden of [
      f.lease.leaseId,
      privateMarker,
      requestId,
      "reviewProofRequests",
      "proofPlan",
      "producerRedemption",
    ])
      assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.equal(
    (stats as any).bay_projection.items[0].stage,
    baseline.bay_projection.items[0].stage,
  );
});
