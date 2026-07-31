import { PR_RATING_LABEL_NAMES, PR_RATING_LABELS } from "./clawsweeper-policy.js";
import type {
  OverallCorrectness,
  PrRating,
  PrRatingTier,
  RealBehaviorProof,
  ReviewFinding,
  SecurityReview,
} from "./clawsweeper-types.js";

/** Classify proof quality and synthesize the single maintainer-facing PR rating. */

function screenshotProofNeedsRuntimeOutput(summary: string): boolean {
  if (
    /\b(?:no|without|absence of|zero|none)\b[^.]{0,120}\b(?:visible\s+)?(?:console|network|error|warning|violation|csp|cors)\b/i.test(
      summary,
    )
  ) {
    return true;
  }
  if (
    !/\b(?:csp|content[- ]security[- ]policy|connect-src|script-src|style-src|img-src|cors)\b/i.test(
      summary,
    )
  ) {
    return false;
  }
  return !/\b(?:devtools|developer tools|console output|console panel|network trace|network panel|network tab|terminal|logs?|live output|request|response|status code|har)\b/i.test(
    summary,
  );
}

export function normalizeRealBehaviorProof(proof: RealBehaviorProof): RealBehaviorProof {
  if (
    proof.status === "sufficient" &&
    proof.evidenceKind === "screenshot" &&
    screenshotProofNeedsRuntimeOutput(proof.summary)
  ) {
    return {
      status: "insufficient",
      summary:
        "The screenshot proof is not enough for browser runtime or security behavior; include console, network, terminal, live output, or logs showing the changed behavior after the fix.",
      evidenceKind: "screenshot",
      needsContributorAction: true,
    };
  }
  return proof;
}

function ratingIndex(tier: PrRatingTier): number {
  return ["S", "A", "B", "C", "D", "F", "NA"].indexOf(tier);
}

function lowerRatingTier(a: PrRatingTier, b: PrRatingTier): PrRatingTier {
  if (a === "NA") return b;
  if (b === "NA") return a;
  return ratingIndex(a) >= ratingIndex(b) ? a : b;
}

function proofTierFromRealBehaviorProof(proof: RealBehaviorProof): PrRatingTier {
  switch (proof.status) {
    case "sufficient":
      if (
        proof.evidenceKind === "recording" ||
        proof.evidenceKind === "screenshot" ||
        proof.evidenceKind === "linked_artifact"
      ) {
        return "S";
      }
      return "A";
    case "override":
      return "A";
    case "insufficient":
    case "mock_only":
      return "D";
    case "missing":
      return "F";
    case "not_applicable":
      return "NA";
  }
}

function patchTierFromReview(options: {
  isPullRequest: boolean;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  overallCorrectness: OverallCorrectness;
  overallConfidenceScore: number;
}): PrRatingTier {
  if (!options.isPullRequest || options.overallCorrectness === "not a patch") return "NA";
  if (options.securityReview.status === "needs_attention") return "F";
  const highestPriority = Math.min(...options.findings.map((finding) => finding.priority), 4);
  if (options.overallCorrectness === "patch is incorrect") {
    if (highestPriority <= 1) return "F";
    if (highestPriority === 2) return "D";
    return "C";
  }
  if (highestPriority <= 1) return "D";
  if (highestPriority === 2) return "C";
  if (highestPriority === 3) return "B";
  if (options.overallConfidenceScore >= 0.95) return "S";
  if (options.overallConfidenceScore >= 0.8) return "A";
  if (options.overallConfidenceScore >= 0.6) return "B";
  return "C";
}

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

function defaultRatingNextSteps(options: {
  proof: RealBehaviorProof;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  overallCorrectness: OverallCorrectness;
  overallTier: PrRatingTier;
}): string[] {
  if (options.overallTier === "S" || options.overallTier === "A" || options.overallTier === "NA") {
    return [];
  }
  const steps: string[] = [];
  if (
    options.proof.status === "missing" ||
    options.proof.status === "mock_only" ||
    options.proof.status === "insufficient"
  ) {
    steps.push(
      "Add after-fix proof from a real setup, such as a short recording, terminal output, linked artifact, or redacted logs.",
    );
  }
  if (options.securityReview.status === "needs_attention") {
    steps.push("Resolve the security review concern or explain why the changed path is safe.");
  }
  const highestPriority = Math.min(...options.findings.map((finding) => finding.priority), 4);
  if (options.overallCorrectness === "patch is incorrect" || highestPriority <= 2) {
    steps.push(
      "Address the highest-priority review finding and re-run the changed-surface validation.",
    );
  }
  if (!steps.length) {
    steps.push(
      "Tighten the PR description with what changed, how it was validated, and any remaining risk.",
    );
  }
  return steps.slice(0, 3);
}

export function normalizePrRating(rating: PrRating): PrRating {
  if (rating.overallTier === "S" || rating.overallTier === "A" || rating.overallTier === "NA") {
    return { ...rating, nextSteps: [] };
  }
  return { ...rating, nextSteps: rating.nextSteps.slice(0, 3) };
}

export function derivedPrRating(options: {
  isPullRequest: boolean;
  proof: RealBehaviorProof;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  overallCorrectness: OverallCorrectness;
  overallConfidenceScore: number;
}): PrRating {
  const proofTier = proofTierFromRealBehaviorProof(options.proof);
  const patchTier = patchTierFromReview(options);
  const overallTier =
    proofTier === "NA" && patchTier === "NA" ? "NA" : lowerRatingTier(proofTier, patchTier);
  return normalizePrRating({
    proofTier,
    patchTier,
    overallTier,
    summary:
      overallTier === "NA"
        ? "PR readiness rating is not applicable to this item."
        : "PR readiness rating was derived from proof quality, review findings, security review, and reviewer confidence.",
    nextSteps: defaultRatingNextSteps({ ...options, overallTier }),
  });
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
