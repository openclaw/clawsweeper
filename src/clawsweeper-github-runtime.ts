import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import type { GitHubRuntimeBudget } from "./clawsweeper-types.js";
import { codexEnv } from "./codex-env.js";
import { resolveCommand } from "./command.js";
import {
  exactPublicationPublicReadToken,
  isPublicOpenClawReadOnlyRequest,
} from "./github-public-read.js";
import { GitHubRateLimitError, ghRetryKind, type GitHubCredentialScope } from "./github-retry.js";

interface CreateGitHubRuntimeDependencies {
  ROOT: string;
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number | undefined },
  ) => string;
  targetRepo: () => string;
}

const claimedPublicReadFallbackTokens = new Set<string>();
const RATE_LIMIT_LOOKUP_TIMEOUT_MS = 20_000;

export function createGitHubRuntime(dependencies: CreateGitHubRuntimeDependencies) {
  const { ROOT, run, targetRepo } = dependencies;
  const inspectedRateLimitScopes = new Set<GitHubCredentialScope>();

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

  function publicReadToken(
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
  ): string | null {
    const publicToken = process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN?.trim();
    const env = { ...process.env, ...overrides };
    if (
      !publicToken ||
      Object.hasOwn(overrides, "GH_TOKEN") ||
      Object.hasOwn(overrides, "GITHUB_TOKEN") ||
      (env.GH_HOST && env.GH_HOST.toLowerCase() !== "github.com") ||
      !isPublicOpenClawReadOnlyRequest(args)
    ) {
      return null;
    }
    return publicToken;
  }

  function preparedGitHubEnv(
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
  ): NodeJS.ProcessEnv | undefined {
    const hasExplicitToken =
      Object.hasOwn(overrides, "GH_TOKEN") || Object.hasOwn(overrides, "GITHUB_TOKEN");
    const token =
      publicReadToken(args, overrides) ??
      (hasExplicitToken
        ? null
        : exactPublicationPublicReadToken(args, targetRepo(), {
            ...process.env,
            ...overrides,
          }));
    const selected = token ? { ...overrides, GH_TOKEN: token } : overrides;
    const telemetryEnv = githubEgressEnvironment(
      args,
      selected,
      token ? "public_read_fallback" : undefined,
    );
    if (token) return { ...selected, ...telemetryEnv };
    return Object.keys(selected).length > 0 || telemetryEnv
      ? { ...selected, ...telemetryEnv }
      : undefined;
  }

  function githubEgressEnvironment(
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
    selectedPoolClass?: "public_read_fallback",
  ): NodeJS.ProcessEnv | undefined {
    if (!process.env.CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH?.trim()) return undefined;
    const scope = githubRequestScope(args, overrides);
    return {
      CLAWSWEEPER_GITHUB_POOL_CLASS:
        selectedPoolClass ?? (scope === "repository_actions" ? "repository_actions" : "target_app"),
      CLAWSWEEPER_GITHUB_STAGE:
        process.env.CLAWSWEEPER_GITHUB_STAGE ||
        (process.env.EXACT_EVENT_PUBLICATION === "true"
          ? "publication_apply"
          : "publication_recovery"),
      CLAWSWEEPER_GITHUB_SOURCE_ACTION: process.env.CLAWSWEEPER_GITHUB_SOURCE_ACTION || "",
      CLAWSWEEPER_GITHUB_CLAIM_GENERATION:
        process.env.CLAWSWEEPER_GITHUB_CLAIM_GENERATION ||
        process.env.EXACT_REVIEW_BATCH_CLAIM_GENERATION ||
        process.env.EXACT_REVIEW_CLAIM_GENERATION ||
        "",
      CLAWSWEEPER_GITHUB_REQUEST_REPEAT: process.env.CLAWSWEEPER_GITHUB_REQUEST_REPEAT || "",
    };
  }

  function githubRequestScope(
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
  ): GitHubCredentialScope {
    const publicToken =
      publicReadToken(args, overrides) ??
      exactPublicationPublicReadToken(args, targetRepo(), {
        ...process.env,
        ...overrides,
      });
    const selectedToken =
      overrides.GH_TOKEN?.trim() ||
      overrides.GITHUB_TOKEN?.trim() ||
      publicToken ||
      process.env.GH_TOKEN?.trim() ||
      process.env.GITHUB_TOKEN?.trim() ||
      "";
    const repositoryTokens = [
      process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN?.trim(),
      process.env.REPO_TOKEN?.trim(),
      process.env.GITHUB_TOKEN?.trim(),
    ].filter((token): token is string => Boolean(token));
    return repositoryTokens.includes(selectedToken) ? "repository_actions" : "target_app";
  }

  function rateLimitObservationPath(): string | null {
    return process.env.CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH?.trim() || null;
  }

  function githubRequestMetricsPath(): string | null {
    return process.env.CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH?.trim() || null;
  }

  function appendJsonLine(path: string | null, value: Record<string, unknown>): void {
    if (!path) return;
    appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
  }

  function githubEndpointCategory(args: readonly string[]): string {
    const text = args.join(" ").toLowerCase();
    if (/\brate_limit\b/.test(text)) return "rate_status";
    if (/\brun download\b/.test(text)) return "artifact_download";
    if (/\/comments(?:\?|\s|$)/.test(text)) return "comments";
    if (/\/labels(?:\?|\s|$)/.test(text)) return "labels";
    if (/\/reviews(?:\?|\s|$)/.test(text)) return "reviews";
    if (/\bworkflow run\b/.test(text)) return "workflow_dispatch";
    if (/\/issues\/\d+|\/pulls\/\d+/.test(text)) return "item_metadata";
    return "other";
  }

  function recordGitHubRequest(
    args: readonly string[],
    scope: GitHubCredentialScope,
    outcome: "success" | "throttle" | "transient" | "error",
  ): void {
    appendJsonLine(githubRequestMetricsPath(), {
      scope,
      category: githubEndpointCategory(args),
      mode: isPublicOpenClawReadOnlyRequest(args) ? "read" : "mutation_or_private_read",
      outcome,
      repeat_revision: process.env.CLAWSWEEPER_GITHUB_REQUEST_REPEAT === "true",
      count: 1,
    });
  }

  function rateLimitStatusRetryAt(scope: GitHubCredentialScope, token: string): number | null {
    if (!rateLimitObservationPath() || inspectedRateLimitScopes.has(scope) || !token) return null;
    inspectedRateLimitScopes.add(scope);
    try {
      closeSync(openSync(`${rateLimitObservationPath()}.lookup-${scope}.lock`, "wx"));
    } catch {
      return null;
    }
    try {
      const raw = run(
        "gh",
        [
          "api",
          "rate_limit",
          "--jq",
          "{remaining:.resources.core.remaining,reset:.resources.core.reset}",
        ],
        {
          timeoutMs: RATE_LIMIT_LOOKUP_TIMEOUT_MS,
          env: {
            ...process.env,
            GH_TOKEN: token,
            ...githubEgressEnvironment(["api", "rate_limit"], { GH_TOKEN: token }),
          },
        },
      );
      recordGitHubRequest(["api", "rate_limit"], scope, "success");
      const status = JSON.parse(raw) as { remaining?: unknown; reset?: unknown };
      const remaining = Number(status.remaining);
      const reset = Number(status.reset);
      return remaining <= 0 && Number.isSafeInteger(reset) && reset > 0 ? reset * 1_000 : null;
    } catch (error) {
      const kind = ghRetryKind(error);
      recordGitHubRequest(
        ["api", "rate_limit"],
        scope,
        kind === "throttle" ? "throttle" : kind === "transient" ? "transient" : "error",
      );
      return null;
    }
  }

  function githubRateLimitError(
    cause: unknown,
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
  ): GitHubRateLimitError {
    const scope = githubRequestScope(args, overrides);
    const prepared = preparedGitHubEnv(args, overrides) ?? overrides;
    const token =
      prepared.GH_TOKEN?.trim() ||
      prepared.GITHUB_TOKEN?.trim() ||
      process.env.GH_TOKEN?.trim() ||
      process.env.GITHUB_TOKEN?.trim() ||
      "";
    const hinted = new GitHubRateLimitError(cause, Date.now(), { scope });
    const statusRetryAt = hinted.authoritative ? null : rateLimitStatusRetryAt(scope, token);
    const error = statusRetryAt
      ? new GitHubRateLimitError(cause, Date.now(), {
          scope,
          retryAt: statusRetryAt,
          provenance: "rate_limit_status",
          authoritative: true,
        })
      : hinted;
    appendJsonLine(rateLimitObservationPath(), {
      scope: error.scope,
      ...(error.scope === "target_app"
        ? { target_owner: targetRepo().split("/", 1)[0]?.toLowerCase() }
        : {}),
      observed_at: new Date().toISOString(),
      retry_at: error.retryAt,
      provenance: error.provenance,
      authoritative: error.authoritative,
    });
    recordGitHubRequest(args, scope, "throttle");
    return error;
  }

  function claimPublicReadFallback(args: readonly string[]): NodeJS.ProcessEnv | null {
    const publicToken =
      publicReadToken(args) ?? exactPublicationPublicReadToken(args, targetRepo(), process.env);
    const appToken = process.env.GH_TOKEN?.trim();
    if (
      !publicToken ||
      !appToken ||
      publicToken === appToken ||
      claimedPublicReadFallbackTokens.has(appToken)
    ) {
      return null;
    }
    const observationPath = rateLimitObservationPath();
    if (observationPath) {
      try {
        closeSync(openSync(`${observationPath}.fallback-target_app.lock`, "wx"));
      } catch {
        return null;
      }
    }
    claimedPublicReadFallbackTokens.add(appToken);
    return { GH_TOKEN: appToken };
  }

  function ghWithPreparedTimeout(
    args: string[],
    timeoutMs: number | undefined,
    env: NodeJS.ProcessEnv = {},
  ): string {
    const resolvedArgs = args[0] === "api" ? args : ["--repo", targetRepo(), ...args];
    const preparedEnv = preparedGitHubEnv(resolvedArgs, env);
    const scope = githubRequestScope(resolvedArgs, env);
    try {
      const result = run("gh", resolvedArgs, {
        timeoutMs,
        ...(preparedEnv ? { env: preparedEnv } : {}),
      });
      recordGitHubRequest(resolvedArgs, scope, "success");
      return result;
    } catch (error) {
      const retryKind = ghRetryKind(error);
      if (retryKind !== "throttle") {
        recordGitHubRequest(resolvedArgs, scope, retryKind === "transient" ? "transient" : "error");
      }
      throw error;
    }
  }

  function gh(args: string[]): string {
    return ghWithPreparedTimeout(args, githubCommandTimeoutMs());
  }

  function ghOnce(args: string[], timeoutMs: number): string {
    const resolvedArgs = args[0] === "api" ? args : ["--repo", targetRepo(), ...args];
    const env = {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      ...preparedGitHubEnv(resolvedArgs),
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
    claimPublicReadFallback,
    ensureGitHubRetryFits,
    ensureGitHubRuntimeAvailable,
    ensureRuntimeDelayFits,
    gh,
    ghOnce,
    ghWithPreparedTimeout,
    githubRateLimitError,
    githubCommandTimeoutMs,
    githubRuntimeBudgetError,
    sleepBeforeGitHubRetry,
    sleepMs,
    untrustedCodexEnv,
    untrustedCodexEnvForTest,
    withGitHubRuntimeBudget,
  };
}
