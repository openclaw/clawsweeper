import { recordOrEmpty as objectValue } from "../src/value-coerce.ts";

export const EXACT_REVIEW_ARTIFACT_RECEIPT_TABLE = "exact_review_artifact_receipts";
const EXACT_REVIEW_ARTIFACT_CACHE_META_TABLE = "exact_review_artifact_cache_meta";
export const EXACT_REVIEW_ARTIFACT_CACHE_PREFIX = "artifacts/exact-review/v1/";
export const EXACT_REVIEW_ARTIFACT_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ITEM_KEY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;
const CLEANUP_LIMIT = 128;

type SqlRow = Record<string, unknown>;
type ArtifactReceiptStorage = {
  sql: { exec: (query: string, ...bindings: unknown[]) => Iterable<SqlRow> };
  transactionSync: <T>(callback: () => T) => T;
};

type ArtifactR2Object = {
  key: string;
  size: number;
  uploaded?: Date;
  customMetadata?: Record<string, string>;
};

type ArtifactR2Bucket = {
  head: (key: string) => Promise<ArtifactR2Object | null>;
  list: (options: {
    prefix: string;
    cursor?: string;
    limit: number;
    include: string[];
  }) => Promise<{ objects: ArtifactR2Object[]; truncated: boolean; cursor?: string }>;
  delete: (key: string) => Promise<void>;
};

export type ExactReviewArtifactReceiptTuple = {
  producerRunId: string;
  producerRunAttempt: number;
  artifactName: string;
  canonicalItemKey: string;
  leaseRevision: number;
  protocolVersion: number;
};

export type ExactReviewArtifactReceipt = ExactReviewArtifactReceiptTuple & {
  digest: string;
  bytes: number;
  objectKey: string;
  createdAt: number;
  expiresAt: number;
};

export type ExactReviewArtifactReceiptStoreResult =
  | { ok: true; receipt: ExactReviewArtifactReceipt; deduped: boolean }
  | { ok: false; error: string; status: number };

export function exactReviewArtifactReceiptTuple(
  value: unknown,
): ExactReviewArtifactReceiptTuple | null {
  const body = objectValue(value);
  const producerRunId = String(body.producer_run_id || "").trim();
  const producerRunAttempt = Number(body.producer_run_attempt);
  const artifactName = String(body.artifact_name || "").trim();
  const canonicalItemKey = String(body.canonical_item_key || "").trim();
  const leaseRevision = Number(body.lease_revision);
  const protocolVersion = Number(body.protocol_version);
  if (
    !/^\d+$/.test(producerRunId) ||
    !Number.isSafeInteger(producerRunAttempt) ||
    producerRunAttempt < 1 ||
    !ARTIFACT_NAME_PATTERN.test(artifactName) ||
    !ITEM_KEY_PATTERN.test(canonicalItemKey) ||
    !Number.isSafeInteger(leaseRevision) ||
    leaseRevision < 1 ||
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion < 1
  ) {
    return null;
  }
  return {
    producerRunId,
    producerRunAttempt,
    artifactName,
    canonicalItemKey,
    leaseRevision,
    protocolVersion,
  };
}

export function exactReviewArtifactObjectKey(digest: string): string | null {
  return DIGEST_PATTERN.test(digest) ? `${EXACT_REVIEW_ARTIFACT_CACHE_PREFIX}${digest}` : null;
}

export class ExactReviewArtifactReceiptStore {
  private readonly storage: ArtifactReceiptStorage;
  private readonly bucket: ArtifactR2Bucket | null;

  constructor(storage: ArtifactReceiptStorage, bucketBinding: unknown) {
    this.storage = storage;
    this.bucket = artifactBucket(bucketBinding);
  }

  ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_ARTIFACT_RECEIPT_TABLE} (
         producer_run_id TEXT NOT NULL,
         producer_run_attempt INTEGER NOT NULL CHECK (producer_run_attempt >= 1),
         artifact_name TEXT NOT NULL,
         canonical_item_key TEXT NOT NULL,
         lease_revision INTEGER NOT NULL CHECK (lease_revision >= 1),
         protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1),
         digest TEXT NOT NULL,
         bytes INTEGER NOT NULL CHECK (bytes >= 1),
         object_key TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         PRIMARY KEY (
           producer_run_id, producer_run_attempt, artifact_name,
           canonical_item_key, lease_revision, protocol_version
         )
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_artifact_receipts_expiry
         ON ${EXACT_REVIEW_ARTIFACT_RECEIPT_TABLE} (expires_at, digest)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_artifact_receipts_digest_expiry
         ON ${EXACT_REVIEW_ARTIFACT_RECEIPT_TABLE} (digest, expires_at)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_ARTIFACT_CACHE_META_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         prune_cursor TEXT
       ) STRICT`,
    );
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${EXACT_REVIEW_ARTIFACT_CACHE_META_TABLE}
         (singleton_id, prune_cursor) VALUES (1, NULL)`,
    );
  }

  lookup(value: unknown, now: number): ExactReviewArtifactReceipt | null {
    const tuple = exactReviewArtifactReceiptTuple(value);
    if (!tuple) return null;
    this.deleteExpiredReceiptsSync(now);
    const row = firstRow(
      this.storage.sql.exec(
        `SELECT digest, bytes, object_key, created_at, expires_at
           FROM ${EXACT_REVIEW_ARTIFACT_RECEIPT_TABLE}
          WHERE producer_run_id = ? AND producer_run_attempt = ? AND artifact_name = ?
            AND canonical_item_key = ? AND lease_revision = ? AND protocol_version = ?
            AND expires_at > ?`,
        tuple.producerRunId,
        tuple.producerRunAttempt,
        tuple.artifactName,
        tuple.canonicalItemKey,
        tuple.leaseRevision,
        tuple.protocolVersion,
        now,
      ),
    );
    return row ? receiptFromRow(tuple, row) : null;
  }

  async store(value: unknown, now: number): Promise<ExactReviewArtifactReceiptStoreResult> {
    const tuple = exactReviewArtifactReceiptTuple(value);
    const body = objectValue(value);
    const digest = String(body.digest || "").trim();
    const bytes = Number(body.bytes);
    const objectKey = exactReviewArtifactObjectKey(digest);
    if (!tuple || !objectKey || !Number.isSafeInteger(bytes) || bytes < 1) {
      return { ok: false, error: "invalid_artifact_receipt", status: 400 };
    }
    if (!this.bucket) {
      return { ok: false, error: "artifact_cache_unavailable", status: 503 };
    }
    const object = await this.bucket.head(objectKey);
    if (!object || object.size !== bytes || object.customMetadata?.sha256 !== digest) {
      return { ok: false, error: "artifact_cache_object_mismatch", status: 409 };
    }
    const expiresAt = now + EXACT_REVIEW_ARTIFACT_RECEIPT_RETENTION_MS;
    const stored = this.storage.transactionSync(() => {
      this.deleteExpiredReceiptsSync(now);
      const existing = this.lookupExactSync(tuple);
      if (existing && (existing.digest !== digest || existing.bytes !== bytes)) {
        return { conflict: true as const };
      }
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_ARTIFACT_RECEIPT_TABLE}
           (producer_run_id, producer_run_attempt, artifact_name, canonical_item_key,
            lease_revision, protocol_version, digest, bytes, object_key, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (
           producer_run_id, producer_run_attempt, artifact_name,
           canonical_item_key, lease_revision, protocol_version
         ) DO UPDATE SET expires_at = excluded.expires_at`,
        tuple.producerRunId,
        tuple.producerRunAttempt,
        tuple.artifactName,
        tuple.canonicalItemKey,
        tuple.leaseRevision,
        tuple.protocolVersion,
        digest,
        bytes,
        objectKey,
        now,
        expiresAt,
      );
      return { conflict: false as const, deduped: Boolean(existing) };
    });
    if (stored.conflict) {
      return { ok: false, error: "artifact_receipt_immutable_conflict", status: 409 };
    }
    const receipt = this.lookupExactSync(tuple);
    if (!receipt) {
      return { ok: false, error: "artifact_receipt_store_failed", status: 503 };
    }
    return {
      ok: true,
      deduped: stored.deduped,
      receipt,
    };
  }

  async prune(now: number): Promise<{ receiptsDeleted: number; objectsDeleted: number }> {
    const receiptsDeleted = this.deleteExpiredReceiptsSync(now);
    if (!this.bucket) return { receiptsDeleted, objectsDeleted: 0 };
    const cursorRow = firstRow(
      this.storage.sql.exec(
        `SELECT prune_cursor FROM ${EXACT_REVIEW_ARTIFACT_CACHE_META_TABLE}
          WHERE singleton_id = 1`,
      ),
    );
    const cursor = typeof cursorRow?.prune_cursor === "string" ? cursorRow.prune_cursor : null;
    const page = await this.bucket.list({
      prefix: EXACT_REVIEW_ARTIFACT_CACHE_PREFIX,
      ...(cursor ? { cursor } : {}),
      limit: CLEANUP_LIMIT,
      include: ["customMetadata"],
    });
    let objectsDeleted = 0;
    const cutoff = now - EXACT_REVIEW_ARTIFACT_RECEIPT_RETENTION_MS;
    for (const object of page.objects) {
      const uploadedAt = object.uploaded?.getTime();
      if (!Number.isFinite(uploadedAt) || Number(uploadedAt) > cutoff) continue;
      const digest = object.key.slice(EXACT_REVIEW_ARTIFACT_CACHE_PREFIX.length);
      if (!DIGEST_PATTERN.test(digest) || this.hasLiveDigestSync(digest, now)) continue;
      await this.bucket.delete(object.key);
      objectsDeleted += 1;
    }
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_ARTIFACT_CACHE_META_TABLE}
          SET prune_cursor = ? WHERE singleton_id = 1`,
      page.truncated && page.cursor ? page.cursor : null,
    );
    return { receiptsDeleted, objectsDeleted };
  }

  private lookupExactSync(
    tuple: ExactReviewArtifactReceiptTuple,
  ): ExactReviewArtifactReceipt | null {
    const row = firstRow(
      this.storage.sql.exec(
        `SELECT digest, bytes, object_key, created_at, expires_at
           FROM ${EXACT_REVIEW_ARTIFACT_RECEIPT_TABLE}
          WHERE producer_run_id = ? AND producer_run_attempt = ? AND artifact_name = ?
            AND canonical_item_key = ? AND lease_revision = ? AND protocol_version = ?`,
        tuple.producerRunId,
        tuple.producerRunAttempt,
        tuple.artifactName,
        tuple.canonicalItemKey,
        tuple.leaseRevision,
        tuple.protocolVersion,
      ),
    );
    return row ? receiptFromRow(tuple, row) : null;
  }

  private deleteExpiredReceiptsSync(now: number): number {
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT producer_run_id, producer_run_attempt, artifact_name, canonical_item_key,
                lease_revision, protocol_version
           FROM ${EXACT_REVIEW_ARTIFACT_RECEIPT_TABLE}
          WHERE expires_at <= ?
          ORDER BY expires_at
          LIMIT ${CLEANUP_LIMIT}`,
        now,
      ),
    );
    for (const row of rows) {
      this.storage.sql.exec(
        `DELETE FROM ${EXACT_REVIEW_ARTIFACT_RECEIPT_TABLE}
          WHERE producer_run_id = ? AND producer_run_attempt = ? AND artifact_name = ?
            AND canonical_item_key = ? AND lease_revision = ? AND protocol_version = ?`,
        row.producer_run_id,
        row.producer_run_attempt,
        row.artifact_name,
        row.canonical_item_key,
        row.lease_revision,
        row.protocol_version,
      );
    }
    return rows.length;
  }

  private hasLiveDigestSync(digest: string, now: number): boolean {
    return Boolean(
      firstRow(
        this.storage.sql.exec(
          `SELECT 1 AS found FROM ${EXACT_REVIEW_ARTIFACT_RECEIPT_TABLE}
            WHERE digest = ? AND expires_at > ? LIMIT 1`,
          digest,
          now,
        ),
      ),
    );
  }
}

function receiptFromRow(
  tuple: ExactReviewArtifactReceiptTuple,
  row: SqlRow,
): ExactReviewArtifactReceipt {
  return {
    ...tuple,
    digest: String(row.digest),
    bytes: Number(row.bytes),
    objectKey: String(row.object_key),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

function artifactBucket(value: unknown): ArtifactR2Bucket | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ArtifactR2Bucket>;
  return typeof candidate.head === "function" &&
    typeof candidate.list === "function" &&
    typeof candidate.delete === "function"
    ? (candidate as ArtifactR2Bucket)
    : null;
}

function firstRow(rows: Iterable<SqlRow>): SqlRow | undefined {
  return Array.from(rows)[0];
}
