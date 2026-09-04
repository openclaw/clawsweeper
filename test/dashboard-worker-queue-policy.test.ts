import {
  assert,
  createHmac,
  generateKeyPairSync,
  fs,
  test,
  worker,
  ExactReviewQueue,
  exactReviewEffectiveLeaseExpiresAt,
  exactReviewJitteredDelayMs,
  exactReviewPublicationCapacity,
  exactReviewPublicationCapacityForState,
  exactReviewQueueAdmittedItems,
  exactReviewQueueCapacity,
  summarizeAutomergeReliability,
  commandAcknowledgementState,
  EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS,
  ExactReviewLifecycleProjectionStore,
  lifecycleState,
  ExactReviewLifecycleTelemetryStore,
  LIVE_ACTIVITY_SOURCE_LIMIT,
  liveActivityBaySnapshot,
  seededRandom,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  jsonResponse,
  buildExactReviewQueueRequest,
  exactReviewPublicationOverrides,
  leasedExactReviewQueueItem,
  leasedExactReviewPublicationItem,
  unclaimedExactReviewQueueItem,
  type ExactReviewQueueItem,
} from "./dashboard-worker-harness.ts";

function credentialRecoveryJitterMs(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return 1_000 + (Math.abs(hash >>> 0) % 29_001);
}

test("exact-review retry jitter stays within every parked recovery ladder band", () => {
  const random = seededRandom(0xc1a05);
  for (const delay of [5, 10, 20].map((minutes) => minutes * 60_000)) {
    for (let sample = 0; sample < 1_000; sample += 1) {
      const jittered = exactReviewJitteredDelayMs(delay, random);
      assert.ok(jittered >= delay * 0.75);
      assert.ok(jittered <= delay * 1.5);
    }
    assert.equal(
      exactReviewJitteredDelayMs(delay, () => 0),
      delay * 0.75,
    );
    assert.equal(
      exactReviewJitteredDelayMs(delay, () => 1),
      delay * 1.5,
    );
  }
});

test("exact-review queue defaults to all 128 global workers", () => {
  assert.equal(exactReviewQueueCapacity({}), 128);
  assert.equal(exactReviewQueueCapacity({ EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "32" }), 32);
  assert.equal(exactReviewQueueCapacity({ EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "100" }), 100);
  assert.equal(
    exactReviewQueueCapacity({
      EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "100",
      EXACT_REVIEW_ACTIONS_BUDGET: "64",
    }),
    64,
  );
});

test("live activity is bounded, redacted, expiring, and separate from lifecycle data", () => {
  const now = 1_770_000_000_000;
  const snapshot = liveActivityBaySnapshot(
    {
      generated_at: new Date(now).toISOString(),
      diagnostics: { errors: [] },
      workers: [
        {
          work_kind: "pr_repair",
          mode: "repair",
          status: "in_progress",
          run_id: "private-run-marker",
          repository: "private-owner/private-project",
          current_step: "private step marker",
        },
        { work_kind: "other", mode: "exact-review", status: "queued" },
      ],
      bay: { active_census_complete: true },
      control_plane: {
        publishers: { running: 1, waiting: 0 },
        comment_routers: { running: 0, waiting: 1 },
        reconcilers: { running: 1, waiting: 0 },
      },
    },
    now,
  );

  assert.equal(snapshot.collection.state, "complete");
  assert.equal(snapshot.activity?.total, 5);
  assert.deepEqual(snapshot.activity?.by_kind, {
    worker: 1,
    repair: 1,
    scheduler: 1,
    publisher: 1,
    reconciliation: 1,
  });
  assert.equal(snapshot.freshness.maximum_age_ms, 60_000);
  assert.equal(Date.parse(snapshot.freshness.expires_at), now + 60_000);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private-run-marker|private-owner|private step marker|current_step/i,
  );
  assert.equal("signals" in (snapshot.activity || {}), false);
  assert.equal("label" in (snapshot.activity || {}), false);
  assert.equal("lanes" in snapshot, false);
  assert.equal("cards" in snapshot, false);

  const fullCapacity = liveActivityBaySnapshot(
    {
      generated_at: new Date(now).toISOString(),
      diagnostics: { errors: [] },
      workers: Array.from({ length: LIVE_ACTIVITY_SOURCE_LIMIT }, () => ({
        work_kind: "other",
        mode: "exact-review",
        status: "in_progress",
      })),
      bay: { active_census_complete: true },
      control_plane: {
        publishers: { running: 0, waiting: 0 },
        comment_routers: { running: 0, waiting: 0 },
        reconcilers: { running: 0, waiting: 0 },
      },
    },
    now,
  );
  assert.equal(fullCapacity.collection.state, "complete");
  assert.equal(fullCapacity.activity?.total, LIVE_ACTIVITY_SOURCE_LIMIT);
  assert.equal(fullCapacity.activity?.by_kind.worker, LIVE_ACTIVITY_SOURCE_LIMIT);
});

test("live activity fails closed for stale, mixed, unavailable, and over-bound sources", () => {
  const now = 1_770_000_000_000;
  const source = {
    generated_at: new Date(now).toISOString(),
    diagnostics: { errors: [] },
    workers: [],
    bay: { active_census_complete: true },
    control_plane: {
      publishers: { running: 0, waiting: 0 },
      comment_routers: { running: 0, waiting: 0 },
      reconcilers: { running: 0, waiting: 0 },
    },
  };
  assert.equal(liveActivityBaySnapshot(source, now + 60_001).collection.state, "unknown");
  for (const generated_at of [
    "1171",
    "Fri, 15 Aug 2026 12:00:00 GMT",
    "https://invalid.example/private?timestamp=1",
    "2100-01-01T00:00:00Z",
  ]) {
    const malformedTimestamp = liveActivityBaySnapshot({ ...source, generated_at }, now);
    assert.deepEqual(malformedTimestamp.collection, { state: "unknown", reason: "malformed" });
    assert.doesNotMatch(JSON.stringify(malformedTimestamp), /invalid\.example|private|1171/);
  }
  assert.equal(
    liveActivityBaySnapshot({ ...source, diagnostics: { errors: ["GitHub unavailable"] } }, now)
      .collection.state,
    "unknown",
  );
  assert.equal(
    liveActivityBaySnapshot(
      { ...source, workers: Array.from({ length: LIVE_ACTIVITY_SOURCE_LIMIT + 1 }, () => ({})) },
      now,
    ).collection.state,
    "unknown",
  );
  assert.equal(
    liveActivityBaySnapshot(
      {
        ...source,
        control_plane: { ...source.control_plane, reconcilers: { running: -1, waiting: 0 } },
      },
      now,
    ).collection.state,
    "unknown",
  );
  assert.equal(
    liveActivityBaySnapshot({ ...source, bay: { active_census_complete: false } }, now).collection
      .state,
    "unknown",
  );
  assert.equal(
    liveActivityBaySnapshot(
      {
        ...source,
        workers: Array.from({ length: LIVE_ACTIVITY_SOURCE_LIMIT }, () => ({
          work_kind: "other",
          mode: "exact-review",
          status: "in_progress",
        })),
        bay: { active_census_complete: false },
      },
      now,
    ).collection.state,
    "unknown",
  );
  assert.equal(
    liveActivityBaySnapshot(
      {
        ...source,
        workers: [
          {
            work_kind: { nested_private_marker: "must-not-surface" },
            mode: "exact-review",
            status: "in_progress",
          },
        ],
      },
      now,
    ).collection.state,
    "unknown",
  );
  assert.equal(
    liveActivityBaySnapshot(
      {
        ...source,
        control_plane: {
          ...source.control_plane,
          publishers: { running: LIVE_ACTIVITY_SOURCE_LIMIT + 1, waiting: 0 },
        },
      },
      now,
    ).collection.state,
    "unknown",
  );
  assert.doesNotMatch(
    JSON.stringify(
      liveActivityBaySnapshot(
        {
          ...source,
          workers: [
            {
              work_kind: { nested_private_marker: "must-not-surface" },
              mode: "exact-review",
              status: "in_progress",
            },
          ],
        },
        now,
      ),
    ),
    /nested_private_marker|must-not-surface/,
  );
});

test("production doubles exact review claims and canonical publication batches", () => {
  const wrangler = fs.readFileSync("dashboard/wrangler.toml", "utf8");
  assert.match(wrangler, /CLAWSWEEPER_ENABLE_CLAWHUB = "1"/);
  assert.match(wrangler, /EXACT_REVIEW_QUEUE_MAX_CONCURRENT = "128"/);
  assert.match(wrangler, /EXACT_REVIEW_TARGET_MAX_CONCURRENT = "120"/);
  assert.match(wrangler, /EXACT_REVIEW_ACTIONS_BUDGET = "194"/);
  assert.match(wrangler, /EXACT_REVIEW_PUBLICATION_BATCH_SIZE = "8"/);
  assert.match(wrangler, /EXACT_REVIEW_PUBLICATION_BATCH_MAX_CONCURRENT = "8"/);
  assert.match(wrangler, /EXACT_REVIEW_PUBLICATION_BATCH_DISPATCH_COOLDOWN_MS = "5000"/);
  assert.match(wrangler, /EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT = "8"/);
  assert.match(wrangler, /EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT = "32"/);
  assert.match(wrangler, /EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT = "40"/);
  assert.match(wrangler, /EXACT_REVIEW_TARGET_RATE_PER_HOUR = "300"/);
  assert.match(wrangler, /EXACT_REVIEW_TARGET_BURST = "30"/);
  assert.match(wrangler, /EXACT_REVIEW_PENDING_SOFT_LIMIT = "600"/);
  assert.match(wrangler, /EXACT_REVIEW_LIFECYCLE_BAY_CACHE_MS = "30000"/);
});

test("exact-review lifecycle projection keeps immutable per-revision facts and terminal distinctions", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const canonicalTargetKey = "openclaw/openclaw#777";
  const base = {
    canonicalTargetKey,
    fenceKey: "openclaw/openclaw#777@exact:4",
    revision: 4,
  };
  const admit = (revision: number, fenceKey = base.fenceKey) =>
    lifecycle.recordAdmission({
      canonicalTargetKey,
      fenceKey,
      revision,
      deliveryId: `delivery:${revision}`,
      sourceAction: "re_review",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      observedAt: 1_700_000_000_000 + revision,
    });

  admit(base.revision);
  lifecycle.recordClaim({
    ...base,
    claimGeneration: 2,
    runId: "7770",
    runAttempt: 1,
    observedAt: 1_700_000_000_010,
  });
  lifecycle.recordReviewResult({
    ...base,
    claimGeneration: 2,
    runId: "7770",
    runAttempt: 1,
    outcome: "completed",
    observedAt: 1_700_000_000_020,
  });
  lifecycle.recordGithubEffect({
    ...base,
    commentId: 9001,
    digest: "a".repeat(64),
    observedAt: 1_700_000_000_030,
  });
  lifecycle.recordCanonicalReceipt({
    ...base,
    outcome: "accepted",
    receiptId: "canonical:4:accepted",
    observedAt: 1_700_000_000_040,
  });
  lifecycle.recordCanonicalReceipt({
    ...base,
    outcome: "deduped",
    receiptId: "canonical:4:deduped",
    observedAt: 1_700_000_000_041,
  });
  lifecycle.recordRouterReceipt({
    ...base,
    outcome: "durable",
    receiptId: "router:7770:1",
    observedAt: 1_700_000_000_050,
  });
  const completed = lifecycle.recordTerminalDisposition({
    ...base,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_060,
  });
  assert.equal(lifecycleState(completed), "completed");
  assert.deepEqual(completed.claims, [
    {
      fenceKey: base.fenceKey,
      claimGeneration: 2,
      runId: "7770",
      runAttempt: 1,
      claimedAt: 1_700_000_000_010,
    },
  ]);
  assert.deepEqual(
    completed.reviewResults.map(({ outcome, observedAt, ...claim }) => ({
      claim,
      outcome,
      observedAt,
    })),
    [
      {
        claim: {
          fenceKey: base.fenceKey,
          claimGeneration: 2,
          runId: "7770",
          runAttempt: 1,
        },
        outcome: "completed",
        observedAt: 1_700_000_000_020,
      },
    ],
  );
  assert.equal(completed.githubEffect?.commentId, 9001);
  assert.equal(completed.canonicalReceipts.length, 2);
  assert.equal(completed.routerReceipt?.receiptId, "router:7770:1");
  assert.throws(
    () =>
      lifecycle.recordAdmission({
        ...base,
        deliveryId: "different-delivery",
        sourceAction: "re_review",
        commandOriginated: false,
        statusMarker: null,
        statusCommentId: null,
        observedAt: 1_700_000_000_070,
      }),
    /conflicting lifecycle admission fact/,
  );
  const siblingPublisher = { ...base, fenceKey: "openclaw/openclaw#777@exact:sibling" };
  lifecycle.recordAdmission({
    ...siblingPublisher,
    deliveryId: "sibling-delivery:4",
    sourceAction: "re_review",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    observedAt: 1_700_000_000_071,
  });
  lifecycle.recordClaim({
    ...siblingPublisher,
    claimGeneration: 1,
    runId: "7771",
    runAttempt: 1,
    observedAt: 1_700_000_000_072,
  });
  assert.equal(
    lifecycle.read(canonicalTargetKey, base.fenceKey, base.revision)?.claims[0]?.runId,
    "7770",
  );
  assert.equal(
    lifecycle.read(canonicalTargetKey, siblingPublisher.fenceKey, siblingPublisher.revision)
      ?.claims[0]?.runId,
    "7771",
  );

  const command = {
    canonicalTargetKey,
    fenceKey: "openclaw/openclaw#777@exact:5",
    revision: 5,
  };
  lifecycle.recordAdmission({
    ...command,
    deliveryId: "command-delivery:5",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: "<!-- clawsweeper-command-status:777:re_review:token -->",
    statusCommentId: 9003,
    observedAt: 1_700_000_000_080,
  });
  lifecycle.recordGithubEffect({
    ...command,
    commentId: 9002,
    digest: "b".repeat(64),
    observedAt: 1_700_000_000_081,
  });
  lifecycle.recordCanonicalReceipt({
    ...command,
    outcome: "accepted",
    receiptId: "canonical:5:accepted",
    observedAt: 1_700_000_000_082,
  });
  lifecycle.recordRouterReceipt({
    ...command,
    outcome: "durable",
    receiptId: "router:7771:1",
    observedAt: 1_700_000_000_083,
  });
  lifecycle.recordTerminalDisposition({
    ...command,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_084,
  });
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, command.fenceKey, 5)!),
    "acknowledgement_pending",
  );
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...command,
      statusMarker: "<!-- clawsweeper-command-status:777:re_review:token -->",
      statusCommentId: 9003,
      observedAt: 1_700_000_000_085,
    }).allowed,
    true,
  );
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...command,
      statusMarker: "<!-- clawsweeper-command-status:777:re_review:token -->",
      statusCommentId: 9003,
      observedAt: 1_700_000_000_086,
    }).allowed,
    false,
  );
  assert.equal(
    lifecycle.read(canonicalTargetKey, command.fenceKey, 5)?.acknowledgement.attempts.length,
    1,
  );
  assert.equal(
    lifecycle.recordCommandAcknowledgementFailure({
      ...command,
      attemptId: "ack:1",
      statusMarker: "<!-- clawsweeper-command-status:777:re_review:token -->",
      statusCommentId: 9003,
      observedAt: 1_700_000_000_086,
    }).released,
    true,
  );
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...command,
      statusMarker: "<!-- clawsweeper-command-status:777:re_review:token -->",
      statusCommentId: 9003,
      observedAt: 1_700_000_000_086,
    }).allowed,
    true,
  );
  assert.equal(
    lifecycle.recordCommandAcknowledgementFailure({
      ...command,
      attemptId: "ack:1",
      statusMarker: "<!-- clawsweeper-command-status:777:re_review:token -->",
      statusCommentId: 9003,
      observedAt: 1_700_000_000_087,
    }).released,
    false,
  );
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...command,
      statusMarker: "<!-- clawsweeper-command-status:777:re_review:token -->",
      statusCommentId: 123,
      observedAt: 1_700_000_000_087,
    }).allowed,
    false,
  );
  assert.equal(
    lifecycle.observeCommandAcknowledgement({
      canonicalTargetKey,
      statusMarker: "<!-- clawsweeper-command-status:777:re_review:token -->",
      commandCommentId: 123,
      completionCommentId: 9003,
      observedAt: 1_700_000_000_087,
    }).accepted,
    true,
  );
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, command.fenceKey, 5)!),
    "completed",
  );
  assert.equal(
    lifecycle.read(canonicalTargetKey, command.fenceKey, 5)?.acknowledgement.attempts.length,
    2,
  );

  const deferredCommand = {
    canonicalTargetKey,
    fenceKey: "openclaw/openclaw#777@exact:deferred",
    revision: 7,
  };
  lifecycle.recordAdmission({
    ...deferredCommand,
    deliveryId: "command-delivery:7",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: "<!-- clawsweeper-command-status:777:re_review:deferred -->",
    statusCommentId: 9005,
    observedAt: 1_700_000_000_088,
  });
  lifecycle.recordCanonicalReceipt({
    ...deferredCommand,
    outcome: "accepted",
    receiptId: "canonical:7:accepted",
    observedAt: 1_700_000_000_089,
  });
  lifecycle.recordRouterReceipt({
    ...deferredCommand,
    outcome: "durable",
    receiptId: "router-proof:7774:1",
    observedAt: 1_700_000_000_090,
  });
  lifecycle.recordTerminalDisposition({
    ...deferredCommand,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_091,
  });
  assert.equal(lifecycle.read(canonicalTargetKey, deferredCommand.fenceKey, 7)?.githubEffect, null);
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, deferredCommand.fenceKey, 7)!),
    "acknowledgement_pending",
  );
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...deferredCommand,
      statusMarker: "<!-- clawsweeper-command-status:777:re_review:deferred -->",
      statusCommentId: 9005,
      observedAt: 1_700_000_000_092,
    }).allowed,
    true,
  );

  const statusIdOnlyCommand = {
    canonicalTargetKey,
    fenceKey: "openclaw/openclaw#777@exact:status-id-only",
    revision: 8,
  };
  lifecycle.recordAdmission({
    ...statusIdOnlyCommand,
    deliveryId: "command-delivery:8",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: null,
    statusCommentId: 9006,
    observedAt: 1_700_000_000_093,
  });
  lifecycle.recordCanonicalReceipt({
    ...statusIdOnlyCommand,
    outcome: "accepted",
    receiptId: "canonical:8:accepted",
    observedAt: 1_700_000_000_094,
  });
  lifecycle.recordRouterReceipt({
    ...statusIdOnlyCommand,
    outcome: "durable",
    receiptId: "router:7774:1",
    observedAt: 1_700_000_000_095,
  });
  lifecycle.recordTerminalDisposition({
    ...statusIdOnlyCommand,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_096,
  });
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...statusIdOnlyCommand,
      statusMarker: null,
      statusCommentId: 9006,
      observedAt: 1_700_000_000_097,
    }).allowed,
    true,
  );
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...statusIdOnlyCommand,
      statusMarker: null,
      statusCommentId: 9006,
      observedAt: 1_700_000_000_097 + EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS - 1,
    }).allowed,
    false,
  );
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...statusIdOnlyCommand,
      statusMarker: null,
      statusCommentId: 9006,
      observedAt: 1_700_000_000_097 + EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS,
    }).allowed,
    true,
  );
  assert.equal(
    lifecycle.read(canonicalTargetKey, statusIdOnlyCommand.fenceKey, 8)?.acknowledgement.attempts[0]
      ?.expiredAt,
    1_700_000_000_097 + EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS,
  );
  assert.equal(
    lifecycle.observeCommandAcknowledgement({
      canonicalTargetKey,
      statusMarker: null,
      commandCommentId: 123,
      completionCommentId: 9006,
      observedAt: 1_700_000_000_098 + EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS,
    }).accepted,
    true,
  );
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, statusIdOnlyCommand.fenceKey, 8)!),
    "completed",
  );

  const requeuedCommand = {
    canonicalTargetKey,
    fenceKey: "openclaw/openclaw#777@exact:6",
    revision: 6,
  };
  lifecycle.recordAdmission({
    ...requeuedCommand,
    deliveryId: "command-delivery:6",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: "<!-- clawsweeper-command-status:777:re_review:requeue -->",
    statusCommentId: 124,
    observedAt: 1_700_000_000_088,
  });
  const requeued = lifecycle.recordTerminalDisposition({
    ...requeuedCommand,
    kind: "requeue",
    observedAt: 1_700_000_000_089,
  });
  assert.equal(lifecycleState(requeued), "requeue");
  assert.equal(commandAcknowledgementState(requeued), "unavailable");
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...requeuedCommand,
      statusMarker: "<!-- clawsweeper-command-status:777:re_review:requeue -->",
      statusCommentId: 124,
      observedAt: 1_700_000_000_090,
    }).allowed,
    false,
  );
  lifecycle.recordGithubEffect({
    ...requeuedCommand,
    commentId: 9004,
    digest: "c".repeat(64),
    observedAt: 1_700_000_000_091,
  });
  lifecycle.recordCanonicalReceipt({
    ...requeuedCommand,
    outcome: "deduped",
    receiptId: "canonical:6:deduped",
    observedAt: 1_700_000_000_092,
  });
  lifecycle.recordRouterReceipt({
    ...requeuedCommand,
    outcome: "durable",
    receiptId: "router:7772:1",
    observedAt: 1_700_000_000_093,
  });
  lifecycle.recordRouterReceipt({
    ...requeuedCommand,
    outcome: "durable",
    receiptId: "router:7773:1",
    observedAt: 1_700_000_000_094,
  });
  const rerouted = lifecycle.recordTerminalDisposition({
    ...requeuedCommand,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_095,
  });
  assert.equal(lifecycleState(rerouted), "acknowledgement_pending");
  assert.deepEqual(
    rerouted.routerReceipts.map((receipt) => receipt.receiptId),
    ["router:7772:1", "router:7773:1"],
  );
  assert.deepEqual(
    rerouted.terminalDispositions.map((disposition) => disposition.kind),
    ["requeue", "review_completed_routed"],
  );
  const sourceUpdated = lifecycle.recordTerminalDisposition({
    ...requeuedCommand,
    kind: "requeue",
    observedAt: 1_700_000_000_096,
  });
  assert.equal(lifecycleState(sourceUpdated), "requeue");
  const completedAfterSourceUpdate = lifecycle.recordTerminalDisposition({
    ...requeuedCommand,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_097,
  });
  assert.equal(lifecycleState(completedAfterSourceUpdate), "acknowledgement_pending");
  assert.deepEqual(
    completedAfterSourceUpdate.terminalDispositions.map((disposition) => disposition.kind),
    ["requeue", "review_completed_routed", "requeue", "review_completed_routed"],
  );

  const terminalCases = [
    ["superseded", "superseded"],
    ["requeue", "requeue"],
    ["dead_letter", "dead_letter"],
    ["target_closed", "target_closed"],
    ["target_missing", "target_missing"],
    ["failure", "failed"],
  ] as const;
  for (const [index, [terminal, state]] of terminalCases.entries()) {
    const revision = 10 + index;
    admit(revision, `openclaw/openclaw#777@exact:${revision}`);
    const projection = lifecycle.recordTerminalDisposition({
      canonicalTargetKey,
      fenceKey: `openclaw/openclaw#777@exact:${revision}`,
      revision,
      kind: terminal,
      observedAt: 1_700_000_000_100 + revision,
    });
    assert.equal(lifecycleState(projection), state);
  }
});

test("lifecycle telemetry counts durable terminal coverage without treating acknowledgement pending as completed", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  lifecycle.ensureSchemaSync();
  telemetry.ensureSchemaSync();
  const admittedAt = 1_700_000_000_000;
  const add = ({
    number,
    revision = 1,
    fenceKey = `openclaw/openclaw#${number}@exact:${revision}`,
    commandOriginated = false,
    terminal,
    receipt,
  }: {
    number: number;
    revision?: number;
    fenceKey?: string;
    commandOriginated?: boolean;
    terminal?: Parameters<
      ExactReviewLifecycleProjectionStore["recordTerminalDisposition"]
    >[0]["kind"];
    receipt?: "accepted" | "deduped" | "superseded";
  }) => {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${number}`,
      fenceKey,
      revision,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `telemetry:${number}:${revision}`,
      sourceAction: "re_review",
      commandOriginated,
      statusMarker: commandOriginated
        ? `<!-- clawsweeper-command-status:${number}:token -->`
        : null,
      statusCommentId: commandOriginated ? number : null,
      observedAt: admittedAt + number,
    });
    lifecycle.recordClaim({
      ...identity,
      claimGeneration: 1,
      runId: String(number),
      runAttempt: 1,
      observedAt: admittedAt + number + 1,
    });
    if (receipt) {
      lifecycle.recordCanonicalReceipt({
        ...identity,
        outcome: receipt,
        receiptId: `telemetry:${number}:${receipt}`,
        observedAt: admittedAt + number + 2,
      });
    }
    if (terminal) {
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: terminal,
        observedAt: admittedAt + number + 3,
      });
    }
    return identity;
  };

  const acknowledgementPending = add({
    number: 810,
    commandOriginated: true,
    receipt: "accepted",
    terminal: "review_completed_routed",
  });
  lifecycle.recordRouterReceipt({
    ...acknowledgementPending,
    outcome: "durable",
    receiptId: "telemetry:810:router",
    observedAt: admittedAt + 815,
  });
  lifecycle.recordClaim({
    ...acknowledgementPending,
    claimGeneration: 2,
    runId: "810",
    runAttempt: 2,
    observedAt: admittedAt + 816,
  });
  telemetry.recordDirectOutcome({
    ...acknowledgementPending,
    claimGeneration: 1,
    outcome: "accepted",
    observedAt: admittedAt + 817,
  });

  add({ number: 811 }); // Unresolved durable lifecycle fact, not a workflow-success proxy.
  const supersededDirect = add({ number: 812, revision: 1, terminal: "superseded" });
  add({ number: 812, revision: 2 });
  telemetry.recordDirectOutcome({
    ...supersededDirect,
    claimGeneration: 1,
    outcome: "superseded",
    observedAt: admittedAt + 818,
  });
  telemetry.recordDirectOutcome({
    ...acknowledgementPending,
    claimGeneration: 1,
    outcome: "fallback",
    observedAt: admittedAt - 7 * 24 * 60 * 60 * 1_000 - 1,
  });
  add({
    number: 813,
    fenceKey: "openclaw/openclaw#813@publish:1",
    receipt: "accepted",
    terminal: "review_completed_routed",
  });
  add({
    number: 814,
    fenceKey: "openclaw/openclaw#814@publish:1",
    receipt: "deduped",
    terminal: "review_completed_routed",
  });
  add({
    number: 815,
    fenceKey: "openclaw/openclaw#815@publish:1",
    receipt: "superseded",
    terminal: "superseded",
  });
  const retryable = add({ number: 816, fenceKey: "openclaw/openclaw#816@publish:1" });
  const permanent = add({ number: 817, fenceKey: "openclaw/openclaw#817@publish:1" });
  telemetry.recordBatchOutcome({
    batchId: "batch-816",
    ...retryable,
    claimGeneration: 1,
    outcome: "retryable",
    observedAt: admittedAt + 900,
  });
  telemetry.recordBatchOutcome({
    batchId: "batch-817",
    ...permanent,
    claimGeneration: 1,
    outcome: "permanent",
    observedAt: admittedAt + 901,
  });
  telemetry.recordBatchOutcome({
    batchId: "expired-batch-816",
    ...retryable,
    claimGeneration: 1,
    outcome: "retryable",
    observedAt: admittedAt - 7 * 24 * 60 * 60 * 1_000 - 1,
  });
  const expiredBatchReceipt = add({
    number: 818,
    fenceKey: "openclaw/openclaw#818@publish:1",
  });
  lifecycle.recordCanonicalReceipt({
    ...expiredBatchReceipt,
    outcome: "accepted",
    receiptId: "expired-batch-receipt-818",
    observedAt: admittedAt - 7 * 24 * 60 * 60 * 1_000 - 1,
  });

  const summary = telemetry.summary(admittedAt + 10_000);
  assert.equal(summary.terminalCoverage.acknowledgementPendingRecords, 1);
  assert.equal(summary.terminalCoverage.unknownTerminalRecords, 5);
  assert.equal(summary.terminalCoverage.nonCurrentRecords, 2);
  assert.equal(summary.terminalCoverage.terminalClasses.review_completed_routed, 3);
  assert.equal(summary.terminalCoverage.terminalClasses.superseded, 2);
  assert.equal(summary.publication.direct.accepted, 1);
  assert.equal(summary.publication.direct.superseded, 1);
  assert.equal(summary.publication.direct.fallback, 0);
  assert.equal(summary.publication.direct.unknown, 2);
  assert.deepEqual(summary.publication.batch, {
    accepted: 1,
    deduped: 1,
    superseded: 1,
    retryable: 1,
    permanent: 1,
  });
  assert.equal(summary.publication.lifecycleRetries, 1);
  assert.equal(summary.publication.lastSuccessfulCanonicalAcceptanceAt, admittedAt + 816);
  assert.equal(JSON.stringify(summary).includes("openclaw/openclaw"), false);
});

test("full review admission does not inflate staged publication capacity", () => {
  const state = {
    items: Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => {
        const item = leasedExactReviewQueueItem(120_000 + index, String(120_000 + index));
        return [item.key, item];
      }),
    ),
  };
  assert.equal(
    exactReviewPublicationCapacityForState(
      {
        EXACT_REVIEW_ACTIONS_BUDGET: "194",
        EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT: "8",
        EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT: "32",
        EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "40",
      },
      state,
      Date.now(),
    ),
    32,
  );
});

test("exact-review source authority sequence survives queue restarts", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const reserve = (
    target: ExactReviewQueue,
    deliveryId: string,
    decisionOverrides: Record<string, unknown> = {},
  ) =>
    target.fetch(
      new Request("https://clawsweeper-exact-review-queue/source-authority", {
        method: "POST",
        body: JSON.stringify({
          delivery_id: deliveryId,
          installation_id: 123,
          decision: {
            targetRepo: "openclaw/openclaw",
            targetBranch: "main",
            itemNumber: 749,
            itemKind: "pull_request",
            sourceEvent: "pull_request",
            sourceAction: "synchronize",
            supersedesInProgress: true,
            sourceHeadSha: "a".repeat(40),
            sourceUpdatedAt: "2026-07-23T13:00:02Z",
            ...decisionOverrides,
          },
        }),
      }),
    );

  assert.deepEqual(await (await reserve(queue, "authority-delivery-1")).json(), {
    ok: true,
    source_authority_seq: 1,
  });
  assert.deepEqual(await (await reserve(queue, "authority-delivery-1")).json(), {
    ok: true,
    source_authority_seq: 1,
  });
  // A reservation made before semantic edited-event fields were deployed must
  // remain idempotent when the original delivery is redelivered afterwards.
  assert.deepEqual(
    await (
      await reserve(queue, "authority-delivery-1", {
        sourceBaseSha: "b".repeat(40),
        sourceIsDraft: false,
        sourceContentRevision: "c".repeat(64),
      })
    ).json(),
    {
      ok: true,
      source_authority_seq: 1,
    },
  );
  assert.deepEqual(await (await reserve(queue, "authority-delivery-2")).json(), {
    ok: true,
    source_authority_seq: 2,
  });

  const restarted = new ExactReviewQueue({ storage }, {});
  assert.deepEqual(await (await reserve(restarted, "authority-delivery-3")).json(), {
    ok: true,
    source_authority_seq: 3,
  });
});

test("branch authority shares the target App circuit and collapses same-owner retries", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 4_000_000;
  const resetAt = now + 90_000;
  Date.now = () => now;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const queue = new ExactReviewQueue(
    { storage },
    {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
  );
  let openclawInstallationTokens = 0;
  let openclawRepositoryReads = 0;
  let openclawPullReads = 0;
  let otherRepositoryReads = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations/123/access_tokens") {
      openclawInstallationTokens += 1;
      return jsonResponse({ token: "openclaw-token" });
    }
    if (url.pathname === "/app/installations/456/access_tokens") {
      return jsonResponse({ token: "other-token" });
    }
    if (url.pathname === "/repos/openclaw/openclaw") {
      openclawRepositoryReads += 1;
      if (openclawRepositoryReads === 1) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetAt / 1_000),
          },
        });
      }
      return jsonResponse({ default_branch: "trunk" });
    }
    if (url.pathname === "/repos/openclaw/openclaw/pulls/903") {
      openclawPullReads += 1;
      return jsonResponse({ head: { sha: "d".repeat(40) } });
    }
    if (url.pathname === "/repos/other/repo") {
      otherRepositoryReads += 1;
      return jsonResponse({ default_branch: "stable" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const branchReservation = (
    deliveryId: string,
    targetRepo: string,
    itemNumber: number,
    installationId: number,
  ) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/branch-authority", {
        method: "POST",
        body: JSON.stringify({
          delivery_id: deliveryId,
          installation_id: installationId,
          decision: {
            targetRepo,
            itemNumber,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction: "legacy_dispatch",
            supersedesInProgress: false,
          },
        }),
      }),
    );

  try {
    for (const [deliveryId, targetRepo, itemNumber, installationId] of [
      ["a-openclaw", "openclaw/openclaw", 900, 123],
      ["b-openclaw", "openclaw/openclaw", 901, 123],
      ["c-other", "other/repo", 902, 456],
    ] as const) {
      const response = await branchReservation(deliveryId, targetRepo, itemNumber, installationId);
      assert.equal(response.status, 202);
    }
    const sourceResponse = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/source-authority", {
        method: "POST",
        body: JSON.stringify({
          delivery_id: "d-source-openclaw",
          installation_id: 123,
          decision: {
            targetRepo: "openclaw/openclaw",
            targetBranch: "trunk",
            itemNumber: 903,
            itemKind: "pull_request",
            sourceEvent: "pull_request",
            sourceAction: "synchronize",
            supersedesInProgress: true,
            sourceHeadSha: "d".repeat(40),
          },
        }),
      }),
    );
    assert.equal(sourceResponse.status, 200);

    await queue.alarm();

    assert.equal(openclawInstallationTokens, 1);
    assert.equal(openclawRepositoryReads, 1);
    assert.equal(openclawPullReads, 0);
    assert.equal(otherRepositoryReads, 1);
    assert.deepEqual(
      {
        first: storage.rawGet("exact-review-branch-authority-reservation:v1:a-openclaw"),
        second: storage.rawGet("exact-review-branch-authority-reservation:v1:b-openclaw"),
        source: storage.rawGet("exact-review-source-authority-reservation:v1:d-source-openclaw"),
      },
      {
        first: {
          deliveryId: "a-openclaw",
          decision: {
            targetRepo: "openclaw/openclaw",
            itemNumber: 900,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction: "legacy_dispatch",
            supersedesInProgress: false,
          },
          installationId: 123,
          sourceAuthorityRequired: false,
          attempts: 1,
          nextAttemptAt: resetAt + credentialRecoveryJitterMs("a-openclaw"),
        },
        second: {
          deliveryId: "b-openclaw",
          decision: {
            targetRepo: "openclaw/openclaw",
            itemNumber: 901,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction: "legacy_dispatch",
            supersedesInProgress: false,
          },
          installationId: 123,
          sourceAuthorityRequired: false,
          attempts: 0,
          nextAttemptAt: resetAt + credentialRecoveryJitterMs("b-openclaw"),
        },
        source: {
          deliveryId: "d-source-openclaw",
          decision: {
            targetRepo: "openclaw/openclaw",
            targetBranch: "trunk",
            itemNumber: 903,
            itemKind: "pull_request",
            sourceEvent: "pull_request",
            sourceAction: "synchronize",
            supersedesInProgress: true,
            sourceHeadSha: "d".repeat(40),
            sourceAuthoritySeq: 1,
          },
          installationId: 123,
          sourceAuthoritySeq: 1,
          attempts: 0,
          nextAttemptAt: resetAt + credentialRecoveryJitterMs("d-source-openclaw"),
        },
      },
    );
    const throttled = (await storage.get("exact-review-queue")) as {
      dispatcher: {
        githubCredentialCircuits: Record<
          string,
          { retryAt: number; provenance: string; authoritative: boolean }
        >;
        githubRequestMetrics: { counters: Record<string, number> };
      };
      items: Record<string, { decision: { targetBranch: string } }>;
    };
    assert.deepEqual(throttled.dispatcher.githubCredentialCircuits["target_app:openclaw"], {
      scope: "target_app",
      targetOwner: "openclaw",
      observedAt: now,
      retryAt: resetAt,
      provenance: "rate_limit_reset",
      authoritative: true,
      poolKey: "target_app:openclaw",
    });
    assert.equal(
      throttled.dispatcher.githubRequestMetrics.counters[
        "target_app:item_metadata:read:skipped_by_circuit:first"
      ],
      2,
    );
    assert.equal(throttled.items["other/repo#902"].decision.targetBranch, "stable");
    const stats = (await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json()) as {
      lanes: {
        review: { authority_pending: Record<string, number> };
        publication: {
          credential_circuits: Array<{
            pool: string;
            affected_pending: number;
            active: boolean;
            recovery_until: string;
          }>;
        };
      };
    };
    assert.deepEqual(stats.lanes.review.authority_pending, {
      total: 3,
      branch_resolution: 2,
      source_verification: 1,
    });
    const openclawCircuit = stats.lanes.publication.credential_circuits.find(
      (circuit) => circuit.pool === "target_app:openclaw",
    );
    const authorityRecoveryAt = Math.max(
      ...["a-openclaw", "b-openclaw", "d-source-openclaw"].map(
        (deliveryId) => resetAt + credentialRecoveryJitterMs(deliveryId),
      ),
    );
    assert.equal(openclawCircuit?.affected_pending, 3);
    assert.equal(openclawCircuit?.active, true);
    assert.equal(openclawCircuit?.recovery_until, new Date(authorityRecoveryAt).toISOString());

    now = resetAt;
    const resetStats = (await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json()) as {
      lanes: { publication: { credential_circuits: Array<{ pool: string; active: boolean }> } };
    };
    assert.equal(
      resetStats.lanes.publication.credential_circuits.find(
        (circuit) => circuit.pool === "target_app:openclaw",
      )?.active,
      true,
    );

    now = resetAt + 30_001;
    await queue.alarm();
    const recovered = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { targetBranch: string } }>;
    };
    assert.equal(recovered.items["openclaw/openclaw#900"].decision.targetBranch, "trunk");
    assert.equal(recovered.items["openclaw/openclaw#901"].decision.targetBranch, "trunk");
    assert.equal(recovered.items["openclaw/openclaw#903"].decision.targetBranch, "trunk");
    assert.equal(openclawRepositoryReads, 3);
    assert.equal(openclawPullReads, 1);
    assert.equal(storage.rawHas("exact-review-branch-authority-reservation:v1:a-openclaw"), false);
    assert.equal(storage.rawHas("exact-review-branch-authority-reservation:v1:b-openclaw"), false);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("exact-review queue durably coalesces concurrent unchanged pull request edits", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const targetRepo = "Steipete/Nameplate";
  const request = (deliveryId: string, sourceAuthoritySeq: number, repo = targetRepo) =>
    buildExactReviewQueueRequest(deliveryId, 750, "edited", "pull_request", repo, {
      sourceHeadSha: "a".repeat(40),
      sourceBaseSha: "b".repeat(40),
      sourceIsDraft: false,
      sourceContentRevision: "c".repeat(64),
      sourceHeadVerified: true,
      sourceAuthoritySeq,
      sourceUpdatedAt: "2026-07-25T09:00:00Z",
    });

  const [first, duplicate] = await Promise.all([
    queue.fetch(request("semantic-edit-1", 1)),
    queue.fetch(request("semantic-edit-2", 2, targetRepo.toLowerCase())),
  ]);
  const responses = await Promise.all([first.json(), duplicate.json()]);
  assert.equal(responses.filter((response) => response.queued === true).length, 1);
  const deduped = responses.find((response) => response.deduped === true);
  assert.deepEqual(
    { ...deduped, item_key: String(deduped?.item_key).toLowerCase() },
    {
      ok: true,
      deduped: true,
      item_key: "steipete/nameplate#750",
      dedupe_scope: "semantic_edited",
      dedupe_reason: "unchanged_pull_request_edit",
    },
  );

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        revision: number;
        decision: { sourceAuthoritySeq?: number };
        sourceAuthorityWatermark?: { sequence: number; updatedAt?: string };
      }
    >;
  };
  // Either concurrent delivery may win the enqueue race; the stored item keeps
  // the winner's repo casing (seq 1 sent "Steipete/Nameplate", seq 2 lowercase)
  // while the loser dedupes case-insensitively and the watermark ends at the
  // maximum sequence in both orders.
  const queued = responses.find((response) => response.queued === true);
  const storedKeys = Object.keys(state.items).filter(
    (key) => key.toLowerCase() === "steipete/nameplate#750",
  );
  assert.deepEqual(storedKeys, [queued?.item_key]);
  const item = state.items[storedKeys[0]];
  const winnerAuthoritySeq = storedKeys[0] === "Steipete/Nameplate#750" ? 1 : 2;
  assert.equal(item.revision, 1);
  assert.equal(item.decision.sourceAuthoritySeq, winnerAuthoritySeq);
  assert.deepEqual(item.sourceAuthorityWatermark, {
    sequence: 2,
    updatedAt: "2026-07-25T09:00:00Z",
  });
  const stats = await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  assert.equal((await stats.json()).lanes.review.semantic_deduped_total, 1);
});

test("semantic edit suppression advances the pull request authority watermark", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const request = (
    deliveryId: string,
    sourceAuthoritySeq: number,
    sourceUpdatedAt: string,
    overrides: Record<string, unknown> = {},
  ) =>
    buildExactReviewQueueRequest(deliveryId, 752, "edited", "pull_request", "openclaw/openclaw", {
      sourceHeadSha: "a".repeat(40),
      sourceBaseSha: "b".repeat(40),
      sourceIsDraft: false,
      sourceContentRevision: "c".repeat(64),
      sourceHeadVerified: true,
      sourceAuthoritySeq,
      sourceUpdatedAt,
      ...overrides,
    });

  assert.equal(
    (await queue.fetch(request("watermark-original", 1, "2026-07-25T09:00:01Z"))).status,
    202,
  );
  // An older compatible producer that lacks a content digest still queues
  // normally. Its authority tuple must not allow a delayed revision to win
  // after a newer duplicate of the original semantic edit is suppressed.
  assert.equal(
    (
      await queue.fetch(
        request("watermark-undigested", 2, "2026-07-25T09:00:02Z", {
          sourceContentRevision: undefined,
        }),
      )
    ).status,
    202,
  );
  const duplicate = await queue.fetch(request("watermark-duplicate", 3, "2026-07-25T09:00:03Z"));
  assert.equal((await duplicate.json()).dedupe_scope, "semantic_edited");

  const delayed = await queue.fetch(
    request("watermark-delayed", 4, "2026-07-25T09:00:02Z", {
      sourceContentRevision: "d".repeat(64),
    }),
  );
  assert.deepEqual(await delayed.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/openclaw#752",
    stale_source: true,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { revision: number; sourceAuthorityWatermark?: { sequence: number; updatedAt?: string } }
    >;
  };
  assert.equal(state.items["openclaw/openclaw#752"].revision, 2);
  assert.deepEqual(state.items["openclaw/openclaw#752"].sourceAuthorityWatermark, {
    sequence: 3,
    updatedAt: "2026-07-25T09:00:03Z",
  });
});

test("exact-review queue retains edits with a changed review tuple", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const headSha = "a".repeat(40);
  const baseSha = "b".repeat(40);
  const request = (
    deliveryId: string,
    sourceAuthoritySeq: number,
    overrides: Record<string, unknown> = {},
  ) =>
    buildExactReviewQueueRequest(deliveryId, 751, "edited", "pull_request", "openclaw/openclaw", {
      sourceHeadSha: headSha,
      sourceBaseSha: baseSha,
      sourceIsDraft: false,
      sourceContentRevision: "c".repeat(64),
      sourceHeadVerified: true,
      sourceAuthoritySeq,
      sourceUpdatedAt: "2026-07-25T09:00:00Z",
      ...overrides,
    });

  for (const [deliveryId, sourceAuthoritySeq, overrides] of [
    ["semantic-tuple-1", 1, {}],
    ["semantic-tuple-base", 2, { sourceBaseSha: "c".repeat(40) }],
    ["semantic-tuple-draft", 3, { sourceBaseSha: "c".repeat(40), sourceIsDraft: true }],
    [
      "semantic-tuple-content",
      4,
      {
        sourceBaseSha: "c".repeat(40),
        sourceIsDraft: true,
        sourceContentRevision: "d".repeat(64),
      },
    ],
    [
      "semantic-tuple-command",
      5,
      {
        sourceBaseSha: "c".repeat(40),
        sourceIsDraft: true,
        sourceContentRevision: "d".repeat(64),
        additionalPrompt: "Review the revised request.",
      },
    ],
    [
      "semantic-tuple-head",
      6,
      {
        sourceHeadSha: "d".repeat(40),
        sourceBaseSha: "c".repeat(40),
        sourceIsDraft: true,
        sourceContentRevision: "d".repeat(64),
        additionalPrompt: "Review the revised request.",
      },
    ],
  ] as const) {
    const response = await queue.fetch(request(deliveryId, sourceAuthoritySeq, overrides));
    assert.deepEqual(await response.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/openclaw#751",
      superseded_publications: 0,
    });
  }

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        revision: number;
        decision: {
          sourceHeadSha?: string;
          sourceBaseSha?: string;
          sourceIsDraft?: boolean;
          sourceContentRevision?: string;
          additionalPrompt?: string;
        };
      }
    >;
  };
  assert.equal(state.items["openclaw/openclaw#751"].revision, 6);
  assert.equal(state.items["openclaw/openclaw#751"].decision.sourceHeadSha, "d".repeat(40));
  assert.equal(state.items["openclaw/openclaw#751"].decision.sourceBaseSha, "c".repeat(40));
  assert.equal(state.items["openclaw/openclaw#751"].decision.sourceIsDraft, true);
  assert.equal(state.items["openclaw/openclaw#751"].decision.sourceContentRevision, "d".repeat(64));
  assert.equal(
    state.items["openclaw/openclaw#751"].decision.additionalPrompt,
    "Review the revised request.",
  );
});

test("exact-review supersession audit migration preserves legacy records", () => {
  const storage = new MemoryDurableStorage();
  storage.sql.exec(`CREATE TABLE exact_review_queue_supersessions (
    item_key TEXT NOT NULL,
    prior_revision INTEGER NOT NULL,
    next_revision INTEGER NOT NULL,
    superseded_run_id TEXT,
    source_action TEXT NOT NULL,
    superseded_at INTEGER NOT NULL,
    PRIMARY KEY (item_key, prior_revision, next_revision)
  ) STRICT`);
  storage.sql.exec(
    `INSERT INTO exact_review_queue_supersessions
       (item_key, prior_revision, next_revision, superseded_run_id, source_action, superseded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    "openclaw/openclaw#113453",
    3,
    4,
    "30138593399",
    "synchronize",
    1_785_000_000_000,
  );

  new ExactReviewQueue({ storage }, {});

  const rows = Array.from(
    storage.sql.exec(
      `SELECT audit_id, item_key, prior_revision, next_revision, superseded_run_id,
              source_action, reason_code, superseded_at
         FROM exact_review_queue_supersessions`,
    ),
  ).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      audit_id: "legacy:openclaw/openclaw#113453:3:4",
      item_key: "openclaw/openclaw#113453",
      prior_revision: 3,
      next_revision: 4,
      superseded_run_id: "30138593399",
      source_action: "synchronize",
      reason_code: "newer_source_event",
      superseded_at: 1_785_000_000_000,
    },
  ]);

  storage.sql.exec(
    `INSERT OR IGNORE INTO exact_review_queue_supersessions
       (item_key, prior_revision, next_revision, superseded_run_id, source_action, superseded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    "openclaw/openclaw#113453",
    4,
    5,
    "30138593400",
    "synchronize",
    1_785_000_000_001,
  );
  const rollbackAudit = Array.from(
    storage.sql.exec(
      `SELECT audit_id, reason_code
         FROM exact_review_queue_supersessions
        WHERE prior_revision = 4`,
    ),
  ).map((row) => ({ ...row }));
  assert.equal(rollbackAudit.length, 1);
  assert.match(String(rollbackAudit[0]?.audit_id), /^[0-9a-f]{32}$/);
  assert.equal(rollbackAudit[0]?.reason_code, "newer_source_event");
});

test("exact-review supersession audit migration keeps existing rows non-authoritative", async () => {
  const storage = new MemoryDurableStorage();
  storage.sql.exec(`CREATE TABLE exact_review_queue_supersessions (
    audit_id TEXT PRIMARY KEY,
    item_key TEXT NOT NULL,
    prior_revision INTEGER NOT NULL CHECK (prior_revision >= 1),
    next_revision INTEGER NOT NULL CHECK (next_revision > prior_revision),
    superseded_run_id TEXT,
    source_action TEXT NOT NULL,
    reason_code TEXT NOT NULL DEFAULT 'newer_source_event',
    superseded_at INTEGER NOT NULL
  ) STRICT`);
  storage.sql.exec(
    `INSERT INTO exact_review_queue_supersessions
       (audit_id, item_key, prior_revision, next_revision, superseded_run_id,
        source_action, reason_code, superseded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    "existing-audit",
    "openclaw/openclaw#113454",
    7,
    8,
    "30138593401",
    "synchronize",
    "newer_source_event",
    1_785_000_000_002,
  );

  const queue = new ExactReviewQueue({ storage }, {});

  const rows = Array.from(
    storage.sql.exec(
      `SELECT superseded_lease_id, superseded_run_attempt,
              superseded_claim_generation, superseded_protocol_version
         FROM exact_review_queue_supersessions`,
    ),
  ).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      superseded_lease_id: null,
      superseded_run_attempt: null,
      superseded_claim_generation: null,
      superseded_protocol_version: null,
    },
  ]);

  const completion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "legacy-lease",
        item_key: "openclaw/openclaw#113454",
        lease_revision: 7,
        claim_generation: 1,
        run_id: "30138593401",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(completion.status, 409);
  assert.deepEqual(await completion.json(), { error: "lease_not_claimed" });
});

test("automerge reliability summarizes failures, recovery, duration, and stalled runs", () => {
  const run = (
    id: number,
    number: number,
    status: string,
    conclusion: string | null,
    createdAt: string,
    updatedAt: string,
  ) => ({
    id,
    display_title: `automerge repair jobs/openclaw/inbox/automerge-openclaw-openclaw-${number}.md`,
    status,
    conclusion,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: createdAt,
    updated_at: updatedAt,
  });
  const summary = summarizeAutomergeReliability(
    [
      run(1, 107691, "completed", "failure", "2026-07-16T09:00:00Z", "2026-07-16T09:20:00Z"),
      run(2, 107691, "completed", "success", "2026-07-16T09:30:00Z", "2026-07-16T09:40:00Z"),
      run(3, 107692, "completed", "failure", "2026-07-16T10:00:00Z", "2026-07-16T10:20:00Z"),
      run(6, 107692, "completed", "failure", "2026-07-16T08:00:00Z", "2026-07-16T08:05:00Z"),
      run(4, 107693, "in_progress", null, "2026-07-16T09:30:00Z", "2026-07-16T09:30:00Z"),
      {
        ...run(5, 107694, "completed", "failure", "2026-07-16T11:00:00Z", "2026-07-16T11:05:00Z"),
        display_title: "repair cluster jobs/openclaw/inbox/gitcrawl-55.md",
      },
    ],
    ["openclaw/openclaw"],
    "2026-07-16T12:00:00Z",
  );

  assert.equal(summary.sampled_runs, 5);
  assert.equal(summary.completed_attempts, 4);
  assert.equal(summary.failed_attempts, 3);
  assert.equal(summary.failure_rate_percent, 75);
  assert.equal(summary.average_duration_ms, 825_000);
  assert.equal(summary.longest_duration_ms, 1_200_000);
  assert.equal(summary.active_attempts, 1);
  assert.equal(summary.stalled_attempts, 1);
  assert.equal(summary.recovered_failures, 1);
  assert.equal(summary.unresolved_failures, 1);
  assert.deepEqual(
    summary.failures.map((failure) => [failure.number, failure.status]),
    [
      [107692, "unresolved"],
      [107691, "recovered"],
    ],
  );
});

test("exact-review publication scales bounded capacity with ready backlog", () => {
  assert.equal(exactReviewPublicationCapacity({}), 24);
  assert.equal(exactReviewPublicationCapacity({}, 99), 24);
  assert.equal(exactReviewPublicationCapacity({}, 100), 32);
  assert.equal(exactReviewPublicationCapacity({}, 249), 32);
  assert.equal(exactReviewPublicationCapacity({}, 250), 40);
  assert.equal(exactReviewPublicationCapacity({}, 400), 48);
  assert.equal(exactReviewPublicationCapacity({}, 2_000), 48);
  assert.equal(exactReviewPublicationCapacity({}, 0, 40), 40);
  assert.equal(exactReviewPublicationCapacity({}, 400, 0, 32), 32);
  assert.equal(exactReviewPublicationCapacity({}, 400, 0, 8), 8);
  assert.equal(exactReviewPublicationCapacity({}, 400, 40, 24), 40);
  assert.equal(exactReviewPublicationCapacity({}, 0, 0, 48, 60 * 60_000), 32);
  assert.equal(exactReviewPublicationCapacity({}, 50, 0, 48, 0, 0), 32);
  assert.equal(
    exactReviewPublicationCapacity({ EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "12" }),
    12,
  );
  assert.equal(
    exactReviewPublicationCapacity(
      {
        EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT: "16",
        EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "32",
      },
      250,
    ),
    32,
  );
  assert.equal(
    exactReviewPublicationCapacity({
      EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "24",
      EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "16",
    }),
    16,
  );
  assert.equal(
    exactReviewPublicationCapacity(
      {
        EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT: "8",
        EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT: "32",
        EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "40",
      },
      400,
      0,
      16,
    ),
    16,
  );
});

test("exact-review publication admission applies the hysteresis controller demand target", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue({ storage }, {});
    for (let index = 0; index < 50; index += 1) {
      const number = 10_000 + index;
      const response = await queue.fetch(
        buildExactReviewQueueRequest(
          `publication-demand-${number}`,
          number,
          "exact_review_artifact_publish",
          "issue",
          undefined,
          exactReviewPublicationOverrides(number, String(number * 10)),
        ),
      );
      assert.equal(response.status, 202);
    }
    await storage.put("exact-review-publication-control:v1", {
      capacityCeiling: 48,
      demandCapacity: 32,
      cooldownUntil: 0,
      recoverySuccesses: 0,
      demandSamples: 0,
      demandTier: 1,
      lastDemandSampleAt: now,
      lastScaleAt: now,
    });

    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.pending, 50);
    assert.equal(stats.lanes.publication.capacity_control.demand_capacity, 32);
    assert.equal(stats.lanes.publication.capacity, 32);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review publication controller adopts the staged base after a fixed-policy downgrade", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-08-10T09:00:00.000Z");
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const items: Record<string, ReturnType<typeof leasedExactReviewPublicationItem>> = {};
    for (let index = 0; index < 50; index += 1) {
      const item = leasedExactReviewPublicationItem(20_000 + index, String(200_000 + index));
      item.state = "pending";
      item.createdAt = now - 60_000;
      item.updatedAt = now - 60_000;
      items[item.key] = item;
    }
    await storage.put("exact-review-queue", { deliveries: {}, items });
    await storage.put("exact-review-publication-control:v1", {
      capacityCeiling: 50,
      demandCapacity: 50,
      cooldownUntil: 0,
      recoverySuccesses: 0,
      demandSamples: 0,
      demandTier: 0,
      lastDemandSampleAt: now,
      lastScaleAt: now,
    });
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT: "8",
        EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT: "32",
        EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "40",
      },
    );

    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.pending, 50);
    assert.deepEqual(stats.lanes.publication.capacity_control, {
      mode: "adaptive",
      minimum: 8,
      base: 32,
      maximum: 40,
      ceiling: 40,
      demand_capacity: 32,
      demand_samples: 0,
      demand_tier: 0,
      last_scale_at: new Date(now).toISOString(),
      cooldown_until: null,
      recovery_successes: 0,
      last_failure_at: null,
      last_failure_kind: null,
    });
    assert.equal(stats.lanes.publication.capacity, 32);
    const persisted = (await storage.get("exact-review-publication-control:v1")) as {
      capacityCeiling: number;
      demandCapacity: number;
    };
    assert.equal(persisted.capacityCeiling, 40);
    assert.equal(persisted.demandCapacity, 32);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review queue debounces fresh work and caps pending revision extensions", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "1000",
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS: "1500",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("debounce-1", 750, "edited"));
    let state = (await storage.get("exact-review-queue")) as {
      items: Record<string, { createdAt: number; nextAttemptAt: number; revision: number }>;
    };
    assert.equal(state.items["openclaw/gogcli#750"].nextAttemptAt, 1_001_000);

    now += 500;
    await queue.fetch(buildExactReviewQueueRequest("debounce-2", 750, "synchronize"));
    state = (await storage.get("exact-review-queue")) as typeof state;
    assert.equal(state.items["openclaw/gogcli#750"].nextAttemptAt, 1_001_500);
    assert.equal(state.items["openclaw/gogcli#750"].revision, 2);

    now += 900;
    await queue.fetch(buildExactReviewQueueRequest("debounce-3", 750, "edited"));
    state = (await storage.get("exact-review-queue")) as typeof state;
    assert.equal(state.items["openclaw/gogcli#750"].nextAttemptAt, 1_001_500);
    assert.equal(state.items["openclaw/gogcli#750"].revision, 3);
    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.enqueued_total, 1);
    assert.equal(stats.lanes.publication.enqueued_total, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review queue bypasses debounce for commands and publications", async () => {
  const originalNow = Date.now;
  Date.now = () => 2_000_000;
  try {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue({ storage }, {});
    const commandStatusMarker =
      "<!-- clawsweeper-command-status:751:re_review:0123456789abcdef0123456789abcdef01234567 -->";
    await queue.fetch(
      buildExactReviewQueueRequest(
        "command-immediate",
        751,
        "legacy_dispatch",
        "issue",
        undefined,
        {
          commandStatusMarker,
        },
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publication-immediate",
        752,
        "exact_review_artifact_publish",
        "issue",
        undefined,
        exactReviewPublicationOverrides(752, "7520"),
      ),
    );
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, { nextAttemptAt: number }>;
    };
    assert.equal(state.items["openclaw/gogcli#751"].nextAttemptAt, 2_000_000);
    assert.equal(state.items["openclaw/gogcli#752@publish:7520:1"].nextAttemptAt, 2_000_000);

    // A later plain webhook event merging into the pending command must not
    // re-debounce it: immediacy comes from the merged decision's command marker.
    await queue.fetch(buildExactReviewQueueRequest("command-followup", 751, "edited"));
    const merged = (await storage.get("exact-review-queue")) as {
      items: Record<string, { nextAttemptAt: number; revision: number }>;
    };
    assert.equal(merged.items["openclaw/gogcli#751"].revision, 2);
    assert.equal(merged.items["openclaw/gogcli#751"].nextAttemptAt, 2_000_000);
    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.enqueued_total, 1);
    assert.equal(stats.lanes.review.flow.last_15_minutes.arrival_rate_per_hour, 4);
    assert.equal(stats.lanes.publication.enqueued_total, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review queue bypasses debounce only for fresh pull request openings", async () => {
  const originalNow = Date.now;
  let now = 2_500_000;
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "90000",
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS: "180000",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("fresh-opened", 753, "opened", "pull_request"));
    await queue.fetch(
      buildExactReviewQueueRequest("fresh-ready", 754, "ready_for_review", "pull_request"),
    );
    await queue.fetch(
      buildExactReviewQueueRequest("fresh-synchronize", 755, "synchronize", "pull_request"),
    );
    await queue.fetch(
      buildExactReviewQueueRequest("scheduled-unchanged", 756, "scheduled_normal_backfill"),
    );
    await queue.fetch(buildExactReviewQueueRequest("existing-organic", 757, "opened"));

    let state = (await storage.get("exact-review-queue")) as {
      items: Record<string, { nextAttemptAt: number; revision: number }>;
    };
    assert.equal(state.items["openclaw/gogcli#753"].nextAttemptAt, now);
    assert.equal(state.items["openclaw/gogcli#754"].nextAttemptAt, now);
    assert.equal(state.items["openclaw/gogcli#755"].nextAttemptAt, now + 90_000);
    assert.equal(state.items["openclaw/gogcli#756"].nextAttemptAt, now);
    assert.equal(state.items["openclaw/gogcli#757"].nextAttemptAt, now + 90_000);

    now += 1_000;
    await queue.fetch(buildExactReviewQueueRequest("existing-coalesced", 757, "edited"));
    state = (await storage.get("exact-review-queue")) as typeof state;
    assert.equal(state.items["openclaw/gogcli#757"].revision, 2);
    assert.equal(state.items["openclaw/gogcli#757"].nextAttemptAt, now + 90_000);
  } finally {
    Date.now = originalNow;
  }
});

test("replacing a queued command cannot inherit another command's delivery identity", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const firstMarker = "<!-- clawsweeper-command-status:751:re_review:first -->";
  const replacementMarker = "<!-- clawsweeper-command-status:751:autofix:replacement -->";
  await queue.fetch(
    buildExactReviewQueueRequest(
      "delivery-first-command",
      751,
      "legacy_dispatch",
      "issue",
      undefined,
      {
        commandStatusMarker: firstMarker,
        statusCommentId: 9301,
        sourceDeliveryId: "github-first-command-delivery",
      },
    ),
  );
  await queue.fetch(
    buildExactReviewQueueRequest(
      "delivery-replacement-command",
      751,
      "legacy_dispatch",
      "issue",
      undefined,
      {
        commandStatusMarker: replacementMarker,
        statusCommentId: 9401,
      },
    ),
  );
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: Record<string, unknown> }>;
  };
  assert.equal(state.items["openclaw/gogcli#751"]?.decision.commandStatusMarker, replacementMarker);
  assert.equal(state.items["openclaw/gogcli#751"]?.decision.statusCommentId, 9401);
  assert.equal(state.items["openclaw/gogcli#751"]?.decision.sourceDeliveryId, undefined);

  await queue.fetch(
    buildExactReviewQueueRequest(
      "delivery-shared-original",
      752,
      "legacy_dispatch",
      "issue",
      undefined,
      {
        commandStatusMarker: firstMarker,
        statusCommentId: 9301,
        sourceDeliveryId: "github-shared-original-delivery",
      },
    ),
  );
  await queue.fetch(
    buildExactReviewQueueRequest(
      "delivery-shared-replacement",
      752,
      "legacy_dispatch",
      "issue",
      undefined,
      {
        commandStatusMarker: firstMarker,
        statusCommentId: 9301,
      },
    ),
  );
  const sameMarkerState = (await storage.get("exact-review-queue")) as typeof state;
  assert.equal(
    sameMarkerState.items["openclaw/gogcli#752"]?.decision.commandStatusMarker,
    firstMarker,
  );
  assert.equal(sameMarkerState.items["openclaw/gogcli#752"]?.decision.statusCommentId, 9301);
  assert.equal(sameMarkerState.items["openclaw/gogcli#752"]?.decision.sourceDeliveryId, undefined);
});

test("exact-review queue coalesces one pending publication lineage across producer runs", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const first = await queue.fetch(
    buildExactReviewQueueRequest(
      "lineage-first",
      753,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(753, "7530"),
    ),
  );
  assert.equal((await first.json()).queued, true);

  const duplicate = await queue.fetch(
    buildExactReviewQueueRequest(
      "lineage-duplicate",
      753,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(753, "7531"),
    ),
  );
  assert.deepEqual(await duplicate.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#753@publish:7530:1",
    semantic_deduped: true,
    semantic_duplicates_removed: 0,
  });

  const duplicateRetry = await queue.fetch(
    buildExactReviewQueueRequest(
      "lineage-duplicate-retry",
      753,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(753, "7531"),
    ),
  );
  assert.deepEqual(await duplicateRetry.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#753@publish:7530:1",
    semantic_deduped: true,
    semantic_duplicates_removed: 0,
  });

  const delayedFirstProducer = await queue.fetch(
    buildExactReviewQueueRequest(
      "lineage-first-producer-delayed",
      753,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(753, "7530"),
    ),
  );
  assert.equal((await delayedFirstProducer.json()).deduped, true);

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { publication: { producerRunId: string } } }>;
  };
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#753@publish:7530:1"]);
  assert.equal(
    state.items["openclaw/gogcli#753@publish:7530:1"].decision.publication.producerRunId,
    "7531",
  );
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.enqueued_total, 1);
  assert.equal(stats.lanes.publication.semantic_deduped_total, 3);
});

test("exact-review queue cleans legacy sibling lineages without replacing newer provenance", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(
    buildExactReviewQueueRequest(
      "legacy-lineage-first",
      755,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(755, "7550"),
    ),
  );
  const firstState = structuredClone(
    (await storage.get("exact-review-queue")) as {
      items: Record<string, { key: string; createdAt: number; decision: unknown }>;
    },
  );
  await queue.fetch(
    buildExactReviewQueueRequest(
      "legacy-lineage-second",
      755,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(755, "7551"),
    ),
  );
  const refreshedState = structuredClone(
    (await storage.get("exact-review-queue")) as typeof firstState,
  );
  const firstKey = "openclaw/gogcli#755@publish:7550:1";
  const siblingKey = "openclaw/gogcli#755@publish:7551:1";
  const firstItem = firstState.items[firstKey];
  const refreshedItem = refreshedState.items[firstKey];
  await storage.put("exact-review-queue", {
    ...refreshedState,
    items: {
      [firstKey]: firstItem,
      [siblingKey]: {
        ...refreshedItem,
        key: siblingKey,
        createdAt: firstItem.createdAt + 1,
      },
    },
  });

  const retry = await queue.fetch(
    buildExactReviewQueueRequest(
      "legacy-lineage-first-retry",
      755,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(755, "7550"),
    ),
  );
  assert.deepEqual(await retry.json(), {
    ok: true,
    deduped: true,
    item_key: firstKey,
    semantic_deduped: true,
    semantic_duplicates_removed: 1,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { revision: number; decision: { publication: { producerRunId: string } } }
    >;
  };
  assert.deepEqual(Object.keys(state.items), [firstKey]);
  assert.equal(state.items[firstKey].revision, 1);
  assert.equal(state.items[firstKey].decision.publication.producerRunId, "7551");
});

test("exact-review queue persists legacy sibling cleanup during same-key redelivery", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(
    buildExactReviewQueueRequest(
      "legacy-sibling-first",
      756,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(756, "7560"),
    ),
  );
  const firstState = structuredClone(
    (await storage.get("exact-review-queue")) as {
      items: Record<string, { key: string; createdAt: number; decision: unknown }>;
    },
  );
  await queue.fetch(
    buildExactReviewQueueRequest(
      "legacy-sibling-second",
      756,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(756, "7561"),
    ),
  );
  const refreshedState = structuredClone(
    (await storage.get("exact-review-queue")) as typeof firstState,
  );
  const olderKey = "openclaw/gogcli#756@publish:7560:1";
  const retainedKey = "openclaw/gogcli#756@publish:7561:1";
  const olderItem = firstState.items[olderKey];
  const refreshedItem = refreshedState.items[olderKey];
  await storage.put("exact-review-queue", {
    ...refreshedState,
    items: {
      [retainedKey]: {
        ...refreshedItem,
        key: retainedKey,
        createdAt: 1,
      },
      [olderKey]: {
        ...olderItem,
        createdAt: 2,
      },
    },
  });

  const retry = await queue.fetch(
    buildExactReviewQueueRequest(
      "legacy-sibling-retained-retry",
      756,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(756, "7561"),
    ),
  );
  assert.deepEqual(await retry.json(), {
    ok: true,
    queued: true,
    item_key: retainedKey,
    superseded_publications: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { revision: number; decision: { publication: { producerRunId: string } } }
    >;
  };
  assert.deepEqual(Object.keys(state.items), [retainedKey]);
  assert.equal(state.items[retainedKey].revision, 2);
  assert.equal(state.items[retainedKey].decision.publication.producerRunId, "7561");
});

test("exact-review queue protects an active batch lineage from a later duplicate", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    {
      EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
      EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "1",
    },
  );
  await queue.fetch(
    buildExactReviewQueueRequest(
      "active-lineage-first",
      754,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(754, "7540"),
    ),
  );
  const claim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
      method: "POST",
      body: JSON.stringify({
        claim_id: "lineage-batch",
        lease_owner: "lineage-owner",
        max_items: 1,
      }),
    }),
  );
  assert.equal((await claim.json()).claimed, true);

  const duplicate = await queue.fetch(
    buildExactReviewQueueRequest(
      "active-lineage-duplicate",
      754,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(754, "7541"),
    ),
  );
  assert.equal((await duplicate.json()).semantic_deduped, true);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { publication: { producerRunId: string } } }>;
  };
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#754@publish:7540:1"]);
  assert.equal(
    state.items["openclaw/gogcli#754@publish:7540:1"].decision.publication.producerRunId,
    "7540",
  );
});

test("direct lifecycle recovery bypasses publication batching", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(757, "7570");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  const marker =
    "<!-- clawsweeper-command-status:757:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7570 });
  leased.leaseDecision = { ...leased.decision };
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });

  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      return jsonResponse({ state: "active" });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|openclaw|gogcli)\/installation$/.test(url.pathname)) {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "t" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "2",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "2",
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_MAX_CONCURRENT: "1",
      },
    );
    const secret = "direct-lifecycle-batch-secret";
    const env = {
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const publication = {
      canonicalTargetKey: "openclaw/openclaw#757",
      fenceKey: leased.key,
      revision: 4,
      sourceSha: "a".repeat(40),
      identity: {
        canonicalTargetKey: "openclaw/openclaw#757",
        fenceKey: leased.key,
        revision: 4,
        claimGeneration: 2,
      },
      operations: [
        {
          path: "records/openclaw-openclaw/items/757.md",
          deleted: false,
          mode: "100644",
          bytes: 1,
          contentBase64: "eA==",
        },
      ],
      totalBytes: 1,
      lifecycle: { kind: "router" },
    };
    const publicationBody = JSON.stringify(publication);
    const publicationSignature = `sha256=${createHmac("sha256", secret)
      .update(publicationBody)
      .digest("hex")}`;
    assert.equal(
      (
        await worker.fetch(
          new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": publicationSignature },
            body: publicationBody,
          }),
          env,
        )
      ).status,
      202,
    );

    let state = storage.sql.readNormalizedQueue() as {
      items: Record<string, ExactReviewQueueItem>;
    };
    state.items[leased.key]!.leaseExpiresAt = Date.now() - 1;
    storage.sql.replaceNormalizedQueue(state);
    const expiredClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leased.leaseId,
          item_key: leased.key,
          lease_revision: 4,
          run_id: leased.claimedRunId,
          run_attempt: leased.claimedRunAttempt,
        }),
      }),
    );
    assert.deepEqual(await expiredClaim.json(), { error: "lease_not_active" });
    state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
    assert.equal(state.items[leased.key]?.state, "pending", JSON.stringify(state.items));

    assert.equal(
      (
        await queue.fetch(
          buildExactReviewQueueRequest(
            "batchable-publication-peer",
            758,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(758, "7580"),
          ),
        )
      ).status,
      202,
    );
    const batchableKey = "openclaw/gogcli#758@publish:7580:1";
    state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
    assert.equal(state.items[batchableKey]?.state, "pending", JSON.stringify(state.items));
    assert.ok(state.items[batchableKey]!.nextAttemptAt <= Date.now());
    const batchClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
        method: "POST",
        body: JSON.stringify({
          claim_id: "direct-lifecycle-bypass-batch",
          lease_owner: "direct-lifecycle-bypass-owner",
          max_items: 1,
        }),
      }),
    );
    const batch = await batchClaim.json();
    assert.equal(batch.claimed, true, JSON.stringify(batch));
    assert.deepEqual(
      batch.batch.items.map((item: { item_key: string }) => item.item_key),
      [batchableKey],
    );

    state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
    assert.deepEqual(
      exactReviewQueueAdmittedItems(
        state as never,
        Date.now(),
        2,
        2,
        2,
        new Set([batchableKey]),
        true,
      ).map((item) => item.key),
      [leased.key],
    );

    await queue.alarm();
    assert.equal(dispatched.length, 1);
    const payload = dispatched[0]!.client_payload as {
      queue_claim: { item_key: string };
      source_action: string;
      review_options: { publication: { directLifecycle?: { plan: { kind: string } } } };
    };
    assert.equal(payload.source_action, "exact_review_artifact_publish");
    assert.equal(payload.queue_claim.item_key, leased.key);
    assert.equal(payload.review_options.publication.directLifecycle?.plan.kind, "router");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("superseding source revisions revoke the old lease without Actions cancellation", async () => {
  const originalNow = Date.now;
  const now = 3_000_000;
  Date.now = () => now;
  const storage = new MemoryDurableStorage();
  const staleHeadSha = "a".repeat(40);
  const currentHeadSha = "b".repeat(40);
  const staleBase = leasedExactReviewQueueItem(753, "7530");
  const stale = {
    ...staleBase,
    createdAt: now - 10 * 60_000,
    updatedAt: now - 10 * 60_000,
    decision: {
      ...staleBase.decision,
      itemKind: "pull_request" as const,
      sourceEvent: "pull_request" as const,
      sourceHeadSha: staleHeadSha,
      sourceUpdatedAt: "2026-07-23T13:00:01Z",
    },
    leaseDecision: {
      ...staleBase.leaseDecision,
      itemKind: "pull_request" as const,
      sourceEvent: "pull_request" as const,
      sourceHeadSha: staleHeadSha,
      sourceUpdatedAt: "2026-07-23T13:00:01Z",
      commandStatusMarker: "<!-- clawsweeper-command-status:753:re_review:old-head -->",
    },
  };
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#753": stale },
  });
  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "90000",
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS: "180000",
      },
    );
    const response = await queue.fetch(
      buildExactReviewQueueRequest(
        "superseding-head-753",
        753,
        "synchronize",
        "pull_request",
        "openclaw/openclaw",
        {
          sourceHeadSha: currentHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 1,
          sourceUpdatedAt: "2026-07-23T13:00:02Z",
        },
      ),
    );

    assert.equal(response.status, 202);
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    const current = state.items["openclaw/openclaw#753"];
    assert.ok(current);
    assert.equal(current.state, "pending");
    assert.equal(current.revision, 2);
    assert.equal(current.createdAt, now);
    assert.equal(current.nextAttemptAt, now + 90_000);
    assert.equal(current.leaseId, undefined);
    assert.equal(current.claimedRunId, undefined);
    assert.equal(current.leaseDecision, undefined);
    assert.equal((current.decision as Record<string, unknown>).sourceAction, "synchronize");
    assert.equal((current.decision as Record<string, unknown>).commandStatusMarker, undefined);
    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.superseded_total, 1);
    assert.deepEqual(
      Array.from(
        storage.sql.exec(
          `SELECT item_key, prior_revision, next_revision, superseded_run_id,
                  superseded_lease_id, superseded_run_attempt, superseded_claim_generation,
                  superseded_protocol_version, source_action, superseded_at
             FROM exact_review_queue_supersessions`,
        ),
        (row) => ({ ...row }),
      ),
      [
        {
          item_key: "openclaw/openclaw#753",
          prior_revision: 1,
          next_revision: 2,
          superseded_lease_id: "lease-753",
          superseded_run_id: "7530",
          superseded_run_attempt: 1,
          superseded_claim_generation: 1,
          superseded_protocol_version: 2,
          source_action: "synchronize",
          superseded_at: now,
        },
      ],
    );

    const staleCompletion = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-753",
          item_key: "openclaw/openclaw#753",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7530",
          run_attempt: 1,
          outcome: "success",
        }),
      }),
    );
    assert.equal(staleCompletion.status, 409);
    assert.deepEqual(await staleCompletion.json(), {
      error: "lease_superseded",
      superseded_by_revision: 2,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("source timestamp and sequence ordering protect a newer-head lease", async () => {
  const storage = new MemoryDurableStorage();
  const staleHeadSha = "a".repeat(40);
  const currentHeadSha = "b".repeat(40);
  const activeBase = leasedExactReviewQueueItem(756, "7560");
  const active = {
    ...activeBase,
    decision: {
      ...activeBase.decision,
      itemKind: "pull_request" as const,
      sourceEvent: "pull_request" as const,
      sourceAction: "synchronize",
      supersedesInProgress: true,
      sourceHeadSha: currentHeadSha,
      sourceHeadVerified: true,
      sourceAuthoritySeq: 2,
      sourceUpdatedAt: "2026-07-23T13:00:02Z",
    },
    leaseDecision: {
      ...activeBase.leaseDecision,
      itemKind: "pull_request" as const,
      sourceEvent: "pull_request" as const,
      sourceAction: "synchronize",
      supersedesInProgress: true,
      sourceHeadSha: currentHeadSha,
      sourceHeadVerified: true,
      sourceAuthoritySeq: 2,
      sourceUpdatedAt: "2026-07-23T13:00:02Z",
    },
  };
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#756": active },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "delayed-stale-head-756",
      756,
      "synchronize",
      "pull_request",
      "openclaw/openclaw",
      {
        sourceHeadSha: staleHeadSha,
        sourceHeadVerified: true,
        sourceAuthoritySeq: 1,
        sourceUpdatedAt: "2026-07-23T13:00:02Z",
      },
    ),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/openclaw#756",
    stale_source: true,
  });
  const olderSourceResponse = await queue.fetch(
    buildExactReviewQueueRequest(
      "later-reserved-older-head-756",
      756,
      "synchronize",
      "pull_request",
      "openclaw/openclaw",
      {
        sourceHeadSha: staleHeadSha,
        sourceHeadVerified: true,
        sourceAuthoritySeq: 3,
        sourceUpdatedAt: "2026-07-23T13:00:01Z",
      },
    ),
  );
  assert.equal(olderSourceResponse.status, 202);
  assert.equal((await olderSourceResponse.json()).stale_source, true);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof active>;
  };
  const current = state.items["openclaw/openclaw#756"];
  assert.equal(current.state, "leased");
  assert.equal(current.revision, 1);
  assert.equal(current.claimedRunId, "7560");
  assert.equal(current.decision.sourceHeadSha, currentHeadSha);
  assert.equal(current.leaseDecision.sourceHeadSha, currentHeadSha);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.superseded_total, 0);
  assert.deepEqual(
    Array.from(storage.sql.exec(`SELECT item_key FROM exact_review_queue_supersessions`)),
    [],
  );
});

test("delayed opened pull request delivery cannot replace a newer pending synchronize", async () => {
  const storage = new MemoryDurableStorage();
  const staleHeadSha = "a".repeat(40);
  const currentHeadSha = "b".repeat(40);
  const now = Date.now();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#757": {
        key: "openclaw/openclaw#757",
        decision: {
          targetRepo: "openclaw/openclaw",
          targetBranch: "main",
          itemNumber: 757,
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceAction: "synchronize",
          supersedesInProgress: true,
          sourceHeadSha: currentHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 2,
          sourceUpdatedAt: "2026-07-23T13:00:02Z",
        },
        state: "pending",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now + 90_000,
        attempts: 0,
      },
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "delayed-opened-pending-head-757",
      757,
      "opened",
      "pull_request",
      "openclaw/openclaw",
      {
        sourceHeadSha: staleHeadSha,
        sourceAuthoritySeq: 1,
        sourceUpdatedAt: "2026-07-23T13:00:02Z",
      },
    ),
  );

  assert.equal(response.status, 202);
  assert.equal((await response.json()).stale_source, true);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { revision: number; decision: { sourceHeadSha?: string } }>;
  };
  assert.equal(state.items["openclaw/openclaw#757"].revision, 1);
  assert.equal(state.items["openclaw/openclaw#757"].decision.sourceHeadSha, currentHeadSha);
});

test("explicit pull request commands bind to pending source authority", async () => {
  const originalNow = Date.now;
  const now = 4_000_000;
  Date.now = () => now;
  const storage = new MemoryDurableStorage();
  const currentHeadSha = "b".repeat(40);
  try {
    await storage.put("exact-review-queue", {
      deliveries: {},
      items: {
        "openclaw/openclaw#758": {
          key: "openclaw/openclaw#758",
          decision: {
            targetRepo: "openclaw/openclaw",
            targetBranch: "main",
            itemNumber: 758,
            itemKind: "pull_request",
            sourceEvent: "pull_request",
            sourceAction: "synchronize",
            supersedesInProgress: true,
            sourceHeadSha: currentHeadSha,
            sourceHeadVerified: true,
            sourceAuthoritySeq: 2,
            sourceUpdatedAt: "2026-07-23T13:00:02Z",
          },
          state: "pending",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          nextAttemptAt: now + 90_000,
          attempts: 0,
        },
      },
    });
    const queue = new ExactReviewQueue({ storage }, {});
    const commandStatusMarker =
      "<!-- clawsweeper-command-status:758:re_review:0123456789abcdef0123456789abcdef01234567 -->";

    const commandResponse = await queue.fetch(
      buildExactReviewQueueRequest(
        "explicit-command-758",
        758,
        "legacy_dispatch",
        "pull_request",
        "openclaw/openclaw",
        {
          commandStatusMarker,
          statusCommentId: 9001,
        },
      ),
    );

    assert.equal(commandResponse.status, 202);
    assert.equal((await commandResponse.json()).queued, true);
    let state = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          revision: number;
          nextAttemptAt: number;
          decision: Record<string, unknown>;
        }
      >;
    };
    let current = state.items["openclaw/openclaw#758"];
    assert.equal(current.revision, 2);
    assert.equal(current.nextAttemptAt, now);
    assert.equal(current.decision.sourceHeadSha, currentHeadSha);
    assert.equal(current.decision.sourceHeadVerified, true);
    assert.equal(current.decision.sourceAuthoritySeq, 2);
    assert.equal(current.decision.sourceUpdatedAt, "2026-07-23T13:00:02Z");
    assert.equal(current.decision.commandStatusMarker, commandStatusMarker);
    assert.equal(current.decision.statusCommentId, 9001);

    const staleWebhookResponse = await queue.fetch(
      buildExactReviewQueueRequest(
        "stale-after-command-758",
        758,
        "opened",
        "pull_request",
        "openclaw/openclaw",
        {
          sourceHeadSha: "a".repeat(40),
          sourceAuthoritySeq: 1,
          sourceUpdatedAt: "2026-07-23T13:00:01Z",
        },
      ),
    );
    assert.equal(staleWebhookResponse.status, 202);
    assert.equal((await staleWebhookResponse.json()).stale_source, true);
    state = (await storage.get("exact-review-queue")) as typeof state;
    current = state.items["openclaw/openclaw#758"];
    assert.equal(current.revision, 2);
    assert.equal(current.decision.sourceHeadSha, currentHeadSha);
    assert.equal(current.decision.commandStatusMarker, commandStatusMarker);
  } finally {
    Date.now = originalNow;
  }
});

test("explicit pull request commands queue behind a dispatching authoritative review", async () => {
  const storage = new MemoryDurableStorage();
  const currentHeadSha = "b".repeat(40);
  const item = unclaimedExactReviewQueueItem(759);
  item.decision = {
    ...item.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
    sourceHeadSha: currentHeadSha,
    sourceHeadVerified: true,
    sourceAuthoritySeq: 2,
    sourceUpdatedAt: "2026-07-23T13:00:02Z",
  };
  item.leaseDecision = { ...item.decision };
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#759": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:759:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const command = buildExactReviewQueueRequest(
    "explicit-command-dispatching-759",
    759,
    "legacy_dispatch",
    "pull_request",
    "openclaw/openclaw",
    {
      commandStatusMarker,
      statusCommentId: 9002,
      additionalPrompt: "Inspect the command-requested dispatching follow-up.",
    },
  );

  const response = await queue.fetch(command.clone());
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, true);
  const afterCommand = structuredClone(await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        revision: number;
        leaseId?: string;
        leaseRevision?: number;
        decision: Record<string, unknown>;
        leaseDecision?: Record<string, unknown>;
      }
    >;
  };
  const current = afterCommand.items["openclaw/openclaw#759"];
  assert.equal(current.state, "dispatching");
  assert.equal(current.revision, 2);
  assert.equal(current.leaseId, "lease-759");
  assert.equal(current.leaseRevision, 1);
  assert.equal(current.leaseDecision?.commandStatusMarker, undefined);
  assert.equal(current.leaseDecision?.sourceHeadSha, currentHeadSha);
  assert.equal(current.decision.sourceHeadSha, currentHeadSha);
  assert.equal(current.decision.sourceAuthoritySeq, 2);
  assert.equal(current.decision.commandStatusMarker, commandStatusMarker);
  assert.equal(current.decision.statusCommentId, 9002);
  assert.equal(
    current.decision.additionalPrompt,
    "Inspect the command-requested dispatching follow-up.",
  );

  const redelivery = await queue.fetch(command);
  assert.equal(redelivery.status, 202);
  assert.equal((await redelivery.json()).deduped, true);
  assert.deepEqual(await storage.get("exact-review-queue"), afterCommand);
});

test("explicit pull request commands survive an active authoritative lease completion", async () => {
  const storage = new MemoryDurableStorage();
  const currentHeadSha = "c".repeat(40);
  const item = leasedExactReviewQueueItem(760, "7600");
  item.decision = {
    ...item.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
    sourceHeadSha: currentHeadSha,
    sourceHeadVerified: true,
    sourceAuthoritySeq: 3,
    sourceUpdatedAt: "2026-07-23T13:00:03Z",
  };
  item.leaseDecision = { ...item.decision };
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#760": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:760:re_review:abcdef0123456789abcdef0123456789abcdef01 -->";
  const command = buildExactReviewQueueRequest(
    "explicit-command-leased-760",
    760,
    "legacy_dispatch",
    "pull_request",
    "openclaw/openclaw",
    {
      commandStatusMarker,
      statusCommentId: 9003,
      additionalPrompt: "Inspect the command-requested leased follow-up.",
    },
  );

  const response = await queue.fetch(command.clone());
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, true);
  const afterCommand = structuredClone(await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        revision: number;
        leaseId?: string;
        leaseRevision?: number;
        decision: Record<string, unknown>;
        leaseDecision?: Record<string, unknown>;
      }
    >;
  };
  const active = afterCommand.items["openclaw/openclaw#760"];
  assert.equal(active.state, "leased");
  assert.equal(active.revision, 2);
  assert.equal(active.leaseId, "lease-760");
  assert.equal(active.leaseRevision, 1);
  assert.equal(active.leaseDecision?.commandStatusMarker, undefined);
  assert.equal(active.leaseDecision?.sourceHeadSha, currentHeadSha);
  assert.equal(active.decision.sourceHeadSha, currentHeadSha);
  assert.equal(active.decision.sourceAuthoritySeq, 3);
  assert.equal(active.decision.commandStatusMarker, commandStatusMarker);
  assert.equal(active.decision.statusCommentId, 9003);
  assert.equal(active.decision.additionalPrompt, "Inspect the command-requested leased follow-up.");

  const redelivery = await queue.fetch(command);
  assert.equal(redelivery.status, 202);
  assert.equal((await redelivery.json()).deduped, true);
  assert.deepEqual(await storage.get("exact-review-queue"), afterCommand);

  const completion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-760",
        item_key: "openclaw/openclaw#760",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7600",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(completion.status, 200);
  assert.deepEqual(await completion.json(), { ok: true, requeued: true });
  const completed = (await storage.get("exact-review-queue")) as typeof afterCommand;
  const followUp = completed.items["openclaw/openclaw#760"];
  assert.equal(followUp.state, "pending");
  assert.equal(followUp.revision, 2);
  assert.equal(followUp.leaseId, undefined);
  assert.equal(followUp.leaseDecision, undefined);
  assert.equal(followUp.decision.sourceHeadSha, currentHeadSha);
  assert.equal(followUp.decision.sourceAuthoritySeq, 3);
  assert.equal(followUp.decision.commandStatusMarker, commandStatusMarker);
  assert.equal(followUp.decision.statusCommentId, 9003);
  assert.equal(
    followUp.decision.additionalPrompt,
    "Inspect the command-requested leased follow-up.",
  );
});

test("a newer explicit command survives completion of the active command lease", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(761, "7610");
  const firstMarker =
    "<!-- clawsweeper-command-status:761:autofix:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const nextMarker =
    "<!-- clawsweeper-command-status:761:automerge:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->";
  item.decision = {
    ...item.decision,
    sourceAction: "legacy_dispatch",
    commandStatusMarker: firstMarker,
    statusCommentId: 9004,
  };
  item.leaseDecision = { ...item.decision };
  item.attempts = 7;
  item.reviewFailureAttempts = 7;
  item.reviewRetryPolicyEpoch = "1";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [item.key]: item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const queued = await queue.fetch(
    buildExactReviewQueueRequest(
      "newer-explicit-command-761",
      761,
      "legacy_dispatch",
      "issue",
      "openclaw/openclaw",
      {
        commandStatusMarker: nextMarker,
        statusCommentId: 9005,
        additionalPrompt: "Run the newer explicit command.",
      },
    ),
  );
  assert.equal(queued.status, 202);

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].revision, 2);
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].decision.commandStatusMarker, nextMarker);
  assert.equal(state.items[item.key].decision.statusCommentId, 9005);
  assert.equal(state.items[item.key].decision.additionalPrompt, "Run the newer explicit command.");
});

test("same-timestamp verified successor replaces the current pull request head", async () => {
  const storage = new MemoryDurableStorage();
  const currentHeadSha = "b".repeat(40);
  const successorHeadSha = "c".repeat(40);
  const activeBase = leasedExactReviewQueueItem(7571, "75710");
  const active = {
    ...activeBase,
    decision: {
      ...activeBase.decision,
      itemKind: "pull_request" as const,
      sourceEvent: "pull_request" as const,
      sourceAction: "synchronize",
      supersedesInProgress: true,
      sourceHeadSha: currentHeadSha,
      sourceHeadVerified: true,
      sourceAuthoritySeq: 2,
      sourceUpdatedAt: "2026-07-23T13:00:02Z",
    },
    leaseDecision: {
      ...activeBase.leaseDecision,
      itemKind: "pull_request" as const,
      sourceEvent: "pull_request" as const,
      sourceAction: "synchronize",
      supersedesInProgress: true,
      sourceHeadSha: currentHeadSha,
      sourceHeadVerified: true,
      sourceAuthoritySeq: 2,
      sourceUpdatedAt: "2026-07-23T13:00:02Z",
    },
  };
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#7571": active },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "same-timestamp-successor-7571",
      7571,
      "synchronize",
      "pull_request",
      "openclaw/openclaw",
      {
        sourceHeadSha: successorHeadSha,
        sourceHeadVerified: true,
        sourceAuthoritySeq: 3,
        sourceUpdatedAt: "2026-07-23T13:00:02Z",
      },
    ),
  );

  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, true);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; revision: number; decision: { sourceHeadSha?: string } }
    >;
  };
  assert.equal(state.items["openclaw/openclaw#7571"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#7571"].revision, 2);
  assert.equal(state.items["openclaw/openclaw#7571"].decision.sourceHeadSha, successorHeadSha);
});

test("verified live head supersedes a timestamp-less rolling lease", async () => {
  const originalNow = Date.now;
  const storage = new MemoryDurableStorage();
  const rolling = leasedExactReviewQueueItem(758, "7580");
  rolling.decision.itemKind = "pull_request";
  rolling.decision.sourceEvent = "pull_request";
  rolling.leaseDecision.itemKind = "pull_request";
  rolling.leaseDecision.sourceEvent = "pull_request";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#758": rolling },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const currentHeadSha = "c".repeat(40);
  Date.now = () => rolling.updatedAt + 1_000;

  try {
    const heartbeat = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          item_key: "openclaw/openclaw#758",
          lease_id: "lease-758",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7580",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(heartbeat.status, 200);
    const response = await queue.fetch(
      buildExactReviewQueueRequest(
        "current-head-after-rolling-758",
        758,
        "synchronize",
        "pull_request",
        "openclaw/openclaw",
        {
          sourceHeadSha: currentHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 1,
          sourceUpdatedAt: "2026-07-23T13:00:03Z",
        },
      ),
    );

    assert.equal(response.status, 202);
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        { state: string; revision: number; decision: { sourceHeadSha?: string } }
      >;
    };
    assert.equal(state.items["openclaw/openclaw#758"].state, "pending");
    assert.equal(state.items["openclaw/openclaw#758"].revision, 2);
    assert.equal(state.items["openclaw/openclaw#758"].decision.sourceHeadSha, currentHeadSha);
  } finally {
    Date.now = originalNow;
  }
});

test("same-head edit supersedes a timestamp-less rolling decision", async () => {
  const storage = new MemoryDurableStorage();
  const currentHeadSha = "d".repeat(40);
  const rolling = leasedExactReviewQueueItem(759, "7590");
  rolling.decision.itemKind = "pull_request";
  rolling.decision.sourceEvent = "pull_request";
  rolling.decision.sourceHeadSha = currentHeadSha;
  rolling.leaseDecision.itemKind = "pull_request";
  rolling.leaseDecision.sourceEvent = "pull_request";
  rolling.leaseDecision.sourceHeadSha = currentHeadSha;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#759": rolling },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "same-head-edit-after-rolling-759",
      759,
      "edited",
      "pull_request",
      "openclaw/openclaw",
      {
        sourceHeadSha: currentHeadSha,
        sourceAuthoritySeq: 1,
      },
    ),
  );

  assert.equal(response.status, 202);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; revision: number; decision: { sourceAction: string } }>;
  };
  assert.equal(state.items["openclaw/openclaw#759"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#759"].revision, 2);
  assert.equal(state.items["openclaw/openclaw#759"].decision.sourceAction, "edited");
});

test("exact-review heartbeat binds a claimed pull request source head", async () => {
  const storage = new MemoryDurableStorage();
  const staleHeadSha = "c".repeat(40);
  const staleBase = leasedExactReviewQueueItem(755, "7550");
  const stale = {
    ...staleBase,
    decision: {
      ...staleBase.decision,
      itemKind: "pull_request" as const,
      sourceEvent: "pull_request" as const,
      sourceHeadSha: staleHeadSha,
    },
    leaseDecision: {
      ...staleBase.leaseDecision,
      itemKind: "pull_request" as const,
      sourceEvent: "pull_request" as const,
      sourceHeadSha: staleHeadSha,
    },
  };
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#755": stale },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const heartbeat = (sourceHeadSha?: string) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          item_key: "openclaw/openclaw#755",
          lease_id: "lease-755",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7550",
          run_attempt: 1,
          ...(sourceHeadSha ? { source_head_sha: sourceHeadSha } : {}),
        }),
      }),
    );

  assert.equal((await heartbeat()).status, 409);
  assert.equal((await heartbeat("d".repeat(40))).status, 409);
  assert.equal((await heartbeat(staleHeadSha)).status, 200);
});

test("recovery revisions cannot supersede an active authoritative exact review", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const active = leasedExactReviewQueueItem(754, "7540");
  active.decision.sourceAction = "synchronize";
  active.leaseDecision.sourceAction = "synchronize";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#754": active },
  });
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected cancellation request ${String(input)}`);
  };

  try {
    const queue = new ExactReviewQueue({ storage }, {});
    for (const sourceAction of [
      "failed_review_shard_recovery",
      "artifact_retention_recovery",
      "source_drift_requeue",
    ]) {
      const response = await queue.fetch(
        buildExactReviewQueueRequest(
          `stale-recovery-${sourceAction}`,
          754,
          sourceAction,
          "pull_request",
          "openclaw/openclaw",
        ),
      );
      assert.equal(response.status, 202);
    }

    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    const current = state.items["openclaw/openclaw#754"];
    assert.equal(current.state, "leased");
    assert.equal(current.revision, 1);
    assert.equal(current.claimedRunId, "7540");
    assert.equal((current.decision as Record<string, unknown>).sourceAction, "synchronize");
    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.superseded_total, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue sheds only new recovery work above the pending soft limit", async () => {
  const storage = new MemoryDurableStorage();
  const env = {
    EXACT_REVIEW_PENDING_SOFT_LIMIT: "1",
    EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
  };
  const queue = new ExactReviewQueue({ storage }, env);
  await queue.fetch(buildExactReviewQueueRequest("ordinary-existing", 760, "edited"));

  const existing = await queue.fetch(
    buildExactReviewQueueRequest("existing-recovery", 760, "source_drift_requeue"),
  );
  assert.equal(existing.status, 202);
  assert.equal((await existing.json()).queued, true);

  for (const [index, sourceAction] of [
    "failed_review_shard_recovery",
    "artifact_retention_recovery",
    "source_drift_requeue",
  ].entries()) {
    const shed = await queue.fetch(
      buildExactReviewQueueRequest(`shed-${index}`, 761 + index, sourceAction),
    );
    assert.equal(shed.status, 202);
    assert.deepEqual(await shed.json(), { ok: true, shed: true, reason: "backpressure" });
  }

  const placeholderRecovery = await queue.fetch(
    buildExactReviewQueueRequest(
      "placeholder-recovery-over-limit",
      769,
      "review_placeholder_recovery",
    ),
  );
  assert.equal(placeholderRecovery.status, 202);
  const placeholderRecoveryBody = await placeholderRecovery.json();
  assert.equal(placeholderRecoveryBody.queued, true);
  assert.notEqual(placeholderRecoveryBody.shed, true);

  const webhook = await queue.fetch(
    buildExactReviewQueueRequest("webhook-over-limit", 770, "opened"),
  );
  assert.equal((await webhook.json()).queued, true);
  const publication = await queue.fetch(
    buildExactReviewQueueRequest(
      "publication-over-limit",
      771,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(771, "7710"),
    ),
  );
  assert.equal((await publication.json()).queued, true);

  const restarted = new ExactReviewQueue({ storage }, env);
  const stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 3);
  assert.equal(stats.shed_since_reset, 3);
  assert.equal(stats.handoff_health.pending_depth, 3);
  assert.equal(stats.handoff_health.shed_since_reset, 3);
  assert.equal(stats.lanes.review.pending_depth, 3);
  assert.equal(stats.lanes.review.shed_since_reset, 3);
  assert.equal(stats.lanes.review.enqueued_total, 3);
  assert.deepEqual(stats.lanes.review.shed_reasons_since_reset, {
    backpressure: 3,
    scheduled_rate: 0,
    unattributed: 0,
  });
  assert.deepEqual(stats.lanes.review.flow.last_15_minutes, {
    window_minutes: 15,
    arrival: 6,
    successful: 0,
    retried: 0,
    shed: 3,
    shed_reasons: { backpressure: 3, scheduled_rate: 0 },
    arrival_rate_per_hour: 24,
    successful_rate_per_hour: 0,
    retried_rate_per_hour: 0,
    shed_rate_per_hour: 12,
    retry_amplification: null,
  });
  assert.equal(stats.lanes.publication.enqueued_total, 1);
});

test("scheduled review feed is lane-paced and exposes its configured target", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    {
      EXACT_REVIEW_TARGET_RATE_PER_HOUR: "2",
      EXACT_REVIEW_TARGET_BURST: "2",
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "600000",
    },
  );

  for (const [lane, sourceAction, start] of [
    ["hot_intake", "scheduled_hot_intake", 780],
    ["normal_backfill", "scheduled_normal_backfill", 790],
  ] as const) {
    const admitted = await queue.fetch(
      buildExactReviewQueueRequest(`scheduled-${lane}-1`, start, sourceAction),
    );
    assert.equal((await admitted.json()).queued, true);
    const limited = await queue.fetch(
      buildExactReviewQueueRequest(`scheduled-${lane}-2`, start + 1, sourceAction),
    );
    assert.deepEqual(await limited.json(), {
      ok: true,
      shed: true,
      reason: "scheduled_rate",
    });
  }

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 2);
  assert.equal(stats.shed_since_reset, 2);
  assert.deepEqual(stats.scheduled_feed, {
    target_rate_per_hour: 2,
    enqueue_replay: "scheduled_disposition_v1",
    burst: 2,
    token_balance: 0,
    lanes: {
      hot_intake: { target_rate_per_hour: 1, burst: 1, token_balance: 0 },
      normal_backfill: { target_rate_per_hour: 1, burst: 1, token_balance: 0 },
    },
  });
});

test("scheduled untracked reviews are ready and claimable within one tick when 122 slots are free", async () => {
  const storage = new MemoryDurableStorage();
  const active = Object.fromEntries(
    Array.from({ length: 6 }, (_, index) => {
      const item = leasedExactReviewQueueItem(120_000 + index, String(120_000 + index));
      return [item.key, item];
    }),
  );
  await storage.put("exact-review-queue", { items: active });
  const queue = new ExactReviewQueue(
    { storage },
    {
      EXACT_REVIEW_ACTIONS_BUDGET: "194",
      EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "128",
      EXACT_REVIEW_TARGET_MAX_CONCURRENT: "120",
      EXACT_REVIEW_TARGET_RATE_PER_HOUR: "600",
      EXACT_REVIEW_TARGET_BURST: "120",
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "90000",
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS: "180000",
    },
  );

  for (let index = 0; index < 31; index += 1) {
    const response = await queue.fetch(
      buildExactReviewQueueRequest(
        `scheduled-untracked-${index}`,
        121_000 + index,
        "scheduled_normal_backfill",
        index % 2 === 0 ? "issue" : "pull_request",
        "openclaw/openclaw",
        { sourceUpdatedAt: "2026-07-30T13:00:00Z" },
      ),
    );
    assert.equal((await response.json()).queued, true);
  }

  const status = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(status.lanes.review.available_slots, 122);
  assert.equal(status.lanes.review.pending, 31);
  assert.equal(status.lanes.review.ready, 31);
  assert.equal(status.lanes.review.backoff, 0);
  assert.equal(status.admissible_pending, 31);
});

test("exact-review lane status counts backoff and parked reasons", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    {
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "600000",
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS: "600000",
    },
  );
  await queue.fetch(buildExactReviewQueueRequest("reason-backoff", 121_100, "opened"));
  await queue.fetch(buildExactReviewQueueRequest("reason-parked", 121_101, "opened"));
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; parkedReason?: string; backoffReason?: string; updatedAt: number }
    >;
  };
  state.items["openclaw/gogcli#121101"].state = "parked";
  state.items["openclaw/gogcli#121101"].parkedReason = "dispatch_rejected";
  state.items["openclaw/gogcli#121101"].backoffReason = undefined;
  await storage.put("exact-review-queue", state);

  const status = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.deepEqual(status.lanes.review.backoff_reasons, { dispatch_debounce: 1 });
  assert.deepEqual(status.lanes.review.parked_reasons, { dispatch_rejected: 1 });
});

test("organic reviews consume the global target before scheduled backfill", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    {
      EXACT_REVIEW_TARGET_RATE_PER_HOUR: "2",
      EXACT_REVIEW_TARGET_BURST: "2",
    },
  );
  await queue.fetch(buildExactReviewQueueRequest("organic-1", 795, "opened"));
  await queue.fetch(buildExactReviewQueueRequest("organic-2", 796, "opened"));
  const scheduled = await queue.fetch(
    buildExactReviewQueueRequest("scheduled-after-organic", 797, "scheduled_normal_backfill"),
  );
  assert.deepEqual(await scheduled.json(), {
    ok: true,
    shed: true,
    reason: "scheduled_rate",
  });
});

test("scheduled review feed dedupes untouched queued items without superseding them", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("ordinary-before-schedule", 800, "opened")))
      .status,
    202,
  );

  const duplicate = await queue.fetch(
    buildExactReviewQueueRequest("scheduled-duplicate", 800, "scheduled_normal_backfill"),
  );
  assert.deepEqual(await duplicate.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#800",
    dedupe_scope: "scheduled_queue_item",
    dedupe_reason: "item_already_pending_or_active",
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { revision: number; decision: { sourceAction: string } }>;
  };
  assert.equal(state.items["openclaw/gogcli#800"].revision, 1);
  assert.equal(state.items["openclaw/gogcli#800"].decision.sourceAction, "opened");
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 1);
  assert.equal(stats.lanes.review.superseded_total, 0);
});

test("scheduled review feed stops at the pending soft limit", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_PENDING_SOFT_LIMIT: "1" });
  await queue.fetch(
    buildExactReviewQueueRequest("scheduled-pending-1", 810, "scheduled_hot_intake"),
  );
  const shed = await queue.fetch(
    buildExactReviewQueueRequest("scheduled-pending-2", 811, "scheduled_hot_intake"),
  );
  assert.deepEqual(await shed.json(), { ok: true, shed: true, reason: "backpressure" });
});

test("publication backlog does not consume the review pending soft limit", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_PENDING_SOFT_LIMIT: "1", EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "600000" },
  );
  const publication = await queue.fetch(
    buildExactReviewQueueRequest(
      "publication-before-review-limit",
      812,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(812, "8120"),
    ),
  );
  assert.equal((await publication.json()).queued, true);

  const admitted = await queue.fetch(
    buildExactReviewQueueRequest("scheduled-with-publication-backlog", 813, "scheduled_hot_intake"),
  );
  assert.equal((await admitted.json()).queued, true);

  const shed = await queue.fetch(
    buildExactReviewQueueRequest("scheduled-over-review-limit", 814, "scheduled_hot_intake"),
  );
  assert.deepEqual(await shed.json(), { ok: true, shed: true, reason: "backpressure" });

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.lanes.publication.pending, 1);
  assert.deepEqual(stats.lanes.review.shed_reasons_since_reset, {
    backpressure: 1,
    scheduled_rate: 0,
    unattributed: 0,
  });
});

test("exact-review queue does not count work for a disabled target", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    buildExactReviewQueueRequest("disabled-clawhub", 780, "opened", "issue", "openclaw/clawhub"),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "target not enabled",
  });
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 0);
  assert.equal(stats.lanes.publication.enqueued_total, 0);
});

test("review heartbeats use grace while finalizing leases keep execution expiry", () => {
  const now = 1_000_000;
  const item = {
    ...leasedExactReviewQueueItem(700, "7000"),
    leaseHeartbeatAt: undefined as number | undefined,
  };
  item.leaseExpiresAt = now + 130 * 60_000;
  assert.equal(exactReviewEffectiveLeaseExpiresAt(item, 15 * 60_000), item.leaseExpiresAt);

  item.leaseHeartbeatAt = now;
  assert.equal(exactReviewEffectiveLeaseExpiresAt(item, 15 * 60_000), now + 20 * 60_000);
  assert.equal(exactReviewEffectiveLeaseExpiresAt(item, 15 * 60_000, 5 * 60_000), now + 5 * 60_000);

  item.leasePhase = "finalizing";
  assert.equal(exactReviewEffectiveLeaseExpiresAt(item, 15 * 60_000), item.leaseExpiresAt);
});

test("exact-review heartbeat refreshes only the matching live lease tuple", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#700": leasedExactReviewQueueItem(700, "7000"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  // Heartbeat is tuple-authenticated like /claim and /complete: no webhook signature.
  const env = {
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const body = JSON.stringify({
    item_key: "openclaw/openclaw#700",
    lease_id: "lease-700",
    lease_revision: 1,
    claim_generation: 1,
    run_id: "7000",
    run_attempt: 1,
  });
  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/heartbeat", {
      method: "POST",
      body,
    }),
    env,
  );
  assert.equal(response.status, 200);
  const heartbeatResponse = (await response.json()) as {
    ok: boolean;
    phase: string;
    lease_heartbeat_at: string;
  };
  assert.equal(heartbeatResponse.ok, true);
  assert.equal(heartbeatResponse.phase, "review");
  assert.equal(Number.isFinite(Date.parse(heartbeatResponse.lease_heartbeat_at)), true);
  const heartbeatAt = Number(
    (
      (await storage.get("exact-review-queue")) as {
        items: Record<string, { leaseHeartbeatAt?: number }>;
      }
    ).items["openclaw/openclaw#700"].leaseHeartbeatAt,
  );
  assert.ok(heartbeatAt > 0);

  const finalizing = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/heartbeat", {
      method: "POST",
      body: JSON.stringify({ ...JSON.parse(body), phase: "finalizing" }),
    }),
    env,
  );
  assert.equal(finalizing.status, 200);
  assert.equal(((await finalizing.json()) as { phase: string }).phase, "finalizing");
  assert.equal(
    (
      (await storage.get("exact-review-queue")) as {
        items: Record<string, { leasePhase?: string }>;
      }
    ).items["openclaw/openclaw#700"].leasePhase,
    "finalizing",
  );

  const mismatchBody = JSON.stringify({
    item_key: "openclaw/openclaw#700",
    lease_id: "lease-700",
    lease_revision: 1,
    claim_generation: 2,
    run_id: "7000",
    run_attempt: 1,
  });
  const mismatch = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/heartbeat", {
      method: "POST",
      body: mismatchBody,
    }),
    env,
  );
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await mismatch.json(), { error: "lease_not_active" });
});

test("exact-review queue requeues a heartbeat-stale lease before execution expiry", async () => {
  const storage = new MemoryDurableStorage();
  const item = {
    ...leasedExactReviewQueueItem(701, "7010"),
    leaseHeartbeatAt: undefined as number | undefined,
  };
  item.leaseExpiresAt = Date.now() + 100 * 60_000;
  item.leaseHeartbeatAt = Date.now() - 21 * 60_000;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#701": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pending, 1);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; leaseId?: string; leaseHeartbeatAt?: number }>;
  };
  assert.equal(state.items["openclaw/openclaw#701"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#701"].leaseId, undefined);
  assert.equal(state.items["openclaw/openclaw#701"].leaseHeartbeatAt, undefined);
});

test("signed claimed-run snapshot feeds tuple-safe terminal reconciliation", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#702": leasedExactReviewQueueItem(702, "7020"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const claimedBody = JSON.stringify({ runs: [], include_all_claimed: true });
  const claimedSignature = `sha256=${createHmac("sha256", "test-token-placeholder").update(claimedBody).digest("hex")}`;
  const claimed = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/claimed-runs", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": claimedSignature },
      body: claimedBody,
    }),
    env,
  );
  assert.equal(claimed.status, 200);
  assert.deepEqual(await claimed.json(), {
    runs: [{ run_id: "7020", run_attempt: 1, claim_generation: 1 }],
  });

  const terminalBody = JSON.stringify({
    terminal_runs: [
      {
        run_id: "7020",
        run_attempt: 1,
        claimed_run_attempt: 1,
        claim_generation: 1,
        outcome: "success",
      },
    ],
  });
  const terminalSignature = `sha256=${createHmac("sha256", "test-token-placeholder").update(terminalBody).digest("hex")}`;
  const reconciled = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": terminalSignature },
      body: terminalBody,
    }),
    env,
  );
  assert.equal(reconciled.status, 200);
  assert.deepEqual(await reconciled.json(), {
    ok: true,
    reconciled: 1,
    requeued: 0,
    completed: 1,
  });
});

test("fresh dead-letter recovery is available only through the signed internal route", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
    EXACT_REVIEW_OPERATOR_SECRET: "operator-token-placeholder",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const body = JSON.stringify({ ids: ["missing-dead-letter"], idempotency_key: "operator:test" });
  const unsigned = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/dead-letters/recover-fresh",
      {
        method: "POST",
        body,
      },
    ),
    env,
  );
  assert.equal(unsigned.status, 401);

  const sharedSignature = `sha256=${createHmac("sha256", "test-token-placeholder").update(body).digest("hex")}`;
  const sharedSigned = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/dead-letters/recover-fresh",
      {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": sharedSignature },
        body,
      },
    ),
    env,
  );
  assert.equal(sharedSigned.status, 401);

  const signature = `sha256=${createHmac("sha256", "operator-token-placeholder").update(body).digest("hex")}`;
  const signed = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/dead-letters/recover-fresh",
      {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      },
    ),
    env,
  );
  assert.equal(signed.status, 200);
  assert.deepEqual(await signed.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });
});

test("parked review inventory and mutations require the operator signature", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
    EXACT_REVIEW_OPERATOR_SECRET: "operator-token-placeholder",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const requests = [
    { path: "list", payload: { limit: 5 } },
    {
      path: "resolve",
      payload: {
        items: [{ item_key: "openclaw/gogcli#1", revision: 1, updated_at_ms: 1 }],
        note: "terminal target",
      },
    },
    {
      path: "recover-fresh",
      payload: {
        items: [{ item_key: "openclaw/gogcli#1", revision: 1, updated_at_ms: 1 }],
        idempotency_key: "parked-reconcile:test",
      },
    },
  ];
  for (const { path, payload } of requests) {
    const body = JSON.stringify(payload);
    const url = `https://clawsweeper.openclaw.ai/internal/exact-review/parked-reviews/${path}`;
    assert.equal((await worker.fetch(new Request(url, { method: "POST", body }), env)).status, 401);
    const sharedSignature = `sha256=${createHmac("sha256", "test-token-placeholder").update(body).digest("hex")}`;
    assert.equal(
      (
        await worker.fetch(
          new Request(url, {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": sharedSignature },
            body,
          }),
          env,
        )
      ).status,
      401,
    );
    const operatorSignature = `sha256=${createHmac("sha256", "operator-token-placeholder").update(body).digest("hex")}`;
    assert.equal(
      (
        await worker.fetch(
          new Request(url, {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": operatorSignature },
            body,
          }),
          env,
        )
      ).status,
      200,
    );
  }
});
