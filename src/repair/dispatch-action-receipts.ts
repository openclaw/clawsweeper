import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  actionIdempotencyKey,
  actionLedgerJson,
  type ActionEvent,
  type ActionEventReasonCode,
} from "../action-ledger.js";
import {
  flushWorkflowActionEvents,
  recordWorkflowPhaseEvent,
  workflowActionProducer,
  workflowActionEventsEnabled,
} from "../action-ledger-runtime.js";
import { normalizeRepo } from "../repository-profiles.js";
import { repoRoot } from "./paths.js";

const MAX_DISPATCH_INPUT_FIELDS = 32;
const MAX_DISPATCH_INPUT_KEY_BYTES = 64;
const MAX_DISPATCH_INPUT_STRING_BYTES = 512;
const MAX_DISPATCH_INPUT_JSON_BYTES = 8 * 1024;
const MAX_DISPATCH_CHAIN_CACHE_ENTRIES = 64;
const DISPATCH_CHAIN_CACHE_TTL_MS = 10 * 60 * 1000;
const LOCAL_DISPATCH_RUN_STARTED_AT = new Date().toISOString();
const LOCAL_DISPATCH_RUN_ID = `local-${Date.now()}-${process.pid}`;
const DISPATCH_INPUT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const LOCAL_COMPONENT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FORBIDDEN_DISPATCH_INPUT_KEYS = new Set([
  "authorization",
  "body",
  "client_payload",
  "cookie",
  "credential",
  "credentials",
  "payload",
  "private_key",
  "raw",
  "raw_payload",
  "secret",
  "token",
]);
const DISPATCH_PRIVACY_DROPPED_FIELDS = [
  "authorization",
  "body",
  "client_payload",
  "error",
  "payload",
  "raw_payload",
  "token",
] as const;

export type BoundedDispatchInputValue = string | number | boolean | null;
export type BoundedDispatchInput = Readonly<Record<string, BoundedDispatchInputValue>>;
export type DispatchKind = "repository" | "workflow";
export type DispatchOutcome = "accepted" | "rejected" | "unknown";
export type DispatchOutcomeDisposition = {
  outcome: DispatchOutcome;
  statusKind: "accepted" | "error" | "timeout" | "unknown";
};
export type DispatchActionReceiptContext = {
  root: string;
  outputRoot: string;
  env: NodeJS.ProcessEnv;
};

type DispatchReceiptConfig = {
  component: string;
  operationKey: string;
  dispatchKind: DispatchKind;
  repository: string;
  dispatchTarget: string;
  dispatchInput: BoundedDispatchInput;
  root?: string;
  env?: NodeJS.ProcessEnv;
};

type DispatchReceiptOptions<T> = DispatchReceiptConfig & {
  operation: () => T;
  outcome?: (result: T) => DispatchOutcomeDisposition;
  knownNoMutation?: (error: unknown) => boolean;
};

type DispatchChain = {
  parentEventId: string | null;
  nextPhaseSeq: number;
  nextAttempt: number;
  activeAttempts: number;
  lastTouchedAtMs: number;
};

const dispatchChains = new Map<string, DispatchChain>();

export class DispatchRejectedError extends Error {
  readonly status: number | null;

  constructor(message: string, options: { status?: number } = {}) {
    super(message);
    this.name = "DispatchRejectedError";
    this.status = options.status ?? null;
  }
}

export class DispatchOutcomeUnknownError extends Error {
  readonly timeout: boolean;

  constructor(message: string, options: { timeout?: boolean } = {}) {
    super(message);
    this.name = "DispatchOutcomeUnknownError";
    this.timeout = options.timeout ?? false;
  }
}

export function dispatchInputSha256(input: BoundedDispatchInput): string {
  const normalized = normalizedDispatchInput(input);
  return actionIdempotencyKey(normalized);
}

export function assertDispatchActionReceiptsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!workflowActionEventsEnabled(env)) {
    throw new Error("refusing dispatch without authoritative action receipts");
  }
  if (!env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT?.trim()) {
    throw new Error("refusing dispatch without an authoritative action receipt output root");
  }
  if (!env.GITHUB_RUN_STARTED_AT?.trim()) {
    throw new Error("refusing dispatch without an immutable action receipt start time");
  }
  workflowActionProducer("dispatch_receipt_preflight", env);
}

export function prepareDispatchActionReceiptContext({
  component,
  env = process.env,
}: {
  component: string;
  env?: NodeJS.ProcessEnv;
}): DispatchActionReceiptContext {
  if (
    env.GITHUB_ACTIONS === "true" ||
    env.CLAWSWEEPER_ACTION_LEDGER_FORCE === "1" ||
    env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() ||
    env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT?.trim()
  ) {
    assertDispatchActionReceiptsEnabled(env);
    return {
      root: requiredExistingDirectory(
        env.CLAWSWEEPER_ACTION_LEDGER_ROOT,
        "CLAWSWEEPER_ACTION_LEDGER_ROOT",
      ),
      outputRoot: requiredExistingDirectory(
        env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT,
        "CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT",
      ),
      env,
    };
  }
  if (env.CLAWSWEEPER_ACTION_LEDGER_DISABLED === "1") {
    throw new Error("refusing dispatch without authoritative action receipts");
  }

  const normalizedComponent = boundedMachineText(component, "local receipt component", 64);
  if (!LOCAL_COMPONENT_PATTERN.test(normalizedComponent)) {
    throw new Error("local receipt component must be a machine identifier");
  }
  const repositoryRoot = repoRoot();
  const repository = localDispatchRepository(repositoryRoot, env);
  const sha = localDispatchSha(repositoryRoot, env);
  const localRoot = createReceiptDirectory(
    path.resolve(
      env.CLAWSWEEPER_ACTION_LEDGER_LOCAL_ROOT?.trim() ||
        path.join(repositoryRoot, ".clawsweeper-repair", "local-dispatch-action-ledger"),
    ),
  );
  const runKey = createHash("sha256")
    .update(`${repository}:${sha}:${LOCAL_DISPATCH_RUN_ID}`)
    .digest("hex")
    .slice(0, 24);
  const root = createReceiptDirectory(path.join(localRoot, "runs", runKey, normalizedComponent));
  const outputRoot = createReceiptDirectory(
    path.join(localRoot, "output", runKey, normalizedComponent),
  );
  const localEnv = {
    ...env,
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: `${LOCAL_DISPATCH_RUN_ID}-${normalizedComponent}`,
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW: "local-dispatch",
    GITHUB_WORKFLOW_REF: "",
    GITHUB_JOB: normalizedComponent,
    GITHUB_RUN_ID: LOCAL_DISPATCH_RUN_ID,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_STARTED_AT: LOCAL_DISPATCH_RUN_STARTED_AT,
    GITHUB_ACTION: normalizedComponent,
  };
  assertDispatchActionReceiptsEnabled(localEnv);
  return { root, outputRoot, env: localEnv };
}

export function dispatchChainCacheSizeForTest(): number {
  return dispatchChains.size;
}

export function dispatchChainActiveAttemptsForTest(): number {
  return [...dispatchChains.values()].reduce((total, chain) => total + chain.activeAttempts, 0);
}

export function runDispatchWithReceiptSync<T>(options: DispatchReceiptOptions<T>): T {
  const receipt = startDispatchReceipt(options);
  let result: T;
  try {
    result = options.operation();
  } catch (error) {
    finishFailedDispatchReceipt(receipt, error, options.knownNoMutation);
    throw error;
  }
  let disposition: DispatchOutcomeDisposition;
  try {
    disposition = options.outcome?.(result) ?? acceptedDispatch();
  } catch (error) {
    finishFailedDispatchReceipt(receipt, error);
    throw error;
  }
  finishCompletedDispatchReceipt(receipt, disposition);
  return result;
}

export async function runDispatchWithReceipt<T>(
  options: DispatchReceiptConfig & {
    operation: () => Promise<T>;
    outcome?: (result: T) => DispatchOutcomeDisposition;
    knownNoMutation?: (error: unknown) => boolean;
  },
): Promise<T> {
  const receipt = startDispatchReceipt(options);
  let result: T;
  try {
    result = await options.operation();
  } catch (error) {
    finishFailedDispatchReceipt(receipt, error, options.knownNoMutation);
    throw error;
  }
  let disposition: DispatchOutcomeDisposition;
  try {
    disposition = options.outcome?.(result) ?? acceptedDispatch();
  } catch (error) {
    finishFailedDispatchReceipt(receipt, error);
    throw error;
  }
  finishCompletedDispatchReceipt(receipt, disposition);
  return result;
}

export function acceptedDispatch(): DispatchOutcomeDisposition {
  return { outcome: "accepted", statusKind: "accepted" };
}

export function rejectedDispatch(): DispatchOutcomeDisposition {
  return { outcome: "rejected", statusKind: "error" };
}

export function unknownDispatch(
  statusKind: DispatchOutcomeDisposition["statusKind"] = "unknown",
): DispatchOutcomeDisposition {
  return { outcome: "unknown", statusKind };
}

export function dispatchProcessOutcome(result: {
  status: number | null;
  signal?: string | null;
  error?: unknown;
}): DispatchOutcomeDisposition {
  if (result.status === 0 && !result.error && !result.signal) return acceptedDispatch();
  if (result.error && isTimeoutError(result.error)) return unknownDispatch("timeout");
  return unknownDispatch(result.error || result.signal ? "unknown" : "error");
}

export function dispatchErrorDisposition(
  error: unknown,
  knownNoMutation?: (error: unknown) => boolean,
): DispatchOutcomeDisposition {
  if (error instanceof DispatchRejectedError) return rejectedDispatch();
  try {
    if (knownNoMutation?.(error) === true) return rejectedDispatch();
  } catch {
    return unknownDispatch("unknown");
  }
  if (error instanceof DispatchOutcomeUnknownError) {
    return unknownDispatch(error.timeout ? "timeout" : "unknown");
  }
  if (isTimeoutError(error)) return unknownDispatch("timeout");
  return unknownDispatch("error");
}

export function dispatchHttpError(status: number, message: string): Error {
  if (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    ![408, 425, 429].includes(status)
  ) {
    return new DispatchRejectedError(message, { status });
  }
  return new DispatchOutcomeUnknownError(message, { timeout: status === 408 });
}

export async function flushDispatchActionEvents(
  root = dispatchActionLedgerRoot(),
  options: { env?: NodeJS.ProcessEnv; outputRoot?: string } = {},
): Promise<string[]> {
  return flushWorkflowActionEvents(root, options);
}

function startDispatchReceipt(options: DispatchReceiptConfig): {
  chain: DispatchChain;
  attempt: number;
  attemptEventId: string | null;
  inputSha256: string;
  operationIdentity: ReturnType<typeof dispatchOperationIdentity>;
  outcomePhaseSeq: number;
  options: DispatchReceiptConfig;
  chainKey: string;
} {
  const env = options.env ?? process.env;
  assertDispatchActionReceiptsEnabled(env);
  const repository = normalizeRepo(options.repository);
  const inputSha256 = dispatchInputSha256(options.dispatchInput);
  const operationIdentity = dispatchOperationIdentity({
    operationKey: options.operationKey,
    dispatchKind: options.dispatchKind,
    repository,
    dispatchTarget: options.dispatchTarget,
    inputSha256,
  });
  const { chain, key: chainKey } = acquireDispatchChain(operationIdentity, options.component, env);
  const attempt = chain.nextAttempt;
  const phaseSeq = chain.nextPhaseSeq;
  chain.nextAttempt += 1;
  chain.nextPhaseSeq += 2;
  const root = options.root ?? dispatchActionLedgerRoot(options.env);
  let event: ActionEvent | null;
  try {
    event = recordDispatchEvent(
      {
        ...options,
        repository,
        root,
        inputSha256,
        operationIdentity,
        attempt,
        parentEventId: chain.parentEventId,
        phaseSeq,
        disposition: null,
      },
      options.env,
    );
  } catch (error) {
    releaseDispatchChain(chainKey, chain);
    throw error;
  }
  chain.parentEventId = event?.event_id ?? chain.parentEventId;
  return {
    chain,
    chainKey,
    attempt,
    attemptEventId: event?.event_id ?? null,
    inputSha256,
    operationIdentity,
    outcomePhaseSeq: phaseSeq + 1,
    options: {
      component: options.component,
      operationKey: options.operationKey,
      dispatchKind: options.dispatchKind,
      repository,
      dispatchTarget: options.dispatchTarget,
      dispatchInput: options.dispatchInput,
      root,
      ...(options.env ? { env: options.env } : {}),
    },
  };
}

function finishDispatchReceipt(
  receipt: ReturnType<typeof startDispatchReceipt>,
  disposition: DispatchOutcomeDisposition,
): void {
  try {
    const event = recordDispatchEvent(
      {
        ...receipt.options,
        root: receipt.options.root ?? dispatchActionLedgerRoot(receipt.options.env),
        inputSha256: receipt.inputSha256,
        operationIdentity: receipt.operationIdentity,
        attempt: receipt.attempt,
        parentEventId: receipt.attemptEventId,
        phaseSeq: receipt.outcomePhaseSeq,
        disposition,
      },
      receipt.options.env,
    );
    receipt.chain.parentEventId = event?.event_id ?? receipt.chain.parentEventId;
  } finally {
    releaseDispatchChain(receipt.chainKey, receipt.chain);
  }
}

function finishCompletedDispatchReceipt(
  receipt: ReturnType<typeof startDispatchReceipt>,
  disposition: DispatchOutcomeDisposition,
): void {
  if (disposition.outcome !== "accepted") {
    finishDispatchReceipt(receipt, disposition);
    return;
  }
  try {
    finishDispatchReceipt(receipt, disposition);
  } catch (error) {
    console.error(
      `[action-ledger] dispatch accepted but failed to record outcome: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function finishFailedDispatchReceipt(
  receipt: ReturnType<typeof startDispatchReceipt>,
  error: unknown,
  knownNoMutation?: (error: unknown) => boolean,
): void {
  try {
    finishDispatchReceipt(receipt, dispatchErrorDisposition(error, knownNoMutation));
  } catch {
    console.error("[action-ledger] failed to record dispatch failure outcome");
  }
}

function recordDispatchEvent(
  options: {
    component: string;
    dispatchKind: DispatchKind;
    repository: string;
    dispatchTarget: string;
    root: string;
    inputSha256: string;
    operationIdentity: ReturnType<typeof dispatchOperationIdentity>;
    attempt: number;
    parentEventId: string | null;
    phaseSeq: number;
    disposition: DispatchOutcomeDisposition | null;
  },
  env: NodeJS.ProcessEnv | undefined,
): ActionEvent | null {
  const disposition = options.disposition;
  const outcome = disposition?.outcome ?? "attempted";
  return recordWorkflowPhaseEvent(
    options.root,
    {
      phase: ACTION_EVENT_TYPES.dispatchLifecycle,
      status:
        disposition === null
          ? ACTION_EVENT_STATUSES.started
          : disposition.outcome === "accepted"
            ? ACTION_EVENT_STATUSES.dispatched
            : disposition.outcome === "rejected"
              ? ACTION_EVENT_STATUSES.skipped
              : ACTION_EVENT_STATUSES.failed,
      reasonCode: dispatchReasonCode(disposition),
      retryable: false,
      mutation: disposition?.outcome === "accepted" || disposition?.outcome === "unknown",
      identity: {
        slot: disposition === null ? "dispatch_attempt" : "dispatch_outcome",
        attempt: options.attempt,
        outcome,
        inputSha256: options.inputSha256,
      },
      operation: "dispatch",
      operationIdentity: options.operationIdentity,
      parentEventId: options.parentEventId,
      phaseSeq: options.phaseSeq,
      idempotencyIdentity: {
        operation: options.operationIdentity,
        inputSha256: options.inputSha256,
      },
      component: options.component,
      subject: {
        repository: options.repository,
        kind: options.dispatchKind === "workflow" ? "workflow" : "repository",
        subjectId: `dispatch-${options.inputSha256.slice(0, 24)}`,
      },
      evidence: [{ kind: "dispatch_input", sha256: options.inputSha256 }],
      attributes: {
        attempt: options.attempt,
        dispatch_kind: options.dispatchKind,
        state: outcome,
        status_kind: disposition?.statusKind ?? "attempted",
        completion_reason:
          disposition === null
            ? "dispatch_attempted"
            : disposition.outcome === "accepted"
              ? "dispatch_accepted"
              : disposition.outcome === "rejected"
                ? "dispatch_rejected"
                : "dispatch_outcome_unknown",
      },
      privacy: {
        classification: "internal",
        redactionVersion: "v1",
        fieldsDropped: DISPATCH_PRIVACY_DROPPED_FIELDS,
      },
    },
    env ? { env } : {},
  );
}

function dispatchReasonCode(disposition: DispatchOutcomeDisposition | null): ActionEventReasonCode {
  if (disposition === null) return ACTION_EVENT_REASON_CODES.selected;
  if (disposition.outcome === "accepted") return ACTION_EVENT_REASON_CODES.accepted;
  if (disposition.outcome === "rejected") return ACTION_EVENT_REASON_CODES.notApplicable;
  return disposition.statusKind === "timeout"
    ? ACTION_EVENT_REASON_CODES.timeout
    : ACTION_EVENT_REASON_CODES.unavailable;
}

function dispatchOperationIdentity(options: {
  operationKey: string;
  dispatchKind: DispatchKind;
  repository: string;
  dispatchTarget: string;
  inputSha256: string;
}) {
  return {
    operationKey: boundedMachineText(options.operationKey, "dispatch operation key", 256),
    dispatchKind: options.dispatchKind,
    repository: options.repository,
    dispatchTarget: boundedMachineText(options.dispatchTarget, "dispatch target", 256),
    inputSha256: options.inputSha256,
  };
}

function acquireDispatchChain(
  operationIdentity: ReturnType<typeof dispatchOperationIdentity>,
  component: string,
  env: NodeJS.ProcessEnv,
): { chain: DispatchChain; key: string } {
  const key = createHash("sha256")
    .update(
      actionLedgerJson({
        operationIdentity,
        component,
        runId: env.GITHUB_RUN_ID ?? "",
        runAttempt: env.GITHUB_RUN_ATTEMPT ?? "",
        action: env.GITHUB_ACTION ?? "",
        invocation: env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION ?? "",
      }),
    )
    .digest("hex");
  const now = Date.now();
  pruneDispatchChains(now);
  const existing = dispatchChains.get(key);
  if (existing) {
    existing.activeAttempts += 1;
    existing.lastTouchedAtMs = now;
    dispatchChains.delete(key);
    dispatchChains.set(key, existing);
    return { chain: existing, key };
  }
  const created = {
    parentEventId: null,
    nextPhaseSeq: 1,
    nextAttempt: 1,
    activeAttempts: 1,
    lastTouchedAtMs: now,
  };
  dispatchChains.set(key, created);
  pruneDispatchChains(now);
  return { chain: created, key };
}

function releaseDispatchChain(key: string, chain: DispatchChain): void {
  chain.activeAttempts = Math.max(0, chain.activeAttempts - 1);
  chain.lastTouchedAtMs = Date.now();
  if (dispatchChains.get(key) !== chain) return;
  dispatchChains.delete(key);
  dispatchChains.set(key, chain);
  pruneDispatchChains(chain.lastTouchedAtMs);
}

function pruneDispatchChains(now: number): void {
  for (const [key, chain] of dispatchChains) {
    if (chain.activeAttempts === 0 && now - chain.lastTouchedAtMs >= DISPATCH_CHAIN_CACHE_TTL_MS) {
      dispatchChains.delete(key);
    }
  }
  while (dispatchChains.size > MAX_DISPATCH_CHAIN_CACHE_ENTRIES) {
    const completed = [...dispatchChains].find(([, chain]) => chain.activeAttempts === 0);
    if (!completed) return;
    dispatchChains.delete(completed[0]);
  }
}

function normalizedDispatchInput(input: BoundedDispatchInput): BoundedDispatchInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("dispatch input must be a flat object");
  }
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.length > MAX_DISPATCH_INPUT_FIELDS) {
    throw new Error(`dispatch input must contain 1-${MAX_DISPATCH_INPUT_FIELDS} bounded fields`);
  }
  const normalized: Record<string, BoundedDispatchInputValue> = {};
  for (const [key, value] of entries) {
    if (
      !DISPATCH_INPUT_KEY_PATTERN.test(key) ||
      Buffer.byteLength(key, "utf8") > MAX_DISPATCH_INPUT_KEY_BYTES
    ) {
      throw new Error(`invalid dispatch input field: ${key}`);
    }
    if (FORBIDDEN_DISPATCH_INPUT_KEYS.has(key.toLowerCase())) {
      throw new Error(`dispatch input field is not receipt-safe: ${key}`);
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new Error(`dispatch input field ${key} must be scalar`);
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error(`dispatch input field ${key} must be a safe integer`);
    }
    if (
      typeof value === "string" &&
      Buffer.byteLength(value, "utf8") > MAX_DISPATCH_INPUT_STRING_BYTES
    ) {
      throw new Error(`dispatch input field ${key} exceeds its byte limit`);
    }
    normalized[key] = value;
  }
  const encoded = actionLedgerJson(normalized);
  if (Buffer.byteLength(encoded, "utf8") > MAX_DISPATCH_INPUT_JSON_BYTES) {
    throw new Error(`dispatch input exceeds ${MAX_DISPATCH_INPUT_JSON_BYTES} bytes`);
  }
  return normalized;
}

function boundedMachineText(value: string, label: string, maxBytes: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new Error(`${label} must be non-empty and at most ${maxBytes} bytes`);
  }
  return normalized;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = String(record.code ?? "").toUpperCase();
  const name = String(record.name ?? "").toLowerCase();
  const message = String(record.message ?? "").toLowerCase();
  return (
    ["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ABORT_ERR"].includes(code) ||
    name === "aborterror" ||
    /\b(?:timed? out|timeout)\b/.test(message)
  );
}

function dispatchActionLedgerRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
}

function localDispatchRepository(root: string, env: NodeJS.ProcessEnv): string {
  const configured = String(env.GITHUB_REPOSITORY || env.CLAWSWEEPER_REPO || "").trim();
  if (configured) return normalizeRepo(configured);
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (match?.[1]) return normalizeRepo(match[1]);
  } catch {
    // The explicit error below is more useful than the git failure.
  }
  throw new Error(
    "local dispatch receipts require GITHUB_REPOSITORY, CLAWSWEEPER_REPO, or a GitHub origin",
  );
}

function localDispatchSha(root: string, env: NodeJS.ProcessEnv): string {
  const configured = String(env.GITHUB_SHA ?? "").trim();
  if (configured) return configured;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("local dispatch receipts require GITHUB_SHA or a Git HEAD");
  }
}

function requiredExistingDirectory(value: string | undefined, name: string): string {
  const configured = String(value ?? "").trim();
  if (!configured) throw new Error(`${name} is required for dispatch receipts`);
  return fs.realpathSync(configured);
}

function createReceiptDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  return fs.realpathSync(directory);
}
