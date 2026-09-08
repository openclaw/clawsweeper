import type { ApplyGuardDependencies } from "./clawsweeper-apply-guard-dependencies.js";
import { createApplyGuardActivity } from "./clawsweeper-apply-guard-activity.js";
import { createApplyGuardPolicy } from "./clawsweeper-apply-guard-policy.js";
import { createApplyGuardProof } from "./clawsweeper-apply-guard-proof.js";
import { createApplyGuardCapacity } from "./clawsweeper-apply-guard-capacity.js";
import { type LiveReadGeneration, type LiveReadOptions } from "./live-read-generation.js";
export { STALLED_UNPROVEN_PROOF_STATUSES } from "./clawsweeper-apply-guard-dependencies.js";

type GuardReadCacheEntry = { ok: true; value: unknown } | { ok: false; error: unknown };

export function createApplyGuards(dependencies: ApplyGuardDependencies) {
  const guardReadCache = new Map<string, GuardReadCacheEntry>();
  let liveReadGeneration: LiveReadGeneration | null = null;
  let liveReadOptions: LiveReadOptions = {};

  function memoizedGuardRead<T>(kind: "json" | "paged", args: readonly string[], read: () => T): T {
    const key = JSON.stringify([kind, ...args]);
    if (liveReadGeneration) return liveReadGeneration.read(key, read, liveReadOptions);
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
  function setGuardReadGeneration(generation: LiveReadGeneration | null): void {
    liveReadGeneration = generation;
    guardReadCache.clear();
  }
  function withGuardReadOptions<T>(options: LiveReadOptions, read: () => T): T {
    const previous = liveReadOptions;
    liveReadOptions = options;
    try {
      return read();
    } finally {
      liveReadOptions = previous;
    }
  }
  const tools = { ...activity, ...policy, ...proof, ...capacity };
  return {
    abandonedPrAgeSkipReason: tools.abandonedPrAgeSkipReason,
    abandonedPrApplyBlockReasonSafe: tools.abandonedPrApplyBlockReasonSafe,
    authorPrBudgetApplyGateSafe: tools.authorPrBudgetApplyGateSafe,
    authorPrBudgetSignalBlockReason: tools.authorPrBudgetSignalBlockReason,
    issueRecentHumanCommentBlockReasonFromComments:
      tools.issueRecentHumanCommentBlockReasonFromComments,
    issueRecentHumanCommentBlockReasonSafe: tools.issueRecentHumanCommentBlockReasonSafe,
    lowSignalUnmergeablePrApplyBlockReasonSafe: tools.lowSignalUnmergeablePrApplyBlockReasonSafe,
    lowSignalUnmergeablePrAuthorActivityBlockReason:
      tools.lowSignalUnmergeablePrAuthorActivityBlockReason,
    lowSignalUnmergeablePrConflictBlockReason: tools.lowSignalUnmergeablePrConflictBlockReason,
    obsoleteFixPrApplyBlockReasonSafe: tools.obsoleteFixPrApplyBlockReasonSafe,
    prAutoCloseExemptDecisionReason: tools.prAutoCloseExemptDecisionReason,
    prAutoCloseExemptLabel: tools.prAutoCloseExemptLabel,
    pullRequestHeadActivity: tools.pullRequestHeadActivity,
    resetGuardReadCache,
    setGuardReadGeneration,
    staleVersionBugApplyBlockReasonSafe: tools.staleVersionBugApplyBlockReasonSafe,
    stalledUnprovenPrAgeSkipReason: tools.stalledUnprovenPrAgeSkipReason,
    stalledUnprovenPrApplyBlockReasonSafe: tools.stalledUnprovenPrApplyBlockReasonSafe,
    stalledUnprovenProofRequestBlockReason: tools.stalledUnprovenProofRequestBlockReason,
    unconfirmedProductDirectionApplyBlockReasonSafe:
      tools.unconfirmedProductDirectionApplyBlockReasonSafe,
    unsponsoredFeatureApplyBlockReasonSafe: tools.unsponsoredFeatureApplyBlockReasonSafe,
    withGuardReadOptions,
  };
}
