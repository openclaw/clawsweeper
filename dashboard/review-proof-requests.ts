import { type CommandProofScenario } from "../src/command-proof-contract.ts";
import { stableJson } from "../src/stable-json.ts";
import { validReviewProofPlan } from "../src/review-proof-plan.ts";
import { sha256Hex } from "./exact-review-direct-publication.ts";

export { REVIEW_PROOF_LIFETIME_MS } from "../src/review-proof-limits.ts";
export type ReviewProofLease = {
  itemKey: string;
  leaseId: string;
  leaseRevision: number;
  claimGeneration: number;
  runId: string;
  runAttempt: number;
  sourceHeadSha: string;
};
export type ReviewProofRequest = {
  lease: ReviewProofLease;
  operation: "request" | "poll";
  scenario: CommandProofScenario;
  proofPlan: Record<string, unknown>;
  planSha256: string;
};
export type ReviewProofRecord = {
  requestId: string;
  owner: ReviewProofLease;
  scenario: CommandProofScenario;
  proofPlan: Record<string, unknown>;
  planSha256: string;
  createdAt: number;
  expiresAt: number;
  state: "dispatch_claimed" | "pending" | "completed" | "inconclusive";
  runId?: string;
  reason?: string;
  result?: Record<string, unknown>;
  producer?: {
    workflowSha: string;
    harnessSha: string;
    workflowPath: string;
    workflowRef: "main";
    repositoryId: string;
    bodySha256: string;
    baseSha: string;
    targetBranch: string;
  };
  producerRedemption?: { runId: string; runAttempt: number };
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseReviewProofLease(value: unknown): ReviewProofLease | null {
  if (!object(value)) return null;
  if (
    typeof value.itemKey !== "string" ||
    value.itemKey.length > 200 ||
    !/^openclaw\/openclaw#[1-9][0-9]*$/.test(value.itemKey) ||
    typeof value.leaseId !== "string" ||
    !value.leaseId ||
    value.leaseId.length > 200 ||
    typeof value.runId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value.runId) ||
    typeof value.sourceHeadSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.sourceHeadSha) ||
    ![value.leaseRevision, value.claimGeneration, value.runAttempt].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0,
    )
  )
    return null;
  return {
    itemKey: value.itemKey,
    leaseId: value.leaseId,
    leaseRevision: value.leaseRevision as number,
    claimGeneration: value.claimGeneration as number,
    runId: value.runId,
    runAttempt: value.runAttempt as number,
    sourceHeadSha: value.sourceHeadSha,
  };
}
export async function parseReviewProofRequest(value: unknown): Promise<ReviewProofRequest | null> {
  if (!object(value)) return null;
  const lease = parseReviewProofLease(value.lease);
  const validPlan =
    value.scenario === "web-ui-chat-proof"
      ? object(value.proofPlan) &&
        Object.keys(value.proofPlan).length === 1 &&
        value.proofPlan.kind === "web-ui-chat-smoke"
      : value.scenario === "telegram-bot-e2e-proof" && validReviewProofPlan(value.proofPlan);
  if (
    !lease ||
    !validPlan ||
    (value.operation !== "request" && value.operation !== "poll") ||
    !object(value.proofPlan) ||
    typeof value.planSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.planSha256)
  )
    return null;
  const plan = stableJson(value.proofPlan);
  if (
    new TextEncoder().encode(plan).length > 48 * 1024 ||
    (await sha256Hex(new TextEncoder().encode(plan))) !== value.planSha256
  )
    return null;
  return {
    lease,
    operation: value.operation,
    scenario: value.scenario as CommandProofScenario,
    proofPlan: value.proofPlan,
    planSha256: value.planSha256,
  };
}
export function reviewProofOwnersMatch(a: ReviewProofLease, b: ReviewProofLease): boolean {
  return stableJson(a) === stableJson(b);
}
export async function reviewProofRequestId(request: ReviewProofRequest): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      stableJson({
        version: 1,
        owner: request.lease,
        scenario: request.scenario,
        planSha256: request.planSha256,
      }),
    ),
  );
}
