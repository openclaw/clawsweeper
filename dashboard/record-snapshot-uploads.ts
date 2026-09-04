import {
  RECORD_SNAPSHOT_UPLOAD_MAX_BYTES,
  SNAPSHOT_UPLOAD_PART_BYTES,
  SNAPSHOT_MANIFEST_CHUNK_IDENTITIES,
  type SnapshotIdentity,
} from "../src/record-snapshot-protocol.ts";
import {
  SnapshotRegistrationError,
  validateSnapshotRegistration,
  validateSnapshotIdentities,
  type RecordSnapshot,
} from "./record-snapshots.ts";

export const SNAPSHOT_UPLOAD_MAX_PARTS = 200;
export const SNAPSHOT_UPLOAD_TTL_SECONDS = 3600;
export const SNAPSHOT_UPLOAD_CLOCK_SKEW_MS = 5 * 60 * 1000;
export { SNAPSHOT_UPLOAD_JSON_MAX_BYTES } from "../src/record-snapshot-protocol.ts";
export const SNAPSHOT_UPLOAD_OPERATIONS = [
  "start",
  "part",
  "manifest",
  "complete",
  "abort",
] as const;
export type SnapshotUploadOperation = (typeof SNAPSHOT_UPLOAD_OPERATIONS)[number];

type Part = { partNumber: number; etag: string };
type Receipt = Part & { bytes: number; sha256: string };
type Session = {
  snapshot: RecordSnapshot;
  r2UploadId: string;
  sha256: string;
  expiresAt: number;
  aborted?: boolean;
};
export const SNAPSHOT_UPLOAD_SESSION_PREFIX = "record-snapshot-upload/";
type Multipart = {
  uploadId: string;
  uploadPart: (partNumber: number, bytes: Uint8Array) => Promise<Part>;
  complete: (parts: Part[]) => Promise<unknown>;
  abort: () => Promise<void>;
};
type Bucket = {
  createMultipartUpload: (
    key: string,
    options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> },
  ) => Promise<Multipart>;
  resumeMultipartUpload: (key: string, uploadId: string) => Multipart;
  head: (key: string) => Promise<{ size: number } | null>;
  put: (key: string, value: string) => Promise<unknown>;
  get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
  delete: (keys: string[]) => Promise<void>;
};
export type SnapshotUploadStore = {
  read: (key: string) => Promise<string | null>;
  write: (key: string, value: string, ttlSeconds: number) => Promise<unknown>;
};

export async function handleSnapshotUpload(
  bucketBinding: unknown,
  store: SnapshotUploadStore,
  operation: SnapshotUploadOperation,
  body: Record<string, unknown>,
  register: (snapshot: RecordSnapshot & { identities: SnapshotIdentity[] }) => Promise<Response>,
  discard: (snapshot: RecordSnapshot) => Promise<Response>,
): Promise<Response> {
  const bucket = bucketBinding as Bucket | undefined;
  if (!bucket?.createMultipartUpload || !bucket.resumeMultipartUpload || !bucket.head)
    return Response.json({ error: "snapshot_store_unavailable" }, { status: 503 });
  try {
    if (body.operation !== operation)
      throw new SnapshotRegistrationError("upload_operation_mismatch");
    validateSnapshotUploadIssuedAt(body.issuedAt);
    if (operation === "start") {
      if (typeof body.bytes === "number" && body.bytes > RECORD_SNAPSHOT_UPLOAD_MAX_BYTES)
        throw new SnapshotRegistrationError("snapshot_too_large", 413);
      const sha256 = requireDigest(body.sha256);
      if (
        typeof body.operationId !== "string" ||
        !/^[A-Za-z0-9:_.-]{1,256}$/.test(body.operationId)
      )
        throw new SnapshotRegistrationError("invalid_snapshot_operation_id");
      const operationKey = `record-snapshot-operation/${body.operationId}`;
      // The owning StatusStore serializes metadata operations, including this
      // lookup, R2 creation, and the durable session/operation receipts.
      const previous = await store.read(operationKey);
      const fingerprint = JSON.stringify([
        body.repoSlug,
        body.revisionWatermark,
        body.bytes,
        body.uncompressedBytes,
        body.fileCount,
        body.identityDigest,
        sha256,
      ]);
      if (previous) {
        const receipt = JSON.parse(previous);
        if (receipt.fingerprint !== fingerprint)
          throw new SnapshotRegistrationError("snapshot_operation_conflict", 409);
        const stored = await store.read(sessionKey(receipt.uploadId));
        if (!stored) throw new SnapshotRegistrationError("snapshot_upload_expired", 410);
        const session: Session = JSON.parse(stored);
        if (session.aborted || session.expiresAt <= Date.now())
          throw new SnapshotRegistrationError("snapshot_upload_expired", 410);
        return startResponse(receipt.uploadId, session, 200);
      }
      const createdAt = Date.now();
      const uploadId = crypto.randomUUID();
      const objectKey = `${body.repoSlug}/${body.revisionWatermark}/${createdAt}-${uploadId}.tar.gz`;
      const snapshot = validateSnapshotRegistration(
        { ...body, createdAt, objectKey },
        Number.MAX_SAFE_INTEGER,
      );
      const upload = await bucket.createMultipartUpload(objectKey, {
        httpMetadata: { contentType: "application/gzip" },
        // Whole-object SHA256 is the runner's claim; each part is verified below.
        customMetadata: { sha256, verified: "parts-and-length" },
      });
      const session: Session = {
        snapshot,
        r2UploadId: upload.uploadId,
        sha256,
        expiresAt:
          Math.max(createdAt, Date.parse(body.issuedAt as string)) +
          SNAPSHOT_UPLOAD_TTL_SECONDS * 1000,
      };
      try {
        await store.write(
          sessionKey(uploadId),
          JSON.stringify(session),
          Math.ceil((session.expiresAt - createdAt) / 1000),
        );
        await store.write(
          operationKey,
          JSON.stringify({ fingerprint, uploadId }),
          SNAPSHOT_UPLOAD_TTL_SECONDS + SNAPSHOT_UPLOAD_CLOCK_SKEW_MS / 1000,
        );
      } catch (error) {
        await upload.abort().catch(() => undefined);
        throw error;
      }
      return startResponse(uploadId, session, 201);
    }
    if (typeof body.uploadId !== "string" || body.uploadId.length > 200)
      throw new SnapshotRegistrationError("invalid_snapshot_upload_id");
    const key = sessionKey(body.uploadId);
    const stored = await store.read(key);
    if (!stored) throw new SnapshotRegistrationError("snapshot_upload_expired", 410);
    const session: Session = JSON.parse(stored);
    if (session.expiresAt <= Date.now() || session.aborted)
      throw new SnapshotRegistrationError("snapshot_upload_expired", 410);
    const { snapshot } = session;
    const upload = bucket.resumeMultipartUpload(snapshot.objectKey, session.r2UploadId);
    const ttl = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
    const partCount = Math.ceil(snapshot.bytes / SNAPSHOT_UPLOAD_PART_BYTES);
    const manifestChunks = Math.ceil(snapshot.fileCount / SNAPSHOT_MANIFEST_CHUNK_IDENTITIES);
    if (operation === "abort") {
      await cleanupSnapshotUpload(bucket, stored, discard);
      await store.write(key, JSON.stringify({ ...session, aborted: true }), ttl);
      return Response.json({ ok: true });
    }
    if (operation === "part") {
      const partNumber = body.partNumber;
      if (
        !Number.isSafeInteger(partNumber) ||
        Number(partNumber) < 1 ||
        Number(partNumber) > partCount ||
        Number(partNumber) > SNAPSHOT_UPLOAD_MAX_PARTS
      )
        throw new SnapshotRegistrationError("invalid_snapshot_part_number");
      if (typeof body.data !== "string" || body.data.length > (SNAPSHOT_UPLOAD_PART_BYTES / 3) * 4)
        throw new SnapshotRegistrationError("snapshot_part_too_large", 413);
      if (body.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data))
        throw new SnapshotRegistrationError("invalid_snapshot_part_data");
      const decoded = atob(body.data);
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
      const expected =
        Number(partNumber) === partCount
          ? snapshot.bytes - (partCount - 1) * SNAPSHOT_UPLOAD_PART_BYTES
          : SNAPSHOT_UPLOAD_PART_BYTES;
      if (bytes.length !== expected)
        throw new SnapshotRegistrationError("snapshot_part_size_mismatch");
      const sha256 = requireDigest(body.sha256);
      if ((await digest(bytes)) !== sha256)
        throw new SnapshotRegistrationError("snapshot_part_digest_mismatch");
      if (partCount === 1 && sha256 !== session.sha256)
        throw new SnapshotRegistrationError("snapshot_digest_mismatch");
      const receiptKey = `${key}/parts/${partNumber}`;
      const previous = await store.read(receiptKey);
      if (previous) {
        const receipt: Receipt = JSON.parse(previous);
        if (receipt.sha256 !== sha256 || receipt.bytes !== bytes.length)
          throw new SnapshotRegistrationError("snapshot_part_conflict", 409);
        return Response.json({
          ok: true,
          part: { partNumber: receipt.partNumber, etag: receipt.etag },
        });
      }
      const part = await upload.uploadPart(Number(partNumber), bytes);
      await store.write(receiptKey, JSON.stringify({ ...part, bytes: bytes.length, sha256 }), ttl);
      return Response.json({ ok: true, part });
    }
    if (operation === "manifest") {
      const partNumber = Number(body.partNumber);
      if (!Number.isSafeInteger(body.partNumber) || partNumber < 1 || partNumber > manifestChunks)
        throw new SnapshotRegistrationError("invalid_snapshot_manifest_part");
      const count = Math.min(
        SNAPSHOT_MANIFEST_CHUNK_IDENTITIES,
        snapshot.fileCount - (partNumber - 1) * SNAPSHOT_MANIFEST_CHUNK_IDENTITIES,
      );
      const identities = validateSnapshotIdentities(body.identities, count);
      const manifest = JSON.stringify(identities);
      const sha256 = await digest(new TextEncoder().encode(manifest));
      const receiptKey = `${key}/manifest/${partNumber}`;
      const previous = await store.read(receiptKey);
      if (previous && previous !== sha256)
        throw new SnapshotRegistrationError("snapshot_manifest_conflict", 409);
      if (!previous) {
        await bucket.put(manifestKey(snapshot, partNumber), manifest);
        await store.write(receiptKey, sha256, ttl);
      }
      return Response.json({ ok: true });
    }
    if (
      !Array.isArray(body.parts) ||
      body.parts.length !== partCount ||
      body.parts.length > SNAPSHOT_UPLOAD_MAX_PARTS
    )
      throw new SnapshotRegistrationError("invalid_snapshot_parts");
    const parts: Part[] = [];
    let total = 0;
    for (let index = 0; index < body.parts.length; index++) {
      const part = body.parts[index];
      if (!part || part.partNumber !== index + 1 || typeof part.etag !== "string")
        throw new SnapshotRegistrationError("invalid_snapshot_parts");
      const storedPart = await store.read(`${key}/parts/${index + 1}`);
      if (!storedPart) throw new SnapshotRegistrationError("snapshot_part_missing");
      const receipt: Receipt = JSON.parse(storedPart);
      if (receipt.etag !== part.etag) throw new SnapshotRegistrationError("snapshot_part_mismatch");
      total += receipt.bytes;
      parts.push({ partNumber: part.partNumber, etag: part.etag });
    }
    if (total !== snapshot.bytes) throw new SnapshotRegistrationError("snapshot_size_mismatch");
    // Completion and registration are retryable even if either response is lost.
    let object = await bucket.head(snapshot.objectKey);
    if (!object) {
      await upload.complete(parts);
      object = await bucket.head(snapshot.objectKey);
    }
    if (!object || object.size !== total)
      throw new SnapshotRegistrationError("snapshot_size_mismatch");
    let identities = body.identities;
    if (identities === undefined) {
      const staged: SnapshotIdentity[] = [];
      for (let partNumber = 1; partNumber <= manifestChunks; partNumber++) {
        const receipt = await store.read(`${key}/manifest/${partNumber}`);
        const chunk = await bucket.get(manifestKey(snapshot, partNumber));
        if (!receipt || !chunk) throw new SnapshotRegistrationError("snapshot_manifest_missing");
        const content = await chunk.text();
        if ((await digest(new TextEncoder().encode(content))) !== receipt)
          throw new SnapshotRegistrationError("snapshot_manifest_digest_mismatch");
        const count = Math.min(
          SNAPSHOT_MANIFEST_CHUNK_IDENTITIES,
          snapshot.fileCount - (partNumber - 1) * SNAPSHOT_MANIFEST_CHUNK_IDENTITIES,
        );
        for (const pair of validateSnapshotIdentities(JSON.parse(content), count))
          staged.push(pair);
      }
      identities = staged;
    }
    return await register({
      ...snapshot,
      identities: validateSnapshotIdentities(identities),
    });
  } catch (error) {
    if (error instanceof SnapshotRegistrationError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error("snapshot_upload_unavailable");
    return Response.json({ error: "snapshot_upload_unavailable" }, { status: 503 });
  }
}

function startResponse(uploadId: string, session: Session, status: number) {
  return Response.json(
    {
      ok: true,
      uploadId,
      objectKey: session.snapshot.objectKey,
      partBytes: SNAPSHOT_UPLOAD_PART_BYTES,
      expiresAt: session.expiresAt,
    },
    { status },
  );
}

export async function cleanupSnapshotUpload(
  bucketBinding: unknown,
  stored: string,
  discard: (snapshot: RecordSnapshot) => Promise<Response>,
) {
  const bucket = bucketBinding as Bucket;
  const session: Session = JSON.parse(stored);
  if (session.aborted) return;
  const manifestChunks = Math.ceil(session.snapshot.fileCount / SNAPSHOT_MANIFEST_CHUNK_IDENTITIES);
  if (manifestChunks)
    await bucket.delete(
      Array.from({ length: manifestChunks }, (_, index) =>
        manifestKey(session.snapshot, index + 1),
      ),
    );
  if (await bucket.head(session.snapshot.objectKey)) {
    const response = await discard(session.snapshot);
    if (!response.ok) throw new Error("snapshot_discard_unavailable");
  } else {
    await bucket.resumeMultipartUpload(session.snapshot.objectKey, session.r2UploadId).abort();
  }
}

function manifestKey(snapshot: RecordSnapshot, partNumber: number) {
  return `${snapshot.objectKey}.manifest/${partNumber}`;
}

export function validateSnapshotUploadIssuedAt(value: unknown) {
  const issuedAt =
    typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
      ? Date.parse(value)
      : NaN;
  const now = Date.now();
  if (
    !Number.isFinite(issuedAt) ||
    now - issuedAt >= SNAPSHOT_UPLOAD_TTL_SECONDS * 1000 ||
    issuedAt - now > SNAPSHOT_UPLOAD_CLOCK_SKEW_MS
  )
    throw new SnapshotRegistrationError("upload_request_expired");
}

function sessionKey(uploadId: string) {
  return `${SNAPSHOT_UPLOAD_SESSION_PREFIX}${uploadId}`;
}
function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new SnapshotRegistrationError("invalid_snapshot_digest");
  return value;
}
async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
