import {
  EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE,
  commandAcknowledgementState,
  lifecycleState,
  type ExactReviewLifecycleProjection,
  type LifecycleTerminalDisposition,
} from "./exact-review-lifecycle.ts";

export const EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE =
  "exact_review_lifecycle_telemetry_direct_v1";
export const EXACT_REVIEW_LIFECYCLE_TELEMETRY_BATCH_TABLE =
  "exact_review_lifecycle_telemetry_batch_v1";
export const EXACT_REVIEW_LIFECYCLE_TELEMETRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};

type DurableStorage = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};

export type DirectPublicationTelemetryOutcome = "accepted" | "deduped" | "superseded" | "fallback";

export type BatchPublicationTelemetryOutcome = "superseded" | "retryable" | "permanent";

/**
 * Producer-only durable telemetry contract. Its counts are derived from the
 * lifecycle projection and server-observed publication results, never from a
 * workflow run or a visible command-status acknowledgement.
 */
export type ExactReviewLifecycleTelemetryV1 = {
  version: 1;
  generatedAt: number;
  inventory: {
    uniqueTargets: number;
    targetRevisions: number;
    lifecycleRecords: number;
  };
  age: {
    activeRecords: number;
    oldestActiveMs: number | null;
  };
  terminalCoverage: {
    trackedRecords: number;
    currentRecords: number;
    durableTerminalRecords: number;
    durableTerminalCoveragePercent: number | null;
    unknownTerminalRecords: number;
    acknowledgementPendingRecords: number;
    nonCurrentRecords: number;
    terminalClasses: Record<LifecycleTerminalDisposition, number>;
  };
  publication: {
    direct: Record<DirectPublicationTelemetryOutcome | "unknown", number>;
    batch: Record<"accepted" | "deduped" | BatchPublicationTelemetryOutcome, number>;
    lifecycleRetries: number;
    lastSuccessfulCanonicalAcceptanceAt: number | null;
  };
  invalidProjectionRows: number;
};

export type ExactReviewLifecycleTelemetrySummary = ExactReviewLifecycleTelemetryV1;

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

const TERMINAL_CLASSES: LifecycleTerminalDisposition[] = [
  "review_completed_routed",
  "superseded",
  "requeue",
  "dead_letter",
  "target_closed",
  "target_missing",
  "policy_noop",
  "guarded_open",
  "failure",
];

export class ExactReviewLifecycleTelemetryStore {
  private readonly storage: DurableStorage;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
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

  /**
   * Intentionally has no queue fetch route in Workstream 3. A future,
   * maintainer-approved authenticated operator reader may aggregate this
   * producer contract, but must not turn it into Bay/public status data.
   */
  summary(now: number): ExactReviewLifecycleTelemetrySummary {
    const retentionCutoff = now - EXACT_REVIEW_LIFECYCLE_TELEMETRY_RETENTION_MS;
    const projections: ExactReviewLifecycleProjection[] = [];
    let invalidProjectionRows = 0;
    for (const row of this.storage.sql.exec(
      `SELECT projection_json FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}`,
    )) {
      const projection = projectionFromRow(String(row.projection_json || ""));
      if (projection) projections.push(projection);
      else invalidProjectionRows += 1;
    }

    const maxRevisionByTarget = new Map<string, number>();
    for (const projection of projections) {
      maxRevisionByTarget.set(
        projection.canonicalTargetKey,
        Math.max(maxRevisionByTarget.get(projection.canonicalTargetKey) ?? 0, projection.revision),
      );
    }

    const terminalClasses = Object.fromEntries(TERMINAL_CLASSES.map((kind) => [kind, 0])) as Record<
      LifecycleTerminalDisposition,
      number
    >;
    const direct = emptyDirectOutcomes();
    const batch = emptyBatchOutcomes();
    let activeRecords = 0;
    let oldestActiveMs: number | null = null;
    let durableTerminalRecords = 0;
    let unknownTerminalRecords = 0;
    let acknowledgementPendingRecords = 0;
    let nonCurrentRecords = 0;
    let lifecycleRetries = 0;
    let lastSuccessfulCanonicalAcceptanceAt: number | null = null;
    const directKnownByRecord = new Set<string>();

    for (const row of this.storage.sql.exec(
      `SELECT canonical_target_key, fence_key, revision
         FROM ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE}
        WHERE observed_at >= ?`,
      retentionCutoff,
    )) {
      directKnownByRecord.add(
        identityKey({
          canonicalTargetKey: String(row.canonical_target_key || ""),
          fenceKey: String(row.fence_key || ""),
          revision: Number(row.revision),
        }),
      );
    }
    for (const row of this.storage.sql.exec(
      `SELECT outcome, COUNT(*) AS count FROM ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_DIRECT_TABLE}
        WHERE observed_at >= ?
        GROUP BY outcome`,
      retentionCutoff,
    )) {
      const outcome = String(row.outcome || "") as DirectPublicationTelemetryOutcome;
      if (DIRECT_OUTCOMES.has(outcome)) direct[outcome] = Number(row.count || 0);
    }
    for (const row of this.storage.sql.exec(
      `SELECT outcome, COUNT(*) AS count FROM ${EXACT_REVIEW_LIFECYCLE_TELEMETRY_BATCH_TABLE}
        WHERE observed_at >= ?
        GROUP BY outcome`,
      retentionCutoff,
    )) {
      const outcome = String(row.outcome || "") as BatchPublicationTelemetryOutcome;
      if (BATCH_OUTCOMES.has(outcome)) batch[outcome] = Number(row.count || 0);
    }

    for (const projection of projections) {
      const state = lifecycleState(projection);
      const acknowledgement = commandAcknowledgementState(projection);
      const terminal = projection.terminalDisposition?.kind ?? null;
      const isCurrent =
        projection.revision === maxRevisionByTarget.get(projection.canonicalTargetKey) &&
        state !== "superseded" &&
        state !== "requeue";
      if (!isCurrent) nonCurrentRecords += 1;
      if (terminal) {
        durableTerminalRecords += 1;
        terminalClasses[terminal] += 1;
      } else {
        unknownTerminalRecords += 1;
        activeRecords += 1;
        const age = Math.max(0, now - projection.admission.admittedAt);
        oldestActiveMs = Math.max(oldestActiveMs ?? 0, age);
      }
      if (acknowledgement === "pending") acknowledgementPendingRecords += 1;
      lifecycleRetries += Math.max(0, projection.claims.length - 1);
      for (const receipt of projection.canonicalReceipts) {
        if (receipt.observedAt < retentionCutoff) continue;
        if (receipt.outcome === "accepted" || receipt.outcome === "deduped") {
          lastSuccessfulCanonicalAcceptanceAt = Math.max(
            lastSuccessfulCanonicalAcceptanceAt ?? 0,
            receipt.observedAt,
          );
        }
        if (isBatchFence(projection.fenceKey)) batch[receipt.outcome] += 1;
      }
      if (!isBatchFence(projection.fenceKey)) {
        const key = identityKey(projection);
        if (!directKnownByRecord.has(key) && !projection.canonicalReceipts.length)
          direct.unknown += 1;
      }
    }

    const targetRevisions = new Set(
      projections.map((projection) => `${projection.canonicalTargetKey}:${projection.revision}`),
    ).size;
    return {
      version: 1,
      generatedAt: now,
      inventory: {
        uniqueTargets: maxRevisionByTarget.size,
        targetRevisions,
        lifecycleRecords: projections.length,
      },
      age: { activeRecords, oldestActiveMs },
      terminalCoverage: {
        trackedRecords: projections.length,
        currentRecords: projections.length - nonCurrentRecords,
        durableTerminalRecords,
        durableTerminalCoveragePercent: projections.length
          ? Math.round((durableTerminalRecords / projections.length) * 10_000) / 100
          : null,
        unknownTerminalRecords,
        acknowledgementPendingRecords,
        nonCurrentRecords,
        terminalClasses,
      },
      publication: {
        direct,
        batch,
        lifecycleRetries,
        lastSuccessfulCanonicalAcceptanceAt,
      },
      invalidProjectionRows,
    };
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

function emptyDirectOutcomes() {
  return { accepted: 0, deduped: 0, superseded: 0, fallback: 0, unknown: 0 };
}

function emptyBatchOutcomes() {
  return { accepted: 0, deduped: 0, superseded: 0, retryable: 0, permanent: 0 };
}

function projectionFromRow(value: string): ExactReviewLifecycleProjection | null {
  try {
    const projection = JSON.parse(value) as ExactReviewLifecycleProjection;
    if (
      !projection ||
      projection.version !== 1 ||
      !validCanonicalTargetKey(projection.canonicalTargetKey) ||
      !validText(projection.fenceKey, 1, 512) ||
      !positiveInteger(projection.revision)
    ) {
      return null;
    }
    return projection;
  } catch {
    return null;
  }
}

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

function identityKey(input: { canonicalTargetKey: string; fenceKey: string; revision: number }) {
  return `${input.canonicalTargetKey}\u0000${input.fenceKey}\u0000${input.revision}`;
}

function isBatchFence(fenceKey: string) {
  return fenceKey.includes("@publish:");
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
