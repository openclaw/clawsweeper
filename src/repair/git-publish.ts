import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { mergeCommentRouterLedgers } from "./comment-router-ledger-merge.js";
import { clawsweeperGitUserEmail, clawsweeperGitUserName } from "./process-env.js";
import { mergeSweepStatusJson } from "./sweep-status-merge.js";
import { acquireStateWriterCoordinator } from "./state-writer-coordinator.js";

type GitRunResult = {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type GitRunOptions = {
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  maxBuffer?: number;
  quiet?: boolean;
  timeout?: number;
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

class GitCommandTimeoutError extends Error {
  constructor(args: readonly string[], timeoutMs: number) {
    super(`git ${safeAction(args[0])} timed out after ${timeoutMs}ms`);
    this.name = "GitCommandTimeoutError";
  }
}

function configureGitUser(): void {
  runGit(["config", "user.name", clawsweeperGitUserName()]);
  runGit(["config", "user.email", clawsweeperGitUserEmail()]);
}

export function runGit(args: readonly string[], options: GitRunOptions = {}): string {
  const result = spawnGit(args, options);
  if (result.timedOut) throw new GitCommandTimeoutError(args, options.timeout ?? GIT_TIMEOUT_MS);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      result.stderr.trim() || `git ${safeAction(args[0])} failed with status ${result.status}`,
    );
  }
  return result.stdout;
}

function spawnGit(args: readonly string[], options: GitRunOptions = {}): GitRunResult {
  const child = spawnSync("git", [...args], {
    cwd: publishRoot() ?? process.cwd(),
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  const stdout = child.stdout ?? "";
  const stderr = redactGitOutput(child.stderr ?? "", args);
  if (!options.quiet && stdout) process.stdout.write(stdout);
  if (!options.quiet && stderr) process.stderr.write(stderr);
  return {
    status: child.status ?? 1,
    stdout: child.status === 0 ? stdout : redactGitOutput(stdout, args),
    stderr,
    timedOut: (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

export function publishMainCommit(options: GitPublishOptions): PublishResult {
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? publishDefaultBranch();
  const stateRoot = publishRoot();
  const coordinator = stateRoot ? acquireStateWriterCoordinator(branch) : null;
  try {
    if (stateRoot) {
      runGit(["fetch", "--no-tags", "--depth=1", remote, branch], { timeout: GIT_PUSH_TIMEOUT_MS });
      runGit(["checkout", "--detach", "FETCH_HEAD"]);
      syncPublishPaths(options.paths);
    }
    configureGitUser();
    stagePaths(options.paths);
    if (!hasStagedChanges()) {
      console.log("No publish changes");
      refreshSourceAfterStatePublish(options.paths);
      return "unchanged";
    }
    runGit(["commit", "-m", options.message]);
    coordinator?.assertActive();
    const push = spawnGit(["push", remote, `HEAD:${branch}`], {
      quiet: true,
      timeout: GIT_PUSH_TIMEOUT_MS,
    });
    if (push.timedOut) {
      throw new GitCommandTimeoutError(["push"], GIT_PUSH_TIMEOUT_MS);
    }
    if (push.status !== 0) {
      throw new Error(push.stderr.trim() || `git push failed with status ${push.status}`);
    }
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
  runGit(["add", "-A", "--", ...unique]);
}

function restoreWorktree(paths: readonly string[]): void {
  const unique = uniqueNonEmpty(paths).map(normalizedPath);
  if (unique.length) runGit(["restore", "--worktree", "--", ...unique], { allowFailure: true });
}

function hasStagedChanges(): boolean {
  return spawnGit(["diff", "--cached", "--quiet"], { quiet: true }).status !== 0;
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

function redactGitOutput(value: string, args: readonly string[]): string {
  let redacted = value;
  for (const argument of args) {
    const match = /^https:\/\/x-access-token:([^@]+)@/.exec(argument);
    if (match?.[1]) redacted = redacted.split(match[1]).join("<redacted>");
  }
  return redacted;
}
