const TERMINAL_LEDGER_TABLE = "exact_review_publication_terminals";
const TERMINAL_LEDGER_HEAD_TABLE = "exact_review_publication_terminal_heads";

export const EXACT_REVIEW_PUBLICATION_TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const EXACT_REVIEW_PUBLICATION_TERMINAL_COMPACTION_LIMIT = 100;

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};

type DurableStorage = {
  sql: SqlStorage;
};

export type ExactReviewPublicationTerminalOutcome = "published" | "superseded" | "closed";

export type ExactReviewPublicationTerminal = {
  targetKey: string;
  sourceRevision: number;
  outcome: ExactReviewPublicationTerminalOutcome;
  terminalAt: number;
  runId?: string;
  batchId?: string;
  stateCommitSha?: string;
};

export type ExactReviewPublicationTerminalMatch = {
  outcome: ExactReviewPublicationTerminalOutcome | "compacted";
  compacted: boolean;
};

/**
 * Stores the terminal result for a review publication revision. Detailed rows
 * expire, but a one-row-per-target high-water mark survives compaction so an
 * old redelivery remains a no-op while a newer source revision can proceed.
 */
export class ExactReviewPublicationTerminalLedger {
  private readonly storage: DurableStorage;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TERMINAL_LEDGER_TABLE} (
         target_key TEXT NOT NULL,
         source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
         terminal_outcome TEXT NOT NULL CHECK (
           terminal_outcome IN ('published', 'superseded', 'closed')
         ),
         terminal_at INTEGER NOT NULL,
         run_id TEXT,
         batch_id TEXT,
         state_commit_sha TEXT,
         PRIMARY KEY (target_key, source_revision)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TERMINAL_LEDGER_HEAD_TABLE} (
         target_key TEXT PRIMARY KEY,
         completed_through_revision INTEGER NOT NULL CHECK (completed_through_revision >= 1),
         updated_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_publication_terminals_compaction
         ON ${TERMINAL_LEDGER_TABLE} (terminal_at, target_key, source_revision)`,
    );
    // A rolling upgrade can encounter detailed rows from an interrupted older
    // deployment. Reconstruct the compacted fence before admitting redelivery.
    this.storage.sql.exec(
      `INSERT INTO ${TERMINAL_LEDGER_HEAD_TABLE}
         (target_key, completed_through_revision, updated_at)
       SELECT target_key, MAX(source_revision), MAX(terminal_at)
         FROM ${TERMINAL_LEDGER_TABLE}
        GROUP BY target_key
       ON CONFLICT(target_key) DO UPDATE SET
         completed_through_revision = MAX(
           completed_through_revision,
           excluded.completed_through_revision
         ),
         updated_at = MAX(updated_at, excluded.updated_at)`,
    );
  }

  terminalFor(
    targetKey: string,
    sourceRevision: number,
  ): ExactReviewPublicationTerminalMatch | null {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT terminal_outcome
           FROM ${TERMINAL_LEDGER_TABLE}
          WHERE target_key = ? AND source_revision = ?`,
        targetKey,
        sourceRevision,
      ),
    )[0];
    if (row) {
      return {
        outcome: String(row.terminal_outcome) as ExactReviewPublicationTerminalOutcome,
        compacted: false,
      };
    }
    const head = Array.from(
      this.storage.sql.exec(
        `SELECT completed_through_revision
           FROM ${TERMINAL_LEDGER_HEAD_TABLE}
          WHERE target_key = ?`,
        targetKey,
      ),
    )[0];
    return Number(head?.completed_through_revision || 0) >= sourceRevision
      ? { outcome: "compacted", compacted: true }
      : null;
  }

  record(terminal: ExactReviewPublicationTerminal): "recorded" | "duplicate" | "conflict" {
    const existing = this.terminalFor(terminal.targetKey, terminal.sourceRevision);
    if (existing) {
      return existing.outcome === terminal.outcome || existing.compacted ? "duplicate" : "conflict";
    }
    this.storage.sql.exec(
      `INSERT INTO ${TERMINAL_LEDGER_TABLE}
         (target_key, source_revision, terminal_outcome, terminal_at, run_id, batch_id, state_commit_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      terminal.targetKey,
      terminal.sourceRevision,
      terminal.outcome,
      terminal.terminalAt,
      terminal.runId ?? null,
      terminal.batchId ?? null,
      terminal.stateCommitSha ?? null,
    );
    this.storage.sql.exec(
      `INSERT INTO ${TERMINAL_LEDGER_HEAD_TABLE}
         (target_key, completed_through_revision, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(target_key) DO UPDATE SET
         completed_through_revision = MAX(
           completed_through_revision,
           excluded.completed_through_revision
         ),
         updated_at = MAX(updated_at, excluded.updated_at)`,
      terminal.targetKey,
      terminal.sourceRevision,
      terminal.terminalAt,
    );
    return "recorded";
  }

  compact(
    now: number,
    options: { retentionMs?: number; limit?: number } = {},
  ): { deleted: number; remaining: number } {
    const retentionMs = options.retentionMs ?? EXACT_REVIEW_PUBLICATION_TERMINAL_RETENTION_MS;
    const limit = options.limit ?? EXACT_REVIEW_PUBLICATION_TERMINAL_COMPACTION_LIMIT;
    const cutoff = now - retentionMs;
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT target_key, source_revision
           FROM ${TERMINAL_LEDGER_TABLE}
          WHERE terminal_at <= ?
          ORDER BY terminal_at, target_key, source_revision
          LIMIT ?`,
        cutoff,
        limit,
      ),
    );
    for (const row of rows) {
      this.storage.sql.exec(
        `DELETE FROM ${TERMINAL_LEDGER_TABLE}
          WHERE target_key = ? AND source_revision = ?`,
        String(row.target_key),
        Number(row.source_revision),
      );
    }
    const remaining = Number(
      Array.from(
        this.storage.sql.exec(
          `SELECT COUNT(*) AS count FROM ${TERMINAL_LEDGER_TABLE} WHERE terminal_at <= ?`,
          cutoff,
        ),
      )[0]?.count ?? 0,
    );
    return { deleted: rows.length, remaining };
  }
}
