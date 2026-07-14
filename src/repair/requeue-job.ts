#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import { createHash } from "node:crypto";
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
import {
  flushCommandActionEvents,
  recordCommandLifecycleFailure,
  recordCommandRequeue,
  runCommandLifecycleMutation,
  type CommandLifecycleInput,
} from "./command-action-ledger.js";
import {
  boundedNextRequeueDepth,
  deterministicRequeueDispatchKey,
  normalizedRequeueSourceJobPath,
} from "./requeue-job-key.js";
import {
  isRepairWorkflowArtifactUnavailable,
  readNewestRepairLegacyRecoveryInputs,
  readNewestRepairWorkflowRecoveryInputs,
  resolveRepairWorkflowRetryMode,
  type RepairWorkflowRecoveryInputs,
} from "./workflow-recovery-inputs.js";

const DEFAULT_REPO = currentProjectRepo();
const DEFAULT_WORKFLOW = REPAIR_CLUSTER_WORKFLOW;
const DEFAULT_RUNNER = process.env.CLAWSWEEPER_WORKER_RUNNER ?? "blacksmith-4vcpu-ubuntu-2404";
const DEFAULT_EXECUTION_RUNNER =
  process.env.CLAWSWEEPER_EXECUTION_RUNNER ?? "blacksmith-16vcpu-ubuntu-2404";
const QUEUED_STATUSES = new Set(["queued", "requested", "waiting", "pending"]);
const WORKFLOW_INPUT_DOWNLOAD_TIMEOUT_MS = 60_000;

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? DEFAULT_REPO);
const workflow = String(args.workflow ?? DEFAULT_WORKFLOW);
const requestedMode = typeof args.mode === "string" ? args.mode : null;
const requestedRunId = args["run-id"] ?? (looksLikeRunId(args._[0]) ? args._[0] : null);
const resolved: ResolvedRequeueSource = requestedRunId
  ? resolveFromRunId(String(requestedRunId))
  : { source_job: args._[0], mode: requestedMode, workflow_inputs: null };
const recoveredInputs = resolved.workflow_inputs;
const runner = String(args.runner ?? recoveredInputs?.runner ?? DEFAULT_RUNNER);
const executionRunner = String(
  args["execution-runner"] ??
    args.execution_runner ??
    recoveredInputs?.execution_runner ??
    DEFAULT_EXECUTION_RUNNER,
);
const plannerSandbox = String(
  args["planner-sandbox"] ??
    args.planner_sandbox ??
    recoveredInputs?.planner_sandbox ??
    "read-only",
);
if (!["read-only", "danger-full-access"].includes(plannerSandbox)) {
  throw new Error(`unsupported planner sandbox: ${plannerSandbox}`);
}
const model = String(
  args.model ?? recoveredInputs?.model ?? process.env.CLAWSWEEPER_MODEL ?? "internal",
);
const dryRun = booleanArg(
  args["dry-run"] ?? args.dry_run,
  recoveredInputs?.dry_run ?? Boolean(requestedRunId),
);
const maxLiveWorkers = readMaxLiveWorkers(args);
const waitForCapacity = Boolean(args["wait-for-capacity"]);
const execute = Boolean(args.execute || args.live);
const openExecuteWindow = Boolean(args["open-execute-window"] || args.live);
const sourceRunId = String(
  args["source-run-id"] ?? requestedRunId ?? process.env.GITHUB_RUN_ID ?? "",
).trim();
const requeueDepth = nonNegativeIntegerArg(
  args["requeue-depth"],
  "requeue-depth",
  recoveredInputs?.requeue_depth ?? 0,
);
const maxRequeueDepth = nonNegativeIntegerArg(args["max-requeue-depth"], "max-requeue-depth", 1);

if (!resolved.source_job) {
  console.error(
    `usage: node scripts/requeue-job.ts <job.md|run-id> [--mode plan|execute|autonomous] [--execute] [--open-execute-window] [--source-run-id id] [--source-job-path path] [--requeue-depth n] [--max-requeue-depth n] [--runner label] [--execution-runner label] [--planner-sandbox read-only|danger-full-access] [--model model] [--dry-run true|false] [--max-live-workers ${AUTOMATION_LIMITS.repair_live_runs.default}] [--wait-for-capacity]`,
  );
  process.exit(2);
}

const job = parseJob(String(resolved.source_job));
const sourceJobPath = normalizedRequeueSourceJobPath(args["source-job-path"], job.relativePath);
const authorizationSha256 = createHash("sha256").update(job.raw).digest("hex");
const errors = validateJob(job);
if (errors.length > 0) {
  console.error(`invalid job: ${job.relativePath}`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const mode = resolveRepairWorkflowRetryMode({
  requestedMode,
  recoveredMode: recoveredInputs?.effective_mode ?? (requestedRunId ? "plan" : null),
  fallbackMode: resolved.mode ?? job.frontmatter.mode,
});

const summary: LooseRecord = {
  status: execute ? "dispatching" : "dry_run",
  repo,
  workflow,
  source_run_id: sourceRunId || null,
  source_job: sourceJobPath,
  source_authorization_sha256: authorizationSha256,
  requeue_depth: requeueDepth,
  max_requeue_depth: maxRequeueDepth,
  mode,
  runner,
  execution_runner: executionRunner,
  planner_sandbox: plannerSandbox,
  model,
  dry_run: dryRun,
  max_live_workers: maxLiveWorkers,
};

if (!execute) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const gateRestores: JsonValue[] = [];
const headSha = currentHeadSha();
const dispatchStartedAt = new Date(Date.now() - 5000).toISOString();
const nextRequeueDepth = boundedNextRequeueDepth(requeueDepth, maxRequeueDepth);
const dispatchKey = deterministicRequeueDispatchKey({
  repo,
  workflow,
  sourceRunId: sourceRunId || null,
  sourceJobPath,
  authorizationSha256,
  depth: nextRequeueDepth,
});
const requeueLifecycle: CommandLifecycleInput = {
  repository: repo,
  operationKey: `repair-requeue:${repo}:${sourceJobPath}:${authorizationSha256}:depth:${nextRequeueDepth}`,
  sourceRevision: authorizationSha256,
  attemptId: dispatchKey,
};
let commandError: unknown = null;

try {
  if (!dryRun && openExecuteWindow && ["execute", "autonomous"].includes(mode)) {
    openGate("CLAWSWEEPER_ALLOW_EXECUTE", requeueLifecycle);
    if (job.frontmatter.allow_fix_pr === true || job.frontmatter.allowed_actions.includes("fix")) {
      openGate("CLAWSWEEPER_ALLOW_FIX_PR", requeueLifecycle);
    }
  }

  assertGateOpenIfNeeded(mode, dryRun);
  summary.live_worker_capacity_before_dispatch = waitForCapacity
    ? waitForLiveWorkerCapacity({ repo, workflow, requested: 1, maxLiveWorkers })
    : assertLiveWorkerCapacity({ repo, workflow, requested: 1, maxLiveWorkers });
  dispatchJob(sourceJobPath, mode, dispatchKey, requeueLifecycle);
  recordCommandRequeue(requeueLifecycle, {
    dispatchKey,
    sourceJobPath,
    sourceJobSha256: authorizationSha256,
    depth: nextRequeueDepth,
  });
  const observedRuns = waitForStartedRuns({ headSha, since: dispatchStartedAt, expectedCount: 1 });

  summary.status = "dispatched";
  summary.dispatch_key = dispatchKey;
  summary.observed_runs = observedRuns.map((run: JsonValue) => ({
    run_id: String(run.databaseId),
    status: run.status,
    conclusion: run.conclusion ?? null,
    created_at: run.createdAt,
    url: run.url,
  }));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  commandError = error;
} finally {
  for (const gate of gateRestores.reverse()) {
    try {
      setGate(gate.name, gate.previous || "1", requeueLifecycle);
    } catch (error) {
      if (!commandError) {
        commandError = error;
      } else {
        console.error(
          `failed to restore ${gate.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
if (commandError) {
  recordCommandLifecycleFailure(requeueLifecycle, {
    component: "repair_requeue",
    error: commandError,
  });
}
try {
  await flushCommandActionEvents();
} catch (error) {
  if (commandError) {
    console.error(
      `[action-ledger] failed to finalize repair requeue receipts: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } else {
    commandError = error;
  }
}
if (commandError) throw commandError;

function resolveFromRunId(runId: string) {
  const fromLedger = readPublishedRunRecord(runId);
  const artifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `clawsweeper-repair-requeue-${runId}-`),
  );
  try {
    const recoveryDir = path.join(artifactDir, "recovery");
    fs.mkdirSync(recoveryDir);
    const recoveryDownload = downloadRunArtifacts(
      runId,
      recoveryDir,
      `clawsweeper-repair-inputs-${runId}-*`,
    );
    if (recoveryDownload.status === 0) {
      const workflowInputs = readNewestRepairWorkflowRecoveryInputs(recoveryDir, runId);
      if (!workflowInputs) {
        throw new Error(`run ${runId} recovery artifact did not contain immutable inputs`);
      }
      const ledgerSourceJob = String(fromLedger?.source_job ?? "").trim();
      if (ledgerSourceJob && ledgerSourceJob !== workflowInputs.source_job) {
        throw new Error(`run ${runId} record conflicts with its immutable workflow inputs`);
      }
      return {
        source_job: workflowInputs.source_job,
        mode: workflowInputs.effective_mode,
        workflow_inputs: workflowInputs,
      };
    }
    if (!isRepairWorkflowArtifactUnavailable(recoveryDownload.stderr, recoveryDownload.stdout)) {
      throw new Error(`could not resolve run ${runId}: ${artifactDownloadError(recoveryDownload)}`);
    }
    if (fromLedger?.source_job) {
      return {
        source_job: fromLedger.source_job,
        mode: fromLedger.mode,
        workflow_inputs: null,
      };
    }

    const legacyDir = path.join(artifactDir, "legacy");
    fs.mkdirSync(legacyDir);
    const legacyDownloads = [
      `clawsweeper-repair-${runId}-*`,
      `clawsweeper-repair-worker-${runId}-*`,
    ].map((pattern) => downloadRunArtifacts(runId, legacyDir, pattern));
    const failedLegacyDownload = legacyDownloads.find(
      (download) =>
        download.status !== 0 &&
        !isRepairWorkflowArtifactUnavailable(download.stderr, download.stdout),
    );
    if (failedLegacyDownload) {
      throw new Error(
        `could not resolve run ${runId}: ${artifactDownloadError(failedLegacyDownload)}`,
      );
    }
    if (legacyDownloads.some((download) => download.status === 0)) {
      const legacyInputs = readNewestRepairLegacyRecoveryInputs(legacyDir, runId);
      if (legacyInputs) {
        return {
          source_job: legacyInputs.source_job,
          mode: legacyInputs.mode,
          workflow_inputs: null,
        };
      }
      throw new Error(`run ${runId} legacy artifact did not contain one complete repair cohort`);
    }
    throw new Error(
      `could not resolve run ${runId}: ${legacyDownloads.map(artifactDownloadError).join("; ")}`,
    );
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

function downloadRunArtifacts(runId: string, outputDir: string, pattern: string) {
  return spawnSync(
    "gh",
    ["run", "download", runId, "--repo", repo, "--dir", outputDir, "--pattern", pattern],
    {
      cwd: repoRoot(),
      encoding: "utf8",
      stdio: "pipe",
      timeout: WORKFLOW_INPUT_DOWNLOAD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
}

function artifactDownloadError(result: ReturnType<typeof downloadRunArtifacts>) {
  return result.stderr || result.stdout || result.error?.message || "artifact unavailable";
}

function readPublishedRunRecord(runId: string) {
  const file = path.join(repoRoot(), "results", "runs", `${runId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function dispatchJob(
  jobPath: string,
  mode: string,
  dispatchKey: string,
  lifecycle: CommandLifecycleInput,
) {
  const dispatchInput = {
    repository: repo,
    workflow,
    job: jobPath,
    dispatch_key: dispatchKey,
    mode,
    runner,
    execution_runner: executionRunner,
    planner_sandbox: plannerSandbox,
    model,
    dry_run: dryRun,
    requeue: true,
    requeue_depth: nextRequeueDepth,
  };
  const result = runCommandLifecycleMutation(lifecycle, {
    kind: "requeue_dispatch",
    identity: dispatchInput,
    component: "repair_requeue",
    operation: () =>
      spawnSync(
        "gh",
        [
          "workflow",
          "run",
          workflow,
          "--repo",
          dispatchInput.repository,
          "-f",
          `job=${dispatchInput.job}`,
          "-f",
          `dispatch_key=${dispatchInput.dispatch_key}`,
          "-f",
          `mode=${dispatchInput.mode}`,
          "-f",
          `runner=${dispatchInput.runner}`,
          "-f",
          `execution_runner=${dispatchInput.execution_runner}`,
          "-f",
          `planner_sandbox=${dispatchInput.planner_sandbox}`,
          "-f",
          `model=${dispatchInput.model}`,
          "-f",
          `dry_run=${dispatchInput.dry_run}`,
          "-f",
          `requeue=${dispatchInput.requeue}`,
          "-f",
          `requeue_depth=${dispatchInput.requeue_depth}`,
        ],
        { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
      ),
    outcome: (dispatch) => (dispatch.status === 0 && !dispatch.error ? "accepted" : "unknown"),
  });
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

function assertGateOpenIfNeeded(mode: string, isDryRun: boolean) {
  if (isDryRun) return;
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

function openGate(name: string, lifecycle: CommandLifecycleInput) {
  const previous = readGate(name);
  gateRestores.push({ name, previous });
  if (previous !== "1") setGate(name, "1", lifecycle);
}

function setGate(name: string, value: JsonValue, lifecycle: CommandLifecycleInput) {
  runCommandLifecycleMutation(lifecycle, {
    kind: "repository_variable_update",
    identity: { repository: repo, name, value: String(value ?? "") },
    component: "repair_requeue",
    operation: () =>
      ghText(["variable", "set", name, "--repo", repo, "--body", String(value ?? "")]),
  });
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

function nonNegativeIntegerArg(value: JsonValue, name: string, fallback: number): number {
  if (value === undefined || value === null || value === false || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function booleanArg(value: JsonValue, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("boolean arguments must be true or false");
}

type ResolvedRequeueSource = {
  source_job: JsonValue;
  mode: string | null;
  workflow_inputs: RepairWorkflowRecoveryInputs | null;
};
