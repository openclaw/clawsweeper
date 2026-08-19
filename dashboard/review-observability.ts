import { type DurableReviewRunTelemetry, type ReviewTriggerLane } from "./review-run-telemetry.ts";

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
  const runs = options.runs.filter(
    (run) =>
      Date.parse(run.completed_at) >= from &&
      (!options.repo || run.target_repo === null || run.target_repo === options.repo),
  );
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
    sources,
  };
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
