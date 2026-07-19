export const REVIEW_TELEMETRY_DEGRADED_MS = 30 * 60 * 1000;
export const REVIEW_TELEMETRY_ORPHAN_MS = 150 * 60 * 1000;
export const REVIEW_TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const REVIEW_TELEMETRY_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const REVIEW_TELEMETRY_MAX_LEASE_HORIZON_MS = 24 * 60 * 60 * 1000;

const OUTCOMES = new Set(["succeeded", "failed", "cancelled", "interrupted", "superseded"]);
const PHASES = ["queue", "claim", "review", "publication", "total"] as const;

export type DurableReviewTelemetry = {
  repo: string;
  item_number: number;
  run_id: string;
  run_attempt: number;
  status: "refreshing" | "completed";
  outcome: "succeeded" | "failed" | "cancelled" | "interrupted" | "superseded" | null;
  started_at: string;
  updated_at: string;
  lease_expires_at: string | null;
  phase_durations_ms: Partial<Record<(typeof PHASES)[number], number>>;
  generation?: number;
  operation_id?: string;
};

export type ReviewTelemetryHealth = {
  status: "healthy" | "degraded" | "critical";
  refreshing: number;
  slow_refreshing: number;
  orphan_refreshing: number;
  degraded_after_seconds: number;
  orphan_after_seconds: number;
  orphans: Array<{
    repo: string;
    item_number: number;
    run_id: string;
    run_attempt: number;
    updated_at: string;
    age_seconds: number;
    lease_expires_at: string | null;
  }>;
};

export function normalizeReviewTelemetry(
  value: unknown,
  now = Date.now(),
): DurableReviewTelemetry | null {
  const record = objectValue(value);
  const repo = String(record.repo || "").trim();
  const itemNumber = Number(record.item_number);
  const runId = String(record.run_id || "").trim();
  const runAttempt = Number(record.run_attempt);
  const status = String(record.status || "");
  const outcome = record.outcome == null ? null : String(record.outcome);
  const startedAt = timestamp(record.started_at);
  const updatedAt = timestamp(record.updated_at);
  const leaseExpiresAt =
    record.lease_expires_at == null ? null : timestamp(record.lease_expires_at);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !Number.isSafeInteger(itemNumber) ||
    itemNumber < 1 ||
    !runId ||
    runId.length > 100 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !["refreshing", "completed"].includes(status) ||
    (status === "refreshing" ? outcome !== null : !OUTCOMES.has(String(outcome))) ||
    !startedAt ||
    !updatedAt ||
    Date.parse(updatedAt) < Date.parse(startedAt) ||
    Date.parse(startedAt) > now + REVIEW_TELEMETRY_CLOCK_SKEW_MS ||
    Date.parse(updatedAt) > now + REVIEW_TELEMETRY_CLOCK_SKEW_MS ||
    (leaseExpiresAt !== null &&
      Date.parse(leaseExpiresAt) > now + REVIEW_TELEMETRY_MAX_LEASE_HORIZON_MS) ||
    (record.lease_expires_at != null && !leaseExpiresAt)
  ) {
    return null;
  }
  const generation = optionalPositiveInteger(record.generation);
  const operationId = optionalBoundedString(record.operation_id, 200);
  if (generation === null || operationId === null) return null;
  const phaseDurations = normalizePhaseDurations(record.phase_durations_ms);
  if (!phaseDurations) return null;
  return {
    repo,
    item_number: itemNumber,
    run_id: runId,
    run_attempt: runAttempt,
    status: status as DurableReviewTelemetry["status"],
    outcome: outcome as DurableReviewTelemetry["outcome"],
    started_at: startedAt,
    updated_at: updatedAt,
    lease_expires_at: leaseExpiresAt,
    phase_durations_ms: phaseDurations,
    ...(generation === undefined ? {} : { generation }),
    ...(operationId === undefined ? {} : { operation_id: operationId }),
  };
}

export function summarizeReviewTelemetryHealth(
  records: readonly DurableReviewTelemetry[],
  now = Date.now(),
): ReviewTelemetryHealth {
  const refreshing = records.filter((record) => record.status === "refreshing");
  const aged = refreshing.map((record) => ({
    record,
    age: Math.max(0, now - Date.parse(record.updated_at)),
    leaseActive: record.lease_expires_at !== null && Date.parse(record.lease_expires_at) > now,
  }));
  const slow = aged.filter(({ age }) => age >= REVIEW_TELEMETRY_DEGRADED_MS);
  const orphanRecords = aged.filter(
    ({ age, leaseActive }) => age >= REVIEW_TELEMETRY_ORPHAN_MS && !leaseActive,
  );
  const orphans = orphanRecords
    .sort((left, right) => right.age - left.age)
    .slice(0, 20)
    .map(({ record, age }) => ({
      repo: record.repo,
      item_number: record.item_number,
      run_id: record.run_id,
      run_attempt: record.run_attempt,
      updated_at: record.updated_at,
      age_seconds: Math.floor(age / 1000),
      lease_expires_at: record.lease_expires_at,
    }));
  return {
    status: orphanRecords.length ? "critical" : slow.length ? "degraded" : "healthy",
    refreshing: refreshing.length,
    slow_refreshing: slow.length,
    orphan_refreshing: orphanRecords.length,
    degraded_after_seconds: REVIEW_TELEMETRY_DEGRADED_MS / 1000,
    orphan_after_seconds: REVIEW_TELEMETRY_ORPHAN_MS / 1000,
    orphans,
  };
}

function normalizePhaseDurations(value: unknown) {
  const durations = objectValue(value);
  const result: DurableReviewTelemetry["phase_durations_ms"] = {};
  for (const phase of PHASES) {
    if (durations[phase] === undefined) continue;
    const duration = Number(durations[phase]);
    if (!Number.isSafeInteger(duration) || duration < 0) return null;
    result[phase] = duration;
  }
  return result;
}

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function optionalPositiveInteger(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function optionalBoundedString(value: unknown, maxLength: number) {
  if (value === undefined || value === null) return undefined;
  const string = String(value).trim();
  return string && string.length <= maxLength ? string : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
