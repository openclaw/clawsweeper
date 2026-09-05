import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import type {
  Item,
  ItemContext,
  PrStatusLabelKind,
  StalePullRequestReviewHead,
} from "./clawsweeper-types.js";

type ApplyPullRequestLabelDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "frontMatterValue"
  | "prStatusLabelKindFromReport"
  | "reportFeatureShowcase"
  | "reportOverallCorrectness"
  | "reportPrRating"
  | "reportRealBehaviorProof"
  | "reportSecurityReview"
  | "reportTelegramVisibleProof"
  | "replaceFrontMatterValue"
  | "syncFeatureShowcaseLabel"
  | "syncPrRatingLabel"
  | "syncPrStatusLabel"
  | "syncRealBehaviorProofMediaLabels"
  | "syncRealBehaviorProofSufficientLabel"
  | "syncStalePullRequestReviewLabels"
  | "syncTelegramVisibleProofLabel"
>;

interface ApplyPullRequestLabelOptions {
  currentItemContext: () => ItemContext;
  dryRun: boolean;
  item: Item;
  labelSyncFreshEnough: () => boolean;
  markdown: string;
  number: number;
  onMutation: (parentEventId?: string | null) => void;
  staleReviewHead: StalePullRequestReviewHead | null;
}

export function syncApplyPullRequestLabels(
  dependencies: ApplyPullRequestLabelDependencies,
  options: ApplyPullRequestLabelOptions,
): {
  changed: boolean;
  currentPrStatusKind: PrStatusLabelKind | null;
  labels: string[];
  markdown: string;
} {
  const {
    frontMatterValue,
    prStatusLabelKindFromReport,
    reportFeatureShowcase,
    reportOverallCorrectness,
    reportPrRating,
    reportRealBehaviorProof,
    reportSecurityReview,
    reportTelegramVisibleProof,
    replaceFrontMatterValue,
    syncFeatureShowcaseLabel,
    syncPrRatingLabel,
    syncPrStatusLabel,
    syncRealBehaviorProofMediaLabels,
    syncRealBehaviorProofSufficientLabel,
    syncStalePullRequestReviewLabels,
    syncTelegramVisibleProofLabel,
  } = dependencies;
  const {
    currentItemContext,
    dryRun,
    item,
    labelSyncFreshEnough,
    number,
    onMutation,
    staleReviewHead,
  } = options;
  let { markdown } = options;
  let labels = item.labels;
  let changed = false;
  let currentPrStatusKind: PrStatusLabelKind | null = null;
  const applyLabels = (result: { labels: string[]; changed: boolean }): void => {
    item.labels = result.labels;
    labels = result.labels;
    changed ||= result.changed;
  };

  if (staleReviewHead) {
    applyLabels(syncStalePullRequestReviewLabels({ number, labels, dryRun, onMutation }));
    markdown = replaceFrontMatterValue(
      markdown,
      "current_pull_head_sha",
      staleReviewHead.liveHeadSha,
    );
    return { changed, currentPrStatusKind, labels, markdown };
  }
  if (!labelSyncFreshEnough()) {
    return { changed, currentPrStatusKind, labels, markdown };
  }

  const proof = reportRealBehaviorProof(markdown);
  applyLabels(syncRealBehaviorProofSufficientLabel({ number, labels, proof, dryRun, onMutation }));

  applyLabels(syncRealBehaviorProofMediaLabels({ number, labels, proof, dryRun, onMutation }));

  applyLabels(
    syncPrRatingLabel({
      number,
      labels,
      rating: reportPrRating(markdown),
      reviewFailed: frontMatterValue(markdown, "review_status") === "failed",
      dryRun,
      onMutation,
    }),
  );

  applyLabels(
    syncFeatureShowcaseLabel({
      number,
      labels,
      isPullRequest: true,
      itemCategory: frontMatterValue(markdown, "item_category"),
      requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
      showcase: reportFeatureShowcase(markdown),
      securityReview: reportSecurityReview(markdown),
      overallCorrectness: reportOverallCorrectness(markdown),
      dryRun,
      onMutation,
    }),
  );

  currentPrStatusKind = prStatusLabelKindFromReport(markdown, currentItemContext(), labels);
  applyLabels(
    syncPrStatusLabel({ number, labels, statusKind: currentPrStatusKind, dryRun, onMutation }),
  );

  applyLabels(
    syncTelegramVisibleProofLabel({
      number,
      labels,
      proof: reportTelegramVisibleProof(markdown),
      dryRun,
      onMutation,
    }),
  );

  return { changed, currentPrStatusKind, labels, markdown };
}
