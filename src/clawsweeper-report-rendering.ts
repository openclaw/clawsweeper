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
  const {
    OWNED_REVIEW_SECTION_HEADINGS,
    closeItem,
    collapsedDetailsBlock,
    currentReviewRevision,
    markdownFor,
    pullRequestFilePathsFromContextForTest,
    pullRequestHeadSha,
    pullRequestReviewReadinessFromReport,
    renderCloseCommentFromReport,
    renderLiveProofReportSection,
    renderPrRatingAssessmentReportSection,
    renderReviewCommentFromReport,
    renderReviewContextBudgetForTest,
    renderRootCauseClusterAssessmentReportSection,
    renderWorkPlanFromReport,
    reviewActionForDecision,
    reviewContextLedgerForTest,
    reviewHistoryForStaleComment,
    sanitizePublicSelfReferences,
    securitySensitiveRepairAllowed,
    syncWorkPlanFromReport,
    updateReviewStructuralFrontMatter,
  } = { ...context, ...commentHelpers, ...commentPresentation, ...actions, ...document };

  return {
    OWNED_REVIEW_SECTION_HEADINGS,
    closeItem,
    collapsedDetailsBlock,
    currentReviewRevision,
    markdownFor,
    pullRequestFilePathsFromContextForTest,
    pullRequestHeadSha,
    pullRequestReviewReadinessFromReport,
    renderCloseCommentFromReport,
    renderLiveProofReportSection,
    renderPrRatingAssessmentReportSection,
    renderReviewCommentFromReport,
    renderReviewContextBudgetForTest,
    renderRootCauseClusterAssessmentReportSection,
    renderWorkPlanFromReport,
    reviewActionForDecision,
    reviewContextLedgerForTest,
    reviewHistoryForStaleComment,
    sanitizePublicSelfReferences,
    securitySensitiveRepairAllowed,
    syncWorkPlanFromReport,
    updateReviewStructuralFrontMatter,
  };
}
