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
export const EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE = "exact_review_lifecycle_bay_event_v1";
export const EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE = "exact_review_lifecycle_bay_meta_v1";
export const EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE = "exact_review_lifecycle_bay_scope_v1";
export const EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE = "exact_review_lifecycle_bay_pending_v1";
export const EXACT_REVIEW_LIFECYCLE_TELEMETRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const EXACT_REVIEW_LIFECYCLE_BAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const EXACT_REVIEW_LIFECYCLE_BAY_TIMING_WINDOW_MS = 60 * 60 * 1000;
export const EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD = 20;
export const EXACT_REVIEW_LIFECYCLE_BAY_SCAN_LIMIT = 10_000;
export const EXACT_REVIEW_LIFECYCLE_BAY_RECOVERY_BATCH_LIMIT = 256;

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

type BayLifecycleOutcome = "success" | "failure" | "cancelled";

type BayLifecycleEvent = {
  event_id: string;
  item_key: string;
  outcome: BayLifecycleOutcome;
  triggered_at: number;
  completed_at: number;
};

type BayTerminalRecord = {
  event_id: string;
  item_key: string;
  outcome: BayLifecycleOutcome;
  completed_at: string;
};

export type ExactReviewBayLifecycleSnapshot = {
  version: 1;
  collection: { state: "complete" } | { state: "unknown"; reason: "unavailable" | "over_cap" };
  coverage: {
    started_at: string;
    timing_complete: boolean;
  } | null;
  timings: {
    window_minutes: number;
    sample_kind: "completed_exact_review_lifecycles";
    sample_limit: number;
    overall: { average_ms: number | null; median_ms: number | null; samples: number | null };
  } | null;
  terminal: {
    tide_threshold: number;
    tide_generation: number;
    last_tide_at: string | null;
    terminal_count: number;
    terminal_buffer: BayTerminalRecord[];
    recently_washed: BayTerminalRecord[];
  } | null;
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
         completed_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_bay_event_completed
         ON ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE} (completed_at, event_id)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_bay_event_repository_completed
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
         coverage_started_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE}
         (singleton, coverage_started_at) VALUES (1, ?)`,
      Date.now(),
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE} (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         repository_scope TEXT NOT NULL,
         coverage_started_at INTEGER NOT NULL
       ) STRICT`,
    );
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
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_bay_pending_queued
         ON ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE} (queued_at, canonical_target_key, fence_key, revision)`,
    );
    this.schemaReady = true;
  }

  /**
   * Records the configured public Bay repository scope from the queue's
   * constructor barrier. A changed allowlist starts a fresh timing epoch, so
   * facts observed while a repository was private cannot warm its public view.
   * Public metrics reads only compare against this durable scope; they do not
   * initialize or repair it.
   */
  syncBayRepositoryScope(allowedRepositories?: ReadonlySet<string>, now = Date.now()) {
    this.ensureSchemaSync();
    const repositoryFilter = bayRepositoryFilter(allowedRepositories);
    if (!repositoryFilter || !validTimestamp(now)) return false;
    const current = Array.from(
      this.storage.sql.exec(
        `SELECT repository_scope FROM ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
          WHERE singleton = 1`,
      ),
    )[0];
    if (current && String(current.repository_scope || "") === repositoryFilter.scope) return true;
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
         (singleton, repository_scope, coverage_started_at)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         repository_scope = excluded.repository_scope,
         coverage_started_at = excluded.coverage_started_at`,
      repositoryFilter.scope,
      now,
    );
    return true;
  }

  /**
   * Keeps one mutable terminal fact for every admitted lifecycle revision.
   * Requeues and supersessions remove their provisional record, so a retry
   * cannot advance Bay twice.
   */
  syncBayLifecycle(projection: ExactReviewLifecycleProjection) {
    const identity = [
      projection.canonicalTargetKey,
      projection.fenceKey,
      projection.revision,
    ] as const;
    // Record recovery work before trying to materialize the public aggregate.
    // This often runs inside the lifecycle terminal transaction, so a queue
    // completion can safely consume its lease even if the secondary Bay table
    // is temporarily unavailable: the next metrics read retries this exact
    // immutable terminal projection instead of losing the completion.
    try {
      this.ensureSchemaSync();
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE}
           (canonical_target_key, fence_key, revision, projection_json, queued_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(canonical_target_key, fence_key, revision) DO UPDATE SET
           projection_json = excluded.projection_json,
           queued_at = excluded.queued_at`,
        ...identity,
        JSON.stringify(projection),
        Date.now(),
      );
      this.materializeBayLifecycleSync(projection);
      this.clearBayLifecyclePendingSync(identity);
      projection.bayTelemetryPending = false;
      return true;
    } catch {
      // The lifecycle projection's own durable pending marker is written by
      // its caller after this callback returns. The queue's internal alarm
      // will replay that exact terminal fact, even when this telemetry schema
      // was briefly unavailable.
      return false;
    }
  }

  private materializeBayLifecycleSync(projection: ExactReviewLifecycleProjection) {
    const event = bayLifecycleEvent(projection);
    const identity = [
      projection.canonicalTargetKey,
      projection.fenceKey,
      projection.revision,
    ] as const;
    // Callers may already hold the queue's durable transaction. Durable
    // Objects serialize each invocation, so these synchronous statements stay
    // ordered without opening a nested SQLite transaction.
    // The constructor normally establishes the epoch before any lifecycle
    // completion. Backdate a just-created epoch to its first terminal fact so
    // a same-turn completion cannot fall on the wrong side of the boundary.
    if (event) {
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE}
            SET coverage_started_at = ?
          WHERE singleton = 1 AND coverage_started_at > ?`,
        event.completed_at,
        event.completed_at,
      );
    }
    const coverageStartedAt = this.coverageStartedAtSync();
    this.pruneBayEventsSync(Math.max(Date.now(), coverageStartedAt));
    if (!event) {
      this.storage.sql.exec(
        `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
          WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
        ...identity,
      );
      return;
    }
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
         (event_id, canonical_target_key, fence_key, revision, outcome, triggered_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         outcome = excluded.outcome,
         triggered_at = excluded.triggered_at,
         completed_at = excluded.completed_at`,
      event.event_id,
      projection.canonicalTargetKey,
      projection.fenceKey,
      projection.revision,
      event.outcome,
      event.triggered_at,
      event.completed_at,
    );
  }

  baySnapshot(
    now = Date.now(),
    allowedRepositories?: ReadonlySet<string>,
  ): ExactReviewBayLifecycleSnapshot {
    this.ensureSchemaSync();
    try {
      const repositoryFilter = bayRepositoryFilter(allowedRepositories);
      if (!repositoryFilter) return unknownBaySnapshot("unavailable");
      // Filtered public snapshots are valid only for the exact configured
      // repository set established in the constructor barrier. This makes a
      // new public repository fail closed until a full timing window elapses.
      const coverageStartedAt = allowedRepositories
        ? this.coverageStartedAtForRepositoryScopeSync(repositoryFilter.scope)
        : this.coverageStartedAtSync();
      if (coverageStartedAt === null) return unknownBaySnapshot("unavailable");
      // Physical pruning occurs during lifecycle writes. Apply the same
      // retention boundary at read time so an otherwise idle Durable Object
      // cannot keep showing expired completions before the next write.
      const terminalCoverageStartedAt = Math.max(
        coverageStartedAt,
        now - EXACT_REVIEW_LIFECYCLE_BAY_RETENTION_MS,
      );
      const timingCutoff = Math.max(
        now - EXACT_REVIEW_LIFECYCLE_BAY_TIMING_WINDOW_MS,
        coverageStartedAt,
      );
      const rows = Array.from(
        this.storage.sql.exec(
          `SELECT event_id, canonical_target_key, outcome, triggered_at, completed_at
             FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
            WHERE completed_at >= ? AND completed_at <= ?
              ${repositoryFilter.where}
            ORDER BY completed_at, event_id LIMIT ?`,
          timingCutoff,
          now,
          ...repositoryFilter.bindings,
          EXACT_REVIEW_LIFECYCLE_BAY_SCAN_LIMIT + 1,
        ),
      );
      if (rows.length > EXACT_REVIEW_LIFECYCLE_BAY_SCAN_LIMIT)
        return unknownBaySnapshot("over_cap");
      const durations: number[] = [];
      for (const row of rows) {
        const triggeredAt = Number(row.triggered_at);
        const completedAt = Number(row.completed_at);
        if (
          !validTimestamp(triggeredAt) ||
          !validTimestamp(completedAt) ||
          completedAt < triggeredAt
        )
          return unknownBaySnapshot("unavailable");
        durations.push(completedAt - triggeredAt);
      }

      const totalRows = Array.from(
        this.storage.sql.exec(
          `SELECT COUNT(*) AS count FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
            WHERE completed_at >= ? AND completed_at <= ? ${repositoryFilter.where}`,
          terminalCoverageStartedAt,
          now,
          ...repositoryFilter.bindings,
        ),
      );
      const total = Number(totalRows[0]?.count || 0);
      if (!Number.isSafeInteger(total) || total < 0) return unknownBaySnapshot("unavailable");
      const terminalCount = total % EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD;
      const tideGeneration = Math.floor(total / EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD);
      const lastTideRow =
        tideGeneration > 0
          ? Array.from(
              this.storage.sql.exec(
                `SELECT completed_at FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
                  WHERE completed_at >= ? AND completed_at <= ?
                    ${repositoryFilter.where}
                  ORDER BY completed_at DESC, event_id DESC LIMIT 1 OFFSET ?`,
                terminalCoverageStartedAt,
                now,
                ...repositoryFilter.bindings,
                terminalCount,
              ),
            )[0]
          : undefined;
      // Select by the deterministic event ordering rather than timestamp
      // ranges: several completions may legitimately share a millisecond.
      const bufferRows = terminalCount
        ? Array.from(
            this.storage.sql.exec(
              `SELECT event_id, canonical_target_key, outcome, completed_at
                 FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
                WHERE completed_at >= ? AND completed_at <= ?
                  ${repositoryFilter.where}
                ORDER BY completed_at DESC, event_id DESC LIMIT ?`,
              terminalCoverageStartedAt,
              now,
              ...repositoryFilter.bindings,
              terminalCount,
            ),
          ).reverse()
        : [];
      const washedRows =
        tideGeneration > 0
          ? Array.from(
              this.storage.sql.exec(
                `SELECT event_id, canonical_target_key, outcome, completed_at
                   FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
                  WHERE completed_at >= ? AND completed_at <= ?
                    ${repositoryFilter.where}
                  ORDER BY completed_at DESC, event_id DESC LIMIT ? OFFSET ?`,
                terminalCoverageStartedAt,
                now,
                ...repositoryFilter.bindings,
                EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD,
                terminalCount,
              ),
            ).reverse()
          : [];
      const average = durations.length
        ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
        : null;
      const ordered = [...durations].sort((left, right) => left - right);
      const median = ordered.length
        ? Math.round(
            ordered.length % 2
              ? ordered[Math.floor(ordered.length / 2)]!
              : (ordered[ordered.length / 2 - 1]! + ordered[ordered.length / 2]!) / 2,
          )
        : null;
      return {
        version: 1,
        collection: { state: "complete" },
        coverage: {
          started_at: new Date(coverageStartedAt).toISOString(),
          timing_complete: now - coverageStartedAt >= EXACT_REVIEW_LIFECYCLE_BAY_TIMING_WINDOW_MS,
        },
        timings: {
          window_minutes: EXACT_REVIEW_LIFECYCLE_BAY_TIMING_WINDOW_MS / 60_000,
          sample_kind: "completed_exact_review_lifecycles",
          sample_limit: EXACT_REVIEW_LIFECYCLE_BAY_SCAN_LIMIT,
          overall: { average_ms: average, median_ms: median, samples: durations.length },
        },
        terminal: {
          tide_threshold: EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD,
          tide_generation: tideGeneration,
          last_tide_at:
            lastTideRow && validTimestamp(Number(lastTideRow.completed_at))
              ? new Date(Number(lastTideRow.completed_at)).toISOString()
              : null,
          terminal_count: terminalCount,
          terminal_buffer: bayTerminalRows(bufferRows),
          recently_washed: bayTerminalRows(washedRows),
        },
      };
    } catch {
      return unknownBaySnapshot("unavailable");
    }
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

  private coverageStartedAtSync() {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT coverage_started_at FROM ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE} WHERE singleton = 1`,
      ),
    )[0];
    const startedAt = Number(row?.coverage_started_at);
    if (!validTimestamp(startedAt)) throw new Error("invalid Bay lifecycle coverage epoch");
    return startedAt;
  }

  private coverageStartedAtForRepositoryScopeSync(scope: string) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT repository_scope, coverage_started_at
           FROM ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
          WHERE singleton = 1`,
      ),
    )[0];
    if (!row || String(row.repository_scope || "") !== scope) return null;
    const startedAt = Number(row.coverage_started_at);
    if (!validTimestamp(startedAt)) throw new Error("invalid Bay lifecycle scope coverage epoch");
    return startedAt;
  }

  private clearBayLifecyclePendingSync(
    identity: readonly [canonicalTargetKey: string, fenceKey: string, revision: number],
  ) {
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE}
        WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      ...identity,
    );
  }

  reconcileBayLifecyclePending() {
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT canonical_target_key, fence_key, revision, projection_json
           FROM ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE}
          ORDER BY queued_at, canonical_target_key, fence_key, revision
          LIMIT ?`,
        EXACT_REVIEW_LIFECYCLE_BAY_RECOVERY_BATCH_LIMIT + 1,
      ),
    );
    const pendingMore = rows.length > EXACT_REVIEW_LIFECYCLE_BAY_RECOVERY_BATCH_LIMIT;
    for (const row of rows.slice(0, EXACT_REVIEW_LIFECYCLE_BAY_RECOVERY_BATCH_LIMIT)) {
      const projection = projectionFromRow(String(row.projection_json || ""));
      const identity = [
        String(row.canonical_target_key || ""),
        String(row.fence_key || ""),
        Number(row.revision),
      ] as const;
      if (
        !projection ||
        projection.canonicalTargetKey !== identity[0] ||
        projection.fenceKey !== identity[1] ||
        projection.revision !== identity[2]
      ) {
        return false;
      }
      try {
        this.materializeBayLifecycleSync(projection);
        this.clearBayLifecyclePendingSync(identity);
      } catch {
        return false;
      }
    }
    return !pendingMore;
  }

  hasBayLifecyclePending() {
    try {
      return (
        Array.from(
          this.storage.sql.exec(
            `SELECT 1 AS pending FROM ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE} LIMIT 1`,
          ),
        ).length > 0
      );
    } catch {
      return true;
    }
  }

  private pruneBayEventsSync(now: number) {
    const cutoff = now - EXACT_REVIEW_LIFECYCLE_BAY_RETENTION_MS;
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
        WHERE rowid IN (
          SELECT rowid FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
           WHERE completed_at < ? ORDER BY completed_at, event_id LIMIT 256
        )`,
      cutoff,
    );
    // The public coverage declaration advances with retention, so every
    // completion claimed by the tide is represented by a retained fact.
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE}
          SET coverage_started_at = ?
        WHERE singleton = 1 AND coverage_started_at < ?`,
      cutoff,
      cutoff,
    );
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
          SET coverage_started_at = ?
        WHERE singleton = 1 AND coverage_started_at < ?`,
      cutoff,
      cutoff,
    );
  }
}

function bayLifecycleEvent(projection: ExactReviewLifecycleProjection): BayLifecycleEvent | null {
  const terminal = projection.terminalDisposition;
  if (!terminal) return null;
  const latestReviewResult = projection.reviewResults.reduce<
    ExactReviewLifecycleProjection["reviewResults"][number] | null
  >(
    (latest, result) => (!latest || result.observedAt >= latest.observedAt ? result : latest),
    null,
  );
  let outcome: BayLifecycleOutcome | null = null;
  if (terminal.kind === "review_completed_routed") outcome = "success";
  else if (terminal.kind === "failure")
    outcome = latestReviewResult?.outcome === "cancelled" ? "cancelled" : "failure";
  if (!outcome) return null;
  const triggeredAt = projection.admission.triggeredAt ?? projection.admission.admittedAt;
  const completedAt = terminal.observedAt;
  if (!validTimestamp(triggeredAt) || !validTimestamp(completedAt) || completedAt < triggeredAt)
    return null;
  return {
    event_id: `bay:${projection.fenceKey}:${projection.revision}`,
    item_key: projection.canonicalTargetKey,
    outcome,
    triggered_at: triggeredAt,
    completed_at: completedAt,
  };
}

function bayRepositoryFilter(allowedRepositories?: ReadonlySet<string>) {
  if (!allowedRepositories) return { where: "", bindings: [] as string[], scope: "" };
  const repositories = [
    ...new Set([...allowedRepositories].map((value) => value.trim().toLowerCase())),
  ].sort();
  if (
    repositories.length > 32 ||
    repositories.some((repository) => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository))
  ) {
    return null;
  }
  if (repositories.length === 0) return { where: "AND 1 = 0", bindings: [] as string[], scope: "" };
  return {
    where: `AND LOWER(SUBSTR(canonical_target_key, 1, INSTR(canonical_target_key, '#') - 1)) IN (${repositories.map(() => "?").join(", ")})`,
    bindings: repositories,
    scope: repositories.join(","),
  };
}

function bayTerminalRows(rows: Array<Record<string, unknown>>): BayTerminalRecord[] {
  const events: BayTerminalRecord[] = [];
  for (const row of rows) {
    const eventId = String(row.event_id || "");
    const itemKey = String(row.canonical_target_key || "");
    const outcome = String(row.outcome || "");
    const completedAt = Number(row.completed_at);
    if (
      !eventId ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(itemKey) ||
      !["success", "failure", "cancelled"].includes(outcome) ||
      !validTimestamp(completedAt)
    ) {
      throw new Error("invalid Bay lifecycle terminal row");
    }
    events.push({
      event_id: eventId,
      item_key: itemKey,
      outcome: outcome as BayLifecycleOutcome,
      completed_at: new Date(completedAt).toISOString(),
    });
  }
  return events;
}

export function unknownBaySnapshot(
  reason: "unavailable" | "over_cap",
): ExactReviewBayLifecycleSnapshot {
  return {
    version: 1,
    collection: { state: "unknown", reason },
    coverage: null,
    timings: null,
    terminal: null,
  };
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

function validTimestamp(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function validText(value: string, min: number, max: number) {
  return value.length >= min && value.length <= max && !/[\r\n]/.test(value);
}
