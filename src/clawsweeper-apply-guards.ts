import { createApplyGuardActivity, type GuardReads } from "./clawsweeper-apply-guard-activity.js";
import { createApplyGuardPolicy } from "./clawsweeper-apply-guard-policy.js";
import { createApplyGuardProof } from "./clawsweeper-apply-guard-proof.js";
import { createApplyGuardCapacity } from "./clawsweeper-apply-guard-capacity.js";
import { type LiveReadGeneration, type LiveReadOptions } from "./live-read-generation.js";

type GuardReadCacheEntry = { ok: true; value: unknown } | { ok: false; error: unknown };

// All guards read GitHub through one memoized copy of the read context.
export function createApplyGuards(gh: GuardReads) {
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

  const reads: GuardReads = {
    ghJson: <T>(args: string[]): T => memoizedGuardRead("json", args, () => gh.ghJson<T>(args)),
    ghPaged: <T>(path: string): T[] =>
      memoizedGuardRead("paged", [path], () => gh.ghPaged<T>(path)),
    targetRepo: gh.targetRepo,
  };
  const activity = createApplyGuardActivity(reads);
  const policy = createApplyGuardPolicy(reads, activity);
  const proof = createApplyGuardProof(reads, activity);
  const capacity = createApplyGuardCapacity(reads, activity);

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
  return {
    abandonedPrApplyBlockReasonSafe: proof.abandonedPrApplyBlockReasonSafe,
    authorPrBudgetApplyGateSafe: capacity.authorPrBudgetApplyGateSafe,
    issueRecentHumanCommentBlockReasonSafe: activity.issueRecentHumanCommentBlockReasonSafe,
    lowSignalUnmergeablePrApplyBlockReasonSafe: policy.lowSignalUnmergeablePrApplyBlockReasonSafe,
    obsoleteFixPrApplyBlockReasonSafe: capacity.obsoleteFixPrApplyBlockReasonSafe,
    pullRequestHeadActivity: activity.pullRequestHeadActivity,
    resetGuardReadCache,
    setGuardReadGeneration,
    staleVersionBugApplyBlockReasonSafe: policy.staleVersionBugApplyBlockReasonSafe,
    stalledUnprovenPrApplyBlockReasonSafe: proof.stalledUnprovenPrApplyBlockReasonSafe,
    stalledUnprovenProofRequestBlockReason: proof.stalledUnprovenProofRequestBlockReason,
    unconfirmedProductDirectionApplyBlockReasonSafe:
      policy.unconfirmedProductDirectionApplyBlockReasonSafe,
    unsponsoredFeatureApplyBlockReasonSafe: policy.unsponsoredFeatureApplyBlockReasonSafe,
    withGuardReadOptions,
  };
}
