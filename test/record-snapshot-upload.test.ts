import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RECORD_SNAPSHOT_UPLOAD_MAX_BYTES,
  SNAPSHOT_MAX_IDENTITIES,
} from "../src/record-snapshot-protocol.ts";
import {
  bootstrapColdWorkerRecordSnapshots,
  COLD_HYDRATION_MAX_RECORDS,
  materializeWorkerRecords,
  uploadWorkerRecordSnapshot,
  WorkerRecordExportBoundError,
  WorkerSnapshotUnavailableError,
  type WorkerRecord,
  type WorkerStoredSnapshot,
} from "../scripts/worker-records.ts";
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

test("runner bootstraps a cold repository beyond the reader bound and preserves concurrent deltas", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "snapshot-bootstrap-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoSlug = "fixture-repo";
  const count = COLD_HYDRATION_MAX_RECORDS + 1;
  let revision = count;
  const journal = new Map<string, WorkerRecord>();
  const put = (id: number, content: string | null, storeRevision = ++revision) => {
    journal.set(String(id), {
      section: "items",
      id: String(id),
      content,
      digest: content === null ? null : digest(Buffer.from(content)),
      revision: 1,
      storeRevision,
      deleted: content === null,
    });
  };
  for (let id = 1; id <= count; id++) put(id, `# Record ${id}\r\nUnicode 🦞\n`, id);
  const f = fixture();
  let snapshot: WorkerStoredSnapshot | undefined;
  let mutate = false;
  const since: number[] = [];
  const source: typeof fetch = async (input, init) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body));
    if (endpoint.endsWith("/latest"))
      return snapshot
        ? Response.json({ snapshotStoreAvailable: true, snapshot })
        : Response.json({ error: "snapshot_not_found" }, { status: 404 });
    if (endpoint.endsWith("/chunk")) {
      const archive = f.objects.get(snapshot!.objectKey)!;
      return new Response(archive.subarray(body.offset, body.offset + body.length), {
        status: 206,
        headers: {
          "content-range": `bytes ${body.offset}-${body.offset + body.length - 1}/${archive.length}`,
        },
      });
    }
    if (endpoint.endsWith("/export")) {
      since.push(body.sinceRevision);
      const available = [...journal.values()]
        .filter((r) => r.storeRevision > Math.max(body.cursor, body.sinceRevision))
        .sort((a, b) => a.storeRevision - b.storeRevision);
      const page = available.slice(0, body.limit);
      const response = Response.json({
        repoSlug,
        revision,
        records: page,
        nextCursor: available.length > page.length ? page.at(-1)!.storeRevision : null,
      });
      if (mutate && body.cursor === 0) {
        mutate = false;
        put(1, "updated after first page\n");
        put(2, null);
        put(count + 1, "created after first page\n");
      }
      return response;
    }
    if (endpoint.endsWith("/list")) {
      const ids = [...journal.values()]
        .filter((r) => !r.deleted && Number(r.id) > body.cursor)
        .map((r) => ({ id: Number(r.id) }))
        .sort((a, b) => a.id - b.id);
      const page = ids.slice(0, body.limit);
      return Response.json({
        repoSlug,
        section: "items",
        records: page,
        nextCursor: ids.length > page.length ? page.at(-1)!.id : null,
      });
    }
    return worker.fetch(new Request(String(input), init), f.env);
  };
  const options = {
    baseUrl: "http://127.0.0.1:8787",
    webhookSecret: secret,
    repoSlug,
    fetch: source,
    log: () => {},
  };
  const destination = path.join(root, "reader");
  fs.mkdirSync(path.join(destination, "records"), { recursive: true });
  writeFileSync(path.join(destination, "records", "sentinel"), "preserved");
  await assert.rejects(
    materializeWorkerRecords({ ...options, repoSlugs: [repoSlug], worktreeRoot: destination }),
    (error: unknown) =>
      error instanceof WorkerSnapshotUnavailableError &&
      error.detail.code === "cold_hydration_bound_exceeded",
  );
  assert.equal(readFileSync(path.join(destination, "records", "sentinel"), "utf8"), "preserved");
  assert.equal(f.counts().uploads, 0);
  mutate = true;
  snapshot = {
    ...(await uploadWorkerRecordSnapshot(options)),
    access: { mode: "worker_range_proxy", maxChunkBytes: partBytes },
  };
  assert.equal(snapshot.revisionWatermark, count);
  assert.equal(snapshot.fileCount, count);
  assert.equal(f.counts().uploads, 1);
  since.length = 0;
  const hydrated = await materializeWorkerRecords({
    ...options,
    repoSlugs: [repoSlug],
    worktreeRoot: destination,
  });
  assert.deepEqual(since, [count]);
  assert.equal(hydrated.repositories[repoSlug].deltaRecords, 3);
  for (const record of journal.values()) {
    const filename = path.join(hydrated.recordsRoot, repoSlug, "items", `${record.id}.md`);
    if (record.deleted) assert.equal(existsSync(filename), false);
    else assert.deepEqual(readFileSync(filename), Buffer.from(record.content!));
  }
  // The next producer shares the warm snapshot/delta path; use a fresh upload
  // store so an Actions operation id still denotes exactly one attempt.
  const warm = fixture();
  since.length = 0;
  const refreshed = await uploadWorkerRecordSnapshot({
    ...options,
    fetch: (input, init) =>
      new URL(String(input)).pathname.includes("/upload/")
        ? worker.fetch(new Request(String(input), init), warm.env)
        : source(input, init),
  });
  assert.deepEqual(since, [count]);
  assert.equal(refreshed.revisionWatermark, revision);
  assert.equal(refreshed.fileCount, count);
});

test("cold bootstrap snapshots every snapshot-less repository and survives per-repository failures", async () => {
  const count = COLD_HYDRATION_MAX_RECORDS + 1;
  const records: WorkerRecord[] = Array.from({ length: count }, (_, index) => {
    const content = `# Record ${index + 1}\n`;
    return {
      section: "items",
      id: String(index + 1),
      content,
      digest: digest(Buffer.from(content)),
      revision: 1,
      storeRevision: index + 1,
      deleted: false,
    };
  });
  const f = fixture();
  const stored = new Map<string, WorkerStoredSnapshot>();
  const exported: string[] = [];
  const source: typeof fetch = async (input, init) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (endpoint.endsWith("/records/slugs"))
      return Response.json({
        repositories: [
          { repoSlug: "cold-b-large", revision: count },
          { repoSlug: "a-lookup-broken", revision: 1 },
          { repoSlug: "cold-a-refused", revision: 1 },
        ],
      });
    if (endpoint.endsWith("/latest")) {
      if (body.repoSlug === "a-lookup-broken")
        return Response.json({ error: "fixture_lookup_refused" }, { status: 404 });
      const snapshot = stored.get(body.repoSlug);
      return snapshot
        ? Response.json({ snapshotStoreAvailable: true, snapshot })
        : Response.json({ error: "snapshot_not_found" }, { status: 404 });
    }
    if (endpoint.endsWith("/export")) {
      exported.push(body.repoSlug);
      if (body.repoSlug === "cold-a-refused")
        return Response.json({ error: "fixture_export_refused" }, { status: 403 });
      const available = records.filter(
        (record) => record.storeRevision > Math.max(body.cursor, body.sinceRevision),
      );
      const page = available.slice(0, body.limit);
      return Response.json({
        repoSlug: body.repoSlug,
        revision: count,
        records: page,
        nextCursor: available.length > page.length ? page.at(-1)!.storeRevision : null,
      });
    }
    if (endpoint.endsWith("/list"))
      return Response.json({
        repoSlug: body.repoSlug,
        section: "items",
        records: [],
        nextCursor: null,
      });
    return worker.fetch(new Request(String(input), init), f.env);
  };
  const options = {
    baseUrl: "http://127.0.0.1:8787",
    webhookSecret: secret,
    fetch: source,
    log: () => {},
  };

  // Both broken slugs sort first: neither a lookup nor an upload failure may
  // strand the large cold repository.
  const first = await bootstrapColdWorkerRecordSnapshots(options);
  assert.deepEqual(first.coldSlugs, ["cold-a-refused", "cold-b-large"]);
  assert.deepEqual(
    first.snapshots.map(({ repoSlug, fileCount, revisionWatermark }) => ({
      repoSlug,
      fileCount,
      revisionWatermark,
    })),
    [{ repoSlug: "cold-b-large", fileCount: count, revisionWatermark: count }],
  );
  assert.deepEqual(
    first.failures.map(({ repoSlug }) => repoSlug),
    ["a-lookup-broken", "cold-a-refused"],
  );
  assert.match(first.failures[0]!.error, /fixture_lookup_refused/);
  assert.match(first.failures[1]!.error, /fixture_export_refused/);
  assert.equal(f.counts().uploads, 1);

  for (const snapshot of first.snapshots)
    stored.set(snapshot.repoSlug, {
      ...snapshot,
      access: { mode: "worker_range_proxy", maxChunkBytes: partBytes },
    });
  exported.length = 0;
  const second = await bootstrapColdWorkerRecordSnapshots(options);
  assert.deepEqual(second.coldSlugs, ["cold-a-refused"]);
  assert.deepEqual(second.snapshots, []);
  assert.deepEqual(
    second.failures.map(({ repoSlug }) => repoSlug),
    ["a-lookup-broken", "cold-a-refused"],
  );
  assert.deepEqual(exported, ["cold-a-refused"]);
  assert.equal(f.counts().uploads, 1);
});

test("cold producer export failures and protocol caps never start an upload and clean staging", async (t) => {
  const roots: string[] = [];
  const original = fs.mkdtempSync;
  t.mock.method(fs, "mkdtempSync", (prefix: string) => {
    const root = original(prefix);
    if (prefix.includes("clawsweeper-snapshot-upload-")) roots.push(root);
    return root;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const originalStat = fs.statSync;
  for (const failure of ["export", "cap", "archive"] as const) {
    if (failure === "archive") {
      // Exercise the archive-size admission boundary without a 1 GiB fixture.
      t.mock.method(fs, "statSync", (filename, ...args) => {
        const stat = originalStat(filename, ...args);
        return String(filename).endsWith("snapshot.tar.gz")
          ? { ...stat, size: RECORD_SNAPSHOT_UPLOAD_MAX_BYTES + 1 }
          : stat;
      });
      syncBuiltinESMExports();
    }
    let uploadCalls = 0;
    const promise = uploadWorkerRecordSnapshot({
      baseUrl: "http://127.0.0.1:8787",
      webhookSecret: secret,
      repoSlug: "fixture-repo",
      log: () => {},
      fetch: async (input, init) => {
        const endpoint = new URL(String(input)).pathname;
        if (endpoint.includes("/upload/")) uploadCalls++;
        if (endpoint.endsWith("/latest"))
          return Response.json({ error: "snapshot_not_found" }, { status: 404 });
        if (endpoint.endsWith("/list"))
          return Response.json({
            repoSlug: "fixture-repo",
            section: "items",
            records: [],
            nextCursor: null,
          });
        assert.ok(endpoint.endsWith("/export"));
        if (failure === "export")
          return Response.json({ error: "fixture_export_refused" }, { status: 403 });
        if (failure === "archive")
          return Response.json({
            repoSlug: "fixture-repo",
            revision: 0,
            records: [],
            nextCursor: null,
          });
        const { cursor, limit } = JSON.parse(String(init?.body));
        const end = Math.min(cursor + limit, SNAPSHOT_MAX_IDENTITIES + 1);
        return Response.json({
          repoSlug: "fixture-repo",
          revision: SNAPSHOT_MAX_IDENTITIES + 1,
          nextCursor: end === SNAPSHOT_MAX_IDENTITIES + 1 ? null : end,
          records: Array.from({ length: end - cursor }, (_, offset) => ({
            section: "items",
            id: String(cursor + offset + 1),
            content: "",
            digest: digest(Buffer.alloc(0)),
            revision: 1,
            storeRevision: cursor + offset + 1,
            deleted: false,
          })),
        });
      },
    });
    await assert.rejects(promise, (error: unknown) =>
      failure === "cap"
        ? error instanceof WorkerRecordExportBoundError &&
          error.maxRecords === SNAPSHOT_MAX_IDENTITIES
        : error instanceof Error &&
          error.message.includes(
            failure === "archive" ? "1 GiB upload limit" : "fixture_export_refused",
          ),
    );
    assert.equal(uploadCalls, 0);
    assert.ok(roots.length > 0);
    assert.ok(roots.every((root) => !existsSync(root)));
  }
});

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
