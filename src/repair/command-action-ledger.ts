import { createHash } from "node:crypto";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEventReasonCode,
  type ActionEventStatus,
} from "../action-ledger.js";
import {
  flushWorkflowActionEvents,
  recordWorkflowActionEvent,
  workflowActionEventsEnabled,
} from "../action-ledger-runtime.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { repoRoot } from "./paths.js";

type CommandEventOptions = {
  status: ActionEventStatus;
  reasonCode: ActionEventReasonCode;
  mutation: boolean;
  retryable?: boolean;
  component?: string;
  eventIdentity?: unknown;
  idempotencyIdentity?: unknown;
  completionReason?: string;
  state?: string;
  dispatchKind?: string;
  queueDepth?: number;
};

export type CommandLifecycleInput = {
  repository: string;
  operationKey: string;
  number?: number | null;
  sourceRevision?: string | null;
  attemptId?: string | null;
};

type CommandEventChain = {
  parentEventId: string | null;
  phaseSeq: number;
  mutationObserved: boolean;
  uncertainMutationObserved: boolean;
};

const eventChains = new Map<string, CommandEventChain>();

export function recordCommandReceived(command: LooseRecord): void {
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandReceived, {
    status: ACTION_EVENT_STATUSES.received,
    reasonCode: ACTION_EVENT_REASON_CODES.accepted,
    mutation: false,
    state: "pending",
  });
}

export function recordCommandClassified(command: LooseRecord): void {
  const state = commandState(command);
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandClassified, {
    status: ACTION_EVENT_STATUSES.classified,
    reasonCode:
      state === "ready"
        ? ACTION_EVENT_REASON_CODES.selected
        : state === "waiting"
          ? ACTION_EVENT_REASON_CODES.dependencyPending
          : state === "skipped"
            ? ACTION_EVENT_REASON_CODES.alreadyProcessed
            : ACTION_EVENT_REASON_CODES.policyBlocked,
    mutation: false,
    state,
  });
}

export function recordCommandClaimed(command: LooseRecord): void {
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandClaimed, {
    status: ACTION_EVENT_STATUSES.claimed,
    reasonCode: ACTION_EVENT_REASON_CODES.accepted,
    mutation: true,
    idempotencyIdentity: {
      operation: commandOperationIdentity(command),
      mutation: "dispatch_claim",
    },
    state: "claimed",
  });
}

export function recordCommandClaimRefreshed(command: LooseRecord): void {
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandClaimRefreshed, {
    status: ACTION_EVENT_STATUSES.refreshed,
    reasonCode: ACTION_EVENT_REASON_CODES.retryScheduled,
    mutation: true,
    idempotencyIdentity: {
      operation: commandOperationIdentity(command),
      mutation: "dispatch_claim",
    },
    state: "claimed",
  });
}

export function recordCommandOutcome(command: LooseRecord): void {
  for (const action of commandActions(command)) {
    const actionName = machineState(action.action, "unknown");
    const actionStatus = machineState(action.status, "unknown");
    if (action.recovered === true || actionStatus === "recovered") {
      recordCommandEvent(command, ACTION_EVENT_TYPES.commandRecover, {
        status: ACTION_EVENT_STATUSES.recovered,
        reasonCode: ACTION_EVENT_REASON_CODES.recoveredStaleClaim,
        mutation: false,
        eventIdentity: { action: actionName, dispatchKey: action.dispatch_key ?? null },
        state: "recovered",
        dispatchKind: actionName,
      });
      continue;
    }
    if (
      ["dispatch_clawsweeper", "dispatch_repair", "dispatch_assist"].includes(actionName) &&
      actionStatus === "active"
    ) {
      recordCommandEvent(command, ACTION_EVENT_TYPES.commandRecover, {
        status: ACTION_EVENT_STATUSES.recovered,
        reasonCode: ACTION_EVENT_REASON_CODES.alreadyExists,
        mutation: false,
        eventIdentity: { action: actionName, runId: action.run_id ?? null },
        state: actionStatus,
        dispatchKind: actionName,
      });
      continue;
    }
    if (
      ["dispatch_clawsweeper", "dispatch_repair", "dispatch_assist"].includes(actionName) &&
      ["executed", "dispatched"].includes(actionStatus)
    ) {
      recordCommandEvent(command, ACTION_EVENT_TYPES.commandDispatched, {
        status: ACTION_EVENT_STATUSES.dispatched,
        reasonCode: ACTION_EVENT_REASON_CODES.accepted,
        mutation: true,
        eventIdentity: { action: actionName, dispatchKey: action.dispatch_key ?? null },
        idempotencyIdentity: {
          operation: commandOperationIdentity(command),
          mutation: actionName,
          dispatchKey: action.dispatch_key ?? null,
        },
        state: actionStatus,
        dispatchKind: actionName,
      });
    }
  }

  const state = commandState(command);
  if (state === "claimed" || state === "waiting") {
    recordCommandEvent(command, ACTION_EVENT_TYPES.commandWait, {
      status: ACTION_EVENT_STATUSES.waiting,
      reasonCode:
        state === "claimed"
          ? ACTION_EVENT_REASON_CODES.leaseActive
          : ACTION_EVENT_REASON_CODES.dependencyPending,
      mutation: false,
      state,
    });
    return;
  }
  if (state === "skipped" || state === "ignored") {
    recordCommandEvent(command, ACTION_EVENT_TYPES.commandSkipped, {
      status: ACTION_EVENT_STATUSES.skipped,
      reasonCode:
        state === "skipped"
          ? ACTION_EVENT_REASON_CODES.alreadyProcessed
          : ACTION_EVENT_REASON_CODES.policyBlocked,
      mutation: false,
      state,
    });
    return;
  }
  if (state === "executed") {
    recordCommandEvent(command, ACTION_EVENT_TYPES.commandCompleted, {
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      mutation: true,
      idempotencyIdentity: {
        operation: commandOperationIdentity(command),
        mutation: "command_terminal",
      },
      state,
    });
  }
}

export function recordCommandFailure(command: LooseRecord, error: unknown): void {
  const chain = commandEventChain(command);
  const mutation = chain.mutationObserved || chain.uncertainMutationObserved;
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandFailed, {
    status: ACTION_EVENT_STATUSES.failed,
    reasonCode: ACTION_EVENT_REASON_CODES.exception,
    mutation,
    retryable: chain.uncertainMutationObserved,
    eventIdentity: {
      errorKind: error instanceof Error ? error.name : typeof error,
    },
    idempotencyIdentity: mutation
      ? {
          operation: commandOperationIdentity(command),
          mutation: "command_terminal",
        }
      : undefined,
    completionReason: chain.uncertainMutationObserved
      ? "mutation_outcome_unknown"
      : mutation
        ? "mutation_observed"
        : "failed",
    state: "failed",
  });
}

export type CommandMutationOutcome = "accepted" | "rejected" | "unknown";

type CommandMutationOptions<T> = {
  kind: string;
  identity: unknown;
  operation: () => T;
  component?: string;
  outcome?: (result: T) => CommandMutationOutcome;
  knownNoMutation?: (error: unknown) => boolean;
};

type CommandMutationRetryOptions<T> = CommandMutationOptions<T> & {
  attempts: number;
  shouldRetry: (error: unknown, attempt: number) => boolean;
  beforeRetry?: (error: unknown, attempt: number) => void;
};

type CommandMutationIdentity = {
  operation: ReturnType<typeof commandOperationIdentity>;
  mutation: string;
  requestSha256: string;
};

export function runCommandMutation<T>(command: LooseRecord, options: CommandMutationOptions<T>): T {
  const kind = machineState(options.kind, "github_mutation");
  const mutationIdentity = {
    operation: commandOperationIdentity(command),
    mutation: kind,
    requestSha256: stableDigest(options.identity),
  };
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandMutation, {
    status: ACTION_EVENT_STATUSES.started,
    reasonCode: ACTION_EVENT_REASON_CODES.selected,
    mutation: false,
    retryable: true,
    ...(options.component ? { component: options.component } : {}),
    eventIdentity: {
      kind,
      requestSha256: mutationIdentity.requestSha256,
      outcome: "attempted",
    },
    idempotencyIdentity: mutationIdentity,
    completionReason: "mutation_attempted",
    state: "mutation_attempted",
  });

  let result: T;
  try {
    result = options.operation();
  } catch (error) {
    let outcome: CommandMutationOutcome = "unknown";
    try {
      if (options.knownNoMutation?.(error) === true) outcome = "rejected";
    } catch {
      outcome = "unknown";
    }
    try {
      recordCommandMutationOutcome(command, {
        kind,
        mutationIdentity,
        ...(options.component ? { component: options.component } : {}),
        outcome,
      });
    } catch (receiptError) {
      console.error(
        `[action-ledger] failed to record ${kind} ${outcome} outcome: ${
          receiptError instanceof Error ? receiptError.message : String(receiptError)
        }`,
      );
    }
    throw error;
  }

  let outcome: CommandMutationOutcome;
  try {
    outcome = options.outcome?.(result) ?? "accepted";
  } catch (error) {
    recordCommandMutationOutcome(command, {
      kind,
      mutationIdentity,
      ...(options.component ? { component: options.component } : {}),
      outcome: "unknown",
    });
    throw error;
  }
  recordCommandMutationOutcome(command, {
    kind,
    mutationIdentity,
    ...(options.component ? { component: options.component } : {}),
    outcome,
  });
  return result;
}

export function runCommandMutationWithRetry<T>(
  command: LooseRecord,
  options: CommandMutationRetryOptions<T>,
): T {
  const { attempts, shouldRetry, beforeRetry, ...mutationOptions } = options;
  const attemptCount = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    try {
      return runCommandMutation(command, mutationOptions);
    } catch (error) {
      lastError = error;
      if (attempt >= attemptCount || !shouldRetry(error, attempt)) throw error;
      beforeRetry?.(error, attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function runCommandLifecycleMutation<T>(
  input: CommandLifecycleInput,
  options: CommandMutationOptions<T>,
): T {
  return runCommandMutation(lifecycleCommand(input), options);
}

function recordCommandMutationOutcome(
  command: LooseRecord,
  options: {
    kind: string;
    mutationIdentity: CommandMutationIdentity;
    component?: string;
    outcome: CommandMutationOutcome;
  },
): void {
  const chain = commandEventChain(command);
  if (options.outcome !== "rejected") chain.mutationObserved = true;
  if (options.outcome === "unknown") chain.uncertainMutationObserved = true;
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandMutation, {
    status:
      options.outcome === "accepted"
        ? ACTION_EVENT_STATUSES.executed
        : options.outcome === "rejected"
          ? ACTION_EVENT_STATUSES.skipped
          : ACTION_EVENT_STATUSES.failed,
    reasonCode:
      options.outcome === "accepted"
        ? ACTION_EVENT_REASON_CODES.completed
        : options.outcome === "rejected"
          ? ACTION_EVENT_REASON_CODES.notApplicable
          : ACTION_EVENT_REASON_CODES.unavailable,
    mutation: options.outcome !== "rejected",
    retryable: options.outcome === "unknown",
    ...(options.component ? { component: options.component } : {}),
    eventIdentity: {
      kind: options.kind,
      requestSha256: options.mutationIdentity.requestSha256,
      outcome: options.outcome,
    },
    idempotencyIdentity: options.mutationIdentity,
    completionReason:
      options.outcome === "accepted"
        ? "mutation_accepted"
        : options.outcome === "rejected"
          ? "mutation_rejected"
          : "mutation_outcome_unknown",
    state: `mutation_${options.outcome}`,
  });
}

export function recordCommandProgress(
  input: CommandLifecycleInput,
  options: {
    state: string;
    status: "completed" | "failed" | "skipped" | "unchanged";
    mutation: boolean;
    reasonCode?: ActionEventReasonCode;
  },
): void {
  const command = lifecycleCommand(input);
  const status = ACTION_EVENT_STATUSES[options.status];
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandProgress, {
    status,
    reasonCode:
      options.reasonCode ??
      (status === ACTION_EVENT_STATUSES.completed
        ? ACTION_EVENT_REASON_CODES.completed
        : status === ACTION_EVENT_STATUSES.unchanged
          ? ACTION_EVENT_REASON_CODES.contentUnchanged
          : status === ACTION_EVENT_STATUSES.skipped
            ? ACTION_EVENT_REASON_CODES.notApplicable
            : ACTION_EVENT_REASON_CODES.exception),
    mutation: options.mutation,
    component: "command_status",
    idempotencyIdentity: options.mutation
      ? {
          operation: commandOperationIdentity(command),
          mutation: "status_comment",
          state: machineState(options.state, "unknown"),
        }
      : undefined,
    state: options.state,
  });
}

export function recordCommandRequeue(
  input: CommandLifecycleInput,
  options: {
    dispatchKey: string;
    sourceJobPath: string;
    sourceJobSha256: string;
    depth: number;
  },
): void {
  const command = lifecycleCommand(input);
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandRequeue, {
    status: ACTION_EVENT_STATUSES.requeued,
    reasonCode: ACTION_EVENT_REASON_CODES.retryScheduled,
    mutation: true,
    component: "repair_requeue",
    eventIdentity: {
      dispatchKey: options.dispatchKey,
      sourceJobPath: options.sourceJobPath,
      sourceJobSha256: options.sourceJobSha256,
      depth: options.depth,
    },
    idempotencyIdentity: {
      operation: commandOperationIdentity(command),
      mutation: "requeue_dispatch",
      dispatchKey: options.dispatchKey,
      sourceJobPath: options.sourceJobPath,
      sourceJobSha256: options.sourceJobSha256,
      depth: options.depth,
    },
    state: "requeued",
    dispatchKind: "dispatch_repair",
    queueDepth: options.depth,
  });
}

export function recordCommandLifecycleFailure(
  input: CommandLifecycleInput,
  options: { component: "command_status" | "repair_requeue"; error: unknown },
): void {
  const command = lifecycleCommand(input);
  const chain = commandEventChain(command);
  const mutation = chain.mutationObserved || chain.uncertainMutationObserved;
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandFailed, {
    status: ACTION_EVENT_STATUSES.failed,
    reasonCode: ACTION_EVENT_REASON_CODES.exception,
    mutation,
    retryable: chain.uncertainMutationObserved,
    component: options.component,
    idempotencyIdentity: mutation
      ? {
          operation: commandOperationIdentity(command),
          mutation: "command_terminal",
        }
      : undefined,
    eventIdentity: {
      errorKind: options.error instanceof Error ? options.error.name : typeof options.error,
    },
    completionReason: chain.uncertainMutationObserved
      ? "mutation_outcome_unknown"
      : mutation
        ? "mutation_observed"
        : "failed",
    state: "failed",
  });
}

export async function flushCommandActionEvents(): Promise<string[]> {
  return flushWorkflowActionEvents(commandActionLedgerRoot());
}

function recordCommandEvent(
  command: LooseRecord,
  type: string,
  options: CommandEventOptions,
): void {
  if (!workflowActionEventsEnabled()) return;
  const operationIdentity = commandOperationIdentity(command);
  const chain = commandEventChain(command);
  const phaseSeq = chain.phaseSeq + 1;
  const event = recordWorkflowActionEvent(commandActionLedgerRoot(), {
    scope: type,
    identity: {
      operation: operationIdentity,
      state: options.state ?? options.status,
      event: options.eventIdentity ?? null,
    },
    operation: "command",
    operationIdentity,
    attemptIdentity: commandAttemptIdentity(command),
    parentEventId: chain.parentEventId,
    phaseSeq,
    ...(options.idempotencyIdentity === undefined
      ? {}
      : { idempotencyIdentity: options.idempotencyIdentity }),
    type,
    component: options.component ?? "comment_router",
    subject: commandSubject(command, operationIdentity),
    action: {
      name: type,
      status: options.status,
      reasonCode: options.reasonCode,
      retryable: options.retryable ?? options.status === ACTION_EVENT_STATUSES.waiting,
      mutation: options.mutation,
    },
    attributes: {
      state: machineState(options.state ?? options.status, "unknown"),
      ...(options.completionReason
        ? { completion_reason: machineState(options.completionReason, "unknown") }
        : {}),
      ...(options.dispatchKind
        ? { dispatch_kind: machineState(options.dispatchKind, "unknown") }
        : {}),
      ...(options.queueDepth === undefined ? {} : { queue_depth: options.queueDepth }),
    },
  });
  if (!event) return;
  chain.parentEventId = event.event_id;
  chain.phaseSeq = phaseSeq;
}

function commandActionLedgerRoot(): string {
  return process.env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
}

function commandOperationIdentity(command: LooseRecord) {
  const attemptId = commandDurableAttemptId(command);
  return {
    repository: String(command.repo ?? "")
      .trim()
      .toLowerCase(),
    number: positiveInteger(command.issue_number),
    idempotencyKey: String(command.idempotency_key ?? command.comment_version_key ?? "").trim(),
    commentBodySha256: sha256OrNull(command.comment_body_sha256),
    ...(attemptId ? { attemptId } : {}),
  };
}

function commandAttemptIdentity(command: LooseRecord) {
  return {
    repository: String(process.env.GITHUB_REPOSITORY ?? "")
      .trim()
      .toLowerCase(),
    runId: String(process.env.GITHUB_RUN_ID ?? "").trim(),
    runAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT),
    action: String(process.env.GITHUB_ACTION ?? "process").trim(),
    invocation: String(process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION ?? "default").trim(),
    ...(commandDurableAttemptId(command)
      ? { durableAttemptId: commandDurableAttemptId(command) }
      : {}),
  };
}

function commandEventChain(command: LooseRecord): CommandEventChain {
  const chainKey = stableDigest({
    operationIdentity: commandOperationIdentity(command),
    attemptIdentity: commandAttemptIdentity(command),
  });
  const existing = eventChains.get(chainKey);
  if (existing) return existing;
  const created = {
    parentEventId: null,
    phaseSeq: 0,
    mutationObserved: false,
    uncertainMutationObserved: false,
  };
  eventChains.set(chainKey, created);
  return created;
}

function commandDurableAttemptId(command: LooseRecord): string | null {
  const attemptId = String(command.attempt_id ?? "").trim();
  if (!attemptId) return null;
  if (
    attemptId.length > 128 ||
    /\s/.test(attemptId) ||
    attemptId.includes(String.fromCharCode(0))
  ) {
    throw new Error("command attempt_id must be a non-empty token of at most 128 characters");
  }
  return attemptId;
}

function lifecycleCommand(input: CommandLifecycleInput): LooseRecord {
  const sourceRevision = machineRevision(input.sourceRevision);
  return {
    repo: input.repository,
    issue_number: input.number ?? null,
    idempotency_key: input.operationKey,
    comment_body_sha256: sha256OrNull(input.sourceRevision),
    expected_source_revision: sourceRevision,
    ...(input.attemptId ? { attempt_id: input.attemptId } : {}),
    status: "pending",
    actions: [],
  };
}

function commandSubject(
  command: LooseRecord,
  operationIdentity: ReturnType<typeof commandOperationIdentity>,
) {
  const sourceRevision =
    sha256OrNull(command.comment_body_sha256) ??
    machineRevision(command.expected_source_revision) ??
    machineRevision(command.target?.head_sha);
  const kind = command.target?.kind === "pull_request" ? "pull_request" : "command";
  return {
    repository: operationIdentity.repository,
    kind,
    subjectId: `command-${stableDigest(operationIdentity).slice(0, 24)}`,
    ...(operationIdentity.number ? { number: operationIdentity.number } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
  } as const;
}

function commandActions(command: LooseRecord): LooseRecord[] {
  return Array.isArray(command.actions)
    ? command.actions.filter(
        (action: JsonValue): action is LooseRecord =>
          Boolean(action) && typeof action === "object" && !Array.isArray(action),
      )
    : [];
}

function commandState(command: LooseRecord): string {
  return machineState(command.status, "unknown");
}

function machineState(value: JsonValue, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:/@+-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function machineRevision(value: JsonValue): string | null {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/.test(normalized) ? normalized : null;
}

function sha256OrNull(value: JsonValue): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function positiveInteger(value: JsonValue): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
