import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { materializeWorkerRecords } from "../../../scripts/worker-records.ts";

const root = mkdtempSync(path.join(tmpdir(), "snapshot-resume-proof-"));
const secret = "synthetic-snapshot-resume-secret";
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const nonce = randomUUID();
const child = spawn("corepack", ["pnpm", "dlx", "--allow-build", "esbuild", "--allow-build", "sharp",
  "--allow-build", "workerd", "wrangler@4.131.1", "dev", "--config",
  "docs/proof/snapshot-resume/wrangler.toml", "--local", "--persist-to", path.join(root, "state"),
  "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--var", `PROOF_NONCE:${nonce}`],
{ detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
  PATH: process.env.PATH, HOME: process.env.HOME, CI: "1", WRANGLER_SEND_METRICS: "false",
  SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
} });
let diagnostics = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
  diagnostics = (diagnostics + chunk).slice(-8000);
});
const exited = once(child, "exit");
let cleanupPromise;
function signalChildGroup(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function cleanup() {
  return cleanupPromise ??= (async () => {
    signalChildGroup("SIGTERM");
    const forceStop = setTimeout(() => signalChildGroup("SIGKILL"), 5000);
    try { await exited; } finally {
      clearTimeout(forceStop);
      // The wrapper can exit before workerd; kill any remaining owned descendants.
      signalChildGroup("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  })();
}
for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    cleanup().then(() => process.exit(exitCode), (error) => {
      console.error(error);
      process.exit(1);
    });
  });
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`local Worker exited: ${diagnostics}`);
    try {
      const response = await fetch(baseUrl + "/__proof/ready", { signal: AbortSignal.timeout(1000) });
      ready = response.ok && (await response.json()).nonce === nonce;
      if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(ready, `local Worker ready: ${diagnostics}`);
  const truth = new Map();
  const write = async (writes) => {
    for (let index = 0; index < writes.length; index += 100) {
      const batch = writes.slice(index, index + 100).map(({ id, content }) => ({
        id, content, digest: content === null ? null : createHash("sha256").update(content).digest("hex"),
      }));
      const response = await fetch(baseUrl + "/__proof/write", { method: "POST", body: JSON.stringify(batch) });
      assert.equal(response.status, 200, await response.clone().text());
      for (const { id, content } of batch) content === null ? truth.delete(id) : truth.set(id, content);
    }
  };
  const run = promisify(execFile);
  const snapshotCli = async (budgetSeconds) => {
    const args = ["scripts/worker-records.ts", "snapshot-upload", "--repo-slug", "fixture-repo", "--records-url", baseUrl];
    if (budgetSeconds !== undefined) args.push("--replay-budget-seconds", String(budgetSeconds));
    const { stdout } = await run(process.execPath, args, {
      encoding: "utf8", env: { PATH: process.env.PATH, CLAWSWEEPER_RECORDS_SECRET: secret }, timeout: 300_000,
    });
    return JSON.parse(stdout);
  };
  let readers = 0;
  const assertReader = async () => {
    const hydrated = await materializeWorkerRecords({ baseUrl, webhookSecret: secret, repoSlugs: ["fixture-repo"],
      worktreeRoot: path.join(root, `reader-${++readers}`), trackCoverage: false, log: () => {} });
    const items = path.join(hydrated.recordsRoot, "fixture-repo", "items");
    const files = readdirSync(items).sort();
    assert.deepEqual(files, [...truth.keys()].map((id) => `${id}.md`).sort());
    for (const [id, content] of truth) assert.equal(readFileSync(path.join(items, `${id}.md`), "utf8"), content);
    return hydrated.repositories["fixture-repo"];
  };

  await write(Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, content: `# Item ${i + 1}\r\nUnicode 🦞\n` })));
  const base = await snapshotCli();
  assert.equal(base.replay.complete, true);
  await assertReader();
  // Backlog: every stored identity rewritten plus 4,000 new ones.
  await write(Array.from({ length: 6000 }, (_, i) => ({ id: i + 1, content: `# Item ${i + 1} backlog\n` })));
  const unbudgetedReplay = Date.now();
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const runs = [];
  for (;;) {
    assert.ok(runs.length < 80, "converges within a bounded number of runs");
    const pending = snapshotCli(2);
    // Writes land while the producer replays: rewrites, deletes and creations.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await write(Array.from({ length: 50 }, (_, i) => {
      const id = 1 + Math.floor(random() * 6500);
      return { id, content: random() < 0.2 && truth.has(id) ? null : `# Item ${id} run ${runs.length + 1} write ${i}\n` };
    }));
    const snapshot = await pending;
    if (runs.length) assert.ok(snapshot.revisionWatermark > runs.at(-1).revisionWatermark, "watermark advances");
    const reader = await assertReader();
    runs.push({ revisionWatermark: snapshot.revisionWatermark, complete: snapshot.replay.complete,
      replayedRecords: snapshot.replay.replayedRecords, fileCount: snapshot.fileCount,
      readerDelta: reader.deltaRecords, hydrateMs: snapshot.replay.durationsMs.hydrate });
    if (snapshot.replay.complete) break;
  }
  const final = runs.at(-1);
  assert.ok(runs.length > 1, "the backlog needed more than one budgeted run");
  console.log(JSON.stringify({ source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDigest: createHash("sha256").update(readFileSync("scripts/worker-records.ts")).digest("hex"),
    runtime: "workerd local SQLite/R2 via wrangler 4.131.1 dev --local", node: process.version,
    backlogChanges: 6000, syntheticExportPageDelayMs: 300, concurrentWritesPerRun: 50, budgetSeconds: 2, runs: runs.length,
    finalLiveRecords: truth.size, finalFileCount: final.fileCount, everyReaderExact: true,
    elapsedMs: Date.now() - unbudgetedReplay, perRun: runs,
    limit: "controlled loopback fixture; proves resume correctness and convergence, not production throughput" }));
} finally {
  await cleanup();
}
