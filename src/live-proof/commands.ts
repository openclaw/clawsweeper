import { boolArg, stringArg, type Args } from "../clawsweeper-args.js";
import type { LiveProofPlan, MediaProofCommandRunner } from "../clawsweeper-types.js";
import type { RepositoryProfile } from "../repository-profiles.js";
import { assertLiveProofEnvironmentSanitized } from "./environment.js";
import {
  attachLiveProof,
  detachLiveProof,
  syncDetachedLiveProofComment,
  syncLiveProofComment,
  type LiveProofAttachDependencies,
} from "./attach.js";
import {
  executeLiveProof,
  type LiveProofExecuteDependencies,
  type LiveProofPullRequestState,
} from "./execute.js";

export interface LiveProofCommandDependencies {
  repositoryProfileFor: (repo: string) => RepositoryProfile;
  reportLiveProofPlan: (markdown: string) => LiveProofPlan;
  parseLiveProofPlan: (value: unknown) => LiveProofPlan;
  attach: Omit<LiveProofAttachDependencies, "fetchPullRequest" | "reportLiveProofPlan">;
  fetchPullRequest?: (repo: string, item: number) => Promise<LiveProofPullRequestState>;
  runner?: MediaProofCommandRunner;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export function createLiveProofCommands(dependencies: LiveProofCommandDependencies) {
  const fetchPullRequest =
    dependencies.fetchPullRequest ??
    ((repo: string, item: number) =>
      fetchGitHubPullRequest(repo, item, dependencies.env?.GH_TOKEN ?? process.env.GH_TOKEN));

  async function liveProofCommand(args: Args): Promise<void> {
    const repo = requiredArg(args.repo ?? args.target_repo, "--repo");
    const item = positiveIntegerArg(args.item ?? args.item_number, "--item");
    const outputDir = requiredArg(args.output, "--output");
    if ((dependencies.env ?? process.env).CLAWSWEEPER_SANITIZED_LIVE_PROOF === "1") {
      assertLiveProofEnvironmentSanitized(dependencies.env ?? process.env);
      (dependencies.log ?? console.log)(
        "[live-proof] sanitized environment assertion passed: credentials=0",
      );
    }
    const executeDependencies: LiveProofExecuteDependencies = {
      repositoryProfileFor: dependencies.repositoryProfileFor,
      reportLiveProofPlan: dependencies.reportLiveProofPlan,
      parseLiveProofPlan: dependencies.parseLiveProofPlan,
      fetchPullRequest,
    };
    if (dependencies.runner) executeDependencies.runner = dependencies.runner;
    if (dependencies.env) executeDependencies.env = dependencies.env;
    if (dependencies.log) executeDependencies.log = dependencies.log;
    await executeLiveProof(
      {
        repo,
        item,
        outputDir,
        ...optionalPath(args.record, "recordPath"),
        ...optionalPath(args.plan, "planPath"),
        ...optionalPath(args.checkout, "checkoutPath"),
      },
      executeDependencies,
    );
  }

  async function liveProofAttachCommand(args: Args) {
    const recordPath = requiredArg(args.record, "--record");
    if (boolArg(args.detach)) {
      return detachLiveProof(
        {
          recordPath,
          repositorySlug: requiredRepositorySlugArg(args.repo_slug),
          item: positiveIntegerArg(args.item ?? args.item_number, "--item"),
          dryRun: boolArg(args.dry_run),
        },
        {
          ...dependencies.attach,
          fetchPullRequest,
          reportLiveProofPlan: dependencies.reportLiveProofPlan,
          ...(dependencies.runner ? { runner: dependencies.runner } : {}),
          ...(dependencies.env ? { env: dependencies.env } : {}),
          ...(dependencies.log ? { log: dependencies.log } : {}),
        },
      );
    }
    const bundleDir = requiredArg(args.bundle, "--bundle");
    return attachLiveProof(
      {
        bundleDir,
        recordPath,
        dryRun: boolArg(args.dry_run),
      },
      {
        ...dependencies.attach,
        fetchPullRequest,
        reportLiveProofPlan: dependencies.reportLiveProofPlan,
        ...(dependencies.runner ? { runner: dependencies.runner } : {}),
        ...(dependencies.env ? { env: dependencies.env } : {}),
        ...(dependencies.log ? { log: dependencies.log } : {}),
      },
    );
  }

  function liveProofCommentCommand(args: Args): void {
    const recordPath = requiredArg(args.record, "--record");
    if (boolArg(args.detach)) {
      syncDetachedLiveProofComment(
        {
          recordPath,
          repositorySlug: requiredRepositorySlugArg(args.repo_slug),
          item: positiveIntegerArg(args.item ?? args.item_number, "--item"),
        },
        {
          ...dependencies.attach,
          fetchPullRequest,
          reportLiveProofPlan: dependencies.reportLiveProofPlan,
          ...(dependencies.runner ? { runner: dependencies.runner } : {}),
          ...(dependencies.env ? { env: dependencies.env } : {}),
          ...(dependencies.log ? { log: dependencies.log } : {}),
        },
      );
      return;
    }
    const bundleDir = requiredArg(args.bundle, "--bundle");
    syncLiveProofComment(
      { bundleDir, recordPath },
      {
        ...dependencies.attach,
        fetchPullRequest,
        reportLiveProofPlan: dependencies.reportLiveProofPlan,
        ...(dependencies.runner ? { runner: dependencies.runner } : {}),
        ...(dependencies.env ? { env: dependencies.env } : {}),
        ...(dependencies.log ? { log: dependencies.log } : {}),
      },
    );
  }

  return { liveProofCommand, liveProofAttachCommand, liveProofCommentCommand };
}

export async function fetchGitHubPullRequest(
  repo: string,
  item: number,
  token?: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<LiveProofPullRequestState> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ClawSweeper-live-proof",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const issue = await githubJson(
    `https://api.github.com/repos/${repo}/issues/${item}`,
    headers,
    fetchImplementation,
  );
  if (!("pull_request" in issue))
    return { kind: "issue", state: stringProperty(issue, "state"), headSha: null };
  const pull = await githubJson(
    `https://api.github.com/repos/${repo}/pulls/${item}`,
    headers,
    fetchImplementation,
  );
  const head = pull.head && typeof pull.head === "object" ? pull.head : {};
  return {
    kind: "pull_request",
    state: stringProperty(pull, "state") || stringProperty(issue, "state"),
    headSha:
      typeof (head as Record<string, unknown>).sha === "string"
        ? String((head as Record<string, unknown>).sha)
        : null,
  };
}

function stringProperty(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === "string" ? record[key] : "";
}

async function githubJson(
  url: string,
  headers: Record<string, string>,
  fetchImplementation: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(url, { headers });
  if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}`);
  const value = (await response.json()) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub returned an invalid item response");
  }
  return value as Record<string, unknown>;
}

type ArgValue = string | boolean | string[] | undefined;

function requiredArg(value: ArgValue, label: string): string {
  const result = stringArg(value, "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function positiveIntegerArg(value: ArgValue, label: string): number {
  const result = Number(requiredArg(value, label));
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return result;
}

function requiredRepositorySlugArg(value: ArgValue): string {
  const result = requiredArg(value, "--repo-slug");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result)) {
    throw new Error("--repo-slug must be a canonical repository slug");
  }
  return result;
}

function optionalPath<Key extends string>(
  value: ArgValue,
  key: Key,
): { [Property in Key]?: string } {
  const path = stringArg(value, "").trim();
  return path ? ({ [key]: path } as { [Property in Key]?: string }) : {};
}
