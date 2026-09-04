import assert from "node:assert/strict";
import test from "node:test";

import {
  projectExactReviewHandoff,
  summarizeExactReviewHandoff,
  summarizeExactReviewPublicationHealth,
  summarizeExactReviewPressure,
} from "../dashboard/exact-review-health.ts";

const NOW = Date.parse("2026-07-13T02:00:00.000Z");
const DISPATCH_LEASE_MS = 10 * 60_000;
const EXECUTION_LEASE_MS = 130 * 60_000;

function summarize(overrides: Partial<Parameters<typeof summarizeExactReviewHandoff>[0]> = {}) {
  return summarizeExactReviewHandoff({
    items: [],
    now: NOW,
    capacity: 28,
    dispatchLeaseMs: DISPATCH_LEASE_MS,
    executionLeaseMs: EXECUTION_LEASE_MS,
    ...overrides,
  });
}

test("exact-review handoff health reports an empty queue as idle", () => {
  const health = summarize();

  assert.equal(health.status, "idle");
  assert.equal(health.reason, "queue_empty");
  assert.equal(health.message, "No exact-review work is queued or active.");
  assert.equal(health.active, 0);
  assert.equal(health.available_slots, 28);
  assert.deepEqual(health.phases, {
    pending: { count: 0, oldest_at: null, oldest_age_seconds: null, oldest_key: null },
    dispatching: { count: 0, oldest_at: null, oldest_age_seconds: null, oldest_key: null },
    leased: { count: 0, oldest_at: null, oldest_age_seconds: null, oldest_key: null },
  });
});

test("exact-review handoff health exposes phase counts, ages, and available capacity", () => {
  const pending = { state: "pending" as const, createdAt: NOW - 90_000, updatedAt: NOW - 90_000 };
  const health = summarize({
    capacity: 4,
    shedSinceReset: 7,
    items: [
      { ...pending, key: "b", reviewRecoveryReason: "claim_timeout" },
      { ...pending, key: "a", reviewRecoveryReason: "execution_timeout" },
      {
        state: "dispatching",
        createdAt: NOW - 5 * 60_000,
        updatedAt: NOW - 20_000,
        dispatchedAt: NOW - 20_000,
        reviewRecoveryReason: "workflow_cancelled",
      },
      {
        state: "leased",
        createdAt: NOW - 6 * 60_000,
        updatedAt: NOW - 40_000,
        claimedAt: NOW - 40_000,
        reviewRecoveryReason: "workflow_failed",
      },
    ],
  });

  const pendingAt = "2026-07-13T01:58:30.000Z";
  const dispatchingAt = "2026-07-13T01:59:40.000Z";
  const leasedAt = "2026-07-13T01:59:20.000Z";
  const expected = {
    status: "healthy",
    reason: "handoff_current",
    message: "Dispatch-to-claim handoffs are within the expected window.",
    observed_at: "2026-07-13T02:00:00.000Z",
    warning_after_seconds: 120,
    stalled_after_seconds: 300,
    capacity: 4,
    active: 2,
    available_slots: 2,
    pending_depth: 2,
    shed_since_reset: 7,
    recovery_reasons: {
      claim_timeout: 1,
      execution_timeout: 1,
      workflow_cancelled: 1,
      workflow_failed: 1,
    },
    phases: {
      pending: { count: 2, oldest_at: pendingAt, oldest_age_seconds: 90, oldest_key: "a" },
      dispatching: { count: 1, oldest_at: dispatchingAt, oldest_age_seconds: 20, oldest_key: null },
      leased: { count: 1, oldest_at: leasedAt, oldest_age_seconds: 40, oldest_key: null },
    },
  };
  assert.deepEqual(health, expected);
  assert.equal(JSON.stringify(health), JSON.stringify(expected));

  const malformedPhase = { count: 1, oldestAt: NOW, oldestKey: "malformed#1" };
  const projected = projectExactReviewHandoff({
    itemCount: 0,
    phaseCensus: { pending: malformedPhase, dispatching: malformedPhase, leased: malformedPhase },
    recoveryReasons: expected.recovery_reasons,
    now: NOW,
    capacity: 1,
    dispatchLeaseMs: DISPATCH_LEASE_MS,
  });
  assert.deepEqual(
    { status: projected.status, pendingDepth: projected.pending_depth },
    { status: "idle", pendingDepth: 1 },
  );
});

test("exact-review handoff health distinguishes delayed and stalled claims", () => {
  const delayed = summarize({
    items: [
      {
        state: "dispatching",
        createdAt: NOW - 10 * 60_000,
        updatedAt: NOW - 120_000,
        dispatchedAt: NOW - 120_000,
      },
    ],
  });
  const stalled = summarize({
    dispatcher: { state: "blocked" },
    items: [
      { state: "pending", createdAt: NOW, updatedAt: NOW },
      {
        state: "dispatching",
        createdAt: NOW - 10 * 60_000,
        updatedAt: NOW - 300_000,
        dispatchedAt: NOW - 300_000,
      },
    ],
  });

  assert.equal(delayed.status, "degraded");
  assert.equal(delayed.reason, "claim_delayed");
  assert.equal(delayed.message, "A dispatched review is taking longer than expected to claim.");
  assert.equal(stalled.status, "stalled");
  assert.equal(stalled.reason, "claim_stalled");
  const stalledMessage =
    "A dispatched review has not been claimed within the expected handoff window.";
  assert.equal(stalled.message, stalledMessage);
});

test("exact-review handoff health surfaces paused and blocked dispatchers with pending work", () => {
  const delayedAt = NOW - 120_000;
  const items = [
    { state: "pending" as const, createdAt: NOW - 60_000, updatedAt: NOW - 60_000 },
    {
      state: "dispatching" as const,
      createdAt: delayedAt,
      updatedAt: delayedAt,
      dispatchedAt: delayedAt,
    },
  ];

  const paused = summarize({ items, dispatcher: { state: "paused" } });
  const blocked = summarize({ items, dispatcher: { state: "blocked" } });

  assert.equal(paused.status, "degraded");
  assert.equal(paused.reason, "dispatcher_paused");
  assert.equal(paused.message, "The exact-review workflow is paused while reviews are pending.");
  assert.equal(blocked.status, "stalled");
  assert.equal(blocked.reason, "dispatcher_blocked");
  const blockedMessage =
    "The dispatcher cannot verify workflow availability while reviews are pending.";
  assert.equal(blocked.message, blockedMessage);
});

test("exact-review handoff health derives legacy dispatch age from its active lease", () => {
  const health = summarize({
    items: [
      {
        state: "dispatching",
        createdAt: NOW - 60 * 60_000,
        updatedAt: NOW - 60 * 60_000,
        leaseExpiresAt: NOW + DISPATCH_LEASE_MS - 20_000,
      },
    ],
  });

  assert.equal(health.status, "healthy");
  assert.equal(health.phases.dispatching.oldest_at, "2026-07-13T01:59:40.000Z");
  assert.equal(health.phases.dispatching.oldest_age_seconds, 20);
});

test("exact-review handoff health uses dispatch time when a longer lease has a future derived start", () => {
  const health = summarize({
    items: [
      {
        state: "dispatching",
        createdAt: NOW - 10 * 60_000,
        updatedAt: NOW - 6 * 60_000,
        dispatchedAt: NOW - 6 * 60_000,
        leaseExpiresAt: NOW + 15 * 60_000,
      },
    ],
  });

  assert.equal(health.status, "stalled");
  assert.equal(health.reason, "claim_stalled");
  assert.equal(health.phases.dispatching.oldest_at, "2026-07-13T01:54:00.000Z");
  assert.equal(health.phases.dispatching.oldest_age_seconds, 360);
});

test("exact-review handoff health ignores stale rollback telemetry and unknown legacy ages", () => {
  const rolledBack = summarize({
    items: [
      {
        state: "dispatching",
        createdAt: NOW - 60 * 60_000,
        updatedAt: NOW - 60 * 60_000,
        dispatchedAt: NOW - 60 * 60_000,
        leaseExpiresAt: NOW + DISPATCH_LEASE_MS - 20_000,
      },
    ],
  });
  const unknown = summarize({
    items: [
      {
        state: "dispatching",
        createdAt: NOW - 60 * 60_000,
        updatedAt: NOW - 60 * 60_000,
      },
    ],
  });

  assert.equal(rolledBack.status, "healthy");
  assert.equal(rolledBack.phases.dispatching.oldest_age_seconds, 20);
  assert.equal(unknown.status, "healthy");
  assert.equal(unknown.phases.dispatching.oldest_age_seconds, 0);
});

test("exact-review handoff health derives legacy leased age from its execution lease", () => {
  const health = summarize({
    items: [
      {
        state: "leased",
        createdAt: NOW - 60 * 60_000,
        updatedAt: NOW - 60 * 60_000,
        claimedAt: NOW - 60 * 60_000,
        leaseExpiresAt: NOW + EXECUTION_LEASE_MS - 40_000,
      },
    ],
  });

  assert.equal(health.status, "healthy");
  assert.equal(health.phases.leased.oldest_at, "2026-07-13T01:59:20.000Z");
  assert.equal(health.phases.leased.oldest_age_seconds, 40);
});

test("exact-review pressure distinguishes available, congested, and saturated capacity", () => {
  const base = {
    pending: 4,
    readyPending: 4,
    admissiblePending: 4,
    dispatching: 4,
    leased: 60,
    capacity: 64,
    dispatcherState: "active",
    handoffStatus: "healthy",
  };

  assert.deepEqual(summarizeExactReviewPressure({ ...base, leased: 59 }), {
    status: "idle",
    reason: "capacity_available",
    capacity: 64,
    active: 63,
    pending: 4,
    ready_pending: 4,
    admissible_pending: 4,
  });
  assert.equal(summarizeExactReviewPressure({ ...base, admissiblePending: 3 }).status, "congested");
  assert.equal(
    summarizeExactReviewPressure({ ...base, pending: 64, readyPending: 64, admissiblePending: 64 })
      .status,
    "saturated",
  );
});

test("exact-review pressure preserves non-dispatchable and unknown states", () => {
  const base = {
    pending: 5,
    readyPending: 5,
    admissiblePending: 5,
    dispatching: 4,
    leased: 60,
    capacity: 64,
    dispatcherState: "active",
    handoffStatus: "healthy",
  };

  assert.equal(
    summarizeExactReviewPressure({ ...base, readyPending: 0 }).reason,
    "no_ready_backlog",
  );
  assert.equal(
    summarizeExactReviewPressure({ ...base, admissiblePending: 0 }).reason,
    "no_admissible_backlog",
  );
  assert.deepEqual(
    summarizeExactReviewPressure({
      ...base,
      pending: 2.9,
      readyPending: 9,
      admissiblePending: 8,
      dispatcherState: "paused",
    }),
    {
      status: "unknown",
      reason: "dispatcher_inactive",
      capacity: 64,
      active: 64,
      pending: 2,
      ready_pending: 2,
      admissible_pending: 2,
    },
  );
});

test("idle publication activity is healthy regardless of retired writer history", () => {
  const idle = summarizeExactReviewPublicationHealth(
    { pending: 0, active: 0, parked: 0, oldest_pending_age_seconds: null },
    { last_15_minutes: { net_drain_rate_per_hour: -100 } },
  );
  assert.deepEqual(idle, { status: "idle", reason: null });

  const delayed = summarizeExactReviewPublicationHealth(
    { pending: 1, active: 0, parked: 0, oldest_pending_age_seconds: 3_601 },
    { last_15_minutes: { net_drain_rate_per_hour: 10 } },
  );
  assert.deepEqual(delayed, { status: "degraded", reason: "oldest_pending_over_1h" });
});
