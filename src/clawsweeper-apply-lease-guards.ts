import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { trimMiddle } from "./clawsweeper-text.js";
import type { AcquiredReviewStartLease, Item } from "./clawsweeper-types.js";
import { freshExactHeadReviewStartLease } from "./repair/comment-router-core.js";

type ActiveApplyMutationLease = { itemNumber: number; lease: AcquiredReviewStartLease } | null;

type ApplyLeaseGuardDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "asRecord"
  | "frontMatterValue"
  | "ghJson"
  | "GitHubRuntimeBudgetError"
  | "issueReviewCommentState"
  | "liveIssueSourceRevision"
  | "PATCHABLE_REVIEW_COMMENT_AUTHORS"
  | "postReviewStartStatusComment"
  | "reviewLeaseRevisionFromReport"
  | "shouldPreserveReviewStartLease"
  | "targetRepo"
> & {
  canonicalBoundStaleReviewReason: (
    markdown: string,
    comment: Record<string, unknown> | undefined,
  ) => string | null;
  closeDelayMs: number;
  currentReviewActivityBlock: () => string | null;
  dryRun: boolean;
  getActiveApplyMutationLease: () => ActiveApplyMutationLease;
  initialReviewHeadSha: string;
  item: Item;
  markdownBeforeApplyDecisionMutations: string;
  number: number;
  reportReviewRevision: string | null;
  requiresApplyMutationLease: boolean;
  setActiveApplyMutationLease: (lease: ActiveApplyMutationLease) => void;
};

export function createApplyLeaseGuards({
  asRecord,
  canonicalBoundStaleReviewReason,
  closeDelayMs,
  currentReviewActivityBlock,
  dryRun,
  frontMatterValue,
  getActiveApplyMutationLease,
  ghJson,
  GitHubRuntimeBudgetError,
  initialReviewHeadSha,
  issueReviewCommentState,
  item,
  liveIssueSourceRevision,
  markdownBeforeApplyDecisionMutations,
  number,
  PATCHABLE_REVIEW_COMMENT_AUTHORS,
  postReviewStartStatusComment,
  reportReviewRevision,
  requiresApplyMutationLease,
  reviewLeaseRevisionFromReport,
  setActiveApplyMutationLease,
  shouldPreserveReviewStartLease,
  targetRepo,
}: ApplyLeaseGuardDependencies) {
  const reviewStartLeaseStateForComments = (
    leaseComments: Record<string, unknown>[],
    reviewComment: Record<string, unknown> | undefined,
    headSha: string,
  ) => {
    const lease = freshExactHeadReviewStartLease({
      comments: leaseComments,
      itemNumber: number,
      headSha,
      trustedAuthors: new Set(
        [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
      ),
    });
    const preserve = Boolean(
      lease &&
      shouldPreserveReviewStartLease({
        currentHeadSha: headSha,
        reportHeadSha:
          reviewLeaseRevisionFromReport(markdownBeforeApplyDecisionMutations) ?? undefined,
        reportLeaseOwner: frontMatterValue(
          markdownBeforeApplyDecisionMutations,
          "review_lease_owner",
        ),
        reportLeaseCommentId: frontMatterValue(
          markdownBeforeApplyDecisionMutations,
          "review_lease_comment_id",
        ),
        leaseOwner: lease.owner,
        leaseCommentId: lease.commentId,
      }),
    );
    // A matching report tuple deliberately returns `preserve: false`: the exact publisher
    // adopts that completed review lease as its mutation lock. Any different or incomplete
    // live lease remains preserved and blocks the older artifact.
    return {
      comment: reviewComment,
      leaseComments,
      headSha,
      lease,
      preserve,
      blockReason: null as string | null,
    };
  };

  const fetchLiveReviewHeadSha = (): string => {
    if (item.kind !== "pull_request") return liveIssueSourceRevision(number);
    const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
    const sha = asRecord(pull.head).sha;
    return typeof sha === "string" ? sha.trim().toLowerCase() : "";
  };

  const refreshReviewStartLeaseState = () => {
    try {
      const headBefore = fetchLiveReviewHeadSha();
      const refreshed = issueReviewCommentState(number);
      const headAfter = fetchLiveReviewHeadSha();
      if (!headBefore || headBefore !== headAfter || headAfter !== initialReviewHeadSha) {
        return {
          comment: refreshed.reviewComment,
          comments: refreshed.comments,
          leaseComments: refreshed.leaseComments,
          headSha: headAfter,
          lease: null,
          preserve: false,
          blockReason: `${item.kind === "pull_request" ? "PR head" : "issue source revision"} changed since context capture or during the apply-time review lease check; next apply will retry`,
        };
      }
      if (item.kind === "issue" && reportReviewRevision && headAfter !== reportReviewRevision) {
        return {
          comment: refreshed.reviewComment,
          comments: refreshed.comments,
          leaseComments: refreshed.leaseComments,
          headSha: headAfter,
          lease: null,
          preserve: false,
          blockReason: `live issue source revision ${headAfter} differs from reviewed revision ${reportReviewRevision}`,
        };
      }
      return {
        ...reviewStartLeaseStateForComments(
          refreshed.leaseComments,
          refreshed.reviewComment,
          headAfter,
        ),
        comments: refreshed.comments,
      };
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      const detail = trimMiddle(
        (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " "),
        180,
      );
      return {
        comment: undefined,
        comments: [] as Record<string, unknown>[],
        leaseComments: [],
        headSha: "",
        lease: null,
        preserve: false,
        blockReason: `apply-time review lease check failed; next apply will retry: ${detail}`,
      };
    }
  };

  const ownedApplyMutationLeaseBlockReason = (lease: AcquiredReviewStartLease): string | null => {
    try {
      const reviewActivityBlock = currentReviewActivityBlock();
      if (reviewActivityBlock) return reviewActivityBlock;
      const revisionBefore = fetchLiveReviewHeadSha();
      const refreshed = issueReviewCommentState(number);
      const revisionAfter = fetchLiveReviewHeadSha();
      if (
        !revisionBefore ||
        revisionBefore !== revisionAfter ||
        revisionAfter !== initialReviewHeadSha ||
        (item.kind === "issue" &&
          reportReviewRevision !== null &&
          revisionAfter !== reportReviewRevision)
      ) {
        return `${item.kind === "pull_request" ? "PR head" : "issue source revision"} changed while holding the apply mutation lease`;
      }
      const winner = freshExactHeadReviewStartLease({
        comments: refreshed.leaseComments,
        itemNumber: number,
        headSha: revisionAfter,
        trustedAuthors: new Set(
          [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
        ),
      });
      if (
        winner?.owner !== lease.owner ||
        winner.commentId !== lease.commentId ||
        lease.headSha !== revisionAfter
      ) {
        return `apply mutation lease ${lease.commentId} is no longer the elected ${item.kind === "pull_request" ? "same-head" : "same-revision"} lease`;
      }
      return canonicalBoundStaleReviewReason(
        markdownBeforeApplyDecisionMutations,
        refreshed.reviewComment,
      );
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      const detail = trimMiddle(
        (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " "),
        180,
      );
      return `apply mutation lease verification failed; next apply will retry: ${detail}`;
    }
  };

  const acquireApplyMutationLease = (
    leaseState: ReturnType<typeof refreshReviewStartLeaseState>,
  ): string | null => {
    if (dryRun || !requiresApplyMutationLease) return null;
    let lease: AcquiredReviewStartLease | null = null;
    if (leaseState.lease && !leaseState.preserve) {
      if (!leaseState.lease.owner || leaseState.lease.commentId === null) {
        return "matching review lease lacks a server-confirmed owner and comment id";
      }
      lease = {
        owner: leaseState.lease.owner,
        commentId: leaseState.lease.commentId,
        headSha: leaseState.headSha,
      };
    } else {
      const posted = postReviewStartStatusComment({
        item,
        headSha: leaseState.headSha,
        reviewTimeoutMs: Math.max(5 * 60 * 1000, closeDelayMs + 60 * 1000),
        position: 1,
        total: 1,
        shardIndex: 1,
        shardCount: 1,
        purpose: "apply",
      });
      if (posted.status !== "posted") {
        return `${item.kind === "pull_request" ? "same-head" : "same-revision"} ClawSweeper lease was acquired concurrently`;
      }
      lease = posted.lease;
    }
    setActiveApplyMutationLease({ itemNumber: number, lease });
    return ownedApplyMutationLeaseBlockReason(lease);
  };

  const currentApplyMutationLeaseBlockReason = (): string | null => {
    const reviewActivityBlock = currentReviewActivityBlock();
    if (reviewActivityBlock) return reviewActivityBlock;
    if (dryRun || !requiresApplyMutationLease) return null;
    const active = getActiveApplyMutationLease();
    if (!active || active.itemNumber !== number) return "apply mutation lease is not held";
    return ownedApplyMutationLeaseBlockReason(active.lease);
  };

  return {
    acquireApplyMutationLease,
    currentApplyMutationLeaseBlockReason,
    refreshReviewStartLeaseState,
  };
}
