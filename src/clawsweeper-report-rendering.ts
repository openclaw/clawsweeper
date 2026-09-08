import type { CreateReportRenderingDependencies } from "./clawsweeper-report-rendering-dependencies.js";
import { createReportContextRendering } from "./clawsweeper-report-context.js";
import { createReportCommentHelpers } from "./clawsweeper-report-comment-helpers.js";
import { createReportCommentPresentation } from "./clawsweeper-report-comment-presentation.js";
import { createReportActionRendering } from "./clawsweeper-report-actions.js";
import { createReportDocumentRendering } from "./clawsweeper-report-document.js";

export function createReportRendering(dependencies: CreateReportRenderingDependencies) {
  const context = createReportContextRendering(dependencies);
  const commentHelpers = createReportCommentHelpers({ ...dependencies, ...context });
  const commentPresentation = createReportCommentPresentation({
    ...dependencies,
    ...context,
    ...commentHelpers,
  });
  const actions = createReportActionRendering({ ...dependencies, ...context, ...commentHelpers });
  const document = createReportDocumentRendering({
    ...dependencies,
    ...context,
    ...commentHelpers,
  });
  const tools = { ...context, ...commentHelpers, ...commentPresentation, ...actions, ...document };
  return {
    OWNED_REVIEW_SECTION_HEADINGS: tools.OWNED_REVIEW_SECTION_HEADINGS,
    closeItem: tools.closeItem,
    collapsedDetailsBlock: tools.collapsedDetailsBlock,
    currentReviewRevision: tools.currentReviewRevision,
    markdownFor: tools.markdownFor,
    pullRequestFilePathsFromContextForTest: tools.pullRequestFilePathsFromContextForTest,
    pullRequestHeadSha: tools.pullRequestHeadSha,
    pullRequestReviewReadinessFromReport: tools.pullRequestReviewReadinessFromReport,
    renderCloseCommentFromReport: tools.renderCloseCommentFromReport,
    renderLiveProofReportSection: tools.renderLiveProofReportSection,
    renderPrRatingAssessmentReportSection: tools.renderPrRatingAssessmentReportSection,
    renderReviewCommentFromReport: tools.renderReviewCommentFromReport,
    renderReviewContextBudgetForTest: tools.renderReviewContextBudgetForTest,
    renderRootCauseClusterAssessmentReportSection:
      tools.renderRootCauseClusterAssessmentReportSection,
    renderWorkPlanFromReport: tools.renderWorkPlanFromReport,
    reviewActionForDecision: tools.reviewActionForDecision,
    reviewContextLedgerForTest: tools.reviewContextLedgerForTest,
    reviewHistoryForStaleComment: tools.reviewHistoryForStaleComment,
    sanitizePublicSelfReferences: tools.sanitizePublicSelfReferences,
    securitySensitiveRepairAllowed: tools.securitySensitiveRepairAllowed,
    syncWorkPlanFromReport: tools.syncWorkPlanFromReport,
    updateReviewStructuralFrontMatter: tools.updateReviewStructuralFrontMatter,
  };
}
