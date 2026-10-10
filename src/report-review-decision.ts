import { isExternalPullRequestReport, reviewSectionValue } from "./clawsweeper-record-metadata.js";
import { AUTHORITY_CHAIN_PROOF_MARKER, PROOF_OVERRIDE_LABEL } from "./clawsweeper-policy.js";
import {
  impactLabelsFromReport,
  labelJustificationsFromReport,
  maturityLabelsFromReport,
  mergeRiskLabelsFromReport,
  mergeRiskOptionsFromReport,
  reportAgentsPolicyStatus,
  reportChangeExample,
  reportEvidence,
  reportFeatureShowcase,
  reportLikelyOwners,
  reportOverallConfidenceScore,
  reportOverallCorrectness,
  reportProductReview,
  reportProvenance,
  reportPrRating,
  reportRealBehaviorProof,
  reportReviewFindings,
  reportRootCauseCluster,
  reportTestingReview,
  reportSecurityReview,
  reportTelegramVisibleProof,
  selectedLabelJustifications,
  reportWorkCandidateReason,
  reviewMetricsFromReport,
  triagePriorityFromReport,
} from "./clawsweeper-report-parser.js";
import type { Decision, RealBehaviorProof } from "./clawsweeper-types.js";
import { frontMatterStringArray, frontMatterValue } from "./report-front-matter.js";
import { readReviewRecord } from "./review-record.js";
import { maintainerDecisionFromReport } from "./decision-packets.js";
import { nextStepFromReport } from "./clawsweeper-next-step.js";
import {
  fixedPullRequestFromReport,
  regressionAssessmentFromReport,
  regressionProvenanceFromReport,
} from "./clawsweeper-status-context.js";
import {
  isPublicRegressionProvenance,
  isRegressionAssessment,
  publicLikelyOwner,
} from "./clawsweeper-regression-provenance.js";
import type { PublicRegressionProvenance, RegressionAssessment } from "./clawsweeper-types.js";
import { isCommitSha, normalizeEvidence } from "./clawsweeper-links.js";

/**
 * Reviewed fields used by labels, readiness and public comments.
 * Host-owned publication metadata stays in the report.
 */
export type ReportReviewDecision = Pick<
  Decision,
  | "triagePriority"
  | "impactLabels"
  | "mergeRiskLabels"
  | "maturityLabels"
  | "labelJustifications"
  | "telegramVisibleProof"
  | "securityReview"
  | "itemCategory"
  | "reproductionStatus"
  | "reproductionConfidence"
  | "requiresNewFeature"
  | "requiresNewConfigOption"
  | "requiresProductDecision"
  | "implementationComplexity"
  | "autoImplementationCandidate"
  | "workCandidate"
  | "workConfidence"
  | "workPrompt"
  | "workValidation"
  | "workLikelyFiles"
  | "decision"
  | "closeReason"
  | "visionFit"
  | "visionFitEvidence"
  | "workPriority"
  | "workClusterRefs"
  | "confidence"
  | "summary"
  | "changeSummary"
  | "changeExample"
  | "systemContext"
  | "architectureDiagram"
  | "evidence"
  | "likelyOwners"
  | "bestSolution"
  | "reproductionAssessment"
  | "solutionAssessment"
  | "mergeRiskOptions"
  | "reviewMetrics"
  | "rootCauseCluster"
  | "productReview"
  | "provenance"
  | "testingReview"
  | "reviewFindings"
  | "realBehaviorProof"
  | "prRating"
  | "featureShowcase"
  | "overallCorrectness"
  | "overallConfidenceScore"
  | "nextStep"
  | "fixedPullRequest"
> & {
  risks: string;
  workReason: string;
  agentsPolicyStatus: Decision["agentsPolicyStatus"] | undefined;
  maintainerDecision: Decision["maintainerDecision"] | null;
  maintainerDecisionInvalid: boolean;
  regressionAssessment: RegressionAssessment | null;
  regressionProvenance: PublicRegressionProvenance | null;
  authorityChainProofRequired: boolean;
};

/** Apply publication policy without changing the recorded reviewer assessment. */
export function applyHostProofRules(markdown: string, proof: RealBehaviorProof): RealBehaviorProof {
  if (frontMatterStringArray(markdown, "labels").includes(PROOF_OVERRIDE_LABEL)) {
    return {
      ...proof,
      status: "override",
      summary: "A maintainer applied proof: override for this PR.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    };
  }
  const external = isExternalPullRequestReport(markdown);
  if (!proof.summary.trim()) {
    return {
      ...proof,
      ...(external
        ? {
            status: "missing" as const,
            summary:
              "No after-fix real behavior proof was recorded for this external PR; screenshots or videos are preferred when they can show the behavior, and terminal screenshots, console output, copied live output, linked artifacts, recordings, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
            evidenceKind: "none" as const,
            needsContributorAction: true,
          }
        : {
            status: "not_applicable" as const,
            summary:
              frontMatterValue(markdown, "type") === "pull_request"
                ? "No real behavior proof assessment was recorded in this older report."
                : "Real behavior proof is not required for non-PR issue triage.",
            evidenceKind: "not_applicable" as const,
            needsContributorAction: false,
          }),
    };
  }
  if (
    frontMatterValue(markdown, "type") !== "pull_request" ||
    external ||
    proof.summary.trim().startsWith(AUTHORITY_CHAIN_PROOF_MARKER) ||
    (!proof.needsContributorAction &&
      proof.status !== "missing" &&
      proof.status !== "mock_only" &&
      proof.status !== "insufficient")
  )
    return proof;
  return proof.status === "sufficient"
    ? { ...proof, needsContributorAction: false }
    : {
        ...proof,
        status: "not_applicable",
        summary:
          "Real behavior proof is not required for maintainer- or bot-authored pull requests.",
        evidenceKind: "not_applicable",
        needsContributorAction: false,
      };
}

// Scalar public prose occupied one line in the report. Continuations were not
// published as findings, concerns, rating advice, or evidence metadata.
function reportLineText(value: string): string {
  const newline = value.indexOf("\n");
  return newline < 0 ? value : value.slice(0, newline);
}

/**
 * Reads the reviewed decision of a report from its typed review_record. A report from
 * before review_record existed gets the decision from its text. A record that does not
 * read throws ReviewRecordFormatError: it gets no fallback.
 */
export function reportReviewDecision(markdown: string): ReportReviewDecision {
  const record = readReviewRecord(markdown);
  if (!record) return legacyReportReviewDecision(markdown);
  const reviewedMain = frontMatterValue(markdown, "main_sha") ?? "";
  const repo = frontMatterValue(markdown, "repository");
  const { decision } = record;
  return {
    ...decision,
    labelJustifications: selectedLabelJustifications(decision.labelJustifications, decision),
    realBehaviorProof: applyHostProofRules(markdown, decision.realBehaviorProof),
    authorityChainProofRequired: decision.realBehaviorProof.summary
      .trim()
      .startsWith(AUTHORITY_CHAIN_PROOF_MARKER),
    risks: decision.risks.length ? decision.risks.map((risk) => `- ${risk}`).join("\n") : "- none",
    agentsPolicyStatus: decision.agentsPolicyStatus,
    maintainerDecisionInvalid: false,
    bestSolution: decision.bestSolution.trim() || "_Not provided._",
    reproductionAssessment: decision.reproductionAssessment.trim() || "_Not provided._",
    solutionAssessment: decision.solutionAssessment.trim() || "_Not provided._",
    likelyOwners: decision.likelyOwners.map(publicLikelyOwner),
    reviewFindings: decision.reviewFindings.map((finding) => ({
      ...finding,
      body: reportLineText(finding.body),
    })),
    securityReview: {
      ...decision.securityReview,
      summary: reportLineText(decision.securityReview.summary),
      concerns: decision.securityReview.concerns.map((concern) => ({
        ...concern,
        body: reportLineText(concern.body),
      })),
    },
    prRating: { ...decision.prRating, summary: reportLineText(decision.prRating.summary) },
    evidence: decision.evidence.map((raw) => {
      const evidence = normalizeEvidence(raw);
      evidence.detail = reportLineText(evidence.detail);
      // The report writer links same-repository files to the reviewed main revision.
      if (evidence.file && evidence.repo === repo && !evidence.sha && isCommitSha(reviewedMain)) {
        evidence.sha = reviewedMain;
      }
      return evidence;
    }),
    regressionAssessment: isRegressionAssessment(decision.regressionAssessment)
      ? decision.regressionAssessment
      : null,
    regressionProvenance: isPublicRegressionProvenance(decision.regressionProvenance)
      ? decision.regressionProvenance
      : null,
  };
}

// The report readers that labels used before review_record existed. Remove this
// fallback when the backfill shows that no stored report is without a record.
function legacyReportReviewDecision(markdown: string): ReportReviewDecision {
  const labels = {
    triagePriority: triagePriorityFromReport(markdown),
    impactLabels: impactLabelsFromReport(markdown),
    mergeRiskLabels: mergeRiskLabelsFromReport(markdown),
    maturityLabels: maturityLabelsFromReport(markdown),
  };
  // An older report can have no value, or a value that is not in the type. The labels
  // compare these values to known values, as they did before review_record existed.
  const stored = <T extends string>(key: string) => frontMatterValue(markdown, key) as T;
  const nextStep = nextStepFromReport(markdown);
  let maintainerDecision = null;
  let maintainerDecisionInvalid = false;
  try {
    maintainerDecision = maintainerDecisionFromReport(markdown);
  } catch {
    maintainerDecisionInvalid = true;
  }
  return {
    ...labels,
    labelJustifications: labelJustificationsFromReport(markdown, labels),
    telegramVisibleProof: reportTelegramVisibleProof(markdown),
    securityReview: reportSecurityReview(markdown),
    itemCategory: stored("item_category"),
    reproductionStatus: stored("reproduction_status"),
    reproductionConfidence: stored("reproduction_confidence"),
    requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
    requiresNewConfigOption: frontMatterValue(markdown, "requires_new_config_option") === "true",
    requiresProductDecision: frontMatterValue(markdown, "requires_product_decision") === "true",
    implementationComplexity: stored("implementation_complexity"),
    autoImplementationCandidate: stored("auto_implementation_candidate"),
    workCandidate: stored("work_candidate"),
    workConfidence: stored("work_confidence"),
    workPrompt: reviewSectionValue(markdown, "repairWorkPrompt"),
    workValidation: frontMatterStringArray(markdown, "work_validation"),
    workLikelyFiles: frontMatterStringArray(markdown, "work_likely_files"),
    decision: stored("decision"),
    closeReason: stored("close_reason"),
    visionFit: stored("vision_fit"),
    visionFitEvidence: frontMatterStringArray(markdown, "vision_fit_evidence"),
    workPriority: stored("work_priority"),
    workClusterRefs: frontMatterStringArray(markdown, "work_cluster_refs"),
    confidence: stored("confidence"),
    summary: reviewSectionValue(markdown, "summary"),
    changeSummary: reviewSectionValue(markdown, "changeSummary"),
    changeExample: reportChangeExample(markdown),
    systemContext: reviewSectionValue(markdown, "systemContext"),
    architectureDiagram: reviewSectionValue(markdown, "architectureDiagram"),
    evidence: reportEvidence(markdown),
    likelyOwners: reportLikelyOwners(markdown),
    risks: reviewSectionValue(markdown, "risks"),
    bestSolution: reviewSectionValue(markdown, "bestSolution"),
    reproductionAssessment: reviewSectionValue(markdown, "reproductionAssessment"),
    solutionAssessment: reviewSectionValue(markdown, "solutionAssessment"),
    mergeRiskOptions: mergeRiskOptionsFromReport(markdown),
    reviewMetrics: reviewMetricsFromReport(markdown),
    rootCauseCluster: reportRootCauseCluster(markdown),
    agentsPolicyStatus: reportAgentsPolicyStatus(markdown),
    productReview: reportProductReview(markdown),
    provenance: reportProvenance(markdown),
    testingReview: reportTestingReview(markdown),
    reviewFindings: reportReviewFindings(markdown),
    realBehaviorProof: reportRealBehaviorProof(markdown),
    authorityChainProofRequired: reviewSectionValue(markdown, "realBehaviorProof")
      .split("\n")
      .some((line) => line.trimStart().startsWith(`Summary: ${AUTHORITY_CHAIN_PROOF_MARKER}`)),
    prRating: reportPrRating(markdown),
    featureShowcase: reportFeatureShowcase(markdown),
    overallCorrectness: reportOverallCorrectness(markdown),
    overallConfidenceScore: reportOverallConfidenceScore(markdown),
    ...(nextStep ? { nextStep } : {}),
    workReason: reportWorkCandidateReason(markdown),
    maintainerDecision,
    maintainerDecisionInvalid,
    fixedPullRequest: fixedPullRequestFromReport(markdown),
    regressionAssessment: regressionAssessmentFromReport(markdown),
    regressionProvenance: regressionProvenanceFromReport(markdown),
  };
}
