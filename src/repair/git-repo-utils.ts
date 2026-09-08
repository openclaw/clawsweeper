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
const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000;

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

export function currentHead(targetDir: string): string {
  return gitOutput(["rev-parse", "HEAD"], { targetDir }).trim();
}

export function runGitCommand(
  args: string[],
  {
    targetDir,
    timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    env = process.env,
  }: TargetDir & { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): SpawnSyncReturns<string> {
  return runCommandResult("git", args, {
    cwd: targetDir,
    env,
    timeoutMs,
  });
}

export function isAncestor({
  targetDir,
  ancestor,
  descendant,
}: TargetDir & { ancestor: string; descendant: string }): boolean {
  const child = runGitCommand(["merge-base", "--is-ancestor", ancestor, descendant], {
    targetDir,
  });
  return child.status === 0;
}

export function branchHasBaseDiff({ targetDir, baseBranch }: TargetBaseBranch): boolean {
  const range = `origin/${baseBranch}...HEAD`;
  const first = runGitCommand(["diff", "--name-only", range], { targetDir });
  if (first.status === 0) return Boolean(first.stdout.trim());
  const detail = `${first.stderr ?? ""}\n${first.stdout ?? ""}`;
  if (!/no merge base/i.test(detail)) throw new Error(detail.trim());

  fetchDeeperHistory({ targetDir, baseBranch });
  const retry = runGitCommand(["diff", "--name-only", range], { targetDir });
  if (retry.status === 0) return Boolean(retry.stdout.trim());
  const retryDetail = `${retry.stderr ?? ""}\n${retry.stdout ?? ""}`;
  if (/no merge base/i.test(retryDetail)) return true;
  throw new Error(retryDetail.trim());
}

export function ensureMergeBaseAvailable({ targetDir, baseBranch }: TargetBaseBranch): string {
  gitFetch(targetDir, ["origin", `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
  const baseRef = `origin/${baseBranch}`;
  const first = runGitCommand(["merge-base", baseRef, "HEAD"], { targetDir });
  if (first.status === 0 && first.stdout.trim()) return first.stdout.trim();

  fetchDeeperHistory({ targetDir, baseBranch });
  const retry = runGitCommand(["merge-base", baseRef, "HEAD"], { targetDir });
  if (retry.status === 0 && retry.stdout.trim()) return retry.stdout.trim();

  const detail = `${retry.stderr ?? ""}\n${retry.stdout ?? ""}`.trim();
  throw new Error(detail || `no merge base between ${baseRef} and HEAD`);
}

export function unmergedPaths(targetDir: string): string[] {
  const child = runGitCommand(["diff", "--name-only", "--diff-filter=U"], { targetDir });
  if (child.status !== 0) return [];
  return child.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function fetchDeeperHistory({ targetDir, baseBranch }: TargetBaseBranch): void {
  const shallow = runGitCommand(["rev-parse", "--is-shallow-repository"], {
    targetDir,
  }).stdout.trim();
  if (shallow === "true" || fs.existsSync(path.join(targetDir, ".git", "shallow"))) {
    gitFetch(targetDir, ["--unshallow", "origin"]);
  } else {
    gitFetch(targetDir, ["origin", "--prune"]);
  }
  gitFetch(targetDir, ["origin", `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
}

function gitFetch(targetDir: string, args: string[]): void {
  gitOutput(["fetch", ...args], { targetDir, timeoutMs: gitNetworkTimeoutMs });
}

export function gitChangedFiles(targetDir: string, baseBranch: string): string[] {
  const baseRef = `origin/${baseBranch}`;
  const committed = gitOutput(["diff", "--name-only", `${baseRef}...HEAD`], { targetDir })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return uniqueStrings([...committed, ...gitStatusPaths(targetDir)]);
}

export function gitStatusPaths(targetDir: string): string[] {
  const entries = gitOutput(["status", "--porcelain", "-z"], { targetDir }).split("\0");
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
  return gitOutput(["ls-files"], { targetDir })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitOutput(
  args: string[],
  options: TargetDir & { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): string {
  const child = runGitCommand(args, options);
  if (child.status === 0) return child.stdout ?? "";
  const detail = [child.stderr, child.stdout].filter(Boolean).join("\n").trim();
  throw new Error(detail || `git exited ${child.status ?? `with signal ${child.signal}`}`);
}
