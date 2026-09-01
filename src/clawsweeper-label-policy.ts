import {
  FEATURE_SHOWCASE_LABEL,
  FEATURE_SHOWCASE_STATUSES,
  MERGE_READY_LABEL,
  OVERALL_CORRECTNESS_VALUES,
  PR_STATUS_LABEL_NAMES,
  PR_STATUS_LABELS,
  SECURITY_REVIEW_STATUSES,
} from "./clawsweeper-policy.js";
import {
  AUTOMERGE_LABEL,
  HUMAN_REVIEW_LABEL,
  MANUAL_ONLY_LABEL,
} from "./repair/exact-review-guard-labels.js";
import type { RealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import type {
  FeatureShowcase,
  FeatureShowcaseStatus,
  ItemContext,
  MergeRiskOption,
  MergeRiskOptionCategory,
  OverallCorrectness,
  PrStatusLabelKind,
  ReviewFinding,
  SecurityReview,
  SecurityReviewStatus,
} from "./clawsweeper-types.js";

interface LabelPolicyDependencies {
  asRecord: (value: unknown) => Record<string, unknown>;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  isAutomationReportAuthor: (author: string | undefined) => boolean;
  mergeRiskOptionsFromReport: (markdown: string) => MergeRiskOption[];
  reportOverallCorrectness: (markdown: string) => OverallCorrectness;
  reportRealBehaviorProofPolicy: (markdown: string) => RealBehaviorProofPolicy;
  reportReviewFindings: (markdown: string) => ReviewFinding[];
  reportSecurityReview: (markdown: string) => SecurityReview;
  stringOrUndefined: (value: unknown) => string | undefined;
  timestampMs: (iso: string | undefined) => number | null;
}

export function createLabelPolicy({
  asRecord,
  frontMatterValue,
  isAutomationReportAuthor,
  mergeRiskOptionsFromReport,
  reportOverallCorrectness,
  reportRealBehaviorProofPolicy,
  reportReviewFindings,
  reportSecurityReview,
  stringOrUndefined,
  timestampMs,
}: LabelPolicyDependencies) {
  function shouldApplyFeatureShowcaseLabel(options: {
    isPullRequest: boolean;
    itemCategory: string | undefined;
    requiresNewFeature: boolean;
    showcase: FeatureShowcase;
    securityReview: Pick<SecurityReview, "status">;
    overallCorrectness: OverallCorrectness;
  }): boolean {
    return (
      options.isPullRequest &&
      options.showcase.status === "showcase" &&
      (options.itemCategory === "feature" || options.requiresNewFeature) &&
      options.securityReview.status !== "needs_attention" &&
      options.overallCorrectness !== "patch is incorrect"
    );
  }

  function nextFeatureShowcaseLabels(
    labels: readonly string[],
    options: {
      isPullRequest: boolean;
      itemCategory: string | undefined;
      requiresNewFeature: boolean;
      showcase: FeatureShowcase;
      securityReview: Pick<SecurityReview, "status">;
      overallCorrectness: OverallCorrectness;
    },
  ): string[] {
    if (labels.includes(FEATURE_SHOWCASE_LABEL)) return [...labels];
    return shouldApplyFeatureShowcaseLabel(options)
      ? [...labels, FEATURE_SHOWCASE_LABEL]
      : [...labels];
  }

  function featureShowcaseLabelsForTest(
    labels: readonly string[],
    options: {
      isPullRequest?: boolean;
      itemCategory?: string;
      requiresNewFeature?: boolean;
      status?: string;
      securityReviewStatus?: string;
      overallCorrectness?: string;
    },
  ): string[] {
    const status = FEATURE_SHOWCASE_STATUSES.has(options.status as FeatureShowcaseStatus)
      ? (options.status as FeatureShowcaseStatus)
      : "none";
    const securityReviewStatus = SECURITY_REVIEW_STATUSES.has(
      options.securityReviewStatus as SecurityReviewStatus,
    )
      ? (options.securityReviewStatus as SecurityReviewStatus)
      : "not_applicable";
    const overallCorrectness = OVERALL_CORRECTNESS_VALUES.has(
      options.overallCorrectness as OverallCorrectness,
    )
      ? (options.overallCorrectness as OverallCorrectness)
      : "not a patch";
    return nextFeatureShowcaseLabels(labels, {
      isPullRequest: options.isPullRequest ?? true,
      itemCategory: options.itemCategory,
      requiresNewFeature: options.requiresNewFeature ?? false,
      showcase: {
        status,
        reason: status === "showcase" ? "This is a high-signal feature idea." : "",
      },
      securityReview: { status: securityReviewStatus },
      overallCorrectness,
    });
  }

  function hasBlockingReviewFindings(
    findings: readonly Pick<ReviewFinding, "priority">[],
  ): boolean {
    return findings.some((finding) => finding.priority <= 2);
  }

  function recommendedMergeRiskOptionCategory(
    options: readonly Pick<MergeRiskOption, "category" | "recommended">[],
  ): MergeRiskOptionCategory | null {
    return options.find((option) => option.recommended)?.category ?? null;
  }

  function securityReviewNeedsContributorWork(options: {
    securityReview: Pick<SecurityReview, "status">;
    mergeRiskOptions: readonly Pick<MergeRiskOption, "category" | "recommended">[];
  }): boolean {
    if (options.securityReview.status !== "needs_attention") return false;
    return recommendedMergeRiskOptionCategory(options.mergeRiskOptions) !== "accept_risk";
  }

  function hasUnresolvedContributorWork(options: {
    proofPolicy: Pick<RealBehaviorProofPolicy, "blocksMerge" | "needsContributorAction">;
    reviewFindings: readonly Pick<ReviewFinding, "priority">[];
    securityReview: Pick<SecurityReview, "status">;
    mergeRiskOptions: readonly Pick<MergeRiskOption, "category" | "recommended">[];
    overallCorrectness: OverallCorrectness;
  }): boolean {
    return (
      options.proofPolicy.needsContributorAction ||
      hasBlockingReviewFindings(options.reviewFindings) ||
      securityReviewNeedsContributorWork(options) ||
      options.overallCorrectness === "patch is incorrect"
    );
  }

  function isReadyForMaintainerLook(options: {
    proofPolicy: Pick<RealBehaviorProofPolicy, "blocksMerge" | "needsContributorAction">;
    reviewFindings: readonly Pick<ReviewFinding, "priority">[];
    securityReview: Pick<SecurityReview, "status">;
    mergeRiskOptions: readonly Pick<MergeRiskOption, "category" | "recommended">[];
    overallCorrectness: OverallCorrectness;
  }): boolean {
    return (
      !hasBlockingReviewFindings(options.reviewFindings) &&
      !securityReviewNeedsContributorWork(options) &&
      !options.proofPolicy.blocksMerge &&
      options.overallCorrectness === "patch is correct"
    );
  }

  function prStatusLabelKind(options: {
    reviewFailed: boolean;
    proofPolicy: Pick<RealBehaviorProofPolicy, "blocksMerge" | "needsContributorAction">;
    reviewFindings: readonly Pick<ReviewFinding, "priority">[];
    securityReview: Pick<SecurityReview, "status">;
    mergeRiskOptions: readonly Pick<MergeRiskOption, "category" | "recommended">[];
    overallCorrectness: OverallCorrectness;
    hasAutomergeLabel: boolean;
    hasRepairLoopPauseLabel: boolean;
    hasRecentReReviewRequest: boolean;
    hasRecentAuthorActivity: boolean;
  }): PrStatusLabelKind | null {
    const unresolvedWork = hasUnresolvedContributorWork(options);
    if (options.hasRepairLoopPauseLabel) return null;
    if (options.hasRecentReReviewRequest) return "re_review_loop";
    if (options.hasRecentAuthorActivity && unresolvedWork) return "actively_grinding";
    if (options.proofPolicy.needsContributorAction) return "needs_proof";
    if (options.proofPolicy.blocksMerge) return "needs_maintainer_proof_decision";
    if (options.reviewFailed) return null;
    if (unresolvedWork) return "waiting_on_author";
    if (options.hasAutomergeLabel) return "automerge_armed";
    if (isReadyForMaintainerLook(options)) return "ready_for_maintainer_look";
    return null;
  }

  function prStatusLabelForKind(kind: PrStatusLabelKind): (typeof PR_STATUS_LABELS)[number] {
    const label = PR_STATUS_LABELS.find((candidate) => candidate.kind === kind);
    if (!label) throw new Error(`unknown PR status label kind: ${kind}`);
    return label;
  }

  function nextPrStatusLabels(
    labels: readonly string[],
    statusKind: PrStatusLabelKind | null,
  ): string[] {
    const nextLabels = labels.filter((label) => !PR_STATUS_LABEL_NAMES.has(label));
    if (statusKind) nextLabels.push(prStatusLabelForKind(statusKind).name);
    return nextLabels;
  }

  function hasRepairLoopPauseLabel(labels: readonly string[]): boolean {
    const normalized = new Set(labels.map((label) => label.toLowerCase()));
    return (
      normalized.has(HUMAN_REVIEW_LABEL) ||
      normalized.has(MANUAL_ONLY_LABEL) ||
      normalized.has(MERGE_READY_LABEL)
    );
  }

  function eventTimestampMs(value: unknown): number | null {
    const record = asRecord(value);
    return timestampMs(stringOrUndefined(record.updatedAt) ?? stringOrUndefined(record.createdAt));
  }

  function isAfterReview(value: unknown, reviewedAtMs: number | null): boolean {
    if (reviewedAtMs === null) return false;
    const eventMs = eventTimestampMs(value);
    return eventMs !== null && eventMs > reviewedAtMs;
  }

  function isReReviewRequestText(text: unknown): boolean {
    const body = stringOrUndefined(text)?.trim() ?? "";
    if (!body) return false;
    return (
      /^\s*\/review(?:\s|$)/im.test(body) ||
      /^\s*\/clawsweeper\s+(?:re-?review|rerun|re-run|run\s+review|review)(?:\s|$)/im.test(body) ||
      /(?:^|\s)@clawsweeper(?:\[bot\])?\s+(?:re-?review|rerun|re-run|run\s+review|review)(?:\s|$)/im.test(
        body,
      )
    );
  }

  function hasRecentReReviewRequest(
    context: Pick<ItemContext, "comments">,
    reviewedAt: string | undefined,
  ): boolean {
    const reviewedAtMs = timestampMs(reviewedAt);
    return context.comments.some((comment) => {
      const record = asRecord(comment);
      if (isAutomationReportAuthor(stringOrUndefined(record.author))) return false;
      return isAfterReview(comment, reviewedAtMs) && isReReviewRequestText(record.body);
    });
  }

  function hasRecentAuthorActivity(
    context: Pick<ItemContext, "comments" | "timeline">,
    options: { reviewedAt: string | undefined; author: string | undefined },
  ): boolean {
    const author = String(options.author ?? "")
      .trim()
      .toLowerCase();
    if (!author) return false;
    const reviewedAtMs = timestampMs(options.reviewedAt);
    return (
      context.comments.some((comment) => {
        const record = asRecord(comment);
        return (
          isAfterReview(comment, reviewedAtMs) &&
          stringOrUndefined(record.author)?.toLowerCase() === author
        );
      }) ||
      context.timeline.some((event) => {
        const record = asRecord(event);
        return (
          isAfterReview(event, reviewedAtMs) &&
          stringOrUndefined(record.actor)?.toLowerCase() === author &&
          typeof record.commitId === "string" &&
          record.commitId.length > 0
        );
      })
    );
  }

  function prStatusLabelKindFromReport(
    markdown: string,
    context: ItemContext,
    currentLabels: readonly string[],
  ): PrStatusLabelKind | null {
    if (frontMatterValue(markdown, "type") !== "pull_request") return null;
    return prStatusLabelKind({
      reviewFailed: frontMatterValue(markdown, "review_status") === "failed",
      proofPolicy: reportRealBehaviorProofPolicy(markdown),
      reviewFindings: reportReviewFindings(markdown),
      securityReview: reportSecurityReview(markdown),
      mergeRiskOptions: mergeRiskOptionsFromReport(markdown),
      overallCorrectness: reportOverallCorrectness(markdown),
      hasAutomergeLabel: currentLabels.includes(AUTOMERGE_LABEL),
      hasRepairLoopPauseLabel: hasRepairLoopPauseLabel(currentLabels),
      hasRecentReReviewRequest: hasRecentReReviewRequest(
        context,
        frontMatterValue(markdown, "reviewed_at"),
      ),
      hasRecentAuthorActivity: hasRecentAuthorActivity(context, {
        reviewedAt: frontMatterValue(markdown, "reviewed_at"),
        author: frontMatterValue(markdown, "author"),
      }),
    });
  }

  function prStatusLabelsForTest(
    labels: readonly string[],
    options: {
      isPullRequest?: boolean;
      nextSteps?: readonly string[];
      proofStatus?: string;
      needsContributorAction?: boolean;
      findingPriorities?: readonly number[];
      securityStatus?: string;
      mergeRiskOptions?: readonly Pick<MergeRiskOption, "category" | "recommended">[];
      overallCorrectness?: string;
      hasAutomergeLabel?: boolean;
      hasRecentReReviewRequest?: boolean;
      hasRecentAuthorActivity?: boolean;
      reviewedAt?: string;
      comments?: readonly {
        author?: string;
        body?: string;
        createdAt?: string;
        updatedAt?: string;
      }[];
    },
  ): string[] {
    if (options.isPullRequest === false) return nextPrStatusLabels(labels, null);
    const hasRecentReReviewRequestValue =
      options.hasRecentReReviewRequest ??
      hasRecentReReviewRequest(
        { comments: [...(options.comments ?? [])] },
        options.reviewedAt ?? "2026-01-01T00:00:00Z",
      );
    const unresolvedProof = ["missing", "mock_only", "insufficient"].includes(
      options.proofStatus ?? "",
    );
    const statusKind = prStatusLabelKind({
      reviewFailed: false,
      proofPolicy: {
        blocksMerge: unresolvedProof,
        needsContributorAction: unresolvedProof && (options.needsContributorAction ?? true),
      },
      reviewFindings: (options.findingPriorities ?? [])
        .filter((priority): priority is 0 | 1 | 2 | 3 => [0, 1, 2, 3].includes(priority))
        .map((priority) => ({ priority })),
      securityReview: {
        status: SECURITY_REVIEW_STATUSES.has(options.securityStatus as SecurityReviewStatus)
          ? (options.securityStatus as SecurityReviewStatus)
          : "cleared",
      },
      mergeRiskOptions: options.mergeRiskOptions ?? [],
      overallCorrectness: OVERALL_CORRECTNESS_VALUES.has(
        options.overallCorrectness as OverallCorrectness,
      )
        ? (options.overallCorrectness as OverallCorrectness)
        : "patch is correct",
      hasAutomergeLabel: options.hasAutomergeLabel ?? labels.includes(AUTOMERGE_LABEL),
      hasRepairLoopPauseLabel: hasRepairLoopPauseLabel(labels),
      hasRecentReReviewRequest: hasRecentReReviewRequestValue,
      hasRecentAuthorActivity: options.hasRecentAuthorActivity === true,
    });
    return nextPrStatusLabels(labels, statusKind);
  }

  function prStatusLabelSchemeForTest(): {
    kind: PrStatusLabelKind;
    name: string;
    color: string;
    description: string;
  }[] {
    return PR_STATUS_LABELS.map(({ kind, name, color, description }) => ({
      kind,
      name,
      color,
      description,
    }));
  }

  return {
    eventTimestampMs,
    featureShowcaseLabelsForTest,
    hasRepairLoopPauseLabel,
    isAfterReview,
    nextFeatureShowcaseLabels,
    nextPrStatusLabels,
    prStatusLabelForKind,
    prStatusLabelKindFromReport,
    prStatusLabelsForTest,
    prStatusLabelSchemeForTest,
    shouldApplyFeatureShowcaseLabel,
  };
}
