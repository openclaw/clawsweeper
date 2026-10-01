import {
  verifiedGithubActionsOidcClaims,
  type GithubActionsOidcClaims,
  type GithubActionsOidcOptions,
} from "./github-actions-oidc.ts";

/**
 * Direct target-dispatcher intake. A target repository's dispatcher workflow
 * authenticates with its GitHub Actions OIDC token and sends the same
 * `clawsweeper_item` client payload it would otherwise relay through
 * `repository_dispatch`, so no ClawSweeper Actions run is spent per event.
 */
export const TARGET_DISPATCH_ENDPOINT = "https://clawsweeper.openclaw.ai/github/target-dispatch";
export const TARGET_DISPATCH_MAX_BODY_BYTES = 16 * 1024;
export const TARGET_DISPATCH_WORKFLOW_PATH = ".github/workflows/clawsweeper-dispatch.yml";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9_./-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DISPATCH_EVENTS = {
  issues: { itemKind: "issue", sourceEvent: "issues" },
  pull_request_target: { itemKind: "pull_request", sourceEvent: "pull_request" },
} as const;
// The copied dispatcher's exact field set. Router, recovery, and command fields
// stay on the HMAC-authenticated relay; a payload carrying them falls back.
const PAYLOAD_FIELDS = new Set([
  "target_repo",
  "target_branch",
  "item_number",
  "item_kind",
  "source_event",
  "source_action",
  "supersedes_in_progress",
  "queue_claim",
  "ingress_route",
  "ingress_fingerprint",
]);
const QUEUE_CLAIM_FIELDS = new Set([
  "source_head_sha",
  "source_base_sha",
  "source_is_draft",
  "source_content_revision",
  "source_updated_at",
  "review_acknowledgement_comment_id",
]);

export type TargetDispatchIdentity = {
  repository: string;
  repositoryId: string;
  eventName: keyof typeof DISPATCH_EVENTS;
  ref: string;
  runId: string;
  runAttempt: string;
};

function dispatchEventName(value: unknown): value is keyof typeof DISPATCH_EVENTS {
  return value === "issues" || value === "pull_request_target";
}

function acceptedClaims(claims: GithubActionsOidcClaims) {
  const repository = claims.repository;
  const ref = claims.ref;
  return (
    typeof repository === "string" &&
    REPO_PATTERN.test(repository) &&
    typeof claims.repository_id === "string" &&
    /^[1-9][0-9]{0,19}$/.test(claims.repository_id) &&
    dispatchEventName(claims.event_name) &&
    typeof ref === "string" &&
    ref.startsWith("refs/heads/") &&
    BRANCH_PATTERN.test(ref.slice("refs/heads/".length)) &&
    // Only the named dispatcher file, not any workflow of the repository.
    claims.workflow_ref === `${repository}/${TARGET_DISPATCH_WORKFLOW_PATH}@${ref}` &&
    (claims.job_workflow_ref === undefined || claims.job_workflow_ref === claims.workflow_ref) &&
    typeof claims.run_id === "string" &&
    /^[1-9][0-9]{0,19}$/.test(claims.run_id) &&
    typeof claims.run_attempt === "string" &&
    /^[1-9][0-9]{0,3}$/.test(claims.run_attempt)
  );
}

/** Identity of a target repository's dispatcher run on one of its own branches. */
export async function authenticateTargetDispatchToken(
  token: string,
  options: GithubActionsOidcOptions = {},
): Promise<TargetDispatchIdentity | null> {
  const claims = await verifiedGithubActionsOidcClaims(
    token,
    TARGET_DISPATCH_ENDPOINT,
    acceptedClaims,
    options,
  );
  if (!claims || !acceptedClaims(claims) || !dispatchEventName(claims.event_name)) return null;
  return {
    repository: String(claims.repository),
    repositoryId: String(claims.repository_id),
    eventName: claims.event_name,
    ref: String(claims.ref),
    runId: String(claims.run_id),
    runAttempt: String(claims.run_attempt),
  };
}

export type TargetDispatchIntake =
  | {
      ok: true;
      body: {
        delivery_id: string;
        decision: Record<string, unknown>;
        ingress?: { route: "target_dispatcher"; fingerprint: string };
      };
    }
  | { ok: false; status: 400 | 403; error: string };

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Builds the same `/enqueue` body the legacy `repository_dispatch` relay builds,
 * bound to the authenticated workflow run instead of a ClawSweeper run.
 */
export function targetDispatchQueueIntake(
  value: unknown,
  identity: TargetDispatchIdentity,
): TargetDispatchIntake {
  const payload = plainObject(value);
  if (!payload) return { ok: false, status: 400, error: "invalid_target_dispatch" };
  if (Object.keys(payload).some((key) => !PAYLOAD_FIELDS.has(key))) {
    return { ok: false, status: 400, error: "unsupported_target_dispatch_field" };
  }
  const queueClaim =
    payload.queue_claim === undefined ? {} : (plainObject(payload.queue_claim) ?? null);
  if (!queueClaim || Object.keys(queueClaim).some((key) => !QUEUE_CLAIM_FIELDS.has(key))) {
    return { ok: false, status: 400, error: "unsupported_target_dispatch_field" };
  }
  const targetRepo = typeof payload.target_repo === "string" ? payload.target_repo.trim() : "";
  const targetBranch =
    typeof payload.target_branch === "string" ? payload.target_branch.trim() : "";
  const itemNumber = payload.item_number;
  const sourceAction = payload.source_action;
  if (
    !REPO_PATTERN.test(targetRepo) ||
    !BRANCH_PATTERN.test(targetBranch) ||
    typeof itemNumber !== "number" ||
    !Number.isSafeInteger(itemNumber) ||
    itemNumber <= 0 ||
    typeof sourceAction !== "string" ||
    !/^[a-z_]{1,40}$/.test(sourceAction) ||
    (payload.supersedes_in_progress !== undefined &&
      typeof payload.supersedes_in_progress !== "boolean")
  ) {
    return { ok: false, status: 400, error: "invalid_target_dispatch" };
  }
  const event = DISPATCH_EVENTS[identity.eventName];
  // The signed workflow run, not the payload, decides which repository, event,
  // and branch this delivery may speak for.
  if (
    targetRepo.toLowerCase() !== identity.repository.toLowerCase() ||
    payload.source_event !== identity.eventName ||
    payload.item_kind !== event.itemKind ||
    identity.ref !== `refs/heads/${targetBranch}`
  ) {
    return { ok: false, status: 403, error: "target_dispatch_identity_mismatch" };
  }
  const sourceHeadSha = String(queueClaim.source_head_sha ?? "")
    .trim()
    .toLowerCase();
  const sourceBaseSha = String(queueClaim.source_base_sha ?? "")
    .trim()
    .toLowerCase();
  const sourceContentRevision = String(queueClaim.source_content_revision ?? "")
    .trim()
    .toLowerCase();
  const sourceUpdatedAt = String(queueClaim.source_updated_at ?? "").trim();
  const reviewAcknowledgementCommentId = Number(queueClaim.review_acknowledgement_comment_id);
  const ingressFingerprint = String(payload.ingress_fingerprint ?? "")
    .trim()
    .toLowerCase();
  const ingress =
    payload.ingress_route === "target_dispatcher" &&
    event.itemKind === "pull_request" &&
    DIGEST_PATTERN.test(ingressFingerprint)
      ? { route: "target_dispatcher" as const, fingerprint: ingressFingerprint }
      : undefined;
  return {
    ok: true,
    body: {
      delivery_id: `target-dispatch:${identity.repositoryId}:${identity.runId}:${identity.runAttempt}`,
      decision: {
        targetRepo,
        targetBranch,
        itemNumber,
        itemKind: event.itemKind,
        sourceEvent: event.sourceEvent,
        sourceAction,
        supersedesInProgress: payload.supersedes_in_progress === true,
        ...(SHA_PATTERN.test(sourceHeadSha) ? { sourceHeadSha } : {}),
        ...(SHA_PATTERN.test(sourceBaseSha) ? { sourceBaseSha } : {}),
        ...(typeof queueClaim.source_is_draft === "boolean"
          ? { sourceIsDraft: queueClaim.source_is_draft }
          : {}),
        ...(DIGEST_PATTERN.test(sourceContentRevision) ? { sourceContentRevision } : {}),
        ...(sourceUpdatedAt && Number.isFinite(Date.parse(sourceUpdatedAt))
          ? { sourceUpdatedAt }
          : {}),
        ...(Number.isSafeInteger(reviewAcknowledgementCommentId) &&
        reviewAcknowledgementCommentId > 0
          ? { reviewAcknowledgementCommentId }
          : {}),
      },
      ...(ingress ? { ingress } : {}),
    },
  };
}
