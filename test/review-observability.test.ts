import assert from "node:assert/strict";
import test from "node:test";

import type { DurableReviewRunTelemetry } from "../dashboard/review-run-telemetry.ts";
import {
  summarizeReviewObservability,
  type ReviewObservability,
} from "../dashboard/review-observability.ts";

const NOW = Date.parse("2026-07-19T12:00:00Z");

function wave(
  lane: DurableReviewRunTelemetry["trigger_lane"],
  minutesAgo: number,
  overrides: Partial<DurableReviewRunTelemetry> = {},
): DurableReviewRunTelemetry {
  const completedAt = new Date(NOW - minutesAgo * 60_000).toISOString();
  return {
    run_id: String(10000 + minutesAgo),
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: lane,
    trigger_origin: "schedule",
    target_repo: "openclaw/openclaw",
    started_at: new Date(NOW - (minutesAgo + 5) * 60_000).toISOString(),
    completed_at: completedAt,
    run_url: `https://github.com/openclaw/clawsweeper/actions/runs/${10000 + minutesAgo}`,
    plan_count: 1,
    item_count: 2,
    publication_count: 1,
    ...overrides,
  };
}

function summary(
  runs = [wave("hot_intake", 2), wave("normal_backfill", 2)],
  overrides: Partial<Parameters<typeof summarizeReviewObservability>[0]> = {},
): ReviewObservability {
  return summarizeReviewObservability({
    runs,
    range: "24h",
    repo: null,
    required: true,
    recoveryEnabled: false,
    now: NOW,
    ...overrides,
  });
}

test("review observability exposes only run-level lane freshness", () => {
  const result = summary();
  assert.deepEqual(Object.keys(result), [
    "mode",
    "health",
    "reasons",
    "range",
    "repo",
    "generated_at",
    "telemetry_complete",
    "sources",
  ]);
  assert.deepEqual(
    result.sources.map((source) => source.lane),
    ["exact_event", "hot_intake", "normal_backfill", "recovery"],
  );
  assert.equal(result.health, "healthy");
  assert.equal(result.sources.find((source) => source.lane === "exact_event")?.status, "idle");
  assert.equal(result.sources.find((source) => source.lane === "recovery")?.status, "disabled");
  assert.equal(result.sources.find((source) => source.lane === "hot_intake")?.run_count, 1);
  assert.equal(result.sources.find((source) => source.lane === "hot_intake")?.item_count, 2);
});

test("review observability remains passive when telemetry is not required", () => {
  const result = summary([], { required: false });
  assert.equal(result.mode, "passive");
  assert.equal(result.health, "passive");
  assert.deepEqual(result.reasons, []);
  assert.ok(result.sources.every((source) => source.status === "passive"));
});

test("periodic lane freshness still controls required health", () => {
  const missing = summary([]);
  assert.equal(missing.health, "critical");
  assert.deepEqual(missing.reasons, [
    "hot_intake_missed_cadence",
    "normal_backfill_missed_cadence",
  ]);

  const stale = summary([wave("hot_intake", 11), wave("normal_backfill", 11)]);
  assert.equal(stale.health, "degraded");
  assert.deepEqual(stale.reasons, ["hot_intake_degraded", "normal_backfill_degraded"]);

  const failed = summary([
    wave("hot_intake", 2, { workflow_outcome: "failure" }),
    wave("normal_backfill", 2),
  ]);
  assert.equal(failed.health, "degraded");
  assert.deepEqual(failed.reasons, ["hot_intake_degraded"]);
});

test("required warmup preserves lane gating semantics", () => {
  const result = summary([], { requiredSince: NOW - 10 * 60_000 });
  assert.equal(result.mode, "warmup");
  assert.equal(result.health, "healthy");
  assert.deepEqual(result.reasons, []);
  assert.ok(
    result.sources.every((source) => source.status === "idle" || source.status === "disabled"),
  );
});

test("incomplete run telemetry degrades required health", () => {
  const result = summary(undefined, { telemetryComplete: false });
  assert.equal(result.telemetry_complete, false);
  assert.equal(result.health, "degraded");
  assert.deepEqual(result.reasons, ["telemetry_unavailable"]);
});

test("range and repository filters apply to run counts", () => {
  const result = summarizeReviewObservability({
    runs: [
      wave("hot_intake", 2),
      wave("hot_intake", 3, { target_repo: "openclaw/clawhub", run_id: "11003" }),
      wave("hot_intake", 7 * 60, { run_id: "11004" }),
      wave("normal_backfill", 2),
    ],
    range: "6h",
    repo: "openclaw/openclaw",
    required: true,
    now: NOW,
  });
  assert.equal(result.sources.find((source) => source.lane === "hot_intake")?.run_count, 1);
});

test("repo filters retain unattributed freshness without claiming attribution", () => {
  const result = summarizeReviewObservability({
    runs: [wave("hot_intake", 2, { target_repo: null, item_count: 9 }), wave("normal_backfill", 2)],
    range: "24h",
    repo: "openclaw/openclaw",
    required: true,
    now: NOW,
  });
  const hotIntake = result.sources.find((source) => source.lane === "hot_intake");
  assert.equal(hotIntake?.status, "degraded");
  assert.equal(hotIntake?.attribution, "unavailable");
  assert.equal(hotIntake?.run_count, 1);
  assert.equal(hotIntake?.item_count, 9);
});
