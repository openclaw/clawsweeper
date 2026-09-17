import { normalizePublicReviewFailure } from "../src/review-failure-explanation.ts";
import { stableJson } from "../src/stable-json.ts";
import { stableExactReviewFailureFingerprint } from "./exact-review-failure-telemetry.ts";
import type { ExactReviewQueueItem } from "./exact-review-queue.ts";

/** Includes command address and source identity; never exported in public references. */
export function reviewFailureDecisionFingerprint(decision: ExactReviewQueueItem["decision"]) {
  return stableExactReviewFailureFingerprint(stableJson(decision));
}

export function currentReviewFailure(item: ExactReviewQueueItem) {
  return item.reviewFailure !== undefined &&
    typeof item.reviewFailureDecisionFingerprint === "string" &&
    !item.terminalFinalization &&
    item.reviewFailureDecisionFingerprint === reviewFailureDecisionFingerprint(item.decision)
    ? normalizePublicReviewFailure(item.reviewFailure)
    : null;
}

export function clearStaleReviewFailure(item: ExactReviewQueueItem) {
  const failure = currentReviewFailure(item);
  if (failure) item.reviewFailure = failure;
  else {
    delete item.reviewFailure;
    delete item.reviewFailureDecisionFingerprint;
  }
}
