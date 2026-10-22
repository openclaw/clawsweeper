import { AgentInputScanError } from "./agent-input-scan.js";
import { ReviewSourcePreparationError } from "./review-source-preparation.js";
import { NonretryableReviewBatchError } from "./exact-review-failure-reason.js";
import {
  ValidationRecoveryRequiredError,
  validationRecoveryRequired,
} from "./validation-recovery.js";
import { sha256 } from "./content-hash.js";
import { isRecord } from "./value-coerce.js";
import { isAbsolute, resolve, sep } from "node:path";
export const CODEX_FAILURE_LOG_KINDS = {
  "dirty checkout": "codex_execution",
  "missing structured output": "content_or_output",
  "invalid structured output": "content_or_output",
  "output buffer overflow": "content_or_output",
  "model unavailable or access denied": "model_access",
  timeout: "timeout",
  "retryable codex transport failure (capacity)": "provider_throttle",
  "retryable codex transport failure (network)": "transport_network",
  "codex execution failed": "codex_execution",
} as const;
export type CodexFailureReason = keyof typeof CODEX_FAILURE_LOG_KINDS;
export type CodexFailureLogKind = (typeof CODEX_FAILURE_LOG_KINDS)[CodexFailureReason];
export interface AssessmentFailureDisposition {
  retryable: boolean;
  terminal: boolean;
  logKind: CodexFailureLogKind;
}
export function parseAssessmentFailureDisposition(input: unknown): AssessmentFailureDisposition {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid assessment failure disposition.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["retryable", "terminal", "logKind"].includes(key)) ||
    typeof value.retryable !== "boolean" ||
    typeof value.terminal !== "boolean" ||
    (value.terminal && value.retryable) ||
    !Object.values(CODEX_FAILURE_LOG_KINDS).includes(value.logKind as CodexFailureLogKind)
  )
    throw new Error("Invalid assessment failure disposition.");
  return {
    retryable: value.retryable,
    terminal: value.terminal,
    logKind: value.logKind as CodexFailureLogKind,
  };
}

export class CodexReviewError extends Error {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode: string | null;
  readonly signal: NodeJS.Signals | null;
  readonly retryable: boolean;
  readonly diagnostic: string;
  readonly retryHint?: string;
  readonly failureDisposition?: AssessmentFailureDisposition;

  constructor(options: {
    message: string;
    status: number | null;
    stdout?: string;
    stderr?: string;
    errorCode?: string | null;
    signal?: NodeJS.Signals | null;
    retryable?: boolean;
    diagnostic?: string;
    retryHint?: string;
    failureDisposition?: AssessmentFailureDisposition;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexReviewError";
    this.status = options.status;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.errorCode = options.errorCode ?? null;
    this.signal = options.signal ?? null;
    const disposition = options.failureDisposition
      ? parseAssessmentFailureDisposition(options.failureDisposition)
      : undefined;
    this.retryable = disposition?.retryable ?? options.retryable ?? false;
    if (disposition) this.failureDisposition = disposition;
    this.diagnostic = options.diagnostic ?? "";
    if (options.retryHint !== undefined) this.retryHint = options.retryHint;
  }
}

/** Internal recovery evidence, never an advisory Decision or durable provider diagnostic. */
export interface AssessmentRecoveryReceipt {
  digest: string;
  paths: string[];
  causes: Array<{ name: string; digest: string; code?: string }>;
  overflow: boolean;
}
const RECOVERY_NAMES = new Set([
  "Error",
  "CodexReviewError",
  "ReviewGitError",
  "ValidationRecoveryRequiredError",
]);
const RECOVERY_CODES = new Set([
  "ETIMEDOUT",
  "EPROCESSSETTLEMENT",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOSPC",
  "EIO",
]);
export function assessmentRecoveryReceipt(error: unknown): AssessmentRecoveryReceipt | undefined {
  const recovery = validationRecoveryRequired(error);
  if (!recovery) return;
  const allPaths = [...recovery.recoveryPaths];
  const causes: AssessmentRecoveryReceipt["causes"] = [];
  const seen = new Set<unknown>();
  for (
    let cause: unknown = error;
    cause instanceof Error && !seen.has(cause) && causes.length < 4;
    cause = cause.cause
  ) {
    seen.add(cause);
    const code =
      (cause as Error & { code?: unknown; errorCode?: unknown }).code ??
      (cause as Error & { errorCode?: unknown }).errorCode;
    causes.push({
      name: RECOVERY_NAMES.has(cause.name) ? cause.name : "Error",
      digest: sha256(cause.message),
      ...(typeof code === "string" && RECOVERY_CODES.has(code) ? { code } : {}),
    });
  }
  return {
    digest: sha256(recovery.message),
    paths: allPaths.slice(0, 16).filter((path) => path.length <= 4096),
    causes,
    overflow: allPaths.length > 16 || allPaths.some((path) => path.length > 4096),
  };
}
export function parseAssessmentRecoveryReceipt(
  value: unknown,
  ownedRoot: string,
): ValidationRecoveryRequiredError {
  const fail = () =>
    new ValidationRecoveryRequiredError("Invalid bounded worker recovery receipt", undefined, [
      ownedRoot,
    ]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["digest", "paths", "causes", "overflow"].includes(key)) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    value.overflow !== false ||
    !Array.isArray(value.paths) ||
    value.paths.length > 16 ||
    !Array.isArray(value.causes) ||
    value.causes.length > 4
  )
    throw fail();
  const paths: string[] = [];
  for (const path of value.paths) {
    if (
      typeof path !== "string" ||
      path.length > 4096 ||
      path.split("").some((character) => character.charCodeAt(0) < 32) ||
      !isAbsolute(path) ||
      (resolve(path) !== resolve(ownedRoot) && !resolve(path).startsWith(resolve(ownedRoot) + sep))
    )
      throw fail();
    paths.push(path);
  }
  let cause: unknown;
  for (const item of [...value.causes].reverse()) {
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => !["name", "digest", "code"].includes(key)) ||
      typeof item.name !== "string" ||
      !RECOVERY_NAMES.has(item.name) ||
      typeof item.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.digest) ||
      (item.code !== undefined && (typeof item.code !== "string" || !RECOVERY_CODES.has(item.code)))
    )
      throw fail();
    const next = new Error("Private worker cause digest " + String(item.digest), { cause });
    next.name = String(item.name);
    if (item.code !== undefined) Object.assign(next, { code: item.code });
    cause = next;
  }
  return new ValidationRecoveryRequiredError(
    "Assessment worker requires recovery; receipt " + String(value.digest),
    cause,
    [ownedRoot, ...paths],
  );
}

/** Only explicit transient assessment receipts can authorize another paid batch. */
export function retryableBatchFailure(error: unknown): boolean {
  const disposition = error instanceof CodexReviewError ? error.failureDisposition : undefined;
  return Boolean(
    disposition?.retryable &&
    !disposition.terminal &&
    ["timeout", "transport_network", "provider_throttle"].includes(disposition.logKind),
  );
}

/** Secondary bookkeeping/cleanup cannot authorize repeating an already attempted batch. */
export function batchSecondaryFailure(primary: unknown, secondary: unknown): unknown {
  const pending = [primary, secondary];
  const visited = new Set<unknown>();
  const paths = new Set<string>();
  let recoveryRequired = false;
  for (let index = 0; index < pending.length; index++) {
    const error = pending[index];
    if (!(error instanceof Error) || visited.has(error)) continue;
    visited.add(error);
    if (error instanceof ValidationRecoveryRequiredError) {
      recoveryRequired = true;
      for (const path of error.recoveryPaths) paths.add(path);
    }
    if (error instanceof AggregateError) pending.push(...error.errors);
    pending.push(error.cause);
  }
  // Existing scanner/source owners retain their classification and identity.
  if (primary instanceof AgentInputScanError || primary instanceof ReviewSourcePreparationError) {
    if (recoveryRequired)
      primary.cause = new ValidationRecoveryRequiredError(
        "Review recovery retained after a secondary failure",
        new AggregateError([primary.cause, secondary], "Secondary review recovery", {
          cause: primary.cause,
        }),
        [...paths],
      );
    return primary;
  }
  const combined =
    primary === undefined
      ? secondary
      : new AggregateError(
          [primary, secondary],
          "Review failed and secondary finalization failed",
          { cause: primary },
        );
  const cause = recoveryRequired
    ? new ValidationRecoveryRequiredError(
        "Review recovery retained after a secondary failure",
        combined,
        [...paths],
      )
    : combined;
  return new NonretryableReviewBatchError(cause);
}
