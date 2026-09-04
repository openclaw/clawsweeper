import {
  RECORD_SNAPSHOT_UPLOAD_MAX_BYTES,
  SNAPSHOT_UPLOAD_PART_BYTES,
} from "../src/record-snapshot-protocol.ts";
import {
  SnapshotRegistrationError,
  validateSnapshotRegistration,
  type RecordSnapshot,
} from "./record-snapshots.ts";

export const SNAPSHOT_UPLOAD_MAX_PARTS = 200;
export const SNAPSHOT_UPLOAD_TTL_SECONDS = 3600;
export const SNAPSHOT_UPLOAD_JSON_MAX_BYTES = (SNAPSHOT_UPLOAD_PART_BYTES / 3) * 4 + 16 * 1024;
export const SNAPSHOT_UPLOAD_OPERATIONS = ["start", "part", "complete", "abort"] as const;
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
  register: (snapshot: RecordSnapshot) => Promise<Response>,
): Promise<Response> {
  const bucket = bucketBinding as Bucket | undefined;
  if (!bucket?.createMultipartUpload || !bucket.resumeMultipartUpload || !bucket.head)
    return Response.json({ error: "snapshot_store_unavailable" }, { status: 503 });
  try {
    if (operation === "start") {
      if (typeof body.bytes === "number" && body.bytes > RECORD_SNAPSHOT_UPLOAD_MAX_BYTES)
        throw new SnapshotRegistrationError("snapshot_too_large", 413);
      const sha256 = requireDigest(body.sha256);
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
        expiresAt: createdAt + SNAPSHOT_UPLOAD_TTL_SECONDS * 1000,
      };
      try {
        await store.write(
          sessionKey(uploadId),
          JSON.stringify(session),
          SNAPSHOT_UPLOAD_TTL_SECONDS,
        );
      } catch (error) {
        await upload.abort().catch(() => undefined);
        throw error;
      }
      return Response.json(
        {
          ok: true,
          uploadId,
          objectKey,
          partBytes: SNAPSHOT_UPLOAD_PART_BYTES,
          expiresAt: session.expiresAt,
        },
        { status: 201 },
      );
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
    if (operation === "abort") {
      // A completion response may have been lost after registration. Never delete
      // a completed object here: the descriptor's pruning owns its lifetime.
      if (!(await bucket.head(snapshot.objectKey))) await upload.abort();
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
    return await register(snapshot);
  } catch (error) {
    if (error instanceof SnapshotRegistrationError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error("snapshot_upload_unavailable");
    return Response.json({ error: "snapshot_upload_unavailable" }, { status: 503 });
  }
}

function sessionKey(uploadId: string) {
  return `record-snapshot-upload/${uploadId}`;
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
