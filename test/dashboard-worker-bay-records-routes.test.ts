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
  mergeBayJourneyState,
  mergeBayTerminalState,
  recentWorkerHealthRunSample,
  workerHealthSectionTimeoutMs,
  bayJourneyTimingSnapshot,
  commandAcknowledgementState,
  ExactReviewLifecycleProjectionStore,
  ExactReviewLifecycleTelemetryStore,
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
import { EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE } from "../dashboard/exact-review-lifecycle.ts";
import {
  EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE,
  EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE,
  EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE,
  EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
  EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE,
  EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD,
  EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE,
} from "../dashboard/exact-review-lifecycle-telemetry.ts";

const TIDE = EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD;

let nextBayFinalReceiptCommentId = 900_000;

function recordBayFinalReceipt(
  lifecycle: ExactReviewLifecycleProjectionStore,
  identity: { canonicalTargetKey: string; fenceKey: string; revision: number },
  observedAt: number,
) {
  lifecycle.recordGithubEffect({
    ...identity,
    commentId: nextBayFinalReceiptCommentId++,
    digest: createHash("sha256")
      .update(
        `${identity.canonicalTargetKey}:${identity.fenceKey}:${identity.revision}:${observedAt}`,
      )
      .digest("hex"),
    observedAt,
  });
}

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
  assert.equal(observation.projection?.bayTelemetryPending, true);
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, `${canonicalTargetKey}@exact:1`, 1)!),
    "completed",
  );
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, `${canonicalTargetKey}@exact:2`, 2)!),
    "acknowledgement_pending",
  );
});

test("Bay lifecycle keeps the direct timing aggregate separate from batch-classified paths", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  telemetry.syncBayRepositoryScope(new Set(["openclaw/openclaw"]), now);

  for (const [index, direct] of [true, false].entries()) {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${9_180 + index}`,
      fenceKey: direct
        ? `openclaw/openclaw#${9_180 + index}@exact:1`
        : `openclaw/openclaw#${9_180 + index}@publish:9180:1`,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `publication-path:${index}`,
      sourceAction: "synchronize",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now + index * 10_000,
      observedAt: now + index * 10_000,
    });
    recordBayFinalReceipt(lifecycle, identity, now + index * 10_000 + 60_000);
    if (direct) {
      telemetry.recordDirectOutcome({
        ...identity,
        claimGeneration: 1,
        outcome: "accepted",
        observedAt: now + index * 10_000 + 60_000,
      });
    }
    telemetry.syncBayLifecycle(
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: "review_completed_routed",
        observedAt: now + index * 10_000 + 60_000,
      }),
    );
  }

  const snapshot = telemetry.baySnapshot(now + 120_000, new Set(["openclaw/openclaw"]));
  assert.deepEqual(snapshot.timings?.overall, {
    average_ms: 60_000,
    median_ms: 60_000,
    samples: 1,
  });
  assert.deepEqual(snapshot.timings?.including_legacy_batch.overall, {
    average_ms: 60_000,
    median_ms: 60_000,
    samples: 2,
  });
  assert.deepEqual(
    snapshot.terminal?.terminal_buffer.map((entry) => entry.legacy_batch_path),
    [false, true],
  );
});

test("Bay lifecycle retains direct-path classification after direct telemetry expires", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9182",
    fenceKey: "openclaw/openclaw#9182@exact:1",
    revision: 1,
  };
  telemetry.syncBayRepositoryScope(new Set(["openclaw/openclaw"]), now);
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "retained-direct-path",
    sourceAction: "synchronize",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now,
    observedAt: now,
  });
  recordBayFinalReceipt(lifecycle, identity, now + 60_000);
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now + 60_000,
    }),
  );
  telemetry.recordDirectOutcome({
    ...identity,
    claimGeneration: 1,
    outcome: "accepted",
    observedAt: now + 60_000,
  });

  const afterRetention = now + 8 * 24 * 60 * 60_000;
  telemetry.recordDirectOutcome({
    canonicalTargetKey: "openclaw/openclaw#9183",
    fenceKey: "openclaw/openclaw#9183@exact:1",
    revision: 1,
    claimGeneration: 1,
    outcome: "accepted",
    observedAt: afterRetention,
  });

  assert.equal(
    telemetry.baySnapshot(afterRetention, new Set(["openclaw/openclaw"])).terminal
      ?.terminal_buffer[0]?.legacy_batch_path,
    false,
  );
});

test("Bay lifecycle does not backdate coverage for a late final receipt", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9151",
    fenceKey: "openclaw/openclaw#9151@exact:1",
    revision: 1,
  };
  telemetry.syncBayRepositoryScope(new Set(["openclaw/openclaw"]), now);
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "late-final-receipt",
    sourceAction: "synchronize",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now - 23 * 60 * 60_000,
    observedAt: now - 23 * 60 * 60_000,
  });
  recordBayFinalReceipt(lifecycle, identity, now - 2 * 60 * 60_000);
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now,
    }),
  );
  const snapshot = telemetry.baySnapshot(now, new Set(["openclaw/openclaw"]));
  assert.equal(snapshot.timings?.overall.samples, 0);
  assert.equal(snapshot.coverage?.timing_complete, false);
  assert.equal(snapshot.terminal?.terminal_count, 0);
});

test("Bay lifecycle includes an in-flight public review when it initializes its first scope", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9107",
    fenceKey: "openclaw/openclaw#9107@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "initial-scope-in-flight",
    sourceAction: "synchronize",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now - 90_000,
    observedAt: now - 90_000,
  });

  telemetry.syncBayRepositoryScope(new Set(["openclaw/openclaw"]), now);
  recordBayFinalReceipt(lifecycle, identity, now + 1_000);
  telemetry.recordDirectOutcome({
    ...identity,
    claimGeneration: 1,
    outcome: "accepted",
    observedAt: now + 1_000,
  });
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now + 1_000,
    }),
  );

  const snapshot = telemetry.baySnapshot(now + 2_000, new Set(["openclaw/openclaw"]));
  assert.equal(snapshot.collection.state, "complete");
  assert.equal(snapshot.coverage?.timing_complete, false);
  assert.deepEqual(snapshot.timings?.overall, {
    average_ms: 91_000,
    median_ms: 91_000,
    samples: 1,
  });
  assert.equal(snapshot.terminal?.terminal_count, 1);
});

test("Bay lifecycle timing coverage is bound to the public Bay repository scope", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  telemetry.ensureSchemaSync();
  const privateIdentity = {
    canonicalTargetKey: "private/example#9110",
    fenceKey: "private/example#9110@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...privateIdentity,
    deliveryId: "delivery:private",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now - 3 * 60 * 60_000,
    observedAt: now - 3 * 60 * 60_000,
  });
  recordBayFinalReceipt(lifecycle, privateIdentity, now - 3 * 60 * 60_000 + 60_000);
  telemetry.recordDirectOutcome({
    ...privateIdentity,
    claimGeneration: 1,
    outcome: "accepted",
    observedAt: now - 3 * 60 * 60_000 + 60_000,
  });
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...privateIdentity,
      kind: "review_completed_routed",
      observedAt: now - 3 * 60 * 60_000 + 60_000,
    }),
  );
  const previouslyPrivatePublicIdentity = {
    canonicalTargetKey: "openclaw/clawsweeper#9111",
    fenceKey: "openclaw/clawsweeper#9111@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...previouslyPrivatePublicIdentity,
    deliveryId: "delivery:previously-private-public",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now + 89 * 60_000,
    observedAt: now + 89 * 60_000,
  });
  recordBayFinalReceipt(lifecycle, previouslyPrivatePublicIdentity, now + 90 * 60_000);
  telemetry.recordDirectOutcome({
    ...previouslyPrivatePublicIdentity,
    claimGeneration: 1,
    outcome: "accepted",
    observedAt: now + 90 * 60_000,
  });
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...previouslyPrivatePublicIdentity,
      kind: "review_completed_routed",
      observedAt: now + 90 * 60_000,
    }),
  );
  const inFlightScopeChangeIdentity = {
    canonicalTargetKey: "openclaw/clawsweeper#9112",
    fenceKey: "openclaw/clawsweeper#9112@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...inFlightScopeChangeIdentity,
    deliveryId: "delivery:in-flight-scope-change",
    sourceAction: "synchronize",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now + 119 * 60_000,
    observedAt: now + 119 * 60_000,
  });

  const initialScope = new Set(["openclaw/openclaw"]);
  telemetry.syncBayRepositoryScope(initialScope, now);
  const warming = telemetry.baySnapshot(now + 59 * 60_000, initialScope);
  assert.equal(warming.collection.state, "complete");
  assert.equal(warming.coverage?.timing_complete, false);

  const expandedScope = new Set(["openclaw/openclaw", "openclaw/clawsweeper"]);
  assert.equal(
    telemetry.baySnapshot(now + 2 * 60 * 60_000, expandedScope).collection.state,
    "unknown",
  );
  telemetry.syncBayRepositoryScope(expandedScope, now + 2 * 60 * 60_000);
  recordBayFinalReceipt(lifecycle, inFlightScopeChangeIdentity, now + 2 * 60 * 60_000 + 60_000);
  telemetry.recordDirectOutcome({
    ...inFlightScopeChangeIdentity,
    claimGeneration: 1,
    outcome: "accepted",
    observedAt: now + 2 * 60 * 60_000 + 60_000,
  });
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...inFlightScopeChangeIdentity,
      kind: "review_completed_routed",
      observedAt: now + 2 * 60 * 60_000 + 60_000,
    }),
  );
  const preScopeCompletion = telemetry.baySnapshot(
    now + 2 * 60 * 60_000 + 30 * 60_000,
    expandedScope,
  );
  assert.equal(preScopeCompletion.timings?.overall.samples, 0);
  assert.equal(preScopeCompletion.terminal?.terminal_count, 0);
  const globalAfterScopeChange = telemetry.baySnapshot(now + 2 * 60 * 60_000 + 30 * 60_000);
  assert.equal(globalAfterScopeChange.timings?.overall.samples, 2);
  assert.equal(globalAfterScopeChange.terminal?.terminal_count, 2);
  const reset = telemetry.baySnapshot(now + 2 * 60 * 60_000 + 59 * 60_000, expandedScope);
  assert.equal(reset.collection.state, "complete");
  assert.equal(reset.coverage?.timing_complete, false);
  assert.equal(
    telemetry.baySnapshot(now + 3 * 60 * 60_000, expandedScope).coverage?.timing_complete,
    true,
  );
});

test("Bay lifecycle tides are derived from all durable terminal revisions", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  for (let index = 0; index <= TIDE; index += 1) {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${9_200 + index}`,
      fenceKey: `openclaw/openclaw#${9_200 + index}@exact:${index + 1}`,
      revision: index + 1,
    };
    const triggeredAt = now + 1_000 + index * 1_000;
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `delivery:${index}`,
      sourceAction: index % 2 ? "synchronize" : "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt,
      observedAt: triggeredAt,
    });
    const completedAt = index === TIDE ? now + (TIDE + 1) * 1_000 : triggeredAt + 1_000;
    recordBayFinalReceipt(lifecycle, identity, completedAt);
    const completed = lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: completedAt,
    });
    telemetry.syncBayLifecycle(completed);
  }
  const snapshot = telemetry.baySnapshot(now + 60_000);
  assert.equal(snapshot.collection.state, "complete");
  assert.equal(snapshot.terminal?.tide_generation, 1);
  assert.equal(snapshot.terminal?.terminal_count, 1);
  assert.equal(snapshot.terminal?.last_tide_at, new Date(now + (TIDE + 1) * 1_000).toISOString());
  assert.equal(snapshot.terminal?.recently_washed.length, TIDE);
  assert.deepEqual(
    snapshot.terminal?.terminal_buffer.map((entry) => entry.item_key),
    [`openclaw/openclaw#${9_200 + TIDE}`],
  );
});

test("Bay lifecycle keeps only bounded tide detail after many completions", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const publicScope = new Set(["openclaw/openclaw"]);
  telemetry.syncBayRepositoryScope(publicScope, now);
  const completions = 6 * TIDE - 1;
  for (let index = 0; index < completions; index += 1) {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${9_240 + index}`,
      fenceKey: `openclaw/openclaw#${9_240 + index}@exact:${index + 1}`,
      revision: index + 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `bounded-tide:${index}`,
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now + index * 1_000,
      observedAt: now + index * 1_000,
    });
    recordBayFinalReceipt(lifecycle, identity, now + index * 1_000 + 500);
    telemetry.syncBayLifecycle(
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: "review_completed_routed",
        observedAt: now + index * 1_000 + 500,
      }),
    );
  }
  const snapshot = telemetry.baySnapshot(now + (completions + 1) * 1_000, publicScope);
  assert.equal(snapshot.terminal?.tide_generation, 5);
  assert.equal(snapshot.terminal?.terminal_count, TIDE - 1);
  assert.equal(snapshot.terminal?.terminal_buffer.length, TIDE - 1);
  assert.equal(snapshot.terminal?.recently_washed.length, TIDE);
  const bufferRows = Number(
    Array.from(
      storage.sql.exec(
        `SELECT COUNT(*) AS count FROM ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}`,
      ),
    )[0]?.count || 0,
  );
  // Global and the one public Bay scope each retain at most the current
  // (TIDE - 1)-item tide plus one TIDE-item washed tide.
  assert.equal(bufferRows, 2 * (TIDE - 1 + TIDE));
});

test("Bay lifecycle keeps an empty public scope separate from the global tide", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9355",
    fenceKey: "openclaw/openclaw#9355@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "empty-scope",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now,
    observedAt: now,
  });
  recordBayFinalReceipt(lifecycle, identity, now + 500);
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now + 500,
    }),
  );

  telemetry.syncBayRepositoryScope(new Set(), now + 1_000);
  const emptyScope = telemetry.baySnapshot(now + 2_000, new Set());
  assert.equal(emptyScope.collection.state, "complete");
  assert.equal(emptyScope.terminal?.terminal_count, 0);
  assert.equal(emptyScope.terminal?.terminal_buffer.length, 0);
  assert.equal(telemetry.baySnapshot(now + 2_000).terminal?.terminal_count, 1);
});

test("Bay lifecycle orders delayed terminal delivery by completion time", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  for (let index = 0; index < TIDE - 1; index += 1) {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${9_360 + index}`,
      fenceKey: `openclaw/openclaw#${9_360 + index}@exact:1`,
      revision: 1,
    };
    const triggeredAt = now + index * 1_000;
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `ordered:${index}`,
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt,
      observedAt: triggeredAt,
    });
    recordBayFinalReceipt(lifecycle, identity, triggeredAt + 100);
    telemetry.syncBayLifecycle(
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: "review_completed_routed",
        observedAt: triggeredAt + 100,
      }),
    );
  }
  const laterKey = `openclaw/openclaw#${9_360 + TIDE}`;
  const laterIdentity = {
    canonicalTargetKey: laterKey,
    fenceKey: `${laterKey}@exact:1`,
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...laterIdentity,
    deliveryId: "ordered:later",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now + (TIDE + 9) * 1_000,
    observedAt: now + (TIDE + 9) * 1_000,
  });
  recordBayFinalReceipt(lifecycle, laterIdentity, now + (TIDE + 10) * 1_000);
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...laterIdentity,
      kind: "review_completed_routed",
      observedAt: now + (TIDE + 10) * 1_000,
    }),
  );
  // Completes after the first TIDE - 1 items but is delivered after the later one.
  const delayedKey = `openclaw/openclaw#${9_360 + TIDE - 1}`;
  const delayedCompletedAt = now + (TIDE - 1) * 1_000;
  const delayedIdentity = {
    canonicalTargetKey: delayedKey,
    fenceKey: `${delayedKey}@exact:1`,
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...delayedIdentity,
    deliveryId: "ordered:delayed",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: delayedCompletedAt - 500,
    observedAt: delayedCompletedAt - 500,
  });
  recordBayFinalReceipt(lifecycle, delayedIdentity, delayedCompletedAt);
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...delayedIdentity,
      kind: "review_completed_routed",
      observedAt: delayedCompletedAt,
    }),
  );

  const snapshot = telemetry.baySnapshot(now + 60_000);
  assert.equal(snapshot.terminal?.tide_generation, 1);
  assert.equal(snapshot.terminal?.terminal_count, 1);
  assert.equal(snapshot.terminal?.last_tide_at, new Date(delayedCompletedAt).toISOString());
  assert.deepEqual(
    snapshot.terminal?.terminal_buffer.map((entry) => entry.item_key),
    [laterKey],
  );
});

test("Bay lifecycle tide rebuild preserves pre-change direct publication classification", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  telemetry.syncBayRepositoryScope(new Set(["openclaw/openclaw"]), now);

  const recordDirectReview = (number: number, triggeredAt: number, prefix: string) => {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${number}`,
      fenceKey: `openclaw/openclaw#${number}@exact:1`,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `direct-rebuild:${number}`,
      sourceAction: "synchronize",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt,
      observedAt: triggeredAt,
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: "accepted",
      receiptId: `${prefix}:${identity.fenceKey}:1:accepted`,
      observedAt: triggeredAt + 1_000,
    });
    recordBayFinalReceipt(lifecycle, identity, triggeredAt + 1_000);
    telemetry.recordDirectOutcome({
      ...identity,
      claimGeneration: 1,
      outcome: "accepted",
      observedAt: triggeredAt + 1_000,
    });
    return lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: triggeredAt + 1_000,
    });
  };

  const older = recordDirectReview(9381, now + 1_000, "direct");
  const newer = recordDirectReview(9382, now + 3_000, "direct-v2");
  telemetry.syncBayLifecycle(newer);
  telemetry.syncBayLifecycle(older);

  assert.deepEqual(
    telemetry
      .baySnapshot(now + 5_000, new Set(["openclaw/openclaw"]))
      .terminal?.terminal_buffer.map((entry) => entry.legacy_batch_path),
    [false, false],
  );

  storage.sql.exec(
    `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE} WHERE event_id = ?`,
    `bay:v2:${older.fenceKey}:${older.revision}`,
  );
  storage.sql.exec(
    `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE}
      WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
    older.canonicalTargetKey,
    older.fenceKey,
    older.revision,
  );
  delete older.bayTelemetryEventId;
  telemetry.syncBayLifecycle(older);
  assert.equal(
    telemetry.baySnapshot(now + 6_000, new Set(["openclaw/openclaw"])).terminal?.terminal_buffer[0]
      ?.legacy_batch_path,
    false,
  );
});

test("Bay lifecycle refreshes a retained terminal outcome without advancing its tide", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9390",
    fenceKey: "openclaw/openclaw#9390@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "outcome-refresh",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now,
    observedAt: now,
  });
  lifecycle.recordReviewResult({
    ...identity,
    claimGeneration: 1,
    runId: "9390",
    runAttempt: 1,
    outcome: "failed",
    observedAt: now + 100,
  });
  recordBayFinalReceipt(lifecycle, identity, now + 200);
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "failure",
      observedAt: now + 200,
    }),
  );
  lifecycle.recordReviewResult({
    ...identity,
    claimGeneration: 2,
    runId: "9391",
    runAttempt: 1,
    outcome: "cancelled",
    observedAt: now + 300,
  });
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "failure",
      observedAt: now + 400,
    }),
  );

  const snapshot = telemetry.baySnapshot(now + 1_000);
  assert.equal(snapshot.terminal?.terminal_count, 1);
  assert.equal(snapshot.terminal?.terminal_buffer[0]?.outcome, "cancelled");
  assert.equal(snapshot.terminal?.terminal_buffer[0]?.legacy_batch_path, false);
  assert.equal(snapshot.timings?.overall.samples, 1);
});

test("Bay lifecycle keeps failed legacy publishers out of the default direct view", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9392",
    fenceKey: "openclaw/openclaw#9392@publish:9392:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "failed-legacy-publication",
    sourceAction: "exact_review_artifact_publish",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now,
    observedAt: now,
  });
  lifecycle.recordReviewResult({
    ...identity,
    claimGeneration: 1,
    runId: "9392",
    runAttempt: 1,
    outcome: "failed",
    observedAt: now + 100,
  });
  recordBayFinalReceipt(lifecycle, identity, now + 200);
  telemetry.syncBayLifecycle(
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "failure",
      observedAt: now + 200,
    }),
  );

  const snapshot = telemetry.baySnapshot(now + 1_000);
  assert.equal(snapshot.terminal?.terminal_buffer[0]?.outcome, "failure");
  assert.equal(snapshot.terminal?.terminal_buffer[0]?.legacy_batch_path, true);
  assert.equal(snapshot.timings?.overall.samples, 0);
  assert.equal(snapshot.timings?.including_legacy_batch.overall.samples, 1);
});

test("Bay lifecycle telemetry migrates durable tide metadata", () => {
  const storage = new MemoryDurableStorage();
  const now = Date.now();
  storage.sql.exec(
    `CREATE TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE} (
       event_id TEXT PRIMARY KEY,
       canonical_target_key TEXT NOT NULL,
       fence_key TEXT NOT NULL,
       revision INTEGER NOT NULL CHECK (revision >= 1),
       outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
       triggered_at INTEGER NOT NULL,
       completed_at INTEGER NOT NULL
     ) STRICT`,
  );
  for (const [table, definition] of [
    [
      EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE,
      "singleton INTEGER PRIMARY KEY CHECK (singleton = 1), coverage_started_at INTEGER NOT NULL",
    ],
    [
      EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
      "singleton INTEGER PRIMARY KEY CHECK (singleton = 1), repository_scope TEXT NOT NULL, coverage_started_at INTEGER NOT NULL",
    ],
  ]) {
    storage.sql.exec(`CREATE TABLE ${table} (${definition}) STRICT`);
  }
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE} (singleton, coverage_started_at)
      VALUES (1, ?)`,
    now,
  );
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
       (singleton, repository_scope, coverage_started_at)
     VALUES (1, 'openclaw/openclaw', ?)`,
    now,
  );
  for (let index = 0; index <= TIDE; index += 1) {
    storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
         (event_id, canonical_target_key, fence_key, revision, outcome, triggered_at, completed_at)
       VALUES (?, ?, ?, 1, 'success', ?, ?)`,
      `migration:${index}`,
      `openclaw/openclaw#${9_400 + index}`,
      `openclaw/openclaw#${9_400 + index}@exact:1`,
      now + index * 1_000,
      now + index * 1_000 + 500,
    );
  }

  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  telemetry.ensureSchemaSync();
  for (const table of [
    EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE,
    EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE,
  ]) {
    const columns = new Set(
      Array.from(storage.sql.exec(`SELECT name FROM pragma_table_info('${table}')`)).map((row) =>
        String(row.name || ""),
      ),
    );
    assert.equal(columns.has("legacy_batch_path"), true);
  }
  for (const table of [
    EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE,
    EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
  ]) {
    const columns = new Set(
      Array.from(storage.sql.exec(`SELECT name FROM pragma_table_info('${table}')`)).map((row) =>
        String(row.name || ""),
      ),
    );
    assert.equal(columns.has("tide_base_count"), true);
    assert.equal(columns.has("last_tide_at"), true);
  }
  for (const snapshot of [
    telemetry.baySnapshot(now + 60_000),
    telemetry.baySnapshot(now + 60_000, new Set(["openclaw/openclaw"])),
  ]) {
    assert.equal(snapshot.terminal?.tide_generation, 1);
    assert.equal(snapshot.terminal?.terminal_count, 1);
    assert.equal(snapshot.terminal?.recently_washed.length, TIDE);
  }
});

test("Bay lifecycle migration recovers retained pre-v2 direct tide rows from their fence", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9421",
    fenceKey: "openclaw/openclaw#9421@publish:100:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "retained-direct-migration",
    sourceAction: "synchronize",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now - 60_000,
    observedAt: now - 60_000,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: `direct:${identity.fenceKey}:1:accepted`,
    observedAt: now,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "router-direct:100:1",
    observedAt: now,
  });
  storage.sql.exec(
    `CREATE TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE} (
       repository_scope TEXT NOT NULL,
       bucket TEXT NOT NULL CHECK (bucket IN ('terminal', 'washed')),
       event_id TEXT NOT NULL,
       canonical_target_key TEXT NOT NULL,
       outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
       triggered_at INTEGER NOT NULL,
       completed_at INTEGER NOT NULL,
       PRIMARY KEY (repository_scope, bucket, event_id)
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
       (repository_scope, bucket, event_id, canonical_target_key, outcome, triggered_at, completed_at)
     VALUES ('__all_repositories__', 'terminal', ?, ?, 'success', ?, ?)`,
    `bay:v2:${identity.fenceKey}:${identity.revision}`,
    identity.canonicalTargetKey,
    now - 60_000,
    now,
  );

  new ExactReviewLifecycleTelemetryStore(storage).ensureSchemaSync();

  const row = Array.from(
    storage.sql.exec(
      `SELECT legacy_batch_path
         FROM ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
        WHERE event_id = ?`,
      `bay:v2:${identity.fenceKey}:${identity.revision}`,
    ),
  )[0];
  assert.equal(row?.legacy_batch_path, 0);
});

test("Bay lifecycle repairs failed publishers after path migration and timing expiry", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9420",
    fenceKey: "openclaw/openclaw#9420@publish:99:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "failed-pre-v2-publisher",
    sourceAction: "exact_review_artifact_publish",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now - 60_000,
    observedAt: now - 60_000,
  });
  lifecycle.recordReviewResult({
    ...identity,
    claimGeneration: 1,
    runId: "9420",
    runAttempt: 1,
    outcome: "failed",
    observedAt: now,
  });
  recordBayFinalReceipt(lifecycle, identity, now);
  lifecycle.recordTerminalDisposition({ ...identity, kind: "failure", observedAt: now });
  storage.sql.exec(
    `CREATE TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE} (
       event_id TEXT PRIMARY KEY,
       canonical_target_key TEXT NOT NULL,
       fence_key TEXT NOT NULL,
       revision INTEGER NOT NULL CHECK (revision >= 1),
       outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
       triggered_at INTEGER NOT NULL,
       completed_at INTEGER NOT NULL,
       legacy_batch_path INTEGER NOT NULL CHECK (legacy_batch_path IN (0, 1))
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
       (event_id, canonical_target_key, fence_key, revision, outcome, triggered_at, completed_at,
        legacy_batch_path)
     VALUES (?, ?, ?, 1, 'failure', ?, ?, 0)`,
    `bay:v2:${identity.fenceKey}:${identity.revision}`,
    identity.canonicalTargetKey,
    identity.fenceKey,
    now - 60_000,
    now,
  );
  storage.sql.exec(
    `CREATE TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE} (
       repository_scope TEXT NOT NULL,
       bucket TEXT NOT NULL CHECK (bucket IN ('terminal', 'washed')),
       event_id TEXT NOT NULL,
       canonical_target_key TEXT NOT NULL,
       outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
       triggered_at INTEGER NOT NULL,
       completed_at INTEGER NOT NULL,
       legacy_batch_path INTEGER NOT NULL CHECK (legacy_batch_path IN (0, 1)),
       PRIMARY KEY (repository_scope, bucket, event_id)
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
       (repository_scope, bucket, event_id, canonical_target_key, outcome, triggered_at, completed_at,
        legacy_batch_path)
     VALUES ('__all_repositories__', 'terminal', ?, ?, 'failure', ?, ?, 0)`,
    `bay:v2:${identity.fenceKey}:${identity.revision}`,
    identity.canonicalTargetKey,
    now - 60_000,
    now,
  );

  new ExactReviewLifecycleTelemetryStore(storage).ensureSchemaSync();

  for (const table of [
    EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE,
    EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE,
  ]) {
    const row = Array.from(
      storage.sql.exec(
        `SELECT legacy_batch_path FROM ${table} WHERE event_id = ?`,
        `bay:v2:${identity.fenceKey}:${identity.revision}`,
      ),
    )[0];
    assert.equal(row?.legacy_batch_path, 1);
  }

  storage.sql.exec(
    `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE} WHERE event_id = ?`,
    `bay:v2:${identity.fenceKey}:${identity.revision}`,
  );
  storage.sql.exec(
    `UPDATE ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
        SET legacy_batch_path = 0
      WHERE event_id = ?`,
    `bay:v2:${identity.fenceKey}:${identity.revision}`,
  );
  new ExactReviewLifecycleTelemetryStore(storage).ensureSchemaSync();
  const retained = Array.from(
    storage.sql.exec(
      `SELECT legacy_batch_path
         FROM ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
        WHERE event_id = ?`,
      `bay:v2:${identity.fenceKey}:${identity.revision}`,
    ),
  )[0];
  assert.equal(retained?.legacy_batch_path, 1);
});

test("Bay lifecycle migration keeps every retained pre-v2 batch router variant legacy", () => {
  for (const [index, routerReceiptId] of [
    "router-batch:101:1",
    "router-batch-proof:101:1",
    "router-batch-not-required:101:1",
  ].entries()) {
    const storage = new MemoryDurableStorage();
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const now = Date.now();
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${9422 + index}`,
      fenceKey: `openclaw/openclaw#${9422 + index}@publish:101:1`,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: "retained-batch-migration",
      sourceAction: "synchronize",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now - 60_000,
      observedAt: now - 60_000,
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: "accepted",
      receiptId: `direct:${identity.fenceKey}:1:accepted`,
      observedAt: now,
    });
    lifecycle.recordRouterReceipt({
      ...identity,
      outcome: "durable",
      receiptId: routerReceiptId,
      observedAt: now,
    });
    storage.sql.exec(
      `CREATE TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE} (
       repository_scope TEXT NOT NULL,
       bucket TEXT NOT NULL CHECK (bucket IN ('terminal', 'washed')),
       event_id TEXT NOT NULL,
       canonical_target_key TEXT NOT NULL,
       outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
       triggered_at INTEGER NOT NULL,
       completed_at INTEGER NOT NULL,
       PRIMARY KEY (repository_scope, bucket, event_id)
     ) STRICT`,
    );
    storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
       (repository_scope, bucket, event_id, canonical_target_key, outcome, triggered_at, completed_at)
     VALUES ('__all_repositories__', 'terminal', ?, ?, 'success', ?, ?)`,
      `bay:v2:${identity.fenceKey}:${identity.revision}`,
      identity.canonicalTargetKey,
      now - 60_000,
      now,
    );

    new ExactReviewLifecycleTelemetryStore(storage).ensureSchemaSync();

    const row = Array.from(
      storage.sql.exec(
        `SELECT legacy_batch_path
         FROM ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
        WHERE event_id = ?`,
        `bay:v2:${identity.fenceKey}:${identity.revision}`,
      ),
    )[0];
    assert.equal(row?.legacy_batch_path, 1);
  }
});

test("Bay lifecycle migration does not reinterpret a retained routing-era marker as a final receipt", () => {
  const originalNow = Date.now;
  const startedAt = 2_000_000_000_000;
  let now = startedAt;
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const identity = {
      canonicalTargetKey: "openclaw/openclaw#9450",
      fenceKey: "openclaw/openclaw#9450@exact:1",
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: "legacy-idempotency",
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
    });
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now + 500,
    });
    // Model the legacy source after its prior timing write had completed.
    storage.sql.exec(
      `UPDATE exact_review_lifecycle_projection_v1
          SET bay_telemetry_pending = 0,
              projection_json = json_set(projection_json, '$.bayTelemetryPending', json('false'))
        WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      identity.canonicalTargetKey,
      identity.fenceKey,
      identity.revision,
    );
    storage.sql.exec(
      `CREATE TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE} (
         event_id TEXT PRIMARY KEY,
         canonical_target_key TEXT NOT NULL,
         fence_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
         triggered_at INTEGER NOT NULL,
         completed_at INTEGER NOT NULL
       ) STRICT`,
    );
    storage.sql.exec(
      `CREATE TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE} (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         coverage_started_at INTEGER NOT NULL
       ) STRICT`,
    );
    storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE} (singleton, coverage_started_at)
        VALUES (1, ?)`,
      now,
    );
    storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
         (event_id, canonical_target_key, fence_key, revision, outcome, triggered_at, completed_at)
       VALUES ('bay:openclaw/openclaw#9450@exact:1:1', ?, ?, 1, 'success', ?, ?)`,
      identity.canonicalTargetKey,
      identity.fenceKey,
      now,
      now + 500,
    );

    const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
    telemetry.ensureSchemaSync();
    const marked = lifecycle.read(
      identity.canonicalTargetKey,
      identity.fenceKey,
      identity.revision,
    )!;
    assert.equal(marked.bayTelemetryEventId, "bay:openclaw/openclaw#9450@exact:1:1");

    now += 31 * 24 * 60 * 60_000;
    assert.equal(telemetry.syncBayLifecycle(marked), true);
    assert.equal(telemetry.baySnapshot(now).terminal?.terminal_count, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("Bay lifecycle migration upgrades a legacy marker only when a final receipt is present", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9451",
    fenceKey: "openclaw/openclaw#9451@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "legacy-expired-idempotency",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now,
    observedAt: now,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: now + 500,
  });
  recordBayFinalReceipt(lifecycle, identity, now + 500);
  // Model the legacy source after its prior timing write had completed.
  storage.sql.exec(
    `UPDATE exact_review_lifecycle_projection_v1
        SET bay_telemetry_pending = 0,
            projection_json = json_set(projection_json, '$.bayTelemetryPending', json('false'))
      WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
    identity.canonicalTargetKey,
    identity.fenceKey,
    identity.revision,
  );
  storage.sql.exec(
    `CREATE TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE} (
       singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
       coverage_started_at INTEGER NOT NULL
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE} (singleton, coverage_started_at)
      VALUES (1, ?)`,
    now,
  );

  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  telemetry.ensureSchemaSync();
  const marked = lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!;
  assert.equal(marked.bayTelemetryEventId, "bay:openclaw/openclaw#9451@exact:1:1");
  assert.equal(telemetry.syncBayLifecycle(marked), true);
  assert.equal(telemetry.baySnapshot(now + 1_000).terminal?.terminal_count, 1);
});

test("Bay lifecycle migration leaves a pending terminal source available for recovery", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9452",
    fenceKey: "openclaw/openclaw#9452@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "migration-pending-terminal",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now,
    observedAt: now,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: now + 500,
  });
  recordBayFinalReceipt(lifecycle, identity, now + 500);

  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  telemetry.ensureSchemaSync();
  assert.equal(
    lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
      ?.bayTelemetryEventId,
    undefined,
  );
  assert.deepEqual(
    lifecycle.reconcileBayTelemetryPending((projection) => telemetry.syncBayLifecycle(projection)),
    { pending: false, progressed: true },
  );
  assert.equal(telemetry.baySnapshot(now + 1_000).terminal?.terminal_count, 1);
});

test("Bay lifecycle refreshes scope despite a lifecycle source beyond the public sample cap", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const priorScope = new Set(["openclaw/openclaw"]);
  telemetry.syncBayRepositoryScope(priorScope, now);
  lifecycle.recordAdmission({
    canonicalTargetKey: "openclaw/openclaw#9500",
    fenceKey: "openclaw/openclaw#9500@exact:1",
    revision: 1,
    deliveryId: "over-cap:base",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now,
    observedAt: now,
  });
  for (let index = 0; index < 10_000; index += 1) {
    storage.sql.exec(
      `INSERT INTO exact_review_lifecycle_projection_v1
         (canonical_target_key, revision, fence_key, projection_json, updated_at, bay_telemetry_pending)
       VALUES (?, 1, ?, '{}', ?, 0)`,
      `openclaw/openclaw#${9_600 + index}`,
      `openclaw/openclaw#${9_600 + index}@exact:1`,
      now + index + 1,
    );
  }

  assert.equal(telemetry.syncBayRepositoryScope(new Set(["openclaw/clawsweeper"]), now + 1), true);
  assert.equal(
    telemetry.baySnapshot(now + 1, new Set(["openclaw/clawsweeper"])).collection.state,
    "complete",
  );
  assert.equal(telemetry.baySnapshot(now + 1, priorScope).collection.state, "unknown");
});

test("Bay lifecycle rebuilds compact tide state from more than ten thousand completions", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  lifecycle.recordAdmission({
    canonicalTargetKey: "openclaw/openclaw#9599",
    fenceKey: "openclaw/openclaw#9599@exact:1",
    revision: 1,
    deliveryId: "source-rebuild-schema",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now,
    observedAt: now,
  });
  // Exceed ten thousand completions, ending one record past a tide boundary.
  const tideGenerations = Math.ceil(10_000 / TIDE);
  const completions = tideGenerations * TIDE + 1;
  for (let index = 0; index < completions; index += 1) {
    const canonicalTargetKey = `openclaw/openclaw#${20_000 + index}`;
    const fenceKey = `${canonicalTargetKey}@exact:1`;
    storage.sql.exec(
      `INSERT INTO exact_review_lifecycle_projection_v1
         (canonical_target_key, revision, fence_key, projection_json, updated_at, bay_telemetry_pending)
       VALUES (?, 1, ?, ?, ?, 0)`,
      canonicalTargetKey,
      fenceKey,
      JSON.stringify({
        version: 1,
        canonicalTargetKey,
        fenceKey,
        revision: 1,
        admission: { triggeredAt: now, admittedAt: now },
        githubEffect: { observedAt: now + index + 1 },
        reviewResults: [],
        terminalDisposition: { kind: "review_completed_routed", observedAt: now + index + 1 },
      }),
      now + index + 1,
    );
  }

  const publicScope = new Set(["openclaw/openclaw"]);
  assert.equal(telemetry.syncBayRepositoryScope(publicScope, now), true);
  const snapshot = telemetry.baySnapshot(now + 20_000, publicScope);
  assert.equal(snapshot.collection.state, "complete");
  assert.equal(snapshot.terminal?.tide_generation, tideGenerations);
  assert.equal(snapshot.terminal?.terminal_count, 1);
  assert.equal(snapshot.terminal?.recently_washed.length, TIDE);
  assert.equal(snapshot.terminal?.terminal_buffer.length, 1);
  assert.equal(
    snapshot.terminal?.last_tide_at,
    new Date(now + tideGenerations * TIDE).toISOString(),
  );
});

test("Bay lifecycle tide progress survives terminal-fact retention", () => {
  const originalNow = Date.now;
  const coverageStartedAt = 1_800_000_000_000;
  let now = coverageStartedAt;
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
    const publicScope = new Set(["openclaw/openclaw"]);
    telemetry.syncBayRepositoryScope(publicScope, now);
    for (let index = 0; index <= TIDE; index += 1) {
      const identity = {
        canonicalTargetKey: `openclaw/openclaw#${9_300 + index}`,
        fenceKey: `openclaw/openclaw#${9_300 + index}@exact:${index + 1}`,
        revision: index + 1,
      };
      const triggeredAt = coverageStartedAt + index * 1_000;
      lifecycle.recordAdmission({
        ...identity,
        deliveryId: `retention:${index}`,
        sourceAction: "opened",
        commandOriginated: false,
        statusMarker: null,
        statusCommentId: null,
        triggeredAt,
        observedAt: triggeredAt,
      });
      recordBayFinalReceipt(lifecycle, identity, triggeredAt + 500);
      telemetry.syncBayLifecycle(
        lifecycle.recordTerminalDisposition({
          ...identity,
          kind: "review_completed_routed",
          observedAt: triggeredAt + 500,
        }),
      );
    }

    now = coverageStartedAt + 31 * 24 * 60 * 60_000;
    const currentKey = `openclaw/openclaw#${9_300 + TIDE + 1}`;
    const currentIdentity = {
      canonicalTargetKey: currentKey,
      fenceKey: `${currentKey}@exact:${TIDE + 2}`,
      revision: TIDE + 2,
    };
    lifecycle.recordAdmission({
      ...currentIdentity,
      deliveryId: "retention:current",
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
    });
    recordBayFinalReceipt(lifecycle, currentIdentity, now + 500);
    telemetry.syncBayLifecycle(
      lifecycle.recordTerminalDisposition({
        ...currentIdentity,
        kind: "review_completed_routed",
        observedAt: now + 500,
      }),
    );
    // This revision has already been compacted by the unrelated current
    // completion above. A late requeue must still retract it from the tide.
    const requeuedKey = `openclaw/openclaw#${9_300 + TIDE}`;
    const requeuedIdentity = {
      canonicalTargetKey: requeuedKey,
      fenceKey: `${requeuedKey}@exact:${TIDE + 1}`,
      revision: TIDE + 1,
    };
    telemetry.syncBayLifecycle(
      lifecycle.recordTerminalDisposition({
        ...requeuedIdentity,
        kind: "requeue",
        observedAt: now + 750,
      }),
    );

    const snapshot = telemetry.baySnapshot(now + 1_000, publicScope);
    assert.equal(snapshot.terminal?.tide_generation, 1);
    assert.equal(snapshot.terminal?.terminal_count, 1);
    assert.equal(
      snapshot.terminal?.last_tide_at,
      new Date(coverageStartedAt + (TIDE - 1) * 1_000 + 500).toISOString(),
    );
  } finally {
    Date.now = originalNow;
  }
});

test("Bay lifecycle tide compaction is retry-safe after terminal deletion fails", () => {
  const originalNow = Date.now;
  const coverageStartedAt = 1_900_000_000_000;
  let now = coverageStartedAt;
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
    for (let index = 0; index < TIDE; index += 1) {
      const identity = {
        canonicalTargetKey: `openclaw/openclaw#${9_500 + index}`,
        fenceKey: `openclaw/openclaw#${9_500 + index}@exact:${index + 1}`,
        revision: index + 1,
      };
      const triggeredAt = coverageStartedAt + index * 1_000;
      lifecycle.recordAdmission({
        ...identity,
        deliveryId: `retry-safe:${index}`,
        sourceAction: "opened",
        commandOriginated: false,
        statusMarker: null,
        statusCommentId: null,
        triggeredAt,
        observedAt: triggeredAt,
      });
      recordBayFinalReceipt(lifecycle, identity, triggeredAt + 500);
      telemetry.syncBayLifecycle(
        lifecycle.recordTerminalDisposition({
          ...identity,
          kind: "review_completed_routed",
          observedAt: triggeredAt + 500,
        }),
      );
    }

    now = coverageStartedAt + 31 * 24 * 60 * 60_000;
    const currentKey = `openclaw/openclaw#${9_500 + TIDE}`;
    const currentIdentity = {
      canonicalTargetKey: currentKey,
      fenceKey: `${currentKey}@exact:${TIDE + 1}`,
      revision: TIDE + 1,
    };
    lifecycle.recordAdmission({
      ...currentIdentity,
      deliveryId: "retry-safe:current",
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
    });
    recordBayFinalReceipt(lifecycle, currentIdentity, now + 500);
    storage.sql.failNext(new RegExp(`DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}`));
    const current = lifecycle.recordTerminalDisposition({
      ...currentIdentity,
      kind: "review_completed_routed",
      observedAt: now + 500,
    });
    assert.equal(telemetry.syncBayLifecycle(current), false);
    assert.deepEqual(telemetry.reconcileBayLifecyclePending(), {
      pending: false,
      progressed: true,
    });

    const snapshot = telemetry.baySnapshot(now + 1_000);
    assert.equal(snapshot.terminal?.tide_generation, 1);
    assert.equal(snapshot.terminal?.terminal_count, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("Bay lifecycle source marker keeps expired terminal delivery idempotent", () => {
  const originalNow = Date.now;
  const startedAt = 1_950_000_000_000;
  let now = startedAt;
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
    const identity = {
      canonicalTargetKey: "openclaw/openclaw#9350",
      fenceKey: "openclaw/openclaw#9350@exact:1",
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: "expired-idempotence",
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
    });
    recordBayFinalReceipt(lifecycle, identity, now + 500);
    const completed = lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now + 500,
    });
    assert.equal(telemetry.syncBayLifecycle(completed), true);
    lifecycle.markBayTelemetryMaterialized(completed);
    assert.equal(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
        ?.bayTelemetryEventId,
      "bay:v2:openclaw/openclaw#9350@exact:1:1",
    );
    now += 31 * 24 * 60 * 60 * 1_000;
    const retried = lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: startedAt + 500,
    });
    assert.equal(telemetry.syncBayLifecycle(retried), true);
    lifecycle.markBayTelemetryMaterialized(retried);
    const snapshot = telemetry.baySnapshot(now);
    assert.equal(snapshot.terminal?.tide_generation, 0);
    assert.equal(snapshot.terminal?.terminal_count, 1);
    assert.equal(snapshot.terminal?.terminal_buffer.length, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("Bay lifecycle replays a stale telemetry outbox from its marked source", () => {
  const originalNow = Date.now;
  const startedAt = 1_955_000_000_000;
  let now = startedAt;
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
    const identity = {
      canonicalTargetKey: "openclaw/openclaw#9351",
      fenceKey: "openclaw/openclaw#9351@exact:1",
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: "stale-outbox-source",
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now,
    });
    recordBayFinalReceipt(lifecycle, identity, now + 500);
    const completed = lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now + 500,
    });
    assert.equal(telemetry.syncBayLifecycle(completed), true);
    lifecycle.markBayTelemetryMaterialized(completed);
    const marked = lifecycle.read(
      identity.canonicalTargetKey,
      identity.fenceKey,
      identity.revision,
    )!;
    const staleOutboxProjection = structuredClone(marked);
    delete staleOutboxProjection.bayTelemetryEventId;
    storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE}
         (canonical_target_key, fence_key, revision, projection_json, queued_at)
       VALUES (?, ?, ?, ?, ?)`,
      identity.canonicalTargetKey,
      identity.fenceKey,
      identity.revision,
      JSON.stringify(staleOutboxProjection),
      now,
    );

    now += 31 * 24 * 60 * 60 * 1_000;
    assert.deepEqual(telemetry.reconcileBayLifecyclePending(), {
      pending: false,
      progressed: true,
    });
    const snapshot = telemetry.baySnapshot(now);
    assert.equal(snapshot.terminal?.terminal_count, 1);
    assert.equal(snapshot.terminal?.tide_generation, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("Bay lifecycle accepts a marker generated from a maximum-length fence key", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const revision = Number.MAX_SAFE_INTEGER;
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9352",
    fenceKey: "f".repeat(512),
    revision,
  };
  const now = Date.now();
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "maximum-length-fence",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now,
    observedAt: now,
  });
  recordBayFinalReceipt(lifecycle, identity, now + 500);
  const completed = lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: now + 500,
  });
  assert.equal(telemetry.syncBayLifecycle(completed), true);
  lifecycle.markBayTelemetryMaterialized(completed);
  const marked = lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!;
  assert.equal(marked.bayTelemetryEventId?.length, 536);
  assert.equal(telemetry.baySnapshot(now + 1_000).terminal?.terminal_count, 1);
});

test("Bay lifecycle terminal facts queue a durable retry when metrics cannot materialize", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9249",
    fenceKey: "openclaw/openclaw#9249@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "metric-atomicity",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now - 1_000,
    observedAt: now - 1_000,
  });
  telemetry.baySnapshot(now);
  storage.sql.failNext(new RegExp(`INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}`));
  recordBayFinalReceipt(lifecycle, identity, now);
  const completed = lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: now,
  });
  assert.equal(telemetry.syncBayLifecycle(completed), false);
  assert.equal(
    lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
      ?.terminalDisposition?.kind,
    "review_completed_routed",
  );
  assert.equal(
    lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
      ?.bayTelemetryPending,
    true,
  );
  // The queue alarm repairs the retained outbox fact; the public metrics read
  // stays observer-only while recovery is pending.
  assert.equal(telemetry.hasBayLifecyclePending(), true);
  storage.sql.failNext(new RegExp(`INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}`));
  assert.deepEqual(telemetry.reconcileBayLifecyclePending(), {
    pending: true,
    progressed: false,
  });
  assert.deepEqual(telemetry.reconcileBayLifecyclePending(), {
    pending: false,
    progressed: true,
  });
  assert.equal(telemetry.baySnapshot(now).terminal?.terminal_count, 1);
});

test("Bay lifecycle terminal facts recover after telemetry outbox persistence fails", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9248",
    fenceKey: "openclaw/openclaw#9248@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "pending-recovery",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now - 1_000,
    observedAt: now - 1_000,
  });
  telemetry.baySnapshot(now);
  storage.sql.failNext(/INSERT INTO exact_review_lifecycle_bay_pending_v2/);
  recordBayFinalReceipt(lifecycle, identity, now);
  const completed = lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: now,
  });
  assert.equal(telemetry.syncBayLifecycle(completed), false);
  assert.equal(
    lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
      ?.terminalDisposition?.kind,
    "review_completed_routed",
  );
  assert.equal(
    lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
      ?.bayTelemetryPending,
    true,
  );
  assert.deepEqual(
    lifecycle.reconcileBayTelemetryPending((projection) => telemetry.syncBayLifecycle(projection)),
    { pending: false, progressed: true },
  );
  assert.equal(
    lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
      ?.bayTelemetryPending,
    false,
  );
  assert.equal(telemetry.baySnapshot(now).terminal?.terminal_count, 1);
});

test("Bay lifecycle retains its outbox until the source marker commits", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9247",
    fenceKey: "openclaw/openclaw#9247@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "source-marker-recovery",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now - 1_000,
    observedAt: now - 1_000,
  });
  telemetry.baySnapshot(now);
  storage.sql.failNext(/UPDATE exact_review_lifecycle_projection_v1/);
  recordBayFinalReceipt(lifecycle, identity, now);
  const completed = lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: now,
  });
  assert.equal(telemetry.syncBayLifecycle(completed), false);
  assert.equal(
    lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
      ?.bayTelemetryPending,
    true,
  );
  assert.equal(telemetry.hasBayLifecyclePending(), true);
  assert.equal(telemetry.baySnapshot(now).collection.state, "unknown");
  assert.deepEqual(telemetry.reconcileBayLifecyclePending(), {
    pending: false,
    progressed: true,
  });
  assert.equal(
    lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
      ?.bayTelemetryPending,
    false,
  );
  assert.equal(telemetry.baySnapshot(now).terminal?.terminal_count, 1);
});

test("Bay lifecycle recovery drains source markers in bounded batches", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  telemetry.baySnapshot(now);
  for (let index = 0; index < 257; index += 1) {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${9_300 + index}`,
      fenceKey: `openclaw/openclaw#${9_300 + index}@exact:1`,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `pending-batch:${index}`,
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now - 1_000,
      observedAt: now - 1_000,
    });
    recordBayFinalReceipt(lifecycle, identity, now);
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now,
    });
  }
  assert.deepEqual(
    lifecycle.reconcileBayTelemetryPending((projection) => telemetry.syncBayLifecycle(projection)),
    { pending: true, progressed: true },
  );
  assert.deepEqual(
    lifecycle.reconcileBayTelemetryPending((projection) => telemetry.syncBayLifecycle(projection)),
    { pending: false, progressed: true },
  );
  const recovered = telemetry.baySnapshot(now);
  assert.equal(recovered.collection.state, "complete");
  assert.equal(recovered.terminal?.tide_generation, Math.floor(257 / TIDE));
  assert.equal(recovered.terminal?.terminal_count, 257 % TIDE);
});

test("Bay lifecycle recovery reports no progress for malformed and unmaterialized sources", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#9557",
    fenceKey: "openclaw/openclaw#9557@exact:1",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "no-progress-source",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now,
    observedAt: now,
  });
  lifecycle.markBayTelemetryPending(identity);
  assert.deepEqual(
    lifecycle.reconcileBayTelemetryPending(() => false),
    {
      pending: true,
      progressed: false,
    },
  );

  storage.sql.exec(
    `UPDATE ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
        SET projection_json = ?
      WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
    "{",
    identity.canonicalTargetKey,
    identity.fenceKey,
    identity.revision,
  );
  assert.deepEqual(
    lifecycle.reconcileBayTelemetryPending((projection) => telemetry.syncBayLifecycle(projection)),
    { pending: true, progressed: false },
  );
  telemetry.ensureSchemaSync();
  storage.sql.exec(
    `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE}
       (canonical_target_key, fence_key, revision, projection_json, queued_at)
     VALUES (?, ?, ?, ?, ?)`,
    identity.canonicalTargetKey,
    identity.fenceKey,
    identity.revision,
    "{",
    now,
  );
  assert.deepEqual(telemetry.reconcileBayLifecyclePending(), {
    pending: true,
    progressed: false,
  });
});

test("Bay lifecycle recovery retains progress before a later outbox read fails", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  const now = Date.now();
  telemetry.ensureSchemaSync();
  for (let index = 0; index < 2; index += 1) {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${9_560 + index}`,
      fenceKey: `openclaw/openclaw#${9_560 + index}@exact:1`,
      revision: 1,
    };
    const projection = lifecycle.recordAdmission({
      ...identity,
      deliveryId: `partial-outbox:${index}`,
      sourceAction: "opened",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      triggeredAt: now,
      observedAt: now + index,
    });
    storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE}
         (canonical_target_key, fence_key, revision, projection_json, queued_at)
       VALUES (?, ?, ?, ?, ?)`,
      identity.canonicalTargetKey,
      identity.fenceKey,
      identity.revision,
      JSON.stringify(projection),
      now + index,
    );
  }
  const exec = storage.sql.exec.bind(storage.sql);
  let sourceReads = 0;
  storage.sql.exec = (query: string, ...bindings: unknown[]) => {
    if (
      /SELECT projection_json FROM exact_review_lifecycle_projection_v1\s+WHERE canonical_target_key/.test(
        query,
      ) &&
      ++sourceReads === 2
    ) {
      throw new Error("injected later source read failure");
    }
    return exec(query, ...bindings);
  };
  assert.deepEqual(telemetry.reconcileBayLifecyclePending(), {
    pending: true,
    progressed: true,
  });
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
  assert.equal(projection?.bayTelemetryPending, false);
});

test("Bay reconciles fenced completion delivery, legacy journeys, and same-second orphans", () => {
  const generatedAt = "2026-08-03T12:00:06.000Z";
  const completedAt = "2026-08-03T12:00:05.000Z";
  const triggers = ["delivery-a", "delivery-b"].map((sourceDeliveryId, index) => ({
    repository: "openclaw/openclaw",
    number: 917,
    source_comment_id: 555,
    source_delivery_id: sourceDeliveryId,
    triggered_at: `2026-08-03T12:00:0${index}.000Z`,
  }));
  const completion = {
    repository: "openclaw/openclaw",
    number: 917,
    source_comment_id: 555,
    completed_at: completedAt,
    completion_comment_id: 9302,
  };

  for (const order of ["webhook-first", "receipt-first"] as const) {
    let state = mergeBayJourneyState(null, triggers, [], generatedAt);
    for (const source of order === "webhook-first"
      ? ["webhook", "receipt"]
      : ["receipt", "webhook"]) {
      state = mergeBayJourneyState(
        state,
        [],
        [
          {
            ...completion,
            ...(source === "receipt" ? { source_delivery_id: "delivery-a" } : {}),
          },
        ],
        generatedAt,
      );
    }
    const older = state.journeys.find((journey) => journey.source_delivery_id === "delivery-a");
    const newer = state.journeys.find((journey) => journey.source_delivery_id === "delivery-b");
    assert.equal(older?.completed_at, completedAt, order);
    assert.equal(newer?.completed_at, null, order);
    assert.equal(bayJourneyTimingSnapshot(state.journeys, generatedAt).overall.samples, 1, order);
  }

  const legacy = mergeBayJourneyState(
    {
      schema_version: 1,
      journeys: [
        {
          id: "openclaw/openclaw#917:command:555:at:1785758400000",
          item_key: "openclaw/openclaw#917",
          repository: "openclaw/openclaw",
          number: 917,
          source_comment_id: 555,
          triggered_at: "2026-08-03T12:00:00.000Z",
          completed_at: null,
          completion_kind: null,
          completion_comment_id: null,
        },
      ],
    },
    [],
    [{ ...completion, source_delivery_id: "delivery-a" }],
    generatedAt,
  );
  assert.equal(legacy.journeys.length, 1);
  assert.equal(legacy.journeys[0]?.completed_at, completedAt);

  const orphaned = mergeBayJourneyState(
    null,
    [],
    [
      { ...completion, source_delivery_id: "delivery-a" },
      { ...completion, source_delivery_id: "delivery-b" },
    ],
    generatedAt,
  );
  assert.equal(orphaned.journeys.length, 2);
  assert.notEqual(orphaned.journeys[0]?.id, orphaned.journeys[1]?.id);
  const resolved = mergeBayJourneyState(orphaned, triggers, [], generatedAt);
  assert.equal(resolved.journeys.length, 2);
  assert.equal(
    resolved.journeys.filter((journey) => journey.completed_at === completedAt).length,
    2,
  );

  const identifiedOrphan = mergeBayJourneyState(
    null,
    [],
    [{ ...completion, source_delivery_id: "delivery-a" }],
    generatedAt,
  );
  const legacyTrigger = mergeBayJourneyState(
    identifiedOrphan,
    [{ ...triggers[0], source_delivery_id: undefined }],
    [],
    generatedAt,
  );
  assert.equal(legacyTrigger.journeys.length, 1);
  assert.equal(legacyTrigger.journeys[0]?.completed_at, completedAt);
  assert.equal(bayJourneyTimingSnapshot(legacyTrigger.journeys, generatedAt).overall.samples, 1);

  let legacyThenTagged = mergeBayJourneyState(
    null,
    [{ ...triggers[0], source_delivery_id: undefined }],
    [],
    generatedAt,
  );
  legacyThenTagged = mergeBayJourneyState(legacyThenTagged, [], [completion], generatedAt);
  legacyThenTagged = mergeBayJourneyState(legacyThenTagged, [triggers[0]], [], generatedAt);
  legacyThenTagged = mergeBayJourneyState(
    legacyThenTagged,
    [],
    [{ ...completion, source_delivery_id: "delivery-a" }],
    generatedAt,
  );
  legacyThenTagged = mergeBayJourneyState(legacyThenTagged, [], [], generatedAt);
  assert.equal(legacyThenTagged.journeys.length, 2);
  assert.equal(
    legacyThenTagged.journeys.find((journey) => journey.source_delivery_id === "delivery-a")
      ?.completed_at,
    completedAt,
  );
  assert.equal(
    legacyThenTagged.journeys.find((journey) => !journey.source_delivery_id)?.completed_at,
    null,
  );
  assert.equal(bayJourneyTimingSnapshot(legacyThenTagged.journeys, generatedAt).overall.samples, 1);

  const newerCompletion = {
    ...completion,
    completed_at: "2026-08-03T12:00:05.500Z",
    completion_comment_id: 9303,
    source_delivery_id: "delivery-b",
  };
  const events = [
    { triggers: [triggers[0]], completions: [] },
    { triggers: [triggers[1]], completions: [] },
    { triggers: [], completions: [completion] },
    { triggers: [], completions: [newerCompletion] },
    { triggers: [], completions: [{ ...completion, source_delivery_id: "delivery-a" }] },
  ];
  function* permutations<T>(values: T[]): Generator<T[]> {
    if (values.length === 0) {
      yield [];
      return;
    }
    for (let index = 0; index < values.length; index += 1) {
      for (const tail of permutations(values.filter((_value, position) => position !== index))) {
        yield [values[index]!, ...tail];
      }
    }
  }
  for (const [index, order] of [...permutations(events)].entries()) {
    let state = null;
    for (const event of order) {
      state = mergeBayJourneyState(state, event.triggers, event.completions, generatedAt);
    }
    const older = state!.journeys.find((journey) => journey.source_delivery_id === "delivery-a");
    const newer = state!.journeys.find((journey) => journey.source_delivery_id === "delivery-b");
    assert.equal(state!.journeys.length, 2, `permutation ${index}`);
    assert.equal(older?.completed_at, completedAt, `older permutation ${index}`);
    assert.equal(newer?.completed_at, newerCompletion.completed_at, `newer permutation ${index}`);
    assert.equal(
      bayJourneyTimingSnapshot(state!.journeys, generatedAt).overall.samples,
      2,
      `samples permutation ${index}`,
    );
  }
});

test("Bay transfers a stolen legacy completion when the correct fenced completion arrives", () => {
  const generatedAt = "2026-08-03T12:00:20.000Z";
  const shared = {
    repository: "openclaw/openclaw",
    number: 917,
    source_comment_id: 555,
  };
  const modernTrigger = {
    ...shared,
    source_delivery_id: "modern-a",
    triggered_at: "2026-08-03T12:00:01.000Z",
  };
  const legacyTrigger = {
    ...shared,
    source_delivery_id: "legacy-b",
    triggered_at: "2026-08-03T12:00:02.000Z",
  };
  const legacyCompletion = {
    ...shared,
    completed_at: "2026-08-03T12:00:07.000Z",
    completion_comment_id: 9301,
  };
  const modernCompletion = {
    ...shared,
    source_delivery_id: "modern-a",
    completed_at: "2026-08-03T12:00:08.000Z",
    completion_comment_id: 9301,
  };

  let state = mergeBayJourneyState(null, [modernTrigger], [], generatedAt);
  state = mergeBayJourneyState(state, [], [legacyCompletion], generatedAt);
  state = mergeBayJourneyState(state, [], [modernCompletion], generatedAt);
  state = mergeBayJourneyState(state, [legacyTrigger], [], generatedAt);

  assert.equal(
    state.journeys.find((journey) => journey.source_delivery_id === "modern-a")?.completed_at,
    modernCompletion.completed_at,
  );
  assert.equal(
    state.journeys.find((journey) => journey.source_delivery_id === "legacy-b")?.completed_at,
    legacyCompletion.completed_at,
  );
  assert.equal(bayJourneyTimingSnapshot(state.journeys, generatedAt).overall.samples, 2);
});

test("Bay prefers a delivery-matched orphan over an earlier anonymous completion", () => {
  const generatedAt = "2026-08-03T12:00:30.000Z";
  const shared = {
    repository: "openclaw/openclaw",
    number: 917,
    source_comment_id: 555,
  };
  const identifiedCompletion = {
    ...shared,
    source_delivery_id: "delivery-a",
    completed_at: "2026-08-03T12:00:08.000Z",
    completion_comment_id: 9302,
  };
  const earlierAnonymousCompletion = {
    ...shared,
    completed_at: "2026-08-03T12:00:05.000Z",
    completion_comment_id: 9301,
  };
  const trigger = {
    ...shared,
    source_delivery_id: "delivery-a",
    triggered_at: "2026-08-03T12:00:01.000Z",
  };

  const orphaned = mergeBayJourneyState(
    null,
    [],
    [identifiedCompletion, earlierAnonymousCompletion],
    generatedAt,
  );
  const resolved = mergeBayJourneyState(orphaned, [trigger], [], generatedAt);

  assert.equal(
    resolved.journeys.find((journey) => journey.source_delivery_id === "delivery-a")?.completed_at,
    identifiedCompletion.completed_at,
  );
  assert.equal(
    resolved.journeys.find((journey) => !journey.source_delivery_id)?.completed_at,
    earlierAnonymousCompletion.completed_at,
  );
});

test("Bay reassigns a displaced anonymous completion once its sole journey is identifiable", () => {
  const generatedAt = "2026-08-03T12:00:30.000Z";
  const shared = {
    repository: "openclaw/openclaw",
    number: 917,
    source_comment_id: 555,
  };
  const modernTrigger = {
    ...shared,
    source_delivery_id: "delivery-a",
    triggered_at: "2026-08-03T12:00:01.000Z",
  };
  const legacyTrigger = {
    ...shared,
    source_delivery_id: "delivery-b",
    triggered_at: "2026-08-03T12:00:02.000Z",
  };
  const anonymousCompletion = {
    ...shared,
    completed_at: "2026-08-03T12:00:06.000Z",
    completion_comment_id: 9311,
  };
  const fencedCompletion = {
    ...shared,
    source_delivery_id: "delivery-a",
    completed_at: "2026-08-03T12:00:05.000Z",
    completion_comment_id: 9310,
  };

  let state = mergeBayJourneyState(null, [modernTrigger], [], generatedAt);
  state = mergeBayJourneyState(state, [], [anonymousCompletion], generatedAt);
  state = mergeBayJourneyState(state, [legacyTrigger], [], generatedAt);
  state = mergeBayJourneyState(state, [], [fencedCompletion], generatedAt);

  assert.equal(
    state.journeys.find((journey) => journey.source_delivery_id === "delivery-a")?.completed_at,
    fencedCompletion.completed_at,
  );
  assert.equal(
    state.journeys.find((journey) => journey.source_delivery_id === "delivery-b")?.completed_at,
    anonymousCompletion.completed_at,
  );
  assert.equal(bayJourneyTimingSnapshot(state.journeys, generatedAt).overall.samples, 2);
});

test("Bay keeps the newest fenced completion received before its trigger", () => {
  const generatedAt = "2026-08-03T12:00:30.000Z";
  const shared = {
    repository: "openclaw/openclaw",
    number: 917,
    source_comment_id: 555,
    source_delivery_id: "delivery-a",
  };
  const first = {
    ...shared,
    completed_at: "2026-08-03T12:00:05.000Z",
    completion_comment_id: 9310,
  };
  const newer = {
    ...shared,
    completed_at: "2026-08-03T12:00:06.000Z",
    completion_comment_id: 9311,
  };
  const trigger = { ...shared, triggered_at: "2026-08-03T12:00:01.000Z" };

  for (const completions of [
    [first, newer],
    [newer, first],
  ]) {
    let state = mergeBayJourneyState(null, [], completions, generatedAt);
    state = mergeBayJourneyState(state, [trigger], [], generatedAt);
    assert.equal(state.journeys.length, 1);
    assert.equal(state.journeys[0]?.completed_at, newer.completed_at);
    assert.equal(state.journeys[0]?.completion_comment_id, newer.completion_comment_id);
  }
});

test("same-second fenced completions deterministically retain the newest comment identity", () => {
  const generatedAt = "2026-08-03T12:00:30.000Z";
  const shared = {
    repository: "openclaw/openclaw",
    number: 917,
    source_comment_id: 555,
    source_delivery_id: "delivery-a",
  };
  const trigger = { ...shared, triggered_at: "2026-08-03T12:00:01.000Z" };
  const completedAt = "2026-08-03T12:00:05.000Z";
  const first = { ...shared, completed_at: completedAt, completion_comment_id: 9310 };
  const second = { ...shared, completed_at: completedAt, completion_comment_id: 9311 };

  for (const completions of [
    [first, second],
    [second, first],
  ]) {
    let state = mergeBayJourneyState(null, [trigger], [], generatedAt);
    for (const completion of completions) {
      state = mergeBayJourneyState(state, [], [completion], generatedAt);
    }
    assert.equal(state.journeys.length, 1);
    assert.equal(state.journeys[0]?.completed_at, completedAt);
    assert.equal(state.journeys[0]?.completion_comment_id, second.completion_comment_id);
  }
});

test("verified unchanged legacy receipts complete Bay journeys without a webhook", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const statusStore = new MemoryKv();
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
  await statusStore.put(
    "openclaw-bay:journey-state:v1",
    JSON.stringify(
      mergeBayJourneyState(
        null,
        [
          {
            repository: "openclaw/openclaw",
            number: 918,
            source_comment_id: 558,
            source_delivery_id: "older-legacy-delivery",
            triggered_at: new Date(now - 10).toISOString(),
          },
          {
            repository: "openclaw/openclaw",
            number: 918,
            source_comment_id: 558,
            source_delivery_id: "unchanged-legacy-delivery",
            triggered_at: new Date(now).toISOString(),
          },
        ],
        [],
        new Date(now).toISOString(),
      ),
    ),
  );

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
    STATUS_STORE: statusStore,
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
  const journeys = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1"))!).journeys;
  const completed = journeys.find(
    (journey) => journey.source_delivery_id === "unchanged-legacy-delivery",
  );
  const older = journeys.find((journey) => journey.source_delivery_id === "older-legacy-delivery");
  assert.equal(journeys.length, 2);
  assert.equal(completed.completion_comment_id, 9501);
  assert.equal(completed.completed_at, completedAt);
  assert.equal(older.completed_at, null);
});

test("migrated modern acknowledgement receipts preserve the webhook completion identity", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const statusStore = new MemoryKv();
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
  await statusStore.put(
    "openclaw-bay:journey-state:v1",
    JSON.stringify(
      mergeBayJourneyState(
        null,
        [
          {
            repository: "openclaw/openclaw",
            number: 916,
            source_comment_id: 556,
            source_delivery_id: "older-modern-delivery",
            triggered_at: new Date(now - 10).toISOString(),
          },
          {
            repository: "openclaw/openclaw",
            number: 916,
            source_comment_id: 556,
            source_delivery_id: "modern-migration-delivery",
            triggered_at: new Date(now).toISOString(),
          },
        ],
        [],
        new Date(now).toISOString(),
      ),
    ),
  );

  const secret = "modern-migration-secret";
  const completedAt = new Date(now + 5).toISOString();
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    STATUS_STORE: statusStore,
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
  assert.equal((await webhook.json()).reason, "recorded Bay journey completion");

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
  const journeys = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1"))!).journeys;
  const completed = journeys.find(
    (journey) => journey.source_delivery_id === "modern-migration-delivery",
  );
  const older = journeys.find((journey) => journey.source_delivery_id === "older-modern-delivery");
  assert.equal(journeys.length, 2);
  assert.equal(completed.completed_at, completedAt);
  assert.equal(older.completed_at, null);
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
  const telemetryStore = (
    queue as unknown as {
      lifecycleTelemetryStore: { syncBayLifecycle(projection: unknown): boolean };
    }
  ).lifecycleTelemetryStore;
  const originalSyncBayLifecycle = telemetryStore.syncBayLifecycle;
  telemetryStore.syncBayLifecycle = () => false;
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
  assert.equal(projection?.bayTelemetryPending, true);
  telemetryStore.syncBayLifecycle = originalSyncBayLifecycle;
  await queue.alarm();
  assert.equal(
    projectionStore.read("openclaw/openclaw#782", leased.key, 1)?.bayTelemetryPending,
    false,
  );
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
  const queue = new ExactReviewQueue({ storage }, { STATE_SNAPSHOTS: bucket });
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
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
  const overviewPage = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/"), {});
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
  assert.doesNotMatch(await overviewPage.text(), /href="\/bay"/);
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

test("OpenClaw Bay shares a bounded 20-outcome tide buffer", () => {
  const attempts = Array.from({ length: 20 }, (_, index) => ({
    run_id: index + 1,
    job_id: 1000 + index,
    repository: "openclaw/openclaw",
    item_numbers: [9000 + index],
    outcome: index === 18 ? "failure" : index === 19 ? "cancelled" : "success",
    terminal_outcome: index === 18 ? "failure" : index === 19 ? "cancelled" : "success",
    workflow_title: `Review event item openclaw/openclaw#${9000 + index}`,
    completed_at: `2026-07-10T20:00:${String(index).padStart(2, "0")}Z`,
  }));
  const beforeTide = mergeBayTerminalState(null, attempts.slice(0, 19), [], "2026-07-10T20:00:19Z");
  assert.equal(beforeTide.terminal_count, 19);
  assert.equal(beforeTide.tide_generation, 0);
  assert.equal(beforeTide.recently_washed.length, 0);

  const tide = mergeBayTerminalState(beforeTide, attempts, [], "2026-07-10T20:00:20Z");
  assert.equal(tide.terminal_count, 0);
  assert.equal(tide.tide_generation, 1);
  assert.equal(tide.recently_washed.length, 20);
  assert.equal(tide.last_tide_at, "2026-07-10T20:00:19Z");
  assert.equal(tide.terminal_window_started_at, "2026-07-10T20:00:19Z");
  assert.deepEqual(tide.terminal_window_event_ids, [
    "worker:20:1019:openclaw/openclaw#9019:cancelled:2026-07-10T20:00:19Z",
  ]);
  assert.deepEqual(
    tide.recently_washed.slice(-2).map((item: { outcome: string }) => item.outcome),
    ["failure", "cancelled"],
  );

  const staleAfterTide = {
    ...attempts[0],
    run_id: 10_001,
    job_id: 20_001,
    completed_at: "2026-07-10T20:00:18Z",
  };
  const distinctBoundaryEvent = {
    ...attempts[0],
    run_id: 10_003,
    job_id: 20_003,
    item_numbers: [9_999],
    completed_at: "2026-07-10T20:00:19Z",
  };
  const freshAfterTide = {
    ...attempts[0],
    run_id: 10_002,
    job_id: 20_002,
    completed_at: "2026-07-10T20:00:21Z",
  };
  const afterTide = mergeBayTerminalState(
    tide,
    [staleAfterTide, distinctBoundaryEvent, freshAfterTide],
    [],
    "2026-07-10T20:00:21Z",
  );
  assert.deepEqual(
    afterTide.terminal_buffer.map((item: { run_id: number }) => item.run_id),
    [10_003, 10_002],
  );
  assert.equal(
    afterTide.seen_events.some((item: { event_id: string }) => item.event_id.includes(":10001:")),
    false,
  );
  const boundaryReplay = mergeBayTerminalState(
    { ...tide, seen_events: [] },
    attempts.slice(-1),
    [],
    "2026-07-10T20:00:21Z",
  );
  assert.equal(boundaryReplay.terminal_count, 0);

  const burst = Array.from({ length: 50 }, (_, index) => ({
    run_id: 2000 + index,
    job_id: 3000 + index,
    repository: "openclaw/openclaw",
    item_numbers: [10_000 + index],
    outcome: "success",
    terminal_outcome: "success",
    workflow_title: `Review event item openclaw/openclaw#${10_000 + index}`,
    completed_at: `2026-07-10T21:00:${String(index).padStart(2, "0")}Z`,
  }));
  const burstTides = mergeBayTerminalState(null, burst, [], "2026-07-10T21:00:50Z");
  assert.equal(burstTides.tide_generation, 2);
  assert.equal(burstTides.terminal_count, 10);
  assert.equal(burstTides.recently_washed.length, 20);
  assert.equal(burstTides.terminal_window_started_at, "2026-07-10T21:00:39Z");
  assert.deepEqual(
    burstTides.terminal_buffer.map((item: { number: number }) => item.number),
    Array.from({ length: 10 }, (_, index) => 10_040 + index),
  );
  const retainedBurstTail = mergeBayTerminalState(burstTides, [], [], "2026-07-10T21:00:51Z");
  assert.deepEqual(
    retainedBurstTail.terminal_buffer.map((item: { number: number }) => item.number),
    Array.from({ length: 10 }, (_, index) => 10_040 + index),
  );

  const deferredWhileActive = mergeBayTerminalState(
    null,
    attempts.slice(0, 1),
    [],
    "2026-07-10T20:00:00.500Z",
    ["openclaw/openclaw#9000"],
  );
  assert.equal(deferredWhileActive.terminal_count, 0);
  assert.equal(deferredWhileActive.seen_events.length, 0);
  const visibleAfterActiveFeedSettles = mergeBayTerminalState(
    deferredWhileActive,
    attempts.slice(0, 1),
    [],
    "2026-07-10T20:00:01Z",
  );
  assert.equal(visibleAfterActiveFeedSettles.terminal_count, 1);
  assert.equal(visibleAfterActiveFeedSettles.seen_events.length, 1);

  const replay = mergeBayTerminalState(tide, attempts, [], "2026-07-10T20:00:30Z");
  assert.equal(replay.terminal_count, 0);
  assert.equal(replay.tide_generation, 1);

  const nextRun = {
    ...attempts[0],
    run_id: 101,
    job_id: 1101,
    completed_at: "2026-07-10T20:00:31Z",
  };
  const nextBuffer = mergeBayTerminalState(replay, [nextRun], [], "2026-07-10T20:00:31Z");
  assert.equal(nextBuffer.terminal_count, 1);
  assert.equal(nextBuffer.terminal_buffer[0].number, 9000);

  const terminalBeforeRetrigger = mergeBayTerminalState(
    null,
    attempts.slice(0, 2),
    [],
    "2026-07-10T20:00:02Z",
  );
  const activeAgain = mergeBayTerminalState(
    terminalBeforeRetrigger,
    attempts.slice(0, 2),
    [],
    "2026-07-10T20:00:03Z",
    ["openclaw/openclaw#9000"],
  );
  assert.equal(activeAgain.terminal_count, 1);
  assert.deepEqual(
    activeAgain.terminal_buffer.map((item: { number: number }) => item.number),
    [9001],
  );
  assert.equal(activeAgain.seen_events.length, 2);
  const reterminal = mergeBayTerminalState(activeAgain, [nextRun], [], "2026-07-10T20:00:31Z");
  assert.equal(reterminal.terminal_count, 2);
  assert.deepEqual(
    reterminal.terminal_buffer.map((item: { number: number }) => item.number),
    [9001, 9000],
  );

  const ancillaryFailure = mergeBayTerminalState(
    null,
    [
      {
        run_id: 301,
        job_id: 401,
        repository: "openclaw/openclaw",
        item_numbers: [12_345],
        outcome: "failure",
        terminal_outcome: "success",
        workflow_title: "Review with a non-terminal ancillary step failure",
        completed_at: "2026-07-10T20:00:40Z",
      },
    ],
    [],
    "2026-07-10T20:00:40Z",
  );
  assert.equal(ancillaryFailure.terminal_buffer[0].outcome, "success");

  const expiredWash = mergeBayTerminalState(replay, attempts, [], "2026-07-10T20:01:21Z");
  assert.equal(expiredWash.tide_generation, 1);
  assert.equal(expiredWash.recently_washed.length, 0);

  const legacyNoTide = {
    schema_version: 1,
    tide_threshold: 20,
    tide_generation: 0,
    last_tide_at: null,
    terminal_count: 1,
    terminal_buffer: [
      {
        event_id: "worker:old",
        item_key: "openclaw/openclaw#8000",
        completed_at: "2026-07-10T17:00:00Z",
      },
    ],
    washed_at: null,
    recently_washed: [],
    seen_events: [],
    updated_at: "2026-07-10T17:00:00Z",
  };
  const migratedNoTide = mergeBayTerminalState(
    legacyNoTide,
    [
      { ...attempts[0], run_id: 11_000, job_id: 21_000, completed_at: "2026-07-10T17:00:00Z" },
      { ...attempts[0], run_id: 11_001, job_id: 21_001, completed_at: "2026-07-10T19:30:01Z" },
    ],
    [],
    "2026-07-10T20:00:00Z",
  );
  assert.equal(migratedNoTide.terminal_window_started_at, "2026-07-10T19:00:00.000Z");
  assert.deepEqual(
    migratedNoTide.terminal_buffer.map((item: { run_id: number }) => item.run_id),
    [11_001],
  );

  const legacyTideTail = {
    schema_version: 1,
    tide_threshold: 20,
    tide_generation: 1,
    last_tide_at: "2026-07-10T20:00:20Z",
    terminal_count: 2,
    terminal_buffer: [
      {
        event_id: "worker:stale",
        item_key: "openclaw/openclaw#8001",
        completed_at: "2026-07-10T17:00:00Z",
      },
      {
        event_id: "worker:tail",
        item_key: "openclaw/openclaw#8002",
        completed_at: "2026-07-10T20:00:19.900Z",
      },
    ],
    washed_at: "2026-07-10T20:00:20Z",
    recently_washed: [],
    seen_events: [],
    updated_at: "2026-07-10T20:00:20Z",
  };
  const migratedTideTail = mergeBayTerminalState(legacyTideTail, [], [], "2026-07-10T20:00:21Z");
  assert.equal(migratedTideTail.terminal_window_started_at, "2026-07-10T20:00:19.900Z");
  assert.deepEqual(
    migratedTideTail.terminal_buffer.map((item: { item_key: string }) => item.item_key),
    ["openclaw/openclaw#8002"],
  );
});

test("OpenClaw Bay counts completed review revisions without replaying washed fallback success", () => {
  const attempts = Array.from({ length: 20 }, (_, index) => ({
    run_id: 100 + index,
    job_id: 200 + index,
    repository: "openclaw/openclaw",
    item_numbers: [600 + index],
    terminal_outcome: "success",
    started_at: "2026-07-11T11:59:00.000Z",
    completed_at: `2026-07-11T12:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  const fallbackTide = mergeBayTerminalState(null, attempts, [], "2026-07-11T12:00:20.000Z");
  const reviews = attempts.map((attempt, index) => ({
    event_id: `review:openclaw/openclaw#${600 + index}:revision-${index + 1}`,
    target: {
      repository: "openclaw/openclaw",
      number: 600 + index,
      url: `https://github.com/openclaw/openclaw/issues/${600 + index}`,
    },
    triggered_at: "2026-07-11T11:59:00.000Z",
    completed_at: attempt.completed_at,
  }));

  const promoted = mergeBayTerminalState(
    fallbackTide,
    attempts,
    [],
    "2026-07-11T12:00:21.000Z",
    [],
    reviews,
    true,
  );

  assert.equal(promoted.tide_generation, 1);
  assert.equal(promoted.terminal_count, 0);
  assert.deepEqual(promoted.recently_washed, []);

  const newRevision = {
    ...reviews[0],
    event_id: "review:openclaw/openclaw#600:revision-21",
    triggered_at: "2026-07-11T12:00:20.000Z",
    completed_at: "2026-07-11T12:00:21.000Z",
  };
  const next = mergeBayTerminalState(
    promoted,
    [],
    [],
    "2026-07-11T12:00:22.000Z",
    [],
    [newRevision],
    true,
  );
  assert.equal(next.terminal_count, 1);
  assert.equal(next.terminal_buffer[0]?.event_id, newRevision.event_id);
});

test("OpenClaw Bay retains an unrelated displayed tide when lifecycle telemetry first appears", () => {
  const attempts = Array.from({ length: 20 }, (_, index) => ({
    run_id: 300 + index,
    job_id: 400 + index,
    repository: "openclaw/openclaw",
    item_numbers: [900 + index],
    terminal_outcome: "success",
    completed_at: `2026-07-11T12:20:${String(index).padStart(2, "0")}.000Z`,
  }));
  const tide = mergeBayTerminalState(null, attempts, [], "2026-07-11T12:20:20.000Z");
  const next = mergeBayTerminalState(
    tide,
    [],
    [],
    "2026-07-11T12:20:21.000Z",
    [],
    [
      {
        event_id: "review:openclaw/openclaw:999:completion:99:2026-07-11T12:20:21.000Z",
        target: { repository: "openclaw/openclaw", number: 999 },
        triggered_at: "2026-07-11T12:19:00.000Z",
        completed_at: "2026-07-11T12:20:21.000Z",
        outcome: "success",
      },
    ],
    true,
  );

  assert.equal(next.recently_washed.length, 20);
  assert.equal(next.terminal_count, 1);
});

test("OpenClaw Bay keeps failure and cancelled outcomes during lifecycle promotion", () => {
  const failure = {
    run_id: 1,
    job_id: 1,
    repository: "openclaw/openclaw",
    item_numbers: [701],
    terminal_outcome: "failure",
    completed_at: "2026-07-11T12:00:00.000Z",
  };
  const cancelled = {
    ...failure,
    run_id: 2,
    job_id: 2,
    item_numbers: [702],
    terminal_outcome: "cancelled",
    completed_at: "2026-07-11T12:01:00.000Z",
  };
  const fallback = mergeBayTerminalState(
    null,
    [failure, cancelled],
    [],
    "2026-07-11T12:01:01.000Z",
  );
  const completedReview = {
    event_id: "review:openclaw/openclaw#703:revision-1",
    target: {
      repository: "openclaw/openclaw",
      number: 703,
      url: "https://github.com/openclaw/openclaw/issues/703",
    },
    completed_at: "2026-07-11T12:02:00.000Z",
  };
  const promoted = mergeBayTerminalState(
    fallback,
    [],
    [],
    "2026-07-11T12:02:01.000Z",
    [],
    [completedReview],
    true,
  );

  assert.deepEqual(
    promoted.terminal_buffer.map((item: { outcome: string }) => item.outcome).sort(),
    ["cancelled", "failure", "success"],
  );
});

test("OpenClaw Bay keeps worker successes until a completed lifecycle review is available", () => {
  const success = {
    run_id: 10,
    job_id: 20,
    repository: "openclaw/openclaw",
    item_numbers: [704],
    terminal_outcome: "success",
    completed_at: "2026-07-11T12:03:00.000Z",
  };
  const state = mergeBayTerminalState(
    null,
    [success],
    [],
    "2026-07-11T12:03:01.000Z",
    [],
    [],
    false,
  );

  assert.equal(state.completed_reviews_authoritative, false);
  assert.equal(state.terminal_count, 1);
  assert.equal(state.terminal_buffer[0]?.outcome, "success");
});

test("OpenClaw Bay does not reopen a cleared tide boundary during lifecycle reconciliation", () => {
  const prior = {
    schema_version: 1,
    source_kind: "worker_attempts_v1",
    tide_threshold: 20,
    tide_generation: 1,
    last_tide_at: "2026-07-11T12:00:00.000Z",
    terminal_window_started_at: "2026-07-11T12:00:00.000Z",
    terminal_window_event_ids: [],
    terminal_count: 0,
    terminal_buffer: [],
    washed_at: "2026-07-11T12:00:01.000Z",
    recently_washed: [],
    seen_events: [],
    updated_at: "2026-07-11T12:00:01.000Z",
  };
  const completedReview = {
    event_id: "review:openclaw/openclaw#705:revision-1",
    target: {
      repository: "openclaw/openclaw",
      number: 705,
      url: "https://github.com/openclaw/openclaw/issues/705",
    },
    completed_at: "2026-07-11T11:00:00.000Z",
  };
  const reconciled = mergeBayTerminalState(
    prior,
    [],
    [],
    "2026-07-11T12:01:00.000Z",
    [],
    [completedReview],
    true,
  );
  const staleFailure = {
    run_id: 11,
    job_id: 21,
    repository: "openclaw/openclaw",
    item_numbers: [706],
    terminal_outcome: "failure",
    completed_at: "2026-07-11T11:30:00.000Z",
  };
  const next = mergeBayTerminalState(reconciled, [staleFailure], [], "2026-07-11T12:01:01.000Z");

  assert.equal(reconciled.terminal_window_started_at, "2026-07-11T12:00:00.000Z");
  assert.equal(next.terminal_count, 0);
});

test("OpenClaw Bay does not wash retained lifecycle completions from before the tide boundary", () => {
  const prior = {
    schema_version: 1,
    tide_generation: 1,
    last_tide_at: "2026-07-11T12:00:00.000Z",
    terminal_window_started_at: "2026-07-11T12:00:00.000Z",
    terminal_window_event_ids: [],
    terminal_count: 0,
    terminal_buffer: [],
    recently_washed: [],
    seen_events: [],
  };
  const completedReviews = Array.from({ length: 20 }, (_, index) => ({
    event_id: `review:openclaw/openclaw#${760 + index}:revision-1`,
    target: { repository: "openclaw/openclaw", number: 760 + index },
    triggered_at: "2026-07-11T10:00:00.000Z",
    completed_at: `2026-07-11T11:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const reconciled = mergeBayTerminalState(
    prior,
    [],
    [],
    "2026-07-11T12:01:00.000Z",
    [],
    completedReviews,
    true,
  );

  assert.equal(reconciled.tide_generation, 1);
  assert.equal(reconciled.terminal_count, 0);
  assert.deepEqual(reconciled.recently_washed, []);
});

test("OpenClaw Bay keeps completion IDs stable when an orphaned receipt gains its trigger", () => {
  const completion = {
    repository: "openclaw/openclaw",
    number: 707,
    source_comment_id: 77,
    completed_at: "2026-07-11T12:05:00.000Z",
    completion_kind: "final_command_status",
    completion_outcome: "failure",
    completion_comment_id: 88,
  };
  const orphaned = mergeBayJourneyState(null, [], [completion], "2026-07-11T12:05:01.000Z");
  const correlated = mergeBayJourneyState(
    orphaned,
    [
      {
        repository: "openclaw/openclaw",
        number: 707,
        source_comment_id: 77,
        source_delivery_id: "delivery-707",
        triggered_at: "2026-07-11T12:00:00.000Z",
      },
    ],
    [],
    "2026-07-11T12:05:02.000Z",
  );

  assert.ok(!orphaned.journeys[0]?.triggered_at);
  assert.equal(correlated.journeys[0]?.completion_outcome, "failure");
});

test("OpenClaw Bay preserves failed review completions", () => {
  const journeys = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 708,
        source_comment_id: 78,
        triggered_at: "2026-07-11T12:05:00.000Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 708,
        source_comment_id: 78,
        completed_at: "2026-07-11T12:06:00.000Z",
        completion_kind: "final_command_status",
        completion_outcome: "failure",
        completion_comment_id: 89,
      },
    ],
    "2026-07-11T12:06:01.000Z",
  );
  assert.equal(journeys.journeys[0]?.completion_outcome, "failure");
});

test("OpenClaw Bay excludes legacy completions with an unknown outcome", () => {
  const journeys = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 708,
        source_comment_id: 78,
        triggered_at: "2026-07-11T12:05:00.000Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 708,
        source_comment_id: 78,
        completed_at: "2026-07-11T12:06:00.000Z",
        completion_kind: "final_command_status",
        completion_comment_id: 89,
      },
    ],
    "2026-07-11T12:06:01.000Z",
  );

  assert.ok(!journeys.journeys[0]?.completion_outcome);
});

test("OpenClaw Bay keeps same-second delivery-fenced revisions distinct", () => {
  const completedAt = "2026-07-11T12:07:00.000Z";
  const journeys = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 709,
        source_comment_id: 79,
        source_delivery_id: "delivery-709-a",
        triggered_at: "2026-07-11T12:06:00.000Z",
      },
      {
        repository: "openclaw/openclaw",
        number: 709,
        source_comment_id: 79,
        source_delivery_id: "delivery-709-b",
        triggered_at: "2026-07-11T12:06:00.000Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 709,
        source_comment_id: 79,
        source_delivery_id: "delivery-709-a",
        completed_at: completedAt,
        completion_kind: "final_command_status",
        completion_outcome: "success",
        completion_comment_id: 90,
      },
      {
        repository: "openclaw/openclaw",
        number: 709,
        source_comment_id: 79,
        source_delivery_id: "delivery-709-b",
        completed_at: completedAt,
        completion_kind: "final_command_status",
        completion_outcome: "success",
        completion_comment_id: 90,
      },
    ],
    "2026-07-11T12:07:01.000Z",
  );
  assert.equal(journeys.journeys.length, 2);
  assert.notEqual(journeys.journeys[0]?.id, journeys.journeys[1]?.id);
});

test("OpenClaw Bay replaces a matching worker fallback with its lifecycle completion", () => {
  const previous = mergeBayTerminalState(
    null,
    [],
    [],
    "2026-07-11T12:08:00.000Z",
    [],
    [
      {
        event_id: "review:openclaw/openclaw:709:completion:90:2026-07-11T12:08:00.000Z",
        target: { repository: "openclaw/openclaw", number: 709 },
        triggered_at: "2026-07-11T12:07:00.000Z",
        completed_at: "2026-07-11T12:08:00.000Z",
      },
    ],
    true,
  );
  const workerSuccess = {
    run_id: 12,
    job_id: 22,
    repository: "openclaw/openclaw",
    item_numbers: [710],
    terminal_outcome: "success",
    started_at: "2026-07-11T12:09:00.000Z",
    completed_at: "2026-07-11T12:10:00.000Z",
  };
  const review = {
    event_id: "review:openclaw/openclaw:710:completion:91:2026-07-11T12:11:00.000Z",
    target: { repository: "openclaw/openclaw", number: 710 },
    triggered_at: "2026-07-11T12:08:30.000Z",
    completed_at: "2026-07-11T12:11:00.000Z",
  };
  const next = mergeBayTerminalState(
    previous,
    [workerSuccess],
    [],
    "2026-07-11T12:11:01.000Z",
    [],
    [review],
    true,
  );

  assert.equal(next.terminal_count, 2);
  assert.equal(next.terminal_buffer.at(-1)?.event_id, review.event_id);
  assert.equal(
    next.terminal_buffer.filter((item) => item.item_key === "openclaw/openclaw#710").length,
    1,
  );
});

test("OpenClaw Bay replaces a matching failed worker attempt with its lifecycle completion", () => {
  const workerFailure = {
    run_id: 13,
    job_id: 23,
    repository: "openclaw/openclaw",
    item_numbers: [711],
    terminal_outcome: "failure",
    started_at: "2026-07-11T12:09:00.000Z",
    completed_at: "2026-07-11T12:10:00.000Z",
  };
  const review = {
    event_id: "review:openclaw/openclaw:711:completion:92:2026-07-11T12:11:00.000Z",
    target: { repository: "openclaw/openclaw", number: 711 },
    triggered_at: "2026-07-11T12:08:30.000Z",
    completed_at: "2026-07-11T12:11:00.000Z",
    outcome: "failure",
  };
  const completed = mergeBayTerminalState(
    null,
    [workerFailure],
    [],
    "2026-07-11T12:11:01.000Z",
    [],
    [review],
    true,
  );

  assert.equal(completed.terminal_count, 1);
  assert.equal(completed.terminal_buffer[0]?.event_id, review.event_id);
  assert.equal(completed.terminal_buffer[0]?.outcome, "failure");
});

test("OpenClaw Bay keeps an earlier re-review worker completion beside the next lifecycle", () => {
  const earlierWorkerFailure = {
    run_id: 130,
    job_id: 230,
    repository: "openclaw/openclaw",
    item_numbers: [7110],
    terminal_outcome: "failure",
    started_at: "2026-07-11T12:00:00.000Z",
    completed_at: "2026-07-11T12:10:00.000Z",
  };
  const nextReview = {
    event_id: "review:openclaw/openclaw:7110:completion:920:2026-07-11T12:11:00.000Z",
    target: { repository: "openclaw/openclaw", number: 7110 },
    triggered_at: "2026-07-11T12:08:00.000Z",
    completed_at: "2026-07-11T12:11:00.000Z",
  };

  const completed = mergeBayTerminalState(
    null,
    [earlierWorkerFailure],
    [],
    "2026-07-11T12:11:01.000Z",
    [],
    [nextReview],
    true,
  );

  assert.equal(completed.terminal_count, 2);
  assert.deepEqual(
    completed.terminal_buffer.map((item) => item.event_id),
    ["worker:130:230:openclaw/openclaw#7110:failure:2026-07-11T12:10:00.000Z", nextReview.event_id],
  );
});

test("OpenClaw Bay does not duplicate a worker that finishes after its lifecycle completion", () => {
  const workerSuccess = {
    run_id: 131,
    job_id: 231,
    repository: "openclaw/openclaw",
    item_numbers: [7111],
    terminal_outcome: "success",
    started_at: "2026-07-11T12:09:00.000Z",
    completed_at: "2026-07-11T12:12:00.000Z",
  };
  const review = {
    event_id: "review:openclaw/openclaw:7111:completion:921:2026-07-11T12:10:00.000Z",
    target: { repository: "openclaw/openclaw", number: 7111 },
    triggered_at: "2026-07-11T12:08:30.000Z",
    completed_at: "2026-07-11T12:10:00.000Z",
  };

  const completed = mergeBayTerminalState(
    null,
    [workerSuccess],
    [],
    "2026-07-11T12:12:01.000Z",
    [],
    [review],
    true,
  );

  assert.equal(completed.terminal_count, 1);
  assert.equal(completed.terminal_buffer[0]?.event_id, review.event_id);
});

test("OpenClaw Bay suppresses a failed worker attempt while its retry is active", () => {
  const workerFailure = {
    run_id: 132,
    job_id: 232,
    repository: "openclaw/openclaw",
    item_numbers: [7112],
    terminal_outcome: "failure",
    completed_at: "2026-07-11T12:12:00.000Z",
  };

  const active = mergeBayTerminalState(null, [workerFailure], [], "2026-07-11T12:12:01.000Z", [
    "openclaw/openclaw#7112",
  ]);

  assert.equal(active.terminal_count, 0);
});

test("OpenClaw Bay retains observed active keys during a partial census", () => {
  const workerFailure = {
    run_id: 133,
    job_id: 233,
    repository: "openclaw/openclaw",
    item_numbers: [7113],
    terminal_outcome: "failure",
    completed_at: "2026-07-11T12:13:00.000Z",
  };

  const partial = mergeBayTerminalState(
    { schema_version: 1, active_item_keys: ["openclaw/openclaw#7110"] },
    [workerFailure],
    [],
    "2026-07-11T12:13:01.000Z",
    ["openclaw/openclaw#7113"],
    [],
    false,
    false,
  );

  assert.equal(partial.terminal_count, 0);
  assert.deepEqual(partial.active_item_keys.sort(), [
    "openclaw/openclaw#7110",
    "openclaw/openclaw#7113",
  ]);
});

test("OpenClaw Bay keeps unmatched worker successes during lifecycle promotion", () => {
  const workerSuccess = {
    run_id: 14,
    job_id: 24,
    repository: "openclaw/openclaw",
    item_numbers: [712],
    terminal_outcome: "success",
    completed_at: "2026-07-11T12:12:00.000Z",
  };
  const fallback = mergeBayTerminalState(null, [workerSuccess], [], "2026-07-11T12:12:01.000Z");
  const promoted = mergeBayTerminalState(
    fallback,
    [],
    [],
    "2026-07-11T12:13:01.000Z",
    [],
    [
      {
        event_id: "review:openclaw/openclaw:713:completion:93:2026-07-11T12:13:00.000Z",
        target: { repository: "openclaw/openclaw", number: 713 },
        triggered_at: "2026-07-11T12:12:30.000Z",
        completed_at: "2026-07-11T12:13:00.000Z",
      },
    ],
    true,
  );

  assert.deepEqual(promoted.terminal_buffer.map((item) => item.item_key).sort(), [
    "openclaw/openclaw#712",
    "openclaw/openclaw#713",
  ]);
});

test("OpenClaw Bay replaces an active pending fallback when its completion arrives", () => {
  const workerSuccess = {
    run_id: 15,
    job_id: 25,
    repository: "openclaw/openclaw",
    item_numbers: [714],
    terminal_outcome: "success",
    started_at: "2026-07-11T12:13:30.000Z",
    completed_at: "2026-07-11T12:14:00.000Z",
  };
  const pending = mergeBayTerminalState(null, [workerSuccess], [], "2026-07-11T12:14:01.000Z", [
    "openclaw/openclaw#714",
  ]);
  const review = {
    event_id: "review:openclaw/openclaw:714:completion:94:2026-07-11T12:15:00.000Z",
    target: { repository: "openclaw/openclaw", number: 714 },
    triggered_at: "2026-07-11T12:13:00.000Z",
    completed_at: "2026-07-11T12:15:00.000Z",
  };
  const completed = mergeBayTerminalState(
    pending,
    [],
    [],
    "2026-07-11T12:15:01.000Z",
    ["openclaw/openclaw#714"],
    [review],
    true,
  );
  const inactive = mergeBayTerminalState(
    completed,
    [],
    [],
    "2026-07-11T12:15:02.000Z",
    [],
    [],
    true,
  );

  assert.equal(completed.pending_fallback_successes.length, 0);
  assert.equal(inactive.terminal_count, 1);
  assert.equal(inactive.terminal_buffer[0]?.event_id, review.event_id);
});

test("OpenClaw Bay does not match a prior revision's fallback to a later review", () => {
  const prior = {
    schema_version: 1,
    terminal_window_started_at: "2026-07-11T11:00:00.000Z",
    terminal_window_event_ids: [],
    terminal_buffer: [],
    seen_events: [
      {
        event_id: "worker:13:23:openclaw/openclaw#711:success:2026-07-11T11:30:00.000Z",
        seen_at: "2026-07-11T11:30:00.000Z",
      },
    ],
  };
  const review = {
    event_id: "review:openclaw/openclaw:711:completion:92:2026-07-11T12:31:00.000Z",
    target: { repository: "openclaw/openclaw", number: 711 },
    triggered_at: "2026-07-11T12:00:00.000Z",
    completed_at: "2026-07-11T12:31:00.000Z",
  };
  const state = mergeBayTerminalState(
    prior,
    [],
    [],
    "2026-07-11T12:31:01.000Z",
    [],
    [review],
    true,
  );

  assert.equal(state.terminal_count, 1);
  assert.equal(state.terminal_buffer[0]?.event_id, review.event_id);
});

test("OpenClaw Bay averages completed trigger-to-summary journeys from the last hour", () => {
  const generatedAt = "2026-07-11T12:00:00.000Z";
  const journeys = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 100,
        source_comment_id: 1,
        source_delivery_id: "delivery-1",
        triggered_at: "2026-07-11T11:42:00.000Z",
      },
      {
        repository: "openclaw/openclaw",
        number: 200,
        source_comment_id: 2,
        source_delivery_id: "delivery-2",
        triggered_at: "2026-07-11T11:26:00.000Z",
      },
      {
        repository: "openclaw/openclaw",
        number: 300,
        source_comment_id: 3,
        source_delivery_id: "delivery-3",
        triggered_at: "2026-07-11T10:00:00.000Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 100,
        source_comment_id: 1,
        completed_at: "2026-07-11T11:45:00.000Z",
        completion_kind: "final_command_status",
        completion_comment_id: 11,
      },
      {
        repository: "openclaw/openclaw",
        number: 200,
        source_comment_id: 2,
        completed_at: "2026-07-11T11:30:00.000Z",
        completion_kind: "final_command_status",
        completion_comment_id: 12,
      },
      {
        repository: "openclaw/openclaw",
        number: 300,
        source_comment_id: 3,
        completed_at: "2026-07-11T10:59:59.000Z",
        completion_kind: "final_command_status",
        completion_comment_id: 13,
      },
    ],
    generatedAt,
  );
  const timings = bayJourneyTimingSnapshot(journeys.journeys, generatedAt);

  assert.equal(timings.window_minutes, 60);
  assert.equal("lanes" in timings, false);
  assert.deepEqual(timings.overall, { average_ms: 210_000, median_ms: 210_000, samples: 2 });
  assert.equal(timings.sample_kind, "completed_final_review_journeys");
});

test("OpenClaw Bay reports the median completed journey alongside the mean", () => {
  const timings = bayJourneyTimingSnapshot(
    [
      { triggered_at: "2026-07-13T11:58:00Z", completed_at: "2026-07-13T12:00:00Z" },
      { triggered_at: "2026-07-13T11:56:00Z", completed_at: "2026-07-13T12:00:00Z" },
      { triggered_at: "2026-07-13T11:15:00Z", completed_at: "2026-07-13T12:00:00Z" },
    ],
    "2026-07-13T12:00:00Z",
  );

  assert.deepEqual(timings.overall, {
    average_ms: 1_020_000,
    median_ms: 240_000,
    samples: 3,
  });
});

test("OpenClaw Bay retains pre-delivery journey records during normalization", () => {
  const state = mergeBayJourneyState(
    {
      schema_version: 1,
      journeys: [
        {
          id: "openclaw/openclaw#540:command:456",
          item_key: "openclaw/openclaw#540",
          repository: "openclaw/openclaw",
          number: 540,
          source_comment_id: 456,
          triggered_at: "2026-07-13T11:56:00Z",
          completed_at: "2026-07-13T11:59:00Z",
          completion_kind: "final_command_status",
          completion_comment_id: 790,
        },
      ],
    },
    [],
    [],
    "2026-07-13T12:00:00Z",
  );

  assert.equal(state.journeys.length, 1);
  assert.equal(state.journeys[0]?.triggered_at, "2026-07-13T11:56:00Z");
  assert.deepEqual(bayJourneyTimingSnapshot(state.journeys, "2026-07-13T12:00:00Z").overall, {
    average_ms: 180_000,
    median_ms: 180_000,
    samples: 1,
  });
});

test("OpenClaw Bay retains a completed journey for each edit of the same command", () => {
  const first = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "first-edit",
        triggered_at: "2026-07-13T12:00:00Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:05:00Z",
        completion_comment_id: 790,
      },
    ],
    "2026-07-13T12:06:00Z",
  );
  const second = mergeBayJourneyState(
    first,
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "second-edit",
        triggered_at: "2026-07-13T12:10:00Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:14:00Z",
        completion_comment_id: 790,
      },
    ],
    "2026-07-13T12:15:00Z",
  );

  assert.equal(second.journeys.length, 2);
  assert.notEqual(second.journeys[0]?.id, second.journeys[1]?.id);
  assert.deepEqual(bayJourneyTimingSnapshot(second.journeys, "2026-07-13T12:15:00Z").overall, {
    average_ms: 270_000,
    median_ms: 270_000,
    samples: 2,
  });
});

test("OpenClaw Bay retains same-second command edits from separate GitHub deliveries", () => {
  const journeys = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "edit-one",
        triggered_at: "2026-07-13T12:00:00Z",
      },
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "edit-two",
        triggered_at: "2026-07-13T12:00:00Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:05:00Z",
        completion_comment_id: 790,
      },
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:06:00Z",
        completion_comment_id: 790,
      },
    ],
    "2026-07-13T12:07:00Z",
  );

  assert.equal(journeys.journeys.length, 2);
  assert.notEqual(journeys.journeys[0]?.id, journeys.journeys[1]?.id);
  assert.deepEqual(bayJourneyTimingSnapshot(journeys.journeys, "2026-07-13T12:07:00Z").overall, {
    average_ms: 330_000,
    median_ms: 330_000,
    samples: 2,
  });
});

test("OpenClaw Bay joins an out-of-order reused status completion to its later trigger", () => {
  const first = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "first-edit",
        triggered_at: "2026-07-13T12:00:00Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:05:00Z",
        completion_comment_id: 790,
      },
    ],
    "2026-07-13T12:06:00Z",
  );
  const completionBeforeTrigger = mergeBayJourneyState(
    first,
    [],
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:14:00Z",
        completion_comment_id: 790,
      },
    ],
    "2026-07-13T12:14:00Z",
  );
  assert.equal(completionBeforeTrigger.journeys.length, 2);
  assert.equal(
    completionBeforeTrigger.journeys.filter((journey) => !journey.triggered_at).length,
    1,
  );

  const completed = mergeBayJourneyState(
    completionBeforeTrigger,
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "second-edit",
        triggered_at: "2026-07-13T12:10:00Z",
      },
    ],
    [],
    "2026-07-13T12:15:00Z",
  );

  assert.equal(completed.journeys.length, 2);
  assert.equal(completed.journeys.filter((journey) => !journey.triggered_at).length, 0);
  assert.deepEqual(bayJourneyTimingSnapshot(completed.journeys, "2026-07-13T12:15:00Z").overall, {
    average_ms: 270_000,
    median_ms: 270_000,
    samples: 2,
  });
});

test("hosted webhook records an edited review command through its final command update without GitHub reads", async () => {
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
    reason: "recorded Bay journey completion",
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

  const state = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1")) || "{}");
  assert.deepEqual(state.journeys, [
    {
      id: "openclaw/openclaw#540:command:456:delivery:test-delivery",
      item_key: "openclaw/openclaw#540",
      repository: "openclaw/openclaw",
      number: 540,
      source_comment_id: 456,
      source_delivery_id: "test-delivery",
      triggered_at: at(),
      completed_at: at(4_820_000),
      completion_kind: "final_command_status",
      completion_outcome: "failure",
      completion_comment_id: 790,
    },
  ]);
  const timings = bayJourneyTimingSnapshot(state.journeys, at(5_213_000));
  assert.deepEqual(timings.overall, {
    average_ms: 4_820_000,
    median_ms: 4_820_000,
    samples: 1,
  });
});
