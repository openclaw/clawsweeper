import assert from "node:assert/strict";
import test from "node:test";

import {
  exactReviewHistorySample,
  healthHistorySample,
  mergeHealthHistorySample,
  normalizeHealthHistorySample,
  summarizeOperationalHealth,
} from "../dashboard/operational-health.ts";

const CHECKED_AT = "2026-07-15T14:00:00Z";

function run(status: string, createdAt: string) {
  return { status, created_at: createdAt };
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
  const first = healthHistorySample(health);
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
  const legacy = healthHistorySample(summarizeOperationalHealth([], CHECKED_AT, true));
  assert.deepEqual(normalizeHealthHistorySample(legacy), legacy);

  const exactReview = exactReviewHistorySample({
    lanes: { review: { pending: 317 }, publication: { pending: 1502 } },
  });
  const normalized = normalizeHealthHistorySample({ ...legacy, exact_review: exactReview });
  assert.deepEqual(normalized?.exact_review, {
    collection_ok: true,
    review: { pending: 317 },
    publication: { pending: 1502 },
  });
  assert.deepEqual(exactReviewHistorySample(null), { collection_ok: false });
  assert.equal(
    normalizeHealthHistorySample({
      ...legacy,
      exact_review: { collection_ok: true, review: { pending: 1 } },
    })?.exact_review,
    undefined,
  );
});

test("health history rejects non-finite or incomplete samples", () => {
  const sample = healthHistorySample(summarizeOperationalHealth([], CHECKED_AT, true));
  assert.equal(normalizeHealthHistorySample({ ...sample, queued: "Infinity" }), null);
  const { running, ...incomplete } = sample;
  assert.equal(running, 0);
  assert.equal(normalizeHealthHistorySample(incomplete), null);
});
