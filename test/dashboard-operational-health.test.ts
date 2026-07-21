import assert from "node:assert/strict";
import test from "node:test";

import {
  exactReviewHistorySample,
  mergeHealthHistorySample,
  normalizeHealthHistorySample,
  stateWriterHistorySample,
  summarizeOperationalHealth,
} from "../dashboard/operational-health.ts";

const CHECKED_AT = "2026-07-15T14:00:00Z";

function run(status: string, createdAt: string) {
  return { status, created_at: createdAt };
}

function legacyHistorySample() {
  return {
    at: CHECKED_AT,
    status: "healthy" as const,
    queued: 0,
    queued_over_30m: 0,
    oldest_queued_minutes: 0,
    running: 0,
    running_over_150m: 0,
    oldest_running_minutes: 0,
    collection_ok: true,
  };
}

test("operational health classifies over-age queue pressure and stuck runs", () => {
  const degraded = summarizeOperationalHealth(
    [
      run("queued", "2026-07-15T13:20:00Z"),
      run("pending", "2026-07-15T13:50:00Z"),
      run("in_progress", "2026-07-15T12:00:00Z"),
    ],
    CHECKED_AT,
    true,
  );
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.queued_runs, 2);
  assert.equal(degraded.queued_over_threshold, 1);
  assert.equal(degraded.oldest_queued_minutes, 40);

  const stalled = summarizeOperationalHealth(
    [run("in_progress", "2026-07-15T11:00:00Z")],
    CHECKED_AT,
    true,
  );
  assert.equal(stalled.status, "stalled");
  assert.equal(stalled.running_over_threshold, 1);
  assert.equal(stalled.oldest_running_minutes, 180);
});

test("operational health fails closed when active-run telemetry is incomplete", () => {
  const health = summarizeOperationalHealth([], CHECKED_AT, false);
  assert.equal(health.status, "unknown");
  assert.equal(health.telemetry_complete, false);
});

test("operational health fails closed when an active run has no usable age", () => {
  const health = summarizeOperationalHealth([{ status: "queued" }], CHECKED_AT, true);
  assert.equal(health.status, "unknown");
  assert.equal(health.telemetry_complete, false);
  assert.equal(health.queued_runs, 1);
});

test("operational health measures execution from run start instead of queue admission", () => {
  const health = summarizeOperationalHealth(
    [
      {
        status: "in_progress",
        created_at: "2026-07-15T11:00:00Z",
        run_started_at: "2026-07-15T13:50:00Z",
      },
    ],
    CHECKED_AT,
    true,
  );
  assert.equal(health.status, "healthy");
  assert.equal(health.oldest_running_minutes, 10);
});

test("health history replaces duplicate five-minute slots", () => {
  const health = summarizeOperationalHealth(
    [run("queued", "2026-07-15T13:00:00Z")],
    CHECKED_AT,
    true,
  );
  const first = { ...legacyHistorySample(), status: health.status };
  const replacement = { ...first, at: "2026-07-15T14:04:59Z", queued: 2 };
  const next = mergeHealthHistorySample([first], replacement);
  assert.equal(next.length, 1);
  assert.equal(next[0].queued, 2);

  const lateOlderSample = { ...first, at: "2026-07-15T14:01:00Z", queued: 1 };
  const preserved = mergeHealthHistorySample(next, lateOlderSample);
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].at, replacement.at);
  assert.equal(preserved[0].queued, 2);
});

test("health history preserves legacy samples and normalizes exact-review backlog", () => {
  const legacy = legacyHistorySample();
  assert.deepEqual(normalizeHealthHistorySample(legacy), legacy);

  const exactReview = exactReviewHistorySample({
    lanes: {
      review: {
        pending: 317,
        enqueued_total: 90,
        completed_total: 70,
        shed_since_reset: 3,
      },
      publication: { pending: 1502, enqueued_total: 50, completed_total: 42 },
    },
  });
  const normalized = normalizeHealthHistorySample({ ...legacy, exact_review: exactReview });
  assert.deepEqual(normalized?.exact_review, {
    collection_ok: true,
    review: { pending: 317, enqueued_total: 90, completed_total: 70, shed_total: 3 },
    publication: { pending: 1502, enqueued_total: 50, completed_total: 42 },
  });
  assert.deepEqual(normalizeHealthHistorySample({ at: CHECKED_AT, exact_review: exactReview }), {
    at: CHECKED_AT,
    exact_review: exactReview,
  });
  assert.deepEqual(
    normalizeHealthHistorySample({
      at: CHECKED_AT,
      exact_review: {
        collection_ok: true,
        review: { pending: 8 },
        publication: { pending: 13, completed_total: 21 },
      },
    })?.exact_review,
    {
      collection_ok: true,
      review: { pending: 8 },
      publication: { pending: 13, completed_total: 21 },
    },
  );
  assert.deepEqual(exactReviewHistorySample(null), { collection_ok: false });
  assert.equal(
    normalizeHealthHistorySample({
      ...legacy,
      exact_review: { collection_ok: true, review: { pending: 1 } },
    })?.exact_review,
    undefined,
  );
  assert.deepEqual(
    normalizeHealthHistorySample({
      at: CHECKED_AT,
      exact_review: {
        collection_ok: true,
        review: { pending: 1, enqueued_total: -1, completed_total: 0 },
        publication: { pending: 1, enqueued_total: 0, completed_total: 0 },
      },
    })?.exact_review,
    {
      collection_ok: true,
      review: { pending: 1, enqueued_total: 0, completed_total: 0 },
      publication: { pending: 1, enqueued_total: 0, completed_total: 0 },
    },
  );
});

test("health history keeps legacy samples when optional state_writer is absent or invalid", () => {
  const legacy = legacyHistorySample();
  assert.equal(normalizeHealthHistorySample(legacy)?.state_writer, undefined);
  assert.deepEqual(
    normalizeHealthHistorySample({
      ...legacy,
      state_writer: {
        collection_ok: true,
        mode: "single_item",
        tracked_holding: 1,
        tracked_waiting: 2,
        tracked_releasing: 0,
        accepted_operations_total: 3,
        state_commits_total: 3,
        materialized_items_total: 3,
        contention_timeouts_total: 0,
        wait_ms: { p50: 10, p95: 20, samples: 3 },
        hold_ms: { p50: 30, p95: 40, samples: 3 },
        last_successful_materialization_at: CHECKED_AT,
      },
    })?.state_writer?.mode,
    "single_item",
  );
  const withInvalidWriter = normalizeHealthHistorySample({
    ...legacy,
    state_writer: { collection_ok: true, mode: "not-a-mode" },
  });
  assert.deepEqual(withInvalidWriter, legacy);
});

test("state writer history uses the coordinator while terminal progress is idle", () => {
  assert.deepEqual(
    stateWriterHistorySample({
      collection: { status: "stale" },
      coordinator: { queued: 3, leased: 1 },
      diagnostics: {
        accepted_terminal_total: 12,
        state_commits_total: 6,
        materialized_items_total: 11,
        contention_timeouts_total: 2,
      },
      last_15_minutes: {},
      live: { tracked_holding: 0, tracked_waiting: 0, tracked_releasing: 0 },
      mode: "batch",
    }),
    {
      collection_ok: true,
      terminal_collection_ok: false,
      mode: "batch",
      tracked_holding: 1,
      tracked_waiting: 3,
      tracked_releasing: 0,
      accepted_operations_total: 12,
      state_commits_total: 6,
      materialized_items_total: 11,
      contention_timeouts_total: 2,
      wait_ms: { p50: null, p95: null, samples: 0 },
      hold_ms: { p50: null, p95: null, samples: 0 },
      last_successful_materialization_at: null,
    },
  );
});

test("health history rejects non-finite or incomplete samples", () => {
  const sample = legacyHistorySample();
  assert.equal(normalizeHealthHistorySample({ ...sample, queued: "Infinity" }), null);
  const { running, ...incomplete } = sample;
  assert.equal(running, 0);
  assert.equal(normalizeHealthHistorySample(incomplete), null);
});
