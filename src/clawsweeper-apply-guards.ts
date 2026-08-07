import type { ApplyGuardDependencies } from "./clawsweeper-apply-guard-dependencies.js";
import { createApplyGuardActivity } from "./clawsweeper-apply-guard-activity.js";
import { createApplyGuardPolicy } from "./clawsweeper-apply-guard-policy.js";
import { createApplyGuardProof } from "./clawsweeper-apply-guard-proof.js";
import { createApplyGuardCapacity } from "./clawsweeper-apply-guard-capacity.js";
export { STALLED_UNPROVEN_PROOF_STATUSES } from "./clawsweeper-apply-guard-dependencies.js";

type GuardReadCacheEntry = { ok: true; value: unknown } | { ok: false; error: unknown };

export function createApplyGuards(dependencies: ApplyGuardDependencies) {
  const guardReadCache = new Map<string, GuardReadCacheEntry>();

  function memoizedGuardRead<T>(kind: "json" | "paged", args: readonly string[], read: () => T): T {
    const key = JSON.stringify([kind, ...args]);
    const cached = guardReadCache.get(key);
    if (cached) {
      if (cached.ok) return cached.value as T;
      throw cached.error;
    }
    try {
      const value = read();
      guardReadCache.set(key, { ok: true, value });
      return value;
    } catch (error) {
      guardReadCache.set(key, { ok: false, error });
      throw error;
    }
  }

  const guardDependencies: ApplyGuardDependencies = {
    ...dependencies,
    ghJson: <T>(args: string[]): T =>
      memoizedGuardRead("json", args, () => dependencies.ghJson<T>(args)),
    ghPaged: <T>(path: string): T[] =>
      memoizedGuardRead("paged", [path], () => dependencies.ghPaged<T>(path)),
  };
  const activity = createApplyGuardActivity({ ...guardDependencies });
  const policy = createApplyGuardPolicy({ ...guardDependencies, ...activity });
  const proof = createApplyGuardProof({ ...guardDependencies, ...activity, ...policy });
  const capacity = createApplyGuardCapacity({
    ...guardDependencies,
    ...activity,
    ...policy,
    ...proof,
  });

  function resetGuardReadCache(): void {
    guardReadCache.clear();
  }
  const {
    abandonedPrAgeSkipReason,
    abandonedPrApplyBlockReasonSafe,
    authorPrBudgetApplyGateSafe,
    authorPrBudgetSignalBlockReason,
    issueRecentHumanCommentBlockReasonFromComments,
    issueRecentHumanCommentBlockReasonSafe,
    lowSignalUnmergeablePrApplyBlockReasonSafe,
    lowSignalUnmergeablePrAuthorActivityBlockReason,
    lowSignalUnmergeablePrConflictBlockReason,
    obsoleteFixPrApplyBlockReasonSafe,
    prAutoCloseExemptDecisionReason,
    prAutoCloseExemptLabel,
    pullRequestHeadActivity,
    staleVersionBugApplyBlockReasonSafe,
    stalledUnprovenPrAgeSkipReason,
    stalledUnprovenPrApplyBlockReasonSafe,
    stalledUnprovenProofRequestBlockReason,
    unconfirmedProductDirectionApplyBlockReasonSafe,
    unsponsoredFeatureApplyBlockReasonSafe,
  } = { ...activity, ...policy, ...proof, ...capacity };
  return {
    abandonedPrAgeSkipReason,
    abandonedPrApplyBlockReasonSafe,
    authorPrBudgetApplyGateSafe,
    authorPrBudgetSignalBlockReason,
    issueRecentHumanCommentBlockReasonFromComments,
    issueRecentHumanCommentBlockReasonSafe,
    lowSignalUnmergeablePrApplyBlockReasonSafe,
    lowSignalUnmergeablePrAuthorActivityBlockReason,
    lowSignalUnmergeablePrConflictBlockReason,
    obsoleteFixPrApplyBlockReasonSafe,
    prAutoCloseExemptDecisionReason,
    prAutoCloseExemptLabel,
    pullRequestHeadActivity,
    resetGuardReadCache,
    staleVersionBugApplyBlockReasonSafe,
    stalledUnprovenPrAgeSkipReason,
    stalledUnprovenPrApplyBlockReasonSafe,
    stalledUnprovenProofRequestBlockReason,
    unconfirmedProductDirectionApplyBlockReasonSafe,
    unsponsoredFeatureApplyBlockReasonSafe,
  };
}
