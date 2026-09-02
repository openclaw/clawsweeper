import { AUTHORITY_CHAIN_PROOF_MARKER, PROOF_OVERRIDE_LABEL } from "./clawsweeper-policy.js";
import type { RealBehaviorProof } from "./clawsweeper-types.js";
import type { AttachedLiveVerification } from "./live-proof/verification.js";

export interface RealBehaviorProofPolicy {
  readonly assessment: RealBehaviorProof;
  readonly required: boolean;
  readonly proofBlocksMerge: boolean;
  readonly verificationBlocksMerge: boolean;
  readonly needsContributorAction: boolean;
  readonly blocksMerge: boolean;
}

interface ProofPolicyDependencies {
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  frontMatterStringArray: (markdown: string, key: string) => string[];
  isDocsOnlyPullRequestReport: (markdown: string) => boolean;
  isExternalPullRequestReport: (markdown: string) => boolean;
  reportAttachedLiveVerification: (markdown: string) => AttachedLiveVerification;
  reportRealBehaviorProof: (markdown: string) => RealBehaviorProof;
  reviewSectionValue: (markdown: string, key: "realBehaviorProof") => string;
}

export function createRealBehaviorProofPolicy(dependencies: ProofPolicyDependencies) {
  const {
    frontMatterValue,
    frontMatterStringArray,
    isDocsOnlyPullRequestReport,
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
      !isDocsOnlyPullRequestReport(markdown) &&
      (isExternalPullRequestReport(markdown) || authorityChainProofRequired);
    const proofBlocksMerge =
      required &&
      (assessment.needsContributorAction ||
        (assessment.status !== "sufficient" && assessment.status !== "override"));
    return {
      assessment,
      required,
      proofBlocksMerge,
      verificationBlocksMerge,
      // N/A cannot exempt applicable PRs. Receipt failures remain maintainer-owned.
      needsContributorAction:
        proofBlocksMerge &&
        (assessment.needsContributorAction || assessment.status === "not_applicable"),
      blocksMerge: proofBlocksMerge || verificationBlocksMerge,
    };
  };
}
