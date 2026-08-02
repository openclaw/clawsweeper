import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { trimMiddle } from "./clawsweeper-text.js";
import type { ItemKind } from "./clawsweeper-types.js";
import {
  isReviewedPrActivityCursor,
  readStableReviewedPrActivityCursor,
  ReviewedPrActivityChangedDuringReadError,
} from "./review-activity-cursor.js";

type ApplyReviewActivityDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  "fetchReviewedPrActivityCursor" | "GitHubRuntimeBudgetError"
>;

export function createApplyReviewActivityGuard(
  dependencies: ApplyReviewActivityDependencies,
  options: { expectedCursor: string | undefined; itemKind: ItemKind; number: number },
): () => string | null {
  const { fetchReviewedPrActivityCursor, GitHubRuntimeBudgetError } = dependencies;
  const { expectedCursor, itemKind, number } = options;
  return () => {
    if (itemKind !== "pull_request") return null;
    if (!isReviewedPrActivityCursor(expectedCursor)) {
      return "stored pull request review activity cursor is missing or invalid; fresh review required";
    }
    try {
      const currentCursor = readStableReviewedPrActivityCursor(() =>
        fetchReviewedPrActivityCursor(number),
      );
      if (!currentCursor) return "pull request review activity exceeds the bounded reviewed cursor";
      if (currentCursor !== expectedCursor)
        return "pull request review activity changed since review";
      return null;
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      if (error instanceof ReviewedPrActivityChangedDuringReadError) {
        return "pull request review activity changed since review";
      }
      const detail = trimMiddle(
        (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " "),
        180,
      );
      return `pull request review activity could not be refreshed; next apply will retry: ${detail}`;
    }
  };
}
