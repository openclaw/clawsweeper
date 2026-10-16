import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "apply-result-proof-"));
const secret = process.env.APPLY_PROOF_SECRET || "isolated-apply-proof";
let origin = process.env.APPLY_PROOF_ORIGIN;
let server;
let db;
try {
  // The optional origin exercises workerd; the default exercises the same
  // production handlers over HTTP with real SQLite storage, without deployment.
  if (!origin) {
    const { default: worker, StatusStore } = await import("../../../dashboard/worker.ts");
    db = new DatabaseSync(join(scratch, "status.sqlite"));
    db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    let alarm = null;
    const storage = {
      get: async (key) => {
        const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
        return row ? JSON.parse(row.value) : undefined;
      },
      put: async (key, value) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(key, JSON.stringify(value)),
      delete: async (key) => db.prepare("DELETE FROM kv WHERE key = ?").run(key),
      list: async ({ prefix = "", limit } = {}) => new Map(db.prepare("SELECT key, value FROM kv ORDER BY key").all()
        .filter(row => row.key.startsWith(prefix)).slice(0, limit).map(row => [row.key, JSON.parse(row.value)])),
      getAlarm: async () => alarm,
      setAlarm: async (value) => { alarm = value; },
    };
    const store = new StatusStore({ storage });
    const env = {
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      APPLY_TARGET_REPOS: "openclaw/openclaw",
      STATUS_STORE: { idFromName: name => name, get: () => store },
    };
    server = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const result = await worker.fetch(new Request(`${origin}${request.url}`, {
          method: request.method,
          headers: request.headers,
          ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
        }), env);
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname), "proof origin must be isolated loopback");
  const producer = join(root, "scripts/publish-apply-observability.mjs");
  const health = join(scratch, "health.json");
  await writeFile(health, JSON.stringify({ closed: 2, comment_synced: 3 }));
  const started = new Date(Date.now() - 60_000).toISOString();
  const publish = (id, outcome, withHealth = false, lifecycle = true) => run(process.execPath,
    [producer, ...(withHealth ? ["--health-file", health] : [])], {
      cwd: scratch,
      env: {
        TARGET_REPO: "openclaw/openclaw", GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: "1", APPLY_OUTCOME: outcome,
        ...(lifecycle ? { APPLY_STARTED_AT: started } : {}),
        QUEUE_URL: origin, CLAWSWEEPER_WEBHOOK_SECRET: secret,
      },
    });
  const summary = async () => {
    const response = await fetch(`${origin}/api/apply-observability?range=24h`);
    assert.equal(response.status, 200);
    return response.json();
  };
  await publish("1001", "success", true);
  const measured = await summary();
  assert.equal(measured.totals.applied, 5);
  assert.equal(measured.totals.closed, 2);
  assert.deepEqual(measured.result_coverage.totals.fields.applied, { measured_events: 1, missing_events: 0 });
  await publish("1002", "failure");
  const missing = await summary();
  assert.equal(missing.telemetry_complete, true);
  assert.equal(missing.totals.applied, null);
  assert.deepEqual(missing.result_coverage.totals.fields.applied, { measured_events: 1, missing_events: 1 });
  await publish("1003", "failure", false, false);
  await publish("1004", "in_progress");
  const mixed = await summary();
  assert.equal(mixed.event_count, 4);
  assert.equal(mixed.telemetry_complete, true);
  assert.equal(mixed.result_coverage.totals.completed_lifecycle_events, 2);
  assert.deepEqual(mixed.result_coverage.totals, missing.result_coverage.totals);
  assert.equal(mixed.totals.applied, null);
  assert.equal(mixed.totals.closed, null);
  assert.equal(mixed.result_coverage.totals.fields.arrivals.measured_events, 0);
  assert.equal(Object.hasOwn(mixed, "repositories"), false);
  const { summarizeOperations } = await import("../../../dashboard-site/scripts/operations.ts");
  const operations = summarizeOperations({}, mixed, {}, Date.now());
  assert.deepEqual(operations.apply.day.resultCoverage, { completed: 2, applied: 1, closed: 1 });
  assert.equal(operations.apply.day.observationsCurrent, true);
  const { stdout: head } = await run("git", ["rev-parse", "HEAD"], { cwd: root });
  const { stdout: diff } = await run("git", ["diff", "HEAD", "--binary", "--", "dashboard", "dashboard-site", "scripts/publish-apply-observability.mjs"], { cwd: root });
  const sourcePaths = [
    "dashboard/worker.ts",
    "dashboard/apply-observability.ts",
    "dashboard/public-observability.ts",
    "dashboard-site/scripts/operations.ts",
    "scripts/publish-apply-observability.mjs",
    "docs/proof/apply-result-completeness/run-proof.mjs",
  ];
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [
    path, createHash("sha256").update(await readFile(join(root, path))).digest("hex"),
  ])));
  console.log(JSON.stringify({
    status: "passed", head: head.trim(), diff_sha256: createHash("sha256").update(diff).digest("hex"),
    source_sha256: sourceHashes,
    runtime: process.version, transport: "loopback HTTP",
    worker: server ? "production Worker.fetch + StatusStore; SQLite KV adapter" : "external isolated Worker",
    stages: { measured: measured.result_coverage.totals, missing: missing.result_coverage.totals, mixed: mixed.result_coverage.totals },
    totals: mixed.totals, operations: operations.apply.day,
    limits: ["Synthetic events; no production actions or performance claim.", ...(server ? ["Cloudflare scheduling and storage adapter are not exercised."] : [])],
  }, null, 2));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  db?.close();
  await rm(scratch, { recursive: true, force: true });
}
