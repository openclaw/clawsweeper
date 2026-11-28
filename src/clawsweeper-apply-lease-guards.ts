import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { trimMiddle } from "./clawsweeper-text.js";
import type { AcquiredReviewStartLease, Item } from "./clawsweeper-types.js";
import { GitHubRateLimitError } from "./github-retry.js";
import { freshExactHeadReviewStartLease } from "./repair/comment-router/admission.js";
import { generationReadKey, type LiveReadGeneration } from "./live-read-generation.js";
import { asRecord } from "./value-coerce.js";
import { frontMatterValue } from "./report-front-matter.js";
import { reviewLeaseRevisionFromReport } from "./clawsweeper-record-metadata.js";

export const PULL_CLOSED_DURING_APPLY = "pull request closed during apply";
class PullClosedDuringApply extends Error {}

type ActiveApplyMutationLease = { itemNumber: number; lease: AcquiredReviewStartLease } | null;

type ApplyLeaseGuardDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "ghJson"
  | "GitHubRuntimeBudgetError"
  | "issueReviewCommentState"
  | "liveIssueSourceRevision"
  | "PATCHABLE_REVIEW_COMMENT_AUTHORS"
  | "postReviewStartStatusComment"
  | "shouldPreserveReviewStartLease"
  | "targetRepo"
> & {
  canonicalBoundStaleReviewReason: (
    markdown: string,
    comment: Record<string, unknown> | undefined,
    liveLease?: AcquiredReviewStartLease | null,
  ) => string | null;
  closeDelayMs: number;
  currentReviewActivityBlock: () => string | null;
  dryRun: boolean;
  getActiveApplyMutationLease: () => ActiveApplyMutationLease;
  expectedPullState?: () => string;
  initialReviewHeadSha: string;
  item: Item;
  liveReadGeneration?: LiveReadGeneration;
  markdownBeforeApplyDecisionMutations: string;
  number: number;
  reportReviewRevision: string | null;
  requiresApplyMutationLease: boolean;
  /** Post apply's own lease at the first item write instead of before the decision. */
  deferLeasePost?: boolean;
  setActiveApplyMutationLease: (lease: ActiveApplyMutationLease) => void;
};

export function createApplyLeaseGuards({
  canonicalBoundStaleReviewReason,
  closeDelayMs,
  currentReviewActivityBlock,
  dryRun,
  getActiveApplyMutationLease,
  ghJson,
  GitHubRuntimeBudgetError,
  expectedPullState = () => "open",
  initialReviewHeadSha,
  issueReviewCommentState,
  item,
  liveReadGeneration,
  liveIssueSourceRevision,
  markdownBeforeApplyDecisionMutations,
  number,
  PATCHABLE_REVIEW_COMMENT_AUTHORS,
  postReviewStartStatusComment,
  reportReviewRevision,
  requiresApplyMutationLease,
  deferLeasePost = false,
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
      currentLease:
        lease?.owner && lease.commentId !== null
          ? { owner: lease.owner, commentId: lease.commentId, headSha }
          : null,
      leaseComments,
      headSha,
      lease,
      preserve,
      blockReason: null as string | null,
    };
  };

  const fetchLiveReviewHeadSha = (): string => {
    if (item.kind !== "pull_request") {
      return liveIssueSourceRevision(
        number,
        liveReadGeneration
          ? { liveReadGeneration, bypassGenerationCache: true }
          : { bypassGenerationCache: true },
      );
    }
    const args = ["api", `repos/${targetRepo()}/pulls/${number}`];
    const pull = asRecord(
      liveReadGeneration
        ? liveReadGeneration.read(generationReadKey("json", args), () => ghJson<unknown>(args), {
            bypassGenerationCache: true,
          })
        : ghJson<unknown>(args),
    );
    const expected = expectedPullState();
    if (expected === "open" && pull.state === "closed") throw new PullClosedDuringApply();
    if (pull.state !== expected) {
      throw new Error(`expected PR to be ${expected}, live state is ${String(pull.state)}`);
    }
    const sha = asRecord(pull.head).sha;
    return typeof sha === "string" ? sha.trim().toLowerCase() : "";
  };

  const refreshReviewStartLeaseState = () => {
    try {
      const headBefore = fetchLiveReviewHeadSha();
      const refreshed = issueReviewCommentState(
        number,
        [],
        liveReadGeneration
          ? { liveReadGeneration, bypassGenerationCache: true }
          : { bypassGenerationCache: true },
      );
      const headAfter = fetchLiveReviewHeadSha();
      if (!headBefore || headBefore !== headAfter || headAfter !== initialReviewHeadSha) {
        return {
          comment: refreshed.reviewComment,
          comments: refreshed.comments,
          leaseComments: refreshed.leaseComments,
          headSha: headAfter,
          lease: null,
          currentLease: null,
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
          currentLease: null,
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
      if (error instanceof GitHubRuntimeBudgetError || error instanceof GitHubRateLimitError)
        throw error;
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
        currentLease: null,
        preserve: false,
        blockReason:
          error instanceof PullClosedDuringApply
            ? PULL_CLOSED_DURING_APPLY
            : `apply-time review lease check failed; next apply will retry: ${detail}`,
      };
    }
  };

  const ownedApplyMutationLeaseBlockReason = (
    lease: AcquiredReviewStartLease,
    reviewActivityChecked = false,
  ): string | null => {
    try {
      const reviewActivityBlock = reviewActivityChecked ? null : currentReviewActivityBlock();
      if (reviewActivityBlock) return reviewActivityBlock;
      const revisionBefore = fetchLiveReviewHeadSha();
      const refreshed = issueReviewCommentState(
        number,
        [],
        liveReadGeneration
          ? { liveReadGeneration, bypassGenerationCache: true }
          : { bypassGenerationCache: true },
      );
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
        lease,
      );
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError || error instanceof GitHubRateLimitError)
        throw error;
      const detail = trimMiddle(
        (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " "),
        180,
      );
      return error instanceof PullClosedDuringApply
        ? PULL_CLOSED_DURING_APPLY
        : `apply mutation lease verification failed; next apply will retry: ${detail}`;
    }
  };

  // Posting apply's own lease comment is deferred until the first item write: deleting it
  // later moves the item's updated_at with no live trace, and GitHub reads back the old
  // value right after the delete, so a visit that writes nothing must not post one.
  // openclaw/openclaw#196836 was re-reviewed hourly because every kept_open visit did.
  let deferredLeaseHeadSha: string | null = null;
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
    } else if (deferLeasePost) {
      deferredLeaseHeadSha = leaseState.headSha;
      return null;
    } else {
      return postApplyMutationLease(leaseState.headSha);
    }
    setActiveApplyMutationLease({ itemNumber: number, lease });
    return ownedApplyMutationLeaseBlockReason(lease);
  };

  const postApplyMutationLease = (headSha: string): string | null => {
    const posted = postReviewStartStatusComment({
      item,
      headSha,
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
    setActiveApplyMutationLease({ itemNumber: number, lease: posted.lease });
    return ownedApplyMutationLeaseBlockReason(posted.lease);
  };

  const currentApplyMutationLeaseBlockReason = (): string | null => {
    const reviewActivityBlock = currentReviewActivityBlock();
    if (reviewActivityBlock) return reviewActivityBlock;
    if (dryRun || !requiresApplyMutationLease) return null;
    const active = getActiveApplyMutationLease();
    // A deferred lease is posted by the mutation runner right before the first write.
    if ((!active || active.itemNumber !== number) && deferredLeaseHeadSha !== null) return null;
    if (!active || active.itemNumber !== number) return "apply mutation lease is not held";
    // The live two-read activity barrier above already ran for this boundary;
    // repeating it back to back would only add two GraphQL round trips.
    return ownedApplyMutationLeaseBlockReason(active.lease, true);
  };

  const postDeferredApplyMutationLease = (): string | null => {
    if (deferredLeaseHeadSha === null) return null;
    const headSha = deferredLeaseHeadSha;
    deferredLeaseHeadSha = null;
    return postApplyMutationLease(headSha);
  };

  return {
    acquireApplyMutationLease,
    currentApplyMutationLeaseBlockReason,
    postDeferredApplyMutationLease,
    refreshReviewStartLeaseState,
  };
}
