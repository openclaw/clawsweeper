import { parseOversizedPullRequestEvidence } from "./clawsweeper-oversized-pr-policy.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS,
  REVIEW_SECTIONS,
  isGitHubVerifiedFixedPullRequestSource,
} from "./clawsweeper-policy.js";
import { pullRequestUrlForNumber } from "./clawsweeper-pr-references.js";
import {
  defaultAgentsPolicyStatus,
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
  reportSecurityReview,
  reportTelegramVisibleProof,
  reportTestingReview,
  reportVisionFit,
  reviewMetricsFromReport,
  triagePriorityFromReport,
} from "./clawsweeper-report-parser.js";
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
import { emptyMaintainerDecision, type MaintainerDecision } from "./decision-packets.js";
import type { CreateReportOrchestrationDependencies } from "./clawsweeper-report-orchestration-dependencies.js";
import { renderCloseCommentFromReport } from "./clawsweeper-report-comment-helpers.js";
import { fixedPullRequestFromReport } from "./clawsweeper-status-context.js";
import { asRecord, nonBlankStringOrUndefined } from "./value-coerce.js";
import { parseIsoMs } from "./iso-time.js";
import { evidenceEntry, hostEvidenceMarkdown } from "./clawsweeper-report-helpers.js";
import { ReviewRecordFormatError, updateReviewRecordDecision } from "./review-record.js";
import {
  frontMatterStringArray,
  frontMatterValue,
  replaceFrontMatterValue,
  replaceSectionValue,
} from "./report-front-matter.js";
import { isAutomationReportAuthor } from "./clawsweeper-item-policy.js";
import { reportFileName } from "./clawsweeper-repository-paths.js";
import { reviewSectionValue } from "./clawsweeper-record-metadata.js";
import { eventTimestampMs, isAfterReview } from "./clawsweeper-label-policy.js";
import { reportReviewDecision } from "./report-review-decision.js";

export function createPullRequestPromotionFacts(
  dependencies: CreateReportOrchestrationDependencies,
) {
  const {
    defaultRootCauseCluster,
    ghJson,
    itemSnapshotHash,
    labelNames,
    normalizeLabelName,
    parseGitHubItemRef,
    targetProfile,
    targetRepo,
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
    const oversized = parseOversizedPullRequestEvidence(
      frontMatterValue(markdown, "oversized_pull_request"),
    );
    return {
      ...(closeReason === "oversized_pull_request" && oversized
        ? { oversizedPullRequest: oversized }
        : {}),
      decision: "close",
      closeReason,
      confidence: "high",
      summary: reviewSectionValue(markdown, "summary"),
      changeSummary: reviewSectionValue(markdown, "changeSummary"),
      changeExample: reportChangeExample(markdown),
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
      productReview: reportProductReview(markdown),
      provenance: reportProvenance(markdown),
      testingReview: reportTestingReview(markdown),
      reviewFindings: reportReviewFindings(markdown),
      securityReview: reportSecurityReview(markdown),
      realBehaviorProof: reportRealBehaviorProof(markdown),
      prRating: reportPrRating(markdown),
      telegramVisibleProof: reportTelegramVisibleProof(markdown),
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
    const summary =
      "Close this PR: GitHub reports no changed files against the current base branch.";
    const bestSolution =
      "Close this PR: GitHub reports no changed files against the current base branch, so the branch is already empty or superseded by `main`.";
    const evidence = [
      evidenceEntry({
        label: "live no-diff PR",
        detail:
          "GitHub reports `changed_files: 0` for this open PR, so there is no remaining branch diff to merge.",
        command,
      }),
    ];
    const rootCauseCluster = defaultRootCauseCluster();
    let upgraded = markdown;
    upgraded = replaceFrontMatterValue(upgraded, "decision", "close");
    upgraded = replaceFrontMatterValue(upgraded, "close_reason", "duplicate_or_superseded");
    upgraded = replaceFrontMatterValue(upgraded, "confidence", "high");
    upgraded = replaceFrontMatterValue(upgraded, "action_taken", "proposed_close");
    // GitHub's zero-file diff is the close evidence. Clear the typed canonical
    // and fixing-PR candidates so no coverage proof can block this close.
    upgraded = replaceFrontMatterValue(upgraded, "pr_close_requires_canonical_pr", "false");
    upgraded = replaceFrontMatterValue(
      upgraded,
      "root_cause_cluster",
      JSON.stringify(rootCauseCluster),
    );
    upgraded = replaceFrontMatterValue(upgraded, "fixed_pr_url", "unknown");
    upgraded = replaceFrontMatterValue(upgraded, "fixed_pr_number", "unknown");
    upgraded = replaceFrontMatterValue(upgraded, "work_cluster_refs", "[]");
    upgraded = replaceFrontMatterValue(upgraded, "merge_risk_options", "[]");
    upgraded = replaceFrontMatterValue(upgraded, "work_candidate", "none");
    upgraded = replaceFrontMatterValue(upgraded, "work_status", "none");
    upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.summary, summary);
    upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.bestSolution, bestSolution);
    upgraded = replaceSectionValue(
      upgraded,
      REVIEW_SECTIONS.evidence,
      hostEvidenceMarkdown(evidence),
    );
    upgraded = updateReviewRecordDecision(upgraded, () => ({
      decision: "close",
      closeReason: "duplicate_or_superseded",
      confidence: "high",
      rootCauseCluster,
      fixedPullRequest: null,
      workClusterRefs: [],
      mergeRiskOptions: [],
      workCandidate: "none",
      summary,
      bestSolution,
      evidence,
    }));
    const closeComment = renderCloseCommentFromReport(
      upgraded,
      "duplicate_or_superseded",
      targetProfile(),
    );
    upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.closeComment, closeComment);
    return updateReviewRecordDecision(upgraded, () => ({ closeComment }));
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
    // A promotion closes on GitHub facts or a typed review field, not on a model
    // duplicate claim, so it does not need rootCauseCluster.canonicalRef.
    upgraded = replaceFrontMatterValue(upgraded, "pr_close_requires_canonical_pr", "false");
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
    upgraded = replaceSectionValue(
      upgraded,
      REVIEW_SECTIONS.evidence,
      hostEvidenceMarkdown(promotion.evidence),
    );
    upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.closeComment, promotion.closeComment);
    return updateReviewRecordDecision(upgraded, () => ({
      decision: "close",
      closeReason: promotion.closeReason,
      confidence: "high",
      workCandidate: "none",
      summary: promotion.summary,
      bestSolution: promotion.bestSolution,
      evidence: promotion.evidence,
      closeComment: promotion.closeComment,
    }));
  }

  function authorPrBudgetPromotion(
    markdown: string,
    state: AuthorPrBudgetApplyState,
  ): PullRequestClosePromotion {
    const { realBehaviorProof: proof, prRating: rating } = reportReviewDecision(markdown);
    const author = `@${state.author.replace(/^@/, "")}`;
    const summary = `${author} currently has ${state.openPrCount} open PRs in this repository, above the budget of ${state.budget}. ClawSweeper is closing this PR as one of the author's lowest-signal submissions under that budget: its overall rating is ${rating.overallTier} and its real behavior proof is ${proof.status}. Closing or finishing other PRs frees review budget, and this PR can be reopened once the author is under budget or when real proof is added.`;
    return {
      closeReason: "author_pr_budget_exceeded",
      summary,
      bestSolution:
        "Close this lowest-signal PR for now. Finish or close other open PRs to free review budget, then reopen this PR once the author is under budget; adding real behavior proof also makes it eligible for reconsideration.",
      evidence: [
        evidenceEntry({
          label: "live author budget",
          detail: `${author} has ${state.openPrCount} open PRs in this repository; the configured budget is ${state.budget}.`,
        }),
        evidenceEntry({
          label: "lowest-signal classification",
          detail: `overall PR rating is \`${rating.overallTier}\` and real behavior proof is \`${proof.status}\`.`,
        }),
        evidenceEntry({
          label: "inactivity floor",
          detail: `the PR and its current-head commit, status, and check-run activity are all older than ${AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS} days.`,
        }),
      ],
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
    next = replaceSectionValue(
      next,
      REVIEW_SECTIONS.evidence,
      hostEvidenceMarkdown(promotion.evidence),
    );
    next = replaceSectionValue(next, REVIEW_SECTIONS.closeComment, promotion.closeComment);
    return updateReviewRecordDecision(next, () => ({
      summary: promotion.summary,
      bestSolution: promotion.bestSolution,
      evidence: promotion.evidence,
      closeComment: promotion.closeComment,
    }));
  }

  function closePromotionHasNonAutomationActivityAfterReview(
    markdown: string,
    context: ItemContext,
  ): boolean {
    const reviewedAtMs = parseIsoMs(frontMatterValue(markdown, "reviewed_at"));
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
        !isAutomationReportAuthor(nonBlankStringOrUndefined(record.author))
      );
    };
    const hasNonAutomationEvent = (event: unknown): boolean => {
      const record = asRecord(event);
      const eventActor = (nonBlankStringOrUndefined(record.actor) ?? "").trim().toLowerCase();
      const trustedTimelineComment = options.ignoreTrustedTimelineComment;
      if (
        nonBlankStringOrUndefined(record.event) === "commented" &&
        trustedTimelineComment &&
        eventTimestampMs(event) === parseIsoMs(trustedTimelineComment.createdAt) &&
        trustedTimelineComment.authors.has(eventActor)
      ) {
        return false;
      }
      // Issue comments are checked above with their bodies. Ignore timeline
      // duplicates only through the completed review; later commands are fresh
      // activity and must keep stale labels from being restored.
      if (
        nonBlankStringOrUndefined(record.event) === "commented" &&
        options.ignoreTimelineCommentsThroughMs !== undefined
      ) {
        const eventMs = eventTimestampMs(event);
        if (eventMs !== null && eventMs <= options.ignoreTimelineCommentsThroughMs) return false;
      }
      return (
        isAfterReview(event, reviewedAtMs) &&
        !isAutomationReportAuthor(nonBlankStringOrUndefined(record.actor))
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

  // The review model names the canonical item in `rootCauseCluster.canonicalRef`,
  // and the runtime records a GitHub-verified merged fixing PR in `fixed_pr_*`.
  // Only these typed facts name a PR that can cover this one; report prose never does.
  function canonicalPullRequestNumbersFromReport(
    markdown: string,
    currentNumber: number,
  ): number[] {
    const numbers = new Set<number>();
    const review = reportReviewDecision(markdown);
    const canonicalRef = review.rootCauseCluster.canonicalRef;
    if (canonicalRef) {
      const parsed = parseGitHubItemRef(canonicalRef, "root_cause_cluster.canonicalRef");
      if (parsed.kind === "pull_request") numbers.add(parsed.number);
    }
    const fixedPullRequest = review.fixedPullRequest;
    if (
      fixedPullRequest?.confidence === "high" &&
      isGitHubVerifiedFixedPullRequestSource(fixedPullRequest.source)
    ) {
      numbers.add(fixedPullRequest.number);
    }
    numbers.delete(currentNumber);
    return [...numbers];
  }

  function linkedPullRequestSupersession(
    markdown: string,
    item: Item,
    options: { reportDirs?: readonly string[] } = {},
  ): LinkedPullRequestSupersessionResolution {
    let unsafeReason: string | null = null;
    for (const number of canonicalPullRequestNumbersFromReport(markdown, item.number)) {
      try {
        const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
        const state = nonBlankStringOrUndefined(pull.state)?.toLowerCase() ?? "";
        const mergedAt = nonBlankStringOrUndefined(pull.merged_at) ?? null;
        const linkedPull: LinkedPullRequestSupersession = {
          number,
          title: nonBlankStringOrUndefined(pull.title) ?? `PR #${number}`,
          url:
            nonBlankStringOrUndefined(pull.html_url) ??
            pullRequestUrlForNumber(targetRepo(), number),
          state,
          mergedAt,
          mergeableState: nonBlankStringOrUndefined(pull.mergeable_state)?.toLowerCase() ?? null,
          draft: pull.draft === true,
          labels: linkedPullRequestLabels(number, pull),
        };
        const candidateUnsafeReason = unsafeCanonicalPullRequestReason(linkedPull, options);
        if (candidateUnsafeReason !== null) {
          unsafeReason ??= candidateUnsafeReason;
          continue;
        }
        return { candidate: linkedPull, unsafeReason: null };
      } catch (error) {
        if (error instanceof ReviewRecordFormatError) {
          return {
            candidate: null,
            unsafeReason: `linked canonical PR #${number} has an unreadable review record; fresh review required`,
          };
        }
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
    const proof = reportReviewDecision(markdown).realBehaviorProof;
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
      const review = reportReviewDecision(report);
      if (review.decision === "close" && review.confidence === "high") {
        return `linked canonical PR #${linkedPull.number} is itself proposed for close`;
      }
      const proof = review.realBehaviorProof;
      if (
        !proofPassed &&
        (proof.status === "missing" ||
          proof.status === "mock_only" ||
          proof.status === "insufficient")
      ) {
        return `linked canonical PR #${linkedPull.number} is still waiting for real behavior proof`;
      }
      const rating = review.prRating;
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
    canonicalPullRequestNumbersFromReport,
    linkedPullRequestSupersession,
    linkedPullRequestLabels,
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
  const review = reportReviewDecision(markdown);
  if (!review.maintainerDecisionInvalid) {
    return review.maintainerDecision ?? emptyMaintainerDecision();
  }
  return {
    required: true,
    kind: "manual_review",
    question: "Report front matter is ambiguous or possibly spoofed; review manually.",
    rationale: "Duplicate front-matter metadata detected outside the leading block.",
    options: [],
    likelyOwner: { person: "", reason: "", confidence: "low" },
  };
}
