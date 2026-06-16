#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { ghJsonWithRetry } from "./github-cli.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import { parseArgs } from "./lib.js";
import { sleepMs } from "./timing.js";

const ACTIVE_STATUSES = ["in_progress", "pending", "queued", "waiting", "requested"];
const EXACT_REVIEW_TITLE_PREFIX = "Review event item ";
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export type CapacityRun = {
  databaseId: number;
  displayTitle: string;
  status: string;
  createdAt: string;
};

export type CodexCapacitySnapshot = {
  runs: CapacityRun[];
};

export type ExactReviewAdmission = {
  proceed: boolean;
  current_rank: number;
  exact_waiters: number;
  exact_limit: number;
};

export function exactReviewAdmission({
  currentRunId,
  snapshot,
  exactLimit = AUTOMATION_LIMITS.exact_review.concurrent_max,
}: {
  currentRunId: number;
  snapshot: CodexCapacitySnapshot;
  exactLimit?: number;
}): ExactReviewAdmission {
  const exactRuns = snapshot.runs
    .filter((run) => run.displayTitle.startsWith(EXACT_REVIEW_TITLE_PREFIX))
    .sort(compareRuns);
  if (!exactRuns.some((run) => run.databaseId === currentRunId)) {
    throw new Error(
      `current exact-review run ${currentRunId} was not found in active Actions runs`,
    );
  }

  const currentIndex = exactRuns.findIndex((run) => run.databaseId === currentRunId);

  return {
    proceed: currentIndex >= 0 && currentIndex < exactLimit,
    current_rank: currentIndex + 1,
    exact_waiters: exactRuns.length,
    exact_limit: exactLimit,
  };
}

export function waitForExactReviewAdmission({
  repo,
  currentRunId,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchSnapshot = fetchCodexCapacitySnapshot,
}: {
  repo: string;
  currentRunId: number;
  pollMs?: number;
  timeoutMs?: number;
  fetchSnapshot?: (repo: string) => CodexCapacitySnapshot;
}): ExactReviewAdmission {
  const deadline = Date.now() + timeoutMs;
  let latest: ExactReviewAdmission | undefined;
  let lastError: Error | undefined;

  while (Date.now() <= deadline) {
    try {
      latest = exactReviewAdmission({
        currentRunId,
        snapshot: fetchSnapshot(repo),
      });
      lastError = undefined;
      if (latest.proceed) return latest;
      console.error(
        `Waiting for Codex capacity: exact rank ${latest.current_rank}/${latest.exact_waiters}, ` +
          `${latest.exact_limit} exact-review slots configured.`,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Could not verify Codex capacity: ${lastError.message}`);
    }
    sleepMs(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }

  if (lastError) {
    throw new Error(`timed out verifying Codex capacity: ${lastError.message}`);
  }
  throw new Error(
    `timed out waiting for Codex capacity: exact rank ${latest?.current_rank ?? "unknown"}/` +
      `${latest?.exact_waiters ?? "unknown"}, ${latest?.exact_limit ?? 0} exact-review slots configured`,
  );
}

export function fetchCodexCapacitySnapshot(repo: string): CodexCapacitySnapshot {
  return { runs: fetchActiveExactReviewRuns(repo) };
}

export function fetchActiveExactReviewRuns(
  repo: string,
  fetchPage: (args: string[]) => JsonValue[] = (args) =>
    ghJsonWithRetry<JsonValue[]>(args, { attempts: 3 }),
): CapacityRun[] {
  const runs = ACTIVE_STATUSES.flatMap((status) => {
    const statusRuns: JsonValue[] = [];
    for (let page = 1; ; page += 1) {
      const pageRuns = fetchPage([
        "api",
        "--method",
        "GET",
        `repos/${repo}/actions/workflows/sweep.yml/runs?per_page=100&event=repository_dispatch&status=${status}&page=${page}`,
        "--jq",
        ".workflow_runs",
      ]);
      statusRuns.push(...pageRuns);
      if (pageRuns.length < 100) break;
    }
    return statusRuns;
  });
  return [
    ...new Map(
      runs.map((run: LooseRecord) => {
        const normalized = normalizeRun(run);
        return [normalized.databaseId, normalized] as const;
      }),
    ).values(),
  ].filter((run) => run.displayTitle.startsWith(EXACT_REVIEW_TITLE_PREFIX));
}

function normalizeRun(run: LooseRecord): CapacityRun {
  return {
    databaseId: Number(run?.id ?? run?.databaseId ?? run?.database_id),
    displayTitle: String(run?.display_title ?? run?.displayTitle ?? ""),
    status: String(run?.status ?? ""),
    createdAt: String(run?.created_at ?? run?.createdAt ?? ""),
  };
}

function compareRuns(left: CapacityRun, right: CapacityRun): number {
  const timeDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
  return left.databaseId - right.databaseId;
}

function positiveInteger(value: JsonValue, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${name} must be a positive integer`);
  return number;
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  const repo = String(args.repo ?? process.env.GITHUB_REPOSITORY ?? "").trim();
  if (!repo) throw new Error("--repo or GITHUB_REPOSITORY is required");
  const currentRunId = positiveInteger(args["run-id"] ?? process.env.GITHUB_RUN_ID, "run id");
  const admission = waitForExactReviewAdmission({
    repo,
    currentRunId,
    pollMs: positiveInteger(args["poll-ms"] ?? DEFAULT_POLL_MS, "poll ms"),
    timeoutMs: positiveInteger(args["timeout-ms"] ?? DEFAULT_TIMEOUT_MS, "timeout ms"),
  });
  process.stdout.write(`${JSON.stringify(admission)}\n`);
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}

if (isCliEntrypoint()) runCli();
