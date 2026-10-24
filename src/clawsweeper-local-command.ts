import { ReviewSourcePreparationError } from "./review-source-preparation.js";
import { retryableBatchFailure, batchSecondaryFailure } from "./review-assessment-failure.js";
import {
  NonretryableReviewBatchError,
  nonretryableReviewBatchExitCode,
} from "./exact-review-failure-reason.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { boolArg, stringArg, type Args } from "./clawsweeper-args.js";
import { AgentInputScanError, agentInputScanFailureExitCode } from "./agent-input-scan.js";
import { codexItemProfile } from "./codex-item-profile.js";
import { UserFacingCommandError } from "./command.js";
import {
  prepareReviewCommand,
  type PrepareReviewDependencies,
} from "./clawsweeper-review-preparation.js";
import {
  loadLocalRepositoryReviewConfig,
  repositoryReviewContentDigest,
  type RepositoryReviewConfig,
} from "./repository-review-config.js";
import {
  runPreparedReviewItem,
  writePreparedReviewReport,
  type PreparedReviewDependencies,
} from "./clawsweeper-review-item.js";
import type { CreateReviewCommandWorkflowDependencies } from "./clawsweeper-review-command-dependencies.js";
import type { Decision, FileModeSnapshot } from "./clawsweeper-types.js";
import type { CommitPullResolver } from "./pr-review-provenance.js";
import { localRangeReviewPreflight } from "./review-preflight.js";
import {
  assertReviewOutputFilePeak,
  configureReviewOutputItems,
  createReviewOutputWriter,
  finalizeReviewCommandOutput,
  emitReviewOutput,
  pruneReviewOutputItem,
  writeReviewOutput,
} from "./review-output-policy.js";

export type LocalRangeCommandDependencies = PrepareReviewDependencies &
  PreparedReviewDependencies &
  Pick<
    CreateReviewCommandWorkflowDependencies,
    | "makeTreeReadOnly"
    | "restoreTreeModes"
    | "extractClawSweeperReviewCommentBody"
    | "localRangeHistoryApplies"
    | "itemContentDigest"
    | "reviewActionForDecision"
    | "reportFileName"
    | "markdownFor"
    | "renderReviewCommentFromReport"
    | "updateBulkFilerDetectedFrontMatter"
  > & { resolveProvenancePull: CommitPullResolver };

// Local preparation and output belong here; both CLI routes use the same full
// prepared-item executor as hosted review, without admission or publication adapters.
export function runLocalRangeReview(args: Args, dependencies: LocalRangeCommandDependencies): void {
  if (!boolArg(args.local_range))
    throw new UserFacingCommandError("Local review requires --local-range.");
  const preparation = prepareReviewCommand(args, dependencies);
  const {
    localRangeData,
    openclawDir,
    artifactDir,
    reviewWorkspaceDir,
    model,
    sandboxMode,
    timeoutMs,
    additionalPrompt,
    readonlyOpenclaw,
    forcedLoginMethod,
    git,
    reviewPolicy,
    shardIndex,
    shardCount,
    outputSelection,
    outputBudget,
    retainedReviewOutput,
    localReviewHistoryPath,
    cleanupReviewOutput,
  } = preparation;
  if (!localRangeData) throw new UserFacingCommandError("Local review requires --local-range.");
  const { item, context } = localRangeData;
  let repositoryReview: RepositoryReviewConfig | undefined;
  const {
    results: localOutputResults,
    writeReport,
    assertBudget: assertCurrentOutputBudget,
  } = createReviewOutputWriter({ ...preparation, localOnly: true });
  let preflightDecision: Decision | undefined;
  let outputEmitted = false;
  let commandError: unknown;
  let commandFailed = false;
  let finalizationError: unknown;
  let completed = false;
  let batchAssessmentsFinished = false;
  let transientBatchFailure: Error | undefined;
  const readonlyModeSnapshots: FileModeSnapshot[] = [];
  const emitLocalOutput = (status: "completed" | "failed") => {
    if (outputEmitted || (status === "failed" && localOutputResults.length === 0)) return;
    const preflight = boolArg(args.preflight)
      ? localRangeReviewPreflight({
          targetDir: openclawDir,
          baseRef: stringArg(args.base, "") || "origin/main",
          repo: item.repo,
          base: localRangeData.baseSha,
          head: localRangeData.headSha,
          decision: preflightDecision,
        })
      : undefined;
    emitReviewOutput(outputSelection, status, localOutputResults, preflight);
    if (preflight?.block === null) process.exitCode = 1;
    outputEmitted = true;
  };
  try {
    repositoryReview = loadLocalRepositoryReviewConfig(
      openclawDir,
      stringArg(args.base, "") || "origin/main",
    );
    const reviewTreesDir = join(realpathSync(reviewWorkspaceDir), "review-trees");
    if (readonlyOpenclaw) dependencies.makeTreeReadOnly(openclawDir, readonlyModeSnapshots);
    assertCurrentOutputBudget();
    const itemOutputBudget = configureReviewOutputItems(outputBudget, 1);
    assertReviewOutputFilePeak(outputSelection.retention, 1);
    const writeOutputMetadata = (path: string, content: string) =>
      writeReviewOutput(outputBudget, path, content);
    console.error(
      `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} selected=1 scanned_pages=0`,
    );
    writeOutputMetadata(
      join(artifactDir, "selection.json"),
      JSON.stringify(
        {
          shardIndex,
          shardCount,
          scannedPages: 0,
          candidates: [item],
          reviewPolicy,
        },
        null,
        2,
      ),
    );
    console.error(
      `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start #${item.number} (1/1)`,
    );
    const contextStartedAt = Date.now();
    const itemLocalReviewHistoryPath =
      outputSelection.retention === "debug" ? localReviewHistoryPath : null;
    let previousLocalReviewCommentBody =
      itemLocalReviewHistoryPath && existsSync(itemLocalReviewHistoryPath)
        ? readFileSync(itemLocalReviewHistoryPath, "utf8")
        : "";
    if (previousLocalReviewCommentBody) {
      const previous = dependencies.extractClawSweeperReviewCommentBody(
        previousLocalReviewCommentBody,
      );
      if (
        previous.completedReviewCycles > 0 &&
        /^[0-9a-f]{40}$/iu.test(previous.reviewedSha ?? "") &&
        dependencies.localRangeHistoryApplies(
          openclawDir,
          previous.reviewedSha ?? null,
          localRangeData.headSha,
        )
      ) {
        context.previousClawSweeperReview = previous;
      } else previousLocalReviewCommentBody = "";
    }
    const codexWorkDir = join(artifactDir, "codex");
    const proofScratchDir = join(codexWorkDir, "proof-scratch", String(item.number));
    // Keep the native synthetic item's timestamp and identity before hashing.
    const contextUpdatedAt = (context.issue as { updatedAt?: string }).updatedAt;
    if (contextUpdatedAt) item.updatedAt = contextUpdatedAt;
    const contentDigest = repositoryReviewContentDigest(
      dependencies.itemContentDigest(item, context, git),
      repositoryReview,
    );
    const result = runPreparedReviewItem(
      {
        item,
        context,
        git,
        model,
        sandboxMode,
        localOnly: true,
        localRange: true,
        ...(repositoryReview ? { repositoryReview } : {}),
        reviewOpenclawDir: openclawDir,
        reviewTreesDir,
        additionalPrompt,
        proofScratchDir,
        preparedMediaProof: { manifestPath: null, summaryPath: null, artifacts: [] },
        resolveProvenancePull: dependencies.resolveProvenancePull,
        shardIndex,
        shardCount,
        timeoutMs,
        humanLocalReview: false,
        outputSelection,
        outputBudget,
        itemOutputBudget,
        codexWorkDir,
        forcedLoginMethod,
        itemCodexProfile: codexItemProfile(item.authorAssociation, null),
        existingPriorReview: null,
        contextElapsedMs: Date.now() - contextStartedAt,
      },
      dependencies,
    );
    const { decision, runtime, codexFailure, snapshotHash, multiModel } = result;
    batchAssessmentsFinished = Boolean(repositoryReview?.multiModel);
    const { action, reportPath } = writePreparedReviewReport(
      {
        item,
        context,
        decision,
        ...(multiModel ? { multiModel } : {}),
        git,
        runtime,
        artifactDir,
        snapshotHash,
        contentDigest,
        reviewPolicy,
        structuralRecord: null,
        itemLocalReviewHistoryPath,
        previousLocalReviewCommentBody,
        localRange: true,
        metadataBytes: itemOutputBudget.metadataBytes,
        writeOutputMetadata,
        transformReport: (markdown) =>
          dependencies.updateBulkFilerDetectedFrontMatter(markdown, {
            context: null,
            labelPending: false,
            labelApplied: false,
          }),
        writeOutputReport: (_item, path, markdown) => {
          writeReport(item, path, markdown);
          preflightDecision = decision;
        },
      },
      dependencies,
    );
    console.error(
      `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} done #${item.number} (1/1) decision=${decision.decision} confidence=${decision.confidence} action=${action.actionTaken}`,
    );
    assertCurrentOutputBudget();
    pruneReviewOutputItem({
      artifactDir,
      codexWorkDir,
      proofScratchDir,
      reportPath,
      itemNumber: item.number,
      retention: outputSelection.retention,
    });
    if (codexFailure) {
      console.error(
        `[review] ${new Date().toISOString()} codex-failure classification=${codexFailure.logKind}${outputSelection.retention === "none" ? "" : ` report=${dependencies.displayPath(reportPath)}`}`,
      );
      emitLocalOutput("failed");
      const failure = new Error(
        `Codex failed for 1 item; the workflow recovery lane can requeue evidence-backed retryable items.${outputSelection.retention === "none" ? "" : ` Report: ${dependencies.displayPath(reportPath)}`}`,
        { cause: codexFailure.error },
      );
      if (repositoryReview?.multiModel && result.codexFailureRetryable)
        transientBatchFailure = failure;
      throw failure;
    }
    completed = true;
    assertCurrentOutputBudget();
  } catch (caught) {
    const error =
      repositoryReview?.multiModel &&
      !(caught instanceof AgentInputScanError) &&
      !(caught instanceof ReviewSourcePreparationError) &&
      (batchAssessmentsFinished ? caught !== transientBatchFailure : !retryableBatchFailure(caught))
        ? new NonretryableReviewBatchError(caught)
        : caught;
    commandError = error;
    commandFailed = true;
    try {
      emitLocalOutput("failed");
    } catch (secondary) {
      commandError = repositoryReview?.multiModel
        ? batchSecondaryFailure(error, secondary)
        : secondary;
      console.error("[review] error-path bookkeeping failed; original batch disposition retained.");
    }
  } finally {
    try {
      finalizationError = finalizeReviewCommandOutput({
        restoreTreeModes: () => dependencies.restoreTreeModes(readonlyModeSnapshots),
        outputSelection,
        retainedReviewOutput,
        results: localOutputResults,
        cleanupReviewOutput,
        captureSecondaryFailure: Boolean(repositoryReview?.multiModel),
        commandError,
      });
    } catch (secondary) {
      finalizationError = secondary;
    }
  }
  if (finalizationError !== undefined) {
    if (repositoryReview?.multiModel) {
      commandError = batchSecondaryFailure(
        commandFailed ? commandError : undefined,
        finalizationError,
      );
      commandFailed = true;
    } else if (!commandFailed) throw finalizationError;
  }
  if (commandFailed) {
    if (outputEmitted && outputSelection.resultFormat === "json") {
      console.error(commandError instanceof Error ? commandError.message : String(commandError));
      process.exitCode =
        agentInputScanFailureExitCode(commandError) ??
        nonretryableReviewBatchExitCode(commandError) ??
        1;
      return;
    }
    throw commandError;
  }
  if (completed) {
    try {
      emitLocalOutput("completed");
    } catch (error) {
      throw repositoryReview?.multiModel ? batchSecondaryFailure(undefined, error) : error;
    }
  }
}
