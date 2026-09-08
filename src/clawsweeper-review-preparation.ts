import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { boolArg, itemNumbersArg, numberArg, stringArg } from "./clawsweeper-args.js";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW_CODEX_TIMEOUT_MS,
  DEFAULT_SERVICE_TIER,
} from "./clawsweeper-policy.js";
import type { GitInfo } from "./clawsweeper-types.js";
import { UserFacingCommandError } from "./command.js";
import {
  isolateGitHubConfigDir,
  localReviewAdditionalPrompt,
  scrubGitHubCredentialEnv,
} from "./commit-sweeper.js";
import type { Args } from "./clawsweeper-args.js";
import type { CreateReviewCommandWorkflowDependencies } from "./clawsweeper-review-command-dependencies.js";
import { parsePrCommentActivityRevisionMap } from "./pr-hydration-snapshot.js";
import { writeExactReviewFailureDiagnostics } from "./clawsweeper-review-failure-diagnostics.js";
import { ReviewSourcePreparationError } from "./review-source-preparation.js";

const AUTOMATIC_REVIEW_SOURCE_ACTIONS = new Set([
  "scheduled_hot_intake",
  "scheduled_normal_backfill",
]);

export function isExplicitReviewDispatch(args: Args, hasExplicitItemSelection: boolean): boolean {
  const sourceAction = stringArg(args.review_source_action, "").trim();
  const plannedAutomaticReview =
    boolArg(args.planned_automatic_review) || AUTOMATIC_REVIEW_SOURCE_ACTIONS.has(sourceAction);
  return !plannedAutomaticReview && hasExplicitItemSelection;
}

export function prepareReviewCommand(
  args: Args,
  dependencies: CreateReviewCommandWorkflowDependencies,
) {
  const {
    buildLocalRangeReview,
    DEFAULT_PLAN_BATCH_SIZE,
    defaultItemsDir,
    defaultLocalRangeArtifactDir,
    defaultLocalRangeHistoryPath,
    defaultReviewArtifactDir,
    ensureDir,
    gitInfo,
    localExactReviewItem,
    repoFromArgs,
    resolveReviewCheckout,
    reviewCodexForcedLoginMethod,
    reviewPolicyHash,
    suppliedReviewStartLeaseFromArgs,
    targetRepo,
  } = dependencies;

  const profile = repoFromArgs(args);
  const localRange = boolArg(args.local_range);
  const localOnly = boolArg(args.local_only) || localRange;
  const verbose = boolArg(args.verbose);
  const itemNumber = numberArg(args.item_number, 0) || undefined;
  const hasItemNumbersInput = typeof args.item_numbers === "string" && args.item_numbers.trim();
  const itemNumbers = hasItemNumbersInput
    ? itemNumbersArg(args.item_numbers, undefined)
    : undefined;
  const prCommentActivityRevisions = parsePrCommentActivityRevisionMap(
    stringArg(args.pr_comment_activity_revisions, ""),
  );
  if (localRange && (itemNumber !== undefined || itemNumbers !== undefined)) {
    throw new UserFacingCommandError(
      "--item-number / --item-numbers cannot be combined with --local-range (local-range reviews " +
        "the local git range and never fetches a GitHub item).",
    );
  }
  const localExactItem = localExactReviewItem(localOnly, itemNumber, itemNumbers);
  const humanLocalReview = localExactItem && !verbose;
  const defaultArtifactDir = defaultReviewArtifactDir(localOnly, itemNumber, itemNumbers);
  const requestedArtifactDir = stringArg(args.artifact_dir, "");
  const checkoutArtifactDir = resolve(requestedArtifactDir || defaultArtifactDir);
  if (humanLocalReview) {
    console.error(`Local ClawSweeper review for ${targetRepo()}#${itemNumber}`);
    console.error("");
    console.error("Preparing target checkout");
  }
  const checkout = resolveReviewCheckout({
    args,
    artifactDir: checkoutArtifactDir,
    humanLocalReview,
    itemNumber,
    itemNumbers,
    localRange,
    localOnly,
    profile,
    verbose,
  });
  const openclawDir = checkout.openclawDir;
  const artifactDir = requestedArtifactDir
    ? resolve(requestedArtifactDir)
    : localRange
      ? defaultLocalRangeArtifactDir(openclawDir)
      : checkoutArtifactDir;
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const batchSize = numberArg(args.batch_size, DEFAULT_PLAN_BATCH_SIZE);
  const maxPages = numberArg(args.max_pages, 250);
  const model = stringArg(args.codex_model, DEFAULT_CODEX_MODEL);
  const reasoningEffort = stringArg(args.codex_reasoning_effort, DEFAULT_REASONING_EFFORT);
  const sandboxMode = stringArg(args.codex_sandbox, "read-only");
  const serviceTier = stringArg(args.codex_service_tier, localOnly ? "fast" : DEFAULT_SERVICE_TIER);
  const timeoutMs = numberArg(args.codex_timeout_ms, DEFAULT_REVIEW_CODEX_TIMEOUT_MS);
  const expectedSourceRevision = stringArg(args.expected_source_revision, "").trim();
  if (expectedSourceRevision && !/^[0-9a-f]{64}$/.test(expectedSourceRevision)) {
    throw new UserFacingCommandError(
      "--expected-source-revision must be a lowercase SHA-256 digest.",
    );
  }
  let additionalPrompt = stringArg(
    args.additional_prompt,
    process.env.CLAWSWEEPER_ADDITIONAL_PROMPT ?? "",
  );
  const additionalPolicyFile = stringArg(args.additional_policy, "");
  if (additionalPolicyFile) {
    const policy = readFileSync(additionalPolicyFile, "utf8");
    additionalPrompt = additionalPrompt
      ? `${additionalPrompt}\n\n## Additional review policy (layered on the repo's own policy)\n${policy}`
      : policy;
  }
  const allowClosed = boolArg(args.allow_closed);
  const bodyFile = stringArg(args.body_file, "");
  if (bodyFile) {
    const providedBody = readFileSync(bodyFile, "utf8");
    additionalPrompt = `${additionalPrompt}\n\n## AUTHORITATIVE PR BODY (review THIS exact body)\nTreat the text below as the pull request's current body/description and review it as such — assess its real-behavior proof, telegram-visible-proof, and mantis recommendation against it. Do NOT fetch, prefer, or assume any other version of the body from the GitHub API. The diff, code, and comments are still the live PR.\n\n----- BEGIN PROVIDED PR BODY -----\n${providedBody}\n----- END PROVIDED PR BODY -----`;
  }
  const localRangeData = localRange
    ? buildLocalRangeReview(openclawDir, targetRepo(), stringArg(args.base, ""))
    : undefined;
  ensureDir(artifactDir);
  const localReviewHistoryPath = localRangeData
    ? defaultLocalRangeHistoryPath(openclawDir, targetRepo(), localRangeData.baseSha)
    : null;
  if (localReviewHistoryPath) ensureDir(dirname(localReviewHistoryPath));
  const coordinationHeldPath = join(artifactDir, "coordination-held.json");
  if (existsSync(coordinationHeldPath)) unlinkSync(coordinationHeldPath);
  if (localRangeData) {
    // Reuse #298's FULL offline envelope (not just token-scrub): withhold every GitHub
    // credential AND point gh at an empty config dir — token deletion alone can't stop
    // gh's own cached auth — and prepend the no-network local-review prompt.
    scrubGitHubCredentialEnv();
    isolateGitHubConfigDir(artifactDir);
    additionalPrompt = [
      localReviewAdditionalPrompt(
        localRangeData.baseSha,
        localRangeData.headSha,
        stringArg(args.base, "") || "origin/main",
      ),
      additionalPrompt,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const shardIndex = numberArg(args.shard_index, 0);
  const shardCount = numberArg(args.shard_count, 1);
  const hotIntake = boolArg(args.hot_intake);
  const readonlyOpenclaw = boolArg(args.readonly_openclaw);
  const skipStartComment = boolArg(args.skip_start_comment) || localOnly || localRange;
  const suppliedReviewLease = suppliedReviewStartLeaseFromArgs(args);
  if (suppliedReviewLease && !skipStartComment) {
    throw new UserFacingCommandError(
      "A supplied review lease requires --skip-start-comment to prevent a second lease from being created.",
    );
  }
  if (suppliedReviewLease && localOnly) {
    throw new UserFacingCommandError(
      "A supplied review lease cannot be used with local-only review.",
    );
  }
  const forcedLoginMethod = reviewCodexForcedLoginMethod(args);
  const exactItemNumber = itemNumbers
    ? itemNumber === undefined && itemNumbers.length === 1
      ? itemNumbers[0]
      : undefined
    : itemNumber;
  const itemKind = process.env.EXACT_REVIEW_ITEM_KIND;
  // No hydrated item exists yet. Only the matching workflow claim can identify this failure.
  const exactReviewIdentity =
    !localOnly &&
    exactItemNumber !== undefined &&
    (itemKind === "issue" || itemKind === "pull_request") &&
    process.env.EXACT_REVIEW_ITEM_KEY?.toLowerCase() ===
      `${targetRepo()}#${exactItemNumber}`.toLowerCase()
      ? ({ repo: targetRepo(), itemKind, itemNumber: exactItemNumber } as const)
      : null;
  const loadReviewGitInfo = (): GitInfo =>
    gitInfo(openclawDir, {
      ...(checkout.gitTargetBranch ? { targetBranch: checkout.gitTargetBranch } : {}),
      ...(exactReviewIdentity ? { classifyFetchFailure: true } : {}),
    });
  let git: GitInfo;
  try {
    git = localRangeData
      ? { mainSha: localRangeData.baseSha, releaseStateComplete: true, latestRelease: null }
      : loadReviewGitInfo();
  } catch (error) {
    if (error instanceof ReviewSourcePreparationError && exactReviewIdentity) {
      try {
        writeExactReviewFailureDiagnostics({
          artifactDir,
          error,
          prompt: additionalPrompt,
          model,
          classification: "source_preparation",
          ...exactReviewIdentity,
          sourceSha:
            exactReviewIdentity.itemKind === "pull_request"
              ? process.env.EXACT_REVIEW_SOURCE_HEAD_SHA
              : null,
          retryable: dependencies.codexReviewFailureRetryable(error),
          workflowExit: 1,
        });
      } catch {
        console.error("[review] exact-review failure diagnostics could not be written.");
      }
    }
    throw error;
  }
  const reviewPolicy = reviewPolicyHash({ model, reasoningEffort, sandboxMode, serviceTier });
  const explicitDispatch = isExplicitReviewDispatch(
    args,
    itemNumber !== undefined || itemNumbers !== undefined,
  );
  const maintainerRequest = additionalPrompt.trim().length > 0;

  return {
    localRange,
    localOnly,
    itemNumber,
    itemNumbers,
    prCommentActivityRevisions,
    humanLocalReview,
    openclawDir,
    artifactDir,
    itemsDir,
    batchSize,
    maxPages,
    model,
    reasoningEffort,
    sandboxMode,
    serviceTier,
    timeoutMs,
    expectedSourceRevision,
    additionalPrompt,
    allowClosed,
    localRangeData,
    localReviewHistoryPath,
    coordinationHeldPath,
    shardIndex,
    shardCount,
    hotIntake,
    readonlyOpenclaw,
    skipStartComment,
    suppliedReviewLease,
    forcedLoginMethod,
    loadReviewGitInfo,
    git,
    reviewPolicy,
    explicitDispatch,
    maintainerRequest,
  };
}
