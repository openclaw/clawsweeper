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

function fixture(registrationStatus = 201) {
  const storage = new MemoryDurableStorage();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const objects = new Map<string, Uint8Array>();
  const queueCalls: string[] = [];
  let writes = 0;
  let aborted = 0;
  let discardFailures = 0;
  const registered = new Set<string>();
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
    async put(key: string, value: string) {
      objects.set(key, Buffer.from(value));
    },
    async get(key: string) {
      const value = objects.get(key);
      return value ? { text: async () => value.toString() } : null;
    },
    async delete(keys: string[]) {
      for (const key of keys) objects.delete(key);
    },
  };
  let serial = Promise.resolve();
  const state = {
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const next = serial.then(callback);
      serial = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    STATE_SNAPSHOTS: bucket,
    STATUS_STORE: new MemoryDurableNamespace({
      fetch: (request: Request, init?: RequestInit) =>
        new StatusStore(state, env).fetch(new Request(request, init)),
    }),
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
      async fetch(request: Request) {
        const pathname = new URL(request.url).pathname;
        queueCalls.push(pathname);
        const snapshot = await request.json();
        if (pathname.endsWith("/discard")) {
          if (discardFailures-- > 0)
            return Response.json({ error: "unavailable" }, { status: 503 });
          if (!registered.has(snapshot.objectKey)) objects.delete(snapshot.objectKey);
          return Response.json({ ok: true });
        }
        if (registrationStatus === 201) registered.add(snapshot.objectKey);
        return Response.json({ ok: true, snapshot }, { status: registrationStatus });
      },
    }),
  };
  const post = (operation: string, body: Record<string, unknown>) =>
    worker.fetch(
      signedStateAppendRequest(
        prefix + operation,
        {
          operation,
          issuedAt: new Date(Date.now()).toISOString(),
          ...(operation === "complete" ? { identities: [["items", "1"]] } : {}),
          ...body,
        },
        secret,
      ),
      env,
    );
  const start = async (bytes: number, fileCount = 1) => {
    const response = await post("start", {
      operationId: crypto.randomUUID(),
      repoSlug: "fixture-repo",
      revisionWatermark: 0,
      bytes,
      sha256: "a".repeat(64),
      identityDigest: digest(Buffer.from(JSON.stringify([["items", "1"]]))),
      fileCount,
      uncompressedBytes: bytes,
    });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  return {
    env,
    post,
    start,
    storage,
    objects,
    queueCalls,
    alarm: () => new StatusStore(state, env).alarm(),
    failNextDiscard: (count = 1) => {
      discardFailures = count;
    },
    counts: () => ({ writes, aborted, uploads: uploads.size }),
  };
}

test("signed part bodies cannot be replayed as aborts", async () => {
  const f = fixture();
  const session = await f.start(partBytes + 1);
  const response = await f.post("abort", { operation: "part", uploadId: session.uploadId });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "upload_operation_mismatch");
  assert.equal(f.counts().aborted, 0);
});

test("start retries and concurrent identical starts reuse one upload", async () => {
  const f = fixture();
  const body = {
    operationId: "fixture-repo:123:1",
    repoSlug: "fixture-repo",
    revisionWatermark: 0,
    bytes: 1,
    sha256: "a".repeat(64),
    identityDigest: "b".repeat(64),
    fileCount: 1,
    uncompressedBytes: 1,
  };
  const responses = await Promise.all([f.post("start", body), f.post("start", body)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  const [first, second] = await Promise.all(responses.map((r) => r.json()));
  assert.deepEqual(first, second);
  assert.deepEqual(await (await f.post("start", body)).json(), first);
  assert.equal(f.counts().uploads, 1);
  assert.equal((await f.post("start", { ...body, fileCount: 2 })).status, 409);
  assert.equal((await f.post("start", { ...body, operationId: undefined })).status, 400);
});

test("identical signed starts expire before dedupe receipts can be recreated, including clock skew", async (t) => {
  const f = fixture();
  const initial = Date.now();
  let now = initial;
  t.mock.method(Date, "now", () => now);
  const body = {
    operationId: "fixture:expiry:1",
    repoSlug: "fixture-repo",
    revisionWatermark: 0,
    bytes: 1,
    sha256: "a".repeat(64),
    identityDigest: "b".repeat(64),
    fileCount: 0,
    uncompressedBytes: 0,
    issuedAt: new Date(initial + 300_000).toISOString(),
  };
  const first = await f.post("start", body);
  assert.equal(first.status, 201);
  const session = await first.json();
  now += 3_600_001;
  await f.alarm();
  const replay = await f.post("start", body);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), session);
  now = initial + 3_900_001;
  await f.alarm();
  for (const issuedAt of [
    body.issuedAt,
    new Date(now - 3_600_001).toISOString(),
    new Date(now + 300_001).toISOString(),
    "invalid",
    undefined,
  ]) {
    for (const operation of ["start", "part", "manifest", "complete", "abort"]) {
      const response = await f.post(operation, { ...body, issuedAt, uploadId: session.uploadId });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "upload_request_expired");
    }
  }
  assert.equal(f.counts().uploads, 1);
});

test("cleanup survives repeated failures, backs off, and retains receipts after bounded exhaustion", async (t) => {
  const f = fixture(422);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const warnings = t.mock.method(console, "warn", () => {});
  const session = await f.start(1);
  f.objects.set(session.objectKey, Buffer.from("x"));
  const key = `record-snapshot-upload/${session.uploadId}`;
  await f.storage.put(`${key}/parts/1`, { value: "receipt", expires_at: now + 3_600_000 });
  now += 3_900_001;
  f.failNextDiscard(8);
  for (let attempt = 1; attempt <= 7; attempt++) {
    await f.alarm();
    assert.ok(await f.storage.get(key));
    assert.ok(await f.storage.get(`${key}/parts/1`));
    assert.ok(f.objects.has(session.objectKey));
    const alarm = await f.storage.getAlarm();
    assert.equal(alarm, now + Math.min(60_000 * 2 ** (attempt - 1), 3_600_000));
    now = alarm!;
  }
  await f.alarm();
  assert.equal(await f.storage.getAlarm(), null);
  assert.equal((await f.storage.get(key))?.cleanup_attempts, 8);
  assert.ok(await f.storage.get(`${key}/parts/1`));
  await f.alarm();
  assert.equal(warnings.mock.callCount(), 1);
  await f.start(1);
  assert.equal(f.objects.has(session.objectKey), false);
  assert.equal(await f.storage.get(key), undefined);
  assert.equal(await f.storage.get(`${key}/parts/1`), undefined);
});

test("signed manifest chunks are retryable, bounded, reassembled, and cleaned with the session", async () => {
  const f = fixture();
  const session = await f.start(partBytes + 1, 10_001);
  const identities = Array.from({ length: 10_001 }, (_, i) => ["items", String(i + 1)]).sort(
    (a, b) => (a[1] < b[1] ? -1 : 1),
  );
  const parts = [];
  for (const [i, bytes] of [Buffer.alloc(partBytes), Buffer.from("x")].entries()) {
    parts.push(
      (
        await (
          await f.post("part", {
            uploadId: session.uploadId,
            partNumber: i + 1,
            data: bytes.toString("base64"),
            sha256: digest(bytes),
          })
        ).json()
      ).part,
    );
  }
  const complete = () =>
    f.post("complete", { uploadId: session.uploadId, parts, identities: undefined });
  assert.equal((await complete()).status, 400);
  for (let index = 0; index < 2; index++) {
    const body = {
      uploadId: session.uploadId,
      partNumber: index + 1,
      identities: identities.slice(index * 10_000, (index + 1) * 10_000),
    };
    assert.equal((await f.post("manifest", body)).status, 200);
    assert.equal((await f.post("manifest", body)).status, 200);
  }
  assert.equal(
    (await f.post("manifest", { uploadId: session.uploadId, partNumber: 3, identities: [] }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.post("manifest", {
        uploadId: session.uploadId,
        partNumber: 2,
        identities: [["items", "999999"]],
      })
    ).status,
    409,
  );
  const response = await complete();
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).snapshot.identities, identities);
  assert.equal((await complete()).status, 201);
  assert.equal((await f.post("abort", { uploadId: session.uploadId })).status, 200);
  assert.deepEqual([...f.objects.keys()], [session.objectKey]);
});

for (const cleanup of ["abort", "expiry"] as const) {
  test(`${cleanup} deletes completed objects when registration failed`, async () => {
    const f = fixture(422);
    const session = await f.start(partBytes + 1);
    const parts = [];
    for (const [index, bytes] of [Buffer.alloc(partBytes), Buffer.from("a")].entries()) {
      const response = await f.post("part", {
        uploadId: session.uploadId,
        partNumber: index + 1,
        data: bytes.toString("base64"),
        sha256: digest(bytes),
      });
      assert.equal(response.status, 200);
      parts.push((await response.json()).part);
    }
    assert.equal((await f.post("complete", { uploadId: session.uploadId, parts })).status, 422);
    assert.ok(f.objects.has(session.objectKey));
    if (cleanup === "abort") {
      assert.equal((await f.post("abort", { uploadId: session.uploadId })).status, 200);
    } else {
      const originalNow = Date.now;
      Date.now = () => originalNow() + 3_600_001;
      try {
        f.failNextDiscard();
        await f.alarm();
        const retryAt = await f.storage.getAlarm();
        assert.ok(retryAt! > Date.now());
        assert.ok(f.objects.has(session.objectKey));
        Date.now = () => retryAt!;
        await f.alarm();
      } finally {
        Date.now = originalNow;
      }
    }
    assert.equal(f.objects.has(session.objectKey), false);
  });
}

test("snapshot upload authenticates and bounds JSON bodies before touching R2 or queue", async () => {
  const f = fixture();
  for (const operation of ["start", "part", "manifest", "complete", "abort"]) {
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
  const originalNow = Date.now;
  Date.now = () => originalNow() + 3_600_001;
  try {
    await f.alarm();
  } finally {
    Date.now = originalNow;
  }
  assert.ok(f.objects.has(session.objectKey), "expiry must preserve registered objects");
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

test("runner snapshot-upload retries identical signed starts and parts after lost responses", async () => {
  const { uploadWorkerRecordSnapshot } = await import("../scripts/worker-records.ts");
  const f = fixture();
  const partBodies: string[] = [];
  const startBodies: string[] = [];
  let lost = false;
  let lostStart = false;
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
      assert.equal(JSON.parse(String(init?.body)).operation, pathname.split("/").at(-1));
      assert.ok(Number.isFinite(Date.parse(JSON.parse(String(init?.body)).issuedAt)));
      if (pathname.endsWith("/start")) startBodies.push(String(init?.body));
      const response = await worker.fetch(new Request(String(input), init), f.env);
      if (pathname.endsWith("/start") && !lostStart) {
        lostStart = true;
        assert.equal(response.status, 201);
        throw new TypeError("synthetic lost start response");
      }
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
  assert.equal(f.counts().uploads, 1);
  assert.equal(startBodies.length, 2);
  assert.equal(startBodies[0], startBodies[1]);
  const started = JSON.parse(startBodies[0]);
  assert.equal(started.identityDigest, digest(Buffer.from("[]")));
  if (process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT) {
    assert.equal(
      started.operationId,
      `fixture-repo:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`,
    );
  } else {
    assert.match(started.operationId, /^[0-9a-f-]{36}$/);
  }
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

test("runner aborts the completed object after exhausting registration retries", async () => {
  const { uploadWorkerRecordSnapshot } = await import("../scripts/worker-records.ts");
  const f = fixture(503);
  const operations: string[] = [];
  await assert.rejects(
    uploadWorkerRecordSnapshot({
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
        operations.push(JSON.parse(String(init?.body)).operation);
        return worker.fetch(new Request(String(input), init), f.env);
      },
    }),
  );
  assert.equal(operations.filter((operation) => operation === "complete").length, 3);
  assert.equal(operations.at(-1), "abort");
  assert.equal(f.objects.size, 0);
});
