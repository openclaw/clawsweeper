import type {
  CloseReason,
  ItemKind,
  PullRequestReviewReadiness,
  ReviewCommentRenderOptions,
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
import { neutralizeReviewControlMarkers, renderReviewHistorySection } from "./review-history.js";
import type { CreateReportRenderingDependencies } from "./clawsweeper-report-rendering-dependencies.js";
import type { createReportContextRendering } from "./clawsweeper-report-context.js";
import type { createReportCommentHelpers } from "./clawsweeper-report-comment-helpers.js";

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
    frontMatterStringArray,
    frontMatterValue,
    isReportNoneList,
    issueReproductionHelpSuggestions,
    labelJustificationsFromPublicReport,
    labelJustificationsMarkdown,
    labelTransitionJustificationsFromPublicReport,
    labelTransitionJustificationsMarkdown,
    likelyOwnerLine,
    mergeRiskOptionsFromReport,
    neutralizeOwnedSectionSpoofing,
    publicBeforeMergeBlock,
    publicChecklistText,
    publicFailedReviewReadinessBlock,
    publicMantisRecommendationBlock,
    publicMergeReadinessBlock,
    publicMergeRiskLine,
    publicNonDispatchableMantisRecommendationBlock,
    publicPriorityBulletFromText,
    publicPriorityBulletIfActionable,
    publicRankDetailsBlock,
    publicReviewScoresBlock,
    publicReviewTextDiffers,
    publicRiskBulletsFromText,
    publicRootCauseClusterBlock,
    publicSecurityReviewLine,
    publicSummaryBody,
    publicVerificationBlock,
    pullHeadShaFromReport,
    pullRequestReviewReadinessFromReport,
    renderCloseCommentFromReport,
    renderDataModelWarningFromReport,
    renderSqliteSchemaWarningFromReport,
    renderOpenClawPrSurfaceFromReport,
    renderReviewMetricsDigest,
    repairLoopPassModeFromReport,
    reportAgentsPolicyStatus,
    reportEvidence,
    reportLikelyOwners,
    reportLiveProofRecordingBlock,
    reportMantisRecommendation,
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
    reviewWorkflowLines,
    sanitizeArchitectureDiagram,
    sanitizePublicSelfReferences,
    securityConcernDetailedLine,
    securityConcernSummaryLine,
    sentence,
    stripPriorityPrefix,
    triagePriorityFromReport,
  } = dependencies;

  function renderKeepOpenCommentFromReport(
    markdown: string,
    options: ReviewCommentRenderOptions = {},
    precomputedReadiness?: PullRequestReviewReadiness,
  ): string {
    // Keep the full list for verification counts; only the rendered evidence list is
    // abbreviated.
    const allEvidenceEntries = reportEvidence(markdown);
    const evidenceEntries = allEvidenceEntries.slice(0, 6);
    const evidence = evidenceEntries.map(closeEvidenceLine);
    const likelyOwners = reportLikelyOwners(markdown).slice(0, 5).map(likelyOwnerLine);
    const reviewFindings = reportReviewFindings(markdown);
    const securityReview = reportSecurityReview(markdown);
    const proofPolicy = reportRealBehaviorProofPolicy(markdown);
    const prRating = reportPrRating(markdown);
    const liveProofRecordingBlock = reportLiveProofRecordingBlock(markdown);
    const mantisRecommendation = reportMantisRecommendation(markdown);
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
    const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
    const reviewReadiness = isPullRequest
      ? (precomputedReadiness ?? pullRequestReviewReadinessFromReport(markdown))
      : undefined;
    const reviewFailed = frontMatterValue(markdown, "review_status") === "failed";
    const validation = frontMatterStringArray(markdown, "work_validation")
      .slice(0, 5)
      .map((step) =>
        isPullRequest ? publicPriorityBulletFromText(step, "P1") : `- ${stripPriorityPrefix(step)}`,
      );
    const isRepairLoopPass = isPullRequest && Boolean(repairLoopPassModeFromReport(markdown));
    const hasRealBehaviorProofBlocker =
      isPullRequest && !reviewFailed && proofPolicy.proofBlocksMerge;
    const summaryLine =
      neutralizeOwnedSectionSpoofing(sentence(summary)) || "_No summary provided._";
    const changeSummaryLine =
      neutralizeOwnedSectionSpoofing(sentence(changeSummary || summary)) ||
      "_No change summary provided._";
    const fallbackNextStep =
      "Continue tracking this item until the missing behavior is implemented or a maintainer decides the product direction.";
    const nextStepLine = sentence(
      workReason || bestSolution || (isPullRequest ? "" : fallbackNextStep),
    );
    const publicNextStepLine = isPullRequest
      ? hasRealBehaviorProofBlocker
        ? publicPriorityBulletFromText(nextStepLine, "P1")
        : publicPriorityBulletIfActionable(nextStepLine, "P2")
      : nextStepLine;
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
              : "Codex review: keeping this open for maintainer follow-up; there is still a little grit to resolve.";
    const lines = [`${verdictLine}${reviewFreshnessText(markdown)}`, ""];
    const prSurface = renderOpenClawPrSurfaceFromReport(markdown);
    const dataModelWarning = renderDataModelWarningFromReport(markdown);
    const sqliteSchemaWarning = renderSqliteSchemaWarningFromReport(markdown);
    const rootCauseClusterBlock = publicRootCauseClusterBlock(rootCauseCluster);
    const mantisSuggestion = isPullRequest
      ? publicMantisRecommendationBlock(mantisRecommendation)
      : "";
    const unsupportedMantisSuggestion = isPullRequest
      ? publicNonDispatchableMantisRecommendationBlock(mantisRecommendation)
      : "";
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
        isPullRequest ? publicRiskBulletsFromText(risks, "P2") : risks,
      );
    }
    const reviewLine = closeReviewLineFromReport(markdown);
    if (reviewLine) reviewDetails.push(...(reviewDetails.length ? [""] : []), reviewLine);
    const reviewHistoryBlock = renderReviewHistorySection(
      reviewHistoryForRender(markdown, options.previousReviewCommentBody),
    );

    if (isPullRequest) {
      if (!reviewReadiness) {
        throw new Error("pull request review rendering requires normalized readiness");
      }
      // When patch quality itself blocks readiness, the rating's remediation steps are
      // required work, not optional rank-up advice.
      const patchQualityBlocked =
        !reviewFailed && (prRating.patchTier === "F" || prRating.patchTier === "D");
      const beforeMergeItems = reviewReadiness.items;
      lines.push("# ClawSweeper review", "");
      appendHeadingSection(lines, "What this changes", changeSummaryLine);
      if (sqliteSchemaWarning) lines.push(sqliteSchemaWarning, "");
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
      if (!reviewFailed) {
        appendHeadingSection(
          lines,
          "Review scores",
          publicReviewScoresBlock(prRating, proofPolicy, reviewFindings, securityReview),
        );
        appendHeadingSection(
          lines,
          "Verification",
          publicVerificationBlock(proofPolicy, allEvidenceEntries, reviewFindings, securityReview),
        );
      }
      if (liveProofRecordingBlock) {
        lines.push("", "### Live Verification", "", liveProofRecordingBlock, "");
      }
      if (systemContext && architectureDiagram) {
        appendHeadingSection(
          lines,
          "How this fits together",
          `${systemContext}\n\n\`\`\`mermaid\n${architectureDiagram}\n\`\`\``,
        );
      }
      if (decisionPacketBlock) {
        appendHeadingSection(lines, "Decision needed", decisionPacketBlock);
      }
      appendHeadingSection(lines, "Before merge", publicBeforeMergeBlock(beforeMergeItems));
      if (reviewFindings.length || securityReview.concerns.length) {
        appendHeadingSection(
          lines,
          "Findings",
          [
            ...reviewFindings.slice(0, 3).map(reviewFindingSummaryLine),
            ...securityReview.concerns.slice(0, 3).map(securityConcernSummaryLine),
          ].join("\n"),
        );
      }

      const agentDetails: string[] = ["### Security", "", securityLine || "None."];
      if (prSurface) agentDetails.push("", "### PR surface", "", prSurface);
      agentDetails.push("", "### Review metrics", "", renderReviewMetricsDigest(reviewMetrics));
      if (dataModelWarning) {
        agentDetails.push("", "### Stored data model", "", dataModelWarning);
      }
      if (rootCauseClusterBlock) {
        agentDetails.push("", "### Root-cause cluster", "", rootCauseClusterBlock);
      }
      if (mantisSuggestion) {
        agentDetails.push("", "### Mantis proof suggestion", "", mantisSuggestion);
      }
      if (unsupportedMantisSuggestion) {
        agentDetails.push("", "### Proof path suggestion", "", unsupportedMantisSuggestion);
      }
      if (mergeRiskLine) {
        // Routine risks are not counted as Before-merge work, so keep their text
        // visible next to the maintainer options even when actionable risks coexist.
        const riskBullets = !isReportNoneList(risks) ? publicRiskBulletsFromText(risks, "P1") : "";
        const routineRiskContext = riskBullets
          .split("\n")
          .filter((line) => line.startsWith("- ") && !/^- \[P[0-2]\]/.test(line))
          .join("\n");
        agentDetails.push(
          "",
          "### Merge-risk options",
          "",
          ...(routineRiskContext ? [routineRiskContext, ""] : []),
          mergeRiskLine,
        );
      }
      if (reviewDetails.length) {
        agentDetails.push("", "### Technical review", "", ...reviewDetails);
      }
      if (labelDetails.length) {
        agentDetails.push("", "### Labels", "", ...labelDetails);
      }
      if (evidenceDetails.length) {
        agentDetails.push("", "### Evidence", "", ...evidenceDetails);
      }
      const rankUpMoves = prRating.nextSteps
        .map((step) => sentence(step))
        .filter((step) => step && !isReportNoneList(step) && !/^none[.!]?$/i.test(step));
      if (!reviewFailed && !patchQualityBlocked && rankUpMoves.length) {
        agentDetails.push(
          "",
          "### Rank-up moves",
          "",
          "Optional improvements that raise the rating; they are not merge blockers.",
          "",
          rankUpMoves.map((step) => `- ${publicChecklistText(step)}`).join("\n"),
        );
      }
      if (!reviewFailed) {
        agentDetails.push("", "### Rating scale", "", publicRankDetailsBlock());
      }
      agentDetails.push("", "### Workflow", "", ...reviewWorkflowLines());
      if (reviewHistoryBlock) {
        agentDetails.push("", "### History", "", REVIEW_HISTORY_RENDER_SLOT);
      }
      lines.push("", collapsedDetailsBlock("<strong>Agent review details</strong>", agentDetails));
    } else {
      appendPublicSection(lines, "Summary", publicSummaryBody(summaryLine, reproductionAssessment));
      if (regressionPublicLine) {
        appendPublicSection(lines, "Regression provenance", regressionPublicLine);
      }
      if (rootCauseClusterBlock) {
        appendPublicSection(lines, "Root-cause cluster", rootCauseClusterBlock);
      }
      const reproductionHelp = issueReproductionHelpSuggestions(markdown);
      if (reproductionHelp.length) {
        appendPublicSection(
          lines,
          "Ways to help us reproduce this",
          reproductionHelp.map((suggestion) => `- ${suggestion}`).join("\n"),
        );
      }
      if (decisionPacketBlock) {
        appendPublicSection(lines, "Maintainer decision needed", decisionPacketBlock);
      }
      appendPublicSection(lines, "Next step", publicNextStepLine);
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
    const publicBody = neutralizeReviewControlMarkers(
      sanitizePublicSelfReferences(
        lines.join("\n"),
        Number(frontMatterValue(markdown, "number")),
        (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
      ),
    );
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
        "# ClawSweeper review",
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
