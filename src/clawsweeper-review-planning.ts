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
  const {
    dashboardFailedReviewRetryActivityForTest,
    shardItemNumbers,
    shouldSkipScheduledHotIntakeExactReviewForTest,
    addDashboardCadenceBucket,
    capDashboardCadenceBucket,
    dashboardMarkdownWithFailedReviewRetryState,
    emptyDashboardActivityStats,
    emptyDashboardCadenceBucket,
    emptyDashboardKindStats,
    exactLocalReviewNoCandidateError,
    fetchItem,
    fetchOpenItemCounts,
    fetchOpenItemNumbers,
    fetchOpenItems,
    fetchPlannedPrActivityRevisions,
    formatActivityRow,
    formatCadenceBucket,
    formatOperationActivityRow,
    formatPercent,
    isCurrentForCadence,
    isFresh,
    latestTimestamp,
    planCandidates,
    recordDashboardActivity,
    selectCandidates,
    timestampMs,
  } = { ...inventory, ...hot_intake, ...dashboard, ...selection };
  return {
    dashboardFailedReviewRetryActivityForTest,
    shardItemNumbers,
    shouldSkipScheduledHotIntakeExactReviewForTest,
    addDashboardCadenceBucket,
    capDashboardCadenceBucket,
    dashboardMarkdownWithFailedReviewRetryState,
    emptyDashboardActivityStats,
    emptyDashboardCadenceBucket,
    emptyDashboardKindStats,
    exactLocalReviewNoCandidateError,
    fetchItem,
    fetchOpenItemCounts,
    fetchOpenItemNumbers,
    fetchOpenItems,
    fetchPlannedPrActivityRevisions,
    formatActivityRow,
    formatCadenceBucket,
    formatOperationActivityRow,
    formatPercent,
    isCurrentForCadence,
    isFresh,
    latestTimestamp,
    planCandidates,
    recordDashboardActivity,
    selectCandidates,
    timestampMs,
  };
}
