import type { Assessment } from "../../scripts/attention.ts";

export function assessmentReviewAge(reviewedAt: string | null, asOf: string | null): string {
  const reviewed = reviewedAt ? Date.parse(reviewedAt) : NaN;
  const snapshot = asOf ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(reviewed) || !Number.isFinite(snapshot) || reviewed > snapshot)
    return "Age unknown";
  const days = Math.floor((snapshot - reviewed) / 86_400_000);
  return days ? days + "d old at snapshot" : "Less than 1d old at snapshot";
}

// Semantic content for shared rows; layout and responsive placement belong to ItemTable.
export function assessmentEvidence(assessment?: Assessment | null) {
  if (!assessment)
    return {
      state: "Classification unavailable",
      source: "Legacy record · current source not verified",
      review: "Review evidence unavailable",
    };
  const state = {
    open_at_review: "Open at review",
    observed_open: "Recorded open",
    historical: "Historical · closed/archived",
    unknown: "Item state unknown",
  }[assessment.lifecycle];
  const source = {
    reviewed_snapshot: "Reviewed source · current validity unknown",
    changed: "Source changed · needs re-verification",
    unknown: "Source validity unknown",
  }[assessment.sourceValidity];
  return {
    state,
    source,
    review:
      assessment.reviewStatus === "complete"
        ? "Completed review · reviewer flags are not independently verified"
        : assessment.reviewStatus === "incomplete"
          ? "Review incomplete or stale"
          : "Review completion unknown",
  };
}
