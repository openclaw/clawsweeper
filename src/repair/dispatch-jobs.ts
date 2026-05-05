#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  activeRepairWorkflowRunForJob,
  assertLiveWorkerCapacity,
  currentProjectRepo,
  parseArgs,
  parseJob,
  readMaxLiveWorkers,
  repoRoot,
  validateJob,
  waitForLiveWorkerCapacity,
} from "./lib.js";
import { sleepMs } from "./timing.js";
import { REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import { AUTOMATION_LIMITS } from "./limits.js";

const args = parseArgs(process.argv.slice(2));
const defaultRunner = process.env.CLAWSWEEPER_WORKER_RUNNER ?? "blacksmith-4vcpu-ubuntu-2404";
const defaultExecutionRunner =
  process.env.CLAWSWEEPER_EXECUTION_RUNNER ?? "blacksmith-16vcpu-ubuntu-2404";
const mode = args.mode ?? "plan";
const runner = args.runner ?? defaultRunner;
const executionRunner = args["execution-runner"] ?? args.execution_runner ?? defaultExecutionRunner;
const workflow = args.workflow ?? REPAIR_CLUSTER_WORKFLOW;
const repo = String(args.repo ?? currentProjectRepo());
const model = String(args.model ?? process.env.CLAWSWEEPER_MODEL ?? "gpt-5.5");
const maxLiveWorkers = readMaxLiveWorkers(args);
const waitForCapacity = Boolean(args["wait-for-capacity"]);
const ref = args.ref ? String(args.ref) : "";
const files = args._;
const activeRepairRunsByPrefix = new Map<string, LooseRecord[]>();

if (files.length === 0) {
  console.error(
    `usage: node scripts/dispatch-jobs.ts <job.md> [...] [--mode plan|execute|autonomous] [--runner label] [--execution-runner label] [--model model] [--max-live-workers ${AUTOMATION_LIMITS.repair_live_runs.default}] [--wait-for-capacity]`,
  );
  process.exit(2);
}

let failed = false;
const validatedJobs: JsonValue[] = [];
for (const file of files) {
  const job = parseJob(file);
  const errors = validateJob(job);
  if (errors.length > 0) {
    failed = true;
    console.error(`invalid job: ${file}`);
    for (const error of errors) console.error(`- ${error}`);
    continue;
  }

  const relative = job.relativePath;
  if (!fs.existsSync(path.join(repoRoot(), relative))) {
    failed = true;
    console.error(`job does not exist inside repo: ${file}`);
    continue;
  }
  validatedJobs.push(relative);
}

const jobs = failed ? [] : validatedJobs.filter((relative) => shouldDispatchJob(relative));

if (!failed) {
  const requested = waitForCapacity ? Math.min(jobs.length, 1) : jobs.length;
  const capacityOptions = { repo, workflow, requested, maxLiveWorkers };
  const capacity = waitForCapacity
    ? waitForLiveWorkerCapacity(capacityOptions)
    : assertLiveWorkerCapacity(capacityOptions);
  console.log(
    `live worker capacity: ${capacity.active}/${capacity.max_live_workers} active; dispatching ${jobs.length} ${workflow} run(s)`,
  );
}

let dispatched = 0;
let index = 0;
while (!failed && index < jobs.length) {
  let batchSize = jobs.length - index;
  if (waitForCapacity) {
    const capacity = waitForLiveWorkerCapacity({
      repo,
      workflow,
      requested: 1,
      maxLiveWorkers,
    });
    batchSize = Math.min(batchSize, Math.max(1, capacity.available || 1));
    console.log(
      `live worker capacity: ${capacity.active}/${capacity.max_live_workers} active; dispatching next ${batchSize} run(s)`,
    );
  }

  for (const relative of jobs.slice(index, index + batchSize)) {
    if (failed) break;
    dispatched += 1;
    dispatchJob(relative, dispatched, jobs.length);
  }
  index += batchSize;
  if (waitForCapacity && !failed && index < jobs.length) {
    sleepMs(15_000);
  }
}

function dispatchJob(relative: JsonValue, position: JsonValue, total: JsonValue) {
  const result = spawnSync(
    "gh",
    [
      "workflow",
      "run",
      workflow,
      "--repo",
      repo,
      ...(ref ? ["--ref", ref] : []),
      "-f",
      `job=${relative}`,
      "-f",
      `mode=${mode}`,
      "-f",
      `runner=${runner}`,
      "-f",
      `execution_runner=${executionRunner}`,
      "-f",
      `model=${model}`,
    ],
    { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    failed = true;
    console.error(result.stderr || result.stdout);
  } else {
    console.log(
      `dispatched ${position}/${total} ${relative} (${mode}) on ${runner}; execution on ${executionRunner}`,
    );
  }
}

function shouldDispatchJob(relative: JsonValue) {
  const activeRun = activeRepairWorkflowRunForJob({
    repo,
    workflow,
    jobPath: relative,
    activeRunsByPrefix: activeRepairRunsByPrefix,
  });
  if (!activeRun) return true;
  console.log(
    `skipping ${relative}: active ${workflow} run already exists (${activeRun.url ?? activeRun.databaseId ?? "unknown run"})`,
  );
  return false;
}

if (failed) process.exit(1);
