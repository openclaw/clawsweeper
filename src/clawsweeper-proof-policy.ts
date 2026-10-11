import { PROOF_OVERRIDE_LABEL } from "./clawsweeper-policy.js";
import type { RealBehaviorProof } from "./clawsweeper-types.js";
import { frontMatterStringArray, frontMatterValue } from "./report-front-matter.js";
import { isExternalPullRequestReport } from "./clawsweeper-record-metadata.js";
import { reportReviewDecision } from "./report-review-decision.js";

export interface RealBehaviorProofPolicy {
  readonly assessment: RealBehaviorProof;
  readonly required: boolean;
  readonly proofBlocksMerge: boolean;
  readonly needsContributorAction: boolean;
  readonly blocksMerge: boolean;
}

export function reportRealBehaviorProofPolicy(markdown: string): RealBehaviorProofPolicy {
  const { realBehaviorProof: assessment, authorityChainProofRequired } =
    reportReviewDecision(markdown);
  const required =
    frontMatterValue(markdown, "review_status") !== "failed" &&
    !frontMatterStringArray(markdown, "labels").includes(PROOF_OVERRIDE_LABEL) &&
    (isExternalPullRequestReport(markdown) || authorityChainProofRequired);
  // The reviewer model decides when proof does not apply, for example for a docs-only PR.
  // A not-applicable status cannot clear the authority-chain proof that the model itself requires.
  const proofSatisfied =
    assessment.status === "sufficient" ||
    assessment.status === "override" ||
    (assessment.status === "not_applicable" && !authorityChainProofRequired);
  const proofBlocksMerge = required && (assessment.needsContributorAction || !proofSatisfied);
  return {
    assessment,
    required,
    proofBlocksMerge,
    needsContributorAction:
      proofBlocksMerge &&
      (assessment.needsContributorAction || assessment.status === "not_applicable"),
    blocksMerge: proofBlocksMerge,
  };
}
