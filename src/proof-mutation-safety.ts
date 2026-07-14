import { createHash } from "node:crypto";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEvent,
  type ActionEventEvidence,
  type ActionEventPrivacy,
  type ActionEventSubject,
} from "./action-ledger.js";
import { recordWorkflowPhaseEvent } from "./action-ledger-runtime.js";
import { stableJson } from "./stable-json.js";

export const MAX_PROOF_CONVERSATION_ACTIVITY = 1_000;
export const MAX_PROOF_CONVERSATION_CURSOR_BYTES = 1024 * 1024;

export type ProofMutationLane = "proof_nudges" | "bot_proof";

export interface ProofMutationFreshnessSnapshot {
  headSha: string;
  reviewActivityCursor: string;
  conversationActivityCursor: string;
}

export interface ProofMutationFreshnessBlock {
  reason:
    | "head_changed"
    | "review_activity_changed"
    | "conversation_activity_changed"
    | "eligibility_changed"
    | "freshness_unavailable";
  message: string;
}

export interface ProofMutationReceiptContext {
  root: string;
  lane: ProofMutationLane;
  repository: string;
  number: number;
  headSha: string;
  component: string;
  evidence: readonly ActionEventEvidence[];
  privacy: ActionEventPrivacy;
  env?: NodeJS.ProcessEnv;
}

export interface ProofMutationReceiptAttempt {
  eventId: string | null;
  context: ProofMutationReceiptContext;
  operationIdentity: ProofMutationBusinessIdentity;
  requestAttempt: number;
  receiptIdentitySha256: string;
}

export type ProofMutationReceiptOutcome = "accepted" | "rejected" | "unknown";

interface ProofMutationBusinessIdentity {
  operation: "proof";
  lane: ProofMutationLane;
  repository: string;
  number: number;
  sourceRevision: string;
  mutationIdentitySha256: string;
}

export function createProofConversationActivityCursor(comments: readonly unknown[]): string | null {
  if (comments.length > MAX_PROOF_CONVERSATION_ACTIVITY) return null;
  const entries = comments
    .map((comment) => stableJson(compactConversationComment(comment)))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const canonical = `[${entries.join(",")}]`;
  if (Buffer.byteLength(canonical, "utf8") > MAX_PROOF_CONVERSATION_CURSOR_BYTES) return null;
  return `v1:${entries.length}:${sha256(canonical)}`;
}

export function proofMutationFreshnessBlock(
  expected: ProofMutationFreshnessSnapshot,
  current: ProofMutationFreshnessSnapshot,
): ProofMutationFreshnessBlock | null {
  if (current.headSha !== expected.headSha) {
    return {
      reason: "head_changed",
      message: "live PR head changed before the proof mutation request",
    };
  }
  if (current.reviewActivityCursor !== expected.reviewActivityCursor) {
    return {
      reason: "review_activity_changed",
      message:
        "review, inline-comment, or review-thread activity changed before the proof mutation request",
    };
  }
  if (current.conversationActivityCursor !== expected.conversationActivityCursor) {
    return {
      reason: "conversation_activity_changed",
      message: "pull request conversation activity changed before the proof mutation request",
    };
  }
  return null;
}

export function proofMutationBusinessIdentityForTest(options: {
  lane: ProofMutationLane;
  repository: string;
  number: number;
  headSha: string;
  mutationIdentity: string;
}): ProofMutationBusinessIdentity {
  return {
    operation: "proof",
    lane: options.lane,
    repository: options.repository,
    number: options.number,
    sourceRevision: options.headSha,
    mutationIdentitySha256: sha256(options.mutationIdentity),
  };
}

export function startProofMutationReceipt(options: {
  context: ProofMutationReceiptContext;
  receiptIdentity: string;
  mutationIdentity: string;
  requestAttempt: number;
}): ProofMutationReceiptAttempt {
  if (!Number.isSafeInteger(options.requestAttempt) || options.requestAttempt < 1) {
    throw new Error("proof mutation request attempt must be a positive integer");
  }
  const operationIdentity = proofMutationBusinessIdentityForTest({
    lane: options.context.lane,
    repository: options.context.repository,
    number: options.context.number,
    headSha: options.context.headSha,
    mutationIdentity: options.mutationIdentity,
  });
  const receiptIdentitySha256 = sha256(options.receiptIdentity);
  const event = recordWorkflowPhaseEvent(
    options.context.root,
    {
      phase: ACTION_EVENT_TYPES.proofStage,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: true,
      mutation: false,
      identity: {
        slot: "proof_mutation_attempt",
        requestAttempt: options.requestAttempt,
        receiptIdentitySha256,
      },
      operation: "proof",
      operationIdentity,
      phaseSeq: options.requestAttempt * 2 - 1,
      idempotencyIdentity: operationIdentity,
      component: options.context.component,
      subject: proofMutationSubject(options.context),
      evidence: options.context.evidence,
      attributes: {
        attempt: options.requestAttempt,
        action_count: 1,
        partial: true,
        completion_reason: "mutation_attempted",
        work_kind: options.context.lane,
      },
      privacy: options.context.privacy,
    },
    options.context.env ? { env: options.context.env } : {},
  );
  return {
    eventId: event?.event_id ?? null,
    context: options.context,
    operationIdentity,
    requestAttempt: options.requestAttempt,
    receiptIdentitySha256,
  };
}

export function finishProofMutationReceipt(options: {
  attempt: ProofMutationReceiptAttempt;
  outcome: ProofMutationReceiptOutcome;
}): ActionEvent | null {
  const mutation = options.outcome !== "rejected";
  return recordWorkflowPhaseEvent(
    options.attempt.context.root,
    {
      phase: ACTION_EVENT_TYPES.proofStage,
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
            ? ACTION_EVENT_REASON_CODES.mutationGuard
            : ACTION_EVENT_REASON_CODES.unavailable,
      retryable: false,
      mutation,
      identity: {
        slot: "proof_mutation_outcome",
        requestAttempt: options.attempt.requestAttempt,
        receiptIdentitySha256: options.attempt.receiptIdentitySha256,
        outcome: options.outcome,
      },
      operation: "proof",
      operationIdentity: options.attempt.operationIdentity,
      parentEventId: options.attempt.eventId,
      phaseSeq: options.attempt.requestAttempt * 2,
      idempotencyIdentity: options.attempt.operationIdentity,
      component: options.attempt.context.component,
      subject: proofMutationSubject(options.attempt.context),
      evidence: options.attempt.context.evidence,
      attributes: {
        attempt: options.attempt.requestAttempt,
        action_count: mutation ? 1 : 0,
        partial: options.outcome === "unknown",
        completion_reason:
          options.outcome === "accepted"
            ? "mutation_accepted"
            : options.outcome === "rejected"
              ? "mutation_rejected"
              : "mutation_outcome_unknown",
        work_kind: options.attempt.context.lane,
      },
      privacy: options.attempt.context.privacy,
    },
    options.attempt.context.env ? { env: options.attempt.context.env } : {},
  );
}

export function recordProofMutationReconciliation(options: {
  context: ProofMutationReceiptContext;
  mutationIdentity: string;
  parentEventId?: string | null;
  phaseSeq?: number;
}): ActionEvent | null {
  const operationIdentity = proofMutationBusinessIdentityForTest({
    lane: options.context.lane,
    repository: options.context.repository,
    number: options.context.number,
    headSha: options.context.headSha,
    mutationIdentity: options.mutationIdentity,
  });
  return recordWorkflowPhaseEvent(
    options.context.root,
    {
      phase: ACTION_EVENT_TYPES.proofStage,
      status: ACTION_EVENT_STATUSES.recovered,
      reasonCode: ACTION_EVENT_REASON_CODES.alreadyComplete,
      retryable: false,
      mutation: false,
      identity: {
        slot: "proof_mutation_reconciled",
        mutationIdentitySha256: operationIdentity.mutationIdentitySha256,
      },
      operation: "proof",
      operationIdentity,
      ...(options.parentEventId ? { parentEventId: options.parentEventId } : {}),
      phaseSeq: options.phaseSeq ?? 1,
      idempotencyIdentity: operationIdentity,
      component: options.context.component,
      subject: proofMutationSubject(options.context),
      evidence: options.context.evidence,
      attributes: {
        action_count: 0,
        partial: false,
        completion_reason: "mutation_reconciled",
        work_kind: options.context.lane,
      },
      privacy: options.context.privacy,
    },
    options.context.env ? { env: options.context.env } : {},
  );
}

export function recordProofMutationPendingReconciliation(options: {
  context: ProofMutationReceiptContext;
  mutationIdentity: string;
}): ActionEvent | null {
  const operationIdentity = proofMutationBusinessIdentityForTest({
    lane: options.context.lane,
    repository: options.context.repository,
    number: options.context.number,
    headSha: options.context.headSha,
    mutationIdentity: options.mutationIdentity,
  });
  return recordWorkflowPhaseEvent(
    options.context.root,
    {
      phase: ACTION_EVENT_TYPES.proofStage,
      status: ACTION_EVENT_STATUSES.waiting,
      reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
      retryable: false,
      mutation: false,
      identity: {
        slot: "proof_mutation_reconciliation_pending",
        mutationIdentitySha256: operationIdentity.mutationIdentitySha256,
      },
      operation: "proof",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: operationIdentity,
      component: options.context.component,
      subject: proofMutationSubject(options.context),
      evidence: options.context.evidence,
      attributes: {
        action_count: 0,
        partial: true,
        completion_reason: "mutation_reconciliation_pending",
        work_kind: options.context.lane,
      },
      privacy: options.context.privacy,
    },
    options.context.env ? { env: options.context.env } : {},
  );
}

function proofMutationSubject(context: ProofMutationReceiptContext): ActionEventSubject {
  return {
    repository: context.repository,
    kind: "pull_request",
    number: context.number,
    sourceRevision: context.headSha,
  };
}

function compactConversationComment(value: unknown) {
  const comment = record(value);
  const user = record(comment.user);
  return {
    id: scalar(comment.id),
    user: scalar(user.login),
    author_association: scalar(comment.author_association),
    body_sha256: sha256(scalar(comment.body)),
    created_at: scalar(comment.created_at),
    updated_at: scalar(comment.updated_at ?? comment.created_at),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return stableJson(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
