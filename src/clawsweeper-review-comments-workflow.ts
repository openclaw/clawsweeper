import type { ReviewCommentWorkflowDependencies } from "./clawsweeper-review-comment-dependencies.js";
import { syncStalePullRequestReviewLabels } from "./clawsweeper-review-comment-identity.js";
import { createReviewCommentState } from "./clawsweeper-review-comment-state.js";
import { createReviewCommentPublication } from "./clawsweeper-review-comment-publication.js";
import { createReviewCommentLeases } from "./clawsweeper-review-comment-leases.js";

export function createReviewCommentWorkflow(dependencies: ReviewCommentWorkflowDependencies) {
  const state = createReviewCommentState(dependencies);
  const publication = createReviewCommentPublication({ ...dependencies, ...state });
  const leases = createReviewCommentLeases({
    ...dependencies,
    ...state,
    ...publication,
  });
  const tools = { ...state, ...publication, ...leases };
  return {
    canPatchReviewComment: tools.canPatchReviewComment,
    coverageProofRetryExhaustedRuntimeBudget: tools.coverageProofRetryExhaustedRuntimeBudget,
    isCodexReviewCommentBody: tools.isCodexReviewCommentBody,
    newReviewStartLeaseOwnerForTest: tools.newReviewStartLeaseOwnerForTest,
    recordedLabelSyncCoversUpdate: tools.recordedLabelSyncCoversUpdate,
    removeCurrentCursorTraceItem: tools.removeCurrentCursorTraceItem,
    renderReviewStartStatusComment: tools.renderReviewStartStatusComment,
    reviewArtifactDestination: tools.reviewArtifactDestination,
    reviewStartLeaseWinnerCommentIdForTest: tools.reviewStartLeaseWinnerCommentIdForTest,
    runtimeBudgetExceeded: tools.runtimeBudgetExceeded,
    shouldPreserveReviewStartLease: tools.shouldPreserveReviewStartLease,
    timeoutWithinRuntimeBudget: tools.timeoutWithinRuntimeBudget,
    withReviewStartStatusLease: tools.withReviewStartStatusLease,
    commentId: tools.commentId,
    fetchIssueReviewComments: tools.fetchIssueReviewComments,
    writeCommentPayload: tools.writeCommentPayload,
    exactReviewQueueAuthorityFromEnv: tools.exactReviewQueueAuthorityFromEnv,
    postReviewStartStatusComment: tools.postReviewStartStatusComment,
    deleteOwnedDedicatedReviewStartLease: tools.deleteOwnedDedicatedReviewStartLease,
    freshDedicatedReviewStartLeases: tools.freshDedicatedReviewStartLeases,
    issueReviewCommentState: tools.issueReviewCommentState,
    PATCHABLE_REVIEW_COMMENT_AUTHORS: tools.PATCHABLE_REVIEW_COMMENT_AUTHORS,
    staleReviewCommentSyncReason: tools.staleReviewCommentSyncReason,
    newerDurableReviewTupleVerified: tools.newerDurableReviewTupleVerified,
    reviewCommentHasCloseVerdictForCanonical: tools.reviewCommentHasCloseVerdictForCanonical,
    issueReviewComment: tools.issueReviewComment,
    markedReviewCommentBody: tools.markedReviewCommentBody,
    commentBodyMatches: tools.commentBodyMatches,
    reviewCommentHashMatches: tools.reviewCommentHashMatches,
    commentUpdatedAt: tools.commentUpdatedAt,
    reviewStartLeaseOwner: tools.reviewStartLeaseOwner,
    commentBody: tools.commentBody,
    syncStalePullRequestReviewLabels: (
      options: Parameters<typeof syncStalePullRequestReviewLabels>[0],
    ) => syncStalePullRequestReviewLabels(options, dependencies.removeIssueLabel),
    updateReviewCommentMetadata: tools.updateReviewCommentMetadata,
    upsertReviewComment: tools.upsertReviewComment,
    ensureCloseAppliedComment: tools.ensureCloseAppliedComment,
  };
}
