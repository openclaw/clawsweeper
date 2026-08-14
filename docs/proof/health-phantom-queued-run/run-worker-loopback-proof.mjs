#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const outputPath = args.get("--output");
if (!outputPath) throw new Error("--output is required");

const repositoryRoot = process.cwd();
const proofSecret = "health-phantom-loopback-proof-secret";
const scratch = mkdtempSync(path.join(tmpdir(), "health-phantom-worker-proof-"));
const stateDir = path.join(scratch, "wrangler-state");
const workerLogPath = path.join(scratch, "worker.log");
const workerPort = await availablePort();
const githubPort = await availablePort();
const exactRequests = [];
const githubStub = createHttpServer((request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${githubPort}`);
  const exact = url.pathname.match(
    /^\/repos\/openclaw\/openclaw\/actions\/runs\/(7001|7002|7003)$/,
  );
  if (exact) {
    exactRequests.push(Number(exact[1]));
    if (exact[1] === "7003") return sendJson(response, 500, { message: "zombie rechecked" });
    if (exact[1] === "7002") return sendJson(response, 404, { message: "Not Found" });
    return sendJson(response, 200, {
      ...workflowRun(7001, "completed", seededAt),
      conclusion: "success",
      updated_at: new Date().toISOString(),
    });
  }
  if (url.pathname.endsWith("/actions/runs") || url.pathname.includes("/actions/workflows/")) {
    return sendJson(response, 200, { workflow_runs: [] });
  }
  if (url.pathname === "/search/issues") return sendJson(response, 200, { items: [] });
  if (url.pathname.endsWith("/issues") || url.pathname.endsWith("/pulls")) {
    return sendJson(response, 200, []);
  }
  if (url.pathname.endsWith("/check-runs")) return sendJson(response, 200, { check_runs: [] });
  return sendJson(response, 200, {});
});
await listen(githubStub, githubPort);

const log = createWriteStream(workerLogPath);
await new Promise((resolve, reject) => {
  log.once("open", resolve);
  log.once("error", reject);
});
const worker = spawn(
  "npx",
  [
    "--yes",
    "wrangler@4.107.0",
    "dev",
    "--config",
    "dashboard/wrangler.toml",
    "--local",
    "--persist-to",
    stateDir,
    "--ip",
    "127.0.0.1",
    "--port",
    String(workerPort),
    "--var",
    `CLAWSWEEPER_WEBHOOK_SECRET:${proofSecret}`,
    "--var",
    `GITHUB_API_URL:http://127.0.0.1:${githubPort}`,
    "--var",
    "CLAWSWEEPER_REPO:openclaw/openclaw",
    "--var",
    "TARGET_REPOS:openclaw/openclaw",
    "--var",
    "CACHE_TTL_SECONDS:0",
  ],
  {
    cwd: repositoryRoot,
    detached: true,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", log, log],
  },
);
const origin = `http://127.0.0.1:${workerPort}`;
const seededAt = new Date();

try {
  await waitForWorker(origin, worker, workerLogPath);
  for (const runId of [7001, 7002, 7003]) {
    const webhook = await signedGithubWebhook(origin, runId, seededAt);
    assert.equal(webhook.status, 202, webhook.text);
    assert.equal(webhook.body.materialized, true);
  }

  const ttlWaitMs = 5 * 60_000 + 2_000;
  process.stdout.write(`LOOPBACK_PHASE=age_snapshot wait_ms=${ttlWaitMs}\n`);
  const waitStartedAt = Date.now();
  while (Date.now() - waitStartedAt < ttlWaitMs) {
    const remainingSeconds = Math.ceil((ttlWaitMs - (Date.now() - waitStartedAt)) / 1_000);
    process.stdout.write(`LOOPBACK_HEARTBEAT remaining_seconds=${remainingSeconds}\n`);
    await delay(Math.min(60_000, ttlWaitMs - (Date.now() - waitStartedAt)));
  }

  const repair = await signedInternalPost(origin, "repair", {
    repository: "openclaw/openclaw",
    repair_kind: "workflows",
    workflow_run_census_complete: true,
    workflow_run_census_started_at: new Date(seededAt.getTime() - 1_000).toISOString(),
    objects: [],
  });
  assert.equal(repair.status, 202, repair.text);
  const before = await signedInternalPost(origin, "workflows", {
    repository: "openclaw/openclaw",
  });
  assert.equal(before.status, 200, before.text);
  assert.equal(before.body.usable, true);
  assert.equal(before.body.runs.length, 3);

  const statusResponse = await fetch(`${origin}/api/status`);
  const statusText = await statusResponse.text();
  assert.equal(statusResponse.status, 200, statusText);
  const status = JSON.parse(statusText);
  assert.equal(status.operational_health.status, "healthy");
  assert.equal(status.operational_health.queued_over_threshold, 0);
  assert.equal(status.operational_health.zombie_queued_runs, 1);
  assert.deepEqual(exactRequests.toSorted((left, right) => left - right), [7001, 7002]);

  const after = await signedInternalPost(origin, "workflows", {
    repository: "openclaw/openclaw",
  });
  assert.equal(after.status, 200, after.text);
  assert.deepEqual(
    after.body.runs.map((run) => run.id),
    [7003],
  );
  await delay(250);
  const workerLog = readFileSync(workerLogPath, "utf8");
  const telemetry = workerLog
    .split("\n")
    .filter((line) => line.includes("github_read_model_workflow_run_evicted"))
    .map((line) =>
      line
        .slice(line.indexOf("{"))
        .replaceAll(/\u001b\[[0-9;]*m/g, "")
        .trim(),
    )
    .filter(Boolean);
  assert.equal(telemetry.length, 2, workerLog.slice(-4_000));
  assert.ok(telemetry.some((line) => line.includes('"verdict":"completed"')));
  assert.ok(telemetry.some((line) => line.includes('"verdict":"absent"')));

  const report = {
    schema: "health-phantom-worker-loopback-proof/v1",
    generated_at: new Date().toISOString(),
    tested_runtime_head: git("rev-parse", "HEAD"),
    runtime_blobs: {
      "dashboard/worker.ts": git("hash-object", "dashboard/worker.ts"),
      "dashboard/github-webhook-read-model.ts": git(
        "hash-object",
        "dashboard/github-webhook-read-model.ts",
      ),
    },
    target: `${origin}/api/status`,
    worker: "wrangler dev --local",
    github_transport: `http://127.0.0.1:${githubPort}`,
    durable_object: "SQLite-backed ExactReviewQueue",
    workflow_ttl_wait_ms: ttlWaitMs,
    seeded_runs: [7001, 7002, 7003],
    exact_run_requests: exactRequests,
    health: {
      status: status.operational_health.status,
      telemetry_complete: status.operational_health.telemetry_complete,
      queued_over_threshold: status.operational_health.queued_over_threshold,
      zombie_queued_runs: status.operational_health.zombie_queued_runs,
    },
    read_model_after: { runs: after.body.runs.length, run_ids: [7003] },
    telemetry: telemetry.map((line) => JSON.parse(line)),
    production_mutations: 0,
    openclaw_bay_affected: false,
    limits:
      "Local Wrangler Worker, SQLite Durable Object, and loopback HTTP GitHub server; no production credentials, endpoints, subscriptions, or mutations.",
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write("LOOPBACK_RESULT=pass\n");
} finally {
  if (worker.exitCode === null) {
    try {
      process.kill(-worker.pid, "SIGTERM");
    } catch {}
    await Promise.race([new Promise((resolve) => worker.once("exit", resolve)), delay(5_000)]);
  }
  log.end();
  await new Promise((resolve) => githubStub.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}

function workflowRun(id, status, observedAt) {
  return {
    id,
    name: "Review",
    display_title: `Review event item openclaw/openclaw#${id}`,
    status,
    conclusion: null,
    created_at: new Date(
      observedAt.getTime() - (id === 7003 ? 25 * 60 * 60_000 : 60 * 60_000),
    ).toISOString(),
    updated_at: observedAt.toISOString(),
  };
}

async function signedGithubWebhook(originUrl, runId, observedAt) {
  const body = JSON.stringify({
    action: "requested",
    repository: {
      full_name: "openclaw/openclaw",
      default_branch: "main",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    installation: { id: 123 },
    workflow_run: workflowRun(runId, "queued", observedAt),
  });
  const response = await fetch(`${originUrl}/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "workflow_run",
      "x-github-delivery": `health-phantom-${runId}`,
      "x-hub-signature-256": signature(body),
    },
    body,
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

async function signedInternalPost(originUrl, operation, payload) {
  const body = JSON.stringify(payload);
  const response = await fetch(`${originUrl}/internal/state/github-read-model/${operation}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature(body),
    },
    body,
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

function signature(body) {
  return `sha256=${createHmac("sha256", proofSecret).update(body).digest("hex")}`;
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function availablePort() {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForWorker(originUrl, child, logPath) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Worker exited early:\n${readFileSync(logPath, "utf8")}`);
    }
    try {
      const response = await fetch(`${originUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Worker did not start:\n${readFileSync(logPath, "utf8")}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function git(...command) {
  return execFileSync("git", command, { encoding: "utf8" }).trim();
}
