import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, lstatSync, openSync, unlinkSync } from "node:fs";
import type {
  GitHubFallbackClaim,
  GitHubFirstAttempt,
  GitHubRequestReservation,
  GitHubRuntimeBudget,
} from "./clawsweeper-types.js";
import { codexEnv } from "./codex-env.js";
import {
  resolveCommand,
  runText,
  runTextConcurrently,
  SWEEPER_COMMAND_MAX_BUFFER_BYTES,
} from "./command.js";
import { ROOT } from "./clawsweeper-repository-paths.js";
import { targetRepo } from "./repository-profiles.js";
import {
  exactPublicationPublicReadToken,
  isPublicOpenClawReadOnlyRequest,
} from "./github-public-read.js";
import {
  GITHUB_ETAG_CREDENTIAL_POOLS,
  githubEtagCacheKey,
  githubEtagCacheRequestBody,
  type GithubEtagCredentialPool,
} from "./github-etag-cache-contract.js";
import {
  createRetainedGithubEtagResponses,
  durableGithubEtagReadSync,
  type GithubConditionalResponse,
  type GithubEtagRetainedResponses,
} from "./github-etag-read-broker.js";
import { recordGithubEgressBrokerEvent } from "./github-egress-observer.js";
import {
  activeGitHubRateLimitCircuit,
  GitHubRateLimitCircuitError,
} from "./github-rate-limit-circuit.js";
import {
  GitHubRateLimitError,
  githubCredentialScopeForToken,
  ghRetryKind,
  type GitHubCredentialScope,
} from "./github-retry.js";
import { asRecord as objectValue } from "./value-coerce.js";

type GitHubRunState = {
  inspectedRateLimitScopes: Set<GitHubCredentialScope>;
  retainedEtagResponses: GithubEtagRetainedResponses;
  claimedPublicReadFallbackTokens: Set<string>;
  budget: GitHubRuntimeBudget | null;
};

const gitHubRunStorage = new AsyncLocalStorage<GitHubRunState>();

function gitHubRunState(): GitHubRunState {
  const state = gitHubRunStorage.getStore();
  if (!state) throw new Error("GitHub operations require withGitHubRun.");
  return state;
}

/** Isolates command state, including work resumed after an asynchronous operation. */
export function withGitHubRun<T>(operation: () => T): T {
  return gitHubRunStorage.run(
    {
      inspectedRateLimitScopes: new Set(),
      retainedEtagResponses: createRetainedGithubEtagResponses(),
      claimedPublicReadFallbackTokens: new Set(),
      budget: null,
    },
    operation,
  );
}

/** Independent GitHub reads in flight together. */
export const GITHUB_CONCURRENT_READS = 8;

const RATE_LIMIT_LOOKUP_TIMEOUT_MS = 20_000;
const ETAG_BROKER_TIMEOUT_MS = 7_000;
const ETAG_BROKER_BUDGET_RESERVE_MS = 10_000;

export class GitHubOperationDeadlineError extends Error {
  constructor(readonly deadlineAt: number) {
    super("GitHub operation deadline exhausted.");
    this.name = "GitHubOperationDeadlineError";
  }
}

function reserveGitHubRequest<Key>(
  claims: Set<Key>,
  key: Key,
  lockPath?: string,
): GitHubRequestReservation | null {
  if (claims.has(key)) return null;
  let lock: { path: string; dev: number; ino: number } | undefined;
  if (lockPath) {
    try {
      const descriptor = openSync(lockPath, "wx");
      try {
        const identity = fstatSync(descriptor);
        lock = { path: lockPath, dev: identity.dev, ino: identity.ino };
      } finally {
        closeSync(descriptor);
      }
    } catch {
      return null;
    }
  }
  claims.add(key);
  // Admission can expire after the lock is acquired but before transport starts.
  let state: "reserved" | "dispatched" | "released" = "reserved";
  return {
    onDispatch: () => {
      if (state === "released") throw new Error("GitHub reservation was released before dispatch");
      state = "dispatched";
    },
    releaseIfUndispatched: () => {
      if (state !== "reserved") return true;
      if (lock) {
        try {
          const identity = lstatSync(lock.path);
          if (!identity.isFile() || identity.dev !== lock.dev || identity.ino !== lock.ino) {
            return false;
          }
          unlinkSync(lock.path);
        } catch {
          // Uncertain lock ownership must retain the process-local exclusion too.
          return false;
        }
      }
      claims.delete(key);
      state = "released";
      return true;
    },
  };
}

const GITHUB_RUNTIME_REPORT_FLUSH_RESERVE_MS = 1_000;

export class GitHubRuntimeBudgetError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "GitHubRuntimeBudgetError";
  }
}

/** Scopes the budget without splitting the command's retained responses or claims. */
export function withGitHubRuntimeBudget<T>(
  runtimeBudget: GitHubRuntimeBudget,
  operation: () => T,
): T {
  return gitHubRunStorage.run({ ...gitHubRunState(), budget: runtimeBudget }, operation);
}

function githubRuntimeRemainingMs(nowMs = Date.now()): number | null {
  const budget = gitHubRunState().budget;
  if (!budget || budget.maxRuntimeMs <= 0) return null;
  return (
    budget.maxRuntimeMs - (nowMs - budget.startedAtMs) - GITHUB_RUNTIME_REPORT_FLUSH_RESERVE_MS
  );
}

export function githubRuntimeBudgetError(phase: string): GitHubRuntimeBudgetError {
  const budget = gitHubRunState().budget;
  const reason =
    budget?.yieldReason ??
    budget?.limitReason ??
    `max runtime ${budget?.maxRuntimeMs ?? 0}ms reached ${phase}`;
  if (budget) budget.yieldReason = reason;
  return new GitHubRuntimeBudgetError(reason);
}

function pendingGitHubRuntimeBudgetError(): GitHubRuntimeBudgetError | null {
  const reason = gitHubRunState().budget?.yieldReason;
  return reason ? new GitHubRuntimeBudgetError(reason) : null;
}

function ensureOperationDelayFits(waitMs: number, deadlineAt?: number): void {
  if (deadlineAt !== undefined && deadlineAt - Date.now() <= waitMs) {
    throw new GitHubOperationDeadlineError(deadlineAt);
  }
}

export function githubCommandTimeoutMs(
  requestedTimeoutMs?: number,
  deadlineAt?: number,
): number | undefined {
  const pendingError = pendingGitHubRuntimeBudgetError();
  if (pendingError) throw pendingError;
  const remainingMs = githubRuntimeRemainingMs();
  if (remainingMs !== null && remainingMs <= 0) {
    throw githubRuntimeBudgetError("before GitHub operation");
  }
  let requested = requestedTimeoutMs;
  if (deadlineAt !== undefined) {
    const operationTimeoutMs = deadlineAt - Date.now();
    if (operationTimeoutMs <= 0) throw new GitHubOperationDeadlineError(deadlineAt);
    requested = Math.min(requestedTimeoutMs ?? operationTimeoutMs, operationTimeoutMs);
  }
  if (remainingMs === null) return requested;
  return Math.max(1, requested === undefined ? remainingMs : Math.min(requested, remainingMs));
}

export function ensureGitHubRuntimeAvailable(phase: string, deadlineAt?: number): void {
  const pendingError = pendingGitHubRuntimeBudgetError();
  if (pendingError) throw pendingError;
  const remainingMs = githubRuntimeRemainingMs();
  if (remainingMs !== null && remainingMs <= 0) throw githubRuntimeBudgetError(phase);
  ensureOperationDelayFits(0, deadlineAt);
}

export function ensureRuntimeDelayFits(waitMs: number, phase: string): void {
  const pendingError = pendingGitHubRuntimeBudgetError();
  if (pendingError) throw pendingError;
  const remainingMs = githubRuntimeRemainingMs();
  if (remainingMs !== null && remainingMs <= waitMs) {
    throw githubRuntimeBudgetError(phase);
  }
}

export function ensureGitHubRetryFits(waitMs: number, deadlineAt?: number): void {
  if (deadlineAt !== undefined) ensureGitHubRuntimeAvailable("before GitHub retry");
  ensureOperationDelayFits(waitMs, deadlineAt);
  ensureRuntimeDelayFits(waitMs, "before GitHub retry");
}

export function sleepBeforeGitHubRetry(waitMs: number, deadlineAt?: number): void {
  ensureGitHubRetryFits(waitMs, deadlineAt);
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
  return githubCredentialScopeForToken(selectedToken, process.env);
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
  outcome: "success" | "throttle" | "transient" | "error" | "skipped_by_circuit",
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

function rateLimitStatusRetryAt(
  scope: GitHubCredentialScope,
  token: string,
  deadlineAt?: number,
): number | null {
  const { inspectedRateLimitScopes } = gitHubRunState();
  if (!rateLimitObservationPath() || inspectedRateLimitScopes.has(scope) || !token) return null;
  if (deadlineAt !== undefined) {
    try {
      githubCommandTimeoutMs(RATE_LIMIT_LOOKUP_TIMEOUT_MS, deadlineAt);
    } catch (error) {
      if (
        error instanceof GitHubOperationDeadlineError ||
        error instanceof GitHubRuntimeBudgetError
      ) {
        return null;
      }
      throw error;
    }
  }
  const reservation = reserveGitHubRequest(
    inspectedRateLimitScopes,
    scope,
    `${rateLimitObservationPath()}.lookup-${scope}.lock`,
  );
  if (!reservation) return null;
  let requestStarted = false;
  try {
    const commandArgs = [
      "api",
      "rate_limit",
      "--jq",
      "{remaining:.resources.core.remaining,reset:.resources.core.reset}",
    ];
    const commandEnv = {
      ...process.env,
      GH_TOKEN: token,
      ...githubEgressEnvironment(["api", "rate_limit"], { GH_TOKEN: token }),
    };
    const timeoutMs =
      deadlineAt === undefined
        ? RATE_LIMIT_LOOKUP_TIMEOUT_MS
        : githubCommandTimeoutMs(RATE_LIMIT_LOOKUP_TIMEOUT_MS, deadlineAt);
    reservation.onDispatch();
    requestStarted = true;
    const raw = runText("gh", commandArgs, {
      cwd: ROOT,
      env: commandEnv,
      timeoutMs,
      maxBuffer: SWEEPER_COMMAND_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      trim: "both",
    });
    recordGitHubRequest(["api", "rate_limit"], scope, "success");
    const status = JSON.parse(raw) as { remaining?: unknown; reset?: unknown };
    const remaining = Number(status.remaining);
    const reset = Number(status.reset);
    return remaining <= 0 && Number.isSafeInteger(reset) && reset > 0 ? reset * 1_000 : null;
  } catch (error) {
    if (!requestStarted) return null;
    const kind = ghRetryKind(error);
    recordGitHubRequest(
      ["api", "rate_limit"],
      scope,
      kind === "throttle" ? "throttle" : kind === "transient" ? "transient" : "error",
    );
    return null;
  } finally {
    if (!reservation.releaseIfUndispatched()) {
      console.error(
        "GitHub rate-limit lookup reservation could not be released; one-shot claim retained.",
      );
    }
  }
}

export function githubRateLimitError(
  cause: unknown,
  args: readonly string[],
  overrides: NodeJS.ProcessEnv = {},
  deadlineAt?: number,
): GitHubRateLimitError {
  gitHubRunState();
  if (cause instanceof GitHubRateLimitCircuitError) return cause;
  const scope = githubRequestScope(args, overrides);
  const prepared = preparedGitHubEnv(args, overrides) ?? overrides;
  const token =
    prepared.GH_TOKEN?.trim() ||
    prepared.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    "";
  const hinted = new GitHubRateLimitError(cause, Date.now(), { scope });
  // Publish before a bounded reset lookup so sibling workers stop spending
  // this credential while the lookup is in flight.
  publishRateLimitObservation(hinted);
  recordGitHubRequest(args, scope, "throttle");
  const statusRetryAt = hinted.authoritative
    ? null
    : rateLimitStatusRetryAt(scope, token, deadlineAt);
  const error = statusRetryAt
    ? new GitHubRateLimitError(cause, Date.now(), {
        scope,
        retryAt: statusRetryAt,
        provenance: "rate_limit_status",
        authoritative: true,
      })
    : hinted;
  if (statusRetryAt) publishRateLimitObservation(error);
  return error;
}

function publishRateLimitObservation(error: GitHubRateLimitError): void {
  appendJsonLine(rateLimitObservationPath(), {
    scope: error.scope,
    ...(error.scope === "target_app"
      ? { target_owner: targetRepo().split("/", 1)[0]?.toLowerCase() }
      : {}),
    observed_at: new Date(Date.now()).toISOString(),
    retry_at: error.retryAt,
    provenance: error.provenance,
    authoritative: error.authoritative,
  });
}

export function claimPublicReadFallback(args: readonly string[]): GitHubFallbackClaim | null {
  const { claimedPublicReadFallbackTokens } = gitHubRunState();
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
  const reservation = reserveGitHubRequest(
    claimedPublicReadFallbackTokens,
    appToken,
    observationPath ? `${observationPath}.fallback-target_app.lock` : undefined,
  );
  return reservation ? { ...reservation, env: { GH_TOKEN: appToken } } : null;
}

export function ghWithPreparedTimeout(
  args: string[],
  timeoutMs: number | undefined,
  env: NodeJS.ProcessEnv = {},
  deadlineAt?: number,
  onDispatch?: () => void,
): string {
  gitHubRunState();
  const resolvedArgs = args[0] === "api" ? args : ["--repo", targetRepo(), ...args];
  const preparedEnv = preparedGitHubEnv(resolvedArgs, env);
  const scope = githubRequestScope(resolvedArgs, env);
  const observationPath = rateLimitObservationPath();
  if (
    process.env.EXACT_EVENT_PUBLICATION === "true" &&
    observationPath &&
    isPublicOpenClawReadOnlyRequest(resolvedArgs)
  ) {
    ensureGitHubRuntimeAvailable("before GitHub operation", deadlineAt);
    const circuit = activeGitHubRateLimitCircuit(
      observationPath,
      scope,
      targetRepo().split("/", 1)[0] || "",
    );
    if (circuit) {
      recordGitHubRequest(resolvedArgs, scope, "skipped_by_circuit");
      throw circuit;
    }
  }
  const etagKey = githubEtagKeyForArgs(resolvedArgs, preparedEnv, env);
  if (etagKey && githubEtagBrokerConfigured()) {
    return ghWithDurableEtag(
      resolvedArgs,
      timeoutMs,
      preparedEnv,
      scope,
      etagKey,
      deadlineAt,
      onDispatch,
    );
  }
  if (etagKey) {
    recordGithubEgressBrokerEvent(resolvedArgs, {
      unit: "broker_lookup",
      outcome: "cache_skip",
      env: { ...process.env, ...preparedEnv },
    });
  }
  const commandTimeoutMs =
    deadlineAt === undefined ? timeoutMs : githubCommandTimeoutMs(timeoutMs, deadlineAt);
  const commandOptions = {
    cwd: ROOT,
    timeoutMs: commandTimeoutMs,
    maxBuffer: SWEEPER_COMMAND_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    trim: "both" as const,
    ...(preparedEnv ? { env: preparedEnv } : {}),
  };
  onDispatch?.();
  try {
    const result = runText("gh", resolvedArgs, commandOptions);
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

function githubEtagKeyForArgs(
  args: readonly string[],
  preparedEnv: NodeJS.ProcessEnv | undefined,
  overrides: NodeJS.ProcessEnv,
) {
  if (process.env.EXACT_EVENT_PUBLICATION !== "true" || args[0] !== "api") return null;
  if (
    args.some(
      (arg) =>
        [
          "-i",
          "--include",
          "--paginate",
          "--slurp",
          "-f",
          "--raw-field",
          "-F",
          "--field",
          "-q",
          "--jq",
          "-t",
          "--template",
        ].includes(arg) ||
        arg.startsWith("--jq=") ||
        arg.startsWith("--template=") ||
        /^-i*[qt]/.test(arg),
    )
  ) {
    return null;
  }
  const methodIndex = args.findIndex((arg) => arg === "-X" || arg === "--method");
  if (methodIndex >= 0 && String(args[methodIndex + 1] || "").toUpperCase() !== "GET") {
    return null;
  }
  const route = githubApiEndpointForEtag(args);
  if (!route) return null;
  let mediaType: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "-H" && args[index] !== "--header") continue;
    const header = String(args[index + 1] || "");
    const match = /^accept:\s*(.+)$/i.exec(header);
    if (match) mediaType = match[1];
    index += 1;
  }
  const configuredPool = String(preparedEnv?.CLAWSWEEPER_GITHUB_POOL_CLASS || "");
  const credentialPool = GITHUB_ETAG_CREDENTIAL_POOLS.includes(
    configuredPool as GithubEtagCredentialPool,
  )
    ? (configuredPool as GithubEtagCredentialPool)
    : publicReadToken(args, overrides) ||
        exactPublicationPublicReadToken(args, targetRepo(), { ...process.env, ...overrides })
      ? "public_read_fallback"
      : githubRequestScope(args, overrides);
  return githubEtagCacheKey({ credentialPool, route, mediaType, surface: "apply" });
}

function githubApiEndpointForEtag(args: readonly string[]): string | null {
  const valueFlags = new Set([
    "-X",
    "--method",
    "-H",
    "--header",
    "--hostname",
    "-q",
    "--jq",
    "-t",
    "--template",
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const value = String(args[index] || "");
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) return value;
  }
  return null;
}

function githubEtagBrokerConfigured(): boolean {
  const remaining = githubRuntimeRemainingMs();
  return Boolean(
    process.env.EXACT_REVIEW_QUEUE_URL?.trim() &&
    process.env.CLAWSWEEPER_WEBHOOK_SECRET?.trim() &&
    (remaining === null || remaining > ETAG_BROKER_BUDGET_RESERVE_MS),
  );
}

function ghWithDurableEtag(
  args: string[],
  timeoutMs: number | undefined,
  preparedEnv: NodeJS.ProcessEnv | undefined,
  scope: GitHubCredentialScope,
  key: NonNullable<ReturnType<typeof githubEtagCacheKey>>,
  deadlineAt?: number,
  onDispatch?: () => void,
): string {
  const requestBody = githubEtagCacheRequestBody(key, "apply");
  const record = (event: Parameters<typeof recordGithubEgressBrokerEvent>[1]) =>
    recordGithubEgressBrokerEvent(args, { ...event, env: { ...process.env, ...preparedEnv } });
  return durableGithubEtagReadSync({
    key,
    lookup: () => {
      const response = signedEtagBrokerPost("lookup", requestBody, deadlineAt);
      return {
        hit: response.hit === true,
        ...(response.entry && typeof response.entry === "object"
          ? {
              entry: {
                etag: stringValue((response.entry as Record<string, unknown>).etag),
                bodyDigest: stringValue((response.entry as Record<string, unknown>).bodyDigest),
              },
            }
          : {}),
      };
    },
    store200: (_cacheKey, response) => {
      const stored = signedEtagBrokerPost("store", { ...requestBody, ...response }, deadlineAt);
      return { stored: stored.stored === true };
    },
    confirm304: (_cacheKey, expected) => {
      const confirmed = signedEtagBrokerPost(
        "confirm",
        { ...requestBody, etag: expected.etag, body_digest: expected.bodyDigest },
        deadlineAt,
      );
      const entry = objectValue(confirmed.entry);
      return {
        confirmed: confirmed.confirmed === true,
        ...(typeof confirmed.body === "string" ? { body: confirmed.body } : {}),
        ...(confirmed.entry
          ? {
              entry: {
                etag: stringValue(entry.etag),
                bodyDigest: stringValue(entry.bodyDigest),
              },
            }
          : {}),
      };
    },
    githubRequest: (ifNoneMatch) =>
      ghIncludedRequest(args, timeoutMs, preparedEnv, scope, ifNoneMatch, deadlineAt, onDispatch),
    record,
    retained: gitHubRunState().retainedEtagResponses,
  });
}

function signedEtagBrokerPost(
  operation: "lookup" | "store" | "confirm",
  value: Record<string, unknown>,
  deadlineAt?: number,
): Record<string, unknown> {
  const baseUrl = etagBrokerBaseUrl();
  const secret = process.env.CLAWSWEEPER_WEBHOOK_SECRET?.trim() || "";
  const body = JSON.stringify(value);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const args = [
    "--fail",
    "--silent",
    "--show-error",
    "--connect-timeout",
    "2",
    "--max-time",
    "5",
    "--request",
    "POST",
    "--header",
    "content-type: application/json",
    "--header",
    `x-clawsweeper-exact-review-signature: ${signature}`,
    "--data-binary",
    "@-",
    `${baseUrl}/internal/exact-review/github-etag-cache/${operation}`,
  ];
  const env = { ...process.env };
  const command = resolveCommand("curl", args, env);
  const result = spawnSync(command.command, command.args, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    input: body,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: Math.min(
      ETAG_BROKER_TIMEOUT_MS,
      githubCommandTimeoutMs(ETAG_BROKER_TIMEOUT_MS, deadlineAt)!,
    ),
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(String(result.stderr || "ETag broker request failed"));
  }
  const parsed: unknown = JSON.parse(String(result.stdout || "null"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ETag broker returned an invalid response");
  }
  return parsed as Record<string, unknown>;
}

function etagBrokerBaseUrl(): string {
  const raw = process.env.EXACT_REVIEW_QUEUE_URL?.trim() || "";
  const url = new URL(raw);
  const loopback =
    url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password) {
    throw new Error("EXACT_REVIEW_QUEUE_URL must be credential-free HTTPS or loopback HTTP");
  }
  return url.toString().replace(/\/$/, "");
}

function ghIncludedRequest(
  args: string[],
  timeoutMs: number | undefined,
  preparedEnv: NodeJS.ProcessEnv | undefined,
  scope: GitHubCredentialScope,
  ifNoneMatch?: string,
  deadlineAt?: number,
  onDispatch?: () => void,
): GithubConditionalResponse {
  const includeArgs = [args[0]!, "-i"];
  if (ifNoneMatch) includeArgs.push("-H", `If-None-Match: ${ifNoneMatch}`);
  includeArgs.push(...args.slice(1));
  const commandEnv = { ...process.env, ...preparedEnv, GIT_OPTIONAL_LOCKS: "0" };
  const command = resolveCommand("gh", includeArgs, commandEnv);
  const commandTimeoutMs = githubCommandTimeoutMs(timeoutMs, deadlineAt);
  onDispatch?.();
  const result = spawnSync(command.command, command.args, {
    cwd: ROOT,
    encoding: "utf8",
    env: commandEnv,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: commandTimeoutMs,
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const parsed = parseIncludedGithubResponse(stdout.includes("HTTP/") ? stdout : stderr);
  if (parsed && (parsed.status === 200 || parsed.status === 304)) {
    recordGitHubRequest(args, scope, "success");
    return parsed;
  }
  const error = new Error(
    [`Command failed: gh ${args.join(" ")}`, String(result.stderr || "").trim()]
      .filter(Boolean)
      .join("\n"),
  );
  const retryKind = ghRetryKind(error);
  if (retryKind !== "throttle") {
    recordGitHubRequest(args, scope, retryKind === "transient" ? "transient" : "error");
  }
  throw error;
}

function parseIncludedGithubResponse(value: string): GithubConditionalResponse | null {
  const normalized = value.replace(/\r\n/g, "\n");
  const matches = [...normalized.matchAll(/^HTTP\/[^\s]+\s+(\d{3})[^\n]*$/gm)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return null;
  const block = normalized.slice(last.index);
  const separator = block.indexOf("\n\n");
  const headerText = separator >= 0 ? block.slice(0, separator) : block;
  const body = separator >= 0 ? block.slice(separator + 2).trim() : "";
  const headers = new Map<string, string>();
  for (const line of headerText.split("\n").slice(1)) {
    const delimiter = line.indexOf(":");
    if (delimiter <= 0) continue;
    headers.set(line.slice(0, delimiter).trim().toLowerCase(), line.slice(delimiter + 1).trim());
  }
  return {
    status: Number(last[1]),
    body,
    ...(headers.get("etag") ? { etag: headers.get("etag") } : {}),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function gh(args: string[]): string {
  return ghWithPreparedTimeout(args, githubCommandTimeoutMs());
}

/**
 * The first attempt `gh(args)` would make for each request, with the
 * commands running concurrently. Preparation, circuit checks and request
 * metrics are `gh`'s; the runtime budget is one absolute deadline, so a
 * command still queued when it runs out fails with the budget error `gh`
 * gives before dispatch. Retries stay with the caller. `null` leaves a
 * request to `gh` itself (conditional ETag reads in the publication lane).
 */
export function ghFirstAttemptsConcurrently(
  requests: readonly string[][],
): Array<GitHubFirstAttempt | null> {
  gitHubRunState();
  const attempts: Array<GitHubFirstAttempt | null> = [];
  const dispatched: Array<{
    index: number;
    args: string[];
    scope: GitHubCredentialScope;
    options: { env?: NodeJS.ProcessEnv; deadlineAt?: number | undefined };
  }> = [];
  for (const [index, args] of requests.entries()) {
    try {
      const timeoutMs = githubCommandTimeoutMs();
      const resolvedArgs = args[0] === "api" ? args : ["--repo", targetRepo(), ...args];
      const preparedEnv = preparedGitHubEnv(resolvedArgs);
      const scope = githubRequestScope(resolvedArgs);
      const observationPath = rateLimitObservationPath();
      if (
        process.env.EXACT_EVENT_PUBLICATION === "true" &&
        observationPath &&
        isPublicOpenClawReadOnlyRequest(resolvedArgs)
      ) {
        ensureGitHubRuntimeAvailable("before GitHub operation");
        const circuit = activeGitHubRateLimitCircuit(
          observationPath,
          scope,
          targetRepo().split("/", 1)[0] || "",
        );
        if (circuit) {
          recordGitHubRequest(resolvedArgs, scope, "skipped_by_circuit");
          throw circuit;
        }
      }
      if (!githubEtagKeyForArgs(resolvedArgs, preparedEnv, {})) {
        dispatched.push({
          index,
          args: resolvedArgs,
          scope,
          options: {
            ...(timeoutMs === undefined ? {} : { deadlineAt: Date.now() + timeoutMs }),
            ...(preparedEnv ? { env: preparedEnv } : {}),
          },
        });
      }
      attempts.push(null);
    } catch (error) {
      attempts.push({ error });
    }
  }
  if (dispatched.length === 0) return attempts;
  const results = runTextConcurrently(
    dispatched.map(({ args, options }) => ({
      command: "gh",
      args,
      options: {
        ...options,
        cwd: ROOT,
        maxBuffer: SWEEPER_COMMAND_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        trim: "both",
      },
    })),
    GITHUB_CONCURRENT_READS,
  );
  for (const [position, { index, args, scope }] of dispatched.entries()) {
    const result = results[position]!;
    if ("expired" in result) {
      attempts[index] = { error: githubRuntimeBudgetError("before GitHub operation") };
      continue;
    }
    if ("error" in result) {
      const retryKind = ghRetryKind(result.error);
      if (retryKind !== "throttle") {
        recordGitHubRequest(args, scope, retryKind === "transient" ? "transient" : "error");
      }
    } else {
      recordGitHubRequest(args, scope, "success");
    }
    attempts[index] = result;
  }
  return attempts;
}

export function ghOnce(args: string[], timeoutMs: number): string {
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

export function sleepMs(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function untrustedCodexEnv(
  options: {
    ghToken?: string | undefined;
    preserveCodexAuth?: boolean | undefined;
  } = {},
): NodeJS.ProcessEnv {
  const env = codexEnv(options);
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAWSWEEPER_ACTION_LEDGER_") || key.startsWith("EXACT_REVIEW_"))
      delete env[key];
  }
  return env;
}
