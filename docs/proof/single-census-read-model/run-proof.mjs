#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const artifactDir = path.join(repoRoot, ".artifacts/single-census-read-model");
const scratch = await mkdtemp(path.join(tmpdir(), "single-census-proof-"));
const baseRoot = path.join(scratch, "merge-base");
const archivePath = path.join(scratch, "merge-base.tar");
const proofSecret = "single-census-local-proof-secret";
const populations = [0, 24, 96];
const seed = 0x5eedc0de;
const workers = [];
const githubStubPort = await availablePort();
const githubStub = createHttpServer((_request, response) => {
  const body = `${JSON.stringify({ message: "proof GitHub stub" })}\n`;
  response.writeHead(403, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
});
await new Promise((resolve, reject) => {
  githubStub.once("error", reject);
  githubStub.listen(githubStubPort, "127.0.0.1", resolve);
});

await mkdir(artifactDir, { recursive: true });
const mergeBase = (await command("git", ["merge-base", "HEAD", "origin/main"], repoRoot)).trim();
const headSha = (await command("git", ["rev-parse", "HEAD"], repoRoot)).trim();
const trackedDirty = (await command("git", ["status", "--porcelain", "--untracked-files=no"], repoRoot)).trim();
if (process.env.SINGLE_CENSUS_PROOF_ALLOW_DIRTY !== "1") {
  assert.equal(trackedDirty, "", "proof requires a clean committed checkout");
}
const receipt = trackedDirty ? "DIRTY-DEVELOPMENT-RUN" : "COMMITTED";
await mkdir(baseRoot, { recursive: true });
await command("git", ["archive", "--format=tar", "-o", archivePath, mergeBase], repoRoot);
await command("tar", ["-xf", archivePath, "-C", baseRoot], repoRoot);
await symlink(path.join(repoRoot, "node_modules"), path.join(baseRoot, "node_modules"));

try {
  const comparisons = [];
  for (const population of populations) {
    const before = await runWorkerScenario("merge-base", baseRoot, population, seed);
    const after = await runWorkerScenario("candidate", repoRoot, population, seed);
    for (const route of ["/api/exact-review-queue", "/api/status"]) {
      const beforeBytes = JSON.stringify(normalizeVolatile(before[route]));
      const afterBytes = JSON.stringify(normalizeVolatile(after[route]));
      assert.equal(afterBytes, beforeBytes, `normalized response changed for ${route} n=${population}`);
      comparisons.push({
        population,
        route,
        byte_identical: true,
        normalized_bytes: Buffer.byteLength(beforeBytes),
        normalized_sha256: sha256(beforeBytes),
      });
    }
  }

  const traversals = await measureTraversals(baseRoot, repoRoot);
  assert.equal(traversals.candidate.full_queue_traversals, 1);
  assert.equal(traversals.candidate.object_values_materializations, 1);
  assert.ok(
    traversals.candidate.equivalent_queue_passes < traversals.merge_base.equivalent_queue_passes,
    "candidate did not reduce measured queue passes",
  );
  const summary = {
    schema: "single-census-read-model-proof/v1",
    receipt,
    merge_base: mergeBase,
    candidate_head: headSha,
    worker: "wrangler dev --local",
    durable_object: "SQLite-backed ExactReviewQueue",
    seed,
    populations,
    responses: comparisons,
    all_normalized_responses_byte_identical: true,
    traversal_measurement: traversals,
    production_mutations: 0,
    openclaw_bay_affected: false,
    limits:
      "Synthetic pending reviews and loopback GitHub error stub; no GitHub, lease, publication, or production mutation.",
  };
  await writeFile(
    path.join(artifactDir, "proof-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await Promise.all(workers.map(stopWorker));
  await new Promise((resolve) => githubStub.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}

async function runWorkerScenario(label, root, population, populationSeed) {
  const port = await availablePort();
  const stateDir = await mkdtemp(path.join(tmpdir(), `single-census-${label}-${population}-`));
  const logPath = path.join(artifactDir, `${label}-${population}-worker.log`);
  const log = createWriteStream(logPath);
  await new Promise((resolve, reject) => {
    log.once("open", resolve);
    log.once("error", reject);
  });
  const child = spawn(
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
      String(port),
      "--var",
      `CLAWSWEEPER_WEBHOOK_SECRET:${proofSecret}`,
      "--var",
      `GITHUB_API_URL:http://127.0.0.1:${githubStubPort}`,
      "--var",
      "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS:600000",
      "--var",
      "EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS:600000",
    ],
    {
      cwd: root,
      detached: true,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", log, log],
    },
  );
  const worker = { child, log, stateDir };
  workers.push(worker);
  const origin = `http://127.0.0.1:${port}`;
  await waitForWorker(origin, child, logPath);
  const random = seededRandom(populationSeed);
  for (let index = 0; index < population; index += 1) {
    const itemNumber = 90_000 + index;
    const targetRepo = random() % 2 === 0 ? "openclaw/openclaw" : "openclaw/clawhub";
    const body = {
      delivery_id: `single-census-${populationSeed}-${population}-${index}`,
      decision: {
        targetRepo,
        targetBranch: "main",
        itemNumber,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: random() % 3 === 0 ? "edited" : "opened",
        supersedesInProgress: false,
        sourceUpdatedAt: new Date(Date.UTC(2026, 7, 11, 12, 0, index)).toISOString(),
      },
    };
    const response = await signedPost(origin, body);
    assert.equal(response.status, 202, `${label} seed ${index} failed: ${response.text}`);
  }
  const responses = {
    "/api/exact-review-queue": await getJson(`${origin}/api/exact-review-queue`),
    "/api/status": await getJson(`${origin}/api/status`),
  };
  assert.equal(responses["/api/exact-review-queue"].pending, population);
  await stopWorker(worker);
  workers.splice(workers.indexOf(worker), 1);
  return responses;
}

async function measureTraversals(base, candidate) {
  const baseModule = await import(
    `${pathToFileURL(path.join(base, "dashboard/exact-review-read-model.ts")).href}?proof=base`
  );
  const candidateModule = await import(
    `${pathToFileURL(path.join(candidate, "dashboard/exact-review-read-model.ts")).href}?proof=head`
  );
  return {
    merge_base: instrumentReadModel(baseModule, false),
    candidate: instrumentReadModel(candidateModule, true),
  };
}

function instrumentReadModel(module, hasSharedBayCensus) {
  const population = 1_200;
  const now = Date.parse("2026-08-11T18:00:00.000Z");
  let itemReads = 0;
  let fullQueueTraversals = 0;
  let equivalentElements = 0;
  const items = {};
  const batchByItemKey = new Map();
  for (let index = 0; index < population; index += 1) {
    const publication = index % 5 === 0;
    const state = ["pending", "dispatching", "leased", "parked"][index % 4];
    const targetRepo = index % 3 === 0 ? "openclaw/clawhub" : "openclaw/openclaw";
    const itemNumber = 100_000 + index;
    const key = `${targetRepo}#${itemNumber}${publication ? `@publish:${index}` : ""}`;
    const item = {
      __singleCensusProofItem: true,
      key,
      decision: {
        targetRepo,
        targetBranch: "main",
        itemNumber,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: publication ? "exact_review_artifact_publish" : "opened",
        supersedesInProgress: false,
        ...(publication ? { publication: {} } : {}),
      },
      state,
      revision: 1,
      createdAt: now - index * 1_000,
      updatedAt: now - index * 500,
      nextAttemptAt: now + (index % 3) * 30_000,
      attempts: 0,
      ...(state === "dispatching" || state === "leased"
        ? {
            leaseExpiresAt: now + 30 * 60_000 + index,
            dispatchedAt: now - 30_000,
            claimedAt: now - 60_000,
          }
        : {}),
      ...(state === "parked"
        ? { parkedReason: "review_retry_exhausted", parkedRecoveryAttempts: 1 }
        : {}),
    };
    Object.defineProperty(items, key, {
      enumerable: true,
      get() {
        itemReads += 1;
        return item;
      },
    });
    if (index % 17 === 0) batchByItemKey.set(key, { batchId: `batch-${index}` });
  }
  const state = { items, dispatcher: { state: "active", checkedAt: now } };
  const methods = ["filter", "map", "reduce", "sort", "flatMap", "some"];
  const originals = new Map();
  const iterator = Array.prototype[Symbol.iterator];
  const observe = (array) => {
    if (!array.length || !array[0]?.__singleCensusProofItem) return;
    equivalentElements += array.length;
    if (array.length === population) fullQueueTraversals += 1;
  };
  for (const name of methods) {
    const original = Array.prototype[name];
    originals.set(name, original);
    Array.prototype[name] = function (...args) {
      observe(this);
      return Reflect.apply(original, this, args);
    };
  }
  Array.prototype[Symbol.iterator] = function () {
    observe(this);
    return Reflect.apply(iterator, this, []);
  };
  try {
    const stats = module.exactReviewQueueStats(
      state,
      now,
      128,
      16,
      24,
      6 * 60_000,
      130 * 60_000,
      15 * 60_000,
      20 * 60_000,
      new Set(),
      null,
    );
    const bay = hasSharedBayCensus
      ? module.exactReviewQueueBayProjectionFromStats(stats, [], batchByItemKey)
      : module.exactReviewQueueBayProjection(Object.values(state.items), [], batchByItemKey);
    JSON.stringify({ ...stats, bay_projection: bay });
  } finally {
    for (const [name, original] of originals) Array.prototype[name] = original;
    Array.prototype[Symbol.iterator] = iterator;
  }
  return {
    population,
    full_queue_traversals: fullQueueTraversals,
    object_values_materializations: itemReads / population,
    equivalent_queue_passes: Number((equivalentElements / population).toFixed(3)),
  };
}

function normalizeVolatile(value, key = "") {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeVolatile(entry, key));
    return key === "errors" && normalized.every((entry) => typeof entry === "string")
      ? normalized.toSorted()
      : normalized;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)) return "<time>";
    return volatileKey(key) ? `<volatile:${key}>` : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      volatileKey(childKey) ? `<volatile:${childKey}>` : normalizeVolatile(child, childKey),
    ]),
  );
}

function volatileKey(key) {
  return /(?:^generated_at$|_at$|_until$|_age_seconds$|_wait_seconds$|_ms$|request_id$|lease_id$)/.test(
    key,
  );
}

function seededRandom(initial) {
  let value = initial >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
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

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, `${url} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function waitForWorker(origin, child, logPath) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Worker exited early:\n${await readFile(logPath, "utf8")}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Worker did not become ready: ${origin}`);
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
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
