export const EXACT_REVIEW_PUBLICATION_BATCH_TABLE = "exact_review_publication_batches";
export const EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE = "exact_review_publication_batch_items";
const EXACT_REVIEW_PUBLICATION_BATCH_GENERATION_TABLE =
  "exact_review_publication_batch_generations";

const DEFAULT_COMPLETED_BATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_LIMIT = 100;

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};

type DurableStorage = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};

export type PublicationBatchCandidate = {
  itemKey: string;
  revision: number;
};

export type PublicationBatchTerminalOutcome = "published" | "superseded" | "lease_expired";

export type PublicationBatchItem = PublicationBatchCandidate & {
  claimGeneration: number;
  terminalOutcome: PublicationBatchTerminalOutcome | null;
};

export type PublicationBatch = {
  batchId: string;
  state: "leased" | "completed" | "expired";
  leaseOwner: string;
  leaseExpiresAt: number;
  configuredBatchSize: number;
  attempt: number;
  createdAt: number;
  completedAt: number | null;
  stateCommitSha: string | null;
  failureFingerprint: string | null;
  items: PublicationBatchItem[];
};

export type PublicationBatchCompletion = PublicationBatchCandidate & {
  claimGeneration: number;
  terminalOutcome: PublicationBatchTerminalOutcome;
};

export type PublicationBatchFence = PublicationBatchCandidate & {
  claimGeneration: number;
};

export type PublicationBatchStats = {
  leased: number;
  completed: number;
  expired: number;
  activeItems: number;
  activeItemKeys: string[];
  nextLeaseExpiresAt: number | null;
  oldestActiveAt: number | null;
  reclaimedItemsRetained: number;
  cleanup: {
    deletedThisPass: number;
    eligibleRemaining: number;
    limit: number;
  };
};

export class ExactReviewPublicationBatchStore {
  private readonly storage: DurableStorage;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE} (
         batch_id TEXT PRIMARY KEY,
         state TEXT NOT NULL CHECK (state IN ('leased', 'completed', 'expired')),
         lease_owner TEXT NOT NULL,
         lease_expires_at INTEGER NOT NULL,
         configured_batch_size INTEGER NOT NULL DEFAULT 1 CHECK (configured_batch_size >= 1),
         attempt INTEGER NOT NULL CHECK (attempt >= 1),
         created_at INTEGER NOT NULL,
         completed_at INTEGER,
         state_commit_sha TEXT,
         failure_fingerprint TEXT
       ) STRICT`,
    );
    const batchColumns = new Set(
      Array.from(
        this.storage.sql.exec(
          `SELECT name FROM pragma_table_info('${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}')`,
        ),
      ).map((row) => String(row.name || "")),
    );
    if (!batchColumns.has("configured_batch_size")) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
           ADD COLUMN configured_batch_size INTEGER NOT NULL DEFAULT 1
             CHECK (configured_batch_size >= 1)`,
      );
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE} (
         batch_id TEXT NOT NULL,
         item_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
         terminal_outcome TEXT CHECK (
           terminal_outcome IS NULL OR terminal_outcome IN (
             'published', 'superseded', 'lease_expired'
           )
         ),
         PRIMARY KEY (batch_id, item_key),
         FOREIGN KEY (batch_id) REFERENCES ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE} (batch_id)
           ON DELETE CASCADE
       ) STRICT`,
    );
    // Only unfinished membership owns an item. Expiry terminalizes that membership,
    // preserving its fencing generation while allowing a later batch to reclaim the item.
    this.storage.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS exact_review_publication_batch_items_active
         ON ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE} (item_key)
       WHERE terminal_outcome IS NULL`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_publication_batches_cleanup
         ON ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE} (state, completed_at, batch_id)`,
    );
    // Cleanup may delete batch receipts, but fencing must outlive those receipts so
    // delayed completions can never match a later lease after an ID is reused.
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_PUBLICATION_BATCH_GENERATION_TABLE} (
         item_key TEXT PRIMARY KEY,
         claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1)
       ) STRICT`,
    );
    // Pre-column leases cannot recover their original configured cap. Use their
    // durable membership count as the smallest safe telemetry denominator.
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
          SET configured_batch_size = MAX(
            configured_batch_size,
            (SELECT COUNT(*) FROM ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE}
              WHERE batch_id = ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}.batch_id)
          )`,
    );
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_PUBLICATION_BATCH_GENERATION_TABLE}
         (item_key, claim_generation)
       SELECT item_key, MAX(claim_generation)
         FROM ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE}
        GROUP BY item_key
       ON CONFLICT (item_key) DO UPDATE SET claim_generation = MAX(
         claim_generation,
         excluded.claim_generation
       )`,
    );
  }

  claim(input: {
    batchId: string;
    leaseOwner: string;
    leaseExpiresAt: number;
    now: number;
    maxItems: number;
    maxConcurrentBatches?: number;
    candidates: PublicationBatchCandidate[];
  }): PublicationBatch | null {
    return this.storage.transactionSync(() => {
      this.reclaimExpiredSync(input.now);
      const existing = this.readBatchSync(input.batchId);
      if (existing) {
        return existing.state === "leased" && existing.leaseOwner === input.leaseOwner
          ? existing
          : null;
      }
      const activeBatches = Number(
        Array.from(
          this.storage.sql.exec(
            `SELECT COUNT(*) AS count FROM ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
              WHERE state = 'leased'`,
          ),
        )[0]?.count ?? 0,
      );
      const maxConcurrentBatches = Math.max(1, input.maxConcurrentBatches ?? 1);
      // Batch preparation is isolated per workflow. Bound concurrent owners here
      // while the state-writer coordinator remains the sole mutation boundary.
      if (activeBatches >= maxConcurrentBatches) return null;
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
           (batch_id, state, lease_owner, lease_expires_at, configured_batch_size,
            attempt, created_at)
         VALUES (?, 'leased', ?, ?, ?, 1, ?)`,
        input.batchId,
        input.leaseOwner,
        input.leaseExpiresAt,
        input.maxItems,
        input.now,
      );
      for (const candidate of input.candidates) {
        if (this.countUnfinishedItemsSync(input.batchId) >= input.maxItems) break;
        const generation = this.nextClaimGenerationSync(candidate.itemKey);
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE}
             (batch_id, item_key, revision, claim_generation)
           VALUES (?, ?, ?, ?)`,
          input.batchId,
          candidate.itemKey,
          candidate.revision,
          generation,
        );
      }
      const batch = this.readBatchSync(input.batchId);
      if (!batch?.items.length) {
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE} WHERE batch_id = ?`,
          input.batchId,
        );
        return null;
      }
      return batch;
    });
  }

  fetch(batchId: string, leaseOwner: string, now: number): PublicationBatch | null {
    return this.storage.transactionSync(() => {
      this.reclaimExpiredSync(now);
      const batch = this.readBatchSync(batchId);
      return batch &&
        batch.leaseOwner === leaseOwner &&
        (batch.state === "leased" || batch.state === "completed")
        ? batch
        : null;
    });
  }

  heartbeat(
    batchId: string,
    leaseOwner: string,
    members: PublicationBatchFence[],
    leaseExpiresAt: number,
    now: number,
  ): PublicationBatch | null {
    return this.storage.transactionSync(() => {
      this.reclaimExpiredSync(now);
      const batch = this.readBatchSync(batchId);
      if (!batch || batch.state !== "leased" || batch.leaseOwner !== leaseOwner) return null;
      const unfinished = batch.items.filter((item) => item.terminalOutcome === null);
      const batchMembers = new Map(batch.items.map((item) => [item.itemKey, item]));
      const supplied = new Map(members.map((member) => [member.itemKey, member]));
      if (
        supplied.size !== members.length ||
        members.some((member) => {
          const item = batchMembers.get(member.itemKey);
          return (
            item?.revision !== member.revision || item.claimGeneration !== member.claimGeneration
          );
        }) ||
        unfinished.some((item) => !supplied.has(item.itemKey))
      ) {
        return null;
      }
      // Extend from the server clock. A delayed worker must never shorten its own
      // lease by replaying a heartbeat calculated before an earlier renewal.
      const nextExpiry = Math.max(batch.leaseExpiresAt, leaseExpiresAt);
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
            SET lease_expires_at = ?
          WHERE batch_id = ? AND state = 'leased' AND lease_owner = ?`,
        nextExpiry,
        batchId,
        leaseOwner,
      );
      return this.readBatchSync(batchId);
    });
  }

  activeLeaseSnapshot(now: number) {
    return this.storage.transactionSync(() => {
      this.reclaimExpiredSync(now);
      return this.activeLeaseSnapshotSync();
    });
  }

  complete(
    batchId: string,
    leaseOwner: string,
    completions: PublicationBatchCompletion[],
    now: number,
    metadata: { stateCommitSha?: string; failureFingerprint?: string } = {},
    onAccepted?: (completions: PublicationBatchCompletion[]) => void,
  ): PublicationBatch | null {
    return this.storage.transactionSync(() => {
      this.reclaimExpiredSync(now);
      const batch = this.readBatchSync(batchId);
      if (!batch || batch.leaseOwner !== leaseOwner) return null;
      if (batch.state !== "leased") {
        const membersByKey = new Map(batch.items.map((item) => [item.itemKey, item]));
        const matchesFence = completions.every((completion) => {
          const member = membersByKey.get(completion.itemKey);
          return (
            member?.revision === completion.revision &&
            member.claimGeneration === completion.claimGeneration
          );
        });
        // A delayed always() cleanup may race a successful acknowledgement or
        // lease expiry. Matching immutable fences make either retry an
        // idempotent no-op; stale generations and wrong owners still fail.
        return matchesFence ? batch : null;
      }
      const unfinishedByKey = new Map(
        batch.items
          .filter((item) => item.terminalOutcome === null)
          .map((item) => [item.itemKey, item]),
      );
      const accepted = completions.filter((completion) => {
        const current = unfinishedByKey.get(completion.itemKey);
        return (
          current?.revision === completion.revision &&
          current.claimGeneration === completion.claimGeneration
        );
      });
      onAccepted?.(accepted);
      for (const completion of accepted) {
        this.storage.sql.exec(
          `UPDATE ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE}
              SET terminal_outcome = ?
            WHERE batch_id = ? AND item_key = ? AND revision = ?
              AND claim_generation = ? AND terminal_outcome IS NULL`,
          completion.terminalOutcome,
          batchId,
          completion.itemKey,
          completion.revision,
          completion.claimGeneration,
        );
      }
      if (accepted.length) {
        this.storage.sql.exec(
          `UPDATE ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
              SET state_commit_sha = COALESCE(state_commit_sha, ?),
                  failure_fingerprint = COALESCE(failure_fingerprint, ?)
            WHERE batch_id = ? AND state = 'leased'`,
          metadata.stateCommitSha ?? null,
          metadata.failureFingerprint ?? null,
          batchId,
        );
      }
      const unfinished = this.countUnfinishedItemsSync(batchId);
      if (unfinished === 0) {
        this.storage.sql.exec(
          `UPDATE ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
              SET state = 'completed', completed_at = ?
            WHERE batch_id = ? AND state = 'leased'`,
          now,
          batchId,
        );
      }
      return this.readBatchSync(batchId);
    });
  }

  stats(
    now: number,
    options: { completedTtlMs?: number; cleanupLimit?: number } = {},
  ): PublicationBatchStats {
    return this.storage.transactionSync(() => {
      this.reclaimExpiredSync(now);
      const completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_BATCH_TTL_MS;
      const cleanupLimit = options.cleanupLimit ?? DEFAULT_CLEANUP_LIMIT;
      const cutoff = now - completedTtlMs;
      const cleanupIds = Array.from(
        this.storage.sql.exec(
          `SELECT batch_id FROM ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
            WHERE state IN ('completed', 'expired') AND completed_at <= ?
            ORDER BY completed_at, batch_id LIMIT ?`,
          cutoff,
          cleanupLimit,
        ),
        (row) => String(row.batch_id),
      );
      for (const batchId of cleanupIds) {
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE} WHERE batch_id = ?`,
          batchId,
        );
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
            WHERE batch_id = ? AND state IN ('completed', 'expired')`,
          batchId,
        );
      }
      const rows = Array.from(
        this.storage.sql.exec(
          `SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest_at
             FROM ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE} GROUP BY state`,
        ),
      );
      const counts = new Map(rows.map((row) => [String(row.state), Number(row.count)]));
      const leased = rows.find((row) => row.state === "leased");
      const activeLease = this.activeLeaseSnapshotSync();
      const reclaimedItemsRetained = Number(
        Array.from(
          this.storage.sql.exec(
            `SELECT COUNT(*) AS count FROM ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE}
              WHERE terminal_outcome = 'lease_expired'`,
          ),
        )[0]?.count ?? 0,
      );
      const eligibleRemaining = Number(
        Array.from(
          this.storage.sql.exec(
            `SELECT COUNT(*) AS count FROM ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
              WHERE state IN ('completed', 'expired') AND completed_at <= ?`,
            cutoff,
          ),
        )[0]?.count ?? 0,
      );
      return {
        leased: counts.get("leased") ?? 0,
        completed: counts.get("completed") ?? 0,
        expired: counts.get("expired") ?? 0,
        activeItems: activeLease.itemKeys.length,
        activeItemKeys: activeLease.itemKeys,
        nextLeaseExpiresAt: activeLease.nextLeaseExpiresAt,
        oldestActiveAt: leased ? Number(leased.oldest_at) : null,
        reclaimedItemsRetained,
        cleanup: { deletedThisPass: cleanupIds.length, eligibleRemaining, limit: cleanupLimit },
      };
    });
  }

  private reclaimExpiredSync(now: number) {
    const expired = Array.from(
      this.storage.sql.exec(
        `SELECT batch_id FROM ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
          WHERE state = 'leased' AND lease_expires_at <= ?`,
        now,
      ),
      (row) => String(row.batch_id),
    );
    for (const batchId of expired) {
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE}
            SET terminal_outcome = 'lease_expired'
          WHERE batch_id = ? AND terminal_outcome IS NULL`,
        batchId,
      );
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE}
            SET state = 'expired', completed_at = ?
          WHERE batch_id = ? AND state = 'leased'`,
        now,
        batchId,
      );
    }
  }

  private activeLeaseSnapshotSync() {
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT membership.item_key, membership.batch_id, batch.lease_expires_at
           FROM ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE} AS membership
           JOIN ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE} AS batch
             ON batch.batch_id = membership.batch_id
          WHERE batch.state = 'leased' AND membership.terminal_outcome IS NULL
          ORDER BY membership.item_key`,
      ),
    );
    return {
      itemKeys: rows.map((row) => String(row.item_key)),
      activeBatches: new Set(rows.map((row) => String(row.batch_id))).size,
      nextLeaseExpiresAt: rows.length
        ? Math.min(...rows.map((row) => Number(row.lease_expires_at)))
        : null,
    };
  }

  private nextClaimGenerationSync(itemKey: string) {
    const row = Array.from(
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_PUBLICATION_BATCH_GENERATION_TABLE}
           (item_key, claim_generation) VALUES (?, 1)
         ON CONFLICT (item_key) DO UPDATE
           SET claim_generation = claim_generation + 1
         RETURNING claim_generation`,
        itemKey,
      ),
    )[0];
    return Number(row?.claim_generation);
  }

  private countUnfinishedItemsSync(batchId: string) {
    return Number(
      Array.from(
        this.storage.sql.exec(
          `SELECT COUNT(*) AS count FROM ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE}
            WHERE batch_id = ? AND terminal_outcome IS NULL`,
          batchId,
        ),
      )[0]?.count ?? 0,
    );
  }

  private readBatchSync(batchId: string): PublicationBatch | null {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT batch_id, state, lease_owner, lease_expires_at, attempt, created_at,
                configured_batch_size, completed_at, state_commit_sha, failure_fingerprint
           FROM ${EXACT_REVIEW_PUBLICATION_BATCH_TABLE} WHERE batch_id = ?`,
        batchId,
      ),
    )[0];
    if (!row) return null;
    const items = Array.from(
      this.storage.sql.exec(
        `SELECT item_key, revision, claim_generation, terminal_outcome
           FROM ${EXACT_REVIEW_PUBLICATION_BATCH_ITEM_TABLE}
          WHERE batch_id = ? ORDER BY item_key`,
        batchId,
      ),
      (item) => ({
        itemKey: String(item.item_key),
        revision: Number(item.revision),
        claimGeneration: Number(item.claim_generation),
        terminalOutcome:
          item.terminal_outcome === null
            ? null
            : (String(item.terminal_outcome) as PublicationBatchTerminalOutcome),
      }),
    );
    return {
      batchId: String(row.batch_id),
      state: row.state as PublicationBatch["state"],
      leaseOwner: String(row.lease_owner),
      leaseExpiresAt: Number(row.lease_expires_at),
      configuredBatchSize: Number(row.configured_batch_size),
      attempt: Number(row.attempt),
      createdAt: Number(row.created_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      stateCommitSha: row.state_commit_sha === null ? null : String(row.state_commit_sha),
      failureFingerprint: row.failure_fingerprint === null ? null : String(row.failure_fingerprint),
      items,
    };
  }
}
