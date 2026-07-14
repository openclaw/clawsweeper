import { createHash } from "node:crypto";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  actionLedgerJson,
  type ActionEvent,
  type ActionEventReasonCode,
} from "../action-ledger.js";
import {
  flushWorkflowActionEvents,
  recordWorkflowPhaseEvent,
  workflowActionEventsEnabled,
} from "../action-ledger-runtime.js";
import { normalizeRepo } from "../repository-profiles.js";
import { repoRoot } from "./paths.js";

const MAX_DISPATCH_INPUT_FIELDS = 32;
const MAX_DISPATCH_INPUT_KEY_BYTES = 64;
const MAX_DISPATCH_INPUT_STRING_BYTES = 512;
const MAX_DISPATCH_INPUT_JSON_BYTES = 8 * 1024;
const DISPATCH_INPUT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
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
  return createHash("sha256").update(actionLedgerJson(normalized)).digest("hex");
}

export function runDispatchWithReceiptSync<T>(options: DispatchReceiptOptions<T>): T {
  const receipt = startDispatchReceipt(options);
  try {
    const result = options.operation();
    const disposition = options.outcome?.(result) ?? acceptedDispatch();
    finishDispatchReceipt(receipt, disposition);
    return result;
  } catch (error) {
    finishDispatchReceipt(receipt, dispatchErrorDisposition(error, options.knownNoMutation));
    throw error;
  }
}

export async function runDispatchWithReceipt<T>(
  options: DispatchReceiptConfig & {
    operation: () => Promise<T>;
    outcome?: (result: T) => DispatchOutcomeDisposition;
    knownNoMutation?: (error: unknown) => boolean;
  },
): Promise<T> {
  const receipt = startDispatchReceipt(options);
  try {
    const result = await options.operation();
    const disposition = options.outcome?.(result) ?? acceptedDispatch();
    finishDispatchReceipt(receipt, disposition);
    return result;
  } catch (error) {
    finishDispatchReceipt(receipt, dispatchErrorDisposition(error, options.knownNoMutation));
    throw error;
  }
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
  if (knownNoMutation?.(error) === true) return rejectedDispatch();
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
  options: DispatchReceiptConfig;
} {
  const env = options.env ?? process.env;
  if (env.GITHUB_ACTIONS === "true" && !workflowActionEventsEnabled(env)) {
    throw new Error("refusing GitHub Actions dispatch without authoritative action receipts");
  }
  const repository = normalizeRepo(options.repository);
  const inputSha256 = dispatchInputSha256(options.dispatchInput);
  const operationIdentity = dispatchOperationIdentity({
    operationKey: options.operationKey,
    dispatchKind: options.dispatchKind,
    repository,
    dispatchTarget: options.dispatchTarget,
    inputSha256,
  });
  const chain = dispatchChain(operationIdentity, options.component, env);
  const attempt = chain.nextAttempt;
  const phaseSeq = chain.nextPhaseSeq;
  chain.nextAttempt += 1;
  chain.nextPhaseSeq += 2;
  const root = options.root ?? dispatchActionLedgerRoot(options.env);
  const event = recordDispatchEvent(
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
  chain.parentEventId = event?.event_id ?? chain.parentEventId;
  return {
    chain,
    attempt,
    attemptEventId: event?.event_id ?? null,
    inputSha256,
    operationIdentity,
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
  const event = recordDispatchEvent(
    {
      ...receipt.options,
      root: receipt.options.root ?? dispatchActionLedgerRoot(receipt.options.env),
      inputSha256: receipt.inputSha256,
      operationIdentity: receipt.operationIdentity,
      attempt: receipt.attempt,
      parentEventId: receipt.attemptEventId,
      phaseSeq: receipt.chain.nextPhaseSeq - 1,
      disposition,
    },
    receipt.options.env,
  );
  receipt.chain.parentEventId = event?.event_id ?? receipt.chain.parentEventId;
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

function dispatchChain(
  operationIdentity: ReturnType<typeof dispatchOperationIdentity>,
  component: string,
  env: NodeJS.ProcessEnv,
): DispatchChain {
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
  const existing = dispatchChains.get(key);
  if (existing) return existing;
  const created = { parentEventId: null, nextPhaseSeq: 1, nextAttempt: 1 };
  dispatchChains.set(key, created);
  return created;
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
