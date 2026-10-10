import { escapeRegExp } from "../clawsweeper-markdown.js";
import { repoSlug } from "./comment-router/dispatch.js";
import { ghJsonWithRetry } from "./github-cli.js";
import type { LooseRecord } from "./json-types.js";
import { currentProjectRepo } from "./project-repo.js";

// Automatic issue implementation pauses itself when its own worker runs keep
// failing. The gate counts finished repair-cluster-worker runs by GitHub run
// conclusion; it never reads model output.
export const ISSUE_IMPLEMENTATION_HEALTH_WINDOW_DAYS = 7;
export const ISSUE_IMPLEMENTATION_HEALTH_MIN_FINISHED_RUNS = 10;
export const ISSUE_IMPLEMENTATION_DEFAULT_MIN_SUCCESS_PERCENT = 50;
export const ISSUE_IMPLEMENTATION_HEALTH_OVERRIDE_VARIABLE =
  "CLAWSWEEPER_AUTO_IMPLEMENT_MIN_SUCCESS_PERCENT";

const WINDOW_MS = ISSUE_IMPLEMENTATION_HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const RUN_PAGE_SIZE = 100;
// Cancelled and skipped runs are superseded or stopped work, not worker failures.
const FAILED_CONCLUSIONS: Record<string, true> = {
  failure: true,
  timed_out: true,
  startup_failure: true,
};

export type IssueImplementationLaneHealth = {
  target_repo: string;
  window_days: number;
  succeeded_runs: number;
  failed_runs: number;
  success_rate_percent: number | null;
  min_success_percent: number;
  min_finished_runs: number;
  paused: boolean;
  notice: string | null;
};

export function issueImplementationLaneHealth({
  runs,
  targetRepo,
  nowMs,
  minSuccessPercent = ISSUE_IMPLEMENTATION_DEFAULT_MIN_SUCCESS_PERCENT,
}: {
  runs: readonly LooseRecord[];
  targetRepo: string;
  nowMs: number;
  minSuccessPercent?: number;
}): IssueImplementationLaneHealth {
  // Worker run names come from the repair-cluster-worker.yml run-name.
  const title = new RegExp(
    `^issue implementation jobs/[^/]+/inbox/issue-${escapeRegExp(repoSlug(targetRepo))}-\\d+\\.md(?: \\[[^\\]]+\\])?$`,
  );
  let succeeded = 0;
  let failed = 0;
  for (const run of runs) {
    if (run.status !== "completed") continue;
    if (!title.test(String(run.display_title))) continue;
    const createdMs = Date.parse(String(run.created_at));
    if (!(createdMs >= nowMs - WINDOW_MS && createdMs <= nowMs)) continue;
    if (run.conclusion === "success") succeeded += 1;
    else if (FAILED_CONCLUSIONS[String(run.conclusion)]) failed += 1;
  }
  const finished = succeeded + failed;
  const successRate = finished ? Math.round((succeeded / finished) * 1000) / 10 : null;
  // The floor compares exact counts; the rounded rate is for display only.
  const paused =
    finished >= ISSUE_IMPLEMENTATION_HEALTH_MIN_FINISHED_RUNS &&
    succeeded * 100 < minSuccessPercent * finished;
  return {
    target_repo: targetRepo,
    window_days: ISSUE_IMPLEMENTATION_HEALTH_WINDOW_DAYS,
    succeeded_runs: succeeded,
    failed_runs: failed,
    success_rate_percent: successRate,
    min_success_percent: minSuccessPercent,
    min_finished_runs: ISSUE_IMPLEMENTATION_HEALTH_MIN_FINISHED_RUNS,
    paused,
    notice: paused
      ? `Automatic issue implementation for ${targetRepo} is paused: ${succeeded} of ` +
        `${finished} finished worker runs in the last ${ISSUE_IMPLEMENTATION_HEALTH_WINDOW_DAYS} ` +
        `days succeeded (${successRate}%), below the ${minSuccessPercent}% floor. Dispatch ` +
        `resumes when the rate recovers or fewer than ` +
        `${ISSUE_IMPLEMENTATION_HEALTH_MIN_FINISHED_RUNS} finished runs remain in the window. ` +
        `To override, set the repository variable ${ISSUE_IMPLEMENTATION_HEALTH_OVERRIDE_VARIABLE}=0.`
      : null,
  };
}

export function currentIssueImplementationLaneHealth({
  targetRepo,
  minSuccessPercent,
  nowMs = Date.now(),
  fetchPage = (args) => ghJsonWithRetry<LooseRecord>(args),
}: {
  targetRepo: string;
  minSuccessPercent?: number;
  nowMs?: number;
  fetchPage?: (args: string[]) => LooseRecord;
}): IssueImplementationLaneHealth {
  // GitHub returns at most 1,000 runs for a `created` filter, so page the
  // unfiltered newest-first list until it passes the start of the window.
  const runs: LooseRecord[] = [];
  for (let page = 1; ; page += 1) {
    const response = fetchPage([
      "api",
      `repos/${currentProjectRepo()}/actions/workflows/repair-cluster-worker.yml/runs?per_page=${RUN_PAGE_SIZE}&page=${page}`,
    ]);
    const pageRuns: LooseRecord[] = response.workflow_runs;
    runs.push(...pageRuns);
    const oldestMs = Date.parse(String(pageRuns.at(-1)?.created_at));
    if (pageRuns.length < RUN_PAGE_SIZE || !(oldestMs >= nowMs - WINDOW_MS)) break;
  }
  return issueImplementationLaneHealth({
    runs,
    targetRepo,
    nowMs,
    ...(minSuccessPercent === undefined ? {} : { minSuccessPercent }),
  });
}

export function issueImplementationLaneHealthSummary(
  health: IssueImplementationLaneHealth,
): string {
  const rate = health.success_rate_percent === null ? "n/a" : `${health.success_rate_percent}%`;
  return [
    `### Automatic issue implementation health (${health.target_repo}, ${health.window_days} days)`,
    "",
    "| Succeeded runs | Failed runs | Success rate | Floor | Lane |",
    "| ---: | ---: | ---: | ---: | --- |",
    `| ${health.succeeded_runs} | ${health.failed_runs} | ${rate} | ${health.min_success_percent}% | ${health.paused ? "paused" : "dispatching"} |`,
    "",
    ...(health.notice ? [health.notice, ""] : []),
  ].join("\n");
}
