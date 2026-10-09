import { AUTHORITY_CHAIN_PROOF_MARKER, PROOF_OVERRIDE_LABEL } from "./clawsweeper-policy.js";
import type { RealBehaviorProof } from "./clawsweeper-types.js";
import type { AttachedLiveVerification } from "./live-proof/verification.js";
import { frontMatterStringArray, frontMatterValue } from "./report-front-matter.js";

export interface RealBehaviorProofPolicy {
  readonly assessment: RealBehaviorProof;
  readonly required: boolean;
  readonly proofBlocksMerge: boolean;
  readonly verificationBlocksMerge: boolean;
  readonly needsContributorAction: boolean;
  readonly blocksMerge: boolean;
}

interface ProofPolicyDependencies {
  isExternalPullRequestReport: (markdown: string) => boolean;
  reportAttachedLiveVerification: (markdown: string) => AttachedLiveVerification;
  reportRealBehaviorProof: (markdown: string) => RealBehaviorProof;
  reviewSectionValue: (markdown: string, key: "realBehaviorProof") => string;
}

export function createRealBehaviorProofPolicy(dependencies: ProofPolicyDependencies) {
  const {
    isExternalPullRequestReport,
    reportAttachedLiveVerification,
    reportRealBehaviorProof,
    reviewSectionValue,
  } = dependencies;

  return function reportRealBehaviorProofPolicy(markdown: string): RealBehaviorProofPolicy {
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
  };
}
