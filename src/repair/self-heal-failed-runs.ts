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
import { ghErrorText, ghJson, ghText } from "./github-cli.js";
import { sleepMs } from "./timing.js";
import { REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import {
  boundedRecoveryTimeoutMs,
  isRepairWorkflowArtifactUnavailable,
  readNewestRepairWorkflowRecoveryInputs,
  resolveRepairWorkflowRetryMode,
  type RepairWorkflowRecoveryInputs,
} from "./workflow-recovery-inputs.js";
import {
  dispatchProcessOutcome,
  flushDispatchActionEvents,
  prepareDispatchActionReceiptContext,
  runDispatchWithReceiptSync,
} from "./dispatch-action-receipts.js";

const DEFAULT_REPO = currentProjectRepo();
const DEFAULT_WORKFLOW = REPAIR_CLUSTER_WORKFLOW;
const DEFAULT_RUNNER = process.env.CLAWSWEEPER_WORKER_RUNNER ?? "blacksmith-4vcpu-ubuntu-2404";
const DEFAULT_EXECUTION_RUNNER =
  process.env.CLAWSWEEPER_EXECUTION_RUNNER ?? "blacksmith-16vcpu-ubuntu-2404";
const QUEUED_STATUSES = new Set(["queued", "requested", "waiting", "pending"]);
const ACTIVE_STATUSES = new Set([...QUEUED_STATUSES, "in_progress"]);
const WORKFLOW_INPUT_DOWNLOAD_TIMEOUT_MS = 60_000;
const RECOVERY_SCAN_BUDGET_MS = 3 * 60_000;
const MAX_RECOVERY_CANDIDATE_SCANS = 200;

class SelfHealDispatchNotStartedError extends Error {
  readonly dispatchError: unknown;

  constructor(dispatchError: unknown) {
    super(dispatchError instanceof Error ? dispatchError.message : String(dispatchError), {
      cause: dispatchError,
    });
    this.name = "SelfHealDispatchNotStartedError";
    this.dispatchError = dispatchError;
  }
}

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? DEFAULT_REPO);
const workflow = String(args.workflow ?? DEFAULT_WORKFLOW);
const runner = String(args.runner ?? DEFAULT_RUNNER);
const executionRunner = String(
  args["execution-runner"] ?? args.execution_runner ?? DEFAULT_EXECUTION_RUNNER,
);
const model = String(args.model ?? process.env.CLAWSWEEPER_MODEL ?? "internal");
const maxJobs = Number(args["max-jobs"] ?? args.limit ?? 5);
const maxAgeHours = Number(
  args["max-age-hours"] ??
    args.max_age_hours ??
    process.env.CLAWSWEEPER_SELF_HEAL_MAX_AGE_HOURS ??
    6,
);
const maxAttemptsPerJob = Number(process.env.CLAWSWEEPER_SELF_HEAL_MAX_ATTEMPTS_PER_JOB ?? 3);
const maxLiveWorkers = readMaxLiveWorkers(args);
const waitForCapacity = Boolean(args["wait-for-capacity"]);
const execute = Boolean(args.execute);
const openExecuteWindow = Boolean(args["open-execute-window"] || args.live);
const allowRepeat = Boolean(args["allow-repeat"]);
const requestedMode = typeof args.mode === "string" ? args.mode : null;
const skippedCandidates: LooseRecord[] = [];

if (!Number.isInteger(maxJobs) || maxJobs < 1) {
  throw new Error("--max-jobs must be a positive integer");
}
if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
  throw new Error("--max-age-hours must be a positive number");
}
if (!Number.isInteger(maxAttemptsPerJob) || maxAttemptsPerJob < 1) {
  throw new Error("CLAWSWEEPER_SELF_HEAL_MAX_ATTEMPTS_PER_JOB must be a positive integer");
}

const candidates = selectCandidates();
const summary: LooseRecord = {
  status: execute ? "dispatching" : "dry_run",
  repo,
  workflow,
  runner,
  execution_runner: executionRunner,
  model,
  max_jobs: maxJobs,
  max_age_hours: maxAgeHours,
  max_attempts_per_job: maxAttemptsPerJob,
  max_live_workers: maxLiveWorkers,
  candidates: candidates.map((candidate: JsonValue) => summarizeCandidate(candidate)),
  skipped_candidates: skippedCandidates,
};

if (candidates.length === 0) {
  summary.status = "no_candidates";
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (!execute) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const dispatchReceiptContext = prepareDispatchActionReceiptContext({
  component: "repair_self_heal",
});
const gateRestores: JsonValue[] = [];
const dispatchStartedAt = new Date(Date.now() - 5000).toISOString();
const headSha = currentHeadSha();
const ledger = readSelfHealLedger();
const batchId = `self-heal-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const attempts: LooseRecord[] = candidates.map((candidate: JsonValue) => ({
  batch_id: batchId,
  source_run_id: candidate.run_id,
  cluster_id: candidate.cluster_id,
  source_job: candidate.source_job,
  source_dispatch_key: candidate.source_dispatch_key,
  mode: candidate.mode,
  runner: candidate.runner,
  execution_runner: candidate.execution_runner,
  planner_sandbox: candidate.planner_sandbox,
  model: candidate.model,
  dry_run: candidate.dry_run,
  requeue: candidate.requeue,
  requeue_depth: candidate.requeue_depth,
  workflow,
  repo,
  dispatched_at: new Date().toISOString(),
  dispatched_run_ids: [],
  status: "pending",
}));

let selfHealError: unknown = null;
try {
  if (openExecuteWindow) {
    openGate("CLAWSWEEPER_ALLOW_EXECUTE");
    openGate("CLAWSWEEPER_ALLOW_FIX_PR");
  } else {
    assertExecuteGateOpenIfNeeded(candidates);
  }

  summary.live_worker_capacity_before_dispatch = waitForCapacity
    ? waitForLiveWorkerCapacity({ repo, workflow, requested: candidates.length, maxLiveWorkers })
    : assertLiveWorkerCapacity({ repo, workflow, requested: candidates.length, maxLiveWorkers });

  for (let i = 0; i < candidates.length; i += 1) {
    const attempt = attempts[i];
    appendAttempts(ledger, [attempt]);
    writeSelfHealLedger(ledger);
    try {
      dispatchCandidate(candidates[i]);
    } catch (error) {
      if (error instanceof SelfHealDispatchNotStartedError) {
        removeAttempt(ledger, attempt);
        try {
          writeSelfHealLedger(ledger);
        } catch (rollbackError) {
          throw new AggregateError(
            [error.dispatchError, rollbackError],
            "self-heal dispatch did not start and its pending checkpoint could not be removed",
          );
        }
        throw error.dispatchError;
      }
      throw error;
    }
    attempt.status = "dispatched";
    writeSelfHealLedger(ledger);
  }

  const observedRuns = openExecuteWindow
    ? waitForStartedRuns({
        expectedCount: candidates.length,
        headSha,
        since: dispatchStartedAt,
      })
    : [];
  const observedRunIds = observedRuns.map((run: JsonValue) => String(run.databaseId));
  for (const attempt of attempts) {
    attempt.dispatched_run_ids = observedRunIds;
    attempt.observed_runs = observedRuns.map((run: JsonValue) => ({
      run_id: String(run.databaseId),
      status: run.status,
      conclusion: run.conclusion ?? null,
      created_at: run.createdAt,
      url: run.url,
    }));
  }

  writeSelfHealLedger(ledger);

  summary.status = "dispatched";
  summary.batch_id = batchId;
  summary.observed_runs = attempts[0]?.observed_runs ?? [];
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  selfHealError = error;
} finally {
  for (const gate of gateRestores.reverse()) {
    try {
      setGate(gate.name, gate.previous || "1");
    } catch (error) {
      if (!selfHealError) selfHealError = error;
      else
        console.error(
          `self-heal: failed to restore ${gate.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
    }
  }
  try {
    await flushDispatchActionEvents(dispatchReceiptContext.root, {
      env: dispatchReceiptContext.env,
      outputRoot: dispatchReceiptContext.outputRoot,
    });
  } catch (error) {
    if (!selfHealError) selfHealError = error;
    else
      console.error(
        `[action-ledger] failed to finalize self-heal dispatch receipts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
  }
}
if (selfHealError) throw selfHealError;

function selectCandidates() {
  const records = readRunRecords();
  const attempts = readSelfHealLedger().attempts ?? [];
  const activeSourceJobs = execute ? activeRepairSourceJobs() : new Map<string, string[]>();
  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const attemptedRunIds = new Set(
    attempts.map((attempt: JsonValue) => String(attempt.source_run_id ?? "")).filter(Boolean),
  );
  const attemptCountsByJob = new Map<string, number>();
  for (const attempt of attempts) {
    const sourceJob = String(attempt.source_job ?? "");
    if (sourceJob) attemptCountsByJob.set(sourceJob, (attemptCountsByJob.get(sourceJob) ?? 0) + 1);
  }
  const latestByJob = new Map();

  for (const record of records) {
    const sourceJob = record.source_job;
    if (typeof sourceJob !== "string" || !sourceJob) {
      skippedCandidates.push({ reason: "missing_source_job", run_id: record.run_id ?? null });
      continue;
    }
    const current = latestByJob.get(sourceJob);
    const recordSortKey = runSortKey(record);
    const currentSortKey = current ? runSortKey(current) : Number.NEGATIVE_INFINITY;
    if (
      !current ||
      recordSortKey > currentSortKey ||
      (recordSortKey === currentSortKey && record.live_run_record === true)
    ) {
      latestByJob.set(sourceJob, record);
    }
  }

  const eligible = [...latestByJob.values()]
    .filter((record: JsonValue) => record.workflow_conclusion === "failure")
    .filter((record: JsonValue) => {
      const timestamp = recordTimestampMs(record);
      if (timestamp >= cutoffMs) return true;
      skippedCandidates.push({
        reason: "older_than_max_age",
        run_id: record.run_id ?? null,
        source_job: record.source_job ?? null,
        published_at: record.published_at ?? null,
        workflow_created_at: record.workflow_created_at ?? null,
        workflow_updated_at: record.workflow_updated_at ?? null,
      });
      return false;
    })
    .filter((record: JsonValue) => {
      const sourceJob = String(record.source_job ?? "");
      const activeRunIds = activeSourceJobs.get(sourceJob) ?? [];
      if (activeRunIds.length === 0) return true;
      skippedCandidates.push({
        reason: "active_repair_run",
        run_id: record.run_id ?? null,
        source_job: sourceJob,
        active_run_ids: activeRunIds,
      });
      return false;
    })
    .filter((record: JsonValue) => {
      if (allowRepeat) return true;
      const sourceJob = String(record.source_job ?? "");
      const runId = String(record.run_id ?? "");
      if (runId && attemptedRunIds.has(runId)) return false;
      if ((attemptCountsByJob.get(sourceJob) ?? 0) < maxAttemptsPerJob) return true;
      skippedCandidates.push({
        reason: "retry_limit_reached",
        run_id: runId || null,
        source_job: sourceJob,
        attempts: attemptCountsByJob.get(sourceJob) ?? 0,
      });
      return false;
    })
    .sort((left: JsonValue, right: JsonValue) => runSortKey(right) - runSortKey(left));
  const boundedEligible = eligible.slice(0, MAX_RECOVERY_CANDIDATE_SCANS);
  const recoveryDeadlineMs = Date.now() + RECOVERY_SCAN_BUDGET_MS;
  const selected: LooseRecord[] = [];
  for (const record of boundedEligible) {
    if (selected.length >= maxJobs) break;
    const sourceJob = String(record.source_job ?? "");
    const jobPath = sourceJobPath(sourceJob);
    if (!fs.existsSync(jobPath)) {
      skippedCandidates.push({
        reason: "missing_job_file",
        run_id: record.run_id ?? null,
        source_job: sourceJob,
      });
      continue;
    }
    const job = parseJob(jobPath);
    const errors = validateJob(job);
    if (errors.length > 0) {
      throw new Error(`invalid job ${record.source_job}: ${errors.join("; ")}`);
    }
    let recoveredInputs: RepairWorkflowRecoveryInputs | null = null;
    const recoveryTimeoutMs = boundedRecoveryTimeoutMs({
      deadlineMs: recoveryDeadlineMs,
      nowMs: Date.now(),
      maxTimeoutMs: WORKFLOW_INPUT_DOWNLOAD_TIMEOUT_MS,
    });
    if (recoveryTimeoutMs === 0) {
      skippedCandidates.push({
        reason: "recovery_budget_exhausted",
        run_id: record.run_id ?? null,
        source_job: sourceJob,
      });
      break;
    }
    try {
      recoveredInputs = recoverWorkflowInputs(record, recoveryTimeoutMs);
    } catch (error) {
      skippedCandidates.push({
        reason: "immutable_inputs_invalid",
        run_id: record.run_id ?? null,
        source_job: sourceJob,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    selected.push({
      ...record,
      mode: resolveRepairWorkflowRetryMode({
        requestedMode,
        recoveredMode: recoveredInputs?.effective_mode ?? "plan",
        fallbackMode: record.mode ?? job.frontmatter.mode,
      }),
      runner: String(args.runner ?? recoveredInputs?.runner ?? runner),
      execution_runner: String(
        args["execution-runner"] ??
          args.execution_runner ??
          recoveredInputs?.execution_runner ??
          executionRunner,
      ),
      planner_sandbox: String(
        args["planner-sandbox"] ??
          args.planner_sandbox ??
          recoveredInputs?.planner_sandbox ??
          "read-only",
      ),
      model: String(args.model ?? recoveredInputs?.model ?? model),
      dry_run: booleanArg(args["dry-run"] ?? args.dry_run, recoveredInputs?.dry_run ?? true),
      requeue: recoveredInputs?.requeue ?? false,
      requeue_depth: recoveredInputs?.requeue_depth ?? 0,
      source_dispatch_key: recoveredInputs?.source_dispatch_key ?? null,
    });
  }
  return selected;
}

function sourceJobPath(sourceJob: string) {
  return path.isAbsolute(sourceJob) ? sourceJob : path.join(repoRoot(), sourceJob);
}

function activeRepairSourceJobs() {
  const jobs = new Map<string, string[]>();
  let runs: LooseRecord[] = [];
  try {
    runs = listClusterRuns();
  } catch (error) {
    console.warn(`self-heal: cannot list active repair runs: ${ghErrorText(error)}`);
    return jobs;
  }

  for (const run of runs) {
    if (!ACTIVE_STATUSES.has(String(run.status ?? ""))) continue;
    const sourceJob = sourceJobFromRunTitle(String(run.displayTitle ?? ""));
    if (!sourceJob) continue;
    const runId = String(run.databaseId ?? "");
    jobs.set(sourceJob, [...(jobs.get(sourceJob) ?? []), runId].filter(Boolean));
  }
  return jobs;
}

function sourceJobFromRunTitle(title: string) {
  const index = title.indexOf("jobs/");
  if (index < 0) return null;
  return title.slice(index).match(/^jobs\/[A-Za-z0-9_./-]+\.md\b/)?.[0] ?? null;
}

function dispatchCandidate(candidate: LooseRecord) {
  let transportStarted = false;
  let result;
  try {
    result = runDispatchWithReceiptSync({
      root: dispatchReceiptContext.root,
      env: dispatchReceiptContext.env,
      component: "repair_self_heal",
      operationKey: `self-heal:${candidate.run_id}:${candidate.source_job}`,
      dispatchKind: "workflow",
      repository: repo,
      dispatchTarget: workflow,
      dispatchInput: {
        workflow,
        job: String(candidate.source_job ?? ""),
        mode: String(candidate.mode ?? ""),
        runner: String(candidate.runner ?? ""),
        execution_runner: String(candidate.execution_runner ?? ""),
        planner_sandbox: String(candidate.planner_sandbox ?? ""),
        model: String(candidate.model ?? ""),
        dry_run: Boolean(candidate.dry_run),
        requeue: Boolean(candidate.requeue),
        requeue_depth: Number(candidate.requeue_depth ?? 0),
      },
      operation: () => {
        transportStarted = true;
        return spawnSync(
          "gh",
          [
            "workflow",
            "run",
            workflow,
            "--repo",
            repo,
            "-f",
            `job=${candidate.source_job}`,
            "-f",
            `mode=${candidate.mode}`,
            "-f",
            `runner=${candidate.runner}`,
            "-f",
            `execution_runner=${candidate.execution_runner}`,
            "-f",
            `planner_sandbox=${candidate.planner_sandbox}`,
            "-f",
            `model=${candidate.model}`,
            "-f",
            `dry_run=${candidate.dry_run}`,
            "-f",
            `requeue=${candidate.requeue}`,
            "-f",
            `requeue_depth=${candidate.requeue_depth}`,
          ],
          { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
        );
      },
      outcome: dispatchProcessOutcome,
    });
  } catch (error) {
    if (!transportStarted) throw new SelfHealDispatchNotStartedError(error);
    throw error;
  }
  if (result.status !== 0) {
    throw new Error(
      `failed to dispatch ${candidate.source_job}: ${result.stderr || result.stdout}`,
    );
  }
  console.log(`dispatched ${candidate.source_job} from failed run ${candidate.run_id}`);
}

function waitForStartedRuns({ expectedCount, headSha, since }: LooseRecord) {
  const deadline = Date.now() + 10 * 60 * 1000;
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
      return latest;
    }
    sleepMs(10_000);
  }
  return latest;
}

function assertExecuteGateOpenIfNeeded(candidates: LooseRecord[]) {
  if (
    !candidates.some(
      (candidate: JsonValue) =>
        candidate.dry_run !== true && ["execute", "autonomous"].includes(candidate.mode),
    )
  )
    return;
  const current = readExecuteGate();
  if (current !== "1") {
    throw new Error(
      "refusing write-mode self-heal: CLAWSWEEPER_ALLOW_EXECUTE is not 1; rerun with --open-execute-window or open the gate manually",
    );
  }
  const fixCurrent = readFixGate();
  if (fixCurrent !== "1") {
    throw new Error(
      "refusing write-mode self-heal: CLAWSWEEPER_ALLOW_FIX_PR is not 1; rerun with --open-execute-window or open both gates manually",
    );
  }
}

function readRunRecords() {
  const runsDir = path.join(repoRoot(), "results", "runs");
  const records = fs.existsSync(runsDir)
    ? fs
        .readdirSync(runsDir)
        .filter((name: string) => name.endsWith(".json"))
        .map((name: string) => JSON.parse(fs.readFileSync(path.join(runsDir, name), "utf8")))
    : [];
  return [...records, ...liveRunRecords()];
}

function liveRunRecords() {
  try {
    return listClusterRuns()
      .map((run: LooseRecord) => {
        const sourceJob = sourceJobFromRunTitle(String(run.displayTitle ?? ""));
        if (!sourceJob) return null;
        return {
          run_id: String(run.databaseId ?? ""),
          source_job: sourceJob,
          workflow_conclusion: run.conclusion ?? null,
          workflow_created_at: run.createdAt ?? null,
          workflow_updated_at: run.updatedAt ?? null,
          run_url: run.url ?? null,
          live_run_record: true,
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.warn(`self-heal: cannot list live repair runs: ${ghErrorText(error)}`);
    return [];
  }
}

function readSelfHealLedger() {
  const file = selfHealLedgerPath();
  if (!fs.existsSync(file)) {
    return { updated_at: null, attempts: [] };
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function appendAttempts(ledger: LooseRecord, attempts: LooseRecord[]) {
  ledger.updated_at = new Date().toISOString();
  ledger.attempts = [...(ledger.attempts ?? []), ...attempts];
}

function removeAttempt(ledger: LooseRecord, attempt: LooseRecord) {
  ledger.updated_at = new Date().toISOString();
  ledger.attempts = (ledger.attempts ?? []).filter(
    (candidate: LooseRecord) => candidate !== attempt,
  );
}

function writeSelfHealLedger(ledger: LooseRecord) {
  const file = selfHealLedgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function selfHealLedgerPath() {
  return path.join(repoRoot(), "results", "self-heal.json");
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
    "databaseId,workflowName,displayTitle,headSha,status,conclusion,createdAt,updatedAt,url",
  ]).filter((run: LooseRecord) => run.workflowName === workflowName);
}

function workflowDisplayName(workflowNameOrFile: string): string {
  if (workflowNameOrFile === "repair-cluster-worker.yml") return "repair cluster worker";
  return workflowNameOrFile;
}

function readExecuteGate() {
  return readGateValue("CLAWSWEEPER_ALLOW_EXECUTE", { preferEnv: true });
}

function readFixGate() {
  return readGateValue("CLAWSWEEPER_ALLOW_FIX_PR", { preferEnv: true });
}

function openGate(name: string) {
  const previous = readGate(name);
  gateRestores.push({ name, previous });
  if (previous !== "1") setGate(name, "1");
}

function readGate(name: string) {
  return readGateValue(name, { preferEnv: false });
}

function readGateValue(name: string, { preferEnv }: { preferEnv: boolean }) {
  const envValue = process.env[name];
  if (preferEnv && envValue !== undefined && envValue !== "") return envValue;
  const variables = readRepoVariables();
  return variables.find((variable: JsonValue) => variable.name === name)?.value ?? envValue ?? "";
}

function readRepoVariables() {
  try {
    return ghJson<LooseRecord[]>(["variable", "list", "--repo", repo, "--json", "name,value"]);
  } catch (error) {
    const detail = ghErrorText(error);
    if (/HTTP 403|Resource not accessible by integration/i.test(detail)) {
      console.warn("self-heal: cannot read repo variables; falling back to workflow env");
      return [];
    }
    throw error;
  }
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

function runSortKey(record: LooseRecord) {
  const runId = Number(record.run_id);
  if (Number.isFinite(runId) && runId > 0) return runId;
  return Date.parse(record.published_at ?? "") || 0;
}

function recordTimestampMs(record: LooseRecord) {
  return (
    Date.parse(
      record.workflow_updated_at ?? record.workflow_created_at ?? record.published_at ?? "",
    ) || 0
  );
}

function summarizeCandidate(candidate: LooseRecord) {
  return {
    source_run_id: candidate.run_id,
    cluster_id: candidate.cluster_id,
    source_job: candidate.source_job,
    mode: candidate.mode,
    runner: candidate.runner,
    execution_runner: candidate.execution_runner,
    planner_sandbox: candidate.planner_sandbox,
    model: candidate.model,
    dry_run: candidate.dry_run,
    requeue: candidate.requeue,
    requeue_depth: candidate.requeue_depth,
    result_status: candidate.result_status,
    run_url: candidate.run_url,
  };
}

function recoverWorkflowInputs(
  record: LooseRecord,
  timeoutMs: number,
): RepairWorkflowRecoveryInputs | null {
  const runId = String(record.run_id ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(runId)) return null;
  const artifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `clawsweeper-self-heal-inputs-${runId}-`),
  );
  try {
    const downloaded = spawnSync(
      "gh",
      [
        "run",
        "download",
        runId,
        "--repo",
        repo,
        "--dir",
        artifactDir,
        "--pattern",
        `clawsweeper-repair-inputs-${runId}-*`,
      ],
      {
        cwd: repoRoot(),
        encoding: "utf8",
        stdio: "pipe",
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    );
    if (downloaded.status !== 0) {
      if (isRepairWorkflowArtifactUnavailable(downloaded.stderr, downloaded.stdout)) return null;
      throw new Error(
        `could not recover run ${runId} inputs: ${
          downloaded.stderr ||
          downloaded.stdout ||
          downloaded.error?.message ||
          "artifact unavailable"
        }`,
      );
    }
    const recovered = readNewestRepairWorkflowRecoveryInputs(artifactDir, runId);
    if (recovered && recovered.source_job !== String(record.source_job ?? "")) {
      throw new Error(`run ${runId} immutable inputs conflict with the selected source job`);
    }
    return recovered;
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

function booleanArg(value: JsonValue, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("boolean arguments must be true or false");
}
