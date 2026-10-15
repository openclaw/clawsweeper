import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { materializeWorkerRecords, type WorkerRecord } from "../scripts/worker-records.ts";
import { hydrateState } from "../scripts/hydrate-state.ts";
import { tarHeader } from "../src/record-snapshot-protocol.ts";

const repoSlug = "streaming-fixture";

function record(id: string, storeRevision: number, content: string | null): WorkerRecord {
  return {
    section: "items",
    id,
    storeRevision,
    revision: storeRevision,
    content,
    digest: content === null ? null : createHash("sha256").update(content).digest("hex"),
    deleted: content === null,
  };
}

const snapshotContent = Buffer.from("snapshot");
const snapshotArchive = gzipSync(
  Buffer.concat([
    tarHeader("items/1.md", snapshotContent.length),
    snapshotContent,
    Buffer.alloc(512 - snapshotContent.length + 1024),
  ]),
);

for (const repositories of [[repoSlug], [repoSlug, "second-fixture"]]) {
  test(`export page budget bounds existing snapshots across ${repositories.length} repositories and repeated IDs`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bounded-records-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const original = path.join(root, "records", "original.md");
    mkdirSync(path.dirname(original), { recursive: true });
    writeFileSync(original, "preserved");
    let exports = 0;
    await assert.rejects(
      materializeWorkerRecords({
        worktreeRoot: root,
        baseUrl: "https://worker.invalid",
        webhookSecret: "fixture",
        repoSlugs: repositories,
        maxExportPages: 2,
        log: () => {},
        fetch: async (input, init) => {
          const endpoint = new URL(String(input)).pathname;
          const body = JSON.parse(String(init?.body));
          if (endpoint.endsWith("/latest"))
            return Response.json({
              snapshotStoreAvailable: true,
              snapshot: {
                repoSlug: body.repoSlug,
                revisionWatermark: 1,
                objectKey: "fixture",
                bytes: snapshotArchive.length,
                fileCount: 1,
                uncompressedBytes: 8,
                createdAt: new Date().toISOString(),
                access: { mode: "worker_range_proxy", maxChunkBytes: 1024 },
              },
            });
          if (endpoint.endsWith("/chunk"))
            return new Response(snapshotArchive, {
              status: 206,
              headers: {
                "content-range": `bytes 0-${snapshotArchive.length - 1}/${snapshotArchive.length}`,
              },
            });
          if (endpoint.endsWith("/list"))
            return Response.json({
              repoSlug: body.repoSlug,
              section: "items",
              records: [],
              nextCursor: null,
            });
          assert.ok(endpoint.endsWith("/export"));
          assert.equal(body.sinceRevision, 1, "existing snapshot remains the replay boundary");
          exports++;
          return Response.json({
            repoSlug: body.repoSlug,
            revision: exports + 1,
            records: [record("1", exports + 1, "newest")],
            nextCursor: repositories.length === 2 && exports === 1 ? null : exports + 1,
          });
        },
      }),
      /budget of 2 pages exhausted.*snapshot-upload --repo-slug/,
    );
    assert.equal(exports, 2, "no third export request may reach the queue");
    assert.equal(readFileSync(original, "utf8"), "preserved");
    assert.ok(!readdirSync(root).some((entry) => entry.startsWith(".worker-records-stage-")));
  });
}

test("hydrate CLI cancels the export stream at its shared byte budget", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "bounded-export-bytes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let cancelled = false;
  await assert.rejects(
    hydrateState(
      [
        "--worktree",
        root,
        "--skip-git-state",
        "--skip-state-blobs",
        "--records-repo-slugs",
        repoSlug,
        "--max-export-pages",
        "50",
        "--max-export-bytes",
        "32",
      ],
      { CLAWSWEEPER_RECORDS_SECRET: "fixture" },
      async (input) => {
        if (String(input).endsWith("/latest"))
          return Response.json({
            snapshotStoreAvailable: true,
            snapshot: {
              repoSlug,
              revisionWatermark: 1,
              objectKey: "fixture",
              bytes: snapshotArchive.length,
              fileCount: 1,
              uncompressedBytes: 8,
              createdAt: new Date().toISOString(),
              access: { mode: "worker_range_proxy", maxChunkBytes: 1024 },
            },
          });
        if (String(input).endsWith("/chunk"))
          return new Response(snapshotArchive, {
            status: 206,
            headers: {
              "content-range": `bytes 0-${snapshotArchive.length - 1}/${snapshotArchive.length}`,
            },
          });
        assert.ok(String(input).endsWith("/export"));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(33)));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    ),
    /budget of 32 bytes exhausted.*snapshot-upload --repo-slug/,
  );
  assert.equal(cancelled, true);
  assert.ok(!existsSync(path.join(root, "records")));
});

for (const fail of [false, true]) {
  test(`hydration writes pages before fetching more and ${fail ? "discards failed staging" : "keeps newest revisions"}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "streaming-records-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const original = path.join(root, "records", repoSlug, "items", "99.md");
    mkdirSync(path.dirname(original), { recursive: true });
    writeFileSync(original, "original");
    let page = 0;
    const result = materializeWorkerRecords({
      worktreeRoot: root,
      baseUrl: "https://worker.invalid",
      webhookSecret: "fixture",
      repoSlugs: [repoSlug],
      log: () => {},
      fetch: async (input) => {
        const endpoint = new URL(String(input)).pathname;
        if (endpoint.endsWith("/latest"))
          return Response.json({ error: "snapshot_not_found" }, { status: 404 });
        if (endpoint.endsWith("/list"))
          return Response.json({ repoSlug, section: "items", records: [], nextCursor: null });
        assert.ok(endpoint.endsWith("/export"));
        page++;
        if (page === 1)
          return Response.json({
            repoSlug,
            revision: 10,
            records: [record("1", 4, "newest"), record("2", 3, "delete me")],
            nextCursor: 1,
          });
        const stage = readdirSync(root).find((entry) => entry.startsWith(".worker-records-stage-"));
        assert.ok(stage);
        const items = path.join(root, stage, "records", repoSlug, "items");
        assert.equal(readFileSync(path.join(items, "1.md"), "utf8"), "newest");
        assert.equal(readFileSync(original, "utf8"), "original");
        if (fail) return Response.json({ error: "denied" }, { status: 403 });
        return Response.json({
          repoSlug,
          revision: 12,
          records: [
            record("1", 2, "older"),
            record("1", 4, "equal"),
            record("2", 7, null),
            record("2", 5, "stale resurrection"),
            record("3", 9, "third"),
          ],
          nextCursor: null,
        });
      },
    });
    if (fail) {
      await assert.rejects(result, /403/);
      assert.equal(readFileSync(original, "utf8"), "original");
    } else {
      const hydrated = await result;
      assert.equal(hydrated.repositories[repoSlug].deltaRecords, 3);
      assert.equal(hydrated.repositories[repoSlug].recordCount, 2);
      assert.equal(hydrated.repositories[repoSlug].exportStartRevision, 10);
      assert.equal(hydrated.repositories[repoSlug].revision, 12);
      const items = path.join(root, "records", repoSlug, "items");
      assert.equal(readFileSync(path.join(items, "1.md"), "utf8"), "newest");
      assert.equal(readFileSync(path.join(items, "3.md"), "utf8"), "third");
      assert.equal(existsSync(path.join(items, "2.md")), false);
      assert.equal(existsSync(original), false);
    }
    assert.equal(
      readdirSync(root).some((entry) => entry.startsWith(".worker-records-stage-")),
      false,
    );
  });
}
