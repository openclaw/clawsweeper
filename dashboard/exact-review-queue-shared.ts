import type { ExactReviewDecision } from "./exact-review-decision.ts";

const EXACT_REVIEW_SCHEDULED_HOT_SOURCE_ACTION = "scheduled_hot_intake";
const EXACT_REVIEW_SCHEDULED_NORMAL_SOURCE_ACTION = "scheduled_normal_backfill";

export type ExactReviewScheduledLane = "hot_intake" | "normal_backfill";

export function exactReviewScheduledLane(
  decision: ExactReviewDecision,
): ExactReviewScheduledLane | null {
  if (decision.sourceAction === EXACT_REVIEW_SCHEDULED_HOT_SOURCE_ACTION) return "hot_intake";
  if (decision.sourceAction === EXACT_REVIEW_SCHEDULED_NORMAL_SOURCE_ACTION) {
    return "normal_backfill";
  }
  return null;
}

export function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function numberFrom(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
