import type {
  ExactReviewDirectPublicationStore,
  RecordSection,
  RecordSnapshotIdentity,
} from "./exact-review-direct-publication.ts";

export const EXACT_REVIEW_RECORD_SNAPSHOT_TABLE = "exact_review_record_snapshots";
export const RECORD_SNAPSHOT_KEEP = 2;
export const RECORD_SNAPSHOT_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;

const R2_MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const encoder = new TextEncoder();

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};

type DurableStorage = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};

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
  head: (key: string) => Promise<unknown | null>;
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
  createdAt: number;
};

export class SnapshotStoreUnavailableError extends Error {
  constructor(message = "snapshot store unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotStoreUnavailableError";
  }
}

export class ExactReviewRecordSnapshotStore {
  private readonly storage: DurableStorage;
  private readonly records: ExactReviewDirectPublicationStore;
  private readonly bucket: SnapshotR2Bucket | null;

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
         created_at INTEGER NOT NULL
       ) STRICT`,
    );
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
                file_count, created_at
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
                file_count, created_at
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
          file_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      snapshot.repoSlug,
      snapshot.revisionWatermark,
      snapshot.objectKey,
      snapshot.bytes,
      snapshot.uncompressedBytes,
      snapshot.fileCount,
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

function tarHeader(relativePath: string, size: number) {
  const header = new Uint8Array(TAR_BLOCK_BYTES);
  const { name, prefix } = splitTarPath(relativePath);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  writeTarString(header, 265, 32, "clawsweeper");
  writeTarString(header, 297, 32, "clawsweeper");
  writeTarString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeTarString(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(relativePath: string) {
  if (encoder.encode(relativePath).byteLength <= 100) return { name: relativePath, prefix: "" };
  for (
    let index = relativePath.lastIndexOf("/");
    index > 0;
    index = relativePath.lastIndexOf("/", index - 1)
  ) {
    const prefix = relativePath.slice(0, index);
    const name = relativePath.slice(index + 1);
    if (encoder.encode(prefix).byteLength <= 155 && encoder.encode(name).byteLength <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`snapshot tar path is too long: ${relativePath}`);
}

function writeTarString(target: Uint8Array, offset: number, length: number, value: string) {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error(`tar header value exceeds ${length} bytes`);
  target.set(bytes, offset);
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const octal = value.toString(8).padStart(length - 1, "0");
  if (octal.length >= length) throw new Error(`tar numeric value exceeds ${length} bytes`);
  writeTarString(target, offset, length - 1, octal);
  target[offset + length - 1] = 0;
}

function recordExtension(section: RecordSection) {
  return section === "decision-packets" ? ".json" : ".md";
}
