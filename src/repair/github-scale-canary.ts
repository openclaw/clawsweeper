#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { ghJson } from "./github-cli.js";
import {
  describeHookDelivery,
  errorText,
  postOpenClawAgentHook,
  resolveOpenClawHookConfig,
} from "./openclaw-hook.js";
import { COMMIT_CHECKS_MAX_PAGES, COMMIT_CHECKS_PAGE_SIZE } from "../github-commit-checks.js";

// Warn before a reader reaches its bound, not after reviews start failing.
export const SCALE_HEADROOM_RATIO = 0.8;
// The 2026-11-07 tree-listing outage produced over 150 such failures an hour.
export const SOURCE_PREPARATION_FAILURE_THRESHOLD = 10;
const OPEN_PR_SAMPLE = 100;

export type ScaleObservation = {
  repository: string;
  maxCheckRuns: number;
  maxCheckRunsPr: number | null;
};

export type ReviewFailureObservation = {
  windowMinutes: number;
  sourcePreparationFailures: number;
};

export type ScaleFinding = { key: string; message: string };

/** Which GitHub limits are hit or close, given live observations. */
export function evaluateScaleCanary(
  scale: readonly ScaleObservation[],
  failures: ReviewFailureObservation | null,
): ScaleFinding[] {
  const findings: ScaleFinding[] = [];
  if (failures && failures.sourcePreparationFailures >= SOURCE_PREPARATION_FAILURE_THRESHOLD) {
    findings.push({
      key: "source_preparation_failures",
      message: `${failures.sourcePreparationFailures} reviews failed in source preparation in the last ${failures.windowMinutes} minutes. A GitHub limit (such as a truncated listing) first shows up here.`,
    });
  }
  const checkRunBound = COMMIT_CHECKS_MAX_PAGES * COMMIT_CHECKS_PAGE_SIZE;
  for (const observation of scale) {
    if (observation.maxCheckRuns >= checkRunBound * SCALE_HEADROOM_RATIO) {
      findings.push({
        key: `check_runs:${observation.repository}`,
        message: `${observation.repository}#${observation.maxCheckRunsPr} has ${observation.maxCheckRuns} check runs; ClawSweeper reads at most ${checkRunBound} per commit and treats more as incomplete.`,
      });
    }
  }
  return findings;
}

type CheckRunScaleResponse = {
  pullRequests?: {
    nodes?: Array<{
      number?: number;
      commits?: {
        nodes?: Array<{
          commit?: {
            statusCheckRollup?: { contexts?: { checkRunCount?: number } } | null;
          };
        }>;
      };
    }>;
  };
} | null;

export function observeCheckRunScale(
  repository: string,
  read: (query: string) => unknown = (query) =>
    ghJson(["api", "graphql", "-f", `query=${query}`, "--jq", ".data.repository"]),
): ScaleObservation {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match) throw new Error(`invalid repository: ${repository}`);
  // One query: the most recently updated open PRs and their head's check-run count.
  const response = read(
    `query { repository(owner: "${match[1]}", name: "${match[2]}") { pullRequests(states: OPEN, first: ${OPEN_PR_SAMPLE}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 1) { checkRunCount } } } } } } } } }`,
  ) as CheckRunScaleResponse;
  let maxCheckRuns = 0;
  let maxCheckRunsPr: number | null = null;
  for (const pr of response?.pullRequests?.nodes ?? []) {
    const count = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.checkRunCount ?? 0;
    if (typeof pr.number === "number" && count > maxCheckRuns) {
      maxCheckRuns = count;
      maxCheckRunsPr = pr.number;
    }
  }
  return { repository, maxCheckRuns, maxCheckRunsPr };
}

export function observeReviewFailures(status: unknown): ReviewFailureObservation | null {
  const queue = (status as { exact_review_queue?: { review_failure_health?: unknown } } | null)
    ?.exact_review_queue;
  const health = queue?.review_failure_health as
    | { window_minutes?: unknown; by_stage?: { source_preparation?: unknown } }
    | undefined;
  const failures = health?.by_stage?.source_preparation;
  const windowMinutes = health?.window_minutes;
  if (typeof failures !== "number" || typeof windowMinutes !== "number") return null;
  return { windowMinutes, sourcePreparationFailures: failures };
}

async function main() {
  const repositories = (process.env.TARGET_REPOS ?? "openclaw/openclaw")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const statusUrl =
    process.env.CLAWSWEEPER_STATUS_URL ?? "https://clawsweeper.openclaw.ai/api/status";
  const status = await fetch(statusUrl, { signal: AbortSignal.timeout(30_000) })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const scale = repositories.map((repository) => observeCheckRunScale(repository));
  const findings = evaluateScaleCanary(scale, observeReviewFailures(status));
  console.log(JSON.stringify({ scale, findings }, null, 2));
  if (findings.length === 0) return;
  process.exitCode = 1;
  const config = resolveOpenClawHookConfig(process.env);
  if (!config || process.env.CLAWSWEEPER_SCALE_CANARY_DRY_RUN === "1") return;
  // One alert per finding set per day: the key makes repeat runs idempotent.
  const day = new Date().toISOString().slice(0, 10);
  const result = await postOpenClawAgentHook({
    config,
    fetcher: fetch,
    post: {
      name: "ClawSweeper GitHub scale canary",
      idempotencyKey: `github-scale-canary:${day}:${findings.map((finding) => finding.key).join(",")}`,
      deliver: true,
      message: [
        "Post this ClawSweeper alert to the channel verbatim:",
        "",
        "ClawSweeper GitHub scale canary:",
        ...findings.map((finding) => `- ${finding.message}`),
        "See docs/github-api-limits.md.",
      ].join("\n"),
    },
  });
  console.log(`alert: ${describeHookDelivery(result.delivery)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(errorText(error));
    process.exit(1);
  });
}
