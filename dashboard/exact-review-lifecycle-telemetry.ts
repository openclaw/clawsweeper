import { sqlColumnNames, type DurableStorage } from "./durable-storage.ts";

export const EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE =
  "exact_review_lifecycle_telemetry_direct_v1";
export const EXACT_REVIEW_LIFECYCLE_TELEMETRY_BATCH_TABLE =
  "exact_review_lifecycle_telemetry_batch_v1";
// Retain the retired Bay schema for existing databases without maintaining its data.
export const EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE = "exact_review_lifecycle_bay_event_v2";
export const EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE = "exact_review_lifecycle_bay_meta_v2";
export const EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE = "exact_review_lifecycle_bay_scope_v2";
export const EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE =
  "exact_review_lifecycle_bay_tide_buffer_v2";
export const EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE = "exact_review_lifecycle_bay_pending_v2";
export const EXACT_REVIEW_LIFECYCLE_TELEMETRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type DirectPublicationTelemetryOutcome = "accepted" | "deduped" | "superseded" | "fallback";

export type BatchPublicationTelemetryOutcome = "superseded" | "retryable" | "permanent";

type DirectOutcomeInput = {
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
  claimGeneration: number;
  outcome: DirectPublicationTelemetryOutcome;
  observedAt: number;
};

type BatchOutcomeInput = {
  batchId: string;
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
  claimGeneration: number;
  outcome: BatchPublicationTelemetryOutcome;
  observedAt: number;
};

export class ExactReviewLifecycleTelemetryStore {
  private readonly storage: DurableStorage;
  private schemaReady = false;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    if (this.schemaReady) return;
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE} (
         event_id TEXT PRIMARY KEY,
         canonical_target_key TEXT NOT NULL,
         fence_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
         outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'deduped', 'superseded', 'fallback')),
         observed_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_telemetry_direct_retention
         ON ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE} (observed_at, event_id)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_telemetry_direct_path
         ON ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE}
         (canonical_target_key, fence_key, revision, outcome)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_BATCH_TABLE} (
         event_id TEXT PRIMARY KEY,
         batch_id TEXT NOT NULL,
         canonical_target_key TEXT NOT NULL,
         fence_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
         outcome TEXT NOT NULL CHECK (outcome IN ('superseded', 'retryable', 'permanent')),
         observed_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_telemetry_batch_retention
         ON ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_BATCH_TABLE} (observed_at, event_id)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE} (
         event_id TEXT PRIMARY KEY,
         canonical_target_key TEXT NOT NULL,
         fence_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
         triggered_at INTEGER NOT NULL,
         completed_at INTEGER NOT NULL,
         legacy_batch_path INTEGER NOT NULL DEFAULT 1 CHECK (legacy_batch_path IN (0, 1))
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_bay_event_v2_completed
         ON ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE} (completed_at, event_id)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_bay_event_v2_repository_completed
         ON ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
         (
           LOWER(SUBSTR(canonical_target_key, 1, INSTR(canonical_target_key, '#') - 1)),
           completed_at,
           event_id
         )`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE} (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         coverage_started_at INTEGER NOT NULL,
         tide_base_count INTEGER NOT NULL DEFAULT 0 CHECK (tide_base_count >= 0),
         last_tide_at INTEGER
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE} (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         repository_scope TEXT NOT NULL,
         coverage_started_at INTEGER NOT NULL,
         trigger_coverage_started_at INTEGER,
         tide_base_count INTEGER NOT NULL DEFAULT 0 CHECK (tide_base_count >= 0),
         last_tide_at INTEGER
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE} (
         repository_scope TEXT NOT NULL,
         bucket TEXT NOT NULL CHECK (bucket IN ('terminal', 'washed')),
         event_id TEXT NOT NULL,
         canonical_target_key TEXT NOT NULL,
         outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
         triggered_at INTEGER NOT NULL,
         completed_at INTEGER NOT NULL,
         legacy_batch_path INTEGER NOT NULL DEFAULT 1 CHECK (legacy_batch_path IN (0, 1)),
         PRIMARY KEY (repository_scope, bucket, event_id)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_bay_tide_buffer_v2_rows
         ON ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
         (repository_scope, bucket, completed_at, event_id)`,
    );
    const bayEventColumns = sqlColumnNames(this.storage, EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE);
    if (!bayEventColumns.has("legacy_batch_path")) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
           ADD COLUMN legacy_batch_path INTEGER NOT NULL DEFAULT 1
           CHECK (legacy_batch_path IN (0, 1))`,
      );
    }
    const tideBufferColumns = sqlColumnNames(
      this.storage,
      EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE,
    );
    if (!tideBufferColumns.has("legacy_batch_path")) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
           ADD COLUMN legacy_batch_path INTEGER NOT NULL DEFAULT 1
           CHECK (legacy_batch_path IN (0, 1))`,
      );
    }
    for (const table of [
      EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE,
      EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
    ]) {
      const columns = sqlColumnNames(this.storage, table);
      if (!columns.has("tide_base_count")) {
        this.storage.sql.exec(
          `ALTER TABLE ${table}
             ADD COLUMN tide_base_count INTEGER NOT NULL DEFAULT 0 CHECK (tide_base_count >= 0)`,
        );
      }
      if (!columns.has("last_tide_at")) {
        this.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN last_tide_at INTEGER`);
      }
    }
    const scopeColumns = sqlColumnNames(this.storage, EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE);
    if (!scopeColumns.has("trigger_coverage_started_at")) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
           ADD COLUMN trigger_coverage_started_at INTEGER`,
      );
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE} (
         canonical_target_key TEXT NOT NULL,
         fence_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         projection_json TEXT NOT NULL,
         queued_at INTEGER NOT NULL,
         PRIMARY KEY (canonical_target_key, fence_key, revision)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_bay_pending_v2_queued
         ON ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE} (queued_at, canonical_target_key, fence_key, revision)`,
    );
    this.schemaReady = true;
  }

  recordDirectOutcome(input: DirectOutcomeInput) {
    validateIdentity(input);
    if (!DIRECT_OUTCOMES.has(input.outcome)) throw new Error("invalid direct telemetry outcome");
    const eventId = `direct:${input.fenceKey}:${input.revision}:${input.claimGeneration}:${input.outcome}`;
    this.storage.transactionSync(() => {
      this.pruneSync(input.observedAt);
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE}
           (event_id, canonical_target_key, fence_key, revision, claim_generation, outcome, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        input.canonicalTargetKey,
        input.fenceKey,
        input.revision,
        input.claimGeneration,
        input.outcome,
        input.observedAt,
      );
    });
  }

  recordBatchOutcome(input: BatchOutcomeInput) {
    validateIdentity(input);
    if (!BATCH_OUTCOMES.has(input.outcome)) throw new Error("invalid batch telemetry outcome");
    if (!validText(input.batchId, 1, 200)) throw new Error("invalid telemetry batch id");
    const eventId = `batch:${input.batchId}:${input.fenceKey}:${input.revision}:${input.claimGeneration}:${input.outcome}`;
    this.storage.transactionSync(() => {
      this.pruneSync(input.observedAt);
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_BATCH_TABLE}
           (event_id, batch_id, canonical_target_key, fence_key, revision, claim_generation, outcome, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        input.batchId,
        input.canonicalTargetKey,
        input.fenceKey,
        input.revision,
        input.claimGeneration,
        input.outcome,
        input.observedAt,
      );
    });
  }

  private pruneSync(now: number) {
    const cutoff = now - EXACT_REVIEW_LIFECYCLE_TELEMETRY_RETENTION_MS;
    for (const table of [
      EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE,
      EXACT_REVIEW_LIFECYCLE_TELEMETRY_BATCH_TABLE,
    ]) {
      this.storage.sql.exec(
        `DELETE FROM ${table}
          WHERE rowid IN (
            SELECT rowid FROM ${table} WHERE observed_at < ? ORDER BY observed_at, event_id LIMIT 256
          )`,
        cutoff,
      );
    }
  }
}

const DIRECT_OUTCOMES = new Set<DirectPublicationTelemetryOutcome>([
  "accepted",
  "deduped",
  "superseded",
  "fallback",
]);
const BATCH_OUTCOMES = new Set<BatchPublicationTelemetryOutcome>([
  "superseded",
  "retryable",
  "permanent",
]);

function validateIdentity(input: {
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
  claimGeneration: number;
  observedAt: number;
}) {
  if (
    !validCanonicalTargetKey(input.canonicalTargetKey) ||
    !validText(input.fenceKey, 1, 512) ||
    !positiveInteger(input.revision) ||
    !positiveInteger(input.claimGeneration) ||
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt < 1
  ) {
    throw new Error("invalid lifecycle telemetry identity");
  }
}

function validCanonicalTargetKey(value: string) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(value);
}

function positiveInteger(value: number) {
  return Number.isSafeInteger(value) && value >= 1;
}

function validText(value: string, min: number, max: number) {
  return value.length >= min && value.length <= max && !/[\r\n]/.test(value);
}
