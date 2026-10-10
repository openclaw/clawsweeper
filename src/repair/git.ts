import fs from "node:fs";
import path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { runCommandResult } from "./command-runner.js";
import { uniqueStrings } from "./validation-command-utils.js";

const gitNetworkTimeoutMs = Math.max(
  30_000,
  Number(
    process.env.CLAWSWEEPER_GIT_NETWORK_TIMEOUT_MS ??
      process.env.CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS ??
      5 * 60 * 1000,
  ),
);
const HELPER_GIT_TIMEOUT_MS = 10 * 60 * 1000;

export type GitOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
  timeoutMs?: number;
};

type TargetDir = {
  targetDir: string;
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

/** Run git. A spawn failure or a timeout throws. A non-zero exit returns the result. */
export function runGitResult(args: string[], options: GitOptions): SpawnSyncReturns<string> {
  return runCommandResult("git", args, options);
}

/** Run git and return stdout. A non-zero exit throws with the git output. */
export function runGit(args: string[], options: GitOptions): string {
  const child = runGitResult(args, options);
  if (child.status === 0) return child.stdout;
  const detail = [child.stderr, child.stdout].filter(Boolean).join("\n").trim();
  throw new Error(detail || `git exited ${child.status ?? `with signal ${child.signal}`}`);
}

export function currentHead(targetDir: string): string {
  return runGit(["rev-parse", "HEAD"], helperOptions(targetDir)).trim();
}

function helperOptions(targetDir: string): GitOptions {
  return { cwd: targetDir, timeoutMs: HELPER_GIT_TIMEOUT_MS };
}

export function currentMainHeadSha(cwd: string): string {
  return runGit(["rev-parse", "origin/main"], { cwd }).trim();
}

export function isAncestor({
  targetDir,
  ancestor,
  descendant,
}: TargetDir & { ancestor: string; descendant: string }): boolean {
  const child = runGitResult(
    ["merge-base", "--is-ancestor", ancestor, descendant],
    helperOptions(targetDir),
  );
  return child.status === 0;
}

export function branchHasBaseDiff({ targetDir, baseBranch }: TargetBaseBranch): boolean {
  const range = `origin/${baseBranch}...HEAD`;
  const first = runGitResult(["diff", "--name-only", range], helperOptions(targetDir));
  if (first.status === 0) return Boolean(first.stdout.trim());
  const detail = `${first.stderr ?? ""}\n${first.stdout ?? ""}`;
  if (!/no merge base/i.test(detail)) throw new Error(detail.trim());

  fetchDeeperHistory({ targetDir, baseBranch });
  const retry = runGitResult(["diff", "--name-only", range], helperOptions(targetDir));
  if (retry.status === 0) return Boolean(retry.stdout.trim());
  const retryDetail = `${retry.stderr ?? ""}\n${retry.stdout ?? ""}`;
  if (/no merge base/i.test(retryDetail)) return true;
  throw new Error(retryDetail.trim());
}

export function ensureMergeBaseAvailable({ targetDir, baseBranch }: TargetBaseBranch): string {
  gitFetch(targetDir, ["origin", `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
  const baseRef = `origin/${baseBranch}`;
  const first = runGitResult(["merge-base", baseRef, "HEAD"], helperOptions(targetDir));
  if (first.status === 0 && first.stdout.trim()) return first.stdout.trim();

  fetchDeeperHistory({ targetDir, baseBranch });
  const retry = runGitResult(["merge-base", baseRef, "HEAD"], helperOptions(targetDir));
  if (retry.status === 0 && retry.stdout.trim()) return retry.stdout.trim();

  const detail = `${retry.stderr ?? ""}\n${retry.stdout ?? ""}`.trim();
  throw new Error(detail || `no merge base between ${baseRef} and HEAD`);
}

export function unmergedPaths(targetDir: string): string[] {
  const child = runGitResult(["diff", "--name-only", "--diff-filter=U"], helperOptions(targetDir));
  if (child.status !== 0) return [];
  return child.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function fetchDeeperHistory({ targetDir, baseBranch }: TargetBaseBranch): void {
  const shallow = runGitResult(
    ["rev-parse", "--is-shallow-repository"],
    helperOptions(targetDir),
  ).stdout.trim();
  if (shallow === "true" || fs.existsSync(path.join(targetDir, ".git", "shallow"))) {
    gitFetch(targetDir, ["--unshallow", "origin"]);
  } else {
    gitFetch(targetDir, ["origin", "--prune"]);
  }
  gitFetch(targetDir, ["origin", `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
}

function gitFetch(targetDir: string, args: string[]): void {
  runGit(["fetch", ...args], { cwd: targetDir, timeoutMs: gitNetworkTimeoutMs });
}

export function gitChangedFiles(targetDir: string, baseBranch: string): string[] {
  const baseRef = `origin/${baseBranch}`;
  const committed = runGit(["diff", "--name-only", `${baseRef}...HEAD`], helperOptions(targetDir))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return uniqueStrings([...committed, ...gitStatusPaths(targetDir)]);
}

export function gitStatusPaths(targetDir: string): string[] {
  const entries = runGit(["status", "--porcelain", "-z"], helperOptions(targetDir)).split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!entry) continue;
    paths.push(entry.slice(3));
    // Porcelain -z emits the destination first, then a separate source path for renames/copies.
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
  }
  return paths;
}

export function gitLsFiles(targetDir: string): string[] {
  return runGit(["ls-files"], helperOptions(targetDir))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
