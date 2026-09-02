import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import worker from "../dashboard/worker.ts";
import { publishStateBlob } from "../dist/state-blob-client.js";
import {
  WorkerBlobsUnavailableError,
  downloadStateBlob,
  listStateBlobs,
  materializeStateBlobs,
  statStateBlob,
} from "../scripts/worker-blobs.ts";

const secret = "state-blob-secret";
const baseUrl = "https://worker.example";
const ledgerPath = "ledger/v1/events/2026/07/26/openclaw/openclaw/shard-000.jsonl";
const assetPath = "assets/social/card.svg";
const artifactContent = Buffer.from("cached bundle bytes");
const artifactPath = `artifacts/exact-review/v1/${sha256(artifactContent)}`;

test("state blob endpoints reject unsigned requests and fail closed without a bucket", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const unsigned = await worker.fetch(
    new Request(`${baseUrl}/internal/state/blobs/stat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ledgerPath }),
    }),
    env,
  );
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "invalid_signature" });

  const unknownOperation = await worker.fetch(
    signedBlobRequest("delete", { path: ledgerPath }),
    env,
  );
  assert.equal(unknownOperation.status, 404);

  const bucketless = { CLAWSWEEPER_WEBHOOK_SECRET: secret };
  const unavailable = await worker.fetch(
    signedBlobRequest("stat", { path: ledgerPath }),
    bucketless,
  );
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "blob_store_unavailable");
  await assert.rejects(
    listStateBlobs({
      baseUrl,
      webhookSecret: secret,
      prefix: "ledger/v1/",
      fetch: viaWorker(bucketless),
    }),
    (error: unknown) =>
      error instanceof WorkerBlobsUnavailableError && error.reason === "blob_store_unavailable",
  );
});

test("state blob failures return stable errors and sanitize server logs", async () => {
  const sensitive = "secret-state-token";
  const bearerCredential = ["bearer", "credential", "value"].join("-");
  const bucket = new FakeR2Bucket();
  bucket.head = async () => {
    throw new Error(
      `R2 request failed at https://operator:${sensitive}@storage.example/object?token=${sensitive}; Authorization: Bearer ${bearerCredential}`,
    );
  };
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => errors.push(values.join(" "));
  try {
    const response = await worker.fetch(signedBlobRequest("stat", { path: ledgerPath }), {
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      STATE_SNAPSHOTS: bucket,
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "blob_store_unavailable" });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, ["state_blob_request_failed"]);
  assert.doesNotMatch(errors.join("\n"), new RegExp(sensitive));
  assert.doesNotMatch(errors.join("\n"), new RegExp(bearerCredential));
});

test("state blob upload rejection logs omit path, upload, URL, query, and error identity", async () => {
  const marker =
    "synthetic-upload-title-at-https://privacy.invalid/private-path?query=private-marker";
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
  try {
    const response = await worker.fetch(
      signedBlobRequest("multipart/part", {
        path: "assets/private-repository/private-item.svg",
        uploadId: marker,
        partNumber: 1,
        contentBase64: Buffer.from("synthetic upload bytes").toString("base64"),
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        STATE_SNAPSHOTS: new FakeR2Bucket(),
      },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_blob_upload" });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, ["state_blob_upload_rejected"]);
  assert.doesNotMatch(
    warnings.join("\n"),
    /synthetic-upload-title|privacy\.invalid|private-marker/,
  );
});

test("single-shot blob uploads verify digests server-side and re-put idempotently", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const options = { baseUrl, webhookSecret: secret, fetch: viaWorker(env) };
  const content = Buffer.from('{"event":"opened"}\n');

  const upload = {
    baseUrl,
    webhookSecret: secret,
    fetchImpl: options.fetch,
    path: ledgerPath,
    content,
  };
  const uploaded = await publishStateBlob(upload);
  assert.deepEqual(uploaded, {
    path: ledgerPath,
    bytes: content.byteLength,
    digest: sha256(content),
    unchanged: false,
  });
  const repeat = await publishStateBlob(upload);
  assert.equal(repeat.unchanged, true);

  const stat = await statStateBlob({ ...options, blobPath: ledgerPath });
  assert.deepEqual(stat, {
    path: ledgerPath,
    bytes: content.byteLength,
    digest: sha256(content),
    digestVerified: true,
  });
  assert.equal(await statStateBlob({ ...options, blobPath: "ledger/v1/missing.jsonl" }), null);

  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-blob-download-"));
  try {
    const destination = path.join(root, "downloaded.jsonl");
    const downloaded = await downloadStateBlob({ ...options, blobPath: ledgerPath, destination });
    assert.equal(downloaded.digest, sha256(content));
    assert.equal(readFileSync(destination, "utf8"), content.toString("utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const corrupted = await worker.fetch(
    signedBlobRequest("put", {
      path: ledgerPath,
      digest: "0".repeat(64),
      contentBase64: content.toString("base64"),
    }),
    env,
  );
  assert.equal(corrupted.status, 400);
  assert.equal((await corrupted.json()).error, "blob_digest_mismatch");

  const badPath = await worker.fetch(
    signedBlobRequest("put", {
      path: "records/openclaw-openclaw/items/1.md",
      digest: sha256(content),
      contentBase64: content.toString("base64"),
    }),
    env,
  );
  assert.equal(badPath.status, 400);
  assert.equal((await badPath.json()).error, "invalid_blob_path");

  const traversal = await worker.fetch(
    signedBlobRequest("put", {
      path: "ledger/v1/../../records/escape.md",
      digest: sha256(content),
      contentBase64: content.toString("base64"),
    }),
    env,
  );
  assert.equal(traversal.status, 400);
});

test("state blob publication retries aborted attempts without reporting success", async (t) => {
  const signals: AbortSignal[] = [];
  t.mock.method(AbortSignal, "timeout", () => {
    const signal = AbortSignal.abort(new DOMException("request timed out", "TimeoutError"));
    signals.push(signal);
    return signal;
  });
  let attempts = 0;
  await assert.rejects(
    publishStateBlob({
      baseUrl,
      webhookSecret: secret,
      path: ledgerPath,
      content: Buffer.from("synthetic publication\n"),
      fetchImpl: async (_input, init) => {
        attempts += 1;
        init?.signal?.throwIfAborted();
        return Response.json({ unchanged: false });
      },
    }),
    /request timed out/,
  );
  assert.equal(attempts, 4);
  assert.equal(new Set(signals).size, 4, "each retry needs its own deadline");
});

test("ledger keys are create-only while asset keys may overwrite", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const options = { baseUrl, webhookSecret: secret, fetch: viaWorker(env) };

  await putBlob(env, ledgerPath, Buffer.from("immutable\n"));
  const conflict = await worker.fetch(
    signedBlobRequest("put", {
      path: ledgerPath,
      digest: sha256(Buffer.from("different\n")),
      contentBase64: Buffer.from("different\n").toString("base64"),
    }),
    env,
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "ledger_blob_immutable_conflict");
  const kept = await statStateBlob({ ...options, blobPath: ledgerPath });
  assert.equal(kept?.digest, sha256(Buffer.from("immutable\n")));

  await putBlob(env, assetPath, Buffer.from("<svg one/>"));
  const replaced = await putBlob(env, assetPath, Buffer.from("<svg two/>"));
  assert.equal(replaced.unchanged, false);
  const stat = await statStateBlob({ ...options, blobPath: assetPath });
  assert.equal(stat?.digest, sha256(Buffer.from("<svg two/>")));

  const artifact = artifactContent;
  await putBlob(env, artifactPath, artifact);
  const artifactConflict = await worker.fetch(
    signedBlobRequest("put", {
      path: artifactPath,
      digest: sha256(Buffer.from("different cached bytes")),
      contentBase64: Buffer.from("different cached bytes").toString("base64"),
    }),
    env,
  );
  assert.equal(artifactConflict.status, 400);
  assert.equal((await artifactConflict.json()).error, "artifact_blob_key_digest_mismatch");

  for (const malformed of [
    "artifacts/exact-review/v1/not-a-digest",
    `artifacts/exact-review/v1/${"b".repeat(64)}/nested`,
    `artifacts/exact-review/v1/${"C".repeat(64)}`,
  ]) {
    const rejected = await worker.fetch(
      signedBlobRequest("put", {
        path: malformed,
        digest: sha256(artifact),
        contentBase64: artifact.toString("base64"),
      }),
      env,
    );
    assert.equal(rejected.status, 400, malformed);
    assert.equal((await rejected.json()).error, "invalid_blob_path", malformed);
  }

  const mismatchedKey = `artifacts/exact-review/v1/${"b".repeat(64)}`;
  const mismatchedDirect = await worker.fetch(
    signedBlobRequest("put", {
      path: mismatchedKey,
      digest: sha256(artifact),
      contentBase64: artifact.toString("base64"),
    }),
    env,
  );
  assert.equal(mismatchedDirect.status, 400);
  assert.equal((await mismatchedDirect.json()).error, "artifact_blob_key_digest_mismatch");

  const mismatchedStart = await worker.fetch(
    signedBlobRequest("multipart/start", {
      path: mismatchedKey,
      digest: sha256(artifact),
      bytes: artifact.byteLength,
    }),
    env,
  );
  assert.equal(mismatchedStart.status, 400);
  assert.equal((await mismatchedStart.json()).error, "artifact_blob_key_digest_mismatch");
});

test("multipart uploads stream fixed-size parts and enforce immutability at completion", async () => {
  const bucket = new FakeR2Bucket();
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: bucket };
  const options = { baseUrl, webhookSecret: secret, fetch: viaWorker(env) };
  const content = Buffer.from("0123456789abcdefghij");

  const started = await signedJson(
    env,
    "multipart/start",
    { path: assetPath, digest: sha256(content), bytes: content.byteLength },
    201,
  );
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (let offset = 0; offset < content.byteLength; offset += 6) {
    const uploaded = await signedJson(env, "multipart/part", {
      path: assetPath,
      uploadId: started.uploadId,
      partNumber: parts.length + 1,
      contentBase64: content.subarray(offset, offset + 6).toString("base64"),
    });
    parts.push(uploaded.part);
  }
  const completed = await signedJson(
    env,
    "multipart/complete",
    {
      path: assetPath,
      uploadId: started.uploadId,
      digest: sha256(content),
      bytes: content.byteLength,
      parts,
    },
    201,
  );
  assert.equal(completed.unchanged, false);
  assert.equal(bucket.uploads.size, 0);

  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-blob-multipart-"));
  try {
    const destination = path.join(root, "multipart.bin");
    const downloaded = await downloadStateBlob({ ...options, blobPath: assetPath, destination });
    assert.equal(downloaded.digest, sha256(content));
    assert.equal(readFileSync(destination).toString("utf8"), content.toString("utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const repeat = await signedJson(env, "multipart/start", {
    path: assetPath,
    digest: sha256(content),
    bytes: content.byteLength,
  });
  assert.equal(repeat.unchanged, true);

  // A concurrent single-shot writer lands the immutable key between
  // multipart/start and multipart/complete: completion must refuse and abort.
  const ledgerKey = "ledger/v1/import-bindings/events/race.json";
  const raceContent = Buffer.from("multipart-body-that-loses-the-race");
  const raceStarted = await signedJson(
    env,
    "multipart/start",
    { path: ledgerKey, digest: sha256(raceContent), bytes: raceContent.byteLength },
    201,
  );
  const part = await signedJson(env, "multipart/part", {
    path: ledgerKey,
    uploadId: raceStarted.uploadId,
    partNumber: 1,
    contentBase64: raceContent.toString("base64"),
  });
  await putBlob(env, ledgerKey, Buffer.from("winner\n"));
  const conflicted = await worker.fetch(
    signedBlobRequest("multipart/complete", {
      path: ledgerKey,
      uploadId: raceStarted.uploadId,
      digest: sha256(raceContent),
      bytes: raceContent.byteLength,
      parts: [part.part],
    }),
    env,
  );
  assert.equal(conflicted.status, 409);
  assert.equal((await conflicted.json()).error, "ledger_blob_immutable_conflict");
  assert.equal(bucket.uploads.size, 0);
  const winner = await statStateBlob({ ...options, blobPath: ledgerKey });
  assert.equal(winner?.digest, sha256(Buffer.from("winner\n")));

  const staleUpload = await worker.fetch(
    signedBlobRequest("multipart/part", {
      path: assetPath,
      uploadId: "upload-does-not-exist",
      partNumber: 1,
      contentBase64: content.toString("base64"),
    }),
    env,
  );
  assert.equal(staleUpload.status, 400);
  assert.equal((await staleUpload.json()).error, "invalid_blob_upload");

  const artifactContent = Buffer.from("multipart artifact bytes");
  const artifactDigest = sha256(artifactContent);
  const artifactKey = `artifacts/exact-review/v1/${artifactDigest}`;
  const artifactStarted = await signedJson(
    env,
    "multipart/start",
    { path: artifactKey, digest: artifactDigest, bytes: artifactContent.byteLength },
    201,
  );
  const artifactPart = await signedJson(env, "multipart/part", {
    path: artifactKey,
    uploadId: artifactStarted.uploadId,
    partNumber: 1,
    contentBase64: artifactContent.toString("base64"),
  });
  const mismatchedComplete = await worker.fetch(
    signedBlobRequest("multipart/complete", {
      path: artifactKey,
      uploadId: artifactStarted.uploadId,
      digest: "c".repeat(64),
      bytes: artifactContent.byteLength,
      parts: [artifactPart.part],
    }),
    env,
  );
  assert.equal(mismatchedComplete.status, 400);
  assert.equal((await mismatchedComplete.json()).error, "artifact_blob_key_digest_mismatch");
  await signedJson(env, "multipart/abort", {
    path: artifactKey,
    uploadId: artifactStarted.uploadId,
  });
});

test("chunked downloads retry transient 5xx responses and reject invalid ranges", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const workerFetch = viaWorker(env);
  const content = Buffer.from("retryable ledger shard\n");
  await putBlob(env, ledgerPath, content);

  let failuresLeft = 2;
  const flaky: typeof globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/internal/state/blobs/chunk") && failuresLeft > 0) {
      failuresLeft -= 1;
      return new Response("edge 502", { status: 502 });
    }
    return workerFetch(input, init);
  };
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-blob-retry-"));
  try {
    const downloaded = await downloadStateBlob({
      baseUrl,
      webhookSecret: secret,
      fetch: flaky,
      blobPath: ledgerPath,
      destination: path.join(root, "retried.jsonl"),
    });
    assert.equal(downloaded.digest, sha256(content));
    assert.equal(failuresLeft, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const pastEnd = await worker.fetch(
    signedBlobRequest("chunk", { path: ledgerPath, offset: content.byteLength, length: 1 }),
    env,
  );
  assert.equal(pastEnd.status, 416);
  const zeroLength = await worker.fetch(
    signedBlobRequest("chunk", { path: ledgerPath, offset: 0, length: 0 }),
    env,
  );
  assert.equal(zeroLength.status, 400);
});

test("blob listing pages with cursors and validates prefixes", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const options = { baseUrl, webhookSecret: secret, fetch: viaWorker(env) };
  const paths = [
    "ledger/v1/events/2026/07/26/openclaw/openclaw/a.jsonl",
    "ledger/v1/events/2026/07/26/openclaw/openclaw/b.jsonl",
    "ledger/v1/import-bindings/events/c.json",
  ];
  for (const blobPath of paths) {
    await putBlob(env, blobPath, Buffer.from(blobPath));
  }
  await putBlob(env, assetPath, Buffer.from("asset"));

  const listed = await listStateBlobs({ ...options, prefix: "ledger/v1/", pageLimit: 1 });
  assert.deepEqual(
    listed.map((blob) => blob.path),
    paths,
  );
  const assets = await listStateBlobs({ ...options, prefix: "assets" });
  assert.deepEqual(
    assets.map((blob) => blob.path),
    [assetPath],
  );

  const invalidPrefix = await worker.fetch(signedBlobRequest("list", { prefix: "records/" }), env);
  assert.equal(invalidPrefix.status, 400);
  assert.equal((await invalidPrefix.json()).error, "invalid_blob_prefix");
});

test("materialize refuses partial trees only when the whole store is empty", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const options = { baseUrl, webhookSecret: secret, fetch: viaWorker(env) };
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-blob-partial-"));
  try {
    // Assets seeded, ledger empty: the store is live, so materialize proceeds
    // and produces only the assets tree.
    await putBlob(env, assetPath, Buffer.from("asset"));
    const summary = await materializeStateBlobs({ ...options, worktreeRoot: root });
    assert.deepEqual(summary.trees, { "ledger/v1": 0, assets: 1 });
    assert.equal(readFileSync(path.join(root, assetPath), "utf8"), "asset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function viaWorker(env: Record<string, unknown>): typeof globalThis.fetch {
  return async (input, init) => worker.fetch(new Request(String(input), init), env);
}

function signedBlobRequest(operation: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return new Request(`${baseUrl}/internal/state/blobs/${operation}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
}

async function putBlob(env: Record<string, unknown>, blobPath: string, content: Buffer) {
  const response = await worker.fetch(
    signedBlobRequest("put", {
      path: blobPath,
      digest: sha256(content),
      contentBase64: content.toString("base64"),
    }),
    env,
  );
  assert.ok(response.status === 200 || response.status === 201);
  return response.json();
}

async function signedJson(
  env: Record<string, unknown>,
  operation: string,
  payload: unknown,
  expectedStatus = 200,
) {
  const response = await worker.fetch(signedBlobRequest(operation, payload), env);
  assert.equal(response.status, expectedStatus);
  return response.json();
}

function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

class FakeR2Bucket {
  readonly objects = new Map<
    string,
    { bytes: Uint8Array; customMetadata: Record<string, string> }
  >();
  readonly uploads = new Map<
    string,
    { key: string; parts: Map<number, Uint8Array>; customMetadata: Record<string, string> }
  >();
  private uploadCounter = 0;

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? describe(key, object) : null;
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const object = this.objects.get(key);
    if (!object) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? object.bytes.byteLength - offset;
    const body = new Response(object.bytes.slice(offset, offset + length)).body;
    assert.ok(body);
    return { ...describe(key, object), body };
  }

  async put(key: string, value: Uint8Array, options?: { customMetadata?: Record<string, string> }) {
    this.objects.set(key, {
      bytes: new Uint8Array(value).slice(),
      customMetadata: options?.customMetadata ?? {},
    });
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const page = keys.slice(start, start + limit);
    const truncated = start + page.length < keys.length;
    return {
      objects: page.map((key) => describe(key, this.objects.get(key)!)),
      truncated,
      ...(truncated ? { cursor: String(start + page.length) } : {}),
    };
  }

  async createMultipartUpload(key: string, options?: { customMetadata?: Record<string, string> }) {
    this.uploadCounter += 1;
    const uploadId = `upload-${this.uploadCounter}`;
    this.uploads.set(uploadId, {
      key,
      parts: new Map(),
      customMetadata: options?.customMetadata ?? {},
    });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const requireUpload = () => {
      const upload = this.uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error(`unknown multipart upload: ${uploadId}`);
      return upload;
    };
    return {
      uploadId,
      uploadPart: async (partNumber: number, value: Uint8Array) => {
        requireUpload().parts.set(partNumber, new Uint8Array(value).slice());
        return { partNumber, etag: `etag-${uploadId}-${partNumber}` };
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        const upload = requireUpload();
        const selected = parts.map((part) => {
          const bytes = upload.parts.get(part.partNumber);
          if (!bytes || `etag-${uploadId}-${part.partNumber}` !== part.etag) {
            throw new Error(`missing multipart part: ${part.partNumber}`);
          }
          return bytes;
        });
        const total = new Uint8Array(selected.reduce((sum, part) => sum + part.byteLength, 0));
        let offset = 0;
        for (const part of selected) {
          total.set(part, offset);
          offset += part.byteLength;
        }
        this.objects.set(key, { bytes: total, customMetadata: upload.customMetadata });
        this.uploads.delete(uploadId);
        return { key, size: total.byteLength };
      },
      abort: async () => {
        this.uploads.delete(uploadId);
      },
    };
  }
}

function describe(
  key: string,
  object: { bytes: Uint8Array; customMetadata: Record<string, string> },
) {
  return { key, size: object.bytes.byteLength, customMetadata: object.customMetadata };
}
