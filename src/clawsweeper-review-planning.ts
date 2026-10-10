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
    dashboardMarkdownWithFailedReviewRetryState: tools.dashboardMarkdownWithFailedReviewRetryState,
    exactLocalReviewNoCandidateError: tools.exactLocalReviewNoCandidateError,
    fetchItem: tools.fetchItem,
    fetchOpenItemCounts: tools.fetchOpenItemCounts,
    fetchOpenItemNumbers: tools.fetchOpenItemNumbers,
    fetchOpenItems: tools.fetchOpenItems,
    fetchPlannedPrActivityRevisions: tools.fetchPlannedPrActivityRevisions,
    isCurrentForCadence: tools.isCurrentForCadence,
    isFresh: tools.isFresh,
    planCandidates: tools.planCandidates,
    selectCandidates: tools.selectCandidates,
  };
}
