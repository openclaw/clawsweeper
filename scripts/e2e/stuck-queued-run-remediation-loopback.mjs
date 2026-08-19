#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const REPOSITORY = "openclaw/clawsweeper";

async function main(argv) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: { "output-dir": { type: "string", default: ".artifacts/stuck-run-loopback" } },
  });
  const outputDir = resolve(parsed.values["output-dir"]);
  const scratch = await mkdtemp(join(tmpdir(), "clawsweeper-stuck-run-proof-"));
  await mkdir(outputDir, { recursive: true });
  const zombieSeed = join(scratch, "empty-zombies.json");
  await writeFile(zombieSeed, '{"schema_version":1,"zombies":[]}\n', "utf8");

  try {
    const cancel = await runScenario({ name: "cancel", outputDir, zombieSeed });
    const zombie = await runScenario({ name: "zombie", outputDir, zombieSeed });
    const receipt = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      production_script: "scripts/stuck-queued-run-remediation.mjs",
      transport: "loopback HTTP listener via GITHUB_API_URL",
      assertions: {
        stranded_cancelled_exactly_once:
          cancel.summary.actions.length === 1 &&
          cancel.summary.actions[0]?.run_id === cancel.strandedRunId &&
          cancel.summary.actions[0]?.outcome === "cancel_requested" &&
          cancel.trace.filter((entry) => entry.path.endsWith("/cancel")).length === 1,
        young_run_untouched: [...cancel.trace, ...zombie.trace].every(
          (entry) =>
            !entry.path.includes(`/${cancel.youngRunId}`) &&
            !entry.path.includes(`/${zombie.youngRunId}`),
        ),
        zombie_500_500_persisted:
          zombie.summary.actions[0]?.outcome === "permanent_zombie_recorded" &&
          zombie.zombieState.zombies.some((entry) => entry.run_id === zombie.strandedRunId) &&
          zombie.replaySummary.actions.length === 0 &&
          zombie.replaySummary.candidates.some(
            (entry) => entry.run_id === zombie.strandedRunId && entry.reason === "permanent_zombie",
          ) &&
          zombie.replayTrace.every((entry) => entry.method !== "POST"),
      },
      scenarios: {
        cancel: scenarioReceipt(cancel),
        zombie_500_500: scenarioReceipt(zombie),
      },
    };
    if (Object.values(receipt.assertions).some((passed) => !passed)) {
      throw new Error(`loopback proof assertion failed: ${JSON.stringify(receipt.assertions)}`);
    }
    const receiptPath = join(outputDir, "loopback-proof-receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    process.stdout.write(
      `${JSON.stringify({ status: "passed", receipt: receiptPath, assertions: receipt.assertions })}\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runScenario({ name, outputDir, zombieSeed }) {
  const nowMs = Date.now();
  const workflowId = name === "cancel" ? "7001" : "7002";
  const strandedRunId = name === "cancel" ? "910001" : "920001";
  const youngRunId = name === "cancel" ? "910002" : "920002";
  const oldCreatedAt = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
  const youngCreatedAt = new Date(nowMs - 10 * 60 * 1000).toISOString();
  const trace = [];
  const fixture = {
    stranded: queuedRun(strandedRunId, workflowId, oldCreatedAt),
    young: queuedRun(youngRunId, workflowId, youngCreatedAt),
    history: [1, 2, 3].map((offset) => ({
      id: String(Number(strandedRunId) + 10 + offset),
      workflow_id: workflowId,
      status: offset === 2 ? "in_progress" : "completed",
      created_at: new Date(Date.parse(oldCreatedAt) + offset * 60_000).toISOString(),
      run_started_at: new Date(Date.parse(oldCreatedAt) + offset * 60_000).toISOString(),
    })),
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://loopback.invalid");
    trace.push({ method: request.method || "GET", path: url.pathname });
    const base = `/repos/${REPOSITORY}`;
    if (request.method === "GET" && url.pathname === `${base}/actions/runs`) {
      return json(response, 200, {
        total_count: 2,
        workflow_runs: [fixture.stranded, fixture.young],
      });
    }
    if (
      request.method === "GET" &&
      url.pathname === `${base}/actions/workflows/${workflowId}/runs`
    ) {
      return json(response, 200, {
        total_count: fixture.history.length,
        workflow_runs: fixture.history,
      });
    }
    if (request.method === "GET" && url.pathname === `${base}/actions/runs/${strandedRunId}`) {
      return json(response, 200, fixture.stranded);
    }
    if (
      request.method === "POST" &&
      url.pathname === `${base}/actions/runs/${strandedRunId}/cancel`
    ) {
      response.writeHead(name === "cancel" ? 202 : 500).end();
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === `${base}/actions/runs/${strandedRunId}/force-cancel`
    ) {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(404).end();
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback listener has no TCP port");
  const summaryPath = join(outputDir, `${name}-summary.json`);
  const zombiePath = join(outputDir, `${name}-zombies.json`);
  const replaySummaryPath = join(outputDir, `${name}-replay-summary.json`);
  const replayZombiePath = join(outputDir, `${name}-replay-zombies.json`);
  let replayTrace = [];
  try {
    await runProductionScript({
      apiUrl: `http://127.0.0.1:${address.port}`,
      output: summaryPath,
      zombieOutput: zombiePath,
      zombieSeed,
    });
    if (name === "zombie") {
      const firstPassRequestCount = trace.length;
      await runProductionScript({
        apiUrl: `http://127.0.0.1:${address.port}`,
        output: replaySummaryPath,
        zombieOutput: replayZombiePath,
        zombieSeed,
        zombieState: zombiePath,
      });
      replayTrace = trace.splice(firstPassRequestCount);
    }
  } finally {
    server.closeAllConnections();
    await close(server);
  }
  return {
    strandedRunId,
    youngRunId,
    trace,
    summary: JSON.parse(await readFile(summaryPath, "utf8")),
    zombieState: JSON.parse(await readFile(zombiePath, "utf8")),
    replayTrace,
    replaySummary:
      name === "zombie"
        ? JSON.parse(await readFile(replaySummaryPath, "utf8"))
        : { actions: [], candidates: [] },
  };
}

function queuedRun(id, workflowId, createdAt) {
  return {
    id,
    workflow_id: workflowId,
    path: ".github/workflows/sweep.yml",
    status: "queued",
    created_at: createdAt,
    display_title: `proof run ${id}`,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
  };
}

function scenarioReceipt(scenario) {
  return {
    stranded_run_id: scenario.strandedRunId,
    young_run_id: scenario.youngRunId,
    selected_run_ids: scenario.summary.selected.map((entry) => entry.run_id),
    actions: scenario.summary.actions,
    deadline_reached: scenario.summary.deadline_reached,
    request_trace: scenario.trace,
    persisted_zombie_run_ids: scenario.zombieState.zombies.map((entry) => entry.run_id),
    ...(scenario.replayTrace.length
      ? {
          persisted_state_replay: {
            actions: scenario.replaySummary.actions,
            stranded_reason: scenario.replaySummary.candidates.find(
              (entry) => entry.run_id === scenario.strandedRunId,
            )?.reason,
            request_trace: scenario.replayTrace,
          },
        }
      : {}),
  };
}

async function runProductionScript({ apiUrl, output, zombieOutput, zombieSeed, zombieState }) {
  const args = [
    "scripts/stuck-queued-run-remediation.mjs",
    "--repository",
    REPOSITORY,
    "--execute",
    "--output",
    output,
    "--zombie-seed",
    zombieSeed,
    "--zombie-output",
    zombieOutput,
  ];
  if (zombieState) args.push("--zombie-state", zombieState);
  const child = spawn(process.execPath, args, {
    cwd: resolve("."),
    env: { ...process.env, GITHUB_API_URL: apiUrl, GITHUB_TOKEN: "loopback-proof-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`production remediation exited ${exitCode}: ${stderr || stdout}`);
  }
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
