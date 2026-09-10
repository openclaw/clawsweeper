import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { trimMiddle } from "./clawsweeper-text.js";
import type { ItemKind } from "./clawsweeper-types.js";
import {
  compareReviewedPrActivityCursors,
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
    const observedCursors: Array<string | null> = [];
    const recordDrift = (reason: "changed" | "unstable") => {
      const diagnosticCursor = (cursor: string | null) =>
        cursor && cursor.length <= 80 && isReviewedPrActivityCursor(cursor) ? cursor : null;
      console.error(
        JSON.stringify({
          event: "reviewed_pr_activity_cursor_drift",
          number,
          reason,
          expected_cursor: diagnosticCursor(expectedCursor),
          observed_cursors: observedCursors.map(diagnosticCursor),
        }),
      );
      return "pull request review activity changed since review";
    };
    try {
      const currentCursor = readStableReviewedPrActivityCursor(() => {
        const cursor = fetchReviewedPrActivityCursor(number);
        observedCursors.push(cursor);
        return cursor;
      });
      if (!currentCursor) return "pull request review activity exceeds the bounded reviewed cursor";
      const comparison = compareReviewedPrActivityCursors(expectedCursor, currentCursor);
      if (comparison === "rebaseline") {
        return "stored pull request review activity cursor version requires a fresh review";
      }
      if (comparison === "changed") return recordDrift("changed");
      return null;
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      if (error instanceof ReviewedPrActivityChangedDuringReadError) {
        return recordDrift("unstable");
      }
      const detail = trimMiddle(
        (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " "),
        180,
      );
      return `pull request review activity could not be refreshed; next apply will retry: ${detail}`;
    }
  };
}
