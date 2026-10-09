import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { materializeWorkerRecords, WorkerSnapshotUnavailableError } from "../../../scripts/worker-records.ts";

const root = mkdtempSync(path.join(tmpdir(), "snapshot-bootstrap-proof-"));
const secret = "synthetic-snapshot-bootstrap-secret";
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const nonce = randomUUID();
const child = spawn("corepack", ["pnpm", "dlx", "--allow-build", "esbuild", "--allow-build", "sharp",
  "--allow-build", "workerd", "wrangler@4.131.1", "dev", "--config",
  "docs/proof/snapshot-bootstrap/wrangler.toml", "--local", "--persist-to", path.join(root, "state"),
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
  const rows = Array.from({ length: 2001 }, (_, index) => {
    const content = `# Synthetic ${index + 1}\r\nUnicode 🦞\n`;
    return { id: index + 1, content, digest: createHash("sha256").update(content).digest("hex") };
  });
  for (let index = 0; index < rows.length; index += 100) {
    const response = await fetch(baseUrl + "/__proof/seed", { method: "POST", body: JSON.stringify(rows.slice(index, index + 100)) });
    assert.equal(response.status, 200, await response.clone().text());
  }
  const options = { baseUrl, webhookSecret: secret, repoSlugs: ["fixture-repo"], worktreeRoot: path.join(root, "reader"), log: () => {} };
  await assert.rejects(materializeWorkerRecords(options), (error) => error instanceof WorkerSnapshotUnavailableError && error.detail.code === "cold_hydration_bound_exceeded");
  const snapshot = JSON.parse(execFileSync(process.execPath, ["scripts/worker-records.ts", "snapshot-upload", "--repo-slug", "fixture-repo", "--records-url", baseUrl], {
    encoding: "utf8", env: { PATH: process.env.PATH, CLAWSWEEPER_RECORDS_SECRET: secret },
    stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
  }));
  assert.equal(snapshot.fileCount, rows.length);
  assert.equal(snapshot.revisionWatermark, rows.length);
  const hydrated = await materializeWorkerRecords(options);
  for (const row of rows) assert.deepEqual(readFileSync(path.join(hydrated.recordsRoot, "fixture-repo", "items", `${row.id}.md`)), Buffer.from(row.content));
  console.log(JSON.stringify({ source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDigest: createHash("sha256").update(readFileSync("scripts/worker-records.ts")).digest("hex"),
    runtime: "workerd local SQLite/R2", node: process.version, records: rows.length,
    coldReader: "refused", snapshotCli: "registered", hydratedBytes: "exact", revisionWatermark: snapshot.revisionWatermark,
    limit: "controlled loopback fixture; no production Cloudflare throughput claim" }));
} finally {
  await cleanup();
}
