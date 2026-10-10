// Publishes a whole records/<repo> request through the real
// publishMainWithStateAppend of the checkout in argv[2], against a large source
// tree and an equally large hydrated state tree that differ in three tuples.
// Usage: node --max-old-space-size=<MiB> publish-child.mjs <checkout> <items> <itemKiB>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, itemsArg, kibArg] = process.argv.slice(2);
const items = Number(itemsArg);
const itemBytes = Number(kibArg) * 1024;
const { publishMainWithStateAppend } = await import(
  pathToFileURL(path.join(checkout, "dist/repair/publish-main.js")).href
);
const tupleRoot = "records/openclaw-openclaw";
const scratch = mkdtempSync(path.join(tmpdir(), "publish-main-proof-"));
const root = path.join(scratch, "source");
const stateRoot = path.join(scratch, "state");
const write = (base, file, content) => {
  const target = path.join(base, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};
// Backfill-shaped records: front matter with one large review_record line.
const record = (number, body) => {
  const head = `---\nrepo: openclaw/openclaw\nnumber: ${number}\nreview_record: `;
  const tail = `\n---\n\n${body}\n`;
  return `${head}${"r".repeat(Math.max(0, itemBytes - head.length - tail.length))}${tail}`;
};

let peakHeap = 0;
const sampleHeap = () => {
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
};
try {
  for (let number = 1; number <= items; number += 1) {
    const body = record(number, "unchanged");
    write(stateRoot, `${tupleRoot}/items/${number}.md`, body);
    write(root, `${tupleRoot}/items/${number}.md`, body);
  }
  write(root, `${tupleRoot}/items/1.md`, record(1, "updated by apply"));
  write(root, `${tupleRoot}/items/2.md`, record(2, "updated by apply"));
  rmSync(path.join(root, `${tupleRoot}/items/3.md`));
  write(root, `${tupleRoot}/closed/3.md`, record(3, "closed by apply"));

  const posted = [];
  const startedAt = Date.now();
  const result = await publishMainWithStateAppend(
    { message: "chore: apply sweep decisions checkpoint 1", paths: [tupleRoot] },
    {
      root,
      env: {
        QUEUE_URL: "https://queue.test",
        CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-publish-proof-secret",
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        CLAWSWEEPER_STATE_DIR: stateRoot,
      },
      fetchImpl: async (_input, init) => {
        sampleHeap();
        posted.push(String(JSON.parse(String(init?.body ?? "")).key));
        return Response.json(
          { ok: true, accepted: true, deduped: false, revision: 7, sequence: 11 },
          { status: 202 },
        );
      },
      publishGit: () => {
        throw new Error("publish-main must not fall back to git for record tuples");
      },
    },
  );
  sampleHeap();
  console.log(
    JSON.stringify({
      outcome: result,
      postedTuples: posted.sort(),
      treeMiB: Math.round((items * itemBytes) / 1024 / 1024),
      peakHeapMiB: Math.round(peakHeap / 1024 / 1024),
      elapsedMs: Date.now() - startedAt,
    }),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
