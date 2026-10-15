import {
  assert,
  createHash,
  createHmac,
  fs,
  test,
  createContext,
  Script,
  gunzipSync,
  worker,
  ExactReviewQueue,
  exactReviewQueueAdmittedItems,
  exactReviewQueueNextWakeAt,
  exactReviewQueueStatusSnapshot,
  recentWorkerHealthRunSample,
  workerHealthSectionTimeoutMs,
  commandAcknowledgementState,
  ExactReviewLifecycleProjectionStore,
  lifecycleState,
  MemoryKv,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  MemoryR2Bucket,
  jsonResponse,
  signedGithubWebhookRequest,
  stateAppendQueueRequest,
  signedStateAppendRequest,
  createExactReviewAdmissionHarness,
  withExactReviewAdmissionHarness,
  buildExactReviewQueueRequest,
  completedReviewRun,
  exactReviewPublicationOverrides,
  leasedExactReviewQueueItem,
  leasedExactReviewPublicationItem,
} from "./dashboard-worker-harness.ts";

test("unfenced acknowledgements prefer a unique exact status comment over a shared marker", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const canonicalTargetKey = "openclaw/openclaw#918";
  const statusMarker = "<!-- clawsweeper-command-status:918:re_review:same-head -->";
  const observedAt = 1_780_000_000_000;
  for (const [revision, statusCommentId] of [
    [1, 9301],
    [2, 9401],
  ] as const) {
    const identity = {
      canonicalTargetKey,
      fenceKey: `${canonicalTargetKey}@exact:${revision}`,
      revision,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `publisher:${revision}`,
      sourceDeliveryId: `github-command-delivery:${revision}`,
      sourceAction: "re_review",
      commandOriginated: true,
      statusMarker,
      statusCommentId,
      observedAt: observedAt + revision,
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: "accepted",
      receiptId: `canonical:${revision}`,
      observedAt: observedAt + 10 + revision,
    });
    lifecycle.recordRouterReceipt({
      ...identity,
      outcome: "durable",
      receiptId: `router:${revision}`,
      observedAt: observedAt + 20 + revision,
    });
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: observedAt + 30 + revision,
    });
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker,
      statusCommentId,
      observedAt: observedAt + 40 + revision,
    });
  }

  const observation = lifecycle.observeCommandAcknowledgement({
    canonicalTargetKey,
    statusMarker,
    commandCommentId: 555,
    completionCommentId: 9301,
    observedAt: observedAt + 100,
  });
  assert.equal(observation.accepted, true);
  assert.equal(observation.projection?.revision, 1);
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, `${canonicalTargetKey}@exact:1`, 1)!),
    "completed",
  );
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, `${canonicalTargetKey}@exact:2`, 2)!),
    "acknowledgement_pending",
  );
});

test("exact-review queue preserves source timestamps for pull-request and command lifecycle admission", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  const pullRequestTriggeredAt = new Date(Date.now() - 20_000).toISOString();
  const commandTriggeredAt = new Date(Date.now() - 10_000).toISOString();
  const verifiedPullRequestAt = new Date(Date.now() - 1_000).toISOString();
  const staleScheduledCandidateAt = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();

  const pullRequest = await queue.fetch(
    buildExactReviewQueueRequest(
      "lifecycle-pr-opened",
      9_300,
      "opened",
      "pull_request",
      "openclaw/openclaw",
      { sourceUpdatedAt: pullRequestTriggeredAt },
    ),
  );
  assert.equal(pullRequest.status, 202);
  const command = await queue.fetch(
    buildExactReviewQueueRequest(
      "lifecycle-command-rereview",
      9_301,
      "re_review",
      "issue",
      "openclaw/openclaw",
      {
        commandStatusMarker: "<!-- clawsweeper-command-status:9301:re_review:head -->",
        statusCommentId: 93_011,
        sourceCommentId: 93_010,
        sourceCommentUpdatedAt: commandTriggeredAt,
        // Command verification may attach current PR metadata for source
        // authority. It must not replace the command's timing origin.
        sourceUpdatedAt: verifiedPullRequestAt,
        commandBodyDigest: "a".repeat(64),
        commandOrigin: "hosted_webhook",
        sourceCommentVerified: true,
      },
    ),
  );
  assert.equal(command.status, 202);
  const scheduledAdmissionStartedAt = Date.now();
  const scheduled = await queue.fetch(
    buildExactReviewQueueRequest(
      "lifecycle-scheduled-backfill",
      9_302,
      "scheduled_normal_backfill",
      "pull_request",
      "openclaw/openclaw",
      { sourceUpdatedAt: staleScheduledCandidateAt },
    ),
  );
  const scheduledAdmissionFinishedAt = Date.now();
  assert.equal(scheduled.status, 202);

  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  assert.equal(
    lifecycle.read("openclaw/openclaw#9300", "openclaw/openclaw#9300", 1)?.admission.triggeredAt,
    Date.parse(pullRequestTriggeredAt),
  );
  assert.equal(
    lifecycle.read("openclaw/openclaw#9301", "openclaw/openclaw#9301", 1)?.admission.triggeredAt,
    Date.parse(commandTriggeredAt),
  );
  const scheduledTriggeredAt = lifecycle.read("openclaw/openclaw#9302", "openclaw/openclaw#9302", 1)
    ?.admission.triggeredAt;
  assert.ok(scheduledTriggeredAt && scheduledTriggeredAt >= scheduledAdmissionStartedAt);
  assert.ok(scheduledTriggeredAt && scheduledTriggeredAt <= scheduledAdmissionFinishedAt);
});

test("exact-review queue materializes a superseded command lifecycle after enqueue commits", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  const targetRepo = "openclaw/openclaw";
  const itemNumber = 9_303;
  const first = await queue.fetch(
    buildExactReviewQueueRequest(
      "lifecycle-command-first",
      itemNumber,
      "re_review",
      "issue",
      targetRepo,
      {
        commandStatusMarker: "<!-- clawsweeper-command-status:9303:re_review:first -->",
        statusCommentId: 93_031,
        sourceCommentId: 93_030,
        sourceCommentUpdatedAt: new Date(Date.now() - 1_000).toISOString(),
        sourceUpdatedAt: new Date().toISOString(),
        commandBodyDigest: "a".repeat(64),
        commandOrigin: "hosted_webhook",
        sourceCommentVerified: true,
      },
    ),
  );
  assert.equal(first.status, 202);
  const second = await queue.fetch(
    buildExactReviewQueueRequest(
      "lifecycle-command-second",
      itemNumber,
      "re_review",
      "issue",
      targetRepo,
      {
        commandStatusMarker: "<!-- clawsweeper-command-status:9303:re_review:second -->",
        statusCommentId: 93_032,
        sourceCommentId: 93_031,
        sourceCommentUpdatedAt: new Date().toISOString(),
        sourceUpdatedAt: new Date().toISOString(),
        commandBodyDigest: "b".repeat(64),
        commandOrigin: "hosted_webhook",
        sourceCommentVerified: true,
      },
    ),
  );
  assert.equal(second.status, 202);

  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const projection = lifecycle.read(
    `${targetRepo}#${itemNumber}`,
    `${targetRepo}#${itemNumber}`,
    1,
  );
  assert.equal(projection?.terminalDisposition?.kind, "superseded");
});

test("verified unchanged legacy receipts acknowledge without a webhook", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const now = Date.now();
  const marker = "<!-- clawsweeper-command-status:918:re_review:unchanged -->";
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#918",
    fenceKey: "openclaw/openclaw#918@exact",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "unchanged-legacy:918",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: marker,
    statusCommentId: 9501,
    observedAt: now,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "unchanged-legacy:canonical",
    observedAt: now + 1,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "unchanged-legacy:router",
    observedAt: now + 2,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: now + 3,
  });
  lifecycle.authorizeCommandAcknowledgement({
    ...identity,
    statusMarker: marker,
    statusCommentId: 9501,
    observedAt: now + 4,
  });
  const secret = "unchanged-legacy-secret";
  const completedAt = new Date(now + 5).toISOString();
  const body = JSON.stringify({
    canonical_target_key: identity.canonicalTargetKey,
    status_marker: marker,
    status_comment_id: 9501,
    command_comment_id: 558,
    completion_comment_id: 9501,
    completed_at: completedAt,
    observed_at: now + 15,
  });
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const sendReceipt = () =>
    worker.fetch(
      new Request(
        "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/command-ack/observed",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret)
              .update(body)
              .digest("hex")}`,
          },
          body,
        },
      ),
      env,
    );

  assert.equal((await (await sendReceipt()).json()).accepted, true);
  assert.equal((await (await sendReceipt()).json()).accepted, true);
  assert.equal(
    lifecycleState(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!,
    ),
    "completed",
  );
});

test("migrated modern acknowledgement receipts preserve the canonical completion identity", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const now = Date.now();
  const marker = "<!-- clawsweeper-command-status:916:re_review:migrated -->";
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#916",
    fenceKey: "openclaw/openclaw#916@exact",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "modern-migration:916",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: marker,
    statusCommentId: 9401,
    observedAt: now,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "modern-migration:canonical",
    observedAt: now + 1,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "modern-migration:router",
    observedAt: now + 2,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: now + 3,
  });
  lifecycle.authorizeCommandAcknowledgement({
    ...identity,
    statusMarker: marker,
    statusCommentId: 9401,
    observedAt: now + 4,
  });
  const secret = "modern-migration-secret";
  const completedAt = new Date(now + 5).toISOString();
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    hostedPublicTargetProbe: async () => "public" as const,
  };
  const webhook = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret,
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 916 },
        comment: {
          id: 9402,
          body: [
            "<!-- clawsweeper-command-ack:556 -->",
            marker,
            "<!-- clawsweeper-command-progress:start -->",
            "- State: Complete",
            "- Detail: Done.",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: completedAt,
          updated_at: completedAt,
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    env,
  );
  assert.equal((await webhook.json()).reason, "recorded lifecycle acknowledgement");

  const body = JSON.stringify({
    canonical_target_key: identity.canonicalTargetKey,
    status_marker: marker,
    status_comment_id: 9401,
    command_comment_id: 556,
    completion_comment_id: 9402,
    completed_at: completedAt,
    observed_at: now + 15,
  });
  const receipt = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/command-ack/observed",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret)
            .update(body)
            .digest("hex")}`,
        },
        body,
      },
    ),
    env,
  );

  assert.equal((await receipt.json()).accepted, true);
  assert.equal(
    lifecycleState(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!,
    ),
    "completed",
  );
});

test("unsigned terminal receipts are rejected before their JSON body is parsed", async () => {
  const originalJson = Request.prototype.json;
  let bodyParses = 0;
  Request.prototype.json = function (...args) {
    bodyParses += 1;
    return originalJson.apply(this, args);
  };
  try {
    const response = await worker.fetch(
      new Request(
        "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/command-ack/observed",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": "sha256=invalid",
          },
          body: JSON.stringify({ values: Array.from({ length: 100 }, (_, index) => index) }),
        },
      ),
      { CLAWSWEEPER_WEBHOOK_SECRET: "real-secret" },
    );
    assert.equal(response.status, 401);
    assert.equal(bodyParses, 0);
  } finally {
    Request.prototype.json = originalJson;
  }
});

test("modern shared status comments acknowledge only the matching command marker", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const canonicalTargetKey = "openclaw/openclaw#913";
  for (const [head, runId] of [
    ["old", "100"],
    ["new", "200"],
  ]) {
    const identity = {
      canonicalTargetKey,
      fenceKey: `${canonicalTargetKey}@publish:${runId}:1`,
      revision: 1,
    };
    const statusMarker = `<!-- clawsweeper-command-status:913:automerge:${head} -->`;
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `shared-status:${runId}`,
      sourceAction: "automerge",
      commandOriginated: true,
      statusMarker,
      statusCommentId: 9201,
      observedAt: 1_700_000_000_000,
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: "accepted",
      receiptId: `shared-status:${runId}:canonical`,
      observedAt: 1_700_000_000_001,
    });
    lifecycle.recordRouterReceipt({
      ...identity,
      outcome: "durable",
      receiptId: `shared-status:${runId}:router`,
      observedAt: 1_700_000_000_002,
    });
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: 1_700_000_000_003,
    });
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker,
      statusCommentId: 9201,
      observedAt: 1_700_000_000_004,
    });
  }

  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "shared-status-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 913 },
        comment: {
          id: 9201,
          body: [
            "<!-- clawsweeper-command-ack:456 -->",
            "<!-- clawsweeper-command-status:913:automerge:new -->",
            "<!-- clawsweeper-command-progress:start -->",
            "- State: Complete",
            "- Detail: Done.",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: "2026-07-30T00:00:00.000Z",
          updated_at: "2026-07-30T00:01:00.000Z",
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "shared-status-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      STATUS_STORE: new MemoryKv(),
      hostedPublicTargetProbe: async () => "public" as const,
    },
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "recorded lifecycle acknowledgement",
  });
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, `${canonicalTargetKey}@publish:100:1`, 1)!),
    "acknowledgement_pending",
  );
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, `${canonicalTargetKey}@publish:200:1`, 1)!),
    "completed",
  );
});

test("Worker lifecycle keeps retryable publication work ineligible for final acknowledgement", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewPublicationItem(779, "7790");
  leased.revision = 1;
  leased.leaseRevision = 1;
  leased.claimedRunId = undefined;
  leased.claimedRunAttempt = undefined;
  leased.claimGeneration = undefined;
  leased.admissionDeliveryId = "publication-delivery:779";
  const marker = "<!-- clawsweeper-command-status:779:re_review:retry -->";
  Object.assign(leased.decision.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 124,
  });
  Object.assign(leased.leaseDecision!.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 124,
  });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "lifecycle-retry-proof-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const claimed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 1,
        run_id: "7790",
        run_attempt: 1,
      }),
    }),
  );
  assert.equal(claimed.status, 200);
  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7790",
        run_attempt: 1,
        outcome: "failure",
        failure_kind: "github_transient",
        completion_kind: "retryable_failure",
        reason_code: "github_transient",
        lifecycle_terminal_disposition: "failure",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: true });
  const projection = new ExactReviewLifecycleProjectionStore(storage).read(
    "openclaw/openclaw#779",
    leased.key,
    1,
  );
  assert.equal(lifecycleState(projection!), "requeue");
  assert.equal(commandAcknowledgementState(projection!), "unavailable");
  assert.deepEqual(
    projection?.reviewResults.map((result) => result.outcome),
    ["failed"],
  );

  const acknowledgement = {
    canonical_target_key: "openclaw/openclaw#779",
    fence_key: leased.key,
    revision: 1,
    status_marker: marker,
    status_comment_id: 124,
  };
  const body = JSON.stringify(acknowledgement);
  const attempted = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/command-ack/attempt",
      {
        method: "POST",
        headers: {
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      },
    ),
    env,
  );
  assert.deepEqual(await attempted.json(), {
    ok: true,
    allowed: false,
    lifecycle_state: "requeue",
    acknowledgement_state: "unavailable",
    version: 1,
  });
});

test("Worker retains a committed terminal command acknowledgement for fenced retries", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewPublicationItem(782, "7820");
  leased.revision = 1;
  leased.leaseRevision = 1;
  leased.claimedRunId = undefined;
  leased.claimedRunAttempt = undefined;
  leased.claimGeneration = undefined;
  leased.admissionDeliveryId = "publication-delivery:782";
  const marker = "<!-- clawsweeper-command-status:782:re_review:terminal -->";
  Object.assign(leased.decision.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 7821,
  });
  Object.assign(leased.leaseDecision!.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 7821,
  });
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7821 });
  Object.assign(leased.leaseDecision!, { commandStatusMarker: marker, statusCommentId: 7821 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) };
  await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 1,
        run_id: "7820",
        run_attempt: 1,
      }),
    }),
  );
  const claimedState = storage.sql.readNormalizedQueue() as {
    items: Record<string, { publicationFailureAttempts?: number; firstFailureAt?: number }>;
  };
  claimedState.items[leased.key]!.publicationFailureAttempts = 47;
  claimedState.items[leased.key]!.firstFailureAt = Date.now();
  storage.sql.replaceNormalizedQueue(claimedState);
  const committed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7820",
        run_attempt: 1,
        outcome: "failure",
        failure_kind: "github_transient",
        completion_kind: "retryable_failure",
        reason_code: "github_transient",
      }),
    }),
  );
  assert.deepEqual(await committed.json(), {
    ok: true,
    requeued: false,
    terminal_finalization: true,
  });
  const committedState = storage.sql.readNormalizedQueue() as {
    items: Record<string, Record<string, unknown>>;
  };
  const driverKey = `terminal-finalization:${leased.key}:1`;
  assert.equal(committedState.items[leased.key], undefined);
  const finalizer = committedState.items[driverKey]!;
  assert.equal(finalizer.state, "pending");
  assert.deepEqual(finalizer.terminalFinalization, {
    disposition: "dead_letter",
    statusState: "Failed",
    statusDetail:
      "Durable publication exhausted its retry budget and was retained for operator dead-letter recovery.",
    projection: {
      canonicalTargetKey: "openclaw/openclaw#782",
      fenceKey: leased.key,
      revision: 1,
    },
  });
  const newerMarker = "<!-- clawsweeper-command-status:782:re_review:newer -->";
  const newerPublicationDecision = exactReviewPublicationOverrides(
    782,
    "7821",
    "re_review",
    2,
    "openclaw/openclaw",
  );
  Object.assign(newerPublicationDecision.publication.producerDecision, {
    commandStatusMarker: newerMarker,
    statusCommentId: 7822,
  });
  const newerPublication = await queue.fetch(
    buildExactReviewQueueRequest(
      "publication-after-terminal-finalization",
      782,
      "exact_review_artifact_publish",
      "issue",
      "openclaw/openclaw",
      {
        commandStatusMarker: newerMarker,
        statusCommentId: 7822,
        ...newerPublicationDecision,
      },
    ),
  );
  assert.deepEqual(await newerPublication.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/openclaw#782@publish:7821:1",
    superseded_publications: 0,
  });
  const stateAfterNewPublication = storage.sql.readNormalizedQueue() as {
    items: Record<string, Record<string, unknown>>;
  };
  const retainedFinalizer = stateAfterNewPublication.items[driverKey]!;
  assert.deepEqual(retainedFinalizer.terminalFinalization, finalizer.terminalFinalization);
  Object.assign(retainedFinalizer, {
    state: "dispatching",
    leaseId: "terminal-finalization-lease",
    leaseRevision: 1,
    leaseDecision: retainedFinalizer.decision,
    leaseExpiresAt: Date.now() + 60_000,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
  });
  storage.sql.replaceNormalizedQueue(stateAfterNewPublication);
  const finalizationClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "terminal-finalization-lease",
        item_key: driverKey,
        lease_revision: 1,
        run_id: "7821",
        run_attempt: 1,
      }),
    }),
  );
  const finalizationClaimBody = await finalizationClaim.json();
  assert.equal(finalizationClaimBody.terminal_finalization?.disposition, "dead_letter");
  const staleClaim = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          lease_id: "terminal-finalization-lease",
          item_key: driverKey,
          lease_revision: 1,
          claim_generation: 2,
          run_id: "7821",
          run_attempt: 1,
          status_marker: marker,
          status_comment_id: 7821,
        }),
      },
    ),
    env,
  );
  assert.equal(staleClaim.status, 409);
  const expiredState = storage.sql.readNormalizedQueue() as {
    items: Record<string, Record<string, unknown>>;
  };
  expiredState.items[driverKey]!.leaseExpiresAt = Date.now() - 1;
  storage.sql.replaceNormalizedQueue(expiredState);
  const expiredLease = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          lease_id: "terminal-finalization-lease",
          item_key: driverKey,
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7821",
          run_attempt: 1,
          status_marker: marker,
          status_comment_id: 7821,
        }),
      },
    ),
    env,
  );
  assert.equal(expiredLease.status, 409);
  const restoredState = storage.sql.readNormalizedQueue() as {
    items: Record<string, Record<string, unknown>>;
  };
  restoredState.items[driverKey]!.leaseExpiresAt = Date.now() + 60_000;
  storage.sql.replaceNormalizedQueue(restoredState);
  const acknowledgement = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          lease_id: "terminal-finalization-lease",
          item_key: driverKey,
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7821",
          run_attempt: 1,
          status_marker: marker,
          status_comment_id: 7821,
        }),
      },
    ),
    env,
  );
  assert.deepEqual(await acknowledgement.json(), {
    ok: true,
    allowed: true,
    lifecycle_state: "dead_letter",
    acknowledgement_state: "pending",
    terminal_disposition: "dead_letter",
    status_state: "Failed",
    status_detail:
      "Durable publication exhausted its retry budget and was retained for operator dead-letter recovery.",
    attempt_id: "ack:1",
    version: 1,
  });
  const released = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/failed", {
      method: "POST",
      body: JSON.stringify({
        canonical_target_key: "openclaw/openclaw#782",
        fence_key: leased.key,
        revision: 1,
        attempt_id: "ack:1",
        status_marker: marker,
        status_comment_id: 7821,
      }),
    }),
  );
  assert.equal((await released.json()).released, true);
  const requeued = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/retry",
      {
        method: "POST",
        body: JSON.stringify({
          lease_id: "terminal-finalization-lease",
          item_key: driverKey,
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7821",
          run_attempt: 1,
        }),
      },
    ),
    env,
  );
  assert.deepEqual(await requeued.json(), { ok: true, requeued: true });
  const retryState = storage.sql.readNormalizedQueue() as {
    items: Record<string, Record<string, unknown>>;
  };
  Object.assign(retryState.items[driverKey]!, {
    state: "dispatching",
    leaseId: "terminal-finalization-retry",
    leaseRevision: 1,
    leaseDecision: retryState.items[driverKey]!.decision,
    leaseExpiresAt: Date.now() + 60_000,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
  });
  storage.sql.replaceNormalizedQueue(retryState);
  await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "terminal-finalization-retry",
        item_key: driverKey,
        lease_revision: 1,
        run_id: "7822",
        run_attempt: 1,
      }),
    }),
  );
  const retriedAcknowledgement = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          lease_id: "terminal-finalization-retry",
          item_key: driverKey,
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7822",
          run_attempt: 1,
          status_marker: marker,
          status_comment_id: 7821,
        }),
      },
    ),
    env,
  );
  assert.equal((await retriedAcknowledgement.json()).attempt_id, "ack:2");
  const observed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/observed", {
      method: "POST",
      body: JSON.stringify({
        canonical_target_key: "openclaw/openclaw#782",
        status_marker: marker,
        command_comment_id: 7820,
        completion_comment_id: 7821,
        observed_at: Date.now(),
      }),
    }),
  );
  assert.equal(observed.status, 200);
  assert.equal(storage.sql.readNormalizedQueue().items[driverKey], undefined);
  const projectionStore = new ExactReviewLifecycleProjectionStore(storage);
  const projection = projectionStore.read("openclaw/openclaw#782", leased.key, 1);
  assert.equal(commandAcknowledgementState(projection!), "observed");
});

test("command acknowledgement clamps a future final-receipt timestamp to the queue clock", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/observed", {
      method: "POST",
      body: JSON.stringify({
        canonical_target_key: "openclaw/openclaw#783",
        status_marker: "<!-- clawsweeper-command-status:783:review -->",
        command_comment_id: 7830,
        completion_comment_id: 7831,
        observed_at: Date.now() + 60_000,
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, false);
});

test("newer shared command status leaves a pending terminal finalizer independent", async () => {
  const storage = new MemoryDurableStorage();
  const finalizer = leasedExactReviewPublicationItem(785, "7850");
  const marker = "<!-- clawsweeper-command-status:785:re_review:na -->";
  Object.assign(finalizer.decision.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 7851,
  });
  Object.assign(finalizer.decision, { commandStatusMarker: marker, statusCommentId: 7851 });
  Object.assign(finalizer, {
    state: "pending",
    terminalFinalization: {
      disposition: "failure",
      statusState: "Failed",
      statusDetail:
        "The exact review reached a durable terminal failure and needs operator attention.",
    },
  });
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [finalizer.key]: finalizer },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const successor = exactReviewPublicationOverrides(
    785,
    "7851",
    "re_review",
    2,
    "openclaw/openclaw",
  );
  Object.assign(successor.publication.producerDecision, {
    commandStatusMarker: marker,
    statusCommentId: 7851,
  });
  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "publication-shared-command-status",
      785,
      "exact_review_artifact_publish",
      "issue",
      "openclaw/openclaw",
      { commandStatusMarker: marker, statusCommentId: 7851, ...successor },
    ),
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/openclaw#785@publish:7851:1",
    superseded_publications: 0,
  });
  assert.deepEqual(storage.sql.readNormalizedQueue().items[finalizer.key]?.terminalFinalization, {
    disposition: "failure",
    statusState: "Failed",
    statusDetail:
      "The exact review reached a durable terminal failure and needs operator attention.",
  });
});

test("Worker completes a locked terminal acknowledgement as a projection-backed skip", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewPublicationItem(786, "7860");
  const marker = "<!-- clawsweeper-command-status:786:re_review:locked -->";
  Object.assign(leased.decision.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 7861,
  });
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7861 });
  Object.assign(leased, {
    terminalFinalization: {
      disposition: "review_completed_routed",
      statusState: "Complete",
      statusDetail: "The durable review result and its route handoff completed.",
    },
  });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#786",
    fenceKey: leased.key,
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "terminal-locked:786",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: marker,
    statusCommentId: 7861,
    observedAt: Date.now(),
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "terminal-locked:786:canonical",
    observedAt: Date.now(),
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "terminal-locked:786:router",
    observedAt: Date.now(),
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: Date.now(),
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) };
  const tuple = {
    lease_id: leased.leaseId,
    item_key: leased.key,
    lease_revision: 1,
    claim_generation: 1,
    run_id: "7860",
    run_attempt: 1,
    status_marker: marker,
    status_comment_id: 7861,
  };
  const attempted = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify(tuple),
      },
    ),
    env,
  );
  assert.equal((await attempted.json()).attempt_id, "ack:1");
  const skipped = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/skip",
      {
        method: "POST",
        body: JSON.stringify({ ...tuple, attempt_id: "ack:1", reason: "locked_conversation" }),
      },
    ),
    env,
  );
  assert.deepEqual(await skipped.json(), {
    ok: true,
    completed: true,
    lifecycle_state: "acknowledgement_skipped",
    acknowledgement_state: "skipped_locked",
    version: 1,
  });
  assert.equal(storage.sql.readNormalizedQueue().items[leased.key], undefined);
  const projection = lifecycle.read(
    identity.canonicalTargetKey,
    identity.fenceKey,
    identity.revision,
  )!;
  assert.equal(lifecycleState(projection), "acknowledgement_skipped");
  assert.equal(commandAcknowledgementState(projection), "skipped_locked");
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: marker,
      statusCommentId: 7861,
      observedAt: Date.now(),
    }).allowed,
    false,
  );
});

test("Worker completes a missing status comment terminal acknowledgement as a durable skip", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewPublicationItem(787, "7870");
  const marker = "<!-- clawsweeper-command-status:787:automerge:missing -->";
  Object.assign(leased.decision.publication!.producerDecision, {
    sourceAction: "automerge",
    commandStatusMarker: marker,
    statusCommentId: 7871,
  });
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7871 });
  Object.assign(leased, {
    terminalFinalization: {
      disposition: "review_completed_routed",
      statusState: "Complete",
      statusDetail: "The durable review result and its route handoff completed.",
    },
  });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#787",
    fenceKey: leased.key,
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "terminal-missing:787",
    sourceAction: "automerge",
    commandOriginated: true,
    statusMarker: marker,
    statusCommentId: 7871,
    observedAt: Date.now(),
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "terminal-missing:787:canonical",
    observedAt: Date.now(),
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "terminal-missing:787:router",
    observedAt: Date.now(),
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: Date.now(),
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) };
  const tuple = {
    lease_id: leased.leaseId,
    item_key: leased.key,
    lease_revision: 1,
    claim_generation: 1,
    run_id: "7870",
    run_attempt: 1,
    status_marker: marker,
    status_comment_id: 7871,
  };
  const attempted = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify(tuple),
      },
    ),
    env,
  );
  assert.equal((await attempted.json()).attempt_id, "ack:1");
  const rejected = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/skip",
      {
        method: "POST",
        body: JSON.stringify({ ...tuple, attempt_id: "ack:1", reason: "operator_override" }),
      },
    ),
    env,
  );
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "invalid_terminal_finalization_skip" });
  const skipped = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/skip",
      {
        method: "POST",
        body: JSON.stringify({ ...tuple, attempt_id: "ack:1", reason: "missing_status_comment" }),
      },
    ),
    env,
  );
  assert.deepEqual(await skipped.json(), {
    ok: true,
    completed: true,
    lifecycle_state: "acknowledgement_skipped",
    acknowledgement_state: "skipped_missing_comment",
    version: 1,
  });
  assert.equal(storage.sql.readNormalizedQueue().items[leased.key], undefined);
  const projection = lifecycle.read(
    identity.canonicalTargetKey,
    identity.fenceKey,
    identity.revision,
  )!;
  assert.equal(lifecycleState(projection), "acknowledgement_skipped");
  assert.equal(commandAcknowledgementState(projection), "skipped_missing_comment");
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: marker,
      statusCommentId: 7871,
      observedAt: Date.now(),
    }).allowed,
    false,
  );
});

test("Worker observes the generic durable terminal failure acknowledgement", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewPublicationItem(784, "7840");
  const marker = "<!-- clawsweeper-command-status:784:re_review:terminal-failure -->";
  Object.assign(leased.decision.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 7841,
  });
  Object.assign(leased.leaseDecision!.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 7841,
  });
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7841 });
  Object.assign(leased.leaseDecision!, { commandStatusMarker: marker, statusCommentId: 7841 });
  Object.assign(leased, {
    terminalFinalization: {
      disposition: "failure",
      statusState: "Failed",
      statusDetail:
        "The exact review reached a durable terminal failure and needs operator attention.",
    },
  });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#784",
    fenceKey: leased.key,
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "terminal-failure:784",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: marker,
    statusCommentId: 7841,
    observedAt: Date.now(),
  });
  lifecycle.recordTerminalDisposition({ ...identity, kind: "failure", observedAt: Date.now() });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "terminal-failure-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    STATUS_STORE: new MemoryKv(),
    hostedPublicTargetProbe: async () => "public" as const,
  };
  const attempted = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          lease_id: leased.leaseId,
          item_key: leased.key,
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7840",
          run_attempt: 1,
          status_marker: marker,
          status_comment_id: 7841,
        }),
      },
    ),
    env,
  );
  assert.equal((await attempted.json()).attempt_id, "ack:1");
  const observed = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "terminal-failure-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 784 },
        comment: {
          id: 7842,
          body: [
            "<!-- clawsweeper-command-ack:7840 -->",
            marker,
            "<!-- clawsweeper-command-progress:start -->",
            "Re-review progress:",
            "- State: Failed",
            "- Detail: The exact review reached a durable terminal failure and needs operator attention.",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: "2026-07-31T00:00:00.000Z",
          updated_at: "2026-07-31T00:01:00.000Z",
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    env,
  );
  assert.equal(observed.status, 202);
  assert.equal(storage.sql.readNormalizedQueue().items[leased.key], undefined);
  assert.equal(
    commandAcknowledgementState(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!,
    ),
    "observed",
  );
});

test("runnerless batch completion preserves terminal command acknowledgement during rollout", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
    publicationBatchSize: "1",
    captureBatchDispatch: true,
  });
  await withExactReviewAdmissionHarness(harness, async () => {
    const itemNumber = 783;
    const marker = "<!-- clawsweeper-command-status:783:re_review:batch-terminal -->";
    const publication = exactReviewPublicationOverrides(itemNumber, "7830");
    Object.assign(publication.publication.producerDecision, {
      sourceAction: "re_review",
      commandStatusMarker: marker,
      statusCommentId: 7831,
    });
    await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "batch-terminal-acknowledgement",
        itemNumber,
        "exact_review_artifact_publish",
        "issue",
        undefined,
        { commandStatusMarker: marker, statusCommentId: 7831, ...publication },
      ),
    );
    const claim = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({
            claim_id: "terminal-acknowledgement-batch",
            lease_owner: "terminal-acknowledgement-owner",
            max_items: 1,
          }),
        }),
      )
    ).json();
    assert.equal(claim.claimed, true);
    const member = claim.batch.items[0]!;
    const itemKey = member.item_key as string;
    const revision = member.revision as number;
    const claimGeneration = member.claim_generation as number;
    const projection = new ExactReviewLifecycleProjectionStore(harness.storage).read(
      `openclaw/gogcli#${itemNumber}`,
      itemKey,
      revision,
    );
    assert.equal(projection?.admission.commandOriginated, true);
    assert.deepEqual(projection?.claims, []);
    assert.deepEqual(projection?.reviewResults, []);
    const routed = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/lifecycle/router-receipt", {
        method: "POST",
        body: JSON.stringify({
          canonical_target_key: `openclaw/gogcli#${itemNumber}`,
          fence_key: itemKey,
          revision,
          receipt_id: "batch-terminal-router",
          outcome: "durable",
        }),
      }),
    );
    assert.equal(routed.status, 200);
    const completed = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/publication-batches/complete", {
        method: "POST",
        body: JSON.stringify({
          batch_id: "terminal-acknowledgement-batch",
          lease_owner: "terminal-acknowledgement-owner",
          items: [
            {
              item_key: itemKey,
              revision,
              claim_generation: claimGeneration,
              terminal_outcome: "published",
            },
          ],
        }),
      }),
    );
    assert.equal(completed.status, 200);
    const committed = harness.storage.sql.readNormalizedQueue() as {
      items: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(committed.items[itemKey]?.terminalFinalization, {
      disposition: "review_completed_routed",
      statusState: "Complete",
      statusDetail: "The durable review result and its route handoff completed.",
      projection: {
        canonicalTargetKey: `openclaw/gogcli#${itemNumber}`,
        fenceKey: itemKey,
        revision,
      },
    });

    await harness.queue.alarm();
    assert.equal(harness.batchDispatches, 0);
    assert.equal(harness.dispatched.length, 1);
    assert.equal(
      harness.dispatched[0]?.client_payload?.source_action,
      "exact_review_command_acknowledgement",
    );
  });
});

test("canonical commit records and tuples export with one monotonic revision", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(711, "7110");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "record-export-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const commitId = "a".repeat(40);
  const seedRecords = [
    {
      sha: commitId,
      content: "canonical-commit",
      digest: createHash("sha256").update("canonical-commit").digest("hex"),
    },
  ];
  const ingestPayload = { repo_slug: "openclaw-openclaw", records: seedRecords };
  const ingestPath = "/internal/state/records/commits";
  const unsigned = await worker.fetch(
    stateAppendQueueRequest(ingestPath, ingestPayload, "https://clawsweeper.openclaw.ai"),
    env,
  );
  assert.equal(unsigned.status, 401);

  const first = await worker.fetch(
    signedStateAppendRequest(ingestPath, ingestPayload, secret),
    env,
  );
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    ok: true,
    repo_slug: "openclaw-openclaw",
    inserted: 1,
    unchanged: 0,
    watermark: 1,
  });
  const repeated = await worker.fetch(
    signedStateAppendRequest(ingestPath, ingestPayload, secret),
    env,
  );
  assert.deepEqual(await repeated.json(), {
    ok: true,
    repo_slug: "openclaw-openclaw",
    inserted: 0,
    unchanged: 1,
    watermark: 1,
  });

  const publication = {
    canonicalTargetKey: "openclaw/openclaw#711",
    fenceKey: "openclaw/openclaw#711",
    revision: 4,
    sourceSha: "d".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#711",
      fenceKey: "openclaw/openclaw#711",
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/711.md",
        deleted: false,
        mode: "100644",
        bytes: 4,
        contentBase64: Buffer.from("live").toString("base64"),
      },
    ],
    totalBytes: 4,
  };
  const publicationBody = JSON.stringify(publication);
  const publicationSignature = `sha256=${createHmac("sha256", secret).update(publicationBody).digest("hex")}`;
  const published = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": publicationSignature },
      body: publicationBody,
    }),
    env,
  );
  assert.equal(published.status, 202);

  const guarded = await worker.fetch(
    signedStateAppendRequest(ingestPath, ingestPayload, secret),
    env,
  );
  assert.equal(guarded.status, 202);
  assert.equal((await guarded.json()).unchanged, 1);

  const exportPath = "/internal/state/records/export";
  const pageOnePayload = {
    repoSlug: "openclaw-openclaw",
    sections: ["items", "commits"],
    limit: 1,
  };
  const unsignedExport = await worker.fetch(
    stateAppendQueueRequest(exportPath, pageOnePayload, "https://clawsweeper.openclaw.ai"),
    env,
  );
  assert.equal(unsignedExport.status, 401);
  const pageOneResponse = await worker.fetch(
    signedStateAppendRequest(exportPath, pageOnePayload, secret),
    env,
  );
  assert.equal(pageOneResponse.status, 200);
  const pageOne = await pageOneResponse.json();
  assert.equal(pageOne.records.length, 1);
  assert.equal(pageOne.nextCursor, 1);
  const pageTwo = await (
    await worker.fetch(
      signedStateAppendRequest(
        exportPath,
        { ...pageOnePayload, cursor: pageOne.nextCursor },
        secret,
      ),
      env,
    )
  ).json();
  assert.equal(pageTwo.records.length, 1);
  assert.equal(pageTwo.nextCursor, null);
  assert.deepEqual(pageTwo.records[0], {
    section: "items",
    id: "711",
    content: "live",
    digest: createHash("sha256").update("live").digest("hex"),
    revision: 4,
    storeRevision: 2,
    updatedAt: pageTwo.records[0].updatedAt,
    deleted: false,
  });
  const incremental = await (
    await worker.fetch(
      signedStateAppendRequest(
        exportPath,
        { repoSlug: "openclaw-openclaw", sections: ["items"], sinceRevision: 1 },
        secret,
      ),
      env,
    )
  ).json();
  assert.deepEqual(incremental.records, pageTwo.records);

  const conflictingContent = "changed-commit";
  const conflict = await worker.fetch(
    signedStateAppendRequest(
      ingestPath,
      {
        repo_slug: "openclaw-openclaw",
        records: [
          {
            sha: commitId,
            content: conflictingContent,
            digest: createHash("sha256").update(conflictingContent).digest("hex"),
          },
        ],
      },
      secret,
    ),
    env,
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "canonical_commit_record_conflict" });
});

test("record slug discovery authenticates and lists per-repository revisions", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "record-slug-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const slugsPath = "/internal/state/records/slugs";
  const unsigned = await worker.fetch(
    stateAppendQueueRequest(slugsPath, {}, "https://clawsweeper.openclaw.ai"),
    env,
  );
  assert.equal(unsigned.status, 401);

  const empty = await worker.fetch(signedStateAppendRequest(slugsPath, {}, secret), env);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { ok: true, repositories: [] });

  const seed = (slug: string, sha: string, content: string) => ({
    repo_slug: slug,
    records: [
      {
        sha,
        content,
        digest: createHash("sha256").update(content).digest("hex"),
      },
    ],
  });
  const ingestPath = "/internal/state/records/commits";
  for (const payload of [
    seed("zz-later", "a".repeat(40), "later-first"),
    seed("aa-early", "b".repeat(40), "early"),
    seed("zz-later", "c".repeat(40), "later-second"),
  ]) {
    const ingested = await worker.fetch(signedStateAppendRequest(ingestPath, payload, secret), env);
    assert.equal(ingested.status, 202);
  }

  const listed = await worker.fetch(signedStateAppendRequest(slugsPath, {}, secret), env);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), {
    ok: true,
    repositories: [
      { repoSlug: "aa-early", revision: 2 },
      { repoSlug: "zz-later", revision: 3 },
    ],
  });
});

test("record snapshots authenticate, stream multipart R2 objects, serve ranges, prune, and fail closed", async () => {
  const secret = "record-snapshot-secret";
  const unavailableStorage = new MemoryDurableStorage();
  const unavailableQueue = new ExactReviewQueue({ storage: unavailableStorage }, {});
  const unavailableEnv = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(unavailableQueue),
  };
  const triggerPath = "/internal/state/records/snapshots/trigger";
  const triggerBody = { repoSlug: "openclaw-openclaw" };
  const unsigned = await worker.fetch(
    stateAppendQueueRequest(triggerPath, triggerBody, "https://clawsweeper.openclaw.ai"),
    unavailableEnv,
  );
  assert.equal(unsigned.status, 401);
  const unavailable = await worker.fetch(
    signedStateAppendRequest(triggerPath, triggerBody, secret),
    unavailableEnv,
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: "snapshot_store_unavailable",
    snapshotStoreAvailable: false,
    detail: "STATE_SNAPSHOTS is not available",
  });

  const storage = new MemoryDurableStorage();
  const bucket = new MemoryR2Bucket();
  const queue = new ExactReviewQueue(
    { storage },
    {
      STATE_SNAPSHOTS: {
        createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
        head: bucket.head.bind(bucket),
        get: async () => assert.fail("snapshot bytes must bypass the queue object"),
        delete: bucket.delete.bind(bucket),
      },
    },
  );
  const queuePaths: string[] = [];
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    STATE_SNAPSHOTS: bucket,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
      fetch(request: Request) {
        queuePaths.push(new URL(request.url).pathname);
        return queue.fetch(request);
      },
    }),
  };
  const records = [
    { sha: "d".repeat(40), content: "snapshot commit one\n" },
    { sha: "e".repeat(40), content: "snapshot commit two\n" },
  ].map((record) => ({
    ...record,
    digest: createHash("sha256").update(record.content).digest("hex"),
  }));
  const ingest = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state/records/commits",
      { repo_slug: "openclaw-openclaw", records },
      secret,
    ),
    env,
  );
  assert.equal(ingest.status, 202);

  let latestSnapshot: {
    revisionWatermark: number;
    bytes: number;
    fileCount: number;
    objectKey: string;
  } | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await worker.fetch(
      signedStateAppendRequest(triggerPath, triggerBody, secret),
      env,
    );
    assert.equal(response.status, 201);
    latestSnapshot = (await response.json()).snapshot;
  }
  assert.ok(latestSnapshot);
  assert.equal(latestSnapshot.fileCount, records.length);
  assert.equal(latestSnapshot.revisionWatermark, records.length);
  assert.equal(bucket.keys().length, 2);
  const snapshotRows = Array.from(
    storage.sql.exec("SELECT object_key FROM exact_review_record_snapshots"),
  );
  assert.equal(snapshotRows.length, 2);

  const latestResponse = await worker.fetch(
    signedStateAppendRequest("/internal/state/records/snapshots/latest", triggerBody, secret),
    env,
  );
  assert.equal(latestResponse.status, 200);
  assert.equal((await latestResponse.json()).snapshot.objectKey, latestSnapshot.objectKey);

  const chunkBody = {
    repoSlug: "openclaw-openclaw",
    revisionWatermark: latestSnapshot.revisionWatermark,
    offset: 0,
    length: latestSnapshot.bytes,
  };
  const chunk = await worker.fetch(
    signedStateAppendRequest("/internal/state/records/snapshots/chunk", chunkBody, secret),
    env,
  );
  assert.equal(chunk.status, 206);
  assert.equal(
    chunk.headers.get("content-range"),
    `bytes 0-${latestSnapshot.bytes - 1}/${latestSnapshot.bytes}`,
  );
  const tar = gunzipSync(Buffer.from(await chunk.arrayBuffer()));
  assert.match(tar.toString("utf8"), new RegExp(`commits/${"d".repeat(40)}\\.md`));
  assert.match(tar.toString("utf8"), /snapshot commit one/);
  assert.match(tar.toString("utf8"), new RegExp(`commits/${"e".repeat(40)}\\.md`));

  const chunkPath = "/internal/state/records/snapshots/chunk";
  const readChunk = (overrides = {}, readEnv: Record<string, unknown> = env) =>
    worker.fetch(
      signedStateAppendRequest(chunkPath, { ...chunkBody, ...overrides }, secret),
      readEnv,
    );
  assert.equal(queuePaths.at(-1), "/records/snapshots/range");
  assert.ok(!queuePaths.includes("/records/snapshots/chunk"));

  const queueReads = queuePaths.length;
  const unsignedChunk = await worker.fetch(
    stateAppendQueueRequest(chunkPath, chunkBody, "https://clawsweeper.openclaw.ai"),
    env,
  );
  assert.equal(unsignedChunk.status, 401);
  assert.equal(queuePaths.length, queueReads);

  const tail = await readChunk({ offset: 3, length: latestSnapshot.bytes });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get("content-length"), String(latestSnapshot.bytes - 3));
  assert.equal(
    tail.headers.get("content-range"),
    `bytes 3-${latestSnapshot.bytes - 1}/${latestSnapshot.bytes}`,
  );
  assert.equal(
    tail.headers.get("x-clawsweeper-snapshot-revision"),
    String(latestSnapshot.revisionWatermark),
  );
  for (const invalid of [
    { offset: -1 },
    { offset: 0.5 },
    { offset: latestSnapshot.bytes },
    { length: 0 },
    { length: 33 * 1024 * 1024 },
  ]) {
    const response = await readChunk(invalid);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_snapshot_range");
  }
  const missing = await readChunk({ revisionWatermark: latestSnapshot.revisionWatermark + 1 });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "snapshot_not_found");
  const missingBinding = await readChunk({}, { ...env, STATE_SNAPSHOTS: undefined });
  assert.equal(missingBinding.status, 503);
  assert.equal((await missingBinding.json()).error, "snapshot_store_unavailable");
  await bucket.delete(latestSnapshot.objectKey);
  const pruned = await readChunk();
  assert.equal(pruned.status, 503);
  assert.equal((await pruned.json()).error, "snapshot_store_unavailable");
});

test("exact-review queue counts only work that successfully leaves each lane", async () => {
  const storage = new MemoryDurableStorage();
  const directPublication = leasedExactReviewQueueItem(703, "7030");
  directPublication.decision.sourceAction = "exact_review_artifact_publish";
  directPublication.leaseDecision.sourceAction = "exact_review_artifact_publish";
  const reconciledPublication = leasedExactReviewQueueItem(704, "7040");
  reconciledPublication.decision.sourceAction = "exact_review_artifact_publish";
  reconciledPublication.leaseDecision.sourceAction = "exact_review_artifact_publish";
  const failedPublication = leasedExactReviewQueueItem(705, "7050");
  failedPublication.decision.sourceAction = "exact_review_artifact_publish";
  failedPublication.leaseDecision.sourceAction = "exact_review_artifact_publish";
  const driftPublication = leasedExactReviewQueueItem(707, "7070");
  driftPublication.decision.sourceAction = "exact_review_artifact_publish";
  driftPublication.leaseDecision.sourceAction = "exact_review_artifact_publish";
  const review = leasedExactReviewQueueItem(706, "7060");
  const reconciledReviewFailure = leasedExactReviewQueueItem(708, "7080");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: Object.fromEntries(
      [
        directPublication,
        reconciledPublication,
        failedPublication,
        driftPublication,
        review,
        reconciledReviewFailure,
      ].map((item) => [item.key, item]),
    ),
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = (
    item: ReturnType<typeof leasedExactReviewQueueItem>,
    outcome: string,
    requeueLatest = false,
  ) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: item.key,
          lease_revision: item.leaseRevision,
          claim_generation: item.claimGeneration,
          run_id: item.claimedRunId,
          run_attempt: item.claimedRunAttempt,
          outcome,
          ...(requeueLatest ? { requeue_latest: true } : {}),
        }),
      }),
    );

  assert.equal((await complete(directPublication, "success")).status, 200);
  assert.equal((await complete(review, "success")).status, 200);
  assert.equal((await complete(failedPublication, "failure")).status, 200);
  assert.equal((await complete(driftPublication, "success", true)).status, 200);
  assert.equal((await complete(directPublication, "success")).status, 409);

  const reconcileBody = {
    runs: [
      {
        run_id: reconciledPublication.claimedRunId,
        run_attempt: reconciledPublication.claimedRunAttempt,
        claimed_run_attempt: reconciledPublication.claimedRunAttempt,
        claim_generation: reconciledPublication.claimGeneration,
        outcome: "success",
      },
      {
        run_id: reconciledReviewFailure.claimedRunId,
        run_attempt: reconciledReviewFailure.claimedRunAttempt,
        claimed_run_attempt: reconciledReviewFailure.claimedRunAttempt,
        claim_generation: reconciledReviewFailure.claimGeneration,
        outcome: "failure",
      },
    ],
  };
  const reconciled = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify(reconcileBody),
    }),
  );
  assert.deepEqual(await reconciled.json(), {
    ok: true,
    reconciled: 2,
    requeued: 1,
    completed: 1,
  });
  assert.equal(
    (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/reconcile", {
          method: "POST",
          body: JSON.stringify(reconcileBody),
        }),
      )
    ).status,
    200,
  );

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.completed_total, 1);
  assert.equal(stats.lanes.review.flow.last_15_minutes.successful_rate_per_hour, 4);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retried_rate_per_hour, 4);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retry_amplification, 1);
  assert.equal(stats.lanes.publication.completed_total, 2);
  assert.equal(stats.lanes.publication.pending, 2);
});

test("exact-review completion and lane metrics roll back together", async () => {
  const storage = new MemoryDurableStorage();
  const review = leasedExactReviewQueueItem(708, "7080");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [review.key]: review },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const complete = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: review.leaseId,
          item_key: review.key,
          lease_revision: review.leaseRevision,
          claim_generation: review.claimGeneration,
          run_id: review.claimedRunId,
          run_attempt: review.claimedRunAttempt,
          outcome: "success",
        }),
      }),
    );

  storage.failNextSql(/SET review_enqueued_total = review_enqueued_total \+ \?/);
  await assert.rejects(complete(), /injected SQL failure/);
  let state = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.ok(state.items[review.key]);
  let stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.completed_total, 0);

  assert.equal((await complete()).status, 200);
  state = (await storage.get("exact-review-queue")) as typeof state;
  assert.equal(state.items[review.key], undefined);
  stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.completed_total, 1);
});

test("exact-review queue admits and wakes up to 24 publishers", () => {
  const now = 1_000_000;
  const publication = (number: number) => ({
    key: `openclaw/openclaw#${number}@publish:${number}:1`,
    state: "pending",
    nextAttemptAt: now,
    leaseExpiresAt: undefined,
    decision: {
      sourceAction: "exact_review_artifact_publish",
      targetRepo: "openclaw/openclaw",
      itemNumber: number,
    },
  });
  const state = {
    items: Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => {
        const item = publication(index + 1);
        return [item.key, item];
      }),
    ),
  } as never;
  assert.equal(exactReviewQueueAdmittedItems(state, now, 64, 60, 24).length, 24);

  const active = publication(1);
  active.state = "leased";
  active.leaseExpiresAt = now + 60_000;
  const pending = publication(2);
  const wakeState = { items: { [active.key]: active, [pending.key]: pending } } as never;
  assert.equal(exactReviewQueueNextWakeAt(wakeState, now, 64, 60, 24), now + 1_000);
  assert.equal(exactReviewQueueNextWakeAt(wakeState, now, 64, 60, 1), now + 60_000);

  const activeReview = {
    key: "openclaw/openclaw#3",
    state: "leased",
    nextAttemptAt: now,
    leaseExpiresAt: now + 45_000,
    decision: { sourceAction: "opened", targetRepo: "openclaw/openclaw" },
  };
  const budgetBlockedState = {
    items: { [activeReview.key]: activeReview, [pending.key]: pending },
  } as never;
  assert.equal(exactReviewQueueNextWakeAt(budgetBlockedState, now, 64, 60, 0), now + 45_000);
  assert.equal(
    exactReviewQueueNextWakeAt({ items: { [pending.key]: pending } } as never, now, 64, 60, 0),
    now + 30_000,
  );
});

test("publish-keyed backlog cannot block review admission from filling capacity", () => {
  const now = 1_000_000;
  const publication = {
    key: "openclaw/openclaw#1@publish:100:1",
    state: "pending",
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    nextAttemptAt: now,
    attempts: 0,
    revision: 1,
    decision: {
      sourceAction: "exact_review_artifact_publish",
      targetRepo: "openclaw/openclaw",
      itemNumber: 1,
    },
  };
  const reviews = Array.from({ length: 200 }, (_, index) => ({
    key: `openclaw/openclaw#${index + 2}`,
    state: "pending",
    createdAt: now - 30_000 + index,
    updatedAt: now - 30_000 + index,
    nextAttemptAt: now,
    attempts: 0,
    revision: 1,
    decision: {
      sourceAction: "scheduled_normal_backfill",
      targetRepo: "openclaw/openclaw",
      itemNumber: index + 2,
    },
  }));
  const state = {
    items: Object.fromEntries([publication, ...reviews].map((item) => [item.key, item])),
  } as never;

  const admitted = exactReviewQueueAdmittedItems(state, now, 128, 128, 0);
  assert.equal(admitted.length, 128);
  assert.ok(admitted.every((item) => !item.key.includes("@publish:")));
});

test("dashboard status reads the exact-review handoff model from the durable queue", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  await queue.fetch(buildExactReviewQueueRequest("handoff-status", 597, "opened"));
  await queue.fetch(buildExactReviewQueueRequest("backoff-status", 598, "opened"));
  await queue.fetch(buildExactReviewQueueRequest("leased-review-status", 600, "opened"));
  await queue.fetch(buildExactReviewQueueRequest("recovery-status", 601, "source_drift_requeue"));
  await queue.fetch(
    buildExactReviewQueueRequest(
      "publication-status",
      599,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(599, "5990"),
    ),
  );
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: "pending" | "dispatching" | "leased";
        nextAttemptAt: number;
        leaseId?: string;
        leaseExpiresAt?: number;
        decision: { sourceAction: string };
      }
    >;
  };
  state.items["openclaw/gogcli#598"].nextAttemptAt = Date.now() + 60_000;
  for (const key of ["openclaw/gogcli#600", "openclaw/gogcli#599@publish:5990:1"]) {
    state.items[key].state = "leased";
    state.items[key].leaseId = `lease-${key}`;
    state.items[key].leaseExpiresAt = Date.now() + 60_000;
  }
  await storage.put("exact-review-queue", state);

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.ok(status);
  assert.match(status.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(status.pending, 3);
  assert.equal(status.ready_pending, 2);
  assert.equal(status.admissible_pending, 2);
  assert.equal(status.dispatching, 0);
  assert.equal(status.leased, 1);
  assert.equal(status.handoff_health.status, "healthy");
  assert.equal(status.handoff_health.phases.pending.count, 3);
  assert.equal(status.lanes.review.enqueued_total, 4);
  assert.equal(status.lanes.review.completed_total, 0);
  assert.equal(status.lanes.publication.enqueued_total, 1);
  assert.equal(status.lanes.publication.completed_total, 0);
  assert.equal(status.review_execution_health, undefined);
  assert.deepEqual(
    {
      pending: status.lanes.review.pending,
      ready: status.lanes.review.ready,
      backoff: status.lanes.review.backoff,
      active: status.lanes.review.active,
      available_slots: status.lanes.review.available_slots,
      capacity: status.lanes.review.capacity,
    },
    { pending: 3, ready: 2, backoff: 1, active: 1, available_slots: 31, capacity: 32 },
  );
  assert.deepEqual(
    {
      pending: status.lanes.publication.pending,
      ready: status.lanes.publication.ready,
      backoff: status.lanes.publication.backoff,
      active: status.lanes.publication.active,
      available_slots: status.lanes.publication.available_slots,
      capacity: status.lanes.publication.capacity,
    },
    { pending: 0, ready: 0, backoff: 0, active: 1, available_slots: 23, capacity: 24 },
  );
  assert.equal(typeof status.lanes.review.oldest_pending_at, "string");
  assert.equal(status.lanes.review.oldest_pending_key, "openclaw/gogcli#597");
  assert.equal(typeof status.lanes.review.next_attempt_at, "string");
  assert.equal(status.pressure.status, "idle");
  assert.equal(status.pressure.reason, "capacity_available");
  assert.equal(status.pressure.active, status.lanes.review.active);
  assert.equal(status.pressure.pending, status.lanes.review.pending);
  assert.equal(status.pressure.capacity, status.lanes.review.capacity);
  assert.equal(status.bay_projection.complete, true);
  assert.deepEqual(status.bay_projection.stages, {
    arriving: 2,
    "setting-up": 1,
    reviewing: 0,
    publishing: 1,
    applying: 0,
    repairing: 1,
  });
  assert.deepEqual(status.bay_projection.legacy_batch_stages, {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 1,
    applying: 0,
    repairing: 0,
  });
  assert.deepEqual(
    status.bay_projection.items.map((item) => ({
      item_key: item.item_key,
      stage: item.stage,
      queue_state: item.queue_state,
    })),
    [
      { item_key: "openclaw/gogcli#597", stage: "arriving", queue_state: "pending" },
      { item_key: "openclaw/gogcli#600", stage: "setting-up", queue_state: "leased" },
      { item_key: "openclaw/gogcli#601", stage: "repairing", queue_state: "pending" },
      { item_key: "openclaw/gogcli#598", stage: "arriving", queue_state: "pending" },
      { item_key: "openclaw/gogcli#599", stage: "publishing", queue_state: "leased" },
    ],
  );
  assert.deepEqual(Object.keys(status.bay_projection.items[0]).sort(), [
    "created_at",
    "item_key",
    "item_number",
    "legacy_batch_path",
    "next_attempt_at",
    "queue_state",
    "repository",
    "stage",
    "updated_at",
  ]);
  assert.equal(await exactReviewQueueStatusSnapshot({}), null);
});

test("Bay queue projection maps durable batch-owned publication items to Applying", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    {
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
      EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "1",
    },
  );
  await queue.fetch(
    buildExactReviewQueueRequest(
      "bay-batch-applying",
      602,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(602, "6020"),
    ),
  );
  const claim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
      method: "POST",
      body: JSON.stringify({
        claim_id: "bay-applying-batch",
        lease_owner: "bay-applying-owner",
        max_items: 1,
      }),
    }),
  );
  assert.equal((await claim.json()).claimed, true);

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.ok(status);
  assert.deepEqual(status.bay_projection.stages, {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 1,
    repairing: 0,
  });
  assert.deepEqual(
    status.bay_projection.items.map((item) => ({
      item_key: item.item_key,
      stage: item.stage,
      batch_id: item.batch_id,
    })),
    [
      {
        item_key: "openclaw/gogcli#602",
        stage: "applying",
        batch_id: "bay-applying-batch",
      },
    ],
  );
});

test("Bay queue projection keeps scheduled exact reviews on the direct path", async () => {
  const queue = new ExactReviewQueue(
    { storage: new MemoryDurableStorage() },
    { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" },
  );
  await queue.fetch(
    buildExactReviewQueueRequest(
      "bay-scheduled-direct",
      603,
      "scheduled_hot_intake",
      "issue",
      "openclaw/openclaw",
    ),
  );

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.equal(status?.bay_projection.items[0]?.legacy_batch_path, false);
});

test("Bay queue projection preserves a direct review beside newer legacy publication work", async () => {
  const storage = new MemoryDurableStorage();
  const direct = leasedExactReviewQueueItem(605, "6050");
  const legacy = leasedExactReviewPublicationItem(605, "6051");
  legacy.updatedAt = direct.updatedAt + 1_000;
  legacy.nextAttemptAt = direct.nextAttemptAt + 1_000;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [direct.key]: direct, [legacy.key]: legacy },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.equal(status?.bay_projection.total, 1);
  assert.equal(status?.bay_projection.items[0]?.item_key, direct.key);
  assert.equal(status?.bay_projection.items[0]?.legacy_batch_path, false);

  const legacyActive = await exactReviewQueueStatusSnapshot(
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    { bayActiveLegacyKeys: [direct.key] },
  );
  assert.equal(legacyActive?.bay_projection.active_overlaps["setting-up"], 0);

  const directActive = await exactReviewQueueStatusSnapshot(
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    { bayActiveKeys: [direct.key] },
  );
  assert.equal(directActive?.bay_projection.active_overlaps["setting-up"], 1);
});

test("Bay queue projection retains the legacy path during batch terminal finalization", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(603, "6030");
  Object.assign(item, {
    state: "pending",
    terminalFinalization: {
      disposition: "review_completed_routed",
      statusState: "Complete",
      statusDetail: "The durable review result and its route handoff completed.",
    },
  });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.equal(status?.bay_projection.items[0]?.legacy_batch_path, true);
});

test("Bay queue projection sends parked review and publication work to Repair Cove", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  await queue.fetch(buildExactReviewQueueRequest("bay-parked-review", 603, "opened"));
  await queue.fetch(
    buildExactReviewQueueRequest(
      "bay-parked-publication",
      604,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(604, "6040"),
    ),
  );
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; parkedReason?: string }>;
  };
  state.items["openclaw/gogcli#603"].state = "parked";
  state.items["openclaw/gogcli#603"].parkedReason = "review_retry_exhausted";
  state.items["openclaw/gogcli#604@publish:6040:1"].state = "parked";
  state.items["openclaw/gogcli#604@publish:6040:1"].parkedReason = "dead_letter_capacity";
  await storage.put("exact-review-queue", state);

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.ok(status);
  assert.deepEqual(status.bay_projection.stages, {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 2,
  });
  assert.deepEqual(
    status.bay_projection.items.map((item) => ({ item_key: item.item_key, stage: item.stage })),
    [
      { item_key: "openclaw/gogcli#603", stage: "repairing" },
      { item_key: "openclaw/gogcli#604", stage: "repairing" },
    ],
  );
});

test("Bay queue projection caps its sample and validates its full durable census", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  for (let index = 0; index < 9; index += 1) {
    await queue.fetch(
      buildExactReviewQueueRequest(`bay-arriving-${index}`, 10_000 + index, "opened"),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(`bay-setting-${index}`, 20_000 + index, "opened"),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        `bay-repairing-${index}`,
        30_000 + index,
        "source_drift_requeue",
      ),
    );
  }
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: unknown;
        leaseId?: string;
        leaseExpiresAt?: number;
        key: string;
        decision?: { targetRepo: unknown; itemNumber: unknown } | null;
        createdAt: unknown;
        updatedAt: unknown;
        nextAttemptAt: unknown;
      }
    >;
  };
  for (let index = 0; index < 9; index += 1) {
    const item = state.items[`openclaw/gogcli#${20_000 + index}`];
    item.state = "leased";
    item.leaseId = `bay-setting-lease-${index}`;
    item.leaseExpiresAt = Date.now() + 10 * 60_000;
  }
  const caseSource = state.items["openclaw/gogcli#30008"];
  assert.ok(caseSource.decision);
  caseSource.decision.targetRepo = "OpenClaw/GogCli";
  const caseVariant = structuredClone(state.items["openclaw/gogcli#30008"]);
  caseVariant.key = "openclaw/gogcli#30008@legacy-case";
  assert.ok(caseVariant.decision);
  caseVariant.decision.targetRepo = "openclaw/gogcli";
  state.items[caseVariant.key] = caseVariant;
  await storage.put("exact-review-queue", state);

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.ok(status);
  assert.equal(status.bay_projection.complete, true);
  assert.equal(status.bay_projection.sample_limit, 24);
  assert.deepEqual(status.bay_projection.stages, {
    arriving: 9,
    "setting-up": 9,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 9,
  });
  assert.equal(status.bay_projection.total, 27);
  assert.equal(status.bay_projection.items.length, 24);
  assert.deepEqual(
    Object.fromEntries(
      ["arriving", "setting-up", "repairing"].map((stage) => [
        stage,
        status.bay_projection.items.filter((item) => item.stage === stage).length,
      ]),
    ),
    { arriving: 8, "setting-up": 8, repairing: 8 },
  );
  assert.deepEqual(status.bay_projection.active_overlaps, {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 0,
  });
  assert.deepEqual(status.bay_projection.legacy_batch_stages, {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 0,
  });

  const correlatedOutsideSample = await exactReviewQueueStatusSnapshot(
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    {
      bayActiveKeys: [
        "OPENCLAW/GOGCLI#20008",
        "OpenClaw/GogCli#30008",
        "openclaw/gogcli#30008",
        "not-a-valid-target",
      ],
    },
  );
  assert.ok(correlatedOutsideSample);
  assert.deepEqual(correlatedOutsideSample.bay_projection.active_overlaps, {
    arriving: 0,
    "setting-up": 1,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 1,
  });
  assert.equal(
    correlatedOutsideSample.bay_projection.items.some(
      (item) => item.item_key === "openclaw/gogcli#30008",
    ),
    false,
  );

  const prioritized = await exactReviewQueueStatusSnapshot(
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    { bayPriorityKeys: ["OPENCLAW/GOGCLI#30008"] },
  );
  assert.ok(prioritized);
  assert.equal(prioritized.bay_projection.items.length, 24);
  assert.equal(prioritized.bay_projection.items[0].item_key, "openclaw/gogcli#30008");
  assert.equal(
    prioritized.bay_projection.items.filter((item) => item.item_key === "openclaw/gogcli#30008")
      .length,
    1,
  );

  const firstRowsInEachLane = [
    ...Array.from({ length: 7 }, (_, index) => `openclaw/gogcli#${10_000 + index}`),
    ...Array.from({ length: 7 }, (_, index) => `openclaw/gogcli#${20_000 + index}`),
    ...Array.from({ length: 7 }, (_, index) => `openclaw/gogcli#${30_000 + index}`),
  ];
  const prioritizedLaneRows = await exactReviewQueueStatusSnapshot(
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    { bayPriorityKeys: firstRowsInEachLane },
  );
  assert.ok(prioritizedLaneRows);
  assert.equal(prioritizedLaneRows.bay_projection.items.length, 24);

  const matchingPriorityAfterStaleCards = await exactReviewQueueStatusSnapshot(
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    {
      bayPriorityKeys: [
        ...Array.from({ length: 20 }, (_, index) => `openclaw/stale#${index + 1}`),
        "openclaw/gogcli#30008",
      ],
    },
  );
  assert.ok(matchingPriorityAfterStaleCards);
  assert.equal(
    matchingPriorityAfterStaleCards.bay_projection.items[0].item_key,
    "openclaw/gogcli#30008",
  );

  assert.equal(
    status.bay_projection.items.some((item) => item.item_key === "openclaw/gogcli#10008"),
    false,
  );
  const cleanState = structuredClone(state);
  const malformedMarker = "malformed-legacy-value";
  const corruptions: Array<{
    mutate: (item: (typeof state.items)[string]) => void;
    retained: (item: (typeof state.items)[string]) => boolean;
  }> = [
    {
      mutate: (item) => {
        item.decision = null;
      },
      retained: (item) => item.decision === null,
    },
    {
      mutate: (item) => {
        delete item.decision;
      },
      retained: (item) => !Object.prototype.hasOwnProperty.call(item, "decision"),
    },
    {
      mutate: (item) => {
        assert.ok(item.decision);
        item.decision.targetRepo = { category: malformedMarker };
      },
      retained: (item) => JSON.stringify(item.decision?.targetRepo).includes(malformedMarker),
    },
    {
      mutate: (item) => {
        assert.ok(item.decision);
        item.decision.itemNumber = malformedMarker;
      },
      retained: (item) => item.decision?.itemNumber === malformedMarker,
    },
    {
      mutate: (item) => {
        item.state = malformedMarker;
      },
      retained: (item) => item.state === malformedMarker,
    },
    {
      mutate: (item) => {
        item.createdAt = malformedMarker;
      },
      retained: (item) => item.createdAt === malformedMarker,
    },
    {
      mutate: (item) => {
        item.updatedAt = malformedMarker;
      },
      retained: (item) => item.updatedAt === malformedMarker,
    },
    {
      mutate: (item) => {
        item.nextAttemptAt = malformedMarker;
      },
      retained: (item) => item.nextAttemptAt === malformedMarker,
    },
  ];
  for (const corruption of corruptions) {
    const corruptState = structuredClone(cleanState);
    corruption.mutate(corruptState.items["openclaw/gogcli#10008"]);
    await storage.put("exact-review-queue", corruptState);
    const restartedQueue = new ExactReviewQueue(
      { storage },
      { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" },
    );
    const malformed = await exactReviewQueueStatusSnapshot({
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(restartedQueue),
    });
    assert.ok(malformed);
    assert.match(malformed.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Number.isSafeInteger(malformed.lanes.review.pending), true);
    assert.deepEqual(malformed.bay_projection, {
      complete: false,
      sample_limit: 24,
      total: null,
      stages: null,
      legacy_batch_stages: null,
      active_overlaps: null,
      legacy_batch_active_overlaps: null,
      items: [],
    });
    assert.equal(JSON.stringify(malformed.bay_projection).includes(malformedMarker), false);
    const retainedState = (await storage.get("exact-review-queue")) as typeof state;
    assert.equal(corruption.retained(retainedState.items["openclaw/gogcli#10008"]), true);
  }
  await storage.put("exact-review-queue", cleanState);
});

test("Bay queue projection samples normal direct work across stages before hidden legacy rows", async () => {
  const storage = new MemoryDurableStorage();
  const items: Record<
    string,
    | ReturnType<typeof leasedExactReviewPublicationItem>
    | ReturnType<typeof leasedExactReviewQueueItem>
  > = {};
  for (let index = 0; index < 24; index += 1) {
    const legacy = leasedExactReviewPublicationItem(40_000 + index, String(80_000 + index));
    items[legacy.key] = legacy;
    const normal = leasedExactReviewQueueItem(60_000 + index, String(100_000 + index));
    items[normal.key] = normal;
  }
  const direct = leasedExactReviewPublicationItem(50_000, "90000");
  assert.ok(direct.decision.publication);
  assert.ok(direct.leaseDecision.publication);
  direct.decision.publication.directLifecycle = {
    plan: { kind: "router" },
    receiptOutcome: "accepted",
  };
  direct.leaseDecision.publication.directLifecycle = {
    plan: { kind: "router" },
    receiptOutcome: "accepted",
  };
  items[direct.key] = direct;
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const queue = new ExactReviewQueue({ storage }, {});

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.ok(status);
  assert.equal(status.bay_projection.total, 49);
  assert.equal(status.bay_projection.items.length, 24);
  assert.equal(
    status.bay_projection.items.some((item) => item.item_number === 50_000),
    true,
  );
  assert.equal(status.bay_projection.items.filter((item) => item.legacy_batch_path).length, 0);
  assert.equal(status.bay_projection.items.filter((item) => item.stage === "publishing").length, 1);
});

test("public triage pages expose aggregate counts without identity controls", async () => {
  const issuePage = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/triage"), {});
  const proofPage = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/pr-proof-triage"),
    {},
  );
  const issueHtml = await issuePage.text();
  const proofHtml = await proofPage.text();
  for (const html of [issueHtml, proofHtml]) {
    assert.match(html, /Privacy-safe aggregate triage counts/);
    assert.match(html, /bounded category counts only/);
    assert.match(html, /id="metrics"/);
    assert.match(html, /id="tabs"/);
    assert.match(html, /id="view-count"/);
    assert.match(html, /id="snapshot-health"/);
    assert.match(html, /Aggregate snapshot is temporarily unavailable/);
    assert.match(html, /collection errors were withheld/);
    assert.match(html, /function publicSnapshot\(value\)/);
    assert.match(html, /function renderMetrics\(\)/);
    assert.match(html, /function renderTabs\(\)/);
    assert.doesNotMatch(html, /href="\/bay"/);
    assert.doesNotMatch(html, /id="issue-filter"/);
    assert.doesNotMatch(html, /id="issue-sort"/);
    assert.doesNotMatch(html, /id="routing-group"/);
    assert.doesNotMatch(html, /id="github-query"/);
    assert.doesNotMatch(html, /id="visible-count"/);
    assert.doesNotMatch(html, /id="table"/);
    assert.doesNotMatch(html, /<table[ >]/);
    assert.doesNotMatch(html, /rowCellHtml|renderRows|searchableText|routingGroupGithubUrl/);
    assert.doesNotMatch(html, /data-filter-value|linkedPullRequestPills/);
    assert.doesNotMatch(html, /diagnostics(?:\?\.)?\.errors|target_repositories/);
    assert.doesNotMatch(html, /href="https:\/\/github\.com\/issues/);
  }
  assert.match(issueHtml, /Ready candidates/);
  assert.match(issueHtml, /Queueable fixes without a no-new-fix-pr blocker/);
  assert.match(proofHtml, /Needs proof review/);
  assert.match(proofHtml, /Proof is requested but not yet marked sufficient or overridden/);
});

async function renderPublicTriageApplication(
  html: string,
  pathname: string,
  fetchResponse: () => Promise<unknown>,
) {
  const applicationScript = publicTriageApplicationScript(html);
  const elements = new Map(
    [
      "metrics",
      "tabs",
      "view-name",
      "view-description",
      "view-count",
      "snapshot-health",
      "updated",
    ].map((id) => [id, { id, innerHTML: "", textContent: "", dataset: {} }]),
  );
  const context = createContext({
    console,
    Date,
    Intl,
    Number,
    Object,
    Array,
    Map,
    String,
    encodeURIComponent,
    window: {
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
      localStorage: { getItem: () => null, setItem: () => undefined },
    },
    document: {
      documentElement: { dataset: {} },
      getElementById: (id: string) => elements.get(id),
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    location: { hash: "", pathname },
    history: { replaceState: () => undefined },
    fetch: fetchResponse,
    setInterval: () => 0,
  });
  new Script(applicationScript).runInContext(context);
  await new Promise((resolve) => setImmediate(resolve));
  return elements;
}

function publicTriageApplicationScript(html: string) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  return scripts.at(-1)?.[1] || "";
}

test("public triage application script extraction is case-insensitive", () => {
  assert.equal(
    publicTriageApplicationScript("<SCRIPT>safeApplication()</SCRIPT>"),
    "safeApplication()",
  );
});

test("public triage UI renders only closed aggregate definitions and bounded counts", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/triage"), {});
  const html = await response.text();
  const marker = "synthetic-ui-identity-marker";
  const viewIds = [
    "clawsweeper",
    "ready-candidates",
    "queueable-blocked",
    "already-has-pr",
    "needs-info",
    "needs-maintainer-review",
    "product-security",
    "needs-live-repro",
  ];
  const elements = await renderPublicTriageApplication(html, "/triage", async () => ({
    ok: true,
    json: async () => ({
      schema_version: 2,
      generated_at: "2026-08-15T12:00:00.000Z",
      complete: true,
      error_count: 0,
      views: viewIds.map((id, index) => ({
        id,
        title: marker,
        description: marker,
        total_count: index + 11,
        items: [{ title: marker, url: marker }],
      })),
    }),
  }));

  assert.match(String(elements.get("metrics")?.innerHTML), /ClawSweeper issues/);
  assert.match(String(elements.get("metrics")?.innerHTML), />11</);
  assert.match(String(elements.get("tabs")?.innerHTML), /Ready candidates/);
  assert.equal(elements.get("view-name")?.textContent, "ClawSweeper");
  assert.equal(
    elements.get("view-description")?.textContent,
    "Open issues carrying any ClawSweeper label.",
  );
  assert.equal(elements.get("view-count")?.textContent, "11");
  assert.match(String(elements.get("snapshot-health")?.textContent), /Complete aggregate snapshot/);
  assert.doesNotMatch(
    [...elements.values()]
      .map((element) => `${element.innerHTML} ${element.textContent}`)
      .join(" "),
    new RegExp(marker, "i"),
  );
});

test("public triage UI fails closed for malformed and unavailable snapshots", async () => {
  const marker = "synthetic-ui-malformed-marker";
  const pages = [
    {
      pathname: "/triage",
      viewIds: [
        "clawsweeper",
        "ready-candidates",
        "queueable-blocked",
        "already-has-pr",
        "needs-info",
        "needs-maintainer-review",
        "product-security",
        "needs-live-repro",
      ],
    },
    {
      pathname: "/pr-proof-triage",
      viewIds: [
        "proof-triage",
        "needs-proof",
        "missing-proof",
        "sufficient-proof",
        "mock-only-proof",
        "telegram-proof",
        "sufficient-with-need-label",
      ],
    },
  ];
  const renderedText = (elements: Map<string, { innerHTML: string; textContent: string }>) =>
    [...elements.values()]
      .map((element) => `${element.innerHTML} ${element.textContent}`)
      .join(" ");

  for (const page of pages) {
    const response = await worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai${page.pathname}`),
      {},
    );
    const html = await response.text();
    const valid = {
      schema_version: 2,
      generated_at: "2026-08-15T12:00:00.000Z",
      complete: true,
      error_count: 0,
      views: page.viewIds.map((id, index) => ({
        id,
        total_count: index + 1,
        title: marker,
        items: [{ url: marker }],
      })),
    };

    const partial = {
      ...valid,
      complete: false,
      error_count: 2,
      diagnostics: { errors: [marker, marker] },
    };
    const partialElements = await renderPublicTriageApplication(html, page.pathname, async () => ({
      ok: true,
      json: async () => partial,
    }));
    assert.notEqual(partialElements.get("view-count")?.textContent, "Not available");
    assert.match(
      String(partialElements.get("snapshot-health")?.textContent),
      /2 collection errors were withheld/,
    );
    assert.doesNotMatch(renderedText(partialElements), new RegExp(marker, "i"));

    const missingView = { ...valid, views: valid.views.slice(0, -1) };
    const duplicateView = {
      ...valid,
      views: [...valid.views.slice(0, -1), { ...valid.views[0] }],
    };
    const unknownView = {
      ...valid,
      views: [
        ...valid.views.slice(0, -1),
        { ...valid.views.at(-1), id: "unexpected-view", title: marker },
      ],
    };
    const overCapCount = {
      ...valid,
      views: valid.views.map((view, index) =>
        index === 0 ? { ...view, total_count: 1_000_001 } : view,
      ),
    };
    const nonIntegerCount = {
      ...valid,
      views: valid.views.map((view, index) => (index === 0 ? { ...view, total_count: 1.5 } : view)),
    };
    const invalidTimestamp = { ...valid, generated_at: marker };
    const numericTimestamp = { ...valid, generated_at: "1171" };
    const urlTimestamp = {
      ...valid,
      generated_at: `https://invalid.example/${marker}?timestamp=1`,
    };
    const overCapErrorCount = { ...valid, error_count: 21, complete: false };
    const completenessMismatch = { ...valid, error_count: 1, complete: true };
    for (const malformed of [
      missingView,
      duplicateView,
      unknownView,
      overCapCount,
      nonIntegerCount,
      invalidTimestamp,
      numericTimestamp,
      urlTimestamp,
      overCapErrorCount,
      completenessMismatch,
    ]) {
      const elements = await renderPublicTriageApplication(html, page.pathname, async () => ({
        ok: true,
        json: async () => malformed,
      }));
      assert.equal(elements.get("view-count")?.textContent, "Not available");
      assert.match(String(elements.get("snapshot-health")?.textContent), /temporarily unavailable/);
      assert.doesNotMatch(renderedText(elements), new RegExp(marker, "i"));
    }

    for (const unavailableFetch of [
      async () => ({ ok: false, json: async () => ({ marker }) }),
      async () => ({
        ok: true,
        json: async () => {
          throw new Error(marker);
        },
      }),
      async () => {
        throw new Error(marker);
      },
    ]) {
      const elements = await renderPublicTriageApplication(html, page.pathname, unavailableFetch);
      assert.equal(elements.get("view-count")?.textContent, "Not available");
      assert.match(String(elements.get("snapshot-health")?.textContent), /temporarily unavailable/);
      assert.doesNotMatch(renderedText(elements), new RegExp(marker, "i"));
    }
  }
});

test("dashboard health identifies the deployed revision", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/health"), {
    CLAWSWEEPER_DEPLOY_SHA: "abc123",
  });

  assert.deepEqual(await response.json(), {
    ok: true,
    service: "clawsweeper-status",
    deployment_sha: "abc123",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("worker health samples a bounded recent run history within its section deadline", () => {
  const sample = recentWorkerHealthRunSample(
    Array.from({ length: 45 }, (_, index) =>
      completedReviewRun(index + 1, 90_000 + index, "success", (index + 1) * 1_000),
    ),
  );
  assert.equal(sample.length, 40);
  assert.deepEqual(
    sample.map((run) => run.id),
    Array.from({ length: 40 }, (_, index) => index + 1),
  );
  assert.equal(workerHealthSectionTimeoutMs(10), 12_000);
  assert.equal(workerHealthSectionTimeoutMs(1), 12_000);
  assert.equal(workerHealthSectionTimeoutMs(40), 12_000);
  assert.equal(workerHealthSectionTimeoutMs(10, 25), 25);
  assert.ok(workerHealthSectionTimeoutMs(10) < 20_000);
  assert.match(
    fs.readFileSync("dashboard/wrangler.toml", "utf8"),
    /WORKER_HEALTH_FETCH_CONCURRENCY\s*=\s*"20"/,
  );
});

test("hosted webhook distinguishes terminal command updates from retrying failures without GitHub reads", async () => {
  const triggerAtMs = Date.now() - 2 * 60 * 60 * 1000;
  const at = (offsetMs = 0) => new Date(triggerAtMs + offsetMs).toISOString();
  const statusStore = new MemoryKv();
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    STATUS_STORE: statusStore,
    hostedPublicTargetProbe: async () => "public" as const,
  };
  const trigger = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 540 },
        installation: { id: 123 },
        comment: {
          id: 456,
          body: "@clawsweeper review",
          author_association: "MEMBER",
          created_at: at(-60_000),
          updated_at: at(),
          user: { login: "brokemac79" },
        },
      },
    }),
    env,
  );
  assert.equal(trigger.status, 503);

  const durableSummary = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 540 },
        comment: {
          id: 789,
          body: [
            `<!-- clawsweeper-verdict:needs-human item=540 sha=abc reviewed_at=${at(4_678_000)} -->`,
          ].join("\n"),
          created_at: at(4_805_000),
          updated_at: at(4_805_000),
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    env,
  );
  assert.equal(durableSummary.status, 202);

  const completion = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 540 },
        comment: {
          id: 790,
          body: [
            "<!-- clawsweeper-command-ack:456 -->",
            "<!-- clawsweeper-command-status:540:re_review:abc -->",
            "<!-- clawsweeper-command-progress:start -->",
            "Re-review progress:",
            "- State: Failed",
            "- Detail: The review artifact was captured, but durable publication ended in a terminal failure.",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: at(3_000),
          updated_at: at(4_820_000),
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    env,
  );
  assert.equal(completion.status, 202);
  assert.deepEqual(await completion.json(), {
    ok: true,
    accepted: false,
    reason: "recorded lifecycle acknowledgement",
  });

  const retryingFailure = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 540 },
        comment: {
          id: 791,
          body: [
            "<!-- clawsweeper-command-ack:456 -->",
            "<!-- clawsweeper-command-status:540:re_review:abc -->",
            "<!-- clawsweeper-command-progress:start -->",
            "Re-review progress:",
            "- State: Failed",
            "- Detail: The exact review did not produce a publishable artifact. The durable queue will retry it.",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: at(3_000),
          updated_at: at(4_821_000),
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    env,
  );
  assert.deepEqual(await retryingFailure.json(), {
    ok: true,
    accepted: true,
    materialized: false,
    event: "issue_comment",
    action: "edited",
  });
});
