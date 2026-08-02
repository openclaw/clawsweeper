import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import type {
  Item,
  ItemContext,
  PrCloseCoverageProofGateBlock,
  PrCloseCoverageProofGateResult,
} from "./clawsweeper-types.js";

type ApplyProofFreshnessDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "collectItemContext"
  | "contextHasNonAutomationActivityAfter"
  | "coveringPrCloseCoveragePullRequestUpdatedAt"
  | "fetchItem"
  | "GitHubRuntimeBudgetError"
  | "itemSnapshotHash"
> & {
  action: string | undefined;
  allowedSelfMutationUpdatedAts: ReadonlySet<string>;
  currentProofState: () => {
    cachedPrCloseCoverageProofGateResult: PrCloseCoverageProofGateResult | undefined;
    prCloseCoverageProofGateChecked: boolean;
    prCloseCoverageProofStartedAtMs: number | null;
    storedHash: string | undefined;
    storedUpdatedAt: string | undefined;
  };
  number: number;
  retryCloseCoverageCommandStatusOnlyUpdate: (item: Item, context: ItemContext) => boolean;
};

export function createApplyProofFreshnessGuards({
  action,
  allowedSelfMutationUpdatedAts,
  collectItemContext,
  contextHasNonAutomationActivityAfter,
  coveringPrCloseCoveragePullRequestUpdatedAt,
  currentProofState,
  fetchItem,
  GitHubRuntimeBudgetError,
  itemSnapshotHash,
  number,
  retryCloseCoverageCommandStatusOnlyUpdate,
}: ApplyProofFreshnessDependencies) {
  const postProofFreshnessBlock = (): {
    reason: string;
    currentUpdatedAt?: string;
    currentSnapshotHash?: string;
  } | null => {
    const {
      cachedPrCloseCoverageProofGateResult,
      prCloseCoverageProofGateChecked,
      prCloseCoverageProofStartedAtMs,
      storedHash,
      storedUpdatedAt,
    } = currentProofState();
    if (
      !prCloseCoverageProofGateChecked ||
      cachedPrCloseCoverageProofGateResult?.status !== "allowed"
    ) {
      return null;
    }
    const refreshed = fetchItem(number);
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
        })),
      );
    const refreshedSelfMutationOnlyUpdate =
      allowedSelfMutationUpdatedAts.has(refreshed.item.updatedAt) ||
      refreshedCommandStatusOnlyUpdate;
    const selfMutationMaskedNonAutomationActivity = (): boolean => {
      if (prCloseCoverageProofStartedAtMs === null) return true;
      refreshedContext ??= collectItemContext(refreshed.item, {
        fullTimelineForRelations: true,
      });
      return contextHasNonAutomationActivityAfter(
        refreshedContext,
        prCloseCoverageProofStartedAtMs,
        { truncationCountsAsActivity: false },
      );
    };
    if (storedUpdatedAt && refreshed.item.updatedAt !== storedUpdatedAt) {
      if (refreshedSelfMutationOnlyUpdate) {
        if (!selfMutationMaskedNonAutomationActivity()) return null;
        return {
          reason: "non-automation activity after coverage proof",
          currentUpdatedAt: refreshed.item.updatedAt,
        };
      }
      return {
        reason: "updated_at changed",
        currentUpdatedAt: refreshed.item.updatedAt,
      };
    }
    if (!storedUpdatedAt && storedHash) {
      const refreshedHash = itemSnapshotHash(
        refreshed.item,
        (refreshedContext ??= collectItemContext(refreshed.item, {
          fullTimelineForRelations: true,
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
    if (!covering.updatedAt) return null;
    try {
      const currentUpdatedAt = coveringPrCloseCoveragePullRequestUpdatedAt(covering.number);
      if (currentUpdatedAt === covering.updatedAt) return null;
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
