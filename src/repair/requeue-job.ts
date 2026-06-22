#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  assertLiveWorkerCapacity,
  currentProjectRepo,
  parseArgs,
  parseJob,
  readMaxLiveWorkers,
  repoRoot,
  validateJob,
  waitForLiveWorkerCapacity,
} from "./lib.js";
import { ghJson, ghText } from "./github-cli.js";
import { sleepMs } from "./timing.js";
import { REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import { AUTOMATION_LIMITS } from "./limits.js";

const DEFAULT_REPO = currentProjectRepo();
const DEFAULT_WORKFLOW = REPAIR_CLUSTER_WORKFLOW;
const DEFAULT_RUNNER = process.env.CLAWSWEEPER_WORKER_RUNNER ?? "blacksmith-4vcpu-ubuntu-2404";
const DEFAULT_EXECUTION_RUNNER =
  process.env.CLAWSWEEPER_EXECUTION_RUNNER ?? "blacksmith-16vcpu-ubuntu-2404";
const QUEUED_STATUSES = new Set(["queued", "requested", "waiting", "pending"]);

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? DEFAULT_REPO);
const workflow = String(args.workflow ?? DEFAULT_WORKFLOW);
const runner = String(args.runner ?? DEFAULT_RUNNER);
const executionRunner = String(
  args["execution-runner"] ?? args.execution_runner ?? DEFAULT_EXECUTION_RUNNER,
);
const model = String(args.model ?? process.env.CLAWSWEEPER_MODEL ?? "internal");
const maxLiveWorkers = readMaxLiveWorkers(args);
const waitForCapacity = Boolean(args["wait-for-capacity"]);
const execute = Boolean(args.execute || args.live);
const openExecuteWindow = Boolean(args["open-execute-window"] || args.live);
const requestedMode = typeof args.mode === "string" ? args.mode : null;
const requestedRunId = args["run-id"] ?? (looksLikeRunId(args._[0]) ? args._[0] : null);

const resolved = requestedRunId
  ? resolveFromRunId(String(requestedRunId))
  : { source_job: args._[0], mode: requestedMode };

if (!resolved.source_job) {
  console.error(
    `usage: node scripts/requeue-job.ts <job.md|run-id> [--mode plan|execute|autonomous] [--execute] [--open-execute-window] [--runner label] [--execution-runner label] [--model model] [--max-live-workers ${AUTOMATION_LIMITS.repair_live_runs.default}] [--wait-for-capacity]`,
  );
  process.exit(2);
}

const job = parseJob(resolved.source_job);
const errors = validateJob(job);
if (errors.length > 0) {
  console.error(`invalid job: ${job.relativePath}`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const mode = requestedMode ?? resolved.mode ?? job.frontmatter.mode;
if (!["plan", "execute", "autonomous"].includes(mode)) {
  throw new Error(`unsupported mode: ${mode}`);
}

const summary: LooseRecord = {
  status: execute ? "dispatching" : "dry_run",
  repo,
  workflow,
  source_run_id: requestedRunId,
  source_job: job.relativePath,
  mode,
  runner,
  execution_runner: executionRunner,
  model,
  max_live_workers: maxLiveWorkers,
};

if (!execute) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const gateRestores: JsonValue[] = [];
const headSha = currentHeadSha();
const dispatchStartedAt = new Date(Date.now() - 5000).toISOString();

try {
  if (openExecuteWindow && ["execute", "autonomous"].includes(mode)) {
    openGate("CLAWSWEEPER_ALLOW_EXECUTE");
    if (job.frontmatter.allow_fix_pr === true || job.frontmatter.allowed_actions.includes("fix")) {
      openGate("CLAWSWEEPER_ALLOW_FIX_PR");
    }
  }

  assertGateOpenIfNeeded(mode);
  summary.live_worker_capacity_before_dispatch = waitForCapacity
    ? waitForLiveWorkerCapacity({ repo, workflow, requested: 1, maxLiveWorkers })
    : assertLiveWorkerCapacity({ repo, workflow, requested: 1, maxLiveWorkers });
  dispatchJob(job.relativePath, mode);
  const observedRuns = waitForStartedRuns({ headSha, since: dispatchStartedAt, expectedCount: 1 });

  summary.status = "dispatched";
  summary.observed_runs = observedRuns.map((run: JsonValue) => ({
    run_id: String(run.databaseId),
    status: run.status,
    conclusion: run.conclusion ?? null,
    created_at: run.createdAt,
    url: run.url,
  }));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  for (const gate of gateRestores.reverse()) {
    setGate(gate.name, gate.previous || "1");
  }
}

function resolveFromRunId(runId: string) {
  const fromLedger = readPublishedRunRecord(runId);
  if (fromLedger?.source_job) {
    return { source_job: fromLedger.source_job, mode: fromLedger.mode };
  }

  const artifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `clawsweeper-repair-requeue-${runId}-`),
  );
  const downloaded = spawnSync(
    "gh",
    ["run", "download", runId, "--repo", repo, "--dir", artifactDir],
    { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
  );
  if (downloaded.status !== 0) {
    throw new Error(`could not resolve run ${runId}: ${downloaded.stderr || downloaded.stdout}`);
  }
  const planPath = findFirstFile(artifactDir, "cluster-plan.json");
  const resultPath = findFirstFile(artifactDir, "result.json");
  if (!planPath) throw new Error(`run ${runId} artifact did not include cluster-plan.json`);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const result = resultPath ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : null;
  return { source_job: plan.source_job, mode: result?.mode ?? plan.mode };
}

function readPublishedRunRecord(runId: string) {
  const file = path.join(repoRoot(), "results", "runs", `${runId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findFirstFile(root: string, basename: string) {
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    const candidate = path.join(root, String(entry));
    if (path.basename(candidate) === basename && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function dispatchJob(jobPath: string, mode: string) {
  const result = spawnSync(
    "gh",
    [
      "workflow",
      "run",
      workflow,
      "--repo",
      repo,
      "-f",
      `job=${jobPath}`,
      "-f",
      `mode=${mode}`,
      "-f",
      `runner=${runner}`,
      "-f",
      `execution_runner=${executionRunner}`,
      "-f",
      `model=${model}`,
      "-f",
      "requeue=true",
    ],
    { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    throw new Error(`failed to dispatch ${jobPath}: ${result.stderr || result.stdout}`);
  }
}

function waitForStartedRuns({ expectedCount, headSha, since }: LooseRecord) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let latest: JsonValue[] = [];
  while (Date.now() < deadline) {
    latest = listClusterRuns()
      .filter((run: JsonValue) => run.headSha === headSha)
      .filter((run: JsonValue) => Date.parse(run.createdAt) >= Date.parse(since))
      .sort(
        (left: JsonValue, right: JsonValue) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      );
    if (
      latest.length >= expectedCount &&
      latest.every((run: JsonValue) => !QUEUED_STATUSES.has(run.status))
    ) {
      return latest.slice(-expectedCount);
    }
    sleepMs(5_000);
  }
  return latest.slice(-expectedCount);
}

function assertGateOpenIfNeeded(mode: string) {
  if (!["execute", "autonomous"].includes(mode)) return;
  if (readGate("CLAWSWEEPER_ALLOW_EXECUTE") !== "1") {
    throw new Error(
      "refusing write-mode requeue: CLAWSWEEPER_ALLOW_EXECUTE is not 1; use --open-execute-window",
    );
  }
}

function listClusterRuns() {
  const workflowName = workflowDisplayName(workflow);
  return ghJson<LooseRecord[]>([
    "run",
    "list",
    "--repo",
    repo,
    "--limit",
    "200",
    "--json",
    "databaseId,workflowName,headSha,status,conclusion,createdAt,url",
  ]).filter((run: LooseRecord) => run.workflowName === workflowName);
}

function workflowDisplayName(workflowNameOrFile: string): string {
  if (workflowNameOrFile === "repair-cluster-worker.yml") return "repair cluster worker";
  return workflowNameOrFile;
}

function readGate(name: string) {
  const variables = ghJson(["variable", "list", "--repo", repo, "--json", "name,value"]);
  return variables.find((variable: JsonValue) => variable.name === name)?.value ?? "";
}

function openGate(name: string) {
  const previous = readGate(name);
  gateRestores.push({ name, previous });
  if (previous !== "1") setGate(name, "1");
}

function setGate(name: string, value: JsonValue) {
  ghText(["variable", "set", name, "--repo", repo, "--body", String(value ?? "")]);
  console.log(`${name}=${value}`);
}

function currentHeadSha() {
  return execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function looksLikeRunId(value: JsonValue) {
  return /^[0-9]{6,}$/.test(String(value ?? ""));
}
