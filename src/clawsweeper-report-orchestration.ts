import type { CreateReportOrchestrationDependencies } from "./clawsweeper-report-orchestration-dependencies.js";
import { createReportRendering } from "./clawsweeper-report-rendering.js";
import { createPullRequestPromotionFacts } from "./clawsweeper-promotion-facts.js";
import { createPullRequestCoverageProof } from "./clawsweeper-coverage-proof.js";
import { createPullRequestClosePromotion } from "./clawsweeper-close-promotion.js";
import { createReportLabelPresentation } from "./clawsweeper-label-presentation.js";

export function createReportOrchestration(dependencies: CreateReportOrchestrationDependencies) {
  let reportRendering: ReturnType<typeof createReportRendering>;
  const renderingReferences = {
    renderPrRatingAssessmentReportSection: (
      ...args: Parameters<
        ReturnType<typeof createReportRendering>["renderPrRatingAssessmentReportSection"]
      >
    ) => reportRendering.renderPrRatingAssessmentReportSection(...args),
    renderRootCauseClusterAssessmentReportSection: (
      ...args: Parameters<
        ReturnType<typeof createReportRendering>["renderRootCauseClusterAssessmentReportSection"]
      >
    ) => reportRendering.renderRootCauseClusterAssessmentReportSection(...args),
  };
  const promotionFacts = createPullRequestPromotionFacts(dependencies);
  const coverageProof = createPullRequestCoverageProof({
    ...dependencies,
    ...renderingReferences,
    ...promotionFacts,
  });
  const closePromotion = createPullRequestClosePromotion({
    ...dependencies,
    ...promotionFacts,
    ...coverageProof,
  });
  const labelPresentation = createReportLabelPresentation(dependencies);
  const {
    collectItemContext,
    compactPullFilePaths,
    ensureDir,
    fileUrl,
    formatTimestamp,
    ghJson,
    ghObservedMutationCommand,
    hasUsableCloseComment,
    isImplementationCloseReason,
    isMaintainerAuthored,
    isVerifiedFixedCloseReason,
    jsonFrontMatterValue,
    linkedRelease,
    linkedSha,
    markdownLink,
    pullHeadShaFromContext,
    repairLoopPassModeFromReport,
    reviewAutomationMarkersFromReport,
    reviewStructuralPullStateFromContext,
    reviewVersionMarkerFromReport,
    ROOT,
    targetProfile,
    targetRepo,
    validateCloseDecision,
    workStatusForDecision,
  } = dependencies;
  const {
    reportDecision,
    livePullRequestHasNoDiff,
    upgradeNoDiffPullRequestReport,
    upgradePullRequestClosePromotionReport,
    authorPrBudgetPromotion,
    applyAuthorPrBudgetStateToReport,
    contextHasNonAutomationActivityAfter,
    contextHasNonAutomationActivityAfterForTest,
    duplicateCanonicalPullRequestBlockReason,
    canonicalPullRequestCommentSyncBlock,
    coveringPrCloseCoveragePullRequestSnapshotSha256,
    prCloseCoverageProofGateResult,
    applyPrCloseCoverageProofReportSection,
    applyPrCloseCoverageProofBlockedReport,
    applyClosedUnmergedCanonicalBlockedReport,
    staleCanonicalCommentSyncPendingReason,
    staleCanonicalPullRequestNumber,
    completeStaleCanonicalCommentSyncReport,
    pullRequestClosePromotion,
    workPlanPathForReport,
    shouldRenderWorkPlanFromReport,
    formattedMarkdownList,
    labelJustificationsMarkdown,
    labelTransitionJustificationsMarkdown,
    labelJustificationsMarkdownForTest,
    isClawSweeperOwnedLabel,
    labelTransitionJustificationsFromPublicReport,
    labelJustificationsFromPublicReport,
    inlineCode,
  } = {
    ...promotionFacts,
    ...coverageProof,
    ...closePromotion,
    ...labelPresentation,
  };

  reportRendering = createReportRendering({
    collectItemContext,
    compactPullFilePaths,
    ensureDir,
    fileUrl,
    formattedMarkdownList,
    formatTimestamp,
    ghJson,
    ghObservedMutationCommand,
    hasUsableCloseComment,
    inlineCode,
    isImplementationCloseReason,
    isMaintainerAuthored,
    isVerifiedFixedCloseReason,
    jsonFrontMatterValue,
    labelJustificationsFromPublicReport,
    labelJustificationsMarkdown,
    labelTransitionJustificationsFromPublicReport,
    labelTransitionJustificationsMarkdown,
    linkedRelease,
    linkedSha,
    markdownLink,
    pullHeadShaFromContext,
    repairLoopPassModeFromReport,
    reviewAutomationMarkersFromReport,
    reviewStructuralPullStateFromContext,
    reviewVersionMarkerFromReport,
    ROOT,
    shouldRenderWorkPlanFromReport,
    targetProfile,
    targetRepo,
    validateCloseDecision,
    workPlanPathForReport,
    workStatusForDecision,
  });
  const {
    closeItem,
    currentReviewRevision,
    markdownFor,
    pullRequestFilePathsFromContextForTest,
    pullRequestHeadSha,
    renderReviewCommentFromReport,
    renderReviewContextBudgetForTest,
    renderWorkPlanFromReport,
    reviewActionForDecision,
    reviewContextLedgerForTest,
    syncWorkPlanFromReport,
    updateReviewStructuralFrontMatter,
  } = reportRendering;

  return {
    applyAuthorPrBudgetStateToReport,
    applyClosedUnmergedCanonicalBlockedReport,
    applyPrCloseCoverageProofBlockedReport,
    applyPrCloseCoverageProofReportSection,
    authorPrBudgetPromotion,
    canonicalPullRequestCommentSyncBlock,
    closeItem,
    completeStaleCanonicalCommentSyncReport,
    contextHasNonAutomationActivityAfter,
    contextHasNonAutomationActivityAfterForTest,
    coveringPrCloseCoveragePullRequestSnapshotSha256,
    currentReviewRevision,
    duplicateCanonicalPullRequestBlockReason,
    isClawSweeperOwnedLabel,
    labelJustificationsMarkdownForTest,
    livePullRequestHasNoDiff,
    markdownFor,
    prCloseCoverageProofGateResult,
    pullRequestClosePromotion,
    pullRequestFilePathsFromContextForTest,
    pullRequestHeadSha,
    renderReviewCommentFromReport,
    renderReviewContextBudgetForTest,
    renderWorkPlanFromReport,
    reportDecision,
    reviewActionForDecision,
    reviewContextLedgerForTest,
    staleCanonicalCommentSyncPendingReason,
    staleCanonicalPullRequestNumber,
    syncWorkPlanFromReport,
    updateReviewStructuralFrontMatter,
    upgradeNoDiffPullRequestReport,
    upgradePullRequestClosePromotionReport,
    workPlanPathForReport,
  };
}
