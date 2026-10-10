import { PR_RATING_LABEL_NAMES, PR_RATING_LABELS } from "./clawsweeper-policy.js";
import type { PrRating, PrRatingTier, RealBehaviorProof } from "./clawsweeper-types.js";

/** Label and present the PR rating that the reviewer model gives. */

export function ratingLabelForTier(tier: PrRatingTier): (typeof PR_RATING_LABELS)[number] {
  const label = PR_RATING_LABELS.find((candidate) => candidate.tier === tier);
  if (label) return label;
  return PR_RATING_LABELS[6];
}

export function themedRatingName(tier: PrRatingTier): string {
  return ratingLabelForTier(tier).name.replace(/^rating:\s*/, "");
}

export function hasShinyProof(proof: Pick<RealBehaviorProof, "status" | "evidenceKind">): boolean {
  return (
    proof.status === "sufficient" &&
    (proof.evidenceKind === "recording" ||
      proof.evidenceKind === "screenshot" ||
      proof.evidenceKind === "linked_artifact")
  );
}

export function normalizePrRating(rating: PrRating): PrRating {
  if (rating.overallTier === "S" || rating.overallTier === "A" || rating.overallTier === "NA") {
    return { ...rating, nextSteps: [] };
  }
  return { ...rating, nextSteps: rating.nextSteps.slice(0, 3) };
}

export function nextPrRatingLabels(
  labels: readonly string[],
  rating: Pick<PrRating, "overallTier">,
  reviewFailed = false,
): string[] {
  const nextLabels = labels.filter((label) => !PR_RATING_LABEL_NAMES.has(label));
  if (reviewFailed) return nextLabels;
  nextLabels.push(ratingLabelForTier(rating.overallTier).name);
  return nextLabels;
}
