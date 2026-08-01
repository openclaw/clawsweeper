import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  configSurfaceChangeFromContext,
  dataModelChangeFromContext,
} from "./clawsweeper-change-detection.js";
import { closeReasonText } from "./clawsweeper-close-reasons.js";
import { REVIEW_SECTIONS } from "./clawsweeper-policy.js";
import { hasShinyProof, themedRatingName } from "./clawsweeper-rating.js";
import type {
  Action,
  ActionTaken,
  AgentsPolicyStatus,
  CloseReason,
  Decision,
  Evidence,
  FixedPullRequest,
  GitInfo,
  Item,
  ItemContext,
  ItemKind,
  LabelJustification,
  LabelTransitionJustification,
  LikelyOwner,
  MantisRecommendation,
  MergeRiskOption,
  OverallCorrectness,
  PrRating,
  PublicBeforeMergeItem,
  PublicPriority,
  RealBehaviorProof,
  ReviewCommentRenderOptions,
  ReviewContextLedgerEntry,
  ReviewFinding,
  ReviewMetric,
  ReviewRuntime,
  RootCauseClusterAssessment,
  SecurityConcern,
  SecurityReview,
  TriagePriority,
} from "./clawsweeper-types.js";
import {
  maintainerDecisionFromReport,
  renderDecisionPacketPublicBlock,
} from "./decision-packets.js";
import { type PrSurfaceFile } from "./pr-surface-stats.js";
import {
  appendReviewHistoryCycle,
  neutralizeReviewControlMarkers,
  parseReviewHistory,
  renderReviewHistorySection,
  reviewHistoryCycleFromCommentBody,
  type ReviewHistoryLedger,
} from "./review-history.js";
import { type ReviewSemanticRecord } from "./review-semantic-cache.js";
import {
  reviewStructuralPullStateDigest,
  type ReviewStructuralPullState,
  type ReviewStructuralRecord,
} from "./review-structural-cache.js";

interface CreateReportRenderingDependencies {
  agentsPolicyStatusLine: (status: AgentsPolicyStatus | undefined) => string;
  asRecord: (value: unknown) => Record<string, unknown>;
  closeClawHubHandoffBlock: (reason: CloseReason) => string;
  closeEvidenceLine: (evidence: Evidence) => string;
  closeIntro: (reason: CloseReason) => string;
  closeOutro: (reason: CloseReason, canonicalLinks?: string[]) => string;
  collectItemContext: (
    item: Item,
    options?: {
      fullTimelineForRelations?: boolean;
      reviewCacheDigest?: boolean;
      reviewCacheGitDir?: string;
    },
  ) => ItemContext;
  compactPullFilePaths: (value: unknown) => string[];
  confidenceText: (score: number) => string;
  duplicateCanonicalLinks: (options: {
    reason: CloseReason;
    bestSolutionLine: string;
    evidence: Evidence[];
    currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
  }) => string[];
  duplicateCanonicalPathLine: (options: {
    reason: CloseReason;
    summaryLine: string;
    bestSolutionLine: string;
    evidence: Evidence[];
  }) => string;
  ensureDir: (path: string) => void;
  fileUrl: (file: string, sha: string, line?: number) => string;
  fixedInReportText: (markdown: string) => string;
  fixedInText: (decision: Decision) => string;
  fixedPullRequestFromReport: (markdown: string) => FixedPullRequest | null;
  formatReviewFreshnessTimestamp: (iso: string | undefined) => string;
  formattedMarkdownList: (
    values: readonly string[],
    formatter: (value: string) => string,
  ) => string;
  formatTimestamp: (iso: string | undefined) => string;
  frontMatterStringArray: (markdown: string, key: string) => string[];
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  ghJson: <T>(args: string[]) => T;
  ghObservedMutationCommand: (options: {
    identity: string;
    args: string[];
    attempts?: number | undefined;
    onMutation?: (() => void) | undefined;
    didMutate?: ((result: string) => boolean) | undefined;
    knownNoMutation?: ((error: unknown) => boolean) | undefined;
    request?: ((args: string[], attempt: number) => string) | undefined;
    prepareRequest?: ((args: string[], attempt: number) => () => string) | undefined;
    sleepBeforeRetry?: ((waitMs: number) => void) | undefined;
  }) => string;
  hasUsableCloseComment: (closeComment: string) => boolean;
  inlineCode: (value: string) => string;
  isActionablePriorityText: (text: string) => boolean;
  isImplementationCloseReason: (reason: CloseReason) => boolean;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  isReportNoneList: (value: string) => boolean;
  isRoutineCiOrReviewText: (text: string) => boolean;
  isVerifiedFixedCloseReason: (reason: unknown) => boolean;
  jsonFrontMatterValue: (value: readonly unknown[]) => string;
  labelJustificationsFromPublicReport: (
    markdown: string,
    options?: ReviewCommentRenderOptions,
  ) => LabelJustification[];
  labelJustificationsMarkdown: (justifications: readonly LabelJustification[]) => string;
  labelTransitionJustificationsFromPublicReport: (
    markdown: string,
    finalJustifications: readonly LabelJustification[],
    options?: ReviewCommentRenderOptions,
  ) => LabelTransitionJustification[];
  labelTransitionJustificationsMarkdown: (
    justifications: readonly LabelTransitionJustification[],
  ) => string;
  likelyOwnerLine: (owner: LikelyOwner) => string;
  linkedRelease: (tag: string) => string;
  linkedSha: (sha: string) => string;
  markdownLink: (label: string, url: string) => string;
  markdownRepository: (markdown: string, file?: string) => string;
  mergeRiskOptionsFromReport: (markdown: string) => MergeRiskOption[];
  neutralizeOwnedSectionSpoofing: (value: string) => string;
  normalizePublicReviewText: (value: string) => string;
  priorityLabel: (priority: ReviewFinding["priority"]) => string;
  prSurfaceFilesFromContext: (context: ItemContext) => PrSurfaceFile[];
  publicFailedReviewReadinessBlock: (markdown: string) => string;
  publicLikelyOwnerRole: (role: string) => string;
  publicMantisRecommendationBlock: (recommendation: MantisRecommendation) => string;
  publicMergeReadinessBlock: (
    rating: PrRating,
    proof: RealBehaviorProof,
    priority: TriagePriority,
    bottomLine: string,
    remainingItemCount: number,
    decisionNeeded: boolean,
    reviewedHeadSha: string,
  ) => string;
  publicNonDispatchableMantisRecommendationBlock: (recommendation: MantisRecommendation) => string;
  publicPriorityBulletFromText: (text: string, fallback: PublicPriority) => string;
  publicPriorityBulletIfActionable: (text: string, fallback: PublicPriority) => string;
  publicPriorityFromText: (text: string, fallback: PublicPriority) => PublicPriority;
  publicRankDetailsBlock: () => string;
  publicRealBehaviorProofLine: (proof: RealBehaviorProof) => string;
  publicReviewScoresBlock: (
    rating: PrRating,
    proof: RealBehaviorProof,
    findings: readonly ReviewFinding[],
    securityReview: SecurityReview,
  ) => string;
  publicReviewTextDiffers: (left: string, right: string) => boolean;
  publicReviewTextIsSame: (left: string, right: string) => boolean;
  publicRiskBulletsFromText: (text: string, fallback: PublicPriority) => string;
  publicSecurityReviewLine: (review: SecurityReview) => string;
  publicVerificationBlock: (
    proof: RealBehaviorProof,
    evidence: readonly Evidence[],
    findings: readonly ReviewFinding[],
    securityReview: SecurityReview,
  ) => string;
  pullHeadShaFromContext: (context: ItemContext) => string | null;
  pullHeadShaFromReport: (markdown: string) => string | null;
  realBehaviorProofBlocksMerge: (markdown: string) => boolean;
  renderDataModelWarningFromReport: (markdown: string) => string;
  renderOpenClawPrSurfaceFromReport: (markdown: string) => string;
  renderReviewMetricsDigest: (metrics: readonly ReviewMetric[]) => string;
  repairLoopPassModeFromReport: (markdown: string) => "" | "autofix" | "automerge";
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
  repoRelativePath: (path: string) => string;
  reportAgentsPolicyStatus: (markdown: string) => AgentsPolicyStatus | undefined;
  reportEvidence: (markdown: string) => Evidence[];
  reportLikelyOwners: (markdown: string) => LikelyOwner[];
  reportMantisRecommendation: (markdown: string) => MantisRecommendation;
  reportOverallConfidenceScore: (markdown: string) => number;
  reportOverallCorrectness: (markdown: string) => OverallCorrectness;
  reportPrRating: (markdown: string) => PrRating;
  reportRealBehaviorProof: (markdown: string) => RealBehaviorProof;
  reportReviewFindings: (markdown: string) => ReviewFinding[];
  reportRootCauseCluster: (markdown: string) => RootCauseClusterAssessment;
  reportSecurityReview: (markdown: string) => SecurityReview;
  reviewAutomationMarkersFromReport: (markdown: string) => string;
  reviewFindingDetailedLine: (finding: ReviewFinding) => string;
  reviewFindingLocation: (finding: Pick<ReviewFinding, "file" | "lineStart" | "lineEnd">) => string;
  reviewFindingSummaryLine: (finding: ReviewFinding) => string;
  reviewMetricsFromReport: (markdown: string) => ReviewMetric[];
  reviewSectionValue: (
    markdown: string,
    section:
      | "summary"
      | "changeSummary"
      | "systemContext"
      | "architectureDiagram"
      | "bestSolution"
      | "maintainerDecision"
      | "reproductionAssessment"
      | "solutionAssessment"
      | "visionFit"
      | "rootCauseCluster"
      | "reviewFindings"
      | "securityReview"
      | "realBehaviorProof"
      | "prRating"
      | "telegramVisibleProof"
      | "mantisRecommendation"
      | "featureShowcase"
      | "agentsPolicyStatus"
      | "workCandidate"
      | "repairWorkPrompt"
      | "evidence"
      | "likelyOwners"
      | "risks"
      | "closeComment",
  ) => string;
  reviewStructuralPullStateFromContext: (context: ItemContext) => ReviewStructuralPullState | null;
  reviewVersionMarkerFromReport: (markdown: string) => string;
  ROOT: string;
  sanitizeArchitectureDiagram: (value: string) => string;
  securityConcernDetailedLine: (concern: SecurityConcern) => string;
  securityConcernLocation: (concern: SecurityConcern) => string;
  securityConcernSummaryLine: (concern: SecurityConcern) => string;
  securityReviewLine: (review: SecurityReview) => string;
  sentence: (value: string) => string;
  sha256: (text: string) => string;
  shouldRenderWorkPlanFromReport: (markdown: string) => boolean;
  splitFileAndLine: (file: string, explicitLine?: number | null) => { file: string; line?: number };
  stripPriorityPrefix: (text: string) => string;
  targetRepo: () => string;
  triagePriorityFromReport: (markdown: string) => TriagePriority;
  validateCloseDecision: (
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo" | "authorAssociation">>,
    decision: Decision,
    options?: { requireCloseComment?: boolean },
  ) => { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string };
  workCandidateReasonText: (section: string) => string;
  workPlanPathForReport: (file: string, plansDir?: string) => string;
  workStatusForDecision: (decision: Decision) => string;
}

export function createReportRendering(dependencies: CreateReportRenderingDependencies) {
  const {
    agentsPolicyStatusLine,
    asRecord,
    closeClawHubHandoffBlock,
    closeEvidenceLine,
    closeIntro,
    closeOutro,
    collectItemContext,
    compactPullFilePaths,
    confidenceText,
    duplicateCanonicalLinks,
    duplicateCanonicalPathLine,
    ensureDir,
    fileUrl,
    fixedInReportText,
    fixedInText,
    fixedPullRequestFromReport,
    formatReviewFreshnessTimestamp,
    formattedMarkdownList,
    formatTimestamp,
    frontMatterStringArray,
    frontMatterValue,
    ghJson,
    ghObservedMutationCommand,
    hasUsableCloseComment,
    inlineCode,
    isActionablePriorityText,
    isImplementationCloseReason,
    isMaintainerAuthored,
    isReportNoneList,
    isRoutineCiOrReviewText,
    isVerifiedFixedCloseReason,
    jsonFrontMatterValue,
    labelJustificationsFromPublicReport,
    labelJustificationsMarkdown,
    labelTransitionJustificationsFromPublicReport,
    labelTransitionJustificationsMarkdown,
    likelyOwnerLine,
    linkedRelease,
    linkedSha,
    markdownLink,
    markdownRepository,
    mergeRiskOptionsFromReport,
    neutralizeOwnedSectionSpoofing,
    normalizePublicReviewText,
    priorityLabel,
    prSurfaceFilesFromContext,
    publicFailedReviewReadinessBlock,
    publicLikelyOwnerRole,
    publicMantisRecommendationBlock,
    publicMergeReadinessBlock,
    publicNonDispatchableMantisRecommendationBlock,
    publicPriorityBulletFromText,
    publicPriorityBulletIfActionable,
    publicPriorityFromText,
    publicRankDetailsBlock,
    publicRealBehaviorProofLine,
    publicReviewScoresBlock,
    publicReviewTextDiffers,
    publicReviewTextIsSame,
    publicRiskBulletsFromText,
    publicSecurityReviewLine,
    publicVerificationBlock,
    pullHeadShaFromContext,
    pullHeadShaFromReport,
    realBehaviorProofBlocksMerge,
    renderDataModelWarningFromReport,
    renderOpenClawPrSurfaceFromReport,
    renderReviewMetricsDigest,
    repairLoopPassModeFromReport,
    replaceFrontMatterValue,
    repoRelativePath,
    reportAgentsPolicyStatus,
    reportEvidence,
    reportLikelyOwners,
    reportMantisRecommendation,
    reportOverallConfidenceScore,
    reportOverallCorrectness,
    reportPrRating,
    reportRealBehaviorProof,
    reportReviewFindings,
    reportRootCauseCluster,
    reportSecurityReview,
    reviewAutomationMarkersFromReport,
    reviewFindingDetailedLine,
    reviewFindingLocation,
    reviewFindingSummaryLine,
    reviewMetricsFromReport,
    reviewSectionValue,
    reviewStructuralPullStateFromContext,
    reviewVersionMarkerFromReport,
    ROOT,
    sanitizeArchitectureDiagram,
    securityConcernDetailedLine,
    securityConcernLocation,
    securityConcernSummaryLine,
    securityReviewLine,
    sentence,
    sha256,
    shouldRenderWorkPlanFromReport,
    splitFileAndLine,
    stripPriorityPrefix,
    targetRepo,
    triagePriorityFromReport,
    validateCloseDecision,
    workCandidateReasonText,
    workPlanPathForReport,
    workStatusForDecision,
  } = dependencies;

  function renderWorkPlanFromReport(
    markdown: string,
    options: { reportPath?: string } = {},
  ): string | null {
    if (!shouldRenderWorkPlanFromReport(markdown)) return null;
    const repo = markdownRepository(markdown);
    const number = frontMatterValue(markdown, "number") ?? "unknown";
    const title = frontMatterValue(markdown, "title") ?? "Untitled";
    const reviewedAt = frontMatterValue(markdown, "reviewed_at") ?? "unknown";
    const workPrompt = reviewSectionValue(markdown, "repairWorkPrompt").trim();
    const likelyFiles = frontMatterStringArray(markdown, "work_likely_files");
    const validation = frontMatterStringArray(markdown, "work_validation");
    const clusterRefs = frontMatterStringArray(markdown, "work_cluster_refs");
    const reportPath = options.reportPath ?? "unknown";
    return `---
number: ${number}
repository: ${repo}
title: ${JSON.stringify(title)}
source_report: ${reportPath}
reviewed_at: ${reviewedAt}
work_candidate: ${frontMatterValue(markdown, "work_candidate") ?? "none"}
work_priority: ${frontMatterValue(markdown, "work_priority") ?? "low"}
work_confidence: ${frontMatterValue(markdown, "work_confidence") ?? "low"}
---

# Coding Plan for ${repo}#${number}: ${title}

Source report: ${reportPath === "unknown" ? "unknown" : markdownLink(reportPath, reportPath)}

## Summary

${reviewSectionValue(markdown, "summary") || "No summary provided."}

## Plan

${workPrompt || "No repair work prompt provided."}

## Likely Files

${formattedMarkdownList(likelyFiles, inlineCode)}

## Validation

${formattedMarkdownList(validation, inlineCode)}

## Cluster References

${formattedMarkdownList(clusterRefs, (value) => value)}

## Notes

- This file is generated dashboard state from the durable review report.
- Regenerate it from the source report instead of editing it by hand.
`;
  }

  function syncWorkPlanFromReport(options: {
    markdown: string;
    reportPath: string;
    plansDir: string;
    dryRun?: boolean;
  }): boolean {
    const planPath = workPlanPathForReport(options.reportPath, options.plansDir);
    const plan = renderWorkPlanFromReport(options.markdown, {
      reportPath: repoRelativePath(options.reportPath),
    });
    if (!plan) {
      if (!options.dryRun && existsSync(planPath)) unlinkSync(planPath);
      return false;
    }
    if (!options.dryRun) {
      ensureDir(dirname(planPath));
      writeFileSync(planPath, plan, "utf8");
    }
    return true;
  }

  function runtimeReviewText(runtime?: {
    model?: string | undefined;
    reasoningEffort?: string | undefined;
  }): string {
    const model = runtime?.model?.trim();
    const reasoningEffort = runtime?.reasoningEffort?.trim();
    if (model && reasoningEffort) return `model ${model}, reasoning ${reasoningEffort}`;
    if (model) return `model ${model}`;
    if (reasoningEffort) return `reasoning ${reasoningEffort}`;
    return "";
  }

  function reviewTelemetryNumber(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return "unknown";
    return String(Math.max(0, Math.round(value)));
  }

  function contextCountText(
    total: number | undefined,
    fallback: number,
    hydrated?: number,
    truncated?: boolean,
  ): string {
    const displayTotal =
      total === undefined || !Number.isFinite(total) ? Math.max(0, fallback) : Math.max(0, total);
    if (hydrated === undefined || !Number.isFinite(hydrated)) return String(displayTotal);
    const displayHydrated = Math.max(0, Math.round(hydrated));
    if (!truncated && displayHydrated >= displayTotal) return String(displayTotal);
    return `${displayTotal} (hydrated ${displayHydrated}${truncated ? ", truncated" : ""})`;
  }

  function promptJsonChars(value: unknown): number {
    return JSON.stringify(value, null, 2).length;
  }

  function reviewContextLedgerEntry(options: {
    section: string;
    label: string;
    value: unknown;
    entries: number;
    total?: number | undefined;
    hydrated?: number | undefined;
    truncated?: boolean | undefined;
  }): ReviewContextLedgerEntry {
    const entry: ReviewContextLedgerEntry = {
      section: options.section,
      label: options.label,
      entries: Math.max(0, Math.round(options.entries)),
      chars: promptJsonChars(options.value),
    };
    if (options.total !== undefined && Number.isFinite(options.total)) {
      entry.total = Math.max(0, Math.round(options.total));
    }
    if (options.hydrated !== undefined && Number.isFinite(options.hydrated)) {
      entry.hydrated = Math.max(0, Math.round(options.hydrated));
    }
    if (options.truncated !== undefined) entry.truncated = options.truncated;
    return entry;
  }

  function arrayEntries(value: unknown[] | undefined): number {
    return value?.length ?? 0;
  }

  function reviewContextLedger(context: ItemContext): ReviewContextLedgerEntry[] {
    const counts = context.counts;
    const entries = [
      reviewContextLedgerEntry({
        section: "issue",
        label: "issue",
        value: context.issue,
        entries: 1,
      }),
      reviewContextLedgerEntry({
        section: "comments",
        label: "comments",
        value: context.comments,
        entries: context.comments.length,
        total: counts?.comments,
        hydrated: counts?.commentsHydrated,
        truncated: counts?.commentsTruncated,
      }),
      reviewContextLedgerEntry({
        section: "timeline",
        label: "timeline events",
        value: context.timeline,
        entries: context.timeline.length,
        total: counts?.timeline,
        hydrated: counts?.timelineHydrated,
        truncated: counts?.timelineTruncated,
      }),
      reviewContextLedgerEntry({
        section: "previousClawSweeperReview",
        label: "previous ClawSweeper review",
        value: context.previousClawSweeperReview ?? null,
        entries: context.previousClawSweeperReview === undefined ? 0 : 1,
      }),
      reviewContextLedgerEntry({
        section: "closingPullRequests",
        label: "closing PRs",
        value: context.closingPullRequests ?? [],
        entries: arrayEntries(context.closingPullRequests),
        total: counts?.closingPullRequests,
      }),
      reviewContextLedgerEntry({
        section: "relatedItems",
        label: "related items",
        value: context.relatedItems ?? [],
        entries: arrayEntries(context.relatedItems),
        total: counts?.relatedItems,
      }),
      reviewContextLedgerEntry({
        section: "pullRequest",
        label: "pull request",
        value: context.pullRequest ?? null,
        entries: context.pullRequest === undefined ? 0 : 1,
      }),
      reviewContextLedgerEntry({
        section: "pullFiles",
        label: "PR files",
        value: context.pullFiles ?? [],
        entries: arrayEntries(context.pullFiles),
        total: counts?.pullFiles,
        hydrated: counts?.pullFilesHydrated,
        truncated: counts?.pullFilesTruncated,
      }),
      reviewContextLedgerEntry({
        section: "pullCommits",
        label: "PR commits",
        value: context.pullCommits ?? [],
        entries: arrayEntries(context.pullCommits),
        total: counts?.pullCommits,
        hydrated: counts?.pullCommitsHydrated,
        truncated: counts?.pullCommitsTruncated,
      }),
      reviewContextLedgerEntry({
        section: "pullReviewComments",
        label: "PR review comments",
        value: context.pullReviewComments ?? [],
        entries: arrayEntries(context.pullReviewComments),
        total: counts?.pullReviewComments,
        hydrated: counts?.pullReviewCommentsHydrated,
        truncated: counts?.pullReviewCommentsTruncated,
      }),
      reviewContextLedgerEntry({
        section: "pullChecks",
        label: "PR checks",
        value: context.pullChecks ?? null,
        entries: context.pullChecks === undefined ? 0 : 1,
      }),
      reviewContextLedgerEntry({
        section: "counts",
        label: "context counts",
        value: counts ?? {},
        entries: Object.keys(counts ?? {}).length,
      }),
    ];
    return entries.filter((entry) => entry.entries > 0 || (entry.total ?? 0) > 0);
  }

  function reviewContextLedgerForTest(context: ItemContext): ReviewContextLedgerEntry[] {
    return reviewContextLedger(context);
  }

  function reviewContextLedgerCountText(entry: ReviewContextLedgerEntry): string {
    if (entry.total !== undefined || entry.hydrated !== undefined) {
      const total = entry.total ?? entry.entries;
      const hydrated = entry.hydrated ?? entry.entries;
      const suffix = entry.truncated ? ", truncated" : "";
      return `${hydrated}/${total} hydrated${suffix}`;
    }
    return `${entry.entries} ${entry.entries === 1 ? "entry" : "entries"}`;
  }

  function renderReviewContextBudget(context: ItemContext): string {
    return reviewContextLedger(context)
      .map(
        (entry) => `- ${entry.label}: ${reviewContextLedgerCountText(entry)}, ${entry.chars} chars`,
      )
      .join("\n");
  }

  function renderReviewContextBudgetForTest(context: ItemContext): string {
    return renderReviewContextBudget(context);
  }

  function runtimeReviewTextFromReport(markdown: string): string {
    return runtimeReviewText({
      model: frontMatterValue(markdown, "review_model") ?? "",
      reasoningEffort: frontMatterValue(markdown, "review_reasoning_effort") ?? "",
    });
  }

  function closeReviewLineFromDecision(
    decision: Decision,
    git: GitInfo,
    runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">,
  ): string {
    const fixed = fixedInText(decision);
    const parts = [runtimeReviewText(runtime), `reviewed against ${linkedSha(git.mainSha)}`].filter(
      Boolean,
    );
    if (fixed !== "not determined") parts.push(`fix evidence: ${fixed}`);
    return `Codex review notes: ${parts.join("; ")}.`;
  }

  function closeReviewLineFromReport(markdown: string): string {
    const mainSha = frontMatterValue(markdown, "main_sha");
    const fixed = fixedInReportText(markdown);
    const parts: string[] = [runtimeReviewTextFromReport(markdown)].filter(Boolean);
    if (mainSha && mainSha !== "unknown") parts.push(`reviewed against ${linkedSha(mainSha)}`);
    if (fixed !== "not determined") parts.push(`fix evidence: ${fixed}`);
    return parts.length ? `Codex review notes: ${parts.join("; ")}.` : "";
  }

  function renderCloseComment(options: {
    reason: CloseReason;
    summary: string;
    bestSolution?: string;
    reproductionAssessment?: string;
    solutionAssessment?: string;
    agentsPolicyStatus?: AgentsPolicyStatus | undefined;
    evidence: Evidence[];
    likelyOwners?: LikelyOwner[];
    fixedPullRequest?: FixedPullRequest | null;
    securityReview?: SecurityReview;
    rootCauseCluster?: RootCauseClusterAssessment;
    reviewLine: string;
    currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
  }): string {
    const evidence = options.evidence.slice(0, 6).map(closeEvidenceLine);
    const likelyOwners = (options.likelyOwners ?? []).slice(0, 5).map(likelyOwnerLine);
    const summaryLine = sentence(options.summary);
    const lines = [closeIntro(options.reason), "", summaryLine];
    if (options.fixedPullRequest?.confidence === "high") {
      lines.push(
        "",
        `I found the merged PR that appears to have closed this: ${markdownLink(
          `#${options.fixedPullRequest.number}: ${options.fixedPullRequest.title}`,
          options.fixedPullRequest.url,
        )}.`,
      );
    }
    const rootCauseCluster = publicRootCauseClusterBlock(options.rootCauseCluster);
    if (rootCauseCluster) lines.push("", "**Root-cause cluster**", rootCauseCluster);
    const bestSolutionLine = sentence(options.bestSolution ?? "");
    const canonicalLinks = duplicateCanonicalLinks({
      reason: options.reason,
      bestSolutionLine,
      evidence: options.evidence,
      currentItem: options.currentItem,
    });
    const canonicalPathLine = duplicateCanonicalPathLine({
      reason: options.reason,
      summaryLine,
      bestSolutionLine,
      evidence: options.evidence,
    });
    if (canonicalPathLine) lines.push("", canonicalPathLine);
    const details: string[] = [];
    if (bestSolutionLine && publicReviewTextDiffers(bestSolutionLine, summaryLine)) {
      details.push("Best possible solution:", "", bestSolutionLine);
    }
    appendReviewQuestionDetails(
      details,
      options.reproductionAssessment,
      options.solutionAssessment,
    );
    if (options.securityReview) {
      details.push("", "Security review:", "", securityReviewLine(options.securityReview));
      if (options.securityReview.concerns.length) {
        details.push("", ...options.securityReview.concerns.map(securityConcernDetailedLine));
      }
    }
    const agentsPolicyLine = agentsPolicyStatusLine(options.agentsPolicyStatus);
    if (agentsPolicyLine) details.push("", agentsPolicyLine);
    if (evidence.length) details.push("", "What I checked:", "", ...evidence);
    if (likelyOwners.length) details.push("", "Likely related people:", "", ...likelyOwners);

    const clawhubHandoff = closeClawHubHandoffBlock(options.reason);
    if (clawhubHandoff) lines.push("", "**ClawHub handoff**", clawhubHandoff);
    const outro = closeOutro(options.reason, canonicalLinks);
    if (outro) lines.push("", outro);
    if (options.reviewLine) details.push("", options.reviewLine);
    const detailsBlock = collapsedDetailsBlock("Review details", details);
    if (detailsBlock) lines.push("", detailsBlock);

    return lines.join("\n");
  }

  function renderCloseCommentFromReport(markdown: string, reason: CloseReason): string {
    return neutralizeReviewControlMarkers(
      sanitizePublicSelfReferences(
        renderCloseComment({
          reason,
          summary: reviewSectionValue(markdown, "summary"),
          bestSolution: reviewSectionValue(markdown, "bestSolution"),
          reproductionAssessment: reviewSectionValue(markdown, "reproductionAssessment"),
          solutionAssessment: reviewSectionValue(markdown, "solutionAssessment"),
          agentsPolicyStatus: reportAgentsPolicyStatus(markdown),
          evidence: reportEvidence(markdown),
          likelyOwners: reportLikelyOwners(markdown),
          fixedPullRequest: fixedPullRequestFromReport(markdown),
          securityReview: reportSecurityReview(markdown),
          rootCauseCluster: reportRootCauseCluster(markdown),
          reviewLine: closeReviewLineFromReport(markdown),
          currentItem: {
            repo: markdownRepository(markdown),
            number: Number(frontMatterValue(markdown, "number")),
            kind: (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
          },
        }),
        Number(frontMatterValue(markdown, "number")),
        (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
      ),
    );
  }

  function sanitizePublicSelfReferences(text: string, number: number, kind: ItemKind): string {
    if (!Number.isInteger(number) || number <= 0) return text;
    const noun = kind === "pull_request" ? "this PR" : "this issue";
    const escapedNumber = String(number).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selfRefSource = `#${escapedNumber}\\b`;
    const typedSelfRef = new RegExp(
      `\\b(?:Issue|issue|PR|pr|Pull request|pull request)\\s+${selfRefSource}`,
      "g",
    );
    const closingVerbSelfRef = new RegExp(
      `\\b(Fixes|fixes|Fix|fix|Closes|closes|Resolves|resolves)\\s+${selfRefSource}`,
      "g",
    );
    const selfRef = new RegExp(selfRefSource, "g");
    return text
      .replace(closingVerbSelfRef, (_match, verb: string) => `${verb} ${noun}`)
      .replace(typedSelfRef, noun)
      .replace(selfRef, noun)
      .replace(
        /(^|[.!?]\s+)(this issue|this PR)/g,
        (_match, prefix: string, value: string) =>
          `${prefix}${value[0]?.toUpperCase()}${value.slice(1)}`,
      );
  }

  function normalizeComment(
    decision: Decision,
    git: GitInfo,
    runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">,
    item?: { repo?: string; kind?: ItemKind; number?: number },
  ): string {
    return renderCloseComment({
      reason: decision.closeReason,
      summary: decision.summary,
      bestSolution: decision.bestSolution,
      reproductionAssessment: decision.reproductionAssessment,
      solutionAssessment: decision.solutionAssessment,
      agentsPolicyStatus: decision.agentsPolicyStatus,
      evidence: decision.evidence,
      likelyOwners: decision.likelyOwners,
      fixedPullRequest: decision.fixedPullRequest ?? null,
      securityReview: decision.securityReview,
      rootCauseCluster: decision.rootCauseCluster,
      reviewLine: closeReviewLineFromDecision(decision, git, runtime),
      currentItem: item,
    });
  }

  function reportWorkCandidateReason(markdown: string): string {
    const workCandidate = reviewSectionValue(markdown, "workCandidate");
    const reason = workCandidateReasonText(workCandidate);
    if (!reason || reason.startsWith("_No work-lane recommendation")) return "";
    return reason;
  }

  function collapsedDetailsBlock(summary: string, lines: readonly string[]): string {
    const body = lines.join("\n").trim();
    if (!body) return "";
    return ["<details>", `<summary>${summary}</summary>`, "", body, "", "</details>"].join("\n");
  }

  function appendPublicSection(lines: string[], heading: string, body: string): void {
    lines.push(`**${heading}**`, body, "");
  }

  function appendHeadingSection(lines: string[], heading: string, body: string): void {
    lines.push(`## ${heading}`, "", body, "");
  }

  function isRoutineBeforeMergeStep(value: string): boolean {
    const text = value.trim();
    if (!text) return false;
    if (
      !/\b(?:merge after (?:required )?checks are green|merge after maintainer review|normal (?:ci|maintainer review)|routine (?:ci|maintainer review)|ordinary (?:ci|maintainer review)|wait for (?:required |status )?(?:ci|checks|status checks)|no further action)\b/i.test(
        text,
      ) &&
      !/^(?:land|merge|ship|proceed|continue|wait)\b[^\n]{0,120}\bafter (?:normal |ordinary |routine )?maintainer review\b/i.test(
        text,
      )
    ) {
      return false;
    }
    if (/\b(?:do not|don['’]t|must not|never|not merge|except|unless|until)\b/i.test(text)) {
      return false;
    }
    return !isActionablePriorityText(text);
  }

  function publicBeforeMergeItems(options: {
    reviewFailed: boolean;
    proof: RealBehaviorProof;
    proofBlocked: boolean;
    findings: readonly ReviewFinding[];
    securityReview: SecurityReview;
    risks: string;
    nextStep: string;
    decisionPending: boolean;
    patchQualityBlocked: boolean;
    requiredRatingSteps: readonly string[];
  }): PublicBeforeMergeItem[] {
    const items: PublicBeforeMergeItem[] = [];
    const seen = new Set<string>();
    const add = (label: string, detail: string, identity?: { distinctKey: string }) => {
      const rawDetail = stripPriorityPrefix(detail);
      const cleanDetail = sentence(stripPriorityPrefix(detail));
      // Typed findings pass a distinct key (title and location) so independent
      // findings that share remediation wording are all kept; free-form guidance
      // still de-duplicates on the detail text across sections.
      const key = normalizePublicReviewText(
        identity ? `${identity.distinctKey} ${cleanDetail}` : cleanDetail,
      );
      if (
        !cleanDetail ||
        /^none[.!]?$/i.test(rawDetail) ||
        isReportNoneList(cleanDetail) ||
        seen.has(key) ||
        (!identity && items.some((item) => !publicReviewTextDiffers(item.detail, cleanDetail)))
      ) {
        return;
      }
      seen.add(key);
      items.push({ label, detail: cleanDetail });
    };
    const addPrioritized = (text: string, fallback: PublicPriority, label: string) => {
      for (const line of publicRiskBulletsFromText(text, fallback).split("\n")) {
        const match = line.match(/^-[ \t]+\[(P[0-2])\][ \t]+(\S.*)$/);
        // Unprioritized bullets are the ones classified as routine CI or ordinary
        // maintainer review; they are not remaining merge work.
        if (match?.[1] && match[2]) {
          add(`${label} (${match[1]})`, match[2]);
        }
      }
    };

    if (options.reviewFailed) {
      add(
        "Retry ClawSweeper review",
        "ClawSweeper must complete a fresh review before readiness is known.",
      );
    }
    if (options.proofBlocked) {
      add("Add real behavior proof", publicRealBehaviorProofLine(options.proof));
    }
    for (const finding of options.findings) {
      add(`${finding.title.trim()} (${priorityLabel(finding.priority)})`, finding.body, {
        distinctKey: `${finding.title} ${reviewFindingLocation(finding)}`,
      });
    }
    for (const concern of options.securityReview.concerns) {
      add(`Resolve security concern: ${concern.title.trim()}`, concern.body, {
        distinctKey: `security ${concern.title}`,
      });
    }
    if (
      options.securityReview.status === "needs_attention" &&
      options.securityReview.concerns.length === 0
    ) {
      add("Resolve security review attention item", options.securityReview.summary);
    }
    if (!isReportNoneList(options.risks)) addPrioritized(options.risks, "P1", "Resolve merge risk");
    // Only actionable next-step text enters the checklist: routing rationale or other
    // explanatory prose is not remaining merge work, and decision questions are
    // already represented by the decision packet.
    if (
      !isRoutineBeforeMergeStep(options.nextStep) &&
      !isRoutineCiOrReviewText(options.nextStep) &&
      isActionablePriorityText(options.nextStep) &&
      !(options.decisionPending && /\bdecision\b/i.test(options.nextStep))
    ) {
      add(
        `Complete next step (${publicPriorityFromText(options.nextStep, "P2")})`,
        options.nextStep,
      );
    }
    // Routine advice never becomes a merge blocker; a step that deduplicates against
    // an existing item still counts as represented remediation.
    let ratingRemediationRepresented = false;
    for (const step of options.requiredRatingSteps) {
      if (isRoutineBeforeMergeStep(step) || isRoutineCiOrReviewText(step)) continue;
      const cleanStep = sentence(stripPriorityPrefix(step));
      if (!cleanStep || /^none[.!]?$/i.test(cleanStep) || isReportNoneList(cleanStep)) continue;
      ratingRemediationRepresented = true;
      add("Improve patch quality", step);
    }
    // A blocked patch rating must always leave a concrete follow-up, even when the
    // rating supplied no usable next steps and no typed findings explain the block.
    if (
      options.patchQualityBlocked &&
      !ratingRemediationRepresented &&
      options.findings.length === 0 &&
      options.securityReview.concerns.length === 0
    ) {
      add(
        "Improve patch quality",
        "Address the low patch-quality rating before merge; see the review scores for what is holding it back.",
      );
    }

    return items;
  }

  function publicChecklistText(value: string): string {
    // Flatten line breaks (with their surrounding layout indentation) only; interior
    // runs of spaces inside commands, quoted arguments, and paths stay exact.
    return value
      .replace(/<(?=[a-z/!?])/gi, "&lt;")
      .replace(/[ \t]*(?:\r?\n|\r)+[ \t]*/g, " ")
      .trim();
  }

  function publicChecklistLabel(value: string): string {
    return publicChecklistText(value)
      .replace(/\\/g, "\\\\")
      .replace(/([*_`[\]])/g, "\\$1");
  }

  function publicBeforeMergeBlock(items: readonly PublicBeforeMergeItem[]): string {
    if (items.length === 0) return "None.";
    return items
      .map(
        (item) =>
          `- [ ] **${publicChecklistLabel(item.label)}** - ${publicChecklistText(item.detail)}`,
      )
      .join("\n");
  }

  function publicRootCauseClusterBlock(cluster: RootCauseClusterAssessment | undefined): string {
    if (
      !cluster ||
      cluster.confidence !== "high" ||
      !cluster.canonicalRef ||
      cluster.members.length === 0 ||
      ["independent", "security_route", "needs_human"].includes(cluster.currentItemRelationship)
    ) {
      return "";
    }
    const visibleMembers = cluster.members.slice(0, 5);
    const memberLines = visibleMembers.map(
      (member) => `- \`${member.relationship}\`: ${member.ref} - ${sentence(member.reason)}`,
    );
    if (cluster.members.length > visibleMembers.length) {
      memberLines.push(`- ${cluster.members.length - visibleMembers.length} more in the report.`);
    }
    return [
      `Relationship: \`${cluster.currentItemRelationship}\``,
      `Canonical: ${cluster.canonicalRef}`,
      `Summary: ${sentence(cluster.summary)}`,
      "",
      "Members:",
      ...memberLines,
      "",
      "Proposal only: this assessment does not dispatch repair, suppress jobs, mutate sibling items, close, or merge anything.",
    ].join("\n");
  }

  function publicReproducibilityLine(reproductionAssessment: string): string {
    const assessmentLine = sentence(reproductionAssessment);
    if (!assessmentLine) return "";
    const match = assessmentLine.match(/^(yes|no|unclear|not applicable)\b/i);
    if (!match) return `Reproducibility: ${assessmentLine}`;
    const status = match[1]?.toLowerCase() ?? "";
    const detail = sentence(assessmentLine.slice(match[0].length).replace(/^[\s,.:;-]+/, ""));
    return `Reproducibility: ${status}.${detail ? ` ${detail}` : ""}`;
  }

  function publicSummaryBody(summaryLine: string, reproductionAssessment: string): string {
    return [summaryLine, publicReproducibilityLine(reproductionAssessment)]
      .filter(Boolean)
      .join("\n\n");
  }

  function publicMergeRiskLine(
    risks: string,
    nextStepLine: string,
    bestSolutionLine: string,
    options: readonly MergeRiskOption[],
  ): string {
    if (isReportNoneList(risks)) return "";
    if (publicReviewTextIsSame(risks, nextStepLine)) return "";
    if (bestSolutionLine && publicReviewTextIsSame(risks, bestSolutionLine)) return "";
    const choices = options.length
      ? mergeRiskOptionsLines(options)
      : mergeRiskFallbackOptionsLines(bestSolutionLine, nextStepLine);
    return choices.length ? ["**Maintainer options:**", ...choices].join("\n") : "";
  }

  function mergeRiskFallbackOptionsLines(bestSolutionLine: string, nextStepLine: string): string[] {
    const recommended = sentence(bestSolutionLine) || sentence(nextStepLine);
    const instruction =
      recommended || "Decide whether the merge risk is acceptable before merging.";
    return mergeRiskOptionsLines([
      {
        title: "Decide the mitigation before merge",
        body: instruction,
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
      {
        title: "Pause or close",
        body: "Do not merge this PR until maintainers decide whether the risk is worth taking.",
        category: "pause_or_close",
        recommended: false,
        automergeInstruction: "",
      },
    ]);
  }

  function mergeRiskOptionsLines(options: readonly MergeRiskOption[]): string[] {
    const lines = options.flatMap((option, index) => [
      `${index + 1}. **${option.title}${option.recommended ? " (recommended)" : ""}**  `,
      `   ${option.body}`,
    ]);
    const recommendedRepair = options.find(
      (option) =>
        option.recommended &&
        option.category === "fix_before_merge" &&
        option.automergeInstruction.trim(),
    );
    if (recommendedRepair) {
      lines.push("", mergeRiskAutomergeInstructionBlock(recommendedRepair.automergeInstruction));
    }
    return lines;
  }

  function mergeRiskAutomergeInstructionBlock(instruction: string): string {
    const specialInstructions = normalizeMergeRiskAutomergeInstruction(instruction);
    if (!specialInstructions) return "";
    return [
      "<details>",
      "<summary>Copy recommended automerge instruction</summary>",
      "",
      "```text",
      "@clawsweeper automerge",
      "",
      "Special instructions:",
      specialInstructions,
      "```",
      "",
      "</details>",
    ].join("\n");
  }

  function normalizeMergeRiskAutomergeInstruction(instruction: string): string {
    return instruction
      .trim()
      .replace(/^@clawsweeper\s+(?:automerge|autofix)\b[:\s-]*/i, "")
      .replace(/^special instructions:\s*/i, "")
      .replace(/^this PR:\s*/i, "")
      .trim();
  }

  function issueReproductionHelpSuggestions(markdown: string): string[] {
    if (frontMatterValue(markdown, "type") !== "issue") return [];
    const reproductionStatus = frontMatterValue(markdown, "reproduction_status");
    const reproductionConfidence = frontMatterValue(markdown, "reproduction_confidence");
    if (reproductionStatus === "reproduced" && reproductionConfidence === "high") return [];
    const reproductionAssessment = sentence(reviewSectionValue(markdown, "reproductionAssessment"));
    if (/^yes\b/i.test(reproductionAssessment)) return [];
    const sections = [
      reviewSectionValue(markdown, "summary"),
      reproductionAssessment,
      reviewSectionValue(markdown, "solutionAssessment"),
      reviewSectionValue(markdown, "evidence"),
      reviewSectionValue(markdown, "risks"),
    ];
    const text = sections.join("\n").toLowerCase();
    const suggestions: string[] = [];
    const hasMedia = /\b(?:screenshot|screen shot|video|recording|gif|image)\b/i.test(text);
    const hasSteps = /\b(?:step|steps|command|run|click|launch|workflow)\b/i.test(text);
    const hasExpectedActual = /\bexpected\b/i.test(text) && /\bactual\b/i.test(text);
    const hasLogs = /\b(?:log|logs|terminal|console|stack trace|traceback|output|error)\b/i.test(
      text,
    );
    const hasVersionContext =
      /\b(?:version|platform|os|macos|windows|linux|browser|provider|channel|config|settings)\b/i.test(
        text,
      );
    if (!hasMedia) {
      suggestions.push("Add a screenshot or short recording showing the behavior.");
    }
    if (!hasSteps) {
      suggestions.push("Include the exact command, prompt, or workflow that triggered it.");
    }
    if (!hasExpectedActual) {
      suggestions.push("Add expected vs actual behavior.");
    }
    if (!hasLogs) {
      suggestions.push("Include redacted logs or terminal output.");
    }
    if (!hasVersionContext) {
      suggestions.push("Share version, platform, channel/provider, and relevant config details.");
    }
    return suggestions.slice(0, 3);
  }

  function appendReviewQuestionDetails(
    details: string[],
    reproductionAssessment: string | undefined,
    solutionAssessment: string | undefined,
  ): void {
    const append = (heading: string, body: string) => {
      if (details.length) details.push("");
      details.push(heading, "", body);
    };
    const reproductionLine = sentence(reproductionAssessment ?? "");
    if (reproductionLine) {
      append("Do we have a high-confidence way to reproduce the issue?", reproductionLine);
    }
    const solutionLine = sentence(solutionAssessment ?? "");
    if (solutionLine) {
      append("Is this the best way to solve the issue?", solutionLine);
    }
  }

  function reviewWorkflowLines(): string[] {
    return [
      "- ClawSweeper keeps one durable marker-backed review comment per issue or PR.",
      "- Re-runs edit this comment so the latest verdict, findings, and automation markers stay together instead of adding duplicate bot comments.",
      "- A fresh review can be triggered by eligible `@clawsweeper re-review` comments, exact-item GitHub events, scheduled/background review runs, or manual workflow dispatch.",
      "- PR/issue authors and users with repository write access can comment `@clawsweeper re-review` or `@clawsweeper re-run` on an open PR or issue to request a fresh review only.",
      "- Maintainers can also comment `@clawsweeper review` to request a fresh review only.",
      "- Fresh-review commands do not start repair, autofix, rebase, CI repair, or automerge.",
      "- Maintainer-only repair and merge flows require explicit commands such as `@clawsweeper autofix`, `@clawsweeper automerge`, `@clawsweeper fix ci`, or `@clawsweeper address review`.",
      "- Maintainers can comment `@clawsweeper explain` to ask for more context, or `@clawsweeper stop` to stop active automation.",
    ];
  }

  function reviewWorkflowCallout(): string[] {
    return [collapsedDetailsBlock("How this review workflow works", reviewWorkflowLines()), ""];
  }

  function reviewFreshnessText(markdown: string): string {
    const timestamp = formatReviewFreshnessTimestamp(frontMatterValue(markdown, "reviewed_at"));
    return timestamp ? ` _Reviewed ${timestamp}._` : "";
  }

  const REVIEW_HISTORY_RENDER_SLOT = "CLAWSWEEPER_REVIEW_HISTORY_RENDER_SLOT";

  const OWNED_REVIEW_SECTION_HEADINGS = new Set([
    "summary",
    "what this changes",
    "merge readiness",
    "review scores",
    "verification",
    "how this fits together",
    "decision needed",
    "before merge",
    "next step",
    "next step before merge",
    "automerge follow-up",
    "autofix follow-up",
    "findings",
    "review findings",
    "security",
    "label changes",
  ]);

  function reviewHistoryForRender(
    markdown: string,
    previousReviewCommentBody: string | undefined,
  ): ReviewHistoryLedger {
    if (frontMatterValue(markdown, "type") !== "pull_request") {
      return { cycles: [], totalCompletedCycles: 0 };
    }
    const body = previousReviewCommentBody ?? "";
    if (!body.trim()) return { cycles: [], totalCompletedCycles: 0 };
    const history = parseReviewHistory(body);
    const previousCycle = reviewHistoryCycleFromCommentBody(body);
    if (!previousCycle) return history;
    const reviewedAt = frontMatterValue(markdown, "reviewed_at");
    if (reviewedAt && previousCycle.reviewedAt === reviewedAt) return history;
    return appendReviewHistoryCycle(history, previousCycle);
  }

  function reviewHistoryForStaleComment(
    previousReviewCommentBody: string | undefined,
  ): ReviewHistoryLedger {
    const body = previousReviewCommentBody ?? "";
    const history = parseReviewHistory(body);
    return appendReviewHistoryCycle(history, reviewHistoryCycleFromCommentBody(body));
  }

  function renderKeepOpenCommentFromReport(
    markdown: string,
    options: ReviewCommentRenderOptions = {},
  ): string {
    // Keep the full list for verification counts; only the rendered evidence list is
    // abbreviated.
    const allEvidenceEntries = reportEvidence(markdown);
    const evidenceEntries = allEvidenceEntries.slice(0, 6);
    const evidence = evidenceEntries.map(closeEvidenceLine);
    const likelyOwners = reportLikelyOwners(markdown).slice(0, 5).map(likelyOwnerLine);
    const reviewFindings = reportReviewFindings(markdown);
    const securityReview = reportSecurityReview(markdown);
    const realBehaviorProof = reportRealBehaviorProof(markdown);
    const prRating = reportPrRating(markdown);
    const mantisRecommendation = reportMantisRecommendation(markdown);
    const agentsPolicyStatus = reportAgentsPolicyStatus(markdown);
    const rootCauseCluster = reportRootCauseCluster(markdown);
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
    const workCandidate = frontMatterValue(markdown, "work_candidate");
    const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
    const reviewFailed = frontMatterValue(markdown, "review_status") === "failed";
    const validation = frontMatterStringArray(markdown, "work_validation")
      .slice(0, 5)
      .map((step) =>
        isPullRequest ? publicPriorityBulletFromText(step, "P1") : `- ${stripPriorityPrefix(step)}`,
      );
    const isRepairCandidate = workCandidate === "queue_fix_pr";
    const isRepairLoopPass = isPullRequest && Boolean(repairLoopPassModeFromReport(markdown));
    const hasRealBehaviorProofBlocker =
      isPullRequest && !reviewFailed && realBehaviorProofBlocksMerge(markdown);
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
    const hasReviewFindings = isPullRequest && reviewFindings.length > 0;
    const verdictLine = reviewFailed
      ? "ClawSweeper review: did not complete due to Codex infrastructure failure."
      : hasRealBehaviorProofBlocker
        ? "Codex review: needs real behavior proof before merge."
        : isRepairLoopPass
          ? "Codex review: passed."
          : isPullRequest && isRepairCandidate
            ? "Codex review: needs changes before merge."
            : hasReviewFindings
              ? "Codex review: found issues before merge."
              : isPullRequest
                ? "Codex review: needs maintainer review before merge."
                : "Codex review: keeping this open for maintainer follow-up; there is still a little grit to resolve.";
    const lines = [`${verdictLine}${reviewFreshnessText(markdown)}`, ""];
    const prSurface = renderOpenClawPrSurfaceFromReport(markdown);
    const dataModelWarning = renderDataModelWarningFromReport(markdown);
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
      // When patch quality itself blocks readiness, the rating's remediation steps are
      // required work, not optional rank-up advice.
      const patchQualityBlocked =
        !reviewFailed && (prRating.patchTier === "F" || prRating.patchTier === "D");
      const beforeMergeItems = publicBeforeMergeItems({
        reviewFailed,
        proof: realBehaviorProof,
        proofBlocked: hasRealBehaviorProofBlocker,
        findings: reviewFindings,
        securityReview,
        risks,
        nextStep: nextStepLine,
        decisionPending: Boolean(decisionPacketBlock),
        patchQualityBlocked,
        requiredRatingSteps: patchQualityBlocked ? prRating.nextSteps : [],
      });
      lines.push("# ClawSweeper review", "");
      appendHeadingSection(lines, "What this changes", changeSummaryLine);
      appendHeadingSection(
        lines,
        "Merge readiness",
        reviewFailed
          ? publicFailedReviewReadinessBlock(markdown)
          : publicMergeReadinessBlock(
              prRating,
              realBehaviorProof,
              triagePriority,
              summaryLine,
              // An outstanding maintainer decision is remaining work even though it
              // lives outside the checklist.
              beforeMergeItems.length + (decisionPacketBlock ? 1 : 0),
              Boolean(decisionPacketBlock),
              pullHeadShaFromReport(markdown) ?? "",
            ),
      );
      if (!reviewFailed) {
        appendHeadingSection(
          lines,
          "Review scores",
          publicReviewScoresBlock(prRating, realBehaviorProof, reviewFindings, securityReview),
        );
        appendHeadingSection(
          lines,
          "Verification",
          publicVerificationBlock(
            realBehaviorProof,
            allEvidenceEntries,
            reviewFindings,
            securityReview,
          ),
        );
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
    const requiresMaintainerDecision = maintainerDecisionFromReport(markdown)?.required === true;
    const body =
      decision === "close" &&
      reason !== "none" &&
      (!requiresMaintainerDecision ||
        reason === "unsponsored_feature_request" ||
        reason === "author_pr_budget_exceeded")
        ? renderCloseCommentFromReport(markdown, reason)
        : renderKeepOpenCommentFromReport(markdown, options);
    const markers = options.suppressAutomationMarkers
      ? ""
      : reviewAutomationMarkersFromReport(markdown);
    return [body.trimEnd(), markers, reviewVersionMarkerFromReport(markdown)]
      .filter(Boolean)
      .join("\n\n");
  }

  function pullRequestHeadSha(number: number): string {
    const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
    const sha = asRecord(pull.head).sha;
    return typeof sha === "string" ? sha.trim().toLowerCase() : "";
  }

  function currentReviewRevision(item: Item): string {
    if (item.kind === "pull_request") return pullRequestHeadSha(item.number);
    const revision = collectItemContext(item, { fullTimelineForRelations: true }).sourceRevision;
    return typeof revision === "string" ? revision : "";
  }

  function closeItem(options: { number: number; kind: ItemKind; reason: CloseReason }): void {
    if (options.kind === "pull_request") {
      ghObservedMutationCommand({
        identity: `item_close:${options.number}:${options.kind}:${options.reason}`,
        args: ["pr", "close", String(options.number)],
      });
    } else {
      const reason = isImplementationCloseReason(options.reason) ? "completed" : "not_planned";
      const closePayloadFile = join(ROOT, ".artifacts", `close-${options.number}.json`);
      writeFileSync(
        closePayloadFile,
        JSON.stringify({ state: "closed", state_reason: reason }),
        "utf8",
      );
      ghObservedMutationCommand({
        identity: `item_close:${options.number}:${options.kind}:${options.reason}`,
        args: [
          "api",
          `repos/${targetRepo()}/issues/${options.number}`,
          "--method",
          "PATCH",
          "--input",
          closePayloadFile,
        ],
      });
    }
  }

  function reviewActionForDecision(options: {
    item: Item;
    decision: Decision;
    git: GitInfo;
    runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">;
  }): Action {
    if (options.decision.decision !== "close")
      return { actionTaken: "kept_open", closeComment: "" };
    if (
      isMaintainerAuthored(options.item) &&
      !isVerifiedFixedCloseReason(options.decision.closeReason)
    ) {
      return { actionTaken: "skipped_maintainer_authored", closeComment: "" };
    }
    const validation = validateCloseDecision(options.item, options.decision, {
      requireCloseComment: false,
    });
    if (!validation.ok) return { actionTaken: validation.actionTaken, closeComment: "" };
    const closeComment = normalizeComment(
      options.decision,
      options.git,
      options.runtime,
      options.item,
    );
    if (!hasUsableCloseComment(closeComment)) {
      return { actionTaken: "skipped_invalid_decision", closeComment: "" };
    }
    return { actionTaken: "proposed_close", closeComment };
  }

  function markdownList(values: string[]): string {
    return values.length ? values.map((value) => `- ${value}`).join("\n") : "- none";
  }

  function renderWorkCandidateReportSection(decision: Decision): string {
    const lines = [
      `Candidate: ${decision.workCandidate}`,
      "",
      `Confidence: ${decision.workConfidence}`,
      "",
      `Priority: ${decision.workPriority}`,
      "",
      `Status: ${workStatusForDecision(decision)}`,
    ];
    const workReason = decision.workReason.trim();
    if (workReason) lines.push("", `Reason: ${workReason}`);

    const includeDetails =
      decision.workCandidate !== "none" ||
      decision.workClusterRefs.length > 0 ||
      decision.workLikelyFiles.length > 0 ||
      decision.workValidation.length > 0;
    if (includeDetails) {
      lines.push("", "Cluster refs:", "", markdownList(decision.workClusterRefs));
      lines.push("", "Likely files:", "", markdownList(decision.workLikelyFiles));
      lines.push("", "Validation:", "", markdownList(decision.workValidation));
    }
    return lines.join("\n");
  }

  function renderRepairWorkPromptReportSection(decision: Decision): string {
    const workPrompt = decision.workPrompt.trim();
    return workPrompt ? `\n\n## ${REVIEW_SECTIONS.repairWorkPrompt}\n\n${workPrompt}` : "";
  }

  function renderMaintainerDecisionReportSection(decision: Decision): string {
    const maintainerDecision = decision.maintainerDecision;
    if (!maintainerDecision.required) return "Required: false";
    const options = maintainerDecision.options
      .map(
        (option) =>
          `- **${option.title}${option.recommended ? " (recommended)" : ""}:** ${option.body}`,
      )
      .join("\n");
    return [
      "Required: true",
      "",
      `Kind: ${maintainerDecision.kind}`,
      "",
      `Question: ${maintainerDecision.question}`,
      "",
      `Rationale: ${maintainerDecision.rationale}`,
      "",
      `Likely owner: ${maintainerDecision.likelyOwner.person}`,
      "",
      `Owner reason: ${maintainerDecision.likelyOwner.reason}`,
      "",
      `Owner confidence: ${maintainerDecision.likelyOwner.confidence}`,
      "",
      "Options:",
      "",
      options,
    ].join("\n");
  }

  function renderVisionFitReportSection(decision: Decision): string {
    return [
      `Status: ${decision.visionFit}`,
      "",
      `Implementation complexity: ${decision.implementationComplexity}`,
      "",
      `Auto implementation candidate: ${decision.autoImplementationCandidate}`,
      "",
      `Reason: ${sentence(decision.visionFitReason)}`,
      "",
      "Vision evidence:",
      "",
      markdownList(decision.visionFitEvidence),
    ].join("\n");
  }

  function renderReviewFindingsReportSection(decision: Decision): string {
    const lines = [
      `Overall correctness: ${decision.overallCorrectness}`,
      "",
      `Overall confidence: ${confidenceText(decision.overallConfidenceScore)}`,
      "",
      "Full review comments:",
      "",
    ];
    if (!decision.reviewFindings.length) {
      lines.push("- none");
      return lines.join("\n");
    }
    lines.push(
      decision.reviewFindings
        .map((finding) =>
          [
            `- **[${priorityLabel(finding.priority)}] ${finding.title}:** \`${reviewFindingLocation(
              finding,
            )}\``,
            `  - body: ${sentence(finding.body)}`,
            ...(finding.lateFinding ? ["  - late: true"] : []),
            `  - confidence: ${confidenceText(finding.confidenceScore)}`,
          ].join("\n"),
        )
        .join("\n"),
    );
    return lines.join("\n");
  }

  function renderSecurityReviewReportSection(decision: Decision): string {
    const lines = [
      `Status: ${decision.securityReview.status}`,
      "",
      `Summary: ${sentence(decision.securityReview.summary)}`,
      "",
      "Concerns:",
      "",
    ];
    if (!decision.securityReview.concerns.length) {
      lines.push("- none");
      return lines.join("\n");
    }
    lines.push(
      decision.securityReview.concerns
        .map((concern) => {
          const location = securityConcernLocation(concern);
          const heading =
            location === "not tied to a single file"
              ? `- **[${concern.severity}] ${concern.title}:**`
              : `- **[${concern.severity}] ${concern.title}:** \`${location}\``;
          return [
            heading,
            `  - body: ${sentence(concern.body)}`,
            `  - confidence: ${confidenceText(concern.confidenceScore)}`,
          ].join("\n");
        })
        .join("\n"),
    );
    return lines.join("\n");
  }

  function renderRealBehaviorProofReportSection(decision: Decision): string {
    return [
      `Status: ${decision.realBehaviorProof.status}`,
      "",
      `Evidence kind: ${decision.realBehaviorProof.evidenceKind}`,
      "",
      `Needs contributor action: ${decision.realBehaviorProof.needsContributorAction}`,
      "",
      `Summary: ${sentence(decision.realBehaviorProof.summary)}`,
    ].join("\n");
  }

  function renderPrRatingAssessmentReportSection(
    rating: PrRating,
    realBehaviorProof: RealBehaviorProof,
  ): string {
    const nextSteps = rating.nextSteps.length
      ? rating.nextSteps.map((step) => `- ${step}`).join("\n")
      : "- none";
    const shiny = hasShinyProof(realBehaviorProof) ? " ✨" : "";
    return [
      `Overall tier: ${rating.overallTier}`,
      "",
      `Proof tier: ${rating.proofTier}`,
      "",
      `Patch tier: ${rating.patchTier}`,
      "",
      `Overall label: ${themedRatingName(rating.overallTier)}`,
      "",
      `Proof label: ${themedRatingName(rating.proofTier)}${shiny}`,
      "",
      `Patch label: ${themedRatingName(rating.patchTier)}`,
      "",
      `Summary: ${sentence(rating.summary)}`,
      "",
      "Next rank-up steps:",
      "",
      nextSteps,
    ].join("\n");
  }

  function renderPrRatingReportSection(decision: Decision): string {
    return renderPrRatingAssessmentReportSection(decision.prRating, decision.realBehaviorProof);
  }

  function renderTelegramVisibleProofReportSection(decision: Decision): string {
    return [
      `Status: ${decision.telegramVisibleProof.status}`,
      "",
      `Summary: ${sentence(decision.telegramVisibleProof.summary)}`,
    ].join("\n");
  }

  function renderMantisRecommendationReportSection(decision: Decision): string {
    return [
      `Status: ${decision.mantisRecommendation.status}`,
      "",
      `Scenario: ${decision.mantisRecommendation.scenario}`,
      "",
      `Reason: ${sentence(decision.mantisRecommendation.reason)}`,
      "",
      `Maintainer comment: ${decision.mantisRecommendation.maintainerComment.trim()}`,
    ].join("\n");
  }

  function renderFeatureShowcaseReportSection(decision: Decision): string {
    return [
      `Status: ${decision.featureShowcase.status}`,
      "",
      `Reason: ${sentence(decision.featureShowcase.reason)}`,
    ].join("\n");
  }

  function renderRootCauseClusterAssessmentReportSection(
    rootCauseCluster: RootCauseClusterAssessment,
  ): string {
    const members = rootCauseCluster.members.length
      ? rootCauseCluster.members
          .map(
            (member) => `- **${member.relationship}:** ${member.ref}\n  - reason: ${member.reason}`,
          )
          .join("\n")
      : "- none";
    return [
      `Current item relationship: ${rootCauseCluster.currentItemRelationship}`,
      "",
      `Confidence: ${rootCauseCluster.confidence}`,
      "",
      `Canonical ref: ${rootCauseCluster.canonicalRef ?? "none"}`,
      "",
      `Summary: ${sentence(rootCauseCluster.summary)}`,
      "",
      "Members:",
      members,
    ].join("\n");
  }

  function renderRootCauseClusterReportSection(decision: Decision): string {
    return renderRootCauseClusterAssessmentReportSection(decision.rootCauseCluster);
  }

  function renderAgentsPolicyStatusReportSection(decision: Decision): string {
    return [
      `Status: ${decision.agentsPolicyStatus.status}`,
      "",
      `Found: ${decision.agentsPolicyStatus.found}`,
      "",
      `Read fully: ${decision.agentsPolicyStatus.readFully}`,
      "",
      `Applied: ${decision.agentsPolicyStatus.applied}`,
      "",
      `Summary: ${sentence(decision.agentsPolicyStatus.summary)}`,
    ].join("\n");
  }

  function pullRequestFilePathsFromContextForTest(context: { pullFiles?: unknown[] }): string[] {
    return (context.pullFiles ?? []).flatMap(compactPullFilePaths);
  }

  function pullRequestFilePathsFromContext(context: ItemContext): string[] {
    return pullRequestFilePathsFromContextForTest(context);
  }

  function updateReviewStructuralFrontMatter(
    markdown: string,
    record: ReviewStructuralRecord | null,
    cacheHit: boolean,
  ): string {
    let next = replaceFrontMatterValue(
      markdown,
      "review_structural_cache_version",
      record ? String(record.version) : "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_fingerprint",
      record?.fingerprint ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_source_revision",
      record?.sourceRevision ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_item_state_digest",
      record?.itemStateDigest ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_context_revision",
      record?.contextRevision ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_activity_updated_at",
      record?.activityUpdatedAt ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_relation_sensitive",
      record ? String(record.relationSensitive) : "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_target_head_sha",
      record?.targetHeadSha ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_pull_head_sha",
      record ? (record.pullHeadSha ?? "none") : "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_structural_pull_state_digest",
      record ? (record.pullStateDigest ?? "none") : "unknown",
    );
    return replaceFrontMatterValue(
      next,
      "review_structural_cache_hit",
      cacheHit ? "true" : "false",
    );
  }

  function updateReviewSemanticFrontMatter(
    markdown: string,
    record: ReviewSemanticRecord | null,
    cacheHit: boolean,
  ): string {
    let next = replaceFrontMatterValue(
      markdown,
      "review_semantic_cache_version",
      record ? String(record.version) : "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_semantic_fingerprint",
      record?.fingerprint ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_semantic_code_digest",
      record?.codeDigest ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_semantic_exact_digest",
      record?.exactDigest ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_semantic_context_digest",
      record?.contextDigest ?? "unknown",
    );
    next = replaceFrontMatterValue(
      next,
      "review_semantic_eligible",
      record ? String(record.eligible) : "false",
    );
    next = replaceFrontMatterValue(
      next,
      "review_semantic_eligibility_reason",
      record?.eligibilityReason ?? "unknown",
    );
    return replaceFrontMatterValue(next, "review_semantic_cache_hit", cacheHit ? "true" : "false");
  }

  function markdownFor(options: {
    item: Item;
    context: ItemContext;
    decision: Decision;
    git: GitInfo;
    action: Action;
    reviewMode: "propose" | "apply";
    snapshotHash: string;
    contentDigest: string;
    reviewPolicy: string;
    runtime: ReviewRuntime;
    structuralRecord?: ReviewStructuralRecord | null;
    semanticRecord?: ReviewSemanticRecord | null;
    reviewLeaseOwner?: string;
    reviewLeaseCommentId?: number;
  }): string {
    const labels = options.item.labels.length ? options.item.labels.join(", ") : "none";
    const reviewedAt = new Date().toISOString();
    const fixedPullRequest = options.decision.fixedPullRequest;
    const evidence = options.decision.evidence.length
      ? options.decision.evidence
          .map((entry) => {
            const bits = [`- **${entry.label}:** ${entry.detail}`];
            if (entry.file) {
              const parsed = splitFileAndLine(entry.file, entry.line);
              const label = `${parsed.file}${parsed.line ? `:${parsed.line}` : ""}`;
              bits.push(
                `  - file: ${markdownLink(label, fileUrl(parsed.file, entry.sha ?? options.git.mainSha, parsed.line))}`,
              );
            }
            if (entry.command) bits.push(`  - command: \`${entry.command}\``);
            if (entry.sha) bits.push(`  - sha: ${linkedSha(entry.sha)}`);
            return bits.join("\n");
          })
          .join("\n")
      : "- none";
    const risks = options.decision.risks.length
      ? options.decision.risks.map((risk) => `- ${risk}`).join("\n")
      : "- none";
    const likelyOwners = options.decision.likelyOwners.length
      ? options.decision.likelyOwners
          .map((owner) => {
            const bits = [`- **${owner.person}:** ${publicLikelyOwnerRole(owner.role)}`];
            bits.push(`  - reason: ${owner.reason}`);
            bits.push(`  - confidence: ${owner.confidence}`);
            if (owner.commits.length) bits.push(`  - commits: ${owner.commits.join(", ")}`);
            if (owner.files.length) bits.push(`  - files: ${owner.files.join(", ")}`);
            return bits.join("\n");
          })
          .join("\n")
      : "- none";
    const bestSolution = options.decision.bestSolution.trim() || "_Not provided._";
    const maintainerDecision = renderMaintainerDecisionReportSection(options.decision);
    const reproductionAssessment =
      options.decision.reproductionAssessment.trim() || "_Not provided._";
    const solutionAssessment = options.decision.solutionAssessment.trim() || "_Not provided._";
    const visionFit = renderVisionFitReportSection(options.decision);
    const rootCauseCluster = renderRootCauseClusterReportSection(options.decision);
    const reviewFindings = renderReviewFindingsReportSection(options.decision);
    const securityReview = renderSecurityReviewReportSection(options.decision);
    const realBehaviorProof = renderRealBehaviorProofReportSection(options.decision);
    const prRating = renderPrRatingReportSection(options.decision);
    const telegramVisibleProof = renderTelegramVisibleProofReportSection(options.decision);
    const mantisRecommendation = renderMantisRecommendationReportSection(options.decision);
    const featureShowcase = renderFeatureShowcaseReportSection(options.decision);
    const agentsPolicyStatus = renderAgentsPolicyStatusReportSection(options.decision);
    const workCandidateSection = renderWorkCandidateReportSection(options.decision);
    const repairWorkPromptSection = renderRepairWorkPromptReportSection(options.decision);
    const pullFiles = pullRequestFilePathsFromContext(options.context);
    const pullFilesTruncated = Boolean(options.context.counts?.pullFilesTruncated);
    const configSurfaceChange = configSurfaceChangeFromContext(options.item.repo, options.context);
    const dataModelChange = dataModelChangeFromContext(options.item.repo, options.context);
    const prSurfaceFiles = prSurfaceFilesFromContext(options.context);
    const reviewedPullStateDigest = reviewStructuralPullStateFromContext(options.context);
    return `---
number: ${options.item.number}
repository: ${options.item.repo}
type: ${options.item.kind}
title: ${JSON.stringify(options.item.title)}
url: ${options.item.url}
state_at_review: open
item_created_at: ${options.item.createdAt}
item_updated_at: ${options.item.updatedAt}
author: ${options.item.author}
author_association: ${options.item.authorAssociation}
labels: ${JSON.stringify(options.item.labels)}
bulk_filer_detected: ${options.context.bulkFiler?.detected === true}
reviewed_at: ${reviewedAt}
review_lease_owner: ${options.reviewLeaseOwner ?? "unknown"}
review_lease_comment_id: ${options.reviewLeaseCommentId ?? "unknown"}
main_sha: ${options.git.mainSha}
pull_head_sha: ${pullHeadShaFromContext(options.context) ?? "unknown"}
reviewed_pull_state_digest: ${
      reviewedPullStateDigest
        ? (reviewStructuralPullStateDigest(reviewedPullStateDigest) ?? "unknown")
        : "unknown"
    }
latest_release: ${options.git.latestRelease?.tagName ?? "unknown"}
latest_release_sha: ${options.git.latestRelease?.sha ?? "unknown"}
fixed_release: ${options.decision.fixedRelease ?? "unknown"}
fixed_sha: ${options.decision.fixedSha ?? "unknown"}
fixed_at: ${options.decision.fixedAt ?? "unknown"}
fixed_pr_url: ${fixedPullRequest?.url ?? "unknown"}
fixed_pr_number: ${fixedPullRequest?.number ?? "unknown"}
fixed_pr_title: ${fixedPullRequest ? JSON.stringify(fixedPullRequest.title) : "unknown"}
fixed_pr_merged_at: ${fixedPullRequest?.mergedAt ?? "unknown"}
fixed_pr_sha: ${fixedPullRequest?.sha ?? "unknown"}
fixed_pr_confidence: ${fixedPullRequest?.confidence ?? "unknown"}
fixed_pr_source: ${fixedPullRequest ? JSON.stringify(fixedPullRequest.source) : "unknown"}
review_policy: ${options.reviewPolicy}
review_model: ${options.runtime.model}
review_reasoning_effort: ${options.runtime.reasoningEffort}
review_sandbox: ${options.runtime.sandboxMode ?? "unknown"}
review_service_tier: ${options.runtime.serviceTier || "default"}
review_prompt_chars: ${reviewTelemetryNumber(options.runtime.promptChars)}
review_static_prompt_chars: ${reviewTelemetryNumber(options.runtime.staticPromptChars)}
review_context_chars: ${reviewTelemetryNumber(options.runtime.contextChars)}
review_schema_chars: ${reviewTelemetryNumber(options.runtime.schemaChars)}
review_additional_prompt_chars: ${reviewTelemetryNumber(options.runtime.additionalPromptChars)}
review_context_elapsed_ms: ${reviewTelemetryNumber(options.runtime.contextElapsedMs)}
review_codex_elapsed_ms: ${reviewTelemetryNumber(options.runtime.codexElapsedMs)}
review_mode: ${options.reviewMode}
review_status: ${options.decision.summary.startsWith("Codex review failed") ? "failed" : "complete"}
review_terminal_failure: ${options.decision.codexTerminalFailure === true}
local_checkout_access: verified
item_snapshot_hash: ${options.snapshotHash}
review_content_digest: ${options.contentDigest}
last_full_review_at: ${reviewedAt}
last_full_review_decision: ${options.decision.decision}
last_full_review_bulk_filer_detected: ${options.context.bulkFiler?.detected === true}
review_cache_hit: false
review_structural_cache_version: ${options.structuralRecord?.version ?? "unknown"}
review_structural_fingerprint: ${options.structuralRecord?.fingerprint ?? "unknown"}
review_structural_source_revision: ${options.structuralRecord?.sourceRevision ?? "unknown"}
review_structural_item_state_digest: ${options.structuralRecord?.itemStateDigest ?? "unknown"}
review_structural_context_revision: ${options.structuralRecord?.contextRevision ?? "unknown"}
review_structural_activity_updated_at: ${options.structuralRecord?.activityUpdatedAt ?? "unknown"}
review_structural_relation_sensitive: ${
      options.structuralRecord ? options.structuralRecord.relationSensitive : "unknown"
    }
review_structural_target_head_sha: ${options.structuralRecord?.targetHeadSha ?? "unknown"}
review_structural_pull_head_sha: ${
      options.structuralRecord ? (options.structuralRecord.pullHeadSha ?? "none") : "unknown"
    }
review_structural_pull_state_digest: ${
      options.structuralRecord ? (options.structuralRecord.pullStateDigest ?? "none") : "unknown"
    }
review_structural_cache_hit: false
review_semantic_cache_version: ${options.semanticRecord?.version ?? "unknown"}
review_semantic_fingerprint: ${options.semanticRecord?.fingerprint ?? "unknown"}
review_semantic_code_digest: ${options.semanticRecord?.codeDigest ?? "unknown"}
review_semantic_exact_digest: ${options.semanticRecord?.exactDigest ?? "unknown"}
review_semantic_context_digest: ${options.semanticRecord?.contextDigest ?? "unknown"}
review_semantic_eligible: ${options.semanticRecord?.eligible ?? false}
review_semantic_eligibility_reason: ${options.semanticRecord?.eligibilityReason ?? "unknown"}
review_semantic_cache_hit: false
item_source_revision: ${options.context.sourceRevision ?? "unknown"}
review_activity_cursor: ${options.context.pullReviewActivityCursor ?? "unknown"}
close_comment_sha256: ${options.action.closeComment ? sha256(options.action.closeComment) : "none"}
review_comment_sha256: none
review_comment_id: unknown
review_comment_url: unknown
decision: ${options.decision.decision}
close_reason: ${options.decision.closeReason}
confidence: ${options.decision.confidence}
action_taken: ${options.action.actionTaken}
work_candidate: ${options.decision.workCandidate}
work_confidence: ${options.decision.workConfidence}
work_priority: ${options.decision.workPriority}
work_status: ${workStatusForDecision(options.decision)}
work_reason_sha256: ${options.decision.workReason ? sha256(options.decision.workReason) : "none"}
work_prompt_sha256: ${options.decision.workPrompt ? sha256(options.decision.workPrompt) : "none"}
work_cluster_refs: ${jsonFrontMatterValue(options.decision.workClusterRefs)}
root_cause_cluster: ${JSON.stringify(options.decision.rootCauseCluster)}
work_validation: ${jsonFrontMatterValue(options.decision.workValidation)}
work_likely_files: ${jsonFrontMatterValue(options.decision.workLikelyFiles)}
maintainer_decision: ${JSON.stringify(options.decision.maintainerDecision)}
triage_priority: ${options.decision.triagePriority}
impact_labels: ${jsonFrontMatterValue(options.decision.impactLabels)}
merge_risk_labels: ${jsonFrontMatterValue(options.decision.mergeRiskLabels)}
maturity_labels: ${jsonFrontMatterValue(options.decision.maturityLabels)}
merge_risk_options: ${JSON.stringify(options.decision.mergeRiskOptions)}
review_metrics: ${JSON.stringify(options.decision.reviewMetrics)}
label_justifications: ${JSON.stringify(options.decision.labelJustifications)}
pull_files: ${jsonFrontMatterValue(pullFiles)}
pull_files_truncated: ${pullFilesTruncated}
config_surface_change: ${configSurfaceChange.change}
config_surface_keys: ${jsonFrontMatterValue(configSurfaceChange.keys)}
data_model_change: ${dataModelChange.change}
data_model_surfaces: ${jsonFrontMatterValue(dataModelChange.surfaces)}
pr_surface_files: ${jsonFrontMatterValue(prSurfaceFiles)}
pr_surface_files_truncated: ${pullFilesTruncated}
item_category: ${options.decision.itemCategory}
reproduction_status: ${options.decision.reproductionStatus}
reproduction_confidence: ${options.decision.reproductionConfidence}
requires_new_feature: ${options.decision.requiresNewFeature}
requires_new_config_option: ${options.decision.requiresNewConfigOption}
requires_product_decision: ${options.decision.requiresProductDecision}
vision_fit: ${options.decision.visionFit}
vision_fit_evidence: ${jsonFrontMatterValue(options.decision.visionFitEvidence)}
implementation_complexity: ${options.decision.implementationComplexity}
auto_implementation_candidate: ${options.decision.autoImplementationCandidate}
real_behavior_proof_status: ${options.decision.realBehaviorProof.status}
real_behavior_proof_evidence_kind: ${options.decision.realBehaviorProof.evidenceKind}
real_behavior_proof_needs_contributor_action: ${options.decision.realBehaviorProof.needsContributorAction}
pr_rating_overall: ${options.decision.prRating.overallTier}
pr_rating_proof: ${options.decision.prRating.proofTier}
pr_rating_patch: ${options.decision.prRating.patchTier}
telegram_visible_proof_status: ${options.decision.telegramVisibleProof.status}
mantis_recommendation_status: ${options.decision.mantisRecommendation.status}
mantis_recommendation_scenario: ${options.decision.mantisRecommendation.scenario}
feature_showcase_status: ${options.decision.featureShowcase.status}
agents_policy_status: ${options.decision.agentsPolicyStatus.status}
---

# ${markdownLink(`#${options.item.number}: ${options.item.title}`, options.item.url)}

Type: ${options.item.kind}

URL: ${markdownLink(options.item.url, options.item.url)}

Author: ${options.item.author}

Author association: ${options.item.authorAssociation}

Labels: ${labels}

Created at: ${formatTimestamp(options.item.createdAt)}

Updated at: ${formatTimestamp(options.item.updatedAt)}

Reviewed against: ${linkedSha(options.git.mainSha)}

Codex review: ${runtimeReviewText(options.runtime)}

Latest release at review time: ${
      options.git.latestRelease?.tagName
        ? linkedRelease(options.git.latestRelease.tagName)
        : "unknown"
    }${options.git.latestRelease?.sha ? ` (${linkedSha(options.git.latestRelease.sha)})` : ""}

Fixed in: ${fixedInText(options.decision)}

## Decision

${options.decision.decision === "close" ? "Close" : "Keep open"}: ${closeReasonText(options.decision.closeReason)}

Confidence: ${options.decision.confidence}

Action taken: ${options.action.actionTaken}

## Label Justifications

${labelJustificationsMarkdown(options.decision.labelJustifications)}

## ${REVIEW_SECTIONS.summary}

${options.decision.summary}

## ${REVIEW_SECTIONS.changeSummary}

${options.decision.changeSummary}

## ${REVIEW_SECTIONS.systemContext}

${options.decision.systemContext}

## ${REVIEW_SECTIONS.architectureDiagram}

${options.decision.architectureDiagram}

## ${REVIEW_SECTIONS.bestSolution}

${bestSolution}

## ${REVIEW_SECTIONS.maintainerDecision}

${maintainerDecision}

## ${REVIEW_SECTIONS.reproductionAssessment}

${reproductionAssessment}

## ${REVIEW_SECTIONS.solutionAssessment}

${solutionAssessment}

## ${REVIEW_SECTIONS.visionFit}

${visionFit}

## ${REVIEW_SECTIONS.rootCauseCluster}

${rootCauseCluster}

## ${REVIEW_SECTIONS.reviewFindings}

${reviewFindings}

## ${REVIEW_SECTIONS.securityReview}

${securityReview}

## ${REVIEW_SECTIONS.realBehaviorProof}

${realBehaviorProof}

## ${REVIEW_SECTIONS.prRating}

${prRating}

## ${REVIEW_SECTIONS.telegramVisibleProof}

${telegramVisibleProof}

## ${REVIEW_SECTIONS.mantisRecommendation}

${mantisRecommendation}

## ${REVIEW_SECTIONS.featureShowcase}

${featureShowcase}

## ${REVIEW_SECTIONS.agentsPolicyStatus}

${agentsPolicyStatus}

## ${REVIEW_SECTIONS.workCandidate}

${workCandidateSection}${repairWorkPromptSection}

## ${REVIEW_SECTIONS.evidence}

${evidence}

## ${REVIEW_SECTIONS.likelyOwners}

${likelyOwners}

## ${REVIEW_SECTIONS.risks}

${risks}

## ${REVIEW_SECTIONS.closeComment}

${options.action.closeComment ? options.action.closeComment : "_No close comment posted._"}

## GitHub Snapshot

- comments: ${contextCountText(
      options.context.counts?.comments,
      options.context.comments.length,
      options.context.counts?.commentsHydrated,
      options.context.counts?.commentsTruncated,
    )}
- timeline events: ${contextCountText(
      options.context.counts?.timeline,
      options.context.timeline.length,
      options.context.counts?.timelineHydrated,
      options.context.counts?.timelineTruncated,
    )}
- related items: ${options.context.counts?.relatedItems ?? options.context.relatedItems?.length ?? 0}
- PR files: ${contextCountText(
      options.context.counts?.pullFiles,
      options.context.pullFiles?.length ?? 0,
      options.context.counts?.pullFilesHydrated,
      options.context.counts?.pullFilesTruncated,
    )}
- PR commits: ${contextCountText(
      options.context.counts?.pullCommits,
      options.context.pullCommits?.length ?? 0,
      options.context.counts?.pullCommitsHydrated,
      options.context.counts?.pullCommitsTruncated,
    )}
- PR review comments: ${contextCountText(
      options.context.counts?.pullReviewComments,
      options.context.pullReviewComments?.length ?? 0,
      options.context.counts?.pullReviewCommentsHydrated,
      options.context.counts?.pullReviewCommentsTruncated,
    )}

## Review Context Budget

${renderReviewContextBudget(options.context)}

## Review Telemetry

- prompt chars: ${reviewTelemetryNumber(options.runtime.promptChars)}
- static prompt chars: ${reviewTelemetryNumber(options.runtime.staticPromptChars)}
- context chars: ${reviewTelemetryNumber(options.runtime.contextChars)}
- schema chars: ${reviewTelemetryNumber(options.runtime.schemaChars)}
- additional prompt chars: ${reviewTelemetryNumber(options.runtime.additionalPromptChars)}
- context collection ms: ${reviewTelemetryNumber(options.runtime.contextElapsedMs)}
- Codex review ms: ${reviewTelemetryNumber(options.runtime.codexElapsedMs)}
  `;
  }

  return {
    OWNED_REVIEW_SECTION_HEADINGS,
    closeItem,
    collapsedDetailsBlock,
    currentReviewRevision,
    markdownFor,
    pullRequestFilePathsFromContextForTest,
    pullRequestHeadSha,
    renderCloseCommentFromReport,
    renderPrRatingAssessmentReportSection,
    renderReviewCommentFromReport,
    renderReviewContextBudgetForTest,
    renderRootCauseClusterAssessmentReportSection,
    renderWorkPlanFromReport,
    reviewActionForDecision,
    reviewContextLedgerForTest,
    reviewHistoryForStaleComment,
    sanitizePublicSelfReferences,
    syncWorkPlanFromReport,
    updateReviewSemanticFrontMatter,
    updateReviewStructuralFrontMatter,
  };
}
