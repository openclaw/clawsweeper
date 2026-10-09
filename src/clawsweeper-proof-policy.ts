import { AUTHORITY_CHAIN_PROOF_MARKER, PROOF_OVERRIDE_LABEL } from "./clawsweeper-policy.js";
import type { RealBehaviorProof } from "./clawsweeper-types.js";
import { frontMatterStringArray, frontMatterValue } from "./report-front-matter.js";
import { isExternalPullRequestReport, reviewSectionValue } from "./clawsweeper-record-metadata.js";
import {
  reportAttachedLiveVerification,
  reportRealBehaviorProof,
} from "./clawsweeper-report-parser.js";

export interface RealBehaviorProofPolicy {
  readonly assessment: RealBehaviorProof;
  readonly required: boolean;
  readonly proofBlocksMerge: boolean;
  readonly verificationBlocksMerge: boolean;
  readonly needsContributorAction: boolean;
  readonly blocksMerge: boolean;
}

export function reportRealBehaviorProofPolicy(markdown: string): RealBehaviorProofPolicy {
  const assessment = reportRealBehaviorProof(markdown);
  const attached = reportAttachedLiveVerification(markdown);
  const verificationBlocksMerge = attached.status === "failed" || attached.status === "malformed";
  const authorityChainProofRequired = reviewSectionValue(markdown, "realBehaviorProof")
    .split("\n")
    .some((line) => line.trimStart().startsWith(`Summary: ${AUTHORITY_CHAIN_PROOF_MARKER}`));
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
    verificationBlocksMerge,
    // Receipt failures remain maintainer-owned.
    needsContributorAction:
      proofBlocksMerge &&
      (assessment.needsContributorAction || assessment.status === "not_applicable"),
    blocksMerge: proofBlocksMerge || verificationBlocksMerge,
  };
}
