export const EXACT_REVIEW_DIRECT_PUBLICATION_TABLE = "exact_review_direct_publication_plans";
export const EXACT_REVIEW_CANONICAL_RECORD_TABLE = "exact_review_canonical_records";
export const EXACT_REVIEW_CANONICAL_RECORD_CHUNK_TABLE = "exact_review_canonical_record_chunks";
export const EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE = "exact_review_record_export_index";
export const EXACT_REVIEW_RECORD_BACKFILL_TABLE = "exact_review_record_backfill";
export const EXACT_REVIEW_RECORD_BACKFILL_CHUNK_TABLE = "exact_review_record_backfill_chunks";
export const EXACT_REVIEW_RECORD_EXPORT_META_TABLE = "exact_review_record_export_meta";
export const CANONICAL_RECORD_TUPLE_RECEIPT_TABLE = "canonical_record_tuple_receipts";
export const EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES = 4 * 1024 * 1024;
export const EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILES = 4;
export const EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const EXACT_REVIEW_CANONICAL_INLINE_BYTES = Math.floor(1.5 * 1024 * 1024);
export const EXACT_REVIEW_CANONICAL_CHUNK_BYTES = 512 * 1024;
export const EXACT_REVIEW_DIRECT_PUBLICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DIRECT_PUBLICATION_TERMINAL_PRUNE_LIMIT = 256;
const MAX_PATH_BYTES = 1024;
const RECORD_SECTIONS = new Set<RecordSection>([
  "items",
  "closed",
  "plans",
  "decision-packets",
  "commits",
]);

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};

type DurableStorage = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};

export type RecordSection = "items" | "closed" | "plans" | "decision-packets" | "commits";
export type ExactReviewTupleRecordSection = Exclude<RecordSection, "commits">;

export type DirectPublicationOperation = {
  path: string;
  deleted: boolean;
  mode: "100644";
  bytes: number;
  contentBase64?: string;
};

export type DirectPublicationPlan = {
  itemKey: string;
  revision: number;
  identity: { itemKey: string; revision: number; claimGeneration: number };
  operations: DirectPublicationOperation[];
  totalBytes: number;
};

export type CanonicalDirectPublicationOperation = DirectPublicationOperation & {
  repoSlug: string;
  section: ExactReviewTupleRecordSection;
  itemId: number;
  content: string | null;
  digest: string | null;
};

export type CanonicalDirectPublicationPlan = Omit<DirectPublicationPlan, "operations"> & {
  operations: CanonicalDirectPublicationOperation[];
};

export type DirectPublicationStoredOperation = {
  path: string;
  bytes: number;
  digest: string | null;
  deleted: boolean;
};

export type DirectPublicationRow = Omit<DirectPublicationPlan, "operations"> & {
  operations: DirectPublicationStoredOperation[] | DirectPublicationOperation[];
  state: "pending" | "committing" | "retryable" | "published" | "superseded" | "failed";
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  commitSha: string | null;
  failureReason: string | null;
};

export type DirectPublicationAcceptResult = {
  outcome: "accepted" | "deduped" | "superseded";
  row: DirectPublicationRow;
  supersededRevisions: number[];
};

export type CanonicalRecord = {
  repoSlug: string;
  section: ExactReviewTupleRecordSection;
  itemId: number;
  content: string | null;
  digest: string | null;
  revision: number;
  updatedAt: number;
  deleted: boolean;
};

export type CanonicalRecordTupleMutationOperation = {
  path: string;
  expectedDigest: string | null;
  contentBase64?: string;
};

export type CanonicalRecordTupleMutation = {
  deliveryId: string;
  key: string;
  operations: CanonicalRecordTupleMutationOperation[];
};

export type ValidatedCanonicalRecordTupleMutation = {
  deliveryId: string;
  key: string;
  repoSlug: string;
  itemId: number;
  operations: CanonicalDirectPublicationOperation[];
  expectedDigests: Map<ExactReviewTupleRecordSection, string | null>;
  fingerprint: string;
};

export type CanonicalRecordTupleConflictState = {
  key: string;
  revision: number;
  deliveryId: string | null;
  operations: CanonicalRecordTupleMutationOperation[];
};

export type RecordExportEntry = {
  repoSlug: string;
  section: RecordSection;
  id: string;
  content: string | null;
  digest: string | null;
  revision: number;
  storeRevision: number;
  updatedAt: number;
  deleted: boolean;
};

export type CanonicalCommitRecordInput = {
  section: "commits";
  id: string;
  content: string;
  digest: string;
  bytes: number;
};

export type RecordSnapshotIdentity = {
  section: RecordSection;
  id: string;
};

export class CanonicalRecordTupleConflictError extends Error {
  readonly current: CanonicalRecordTupleConflictState | null;

  constructor(message: string, current: CanonicalRecordTupleConflictState | null = null) {
    super(message);
    this.name = "CanonicalRecordTupleConflictError";
    this.current = current;
  }
}

export class ExactReviewDirectPublicationStore {
  private readonly storage: DurableStorage;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE} (
         item_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         identity_item_key TEXT NOT NULL,
         identity_revision INTEGER NOT NULL CHECK (identity_revision >= 1),
         claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
         operations_json TEXT NOT NULL,
         total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
         file_count INTEGER NOT NULL CHECK (file_count >= 1),
         state TEXT NOT NULL CHECK (
           state IN ('pending', 'committing', 'retryable', 'published', 'superseded', 'failed')
         ),
         attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         next_attempt_at INTEGER NOT NULL,
         commit_sha TEXT,
         failure_reason TEXT,
         PRIMARY KEY (item_key, revision)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${CANONICAL_RECORD_TUPLE_RECEIPT_TABLE} (
         delivery_id TEXT PRIMARY KEY,
         fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
         revision INTEGER NOT NULL CHECK (revision >= 1),
         sequence INTEGER NOT NULL CHECK (sequence >= 1),
         received_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS canonical_record_tuple_receipt_retention
         ON ${CANONICAL_RECORD_TUPLE_RECEIPT_TABLE} (received_at, delivery_id)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_direct_publication_terminal_retention
         ON ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE} (state, updated_at, item_key, revision)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_CANONICAL_RECORD_TABLE} (
         repo_slug TEXT NOT NULL,
         section TEXT NOT NULL CHECK (section IN ('items', 'closed', 'plans', 'decision-packets')),
         item_id INTEGER NOT NULL CHECK (item_id >= 1),
         content TEXT,
         digest TEXT CHECK (digest IS NULL OR length(digest) = 64),
         byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
         chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
         deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
         revision INTEGER NOT NULL CHECK (revision >= 1),
         item_key TEXT NOT NULL,
         claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (repo_slug, section, item_id),
         CHECK ((deleted = 1 AND content IS NULL AND digest IS NULL AND byte_length = 0 AND chunk_count = 0)
             OR (deleted = 0 AND digest IS NOT NULL AND ((content IS NOT NULL AND chunk_count = 0)
               OR (content IS NULL AND chunk_count > 0))))
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_canonical_records_listing
         ON ${EXACT_REVIEW_CANONICAL_RECORD_TABLE} (repo_slug, section, item_id)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_CANONICAL_RECORD_CHUNK_TABLE} (
         repo_slug TEXT NOT NULL,
         section TEXT NOT NULL CHECK (section IN ('items', 'closed', 'plans', 'decision-packets')),
         item_id INTEGER NOT NULL CHECK (item_id >= 1),
         chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
         content_base64 TEXT NOT NULL,
         PRIMARY KEY (repo_slug, section, item_id, chunk_index)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_RECORD_EXPORT_META_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         current_revision INTEGER NOT NULL CHECK (current_revision >= 0)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${EXACT_REVIEW_RECORD_EXPORT_META_TABLE}
         (singleton_id, current_revision) VALUES (1, 0)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE} (
         repo_slug TEXT NOT NULL,
         section TEXT NOT NULL CHECK (
           section IN ('items', 'closed', 'plans', 'decision-packets', 'commits')
         ),
         record_id TEXT NOT NULL,
         digest TEXT CHECK (digest IS NULL OR length(digest) = 64),
         deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
         revision INTEGER NOT NULL CHECK (revision >= 0),
         store_revision INTEGER NOT NULL UNIQUE CHECK (store_revision >= 1),
         source TEXT NOT NULL CHECK (source IN ('canonical', 'backfill')),
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (repo_slug, section, record_id),
         CHECK ((deleted = 1 AND digest IS NULL) OR (deleted = 0 AND digest IS NOT NULL))
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_record_export_by_repo_revision
         ON ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
         (repo_slug, store_revision, section, record_id)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_RECORD_BACKFILL_TABLE} (
         repo_slug TEXT NOT NULL,
         section TEXT NOT NULL CHECK (
           section IN ('items', 'closed', 'plans', 'decision-packets', 'commits')
         ),
         record_id TEXT NOT NULL,
         content TEXT,
         digest TEXT NOT NULL CHECK (length(digest) = 64),
         byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
         chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (repo_slug, section, record_id),
         CHECK ((content IS NOT NULL AND chunk_count = 0)
           OR (content IS NULL AND chunk_count > 0))
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_RECORD_BACKFILL_CHUNK_TABLE} (
         repo_slug TEXT NOT NULL,
         section TEXT NOT NULL CHECK (
           section IN ('items', 'closed', 'plans', 'decision-packets', 'commits')
         ),
         record_id TEXT NOT NULL,
         chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
         content_base64 TEXT NOT NULL,
         PRIMARY KEY (repo_slug, section, record_id, chunk_index)
       ) STRICT`,
    );
    this.seedExportIndexFromCanonicalSync();
  }

  accept(plan: CanonicalDirectPublicationPlan, now: number): DirectPublicationAcceptResult {
    const storedOperations = storedOperationsFrom(plan.operations);
    const canonicalOperations = canonicalTupleOperations(plan);
    return this.storage.transactionSync(() => {
      this.pruneTerminalSync(now);
      const existing = this.readSync(plan.itemKey, plan.revision);
      if (existing) {
        if (["pending", "committing", "retryable"].includes(existing.state)) {
          this.storage.sql.exec(
            `DELETE FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
              WHERE item_key = ? AND revision = ?`,
            plan.itemKey,
            plan.revision,
          );
        } else {
          if (canonicalStoredPlan(existing) !== canonicalIncomingPlan(plan, storedOperations)) {
            throw new Error("conflicting direct publication retry");
          }
          return { outcome: "deduped" as const, row: existing, supersededRevisions: [] };
        }
      }

      const newer = Array.from(
        this.storage.sql.exec(
          `SELECT revision FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
            WHERE item_key = ? AND revision > ?
            ORDER BY revision DESC LIMIT 1`,
          plan.itemKey,
          plan.revision,
        ),
      )[0];
      if (newer) {
        const row = directPublicationRowFromPlan({
          plan,
          operations: storedOperations,
          state: "superseded",
          now,
          commitSha: null,
          failureReason: "newer_revision_already_published",
        });
        this.insertSync(row);
        return { outcome: "superseded" as const, row, supersededRevisions: [] };
      }

      const canonicalRevision = Math.max(
        plan.revision,
        this.nextTupleRevisionSync(
          canonicalOperations[0]!.repoSlug,
          canonicalOperations[0]!.itemId,
        ),
      );

      for (const operation of canonicalOperations)
        this.writeCanonicalOperationSync(operation, plan, now, canonicalRevision);
      const row = directPublicationRowFromPlan({
        plan,
        operations: storedOperations,
        state: "published",
        now,
        commitSha: `do-revision:${canonicalRevision}`,
        failureReason: null,
      });
      this.insertSync(row);
      return { outcome: "accepted" as const, row, supersededRevisions: [] };
    });
  }

  acceptCanonicalTupleMutation(mutation: ValidatedCanonicalRecordTupleMutation, now: number) {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `DELETE FROM ${CANONICAL_RECORD_TUPLE_RECEIPT_TABLE}
          WHERE delivery_id IN (
            SELECT delivery_id FROM ${CANONICAL_RECORD_TUPLE_RECEIPT_TABLE}
             WHERE received_at <= ?
             ORDER BY received_at, delivery_id
             LIMIT ${DIRECT_PUBLICATION_TERMINAL_PRUNE_LIMIT}
          )`,
        now - EXACT_REVIEW_DIRECT_PUBLICATION_RETENTION_MS,
      );
      const receipt = Array.from(
        this.storage.sql.exec(
          `SELECT fingerprint, revision, sequence
             FROM ${CANONICAL_RECORD_TUPLE_RECEIPT_TABLE}
            WHERE delivery_id = ?`,
          mutation.deliveryId,
        ),
      )[0];
      if (receipt) {
        if (String(receipt.fingerprint) !== mutation.fingerprint) {
          throw new CanonicalRecordTupleConflictError(
            `canonical tuple delivery ${mutation.deliveryId} is bound to another payload`,
          );
        }
        return {
          outcome: "deduped" as const,
          revision: Number(receipt.revision),
        };
      }

      for (const operation of mutation.operations) {
        const current = this.readExportRecord(
          mutation.repoSlug,
          operation.section,
          String(mutation.itemId),
        );
        const currentDigest = current && !current.deleted ? current.digest : null;
        const expectedDigest = mutation.expectedDigests.get(operation.section) ?? null;
        if (currentDigest !== expectedDigest) {
          throw new CanonicalRecordTupleConflictError(
            `canonical record changed before tuple publication: ${operation.path}`,
            this.canonicalTupleConflictStateSync(mutation.repoSlug, mutation.itemId),
          );
        }
      }

      const revision = this.nextTupleRevisionSync(mutation.repoSlug, mutation.itemId);
      const plan: CanonicalDirectPublicationPlan = {
        itemKey: mutation.key,
        revision,
        identity: { itemKey: mutation.key, revision, claimGeneration: 1 },
        operations: mutation.operations,
        totalBytes: mutation.operations.reduce((sum, operation) => sum + operation.bytes, 0),
      };
      for (const operation of mutation.operations) {
        this.writeCanonicalOperationSync(operation, plan, now, revision);
      }
      this.storage.sql.exec(
        `INSERT INTO ${CANONICAL_RECORD_TUPLE_RECEIPT_TABLE}
           (delivery_id, fingerprint, revision, sequence, received_at)
         VALUES (?, ?, ?, ?, ?)`,
        mutation.deliveryId,
        mutation.fingerprint,
        revision,
        revision,
        now,
      );
      return { outcome: "accepted" as const, revision };
    });
  }

  readCanonical(
    repoSlug: string,
    section: ExactReviewTupleRecordSection,
    itemId: number,
  ): CanonicalRecord | null {
    const metadata = this.readCanonicalMetadataSync(repoSlug, section, itemId);
    if (!metadata) return null;
    if (metadata.deleted) return { ...metadata, content: null };
    if (metadata.content !== null) return metadata;
    const chunks = Array.from(
      this.storage.sql.exec(
        `SELECT chunk_index, content_base64
           FROM ${EXACT_REVIEW_CANONICAL_RECORD_CHUNK_TABLE}
          WHERE repo_slug = ? AND section = ? AND item_id = ?
          ORDER BY chunk_index`,
        repoSlug,
        section,
        itemId,
      ),
    );
    if (chunks.length !== metadata.chunkCount) {
      throw new Error(`canonical record chunk count mismatch: ${repoSlug}/${section}/${itemId}`);
    }
    const byteParts = chunks.map((row) => base64Bytes(String(row.content_base64)));
    const combined = new Uint8Array(byteParts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of byteParts) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    if (new TextEncoder().encode(content).byteLength !== metadata.byteLength) {
      throw new Error(`canonical record byte count mismatch: ${repoSlug}/${section}/${itemId}`);
    }
    return { ...metadata, content };
  }

  private canonicalTupleConflictStateSync(
    repoSlug: string,
    itemId: number,
  ): CanonicalRecordTupleConflictState | null {
    const sections = ["items", "closed", "plans", "decision-packets"] as const;
    const records = sections.map((section) => this.readCanonical(repoSlug, section, itemId));
    const revisions = new Set(records.flatMap((record) => (record ? [record.revision] : [])));
    if (records.some((record) => record === null) || revisions.size !== 1) return null;
    const revision = records[0]!.revision;
    const receiptPrefix = `record-reconcile:${repoSlug}:${itemId}:`;
    const deliveryId = Array.from(
      this.storage.sql.exec(
        `SELECT delivery_id
           FROM ${CANONICAL_RECORD_TUPLE_RECEIPT_TABLE}
          WHERE revision = ?
          ORDER BY received_at DESC, delivery_id`,
        revision,
      ),
      (row) => String(row.delivery_id),
    ).find((candidate) => candidate.startsWith(receiptPrefix));
    return {
      key: `${repoSlug}/${itemId}`,
      revision,
      deliveryId: deliveryId ?? null,
      operations: records.map((record, index) => ({
        path: `records/${repoSlug}/${sections[index]}/${itemId}.${sections[index] === "decision-packets" ? "json" : "md"}`,
        expectedDigest: record!.deleted ? null : record!.digest,
        ...(record!.content === null ? {} : { contentBase64: base64Text(record!.content) }),
      })),
    };
  }

  listCanonical(options: {
    repoSlug: string;
    section: ExactReviewTupleRecordSection;
    cursor: number;
    limit: number;
  }) {
    return Array.from(
      this.storage.sql.exec(
        `SELECT item_id, digest, revision, updated_at
           FROM ${EXACT_REVIEW_CANONICAL_RECORD_TABLE}
          WHERE repo_slug = ? AND section = ? AND item_id > ? AND deleted = 0
          ORDER BY item_id
          LIMIT ?`,
        options.repoSlug,
        options.section,
        options.cursor,
        options.limit,
      ),
      (row) => ({
        id: Number(row.item_id),
        digest: String(row.digest),
        revision: Number(row.revision),
        updatedAt: Number(row.updated_at),
      }),
    );
  }

  listRecordRepoSlugs(): Array<{ repoSlug: string; revision: number }> {
    // Distinct repositories present in the canonical record store, with each
    // repository's latest store revision. Tombstoned rows still count: a slug
    // whose records were all deleted still exists in the store and hydration
    // must learn about it to materialize the deletions.
    return Array.from(
      this.storage.sql.exec(
        `SELECT repo_slug, MAX(store_revision) AS revision
           FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
          GROUP BY repo_slug
          ORDER BY repo_slug`,
      ),
      (row) => ({ repoSlug: String(row.repo_slug), revision: Number(row.revision) }),
    );
  }

  exportRecords(options: {
    repoSlug: string;
    sections: readonly RecordSection[];
    sinceRevision: number;
    cursor: number;
    limit: number;
    maxBytes: number;
  }): { records: RecordExportEntry[]; nextCursor: number | null; watermark: number } {
    const placeholders = options.sections.map(() => "?").join(", ");
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT repo_slug, section, record_id, digest, deleted, revision, store_revision,
                source, updated_at
           FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
          WHERE repo_slug = ?
            AND section IN (${placeholders})
            AND store_revision > ?
            AND store_revision > ?
          ORDER BY store_revision
          LIMIT ?`,
        options.repoSlug,
        ...options.sections,
        options.sinceRevision,
        options.cursor,
        options.limit,
      ),
    );
    const records: RecordExportEntry[] = [];
    let responseBytes = 0;
    for (const row of rows) {
      const entry = this.recordExportEntrySync(row);
      const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
      if (records.length && responseBytes + entryBytes > options.maxBytes) break;
      records.push(entry);
      responseBytes += entryBytes;
    }
    const watermark = this.currentExportRevisionSync();
    const lastRevision = records.at(-1)?.storeRevision ?? null;
    return {
      records,
      nextCursor:
        lastRevision !== null && (records.length < rows.length || rows.length === options.limit)
          ? lastRevision
          : null,
      watermark,
    };
  }

  publishCanonicalCommits(
    repoSlug: string,
    records: readonly CanonicalCommitRecordInput[],
    now: number,
  ) {
    return this.storage.transactionSync(() => {
      const result = { inserted: 0, unchanged: 0 };
      for (const record of records) {
        const existing = Array.from(
          this.storage.sql.exec(
            `SELECT digest, deleted, revision, source
               FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
              WHERE repo_slug = ? AND section = ? AND record_id = ?`,
            repoSlug,
            record.section,
            record.id,
          ),
        )[0];
        if (existing) {
          if (Number(existing.deleted) === 0 && String(existing.digest) === record.digest) {
            result.unchanged += 1;
            continue;
          }
          throw new Error(
            `conflicting canonical commit record for ${repoSlug}/${record.section}/${record.id}`,
          );
        }
        this.writeBackfillRecordSync(repoSlug, record, now);
        const storeRevision = this.nextExportRevisionSync();
        this.storage.sql.exec(
          `INSERT INTO ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
             (repo_slug, section, record_id, digest, deleted, revision, store_revision,
              source, updated_at)
           VALUES (?, ?, ?, ?, 0, 1, ?, 'canonical', ?)`,
          repoSlug,
          record.section,
          record.id,
          record.digest,
          storeRevision,
          now,
        );
        result.inserted += 1;
      }
      return { ...result, watermark: this.currentExportRevisionSync() };
    });
  }

  currentExportRevision() {
    return this.currentExportRevisionSync();
  }

  snapshotRecordIdentities(repoSlug: string): RecordSnapshotIdentity[] {
    return Array.from(
      this.storage.sql.exec(
        `SELECT section, record_id
           FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
          WHERE repo_slug = ? AND deleted = 0
          ORDER BY section, record_id`,
        repoSlug,
      ),
      (row) => ({
        section: String(row.section) as RecordSection,
        id: String(row.record_id),
      }),
    );
  }

  readExportRecord(repoSlug: string, section: RecordSection, id: string): RecordExportEntry | null {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT repo_slug, section, record_id, digest, deleted, revision, store_revision,
                source, updated_at
           FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
          WHERE repo_slug = ? AND section = ? AND record_id = ?`,
        repoSlug,
        section,
        id,
      ),
    )[0];
    return row ? this.recordExportEntrySync(row) : null;
  }

  list(): DirectPublicationRow[] {
    return Array.from(
      this.storage.sql.exec(
        `SELECT * FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE} ORDER BY item_key, revision`,
      ),
      directPublicationRow,
    );
  }

  get(itemKey: string, revision: number): DirectPublicationRow | null {
    return this.readSync(itemKey, revision);
  }

  pruneTerminalSync(now: number) {
    return Array.from(
      this.storage.sql.exec(
        `DELETE FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
          WHERE rowid IN (
            SELECT rowid FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
             WHERE state IN ('published', 'superseded', 'failed') AND updated_at <= ?
             ORDER BY updated_at, item_key, revision
             LIMIT ${DIRECT_PUBLICATION_TERMINAL_PRUNE_LIMIT}
          )
          RETURNING item_key`,
        now - EXACT_REVIEW_DIRECT_PUBLICATION_RETENTION_MS,
      ),
    ).length;
  }

  private readSync(itemKey: string, revision: number) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT * FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
          WHERE item_key = ? AND revision = ?`,
        itemKey,
        revision,
      ),
    )[0];
    return row ? directPublicationRow(row) : null;
  }

  private readCanonicalMetadataSync(
    repoSlug: string,
    section: ExactReviewTupleRecordSection,
    itemId: number,
  ) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT content, digest, byte_length, chunk_count, deleted, revision, updated_at
           FROM ${EXACT_REVIEW_CANONICAL_RECORD_TABLE}
          WHERE repo_slug = ? AND section = ? AND item_id = ?`,
        repoSlug,
        section,
        itemId,
      ),
    )[0];
    if (!row) return null;
    return {
      repoSlug,
      section,
      itemId,
      content: row.content === null ? null : String(row.content),
      digest: row.digest === null ? null : String(row.digest),
      byteLength: Number(row.byte_length),
      chunkCount: Number(row.chunk_count),
      revision: Number(row.revision),
      updatedAt: Number(row.updated_at),
      deleted: Number(row.deleted) === 1,
    };
  }

  private writeCanonicalOperationSync(
    operation: CanonicalDirectPublicationOperation,
    plan: CanonicalDirectPublicationPlan,
    now: number,
    revision = plan.revision,
  ) {
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_CANONICAL_RECORD_CHUNK_TABLE}
        WHERE repo_slug = ? AND section = ? AND item_id = ?`,
      operation.repoSlug,
      operation.section,
      operation.itemId,
    );
    const chunked =
      operation.content !== null && operation.bytes > EXACT_REVIEW_CANONICAL_INLINE_BYTES;
    const chunks = chunked
      ? byteChunks(operation.content!, EXACT_REVIEW_CANONICAL_CHUNK_BYTES)
      : [];
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_CANONICAL_RECORD_TABLE}
         (repo_slug, section, item_id, content, digest, byte_length, chunk_count, deleted,
          revision, item_key, claim_generation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_slug, section, item_id) DO UPDATE SET
         content = excluded.content,
         digest = excluded.digest,
         byte_length = excluded.byte_length,
         chunk_count = excluded.chunk_count,
         deleted = excluded.deleted,
         revision = excluded.revision,
         item_key = excluded.item_key,
         claim_generation = excluded.claim_generation,
         updated_at = excluded.updated_at`,
      operation.repoSlug,
      operation.section,
      operation.itemId,
      operation.content === null || chunked ? null : operation.content,
      operation.digest,
      operation.bytes,
      chunks.length,
      operation.content === null ? 1 : 0,
      revision,
      plan.itemKey,
      plan.identity.claimGeneration,
      now,
    );
    for (let index = 0; index < chunks.length; index += 1) {
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_CANONICAL_RECORD_CHUNK_TABLE}
           (repo_slug, section, item_id, chunk_index, content_base64)
         VALUES (?, ?, ?, ?, ?)`,
        operation.repoSlug,
        operation.section,
        operation.itemId,
        index,
        chunks[index],
      );
    }
    const storeRevision = this.nextExportRevisionSync();
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
         (repo_slug, section, record_id, digest, deleted, revision, store_revision,
          source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical', ?)
       ON CONFLICT(repo_slug, section, record_id) DO UPDATE SET
         digest = excluded.digest,
         deleted = excluded.deleted,
         revision = excluded.revision,
         store_revision = excluded.store_revision,
         source = 'canonical',
         updated_at = excluded.updated_at`,
      operation.repoSlug,
      operation.section,
      String(operation.itemId),
      operation.digest,
      operation.content === null ? 1 : 0,
      revision,
      storeRevision,
      now,
    );
  }

  private nextTupleRevisionSync(repoSlug: string, itemId: number): number {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT COALESCE(MAX(revision), 0) AS revision
           FROM ${EXACT_REVIEW_CANONICAL_RECORD_TABLE}
          WHERE repo_slug = ? AND item_id = ?`,
        repoSlug,
        itemId,
      ),
    )[0];
    const current = Number(row?.revision ?? 0);
    if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`invalid canonical tuple revision for ${repoSlug}/${itemId}`);
    }
    return current + 1;
  }

  private seedExportIndexFromCanonicalSync() {
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT repo_slug, section, item_id, digest, deleted, revision, updated_at
           FROM ${EXACT_REVIEW_CANONICAL_RECORD_TABLE}
          WHERE NOT EXISTS (
            SELECT 1 FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE} export
             WHERE export.repo_slug = ${EXACT_REVIEW_CANONICAL_RECORD_TABLE}.repo_slug
               AND export.section = ${EXACT_REVIEW_CANONICAL_RECORD_TABLE}.section
               AND export.record_id = CAST(${EXACT_REVIEW_CANONICAL_RECORD_TABLE}.item_id AS TEXT)
          )
          ORDER BY repo_slug, section, item_id`,
      ),
    );
    for (const row of rows) {
      const storeRevision = this.nextExportRevisionSync();
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
           (repo_slug, section, record_id, digest, deleted, revision, store_revision,
            source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical', ?)`,
        String(row.repo_slug),
        String(row.section),
        String(row.item_id),
        row.digest === null ? null : String(row.digest),
        Number(row.deleted),
        Number(row.revision),
        storeRevision,
        Number(row.updated_at),
      );
    }
  }

  private nextExportRevisionSync() {
    const row = Array.from(
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_RECORD_EXPORT_META_TABLE}
            SET current_revision = current_revision + 1
          WHERE singleton_id = 1
          RETURNING current_revision`,
      ),
    )[0];
    const revision = Number(row?.current_revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("record export revision allocation failed");
    }
    return revision;
  }

  private currentExportRevisionSync() {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT current_revision FROM ${EXACT_REVIEW_RECORD_EXPORT_META_TABLE}
          WHERE singleton_id = 1`,
      ),
    )[0];
    const revision = Number(row?.current_revision ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("invalid record export revision watermark");
    }
    return revision;
  }

  private recordExportEntrySync(row: Record<string, unknown>): RecordExportEntry {
    const repoSlug = String(row.repo_slug);
    const section = String(row.section) as RecordSection;
    const id = String(row.record_id);
    const deleted = Number(row.deleted) === 1;
    let content: string | null = null;
    if (!deleted) {
      if (String(row.source) === "canonical" && section !== "commits") {
        const itemId = Number(id);
        if (!Number.isSafeInteger(itemId) || itemId < 1) {
          throw new Error(`invalid canonical export identity: ${repoSlug}/${section}/${id}`);
        }
        const canonical = this.readCanonical(repoSlug, section, itemId);
        if (!canonical || canonical.deleted || canonical.content === null) {
          throw new Error(`canonical export content missing: ${repoSlug}/${section}/${id}`);
        }
        content = canonical.content;
      } else {
        content = this.readBackfillContentSync(repoSlug, section, id);
      }
    }
    return {
      repoSlug,
      section,
      id,
      content,
      digest: row.digest === null ? null : String(row.digest),
      revision: Number(row.revision),
      storeRevision: Number(row.store_revision),
      updatedAt: Number(row.updated_at),
      deleted,
    };
  }

  private writeBackfillRecordSync(
    repoSlug: string,
    record: CanonicalCommitRecordInput,
    now: number,
  ) {
    const chunked = record.bytes > EXACT_REVIEW_CANONICAL_INLINE_BYTES;
    const chunks = chunked ? byteChunks(record.content, EXACT_REVIEW_CANONICAL_CHUNK_BYTES) : [];
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_RECORD_BACKFILL_TABLE}
         (repo_slug, section, record_id, content, digest, byte_length, chunk_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      repoSlug,
      record.section,
      record.id,
      chunked ? null : record.content,
      record.digest,
      record.bytes,
      chunks.length,
      now,
    );
    for (let index = 0; index < chunks.length; index += 1) {
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_RECORD_BACKFILL_CHUNK_TABLE}
           (repo_slug, section, record_id, chunk_index, content_base64)
         VALUES (?, ?, ?, ?, ?)`,
        repoSlug,
        record.section,
        record.id,
        index,
        chunks[index],
      );
    }
  }

  private readBackfillContentSync(repoSlug: string, section: RecordSection, id: string) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT content, byte_length, chunk_count
           FROM ${EXACT_REVIEW_RECORD_BACKFILL_TABLE}
          WHERE repo_slug = ? AND section = ? AND record_id = ?`,
        repoSlug,
        section,
        id,
      ),
    )[0];
    if (!row) throw new Error(`backfill export content missing: ${repoSlug}/${section}/${id}`);
    if (row.content !== null) return String(row.content);
    const chunks = Array.from(
      this.storage.sql.exec(
        `SELECT chunk_index, content_base64
           FROM ${EXACT_REVIEW_RECORD_BACKFILL_CHUNK_TABLE}
          WHERE repo_slug = ? AND section = ? AND record_id = ?
          ORDER BY chunk_index`,
        repoSlug,
        section,
        id,
      ),
    );
    if (chunks.length !== Number(row.chunk_count)) {
      throw new Error(`backfill export chunk count mismatch: ${repoSlug}/${section}/${id}`);
    }
    const parts = chunks.map((chunk) => base64Bytes(String(chunk.content_base64)));
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    if (bytes.byteLength !== Number(row.byte_length)) {
      throw new Error(`backfill export byte count mismatch: ${repoSlug}/${section}/${id}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  private insertSync(row: DirectPublicationRow) {
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
       (item_key, revision, identity_item_key, identity_revision, claim_generation,
        operations_json, total_bytes, file_count, state, attempts, created_at, updated_at,
        next_attempt_at, commit_sha, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.itemKey,
      row.revision,
      row.identity.itemKey,
      row.identity.revision,
      row.identity.claimGeneration,
      JSON.stringify(row.operations),
      row.totalBytes,
      row.operations.length,
      row.state,
      row.attempts,
      row.createdAt,
      row.updatedAt,
      row.nextAttemptAt,
      row.commitSha,
      row.failureReason,
    );
  }
}

function canonicalTupleOperations(
  plan: CanonicalDirectPublicationPlan,
): CanonicalDirectPublicationOperation[] {
  const operations = [...plan.operations];
  const primaryWrites = operations.filter(
    (operation) =>
      (operation.section === "items" || operation.section === "closed") &&
      operation.content !== null,
  );
  if (primaryWrites.length > 1) {
    throw new Error(`direct publication tuple writes both primary sections: ${plan.itemKey}`);
  }
  const primaryWrite = primaryWrites[0];
  const first = operations[0]!;
  const addDelete = (section: ExactReviewTupleRecordSection): void => {
    if (operations.some((operation) => operation.section === section)) return;
    const extension = section === "decision-packets" ? "json" : "md";
    operations.push({
      path: `records/${first.repoSlug}/${section}/${first.itemId}.${extension}`,
      deleted: true,
      mode: "100644",
      bytes: 0,
      repoSlug: first.repoSlug,
      section,
      itemId: first.itemId,
      content: null,
      digest: null,
    });
  };

  if (primaryWrite) {
    addDelete(primaryWrite.section === "items" ? "closed" : "items");
    if (primaryWrite.section === "closed") addDelete("plans");
    if (!primaryReferencesDecisionPacket(primaryWrite.content!)) addDelete("decision-packets");
  } else if (
    operations.some(
      (operation) =>
        (operation.section === "items" || operation.section === "closed") &&
        operation.content === null,
    )
  ) {
    addDelete("plans");
    addDelete("decision-packets");
  }
  if (operations.length > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILES) {
    throw new Error(`canonical record tuple exceeds its file limit: ${plan.itemKey}`);
  }
  return operations;
}

function primaryReferencesDecisionPacket(content: string): boolean {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return false;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return false;
  const frontMatter = new Map<string, string>();
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (match?.[1]) frontMatter.set(match[1], match[2] ?? "");
  }
  const digest = frontMatter.get("decision_packet_sha256");
  const pointer = frontMatter.get("decision_packet_path");
  return Boolean(digest && pointer && digest !== "none" && pointer !== "none");
}

export function validateRecordSection(value: unknown): RecordSection | null {
  const section = String(value || "").trim() as RecordSection;
  return RECORD_SECTIONS.has(section) ? section : null;
}

export function validateTupleRecordSection(value: unknown): ExactReviewTupleRecordSection | null {
  const section = validateRecordSection(value);
  return section && section !== "commits" ? section : null;
}

export function validateRecordId(section: RecordSection, value: unknown): string | null {
  const id = String(value || "").trim();
  if (section === "commits") return /^[0-9a-f]{40}$/.test(id) ? id : null;
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null;
}

export function validateRepoSlug(value: unknown): string | null {
  const slug = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(slug) ? slug : null;
}

export async function validateCanonicalRecordTupleMutation(
  value: CanonicalRecordTupleMutation,
): Promise<ValidatedCanonicalRecordTupleMutation> {
  const mutation =
    value && typeof value === "object" ? value : ({} as CanonicalRecordTupleMutation);
  const deliveryId = String(mutation.deliveryId || "").trim();
  if (
    !deliveryId ||
    deliveryId.length > 512 ||
    /[\r\n]/.test(deliveryId) ||
    deliveryId.includes("\u0000")
  ) {
    throw new Error("invalid canonical tuple delivery id");
  }
  const key = String(mutation.key || "").trim();
  const keyMatch = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\/([1-9]\d*)$/.exec(key);
  const repoSlug = validateRepoSlug(keyMatch?.[1]);
  const itemId = Number(keyMatch?.[2]);
  if (!repoSlug || !Number.isSafeInteger(itemId) || itemId < 1) {
    throw new Error("invalid canonical tuple key");
  }
  if (!Array.isArray(mutation.operations) || mutation.operations.length !== 4) {
    throw new Error("canonical tuple publication must include all four record sections");
  }
  const expectedDigests = new Map<ExactReviewTupleRecordSection, string | null>();
  const operations: CanonicalDirectPublicationOperation[] = [];
  const sections = new Set<ExactReviewTupleRecordSection>();
  for (const raw of mutation.operations) {
    const operation =
      raw && typeof raw === "object" ? raw : ({} as CanonicalRecordTupleMutationOperation);
    const tuple = canonicalTuplePath(String(operation.path || ""));
    if (!tuple || tuple.repoSlug !== repoSlug || tuple.itemId !== itemId) {
      throw new Error(`canonical tuple path is outside ${key}: ${String(operation.path)}`);
    }
    if (sections.has(tuple.section)) {
      throw new Error(`canonical tuple repeats section ${tuple.section}`);
    }
    sections.add(tuple.section);
    const expectedDigest = operation.expectedDigest;
    if (expectedDigest !== null && !/^[a-f0-9]{64}$/.test(String(expectedDigest))) {
      throw new Error(`invalid expected digest for ${operation.path}`);
    }
    expectedDigests.set(tuple.section, expectedDigest);
    if (operation.contentBase64 === undefined) {
      operations.push({
        path: operation.path,
        deleted: true,
        mode: "100644",
        bytes: 0,
        ...tuple,
        content: null,
        digest: null,
      });
      continue;
    }
    if (
      typeof operation.contentBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        operation.contentBase64,
      )
    ) {
      throw new Error(`invalid canonical tuple content for ${operation.path}`);
    }
    const bytes = base64Bytes(operation.contentBase64);
    if (bytes.byteLength > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES) {
      throw new Error(`canonical tuple content is too large: ${operation.path}`);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`canonical tuple content is not UTF-8: ${operation.path}`);
    }
    operations.push({
      path: operation.path,
      deleted: false,
      mode: "100644",
      bytes: bytes.byteLength,
      contentBase64: operation.contentBase64,
      ...tuple,
      content,
      digest: await sha256Hex(bytes),
    });
  }
  const primaryCount = operations.filter(
    (operation) =>
      (operation.section === "items" || operation.section === "closed") &&
      operation.content !== null,
  ).length;
  const sidecarCount = operations.filter(
    (operation) =>
      (operation.section === "plans" || operation.section === "decision-packets") &&
      operation.content !== null,
  ).length;
  if (primaryCount > 1 || (primaryCount === 0 && sidecarCount > 0)) {
    throw new Error(`canonical tuple has invalid primary/sidecar structure: ${key}`);
  }
  const closed = operations.find((operation) => operation.section === "closed")?.content;
  const plan = operations.find((operation) => operation.section === "plans")?.content;
  if (closed !== null && closed !== undefined && plan !== null && plan !== undefined) {
    throw new Error(`canonical closed tuple retains a work plan: ${key}`);
  }
  validateCanonicalTuplePacketReference(key, operations);
  const canonicalFingerprint = JSON.stringify({
    key,
    operations: operations.map((operation) => ({
      path: operation.path,
      expectedDigest: expectedDigests.get(operation.section) ?? null,
      digest: operation.digest,
    })),
  });
  return {
    deliveryId,
    key,
    repoSlug,
    itemId,
    operations,
    expectedDigests,
    fingerprint: await sha256Hex(new TextEncoder().encode(canonicalFingerprint)),
  };
}

function validateCanonicalTuplePacketReference(
  key: string,
  operations: readonly CanonicalDirectPublicationOperation[],
) {
  const primary = operations.find(
    (operation) =>
      (operation.section === "items" || operation.section === "closed") &&
      operation.content !== null,
  );
  const packet = operations.find((operation) => operation.section === "decision-packets")!;
  if (!primary) return;
  const normalized = primary.content!.replace(/\r\n/g, "\n");
  const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 4) : -1;
  const frontMatter = new Map<string, string>();
  if (end !== -1) {
    for (const line of normalized.slice(4, end).split("\n")) {
      const match = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/.exec(line);
      if (match?.[1]) frontMatter.set(match[1], match[2] ?? "");
    }
  }
  const digest = frontMatter.get("decision_packet_sha256");
  const pointer = frontMatter.get("decision_packet_path");
  if (packet.content === null) {
    if (
      !(
        (digest === undefined && pointer === undefined) ||
        (digest === "none" && pointer === "none")
      )
    ) {
      throw new Error(`canonical tuple references a missing decision packet: ${key}`);
    }
    return;
  }
  if (digest !== packet.digest || pointer !== packet.path) {
    throw new Error(`canonical tuple decision packet reference is inconsistent: ${key}`);
  }
}

export async function validateDirectPublicationPlan(
  value: DirectPublicationPlan,
): Promise<CanonicalDirectPublicationPlan> {
  const plan = value && typeof value === "object" ? value : ({} as DirectPublicationPlan);
  const itemKey = boundedItemKey(plan.itemKey);
  const itemIdentity = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(itemKey);
  if (!itemIdentity) throw new Error("invalid direct publication item key");
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) {
    throw new Error("invalid direct publication revision");
  }
  const identity = plan.identity;
  if (
    !identity ||
    boundedItemKey(identity.itemKey) !== itemKey ||
    identity.revision !== plan.revision ||
    !Number.isSafeInteger(identity.claimGeneration) ||
    identity.claimGeneration < 1
  ) {
    throw new Error("invalid direct publication identity");
  }
  if (!Array.isArray(plan.operations) || !plan.operations.length) {
    throw new Error("a direct publication plan must change a path");
  }
  if (plan.operations.length > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILES) {
    throw new Error("a direct publication plan exceeds the exact-review tuple file limit");
  }
  const repoSlug = `${itemIdentity[1]}-${itemIdentity[2]}`;
  const itemId = Number(itemIdentity[3]);
  const paths = new Set<string>();
  let totalBytes = 0;
  const operations: CanonicalDirectPublicationOperation[] = [];
  for (const raw of plan.operations) {
    const operation = raw && typeof raw === "object" ? raw : ({} as DirectPublicationOperation);
    const path = canonicalPath(operation.path);
    if (path !== operation.path || paths.has(path)) {
      throw new Error(`invalid or repeated direct publication path: ${String(operation.path)}`);
    }
    paths.add(path);
    const tuple = canonicalTuplePath(path);
    if (!tuple || tuple.repoSlug !== repoSlug || tuple.itemId !== itemId) {
      throw new Error(`direct publication path is outside ${repoSlug}#${itemId}: ${path}`);
    }
    if (operation.mode !== "100644") throw new Error(`invalid mutation mode for ${path}`);
    if (
      !Number.isSafeInteger(operation.bytes) ||
      operation.bytes < 0 ||
      operation.bytes > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES
    ) {
      throw new Error(`invalid mutation byte count for ${path}`);
    }
    if (operation.deleted === true) {
      if (operation.bytes !== 0 || operation.contentBase64 !== undefined) {
        throw new Error(`deleted mutation paths must not carry content: ${path}`);
      }
      operations.push({ ...operation, path, ...tuple, content: null, digest: null, bytes: 0 });
      continue;
    }
    const contentBase64 = operation.contentBase64;
    if (
      typeof contentBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)
    ) {
      throw new Error(`missing or invalid mutation content for ${path}`);
    }
    const bytes = base64Bytes(contentBase64);
    if (bytes.byteLength !== operation.bytes) {
      throw new Error(`mutation byte count does not match content for ${path}`);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`canonical record content is not UTF-8: ${path}`);
    }
    const digest = await sha256Hex(bytes);
    totalBytes += bytes.byteLength;
    operations.push({ ...operation, path, ...tuple, contentBase64, content, digest });
  }
  if (!Number.isSafeInteger(plan.totalBytes) || plan.totalBytes !== totalBytes) {
    throw new Error("direct publication total does not match its operations");
  }
  if (totalBytes > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES) {
    throw new Error("direct publication plan exceeds the per-POST byte limit");
  }
  return {
    itemKey,
    revision: plan.revision,
    identity: { itemKey, revision: plan.revision, claimGeneration: identity.claimGeneration },
    operations,
    totalBytes,
  };
}

function storedOperationsFrom(
  operations: readonly CanonicalDirectPublicationOperation[],
): DirectPublicationStoredOperation[] {
  return operations.map((operation) => ({
    path: operation.path,
    bytes: operation.bytes,
    digest: operation.digest,
    deleted: operation.content === null,
  }));
}

function directPublicationRowFromPlan(options: {
  plan: CanonicalDirectPublicationPlan;
  operations: DirectPublicationStoredOperation[];
  state: DirectPublicationRow["state"];
  now: number;
  commitSha: string | null;
  failureReason: string | null;
}): DirectPublicationRow {
  return {
    itemKey: options.plan.itemKey,
    revision: options.plan.revision,
    identity: options.plan.identity,
    operations: options.operations,
    totalBytes: options.plan.totalBytes,
    state: options.state,
    attempts: 0,
    createdAt: options.now,
    updatedAt: options.now,
    nextAttemptAt: options.now,
    commitSha: options.commitSha,
    failureReason: options.failureReason,
  };
}

function directPublicationRow(row: Record<string, unknown>): DirectPublicationRow {
  return {
    itemKey: String(row.item_key),
    revision: Number(row.revision),
    identity: {
      itemKey: String(row.identity_item_key),
      revision: Number(row.identity_revision),
      claimGeneration: Number(row.claim_generation),
    },
    operations: JSON.parse(String(row.operations_json)) as DirectPublicationStoredOperation[],
    totalBytes: Number(row.total_bytes),
    state: row.state as DirectPublicationRow["state"],
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    nextAttemptAt: Number(row.next_attempt_at),
    commitSha: row.commit_sha === null ? null : String(row.commit_sha),
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
  };
}

function canonicalIncomingPlan(
  plan: CanonicalDirectPublicationPlan,
  operations: DirectPublicationStoredOperation[],
) {
  return JSON.stringify({
    itemKey: plan.itemKey,
    revision: plan.revision,
    identity: plan.identity,
    operations,
    totalBytes: plan.totalBytes,
  });
}

function canonicalStoredPlan(plan: DirectPublicationRow) {
  return JSON.stringify({
    itemKey: plan.itemKey,
    revision: plan.revision,
    identity: plan.identity,
    operations: plan.operations,
    totalBytes: plan.totalBytes,
  });
}

function canonicalTuplePath(path: string) {
  const match =
    /^records\/([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\/(items|closed|plans|decision-packets)\/([1-9]\d*)\.(md|json)$/.exec(
      path,
    );
  if (!match) return null;
  const section = match[2] as ExactReviewTupleRecordSection;
  if ((section === "decision-packets") !== (match[4] === "json")) return null;
  return { repoSlug: match[1]!, section, itemId: Number(match[3]) };
}

function boundedItemKey(value: unknown) {
  const text = String(value || "").trim();
  return text && text.length <= 500 && !text.includes("\0") && !/[\r\n]/.test(text) ? text : "";
}

function canonicalPath(value: unknown) {
  const path = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\0") ||
    /[\r\n]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git") ||
    new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES
  ) {
    throw new Error(`invalid bounded state mutation path: ${String(value)}`);
  }
  return path;
}

function base64Bytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64Text(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function byteChunks(content: string, maximumBytes: number) {
  const bytes = new TextEncoder().encode(content);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maximumBytes) {
    const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + maximumBytes));
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    chunks.push(btoa(binary));
  }
  return chunks;
}

export async function sha256Hex(bytes: Uint8Array) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
