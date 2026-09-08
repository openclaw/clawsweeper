import assert from "node:assert/strict";
import test from "node:test";
import {
  exactReviewQueueAdmittedItems,
  exactReviewQueueNextWakeAt,
  exactReviewQueueStats,
} from "../dashboard/exact-review-read-model.ts";
import type {
  ExactReviewQueueItem,
  ExactReviewQueueState,
} from "../dashboard/exact-review-queue.ts";
import { leasedExactReviewQueueItem } from "./dashboard-worker-harness.ts";

const NOW = Date.parse("2026-09-05T12:00:00Z");

function active(number: number, sourceAction: string, state: "leased" | "dispatching" = "leased") {
  const item = leasedExactReviewQueueItem(number, String(number));
  const decision = { ...item.decision, sourceAction };
  return {
    ...item,
    state,
    decision,
    leaseDecision: decision,
    leaseExpiresAt: NOW + 60_000,
  } as ExactReviewQueueItem;
}

function pending(number: number, sourceAction: string): ExactReviewQueueItem {
  const item = active(number, sourceAction);
  return {
    ...item,
    state: "pending",
    createdAt: NOW - number * 1_000,
    nextAttemptAt: NOW - 1_000,
    leaseDecision: undefined,
    leaseExpiresAt: undefined,
    leaseId: undefined,
  };
}

function stateOf(...items: ExactReviewQueueItem[]): ExactReviewQueueState {
  return { items: Object.fromEntries(items.map((item) => [item.key, item])) };
}

function admit(state: ExactReviewQueueState, scheduledCapacity = 8) {
  return exactReviewQueueAdmittedItems(
    state,
    NOW,
    32,
    24,
    8,
    new Set(),
    false,
    false,
    new Set(),
    0,
    scheduledCapacity,
  );
}

test("scheduled owners share one cap while organic/manual reviews keep admission", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const owners = Array.from({ length: 8 }, (_, i) =>
    active(
      i + 1,
      i % 2 ? "scheduled_normal_backfill" : "scheduled_hot_intake",
      i % 2 ? "leased" : "dispatching",
    ),
  );
  owners[0].decision = { ...owners[0].decision, sourceAction: "opened" };
  const scheduled = [pending(20, "scheduled_normal_backfill"), pending(21, "scheduled_hot_intake")];
  const organic = pending(10, "opened");
  const manual = pending(11, "re_review_command");
  const state = stateOf(...owners, ...scheduled, organic, manual);
  const before = structuredClone(state);
  assert.deepEqual(
    new Set(admit(state).map((item) => item.key)),
    new Set([organic.key, manual.key]),
  );
  assert.deepEqual(
    admit(state, 2).map((item) => item.key),
    admit(state).map((item) => item.key),
  );
  assert.deepEqual(state, before, "lowering capacity must not cancel or mutate existing owners");
  const stats = exactReviewQueueStats(
    state,
    NOW,
    32,
    24,
    8,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    8,
  );
  assert.deepEqual(stats.scheduled_feed, { max_concurrent: 8, active: 8 });
  assert.equal(stats.admissible_pending, 2);
  delete state.items[owners[0].key];
  const admitted = admit(state);
  assert.equal(admitted.length, 3);
  assert.equal(
    admitted.filter((item) => scheduled.some((candidate) => candidate.key === item.key)).length,
    1,
  );
});

test("a full scheduled cap sleeps until an owner can release capacity", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const state = stateOf(active(1, "scheduled_hot_intake"), pending(2, "scheduled_normal_backfill"));
  const wake = () =>
    exactReviewQueueNextWakeAt(
      state,
      NOW,
      32,
      24,
      8,
      undefined,
      undefined,
      undefined,
      null,
      null,
      1,
    );
  assert.equal(wake(), NOW + 60_000);
  state.items["openclaw/openclaw#3"] = pending(3, "opened");
  assert.equal(wake(), NOW + 1_000, "organic work must not inherit the scheduled hold");
});

test("an organic lease is not charged for a newer scheduled desired revision", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const owner = active(1, "opened");
  owner.decision = { ...owner.decision, sourceAction: "scheduled_normal_backfill" };
  const queued = pending(2, "scheduled_hot_intake");
  assert.deepEqual(
    admit(stateOf(owner, queued), 1).map((item) => item.key),
    [queued.key],
  );
});
