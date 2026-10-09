import type { SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { mergeCommentRouterLedgers } from "./comment-router/ledger.js";
import { runGitResult } from "./git.js";
import { clawsweeperGitUserEmail, clawsweeperGitUserName } from "./process-env.js";
import { mergeSweepStatusJson } from "./sweep-status-merge.js";
import { acquireStateWriterCoordinator } from "./state-writer-coordinator.js";

type StateGitOptions = {
  allowFailure?: boolean;
  quiet?: boolean;
  timeoutMs?: number;
};

export type RebaseStrategy = "normal" | "theirs";

export type GitPublishOptions = {
  message: string;
  paths: readonly string[];
  restorePaths?: readonly string[];
  maxAttempts?: number;
  pushAttempts?: number;
  remote?: string;
  branch?: string;
  rebaseStrategy?: RebaseStrategy;
};

export type PublishResult = "committed" | "unchanged";

const GIT_TIMEOUT_MS = 60_000;
const GIT_PUSH_TIMEOUT_MS = 300_000;

function configureGitUser(): void {
  stateGit(["config", "user.name", clawsweeperGitUserName()]);
  stateGit(["config", "user.email", clawsweeperGitUserEmail()]);
}

/** Run git in the publish root. Echo the output unless quiet; a failed exit throws unless allowed. */
function stateGit(args: string[], options: StateGitOptions = {}): SpawnSyncReturns<string> {
  const child = runGitResult(args, {
    cwd: publishRoot() ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
  });
  if (!options.quiet && child.stdout) process.stdout.write(child.stdout);
  if (!options.quiet && child.stderr) process.stderr.write(child.stderr);
  if (child.status !== 0 && !options.allowFailure) {
    throw new Error(
      child.stderr.trim() || `git ${safeAction(args[0])} failed with status ${child.status}`,
    );
  }
  return child;
}

export function publishMainCommit(options: GitPublishOptions): PublishResult {
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? publishDefaultBranch();
  const stateRoot = publishRoot();
  const coordinator = stateRoot ? acquireStateWriterCoordinator(branch) : null;
  try {
    if (stateRoot) {
      stateGit(["fetch", "--no-tags", "--depth=1", remote, branch], {
        timeoutMs: GIT_PUSH_TIMEOUT_MS,
      });
      stateGit(["checkout", "--detach", "FETCH_HEAD"]);
      syncPublishPaths(options.paths);
    }
    configureGitUser();
    stagePaths(options.paths);
    if (!hasStagedChanges()) {
      console.log("No publish changes");
      refreshSourceAfterStatePublish(options.paths);
      return "unchanged";
    }
    stateGit(["commit", "-m", options.message]);
    coordinator?.assertActive();
    stateGit(["push", remote, `HEAD:${branch}`], { quiet: true, timeoutMs: GIT_PUSH_TIMEOUT_MS });
    restoreWorktree(options.restorePaths ?? []);
    refreshSourceAfterStatePublish(options.paths);
    return "committed";
  } finally {
    coordinator?.release();
  }
}

function stagePaths(paths: readonly string[]): void {
  const unique = uniqueNonEmpty(paths).map(normalizedPath);
  if (!unique.length) throw new Error("No paths were provided for publishing");
  stateGit(["add", "-A", "--", ...unique]);
}

function restoreWorktree(paths: readonly string[]): void {
  const unique = uniqueNonEmpty(paths).map(normalizedPath);
  if (unique.length) stateGit(["restore", "--worktree", "--", ...unique], { allowFailure: true });
}

function hasStagedChanges(): boolean {
  return (
    stateGit(["diff", "--cached", "--quiet"], { allowFailure: true, quiet: true }).status !== 0
  );
}

export function publishRoot(): string | undefined {
  const configured = process.env.CLAWSWEEPER_STATE_DIR?.trim();
  return configured ? resolve(configured) : undefined;
}

function syncPublishPaths(paths: readonly string[]): void {
  const stateRoot = publishRoot();
  if (!stateRoot) return;
  const sourceRoot = resolve(process.cwd());
  if (sourceRoot === stateRoot) return;
  for (const input of uniqueNonEmpty(paths)) {
    const path = normalizedPath(input);
    const source = containedPath(sourceRoot, path);
    const destination = containedPath(stateRoot, path);
    if (!existsSync(source)) {
      rmSync(destination, { force: true, recursive: true });
      continue;
    }
    if (isCommentRouterLedger(path) && existsSync(destination)) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        mergeCommentRouterLedgers(readFileSync(source, "utf8"), readFileSync(destination, "utf8")),
        "utf8",
      );
      continue;
    }
    if (isSweepStatus(path) && existsSync(destination)) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        mergeSweepStatusJson({
          path,
          baseText: null,
          localText: readFileSync(source, "utf8"),
          remoteText: readFileSync(destination, "utf8"),
        }),
        "utf8",
      );
      continue;
    }
    rmSync(destination, { force: true, recursive: true });
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}

export function refreshSourceAfterStatePublish(paths: readonly string[]): void {
  const stateRoot = publishRoot();
  if (!stateRoot) return;
  const sourceRoot = resolve(process.cwd());
  if (sourceRoot === stateRoot) return;
  for (const input of uniqueNonEmpty(paths)) {
    const path = normalizedPath(input);
    const source = containedPath(sourceRoot, path);
    const state = containedPath(stateRoot, path);
    rmSync(source, { force: true, recursive: true });
    if (!existsSync(state)) continue;
    mkdirSync(dirname(source), { recursive: true });
    cpSync(state, source, { recursive: true });
  }
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function publishDefaultBranch(): string {
  return process.env.CLAWSWEEPER_PUBLISH_BRANCH?.trim() || "state";
}

function normalizedPath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error(`Invalid publish path: ${value}`);
  }
  return path;
}

function containedPath(root: string, path: string): string {
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`Publish path escapes its root: ${path}`);
  }
  return candidate;
}

function isCommentRouterLedger(path: string): boolean {
  return path === "results/comment-router.json";
}

function isSweepStatus(path: string): boolean {
  return /^results\/sweep-status\/[^/]+\.json$/.test(path);
}

function safeAction(value: string | undefined): string {
  return /^[a-z-]+$/.test(value ?? "") ? value! : "command";
}
