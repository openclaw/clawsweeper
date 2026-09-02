#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const outputDir = path.resolve(process.env.PROOF_OUTPUT || ".artifacts/review-branch-authority");
const workerPort = Number(process.env.PROOF_WORKER_PORT || 8795);
const githubPort = Number(process.env.PROOF_GITHUB_PORT || 8796);
const rateLimitResetDelayMs = 45_000;
const webhookSecret = "review-branch-authority-proof";
const sourceSha = process.env.PROOF_SOURCE_SHA || (await gitHead());
const sourceTreeSha = await treeHash([
  "dashboard/exact-review-queue.ts",
  "dashboard/github-api.ts",
  "dashboard/worker.ts",
  "docs/proof/review-branch-authority/README.md",
  "docs/proof/review-branch-authority/run-proof.mjs",
  "docs/proof/review-branch-authority/run-proof.sh",
]);
const persistence = await mkdtemp(path.join(os.tmpdir(), "clawsweeper-branch-authority-"));
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

await mkdir(outputDir, { recursive: true });
const github = await startGithubFaultServer();
let worker;
let beforeReset;
let afterReset;
let resolvedRecords;

try {
  worker = await startWorker("initial");
  await signedPost(
    "/internal/exact-review/branch-authority",
    branchPayload({
      deliveryId: "branch-proof-openclaw-a",
      targetRepo: "openclaw/openclaw",
      itemNumber: 900,
      installationId: 123,
    }),
    202,
  );
  await waitFor(() => github.count("GET", "/repos/openclaw/openclaw") === 1);
  assert.equal(github.count("POST", "/app/installations/123/access_tokens"), 1);

  await signedPost(
    "/internal/exact-review/branch-authority",
    branchPayload({
      deliveryId: "branch-proof-openclaw-b",
      targetRepo: "openclaw/openclaw",
      itemNumber: 901,
      installationId: 123,
    }),
    202,
  );
  await signedPost(
    "/internal/exact-review/source-authority",
    {
      delivery_id: "branch-proof-openclaw-source",
      installation_id: 123,
      decision: {
        targetRepo: "openclaw/openclaw",
        targetBranch: "trunk",
        itemNumber: 903,
        itemKind: "pull_request",
        sourceEvent: "pull_request",
        sourceAction: "synchronize",
        supersedesInProgress: true,
        sourceHeadSha: "d".repeat(40),
      },
    },
    200,
  );
  await signedPost(
    "/internal/exact-review/branch-authority",
    branchPayload({
      deliveryId: "branch-proof-other",
      targetRepo: "other/repo",
      itemNumber: 902,
      installationId: 456,
    }),
    202,
  );

  beforeReset = await waitForQueue((snapshot) => {
    const authority = snapshot.lanes?.review?.authority_pending;
    const circuit = circuitFor(snapshot, "target_app:openclaw");
    return (
      authority?.total === 3 &&
      authority?.branch_resolution === 2 &&
      authority?.source_verification === 1 &&
      circuit?.active === true &&
      circuit?.affected_pending === 3 &&
      JSON.stringify(snapshot).includes("other/repo#902")
    );
  });
  assert.equal(github.count("GET", "/repos/openclaw/openclaw"), 1);
  assert.equal(github.count("GET", "/repos/openclaw/openclaw/pulls/903"), 0);
  assert.equal(github.count("POST", "/app/installations/123/access_tokens"), 1);
  assert.equal(github.count("GET", "/repos/other/repo"), 1);
  assert.equal(
    beforeReset.lanes.publication.github_request_metrics.counters[
      "target_app:item_metadata:read:skipped_by_circuit:first"
    ],
    2,
  );
  await writeJson("before-reset-queue.json", beforeReset);

  await stopProcessTree(worker);
  worker = await startWorker("restarted");
  afterReset = await waitForQueue((snapshot) => {
    const authority = snapshot.lanes?.review?.authority_pending;
    const text = JSON.stringify(snapshot);
    return (
      authority?.total === 0 &&
      text.includes("openclaw/openclaw#900") &&
      text.includes("openclaw/openclaw#901") &&
      text.includes("openclaw/openclaw#903")
    );
  }, rateLimitResetDelayMs + 30_000);
  await writeJson("after-reset-queue.json", afterReset);

  assert.equal(github.count("GET", "/repos/openclaw/openclaw"), 3);
  assert.equal(github.count("GET", "/repos/openclaw/openclaw/pulls/903"), 1);
  assert.equal(github.count("GET", "/repos/other/repo"), 1);
  assert.ok(github.count("POST", "/app/installations/123/access_tokens") >= 4);
  assert.equal(github.unexpectedRequests(), 0);
  const recoveredCircuit = circuitFor(afterReset, "target_app:openclaw");
  assert.ok(!recoveredCircuit || recoveredCircuit.active === false);

  await stopProcessTree(worker);
  worker = undefined;
  resolvedRecords = await exactReviewQueueRecords();
  assertResolvedRecord(resolvedRecords, "openclaw/openclaw", 900, "trunk");
  assertResolvedRecord(resolvedRecords, "openclaw/openclaw", 901, "trunk");
  assertResolvedRecord(resolvedRecords, "other/repo", 902, "stable");
  assertResolvedRecord(resolvedRecords, "openclaw/openclaw", 903, "trunk", {
    sourceHeadVerified: true,
    sourceHeadSha: "d".repeat(40),
  });

  await writeJson("github-requests.json", github.trace);
  await writeJson("resolved-queue-records.json", resolvedRecords.map(proofQueueRecord));
  const summary = {
    claim:
      "signed branchless intake survives a target-owner quota reset durably, collapses same-owner requests, preserves other owners, and recovers after a Worker restart",
    source_sha: sourceSha,
    source_tree_sha: sourceTreeSha,
    generated_at: new Date().toISOString(),
    runtime: "wrangler dev --local with SQLite-backed ExactReviewQueue",
    transport: `loopback HTTP GITHUB_API_URL on 127.0.0.1:${githubPort}`,
    observations: {
      before_reset: {
        authority_pending: beforeReset.lanes.review.authority_pending,
        circuit: circuitFor(beforeReset, "target_app:openclaw"),
        openclaw_repository_reads: 1,
        openclaw_pull_reads: 0,
        other_repository_reads: 1,
      },
      after_restart_and_reset: {
        authority_pending: afterReset.lanes.review.authority_pending,
        circuit: recoveredCircuit || null,
        openclaw_repository_reads: 3,
        openclaw_pull_reads: 1,
        other_repository_reads: 1,
      },
    },
    assertion_groups: [
      "signed intake",
      "first quota observation",
      "same-owner request collapse",
      "unaffected-owner progress",
      "restart durability",
      "reset recovery",
      "resolved branch and source-head decisions",
    ],
    production_mutations: 0,
    run_status: "succeeded",
  };
  await writeJson("proof-summary.json", summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  await writeJson("proof-failure.json", {
    source_sha: sourceSha,
    generated_at: new Date().toISOString(),
    error: error instanceof Error ? error.stack : String(error),
    before_reset: beforeReset || null,
    after_reset: afterReset || null,
    github_requests: github.trace,
    resolved_queue_records: resolvedRecords?.map(proofQueueRecord) || null,
    run_status: "failed",
  });
  throw error;
} finally {
  await stopProcessTree(worker);
  await github.close();
  await rm(persistence, { recursive: true, force: true });
}

function branchPayload({ deliveryId, targetRepo, itemNumber, installationId }) {
  return {
    delivery_id: deliveryId,
    installation_id: installationId,
    decision: {
      targetRepo,
      itemNumber,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "legacy_dispatch",
      supersedesInProgress: false,
    },
  };
}

async function startGithubFaultServer() {
  const trace = [];
  let openclawRepositoryReads = 0;
  let resetAt = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${githubPort}`);
    const method = request.method || "GET";
    const authScheme = String(request.headers.authorization || "").split(" ", 1)[0] || null;
    let status = 200;
    let payload = {};
    const headers = { "content-type": "application/json" };

    if (
      method === "POST" &&
      /^\/app\/installations\/(123|456)\/access_tokens$/.test(url.pathname)
    ) {
      const installation = url.pathname.split("/")[3];
      status = 201;
      payload = {
        token: `proof-installation-${installation}`,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      };
    } else if (method === "GET" && url.pathname === "/repos/openclaw/openclaw") {
      openclawRepositoryReads += 1;
      if (openclawRepositoryReads === 1) {
        resetAt = Math.ceil((Date.now() + rateLimitResetDelayMs) / 1_000) * 1_000;
        status = 403;
        payload = { message: "API rate limit exceeded" };
        headers["x-ratelimit-remaining"] = "0";
        headers["x-ratelimit-reset"] = String(resetAt / 1_000);
      } else {
        payload = { default_branch: "trunk" };
      }
    } else if (method === "GET" && url.pathname === "/repos/openclaw/openclaw/pulls/903") {
      payload = { head: { sha: "d".repeat(40) } };
    } else if (method === "GET" && url.pathname === "/repos/other/repo") {
      payload = { default_branch: "stable" };
    } else {
      status = 501;
      payload = { message: "unexpected proof request" };
    }

    trace.push({
      at: new Date().toISOString(),
      method,
      path: url.pathname,
      auth_scheme: authScheme,
      response_status: status,
      ...(status === 403 ? { reset_at: new Date(resetAt).toISOString() } : {}),
    });
    response.writeHead(status, headers);
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(githubPort, "127.0.0.1", resolve);
  });
  return {
    trace,
    count(method, requestPath) {
      return trace.filter((entry) => entry.method === method && entry.path === requestPath).length;
    },
    unexpectedRequests() {
      return trace.filter((entry) => entry.response_status === 501).length;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startWorker(name) {
  const args = [
    "--yes",
    "wrangler@4.107.0",
    "dev",
    "--config",
    "dashboard/wrangler.toml",
    "--local",
    "--persist-to",
    persistence,
    "--ip",
    "127.0.0.1",
    "--port",
    String(workerPort),
    "--var",
    `CLAWSWEEPER_WEBHOOK_SECRET:${webhookSecret}`,
    "--var",
    "CLAWSWEEPER_APP_CLIENT_ID:Iv23proof",
    "--var",
    `CLAWSWEEPER_APP_PRIVATE_KEY:${privateKey.replace(/\n/g, "\\n")}`,
    "--var",
    `GITHUB_API_URL:http://127.0.0.1:${githubPort}`,
    "--var",
    "TARGET_REPOS:openclaw/openclaw,other/repo",
    "--var",
    "CACHE_TTL_SECONDS:0",
    "--var",
    "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS:600000",
    "--log-level",
    "warn",
  ];
  const command = process.platform === "win32" ? process.execPath : "npx";
  const processArgs =
    process.platform === "win32"
      ? [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npx-cli.js"), ...args]
      : args;
  const child = startProcess(command, processArgs, `${name}-wrangler.log`);
  try {
    await waitForHttp(`http://127.0.0.1:${workerPort}/api/health`);
    return child;
  } catch (error) {
    await stopProcessTree(child);
    throw error;
  }
}

async function signedPost(requestPath, payload, expectedStatus) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
  const response = await fetch(`http://127.0.0.1:${workerPort}${requestPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expectedStatus, await response.text());
}

async function queueSnapshot() {
  const response = await fetch(`http://127.0.0.1:${workerPort}/api/exact-review-queue`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function circuitFor(snapshot, pool) {
  return snapshot.lanes?.publication?.credential_circuits?.find(
    (candidate) => candidate.pool === pool,
  );
}

async function exactReviewQueueRecords() {
  const records = [];
  const persistenceFiles = await filesUnder(persistence);
  for (const file of persistenceFiles) {
    let database;
    try {
      database = new DatabaseSync(file, { readOnly: true });
      const table = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'exact_review_queue_items'",
        )
        .get();
      if (!table) continue;
      const rows = database
        .prepare("SELECT item_key, item_json FROM exact_review_queue_items")
        .all();
      for (const row of rows) {
        records.push({ itemKey: String(row.item_key), ...JSON.parse(String(row.item_json)) });
      }
    } catch {
    } finally {
      database?.close();
    }
  }
  assert.ok(records.length > 0, "exact-review queue records were not found in local persistence");
  return records;
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function assertResolvedRecord(
  records,
  targetRepo,
  itemNumber,
  targetBranch,
  { sourceHeadVerified, sourceHeadSha } = {},
) {
  const record = records.find(
    (candidate) =>
      candidate.decision?.targetRepo === targetRepo &&
      candidate.decision?.itemNumber === itemNumber,
  );
  assert.ok(record, `missing durable queue record for ${targetRepo}#${itemNumber}`);
  assert.equal(record.state, "pending");
  assert.equal(record.decision.targetBranch, targetBranch);
  if (sourceHeadVerified !== undefined) {
    assert.equal(record.decision.sourceHeadVerified, sourceHeadVerified);
  }
  if (sourceHeadSha !== undefined) {
    assert.equal(record.decision.sourceHeadSha, sourceHeadSha);
  }
}

function proofQueueRecord(record) {
  return {
    item_key: record.itemKey,
    state: record.state,
    target_repo: record.decision.targetRepo,
    item_number: record.decision.itemNumber,
    target_branch: record.decision.targetBranch,
    source_head_verified: record.decision.sourceHeadVerified ?? null,
    source_head_sha: record.decision.sourceHeadSha ?? null,
  };
}

async function waitForQueue(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await queueSnapshot();
    if (predicate(latest)) return latest;
    await delay(200);
  }
  throw new Error(`timed out waiting for queue state: ${JSON.stringify(latest)}`);
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error("timed out waiting for proof observation");
}

function startProcess(command, args, logName) {
  const stream = createWriteStream(path.join(outputDir, logName), { flags: "w" });
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  child.logStream = stream;
  return child;
}

async function stopProcessTree(child) {
  if (!child) return;
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) {
      const taskkill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      await onceExit(taskkill);
      await Promise.race([onceExit(child), delay(5_000)]);
    }
  } else {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await Promise.race([onceExit(child), delay(5_000)]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await onceExit(child);
    }
  }
  child.logStream?.end();
  await waitForPortRelease();
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function waitForPortRelease() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${workerPort}/api/health`, {
        signal: AbortSignal.timeout(100),
      });
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error(`worker port ${workerPort} remained occupied after process-tree stop`);
}

function onceExit(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeJson(name, value) {
  await writeFile(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function gitHead() {
  const child = spawn("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  await onceExit(child);
  return output.trim() || "unknown";
}

async function treeHash(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(file))
      .update("\0");
  }
  return hash.digest("hex");
}
