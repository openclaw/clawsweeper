import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createContext, Script } from "node:vm";
import { gunzipSync } from "node:zlib";

import worker, {
  automaticIssueWork,
  ExactReviewQueue,
  exactReviewEffectiveLeaseExpiresAt,
  exactReviewJitteredDelayMs,
  exactReviewPublicationCapacity,
  exactReviewPublicationCapacityForState,
  exactReviewQueueAdmittedItems,
  exactReviewQueueCapacity,
  exactReviewQueueNextWakeAt,
  exactReviewQueueStatusSnapshot,
  mergeBayJourneyState,
  mergeBayTerminalState,
  StatusStore,
  summarizeAutomergeReliability,
  summarizeBayJourneyTimings,
  workerWorkKind,
} from "../dashboard/worker.ts";
import {
  TRIAGE_ROUTING_GROUPS,
  triageRoutingGroupsForLabels,
} from "../dashboard/triage-routing-groups.ts";
import { ExactReviewPublicationBatchStore } from "../dashboard/exact-review-publication-batches.ts";
import type { ExactReviewQueueItem } from "../dashboard/exact-review-queue.ts";
import {
  commandAcknowledgementState,
  EXACT_REVIEW_HISTORICAL_RECONCILIATION_COHORT_MAX,
  EXACT_REVIEW_HISTORICAL_RECONCILIATION_FACT_HISTORY_MAX,
  EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS,
  ExactReviewLifecycleProjectionStore,
  historicalLifecycleReconciliationReport,
  lifecycleState,
} from "../dashboard/exact-review-lifecycle.ts";
import { ExactReviewLifecycleTelemetryStore } from "../dashboard/exact-review-lifecycle-telemetry.ts";
import { LIVE_ACTIVITY_SOURCE_LIMIT, liveActivityBaySnapshot } from "../dashboard/live-activity.ts";
import { captureCanonicalRecordBaseline } from "../dist/repair/canonical-record-baseline.js";
import { publishMainWithStateAppend } from "../dist/repair/publish-main.js";

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
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
          run_id: "sensitive-run-id",
          repository: "openclaw/openclaw",
          current_step: "do not publish this detail",
        },
        { work_kind: "other", mode: "exact-review", status: "queued" },
      ],
      control_plane: {
        publishers: { running: 1, waiting: 0 },
        comment_routers: { running: 0, waiting: 1 },
        reconcilers: { running: 1, waiting: 0 },
      },
    },
    now,
  );

  assert.equal(snapshot.collection.state, "complete");
  assert.equal(snapshot.activity?.returned, 5);
  assert.equal(snapshot.activity?.omitted, 0);
  assert.deepEqual(
    snapshot.activity?.signals.map((signal) => signal.label),
    [
      "publication scheduler active",
      "lease reconciler active",
      "repair worker active",
      "comment router active",
      "worker active",
    ],
  );
  assert.equal(snapshot.freshness.maximum_age_ms, 60_000);
  assert.equal(Date.parse(snapshot.freshness.expires_at), now + 60_000);
  assert.doesNotMatch(JSON.stringify(snapshot), /sensitive|openclaw\/openclaw|current_step/i);
  assert.equal("lanes" in snapshot, false);
  assert.equal("cards" in snapshot, false);

  const fullCapacity = liveActivityBaySnapshot(
    {
      generated_at: new Date(now).toISOString(),
      diagnostics: { errors: [] },
      workers: Array.from({ length: LIVE_ACTIVITY_SOURCE_LIMIT }, () => ({
        work_kind: "exact_review",
        mode: "exact-review",
        status: "in_progress",
      })),
      control_plane: {
        publishers: { running: 0, waiting: 0 },
        comment_routers: { running: 0, waiting: 0 },
        reconcilers: { running: 0, waiting: 0 },
      },
    },
    now,
  );
  assert.equal(fullCapacity.collection.state, "complete");
  assert.equal(fullCapacity.activity?.returned, 16);
  assert.equal(fullCapacity.activity?.omitted, LIVE_ACTIVITY_SOURCE_LIMIT - 16);
});

test("live activity fails closed for stale, mixed, unavailable, and over-bound sources", () => {
  const now = 1_770_000_000_000;
  const source = {
    generated_at: new Date(now).toISOString(),
    diagnostics: { errors: [] },
    workers: [],
    control_plane: {
      publishers: { running: 0, waiting: 0 },
      comment_routers: { running: 0, waiting: 0 },
      reconcilers: { running: 0, waiting: 0 },
    },
  };
  assert.equal(liveActivityBaySnapshot(source, now + 60_001).collection.state, "unknown");
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
  assert.match(wrangler, /EXACT_REVIEW_TARGET_RATE_PER_HOUR = "450"/);
  assert.match(wrangler, /EXACT_REVIEW_TARGET_BURST = "120"/);
  assert.match(wrangler, /EXACT_REVIEW_PENDING_SOFT_LIMIT = "600"/);
});

test("historical lifecycle reconciliation is capped, provenance-fenced, and never imports Completed", () => {
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const now = 1_770_000_000_000;
  const projection = lifecycle.recordAdmission({
    canonicalTargetKey: "openclaw/openclaw#777",
    fenceKey: "openclaw/openclaw#777@exact:1",
    revision: 1,
    deliveryId: "retained:777",
    sourceAction: "historical_fixture",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    observedAt: now - 1,
  });
  const cohort = {
    cohort_id: "a".repeat(64),
    captured_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 1_000).toISOString(),
    source: "retained-historical-lifecycle-snapshot-v1" as const,
    rows: [{ source_row_id: "retained-row-777", projection }],
  };
  const before = JSON.stringify(projection);
  const report = historicalLifecycleReconciliationReport(cohort, now);
  assert.deepEqual(report.outcomes, { not_reconciled: 1, unknown: 0, completed: 0 });
  const {
    routerReceipts: _routerReceipts,
    terminalDispositions: _terminalDispositions,
    ...legacyV1
  } = projection;
  const withClaim = lifecycle.recordClaim({
    canonicalTargetKey: "openclaw/openclaw#777",
    fenceKey: "openclaw/openclaw#777@exact:1",
    revision: 1,
    claimGeneration: 1,
    runId: "777",
    runAttempt: 1,
    observedAt: now,
  });
  assert.deepEqual(
    historicalLifecycleReconciliationReport(
      { ...cohort, rows: [{ source_row_id: "legacy-v1", projection: legacyV1 }] },
      now,
    ).outcomes,
    { not_reconciled: 1, unknown: 0, completed: 0 },
  );
  assert.equal(JSON.stringify(projection), before);
  assert.deepEqual(historicalLifecycleReconciliationReport(cohort, now), report);
  assert.equal(
    historicalLifecycleReconciliationReport({ ...cohort, source: "bad" as never }, now).collection
      .state,
    "unknown",
  );
  assert.equal(
    historicalLifecycleReconciliationReport(
      {
        ...cohort,
        rows: Array.from(
          { length: EXACT_REVIEW_HISTORICAL_RECONCILIATION_COHORT_MAX + 1 },
          () => cohort.rows[0],
        ),
      },
      now,
    ).collection.state,
    "unknown",
  );
  assert.equal(
    historicalLifecycleReconciliationReport(cohort, now + 2_000).collection.state,
    "unknown",
  );
  assert.equal(
    historicalLifecycleReconciliationReport({ ...cohort, rows: null as never }, now).collection
      .state,
    "unknown",
  );
  assert.equal(
    historicalLifecycleReconciliationReport({ ...cohort, rows: [{}] as never }, now).collection
      .state,
    "complete",
  );
  assert.deepEqual(
    historicalLifecycleReconciliationReport({ ...cohort, rows: [{}] as never }, now).outcomes,
    {
      not_reconciled: 0,
      unknown: 1,
      completed: 0,
    },
  );
  assert.deepEqual(
    historicalLifecycleReconciliationReport(
      {
        ...cohort,
        rows: [
          { source_row_id: "corrupt", projection: { ...projection, admission: null } as never },
        ],
      },
      now,
    ).outcomes,
    { not_reconciled: 0, unknown: 1, completed: 0 },
  );
  assert.deepEqual(
    historicalLifecycleReconciliationReport(
      {
        ...cohort,
        rows: [
          {
            source_row_id: "over-history-cap",
            projection: {
              ...withClaim,
              claims: Array.from(
                { length: EXACT_REVIEW_HISTORICAL_RECONCILIATION_FACT_HISTORY_MAX + 1 },
                () => withClaim.claims[0],
              ),
            },
          },
        ],
      },
      now,
    ).outcomes,
    { not_reconciled: 0, unknown: 1, completed: 0 },
  );
  assert.deepEqual(
    historicalLifecycleReconciliationReport(
      {
        ...cohort,
        rows: [
          {
            source_row_id: "falsy-terminal",
            projection: { ...projection, terminalDisposition: false } as never,
          },
        ],
      },
      now,
    ).outcomes,
    { not_reconciled: 0, unknown: 1, completed: 0 },
  );
  const routed = lifecycle.recordRouterReceipt({
    canonicalTargetKey: "openclaw/openclaw#777",
    fenceKey: "openclaw/openclaw#777@exact:1",
    revision: 1,
    outcome: "durable",
    receiptId: "router:777",
    observedAt: now,
  });
  assert.deepEqual(
    historicalLifecycleReconciliationReport(
      {
        ...cohort,
        rows: [
          {
            source_row_id: "corrupt-router-receipt",
            projection: {
              ...routed,
              routerReceipt: { ...routed.routerReceipt!, observedAt: "invalid" },
            } as never,
          },
        ],
      },
      now,
    ).outcomes,
    { not_reconciled: 0, unknown: 1, completed: 0 },
  );
  assert.equal(
    historicalLifecycleReconciliationReport(
      { ...cohort, expires_at: new Date(now).toISOString() },
      now,
    ).collection.state,
    "unknown",
  );
  assert.equal(
    historicalLifecycleReconciliationReport(
      {
        ...cohort,
        captured_at: new Date(now + 1).toISOString(),
        expires_at: new Date(now + 2).toISOString(),
      },
      now,
    ).collection.state,
    "unknown",
  );
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

test("full exact-review admission preserves production verdict publication capacity", () => {
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
        EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT: "50",
        EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT: "50",
        EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "50",
      },
      state,
      Date.now(),
    ),
    50,
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

test("direct publication endpoint authenticates, dedupes, and returns a structured 413", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(701, "7010");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  leased.admissionDeliveryId = "direct-publication-delivery:701";
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const payload = {
    canonicalTargetKey: "openclaw/openclaw#701",
    fenceKey: "openclaw/openclaw#701",
    revision: 4,
    sourceSha: "b".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#701",
      fenceKey: "openclaw/openclaw#701",
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/701.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "router" },
  };
  const body = JSON.stringify(payload);
  const url = "https://clawsweeper.openclaw.ai/internal/exact-review/publication-results";
  const unsigned = await worker.fetch(new Request(url, { method: "POST", body }), env);
  assert.equal(unsigned.status, 401);

  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  const { sourceSha: _sourceSha, ...missingSourceSha } = payload;
  const missingSourceBody = JSON.stringify(missingSourceSha);
  const missingSourceSignature = `sha256=${createHmac("sha256", "test-secret").update(missingSourceBody).digest("hex")}`;
  const missingSource = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": missingSourceSignature },
      body: missingSourceBody,
    }),
    env,
  );
  assert.equal(missingSource.status, 400);
  assert.deepEqual(await missingSource.json(), {
    error: "direct_publication_source_sha_required",
    fallback_required: true,
  });
  for (const expected of [
    { accepted: true, deduped: false },
    { accepted: false, deduped: true },
  ]) {
    const response = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );
    assert.equal(response.status, 202);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, {
      ok: true,
      ...expected,
      superseded: false,
      superseded_revisions: [],
      canonical_target_key: "openclaw/openclaw#701",
      fence_key: "openclaw/openclaw#701",
      state_commit_sha: "do-revision:4",
    });
  }
  assert.equal(
    new ExactReviewLifecycleProjectionStore(storage).read("openclaw/openclaw#701", leased.key, 4)
      ?.admission.deliveryId,
    "direct-publication-delivery:701",
  );
  const directTelemetry = new ExactReviewLifecycleTelemetryStore(storage).summary(Date.now());
  assert.deepEqual(directTelemetry.publication.direct, {
    accepted: 1,
    deduped: 1,
    superseded: 0,
    fallback: 1,
    unknown: 0,
  });
  const directState = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        decision: {
          sourceAction: string;
          publication?: {
            sourceSha: string;
            leaseRevision: number | null;
            claimGeneration: number | null;
            directLifecycle?: { plan: { kind: string }; receiptOutcome: string };
          };
        };
      }
    >;
  };
  assert.equal(
    directState.items[leased.key]?.decision.sourceAction,
    "exact_review_artifact_publish",
  );
  assert.equal(directState.items[leased.key]?.decision.publication?.sourceSha, "b".repeat(40));
  assert.equal(directState.items[leased.key]?.decision.publication?.leaseRevision, 4);
  assert.equal(directState.items[leased.key]?.decision.publication?.claimGeneration, 2);
  assert.deepEqual(directState.items[leased.key]?.decision.publication?.directLifecycle, {
    plan: { kind: "router" },
    receiptOutcome: "accepted",
  });
  assert.deepEqual(
    {
      ...Array.from(
        storage.sql.exec(
          `SELECT review_completed_total, publication_enqueued_total, publication_completed_total,
                  publication_published_total
             FROM exact_review_queue_metrics`,
        ),
      )[0],
    },
    {
      review_completed_total: 1,
      publication_enqueued_total: 1,
      publication_completed_total: 0,
      publication_published_total: 0,
    },
  );
  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: leased.leaseRevision,
        claim_generation: leased.claimGeneration,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  const finalizedDirectState = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(finalizedDirectState.items[leased.key], undefined);
  assert.deepEqual(
    {
      ...Array.from(
        storage.sql.exec(
          `SELECT publication_completed_total, publication_published_total
             FROM exact_review_queue_metrics`,
        ),
      )[0],
    },
    { publication_completed_total: 1, publication_published_total: 1 },
  );

  const batchLeased = leasedExactReviewPublicationItem(702, "7020");
  batchLeased.revision = 4;
  batchLeased.leaseRevision = 4;
  batchLeased.claimGeneration = 2;
  batchLeased.state = "pending";
  const queueState = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof batchLeased>;
  };
  queueState.items[batchLeased.key] = batchLeased;
  await storage.put("exact-review-queue", queueState);
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  const batch = batches.claim({
    batchId: "worker-publication-proof",
    leaseOwner: "proof-worker",
    leaseExpiresAt: Date.now() + 60_000,
    now: Date.now(),
    maxItems: 1,
    candidates: [{ itemKey: batchLeased.key, revision: 4 }],
  });
  const batchMember = batch?.items[0];
  assert.ok(batchMember);
  const batchPayload = {
    ...payload,
    canonicalTargetKey: "openclaw/openclaw#702",
    fenceKey: batchLeased.key,
    identity: {
      canonicalTargetKey: "openclaw/openclaw#702",
      fenceKey: batchLeased.key,
      revision: 4,
      claimGeneration: batchMember.claimGeneration,
    },
    operations: [
      {
        ...payload.operations[0],
        path: "records/openclaw-openclaw/items/702.md",
      },
    ],
  };
  const targetMismatchPayload = {
    ...batchPayload,
    canonicalTargetKey: "openclaw/openclaw#703",
    identity: { ...batchPayload.identity, canonicalTargetKey: "openclaw/openclaw#703" },
    operations: [
      {
        ...batchPayload.operations[0],
        path: "records/openclaw-openclaw/items/703.md",
      },
    ],
  };
  const targetMismatchBody = JSON.stringify(targetMismatchPayload);
  const targetMismatchSignature = `sha256=${createHmac("sha256", "test-secret").update(targetMismatchBody).digest("hex")}`;
  const targetMismatch = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": targetMismatchSignature },
      body: targetMismatchBody,
    }),
    env,
  );
  assert.equal(targetMismatch.status, 409);
  assert.deepEqual(await targetMismatch.json(), {
    error: "direct_publication_fence_not_owned",
    fallback_required: true,
  });
  const batchBody = JSON.stringify(batchPayload);
  const batchSignature = `sha256=${createHmac("sha256", "test-secret").update(batchBody).digest("hex")}`;
  const batchResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": batchSignature },
      body: batchBody,
    }),
    env,
  );
  assert.equal(batchResponse.status, 202);
  assert.deepEqual(await batchResponse.json(), {
    ok: true,
    accepted: true,
    deduped: false,
    superseded: false,
    superseded_revisions: [],
    canonical_target_key: "openclaw/openclaw#702",
    fence_key: batchLeased.key,
    state_commit_sha: "do-revision:4",
  });
  const repeatedBatch = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": batchSignature },
      body: batchBody,
    }),
    env,
  );
  assert.equal((await repeatedBatch.json()).deduped, true);
  const wrongFencePayload = {
    ...batchPayload,
    fenceKey: "openclaw/openclaw#702",
    identity: { ...batchPayload.identity, fenceKey: "openclaw/openclaw#702" },
  };
  const wrongFenceBody = JSON.stringify(wrongFencePayload);
  const wrongFenceSignature = `sha256=${createHmac("sha256", "test-secret").update(wrongFenceBody).digest("hex")}`;
  const wrongFence = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": wrongFenceSignature },
      body: wrongFenceBody,
    }),
    env,
  );
  assert.equal(wrongFence.status, 409);
  assert.deepEqual(await wrongFence.json(), {
    error: "direct_publication_fence_not_owned",
    fallback_required: true,
  });
  storage.sql.exec(
    `INSERT INTO exact_review_publication_heads (target_key, source_revision, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(target_key) DO UPDATE SET source_revision = excluded.source_revision`,
    "openclaw/openclaw#702",
    2,
    Date.now(),
  );
  const staleBatch = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": batchSignature },
      body: batchBody,
    }),
    env,
  );
  assert.deepEqual(await staleBatch.json(), {
    ok: true,
    accepted: false,
    deduped: false,
    superseded: true,
    superseded_revisions: [],
    canonical_target_key: "openclaw/openclaw#702",
    fence_key: batchLeased.key,
    state_commit_sha: null,
  });
  assert.deepEqual(
    new ExactReviewLifecycleTelemetryStore(storage).summary(Date.now()).publication.batch,
    { accepted: 1, deduped: 1, superseded: 0, retryable: 0, permanent: 0 },
  );
  const afterBatch = (await storage.get("exact-review-queue")) as typeof queueState;
  assert.equal(afterBatch.items[batchLeased.key]?.state, "pending");
  const staleBatchCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/publication-batches/complete", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "worker-publication-proof",
        lease_owner: "proof-worker",
        items: [
          {
            item_key: batchLeased.key,
            revision: 4,
            claim_generation: batchMember.claimGeneration,
            terminal_outcome: "superseded",
          },
        ],
      }),
    }),
  );
  assert.equal(staleBatchCompletion.status, 200);
  assert.equal((await staleBatchCompletion.json()).accepted, 1);
  assert.deepEqual(
    new ExactReviewLifecycleTelemetryStore(storage).summary(Date.now()).publication.batch,
    { accepted: 1, deduped: 1, superseded: 1, retryable: 0, permanent: 0 },
  );

  const recordUrl =
    "https://clawsweeper.openclaw.ai/internal/state/records/openclaw-openclaw/items/701";
  const unsignedRecord = await worker.fetch(new Request(recordUrl), env);
  assert.equal(unsignedRecord.status, 401);
  const emptySignature = `sha256=${createHmac("sha256", "test-secret").update("").digest("hex")}`;
  const recordResponse = await worker.fetch(
    new Request(recordUrl, {
      headers: { "x-clawsweeper-exact-review-signature": emptySignature },
    }),
    env,
  );
  assert.equal(recordResponse.status, 200);
  const record = await recordResponse.json();
  assert.deepEqual(record, {
    content: "x",
    digest: createHash("sha256").update("x").digest("hex"),
    revision: 4,
    updatedAt: record.updatedAt,
  });
  assert.equal(Number.isFinite(Date.parse(record.updatedAt)), true);

  const listingBody = JSON.stringify({
    repoSlug: "openclaw-openclaw",
    section: "items",
    cursor: 0,
    limit: 500,
  });
  const listingSignature = `sha256=${createHmac("sha256", "test-secret").update(listingBody).digest("hex")}`;
  const listingResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/state/records/list", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": listingSignature },
      body: listingBody,
    }),
    env,
  );
  assert.equal(listingResponse.status, 200);
  const listing = await listingResponse.json();
  assert.deepEqual(listing.records, [
    {
      id: 701,
      digest: createHash("sha256").update("x").digest("hex"),
      revision: 4,
      updatedAt: listing.records[0].updatedAt,
    },
    {
      id: 702,
      digest: createHash("sha256").update("x").digest("hex"),
      revision: 4,
      updatedAt: listing.records[1].updatedAt,
    },
  ]);
  assert.equal(listing.nextCursor, null);

  const oversizedBody = JSON.stringify({ ...payload, padding: "x".repeat(4 * 1024 * 1024) });
  const oversizedSignature = `sha256=${createHmac("sha256", "test-secret").update(oversizedBody).digest("hex")}`;
  const oversized = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": oversizedSignature },
      body: oversizedBody,
    }),
    env,
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {
    error: "direct_publication_payload_too_large",
    max_bytes: 4 * 1024 * 1024,
    fallback_required: true,
  });
});

test("fetching a stale publication batch records a durable superseded telemetry outcome", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(719, "7190");
  item.revision = 4;
  item.leaseRevision = 4;
  item.claimGeneration = 2;
  item.state = "pending";
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1", EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "1" },
  );
  const claim = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
        method: "POST",
        body: JSON.stringify({
          claim_id: "fetch-stale-telemetry-batch",
          lease_owner: "fetch-stale-telemetry-owner",
          max_items: 1,
        }),
      }),
    )
  ).json();
  assert.equal(claim.claimed, true);
  storage.sql.exec(
    `INSERT INTO exact_review_publication_heads (target_key, source_revision, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(target_key) DO UPDATE SET source_revision = excluded.source_revision`,
    "openclaw/openclaw#719",
    2,
    Date.now(),
  );
  const fetched = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/publication-batches/fetch", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "fetch-stale-telemetry-batch",
        lease_owner: "fetch-stale-telemetry-owner",
      }),
    }),
  );
  assert.equal(fetched.status, 200);
  const fetchedBody = (await fetched.json()) as { items: unknown[]; superseded: number };
  assert.equal(fetchedBody.superseded, 1);
  assert.deepEqual(fetchedBody.items, []);
  assert.deepEqual(
    new ExactReviewLifecycleTelemetryStore(storage).summary(Date.now()).publication.batch,
    { accepted: 0, deduped: 0, superseded: 1, retryable: 0, permanent: 0 },
  );
});

test("non-batch publication completions record durable terminal outcomes without inferring acceptance", async () => {
  const storage = new MemoryDurableStorage();
  const retryable = leasedExactReviewPublicationItem(720, "7200");
  const permanent = leasedExactReviewPublicationItem(721, "7210");
  const superseded = leasedExactReviewPublicationItem(722, "7220");
  const published = leasedExactReviewPublicationItem(723, "7230");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: Object.fromEntries(
      [retryable, permanent, superseded, published].map((item) => [item.key, item]),
    ),
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = async (
    item: ExactReviewQueueItem,
    outcome: "success" | "failure",
    completionKind: string,
    reasonCode: string,
  ) => {
    const response = await queue.fetch(
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
          completion_kind: completionKind,
          reason_code: reasonCode,
        }),
      }),
    );
    assert.equal(response.status, 200);
  };
  await complete(retryable, "failure", "retryable_failure", "github_transient");
  await complete(permanent, "failure", "permanent_failure", "invalid_artifact");
  await complete(superseded, "success", "superseded", "remote_newer_tuple");
  await complete(published, "success", "published", "publication_applied");

  assert.deepEqual(
    new ExactReviewLifecycleTelemetryStore(storage).summary(Date.now()).publication.batch,
    { accepted: 0, deduped: 0, superseded: 1, retryable: 1, permanent: 1 },
  );
});

test("direct lifecycle requeue becomes a fresh fenced source-drift revision", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(703, "7030");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const payload = {
    canonicalTargetKey: "openclaw/openclaw#703",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "c".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#703",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/703.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "requeue" },
  };
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": signature },
      body,
    }),
    env,
  );
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).accepted, true);

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
        direct_lifecycle_requeue: true,
        lifecycle_terminal_disposition: "requeue",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: true });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        admissionDeliveryId?: string;
        decision: { sourceAction: string; publication?: unknown };
        leaseId?: string;
        revision: number;
        state: string;
      }
    >;
  };
  const requeued = state.items[leased.key];
  assert.equal(requeued?.state, "pending");
  assert.equal(requeued?.revision, 5);
  assert.equal(requeued?.leaseId, undefined);
  assert.equal(requeued?.decision.sourceAction, "source_drift_requeue");
  assert.equal(requeued?.decision.publication, undefined);
  assert.equal(requeued?.admissionDeliveryId, "direct-lifecycle-requeue:openclaw/openclaw#703:4");
  assert.equal(
    new ExactReviewLifecycleProjectionStore(storage).read("openclaw/openclaw#703", leased.key, 4)
      ?.terminalDisposition?.kind,
    "requeue",
  );
});

test("direct lifecycle requeue preserves a newer command follow-up revision", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(704, "7040");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  leased.decision = {
    ...leased.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
  };
  leased.leaseDecision = { ...leased.decision };
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const publication = {
    canonicalTargetKey: "openclaw/openclaw#704",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "d".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#704",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/704.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "requeue" },
  };
  const publicationBody = JSON.stringify(publication);
  const publicationSignature = `sha256=${createHmac("sha256", "test-secret")
    .update(publicationBody)
    .digest("hex")}`;
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": publicationSignature },
      body: publicationBody,
    }),
    env,
  );
  assert.equal(accepted.status, 202);

  const marker =
    "<!-- clawsweeper-command-status:704:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const command = await queue.fetch(
    buildExactReviewQueueRequest(
      "direct-lifecycle-command-follow-up-704",
      704,
      "legacy_dispatch",
      "pull_request",
      "openclaw/openclaw",
      {
        commandStatusMarker: marker,
        statusCommentId: 7041,
        additionalPrompt: "Preserve this command follow-up after the direct lifecycle receipt.",
      },
    ),
  );
  assert.equal(command.status, 202);
  assert.equal((await command.json()).queued, true);

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
        direct_lifecycle_requeue: true,
        lifecycle_terminal_disposition: "requeue",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: true });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        decision: {
          sourceAction: string;
          commandStatusMarker?: string;
          statusCommentId?: number;
          additionalPrompt?: string;
          publication?: unknown;
        };
        leaseId?: string;
        revision: number;
        state: string;
        terminalFinalization?: unknown;
      }
    >;
  };
  const followUp = state.items[leased.key];
  assert.equal(followUp?.state, "pending");
  assert.equal(followUp?.revision, 5);
  assert.equal(followUp?.leaseId, undefined);
  assert.equal(followUp?.terminalFinalization, undefined);
  assert.equal(followUp?.decision.sourceAction, "legacy_dispatch");
  assert.equal(followUp?.decision.publication, undefined);
  assert.equal(followUp?.decision.commandStatusMarker, marker);
  assert.equal(followUp?.decision.statusCommentId, 7041);
  assert.equal(
    followUp?.decision.additionalPrompt,
    "Preserve this command follow-up after the direct lifecycle receipt.",
  );
  assert.equal(
    new ExactReviewLifecycleProjectionStore(storage).read("openclaw/openclaw#704", leased.key, 4)
      ?.terminalDisposition?.kind,
    "requeue",
  );
});

test("direct lifecycle router completion preserves a newer command follow-up revision", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(705, "7050");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  leased.decision = {
    ...leased.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
  };
  const priorMarker =
    "<!-- clawsweeper-command-status:705:re_review:fedcba9876543210fedcba9876543210fedcba98 -->";
  Object.assign(leased.decision, { commandStatusMarker: priorMarker, statusCommentId: 7050 });
  leased.leaseDecision = { ...leased.decision };
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const publication = {
    canonicalTargetKey: "openclaw/openclaw#705",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "e".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#705",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/705.md",
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
  const publicationSignature = `sha256=${createHmac("sha256", "test-secret")
    .update(publicationBody)
    .digest("hex")}`;
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": publicationSignature },
      body: publicationBody,
    }),
    env,
  );
  assert.equal(accepted.status, 202);

  const marker =
    "<!-- clawsweeper-command-status:705:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const command = await queue.fetch(
    buildExactReviewQueueRequest(
      "direct-lifecycle-router-command-follow-up-705",
      705,
      "legacy_dispatch",
      "pull_request",
      "openclaw/openclaw",
      {
        commandStatusMarker: marker,
        statusCommentId: 7051,
      },
    ),
  );
  assert.equal(command.status, 202);
  assert.equal((await command.json()).queued, true);

  const routerReceipt = {
    canonical_target_key: "openclaw/openclaw#705",
    fence_key: leased.key,
    revision: 4,
    outcome: "durable",
    receipt_id: "direct-router-recovery:705:1",
  };
  const routerBody = JSON.stringify(routerReceipt);
  const routerSignature = `sha256=${createHmac("sha256", "test-secret")
    .update(routerBody)
    .digest("hex")}`;
  const routed = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/router-receipt", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": routerSignature },
      body: routerBody,
    }),
    env,
  );
  assert.equal(routed.status, 200);

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), {
    ok: true,
    requeued: true,
    terminal_finalization: true,
  });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        decision: {
          sourceAction: string;
          commandStatusMarker?: string;
          statusCommentId?: number;
          publication?: unknown;
        };
        leaseId?: string;
        revision: number;
        state: string;
        terminalFinalization?: unknown;
      }
    >;
  };
  const followUp = state.items[leased.key];
  assert.equal(followUp?.state, "pending");
  assert.equal(followUp?.revision, 5);
  assert.equal(followUp?.leaseId, undefined);
  assert.equal(followUp?.terminalFinalization, undefined);
  assert.equal(followUp?.decision.sourceAction, "legacy_dispatch");
  assert.equal(followUp?.decision.publication, undefined);
  assert.equal(followUp?.decision.commandStatusMarker, marker);
  assert.equal(followUp?.decision.statusCommentId, 7051);
  const finalizationDriver = state.items[`terminal-finalization:${leased.key}:4`];
  assert.equal(finalizationDriver?.state, "pending");

  // The successor now owns a new fence. Its direct receipt must install a
  // new lifecycle projection rather than being mistaken for the old receipt.
  const successorState = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, unknown>;
    items: Record<string, typeof leased>;
  };
  const successor = successorState.items[leased.key]!;
  successor.state = "leased";
  successor.revision = 5;
  successor.leaseId = "direct-lifecycle-router-follow-up-705";
  successor.leaseRevision = 5;
  successor.claimGeneration = 3;
  successor.claimedRunId = "7051";
  successor.claimedRunAttempt = 1;
  successor.claimProtocolVersion = 2;
  successor.leaseDecision = { ...successor.decision };
  successor.leaseExpiresAt = Date.now() + 60_000;
  await storage.put("exact-review-queue", successorState);

  const successorPublication = {
    ...publication,
    revision: 5,
    sourceSha: "f".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#705",
      fenceKey: leased.key,
      revision: 5,
      claimGeneration: 3,
    },
  };
  const successorPublicationBody = JSON.stringify(successorPublication);
  const successorPublicationSignature = `sha256=${createHmac("sha256", "test-secret")
    .update(successorPublicationBody)
    .digest("hex")}`;
  const successorAccepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": successorPublicationSignature },
      body: successorPublicationBody,
    }),
    env,
  );
  assert.equal(successorAccepted.status, 202);
  const successorDirectState = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { decision: { sourceAction: string; publication?: { leaseRevision: number | null } } }
    >;
  };
  assert.equal(
    successorDirectState.items[leased.key]?.decision.sourceAction,
    "exact_review_artifact_publish",
  );
  assert.equal(successorDirectState.items[leased.key]?.decision.publication?.leaseRevision, 5);
  const priorProjection = new ExactReviewLifecycleProjectionStore(storage).read(
    "openclaw/openclaw#705",
    leased.key,
    4,
  );
  assert.equal(priorProjection?.routerReceipt?.outcome, "durable");
  assert.equal(priorProjection?.admission.statusMarker, priorMarker);
  assert.equal(priorProjection?.terminalDisposition?.kind, "review_completed_routed");
  assert.equal(commandAcknowledgementState(priorProjection!), "pending");
});

test("durable direct command acknowledgement survives successor lease expiry", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(706, "7060");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  leased.decision = {
    ...leased.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
  };
  const priorMarker =
    "<!-- clawsweeper-command-status:706:re_review:fedcba9876543210fedcba9876543210fedcba98 -->";
  Object.assign(leased.decision, { commandStatusMarker: priorMarker, statusCommentId: 7060 });
  leased.leaseDecision = { ...leased.decision };
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "concurrent-terminal-finalization-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const publication = {
    canonicalTargetKey: "openclaw/openclaw#706",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "a".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#706",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/706.md",
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

  const successorMarker =
    "<!-- clawsweeper-command-status:706:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const successor = await queue.fetch(
    buildExactReviewQueueRequest(
      "direct-lifecycle-router-command-follow-up-706",
      706,
      "legacy_dispatch",
      "pull_request",
      "openclaw/openclaw",
      { commandStatusMarker: successorMarker, statusCommentId: 7061 },
    ),
  );
  assert.equal(successor.status, 202);

  const driverKey = `terminal-finalization:${leased.key}:4`;
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
  const staleCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await staleCompletion.json(), { error: "lease_not_claimed" });

  // The durable route handoff arrived after the old lease expired and its
  // mutable lease decision was cleared. The immutable old projection must
  // still materialize its own acknowledgement driver rather than attaching
  // the old marker to the successor.
  const routerReceipt = {
    canonical_target_key: publication.canonicalTargetKey,
    fence_key: publication.fenceKey,
    revision: publication.revision,
    outcome: "durable",
    receipt_id: "direct-router-recovery:706:1",
  };
  const routerBody = JSON.stringify(routerReceipt);
  const routerSignature = `sha256=${createHmac("sha256", secret).update(routerBody).digest("hex")}`;
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/router-receipt",
          {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": routerSignature },
            body: routerBody,
          },
        ),
        env,
      )
    ).status,
    200,
  );

  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  const pendingSuccessor = state.items[leased.key]!;
  let driver = state.items[driverKey]!;
  assert.equal(pendingSuccessor.state, "pending");
  assert.equal(pendingSuccessor.revision, 5);
  assert.equal(pendingSuccessor.decision.sourceAction, "legacy_dispatch");
  assert.equal(pendingSuccessor.decision.publication, undefined);
  assert.equal(pendingSuccessor.decision.commandStatusMarker, successorMarker);
  assert.equal(driver.state, "pending");
  assert.equal(driver.decision.sourceAction, "exact_review_artifact_publish");
  assert.equal(driver.decision.publication, undefined);
  assert.equal(driver.decision.commandStatusMarker, priorMarker);
  assert.deepEqual(driver.terminalFinalization?.projection, {
    canonicalTargetKey: "openclaw/openclaw#706",
    fenceKey: leased.key,
    revision: 4,
  });
  assert.equal(
    new ExactReviewLifecycleProjectionStore(storage).read("openclaw/openclaw#706", driverKey, 4),
    null,
  );

  // A later requeue is authoritative for this revision: it must cancel the
  // stale Complete driver rather than allowing it to restore the earlier
  // routed disposition. A later durable route handoff may then create a new
  // driver for that same fenced revision.
  const requeueBody = JSON.stringify({
    canonical_target_key: publication.canonicalTargetKey,
    fence_key: publication.fenceKey,
    revision: publication.revision,
    kind: "requeue",
  });
  const requeueSignature = `sha256=${createHmac("sha256", secret).update(requeueBody).digest("hex")}`;
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/terminal-disposition",
          {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": requeueSignature },
            body: requeueBody,
          },
        ),
        env,
      )
    ).status,
    200,
  );
  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  assert.equal(state.items[driverKey], undefined);
  const requeuedProjection = new ExactReviewLifecycleProjectionStore(storage).read(
    "openclaw/openclaw#706",
    leased.key,
    4,
  )!;
  assert.equal(lifecycleState(requeuedProjection), "requeue");
  assert.equal(commandAcknowledgementState(requeuedProjection), "unavailable");

  const reroutedBody = JSON.stringify({
    ...routerReceipt,
    receipt_id: "direct-router-recovery:706:2",
  });
  const reroutedSignature = `sha256=${createHmac("sha256", secret)
    .update(reroutedBody)
    .digest("hex")}`;
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/router-receipt",
          {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": reroutedSignature },
            body: reroutedBody,
          },
        ),
        env,
      )
    ).status,
    200,
  );
  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  driver = state.items[driverKey]!;
  Object.assign(driver, {
    state: "dispatching",
    leaseId: "concurrent-terminal-finalization-lease",
    leaseRevision: 4,
    leaseDecision: driver.decision,
    leaseExpiresAt: Date.now() + 60_000,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
  });
  storage.sql.replaceNormalizedQueue(state);
  const claimedDriver = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "concurrent-terminal-finalization-lease",
        item_key: driverKey,
        lease_revision: 4,
        run_id: "7062",
        run_attempt: 1,
      }),
    }),
  );
  const claimedDriverBody = await claimedDriver.json();
  assert.equal(claimedDriver.status, 200);
  assert.deepEqual(claimedDriverBody.lifecycle_projection, {
    canonicalTargetKey: "openclaw/openclaw#706",
    fenceKey: leased.key,
    revision: 4,
  });

  const finalizerTuple = {
    lease_id: "concurrent-terminal-finalization-lease",
    item_key: driverKey,
    lease_revision: 4,
    claim_generation: claimedDriverBody.claim_generation,
    run_id: "7062",
    run_attempt: 1,
  };
  const rejectedNewerMarker = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          ...finalizerTuple,
          status_marker: successorMarker,
          status_comment_id: 7061,
        }),
      },
    ),
    env,
  );
  assert.deepEqual(await rejectedNewerMarker.json(), {
    ok: true,
    allowed: false,
    lifecycle_state: "acknowledgement_pending",
    acknowledgement_state: "pending",
    terminal_disposition: "review_completed_routed",
    status_state: "Complete",
    status_detail: "The durable review result and its route handoff completed.",
    version: 1,
  });
  const permittedOldMarker = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          ...finalizerTuple,
          status_marker: priorMarker,
          status_comment_id: 7060,
        }),
      },
    ),
    env,
  );
  assert.deepEqual(await permittedOldMarker.json(), {
    ok: true,
    allowed: true,
    lifecycle_state: "acknowledgement_pending",
    acknowledgement_state: "pending",
    terminal_disposition: "review_completed_routed",
    status_state: "Complete",
    status_detail: "The durable review result and its route handoff completed.",
    attempt_id: "ack:1",
    version: 1,
  });
  assert.equal(
    commandAcknowledgementState(
      new ExactReviewLifecycleProjectionStore(storage).read(
        "openclaw/openclaw#706",
        leased.key,
        4,
      )!,
    ),
    "pending",
  );

  const failed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/failed", {
      method: "POST",
      body: JSON.stringify({
        canonical_target_key: "openclaw/openclaw#706",
        fence_key: leased.key,
        revision: 4,
        attempt_id: "ack:1",
        status_marker: priorMarker,
        status_comment_id: 7060,
      }),
    }),
  );
  assert.equal((await failed.json()).released, true);
  const retried = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/retry",
      {
        method: "POST",
        body: JSON.stringify(finalizerTuple),
      },
    ),
    env,
  );
  assert.deepEqual(await retried.json(), { ok: true, requeued: true });

  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  const retryDriver = state.items[driverKey]!;
  const retainedSuccessor = state.items[leased.key]!;
  assert.equal(retainedSuccessor.state, "pending");
  assert.equal(retainedSuccessor.revision, 5);
  assert.equal(retainedSuccessor.decision.commandStatusMarker, successorMarker);
  Object.assign(retryDriver, {
    state: "dispatching",
    leaseId: "concurrent-terminal-finalization-retry",
    leaseRevision: 4,
    leaseDecision: retryDriver.decision,
    leaseExpiresAt: Date.now() + 60_000,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
  });
  storage.sql.replaceNormalizedQueue(state);
  const retryClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "concurrent-terminal-finalization-retry",
        item_key: driverKey,
        lease_revision: 4,
        run_id: "7063",
        run_attempt: 1,
      }),
    }),
  );
  const retryClaimBody = await retryClaim.json();
  const retriedAttempt = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          lease_id: "concurrent-terminal-finalization-retry",
          item_key: driverKey,
          lease_revision: 4,
          claim_generation: retryClaimBody.claim_generation,
          run_id: "7063",
          run_attempt: 1,
          status_marker: priorMarker,
          status_comment_id: 7060,
        }),
      },
    ),
    env,
  );
  assert.equal((await retriedAttempt.json()).attempt_id, "ack:2");
  const observedPayload = {
    canonical_target_key: "openclaw/openclaw#706",
    status_marker: priorMarker,
    command_comment_id: 7060,
    completion_comment_id: 7060,
    observed_at: Date.now(),
  };
  const observedBody = JSON.stringify(observedPayload);
  const observedSignature = `sha256=${createHmac("sha256", secret)
    .update(observedBody)
    .digest("hex")}`;
  const observed = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/command-ack/observed",
      {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": observedSignature },
        body: observedBody,
      },
    ),
    env,
  );
  assert.deepEqual(await observed.json(), {
    ok: true,
    accepted: true,
    lifecycle_state: "completed",
    acknowledgement_state: "observed",
    version: 1,
  });
  const observedState = storage.sql.readNormalizedQueue() as {
    items: Record<string, ExactReviewQueueItem>;
  };
  assert.equal(observedState.items[driverKey], undefined);
  assert.equal(observedState.items[leased.key]?.revision, 5);
  assert.equal(observedState.items[leased.key]?.decision.commandStatusMarker, successorMarker);
});

test("terminal disposition materializes a direct acknowledgement driver after lease expiry", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(789, "7890");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  const marker =
    "<!-- clawsweeper-command-status:789:re_review:fedcba9876543210fedcba9876543210fedcba98 -->";
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7890 });
  leased.leaseDecision = { ...leased.decision };
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "expired-terminal-disposition-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const publication = {
    canonicalTargetKey: "openclaw/openclaw#789",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "b".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#789",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/789.md",
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

  let state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
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

  const disposition = {
    canonical_target_key: publication.canonicalTargetKey,
    fence_key: publication.fenceKey,
    revision: publication.revision,
    kind: "target_closed",
  };
  const dispositionBody = JSON.stringify(disposition);
  const dispositionSignature = `sha256=${createHmac("sha256", secret)
    .update(dispositionBody)
    .digest("hex")}`;
  const terminal = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/terminal-disposition",
      {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": dispositionSignature },
        body: dispositionBody,
      },
    ),
    env,
  );
  assert.equal(terminal.status, 200);
  assert.equal((await terminal.json()).acknowledgement_state, "pending");

  const staleCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await staleCompletion.json(), { error: "lease_not_claimed" });

  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  const driverKey = `terminal-finalization:${leased.key}:4`;
  assert.equal(state.items[leased.key], undefined);
  assert.equal(state.items[driverKey]?.state, "pending");
  assert.equal(state.items[driverKey]?.decision.commandStatusMarker, marker);
  assert.deepEqual(state.items[driverKey]?.terminalFinalization, {
    disposition: "target_closed",
    statusState: "Complete",
    statusDetail: "The item is closed; no stale verdict was published.",
    projection: {
      canonicalTargetKey: "openclaw/openclaw#789",
      fenceKey: leased.key,
      revision: 4,
    },
  });
  assert.equal(
    new ExactReviewLifecycleProjectionStore(storage).read("openclaw/openclaw#789", leased.key, 4)
      ?.terminalDisposition?.kind,
    "target_closed",
  );
});

test("fallback canonical routing materializes an acknowledgement driver after lease expiry", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewPublicationItem(791, "7910");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  const marker =
    "<!-- clawsweeper-command-status:791:re_review:fedcba9876543210fedcba9876543210fedcba98 -->";
  Object.assign(leased.decision.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 7910,
  });
  Object.assign(leased.leaseDecision!.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 7910,
  });
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7910 });
  Object.assign(leased.leaseDecision!, { commandStatusMarker: marker, statusCommentId: 7910 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#791",
    fenceKey: leased.key,
    revision: 4,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "fallback-expiry:791",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: marker,
    statusCommentId: 7910,
    observedAt: 1_700_000_000_000,
  });
  lifecycle.recordClaim({
    ...identity,
    claimGeneration: 2,
    runId: "7910",
    runAttempt: 1,
    observedAt: 1_700_000_000_001,
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "fallback-expiry-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const canonicalBody = JSON.stringify({
    canonical_target_key: identity.canonicalTargetKey,
    fence_key: identity.fenceKey,
    revision: identity.revision,
    outcome: "accepted",
    receipt_id: "fallback:791:accepted",
  });
  const canonicalSignature = `sha256=${createHmac("sha256", secret)
    .update(canonicalBody)
    .digest("hex")}`;
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/canonical-receipt",
          {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": canonicalSignature },
            body: canonicalBody,
          },
        ),
        env,
      )
    ).status,
    200,
  );

  let state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
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

  const routerBody = JSON.stringify({
    canonical_target_key: identity.canonicalTargetKey,
    fence_key: identity.fenceKey,
    revision: identity.revision,
    outcome: "durable",
    receipt_id: "fallback:791:router",
  });
  const routerSignature = `sha256=${createHmac("sha256", secret).update(routerBody).digest("hex")}`;
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/router-receipt",
          {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": routerSignature },
            body: routerBody,
          },
        ),
        env,
      )
    ).status,
    200,
  );

  const driverKey = `terminal-finalization:${leased.key}:4`;
  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  assert.equal(state.items[leased.key], undefined);
  const driver = state.items[driverKey]!;
  assert.equal(driver.state, "pending");
  assert.equal(driver.decision.publication, undefined);
  assert.equal(driver.decision.commandStatusMarker, marker);
  assert.deepEqual(driver.terminalFinalization?.projection, identity);
  assert.equal(
    commandAcknowledgementState(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!,
    ),
    "pending",
  );

  Object.assign(driver, {
    state: "dispatching",
    leaseId: "fallback-terminal-finalization-lease",
    leaseRevision: 4,
    leaseDecision: driver.decision,
    leaseExpiresAt: Date.now() + 60_000,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
  });
  storage.sql.replaceNormalizedQueue(state);
  const claimed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "fallback-terminal-finalization-lease",
        item_key: driverKey,
        lease_revision: 4,
        run_id: "7911",
        run_attempt: 1,
      }),
    }),
  );
  const claimedBody = await claimed.json();
  assert.equal(claimed.status, 200);
  const attempted = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          lease_id: "fallback-terminal-finalization-lease",
          item_key: driverKey,
          lease_revision: 4,
          claim_generation: claimedBody.claim_generation,
          run_id: "7911",
          run_attempt: 1,
          status_marker: marker,
          status_comment_id: 7910,
        }),
      },
    ),
    env,
  );
  assert.equal((await attempted.json()).allowed, true);
});

test("a successor splits a pending terminal finalizer before command merge", async () => {
  const storage = new MemoryDurableStorage();
  const finalizer = leasedExactReviewQueueItem(790, "7900");
  finalizer.revision = 4;
  const oldMarker =
    "<!-- clawsweeper-command-status:790:re_review:fedcba9876543210fedcba9876543210fedcba98 -->";
  const oldDecision = {
    ...finalizer.decision,
    sourceAction: "re_review",
    commandStatusMarker: oldMarker,
    statusCommentId: 7900,
  };
  const publication = exactReviewPublicationOverrides(
    790,
    "7900",
    "re_review",
    4,
    "openclaw/openclaw",
  ).publication;
  publication.producerDecision = oldDecision;
  Object.assign(finalizer, {
    decision: {
      ...oldDecision,
      sourceAction: "exact_review_artifact_publish",
      publication,
    },
    leaseDecision: undefined,
    state: "pending",
    leaseId: undefined,
    leaseRevision: undefined,
    leaseExpiresAt: undefined,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
    claimProtocolVersion: undefined,
    terminalFinalization: {
      disposition: "review_completed_routed",
      statusState: "Complete",
      statusDetail: "The durable review result and its route handoff completed.",
      projection: {
        canonicalTargetKey: "openclaw/openclaw#790",
        fenceKey: finalizer.key,
        revision: 4,
      },
    },
  });
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [finalizer.key]: finalizer },
  });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#790",
    fenceKey: finalizer.key,
    revision: 4,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "pending-terminal-finalizer:790",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: oldMarker,
    statusCommentId: 7900,
    observedAt: 1_700_000_000_000,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "canonical:790:accepted",
    observedAt: 1_700_000_000_001,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "router:790:durable",
    observedAt: 1_700_000_000_002,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_003,
  });

  const queue = new ExactReviewQueue({ storage }, {});
  const successorMarker =
    "<!-- clawsweeper-command-status:790:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "pending-terminal-finalizer-successor-790",
      790,
      "legacy_dispatch",
      "issue",
      "openclaw/openclaw",
      { commandStatusMarker: successorMarker, statusCommentId: 7901 },
    ),
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, true);

  const state = storage.sql.readNormalizedQueue() as {
    items: Record<string, ExactReviewQueueItem>;
  };
  const driverKey = `terminal-finalization:${finalizer.key}:4`;
  const successor = state.items[finalizer.key]!;
  assert.equal(successor.state, "pending");
  assert.equal(successor.revision, 5);
  assert.equal(successor.terminalFinalization, undefined);
  assert.equal(successor.decision.sourceAction, "legacy_dispatch");
  assert.equal(successor.decision.publication, undefined);
  assert.equal(successor.decision.commandStatusMarker, successorMarker);
  assert.equal(state.items[driverKey]?.state, "pending");
  assert.equal(state.items[driverKey]?.decision.commandStatusMarker, oldMarker);
  assert.deepEqual(state.items[driverKey]?.terminalFinalization?.projection, identity);
});

test("terminal acknowledgement dispatch rejection remains a durable fenced retry", async () => {
  let dispatchStatus = 422;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    dispatch: () =>
      dispatchStatus === 204
        ? new Response(null, { status: 204 })
        : new Response(
            JSON.stringify({
              message: "Validation Failed",
              errors: [{ field: "client_payload", code: "invalid" }],
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
  });
  try {
    const finalizer = leasedExactReviewPublicationItem(788, "7880");
    const driverKey = `terminal-finalization:${finalizer.key}:1`;
    Object.assign(finalizer, {
      key: driverKey,
      state: "pending",
      leaseId: undefined,
      leaseRevision: undefined,
      leaseDecision: undefined,
      leaseExpiresAt: undefined,
      claimedRunId: undefined,
      claimedRunAttempt: undefined,
      claimGeneration: undefined,
      claimProtocolVersion: undefined,
      terminalFinalization: {
        disposition: "failure",
        statusState: "Failed",
        statusDetail:
          "The exact review reached a durable terminal failure and needs operator attention.",
        projection: {
          canonicalTargetKey: "openclaw/openclaw#788",
          fenceKey: "openclaw/openclaw#788",
          revision: 1,
        },
      },
    });
    await harness.storage.put("exact-review-queue", {
      deliveries: {},
      items: { [driverKey]: finalizer },
    });

    await harness.queue.alarm();
    let state = harness.storage.sql.readNormalizedQueue() as {
      items: Record<string, ExactReviewQueueItem>;
    };
    const retained = state.items[driverKey]!;
    assert.equal(retained.state, "pending");
    assert.equal(retained.parkedReason, undefined);
    assert.equal(retained.terminalFinalization?.projection?.fenceKey, "openclaw/openclaw#788");
    assert.equal(retained.dispatchFailureClass, "permanent_rejection");
    assert.equal(retained.attempts, 1);
    assert.ok(retained.nextAttemptAt > Date.now());
    assert.equal(
      harness.dispatched[0]?.client_payload?.source_action,
      "exact_review_command_acknowledgement",
    );

    dispatchStatus = 204;
    retained.nextAttemptAt = Date.now() - 1;
    await harness.storage.put("exact-review-queue", state);
    await harness.queue.alarm();
    state = harness.storage.sql.readNormalizedQueue() as {
      items: Record<string, ExactReviewQueueItem>;
    };
    assert.equal(state.items[driverKey]?.state, "dispatching");
    assert.equal(state.items[driverKey]?.terminalFinalization?.projection?.revision, 1);
  } finally {
    harness.restore();
  }
});

test("direct command publication retains its terminal acknowledgement driver after durable handoff", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(787, "7870");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  const marker = "<!-- clawsweeper-command-status:787:re_review:direct -->";
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7871 });
  Object.assign(leased.leaseDecision!, { commandStatusMarker: marker, statusCommentId: 7871 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "direct-command-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const publication = {
    canonicalTargetKey: "openclaw/openclaw#787",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "c".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#787",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/787.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
  };
  const body = JSON.stringify(publication);
  const signature = `sha256=${createHmac("sha256", "direct-command-secret").update(body).digest("hex")}`;
  const published = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": signature },
      body,
    }),
    env,
  );
  assert.equal(published.status, 202);
  const routed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/router-receipt", {
      method: "POST",
      body: JSON.stringify({
        canonical_target_key: publication.canonicalTargetKey,
        fence_key: publication.fenceKey,
        revision: publication.revision,
        outcome: "durable",
        receipt_id: "direct-command:787:router",
      }),
    }),
  );
  assert.equal(routed.status, 200);
  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), {
    ok: true,
    requeued: false,
    terminal_finalization: true,
  });
  const driverKey = `terminal-finalization:${leased.key}:4`;
  const terminalState = storage.sql.readNormalizedQueue().items;
  assert.equal(terminalState[leased.key], undefined);
  const driver = terminalState[driverKey]!;
  assert.equal(driver.state, "pending");
  assert.equal(driver.decision.publication, undefined);
  assert.equal(driver.decision.commandStatusMarker, marker);
  assert.deepEqual(driver.terminalFinalization, {
    disposition: "review_completed_routed",
    statusState: "Complete",
    statusDetail: "The durable review result and its route handoff completed.",
    projection: {
      canonicalTargetKey: "openclaw/openclaw#787",
      fenceKey: leased.key,
      revision: 4,
    },
  });
});

test("authenticated fanout cursors round-trip through durable storage", async () => {
  const storage = new MemoryDurableStorage();
  const secret = "fanout-cursor-secret";
  let queue = new ExactReviewQueue({ storage }, {});
  let env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const path = "/internal/state/cursors/normal-review";
  const request = (method: "GET" | "PUT", payload?: unknown, signed = true) => {
    const body = method === "PUT" ? JSON.stringify(payload) : "";
    return new Request(`https://clawsweeper.openclaw.ai${path}`, {
      method,
      headers: signed
        ? {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
          }
        : undefined,
      ...(method === "PUT" ? { body } : {}),
    });
  };

  assert.equal((await worker.fetch(request("GET", undefined, false), env)).status, 401);
  assert.deepEqual(await (await worker.fetch(request("GET"), env)).json(), {
    ok: true,
    mode: "normal-review",
    next_cursor: 0,
    revision: 0,
    updated_at: null,
  });

  const writtenResponse = await worker.fetch(
    request("PUT", { next_cursor: 12, expected_revision: 0 }),
    env,
  );
  assert.equal(writtenResponse.status, 202);
  const written = await writtenResponse.json();
  assert.deepEqual(written, {
    ok: true,
    mode: "normal-review",
    next_cursor: 12,
    revision: 1,
    updated_at: written.updated_at,
  });
  assert.equal(Number.isFinite(Date.parse(written.updated_at)), true);

  const conflict = await worker.fetch(
    request("PUT", { next_cursor: 24, expected_revision: 0 }),
    env,
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "fanout_cursor_revision_conflict");

  queue = new ExactReviewQueue({ storage }, {});
  env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  assert.deepEqual(await (await worker.fetch(request("GET"), env)).json(), written);
});

test("placeholder recovery cursor survives queue reconstruction", async () => {
  const storage = new MemoryDurableStorage();
  const secret = "placeholder-cursor-secret";
  const mode = "review-placeholder-0123456789abcdef-closed";
  const path = `/internal/state/cursors/${mode}`;
  let queue = new ExactReviewQueue({ storage }, {});
  let env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const request = (method: "GET" | "PUT", payload?: unknown) => {
    const body = method === "PUT" ? JSON.stringify(payload) : "";
    return new Request(`https://clawsweeper.openclaw.ai${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      ...(method === "PUT" ? { body } : {}),
    });
  };

  const written = await worker.fetch(
    request("PUT", { next_cursor: 120, expected_revision: 0 }),
    env,
  );
  assert.equal(written.status, 202);

  queue = new ExactReviewQueue({ storage }, {});
  env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  assert.deepEqual(await (await worker.fetch(request("GET"), env)).json(), {
    ok: true,
    mode,
    next_cursor: 120,
    revision: 1,
    updated_at: (await written.clone().json()).updated_at,
  });
});

test("Worker lifecycle projection permits one command acknowledgement after durable routing", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewPublicationItem(778, "7780");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimedRunId = undefined;
  leased.claimedRunAttempt = undefined;
  leased.claimGeneration = undefined;
  leased.admissionDeliveryId = "publication-delivery:778";
  const marker = "<!-- clawsweeper-command-status:778:re_review:token -->";
  Object.assign(leased.decision.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 9002,
  });
  Object.assign(leased.leaseDecision!.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 9002,
  });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "lifecycle-proof-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const postSigned = async (path: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload);
    return worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai${path}`, {
        method: "POST",
        headers: {
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      }),
      env,
    );
  };

  const claimed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        run_id: "7780",
        run_attempt: 1,
      }),
    }),
  );
  assert.equal(claimed.status, 200);
  const stateAfterClaim = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; revision: number; leaseRevision: number; claimGeneration: number }
    >;
  };
  const claimedItem = stateAfterClaim.items[leased.key]!;
  assert.equal(claimedItem.state, "leased");
  assert.equal(claimedItem.revision, 4);
  assert.equal(claimedItem.leaseRevision, 4);
  assert.equal(claimedItem.claimGeneration, 1);
  assert.deepEqual(
    {
      targetRepo: claimedItem.decision.targetRepo,
      itemNumber: claimedItem.decision.itemNumber,
      key: claimedItem.key,
    },
    { targetRepo: "openclaw/openclaw", itemNumber: 778, key: leased.key },
  );
  const claimedLifecycle = new ExactReviewLifecycleProjectionStore(storage).read(
    "openclaw/openclaw#778",
    leased.key,
    4,
  );
  assert.equal(claimedLifecycle?.admission.deliveryId, "publication-delivery:778");
  assert.deepEqual(
    claimedLifecycle?.claims.map(({ claimGeneration, runId, runAttempt }) => ({
      claimGeneration,
      runId,
      runAttempt,
    })),
    [{ claimGeneration: 1, runId: "7780", runAttempt: 1 }],
  );

  const identity = {
    canonical_target_key: "openclaw/openclaw#778",
    fence_key: leased.key,
    revision: 4,
  };
  const canonical = await postSigned("/internal/exact-review/lifecycle/canonical-receipt", {
    ...identity,
    outcome: "accepted",
    receipt_id: "fallback:7780:1",
  });
  assert.deepEqual(await canonical.json(), {
    ok: true,
    lifecycle_state: "pending",
    version: 1,
  });
  const routed = await postSigned("/internal/exact-review/lifecycle/router-receipt", {
    ...identity,
    receipt_id: "router:7780:1",
  });
  assert.deepEqual(await routed.json(), {
    ok: true,
    lifecycle_state: "acknowledgement_pending",
    version: 1,
  });
  const acknowledgement = {
    ...identity,
    status_marker: marker,
    status_comment_id: 9002,
  };
  assert.deepEqual(
    await (
      await postSigned("/internal/exact-review/lifecycle/command-ack/attempt", acknowledgement)
    ).json(),
    {
      ok: true,
      allowed: true,
      lifecycle_state: "acknowledgement_pending",
      acknowledgement_state: "pending",
      attempt_id: "ack:1",
      version: 1,
    },
  );
  assert.deepEqual(
    await (
      await postSigned("/internal/exact-review/lifecycle/command-ack/failed", {
        ...acknowledgement,
        attempt_id: "ack:1",
      })
    ).json(),
    {
      ok: true,
      released: true,
      lifecycle_state: "acknowledgement_pending",
      acknowledgement_state: "pending",
      version: 1,
    },
  );
  assert.deepEqual(
    await (
      await postSigned("/internal/exact-review/lifecycle/command-ack/attempt", acknowledgement)
    ).json(),
    {
      ok: true,
      allowed: true,
      lifecycle_state: "acknowledgement_pending",
      acknowledgement_state: "pending",
      attempt_id: "ack:2",
      version: 1,
    },
  );
  assert.deepEqual(
    await (
      await postSigned("/internal/exact-review/lifecycle/command-ack/attempt", acknowledgement)
    ).json(),
    {
      ok: true,
      allowed: false,
      lifecycle_state: "acknowledgement_pending",
      acknowledgement_state: "pending",
      version: 1,
    },
  );
  const observed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/observed", {
      method: "POST",
      body: JSON.stringify({
        canonical_target_key: "openclaw/openclaw#778",
        status_marker: marker,
        command_comment_id: 123,
        completion_comment_id: 9002,
        observed_at: 1_700_000_000_000,
      }),
    }),
  );
  assert.deepEqual(await observed.json(), {
    ok: true,
    accepted: true,
    lifecycle_state: "completed",
    acknowledgement_state: "observed",
    version: 1,
  });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage).read(
    "openclaw/openclaw#778",
    leased.key,
    4,
  );
  assert.equal(lifecycleState(lifecycle!), "completed");
  assert.deepEqual(
    lifecycle?.canonicalReceipts.map(({ outcome }) => outcome),
    ["accepted"],
  );
  assert.equal(lifecycle?.acknowledgement.attempts.length, 2);
});

test("signed Worker records a status-ID-only terminal acknowledgement", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#779",
    fenceKey: "openclaw/openclaw#779@exact:status-id-only",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "status-id-only-delivery:779",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: null,
    statusCommentId: 9011,
    observedAt: 1_700_000_000_000,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "status-id-only-canonical:779",
    observedAt: 1_700_000_000_001,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "status-id-only-router:779",
    observedAt: 1_700_000_000_002,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_003,
  });
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: null,
      statusCommentId: 9011,
      observedAt: 1_700_000_000_004,
    }).allowed,
    true,
  );

  const secret = "status-id-only-lifecycle-secret";
  const payload = {
    canonical_target_key: "openclaw/openclaw#779",
    command_comment_id: 9010,
    completion_comment_id: 9011,
    observed_at: 1_700_000_000_005,
  };
  const body = JSON.stringify(payload);
  const response = await worker.fetch(
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
    {
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: true,
    lifecycle_state: "completed",
    acknowledgement_state: "observed",
    version: 1,
  });
  assert.deepEqual(
    lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
      ?.acknowledgement.observed,
    {
      statusMarker: null,
      commandCommentId: 9010,
      completionCommentId: 9011,
      observedAt: 1_700_000_000_005,
    },
  );
});

test("Worker lifecycle acknowledgement preserves canonical GitHub repository casing", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const marker = "<!-- clawsweeper-command-status:780:re_review:token -->";
  const identity = {
    canonicalTargetKey: "steipete/CodexBar#780",
    fenceKey: "steipete/CodexBar#780@exact",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "case-preserving-delivery:780",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: marker,
    statusCommentId: 9101,
    observedAt: 1_700_000_000_000,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "case-preserving:accepted",
    observedAt: 1_700_000_000_001,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "case-preserving:router",
    observedAt: 1_700_000_000_002,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_003,
  });
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: marker,
      statusCommentId: 9101,
      observedAt: 1_700_000_000_004,
    }).allowed,
    true,
  );

  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "case-preserving-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "steipete/CodexBar",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 780 },
        comment: {
          id: 9101,
          body: [
            "<!-- clawsweeper-command-ack:123 -->",
            marker,
            "<!-- clawsweeper-command-progress:start -->",
            "Re-review progress:",
            "- State: Complete",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: "2026-07-30T00:00:00.000Z",
          updated_at: "2026-07-30T00:01:00.000Z",
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "case-preserving-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      STATUS_STORE: new MemoryKv(),
    },
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "recorded Bay journey completion",
  });
  assert.equal(
    lifecycleState(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!,
    ),
    "completed",
  );
});

test("Worker converges legacy and non-review acknowledgement receipts without webhook races", async () => {
  let itemNumber = 780;
  for (const intent of ["re_review", "automerge", "autofix"]) {
    for (const legacy of [false, true]) {
      itemNumber += 1;
      const storage = new MemoryDurableStorage();
      const queue = new ExactReviewQueue({ storage }, {});
      const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
      const statusMarker = `<!-- clawsweeper-command-status:${itemNumber}:${intent}:head -->`;
      const identity = {
        canonicalTargetKey: `openclaw/openclaw#${itemNumber}`,
        fenceKey: `openclaw/openclaw#${itemNumber}@exact`,
        revision: 1,
      };
      lifecycle.recordAdmission({
        ...identity,
        deliveryId: `legacy-acknowledgement:${itemNumber}`,
        sourceAction: intent,
        commandOriginated: true,
        statusMarker,
        statusCommentId: itemNumber + 10_000,
        observedAt: 1_700_000_000_000,
      });
      lifecycle.recordCanonicalReceipt({
        ...identity,
        outcome: "accepted",
        receiptId: `legacy-acknowledgement:${itemNumber}:canonical`,
        observedAt: 1_700_000_000_001,
      });
      lifecycle.recordRouterReceipt({
        ...identity,
        outcome: "durable",
        receiptId: `legacy-acknowledgement:${itemNumber}:router`,
        observedAt: 1_700_000_000_002,
      });
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: "review_completed_routed",
        observedAt: 1_700_000_000_003,
      });
      assert.equal(
        lifecycle.authorizeCommandAcknowledgement({
          ...identity,
          statusMarker,
          statusCommentId: itemNumber + 10_000,
          observedAt: 1_700_000_000_004,
        }).allowed,
        true,
      );

      const marker = legacy
        ? `<!-- clawsweeper-command:123:2026-08-01T08:13:51Z:${intent}:head -->`
        : "<!-- clawsweeper-command-ack:123 -->";
      const response = await worker.fetch(
        signedGithubWebhookRequest({
          event: "issue_comment",
          secret: "legacy-acknowledgement-secret",
          payload: {
            action: "edited",
            repository: {
              full_name: "openclaw/openclaw",
              private: false,
              archived: false,
              fork: false,
              has_issues: true,
            },
            issue: { number: itemNumber },
            comment: {
              id: itemNumber + 10_000,
              body: [
                marker,
                statusMarker,
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
          CLAWSWEEPER_WEBHOOK_SECRET: "legacy-acknowledgement-secret",
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
          STATUS_STORE: new MemoryKv(),
        },
      );
      assert.deepEqual(await response.json(), {
        ok: true,
        accepted: false,
        reason:
          intent === "re_review"
            ? "recorded Bay journey completion"
            : "recorded lifecycle acknowledgement",
      });
      assert.equal(
        lifecycle.observeCommandAcknowledgement({
          canonicalTargetKey: identity.canonicalTargetKey,
          statusMarker,
          commandCommentId: 123,
          completionCommentId: itemNumber + 10_000,
          observedAt: 1_700_000_000_005,
        }).accepted,
        true,
      );
    }
  }
});

test("Worker binds legacy webhooks while preserving marker-only command addresses", async () => {
  for (const mismatch of ["comment", "marker", "marker-only", "id-only"]) {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue({ storage }, {});
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const itemNumber =
      mismatch === "comment"
        ? 910
        : mismatch === "marker"
          ? 911
          : mismatch === "marker-only"
            ? 912
            : 914;
    const expectedMarker = `<!-- clawsweeper-command-status:${itemNumber}:re_review:expected -->`;
    const admissionMarker = mismatch === "id-only" ? null : expectedMarker;
    const receivedMarker =
      mismatch === "marker"
        ? `<!-- clawsweeper-command-status:${itemNumber}:re_review:other -->`
        : expectedMarker;
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${itemNumber}`,
      fenceKey: `openclaw/openclaw#${itemNumber}@exact`,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `legacy-source-fence:${itemNumber}`,
      sourceAction: "re_review",
      commandOriginated: true,
      statusMarker: admissionMarker,
      statusCommentId: mismatch === "marker-only" ? null : 9101,
      observedAt: 1_700_000_000_000,
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: "accepted",
      receiptId: `legacy-source-fence:${itemNumber}:canonical`,
      observedAt: 1_700_000_000_001,
    });
    lifecycle.recordRouterReceipt({
      ...identity,
      outcome: "durable",
      receiptId: `legacy-source-fence:${itemNumber}:router`,
      observedAt: 1_700_000_000_002,
    });
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: 1_700_000_000_003,
    });
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: admissionMarker,
      statusCommentId: mismatch === "marker-only" ? null : 9101,
      observedAt: 1_700_000_000_004,
    });

    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "legacy-source-fence-secret",
        payload: {
          action: "edited",
          repository: {
            full_name: "openclaw/openclaw",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: itemNumber },
          comment: {
            id: mismatch === "comment" || mismatch === "marker-only" ? 9102 : 9101,
            body: [
              `<!-- clawsweeper-command:456:2026-08-01T08:13:51Z:re_review:${mismatch === "marker" ? "other" : "expected"} -->`,
              receivedMarker,
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
        CLAWSWEEPER_WEBHOOK_SECRET: "legacy-source-fence-secret",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
        STATUS_STORE: new MemoryKv(),
      },
    );

    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: false,
      reason:
        mismatch === "marker-only" || mismatch === "id-only"
          ? "recorded Bay journey completion"
          : "unmatched lifecycle acknowledgement",
    });
    assert.equal(
      lifecycleState(lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, 1)!),
      mismatch === "marker-only" || mismatch === "id-only"
        ? "completed"
        : "acknowledgement_pending",
    );
  }
});

test("signed terminal receipts bind legacy migration to its admitted status comment", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const statusStore = new MemoryKv();
  const now = Date.now();
  const canonicalTargetKey = "openclaw/openclaw#915";
  const statusMarker = "<!-- clawsweeper-command-status:915:re_review:migrated -->";
  const identity = {
    canonicalTargetKey,
    fenceKey: `${canonicalTargetKey}@exact`,
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "migrated-bay:915",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker,
    statusCommentId: 9301,
    observedAt: now,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "migrated-bay:canonical",
    observedAt: now + 1,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "migrated-bay:router",
    observedAt: now + 2,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: now + 3,
  });
  lifecycle.authorizeCommandAcknowledgement({
    ...identity,
    statusMarker,
    statusCommentId: 9301,
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
            number: 915,
            source_comment_id: 555,
            source_delivery_id: "migrated-bay-delivery",
            triggered_at: new Date(now).toISOString(),
          },
        ],
        [],
        new Date(now).toISOString(),
      ),
    ),
  );

  const secret = "migrated-bay-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    STATUS_STORE: statusStore,
  };
  const sendReceipt = (admittedCommentId: number) => {
    const body = JSON.stringify({
      canonical_target_key: canonicalTargetKey,
      status_marker: statusMarker,
      status_comment_id: admittedCommentId,
      command_comment_id: 555,
      completion_comment_id: 9302,
      completed_at: new Date(now + 5).toISOString(),
      observed_at: now + 15,
    });
    return worker.fetch(
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
  };

  assert.equal((await (await sendReceipt(9302)).json()).accepted, false);
  const incomplete = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1"))!).journeys;
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].completed_at ?? null, null);

  await statusStore.put(
    "openclaw-bay:journey-state:v1",
    JSON.stringify(
      mergeBayJourneyState(
        { schema_version: 1, journeys: incomplete },
        [
          {
            repository: "openclaw/openclaw",
            number: 915,
            source_comment_id: 555,
            source_delivery_id: "newer-edit",
            triggered_at: new Date(now + 10).toISOString(),
          },
        ],
        [],
        new Date(now + 10).toISOString(),
      ),
    ),
  );

  const response = await sendReceipt(9301);

  assert.equal((await response.json()).accepted, true);
  const journeys = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1"))!).journeys;
  const completed = journeys.find(
    (journey) => journey.source_delivery_id === "migrated-bay-delivery",
  );
  const newer = journeys.find((journey) => journey.source_delivery_id === "newer-edit");
  assert.equal(completed.completion_comment_id, 9302);
  assert.equal(completed.completed_at, new Date(now + 5).toISOString());
  assert.equal(newer.completed_at, null);
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, identity.fenceKey, 1)!),
    "completed",
  );
});

test("signed migrated receipts cannot complete a newer same-marker lifecycle revision", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const statusStore = new MemoryKv();
  const now = Date.now();
  const target = "openclaw/openclaw#917";
  const marker = "<!-- clawsweeper-command-status:917:re_review:same-head -->";
  for (const [revision, statusCommentId, name] of [
    [1, 9301, "older"],
    [2, 9301, "newer"],
  ] as const) {
    const identity = {
      canonicalTargetKey: target,
      fenceKey: `${target}@exact:${name}`,
      revision,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `publisher:${name}:1`,
      sourceDeliveryId: `github-delivery:${name}`,
      sourceAction: "re_review",
      commandOriginated: true,
      statusMarker: marker,
      statusCommentId,
      observedAt: now + revision,
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: "accepted",
      receiptId: `same-head:canonical:${name}`,
      observedAt: now + 10 + revision,
    });
    lifecycle.recordRouterReceipt({
      ...identity,
      outcome: "durable",
      receiptId: `same-head:router:${name}`,
      observedAt: now + 20 + revision,
    });
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now + 30 + revision,
    });
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: marker,
      statusCommentId,
      observedAt: now + 40 + revision,
    });
  }

  const secret = "same-head-revision-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    STATUS_STORE: statusStore,
  };
  await statusStore.put(
    "openclaw-bay:journey-state:v1",
    JSON.stringify(
      mergeBayJourneyState(
        null,
        [
          {
            repository: "openclaw/openclaw",
            number: 917,
            source_comment_id: 555,
            source_delivery_id: "github-delivery:older",
            triggered_at: new Date(now + 1).toISOString(),
          },
          {
            repository: "openclaw/openclaw",
            number: 917,
            source_comment_id: 555,
            source_delivery_id: "github-delivery:newer",
            triggered_at: new Date(now + 2).toISOString(),
          },
        ],
        [],
        new Date(now).toISOString(),
      ),
    ),
  );
  const payload = {
    canonical_target_key: target,
    fence_key: `${target}@exact:older`,
    revision: 1,
    status_marker: marker,
    status_comment_id: 9301,
    command_comment_id: 555,
    completion_comment_id: 9302,
    completed_at: new Date(now + 50).toISOString(),
    observed_at: now + 51,
  };
  const ambiguousWebhook = await worker.fetch(
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
        issue: { number: 917 },
        comment: {
          id: 9302,
          body: [
            "<!-- clawsweeper-command-ack:555 -->",
            marker,
            "<!-- clawsweeper-command-progress:start -->",
            "- State: Complete",
            "- Detail: Done.",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: payload.completed_at,
          updated_at: payload.completed_at,
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    env,
  );
  assert.equal((await ambiguousWebhook.json()).reason, "unmatched lifecycle acknowledgement");
  assert.equal(
    lifecycleState(lifecycle.read(target, `${target}@exact:older`, 1)!),
    "acknowledgement_pending",
  );
  assert.equal(
    lifecycleState(lifecycle.read(target, `${target}@exact:newer`, 2)!),
    "acknowledgement_pending",
  );
  const body = JSON.stringify(payload);
  const response = await worker.fetch(
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

  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: true,
    lifecycle_state: "completed",
    acknowledgement_state: "observed",
    version: 1,
    source_delivery_id: "github-delivery:older",
  });
  assert.equal(lifecycleState(lifecycle.read(target, `${target}@exact:older`, 1)!), "completed");
  assert.equal(
    lifecycleState(lifecycle.read(target, `${target}@exact:newer`, 2)!),
    "acknowledgement_pending",
  );
  const journeys = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1"))!).journeys;
  const older = journeys.find((journey) => journey.source_delivery_id === "github-delivery:older");
  const newer = journeys.find((journey) => journey.source_delivery_id === "github-delivery:newer");
  assert.equal(older.completed_at, payload.completed_at);
  assert.equal(newer.completed_at, null);

  const malformed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/observed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, status_comment_id: "9301" }),
    }),
  );
  assert.equal(malformed.status, 400);

  for (const invalidIdentity of [
    { fence_key: `${target}@exact:older`, revision: undefined },
    { fence_key: undefined, revision: 1 },
    { fence_key: `${target}@exact:older`, revision: "1" },
  ]) {
    const malformedIdentity = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/observed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, ...invalidIdentity }),
      }),
    );
    assert.equal(malformedIdentity.status, 400);
  }
});

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
    assert.equal(summarizeBayJourneyTimings(state.journeys, generatedAt).overall.samples, 1, order);
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
  assert.equal(summarizeBayJourneyTimings(legacyTrigger.journeys, generatedAt).overall.samples, 1);

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
  assert.equal(
    summarizeBayJourneyTimings(legacyThenTagged.journeys, generatedAt).overall.samples,
    1,
  );

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
      summarizeBayJourneyTimings(state!.journeys, generatedAt).overall.samples,
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
  assert.equal(summarizeBayJourneyTimings(state.journeys, generatedAt).overall.samples, 2);
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
  assert.equal(summarizeBayJourneyTimings(state.journeys, generatedAt).overall.samples, 2);
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
  const projection = new ExactReviewLifecycleProjectionStore(storage).read(
    "openclaw/openclaw#782",
    leased.key,
    1,
  );
  assert.equal(commandAcknowledgementState(projection!), "observed");
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
  try {
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
  } finally {
    harness.restore();
  }
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
  assert.equal(pageTwo.nextCursor, 2);
  const terminalPage = await (
    await worker.fetch(
      signedStateAppendRequest(
        exportPath,
        { ...pageOnePayload, cursor: pageTwo.nextCursor },
        secret,
      ),
      env,
    )
  ).json();
  assert.deepEqual(terminalPage.records, []);
  assert.equal(terminalPage.nextCursor, null);
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
    decision: { sourceAction: "exact_review_artifact_publish" },
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
    { pending: 3, ready: 2, backoff: 1, active: 1, available_slots: 127, capacity: 128 },
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
  assert.deepEqual(status.bay_projection.stages, {
    arriving: 2,
    "setting-up": 1,
    reviewing: 0,
    publishing: 1,
    applying: 0,
    repairing: 1,
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
      { item_key: "openclaw/gogcli#599", stage: "publishing", queue_state: "leased" },
      { item_key: "openclaw/gogcli#601", stage: "repairing", queue_state: "pending" },
      { item_key: "openclaw/gogcli#598", stage: "arriving", queue_state: "pending" },
    ],
  );
  assert.deepEqual(Object.keys(status.bay_projection.items[0]).sort(), [
    "created_at",
    "item_key",
    "item_number",
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

test("Bay queue projection applies its public sample cap across all stages", async () => {
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
      { state: "pending" | "dispatching" | "leased"; leaseId?: string; leaseExpiresAt?: number }
    >;
  };
  for (let index = 0; index < 9; index += 1) {
    const item = state.items[`openclaw/gogcli#${20_000 + index}`];
    item.state = "leased";
    item.leaseId = `bay-setting-lease-${index}`;
    item.leaseExpiresAt = Date.now() + 60_000;
  }
  await storage.put("exact-review-queue", state);

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.ok(status);
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

  const prioritized = await exactReviewQueueStatusSnapshot(
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    { bayPriorityKeys: ["openclaw/gogcli#30008"] },
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
});

test("triage routing groups classify impact labels without forcing one primary group", () => {
  assert.deepEqual(
    triageRoutingGroupsForLabels([
      "impact:message-loss",
      { name: "impact:security" },
      "clawsweeper:queueable-fix",
    ]).map((group) => group.id),
    ["message-delivery", "security"],
  );
  assert.deepEqual(
    triageRoutingGroupsForLabels(["impact:unknown"]).map((group) => group.id),
    ["unclassified"],
  );
  assert.deepEqual(
    triageRoutingGroupsForLabels(["impact:ux-release-blocker"]).map((group) => group.id),
    ["user-experience"],
  );
  assert.deepEqual(
    triageRoutingGroupsForLabels([{ name: "impact:ux-friction" }]).map((group) => group.id),
    ["user-experience"],
  );
  assert.equal(TRIAGE_ROUTING_GROUPS.at(-1)?.id, "unclassified");
});

test("issue triage exposes impact-group controls without changing PR proof triage", async () => {
  const issuePage = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/triage"), {});
  const proofPage = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/pr-proof-triage"),
    {},
  );
  const overviewPage = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/"), {});
  const issueHtml = await issuePage.text();
  const proofHtml = await proofPage.text();
  assert.match(issueHtml, /id="routing-group"/);
  assert.match(issueHtml, /Impact group/);
  assert.match(issueHtml, /href="\/bay-demo">OpenClaw Bay/);
  assert.match(proofHtml, /href="\/bay-demo">OpenClaw Bay/);
  assert.match(await overviewPage.text(), /href="\/bay-demo">OpenClaw Bay/);
  assert.doesNotMatch(proofHtml, /id="routing-group"/);
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

test("OpenClaw Bay is a public, indexable, hardened route", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/bay-demo"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), null);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const contentSecurityPolicy = response.headers.get("content-security-policy") || "";
  assert.match(contentSecurityPolicy, /connect-src 'self' https:\/\/\*\.openclaw\.ai/);
  assert.match(contentSecurityPolicy, /frame-ancestors 'none'/);
  const body = await response.text();
  assert.match(body, /<title>OpenClaw Bay · ClawSweeper<\/title>/);
  assert.doesNotMatch(body, /<meta name="robots"/);
  assert.doesNotMatch(body, /Experimental demo/);
  assert.match(body, /href="\/bay-demo" aria-current="page"/);
  assert.match(body, /Where's my crustacean\?/);
  assert.match(body, /20 distinct terminal items per tide/);
  assert.match(body, /Master Sweeper/);
  assert.match(body, /id="bay-control-board"/);
  assert.match(body, /Review admission/);
  assert.match(body, /Result publication/);
  assert.match(body, /State writer/);
  assert.match(body, /Queue handoff/);
  assert.doesNotMatch(body, /Recent durable events/);
  assert.doesNotMatch(body, /function bayRecentPublicationEvents/);
  assert.match(body, /id="durable-lifecycle-kanban"/);
  assert.match(body, /Durable lifecycle Kanban/);
  assert.match(body, /id="live-activity-panel"/);
  assert.match(body, /Transient signals only/);
  assert.match(body, /class="live-activity hero-live-activity"/);
  assert.match(body, /fetch\("\/api\/live-activity-bay"/);
  assert.match(body, /never create, move, count, or complete a durable lifecycle card/);
  assert.match(body, /function durableSnapshot/);
  assert.match(body, /fetch\("\/api\/durable-lifecycle-bay"/);
  assert.match(body, /durableLifecycleLoading/);
  assert.match(body, /if\(state\.durableLifecycleLoading\)return/);
  assert.match(body, /fixed 24-card newest round-robin public sample; no cursor is available/);
  assert.match(body, /Empty complete lifecycle snapshot/);
  assert.match(
    body,
    /No counts or cards are shown until a complete, fresh projection is available/,
  );
  assert.match(
    body,
    /Transient signals only; they never create, move, count, or complete a durable lifecycle card/,
  );
  const durableScriptStart = body.indexOf("function durableSnapshot");
  const durableScriptEnd = body.indexOf("function hash", durableScriptStart);
  assert.ok(durableScriptStart > 0 && durableScriptEnd > durableScriptStart);
  const durableScript = body.slice(durableScriptStart, durableScriptEnd);
  assert.doesNotMatch(durableScript, /\/api\/status|workers|current_step|stageFor/);
  const liveScriptStart = body.indexOf("function liveActivitySnapshot");
  const liveScriptEnd = body.indexOf("function hash", liveScriptStart);
  assert.ok(liveScriptStart > 0 && liveScriptEnd > liveScriptStart);
  const liveScript = body.slice(liveScriptStart, liveScriptEnd);
  assert.doesNotMatch(
    liveScript,
    /durable-lifecycle-bay|durableLifecycle|stageFor|\/api\/status|workers|current_step/,
  );
  assert.match(body, /function durableNoSensitiveFields/);
  assert.doesNotMatch(durableScript, /JSON\.stringify\(card\|\|\{\}\)/);
  assert.match(body, /function loadBayHistory/);
  assert.match(body, /function bayRateSparkline/);
  assert.match(body, /function bayStateWriterCard/);
  assert.match(body, /function bayStateWriterHistory/);
  assert.match(body, /max-width:970px\) and \(orientation:landscape/);
  assert.match(body, /net throughput over .*bayRangeLabel/);
  assert.match(body, /data-bay-history-range="24h"/);
  assert.match(body, /data-bay-history-range="7d"/);
  assert.match(body, /bay-control-axis-label/);
  assert.match(body, /api\/health-history\?range="\+encodeURIComponent\(range\)/);
  assert.match(body, /function expandQueue/);
  assert.match(body, /function queueProjectionStage/);
  assert.match(body, /Repair cove/);
  assert.match(body, /"publishing":"Publishing"/);
  assert.match(body, /Waiting to publish the final review/);
  assert.match(body, /bounded result-publication queue/);
  assert.match(
    body,
    /var hasPublishing=Object\.prototype\.hasOwnProperty\.call\(stages,"publishing"\)/,
  );
  assert.match(body, /if\(stage==="applying"&&!hasPublishing\)reported=0/);
  assert.match(body, /id="tunnel-layer"/);
  assert.match(body, /function startTunnelJourney/);
  assert.doesNotMatch(body, /function drawTunnels/);
  assert.match(body, /function visualBackwardTransitionKey/);
  assert.match(body, /class="ready-flag"/);
  assert.match(body, /function sweepPendingForward/);
  assert.match(body, /function laneLinesSvg/);
  assert.match(body, /function laneWeightFor/);
  assert.match(body, /gridTemplateColumns=laneWeights/);
  assert.match(body, /function fitStageDensity/);
  assert.match(body, /function terminalColumns\(count\)/);
  assert.match(body, /count>12&&width>=340\)return 4/);
  assert.match(body, /function terminalSlots\(columns\)/);
  assert.match(body, /TERMINAL_GROUPS=/);
  assert.match(body, /Failed \/ cancelled/);
  assert.match(body, /function terminalCapacity\(stage\)/);
  assert.match(body, /stage==="completed"&&terminalStack&&terminalStack\.clientWidth>=340\?20:12/);
  assert.match(body, /columns===4/);
  assert.match(body, /Typical trigger → final review/);
  assert.match(body, /median; mean is shown for context/);
  assert.match(body, /Awaiting a completed journey/);
  assert.match(body, /id="queue-sample-drawer"/);
  assert.match(body, /-reference public sample/);
  assert.match(body, /does not fetch or invent that missing list/);
  assert.match(body, /var known=rows;/);
  assert.match(body, /data-overflow-stage/);
  assert.match(body, /function laneHelp/);
  assert.match(body, /lane-nudge/);
  assert.match(body, /id="overall-average"/);
  assert.doesNotMatch(body, /function laneTimingHtml/);
  assert.doesNotMatch(body, /lane-average/);
  assert.doesNotMatch(body, /AVG WAIT|AVG TIME|AVG RUN/);
  assert.match(body, /function packActiveStages/);
  assert.match(body, /id="chat-overlay"/);
  assert.match(body, /id="chat-overlay" aria-hidden="true"/);
  assert.doesNotMatch(body, /id="chat-overlay" aria-live=/);
  assert.match(body, /function showLaneChat/);
  assert.match(body, /z-index:90/);
  assert.match(body, /id="tide-preview"/);
  assert.match(body, /id="tide-visual"/);
  assert.match(body, /class="tide-carriage wave"/);
  assert.match(body, /tide-water-texture/);
  assert.match(body, /tide-washing/);
  assert.match(body, /dataset\.tidePhase="incoming"/);
  assert.match(body, /duration:"520ms"|end:520/);
  assert.match(body, /function previewTide/);
  assert.match(body, /live outcome data was unchanged/);
  assert.match(body, /realTidePending/);
  assert.match(body, /loadInFlight/);
  assert.match(body, /replaceChildren\(journey\)/);
  assert.match(body, /master\.getAnimations\(\)/);
  assert.match(body, /Let the current beach movement finish first/);
  assert.match(body, /function visualTransitionKey/);
  assert.match(body, /pendingItems/);
  assert.match(body, /OUTCOME_CONFIRM_MS=150000/);
  assert.match(body, /function reconcileConfirmingOutcomes/);
  assert.match(body, /confirming-flag/);
  assert.match(body, /confirming outcome/);
  assert.match(body, /data-key=/);
  assert.match(body, /aria-pressed=/);
  assert.match(body, /function laneChatCopy/);
  assert.match(body, /Have you been in this lane long\?/);
  assert.match(body, /I'm listening for the master sweeper\./);
  assert.match(body, /The sand is cosy enough\./);
  assert.match(body, /chatSequence:0/);
  assert.doesNotMatch(body, /Things are moving|30m end to end/);
  const chatScript = [...body.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].at(-1)?.[1];
  assert.ok(chatScript);
  const chatCopyStart = chatScript.indexOf("function hash(value)");
  const chatCopyEnd = chatScript.indexOf("function runLaneChat()", chatCopyStart);
  assert.ok(chatCopyStart > 0 && chatCopyEnd > chatCopyStart);
  const chatCopySource = chatScript.slice(chatCopyStart, chatCopyEnd);
  const chatContext = createContext({
    state: { chatSequence: 0 },
    asking: { getAttribute: () => "openclaw/openclaw#1" },
    replying: { getAttribute: () => "openclaw/openclaw#2" },
    copies: [],
  });
  new Script(
    `${chatCopySource};for(var chatIndex=0;chatIndex<10;chatIndex+=1)copies.push(laneChatCopy(asking,replying,7));`,
  ).runInContext(chatContext);
  assert.ok(new Set(chatContext.copies.map((copy) => copy.question)).size > 1);
  assert.ok(new Set(chatContext.copies.map((copy) => copy.answer)).size > 1);
  assert.ok(chatContext.copies.every((copy) => copy.answer.includes("7m")));
  const runChangedSource = body.match(/function runChanged\([^}]+\}/)?.[0];
  const stageForSource = body.match(/function stageFor\([^]*?return "arriving";\}/)?.[0];
  const queueProjectionStageSource = body.match(
    /function queueProjectionStage\([^]*?return STAGES\.indexOf\(stage\)>=0\?stage:"arriving";\}/,
  )?.[0];
  const transitionKindSource = body.match(
    /function transitionKind\([^]*?return oldIndex>=0&&nextIndex>oldIndex\?"forward":null;\}/,
  )?.[0];
  assert.ok(runChangedSource);
  assert.ok(stageForSource);
  assert.ok(queueProjectionStageSource);
  assert.ok(transitionKindSource);
  const normalizeQueueStage = new Script(
    `${queueProjectionStageSource};queueProjectionStage`,
  ).runInNewContext({
    STAGES: ["arriving", "setting-up", "reviewing", "publishing", "applying", "repairing"],
  });
  assert.equal(normalizeQueueStage("applying", false), "applying");
  assert.equal(normalizeQueueStage("applying", true), "publishing");
  assert.equal(normalizeQueueStage("publishing"), "publishing");
  const classifyBayStage = new Script(`${stageForSource};stageFor`).runInNewContext({
    STAGES: ["arriving", "setting-up", "reviewing", "publishing", "applying", "repairing"],
  });
  const publicationSteps = [{ name: "Apply review artifacts" }];
  assert.equal(
    classifyBayStage({
      status: "in_progress",
      current_step: "Validate exact review artifact bundle",
      steps: publicationSteps,
    }),
    "publishing",
  );
  assert.equal(
    classifyBayStage({
      status: "queued",
      current_step: "Waiting for runner",
      steps: publicationSteps,
    }),
    "publishing",
  );
  assert.equal(
    classifyBayStage({
      name: "Publish review artifacts",
      status: "queued",
      current_step: "Waiting for runner",
      steps: [],
    }),
    "publishing",
  );
  assert.equal(
    classifyBayStage({
      status: "in_progress",
      current_step: "Publish review artifact action ledger",
      steps: publicationSteps,
    }),
    "publishing",
  );
  assert.equal(
    classifyBayStage({
      status: "in_progress",
      current_step: "Sync selected review comments",
      steps: publicationSteps,
    }),
    "applying",
  );
  const classifyTransition = new Script(
    `${runChangedSource};(${transitionKindSource})`,
  ).runInNewContext({
    MAIN_STAGES: ["arriving", "setting-up", "reviewing", "publishing", "applying"],
  });
  for (const stage of ["setting-up", "reviewing", "publishing", "applying"]) {
    assert.equal(
      classifyTransition({ run_id: "old", stage: "reviewing" }, { run_id: "new", stage }),
      "retrigger",
    );
  }
  assert.equal(
    classifyTransition(
      { run_id: "same", stage: "reviewing" },
      { run_id: "same", stage: "repairing" },
    ),
    null,
  );
  assert.equal(
    classifyTransition(
      { run_id: "same", stage: "reviewing" },
      { run_id: "same", stage: "publishing" },
    ),
    "forward",
  );
  assert.equal(
    classifyTransition(
      { run_id: "same", stage: "publishing" },
      { run_id: "same", stage: "applying" },
    ),
    "forward",
  );
  assert.match(body, /hasBaySchema\(live\.bay\)\?live\.bay:previewBay/);
  assert.match(body, /state\.previewSource=false/);
  assert.match(body, /record\.outcome==="failure"\?"failed"/);
  assert.match(body, /master\.classList\.add\("resting"\)/);
  assert.match(body, /fetch\("\/api\/status"/);
  assert.match(body, /exact_review_queue=live\.exact_review_queue/);
  assert.match(body, /setInterval\(load,20000\)/);
  assert.doesNotMatch(body, /api\.github\.com|fetch\("\/repos\//);
  assert.match(body, /Disappearing workers remain CHECKING/);
  assert.match(body, /renderRepos\(state\.filter\)/);
  assert.match(body, /replacement\.focus\(\{preventScroll:true\}\)/);
  const script = [...body.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].at(-1)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  const confirmingStart = script.indexOf("function reconcileConfirmingOutcomes");
  const confirmingEnd = script.indexOf("function reposFor", confirmingStart);
  assert.ok(confirmingStart > 0 && confirmingEnd > confirmingStart);
  const confirmingSource = script.slice(confirmingStart, confirmingEnd);
  const activeVisual = {
    id: "active:1:97722",
    key: "openclaw/openclaw#97722",
    number: 97722,
    repository: "openclaw/openclaw",
    stage: "reviewing",
    status: "in_progress",
    outcome: null,
    run_id: 1,
    current_step: "Review exact event item",
  };
  const confirmingContext = createContext({
    state: { items: [activeVisual], confirmingOutcomes: {} },
    OUTCOME_CONFIRM_MS: 150_000,
    Date,
    Object,
    nextItems: [],
    result: null,
  });
  new Script(`${confirmingSource}\nresult = reconcileConfirmingOutcomes(nextItems);`).runInContext(
    confirmingContext,
  );
  assert.equal(confirmingContext.result.length, 1);
  assert.equal(confirmingContext.result[0].confirming, true);
  assert.equal(confirmingContext.result[0].stage, "reviewing");
  assert.equal(confirmingContext.result[0].current_step, "Confirming terminal outcome");

  confirmingContext.state.items = confirmingContext.result;
  confirmingContext.nextItems = [
    {
      ...activeVisual,
      id: "terminal:1",
      stage: "completed",
      status: "success",
      outcome: "success",
    },
  ];
  new Script("result = reconcileConfirmingOutcomes(nextItems);").runInContext(confirmingContext);
  assert.equal(confirmingContext.result.length, 1);
  assert.equal(confirmingContext.result[0].stage, "completed");
  assert.equal(Object.keys(confirmingContext.state.confirmingOutcomes).length, 0);

  for (const path of ["/bay", "/bay.html", "/bay-demo.html"]) {
    const missing = await worker.fetch(new Request(`https://clawsweeper.openclaw.ai${path}`), {});
    assert.equal(missing.status, 404, `${path} should remain unpublished`);
  }

  for (const path of ["/", "/triage", "/pr-proof-triage"]) {
    const page = await worker.fetch(new Request(`https://clawsweeper.openclaw.ai${path}`), {});
    const pageBody = await page.text();
    assert.match(pageBody, /href="\/bay-demo">OpenClaw Bay/);
    if (path === "/") assert.match(pageBody, /setInterval\(load, 15000\)/);
  }
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
  const timings = summarizeBayJourneyTimings(journeys.journeys, generatedAt);

  assert.equal(timings.window_minutes, 60);
  assert.equal("lanes" in timings, false);
  assert.deepEqual(timings.overall, { average_ms: 210_000, median_ms: 210_000, samples: 2 });
  assert.equal(timings.sample_kind, "completed_review_journeys");
});

test("OpenClaw Bay reports the median completed journey alongside the mean", () => {
  const timings = summarizeBayJourneyTimings(
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
  assert.deepEqual(summarizeBayJourneyTimings(state.journeys, "2026-07-13T12:00:00Z").overall, {
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
  assert.deepEqual(summarizeBayJourneyTimings(second.journeys, "2026-07-13T12:15:00Z").overall, {
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
  assert.deepEqual(summarizeBayJourneyTimings(journeys.journeys, "2026-07-13T12:07:00Z").overall, {
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
  assert.deepEqual(summarizeBayJourneyTimings(completed.journeys, "2026-07-13T12:15:00Z").overall, {
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
    accepted: false,
    reason: "no routable ClawSweeper command",
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
      completion_comment_id: 790,
    },
  ]);
  const timings = summarizeBayJourneyTimings(state.journeys, at(5_213_000));
  assert.deepEqual(timings.overall, {
    average_ms: 4_820_000,
    median_ms: 4_820_000,
    samples: 1,
  });
});

class MemoryKv {
  private values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

class MemorySqlCursor<T extends Record<string, unknown>> implements Iterable<T> {
  rowsRead = 0;
  readonly rowsWritten: number;
  private readonly rows: T[];

  constructor(rows: T[], rowsWritten: number) {
    this.rows = rows;
    this.rowsWritten = rowsWritten;
  }

  *[Symbol.iterator]() {
    for (const row of this.rows) {
      this.rowsRead += 1;
      yield row;
    }
  }
}

class MemorySqlStorage {
  private readonly database = new DatabaseSync(":memory:");
  private failure: { pattern: RegExp; error: Error } | undefined;
  private bindingLimit = Number.POSITIVE_INFINITY;

  exec(query: string, ...bindings: unknown[]) {
    if (bindings.length > this.bindingLimit) {
      throw new Error(`test SQL binding limit exceeded: ${bindings.length}`);
    }
    if (this.failure?.pattern.test(query)) {
      const { error } = this.failure;
      this.failure = undefined;
      throw error;
    }
    const statement = this.database.prepare(query);
    if (/^\s*(?:SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
      const rows = statement.all(...bindings) as Record<string, unknown>[];
      return new MemorySqlCursor(rows, rows.length);
    }
    const result = statement.run(...bindings);
    return new MemorySqlCursor([], Number(result.changes));
  }

  transactionSync<T>(callback: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failNext(pattern: RegExp, error = new Error("injected SQL failure")) {
    this.failure = { pattern, error };
  }

  setBindingLimit(limit: number) {
    this.bindingLimit = limit;
  }

  hasNormalizedQueue() {
    const table = this.database
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'exact_review_queue_meta'",
      )
      .get() as { found?: number } | undefined;
    if (!table) return false;
    return Boolean(
      this.database
        .prepare("SELECT 1 AS found FROM exact_review_queue_meta WHERE singleton_id = 1")
        .get(),
    );
  }

  readNormalizedQueue() {
    const meta = this.database
      .prepare("SELECT dispatcher_json FROM exact_review_queue_meta WHERE singleton_id = 1")
      .get() as { dispatcher_json?: string | null } | undefined;
    const items = Object.fromEntries(
      (
        this.database
          .prepare("SELECT item_key, item_json FROM exact_review_queue_items ORDER BY item_key")
          .all() as Array<{ item_key: string; item_json: string }>
      ).map((row) => [row.item_key, JSON.parse(row.item_json)]),
    );
    const deliveries = Object.fromEntries(
      (
        this.database
          .prepare(
            "SELECT delivery_id, received_at FROM exact_review_queue_deliveries ORDER BY delivery_id",
          )
          .all() as Array<{ delivery_id: string; received_at: number }>
      ).map((row) => [row.delivery_id, row.received_at]),
    );
    const state: {
      deliveries: Record<string, number>;
      items: Record<string, unknown>;
      dispatcher?: unknown;
    } = { deliveries, items };
    if (meta?.dispatcher_json) state.dispatcher = JSON.parse(meta.dispatcher_json);
    return state;
  }

  replaceNormalizedQueue(value: unknown) {
    const state = (value && typeof value === "object" ? value : {}) as {
      deliveries?: Record<string, number>;
      items?: Record<string, unknown>;
      dispatcher?: unknown;
    };
    this.transactionSync(() => {
      this.database.exec("DELETE FROM exact_review_queue_deliveries");
      this.database.exec("DELETE FROM exact_review_queue_items");
      const insertDelivery = this.database.prepare(
        "INSERT INTO exact_review_queue_deliveries (delivery_id, received_at) VALUES (?, ?)",
      );
      for (const [deliveryId, receivedAt] of Object.entries(state.deliveries || {})) {
        insertDelivery.run(deliveryId, receivedAt);
      }
      const insertItem = this.database.prepare(
        "INSERT INTO exact_review_queue_items (item_key, item_json) VALUES (?, ?)",
      );
      for (const [itemKey, item] of Object.entries(state.items || {})) {
        insertItem.run(itemKey, JSON.stringify(item));
      }
      this.database
        .prepare("UPDATE exact_review_queue_meta SET dispatcher_json = ? WHERE singleton_id = 1")
        .run(state.dispatcher === undefined ? null : JSON.stringify(state.dispatcher));
    });
  }

  setMigrationTime(migratedAt: number) {
    this.database
      .prepare("UPDATE exact_review_queue_meta SET migrated_at = ? WHERE singleton_id = 1")
      .run(migratedAt);
  }

  setReceiptTime(deliveryId: string, receivedAt: number) {
    this.database
      .prepare("UPDATE exact_review_queue_deliveries SET received_at = ? WHERE delivery_id = ?")
      .run(receivedAt, deliveryId);
  }
}

class MemoryDurableStorage {
  private values = new Map<string, unknown>();
  private putCounts = new Map<string, number>();
  private putFailure: { key: string; error: Error } | undefined;
  private deleteFailure: { key: string; error: Error } | undefined;
  private alarmAt: number | null = null;
  readonly sql = new MemorySqlStorage();
  readonly kv = {
    get: (key: string) => this.values.get(key),
    put: (key: string, value: unknown) => this.putRawSync(key, value),
    delete: (key: string) => this.deleteRawSync(key),
  };

  transactionSync<T>(callback: () => T) {
    const valuesBefore = new Map(
      Array.from(this.values, ([key, value]) => [key, structuredClone(value)]),
    );
    const putCountsBefore = new Map(this.putCounts);
    try {
      return this.sql.transactionSync(callback);
    } catch (error) {
      this.values = valuesBefore;
      this.putCounts = putCountsBefore;
      throw error;
    }
  }

  async get(key: string, options?: { noCache?: boolean }) {
    if (key === "exact-review-queue" && this.sql.hasNormalizedQueue() && !options?.noCache) {
      return this.sql.readNormalizedQueue();
    }
    return this.values.get(key);
  }

  async put(key: string | Record<string, unknown>, value?: unknown) {
    if (typeof key === "object") {
      for (const [entryKey, entryValue] of Object.entries(key)) {
        this.throwPutFailure(entryKey);
        this.storeRaw(entryKey, entryValue);
      }
      return;
    }
    this.throwPutFailure(key);
    if (key === "exact-review-queue" && this.sql.hasNormalizedQueue()) {
      const normalized = this.sql.readNormalizedQueue();
      const candidate = (value && typeof value === "object" ? value : {}) as {
        deliveries?: Record<string, number>;
        items?: Record<string, unknown>;
        dispatcher?: unknown;
      };
      const deliveryEntries = Object.entries(candidate.deliveries || {});
      const markerEntries = deliveryEntries.filter(([deliveryId]) =>
        /^__clawsweeper_sql_generation:\d+$/.test(deliveryId),
      );
      const candidateReceipts = Object.fromEntries(
        deliveryEntries.filter(
          ([deliveryId]) => !deliveryId.startsWith("__clawsweeper_sql_generation:"),
        ),
      );
      const normalizedReceiptIds = Object.keys(normalized.deliveries).sort();
      const rollbackShadow =
        markerEntries.length === 1 &&
        markerEntries[0][1] === Number.MAX_SAFE_INTEGER &&
        isDeepStrictEqual(Object.keys(candidateReceipts).sort(), normalizedReceiptIds) &&
        normalizedReceiptIds.every(
          (deliveryId) =>
            Number(candidateReceipts[deliveryId]) >= Number(normalized.deliveries[deliveryId]),
        ) &&
        isDeepStrictEqual(candidate.items || {}, normalized.items) &&
        isDeepStrictEqual(candidate.dispatcher, normalized.dispatcher);
      if (!rollbackShadow) this.sql.replaceNormalizedQueue(candidate);
    }
    this.storeRaw(key, value);
  }

  async delete(key: string) {
    return this.deleteRawSync(key);
  }

  async list() {
    return new Map(this.values);
  }

  async getAlarm() {
    return this.alarmAt;
  }

  async setAlarm(at: number) {
    this.alarmAt = at;
  }

  async deleteAlarm() {
    this.alarmAt = null;
  }

  has(key: string) {
    return this.values.has(key);
  }

  putCount(key: string) {
    return this.putCounts.get(key) || 0;
  }

  rawHas(key: string) {
    return this.values.has(key);
  }

  rawGet(key: string) {
    return this.values.get(key);
  }

  rawPut(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }

  private throwPutFailure(key: string) {
    if (this.putFailure?.key !== key) return;
    const { error } = this.putFailure;
    this.putFailure = undefined;
    throw error;
  }

  private putRawSync(key: string, value: unknown) {
    this.throwPutFailure(key);
    this.storeRaw(key, value);
  }

  private storeRaw(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
    this.putCounts.set(key, (this.putCounts.get(key) || 0) + 1);
  }

  private deleteRawSync(key: string) {
    if (this.deleteFailure?.key === key) {
      const { error } = this.deleteFailure;
      this.deleteFailure = undefined;
      throw error;
    }
    return this.values.delete(key);
  }

  failNextPut(key: string, error = new Error("injected storage put failure")) {
    this.putFailure = { key, error };
  }

  failNextDelete(key: string, error = new Error("injected storage delete failure")) {
    this.deleteFailure = { key, error };
  }

  failNextSql(pattern: RegExp, error?: Error) {
    this.sql.failNext(pattern, error);
  }

  setExactReviewMigrationTime(migratedAt: number) {
    this.sql.setMigrationTime(migratedAt);
  }

  setExactReviewReceiptTime(deliveryId: string, receivedAt: number) {
    this.sql.setReceiptTime(deliveryId, receivedAt);
  }
}

class MemoryDurableNamespace {
  private stub;

  constructor(stub) {
    this.stub = stub;
  }

  idFromName(name: string) {
    return name;
  }

  get() {
    return this.stub;
  }
}

test("public durable publication event endpoint returns bounded aggregate-only window data", async () => {
  const storage = new MemoryDurableStorage();
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  telemetry.ensureSchemaSync();
  telemetry.recordDirectOutcome({
    canonicalTargetKey: "openclaw/openclaw#898",
    fenceKey: "openclaw/openclaw#898@exact:1",
    revision: 1,
    claimGeneration: 1,
    outcome: "accepted",
    observedAt: Date.now() - 60_000,
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const exec = storage.sql.exec.bind(storage.sql);
  let sourceReads = 0;
  storage.sql.exec = (query: string, ...bindings: unknown[]) => {
    if (query.includes("SELECT outcome, observed_at")) sourceReads += 1;
    return exec(query, ...bindings);
  };
  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/recent-durable-publication-events?window=6h"),
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
  );
  const body = (await response.json()) as {
    recent_durable_publication_events: Record<string, unknown>;
  };
  assert.equal(response.status, 200);
  assert.equal((body.recent_durable_publication_events.window as { id: string }).id, "6h");
  assert.equal(
    (body.recent_durable_publication_events.collection as { complete: boolean }).complete,
    true,
  );
  assert.equal(JSON.stringify(body).includes("openclaw/openclaw#898"), false);
  assert.equal(JSON.stringify(body).includes("workflow"), false);
  const cached = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/recent-durable-publication-events?window=6h"),
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
  );
  assert.equal(cached.status, 200);
  assert.equal(sourceReads, 2);
});

test("durable lifecycle Bay is a pure, redacted per-target-revision reducer snapshot", async () => {
  const now = Date.now();
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const record = ({
    number,
    revision = 1,
    terminal,
    command = false,
  }: {
    number: number;
    revision?: number;
    terminal?: "review_completed_routed" | "superseded" | "requeue" | "dead_letter";
    command?: boolean;
  }) => {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${number}`,
      fenceKey: `fence-secret-${number}-${revision}`,
      revision,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `delivery-secret-${number}-${revision}`,
      sourceAction: "re_review",
      commandOriginated: command,
      statusMarker: command ? `status-secret-${number}-${revision}` : null,
      statusCommentId: command ? number : null,
      observedAt: now - 500 + revision,
    });
    if (terminal === "review_completed_routed") {
      lifecycle.recordCanonicalReceipt({
        ...identity,
        outcome: "accepted",
        receiptId: `receipt-secret-${number}-${revision}`,
        observedAt: now - 400 + revision,
      });
      lifecycle.recordRouterReceipt({
        ...identity,
        outcome: "durable",
        receiptId: `router-secret-${number}-${revision}`,
        observedAt: now - 300 + revision,
      });
    }
    if (terminal) {
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: terminal,
        observedAt: now - 200 + revision,
      });
    }
  };

  // A re-review produces a new revision in its own lane; the first revision
  // remains visible as superseded rather than moving backwards.
  record({ number: 910, revision: 1, terminal: "superseded" });
  record({ number: 910, revision: 2 });
  record({ number: 911, terminal: "review_completed_routed", command: true });
  record({ number: 912, terminal: "review_completed_routed" });
  record({ number: 913, terminal: "requeue" });
  record({ number: 914, terminal: "dead_letter" });

  let initialized = 0;
  const queue = new ExactReviewQueue(
    {
      storage,
      blockConcurrencyWhile: async (callback: () => Promise<void>) => {
        initialized += 1;
        return callback();
      },
    },
    {},
  );
  const exec = storage.sql.exec.bind(storage.sql);
  const queries: string[] = [];
  storage.sql.exec = (query: string, ...bindings: unknown[]) => {
    queries.push(query);
    assert.match(query, /^\s*SELECT\s+projection_json\b/i, "Bay route must be read-only");
    assert.deepEqual(bindings, [513]);
    return exec(query, ...bindings);
  };

  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
  );
  const body = (await response.json()) as {
    durable_lifecycle_bay: {
      collection: { state: string };
      inventory: { lifecycle_records: number } | null;
      lanes: Record<string, number> | null;
      sample: { cards: Array<Record<string, unknown>> } | null;
    };
  };
  const snapshot = body.durable_lifecycle_bay;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(initialized, 0, "pure Bay GET must not initialize queue storage");
  assert.equal(queries.length, 1);
  assert.equal(snapshot.collection.state, "complete");
  assert.equal(snapshot.inventory?.lifecycle_records, 6);
  assert.deepEqual(snapshot.lanes, {
    pending: 1,
    acknowledgement_pending: 1,
    completed: 1,
    superseded: 1,
    requeued: 1,
    terminal_attention: 1,
  });
  assert.equal(snapshot.sample?.cards.length, 6);
  const revisions = snapshot.sample?.cards
    .filter(
      (card) => String((card.target as { repository?: string }).repository) === "openclaw/openclaw",
    )
    .map((card) => [
      (card.target as { number: number }).number,
      card.revision,
      card.lane,
      card.terminal_label,
    ]);
  assert.deepEqual(revisions, [
    [910, 2, "pending", null],
    [911, 1, "acknowledgement_pending", null],
    [912, 1, "completed", null],
    [910, 1, "superseded", null],
    [913, 1, "requeued", null],
    [914, 1, "terminal_attention", "dead_letter"],
  ]);
  const publicText = JSON.stringify(body);
  for (const secret of [
    "fence-secret",
    "delivery-secret",
    "status-secret",
    "receipt-secret",
    "router-secret",
  ]) {
    assert.doesNotMatch(publicText, new RegExp(secret));
  }
  assert.doesNotMatch(publicText, /claimGeneration|commentId|digest|cursor/i);
});

test("operator lifecycle audit inventory is signed, redacted, paginated, snapshot-stable, and short-lived", async () => {
  const coldQueue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const cold = await coldQueue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle-audit/inventory", {
      method: "POST",
      body: JSON.stringify({ page_size: 1 }),
    }),
  );
  const coldInventory = (await cold.json()) as {
    exact_review_lifecycle_audit_inventory: {
      collection: { state: string };
      snapshot: { total_records: number } | null;
      page: { returned: number } | null;
    };
  };
  assert.equal(cold.status, 200);
  assert.equal(coldInventory.exact_review_lifecycle_audit_inventory.collection.state, "complete");
  assert.equal(coldInventory.exact_review_lifecycle_audit_inventory.snapshot?.total_records, 0);
  assert.equal(coldInventory.exact_review_lifecycle_audit_inventory.page?.returned, 0);

  const unavailableStorage = new MemoryDurableStorage();
  new ExactReviewLifecycleProjectionStore(unavailableStorage).ensureSchemaSync();
  unavailableStorage.failNextSql(/exact_review_lifecycle_audit_snapshots_v1/);
  const unavailableQueue = new ExactReviewQueue(
    {
      storage: unavailableStorage,
      blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
    },
    {},
  );
  const unavailable = await unavailableQueue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle-audit/inventory", {
      method: "POST",
      body: JSON.stringify({ page_size: 1 }),
    }),
  );
  const unavailableInventory = (await unavailable.json()) as {
    exact_review_lifecycle_audit_inventory: { collection: { state: string; reason: string } };
  };
  assert.deepEqual(unavailableInventory.exact_review_lifecycle_audit_inventory.collection, {
    state: "unknown",
    reason: "unavailable",
  });

  const now = Date.now();
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  for (const number of [960, 961, 962]) {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${number}`,
      fenceKey: `fence-secret-${number}`,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `delivery-secret-${number}`,
      sourceAction: "re_review",
      commandOriginated: number === 960,
      statusMarker: number === 960 ? `status-secret-${number}` : null,
      statusCommentId: number === 960 ? number : null,
      observedAt: now - number,
    });
  }
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "shared-secret",
    EXACT_REVIEW_OPERATOR_SECRET: "operator-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const endpoint =
    "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle-audit/inventory";
  const request = async (body: string, secret = "operator-secret") =>
    worker.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret)
            .update(body)
            .digest("hex")}`,
        },
        body,
      }),
      env,
    );

  const unsigned = await worker.fetch(new Request(endpoint, { method: "POST", body: "{}" }), env);
  assert.equal(unsigned.status, 401);
  const sharedSigned = await request(JSON.stringify({ page_size: 2 }), "shared-secret");
  assert.equal(sharedSigned.status, 401);
  for (const malformedBody of ["", "null", "[]", "true", "{not-json"]) {
    const malformed = await request(malformedBody);
    assert.equal(
      malformed.status,
      400,
      `expected invalid signed body ${JSON.stringify(malformedBody)}`,
    );
  }

  const firstBody = JSON.stringify({ page_size: 2 });
  const first = await request(firstBody);
  assert.equal(first.status, 200);
  const firstInventory = (await first.json()) as {
    exact_review_lifecycle_audit_inventory: {
      collection: { state: string };
      snapshot: { id: string; total_records: number; retention_ms: number } | null;
      page: {
        records: Array<{ target: { number: number }; state: string }>;
        next_cursor: string | null;
      } | null;
    };
  };
  const inventory = firstInventory.exact_review_lifecycle_audit_inventory;
  assert.equal(inventory.collection.state, "complete");
  assert.equal(inventory.snapshot?.total_records, 3);
  assert.equal(inventory.snapshot?.retention_ms, 300_000);
  assert.deepEqual(
    inventory.page?.records.map((record) => record.target.number),
    [960, 961],
  );
  assert.ok(inventory.page?.next_cursor);
  const redacted = JSON.stringify(firstInventory);
  for (const secret of ["fence-secret", "delivery-secret", "status-secret"]) {
    assert.doesNotMatch(redacted, new RegExp(secret));
  }
  assert.doesNotMatch(redacted, /commentId|digest|receiptId|runId/i);

  lifecycle.recordTerminalDisposition({
    canonicalTargetKey: "openclaw/openclaw#962",
    fenceKey: "fence-secret-962",
    revision: 1,
    kind: "dead_letter",
    observedAt: now + 1,
  });
  const nextBody = JSON.stringify({ page_size: 2, cursor: inventory.page?.next_cursor });
  const next = await request(nextBody);
  const nextInventory = (await next.json()) as {
    exact_review_lifecycle_audit_inventory: {
      collection: { state: string };
      page: {
        records: Array<{ target: { number: number }; state: string }>;
        next_cursor: string | null;
      } | null;
    };
  };
  assert.equal(next.status, 200);
  assert.equal(nextInventory.exact_review_lifecycle_audit_inventory.collection.state, "complete");
  assert.deepEqual(
    nextInventory.exact_review_lifecycle_audit_inventory.page?.records.map((record) => [
      record.target.number,
      record.state,
    ]),
    [[962, "pending"]],
  );
  assert.equal(nextInventory.exact_review_lifecycle_audit_inventory.page?.next_cursor, null);

  const invalid = await request(JSON.stringify({ page_size: 101 }));
  assert.equal(invalid.status, 400);
  const expiredAt = Date.now() - 1;
  storage.sql.exec(
    "UPDATE exact_review_lifecycle_audit_snapshots_v1 SET created_at = ?, expires_at = ?",
    expiredAt - 300_000,
    expiredAt,
  );
  const replacement = await request(firstBody);
  assert.equal(
    replacement.status,
    200,
    "a new snapshot prunes expired rows but retains a stale tombstone",
  );
  const stale = await request(nextBody);
  const staleInventory = (await stale.json()) as {
    exact_review_lifecycle_audit_inventory: { collection: { state: string; reason: string } };
  };
  assert.equal(stale.status, 200);
  assert.deepEqual(staleInventory.exact_review_lifecycle_audit_inventory.collection, {
    state: "unknown",
    reason: "stale",
  });
});

test("durable lifecycle Bay keeps ordinary queue initialization available after a pure direct read", async () => {
  const storage = new MemoryDurableStorage();
  let initialized = 0;
  const queue = new ExactReviewQueue(
    {
      storage,
      blockConcurrencyWhile: async (callback: () => Promise<void>) => {
        initialized += 1;
        return callback();
      },
    },
    {},
  );

  const pure = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle-bay"),
  );
  const pureBody = (await pure.json()) as {
    durable_lifecycle_bay: {
      collection: { state: string; reason: string };
      inventory: unknown;
      lanes: unknown;
      sample: unknown;
    };
  };
  assert.equal(pure.status, 200);
  assert.deepEqual(pureBody.durable_lifecycle_bay.collection, {
    state: "unknown",
    reason: "unavailable",
  });
  assert.equal(pureBody.durable_lifecycle_bay.inventory, null);
  assert.equal(pureBody.durable_lifecycle_bay.lanes, null);
  assert.equal(pureBody.durable_lifecycle_bay.sample, null);
  assert.equal(initialized, 0, "pure /lifecycle-bay must bypass initialization");
  assert.equal(storage.sql.hasNormalizedQueue(), false);

  const ordinary = await queue.fetch(
    new Request(
      "https://clawsweeper-exact-review-queue/recent-durable-publication-events?window=24h",
    ),
  );
  const ordinaryBody = (await ordinary.json()) as {
    recent_durable_publication_events: { collection: { state: string; complete: boolean } };
  };
  assert.equal(ordinary.status, 200);
  assert.equal(initialized, 1, "ordinary queue GET must still initialize normally");
  assert.equal(storage.sql.hasNormalizedQueue(), true);
  assert.equal(ordinaryBody.recent_durable_publication_events.collection.state, "complete");
  assert.equal(ordinaryBody.recent_durable_publication_events.collection.complete, true);
});

test("durable lifecycle Bay fail-closes unknown snapshots without partial cards or counts", async () => {
  const assertUnknown = (snapshot: Record<string, unknown>, reason: string) => {
    assert.deepEqual(snapshot.collection, { state: "unknown", reason });
    assert.equal(snapshot.inventory, null);
    assert.equal(snapshot.lanes, null);
    assert.equal(snapshot.sample, null);
  };
  const unavailable = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    {},
  );
  const unavailableBody = (await unavailable.json()) as {
    durable_lifecycle_bay: Record<string, unknown>;
  };
  assert.equal(unavailable.status, 200);
  assertUnknown(unavailableBody.durable_lifecycle_bay, "unavailable");

  const staleQueue = {
    fetch: async () =>
      new Response(
        JSON.stringify({
          durable_lifecycle_bay: {
            version: 1,
            source: "exact-review-lifecycle-projection-v1",
            generated_at: new Date(Date.now() - 60_001).toISOString(),
            freshness: { maximum_age_ms: 60_000 },
            collection: { state: "complete" },
            inventory: { lifecycle_records: 0, target_revisions: 0, unique_targets: 0 },
            lanes: {
              pending: 0,
              acknowledgement_pending: 0,
              completed: 0,
              superseded: 0,
              requeued: 0,
              terminal_attention: 0,
            },
            sample: { limit: 24, returned: 0, omitted: 0, cards: [] },
          },
        }),
      ),
  };
  const stale = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(staleQueue) },
  );
  const staleBody = (await stale.json()) as { durable_lifecycle_bay: Record<string, unknown> };
  assertUnknown(staleBody.durable_lifecycle_bay, "stale");

  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  storage.sql.exec(
    "INSERT INTO exact_review_lifecycle_projection_v1 (canonical_target_key, revision, fence_key, projection_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    "openclaw/openclaw#950",
    1,
    "malformed-fence",
    "{not-json",
    Date.now(),
  );
  const malformed = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(new ExactReviewQueue({ storage }, {})) },
  );
  const malformedBody = (await malformed.json()) as {
    durable_lifecycle_bay: Record<string, unknown>;
  };
  assertUnknown(malformedBody.durable_lifecycle_bay, "malformed");

  const nestedMalformedStorage = new MemoryDurableStorage();
  const nestedMalformedLifecycle = new ExactReviewLifecycleProjectionStore(nestedMalformedStorage);
  nestedMalformedLifecycle.ensureSchemaSync();
  nestedMalformedStorage.sql.exec(
    "INSERT INTO exact_review_lifecycle_projection_v1 (canonical_target_key, revision, fence_key, projection_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    "openclaw/openclaw#951",
    1,
    "nested-malformed-fence",
    JSON.stringify({
      version: 1,
      canonicalTargetKey: "openclaw/openclaw#951",
      fenceKey: "nested-malformed-fence",
      revision: 1,
      updatedAt: Date.now(),
      admission: null,
    }),
    Date.now(),
  );
  const nestedMalformed = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    {
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(
        new ExactReviewQueue({ storage: nestedMalformedStorage }, {}),
      ),
    },
  );
  const nestedMalformedBody = (await nestedMalformed.json()) as {
    durable_lifecycle_bay: Record<string, unknown>;
  };
  assertUnknown(nestedMalformedBody.durable_lifecycle_bay, "mixed");

  const missingGithubEffectStorage = new MemoryDurableStorage();
  const missingGithubEffectLifecycle = new ExactReviewLifecycleProjectionStore(
    missingGithubEffectStorage,
  );
  missingGithubEffectLifecycle.ensureSchemaSync();
  missingGithubEffectLifecycle.recordAdmission({
    canonicalTargetKey: "openclaw/openclaw#952",
    fenceKey: "missing-github-effect-fence",
    revision: 1,
    deliveryId: "missing-github-effect-delivery",
    sourceAction: "re_review",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    observedAt: Date.now(),
  });
  const missingGithubEffect = missingGithubEffectLifecycle.read(
    "openclaw/openclaw#952",
    "missing-github-effect-fence",
    1,
  );
  assert.ok(missingGithubEffect);
  const missingGithubEffectJson = { ...missingGithubEffect } as Record<string, unknown>;
  delete missingGithubEffectJson.githubEffect;
  missingGithubEffectStorage.sql.exec(
    "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ? WHERE canonical_target_key = ? AND revision = ? AND fence_key = ?",
    JSON.stringify(missingGithubEffectJson),
    "openclaw/openclaw#952",
    1,
    "missing-github-effect-fence",
  );
  const missingGithubEffectResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    {
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(
        new ExactReviewQueue({ storage: missingGithubEffectStorage }, {}),
      ),
    },
  );
  const missingGithubEffectBody = (await missingGithubEffectResponse.json()) as {
    durable_lifecycle_bay: Record<string, unknown>;
  };
  assertUnknown(missingGithubEffectBody.durable_lifecycle_bay, "mixed");

  const cappedStorage = new MemoryDurableStorage();
  const cappedLifecycle = new ExactReviewLifecycleProjectionStore(cappedStorage);
  cappedLifecycle.ensureSchemaSync();
  for (let index = 1; index <= 513; index += 1) {
    cappedLifecycle.recordAdmission({
      canonicalTargetKey: `openclaw/openclaw#${10_000 + index}`,
      fenceKey: `cap-fence-${index}`,
      revision: 1,
      deliveryId: `cap-delivery-${index}`,
      sourceAction: "re_review",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      observedAt: Date.now() - index,
    });
  }
  const overCap = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    {
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(
        new ExactReviewQueue({ storage: cappedStorage }, {}),
      ),
    },
  );
  const overCapBody = (await overCap.json()) as {
    durable_lifecycle_bay: Record<string, unknown>;
  };
  assertUnknown(overCapBody.durable_lifecycle_bay, "over_cap");
});

class MemoryR2Bucket {
  private objects = new Map<string, Uint8Array>();

  async createMultipartUpload(key: string) {
    const parts = new Map<number, Uint8Array>();
    return {
      uploadPart: async (partNumber: number, value: ArrayBuffer | Uint8Array) => {
        parts.set(partNumber, new Uint8Array(value).slice());
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async (completed: Array<{ partNumber: number }>) => {
        const selected = completed.map((part) => parts.get(part.partNumber)!);
        const bytes = new Uint8Array(selected.reduce((sum, part) => sum + part.byteLength, 0));
        let offset = 0;
        for (const part of selected) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        this.objects.set(key, bytes);
        return { key, size: bytes.byteLength };
      },
      abort: async () => undefined,
    };
  }

  async head(key: string) {
    const value = this.objects.get(key);
    return value ? { key, size: value.byteLength } : null;
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const value = this.objects.get(key);
    if (!value) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? value.byteLength - offset;
    const body = new Response(value.slice(offset, offset + length)).body;
    assert.ok(body);
    return { body, size: value.byteLength };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  keys() {
    return [...this.objects.keys()].sort();
  }
}

class MemoryCache {
  private values = new Map<string, Response>();

  async match(request: Request) {
    return this.values.get(request.url)?.clone();
  }

  async put(request: Request, response: Response) {
    this.values.set(request.url, response.clone());
  }
}

test("automerge metric ingestion validates before writes and requires durable storage", async () => {
  const statusStore = new MemoryKv();
  const token = ["test", "token"].join("-");
  const env = { INGEST_TOKEN: token, STATUS_STORE: statusStore };
  const request = (body: Record<string, unknown>) =>
    worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.automerge_metric",
          repository: "openclaw/openclaw",
          item_number: 42,
          phase: "activated",
          occurred_at: "2026-07-17T10:00:00Z",
          ...body,
        }),
      }),
      env,
    );

  assert.equal((await request({})).status, 400);
  assert.equal(await statusStore.get("events"), null);
  assert.equal(await statusStore.get("latest-event"), null);

  assert.equal(
    (
      await request({
        event_id: "activation-42",
        session_id: "openclaw/openclaw#42:100:2026-07-17T10:00:00Z",
      })
    ).status,
    503,
  );
  assert.equal(await statusStore.get("events"), null);
  assert.equal(await statusStore.get("latest-event"), null);
});

test("automerge metric events use isolated durable keys and aggregate through the API", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace({
    fetch: (request: Request, init?: RequestInit) =>
      store.fetch(init ? new Request(request, init) : request),
  });
  const token = ["test", "token"].join("-");
  const env = { INGEST_TOKEN: token, STATUS_STORE: namespace };
  const occurredAt = new Date().toISOString();
  for (const eventId of ["terminal-1", "terminal-2"]) {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.automerge_metric",
          event_id: eventId,
          session_id: `openclaw/openclaw#42:${eventId}:${occurredAt}`,
          repository: "openclaw/openclaw",
          item_number: 42,
          phase: "terminal",
          outcome: "merged",
          occurred_at: occurredAt,
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
  }
  const duplicate = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "clawsweeper.automerge_metric",
        event_id: "terminal-1",
        session_id: `openclaw/openclaw#42:terminal-1:${occurredAt}`,
        repository: "openclaw/openclaw",
        item_number: 42,
        phase: "terminal",
        outcome: "maintainer_stopped",
        occurred_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    }),
    env,
  );
  assert.equal(duplicate.status, 200);

  assert.equal(storage.rawHas("automerge-product-metrics:v1"), false);
  assert.equal(storage.rawHas("automerge-product-metrics:v1:id:terminal-1"), true);
  assert.equal(storage.rawHas("automerge-product-metrics:v1:id:terminal-2"), true);
  const metrics = await (
    await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/automerge-metrics?range=6h"),
      env,
    )
  ).json();
  assert.equal(metrics.summary.terminal_sessions, 2);
  assert.equal(metrics.summary.merged_sessions, 2);
});

test("apply observability accepts signed durable events and exposes the API summary", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace({
    fetch: (request: Request, init?: RequestInit) =>
      store.fetch(init ? new Request(request, init) : request),
  });
  const secret = "apply-observability-secret";
  const now = new Date().toISOString();
  const body = JSON.stringify({
    event: {
      schema_version: 1,
      repo: "openclaw/openclaw",
      run_id: "98765",
      run_attempt: 1,
      occurred_at: now,
      started_at: now,
      lifecycle_started: true,
      outcome: "success",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/98765",
      queue: {
        active: 1,
        capacity: 1,
        ready: 2,
        backoff: null,
        dispatching: 0,
        leased: null,
        oldest_ready_age_seconds: 60,
        oldest_backoff_age_seconds: null,
        oldest_lease_age_seconds: null,
      },
      arrivals: null,
      results: { applied: 2, closed: 1, superseded: null, retried: null, dead_lettered: null },
      lease: { wait_ms: null, hold_ms: null },
      observed_failure_kinds: ["safe_close_blocked"],
      failures: [{ kind: "safe_close_blocked", at: now }],
    },
  });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const env = {
    STATUS_STORE: namespace,
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    APPLY_TARGET_REPOS: "openclaw/openclaw",
    APPLY_OPTIONAL_TARGET_REPOS: "openclaw/clawhub",
  };
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/apply-observability", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
    }),
    env,
  );
  assert.equal(accepted.status, 200);
  const summary = await (
    await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/apply-observability?range=24h"),
      env,
    )
  ).json();
  assert.equal(summary.event_count, 1);
  assert.equal(summary.queue.ready, 2);
  assert.equal(summary.last_60_minutes.closed, 1);
  assert.equal(summary.failures.safe_close_blocked, 1);
  assert.deepEqual(
    summary.repositories.map((entry) => entry.repo),
    ["openclaw/openclaw"],
  );

  const staleClawhubPayload = JSON.parse(body);
  staleClawhubPayload.event.repo = "openclaw/clawhub";
  staleClawhubPayload.event.run_id = "98766";
  staleClawhubPayload.event.occurred_at = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  staleClawhubPayload.event.started_at = new Date(
    Date.now() - 7 * 60 * 60 * 1000 - 60_000,
  ).toISOString();
  const staleClawhubBody = JSON.stringify(staleClawhubPayload);
  const staleClawhubSignature = `sha256=${createHmac("sha256", secret).update(staleClawhubBody).digest("hex")}`;
  const staleClawhubAccepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/apply-observability", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": staleClawhubSignature,
      },
      body: staleClawhubBody,
    }),
    env,
  );
  assert.equal(staleClawhubAccepted.status, 200);
  const withoutStaleClawhub = await (
    await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/apply-observability?range=6h"),
      env,
    )
  ).json();
  assert.deepEqual(
    withoutStaleClawhub.repositories.map((entry) => entry.repo),
    ["openclaw/openclaw"],
  );

  const runningClawhubPayload = JSON.parse(body);
  runningClawhubPayload.event.repo = "openclaw/clawhub";
  runningClawhubPayload.event.run_id = "987661";
  runningClawhubPayload.event.outcome = "in_progress";
  runningClawhubPayload.event.lifecycle_started = true;
  runningClawhubPayload.event.occurred_at = new Date(
    Date.now() - 6.5 * 60 * 60 * 1000,
  ).toISOString();
  runningClawhubPayload.event.started_at = runningClawhubPayload.event.occurred_at;
  const runningClawhubBody = JSON.stringify(runningClawhubPayload);
  const runningClawhubSignature = `sha256=${createHmac("sha256", secret).update(runningClawhubBody).digest("hex")}`;
  const runningClawhubAccepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/apply-observability", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": runningClawhubSignature,
      },
      body: runningClawhubBody,
    }),
    env,
  );
  assert.equal(runningClawhubAccepted.status, 200);
  const withRunningClawhub = await (
    await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/apply-observability?range=6h"),
      env,
    )
  ).json();
  assert.deepEqual(
    withRunningClawhub.repositories.map((entry) => entry.repo),
    ["openclaw/openclaw", "openclaw/clawhub"],
  );
  assert.equal(withRunningClawhub.telemetry_complete, true);

  const currentClawhubPayload = JSON.parse(body);
  currentClawhubPayload.event.repo = "openclaw/clawhub";
  currentClawhubPayload.event.run_id = "98767";
  const clawhubBody = JSON.stringify(currentClawhubPayload);
  const clawhubSignature = `sha256=${createHmac("sha256", secret).update(clawhubBody).digest("hex")}`;
  const clawhubAccepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/apply-observability", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": clawhubSignature,
      },
      body: clawhubBody,
    }),
    env,
  );
  assert.equal(clawhubAccepted.status, 200);
  const withClawhub = await (
    await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/apply-observability?range=24h"),
      env,
    )
  ).json();
  assert.deepEqual(
    withClawhub.repositories.map((entry) => entry.repo),
    ["openclaw/openclaw", "openclaw/clawhub"],
  );
  assert.equal(withClawhub.telemetry_complete, true);
});

test("dashboard durable status store persists, expires, and prepends events", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const key = "https://clawsweeper-status-store/snapshot";

  assert.equal((await store.fetch(new Request(key))).status, 404);
  assert.equal(
    (
      await store.fetch(
        new Request(key, {
          method: "PUT",
          body: JSON.stringify({ value: "ready" }),
        }),
      )
    ).status,
    204,
  );
  assert.equal(await (await store.fetch(new Request(key))).text(), "ready");

  await store.fetch(
    new Request("https://clawsweeper-status-store/expired", {
      method: "PUT",
      body: JSON.stringify({ value: "old", expires_at: Date.now() - 1 }),
    }),
  );
  assert.equal(
    (await store.fetch(new Request("https://clawsweeper-status-store/expired"))).status,
    404,
  );

  for (const id of ["first", "second"]) {
    assert.equal(
      (
        await store.fetch(
          new Request("https://clawsweeper-status-store/events", {
            method: "POST",
            body: JSON.stringify({ event: { id }, limit: 2, ttl_seconds: 60 }),
          }),
        )
      ).status,
      200,
    );
  }
  assert.deepEqual(
    JSON.parse(
      await (await store.fetch(new Request("https://clawsweeper-status-store/events"))).text(),
    ),
    [{ id: "second" }, { id: "first" }],
  );

  const bayStoreUrl = `https://clawsweeper-status-store/${encodeURIComponent(
    "openclaw-bay:terminal-state:v1",
  )}`;
  for (const number of [501, 502]) {
    const response = await store.fetch(
      new Request(bayStoreUrl, {
        method: "POST",
        body: JSON.stringify({
          attempts: [
            {
              run_id: number,
              job_id: number,
              repository: "openclaw/openclaw",
              item_numbers: [number],
              outcome: "success",
              terminal_outcome: "success",
              completed_at: `2026-07-11T12:00:${String(number - 500).padStart(2, "0")}Z`,
            },
          ],
          closed_items: [],
          generated_at: `2026-07-11T12:00:${String(number - 500).padStart(2, "0")}Z`,
          ttl_seconds: 60,
        }),
      }),
    );
    assert.equal(response.status, 200);
  }
  const persistedBay = JSON.parse(await (await store.fetch(new Request(bayStoreUrl))).text());
  const bayPutsBeforeReplay = storage.putCount("openclaw-bay:terminal-state:v1");
  const replay = await store.fetch(
    new Request(bayStoreUrl, {
      method: "POST",
      body: JSON.stringify({
        attempts: [
          {
            run_id: 502,
            job_id: 502,
            repository: "openclaw/openclaw",
            item_numbers: [502],
            outcome: "success",
            terminal_outcome: "success",
            completed_at: "2026-07-11T12:00:02Z",
          },
        ],
        closed_items: [],
        generated_at: "2026-07-11T12:00:03Z",
        ttl_seconds: 60,
      }),
    }),
  );
  assert.equal(replay.status, 200);
  assert.equal(storage.putCount("openclaw-bay:terminal-state:v1"), bayPutsBeforeReplay);
  assert.equal(JSON.parse(await replay.text()).updated_at, persistedBay.updated_at);
  assert.deepEqual(
    persistedBay.terminal_buffer.map((item: { number: number }) => item.number),
    [501, 502],
  );

  await store.fetch(
    new Request("https://clawsweeper-status-store/events", {
      method: "PUT",
      body: JSON.stringify({
        value: JSON.stringify([{ id: "expired" }]),
        expires_at: Date.now() - 1,
      }),
    }),
  );
  await store.fetch(
    new Request("https://clawsweeper-status-store/events", {
      method: "POST",
      body: JSON.stringify({ event: { id: "fresh" }, limit: 2, ttl_seconds: 60 }),
    }),
  );
  assert.deepEqual(
    JSON.parse(
      await (await store.fetch(new Request("https://clawsweeper-status-store/events"))).text(),
    ),
    [{ id: "fresh" }],
  );

  await store.fetch(
    new Request("https://clawsweeper-status-store/cold-expired", {
      method: "PUT",
      body: JSON.stringify({ value: "old", expires_at: Date.now() - 1 }),
    }),
  );
  assert.equal(storage.has("cold-expired"), true);
  await store.alarm();
  assert.equal(storage.has("cold-expired"), false);
});

test("dashboard reuses a current Bay snapshot from the shared status store", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      bay: {
        timings: { sample_kind: "completed_review_journeys" },
      },
      pipeline: [{ id: "shared-snapshot" }],
    }),
  );
  let networkRequests = 0;
  globalThis.fetch = async () => {
    networkRequests += 1;
    throw new Error("shared snapshot should avoid GitHub requests");
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CACHE_TTL_SECONDS: "60",
        STATUS_STORE: statusStore,
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pipeline[0].id, "shared-snapshot");
    assert.equal(networkRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard health history persists five-minute samples and serves a bounded range", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace(store);
  const sample = {
    at: new Date().toISOString(),
    status: "degraded",
    queued: 12,
    queued_over_30m: 4,
    oldest_queued_minutes: 75,
    running: 3,
    running_over_150m: 0,
    oldest_running_minutes: 40,
    collection_ok: true,
    exact_review: {
      collection_ok: true,
      review: { pending: 317 },
      publication: { pending: 1502 },
    },
  };

  for (const queued of [12, 14]) {
    const response = await store.fetch(
      new Request("https://clawsweeper-status-store/health-history", {
        method: "POST",
        body: JSON.stringify({ sample: { ...sample, queued } }),
      }),
    );
    assert.equal(response.status, 200);
  }

  await store.fetch(
    new Request("https://clawsweeper-status-store/health-history", {
      method: "POST",
      body: JSON.stringify({
        sample: { ...sample, at: new Date(Date.now() - 8 * 60 * 60_000).toISOString(), queued: 3 },
      }),
    }),
  );

  const sixHourResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/health-history?range=6h"),
    { STATUS_STORE: namespace },
  );
  const sixHourHistory = await sixHourResponse.json();
  assert.equal(sixHourResponse.status, 200);
  assert.equal(sixHourHistory.range, "6h");
  assert.equal(sixHourHistory.retention_days, 7);
  assert.equal(sixHourHistory.samples.length, 1);
  assert.equal(sixHourHistory.samples[0].queued, 14);
  assert.equal(sixHourHistory.samples[0].exact_review.review.pending, 317);

  for (const [query, expectedRange] of [
    ["24h", "24h"],
    ["7d", "7d"],
    ["invalid", "24h"],
  ]) {
    const response = await worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai/api/health-history?range=${query}`),
      { STATUS_STORE: namespace },
    );
    const history = await response.json();
    assert.equal(history.range, expectedRange);
    assert.equal(history.samples.length, 2);
  }
});

test("dashboard cron records only exact-review history without GitHub queries", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace(store);
  const requests: string[] = [];
  let queueReads = 0;
  const exactReviewQueue = {
    idFromName: () => "global",
    get: () => ({
      fetch: async () => {
        queueReads += 1;
        return jsonResponse({
          handoff_health: { status: "healthy" },
          lanes: {
            review: {
              pending: 17,
              enqueued_total: 101,
              completed_total: 83,
              shed_since_reset: 5,
            },
            publication: { pending: 29, enqueued_total: 157, completed_total: 123 },
          },
        });
      },
    }),
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    assert.equal(url.pathname, "/repos/openclaw/clawsweeper/actions/runs");
    const status = url.searchParams.get("status");
    return jsonResponse({
      workflow_runs:
        status === "queued"
          ? Array.from({ length: 100 }, (_, index) => ({
              id: 9001 + index,
              name: "repair cluster worker",
              display_title: "repair cluster worker",
              status: "queued",
              created_at: isoAgo((index === 0 ? 40 : 10) * 60_000),
            }))
          : [],
    });
  };
  let recording: Promise<unknown> | undefined;
  try {
    await worker.scheduled(
      {},
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        EXACT_REVIEW_QUEUE: exactReviewQueue,
        STATUS_STORE: namespace,
      },
      { waitUntil: (promise) => (recording = promise) },
    );
    await recording;
    assert.equal(requests.length, 0);
    assert.equal(queueReads, 1);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/health-history?range=24h"),
      { STATUS_STORE: namespace },
    );
    const history = await response.json();
    assert.equal(history.samples.length, 1);
    assert.equal(history.samples[0].status, undefined);
    assert.equal(history.samples[0].queued, undefined);
    assert.equal(history.samples[0].exact_review.collection_ok, true);
    assert.equal(history.samples[0].exact_review.review.pending, 17);
    assert.equal(history.samples[0].exact_review.review.enqueued_total, 101);
    assert.equal(history.samples[0].exact_review.review.completed_total, 83);
    assert.equal(history.samples[0].exact_review.review.shed_total, 5);
    assert.equal(history.samples[0].exact_review.publication.pending, 29);
    assert.equal(history.samples[0].exact_review.publication.enqueued_total, 157);
    assert.equal(history.samples[0].exact_review.publication.completed_total, 123);

    let failureRecording: Promise<unknown> | undefined;
    await worker.scheduled(
      {},
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        EXACT_REVIEW_QUEUE: {
          idFromName: () => "global",
          get: () => ({ fetch: async () => Promise.reject(new Error("queue unavailable")) }),
        },
        STATUS_STORE: namespace,
      },
      { waitUntil: (promise) => (failureRecording = promise) },
    );
    await failureRecording;
    const afterFailure = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/health-history?range=6h"),
      { STATUS_STORE: namespace },
    );
    const failedQueueHistory = await afterFailure.json();
    assert.equal(failedQueueHistory.samples.length, 1);
    assert.equal(failedQueueHistory.samples[0].queued, undefined);
    assert.deepEqual(failedQueueHistory.samples[0].exact_review, { collection_ok: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("optional exact-review telemetry failures do not freeze an idle status snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      bay: { timings: { sample_kind: "completed_review_journeys" } },
      pipeline: [],
      fleet: { active_workflow_runs: 0 },
      diagnostics: { errors: [] },
    }),
  );
  globalThis.fetch = async () => {
    throw new Error("shared snapshot should avoid GitHub requests");
  };
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  let queueReads = 0;
  const queueWithUnavailableAggregate = {
    fetch: async (request: Request) => {
      queueReads += 1;
      if (new URL(request.url).pathname === "/recent-durable-publication-events") {
        return new Response(JSON.stringify({ error: "queue_read_failed" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return queue.fetch(request);
    },
  };
  const env = {
    CACHE_TTL_SECONDS: "60",
    STATUS_STORE: statusStore,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queueWithUnavailableAggregate),
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.exact_review_queue.pending, 0);
    assert.equal(status.recent_durable_publication_events, null);
    assert.deepEqual(status.diagnostics.errors, []);
    assert.equal(status.diagnostics.exact_review_queue_error, null);
    assert.equal(status.diagnostics.recent_durable_publication_events_error, "queue_read_failed");

    const cached = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.headers.get("x-clawsweeper-cache"), "fresh");
    const cachedStatus = await cached.json();
    assert.equal(cachedStatus.exact_review_queue.pending, 0);
    assert.equal(cachedStatus.diagnostics.exact_review_queue_error, null);
    assert.equal(
      cachedStatus.diagnostics.recent_durable_publication_events_error,
      "queue_read_failed",
    );
    assert.equal(queueReads, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("exact-review queue coalesces deliveries, dispatches a bound rollout snapshot, and rejects duplicate claims", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  let workflowState = "disabled_manually";
  let signalWorkflowCheckStarted!: () => void;
  let releaseWorkflowCheck!: () => void;
  const workflowCheckStarted = new Promise<void>((resolve) => {
    signalWorkflowCheckStarted = resolve;
  });
  const workflowCheckRelease = new Promise<void>((resolve) => {
    releaseWorkflowCheck = resolve;
  });
  let wroteActiveLease = false;
  const storagePut = storage.put.bind(storage);
  storage.put = async (key, value) => {
    if (key === "exact-review-queue") {
      const snapshot = value as { items?: Record<string, { state?: string }> };
      wroteActiveLease ||= Object.values(snapshot.items || {}).some(
        (item) => item.state === "dispatching" || item.state === "leased",
      );
    }
    await storagePut(key, value);
  };
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      signalWorkflowCheckStarted();
      await workflowCheckRelease;
      return jsonResponse({ state: workflowState });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname)) {
      return jsonResponse({ id: 999 });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname)) {
      return jsonResponse({ state: "open" });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer dispatch-token");
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
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "1",
      },
    );
    const commandStatusMarker =
      "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
    const first = buildExactReviewQueueRequest("delivery-1", 597, "opened", "issue", undefined, {
      commandStatusMarker,
      statusCommentId: 9001,
      additionalPrompt: "Check the maintainer-requested regression path.",
      codexTimeoutMs: 1_200_000,
      mediaProofTimeoutMs: 480_000,
    });
    const duplicate = first.clone();
    const latest = buildExactReviewQueueRequest("delivery-2", 597, "edited");
    const second = buildExactReviewQueueRequest("delivery-3", 598, "opened");
    assert.equal((await queue.fetch(duplicate)).status, 202);
    assert.equal((await queue.fetch(latest)).status, 202);
    assert.equal((await queue.fetch(second)).status, 202);
    assert.equal((await queue.fetch(first)).status, 202);

    const alarm = queue.alarm();
    await workflowCheckStarted;
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-during-preflight", 600, "opened")))
        .status,
      202,
    );
    releaseWorkflowCheck();
    await alarm;
    let stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 3);
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.dispatcher.state, "paused");
    assert.equal(stats.dispatcher.reason, "workflow_not_active");
    assert.equal(stats.dispatcher.workflow_state, "disabled_manually");
    assert.equal(wroteActiveLease, false);
    assert.equal(dispatched.length, 0);

    const pausedState = (await storage.get("exact-review-queue")) as {
      dispatcher: { retryAt: number };
      items: Record<string, { nextAttemptAt: number }>;
    };
    assert.ok(
      Object.values(pausedState.items).some(
        (item) => item.nextAttemptAt < pausedState.dispatcher.retryAt,
      ),
    );
    // Simulate the pre-repair persisted state, which moved the whole backlog
    // to the dispatcher retry. At the scheduled wake, recovery must not need
    // an operator rewrite.
    pausedState.dispatcher.retryAt = Date.now() - 1;
    for (const item of Object.values(pausedState.items)) {
      item.nextAttemptAt = pausedState.dispatcher.retryAt;
    }
    await storage.put("exact-review-queue", pausedState);
    workflowState = "active";
    await queue.alarm();
    assert.equal(dispatched.length, 1);
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.dispatching, 1);
    assert.equal(stats.leased, 0);
    assert.equal(stats.handoff_health.status, "healthy");
    assert.equal(stats.handoff_health.phases.dispatching.count, 1);
    assert.equal(typeof stats.oldest_dispatching_age_seconds, "number");
    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm > Date.now() + 60_000);
    const payload = dispatched[0].client_payload as Record<string, unknown>;
    const leaseId = String(payload.queue_lease_id || "");
    assert.match(leaseId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(payload, {
      queue_lease_id: leaseId,
      queue_claim: {
        protocol_version: 2,
        item_key: "openclaw/gogcli#597",
        lease_revision: 2,
      },
      target_repo: "openclaw/gogcli",
      target_branch: "main",
      item_number: 597,
      item_kind: "issue",
      source_event: "issues",
      source_action: "edited",
      supersedes_in_progress: true,
      review_options: {
        codex_timeout_ms: 1_200_000,
        media_proof_timeout_ms: 480_000,
        command_status_marker: commandStatusMarker,
        status_comment_id: 9001,
        additional_prompt: "Check the maintainer-requested regression path.",
      },
    });
    assert.equal(Object.keys(payload).length, 10);

    const newer = buildExactReviewQueueRequest("delivery-4", 597, "synchronize", "pull_request");
    assert.equal((await queue.fetch(newer)).status, 202);

    const claimed = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: "openclaw/gogcli#597",
          lease_revision: 2,
          run_id: "100",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(claimed.status, 409);
    assert.deepEqual(await claimed.json(), { error: "lease_not_active" });
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.leased, 0);
    const requeued = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          revision: number;
          attempts: number;
          nextAttemptAt: number;
          decision: Record<string, unknown>;
        }
      >;
    };
    assert.equal(requeued.items["openclaw/gogcli#597"].state, "pending");
    assert.equal(requeued.items["openclaw/gogcli#597"].revision, 3);
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.commandStatusMarker, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.statusCommentId, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.additionalPrompt, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].attempts, 0);
    assert.ok(requeued.items["openclaw/gogcli#597"].nextAttemptAt <= Date.now());
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 3);
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.leased, 0);
    assert.match(String(stats.oldest_pending_at), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue resolves a closed item before dispatch", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "closed" }));
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("terminal-item", 597, "opened")))
        .status,
      202,
    );

    await harness.queue.alarm();

    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(harness.dispatched.length, 0);
    assert.equal(stats.pending, 0);
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.lanes.review.completed_total, 1);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items["openclaw/gogcli#597"], undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review queue dispatches a closed command item to complete its acknowledgement", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "closed" }));
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("terminal-command-item", 597, "opened", "issue", undefined, {
            commandStatusMarker,
            statusCommentId: 9001,
          }),
        )
      ).status,
      202,
    );
    const seeded = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          attempts: number;
          reviewFailureAttempts?: number;
          dispatchFailureStatus?: number;
          dispatchFailureClass?: string;
          dispatchFailureAt?: number;
          dispatchFailureFingerprint?: string;
        }
      >;
    };
    Object.assign(seeded.items["openclaw/gogcli#597"]!, {
      attempts: 1,
      reviewFailureAttempts: 1,
      dispatchFailureStatus: 503,
      dispatchFailureClass: "github_outage",
      dispatchFailureAt: 1_785_000_000_000,
      dispatchFailureFingerprint: "github_outage:503:upstream",
    });
    await harness.storage.put("exact-review-queue", seeded);

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 1);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          leaseDecision?: { commandStatusMarker?: string; statusCommentId?: number };
        }
      >;
    };
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "dispatching");
    assert.equal(
      state.items["openclaw/gogcli#597"]?.leaseDecision?.commandStatusMarker,
      commandStatusMarker,
    );
    assert.equal(state.items["openclaw/gogcli#597"]?.leaseDecision?.statusCommentId, 9001);
  } finally {
    harness.restore();
  }
});

test("exact-review queue limits live admission probes to one bounded pass", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-24T23:45:00.000Z");
  Date.now = () => now;
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    { maxConcurrent: "16" },
  );
  try {
    for (let index = 0; index < 10; index += 1) {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(
              `bounded-admission-${index}`,
              700 + index,
              "opened",
              "issue",
            ),
          )
        ).status,
        202,
      );
    }

    await harness.queue.alarm();

    assert.equal(liveChecks, 4);
    assert.equal(harness.dispatched.length, 0);
    let stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 6);
    assert.equal(stats.lanes.review.completed_total, 4);
    assert.equal(await harness.storage.getAlarm(), now + 5_000);

    await harness.queue.alarm();

    assert.equal(liveChecks, 4);
    now += 5_000;
    await harness.queue.alarm();

    assert.equal(liveChecks, 8);
    stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 2);
    assert.equal(stats.lanes.review.completed_total, 8);

    now += 5_000;
    await harness.queue.alarm();

    assert.equal(liveChecks, 10);
    stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 0);
    assert.equal(stats.lanes.review.completed_total, 10);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review queue throttles partial terminal admission passes", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-24T23:50:00.000Z");
  Date.now = () => now;
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    { maxConcurrent: "1" },
  );
  try {
    for (let index = 0; index < 2; index += 1) {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(`partial-admission-${index}`, 800 + index, "opened"),
          )
        ).status,
        202,
      );
    }

    await harness.queue.alarm();

    assert.equal(liveChecks, 1);
    assert.equal(await harness.storage.getAlarm(), now + 5_000);
    await harness.queue.alarm();
    assert.equal(liveChecks, 1);

    now += 5_000;
    await harness.queue.alarm();
    assert.equal(liveChecks, 2);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review queue resolves missing target responses before dispatch", async () => {
  for (const status of [404, 410]) {
    const harness = createExactReviewAdmissionHarness(() => new Response(null, { status }));
    try {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(`missing-item-${status}`, 597, "opened"),
          )
        ).status,
        202,
      );

      await harness.queue.alarm();

      const stats = await (
        await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
      ).json();
      assert.equal(harness.dispatched.length, 0);
      assert.equal(stats.pending, 0);
      assert.equal(stats.dispatching, 0);
    } finally {
      harness.restore();
    }
  }
});

test("exact-review queue terminalizes every admitted ordinary publication before legacy dispatch", async () => {
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    (_targetRepo, itemNumber) => {
      liveChecks += 1;
      return jsonResponse({ state: itemNumber === 9215 ? "closed" : "open" });
    },
    { maxConcurrent: "16" },
  );
  try {
    for (let itemNumber = 9211; itemNumber <= 9215; itemNumber += 1) {
      const itemKind = itemNumber === 9215 ? "pull_request" : "issue";
      const publication = exactReviewPublicationOverrides(
        itemNumber,
        String(itemNumber * 10),
        "opened",
        1,
        "openclaw/gogcli",
      );
      if (itemKind === "pull_request") {
        publication.publication.producerDecision.itemKind = "pull_request";
        publication.publication.producerDecision.sourceEvent = "pull_request";
      }
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(
              `legacy-terminal-${itemNumber}`,
              itemNumber,
              "exact_review_artifact_publish",
              itemKind,
              "openclaw/gogcli",
              publication,
            ),
          )
        ).status,
        202,
      );
    }

    await harness.queue.alarm();

    // The legacy admission can contain more rows than the four-review probe.
    // Its fifth item is a merged pull request and must never be dispatched.
    assert.equal(liveChecks, 5);
    assert.equal(harness.dispatched.length, 4);
    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.completed_total, 1);
    assert.equal(stats.lanes.publication.superseded_total, 1);
    const terminal = await (
      await harness.queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=openclaw%2Fgogcli&item_number=9215",
        ),
      )
    ).json();
    assert.equal(terminal.items.length, 0);
  } finally {
    harness.restore();
  }
});

test("terminal publication cleanup does not block review admission in the same alarm", async () => {
  const publicationNumber = 9220;
  const reviewNumber = 9221;
  const harness = createExactReviewAdmissionHarness(
    (_targetRepo, itemNumber) =>
      jsonResponse({ state: itemNumber === publicationNumber ? "closed" : "open" }),
    {
      maxConcurrent: "1",
      publicationBatching: true,
      publicationBatchSize: "1",
      captureBatchDispatch: true,
    },
  );
  try {
    await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "terminal-publication-ahead-of-review",
        publicationNumber,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(publicationNumber, "92200"),
      ),
    );
    await harness.queue.fetch(
      buildExactReviewQueueRequest("review-behind-terminal-publication", reviewNumber, "opened"),
    );

    await harness.queue.alarm();

    assert.equal(harness.batchDispatches, 0);
    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]?.client_payload.item_number, reviewNumber);
    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.completed_total, 1);
    assert.equal(stats.lanes.review.dispatching, 1);
  } finally {
    harness.restore();
  }
});

test("publication reconcile terminalizes a completed protocol-v1 publication after its target closes", async () => {
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(() => {
    liveChecks += 1;
    return jsonResponse({ state: "closed" });
  });
  const itemNumber = 9301;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560737:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-terminal",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(itemNumber, "30091560737"),
          ),
        )
      ).status,
      202,
    );

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 1);
    assert.equal(reconciled.changed, 1);
    assert.equal(reconciled.legacy_terminal_eligible, 1);
    assert.equal(reconciled.legacy_terminal_changed, 1);
    assert.equal(reconciled.eligible_remaining, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items[itemKey], undefined);
  } finally {
    harness.restore();
  }
});

test("publication reconcile dry runs verify terminal legacy rows without deleting them", async () => {
  let terminal = false;
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(() => {
    liveChecks += 1;
    return jsonResponse({ state: terminal ? "closed" : "open" });
  });
  const itemNumber = 9307;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560744:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-dry-run",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(itemNumber, "30091560744"),
          ),
        )
      ).status,
      202,
    );

    const reconcile = () =>
      harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: false, max_items: 100 }),
        }),
      );
    const openResult = await (await reconcile()).json();
    assert.equal(liveChecks, 1);
    assert.equal(openResult.legacy_terminal_candidates, 1);
    assert.equal(openResult.legacy_terminal_selected, 1);
    assert.equal(openResult.legacy_terminal_eligible, 0);
    assert.equal(openResult.changed, 0);

    terminal = true;
    const terminalResult = await (await reconcile()).json();
    assert.equal(liveChecks, 2);
    assert.equal(terminalResult.legacy_terminal_eligible, 1);
    assert.equal(terminalResult.changed, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(state.items[itemKey]);
  } finally {
    harness.restore();
  }
});

test("publication reconcile terminalizes a closed legacy publication after its lease expires", async () => {
  let liveChecks = 0;
  let probeState: string | undefined;
  const harness = createExactReviewAdmissionHarness(async () => {
    liveChecks += 1;
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { state: string }>;
    };
    probeState = state.items[itemKey]?.state;
    return jsonResponse({ state: "closed" });
  });
  const itemNumber = 9306;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560743:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-expired-lease",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(itemNumber, "30091560743"),
          ),
        )
      ).status,
      202,
    );
    const stored = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    const item = stored.items[itemKey]!;
    Object.assign(item, {
      state: "leased",
      leaseId: "expired-legacy-lease",
      leaseRevision: 1,
      leaseExpiresAt: Date.now() - 1,
      claimedRunId: "9306",
      claimedAt: Date.now() - 60_000,
      leaseDecision: item.decision,
    });
    await harness.storage.put("exact-review-queue", stored);

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 1);
    assert.equal(probeState, "pending");
    assert.equal(reconciled.changed, 1);
    const after = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(after.items[itemKey], undefined);
  } finally {
    harness.restore();
  }
});

test("publication reconcile retains a legacy command publication awaiting acknowledgement", async () => {
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(() => {
    liveChecks += 1;
    return jsonResponse({ state: "closed" });
  });
  const itemNumber = 9302;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560738:1`;
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:9302:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-command-awaiting-ack",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            {
              ...legacyExactReviewPublicationOverrides(itemNumber, "30091560738"),
              commandStatusMarker,
            },
          ),
        )
      ).status,
      202,
    );

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 0);
    assert.equal(reconciled.changed, 0);
    assert.equal(reconciled.legacy_terminal_eligible, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { commandStatusMarker?: string } }>;
    };
    assert.equal(state.items[itemKey]?.decision.commandStatusMarker, commandStatusMarker);
  } finally {
    harness.restore();
  }
});

test("publication reconcile preserves a legacy publication owned by an active batch", async () => {
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    { publicationBatching: true },
  );
  const itemNumber = 9303;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560739:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-active-batch",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(itemNumber, "30091560739"),
          ),
        )
      ).status,
      202,
    );
    const claim = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({
            claim_id: "legacy-v1-active-batch",
            lease_owner: "legacy-v1-owner",
            max_items: 1,
          }),
        }),
      )
    ).json();
    assert.equal(claim.claimed, true);

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 0);
    assert.equal(reconciled.changed, 0);
    assert.equal(reconciled.legacy_terminal_eligible, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(state.items[itemKey]);
  } finally {
    harness.restore();
  }
});

test("publication reconcile preserves active legacy leases and newer publication authority", async () => {
  let terminal = false;
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(() => {
    liveChecks += 1;
    return jsonResponse({ state: terminal ? "closed" : "open" });
  });
  const leasedItemNumber = 9304;
  const leasedItemKey = `openclaw/gogcli#${leasedItemNumber}@publish:30091560740:1`;
  const supersededItemNumber = 9305;
  const supersededItemKey = `openclaw/gogcli#${supersededItemNumber}@publish:30091560741:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-active-lease",
            leasedItemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(leasedItemNumber, "30091560740"),
          ),
        )
      ).status,
      202,
    );
    await harness.queue.alarm();
    const dispatched = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId?: string }>;
    };
    const leaseId = dispatched.items[leasedItemKey]?.leaseId;
    assert.ok(leaseId);
    assert.equal(
      (
        await harness.queue.fetch(
          new Request("https://clawsweeper-exact-review-queue/claim", {
            method: "POST",
            body: JSON.stringify({ lease_id: leaseId, run_id: "9304" }),
          }),
        )
      ).status,
      200,
    );

    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-newer-authority",
            supersededItemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(supersededItemNumber, "30091560741"),
          ),
        )
      ).status,
      202,
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "v2-newer-authority",
            supersededItemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(supersededItemNumber, "30091560742", "opened", 2),
          ),
        )
      ).status,
      202,
    );

    terminal = true;
    const checksBeforeReconcile = liveChecks;
    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, checksBeforeReconcile);
    assert.equal(reconciled.changed, 0);
    assert.equal(reconciled.legacy_terminal_eligible, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { state: string }>;
    };
    assert.equal(state.items[leasedItemKey]?.state, "leased");
    assert.ok(state.items[supersededItemKey]);
  } finally {
    harness.restore();
  }
});

test("publication reconcile terminalizes a completed protocol-v2 state-batch publication after its target closes", async () => {
  let liveChecks = 0;
  const producerChecks: Array<[string, number | null, string]> = [];
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    {
      producerRun: (runId, runAttempt, kind) => {
        producerChecks.push([runId, runAttempt, kind]);
        return jsonResponse({
          id: runId,
          run_attempt: 1,
          status: "completed",
          ...(kind === "attempt" ? { conclusion: "success" } : {}),
        });
      },
    },
  );
  const itemNumber = 113313;
  const producerRunId = "30091560737";
  const itemKey = `openclaw/openclaw#${itemNumber}@publish:${producerRunId}:1`;
  const rootPublication = exactReviewPublicationOverrides(
    itemNumber,
    producerRunId,
    "synchronize",
    1,
    "openclaw/openclaw",
  );
  rootPublication.publication.producerDecision = {
    ...rootPublication.publication.producerDecision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
  };
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v2-state-batch-terminal",
            itemNumber,
            "exact_review_artifact_publish",
            "pull_request",
            "openclaw/openclaw",
            rootPublication,
          ),
        )
      ).status,
      202,
    );

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.deepEqual(producerChecks, [
      [producerRunId, null, "summary"],
      [producerRunId, 1, "attempt"],
    ]);
    assert.equal(liveChecks, 1);
    assert.equal(reconciled.changed, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_candidates, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_selected, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_producer_succeeded, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_eligible, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_changed, 1);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items[itemKey], undefined);
  } finally {
    harness.restore();
  }
});

test("publication reconcile retains a protocol-v2 command publication awaiting acknowledgement", async () => {
  let liveChecks = 0;
  let producerChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    {
      producerRun: () => {
        producerChecks += 1;
        return jsonResponse({ id: "30091560738", run_attempt: 1, status: "completed" });
      },
    },
  );
  const itemNumber = 9313;
  const producerRunId = "30091560738";
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:${producerRunId}:1`;
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:9313:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v2-command-awaiting-ack",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            {
              ...exactReviewPublicationOverrides(itemNumber, producerRunId),
              commandStatusMarker,
            },
          ),
        )
      ).status,
      202,
    );

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 0);
    assert.equal(producerChecks, 0);
    assert.equal(reconciled.changed, 0);
    assert.equal(reconciled.legacy_state_batch_terminal_candidates, 0);
    assert.equal(reconciled.legacy_state_batch_terminal_eligible, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { commandStatusMarker?: string } }>;
    };
    assert.equal(state.items[itemKey]?.decision.commandStatusMarker, commandStatusMarker);
  } finally {
    harness.restore();
  }
});

test("publication reconcile preserves protocol-v2 state-batch rows owned by an active batch or lease", async () => {
  let batchLiveChecks = 0;
  let batchProducerChecks = 0;
  const batchHarness = createExactReviewAdmissionHarness(
    () => {
      batchLiveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    {
      publicationBatching: true,
      producerRun: () => {
        batchProducerChecks += 1;
        return jsonResponse({ id: "30091560739", run_attempt: 1, status: "completed" });
      },
    },
  );
  const batchItemNumber = 9314;
  const batchItemKey = `openclaw/gogcli#${batchItemNumber}@publish:30091560739:1`;
  try {
    assert.equal(
      (
        await batchHarness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v2-active-batch",
            batchItemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(batchItemNumber, "30091560739"),
          ),
        )
      ).status,
      202,
    );
    const claim = await (
      await batchHarness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({
            claim_id: "legacy-v2-active-batch",
            lease_owner: "legacy-v2-owner",
            max_items: 1,
          }),
        }),
      )
    ).json();
    assert.equal(claim.claimed, true);
    const batchReconciled = await (
      await batchHarness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();
    assert.equal(batchLiveChecks, 0);
    assert.equal(batchProducerChecks, 0);
    assert.equal(batchReconciled.changed, 0);
    assert.equal(batchReconciled.legacy_state_batch_terminal_candidates, 0);
    const batchState = (await batchHarness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(batchState.items[batchItemKey]);
  } finally {
    batchHarness.restore();
  }

  let leaseLiveChecks = 0;
  let leaseProducerChecks = 0;
  const leaseHarness = createExactReviewAdmissionHarness(
    () => {
      leaseLiveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    {
      producerRun: () => {
        leaseProducerChecks += 1;
        return jsonResponse({ id: "30091560740", run_attempt: 1, status: "completed" });
      },
    },
  );
  const leaseItemNumber = 9315;
  const leaseItemKey = `openclaw/gogcli#${leaseItemNumber}@publish:30091560740:1`;
  try {
    assert.equal(
      (
        await leaseHarness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v2-active-lease",
            leaseItemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(leaseItemNumber, "30091560740"),
          ),
        )
      ).status,
      202,
    );
    const stored = (await leaseHarness.storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    const item = stored.items[leaseItemKey]!;
    Object.assign(item, {
      state: "leased",
      leaseId: "active-legacy-v2-lease",
      leaseRevision: 1,
      leaseExpiresAt: Date.now() + 60_000,
      claimedRunId: "9315",
      claimedAt: Date.now(),
      leaseDecision: item.decision,
    });
    await leaseHarness.storage.put("exact-review-queue", stored);

    const leaseReconciled = await (
      await leaseHarness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();
    assert.equal(leaseLiveChecks, 0);
    assert.equal(leaseProducerChecks, 0);
    assert.equal(leaseReconciled.changed, 0);
    assert.equal(leaseReconciled.legacy_state_batch_terminal_candidates, 0);
    const leaseState = (await leaseHarness.storage.get("exact-review-queue")) as {
      items: Record<string, { state: string }>;
    };
    assert.equal(leaseState.items[leaseItemKey]?.state, "leased");
  } finally {
    leaseHarness.restore();
  }
});

test("publication reconcile leaves a protocol-v2 state-batch row to existing stale-revision handling when a newer head exists", async () => {
  let liveChecks = 0;
  let producerChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    {
      producerRun: () => {
        producerChecks += 1;
        return jsonResponse({ id: "30091560741", run_attempt: 1, status: "completed" });
      },
    },
  );
  const itemNumber = 9316;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560741:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v2-newer-head",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(itemNumber, "30091560741"),
          ),
        )
      ).status,
      202,
    );
    harness.storage.sql.exec(
      `INSERT INTO exact_review_publication_heads (target_key, source_revision, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(target_key) DO UPDATE SET source_revision = excluded.source_revision`,
      `openclaw/gogcli#${itemNumber}`,
      2,
      Date.now(),
    );

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: false, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 0);
    assert.equal(producerChecks, 0);
    assert.equal(reconciled.stale_revision_eligible, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_candidates, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(state.items[itemKey]);
  } finally {
    harness.restore();
  }
});

test("exact-review batch preflight follows the publisher owner selection", async () => {
  const checked: Array<[string, number]> = [];
  const harness = createExactReviewAdmissionHarness(
    (targetRepo, itemNumber) => {
      checked.push([targetRepo, itemNumber]);
      return jsonResponse({ state: targetRepo === "alpha/repo" ? "closed" : "open" });
    },
    {
      publicationBatching: true,
      publicationBatchSize: "2",
      captureBatchDispatch: true,
    },
  );
  try {
    for (const [deliveryId, itemNumber, targetRepo] of [
      ["owner-alpha", 9221, "alpha/repo"],
      ["owner-beta-1", 9222, "beta/repo"],
      ["owner-beta-2", 9223, "beta/repo"],
    ] as const) {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(
              deliveryId,
              itemNumber,
              "exact_review_artifact_publish",
              "issue",
              targetRepo,
              exactReviewPublicationOverrides(
                itemNumber,
                String(itemNumber * 10),
                "opened",
                1,
                targetRepo,
              ),
            ),
          )
        ).status,
        202,
      );
    }

    await harness.queue.alarm();

    // Departure policy sees beta's full batch, while the publisher picks the
    // oldest alpha owner. The preflight must inspect that publisher selection.
    assert.deepEqual(checked, [["alpha/repo", 9221]]);
    assert.equal(harness.batchDispatches, 0);
    const terminal = await (
      await harness.queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=alpha%2Frepo&item_number=9221",
        ),
      )
    ).json();
    assert.equal(terminal.items.length, 0);
  } finally {
    harness.restore();
  }
});

test("exact-review batch terminal probe resets for a later departure", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-25T12:00:00.000Z");
  Date.now = () => now;
  let terminal = false;
  let dispatchAttempts = 0;
  const harness = createExactReviewAdmissionHarness(
    () => jsonResponse({ state: terminal ? "closed" : "open" }),
    {
      publicationBatching: true,
      captureBatchDispatch: true,
      batchDispatch: () => {
        dispatchAttempts += 1;
        return new Response(null, { status: 500 });
      },
    },
  );
  try {
    const itemNumber = 9231;
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "batch-probe-reset",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(itemNumber, "92310"),
          ),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();
    assert.equal(harness.batchDispatches, 1);
    assert.equal(dispatchAttempts, 1);

    terminal = true;
    now += 300_000;
    await harness.queue.alarm();

    // A failed dispatch begins a new departure; it must not reuse the first
    // open probe to publish the now-closed item.
    assert.equal(harness.batchDispatches, 1);
    const item = await (
      await harness.queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=openclaw%2Fgogcli&item_number=9231",
        ),
      )
    ).json();
    assert.equal(item.items.length, 0);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review batch claims keep a newer departure fence when an older workflow arrives", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-25T13:00:00.000Z");
  Date.now = () => now;
  let releaseBatchDispatch!: () => void;
  let signalBatchDispatch!: () => void;
  const batchDispatchStarted = new Promise<void>((resolve) => {
    signalBatchDispatch = resolve;
  });
  const batchDispatchRelease = new Promise<void>((resolve) => {
    releaseBatchDispatch = resolve;
  });
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
    publicationBatchSize: "2",
    publicationFreshLane: true,
    captureBatchDispatch: true,
    batchDispatch: async () => {
      signalBatchDispatch();
      await batchDispatchRelease;
      return new Response(null, { status: 204 });
    },
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "delayed-workflow-old",
            9241,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9241, "92410"),
          ),
        )
      ).status,
      202,
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "delayed-workflow-old-second",
            9242,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9242, "92420"),
          ),
        )
      ).status,
      202,
    );
    now += 16 * 60_000;
    const alarm = harness.queue.alarm();
    await batchDispatchStarted;

    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "delayed-workflow-fresh",
            9243,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9243, "92430"),
          ),
        )
      ).status,
      202,
    );

    const firstDelayedClaim = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({ claim_id: "delayed-claim-old", lease_owner: "worker-old" }),
        }),
      )
    ).json();
    const secondDelayedClaim = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({ claim_id: "delayed-claim-new", lease_owner: "worker-new" }),
        }),
      )
    ).json();
    assert.equal(firstDelayedClaim.claimed, false);
    assert.equal(firstDelayedClaim.preflight_required, true);
    assert.equal(secondDelayedClaim.claimed, false);
    assert.equal(secondDelayedClaim.preflight_required, true);

    releaseBatchDispatch();
    await alarm;
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("matching stale batch departures release their own fence and redispatch current work", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-25T14:00:00.000Z");
  Date.now = () => now;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
    publicationBatchSize: "2",
    publicationFreshLane: true,
    captureBatchDispatch: true,
  });
  try {
    for (const [deliveryId, itemNumber] of [
      ["stale-departure-first", 9251],
      ["stale-departure-second", 9252],
    ] as const) {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(
              deliveryId,
              itemNumber,
              "exact_review_artifact_publish",
              "issue",
              "openclaw/gogcli",
              exactReviewPublicationOverrides(itemNumber, String(itemNumber * 10)),
            ),
          )
        ).status,
        202,
      );
    }
    now += 16 * 60_000;
    await harness.queue.alarm();
    assert.equal(harness.batchDispatches, 1);

    const reserved = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: {
        publicationBatchDispatchId: string;
        publicationBatchDispatchedAt: number;
        publicationBatchDispatchPendingUntil?: number;
        publicationBatchTerminalProbe?: string;
      };
    };
    const firstDispatch = reserved.dispatcher;
    assert.ok(firstDispatch.publicationBatchTerminalProbe);

    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "stale-departure-fresh",
            9253,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9253, "92530"),
          ),
        )
      ).status,
      202,
    );

    const stale = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({
            claim_id: "matching-stale-departure",
            lease_owner: "matching-stale-worker",
            dispatch_id: firstDispatch.publicationBatchDispatchId,
            dispatched_at: new Date(firstDispatch.publicationBatchDispatchedAt).toISOString(),
          }),
        }),
      )
    ).json();
    assert.equal(stale.claimed, false);
    assert.equal(stale.preflight_required, true);

    const released = (await harness.storage.get("exact-review-queue")) as typeof reserved;
    assert.equal(released.dispatcher.publicationBatchDispatchPendingUntil, undefined);
    assert.equal(released.dispatcher.publicationBatchTerminalProbe, undefined);

    now += 60_000;
    await harness.queue.alarm();
    assert.equal(harness.batchDispatches, 2);
    const refreshed = (await harness.storage.get("exact-review-queue")) as typeof reserved;
    assert.notEqual(
      refreshed.dispatcher.publicationBatchDispatchId,
      firstDispatch.publicationBatchDispatchId,
    );
    assert.ok(refreshed.dispatcher.publicationBatchTerminalProbe);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review batch claim retries resume their existing leased batch", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
    captureBatchDispatch: true,
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "batch-claim-retry",
            9244,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9244, "92440"),
          ),
        )
      ).status,
      202,
    );
    await harness.queue.alarm();
    assert.equal(harness.batchDispatches, 1);

    const request = () =>
      new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
        method: "POST",
        body: JSON.stringify({ claim_id: "retry-claim", lease_owner: "retry-worker" }),
      });
    const first = await (await harness.queue.fetch(request())).json();
    const retry = await (await harness.queue.fetch(request())).json();

    assert.equal(first.claimed, true, JSON.stringify(first));
    assert.equal(retry.claimed, true, JSON.stringify(retry));
    assert.equal(retry.batch.batch_id, first.batch.batch_id);
    assert.deepEqual(retry.batch.items, first.batch.items);
  } finally {
    harness.restore();
  }
});

test("exact-review batch accepts an in-flight pre-probe rolling-deploy departure", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-07-25T14:00:00.000Z");
  Date.now = () => now;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "pre-probe-departure",
            9245,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9245, "92450"),
          ),
        )
      ).status,
      202,
    );
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: Record<string, unknown>;
    };
    state.dispatcher = {
      state: "active",
      checkedAt: now,
      publicationBatchDispatchedAt: now,
      publicationBatchDispatchPendingUntil: now + 600_000,
    };
    await harness.storage.put("exact-review-queue", state);

    const claim = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({ claim_id: "pre-probe-claim", lease_owner: "pre-probe-worker" }),
        }),
      )
    ).json();
    assert.equal(claim.claimed, true, JSON.stringify(claim));
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review queue retains a 404 item when the target repository is inaccessible", async () => {
  const harness = createExactReviewAdmissionHarness(() => new Response(null, { status: 404 }), {
    targetRepository: () => new Response(null, { status: 404 }),
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("inaccessible-target", 597, "opened"),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { state: string; attempts: number; reviewFailureAttempts?: number }>;
    };
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.attempts, 1);
    assert.equal(state.items["openclaw/gogcli#597"]?.reviewFailureAttempts, 1);
  } finally {
    harness.restore();
  }
});

test("exact-review queue dispatches an item that remains open", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }));
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("open-item", 597, "opened"))).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 1);
    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.dispatching, 1);
  } finally {
    harness.restore();
  }
});

test("exact-review queue supersedes a stale open pull-request head before dispatch", async () => {
  const staleHeadSha = "a".repeat(40);
  const currentHeadSha = "b".repeat(40);
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    targetPull: () => jsonResponse({ state: "open", head: { sha: currentHeadSha } }),
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "stale-pr-head",
            597,
            "synchronize",
            "pull_request",
            undefined,
            {
              sourceHeadSha: staleHeadSha,
            },
          ),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items["openclaw/gogcli#597"], undefined);
    const audit = Array.from(
      harness.storage.sql.exec(
        `SELECT audit_id, item_key, prior_revision, next_revision, source_action, reason_code
           FROM exact_review_queue_supersessions`,
      ),
    ).map((row) => ({ ...row }));
    assert.equal(audit.length, 1);
    assert.match(String(audit[0]?.audit_id), /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      { ...audit[0], audit_id: undefined },
      {
        audit_id: undefined,
        item_key: "openclaw/gogcli#597",
        prior_revision: 1,
        next_revision: 2,
        source_action: "synchronize",
        reason_code: "live_head_advanced",
      },
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "stale-pr-head-again",
            597,
            "synchronize",
            "pull_request",
            undefined,
            { sourceHeadSha: "c".repeat(40) },
          ),
        )
      ).status,
      202,
    );
    await harness.queue.alarm();
    const repeatedAudit = Array.from(
      harness.storage.sql.exec(
        `SELECT audit_id FROM exact_review_queue_supersessions ORDER BY superseded_at, audit_id`,
      ),
    ).map((row) => String(row.audit_id));
    assert.equal(harness.dispatched.length, 0);
    assert.equal(repeatedAudit.length, 2);
    assert.equal(new Set(repeatedAudit).size, 2);
    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.completed_total, 2);
    assert.equal(stats.lanes.review.superseded_total, 2);
  } finally {
    harness.restore();
  }
});

test("exact-review queue refreshes a stale pull-request command to the current head", async () => {
  const staleHeadSha = "a".repeat(40);
  const currentHeadSha = "b".repeat(40);
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    targetPull: () => jsonResponse({ state: "open", head: { sha: currentHeadSha } }),
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "stale-pr-command",
            597,
            "synchronize",
            "pull_request",
            undefined,
            {
              sourceHeadSha: staleHeadSha,
              commandStatusMarker,
              statusCommentId: 9001,
            },
          ),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    let state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          revision: number;
          attempts: number;
          dispatchFailureStatus?: number;
          dispatchFailureClass?: string;
          dispatchFailureAt?: number;
          dispatchFailureFingerprint?: string;
          decision: {
            sourceHeadSha?: string;
            sourceHeadVerified?: boolean;
            sourceAuthoritySeq?: number;
            commandStatusMarker?: string;
            statusCommentId?: number;
          };
          leaseDecision?: {
            sourceHeadSha?: string;
            commandStatusMarker?: string;
          };
        }
      >;
    };
    const refreshed = state.items["openclaw/gogcli#597"];
    assert.equal(refreshed?.state, "pending");
    assert.equal(refreshed?.revision, 2);
    assert.equal(refreshed?.attempts, 0);
    assert.equal(refreshed?.decision.sourceHeadSha, currentHeadSha);
    assert.equal(refreshed?.decision.sourceHeadVerified, true);
    assert.equal(refreshed?.decision.sourceAuthoritySeq, undefined);
    assert.equal(refreshed?.decision.commandStatusMarker, commandStatusMarker);
    assert.equal(refreshed?.decision.statusCommentId, 9001);
    assert.equal(refreshed?.dispatchFailureStatus, undefined);
    assert.equal(refreshed?.dispatchFailureClass, undefined);
    assert.equal(refreshed?.dispatchFailureAt, undefined);
    assert.equal(refreshed?.dispatchFailureFingerprint, undefined);

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 1);
    state = (await harness.storage.get("exact-review-queue")) as typeof state;
    const dispatched = state.items["openclaw/gogcli#597"];
    assert.equal(dispatched?.state, "dispatching");
    assert.equal(dispatched?.attempts, 0);
    assert.equal(dispatched?.leaseDecision?.sourceHeadSha, currentHeadSha);
    assert.equal(dispatched?.leaseDecision?.commandStatusMarker, commandStatusMarker);
  } finally {
    harness.restore();
  }
});

test("exact-review queue bounds item-specific terminal-state check failures", async () => {
  const harness = createExactReviewAdmissionHarness(
    () => new Response(JSON.stringify({ message: "unprocessable" }), { status: 422 }),
  );
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("unavailable-item", 597, "opened")))
        .status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        { state: string; attempts: number; reviewFailureAttempts?: number; nextAttemptAt: number }
      >;
    };
    const item = state.items["openclaw/gogcli#597"];
    assert.equal(item?.state, "pending");
    assert.equal(item?.attempts, 1);
    assert.equal(item?.reviewFailureAttempts, 1);
    assert.ok((item?.nextAttemptAt || 0) > Date.now());
  } finally {
    harness.restore();
  }
});

test("exact-review queue parks an item after repeated item-specific target-state failures", async () => {
  const harness = createExactReviewAdmissionHarness(
    () => new Response(JSON.stringify({ message: "unprocessable" }), { status: 422 }),
  );
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("repeated-unavailable", 597, "opened"),
        )
      ).status,
      202,
    );

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await harness.queue.alarm();
      const state = (await harness.storage.get("exact-review-queue")) as {
        items: Record<
          string,
          {
            state: string;
            attempts: number;
            reviewFailureAttempts?: number;
            nextAttemptAt: number;
            parkedReason?: string;
          }
        >;
      };
      const item = state.items["openclaw/gogcli#597"];
      assert.equal(item?.attempts, attempt);
      assert.equal(item?.reviewFailureAttempts, attempt);
      if (attempt < 8) {
        assert.equal(item?.state, "pending");
        item.nextAttemptAt = Date.now() - 1;
        await harness.storage.put("exact-review-queue", state);
      } else {
        assert.equal(item?.state, "parked");
        assert.equal(item?.parkedReason, "review_retry_exhausted");
      }
    }
    assert.equal(harness.dispatched.length, 0);
  } finally {
    harness.restore();
  }
});

test("exact-review queue globally backs off admission GitHub outages without charging item attempts", async () => {
  const harness = createExactReviewAdmissionHarness(
    () => new Response(JSON.stringify({ message: "unavailable" }), { status: 503 }),
  );
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("admission-outage", 597, "opened")))
        .status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: {
        state: string;
        reason: string;
        dispatchFailureStatus: number;
        dispatchConsecutiveFailures: number;
      };
      items: Record<string, { state: string; attempts: number; reviewFailureAttempts?: number }>;
    };
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "dispatch_github_outage");
    assert.equal(state.dispatcher.dispatchFailureStatus, 503);
    assert.equal(state.dispatcher.dispatchConsecutiveFailures, 1);
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.attempts, 0);
    assert.equal(state.items["openclaw/gogcli#597"]?.reviewFailureAttempts, undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review queue globally backs off admission 403 rate limits without charging item attempts", async () => {
  const harness = createExactReviewAdmissionHarness(
    () =>
      new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
  );
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("admission-rate-limit", 597, "opened"),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: {
        state: string;
        reason: string;
        dispatchFailureStatus: number;
        dispatchFailureClass: string;
      };
      items: Record<string, { state: string; attempts: number; reviewFailureAttempts?: number }>;
    };
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "dispatch_rate_limit");
    assert.equal(state.dispatcher.dispatchFailureStatus, 403);
    assert.equal(state.dispatcher.dispatchFailureClass, "rate_limit");
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.attempts, 0);
    assert.equal(state.items["openclaw/gogcli#597"]?.reviewFailureAttempts, undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review queue keeps healthy targets moving when one target App access fails", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    maxConcurrent: "2",
    targetInstallation: (targetRepo) =>
      targetRepo === "openclaw/gogcli"
        ? new Response(JSON.stringify({ message: "not installed" }), { status: 404 })
        : jsonResponse({ id: 999 }),
  });
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("target-app-failure", 597, "opened")))
        .status,
      202,
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "healthy-target",
            598,
            "opened",
            "issue",
            "openclaw/openclaw",
          ),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]?.client_payload?.target_repo, "openclaw/openclaw");
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: { state: string };
      items: Record<string, { state: string; attempts: number; reviewFailureAttempts?: number }>;
    };
    assert.equal(state.dispatcher.state, "active");
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.attempts, 1);
    assert.equal(state.items["openclaw/gogcli#597"]?.reviewFailureAttempts, 1);
    assert.equal(state.items["openclaw/openclaw#598"]?.state, "dispatching");
  } finally {
    harness.restore();
  }
});

test("exact-review queue keeps healthy targets moving when one target item read is forbidden", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    maxConcurrent: "2",
    targetItem: (targetRepo) =>
      targetRepo === "openclaw/gogcli"
        ? new Response(JSON.stringify({ message: "forbidden" }), { status: 403 })
        : jsonResponse({ state: "open" }),
  });
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("forbidden-target", 597, "opened")))
        .status,
      202,
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "healthy-target-after-forbidden",
            598,
            "opened",
            "issue",
            "openclaw/openclaw",
          ),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]?.client_payload?.target_repo, "openclaw/openclaw");
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: { state: string };
      items: Record<string, { state: string; attempts: number; reviewFailureAttempts?: number }>;
    };
    assert.equal(state.dispatcher.state, "active");
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.attempts, 1);
    assert.equal(state.items["openclaw/gogcli#597"]?.reviewFailureAttempts, 1);
    assert.equal(state.items["openclaw/openclaw#598"]?.state, "dispatching");
  } finally {
    harness.restore();
  }
});

test("exact-review admission does not restore a publication batch claim reservation", async () => {
  let releaseLookup!: () => void;
  let signalLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    signalLookupStarted = resolve;
  });
  const lookupRelease = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const harness = createExactReviewAdmissionHarness(
    async () => {
      signalLookupStarted();
      await lookupRelease;
      return jsonResponse({ state: "open" });
    },
    {
      publicationBatching: true,
      dispatch: () => new Response(JSON.stringify({ message: "unavailable" }), { status: 503 }),
    },
  );
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("batch-claim-race", 597, "opened")))
        .status,
      202,
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "batch-claim-publication",
            598,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/openclaw",
            exactReviewPublicationOverrides(598, "5980", "opened", 1, "openclaw/openclaw"),
          ),
        )
      ).status,
      202,
    );
    const reserved = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: Record<string, unknown>;
    };
    reserved.dispatcher = {
      state: "active",
      checkedAt: Date.now(),
      publicationBatchDispatchPendingUntil: Date.now() + 5 * 60_000,
    };
    await harness.storage.put("exact-review-queue", reserved);

    const alarm = harness.queue.alarm();
    await lookupStarted;
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
        method: "POST",
        body: JSON.stringify({
          claim_id: "admission-race-batch",
          lease_owner: "admission-race-owner",
          max_items: 1,
        }),
      }),
    );
    assert.equal((await claim.json()).claimed, true);
    const afterClaim = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: { publicationBatchDispatchPendingUntil?: number };
    };
    assert.equal(afterClaim.dispatcher?.publicationBatchDispatchPendingUntil, undefined);

    releaseLookup();
    await alarm;

    const afterAlarm = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: { publicationBatchDispatchPendingUntil?: number };
    };
    assert.equal(afterAlarm.dispatcher?.publicationBatchDispatchPendingUntil, undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review terminal admission does not remove a newer queue revision", async () => {
  let releaseLookup!: () => void;
  let signalLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    signalLookupStarted = resolve;
  });
  const lookupRelease = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const harness = createExactReviewAdmissionHarness(async () => {
    signalLookupStarted();
    await lookupRelease;
    return jsonResponse({ state: "closed" });
  });
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("stale-terminal", 597, "opened")))
        .status,
      202,
    );
    const alarm = harness.queue.alarm();
    await lookupStarted;
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("newer-revision", 597, "edited")))
        .status,
      202,
    );
    releaseLookup();
    await alarm;

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { state: string; revision: number }>;
    };
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.revision, 2);
  } finally {
    harness.restore();
  }
});

test("exact-review queue upgrades flow metrics without losing publication completions", async () => {
  const storage = new MemoryDurableStorage();
  storage.sql.exec(
    `CREATE TABLE exact_review_queue_metrics (
       singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
       publication_completed_total INTEGER NOT NULL CHECK (publication_completed_total >= 0)
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO exact_review_queue_metrics (singleton_id, publication_completed_total)
     VALUES (1, 42)`,
  );
  storage.sql.exec(
    `CREATE TABLE exact_review_queue_metric_buckets (
       bucket_start INTEGER PRIMARY KEY,
       publication_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (publication_enqueued >= 0),
       publication_resolved INTEGER NOT NULL DEFAULT 0 CHECK (publication_resolved >= 0),
       publication_published INTEGER NOT NULL DEFAULT 0 CHECK (publication_published >= 0),
       publication_superseded INTEGER NOT NULL DEFAULT 0 CHECK (publication_superseded >= 0),
       publication_retried INTEGER NOT NULL DEFAULT 0 CHECK (publication_retried >= 0),
       publication_dead_lettered INTEGER NOT NULL DEFAULT 0
         CHECK (publication_dead_lettered >= 0)
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO exact_review_queue_metric_buckets
       (bucket_start, publication_enqueued, publication_resolved, publication_published)
     VALUES (?, 2, 1, 1)`,
    Date.now(),
  );
  const queue = new ExactReviewQueue({ storage }, {});

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.deepEqual(
    {
      review_enqueued: stats.lanes.review.enqueued_total,
      review_completed: stats.lanes.review.completed_total,
      review_superseded: stats.lanes.review.superseded_total,
      publication_enqueued: stats.lanes.publication.enqueued_total,
      publication_completed: stats.lanes.publication.completed_total,
    },
    {
      review_enqueued: 0,
      review_completed: 0,
      review_superseded: 0,
      publication_enqueued: 0,
      publication_completed: 42,
    },
  );
  assert.equal(stats.lanes.publication.flow.last_15_minutes.published_rate_per_hour, 4);
  assert.deepEqual(stats.lanes.review.flow.last_15_minutes, {
    window_minutes: 15,
    arrival: 0,
    successful: 0,
    retried: 0,
    shed: 0,
    shed_reasons: { backpressure: 0, scheduled_rate: 0 },
    arrival_rate_per_hour: 0,
    successful_rate_per_hour: 0,
    retried_rate_per_hour: 0,
    shed_rate_per_hour: 0,
    retry_amplification: null,
  });
});

test("exact-review queue migrates delivery receipts and retains them for seven days", async () => {
  const storage = new MemoryDurableStorage();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  await storage.put("exact-review-queue", {
    deliveries: {
      "delivery-expired": Date.now() - sevenDaysMs - 60_000,
      "delivery-within-window": Date.now() - sevenDaysMs + 60_000,
    },
    items: {},
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-fresh", 619, "opened"))).status,
    202,
  );

  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
  };
  assert.deepEqual(Object.keys(state.deliveries).sort(), [
    "delivery-fresh",
    "delivery-within-window",
  ]);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.delivery_receipts, 2);
  assert.equal(stats.storage_schema_version, 1);
  assert.equal(stats.legacy_rollback_available, true);
  const shadowDeliveries = (
    storage.rawGet("exact-review-queue") as { deliveries: Record<string, number> }
  ).deliveries;
  const shadowGenerationIds = Object.keys(shadowDeliveries).filter((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.equal(shadowGenerationIds.length, 1);
  assert.equal(shadowDeliveries[shadowGenerationIds[0]], Number.MAX_SAFE_INTEGER);
  assert.deepEqual(
    Object.keys(shadowDeliveries)
      .filter((deliveryId) => !deliveryId.startsWith("__clawsweeper_sql_generation:"))
      .sort(),
    ["delivery-fresh", "delivery-within-window"],
  );
  assert.ok(shadowDeliveries["delivery-within-window"] > Date.now() - 5 * 24 * 60 * 60 * 1000);

  const restarted = new ExactReviewQueue({ storage }, {});
  const duplicate = await restarted.fetch(
    buildExactReviewQueueRequest("delivery-within-window", 619, "edited"),
  );
  assert.deepEqual(await duplicate.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#619",
  });
});

test("exact-review receipt acceptance and queue mutation commit atomically", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  storage.failNextSql(/INSERT INTO exact_review_queue_items/);

  await assert.rejects(
    queue.fetch(buildExactReviewQueueRequest("delivery-atomic", 625, "opened")),
    /injected SQL failure/,
  );
  let state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(state.deliveries, {});
  assert.deepEqual(state.items, {});
  let stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 0);

  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-atomic", 625, "opened"))).status,
    202,
  );
  state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.deliveries), ["delivery-atomic"]);
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#625"]);
  stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 1);
});

test("exact-review re-upgrade imports rollback-era queue mutations and receipts", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-before-rollback", 626, "opened")))
      .status,
    202,
  );

  const shadow = structuredClone(
    storage.rawGet("exact-review-queue") as {
      deliveries: Record<string, number>;
      items: Record<string, Record<string, unknown>>;
    },
  );
  const oldGenerationId = Object.keys(shadow.deliveries).find((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.ok(oldGenerationId);
  const rollbackItem = structuredClone(shadow.items["openclaw/gogcli#626"]);
  rollbackItem.key = "openclaw/gogcli#627";
  rollbackItem.decision = {
    ...(rollbackItem.decision as Record<string, unknown>),
    itemNumber: 627,
  };
  delete shadow.items["openclaw/gogcli#626"];
  shadow.items["openclaw/gogcli#627"] = rollbackItem;
  shadow.deliveries["delivery-during-rollback"] = Date.now();
  storage.rawPut("exact-review-queue", shadow);

  const upgraded = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 2);
  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#627"]);
  assert.deepEqual(Object.keys(state.deliveries).sort(), [
    "delivery-before-rollback",
    "delivery-during-rollback",
  ]);
  const upgradedShadow = storage.rawGet("exact-review-queue") as {
    deliveries: Record<string, number>;
  };
  const upgradedGenerationIds = Object.keys(upgradedShadow.deliveries).filter((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.equal(upgradedGenerationIds.length, 1);
  assert.match(upgradedGenerationIds[0], /^__clawsweeper_sql_generation:\d+$/);
  assert.notEqual(upgradedGenerationIds[0], oldGenerationId);
  assert.deepEqual(
    Object.keys(upgradedShadow.deliveries)
      .filter((deliveryId) => !deliveryId.startsWith("__clawsweeper_sql_generation:"))
      .sort(),
    ["delivery-before-rollback", "delivery-during-rollback"],
  );
});

test("exact-review re-upgrade distinguishes a refreshed rollback receipt", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-refreshed", 634, "opened"))).status,
    202,
  );
  const oldReceivedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const refreshedAt = Date.now();
  storage.setExactReviewReceiptTime("delivery-refreshed", oldReceivedAt);
  const rollback = structuredClone(
    storage.rawGet("exact-review-queue") as {
      deliveries: Record<string, number>;
      items: Record<string, { revision: number; updatedAt: number }>;
    },
  );
  rollback.deliveries["delivery-refreshed"] = refreshedAt;
  rollback.items["openclaw/gogcli#634"].revision += 1;
  rollback.items["openclaw/gogcli#634"].updatedAt = refreshedAt;
  storage.rawPut("exact-review-queue", rollback);

  const upgraded = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 1);
  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, { revision: number }>;
  };
  assert.equal(state.deliveries["delivery-refreshed"], refreshedAt);
  assert.equal(state.items["openclaw/gogcli#634"].revision, 2);
  assert.deepEqual(
    await (
      await upgraded.fetch(buildExactReviewQueueRequest("delivery-refreshed", 634, "edited"))
    ).json(),
    { ok: true, deduped: true, item_key: "openclaw/gogcli#634" },
  );
});

test("exact-review receipt pruning removes its translated shadow atomically", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-pruned", 635, "opened"))).status,
    202,
  );
  const expiredAt = Date.now() - 7 * 24 * 60 * 60 * 1000 - 1;
  storage.setExactReviewReceiptTime("delivery-pruned", expiredAt);
  const staleShadow = structuredClone(
    storage.rawGet("exact-review-queue") as { deliveries: Record<string, number> },
  );
  staleShadow.deliveries["delivery-pruned"] = expiredAt + 2 * 24 * 60 * 60 * 1000;
  storage.rawPut("exact-review-queue", staleShadow);

  let stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.delivery_receipts, 0);
  const refreshedShadow = storage.rawGet("exact-review-queue") as {
    deliveries: Record<string, number>;
  };
  assert.deepEqual(
    Object.keys(refreshedShadow.deliveries).filter(
      (deliveryId) => !deliveryId.startsWith("__clawsweeper_sql_generation:"),
    ),
    [],
  );

  const restarted = new ExactReviewQueue({ storage }, {});
  stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.delivery_receipts, 0);
});

test("exact-review re-upgrade fails closed for a divergent stale rollback shadow", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-stale-1", 628, "opened"))).status,
    202,
  );
  const staleShadow = structuredClone(storage.rawGet("exact-review-queue"));
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-stale-2", 629, "opened"))).status,
    202,
  );
  storage.rawPut("exact-review-queue", staleShadow);

  const upgraded = new ExactReviewQueue({ storage }, {});
  await assert.rejects(
    upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats")),
    /ambiguous exact-review legacy rollback state/,
  );
  const sqlState = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(sqlState.items).sort(), [
    "openclaw/gogcli#628",
    "openclaw/gogcli#629",
  ]);
  assert.deepEqual(storage.rawGet("exact-review-queue"), staleShadow);
});

test("exact-review discards a stale rollback shadow when its refresh fails", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  assert.equal(storage.rawHas("exact-review-queue"), true);
  storage.failNextPut("exact-review-queue");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-mirror-failure", 630, "opened")))
        .status,
      202,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(storage.rawHas("exact-review-queue"), false);
  assert.match(String(warnings[0][0]), /legacy rollback shadow unavailable/);

  const restarted = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 1);
  assert.equal(storage.rawHas("exact-review-queue"), true);
});

test("exact-review rolls SQL back when an obsolete shadow cannot be removed", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const originalShadow = structuredClone(storage.rawGet("exact-review-queue"));
  const secret = "legacy-shadow-secret";
  storage.failNextPut("exact-review-queue");
  storage.failNextDelete(
    "exact-review-queue",
    new Error(
      `legacy shadow delete failed at https://operator:${secret}@storage.example/shadow?token=${secret}`,
    ),
  );
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await assert.rejects(
      queue.fetch(buildExactReviewQueueRequest("delivery-atomic-shadow", 633, "opened")),
      /exact-review legacy rollback shadow cleanup failed/,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.match(String(warnings[0][0]), /stale legacy rollback shadow could not be removed/);
  assert.doesNotMatch(warnings.flat().join("\n"), new RegExp(secret));
  assert.match(warnings.flat().join("\n"), /https:\/\/\[REDACTED\]@storage\.example/);
  assert.match(warnings.flat().join("\n"), /token=\[REDACTED\]/);
  assert.deepEqual(storage.rawGet("exact-review-queue"), originalShadow);
  let state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(state.deliveries, {});
  assert.deepEqual(state.items, {});

  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-atomic-shadow", 633, "opened")))
      .status,
    202,
  );
  state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.deliveries), ["delivery-atomic-shadow"]);
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#633"]);
});

test("exact-review SQL rows outgrow the bounded rollback shadow without blocking intake", async () => {
  const storage = new MemoryDurableStorage();
  const now = Date.now();
  const items = Object.fromEntries(
    Array.from({ length: 220 }, (_, index) => {
      const itemNumber = 10_000 + index;
      const key = `openclaw/openclaw#${itemNumber}`;
      return [
        key,
        {
          key,
          decision: {
            targetRepo: "openclaw/openclaw",
            targetBranch: "main",
            itemNumber,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction: "opened",
            supersedesInProgress: false,
            additionalPrompt: "x".repeat(5_000),
          },
          state: "pending",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          nextAttemptAt: now,
          attempts: 0,
        },
      ];
    }),
  );
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let queue: ExactReviewQueue;
  try {
    queue = new ExactReviewQueue({ storage }, {});
    const response = await queue.fetch(
      buildExactReviewQueueRequest("delivery-after-large-migration", 20_000, "opened"),
    );
    assert.equal(response.status, 202);
  } finally {
    console.warn = originalWarn;
  }

  const stats = await (
    await queue!.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 221);
  assert.equal(stats.delivery_receipts, 1);
  assert.equal(stats.legacy_rollback_available, false);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /legacy rollback shadow unavailable/);
  assert.match(String(warnings[0][1]), /shadow is \d+ bytes/);
  assert.equal(storage.rawHas("exact-review-queue"), false);
});

test("exact-review migration removes its rollback shadow after one day", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-shadow", 626, "opened"))).status,
    202,
  );
  assert.equal(storage.rawHas("exact-review-queue"), true);

  storage.setExactReviewMigrationTime(Date.now() - 24 * 60 * 60 * 1000 - 1);
  const restarted = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 1);
  assert.equal(stats.legacy_rollback_available, false);
  assert.equal(storage.rawHas("exact-review-queue"), false);
});

test("exact-review imports an active rollback before expiring an old bridge", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-old-bridge", 631, "opened"))).status,
    202,
  );
  const shadow = structuredClone(
    storage.rawGet("exact-review-queue") as {
      deliveries: Record<string, number>;
      items: Record<string, Record<string, unknown>>;
    },
  );
  const oldMigrationTime = Date.now() - 24 * 60 * 60 * 1000 - 1;
  storage.setExactReviewMigrationTime(oldMigrationTime);
  const generationId = Object.keys(shadow.deliveries).find((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.ok(generationId);
  assert.equal(shadow.deliveries[generationId], Number.MAX_SAFE_INTEGER);
  for (const [deliveryId, receivedAt] of Object.entries(shadow.deliveries)) {
    if (receivedAt <= Date.now() - 5 * 24 * 60 * 60 * 1000) {
      delete shadow.deliveries[deliveryId];
    }
  }
  assert.equal(shadow.deliveries[generationId], Number.MAX_SAFE_INTEGER);
  shadow.deliveries["delivery-old-bridge-rollback"] = Date.now();
  const rollbackItem = structuredClone(shadow.items["openclaw/gogcli#631"]);
  rollbackItem.key = "openclaw/gogcli#632";
  rollbackItem.decision = {
    ...(rollbackItem.decision as Record<string, unknown>),
    itemNumber: 632,
  };
  delete shadow.items["openclaw/gogcli#631"];
  shadow.items["openclaw/gogcli#632"] = rollbackItem;
  storage.rawPut("exact-review-queue", shadow);

  const upgraded = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 2);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#632"]);
  assert.equal(storage.rawHas("exact-review-queue"), false);
});

test("a newer exact-review enqueue revokes a claimed immutable decision", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(620);
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#620": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const claim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-620",
        item_key: "openclaw/openclaw#620",
        lease_revision: 1,
        run_id: "6200",
        run_attempt: 1,
      }),
    }),
  );
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), {
    ok: true,
    claimed: true,
    protocol_version: 2,
    item_key: "openclaw/openclaw#620",
    lease_revision: 1,
    claim_generation: 1,
    decision: item.leaseDecision,
  });

  const newer = buildExactReviewQueueRequest(
    "newer-620",
    620,
    "edited",
    "pull_request",
    "openclaw/openclaw",
  );
  assert.equal((await queue.fetch(newer)).status, 202);

  const claimedState = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        revision: number;
        decision: { sourceAction: string; itemKind: string };
        state: string;
        leaseDecision?: { sourceAction: string; itemKind: string };
      }
    >;
  };
  assert.equal(claimedState.items["openclaw/openclaw#620"].state, "pending");
  assert.equal(claimedState.items["openclaw/openclaw#620"].revision, 2);
  assert.deepEqual(claimedState.items["openclaw/openclaw#620"].decision, {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 620,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "edited",
    supersedesInProgress: true,
  });
  assert.equal(claimedState.items["openclaw/openclaw#620"].leaseDecision, undefined);

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-620",
        item_key: "openclaw/openclaw#620",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6200",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(complete.status, 409);
  assert.deepEqual(await complete.json(), {
    error: "lease_superseded",
    superseded_by_revision: 2,
  });

  const mismatchedGeneration = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-620",
        item_key: "openclaw/openclaw#620",
        lease_revision: 1,
        claim_generation: 2,
        run_id: "6200",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(mismatchedGeneration.status, 409);
  assert.deepEqual(await mismatchedGeneration.json(), { error: "lease_not_claimed" });
});

test("a newer exact-review enqueue revokes a claimed legacy workflow lease", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(624);
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#624": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const legacyClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-624",
        run_id: "6240",
        run_attempt: 1,
      }),
    }),
  );
  assert.equal(legacyClaim.status, 200);
  assert.deepEqual(await legacyClaim.json(), {
    ok: true,
    claimed: true,
    protocol_version: 1,
    item_key: "openclaw/openclaw#624",
    revision: 1,
    lease_revision: 1,
    claim_generation: 1,
    decision: item.leaseDecision,
  });

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "newer-624",
          624,
          "edited",
          "pull_request",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const strictCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-624",
        item_key: "openclaw/openclaw#624",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6240",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(strictCompletion.status, 409);
  assert.deepEqual(await strictCompletion.json(), { error: "lease_not_claimed" });

  const legacyCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-624",
        run_id: "6240",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(legacyCompletion.status, 409);
  assert.deepEqual(await legacyCompletion.json(), { error: "lease_not_claimed" });
  const requeued = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(requeued.items["openclaw/openclaw#624"].state, "pending");
  assert.equal(requeued.items["openclaw/openclaw#624"].claimProtocolVersion, undefined);
  assert.equal(
    (requeued.items["openclaw/openclaw#624"].decision as { sourceAction: string }).sourceAction,
    "edited",
  );
});

test("exact-review claims advance generations only for newer run attempts", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#621": unclaimedExactReviewQueueItem(621) },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const claim = (runAttempt?: number) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-621",
          item_key: "openclaw/openclaw#621",
          lease_revision: 1,
          run_id: "6210",
          ...(runAttempt === undefined ? {} : { run_attempt: runAttempt }),
        }),
      }),
    );

  const first = await claim(1);
  assert.equal(first.status, 200);
  const firstPayload = await first.json();
  assert.equal(firstPayload.claim_generation, 1);
  assert.equal(firstPayload.lease_revision, 1);

  const beforeReplay = (await storage.get("exact-review-queue")) as {
    items: Record<string, { leaseExpiresAt: number }>;
  };
  beforeReplay.items["openclaw/openclaw#621"].leaseExpiresAt = Date.now() + 1_000;
  await storage.put("exact-review-queue", beforeReplay);

  const replay = await claim(1);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstPayload);
  const afterReplay = (await storage.get("exact-review-queue")) as typeof beforeReplay;
  assert.ok(afterReplay.items["openclaw/openclaw#621"].leaseExpiresAt - Date.now() > 120 * 60_000);

  const nextAttempt = await claim(2);
  assert.equal(nextAttempt.status, 200);
  assert.equal((await nextAttempt.json()).claim_generation, 2);
  const latestState = structuredClone(await storage.get("exact-review-queue"));

  const staleAttempt = await claim(1);
  assert.equal(staleAttempt.status, 409);
  assert.deepEqual(await staleAttempt.json(), { error: "stale_run_attempt" });
  assert.deepEqual(await storage.get("exact-review-queue"), latestState);

  const missingAttempt = await claim();
  assert.equal(missingAttempt.status, 409);
  assert.deepEqual(await missingAttempt.json(), { error: "missing_run_attempt" });
  assert.deepEqual(await storage.get("exact-review-queue"), latestState);

  const staleCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-621",
        item_key: "openclaw/openclaw#621",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6210",
        run_attempt: 1,
        outcome: "failure",
      }),
    }),
  );
  assert.equal(staleCompletion.status, 409);
  assert.deepEqual(await staleCompletion.json(), { error: "lease_not_claimed" });
  assert.deepEqual(await storage.get("exact-review-queue"), latestState);
});

test("exact-review claim upgrades a legacy same-attempt generation", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(622);
  item.state = "leased";
  item.claimedRunId = "6220";
  item.claimedRunAttempt = 1;
  item.leaseDecision = structuredClone(item.decision);
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#622": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-622",
        item_key: "openclaw/openclaw#622",
        lease_revision: 1,
        run_id: "6220",
        run_attempt: 1,
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).claim_generation, 1);
  const stored = (await storage.get("exact-review-queue")) as {
    items: Record<string, { claimGeneration?: number }>;
  };
  assert.equal(stored.items["openclaw/openclaw#622"].claimGeneration, 1);
});

test("exact-review claim and completion reject forged or incomplete lease tuples", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#622": unclaimedExactReviewQueueItem(622),
      "openclaw/openclaw#623": unclaimedExactReviewQueueItem(623),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const claimBase = {
    lease_id: "lease-622",
    item_key: "openclaw/openclaw#622",
    lease_revision: 1,
    run_id: "6220",
    run_attempt: 1,
  };
  const initialState = structuredClone(await storage.get("exact-review-queue"));
  const invalidClaims = [
    { body: { ...claimBase, item_key: undefined }, status: 400 },
    { body: { ...claimBase, lease_revision: undefined }, status: 400 },
    { body: { ...claimBase, item_key: "openclaw/openclaw#623" }, status: 409 },
    { body: { ...claimBase, lease_revision: 2 }, status: 409 },
    {
      body: {
        ...claimBase,
        lease_id: "lease-623",
        item_key: "openclaw/openclaw#622",
      },
      status: 409,
    },
  ];
  for (const candidate of invalidClaims) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify(candidate.body),
      }),
    );
    assert.equal(response.status, candidate.status);
    assert.deepEqual(await storage.get("exact-review-queue"), initialState);
  }

  const validClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify(claimBase),
    }),
  );
  assert.equal(validClaim.status, 200);
  assert.equal((await validClaim.json()).claim_generation, 1);

  const completeBase = {
    ...claimBase,
    claim_generation: 1,
    outcome: "failure",
  };
  const claimedState = structuredClone(await storage.get("exact-review-queue"));
  const invalidCompletions = [
    { body: { ...completeBase, item_key: undefined }, status: 400 },
    { body: { ...completeBase, item_key: "openclaw/openclaw#623" }, status: 409 },
    { body: { ...completeBase, lease_revision: undefined }, status: 400 },
    { body: { ...completeBase, lease_revision: 2 }, status: 409 },
    { body: { ...completeBase, claim_generation: undefined }, status: 400 },
    { body: { ...completeBase, claim_generation: 2 }, status: 409 },
  ];
  for (const candidate of invalidCompletions) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify(candidate.body),
      }),
    );
    assert.equal(response.status, candidate.status);
    assert.deepEqual(await storage.get("exact-review-queue"), claimedState);
  }
});

test("exact-review queue admits at most one active item per target repository", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
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
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname)) {
      return jsonResponse({ id: 999 });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname)) {
      return jsonResponse({ state: "open" });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
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
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "1",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-target-a-1", 601, "opened"));
    await queue.fetch(buildExactReviewQueueRequest("delivery-target-a-2", 602, "opened"));
    await queue.fetch(
      buildExactReviewQueueRequest(
        "delivery-target-b-1",
        603,
        "opened",
        "issue",
        "openclaw/openclaw",
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "delivery-target-c-1",
        604,
        "opened",
        "issue",
        "openclaw/clawsweeper",
      ),
    );

    await queue.alarm();
    assert.equal(dispatched.length, 2);
    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm > Date.now() + 60_000);
    const targets = dispatched.map((payload) =>
      String((payload.client_payload as Record<string, unknown>).target_repo),
    );
    assert.equal(new Set(targets).size, 2);
    assert.equal(targets.filter((target) => target === "openclaw/gogcli").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review review retries park at the attempt ceiling and recover after cooldown", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const liveHeadSha = `956eaead7f${"0".repeat(30)}`;
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
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (/^\/repos\/openclaw\/openclaw\/pulls\/\d+$/.test(url.pathname)) {
      return jsonResponse({ state: "open", head: { sha: liveHeadSha } });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const itemKey = "openclaw/openclaw#113341";
  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    assert.equal(
      (
        await queue.fetch(
          buildExactReviewQueueRequest(
            "ceiling-1",
            113_341,
            "synchronize",
            "pull_request",
            "openclaw/openclaw",
            {
              sourceHeadSha: `956eaead7f${"0".repeat(30)}`,
              sourceHeadVerified: true,
              sourceAuthoritySeq: 1,
              sourceUpdatedAt: new Date().toISOString(),
            },
          ),
        )
      ).status,
      202,
    );

    const failOnce = async (cycle: number) => {
      const ready = (await storage.get("exact-review-queue")) as {
        items: Record<string, { state: string; nextAttemptAt: number }>;
      };
      if (ready.items[itemKey]?.state === "pending") {
        ready.items[itemKey].nextAttemptAt = Date.now() - 1;
        await storage.put("exact-review-queue", ready);
      }
      const before = dispatched.length;
      await queue.alarm();
      if (dispatched.length === before) return false;
      const payload = dispatched.at(-1)?.client_payload as {
        queue_lease_id: string;
        queue_claim: { item_key: string; lease_revision: number };
      };
      const claim = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: payload.queue_lease_id,
            item_key: payload.queue_claim.item_key,
            lease_revision: payload.queue_claim.lease_revision,
            run_id: `90000${cycle}`,
            run_attempt: 1,
          }),
        }),
      );
      assert.equal(claim.status, 200);
      const claimed = (await claim.json()) as { claim_generation: number };
      const completed = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/complete", {
          method: "POST",
          body: JSON.stringify({
            lease_id: payload.queue_lease_id,
            item_key: payload.queue_claim.item_key,
            lease_revision: payload.queue_claim.lease_revision,
            claim_generation: claimed.claim_generation,
            run_id: `90000${cycle}`,
            run_attempt: 1,
            outcome: "failure",
          }),
        }),
      );
      assert.equal(completed.status, 200);
      return true;
    };

    const readItem = async () => {
      const state = (await storage.get("exact-review-queue")) as {
        items: Record<
          string,
          {
            state: string;
            attempts: number;
            nextAttemptAt: number;
            parkedReason?: string;
            parkedRecoveryAttempts?: number;
          }
        >;
      };
      return state.items[itemKey];
    };

    for (let cycle = 1; cycle <= 7; cycle += 1) {
      assert.equal(await failOnce(cycle), true);
      const item = await readItem();
      assert.equal(item.state, "pending");
      assert.equal(item.attempts, cycle);
      assert.equal(item.parkedReason, undefined);
      assert.ok(item.nextAttemptAt > Date.now());
    }

    assert.equal(await failOnce(8), true);
    const parked = await readItem();
    assert.equal(parked.state, "parked");
    assert.equal(parked.attempts, 8);
    assert.equal(parked.parkedReason, "review_retry_exhausted");
    assert.equal(dispatched.length, 8);

    assert.equal(await failOnce(9), false);
    assert.equal(dispatched.length, 8);
    assert.equal((await readItem()).state, "parked");

    const stats = (await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json()) as { lanes: { review: { parked: number; pending: number } } };
    assert.equal(stats.lanes.review.parked, 1);
    assert.equal(stats.lanes.review.pending, 0);

    const status = (await (
      await queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=openclaw%2Fopenclaw&item_number=113341",
        ),
      )
    ).json()) as { items: Array<{ state: string; parked_reason: string | null }> };
    assert.deepEqual(
      status.items.map((entry) => [entry.state, entry.parked_reason]),
      [["parked", "review_retry_exhausted"]],
    );

    const due = (await storage.get("exact-review-queue")) as {
      items: Record<string, { parkedRecoveryAt?: number; updatedAt: number }>;
    };
    due.items[itemKey].parkedRecoveryAt = due.items[itemKey].updatedAt;
    await storage.put("exact-review-queue", due);
    await queue.alarm();
    assert.equal(dispatched.length, 9);
    const recovered = await readItem();
    assert.equal(recovered.state, "dispatching");
    assert.equal(recovered.attempts, 0);
    assert.equal(recovered.parkedReason, undefined);
    assert.equal(recovered.parkedRecoveryAttempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review parking spreads a same-tick cohort across persisted recovery timestamps", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-08-08T12:00:00.000Z");
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const items = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const item = leasedExactReviewQueueItem(120_000 + index, `12000${index}`);
        item.attempts = 7;
        item.reviewFailureAttempts = 7;
        return [item.key, item];
      }),
    );
    await storage.put("exact-review-queue", { deliveries: {}, items });
    const queue = new ExactReviewQueue({ storage }, {}, seededRandom(0x5eed));

    for (const item of Object.values(items)) {
      const response = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/complete", {
          method: "POST",
          body: JSON.stringify({
            lease_id: item.leaseId,
            item_key: item.key,
            lease_revision: item.leaseRevision,
            claim_generation: item.claimGeneration,
            run_id: item.claimedRunId,
            run_attempt: item.claimedRunAttempt,
            outcome: "failure",
          }),
        }),
      );
      assert.equal(response.status, 200);
    }

    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, { state: string; parkedRecoveryAt?: number }>;
    };
    const recoveryTimes = Object.values(state.items).map((item) => {
      assert.equal(item.state, "parked");
      assert.ok(Number(item.parkedRecoveryAt) >= now + 3.75 * 60_000);
      assert.ok(Number(item.parkedRecoveryAt) <= now + 7.5 * 60_000);
      return Number(item.parkedRecoveryAt);
    });
    assert.ok(new Set(recoveryTimes).size > 1);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review automatic parked recovery remains bounded", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  await queue.fetch(buildExactReviewQueueRequest("bounded-parked-recovery", 113_342, "opened"));
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        parkedReason?: string;
        parkedRecoveryAttempts?: number;
        updatedAt: number;
      }
    >;
  };
  const item = state.items["openclaw/gogcli#113342"];
  item.state = "parked";
  item.parkedReason = "review_retry_exhausted";
  item.parkedRecoveryAttempts = 3;
  item.updatedAt = Date.now() - 24 * 60 * 60_000;
  await storage.put("exact-review-queue", state);

  await queue.alarm();

  const retained = (await storage.get("exact-review-queue")) as typeof state;
  assert.equal(retained.items["openclaw/gogcli#113342"].state, "parked");
  assert.equal(retained.items["openclaw/gogcli#113342"].parkedRecoveryAttempts, 3);
  assert.equal(await storage.getAlarm(), null);
});

test("exact-review admission requeue_latest resets failures instead of parking at the review ceiling", async () => {
  const storage = new MemoryDurableStorage();
  const review = leasedExactReviewQueueItem(113_342, "9130");
  const publication = leasedExactReviewPublicationItem(113_343, "9131");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      [review.key]: { ...review, attempts: 7, reviewFailureAttempts: 7 },
      [publication.key]: { ...publication, attempts: 40, reviewFailureAttempts: 40 },
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const completion = (item: { key: string }, runId: string, extra: Record<string, unknown>) =>
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: `lease-${item.key.split("#")[1].split("@")[0]}`,
        item_key: item.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: runId,
        run_attempt: 1,
        ...extra,
      }),
    });

  assert.equal(
    (await queue.fetch(completion(review, "9130", { outcome: "success", requeue_latest: true })))
      .status,
    200,
  );
  assert.equal(
    (await queue.fetch(completion(publication, "9131", { outcome: "failure" }))).status,
    200,
  );

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; attempts: number; reviewFailureAttempts?: number; parkedReason?: string }
    >;
  };
  assert.equal(state.items[review.key].state, "pending");
  assert.equal(state.items[review.key].attempts, 0);
  assert.equal(state.items[review.key].reviewFailureAttempts, 0);
  assert.equal(state.items[review.key].parkedReason, undefined);
  assert.equal(state.items[publication.key].state, "pending");
  assert.equal(state.items[publication.key].attempts, 41);
  assert.equal(state.items[publication.key].parkedReason, undefined);
});

test("exact-review queue can use the global capacity for one target", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
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
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "4",
      },
    );
    for (const itemNumber of [701, 702, 703, 704]) {
      await queue.fetch(
        buildExactReviewQueueRequest(`delivery-${itemNumber}`, itemNumber, "opened"),
      );
    }

    await queue.alarm();

    assert.equal(dispatched.length, 4);
    assert.equal(
      new Set(
        dispatched.map(
          (payload) => (payload.client_payload as Record<string, unknown>).target_repo,
        ),
      ).size,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue keeps publication artifacts durable outside review capacity", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse(Object.fromEntries([["token", "t"]]));
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
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "4",
      },
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:100:1",
        801,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(801, "100"),
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:101:1",
        802,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(802, "101"),
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:102:1",
        803,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(803, "102"),
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:103:1",
        804,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(804, "103", "failed_review_shard_recovery"),
      ),
    );
    await queue.fetch(buildExactReviewQueueRequest("ordinary-801", 801, "edited"));
    await queue.fetch(buildExactReviewQueueRequest("ordinary-803", 803, "edited"));

    const state = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          createdAt: number;
          decision: Record<string, unknown>;
          dispatchedAt?: number;
          leaseDecision?: Record<string, unknown>;
          leaseExpiresAt?: number;
          leaseId?: string;
          leaseRevision?: number;
          nextAttemptAt: number;
          revision: number;
          state: string;
        }
      >;
    };
    assert.deepEqual(Object.keys(state.items).sort(), [
      "openclaw/gogcli#801",
      "openclaw/gogcli#801@publish:100:1",
      "openclaw/gogcli#802@publish:101:1",
      "openclaw/gogcli#803",
      "openclaw/gogcli#803@publish:102:1",
      "openclaw/gogcli#804@publish:103:1",
    ]);
    state.items["openclaw/gogcli#802@publish:101:1"].createdAt =
      Date.now() - 81 * 24 * 60 * 60 * 1000;
    state.items["openclaw/gogcli#802@publish:101:1"].nextAttemptAt = Date.now() - 1;
    state.items["openclaw/gogcli#803@publish:102:1"].createdAt =
      Date.now() - 81 * 24 * 60 * 60 * 1000;
    state.items["openclaw/gogcli#803@publish:102:1"].nextAttemptAt = Date.now() - 1;
    state.items["openclaw/gogcli#804@publish:103:1"].createdAt =
      Date.now() - 81 * 24 * 60 * 60 * 1000;
    state.items["openclaw/gogcli#804@publish:103:1"].nextAttemptAt = Date.now() - 1;
    const activeFreshReview = state.items["openclaw/gogcli#803"];
    activeFreshReview.state = "leased";
    activeFreshReview.decision = {
      ...activeFreshReview.decision,
      additionalPrompt: "newer maintainer context",
    };
    activeFreshReview.revision = 4;
    activeFreshReview.leaseId = "lease-fresh-803";
    activeFreshReview.leaseRevision = 4;
    activeFreshReview.leaseDecision = { ...activeFreshReview.decision };
    activeFreshReview.leaseExpiresAt = Date.now() + 60_000;
    const activeFreshReviewBeforeExpiry = structuredClone(activeFreshReview);
    await storage.put("exact-review-queue", state);

    await queue.alarm();
    const sourceActions = dispatched.map((payload) =>
      String((payload.client_payload as Record<string, unknown>).source_action),
    );
    assert.equal(
      sourceActions.filter((action) => action === "exact_review_artifact_publish").length,
      1,
    );
    assert.equal(sourceActions.filter((action) => action === "edited").length, 1);
    assert.equal(
      sourceActions.filter((action) => action === "artifact_retention_recovery").length,
      1,
    );
    assert.equal(
      sourceActions.filter((action) => action === "failed_review_shard_recovery").length,
      1,
    );
    assert.equal(
      dispatched.some(
        (payload) =>
          Number((payload.client_payload as Record<string, unknown>).item_number) === 803,
      ),
      false,
    );
    const afterExpiry = (await storage.get("exact-review-queue")) as typeof state;
    assert.deepEqual(afterExpiry.items["openclaw/gogcli#803"], activeFreshReviewBeforeExpiry);
    assert.equal(afterExpiry.items["openclaw/gogcli#803@publish:102:1"], undefined);
    const reservedPublisher = afterExpiry.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(reservedPublisher.state, "dispatching");
    assert.ok((reservedPublisher.leaseExpiresAt ?? 0) - Date.now() > 14 * 60_000);
    assert.ok((reservedPublisher.leaseExpiresAt ?? 0) - Date.now() <= 15 * 60_000);
    const publicationPayload = dispatched.find(
      (payload) =>
        (payload.client_payload as Record<string, unknown>).source_action ===
        "exact_review_artifact_publish",
    )?.client_payload as Record<string, unknown>;
    assert.match(
      String((publicationPayload.queue_claim as Record<string, unknown>).item_key),
      /@publish:/,
    );
    assert.ok(
      (
        (publicationPayload.review_options as Record<string, unknown>).publication as Record<
          string,
          unknown
        >
      ).producerDecision,
    );

    const firstPublicationLease = {
      leaseId: reservedPublisher.leaseId,
      leaseRevision: reservedPublisher.leaseRevision,
    };
    reservedPublisher.dispatchedAt = Date.now() - 16 * 60_000;
    reservedPublisher.leaseExpiresAt = Date.now() + 7 * 24 * 60 * 60_000;
    await storage.put("exact-review-queue", afterExpiry);

    let queueMaintenance: Promise<unknown> | undefined;
    await worker.scheduled(
      {},
      { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
      { waitUntil: (promise) => (queueMaintenance = promise) },
    );
    await queueMaintenance;
    const afterScheduledMaintenance = (await storage.get("exact-review-queue")) as typeof state;
    const scheduledPublisher = afterScheduledMaintenance.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(scheduledPublisher.state, "pending");
    assert.equal(scheduledPublisher.leaseId, undefined);
    assert.ok(((await storage.getAlarm()) ?? Number.POSITIVE_INFINITY) <= Date.now() + 1_000);

    await queue.alarm();
    const afterScheduledRedispatch = (await storage.get("exact-review-queue")) as typeof state;
    const scheduledRedispatch = afterScheduledRedispatch.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(scheduledRedispatch.state, "dispatching");
    assert.notEqual(scheduledRedispatch.leaseId, firstPublicationLease.leaseId);
    assert.equal(
      dispatched.filter(
        (payload) =>
          (payload.client_payload as Record<string, unknown>).source_action ===
          "exact_review_artifact_publish",
      ).length,
      2,
    );

    const scheduledPublicationLease = {
      leaseId: scheduledRedispatch.leaseId,
      leaseRevision: scheduledRedispatch.leaseRevision,
    };
    scheduledRedispatch.dispatchedAt = Date.now() - 16 * 60_000;
    scheduledRedispatch.leaseExpiresAt = Date.now() + 7 * 24 * 60 * 60_000;
    await storage.put("exact-review-queue", afterScheduledRedispatch);

    const expiredLegacyClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: scheduledPublicationLease.leaseId,
          item_key: "openclaw/gogcli#801@publish:100:1",
          lease_revision: scheduledPublicationLease.leaseRevision,
          run_id: "999998",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(expiredLegacyClaim.status, 409);
    assert.deepEqual(await expiredLegacyClaim.json(), { error: "lease_not_active" });
    const afterExpiredClaim = (await storage.get("exact-review-queue")) as typeof state;
    const reclaimedPublisher = afterExpiredClaim.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(reclaimedPublisher.state, "pending");
    assert.equal(reclaimedPublisher.leaseId, undefined);
    assert.ok(((await storage.getAlarm()) ?? Number.POSITIVE_INFINITY) <= Date.now() + 1_000);

    await queue.alarm();

    const publicationDispatches = dispatched.filter(
      (payload) =>
        (payload.client_payload as Record<string, unknown>).source_action ===
        "exact_review_artifact_publish",
    );
    assert.equal(publicationDispatches.length, 3);
    const afterRedispatch = (await storage.get("exact-review-queue")) as typeof state;
    const redispatchedPublisher = afterRedispatch.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(redispatchedPublisher.state, "dispatching");
    assert.notEqual(redispatchedPublisher.leaseId, scheduledPublicationLease.leaseId);
    assert.ok((redispatchedPublisher.leaseExpiresAt ?? 0) - Date.now() > 14 * 60_000);
    const staleClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: firstPublicationLease.leaseId,
          item_key: "openclaw/gogcli#801@publish:100:1",
          lease_revision: firstPublicationLease.leaseRevision,
          run_id: "999999",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(staleClaim.status, 409);
    assert.deepEqual(await staleClaim.json(), { error: "lease_not_active" });
    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.enqueued_total, 4);
    assert.equal(stats.lanes.publication.enqueued_total, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue wakes while target capacity remains", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
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
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "2",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-801", 801, "opened"));
    await queue.alarm();
    await queue.fetch(buildExactReviewQueueRequest("delivery-802", 802, "opened"));

    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm <= Date.now() + 5_000);

    await queue.alarm();
    assert.equal(dispatched.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue defers retained backlog until a paused dispatcher retry", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
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
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "2",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-paused-a", 801, "opened"));
    await queue.alarm();
    await queue.fetch(buildExactReviewQueueRequest("delivery-paused-b", 802, "opened"));
    await queue.fetch(buildExactReviewQueueRequest("delivery-paused-c", 803, "opened"));

    const state = (await storage.get("exact-review-queue")) as {
      dispatcher?: Record<string, unknown>;
      items: Record<
        string,
        { leaseExpiresAt?: number; nextAttemptAt: number; state: string; backoffReason?: string }
      >;
    };
    const leaseExpiresAt = Date.now() + 60_000;
    const retryAt = Date.now() + 15 * 60_000;
    const retainedAttemptAt = Date.now() - 1;
    state.dispatcher = {
      state: "paused",
      reason: "workflow_not_active",
      checkedAt: Date.now(),
      retryAt,
    };
    state.items["openclaw/gogcli#801"].leaseExpiresAt = leaseExpiresAt;
    state.items["openclaw/gogcli#802"].nextAttemptAt = retryAt;
    state.items["openclaw/gogcli#802"].backoffReason = "dispatcher_backoff";
    state.items["openclaw/gogcli#803"].nextAttemptAt = retainedAttemptAt;
    await storage.put("exact-review-queue", state);
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));

    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm <= leaseExpiresAt);

    // Emulate a pre-pause alarm that remains scheduled for an active lease,
    // then fires before the paused dispatcher's retry deadline.
    state.items["openclaw/gogcli#801"].leaseExpiresAt = Date.now() - 1;
    await storage.put("exact-review-queue", state);
    await queue.alarm();
    assert.equal(dispatched.length, 1);
    const after = (await storage.get("exact-review-queue")) as typeof state;
    assert.equal(after.items["openclaw/gogcli#802"].nextAttemptAt, retryAt);
    assert.equal(after.items["openclaw/gogcli#802"].backoffReason, "dispatcher_backoff");
    assert.equal(after.items["openclaw/gogcli#803"].nextAttemptAt, retainedAttemptAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("canonical tuple publication updates Worker authority without a git projection row", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const item =
    "---\nrepo: openclaw/openclaw\nnumber: 42\nreviewed_at: 2026-07-26T02:00:00.000Z\n---\n\nreview\n";
  const mutation = {
    deliveryId: "record-tuple:run-1:42",
    key: "openclaw-openclaw/42",
    operations: [
      {
        path: "records/openclaw-openclaw/items/42.md",
        expectedDigest: null,
        contentBase64: Buffer.from(item).toString("base64"),
      },
      { path: "records/openclaw-openclaw/closed/42.md", expectedDigest: null },
      { path: "records/openclaw-openclaw/plans/42.md", expectedDigest: null },
      { path: "records/openclaw-openclaw/decision-packets/42.json", expectedDigest: null },
    ],
  };

  const first = await queue.fetch(stateAppendQueueRequest("/records/tuples", mutation));
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    ok: true,
    accepted: true,
    deduped: false,
    revision: 1,
  });
  const duplicate = await queue.fetch(stateAppendQueueRequest("/records/tuples", mutation));
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).deduped, true);

  const canonical = await (
    await queue.fetch(
      new Request("https://queue/records/openclaw-openclaw/items/42", { method: "GET" }),
    )
  ).json();
  assert.equal(canonical.content, item);
  assert.equal(canonical.digest, createHash("sha256").update(item).digest("hex"));
  assert.equal(canonical.revision, 1);

  const reconciledItem = item.replace(
    "reviewed_at: 2026-07-26T02:00:00.000Z",
    "reviewed_at: 2026-07-26T02:00:00.000Z\nreconciled_at: 2026-07-27T02:00:00.000Z",
  );
  const reconciliation = structuredClone(mutation);
  reconciliation.deliveryId = "record-reconcile:openclaw-openclaw:42:authority-fix";
  reconciliation.operations[0]!.expectedDigest = createHash("sha256").update(item).digest("hex");
  reconciliation.operations[0]!.contentBase64 = Buffer.from(reconciledItem).toString("base64");
  const reconciled = await queue.fetch(stateAppendQueueRequest("/records/tuples", reconciliation));
  assert.equal(reconciled.status, 202);
  assert.equal((await reconciled.json()).revision, 2);

  const conflict = structuredClone(mutation);
  conflict.deliveryId = "record-tuple:run-2:42";
  conflict.operations[0]!.expectedDigest = "0".repeat(64);
  const rejected = await queue.fetch(stateAppendQueueRequest("/records/tuples", conflict));
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), {
    error: "canonical_record_tuple_conflict",
    current: {
      key: "openclaw-openclaw/42",
      revision: 2,
      deliveryId: reconciliation.deliveryId,
      operations: [
        {
          path: "records/openclaw-openclaw/items/42.md",
          expectedDigest: createHash("sha256").update(reconciledItem).digest("hex"),
          contentBase64: Buffer.from(reconciledItem).toString("base64"),
        },
        { path: "records/openclaw-openclaw/closed/42.md", expectedDigest: null },
        { path: "records/openclaw-openclaw/plans/42.md", expectedDigest: null },
        {
          path: "records/openclaw-openclaw/decision-packets/42.json",
          expectedDigest: null,
        },
      ],
    },
  });
});

test("review coverage summarizes canonical item records per fleet", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const now = Date.now();
  const itemRecord = (repo: string | null, number: number, frontMatter: string) =>
    `---\n${repo ? `repo: ${repo}\n` : ""}number: ${number}\n${frontMatter}---\n\nreview body\n`;
  const publish = async (slug: string, number: number, content: string) => {
    const response = await queue.fetch(
      stateAppendQueueRequest("/records/tuples", {
        deliveryId: `record-tuple:coverage:${slug}:${number}`,
        key: `${slug}/${number}`,
        operations: [
          {
            path: `records/${slug}/items/${number}.md`,
            expectedDigest: null,
            contentBase64: Buffer.from(content).toString("base64"),
          },
          { path: `records/${slug}/closed/${number}.md`, expectedDigest: null },
          { path: `records/${slug}/plans/${number}.md`, expectedDigest: null },
          { path: `records/${slug}/decision-packets/${number}.json`, expectedDigest: null },
        ],
      }),
    );
    assert.equal(response.status, 202);
  };
  const fresh = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const outdated = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
  await publish(
    "openclaw-openclaw",
    1,
    itemRecord("openclaw/openclaw", 1, `reviewed_at: ${fresh}\nreview_status: complete\n`),
  );
  await publish(
    "openclaw-openclaw",
    2,
    itemRecord("openclaw/openclaw", 2, `reviewed_at: ${outdated}\nreview_status: complete\n`),
  );
  await publish(
    "openclaw-openclaw",
    3,
    itemRecord("openclaw/openclaw", 3, `reviewed_at: ${outdated}\nreview_status: stale_reopened\n`),
  );
  await publish(
    "openclaw-openclaw",
    4,
    itemRecord("openclaw/openclaw", 4, `reviewed_at: ${fresh}\nreview_status: failed\n`),
  );
  await publish(
    "openclaw-openclaw",
    5,
    itemRecord(
      "openclaw/openclaw",
      5,
      `labels: ["security"]\nreviewed_at: ${fresh}\nreview_status: complete\n`,
    ),
  );
  await publish(
    "other-repo",
    9,
    itemRecord(null, 9, `reviewed_at: "${fresh}"\nreview_status: "complete"\n`),
  );
  await publish(
    "unmanaged-repo",
    10,
    itemRecord(null, 10, `reviewed_at: "${fresh}"\nreview_status: "complete"\n`),
  );
  const inventory = await queue.fetch(
    new Request("https://queue/review-coverage/inventory", {
      method: "POST",
      body: JSON.stringify({
        generated_at: new Date(now).toISOString(),
        repositories: [
          {
            repo: "openclaw/openclaw",
            repo_slug: "openclaw-openclaw",
            open_issues: 5,
            open_pull_requests: 2,
          },
          {
            repo: "other/repo",
            repo_slug: "other-repo",
            open_issues: 1,
            open_pull_requests: 1,
          },
        ],
      }),
    }),
  );
  assert.equal(inventory.status, 202);

  const response = await queue.fetch(new Request("https://queue/review-coverage"));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    ok: boolean;
    window_days: number;
    generated_at: string;
    fleets: Array<Record<string, unknown>>;
    totals: Record<string, unknown>;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.window_days, 7);
  assert.equal(payload.inventory_status, "current");
  assert.equal(payload.fleets.length, 3);
  const [openclaw, other, unmanaged] = payload.fleets;
  assert.equal(openclaw.repo, "openclaw/openclaw");
  assert.equal(openclaw.repo_slug, "openclaw-openclaw");
  assert.equal(openclaw.open_records, 7);
  assert.equal(openclaw.reviewable_records, 6);
  assert.equal(openclaw.tracked_records, 5);
  assert.equal(openclaw.reviewed_recent, 1);
  assert.equal(openclaw.stale, 1);
  assert.equal(openclaw.failed, 1);
  assert.equal(openclaw.expired, 1);
  assert.equal(openclaw.untracked_open, 2);
  assert.equal(openclaw.pending, 3);
  assert.equal(openclaw.excluded, 1);
  assert.equal(openclaw.coverage_percent, 16.7);
  assert.equal(openclaw.oldest_reviewed_at, new Date(Date.parse(outdated)).toISOString());
  assert.equal(other.repo, "other/repo");
  assert.equal(other.open_records, 2);
  assert.equal(other.reviewed_recent, 1);
  assert.equal(other.untracked_open, 1);
  assert.equal(other.coverage_percent, 50);
  assert.equal(unmanaged.schedulable, false);
  assert.equal(unmanaged.tracked_records, 1);
  assert.equal(unmanaged.unschedulable_records, 1);
  assert.deepEqual(payload.totals, {
    open_records: 9,
    reviewable_records: 8,
    tracked_records: 6,
    reviewed_recent: 2,
    stale: 1,
    failed: 1,
    expired: 1,
    unreviewed_records: 0,
    untracked_open: 3,
    pending: 4,
    excluded: 1,
    unschedulable_records: 1,
    record_drift: 0,
    coverage_percent: 25,
  });

  // Deleting the record tombstones it out of the open universe.
  await queue.fetch(
    stateAppendQueueRequest("/records/tuples", {
      deliveryId: "record-tuple:coverage:other-repo:9:close",
      key: "other-repo/9",
      operations: [
        {
          path: "records/other-repo/items/9.md",
          expectedDigest: createHash("sha256")
            .update(itemRecord(null, 9, `reviewed_at: "${fresh}"\nreview_status: "complete"\n`))
            .digest("hex"),
        },
        { path: "records/other-repo/closed/9.md", expectedDigest: null },
        { path: "records/other-repo/plans/9.md", expectedDigest: null },
        { path: "records/other-repo/decision-packets/9.json", expectedDigest: null },
      ],
    }),
  );
  const cached = (await (
    await queue.fetch(new Request("https://queue/review-coverage"))
  ).json()) as {
    generated_at: string;
    totals: Record<string, unknown>;
  };
  // Responses are cached for up to a minute; the tombstone appears on refresh.
  assert.equal(cached.generated_at, payload.generated_at);
  assert.equal(cached.totals.open_records, 9);
  assert.equal(cached.totals.tracked_records, 6);
});

test("worker exposes review coverage through the public API route", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const secret = "coverage-secret";
  const env = {
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
  };
  const inventoryBody = JSON.stringify({
    generated_at: new Date().toISOString(),
    repositories: [
      {
        repo: "openclaw/openclaw",
        repo_slug: "openclaw-openclaw",
        open_issues: 1,
        open_pull_requests: 0,
      },
    ],
  });
  const inventorySignature = `sha256=${createHmac("sha256", secret).update(inventoryBody).digest("hex")}`;
  const inventoryResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/review-coverage/inventory", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": inventorySignature },
      body: inventoryBody,
    }),
    env,
  );
  assert.equal(inventoryResponse.status, 202);
  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/review-coverage"),
    env,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { ok: boolean; fleets: unknown[] };
  assert.equal(payload.ok, true);
  assert.equal(payload.fleets.length, 1);

  const unconfigured = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/review-coverage"),
    {},
  );
  assert.equal(unconfigured.status, 503);
});

test("apply preselect and checkpoint publish captured canonical tuple baselines", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-preselect-source-"));
  const sparseStateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawsweeper-apply-preselect-state-"),
  );
  const canonicalBaselineRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawsweeper-apply-preselect-baseline-"),
  );
  const itemId = 100078;
  const tupleRoot = "records/openclaw-openclaw";
  const itemPath = `${tupleRoot}/items/${itemId}.md`;
  const closedPath = `${tupleRoot}/closed/${itemId}.md`;
  const planPath = `${tupleRoot}/plans/${itemId}.md`;
  const packetPath = `${tupleRoot}/decision-packets/${itemId}.json`;
  const packet = (state: "open" | "closed", reportPath: string, number = itemId) =>
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: "2026-07-27T18:00:00.000Z",
        updatedAt: "2026-07-27T17:00:00.000Z",
        subject: { repo: "openclaw/openclaw", kind: "issue", number, state },
        source: { reportPath, reviewedAt: "2026-07-27T18:00:00.000Z" },
      },
      null,
      2,
    )}\n`;
  const primary = (
    state: "open" | "closed",
    packetContent: string,
    reconciledAt: string,
    number = itemId,
  ) =>
    [
      "---",
      `decision_packet_sha256: ${createHash("sha256").update(packetContent).digest("hex")}`,
      `decision_packet_path: ${tupleRoot}/decision-packets/${number}.json`,
      `number: ${number}`,
      "repository: openclaw/openclaw",
      `current_state: ${state}`,
      "reviewed_at: 2026-07-27T18:00:00.000Z",
      `reconciled_at: ${reconciledAt}`,
      "---",
      "",
      "production-shaped canonical record",
      "",
    ].join("\n");

  const openPacket = packet("open", itemPath);
  const openPrimary = primary("open", openPacket, "2026-07-27T19:00:00.000Z");
  const seeded = await queue.fetch(
    stateAppendQueueRequest("/records/tuples", {
      deliveryId: `record-reconcile:openclaw-openclaw:${itemId}:corrective-tuple`,
      key: `openclaw-openclaw/${itemId}`,
      operations: [
        {
          path: itemPath,
          expectedDigest: null,
          contentBase64: Buffer.from(openPrimary).toString("base64"),
        },
        { path: closedPath, expectedDigest: null },
        { path: planPath, expectedDigest: null },
        {
          path: packetPath,
          expectedDigest: null,
          contentBase64: Buffer.from(openPacket).toString("base64"),
        },
      ],
    }),
  );
  assert.equal(seeded.status, 202, await seeded.text());

  const write = (base: string, relativePath: string, content: string) => {
    const destination = path.join(base, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, "utf8");
  };
  // Worker hydration writes canonical records to the lane worktree. The state
  // checkout is sparse and intentionally has no records/ baseline.
  write(root, itemPath, openPrimary);
  write(root, packetPath, openPacket);
  captureCanonicalRecordBaseline({
    baselineRoot: canonicalBaselineRoot,
    repositorySlug: "openclaw-openclaw",
    itemNumber: itemId,
    sources: [
      { section: "items", name: `${itemId}.md`, path: path.join(root, itemPath) },
      { section: "closed", name: `${itemId}.md`, path: path.join(root, closedPath) },
      { section: "plans", name: `${itemId}.md`, path: path.join(root, planPath) },
      {
        section: "decision-packets",
        name: `${itemId}.json`,
        path: path.join(root, packetPath),
      },
    ],
  });

  const closedPacket = packet("closed", closedPath);
  const closedPrimary = primary("closed", closedPacket, "2026-07-28T04:33:00.000Z");
  fs.unlinkSync(path.join(root, itemPath));
  write(root, closedPath, closedPrimary);
  write(root, packetPath, closedPacket);

  const laneResponses: Array<{ status: number; body: Record<string, unknown> }> = [];
  await publishMainWithStateAppend(
    {
      message: "chore: persist sweep reconciliation",
      paths: [itemPath, closedPath, planPath, packetPath],
      rebaseStrategy: "normal",
    },
    {
      root,
      env: {
        CLAWSWEEPER_STATE_DIR: sparseStateRoot,
        CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: canonicalBaselineRoot,
        CLAWSWEEPER_CANONICAL_PUBLICATION_KIND: "reconcile",
        QUEUE_URL: "https://queue.test",
        CLAWSWEEPER_WEBHOOK_SECRET: "apply-preselect-test-secret",
      },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        const mutation = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const response = await queue.fetch(stateAppendQueueRequest("/records/tuples", mutation));
        const body = (await response.json()) as Record<string, unknown>;
        laneResponses.push({ status: response.status, body });
        return Response.json(body, { status: response.status });
      }) as typeof fetch,
      publishGit: () => {
        throw new Error("canonical reconciliation must not use Git publication");
      },
    },
  );

  assert.equal(laneResponses[0]?.status, 202);
  const closed = await queue.fetch(
    new Request(`https://queue/records/openclaw-openclaw/closed/${itemId}`, { method: "GET" }),
  );
  assert.equal(
    closed.status,
    200,
    "the legitimate items-to-closed move must reach canonical state",
  );
  assert.equal((await closed.json()).content, closedPrimary);

  // The checkpoint lane mutates a hydrated record after preselect. Its state
  // checkout still has no records/, and the broad records path must be scoped
  // to the tuple captured immediately before this mutation.
  const applyItemId = itemId + 1;
  const applyItemPath = `${tupleRoot}/items/${applyItemId}.md`;
  const applyClosedPath = `${tupleRoot}/closed/${applyItemId}.md`;
  const applyPlanPath = `${tupleRoot}/plans/${applyItemId}.md`;
  const applyPacketPath = `${tupleRoot}/decision-packets/${applyItemId}.json`;
  const applyPacket = packet("open", applyItemPath, applyItemId);
  const applyBefore = primary("open", applyPacket, "2026-07-28T04:34:00.000Z", applyItemId);
  const applySeed = await queue.fetch(
    stateAppendQueueRequest("/records/tuples", {
      deliveryId: `record-reconcile:openclaw-openclaw:${applyItemId}:seed`,
      key: `openclaw-openclaw/${applyItemId}`,
      operations: [
        {
          path: applyItemPath,
          expectedDigest: null,
          contentBase64: Buffer.from(applyBefore).toString("base64"),
        },
        { path: applyClosedPath, expectedDigest: null },
        { path: applyPlanPath, expectedDigest: null },
        {
          path: applyPacketPath,
          expectedDigest: null,
          contentBase64: Buffer.from(applyPacket).toString("base64"),
        },
      ],
    }),
  );
  assert.equal(applySeed.status, 202, await applySeed.text());
  write(root, applyItemPath, applyBefore);
  write(root, applyPacketPath, applyPacket);

  const applyBaselineRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawsweeper-apply-checkpoint-baseline-"),
  );
  captureCanonicalRecordBaseline({
    baselineRoot: applyBaselineRoot,
    repositorySlug: "openclaw-openclaw",
    itemNumber: applyItemId,
    sources: [
      { section: "items", name: `${applyItemId}.md`, path: path.join(root, applyItemPath) },
      {
        section: "closed",
        name: `${applyItemId}.md`,
        path: path.join(root, applyClosedPath),
      },
      { section: "plans", name: `${applyItemId}.md`, path: path.join(root, applyPlanPath) },
      {
        section: "decision-packets",
        name: `${applyItemId}.json`,
        path: path.join(root, applyPacketPath),
      },
    ],
  });
  const applyAfter = applyBefore.replace(
    "reconciled_at: 2026-07-28T04:34:00.000Z",
    "reconciled_at: 2026-07-28T04:34:00.000Z\napply_checked_at: 2026-07-28T05:24:00.000Z",
  );
  write(root, applyItemPath, applyAfter);

  const unrelatedItemId = applyItemId + 1;
  const unrelatedItemPath = `${tupleRoot}/items/${unrelatedItemId}.md`;
  const unrelatedPacketPath = `${tupleRoot}/decision-packets/${unrelatedItemId}.json`;
  const unrelatedPacket = packet("open", unrelatedItemPath, unrelatedItemId);
  write(
    root,
    unrelatedItemPath,
    primary("open", unrelatedPacket, "2026-07-28T04:35:00.000Z", unrelatedItemId),
  );
  write(root, unrelatedPacketPath, unrelatedPacket);

  const applyMutations: Array<Record<string, unknown>> = [];
  await publishMainWithStateAppend(
    {
      message: "chore: apply sweep decisions checkpoint 1",
      paths: [tupleRoot],
      rebaseStrategy: "normal",
    },
    {
      root,
      env: {
        CLAWSWEEPER_STATE_DIR: sparseStateRoot,
        CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: applyBaselineRoot,
        QUEUE_URL: "https://queue.test",
        CLAWSWEEPER_WEBHOOK_SECRET: "apply-checkpoint-test-secret",
      },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        const mutation = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        applyMutations.push(mutation);
        const response = await queue.fetch(stateAppendQueueRequest("/records/tuples", mutation));
        return Response.json(await response.json(), { status: response.status });
      }) as typeof fetch,
      publishGit: () => {
        throw new Error("canonical apply checkpoint must not use Git publication");
      },
    },
  );

  assert.equal(applyMutations.length, 1);
  assert.equal(applyMutations[0]?.key, `openclaw-openclaw/${applyItemId}`);
  const applied = await queue.fetch(
    new Request(`https://queue/records/openclaw-openclaw/items/${applyItemId}`, { method: "GET" }),
  );
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).content, applyAfter);
});

test("canonical tuple failures return stable errors and sanitize server logs", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "canonical-storage-secret";
  storage.failNextSql(
    /INSERT INTO exact_review_canonical_records/,
    new Error(
      `database unavailable at https://operator:${secret}@storage.example/records?token=${secret}`,
    ),
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
  try {
    const response = await queue.fetch(
      stateAppendQueueRequest("/records/tuples", {
        deliveryId: "record-tuple:failure:42",
        key: "openclaw-openclaw/42",
        operations: [
          {
            path: "records/openclaw-openclaw/items/42.md",
            expectedDigest: null,
            contentBase64: Buffer.from("record\n").toString("base64"),
          },
          { path: "records/openclaw-openclaw/closed/42.md", expectedDigest: null },
          { path: "records/openclaw-openclaw/plans/42.md", expectedDigest: null },
          { path: "records/openclaw-openclaw/decision-packets/42.json", expectedDigest: null },
        ],
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_canonical_record_tuple" });
  } finally {
    console.warn = originalWarn;
  }
  assert.doesNotMatch(warnings.join("\n"), new RegExp(secret));
  assert.match(warnings.join("\n"), /https:\/\/\[REDACTED\]@storage\.example/);
  assert.match(warnings.join("\n"), /token=\[REDACTED\]/);
});

test("canonical tuple publication accepts explicit absent sidecars and closed records", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const packet = '{"version":1}\n';
  const packetDigest = createHash("sha256").update(packet).digest("hex");
  const cases = [
    {
      itemId: 51,
      primarySection: "items",
      primary: [
        "---",
        `decision_packet_sha256: ${packetDigest}`,
        "decision_packet_path: records/openclaw-openclaw/decision-packets/51.json",
        "---",
        "open item without a plan",
        "",
      ].join("\n"),
      plan: null,
      packet,
    },
    {
      itemId: 52,
      primarySection: "items",
      primary:
        "---\ndecision_packet_sha256: none\ndecision_packet_path: none\n---\nopen item without a packet\n",
      plan: "---\nreviewed_at: 2026-07-26T01:00:00Z\n---\nwork plan\n",
      packet: null,
    },
    {
      itemId: 53,
      primarySection: "closed",
      primary: "---\ndecision_packet_sha256: none\ndecision_packet_path: none\n---\nclosed item\n",
      plan: null,
      packet: null,
    },
  ] as const;

  for (const fixture of cases) {
    const content = new Map<string, string | null>([
      ["items", fixture.primarySection === "items" ? fixture.primary : null],
      ["closed", fixture.primarySection === "closed" ? fixture.primary : null],
      ["plans", fixture.plan],
      ["decision-packets", fixture.packet],
    ]);
    const operations = [...content].map(([section, value]) => ({
      path: `records/openclaw-openclaw/${section}/${fixture.itemId}.${section === "decision-packets" ? "json" : "md"}`,
      expectedDigest: null,
      ...(value === null ? {} : { contentBase64: Buffer.from(value).toString("base64") }),
    }));
    const response = await queue.fetch(
      stateAppendQueueRequest("/records/tuples", {
        deliveryId: `record-tuple:partial:${fixture.itemId}`,
        key: `openclaw-openclaw/${fixture.itemId}`,
        operations,
      }),
    );
    assert.equal(response.status, 202, await response.text());
  }
});

test("internal state endpoints reject invalid HMAC signatures", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const payload = { deliveryId: "auth-check", key: "openclaw-openclaw/1", operations: [] };
  const unsigned = await worker.fetch(
    stateAppendQueueRequest(
      "/internal/state/records/tuples",
      payload,
      "https://clawsweeper.openclaw.ai",
    ),
    env,
  );
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "invalid_signature" });

  // A correctly signed request passes authentication and fails only on its
  // payload shape, proving the signature gate is what rejected the call above.
  const signed = await worker.fetch(
    signedStateAppendRequest("/internal/state/records/tuples", payload, "test-secret"),
    env,
  );
  assert.equal(signed.status, 400);
});

test("internal state writer routes authenticate and preserve durable ticket identity", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-clawsweeper-webhook-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const acquire = {
    ticket_id: "state-writer:test-route",
    owner: "11111111-1111-4111-8111-111111111111",
    branch: "state",
    repository: "openclaw/clawsweeper-state",
    workflow: "State materializer",
    job: "materialize",
    run_id: "12345",
    run_attempt: 1,
    writer_class: "ordinary",
  };

  const unsigned = await worker.fetch(
    stateAppendQueueRequest(
      "/internal/state-writer/acquire",
      acquire,
      "https://clawsweeper.openclaw.ai",
    ),
    env,
  );
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "invalid_signature" });

  const invalid = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/acquire",
      { ...acquire, ticket_id: "state-writer:invalid", workflow: "bad\u0000metadata" },
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_state_writer_ticket" });

  const acquiredResponse = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/acquire",
      acquire,
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(acquiredResponse.status, 200);
  const acquired = (await acquiredResponse.json()) as {
    ok: boolean;
    ticket: { ticketId: string; owner: string; leaseToken: string; state: string };
  };
  assert.equal(acquired.ok, true);
  assert.equal(acquired.ticket.ticketId, acquire.ticket_id);
  assert.equal(acquired.ticket.owner, acquire.owner);
  assert.equal(acquired.ticket.state, "leased");

  const legacyTicket = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/acquire",
      {
        ...acquire,
        ticket_id: "state-writer:legacy-route",
        owner: "22222222-2222-4222-8222-222222222222",
        writer_class: undefined,
      },
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(legacyTicket.status, 200, "rolling-deploy clients default to ordinary admission");

  const ownership = {
    ticket_id: acquired.ticket.ticketId,
    owner: acquired.ticket.owner,
    ["lease_token"]: acquired.ticket.leaseToken,
  };
  const heartbeat = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/heartbeat",
      ownership,
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(heartbeat.status, 200);
  assert.equal(((await heartbeat.json()) as { ticket: { state: string } }).ticket.state, "leased");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const release = await worker.fetch(
      signedStateAppendRequest(
        "/internal/state-writer/release",
        ownership,
        "test-clawsweeper-webhook-secret",
      ),
      env,
    );
    assert.equal(release.status, 200);
    assert.deepEqual(await release.json(), { ok: true, released: true });
  }
  const stats = (await (await queue.fetch(new Request("https://queue/stats"))).json()) as {
    state_writer: { coordinator: { completed: number; active: unknown } };
  };
  assert.equal(stats.state_writer.coordinator.completed, 1);
  assert.equal(stats.state_writer.coordinator.active, null);
});

test("authenticated legacy exact-review intake enters the durable queue", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const payload = JSON.stringify({
    delivery_id: "legacy:100:1",
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 597,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "legacy_dispatch",
      supersedesInProgress: false,
      commandStatusMarker,
      statusCommentId: "9001",
      additionalPrompt: "Check the maintainer-requested regression path.",
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`;

  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/enqueue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/gogcli#597",
    superseded_publications: 0,
  });
  const stored = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: Record<string, unknown> }>;
  };
  assert.deepEqual(
    {
      commandStatusMarker: stored.items["openclaw/gogcli#597"].decision.commandStatusMarker,
      statusCommentId: stored.items["openclaw/gogcli#597"].decision.statusCommentId,
      additionalPrompt: stored.items["openclaw/gogcli#597"].decision.additionalPrompt,
    },
    {
      commandStatusMarker,
      statusCommentId: 9001,
      additionalPrompt: "Check the maintainer-requested regression path.",
    },
  );

  const denied = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(denied.status, 401);
});

test("authenticated legacy pull request intake reserves source authority", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const payload = JSON.stringify({
    delivery_id: "legacy:edited:857:1",
    installation_id: 123,
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 857,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "edited",
      supersedesInProgress: true,
      sourceHeadSha: "a".repeat(40),
      sourceBaseSha: "b".repeat(40),
      sourceIsDraft: false,
      sourceContentRevision: "c".repeat(64),
      sourceUpdatedAt: "2026-07-26T09:00:00Z",
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`;

  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/source-authority", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, source_authority_seq: 1 });
});

test("exact-review queue rejects unbounded or unsafe command context", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const invalidDecisions = [
    {
      commandStatusMarker: "<!-- clawsweeper-command-status:597:re_review:na -->\nextra",
    },
    { statusCommentId: Number.MAX_SAFE_INTEGER + 1 },
    { additionalPrompt: "x".repeat(5001) },
    { additionalPrompt: "unsafe\0prompt" },
  ];

  for (const [index, decision] of invalidDecisions.entries()) {
    const response = await queue.fetch(
      buildExactReviewQueueRequest(
        `invalid-command-context-${index}`,
        597,
        "legacy_dispatch",
        "issue",
        undefined,
        decision,
      ),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_exact_review_item" });
  }

  const reservedDelivery = await queue.fetch(
    buildExactReviewQueueRequest("__clawsweeper_sql_generation:99", 597, "opened"),
  );
  assert.equal(reservedDelivery.status, 400);
  assert.deepEqual(await reservedDelivery.json(), { error: "reserved_delivery_id" });
});

test("exact-review queue retries dispatch failures and reclaims an unclaimed lease", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchAttempts = 0;
  let workflowStatusAvailable = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      if (!workflowStatusAvailable) {
        return new Response(JSON.stringify({ message: "temporarily unavailable" }), {
          status: 503,
        });
      }
      return jsonResponse({ state: "active" });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatchAttempts += 1;
      if (dispatchAttempts === 1) {
        return new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
      }
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
      },
    );
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-1", 599, "opened"))).status,
      202,
    );

    await queue.alarm();
    let state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 1, dispatching: 0, leased: 0 },
    );
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "workflow_status_unavailable");
    assert.equal(dispatchAttempts, 0);

    const stored = (await storage.get("exact-review-queue")) as {
      dispatcher: { retryAt: number };
      items: Record<string, { nextAttemptAt: number }>;
    };
    workflowStatusAvailable = true;
    stored.dispatcher.retryAt = Date.now() - 1;
    stored.items["openclaw/gogcli#599"].nextAttemptAt = Date.now() - 1;
    await storage.put("exact-review-queue", stored);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 1, dispatching: 0, leased: 0 },
    );
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "dispatch_rate_limit");
    assert.equal(state.dispatcher.dispatch_failure_status, 429);
    assert.equal(state.dispatcher.dispatch_failure_class, "rate_limit");
    assert.equal(dispatchAttempts, 1);

    const retried = (await storage.get("exact-review-queue")) as {
      dispatcher: { retryAt: number };
      items: Record<string, { nextAttemptAt: number; attempts: number }>;
    };
    assert.equal(retried.items["openclaw/gogcli#599"].attempts, 0);
    retried.dispatcher.retryAt = Date.now() - 1;
    retried.items["openclaw/gogcli#599"].nextAttemptAt = Date.now() - 1;
    await storage.put("exact-review-queue", retried);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 0, dispatching: 1, leased: 0 },
    );

    const leased = (await storage.get("exact-review-queue")) as {
      items: Record<string, { leaseExpiresAt: number; leaseId: string; leaseRevision: number }>;
    };
    const firstLease = leased.items["openclaw/gogcli#599"];
    assert.ok(firstLease.leaseExpiresAt - Date.now() > 350_000);
    assert.ok(firstLease.leaseExpiresAt - Date.now() <= 360_000);
    firstLease.leaseExpiresAt = Date.now() - 1;
    await storage.put("exact-review-queue", leased);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 0, dispatching: 1, leased: 0 },
    );
    assert.equal(dispatchAttempts, 3);
    const staleClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: firstLease.leaseId,
          item_key: "openclaw/gogcli#599",
          lease_revision: firstLease.leaseRevision,
          run_id: "5990",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(staleClaim.status, 409);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue automatically retries a parked dispatch rejection after cooldown", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchStatus = 422;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches")
      return dispatchStatus === 204
        ? new Response(null, { status: 204 })
        : new Response(
            JSON.stringify({
              message: "Validation Failed: must-not-persist",
              errors: [
                {
                  resource: "Repository",
                  field: "client_payload",
                  code: "invalid",
                  value: "https://private.example/secret?token=must-not-persist",
                },
              ],
            }),
            { status: dispatchStatus },
          );
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("dispatch-rejected", 600, "opened"))).status,
      202,
    );
    await queue.alarm();

    const status = await (
      await queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=openclaw%2Fgogcli&item_number=600",
        ),
      )
    ).json();
    assert.equal(status.items[0].state, "parked");
    assert.equal(status.items[0].parked_reason, "dispatch_rejected");
    assert.equal(status.items[0].attempts, 0);
    assert.equal(status.items[0].dispatch_failure_status, 422);
    assert.equal(status.items[0].dispatch_failure_class, "permanent_rejection");
    assert.deepEqual(status.items[0].dispatch_failure_detail, {
      validation_fields: ["client_payload"],
      validation_codes: ["invalid"],
    });
    assert.match(status.items[0].dispatch_failure_fingerprint, /^dispatch-[0-9a-f]{8}$/);

    const persisted = JSON.stringify(await storage.get("exact-review-queue"));
    assert.doesNotMatch(persisted, /must-not-persist|private\.example|token=/);

    dispatchStatus = 204;
    const due = (await storage.get("exact-review-queue")) as {
      items: Record<string, { updatedAt: number; parkedRecoveryAt?: number }>;
    };
    const parked = due.items["openclaw/gogcli#600"];
    assert.ok(Number(parked.parkedRecoveryAt) >= parked.updatedAt + 3.75 * 60_000);
    assert.ok(Number(parked.parkedRecoveryAt) <= parked.updatedAt + 7.5 * 60_000);
    parked.parkedRecoveryAt = parked.updatedAt;
    await storage.put("exact-review-queue", due);
    await queue.alarm();
    const recovered = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          parkedReason?: string;
          parkedRecoveryAttempts?: number;
          dispatchFailureClass?: string;
          attempts: number;
        }
      >;
    };
    assert.equal(recovered.items["openclaw/gogcli#600"].state, "dispatching");
    assert.equal(recovered.items["openclaw/gogcli#600"].parkedReason, undefined);
    assert.equal(recovered.items["openclaw/gogcli#600"].parkedRecoveryAttempts, 1);
    assert.equal(recovered.items["openclaw/gogcli#600"].dispatchFailureClass, undefined);
    assert.equal(recovered.items["openclaw/gogcli#600"].attempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue retains a synchronize update after an unclassified 422", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchedPayload: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/repos/openclaw/clawsweeper/pulls/842")
      return jsonResponse({
        state: "open",
        head: { sha: "81e4abc894e7d3ec1fddbd856378b6aadb4392f3" },
      });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatchedPayload = JSON.parse(String(init?.body || "{}"));
      return new Response(
        JSON.stringify({
          message: "Validation Failed: must-not-persist",
          errors: [
            {
              resource: "Repository",
              field: "event_type",
              code: "invalid",
              value: "https://private.example/secret?token=must-not-persist",
            },
          ],
        }),
        { status: 422 },
      );
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
      },
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "842-command",
        842,
        "legacy_dispatch",
        "pull_request",
        "openclaw/clawsweeper",
        { commandStatusMarker: "<!-- clawsweeper-command-status:842:re_review:old -->" },
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "842-synchronize",
        842,
        "synchronize",
        "pull_request",
        "openclaw/clawsweeper",
        {
          sourceHeadSha: "81e4abc894e7d3ec1fddbd856378b6aadb4392f3",
          sourceHeadVerified: true,
          sourceAuthoritySeq: 1,
        },
      ),
    );
    await queue.alarm();

    const clientPayload = (dispatchedPayload?.client_payload || {}) as Record<string, unknown>;
    assert.equal(Object.keys(clientPayload).length, 10);
    assert.equal(clientPayload.source_head_sha, undefined);
    assert.equal(
      (clientPayload.queue_claim as Record<string, unknown>).source_head_sha,
      "81e4abc894e7d3ec1fddbd856378b6aadb4392f3",
    );
    assert.ok(clientPayload.review_options);

    const status = await (
      await queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=openclaw%2Fclawsweeper&item_number=842",
        ),
      )
    ).json();
    assert.equal(status.items[0].state, "pending");
    assert.equal(status.items[0].parked_reason, null);
    assert.equal(status.items[0].dispatch_failure_status, 422);
    assert.equal(status.items[0].dispatch_failure_class, "validation_unknown");
    assert.deepEqual(status.items[0].dispatch_failure_detail, {
      validation_fields: ["event_type"],
      validation_codes: ["invalid"],
    });

    const queueStatus = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(queueStatus.dispatcher.state, "blocked");
    assert.equal(queueStatus.dispatcher.reason, "dispatch_validation");
    assert.ok(Date.parse(queueStatus.dispatcher.retry_at) > Date.now());
    assert.deepEqual(queueStatus.dispatcher.dispatch_failure_detail, {
      validation_fields: ["event_type"],
      validation_codes: ["invalid"],
    });
    assert.doesNotMatch(
      JSON.stringify(await storage.get("exact-review-queue")),
      /must-not-persist|private\.example|token=/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue treats a secondary-limit 422 as a global retry", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches")
      return new Response(
        JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
        {
          status: 422,
        },
      );
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("secondary-limit", 843, "synchronize"));
    await queue.alarm();
    const status = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(status.dispatcher.state, "blocked");
    assert.equal(status.dispatcher.reason, "dispatch_rate_limit");
    assert.equal(status.dispatcher.dispatch_failure_status, 422);
    assert.equal(status.dispatcher.dispatch_failure_class, "rate_limit");
    assert.equal(status.pending, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue globally backs off GitHub outages without charging item attempts", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches")
      return new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("github-outage", 602, "opened"));
    await queue.alarm();
    const state = (await storage.get("exact-review-queue")) as {
      dispatcher: {
        state: string;
        reason: string;
        dispatchFailureStatus: number;
        dispatchConsecutiveFailures: number;
      };
      items: Record<string, { state: string; attempts: number; dispatchFailureClass?: string }>;
    };
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "dispatch_github_outage");
    assert.equal(state.dispatcher.dispatchFailureStatus, 503);
    assert.equal(state.dispatcher.dispatchConsecutiveFailures, 1);
    assert.equal(state.items["openclaw/gogcli#602"].state, "pending");
    assert.equal(state.items["openclaw/gogcli#602"].attempts, 0);
    assert.equal(state.items["openclaw/gogcli#602"].dispatchFailureClass, "github_outage");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue preserves a claimed lease after an ambiguous dispatch failure", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let signalDispatchStarted!: () => void;
  let releaseDispatch!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => {
    signalDispatchStarted = resolve;
  });
  const dispatchRelease = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "t" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      signalDispatchStarted();
      await dispatchRelease;
      throw new DOMException("timeout", "AbortError");
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
      },
    );
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("ambiguous-dispatch", 601, "opened"))).status,
      202,
    );

    const alarm = queue.alarm();
    await dispatchStarted;
    const dispatching = (await storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const dispatchingItem = dispatching.items["openclaw/gogcli#601"];
    const leaseId = dispatchingItem.leaseId;
    const claim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: "openclaw/gogcli#601",
          lease_revision: dispatchingItem.leaseRevision,
          run_id: "6010",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(claim.status, 200);
    releaseDispatch();
    await alarm;

    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: stats.pending, dispatching: stats.dispatching, leased: stats.leased },
      { pending: 0, dispatching: 0, leased: 1 },
    );
    assert.equal(stats.dispatcher.reason, "dispatch_timeout");
    const completed = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: "openclaw/gogcli#601",
          lease_revision: dispatchingItem.leaseRevision,
          claim_generation: 1,
          run_id: "6010",
          run_attempt: 1,
        }),
      }),
    );
    assert.deepEqual(await completed.json(), { ok: true, requeued: false });
    const released = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(released.leased, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue requeues a cancelled claimed lease", async () => {
  const storage = new MemoryDurableStorage();
  const completedAfter = Date.now();
  const retryAt = completedAfter + 10_000;
  await storage.put("exact-review-queue", {
    deliveries: {},
    dispatcher: {
      state: "paused",
      reason: "workflow_not_active",
      workflowState: "disabled_manually",
      checkedAt: Date.now(),
      retryAt,
    },
    items: {
      "openclaw/openclaw#710": leasedExactReviewQueueItem(710, "7100"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-710",
        item_key: "openclaw/openclaw#710",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7100",
        run_attempt: 1,
        outcome: "cancelled",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#710"].state, "pending");
  assert.ok(Number(state.items["openclaw/openclaw#710"].nextAttemptAt) >= completedAfter + 30_000);
  assert.ok(Number(state.items["openclaw/openclaw#710"].nextAttemptAt) > retryAt);
  assert.equal(state.items["openclaw/openclaw#710"].attempts, 1);
  assert.equal(state.items["openclaw/openclaw#710"].leaseId, undefined);
  assert.equal(state.items["openclaw/openclaw#710"].claimedRunId, undefined);
  assert.equal(state.items["openclaw/openclaw#710"].claimedRunAttempt, undefined);
  assert.equal(state.items["openclaw/openclaw#710"].claimGeneration, undefined);
});

test("exact-review publication capacity backs off on GitHub pressure and recovers gradually", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-16T08:00:00.000Z");
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const rateLimited = leasedExactReviewPublicationItem(720, "7200");
    await storage.put("exact-review-queue", {
      deliveries: {},
      items: { [rateLimited.key]: rateLimited },
    });
    const queue = new ExactReviewQueue({ storage }, {});
    const complete = (
      item: ReturnType<typeof leasedExactReviewPublicationItem>,
      outcome: "success" | "failure",
      failureKind?: "github_rate_limit" | "github_transient",
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
            ...(failureKind ? { failure_kind: failureKind } : {}),
          }),
        }),
      );

    storage.failNextPut("exact-review-publication-control:v1");
    await assert.rejects(
      complete(rateLimited, "failure", "github_rate_limit"),
      /injected storage put failure/,
    );
    let preserved = (await storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(preserved.items[rateLimited.key]);
    assert.equal((await complete(rateLimited, "failure", "github_rate_limit")).status, 200);
    let stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(stats.lanes.publication.capacity_control, {
      mode: "throttled",
      minimum: 4,
      base: 24,
      maximum: 48,
      ceiling: 12,
      demand_capacity: 24,
      demand_samples: 1,
      demand_tier: 0,
      last_scale_at: null,
      cooldown_until: "2026-07-16T08:15:00.000Z",
      recovery_successes: 0,
      last_failure_at: "2026-07-16T08:00:00.000Z",
      last_failure_kind: "github_rate_limit",
    });

    const state = (await storage.get("exact-review-queue")) as {
      deliveries: Record<string, number>;
      items: Record<string, ReturnType<typeof leasedExactReviewPublicationItem>>;
    };
    // One ceiling step per DEFAULT_EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES
    // (10) consecutive clean publications.
    const recovered = Array.from({ length: 10 }, (_, index) =>
      leasedExactReviewPublicationItem(721 + index, String(7210 + index)),
    );
    for (const item of recovered) state.items[item.key] = item;
    await storage.put("exact-review-queue", state);
    now += 15 * 60_000;
    for (const item of recovered) {
      assert.equal((await complete(item, "success")).status, 200);
    }

    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.capacity_control.ceiling, 20);
    assert.equal(stats.lanes.publication.capacity_control.recovery_successes, 0);

    const transient = leasedExactReviewPublicationItem(780, "7800");
    const latest = (await storage.get("exact-review-queue")) as typeof state;
    latest.items[transient.key] = transient;
    await storage.put("exact-review-queue", latest);
    assert.equal((await complete(transient, "failure", "github_transient")).status, 200);
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.capacity_control.ceiling, 12);
    assert.equal(
      stats.lanes.publication.capacity_control.cooldown_until,
      "2026-07-16T08:20:00.000Z",
    );
    assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, "github_transient");
    preserved = (await storage.get("exact-review-queue")) as typeof preserved;
    assert.ok(preserved.items[rateLimited.key]);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review publication retries a state fetch timeout without throttling capacity", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7801, "78010");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "retryable_failure",
        reason_code: "github_transient",
        error_fingerprint: "sha256:state-fetch-timeout",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; lastFailureReason?: string }>;
  };
  assert.equal(state.items[item.key]?.state, "pending");
  assert.equal(state.items[item.key]?.lastFailureReason, "github_transient");

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.capacity_control.mode, "adaptive");
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 48);
  assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, null);
});

test("exact-review publication gives state contention the transient retry budget", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7803, "78030");
  item.publicationFailureAttempts = 4;
  item.firstFailureAt = Date.now() - 30 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "retryable_failure",
        reason_code: "state_contention",
        error_fingerprint: "sha256:state-publish-contention",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        lastFailureReason?: string;
        publicationFailureAttempts?: number;
        nextAttemptAt?: number;
      }
    >;
  };
  assert.equal(state.items[item.key]?.state, "pending");
  assert.equal(state.items[item.key]?.lastFailureReason, "state_contention");
  assert.equal(state.items[item.key]?.publicationFailureAttempts, 5);
  assert.ok((state.items[item.key]?.nextAttemptAt ?? Infinity) <= Date.now() + 6 * 60_000);

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
  assert.equal(stats.lanes.publication.capacity_control.mode, "adaptive");
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 48);
  assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, null);
});

test("exact-review publication defers an active review lease without throttling capacity", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7802, "78020");
  const retryAt = Date.now() + 12 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
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
        completion_kind: "retryable_failure",
        reason_code: "review_lease_active",
        retry_at: new Date(retryAt).toISOString(),
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; lastFailureReason?: string; nextAttemptAt?: number }>;
  };
  assert.equal(state.items[item.key]?.state, "pending");
  assert.equal(state.items[item.key]?.lastFailureReason, "review_lease_active");
  assert.ok(Number(state.items[item.key]?.nextAttemptAt) >= retryAt);

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.capacity_control.mode, "adaptive");
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 48);
  assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, null);
});

test("exact-review publication supersedes stale tuples without counting a publish", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(781, "7810");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
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
        completion_kind: "superseded",
        reason_code: "remote_newer_tuple",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as { items: Record<string, unknown> };
  assert.equal(state.items[item.key], undefined);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.completed_total, 1);
  assert.equal(stats.lanes.publication.published_total, 0);
  assert.equal(stats.lanes.publication.superseded_total, 1);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.published_rate_per_hour, 0);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.superseded_rate_per_hour, 4);
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
});

test("exact-review publication dead-letters exhausted permanent failures and replays idempotently", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(782, "7820");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.firstFailureAt = Date.now() - 6 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
        error_fingerprint: "sha256:deadbeef",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });

  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(listed.dead_letters.length, 1);
  assert.equal(listed.dead_letters[0].reason_code, "invalid_artifact");
  assert.equal(listed.dead_letters[0].attempts, 3);
  const id = listed.dead_letters[0].dead_letter_id;

  const replay = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/replay", {
        method: "POST",
        body: JSON.stringify({ ids: [id], idempotency_key: "operator:782:v1" }),
      }),
    );
  assert.deepEqual(await (await replay()).json(), {
    ok: true,
    replayed: 1,
    deduped: 0,
    skipped: 0,
  });
  assert.deepEqual(await (await replay()).json(), {
    ok: true,
    replayed: 0,
    deduped: 1,
    skipped: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number }>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].attempts, 0);
});

test("exact-review dead letters expose diagnostics and recover fresh reviews in bounded batches", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(792, "7920");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.firstFailureAt = Date.now() - 6 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
        error_fingerprint: "sha256:fresh-recovery",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });

  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const row = listed.dead_letters[0];
  assert.equal(row.item.key, item.key);
  assert.deepEqual(row.diagnostic.reason_code, "invalid_artifact");
  assert.equal(row.diagnostic.attempts, 3);
  assert.equal(row.diagnostic.error_fingerprint, "sha256:fresh-recovery");
  assert.equal(typeof row.diagnostic.first_failed_at, "string");
  assert.equal(typeof row.diagnostic.last_failed_at, "string");
  assert.deepEqual(row.fresh_recovery, {
    mode: "fresh_review_only",
    eligible: true,
    reason: "eligible",
    item_key: "openclaw/openclaw#792",
  });

  const tooMany = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: Array.from({ length: 11 }, (_, index) => `dead-letter-${index}`),
        idempotency_key: "operator:792:too-many",
      }),
    }),
  );
  assert.equal(tooMany.status, 400);
  assert.deepEqual(await tooMany.json(), { error: "invalid_dead_letter_ids" });

  const recover = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
        method: "POST",
        body: JSON.stringify({ ids: [row.dead_letter_id], idempotency_key: "operator:792:v1" }),
      }),
    );
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unparked: 0,
  });
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 0,
    deduped: 1,
    skipped: 0,
    unparked: 0,
  });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { attempts: number; state: string; decision: { sourceAction: string } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(state.items["openclaw/openclaw#792"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#792"].attempts, 0);
  assert.equal(
    state.items["openclaw/openclaw#792"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  assert.equal(Object.hasOwn(state.items["openclaw/openclaw#792"].decision, "publication"), false);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 1);
  assert.equal(stats.lanes.review.flow.last_15_minutes.arrival, 1);

  const resolved = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10, status: "all" }),
      }),
    )
  ).json();
  assert.equal(resolved.dead_letters[0].status, "resolved");
  assert.equal(resolved.dead_letters[0].resolution_note, "recovered_fresh");
  assert.equal(resolved.dead_letters[0].replay_key, "operator:792:v1");
  assert.equal(resolved.dead_letters[0].fresh_recovery.reason, "fresh_review_already_active");
});

test("a later exact-review cycle still publishes after an earlier cycle raised the publication head", async () => {
  const storage = new MemoryDurableStorage();
  const published = leasedExactReviewPublicationItem(864, "8640");
  published.decision.publication.leaseRevision = 2;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [published.key]: published },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: published.leaseId,
        item_key: published.key,
        lease_revision: published.leaseRevision,
        claim_generation: published.claimGeneration,
        run_id: published.claimedRunId,
        run_attempt: published.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  const drained = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(drained.items), []);

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("cycle-b-review", 864, "opened", "issue", "openclaw/openclaw"),
      )
    ).status,
    202,
  );
  const reopened = (await storage.get("exact-review-queue")) as {
    items: Record<string, { revision: number }>;
  };

  const republished = await (
    await queue.fetch(
      buildExactReviewQueueRequest(
        "cycle-b-publish",
        864,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/openclaw",
        exactReviewPublicationOverrides(
          864,
          "8641",
          "opened",
          reopened.items["openclaw/openclaw#864"].revision,
          "openclaw/openclaw",
        ),
      ),
    )
  ).json();
  assert.equal(republished.queued, true);
  assert.equal(republished.deduped, undefined);
  assert.equal(republished.superseded, undefined);
  assert.equal(republished.item_key, "openclaw/openclaw#864@publish:8641:1");
  assert.equal(reopened.items["openclaw/openclaw#864"].revision, 3);
});

test("an existing exact-review item rebases above the publication head on a newer source event", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const reviewKey = "openclaw/openclaw#865";

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "existing-review",
          865,
          "opened",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );
  const existing = (await storage.get("exact-review-queue")) as {
    items: Record<string, { revision: number }>;
  };
  existing.items[reviewKey].revision = 7;
  await storage.put("exact-review-queue", existing);

  const recorded = await (
    await queue.fetch(
      buildExactReviewQueueRequest(
        "record-publication-head",
        865,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/openclaw",
        exactReviewPublicationOverrides(865, "8650", "opened", 12, "openclaw/openclaw"),
      ),
    )
  ).json();
  assert.equal(recorded.queued, true);

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("newer-source", 865, "edited", "issue", "openclaw/openclaw"),
      )
    ).status,
    202,
  );
  const rebased = (await storage.get("exact-review-queue")) as {
    items: Record<string, { revision: number }>;
  };
  assert.equal(rebased.items[reviewKey].revision, 13);

  const republished = await (
    await queue.fetch(
      buildExactReviewQueueRequest(
        "rebased-publication",
        865,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/openclaw",
        exactReviewPublicationOverrides(
          865,
          "8651",
          "edited",
          rebased.items[reviewKey].revision,
          "openclaw/openclaw",
        ),
      ),
    )
  ).json();
  assert.equal(republished.queued, true);
  assert.equal(republished.superseded, undefined);
});

test("dead-letter fresh recovery seeds a review revision that can still publish", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(866, "8660");
  item.decision.publication.leaseRevision = 2;
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.firstFailureAt = Date.now() - 6 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

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
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
        error_fingerprint: "sha256:recovery-ratchet",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });

  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.deepEqual(
    await (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
          method: "POST",
          body: JSON.stringify({
            ids: [listed.dead_letters[0].dead_letter_id],
            idempotency_key: "operator:866:v1",
          }),
        }),
      )
    ).json(),
    { ok: true, recovered: 1, deduped: 0, skipped: 0, unparked: 0 },
  );

  const recovered = (await storage.get("exact-review-queue")) as {
    items: Record<string, { revision: number }>;
  };
  assert.equal(recovered.items["openclaw/openclaw#866"].revision, 3);

  const republished = await (
    await queue.fetch(
      buildExactReviewQueueRequest(
        "recovery-publish",
        866,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/openclaw",
        exactReviewPublicationOverrides(
          866,
          "8661",
          "artifact_retention_recovery",
          recovered.items["openclaw/openclaw#866"].revision,
          "openclaw/openclaw",
        ),
      ),
    )
  ).json();
  assert.equal(republished.queued, true);
  assert.equal(republished.superseded, undefined);
});

test("exact-review fresh recovery preserves failed-shard review-only behavior", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(794, "7940");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.decision.publication.producerDecision.sourceAction = "failed_review_shard_recovery";
  item.leaseDecision.publication.producerDecision.sourceAction = "failed_review_shard_recovery";
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();

  const recover = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [listed.dead_letters[0].dead_letter_id],
        idempotency_key: "operator:794:v1",
      }),
    }),
  );
  assert.deepEqual(await recover.json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unparked: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string } }>;
  };
  assert.equal(
    state.items["openclaw/openclaw#794"].decision.sourceAction,
    "failed_review_shard_recovery",
  );
});

test("exact-review fresh recovery leaves an active review item untouched", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(793, "7930");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const id = listed.dead_letters[0].dead_letter_id;

  const enqueue = await queue.fetch(
    buildExactReviewQueueRequest(
      "fresh-recovery-guard",
      793,
      "opened",
      "issue",
      "openclaw/openclaw",
    ),
  );
  assert.equal(enqueue.status, 202);
  const before = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; decision: { sourceAction: string } }>;
  };
  const active = before.items["openclaw/openclaw#793"];
  assert.equal(active.state, "pending");
  assert.equal(active.decision.sourceAction, "opened");

  const recover = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({ ids: [id], idempotency_key: "operator:793:v1" }),
    }),
  );
  assert.deepEqual(await recover.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });

  const after = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; decision: { sourceAction: string } }>;
  };
  assert.deepEqual(after.items["openclaw/openclaw#793"], active);
  const guarded = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(guarded.dead_letters[0].fresh_recovery.reason, "fresh_review_already_active");
});

test("guarded dead-letter recovery atomically rejects transferred active aliases", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(1793, "17930");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
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
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const id = listed.dead_letters[0].dead_letter_id;
  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("guarded-alias", 19, "opened", "issue", "openclaw/new"),
      )
    ).status,
    202,
  );
  const guarded = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        idempotency_key: "operator:1793:guarded",
        inventory_fingerprint: deadLetterFingerprint([id]),
        recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1793", "openclaw/new#19"] }],
        recovery_targets: [{ id, target: "openclaw/new#19" }],
      }),
    }),
  );
  assert.deepEqual(await guarded.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string }>;
  };
  assert.equal(state.items["openclaw/openclaw#1793"], undefined);
  assert.equal(state.items["openclaw/new#19"].state, "pending");
});

test("guarded dead-letter recovery rejects inventory changes inside its transaction", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(1794, "17940");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const id = listed.dead_letters[0].dead_letter_id;
  const guarded = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        idempotency_key: "operator:1794:stale",
        inventory_fingerprint: deadLetterFingerprint([]),
        recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1794"] }],
        recovery_targets: [{ id, target: "openclaw/openclaw#1794" }],
      }),
    }),
  );
  assert.deepEqual(await guarded.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
    stale_inventory: true,
  });
});

test("guarded dead-letter resolution preserves a concurrently active transferred alias", async () => {
  const { storage, queue, id } = await guardedDeadLetterFixture(1795);
  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("resolve-guard-alias", 19, "opened", "issue", "openclaw/new"),
      )
    ).status,
    202,
  );
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/resolve", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        note: "automatic duplicate cleanup",
        resolution_aliases: [{ id, aliases: ["openclaw/openclaw#1795", "openclaw/new#19"] }],
      }),
    }),
  );
  assert.deepEqual(await response.json(), { ok: true, resolved: 0, skipped: 1, unparked: 0 });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(listed.dead_letters[0].dead_letter_id, id);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string }>;
  };
  assert.equal(state.items["openclaw/new#19"].state, "pending");
});

test("guarded dead-letter resolution rejects an entire mixed-safe batch atomically", async () => {
  const { storage, queue, id: safeId } = await guardedDeadLetterFixture(17951);
  const unsafe = leasedExactReviewPublicationItem(17952, "179520");
  unsafe.attempts = 2;
  Object.assign(unsafe, { publicationFailureAttempts: 2 });
  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, unknown>;
    items: Record<string, typeof unsafe>;
  };
  state.items[unsafe.key] = unsafe;
  await storage.put("exact-review-queue", state);
  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: unsafe.leaseId,
        item_key: unsafe.key,
        lease_revision: unsafe.leaseRevision,
        claim_generation: unsafe.claimGeneration,
        run_id: unsafe.claimedRunId,
        run_attempt: unsafe.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  const before = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const unsafeId = before.dead_letters.find(
    (entry) => entry.dead_letter_id !== safeId,
  ).dead_letter_id;
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/resolve", {
      method: "POST",
      body: JSON.stringify({
        ids: [safeId, unsafeId],
        note: "automatic duplicate cleanup",
        resolution_aliases: [
          { id: safeId, aliases: ["openclaw/openclaw#17951"] },
          { id: unsafeId, aliases: ["openclaw/incorrect#1"] },
        ],
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, resolved: 0, skipped: 2, unparked: 0 });
  const after = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.deepEqual(
    after.dead_letters.map((entry) => entry.dead_letter_id).sort(),
    [safeId, unsafeId].sort(),
  );
});

test("guarded dead-letter recovery retries remain idempotent after inventory changes", async () => {
  const { queue, id } = await guardedDeadLetterFixture(1796);
  const payload = {
    ids: [id],
    idempotency_key: "operator:1796:idempotent",
    inventory_fingerprint: deadLetterFingerprint([id]),
    recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1796"] }],
    recovery_targets: [{ id, target: "openclaw/openclaw#1796" }],
  };
  const recover = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unparked: 0,
  });
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 0,
    deduped: 1,
    skipped: 0,
    unparked: 0,
  });
});

test("guarded dead-letter recovery enforces live review capacity transactionally", async () => {
  const { storage, queue, id } = await guardedDeadLetterFixture(1797, {
    EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "1",
  });
  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, unknown>;
    items: Record<string, ReturnType<typeof leasedExactReviewQueueItem>>;
  };
  const active = leasedExactReviewQueueItem(9999, "99990");
  state.items[active.key] = active;
  await storage.put("exact-review-queue", state);
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        idempotency_key: "operator:1797:capacity",
        inventory_fingerprint: deadLetterFingerprint([id]),
        recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1797"] }],
        recovery_targets: [{ id, target: "openclaw/openclaw#1797" }],
      }),
    }),
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });
});

test("guarded dead-letter recovery enqueues transferred items at their canonical target", async () => {
  const { storage, queue, id } = await guardedDeadLetterFixture(1798);
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        idempotency_key: "operator:1798:transferred",
        inventory_fingerprint: deadLetterFingerprint([id]),
        recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1798", "openclaw/new#19"] }],
        recovery_targets: [{ id, target: "openclaw/new#19" }],
      }),
    }),
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unparked: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { targetRepo: string; itemNumber: number } }>;
  };
  assert.equal(state.items["openclaw/openclaw#1798"], undefined);
  assert.deepEqual(
    {
      targetRepo: state.items["openclaw/new#19"].decision.targetRepo,
      itemNumber: state.items["openclaw/new#19"].decision.itemNumber,
    },
    { targetRepo: "openclaw/new", itemNumber: 19 },
  );
});

test("guarded dead-letter recovery rejects canonical targets outside the sibling alias fence", async () => {
  const { storage, queue, id } = await guardedDeadLetterFixture(1799);
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        idempotency_key: "operator:1799:untrusted-target",
        inventory_fingerprint: deadLetterFingerprint([id]),
        recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1799"] }],
        recovery_targets: [{ id, target: "openclaw/untrusted#19" }],
      }),
    }),
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(state.items["openclaw/untrusted#19"], undefined);
});

async function guardedDeadLetterFixture(number: number, env: Record<string, string> = {}) {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(number, `${number}0`);
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, env);
  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  return { storage, queue, id: listed.dead_letters[0].dead_letter_id as string };
}

function deadLetterFingerprint(ids: string[]): string {
  let fingerprint = 2_166_136_261;
  for (const id of [...ids].sort()) {
    for (const character of `${id}\n`) {
      fingerprint = Math.imul(fingerprint ^ character.charCodeAt(0), 16_777_619) >>> 0;
    }
  }
  return `${ids.length}:${fingerprint.toString(16).padStart(8, "0")}`;
}

test("exact-review publication refreshes an artifact after its third unavailable attempt", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(783, "7830");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "retryable_failure",
        reason_code: "artifact_unavailable",
      }),
    }),
  );
  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(
    state.items["openclaw/openclaw#783"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.refreshed_total, 1);
});

test("exact-review publication completes a close-coverage deferral without refreshing", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7831, "78310");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const identity = {
    canonicalTargetKey: `${item.decision.targetRepo}#${item.decision.itemNumber}`,
    fenceKey: item.key,
    revision: item.leaseRevision,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "close-coverage-delivery:7831",
    sourceAction: item.decision.sourceAction,
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    observedAt: 1_700_000_000_000,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "close-coverage:7831:accepted",
    observedAt: 1_700_000_000_001,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "router-proof:7831:1",
    observedAt: 1_700_000_000_002,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_003,
  });

  const response = await queue.fetch(
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
        completion_kind: "deferred",
        reason_code: "close_coverage_deferred",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  assert.equal(
    lifecycleState(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!,
    ),
    "completed",
  );
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string; publication?: unknown } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(state.items["openclaw/openclaw#7831"], undefined);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.refreshed_total, 0);
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
});

test("exact-review publication accepts the legacy close-coverage refresh during rollout", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7832, "78320");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });

  const response = await queue.fetch(
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
        completion_kind: "refresh_required",
        reason_code: "close_coverage_retry",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string; publication?: unknown } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(
    state.items["openclaw/openclaw#7832"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  assert.equal(state.items["openclaw/openclaw#7832"].decision.publication, undefined);
});

test("exact-review publication retry budgets ignore earlier dispatch failures", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(785, "7850");
  item.attempts = 2;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { attempts: number; publicationFailureAttempts?: number }>;
  };
  assert.equal(state.items[item.key].attempts, 1);
  assert.equal(state.items[item.key].publicationFailureAttempts, 1);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
});

test("exact-review publication retains one unknown completion for a current-workflow retry", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7851, "78510");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "unknown_failure",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; publicationFailureAttempts?: number }>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].attempts, 1);
  assert.equal(state.items[item.key].publicationFailureAttempts, 1);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
});

test("ordinary exact-review retries do not increment publication retry telemetry", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(786, "7860");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.retried_total, 0);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.retried, 0);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retried, 1);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retried_rate_per_hour, 4);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retry_amplification, null);
});

test("exact-review completion rejects incompatible structured dispositions", async () => {
  const item = leasedExactReviewPublicationItem(784, "7840");
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "superseded",
        reason_code: "remote_closed",
      }),
    }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "completion_outcome_mismatch" });
});

test("exact-review publication recovery ignores successful source-drift requeues", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(790, "7900");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [item.key]: item },
  });
  await storage.put("exact-review-publication-control:v1", {
    capacityCeiling: 12,
    cooldownUntil: Date.now() - 1,
    recoverySuccesses: 49,
    lastFailureAt: Date.now() - 60_000,
    lastFailureKind: "github_rate_limit",
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
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
        requeue_latest: true,
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 12);
  assert.equal(stats.lanes.publication.capacity_control.recovery_successes, 49);
});

test("exact-review queue completes a failed shard recovery without a second retry", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(710, "7101");
  item.decision.sourceAction = "failed_review_shard_recovery";
  item.leaseDecision.sourceAction = "failed_review_shard_recovery";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#710": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-710",
        item_key: "openclaw/openclaw#710",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7101",
        run_attempt: 1,
        outcome: "failure",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(Object.keys(state.items).length, 0);
});

test("failed shard recovery does not replace an already-pending ordinary event", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("ordinary-event", 710, "edited"))).status,
    202,
  );
  const beforeRecovery = (await storage.get("exact-review-queue")) as {
    items: Record<string, { attempts: number; nextAttemptAt: number }>;
  };
  const ordinary = beforeRecovery.items["openclaw/gogcli#710"];
  ordinary.attempts = 1;
  ordinary.nextAttemptAt = Date.now() + 30_000;
  await storage.put("exact-review-queue", beforeRecovery);
  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("failed-shard-recovery", 710, "failed_review_shard_recovery"),
      )
    ).status,
    202,
  );

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        attempts: number;
        nextAttemptAt: number;
        revision: number;
        decision: { sourceAction: string; supersedesInProgress: boolean };
      }
    >;
  };
  assert.equal(state.items["openclaw/gogcli#710"].decision.sourceAction, "edited");
  assert.equal(state.items["openclaw/gogcli#710"].decision.supersedesInProgress, true);
  assert.equal(state.items["openclaw/gogcli#710"].revision, 1);
  assert.equal(state.items["openclaw/gogcli#710"].attempts, 1);
  assert.equal(state.items["openclaw/gogcli#710"].nextAttemptAt, ordinary.nextAttemptAt);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 1);
});

test("failed shard recovery does not replace an ordinary active lease", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#710": leasedExactReviewQueueItem(710, "7102"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "failed-shard-recovery-active-lease",
          710,
          "failed_review_shard_recovery",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const beforeComplete = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        revision: number;
        decision: { sourceAction: string };
        leaseDecision?: { sourceAction: string };
      }
    >;
  };
  const ordinary = beforeComplete.items["openclaw/openclaw#710"];
  assert.equal(ordinary.state, "leased");
  assert.equal(ordinary.revision, 1);
  assert.equal(ordinary.decision.sourceAction, "opened");
  assert.equal(ordinary.leaseDecision?.sourceAction, "opened");

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "7102",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "success",
          },
        ],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reconciled: 1, requeued: 0, completed: 1 });
  const afterComplete = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(afterComplete.items["openclaw/openclaw#710"], undefined);
});

test("failed shard recovery does not replace an active recovery lease", async () => {
  const storage = new MemoryDurableStorage();
  const recovery = leasedExactReviewQueueItem(710, "7103");
  recovery.decision.sourceAction = "failed_review_shard_recovery";
  recovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#710": recovery },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "failed-shard-recovery-active-recovery",
          710,
          "failed_review_shard_recovery",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const beforeComplete = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; revision: number; decision: { sourceAction: string } }>;
  };
  const activeRecovery = beforeComplete.items["openclaw/openclaw#710"];
  assert.equal(activeRecovery.state, "leased");
  assert.equal(activeRecovery.revision, 1);
  assert.equal(activeRecovery.decision.sourceAction, "failed_review_shard_recovery");

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "7103",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "success",
          },
        ],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reconciled: 1, requeued: 0, completed: 1 });
  const afterComplete = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(afterComplete.items["openclaw/openclaw#710"], undefined);
});

test("failed shard recovery replaces an expired recovery lease", async () => {
  const storage = new MemoryDurableStorage();
  const expiredRecovery = leasedExactReviewQueueItem(710, "7104");
  expiredRecovery.decision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseExpiresAt = Date.now() - 1;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#710": expiredRecovery },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "failed-shard-recovery-expired-recovery",
          710,
          "failed_review_shard_recovery",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; revision: number; decision: { sourceAction: string }; leaseId?: string }
    >;
  };
  const replacement = state.items["openclaw/openclaw#710"];
  assert.equal(replacement.state, "pending");
  assert.equal(replacement.revision, 1);
  assert.equal(replacement.decision.sourceAction, "failed_review_shard_recovery");
  assert.equal(replacement.leaseId, undefined);
});

for (const retryKind of ["coordination", "throttle"] as const) {
  test(`exact-review queue defers ${retryKind} without spending review attempts`, async () => {
    const originalNow = Date.now;
    const now = Date.parse("2026-08-08T13:00:00.000Z");
    Date.now = () => now;
    try {
      const storage = new MemoryDurableStorage();
      const retryAt = now + 45 * 60_000;
      const item = leasedExactReviewQueueItem(711, "7110");
      item.attempts = 3;
      item.reviewFailureAttempts = 2;
      await storage.put("exact-review-queue", {
        deliveries: {},
        items: {
          "openclaw/openclaw#711": item,
        },
      });
      const queue = new ExactReviewQueue({ storage }, {}, () => 0);

      const response = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/complete", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-711",
            item_key: "openclaw/openclaw#711",
            lease_revision: 1,
            claim_generation: 1,
            run_id: "7110",
            run_attempt: 1,
            outcome: "failure",
            retry_kind: retryKind,
            retry_at: new Date(retryAt).toISOString(),
          }),
        }),
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, requeued: true });
      const state = (await storage.get("exact-review-queue")) as {
        items: Record<string, Record<string, unknown>>;
      };
      const deferred = state.items["openclaw/openclaw#711"];
      assert.equal(
        deferred.nextAttemptAt,
        retryKind === "throttle" ? now + 33.75 * 60_000 : retryAt,
      );
      assert.equal(deferred.attempts, 3);
      assert.equal(deferred.reviewFailureAttempts, 2);
      assert.equal(deferred.backoffReason, `${retryKind}_retry`);
    } finally {
      Date.now = originalNow;
    }
  });
}

test("exact-review queue spends review attempts for an untyped retry deadline", async () => {
  const storage = new MemoryDurableStorage();
  const retryAt = Date.now() + 45 * 60_000;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#711": leasedExactReviewQueueItem(711, "7110"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-711",
        item_key: "openclaw/openclaw#711",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7110",
        run_attempt: 1,
        outcome: "failure",
        retry_at: new Date(retryAt).toISOString(),
      }),
    }),
  );

  assert.equal(response.status, 200);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#711"].attempts, 1);
  assert.equal(state.items["openclaw/openclaw#711"].reviewFailureAttempts, 1);
  assert.equal(state.items["openclaw/openclaw#711"].nextAttemptAt, retryAt);
});

test("exact-review queue does not carry an old coordination deadline to a newer revision", async () => {
  const storage = new MemoryDurableStorage();
  const retryAt = Date.now() + 45 * 60_000;
  const item = leasedExactReviewQueueItem(712, "7120");
  item.attempts = 3;
  item.reviewFailureAttempts = 2;
  item.revision = Number(item.leaseRevision) + 1;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#712": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-712",
        item_key: "openclaw/openclaw#712",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7120",
        run_attempt: 1,
        outcome: "failure",
        retry_kind: "coordination",
        retry_at: new Date(retryAt).toISOString(),
      }),
    }),
  );

  assert.equal(response.status, 200);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.ok(Number(state.items["openclaw/openclaw#712"].nextAttemptAt) < retryAt);
  assert.equal(state.items["openclaw/openclaw#712"].attempts, 0);
  assert.equal(state.items["openclaw/openclaw#712"].reviewFailureAttempts, 0);
});

test("exact-review queue rejects invalid retry deferral contracts", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  for (const [payload, error] of [
    [
      { retry_kind: "capacity", retry_at: new Date(Date.now() + 60_000).toISOString() },
      "invalid_retry_kind",
    ],
    [{ retry_kind: "coordination" }, "retry_kind_without_retry_at"],
    [
      {
        outcome: "success",
        retry_kind: "coordination",
        retry_at: new Date(Date.now() + 60_000).toISOString(),
      },
      "retry_kind_without_failure",
    ],
    [{ retry_kind: "coordination", retry_at: "not-a-timestamp" }, "invalid_retry_at"],
    [
      {
        retry_kind: "throttle",
        retry_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      },
      "invalid_retry_at",
    ],
  ] as const) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-712",
          item_key: "openclaw/openclaw#712",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7120",
          run_attempt: 1,
          outcome: "failure",
          ...payload,
        }),
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
  }
});

test("exact-review queue rejects regular-review retry kinds for publication work", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(712, "7120");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [item.key]: item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        retry_kind: "throttle",
        retry_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "retry_kind_outside_regular_review" });
});

test("exact-review queue requeues a verified source drift exactly once without failure backoff", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#713": leasedExactReviewQueueItem(713, "9113"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-713",
          item_key: "openclaw/openclaw#713",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "9113",
          run_attempt: 1,
          outcome: "success",
          requeue_latest: true,
        }),
      }),
    );

  const response = await complete();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#713"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#713"].attempts, 0);
  assert.equal(state.items["openclaw/openclaw#713"].revision, 1);
  assert.equal(state.items["openclaw/openclaw#713"].leaseId, undefined);
  assert.equal((await complete()).status, 409);
  const replayedState = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(Object.keys(replayedState.items).length, 1);
  assert.equal(replayedState.items["openclaw/openclaw#713"].state, "pending");
  const reconciled = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "9113",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "success",
          },
        ],
      }),
    }),
  );
  assert.deepEqual(await reconciled.json(), {
    ok: true,
    reconciled: 0,
    requeued: 0,
    completed: 0,
  });
  const reconciledState = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(reconciledState.items["openclaw/openclaw#713"].state, "pending");
});

test("exact-review success preserves an already-enqueued newer decision", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(714, "7140");
  item.revision = 2;
  item.decision.sourceAction = "edited";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#714": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-714",
        item_key: "openclaw/openclaw#714",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7140",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );

  assert.equal(response.status, 200);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; revision: number; decision: { sourceAction: string } }>;
  };
  assert.equal(Object.keys(state.items).length, 1);
  assert.equal(state.items["openclaw/openclaw#714"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#714"].revision, 2);
  assert.equal(state.items["openclaw/openclaw#714"].decision.sourceAction, "edited");
});

test("exact-review queue rejects invalid source-drift requeue requests", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  for (const body of [
    { outcome: "success", requeue_latest: "true" },
    { outcome: "failure", requeue_latest: true },
  ]) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-715",
          item_key: "openclaw/openclaw#715",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7150",
          run_attempt: 1,
          ...body,
        }),
      }),
    );
    assert.equal(response.status, 400);
  }
});

test("exact-review completion rejects stale owners and is race-idempotent", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#716": leasedExactReviewQueueItem(716, "9100", 2),
      "openclaw/openclaw#717": leasedExactReviewQueueItem(717, "9101", 1),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = (
    itemNumber: number,
    leaseId: string,
    runId: string,
    runAttempt: number,
    outcome: string,
  ) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: `openclaw/openclaw#${itemNumber}`,
          lease_revision: 1,
          claim_generation: 1,
          run_id: runId,
          run_attempt: runAttempt,
          outcome,
        }),
      }),
    );

  assert.equal((await complete(716, "lease-716", "9100", 1, "failure")).status, 409);
  assert.equal((await complete(716, "lease-716", "9999", 2, "failure")).status, 409);
  const failed = await complete(716, "lease-716", "9100", 2, "failure");
  assert.equal(failed.status, 200);
  assert.deepEqual(await failed.json(), { ok: true, requeued: true });
  assert.equal((await complete(716, "lease-716", "9100", 2, "success")).status, 409);

  const completed = await complete(717, "lease-717", "9101", 1, "success");
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  assert.equal((await complete(717, "lease-717", "9101", 1, "failure")).status, 409);
  const reconciledAfterSuccess = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "9101",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "failure",
          },
        ],
      }),
    }),
  );
  assert.deepEqual(await reconciledAfterSuccess.json(), {
    ok: true,
    reconciled: 0,
    requeued: 0,
    completed: 0,
  });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#716"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#716"].attempts, 1);
  assert.equal(state.items["openclaw/openclaw#716"].leaseId, undefined);
  assert.equal(state.items["openclaw/openclaw#717"], undefined);
});

test("signed exact-review reconciliation releases only immutable terminal runs", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#711": leasedExactReviewQueueItem(711, "9001"),
      "openclaw/openclaw#712": leasedExactReviewQueueItem(712, "9002"),
      "openclaw/openclaw#720": leasedExactReviewQueueItem(720, "9004"),
      "openclaw/openclaw#719": leasedExactReviewQueueItem(719, "9003"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      assert.deepEqual(JSON.parse(String(init?.body)).permissions, { actions: "read" });
      return jsonResponse({ token: "t" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml/runs") {
      assert.equal(url.searchParams.get("event"), "repository_dispatch");
      assert.equal(url.searchParams.get("status"), null);
      assert.equal(url.searchParams.get("per_page"), "100");
      const page = url.searchParams.get("page");
      if (page === "1") {
        return jsonResponse({
          workflow_runs: Array.from({ length: 100 }, (_, index) => ({
            id: 10_000 + index,
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
          })),
        });
      }
      assert.equal(page, "2");
      return jsonResponse({
        workflow_runs: [
          { id: 9001, run_attempt: 1, status: "completed", conclusion: "cancelled" },
          { id: 9002, run_attempt: 1, status: "in_progress", conclusion: null },
          { id: 9003, run_attempt: 1, status: "completed", conclusion: "success" },
        ],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9001/attempts/1") {
      return jsonResponse({
        id: 9001,
        run_attempt: 1,
        status: "completed",
        conclusion: "cancelled",
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9003/attempts/1") {
      return jsonResponse({
        id: 9003,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const body = JSON.stringify({
      runs: [{ run_id: "9001", run_attempt: 1 }],
      include_all_claimed: true,
    });
    const unsigned = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        body,
      }),
      env,
    );
    assert.equal(unsigned.status, 401);

    const oversizedBody = JSON.stringify({
      run_ids: Array.from({ length: 129 }, (_, index) => String(index + 1)),
    });
    const oversizedSignature = `sha256=${createHmac("sha256", "test-secret").update(oversizedBody).digest("hex")}`;
    const oversized = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": oversizedSignature },
        body: oversizedBody,
      }),
      env,
    );
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), { error: "invalid_runs" });

    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      ok: false,
      requested: 1,
      claimed: 4,
      terminal: 2,
      unavailable: 1,
      reconciled: 2,
      requeued: 1,
      completed: 1,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    assert.equal(state.items["openclaw/openclaw#711"].state, "pending");
    assert.equal(state.items["openclaw/openclaw#711"].claimedRunId, undefined);
    assert.equal(state.items["openclaw/openclaw#712"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#712"].claimedRunId, "9002");
    assert.equal(state.items["openclaw/openclaw#720"].claimedRunId, "9004");
    assert.equal(state.items["openclaw/openclaw#719"], undefined);
    const staleAttemptBody = JSON.stringify({
      runs: [{ run_id: "9004", run_attempt: 2 }],
      include_all_claimed: true,
    });
    const staleAttemptSignature = `sha256=${createHmac("sha256", "test-secret").update(staleAttemptBody).digest("hex")}`;
    const staleAttempt = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": staleAttemptSignature },
        body: staleAttemptBody,
      }),
      env,
    );
    assert.equal(staleAttempt.status, 502);
    const staleAttemptResult = (await staleAttempt.json()) as { unavailable: number };
    assert.equal(staleAttemptResult.unavailable, 1);
    const unavailableBody = JSON.stringify({
      runs: [{ run_id: "9004", run_attempt: 1 }],
      include_all_claimed: true,
    });
    const unavailableSignature = `sha256=${createHmac("sha256", "test-secret").update(unavailableBody).digest("hex")}`;
    const unavailable = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": unavailableSignature },
        body: unavailableBody,
      }),
      env,
    );
    assert.equal(unavailable.status, 502);
    assert.deepEqual(await unavailable.json(), {
      ok: false,
      requested: 1,
      claimed: 2,
      terminal: 0,
      unavailable: 1,
      reconciled: 0,
      requeued: 0,
      completed: 0,
    });
    const staleFailure = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-719",
          item_key: "openclaw/openclaw#719",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "9003",
          run_attempt: 1,
          outcome: "failure",
        }),
      }),
    );
    assert.equal(staleFailure.status, 409);

    const replayBody = JSON.stringify({ runs: [{ run_id: "9001", run_attempt: 1 }] });
    const replaySignature = `sha256=${createHmac("sha256", "test-secret").update(replayBody).digest("hex")}`;
    const replay = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": replaySignature },
        body: replayBody,
      }),
      env,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      ok: true,
      requested: 1,
      claimed: 0,
      terminal: 0,
      unavailable: 0,
      reconciled: 0,
      requeued: 0,
      completed: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review reconciliation targets leases beyond 64 entries without accepting stale claims", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const fillerItems = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => {
      const itemNumber = 8000 + index;
      return [
        `openclaw/openclaw#${itemNumber}`,
        leasedExactReviewQueueItem(itemNumber, String(10_000 + index)),
      ];
    }),
  );
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      ...fillerItems,
      "openclaw/openclaw#8065": leasedExactReviewQueueItem(8065, "9901", 2),
      "openclaw/openclaw#8066": leasedExactReviewQueueItem(8066, "9902"),
      "openclaw/openclaw#8067": leasedExactReviewQueueItem(8067, "9903"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "t" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9901") {
      return jsonResponse({ id: 9901, run_attempt: 2, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9902") {
      return jsonResponse({ id: 9902, run_attempt: 1, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9902/attempts/1") {
      const claim = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-8066",
            item_key: "openclaw/openclaw#8066",
            lease_revision: 1,
            run_id: "9902",
            run_attempt: 2,
          }),
        }),
      );
      assert.equal(claim.status, 200);
      return jsonResponse({
        id: 9902,
        run_attempt: 1,
        status: "completed",
        conclusion: "cancelled",
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9903") {
      return jsonResponse({ id: 9903, run_attempt: 1, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9903/attempts/1") {
      return jsonResponse({
        id: 9903,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const body = JSON.stringify({
      runs: [
        { run_id: "9901", run_attempt: 1 },
        { run_id: "9902", run_attempt: 1 },
        { run_id: "9903", run_attempt: 1 },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      requested: 3,
      claimed: 3,
      terminal: 2,
      unavailable: 0,
      reconciled: 1,
      requeued: 1,
      completed: 0,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    assert.equal(state.items["openclaw/openclaw#8000"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#8065"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#8065"].claimedRunAttempt, 2);
    assert.equal(state.items["openclaw/openclaw#8065"].claimGeneration, 1);
    assert.equal(state.items["openclaw/openclaw#8066"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#8066"].claimedRunAttempt, 2);
    assert.equal(state.items["openclaw/openclaw#8066"].claimGeneration, 2);
    assert.equal(state.items["openclaw/openclaw#8067"].state, "pending");
    assert.equal(state.items["openclaw/openclaw#8067"].attempts, 1);
    assert.equal(state.items["openclaw/openclaw#8067"].claimedRunId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review reconciliation cannot release a later attempt with the same run id", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#713": leasedExactReviewQueueItem(713, "9010"),
      "openclaw/openclaw#714": {
        ...leasedExactReviewQueueItem(714, "9011"),
        claimedRunAttempt: undefined,
        claimGeneration: 2,
      },
      "openclaw/openclaw#715": leasedExactReviewQueueItem(715, "9012"),
      "openclaw/openclaw#718": leasedExactReviewQueueItem(718, "9013"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "t" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9010") {
      return jsonResponse({ id: 9010, run_attempt: 1, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9010/attempts/1") {
      const claim = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-713",
            item_key: "openclaw/openclaw#713",
            lease_revision: 1,
            run_id: "9010",
            run_attempt: 2,
          }),
        }),
      );
      assert.equal(claim.status, 200);
      return jsonResponse({
        id: 9010,
        run_attempt: 1,
        status: "completed",
        conclusion: "cancelled",
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9011") {
      return jsonResponse({ id: 9011, run_attempt: 2, status: "in_progress", conclusion: null });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9012") {
      return jsonResponse({ id: 9012, run_attempt: 2, status: "queued", conclusion: null });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9013") {
      return jsonResponse({ id: 9013, run_attempt: 2, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9013/attempts/2") {
      return jsonResponse({ id: 9013, run_attempt: 2, status: "completed", conclusion: "failure" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const body = JSON.stringify({
      runs: [
        { run_id: "9010", run_attempt: 1 },
        { run_id: "9011", run_attempt: 1 },
        { run_id: "9012", run_attempt: 1 },
        { run_id: "9013", run_attempt: 2 },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      requested: 4,
      claimed: 4,
      terminal: 2,
      unavailable: 0,
      reconciled: 1,
      requeued: 1,
      completed: 0,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    assert.equal(state.items["openclaw/openclaw#713"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#713"].claimedRunId, "9010");
    assert.equal(state.items["openclaw/openclaw#713"].claimedRunAttempt, 2);
    assert.equal(state.items["openclaw/openclaw#713"].claimGeneration, 2);
    assert.equal(state.items["openclaw/openclaw#714"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#714"].claimedRunId, "9011");
    assert.equal(state.items["openclaw/openclaw#714"].claimedRunAttempt, undefined);
    assert.equal(state.items["openclaw/openclaw#714"].claimGeneration, 2);
    assert.equal(state.items["openclaw/openclaw#715"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#715"].claimedRunId, "9012");
    assert.equal(state.items["openclaw/openclaw#715"].claimedRunAttempt, 1);
    assert.equal(state.items["openclaw/openclaw#715"].claimGeneration, 1);
    assert.equal(state.items["openclaw/openclaw#718"].state, "pending");
    assert.equal(state.items["openclaw/openclaw#718"].attempts, 1);
    assert.equal(state.items["openclaw/openclaw#718"].claimedRunId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review stats heals a missing or stale alarm and expired lease", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#700": {
        key: "openclaw/openclaw#700",
        decision: {
          targetRepo: "openclaw/openclaw",
          targetBranch: "main",
          itemNumber: 700,
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceAction: "synchronize",
          supersedesInProgress: true,
        },
        state: "leased",
        revision: 1,
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now() - 120_000,
        nextAttemptAt: Date.now() - 120_000,
        attempts: 0,
        leaseId: "expired-lease",
        leaseRevision: 1,
        leaseExpiresAt: Date.now() - 1,
        claimedRunId: "run-700",
      },
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.dispatching, 0);
  assert.equal(stats.leased, 0);
  assert.equal(stats.target_stats[0].target_repo, "openclaw/openclaw");
  assert.equal(stats.target_stats[0].pending, 1);
  assert.ok(stats.oldest_pending_age_seconds >= 120);
  assert.equal(stats.oldest_pending_key, "openclaw/openclaw#700");
  assert.equal(stats.lanes.review.oldest_pending_key, "openclaw/openclaw#700");
  assert.ok(stats.next_wake_at);
  assert.ok((await storage.getAlarm()) !== null);

  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, Record<string, unknown>>;
  };
  const activeLeaseExpiry = Date.now() + 60_000;
  state.items["openclaw/openclaw#701"] = {
    key: "openclaw/openclaw#701",
    decision: state.items["openclaw/openclaw#700"].decision,
    state: "leased",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: Date.now(),
    attempts: 0,
    leaseId: "active-lease",
    leaseRevision: 1,
    leaseExpiresAt: activeLeaseExpiry,
    claimedRunId: "run-701",
  };
  state.items["openclaw/openclaw#702"] = {
    key: "openclaw/openclaw#702",
    decision: {
      ...state.items["openclaw/openclaw#700"].decision,
      itemNumber: 702,
    },
    state: "pending",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: Date.now(),
    attempts: 0,
  };
  await storage.put("exact-review-queue", state);
  await storage.setAlarm(Date.now() + 1_000);
  const scheduledBeforePoll = await storage.getAlarm();
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const scheduledAfterPoll = await storage.getAlarm();
  assert.ok(scheduledBeforePoll !== null && scheduledAfterPoll !== null);
  assert.ok(scheduledAfterPoll <= scheduledBeforePoll);

  await storage.setAlarm(Date.now() - 1_000);
  const staleAlarmPollStartedAt = Date.now();
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const rescheduledAlarm = await storage.getAlarm();
  assert.ok(rescheduledAlarm !== null && rescheduledAlarm > staleAlarmPollStartedAt);
});

test("exact-review queue drops an expired failed-shard recovery unless a newer revision superseded it", async () => {
  const storage = new MemoryDurableStorage();
  const expiredRecovery = leasedExactReviewQueueItem(702, "7020");
  expiredRecovery.decision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseExpiresAt = Date.now() - 1;

  const supersededRecovery = leasedExactReviewQueueItem(703, "7030");
  supersededRecovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  supersededRecovery.decision.sourceAction = "edited";
  supersededRecovery.decision.supersedesInProgress = true;
  supersededRecovery.revision = 2;
  supersededRecovery.leaseExpiresAt = Date.now() - 1;

  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#702": expiredRecovery,
      "openclaw/openclaw#703": supersededRecovery,
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; decision: { sourceAction: string } }>;
  };
  assert.equal(state.items["openclaw/openclaw#702"], undefined);
  assert.equal(state.items["openclaw/openclaw#703"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#703"].attempts, 0);
  assert.equal(state.items["openclaw/openclaw#703"].decision.sourceAction, "edited");
});

function isoAgo(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

function completedReviewRun(id: number, itemNumber: number, conclusion: string, ageMs: number) {
  const now = Date.now();
  return {
    id,
    name: "Review ClawSweeper items",
    display_title: `Review event item openclaw/openclaw#${itemNumber}`,
    status: "completed",
    conclusion,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: new Date(now - ageMs).toISOString(),
    updated_at: new Date(now - Math.max(0, ageMs - 10_000)).toISOString(),
  };
}

test("dashboard classifies issue conversion and PR repair workers", () => {
  assert.equal(
    workerWorkKind(
      { title: "repair cluster jobs/openclaw/inbox/issue-openclaw-openclaw-123.md" },
      "Execute and apply cluster actions",
    ),
    "issue_to_pr",
  );
  assert.equal(
    workerWorkKind({ title: "automerge repair jobs/openclaw/inbox/automerge-456.md" }, ""),
    "pr_repair",
  );
  assert.equal(
    workerWorkKind({ title: "repair cluster jobs/openclaw/inbox/cluster-1.md" }, ""),
    "repair_cluster",
  );
});

test("dashboard HTML preserves UTF-8 emoji labels", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/"), {
    CLAWSWEEPER_CRABFLEET_URL: "https://fleet.example.test/terminal?view=live&mode=all",
  });
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.match(html, /<title>🦞 ClawSweeper Live<\/title>/);
  assert.match(html, /content: "🦞"/);
  assert.match(html, /Codex Workers/);
  assert.doesNotMatch(html, /Active Sweeps/);
  assert.doesNotMatch(html, /Queue Depth/);
  assert.doesNotMatch(html, /Health Trends/);
  assert.doesNotMatch(html, /id="health-trend-grid"/);
  assert.match(html, /\/api\/health-history\?range=/);
  assert.match(html, /Work execution needs attention/);
  assert.doesNotMatch(html, /Review reliability/);
  assert.doesNotMatch(html, /\/api\/review-observability\?range=/);
  assert.match(html, /Apply \/ close health/);
  assert.match(html, /id="apply-observability-body"/);
  assert.match(html, /id="health-strip"/);
  assert.match(html, /Fleet Review Coverage/);
  assert.match(html, /id="review-coverage-body"/);
  assert.match(html, /\/api\/review-coverage/);
  assert.ok(html.indexOf('id="review-coverage-body"') < html.indexOf("System Overview"));
  assert.match(html, /\/api\/apply-observability\?range=/);
  assert.match(html, /data-trend-range="6h"/);
  assert.match(html, /<details class="execution-alert">/);
  assert.match(html, /Error Rate/);
  assert.match(html, /Recovery Rate/);
  assert.match(html, /Capacity/);
  assert.match(html, /Only jobs that execute Codex count against this budget/);
  assert.match(html, /id="exact-review-lanes"/);
  assert.match(html, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.exact-review-lanes \{ display: contents; \}/);
  assert.match(html, /Review admission/);
  assert.match(html, /Result publication/);
  assert.match(html, /Net publication rate/);
  assert.match(html, /Review throughput/);
  assert.doesNotMatch(html, /Control Plane · GitHub Actions, not Codex/);
  assert.doesNotMatch(html, /id="control-plane"/);
  assert.match(html, /\.exact-lanes \{ grid-template-columns: 1fr; \}/);
  assert.match(
    html,
    /<div class="exact-lanes">\s*<div class="exact-review-lanes" id="exact-review-lanes"[\s\S]*?<section class="exact-lane" id="state-writer-health"/,
  );
  assert.ok(html.indexOf("Codex Capacity") < html.indexOf('id="exact-review-lanes"'));
  assert.ok(html.indexOf('id="exact-review-lanes"') < html.indexOf("Apply / close health"));
  assert.ok(html.indexOf('id="exact-review-lanes"') < html.indexOf("Handoff Health"));
  assert.match(html, /Live terminals/);
  assert.match(html, /href="https:\/\/fleet\.example\.test\/terminal\?view=live&amp;mode=all"/);
  assert.match(html, /Loading pipeline state/);
  assert.match(html, /System Overview/);
  assert.match(html, /id="exact-review-handoff"/);
  assert.match(html, /function renderExactReviewHandoff/);
  assert.match(html, /id="recent-durable-publication-events"/);
  assert.match(html, /function renderRecentDurablePublicationEvents/);
  assert.match(html, /Workflow activity is not lifecycle completion/);
  assert.match(html, /waiting for run claim/);
  assert.match(html, /id="apply-health"/);
  assert.match(html, /function renderApplyHealth/);
  assert.match(html, /candidate examined count unavailable for this lane/);
  assert.match(html, /Pruning sweep/);
  assert.match(html, /Copy command/);
  assert.match(html, /applyHealthRecommendedAction/);
  assert.match(html, /Rotation cursor missing/);
  assert.match(html, /Inspect the cursor-write and state-publish steps/);
  assert.match(html, /const skipCount = skipReasons\[reason\]/);
  assert.doesNotMatch(html, /Apply needs attention/);
  assert.match(html, /Automatic Builds/);
  assert.match(html, /id="automatic-work"/);
  assert.match(html, /Lifecycle Timeline/);
  assert.match(html, /Active Workers/);
  assert.match(html, /id="worker-dialog"/);
  assert.match(html, /Step Timeline/);
  assert.match(html, /worker-target-title/);
  assert.match(html, /Refreshing live status in the background/);
  assert.match(html, /Cluster Intake/);
  assert.match(html, /Active Pipeline/);
  assert.doesNotMatch(html, /Automerge Reliability/);
  assert.doesNotMatch(html, /id="automerge-reliability"/);
  assert.match(html, /Automerge worker operations/);
  assert.match(html, /separate from Automerge Product Health success rate/);
  assert.match(html, /Time-window coverage/);
  assert.match(html, /Active sessions/);
  assert.match(html, /No terminal samples yet/);
  assert.match(html, /Repair workflow failed/);
  assert.match(html, /outcomeLabels\[session\.state\]/);
  assert.match(html, /Showing up to 30 latest sessions in the selected window/);
  assert.match(html, /Closed by ClawSweeper/);
  assert.match(html, /Worker Health/);
  assert.match(html, /Recent Activity/);
  assert.doesNotMatch(html, /ðŸ|â|âš|âœ/);
});

test("dashboard hero treats apply and exact-review handoff health as attention", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/"));
  const html = await response.text();
  const script = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].at(-1)?.[1];
  assert.ok(script);

  const elements = new Map();
  const elementFor = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        addEventListener: () => undefined,
        className: "",
        close() {
          this.open = false;
        },
        dataset: {},
        id,
        innerHTML: "",
        open: false,
        showModal() {
          this.open = true;
        },
        style: {},
        textContent: "",
      });
    }
    return elements.get(id);
  };
  const status = {
    generated_at: "2026-07-05T11:22:43.934Z",
    source: { target_repositories: ["openclaw/openclaw"] },
    health: {
      attempts: 0,
      error_rate_percent: 0,
      failed_attempts: 0,
      failures: [],
      recovered_failures: 0,
      recovery_rate_percent: 100,
      unresolved_failures: 0,
    },
    fleet: {
      active_codex_jobs: 0,
      active_workflow_runs: 0,
      budget_used_percent: 0,
      queued_workflow_runs: 0,
      support_queued_workflow_runs: 0,
      support_workflow_runs: 0,
      worker_budget: 128,
      worker_detail_fallbacks: 0,
    },
    workers: [],
    automatic_work: [],
    pipeline: [],
    control_plane: {
      publishers: { running: 2, waiting: 1 },
      comment_routers: { running: 3, waiting: 4 },
      reconcilers: { running: 1, waiting: 0 },
    },
    exact_review_queue: {
      pending: 4,
      ready_pending: 3,
      admissible_pending: 2,
      lanes: {
        review: {
          pending: 4,
          ready: 3,
          backoff: 1,
          dispatching: 2,
          leased: 10,
          active: 12,
          capacity: 64,
          available_slots: 52,
          oldest_pending_age_seconds: 60,
          flow: {
            last_15_minutes: {
              arrival_rate_per_hour: 24,
              successful_rate_per_hour: 20,
              retried_rate_per_hour: 4,
              shed_rate_per_hour: 0,
              retry_amplification: 0.2,
            },
          },
        },
        publication: {
          pending: 2,
          ready: 1,
          backoff: 1,
          dispatching: 1,
          leased: 20,
          active: 21,
          capacity: 24,
          available_slots: 3,
          oldest_pending_age_seconds: 30,
          oldest_ready_age_seconds: 30,
          oldest_backoff_age_seconds: 20,
          flow: {
            last_15_minutes: {
              arrival_rate_per_hour: 12,
              resolved_rate_per_hour: 20,
              published_rate_per_hour: 4,
              superseded_rate_per_hour: 16,
              retried_rate_per_hour: 8,
              dead_lettered_rate_per_hour: 0,
              retry_amplification: 0.4,
            },
          },
          dead_letters: {
            open: 2,
            oldest_failed_at: "2026-07-05T10:22:43.934Z",
          },
          capacity_control: {
            mode: "throttled",
            base: 24,
            maximum: 48,
            ceiling: 24,
            demand_capacity: 32,
            cooldown_until: "2026-07-05T12:00:00.000Z",
            last_failure_kind: "github_rate_limit",
          },
        },
      },
      pressure: {
        status: "congested",
        reason: "capacity_full_with_backlog",
        capacity: 28,
        active: 28,
        pending: 4,
        ready_pending: 3,
        admissible_pending: 2,
      },
      handoff_health: {
        status: "healthy",
        message: "Dispatch-to-claim handoffs are within the expected window.",
        available_slots: 2,
        capacity: 28,
        stalled_after_seconds: 300,
        phases: {
          pending: { count: 4, oldest_age_seconds: 60 },
          dispatching: { count: 2, oldest_age_seconds: 10 },
          leased: { count: 24, oldest_age_seconds: 240 },
        },
      },
    },
    diagnostics: { errors: [], exact_review_queue_error: null as string | null },
    recent: {
      apply_health: {
        attention_count: 1,
        items: [
          {
            attention_reasons: ["cursor_required_but_missing_after_full_window"],
            closed: 0,
            comment_synced: 0,
            cursor: null,
            cursor_required: true,
            cycle: null,
            lanes: {
              closure: {
                closed: 0,
                comment_synced: 0,
                processed: 2,
                skip_reasons: { skipped_changed_since_review: 2 },
                skipped: 2,
              },
              comment_sync: {
                closed: 0,
                comment_synced: 0,
                processed: 0,
                skip_reasons: {},
                skipped: 0,
              },
            },
            mode: "close",
            next_action_buckets: { review_refresh: 2 },
            next_actions: [
              {
                bucket: "review_refresh",
                count: 2,
                label: "Refresh review",
                next_step: "Queue a fresh ClawSweeper review before any close retry.",
                owner: "clawsweeper",
                reason: "skipped_changed_since_review",
                retryable: true,
                summary: "The item changed after review.",
              },
            ],
            processed: 2,
            run_url: "https://github.com/openclaw/clawsweeper/actions/runs/99",
            skip_reasons: { skipped_changed_since_review: 2 },
            skipped: 2,
            status: "needs_attention",
            target_repo: "openclaw/openclaw",
            updated_at: "2026-07-05T11:22:03.748Z",
          },
        ],
      },
      automerge: [],
      automerge_reliability: {
        sampled_runs: 3,
        completed_attempts: 3,
        failed_attempts: 2,
        failure_rate_percent: 66.7,
        active_attempts: 0,
        stalled_attempts: 0,
        average_duration_ms: 600_000,
        longest_duration_ms: 1_200_000,
        unresolved_failures: 1,
        recovered_failures: 1,
        failures: [
          {
            repository: "openclaw/openclaw",
            number: 107691,
            item_url: "https://github.com/openclaw/openclaw/pull/107691",
            run_url: "https://github.com/openclaw/clawsweeper/actions/runs/29431617465",
            status: "unresolved",
            conclusion: "failure",
            started_at: "2026-07-05T10:50:00Z",
            completed_at: "2026-07-05T11:10:00Z",
            duration_ms: 1_200_000,
            recovered: false,
          },
        ],
      },
      closed_items: [],
      closed_stats: { issues: 0, prs: 0, total: 0, window_hours: 24 },
      cluster_repair: null,
      events: [],
      operation_counts: {},
    },
  };

  const context = createContext({
    console,
    document: {
      addEventListener: () => undefined,
      body: { classList: { add: () => undefined, remove: () => undefined } },
      documentElement: { dataset: {} },
      getElementById: elementFor,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    fetch: async () => ({
      headers: { get: () => "fresh" },
      json: async () => status,
      ok: true,
      status: 200,
    }),
    history: { replaceState: () => undefined },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    location: { hash: "", pathname: "/", search: "" },
    navigator: { clipboard: { writeText: async () => undefined } },
    setInterval: () => 1,
    setTimeout: () => 1,
    window: { addEventListener: () => undefined },
  });
  new Script(script).runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(elementFor("hero-dot").className, "hero-dot amber");
  assert.match(elementFor("hero-headline").textContent, /^Needs attention/);
  assert.match(elementFor("apply-health").innerHTML, /Pruning sweep blocked/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /Dispatching/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /2 of 28 exact-review slots open/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /health-badge healthy/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /pressure congested/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /4 total · 3 ready · 2 admissible/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /Review admission/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /52 review admission slots open/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /Result publication/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /3 result publication slots open/);
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /<div class="exact-lane-head"><strong>State writer<\/strong><span>Unavailable<\/span><\/div>/,
  );
  context.renderStateWriter({
    lanes: {
      publication: {
        batches: { enabled: true, max_items: 2 },
        active: 0,
        leased: 0,
        dispatching: 0,
        flow: {
          last_15_minutes: {
            resolved: 16,
            published: 0,
            superseded: 16,
            retried: 0,
            dead_lettered: 0,
          },
        },
      },
    },
    state_writer: {
      collection: { status: "stale", last_observed_at: "2026-07-21T12:12:42.397Z" },
      coordinator: {
        queued: 0,
        leased: 0,
        admitted: 16,
        completed: 16,
        expired: 0,
        recovered: 0,
        last_wait_ms: 0,
        max_wait_ms: 300_309,
      },
      global_lease: { status: "free" },
      last_60_minutes: {
        materialized_items: 0,
        state_commits: 0,
        items_per_commit: null,
        wait_ms: { p50: null, p95: null, samples: 0 },
        hold_ms: { p50: null, p95: null, samples: 0 },
      },
      live: { freshness_seconds: null, tracked_holding: 0, tracked_waiting: 0 },
      mode: "unknown",
    },
  });
  const stateWriterHtml = elementFor("state-writer-health").innerHTML;
  assert.match(stateWriterHtml, /class="exact-lane-head"/);
  assert.match(stateWriterHtml, /Batch · configured 2 · coordinator live · 6h/);
  assert.match(
    stateWriterHtml,
    /Serialization queue<\/span><strong>0 active · 0 queued · 1 writer max/,
  );
  assert.doesNotMatch(stateWriterHtml, /Git crash fence/);
  assert.match(stateWriterHtml, /Coordinator turns<\/dt><dd>16 completed · 16 admitted/);
  assert.match(stateWriterHtml, /Coordinator wait<\/dt><dd>last 0s · max 5m/);
  assert.match(stateWriterHtml, /Queue history<\/dt><dd>collecting samples/);
  assert.match(
    stateWriterHtml,
    /Terminal telemetry<\/dt><dd>idle · no exact-review materialization required in the last 15m/,
  );
  assert.doesNotMatch(stateWriterHtml, /terminal telemetry stale/);
  assert.doesNotMatch(stateWriterHtml, /Exact-review materialized/);

  context.renderStateWriter({
    lanes: {
      publication: {
        batches: { enabled: true, max_items: 2, leased: 1 },
        active: 0,
        leased: 0,
        dispatching: 0,
        flow: {
          last_15_minutes: {
            resolved: 16,
            published: 0,
            superseded: 16,
            retried: 0,
            dead_lettered: 0,
          },
        },
      },
    },
    state_writer: {
      collection: { status: "stale", last_observed_at: "2026-07-21T12:12:42.397Z" },
      coordinator: {
        queued: 2,
        leased: 1,
        admitted: 16,
        completed: 16,
        expired: 0,
        recovered: 0,
        last_wait_ms: 0,
        max_wait_ms: 300_309,
      },
      global_lease: { status: "free" },
      last_60_minutes: { materialized_items: 0, state_commits: 0 },
      mode: "batch",
    },
  });
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Terminal telemetry<\/dt><dd>awaiting exact-review writer result/,
  );
  assert.doesNotMatch(elementFor("state-writer-health").innerHTML, /terminal telemetry stale/);

  context.renderStateWriter({
    lanes: {
      publication: {
        batches: { enabled: true, max_items: 2 },
        flow: {
          last_15_minutes: {
            resolved: 1,
            published: 1,
            superseded: 0,
            retried: 0,
            dead_lettered: 0,
          },
        },
      },
    },
    state_writer: {
      collection: { status: "stale", last_observed_at: "2026-07-21T12:12:42.397Z" },
      coordinator: {
        queued: 0,
        leased: 0,
        admitted: 16,
        completed: 16,
        expired: 0,
        recovered: 0,
        last_wait_ms: 0,
        max_wait_ms: 300_309,
      },
      global_lease: { status: "free" },
      last_60_minutes: { materialized_items: 0, state_commits: 0 },
      mode: "batch",
    },
  });
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Terminal telemetry<\/dt><dd>terminal telemetry stale/,
  );

  const coordinatorSamples = [
    {
      at: new Date(Date.now() - 15 * 60_000).toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: null,
        tracked_waiting: "",
      },
    },
    {
      at: new Date(Date.now() - 10 * 60_000).toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: 1,
        tracked_waiting: 5,
        accepted_operations_total: 16,
        state_commits_total: 8,
        materialized_items_total: 16,
      },
    },
    {
      at: new Date(Date.now() - 5 * 60_000).toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: 1,
        tracked_waiting: 2,
      },
    },
    {
      at: new Date().toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: 1,
        tracked_waiting: 4,
      },
    },
  ];
  context.fetch = async () => ({
    ok: true,
    json: async () => ({ samples: coordinatorSamples }),
  });
  await context.loadHealthHistory("6h", true);
  context.renderStateWriter({
    lanes: { publication: { batches: { enabled: true, max_items: 2 } } },
    state_writer: {
      collection: { status: "stale" },
      coordinator: { queued: 0, leased: 0, admitted: 16, completed: 16 },
      global_lease: { status: "free" },
      last_60_minutes: { materialized_items: 0, state_commits: 0 },
      mode: "batch",
    },
  });
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Queue history<\/dt><dd>3 samples · 2–5 queued/,
  );
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Latest queue sample<\/dt><dd>1 active · 4 queued ·/,
  );
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Serialized writer queue depth over 6h/,
  );
  assert.doesNotMatch(elementFor("state-writer-health").innerHTML, /Exact-review materialized/);
  assert.match(stateWriterHtml, /class="lane-metrics"/);
  assert.doesNotMatch(stateWriterHtml, /<section class="exact-lane">/);
  const initialLaneHtml = elementFor("exact-review-lanes").innerHTML;
  assert.match(
    initialLaneHtml,
    /<details class="lane-flow"><summary><span class="lane-flow-title">Review throughput · last 15 minutes/,
  );
  assert.match(
    initialLaneHtml,
    /<details class="lane-flow"><summary><span class="lane-flow-title">Publication throughput · last 15 minutes/,
  );
  assert.match(
    initialLaneHtml,
    /15m hourly-equivalent rates respond faster to recent changes but are more burst-sensitive than the up-to-60m net rate above\./,
  );
  assert.equal(initialLaneHtml.match(/class="lane-flow"/g)?.length, 2);
  assert.equal(initialLaneHtml.match(/class="lane-flow-foot"/g)?.length, 2);
  assert.doesNotMatch(initialLaneHtml, /<details class="lane-flow" open>/);
  const flowBlocks = [
    ...initialLaneHtml.matchAll(/<details class="lane-flow">([\s\S]*?)<\/details>/g),
  ];
  assert.equal(flowBlocks.length, 2);
  assert.deepEqual(
    flowBlocks.map((match) => match[1].match(/class="lane-count"/g)?.length),
    [4, 4],
  );
  assert.match(initialLaneHtml, /Successful<\/span><strong>20\/h/);
  assert.match(initialLaneHtml, /Shed<\/span><strong>0\/h/);
  assert.match(initialLaneHtml, /Published<\/span><strong>4\/h/);
  assert.match(initialLaneHtml, /Superseded<\/span><strong>16\/h/);
  assert.doesNotMatch(initialLaneHtml, /Terminal resolved/);
  assert.doesNotMatch(initialLaneHtml, /Dead-lettered/);
  assert.match(initialLaneHtml, /DLQ 2/);
  assert.match(initialLaneHtml, /Retry amplification<\/span><strong>0\.20/);
  assert.match(initialLaneHtml, /Retry amplification<\/span><strong>0\.40/);
  assert.match(elementFor("worker-health").innerHTML, /Automerge worker operations/);
  assert.match(elementFor("worker-health").innerHTML, /Active \/ stalled<\/span><strong>0 \/ 0/);
  assert.match(elementFor("worker-health").innerHTML, /Failed attempts<\/span><strong>2/);
  assert.match(
    elementFor("worker-health").innerHTML,
    /Recovered \/ unresolved<\/span><strong>1 \/ 1/,
  );
  assert.match(elementFor("worker-health").innerHTML, /avg runtime 10m/);
  assert.match(elementFor("worker-health").innerHTML, /openclaw\/openclaw#107691/);
  assert.match(elementFor("worker-health").innerHTML, /actions\/runs\/29431617465/);
  assert.match(elementFor("worker-health").innerHTML, /unresolved/);
  assert.match(
    elementFor("exact-review-lanes").innerHTML,
    /target 32 · pressure ceiling 24 after GitHub rate limit/,
  );
  assert.match(elementFor("exact-review-lanes").innerHTML, /No backlog history in this range/);
  status.workers = [
    ...Array.from({ length: 128 }, (_, id) => ({
      id,
      status: "in_progress",
      is_codex_worker: true,
    })),
    { id: 128, status: "in_progress", is_codex_worker: false },
    { id: 129, status: "in_progress", is_codex_worker: false },
  ];
  context.renderSystemMap(status);
  assert.match(elementFor("capacity-rail").innerHTML, /128 running/);
  assert.doesNotMatch(elementFor("capacity-rail").innerHTML, /over budget/);
  status.workers = [{ id: 130, status: "in_progress", is_codex_worker: false }];
  context.renderDashboard(status, "");
  assert.match(elementFor("hero-headline").textContent, /0 claw workers sweeping/);
  status.workers = [];

  status.recent.apply_health.items = [];
  status.exact_review_queue.handoff_health.status = "stalled";
  status.exact_review_queue.pressure.status = "saturated";
  status.exact_review_queue.pressure.reason = "capacity_full_with_backlog";
  status.exact_review_queue.handoff_health.message =
    "A dispatched review has not been claimed within the expected handoff window.";
  context.renderDashboard(status, "");

  assert.equal(elementFor("hero-dot").className, "hero-dot red");
  assert.match(elementFor("hero-headline").textContent, /^Needs attention/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /health-badge stalled/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /pressure saturated/);

  Object.assign(status, { exact_review_queue: null });
  status.diagnostics.exact_review_queue_error = "exact-review queue timed out";
  context.renderDashboard(status, "");

  assert.equal(elementFor("hero-dot").className, "hero-dot amber");
  assert.match(elementFor("hero-headline").textContent, /^Needs attention/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /telemetry unavailable/);

  const healthyOperational = {
    status: "healthy",
    telemetry_complete: true,
    queued_runs: 0,
    queued_over_threshold: 0,
    oldest_queued_minutes: 0,
    running_runs: 0,
    running_over_threshold: 0,
    oldest_running_minutes: 0,
  };
  context.renderExecutionAlert(healthyOperational);
  assert.equal(elementFor("execution-alert").innerHTML, "");
  context.renderExecutionAlert({ ...healthyOperational, queued_runs: 2, queued_over_threshold: 2 });
  assert.match(
    elementFor("execution-alert").innerHTML,
    /2 workflows waiting for a runner over 30m/,
  );
  context.renderExecutionAlert({
    ...healthyOperational,
    queued_runs: 2,
    queued_over_threshold: 2,
    approval_gated_runs: 1,
    oldest_approval_gated_minutes: 7 * 24 * 60,
  });
  assert.match(
    elementFor("execution-alert").innerHTML,
    /1 awaiting deployment approval \(oldest 168h\)/,
  );
  context.renderExecutionAlert({
    ...healthyOperational,
    running_runs: 1,
    running_over_threshold: 1,
  });
  assert.match(elementFor("execution-alert").innerHTML, /1 execution over 150m/);
  context.renderExecutionAlert({ ...healthyOperational, telemetry_complete: false });
  assert.match(elementFor("execution-alert").innerHTML, /telemetry is incomplete/);

  status.diagnostics.exact_review_queue_error = null;
  status.exact_review_queue = { handoff_health: { status: "healthy", phases: {} } };
  status.operational_health = {
    status: "stalled",
    checked_at: "2026-07-05T11:22:43.934Z",
    telemetry_complete: true,
    queued_runs: 10,
    queued_over_threshold: 4,
    oldest_queued_minutes: 90,
    running_runs: 2,
    running_over_threshold: 1,
    oldest_running_minutes: 180,
  };
  context.renderDashboard(status, "");

  assert.equal(elementFor("hero-dot").className, "hero-dot red");
  assert.doesNotMatch(elementFor("metrics").innerHTML, /over 30m|over 150m/);
  assert.match(
    elementFor("execution-alert").innerHTML,
    /4 workflows waiting for a runner over 30m/,
  );
  assert.match(elementFor("execution-alert").innerHTML, /1 execution over 150m/);
  assert.match(elementFor("execution-alert").innerHTML, /Total GitHub queued 10/);
  assert.match(elementFor("execution-alert").innerHTML, /oldest running 3h/);

  const scale = context.niceTrendScale(95, 4);
  assert.equal(scale.maximum, 100);
  assert.deepEqual([...scale.ticks], [0, 25, 50, 75, 100]);

  let resolve24HourHistory: ((response: unknown) => void) | undefined;
  const now = Date.now();
  const samples = Array.from({ length: 25 }, (_, index) => ({
    at: new Date(now - (24 - index) * 5 * 60_000).toISOString(),
    collection_ok: true,
    exact_review: {
      collection_ok: true,
      review: {
        pending: 100 + index,
        enqueued_total: index * 8,
        completed_total: index * 5,
        shed_total: 0,
      },
      publication: {
        pending: 200 - index,
        enqueued_total: index * 4,
        completed_total: index * 10,
      },
    },
  }));
  context.fetch = async (input: string) => {
    if (input.includes("range=24h")) {
      return new Promise((resolve) => {
        resolve24HourHistory = resolve;
      });
    }
    return {
      ok: true,
      json: async () => ({ samples }),
    };
  };
  const stale24HourRequest = context.loadHealthHistory("24h", true);
  const active7DayRequest = context.loadHealthHistory("7d", true);
  await active7DayRequest;
  resolve24HourHistory?.({ ok: true, json: async () => ({ samples: [] }) });
  await stale24HourRequest;
  const laneHtml = elementFor("exact-review-lanes").innerHTML;
  assert.match(laneHtml, /Growing · \+12 in the last hour/);
  assert.match(laneHtml, /Draining · −12 in the last hour/);
  assert.match(laneHtml, /Net review rate/);
  assert.match(laneHtml, /Net publication rate/);
  assert.match(laneHtml, /Net review rate.*<\/div><strong>−36 \/ hour/);
  assert.match(laneHtml, /Net publication rate.*<\/div><strong>\+72 \/ hour/);
  assert.equal(laneHtml.match(/class="lane-rate-help"/g)?.length, 2);
  assert.equal(laneHtml.match(/role="tooltip"/g)?.length, 2);
  assert.match(laneHtml, /aria-describedby="lane-rate-help-net-review-rate"/);
  assert.match(laneHtml, /aria-describedby="lane-rate-help-net-publication-rate"/);
  assert.match(
    laneHtml,
    /Successful completions minus incoming review demand per hour\. Incoming includes newly queued work and shed demand\./,
  );
  assert.match(laneHtml, /Successful completions minus newly queued publication work per hour\./);
  assert.match(laneHtml, /Falling behind/);
  assert.match(laneHtml, /Catching up/);
  assert.equal(laneHtml.match(/class="lane-speed"/g)?.length, 2);
  assert.doesNotMatch(laneHtml, /Processed \/ hour|Incoming \/ hour/);
  assert.match(
    laneHtml,
    /role="img" aria-label="Net review rate, completed minus incoming, over 7d"/,
  );
  assert.match(
    laneHtml,
    /role="img" aria-label="Net publication rate, completed minus incoming, over 7d"/,
  );
  assert.match(laneHtml, /role="img" aria-label="Review admission pending backlog over 7d"/);
  assert.match(laneHtml, /Live snapshot unavailable/);
  assert.match(laneHtml, /Last sampled/);

  const smallAxis = context.exactReviewTrend(
    [{ at: new Date(now).toISOString(), pending: 8 }],
    "Small lane",
  );
  const largeAxis = context.exactReviewTrend(
    [{ at: new Date(now).toISOString(), pending: 1500 }],
    "Large lane",
  );
  assert.match(smallAxis, />8<\/text>/);
  assert.match(largeAxis, />2,000<\/text>/);
  const flowSample = (
    minutesAgo: number,
    enqueuedTotal: number,
    completedTotal: number,
    shedTotal = 0,
  ) => ({
    at: new Date(now - minutesAgo * 60_000).toISOString(),
    enqueuedTotal,
    completedTotal,
    shedTotal,
  });
  const provisionalSamples = [flowSample(5, 10, 20), flowSample(0, 12, 25)];
  const provisionalRates = context.laneSpeedHistory(provisionalSamples);
  assert.equal(provisionalRates.length, 1);
  assert.equal(Math.round(provisionalRates[0].rate), 36);
  assert.equal(provisionalRates[0].provisional, true);
  assert.equal(Math.round(provisionalRates[0].windowMinutes), 5);
  const provisionalSpeed = context.laneSpeedTrend(provisionalSamples, "Net review rate");
  assert.match(provisionalSpeed, /Net review rate<\/span><\/div><strong>\+36 \/ hour/);
  assert.match(provisionalSpeed, /Catching up · provisional 5m window/);

  const balancedSamples = [flowSample(5, 10, 20), flowSample(0, 10, 20)];
  const balancedSpeed = context.laneSpeedTrend(balancedSamples, "Net review rate");
  assert.match(balancedSpeed, /Net review rate<\/span><\/div><strong>0 \/ hour/);
  assert.match(balancedSpeed, /Balanced · provisional 5m window/);
  assert.doesNotMatch(balancedSpeed, /Collecting/);

  const shedRates = context.laneSpeedHistory([flowSample(5, 10, 20, 2), flowSample(0, 10, 20, 3)]);
  assert.equal(Math.round(shedRates[0].rate), -12);

  const matureRates = context.laneSpeedHistory(
    Array.from({ length: 13 }, (_, index) => flowSample((12 - index) * 5, index * 3, index * 5)),
  );
  assert.equal(Math.round(matureRates.at(-1).rate), 24);
  assert.equal(matureRates.at(-1).provisional, false);
  assert.equal(Math.round(matureRates.at(-1).windowMinutes), 60);

  const gapRates = context.laneSpeedHistory([
    flowSample(40, 0, 0),
    flowSample(35, 1, 2),
    flowSample(10, 2, 4),
    flowSample(5, 3, 6),
  ]);
  assert.equal(gapRates.length, 2);
  assert.notEqual(gapRates[0].segmentId, gapRates[1].segmentId);

  const resetRates = context.laneSpeedHistory([
    flowSample(20, 10, 10),
    flowSample(15, 11, 12),
    flowSample(10, 1, 1),
    flowSample(5, 2, 3),
  ]);
  assert.equal(resetRates.length, 2);
  assert.notEqual(resetRates[0].segmentId, resetRates[1].segmentId);
  const resetCollecting = context.laneSpeedTrend(
    [flowSample(10, 10, 10), flowSample(5, 11, 12), flowSample(0, 1, 1)],
    "Net review rate",
  );
  assert.match(resetCollecting, /Net review rate<\/span><\/div><strong>Collecting/);
  assert.match(resetCollecting, /Needs two continuous five-minute samples/);

  const legacyBreakRates = context.laneSpeedHistory([
    flowSample(25, 10, 10),
    flowSample(20, 11, 12),
    { at: new Date(now - 15 * 60_000).toISOString(), pending: 1 },
    flowSample(10, 12, 14),
    flowSample(5, 13, 16),
  ]);
  assert.equal(legacyBreakRates.length, 2);
  assert.notEqual(legacyBreakRates[0].segmentId, legacyBreakRates[1].segmentId);
  const speedGeometry = context.speedTrendGeometry(
    legacyBreakRates,
    { left: 0, top: 0, width: 100, height: 100 },
    20,
    now - 30 * 60_000,
    now,
  );
  assert.equal(speedGeometry[1].connected, false);
  assert.match(context.trendPath(speedGeometry), /^M.* M/);

  const staleSpeed = context.laneSpeedTrend(
    [flowSample(25, 0, 0), flowSample(20, 1, 2)],
    "Net publication rate",
  );
  assert.match(staleSpeed, /Net publication rate<\/span><\/div><strong>Stale/);
  assert.match(staleSpeed, /Stale · no rate sample in the last 12m/);
  const collectingSpeed = context.laneSpeedTrend([flowSample(0, 0, 0)], "Net review rate");
  assert.match(collectingSpeed, /Net review rate<\/span><\/div><strong>Collecting/);
  assert.match(collectingSpeed, /Needs two continuous five-minute samples/);

  assert.equal(
    context.oneHourTrend(samples.slice(0, 1).map((sample) => ({ at: sample.at, pending: 4 })))
      .label,
    "Collecting 1h trend",
  );
  assert.equal(
    context.oneHourTrend(samples.map((sample) => ({ at: sample.at, pending: 9 }))).label,
    "Stable · no change in the last hour",
  );
  const broken = context.trendGeometry(
    [
      { at: new Date(now - 30 * 60_000).toISOString(), pending: 1 },
      { at: new Date(now - 10 * 60_000).toISOString(), pending: 2 },
    ],
    "pending",
    { left: 0, top: 0, width: 100, height: 100 },
    2,
    now - 60 * 60_000,
    now,
  );
  assert.equal(broken[1].connected, false);
  assert.match(context.trendPath(broken), /^M.* M/);
});

test("dashboard HTML emits early persistent theme controls", async () => {
  for (const path of ["/", "/triage", "/pr-proof-triage"]) {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai" + path));
    const html = await response.text();
    const themeInit = html.indexOf('const themeKey = "clawsweeper-theme";');
    const styles = html.indexOf("<style>");

    assert.notEqual(themeInit, -1, path + " should initialize theme preference");
    assert.notEqual(styles, -1, path + " should include CSS");
    assert.ok(themeInit < styles, path + " should apply saved theme before styles");
    assert.match(html, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
    assert.match(html, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
    assert.match(html, /data-theme-choice="system"/);
    assert.match(html, /data-theme-choice="light"/);
    assert.match(html, /data-theme-choice="dark"/);
    assert.match(html, /window\.localStorage\?\.setItem\(themeKey, choice\)/);
    assert.match(html, /typeof themeQuery\?\.addEventListener === "function"/);
    assert.match(html, /themeQuery\.addEventListener\("change", updateSystemTheme\)/);
    assert.match(html, /themeQuery\?\.addListener\?\.\(updateSystemTheme\)/);
    assert.match(html, /setAttribute\("aria-pressed", selected \? "true" : "false"\)/);
  }
});

test("dashboard groups automatic issue lifecycle events with active workers", () => {
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_queued",
        repository: "steipete/example",
        source_item_number: 42,
        source_item_url: "https://github.com/steipete/example/issues/42",
        title: "Add compact export mode",
        stage: "queued",
        status: "queued",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/100",
        work_kind: "issue_to_pr",
        automatic: true,
        received_at: "2026-06-14T10:00:00Z",
      },
      {
        event_type: "clawsweeper.generated_pr_opened",
        repository: "steipete/example",
        source_item_number: 42,
        source_item_url: "https://github.com/steipete/example/issues/42",
        item_url: "https://github.com/steipete/example/pull/51",
        pr_url: "https://github.com/steipete/example/pull/51",
        title: "Add compact export mode",
        stage: "pr_opened",
        status: "completed",
        work_kind: "issue_to_pr",
        automatic: null,
        received_at: "2026-06-14T10:10:00Z",
      },
    ],
    [
      {
        id: 7001,
        repository: "steipete/example",
        item_number: 42,
        work_kind: "issue_to_pr",
        name: "Implement issue",
        status: "in_progress",
        current_step: "Run Codex",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/100",
        updated_at: "2026-06-14T10:05:00Z",
        target_items: [
          {
            number: 42,
            title: "Add compact export mode",
            url: "https://github.com/steipete/example/issues/42",
          },
        ],
      },
    ],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "steipete/example#42");
  assert.equal(rows[0].title, "Add compact export mode");
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].worker_id, "7001");
  assert.equal(rows[0].pr_url, "https://github.com/steipete/example/pull/51");
  assert.equal(rows[0].timeline.length, 3);
});

test("dashboard correlates issue implementation workers by run URL", () => {
  const workers = [
    {
      id: 7002,
      repository: null,
      item_number: null,
      item_numbers: [],
      work_kind: "issue_to_pr",
      name: "Execute and apply cluster actions",
      status: "in_progress",
      current_step: "Execute credited fix artifact",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/101",
      updated_at: "2026-06-14T10:05:00Z",
      target_items: [],
    },
  ];
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_started",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        title: "Install sudo when missing",
        stage: "building",
        status: "running",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/101",
        work_kind: "issue_to_pr",
        automatic: true,
        received_at: "2026-06-14T10:04:00Z",
      },
    ],
    workers,
  );

  assert.equal(rows[0].active, true);
  assert.equal(rows[0].worker_id, "7002");
  assert.equal(workers[0].repository, "openclaw/openclaw-ansible");
  assert.equal(workers[0].item_number, 20);
  assert.equal(workers[0].target_items[0].title, "Install sudo when missing");
});

test("dashboard preserves issue titles across generated PR repair events", () => {
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_started",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        title: "installation fails due to not sudo installed",
        stage: "building",
        status: "running",
        automatic: true,
        received_at: "2026-06-14T10:00:00Z",
      },
      {
        event_type: "clawsweeper.contributor_branch_repaired",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        item_url: "https://github.com/openclaw/openclaw-ansible/pull/49",
        pr_url: "https://github.com/openclaw/openclaw-ansible/pull/49",
        title: "openclaw/openclaw-ansible#49",
        stage: "repair_contributor_branch",
        status: "pushed",
        received_at: "2026-06-14T10:10:00Z",
      },
    ],
    [],
  );

  assert.equal(rows[0].title, "installation fails due to not sudo installed");
  assert.equal(rows[0].pr_url, "https://github.com/openclaw/openclaw-ansible/pull/49");
});

test("dashboard exposes active worker jobs and their current steps", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: cache,
    },
  });
  const run = {
    id: 42,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#92521",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
    created_at: isoAgo(120_000),
    updated_at: isoAgo(10_000),
  };
  const queuedRun = {
    id: 43,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#92523",
    status: "queued",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/43",
    created_at: isoAgo(30_000),
    updated_at: isoAgo(5_000),
  };
  const queuedBatchRun = {
    id: 44,
    name: "Publish exact review batch",
    display_title: "Publish exact review batch",
    status: "queued",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/44",
    created_at: isoAgo(20_000),
    updated_at: isoAgo(2_000),
  };
  let graphqlRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status
          ? [run, queuedRun, queuedBatchRun]
          : status === "in_progress"
            ? [run]
            : status === "queued"
              ? [queuedRun, queuedBatchRun]
              : [],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/42/jobs") {
      return jsonResponse({
        jobs: [
          {
            id: 4201,
            name: "Review shard 0 · openclaw/openclaw#92521,92522",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4201",
            started_at: isoAgo(90_000),
            steps: [
              {
                number: 1,
                name: "Set up job",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 3,
                name: "Review shard",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
          {
            id: 4202,
            name: "Publish review artifacts",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4202",
            started_at: isoAgo(60_000),
            steps: [
              {
                number: 1,
                name: "Apply review artifacts",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Publish review artifact action ledger",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
          {
            id: 4203,
            name: "publish",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4203",
            started_at: isoAgo(55_000),
            steps: [
              {
                number: 1,
                name: "Claim one durable publication batch",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Finalize healthy members under a fenced heartbeat",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        ],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/43/jobs") {
      return jsonResponse({ jobs: [] });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/44/jobs") {
      return jsonResponse({
        jobs: [
          {
            id: 4401,
            name: "publish",
            status: "queued",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/44/job/4401",
            started_at: null,
            steps: [],
          },
        ],
      });
    }
    if (url.pathname === "/graphql") {
      graphqlRequests += 1;
      return jsonResponse({
        data: {
          repository: {
            target0: {
              __typename: "Issue",
              title: "Preserve terminal resize state",
              url: "https://github.com/openclaw/openclaw/issues/92521",
            },
            target1: {
              __typename: "PullRequest",
              title: "Repair terminal resize state",
              url: "https://github.com/openclaw/openclaw/pull/92522",
            },
            target2: {
              __typename: "Issue",
              title: "Queued terminal resize follow-up",
              url: "https://github.com/openclaw/openclaw/issues/92523",
            },
          },
        },
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 2);
    assert.equal(status.fleet.worker_detail_runs, 3);
    assert.equal(status.fleet.worker_detail_fallbacks, 1);
    assert.equal(status.workers.length, 5);
    assert.equal(status.workers[0].id, 4201);
    assert.equal(status.workers[0].name, "Review shard 0 · openclaw/openclaw#92521,92522");
    assert.equal(status.workers[0].repository, "openclaw/openclaw");
    assert.equal(status.workers[0].item_number, null);
    assert.deepEqual(status.workers[0].item_numbers, [92521, 92522]);
    assert.equal(status.workers[0].current_step, "Review shard");
    assert.deepEqual(status.workers[0].progress, { completed: 2, total: 3 });
    assert.equal(status.workers[0].steps[2].status, "in_progress");
    assert.deepEqual(status.workers[0].target_items, [
      {
        repository: "openclaw/openclaw",
        number: 92521,
        title: "Preserve terminal resize state",
        url: "https://github.com/openclaw/openclaw/issues/92521",
        type: "issue",
      },
      {
        repository: "openclaw/openclaw",
        number: 92522,
        title: "Repair terminal resize state",
        url: "https://github.com/openclaw/openclaw/pull/92522",
        type: "pull_request",
      },
    ]);
    assert.equal(status.workers[1].id, 4202);
    assert.equal(status.workers[1].name, "Publish review artifacts");
    assert.equal(status.workers[1].is_codex_worker, false);
    assert.equal(status.workers[1].item_number, 92521);
    assert.equal(status.workers[1].current_step, "Publish review artifact action ledger");
    assert.equal(status.workers[1].steps[0].name, "Apply review artifacts");
    assert.equal(status.workers[2].id, 4203);
    assert.equal(status.workers[2].name, "publish");
    assert.equal(status.workers[2].is_codex_worker, false);
    assert.equal(
      status.workers[2].current_step,
      "Finalize healthy members under a fenced heartbeat",
    );
    const cachedPublisherJobs = await cache.match(
      new Request("https://clawsweeper.internal/store/workflow-jobs%3Aopenclaw%2Fclawsweeper%3A42"),
    );
    assert.equal(cachedPublisherJobs?.headers.get("cache-control"), "public, max-age=60");
    assert.equal(status.workers[3].id, "run-43");
    assert.equal(status.workers[3].source, "workflow-fallback");
    assert.equal(status.workers[3].current_step, "reviewing");
    assert.equal(status.workers[3].target_items[0].title, "Queued terminal resize follow-up");
    const queuedBatchPublisher = status.workers.find((entry) => entry.id === 4401);
    assert.ok(queuedBatchPublisher);
    assert.equal(queuedBatchPublisher.name, "publish");
    assert.equal(queuedBatchPublisher.is_codex_worker, false);
    assert.equal(queuedBatchPublisher.workflow_title, "Publish exact review batch");
    assert.equal(queuedBatchPublisher.current_step, "Waiting for runner");

    const cachedResponse = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const cachedStatus = await cachedResponse.json();
    assert.equal(cachedStatus.workers[0].target_items[0].title, "Preserve terminal resize state");
    assert.equal(graphqlRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard keeps control-plane workflow fallbacks out of Codex capacity", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const runs = [
    [1, "ClawSweeper", "Review event item openclaw/openclaw#1", "in_progress"],
    [2, "repair cluster worker", "repair cluster jobs/openclaw/inbox/cluster-2.md", "queued"],
    [3, "Assist", "Assist openclaw/openclaw#3", "in_progress"],
    [4, "ClawSweeper", "Review event item openclaw/openclaw#4@publish:40:1", "in_progress"],
    [5, "repair comment router", "clawsweeper_comment", "queued"],
    [6, "Reconcile exact-review leases", "Reconcile exact-review leases", "in_progress"],
    [7, "ClawSweeper", "Sync Codex review comments for openclaw/openclaw", "queued"],
  ].map(([id, name, displayTitle, status]) => ({
    id,
    name,
    display_title: displayTitle,
    status,
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: isoAgo(Number(id) * 1_000),
    updated_at: isoAgo(500),
  }));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status ? runs : runs.filter((run) => run.status === status),
      });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      return jsonResponse({ jobs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 3);
    assert.equal(status.fleet.worker_detail_fallbacks, 3);
    assert.deepEqual(status.workers.map((entry: { id: string }) => entry.id).sort(), [
      "run-1",
      "run-2",
      "run-3",
    ]);
    assert.deepEqual(status.control_plane, {
      publishers: { running: 1, waiting: 0 },
      comment_routers: { running: 0, waiting: 2 },
      reconcilers: { running: 1, waiting: 0 },
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard bounds worker job detail request concurrency", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = Array.from({ length: 12 }, (_, index) => ({
    id: 1000 + index,
    name: "Review ClawSweeper items",
    display_title: `Review event item openclaw/openclaw#${9000 + index}`,
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${1000 + index}`,
    created_at: isoAgo((index + 1) * 1000),
    updated_at: isoAgo(1000),
  }));
  let activeJobRequests = 0;
  let maxActiveJobRequests = 0;
  let pipelineRequestsWhileJobsActive = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      const runId = Number(url.pathname.split("/").at(-2));
      activeJobRequests += 1;
      maxActiveJobRequests = Math.max(maxActiveJobRequests, activeJobRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeJobRequests -= 1;
      return jsonResponse({
        jobs: [
          {
            id: runId * 10,
            name: `Review shard ${runId}`,
            status: "in_progress",
            conclusion: null,
            html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}/job/${
              runId * 10
            }`,
            started_at: isoAgo(1000),
            steps: [
              {
                number: 1,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Review shard",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        ],
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/pulls\/\d+$/.test(url.pathname)) {
      if (activeJobRequests) pipelineRequestsWhileJobsActive += 1;
      return jsonResponse({ head: { sha: `head-${url.pathname.split("/").at(-1)}` } });
    }
    if (/^\/repos\/openclaw\/openclaw\/commits\/head-\d+\/check-runs$/.test(url.pathname)) {
      if (activeJobRequests) pipelineRequestsWhileJobsActive += 1;
      return jsonResponse({ check_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        WORKER_DETAIL_RUN_LIMIT: "12",
        WORKER_JOB_FETCH_CONCURRENCY: "3",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.workers.length, 12);
    assert.equal(status.fleet.active_codex_jobs, 12);
    assert.equal(maxActiveJobRequests, 3);
    assert.equal(pipelineRequestsWhileJobsActive, 0);
    assert.deepEqual(status.diagnostics.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard paginates worker jobs beyond GitHub's first page", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const run = {
    id: 500,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#500",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/500",
    created_at: isoAgo(60_000),
    updated_at: isoAgo(5_000),
  };
  const requestedPages = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status || status === "in_progress" ? [run] : [],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/500/jobs") {
      const page = Number(url.searchParams.get("page") || "1");
      requestedPages.push(page);
      const count = page === 1 ? 100 : 28;
      const offset = page === 1 ? 0 : 100;
      return jsonResponse({
        total_count: 128,
        jobs: Array.from({ length: count }, (_, index) => ({
          id: 500_000 + offset + index,
          name: `Review shard ${offset + index}`,
          status: "in_progress",
          conclusion: null,
          html_url: `https://github.com/openclaw/clawsweeper/actions/runs/500/job/${
            500_000 + offset + index
          }`,
          started_at: isoAgo(30_000),
          steps: [
            {
              number: 1,
              name: "Run ./clawsweeper/.github/actions/setup-codex",
              status: "completed",
              conclusion: "success",
            },
            {
              number: 2,
              name: "Review shard",
              status: "in_progress",
              conclusion: null,
            },
          ],
        })),
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 128);
    assert.equal(status.workers.length, 128);
    assert.deepEqual(requestedPages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reports worker error and recovery rates from completed job steps", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = [
    completedReviewRun(4, 300, "success", 60_000),
    completedReviewRun(3, 200, "success", 120_000),
    completedReviewRun(2, 100, "success", 180_000),
    completedReviewRun(1, 100, "success", 240_000),
  ];
  let jobRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({
        workflow_runs:
          url.searchParams.get("status") === "completed"
            ? runs
            : url.searchParams.has("status")
              ? []
              : runs,
      });
    }
    const jobMatch = url.pathname.match(
      /^\/repos\/openclaw\/clawsweeper\/actions\/runs\/(\d+)\/jobs$/,
    );
    if (jobMatch) {
      jobRequests += 1;
      const runId = Number(jobMatch[1]);
      const itemNumber = runId === 1 || runId === 2 ? 100 : runId === 3 ? 200 : 300;
      const failed = runId === 1 || runId === 3;
      const run = runs.find((candidate) => candidate.id === runId);
      const runStartedAt = Date.parse(run?.created_at || "");
      const jobStartedAt = new Date(runStartedAt + 1_000).toISOString();
      const reviewStartedAt = new Date(runStartedAt + 3_000).toISOString();
      return jsonResponse({
        jobs: [
          {
            id: runId * 10,
            name: `Review shard 0 · openclaw/openclaw#${itemNumber}`,
            status: "completed",
            conclusion: runId === 4 ? "neutral" : "success",
            html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}/job/${
              runId * 10
            }`,
            started_at: jobStartedAt,
            completed_at: run?.updated_at,
            steps: [
              {
                number: 1,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
                started_at: jobStartedAt,
                completed_at: reviewStartedAt,
              },
              {
                number: 2,
                name: "Review shard",
                status: "completed",
                conclusion: failed ? "failure" : "success",
                started_at: reviewStartedAt,
                completed_at: run?.updated_at,
              },
            ],
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
      STATUS_STORE: new MemoryKv(),
    };
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.health.attempts, 4);
    assert.equal(status.health.successful_attempts, 2);
    assert.equal(status.health.failed_attempts, 2);
    assert.equal(status.health.recovered_failures, 1);
    assert.equal(status.health.unresolved_failures, 1);
    assert.equal(status.health.error_rate_percent, 50);
    assert.equal(status.health.recovery_rate_percent, 50);
    assert.equal(status.bay.tide_threshold, 20);
    assert.equal(status.bay.tide_generation, 0);
    assert.equal(status.bay.terminal_count, 3);
    assert.equal(status.bay.timings.lanes, undefined);
    assert.deepEqual(status.bay.timings.overall, {
      average_ms: null,
      median_ms: null,
      samples: 0,
    });
    assert.deepEqual(
      status.bay.terminal_buffer.map((item: { number: number }) => item.number),
      [100, 200, 300],
    );
    assert.equal(status.health.recent_attempts, undefined);
    assert.equal(status.health.failures[0].item_numbers[0], 200);
    assert.equal(status.health.failures[0].recovered, false);
    assert.equal(status.health.failures[0].failed_step, "Review shard");
    assert.equal(status.health.failures[1].item_numbers[0], 100);
    assert.equal(status.health.failures[1].recovered, true);
    assert.equal(jobRequests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes scheduled cluster intake markers and runs", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const marker = {
    target_repo: "openclaw/openclaw",
    last_processed_store_sha256: "abc123def4567890",
    last_processed_store_exported_at: "2026-05-25T12:00:00Z",
    generated_count: 1,
    generated_jobs: ["jobs/openclaw/inbox/gitcrawl-42-login-fix.md"],
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
    updated_at: "2026-05-25T12:08:00Z",
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 42,
            name: "repair cluster intake",
            display_title: "repair cluster intake",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
            created_at: "2026-05-25T12:08:00Z",
            updated_at: "2026-05-25T12:09:00Z",
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper-state/contents/results/cluster-repair-intake/openclaw-openclaw.json"
    ) {
      assert.equal(url.searchParams.get("ref"), "state");
      return jsonResponse({
        content: Buffer.from(JSON.stringify(marker)).toString("base64"),
      });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.recent.cluster_repair.workflow, "repair-cluster-intake.yml");
    assert.equal("schedule" in status.recent.cluster_repair, false);
    assert.equal(status.recent.cluster_repair.markers[0].status, "imported");
    assert.equal(status.recent.cluster_repair.markers[0].generated_count, 1);
    assert.equal(
      status.recent.cluster_repair.markers[0].last_processed_store_short_sha,
      "abc123def4",
    );
    assert.equal(status.recent.cluster_repair.latest_runs[0].url, marker.run_url);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes apply health from sweep status without broad scans", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const sweepStatus = {
    target_repo: "openclaw/openclaw",
    state: "Apply finished",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/99",
    updated_at: "2026-07-03T10:15:00Z",
    apply_health: {
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/98",
      mode: "close",
      status: "needs_attention",
      summary:
        "4 examined; 2/2 action records; 0 closed, 0 comments synced, 2 skipped; no cursor recorded.",
      examined: 4,
      action_records: 2,
      processed: 2,
      processed_limit: 2,
      close_limit: 5,
      closed: 0,
      comment_synced: 0,
      skipped: 2,
      cursor_required: true,
      skip_reasons: {
        skipped_changed_since_review: 2,
      },
      lanes: {
        closure: {
          processed: 2,
          closed: 0,
          comment_synced: 0,
          skipped: 2,
          skip_reasons: {
            skipped_changed_since_review: 2,
          },
        },
        comment_sync: {
          processed: 0,
          closed: 0,
          comment_synced: 0,
          skipped: 0,
          skip_reasons: {},
        },
      },
      next_actions: [
        {
          reason: "skipped_changed_since_review",
          count: 2,
          bucket: "review_refresh",
          owner: "clawsweeper",
          retryable: true,
          label: "Refresh review",
          summary: "The item changed after the review that proposed closing it.",
          next_step: "Queue a fresh ClawSweeper review before any close retry.",
        },
      ],
      next_action_buckets: {
        review_refresh: 2,
      },
      cycle: {
        basis: "scheduled_close_cursor",
        apply_ready_count: 1200,
        candidate_counts: {
          confirmed_proposal: 4,
          guarded_retry: 2,
          proof_required: 3,
          promotion_total: 1194,
          promotion_eligible: 1,
          promotion_cooldown_eligible: 420,
          cooldown_eligible_total: 427,
          inconsistent_or_stale: 1,
        },
        window_size: 300,
        estimated_full_cycle_windows: 4,
        estimated_full_cycle_minutes: null,
        scheduled_interval_minutes: null,
        label:
          "1200 close candidates (confirmed proposals plus live promotion probes) at 300 records per latest cursor advance: about 4 windows.",
      },
      attention_reasons: ["cursor_required_but_missing_after_full_window"],
      cursor: null,
    },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper-state/contents/results/sweep-status/openclaw-openclaw.json"
    ) {
      assert.equal(url.searchParams.get("ref"), "state");
      return jsonResponse({
        content: Buffer.from(JSON.stringify(sweepStatus)).toString("base64"),
      });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.recent.apply_health.attention_count, 1);
    assert.equal(status.recent.apply_health.items[0].status, "needs_attention");
    assert.equal(
      status.recent.apply_health.items[0].run_url,
      "https://github.com/openclaw/clawsweeper/actions/runs/98",
    );
    assert.equal(status.recent.apply_health.items[0].examined, 4);
    assert.equal(status.recent.apply_health.items[0].action_records, 2);
    assert.equal(status.recent.apply_health.items[0].processed, 2);
    assert.equal(status.recent.apply_health.items[0].cursor_required, true);
    assert.deepEqual(status.recent.apply_health.items[0].skip_reasons, {
      skipped_changed_since_review: 2,
    });
    assert.deepEqual(status.recent.apply_health.items[0].lanes.closure, {
      processed: 2,
      closed: 0,
      comment_synced: 0,
      skipped: 2,
      skip_reasons: {
        skipped_changed_since_review: 2,
      },
    });
    assert.equal(status.recent.apply_health.items[0].lanes.comment_sync.processed, 0);
    assert.deepEqual(status.recent.apply_health.items[0].next_action_buckets, {
      review_refresh: 2,
    });
    assert.equal(
      status.recent.apply_health.items[0].next_actions[0].next_step,
      "Queue a fresh ClawSweeper review before any close retry.",
    );
    assert.equal(status.recent.apply_health.items[0].cycle.estimated_full_cycle_minutes, null);
    assert.equal(status.recent.apply_health.items[0].cycle.apply_ready_count, 1200);
    assert.deepEqual(status.recent.apply_health.items[0].cycle.candidate_counts, {
      confirmed_proposal: 4,
      guarded_retry: 2,
      proof_required: 3,
      promotion_total: 1194,
      promotion_eligible: 1,
      promotion_cooldown_eligible: 420,
      cooldown_eligible_total: 427,
      inconsistent_or_stale: 1,
    });
    assert.equal(status.recent.apply_health.items[0].cursor, null);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reads stored CI status for active PR rows", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            name: "ClawSweeper",
            display_title: "Review event item openclaw/openclaw#80609",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.includes("/search/issues")) return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "ci.status",
          repository: "openclaw/openclaw",
          item_number: 80609,
          status: "green",
          ci: {
            repository: "openclaw/openclaw",
            item_number: 80609,
            state: "green",
            source: "github-checks",
            total: 12,
            failing: 0,
            pending: 0,
          },
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].repository, "openclaw/openclaw");
    assert.equal(status.pipeline[0].item_number, 80609);
    assert.equal(status.pipeline[0].ci.state, "green");
    assert.equal(status.pipeline[0].ci.source, "github-checks");
    assert.equal(status.pipeline[0].ci.total, 12);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard falls back to edge cache storage when KV is not bound", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "ci.status",
          repository: "openclaw/openclaw",
          item_number: 80609,
          ci: {
            repository: "openclaw/openclaw",
            item_number: 80609,
            state: "pending",
            source: "github-checks",
            total: 12,
            failing: 0,
            pending: 2,
          },
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].ci.state, "pending");
    assert.equal(status.pipeline[0].ci.source, "github-checks");
    assert.equal(status.pipeline[0].ci.pending, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard serves stale status while coalescing one background refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: cache },
  });
  await cache.put(
    new Request("https://clawsweeper.openclaw.ai/api/status-cache/v3/stale"),
    jsonResponse({
      schema_version: 1,
      generated_at: "2026-06-13T18:00:00Z",
      source: {
        clawsweeper_repo: "openclaw/clawsweeper",
        target_repositories: ["openclaw/openclaw"],
      },
      fleet: { active_workflow_runs: 1 },
      workers: [],
      pipeline: [{ id: "stale-row" }],
      exact_review_queue: {
        pending: 1,
        dispatching: 1,
        leased: 0,
        handoff_health: { status: "stalled" },
      },
      diagnostics: { errors: [], exact_review_queue_error: null },
    }),
  );

  const currentQueue = {
    pending: 7,
    dispatching: 0,
    leased: 28,
    storage_schema_version: 1,
    handoff_health: {
      status: "healthy",
      reason: "handoff_current",
      phases: {
        pending: { count: 7 },
        dispatching: { count: 0 },
        leased: { count: 28 },
      },
    },
  };
  let queueReads = 0;
  const exactReviewQueue = new MemoryDurableNamespace({
    fetch: async () => {
      queueReads += 1;
      return jsonResponse(currentQueue);
    },
  });

  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let unfilteredRunRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    await fetchGate;
    if (url.pathname.includes("/actions/")) {
      if (url.pathname.endsWith("/actions/runs") && !url.searchParams.has("status")) {
        unfilteredRunRequests += 1;
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const waitUntilPromises: Promise<unknown>[] = [];
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "20",
      EXACT_REVIEW_QUEUE: exactReviewQueue,
    };
    const context = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
    };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const [first, second] = await Promise.all([
      worker.fetch(request, env, context),
      worker.fetch(request, env, context),
    ]);

    assert.equal(first.headers.get("x-clawsweeper-cache"), "stale");
    assert.equal(second.headers.get("x-clawsweeper-cache"), "stale");
    const firstStatus = await first.json();
    const secondStatus = await second.json();
    assert.equal(firstStatus.pipeline[0].id, "stale-row");
    assert.equal(firstStatus.exact_review_queue.pending, 1);
    assert.equal(firstStatus.exact_review_queue.handoff_health.status, "stalled");
    assert.equal(secondStatus.exact_review_queue.handoff_health.status, "stalled");
    assert.equal(queueReads, 0);
    assert.equal(waitUntilPromises.length, 2);

    releaseFetch();
    await Promise.all(waitUntilPromises);
    assert.equal(unfilteredRunRequests, 1);
    assert.equal(queueReads, 2);

    const refreshed = await worker.fetch(request, env);
    assert.equal(refreshed.headers.get("x-clawsweeper-cache"), "fresh");
    const refreshedStatus = await refreshed.json();
    assert.deepEqual(refreshedStatus.pipeline, []);
    assert.equal(refreshedStatus.exact_review_queue.pending, 7);
    assert.equal(refreshedStatus.exact_review_queue.handoff_health.status, "healthy");
    assert.equal(queueReads, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard status survives cache persistence failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async (request: Request) => {
          if (
            request.url.includes("/api/status-cache/") ||
            request.url.includes("recent-automerge") ||
            request.url.includes("recent-closed")
          ) {
            throw new Error("cache unavailable");
          }
        },
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-clawsweeper-cache"), "miss");
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 1);
    assert.deepEqual(status.diagnostics.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard parallelizes and caches historical GitHub telemetry", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let closedRequests = 0;
  let activeDetails = 0;
  let maxActiveDetails = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        items: [101, 102, 103, 104].map((number) => ({
          number,
          title: `Merged PR ${number}`,
          html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
        })),
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/(?:pulls\/\d+|issues\/\d+\/comments)$/.test(url.pathname)) {
      activeDetails += 1;
      maxActiveDetails = Math.max(maxActiveDetails, activeDetails);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDetails -= 1;
      if (url.pathname.includes("/comments")) {
        return jsonResponse([
          {
            body: "@clawsweeper automerge",
            created_at: "2026-06-13T18:00:00Z",
          },
        ]);
      }
      return jsonResponse({
        merged_at: "2026-06-13T18:01:00Z",
        merge_commit_sha: "abc123",
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      closedRequests += 1;
      return jsonResponse([]);
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const env = {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "-1",
    };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const first = await worker.fetch(request, env);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).averages.automerge_samples, 4);
    assert.ok(maxActiveDetails >= 4);
    assert.equal(searchRequests, 1);
    assert.equal(closedRequests, 1);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await worker.fetch(request, env);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).averages.automerge_samples, 4);
    assert.equal(searchRequests, 1);
    assert.equal(closedRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reports automerge worker reliability independently of merged PR timing", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let reliabilityRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      reliabilityRequests += 1;
      const workflowRun = (
        id: number,
        number: number,
        conclusion: "failure" | "success",
        createdAt: string,
        updatedAt: string,
      ) => ({
        id,
        display_title: `automerge repair jobs/openclaw/inbox/automerge-openclaw-openclaw-${number}.md`,
        status: "completed",
        conclusion,
        html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return jsonResponse({
        workflow_runs: [
          workflowRun(
            29431617465,
            107691,
            "failure",
            "2026-07-15T16:15:04Z",
            "2026-07-15T16:34:51Z",
          ),
          workflowRun(
            29434021623,
            107691,
            "success",
            "2026-07-15T16:49:45Z",
            "2026-07-15T16:51:53Z",
          ),
          workflowRun(
            29435000000,
            107692,
            "failure",
            "2026-07-15T17:00:00Z",
            "2026-07-15T17:10:00Z",
          ),
        ],
      });
    }
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "-1",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    const reliability = status.recent.automerge_reliability;
    assert.equal(reliabilityRequests, 1);
    assert.equal(reliability.sampled_runs, 3);
    assert.equal(reliability.failure_rate_percent, 66.7);
    assert.equal(reliability.recovered_failures, 1);
    assert.equal(reliability.unresolved_failures, 1);
    assert.deepEqual(
      reliability.failures.map((failure: { number: number; status: string }) => [
        failure.number,
        failure.status,
      ]),
      [
        [107692, "unresolved"],
        [107691, "recovered"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard batches recent automerge hydration with GraphQL when authenticated", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let graphqlRequests = 0;
  let restDetailRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        items: [101, 102].map((number) => ({
          number,
          title: `Merged PR ${number}`,
          html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
        })),
      });
    }
    if (url.pathname === "/graphql") {
      graphqlRequests += 1;
      return jsonResponse({
        data: {
          repository: {
            pr0: {
              mergedAt: "2026-06-13T18:01:00Z",
              mergeCommit: { oid: "abc101" },
              comments: {
                nodes: [
                  {
                    body: "@clawsweeper automerge",
                    createdAt: "2026-06-13T18:00:30Z",
                  },
                  {
                    body: "/clawsweeper automerge",
                    createdAt: "2026-06-13T18:00:00Z",
                  },
                ],
              },
            },
            pr1: {
              mergedAt: "2026-06-13T18:04:00Z",
              mergeCommit: { oid: "abc102" },
              comments: {
                nodes: [
                  {
                    body: "/clawsweeper automerge",
                    createdAt: "2026-06-13T18:02:00Z",
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/(?:pulls\/\d+|issues\/\d+\/comments)$/.test(url.pathname)) {
      restDetailRequests += 1;
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "-1",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.averages.automerge_samples, 2);
    assert.equal(status.averages.automerge_command_to_merge_ms, 90_000);
    assert.equal(searchRequests, 1);
    assert.equal(graphqlRequests, 1);
    assert.equal(restDetailRequests, 0);
    assert.deepEqual(
      status.recent.automerge.map((item: { number: number; merge_commit_sha: string }) => [
        item.number,
        item.merge_commit_sha,
      ]),
      [
        [101, "abc101"],
        [102, "abc102"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard preserves repeated untargeted activity events", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    for (const title of ["Probe one", "Probe two"]) {
      const ingest = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            event_type: "status.test",
            mode: "test",
            stage: "probe",
            status: "ok",
            title,
          }),
        }),
        env,
      );
      assert.equal(ingest.status, 200);
    }

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      status.recent.events
        .filter((event: { event_type: string }) => event.event_type === "status.test")
        .map((event: { title: string }) => event.title)
        .sort(),
      ["Probe one", "Probe two"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard counts cluster-fixer operation events", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const events = [
      { event_type: "clawsweeper.replacement_label_cleanup", stage: "executed" },
      { event_type: "clawsweeper.clawsweeper_self_rebase", stage: "dispatched" },
      { event_type: "clawsweeper.dispatched_failed_review_retry", stage: "dispatched" },
      { event_type: "clawsweeper.marked_failed_review_retry_exhausted", stage: "exhausted" },
      { event_type: "clawsweeper.bot_proof_decision_posted", stage: "posted" },
      { event_type: "clawsweeper.bot_proof_mantis_request_posted", stage: "posted" },
    ];
    for (const event of events) {
      const ingest = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mode: "operation",
            status: "ok",
            ...event,
          }),
        }),
        env,
      );
      assert.equal(ingest.status, 200);
    }

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(status.recent.operation_counts, {
      inherited_label_cleanups: 1,
      self_heal_conflict_repairs: 1,
      failed_review_retries: 1,
      failed_review_retry_exhaustions: 1,
      bot_owned_proof_decisions_requested: 1,
      bot_owned_proof_dispatches: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard keeps workflow CI status when live PR checks fail", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            name: "ClawSweeper",
            display_title: "Review event item openclaw/openclaw#80609",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.includes("/repos/openclaw/openclaw/pulls/80609")) {
      return new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
    }
    if (url.includes("/search/issues")) return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].ci.state, "pending");
    assert.equal(status.pipeline[0].ci.source, "workflow");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reuses live PR CI hydration within one status snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = [
    {
      id: 8060901,
      name: "ClawSweeper",
      display_title: "Review event item openclaw/openclaw#80609",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/8060901",
      created_at: isoAgo(120_000),
      updated_at: isoAgo(10_000),
    },
    {
      id: 8060902,
      name: "ClawSweeper",
      display_title: "Review event item openclaw/openclaw#80609",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/8060902",
      created_at: isoAgo(90_000),
      updated_at: isoAgo(5_000),
    },
  ];
  let pullRequests = 0;
  let checkRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      return jsonResponse({ jobs: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/pulls/80609") {
      pullRequests += 1;
      return jsonResponse({ head: { sha: "head-80609" } });
    }
    if (url.pathname === "/repos/openclaw/openclaw/commits/head-80609/check-runs") {
      checkRequests += 1;
      return jsonResponse({
        check_runs: [
          {
            name: "test",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(pullRequests, 1);
    assert.equal(checkRequests, 1);
    assert.deepEqual(
      status.pipeline.map((row: { ci: { source: string; state: string } }) => row.ci),
      [
        {
          state: "green",
          head_sha: "head-80609",
          total: 1,
          failing: 0,
          pending: 0,
          source: "live",
        },
        {
          state: "green",
          head_sha: "head-80609",
          total: 1,
          failing: 0,
          pending: 0,
          source: "live",
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard counts active runs that are older than the latest unfiltered page", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (!status) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "recent completed run",
              display_title: "recent completed run",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
              created_at: "2026-05-14T06:40:00Z",
              updated_at: "2026-05-14T06:41:00Z",
            },
          ],
        });
      }
      if (status === "in_progress") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 2,
              name: "Review event item openclaw/openclaw#81001",
              display_title: "Review event item openclaw/openclaw#81001",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/2",
              created_at: isoAgo(25 * 60_000),
              updated_at: isoAgo(20 * 60_000),
            },
            {
              id: 3,
              name: "Commit review openclaw/openclaw@abc123",
              display_title: "Commit review openclaw/openclaw@abc123",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/3",
              created_at: isoAgo(20 * 60_000),
              updated_at: isoAgo(15 * 60_000),
            },
            {
              id: 5,
              name: "spam comment intake",
              display_title: "github_activity",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/5",
              created_at: isoAgo(18 * 60_000),
              updated_at: isoAgo(16 * 60_000),
            },
            {
              id: 6,
              name: "ClawSweeper Live Dashboard CI Status",
              display_title: "ClawSweeper Live Dashboard CI Status",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/6",
              created_at: isoAgo(17 * 60_000),
              updated_at: isoAgo(15 * 60_000),
            },
          ],
        });
      }
      if (status === "queued") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 4,
              name: "Review event item openclaw/openclaw#81002",
              display_title: "Review event item openclaw/openclaw#81002",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/4",
              created_at: isoAgo(30 * 60_000),
              updated_at: isoAgo(29 * 60_000),
            },
            {
              id: 7,
              name: "github activity to openclaw",
              display_title: "github_activity",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/7",
              created_at: isoAgo(31 * 60_000),
              updated_at: isoAgo(30 * 60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 3);
    assert.equal(status.fleet.queued_workflow_runs, 1);
    assert.equal(status.fleet.support_workflow_runs, 3);
    assert.equal(status.fleet.support_queued_workflow_runs, 1);
    assert.equal(status.fleet.worker_budget, 128);
    assert.deepEqual(
      status.pipeline.map((row: { id: number }) => row.id),
      [2, 4, 3],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard hides stale queue ghosts without suppressing queue health", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (!status) return jsonResponse({ workflow_runs: [] });
      if (status === "queued") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "ClawSweeper Commit Review",
              display_title: "clawsweeper_commit_review",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
              created_at: isoAgo(7 * 24 * 60 * 60_000),
              updated_at: isoAgo(7 * 24 * 60 * 60_000),
            },
            {
              id: 2,
              name: "Review event item openclaw/openclaw#81002",
              display_title: "Review event item openclaw/openclaw#81002",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/2",
              created_at: isoAgo(10 * 60_000),
              updated_at: isoAgo(9 * 60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 1);
    assert.equal(status.fleet.queued_workflow_runs, 1);
    assert.equal(status.operational_health.queued_runs, 2);
    assert.equal(status.operational_health.queued_over_threshold, 1);
    assert.equal(status.operational_health.status, "degraded");
    assert.deepEqual(
      status.pipeline.map((row: { id: number }) => row.id),
      [2],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard health retains in-progress runs beyond the queued ghost window", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { match: async () => undefined, put: async () => undefined } },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (status === "in_progress") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 8,
              name: "repair cluster worker",
              display_title: "repair cluster worker",
              status: "in_progress",
              created_at: isoAgo(8 * 60 * 60_000),
              run_started_at: isoAgo(7 * 60 * 60_000),
              updated_at: isoAgo(60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.operational_health.status, "stalled");
    assert.equal(status.operational_health.running_over_threshold, 1);
    assert.equal(status.operational_health.oldest_running_minutes, 420);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes ClawSweeper-owned recent closes and 24h stats", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const issuePages: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    const olderClosedAt = new Date(Date.now() - 120_000).toISOString();
    const oldestClosedAt = new Date(Date.now() - 180_000).toISOString();
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname === "/repos/openclaw/openclaw/issues" &&
      url.searchParams.get("page") === "1"
    ) {
      issuePages.push(url.searchParams.get("page") || "");
      return jsonResponse([
        {
          number: 81,
          title: "Fix stale terminal resize state",
          html_url: "https://github.com/openclaw/openclaw/pull/81",
          closed_at: olderClosedAt,
          closed_by: { login: "clawsweeper[bot]" },
          pull_request: {},
        },
        {
          number: 82,
          title: "Alternate app closed issue",
          html_url: "https://github.com/openclaw/openclaw/issues/82",
          closed_at: oldestClosedAt,
          closed_by: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          number: 80,
          title: "Remove old session warning",
          html_url: "https://github.com/openclaw/openclaw/issues/80",
          closed_at: closedAt,
          closed_by: { login: "clawsweeper[bot]" },
        },
        {
          number: 79,
          title: "Human closed issue",
          html_url: "https://github.com/openclaw/openclaw/issues/79",
          closed_at: closedAt,
          closed_by: { login: "steipete" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      issuePages.push(url.searchParams.get("page") || "");
      return jsonResponse([]);
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.item_closed",
          mode: "item_closed",
          stage: "close_duplicate",
          status: "executed",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/80",
          title: "Real close event",
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);
    const prClose = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.item_closed",
          mode: "item_closed",
          stage: "close_fixed_by_candidate",
          status: "executed",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/81",
          title: "Explicit PR close event",
        }),
      }),
      env,
    );
    assert.equal(prClose.status, 200);
    const blocked = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.close_blocked",
          mode: "close_blocked",
          stage: "close_duplicate",
          status: "blocked",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/82",
          title: "Blocked close event",
        }),
      }),
      env,
    );
    assert.equal(blocked.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      status.recent.closed_items.map(
        (item: { type: string; number: number; closed_by: string }) => ({
          type: item.type,
          number: item.number,
          closed_by: item.closed_by,
        }),
      ),
      [
        { type: "Issue", number: 80, closed_by: "clawsweeper[bot]" },
        { type: "PR", number: 81, closed_by: "clawsweeper[bot]" },
        { type: "Issue", number: 82, closed_by: "openclaw-clawsweeper[bot]" },
      ],
    );
    assert.deepEqual(
      status.recent.events.map(
        (event: {
          mode: string;
          stage: string;
          status: string;
          item_number: number;
          source: string;
          title: string;
        }) => ({
          mode: event.mode,
          stage: event.stage,
          status: event.status,
          item_number: event.item_number,
          source: event.source,
          title: event.title,
        }),
      ),
      [
        {
          mode: "close_blocked",
          stage: "close_duplicate",
          status: "blocked",
          item_number: undefined,
          source: undefined,
          title: "Blocked close event",
        },
        {
          mode: "item_closed",
          stage: "close_fixed_by_candidate",
          status: "executed",
          item_number: undefined,
          source: undefined,
          title: "Explicit PR close event",
        },
        {
          mode: "item_closed",
          stage: "close_duplicate",
          status: "executed",
          item_number: undefined,
          source: undefined,
          title: "Real close event",
        },
        {
          mode: "closed",
          stage: "Issue",
          status: "closed",
          item_number: 82,
          source: "closed_items",
          title: "Alternate app closed issue",
        },
      ],
    );
    assert.deepEqual(status.recent.closed_stats, {
      window_hours: 24,
      since: status.recent.closed_stats.since,
      total: 3,
      issues: 2,
      prs: 1,
      by_repository: {
        "openclaw/openclaw": {
          total: 3,
          issues: 2,
          prs: 1,
        },
      },
    });
    assert.ok(new Date(status.recent.closed_stats.since).getTime() <= Date.now());
    assert.deepEqual(issuePages, ["1"]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard fetches additional closed pages only when the first page is full", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const issuePages: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      const page = url.searchParams.get("page") || "";
      issuePages.push(page);
      if (page === "1") {
        return jsonResponse(
          Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            title: `Human closed issue ${index + 1}`,
            html_url: `https://github.com/openclaw/openclaw/issues/${index + 1}`,
            closed_at: closedAt,
            closed_by: { login: "steipete" },
          })),
        );
      }
      if (page === "2") {
        return jsonResponse([
          {
            number: 101,
            title: "ClawSweeper closed overflow page issue",
            html_url: "https://github.com/openclaw/openclaw/issues/101",
            closed_at: closedAt,
            closed_by: { login: "clawsweeper[bot]" },
          },
        ]);
      }
      return jsonResponse([]);
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      issuePages.sort((left, right) => Number(left) - Number(right)),
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    );
    assert.deepEqual(status.recent.closed_stats, {
      window_hours: 24,
      since: status.recent.closed_stats.since,
      total: 1,
      issues: 1,
      prs: 0,
      by_repository: {
        "openclaw/openclaw": {
          total: 1,
          issues: 1,
          prs: 0,
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused views use direct search when broad snapshot is capped", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let readyPerPage = "";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/openclaw/labels") {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        readyPerPage = url.searchParams.get("per_page") || "";
        return jsonResponse({
          total_count: 2,
          items: [
            triageIssue(102, ["clawsweeper:queueable-fix", "impact:message-loss"]),
            triageIssue(100, ["clawsweeper:queueable-fix"]),
          ],
        });
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 501,
          items:
            page === "1"
              ? [
                  triageIssue(102, ["clawsweeper:queueable-fix"]),
                  triageIssue(101, ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"]),
                ]
              : [],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    const root = snapshot.views.find((view: { id: string }) => view.id === "clawsweeper");
    const ready = snapshot.views.find((view: { id: string }) => view.id === "ready-candidates");
    assert.equal(root.item_limit, 500);
    assert.equal(ready.total_count, 2);
    assert.equal(ready.item_limit, 100);
    assert.equal(readyPerPage, "100");
    assert.deepEqual(
      ready.items.map((item: { number: number }) => item.number),
      [102, 100],
    );
    assert.deepEqual(
      ready.items[0].routing_groups.map((group: { id: string }) => group.id),
      ["message-delivery"],
    );
    assert.deepEqual(
      ready.items[1].routing_groups.map((group: { id: string }) => group.id),
      ["unclassified"],
    );
    assert.equal(ready.loaded_routing_group_counts["message-delivery"], 1);
    assert.equal(ready.loaded_routing_group_counts.unclassified, 1);
    assert.ok(snapshot.routing_groups.some((group: { id: string }) => group.id === "state-data"));
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused fallbacks reserve search budget for later repos", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let sawSecondRepoLastRootPage = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      const repo = query.includes("repo:openclaw/other") ? "openclaw/other" : "openclaw/openclaw";
      if (repo === "openclaw/other" && page === "4") {
        sawSecondRepoLastRootPage = true;
      }
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        return jsonResponse({
          total_count: 1,
          items: [triageIssue(repo, 200, ["clawsweeper:queueable-fix"])],
        });
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 401,
          items: [triageIssue(repo, Number(page), ["clawsweeper:queueable-fix"])],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: "openclaw/openclaw,openclaw/other",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.equal(sawSecondRepoLastRootPage, true);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused search errors fall back to loaded broad rows", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        throw new Error("focused search failed");
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 501,
          items:
            page === "1"
              ? [
                  triageIssue(102, ["clawsweeper:queueable-fix"]),
                  triageIssue(101, ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"]),
                ]
              : [],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    const ready = snapshot.views.find((view: { id: string }) => view.id === "ready-candidates");
    assert.equal(ready.total_count, 1);
    assert.deepEqual(
      ready.items.map((item: { number: number }) => item.number),
      [102],
    );
    assert.match(snapshot.diagnostics.errors.join("\n"), /focused search failed/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage skips repos after root search budget is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        total_count: 1,
        items: [triageIssue(searchRequests, ["clawsweeper:queueable-fix"])],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const repos = Array.from({ length: 10 }, (_, index) => `openclaw/repo-${index}`).join(",");
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: repos,
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.match(snapshot.diagnostics.errors.join("\n"), /repo-9 triage skipped/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage debits failed root searches from the search budget", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      throw new Error("root search failed");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const repos = Array.from({ length: 10 }, (_, index) => `openclaw/repo-${index}`).join(",");
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: repos,
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.match(snapshot.diagnostics.errors.join("\n"), /repo-9 triage skipped/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage uses ClawSweeper GitHub App credentials when no static token is configured", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let sawAppJwt = false;
  let sawInstallationToken = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = String(new Headers(init?.headers).get("authorization") || "");
    if (url.pathname === "/repos/openclaw/openclaw/installation") {
      sawAppJwt = authorization.startsWith("Bearer ");
      return jsonResponse({ id: 12345 });
    }
    if (url.pathname === "/app/installations/12345/access_tokens") {
      sawAppJwt = authorization.startsWith("Bearer ");
      return jsonResponse({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/labels") {
      sawInstallationToken = authorization === "Bearer installation-token";
      return jsonResponse([{ name: "clawsweeper:queueable-fix", color: "0E8A16" }]);
    }
    if (url.pathname === "/search/issues") {
      sawInstallationToken = authorization === "Bearer installation-token";
      return jsonResponse({
        total_count: 1,
        items: [triageIssue(101, ["clawsweeper:queueable-fix"])],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: String(privateKey),
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(response.status, 200);
    assert.equal(snapshot.source.search_request_budget_remaining, 27);
    assert.equal(sawAppJwt, true);
    assert.equal(sawInstallationToken, true);
    assert.doesNotMatch(snapshot.diagnostics.errors.join("\n"), /GITHUB_TOKEN/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("hosted webhook accepts author read-only mention commands", async () => {
  for (const body of [
    "@clawsweeper Re-run",
    "@clawsweeper\nre-review based on latest comments",
    "The issue may already be fixed.\n@clawsweeper re-review based on latest comments\nThanks.",
  ]) {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/openclaw",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 76991, user: { login: "contributor" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body,
            author_association: "CONTRIBUTOR",
            user: { login: "contributor" },
          },
        },
      }),
      { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
    );
    assert.equal(response.status, 503, `${body} should pass classification before app config`);
    assert.deepEqual(await response.json(), { error: "github_app_not_configured" });
  }
});

test("hosted webhook ignores inline ClawSweeper mentions before fast ack", async () => {
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "created",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 87801, user: { login: "issue-author" } },
        installation: { id: 123 },
        comment: {
          id: 456,
          body: "the closed PR 87835 was closed as already implemented by PR 87890 @clawsweeper re-review and if necessary close this issue",
          author_association: "MEMBER",
          user: { login: "brokemac79" },
        },
      },
    }),
    { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "no routable ClawSweeper command",
  });
});

test("hosted webhook returns invalid_json for signed malformed bodies", async () => {
  const response = await worker.fetch(
    signedGithubWebhookBodyRequest({
      event: "issue_comment",
      secret: "test-secret",
      body: "{",
    }),
    { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

test("hosted webhook rejects label additions before exact-review intake", async () => {
  for (const sender of ["openclaw-clawsweeper[bot]", "openclaw-barnacle[bot]", "steipete"]) {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issues",
        secret: "test-secret",
        payload: {
          action: "labeled",
          repository: {
            full_name: "openclaw/openclaw",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 76991 },
          installation: { id: 123 },
          label: { name: "status: ready for maintainer look" },
          sender: { login: sender },
        },
      }),
      { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: false,
      reason: "unsupported action",
    });
  }
});

test("hosted issue webhook enqueues without completing pull request authority", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  let authorityCompletionCalls = 0;
  const queueStub = {
    fetch(request: Request) {
      if (new URL(request.url).pathname === "/source-authority/complete") {
        authorityCompletionCalls += 1;
      }
      return queue.fetch(request);
    },
  };
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issues",
      secret: "test-secret",
      payload: {
        action: "opened",
        repository: {
          full_name: "openclaw/gogcli",
          default_branch: "trunk",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 597 },
        installation: { id: 123 },
      },
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queueStub),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/gogcli#597",
    superseded_publications: 0,
  });
  assert.equal(authorityCompletionCalls, 0);
});

test("hosted edited webhook binds and enqueues only the live pull request head", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const now = 3_000_000;
  Date.now = () => now;
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const staleHeadSha = "a".repeat(40);
  const sourceHeadSha = "b".repeat(40);
  const sourceContentRevision = createHash("sha256")
    .update(
      JSON.stringify({ version: 1, title: "Document the edit", body: "Fresh review context." }),
    )
    .digest("hex");
  let verificationCalls = 0;
  globalThis.fetch = async (input) => {
    verificationCalls += 1;
    assert.equal(String(input), "https://api.github.com/repos/openclaw/gogcli/pulls/596");
    return new Response(JSON.stringify({ head: { sha: sourceHeadSha } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const send = (headSha: string, updatedAt: string, deliveryId: string) =>
    worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId,
        payload: {
          action: "edited",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          pull_request: {
            number: 596,
            head: { sha: headSha },
            base: { sha: "c".repeat(40) },
            draft: false,
            title: "Document the edit",
            body: "Fresh review context.",
            updated_at: updatedAt,
          },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        GITHUB_TOKEN: "test-token",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );

  try {
    const response = await send(sourceHeadSha, "2026-07-23T13:00:02Z", "edited-current-596");
    assert.equal(response.status, 202);
    const duplicateResponse = await send(
      sourceHeadSha,
      "2026-07-23T13:00:02Z",
      "synchronize-current-596",
    );
    assert.deepEqual(await duplicateResponse.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#596",
      dedupe_scope: "semantic_edited",
      dedupe_reason: "unchanged_pull_request_edit",
    });
    assert.equal(verificationCalls, 2);
    const staleResponse = await send(staleHeadSha, "2026-07-23T13:00:01Z", "synchronize-stale-596");
    assert.equal(staleResponse.status, 202);
    assert.deepEqual(await staleResponse.json(), {
      ok: true,
      accepted: false,
      reason: "stale pull request head",
    });
    assert.equal(verificationCalls, 3);
    const staleDuplicateResponse = await send(
      staleHeadSha,
      "2026-07-23T13:00:01Z",
      "synchronize-stale-596",
    );
    assert.deepEqual(await staleDuplicateResponse.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#596",
    });
    assert.equal(verificationCalls, 3);
    assert.equal(storage.rawGet("exact-review-source-authority-sequence:v1"), 3);
    const stored = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          decision: {
            sourceHeadSha?: string;
            sourceHeadVerified?: boolean;
            sourceAuthoritySeq?: number;
            sourceUpdatedAt?: string;
          };
        }
      >;
    };
    assert.deepEqual(stored.items["openclaw/gogcli#596"].decision, {
      targetRepo: "openclaw/gogcli",
      targetBranch: "trunk",
      itemNumber: 596,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "edited",
      supersedesInProgress: true,
      sourceHeadSha,
      sourceBaseSha: "c".repeat(40),
      sourceIsDraft: false,
      sourceContentRevision,
      sourceHeadVerified: true,
      sourceAuthoritySeq: 1,
      sourceUpdatedAt: "2026-07-23T13:00:02Z",
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("hosted pull request verification preserves ingress through a transient failure and queue restart", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 3_500_000;
  Date.now = () => now;
  const storage = new MemoryDurableStorage();
  const sourceHeadSha = "c".repeat(40);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const queueEnv = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
  };
  const queue = new ExactReviewQueue({ storage }, queueEnv);
  let verificationFailures = 2;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/gogcli/pulls/595") {
      if (verificationFailures > 0) {
        verificationFailures -= 1;
        throw new Error("transient GitHub failure");
      }
      return jsonResponse({ head: { sha: sourceHeadSha } });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        payload: {
          action: "synchronize",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          pull_request: {
            number: 595,
            head: { sha: sourceHeadSha },
            updated_at: "2026-07-23T13:00:02Z",
          },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        GITHUB_TOKEN: "test-token",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: true,
      deferred: true,
      reason: "pull request head verification deferred",
    });
    assert.equal(
      storage.rawHas("exact-review-source-authority-reservation:v1:test-delivery"),
      true,
    );
    const fallbackFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/gogcli",
          item_number: 595,
          action: "synchronize",
          head_sha: sourceHeadSha,
          updated_at: "2026-07-23T13:00:02Z",
          body: "",
          label: "",
        }),
      )
      .digest("hex");
    const fallback = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-after-deferred-direct",
        595,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: fallbackFingerprint } },
      ),
    );
    assert.equal((await fallback.json()).queued, true);

    const restarted = new ExactReviewQueue({ storage }, queueEnv);
    await restarted.alarm();
    const deferred = storage.rawGet(
      "exact-review-source-authority-reservation:v1:test-delivery",
    ) as {
      attempts: number;
      nextAttemptAt: number;
      sourceAuthoritySeq: number;
    };
    assert.equal(deferred.attempts, 1);
    assert.equal(deferred.sourceAuthoritySeq, 1);
    assert.equal(deferred.nextAttemptAt, now + 15_000);
    assert.equal(await storage.getAlarm(), deferred.nextAttemptAt);

    now = deferred.nextAttemptAt;
    await restarted.alarm();
    const stored = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          revision: number;
          decision: {
            sourceHeadSha?: string;
            sourceHeadVerified?: boolean;
            sourceAuthoritySeq?: number;
          };
        }
      >;
    };
    assert.equal(stored.items["openclaw/gogcli#595"].revision, 2);
    assert.equal(stored.items["openclaw/gogcli#595"].decision.sourceHeadSha, sourceHeadSha);
    assert.equal(stored.items["openclaw/gogcli#595"].decision.sourceHeadVerified, true);
    assert.equal(stored.items["openclaw/gogcli#595"].decision.sourceAuthoritySeq, 1);
    assert.equal(
      storage.rawHas("exact-review-source-authority-reservation:v1:test-delivery"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("hosted reopened webhook advances to its verified current head", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const previousHeadSha = "d".repeat(40);
  const sourceHeadSha = "e".repeat(40);
  const existing = leasedExactReviewQueueItem(594, "5940");
  existing.decision.itemKind = "pull_request";
  existing.decision.sourceEvent = "pull_request";
  existing.decision.sourceHeadSha = previousHeadSha;
  existing.leaseDecision.itemKind = "pull_request";
  existing.leaseDecision.sourceEvent = "pull_request";
  existing.leaseDecision.sourceHeadSha = previousHeadSha;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/gogcli#594": existing },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://api.github.com/repos/openclaw/gogcli/pulls/594");
    return jsonResponse({ head: { sha: sourceHeadSha } });
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        payload: {
          action: "reopened",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          pull_request: {
            number: 594,
            head: { sha: sourceHeadSha },
            updated_at: "2026-07-23T13:00:03Z",
          },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        GITHUB_TOKEN: "test-token",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );
    assert.equal(response.status, 202);
    const stored = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string; sourceHeadSha?: string } }>;
    };
    assert.equal(stored.items["openclaw/gogcli#594"].decision.sourceAction, "reopened");
    assert.equal(stored.items["openclaw/gogcli#594"].decision.sourceHeadSha, sourceHeadSha);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue drops a delayed matching ingress after the first review completes", async () => {
  const sourceHeadSha = "f".repeat(40);
  const fingerprint = "e".repeat(64);
  const harness = createExactReviewAdmissionHarness(() =>
    jsonResponse({ state: "open", head: { sha: sourceHeadSha } }),
  );

  try {
    const direct = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "completed-direct-ingress",
        601,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 1,
          sourceUpdatedAt: "2026-07-23T13:00:02Z",
        },
        { ingress: { route: "direct_webhook", fingerprint } },
      ),
    );
    assert.equal((await direct.json()).queued, true);

    await harness.queue.alarm();
    const dispatched = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const item = dispatched.items["openclaw/gogcli#601"];
    assert.ok(item);
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#601",
          lease_revision: item.leaseRevision,
          run_id: "6010",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(claim.status, 200);
    const claimed = (await claim.json()) as { claim_generation: number };
    const completed = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#601",
          lease_revision: item.leaseRevision,
          claim_generation: claimed.claim_generation,
          run_id: "6010",
          run_attempt: 1,
          outcome: "success",
        }),
      }),
    );
    assert.deepEqual(await completed.json(), { ok: true, requeued: false });

    const fallback = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "delayed-fallback-ingress",
        601,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint } },
      ),
    );
    assert.deepEqual(await fallback.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#601",
      dedupe_scope: "cross_route",
    });
    const afterFallback = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(afterFallback.items["openclaw/gogcli#601"], undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review queue upgrades ingress receipts with admission tracking", async () => {
  const storage = new MemoryDurableStorage();
  const receivedAt = Date.now();
  storage.sql.exec(`CREATE TABLE exact_review_queue_ingress (
    fingerprint TEXT NOT NULL,
    route TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (fingerprint, route)
  ) STRICT`);
  storage.sql.exec(
    `INSERT INTO exact_review_queue_ingress (fingerprint, route, target_branch, received_at)
     VALUES (?, ?, ?, ?)`,
    "f".repeat(64),
    "direct_webhook",
    "trunk",
    receivedAt,
  );
  const queue = new ExactReviewQueue({ storage }, {});

  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const columns = Array.from(
    storage.sql.exec(`SELECT name FROM pragma_table_info('exact_review_queue_ingress')`),
  ) as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "admitted_at"));
  const migrated = Array.from(
    storage.sql.exec(
      `SELECT admitted_at FROM exact_review_queue_ingress
        WHERE fingerprint = ? AND route = 'direct_webhook'`,
      "f".repeat(64),
    ),
  )[0] as { admitted_at: number };
  assert.equal(migrated.admitted_at, receivedAt);
  const delayedFallback = await queue.fetch(
    buildExactReviewQueueRequest(
      "legacy-after-upgrade",
      601,
      "synchronize",
      "pull_request",
      "openclaw/gogcli",
      { targetBranch: "trunk" },
      { ingress: { route: "target_dispatcher", fingerprint: "f".repeat(64) } },
    ),
  );
  assert.deepEqual(await delayedFallback.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#601",
    dedupe_scope: "cross_route",
  });
});

test("exact-review queue re-upgrade admits a direct receipt written by a rollback", async () => {
  const storage = new MemoryDurableStorage();
  const firstUpgrade = new ExactReviewQueue({ storage }, {});
  await firstUpgrade.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const receivedAt = Date.now();
  storage.sql.exec(
    `INSERT INTO exact_review_queue_ingress
     (fingerprint, route, target_branch, received_at, admitted_at)
     VALUES (?, ?, ?, ?, NULL)`,
    "9".repeat(64),
    "direct_webhook",
    "trunk",
    receivedAt,
  );

  const reupgraded = new ExactReviewQueue({ storage }, {});
  const migrated = Array.from(
    storage.sql.exec(
      `SELECT admitted_at FROM exact_review_queue_ingress
        WHERE fingerprint = ? AND route = 'direct_webhook'`,
      "9".repeat(64),
    ),
  )[0] as { admitted_at: number };
  assert.equal(migrated.admitted_at, receivedAt);
  const delayedFallback = await reupgraded.fetch(
    buildExactReviewQueueRequest(
      "fallback-after-reupgrade",
      605,
      "synchronize",
      "pull_request",
      "openclaw/gogcli",
      { targetBranch: "trunk" },
      { ingress: { route: "target_dispatcher", fingerprint: "9".repeat(64) } },
    ),
  );
  assert.deepEqual(await delayedFallback.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#605",
    dedupe_scope: "cross_route",
  });
});

test("unadmitted fallback receipts do not suppress a later verified direct event", async () => {
  const firstHeadSha = "a".repeat(40);
  const secondHeadSha = "b".repeat(40);
  const firstFingerprint = "a".repeat(64);
  const secondFingerprint = "b".repeat(64);
  const harness = createExactReviewAdmissionHarness(() =>
    jsonResponse({ state: "open", head: { sha: firstHeadSha } }),
  );

  try {
    await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "verified-first",
        602,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha: firstHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 1,
          sourceUpdatedAt: "2026-07-23T13:00:02Z",
        },
        { ingress: { route: "direct_webhook", fingerprint: firstFingerprint } },
      ),
    );
    const staleFallback = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "stale-fallback-second",
        602,
        "edited",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: secondFingerprint } },
      ),
    );
    assert.deepEqual(await staleFallback.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#602",
      stale_source: true,
    });

    await harness.queue.alarm();
    const dispatched = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const item = dispatched.items["openclaw/gogcli#602"];
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#602",
          lease_revision: item.leaseRevision,
          run_id: "6020",
          run_attempt: 1,
        }),
      }),
    );
    const claimed = (await claim.json()) as { claim_generation: number };
    const completed = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#602",
          lease_revision: item.leaseRevision,
          claim_generation: claimed.claim_generation,
          run_id: "6020",
          run_attempt: 1,
          outcome: "success",
        }),
      }),
    );
    assert.deepEqual(await completed.json(), { ok: true, requeued: false });

    const verifiedSecond = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "verified-second",
        602,
        "edited",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha: secondHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 2,
          sourceUpdatedAt: "2026-07-23T13:01:02Z",
        },
        { ingress: { route: "direct_webhook", fingerprint: secondFingerprint } },
      ),
    );
    assert.equal((await verifiedSecond.json()).queued, true);
    const afterDirect = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string; sourceHeadSha?: string } }>;
    };
    assert.equal(afterDirect.items["openclaw/gogcli#602"].decision.sourceAction, "edited");
    assert.equal(afterDirect.items["openclaw/gogcli#602"].decision.sourceHeadSha, secondHeadSha);
  } finally {
    harness.restore();
  }
});

test("a delayed counterpart cannot replace a newer admitted fallback", async () => {
  const firstFingerprint = "c".repeat(64);
  const secondFingerprint = "d".repeat(64);
  const firstHeadSha = "c".repeat(40);
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }));

  try {
    await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "fallback-first-complete",
        603,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: firstFingerprint } },
      ),
    );
    await harness.queue.alarm();
    const dispatched = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const item = dispatched.items["openclaw/gogcli#603"];
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#603",
          lease_revision: item.leaseRevision,
          run_id: "6030",
          run_attempt: 1,
        }),
      }),
    );
    const claimed = (await claim.json()) as { claim_generation: number };
    await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#603",
          lease_revision: item.leaseRevision,
          claim_generation: claimed.claim_generation,
          run_id: "6030",
          run_attempt: 1,
          outcome: "success",
        }),
      }),
    );
    const newerFallback = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "fallback-second-pending",
        603,
        "edited",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: secondFingerprint } },
      ),
    );
    assert.equal((await newerFallback.json()).queued, true);

    const delayedDirect = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "delayed-direct-first",
        603,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha: firstHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 1,
          sourceUpdatedAt: "2026-07-23T13:00:02Z",
        },
        { ingress: { route: "direct_webhook", fingerprint: firstFingerprint } },
      ),
    );
    assert.deepEqual(await delayedDirect.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#603",
      dedupe_scope: "cross_route",
    });
    const afterDelayed = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string } }>;
    };
    assert.equal(afterDelayed.items["openclaw/gogcli#603"].decision.sourceAction, "edited");
  } finally {
    harness.restore();
  }
});

test("a delayed direct ingress cannot promote across a newer legacy-only update", async () => {
  const firstFingerprint = "e".repeat(64);
  const firstHeadSha = "e".repeat(40);
  const secondHeadSha = "f".repeat(40);
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }));

  try {
    const fallback = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "fallback-before-legacy-update",
        604,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: firstFingerprint } },
      ),
    );
    assert.equal((await fallback.json()).queued, true);

    const legacyUpdate = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-only-newer-update",
        604,
        "edited",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha: secondHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 2,
        },
      ),
    );
    assert.equal((await legacyUpdate.json()).queued, true);

    const delayedDirect = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "delayed-direct-before-legacy-update",
        604,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha: firstHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 3,
        },
        { ingress: { route: "direct_webhook", fingerprint: firstFingerprint } },
      ),
    );
    assert.deepEqual(await delayedDirect.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#604",
      dedupe_scope: "cross_route",
    });
    const afterDelayed = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string }; ingressFingerprint?: string }>;
    };
    assert.equal(afterDelayed.items["openclaw/gogcli#604"].decision.sourceAction, "edited");
    assert.equal(afterDelayed.items["openclaw/gogcli#604"].ingressFingerprint, undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review queue coalesces matching ingress and promotes verified direct authority", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    GITHUB_TOKEN: "test-token",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const repository = {
    full_name: "openclaw/gogcli",
    default_branch: "trunk",
    private: false,
    archived: false,
    fork: false,
    has_issues: true,
  };
  const pullRequest = {
    number: 597,
    head: { sha: "a".repeat(40) },
    updated_at: "2026-07-19T10:19:00Z",
    body: "Add durable proof.",
  };
  const originalFetch = globalThis.fetch;
  const liveHeads = new Map([
    [597, "a".repeat(40)],
    [599, "c".repeat(40)],
    [600, "d".repeat(40)],
  ]);
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const match = url.pathname.match(/^\/repos\/openclaw\/gogcli\/pulls\/(\d+)$/);
    assert.ok(match);
    const head = liveHeads.get(Number(match[1]));
    assert.ok(head);
    return jsonResponse({ head: { sha: head } });
  };

  try {
    const direct = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId: "direct-pr-delivery",
        payload: {
          action: "synchronize",
          repository,
          pull_request: pullRequest,
          installation: { id: 123 },
        },
      }),
      env,
    );
    assert.deepEqual(await direct.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#597",
      superseded_publications: 0,
    });
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/gogcli",
          item_number: 597,
          action: "synchronize",
          head_sha: "a".repeat(40),
          updated_at: "2026-07-19T10:19:00Z",
          body: "Add durable proof.",
          label: "",
        }),
      )
      .digest("hex");
    const fallback = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-pr-delivery",
        597,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint } },
      ),
    );
    assert.deepEqual(await fallback.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#597",
      dedupe_scope: "cross_route",
    });

    const fallbackFirstFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/gogcli",
          item_number: 599,
          action: "synchronize",
          head_sha: "c".repeat(40),
          updated_at: "2026-07-19T10:21:00Z",
          body: "Fallback arrived first.",
          label: "",
        }),
      )
      .digest("hex");
    const fallbackFirst = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-first-delivery",
        599,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: fallbackFirstFingerprint } },
      ),
    );
    assert.deepEqual(await fallbackFirst.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#599",
      superseded_publications: 0,
    });
    const directSecond = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId: "direct-after-legacy-delivery",
        payload: {
          action: "synchronize",
          repository,
          pull_request: {
            number: 599,
            head: { sha: "c".repeat(40) },
            updated_at: "2026-07-19T10:21:00Z",
            body: "Fallback arrived first.",
          },
          installation: { id: 123 },
        },
      }),
      env,
    );
    assert.deepEqual(await directSecond.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#599",
      superseded_publications: 0,
    });

    const branchChangeFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/gogcli",
          item_number: 600,
          action: "synchronize",
          head_sha: "d".repeat(40),
          updated_at: "2026-07-19T10:22:00Z",
          body: "The default branch changed.",
          label: "",
        }),
      )
      .digest("hex");
    const directBeforeBranchChange = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId: "direct-old-default-branch-delivery",
        payload: {
          action: "synchronize",
          repository: { ...repository, default_branch: "old-default" },
          pull_request: {
            number: 600,
            head: { sha: "d".repeat(40) },
            updated_at: "2026-07-19T10:22:00Z",
            body: "The default branch changed.",
          },
          installation: { id: 123 },
        },
      }),
      env,
    );
    assert.deepEqual(await directBeforeBranchChange.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#600",
      superseded_publications: 0,
    });
    const fallbackAfterBranchChange = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-new-default-branch-delivery",
        600,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "new-default" },
        { ingress: { route: "target_dispatcher", fingerprint: branchChangeFingerprint } },
      ),
    );
    assert.deepEqual(await fallbackAfterBranchChange.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#600",
      stale_source: true,
    });

    const legacyOnly = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-only-delivery",
        598,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: "b".repeat(64) } },
      ),
    );
    assert.deepEqual(await legacyOnly.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#598",
      superseded_publications: 0,
    });

    const bodyUpdate = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId: "direct-pr-body-update",
        payload: {
          action: "edited",
          repository,
          pull_request: {
            ...pullRequest,
            updated_at: "2026-07-19T10:20:00Z",
            body: "Add revised durable proof.",
          },
          installation: { id: 123 },
        },
      }),
      env,
    );
    assert.deepEqual(await bodyUpdate.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#597",
      superseded_publications: 0,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          revision: number;
          decision: {
            sourceAction: string;
            targetBranch: string;
            sourceHeadSha?: string;
            sourceHeadVerified?: boolean;
            sourceAuthoritySeq?: number;
          };
        }
      >;
    };
    assert.equal(state.items["openclaw/gogcli#597"].revision, 2);
    assert.equal(state.items["openclaw/gogcli#597"].decision.sourceAction, "edited");
    assert.equal(state.items["openclaw/gogcli#599"].revision, 2);
    assert.equal(state.items["openclaw/gogcli#599"].decision.sourceHeadSha, "c".repeat(40));
    assert.equal(state.items["openclaw/gogcli#599"].decision.sourceHeadVerified, true);
    assert.ok(state.items["openclaw/gogcli#599"].decision.sourceAuthoritySeq);
    // A compatibility fallback may be legacy-only, but it cannot replace a
    // source-head-verified direct decision merely because its branch resolves differently.
    assert.equal(state.items["openclaw/gogcli#600"].revision, 1);
    assert.equal(state.items["openclaw/gogcli#600"].decision.targetBranch, "old-default");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook requeues unlocked and close-guard removal events", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ head: { sha: "e".repeat(40) } });
  const closeGuardLabels = [
    "security",
    "beta-blocker",
    "release-blocker",
    "maintainer",
    "clawsweeper:human-review",
    "clawsweeper:manual-only",
    "clawsweeper:automerge",
    "clawsweeper:autofix",
  ];
  const cases = [
    { event: "issues", action: "unlocked" },
    { event: "pull_request", action: "unlocked" },
    ...closeGuardLabels.flatMap((name) => [
      { event: "issues", action: "unlabeled", label: { name } },
      { event: "pull_request", action: "unlabeled", label: { name } },
    ]),
  ];
  try {
    for (const [index, { event, action, label }] of cases.entries()) {
      const number = 598 + index;
      const storage = new MemoryDurableStorage();
      const queue = new ExactReviewQueue({ storage }, {});
      const response = await worker.fetch(
        signedGithubWebhookRequest({
          event,
          secret: "test-secret",
          payload: {
            action,
            repository: {
              full_name: "openclaw/gogcli",
              default_branch: "trunk",
              private: false,
              archived: false,
              fork: false,
              has_issues: true,
            },
            ...(event === "issues"
              ? { issue: { number } }
              : { pull_request: { number, head: { sha: "e".repeat(40) } } }),
            ...(label ? { label } : {}),
            installation: { id: 123 },
          },
        }),
        {
          CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
          GITHUB_TOKEN: "test-token",
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
        },
      );

      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), {
        ok: true,
        queued: true,
        item_key: `openclaw/gogcli#${number}`,
        superseded_publications: 0,
      });
      const stored = (await storage.get("exact-review-queue")) as {
        items: Record<
          string,
          {
            decision: {
              sourceAction: string;
              supersedesInProgress: boolean;
              sourceHeadSha?: string;
            };
          }
        >;
      };
      assert.equal(stored.items[`openclaw/gogcli#${number}`].decision.sourceAction, action);
      assert.equal(stored.items[`openclaw/gogcli#${number}`].decision.supersedesInProgress, true);
      if (event === "pull_request") {
        assert.equal(
          stored.items[`openclaw/gogcli#${number}`].decision.sourceHeadSha,
          "e".repeat(40),
        );
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook ignores removal of non-close-guard labels", async () => {
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issues",
      secret: "test-secret",
      payload: {
        action: "unlabeled",
        repository: {
          full_name: "openclaw/gogcli",
          default_branch: "trunk",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 602 },
        label: { name: "clawsweeper:queueable-fix" },
        installation: { id: 123 },
      },
    }),
    { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "unsupported action",
  });
});

test("hosted pull request receipt fast acks precede verification and stay idempotent", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  type AckComment = {
    id: number;
    body: string;
    created_at: string;
    user: { login: string };
  };
  const comments = new Map<number, AckComment[]>();
  const waitUntilPromises: Promise<unknown>[] = [];
  const fastAckPostAttempts = new Map<number, number>();
  const repository = {
    full_name: "openclaw/gogcli",
    default_branch: "trunk",
    private: false,
    archived: false,
    fork: false,
    has_issues: true,
  };
  const openedPullRequest = {
    number: 597,
    head: { sha: "a".repeat(40) },
    updated_at: "2026-08-08T12:00:00Z",
    body: "Ready for review.",
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        target_repo: "openclaw/gogcli",
        item_number: 597,
        action: "opened",
        head_sha: "a".repeat(40),
        updated_at: "2026-08-08T12:00:00Z",
        body: "Ready for review.",
        label: "",
      }),
    )
    .digest("hex");

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations/123/access_tokens") {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        repositories: ["gogcli"],
        permissions: { issues: "write", pull_requests: "write" },
      });
      return jsonResponse({ token: "target-token" });
    }
    const pullMatch = /^\/repos\/openclaw\/gogcli\/pulls\/(\d+)$/.exec(url.pathname);
    if (pullMatch) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer verification-token");
      const itemNumber = Number(pullMatch[1]);
      if (itemNumber === 599) throw new Error("transient GitHub verification failure");
      return jsonResponse({
        head: {
          sha:
            itemNumber === 597
              ? "a".repeat(40)
              : itemNumber === 598
                ? "b".repeat(40)
                : itemNumber === 600
                  ? "e".repeat(40)
                  : "f".repeat(40),
        },
      });
    }
    const commentMatch = /^\/repos\/openclaw\/gogcli\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentMatch && init?.method === "GET") {
      return jsonResponse([...(comments.get(Number(commentMatch[1])) || [])]);
    }
    if (commentMatch && init?.method === "POST") {
      const itemNumber = Number(commentMatch[1]);
      fastAckPostAttempts.set(itemNumber, (fastAckPostAttempts.get(itemNumber) || 0) + 1);
      if (itemNumber === 601) {
        return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(init.body || "{}"));
      const comment = {
        id: 9000 + itemNumber,
        body: String(body.body || ""),
        created_at: "2026-08-08T12:00:01Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      };
      comments.set(itemNumber, [...(comments.get(itemNumber) || []), comment]);
      return jsonResponse(comment);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const env = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
    GITHUB_TOKEN: "verification-token",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const context = {
    waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
  };
  const send = (deliveryId: string, action: string, pullRequest = openedPullRequest) =>
    worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId,
        payload: {
          action,
          repository,
          pull_request: pullRequest,
          installation: { id: 123 },
        },
      }),
      env,
      context,
    );

  try {
    const fallback = await queue.fetch(
      buildExactReviewQueueRequest(
        "dispatcher-opened",
        597,
        "opened",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint } },
      ),
    );
    assert.equal((await fallback.json()).queued, true);

    assert.equal((await send("app-opened-1", "opened")).status, 202);
    assert.equal((await send("app-opened-2", "opened")).status, 202);
    assert.equal(fastAckPostAttempts.get(597), 1);
    assert.equal(comments.get(597)?.length, 1);
    assert.equal(
      comments.get(597)?.[0]?.body,
      [
        "<!-- clawsweeper-pr-ack:opened item=597 -->",
        "🦞👀",
        "ClawSweeper picked this up.",
        "",
        "Pull request received. I will update this pull request when review starts.",
      ].join("\n"),
    );
    assert.doesNotMatch(comments.get(597)?.[0]?.body || "", /clawsweeper-command-ack:/);
    assert.doesNotMatch(comments.get(597)?.[0]?.body || "", /clawsweeper-review-status:started/);
    assert.doesNotMatch(
      comments.get(597)?.[0]?.body || "",
      /^ClawSweeper status: review started\./,
    );

    assert.equal(
      (
        await send("app-synchronize", "synchronize", {
          number: 598,
          head: { sha: "b".repeat(40) },
          updated_at: "2026-08-08T12:01:00Z",
          body: "Follow-up push.",
        })
      ).status,
      202,
    );
    assert.equal(fastAckPostAttempts.has(598), false);
    assert.equal(comments.has(598), false);

    const deferred = await send("app-opened-deferred", "opened", {
      number: 599,
      head: { sha: "c".repeat(40) },
      updated_at: "2026-08-08T12:02:00Z",
      body: "Verification will be retried.",
    });
    assert.deepEqual(await deferred.json(), {
      ok: true,
      accepted: true,
      deferred: true,
      reason: "pull request head verification deferred",
    });
    assert.equal(fastAckPostAttempts.get(599), 1);
    assert.equal(comments.get(599)?.length, 1);

    const stale = await send("app-ready-stale", "ready_for_review", {
      number: 600,
      head: { sha: "d".repeat(40) },
      updated_at: "2026-08-08T12:03:00Z",
      body: "The webhook head is already stale.",
    });
    assert.deepEqual(await stale.json(), {
      ok: true,
      accepted: false,
      reason: "stale pull request head",
    });
    assert.equal(fastAckPostAttempts.get(600), 1);
    assert.equal(comments.get(600)?.length, 1);
    assert.match(comments.get(600)?.[0]?.body || "", /clawsweeper-pr-ack:ready_for_review/);

    const ackFailure = await send("app-opened-ack-failure", "opened", {
      number: 601,
      head: { sha: "f".repeat(40) },
      updated_at: "2026-08-08T12:04:00Z",
      body: "The ack write fails, but enqueue continues.",
    });
    assert.equal(ackFailure.status, 202);
    assert.equal((await ackFailure.json()).queued, true);
    assert.equal(fastAckPostAttempts.get(601), 1);
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted pull request receipts dedupe across opened and ready_for_review", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  type AckComment = {
    id: number;
    body: string;
    created_at: string;
    user: { login: string };
  };
  const comments = new Map<number, AckComment[]>();
  const waitUntilPromises: Promise<unknown>[] = [];
  const fastAckPostAttempts = new Map<number, number>();
  const deletedCommentIds: number[] = [];
  const repository = {
    full_name: "openclaw/gogcli",
    default_branch: "trunk",
    private: false,
    archived: false,
    fork: false,
    has_issues: true,
  };
  const pullRequestFastAckBody = (itemNumber: number, sourceAction: string) =>
    [
      `<!-- clawsweeper-pr-ack:${sourceAction} item=${itemNumber} -->`,
      "🦞👀",
      "ClawSweeper picked this up.",
      "",
      "Pull request received. I will update this pull request when review starts.",
    ].join("\n");

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    const pullMatch = /^\/repos\/openclaw\/gogcli\/pulls\/(\d+)$/.exec(url.pathname);
    if (pullMatch) {
      return jsonResponse({
        head: { sha: Number(pullMatch[1]) === 640 ? "9".repeat(40) : "8".repeat(40) },
      });
    }
    const commentsMatch = /^\/repos\/openclaw\/gogcli\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentsMatch && init?.method === "GET") {
      return jsonResponse([...(comments.get(Number(commentsMatch[1])) || [])]);
    }
    if (commentsMatch && init?.method === "POST") {
      const itemNumber = Number(commentsMatch[1]);
      fastAckPostAttempts.set(itemNumber, (fastAckPostAttempts.get(itemNumber) || 0) + 1);
      const body = JSON.parse(String(init.body || "{}"));
      const comment = {
        id: 9000 + itemNumber + (comments.get(itemNumber)?.length || 0),
        body: String(body.body || ""),
        created_at: "2026-08-09T12:00:01Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      };
      comments.set(itemNumber, [...(comments.get(itemNumber) || []), comment]);
      return jsonResponse(comment);
    }
    const deleteMatch = /^\/repos\/openclaw\/gogcli\/issues\/comments\/(\d+)$/.exec(url.pathname);
    if (deleteMatch && init?.method === "DELETE") {
      const commentId = Number(deleteMatch[1]);
      deletedCommentIds.push(commentId);
      for (const [itemNumber, list] of comments) {
        comments.set(
          itemNumber,
          list.filter((comment) => comment.id !== commentId),
        );
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const env = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
    GITHUB_TOKEN: "verification-token",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const context = {
    waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
  };
  const send = (
    deliveryId: string,
    action: string,
    pullRequest: { number: number; head: { sha: string }; updated_at: string; body: string },
  ) =>
    worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId,
        payload: {
          action,
          repository,
          pull_request: pullRequest,
          installation: { id: 123 },
        },
      }),
      env,
      context,
    );

  try {
    // A ready_for_review arriving seconds after opened must reuse the opened
    // receipt instead of posting a second, action-suffixed duplicate.
    const opened = {
      number: 640,
      head: { sha: "9".repeat(40) },
      updated_at: "2026-08-09T12:00:00Z",
      body: "Opened, then marked ready seconds later.",
    };
    assert.equal((await send("pr-ack-dual-opened", "opened", opened)).status, 202);
    assert.equal(fastAckPostAttempts.get(640), 1);
    assert.equal(
      (
        await send("pr-ack-dual-ready", "ready_for_review", {
          ...opened,
          updated_at: "2026-08-09T12:00:05Z",
        })
      ).status,
      202,
    );
    assert.equal(fastAckPostAttempts.get(640), 1);
    assert.equal(comments.get(640)?.length, 1);
    assert.match(comments.get(640)?.[0]?.body || "", /clawsweeper-pr-ack:opened item=640/);

    // A pair that already slipped through settles down to the earliest receipt.
    comments.set(641, [
      {
        id: 9100,
        body: pullRequestFastAckBody(641, "opened"),
        created_at: "2026-08-09T12:01:01Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      },
      {
        id: 9101,
        body: pullRequestFastAckBody(641, "ready_for_review"),
        created_at: "2026-08-09T12:01:03Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      },
    ]);
    assert.equal(
      (
        await send("pr-ack-settle-ready", "ready_for_review", {
          number: 641,
          head: { sha: "8".repeat(40) },
          updated_at: "2026-08-09T12:01:10Z",
          body: "Duplicate receipts already exist.",
        })
      ).status,
      202,
    );
    assert.equal(fastAckPostAttempts.has(641), false);
    assert.deepEqual(deletedCommentIds, [9101]);
    assert.equal(comments.get(641)?.length, 1);
    assert.equal(comments.get(641)?.[0]?.id, 9100);
    assert.match(comments.get(641)?.[0]?.body || "", /clawsweeper-pr-ack:opened item=641/);
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook reuses existing fast ack comments on redelivery", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchBody: unknown = null;
  let postedAck = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      assert.equal(authorization, "Bearer target-token");
      assert.equal(url.searchParams.get("per_page"), "100");
      return jsonResponse([
        {
          id: 777,
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "POST") {
      postedAck = true;
      return jsonResponse({ id: 888 });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      assert.equal(authorization, "Bearer target-token");
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      assert.equal(authorization, "Bearer dispatch-token");
      dispatchBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 597, user: { login: "steipete" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body: "@clawsweeper review",
            updated_at: "2026-07-12T20:00:00Z",
            author_association: "OWNER",
            user: { login: "steipete" },
          },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
        STATUS_STORE: new MemoryKv(),
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(postedAck, false);
    assert.deepEqual(dispatchBody, {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: "openclaw/gogcli",
        target_branch: "trunk",
        item_number: 597,
        comment_id: 456,
        status_comment_id: 777,
        source_action: "created",
        source_delivery_id: "test-delivery",
        comment_event_auth: "github_webhook_v1",
        comment_updated_at: "2026-07-12T20:00:00Z",
        comment_body_sha256: createHash("sha256").update("@clawsweeper review").digest("hex"),
      },
    });
    assert.ok(
      Object.keys((dispatchBody as { client_payload: Record<string, unknown> }).client_payload)
        .length <= 10,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook coalesces concurrent duplicate fast ack comments", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const comments: Array<{ id: number; body: string; created_at: string; user: { login: string } }> =
    [];
  const dispatchBodies: unknown[] = [];
  let fastAckPosts = 0;
  let reactions = 0;
  let releaseAckPost: (() => void) | undefined;
  let markAckPostStarted: (() => void) | undefined;
  const ackPostRelease = new Promise<void>((resolve) => {
    releaseAckPost = resolve;
  });
  const ackPostStarted = new Promise<void>((resolve) => {
    markAckPostStarted = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      assert.equal(authorization, "Bearer target-token");
      return jsonResponse([...comments]);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "POST") {
      assert.equal(authorization, "Bearer target-token");
      fastAckPosts += 1;
      markAckPostStarted?.();
      await ackPostRelease;
      const body = JSON.parse(String(init.body || "{}"));
      const comment = {
        id: 777,
        body: String(body.body || ""),
        created_at: "2026-05-28T13:00:00Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      };
      comments.push(comment);
      return jsonResponse(comment);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      assert.equal(authorization, "Bearer target-token");
      reactions += 1;
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      assert.equal(authorization, "Bearer dispatch-token");
      dispatchBodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const payload = {
    action: "created",
    repository: {
      full_name: "openclaw/gogcli",
      default_branch: "trunk",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    issue: { number: 597, user: { login: "steipete" } },
    installation: { id: 123 },
    comment: {
      id: 456,
      body: "@clawsweeper build",
      author_association: "OWNER",
      user: { login: "steipete" },
    },
  };
  const env = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
  };

  try {
    const left = worker.fetch(
      signedGithubWebhookRequest({ event: "issue_comment", secret: "test-secret", payload }),
      env,
    );
    const right = worker.fetch(
      signedGithubWebhookRequest({ event: "issue_comment", secret: "test-secret", payload }),
      env,
    );
    await ackPostStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseAckPost?.();
    const [leftResponse, rightResponse] = await Promise.all([left, right]);

    assert.equal(leftResponse.status, 202);
    assert.equal(rightResponse.status, 202);
    assert.deepEqual(await leftResponse.json(), { ok: true, status_comment_id: 777 });
    assert.deepEqual(await rightResponse.json(), { ok: true, status_comment_id: 777 });
    assert.equal(fastAckPosts, 1);
    assert.equal(reactions, 2);
    assert.equal(comments.length, 1);
    assert.equal(
      comments[0]?.body,
      [
        "<!-- clawsweeper-command-ack:456 -->",
        "🦞👀",
        "ClawSweeper picked this up.",
        "",
        "Command router queued. I will update this comment with the next step.",
      ].join("\n"),
    );
    assert.equal(dispatchBodies.length, 2);
    assert.deepEqual(
      dispatchBodies.map(
        (body) =>
          (body as { client_payload?: { status_comment_id?: unknown } }).client_payload
            ?.status_comment_id,
      ),
      [777, 777],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook removes duplicate fast ack comments after concurrent redelivery", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let commentLookups = 0;
  let deletedAck = 0;
  let dispatchBody: unknown = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      commentLookups += 1;
      if (commentLookups === 1) return jsonResponse([]);
      return jsonResponse([
        {
          id: 777,
          created_at: "2026-05-24T00:00:00Z",
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          id: 888,
          created_at: "2026-05-24T00:00:01Z",
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "POST") {
      return jsonResponse({ id: 888 });
    }
    if (
      url.pathname === "/repos/openclaw/gogcli/issues/comments/888" &&
      init?.method === "DELETE"
    ) {
      deletedAck = 888;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatchBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 597, user: { login: "steipete" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body: "@clawsweeper build",
            author_association: "OWNER",
            user: { login: "steipete" },
          },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(deletedAck, 888);
    assert.equal(commentLookups, 2);
    assert.deepEqual(dispatchBody, {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: "openclaw/gogcli",
        target_branch: "trunk",
        item_number: 597,
        comment_id: 456,
        status_comment_id: 777,
        source_event: "issue_comment",
        source_action: "created",
      },
    });
    assert.ok(
      Object.keys((dispatchBody as { client_payload: Record<string, unknown> }).client_payload)
        .length <= 10,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook schedules post-dispatch fast ack cleanup", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let commentLookups = 0;
  let deletedAck = 0;
  const waitUntilPromises: Promise<unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      commentLookups += 1;
      if (commentLookups <= 2) {
        return jsonResponse([
          {
            id: 777,
            created_at: "2026-05-28T13:00:00Z",
            body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
            user: { login: "openclaw-clawsweeper[bot]" },
          },
        ]);
      }
      return jsonResponse([
        {
          id: 777,
          created_at: "2026-05-28T13:00:00Z",
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          id: 888,
          created_at: "2026-05-28T13:00:01Z",
          updated_at: "2026-05-28T13:00:02Z",
          body: [
            "<!-- clawsweeper-command-status:597:implement_issue:abc123 -->",
            "<!-- clawsweeper-command-ack:456 -->",
            "ClawSweeper issue implementation requested.",
            "<!-- clawsweeper-command-progress:start -->",
            "Implementation progress:",
            "- State: In progress",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    }
    if (
      url.pathname === "/repos/openclaw/gogcli/issues/comments/777" &&
      init?.method === "DELETE"
    ) {
      deletedAck = 777;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 597, user: { login: "steipete" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body: "@clawsweeper build",
            author_association: "OWNER",
            user: { login: "steipete" },
          },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0,0,0",
      },
      {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
    assert.equal(deletedAck, 777);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard shares in-flight GitHub App installation token across parallel requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let tokenRequests = 0;
  let badBearer = "";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = String(new Headers(init?.headers).get("authorization") || "");
    if (url.pathname === "/repos/openclaw/openclaw/installation") {
      return jsonResponse({ id: 12345 });
    }
    if (url.pathname === "/app/installations/12345/access_tokens") {
      tokenRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.hostname === "api.github.com") {
      if (authorization !== "Bearer installation-token") badBearer = authorization;
      if (url.pathname.endsWith("/actions/runs")) return jsonResponse({ workflow_runs: [] });
      if (url.pathname === "/search/issues") return jsonResponse({ total_count: 0, items: [] });
      if (url.pathname.endsWith("/issues")) return jsonResponse([]);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23parallel",
        CLAWSWEEPER_APP_PRIVATE_KEY: String(privateKey),
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    assert.equal(response.status, 200);
    assert.equal(tokenRequests, 1);
    assert.equal(badBearer, "");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard html preserves client compactText regex escapes", async () => {
  const response = await worker.fetch(new Request("https://example.test/"));
  const body = await response.text();
  const match = body.match(/function compactText\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, "compactText function should render in dashboard html");
  const compactText = new Function(`${match[0]}; return compactText;`)() as (
    value: unknown,
  ) => string;

  assert.equal(
    compactText("1234567890abcdef1234567890abcdef\n\t repeated   spaces"),
    "1234567890 repeated spaces",
  );
});

async function activePrFetch(input: RequestInfo | URL) {
  const url = String(input);
  if (url.includes("/actions/workflows/repair-cluster-worker.yml/runs")) {
    return jsonResponse({ workflow_runs: [] });
  }
  if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
    return jsonResponse({
      workflow_runs: [
        {
          id: 1,
          name: "ClawSweeper",
          display_title: "Review event item openclaw/openclaw#80609",
          status: "in_progress",
          conclusion: null,
          html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
          created_at: new Date(Date.now() - 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
  }
  if (url.includes("/repos/openclaw/openclaw/issues")) return jsonResponse([]);
  if (url.includes("/search/issues")) return jsonResponse({ items: [] });
  throw new Error(`unexpected fetch ${url}`);
}

function triageIssue(number: number, labelNames: string[]): Record<string, unknown>;
function triageIssue(repo: string, number: number, labelNames: string[]): Record<string, unknown>;
function triageIssue(
  repoOrNumber: string | number,
  numberOrLabels: number | string[],
  maybeLabels?: string[],
) {
  const repo = typeof repoOrNumber === "string" ? repoOrNumber : "openclaw/openclaw";
  const number = typeof repoOrNumber === "string" ? Number(numberOrLabels) : repoOrNumber;
  const labelNames = typeof repoOrNumber === "string" ? maybeLabels || [] : numberOrLabels;
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/${repo}/issues/${number}`,
    created_at: `2026-05-01T00:${String(number % 60).padStart(2, "0")}:00Z`,
    updated_at: `2026-05-02T00:${String(number % 60).padStart(2, "0")}:00Z`,
    comments: 0,
    user: { login: "reporter" },
    assignees: [],
    labels: labelNames.map((name) => ({ name, color: "0E8A16" })),
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
    },
  });
}

function signedGithubWebhookRequest({
  event,
  secret,
  payload,
  deliveryId = "test-delivery",
}: {
  event: string;
  secret: string;
  payload: unknown;
  deliveryId?: string;
}) {
  const body = JSON.stringify(payload);
  return signedGithubWebhookBodyRequest({ event, secret, body, deliveryId });
}

function signedGithubWebhookBodyRequest({
  event,
  secret,
  body,
  deliveryId = "test-delivery",
}: {
  event: string;
  secret: string;
  body: string;
  deliveryId?: string;
}) {
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Request("https://clawsweeper.openclaw.ai/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body,
  });
}

function stateAppendQueueRequest(path: string, payload: unknown, origin = "https://queue") {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function signedStateAppendRequest(path: string, payload: unknown, secret: string) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Request(`https://clawsweeper.openclaw.ai${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
}

function createExactReviewAdmissionHarness(
  liveItem: (
    targetRepo: string,
    itemNumber: number,
    itemKind: "issue" | "pull_request",
  ) => Response | Promise<Response>,
  options: {
    maxConcurrent?: string;
    publicationBatching?: boolean;
    publicationBatchSize?: string;
    publicationFreshLane?: boolean;
    captureBatchDispatch?: boolean;
    targetInstallation?: (targetRepo: string) => Response | Promise<Response>;
    targetRepository?: (targetRepo: string) => Response | Promise<Response>;
    targetItem?: (targetRepo: string) => Response | Promise<Response>;
    targetPull?: (targetRepo: string) => Response | Promise<Response>;
    producerRun?: (
      runId: string,
      runAttempt: number | null,
      kind: "summary" | "attempt",
    ) => Response | Promise<Response>;
    dispatch?: () => Response | Promise<Response>;
    batchDispatch?: () => Response | Promise<Response>;
  } = {},
) {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  let batchDispatches = 0;
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
    const installation = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/);
    if (installation) {
      return options.targetInstallation?.(installation[1]) ?? jsonResponse({ id: 999 });
    }
    const repository = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (repository) {
      return (
        options.targetRepository?.(repository[1]) ?? jsonResponse({ full_name: repository[1] })
      );
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "queue-token" });
    }
    const producerRunAttempt = url.pathname.match(
      /^\/repos\/openclaw\/clawsweeper\/actions\/runs\/(\d+)\/attempts\/(\d+)$/,
    );
    if (producerRunAttempt) {
      return (
        options.producerRun?.(producerRunAttempt[1]!, Number(producerRunAttempt[2]), "attempt") ??
        jsonResponse({
          id: producerRunAttempt[1],
          run_attempt: Number(producerRunAttempt[2]),
          status: "in_progress",
        })
      );
    }
    const producerRun = url.pathname.match(
      /^\/repos\/openclaw\/clawsweeper\/actions\/runs\/(\d+)$/,
    );
    if (producerRun) {
      return (
        options.producerRun?.(producerRun[1]!, null, "summary") ??
        jsonResponse({ id: producerRun[1], run_attempt: 1, status: "in_progress" })
      );
    }
    const targetItem = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
    if (targetItem) {
      return (
        options.targetItem?.(targetItem[1]) ??
        liveItem(targetItem[1], Number(targetItem[2]), "issue")
      );
    }
    const targetPull = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
    if (targetPull) {
      return (
        options.targetPull?.(targetPull[1]) ??
        options.targetItem?.(targetPull[1]) ??
        liveItem(targetPull[1], Number(targetPull[2]), "pull_request")
      );
    }
    if (
      options.captureBatchDispatch &&
      url.pathname ===
        "/repos/openclaw/clawsweeper/actions/workflows/exact-review-batch-publish.yml/dispatches"
    ) {
      batchDispatches += 1;
      return options.batchDispatch?.() ?? new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return options.dispatch?.() ?? new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const queue = new ExactReviewQueue(
    { storage },
    {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      EXACT_REVIEW_QUEUE_MAX_CONCURRENT: options.maxConcurrent ?? "1",
      ...(options.publicationBatching
        ? {
            EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
            EXACT_REVIEW_PUBLICATION_BATCH_SIZE: options.publicationBatchSize ?? "1",
            EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "300000",
            ...(options.publicationFreshLane
              ? { EXACT_REVIEW_PUBLICATION_FRESH_LANE_ENABLED: "1" }
              : {}),
          }
        : {}),
    },
  );
  return {
    queue,
    storage,
    dispatched,
    get batchDispatches() {
      return batchDispatches;
    },
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function buildExactReviewQueueRequest(
  deliveryId: string,
  itemNumber: number,
  sourceAction: string,
  itemKind: "issue" | "pull_request" = "issue",
  targetRepo = "openclaw/gogcli",
  decisionOverrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
) {
  const sourceEvent = itemKind === "issue" ? "issues" : "pull_request";
  return new Request("https://clawsweeper-exact-review-queue/enqueue", {
    method: "POST",
    body: JSON.stringify({
      delivery_id: deliveryId,
      decision: {
        targetRepo,
        targetBranch: "main",
        itemNumber,
        itemKind,
        sourceEvent,
        sourceAction,
        supersedesInProgress: sourceAction === "edited" || sourceAction === "synchronize",
        ...decisionOverrides,
      },
      ...envelopeOverrides,
    }),
  });
}

function exactReviewPublicationOverrides(
  itemNumber: number,
  producerRunId: string,
  producerSourceAction = "opened",
  leaseRevision = 1,
  targetRepo = "openclaw/gogcli",
) {
  const producerDecision = {
    targetRepo,
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: producerSourceAction,
    supersedesInProgress: false,
  };
  return {
    publication: {
      artifactName: `exact-review-${producerRunId}-1`,
      producerRunId,
      producerRunAttempt: 1,
      sourceSha: "a".repeat(40),
      itemKey: `${targetRepo}#${itemNumber}`,
      protocolVersion: 2,
      leaseRevision,
      claimGeneration: 1,
      liveProceeded: true,
      liveTerminalNoop: false,
      liveTerminalMissing: false,
      liveGuardedOpen: false,
      producerDecision,
    },
  };
}

function legacyExactReviewPublicationOverrides(
  itemNumber: number,
  producerRunId: string,
  producerSourceAction = "opened",
  targetRepo = "openclaw/gogcli",
) {
  const publication = exactReviewPublicationOverrides(
    itemNumber,
    producerRunId,
    producerSourceAction,
    1,
    targetRepo,
  ).publication;
  return {
    publication: {
      ...publication,
      protocolVersion: 1,
      leaseRevision: null,
      claimGeneration: null,
    },
  };
}

function leasedExactReviewQueueItem(itemNumber: number, runId: string, runAttempt = 1) {
  const now = Date.now();
  const decision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber,
    itemKind: "issue" as const,
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  };
  return {
    key: `openclaw/openclaw#${itemNumber}`,
    decision,
    leaseDecision: { ...decision },
    state: "leased",
    revision: 1,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    nextAttemptAt: now - 60_000,
    attempts: 0,
    leaseId: `lease-${itemNumber}`,
    leaseRevision: 1,
    leaseExpiresAt: now + 60 * 60_000,
    claimedRunId: runId,
    claimedRunAttempt: runAttempt,
    claimGeneration: 1,
    claimProtocolVersion: 2,
  };
}

function leasedExactReviewPublicationItem(itemNumber: number, runId: string) {
  const item = leasedExactReviewQueueItem(itemNumber, runId);
  const sourceAction = "exact_review_artifact_publish";
  const publication = {
    artifactName: `exact-review-${runId}-1`,
    producerRunId: runId,
    producerRunAttempt: 1,
    sourceSha: "a".repeat(40),
    itemKey: item.key,
    protocolVersion: 2 as const,
    leaseRevision: 1,
    claimGeneration: 1,
    liveProceeded: true,
    liveTerminalNoop: false,
    liveTerminalMissing: false,
    liveGuardedOpen: false,
    producerDecision: item.decision,
  };
  return {
    ...item,
    key: `${item.key}@publish:${runId}:1`,
    decision: { ...item.decision, sourceAction, publication },
    leaseDecision: { ...item.leaseDecision, sourceAction, publication },
  };
}

test("state writer telemetry is optional, idempotent, and summary-safe", async () => {
  const storage = new MemoryDurableStorage();
  const items = Object.fromEntries(
    Array.from({ length: 2 }, (_, index) => {
      const item = leasedExactReviewPublicationItem(96_000 + index, `9600${index}`);
      return [item.key, item];
    }),
  );
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const queue = new ExactReviewQueue({ storage }, {});
  const now = new Date().toISOString();
  const telemetry = {
    schema_version: 1,
    operation_id: "batch:telemetry-test",
    mode: "batch",
    started_at: now,
    finished_at: now,
    wait_ms: 1,
    acquire_attempts: 1,
    acquired: true,
    hold_ms: 2,
    renewals: 0,
    released: true,
    git_duration_ms: 3,
    git_processes: 4,
    commit_count: 1,
    materialized_items: 2,
    configured_batch_size: 2,
    actual_batch_size: 2,
    batch_wait_ms: 1,
    outcome: "materialized",
  };
  for (const item of Object.values(items)) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: item.key,
          lease_revision: 1,
          claim_generation: 1,
          run_id: item.claimedRunId,
          run_attempt: 1,
          outcome: "success",
          completion_kind: "published",
          reason_code: "publication_applied",
          state_writer: telemetry,
        }),
      }),
    );
    assert.equal(response.status, 200);
  }
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.state_writer.last_15_minutes.operations, 1);
  assert.equal(stats.state_writer.last_15_minutes.state_commits, 1);
  assert.equal(stats.state_writer.last_15_minutes.materialized_items, 2);
  assert.equal(stats.state_writer.last_15_minutes.items_per_commit, 2);
  assert.equal(stats.state_writer.diagnostics.accepted_terminal_total, 1);
  assert.equal(stats.state_writer.diagnostics.duplicate_terminal_total, 1);
  assert.equal(stats.state_writer.diagnostics.state_commits_total, 1);
  assert.equal(stats.state_writer.diagnostics.materialized_items_total, 2);

  const malformed = leasedExactReviewPublicationItem(97_001, "97001");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [malformed.key]: malformed },
  });
  const rejected = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: malformed.leaseId,
        item_key: malformed.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: malformed.claimedRunId,
        run_attempt: 1,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
        state_writer: { schema_version: 1, operation_id: "bad" },
      }),
    }),
  );
  assert.equal(rejected.status, 200);
  const afterReject = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(afterReject.state_writer.diagnostics.rejected_terminal_total, 1);

  const reviewOnly = leasedExactReviewQueueItem(97_002, "97002");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [reviewOnly.key]: reviewOnly },
  });
  const ignored = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: reviewOnly.leaseId,
        item_key: reviewOnly.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: reviewOnly.claimedRunId,
        run_attempt: 1,
        outcome: "success",
        state_writer: telemetry,
      }),
    }),
  );
  assert.equal(ignored.status, 200);
  const afterIgnore = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(afterIgnore.state_writer.last_15_minutes.operations, 1);
  assert.equal(afterIgnore.state_writer.diagnostics.rejected_terminal_total, 2);
});

function unclaimedExactReviewQueueItem(itemNumber: number) {
  return {
    ...leasedExactReviewQueueItem(itemNumber, "unclaimed"),
    state: "dispatching" as const,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
    claimProtocolVersion: undefined,
  };
}

test("exact-review queue durably stores and queries per-item review telemetry", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const now = Date.now();
  const refreshing = {
    repo: "openclaw/openclaw",
    item_number: 674,
    run_id: "12345",
    run_attempt: 2,
    status: "refreshing",
    outcome: null,
    started_at: new Date(now - 60_000).toISOString(),
    updated_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + 60 * 60_000).toISOString(),
    phase_durations_ms: { queue: 10_000, claim: 2_000 },
  };
  const recorded = await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(refreshing),
    }),
  );
  assert.equal(recorded.status, 200);

  const completed = {
    ...refreshing,
    status: "completed",
    outcome: "succeeded",
    updated_at: new Date(now - 10_000).toISOString(),
    lease_expires_at: null,
    phase_durations_ms: { ...refreshing.phase_durations_ms, review: 180_000, total: 250_000 },
    generation: 7,
    operation_id: "review:674:7",
  };
  await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify(completed),
    }),
  );
  // Neither a delayed heartbeat nor a conflicting terminal retry can rewrite
  // the first terminal truth.
  await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify({ ...refreshing, updated_at: new Date(now).toISOString() }),
    }),
  );
  await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify({
        ...completed,
        outcome: "failed",
        updated_at: new Date(now + 1_000).toISOString(),
      }),
    }),
  );

  const response = await queue.fetch(
    new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=674"),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { reviews: unknown[] };
  assert.deepEqual(body.reviews, [completed]);

  const restarted = new ExactReviewQueue({ storage }, {});
  const afterRestart = await restarted.fetch(
    new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=674"),
  );
  assert.deepEqual((await afterRestart.json()) as { reviews: unknown[] }, {
    ok: true,
    repo: "openclaw/openclaw",
    item_number: 674,
    reviews: [completed],
  });
});

test("exact-review queue incrementally indexes the v1 review telemetry table", async () => {
  const storage = new MemoryDurableStorage();
  storage.sql.exec(
    `CREATE TABLE exact_review_review_telemetry (
       repo TEXT NOT NULL,
       item_number INTEGER NOT NULL,
       run_id TEXT NOT NULL,
       run_attempt INTEGER NOT NULL,
       status TEXT NOT NULL,
       updated_at INTEGER NOT NULL,
       lease_expires_at INTEGER,
       record_json TEXT NOT NULL,
       PRIMARY KEY (repo, item_number, run_id, run_attempt)
     ) STRICT`,
  );
  const queue = new ExactReviewQueue({ storage }, {});
  const now = new Date().toISOString();
  const response = await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify({
        repo: "openclaw/openclaw",
        item_number: 674,
        run_id: "44000",
        run_attempt: 1,
        status: "completed",
        outcome: "superseded",
        started_at: now,
        updated_at: now,
        lease_expires_at: null,
        phase_durations_ms: { total: 12_000 },
        generation: 2,
        operation_id: "review:674:2",
        trigger_lane: "exact_event",
        trigger_origin: "webhook",
        terminal_at: now,
        terminal_reason: "generation_superseded",
      }),
    }),
  );
  assert.equal(response.status, 200);
  const columns = Array.from(
    storage.sql.exec(
      "SELECT name FROM pragma_table_info('exact_review_review_telemetry') ORDER BY name",
    ),
    (row) => row.name,
  );
  for (const column of [
    "generation",
    "operation_id",
    "outcome",
    "terminal_at",
    "total_ms",
    "trigger_lane",
    "trigger_origin",
  ]) {
    assert.ok(columns.includes(column));
  }
});

test("terminal workflow observer conservatively completes only unleased refreshing telemetry", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { REVIEW_OBSERVABILITY_REQUIRED: "1" });
  const now = Date.now();
  const refreshing = (itemNumber: number, leaseExpiresAt: string | null) => ({
    repo: "openclaw/openclaw",
    item_number: itemNumber,
    run_id: "55555",
    run_attempt: 1,
    status: "refreshing",
    outcome: null,
    started_at: new Date(now - 10 * 60_000).toISOString(),
    updated_at: new Date(now - 5 * 60_000).toISOString(),
    lease_expires_at: leaseExpiresAt,
    phase_durations_ms: { queue: 1_000 },
    trigger_lane: "exact_event",
    trigger_origin: "webhook",
  });
  for (const record of [
    refreshing(674, null),
    refreshing(675, new Date(now + 60 * 60_000).toISOString()),
    { ...refreshing(676, null), run_attempt: 2 },
  ]) {
    assert.equal(
      (
        await queue.fetch(
          new Request("https://queue/review-telemetry", {
            method: "POST",
            body: JSON.stringify(record),
          }),
        )
      ).status,
      200,
    );
  }
  const run = {
    run_id: "55555",
    run_attempt: 1,
    workflow_outcome: "cancelled",
    trigger_lane: "exact_event",
    trigger_origin: "webhook",
    target_repo: "openclaw/openclaw",
    started_at: new Date(now - 10 * 60_000).toISOString(),
    completed_at: new Date(now).toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/55555",
    plan_count: 1,
    item_count: 2,
    publication_count: 0,
    source_event: "repository_dispatch",
    review_jobs: [
      { name: "Review item 674", conclusion: "cancelled", item_number: 674 },
      { name: "Review item 675", conclusion: "cancelled", item_number: 675 },
    ],
  };
  assert.equal(
    (
      await queue.fetch(
        new Request("https://queue/review-run-telemetry", {
          method: "POST",
          body: JSON.stringify(run),
        }),
      )
    ).status,
    200,
  );
  const first = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=674"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(first.reviews[0].outcome, "cancelled");
  assert.equal(first.reviews[0].terminal_reason, "workflow_cancelled");
  const leased = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=675"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(leased.reviews[0].status, "refreshing");
  const scheduledReconcile = await storage.getAlarm();
  assert.ok(scheduledReconcile !== null && scheduledReconcile <= now + 60 * 60_000);
  const otherAttempt = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=676"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(otherAttempt.reviews[0].status, "refreshing");

  const aggregate = (await (
    await queue.fetch(
      new Request("https://queue/review-observability?range=24h&repo=openclaw%2Fopenclaw"),
    )
  ).json()) as Record<string, any>;
  assert.equal(aggregate.outcomes.cancelled, 1);
  assert.equal(aggregate.unexpected_cancelled, 1);
  assert.match(aggregate.anomalies[0].run_url, /\/actions\/runs\/55555$/);
  assert.equal(
    (
      await queue.fetch(
        new Request("https://queue/review-observability?range=30d&repo=openclaw%2Fopenclaw"),
      )
    ).status,
    400,
  );

  const originalNow = Date.now;
  Date.now = () => now + 61 * 60_000;
  try {
    await queue.alarm();
  } finally {
    Date.now = originalNow;
  }
  const reconciled = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=675"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(reconciled.reviews[0].outcome, "cancelled");
  assert.equal(reconciled.reviews[0].terminal_reason, "workflow_cancelled");
});

test("terminal workflow evidence reconciles telemetry that arrives later", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { REVIEW_OBSERVABILITY_REQUIRED: "1" });
  const now = Date.now();
  const run = {
    run_id: "56565",
    run_attempt: 1,
    workflow_outcome: "failure",
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
    target_repo: "openclaw/openclaw",
    started_at: new Date(now - 10 * 60_000).toISOString(),
    completed_at: new Date(now - 60_000).toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/56565",
    plan_count: 1,
    item_count: 2,
    publication_count: 0,
    review_jobs: [
      { name: "Review item 701", conclusion: "failure", item_number: 701 },
      { name: "Review shard 2", conclusion: "success", item_number: null },
    ],
  };
  assert.equal(
    (
      await queue.fetch(
        new Request("https://queue/review-run-telemetry", {
          method: "POST",
          body: JSON.stringify(run),
        }),
      )
    ).status,
    200,
  );
  for (const itemNumber of [701, 702]) {
    assert.equal(
      (
        await queue.fetch(
          new Request("https://queue/review-telemetry", {
            method: "POST",
            body: JSON.stringify({
              repo: "openclaw/openclaw",
              item_number: itemNumber,
              run_id: run.run_id,
              run_attempt: 1,
              status: "refreshing",
              outcome: null,
              started_at: new Date(now - 9 * 60_000).toISOString(),
              updated_at: new Date(now - 2 * 60_000).toISOString(),
              lease_expires_at: null,
              phase_durations_ms: {},
              trigger_lane: "normal_backfill",
              trigger_origin: "schedule",
            }),
          }),
        )
      ).status,
      200,
    );
    const telemetry = (await (
      await queue.fetch(
        new Request(
          `https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=${itemNumber}`,
        ),
      )
    ).json()) as { reviews: Array<Record<string, unknown>> };
    if (itemNumber === 701) {
      assert.equal(telemetry.reviews[0].outcome, "interrupted");
      assert.equal(telemetry.reviews[0].terminal_reason, "workflow_terminal");
    } else {
      assert.equal(telemetry.reviews[0].status, "refreshing");
    }
  }
  assert.equal(await storage.getAlarm(), null);
});

test("terminal workflow evidence records only attributable success", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { REVIEW_OBSERVABILITY_REQUIRED: "1" });
  const now = Date.now();
  const refreshing = (itemNumber: number, repo = "openclaw/openclaw") => ({
    repo,
    item_number: itemNumber,
    run_id: "57575",
    run_attempt: 1,
    status: "refreshing",
    outcome: null,
    started_at: new Date(now - 5 * 60_000).toISOString(),
    updated_at: new Date(now - 2 * 60_000).toISOString(),
    lease_expires_at: null,
    phase_durations_ms: {},
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
  });
  for (const itemNumber of [801, 802]) {
    await queue.fetch(
      new Request("https://queue/review-telemetry", {
        method: "POST",
        body: JSON.stringify(refreshing(itemNumber)),
      }),
    );
  }
  const run = {
    run_id: "57575",
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
    target_repo: "openclaw/openclaw",
    started_at: new Date(now - 6 * 60_000).toISOString(),
    completed_at: new Date(now - 60_000).toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/57575",
    plan_count: 1,
    item_count: 2,
    publication_count: 1,
    review_jobs: [
      { name: "Review item 801", conclusion: "success", item_number: 801 },
      { name: "Review shard 2", conclusion: "success", item_number: null },
    ],
  };
  assert.equal(
    (
      await queue.fetch(
        new Request("https://queue/review-run-telemetry", {
          method: "POST",
          body: JSON.stringify(run),
        }),
      )
    ).status,
    200,
  );
  for (const [itemNumber, expectedStatus] of [
    [801, "completed"],
    [802, "refreshing"],
  ] as const) {
    const telemetry = (await (
      await queue.fetch(
        new Request(
          `https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=${itemNumber}`,
        ),
      )
    ).json()) as { reviews: Array<Record<string, unknown>> };
    assert.equal(telemetry.reviews[0].status, expectedStatus);
    if (itemNumber === 801) {
      assert.equal(telemetry.reviews[0].outcome, "succeeded");
      assert.equal(telemetry.reviews[0].terminal_reason, "workflow_job_succeeded");
    }
  }
  await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify(refreshing(801, "openclaw/clawhub")),
    }),
  );
  const otherRepo = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fclawhub&item_number=801"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(otherRepo.reviews[0].status, "refreshing");
  assert.equal(await storage.getAlarm(), null);
});

test("workflow observer replay reconciles only from immutable first-writer evidence", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { REVIEW_OBSERVABILITY_REQUIRED: "1" });
  const now = Date.now();
  const baseRun = {
    run_id: "58585",
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "exact_event",
    trigger_origin: "webhook",
    target_repo: "openclaw/clawhub",
    started_at: new Date(now - 5 * 60_000).toISOString(),
    completed_at: new Date(now - 60_000).toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/58585",
    plan_count: 1,
    item_count: 1,
    publication_count: 0,
    review_jobs: [{ name: "Review item 901", conclusion: "success", item_number: 901 }],
  };
  await queue.fetch(
    new Request("https://queue/review-run-telemetry", {
      method: "POST",
      body: JSON.stringify(baseRun),
    }),
  );
  await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify({
        repo: "openclaw/openclaw",
        item_number: 901,
        run_id: "58585",
        run_attempt: 1,
        status: "refreshing",
        outcome: null,
        started_at: new Date(now - 4 * 60_000).toISOString(),
        updated_at: new Date(now - 2 * 60_000).toISOString(),
        lease_expires_at: null,
        phase_durations_ms: {},
        trigger_lane: "exact_event",
        trigger_origin: "webhook",
      }),
    }),
  );
  await queue.fetch(
    new Request("https://queue/review-run-telemetry", {
      method: "POST",
      body: JSON.stringify({
        ...baseRun,
        workflow_outcome: "cancelled",
        target_repo: "openclaw/openclaw",
        review_jobs: [{ name: "Review item 901", conclusion: "cancelled", item_number: 901 }],
      }),
    }),
  );
  const telemetry = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=901"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(telemetry.reviews[0].status, "refreshing");
});

test("review observer write is signed while aggregate telemetry remains read-only", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const record = JSON.stringify({
    run_id: "60000",
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
    target_repo: "openclaw/openclaw",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    completed_at: new Date().toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/60000",
    plan_count: 1,
    item_count: 4,
    publication_count: 1,
  });
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const denied = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/review-run-telemetry", {
      method: "POST",
      body: record,
    }),
    env,
  );
  assert.equal(denied.status, 401);

  const signature = `sha256=${createHmac("sha256", "test-token-placeholder").update(record).digest("hex")}`;
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/review-run-telemetry", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": signature },
      body: record,
    }),
    env,
  );
  assert.equal(accepted.status, 200);
  const aggregate = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/review-observability?range=24h&repo=all"),
    env,
  );
  assert.equal(aggregate.status, 200);
  assert.equal(((await aggregate.json()) as { mode: string }).mode, "passive");
});

test("exact-review health includes the oldest refreshing row beyond operator page bounds", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { REVIEW_OBSERVABILITY_REQUIRED: "1" });
  await queue.fetch(new Request("https://queue/stats"));
  const now = Date.now();
  for (let index = 0; index <= 10_000; index += 1) {
    const old = index === 0;
    const updatedAt = old ? now - 151 * 60_000 : now - 60_000;
    const record = {
      repo: "openclaw/openclaw",
      item_number: index + 1,
      run_id: String(index + 1),
      run_attempt: 1,
      status: "refreshing",
      outcome: null,
      started_at: new Date(updatedAt - 60_000).toISOString(),
      updated_at: new Date(updatedAt).toISOString(),
      lease_expires_at: null,
      phase_durations_ms: {},
    };
    storage.sql.exec(
      `INSERT INTO exact_review_review_telemetry
       (repo, item_number, run_id, run_attempt, status, updated_at, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.repo,
      record.item_number,
      record.run_id,
      record.run_attempt,
      record.status,
      updatedAt,
      JSON.stringify(record),
    );
  }

  const response = await queue.fetch(new Request("https://queue/stats"));
  const stats = (await response.json()) as {
    review_telemetry_health: {
      status: string;
      refreshing: number;
      orphan_refreshing: number;
      orphans: Array<{ age_seconds: number }>;
    };
  };
  const oldestRefreshingAgeSeconds = stats.review_telemetry_health.orphans[0]?.age_seconds;
  assert.ok(oldestRefreshingAgeSeconds !== undefined && oldestRefreshingAgeSeconds >= 9060);
  assert.deepEqual(stats.review_telemetry_health, {
    status: "critical",
    refreshing: 10_001,
    slow_refreshing: 1,
    orphan_refreshing: 1,
    degraded_after_seconds: 1800,
    orphan_after_seconds: 9000,
    orphans: [
      {
        repo: "openclaw/openclaw",
        item_number: 1,
        run_id: "1",
        run_attempt: 1,
        updated_at: new Date(now - 151 * 60_000).toISOString(),
        age_seconds: oldestRefreshingAgeSeconds,
        lease_expires_at: null,
      },
    ],
  });
  const aggregate = (await (
    await queue.fetch(new Request("https://queue/review-observability?range=24h&repo=all"))
  ).json()) as { health: string; orphan: number; telemetry_complete: boolean };
  assert.equal(aggregate.telemetry_complete, false);
  assert.equal(aggregate.orphan, 1);
  assert.equal(aggregate.health, "critical");
});

test("review observability retains refreshing attempts older than the selected range", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    { REVIEW_OBSERVABILITY_REQUIRED: "1", REVIEW_RECOVERY_ENABLED: "0" },
  );
  const now = Date.now();
  const response = await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify({
        repo: "openclaw/openclaw",
        item_number: 674,
        run_id: "70000",
        run_attempt: 1,
        status: "refreshing",
        outcome: null,
        started_at: new Date(now - 26 * 60 * 60_000).toISOString(),
        updated_at: new Date(now - 25 * 60 * 60_000).toISOString(),
        lease_expires_at: null,
        phase_durations_ms: {},
        trigger_lane: "exact_event",
        trigger_origin: "webhook",
      }),
    }),
  );
  assert.equal(response.status, 200);
  const aggregate = (await (
    await queue.fetch(
      new Request("https://queue/review-observability?range=24h&repo=openclaw%2Fopenclaw"),
    )
  ).json()) as { refreshing: number; orphan: number; health: string };
  assert.equal(aggregate.refreshing, 1);
  assert.equal(aggregate.orphan, 1);
  assert.equal(aggregate.health, "critical");
});
