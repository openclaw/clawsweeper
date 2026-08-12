#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const proofDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(proofDir, "../../..");
const observedHead = (await optionalGit(["rev-parse", "HEAD"], repoRoot)).trim();
const expectedHead = process.argv[2] || "";
if (!observedHead && !expectedHead) {
  throw new Error("expected committed head is required when synced source omits Git metadata");
}
if (expectedHead) {
  assert.match(expectedHead, /^[0-9a-f]{40}$/);
  if (observedHead)
    assert.equal(observedHead, expectedHead, "proof must run at the expected committed head");
}
const head = observedHead || expectedHead;
const expectedBase = process.argv[3] || "";
if (expectedBase) assert.match(expectedBase, /^[0-9a-f]{40}$/);
const mergeBase =
  expectedBase || (await git(["merge-base", "HEAD", "origin/main"], repoRoot)).trim();
const outputPath = path.resolve(
  process.env.OPERATOR_RECORD_READ_AUTH_PROOF_OUTPUT ||
    path.join(repoRoot, ".artifacts/operator-record-read-auth/behavior-report.json"),
);
const scratch = await mkdtemp(path.join(os.tmpdir(), "clawsweeper-operator-record-read-auth-"));
const baseRoot = path.join(scratch, "merge-base");
const workerPort = await availablePort();
const webhookSecret = "synthetic-record-read-webhook-proof-secret";
const operatorSecret = "synthetic-record-read-operator-proof-secret";
const garbageSecret = "synthetic-record-read-garbage-proof-secret";
const recordContent = [
  "---",
  "repository: openclaw/openclaw",
  "number: 1148",
  "type: pull_request",
  "review_status: complete",
  `pull_head_sha: ${"a".repeat(40)}`,
  "---",
  "",
  "Synthetic canonical record for operator auth proof.",
  "",
].join("\n");
const recordDigest = createHash("sha256").update(recordContent).digest("hex");
const recordPath = "/internal/state/records/openclaw-openclaw/items/1148";
const shutdowns = [];

if (observedHead) {
  await mkdir(baseRoot, { recursive: true });
  await extractRevision(mergeBase, baseRoot);
} else {
  await cloneRevision(mergeBase, baseRoot);
}

let worker;
try {
  worker = await startWorker(baseRoot, "merge-base");
  await publishRecord(worker.origin, "merge-base");
  const before = await readMatrix(worker.origin);
  assert.equal(before.operator.status, 401);
  assert.deepEqual(before.operator.body, { error: "invalid_signature" });
  assertSuccessfulRecord(before.webhook);
  assert.equal(before.garbage.status, 401);
  assert.deepEqual(before.garbage.body, { error: "invalid_signature" });
  shutdowns.push(await stopWorker(worker, "merge-base"));
  worker = undefined;

  worker = await startWorker(repoRoot, "candidate");
  await publishRecord(worker.origin, "candidate");
  const after = await readMatrix(worker.origin);
  assertSuccessfulRecord(after.operator);
  assertSuccessfulRecord(after.webhook);
  assert.equal(after.garbage.status, 401);
  assert.deepEqual(after.garbage.body, { error: "invalid_signature" });
  shutdowns.push(await stopWorker(worker, "candidate"));
  worker = undefined;

  const report = {
    schema: "clawsweeper-operator-record-read-auth-proof/v1",
    generated_at: new Date().toISOString(),
    merge_base: mergeBase,
    head,
    runtime: "sequential real wrangler dev --local Workers over loopback HTTP",
    configuration: {
      secrets_distinct: webhookSecret !== operatorSecret,
      shared_secret_fixture: false,
      persisted_state_shared_between_boots: false,
      candidate_git_metadata: Boolean(observedHead),
      candidate_head_source: observedHead ? "local git checkout" : "explicit Crabbox argument",
      baseline_source: observedHead ? "local git archive" : "exact public GitHub commit",
    },
    before: sanitizeMatrix(before),
    after: sanitizeMatrix(after),
    process_tree_shutdowns: shutdowns,
    result: {
      merge_base_operator_status: before.operator.status,
      candidate_operator_status: after.operator.status,
      candidate_webhook_status: after.webhook.status,
      candidate_garbage_status: after.garbage.status,
      status: "succeeded",
    },
    limits: [
      "Credentials and canonical content are synthetic local fixtures.",
      "The proof exercises local Worker routing and Durable Object persistence, not production state or GitHub mutation.",
      "The operational-cursor route is outside scope because it has no operator-secret consumer.",
    ],
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write("OPERATOR_RECORD_READ_AUTH_PROOF_RC=0\n");
} finally {
  if (worker) await stopWorker(worker, "cleanup");
  await rm(scratch, { recursive: true, force: true });
}

async function publishRecord(origin, label) {
  const body = JSON.stringify({
    deliveryId: `operator-record-read-auth:${label}`,
    key: "openclaw-openclaw/1148",
    operations: [
      {
        path: "records/openclaw-openclaw/items/1148.md",
        expectedDigest: null,
        contentBase64: Buffer.from(recordContent).toString("base64"),
      },
      { path: "records/openclaw-openclaw/closed/1148.md", expectedDigest: null },
      { path: "records/openclaw-openclaw/plans/1148.md", expectedDigest: null },
      {
        path: "records/openclaw-openclaw/decision-packets/1148.json",
        expectedDigest: null,
      },
    ],
  });
  const response = await fetch(`${origin}/internal/state/records/tuples`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature(webhookSecret, body),
    },
    body,
  });
  assert.equal(response.status, 202, await response.text());
}

async function readMatrix(origin) {
  return {
    webhook: await readRecord(origin, webhookSecret),
    operator: await readRecord(origin, operatorSecret),
    garbage: await readRecord(origin, garbageSecret),
  };
}

async function readRecord(origin, secret) {
  const response = await fetch(`${origin}${recordPath}`, {
    headers: { "x-clawsweeper-exact-review-signature": signature(secret, "") },
  });
  return { status: response.status, body: await response.json() };
}

function assertSuccessfulRecord(outcome) {
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.content, recordContent);
  assert.equal(outcome.body.digest, recordDigest);
  assert.equal(outcome.body.revision, 1);
  assert.equal(Number.isFinite(Date.parse(outcome.body.updatedAt)), true);
}

function sanitizeMatrix(matrix) {
  return Object.fromEntries(
    Object.entries(matrix).map(([name, outcome]) => [
      name,
      {
        status: outcome.status,
        body:
          outcome.status === 200
            ? {
                digest: outcome.body.digest,
                revision: outcome.body.revision,
                content_matches: outcome.body.content === recordContent,
                updated_at_valid: Number.isFinite(Date.parse(outcome.body.updatedAt)),
              }
            : outcome.body,
      },
    ]),
  );
}

async function startWorker(sourceRoot, label) {
  const logs = [];
  const child = spawn(
    "npx",
    [
      "--yes",
      "wrangler@4.107.0",
      "dev",
      "--config",
      path.join(sourceRoot, "dashboard/wrangler.toml"),
      "--local",
      "--persist-to",
      path.join(scratch, `${label}-state`),
      "--ip",
      "127.0.0.1",
      "--port",
      String(workerPort),
      "--var",
      `CLAWSWEEPER_WEBHOOK_SECRET:${webhookSecret}`,
      "--var",
      `EXACT_REVIEW_OPERATOR_SECRET:${operatorSecret}`,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const origin = `http://127.0.0.1:${workerPort}`;
  try {
    await waitForWorker(origin, child, logs);
  } catch (error) {
    await stopWorker({ child, origin }, `${label}-failed-start`);
    throw error;
  }
  return { child, origin };
}

async function waitForWorker(origin, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited early (${child.exitCode}):\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Wrangler did not become ready:\n${logs.join("")}`);
}

async function stopWorker(runningWorker, label) {
  const rootPid = runningWorker?.child?.pid;
  if (!rootPid) return { label, method: "not_started", health_down: true };
  const pids = await processTreePids(rootPid);
  signalProcessTree(rootPid, pids, "SIGTERM");
  await Promise.race([
    runningWorker.child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => runningWorker.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  let healthDown = await waitForHealthDown(runningWorker.origin, 30);
  if (!healthDown) {
    signalProcessTree(rootPid, await processTreePids(rootPid), "SIGKILL");
    healthDown = await waitForHealthDown(runningWorker.origin, 30);
  }
  assert.equal(healthDown, true, `Wrangler process tree for ${label} retained the proof port`);
  return {
    label,
    method: process.platform === "win32" ? "descendant_pid_tree" : "process_group_and_descendants",
    targeted_processes: pids.length,
    health_down: true,
  };
}

function signalProcessTree(rootPid, pids, signal) {
  if (process.platform !== "win32") {
    try {
      process.kill(-rootPid, signal);
    } catch {}
  }
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function processTreePids(rootPid) {
  let stdout = "";
  try {
    stdout = (await execFile("ps", ["-eo", "pid=,ppid="])).stdout;
  } catch {
    return [rootPid];
  }
  const parents = new Map();
  for (const line of stdout.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(parent)) parents.set(pid, parent);
  }
  const tree = [rootPid];
  for (const pid of parents.keys()) {
    let current = pid;
    for (let depth = 0; depth < 100 && parents.has(current); depth += 1) {
      current = parents.get(current);
      if (current === rootPid) {
        tree.push(pid);
        break;
      }
    }
  }
  return [...new Set(tree)];
}

async function waitForHealthDown(origin, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function extractRevision(revision, destination) {
  await new Promise((resolve, reject) => {
    const archive = spawn("git", ["archive", revision], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const extract = spawn("tar", ["-x", "-C", destination], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    archive.stdout.pipe(extract.stdin);
    const errors = [];
    archive.stderr.on("data", (chunk) => errors.push(String(chunk)));
    extract.stderr.on("data", (chunk) => errors.push(String(chunk)));
    let archiveCode;
    let extractCode;
    const finish = () => {
      if (archiveCode === undefined || extractCode === undefined) return;
      if (archiveCode === 0 && extractCode === 0) resolve();
      else reject(new Error(`revision extraction failed:\n${errors.join("")}`));
    };
    archive.on("exit", (code) => {
      archiveCode = code;
      finish();
    });
    extract.on("exit", (code) => {
      extractCode = code;
      finish();
    });
  });
}

async function cloneRevision(revision, destination) {
  await mkdir(destination, { recursive: true });
  await execFile("git", ["init", "--quiet"], { cwd: destination });
  await execFile(
    "git",
    ["remote", "add", "origin", "https://github.com/openclaw/clawsweeper.git"],
    { cwd: destination },
  );
  await execFile("git", ["fetch", "--quiet", "--depth", "1", "origin", revision], {
    cwd: destination,
    maxBuffer: 10 * 1024 * 1024,
  });
  await execFile("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], {
    cwd: destination,
  });
  assert.equal((await git(["rev-parse", "HEAD"], destination)).trim(), revision);
}

function signature(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function git(args, cwd) {
  return (await execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout;
}

async function optionalGit(args, cwd) {
  try {
    return await git(args, cwd);
  } catch {
    return "";
  }
}
