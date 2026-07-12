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
  eventIdentity?: unknown;
  idempotencyIdentity?: unknown;
  state?: string;
  dispatchKind?: string;
};

type CommandEventChain = {
  parentEventId: string | null;
  phaseSeq: number;
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
  recordCommandEvent(command, ACTION_EVENT_TYPES.commandFailed, {
    status: ACTION_EVENT_STATUSES.failed,
    reasonCode: ACTION_EVENT_REASON_CODES.exception,
    mutation: false,
    eventIdentity: {
      errorKind: error instanceof Error ? error.name : typeof error,
    },
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
  const chainKey = stableDigest({
    operationIdentity,
    attemptIdentity: commandAttemptIdentity(),
  });
  const chain = eventChains.get(chainKey) ?? { parentEventId: null, phaseSeq: 0 };
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
    attemptIdentity: commandAttemptIdentity(),
    parentEventId: chain.parentEventId,
    phaseSeq,
    ...(options.idempotencyIdentity === undefined
      ? {}
      : { idempotencyIdentity: options.idempotencyIdentity }),
    type,
    component: "comment_router",
    subject: commandSubject(command, operationIdentity),
    action: {
      name: type,
      status: options.status,
      reasonCode: options.reasonCode,
      retryable: options.status === ACTION_EVENT_STATUSES.waiting,
      mutation: options.mutation,
    },
    attributes: {
      state: machineState(options.state ?? options.status, "unknown"),
      ...(options.dispatchKind
        ? { dispatch_kind: machineState(options.dispatchKind, "unknown") }
        : {}),
    },
  });
  if (!event) return;
  eventChains.set(chainKey, { parentEventId: event.event_id, phaseSeq });
}

function commandActionLedgerRoot(): string {
  return process.env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
}

function commandOperationIdentity(command: LooseRecord) {
  return {
    repository: String(command.repo ?? "")
      .trim()
      .toLowerCase(),
    number: positiveInteger(command.issue_number),
    idempotencyKey: String(command.idempotency_key ?? command.comment_version_key ?? "").trim(),
    commentBodySha256: sha256OrNull(command.comment_body_sha256),
  };
}

function commandAttemptIdentity() {
  return {
    repository: String(process.env.GITHUB_REPOSITORY ?? "")
      .trim()
      .toLowerCase(),
    runId: String(process.env.GITHUB_RUN_ID ?? "").trim(),
    runAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT),
    invocation: String(process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION ?? "default").trim(),
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
