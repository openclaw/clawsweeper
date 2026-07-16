export const OPERATIONAL_QUEUE_DEGRADED_MS = 30 * 60 * 1000;
export const OPERATIONAL_RUNNING_STALLED_MS = 150 * 60 * 1000;
export const HEALTH_HISTORY_SAMPLE_MS = 5 * 60 * 1000;
export const HEALTH_HISTORY_RETENTION_DAYS = 7;

const QUEUED_STATUSES = new Set(["queued", "waiting", "requested", "pending"]);

type WorkflowRun = {
  status?: string;
  created_at?: string;
  run_started_at?: string;
};

export type OperationalHealth = {
  status: "healthy" | "degraded" | "stalled" | "unknown";
  checked_at: string;
  telemetry_complete: boolean;
  queued_runs: number;
  queued_over_threshold: number;
  queued_threshold_minutes: number;
  oldest_queued_minutes: number;
  running_runs: number;
  running_over_threshold: number;
  running_threshold_minutes: number;
  oldest_running_minutes: number;
};

export type HealthHistorySample = {
  at: string;
  status?: OperationalHealth["status"];
  queued?: number;
  queued_over_30m?: number;
  oldest_queued_minutes?: number;
  running?: number;
  running_over_150m?: number;
  oldest_running_minutes?: number;
  collection_ok?: boolean;
  exact_review?: ExactReviewHistorySample;
};

export type ExactReviewHistorySample = {
  collection_ok: boolean;
  review?: ExactReviewLaneHistorySample;
  publication?: ExactReviewLaneHistorySample;
};

export type ExactReviewLaneHistorySample = {
  pending: number;
  enqueued_total?: number;
  completed_total?: number;
  shed_total?: number;
};

export function summarizeOperationalHealth(
  runs: WorkflowRun[],
  checkedAt: string,
  telemetryComplete: boolean,
): OperationalHealth {
  const checkedAtMs = Date.parse(checkedAt);
  const now = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();
  const queuedRuns = runs.filter((run) => QUEUED_STATUSES.has(String(run.status || "")));
  const runningRuns = runs.filter((run) => run.status === "in_progress");
  const queuedAges = queuedRuns.map((run) => ageMs(run.created_at, now));
  const runningAges = runningRuns
    // GitHub exposes queue admission and execution start separately. Falling
    // back keeps older payloads observable without charging queue time when
    // the authoritative execution timestamp is present.
    .map((run) => ageMs(run.run_started_at || run.created_at, now));
  const validQueuedAges = queuedAges.filter((age): age is number => age !== null);
  const validRunningAges = runningAges.filter((age): age is number => age !== null);
  const hasCompleteAges =
    validQueuedAges.length === queuedRuns.length && validRunningAges.length === runningRuns.length;
  const complete = telemetryComplete && hasCompleteAges;
  const queuedOverThreshold = validQueuedAges.filter(
    (age) => age >= OPERATIONAL_QUEUE_DEGRADED_MS,
  ).length;
  const runningOverThreshold = validRunningAges.filter(
    (age) => age >= OPERATIONAL_RUNNING_STALLED_MS,
  ).length;
  const status = !complete
    ? "unknown"
    : runningOverThreshold
      ? "stalled"
      : queuedOverThreshold
        ? "degraded"
        : "healthy";
  return {
    status,
    checked_at: new Date(now).toISOString(),
    telemetry_complete: complete,
    queued_runs: queuedRuns.length,
    queued_over_threshold: queuedOverThreshold,
    queued_threshold_minutes: OPERATIONAL_QUEUE_DEGRADED_MS / 60_000,
    oldest_queued_minutes: oldestMinutes(validQueuedAges),
    running_runs: runningRuns.length,
    running_over_threshold: runningOverThreshold,
    running_threshold_minutes: OPERATIONAL_RUNNING_STALLED_MS / 60_000,
    oldest_running_minutes: oldestMinutes(validRunningAges),
  };
}

export function normalizeHealthHistorySample(value: unknown): HealthHistorySample | null {
  if (!value || typeof value !== "object") return null;
  const sample = value as Record<string, unknown>;
  const at = String(sample.at || "");
  if (!Number.isFinite(Date.parse(at))) return null;
  const countFields = [
    "queued",
    "queued_over_30m",
    "oldest_queued_minutes",
    "running",
    "running_over_150m",
    "oldest_running_minutes",
  ] as const;
  const hasOperationalFields = ["status", "collection_ok", ...countFields].some((field) =>
    Object.hasOwn(sample, field),
  );
  let operational: Omit<HealthHistorySample, "at" | "exact_review"> = {};
  if (hasOperationalFields) {
    const rawStatus = String(sample.status || "");
    if (!["healthy", "degraded", "stalled", "unknown"].includes(rawStatus)) return null;
    if (typeof sample.collection_ok !== "boolean") return null;
    const counts = Object.fromEntries(
      countFields.map((field) => [field, nonNegativeInteger(sample[field])]),
    ) as Record<(typeof countFields)[number], number | null>;
    if (Object.values(counts).some((count) => count === null)) return null;
    operational = {
      status: rawStatus as OperationalHealth["status"],
      queued: counts.queued!,
      queued_over_30m: counts.queued_over_30m!,
      oldest_queued_minutes: counts.oldest_queued_minutes!,
      running: counts.running!,
      running_over_150m: counts.running_over_150m!,
      oldest_running_minutes: counts.oldest_running_minutes!,
      collection_ok: sample.collection_ok,
    };
  }
  const exactReview = normalizeExactReviewHistorySample(sample.exact_review);
  if (!hasOperationalFields && !exactReview) return null;
  return {
    at,
    ...operational,
    ...(exactReview ? { exact_review: exactReview } : {}),
  };
}

export function exactReviewHistorySample(value: unknown): ExactReviewHistorySample {
  const lanes = objectValue(objectValue(value).lanes);
  const review = queueLaneHistorySample(lanes.review, true);
  const publication = queueLaneHistorySample(lanes.publication, false);
  if (!review || !publication) return { collection_ok: false };
  return {
    collection_ok: true,
    review,
    publication,
  };
}

function normalizeExactReviewHistorySample(value: unknown): ExactReviewHistorySample | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") return null;
  const sample = value as Record<string, unknown>;
  if (typeof sample.collection_ok !== "boolean") return null;
  if (!sample.collection_ok) return { collection_ok: false };
  const review = storedLaneHistorySample(sample.review, true);
  const publication = storedLaneHistorySample(sample.publication, false);
  if (!review || !publication) return null;
  return {
    collection_ok: true,
    review,
    publication,
  };
}

function queueLaneHistorySample(value: unknown, includeShed: boolean) {
  const lane = objectValue(value);
  return laneHistorySample(
    lane.pending,
    lane.enqueued_total,
    lane.completed_total,
    includeShed ? lane.shed_since_reset : undefined,
  );
}

function storedLaneHistorySample(value: unknown, includeShed: boolean) {
  const lane = objectValue(value);
  return laneHistorySample(
    lane.pending,
    lane.enqueued_total,
    lane.completed_total,
    includeShed ? lane.shed_total : undefined,
  );
}

function laneHistorySample(
  pendingValue: unknown,
  enqueuedValue: unknown,
  completedValue: unknown,
  shedValue: unknown,
): ExactReviewLaneHistorySample | null {
  const pending = nonNegativeInteger(pendingValue);
  const enqueuedTotal = optionalNonNegativeInteger(enqueuedValue);
  const completedTotal = optionalNonNegativeInteger(completedValue);
  const shedTotal = optionalNonNegativeInteger(shedValue);
  if (pending === null || enqueuedTotal === null || completedTotal === null || shedTotal === null) {
    return null;
  }
  return {
    pending,
    ...(enqueuedTotal === undefined ? {} : { enqueued_total: enqueuedTotal }),
    ...(completedTotal === undefined ? {} : { completed_total: completedTotal }),
    ...(shedTotal === undefined ? {} : { shed_total: shedTotal }),
  };
}

export function mergeHealthHistorySample(
  current: unknown,
  sample: HealthHistorySample,
): HealthHistorySample[] {
  const slot = historySlot(sample.at);
  const entries = Array.isArray(current) ? current : [];
  const normalized = entries
    .map((entry) => normalizeHealthHistorySample(entry))
    .filter((entry): entry is HealthHistorySample => Boolean(entry));
  const latestInSlot = normalized
    .filter((entry) => historySlot(entry.at) === slot)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  // Cron retries may finish out of order. Slot deduplication must not let an
  // older observation erase a newer health transition that already landed.
  const winner =
    latestInSlot && Date.parse(latestInSlot.at) > Date.parse(sample.at) ? latestInSlot : sample;
  return [...normalized.filter((entry) => historySlot(entry.at) !== slot), winner].sort(
    (left, right) => Date.parse(left.at) - Date.parse(right.at),
  );
}

function historySlot(value: string) {
  return Math.floor(Date.parse(value) / HEALTH_HISTORY_SAMPLE_MS);
}

function ageMs(value: string | undefined, now: number) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function optionalNonNegativeInteger(value: unknown) {
  return value === undefined ? undefined : nonNegativeInteger(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function oldestMinutes(ages: number[]) {
  return ages.length ? Math.round(Math.max(...ages) / 60_000) : 0;
}
