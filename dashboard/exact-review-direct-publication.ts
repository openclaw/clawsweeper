import { EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES } from "../src/exact-review-publication-limits.ts";
import { sqlColumnNames, type DurableStorage } from "./durable-storage.ts";

export { EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES };

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
export const EXACT_REVIEW_CANONICAL_INLINE_BYTES = Math.floor(1.5 * 1024 * 1024);
export const EXACT_REVIEW_CANONICAL_CHUNK_BYTES = 512 * 1024;
export const EXACT_REVIEW_DIRECT_PUBLICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_COVERAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_COVERAGE_INVENTORY_KEY = "review-coverage-inventory:v1";
export const REVIEW_COVERAGE_INVENTORY_STALE_MS = 12 * 60 * 60 * 1000;
// Front matter always leads a canonical record; 4 KiB comfortably bounds it.
export const REVIEW_COVERAGE_HEAD_BYTES = 4096;

const DIRECT_PUBLICATION_TERMINAL_PRUNE_LIMIT = 256;
const MAX_PATH_BYTES = 1024;
const RECORD_SECTIONS = new Set<RecordSection>([
  "items",
  "closed",
  "plans",
  "decision-packets",
  "commits",
]);

export type RecordSection = "items" | "closed" | "plans" | "decision-packets" | "commits";
export type ExactReviewTupleRecordSection = Exclude<RecordSection, "commits">;

export type DirectPublicationOperation = {
  path: string;
  deleted: boolean;
  mode: "100644";
  bytes: number;
  contentBase64?: string;
};

export const DIRECT_PUBLICATION_LIFECYCLE_KINDS = [
  "router",
  "router_deferred_coverage",
  "router_not_required",
  "requeue",
  "target_missing",
  "target_closed",
  "guarded_open",
  "policy_noop",
] as const;

export type DirectPublicationLifecycleKind = (typeof DIRECT_PUBLICATION_LIFECYCLE_KINDS)[number];

export type DirectPublicationLifecyclePlan = {
  kind: DirectPublicationLifecycleKind;
};

export type DirectPublicationPlan = {
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
  sourceSha?: string;
  identity: {
    canonicalTargetKey: string;
    fenceKey: string;
    revision: number;
    claimGeneration: number;
  };
  operations: DirectPublicationOperation[];
  totalBytes: number;
  lifecycle?: DirectPublicationLifecyclePlan;
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

export type DirectPublicationRow = Omit<DirectPublicationPlan, "operations" | "lifecycle"> & {
  operations: DirectPublicationStoredOperation[] | DirectPublicationOperation[];
  lifecycle: DirectPublicationLifecyclePlan | null;
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

export class RecordExportConsistencyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecordExportConsistencyError";
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
         canonical_target_key TEXT NOT NULL DEFAULT '',
         fence_key TEXT NOT NULL DEFAULT '',
         revision INTEGER NOT NULL CHECK (revision >= 1),
         identity_item_key TEXT NOT NULL,
         identity_revision INTEGER NOT NULL CHECK (identity_revision >= 1),
         claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
         operations_json TEXT NOT NULL,
         lifecycle_json TEXT NOT NULL DEFAULT '{}',
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
    const directPublicationColumns = sqlColumnNames(
      this.storage,
      EXACT_REVIEW_DIRECT_PUBLICATION_TABLE,
    );
    if (!directPublicationColumns.has("canonical_target_key")) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
           ADD COLUMN canonical_target_key TEXT NOT NULL DEFAULT ''`,
      );
    }
    if (!directPublicationColumns.has("fence_key")) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
           ADD COLUMN fence_key TEXT NOT NULL DEFAULT ''`,
      );
    }
    if (!directPublicationColumns.has("lifecycle_json")) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
           ADD COLUMN lifecycle_json TEXT NOT NULL DEFAULT '{}'`,
      );
    }
    // Every pre-envelope receipt used its sole item key for both roles. Keep
    // those completed receipts dedupe-compatible while all new writes preserve
    // the explicit dual identity below.
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
          SET canonical_target_key = item_key
        WHERE canonical_target_key = ''`,
    );
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
          SET fence_key = item_key
        WHERE fence_key = ''`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_direct_publication_target_revision
         ON ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE} (canonical_target_key, revision)`,
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
      `CREATE INDEX IF NOT EXISTS exact_review_record_export_by_repo_section_revision
         ON ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
         (repo_slug, section, store_revision)`,
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
      const existing = this.readSync(plan.fenceKey, plan.revision);
      if (existing) {
        if (["pending", "committing", "retryable"].includes(existing.state)) {
          this.storage.sql.exec(
            `DELETE FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
              WHERE item_key = ? AND revision = ?`,
            plan.fenceKey,
            plan.revision,
          );
        } else {
          if (canonicalStoredPlan(existing) !== canonicalIncomingPlan(plan, storedOperations)) {
            throw new Error("conflicting direct publication retry");
          }
          return {
            outcome:
              existing.state === "superseded" ? ("superseded" as const) : ("deduped" as const),
            row: existing,
            supersededRevisions: [],
          };
        }
      }

      const newer = Array.from(
        this.storage.sql.exec(
          `SELECT revision FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
            WHERE fence_key = ? AND revision > ?
            ORDER BY revision DESC LIMIT 1`,
          plan.fenceKey,
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
        canonicalTargetKey: mutation.key,
        fenceKey: mutation.key,
        revision,
        identity: {
          canonicalTargetKey: mutation.key,
          fenceKey: mutation.key,
          revision,
          claimGeneration: 1,
        },
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
    return this.readCanonicalContentSync(repoSlug, section, itemId);
  }

  private readCanonicalContentSync(
    repoSlug: string,
    section: ExactReviewTupleRecordSection,
    itemId: number,
    sourceRow?: Record<string, unknown>,
  ): CanonicalRecord | null {
    const metadata = this.readCanonicalMetadataSync(repoSlug, section, itemId, sourceRow);
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

  reviewCoverageSync(
    now: number,
    windowMs = REVIEW_COVERAGE_WINDOW_MS,
    inventory: ReviewCoverageInventorySnapshot | null = null,
  ): ReviewCoverageSummary {
    // Canonical `items` records cover items that have reached publication; they
    // are not a complete GitHub-open inventory. Only the front matter is needed,
    // so read a bounded head and combine it with the periodically published live
    // fleet counts instead of treating missing records as nonexistent work.
    const rows = this.storage.sql.exec(
      `SELECT r.repo_slug AS repo_slug,
              CASE
                WHEN r.content IS NOT NULL THEN substr(r.content, 1, ${REVIEW_COVERAGE_HEAD_BYTES})
                ELSE (SELECT substr(c.content_base64, 1, ${REVIEW_COVERAGE_HEAD_BYTES * 2})
                        FROM ${EXACT_REVIEW_CANONICAL_RECORD_CHUNK_TABLE} c
                       WHERE c.repo_slug = r.repo_slug
                         AND c.section = r.section
                         AND c.item_id = r.item_id
                         AND c.chunk_index = 0)
              END AS head,
              (r.content IS NULL) AS chunked
         FROM ${EXACT_REVIEW_CANONICAL_RECORD_TABLE} r
        WHERE r.section = 'items' AND r.deleted = 0`,
    );
    const fleets = new Map<string, MutableReviewCoverageFleet>();
    for (const row of rows) {
      const head = reviewCoverageHeadText(row.head, Number(row.chunked) === 1);
      const fields = reviewCoverageFrontMatter(head);
      const repoSlug = String(row.repo_slug);
      const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fields.repository ?? "")
        ? fields.repository!
        : /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fields.repo ?? "")
          ? fields.repo!
          : repoSlug;
      const fleet = fleets.get(repoSlug) ?? {
        repo,
        repo_slug: repoSlug,
        tracked_records: 0,
        reviewed_recent: 0,
        stale: 0,
        failed: 0,
        expired: 0,
        unreviewed_records: 0,
        excluded: 0,
        oldest_reviewed_at: null as string | null,
      };
      fleet.tracked_records += 1;
      const status = fields.review_status ?? "";
      const reviewedAtMs = fields.reviewed_at ? Date.parse(fields.reviewed_at) : Number.NaN;
      const fresh =
        status === "complete" &&
        Number.isFinite(reviewedAtMs) &&
        reviewedAtMs <= now &&
        now - reviewedAtMs < windowMs;
      if (reviewCoverageRecordExcluded(fields.labels)) fleet.excluded += 1;
      else if (fresh) fleet.reviewed_recent += 1;
      else if (status.startsWith("stale_")) fleet.stale += 1;
      else if (status === "failed") fleet.failed += 1;
      else if (status === "complete" && Number.isFinite(reviewedAtMs)) fleet.expired += 1;
      else fleet.unreviewed_records += 1;
      if (
        Number.isFinite(reviewedAtMs) &&
        (fleet.oldest_reviewed_at === null || reviewedAtMs < Date.parse(fleet.oldest_reviewed_at))
      ) {
        fleet.oldest_reviewed_at = new Date(reviewedAtMs).toISOString();
      }
      fleets.set(repoSlug, fleet);
    }
    const inventoryBySlug = new Map(
      (inventory?.repositories ?? []).map((entry) => [entry.repo_slug, entry] as const),
    );
    for (const entry of inventory?.repositories ?? []) {
      if (fleets.has(entry.repo_slug)) continue;
      fleets.set(entry.repo_slug, {
        repo: entry.repo,
        repo_slug: entry.repo_slug,
        tracked_records: 0,
        reviewed_recent: 0,
        stale: 0,
        failed: 0,
        expired: 0,
        unreviewed_records: 0,
        excluded: 0,
        oldest_reviewed_at: null,
      });
    }
    const fleetList = [...fleets.values()]
      .map((fleet) =>
        projectReviewCoverageFleet(
          fleet,
          inventoryBySlug.get(fleet.repo_slug) ?? null,
          inventory !== null,
        ),
      )
      .sort((left, right) => left.repo.localeCompare(right.repo));
    const totals = fleetList.reduce(
      (sum, fleet) => {
        if (!fleet.schedulable) {
          sum.unschedulable_records += fleet.unschedulable_records;
          return sum;
        }
        sum.open_records += fleet.open_records;
        sum.reviewable_records += fleet.reviewable_records;
        sum.tracked_records += fleet.tracked_records;
        sum.reviewed_recent += fleet.reviewed_recent;
        sum.stale += fleet.stale;
        sum.failed += fleet.failed;
        sum.expired += fleet.expired;
        sum.unreviewed_records += fleet.unreviewed_records;
        sum.untracked_open += fleet.untracked_open;
        sum.pending += fleet.pending;
        sum.excluded += fleet.excluded;
        sum.record_drift += fleet.record_drift;
        return sum;
      },
      {
        open_records: 0,
        reviewable_records: 0,
        tracked_records: 0,
        reviewed_recent: 0,
        stale: 0,
        failed: 0,
        expired: 0,
        unreviewed_records: 0,
        untracked_open: 0,
        pending: 0,
        excluded: 0,
        unschedulable_records: 0,
        record_drift: 0,
      },
    );
    const inventoryGeneratedAt = inventory?.generated_at ?? null;
    const inventoryGeneratedAtMs = Date.parse(inventoryGeneratedAt ?? "");
    const inventoryStatus =
      inventory === null
        ? "missing"
        : !Number.isFinite(inventoryGeneratedAtMs) ||
            now - inventoryGeneratedAtMs > REVIEW_COVERAGE_INVENTORY_STALE_MS
          ? "stale"
          : "current";
    return {
      window_days: Math.round(windowMs / (24 * 60 * 60 * 1000)),
      inventory_generated_at: inventoryGeneratedAt,
      inventory_status: inventoryStatus,
      fleets: fleetList,
      totals: {
        ...totals,
        coverage_percent: totals.reviewable_records
          ? Math.round((totals.reviewed_recent / totals.reviewable_records) * 1000) / 10
          : null,
      },
    };
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
    maxSourceBytes: number;
    maxRecords: number;
  }): { records: RecordExportEntry[]; nextCursor: number | null; watermark: number } {
    // Snapshot builders use the first page's revision as their replay boundary.
    const watermark = this.currentExportRevisionSync();
    const placeholders = options.sections.map(() => "?").join(", ");
    // The preflight joins source metadata before reconstruction. It must not
    // scan more candidates than the reconstruction bound can ever consume.
    const rowLimit = Math.min(options.limit, options.maxRecords);
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT export.repo_slug, export.section, export.record_id, export.digest,
                export.deleted, export.revision, export.store_revision, export.source,
                export.updated_at,
                CASE
                  WHEN export.deleted = 1 THEN '0'
                  WHEN export.source = 'canonical' AND export.section <> 'commits'
                    THEN CAST(canonical.byte_length AS TEXT)
                  ELSE CAST(backfill.byte_length AS TEXT)
                END AS source_byte_length
           FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE} export
           LEFT JOIN ${EXACT_REVIEW_CANONICAL_RECORD_TABLE} canonical
             ON export.deleted = 0
            AND export.source = 'canonical'
            AND export.section <> 'commits'
            AND canonical.repo_slug = export.repo_slug
            AND canonical.section = export.section
            AND canonical.item_id = CAST(export.record_id AS INTEGER)
           LEFT JOIN ${EXACT_REVIEW_RECORD_BACKFILL_TABLE} backfill
             ON export.deleted = 0
            AND (export.source = 'backfill' OR export.section = 'commits')
            AND backfill.repo_slug = export.repo_slug
            AND backfill.section = export.section
            AND backfill.record_id = export.record_id
          WHERE export.repo_slug = ?
            AND export.section IN (${placeholders})
            AND export.store_revision > ?
            AND export.store_revision > ?
          ORDER BY export.store_revision
          LIMIT ?`,
        options.repoSlug,
        ...options.sections,
        options.sinceRevision,
        options.cursor,
        rowLimit,
      ),
    );
    const selectedRows: Record<string, unknown>[] = [];
    let sourceBytes = 0;
    for (const row of rows) {
      if (selectedRows.length >= options.maxRecords) break;
      const byteLength = recordExportSourceByteLength(row);
      if (selectedRows.length > 0 && byteLength > options.maxSourceBytes - sourceBytes) {
        break;
      }
      selectedRows.push(row);
      sourceBytes += byteLength;
    }
    const sourceRows = this.readExportSourceRowsSync(options.repoSlug, selectedRows);
    const records: RecordExportEntry[] = [];
    let responseBytes = 0;
    for (const row of selectedRows) {
      const sourceRow = sourceRows.get(`${String(row.section)}/${String(row.record_id)}`);
      if (Number(row.deleted) !== 1 && !sourceRow) {
        throw new RecordExportConsistencyError("record export source missing");
      }
      const entry = this.recordExportEntrySync(row, sourceRow);
      const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
      if (records.length && responseBytes + entryBytes > options.maxBytes) break;
      records.push(entry);
      responseBytes += entryBytes;
    }
    const lastRevision = records.at(-1)?.storeRevision ?? null;
    const hasMore =
      lastRevision !== null && records.length === rows.length && rows.length === rowLimit
        ? Array.from(
            this.storage.sql.exec(
              `SELECT 1
                 FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE} export
                WHERE export.repo_slug = ?
                  AND export.section IN (${placeholders})
                  AND export.store_revision > ?
                  AND export.store_revision > ?
                LIMIT 1`,
              options.repoSlug,
              ...options.sections,
              options.sinceRevision,
              lastRevision,
            ),
          ).length > 0
        : false;
    return {
      records,
      nextCursor:
        lastRevision !== null && (records.length < rows.length || hasMore) ? lastRevision : null,
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

  snapshotRecordCount(repoSlug: string, watermark: number): number {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
       WHERE repo_slug = ? AND deleted = 0 AND store_revision <= ?`,
        repoSlug,
        watermark,
      ),
    )[0];
    return Number(row?.count ?? 0);
  }

  snapshotRecordIdentities(
    repoSlug: string,
    watermark = Number.MAX_SAFE_INTEGER,
  ): RecordSnapshotIdentity[] {
    return Array.from(
      this.storage.sql.exec(
        `SELECT section, record_id
           FROM ${EXACT_REVIEW_RECORD_EXPORT_INDEX_TABLE}
          WHERE repo_slug = ? AND deleted = 0 AND store_revision <= ?
          ORDER BY section, record_id`,
        repoSlug,
        watermark,
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

  count(): number {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}`,
      ),
    )[0];
    return Number(row?.count ?? 0);
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
    sourceRow?: Record<string, unknown>,
  ) {
    const row =
      sourceRow ??
      Array.from(
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
      plan.canonicalTargetKey,
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
      throw new RecordExportConsistencyError("record export revision allocation failed");
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
      throw new RecordExportConsistencyError("invalid record export revision watermark");
    }
    return revision;
  }

  private readExportSourceRowsSync(repoSlug: string, rows: Record<string, unknown>[]) {
    const canonical: Array<[string, number]> = [];
    const backfill: Array<[string, string]> = [];
    for (const row of rows) {
      if (Number(row.deleted) === 1) continue;
      if (String(row.source) === "canonical" && row.section !== "commits") {
        canonical.push([String(row.section), Number(row.record_id)]);
      } else {
        backfill.push([String(row.section), String(row.record_id)]);
      }
    }
    if (!canonical.length && !backfill.length) return new Map<string, Record<string, unknown>>();
    // Load only the byte-budgeted identities. JSON arrays keep the binding
    // count fixed even for 200 records; chunks still use the existing reader.
    return new Map(
      Array.from(
        this.storage.sql.exec(
          `SELECT section, CAST(item_id AS TEXT) AS record_id, content, digest,
                  byte_length, chunk_count, deleted, revision, updated_at
             FROM ${EXACT_REVIEW_CANONICAL_RECORD_TABLE}
            WHERE repo_slug = ? AND (section, item_id) IN (
              SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
                FROM json_each(?)
            )
            UNION ALL
           SELECT section, record_id, content, digest, byte_length, chunk_count,
                  0 AS deleted, 0 AS revision, updated_at
             FROM ${EXACT_REVIEW_RECORD_BACKFILL_TABLE}
            WHERE repo_slug = ? AND (section, record_id) IN (
              SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
                FROM json_each(?)
            )`,
          repoSlug,
          JSON.stringify(canonical),
          repoSlug,
          JSON.stringify(backfill),
        ),
        (row) => [`${String(row.section)}/${String(row.record_id)}`, row] as const,
      ),
    );
  }

  private recordExportEntrySync(
    row: Record<string, unknown>,
    sourceRow?: Record<string, unknown>,
  ): RecordExportEntry {
    const repoSlug = String(row.repo_slug);
    const section = String(row.section) as RecordSection;
    const id = String(row.record_id);
    const deleted = Number(row.deleted) === 1;
    let content: string | null = null;
    if (!deleted) {
      if (String(row.source) === "canonical" && section !== "commits") {
        const itemId = Number(id);
        if (!Number.isSafeInteger(itemId) || itemId < 1) {
          throw new RecordExportConsistencyError(
            `invalid canonical export identity: ${repoSlug}/${section}/${id}`,
          );
        }
        let canonical: CanonicalRecord | null;
        try {
          canonical = this.readCanonicalContentSync(repoSlug, section, itemId, sourceRow);
        } catch (error) {
          if (error instanceof RecordExportConsistencyError) throw error;
          throw new RecordExportConsistencyError("canonical export content is malformed", {
            cause: error,
          });
        }
        if (!canonical || canonical.deleted || canonical.content === null) {
          throw new RecordExportConsistencyError(
            `canonical export content missing: ${repoSlug}/${section}/${id}`,
          );
        }
        content = canonical.content;
      } else {
        content = this.readBackfillContentSync(repoSlug, section, id, sourceRow);
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

  private readBackfillContentSync(
    repoSlug: string,
    section: RecordSection,
    id: string,
    sourceRow?: Record<string, unknown>,
  ) {
    const row =
      sourceRow ??
      Array.from(
        this.storage.sql.exec(
          `SELECT content, byte_length, chunk_count
           FROM ${EXACT_REVIEW_RECORD_BACKFILL_TABLE}
          WHERE repo_slug = ? AND section = ? AND record_id = ?`,
          repoSlug,
          section,
          id,
        ),
      )[0];
    if (!row) {
      throw new RecordExportConsistencyError(
        `backfill export content missing: ${repoSlug}/${section}/${id}`,
      );
    }
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
      throw new RecordExportConsistencyError(
        `backfill export chunk count mismatch: ${repoSlug}/${section}/${id}`,
      );
    }
    try {
      const parts = chunks.map((chunk) => base64Bytes(String(chunk.content_base64)));
      const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      if (bytes.byteLength !== Number(row.byte_length)) {
        throw new RecordExportConsistencyError(
          `backfill export byte count mismatch: ${repoSlug}/${section}/${id}`,
        );
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof RecordExportConsistencyError) throw error;
      throw new RecordExportConsistencyError("backfill export content is malformed", {
        cause: error,
      });
    }
  }

  private insertSync(row: DirectPublicationRow) {
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
       (item_key, canonical_target_key, fence_key, revision,
        identity_item_key, identity_revision, claim_generation,
        operations_json, lifecycle_json, total_bytes, file_count, state, attempts, created_at, updated_at,
        next_attempt_at, commit_sha, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.fenceKey,
      row.canonicalTargetKey,
      row.fenceKey,
      row.revision,
      row.identity.fenceKey,
      row.identity.revision,
      row.identity.claimGeneration,
      JSON.stringify(row.operations),
      JSON.stringify(row.lifecycle ?? {}),
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

function recordExportSourceByteLength(row: Record<string, unknown>) {
  const value = row.source_byte_length;
  const byteLength =
    typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    (Number(row.deleted) === 1 && byteLength !== 0)
  ) {
    throw new RecordExportConsistencyError(
      `invalid record export byte metadata: ${String(row.repo_slug)}/${String(row.section)}/${String(row.record_id)}`,
    );
  }
  return byteLength;
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
    throw new Error(
      `direct publication tuple writes both primary sections: ${plan.canonicalTargetKey}`,
    );
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
    throw new Error(`canonical record tuple exceeds its file limit: ${plan.canonicalTargetKey}`);
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
  const inputKey = String(mutation.key || "").trim();
  const keyMatch = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\/([1-9]\d*)$/.exec(inputKey);
  const inputRepoSlug = validateRepoSlug(keyMatch?.[1]);
  const repoSlug = inputRepoSlug?.toLowerCase() ?? null;
  const itemId = Number(keyMatch?.[2]);
  if (!repoSlug || !Number.isSafeInteger(itemId) || itemId < 1) {
    throw new Error("invalid canonical tuple key");
  }
  const key = `${repoSlug}/${itemId}`;
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
    if (!tuple || !repositoryNamesEqual(tuple.repoSlug, repoSlug) || tuple.itemId !== itemId) {
      throw new Error(`canonical tuple path is outside ${inputKey}: ${String(operation.path)}`);
    }
    const storagePath = canonicalTupleStoragePath(repoSlug, tuple.section, tuple.itemId);
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
        path: storagePath,
        deleted: true,
        mode: "100644",
        bytes: 0,
        repoSlug,
        section: tuple.section,
        itemId: tuple.itemId,
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
      path: storagePath,
      deleted: false,
      mode: "100644",
      bytes: bytes.byteLength,
      contentBase64: operation.contentBase64,
      repoSlug,
      section: tuple.section,
      itemId: tuple.itemId,
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
  if (digest !== packet.digest || !recordPathsEqualIgnoringRepositoryCase(pointer, packet.path)) {
    throw new Error(`canonical tuple decision packet reference is inconsistent: ${key}`);
  }
}

export async function validateDirectPublicationPlan(
  value: DirectPublicationPlan,
): Promise<CanonicalDirectPublicationPlan> {
  const plan = value && typeof value === "object" ? value : ({} as DirectPublicationPlan);
  const canonicalTargetKey = boundedItemKey(plan.canonicalTargetKey);
  const itemIdentity = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(canonicalTargetKey);
  if (!itemIdentity) throw new Error("invalid direct publication canonical target key");
  const fenceKey = boundedItemKey(plan.fenceKey);
  if (!fenceKey) throw new Error("invalid direct publication fence key");
  const sourceSha = plan.sourceSha;
  if (sourceSha !== undefined && !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error("invalid direct publication source SHA");
  }
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) {
    throw new Error("invalid direct publication revision");
  }
  const lifecycle = directPublicationLifecyclePlan(plan.lifecycle);
  if (plan.lifecycle !== undefined && !lifecycle) {
    throw new Error("invalid direct publication lifecycle plan");
  }
  const identity = plan.identity;
  if (
    !identity ||
    boundedItemKey(identity.canonicalTargetKey) !== canonicalTargetKey ||
    boundedItemKey(identity.fenceKey) !== fenceKey ||
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
  const inputRepoSlug = `${itemIdentity[1]}-${itemIdentity[2]}`;
  const repoSlug = inputRepoSlug.toLowerCase();
  const itemId = Number(itemIdentity[3]);
  const paths = new Set<string>();
  let totalBytes = 0;
  const operations: CanonicalDirectPublicationOperation[] = [];
  for (const raw of plan.operations) {
    const operation = raw && typeof raw === "object" ? raw : ({} as DirectPublicationOperation);
    const inputPath = canonicalPath(operation.path);
    if (inputPath !== operation.path) {
      throw new Error(`invalid or repeated direct publication path: ${String(operation.path)}`);
    }
    const tuple = canonicalTuplePath(inputPath);
    if (!tuple || !repositoryNamesEqual(tuple.repoSlug, inputRepoSlug) || tuple.itemId !== itemId) {
      throw new Error(
        `direct publication path is outside ${inputRepoSlug}#${itemId}: ${inputPath}`,
      );
    }
    const path = canonicalTupleStoragePath(repoSlug, tuple.section, tuple.itemId);
    if (paths.has(path)) {
      throw new Error(`invalid or repeated direct publication path: ${String(operation.path)}`);
    }
    paths.add(path);
    if (operation.mode !== "100644") throw new Error(`invalid mutation mode for ${inputPath}`);
    if (
      !Number.isSafeInteger(operation.bytes) ||
      operation.bytes < 0 ||
      operation.bytes > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES
    ) {
      throw new Error(`invalid mutation byte count for ${inputPath}`);
    }
    if (operation.deleted === true) {
      if (operation.bytes !== 0 || operation.contentBase64 !== undefined) {
        throw new Error(`deleted mutation paths must not carry content: ${inputPath}`);
      }
      operations.push({
        ...operation,
        path,
        repoSlug,
        section: tuple.section,
        itemId: tuple.itemId,
        content: null,
        digest: null,
        bytes: 0,
      });
      continue;
    }
    const contentBase64 = operation.contentBase64;
    if (
      typeof contentBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)
    ) {
      throw new Error(`missing or invalid mutation content for ${inputPath}`);
    }
    const bytes = base64Bytes(contentBase64);
    if (bytes.byteLength !== operation.bytes) {
      throw new Error(`mutation byte count does not match content for ${inputPath}`);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`canonical record content is not UTF-8: ${inputPath}`);
    }
    const digest = await sha256Hex(bytes);
    totalBytes += bytes.byteLength;
    operations.push({
      ...operation,
      path,
      repoSlug,
      section: tuple.section,
      itemId: tuple.itemId,
      contentBase64,
      content,
      digest,
    });
  }
  if (!Number.isSafeInteger(plan.totalBytes) || plan.totalBytes !== totalBytes) {
    throw new Error("direct publication total does not match its operations");
  }
  if (totalBytes > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES) {
    throw new Error("direct publication plan exceeds the per-POST byte limit");
  }
  return {
    canonicalTargetKey,
    fenceKey,
    revision: plan.revision,
    ...(sourceSha === undefined ? {} : { sourceSha }),
    identity: {
      canonicalTargetKey,
      fenceKey,
      revision: plan.revision,
      claimGeneration: identity.claimGeneration,
    },
    operations,
    totalBytes,
    ...(lifecycle ? { lifecycle } : {}),
  };
}

export function directPublicationRejectionDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  switch (message) {
    case "invalid direct publication canonical target key":
      return "invalid direct publication canonical target key";
    case "invalid direct publication fence key":
      return "invalid direct publication fence key";
    case "invalid direct publication source SHA":
      return "invalid direct publication source SHA";
    case "invalid direct publication revision":
      return "invalid direct publication revision";
    case "invalid direct publication lifecycle plan":
      return "invalid direct publication lifecycle plan";
    case "invalid direct publication identity":
      return "invalid direct publication identity";
    case "a direct publication plan must change a path":
      return "a direct publication plan must change a path";
    case "a direct publication plan exceeds the exact-review tuple file limit":
      return "a direct publication plan exceeds the exact-review tuple file limit";
    case "direct publication total does not match its operations":
      return "direct publication total does not match its operations";
    case "direct publication plan exceeds the per-POST byte limit":
      return "direct publication plan exceeds the per-POST byte limit";
    case "conflicting direct publication retry":
      return "conflicting direct publication retry";
    case "direct publication source run identity is unavailable":
      return "direct publication source run identity is unavailable";
    case "direct publication source SHA is unavailable":
      return "direct publication source SHA is unavailable";
  }
  if (message.startsWith("invalid bounded state mutation path:")) {
    return "invalid bounded state mutation path";
  }
  if (message.startsWith("invalid or repeated direct publication path:")) {
    return "invalid or repeated direct publication path";
  }
  if (message.startsWith("direct publication path is outside ")) {
    return "direct publication path is outside its target tuple";
  }
  if (message.startsWith("invalid mutation mode for ")) return "invalid mutation mode";
  if (message.startsWith("invalid mutation byte count for ")) return "invalid mutation byte count";
  if (message.startsWith("deleted mutation paths must not carry content:")) {
    return "deleted mutation paths must not carry content";
  }
  if (message.startsWith("missing or invalid mutation content for ")) {
    return "missing or invalid mutation content";
  }
  if (message.startsWith("mutation byte count does not match content for ")) {
    return "mutation byte count does not match content";
  }
  if (message.startsWith("canonical record content is not UTF-8:")) {
    return "canonical record content is not UTF-8";
  }
  if (message.startsWith("canonical tuple has invalid primary/sidecar structure:")) {
    return "canonical tuple has invalid primary/sidecar structure";
  }
  if (message.startsWith("canonical closed tuple retains a work plan:")) {
    return "canonical closed tuple retains a work plan";
  }
  if (message.startsWith("canonical tuple references a missing decision packet:")) {
    return "canonical tuple references a missing decision packet";
  }
  if (message.startsWith("canonical tuple decision packet reference is inconsistent:")) {
    return "canonical tuple decision packet reference is inconsistent";
  }
  if (message.startsWith("direct publication tuple writes both primary sections:")) {
    return "direct publication tuple writes both primary sections";
  }
  if (message.startsWith("canonical record tuple exceeds its file limit:")) {
    return "canonical record tuple exceeds its file limit";
  }
  return "direct publication request failed";
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
    canonicalTargetKey: options.plan.canonicalTargetKey,
    fenceKey: options.plan.fenceKey,
    revision: options.plan.revision,
    identity: options.plan.identity,
    operations: options.operations,
    totalBytes: options.plan.totalBytes,
    lifecycle: options.plan.lifecycle ?? null,
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
    canonicalTargetKey: String(row.canonical_target_key),
    fenceKey: String(row.fence_key),
    revision: Number(row.revision),
    identity: {
      canonicalTargetKey: String(row.canonical_target_key),
      fenceKey: String(row.fence_key),
      revision: Number(row.identity_revision),
      claimGeneration: Number(row.claim_generation),
    },
    operations: JSON.parse(String(row.operations_json)) as DirectPublicationStoredOperation[],
    totalBytes: Number(row.total_bytes),
    lifecycle: storedDirectPublicationLifecycle(row.lifecycle_json),
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
    canonicalTargetKey: plan.canonicalTargetKey,
    fenceKey: plan.fenceKey,
    revision: plan.revision,
    // The claim generation fences completion ownership, not the immutable
    // state tuple. A reclaimed batch must be able to dedupe an accepted tuple
    // after its prior worker died before completion.
    identity: stablePublicationIdentity(plan.identity),
    operations,
    totalBytes: plan.totalBytes,
    lifecycle: plan.lifecycle ?? null,
  });
}

function canonicalStoredPlan(plan: DirectPublicationRow) {
  return JSON.stringify({
    canonicalTargetKey: plan.canonicalTargetKey,
    fenceKey: plan.fenceKey,
    revision: plan.revision,
    identity: stablePublicationIdentity(plan.identity),
    operations: plan.operations,
    totalBytes: plan.totalBytes,
    lifecycle: plan.lifecycle,
  });
}

function directPublicationLifecyclePlan(value: unknown): DirectPublicationLifecyclePlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lifecycle = value as Record<string, unknown>;
  if (Object.keys(lifecycle).length !== 1) return null;
  const kind = lifecycle.kind;
  return typeof kind === "string" &&
    (DIRECT_PUBLICATION_LIFECYCLE_KINDS as readonly string[]).includes(kind)
    ? { kind: kind as DirectPublicationLifecycleKind }
    : null;
}

function storedDirectPublicationLifecycle(value: unknown): DirectPublicationLifecyclePlan | null {
  if (typeof value !== "string") return null;
  try {
    return directPublicationLifecyclePlan(JSON.parse(value));
  } catch {
    return null;
  }
}

function stablePublicationIdentity(identity: DirectPublicationPlan["identity"]) {
  return {
    canonicalTargetKey: identity.canonicalTargetKey,
    fenceKey: identity.fenceKey,
    revision: identity.revision,
  };
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

function canonicalTupleStoragePath(
  repoSlug: string,
  section: ExactReviewTupleRecordSection,
  itemId: number,
) {
  const extension = section === "decision-packets" ? "json" : "md";
  return `records/${repoSlug}/${section}/${itemId}.${extension}`;
}

function repositoryNamesEqual(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function recordPathsEqualIgnoringRepositoryCase(left: string | undefined, right: string) {
  if (left === undefined) return false;
  const leftTuple = canonicalTuplePath(left);
  const rightTuple = canonicalTuplePath(right);
  return Boolean(
    leftTuple &&
    rightTuple &&
    repositoryNamesEqual(leftTuple.repoSlug, rightTuple.repoSlug) &&
    leftTuple.section === rightTuple.section &&
    leftTuple.itemId === rightTuple.itemId,
  );
}

function boundedItemKey(value: unknown) {
  if (typeof value !== "string" || value !== value.trim()) return "";
  return value && value.length <= 500 && !value.includes("\0") && !/[\r\n]/.test(value)
    ? value
    : "";
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

type MutableReviewCoverageFleet = {
  repo: string;
  repo_slug: string;
  tracked_records: number;
  reviewed_recent: number;
  stale: number;
  failed: number;
  expired: number;
  unreviewed_records: number;
  excluded: number;
  oldest_reviewed_at: string | null;
};

export type ReviewCoverageInventoryRepository = {
  repo: string;
  repo_slug: string;
  open_issues: number;
  open_pull_requests: number;
};

export type ReviewCoverageInventorySnapshot = {
  generated_at: string;
  repositories: ReviewCoverageInventoryRepository[];
};

export type ReviewCoverageFleet = MutableReviewCoverageFleet & {
  open_records: number;
  reviewable_records: number;
  untracked_open: number;
  pending: number;
  unschedulable_records: number;
  record_drift: number;
  schedulable: boolean;
  coverage_percent: number | null;
};

export type ReviewCoverageSummary = {
  window_days: number;
  inventory_generated_at: string | null;
  inventory_status: "current" | "stale" | "missing";
  fleets: ReviewCoverageFleet[];
  totals: {
    open_records: number;
    reviewable_records: number;
    tracked_records: number;
    reviewed_recent: number;
    stale: number;
    failed: number;
    expired: number;
    unreviewed_records: number;
    untracked_open: number;
    pending: number;
    excluded: number;
    unschedulable_records: number;
    record_drift: number;
    coverage_percent: number | null;
  };
};

export function normalizeReviewCoverageInventory(
  value: unknown,
): ReviewCoverageInventorySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const generatedAt = String(input.generated_at ?? "").trim();
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs) || !Array.isArray(input.repositories)) return null;
  if (input.repositories.length > 2_000) return null;
  const seen = new Set<string>();
  const repositories: ReviewCoverageInventoryRepository[] = [];
  for (const candidate of input.repositories) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const entry = candidate as Record<string, unknown>;
    const repo = String(entry.repo ?? "")
      .trim()
      .toLowerCase();
    const repoSlug = String(entry.repo_slug ?? "")
      .trim()
      .toLowerCase();
    const openIssues = Number(entry.open_issues);
    const openPullRequests = Number(entry.open_pull_requests);
    if (
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo) ||
      !/^[a-z0-9][a-z0-9_.-]*$/.test(repoSlug) ||
      repo.replace("/", "-") !== repoSlug ||
      !Number.isSafeInteger(openIssues) ||
      openIssues < 0 ||
      !Number.isSafeInteger(openPullRequests) ||
      openPullRequests < 0 ||
      seen.has(repoSlug)
    ) {
      return null;
    }
    seen.add(repoSlug);
    repositories.push({
      repo,
      repo_slug: repoSlug,
      open_issues: openIssues,
      open_pull_requests: openPullRequests,
    });
  }
  return { generated_at: new Date(generatedAtMs).toISOString(), repositories };
}

function projectReviewCoverageFleet(
  fleet: MutableReviewCoverageFleet,
  inventory: ReviewCoverageInventoryRepository | null,
  hasInventory: boolean,
): ReviewCoverageFleet {
  if (hasInventory && inventory === null) {
    return {
      ...fleet,
      open_records: 0,
      reviewable_records: 0,
      reviewed_recent: 0,
      stale: 0,
      failed: 0,
      expired: 0,
      unreviewed_records: 0,
      untracked_open: 0,
      pending: 0,
      excluded: 0,
      unschedulable_records: fleet.tracked_records,
      record_drift: 0,
      schedulable: false,
      coverage_percent: null,
    };
  }
  const openRecords = inventory
    ? inventory.open_issues + inventory.open_pull_requests
    : fleet.tracked_records;
  const excluded = Math.min(fleet.excluded, openRecords);
  const reviewableRecords = Math.max(0, openRecords - excluded);
  let remaining = reviewableRecords;
  const take = (count: number) => {
    const accepted = Math.min(Math.max(0, count), remaining);
    remaining -= accepted;
    return accepted;
  };
  const reviewedRecent = take(fleet.reviewed_recent);
  const stale = take(fleet.stale);
  const failed = take(fleet.failed);
  const expired = take(fleet.expired);
  const unreviewedRecords = take(fleet.unreviewed_records);
  const untrackedOpen = remaining;
  return {
    ...fleet,
    repo: inventory?.repo ?? fleet.repo,
    open_records: openRecords,
    reviewable_records: reviewableRecords,
    reviewed_recent: reviewedRecent,
    stale,
    failed,
    expired,
    unreviewed_records: unreviewedRecords,
    untracked_open: untrackedOpen,
    pending: expired + unreviewedRecords + untrackedOpen,
    excluded,
    unschedulable_records: 0,
    record_drift: Math.max(0, fleet.tracked_records - openRecords),
    schedulable: true,
    coverage_percent: reviewableRecords
      ? Math.round((reviewedRecent / reviewableRecords) * 1000) / 10
      : null,
  };
}

const REVIEW_COVERAGE_EXCLUDED_LABELS = new Set<string>(
  CLOSE_PROTECTED_LABEL_NAMES.filter((label) => label !== "maintainer"),
);

function reviewCoverageRecordExcluded(labels: readonly string[]): boolean {
  return labels.some((label) => REVIEW_COVERAGE_EXCLUDED_LABELS.has(label.toLowerCase()));
}

function reviewCoverageHeadText(head: unknown, chunked: boolean): string {
  const raw = typeof head === "string" ? head : "";
  if (!chunked) return raw;
  // Chunked records store base64 text; a 4-aligned prefix decodes standalone.
  const aligned = raw.slice(0, raw.length - (raw.length % 4));
  try {
    return new TextDecoder("utf-8").decode(base64Bytes(aligned));
  } catch {
    return "";
  }
}

function reviewCoverageFrontMatter(head: string): {
  repository: string | null;
  repo: string | null;
  reviewed_at: string | null;
  review_status: string | null;
  labels: string[];
} {
  const result: {
    repository: string | null;
    repo: string | null;
    reviewed_at: string | null;
    review_status: string | null;
    labels: string[];
  } = { repository: null, repo: null, reviewed_at: null, review_status: null, labels: [] };
  if (!head.startsWith("---")) return result;
  const end = head.indexOf("\n---", 3);
  const frontMatter = end === -1 ? head : head.slice(0, end);
  for (const key of ["repository", "repo", "reviewed_at", "review_status"] as const) {
    const match = frontMatter.match(new RegExp(`^${key}:[ \\t]*"?([^"\\n]*)"?[ \\t]*$`, "m"));
    const value = match?.[1];
    if (value !== undefined) result[key] = value.trim() || null;
  }
  const labels = frontMatter.match(/^labels:[ \t]*(.+?)[ \t]*$/m)?.[1]?.trim();
  if (labels) {
    try {
      const parsed = JSON.parse(labels);
      if (Array.isArray(parsed)) {
        result.labels = parsed.filter((label): label is string => typeof label === "string");
      }
    } catch {
      result.labels = labels === "none" ? [] : labels.split(",").map((label) => label.trim());
    }
  }
  return result;
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
import { CLOSE_PROTECTED_LABEL_NAMES } from "../src/repair/exact-review-guard-labels.ts";
