import { resolve } from "node:path";
import { boolArg, itemNumbersArg, numberArg, stringArg, type Args } from "./clawsweeper-args.js";
import {
  DEFAULT_BACKFILL_REVIEW_AGE_MINUTES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SERVICE_TIER,
} from "./clawsweeper-policy.js";
import type { createReviewPlanning } from "./clawsweeper-review-planning.js";
import type { RepositoryProfile } from "./repository-profiles.js";
import { coverageTrackedItemIdsFromManifest } from "./review-coverage-manifest.js";

type PlanCandidates = ReturnType<typeof createReviewPlanning>["planCandidates"];
type FetchPlannedPrActivityRevisions = ReturnType<
  typeof createReviewPlanning
>["fetchPlannedPrActivityRevisions"];

type PlanCommandDependencies = {
  defaultBatchSize: number;
  defaultItemsDir: () => string;
  defaultShardCount: number;
  fetchPlannedPrActivityRevisions: FetchPlannedPrActivityRevisions;
  planCandidates: PlanCandidates;
  repoFromArgs: (args: Args) => RepositoryProfile;
  reviewPolicyHash: (options: {
    model?: string;
    reasoningEffort?: string;
    sandboxMode?: string;
    serviceTier?: string;
  }) => string;
  targetProfile: () => RepositoryProfile;
};

export function createPlanCommand(dependencies: PlanCommandDependencies): (args: Args) => void {
  return (args) => {
    dependencies.repoFromArgs(args);
    const itemsDir = resolve(stringArg(args.items_dir, dependencies.defaultItemsDir()));
    const batchSize = numberArg(args.batch_size, dependencies.defaultBatchSize);
    const maxPages = numberArg(args.max_pages, 250);
    const shardCount = numberArg(args.shard_count, dependencies.defaultShardCount);
    const minimumActiveShards = numberArg(args.min_active_shards, 0);
    const minimumBackfillReviewAgeMs =
      numberArg(args.min_backfill_review_age_minutes, DEFAULT_BACKFILL_REVIEW_AGE_MINUTES) *
      60 *
      1000;
    const itemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
    const hasItemNumbersInput = typeof args.item_numbers === "string" && args.item_numbers.trim();
    const hotIntake = boolArg(args.hot_intake);
    const model = stringArg(args.codex_model, DEFAULT_CODEX_MODEL);
    const reasoningEffort = stringArg(args.codex_reasoning_effort, DEFAULT_REASONING_EFFORT);
    const sandboxMode = stringArg(args.codex_sandbox, "read-only");
    const serviceTier = stringArg(args.codex_service_tier, DEFAULT_SERVICE_TIER);
    const reviewPolicy = dependencies.reviewPolicyHash({
      model,
      reasoningEffort,
      sandboxMode,
      serviceTier,
    });
    const coverageManifest = stringArg(args.coverage_tracked_items_manifest, "").trim();
    const coverageTrackedItemIds = coverageManifest
      ? coverageTrackedItemIdsFromManifest(
          resolve(coverageManifest),
          dependencies.targetProfile().slug,
        )
      : undefined;
    const planOptions: Parameters<PlanCandidates>[0] = {
      batchSize,
      maxPages,
      shardCount,
      itemsDir,
      reviewPolicy,
      minimumActiveShards,
      minimumBackfillReviewAgeMs,
      ...(coverageTrackedItemIds ? { coverageTrackedItemIds } : {}),
    };
    if (hasItemNumbersInput || itemNumbers.length > 0) planOptions.itemNumbers = itemNumbers;
    if (hotIntake) planOptions.hotIntake = true;
    const plan = dependencies.planCandidates(planOptions);
    const prCommentActivity = dependencies.fetchPlannedPrActivityRevisions(plan.candidates);
    console.log(
      JSON.stringify(
        {
          ...plan,
          prCommentActivity,
          reviewPolicy,
          matrix: plan.shards.map((shard) => ({
            shard: shard.shard,
            item_numbers: shard.itemNumbers.join(",") || "none",
            pr_comment_activity_revisions: JSON.stringify(
              Object.fromEntries(
                shard.itemNumbers
                  .filter((number) => String(number) in prCommentActivity.revisions)
                  .map((number) => [String(number), prCommentActivity.revisions[String(number)]]),
              ),
            ),
          })),
        },
        null,
        2,
      ),
    );
  };
}
