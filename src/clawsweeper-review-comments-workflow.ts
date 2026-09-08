import type { ReviewCommentWorkflowDependencies } from "./clawsweeper-review-comment-dependencies.js";
import { createReviewCommentIdentity } from "./clawsweeper-review-comment-identity.js";
import { createReviewCommentAutomation } from "./clawsweeper-review-comment-automation.js";
import { createReviewCommentState } from "./clawsweeper-review-comment-state.js";
import { createReviewCommentPublication } from "./clawsweeper-review-comment-publication.js";
import { createReviewCommentLeases } from "./clawsweeper-review-comment-leases.js";

export function createReviewCommentWorkflow(dependencies: ReviewCommentWorkflowDependencies) {
  const identity = createReviewCommentIdentity({ ...dependencies });
  const automation = createReviewCommentAutomation({ ...dependencies, ...identity });
  const state = createReviewCommentState({ ...dependencies, ...identity });
  const publication = createReviewCommentPublication({ ...dependencies, ...identity, ...state });
  const leases = createReviewCommentLeases({
    ...dependencies,
    ...identity,
    ...state,
    ...publication,
  });
  const tools = { ...identity, ...automation, ...state, ...publication, ...leases };
  return {
    canPatchReviewComment: tools.canPatchReviewComment,
    coverageProofRetryExhaustedRuntimeBudget: tools.coverageProofRetryExhaustedRuntimeBudget,
    isCodexReviewCommentBody: tools.isCodexReviewCommentBody,
    lockedConversationApplyReason: tools.lockedConversationApplyReason,
    newReviewStartLeaseOwnerForTest: tools.newReviewStartLeaseOwnerForTest,
    recordedLabelSyncCoversUpdate: tools.recordedLabelSyncCoversUpdate,
    removeCurrentCursorTraceItem: tools.removeCurrentCursorTraceItem,
    renderReviewStartStatusComment: tools.renderReviewStartStatusComment,
    reviewArtifactDestination: tools.reviewArtifactDestination,
    reviewAutomationMarkersFromReport: tools.reviewAutomationMarkersFromReport,
    reviewStartLeaseWinnerCommentIdForTest: tools.reviewStartLeaseWinnerCommentIdForTest,
    runtimeBudgetExceeded: tools.runtimeBudgetExceeded,
    shouldPreserveReviewStartLease: tools.shouldPreserveReviewStartLease,
    timeoutWithinRuntimeBudget: tools.timeoutWithinRuntimeBudget,
    withReviewStartStatusLease: tools.withReviewStartStatusLease,
    commentId: tools.commentId,
    pullHeadShaFromContext: tools.pullHeadShaFromContext,
    fetchIssueReviewComments: tools.fetchIssueReviewComments,
    reviewLeaseRevisionFromReport: tools.reviewLeaseRevisionFromReport,
    pullHeadShaFromReport: tools.pullHeadShaFromReport,
    writeCommentPayload: tools.writeCommentPayload,
    repairLoopPassModeFromReport: tools.repairLoopPassModeFromReport,
    reviewVersionMarkerFromReport: tools.reviewVersionMarkerFromReport,
    reviewStructuralPullStateFromContext: tools.reviewStructuralPullStateFromContext,
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
    freshPullRequestReviewHead: tools.freshPullRequestReviewHead,
    stalePullRequestReviewHead: tools.stalePullRequestReviewHead,
    syncStalePullRequestReviewLabels: tools.syncStalePullRequestReviewLabels,
    stalePullRequestReviewComment: tools.stalePullRequestReviewComment,
    updateReviewCommentMetadata: tools.updateReviewCommentMetadata,
    upsertReviewComment: tools.upsertReviewComment,
    ensureCloseAppliedComment: tools.ensureCloseAppliedComment,
  };
}
