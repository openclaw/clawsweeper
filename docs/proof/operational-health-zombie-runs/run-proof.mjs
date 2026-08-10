#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const outputDir = path.resolve(
  process.env.PROOF_OUTPUT || ".artifacts/operational-health-zombie-runs",
);
const workerPort = Number(process.env.PROOF_WORKER_PORT || 8793);
const stubPort = Number(process.env.PROOF_STUB_PORT || 8794);
const sourceSha = process.env.PROOF_SOURCE_SHA || (await gitHead());
const sourceTreeSha = await treeHash([
  "dashboard/github-api.ts",
  "dashboard/operational-health.ts",
  "dashboard/worker.ts",
  "dashboard/exact-review-queue.ts",
  "test/dashboard-github-api.test.ts",
  "test/dashboard-operational-health.test.ts",
  "test/dashboard-worker.test.ts",
  "docs/proof/operational-health-zombie-runs/README.md",
  "docs/proof/operational-health-zombie-runs/run-proof.mjs",
  "docs/proof/operational-health-zombie-runs/run-proof.sh",
  "docs/proof/operational-health-zombie-runs/stub-github.mjs",
]);
await mkdir(outputDir, { recursive: true });

const observations = [];
try {
  observations.push(await runStubbedScenario("zombie-only"));
  observations.push(await runStubbedScenario("fresh-backlog"));
  observations.push(await runDefaultScenario());

  const summary = {
    claim:
      "queued runs older than 24 hours remain visible as zombies without degrading operational health, while a 31-minute queued run still degrades it",
    source_sha: sourceSha,
    source_tree_sha: sourceTreeSha,
    generated_at: new Date().toISOString(),
    observations,
    assertions: 21,
    run_status: "succeeded",
  };
  await writeJson("proof-summary.json", summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  await writeJson("proof-failure.json", {
    source_sha: sourceSha,
    source_tree_sha: sourceTreeSha,
    generated_at: new Date().toISOString(),
    error: error instanceof Error ? error.stack : String(error),
    observations,
    run_status: "failed",
  });
  throw error;
}

async function runStubbedScenario(mode) {
  const tracePath = path.join(outputDir, `${mode}-github-requests.jsonl`);
  await writeFile(tracePath, "");
  const stub = startProcess(
    process.execPath,
    [
      "docs/proof/operational-health-zombie-runs/stub-github.mjs",
      mode,
      String(stubPort),
      tracePath,
    ],
    `${mode}-stub.log`,
  );
  await waitForText(path.join(outputDir, `${mode}-stub.log`), "stub-ready");
  const worker = await startWorker(mode, `http://127.0.0.1:${stubPort}`);
  try {
    const payload = await statusPayload();
    await writeJson(`${mode}-status.json`, payload);
    const health = payload.operational_health;
    assert.equal(health.queued_runs, mode === "fresh-backlog" ? 2 : 1);
    assert.equal(health.zombie_queued_runs, 1);
    assert.ok(health.oldest_zombie_queued_minutes >= 1_499);
    assert.ok(health.oldest_zombie_queued_minutes <= 1_502);
    assert.equal(health.queued_over_threshold, mode === "fresh-backlog" ? 1 : 0);
    assert.equal(health.oldest_queued_minutes, mode === "fresh-backlog" ? 31 : 0);
    assert.equal(health.status, mode === "fresh-backlog" ? "degraded" : "healthy");
    assert.equal(
      payload.dashboard_health.reasons.includes("workflow_execution_degraded"),
      mode === "fresh-backlog",
    );
    return {
      scenario: mode,
      operational_health: health,
      dashboard_health: payload.dashboard_health,
      github_requests: (await readFile(tracePath, "utf8")).trim().split("\n").length,
    };
  } finally {
    await stopProcessTree(worker);
    await stopProcessTree(stub);
  }
}

async function runDefaultScenario() {
  const worker = await startWorker("default-origin", null);
  try {
    const payload = await statusPayload();
    await writeJson("default-origin-status.json", payload);
    assert.ok(Array.isArray(payload.diagnostics?.errors));
    assert.ok(payload.operational_health);
    return {
      scenario: "default-origin-unset",
      operational_health: payload.operational_health,
      dashboard_health: payload.dashboard_health,
      diagnostic_errors: payload.diagnostics.errors,
    };
  } finally {
    await stopProcessTree(worker);
  }
}

async function startWorker(name, githubApiUrl) {
  const persistence = await mkdtemp(path.join(os.tmpdir(), `clawsweeper-zombie-${name}-`));
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
    "CLAWSWEEPER_WEBHOOK_SECRET:operational-health-zombie-proof",
    "--var",
    "CACHE_TTL_SECONDS:0",
    "--var",
    "TARGET_REPOS:openclaw/openclaw",
    "--log-level",
    "warn",
  ];
  if (githubApiUrl) args.push("--var", `GITHUB_API_URL:${githubApiUrl}`);
  const child = startProcess("npx", args, `${name}-wrangler.log`);
  child.persistence = persistence;
  try {
    await waitForHttp(`http://127.0.0.1:${workerPort}/api/health`);
    return child;
  } catch (error) {
    await stopProcessTree(child);
    throw error;
  }
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
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await Promise.race([onceExit(child), delay(5_000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await onceExit(child);
  }
  child.logStream?.end();
  if (child.persistence) await rm(child.persistence, { recursive: true, force: true });
  await waitForPortRelease();
}

async function statusPayload() {
  const response = await fetch(`http://127.0.0.1:${workerPort}/api/status`, {
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function waitForText(file, expected) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.includes(expected)) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${expected} in ${file}`);
}

async function waitForPortRelease() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
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
