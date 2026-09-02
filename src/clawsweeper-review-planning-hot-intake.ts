import type { ExistingReview, Item } from "./clawsweeper-types.js";
import {
  compareReviewedPrActivityCursors,
  isReviewedPrActivityCursor,
  readStableReviewedPrActivityCursor,
} from "./review-activity-cursor.js";
import { reviewStructuralPullStateDigest } from "./review-structural-cache.js";
import { HOT_INTAKE_FRESHNESS_MS, hasReviewPolicyMismatch } from "./scheduler-policy.js";
import type { ReviewPlanningDependencies } from "./clawsweeper-review-planning-dependencies.js";
import type { createReviewPlanningInventory } from "./clawsweeper-review-planning-inventory.js";

export function createReviewPlanningHotIntake(
  dependencies: ReviewPlanningDependencies & ReturnType<typeof createReviewPlanningInventory>,
) {
  const {
    ghJson,
    fetchReviewedPrActivityCursor,
    ghPaged,
    githubCount,
    itemSourceRevisionSha256,
    asRecord,
    frontMatterValue,
    stringOrUndefined,
    pullHeadShaFromReport,
  } = dependencies;

  type HotIntakeExactReviewSnapshot = {
    headSha: string;
    sourceRevision: string;
    pullStateDigest: string;
    reviewActivityCursor: string;
    itemUpdatedAt: string;
  };
  function hotIntakeExactReviewSnapshotFromReport(
    review: ExistingReview | null,
    now: number,
  ): HotIntakeExactReviewSnapshot | null {
    if (review?.reviewStatus !== "complete" || !review.reviewedAt) return null;
    const reviewedAt = Date.parse(review.reviewedAt);
    if (
      !Number.isFinite(reviewedAt) ||
      now < reviewedAt ||
      now - reviewedAt >= HOT_INTAKE_FRESHNESS_MS
    ) {
      return null;
    }
    const headSha = pullHeadShaFromReport(review.markdown)?.toLowerCase();
    const sourceRevision = review.itemSourceRevision?.trim();
    const pullStateDigest = frontMatterValue(review.markdown, "reviewed_pull_state_digest");
    const reviewActivityCursor = frontMatterValue(review.markdown, "review_activity_cursor");
    const itemUpdatedAt = review.itemUpdatedAt?.trim();
    if (
      !headSha ||
      !sourceRevision ||
      sourceRevision === "unknown" ||
      !pullStateDigest ||
      pullStateDigest === "unknown" ||
      pullStateDigest === "none" ||
      !isReviewedPrActivityCursor(reviewActivityCursor) ||
      !itemUpdatedAt
    ) {
      return null;
    }
    return { headSha, sourceRevision, pullStateDigest, reviewActivityCursor, itemUpdatedAt };
  }
  function currentHotIntakePullReviewSnapshot(item: Item): HotIntakeExactReviewSnapshot | null {
    try {
      const reviewActivityCursor = readStableReviewedPrActivityCursor(() =>
        fetchReviewedPrActivityCursor(item.number),
      );
      if (!reviewActivityCursor) return null;
      const comments = ghPaged<unknown>(`repos/${item.repo}/issues/${item.number}/comments`);
      const pull = ghJson<unknown>(["api", `repos/${item.repo}/pulls/${item.number}`]);
      const source = asRecord(pull);
      const headSha = stringOrUndefined(asRecord(source.head).sha)?.trim().toLowerCase();
      if (!headSha) return null;
      const itemUpdatedAt = stringOrUndefined(source.updated_at)?.trim();
      if (!itemUpdatedAt) return null;
      const baseSha = stringOrUndefined(asRecord(source.base).sha)?.trim().toLowerCase();
      const draft = source.draft;
      const mergeable = source.mergeable;
      const mergeStateStatus = stringOrUndefined(source.mergeable_state);
      const additions = githubCount(source.additions);
      const deletions = githubCount(source.deletions);
      const changedFiles = githubCount(source.changed_files);
      const commitCount = githubCount(source.commits);
      if (
        !baseSha ||
        typeof draft !== "boolean" ||
        (mergeable !== null && typeof mergeable !== "boolean" && typeof mergeable !== "string") ||
        !mergeStateStatus ||
        additions === null ||
        deletions === null ||
        changedFiles === null ||
        commitCount === null
      ) {
        return null;
      }
      const pullStateDigest = reviewStructuralPullStateDigest({
        headSha,
        baseSha,
        draft,
        mergeable,
        mergeStateStatus,
        additions,
        deletions,
        changedFiles,
        commitCount,
      });
      if (!pullStateDigest) return null;
      const revalidatedReviewActivityCursor = readStableReviewedPrActivityCursor(() =>
        fetchReviewedPrActivityCursor(item.number),
      );
      if (
        compareReviewedPrActivityCursors(revalidatedReviewActivityCursor, reviewActivityCursor) !==
        "equal"
      ) {
        return null;
      }
      return {
        headSha,
        sourceRevision: itemSourceRevisionSha256(pull, comments),
        pullStateDigest,
        reviewActivityCursor,
        itemUpdatedAt,
      };
    } catch (error) {
      console.error(
        `[plan] unable to verify fresh exact-review snapshot for ${item.repo}#${item.number}; leaving it eligible: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
  function hasUncapturedActivitySinceExactReview(item: Item, review: ExistingReview): boolean {
    const updatedAt = Date.parse(item.updatedAt);
    const reviewedAt = review.reviewedAt ? Date.parse(review.reviewedAt) : Number.NaN;
    if (!Number.isFinite(updatedAt) || !Number.isFinite(reviewedAt)) return true;
    // Local synchronization clocks are not ownership receipts. GitHub rounds
    // item activity to seconds, so target-side activity can share a timestamp
    // with a bot comment or label mutation. Keep all post-review activity hot;
    // the structural cache can still reuse the prior verdict after comparing a
    // complete source and timeline receipt.
    if (review.itemUpdatedAt && item.updatedAt === review.itemUpdatedAt) {
      return updatedAt === Math.floor(reviewedAt / 1000) * 1000;
    }
    return updatedAt >= Math.floor(reviewedAt / 1000) * 1000;
  }
  function shouldSkipScheduledHotIntakeExactReview(
    item: Item,
    review: ExistingReview | null,
    now: number,
    reviewPolicy: string,
  ): boolean {
    if (item.kind !== "pull_request") return false;
    if (hasReviewPolicyMismatch(review, reviewPolicy)) return false;
    if (!review || hasUncapturedActivitySinceExactReview(item, review)) return false;
    const reviewed = hotIntakeExactReviewSnapshotFromReport(review, now);
    if (!reviewed) return false;
    const current = currentHotIntakePullReviewSnapshot(item);
    return (
      current !== null &&
      (current.itemUpdatedAt === reviewed.itemUpdatedAt ||
        !hasUncapturedActivitySinceExactReview(
          { ...item, updatedAt: current.itemUpdatedAt },
          review,
        )) &&
      current.headSha === reviewed.headSha &&
      current.sourceRevision === reviewed.sourceRevision &&
      current.pullStateDigest === reviewed.pullStateDigest &&
      compareReviewedPrActivityCursors(
        current.reviewActivityCursor,
        reviewed.reviewActivityCursor,
      ) === "equal"
    );
  }
  function shouldSkipScheduledHotIntakeExactReviewForTest(options: {
    reviewStatus?: string;
    reviewedAt?: string;
    reviewHeadSha?: string;
    reviewSourceRevision?: string;
    reviewPullStateDigest?: string;
    reviewActivityCursor?: string;
    currentHeadSha?: string;
    currentSourceRevision?: string;
    currentPullStateDigest?: string;
    currentReviewActivityCursor?: string;
    currentItemUpdatedAt?: string;
    itemUpdatedAt?: string;
    reviewItemUpdatedAt?: string;
    automationItemUpdatedAt?: string;
    reviewCommentSyncedAt?: string;
    labelsSyncedAt?: string;
    reviewPolicy?: string;
    currentReviewPolicy?: string;
    now: number;
  }): boolean {
    const review = {
      reviewStatus: options.reviewStatus,
      reviewedAt: options.reviewedAt,
      markdown: `---\npull_head_sha: ${options.reviewHeadSha ?? "unknown"}\nreviewed_pull_state_digest: ${options.reviewPullStateDigest ?? "unknown"}\nreview_activity_cursor: ${options.reviewActivityCursor ?? "unknown"}\n---\n`,
      itemSourceRevision: options.reviewSourceRevision,
      reviewPolicy: options.reviewPolicy,
      itemUpdatedAt: options.reviewItemUpdatedAt,
      automationItemUpdatedAt: options.automationItemUpdatedAt,
      reviewCommentSyncedAt: options.reviewCommentSyncedAt,
      labelsSyncedAt: options.labelsSyncedAt,
    } as ExistingReview;
    if (hasReviewPolicyMismatch(review, options.currentReviewPolicy)) return false;
    const item = {
      kind: "pull_request",
      updatedAt: options.itemUpdatedAt ?? options.reviewedAt ?? "",
    } as Item;
    if (hasUncapturedActivitySinceExactReview(item, review)) return false;
    const reviewed = hotIntakeExactReviewSnapshotFromReport(review, options.now);
    if (
      !reviewed ||
      !options.currentHeadSha ||
      !options.currentSourceRevision ||
      !options.currentPullStateDigest ||
      !options.currentReviewActivityCursor ||
      !options.currentItemUpdatedAt
    ) {
      return false;
    }
    return (
      (options.currentItemUpdatedAt === reviewed.itemUpdatedAt ||
        !hasUncapturedActivitySinceExactReview(
          { kind: "pull_request", updatedAt: options.currentItemUpdatedAt } as Item,
          review,
        )) &&
      reviewed.headSha === options.currentHeadSha.trim().toLowerCase() &&
      reviewed.sourceRevision === options.currentSourceRevision.trim() &&
      reviewed.pullStateDigest === options.currentPullStateDigest.trim() &&
      compareReviewedPrActivityCursors(
        reviewed.reviewActivityCursor,
        options.currentReviewActivityCursor.trim(),
      ) === "equal"
    );
  }

  return {
    hotIntakeExactReviewSnapshotFromReport,
    currentHotIntakePullReviewSnapshot,
    hasUncapturedActivitySinceExactReview,
    shouldSkipScheduledHotIntakeExactReview,
    shouldSkipScheduledHotIntakeExactReviewForTest,
  };
}
