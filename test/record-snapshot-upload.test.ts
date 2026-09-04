import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MemoryDurableNamespace,
  MemoryDurableStorage,
  StatusStore,
  signedStateAppendRequest,
  worker,
} from "./dashboard-worker-harness.ts";

const secret = "synthetic-snapshot-upload-secret";
const prefix = "/internal/state/records/snapshots/upload/";
const partBytes = 6 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const storage = new MemoryDurableStorage();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const objects = new Map<string, Uint8Array>();
  const queueCalls: string[] = [];
  let writes = 0;
  let aborted = 0;
  const bucket = {
    async createMultipartUpload(key: string, options: unknown) {
      assert.deepEqual((options as any).httpMetadata, { contentType: "application/gzip" });
      const uploadId = `r2-${uploads.size}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return { uploadId, ...this.resumeMultipartUpload(key, uploadId) };
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      const upload = uploads.get(uploadId)!;
      assert.equal(upload.key, key);
      return {
        async uploadPart(partNumber: number, value: Uint8Array) {
          assert.ok(value instanceof Uint8Array);
          writes++;
          upload.parts.set(partNumber, value.slice());
          return { partNumber, etag: digest(value) };
        },
        async complete(parts: Array<{ partNumber: number; etag: string }>) {
          const bytes = Buffer.concat(
            parts.map((part) => {
              const value = upload.parts.get(part.partNumber)!;
              assert.equal(digest(value), part.etag);
              return value;
            }),
          );
          objects.set(key, bytes);
        },
        async abort() {
          aborted++;
        },
      };
    },
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length } : null;
    },
  };
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    STATE_SNAPSHOTS: bucket,
    STATUS_STORE: new MemoryDurableNamespace({
      fetch: (request: Request, init?: RequestInit) =>
        new StatusStore({ storage }).fetch(new Request(request, init)),
    }),
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
      async fetch(request: Request) {
        queueCalls.push(new URL(request.url).pathname);
        return Response.json({ ok: true, snapshot: await request.json() }, { status: 201 });
      },
    }),
  };
  const post = (operation: string, body: unknown) =>
    worker.fetch(signedStateAppendRequest(prefix + operation, body, secret), env);
  const start = async (bytes: number) => {
    const response = await post("start", {
      repoSlug: "fixture-repo",
      revisionWatermark: 0,
      bytes,
      sha256: "a".repeat(64),
      fileCount: 1,
      uncompressedBytes: bytes,
    });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  return { env, post, start, storage, objects, queueCalls, counts: () => ({ writes, aborted }) };
}

test("snapshot upload authenticates and bounds JSON bodies before touching R2 or queue", async () => {
  const f = fixture();
  for (const operation of ["start", "part", "complete", "abort"]) {
    const response = await worker.fetch(
      new Request(`https://example.test${prefix}${operation}`, { method: "POST", body: "{}" }),
      f.env,
    );
    assert.equal(response.status, 401, operation);
  }
  const oversize = await f.post("start", { repoSlug: "fixture-repo", bytes: 1024 ** 3 + 1 });
  assert.equal(oversize.status, 413);
  const huge = new Request(`https://example.test${prefix}part`, {
    method: "POST",
    body: "{}",
    headers: {
      "content-length": String(9 * 1024 * 1024),
      "x-clawsweeper-exact-review-signature": "sha256=" + "a".repeat(64),
    },
  });
  assert.equal((await worker.fetch(huge, f.env)).status, 413);
  assert.deepEqual(f.queueCalls, []);
});

test("snapshot upload verifies each bounded part and completes directly in R2 before registering", async () => {
  const f = fixture();
  const data = [Buffer.alloc(partBytes, 31), Buffer.from("final")];
  const session = await f.start(partBytes + data[1].length);
  assert.match(session.objectKey, /^fixture-repo\/0\/\d+-[0-9a-f-]+\.tar\.gz$/);
  const parts = [];
  for (let i = 0; i < data.length; i++) {
    const body = {
      uploadId: session.uploadId,
      partNumber: i + 1,
      data: data[i].toString("base64"),
      sha256: digest(data[i]),
    };
    assert.equal((await f.post("part", { ...body, sha256: "b".repeat(64) })).status, 400);
    const response = await f.post("part", body);
    assert.equal(response.status, 200, await response.clone().text());
    parts.push((await response.json()).part);
    assert.deepEqual((await (await f.post("part", body)).json()).part, parts[i]);
    assert.deepEqual(f.queueCalls, []);
  }
  assert.equal(
    (
      await f.post("part", {
        uploadId: session.uploadId,
        partNumber: 201,
        data: "YQ==",
        sha256: digest(Buffer.from("a")),
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.post("complete", { uploadId: session.uploadId, parts: parts.slice(1) })).status,
    400,
  );
  assert.equal(
    (
      await f.post("complete", {
        uploadId: session.uploadId,
        parts: [{ ...parts[0], etag: "wrong" }, parts[1]],
      })
    ).status,
    400,
  );
  const response = await f.post("complete", { uploadId: session.uploadId, parts });
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(f.objects.get(session.objectKey), Buffer.concat(data));
  assert.deepEqual(f.queueCalls, ["/records/snapshots/register"]);
  assert.equal((await f.post("complete", { uploadId: session.uploadId, parts })).status, 201);
  assert.equal((await f.post("abort", { uploadId: session.uploadId })).status, 200);
  assert.ok(
    f.objects.has(session.objectKey),
    "abort must preserve completed objects after response loss",
  );
});

test("snapshot upload rejects wrong lengths and expired sessions and aborts partial uploads", async () => {
  const f = fixture();
  const session = await f.start(partBytes + 1);
  const bytes = Buffer.from("a");
  assert.equal(
    (
      await f.post("part", {
        uploadId: session.uploadId,
        partNumber: 1,
        data: bytes.toString("base64"),
        sha256: digest(bytes),
      })
    ).status,
    400,
  );
  assert.equal((await f.post("abort", { uploadId: session.uploadId })).status, 200);
  assert.equal(f.counts().aborted, 1);
  assert.equal((await f.post("part", { uploadId: session.uploadId })).status, 410);
  assert.equal((await f.post("complete", { uploadId: "unknown", parts: [] })).status, 410);
  const expired = await f.start(1);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 3_600_001;
  try {
    assert.equal((await f.post("complete", { uploadId: expired.uploadId, parts: [] })).status, 410);
  } finally {
    Date.now = originalNow;
  }
});

test("runner snapshot-upload retries identical part bytes after a lost response", async () => {
  const { uploadWorkerRecordSnapshot } = await import("../scripts/worker-records.ts");
  const f = fixture();
  const partBodies: string[] = [];
  let lost = false;
  const snapshot = await uploadWorkerRecordSnapshot({
    baseUrl: "http://127.0.0.1:8787",
    webhookSecret: secret,
    repoSlug: "fixture-repo",
    log: () => {},
    fetch: async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/latest"))
        return Response.json({ error: "snapshot_not_found" }, { status: 404 });
      if (pathname.endsWith("/export"))
        return Response.json({
          repoSlug: "fixture-repo",
          revision: 0,
          records: [],
          nextCursor: null,
        });
      if (pathname.endsWith("/list"))
        return Response.json({
          repoSlug: "fixture-repo",
          section: "items",
          records: [],
          nextCursor: null,
        });
      if (pathname.endsWith("/part")) partBodies.push(String(init?.body));
      const response = await worker.fetch(new Request(String(input), init), f.env);
      if (pathname.endsWith("/part") && !lost) {
        lost = true;
        assert.equal(response.status, 200);
        throw new TypeError("synthetic connection reset after upload");
      }
      return response;
    },
  });
  assert.equal(snapshot.fileCount, 0);
  assert.equal(partBodies.length, 2);
  assert.equal(partBodies[0], partBodies[1]);
  assert.equal(f.counts().writes, 1);
  assert.deepEqual(f.queueCalls, ["/records/snapshots/register"]);
});

test("snapshot part body is bounded without Content-Length", async () => {
  const f = fixture();
  const request = new Request(`https://example.test${prefix}part`, {
    method: "POST",
    duplex: "half",
    headers: { "x-clawsweeper-exact-review-signature": "sha256=" + "a".repeat(64) },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(9 * 1024 * 1024));
        controller.close();
      },
    }),
  } as RequestInit);
  assert.equal((await worker.fetch(request, f.env)).status, 413);
  assert.equal(f.counts().writes, 0);
});
