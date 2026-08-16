export const OPERATIONAL_QUEUE_DEGRADED_MS = 30 * 60 * 1000;
export const OPERATIONAL_WEDGED_RERUN_MS = 60 * 60 * 1000;
export const OPERATIONAL_QUEUE_ZOMBIE_MS = 24 * 60 * 60 * 1000;
export const OPERATIONAL_RUNNING_STALLED_MS = 150 * 60 * 1000;
export const HEALTH_HISTORY_SAMPLE_MS = 5 * 60 * 1000;
export const HEALTH_HISTORY_RETENTION_DAYS = 7;
const HEALTH_HISTORY_MAX_COUNT = 10_000_000;
const HEALTH_HISTORY_MAX_TOTAL = 1_000_000_000_000;
const HEALTH_HISTORY_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const HEALTH_HISTORY_TIMESTAMP_MIN_MS = Date.UTC(2020, 0, 1);
const HEALTH_HISTORY_TIMESTAMP_MAX_MS = Date.UTC(2100, 0, 1);

// "waiting" runs sit behind a deployment approval gate: a human decision, not
// runner congestion. A forgotten approval would otherwise pin
// oldest_queued_minutes for weeks and hold status at degraded, so they are
// counted separately instead of inside the queue-pressure metrics.
const QUEUED_STATUSES = new Set(["queued", "requested", "pending"]);
const APPROVAL_GATED_STATUSES = new Set(["waiting"]);

type WorkflowRun = {
  status?: string;
  created_at?: string;
  run_started_at?: string;
  run_attempt?: number;
};

export type OperationalHealth = {
  status: "healthy" | "degraded" | "stalled" | "unknown";
  checked_at: string;
  telemetry_complete: boolean;
  queued_runs: number;
  queued_over_threshold: number;
  queued_threshold_minutes: number;
  oldest_queued_minutes: number;
  zombie_queued_runs: number;
  oldest_zombie_queued_minutes: number;
  wedged_rerun_runs: number;
  oldest_wedged_rerun_minutes: number;
  approval_gated_runs: number;
  oldest_approval_gated_minutes: number;
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
  state_writer?: StateWriterHistorySample;
};

export type ExactReviewHistorySample = {
  collection_ok: boolean;
  review?: ExactReviewLaneHistorySample;
  publication?: ExactReviewLaneHistorySample;
  handoff?: ExactReviewHandoffHistorySample;
};

export type ExactReviewHandoffHistorySample = {
  status: "idle" | "healthy" | "degraded" | "stalled";
  pending: number;
  dispatching: number;
  leased: number;
};

export type ExactReviewLaneHistorySample = {
  pending: number;
  enqueued_total?: number;
  completed_total?: number;
  shed_total?: number;
};

export type StateWriterHistorySample = {
  collection_ok: boolean;
  terminal_collection_ok?: boolean;
  mode?: "single_item" | "batch" | "mixed" | "unknown" | undefined;
  tracked_holding?: number | undefined;
  tracked_waiting?: number | undefined;
  tracked_releasing?: number | undefined;
  accepted_operations_total?: number | undefined;
  state_commits_total?: number | undefined;
  materialized_items_total?: number | undefined;
  contention_timeouts_total?: number | undefined;
  wait_ms?: { p50: number | null; p95: number | null; samples: number };
  hold_ms?: { p50: number | null; p95: number | null; samples: number };
  last_successful_materialization_at?: string | null;
};

export function summarizeOperationalHealth(
  runs: WorkflowRun[],
  checkedAt: string,
  telemetryComplete: boolean,
): OperationalHealth {
  const checkedAtMs = Date.parse(checkedAt);
  const now = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();
  const queuedRuns = runs.filter((run) => QUEUED_STATUSES.has(String(run.status || "")));
  const approvalGatedRuns = runs.filter((run) =>
    APPROVAL_GATED_STATUSES.has(String(run.status || "")),
  );
  const runningRuns = runs.filter((run) => run.status === "in_progress");
  const queuedAgeRecords = queuedRuns.map((run) => ({
    run,
    age: ageMs(run.created_at, now),
  }));
  const runningAges = runningRuns
    // GitHub exposes queue admission and execution start separately. Falling
    // back keeps older payloads observable without charging queue time when
    // the authoritative execution timestamp is present.
    .map((run) => ageMs(run.run_started_at || run.created_at, now));
  const validQueuedAgeRecords = queuedAgeRecords.filter(
    (record): record is { run: WorkflowRun; age: number } => record.age !== null,
  );
  const validQueuedAges = validQueuedAgeRecords.map((record) => record.age);
  // Pre-queue reruns normally leave pending within seconds. After an hour,
  // GitHub cannot cancel or rerun them, so they are not live queue pressure.
  const wedgedRerunAges = validQueuedAgeRecords
    .filter(
      ({ run, age }) =>
        run.status === "pending" &&
        Number(run.run_attempt) > 1 &&
        age > OPERATIONAL_WEDGED_RERUN_MS,
    )
    .map(({ age }) => age);
  const liveQueuedAgeRecords = validQueuedAgeRecords.filter(
    ({ run, age }) =>
      !(
        run.status === "pending" &&
        Number(run.run_attempt) > 1 &&
        age > OPERATIONAL_WEDGED_RERUN_MS
      ),
  );
  // Normal queue waits are measured in minutes. Seventeen production runs are
  // stranded past 24 hours (three from Jul 13/17 and fourteen from one Aug 7
  // incident), and both cancel and force-cancel return HTTP 500 for every one.
  // Excluding those unremediable zombies is the only way to keep live queue
  // pressure observable without pinning operational health indefinitely.
  const zombieQueuedAges = liveQueuedAgeRecords
    .filter(({ age }) => age > OPERATIONAL_QUEUE_ZOMBIE_MS)
    .map(({ age }) => age);
  const liveQueuedAges = liveQueuedAgeRecords
    .filter(({ age }) => age <= OPERATIONAL_QUEUE_ZOMBIE_MS)
    .map(({ age }) => age);
  const validRunningAges = runningAges.filter((age): age is number => age !== null);
  const hasCompleteAges =
    validQueuedAges.length === queuedRuns.length && validRunningAges.length === runningRuns.length;
  const complete = telemetryComplete && hasCompleteAges;
  const queuedOverThreshold = liveQueuedAges.filter(
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
    oldest_queued_minutes: oldestMinutes(liveQueuedAges),
    zombie_queued_runs: zombieQueuedAges.length,
    oldest_zombie_queued_minutes: oldestMinutes(zombieQueuedAges),
    wedged_rerun_runs: wedgedRerunAges.length,
    oldest_wedged_rerun_minutes: oldestMinutes(wedgedRerunAges),
    approval_gated_runs: approvalGatedRuns.length,
    oldest_approval_gated_minutes: oldestMinutes(
      approvalGatedRuns
        .map((run) => ageMs(run.created_at, now))
        .filter((age): age is number => age !== null),
    ),
    running_runs: runningRuns.length,
    running_over_threshold: runningOverThreshold,
    running_threshold_minutes: OPERATIONAL_RUNNING_STALLED_MS / 60_000,
    oldest_running_minutes: oldestMinutes(validRunningAges),
  };
}

export function normalizeHealthHistorySample(value: unknown): HealthHistorySample | null {
  if (!value || typeof value !== "object") return null;
  const sample = value as Record<string, unknown>;
  const at = canonicalHistoryTimestamp(sample.at);
  if (!at) return null;
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
  let operational: Omit<HealthHistorySample, "at" | "exact_review" | "state_writer"> = {};
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
  const stateWriter = normalizeStateWriterHistorySample(sample.state_writer);
  if (!hasOperationalFields && !exactReview && !stateWriter) return null;
  return {
    at,
    ...operational,
    ...(exactReview ? { exact_review: exactReview } : {}),
    ...(stateWriter ? { state_writer: stateWriter } : {}),
  };
}

export function stateWriterHistorySample(value: unknown): StateWriterHistorySample {
  const writer = objectValue(value);
  const collection = objectValue(writer.collection);
  const live = objectValue(writer.live);
  const coordinator = objectValue(writer.coordinator);
  const window = objectValue(writer.last_15_minutes);
  const diagnostics = objectValue(writer.diagnostics);
  const mode = ["single_item", "batch", "mixed", "unknown"].includes(String(writer.mode))
    ? (writer.mode as StateWriterHistorySample["mode"])
    : "unknown";
  const coordinatorQueued = nonNegativeInteger(coordinator.queued);
  const coordinatorLeased = nonNegativeInteger(coordinator.leased);
  const coordinatorOk = coordinatorQueued !== null && coordinatorLeased !== null;
  // Progress events legitimately go stale while the serialized writer is idle.
  // The coordinator snapshot is the authoritative liveness source after the
  // repo-wide serialization cutover, so an idle writer must remain a valid
  // history sample instead of disappearing from the panel.
  const collectionOk = collection.status === "fresh" || coordinatorOk;
  return {
    collection_ok: collectionOk,
    terminal_collection_ok: collection.status === "fresh",
    mode,
    tracked_holding: coordinatorOk
      ? coordinatorLeased
      : (nonNegativeInteger(live.tracked_holding) ?? 0),
    tracked_waiting: coordinatorOk
      ? coordinatorQueued
      : (nonNegativeInteger(live.tracked_waiting) ?? 0),
    tracked_releasing: nonNegativeInteger(live.tracked_releasing) ?? 0,
    accepted_operations_total: nonNegativeInteger(diagnostics.accepted_terminal_total) ?? 0,
    state_commits_total: nonNegativeInteger(diagnostics.state_commits_total) ?? 0,
    materialized_items_total: nonNegativeInteger(diagnostics.materialized_items_total) ?? 0,
    contention_timeouts_total: nonNegativeInteger(diagnostics.contention_timeouts_total) ?? 0,
    wait_ms: historyPercentiles(window.wait_ms),
    hold_ms: historyPercentiles(window.hold_ms),
    last_successful_materialization_at:
      canonicalHistoryTimestamp(writer.last_successful_materialization_at) ?? null,
  };
}

export function exactReviewHistorySample(value: unknown): ExactReviewHistorySample {
  const queue = objectValue(value);
  const lanes = objectValue(queue.lanes);
  const review = queueLaneHistorySample(lanes.review, true);
  const publication = queueLaneHistorySample(lanes.publication, false);
  if (!review || !publication) return { collection_ok: false };
  const handoff = queueHandoffHistorySample(queue.handoff_health);
  return {
    collection_ok: true,
    review,
    publication,
    ...(handoff ? { handoff } : {}),
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
  const handoff = storedHandoffHistorySample(sample.handoff);
  if (sample.handoff !== undefined && !handoff) return null;
  return {
    collection_ok: true,
    review,
    publication,
    ...(handoff ? { handoff } : {}),
  };
}

function queueHandoffHistorySample(value: unknown): ExactReviewHandoffHistorySample | null {
  const handoff = objectValue(value);
  const phases = objectValue(handoff.phases);
  return handoffHistorySample({
    status: handoff.status,
    pending: objectValue(phases.pending).count,
    dispatching: objectValue(phases.dispatching).count,
    leased: objectValue(phases.leased).count,
  });
}

function storedHandoffHistorySample(value: unknown): ExactReviewHandoffHistorySample | null {
  if (value === undefined) return null;
  return handoffHistorySample(objectValue(value));
}

function handoffHistorySample(
  value: Record<string, unknown>,
): ExactReviewHandoffHistorySample | null {
  const status = String(value.status || "");
  const pending = nonNegativeInteger(value.pending);
  const dispatching = nonNegativeInteger(value.dispatching);
  const leased = nonNegativeInteger(value.leased);
  if (!["idle", "healthy", "degraded", "stalled"].includes(status)) return null;
  if (pending === null || dispatching === null || leased === null) return null;
  return {
    status: status as ExactReviewHandoffHistorySample["status"],
    pending,
    dispatching,
    leased,
  };
}

function normalizeStateWriterHistorySample(value: unknown): StateWriterHistorySample | null {
  if (value === undefined) return null;
  const sample = objectValue(value);
  if (typeof sample.collection_ok !== "boolean") return null;
  if (!sample.collection_ok) return { collection_ok: false };
  const mode = ["single_item", "batch", "mixed", "unknown"].includes(String(sample.mode))
    ? (sample.mode as StateWriterHistorySample["mode"])
    : null;
  const integerFields = [
    "tracked_holding",
    "tracked_waiting",
    "tracked_releasing",
    "accepted_operations_total",
    "state_commits_total",
    "materialized_items_total",
    "contention_timeouts_total",
  ] as const;
  const values = Object.fromEntries(
    integerFields.map((field) => [field, optionalNonNegativeInteger(sample[field])]),
  ) as Record<(typeof integerFields)[number], number | undefined | null>;
  if (!mode || Object.values(values).some((entry) => entry === null)) return null;
  const validValues = values as Record<(typeof integerFields)[number], number | undefined>;
  const wait = normalizeHistoryPercentiles(sample.wait_ms);
  const hold = normalizeHistoryPercentiles(sample.hold_ms);
  if (!wait || !hold) return null;
  const lastSuccessfulMaterialization =
    sample.last_successful_materialization_at === null ||
    sample.last_successful_materialization_at === undefined
      ? null
      : canonicalHistoryTimestamp(sample.last_successful_materialization_at);
  if (lastSuccessfulMaterialization === null && sample.last_successful_materialization_at != null) {
    return null;
  }
  return {
    collection_ok: true,
    terminal_collection_ok:
      typeof sample.terminal_collection_ok === "boolean" ? sample.terminal_collection_ok : true,
    mode,
    ...validValues,
    wait_ms: wait,
    hold_ms: hold,
    last_successful_materialization_at: lastSuccessfulMaterialization,
  };
}

function historyPercentiles(value: unknown) {
  const input = objectValue(value);
  return {
    p50: optionalNonNegativeInteger(input.p50) ?? null,
    p95: optionalNonNegativeInteger(input.p95) ?? null,
    samples: nonNegativeInteger(input.samples) ?? 0,
  };
}

function normalizeHistoryPercentiles(value: unknown) {
  if (value === undefined) return { p50: null, p95: null, samples: 0 };
  const input = objectValue(value);
  const p50 = input.p50 === null ? null : optionalNonNegativeInteger(input.p50);
  const p95 = input.p95 === null ? null : optionalNonNegativeInteger(input.p95);
  const samples = nonNegativeInteger(input.samples);
  return p50 === undefined || p95 === undefined || samples === null ? null : { p50, p95, samples };
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
  const enqueuedTotal = optionalNonNegativeInteger(enqueuedValue, HEALTH_HISTORY_MAX_TOTAL);
  const completedTotal = optionalNonNegativeInteger(completedValue, HEALTH_HISTORY_MAX_TOTAL);
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
  const entries = Array.isArray(current) ? current : [];
  const normalized = entries
    .map((entry) => normalizeHealthHistorySample(entry))
    .filter((entry): entry is HealthHistorySample => Boolean(entry));
  const normalizedSample = normalizeHealthHistorySample(sample);
  if (!normalizedSample)
    return normalized.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const slot = historySlot(normalizedSample.at);
  const latestInSlot = normalized
    .filter((entry) => historySlot(entry.at) === slot)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  // Cron retries may finish out of order. Slot deduplication must not let an
  // older observation erase a newer health transition that already landed.
  const winner =
    latestInSlot && Date.parse(latestInSlot.at) > Date.parse(normalizedSample.at)
      ? latestInSlot
      : normalizedSample;
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

function nonNegativeInteger(value: unknown, maximum = HEALTH_HISTORY_MAX_COUNT) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function optionalNonNegativeInteger(value: unknown, maximum = HEALTH_HISTORY_MAX_COUNT) {
  return value === undefined ? undefined : nonNegativeInteger(value, maximum);
}

function canonicalHistoryTimestamp(value: unknown) {
  if (typeof value !== "string" || !HEALTH_HISTORY_TIMESTAMP_PATTERN.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    timestamp >= HEALTH_HISTORY_TIMESTAMP_MIN_MS &&
    timestamp < HEALTH_HISTORY_TIMESTAMP_MAX_MS
    ? new Date(timestamp).toISOString()
    : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function oldestMinutes(ages: number[]) {
  return ages.length ? Math.round(Math.max(...ages) / 60_000) : 0;
}
