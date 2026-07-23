import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizeExactReviewHandoff,
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
  assert.equal(health.active, 0);
  assert.equal(health.available_slots, 28);
  assert.deepEqual(health.phases, {
    pending: { count: 0, oldest_at: null, oldest_age_seconds: null, oldest_key: null },
    dispatching: { count: 0, oldest_at: null, oldest_age_seconds: null, oldest_key: null },
    leased: { count: 0, oldest_at: null, oldest_age_seconds: null, oldest_key: null },
  });
});

test("exact-review handoff health exposes phase counts, ages, and available capacity", () => {
  const health = summarize({
    capacity: 4,
    shedSinceReset: 7,
    dispatcher: { state: "active" },
    items: [
      {
        key: "openclaw/openclaw#123",
        state: "pending",
        createdAt: NOW - 90_000,
        updatedAt: NOW - 90_000,
      },
      {
        state: "dispatching",
        createdAt: NOW - 5 * 60_000,
        updatedAt: NOW - 20_000,
        dispatchedAt: NOW - 20_000,
      },
      {
        state: "leased",
        createdAt: NOW - 6 * 60_000,
        updatedAt: NOW - 40_000,
        claimedAt: NOW - 40_000,
      },
    ],
  });

  assert.equal(health.status, "healthy");
  assert.equal(health.reason, "handoff_current");
  assert.equal(health.active, 2);
  assert.equal(health.available_slots, 2);
  assert.equal(health.pending_depth, 1);
  assert.equal(health.shed_since_reset, 7);
  assert.deepEqual(health.phases.pending, {
    count: 1,
    oldest_at: "2026-07-13T01:58:30.000Z",
    oldest_age_seconds: 90,
    oldest_key: "openclaw/openclaw#123",
  });
  assert.equal(health.phases.dispatching.oldest_age_seconds, 20);
  assert.equal(health.phases.leased.oldest_age_seconds, 40);
  assert.equal(health.warning_after_seconds, 120);
  assert.equal(health.stalled_after_seconds, 300);
});

test("exact-review handoff health distinguishes delayed and stalled claims", () => {
  const delayed = summarize({
    items: [
      {
        state: "dispatching",
        createdAt: NOW - 10 * 60_000,
        updatedAt: NOW - 121_000,
        dispatchedAt: NOW - 121_000,
      },
    ],
  });
  const stalled = summarize({
    items: [
      {
        state: "dispatching",
        createdAt: NOW - 10 * 60_000,
        updatedAt: NOW - 301_000,
        dispatchedAt: NOW - 301_000,
      },
    ],
  });

  assert.equal(delayed.status, "degraded");
  assert.equal(delayed.reason, "claim_delayed");
  assert.equal(stalled.status, "stalled");
  assert.equal(stalled.reason, "claim_stalled");
});

test("exact-review handoff health surfaces paused and blocked dispatchers with pending work", () => {
  const items = [{ state: "pending" as const, createdAt: NOW - 60_000, updatedAt: NOW - 60_000 }];

  const paused = summarize({ items, dispatcher: { state: "paused" } });
  const blocked = summarize({ items, dispatcher: { state: "blocked" } });

  assert.equal(paused.status, "degraded");
  assert.equal(paused.reason, "dispatcher_paused");
  assert.equal(blocked.status, "stalled");
  assert.equal(blocked.reason, "dispatcher_blocked");
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
