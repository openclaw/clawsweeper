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
  status: OperationalHealth["status"];
  queued: number;
  queued_over_30m: number;
  oldest_queued_minutes: number;
  running: number;
  running_over_150m: number;
  oldest_running_minutes: number;
  collection_ok: boolean;
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

export function healthHistorySample(health: OperationalHealth): HealthHistorySample {
  return {
    at: health.checked_at,
    status: health.status,
    queued: health.queued_runs,
    queued_over_30m: health.queued_over_threshold,
    oldest_queued_minutes: health.oldest_queued_minutes,
    running: health.running_runs,
    running_over_150m: health.running_over_threshold,
    oldest_running_minutes: health.oldest_running_minutes,
    collection_ok: health.telemetry_complete,
  };
}

export function normalizeHealthHistorySample(value: unknown): HealthHistorySample | null {
  if (!value || typeof value !== "object") return null;
  const sample = value as Record<string, unknown>;
  const at = String(sample.at || "");
  if (!Number.isFinite(Date.parse(at))) return null;
  const rawStatus = String(sample.status || "");
  if (!["healthy", "degraded", "stalled", "unknown"].includes(rawStatus)) return null;
  if (typeof sample.collection_ok !== "boolean") return null;
  const countFields = [
    "queued",
    "queued_over_30m",
    "oldest_queued_minutes",
    "running",
    "running_over_150m",
    "oldest_running_minutes",
  ] as const;
  const counts = Object.fromEntries(
    countFields.map((field) => [field, nonNegativeInteger(sample[field])]),
  ) as Record<(typeof countFields)[number], number | null>;
  if (Object.values(counts).some((count) => count === null)) return null;
  return {
    at,
    status: rawStatus as HealthHistorySample["status"],
    queued: counts.queued!,
    queued_over_30m: counts.queued_over_30m!,
    oldest_queued_minutes: counts.oldest_queued_minutes!,
    running: counts.running!,
    running_over_150m: counts.running_over_150m!,
    oldest_running_minutes: counts.oldest_running_minutes!,
    collection_ok: sample.collection_ok,
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

function oldestMinutes(ages: number[]) {
  return ages.length ? Math.round(Math.max(...ages) / 60_000) : 0;
}
