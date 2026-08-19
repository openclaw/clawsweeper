#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const proofDir = path.join(repoRoot, "docs/proof/alarm-hydration-dedup");
const artifactDir = path.join(proofDir, "artifacts");
const scratch = await mkdtemp(path.join(tmpdir(), "alarm-hydration-dedup-"));
const baseRoot = path.join(scratch, "merge-base");
const archivePath = path.join(scratch, "merge-base.tar");
const proofSecret = "alarm-hydration-dedup-local-secret";
const targetRepo = "openclaw/alarm-hydration-proof";
const workers = [];
const stubRequests = [];
let activeScenario = "setup";

await mkdir(artifactDir, { recursive: true });
await Promise.all(
  [
    "failure.json",
    "proof-summary.json",
    "normalized.diff",
    "stub-requests.json",
    "scan-counts.json",
  ].map((name) => rm(path.join(artifactDir, name), { force: true })),
);

const mergeBase = (await command("git", ["merge-base", "HEAD", "origin/main"], repoRoot)).trim();
const headSha = (await command("git", ["rev-parse", "HEAD"], repoRoot)).trim();
await mkdir(baseRoot, { recursive: true });
await command("git", ["archive", "--format=tar", "-o", archivePath, mergeBase], repoRoot);
await command("tar", ["-xf", archivePath, "-C", baseRoot], repoRoot);

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const stubPort = await availablePort();
const dispatches = new Map();
const stub = createHttpServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${stubPort}`);
  const body = await requestBody(request);
  const scenario = activeScenario;
  stubRequests.push({ scenario, method: request.method, pathname: url.pathname });
  if (/^\/repos\/[^/]+\/[^/]+\/installation$/.test(url.pathname)) {
    return json(response, 200, { id: 999 });
  }
  if (url.pathname === "/app/installations/999/access_tokens" && request.method === "POST") {
    return json(response, 201, { token: "loopback-proof-token" });
  }
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname)) {
    return json(response, 200, { state: "open" });
  }
  if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
    return json(response, 200, { state: "active" });
  }
  if (
    url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/exact-review-batch-publish.yml/dispatches" &&
    request.method === "POST"
  ) {
    dispatches.set(scenario, (dispatches.get(scenario) || 0) + 1);
    return empty(response, 204);
  }
  return json(response, 404, { error: "proof_stub_not_found", body_bytes: body.length });
});
await new Promise((resolve, reject) => {
  stub.once("error", reject);
  stub.listen(stubPort, "127.0.0.1", resolve);
});

try {
  await prepareRevision(baseRoot, "base");
  await prepareRevision(repoRoot, "head");
  const scanCounts = await measureScanCounts(baseRoot, repoRoot);
  const base = await runScenario("base", baseRoot);
  const head = await runScenario("head", repoRoot);

  const normalized = {
    base: { before: normalizeVolatile(base.before), after: normalizeVolatile(base.after) },
    head: { before: normalizeVolatile(head.before), after: normalizeVolatile(head.after) },
  };
  const baseBeforeBytes = stableJson(normalized.base.before);
  const headBeforeBytes = stableJson(normalized.head.before);
  const baseAfterBytes = stableJson(normalized.base.after);
  const headAfterBytes = stableJson(normalized.head.after);
  assert.equal(headBeforeBytes, baseBeforeBytes, "normalized pre-alarm queue state changed");
  assert.equal(headAfterBytes, baseAfterBytes, "normalized post-alarm queue state changed");
  assert.deepEqual(scanCounts, { base: 7, head: 5 });

  await Promise.all([
    writeJson("base-before.json", base.before),
    writeJson("base-after.json", base.after),
    writeJson("head-before.json", head.before),
    writeJson("head-after.json", head.after),
    writeJson("base-before.normalized.json", normalized.base.before),
    writeJson("base-after.normalized.json", normalized.base.after),
    writeJson("head-before.normalized.json", normalized.head.before),
    writeJson("head-after.normalized.json", normalized.head.after),
    writeJson("scan-counts.json", scanCounts),
    writeJson("stub-requests.json", stubRequests),
    writeFile(path.join(artifactDir, "normalized.diff"), "", "utf8"),
  ]);
  const summary = {
    proof: "alarm hydration deduplication",
    merge_base: mergeBase,
    head: headSha,
    scenarios: {
      seeded_publications: 8,
      base_batch_dispatches: dispatches.get("base") || 0,
      head_batch_dispatches: dispatches.get("head") || 0,
    },
    normalized_queue_state: {
      before_equal: true,
      after_equal: true,
      before_sha256: sha256(baseBeforeBytes),
      after_sha256: sha256(baseAfterBytes),
    },
    full_item_table_scans_per_alarm: scanCounts,
    normalization: "clock-derived keys, request/dispatch identifiers, UUIDs",
    openclaw_bay: "none",
    limits: "loopback GitHub API; SQL counts use the existing test-only storage adapter",
  };
  await writeJson("proof-summary.json", summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  await writeJson("failure.json", {
    error: error instanceof Error ? error.stack || error.message : String(error),
    merge_base: mergeBase,
    head: headSha,
  });
  throw error;
} finally {
  await Promise.all(workers.map(stopWorker));
  await new Promise((resolve) => stub.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}

async function prepareRevision(root, label) {
  await loggedCommand("corepack", ["enable"], root, `${label}-corepack.log`);
  await loggedCommand("pnpm", ["install", "--frozen-lockfile"], root, `${label}-install.log`);
  await loggedCommand("pnpm", ["run", "build:all"], root, `${label}-build.log`);
}

async function measureScanCounts(base, head) {
  const testPath = "test/dashboard-worker.test.ts";
  const headTest = await readFile(path.join(head, testPath), "utf8");
  const assertion = "assert.equal(fullStateReads, 5);";
  assert.equal(headTest.split(assertion).length, 2, "scan-count assertion marker changed");
  await writeFile(path.join(base, testPath), headTest.replace(assertion, "assert.equal(fullStateReads, 7);"));
  const pattern = "redundant full queue hydrations";
  await loggedCommand(
    "node",
    ["--test", `--test-name-pattern=${pattern}`, testPath],
    base,
    "base-scan-count.log",
  );
  await loggedCommand(
    "node",
    ["--test", `--test-name-pattern=${pattern}`, testPath],
    head,
    "head-scan-count.log",
  );
  return { base: 7, head: 5 };
}

async function runScenario(label, root) {
  activeScenario = label;
  const port = await availablePort();
  const stateDir = await mkdtemp(path.join(tmpdir(), `alarm-hydration-${label}-state-`));
  const logPath = path.join(artifactDir, `${label}-worker.log`);
  const log = createWriteStream(logPath);
  await new Promise((resolve, reject) => {
    log.once("open", resolve);
    log.once("error", reject);
  });
  const args = [
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
    String(port),
    "--var",
    `CLAWSWEEPER_WEBHOOK_SECRET:${proofSecret}`,
    "--var",
    "CLAWSWEEPER_APP_CLIENT_ID:Iv23alarmproof",
    "--var",
    `CLAWSWEEPER_APP_PRIVATE_KEY:${privateKey}`,
    "--var",
    `GITHUB_API_URL:http://127.0.0.1:${stubPort}`,
    "--var",
    "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS:3000",
    "--var",
    "EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS:3000",
    "--var",
    "EXACT_REVIEW_PUBLICATION_BATCH_SIZE:8",
    "--var",
    "EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS:1000",
  ];
  const child = spawn("npx", args, {
    cwd: root,
    detached: true,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", log, log],
  });
  const worker = { child, log, stateDir };
  workers.push(worker);
  const origin = `http://127.0.0.1:${port}`;
  await waitForWorker(origin, child, logPath);

  for (let index = 0; index < 8; index += 1) {
    const itemNumber = 77100 + index;
    const response = await signedPost(origin, {
      delivery_id: `alarm-proof-${index}`,
      decision: publicationDecision(itemNumber, String(771000 + index)),
    });
    assert.equal(response.status, 202, `${label} enqueue ${index} failed: ${response.text}`);
  }
  const before = await getJson(`${origin}/api/exact-review-queue`);
  await waitFor(async () => {
    const state = await getJson(`${origin}/api/exact-review-queue`);
    return state.lanes?.publication?.batches?.last_dispatch_succeeded === true ? state : null;
  }, 30_000, `${label} batch alarm`);
  const after = await getJson(`${origin}/api/exact-review-queue`);
  assert.equal(dispatches.get(label), 1, `${label} did not issue exactly one batch dispatch`);
  await stopWorker(worker);
  workers.splice(workers.indexOf(worker), 1);
  return { before, after };
}

function publicationDecision(itemNumber, producerRunId) {
  const producerDecision = {
    targetRepo,
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  };
  return {
    ...producerDecision,
    sourceAction: "exact_review_artifact_publish",
    publication: {
      artifactName: `exact-review-${producerRunId}-1`,
      producerRunId,
      producerRunAttempt: 1,
      sourceSha: "a".repeat(40),
      itemKey: `${targetRepo}#${itemNumber}`,
      protocolVersion: 2,
      leaseRevision: 1,
      claimGeneration: 1,
      liveProceeded: true,
      liveTerminalNoop: false,
      liveTerminalMissing: false,
      liveGuardedOpen: false,
      producerDecision,
    },
  };
}

async function signedPost(origin, payload) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", proofSecret).update(body).digest("hex")}`;
  const response = await fetch(`${origin}/internal/exact-review/enqueue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
  return { status: response.status, text: await response.text() };
}

function normalizeVolatile(value) {
  if (Array.isArray(value)) return value.map((entry) => normalizeVolatile(entry));
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)) return "<time>";
    if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return "<uuid>";
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      /(?:_at|_until|_age_seconds|_wait_seconds|request_id|dispatch_id|departure_id|batch_id|lease_id)$/.test(
        childKey,
      )
        ? `<volatile:${childKey}>`
        : normalizeVolatile(child, childKey),
    ]),
  );
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, `${url} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function waitForWorker(origin, child, logPath) {
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Worker exited early:\n${await readFile(logPath, "utf8")}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, 90_000, `Worker ${origin}`);
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function stopWorker(worker) {
  if (!worker || worker.child.exitCode !== null) return;
  try {
    process.kill(-worker.child.pid, "SIGTERM");
  } catch {
    worker.child.kill("SIGTERM");
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    worker.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  worker.log.end();
  await rm(worker.stateDir, { recursive: true, force: true });
}

async function loggedCommand(executable, args, cwd, logName) {
  const result = await command(executable, args, cwd);
  await writeFile(path.join(artifactDir, logName), result, "utf8");
}

async function command(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: process.env });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const output = Buffer.concat([...stdout, ...stderr]).toString("utf8");
      if (code === 0) resolve(output);
      else reject(new Error(`${executable} ${args.join(" ")} failed (${code}):\n${output}`));
    });
  });
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function empty(response, status) {
  response.writeHead(status);
  response.end();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(name, value) {
  await writeFile(path.join(artifactDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
