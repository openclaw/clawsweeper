import { spawnSync } from "node:child_process";
import { resolveCommand } from "./command.js";
import { parseGhJson, parseGhJsonLinesWithRetry, parseGhJsonWithRetry } from "./github-json.js";
import { ghRetryKind, ghRetryWaitMs, summarizeGhArgs } from "./github-retry.js";
import type {
  GitHubDispatchOutcome,
  GitHubRetryOptions,
  MutationRunner,
} from "./clawsweeper-types.js";
import type { createGitHubRuntime } from "./clawsweeper-github-runtime.js";
import type { createSweepStatus } from "./clawsweeper-sweep-status.js";

interface CreateGitHubExecutionDependencies {
  ROOT: string;
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number | undefined },
  ) => string;
  gitHubRuntime: ReturnType<typeof createGitHubRuntime>;
  sweepStatus: ReturnType<typeof createSweepStatus>;
  labelAlreadyExistsError: (error: unknown) => boolean;
}

export function createGitHubExecution(dependencies: CreateGitHubExecutionDependencies) {
  const { ROOT, run, gitHubRuntime, sweepStatus, labelAlreadyExistsError } = dependencies;
  const {
    GitHubRuntimeBudgetError,
    ensureGitHubRetryFits,
    ensureGitHubRuntimeAvailable,
    gh,
    ghOnce,
    ghWithPreparedTimeout,
    githubCommandTimeoutMs,
    githubRuntimeBudgetError,
    sleepBeforeGitHubRetry,
  } = gitHubRuntime;
  const { sweepStatusRelativePath, writeSweepStatus } = sweepStatus;

  let lastThrottleHeartbeatAt = 0;

  let throttleHeartbeatContext: (() => string) | null = null;

  function maybePublishThrottleHeartbeat(options: {
    args: string[];
    attempt: number;
    attempts: number;
    waitMs: number;
  }): void {
    if (process.env.CLAWSWEEPER_PUBLISH_THROTTLE_STATUS !== "true") return;
    const minWaitMs = Number(process.env.CLAWSWEEPER_THROTTLE_STATUS_MIN_WAIT_MS ?? 60_000);
    if (options.waitMs < minWaitMs) return;
    const minIntervalMs = Number(
      process.env.CLAWSWEEPER_THROTTLE_STATUS_MIN_INTERVAL_MS ?? 120_000,
    );
    const now = Date.now();
    if (now - lastThrottleHeartbeatAt < minIntervalMs) return;
    lastThrottleHeartbeatAt = now;

    try {
      const context = throttleHeartbeatContext?.();
      const checkpoint = process.env.CLAWSWEEPER_APPLY_CHECKPOINT;
      const checkpointText = checkpoint ? `Checkpoint ${checkpoint}. ` : "";
      const detail = [
        `${checkpointText}GitHub throttled while applying close decisions.`,
        context,
        `Last throttled command: \`${summarizeGhArgs(options.args)}\`.`,
        `Retry ${options.attempt + 1}/${Math.max(1, options.attempts - 1)} in ${Math.round(options.waitMs / 1000)}s.`,
      ]
        .filter(Boolean)
        .join(" ");
      const statusOptions: {
        state: string;
        detail: string;
        runUrl?: string;
      } = {
        state: "Apply throttled",
        detail,
      };
      if (process.env.CLAWSWEEPER_RUN_URL) {
        statusOptions.runUrl = process.env.CLAWSWEEPER_RUN_URL;
      }
      writeSweepStatus(statusOptions);
      run("git", ["add", sweepStatusRelativePath()]);
      const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT });
      if (diff.status === 0) return;
      run("git", ["commit", "-m", "chore: update sweep apply throttle status"]);
      try {
        run("git", ["push"], { timeoutMs: githubCommandTimeoutMs() });
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        console.error(
          `Best-effort throttle status push failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      console.error(
        `Best-effort throttle status update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function ghWithRetry(args: string[], attempts = 12, options: GitHubRetryOptions = {}): string {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return options.request?.(args, attempt) ?? gh(args);
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        lastError = error;
        ensureGitHubRuntimeAvailable("after GitHub operation");
        const retryKind = ghRetryKind(error);
        if (retryKind === "none" || attempt === attempts - 1) throw error;
        const waitMs = ghRetryWaitMs(retryKind, attempt);
        ensureGitHubRetryFits(waitMs);
        const retryLabel =
          retryKind === "throttle" ? "GitHub throttled" : "Transient GitHub API failure";
        console.error(
          `${retryLabel}; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
        );
        if (retryKind === "throttle") {
          maybePublishThrottleHeartbeat({ args, attempt, attempts, waitMs });
        }
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
    return ghWithRetry(options.args, options.attempts ?? 12, {
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
    outcomes: readonly ("not_started" | "transient" | "accepted" | "already_exists")[],
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
    get throttleHeartbeatContext() {
      return throttleHeartbeatContext;
    },
    set throttleHeartbeatContext(value: (() => string) | null) {
      throttleHeartbeatContext = value;
    },
  };
}
