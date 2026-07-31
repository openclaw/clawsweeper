import { ghJsonWithRetry } from "./github-cli.js";
import type { LooseRecord } from "./json-types.js";
import { MAX_LIVE_WORKERS, repairRunNameForJob } from "./live-worker-capacity.js";
import { currentProjectRepo } from "./project-repo.js";

export const ISSUE_IMPLEMENTATION_MAX_WORKER_ATTEMPTS = 3;
export const ISSUE_IMPLEMENTATION_WORKER_RETRY_DELAY_MS = 2 * 60_000;

const ACTIVE_WORKFLOW_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
]);
const WORKFLOW_RUN_PAGE_SIZE = 100;
const MAX_WORKFLOW_RUN_PAGES = Math.ceil(MAX_LIVE_WORKERS / WORKFLOW_RUN_PAGE_SIZE) + 1;

export function issueImplementationWorkerAttemptCount(audit: LooseRecord | null): number {
  const recordedCount = String(audit?.frontmatter?.worker_attempt_count ?? "").trim();
  const count = Number(recordedCount);
  if (recordedCount && Number.isSafeInteger(count) && count >= 0) return count;
  return audit?.frontmatter?.worker_dispatched === "true" ? 1 : 0;
}

export function dispatchedIssueImplementationWorkerRetryDue({
  audit,
  reportRevision,
  nowMs = Date.now(),
}: {
  audit: LooseRecord | null;
  reportRevision: string;
  nowMs?: number;
}): boolean {
  if (!audit || audit.frontmatter?.worker_dispatched !== "true") return false;
  const queuedJobReview = String(
    audit.frontmatter.job_report_revision_sha256 ?? audit.frontmatter.report_revision_sha256 ?? "",
  );
  const sameReview = queuedJobReview === reportRevision;
  if (
    sameReview &&
    issueImplementationWorkerAttemptCount(audit) >= ISSUE_IMPLEMENTATION_MAX_WORKER_ATTEMPTS
  ) {
    return false;
  }
  const retryAfter = Date.parse(String(audit.frontmatter.worker_retry_after ?? ""));
  if (Number.isFinite(retryAfter)) return retryAfter <= nowMs;
  const preparedAt = Date.parse(String(audit.frontmatter.prepared_at ?? ""));
  return (
    !Number.isFinite(preparedAt) || preparedAt + ISSUE_IMPLEMENTATION_WORKER_RETRY_DELAY_MS <= nowMs
  );
}

export function recoverableIssueImplementationWorker({
  audit,
  jobPath,
  reportRevision,
  nowMs = Date.now(),
  fetchRuns = recentIssueImplementationWorkflowRuns,
}: {
  audit: LooseRecord | null;
  jobPath: string;
  reportRevision: string;
  nowMs?: number;
  fetchRuns?: () => LooseRecord[];
}): boolean {
  if (!dispatchedIssueImplementationWorkerRetryDue({ audit, reportRevision, nowMs })) {
    return false;
  }

  const expectedTitle = repairRunNameForJob(jobPath);
  const matchingRuns = fetchRuns()
    .filter((run) => {
      const title = String(run.display_title ?? run.displayTitle ?? "");
      return title === expectedTitle || title.startsWith(`${expectedTitle} [router-`);
    })
    .sort((left, right) => workflowRunTime(right) - workflowRunTime(left));

  if (matchingRuns.length === 0) return false;
  if (matchingRuns.some((run) => ACTIVE_WORKFLOW_STATUSES.has(String(run.status ?? "")))) {
    return false;
  }

  const dispatchedAt = Date.parse(
    String(audit?.frontmatter?.worker_dispatched_at ?? audit?.frontmatter?.prepared_at ?? ""),
  );
  const currentDispatchRuns = Number.isFinite(dispatchedAt)
    ? matchingRuns.filter((run) => workflowRunCreatedAt(run) >= dispatchedAt)
    : matchingRuns;
  if (currentDispatchRuns.length === 0) return false;

  const latestRun = currentDispatchRuns[0];
  return latestRun.status === "completed" && workflowRunTime(latestRun) <= nowMs;
}

export function nextIssueImplementationWorkerRetry(nowMs = Date.now()): string {
  return new Date(nowMs + ISSUE_IMPLEMENTATION_WORKER_RETRY_DELAY_MS).toISOString();
}

export function recentIssueImplementationWorkflowRuns({
  fetchPage,
}: {
  fetchPage?: (args: string[]) => LooseRecord;
} = {}): LooseRecord[] {
  const workflowToken = process.env.CLAWSWEEPER_ISSUE_IMPLEMENTATION_WORKFLOW_TOKEN;
  const env = workflowToken ? { ...process.env, GH_TOKEN: workflowToken } : undefined;
  const readPage =
    fetchPage ?? ((args: string[]) => ghJsonWithRetry<LooseRecord>(args, env ? { env } : {}));
  const runs: LooseRecord[] = [];
  for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES; page += 1) {
    const response = readPage([
      "api",
      `repos/${currentProjectRepo()}/actions/workflows/repair-cluster-worker.yml/runs?per_page=${WORKFLOW_RUN_PAGE_SIZE}&page=${page}`,
    ]);
    const pageRuns = Array.isArray(response?.workflow_runs)
      ? (response.workflow_runs as LooseRecord[])
      : [];
    runs.push(...pageRuns);
    if (pageRuns.length < WORKFLOW_RUN_PAGE_SIZE) break;
  }
  return runs;
}

function workflowRunCreatedAt(run: LooseRecord): number {
  const createdAt = Date.parse(String(run.created_at ?? run.createdAt ?? ""));
  return Number.isFinite(createdAt) ? createdAt : workflowRunTime(run);
}

function workflowRunTime(run: LooseRecord): number {
  const updatedAt = Date.parse(String(run.updated_at ?? run.updatedAt ?? ""));
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(String(run.created_at ?? run.createdAt ?? ""));
  return Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY;
}
