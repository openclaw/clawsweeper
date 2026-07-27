/**
 * Client helpers for the Worker's R2-backed state blob endpoints
 * (`/internal/state/blobs/*`): the phase-3 transport for the immutable
 * `ledger/v1` tree and the mutable `assets` tree. Reuses the signed-request
 * retry machinery from worker-records.ts.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { WorkerRecordRequestError, signedPost, signedRequest } from "./worker-records.ts";

export const STATE_BLOB_TREES = ["ledger/v1", "assets"] as const;
export const STATE_BLOB_SINGLE_PUT_MAX_BYTES = 24 * 1024 * 1024;
export const STATE_BLOB_DOWNLOAD_CHUNK_BYTES = 32 * 1024 * 1024;

export type StateBlobDescriptor = {
  path: string;
  bytes: number;
  digest: string | null;
  digestVerified: boolean;
};

export class WorkerBlobsUnavailableError extends Error {
  readonly reason: "blob_store_unavailable" | "blobs_not_found";

  constructor(reason: "blob_store_unavailable" | "blobs_not_found") {
    super(reason === "blob_store_unavailable" ? "blob store unavailable" : "no state blobs found");
    this.name = "WorkerBlobsUnavailableError";
    this.reason = reason;
  }
}

type BlobRequestOptions = {
  baseUrl: string;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
};

export async function uploadStateBlob(
  options: BlobRequestOptions & {
    blobPath: string;
    content: Buffer;
    // Test seams: production callers use the defaults.
    singlePutMaxBytes?: number;
    partBytes?: number;
  },
): Promise<{ path: string; bytes: number; digest: string; unchanged: boolean; transport: string }> {
  const digest = sha256(options.content);
  const singlePutMaxBytes = options.singlePutMaxBytes ?? STATE_BLOB_SINGLE_PUT_MAX_BYTES;
  if (options.content.byteLength <= singlePutMaxBytes) {
    const response = await blobPost<{ unchanged: boolean }>(options, "put", {
      path: options.blobPath,
      digest,
      contentBase64: options.content.toString("base64"),
    });
    return {
      path: options.blobPath,
      bytes: options.content.byteLength,
      digest,
      unchanged: response.unchanged === true,
      transport: "single",
    };
  }
  const started = await blobPost<{
    unchanged: boolean;
    uploadId: string | null;
    partBytes: number;
  }>(options, "multipart/start", {
    path: options.blobPath,
    digest,
    bytes: options.content.byteLength,
  });
  if (started.unchanged === true || !started.uploadId) {
    return {
      path: options.blobPath,
      bytes: options.content.byteLength,
      digest,
      unchanged: true,
      transport: "multipart",
    };
  }
  const partBytes = options.partBytes ?? started.partBytes;
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > started.partBytes) {
    throw new Error(`Worker returned an invalid multipart part size: ${started.partBytes}`);
  }
  try {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (let offset = 0; offset < options.content.byteLength; offset += partBytes) {
      const chunk = options.content.subarray(
        offset,
        Math.min(offset + partBytes, options.content.byteLength),
      );
      const uploaded = await blobPost<{ part: { partNumber: number; etag: string } }>(
        options,
        "multipart/part",
        {
          path: options.blobPath,
          uploadId: started.uploadId,
          partNumber: parts.length + 1,
          contentBase64: Buffer.from(chunk).toString("base64"),
        },
      );
      parts.push(uploaded.part);
    }
    await blobPost(options, "multipart/complete", {
      path: options.blobPath,
      uploadId: started.uploadId,
      digest,
      bytes: options.content.byteLength,
      parts,
    });
  } catch (error) {
    await blobPost(options, "multipart/abort", {
      path: options.blobPath,
      uploadId: started.uploadId,
    }).catch(() => undefined);
    throw error;
  }
  return {
    path: options.blobPath,
    bytes: options.content.byteLength,
    digest,
    unchanged: false,
    transport: "multipart",
  };
}

export async function statStateBlob(
  options: BlobRequestOptions & { blobPath: string },
): Promise<StateBlobDescriptor | null> {
  try {
    const response = await blobPost<{ blob: StateBlobDescriptor }>(options, "stat", {
      path: options.blobPath,
    });
    return validateDescriptor(response.blob);
  } catch (error) {
    if (error instanceof WorkerRecordRequestError && error.code === "blob_not_found") return null;
    throw error;
  }
}

export async function listStateBlobs(
  options: BlobRequestOptions & { prefix: string; pageLimit?: number },
): Promise<StateBlobDescriptor[]> {
  const blobs: StateBlobDescriptor[] = [];
  let cursor: string | null = null;
  do {
    const page: { blobs: StateBlobDescriptor[]; nextCursor: string | null } = await blobPost(
      options,
      "list",
      {
        prefix: options.prefix,
        ...(cursor ? { cursor } : {}),
        ...(options.pageLimit ? { limit: options.pageLimit } : {}),
      },
    );
    if (!Array.isArray(page.blobs)) throw new Error("Worker returned an invalid blob list page");
    for (const blob of page.blobs) blobs.push(validateDescriptor(blob));
    if (page.nextCursor !== null && typeof page.nextCursor !== "string") {
      throw new Error("Worker returned an invalid blob list cursor");
    }
    if (page.nextCursor !== null && page.nextCursor === cursor) {
      throw new Error("Worker blob list cursor did not advance");
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return blobs.sort((left, right) => left.path.localeCompare(right.path));
}

export async function downloadStateBlob(
  options: BlobRequestOptions & {
    blobPath: string;
    destination: string;
    expected?: { bytes: number; digest: string | null };
  },
): Promise<{ path: string; bytes: number; digest: string }> {
  const expected = options.expected ?? (await statStateBlob(options));
  if (!expected) throw new WorkerBlobsUnavailableError("blobs_not_found");
  mkdirSync(path.dirname(options.destination), { recursive: true });
  rmSync(options.destination, { force: true });
  const descriptor = openSync(options.destination, "wx");
  const hash = createHash("sha256");
  let offset = 0;
  try {
    while (offset < expected.bytes) {
      const length = Math.min(STATE_BLOB_DOWNLOAD_CHUNK_BYTES, expected.bytes - offset);
      const response = await signedRequest({
        baseUrl: options.baseUrl,
        path: "/internal/state/blobs/chunk",
        webhookSecret: options.webhookSecret,
        body: { path: options.blobPath, offset, length },
        fetch: options.fetch,
      });
      if (!response.ok) {
        throw await blobResponseError(response);
      }
      if (response.status !== 206) {
        throw new Error(`Worker blob chunk returned status ${response.status}`);
      }
      const expectedRange = `bytes ${offset}-${offset + length - 1}/${expected.bytes}`;
      if (response.headers.get("content-range") !== expectedRange) {
        throw new Error("Worker blob chunk returned an invalid content range");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== length) {
        throw new Error(
          `Worker blob chunk length mismatch: expected ${length}, received ${bytes.byteLength}`,
        );
      }
      writeSync(descriptor, bytes);
      hash.update(bytes);
      offset += bytes.byteLength;
    }
  } finally {
    closeSync(descriptor);
  }
  const digest = hash.digest("hex");
  if (expected.digest !== null && digest !== expected.digest) {
    rmSync(options.destination, { force: true });
    throw new Error(
      `Worker blob digest mismatch for ${options.blobPath}: expected ${expected.digest}, received ${digest}`,
    );
  }
  return { path: options.blobPath, bytes: offset, digest };
}

export async function materializeStateBlobs(
  options: BlobRequestOptions & {
    worktreeRoot: string;
    trees?: readonly string[];
    cacheRoot?: string;
  },
) {
  const trees = options.trees ?? STATE_BLOB_TREES;
  mkdirSync(options.worktreeRoot, { recursive: true });
  const blobsByTree = new Map<string, StateBlobDescriptor[]>();
  let total = 0;
  for (const tree of trees) {
    const blobs = await listStateBlobs({ ...options, prefix: `${tree}/` });
    blobsByTree.set(tree, blobs);
    total += blobs.length;
  }
  // An entirely empty store means the migration has not seeded R2 yet; refuse
  // the cutover so the caller can fall back to git loudly.
  if (total === 0) throw new WorkerBlobsUnavailableError("blobs_not_found");

  const cacheRoot = options.cacheRoot
    ? path.resolve(options.cacheRoot)
    : path.join(options.worktreeRoot, ".artifacts", "worker-blobs-cache");
  mkdirSync(cacheRoot, { recursive: true });
  const stagingRoot = mkdtempSync(path.join(options.worktreeRoot, ".worker-blobs-stage-"));
  const summary = {
    blobs: total,
    bytes: 0,
    cacheHits: 0,
    downloads: 0,
    trees: Object.fromEntries([...blobsByTree].map(([tree, blobs]) => [tree, blobs.length])),
  };
  try {
    for (const [, blobs] of blobsByTree) {
      for (const blob of blobs) {
        const destination = path.join(stagingRoot, ...blob.path.split("/"));
        const cached = blob.digest ? blobCachePath(cacheRoot, blob.digest) : null;
        if (cached && existsSync(cached)) {
          mkdirSync(path.dirname(destination), { recursive: true });
          cpSync(cached, destination);
          summary.cacheHits += 1;
        } else {
          await downloadStateBlob({
            ...options,
            blobPath: blob.path,
            destination,
            expected: { bytes: blob.bytes, digest: blob.digest },
          });
          summary.downloads += 1;
          if (cached) {
            mkdirSync(path.dirname(cached), { recursive: true });
            const temporary = `${cached}.tmp-${process.pid}`;
            cpSync(destination, temporary);
            renameSync(temporary, cached);
          }
        }
        summary.bytes += blob.bytes;
      }
    }
    for (const root of new Set(trees.map((tree) => tree.split("/")[0]!))) {
      const target = path.join(options.worktreeRoot, root);
      const staged = path.join(stagingRoot, root);
      rmSync(target, { force: true, recursive: true });
      if (existsSync(staged)) renameSync(staged, target);
    }
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
  const manifestPath = path.join(options.worktreeRoot, ".artifacts", "worker-blobs-manifest.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 1, source: "worker", ...summary }, null, 2)}\n`,
    "utf8",
  );
  return { ...summary, manifestPath };
}

function blobCachePath(cacheRoot: string, digest: string) {
  return path.join(cacheRoot, digest.slice(0, 2), digest);
}

async function blobPost<T>(
  options: BlobRequestOptions,
  operation: string,
  body: unknown,
): Promise<T> {
  try {
    return await signedPost<T>({
      baseUrl: options.baseUrl,
      path: `/internal/state/blobs/${operation}`,
      webhookSecret: options.webhookSecret,
      body,
      fetch: options.fetch,
    });
  } catch (error) {
    throw mapUnavailable(error);
  }
}

async function blobResponseError(response: Response) {
  const bodyText = await response.text().catch(() => "");
  let code = String(response.status);
  try {
    const value = JSON.parse(bodyText);
    if (value && typeof value === "object" && "error" in value) code = String(value.error);
  } catch {
    // Non-JSON error body; keep the status code.
  }
  if (code === "blob_store_unavailable") {
    return new WorkerBlobsUnavailableError("blob_store_unavailable");
  }
  return new Error(`Worker blob request failed (${response.status}): ${code}`);
}

function mapUnavailable(error: unknown) {
  if (error instanceof WorkerRecordRequestError && error.code === "blob_store_unavailable") {
    return new WorkerBlobsUnavailableError("blob_store_unavailable");
  }
  return error;
}

function validateDescriptor(blob: StateBlobDescriptor): StateBlobDescriptor {
  if (
    !blob ||
    typeof blob.path !== "string" ||
    !blob.path ||
    !Number.isSafeInteger(blob.bytes) ||
    blob.bytes < 0 ||
    (blob.digest !== null && !/^[0-9a-f]{64}$/.test(blob.digest))
  ) {
    throw new Error("Worker returned an invalid blob descriptor");
  }
  return {
    path: blob.path,
    bytes: blob.bytes,
    digest: blob.digest,
    digestVerified: blob.digestVerified === true,
  };
}

function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}
