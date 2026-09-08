import type { ReviewPlanningDependencies } from "./clawsweeper-review-planning-dependencies.js";
import { createReviewPlanningInventory } from "./clawsweeper-review-planning-inventory.js";
import { createReviewPlanningHotIntake } from "./clawsweeper-review-planning-hot-intake.js";
import { createReviewPlanningDashboard } from "./clawsweeper-review-planning-dashboard.js";
import { createReviewPlanningSelection } from "./clawsweeper-review-planning-selection.js";

export function createReviewPlanning(dependencies: ReviewPlanningDependencies) {
  const inventory = createReviewPlanningInventory({ ...dependencies });
  const hot_intake = createReviewPlanningHotIntake({ ...dependencies, ...inventory });
  const dashboard = createReviewPlanningDashboard({ ...dependencies, ...inventory, ...hot_intake });
  const selection = createReviewPlanningSelection({
    ...dependencies,
    ...inventory,
    ...hot_intake,
    ...dashboard,
  });
  const tools = { ...inventory, ...hot_intake, ...dashboard, ...selection };
  return {
    dashboardFailedReviewRetryActivityForTest: tools.dashboardFailedReviewRetryActivityForTest,
    shardItemNumbers: tools.shardItemNumbers,
    shouldSkipScheduledHotIntakeExactReviewForTest:
      tools.shouldSkipScheduledHotIntakeExactReviewForTest,
    addDashboardCadenceBucket: tools.addDashboardCadenceBucket,
    capDashboardCadenceBucket: tools.capDashboardCadenceBucket,
    dashboardMarkdownWithFailedReviewRetryState: tools.dashboardMarkdownWithFailedReviewRetryState,
    emptyDashboardActivityStats: tools.emptyDashboardActivityStats,
    emptyDashboardCadenceBucket: tools.emptyDashboardCadenceBucket,
    emptyDashboardKindStats: tools.emptyDashboardKindStats,
    exactLocalReviewNoCandidateError: tools.exactLocalReviewNoCandidateError,
    fetchItem: tools.fetchItem,
    fetchOpenItemCounts: tools.fetchOpenItemCounts,
    fetchOpenItemNumbers: tools.fetchOpenItemNumbers,
    fetchOpenItems: tools.fetchOpenItems,
    fetchPlannedPrActivityRevisions: tools.fetchPlannedPrActivityRevisions,
    formatActivityRow: tools.formatActivityRow,
    formatCadenceBucket: tools.formatCadenceBucket,
    formatOperationActivityRow: tools.formatOperationActivityRow,
    formatPercent: tools.formatPercent,
    isCurrentForCadence: tools.isCurrentForCadence,
    isFresh: tools.isFresh,
    latestTimestamp: tools.latestTimestamp,
    planCandidates: tools.planCandidates,
    recordDashboardActivity: tools.recordDashboardActivity,
    selectCandidates: tools.selectCandidates,
    timestampMs: tools.timestampMs,
  };
}
