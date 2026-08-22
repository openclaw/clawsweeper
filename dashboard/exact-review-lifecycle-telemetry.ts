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
export const EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE =
  "exact_review_lifecycle_bay_tide_buffer_v1";
export const EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE = "exact_review_lifecycle_bay_pending_v1";
export const EXACT_REVIEW_LIFECYCLE_TELEMETRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const EXACT_REVIEW_LIFECYCLE_BAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const EXACT_REVIEW_LIFECYCLE_BAY_TIMING_WINDOW_MS = 60 * 60 * 1000;
export const EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD = 20;
export const EXACT_REVIEW_LIFECYCLE_BAY_SCAN_LIMIT = 10_000;
export const EXACT_REVIEW_LIFECYCLE_BAY_RECOVERY_BATCH_LIMIT = 256;

// The empty string is the valid durable scope for an explicitly empty public
// allowlist. Keep the unfiltered aggregate in a distinct tide-buffer partition
// so changing to or from that empty public scope cannot corrupt either view.
const BAY_GLOBAL_TIDE_SCOPE = "__all_repositories__";

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

type BayTideProgress = {
  coverageStartedAt: number;
  baseCount: number;
  lastTideAt: number | null;
};

type BayTideSourceProgress = {
  baseCount: number;
  lastTideAt: number | null;
  recentlyWashed: BayLifecycleEvent[];
  terminalBuffer: BayLifecycleEvent[];
};

type BayRepositoryScopeProgress = {
  scope: string;
  progress: BayTideProgress;
  /**
   * A changed public-repository allowlist must not count work triggered while
   * that repository was out of scope. `null` represents the initial durable
   * scope: its in-flight reviews are already public and may have been
   * triggered just before the queue first materialized the scope row.
   */
  triggerCoverageStartedAt: number | null;
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
    const tideProgressBackfillTables = new Set<string>();
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
         coverage_started_at INTEGER NOT NULL,
         tide_base_count INTEGER NOT NULL DEFAULT 0 CHECK (tide_base_count >= 0),
         last_tide_at INTEGER
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
         completed_at INTEGER NOT NULL,
         PRIMARY KEY (repository_scope, bucket, event_id)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_bay_tide_buffer_rows
         ON ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
         (repository_scope, bucket, completed_at, event_id)`,
    );
    for (const table of [
      EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE,
      EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
    ]) {
      const columns = new Set(
        Array.from(this.storage.sql.exec(`SELECT name FROM pragma_table_info('${table}')`)).map(
          (row) => String(row.name || ""),
        ),
      );
      if (!columns.has("tide_base_count")) {
        tideProgressBackfillTables.add(table);
        this.storage.sql.exec(
          `ALTER TABLE ${table}
             ADD COLUMN tide_base_count INTEGER NOT NULL DEFAULT 0 CHECK (tide_base_count >= 0)`,
        );
      }
      if (!columns.has("last_tide_at")) {
        tideProgressBackfillTables.add(table);
        this.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN last_tide_at INTEGER`);
      }
    }
    const scopeColumns = new Set(
      Array.from(
        this.storage.sql.exec(
          `SELECT name FROM pragma_table_info('${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}')`,
        ),
      ).map((row) => String(row.name || "")),
    );
    if (!scopeColumns.has("trigger_coverage_started_at")) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
           ADD COLUMN trigger_coverage_started_at INTEGER`,
      );
      // Existing rows already represented a durable public scope. Preserve
      // their conservative boundary instead of retrospectively treating them
      // as a fresh initialisation.
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
            SET trigger_coverage_started_at = coverage_started_at
          WHERE trigger_coverage_started_at IS NULL`,
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
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_bay_pending_queued
         ON ${EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE} (queued_at, canonical_target_key, fence_key, revision)`,
    );
    // The prior schema retained only bounded timing rows. Recover that visible
    // progress before serving the upgraded aggregate rather than resetting an
    // existing tide to zero on first read after deployment.
    if (tideProgressBackfillTables.has(EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE)) {
      this.rebuildTideProgressFromTimingEventsSync(
        BAY_GLOBAL_TIDE_SCOPE,
        EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE,
        this.tideProgressSync(),
      );
    }
    if (tideProgressBackfillTables.has(EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE)) {
      const scopeRow = this.tideScopeRowSync();
      if (scopeRow) {
        this.rebuildTideProgressFromTimingEventsSync(
          scopeRow.scope,
          EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
          scopeRow.progress,
        );
      }
    }
    if (tideProgressBackfillTables.size) this.backfillLifecycleIdempotencyMarkersSync();
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
    const initialScope = !current;
    // Read the next scope before changing its durable row. If source recovery
    // is temporarily unavailable, preserve the prior scope and let public
    // metrics fail closed without aborting queue initialization.
    let sourceProgress: BayTideSourceProgress | null = null;
    try {
      sourceProgress = this.lifecycleProjectionTableExistsSync()
        ? this.lifecycleTideProgressFromSourceSync(
            repositoryFilter.scope,
            now,
            undefined,
            undefined,
            initialScope ? null : now,
          )
        : null;
    } catch {
      return false;
    }
    if (current) {
      this.storage.sql.exec(
        `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
          WHERE repository_scope = ?`,
        String(current.repository_scope || ""),
      );
    }
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
         (singleton, repository_scope, coverage_started_at, trigger_coverage_started_at, tide_base_count, last_tide_at)
        VALUES (1, ?, ?, ?, 0, NULL)
        ON CONFLICT(singleton) DO UPDATE SET
          repository_scope = excluded.repository_scope,
          coverage_started_at = excluded.coverage_started_at,
          trigger_coverage_started_at = excluded.trigger_coverage_started_at,
          tide_base_count = excluded.tide_base_count,
          last_tide_at = excluded.last_tide_at`,
      repositoryFilter.scope,
      now,
      initialScope ? null : now,
    );
    // A scope is defined by its coverage epoch rather than the order in which
    // a local Durable Object happens to materialize already-observed facts.
    // Its source query returns only the bounded tail needed to publish a
    // compact tide, so a large lifecycle table cannot crash initialization.
    if (sourceProgress) {
      this.replaceTideProgressFromSourceProgressSync(
        repositoryFilter.scope,
        EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
        sourceProgress,
      );
    }
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
    // Durably record recovery work before the separate aggregate transaction.
    // A failed materialization therefore leaves an exact outbox fact for the
    // next alarm instead of losing the terminal completion.
    try {
      this.ensureSchemaSync();
      this.storage.transactionSync(() => {
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
      });
      return this.storage.transactionSync(() => {
        this.materializeBayLifecycleSync(projection);
        this.markBayLifecycleSourceMaterializedSync(projection);
        this.clearBayLifecyclePendingSync(identity);
        projection.bayTelemetryPending = false;
        return true;
      });
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
    // A requeue/supersession must retract its terminal fact before retention
    // removes its timing row. A late requeue rebuilds the compact aggregate
    // from the lifecycle source of truth instead of retaining an unbounded
    // duplicate event ledger.
    if (!event) {
      if (hadBayLifecycleTerminalEvent(projection))
        this.rebuildTideProgressAfterRetractionSync(projection, identity);
      delete projection.bayTelemetryEventId;
      this.pruneBayEventsSync(Math.max(Date.now(), this.coverageStartedAtSync()));
      return;
    }
    // Callers may already hold the queue's durable transaction. Durable
    // Objects serialize each invocation, so these synchronous statements stay
    // ordered without opening a nested SQLite transaction.
    // The constructor normally establishes the epoch before any lifecycle
    // completion. Backdate a just-created epoch to its first terminal fact so
    // a same-turn completion cannot fall on the wrong side of the boundary.
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE}
          SET coverage_started_at = ?
        WHERE singleton = 1 AND coverage_started_at > ?`,
      event.completed_at,
      event.completed_at,
    );
    const coverageStartedAt = this.coverageStartedAtSync();
    this.pruneBayEventsSync(Math.max(Date.now(), coverageStartedAt));
    const timingEventExists = this.bayTimingEventExistsSync(event.event_id);
    if (projection.bayTelemetryEventId === event.event_id || timingEventExists) {
      // A terminal disposition is immutable, but its final review result can
      // be enriched from failed to cancelled on a later callback. Keep the
      // existing completion count while refreshing its retained presentation.
      if (timingEventExists) {
        this.storage.sql.exec(
          `UPDATE ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
              SET outcome = ?, triggered_at = ?, completed_at = ?
            WHERE event_id = ?`,
          event.outcome,
          event.triggered_at,
          event.completed_at,
          event.event_id,
        );
      }
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
            SET outcome = ?, completed_at = ?
          WHERE event_id = ?`,
        event.outcome,
        event.completed_at,
        event.event_id,
      );
      projection.bayTelemetryEventId = event.event_id;
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
    const globalProgress = this.tideProgressSync();
    const scopeRow = this.tideScopeRowSync();
    const scopeIncludesEvent = Boolean(
      scopeRow &&
      event.completed_at >= scopeRow.progress.coverageStartedAt &&
      (scopeRow.triggerCoverageStartedAt === null ||
        event.triggered_at >= scopeRow.triggerCoverageStartedAt) &&
      bayScopeIncludesTarget(scopeRow.scope, event.item_key),
    );
    // Delivery can be retried after later reviews finish. The compact buffer
    // retains the latest ordered boundary, so detect that uncommon case and
    // replay the bounded lifecycle source rather than using arrival order.
    if (
      this.tideCompletionArrivesOutOfOrderSync(BAY_GLOBAL_TIDE_SCOPE, event) ||
      (scopeIncludesEvent && this.tideCompletionArrivesOutOfOrderSync(scopeRow!.scope, event))
    ) {
      this.rebuildTideProgressFromLifecycleSync(projection, identity);
    } else {
      this.recordTideCompletionSync(
        BAY_GLOBAL_TIDE_SCOPE,
        EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE,
        event,
        globalProgress,
      );
      if (scopeIncludesEvent) {
        this.recordTideCompletionSync(
          scopeRow!.scope,
          EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
          event,
          scopeRow!.progress,
        );
      }
    }
    projection.bayTelemetryEventId = event.event_id;
  }

  baySnapshot(
    now = Date.now(),
    allowedRepositories?: ReadonlySet<string>,
  ): ExactReviewBayLifecycleSnapshot {
    this.ensureSchemaSync();
    try {
      const repositoryFilter = bayRepositoryFilter(allowedRepositories);
      if (!repositoryFilter) return unknownBaySnapshot("unavailable");
      if (this.hasBayLifecyclePending()) return unknownBaySnapshot("unavailable");
      // Filtered public snapshots are valid only for the exact configured
      // repository set established in the constructor barrier. This makes a
      // new public repository fail closed until a full timing window elapses.
      const scopeRow = allowedRepositories ? this.tideScopeRowSync() : null;
      if (allowedRepositories && (!scopeRow || scopeRow.scope !== repositoryFilter.scope))
        return unknownBaySnapshot("unavailable");
      const tideProgress = allowedRepositories
        ? (scopeRow?.progress ?? null)
        : this.tideProgressSync();
      if (!tideProgress) return unknownBaySnapshot("unavailable");
      const { coverageStartedAt, baseCount, lastTideAt } = tideProgress;
      const triggerCoverageStartedAt = allowedRepositories
        ? (scopeRow?.triggerCoverageStartedAt ?? null)
        : null;
      const timingCutoff = Math.max(
        now - EXACT_REVIEW_LIFECYCLE_BAY_TIMING_WINDOW_MS,
        coverageStartedAt,
      );
      const rows = Array.from(
        this.storage.sql.exec(
          `SELECT event_id, canonical_target_key, outcome, triggered_at, completed_at
             FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
            WHERE completed_at >= ? AND completed_at <= ?
              AND (? = 0 OR triggered_at >= ?)
              ${repositoryFilter.where}
            ORDER BY completed_at, event_id LIMIT ?`,
          timingCutoff,
          now,
          Number(triggerCoverageStartedAt !== null),
          triggerCoverageStartedAt ?? 0,
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

      // `tide_base_count` is the exact all-time completion count for this
      // scope. The only detailed history retained here is the current
      // remainder (at most 19 rows) and the most recently washed tide.
      const total = baseCount;
      const terminalCount = total % EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD;
      const tideGeneration = Math.floor(total / EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD);
      const tideScope = allowedRepositories ? repositoryFilter.scope : BAY_GLOBAL_TIDE_SCOPE;
      const bufferRows = this.tideBufferRowsSync(tideScope, "terminal");
      const washedRows = this.tideBufferRowsSync(tideScope, "washed");
      if (bufferRows.length !== terminalCount) return unknownBaySnapshot("unavailable");
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
          last_tide_at: lastTideAt === null ? null : new Date(lastTideAt).toISOString(),
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

  private tideProgressSync() {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT coverage_started_at, tide_base_count, last_tide_at
           FROM ${EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE} WHERE singleton = 1`,
      ),
    )[0];
    const startedAt = Number(row?.coverage_started_at);
    if (!validTimestamp(startedAt)) throw new Error("invalid Bay lifecycle coverage epoch");
    return tideProgressFromRow(startedAt, row?.tide_base_count, row?.last_tide_at);
  }

  private coverageStartedAtSync() {
    return this.tideProgressSync().coverageStartedAt;
  }

  private tideProgressForRepositoryScopeSync(scope: string) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT repository_scope, coverage_started_at, tide_base_count, last_tide_at
           FROM ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
          WHERE singleton = 1`,
      ),
    )[0];
    if (!row || String(row.repository_scope || "") !== scope) return null;
    const startedAt = Number(row.coverage_started_at);
    if (!validTimestamp(startedAt)) throw new Error("invalid Bay lifecycle scope coverage epoch");
    return tideProgressFromRow(startedAt, row.tide_base_count, row.last_tide_at);
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
      const pendingProjection = projectionFromRow(String(row.projection_json || ""));
      const identity = [
        String(row.canonical_target_key || ""),
        String(row.fence_key || ""),
        Number(row.revision),
      ] as const;
      // The lifecycle projection is authoritative. An outbox row can be
      // stale if its clear was interrupted after compacting the aggregate;
      // replaying that older serialized object after timing retention would
      // otherwise lose its durable marker and count the completion twice.
      const projection = this.currentLifecycleProjectionSync(identity);
      if (
        !pendingProjection ||
        !projection ||
        pendingProjection.canonicalTargetKey !== identity[0] ||
        pendingProjection.fenceKey !== identity[1] ||
        pendingProjection.revision !== identity[2] ||
        projection.canonicalTargetKey !== identity[0] ||
        projection.fenceKey !== identity[1] ||
        projection.revision !== identity[2]
      ) {
        return false;
      }
      try {
        this.storage.transactionSync(() => {
          this.materializeBayLifecycleSync(projection);
          if (projection.bayTelemetryPending)
            this.markBayLifecycleSourceMaterializedSync(projection);
          this.clearBayLifecyclePendingSync(identity);
        });
      } catch {
        return false;
      }
    }
    return !pendingMore;
  }

  private currentLifecycleProjectionSync(
    identity: readonly [canonicalTargetKey: string, fenceKey: string, revision: number],
  ) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT projection_json FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?
          LIMIT 1`,
        ...identity,
      ),
    )[0];
    return row ? projectionFromRow(String(row.projection_json || "")) : null;
  }

  private markBayLifecycleSourceMaterializedSync(projection: ExactReviewLifecycleProjection) {
    const identity = [
      projection.canonicalTargetKey,
      projection.fenceKey,
      projection.revision,
    ] as const;
    const source = this.currentLifecycleProjectionSync(identity);
    if (!source) {
      throw new Error("missing pending lifecycle source for Bay materialization");
    }
    if (!source.bayTelemetryPending) {
      if (source.bayTelemetryEventId !== projection.bayTelemetryEventId) {
        throw new Error("lifecycle source Bay marker conflicts with materialization");
      }
      return;
    }
    if (projection.bayTelemetryEventId === undefined) delete source.bayTelemetryEventId;
    else source.bayTelemetryEventId = projection.bayTelemetryEventId;
    source.bayTelemetryPending = false;
    source.updatedAt = Date.now();
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          SET projection_json = ?, updated_at = ?, bay_telemetry_pending = 0
        WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      JSON.stringify(source),
      source.updatedAt,
      ...identity,
    );
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
  }

  private bayTimingEventExistsSync(eventId: string) {
    return (
      Array.from(
        this.storage.sql.exec(
          `SELECT 1 AS found FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
            WHERE event_id = ? LIMIT 1`,
          eventId,
        ),
      ).length > 0
    );
  }

  private recordTideCompletionSync(
    scope: string,
    table:
      | typeof EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE
      | typeof EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
    event: BayLifecycleEvent,
    progress: BayTideProgress,
  ) {
    const terminalRows = this.tideBufferRowsSync(scope, "terminal");
    const priorTerminalCount = progress.baseCount % EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD;
    if (terminalRows.length !== priorTerminalCount)
      throw new Error("Bay lifecycle tide buffer does not match its aggregate");
    const total = progress.baseCount + 1;
    if (!Number.isSafeInteger(total)) throw new Error("Bay lifecycle tide counter overflow");
    let lastTideAt = progress.lastTideAt;
    if (total % EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD === 0) {
      this.storage.sql.exec(
        `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
          WHERE repository_scope = ? AND bucket = 'washed'`,
        scope,
      );
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
            SET bucket = 'washed'
          WHERE repository_scope = ? AND bucket = 'terminal'`,
        scope,
      );
      this.insertTideBufferRowSync(scope, "washed", event);
      lastTideAt = event.completed_at;
    } else {
      this.insertTideBufferRowSync(scope, "terminal", event);
    }
    this.storage.sql.exec(
      `UPDATE ${table}
          SET tide_base_count = ?, last_tide_at = ?
        WHERE singleton = 1`,
      total,
      lastTideAt,
    );
  }

  private insertTideBufferRowSync(
    scope: string,
    bucket: "terminal" | "washed",
    event: BayLifecycleEvent,
  ) {
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
         (repository_scope, bucket, event_id, canonical_target_key, outcome, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      scope,
      bucket,
      event.event_id,
      event.item_key,
      event.outcome,
      event.completed_at,
    );
  }

  private tideBufferRowsSync(scope: string, bucket: "terminal" | "washed") {
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT event_id, canonical_target_key, outcome, completed_at
           FROM ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
          WHERE repository_scope = ? AND bucket = ?
          ORDER BY completed_at, event_id LIMIT ?`,
        scope,
        bucket,
        EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD + 1,
      ),
    );
    if (rows.length > EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD)
      throw new Error("Bay lifecycle tide buffer exceeds its bound");
    return rows;
  }

  private tideCompletionArrivesOutOfOrderSync(scope: string, event: BayLifecycleEvent) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT event_id, completed_at
           FROM ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
          WHERE repository_scope = ?
          ORDER BY completed_at DESC, event_id DESC LIMIT 1`,
        scope,
      ),
    )[0];
    if (!row) return false;
    const completedAt = Number(row.completed_at);
    const eventId = String(row.event_id || "");
    if (!validTimestamp(completedAt) || !eventId)
      throw new Error("invalid Bay lifecycle tide buffer row");
    return (
      event.completed_at < completedAt ||
      (event.completed_at === completedAt && event.event_id.localeCompare(eventId) < 0)
    );
  }

  private tideScopeRowSync() {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT repository_scope, coverage_started_at, trigger_coverage_started_at, tide_base_count, last_tide_at
           FROM ${EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE}
           WHERE singleton = 1`,
      ),
    )[0];
    if (!row) return null;
    const triggerCoverageStartedAt =
      row.trigger_coverage_started_at === null || row.trigger_coverage_started_at === undefined
        ? null
        : Number(row.trigger_coverage_started_at);
    if (triggerCoverageStartedAt !== null && !validTimestamp(triggerCoverageStartedAt))
      throw new Error("invalid Bay lifecycle scope trigger coverage epoch");
    return {
      scope: String(row.repository_scope || ""),
      progress: tideProgressFromRow(
        Number(row.coverage_started_at),
        row.tide_base_count,
        row.last_tide_at,
      ),
      triggerCoverageStartedAt,
    } satisfies BayRepositoryScopeProgress;
  }

  private rebuildTideProgressAfterRetractionSync(
    projection: ExactReviewLifecycleProjection,
    identity: readonly [string, string, number],
  ) {
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
        WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
      ...identity,
    );
    this.rebuildTideProgressFromLifecycleSync(projection, identity);
  }

  private rebuildTideProgressFromLifecycleSync(
    projection: ExactReviewLifecycleProjection,
    identity: readonly [string, string, number],
  ) {
    const global = this.tideProgressSync();
    this.replaceTideProgressFromSourceProgressSync(
      BAY_GLOBAL_TIDE_SCOPE,
      EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE,
      this.lifecycleTideProgressFromSourceSync(
        BAY_GLOBAL_TIDE_SCOPE,
        global.coverageStartedAt,
        projection,
        identity,
      ),
    );
    const scopeRow = this.tideScopeRowSync();
    if (scopeRow) {
      this.replaceTideProgressFromSourceProgressSync(
        scopeRow.scope,
        EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
        this.lifecycleTideProgressFromSourceSync(
          scopeRow.scope,
          scopeRow.progress.coverageStartedAt,
          projection,
          identity,
          scopeRow.triggerCoverageStartedAt,
        ),
      );
    }
  }

  /**
   * Rebuilds an aggregate from the durable lifecycle source without loading
   * every projection into JavaScript. SQLite computes the count and ordering,
   * while this method receives only the previous tide and current remainder.
   * That keeps recovery convergent after the source table outgrows a sampled
   * public-read limit.
   */
  private lifecycleTideProgressFromSourceSync(
    scope: string,
    coverageStartedAt: number,
    replacement?: ExactReviewLifecycleProjection,
    identity?: readonly [string, string, number],
    triggerCoverageStartedAt: number | null = coverageStartedAt,
  ) {
    if (!validTimestamp(coverageStartedAt)) throw new Error("invalid Bay lifecycle coverage epoch");
    if (triggerCoverageStartedAt !== null && !validTimestamp(triggerCoverageStartedAt))
      throw new Error("invalid Bay lifecycle trigger coverage epoch");
    const filter = bayRepositoryFilterForTideScope(scope);
    const replacementEvent = replacement ? bayLifecycleEvent(replacement) : null;
    const replacementIdentity = identity ?? ["", "", 0];
    const replacing = Boolean(replacement && identity);
    const rows = Array.from(
      this.storage.sql.exec(
        `WITH lifecycle_events AS (
           SELECT
             'bay:' || fence_key || ':' || revision AS event_id,
             canonical_target_key,
             CASE
               WHEN json_extract(projection_json, '$.terminalDisposition.kind') = 'review_completed_routed'
                 THEN 'success'
               WHEN COALESCE(
                 (
                   SELECT json_extract(result.value, '$.outcome')
                     FROM json_each(projection_json, '$.reviewResults') AS result
                    ORDER BY CAST(json_extract(result.value, '$.observedAt') AS INTEGER) DESC
                    LIMIT 1
                 ),
                 'failed'
               ) = 'cancelled' THEN 'cancelled'
               ELSE 'failure'
             END AS outcome,
             COALESCE(
               CAST(json_extract(projection_json, '$.admission.triggeredAt') AS INTEGER),
               CAST(json_extract(projection_json, '$.admission.admittedAt') AS INTEGER)
             ) AS triggered_at,
             CAST(json_extract(projection_json, '$.terminalDisposition.observedAt') AS INTEGER)
               AS completed_at
           FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
           WHERE json_valid(projection_json)
             AND json_extract(projection_json, '$.terminalDisposition.kind')
                   IN ('review_completed_routed', 'failure')
             AND (
               ? = 0 OR canonical_target_key != ? OR fence_key != ? OR revision != ?
             )
           UNION ALL
           SELECT ?, ?, ?, ?, ? WHERE ? = 1
         ), filtered AS (
            SELECT event_id, canonical_target_key, outcome, triggered_at, completed_at
              FROM lifecycle_events
             WHERE completed_at >= ? AND completed_at >= triggered_at
               AND (? = 0 OR triggered_at >= ?)
               ${filter.where}
         ), ranked AS (
           SELECT
             event_id,
             canonical_target_key,
             outcome,
             triggered_at,
             completed_at,
             ROW_NUMBER() OVER (ORDER BY completed_at, event_id) AS ordinal,
             COUNT(*) OVER () AS total
             FROM filtered
         )
         SELECT event_id, canonical_target_key, outcome, triggered_at, completed_at, ordinal, total
           FROM ranked
          WHERE ordinal > MAX(0, total - (total % ?) - ?)
          ORDER BY ordinal`,
        Number(replacing),
        replacementIdentity[0],
        replacementIdentity[1],
        replacementIdentity[2],
        replacementEvent?.event_id ?? null,
        replacementEvent?.item_key ?? null,
        replacementEvent?.outcome ?? null,
        replacementEvent?.triggered_at ?? null,
        replacementEvent?.completed_at ?? null,
        Number(replacementEvent !== null),
        coverageStartedAt,
        Number(scope !== BAY_GLOBAL_TIDE_SCOPE && triggerCoverageStartedAt !== null),
        triggerCoverageStartedAt ?? 0,
        ...filter.bindings,
        EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD,
        EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD,
      ),
    );
    if (!rows.length) {
      return { baseCount: 0, lastTideAt: null, recentlyWashed: [], terminalBuffer: [] };
    }
    const total = Number(rows[0]!.total);
    if (!Number.isSafeInteger(total) || total < 1)
      throw new Error("invalid Bay lifecycle source count");
    const tideBoundary =
      Math.floor(total / EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD) *
      EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD;
    const expectedRows =
      Math.min(EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD, tideBoundary) + (total - tideBoundary);
    if (rows.length !== expectedRows) throw new Error("incomplete Bay lifecycle source tail");
    const recentlyWashed: BayLifecycleEvent[] = [];
    const terminalBuffer: BayLifecycleEvent[] = [];
    let lastTideAt: number | null = null;
    let previousOrdinal = total - expectedRows;
    for (const row of rows) {
      const ordinal = Number(row.ordinal);
      if (
        !Number.isSafeInteger(ordinal) ||
        ordinal !== previousOrdinal + 1 ||
        Number(row.total) !== total
      ) {
        throw new Error("invalid Bay lifecycle source ordering");
      }
      previousOrdinal = ordinal;
      const event = bayLifecycleEventFromTimingRow(row);
      if (ordinal <= tideBoundary) {
        recentlyWashed.push(event);
        if (ordinal === tideBoundary) lastTideAt = event.completed_at;
      } else {
        terminalBuffer.push(event);
      }
    }
    if ((tideBoundary === 0) !== (lastTideAt === null))
      throw new Error("invalid Bay lifecycle tide boundary");
    return { baseCount: total, lastTideAt, recentlyWashed, terminalBuffer };
  }

  private lifecycleProjectionTableExistsSync() {
    return (
      Array.from(
        this.storage.sql.exec(
          "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
          EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE,
        ),
      ).length > 0
    );
  }

  private backfillLifecycleIdempotencyMarkersSync() {
    if (!this.lifecycleProjectionTableExistsSync()) return;
    // Before compact tide metadata existed, a bounded timing row was the only
    // duplicate guard. Preserve a marker for every existing terminal source,
    // including terminals whose old timing row has already expired, without
    // retaining a second unbounded ledger.
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          SET projection_json = json_set(
            projection_json,
            '$.bayTelemetryEventId',
            'bay:' || fence_key || ':' || revision
          )
        WHERE json_valid(projection_json)
          AND bay_telemetry_pending = 0
          AND json_extract(projection_json, '$.bayTelemetryEventId') IS NULL
          AND json_extract(projection_json, '$.terminalDisposition.kind')
                IN ('review_completed_routed', 'failure')`,
    );
  }

  private replaceTideProgressFromSourceProgressSync(
    scope: string,
    table:
      | typeof EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE
      | typeof EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
    progress: BayTideSourceProgress,
  ) {
    if (!Number.isSafeInteger(progress.baseCount) || progress.baseCount < 0)
      throw new Error("invalid Bay lifecycle source aggregate");
    if (
      progress.recentlyWashed.length > EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD ||
      progress.terminalBuffer.length >= EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD
    ) {
      throw new Error("invalid Bay lifecycle source tail");
    }
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
        WHERE repository_scope = ?`,
      scope,
    );
    for (const event of progress.recentlyWashed)
      this.insertTideBufferRowSync(scope, "washed", event);
    for (const event of progress.terminalBuffer)
      this.insertTideBufferRowSync(scope, "terminal", event);
    this.storage.sql.exec(
      `UPDATE ${table} SET tide_base_count = ?, last_tide_at = ? WHERE singleton = 1`,
      progress.baseCount,
      progress.lastTideAt,
    );
  }

  private replaceTideProgressFromEventsSync(
    scope: string,
    table:
      | typeof EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE
      | typeof EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
    coverageStartedAt: number,
    events: ReadonlyArray<BayLifecycleEvent>,
  ) {
    const retained = events.filter(
      (event) =>
        event.completed_at >= coverageStartedAt &&
        (scope === BAY_GLOBAL_TIDE_SCOPE || event.triggered_at >= coverageStartedAt),
    );
    const total = retained.length;
    if (!Number.isSafeInteger(total)) throw new Error("Bay lifecycle tide counter overflow");
    const tideBoundary =
      Math.floor(total / EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD) *
      EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD;
    const lastTideAt = tideBoundary ? retained[tideBoundary - 1]!.completed_at : null;
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE}
        WHERE repository_scope = ?`,
      scope,
    );
    for (const event of retained.slice(Math.max(0, tideBoundary - 20), tideBoundary))
      this.insertTideBufferRowSync(scope, "washed", event);
    for (const event of retained.slice(tideBoundary))
      this.insertTideBufferRowSync(scope, "terminal", event);
    this.storage.sql.exec(
      `UPDATE ${table} SET tide_base_count = ?, last_tide_at = ? WHERE singleton = 1`,
      total,
      lastTideAt,
    );
  }

  private rebuildTideProgressFromTimingEventsSync(
    scope: string,
    table:
      | typeof EXACT_REVIEW_LIFECYCLE_BAY_META_TABLE
      | typeof EXACT_REVIEW_LIFECYCLE_BAY_SCOPE_TABLE,
    progress: BayTideProgress,
  ) {
    const repositoryFilter = bayRepositoryFilterForTideScope(scope);
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT event_id, canonical_target_key, outcome, triggered_at, completed_at
             FROM ${EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE}
           WHERE completed_at >= ?
             AND (? = 0 OR triggered_at >= ?)
             ${repositoryFilter.where}
           ORDER BY completed_at, event_id`,
        progress.coverageStartedAt,
        Number(scope !== BAY_GLOBAL_TIDE_SCOPE),
        progress.coverageStartedAt,
        ...repositoryFilter.bindings,
      ),
    );
    this.replaceTideProgressFromEventsSync(
      scope,
      table,
      progress.coverageStartedAt,
      rows.map(bayLifecycleEventFromTimingRow),
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
    event_id: bayLifecycleEventId(projection),
    item_key: projection.canonicalTargetKey,
    outcome,
    triggered_at: triggeredAt,
    completed_at: completedAt,
  };
}

function hadBayLifecycleTerminalEvent(projection: ExactReviewLifecycleProjection) {
  return projection.terminalDispositions.some(
    (terminal) => terminal.kind === "review_completed_routed" || terminal.kind === "failure",
  );
}

function bayLifecycleEventId(projection: ExactReviewLifecycleProjection) {
  return `bay:${projection.fenceKey}:${projection.revision}`;
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

function bayRepositoryFilterForTideScope(scope: string) {
  if (scope === BAY_GLOBAL_TIDE_SCOPE) return { where: "", bindings: [] as string[] };
  const filter = bayRepositoryFilter(new Set(scope ? scope.split(",") : []));
  if (!filter || filter.scope !== scope) throw new Error("invalid Bay lifecycle tide scope");
  return filter;
}

function bayLifecycleEventFromTimingRow(row: Record<string, unknown>): BayLifecycleEvent {
  const eventId = String(row.event_id || "");
  const itemKey = String(row.canonical_target_key || "");
  const outcome = String(row.outcome || "") as BayLifecycleOutcome;
  const triggeredAt = Number(row.triggered_at);
  const completedAt = Number(row.completed_at);
  if (
    !eventId ||
    !validCanonicalTargetKey(itemKey) ||
    !["success", "failure", "cancelled"].includes(outcome) ||
    !validTimestamp(triggeredAt) ||
    !validTimestamp(completedAt) ||
    completedAt < triggeredAt
  ) {
    throw new Error("invalid retained Bay lifecycle timing event");
  }
  return {
    event_id: eventId,
    item_key: itemKey,
    outcome,
    triggered_at: triggeredAt,
    completed_at: completedAt,
  };
}

function bayScopeIncludesTarget(scope: string, canonicalTargetKey: string) {
  if (!validCanonicalTargetKey(canonicalTargetKey) || !scope) return false;
  const separator = canonicalTargetKey.indexOf("#");
  return scope.split(",").includes(canonicalTargetKey.slice(0, separator).toLowerCase());
}

function tideProgressFromRow(
  coverageStartedAt: number,
  tideBaseCount: unknown,
  lastTideAt: unknown,
): BayTideProgress {
  if (!validTimestamp(coverageStartedAt)) throw new Error("invalid Bay lifecycle coverage epoch");
  const baseCount = Number(tideBaseCount ?? 0);
  if (!Number.isSafeInteger(baseCount) || baseCount < 0)
    throw new Error("invalid Bay lifecycle tide base");
  if (lastTideAt === null || lastTideAt === undefined)
    return { coverageStartedAt, baseCount, lastTideAt: null };
  const parsedLastTideAt = Number(lastTideAt);
  if (!validTimestamp(parsedLastTideAt)) throw new Error("invalid Bay lifecycle tide boundary");
  return { coverageStartedAt, baseCount, lastTideAt: parsedLastTideAt };
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
