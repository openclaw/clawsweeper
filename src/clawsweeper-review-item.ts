import { ReviewSourcePreparationError } from "./review-source-preparation.js";
import { validationRecoveryRequired } from "./validation-recovery.js";
import { CodexReviewError, retryableBatchFailure } from "./review-assessment-failure.js";
import { runMultiModelReview } from "./multi-model-review.js";
import { markdownFor as renderDecisionReport } from "./clawsweeper-report-document.js";
import type { MultiModelReviewRecord } from "./review-record.js";
import { dirname, join } from "node:path";
import type { RepositoryReviewConfig } from "./repository-review-config.js";
import { applyHiddenPayloadSecurityReview } from "./repair/security-signals.js";
import { writeFileSync } from "node:fs";
import { UserFacingCommandError } from "./command.js";
import { reviewStatusForDecision } from "./clawsweeper-report-document.js";
import { AgentInputScanError } from "./agent-input-scan.js";
import { reviewNetworkCapability } from "./agent-runner.js";
import { mediaProofRuntimeHints } from "./clawsweeper-media-proof.js";
import { PUBLIC_CODEX_MODEL } from "./codex-env.js";
import { LOCAL_REVIEW_WEB_SEARCH_CONFIG } from "./commit-sweeper.js";
import { pullRequestHistoryCoverage } from "./pr-review-history.js";
import { pullRequestProvenanceEvidence, type CommitPullResolver } from "./pr-review-provenance.js";
import {
  produceReviewOutput,
  reviewAssessmentOutputDir,
  type configureReviewOutputItems,
} from "./review-output-policy.js";
import type { CreateReviewCommandWorkflowDependencies } from "./clawsweeper-review-command-dependencies.js";
import type { CodexFailureLogKind } from "./clawsweeper-review-core.js";
import type {
  Decision,
  GitInfo,
  Item,
  ItemContext,
  PreparedMediaProof,
} from "./clawsweeper-types.js";

export type PreparedReviewDependencies = Pick<
  CreateReviewCommandWorkflowDependencies,
  | "buildReviewPrompt"
  | "reviewEnvironment"
  | "itemSnapshotHash"
  | "runCodex"
  | "codexReviewFailure"
  | "codexReviewFailureRetryable"
  | "attachFixedPullRequest"
  | "verifyRegressionProvenance"
  | "displayPath"
  | "displayDurationMs"
>;

export function runPreparedReviewItem(
  options: {
    item: Item;
    context: ItemContext;
    git: GitInfo;
    model: string;
    sandboxMode: string;
    localOnly: boolean;
    localRange: boolean;
    reviewOpenclawDir: string;
    reviewTreesDir: string;
    additionalPrompt: string;
    proofScratchDir: string;
    preparedMediaProof: PreparedMediaProof;
    resolveProvenancePull: CommitPullResolver;
    shardIndex: number;
    shardCount: number;
    timeoutMs: number;
    humanLocalReview: boolean;
    outputSelection: { retention: "none" | "summary" | "debug" };
    outputBudget: Parameters<typeof produceReviewOutput>[0];
    itemOutputBudget: ReturnType<typeof configureReviewOutputItems>;
    codexWorkDir: string;
    forcedLoginMethod: string;
    itemCodexProfile: { reasoningEffort: string; serviceTier: string };
    existingPriorReview: { markdown: string } | null;
    contextElapsedMs: number;
    onPrompt?: (prompt: string) => void;
    repositoryReview?: RepositoryReviewConfig;
  },
  dependencies: PreparedReviewDependencies,
) {
  const {
    item,
    context,
    git,
    model,
    sandboxMode,
    localOnly,
    localRange,
    reviewOpenclawDir,
    reviewTreesDir,
    additionalPrompt,
    proofScratchDir,
    preparedMediaProof,
    resolveProvenancePull,
    shardIndex,
    shardCount,
    timeoutMs,
    humanLocalReview,
    outputSelection,
    outputBudget,
    itemOutputBudget,
    codexWorkDir,
    forcedLoginMethod,
    itemCodexProfile,
    existingPriorReview,
    contextElapsedMs,
    onPrompt,
  } = options;
  const {
    buildReviewPrompt,
    reviewEnvironment,
    itemSnapshotHash,
    runCodex,
    codexReviewFailure,
    codexReviewFailureRetryable,
    attachFixedPullRequest,
    verifyRegressionProvenance,
    displayPath,
    displayDurationMs,
  } = dependencies;
  const reviewEnv = reviewEnvironment(sandboxMode, localOnly);
  // The review sandbox cannot fetch old blobs: make the changed files'
  // history local first, so host blame and the reviewer both read it.
  const historyCoverage =
    item.kind === "pull_request"
      ? pullRequestHistoryCoverage({ targetDir: reviewOpenclawDir, context, mainSha: git.mainSha })
      : undefined;
  if (historyCoverage) {
    console.error(
      `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} history-prefetch=${historyCoverage.status} #${item.number} paths=${historyCoverage.changedPaths} renames=${historyCoverage.renames.length} blobs=${historyCoverage.blobs} fetched=${historyCoverage.fetched} truncated=${historyCoverage.truncated.length} ms=${historyCoverage.elapsedMs}`,
    );
  }
  // Host-side blame and GitHub reads, recorded as evidence before review.
  const provenanceEvidence =
    item.kind === "pull_request"
      ? pullRequestProvenanceEvidence({
          targetDir: reviewOpenclawDir,
          repo: item.repo,
          context,
          resolvePull: resolveProvenancePull,
        })
      : undefined;
  const prompt = buildReviewPrompt(item, context, git, additionalPrompt, {
    ...mediaProofRuntimeHints(proofScratchDir, preparedMediaProof),
    targetDir: reviewOpenclawDir,
    ...reviewNetworkCapability(sandboxMode, reviewEnv),
    ...(provenanceEvidence ? { provenanceEvidence } : {}),
    ...(historyCoverage ? { historyCoverage } : {}),
  });
  onPrompt?.(prompt.text);
  const snapshotHash = itemSnapshotHash(item, context);
  let decision: Decision;
  let multiModel: MultiModelReviewRecord | undefined;
  const modelCalls =
    item.kind === "pull_request" && options.repositoryReview?.multiModel
      ? options.repositoryReview.multiModel.reviewers.length + 1
      : 1;
  const modelBudget = {
    promptFileBytes: Math.floor(itemOutputBudget.promptFileBytes / modelCalls),
    resultFileBytes: Math.floor(itemOutputBudget.resultFileBytes / modelCalls),
    streamFileBytes: Math.floor(itemOutputBudget.streamFileBytes / modelCalls),
  };
  const postprocess = (value: Decision) =>
    applyHiddenPayloadSecurityReview(
      verifyRegressionProvenance(
        attachFixedPullRequest(value, item, context, existingPriorReview?.markdown),
        item,
        context,
        reviewOpenclawDir,
        git,
      ),
      context.securityReview,
    );
  let codexElapsedMs = 0;
  let codexFailure: { error: unknown; logKind: CodexFailureLogKind } | null = null;
  let codexFailureRetryable = false;
  const codexStartedAt = Date.now();
  try {
    if (humanLocalReview) {
      console.error("");
      console.error(modelCalls > 1 ? "Running multi-model review" : "Running Codex review");
      console.error(`  timeout: ${displayDurationMs(timeoutMs)}`);
      if (outputSelection.retention === "none") {
        console.error("  retained output: none");
      } else if (modelCalls > 1) {
        console.error(
          `  assessments: ${displayPath(reviewAssessmentOutputDir(codexWorkDir, item.number))}`,
        );
      } else {
        console.error(
          `  stdout: ${displayPath(join(codexWorkDir, `${item.number}.1.codex.stdout.log`))}`,
        );
        console.error(
          `  stderr: ${displayPath(join(codexWorkDir, `${item.number}.1.codex.stderr.log`))}`,
        );
      }
    }
    decision = produceReviewOutput(
      outputBudget,
      {
        paths:
          modelCalls > 1
            ? [reviewAssessmentOutputDir(codexWorkDir, item.number)]
            : ["prompt.md", "json", "1.codex.stdout.log", "1.codex.stderr.log"].map((suffix) =>
                join(codexWorkDir, `${item.number}.${suffix}`),
              ),
        maxBytes:
          itemOutputBudget.promptFileBytes +
          itemOutputBudget.resultFileBytes +
          itemOutputBudget.streamFileBytes * 2,
        maxFiles: 4 * modelCalls,
      },
      () => {
        const assessment = {
          item,
          context,
          git,
          model,
          openclawDir: reviewOpenclawDir,
          reviewTreeRoot: reviewTreesDir,
          reasoningEffort: itemCodexProfile.reasoningEffort,
          sandboxMode,
          serviceTier: itemCodexProfile.serviceTier,
          forcedLoginMethod,
          preserveCodexAuth: localOnly,
          timeoutMs,
          workDir: codexWorkDir,
          additionalPrompt,
          proofScratchDir,
          ...(modelCalls > 1 && preparedMediaProof.manifestPath
            ? { preparedMediaDir: dirname(preparedMediaProof.manifestPath) }
            : {}),
          prompt: prompt.text,
          reviewEnv,
          ...modelBudget,
          quietLogs: humanLocalReview,
          ...(options.repositoryReview ? { repositoryReview: options.repositoryReview } : {}),
          ...(localRange ? { extraCodexConfig: [LOCAL_REVIEW_WEB_SEARCH_CONFIG] } : {}),
        };
        if (modelCalls === 1) return runCodex(assessment);
        const result = runMultiModelReview({
          assessment,
          snapshotHash,
          environmentForSelection: (selection) =>
            reviewEnvironment(sandboxMode, localOnly, selection.runner),
          postprocess,
          report: (value) =>
            renderDecisionReport({
              item,
              context,
              decision: value,
              git,
              action: { actionTaken: "kept_open", closeComment: "" },
              reviewMode: "propose",
              snapshotHash,
              contentDigest: snapshotHash,
              reviewPolicy: "multi-model-safety",
              runtime: {
                model: PUBLIC_CODEX_MODEL,
                reasoningEffort: itemCodexProfile.reasoningEffort,
              },
            }),
        });
        multiModel = result.multiModel;
        if (!result.decision)
          throw new CodexReviewError({
            message:
              "Multi-model review incomplete; independent assessments are advisory, not consensus.",
            status: null,
            ...(result.sourcePreparationFailure ? { cause: result.sourcePreparationFailure } : {}),
            failureDisposition: result.failureDisposition ?? {
              retryable: false,
              terminal: false,
              logKind: "codex_execution",
            },
          });
        return result.decision;
      },
    );
  } catch (error) {
    if (
      error instanceof AgentInputScanError ||
      validationRecoveryRequired(error) ||
      (modelCalls > 1 && error instanceof ReviewSourcePreparationError)
    )
      throw error;
    codexFailureRetryable =
      modelCalls > 1 ? retryableBatchFailure(error) : codexReviewFailureRetryable(error);
    const failure = codexReviewFailure(error);
    decision = failure.decision;
    codexFailure = { error, logKind: failure.logKind };
  } finally {
    codexElapsedMs = Date.now() - codexStartedAt;
  }
  if (!multiModel || multiModel.status !== "complete") decision = postprocess(decision);
  const runtime = {
    model: multiModel ? "multi-model" : PUBLIC_CODEX_MODEL,
    reasoningEffort:
      multiModel?.coordinator.selection.reasoningEffort ?? itemCodexProfile.reasoningEffort,
    sandboxMode,
    serviceTier: itemCodexProfile.serviceTier,
    ...prompt.telemetry,
    contextElapsedMs,
    codexElapsedMs,
  };

  return {
    decision,
    runtime,
    codexFailure,
    codexFailureRetryable,
    snapshotHash,
    ...(multiModel ? { multiModel } : {}),
  };
}

export function writePreparedReviewReport(
  options: {
    item: Item;
    context: ItemContext;
    decision: Decision;
    multiModel?: MultiModelReviewRecord;
    git: GitInfo;
    runtime: ReturnType<typeof runPreparedReviewItem>["runtime"];
    artifactDir: string;
    snapshotHash: string;
    contentDigest: string;
    reviewPolicy: string;
    structuralRecord: Exclude<
      Parameters<CreateReviewCommandWorkflowDependencies["markdownFor"]>[0]["structuralRecord"],
      undefined
    >;
    acquiredReviewLease?: { owner: string; commentId: number } | null;
    itemLocalReviewHistoryPath: string | null;
    previousLocalReviewCommentBody: string;
    localRange: boolean;
    metadataBytes: number;
    writeOutputReport: (item: Item, path: string, markdown: string) => void;
    writeOutputMetadata: (path: string, markdown: string) => void;
    transformReport?: (markdown: string) => string;
    onReport?: () => void;
  },
  dependencies: Pick<
    CreateReviewCommandWorkflowDependencies,
    "reviewActionForDecision" | "reportFileName" | "markdownFor" | "renderReviewCommentFromReport"
  >,
) {
  const {
    item,
    context,
    decision,
    git,
    runtime,
    artifactDir,
    snapshotHash,
    contentDigest,
    reviewPolicy,
    structuralRecord,
    acquiredReviewLease,
    itemLocalReviewHistoryPath,
    previousLocalReviewCommentBody,
    localRange,
    metadataBytes,
    writeOutputReport,
    writeOutputMetadata,
    transformReport,
    onReport,
  } = options;
  const { reviewActionForDecision, reportFileName, markdownFor, renderReviewCommentFromReport } =
    dependencies;
  const action = reviewActionForDecision({ item, decision, git, runtime });
  const reportPath = join(artifactDir, reportFileName(item.repo, item.number));
  const markdown = markdownFor({
    item,
    context,
    decision,
    git,
    action,
    reviewMode: "propose",
    snapshotHash,
    contentDigest,
    reviewPolicy,
    runtime,
    structuralRecord,
    ...(options.multiModel ? { multiModel: options.multiModel } : {}),
    ...(acquiredReviewLease
      ? {
          reviewLeaseOwner: acquiredReviewLease.owner,
          reviewLeaseCommentId: acquiredReviewLease.commentId,
        }
      : {}),
  });
  const reportMarkdown = transformReport ? transformReport(markdown) : markdown;
  writeOutputReport(item, reportPath, reportMarkdown);
  onReport?.();
  if (itemLocalReviewHistoryPath) {
    const nextLocalReviewCommentBody =
      reviewStatusForDecision(decision) === "complete"
        ? renderReviewCommentFromReport(
            reportMarkdown,
            "none",
            previousLocalReviewCommentBody
              ? { previousReviewCommentBody: previousLocalReviewCommentBody }
              : undefined,
          )
        : previousLocalReviewCommentBody;
    if (nextLocalReviewCommentBody) {
      if (localRange) {
        // Cross-run history belongs to the checkout, not this output run.
        if (Buffer.byteLength(nextLocalReviewCommentBody) > metadataBytes) {
          throw new UserFacingCommandError("Local review history exceeded its byte limit.");
        }
        writeFileSync(itemLocalReviewHistoryPath, nextLocalReviewCommentBody, "utf8");
      } else {
        writeOutputMetadata(itemLocalReviewHistoryPath, nextLocalReviewCommentBody);
      }
    }
  }
  return { action, reportPath, reportMarkdown };
}
