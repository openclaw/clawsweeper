import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";

import { hydrateState } from "../scripts/hydrate-state.ts";
import { verifyWorkerRecordParity } from "../scripts/verify-worker-record-parity.ts";
import { ingestGitRecords, type WorkerRecord } from "../scripts/worker-records.ts";

const repoSlug = "openclaw-openclaw";
const commitId = "c".repeat(40);
const contents = new Map([
  ["items/1", "---\nnumber: 1\n---\nbyte-identical item\n"],
  ["decision-packets/1", '{"decision":"keep"}\n'],
  [`commits/${commitId}`, "---\nsha: fixture\n---\ncommit finding\n"],
]);

test("hydrate-state Worker mode uses snapshot cold and warm paths before replaying the journal", async () => {
  const fixture = createStateFixture();
  const coldTarget = path.join(fixture.root, "worker-cold-target");
  const warmTarget = path.join(fixture.root, "worker-warm-target");
  const cacheRoot = path.join(fixture.root, "snapshot-cache");
  const fetchStats = { chunkRequests: 0 };
  const journal = [{ section: "closed" as const, id: "2", content: "journal delta\n" }];
  try {
    await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        coldTarget,
        "--records-source",
        "worker",
        "--records-url",
        "https://worker.example",
        "--records-repo-slugs",
        repoSlug,
      ],
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret",
        CLAWSWEEPER_RECORDS_CACHE_DIR: cacheRoot,
      },
      workerFetch(contents, fetchStats, journal),
    );
    const coldChunkRequests = fetchStats.chunkRequests;
    assert.ok(coldChunkRequests > 0);
    for (const [key, content] of contents) {
      const [section, id] = key.split("/");
      const extension = section === "decision-packets" ? ".json" : ".md";
      assert.equal(
        readFileSync(
          path.join(coldTarget, "records", repoSlug, section!, `${id}${extension}`),
          "utf8",
        ),
        content,
      );
    }
    assert.equal(
      readFileSync(path.join(coldTarget, "records", repoSlug, "closed", "2.md"), "utf8"),
      "journal delta\n",
    );
    assert.equal(readFileSync(path.join(coldTarget, "jobs", "fixture.json"), "utf8"), "{}\n");
    const manifest = JSON.parse(
      readFileSync(path.join(coldTarget, ".artifacts", "worker-records-manifest.json"), "utf8"),
    );
    assert.deepEqual(manifest, {
      schemaVersion: 2,
      source: "worker",
      repositories: {
        [repoSlug]: {
          revision: contents.size + journal.length,
          snapshotRevision: contents.size,
          snapshotBytes: snapshotArchive(contents).byteLength,
          snapshotCache: "miss",
          deltaRecords: journal.length,
          recordCount: contents.size + journal.length,
        },
      },
    });

    await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        warmTarget,
        "--records-source",
        "worker",
        "--records-url",
        "https://worker.example",
        "--records-repo-slugs",
        repoSlug,
      ],
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret",
        CLAWSWEEPER_RECORDS_CACHE_DIR: cacheRoot,
      },
      workerFetch(contents, fetchStats, journal),
    );
    assert.equal(fetchStats.chunkRequests, coldChunkRequests);
    const warmManifest = JSON.parse(
      readFileSync(path.join(warmTarget, ".artifacts", "worker-records-manifest.json"), "utf8"),
    );
    assert.equal(warmManifest.repositories[repoSlug].snapshotCache, "hit");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hydrate-state refuses Worker cutover and loudly falls back to git without snapshots", async () => {
  const fixture = createStateFixture();
  const target = path.join(fixture.root, "fallback-target");
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.join(" "));
  try {
    const result = await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        target,
        "--records-source",
        "worker",
        "--records-url",
        "https://worker.example",
        "--records-repo-slugs",
        repoSlug,
      ],
      { CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret" },
      async () =>
        Response.json(
          { error: "snapshot_store_unavailable", snapshotStoreAvailable: false },
          { status: 503 },
        ),
    );
    assert.equal(result.recordsSource, "git");
    assert.equal(result.recordsFallback?.reason, "snapshot_store_unavailable");
    assert.match(errors.join("\n"), /WORKER RECORD CUTOVER REFUSED.*FALLING BACK TO GIT/);
    assert.equal(
      readFileSync(path.join(target, "records", repoSlug, "items", "1.md"), "utf8"),
      contents.get("items/1"),
    );
  } finally {
    console.error = originalError;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("record parity verifier reports matching trees and exact path/digest mismatches", async () => {
  const fixture = createStateFixture();
  try {
    const matching = await verifyWorkerRecordParity(
      {
        stateRoot: fixture.stateRoot,
        repoSlug,
        recordsUrl: "https://worker.example",
        webhookSecret: "fixture-secret",
      },
      workerFetch(contents),
    );
    assert.deepEqual(matching, {
      repoSlug,
      gitRecords: contents.size,
      workerRecords: contents.size,
      mismatches: [],
    });

    const changed = new Map(contents);
    changed.set("items/1", "different\n");
    const mismatched = await verifyWorkerRecordParity(
      {
        stateRoot: fixture.stateRoot,
        repoSlug,
        recordsUrl: "https://worker.example",
        webhookSecret: "fixture-secret",
      },
      workerFetch(changed),
    );
    assert.equal(mismatched.mismatches.length, 1);
    assert.equal(mismatched.mismatches[0]?.path, "items/1.md");
    assert.notEqual(mismatched.mismatches[0]?.gitDigest, mismatched.mismatches[0]?.workerDigest);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("backfill importer walks all record sections and sends digest-bearing rows", async () => {
  const fixture = createStateFixture();
  const requests: unknown[] = [];
  try {
    const result = await ingestGitRecords({
      stateRoot: fixture.stateRoot,
      repoSlug,
      baseUrl: "https://worker.example",
      webhookSecret: "fixture-secret",
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return Response.json({
          inserted: body.records.length,
          unchanged: 0,
          skippedNewer: 0,
          watermark: body.records.length,
        });
      },
    });
    assert.equal(result.records, contents.size);
    const rows = requests.flatMap(
      (request) => (request as { records: unknown[] }).records,
    ) as Array<{
      section: string;
      id: string;
      content: string;
      digest: string;
    }>;
    assert.deepEqual(
      rows.map((row) => `${row.section}/${row.id}`).sort(),
      [...contents.keys()].sort(),
    );
    for (const row of rows) {
      assert.equal(row.digest, createHash("sha256").update(row.content).digest("hex"));
    }

    requests.length = 0;
    const resumed = await ingestGitRecords({
      stateRoot: fixture.stateRoot,
      repoSlug,
      baseUrl: "https://worker.example",
      webhookSecret: "fixture-secret",
      maxRecordsPerBatch: 1,
      cursor: 1,
      maxBatches: 1,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return Response.json({
          inserted: body.records.length,
          unchanged: 0,
          skippedNewer: 0,
          watermark: 2,
        });
      },
    });
    assert.equal(requests.length, 1);
    assert.equal(resumed.cursor, 1);
    assert.equal(resumed.nextCursor, 2);
    assert.equal(resumed.totalBatches, contents.size);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("backfill workflow is manual per-target and setup-state plumbs the opt-in Worker flag", () => {
  const workflowSource = readFileSync(".github/workflows/backfill-worker-records.yml", "utf8");
  const workflow = parse(workflowSource) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
    jobs?: {
      backfill?: { steps?: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }> };
    };
  };
  assert.ok(workflow.on?.workflow_dispatch?.inputs?.target_repo);
  assert.ok(workflow.on?.workflow_dispatch?.inputs?.cursor);
  assert.ok(workflow.on?.workflow_dispatch?.inputs?.max_batches);
  const setupState = workflow.jobs?.backfill?.steps?.find(
    (step) => step.uses === "./.github/actions/setup-state",
  );
  assert.equal(setupState?.with?.["records-source"], "git");
  assert.match(workflowSource, /scripts\/backfill-worker-records\.ts/);
  assert.match(workflowSource, /--cursor "\$BACKFILL_CURSOR"/);
  assert.match(workflowSource, /records\/\$\{\{ steps\.target\.outputs\.slug \}\}/);

  const action = readFileSync(".github/actions/setup-state/action.yml", "utf8");
  assert.match(action, /records-source:[\s\S]*?default: git/);
  assert.match(action, /CLAWSWEEPER_RECORDS_SOURCE: \$\{\{ inputs\.records-source \}\}/);
  assert.match(action, /CLAWSWEEPER_RECORDS_URL: \$\{\{ inputs\.records-url \}\}/);
  assert.match(action, /CLAWSWEEPER_RECORDS_REPO_SLUGS: \$\{\{ inputs\.records-repo-slugs \}\}/);
  assert.match(action, /CLAWSWEEPER_RECORDS_SECRET: \$\{\{ inputs\.records-secret \}\}/);
  assert.match(action, /uses: actions\/cache@v6/);
  assert.match(action, /steps\.records-snapshot\.outputs\.cache-key/);
  assert.match(action, /\.artifacts\/worker-records-cache/);
});

function createStateFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-worker-records-test-"));
  const stateRoot = path.join(root, "state");
  for (const [key, content] of contents) {
    const [section, id] = key.split("/");
    const extension = section === "decision-packets" ? ".json" : ".md";
    write(path.join(stateRoot, "records", repoSlug, section!, `${id}${extension}`), content);
  }
  write(path.join(stateRoot, "jobs", "fixture.json"), "{}\n");
  return { root, stateRoot };
}

function workerFetch(
  recordsByKey: Map<string, string>,
  stats: { chunkRequests: number } = { chunkRequests: 0 },
  journal: Array<{ section: WorkerRecord["section"]; id: string; content: string }> = [],
): typeof globalThis.fetch {
  const archive = snapshotArchive(recordsByKey);
  return async (input, init) => {
    const url = new URL(String(input));
    const bodyText = String(init?.body || "");
    const signature = `sha256=${createHmac("sha256", "fixture-secret").update(bodyText).digest("hex")}`;
    assert.equal(new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"), signature);
    const body = JSON.parse(bodyText) as {
      cursor: number;
      sinceRevision?: number;
      offset?: number;
      length?: number;
    };
    if (url.pathname.endsWith("/snapshots/latest")) {
      return Response.json({
        ok: true,
        snapshotStoreAvailable: true,
        snapshot: {
          repoSlug,
          revisionWatermark: recordsByKey.size,
          objectKey: `${repoSlug}/${recordsByKey.size}/fixture.tar.gz`,
          bytes: archive.byteLength,
          uncompressedBytes: [...recordsByKey.values()].reduce(
            (sum, content) => sum + Buffer.byteLength(content),
            0,
          ),
          fileCount: recordsByKey.size,
          createdAt: "2026-07-26T00:00:00.000Z",
          access: { mode: "worker_range_proxy", maxChunkBytes: 32 * 1024 * 1024 },
        },
      });
    }
    if (url.pathname.endsWith("/snapshots/chunk")) {
      stats.chunkRequests += 1;
      const offset = body.offset ?? 0;
      const length = Math.min(body.length ?? archive.byteLength, archive.byteLength - offset);
      return new Response(archive.subarray(offset, offset + length), {
        status: 206,
        headers: {
          "content-range": `bytes ${offset}-${offset + length - 1}/${archive.byteLength}`,
        },
      });
    }
    assert.equal(body.cursor, 0);
    const records: WorkerRecord[] = [...recordsByKey.entries()].map(([key, content], index) => {
      const [section, id] = key.split("/") as [WorkerRecord["section"], string];
      return {
        section,
        id,
        content,
        digest: createHash("sha256").update(content).digest("hex"),
        revision: 0,
        storeRevision: index + 1,
        deleted: false,
      };
    });
    const journalRecords: WorkerRecord[] = body.sinceRevision
      ? journal.map((record, index) => ({
          ...record,
          digest: createHash("sha256").update(record.content).digest("hex"),
          revision: records.length + index + 1,
          storeRevision: records.length + index + 1,
          deleted: false,
        }))
      : records;
    return Response.json({
      repoSlug,
      revision: records.length + journal.length,
      records: journalRecords,
      nextCursor: null,
    });
  };
}

function snapshotArchive(recordsByKey: Map<string, string>) {
  const chunks: Buffer[] = [];
  for (const [key, content] of recordsByKey) {
    const [section, id] = key.split("/");
    const extension = section === "decision-packets" ? ".json" : ".md";
    const bytes = Buffer.from(content);
    chunks.push(testTarHeader(`${section}/${id}${extension}`, bytes.byteLength), bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function testTarHeader(name: string, size: number) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeOctal(target: Buffer, offset: number, length: number, value: number) {
  target.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  target[offset + length - 1] = 0;
}

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}
