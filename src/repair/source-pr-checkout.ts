import { currentHead } from "./git-repo-utils.js";
import type { GitHubRef } from "./github-ref.js";
import { parsePullRequestUrl, sameRepoSlug } from "./github-ref.js";
import type { JsonValue } from "./json-types.js";
import { runCommand as run } from "./command-runner.js";

const gitNetworkTimeoutMs = Math.max(
  30_000,
  Number(
    process.env.CLAWSWEEPER_GIT_NETWORK_TIMEOUT_MS ??
      process.env.CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS ??
      5 * 60 * 1000,
  ),
);

export type SourcePullRequestCheckout = {
  branch: string;
  sourcePr: GitHubRef;
  sourceHeadSha: string;
  expectedHeadSha: string;
};

export function firstTargetSourcePullRequest(
  sourcePrs: readonly JsonValue[],
  repo: string,
): GitHubRef | null {
  for (const source of sourcePrs) {
    const parsed = parsePullRequestUrl(source);
    if (sameRepoSlug(parsed?.repo, repo)) return parsed;
  }
  return null;
}

export function pullRequestHeadSha(pull: JsonValue): string {
  const sha = String(pull?.head?.sha ?? "").trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : "";
}

export function checkoutSourcePullRequestHead({
  targetDir,
  repo,
  branch,
  sourcePr,
  pull,
}: {
  targetDir: string;
  repo: string;
  branch: string;
  sourcePr: GitHubRef;
  pull: JsonValue;
}): SourcePullRequestCheckout {
  if (!sameRepoSlug(sourcePr.repo, repo)) {
    throw new Error(`source PR ${sourcePr.url} is not in target repo ${repo}`);
  }

  const sourceRef = fetchSourcePullRequestHead({ targetDir, sourcePr });
  run("git", ["checkout", "-B", branch, sourceRef], { cwd: targetDir });

  const sourceHeadSha = currentHead(targetDir);
  const expectedHeadSha = pullRequestHeadSha(pull);
  if (expectedHeadSha && sourceHeadSha !== expectedHeadSha) {
    throw new Error(
      `source PR #${sourcePr.number} checkout head ${sourceHeadSha} did not match expected ${expectedHeadSha}`,
    );
  }

  return {
    branch,
    sourcePr,
    sourceHeadSha,
    expectedHeadSha,
  };
}

export function sourcePullRequestFetchSpec(number: number, branch: string): string {
  return `+refs/pull/${number}/head:${branch}`;
}

export function sourcePullRequestRemoteRef(number: number): string {
  return `refs/remotes/clawsweeper/source-pr-${number}`;
}

export function fetchSourcePullRequestHead({
  targetDir,
  sourcePr,
}: {
  targetDir: string;
  sourcePr: GitHubRef;
}): string {
  const sourceRef = sourcePullRequestRemoteRef(sourcePr.number);
  run("git", ["fetch", "origin", sourcePullRequestFetchSpec(sourcePr.number, sourceRef)], {
    cwd: targetDir,
    timeoutMs: gitNetworkTimeoutMs,
  });
  return sourceRef;
}
