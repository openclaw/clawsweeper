import { numberArg, stringArg, type Args } from "./clawsweeper-args.js";
import type {
  AcquiredReviewStartLease,
  ReviewStartStatusCommentResult,
} from "./clawsweeper-types.js";
import { UserFacingCommandError } from "./command.js";

export function isBackgroundReviewDecision(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const decision = value as Record<string, unknown>;
  if (
    decision.commandStatusMarker ||
    decision.statusCommentId ||
    decision.sourceCommentId ||
    decision.publicationPolicy
  )
    return false;
  return new Set([
    "scheduled_hot_intake",
    "scheduled_normal_backfill",
    "source_drift_requeue",
    "failed_review_shard_recovery",
    "artifact_retention_recovery",
    "review_placeholder_recovery",
    "opened",
    "edited",
    "reopened",
    "labeled",
    "unlabeled",
    "synchronize",
    "ready_for_review",
  ]).has(String(decision.sourceAction));
}

export function backgroundReviewFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.COMMAND_STATUS_MARKER) return false;
  if (env.EXACT_REVIEW_DECISION)
    return isBackgroundReviewDecision(JSON.parse(env.EXACT_REVIEW_DECISION));
  return false;
}

export function suppliedReviewStartLeaseFromArgs(
  args: Args,
): Pick<AcquiredReviewStartLease, "owner" | "commentId"> | null {
  const owner = stringArg(args.review_lease_owner, "").trim();
  const commentId = numberArg(args.review_lease_comment_id, 0);
  if (!owner && commentId === 0) return null;
  if (!owner || !Number.isInteger(commentId) || commentId <= 0) {
    throw new UserFacingCommandError(
      "--review-lease-owner and --review-lease-comment-id must be supplied together.",
    );
  }
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(owner)) {
    throw new UserFacingCommandError("--review-lease-owner contains unsupported characters.");
  }
  return { owner, commentId };
}

export function isSuppliedReviewStartLease(
  supplied: Pick<AcquiredReviewStartLease, "owner" | "commentId"> | null,
  lease: Pick<AcquiredReviewStartLease, "owner" | "commentId">,
): boolean {
  return supplied?.owner === lease.owner && supplied.commentId === lease.commentId;
}

export function reviewLeaseStillMatchesContext(
  itemKind: "issue" | "pull_request",
  contextPullHeadSha: string | null,
  leaseHeadSha: string,
): boolean {
  return itemKind !== "pull_request" || contextPullHeadSha?.trim().toLowerCase() === leaseHeadSha;
}

export function heldReviewStartStatusCommentResult(
  retryAt: string,
  didMutate: boolean,
): ReviewStartStatusCommentResult {
  return { status: "held", lease: null, retryAt, didMutate };
}
