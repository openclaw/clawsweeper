import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveCommand } from "./command.js";
import { ROOT } from "./clawsweeper-repository-paths.js";
import { ghRetryKind, ghRetryWaitMs, summarizeGhArgs } from "./github-retry.js";
import { parseGhJson, parseGhJsonLinesWithRetry, parseGhJsonWithRetry } from "./github-json.js";
import type {
  GitHubDeadlineOptions,
  GitHubDispatchOutcome,
  GitHubFirstAttempt,
  GitHubJsonResult,
  GitHubRetryOptions,
  MutationRunner,
} from "./clawsweeper-types.js";
import {
  GitHubOperationDeadlineError,
  GitHubRuntimeBudgetError,
  claimPublicReadFallback,
  ensureGitHubRetryFits,
  ensureGitHubRuntimeAvailable,
  gh,
  ghFirstAttemptsConcurrently,
  ghOnce,
  ghWithPreparedTimeout,
  githubCommandTimeoutMs,
  githubRateLimitError,
  githubRuntimeBudgetError,
  sleepBeforeGitHubRetry,
} from "./clawsweeper-github-runtime.js";

const mutationReceiptScope = new AsyncLocalStorage<{ runner: MutationRunner | null }>();

/** The mutation receipt adapter is scoped separately from GitHub read/budget data. */
export function withMutationReceiptRunner<T>(runner: MutationRunner | null, operation: () => T): T {
  return mutationReceiptScope.run({ runner }, operation);
}

export function getMutationReceiptRunner(): MutationRunner | null {
  return mutationReceiptScope.getStore()?.runner ?? null;
}

export function setMutationReceiptRunner(runner: MutationRunner | null): void {
  const scope = mutationReceiptScope.getStore();
  if (!scope) throw new Error("Mutation receipts require withMutationReceiptRunner.");
  scope.runner = runner;
}

export function ghWithRetry(
  args: string[],
  attempts = configuredGitHubRetryAttempts(),
  options: GitHubRetryOptions = {},
): string {
  let activeEnv: NodeJS.ProcessEnv | undefined;
  let lastError: unknown;
  const deadlineAt = options.deadlineAt;
  const request = (onDispatch?: () => void) => {
    const result =
      activeEnv || deadlineAt !== undefined
        ? ghWithPreparedTimeout(
            args,
            githubCommandTimeoutMs(undefined, deadlineAt),
            activeEnv,
            deadlineAt,
            onDispatch,
          )
        : gh(args);
    if (deadlineAt !== undefined) {
      ensureGitHubRuntimeAvailable("after GitHub operation", deadlineAt);
    }
    return result;
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (deadlineAt !== undefined) {
        ensureGitHubRuntimeAvailable("before GitHub operation", deadlineAt);
      }
      let result: string;
      if (attempt === 0 && options.firstAttempt) {
        if ("error" in options.firstAttempt) throw options.firstAttempt.error;
        result = options.firstAttempt.output;
      } else {
        result = options.request?.(args, attempt) ?? request();
      }
      if (deadlineAt !== undefined) {
        ensureGitHubRuntimeAvailable("after GitHub operation", deadlineAt);
      }
      return result;
    } catch (error) {
      if (
        error instanceof GitHubRuntimeBudgetError ||
        error instanceof GitHubOperationDeadlineError
      ) {
        throw error;
      }
      lastError = error;
      const retryKind = ghRetryKind(error);
      // Preserve the exhausted credential observation even when the current
      // public read can finish through the bounded App-token fallback. That
      // fallback is deliberately one-shot; later batch members must collapse
      // instead of probing the same exhausted credential again.
      const rateLimitError =
        retryKind === "throttle"
          ? githubRateLimitError(error, args, activeEnv ?? {}, deadlineAt)
          : null;
      if (deadlineAt !== undefined) {
        ensureGitHubRuntimeAvailable("after GitHub operation", deadlineAt);
      }
      const fallback =
        retryKind === "throttle" && !options.request ? claimPublicReadFallback(args) : null;
      if (retryKind === "throttle" && fallback) {
        activeEnv = fallback.env;
        try {
          return request(fallback.onDispatch);
        } catch (fallbackError) {
          if (
            fallbackError instanceof GitHubRuntimeBudgetError ||
            fallbackError instanceof GitHubOperationDeadlineError
          ) {
            throw fallbackError;
          }
          lastError = fallbackError;
          const fallbackRetryKind = ghRetryKind(fallbackError);
          if (fallbackRetryKind === "throttle") {
            const limited = githubRateLimitError(fallbackError, args, fallback.env, deadlineAt);
            if (deadlineAt !== undefined) {
              ensureGitHubRuntimeAvailable("after GitHub operation", deadlineAt);
            }
            throw limited;
          }
          ensureGitHubRuntimeAvailable("after GitHub operation", deadlineAt);
          if (fallbackRetryKind === "none" || attempt === attempts - 1) {
            throw fallbackError;
          }
          const waitMs = ghRetryWaitMs(fallbackRetryKind, attempt);
          ensureGitHubRetryFits(waitMs, deadlineAt);
          console.error(
            `Transient GitHub API failure; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
          );
          if (options.sleepBeforeRetry) options.sleepBeforeRetry(waitMs);
          else sleepBeforeGitHubRetry(waitMs, deadlineAt);
          continue;
        } finally {
          if (!fallback.releaseIfUndispatched()) {
            console.error(
              "GitHub fallback reservation could not be released; one-shot claim retained.",
            );
          }
        }
      }
      if (rateLimitError) throw rateLimitError;
      ensureGitHubRuntimeAvailable("after GitHub operation", deadlineAt);
      if (retryKind === "none" || attempt === attempts - 1) throw error;
      const waitMs = ghRetryWaitMs(retryKind, attempt);
      ensureGitHubRetryFits(waitMs, deadlineAt);
      console.error(
        `Transient GitHub API failure; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
      );
      if (options.sleepBeforeRetry) options.sleepBeforeRetry(waitMs);
      else sleepBeforeGitHubRetry(waitMs, deadlineAt);
    }
  }
  throw lastError;
}

export class ApplyMutationReviewGuardError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ApplyMutationReviewGuardError";
  }
}

export function mutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ghObservedMutationCommand(options: {
  identity: string;
  args: string[];
  attempts?: number | undefined;
  onMutation?: (() => void) | undefined;
  didMutate?: ((result: string) => boolean) | undefined;
  knownNoMutation?: ((error: unknown) => boolean) | undefined;
}): string {
  return ghWithRetry(options.args, options.attempts ?? configuredGitHubRetryAttempts(), {
    request: (args, attempt) => {
      const timeoutMs = githubCommandTimeoutMs();
      const operation = () => ghWithPreparedTimeout(args, timeoutMs);
      const runner = getMutationReceiptRunner();
      if (runner) {
        return runner({
          identity: `${options.identity}:request_attempt:${attempt + 1}`,
          idempotencyIdentity: options.identity,
          operation,
          ...(options.didMutate ? { didMutate: options.didMutate } : {}),
          ...(options.knownNoMutation ? { knownNoMutation: options.knownNoMutation } : {}),
        });
      }
      const result = operation();
      if (options.didMutate?.(result) ?? true) options.onMutation?.();
      return result;
    },
  });
}

export class GitHubDispatchError extends Error {
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

export function ghRawOnceWithCheckpoint(
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

export function ghJson<T>(args: string[], options: GitHubDeadlineOptions = {}): T {
  return readJson<T>(args, options);
}

function readJson<T>(
  args: string[],
  options: GitHubDeadlineOptions,
  firstAttempt?: GitHubFirstAttempt | null,
): T {
  // A replayed first attempt belongs to the first load only; malformed-JSON
  // retries request fresh output.
  let pendingFirstAttempt = firstAttempt ?? undefined;
  const result = parseGhJsonWithRetry<T>(
    () => {
      const retryOptions = pendingFirstAttempt
        ? { ...options, firstAttempt: pendingFirstAttempt }
        : options;
      pendingFirstAttempt = undefined;
      return ghWithRetry(args, undefined, retryOptions);
    },
    args,
    {
      onRetry: (_error, attempt) => {
        const waitMs = ghRetryWaitMs("transient", attempt - 1);
        if (options.deadlineAt !== undefined) {
          ensureGitHubRetryFits(waitMs, options.deadlineAt);
        }
        console.error(
          `Malformed GitHub JSON response; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
        );
        sleepBeforeGitHubRetry(waitMs, options.deadlineAt);
      },
    },
  );
  if (options.deadlineAt !== undefined) {
    ensureGitHubRuntimeAvailable("after GitHub JSON response", options.deadlineAt);
  }
  return result;
}

/**
 * Independent `ghJson` reads whose first attempts run concurrently. Each
 * read then finishes through `ghJson`'s own retry, rate-limit fallback,
 * budget and malformed-JSON handling, in request order. One read failing
 * does not affect the others.
 */
export function ghJsonEach<T>(requests: readonly string[][]): GitHubJsonResult<T>[] {
  const firstAttempts =
    requests.length > 1 ? ghFirstAttemptsConcurrently(requests) : requests.map(() => null);
  return requests.map((args, index) => {
    try {
      return { ok: true, value: readJson<T>(args, {}, firstAttempts[index]) };
    } catch (error) {
      return { ok: false, error };
    }
  });
}

export function ghJsonOnce<T>(args: string[], timeoutMs: number): T {
  return parseGhJson<T>(ghOnce(args, timeoutMs), args);
}

export function ghJsonLines<T>(args: string[]): T[] {
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

function configuredGitHubRetryAttempts(): number {
  const configured = process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
  if (configured === undefined || configured.trim() === "") return 12;
  const attempts = Number(configured);
  return Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 12;
}
