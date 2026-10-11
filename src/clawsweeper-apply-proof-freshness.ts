import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { completeActivityContextSymbol } from "./clawsweeper-types.js";
import type {
  Item,
  ItemContext,
  ItemKind,
  PrCloseCoverageProofGateBlock,
  PrCloseCoverageProofGateResult,
} from "./clawsweeper-types.js";
import {
  compareReviewedPrActivityCursors,
  isReviewedPrActivityCursor,
} from "./review-activity-cursor.js";
import { stableJson } from "./stable-json.js";

export interface ApplySelfMutationItemReceipt {
  updatedAt: string;
  /**
   * `updated_at` of the ClawSweeper write itself, when it differs from the item `updated_at` read
   * right after the write. GitHub can move the item to this time later.
   */
  ownedWriteUpdatedAt?: string;
  sourceRevision: string;
  activityReceipt: string;
  allowsPostReviewAutomationActivity?: boolean;
  postReviewActivityStartedAtMs?: number;
  requiresReviewedPrActivityCursor?: boolean;
  prHeadSha: string | null;
  prHeadMatches: boolean;
  reviewActivityCursor: string | null;
}

type ApplyProofFreshnessDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "collectItemContext"
  | "contextHasNonAutomationActivityAfter"
  | "coveringPrCloseCoveragePullRequestSnapshotSha256"
  | "fetchItem"
  | "fetchReviewedPrActivityCursor"
  | "freshPullRequestReviewHead"
  | "GitHubRuntimeBudgetError"
  | "itemSnapshotHash"
> & {
  action: string | undefined;
  automationItemUpdatedAt: string | undefined;
  completeReviewActivityReceiptMatches: (context: ItemContext) => boolean;
  currentProofState: () => {
    /**
     * Live `updated_at` that the pre-apply source-freshness gate already accepted as the
     * reviewed source (unchanged, or moved only by receipt-backed ClawSweeper writes). Absent
     * when that gate did not accept it.
     */
    acceptedUpdatedAt: string | undefined;
    cachedPrCloseCoverageProofGateResult: PrCloseCoverageProofGateResult | undefined;
    prCloseCoverageProofGateChecked: boolean;
    prCloseCoverageProofStartedAtMs: number | null;
    storedHash: string | undefined;
    storedUpdatedAt: string | undefined;
  };
  expectedReviewActivityCursor: string | undefined;
  itemKind: ItemKind;
  number: number;
  reviewMarkdown: string;
  reviewHasCompleteActivityIdentity: boolean;
  retryCloseCoverageCommandStatusOnlyUpdate: (item: Item, context: ItemContext) => boolean;
  selfMutationItemReceipts: readonly ApplySelfMutationItemReceipt[];
};

export function createApplyProofFreshnessGuards({
  action,
  automationItemUpdatedAt,
  collectItemContext,
  completeReviewActivityReceiptMatches,
  contextHasNonAutomationActivityAfter,
  coveringPrCloseCoveragePullRequestSnapshotSha256,
  currentProofState,
  expectedReviewActivityCursor,
  fetchItem,
  fetchReviewedPrActivityCursor,
  freshPullRequestReviewHead,
  GitHubRuntimeBudgetError,
  itemKind,
  itemSnapshotHash,
  number,
  reviewMarkdown,
  reviewHasCompleteActivityIdentity,
  retryCloseCoverageCommandStatusOnlyUpdate,
  selfMutationItemReceipts,
}: ApplyProofFreshnessDependencies) {
  const postProofFreshnessBlock = (
    options: { force?: boolean } = {},
  ): {
    reason: string;
    currentUpdatedAt?: string;
    currentSnapshotHash?: string;
  } | null => {
    const {
      acceptedUpdatedAt,
      cachedPrCloseCoverageProofGateResult,
      prCloseCoverageProofGateChecked,
      prCloseCoverageProofStartedAtMs,
      storedHash,
      storedUpdatedAt,
    } = currentProofState();
    const hasPostReviewSelfMutationReceipt = selfMutationItemReceipts.some(
      (receipt) => receipt.allowsPostReviewAutomationActivity,
    );
    if (
      !options.force &&
      (!prCloseCoverageProofGateChecked ||
        cachedPrCloseCoverageProofGateResult?.status !== "allowed") &&
      !hasPostReviewSelfMutationReceipt
    ) {
      return null;
    }
    const refreshed = fetchItem(number, { bypassGenerationCache: true });
    if (refreshed.state !== "open") {
      return {
        reason: `state changed to ${refreshed.state}`,
        currentUpdatedAt: refreshed.item.updatedAt,
      };
    }
    let refreshedContext: ItemContext | null = null;
    const refreshedCommandStatusOnlyUpdate =
      action === "retry_pr_close_coverage_proof" &&
      retryCloseCoverageCommandStatusOnlyUpdate(
        refreshed.item,
        (refreshedContext ??= collectItemContext(refreshed.item, {
          fullTimelineForRelations: true,
          reviewCacheDigest: true,
          bypassGenerationCache: true,
        })),
      );
    const candidateItemReceipts = selfMutationItemReceipts.filter(
      (receipt) =>
        receipt.updatedAt === refreshed.item.updatedAt ||
        receipt.ownedWriteUpdatedAt === refreshed.item.updatedAt,
    );
    const mayMatchPersistedAutomationReceipt =
      Boolean(automationItemUpdatedAt) && refreshed.item.updatedAt === automationItemUpdatedAt;
    if (candidateItemReceipts.length > 0 || mayMatchPersistedAutomationReceipt) {
      refreshedContext ??= collectItemContext(refreshed.item, {
        fullTimelineForRelations: true,
        reviewCacheDigest: true,
        bypassGenerationCache: true,
      });
    }
    const refreshedCompleteActivityContext = refreshedContext?.[completeActivityContextSymbol];
    const refreshedActivityReceipt = refreshedCompleteActivityContext
      ? stableJson(refreshedCompleteActivityContext)
      : null;
    // The pre-apply gate already accepted this updated_at as ClawSweeper's own receipt-backed
    // write (such as the automatic review progress edit). A same-second human edit can share
    // that timestamp, so the accepted baseline still needs the review's complete structural
    // receipt (source, timeline, head, review activity) to match the live item below.
    const atAcceptedBaseline =
      acceptedUpdatedAt !== undefined &&
      acceptedUpdatedAt !== storedUpdatedAt &&
      refreshed.item.updatedAt === acceptedUpdatedAt;
    const refreshedReviewActivityCursor =
      itemKind === "pull_request" &&
      (candidateItemReceipts.length > 0 ||
        mayMatchPersistedAutomationReceipt ||
        atAcceptedBaseline ||
        refreshed.item.updatedAt === storedUpdatedAt)
        ? fetchReviewedPrActivityCursor(number)
        : null;
    const refreshedItemReceiptMatches = candidateItemReceipts.some((receipt) => {
      if (
        refreshedContext?.sourceRevision !== receipt.sourceRevision ||
        refreshedActivityReceipt !== receipt.activityReceipt ||
        !receipt.prHeadMatches ||
        refreshedContext === null
      ) {
        return false;
      }
      if (itemKind !== "pull_request") return true;
      if (receipt.allowsPostReviewAutomationActivity) {
        if (
          receipt.requiresReviewedPrActivityCursor
            ? !freshPullRequestReviewHead(reviewMarkdown, refreshedContext)
            : receipt.prHeadSha === null ||
              contextPullHeadSha(refreshedContext) !== receipt.prHeadSha
        )
          return false;
        if (!receipt.requiresReviewedPrActivityCursor) return true;
        if (
          !isReviewedPrActivityCursor(receipt.reviewActivityCursor) ||
          !isReviewedPrActivityCursor(refreshedReviewActivityCursor) ||
          !isReviewedPrActivityCursor(expectedReviewActivityCursor) ||
          compareReviewedPrActivityCursors(
            receipt.reviewActivityCursor,
            expectedReviewActivityCursor,
          ) !== "equal"
        )
          return false;
        return (
          compareReviewedPrActivityCursors(
            receipt.reviewActivityCursor,
            refreshedReviewActivityCursor,
          ) === "equal"
        );
      }
      if (!freshPullRequestReviewHead(reviewMarkdown, refreshedContext)) return false;
      if (!isReviewedPrActivityCursor(expectedReviewActivityCursor)) return false;
      return (
        compareReviewedPrActivityCursors(
          receipt.reviewActivityCursor,
          expectedReviewActivityCursor,
        ) === "equal" &&
        compareReviewedPrActivityCursors(
          refreshedReviewActivityCursor,
          expectedReviewActivityCursor,
        ) === "equal"
      );
    });
    const refreshedCompleteReceiptMatchesReview = (): boolean => {
      refreshedContext ??= collectItemContext(refreshed.item, {
        fullTimelineForRelations: true,
        reviewCacheDigest: true,
        bypassGenerationCache: true,
      });
      if (!completeReviewActivityReceiptMatches(refreshedContext)) return false;
      return (
        itemKind !== "pull_request" ||
        compareReviewedPrActivityCursors(
          refreshedReviewActivityCursor,
          expectedReviewActivityCursor,
        ) === "equal"
      );
    };
    const persistedAutomationReceiptMatches =
      mayMatchPersistedAutomationReceipt &&
      reviewHasCompleteActivityIdentity &&
      refreshedCompleteReceiptMatchesReview();
    // Same structural standard as a persisted automation receipt: the timestamp alone never
    // proves ownership.
    const acceptedBaselineReceiptMatches =
      atAcceptedBaseline &&
      reviewHasCompleteActivityIdentity &&
      refreshedCompleteReceiptMatchesReview();
    const refreshedSelfMutationOnlyUpdate =
      refreshedItemReceiptMatches ||
      persistedAutomationReceiptMatches ||
      acceptedBaselineReceiptMatches ||
      refreshedCommandStatusOnlyUpdate;
    const selfMutationMaskedNonAutomationActivity = (): boolean => {
      const postReviewSelfMutationAtMs = candidateItemReceipts
        .filter((receipt) => receipt.allowsPostReviewAutomationActivity)
        .map((receipt) => receipt.postReviewActivityStartedAtMs ?? Date.parse(receipt.updatedAt))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => right - left)[0];
      const activityStartMs = prCloseCoverageProofStartedAtMs ?? postReviewSelfMutationAtMs;
      if (activityStartMs === undefined) return true;
      refreshedContext ??= collectItemContext(refreshed.item, {
        fullTimelineForRelations: true,
        reviewCacheDigest: true,
        bypassGenerationCache: true,
      });
      const activitySecondStartMs = Math.floor(activityStartMs / 1000) * 1000;
      return contextHasNonAutomationActivityAfter(refreshedContext, activitySecondStartMs - 1, {
        truncationCountsAsActivity: candidateItemReceipts.some(
          (receipt) => receipt.allowsPostReviewAutomationActivity,
        ),
      });
    };
    if (storedUpdatedAt && refreshed.item.updatedAt !== storedUpdatedAt) {
      if (refreshedSelfMutationOnlyUpdate) {
        if (!selfMutationMaskedNonAutomationActivity()) return null;
        return {
          reason: "non-automation activity after coverage proof",
          currentUpdatedAt: refreshed.item.updatedAt,
        };
      }
      // Names which self-mutation receipt failed, so a self-feeding re-review loop shows
      // its cause in the workflow log. Booleans and public GitHub timestamps only.
      console.error(
        `[apply] post-proof drift #${number} ${JSON.stringify({
          stored_updated_at: storedUpdatedAt,
          item_updated_at: refreshed.item.updatedAt,
          automation_item_updated_at: automationItemUpdatedAt ?? null,
          self_mutation_receipt_updated_ats: selfMutationItemReceipts.map(
            (receipt) => receipt.updatedAt,
          ),
          self_mutation_owned_write_updated_ats: selfMutationItemReceipts.flatMap((receipt) =>
            receipt.ownedWriteUpdatedAt ? [receipt.ownedWriteUpdatedAt] : [],
          ),
          candidate_receipts: candidateItemReceipts.length,
          receipt_matches: refreshedItemReceiptMatches,
          persisted_receipt_matches: persistedAutomationReceiptMatches,
          accepted_baseline: atAcceptedBaseline,
          accepted_baseline_receipt_matches: acceptedBaselineReceiptMatches,
          command_status_only: refreshedCommandStatusOnlyUpdate,
        })}`,
      );
      return {
        reason: "updated_at changed",
        currentUpdatedAt: refreshed.item.updatedAt,
      };
    }
    if (
      storedUpdatedAt &&
      refreshed.item.updatedAt === storedUpdatedAt &&
      reviewHasCompleteActivityIdentity &&
      !refreshedCompleteReceiptMatchesReview()
    ) {
      return {
        reason: "same-second activity requires a fresh review",
        currentUpdatedAt: refreshed.item.updatedAt,
      };
    }
    if (!storedUpdatedAt && storedHash) {
      const refreshedHash = itemSnapshotHash(
        refreshed.item,
        (refreshedContext ??= collectItemContext(refreshed.item, {
          fullTimelineForRelations: true,
          reviewCacheDigest: true,
          bypassGenerationCache: true,
        })),
      );
      if (refreshedHash !== storedHash) {
        if (refreshedSelfMutationOnlyUpdate && !selfMutationMaskedNonAutomationActivity()) {
          return null;
        }
        return {
          reason: refreshedSelfMutationOnlyUpdate
            ? "non-automation activity after coverage proof"
            : "snapshot changed",
          currentSnapshotHash: refreshedHash,
        };
      }
    }
    return null;
  };

  const postProofCoveringPrFreshnessBlock = (): PrCloseCoverageProofGateBlock | null => {
    const { cachedPrCloseCoverageProofGateResult, prCloseCoverageProofGateChecked } =
      currentProofState();
    if (
      !prCloseCoverageProofGateChecked ||
      cachedPrCloseCoverageProofGateResult?.status !== "allowed"
    ) {
      return null;
    }
    const { covering } = cachedPrCloseCoverageProofGateResult;
    try {
      const currentSnapshotSha256 = coveringPrCloseCoveragePullRequestSnapshotSha256(
        covering.number,
      );
      if (currentSnapshotSha256 === covering.snapshotSha256) return null;
      return {
        actionTaken: "retry_pr_close_coverage_proof",
        reason: `linked canonical PR #${covering.number} changed after coverage proof`,
      };
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      return {
        actionTaken: "retry_pr_close_coverage_proof",
        reason: `PR close coverage proof could not recheck linked canonical PR #${covering.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };

  return { postProofCoveringPrFreshnessBlock, postProofFreshnessBlock };
}

function contextPullHeadSha(context: ItemContext): string | null {
  const pullRequest = context.pullRequest;
  if (!pullRequest || typeof pullRequest !== "object") return null;
  const head = (pullRequest as { head?: unknown }).head;
  if (!head || typeof head !== "object") return null;
  const sha = (head as { sha?: unknown }).sha;
  return typeof sha === "string" && sha ? sha : null;
}
