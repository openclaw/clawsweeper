import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { runCommand as run } from "./command-runner.js";
import { uniqueStrings } from "./validation-command-utils.js";

const gitNetworkTimeoutMs = Math.max(
  30_000,
  Number(
    process.env.CLAWSWEEPER_GIT_NETWORK_TIMEOUT_MS ??
      process.env.CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS ??
      5 * 60 * 1000,
  ),
);
const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000;

type TargetDir = {
  targetDir: string;
};

type TargetBranch = TargetDir & {
  branch: string;
};

type TargetBaseBranch = TargetDir & {
  baseBranch: string;
};

export type RebaseOntoBaseResult = {
  status: "already-current" | "rebased" | "conflicts";
  base_ref: string;
  base_sha: string;
  previous_head: string;
  current_head: string;
  detail?: string;
};

export type CompleteRebaseResult = {
  status: "not-in-progress" | "continued";
  previous_head: string;
  current_head: string;
  detail?: string;
};

export function currentHead(targetDir: string): string {
  return run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim();
}

function runGit(
  args: string[],
  { targetDir, timeoutMs = DEFAULT_GIT_TIMEOUT_MS }: TargetDir & { timeoutMs?: number },
): SpawnSyncReturns<string> {
  const child = spawnSync("git", args, {
    cwd: targetDir,
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if ((child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    const rendered = ["git", ...args].join(" ");
    const detail = [child.stderr, child.stdout].filter(Boolean).join("\n").trim();
    const message = `git command timed out after ${timeoutMs}ms: ${rendered}`;
    throw new Error(detail ? `${message}\n${detail}` : message);
  }
  if (child.error) {
    const detail = [child.stderr, child.stdout].filter(Boolean).join("\n").trim();
    throw new Error(detail ? `${child.error.message}\n${detail}` : child.error.message);
  }
  return child;
}

export function isAncestor({
  targetDir,
  ancestor,
  descendant,
}: TargetDir & { ancestor: string; descendant: string }): boolean {
  const child = runGit(["merge-base", "--is-ancestor", ancestor, descendant], { targetDir });
  return child.status === 0;
}

export function remoteBranchExists(options: TargetBranch): boolean {
  return Boolean(remoteBranchSha(options));
}

export function remoteBranchSha({ targetDir, branch }: TargetBranch): string {
  const child = runGit(["ls-remote", "--heads", "origin", branch], {
    targetDir,
    timeoutMs: gitNetworkTimeoutMs,
  });
  if (child.status !== 0) return "";
  const sha = child.stdout.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : "";
}

export function branchHasBaseDiff({ targetDir, baseBranch }: TargetBaseBranch): boolean {
  const range = `origin/${baseBranch}...HEAD`;
  const first = runGit(["diff", "--name-only", range], { targetDir });
  if (first.status === 0) return Boolean(first.stdout.trim());
  const detail = `${first.stderr ?? ""}\n${first.stdout ?? ""}`;
  if (!/no merge base/i.test(detail)) throw new Error(detail.trim());

  fetchDeeperHistory({ targetDir, baseBranch });
  const retry = runGit(["diff", "--name-only", range], { targetDir });
  if (retry.status === 0) return Boolean(retry.stdout.trim());
  const retryDetail = `${retry.stderr ?? ""}\n${retry.stdout ?? ""}`;
  if (/no merge base/i.test(retryDetail)) return true;
  throw new Error(retryDetail.trim());
}

export function ensureMergeBaseAvailable({ targetDir, baseBranch }: TargetBaseBranch): string {
  gitFetch(targetDir, ["origin", `${baseBranch}:refs/remotes/origin/${baseBranch}`]);
  const baseRef = `origin/${baseBranch}`;
  const first = runGit(["merge-base", baseRef, "HEAD"], { targetDir });
  if (first.status === 0 && first.stdout.trim()) return first.stdout.trim();

  fetchDeeperHistory({ targetDir, baseBranch });
  const retry = runGit(["merge-base", baseRef, "HEAD"], { targetDir });
  if (retry.status === 0 && retry.stdout.trim()) return retry.stdout.trim();

  const detail = `${retry.stderr ?? ""}\n${retry.stdout ?? ""}`.trim();
  throw new Error(detail || `no merge base between ${baseRef} and HEAD`);
}

export function rebaseOntoBase({ targetDir, baseBranch }: TargetBaseBranch): RebaseOntoBaseResult {
  ensureMergeBaseAvailable({ targetDir, baseBranch });
  const baseRef = `origin/${baseBranch}`;
  const baseSha = run("git", ["rev-parse", baseRef], { cwd: targetDir }).trim();
  const previousHead = currentHead(targetDir);
  if (isAncestor({ targetDir, ancestor: baseRef, descendant: "HEAD" })) {
    return {
      status: "already-current",
      base_ref: baseRef,
      base_sha: baseSha,
      previous_head: previousHead,
      current_head: previousHead,
    };
  }

  const child = runGit(["rebase", baseRef], { targetDir });
  const detail = `${child.stderr ?? ""}\n${child.stdout ?? ""}`.trim();
  if (child.status === 0) {
    return {
      status: "rebased",
      base_ref: baseRef,
      base_sha: baseSha,
      previous_head: previousHead,
      current_head: currentHead(targetDir),
      detail,
    };
  }
  if (hasRebaseInProgress(targetDir) || unmergedPaths(targetDir).length > 0) {
    return {
      status: "conflicts",
      base_ref: baseRef,
      base_sha: baseSha,
      previous_head: previousHead,
      current_head: currentHead(targetDir),
      detail,
    };
  }
  throw new Error(detail || `git rebase ${baseRef} failed`);
}

export function completeRebaseIfResolved({ targetDir }: TargetDir): CompleteRebaseResult {
  const previousHead = currentHead(targetDir);
  if (!hasRebaseInProgress(targetDir)) {
    return {
      status: "not-in-progress",
      previous_head: previousHead,
      current_head: previousHead,
    };
  }

  assertNoConflictMarkers({ targetDir, paths: unmergedPaths(targetDir) });
  run("git", ["add", "--all"], { cwd: targetDir });
  const unresolved = unmergedPaths(targetDir);
  if (unresolved.length > 0) {
    throw new Error(`rebase conflicts remain unresolved: ${unresolved.join(", ")}`);
  }
  let detail = "";
  while (hasRebaseInProgress(targetDir)) {
    const child = runGit(["-c", "core.editor=true", "rebase", "--continue"], { targetDir });
    detail = `${detail}\n${child.stderr ?? ""}\n${child.stdout ?? ""}`.trim();
    if (child.status !== 0) {
      const remaining = unmergedPaths(targetDir);
      if (remaining.length > 0) {
        throw new Error(`rebase produced additional conflicts: ${remaining.join(", ")}`);
      }
      throw new Error(detail || "git rebase --continue failed");
    }
  }

  return {
    status: "continued",
    previous_head: previousHead,
    current_head: currentHead(targetDir),
    detail,
  };
}

function assertNoConflictMarkers({ targetDir, paths }: TargetDir & { paths: string[] }): void {
  const unresolved = paths.filter((filePath) => {
    const absolute = path.join(targetDir, filePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return false;
    const text = fs.readFileSync(absolute, "utf8");
    return /^<{7} |^={7}$|^>{7} /m.test(text);
  });
  if (unresolved.length > 0) {
    throw new Error(`rebase conflicts remain unresolved: ${unresolved.join(", ")}`);
  }
}

export function hasRebaseInProgress(targetDir: string): boolean {
  const gitDir = run("git", ["rev-parse", "--git-dir"], { cwd: targetDir }).trim();
  const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(targetDir, gitDir);
  return (
    fs.existsSync(path.join(absoluteGitDir, "rebase-merge")) ||
    fs.existsSync(path.join(absoluteGitDir, "rebase-apply"))
  );
}

export function unmergedPaths(targetDir: string): string[] {
  const child = runGit(["diff", "--name-only", "--diff-filter=U"], { targetDir });
  if (child.status !== 0) return [];
  return child.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function fetchDeeperHistory({ targetDir, baseBranch }: TargetBaseBranch): void {
  const shallow = runGit(["rev-parse", "--is-shallow-repository"], { targetDir }).stdout.trim();
  if (shallow === "true" || fs.existsSync(path.join(targetDir, ".git", "shallow"))) {
    gitFetch(targetDir, ["--unshallow", "origin"]);
  } else {
    gitFetch(targetDir, ["origin", "--prune"]);
  }
  gitFetch(targetDir, ["origin", `${baseBranch}:refs/remotes/origin/${baseBranch}`]);
}

function gitFetch(targetDir: string, args: string[]): void {
  run("git", ["fetch", ...args], { cwd: targetDir, timeoutMs: gitNetworkTimeoutMs });
}

export function gitChangedFiles(targetDir: string, baseBranch: string): string[] {
  const baseRef = `origin/${baseBranch}`;
  const committed = run("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd: targetDir })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uncommitted = run("git", ["status", "--porcelain"], { cwd: targetDir })
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^.. /, ""))
    .map((line) => line.split(" -> ").pop())
    .filter(Boolean);
  return uniqueStrings([...committed, ...uncommitted]);
}

export function gitLsFiles(targetDir: string): string[] {
  return run("git", ["ls-files"], { cwd: targetDir })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
