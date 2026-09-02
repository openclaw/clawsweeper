import { spawnSync } from "node:child_process";
import { resolveCommand } from "./command.js";
import { parseGhJson, parseGhJsonLinesWithRetry, parseGhJsonWithRetry } from "./github-json.js";
import {
  GitHubRateLimitError,
  ghRetryKind,
  ghRetryWaitMs,
  summarizeGhArgs,
} from "./github-retry.js";
import type {
  GitHubDispatchOutcome,
  GitHubRetryOptions,
  MutationRunner,
} from "./clawsweeper-types.js";
import type { createGitHubRuntime } from "./clawsweeper-github-runtime.js";

interface CreateGitHubExecutionDependencies {
  ROOT: string;
  gitHubRuntime: ReturnType<typeof createGitHubRuntime>;
  labelAlreadyExistsError: (error: unknown) => boolean;
}

export function createGitHubExecution(dependencies: CreateGitHubExecutionDependencies) {
  const { ROOT, gitHubRuntime, labelAlreadyExistsError } = dependencies;
  const {
    GitHubRuntimeBudgetError,
    claimPublicReadFallback,
    ensureGitHubRetryFits,
    ensureGitHubRuntimeAvailable,
    gh,
    ghOnce,
    ghWithPreparedTimeout,
    githubCommandTimeoutMs,
    githubRateLimitError: runtimeGithubRateLimitError,
    githubRuntimeBudgetError,
    sleepBeforeGitHubRetry,
  } = gitHubRuntime;
  const githubRateLimitError =
    runtimeGithubRateLimitError ?? ((cause: unknown) => new GitHubRateLimitError(cause));
  function ghWithRetry(
    args: string[],
    attempts = configuredGitHubRetryAttempts(),
    options: GitHubRetryOptions = {},
  ): string {
    let activeEnv: NodeJS.ProcessEnv | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return (
          options.request?.(args, attempt) ??
          (activeEnv ? ghWithPreparedTimeout(args, githubCommandTimeoutMs(), activeEnv) : gh(args))
        );
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        lastError = error;
        const retryKind = ghRetryKind(error);
        // Preserve the exhausted credential observation even when the current
        // public read can finish through the bounded App-token fallback. That
        // fallback is deliberately one-shot; later batch members must collapse
        // instead of probing the same exhausted credential again.
        const rateLimitError =
          retryKind === "throttle" ? githubRateLimitError(error, args, activeEnv ?? {}) : null;
        const fallback =
          retryKind === "throttle" && !options.request ? claimPublicReadFallback(args) : null;
        if (retryKind === "throttle" && fallback) {
          activeEnv = fallback;
          try {
            return ghWithPreparedTimeout(args, githubCommandTimeoutMs(), fallback);
          } catch (fallbackError) {
            if (fallbackError instanceof GitHubRuntimeBudgetError) throw fallbackError;
            lastError = fallbackError;
            const fallbackRetryKind = ghRetryKind(fallbackError);
            if (fallbackRetryKind === "throttle") {
              throw githubRateLimitError(fallbackError, args, fallback);
            }
            ensureGitHubRuntimeAvailable("after GitHub operation");
            if (fallbackRetryKind === "none" || attempt === attempts - 1) {
              throw fallbackError;
            }
            const waitMs = ghRetryWaitMs(fallbackRetryKind, attempt);
            ensureGitHubRetryFits(waitMs);
            console.error(
              `Transient GitHub API failure; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
            );
            if (options.sleepBeforeRetry) options.sleepBeforeRetry(waitMs);
            else sleepBeforeGitHubRetry(waitMs);
            continue;
          }
        }
        if (rateLimitError) throw rateLimitError;
        ensureGitHubRuntimeAvailable("after GitHub operation");
        if (retryKind === "none" || attempt === attempts - 1) throw error;
        const waitMs = ghRetryWaitMs(retryKind, attempt);
        ensureGitHubRetryFits(waitMs);
        console.error(
          `Transient GitHub API failure; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
        );
        if (options.sleepBeforeRetry) options.sleepBeforeRetry(waitMs);
        else sleepBeforeGitHubRetry(waitMs);
      }
    }
    throw lastError;
  }

  class ApplyMutationReviewGuardError extends Error {
    constructor(reason: string) {
      super(reason);
      this.name = "ApplyMutationReviewGuardError";
    }
  }

  let activeApplyMutationRunner: MutationRunner | null = null;

  let activeReviewMutationRunner: MutationRunner | null = null;

  function mutationErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function runObservedApplyMutation<T>(options: {
    identity: string;
    idempotencyIdentity?: string | undefined;
    operation: () => T;
    onMutation?: (() => void) | undefined;
    didMutate?: ((result: T) => boolean) | undefined;
    knownNoMutation?: ((error: unknown) => boolean) | undefined;
  }): T {
    const runner = activeApplyMutationRunner ?? activeReviewMutationRunner;
    if (runner) {
      return runner({
        identity: options.identity,
        idempotencyIdentity: options.idempotencyIdentity ?? options.identity,
        operation: options.operation,
        ...(options.didMutate ? { didMutate: options.didMutate } : {}),
        ...(options.knownNoMutation ? { knownNoMutation: options.knownNoMutation } : {}),
      });
    }
    const result = options.operation();
    if (options.didMutate?.(result) ?? true) options.onMutation?.();
    return result;
  }

  function ghObservedMutationCommand(options: {
    identity: string;
    args: string[];
    attempts?: number | undefined;
    onMutation?: (() => void) | undefined;
    didMutate?: ((result: string) => boolean) | undefined;
    knownNoMutation?: ((error: unknown) => boolean) | undefined;
    request?: ((args: string[], attempt: number) => string) | undefined;
    prepareRequest?: ((args: string[], attempt: number) => () => string) | undefined;
    sleepBeforeRetry?: ((waitMs: number) => void) | undefined;
  }): string {
    return ghWithRetry(options.args, options.attempts ?? configuredGitHubRetryAttempts(), {
      request: (args, attempt) => {
        let operation: () => string;
        if (options.prepareRequest) {
          operation = options.prepareRequest(args, attempt);
        } else if (options.request) {
          const request = options.request;
          operation = () => request(args, attempt);
        } else {
          const timeoutMs = githubCommandTimeoutMs();
          operation = () => ghWithPreparedTimeout(args, timeoutMs);
        }
        return runObservedApplyMutation({
          identity: `${options.identity}:request_attempt:${attempt + 1}`,
          idempotencyIdentity: options.identity,
          operation,
          ...(options.onMutation ? { onMutation: options.onMutation } : {}),
          ...(options.didMutate ? { didMutate: options.didMutate } : {}),
          ...(options.knownNoMutation ? { knownNoMutation: options.knownNoMutation } : {}),
        });
      },
      ...(options.sleepBeforeRetry ? { sleepBeforeRetry: options.sleepBeforeRetry } : {}),
    });
  }

  function observedGitHubMutationAttemptsForTest(
    outcomes: readonly ("not_started" | "transient" | "throttle" | "accepted" | "already_exists")[],
  ): Array<{
    identity: string;
    idempotencyIdentity: string;
    outcome: "accepted" | "rejected" | "unknown";
  }> {
    const receipts: Array<{
      identity: string;
      idempotencyIdentity: string;
      outcome: "accepted" | "rejected" | "unknown";
    }> = [];
    const previousRunner = activeApplyMutationRunner;
    activeApplyMutationRunner = <T>(options: {
      identity: string;
      idempotencyIdentity: string;
      operation: () => T;
      didMutate?: ((result: T) => boolean) | undefined;
      knownNoMutation?: ((error: unknown) => boolean) | undefined;
    }): T => {
      try {
        const result = options.operation();
        receipts.push({
          identity: options.identity,
          idempotencyIdentity: options.idempotencyIdentity,
          outcome: options.didMutate?.(result) === false ? "rejected" : "accepted",
        });
        return result;
      } catch (error) {
        receipts.push({
          identity: options.identity,
          idempotencyIdentity: options.idempotencyIdentity,
          outcome: options.knownNoMutation?.(error) === true ? "rejected" : "unknown",
        });
        throw error;
      }
    };
    try {
      ghObservedMutationCommand({
        identity: "test_mutation",
        args: ["api", "test"],
        attempts: outcomes.length,
        knownNoMutation: labelAlreadyExistsError,
        prepareRequest: (_args, attempt) => {
          const outcome = outcomes[attempt];
          if (outcome === "not_started") {
            throw new GitHubRuntimeBudgetError("max runtime reached before GitHub operation");
          }
          return () => {
            if (outcome === "accepted") return "ok";
            if (outcome === "already_exists") throw new Error("label already exists");
            if (outcome === "throttle") throw new Error("HTTP 403: API rate limit exceeded");
            throw new Error("HTTP 502: transient upstream failure");
          };
        },
        sleepBeforeRetry: () => {},
      });
    } catch {
      // The receipts are the assertion surface for rejected terminal attempts.
    } finally {
      activeApplyMutationRunner = previousRunner;
    }
    return receipts;
  }

  class GitHubDispatchError extends Error {
    readonly outcome: Exclude<GitHubDispatchOutcome, "accepted">;
    readonly cause: unknown;

    constructor(outcome: Exclude<GitHubDispatchOutcome, "accepted">, cause: unknown) {
      super(cause instanceof Error ? cause.message : String(cause));
      this.name = "GitHubDispatchError";
      this.outcome = outcome;
      this.cause = cause;
    }
  }

  function classifyGitHubDispatchResult(options: {
    status: number | null;
    signal?: NodeJS.Signals | null | undefined;
    errorCode?: string | undefined;
    stderr?: string | undefined;
  }): GitHubDispatchOutcome {
    if (options.signal) return "ambiguous_transport";
    if (options.errorCode) {
      return options.errorCode === "ETIMEDOUT" || options.errorCode === "ENOBUFS"
        ? "ambiguous_transport"
        : "definitely_not_dispatched";
    }
    if (options.status === 0) return "accepted";
    if (options.status === null) return "ambiguous_transport";
    const error = new Error(options.stderr?.trim() || `GitHub dispatch exited ${options.status}`);
    return ghRetryKind(error) === "none" ? "definitely_not_dispatched" : "ambiguous_transport";
  }

  function classifyGitHubDispatchResultForTest(options: {
    status: number | null;
    signal?: NodeJS.Signals | null | undefined;
    errorCode?: string | undefined;
    stderr?: string | undefined;
  }): GitHubDispatchOutcome {
    return classifyGitHubDispatchResult(options);
  }

  function ghRawOnceWithCheckpoint(
    args: string[],
    onBeforeRun: () => void,
  ): { outcome: "accepted"; output: string } {
    const env = { ...process.env };
    const command = resolveCommand("gh", args, env);
    const timeoutMs = githubCommandTimeoutMs();
    try {
      onBeforeRun();
    } catch (error) {
      throw new GitHubDispatchError("definitely_not_dispatched", error);
    }
    const result = spawnSync(command.command, command.args, {
      cwd: ROOT,
      encoding: "utf8",
      env,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    if (result.error) {
      const errorCode = (result.error as NodeJS.ErrnoException).code;
      if (timeoutMs !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        throw new GitHubDispatchError(
          "ambiguous_transport",
          githubRuntimeBudgetError("during GitHub dispatch"),
        );
      }
      throw new GitHubDispatchError(
        classifyGitHubDispatchResult({
          status: result.status,
          signal: result.signal,
          ...(errorCode ? { errorCode } : {}),
        }) as Exclude<GitHubDispatchOutcome, "accepted">,
        result.error,
      );
    }
    if (result.status !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
      const error = new Error(
        [`Command failed: gh ${args.join(" ")}`, stderr].filter(Boolean).join("\n"),
      );
      throw new GitHubDispatchError(
        classifyGitHubDispatchResult({
          status: result.status,
          signal: result.signal,
          stderr,
        }) as Exclude<GitHubDispatchOutcome, "accepted">,
        error,
      );
    }
    return { outcome: "accepted", output: (result.stdout ?? "").trim() };
  }

  function ghJson<T>(args: string[]): T {
    return parseGhJsonWithRetry<T>(() => ghWithRetry(args), args, {
      onRetry: (_error, attempt) => {
        const waitMs = ghRetryWaitMs("transient", attempt - 1);
        console.error(
          `Malformed GitHub JSON response; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
        );
        sleepBeforeGitHubRetry(waitMs);
      },
    });
  }

  function ghJsonOnce<T>(args: string[], timeoutMs: number): T {
    return parseGhJson<T>(ghOnce(args, timeoutMs), args);
  }

  function ghJsonLines<T>(args: string[]): T[] {
    return parseGhJsonLinesWithRetry<T>(() => ghWithRetry(args), args, {
      onRetry: (_error, attempt) => {
        const waitMs = ghRetryWaitMs("transient", attempt - 1);
        console.error(
          `Malformed GitHub JSON-lines response; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
        );
        sleepBeforeGitHubRetry(waitMs);
      },
    });
  }

  return {
    ApplyMutationReviewGuardError,
    GitHubDispatchError,
    classifyGitHubDispatchResultForTest,
    ghJson,
    ghJsonLines,
    ghJsonOnce,
    ghObservedMutationCommand,
    ghRawOnceWithCheckpoint,
    ghWithRetry,
    mutationErrorMessage,
    observedGitHubMutationAttemptsForTest,
    get activeApplyMutationRunner() {
      return activeApplyMutationRunner;
    },
    set activeApplyMutationRunner(value: MutationRunner | null) {
      activeApplyMutationRunner = value;
    },
    get activeReviewMutationRunner() {
      return activeReviewMutationRunner;
    },
    set activeReviewMutationRunner(value: MutationRunner | null) {
      activeReviewMutationRunner = value;
    },
  };
}

function configuredGitHubRetryAttempts(): number {
  const configured = process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
  if (configured === undefined || configured.trim() === "") return 12;
  const attempts = Number(configured);
  return Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 12;
}
