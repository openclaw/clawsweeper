import assert from "node:assert/strict";
import test from "node:test";

import type { DurableReviewRunTelemetry } from "../dashboard/review-run-telemetry.ts";
import {
  summarizeReviewObservability,
  type ReviewObservability,
} from "../dashboard/review-observability.ts";
import type { DurableReviewTelemetry } from "../dashboard/review-telemetry.ts";

const NOW = Date.parse("2026-07-19T12:00:00Z");

function item(
  number: number,
  outcome: DurableReviewTelemetry["outcome"] = "succeeded",
  overrides: Partial<DurableReviewTelemetry> = {},
): DurableReviewTelemetry {
  return {
    repo: "openclaw/openclaw",
    item_number: number,
    run_id: String(9000 + number),
    run_attempt: 1,
    status: outcome === null ? "refreshing" : "completed",
    outcome,
    started_at: "2026-07-19T11:00:00.000Z",
    updated_at: "2026-07-19T11:10:00.000Z",
    lease_expires_at: outcome === null ? "2026-07-19T13:00:00.000Z" : null,
    phase_durations_ms: { total: number * 1_000 },
    trigger_lane: "exact_event",
    trigger_origin: "webhook",
    ...(outcome === null
      ? {}
      : { terminal_at: "2026-07-19T11:10:00.000Z", terminal_reason: "completed" }),
    ...overrides,
  };
}

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
    item_count: 0,
    publication_count: 1,
    ...overrides,
  };
}

function summary(
  records: DurableReviewTelemetry[],
  runs = [wave("hot_intake", 2), wave("normal_backfill", 2)],
): ReviewObservability {
  return summarizeReviewObservability({
    records,
    runs,
    range: "24h",
    repo: null,
    required: true,
    recoveryEnabled: false,
    now: NOW,
  });
}

test("review observability is passive before v2 producers are required", () => {
  const result = summarizeReviewObservability({
    records: [],
    runs: [],
    range: "24h",
    repo: null,
    required: false,
    now: NOW,
  });
  assert.equal(result.mode, "passive");
  assert.equal(result.health, "passive");
  assert.ok(result.sources.every((source) => source.status === "passive"));
});

test("review observability reports green coverage, percentiles, and lane freshness", () => {
  const result = summary([item(1), item(2), item(3), item(4)]);
  assert.equal(result.health, "healthy");
  assert.equal(result.terminal_coverage, 100);
  assert.equal(result.success_rate_percent, 100);
  assert.deepEqual(result.phases.total, { p50_ms: 2_000, p95_ms: 4_000 });
  assert.equal(result.sources.find((source) => source.lane === "exact_event")?.status, "idle");
  assert.equal(result.sources.find((source) => source.lane === "recovery")?.status, "disabled");
});

test("workflow jobs provide an independent denominator for missing item telemetry", () => {
  const result = summary(
    [item(1, "succeeded", { run_id: "10002" })],
    [wave("hot_intake", 2, { item_count: 10 }), wave("normal_backfill", 2)],
  );
  assert.equal(result.expected_attempts, 10);
  assert.equal(result.terminal_attempts, 1);
  assert.equal(result.terminal_coverage, 10);
  assert.equal(result.health, "critical");
});

test("coverage sums disjoint run populations instead of masking missing telemetry", () => {
  const result = summary(
    Array.from({ length: 5 }, (_, index) => item(index + 1, "succeeded", { run_id: "20000" })),
    [wave("hot_intake", 2, { run_id: "20001", item_count: 5 }), wave("normal_backfill", 2)],
  );
  assert.equal(result.expected_attempts, 10);
  assert.equal(result.terminal_attempts, 5);
  assert.equal(result.terminal_coverage, 50);
});

test("completed attempts are ranged by terminal time instead of start time", () => {
  const result = summary([
    item(1, "succeeded", {
      run_id: "10002",
      started_at: "2026-07-18T11:59:00.000Z",
      updated_at: "2026-07-18T12:01:00.000Z",
      terminal_at: "2026-07-18T12:01:00.000Z",
    }),
  ]);
  assert.equal(result.expected_attempts, 1);
  assert.equal(result.terminal_attempts, 1);
  assert.equal(result.terminal_coverage, 100);
});

test("expected supersession is health-neutral while cancellation and missed cadence are amber", () => {
  assert.equal(summary([item(1, "superseded")]).health, "healthy");
  const cancelled = summary([item(1, "cancelled", { terminal_reason: "workflow_cancelled" })]);
  assert.equal(cancelled.health, "degraded");
  assert.equal(cancelled.unexpected_cancelled, 1);
  assert.equal(cancelled.success_rate_percent, 0);
  const staleLane = summary([item(1)], [wave("hot_intake", 11), wave("normal_backfill", 11)]);
  assert.equal(staleLane.health, "degraded");
});

test("workflow failure evidence degrades health when item terminals do not explain it", () => {
  const result = summary(
    [item(1, "succeeded")],
    [
      wave("hot_intake", 4, { run_id: "30000", workflow_outcome: "failure" }),
      wave("hot_intake", 2),
      wave("normal_backfill", 2),
    ],
  );
  assert.equal(result.health, "degraded");
  assert.ok(result.reasons.includes("review_terminal_anomaly"));
  assert.ok(result.anomalies.some((row) => row.kind === "workflow_failure"));
});

test("item terminal anomalies suppress duplicate workflow anomaly rows", () => {
  const result = summary(
    [item(1, "failed", { run_id: "31000" })],
    [
      wave("hot_intake", 2, { run_id: "31000", workflow_outcome: "failure", item_count: 1 }),
      wave("normal_backfill", 2),
    ],
  );
  assert.ok(result.anomalies.some((row) => row.kind === "failed"));
  assert.ok(!result.anomalies.some((row) => row.kind === "workflow_failure"));
});

test("periodic lanes become critical when no run or only a stale failed run remains", () => {
  assert.equal(summary([item(1)], []).health, "critical");
  const staleFailure = summary(
    [item(1)],
    [
      wave("hot_intake", 16, { workflow_outcome: "failure" }),
      wave("normal_backfill", 16, { workflow_outcome: "failure" }),
    ],
  );
  assert.equal(staleFailure.health, "critical");
});

test("review observability makes low coverage, orphan attempts, and high anomaly rates red", () => {
  const lowCoverage = summary([
    ...Array.from({ length: 8 }, (_, index) => item(index + 1)),
    item(9, null),
    item(10, null),
  ]);
  assert.equal(lowCoverage.health, "critical");
  assert.ok(lowCoverage.reasons.includes("terminal_coverage_critical"));

  const orphan = item(20, null, {
    started_at: "2026-07-19T08:00:00.000Z",
    updated_at: "2026-07-19T09:00:00.000Z",
    lease_expires_at: null,
  });
  assert.equal(summary([orphan]).health, "critical");

  const highAnomaly = summary([item(30, "cancelled"), item(31), item(32), item(33), item(34)]);
  assert.equal(highAnomaly.health, "critical");
  assert.ok(highAnomaly.reasons.includes("review_abnormal_rate_critical"));

  const missedCadence = summary([item(40)], [wave("hot_intake", 16), wave("normal_backfill", 16)]);
  assert.equal(missedCadence.health, "critical");
});

test("a later success recovers the same operation failure without erasing its count", () => {
  const result = summary([
    item(1, "failed", {
      operation_id: "review:674",
      terminal_at: "2026-07-19T11:05:00.000Z",
      updated_at: "2026-07-19T11:05:00.000Z",
    }),
    item(1, "succeeded", {
      run_id: "9999",
      operation_id: "review:674",
      terminal_at: "2026-07-19T11:15:00.000Z",
      updated_at: "2026-07-19T11:15:00.000Z",
    }),
  ]);
  assert.equal(result.outcomes.failed, 1);
  assert.equal(result.recovered_failures, 1);
  assert.equal(result.unresolved_failures, 0);
  assert.equal(result.health, "healthy");
});

test("operation recovery never crosses repository identity", () => {
  const result = summary([
    item(1, "failed", {
      operation_id: "shared-operation",
      terminal_at: "2026-07-19T11:05:00.000Z",
      updated_at: "2026-07-19T11:05:00.000Z",
    }),
    item(2, "succeeded", {
      repo: "openclaw/clawhub",
      operation_id: "shared-operation",
      terminal_at: "2026-07-19T11:15:00.000Z",
      updated_at: "2026-07-19T11:15:00.000Z",
    }),
  ]);
  assert.equal(result.recovered_failures, 0);
  assert.equal(result.unresolved_failures, 1);
  assert.equal(result.health, "degraded");
});

test("range and repo filters exclude unrelated telemetry and anomalies stay bounded", () => {
  const records = Array.from({ length: 25 }, (_, index) => item(index + 1, "cancelled"));
  records.push(
    item(99, "failed", {
      repo: "openclaw/clawhub",
      started_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T01:00:00.000Z",
      terminal_at: "2026-07-01T01:00:00.000Z",
    }),
  );
  const result = summarizeReviewObservability({
    records,
    runs: [wave("hot_intake", 2), wave("normal_backfill", 2)],
    range: "6h",
    repo: "openclaw/openclaw",
    required: true,
    now: NOW,
  });
  assert.equal(result.expected_attempts, 25);
  assert.equal(result.anomalies.length, 20);
});

test("repo filters preserve unattributed run evidence without assigning its attempts", () => {
  const result = summarizeReviewObservability({
    records: [item(1)],
    runs: [
      wave("hot_intake", 2, { target_repo: null, item_count: 9 }),
      wave("normal_backfill", 2, { target_repo: "openclaw/openclaw" }),
    ],
    range: "24h",
    repo: "openclaw/openclaw",
    required: true,
    now: NOW,
  });
  const hotIntake = result.sources.find((source) => source.lane === "hot_intake");
  assert.equal(result.expected_attempts, 1);
  assert.equal(hotIntake?.status, "degraded");
  assert.equal(hotIntake?.attribution, "unavailable");
  assert.equal(hotIntake?.item_count, 9);
});
