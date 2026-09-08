import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decisionPublicationPolicy,
  reportMatchesPublicationPolicy,
} from "./manual-publication-policy.js";
import { ACTION_EVENT_REASON_CODES, ACTION_EVENT_STATUSES } from "./action-ledger.js";
import { AgentInputScanError, agentInputScanFailureExitCode } from "./agent-input-scan.js";
import { serializeReviewContext } from "./agent-input-scan-fixtures.js";
import { reviewNetworkCapability } from "./agent-runner.js";
import type { Args } from "./clawsweeper-args.js";
import {
  isBulkFilerExemptRepositoryPermission as isVerifiedMaintainerRepositoryPermission,
  isMaintainerAuthorAssociation,
} from "./clawsweeper-item-policy.js";
import { mediaProofRuntimeHints, prepareMediaProofArtifacts } from "./clawsweeper-media-proof.js";
import type {
  AcquiredReviewStartLease,
  BulkFilerCountCache,
  BulkFilerRepositoryPermissionCache,
  Decision,
  Item,
  ItemContext,
  PreparedMediaProof,
  ReviewActionLedger,
} from "./clawsweeper-types.js";
import { PUBLIC_CODEX_MODEL } from "./codex-env.js";
import { UserFacingCommandError } from "./command.js";
import { LOCAL_REVIEW_WEB_SEARCH_CONFIG } from "./commit-sweeper.js";
import { isReviewedPrActivityCursor } from "./review-activity-cursor.js";
import { previousClawSweeperReviewDigest } from "./clawsweeper-review-comments.js";
import { writeExactReviewFailureDiagnostics } from "./clawsweeper-review-failure-diagnostics.js";
import {
  reviewStructuralCacheDecision,
  reviewStructuralCacheProbeDecision,
  reviewStructuralRecordAtLeastAsFresh,
  reviewStructuralRecordMatchesHydratedItem,
  reviewStructuralRecordMatchesHydratedPull,
  reviewStructuralRecordMatchesObservedUpdate,
  reviewStructuralRecordsDescribeSameVerdictInput,
  type ReviewStructuralRecord,
} from "./review-structural-cache.js";
import { reviewContentCacheHit } from "./scheduler-policy.js";
import type { CreateReviewCommandWorkflowDependencies } from "./clawsweeper-review-command-dependencies.js";
import { prepareReviewCommand } from "./clawsweeper-review-preparation.js";
import { parsePrHydrationSnapshot } from "./pr-hydration-snapshot.js";
import { ReviewSourcePreparationError } from "./review-source-preparation.js";
import { commandProofBinding, assertCommandProofSubject } from "./command-proof-assessment.js";
import { COMMAND_PROOF_SOURCE_ACTION } from "./command-proof-contract.js";

/** Bind verified evidence to its candidate before an ordinary full review. */
export function reviewCommandProofBinding(sourceAction: unknown, additionalPrompt: string) {
  const binding = commandProofBinding(additionalPrompt);
  if (sourceAction !== COMMAND_PROOF_SOURCE_ACTION) {
    if (binding) {
      throw new UserFacingCommandError(
        "commanded proof reassessment lost its trusted source action; full review required",
      );
    }
    return null;
  }
  if (!binding) {
    throw new UserFacingCommandError(
      "commanded proof reassessment is missing its exact-subject binding",
    );
  }
  return binding;
}

function reviewStartLeaseCommentUpdatedAt(
  comment: Record<string, unknown> | undefined,
): string | undefined {
  for (const key of ["updated_at", "created_at"]) {
    const value = comment?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function withRunnerPreflightProvenance(
  markdown: string,
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string,
): string {
  let promoted = replaceFrontMatterValue(markdown, "local_checkout_access", "verified");
  promoted = replaceFrontMatterValue(
    promoted,
    "local_checkout_access_source",
    "runner_preflight_v1",
  );
  return promoted;
}

export function localExactBootstrapReviewCommentBody(
  markdown: string,
  item: Pick<Item, "repo" | "number">,
  frontMatterValue: (markdown: string, key: string) => string | undefined,
  renderReviewCommentFromReport: (markdown: string, reason: "none") => string,
): string {
  if (
    frontMatterValue(markdown, "repository")?.toLowerCase() !== item.repo.toLowerCase() ||
    frontMatterValue(markdown, "number") !== String(item.number)
  ) {
    return "";
  }
  return renderReviewCommentFromReport(markdown, "none");
}

export function restoreVerifiedMaintainerPullRequestAuthorAssociation(
  item: Pick<Item, "kind" | "author" | "authorAssociation" | "labels">,
  repositoryPermission: (author: string) => string | null,
): boolean {
  if (
    item.kind !== "pull_request" ||
    !item.author.trim() ||
    isMaintainerAuthorAssociation(item.authorAssociation) ||
    !item.labels.some((label) => label.trim().toLowerCase() === "maintainer")
  ) {
    return false;
  }
  let permission: string | null;
  try {
    permission = repositoryPermission(item.author);
  } catch {
    return false;
  }
  if (!isVerifiedMaintainerRepositoryPermission(permission)) return false;
  item.authorAssociation = "MEMBER";
  return true;
}

export function createReviewCommandWorkflow(dependencies: CreateReviewCommandWorkflowDependencies) {
  const {
    actionLedgerFailureDisposition,
    actionLedgerItemKey,
    asRecord,
    attachFixedPullRequest,
    verifyRegressionProvenance,
    authorIssueCountInBulkFilerWindow,
    buildReviewPrompt,
    reviewEnvironment,
    bulkFilerPolicyInvalidatesCachedReview,
    bulkFilerRepositoryPermission,
    codexFailureDecision,
    codexFailureLogKind,
    CodexReviewError,
    codexReviewFailureRetryable,
    collectItemContext,
    commentId,
    completePullChecksContext,
    deleteOwnedDedicatedReviewStartLease,
    detectBulkFiler,
    displayDurationMs,
    displayPath,
    enforceExpectedIssueSourceRevision,
    ensureDir,
    exactLocalReviewNoCandidateError,
    extractClawSweeperReviewCommentBody,
    existingReview,
    extractLatestClawSweeperReview,
    fetchIssueReviewComments,
    fetchReviewStructuralRecord,
    finishReviewActionLedger,
    finishReviewActionLedgerItem,
    freshDedicatedReviewStartLeases,
    frontMatterValue,
    isBulkFilerExemptAuthorAssociation,
    isBulkFilerExemptRepositoryPermission,
    issueReviewCommentState,
    isSuppliedReviewStartLease,
    itemContentDigest,
    itemSnapshotHash,
    liveClawSweeperReviewDigest,
    localExactReviewHistoryPath,
    localRangeHistoryApplies,
    makeTreeReadOnly,
    materializePullRequestReviewTree,
    markdownFor,
    postReviewStartStatusComment,
    previousClawSweeperReviewDigestFromReport,
    pullHeadShaFromContext,
    pullRequestHeadSha,
    recordReviewLogPublication,
    removePullRequestReviewTree,
    replaceFrontMatterValue,
    renderReviewCommentFromReport,
    reportFileName,
    reportReviewFindings,
    restoreTreeModes,
    reviewActionForDecision,
    reviewLeaseStillMatchesContext,
    reviewMutationRunner,
    reviewStructuralPullStateFromContext,
    runReviewCheckoutInspection,
    runCodex,
    selectCandidates,
    startReviewActionLedger,
    startReviewActionLedgerItem,
    stringOrUndefined,
    updateBulkFilerDetectedFrontMatter,
    updateReviewStructuralFrontMatter,
  } = dependencies;

  function reviewCommand(args: Args): void {
    const publicationPolicy = process.env.EXACT_REVIEW_DECISION
      ? decisionPublicationPolicy(JSON.parse(process.env.EXACT_REVIEW_DECISION))
      : undefined;
    const hostReport = (markdown: string): string =>
      publicationPolicy
        ? replaceFrontMatterValue(markdown, "publication_policy", publicationPolicy)
        : markdown;
    const preparation = prepareReviewCommand(args, dependencies);
    const {
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
      reviewPolicy,
      explicitDispatch,
      maintainerRequest,
      additionalPrompt,
    } = preparation;
    const proofBinding = reviewCommandProofBinding(args.review_source_action, additionalPrompt);
    let { git } = preparation;
    const readonlyModeSnapshots = readonlyOpenclaw ? makeTreeReadOnly(openclawDir) : [];
    const acquiredReviewLeases: Array<{ itemNumber: number; lease: AcquiredReviewStartLease }> = [];
    const releaseOwnedReviewLease = (
      itemNumber: number,
      lease: AcquiredReviewStartLease,
    ): boolean =>
      // The exact-event workflow reserves a supplied lease in its write-token
      // step and owns cleanup outside this read-token review. Every lease this
      // command creates itself must still be deleted, even for a read-only checkout.
      isSuppliedReviewStartLease(suppliedReviewLease, lease) ||
      deleteOwnedDedicatedReviewStartLease(itemNumber, lease);
    const claimSuppliedReviewLease = (
      itemNumber: number,
      currentRevision: string,
    ):
      | { status: "claimed"; lease: AcquiredReviewStartLease }
      | { status: "stale" }
      | { status: "held"; retryAt: string } => {
      if (!suppliedReviewLease) return { status: "stale" };
      const freshLeases = freshDedicatedReviewStartLeases({
        comments: issueReviewCommentState(itemNumber).leaseComments,
        itemNumber,
        headSha: currentRevision,
        nowMs: Date.now(),
      });
      const winner = freshLeases[0];
      const supplied = freshLeases.find(
        (lease) =>
          commentId(lease.comment) === suppliedReviewLease.commentId &&
          lease.owner === suppliedReviewLease.owner,
      );
      if (!supplied || !winner) return { status: "stale" };
      if (
        commentId(winner.comment) !== suppliedReviewLease.commentId ||
        winner.owner !== suppliedReviewLease.owner
      ) {
        return { status: "held", retryAt: winner.expiresAt };
      }
      return {
        status: "claimed",
        lease: {
          owner: suppliedReviewLease.owner,
          commentId: suppliedReviewLease.commentId,
          headSha: currentRevision,
          comment: supplied.comment,
        },
      };
    };
    const structuralCacheCoordinationEnabled = !skipStartComment || suppliedReviewLease !== null;
    let reviewLedger: ReviewActionLedger | null = null;
    let activeReviewItem: Item | null = null;
    let completed = 0;
    let cacheHits = 0;
    try {
      const selectionOptions: Parameters<typeof selectCandidates>[0] = {
        batchSize,
        maxPages,
        shardIndex,
        shardCount,
        itemsDir,
        reviewPolicy,
      };
      if (itemNumber) selectionOptions.itemNumber = itemNumber;
      if (itemNumbers) selectionOptions.itemNumbers = itemNumbers;
      if (allowClosed) selectionOptions.allowClosed = true;
      if (hotIntake) selectionOptions.hotIntake = true;
      if (humanLocalReview) {
        console.error("");
        console.error("Loading review item");
      }
      const { candidates, scannedPages } = localRangeData
        ? { candidates: [localRangeData.item], scannedPages: 0 }
        : selectCandidates(selectionOptions);
      if (suppliedReviewLease && candidates.length !== 1) {
        throw new UserFacingCommandError(
          "A supplied review lease requires exactly one selected item.",
        );
      }
      if (expectedSourceRevision && candidates.length !== 1) {
        throw new UserFacingCommandError(
          `--expected-source-revision requires exactly one selected issue; selected ${candidates.length}.`,
        );
      }
      if (humanLocalReview) {
        if (candidates.length === 0) throw exactLocalReviewNoCandidateError(itemNumber, shardIndex);
        const item = candidates[0]!;
        console.error(`  item: ${item.kind === "pull_request" ? "PR" : "issue"} #${item.number}`);
        console.error(`  title: ${item.title}`);
        console.error("  state: open");
      } else {
        console.error(
          `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} selected=${candidates.length} scanned_pages=${scannedPages}`,
        );
      }
      writeFileSync(
        join(artifactDir, "selection.json"),
        JSON.stringify({ shardIndex, shardCount, scannedPages, candidates, reviewPolicy }, null, 2),
      );
      reviewLedger = startReviewActionLedger({
        candidates,
        reviewPolicy,
        shardIndex,
        shardCount,
        batchSize,
      });
      let coordinationHeldRetryAt: string | null = null;
      let codexFailures = 0;
      let leaseAcquisitionFailures = 0;
      let contentCacheHits = 0;
      let structuralCacheChecks = 0;
      let structuralCacheHits = 0;
      let structuralCacheProbeFailures = 0;
      let structuralCacheProbeMs = 0;
      let structuralCacheRevalidations = 0;
      let structuralCacheRevalidationFailures = 0;
      let structuralCacheRevalidationMs = 0;
      let hydrationRuns = 0;
      const bulkFilerCountCache: BulkFilerCountCache = new Map();
      const bulkFilerRepositoryPermissionCache: BulkFilerRepositoryPermissionCache = new Map();
      const bulkFilerWindowNow = Date.now();
      const structuralCacheReasons = new Map<string, number>();
      const structuralCacheRevalidationReasons = new Map<string, number>();
      const codexFailureReports: string[] = [];
      const leaseAcquisitionFailureDetails: string[] = [];
      const reviewTreeCleanupFailures: string[] = [];
      // oxfmt-ignore
      for (const item of candidates) {
        const itemReadonlyModeSnapshots: ReturnType<typeof makeTreeReadOnly> = [];
        let reviewOpenclawDir = openclawDir;
        let pullRequestReviewTreeDir: string | null = null;
        let pullRequestReviewTreeSha: string | null = null;
        let diagnosticPrompt = "";
        let diagnosticSourceSha = process.env.EXACT_REVIEW_SOURCE_HEAD_SHA;
        const recordFailureDiagnostics = (error: unknown, classification = "codex_execution") => {
          if (!process.env.EXACT_REVIEW_ITEM_KEY) return;
          try {
            writeExactReviewFailureDiagnostics({
              artifactDir,
              error,
              prompt: diagnosticPrompt,
              model,
              classification,
              repo: item.repo,
              itemKind: item.kind,
              itemNumber: item.number,
              sourceSha: error instanceof ReviewSourcePreparationError || error instanceof AgentInputScanError
                ? error.reviewedHeadSha ?? diagnosticSourceSha
                : diagnosticSourceSha,
              retryable: codexReviewFailureRetryable(error),
              workflowExit: agentInputScanFailureExitCode(error) ?? 1,
            });
          } catch {
            console.error("[review] exact-review failure diagnostics could not be written.");
          }
        };
        let cachePreflightState: "not_run" | "passed" | "failed" = "not_run";
        let structuralScanIdentity: { baseSha: string; headSha: string } | null = null;
        const preparePullRequestReviewTree = (headSha: string): boolean => {
          if (item.kind !== "pull_request") return true;
          diagnosticSourceSha = headSha;
          if (pullRequestReviewTreeDir && pullRequestReviewTreeSha === headSha) return true;
          if (pullRequestReviewTreeDir) {
            restoreTreeModes(itemReadonlyModeSnapshots);
            itemReadonlyModeSnapshots.length = 0;
            if (
              !removePullRequestReviewTree({
                targetDir: openclawDir,
                worktreeDir: pullRequestReviewTreeDir,
              })
            ) {
              return false;
            }
          }
          const reviewTreesDir = join(artifactDir, "review-trees");
          ensureDir(reviewTreesDir);
          pullRequestReviewTreeDir = join(reviewTreesDir, String(item.number));
          pullRequestReviewTreeSha = null;
          reviewOpenclawDir = openclawDir;
          if (
            !materializePullRequestReviewTree({
              targetDir: openclawDir,
              worktreeDir: pullRequestReviewTreeDir,
              itemNumber: item.number,
              headSha,
            })
          ) {
            return false;
          }
          reviewOpenclawDir = pullRequestReviewTreeDir;
          pullRequestReviewTreeSha = headSha;
          if (readonlyOpenclaw) {
            makeTreeReadOnly(reviewOpenclawDir, itemReadonlyModeSnapshots);
          }
          return true;
        };
        const cachePreflightPasses = (headSha: string | null, context?: ItemContext): boolean => {
          if (cachePreflightState !== "not_run") return cachePreflightState === "passed";
          if (item.kind === "pull_request" && (!headSha || !preparePullRequestReviewTree(headSha))) {
            cachePreflightState = "failed";
          } else {
            const baseSha = context
              ? asRecord(asRecord(context.pullRequest).base).sha
              : structuralScanIdentity?.headSha === headSha ? structuralScanIdentity.baseSha : "";
            const inspection = runReviewCheckoutInspection({
              // Structural reuse has no model payload. Hydrated reuse scans the
              // current context too, including source comments.
              initialPrompt: serializeReviewContext(context ?? item),
              scanSource: item.kind === "pull_request"
                ? { kind: "committed", baseSha: typeof baseSha === "string" ? baseSha : "", headSha: headSha ?? "" }
                : { kind: "prompt" },
              itemNumber: item.number,
              openclawDir: reviewOpenclawDir,
              preserveCodexAuth: localOnly,
              timeoutMs,
            });
            cachePreflightState =
              !inspection.error && inspection.status === 0 ? "passed" : "failed";
          }
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} cache-checkout-preflight=${cachePreflightState} #${item.number}`,
          );
          return cachePreflightState === "passed";
        };
        const restoredMaintainerAssociation =
          !localOnly &&
          restoreVerifiedMaintainerPullRequestAuthorAssociation(item, (author) =>
            bulkFilerRepositoryPermission(author, bulkFilerRepositoryPermissionCache),
          );
        activeReviewItem = item;
        let reviewItemFailed = false;
        const previousReviewMutationRunner = dependencies.activeReviewMutationRunner;
        try {
        startReviewActionLedgerItem(reviewLedger, item);
        dependencies.activeReviewMutationRunner = reviewMutationRunner(reviewLedger, item);
        const bulkFilerDetection =
          !localOnly && item.kind === "issue"
            ? detectBulkFiler({
                item,
                cache: bulkFilerCountCache,
                now: bulkFilerWindowNow,
                searchCount: ({ author, windowStart }) =>
                  authorIssueCountInBulkFilerWindow(author, windowStart),
                onSearchError: (error) => {
                  console.error(
                    `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} bulk-filer-search=failed #${item.number}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  );
                },
              })
            : { context: null, labelPending: false, labelApplied: false };
        if (humanLocalReview) {
          console.error("");
          console.error("Collecting GitHub context");
        } else {
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start #${item.number} (${completed + 1}/${candidates.length})`,
          );
        }
        const itemLocalReviewHistoryPath = localRangeData
          ? localReviewHistoryPath
          : localOnly
            ? localExactReviewHistoryPath(artifactDir, item.repo, item.number)
            : null;
        let previousLocalReviewCommentBody =
          itemLocalReviewHistoryPath && existsSync(itemLocalReviewHistoryPath)
            ? readFileSync(itemLocalReviewHistoryPath, "utf8")
            : "";
        if (
          !previousLocalReviewCommentBody &&
          localOnly &&
          !localRangeData &&
          existsSync(join(artifactDir, reportFileName(item.repo, item.number)))
        ) {
          const bootstrapReport = readFileSync(
            join(artifactDir, reportFileName(item.repo, item.number)),
            "utf8",
          );
          previousLocalReviewCommentBody = localExactBootstrapReviewCommentBody(
            bootstrapReport,
            item,
            frontMatterValue,
            renderReviewCommentFromReport,
          );
        }
        const existingPriorReview = localRangeData ? null : existingReview(item, itemsDir);
        const lastFullReviewBulkFilerState = frontMatterValue(
          existingPriorReview?.markdown ?? "",
          "last_full_review_bulk_filer_detected",
        );
        const lastFullReviewBulkFilerStateMayNeedRecheck =
          existingPriorReview !== null && !/^false$/i.test(lastFullReviewBulkFilerState ?? "");
        const needsBulkFilerPermissionLookup =
          !localOnly &&
          item.kind === "issue" &&
          !isBulkFilerExemptAuthorAssociation(item.authorAssociation) &&
          (bulkFilerDetection.context?.detected || lastFullReviewBulkFilerStateMayNeedRecheck);
        const bulkFilerExemptionApplied =
          item.kind === "issue" &&
          (isBulkFilerExemptAuthorAssociation(item.authorAssociation) ||
            (needsBulkFilerPermissionLookup &&
              isBulkFilerExemptRepositoryPermission(
                bulkFilerRepositoryPermission(item.author, bulkFilerRepositoryPermissionCache),
              )));
        if (bulkFilerDetection.context?.detected && bulkFilerExemptionApplied) {
          bulkFilerDetection.context = null;
          bulkFilerDetection.labelPending = false;
          bulkFilerDetection.labelApplied = false;
        }
        let priorReview =
          item.kind === "pull_request" &&
          existingPriorReview &&
          !isReviewedPrActivityCursor(
            frontMatterValue(existingPriorReview.markdown, "review_activity_cursor"),
          )
            ? null
            : existingPriorReview;
        if (
          (restoredMaintainerAssociation &&
            priorReview !== null &&
            !isMaintainerAuthorAssociation(
              frontMatterValue(priorReview.markdown, "author_association"),
            )) ||
          bulkFilerPolicyInvalidatesCachedReview(priorReview?.markdown ?? null, bulkFilerExemptionApplied)
        ) {
          // Ownership and bulk-filer policy changes require a fresh decision;
          // carrying stale front matter would preserve the wrong safeguards.
          priorReview = null;
        }
        // Policy changes require fresh review bytes, not restamped cached provenance.
        // Keep the prior report and history available to the normal review path.
        const cacheEligibleReview =
          priorReview && reportMatchesPublicationPolicy(priorReview.markdown, publicationPolicy)
            ? priorReview
            : null;
        const expectedPreviousReviewDigest = priorReview
          ? previousClawSweeperReviewDigestFromReport(priorReview.markdown)
          : null;
        let acquiredReviewLease: AcquiredReviewStartLease | null = null;
        const acquireReviewStartLease = (headSha: () => string): AcquiredReviewStartLease | null => {
          try {
            const startComment = postReviewStartStatusComment({
              item,
              headSha: headSha(),
              reviewTimeoutMs: timeoutMs,
              position: completed + 1,
              total: candidates.length,
              shardIndex,
              shardCount,
            });
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=${startComment.status} #${item.number}`,
            );
            if (startComment.status === "held") {
              coordinationHeldRetryAt = startComment.retryAt;
              return null;
            }
            acquiredReviewLeases.push({ itemNumber: item.number, lease: startComment.lease });
            return startComment.lease;
          } catch (error) {
            leaseAcquisitionFailures += 1;
            leaseAcquisitionFailureDetails.push(
              `#${item.number}: ${error instanceof Error ? error.message : String(error)}`,
            );
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=failed #${item.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            );
            return null;
          }
        };
        let structuralRecord: ReviewStructuralRecord | null = null;
        let preHydrationStructuralRecord: ReviewStructuralRecord | null = null;
        let hydratedStructuralAnchor: ReviewStructuralRecord | null = null;
        if (!localRangeData) {
          structuralCacheChecks += 1;
          const structuralProbeDecision = reviewStructuralCacheProbeDecision({
            review: cacheEligibleReview,
            reviewPolicy,
            reviewModel: PUBLIC_CODEX_MODEL,
            explicitDispatch,
            maintainerRequest,
            coordinationEnabled: structuralCacheCoordinationEnabled,
          });
          if (!structuralProbeDecision.hit) {
            structuralCacheReasons.set(
              structuralProbeDecision.reason,
              (structuralCacheReasons.get(structuralProbeDecision.reason) ?? 0) + 1,
            );
          } else {
            const structuralProbeStartedAt = Date.now();
            try {
              git = loadReviewGitInfo();
              structuralRecord = fetchReviewStructuralRecord({
                item,
                git,
                reviewPolicy,
                reviewModel: PUBLIC_CODEX_MODEL,
              });
              if (!reviewStructuralRecordAtLeastAsFresh(structuralRecord, item.updatedAt)) {
                structuralRecord = null;
              }
            } catch (error) {
              structuralCacheProbeFailures += 1;
              console.error(
                `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=probe-failed #${item.number}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              );
            } finally {
              structuralCacheProbeMs += Date.now() - structuralProbeStartedAt;
            }
            preHydrationStructuralRecord = structuralRecord;
            if (structuralRecord) item.updatedAt = structuralRecord.activityUpdatedAt;
            const leaseRevision =
              item.kind === "pull_request"
                ? structuralRecord?.pullHeadSha
                : priorReview?.itemSourceRevision;
            const structuralDecisionInput = {
              review: priorReview,
              priorRecord: priorReview?.structuralRecord ?? null,
              currentRecord: structuralRecord,
              reviewPolicy,
              reviewModel: PUBLIC_CODEX_MODEL,
              explicitDispatch,
              maintainerRequest,
              coordinationEnabled: structuralCacheCoordinationEnabled,
            };
            let suppliedLeaseClaim: ReturnType<typeof claimSuppliedReviewLease> | null = null;
            let ownedReservationUpdatedAt: string | undefined;
            let structuralDecision = reviewStructuralCacheDecision(structuralDecisionInput);
            if (
              structuralDecision.reason === "activity_changed" &&
              suppliedReviewLease &&
              leaseRevision
            ) {
              suppliedLeaseClaim = claimSuppliedReviewLease(item.number, leaseRevision);
              if (suppliedLeaseClaim.status === "claimed") {
                ownedReservationUpdatedAt = reviewStartLeaseCommentUpdatedAt(
                  suppliedLeaseClaim.lease.comment,
                );
                if (ownedReservationUpdatedAt) {
                  structuralDecision = reviewStructuralCacheDecision({
                    ...structuralDecisionInput,
                    ownedReservationUpdatedAt,
                  });
                }
              }
            }
            structuralCacheReasons.set(
              structuralDecision.reason,
              (structuralCacheReasons.get(structuralDecision.reason) ?? 0) + 1,
            );
            if (structuralDecision.hit) {
              const initialStructuralRecord = structuralRecord;
              try {
                if (suppliedReviewLease) {
                  const claim =
                    suppliedLeaseClaim ??
                    (leaseRevision
                      ? claimSuppliedReviewLease(item.number, leaseRevision)
                      : ({ status: "stale" } as const));
                  console.error(
                    `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache-start-comment=${claim.status === "claimed" ? "reserved" : claim.status === "held" ? "held" : "stale-reservation"} #${item.number}`,
                  );
                  if (claim.status === "held") {
                    coordinationHeldRetryAt = claim.retryAt;
                    continue;
                  }
                  if (claim.status === "stale") {
                    coordinationHeldRetryAt = new Date(Date.now() + 60_000).toISOString();
                    leaseAcquisitionFailures += 1;
                    leaseAcquisitionFailureDetails.push(
                      `#${item.number}: reserved review lease is no longer fresh for the cached revision`,
                    );
                    continue;
                  }
                  acquiredReviewLease = claim.lease;
                  ownedReservationUpdatedAt ??= reviewStartLeaseCommentUpdatedAt(
                    claim.lease.comment,
                  );
                  acquiredReviewLeases.push({ itemNumber: item.number, lease: claim.lease });
                } else {
                  const startComment = postReviewStartStatusComment({
                    item,
                    headSha: leaseRevision ?? "",
                    reviewTimeoutMs: timeoutMs,
                    position: completed + 1,
                    total: candidates.length,
                    shardIndex,
                    shardCount,
                  });
                  console.error(
                    `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache-start-comment=${startComment.status} #${item.number}`,
                  );
                  if (startComment.status === "held") {
                    coordinationHeldRetryAt = startComment.retryAt;
                    continue;
                  }
                  acquiredReviewLease = startComment.lease;
                  acquiredReviewLeases.push({ itemNumber: item.number, lease: acquiredReviewLease });
                }
              } catch (error) {
                leaseAcquisitionFailures += 1;
                leaseAcquisitionFailureDetails.push(
                  `#${item.number}: ${error instanceof Error ? error.message : String(error)}`,
                );
                console.error(
                  `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache-start-comment=failed #${item.number}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                );
                continue;
              }
              structuralCacheRevalidations += 1;
              const structuralRevalidationStartedAt = Date.now();
              let revalidatedStructuralRecord: ReviewStructuralRecord | null = null;
              let revalidatedPreviousReviewDigest: string | null = null;
              try {
                git = loadReviewGitInfo();
                revalidatedStructuralRecord = fetchReviewStructuralRecord({
                  onPullIdentity: (identity) => { structuralScanIdentity = identity; },
                  item,
                  git,
                  reviewPolicy,
                  reviewModel: PUBLIC_CODEX_MODEL,
                });
                if (
                  !reviewStructuralRecordAtLeastAsFresh(revalidatedStructuralRecord, item.updatedAt)
                ) {
                  revalidatedStructuralRecord = null;
                }
                revalidatedPreviousReviewDigest = liveClawSweeperReviewDigest(item.number);
              } catch (error) {
                structuralCacheRevalidationFailures += 1;
                console.error(
                  `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=revalidation-probe-failed #${item.number}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                );
              } finally {
                structuralCacheRevalidationMs += Date.now() - structuralRevalidationStartedAt;
              }
              const revalidationDecision = reviewStructuralCacheDecision({
                // A lease posted by this command owns activity through now. A
                // supplied reservation owns activity only through its recorded timestamp.
                review: priorReview && !suppliedReviewLease
                  ? {
                      ...priorReview,
                      reviewCommentSyncedAt: new Date().toISOString(),
                    }
                  : priorReview,
                priorRecord: initialStructuralRecord,
                currentRecord: revalidatedStructuralRecord,
                reviewPolicy,
                reviewModel: PUBLIC_CODEX_MODEL,
                explicitDispatch,
                maintainerRequest,
                coordinationEnabled: true,
                ...(ownedReservationUpdatedAt ? { ownedReservationUpdatedAt } : {}),
              });
              const previousReviewIdentityMatches =
                expectedPreviousReviewDigest !== null &&
                revalidatedPreviousReviewDigest !== null &&
                expectedPreviousReviewDigest === revalidatedPreviousReviewDigest;
              const revalidationReason = previousReviewIdentityMatches
                ? revalidationDecision.reason
                : "previous_review_changed";
              structuralCacheRevalidationReasons.set(
                revalidationReason,
                (structuralCacheRevalidationReasons.get(revalidationReason) ?? 0) + 1,
              );
              if (!revalidationDecision.hit || !previousReviewIdentityMatches) {
                const leaseToRelease = acquiredReviewLease!;
                if (!releaseOwnedReviewLease(item.number, leaseToRelease)) {
                  leaseAcquisitionFailures += 1;
                  leaseAcquisitionFailureDetails.push(
                    `#${item.number}: could not release structural cache lease after ${revalidationReason}`,
                  );
                  continue;
                }
                const acquiredIndex = acquiredReviewLeases.findIndex(
                  (entry) =>
                    entry.itemNumber === item.number &&
                    entry.lease.commentId === leaseToRelease.commentId &&
                    entry.lease.owner === leaseToRelease.owner,
                );
                if (acquiredIndex >= 0) acquiredReviewLeases.splice(acquiredIndex, 1);
                acquiredReviewLease = null;
                structuralRecord = revalidatedStructuralRecord;
                preHydrationStructuralRecord = revalidatedStructuralRecord;
                if (structuralRecord) item.updatedAt = structuralRecord.activityUpdatedAt;
                console.error(
                  `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=revalidation-miss reason=${revalidationReason} hydrate #${item.number}`,
                );
              } else {
                const confirmedStructuralRecord = revalidatedStructuralRecord!;
                structuralRecord = confirmedStructuralRecord;
                item.updatedAt = confirmedStructuralRecord.activityUpdatedAt;
                if (
                  !cachePreflightPasses(
                    item.kind === "pull_request" ? confirmedStructuralRecord.pullHeadSha : null,
                  )
                ) {
                  console.error(
                    `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=checkout-preflight-miss hydrate #${item.number}`,
                  );
                } else {
                const reportPath = join(artifactDir, reportFileName(item.repo, item.number));
                let carried = priorReview!.markdown;
                carried = replaceFrontMatterValue(carried, "reviewed_at", new Date().toISOString());
                carried = replaceFrontMatterValue(carried, "item_updated_at", item.updatedAt);
                carried = replaceFrontMatterValue(
                  carried,
                  "review_lease_owner",
                  acquiredReviewLease.owner,
                );
                carried = replaceFrontMatterValue(
                  carried,
                  "review_lease_comment_id",
                  String(acquiredReviewLease.commentId),
                );
                carried = replaceFrontMatterValue(carried, "review_cache_hit", "true");
                carried = updateBulkFilerDetectedFrontMatter(carried, bulkFilerDetection);
                carried = updateReviewStructuralFrontMatter(carried, structuralRecord, true);
                carried = withRunnerPreflightProvenance(carried, replaceFrontMatterValue);
                writeFileSync(reportPath, hostReport(carried), "utf8");
                finishReviewActionLedgerItem({
                  ledger: reviewLedger,
                  item,
                  status: ACTION_EVENT_STATUSES.cached,
                  reasonCode: ACTION_EVENT_REASON_CODES.contentUnchanged,
                  retryable: false,
                  cached: true,
                  startedAtMs: reviewLedger.startedAtMs,
                  ...((
                    item.kind === "pull_request"
                      ? confirmedStructuralRecord.pullHeadSha
                      : priorReview?.itemSourceRevision
                  )
                    ? {
                        sourceRevision: (item.kind === "pull_request"
                          ? confirmedStructuralRecord.pullHeadSha
                          : priorReview?.itemSourceRevision)!,
                      }
                    : {}),
                  reportPath,
                  findingCount: reportReviewFindings(carried).length,
                  completionReason: "structural_cache",
                });
                completed += 1;
                cacheHits += 1;
                structuralCacheHits += 1;
                if (humanLocalReview) {
                  console.error("");
                  console.error("Structural review cache hit; GitHub context unchanged");
                  console.error(`  report: ${displayPath(reportPath)}`);
                } else {
                  console.error(
                    `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} cache-hit structural-unchanged skip-hydration-model #${item.number} (${completed}/${candidates.length})`,
                  );
                }
                continue;
                }
              }
            }
          }
        }
        if (!skipStartComment && !acquiredReviewLease && item.kind === "pull_request") {
          acquiredReviewLease = acquireReviewStartLease(
            () => structuralRecord?.pullHeadSha ?? pullRequestHeadSha(item.number),
          );
          if (!acquiredReviewLease) continue;
        }
        const contextStartedAt = Date.now();
        if (!localRangeData) hydrationRuns += 1;
        const context = localRangeData
          ? localRangeData.context
          : collectItemContext(item, {
              fullTimelineForRelations: true,
              reviewCacheDigest: true,
              reviewCacheGitDir: openclawDir,
              prHydrationSnapshot: existingPriorReview
                ? parsePrHydrationSnapshot(
                    frontMatterValue(existingPriorReview.markdown, "pr_hydration_snapshot"),
                  )
                : null,
              prCommentActivityRevision: prCommentActivityRevisions.get(item.number) ?? null,
            });
        diagnosticSourceSha = item.kind === "pull_request"
          ? pullHeadShaFromContext(context) ?? undefined
          : context.sourceRevision ?? diagnosticSourceSha;
        if (!localRangeData && item.kind === "pull_request") {
          const headSha = pullHeadShaFromContext(context);
          if (!headSha || !preparePullRequestReviewTree(headSha)) {
            throw new ReviewSourcePreparationError(
              "review_checkout_unavailable",
              "Could not prepare the pinned review checkout.",
            );
          }
        }
        if (previousLocalReviewCommentBody) {
          const previousLocalReview = extractClawSweeperReviewCommentBody(
            previousLocalReviewCommentBody,
          );
          const hasCompletedLocalReview =
            previousLocalReview.completedReviewCycles > 0 &&
            /^[0-9a-f]{40}$/iu.test(previousLocalReview.reviewedSha ?? "");
          const appliesToRange =
            !localRangeData ||
            localRangeHistoryApplies(
              openclawDir,
              previousLocalReview?.reviewedSha ?? null,
              localRangeData.headSha,
            );
          if (hasCompletedLocalReview && appliesToRange) {
            context.previousClawSweeperReview = previousLocalReview;
          } else {
            previousLocalReviewCommentBody = "";
          }
        }
        if (bulkFilerDetection.context) context.bulkFiler = bulkFilerDetection.context;
        const contextElapsedMs = Date.now() - contextStartedAt;
        const contextItemUpdatedAt = stringOrUndefined(asRecord(context.issue).updatedAt);
        if (contextItemUpdatedAt) item.updatedAt = contextItemUpdatedAt;
        if (suppliedReviewLease) {
          const currentRevision =
            item.kind === "pull_request"
              ? pullHeadShaFromContext(context)
              : context.sourceRevision ?? null;
          if (!currentRevision) {
            coordinationHeldRetryAt = new Date(Date.now() + 60_000).toISOString();
            leaseAcquisitionFailures += 1;
            leaseAcquisitionFailureDetails.push(
              `#${item.number}: current revision could not be resolved for the reserved review lease`,
            );
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=stale-reservation #${item.number}`,
            );
            continue;
          }
          const claim = claimSuppliedReviewLease(item.number, currentRevision);
          if (claim.status === "stale") {
            coordinationHeldRetryAt = new Date(Date.now() + 60_000).toISOString();
            leaseAcquisitionFailures += 1;
            leaseAcquisitionFailureDetails.push(
              `#${item.number}: reserved review lease is no longer fresh for the current revision`,
            );
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=stale-reservation #${item.number}`,
            );
            continue;
          }
          if (claim.status === "held") {
            coordinationHeldRetryAt = claim.retryAt;
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=held #${item.number}`,
            );
            continue;
          }
          acquiredReviewLease = claim.lease;
          acquiredReviewLeases.push({ itemNumber: item.number, lease: claim.lease });
        }
        if (!localRangeData && contextItemUpdatedAt && preHydrationStructuralRecord) {
          structuralCacheRevalidations += 1;
          const structuralRevalidationStartedAt = Date.now();
          try {
            git = loadReviewGitInfo();
            const candidate = fetchReviewStructuralRecord({
              item,
              git,
              reviewPolicy,
              reviewModel: PUBLIC_CODEX_MODEL,
            });
            if (
              reviewStructuralRecordsDescribeSameVerdictInput(
                preHydrationStructuralRecord,
                candidate,
              ) &&
              reviewStructuralRecordMatchesObservedUpdate(candidate, contextItemUpdatedAt) &&
              reviewStructuralRecordMatchesHydratedItem(
                candidate,
                context.structuralItemStateDigest,
              ) &&
              (item.kind !== "pull_request" ||
                reviewStructuralRecordMatchesHydratedPull(
                  candidate,
                  reviewStructuralPullStateFromContext(context),
                ))
            ) {
              hydratedStructuralAnchor = candidate;
            }
          } catch (error) {
            structuralCacheRevalidationFailures += 1;
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=hydrated-anchor-probe-failed #${item.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            );
          } finally {
            structuralCacheRevalidationMs += Date.now() - structuralRevalidationStartedAt;
          }
          const anchorReason = hydratedStructuralAnchor
            ? "hydrated_anchor_match"
            : "hydrated_anchor_miss";
          structuralCacheRevalidationReasons.set(
            anchorReason,
            (structuralCacheRevalidationReasons.get(anchorReason) ?? 0) + 1,
          );
        }
        const refreshStructuralRecordForVerdict = (): ReviewStructuralRecord | null => {
          if (!hydratedStructuralAnchor) return null;
          structuralCacheRevalidations += 1;
          const structuralRevalidationStartedAt = Date.now();
          let candidate: ReviewStructuralRecord | null = null;
          try {
            const refreshedGit = loadReviewGitInfo();
            candidate = fetchReviewStructuralRecord({
              item,
              git: refreshedGit,
              reviewPolicy,
              reviewModel: PUBLIC_CODEX_MODEL,
            });
          } catch (error) {
            structuralCacheRevalidationFailures += 1;
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=verdict-probe-failed #${item.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            );
          } finally {
            structuralCacheRevalidationMs += Date.now() - structuralRevalidationStartedAt;
          }
          const matched = reviewStructuralRecordsDescribeSameVerdictInput(
            hydratedStructuralAnchor,
            candidate,
          );
          const reason = matched ? "verdict_input_match" : "verdict_input_changed";
          structuralCacheRevalidationReasons.set(
            reason,
            (structuralCacheRevalidationReasons.get(reason) ?? 0) + 1,
          );
          return matched ? candidate : null;
        };
        if (
          acquiredReviewLease &&
          !reviewLeaseStillMatchesContext(
            item.kind,
            pullHeadShaFromContext(context),
            acquiredReviewLease.headSha,
          )
        ) {
          leaseAcquisitionFailures += 1;
          leaseAcquisitionFailureDetails.push(
            `#${item.number}: PR head changed after acquiring review lease`,
          );
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=stale-head #${item.number}`,
          );
          continue;
        }
        if (expectedSourceRevision) {
          enforceExpectedIssueSourceRevision({
            expectedSourceRevision,
            itemKind: item.kind,
            repo: item.repo,
            number: item.number,
            sourceRevision: context.sourceRevision,
            artifactDir,
          });
        }
        if (skipStartComment) {
          if (!humanLocalReview) {
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=skipped #${item.number}`,
            );
          }
        } else if (item.kind !== "pull_request") {
          acquiredReviewLease = acquireReviewStartLease(() => context.sourceRevision ?? "");
          if (!acquiredReviewLease) continue;
        }
        if (!localRangeData && item.kind === "issue" && acquiredReviewLease) {
          try {
            const revalidatedPreviousReview = extractLatestClawSweeperReview(
              fetchIssueReviewComments(item.number),
              item.number,
            );
            if (revalidatedPreviousReview) {
              context.previousClawSweeperReview = revalidatedPreviousReview;
            } else {
              delete context.previousClawSweeperReview;
            }
          } catch (error) {
            const leaseToRelease = acquiredReviewLease;
            leaseAcquisitionFailures += 1;
            leaseAcquisitionFailureDetails.push(
              `#${item.number}: could not refresh durable review after acquiring issue lease: ${
              error instanceof Error ? error.message : String(error)
            }`,
            );
            if (!releaseOwnedReviewLease(item.number, leaseToRelease)) {
              leaseAcquisitionFailureDetails.push(
                `#${item.number}: could not release issue review lease after durable review refresh failed`,
              );
              continue;
            }
            const acquiredIndex = acquiredReviewLeases.findIndex(
              (entry) =>
                entry.itemNumber === item.number &&
                entry.lease.commentId === leaseToRelease.commentId &&
                entry.lease.owner === leaseToRelease.owner,
            );
            if (acquiredIndex >= 0) acquiredReviewLeases.splice(acquiredIndex, 1);
            acquiredReviewLease = null;
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} durable-review=revalidation-failed defer #${item.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            );
            continue;
          }
        }
        const contentDigest = itemContentDigest(item, context, git);
        const currentPreviousReviewDigest = previousClawSweeperReviewDigest(
          context.previousClawSweeperReview,
        );
        const previousReviewIdentityChanged =
          !localRangeData &&
          (!expectedPreviousReviewDigest ||
            !currentPreviousReviewDigest ||
            expectedPreviousReviewDigest !== currentPreviousReviewDigest);
        const contentCacheReview =
          explicitDispatch ||
          maintainerRequest ||
          previousReviewIdentityChanged ||
          !git.releaseStateComplete ||
          (item.kind === "pull_request" && !completePullChecksContext(context.pullChecks))
            ? null
            : cacheEligibleReview;
        const contentCacheHit = reviewContentCacheHit({
            review: contentCacheReview,
            reviewPolicy,
            contentDigest,
            now: Date.now(),
            explicitDispatch,
            maintainerRequest,
          });
        if (
          contentCacheHit &&
          cachePreflightPasses(
            item.kind === "pull_request" ? pullHeadShaFromContext(context) : null,
            context,
          )
        ) {
          structuralRecord = refreshStructuralRecordForVerdict();
          const reportPath = join(artifactDir, reportFileName(item.repo, item.number));
          let carried = priorReview!.markdown;
          carried = replaceFrontMatterValue(carried, "reviewed_at", new Date().toISOString());
          carried = replaceFrontMatterValue(carried, "item_updated_at", item.updatedAt);
          carried = replaceFrontMatterValue(
            carried,
            "review_lease_owner",
            acquiredReviewLease?.owner ?? "unknown",
          );
          carried = replaceFrontMatterValue(
            carried,
            "review_lease_comment_id",
            String(acquiredReviewLease?.commentId ?? "unknown"),
          );
          carried = replaceFrontMatterValue(
            carried,
            "item_snapshot_hash",
            itemSnapshotHash(item, context),
          );
          carried = replaceFrontMatterValue(carried, "review_cache_hit", "true");
          carried = updateBulkFilerDetectedFrontMatter(carried, bulkFilerDetection);
          carried = structuralRecord
            ? updateReviewStructuralFrontMatter(carried, structuralRecord, false)
            : replaceFrontMatterValue(carried, "review_structural_cache_hit", "false");
          carried = withRunnerPreflightProvenance(carried, replaceFrontMatterValue);
          writeFileSync(reportPath, hostReport(carried), "utf8");
          finishReviewActionLedgerItem({
            ledger: reviewLedger,
            item,
            status: ACTION_EVENT_STATUSES.cached,
            reasonCode: ACTION_EVENT_REASON_CODES.contentUnchanged,
            retryable: false,
            cached: true,
            startedAtMs: contextStartedAt,
            ...(context.sourceRevision ? { sourceRevision: context.sourceRevision } : {}),
            reportPath,
            findingCount: reportReviewFindings(carried).length,
            completionReason: "content_cache",
          });
          activeReviewItem = null;
          completed += 1;
          cacheHits += 1;
          contentCacheHits += 1;
          if (humanLocalReview) {
            console.error("");
            console.error("Review cache hit; content unchanged since the last review");
            console.error(`  report: ${displayPath(reportPath)}`);
          } else {
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} cache-hit content-unchanged skip-model #${item.number} (${completed}/${candidates.length})`,
            );
          }
          continue;
        }
        if (proofBinding) {
          assertCommandProofSubject(proofBinding, pullHeadShaFromContext(context), context.pullRequest ?? context.issue, asRecord(asRecord(context.pullRequest).base).ref, asRecord(asRecord(context.pullRequest).base).sha);
        }
        const codexWorkDir = join(artifactDir, "codex");
        const proofScratchDir = join(codexWorkDir, "proof-scratch", String(item.number));
        // --local-range is a pre-PR LOCAL code review — it has no telegram-visible-proof to
        // capture, and prepareMediaProofArtifacts would host-side download media URLs and transcode
        // videos in the synthetic body (commit message / --body-file). Skip it entirely for
        // local-range: no host download or transcode of body-supplied URLs.
        const preparedMediaProof: PreparedMediaProof = localRangeData
          ? { manifestPath: null, summaryPath: null, artifacts: [] }
          : prepareMediaProofArtifacts(context, proofScratchDir);
        const reviewEnv = reviewEnvironment(localOnly);
        const prompt = buildReviewPrompt(
          item,
          context,
          git,
          additionalPrompt,
          {
            ...mediaProofRuntimeHints(proofScratchDir, preparedMediaProof),
            targetDir: reviewOpenclawDir,
            ...reviewNetworkCapability(sandboxMode, reviewEnv),
          },
        );
        diagnosticPrompt = prompt.text;
        const snapshotHash = itemSnapshotHash(item, context);
        let decision: Decision;
        let codexElapsedMs = 0;
        let codexFailed = false;
        let codexFailureError: unknown = null;
        let codexFailureRetryable = false;
        let codexFailureDisposition: ReturnType<typeof actionLedgerFailureDisposition> | null =
          null;
        const codexStartedAt = Date.now();
        try {
          if (humanLocalReview) {
            console.error("");
            console.error("Running Codex review");
            console.error(`  timeout: ${displayDurationMs(timeoutMs)}`);
            console.error(
              `  stdout: ${displayPath(join(codexWorkDir, `${item.number}.1.codex.stdout.log`))}`,
            );
            console.error(
              `  stderr: ${displayPath(join(codexWorkDir, `${item.number}.1.codex.stderr.log`))}`,
            );
          }
          decision = runCodex({
            item,
            context,
            git,
            model,
            openclawDir: reviewOpenclawDir,
            reasoningEffort,
            sandboxMode,
            serviceTier,
            forcedLoginMethod,
            preserveCodexAuth: localOnly,
            timeoutMs,
            workDir: codexWorkDir,
            additionalPrompt,
            proofScratchDir,
            prompt: prompt.text,
            reviewEnv,
            quietLogs: humanLocalReview,
            ...(localRange ? { extraCodexConfig: [LOCAL_REVIEW_WEB_SEARCH_CONFIG] } : {}),
          });
        } catch (error) {
          if (error instanceof AgentInputScanError) throw error;
          codexFailures += 1;
          codexFailed = true;
          codexFailureError = error;
          codexFailureRetryable = codexReviewFailureRetryable(error);
          codexFailureDisposition = actionLedgerFailureDisposition(error);
          if (error instanceof CodexReviewError) {
            decision = codexFailureDecision(
              error.status,
              error.message,
              error.stdout,
              error.stderr,
              {
                errorCode: error.errorCode,
                signal: error.signal,
              },
            );
          } else {
            decision = codexFailureDecision(
              null,
              error instanceof Error ? error.message : String(error),
              "Per-item Codex failure; continuing with the rest of the shard.",
            );
          }
        } finally {
          codexElapsedMs = Date.now() - codexStartedAt;
        }
        decision = attachFixedPullRequest(
          decision,
          item,
          context,
          existingPriorReview?.markdown,
        );
        decision = verifyRegressionProvenance(decision, item, context, reviewOpenclawDir, git);
        const runtime = {
          model: PUBLIC_CODEX_MODEL,
          reasoningEffort,
          sandboxMode,
          serviceTier,
          ...prompt.telemetry,
          contextElapsedMs,
          codexElapsedMs,
        };
        const action = reviewActionForDecision({ item, decision, git, runtime });
        structuralRecord = refreshStructuralRecordForVerdict();
        const reportPath = join(artifactDir, reportFileName(item.repo, item.number));
        const reportMarkdown = hostReport(markdownFor({
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
            ...(acquiredReviewLease
              ? {
                  reviewLeaseOwner: acquiredReviewLease.owner,
                  reviewLeaseCommentId: acquiredReviewLease.commentId,
                }
              : {}),
        }));
        writeFileSync(reportPath, reportMarkdown, "utf8");
        if (codexFailureError) {
          recordFailureDiagnostics(codexFailureError, codexFailureLogKind(reportMarkdown));
        }
        if (itemLocalReviewHistoryPath) {
          const nextLocalReviewCommentBody =
            frontMatterValue(reportMarkdown, "review_status") === "complete"
              ? renderReviewCommentFromReport(
                  reportMarkdown,
                  "none",
                  previousLocalReviewCommentBody
                    ? { previousReviewCommentBody: previousLocalReviewCommentBody }
                    : undefined,
                )
              : previousLocalReviewCommentBody;
          if (nextLocalReviewCommentBody) {
            writeFileSync(itemLocalReviewHistoryPath, nextLocalReviewCommentBody, "utf8");
          }
        }
        recordReviewLogPublication({
          ledger: reviewLedger,
          item,
          codexWorkDir,
          cached: false,
        });
        finishReviewActionLedgerItem({
          ledger: reviewLedger,
          item,
          status: codexFailureDisposition?.status ?? ACTION_EVENT_STATUSES.completed,
          reasonCode: codexFailureDisposition?.reasonCode ?? ACTION_EVENT_REASON_CODES.completed,
          retryable: codexFailed && codexFailureRetryable,
          cached: false,
          startedAtMs: contextStartedAt,
          ...(context.sourceRevision ? { sourceRevision: context.sourceRevision } : {}),
          reportPath,
          findingCount: decision.reviewFindings.length,
          completionReason: codexFailureDisposition?.completionReason ?? decision.decision,
        });
        activeReviewItem = null;
        completed += 1;
        if (codexFailed) codexFailureReports.push(reportPath);
        if (humanLocalReview) {
          console.error("");
          console.error(codexFailed ? "Codex review failed" : "Review complete");
          console.error(`  elapsed: ${displayDurationMs(codexElapsedMs)}`);
          console.error(`  decision: ${decision.decision}`);
          console.error(`  confidence: ${decision.confidence}`);
          console.error(`  action: ${action.actionTaken}`);
          console.error(`  report: ${displayPath(reportPath)}`);
        } else {
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} done #${item.number} (${completed}/${candidates.length}) decision=${decision.decision} confidence=${decision.confidence} action=${action.actionTaken}`,
          );
        }
        } catch (error) {
          reviewItemFailed = true;
          if (error instanceof AgentInputScanError || error instanceof ReviewSourcePreparationError) {
            recordFailureDiagnostics(error);
          }
          throw error;
        } finally {
          try {
            if (
              !reviewItemFailed &&
              activeReviewItem &&
              actionLedgerItemKey(activeReviewItem) === actionLedgerItemKey(item)
            ) {
              finishReviewActionLedgerItem({
                ledger: reviewLedger,
                item,
                status: ACTION_EVENT_STATUSES.blocked,
                reasonCode: ACTION_EVENT_REASON_CODES.leaseActive,
                retryable: true,
                cached: false,
                startedAtMs:
                  reviewLedger.items.get(actionLedgerItemKey(item))?.startedAtMs ??
                  reviewLedger.startedAtMs,
                completionReason: "coordination_deferred",
              });
              activeReviewItem = null;
            }
          } finally {
            try {
              dependencies.activeReviewMutationRunner = previousReviewMutationRunner;
            } finally {
              restoreTreeModes(itemReadonlyModeSnapshots);
              if (
                pullRequestReviewTreeDir &&
                !removePullRequestReviewTree({
                  targetDir: openclawDir,
                  worktreeDir: pullRequestReviewTreeDir,
                })
              ) {
                const detail = [
                  "could not remove restricted review checkout",
                  pullRequestReviewTreeDir,
                ].join(" ");
                reviewTreeCleanupFailures.push(detail);
                console.error(`[review] ${new Date().toISOString()} ${detail}`);
              }
            }
          }
        }
      }
      if (coordinationHeldRetryAt) {
        writeFileSync(
          coordinationHeldPath,
          JSON.stringify({ retry_at: coordinationHeldRetryAt }, null, 2) + "\n",
          "utf8",
        );
      }
      if (!humanLocalReview) {
        console.error(
          `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} complete reviewed=${completed} cache_hits=${cacheHits} structural_cache_checks=${structuralCacheChecks} structural_cache_hits=${structuralCacheHits} structural_cache_revalidations=${structuralCacheRevalidations} content_cache_hits=${contentCacheHits} hydrations=${hydrationRuns}`,
        );
      }
      writeFileSync(
        join(artifactDir, "review-cache-metrics.json"),
        JSON.stringify(
          {
            candidates: candidates.length,
            completed,
            cache_hits: cacheHits,
            structural_cache_checks: structuralCacheChecks,
            structural_cache_hits: structuralCacheHits,
            structural_cache_probe_failures: structuralCacheProbeFailures,
            structural_cache_probe_ms: structuralCacheProbeMs,
            structural_cache_revalidations: structuralCacheRevalidations,
            structural_cache_revalidation_failures: structuralCacheRevalidationFailures,
            structural_cache_revalidation_ms: structuralCacheRevalidationMs,
            structural_cache_reasons: Object.fromEntries(
              [...structuralCacheReasons.entries()].sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            ),
            structural_cache_revalidation_reasons: Object.fromEntries(
              [...structuralCacheRevalidationReasons.entries()].sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            ),
            content_cache_hits: contentCacheHits,
            hydrations: hydrationRuns,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      if (leaseAcquisitionFailures > 0) {
        throw new Error(
          `Could not acquire durable review coordination for ${leaseAcquisitionFailures} item${
            leaseAcquisitionFailures === 1 ? "" : "s"
          }; the workflow recovery lane can requeue the planned set. ${leaseAcquisitionFailureDetails.join("; ")}`,
        );
      }
      if (reviewTreeCleanupFailures.length > 0) {
        throw new Error(reviewTreeCleanupFailures.join("; "));
      }
      if (codexFailures > 0) {
        for (const reportPath of codexFailureReports) {
          const failureKind = codexFailureLogKind(readFileSync(reportPath, "utf8"));
          console.error(
            `[review] ${new Date().toISOString()} codex-failure classification=${failureKind} report=${displayPath(reportPath)}`,
          );
        }
        const message = `Codex failed for ${codexFailures} item${
          codexFailures === 1 ? "" : "s"
        }; local failure reports were written and the workflow recovery lane can requeue the planned set.${
          codexFailureReports.length > 0
            ? ` Report${codexFailureReports.length === 1 ? "" : "s"}: ${codexFailureReports
                .map(displayPath)
                .join(", ")}`
            : ""
        }`;
        if (humanLocalReview) throw new UserFacingCommandError(message);
        throw new Error(message);
      }
      finishReviewActionLedger({
        ledger: reviewLedger,
        completedCount: completed,
        cacheHits,
      });
    } catch (error) {
      if (reviewLedger) {
        for (const acquired of acquiredReviewLeases) {
          const state = [...reviewLedger.items.values()].find(
            (candidate) => candidate.item.number === acquired.itemNumber,
          );
          if (!state) continue;
          const previousReviewMutationRunner = dependencies.activeReviewMutationRunner;
          dependencies.activeReviewMutationRunner = reviewMutationRunner(reviewLedger, state.item);
          try {
            releaseOwnedReviewLease(acquired.itemNumber, acquired.lease);
          } finally {
            dependencies.activeReviewMutationRunner = previousReviewMutationRunner;
          }
        }
        finishReviewActionLedger({
          ledger: reviewLedger,
          error,
          activeItem: activeReviewItem,
          completedCount: completed,
          cacheHits,
        });
      }
      throw error;
    } finally {
      restoreTreeModes(readonlyModeSnapshots);
    }
  }

  return { reviewCommand };
}
