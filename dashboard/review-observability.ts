import type { DurableReviewRunTelemetry } from "./review-run-telemetry.ts";
import {
  REVIEW_TELEMETRY_DEGRADED_MS,
  REVIEW_TELEMETRY_ORPHAN_MS,
  type DurableReviewTelemetry,
  type ReviewTriggerLane,
} from "./review-telemetry.ts";

export const REVIEW_OBSERVABILITY_RANGES = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
} as const;
export const REVIEW_OBSERVABILITY_WARMUP_MS = 30 * 60 * 1000;

const LANE_POLICY: Record<
  ReviewTriggerLane,
  { label: string; cadenceMs: number | null; optional?: boolean }
> = {
  exact_event: { label: "Exact event", cadenceMs: null },
  hot_intake: { label: "Hot intake", cadenceMs: 5 * 60 * 1000 },
  normal_backfill: { label: "Normal backfill", cadenceMs: 5 * 60 * 1000 },
  recovery: { label: "Recovery", cadenceMs: null, optional: true },
};

export type ReviewObservability = ReturnType<typeof summarizeReviewObservability>;

export function summarizeReviewObservability(options: {
  records: readonly DurableReviewTelemetry[];
  runs: readonly DurableReviewRunTelemetry[];
  range: keyof typeof REVIEW_OBSERVABILITY_RANGES;
  repo: string | null;
  required: boolean;
  requiredSince?: number;
  recoveryEnabled?: boolean;
  telemetryComplete?: boolean;
  now?: number;
}) {
  const now = options.now ?? Date.now();
  const rangeMs = REVIEW_OBSERVABILITY_RANGES[options.range];
  const from = now - rangeMs;
  const records = options.records.filter(
    (record) =>
      (record.status === "refreshing" || reviewTerminalTime(record) >= from) &&
      (!options.repo || record.repo === options.repo),
  );
  const runs = options.runs.filter(
    (run) =>
      Date.parse(run.completed_at) >= from &&
      (!options.repo || run.target_repo === null || run.target_repo === options.repo),
  );
  const refreshing = records.filter((record) => record.status === "refreshing");
  const completed = records.filter((record) => record.status === "completed");
  const slow = refreshing.filter(
    (record) => now - Date.parse(record.updated_at) >= REVIEW_TELEMETRY_DEGRADED_MS,
  );
  const orphans = refreshing.filter(
    (record) =>
      now - Date.parse(record.updated_at) >= REVIEW_TELEMETRY_ORPHAN_MS &&
      (record.lease_expires_at === null || Date.parse(record.lease_expires_at) <= now),
  );
  const recoveredFailures = recoveredFailureKeys(completed);
  const outcomes = Object.fromEntries(
    ["succeeded", "failed", "interrupted", "cancelled", "superseded"].map((outcome) => [
      outcome,
      completed.filter((record) => record.outcome === outcome).length,
    ]),
  ) as Record<NonNullable<DurableReviewTelemetry["outcome"]>, number>;
  const unresolvedFailures = completed.filter(
    (record) => record.outcome === "failed" && !recoveredFailures.has(attemptKey(record)),
  );
  const itemTerminalAnomalyRuns = new Set(
    completed
      .filter((record) => ["failed", "interrupted", "cancelled"].includes(String(record.outcome)))
      .map(runAttemptKey),
  );
  const runTerminalAnomalies = runs.filter(
    (run) =>
      ["failure", "cancelled"].includes(run.workflow_outcome) &&
      !itemTerminalAnomalyRuns.has(runAttemptKey(run)),
  );
  const { expectedAttempts, terminalAttempts } = reviewCoverage(
    records,
    runs.filter((run) => !options.repo || run.target_repo === options.repo),
  );
  const terminalCoverage = expectedAttempts ? terminalAttempts / expectedAttempts : null;
  const abnormalCount =
    unresolvedFailures.length +
    outcomes.interrupted +
    outcomes.cancelled +
    runTerminalAnomalies.length;
  const abnormalSamples = completed.length + runTerminalAnomalies.length;
  const abnormalRate = abnormalSamples ? abnormalCount / abnormalSamples : 0;
  const warmup =
    options.required &&
    options.requiredSince !== undefined &&
    now - options.requiredSince < REVIEW_OBSERVABILITY_WARMUP_MS;
  const sources = (Object.keys(LANE_POLICY) as ReviewTriggerLane[]).map((lane) =>
    summarizeLane({
      lane,
      runs: runs.filter((run) => run.trigger_lane === lane),
      now,
      required: options.required,
      warmup,
      recoveryEnabled: options.recoveryEnabled === true,
      repo: options.repo,
    }),
  );

  let health: "passive" | "healthy" | "degraded" | "critical" = options.required
    ? "healthy"
    : "passive";
  const reasons: string[] = [];
  const raise = (next: "degraded" | "critical", reason: string) => {
    reasons.push(reason);
    if (options.required && (next === "critical" || health === "healthy")) health = next;
  };
  if (options.required && !warmup) {
    if (options.telemetryComplete === false) raise("degraded", "telemetry_unavailable");
    if (expectedAttempts >= 10 && terminalCoverage !== null && terminalCoverage < 0.9) {
      raise("critical", "terminal_coverage_critical");
    } else if (expectedAttempts > 0 && terminalCoverage !== null && terminalCoverage < 0.98) {
      raise("degraded", "terminal_coverage_degraded");
    }
    if (orphans.length) raise("critical", "orphan_review_attempt");
    else if (slow.length) raise("degraded", "slow_review_attempt");
    if (abnormalSamples >= 5 && abnormalRate >= 0.2) {
      raise("critical", "review_abnormal_rate_critical");
    } else if (abnormalCount) {
      raise("degraded", "review_terminal_anomaly");
    }
    for (const source of sources) {
      if (source.status === "critical") raise("critical", `${source.lane}_missed_cadence`);
      else if (source.status === "degraded") raise("degraded", `${source.lane}_degraded`);
    }
  }

  return {
    mode: options.required ? (warmup ? "warmup" : "required") : "passive",
    health,
    reasons: [...new Set(reasons)],
    range: options.range,
    repo: options.repo ?? "all",
    generated_at: new Date(now).toISOString(),
    telemetry_complete: options.telemetryComplete !== false,
    terminal_coverage: terminalCoverage === null ? null : round(terminalCoverage * 100, 1),
    expected_attempts: expectedAttempts,
    terminal_attempts: terminalAttempts,
    success_rate_percent: reviewSuccessRate(outcomes, unresolvedFailures.length),
    outcomes,
    recovered_failures: recoveredFailures.size,
    unresolved_failures: unresolvedFailures.length,
    expected_superseded: outcomes.superseded,
    unexpected_cancelled: outcomes.cancelled,
    refreshing: refreshing.length,
    slow: slow.length,
    orphan: orphans.length,
    abnormal_rate_percent: round(abnormalRate * 100, 1),
    phases: phasePercentiles(completed),
    sources,
    anomalies: anomalyRows({ records, runs: runTerminalAnomalies, recoveredFailures, now }).slice(
      0,
      20,
    ),
  };
}

function reviewTerminalTime(record: DurableReviewTelemetry) {
  // A range describes when an attempt reached terminal truth. Using its start
  // would make attempts crossing the boundary look like missing telemetry.
  return Date.parse(record.terminal_at ?? record.updated_at);
}

function summarizeLane(options: {
  lane: ReviewTriggerLane;
  runs: readonly DurableReviewRunTelemetry[];
  now: number;
  required: boolean;
  warmup: boolean;
  recoveryEnabled: boolean;
  repo: string | null;
}) {
  const policy = LANE_POLICY[options.lane];
  const attributedRuns = options.repo
    ? options.runs.filter((run) => run.target_repo === options.repo)
    : options.runs;
  const newest = [...attributedRuns].sort(
    (left, right) => Date.parse(right.completed_at) - Date.parse(left.completed_at),
  );
  const hasOnlyUnattributedRuns =
    options.repo !== null && !newest.length && options.runs.some((run) => run.target_repo === null);
  const lastRun = newest[0];
  const lastSuccess = newest.find((run) => run.workflow_outcome === "success");
  let status: "passive" | "disabled" | "idle" | "healthy" | "degraded" | "critical";
  if (!options.required) status = "passive";
  else if (options.lane === "recovery" && !options.recoveryEnabled) status = "disabled";
  else if (options.warmup) status = "idle";
  else if (hasOnlyUnattributedRuns) status = "degraded";
  else if (!lastRun) status = policy.cadenceMs === null ? "idle" : "critical";
  else if (policy.cadenceMs === null) status = "healthy";
  else {
    const age = options.now - Date.parse(lastRun.completed_at);
    status =
      age > policy.cadenceMs * 3
        ? "critical"
        : lastRun.workflow_outcome !== "success" || age > policy.cadenceMs * 2
          ? "degraded"
          : "healthy";
  }
  return {
    lane: options.lane,
    label: policy.label,
    status,
    last_run_at: lastRun?.completed_at ?? null,
    last_success_at: lastSuccess?.completed_at ?? null,
    item_count: options.runs.reduce((total, run) => total + run.item_count, 0),
    run_count: options.runs.length,
    attribution: hasOnlyUnattributedRuns ? "unavailable" : "available",
  };
}

function reviewCoverage(
  records: readonly DurableReviewTelemetry[],
  runs: readonly DurableReviewRunTelemetry[],
) {
  const groups = new Map<string, { records: number; terminal: number; observed: number }>();
  for (const record of records) {
    const key = `${record.run_id}:${record.run_attempt}`;
    const group = groups.get(key) ?? { records: 0, terminal: 0, observed: 0 };
    group.records += 1;
    if (record.status === "completed") group.terminal += 1;
    groups.set(key, group);
  }
  for (const run of runs) {
    const key = `${run.run_id}:${run.run_attempt}`;
    const group = groups.get(key) ?? { records: 0, terminal: 0, observed: 0 };
    group.observed = Math.max(group.observed, run.item_count);
    groups.set(key, group);
  }
  let expectedAttempts = 0;
  let terminalAttempts = 0;
  for (const group of groups.values()) {
    const expected = Math.max(group.records, group.observed);
    expectedAttempts += expected;
    terminalAttempts += Math.min(group.terminal, expected);
  }
  return { expectedAttempts, terminalAttempts };
}

function phasePercentiles(records: readonly DurableReviewTelemetry[]) {
  return Object.fromEntries(
    ["queue", "claim", "review", "publication", "total"].map((phase) => {
      const values = records
        .map((record) => record.phase_durations_ms[phase as keyof typeof record.phase_durations_ms])
        .filter((value): value is number => Number.isFinite(value))
        .sort((left, right) => left - right);
      return [phase, { p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) }];
    }),
  );
}

function percentile(values: readonly number[], quantile: number) {
  if (!values.length) return null;
  return values[Math.ceil(quantile * values.length) - 1] ?? values.at(-1) ?? null;
}

function reviewSuccessRate(
  outcomes: Record<NonNullable<DurableReviewTelemetry["outcome"]>, number>,
  unresolvedFailures: number,
) {
  const denominator =
    outcomes.succeeded + unresolvedFailures + outcomes.cancelled + outcomes.interrupted;
  return denominator ? round((outcomes.succeeded / denominator) * 100, 1) : null;
}

function recoveredFailureKeys(records: readonly DurableReviewTelemetry[]) {
  const successes = new Map<string, number>();
  for (const record of records) {
    if (record.outcome === "succeeded" && record.operation_id) {
      const operationKey = `${record.repo}\u0000${record.operation_id}`;
      successes.set(
        operationKey,
        Math.max(
          successes.get(operationKey) ?? 0,
          Date.parse(record.terminal_at ?? record.updated_at),
        ),
      );
    }
  }
  return new Set(
    records
      .filter(
        (record) =>
          record.outcome === "failed" &&
          record.operation_id &&
          (successes.get(`${record.repo}\u0000${record.operation_id}`) ?? 0) >
            Date.parse(record.terminal_at ?? record.updated_at),
      )
      .map(attemptKey),
  );
}

function anomalyRows(options: {
  records: readonly DurableReviewTelemetry[];
  runs: readonly DurableReviewRunTelemetry[];
  recoveredFailures: ReadonlySet<string>;
  now: number;
}) {
  const itemRows = options.records.flatMap((record) => {
    const age = options.now - Date.parse(record.updated_at);
    const orphan =
      record.status === "refreshing" &&
      age >= REVIEW_TELEMETRY_ORPHAN_MS &&
      (record.lease_expires_at === null || Date.parse(record.lease_expires_at) <= options.now);
    const slow = record.status === "refreshing" && age >= REVIEW_TELEMETRY_DEGRADED_MS;
    const unresolved =
      record.outcome === "failed" && !options.recoveredFailures.has(attemptKey(record));
    if (
      !orphan &&
      !slow &&
      !unresolved &&
      !["cancelled", "interrupted"].includes(String(record.outcome))
    ) {
      return [];
    }
    return [
      {
        kind: orphan ? "orphan" : slow ? "slow" : record.outcome,
        repo: record.repo,
        item_number: record.item_number,
        item_url: `https://github.com/${record.repo}/issues/${record.item_number}`,
        run_url: `https://github.com/openclaw/clawsweeper/actions/runs/${record.run_id}`,
        run_id: record.run_id,
        run_attempt: record.run_attempt,
        at: record.terminal_at ?? record.updated_at,
        reason: record.terminal_reason ?? null,
      },
    ];
  });
  const runRows = options.runs
    .filter((run) => ["failure", "cancelled"].includes(run.workflow_outcome))
    .map((run) => ({
      kind: `workflow_${run.workflow_outcome}`,
      repo: run.target_repo,
      item_number: null,
      item_url: null,
      run_url: run.run_url,
      run_id: run.run_id,
      run_attempt: run.run_attempt,
      at: run.completed_at,
      reason: null,
    }));
  return [...itemRows, ...runRows].sort(
    (left, right) => Date.parse(right.at) - Date.parse(left.at),
  );
}

function attemptKey(record: DurableReviewTelemetry) {
  return `${record.repo}#${record.item_number}:${record.run_id}:${record.run_attempt}`;
}

function runAttemptKey(record: { run_id: string; run_attempt: number }) {
  return `${record.run_id}:${record.run_attempt}`;
}

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
