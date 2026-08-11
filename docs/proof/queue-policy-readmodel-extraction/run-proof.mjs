#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const proofDir = path.join(repoRoot, "docs/proof/queue-policy-readmodel-extraction");
const artifactDir = path.join(proofDir, "artifacts");
const scratch = await mkdtemp(path.join(tmpdir(), "queue-policy-readmodel-proof-"));
const baseRoot = path.join(scratch, "merge-base");
const archivePath = path.join(scratch, "merge-base.tar");
const proofSecret = "queue-policy-readmodel-local-proof-secret";
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
await Promise.all(
  ["failure.json", "proof-summary.json", "response-comparison.json", "normalized.diff"].map(
    (name) => rm(path.join(artifactDir, name), { force: true }),
  ),
);
const mergeBase = (await command("git", ["merge-base", "HEAD", "origin/main"], repoRoot)).trim();
const headSha = (await command("git", ["rev-parse", "HEAD"], repoRoot)).trim();
await mkdir(baseRoot, { recursive: true });
await command("git", ["archive", "--format=tar", "-o", archivePath, mergeBase], repoRoot);
await command("tar", ["-xf", archivePath, "-C", baseRoot], repoRoot);

try {
  const base = await runScenario("merge-base", baseRoot);
  const candidate = await runScenario("candidate", repoRoot);
  const comparisons = [];
  for (const route of ["/api/exact-review-queue", "/api/status"]) {
    const before = normalizeVolatile(base.responses[route]);
    const after = normalizeVolatile(candidate.responses[route]);
    const beforeBytes = stableJson(before);
    const afterBytes = stableJson(after);
    assert.equal(afterBytes, beforeBytes, `normalized response changed for ${route}`);
    comparisons.push({
      route,
      byte_identical: true,
      normalized_bytes: Buffer.byteLength(beforeBytes),
      normalized_sha256: sha256(beforeBytes),
    });
    await writeJson(`${base.label}-${routeName(route)}.normalized.json`, before);
    await writeJson(`${candidate.label}-${routeName(route)}.normalized.json`, after);
  }
  const result = {
    schema: "queue-policy-readmodel-worker-equivalence/v1",
    merge_base: mergeBase,
    candidate_head: headSha,
    worker: "wrangler dev --local",
    durable_object: "SQLite-backed ExactReviewQueue",
    seeded_items: 6,
    seed_route: "/internal/exact-review/enqueue",
    responses: comparisons,
    all_normalized_responses_byte_identical: true,
    production_mutations: 0,
    openclaw_bay_affected: false,
    limits:
      "Synthetic pending issue reviews; no GitHub, lease, publication, or production mutation.",
  };
  await writeJson("response-comparison.json", result);
  await writeJson("proof-summary.json", result);
  await writeFile(path.join(artifactDir, "normalized.diff"), "", "utf8");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  await writeJson("failure.json", {
    merge_base: mergeBase,
    candidate_head: headSha,
    error: error instanceof Error ? error.stack || error.message : String(error),
  });
  throw error;
} finally {
  await Promise.all(workers.map(stopWorker));
  await new Promise((resolve) => githubStub.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}

async function runScenario(label, root) {
  const port = await availablePort();
  const stateDir = await mkdtemp(path.join(tmpdir(), `queue-policy-${label}-state-`));
  const logPath = path.join(artifactDir, `${label}-worker.log`);
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

  for (let index = 0; index < 6; index += 1) {
    const body = {
      delivery_id: `queue-extraction-proof-${index}`,
      decision: {
        targetRepo: index % 2 === 0 ? "openclaw/openclaw" : "openclaw/clawhub",
        targetBranch: "main",
        itemNumber: 88000 + index,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: index % 2 === 0 ? "opened" : "edited",
        supersedesInProgress: false,
        sourceUpdatedAt: "2026-08-11T12:00:00.000Z",
      },
    };
    const response = await signedPost(origin, body);
    assert.equal(response.status, 202, `${label} seed ${index} failed: ${response.text}`);
  }
  const responses = {
    "/api/exact-review-queue": await getJson(`${origin}/api/exact-review-queue`),
    "/api/status": await getJson(`${origin}/api/status`),
  };
  assert.equal(responses["/api/exact-review-queue"].pending, 6);
  await writeJson(`${label}-exact-review-queue.raw.json`, responses["/api/exact-review-queue"]);
  await writeJson(`${label}-status.raw.json`, responses["/api/status"]);
  await stopWorker(worker);
  workers.splice(workers.indexOf(worker), 1);
  return { label, responses };
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

function normalizeVolatile(value, key = "") {
  if (Array.isArray(value)) return value.map((entry) => normalizeVolatile(entry, key));
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
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Worker exited early:\n${await readFile(logPath, "utf8")}`);
    }
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

function routeName(route) {
  return route.replace(/^\/api\//, "").replaceAll("/", "-");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(name, value) {
  await writeFile(path.join(artifactDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
