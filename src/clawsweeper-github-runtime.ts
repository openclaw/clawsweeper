import { spawnSync } from "node:child_process";
import type { GitHubRuntimeBudget } from "./clawsweeper-types.js";
import { codexEnv } from "./codex-env.js";
import { resolveCommand } from "./command.js";
import { exactPublicationPublicReadToken } from "./github-public-read.js";

interface CreateGitHubRuntimeDependencies {
  ROOT: string;
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number | undefined },
  ) => string;
  targetRepo: () => string;
}

export function createGitHubRuntime(dependencies: CreateGitHubRuntimeDependencies) {
  const { ROOT, run, targetRepo } = dependencies;

  const GITHUB_RUNTIME_REPORT_FLUSH_RESERVE_MS = 1_000;

  class GitHubRuntimeBudgetError extends Error {
    constructor(readonly reason: string) {
      super(reason);
      this.name = "GitHubRuntimeBudgetError";
    }
  }

  let activeGitHubRuntimeBudget: GitHubRuntimeBudget | null = null;

  function withGitHubRuntimeBudget<T>(runtimeBudget: GitHubRuntimeBudget, operation: () => T): T {
    const previousRuntimeBudget = activeGitHubRuntimeBudget;
    activeGitHubRuntimeBudget = runtimeBudget;
    try {
      return operation();
    } finally {
      activeGitHubRuntimeBudget = previousRuntimeBudget;
    }
  }

  function githubRuntimeRemainingMs(nowMs = Date.now()): number | null {
    const budget = activeGitHubRuntimeBudget;
    if (!budget || budget.maxRuntimeMs <= 0) return null;
    return (
      budget.maxRuntimeMs - (nowMs - budget.startedAtMs) - GITHUB_RUNTIME_REPORT_FLUSH_RESERVE_MS
    );
  }

  function githubRuntimeBudgetError(phase: string): GitHubRuntimeBudgetError {
    const budget = activeGitHubRuntimeBudget;
    const reason =
      budget?.yieldReason ??
      budget?.limitReason ??
      `max runtime ${budget?.maxRuntimeMs ?? 0}ms reached ${phase}`;
    if (budget) budget.yieldReason = reason;
    return new GitHubRuntimeBudgetError(reason);
  }

  function pendingGitHubRuntimeBudgetError(): GitHubRuntimeBudgetError | null {
    const reason = activeGitHubRuntimeBudget?.yieldReason;
    return reason ? new GitHubRuntimeBudgetError(reason) : null;
  }

  function githubCommandTimeoutMs(requestedTimeoutMs?: number): number | undefined {
    const pendingError = pendingGitHubRuntimeBudgetError();
    if (pendingError) throw pendingError;
    const remainingMs = githubRuntimeRemainingMs();
    if (remainingMs === null) return requestedTimeoutMs;
    if (remainingMs <= 0) throw githubRuntimeBudgetError("before GitHub operation");
    return Math.max(
      1,
      requestedTimeoutMs === undefined ? remainingMs : Math.min(requestedTimeoutMs, remainingMs),
    );
  }

  function ensureGitHubRuntimeAvailable(phase: string): void {
    const pendingError = pendingGitHubRuntimeBudgetError();
    if (pendingError) throw pendingError;
    const remainingMs = githubRuntimeRemainingMs();
    if (remainingMs !== null && remainingMs <= 0) throw githubRuntimeBudgetError(phase);
  }

  function ensureRuntimeDelayFits(waitMs: number, phase: string): void {
    const pendingError = pendingGitHubRuntimeBudgetError();
    if (pendingError) throw pendingError;
    const remainingMs = githubRuntimeRemainingMs();
    if (remainingMs !== null && remainingMs <= waitMs) {
      throw githubRuntimeBudgetError(phase);
    }
  }

  function ensureGitHubRetryFits(waitMs: number): void {
    ensureRuntimeDelayFits(waitMs, "before GitHub retry");
  }

  function sleepBeforeGitHubRetry(waitMs: number): void {
    ensureGitHubRetryFits(waitMs);
    sleepMs(waitMs);
  }

  function ghWithPreparedTimeout(args: string[], timeoutMs: number | undefined): string {
    const resolvedArgs = args[0] === "api" ? args : ["--repo", targetRepo(), ...args];
    const publicReadToken = exactPublicationPublicReadToken(resolvedArgs, targetRepo());
    return run("gh", resolvedArgs, {
      timeoutMs,
      ...(publicReadToken ? { env: { GH_TOKEN: publicReadToken } } : {}),
    });
  }

  function gh(args: string[]): string {
    return ghWithPreparedTimeout(args, githubCommandTimeoutMs());
  }

  function ghOnce(args: string[], timeoutMs: number): string {
    const resolvedArgs = args[0] === "api" ? args : ["--repo", targetRepo(), ...args];
    const publicReadToken = exactPublicationPublicReadToken(resolvedArgs, targetRepo());
    const env = {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      ...(publicReadToken ? { GH_TOKEN: publicReadToken } : {}),
    };
    const command = resolveCommand("gh", resolvedArgs, env);
    const commandTimeoutMs = githubCommandTimeoutMs(timeoutMs) ?? timeoutMs;
    const runtimeLimitedTimeout = commandTimeoutMs < timeoutMs;
    const result = spawnSync(command.command, command.args, {
      cwd: ROOT,
      encoding: "utf8",
      env,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: commandTimeoutMs,
    });
    if (result.error) {
      if (runtimeLimitedTimeout && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        throw githubRuntimeBudgetError("during GitHub operation");
      }
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
      throw new Error(
        [`Command failed: gh ${resolvedArgs.join(" ")}`, stderr].filter(Boolean).join("\n"),
      );
    }
    return (result.stdout ?? "").trim();
  }

  function sleepMs(milliseconds: number): void {
    if (milliseconds <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }

  function untrustedCodexEnv(
    options: {
      ghToken?: string | undefined;
      preserveCodexAuth?: boolean | undefined;
    } = {},
  ): NodeJS.ProcessEnv {
    const env = codexEnv(options);
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAWSWEEPER_ACTION_LEDGER_")) delete env[key];
    }
    return env;
  }

  function untrustedCodexEnvForTest(
    env: NodeJS.ProcessEnv,
    options: {
      ghToken?: string | undefined;
      preserveCodexAuth?: boolean | undefined;
    } = {},
  ): NodeJS.ProcessEnv {
    const previousEnv = process.env;
    try {
      process.env = { ...env };
      return untrustedCodexEnv(options);
    } finally {
      process.env = previousEnv;
    }
  }

  return {
    GitHubRuntimeBudgetError,
    ensureGitHubRetryFits,
    ensureGitHubRuntimeAvailable,
    ensureRuntimeDelayFits,
    gh,
    ghOnce,
    ghWithPreparedTimeout,
    githubCommandTimeoutMs,
    githubRuntimeBudgetError,
    sleepBeforeGitHubRetry,
    sleepMs,
    untrustedCodexEnv,
    untrustedCodexEnvForTest,
    withGitHubRuntimeBudget,
  };
}
