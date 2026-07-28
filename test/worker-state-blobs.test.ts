import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import worker from "../dashboard/worker.ts";
import { hydrateState } from "../scripts/hydrate-state.ts";
import { migrateStateBlobs } from "../scripts/migrate-state-blobs.ts";
import {
  WorkerBlobsUnavailableError,
  downloadStateBlob,
  listStateBlobs,
  materializeStateBlobs,
  statStateBlob,
  uploadStateBlob,
} from "../scripts/worker-blobs.ts";

const secret = "state-blob-secret";
const baseUrl = "https://worker.example";
const ledgerPath = "ledger/v1/events/2026/07/26/openclaw/openclaw/shard-000.jsonl";
const assetPath = "assets/social/card.svg";

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
  const bucket = new FakeR2Bucket();
  bucket.head = async () => {
    throw new Error(
      `R2 request failed at https://operator:${sensitive}@storage.example/object?token=${sensitive}`,
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
  assert.doesNotMatch(errors.join("\n"), new RegExp(sensitive));
  assert.match(errors.join("\n"), /https:\/\/\[REDACTED\]@storage\.example/);
  assert.match(errors.join("\n"), /token=\[REDACTED\]/);
});

test("single-shot blob uploads verify digests server-side and re-put idempotently", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const options = { baseUrl, webhookSecret: secret, fetch: viaWorker(env) };
  const content = Buffer.from('{"event":"opened"}\n');

  const uploaded = await uploadStateBlob({ ...options, blobPath: ledgerPath, content });
  assert.deepEqual(uploaded, {
    path: ledgerPath,
    bytes: content.byteLength,
    digest: sha256(content),
    unchanged: false,
    transport: "single",
  });
  const repeat = await uploadStateBlob({ ...options, blobPath: ledgerPath, content });
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

test("ledger keys are create-only while asset keys may overwrite", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const options = { baseUrl, webhookSecret: secret, fetch: viaWorker(env) };

  await uploadStateBlob({ ...options, blobPath: ledgerPath, content: Buffer.from("immutable\n") });
  await assert.rejects(
    uploadStateBlob({ ...options, blobPath: ledgerPath, content: Buffer.from("different\n") }),
    /ledger_blob_immutable_conflict/,
  );
  const kept = await statStateBlob({ ...options, blobPath: ledgerPath });
  assert.equal(kept?.digest, sha256(Buffer.from("immutable\n")));

  await uploadStateBlob({ ...options, blobPath: assetPath, content: Buffer.from("<svg one/>") });
  const replaced = await uploadStateBlob({
    ...options,
    blobPath: assetPath,
    content: Buffer.from("<svg two/>"),
  });
  assert.equal(replaced.unchanged, false);
  const stat = await statStateBlob({ ...options, blobPath: assetPath });
  assert.equal(stat?.digest, sha256(Buffer.from("<svg two/>")));
});

test("multipart uploads stream fixed-size parts and enforce immutability at completion", async () => {
  const bucket = new FakeR2Bucket();
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: bucket };
  const options = { baseUrl, webhookSecret: secret, fetch: viaWorker(env) };
  const content = Buffer.from("0123456789abcdefghij");

  const uploaded = await uploadStateBlob({
    ...options,
    blobPath: assetPath,
    content,
    singlePutMaxBytes: 8,
    partBytes: 6,
  });
  assert.equal(uploaded.transport, "multipart");
  assert.equal(uploaded.unchanged, false);
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

  const repeat = await uploadStateBlob({
    ...options,
    blobPath: assetPath,
    content,
    singlePutMaxBytes: 8,
    partBytes: 6,
  });
  assert.equal(repeat.unchanged, true);

  // A concurrent single-shot writer lands the immutable key between
  // multipart/start and multipart/complete: completion must refuse and abort.
  const ledgerKey = "ledger/v1/import-bindings/events/race.json";
  const raceContent = Buffer.from("multipart-body-that-loses-the-race");
  const started = await signedJson(
    env,
    "multipart/start",
    { path: ledgerKey, digest: sha256(raceContent), bytes: raceContent.byteLength },
    201,
  );
  const part = await signedJson(env, "multipart/part", {
    path: ledgerKey,
    uploadId: started.uploadId,
    partNumber: 1,
    contentBase64: raceContent.toString("base64"),
  });
  await uploadStateBlob({ ...options, blobPath: ledgerKey, content: Buffer.from("winner\n") });
  const conflicted = await worker.fetch(
    signedBlobRequest("multipart/complete", {
      path: ledgerKey,
      uploadId: started.uploadId,
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
});

test("chunked downloads retry transient 5xx responses and reject invalid ranges", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const workerFetch = viaWorker(env);
  const options = { baseUrl, webhookSecret: secret, fetch: workerFetch };
  const content = Buffer.from("retryable ledger shard\n");
  await uploadStateBlob({ ...options, blobPath: ledgerPath, content });

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
    await uploadStateBlob({ ...options, blobPath, content: Buffer.from(blobPath) });
  }
  await uploadStateBlob({ ...options, blobPath: assetPath, content: Buffer.from("asset") });

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

test("state blob migration is cursor-resumable, idempotent, and loud on ledger divergence", async () => {
  const fixture = createStateFixture();
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const fetchImpl = viaWorker(env);
  const processEnv = { CLAWSWEEPER_WEBHOOK_SECRET: secret, CLAWSWEEPER_RECORDS_URL: baseUrl };
  const migrate = (argv: string[]) =>
    migrateStateBlobs(["--state-dir", fixture.stateRoot, ...argv], processEnv, fetchImpl);
  try {
    const bounded = await migrate(["--max-files", "1"]);
    assert.equal(bounded.attempted, 1);
    assert.equal(bounded.uploaded, 1);
    assert.equal(bounded.nextCursor, 1);

    const resumed = await migrate(["--cursor", "1"]);
    assert.equal(resumed.uploaded, fixture.blobFiles.length - 1);
    assert.equal(resumed.nextCursor, null);

    const repeat = await migrate([]);
    assert.equal(repeat.uploaded, 0);
    assert.equal(repeat.unchanged, fixture.blobFiles.length);
    assert.equal(repeat.files, fixture.blobFiles.length);

    const options = { baseUrl, webhookSecret: secret, fetch: fetchImpl };
    for (const blobPath of fixture.blobFiles) {
      const stat = await statStateBlob({ ...options, blobPath });
      assert.equal(stat?.digest, sha256(readFileSync(path.join(fixture.stateRoot, blobPath))));
    }

    writeFileSync(
      path.join(fixture.stateRoot, fixture.ledgerFiles[0]!),
      "locally rewritten history\n",
      "utf8",
    );
    await assert.rejects(migrate([]), /ledger_blob_immutable_conflict/);

    await assert.rejects(migrate(["--trees", "ledger"]), /Unknown state blob tree/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hydrate-state defaults ledger hydration to git and never calls the worker", async () => {
  const fixture = createStateFixture();
  const target = path.join(fixture.root, "git-target");
  try {
    const result = await hydrateState(
      ["--state-dir", fixture.stateRoot, "--worktree", target],
      {},
      async () => {
        throw new Error("unexpected worker fetch in git mode");
      },
    );
    assert.equal(result.ledgerSource, "git");
    assert.equal(result.recordsSource, "git");
    for (const blobPath of fixture.blobFiles) {
      assert.equal(
        readFileSync(path.join(target, blobPath), "utf8"),
        readFileSync(path.join(fixture.stateRoot, blobPath), "utf8"),
      );
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hydrate-state CLAWSWEEPER_LEDGER_SOURCE=worker materializes ledger/assets from R2 with a warm cache", async () => {
  const fixture = createStateFixture();
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const fetchImpl = viaWorker(env);
  const options = { baseUrl, webhookSecret: secret, fetch: fetchImpl };
  const cacheRoot = path.join(fixture.root, "blob-cache");
  try {
    // Seed the worker store with content that differs from the git checkout to
    // prove which source the hydrator used.
    for (const blobPath of fixture.blobFiles) {
      await uploadStateBlob({
        ...options,
        blobPath,
        content: Buffer.from(`worker:${blobPath}\n`),
      });
    }
    const coldTarget = path.join(fixture.root, "worker-cold");
    const cold = await hydrateState(
      ["--state-dir", fixture.stateRoot, "--worktree", coldTarget, "--records-url", baseUrl],
      {
        CLAWSWEEPER_LEDGER_SOURCE: "worker",
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        CLAWSWEEPER_BLOBS_CACHE_DIR: cacheRoot,
      },
      fetchImpl,
    );
    assert.equal(cold.ledgerSource, "worker");
    assert.equal(cold.blobs?.blobs, fixture.blobFiles.length);
    assert.equal(cold.blobs?.downloads, fixture.blobFiles.length);
    assert.ok(cold.hydrated.includes("ledger"));
    for (const blobPath of fixture.blobFiles) {
      assert.equal(readFileSync(path.join(coldTarget, blobPath), "utf8"), `worker:${blobPath}\n`);
    }
    assert.equal(readFileSync(path.join(coldTarget, "jobs", "fixture.json"), "utf8"), "{}\n");
    const manifest = JSON.parse(
      readFileSync(path.join(coldTarget, ".artifacts", "worker-blobs-manifest.json"), "utf8"),
    );
    assert.equal(manifest.source, "worker");

    const warmTarget = path.join(fixture.root, "worker-warm");
    const warm = await hydrateState(
      ["--state-dir", fixture.stateRoot, "--worktree", warmTarget, "--records-url", baseUrl],
      {
        CLAWSWEEPER_LEDGER_SOURCE: "worker",
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        CLAWSWEEPER_BLOBS_CACHE_DIR: cacheRoot,
      },
      fetchImpl,
    );
    assert.equal(warm.blobs?.cacheHits, fixture.blobFiles.length);
    assert.equal(warm.blobs?.downloads, 0);

    await assert.rejects(
      hydrateState(
        ["--state-dir", fixture.stateRoot, "--worktree", path.join(fixture.root, "no-secret")],
        { CLAWSWEEPER_LEDGER_SOURCE: "worker" },
        fetchImpl,
      ),
      /CLAWSWEEPER_RECORDS_SECRET is required for Worker ledger hydration/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hydrate-state refuses the ledger cutover loudly and falls back to git", async () => {
  const fixture = createStateFixture();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => errors.push(values.join(" "));
  try {
    // Bucket bound but empty: migration has not seeded R2 yet.
    const emptyEnv = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
    const target = path.join(fixture.root, "fallback-target");
    const result = await hydrateState(
      ["--state-dir", fixture.stateRoot, "--worktree", target, "--records-url", baseUrl],
      { CLAWSWEEPER_LEDGER_SOURCE: "worker", CLAWSWEEPER_WEBHOOK_SECRET: secret },
      viaWorker(emptyEnv),
    );
    assert.equal(result.ledgerSource, "git");
    assert.equal(result.requestedLedgerSource, "worker");
    assert.equal(result.ledgerFallback?.reason, "blobs_not_found");
    assert.match(errors.join("\n"), /WORKER LEDGER CUTOVER REFUSED.*FALLING BACK TO GIT/);
    for (const blobPath of fixture.blobFiles) {
      assert.equal(
        readFileSync(path.join(target, blobPath), "utf8"),
        readFileSync(path.join(fixture.stateRoot, blobPath), "utf8"),
      );
    }

    const bucketlessTarget = path.join(fixture.root, "bucketless-target");
    const bucketless = await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        bucketlessTarget,
        "--records-url",
        baseUrl,
        "--ledger-source",
        "worker",
      ],
      { CLAWSWEEPER_WEBHOOK_SECRET: secret },
      viaWorker({ CLAWSWEEPER_WEBHOOK_SECRET: secret }),
    );
    assert.equal(bucketless.ledgerFallback?.reason, "blob_store_unavailable");
  } finally {
    console.error = originalError;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("materialize refuses partial trees only when the whole store is empty", async () => {
  const env = { CLAWSWEEPER_WEBHOOK_SECRET: secret, STATE_SNAPSHOTS: new FakeR2Bucket() };
  const options = { baseUrl, webhookSecret: secret, fetch: viaWorker(env) };
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-blob-partial-"));
  try {
    // Assets seeded, ledger empty: the store is live, so materialize proceeds
    // and produces only the assets tree.
    await uploadStateBlob({ ...options, blobPath: assetPath, content: Buffer.from("asset") });
    const summary = await materializeStateBlobs({ ...options, worktreeRoot: root });
    assert.deepEqual(summary.trees, { "ledger/v1": 0, assets: 1 });
    assert.equal(readFileSync(path.join(root, assetPath), "utf8"), "asset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createStateFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-state-blobs-test-"));
  const stateRoot = path.join(root, "state");
  const ledgerFiles = [
    "ledger/v1/events/2026/07/25/openclaw/openclaw/shard-000.jsonl",
    "ledger/v1/import-bindings/producer-runs/" + "a".repeat(64) + ".json",
  ];
  const assetFiles = ["assets/social/card.svg", "assets/dashboards/summary.json"];
  for (const file of [...ledgerFiles, ...assetFiles]) {
    write(path.join(stateRoot, ...file.split("/")), `git:${file}\n`);
  }
  write(path.join(stateRoot, "jobs", "fixture.json"), "{}\n");
  write(
    path.join(stateRoot, "records", "openclaw-openclaw", "items", "1.md"),
    "---\nnumber: 1\n---\nrecord\n",
  );
  return {
    root,
    stateRoot,
    ledgerFiles,
    assetFiles,
    blobFiles: [...ledgerFiles, ...assetFiles].sort(),
  };
}

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

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
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
