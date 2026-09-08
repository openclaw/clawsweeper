import {
  recordExtension,
  tarHeader,
  RECORD_SNAPSHOT_UPLOAD_MAX_BYTES,
  SNAPSHOT_MAX_IDENTITIES,
  snapshotIdentityKey,
  type SnapshotIdentity,
} from "../src/record-snapshot-protocol.ts";
import type {
  ExactReviewDirectPublicationStore,
  RecordSnapshotIdentity,
} from "./exact-review-direct-publication.ts";
import type { DurableStorage } from "./durable-storage.ts";

export const EXACT_REVIEW_RECORD_SNAPSHOT_TABLE = "exact_review_record_snapshots";
export const RECORD_SNAPSHOT_KEEP = 2;
export const RECORD_SNAPSHOT_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;

const R2_MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const encoder = new TextEncoder();

type UploadedPart = { partNumber: number; etag: string };

type R2MultipartUploadLike = {
  uploadPart: (partNumber: number, value: ArrayBuffer | Uint8Array) => Promise<UploadedPart>;
  complete: (parts: UploadedPart[]) => Promise<unknown>;
  abort: () => Promise<void>;
};

export type SnapshotR2Object = {
  body: ReadableStream<Uint8Array>;
  size: number;
};

export type SnapshotR2Bucket = {
  createMultipartUpload: (
    key: string,
    options?: { httpMetadata?: { contentType?: string } },
  ) => Promise<R2MultipartUploadLike>;
  head: (key: string) => Promise<{ size: number } | null>;
  get: (
    key: string,
    options?: { range?: { offset: number; length: number } },
  ) => Promise<SnapshotR2Object | null>;
  delete: (keys: string | string[]) => Promise<void>;
};

export type RecordSnapshot = {
  repoSlug: string;
  revisionWatermark: number;
  objectKey: string;
  bytes: number;
  uncompressedBytes: number;
  fileCount: number;
  identityDigest?: string;
  createdAt: number;
};

export class SnapshotStoreUnavailableError extends Error {
  constructor(message = "snapshot store unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotStoreUnavailableError";
  }
}

export class SnapshotRegistrationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SnapshotRegistrationError";
    this.status = status;
  }
}

export class ExactReviewRecordSnapshotStore {
  private readonly storage: DurableStorage;
  private readonly records: ExactReviewDirectPublicationStore;
  private readonly bucket: SnapshotR2Bucket | null;
  private registrationTail: Promise<unknown> = Promise.resolve();

  constructor(
    storage: DurableStorage,
    records: ExactReviewDirectPublicationStore,
    bucket: unknown,
  ) {
    this.storage = storage;
    this.records = records;
    this.bucket = snapshotBucket(bucket);
  }

  ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE} (
         snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
         repo_slug TEXT NOT NULL,
         revision_watermark INTEGER NOT NULL CHECK (revision_watermark >= 0),
         object_key TEXT NOT NULL UNIQUE,
         bytes INTEGER NOT NULL CHECK (bytes >= 0),
         uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes >= 0),
         file_count INTEGER NOT NULL CHECK (file_count >= 0),
         identity_digest TEXT,
         created_at INTEGER NOT NULL
       ) STRICT`,
    );
    const columns = Array.from(
      this.storage.sql.exec(
        `SELECT name FROM pragma_table_info('${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE}')`,
      ),
    );
    if (!columns.some((column) => column.name === "identity_digest")) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE} ADD COLUMN identity_digest TEXT`,
      );
    }
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_record_snapshots_latest
         ON ${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE}
         (repo_slug, created_at DESC, snapshot_id DESC)`,
    );
  }

  available() {
    return this.bucket !== null;
  }

  async latest(repoSlug: string): Promise<RecordSnapshot | null> {
    const bucket = this.requireBucket();
    const snapshot = this.latestSync(repoSlug);
    if (!snapshot) return null;
    try {
      const object = await bucket.head(snapshot.objectKey);
      if (!object) throw new Error(`snapshot object is missing: ${snapshot.objectKey}`);
      return snapshot;
    } catch (error) {
      throw unavailable(error);
    }
  }

  async produce(repoSlug: string): Promise<RecordSnapshot> {
    const bucket = this.requireBucket();
    const revisionWatermark = this.records.currentExportRevision();
    const identities = this.records.snapshotRecordIdentities(repoSlug);
    const createdAt = Date.now();
    const objectKey = `${repoSlug}/${revisionWatermark}/${createdAt}-${crypto.randomUUID()}.tar.gz`;
    let upload: R2MultipartUploadLike | null = null;
    try {
      try {
        upload = await bucket.createMultipartUpload(objectKey, {
          httpMetadata: { contentType: "application/gzip" },
        });
      } catch (error) {
        throw unavailable(error);
      }
      const stats = { fileCount: 0, uncompressedBytes: 0 };
      const compressed = tarStream(repoSlug, identities, this.records, stats).pipeThrough(
        new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
      );
      const { bytes, parts } = await uploadMultipart(compressed, upload);
      try {
        await upload.complete(parts);
      } catch (error) {
        throw unavailable(error);
      }
      const snapshot: RecordSnapshot = {
        repoSlug,
        revisionWatermark,
        objectKey,
        bytes,
        uncompressedBytes: stats.uncompressedBytes,
        fileCount: stats.fileCount,
        createdAt,
      };
      this.insertSync(snapshot);
      await this.prune(repoSlug);
      return snapshot;
    } catch (error) {
      if (upload) await upload.abort().catch(() => undefined);
      throw error;
    }
  }

  register(value: Record<string, unknown>): Promise<RecordSnapshot> {
    return this.serializeRegistration(() => this.registerSnapshot(value));
  }

  discardUnregistered(value: Record<string, unknown>): Promise<void> {
    return this.serializeRegistration(async () => {
      const snapshot = validateSnapshotRegistration(value, Number.MAX_SAFE_INTEGER);
      const referenced =
        Array.from(
          this.storage.sql.exec(
            `SELECT 1 FROM ${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE} WHERE object_key = ? LIMIT 1`,
            snapshot.objectKey,
          ),
        ).length > 0;
      if (!referenced) await this.requireBucket().delete(snapshot.objectKey);
    });
  }

  private serializeRegistration<T>(callback: () => Promise<T>): Promise<T> {
    // Reference checks and deletion must not race registration across R2 awaits.
    const result = this.registrationTail.then(callback);
    this.registrationTail = result.catch(() => undefined);
    return result;
  }

  private async registerSnapshot(value: Record<string, unknown>): Promise<RecordSnapshot> {
    const snapshot = validateSnapshotRegistration(value, this.records.currentExportRevision());
    const bucket = this.requireBucket();
    let object: { size: number } | null;
    try {
      object = await bucket.head(snapshot.objectKey);
    } catch (error) {
      throw unavailable(error);
    }
    if (!object) throw new SnapshotRegistrationError("snapshot_object_not_found", 404);
    if (object.size !== snapshot.bytes)
      throw new SnapshotRegistrationError("snapshot_size_mismatch");
    // Updates after the watermark lower this live-index count; no content is read.
    const expected = this.records.snapshotRecordCount(
      snapshot.repoSlug,
      snapshot.revisionWatermark,
    );
    if (snapshot.fileCount < expected)
      throw new SnapshotRegistrationError("snapshot_coverage_incomplete", 422);
    const identities = validateSnapshotIdentities(value.identities);
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(identities)));
    const digest = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== snapshot.identityDigest)
      throw new SnapshotRegistrationError("snapshot_identity_digest_mismatch");
    const provided = new Set(identities.map(snapshotIdentityKey));
    // One ids-only scan; concurrent updates/deletions can only shrink the required set.
    for (const { section, id } of this.records.snapshotRecordIdentities(
      snapshot.repoSlug,
      snapshot.revisionWatermark,
    )) {
      if (!provided.has(snapshotIdentityKey([section, id])))
        throw new SnapshotRegistrationError("snapshot_coverage_incomplete", 422);
    }
    if (identities.length !== snapshot.fileCount)
      throw new SnapshotRegistrationError("invalid_snapshot_identities");
    // A lost response can retry registration; it must not insert another row.
    const existing = Array.from(
      this.storage.sql.exec(
        `SELECT repo_slug, revision_watermark, object_key, bytes, uncompressed_bytes,
              file_count, identity_digest, created_at FROM ${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE}
        WHERE object_key = ?`,
        snapshot.objectKey,
      ),
    )[0];
    if (existing) {
      if (JSON.stringify(snapshotFromRow(existing)) !== JSON.stringify(snapshot)) {
        throw new SnapshotRegistrationError("snapshot_registration_conflict", 409);
      }
    } else {
      this.insertSync(snapshot);
    }
    await this.prune(snapshot.repoSlug);
    return snapshot;
  }

  async readRange(
    repoSlug: string,
    revisionWatermark: number,
    offset: number,
    length: number,
  ): Promise<{ snapshot: RecordSnapshot; object: SnapshotR2Object; length: number }> {
    const bucket = this.requireBucket();
    if (
      !Number.isSafeInteger(revisionWatermark) ||
      revisionWatermark < 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > RECORD_SNAPSHOT_DOWNLOAD_MAX_BYTES
    ) {
      throw new RangeError("invalid snapshot range");
    }
    const snapshot = this.findSync(repoSlug, revisionWatermark);
    if (!snapshot) throw new RangeError("snapshot not found");
    if (offset >= snapshot.bytes) throw new RangeError("snapshot range starts past end");
    const boundedLength = Math.min(length, snapshot.bytes - offset);
    try {
      const object = await bucket.get(snapshot.objectKey, {
        range: { offset, length: boundedLength },
      });
      if (!object) throw new Error(`snapshot object is missing: ${snapshot.objectKey}`);
      return { snapshot, object, length: boundedLength };
    } catch (error) {
      throw unavailable(error);
    }
  }

  private requireBucket() {
    if (!this.bucket) throw new SnapshotStoreUnavailableError();
    return this.bucket;
  }

  private latestSync(repoSlug: string) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT repo_slug, revision_watermark, object_key, bytes, uncompressed_bytes,
                file_count, identity_digest, created_at
           FROM ${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE}
          WHERE repo_slug = ?
          ORDER BY created_at DESC, snapshot_id DESC
          LIMIT 1`,
        repoSlug,
      ),
    )[0];
    return row ? snapshotFromRow(row) : null;
  }

  private findSync(repoSlug: string, revisionWatermark: number) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT repo_slug, revision_watermark, object_key, bytes, uncompressed_bytes,
                file_count, identity_digest, created_at
           FROM ${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE}
          WHERE repo_slug = ? AND revision_watermark = ?
          ORDER BY created_at DESC, snapshot_id DESC
          LIMIT 1`,
        repoSlug,
        revisionWatermark,
      ),
    )[0];
    return row ? snapshotFromRow(row) : null;
  }

  private insertSync(snapshot: RecordSnapshot) {
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE}
         (repo_slug, revision_watermark, object_key, bytes, uncompressed_bytes,
          file_count, identity_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      snapshot.repoSlug,
      snapshot.revisionWatermark,
      snapshot.objectKey,
      snapshot.bytes,
      snapshot.uncompressedBytes,
      snapshot.fileCount,
      snapshot.identityDigest ?? null,
      snapshot.createdAt,
    );
  }

  private async prune(repoSlug: string) {
    const bucket = this.requireBucket();
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT snapshot_id, object_key
           FROM ${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE}
          WHERE repo_slug = ?
          ORDER BY created_at DESC, snapshot_id DESC
          LIMIT -1 OFFSET ?`,
        repoSlug,
        RECORD_SNAPSHOT_KEEP,
      ),
    );
    if (!rows.length) return;
    const objectKeys = rows.map((row) => String(row.object_key));
    try {
      await bucket.delete(objectKeys);
    } catch (error) {
      throw unavailable(error);
    }
    const placeholders = rows.map(() => "?").join(", ");
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_RECORD_SNAPSHOT_TABLE}
        WHERE snapshot_id IN (${placeholders})`,
      ...rows.map((row) => Number(row.snapshot_id)),
    );
  }
}

function snapshotBucket(value: unknown): SnapshotR2Bucket | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SnapshotR2Bucket>;
  return typeof candidate.createMultipartUpload === "function" &&
    typeof candidate.head === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate.delete === "function"
    ? (candidate as SnapshotR2Bucket)
    : null;
}

function unavailable(error: unknown) {
  return error instanceof SnapshotStoreUnavailableError
    ? error
    : new SnapshotStoreUnavailableError("snapshot store unavailable", {
        cause: error instanceof Error ? error : undefined,
      });
}

function snapshotFromRow(row: Record<string, unknown>): RecordSnapshot {
  return {
    repoSlug: String(row.repo_slug),
    revisionWatermark: Number(row.revision_watermark),
    objectKey: String(row.object_key),
    bytes: Number(row.bytes),
    uncompressedBytes: Number(row.uncompressed_bytes),
    fileCount: Number(row.file_count),
    ...(row.identity_digest == null ? {} : { identityDigest: String(row.identity_digest) }),
    createdAt: Number(row.created_at),
  };
}

async function uploadMultipart(stream: ReadableStream<Uint8Array>, upload: R2MultipartUploadLike) {
  const reader = stream.getReader();
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let bytes = 0;
  let partNumber = 1;
  const parts: UploadedPart[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    pending.push(next.value);
    pendingBytes += next.value.byteLength;
    bytes += next.value.byteLength;
    while (pendingBytes >= R2_MULTIPART_PART_BYTES) {
      const part = takeBytes(pending, R2_MULTIPART_PART_BYTES);
      pendingBytes -= part.byteLength;
      try {
        parts.push(await upload.uploadPart(partNumber++, part));
      } catch (error) {
        throw unavailable(error);
      }
    }
  }
  if (pendingBytes) {
    try {
      parts.push(await upload.uploadPart(partNumber, takeBytes(pending, pendingBytes)));
    } catch (error) {
      throw unavailable(error);
    }
  }
  if (!parts.length) throw new Error("snapshot compression produced no data");
  return { bytes, parts };
}

function takeBytes(chunks: Uint8Array[], size: number) {
  const output = new Uint8Array(size);
  let written = 0;
  while (written < size) {
    const chunk = chunks.shift();
    if (!chunk) throw new Error("snapshot byte buffer underflow");
    const take = Math.min(chunk.byteLength, size - written);
    output.set(chunk.subarray(0, take), written);
    written += take;
    if (take < chunk.byteLength) chunks.unshift(chunk.subarray(take));
  }
  return output;
}

function tarStream(
  repoSlug: string,
  identities: readonly RecordSnapshotIdentity[],
  records: ExactReviewDirectPublicationStore,
  stats: { fileCount: number; uncompressedBytes: number },
) {
  const iterator = tarChunks(repoSlug, identities, records, stats)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value as Uint8Array);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function* tarChunks(
  repoSlug: string,
  identities: readonly RecordSnapshotIdentity[],
  records: ExactReviewDirectPublicationStore,
  stats: { fileCount: number; uncompressedBytes: number },
) {
  for (const identity of identities) {
    const record = records.readExportRecord(repoSlug, identity.section, identity.id);
    if (!record || record.deleted || record.content === null) continue;
    const content = encoder.encode(record.content);
    const relativePath = `${identity.section}/${identity.id}${recordExtension(identity.section)}`;
    yield tarHeader(relativePath, content.byteLength);
    yield content;
    const padding = (TAR_BLOCK_BYTES - (content.byteLength % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding) yield new Uint8Array(padding);
    stats.fileCount += 1;
    stats.uncompressedBytes += content.byteLength;
  }
  yield new Uint8Array(TAR_BLOCK_BYTES * 2);
}

export function validateSnapshotRegistration(
  value: Record<string, unknown>,
  currentRevision: number,
): RecordSnapshot {
  const {
    repoSlug,
    revisionWatermark,
    objectKey,
    bytes,
    uncompressedBytes,
    fileCount,
    createdAt,
    identityDigest,
  } = value;
  if (
    typeof repoSlug !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(repoSlug) ||
    !Number.isSafeInteger(revisionWatermark) ||
    Number(revisionWatermark) < 0 ||
    Number(revisionWatermark) > currentRevision ||
    !Number.isSafeInteger(bytes) ||
    Number(bytes) < 1 ||
    Number(bytes) > RECORD_SNAPSHOT_UPLOAD_MAX_BYTES ||
    !Number.isSafeInteger(uncompressedBytes) ||
    Number(uncompressedBytes) < 0 ||
    !Number.isSafeInteger(fileCount) ||
    Number(fileCount) < 0 ||
    Number(fileCount) > SNAPSHOT_MAX_IDENTITIES ||
    typeof identityDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(identityDigest) ||
    !Number.isSafeInteger(createdAt) ||
    Number(createdAt) < 1 ||
    Number(createdAt) > Date.now() ||
    typeof objectKey !== "string" ||
    !objectKey.startsWith(`${repoSlug}/${revisionWatermark}/${createdAt}-`) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar\.gz$/.test(
      objectKey.slice(`${repoSlug}/${revisionWatermark}/${createdAt}-`.length),
    )
  )
    throw new SnapshotRegistrationError("invalid_snapshot_descriptor");
  return {
    repoSlug,
    revisionWatermark: Number(revisionWatermark),
    objectKey,
    bytes: Number(bytes),
    uncompressedBytes: Number(uncompressedBytes),
    fileCount: Number(fileCount),
    identityDigest,
    createdAt: Number(createdAt),
  };
}

export function validateSnapshotIdentities(value: unknown, fileCount?: number): SnapshotIdentity[] {
  if (
    !Array.isArray(value) ||
    value.length > SNAPSHOT_MAX_IDENTITIES ||
    (fileCount !== undefined && value.length !== fileCount)
  )
    throw new SnapshotRegistrationError("invalid_snapshot_identities");
  let previous = "";
  for (const pair of value) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !["items", "closed", "plans", "decision-packets", "commits"].includes(pair[0]) ||
      typeof pair[1] !== "string" ||
      pair[1].length > 255 ||
      !(pair[0] === "commits" ? /^[0-9a-f]{40}$/.test(pair[1]) : /^[1-9]\d*$/.test(pair[1]))
    )
      throw new SnapshotRegistrationError("invalid_snapshot_identities");
    const key = snapshotIdentityKey(pair as SnapshotIdentity);
    if (key <= previous) throw new SnapshotRegistrationError("invalid_snapshot_identities");
    previous = key;
  }
  return value as SnapshotIdentity[];
}
