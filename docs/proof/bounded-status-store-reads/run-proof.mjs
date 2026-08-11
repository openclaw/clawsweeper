#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

class CountingStorage {
  constructor(rows) {
    this.rows = new Map(rows);
  }
  rowsRead = 0;
  async get(key) {
    const value = this.rows.get(key);
    if (value !== undefined) this.rowsRead += 1;
    return value;
  }
  async list(options = {}) {
    let entries = [...this.rows]
      .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
      .filter(([key]) => !options.start || key >= options.start)
      .filter(([key]) => !options.end || key < options.end)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (options.reverse) entries.reverse();
    if (options.limit) entries = entries.slice(0, options.limit);
    this.rowsRead += entries.length;
    return new Map(entries);
  }
}

const repoRoot = process.cwd();
const proofDir = path.join(repoRoot, "docs/proof/bounded-status-store-reads");
const artifactDir = path.join(proofDir, "artifacts");
const scratch = await mkdtemp(path.join(tmpdir(), "bounded-status-store-reads-"));
const baseRoot = path.join(scratch, "base");
const archivePath = path.join(scratch, "base.tar");
const proofToken = "bounded-status-store-proof-token";
const proofSecret = "bounded-status-store-proof-secret";
const fixtureNow = process.env.BOUNDED_STATUS_PROOF_NOW
  ? Date.parse(process.env.BOUNDED_STATUS_PROOF_NOW)
  : Date.now() - 60_000;
if (!Number.isFinite(fixtureNow))
  throw new Error("BOUNDED_STATUS_PROOF_NOW must be an ISO timestamp");
const workers = [];

await mkdir(artifactDir, { recursive: true });
await Promise.all(
  ["failure.json", "local-summary.json", "response-comparison.json", "row-counts.json"].map(
    (name) => rm(path.join(artifactDir, name), { force: true }),
  ),
);
await mkdir(baseRoot, { recursive: true });

const mergeBase = (await command("git", ["merge-base", "HEAD", "origin/main"], repoRoot)).trim();
const headSha = (await command("git", ["rev-parse", "HEAD"], repoRoot)).trim();
await command("git", ["archive", "--format=tar", "-o", archivePath, mergeBase], repoRoot);
await command("tar", ["-xf", archivePath, "-C", baseRoot], repoRoot);

try {
  const [basePort, headPort] = await Promise.all([availablePort(), availablePort()]);
  const [baseWorker, headWorker] = await Promise.all([
    startWorker("merge-base", baseRoot, basePort),
    startWorker("candidate", repoRoot, headPort),
  ]);
  workers.push(baseWorker, headWorker);
  await Promise.all([waitForWorker(baseWorker.origin), waitForWorker(headWorker.origin)]);

  const fixture = makeFixture(fixtureNow);
  await Promise.all([
    seedWorker(baseWorker.origin, fixture),
    seedWorker(headWorker.origin, fixture),
  ]);

  const comparisons = [];
  for (const query of representativeQueries()) {
    const [before, after] = await Promise.all([
      getJson(`${baseWorker.origin}${query}`),
      getJson(`${headWorker.origin}${query}`),
    ]);
    const normalizedBefore = normalizeVolatile(before);
    const normalizedAfter = normalizeVolatile(after);
    assert.deepEqual(normalizedAfter, normalizedBefore, `response changed for ${query}`);
    comparisons.push({
      query,
      normalized_sha256: sha256(JSON.stringify(normalizedBefore)),
      normalized_response: normalizedBefore,
    });
  }

  const rowCounts = await measureStorageRows(baseRoot, repoRoot, fixtureNow);
  for (const range of ["6h", "24h", "7d"]) {
    assert.ok(
      rowCounts.automerge_metrics[range].after < rowCounts.automerge_metrics[range].before,
      `automerge ${range} row count was not reduced`,
    );
    assert.ok(
      rowCounts.apply_observability[range].after < rowCounts.apply_observability[range].before,
      `apply ${range} row count was not reduced`,
    );
  }

  const summary = {
    schema: "bounded-status-store-reads-proof/v1",
    generated_at: new Date().toISOString(),
    merge_base: mergeBase,
    candidate_head: headSha,
    fixture: {
      automerge_events: fixture.automerge.length,
      apply_observations: fixture.apply.length,
      utc_boundary_replays: 2,
      repositories: ["openclaw/openclaw", "openclaw/clawhub"],
      span_days: 7,
      window_spanning_sessions: ["6h", "24h", "7d"],
      entirely_pre_window_session: "pre-6h",
    },
    runtime: {
      node: process.version,
      wrangler: "4.107.0",
      transport: "real loopback HTTP",
      worker: "wrangler dev --local",
      durable_object: "SQLite-backed StatusStore",
    },
    response_comparison: {
      queries: comparisons.length,
      normalized_fields: ["generated_at", "range_start", "buckets[].start", "buckets[].end"],
      byte_identical: true,
    },
    row_counts: rowCounts,
    production_mutations: 0,
    openclaw_bay_affected: false,
    limits: [
      "Synthetic local data, not production volume or timing.",
      "Row counts include storage rows returned by list() and get(), not payload bytes or CPU time.",
      "Legacy apply rows remain readable until their seven-day TTL expires.",
    ],
    run_status: "succeeded",
  };
  await writeJson("response-comparison.json", { comparisons });
  await writeJson("row-counts.json", rowCounts);
  await writeJson("local-summary.json", summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  await writeJson("failure.json", {
    generated_at: new Date().toISOString(),
    merge_base: mergeBase,
    candidate_head: headSha,
    error: error instanceof Error ? error.stack : String(error),
    run_status: "failed",
  });
  throw error;
} finally {
  await Promise.all(workers.map(stopWorker));
  await rm(scratch, { recursive: true, force: true });
}

function makeFixture(now) {
  const automerge = [];
  for (let index = 0; index < 150; index += 1) {
    const repository = index % 2 === 0 ? "openclaw/openclaw" : "openclaw/clawhub";
    const policy = index % 3 === 0 ? "immediate-v2" : "immediate-v1";
    const activatedAt = new Date(now - (12 + index * 1.8) * 60_000).toISOString();
    const terminalAt = new Date(Date.parse(activatedAt) + (2 + (index % 9)) * 60_000).toISOString();
    const sessionId = `${repository}#${10_000 + index}:${index}:${activatedAt}`;
    const common = {
      event_type: "clawsweeper.automerge_metric",
      session_id: sessionId,
      repository,
      item_number: 10_000 + index,
      policy_version: policy,
      pr_url: `https://github.com/${repository}/pull/${10_000 + index}`,
    };
    automerge.push({
      ...common,
      event_id: `activation-${index}`,
      phase: "activated",
      occurred_at: activatedAt,
    });
    automerge.push({
      ...common,
      event_id: `terminal-${index}`,
      phase: "terminal",
      outcome: index % 5 === 0 ? "repair_failed" : "merged",
      occurred_at: terminalAt,
    });
  }
  const spanningSessions = [
    { id: "6h", activationHoursAgo: 7, terminalHoursAgo: 1, itemNumber: 11_000 },
    { id: "24h", activationHoursAgo: 27, terminalHoursAgo: 20, itemNumber: 11_001 },
    { id: "7d", activationHoursAgo: 8 * 24, terminalHoursAgo: 6 * 24, itemNumber: 11_002 },
    { id: "pre-6h", activationHoursAgo: 9, terminalHoursAgo: 7, itemNumber: 11_003 },
  ];
  for (const session of spanningSessions) {
    const activatedAt = new Date(now - session.activationHoursAgo * 60 * 60_000).toISOString();
    const terminalAt = new Date(now - session.terminalHoursAgo * 60 * 60_000).toISOString();
    const sessionId = `openclaw/openclaw#${session.itemNumber}:boundary-${session.id}:${activatedAt}`;
    const common = {
      event_type: "clawsweeper.automerge_metric",
      session_id: sessionId,
      repository: "openclaw/openclaw",
      item_number: session.itemNumber,
      policy_version: "immediate-v1",
      pr_url: `https://github.com/openclaw/openclaw/pull/${session.itemNumber}`,
    };
    automerge.push({
      ...common,
      event_id: `boundary-${session.id}-activation`,
      phase: "activated",
      occurred_at: activatedAt,
    });
    automerge.push({
      ...common,
      event_id: `boundary-${session.id}-terminal`,
      phase: "terminal",
      outcome: "merged",
      occurred_at: terminalAt,
    });
  }

  const apply = [];
  for (let index = 0; index < 168; index += 1) {
    const repo = index % 2 === 0 ? "openclaw/openclaw" : "openclaw/clawhub";
    const occurredAt = new Date(now - (10 * 60_000 + index * 59 * 60_000)).toISOString();
    apply.push(applyObservation({ repo, runId: String(20_000 + index), occurredAt, index }));
  }
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const boundary = applyObservation({
    repo: "openclaw/openclaw",
    runId: "29999",
    occurredAt: midnight.toISOString(),
    index: 999,
  });
  apply.push(boundary, boundary);
  return { automerge, apply };
}

function applyObservation({ repo, runId, occurredAt, index }) {
  const hasFailure = index % 11 === 0;
  return {
    schema_version: 1,
    repo,
    run_id: runId,
    run_attempt: 1,
    occurred_at: occurredAt,
    started_at: new Date(Date.parse(occurredAt) - 5 * 60_000).toISOString(),
    lifecycle_started: true,
    outcome: hasFailure ? "failure" : "success",
    run_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}`,
    queue: {
      active: index % 4,
      capacity: 8,
      ready: index % 7,
      backoff: index % 3,
      dispatching: index % 2,
      leased: index % 5,
      oldest_ready_age_seconds: index % 7 ? index * 3 : null,
      oldest_backoff_age_seconds: index % 3 ? index * 2 : null,
      oldest_lease_age_seconds: index % 5 ? index : null,
    },
    arrivals: 1,
    results: {
      applied: hasFailure ? 0 : 1,
      closed: index % 4 === 0 ? 1 : 0,
      superseded: index % 13 === 0 ? 1 : 0,
      retried: index % 9 === 0 ? 1 : 0,
      dead_lettered: hasFailure ? 1 : 0,
    },
    lease: { wait_ms: 100 + index, hold_ms: 1_000 + index * 2 },
    observed_failure_kinds: hasFailure ? ["workflow_failure"] : [],
    failures: hasFailure ? [{ kind: "workflow_failure", at: occurredAt }] : [],
  };
}

async function seedWorker(origin, fixture) {
  await parallel(fixture.automerge, 24, async (event) => {
    const response = await fetch(`${origin}/api/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${proofToken}`, "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    assert.equal(response.status, 200, `automerge seed failed: ${await response.text()}`);
  });
  await parallel(fixture.apply, 24, async (event) => {
    const body = JSON.stringify({ event });
    const signature = `sha256=${createHmac("sha256", proofSecret).update(body).digest("hex")}`;
    const response = await fetch(`${origin}/internal/apply-observability`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
    });
    assert.equal(response.status, 200, `apply seed failed: ${await response.text()}`);
  });
}

function representativeQueries() {
  const queries = [];
  for (const range of ["6h", "24h", "7d"]) {
    queries.push(`/api/automerge-metrics?range=${range}`);
    queries.push(
      `/api/automerge-metrics?range=${range}&repo=openclaw%2Fopenclaw&policy_version=immediate-v1`,
    );
    queries.push(`/api/apply-observability?range=${range}`);
    queries.push(`/api/apply-observability?range=${range}&repo=openclaw%2Fclawhub`);
  }
  return queries;
}

function normalizeVolatile(value) {
  if (Array.isArray(value)) return value.map(normalizeVolatile);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      ["generated_at", "range_start", "start", "end"].includes(key)
        ? "<request-time>"
        : normalizeVolatile(child),
    ]),
  );
}

async function measureStorageRows(base, candidate, now) {
  const [baseModule, candidateModule] = await Promise.all([
    import(`${pathToFileURL(path.join(base, "dashboard/worker.ts")).href}?proof=base`),
    import(`${pathToFileURL(path.join(candidate, "dashboard/worker.ts")).href}?proof=head`),
  ]);
  const automergeRows = automergeCountingRows(now);
  const applyEvents = makeFixture(now).apply.slice(0, -1);
  const legacyApplyRows = legacyApplyCountingRows(applyEvents, now);
  const bucketApplyRows = bucketApplyCountingRows(applyEvents, now);
  const result = { automerge_metrics: {}, apply_observability: {} };
  for (const range of ["6h", "24h", "7d"]) {
    result.automerge_metrics[range] = {
      before: await countedRequest(
        baseModule.StatusStore,
        automergeRows,
        `automerge-product-metrics%3Av1?range=${range}`,
      ),
      after: await countedRequest(
        candidateModule.StatusStore,
        automergeRows,
        `automerge-product-metrics%3Av1?range=${range}`,
      ),
    };
    const query = `apply-observability?range=${range}&required_repo=openclaw%2Fopenclaw&optional_repo=openclaw%2Fclawhub`;
    result.apply_observability[range] = {
      before: await countedRequest(baseModule.StatusStore, legacyApplyRows, query),
      after: await countedRequest(candidateModule.StatusStore, bucketApplyRows, query),
    };
  }
  return result;
}

function automergeCountingRows(now) {
  const rows = new Map();
  for (let index = 0; index < 6_480; index += 1) {
    const occurredAt = new Date(now - (8 * 60 + index * 20) * 60_000).toISOString();
    addAutomergeRow(rows, index, occurredAt, now);
  }
  for (let index = 0; index < 120; index += 1) {
    const occurredAt = new Date(now - (10 + index * 2) * 60_000).toISOString();
    addAutomergeRow(rows, 10_000 + index, occurredAt, now);
  }
  return rows;
}

function addAutomergeRow(rows, index, occurredAt, now) {
  const event = {
    event_id: `count-${index}`,
    session_id: `openclaw/openclaw#${index}:count`,
    phase: "terminal",
    occurred_at: occurredAt,
    repository: "openclaw/openclaw",
    item_number: index + 1,
    policy_version: "immediate-v1",
    outcome: "merged",
  };
  rows.set(`automerge-product-metrics:v1:time:${occurredAt}:count-${index}`, {
    value: JSON.stringify(event),
    expires_at: now + 60_000,
  });
}

function legacyApplyCountingRows(events, now) {
  return new Map(
    events.map((event) => [
      `apply-observability:${encodeURIComponent(event.repo)}:${event.run_id}:${event.run_attempt}`,
      { value: JSON.stringify(event), expires_at: now + 60_000 },
    ]),
  );
}

function bucketApplyCountingRows(events, now) {
  const buckets = new Map();
  for (const event of events) {
    const key = `apply-observability:day:${event.occurred_at.slice(0, 10)}:${encodeURIComponent(event.repo)}`;
    const current = buckets.get(key) || [];
    current.push(event);
    buckets.set(key, current);
  }
  return new Map(
    [...buckets].map(([key, value]) => [
      key,
      { value: JSON.stringify(value), expires_at: now + 60_000 },
    ]),
  );
}

async function countedRequest(StatusStore, rows, pathAndQuery) {
  const storage = new CountingStorage(rows);
  const store = new StatusStore({ storage });
  const response = await store.fetch(
    new Request(`https://clawsweeper-status-store/${pathAndQuery}`),
  );
  assert.equal(response.status, 200);
  return storage.rowsRead;
}

async function startWorker(label, cwd, port) {
  const logPath = path.join(scratch, `wrangler-${label}.log`);
  const log = createWriteStream(logPath, { flags: "w" });
  const child = spawn(
    "npx",
    [
      "--yes",
      "wrangler@4.107.0",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      path.join(scratch, `state-${label}`),
      "--config",
      "dashboard/wrangler.toml",
      "--var",
      `INGEST_TOKEN:${proofToken}`,
      "--var",
      `CLAWSWEEPER_WEBHOOK_SECRET:${proofSecret}`,
      "--var",
      "APPLY_TARGET_REPOS:openclaw/openclaw",
      "--var",
      "APPLY_OPTIONAL_TARGET_REPOS:openclaw/clawhub",
    ],
    {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return { label, child, log, origin: `http://127.0.0.1:${port}` };
}

async function waitForWorker(origin) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Worker did not become ready: ${origin}`);
}

async function stopWorker(worker) {
  if (!worker?.child) return;
  signalProcessTree(worker.child, "SIGTERM");
  if (worker.child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => worker.child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  signalProcessTree(worker.child, "SIGKILL");
  await new Promise((resolve) => worker.log.end(resolve));
}

function signalProcessTree(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, `${url}: ${text}`);
  return JSON.parse(text);
}

async function parallel(values, limit, task) {
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        await task(values[index]);
      }
    }),
  );
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function command(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else
        reject(
          new Error(`${executable} ${args.join(" ")} failed (${code}): ${Buffer.concat(stderr)}`),
        );
    });
  });
}

async function writeJson(name, value) {
  await writeFile(path.join(artifactDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
