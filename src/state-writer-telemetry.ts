export const STATE_WRITER_SCHEMA_VERSION = 1 as const;
export const STATE_WRITER_MAX_DURATION_MS = 60 * 60 * 1000;
export const STATE_WRITER_MAX_COUNT = 10_000;
export const STATE_WRITER_MAX_OPERATION_ID_LENGTH = 200;

export type StateWriterMode = "single_item" | "batch";
export type StateWriterOutcome =
  | "materialized"
  | "unchanged"
  | "superseded"
  | "contention_timeout"
  | "failed";
export type StateWriterPhase = "waiting" | "holding" | "releasing" | "finished";

export type StateWriterOperation = {
  schema_version: typeof STATE_WRITER_SCHEMA_VERSION;
  operation_id: string;
  mode: StateWriterMode;
  started_at: string;
  finished_at: string;
  wait_ms: number;
  acquire_attempts: number;
  acquired: boolean;
  hold_ms: number | null;
  renewals: number;
  released: boolean | null;
  git_duration_ms: number;
  git_processes: number;
  commit_count: 0 | 1;
  materialized_items: number;
  configured_batch_size: number;
  actual_batch_size: number;
  batch_wait_ms: number | null;
  outcome: StateWriterOutcome;
};

export type StateWriterProgress = {
  schema_version: typeof STATE_WRITER_SCHEMA_VERSION;
  operation_id: string;
  mode: StateWriterMode;
  phase: StateWriterPhase;
  sequence: number;
  observed_at: string;
  configured_batch_size: number;
  actual_batch_size: number;
};

export function normalizeStateWriterOperation(value: unknown): StateWriterOperation | null {
  const input = objectValue(value);
  if (!input || input.schema_version !== STATE_WRITER_SCHEMA_VERSION) return null;
  const operationId = boundedString(input.operation_id, STATE_WRITER_MAX_OPERATION_ID_LENGTH);
  const mode = stateWriterMode(input.mode);
  const outcome = stateWriterOutcome(input.outcome);
  const startedAt = timestamp(input.started_at);
  const finishedAt = timestamp(input.finished_at);
  const waitMs = duration(input.wait_ms);
  const acquireAttempts = count(input.acquire_attempts);
  const acquired = input.acquired;
  const holdMs = nullableDuration(input.hold_ms);
  const renewals = count(input.renewals);
  const released = nullableBoolean(input.released);
  const gitDurationMs = duration(input.git_duration_ms);
  const gitProcesses = count(input.git_processes);
  const commitCount = input.commit_count;
  const materializedItems = count(input.materialized_items);
  const configuredBatchSize = count(input.configured_batch_size);
  const actualBatchSize = count(input.actual_batch_size);
  const batchWaitMs = nullableDuration(input.batch_wait_ms);
  if (
    !operationId ||
    !mode ||
    !outcome ||
    !startedAt ||
    !finishedAt ||
    waitMs === null ||
    acquireAttempts === null ||
    typeof acquired !== "boolean" ||
    holdMs === undefined ||
    renewals === null ||
    released === undefined ||
    gitDurationMs === null ||
    gitProcesses === null ||
    (commitCount !== 0 && commitCount !== 1) ||
    materializedItems === null ||
    configuredBatchSize === null ||
    actualBatchSize === null ||
    batchWaitMs === undefined
  ) {
    return null;
  }
  if (
    Date.parse(finishedAt) < Date.parse(startedAt) ||
    configuredBatchSize < 1 ||
    actualBatchSize < 1 ||
    actualBatchSize > configuredBatchSize ||
    materializedItems > actualBatchSize ||
    (!acquired &&
      (holdMs !== null ||
        released !== null ||
        renewals !== 0 ||
        commitCount !== 0 ||
        materializedItems !== 0)) ||
    (commitCount === 1 && (!acquired || materializedItems < 1)) ||
    (outcome === "materialized" && (commitCount !== 1 || materializedItems < 1)) ||
    (outcome !== "materialized" && (commitCount !== 0 || materializedItems !== 0)) ||
    (mode === "single_item" &&
      (configuredBatchSize !== 1 || actualBatchSize !== 1 || batchWaitMs !== null)) ||
    (mode === "batch" && batchWaitMs === null) ||
    (outcome === "contention_timeout" && acquired)
  ) {
    return null;
  }
  return {
    schema_version: STATE_WRITER_SCHEMA_VERSION,
    operation_id: operationId,
    mode,
    started_at: startedAt,
    finished_at: finishedAt,
    wait_ms: waitMs,
    acquire_attempts: acquireAttempts,
    acquired,
    hold_ms: holdMs,
    renewals,
    released,
    git_duration_ms: gitDurationMs,
    git_processes: gitProcesses,
    commit_count: commitCount,
    materialized_items: materializedItems,
    configured_batch_size: configuredBatchSize,
    actual_batch_size: actualBatchSize,
    batch_wait_ms: batchWaitMs,
    outcome,
  };
}

export function normalizeStateWriterProgress(value: unknown): StateWriterProgress | null {
  const input = objectValue(value);
  if (!input || input.schema_version !== STATE_WRITER_SCHEMA_VERSION) return null;
  const operationId = boundedString(input.operation_id, STATE_WRITER_MAX_OPERATION_ID_LENGTH);
  const mode = stateWriterMode(input.mode);
  const phase = stateWriterPhase(input.phase);
  const sequence = count(input.sequence);
  const observedAt = timestamp(input.observed_at);
  const configuredBatchSize = count(input.configured_batch_size);
  const actualBatchSize = count(input.actual_batch_size);
  if (
    !operationId ||
    !mode ||
    !phase ||
    sequence === null ||
    sequence < 1 ||
    !observedAt ||
    configuredBatchSize === null ||
    configuredBatchSize < 1 ||
    actualBatchSize === null ||
    actualBatchSize < 1 ||
    actualBatchSize > configuredBatchSize ||
    (mode === "single_item" && (configuredBatchSize !== 1 || actualBatchSize !== 1))
  ) {
    return null;
  }
  return {
    schema_version: STATE_WRITER_SCHEMA_VERSION,
    operation_id: operationId,
    mode,
    phase,
    sequence,
    observed_at: observedAt,
    configured_batch_size: configuredBatchSize,
    actual_batch_size: actualBatchSize,
  };
}

export function payloadHash(normalized: StateWriterOperation): string {
  return stableHash(JSON.stringify(normalized));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum ? text : null;
}

function timestamp(value: unknown): string | null {
  const text = typeof value === "string" ? value : "";
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function count(value: unknown): number | null {
  return integer(value, STATE_WRITER_MAX_COUNT);
}

function duration(value: unknown): number | null {
  return integer(value, STATE_WRITER_MAX_DURATION_MS);
}

function nullableDuration(value: unknown): number | null | undefined {
  return value === null ? null : (duration(value) ?? undefined);
}

function nullableBoolean(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  return undefined;
}

function integer(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function stateWriterMode(value: unknown): StateWriterMode | null {
  return value === "single_item" || value === "batch" ? value : null;
}

function stateWriterOutcome(value: unknown): StateWriterOutcome | null {
  return ["materialized", "unchanged", "superseded", "contention_timeout", "failed"].includes(
    String(value),
  )
    ? (value as StateWriterOutcome)
    : null;
}

function stateWriterPhase(value: unknown): StateWriterPhase | null {
  return ["waiting", "holding", "releasing", "finished"].includes(String(value))
    ? (value as StateWriterPhase)
    : null;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
