/**
 * R2-backed state blob store for the Cloudflare-canonical migration (phase 3).
 *
 * Serves the remaining git-state trees and exact-review artifact cache from
 * the shared STATE_SNAPSHOTS bucket under distinct key prefixes:
 *   - `ledger/v1/...`  — immutable append-only action-ledger shards. Writes are
 *     create-only: overwriting an existing key with a different content digest
 *     is rejected; a same-digest PUT is idempotent.
 *   - `assets/...`     — mutable published assets; overwrite is allowed.
 *   - `artifacts/exact-review/v1/<sha256>` — immutable, content-addressed
 *     exact-review bundle archives. Queue receipts fence their reuse.
 *
 * Record snapshots produced by the phase-2 code live under
 * `<repoSlug>/<revision>/...` keys and never collide with these prefixes.
 *
 * R2 bindings cannot presign URLs, so reads are proxied through the Worker in
 * bounded ranges (mirroring the record-snapshot chunk endpoint) and large
 * writes stream through R2 multipart uploads with fixed-size base64 parts.
 */

import { sanitizedServerError } from "./error-safety.ts";

export const STATE_BLOB_OPERATIONS = [
  "put",
  "stat",
  "chunk",
  "list",
  "multipart/start",
  "multipart/part",
  "multipart/complete",
  "multipart/abort",
] as const;
export type StateBlobOperation = (typeof STATE_BLOB_OPERATIONS)[number];

export const STATE_BLOB_CHUNK_MAX_BYTES = 32 * 1024 * 1024;
export const STATE_BLOB_PUT_MAX_BYTES = 24 * 1024 * 1024;
export const STATE_BLOB_MULTIPART_PART_BYTES = 8 * 1024 * 1024;
export const STATE_BLOB_MAX_BYTES = 1024 * 1024 * 1024;
export const STATE_BLOB_LIST_MAX_LIMIT = 1000;

const BLOB_PATH_PREFIXES = ["ledger/v1/", "assets/", "artifacts/exact-review/v1/"] as const;
const IMMUTABLE_PATH_PREFIXES = ["ledger/", "artifacts/exact-review/"] as const;
const EXACT_REVIEW_ARTIFACT_PATH_PATTERN = /^artifacts\/exact-review\/v1\/[0-9a-f]{64}$/;
const BLOB_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._+@-]{0,254}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

type BlobR2Object = {
  key: string;
  size: number;
  customMetadata?: Record<string, string>;
};

type BlobR2ObjectBody = BlobR2Object & { body: ReadableStream<Uint8Array> };

type BlobR2UploadedPart = { partNumber: number; etag: string };

type BlobR2MultipartUpload = {
  uploadId: string;
  uploadPart: (partNumber: number, value: Uint8Array) => Promise<BlobR2UploadedPart>;
  complete: (parts: BlobR2UploadedPart[]) => Promise<unknown>;
  abort: () => Promise<void>;
};

type BlobR2Bucket = {
  head: (key: string) => Promise<BlobR2Object | null>;
  get: (
    key: string,
    options?: { range?: { offset: number; length: number } },
  ) => Promise<BlobR2ObjectBody | null>;
  put: (
    key: string,
    value: Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ) => Promise<unknown>;
  list: (options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    include?: string[];
  }) => Promise<{ objects: BlobR2Object[]; truncated: boolean; cursor?: string }>;
  createMultipartUpload: (
    key: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ) => Promise<BlobR2MultipartUpload>;
  resumeMultipartUpload: (key: string, uploadId: string) => BlobR2MultipartUpload;
};

export function isValidStateBlobPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 900) return false;
  if (!BLOB_PATH_PREFIXES.some((prefix) => value.startsWith(prefix))) return false;
  if (
    value.startsWith("artifacts/exact-review/") &&
    !EXACT_REVIEW_ARTIFACT_PATH_PATTERN.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => BLOB_PATH_SEGMENT_PATTERN.test(segment));
}

export function isImmutableStateBlobPath(path: string): boolean {
  return IMMUTABLE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function isValidStateBlobListPrefix(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 900) return false;
  const normalized = value.endsWith("/") ? value : `${value}/`;
  if (!BLOB_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix) || prefix === normalized))
    return false;
  return normalized
    .slice(0, -1)
    .split("/")
    .every((segment) => BLOB_PATH_SEGMENT_PATTERN.test(segment));
}

export async function handleStateBlobRequest(
  bucketBinding: unknown,
  operation: StateBlobOperation,
  body: Record<string, unknown>,
): Promise<Response> {
  const bucket = blobBucket(bucketBinding);
  if (!bucket) {
    return blobJson(
      { error: "blob_store_unavailable", detail: "STATE_SNAPSHOTS is not available" },
      503,
    );
  }
  try {
    if (operation === "put") return await putBlob(bucket, body);
    if (operation === "stat") return await statBlob(bucket, body);
    if (operation === "chunk") return await chunkBlob(bucket, body);
    if (operation === "list") return await listBlobs(bucket, body);
    if (operation === "multipart/start") return await startMultipart(bucket, body);
    if (operation === "multipart/part") return await uploadMultipartPart(bucket, body);
    if (operation === "multipart/complete") return await completeMultipart(bucket, body);
    if (operation === "multipart/abort") return await abortMultipart(bucket, body);
    return blobJson({ error: "unknown_blob_operation" }, 404);
  } catch (error) {
    if (error instanceof BlobRequestError) return blobJson(error.body, error.status);
    console.error(`state blob request failed: ${sanitizedServerError(error)}`);
    return blobJson({ error: "blob_store_unavailable" }, 503);
  }
}

class BlobRequestError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error));
    this.name = "BlobRequestError";
    this.status = status;
    this.body = body;
  }
}

async function putBlob(bucket: BlobR2Bucket, body: Record<string, unknown>) {
  const path = requireBlobPath(body.path);
  const digest = requireBlobDigest(body.digest);
  requireArtifactPathDigest(path, digest);
  const content = decodeBase64(body.contentBase64);
  if (!content) throw new BlobRequestError(400, { error: "invalid_blob_content" });
  if (content.byteLength > STATE_BLOB_PUT_MAX_BYTES) {
    throw new BlobRequestError(413, {
      error: "blob_too_large",
      maxBytes: STATE_BLOB_PUT_MAX_BYTES,
      detail: "use the multipart upload endpoints for larger blobs",
    });
  }
  if ((await sha256Hex(content)) !== digest) {
    throw new BlobRequestError(400, { error: "blob_digest_mismatch" });
  }
  const existing = await bucket.head(path);
  const conflict = existingConflict(path, existing, digest, content.byteLength);
  if (conflict === "unchanged") {
    return blobJson({ ok: true, path, bytes: content.byteLength, digest, unchanged: true });
  }
  if (conflict) throw conflict;
  await bucket.put(path, content, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { sha256: digest, verified: "server" },
  });
  return blobJson({ ok: true, path, bytes: content.byteLength, digest, unchanged: false }, 201);
}

async function statBlob(bucket: BlobR2Bucket, body: Record<string, unknown>) {
  const path = requireBlobPath(body.path);
  const object = await bucket.head(path);
  if (!object) return blobJson({ error: "blob_not_found", path }, 404);
  return blobJson({ ok: true, blob: blobDescriptor(path, object) });
}

async function chunkBlob(bucket: BlobR2Bucket, body: Record<string, unknown>) {
  const path = requireBlobPath(body.path);
  const offset = Number(body.offset);
  const length = Number(body.length);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > STATE_BLOB_CHUNK_MAX_BYTES
  ) {
    throw new BlobRequestError(400, {
      error: "invalid_blob_range",
      maxChunkBytes: STATE_BLOB_CHUNK_MAX_BYTES,
    });
  }
  const head = await bucket.head(path);
  if (!head) return blobJson({ error: "blob_not_found", path }, 404);
  if (offset >= head.size) {
    throw new BlobRequestError(416, { error: "invalid_blob_range", bytes: head.size });
  }
  const boundedLength = Math.min(length, head.size - offset);
  const object = await bucket.get(path, { range: { offset, length: boundedLength } });
  if (!object) return blobJson({ error: "blob_not_found", path }, 404);
  return new Response(object.body, {
    status: 206,
    headers: {
      "accept-ranges": "bytes",
      "content-length": String(boundedLength),
      "content-range": `bytes ${offset}-${offset + boundedLength - 1}/${head.size}`,
      "content-type": "application/octet-stream",
      ...(head.customMetadata?.sha256
        ? { "x-clawsweeper-blob-digest": head.customMetadata.sha256 }
        : {}),
    },
  });
}

async function listBlobs(bucket: BlobR2Bucket, body: Record<string, unknown>) {
  if (!isValidStateBlobListPrefix(body.prefix)) {
    throw new BlobRequestError(400, { error: "invalid_blob_prefix" });
  }
  const prefix = body.prefix.endsWith("/") ? body.prefix : `${body.prefix}/`;
  const cursor = body.cursor === undefined ? undefined : String(body.cursor);
  const limit = body.limit === undefined ? STATE_BLOB_LIST_MAX_LIMIT : Number(body.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > STATE_BLOB_LIST_MAX_LIMIT) {
    throw new BlobRequestError(400, {
      error: "invalid_blob_list_limit",
      maxLimit: STATE_BLOB_LIST_MAX_LIMIT,
    });
  }
  const page = await bucket.list({
    prefix,
    ...(cursor ? { cursor } : {}),
    limit,
    include: ["customMetadata"],
  });
  return blobJson({
    ok: true,
    prefix,
    blobs: page.objects.map((object) => blobDescriptor(object.key, object)),
    nextCursor: page.truncated ? (page.cursor ?? null) : null,
  });
}

async function startMultipart(bucket: BlobR2Bucket, body: Record<string, unknown>) {
  const path = requireBlobPath(body.path);
  const digest = requireBlobDigest(body.digest);
  requireArtifactPathDigest(path, digest);
  const bytes = Number(body.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > STATE_BLOB_MAX_BYTES) {
    throw new BlobRequestError(400, {
      error: "invalid_blob_bytes",
      maxBytes: STATE_BLOB_MAX_BYTES,
    });
  }
  const existing = await bucket.head(path);
  const conflict = existingConflict(path, existing, digest, bytes);
  if (conflict === "unchanged") {
    return blobJson({ ok: true, path, bytes, digest, unchanged: true, uploadId: null });
  }
  if (conflict) throw conflict;
  const upload = await bucket.createMultipartUpload(path, {
    httpMetadata: { contentType: "application/octet-stream" },
    // Multipart bodies stream through R2 part by part, so the Worker cannot
    // recompute the whole-object digest; the claimed digest is verified by the
    // uploader with a read-back before it is trusted.
    customMetadata: { sha256: digest, verified: "client" },
  });
  return blobJson(
    {
      ok: true,
      path,
      digest,
      unchanged: false,
      uploadId: upload.uploadId,
      partBytes: STATE_BLOB_MULTIPART_PART_BYTES,
    },
    201,
  );
}

async function uploadMultipartPart(bucket: BlobR2Bucket, body: Record<string, unknown>) {
  const path = requireBlobPath(body.path);
  const uploadId = requireUploadId(body.uploadId);
  const partNumber = Number(body.partNumber);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    throw new BlobRequestError(400, { error: "invalid_blob_part_number" });
  }
  const content = decodeBase64(body.contentBase64);
  if (!content || content.byteLength < 1) {
    throw new BlobRequestError(400, { error: "invalid_blob_content" });
  }
  if (content.byteLength > STATE_BLOB_MULTIPART_PART_BYTES) {
    throw new BlobRequestError(413, {
      error: "blob_part_too_large",
      maxBytes: STATE_BLOB_MULTIPART_PART_BYTES,
    });
  }
  try {
    const part = await bucket.resumeMultipartUpload(path, uploadId).uploadPart(partNumber, content);
    return blobJson({ ok: true, path, part: { partNumber: part.partNumber, etag: part.etag } });
  } catch (error) {
    throw invalidUpload(error);
  }
}

async function completeMultipart(bucket: BlobR2Bucket, body: Record<string, unknown>) {
  const path = requireBlobPath(body.path);
  const uploadId = requireUploadId(body.uploadId);
  const digest = requireBlobDigest(body.digest);
  requireArtifactPathDigest(path, digest);
  const bytes = Number(body.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > STATE_BLOB_MAX_BYTES) {
    throw new BlobRequestError(400, {
      error: "invalid_blob_bytes",
      maxBytes: STATE_BLOB_MAX_BYTES,
    });
  }
  const parts = multipartParts(body.parts);
  if (!parts) throw new BlobRequestError(400, { error: "invalid_blob_parts" });
  const upload = bucket.resumeMultipartUpload(path, uploadId);
  // Re-check immutability at completion: a concurrent writer may have created
  // the key after multipart/start admitted this upload.
  const existing = await bucket.head(path);
  const conflict = existingConflict(path, existing, digest, bytes);
  if (conflict === "unchanged" || conflict) {
    await upload.abort().catch(() => undefined);
    if (conflict === "unchanged")
      return blobJson({ ok: true, path, bytes, digest, unchanged: true });
    throw conflict;
  }
  try {
    await upload.complete(parts);
  } catch (error) {
    throw invalidUpload(error);
  }
  const completed = await bucket.head(path);
  if (!completed || completed.size !== bytes) {
    throw new BlobRequestError(400, {
      error: "blob_size_mismatch",
      expectedBytes: bytes,
      receivedBytes: completed?.size ?? 0,
    });
  }
  return blobJson({ ok: true, path, bytes, digest, unchanged: false }, 201);
}

async function abortMultipart(bucket: BlobR2Bucket, body: Record<string, unknown>) {
  const path = requireBlobPath(body.path);
  const uploadId = requireUploadId(body.uploadId);
  await bucket
    .resumeMultipartUpload(path, uploadId)
    .abort()
    .catch(() => undefined);
  return blobJson({ ok: true, path });
}

function existingConflict(
  path: string,
  existing: BlobR2Object | null,
  digest: string,
  bytes: number,
): BlobRequestError | "unchanged" | null {
  if (!existing) return null;
  const existingDigest = existing.customMetadata?.sha256 ?? null;
  if (existingDigest === digest && existing.size === bytes) return "unchanged";
  if (!isImmutableStateBlobPath(path)) return null;
  return new BlobRequestError(409, {
    error: path.startsWith("artifacts/")
      ? "artifact_blob_immutable_conflict"
      : "ledger_blob_immutable_conflict",
    path,
    existingBytes: existing.size,
    existingDigest,
  });
}

function blobDescriptor(path: string, object: BlobR2Object) {
  return {
    path,
    bytes: object.size,
    digest: object.customMetadata?.sha256 ?? null,
    digestVerified: object.customMetadata?.verified === "server",
  };
}

function requireBlobPath(value: unknown): string {
  if (!isValidStateBlobPath(value)) throw new BlobRequestError(400, { error: "invalid_blob_path" });
  return value;
}

function requireBlobDigest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new BlobRequestError(400, { error: "invalid_blob_digest" });
  }
  return value;
}

function requireArtifactPathDigest(path: string, digest: string) {
  if (
    path.startsWith("artifacts/exact-review/") &&
    path !== `artifacts/exact-review/v1/${digest}`
  ) {
    throw new BlobRequestError(400, { error: "artifact_blob_key_digest_mismatch" });
  }
}

function requireUploadId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096) {
    throw new BlobRequestError(400, { error: "invalid_blob_upload" });
  }
  return value;
}

function multipartParts(value: unknown): BlobR2UploadedPart[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10000) return null;
  const parts: BlobR2UploadedPart[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const partNumber = Number((entry as { partNumber: unknown }).partNumber);
    const etag = (entry as { etag: unknown }).etag;
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || typeof etag !== "string")
      return null;
    parts.push({ partNumber, etag });
  }
  return parts;
}

function invalidUpload(error: unknown) {
  console.warn(`state blob upload rejected: ${sanitizedServerError(error)}`);
  return new BlobRequestError(400, { error: "invalid_blob_upload" });
}

function blobBucket(value: unknown): BlobR2Bucket | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<BlobR2Bucket>;
  return typeof candidate.head === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate.put === "function" &&
    typeof candidate.list === "function" &&
    typeof candidate.createMultipartUpload === "function" &&
    typeof candidate.resumeMultipartUpload === "function"
    ? (candidate as BlobR2Bucket)
    : null;
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function blobJson(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
