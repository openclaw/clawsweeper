import { ghJson } from "./github-cli.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import { currentProjectRepo } from "./project-repo.js";
import { sleepMs } from "./timing.js";

const DEFAULT_MAX_LIVE_WORKERS = AUTOMATION_LIMITS.repair_live_runs.default;
export const MAX_LIVE_WORKERS = AUTOMATION_LIMITS.repair_live_runs.hard_cap;
export const DEFAULT_AUTOMERGE_REPAIR_RUN_NAME_PREFIX = "automerge repair ";
export const DEFAULT_REPAIR_RUN_NAME_PREFIX = "repair cluster ";
const DEFAULT_CAPACITY_POLL_MS = 30_000;
const DEFAULT_CAPACITY_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STALE_QUEUED_WORKFLOW_MS = 6 * 60 * 60 * 1000;
const ACTIVE_WORKFLOW_STATUSES = ["queued", "in_progress", "waiting", "requested", "pending"];
const ACTIVE_WORKFLOW_STATUS_SET = new Set(ACTIVE_WORKFLOW_STATUSES);
const QUEUED_WORKFLOW_STATUS_SET = new Set(["queued", "waiting", "requested", "pending"]);

export function readMaxLiveWorkers(args: LooseRecord = {}) {
  return readMaxLiveWorkerLimit(
    args["max-live-workers"] ??
      args.max_live_workers ??
      process.env.CLAWSWEEPER_MAX_LIVE_WORKERS ??
      DEFAULT_MAX_LIVE_WORKERS,
  );
}

export function liveWorkerCapacity({
  repo = currentProjectRepo(),
  workflow = REPAIR_CLUSTER_WORKFLOW,
  requested = 1,
  maxLiveWorkers = DEFAULT_MAX_LIVE_WORKERS,
  runNamePrefix = "",
  excludeRunNamePrefix = "",
}: LooseRecord = {}) {
  const requestedCount = readNonNegativeInteger(requested, "requested");
  const max = readMaxLiveWorkerLimit(maxLiveWorkers);
  const activeRuns = listActiveWorkflowRuns({
    repo,
    workflow,
    runNamePrefix,
    excludeRunNamePrefix,
  });
  return {
    repo,
    workflow,
    ...(runNamePrefix ? { run_name_prefix: runNamePrefix } : {}),
    ...(excludeRunNamePrefix ? { exclude_run_name_prefix: excludeRunNamePrefix } : {}),
    active: activeRuns.length,
    requested: requestedCount,
    max_live_workers: max,
    available: Math.max(0, max - activeRuns.length),
    active_runs: activeRuns,
  };
}

export function assertLiveWorkerCapacity(options: LooseRecord = {}) {
  const capacity = liveWorkerCapacity(options);
  if (capacity.requested > capacity.max_live_workers) {
    throw new Error(
      `refusing dispatch: requested ${capacity.requested} ${capacity.workflow} workers exceeds max-live-workers=${capacity.max_live_workers}`,
    );
  }
  if (capacity.active + capacity.requested > capacity.max_live_workers) {
    throw new Error(
      `refusing dispatch: ${capacity.active} active ${capacity.workflow} workers + ${capacity.requested} requested would exceed max-live-workers=${capacity.max_live_workers}`,
    );
  }
  return capacity;
}

export function waitForLiveWorkerCapacity(options: LooseRecord = {}) {
  const requestedCount = readNonNegativeInteger(options.requested ?? 1, "requested");
  const max = readMaxLiveWorkerLimit(options.maxLiveWorkers ?? DEFAULT_MAX_LIVE_WORKERS);
  if (requestedCount > max) {
    throw new Error(
      `refusing dispatch: requested ${requestedCount} ${options.workflow ?? REPAIR_CLUSTER_WORKFLOW} workers exceeds max-live-workers=${max}`,
    );
  }
  const pollMs = readPositiveInteger(
    options.pollMs ??
      process.env.CLAWSWEEPER_LIVE_WORKER_CAPACITY_POLL_MS ??
      DEFAULT_CAPACITY_POLL_MS,
    "capacity poll ms",
  );
  const timeoutMs = readPositiveInteger(
    options.timeoutMs ??
      process.env.CLAWSWEEPER_LIVE_WORKER_CAPACITY_TIMEOUT_MS ??
      DEFAULT_CAPACITY_TIMEOUT_MS,
    "capacity timeout ms",
  );
  const deadline = Date.now() + timeoutMs;
  let latest = null;

  while (Date.now() <= deadline) {
    latest = liveWorkerCapacity(options);
    if (
      latest.requested <= latest.max_live_workers &&
      latest.active + latest.requested <= latest.max_live_workers
    ) {
      return latest;
    }
    sleepMs(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }

  throw new Error(
    `timed out waiting for ${options.workflow ?? REPAIR_CLUSTER_WORKFLOW} capacity: ${latest?.active ?? "unknown"} active + ${requestedCount} requested exceeds max-live-workers=${max}`,
  );
}

export function listActiveWorkflowRuns({
  repo = currentProjectRepo(),
  workflow = REPAIR_CLUSTER_WORKFLOW,
  runNamePrefix = "",
  excludeRunNamePrefix = "",
  nowMs = Date.now(),
  staleQueuedMs = process.env.CLAWSWEEPER_STALE_QUEUED_WORKFLOW_MS ??
    DEFAULT_STALE_QUEUED_WORKFLOW_MS,
  fetchWorkflowRuns = fetchRecentWorkflowRuns,
}: LooseRecord = {}) {
  const fetchRuns =
    typeof fetchWorkflowRuns === "function" ? fetchWorkflowRuns : fetchRecentWorkflowRuns;
  const workflowRuns = fetchRuns({ repo, workflow });
  const staleQueuedWindowMs = readNonNegativeInteger(staleQueuedMs, "stale queued workflow ms");
  const runs = Array.isArray(workflowRuns)
    ? workflowRuns
        .filter((run: JsonValue) => isActiveWorkflowRun(run, Number(nowMs), staleQueuedWindowMs))
        .map((run: JsonValue) => normalizeWorkflowRun(run, String(run.status ?? "")))
    : [];
  return [
    ...new Map(runs.map((run: JsonValue) => [String(run.databaseId ?? run.id), run])).values(),
  ]
    .filter((run: JsonValue) => runMatchesNameFilter(run, runNamePrefix, excludeRunNamePrefix))
    .sort(
      (left: JsonValue, right: JsonValue) =>
        Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""),
    );
}

function fetchRecentWorkflowRuns({ repo, workflow }: LooseRecord) {
  return ACTIVE_WORKFLOW_STATUSES.flatMap((status) => {
    const runs = ghJson([
      "api",
      "--method",
      "GET",
      `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=100&status=${encodeURIComponent(status)}`,
      "--jq",
      ".workflow_runs",
    ]);
    return Array.isArray(runs) ? runs : [];
  });
}

export function repairRunNamePrefixForJob(
  jobPath: JsonValue,
  automergeRunNamePrefix: JsonValue = DEFAULT_AUTOMERGE_REPAIR_RUN_NAME_PREFIX,
) {
  return String(jobPath ?? "").includes("/inbox/automerge-")
    ? String(automergeRunNamePrefix ?? DEFAULT_AUTOMERGE_REPAIR_RUN_NAME_PREFIX)
    : DEFAULT_REPAIR_RUN_NAME_PREFIX;
}

export function repairRunNameForJob(
  jobPath: JsonValue,
  automergeRunNamePrefix: JsonValue = DEFAULT_AUTOMERGE_REPAIR_RUN_NAME_PREFIX,
) {
  return joinRepairRunNamePrefix(
    repairRunNamePrefixForJob(jobPath, automergeRunNamePrefix),
    String(jobPath ?? ""),
  );
}

export function activeRepairWorkflowRunForJob({
  repo = currentProjectRepo(),
  workflow = REPAIR_CLUSTER_WORKFLOW,
  jobPath,
  automergeRunNamePrefix = DEFAULT_AUTOMERGE_REPAIR_RUN_NAME_PREFIX,
  activeRunsByPrefix,
}: LooseRecord = {}) {
  const job = String(jobPath ?? "");
  if (!job) return null;
  const prefix = repairRunNamePrefixForJob(job, automergeRunNamePrefix);
  const expectedTitle = repairRunNameForJob(job, automergeRunNamePrefix);
  if (activeRunsByPrefix instanceof Map && !activeRunsByPrefix.has(prefix)) {
    activeRunsByPrefix.set(
      prefix,
      listActiveWorkflowRuns({
        repo,
        workflow,
        runNamePrefix: prefix,
      }),
    );
  }
  const activeRuns =
    activeRunsByPrefix instanceof Map
      ? activeRunsByPrefix.get(prefix)
      : listActiveWorkflowRuns({
          repo,
          workflow,
          runNamePrefix: prefix,
        });
  return (
    activeRuns?.find((run: JsonValue) => String(run.displayTitle ?? "") === expectedTitle) ?? null
  );
}

export function activeRepairWorkflowRunForJobAfterDispatchRecheck(options: LooseRecord = {}) {
  const activeRun = activeRepairWorkflowRunForJob(options);
  if (activeRun) return activeRun;
  const recheckMs = readNonNegativeInteger(
    options.recheckMs ?? process.env.CLAWSWEEPER_DISPATCH_RECHECK_MS ?? 5000,
    "repair dispatch recheck ms",
  );
  if (recheckMs <= 0) return null;
  sleepMs(recheckMs);
  const cache = options.activeRunsByPrefix;
  if (cache instanceof Map) cache.clear();
  return activeRepairWorkflowRunForJob(options);
}

function runMatchesNameFilter(
  run: LooseRecord,
  runNamePrefix: JsonValue,
  excludeRunNamePrefix: JsonValue,
) {
  const title = String(run.displayTitle ?? "");
  const includePrefix = String(runNamePrefix ?? "");
  const excludePrefix = String(excludeRunNamePrefix ?? "");
  if (includePrefix && !title.startsWith(includePrefix)) return false;
  if (excludePrefix && title.startsWith(excludePrefix)) return false;
  return true;
}

export function normalizeWorkflowRun(run: LooseRecord, fallbackStatus: string) {
  return {
    databaseId: run.databaseId ?? run.database_id ?? run.id,
    status: run.status ?? fallbackStatus,
    conclusion: run.conclusion ?? null,
    createdAt: run.createdAt ?? run.created_at ?? null,
    updatedAt: run.updatedAt ?? run.updated_at ?? null,
    url: run.html_url ?? run.url ?? null,
    displayTitle: run.displayTitle ?? run.display_title ?? run.name ?? null,
  };
}

function isActiveWorkflowRun(run: LooseRecord, nowMs: number, staleQueuedMs: number) {
  const status = String(run.status ?? "");
  if (!ACTIVE_WORKFLOW_STATUS_SET.has(status)) return false;
  if (!QUEUED_WORKFLOW_STATUS_SET.has(status)) return true;
  if (staleQueuedMs <= 0) return true;
  const lastChangedAt = workflowRunLastChangedAt(run);
  if (!Number.isFinite(lastChangedAt)) return true;
  return Math.max(0, nowMs - lastChangedAt) <= staleQueuedMs;
}

function joinRepairRunNamePrefix(prefix: JsonValue, jobPath: string) {
  const text = String(prefix ?? "");
  if (!text || !jobPath) return `${text}${jobPath}`;
  return /\s$/.test(text) ? `${text}${jobPath}` : `${text} ${jobPath}`;
}

function readPositiveInteger(value: JsonValue, name: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function workflowRunLastChangedAt(run: LooseRecord) {
  const updated = Date.parse(String(run.updatedAt ?? run.updated_at ?? ""));
  if (Number.isFinite(updated)) return updated;
  return Date.parse(String(run.createdAt ?? run.created_at ?? ""));
}

function readMaxLiveWorkerLimit(value: JsonValue) {
  const max = readPositiveInteger(value, "max-live-workers");
  if (max > MAX_LIVE_WORKERS) {
    throw new Error(`max-live-workers must be <= ${MAX_LIVE_WORKERS}`);
  }
  return max;
}

function readNonNegativeInteger(value: JsonValue, name: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return number;
}
