// Hydrates one repository through the real materializeWorkerRecords of the
// checkout passed as argv[2], against a fixture Worker: a one-record stored
// snapshot plus a large journal delta, paged like the production export route.
// Usage: node --max-old-space-size=<MiB> hydrate-child.mjs <checkout> <records> <recordKiB> <recordsPerPage>
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, recordsArg, kibArg, perPageArg] = process.argv.slice(2);
const total = Number(recordsArg);
const recordBytes = Number(kibArg) * 1024;
const perPage = Number(perPageArg);
const records = await import(pathToFileURL(path.join(checkout, "scripts/worker-records.ts")).href);
const repoSlug = "openclaw-openclaw";
const root = mkdtempSync(path.join(tmpdir(), "record-hydration-proof-"));

// Sampled on every fixture request: hydration never yields to timers between pages.
let peakHeap = 0;
const sampleHeap = () => {
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
};

try {
  // A one-record stored snapshot at watermark 10; the delta carries the rest.
  const snapshotTree = path.join(root, "snapshot");
  mkdirSync(path.join(snapshotTree, "items"), { recursive: true });
  writeFileSync(path.join(snapshotTree, "items", "999999.md"), "snapshot record\n");
  const packed = await records.packWorkerRecordSnapshot({
    repoRoot: snapshotTree,
    archivePath: path.join(root, "snapshot.tar.gz"),
  });
  const archive = readFileSync(packed.archivePath);

  // Backfill-shaped content: a front matter with one large review_record line.
  const content = (id) => {
    const head = `---\nnumber: ${id}\nreview_record: `;
    return `${head}${"r".repeat(Math.max(0, recordBytes - head.length - 6))}\n---\n`;
  };
  const pages = Math.ceil(total / perPage);
  let exportRequests = 0;
  const fetchFixture = async (input, init) => {
    sampleHeap();
    const endpoint = new URL(String(input)).pathname;
    if (endpoint.endsWith("/latest"))
      return Response.json({
        snapshotStoreAvailable: true,
        snapshot: {
          repoSlug,
          revisionWatermark: 10,
          objectKey: "fixture",
          ...packed,
          createdAt: new Date().toISOString(),
          access: { mode: "worker_range_proxy", maxChunkBytes: 1024 * 1024 },
        },
      });
    if (endpoint.endsWith("/chunk")) {
      const { offset, length } = JSON.parse(String(init?.body));
      return new Response(archive.subarray(offset, offset + length), {
        status: 206,
        headers: { "content-range": `bytes ${offset}-${offset + length - 1}/${archive.length}` },
      });
    }
    if (endpoint.endsWith("/list"))
      return Response.json({ repoSlug, section: "items", records: [], nextCursor: null });
    exportRequests += 1;
    const cursor = Number(JSON.parse(String(init?.body)).cursor);
    const page = [];
    for (let index = cursor * perPage; index < Math.min(total, (cursor + 1) * perPage); index++) {
      const id = index + 1;
      const body = content(id);
      page.push({
        section: "items",
        id: String(id),
        content: body,
        digest: createHash("sha256").update(body).digest("hex"),
        revision: 2,
        storeRevision: 10 + id,
        deleted: false,
      });
    }
    return Response.json({
      repoSlug,
      revision: 10 + total,
      records: page,
      nextCursor: cursor + 1 < pages ? cursor + 1 : null,
    });
  };

  const startedAt = Date.now();
  const hydrated = await records.materializeWorkerRecords({
    worktreeRoot: path.join(root, "worktree"),
    baseUrl: "http://127.0.0.1:8787",
    webhookSecret: "synthetic-hydration-proof-secret",
    repoSlugs: [repoSlug],
    fetch: fetchFixture,
    log: () => {},
  });
  const items = path.join(hydrated.recordsRoot, repoSlug, "items");
  const files = readdirSync(items);
  let exact = 0;
  for (const id of [1, Math.ceil(total / 2), total]) {
    if (readFileSync(path.join(items, `${id}.md`), "utf8") === content(id)) exact += 1;
  }
  sampleHeap();
  console.log(
    JSON.stringify({
      outcome: "hydrated",
      materializedFiles: files.length,
      deltaRecords: hydrated.repositories[repoSlug].deltaRecords,
      sampledExactContents: `${exact}/3`,
      exportRequests,
      journalBytes: total * recordBytes,
      peakHeapMiB: Math.round(peakHeap / 1024 / 1024),
      elapsedMs: Date.now() - startedAt,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
