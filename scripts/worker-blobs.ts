/**
 * Client helpers for the Worker's R2-backed state blob endpoints
 * (`/internal/state/blobs/*`): the phase-3 transport for the immutable
 * `ledger/v1` tree and the mutable `assets` tree. Reuses the signed-request
 * retry machinery from worker-records.ts.
 */
import { verifyHydratedActionEventImports } from "../src/action-ledger-import.ts";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { WorkerRecordRequestError, signedPost, signedRequest } from "./worker-records.ts";

export const STATE_BLOB_TREES = ["ledger/v1", "assets"] as const;
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

export async function* listStateBlobs(
  options: BlobRequestOptions & { prefix: string; pageLimit?: number },
): AsyncGenerator<StateBlobDescriptor> {
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
    if (page.nextCursor !== null && typeof page.nextCursor !== "string") {
      throw new Error("Worker returned an invalid blob list cursor");
    }
    if (page.nextCursor !== null && page.nextCursor === cursor) {
      throw new Error("Worker blob list cursor did not advance");
    }
    cursor = page.nextCursor;
    // Consume one page before requesting another: immutable ledger prefixes can
    // contain millions of objects, so a full-prefix descriptor array is unbounded.
    for (const blob of page.blobs) yield validateDescriptor(blob);
  } while (cursor !== null);
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
  const cacheRoot = options.cacheRoot
    ? path.resolve(options.cacheRoot)
    : path.join(options.worktreeRoot, ".artifacts", "worker-blobs-cache");
  mkdirSync(cacheRoot, { recursive: true });
  const stagingRoot = realpathSync(
    mkdtempSync(path.join(options.worktreeRoot, ".worker-blobs-stage-")),
  );
  const summary = {
    blobs: 0,
    bytes: 0,
    cacheHits: 0,
    downloads: 0,
    omittedProducers: 0,
    omittedPayloads: 0,
    omittedBytes: 0,
    closureBlobs: 0,
    materializedBlobs: 0,
    materializedBytes: 0,
    omittedProducerExamples: [] as string[],
    trees: Object.fromEntries(trees.map((tree) => [tree, 0])),
  };
  try {
    for (const tree of Object.keys(summary.trees)) {
      for await (const blob of listStateBlobs({ ...options, prefix: `${tree}/` })) {
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
        summary.blobs += 1;
        summary.trees[tree]! += 1;
        summary.bytes += blob.bytes;
      }
    }
    // Keep the existing trees until every page and download succeeds. An empty
    // store still refuses cutover rather than replacing local state with nothing.
    if (summary.blobs === 0) throw new WorkerBlobsUnavailableError("blobs_not_found");
    const omissions = await verifyHydratedActionEventImports(stagingRoot, async (blobPath) => {
      const blob = await statStateBlob({ ...options, blobPath });
      if (!blob) return false;
      await downloadStateBlob({
        ...options,
        blobPath,
        destination: path.join(stagingRoot, blobPath),
        expected: blob,
      });
      summary.downloads += 1;
      summary.closureBlobs += 1;
      summary.blobs += 1;
      summary.bytes += blob.bytes;
      return true;
    });
    Object.assign(summary, omissions);
    summary.materializedBlobs = summary.blobs - summary.omittedPayloads;
    summary.materializedBytes = summary.bytes - summary.omittedBytes;
    if (omissions.omittedProducers > 0)
      console.warn(
        `[action-ledger] omitted ${omissions.omittedPayloads} uncommitted payloads from ${omissions.omittedProducers} producers; retained remote objects and bindings (${omissions.omittedProducerExamples.join(", ")}). Retry hydration after publication completes.`,
      );
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
