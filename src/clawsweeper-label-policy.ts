import {
  FEATURE_SHOWCASE_LABEL,
  PR_STATUS_LABEL_NAMES,
  PR_STATUS_LABELS,
} from "./clawsweeper-policy.js";
import {
  AUTOMERGE_LABEL,
  HUMAN_REVIEW_LABEL,
  MANUAL_ONLY_LABEL,
  MERGE_READY_LABEL,
} from "./repair/exact-review-guard-labels.js";
import {
  reportRealBehaviorProofPolicy,
  type RealBehaviorProofPolicy,
} from "./clawsweeper-proof-policy.js";
import { pullRequestReviewReadinessFromReport } from "./clawsweeper-report-comment-helpers.js";
import { reportReviewDecision } from "./report-review-decision.js";
import { isAutomationReportAuthor } from "./clawsweeper-item-policy.js";
import type {
  FeatureShowcase,
  ItemContext,
  MergeRiskOption,
  MergeRiskOptionCategory,
  OverallCorrectness,
  PrStatusLabelKind,
  PublicBeforeMergeItem,
  SecurityReview,
} from "./clawsweeper-types.js";
import { asRecord, nonBlankStringOrUndefined } from "./value-coerce.js";
import { parseIsoMs } from "./iso-time.js";
import { frontMatterValue } from "./report-front-matter.js";

export function shouldApplyFeatureShowcaseLabel(options: {
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

export function nextFeatureShowcaseLabels(
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

// The Before-merge items own merge readiness. The status label only routes them:
// it is "ready" only when the published comment lists no Before-merge item.
export function prStatusLabelKind(options: {
  reviewFailed: boolean;
  proofPolicy: Pick<RealBehaviorProofPolicy, "blocksMerge" | "needsContributorAction">;
  beforeMergeItems: readonly Pick<PublicBeforeMergeItem, "state">[];
  securityReview: Pick<SecurityReview, "status">;
  mergeRiskOptions: readonly Pick<MergeRiskOption, "category" | "recommended">[];
  hasAutomergeLabel: boolean;
  hasRepairLoopPauseLabel: boolean;
  hasRecentReReviewRequest: boolean;
  hasRecentAuthorActivity: boolean;
}): PrStatusLabelKind | null {
  const unresolvedWork =
    options.proofPolicy.needsContributorAction ||
    options.beforeMergeItems.some((item) => item.state === "needs-changes") ||
    securityReviewNeedsContributorWork(options);
  if (options.hasRepairLoopPauseLabel) return null;
  if (options.hasRecentReReviewRequest) return "re_review_loop";
  if (options.hasRecentAuthorActivity && unresolvedWork) return "actively_grinding";
  if (options.proofPolicy.needsContributorAction) return "needs_proof";
  if (options.proofPolicy.blocksMerge) return "needs_maintainer_proof_decision";
  if (options.reviewFailed) return null;
  if (unresolvedWork) return "waiting_on_author";
  if (options.hasAutomergeLabel) return "automerge_armed";
  if (options.beforeMergeItems.length === 0) return "ready_for_maintainer_look";
  return null;
}

export function prStatusLabelForKind(kind: PrStatusLabelKind): (typeof PR_STATUS_LABELS)[number] {
  const label = PR_STATUS_LABELS.find((candidate) => candidate.kind === kind);
  if (!label) throw new Error(`unknown PR status label kind: ${kind}`);
  return label;
}

export function nextPrStatusLabels(
  labels: readonly string[],
  statusKind: PrStatusLabelKind | null,
): string[] {
  const nextLabels = labels.filter((label) => !PR_STATUS_LABEL_NAMES.has(label));
  if (statusKind) nextLabels.push(prStatusLabelForKind(statusKind).name);
  return nextLabels;
}

export function hasRepairLoopPauseLabel(labels: readonly string[]): boolean {
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  return (
    normalized.has(HUMAN_REVIEW_LABEL) ||
    normalized.has(MANUAL_ONLY_LABEL) ||
    normalized.has(MERGE_READY_LABEL)
  );
}

export function eventTimestampMs(value: unknown): number | null {
  const record = asRecord(value);
  return parseIsoMs(
    nonBlankStringOrUndefined(record.updatedAt) ?? nonBlankStringOrUndefined(record.createdAt),
  );
}

export function isAfterReview(value: unknown, reviewedAtMs: number | null): boolean {
  if (reviewedAtMs === null) return false;
  const eventMs = eventTimestampMs(value);
  return eventMs !== null && eventMs > reviewedAtMs;
}

function isReReviewRequestText(text: unknown): boolean {
  const body = nonBlankStringOrUndefined(text)?.trim() ?? "";
  if (!body) return false;
  return (
    /^\s*\/review(?:\s|$)/im.test(body) ||
    /^\s*\/clawsweeper\s+(?:re-?review|rerun|re-run|run\s+review|review)(?:\s|$)/im.test(body) ||
    /(?:^|\s)@clawsweeper(?:\[bot\])?\s+(?:re-?review|rerun|re-run|run\s+review|review)(?:\s|$)/im.test(
      body,
    )
  );
}

export function hasRecentReReviewRequest(
  context: Pick<ItemContext, "comments">,
  reviewedAt: string | undefined,
): boolean {
  const reviewedAtMs = parseIsoMs(reviewedAt);
  return context.comments.some((comment) => {
    const record = asRecord(comment);
    if (isAutomationReportAuthor(nonBlankStringOrUndefined(record.author))) return false;
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
  const reviewedAtMs = parseIsoMs(options.reviewedAt);
  return (
    context.comments.some((comment) => {
      const record = asRecord(comment);
      return (
        isAfterReview(comment, reviewedAtMs) &&
        nonBlankStringOrUndefined(record.author)?.toLowerCase() === author
      );
    }) ||
    context.timeline.some((event) => {
      const record = asRecord(event);
      return (
        isAfterReview(event, reviewedAtMs) &&
        nonBlankStringOrUndefined(record.actor)?.toLowerCase() === author &&
        typeof record.commitId === "string" &&
        record.commitId.length > 0
      );
    })
  );
}

export function prStatusLabelKindFromReport(
  markdown: string,
  context: Pick<ItemContext, "comments" | "timeline">,
  currentLabels: readonly string[],
): PrStatusLabelKind | null {
  if (frontMatterValue(markdown, "type") !== "pull_request") return null;
  const decision = reportReviewDecision(markdown);
  return prStatusLabelKind({
    reviewFailed: frontMatterValue(markdown, "review_status") === "failed",
    proofPolicy: reportRealBehaviorProofPolicy(markdown),
    beforeMergeItems: pullRequestReviewReadinessFromReport(markdown).items,
    securityReview: decision.securityReview,
    mergeRiskOptions: decision.mergeRiskOptions,
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
