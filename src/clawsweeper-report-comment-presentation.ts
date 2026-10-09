import type {
  CloseReason,
  ProductFixScope,
  ProductReview,
  ProductReviewKind,
  ProductWorthIt,
  ProvenanceEntry,
  PullRequestReviewReadiness,
  ReviewCommentRenderOptions,
  ReviewFinding,
  SecurityReview,
  TestingProofPath,
  TestingReview,
} from "./clawsweeper-types.js";
import {
  isVerifiedRegressionProvenance,
  regressionAssessmentPublicLine,
  regressionProvenancePublicLine,
} from "./clawsweeper-regression-provenance.js";
import {
  maintainerDecisionFromReport,
  renderDecisionPacketPublicBlock,
} from "./decision-packets.js";
import {
  reportChangeExample,
  reportProductReview,
  reportProvenance,
  reportTestingReview,
} from "./clawsweeper-report-parser.js";
import { neutralizeReviewControlMarkers, renderReviewHistorySection } from "./review-history.js";
import type { CreateReportRenderingDependencies } from "./clawsweeper-report-rendering-dependencies.js";
import type { createReportContextRendering } from "./clawsweeper-report-context.js";
import type { createReportCommentHelpers } from "./clawsweeper-report-comment-helpers.js";
import { frontMatterStringArray, frontMatterValue } from "./report-front-matter.js";

const PRODUCT_KIND_TEXT: Record<ProductReviewKind, string> = {
  bug_fix: "Bug fix",
  preference: "Preference",
  feature: "Feature",
  refactor: "Refactor",
  performance: "Performance",
  test_only: "Test only",
  docs: "Docs",
  maintenance: "Maintenance",
  not_applicable: "Not applicable",
};

const PRODUCT_WORTH_TEXT: Record<ProductWorthIt, string> = {
  yes: "Yes",
  no: "No",
  needs_maintainer: "Needs a maintainer decision",
  not_applicable: "Not applicable",
};

const PRODUCT_FIX_SCOPE_TEXT: Record<ProductFixScope, string> = {
  complete: "Complete",
  partial: "Partial",
  not_applicable: "Not applicable",
};

const TESTING_PROOF_PATH_TEXT: Record<TestingProofPath, string> = {
  shipped_entry_point: "shipped entry point",
  in_process_harness: "in-process harness",
  unit_only: "unit tests only",
  none: "none",
  not_applicable: "not applicable",
};

export function createReportCommentPresentation(
  dependencies: CreateReportRenderingDependencies &
    ReturnType<typeof createReportContextRendering> &
    ReturnType<typeof createReportCommentHelpers>,
) {
  const {
    REVIEW_HISTORY_RENDER_SLOT,
    agentsPolicyStatusLine,
    appendHeadingSection,
    appendPublicSection,
    appendReviewQuestionDetails,
    closeEvidenceLine,
    closeReviewLineFromReport,
    collapsedDetailsBlock,
    confidenceText,
    isReportNoneList,
    labelJustificationsFromPublicReport,
    labelJustificationsMarkdown,
    labelTransitionJustificationsFromPublicReport,
    labelTransitionJustificationsMarkdown,
    likelyOwnerLines,
    mergeRiskOptionsFromReport,
    neutralizeOwnedSectionSpoofing,
    publicBeforeMergeBlock,
    publicChecklistText,
    publicFailedReviewReadinessBlock,
    publicMergeReadinessBlock,
    publicMergeRiskLine,
    publicRankScaleLine,
    publicReviewScoresBlock,
    publicReviewTextDiffers,
    publicReviewTextIsSame,
    publicRiskBullets,
    publicRootCauseClusterBlock,
    publicSecurityReviewLine,
    publicSummaryBody,
    pullHeadShaFromReport,
    pullRequestReviewReadinessFromReport,
    renderCloseCommentFromReport,
    renderOpenClawPrSurfaceFromReport,
    renderReviewMetricsDigest,
    repairLoopPassModeFromReport,
    reportAgentsPolicyStatus,
    reportEvidence,
    reportLikelyOwners,
    reportLiveProofRecordingBlock,
    reportOverallConfidenceScore,
    reportOverallCorrectness,
    reportPrRating,
    reportRealBehaviorProofPolicy,
    reportReviewFindings,
    reportRootCauseCluster,
    reportSecurityReview,
    reportWorkCandidateReason,
    regressionAssessmentFromReport,
    regressionProvenanceFromReport,
    reviewAutomationMarkersFromReport,
    reviewFindingDetailedLine,
    reviewFindingSummaryLine,
    reviewFreshnessText,
    reviewHistoryForRender,
    reviewMetricsFromReport,
    reviewSectionValue,
    reviewVersionMarkerFromReport,
    reviewWorkflowCallout,
    reviewWorkflowSummaryLine,
    sanitizeArchitectureDiagram,
    securityConcernDetailedLine,
    securityConcernSummaryLine,
    sentence,
    stripListMarker,
    triagePriorityFromReport,
  } = dependencies;

  function publicInlineText(value: string): string {
    return sentence(publicChecklistText(value));
  }

  function publicInlineCode(value: string): string {
    return `\`${publicChecklistText(value).replaceAll("`", "'")}\``;
  }

  // Old reports carry no product review; an all-empty review has nothing to show.
  function publicProductBlock(product: ProductReview): string {
    if (
      product.kind === "not_applicable" &&
      product.worthIt === "not_applicable" &&
      product.fixScope === "not_applicable" &&
      !product.userProblem.trim() &&
      !product.reason.trim()
    ) {
      return "";
    }
    const facts = [
      `**Kind:** ${PRODUCT_KIND_TEXT[product.kind]}`,
      `**Worth it:** ${PRODUCT_WORTH_TEXT[product.worthIt]}`,
      ...(product.fixScope === "not_applicable"
        ? []
        : [`**Fix scope:** ${PRODUCT_FIX_SCOPE_TEXT[product.fixScope]}`]),
    ];
    return [
      facts.join(" · "),
      ...(product.userProblem.trim()
        ? [`**User problem:** ${publicInlineText(product.userProblem)}`]
        : []),
      ...(product.reason.trim() ? [`**Reason:** ${publicInlineText(product.reason)}`] : []),
    ].join("\n");
  }

  function publicProvenanceLine(entry: ProvenanceEntry): string {
    const area = publicInlineCode(entry.area);
    const origin = `${publicChecklistText(entry.introducedBy)}: ${
      publicInlineText(entry.originalReason) || "reason not recorded."
    }`;
    switch (entry.verdict) {
      case "overrides_without_reason":
        return `- ${area} changes intended behavior without addressing why it exists (${origin})`;
      case "unknown":
        return `- ${area}: original intent not found (${origin})`;
      case "overrides_with_reason":
        return `- ${area} changes intended behavior with a stated reason (${origin})`;
      case "respects":
        return `- ${area} keeps the original intent (${origin})`;
    }
  }

  // The leading block keeps the renderer's finding grammar ("- [P1] title" or
  // "None.") that review history and the comment router parse; provenance and test
  // notes sit under their own subheadings so they never read as P-severity findings.
  function publicFindingsBlock(
    reviewFindings: readonly ReviewFinding[],
    securityReview: SecurityReview,
    provenance: readonly ProvenanceEntry[],
    testingReview: TestingReview,
  ): string {
    const findingLines = [
      ...reviewFindings.slice(0, 3).map(reviewFindingSummaryLine),
      ...securityReview.concerns.slice(0, 3).map(securityConcernSummaryLine),
    ];
    const blocks = [findingLines.length ? findingLines.join("\n") : "None."];
    const provenanceLines = provenance
      .filter(
        (entry) => entry.verdict === "overrides_without_reason" || entry.verdict === "unknown",
      )
      .map(publicProvenanceLine);
    if (provenanceLines.length) blocks.push("### Provenance", provenanceLines.join("\n"));
    const testLines = [
      ...testingReview.lowValueTests.map(
        (test) =>
          `- Low-value test ${publicInlineCode(test.file)}: ${
            publicInlineText(test.reason) || "reason not recorded."
          }`,
      ),
      ...(testingReview.missingE2e.trim()
        ? [`- Missing end-to-end proof: ${publicInlineText(testingReview.missingE2e)}`]
        : []),
    ];
    if (testLines.length) blocks.push("### Tests", testLines.join("\n"));
    return blocks.join("\n\n");
  }

  function renderKeepOpenCommentFromReport(
    markdown: string,
    options: ReviewCommentRenderOptions = {},
    precomputedReadiness?: PullRequestReviewReadiness,
  ): string {
    const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
    const proofPolicy = reportRealBehaviorProofPolicy(markdown);
    // PR comments state the proof sentence once: in Review scores, or in Before merge
    // when proof blocks merge. An evidence entry that only repeats it adds nothing.
    // Entries that carry a location, commit, command, or link stay, because that is
    // the support for the proof.
    const proofSummary = isPullRequest ? proofPolicy.assessment.summary : "";
    const evidence = reportEvidence(markdown)
      .filter(
        (entry) =>
          !proofSummary ||
          Boolean(entry.file || entry.sha || entry.command) ||
          /https?:\/\//i.test(entry.detail) ||
          !publicReviewTextIsSame(entry.detail, proofSummary),
      )
      .slice(0, 6)
      .map(closeEvidenceLine);
    const likelyOwners = likelyOwnerLines(reportLikelyOwners(markdown));
    const reviewFindings = reportReviewFindings(markdown);
    const securityReview = reportSecurityReview(markdown);
    const prRating = reportPrRating(markdown);
    const liveProofRecordingBlock = reportLiveProofRecordingBlock(markdown);
    const agentsPolicyStatus = reportAgentsPolicyStatus(markdown);
    const rootCauseCluster = reportRootCauseCluster(markdown);
    const regressionProvenance = regressionProvenanceFromReport(markdown);
    const regressionAssessment = regressionAssessmentFromReport(markdown);
    const regressionProvenanceLine = regressionProvenancePublicLine(
      regressionProvenance,
      regressionAssessment,
    );
    const regressionAssessmentLine = regressionAssessmentPublicLine(regressionAssessment, {
      predecessorAttributed: regressionProvenance?.evidenceType === "rewrite_equivalent",
    });
    const regressionPublicLine = [
      regressionProvenanceLine,
      !isVerifiedRegressionProvenance(regressionProvenance) ? regressionAssessmentLine : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");
    const summary = reviewSectionValue(markdown, "summary");
    const changeSummary = reviewSectionValue(markdown, "changeSummary");
    const systemContext = neutralizeOwnedSectionSpoofing(
      reviewSectionValue(markdown, "systemContext"),
    );
    const architectureDiagram = sanitizeArchitectureDiagram(
      reviewSectionValue(markdown, "architectureDiagram"),
    );
    const bestSolution = reviewSectionValue(markdown, "bestSolution");
    const reproductionAssessment = reviewSectionValue(markdown, "reproductionAssessment");
    const solutionAssessment = reviewSectionValue(markdown, "solutionAssessment");
    const risks = reviewSectionValue(markdown, "risks");
    const mergeRiskOptions = mergeRiskOptionsFromReport(markdown);
    const reviewMetrics = reviewMetricsFromReport(markdown);
    const workReason = reportWorkCandidateReason(markdown);
    const reviewReadiness = isPullRequest
      ? (precomputedReadiness ?? pullRequestReviewReadinessFromReport(markdown))
      : undefined;
    const reviewFailed = frontMatterValue(markdown, "review_status") === "failed";
    const validation = frontMatterStringArray(markdown, "work_validation")
      .slice(0, 5)
      .map((step) => `- ${stripListMarker(step)}`);
    const isRepairLoopPass = isPullRequest && Boolean(repairLoopPassModeFromReport(markdown));
    const hasRealBehaviorProofBlocker =
      isPullRequest && !reviewFailed && proofPolicy.proofBlocksMerge;
    const summaryLine =
      neutralizeOwnedSectionSpoofing(sentence(summary)) || "_No summary provided._";
    const changeSummarySentence =
      neutralizeOwnedSectionSpoofing(sentence(changeSummary || summary)) ||
      "_No change summary provided._";
    const changeExample = reportChangeExample(markdown);
    const changeSummaryLine =
      changeExample.scenario && changeExample.before && changeExample.after
        ? [
            changeSummarySentence,
            "",
            `**Example:** ${neutralizeOwnedSectionSpoofing(changeExample.scenario)}`,
            `- **Before:** ${neutralizeOwnedSectionSpoofing(changeExample.before)}`,
            `- **After:** ${neutralizeOwnedSectionSpoofing(changeExample.after)}`,
          ].join("\n")
        : changeSummarySentence;
    const fallbackNextStep =
      "Continue tracking this item until the missing behavior is implemented or a maintainer decides the product direction.";
    const nextStepLine = sentence(
      workReason || bestSolution || (isPullRequest ? "" : fallbackNextStep),
    );
    const bestSolutionLine = sentence(bestSolution);
    const mergeRiskLine = isPullRequest
      ? publicMergeRiskLine(risks, nextStepLine, bestSolutionLine, mergeRiskOptions)
      : "";
    const reviewDetails: string[] = [];
    const labelDetails: string[] = [];
    const evidenceDetails: string[] = [];
    const triagePriority = triagePriorityFromReport(markdown);
    const verdictLine = reviewFailed
      ? "ClawSweeper review: did not complete due to Codex infrastructure failure."
      : reviewReadiness?.state === "blocked"
        ? hasRealBehaviorProofBlocker
          ? "Codex review: needs real behavior proof before merge."
          : proofPolicy.verificationBlocksMerge
            ? "Codex review: needs historical verification review before merge."
            : "Codex review: blocked before merge."
        : reviewReadiness?.state === "needs-changes"
          ? "Codex review: needs changes before merge."
          : isRepairLoopPass
            ? "Codex review: passed."
            : isPullRequest
              ? "Codex review: needs maintainer review before merge."
              : "Codex review: this still needs some work.";
    const reviewHistory = reviewHistoryForRender(markdown, options.previousReviewCommentBody);
    const revision = reviewHistory.totalCompletedCycles + 1;
    const lines = [verdictLine, ""];
    const prSurface = renderOpenClawPrSurfaceFromReport(markdown);
    const rootCauseClusterBlock = publicRootCauseClusterBlock(rootCauseCluster);
    // The decision rationale is model text rendered above owned sections; escape
    // heading-shaped lines so it cannot spoof them.
    const decisionPacketBlock = neutralizeOwnedSectionSpoofing(
      renderDecisionPacketPublicBlock(markdown),
    );
    const securityLine = publicSecurityReviewLine(securityReview);
    if (bestSolutionLine && publicReviewTextDiffers(bestSolutionLine, nextStepLine)) {
      reviewDetails.push("Best possible solution:", "", bestSolutionLine);
    }
    appendReviewQuestionDetails(reviewDetails, reproductionAssessment, solutionAssessment);
    const labelJustifications = labelJustificationsFromPublicReport(markdown, options);
    const labelTransitionJustifications = labelTransitionJustificationsFromPublicReport(
      markdown,
      labelJustifications,
      options,
    );
    if (labelTransitionJustifications.length) {
      labelDetails.push(
        "Label changes:",
        "",
        labelTransitionJustificationsMarkdown(labelTransitionJustifications),
      );
    } else if (
      options.previousLabels !== undefined &&
      !reviewFailed &&
      labelJustifications.length > 0
    ) {
      labelDetails.push("Label changes:", "", "No label changes.");
    }
    if (labelJustifications.length) {
      if (labelDetails.length) labelDetails.push("");
      labelDetails.push(
        "Label justifications:",
        "",
        labelJustificationsMarkdown(labelJustifications),
      );
    }
    if (isPullRequest && reviewFindings.length) {
      reviewDetails.push(
        ...(reviewDetails.length ? [""] : []),
        "Full review comments:",
        "",
        ...reviewFindings.map(reviewFindingDetailedLine),
        "",
        `Overall correctness: ${reportOverallCorrectness(markdown)}`,
        `Overall confidence: ${confidenceText(reportOverallConfidenceScore(markdown))}`,
      );
    }
    if (securityReview.concerns.length) {
      evidenceDetails.push(
        ...(evidenceDetails.length ? [""] : []),
        "Security concerns:",
        "",
        ...securityReview.concerns.map(securityConcernDetailedLine),
      );
    }
    const agentsPolicyLine = agentsPolicyStatusLine(agentsPolicyStatus);
    if (agentsPolicyLine) {
      reviewDetails.push(...(reviewDetails.length ? [""] : []), agentsPolicyLine);
    }
    if (validation.length) {
      evidenceDetails.push(
        ...(evidenceDetails.length ? [""] : []),
        "Acceptance criteria:",
        "",
        ...validation,
      );
    }
    if (evidence.length) {
      evidenceDetails.push(
        ...(evidenceDetails.length ? [""] : []),
        "What I checked:",
        "",
        ...evidence,
      );
    }
    if (likelyOwners.length) {
      evidenceDetails.push(
        ...(evidenceDetails.length ? [""] : []),
        "Likely related people:",
        "",
        ...likelyOwners,
      );
    }
    if (
      !isReportNoneList(risks) &&
      !mergeRiskLine &&
      publicReviewTextDiffers(risks, nextStepLine) &&
      (!bestSolutionLine || publicReviewTextDiffers(risks, bestSolutionLine))
    ) {
      reviewDetails.push(
        ...(reviewDetails.length ? [""] : []),
        "Remaining risk / open question:",
        "",
        isPullRequest ? publicRiskBullets(risks) : risks,
      );
    }
    const reviewLine = closeReviewLineFromReport(markdown);
    if (reviewLine) reviewDetails.push(...(reviewDetails.length ? [""] : []), reviewLine);
    const reviewHistoryBlock = renderReviewHistorySection(reviewHistory);

    if (isPullRequest) {
      if (!reviewReadiness) {
        throw new Error("pull request review rendering requires normalized readiness");
      }
      // When patch quality itself blocks readiness, the rating's remediation steps are
      // required work, not optional rank-up advice.
      const patchQualityBlocked =
        !reviewFailed && (prRating.patchTier === "F" || prRating.patchTier === "D");
      const beforeMergeItems = reviewReadiness.items;
      appendHeadingSection(lines, "What this changes", changeSummaryLine);
      if (!reviewFailed) {
        // The proof summary renders here, or only in Before merge when proof blocks merge.
        appendHeadingSection(
          lines,
          "Review scores",
          publicReviewScoresBlock(prRating, proofPolicy, reviewFindings, securityReview),
        );
      }
      const productBlock = publicProductBlock(reportProductReview(markdown));
      if (productBlock) appendHeadingSection(lines, "Product", productBlock);
      if (regressionPublicLine) {
        appendHeadingSection(lines, "Regression provenance", regressionPublicLine);
      }
      appendHeadingSection(
        lines,
        "Merge readiness",
        reviewFailed
          ? publicFailedReviewReadinessBlock(markdown)
          : publicMergeReadinessBlock(
              reviewReadiness.state,
              triagePriority,
              summaryLine,
              beforeMergeItems.length,
              Boolean(decisionPacketBlock),
              pullHeadShaFromReport(markdown) ?? "",
            ),
      );
      if (decisionPacketBlock) {
        appendHeadingSection(lines, "Decision needed", decisionPacketBlock);
      }
      appendHeadingSection(lines, "Before merge", publicBeforeMergeBlock(beforeMergeItems));
      const provenance = reportProvenance(markdown);
      const testingReview = reportTestingReview(markdown);
      if (!reviewFailed) {
        appendHeadingSection(
          lines,
          "Findings",
          publicFindingsBlock(reviewFindings, securityReview, provenance, testingReview),
        );
      }

      const agentDetails: string[] = [];
      const appendDetails = (heading: string, ...body: string[]) => {
        agentDetails.push(...(agentDetails.length ? [""] : []), `### ${heading}`, "", ...body);
      };
      if (systemContext && architectureDiagram) {
        appendDetails(
          "How this fits together",
          `${systemContext}\n\n\`\`\`mermaid\n${architectureDiagram}\n\`\`\``,
        );
      }
      if (liveProofRecordingBlock) appendDetails("Live Verification", liveProofRecordingBlock);
      if (reviewDetails.length) appendDetails("Technical review", ...reviewDetails);
      if (mergeRiskLine) appendDetails("Merge-risk options", mergeRiskLine);
      const checkedProvenance = provenance.filter(
        (entry) => entry.verdict === "respects" || entry.verdict === "overrides_with_reason",
      );
      if (checkedProvenance.length) {
        appendDetails("Provenance checked", checkedProvenance.map(publicProvenanceLine).join("\n"));
      }
      if (testingReview.proofPath !== "not_applicable") {
        appendDetails(
          "Testing",
          `Proof path: ${TESTING_PROOF_PATH_TEXT[testingReview.proofPath]}.`,
        );
      }
      appendDetails("Security", securityLine || "None.");
      if (evidenceDetails.length) appendDetails("Evidence", ...evidenceDetails);
      if (prSurface) appendDetails("PR surface", prSurface);
      if (reviewMetrics.length) {
        appendDetails("Review metrics", renderReviewMetricsDigest(reviewMetrics));
      }
      if (rootCauseClusterBlock) appendDetails("Root-cause cluster", rootCauseClusterBlock);
      if (labelDetails.length) appendDetails("Labels", ...labelDetails);
      const rankUpMoves = prRating.nextSteps
        .map((step) => sentence(step))
        .filter((step) => step && !isReportNoneList(step) && !/^none[.!]?$/i.test(step));
      if (!reviewFailed && !patchQualityBlocked && rankUpMoves.length) {
        appendDetails(
          "Rank-up moves",
          "Optional improvements that raise the rating; they are not merge blockers.",
          "",
          rankUpMoves.map((step) => `- ${publicChecklistText(step)}`).join("\n"),
        );
      }
      if (!reviewFailed) appendDetails("Rating scale", publicRankScaleLine());
      appendDetails("Workflow", reviewWorkflowSummaryLine());
      if (reviewHistoryBlock) appendDetails("History", REVIEW_HISTORY_RENDER_SLOT);
      lines.push("", collapsedDetailsBlock("<strong>Agent review details</strong>", agentDetails));
    } else {
      appendPublicSection(lines, "Summary", publicSummaryBody(summaryLine, reproductionAssessment));
      if (regressionPublicLine) {
        appendPublicSection(lines, "Regression provenance", regressionPublicLine);
      }
      if (rootCauseClusterBlock) {
        appendPublicSection(lines, "Root-cause cluster", rootCauseClusterBlock);
      }
      if (decisionPacketBlock) {
        appendPublicSection(lines, "Maintainer decision needed", decisionPacketBlock);
      }
      appendPublicSection(lines, "Next step", nextStepLine);
      if (securityReview.status !== "not_applicable" || securityReview.concerns.length > 0) {
        appendPublicSection(lines, "Security", securityLine);
      }
      const detailsBlock = collapsedDetailsBlock("Review details", reviewDetails);
      if (detailsBlock) lines.push("", detailsBlock);
      const labelDetailsBlock = collapsedDetailsBlock("Label changes", labelDetails);
      if (labelDetailsBlock) lines.push("", labelDetailsBlock);
      const evidenceDetailsBlock = collapsedDetailsBlock("Evidence reviewed", evidenceDetails);
      if (evidenceDetailsBlock) lines.push("", evidenceDetailsBlock);
      lines.push("", ...reviewWorkflowCallout());
    }
    const freshness = reviewFreshnessText(markdown, revision);
    if (freshness) lines.push("", freshness);
    const publicBody = neutralizeReviewControlMarkers(lines.join("\n"));
    if (!reviewHistoryBlock) return publicBody;
    // Issues keep the pre-redesign trailing history block; only PRs moved it into the
    // collapsed details slot.
    if (!isPullRequest) return `${publicBody.trimEnd()}\n\n${reviewHistoryBlock}\n`;
    // The slot is always the renderer-appended last occurrence; report text earlier in
    // the body could mention the sentinel, and a plain replace would expand $-sequences.
    const slotIndex = publicBody.lastIndexOf(REVIEW_HISTORY_RENDER_SLOT);
    if (slotIndex < 0) return publicBody;
    return (
      publicBody.slice(0, slotIndex) +
      reviewHistoryBlock +
      publicBody.slice(slotIndex + REVIEW_HISTORY_RENDER_SLOT.length)
    );
  }

  function renderReviewCommentFromReport(
    markdown: string,
    reason: CloseReason,
    options: ReviewCommentRenderOptions = {},
  ): string {
    if (reason === "oversized_pull_request") {
      return [
        renderCloseCommentFromReport(markdown, reason),
        reviewVersionMarkerFromReport(markdown),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    const decision = frontMatterValue(markdown, "decision");
    const reviewReadiness =
      frontMatterValue(markdown, "type") === "pull_request"
        ? pullRequestReviewReadinessFromReport(markdown)
        : undefined;
    if (reviewReadiness?.normalizationFailed) {
      const reviewedHead = reviewReadiness.headSha
        ? `Reviewed head: \`${reviewReadiness.headSha}\`.`
        : "The exact reviewed head could not be recovered.";
      const body = [
        "Codex review: blocked before merge.",
        "",
        "## What this changes",
        "",
        "The generated review report could not be normalized safely.",
        "",
        "## Merge readiness",
        "",
        "**Blocked before merge.**",
        "",
        reviewedHead,
        "",
        "## Before merge",
        "",
        publicBeforeMergeBlock(reviewReadiness.items),
      ].join("\n");
      const markers = options.suppressAutomationMarkers
        ? ""
        : reviewAutomationMarkersFromReport(markdown, reviewReadiness);
      return [body, markers, reviewVersionMarkerFromReport(markdown)].filter(Boolean).join("\n\n");
    }
    let requiresMaintainerDecision = true;
    try {
      requiresMaintainerDecision = maintainerDecisionFromReport(markdown)?.required === true;
    } catch {
      // Malformed or ambiguous decision metadata must keep the report on the human-review path.
    }
    const body =
      decision === "close" &&
      reason !== "none" &&
      (!requiresMaintainerDecision ||
        reason === "unsponsored_feature_request" ||
        reason === "author_pr_budget_exceeded")
        ? renderCloseCommentFromReport(markdown, reason)
        : renderKeepOpenCommentFromReport(markdown, options, reviewReadiness);
    const markers = options.suppressAutomationMarkers
      ? ""
      : reviewAutomationMarkersFromReport(markdown, reviewReadiness);
    return [body.trimEnd(), markers, reviewVersionMarkerFromReport(markdown)]
      .filter(Boolean)
      .join("\n\n");
  }

  return { renderKeepOpenCommentFromReport, renderReviewCommentFromReport };
}
