import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDocsPath } from "./clawsweeper-change-detection.js";
import { AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS, REVIEW_SECTIONS } from "./clawsweeper-policy.js";
import { createPullRequestReferenceParser } from "./clawsweeper-pr-references.js";
import type {
  AuthorPrBudgetApplyState,
  CloseReason,
  CompleteActivityContext,
  Confidence,
  Decision,
  Item,
  ItemCategory,
  ItemContext,
  LinkedPullRequestSupersession,
  LinkedPullRequestSupersessionResolution,
  PullRequestClosePromotion,
  ReproductionStatus,
  WorkCandidateKind,
} from "./clawsweeper-types.js";
import { completeActivityContextSymbol } from "./clawsweeper-types.js";
import {
  emptyMaintainerDecision,
  maintainerDecisionFromReport,
  type MaintainerDecision,
} from "./decision-packets.js";
import type { CreateReportOrchestrationDependencies } from "./clawsweeper-report-orchestration-dependencies.js";
import type { createReportOrchestrationFoundation } from "./clawsweeper-orchestration-foundation.js";
import type { createReportRendering } from "./clawsweeper-report-rendering.js";

export function createPullRequestPromotionFacts(
  dependencies: CreateReportOrchestrationDependencies &
    ReturnType<typeof createReportOrchestrationFoundation> &
    Pick<ReturnType<typeof createReportRendering>, "renderCloseCommentFromReport">,
) {
  const {
    asRecord,
    defaultAgentsPolicyStatus,
    eventTimestampMs,
    fixedPullRequestFromReport,
    frontMatterStringArray,
    frontMatterValue,
    ghJson,
    impactLabelsFromReport,
    isAfterReview,
    isAutomationReportAuthor,
    isDocsOnlyPullRequestReport,
    itemSnapshotHash,
    labelJustificationsFromReport,
    labelNames,
    maturityLabelsFromReport,
    mergeRiskLabelsFromReport,
    mergeRiskOptionsFromReport,
    normalizeLabelName,
    renderCloseCommentFromReport,
    replaceFrontMatterValue,
    replaceSectionValue,
    repoUrlFor,
    reportAgentsPolicyStatus,
    reportEvidence,
    reportFeatureShowcase,
    reportFileName,
    reportLikelyOwners,
    reportLiveProofPlan,
    reportMantisRecommendation,
    reportOverallConfidenceScore,
    reportOverallCorrectness,
    reportPrRating,
    reportRealBehaviorProof,
    reportReviewFindings,
    reportRootCauseCluster,
    reportSecurityReview,
    reportTelegramVisibleProof,
    reportVisionFit,
    reviewMetricsFromReport,
    reviewSectionValue,
    stringOrUndefined,
    targetRepo,
    timestampMs,
    triagePriorityFromReport,
  } = dependencies;

  function reportDecision(markdown: string, closeReason: CloseReason): Decision {
    const fixedRelease = frontMatterValue(markdown, "fixed_release");
    const fixedSha = frontMatterValue(markdown, "fixed_sha");
    const fixedAt = frontMatterValue(markdown, "fixed_at");
    const kind = frontMatterValue(markdown, "type");
    const triagePriority = triagePriorityFromReport(markdown);
    const impactLabels = kind === "pull_request" ? [] : impactLabelsFromReport(markdown);
    const mergeRiskLabels = mergeRiskLabelsFromReport(markdown);
    const maturityLabels = kind === "pull_request" ? [] : maturityLabelsFromReport(markdown);
    const visionFit = reportVisionFit(markdown);
    return {
      decision: "close",
      closeReason,
      confidence: "high",
      summary: reviewSectionValue(markdown, "summary"),
      changeSummary: reviewSectionValue(markdown, "changeSummary"),
      systemContext: reviewSectionValue(markdown, "systemContext"),
      architectureDiagram: reviewSectionValue(markdown, "architectureDiagram"),
      evidence: reportEvidence(markdown),
      likelyOwners: reportLikelyOwners(markdown),
      risks: [],
      bestSolution: reviewSectionValue(markdown, "bestSolution"),
      maintainerDecision: ambiguityGuardedMaintainerDecision(markdown),
      triagePriority,
      impactLabels,
      mergeRiskLabels,
      maturityLabels,
      mergeRiskOptions: mergeRiskOptionsFromReport(markdown),
      reviewMetrics: reviewMetricsFromReport(markdown),
      labelJustifications: labelJustificationsFromReport(markdown, {
        triagePriority,
        impactLabels,
        mergeRiskLabels,
        maturityLabels,
      }),
      itemCategory:
        (frontMatterValue(markdown, "item_category") as ItemCategory | undefined) ?? "unclear",
      reproductionStatus:
        (frontMatterValue(markdown, "reproduction_status") as ReproductionStatus | undefined) ??
        "unclear",
      reproductionConfidence:
        (frontMatterValue(markdown, "reproduction_confidence") as Confidence | undefined) ?? "low",
      requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
      requiresNewConfigOption: frontMatterValue(markdown, "requires_new_config_option") === "true",
      requiresProductDecision: frontMatterValue(markdown, "requires_product_decision") === "true",
      reproductionAssessment: reviewSectionValue(markdown, "reproductionAssessment"),
      solutionAssessment: reviewSectionValue(markdown, "solutionAssessment"),
      ...visionFit,
      rootCauseCluster: reportRootCauseCluster(markdown),
      agentsPolicyStatus: reportAgentsPolicyStatus(markdown) ?? defaultAgentsPolicyStatus(),
      reviewFindings: reportReviewFindings(markdown),
      securityReview: reportSecurityReview(markdown),
      realBehaviorProof: reportRealBehaviorProof(markdown),
      prRating: reportPrRating(markdown),
      telegramVisibleProof: reportTelegramVisibleProof(markdown),
      liveProofPlan: reportLiveProofPlan(markdown),
      mantisRecommendation: reportMantisRecommendation(markdown),
      featureShowcase: reportFeatureShowcase(markdown),
      overallCorrectness: reportOverallCorrectness(markdown),
      overallConfidenceScore: reportOverallConfidenceScore(markdown),
      fixedRelease: fixedRelease && fixedRelease !== "unknown" ? fixedRelease : null,
      fixedSha: fixedSha && fixedSha !== "unknown" ? fixedSha : null,
      fixedAt: fixedAt && fixedAt !== "unknown" ? fixedAt : null,
      fixedPullRequest: fixedPullRequestFromReport(markdown),
      closeComment: reviewSectionValue(markdown, "closeComment"),
      workCandidate:
        (frontMatterValue(markdown, "work_candidate") as WorkCandidateKind | undefined) ?? "none",
      workConfidence:
        (frontMatterValue(markdown, "work_confidence") as Confidence | undefined) ?? "low",
      workPriority:
        (frontMatterValue(markdown, "work_priority") as Confidence | undefined) ?? "low",
      workReason: reviewSectionValue(markdown, "workCandidate"),
      workPrompt: reviewSectionValue(markdown, "repairWorkPrompt"),
      workClusterRefs: frontMatterStringArray(markdown, "work_cluster_refs"),
      workValidation: frontMatterStringArray(markdown, "work_validation"),
      workLikelyFiles: frontMatterStringArray(markdown, "work_likely_files"),
    };
  }

  function livePullRequestHasNoDiff(context: ItemContext): boolean {
    const pull = asRecord(context.pullRequest);
    return (
      pull.changedFiles === 0 &&
      context.counts?.pullFilesTruncated !== true &&
      (context.pullFiles?.length ?? 0) === 0
    );
  }

  function upgradeNoDiffPullRequestReport(markdown: string, item: Item): string {
    const command = `gh api repos/${item.repo}/pulls/${item.number} --jq '{state:.state,changed_files:.changed_files,base:.base.ref,head:.head.sha}'`;
    let upgraded = markdown;
    upgraded = replaceFrontMatterValue(upgraded, "decision", "close");
    upgraded = replaceFrontMatterValue(upgraded, "close_reason", "duplicate_or_superseded");
    upgraded = replaceFrontMatterValue(upgraded, "confidence", "high");
    upgraded = replaceFrontMatterValue(upgraded, "action_taken", "proposed_close");
    upgraded = replaceFrontMatterValue(upgraded, "pr_close_coverage_proof_fallback_refs", "false");
    upgraded = replaceFrontMatterValue(upgraded, "work_cluster_refs", "[]");
    upgraded = replaceFrontMatterValue(upgraded, "merge_risk_options", "[]");
    upgraded = replaceFrontMatterValue(upgraded, "work_candidate", "none");
    upgraded = replaceFrontMatterValue(upgraded, "work_status", "none");
    upgraded = replaceSectionValue(
      upgraded,
      REVIEW_SECTIONS.summary,
      "Close this PR: GitHub reports no changed files against the current base branch.",
    );
    upgraded = replaceSectionValue(
      upgraded,
      REVIEW_SECTIONS.bestSolution,
      "Close this PR: GitHub reports no changed files against the current base branch, so the branch is already empty or superseded by `main`.",
    );
    upgraded = replaceSectionValue(
      upgraded,
      REVIEW_SECTIONS.evidence,
      `- **live no-diff PR:** GitHub reports \`changed_files: 0\` for this open PR, so there is no remaining branch diff to merge.\n  - command: \`${command}\``,
    );
    upgraded = replaceSectionValue(
      upgraded,
      REVIEW_SECTIONS.closeComment,
      renderCloseCommentFromReport(upgraded, "duplicate_or_superseded"),
    );
    return upgraded;
  }

  function upgradePullRequestClosePromotionReport(
    markdown: string,
    item: Item,
    context: ItemContext,
    promotion: PullRequestClosePromotion,
  ): string {
    let upgraded = markdown;
    upgraded = replaceFrontMatterValue(upgraded, "decision", "close");
    upgraded = replaceFrontMatterValue(upgraded, "close_reason", promotion.closeReason);
    upgraded = replaceFrontMatterValue(upgraded, "confidence", "high");
    upgraded = replaceFrontMatterValue(upgraded, "action_taken", "proposed_close");
    upgraded = replaceFrontMatterValue(
      upgraded,
      "pr_close_coverage_proof_fallback_refs",
      promotion.coverageProofFallbackRefs ? "true" : "false",
    );
    upgraded = replaceFrontMatterValue(upgraded, "work_candidate", "none");
    upgraded = replaceFrontMatterValue(upgraded, "work_status", "none");
    upgraded = replaceFrontMatterValue(upgraded, "item_updated_at", item.updatedAt);
    upgraded = replaceFrontMatterValue(
      upgraded,
      "item_snapshot_hash",
      itemSnapshotHash(item, context),
    );
    upgraded = replaceFrontMatterValue(
      upgraded,
      "item_source_revision",
      context.sourceRevision ?? "unknown",
    );
    upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.summary, promotion.summary);
    upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.bestSolution, promotion.bestSolution);
    upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.evidence, promotion.evidence);
    upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.closeComment, promotion.closeComment);
    return upgraded;
  }

  function authorPrBudgetPromotion(
    markdown: string,
    state: AuthorPrBudgetApplyState,
  ): PullRequestClosePromotion {
    const proof = reportRealBehaviorProof(markdown);
    const rating = reportPrRating(markdown);
    const author = `@${state.author.replace(/^@/, "")}`;
    const summary = `${author} currently has ${state.openPrCount} open PRs in this repository, above the budget of ${state.budget}. ClawSweeper is closing this PR as one of the author's lowest-signal submissions under that budget: its overall rating is ${rating.overallTier} and its real behavior proof is ${proof.status}. Closing or finishing other PRs frees review budget, and this PR can be reopened once the author is under budget or when real proof is added.`;
    return {
      closeReason: "author_pr_budget_exceeded",
      summary,
      coverageProofFallbackRefs: false,
      bestSolution:
        "Close this lowest-signal PR for now. Finish or close other open PRs to free review budget, then reopen this PR once the author is under budget; adding real behavior proof also makes it eligible for reconsideration.",
      evidence: [
        `- **live author budget:** ${author} has ${state.openPrCount} open PRs in this repository; the configured budget is ${state.budget}.`,
        `- **lowest-signal classification:** overall PR rating is \`${rating.overallTier}\` and real behavior proof is \`${proof.status}\`.`,
        `- **inactivity floor:** the PR and its current-head commit, status, and check-run activity are all older than ${AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS} days.`,
      ].join("\n"),
      closeComment: `Thanks for the contribution. ${summary}`,
    };
  }

  function applyAuthorPrBudgetStateToReport(
    markdown: string,
    state: AuthorPrBudgetApplyState,
  ): string {
    const promotion = authorPrBudgetPromotion(markdown, state);
    let next = replaceSectionValue(markdown, REVIEW_SECTIONS.summary, promotion.summary);
    next = replaceSectionValue(next, REVIEW_SECTIONS.bestSolution, promotion.bestSolution);
    next = replaceSectionValue(next, REVIEW_SECTIONS.evidence, promotion.evidence);
    return replaceSectionValue(next, REVIEW_SECTIONS.closeComment, promotion.closeComment);
  }

  function closePromotionHasNonAutomationActivityAfterReview(
    markdown: string,
    context: ItemContext,
  ): boolean {
    const reviewedAtMs = timestampMs(frontMatterValue(markdown, "reviewed_at"));
    if (reviewedAtMs === null) return true;
    return contextHasNonAutomationActivityAfter(context, reviewedAtMs);
  }

  function contextHasNonAutomationActivityAfter(
    context: ItemContext,
    reviewedAtMs: number,
    options: {
      truncationCountsAsActivity?: boolean;
      useCompleteActivityContext?: boolean;
      ignoreTimelineCommentsThroughMs?: number;
      ignoreTrustedTimelineComment?: {
        authors: ReadonlySet<string>;
        createdAt: string;
      };
    } = {},
  ): boolean {
    const truncationCountsAsActivity = options.truncationCountsAsActivity ?? true;
    const activityContextTruncated = Boolean(
      context.counts?.commentsTruncated ||
      context.counts?.timelineTruncated ||
      context.counts?.pullReviewCommentsTruncated,
    );
    const completeActivityContext = options.useCompleteActivityContext
      ? context[completeActivityContextSymbol]
      : undefined;
    if (truncationCountsAsActivity && activityContextTruncated && !completeActivityContext) {
      return true;
    }
    const hasNonAutomationComment = (comment: unknown): boolean => {
      const record = asRecord(comment);
      return (
        isAfterReview(comment, reviewedAtMs) &&
        !isAutomationReportAuthor(stringOrUndefined(record.author))
      );
    };
    const hasNonAutomationEvent = (event: unknown): boolean => {
      const record = asRecord(event);
      const eventActor = (stringOrUndefined(record.actor) ?? "").trim().toLowerCase();
      const trustedTimelineComment = options.ignoreTrustedTimelineComment;
      if (
        stringOrUndefined(record.event) === "commented" &&
        trustedTimelineComment &&
        eventTimestampMs(event) === timestampMs(trustedTimelineComment.createdAt) &&
        trustedTimelineComment.authors.has(eventActor)
      ) {
        return false;
      }
      // Issue comments are checked above with their bodies. Ignore timeline
      // duplicates only through the completed review; later commands are fresh
      // activity and must keep stale labels from being restored.
      if (
        stringOrUndefined(record.event) === "commented" &&
        options.ignoreTimelineCommentsThroughMs !== undefined
      ) {
        const eventMs = eventTimestampMs(event);
        if (eventMs !== null && eventMs <= options.ignoreTimelineCommentsThroughMs) return false;
      }
      return (
        isAfterReview(event, reviewedAtMs) &&
        !isAutomationReportAuthor(stringOrUndefined(record.actor))
      );
    };
    return (
      (completeActivityContext?.comments ?? context.comments).some(hasNonAutomationComment) ||
      (completeActivityContext?.pullReviewComments ?? context.pullReviewComments ?? []).some(
        hasNonAutomationComment,
      ) ||
      (completeActivityContext?.timeline ?? context.timeline).some(hasNonAutomationEvent)
    );
  }

  function contextHasNonAutomationActivityAfterForTest(options: {
    comments?: unknown[];
    timeline?: unknown[];
    pullReviewComments?: unknown[];
    truncated?: {
      comments?: boolean;
      timeline?: boolean;
      pullReviewComments?: boolean;
    };
    completeActivityContext?: Partial<CompleteActivityContext>;
    activityAfterMs: number;
    ignoreTimelineCommentsThroughMs?: number;
  }): boolean {
    const context: ItemContext = {
      issue: {},
      comments: options.comments ?? [],
      timeline: options.timeline ?? [],
      pullReviewComments: options.pullReviewComments ?? [],
      counts: {
        comments: options.comments?.length ?? 0,
        commentsTruncated: options.truncated?.comments ?? false,
        timeline: options.timeline?.length ?? 0,
        timelineTruncated: options.truncated?.timeline ?? false,
        pullReviewCommentsTruncated: options.truncated?.pullReviewComments ?? false,
      },
    };
    if (options.completeActivityContext) {
      context[completeActivityContextSymbol] = {
        comments: options.completeActivityContext.comments ?? [],
        timeline: options.completeActivityContext.timeline ?? [],
        pullReviewComments: options.completeActivityContext.pullReviewComments ?? [],
      };
    }
    return contextHasNonAutomationActivityAfter(context, options.activityAfterMs, {
      ...(options.completeActivityContext ? { useCompleteActivityContext: true } : {}),
      ...(options.ignoreTimelineCommentsThroughMs === undefined
        ? {}
        : { ignoreTimelineCommentsThroughMs: options.ignoreTimelineCommentsThroughMs }),
    });
  }

  const pullRequestReferenceParser = createPullRequestReferenceParser({
    targetRepo,
    repoUrlFor,
    reportReferenceTexts(markdown) {
      return [
        ...frontMatterStringArray(markdown, "work_cluster_refs"),
        ...mergeRiskOptionsFromReport(markdown).flatMap((option) => [option.title, option.body]),
        reviewSectionValue(markdown, "bestSolution"),
        reviewSectionValue(markdown, "evidence"),
        reviewSectionValue(markdown, "closeComment"),
      ];
    },
  });

  const {
    linkedPullRequestNumbersFromReport,
    linkedPullRequestRefsFromReport,
    linkedPullRequestRefsFromText,
    linkedPullRequestSignalContextsFromText,
    pullRequestUrlForNumber,
  } = pullRequestReferenceParser;

  function linkedPullRequestHasSupersessionSignal(
    markdown: string,
    currentNumber: number,
    linkedNumber: number,
  ): boolean {
    const signal =
      /\b(supersed(?:e|ed|es|ing)|replace(?:s|d|ment)?|duplicate|duplicated|canonical|covered by|landed in)\b/i;
    const texts = [
      ...frontMatterStringArray(markdown, "work_cluster_refs"),
      ...mergeRiskOptionsFromReport(markdown).flatMap((option) => [option.title, option.body]),
      reviewSectionValue(markdown, "bestSolution"),
      reviewSectionValue(markdown, "evidence"),
      reviewSectionValue(markdown, "closeComment"),
    ];
    return texts.some((text) =>
      linkedPullRequestSignalContextsFromText(text, currentNumber, linkedNumber).some((context) =>
        signal.test(context),
      ),
    );
  }

  function linkedPullRequestSupersession(
    markdown: string,
    item: Item,
    options: { reportDirs?: readonly string[] } = {},
  ): LinkedPullRequestSupersessionResolution {
    let unsafeReason: string | null = null;
    for (const number of linkedPullRequestNumbersFromReport(markdown, item.number)) {
      try {
        const hasSupersessionSignal = linkedPullRequestHasSupersessionSignal(
          markdown,
          item.number,
          number,
        );
        const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
        const state = stringOrUndefined(pull.state)?.toLowerCase() ?? "";
        const mergedAt = stringOrUndefined(pull.merged_at) ?? null;
        if (!hasSupersessionSignal) continue;
        const linkedFiles = linkedPullRequestFiles(number);
        const linkedPull: LinkedPullRequestSupersession = {
          number,
          title: stringOrUndefined(pull.title) ?? `PR #${number}`,
          url: stringOrUndefined(pull.html_url) ?? pullRequestUrlForNumber(number),
          state,
          mergedAt,
          mergeableState: stringOrUndefined(pull.mergeable_state)?.toLowerCase() ?? null,
          draft: pull.draft === true,
          labels: linkedPullRequestLabels(number, pull),
          files: linkedFiles.files,
          filesKnown: linkedFiles.known,
        };
        if (linkedPullCannotSupersedeDocsOnlySource(markdown, linkedPull)) continue;
        const candidateUnsafeReason = unsafeCanonicalPullRequestReason(linkedPull, options);
        if (candidateUnsafeReason !== null) {
          unsafeReason ??= candidateUnsafeReason;
          continue;
        }
        return { candidate: linkedPull, unsafeReason: null };
      } catch {
        // Missing or cross-repo stale references are not close evidence.
      }
    }
    return { candidate: null, unsafeReason };
  }

  function linkedPullRequestLabels(number: number, pull: Record<string, unknown>): string[] {
    const labels = labelNames(pull.labels);
    if (labels.length) return labels;
    try {
      return ghJson<string[]>([
        "api",
        `repos/${targetRepo()}/issues/${number}`,
        "--jq",
        "[.labels[].name]",
      ]);
    } catch {
      return [];
    }
  }

  function linkedPullRequestFiles(number: number): { files: string[]; known: boolean } {
    try {
      const files = ghJson<unknown[]>([
        "api",
        `repos/${targetRepo()}/pulls/${number}/files?per_page=100`,
        "--jq",
        "[.[].filename]",
      ]);
      return {
        files: files.filter((file): file is string => typeof file === "string"),
        known: true,
      };
    } catch {
      return { files: [], known: false };
    }
  }

  function linkedPullCannotSupersedeDocsOnlySource(
    sourceMarkdown: string,
    linkedPull: LinkedPullRequestSupersession,
  ): boolean {
    if (!isDocsOnlyPullRequestReport(sourceMarkdown)) return false;
    if (!linkedPull.filesKnown) return true;
    return linkedPull.files.length === 0 || !linkedPull.files.every(isDocsPath);
  }

  function linkedPullRequestReportMarkdown(
    number: number,
    reportDirs: readonly string[] | undefined,
  ): string | null {
    if (!reportDirs?.length) return null;
    const file = reportFileName(targetRepo(), number);
    for (const dir of reportDirs) {
      const path = join(dir, file);
      if (existsSync(path)) return readFileSync(path, "utf8");
    }
    return null;
  }

  function proofPassedInReport(markdown: string | null): boolean {
    if (!markdown) return false;
    const proof = reportRealBehaviorProof(markdown);
    return proof.status === "sufficient" || proof.status === "override";
  }

  function proofPassedInLabels(labels: readonly string[]): boolean {
    return labels.some((label) => /^proof:\s*(sufficient|override)\b/i.test(label));
  }

  function unsafeCanonicalPullRequestReason(
    linkedPull: LinkedPullRequestSupersession,
    options: { reportDirs?: readonly string[] } = {},
  ): string | null {
    if (linkedPull.mergedAt) return null;
    if (linkedPull.state !== "open") {
      return `linked canonical PR #${linkedPull.number} is ${linkedPull.state || "not open"} and unmerged`;
    }
    if (linkedPull.draft) {
      return `linked canonical PR #${linkedPull.number} is still draft`;
    }
    if (!linkedPull.mergeableState || linkedPull.mergeableState === "unknown") {
      return `linked canonical PR #${linkedPull.number} mergeability is not known`;
    }
    if (linkedPull.mergeableState === "dirty") {
      return `linked canonical PR #${linkedPull.number} has merge conflicts`;
    }
    // GitHub reports "behind" for a conflict-free PR that only needs a base update.
    if (linkedPull.mergeableState !== "clean" && linkedPull.mergeableState !== "behind") {
      return `linked canonical PR #${linkedPull.number} is not cleanly mergeable (${linkedPull.mergeableState})`;
    }

    const report = linkedPullRequestReportMarkdown(linkedPull.number, options.reportDirs);
    const labels = linkedPull.labels.map(normalizeLabelName);
    const labelProofPassed = proofPassedInLabels(linkedPull.labels);
    const liveNeedsProof = labels.some(
      (label) =>
        label === "triage: needs-real-behavior-proof" ||
        (label.startsWith("status:") && label.includes("needs proof")),
    );
    const reportProofPassed = proofPassedInReport(report);
    const proofPassed = reportProofPassed || labelProofPassed;

    if (labels.some((label) => label.startsWith("rating:") && label.includes("unranked"))) {
      return `linked canonical PR #${linkedPull.number} is F-rated`;
    }
    if (liveNeedsProof && !labelProofPassed) {
      return `linked canonical PR #${linkedPull.number} is still waiting for real behavior proof`;
    }

    if (report) {
      if (
        frontMatterValue(report, "decision") === "close" &&
        frontMatterValue(report, "confidence") === "high"
      ) {
        return `linked canonical PR #${linkedPull.number} is itself proposed for close`;
      }
      const proof = reportRealBehaviorProof(report);
      if (
        !proofPassed &&
        (proof.status === "missing" ||
          proof.status === "mock_only" ||
          proof.status === "insufficient")
      ) {
        return `linked canonical PR #${linkedPull.number} is still waiting for real behavior proof`;
      }
      const rating = reportPrRating(report);
      if (rating.overallTier === "F" || rating.proofTier === "F" || rating.patchTier === "F") {
        return `linked canonical PR #${linkedPull.number} is F-rated`;
      }
    }
    if (!proofPassed) {
      return `linked canonical PR #${linkedPull.number} has no positive real behavior proof`;
    }

    return null;
  }

  return {
    reportDecision,
    livePullRequestHasNoDiff,
    upgradeNoDiffPullRequestReport,
    upgradePullRequestClosePromotionReport,
    authorPrBudgetPromotion,
    applyAuthorPrBudgetStateToReport,
    closePromotionHasNonAutomationActivityAfterReview,
    contextHasNonAutomationActivityAfter,
    contextHasNonAutomationActivityAfterForTest,
    pullRequestReferenceParser,
    linkedPullRequestNumbersFromReport,
    linkedPullRequestRefsFromReport,
    linkedPullRequestRefsFromText,
    linkedPullRequestSignalContextsFromText,
    pullRequestUrlForNumber,
    linkedPullRequestHasSupersessionSignal,
    linkedPullRequestSupersession,
    linkedPullRequestLabels,
    linkedPullRequestFiles,
    linkedPullCannotSupersedeDocsOnlySource,
    linkedPullRequestReportMarkdown,
    proofPassedInReport,
    proofPassedInLabels,
    unsafeCanonicalPullRequestReason,
  };
}

// Ambiguous (possibly spoofed) front matter must demote the item to human
// review, not crash the promotion batch: close-decision gating blocks any
// close while maintainerDecision.required is true.
export function ambiguityGuardedMaintainerDecision(markdown: string): MaintainerDecision {
  try {
    return maintainerDecisionFromReport(markdown) ?? emptyMaintainerDecision();
  } catch {
    return {
      required: true,
      kind: "manual_review",
      question: "Report front matter is ambiguous or possibly spoofed; review manually.",
      rationale: "Duplicate front-matter metadata detected outside the leading block.",
      options: [],
      likelyOwner: { person: "", reason: "", confidence: "low" },
    };
  }
}
