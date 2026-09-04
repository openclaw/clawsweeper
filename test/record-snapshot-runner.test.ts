import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as records from "../scripts/worker-records.ts";
import {
  ExactReviewQueue,
  MemoryDurableNamespace,
  MemoryDurableStorage,
  MemoryR2Bucket,
  signedStateAppendRequest,
  worker,
} from "./dashboard-worker-harness.ts";

const repoSlug = "fixture-repo";
const secret = "synthetic-record-snapshot-secret";
const baseUrl = "http://127.0.0.1:8787";

test("snapshot hydration retains the first export watermark across changing pages", async () => {
  let page = 0;
  const exported = await records.exportWorkerRecords({
    baseUrl,
    webhookSecret: secret,
    repoSlug,
    fetch: async () =>
      Response.json({
        repoSlug,
        revision: ++page === 1 ? 20 : 25,
        records: [],
        nextCursor: page === 1 ? 10 : null,
      }),
  });
  assert.equal(exported.revision, 25);
  assert.equal(exported.exportStartRevision, 20);
});

test("runner packs hydrated records and the existing snapshot restore reads exact bytes", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "record-snapshot-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = [
    { section: "items", id: "1", content: "# First\r\nUnicode 🦞\n" },
    { section: "closed", id: "2", content: "Closed\n" },
    { section: "plans", id: "1", content: "" },
    { section: "decision-packets", id: "1", content: '{"result":"keep"}\n' },
    { section: "commits", id: "a".repeat(40), content: "Commit\n" },
  ];
  const fetchSource: typeof fetch = async (input) => {
    const endpoint = new URL(String(input)).pathname;
    if (endpoint.endsWith("/latest"))
      return Response.json({ error: "snapshot_not_found" }, { status: 404 });
    if (endpoint.endsWith("/list"))
      return Response.json({ repoSlug, section: "items", records: [{ id: 1 }], nextCursor: null });
    assert.ok(endpoint.endsWith("/export"));
    return Response.json({
      repoSlug,
      revision: 5,
      nextCursor: null,
      records: fixture.map((record, index) => ({
        ...record,
        digest: createHash("sha256").update(record.content).digest("hex"),
        revision: 1,
        storeRevision: index + 1,
        deleted: false,
      })),
    });
  };
  const hydrated = await records.materializeWorkerRecords({
    worktreeRoot: path.join(root, "source"),
    baseUrl,
    webhookSecret: secret,
    repoSlugs: [repoSlug],
    fetch: fetchSource,
    log: () => {},
  });
  assert.equal(hydrated.repositories[repoSlug].exportStartRevision, 5);
  const packed = await records.packWorkerRecordSnapshot({
    repoRoot: path.join(hydrated.recordsRoot, repoSlug),
    archivePath: path.join(root, "snapshot.tar.gz"),
  });
  const archive = readFileSync(packed.archivePath);
  assert.equal(packed.fileCount, fixture.length);
  assert.equal(packed.bytes, archive.length);
  assert.equal(
    packed.uncompressedBytes,
    fixture.reduce((sum, record) => sum + Buffer.byteLength(record.content), 0),
  );
  const restored = await records.materializeWorkerRecords({
    worktreeRoot: path.join(root, "restored"),
    baseUrl,
    webhookSecret: secret,
    repoSlugs: [repoSlug],
    log: () => {},
    fetch: async (input, init) => {
      const endpoint = new URL(String(input)).pathname;
      if (endpoint.endsWith("/latest"))
        return Response.json({
          snapshotStoreAvailable: true,
          snapshot: {
            repoSlug,
            revisionWatermark: 5,
            objectKey: "fixture",
            ...packed,
            createdAt: new Date().toISOString(),
            access: { mode: "worker_range_proxy", maxChunkBytes: 32 },
          },
        });
      if (endpoint.endsWith("/chunk")) {
        const { offset, length } = JSON.parse(String(init?.body));
        return new Response(archive.subarray(offset, offset + length), {
          status: 206,
          headers: {
            "content-range": `bytes ${offset}-${offset + length - 1}/${archive.length}`,
          },
        });
      }
      if (endpoint.endsWith("/list"))
        return Response.json({
          repoSlug,
          section: "items",
          records: [{ id: 1 }],
          nextCursor: null,
        });
      assert.ok(endpoint.endsWith("/export"));
      assert.equal(JSON.parse(String(init?.body)).sinceRevision, 5);
      return Response.json({ repoSlug, revision: 5, records: [], nextCursor: null });
    },
  });
  for (const record of fixture) {
    const extension = record.section === "decision-packets" ? ".json" : ".md";
    assert.deepEqual(
      readFileSync(
        path.join(restored.recordsRoot, repoSlug, record.section, `${record.id}${extension}`),
      ),
      Buffer.from(record.content),
    );
  }
});

test("signed registration validates descriptor, verifies R2, inserts and prunes", async () => {
  const storage = new MemoryDurableStorage();
  const bucket = new MemoryR2Bucket();
  const queue = new ExactReviewQueue({ storage }, { STATE_SNAPSHOTS: bucket });
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const endpoint = "/internal/state/records/snapshots/register";
  const createdAt = Date.now() - 1000;
  const descriptor = {
    repoSlug,
    revisionWatermark: 0,
    objectKey: `${repoSlug}/0/${createdAt}-00000000-0000-4000-8000-000000000001.tar.gz`,
    bytes: 20,
    uncompressedBytes: 0,
    fileCount: 0,
    createdAt,
  };
  const post = (body: unknown) =>
    worker.fetch(signedStateAppendRequest(endpoint, body, secret), env);
  const unsigned = await worker.fetch(
    new Request(`${baseUrl}${endpoint}`, { method: "POST", body: JSON.stringify(descriptor) }),
    env,
  );
  assert.equal(unsigned.status, 401);
  assert.equal((await post(descriptor)).status, 404);
  for (const patch of [
    { revisionWatermark: 1, objectKey: descriptor.objectKey.replace("/0/", "/1/") },
    { repoSlug: "../escape" },
    { objectKey: "other/0/archive.tar.gz" },
    { bytes: -1 },
    { bytes: 1024 * 1024 * 1024 + 1 },
    { fileCount: -1 },
    { fileCount: 1.5 },
    { uncompressedBytes: -1 },
    { createdAt: "yesterday" },
    { createdAt: Date.now() + 60_000 },
  ])
    assert.equal((await post({ ...descriptor, ...patch })).status, 400, JSON.stringify(patch));
  for (let index = 0; index < 3; index++) {
    const next = {
      ...descriptor,
      createdAt: createdAt + index,
      objectKey: descriptor.objectKey.replace(String(createdAt), String(createdAt + index)),
    };
    const upload = await bucket.createMultipartUpload(next.objectKey);
    const part = await upload.uploadPart(1, new Uint8Array(next.bytes));
    await upload.complete([part]);
    assert.equal((await post({ ...next, bytes: 19 })).status, 400);
    const registered = await post(next);
    assert.equal(registered.status, 201, await registered.clone().text());
    assert.equal((await registered.json()).snapshot.objectKey, next.objectKey);
    assert.equal((await post(next)).status, 201, "retry must be idempotent");
    assert.equal((await post({ ...next, fileCount: 1 })).status, 409);
  }
  assert.equal(bucket.keys().length, 2);
  assert.equal(
    Array.from(storage.sql.exec("SELECT * FROM exact_review_record_snapshots")).length,
    2,
  );
});
