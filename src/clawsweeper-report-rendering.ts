import type { CreateReportRenderingDependencies } from "./clawsweeper-report-rendering-dependencies.js";
import { createReportContextRendering } from "./clawsweeper-report-context.js";
import { createReportCommentPresentation } from "./clawsweeper-report-comment-presentation.js";
import { createReportActionRendering } from "./clawsweeper-report-actions.js";
import { createReportDocumentRendering } from "./clawsweeper-report-document.js";

export function createReportRendering(dependencies: CreateReportRenderingDependencies) {
  const context = createReportContextRendering(dependencies);
  const commentPresentation = createReportCommentPresentation(dependencies);
  const actions = createReportActionRendering(dependencies);
  const document = createReportDocumentRendering({ ...dependencies, ...context });
  const tools = { ...context, ...commentPresentation, ...actions, ...document };
  return {
    closeItem: tools.closeItem,
    currentReviewRevision: tools.currentReviewRevision,
    markdownFor: tools.markdownFor,
    pullRequestFilePathsFromContextForTest: tools.pullRequestFilePathsFromContextForTest,
    pullRequestHeadSha: tools.pullRequestHeadSha,
    renderPrRatingAssessmentReportSection: tools.renderPrRatingAssessmentReportSection,
    renderReviewCommentFromReport: tools.renderReviewCommentFromReport,
    renderReviewContextBudgetForTest: tools.renderReviewContextBudgetForTest,
    renderRootCauseClusterAssessmentReportSection:
      tools.renderRootCauseClusterAssessmentReportSection,
    renderWorkPlanFromReport: tools.renderWorkPlanFromReport,
    reviewActionForDecision: tools.reviewActionForDecision,
    reviewContextLedgerForTest: tools.reviewContextLedgerForTest,
    syncWorkPlanFromReport: tools.syncWorkPlanFromReport,
    updateReviewStructuralFrontMatter: tools.updateReviewStructuralFrontMatter,
  };
}
