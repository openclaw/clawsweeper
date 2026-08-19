import assert from "node:assert/strict";
import test from "node:test";

import {
  OPERATIONAL_QUEUE_ZOMBIE_MS,
  exactReviewHistorySample,
  mergeHealthHistorySample,
  normalizeHealthHistorySample,
  stateWriterHistorySample,
  summarizeOperationalHealth,
} from "../dashboard/operational-health.ts";

const CHECKED_AT = "2026-07-15T14:00:00.000Z";

function run(status: string, createdAt: string, runAttempt?: number) {
  return { status, created_at: createdAt, ...(runAttempt ? { run_attempt: runAttempt } : {}) };
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

test("operational health reports approval-gated runs outside queue congestion", () => {
  const health = summarizeOperationalHealth(
    [
      // A deployment waiting a week for human approval is not runner
      // congestion and must not degrade status or pin oldest_queued_minutes.
      run("waiting", "2026-07-08T14:00:00Z"),
      run("queued", "2026-07-15T13:55:00Z"),
    ],
    CHECKED_AT,
    true,
  );
  assert.equal(health.status, "healthy");
  assert.equal(health.queued_runs, 1);
  assert.equal(health.queued_over_threshold, 0);
  assert.equal(health.oldest_queued_minutes, 5);
  assert.equal(health.approval_gated_runs, 1);
  assert.equal(health.oldest_approval_gated_minutes, 7 * 24 * 60);
});

test("operational health surfaces zombie queue entries without degrading", () => {
  const health = summarizeOperationalHealth(
    [run("queued", "2026-07-14T13:00:00Z")],
    CHECKED_AT,
    true,
  );
  assert.equal(health.status, "healthy");
  assert.equal(health.queued_runs, 1);
  assert.equal(health.queued_over_threshold, 0);
  assert.equal(health.oldest_queued_minutes, 0);
  assert.equal(health.zombie_queued_runs, 1);
  assert.equal(health.oldest_zombie_queued_minutes, 25 * 60);
});

test("operational health keeps fresh queue pressure alongside zombies", () => {
  const health = summarizeOperationalHealth(
    [run("queued", "2026-07-14T13:00:00Z"), run("queued", "2026-07-15T13:29:00Z")],
    CHECKED_AT,
    true,
  );
  assert.equal(health.status, "degraded");
  assert.equal(health.queued_runs, 2);
  assert.equal(health.queued_over_threshold, 1);
  assert.equal(health.oldest_queued_minutes, 31);
  assert.equal(health.zombie_queued_runs, 1);
  assert.equal(health.oldest_zombie_queued_minutes, 25 * 60);
});

test("operational health treats exactly 24 hours as live queue pressure", () => {
  const boundary = new Date(Date.parse(CHECKED_AT) - OPERATIONAL_QUEUE_ZOMBIE_MS).toISOString();
  const health = summarizeOperationalHealth([run("queued", boundary)], CHECKED_AT, true);
  assert.equal(health.status, "degraded");
  assert.equal(health.queued_over_threshold, 1);
  assert.equal(health.oldest_queued_minutes, 24 * 60);
  assert.equal(health.zombie_queued_runs, 0);
  assert.equal(health.oldest_zombie_queued_minutes, 0);
});

test("operational health excludes wedged pre-queue reruns without hiding real queue pressure", () => {
  const wedged = summarizeOperationalHealth(
    [run("pending", "2026-07-15T12:30:00Z", 2)],
    CHECKED_AT,
    true,
  );
  assert.equal(wedged.status, "healthy");
  assert.equal(wedged.queued_runs, 1);
  assert.equal(wedged.queued_over_threshold, 0);
  assert.equal(wedged.oldest_queued_minutes, 0);
  assert.equal(wedged.wedged_rerun_runs, 1);
  assert.equal(wedged.oldest_wedged_rerun_minutes, 90);

  const freshRerun = summarizeOperationalHealth(
    [run("pending", "2026-07-15T13:58:00Z", 2)],
    CHECKED_AT,
    true,
  );
  assert.equal(freshRerun.status, "healthy");
  assert.equal(freshRerun.queued_runs, 1);
  assert.equal(freshRerun.oldest_queued_minutes, 2);
  assert.equal(freshRerun.wedged_rerun_runs, 0);
  assert.equal(freshRerun.oldest_wedged_rerun_minutes, 0);

  const thresholdRerun = summarizeOperationalHealth(
    [run("pending", "2026-07-15T13:00:00Z", 2)],
    CHECKED_AT,
    true,
  );
  assert.equal(thresholdRerun.status, "degraded");
  assert.equal(thresholdRerun.queued_over_threshold, 1);
  assert.equal(thresholdRerun.wedged_rerun_runs, 0);

  const genuinelyQueued = summarizeOperationalHealth(
    [run("queued", "2026-07-15T12:30:00Z", 2)],
    CHECKED_AT,
    true,
  );
  assert.equal(genuinelyQueued.status, "degraded");
  assert.equal(genuinelyQueued.queued_over_threshold, 1);
  assert.equal(genuinelyQueued.wedged_rerun_runs, 0);
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
  const replacement = { ...first, at: "2026-07-15T14:04:59.000Z", queued: 2 };
  const next = mergeHealthHistorySample([first], replacement);
  assert.equal(next.length, 1);
  assert.equal(next[0].queued, 2);

  const lateOlderSample = { ...first, at: "2026-07-15T14:01:00.000Z", queued: 1 };
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
        enqueued_total: 10_000_090,
        completed_total: 10_000_070,
        shed_since_reset: 3,
      },
      publication: {
        pending: 1502,
        enqueued_total: 10_000_050,
        completed_total: 10_000_042,
      },
    },
    handoff_health: {
      status: "degraded",
      phases: {
        pending: { count: 317 },
        dispatching: { count: 8 },
        leased: { count: 34 },
      },
    },
  });
  const normalized = normalizeHealthHistorySample({ ...legacy, exact_review: exactReview });
  assert.deepEqual(normalized?.exact_review, {
    collection_ok: true,
    review: {
      pending: 317,
      enqueued_total: 10_000_090,
      completed_total: 10_000_070,
      shed_total: 3,
    },
    publication: {
      pending: 1502,
      enqueued_total: 10_000_050,
      completed_total: 10_000_042,
    },
    handoff: { status: "degraded", pending: 317, dispatching: 8, leased: 34 },
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
  assert.equal(
    normalizeHealthHistorySample({
      at: CHECKED_AT,
      exact_review: {
        collection_ok: true,
        review: { pending: 1, enqueued_total: -1, completed_total: 0 },
        publication: { pending: 1, enqueued_total: 0, completed_total: 0 },
      },
    }),
    null,
  );
  assert.equal(
    normalizeHealthHistorySample({
      at: CHECKED_AT,
      exact_review: {
        collection_ok: true,
        review: { pending: 1, enqueued_total: 1_000_000_000_001, completed_total: 0 },
        publication: { pending: 1, enqueued_total: 0, completed_total: 0 },
      },
    }),
    null,
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

test("health history strictly bounds stored counts and canonicalizes timestamps", () => {
  const sample = legacyHistorySample();
  for (const queued of ["0", -1, 1.5, Number.MAX_SAFE_INTEGER, 10_000_001]) {
    assert.equal(normalizeHealthHistorySample({ ...sample, queued }), null);
  }

  assert.equal(
    normalizeHealthHistorySample({ ...sample, at: "2026-07-15T15:00:00+01:00" })?.at,
    CHECKED_AT,
  );
  assert.equal(normalizeHealthHistorySample({ ...sample, at: `${CHECKED_AT} unexpected` }), null);
  assert.equal(normalizeHealthHistorySample({ ...sample, at: "1171-01-01T00:00:00Z" }), null);
  assert.deepEqual(
    normalizeHealthHistorySample({
      at: CHECKED_AT,
      state_writer: {
        collection_ok: true,
        mode: "batch",
        tracked_holding: 0,
        tracked_waiting: 0,
        tracked_releasing: 0,
        accepted_operations_total: 0,
        state_commits_total: 0,
        materialized_items_total: 0,
        contention_timeouts_total: 0,
        wait_ms: { p50: null, p95: null, samples: 0 },
        hold_ms: { p50: null, p95: null, samples: 0 },
        last_successful_materialization_at: "2026-07-15T15:00:00+01:00",
      },
    })?.state_writer?.last_successful_materialization_at,
    CHECKED_AT,
  );
  assert.equal(
    normalizeHealthHistorySample({
      at: CHECKED_AT,
      state_writer: {
        collection_ok: true,
        mode: "batch",
        tracked_holding: 0,
        tracked_waiting: 0,
        tracked_releasing: 0,
        accepted_operations_total: 0,
        state_commits_total: 0,
        materialized_items_total: 0,
        contention_timeouts_total: 0,
        wait_ms: { p50: null, p95: null, samples: 0 },
        hold_ms: { p50: null, p95: null, samples: 0 },
        last_successful_materialization_at: "1171-01-01T00:00:00Z",
      },
    })?.state_writer?.last_successful_materialization_at,
    undefined,
  );
  assert.equal(
    normalizeHealthHistorySample({
      at: CHECKED_AT,
      exact_review: {
        collection_ok: true,
        review: { pending: "1" },
        publication: { pending: 0 },
      },
    }),
    null,
  );
});
