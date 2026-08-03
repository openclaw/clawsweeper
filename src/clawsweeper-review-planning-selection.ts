import { UserFacingCommandError } from "./command.js";
import type {
  DueCandidate,
  Item,
  PlanCandidateResult,
  PlanSelectionTelemetry,
  PlanShard,
} from "./clawsweeper-types.js";
import {
  appendFloorBackfillCandidates,
  compareDueCandidates,
  compareHotIntakeDueCandidates,
  selectDueCandidates,
} from "./scheduler-policy.js";
import type { ReviewPlanningDependencies } from "./clawsweeper-review-planning-dependencies.js";
import type { createReviewPlanningInventory } from "./clawsweeper-review-planning-inventory.js";
import type { createReviewPlanningHotIntake } from "./clawsweeper-review-planning-hot-intake.js";
import type { createReviewPlanningDashboard } from "./clawsweeper-review-planning-dashboard.js";

export function createReviewPlanningSelection(
  dependencies: ReviewPlanningDependencies &
    ReturnType<typeof createReviewPlanningInventory> &
    ReturnType<typeof createReviewPlanningHotIntake> &
    ReturnType<typeof createReviewPlanningDashboard>,
) {
  const {
    maxPlanShardCount: MAX_PLAN_SHARD_COUNT,
    targetRepo,
    shouldPlanItem,
    buildExistingReviewIndex,
    dueCandidate,
    reviewBackfillCandidate,
    fetchOpenItemPage,
    fetchHotIntakeItems,
    fetchItem,
    shouldSkipScheduledHotIntakeExactReview,
  } = dependencies;

  function selectCandidates(options: {
    batchSize: number;
    maxPages: number;
    shardIndex: number;
    shardCount: number;
    itemsDir: string;
    itemNumber?: number;
    itemNumbers?: number[];
    reviewPolicy?: string;
    hotIntake?: boolean;
    // Local-review extension: review closed/merged items too (fixtures, hypothetical
    // re-review). Default false preserves the open-only rule for normal operation.
    allowClosed?: boolean;
  }): { candidates: Item[]; scannedPages: number } {
    if (options.itemNumbers) {
      const candidates = options.itemNumbers.flatMap((number) => {
        const { item, state } = fetchItem(number);
        return state === "open" || options.allowClosed ? [item] : [];
      });
      return { candidates, scannedPages: 0 };
    }
    if (options.itemNumber) {
      if (options.shardIndex !== 0) return { candidates: [], scannedPages: 0 };
      const { item, state } = fetchItem(options.itemNumber);
      if (state !== "open" && !options.allowClosed) return { candidates: [], scannedPages: 0 };
      return { candidates: [item], scannedPages: 0 };
    }
    const due: DueCandidate[] = [];
    const now = Date.now();
    const reviewIndex = buildExistingReviewIndex(options.itemsDir);
    if (options.hotIntake) {
      const { items, pagesScanned } = fetchHotIntakeItems(options.maxPages);
      for (const item of items) {
        if (item.number % options.shardCount !== options.shardIndex) continue;
        if (!shouldPlanItem(item)) continue;
        const candidate = dueCandidate(
          item,
          options.itemsDir,
          now,
          options.reviewPolicy,
          reviewIndex,
        );
        if (candidate) due.push(candidate);
      }
      const candidates = selectDueCandidates(
        due,
        options.batchSize,
        compareHotIntakeDueCandidates,
      ).map(({ item }) => item);
      return { candidates, scannedPages: pagesScanned };
    }
    let scannedPages = 0;
    for (let page = 1; page <= options.maxPages; page += 1) {
      const items = fetchOpenItemPage(page);
      scannedPages = page;
      if (items.length === 0) break;
      for (const item of items) {
        if (item.number % options.shardCount !== options.shardIndex) continue;
        if (!shouldPlanItem(item)) continue;
        const candidate = dueCandidate(
          item,
          options.itemsDir,
          now,
          options.reviewPolicy,
          reviewIndex,
        );
        if (candidate) due.push(candidate);
      }
    }
    const candidates = selectDueCandidates(due, options.batchSize)
      .slice(0, options.batchSize)
      .map(({ item }) => item);
    return { candidates, scannedPages };
  }
  function exactLocalReviewNoCandidateError(
    itemNumber: number | undefined,
    shardIndex: number,
  ): UserFacingCommandError {
    if (itemNumber === undefined) {
      return new UserFacingCommandError("No review was run because no item number was provided.");
    }
    if (shardIndex !== 0) {
      return new UserFacingCommandError(
        `No review was run for ${targetRepo()}#${itemNumber} because exact item reviews only run on shard 0. Remove --shard-index for local reviews.`,
      );
    }
    try {
      const { item, state } = fetchItem(itemNumber);
      if (state !== "open") {
        return new UserFacingCommandError(
          `No review was run for ${targetRepo()}#${itemNumber} because GitHub reports this ${item.kind === "pull_request" ? "PR" : "issue"} is ${state}. Local exact review only reviews open items.`,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return new UserFacingCommandError(
        `No review was run for ${targetRepo()}#${itemNumber} because the item could not be loaded from GitHub. If this is a different repository, pass --target-repo owner/name. ${reason}`,
      );
    }
    return new UserFacingCommandError(
      `No review was run for ${targetRepo()}#${itemNumber}. The item was not selected for review.`,
    );
  }
  function openExplicitItems(itemNumbers: readonly number[]): Item[] {
    const seen = new Set<number>();
    const candidates: Item[] = [];
    for (const number of itemNumbers) {
      if (seen.has(number)) continue;
      seen.add(number);
      const { item, state } = fetchItem(number);
      if (state === "open") candidates.push(item);
    }
    return candidates;
  }
  function planShardCount(shardCount: number): number {
    if (!Number.isFinite(shardCount)) return 1;
    return Math.max(1, Math.min(MAX_PLAN_SHARD_COUNT, Math.floor(shardCount)));
  }
  function shardItemNumbers(itemNumbers: readonly number[], shardCount: number): PlanShard[] {
    const count = Math.max(1, Math.min(planShardCount(shardCount), itemNumbers.length || 1));
    const shards = Array.from({ length: count }, (_, shard) => ({
      shard,
      itemNumbers: [] as number[],
    }));
    itemNumbers.forEach((number, index) => {
      shards[index % shards.length]?.itemNumbers.push(number);
    });
    return shards;
  }
  function activeCodexTarget(shards: readonly PlanShard[]): number {
    return shards.filter((shard) => shard.itemNumbers.length > 0).length;
  }
  function oldestUnreviewedAt(candidates: readonly DueCandidate[]): string | undefined {
    let oldest: string | undefined;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const coverageTracked =
        candidate.coverageTracked === undefined
          ? candidate.review !== null
          : candidate.coverageTracked;
      if (coverageTracked) continue;
      const createdAtMs = Date.parse(candidate.item.createdAt);
      if (!Number.isFinite(createdAtMs) || createdAtMs >= oldestMs) continue;
      oldestMs = createdAtMs;
      oldest = candidate.item.createdAt;
    }
    return oldest;
  }
  function planCapacityReason(options: {
    selectedCount: number;
    dueBacklog: number;
    capacity: number;
    exact?: boolean;
    activeFloor?: number;
    floorBackfill?: number;
  }): string {
    if (options.exact) {
      return options.selectedCount === 0
        ? "idle: no requested open items found"
        : "exact: requested item selection";
    }
    if ((options.floorBackfill ?? 0) > 0) {
      return `floor: due backlog below active floor; filled ${options.floorBackfill} stale current item(s)`;
    }
    if ((options.activeFloor ?? 0) > 0 && options.selectedCount < (options.activeFloor ?? 0)) {
      return `under floor: only ${options.selectedCount} eligible item(s) found for active floor ${options.activeFloor}`;
    }
    if (options.selectedCount === 0) return "idle: no due candidates found";
    if (options.dueBacklog >= options.capacity)
      return "saturated: due backlog filled planned capacity";
    return "under capacity: due backlog below planned capacity";
  }
  function planSelectionTelemetry(
    selected: readonly DueCandidate[],
    now: number,
  ): PlanSelectionTelemetry[] {
    return selected.map((candidate) => {
      const createdAt = Date.parse(candidate.item.createdAt);
      const referenceAt = candidate.reviewedAt > 0 ? candidate.reviewedAt : createdAt;
      return {
        itemNumber: candidate.item.number,
        bucket: candidate.bucket,
        coverageTracked:
          candidate.coverageTracked === undefined
            ? candidate.review !== null
            : candidate.coverageTracked,
        lastReviewedAt: candidate.review?.reviewedAt ?? null,
        ageMs: Number.isFinite(referenceAt) ? Math.max(0, now - referenceAt) : 0,
        nextDueAt: new Date(candidate.nextDueAt).toISOString(),
      };
    });
  }
  function planCandidates(options: {
    batchSize: number;
    maxPages: number;
    shardCount: number;
    itemsDir: string;
    itemNumber?: number;
    itemNumbers?: number[];
    reviewPolicy: string;
    hotIntake?: boolean;
    minimumActiveShards?: number;
    minimumBackfillReviewAgeMs?: number;
    coverageTrackedItemIds?: ReadonlySet<number>;
  }): PlanCandidateResult {
    const shardCount = planShardCount(options.shardCount);
    const batchSize = Math.max(1, options.batchSize);
    const capacity = batchSize * shardCount;
    const activeFloor =
      options.hotIntake || options.itemNumber || options.itemNumbers
        ? 0
        : Math.max(0, Math.min(capacity, Math.floor(options.minimumActiveShards ?? 0)));
    const minimumBackfillReviewAgeMs = Math.max(0, options.minimumBackfillReviewAgeMs ?? 0);
    if (options.itemNumbers) {
      const candidates = openExplicitItems(options.itemNumbers);
      const shards = shardItemNumbers(
        candidates.map((item) => item.number),
        shardCount,
      );
      return {
        shards,
        scannedPages: 0,
        candidates,
        capacity,
        dueBacklog: candidates.length,
        activeCodexTarget: activeCodexTarget(shards),
        oldestUnreviewedAt: undefined,
        floorBackfill: 0,
        selection: [],
        capacityReason: planCapacityReason({
          selectedCount: candidates.length,
          dueBacklog: candidates.length,
          capacity,
          exact: true,
        }),
      };
    }
    if (options.itemNumber) {
      const { item, state } = fetchItem(options.itemNumber);
      const shouldReview = state === "open";
      const candidates = shouldReview ? [item] : [];
      const shards = [{ shard: 0, itemNumbers: shouldReview ? [item.number] : [] }];
      return {
        shards,
        scannedPages: 0,
        candidates,
        capacity,
        dueBacklog: candidates.length,
        activeCodexTarget: activeCodexTarget(shards),
        oldestUnreviewedAt: undefined,
        floorBackfill: 0,
        selection: [],
        capacityReason: planCapacityReason({
          selectedCount: candidates.length,
          dueBacklog: candidates.length,
          capacity,
          exact: true,
        }),
      };
    }

    const due: DueCandidate[] = [];
    const now = Date.now();
    const reviewIndex = buildExistingReviewIndex(options.itemsDir);
    if (options.hotIntake) {
      const { items, pagesScanned } = fetchHotIntakeItems(options.maxPages);
      for (const item of items) {
        if (!shouldPlanItem(item)) continue;
        const candidate = dueCandidate(
          item,
          options.itemsDir,
          now,
          options.reviewPolicy,
          reviewIndex,
          options.coverageTrackedItemIds,
        );
        if (
          candidate &&
          !shouldSkipScheduledHotIntakeExactReview(
            item,
            candidate.review,
            now,
            options.reviewPolicy,
          )
        ) {
          due.push(candidate);
        }
      }
      const selected = selectDueCandidates(due, capacity, compareHotIntakeDueCandidates, now);
      const candidates = selected.map(({ item }) => item);
      const shards = Array.from(
        { length: Math.max(1, Math.min(shardCount, candidates.length || 1)) },
        (_, shard) => ({ shard, itemNumbers: [] as number[] }),
      );
      candidates.forEach((item, index) => {
        shards[index % shards.length]?.itemNumbers.push(item.number);
      });
      return {
        shards,
        scannedPages: pagesScanned,
        candidates,
        capacity,
        dueBacklog: due.length,
        activeCodexTarget: activeCodexTarget(shards),
        oldestUnreviewedAt: oldestUnreviewedAt(due),
        floorBackfill: 0,
        selection: planSelectionTelemetry(selected, now),
        capacityReason: planCapacityReason({
          selectedCount: candidates.length,
          dueBacklog: due.length,
          capacity,
        }),
      };
    }
    let scannedPages = 0;
    const backfill: DueCandidate[] = [];
    for (let page = 1; page <= options.maxPages; page += 1) {
      const items = fetchOpenItemPage(page);
      scannedPages = page;
      if (items.length === 0) break;
      for (const item of items) {
        if (!shouldPlanItem(item)) continue;
        const candidate = dueCandidate(
          item,
          options.itemsDir,
          now,
          options.reviewPolicy,
          reviewIndex,
          options.coverageTrackedItemIds,
        );
        if (candidate) {
          due.push(candidate);
          continue;
        }
        if (activeFloor <= 0) continue;
        const fallback = reviewBackfillCandidate(
          item,
          options.itemsDir,
          now,
          options.reviewPolicy,
          minimumBackfillReviewAgeMs,
          reviewIndex,
        );
        if (fallback) backfill.push(fallback);
      }
    }
    const selected = appendFloorBackfillCandidates(
      selectDueCandidates(due, capacity, compareDueCandidates, now),
      backfill,
      {
        activeFloor,
        capacity,
      },
    );
    const floorBackfill = selected.filter((candidate) => !due.includes(candidate)).length;
    const candidates = selected.map(({ item }) => item);
    const shards = shardItemNumbers(
      candidates.map((item) => item.number),
      shardCount,
    );

    return {
      shards,
      scannedPages,
      candidates,
      capacity,
      dueBacklog: due.length,
      activeCodexTarget: activeCodexTarget(shards),
      oldestUnreviewedAt: oldestUnreviewedAt(due),
      floorBackfill,
      selection: planSelectionTelemetry(selected, now),
      capacityReason: planCapacityReason({
        selectedCount: candidates.length,
        dueBacklog: due.length,
        capacity,
        activeFloor,
        floorBackfill,
      }),
    };
  }

  return {
    selectCandidates,
    exactLocalReviewNoCandidateError,
    openExplicitItems,
    planShardCount,
    shardItemNumbers,
    activeCodexTarget,
    oldestUnreviewedAt,
    planCapacityReason,
    planSelectionTelemetry,
    planCandidates,
  };
}
