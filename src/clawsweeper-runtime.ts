#!/usr/bin/env node
import { sha256 } from "./content-hash.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { flushWorkflowActionEvents } from "./action-ledger-runtime.js";
import { boolArg, itemNumbersArg, parseArgs, stringArg, type Args } from "./clawsweeper-args.js";
import { dispatchCommand, type CommandHandler } from "./clawsweeper-command-dispatch.js";
import { reviewDecisionParser } from "./clawsweeper-decision-parser.js";
import { runText, runTextConcurrently, SWEEPER_COMMAND_MAX_BUFFER_BYTES } from "./command.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import { repositoryProfileFor } from "./repository-profiles.js";
import { reviewPullChecksDigestParts } from "./review-checks-digest.js";
import {
  reviewStructuralQuery,
  reviewStructuralRecordFromGraphql,
  type ReviewStructuralRecord,
} from "./review-structural-cache.js";
import { stableJson } from "./stable-json.js";
import { asRecord, nonBlankStringOrUndefined } from "./value-coerce.js";

import {
  finalizeActionEventsCommand,
  isExplicitActionLedgerCommand,
  publishActionEventPathsCommand,
  publishActionEventsCommand,
} from "./clawsweeper-action-commands.js";
import { createApplyDecisionWorkflow } from "./clawsweeper-apply-decision-workflow.js";
import { implementedOnMainCloseProvenanceBlock } from "./clawsweeper-apply-close-execution.js";
import { createApplyGuards } from "./clawsweeper-apply-guards.js";
import { createAssistWorkflow } from "./clawsweeper-assist.js";
import {
  hasUsableCloseComment,
  isImplementationCloseReason,
  staleVersionBugDecisionBlockReason,
  unsponsoredFeatureDecisionBlockReason,
  validateCloseDecision,
} from "./clawsweeper-close-decision.js";
import { createCommandOperations } from "./clawsweeper-command-operations.js";
import { createContextHydration } from "./clawsweeper-context-hydration.js";
import { createDashboardAudit } from "./clawsweeper-dashboard-audit.js";
import { createGitHubContext, githubCount } from "./clawsweeper-github-context.js";
import { createGitHubExecution } from "./clawsweeper-github-execution.js";
import { createGitHubRuntime } from "./clawsweeper-github-runtime.js";
import { exactPublicationPublicReadToken } from "./github-public-read.js";
import { createItemContext } from "./clawsweeper-item-context.js";
import {
  applyBlockingProtectedLabels,
  applyKindArg,
  applyProtectedLabelReason,
  authorPrBudgetAgeSkipReason,
  closeReasonApplyAgeSkipReason,
  closeReasonEnabled,
  closeReasonFilterText,
  closeReasonsArg,
  isBulkFilerExemptAuthorAssociation,
  isBulkFilerExemptRepositoryPermission,
  isMaintainerAuthorAssociation,
  isMaintainerAuthored,
  isProtectedItem,
  isVerifiedFixedCloseReason,
  labelNames,
  normalizeAuthorAssociation,
  normalizeLabelName,
  shouldPlanItem,
} from "./clawsweeper-item-policy.js";
import { createLabelMutationOperations } from "./clawsweeper-label-mutations.js";
import { createLabelSyncOperations } from "./clawsweeper-label-operations.js";
import { createLiveProofCommands } from "./live-proof/commands.js";
import { publishReviewLiveProofArtifacts } from "./live-proof/publication-artifacts.js";
import { executeReviewLiveProofs, inspectReviewLiveProofs } from "./live-proof/review-artifacts.js";
import * as repositoryLinks from "./clawsweeper-links.js";
import {
  repoFromArgs,
  setTargetRepo,
  targetProfile,
  targetRepo,
  withTargetProfile,
} from "./repository-profiles.js";
import * as repositoryPaths from "./clawsweeper-repository-paths.js";
import { createLocalRangeReviewer } from "./clawsweeper-local-review.js";
import { createPlanCommand } from "./clawsweeper-plan-command.js";
import { CLAWSWEEPER_BOT_AUTHORS } from "./clawsweeper-review-comments.js";
import {
  EVENT_GUARDED_OPEN_ACTIONS,
  FRESH_DAYS,
  REVIEW_SECTIONS,
  REVIEW_POLICY_VERSION,
} from "./clawsweeper-policy.js";
import { createRegressionProvenanceVerifier } from "./clawsweeper-regression-provenance.js";
import { createReportOrchestration } from "./clawsweeper-report-orchestration.js";
import { reportLiveProofPlan } from "./live-proof/report.js";
import { createReviewRecordBackfill } from "./review-record-backfill.js";
import { existingReview } from "./clawsweeper-record-metadata.js";
import {
  markdownFiles,
  markdownRepository,
  numberForMarkdownFile,
  repoRelativePath,
  reportFileName,
  ROOT,
} from "./clawsweeper-repository-paths.js";
import { createReviewCommandWorkflow } from "./clawsweeper-review-command-workflow.js";
import { createReviewCommentWorkflow } from "./clawsweeper-review-comments-workflow.js";
import {
  heldReviewStartStatusCommentResult,
  isSuppliedReviewStartLease,
  reviewLeaseStillMatchesContext,
  suppliedReviewStartLeaseFromArgs,
} from "./clawsweeper-review-lease.js";
import { createReviewActionLedger } from "./clawsweeper-review-ledger.js";
import { createReviewPlanning } from "./clawsweeper-review-planning.js";
import { createReviewRuntime, type ReviewItemPrompts } from "./clawsweeper-review-runtime.js";
import {
  hydratedReviewStructuralItemStateDigest,
  isExactEventSourceRevisionChange,
  isIgnorableSourceRevisionLabel,
  itemContentDigest,
  itemSnapshotHash,
  itemSourceRevisionSha256,
  pullCommitContentRevision,
  reviewCommentBodyDigest,
  reviewCommentContentRevision,
  reviewTimelineDigestParts,
} from "./clawsweeper-source-revision.js";
import {
  freshPullRequestReviewHead,
  pullHeadShaFromContext,
  reviewStructuralPullStateFromContext,
  stalePullRequestReviewComment,
  stalePullRequestReviewHead,
} from "./clawsweeper-review-comment-identity.js";
import {
  repairLoopPassModeFromReport,
  reviewAutomationMarkersFromReport,
  reviewVersionMarkerFromReport,
} from "./clawsweeper-review-comment-automation.js";
export { reviewAutomationMarkersFromReport };
import {
  currentClosingPullRequestReferenceFromIssueTimeline,
  createStatusContext,
  linkedIssueNumbersForImplementationProvenance,
  linkedIssueNumbersForPullRequestBody,
} from "./clawsweeper-status-context.js";
import { createSweepStatus } from "./clawsweeper-sweep-status.js";
import type {
  Decision,
  GitInfo,
  Item,
  ItemContext,
  MutationRunner,
  ReportEntry,
  RootCauseNormalizationItem,
} from "./clawsweeper-types.js";
import { frontMatterValue } from "./report-front-matter.js";
export {
  authorPrBudgetAgeSkipReason,
  closeReasonApplyAgeSkipReason,
  closeReasonsArg,
  isProtectedItem,
  obsoleteFixPrAgeSkipReason,
  protectedLabels,
  shouldPlanItem,
  staleVersionBugAgeSkipReason,
  unconfirmedProductDirectionAgeSkipReason,
  unsponsoredFeatureAgeSkipReason,
} from "./clawsweeper-item-policy.js";
export type {
  BulkFilerDetectionResult,
  BulkFilerReviewContext,
  ContextHydration,
  GitHubDispatchOutcome,
  GithubPageWithHeaders,
  LabelJustification,
  ReviewStartStatusCommentOptions,
} from "./clawsweeper-types.js";

export { itemNumbersArg } from "./clawsweeper-args.js";
export {
  prepareMediaProofArtifactsForTest,
  proofMediaUrlsFromContextForTest,
  proofVideoUrlsFromContextForTest,
} from "./clawsweeper-media-proof.js";
export {
  heldReviewStartStatusCommentResult as heldReviewStartStatusCommentResultForTest,
  isSuppliedReviewStartLease as isSuppliedReviewStartLeaseForTest,
  reviewLeaseStillMatchesContext as reviewLeaseStillMatchesContextForTest,
} from "./clawsweeper-review-lease.js";
export { safeOutputTail } from "./clawsweeper-text.js";
export {
  codexEnv,
  codexLoginConfig,
  codexLoginMethod,
  redactInternalCodexModel,
} from "./codex-env.js";
export {
  buildDecisionPacketFromReport,
  renderDecisionPacketPublicBlock,
} from "./decision-packets.js";
export {
  parseGhJson,
  parseGhJsonLines,
  parseGhJsonLinesWithRetry,
  parseGhJsonWithRetry,
  parseGhJsonWithRetryAsync,
} from "./github-json.js";
export {
  ghRetryKind,
  ghRetryWaitMs,
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
  shouldRetryGh,
} from "./github-retry.js";

const DEFAULT_PLAN_BATCH_SIZE = 3;
const DEFAULT_PLAN_SHARD_COUNT = AUTOMATION_LIMITS.review_shards.normal_default;
const MAX_PLAN_SHARD_COUNT = AUTOMATION_LIMITS.review_shards.hard_cap;

const REVIEW_ITEM_PROMPT_PATHS = {
  core: join(ROOT, "prompts", "review-item.md"),
  issue: join(ROOT, "prompts", "review-item-issue.md"),
  pull_request: join(ROOT, "prompts", "review-item-pr.md"),
  closeReasons: join(ROOT, "prompts", "review-close-reasons.md"),
};
const CLAWSWEEPER_DECISION_SCHEMA_PATH = join(ROOT, "schema", "clawsweeper-decision.schema.json");
const PR_CLOSE_COVERAGE_PROOF_PROMPT_PATH = join(ROOT, "prompts", "pr-close-coverage-proof.md");
const PR_CLOSE_COVERAGE_PROOF_SCHEMA_PATH = join(
  ROOT,
  "schema",
  "clawsweeper-pr-close-coverage-proof.schema.json",
);

export function guardedOpenApplyProofFields(
  actionTaken: string,
  options: { emitEventApplyProof: boolean; liveGuardVerified: boolean },
): { guardedOpenStateVerified?: true } {
  return options.emitEventApplyProof &&
    options.liveGuardVerified &&
    EVENT_GUARDED_OPEN_ACTIONS.has(actionTaken)
    ? { guardedOpenStateVerified: true }
    : {};
}

const { markdownLink, reportUrl } = repositoryLinks;

const sweepStatus = createSweepStatus({
  ensureDir,
  readSweepStatusSummary: (...args) => readSweepStatusSummary(...args),
  ROOT,
  targetProfile,
});
const { defaultClosedDir, defaultItemsDir } = repositoryPaths;

type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv };

function runTextOptions(options: RunOptions) {
  return {
    cwd: options.cwd ?? ROOT,
    env: options.env,
    maxBuffer: SWEEPER_COMMAND_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    trim: "both" as const,
  };
}

function run(
  command: string,
  args: string[],
  options: RunOptions & { timeoutMs?: number | undefined } = {},
): string {
  return runText(command, args, { ...runTextOptions(options), timeoutMs: options.timeoutMs });
}

const gitHubRuntime = createGitHubRuntime({
  ROOT,
  run,
  runConcurrently: (commands, concurrency) =>
    runTextConcurrently(
      commands.map(({ command, args, options }) => ({
        command,
        args,
        options: { ...runTextOptions(options), deadlineAt: options.deadlineAt },
      })),
      concurrency,
    ),
  targetRepo,
});
export const { untrustedCodexEnvForTest } = gitHubRuntime;
const { GitHubRuntimeBudgetError, untrustedCodexEnv } = gitHubRuntime;

const githubExecution = createGitHubExecution({
  ROOT,
  gitHubRuntime,
});
export const { classifyGitHubDispatchResultForTest, observedGitHubMutationAttemptsForTest } =
  githubExecution;
const {
  ApplyMutationReviewGuardError,
  GitHubDispatchError,
  ghJson,
  ghJsonEach,
  ghJsonLines,
  ghJsonOnce,
  ghObservedMutationCommand,
  ghRawOnceWithCheckpoint,
  ghWithRetry,
  mutationErrorMessage,
} = githubExecution;

const githubContext = createGitHubContext({ ghJson, ghJsonEach, ghWithRetry, targetRepo });
export const {
  ghPagedContextWindow,
  ghPagedLinkHeaderContextWindow,
  githubContextWindowPlan,
  githubLinkLastPageNumber,
  githubPaginatedPath,
} = githubContext;
const { fetchReviewedPrActivityCursor, ghPaged } = githubContext;
export { isExactEventSourceRevisionChange };

function reviewPolicyHash(
  options: { model?: string; sandboxMode?: string },
  prompts: ReviewItemPrompts = reviewPromptTemplates(),
): string {
  const policyTargetRepo = targetRepo();
  return sha256(
    stableJson({
      version: REVIEW_POLICY_VERSION,
      freshDays: FRESH_DAYS,
      // Model changes roll through normal review cadence. Keep this sentinel
      // stable; bump REVIEW_POLICY_VERSION to invalidate stored reviews.
      model: "model-excluded-2026-07",
      reasoningEffort: "per-item-author-profile-v1",
      itemExecutionProfile: "maintainer-high-fast-otherwise-medium-standard-v1",
      sandboxMode: options.sandboxMode ?? "read-only",
      // Keep the historical hash value so service tier changes do not invalidate reviews.
      serviceTier: "",
      targetRepo: policyTargetRepo,
      ...(policyTargetRepo.toLowerCase() === "openclaw/openclaw"
        ? { openclawCodexSourceProvisioning: "v1" }
        : {}),
      repositoryProfile: targetProfile(),
      prompts,
      schema: reviewDecisionSchemaText(),
    }),
  ).slice(0, 16);
}

export function reviewPolicyHashForTest(
  options: {
    model?: string;
    sandboxMode?: string;
  } = {},
  prompts?: ReviewItemPrompts,
): string {
  return reviewPolicyHash(options, prompts);
}

const { defaultRootCauseCluster, parseGitHubItemRef } = reviewDecisionParser;

export function parseDecision(value: unknown, item?: RootCauseNormalizationItem): Decision {
  return reviewDecisionParser.parseDecision(value, item);
}

const applyGuards = createApplyGuards({
  ghJson: <T>(args: string[]): T =>
    ghJson<T>(
      exactPublicationPublicReadToken(args, targetRepo()) ? [...args, "--method", "GET"] : args,
    ),
  ghPaged: <T>(path: string): T[] => ghPaged<T>(path, { requireApp: true }),
  targetRepo,
});
const { resetGuardReadCache } = applyGuards;
export function stalledUnprovenProofRequestBlockReason(
  ...args: Parameters<typeof applyGuards.stalledUnprovenProofRequestBlockReason>
): ReturnType<typeof applyGuards.stalledUnprovenProofRequestBlockReason> {
  resetGuardReadCache();
  return applyGuards.stalledUnprovenProofRequestBlockReason(...args);
}

const contextHydration = createContextHydration({
  CLAWSWEEPER_BOT_AUTHORS,
  ...repositoryPaths,
  displayTitle: (title) => displayTitle(title),
  fetchIssueReviewComments: (number) => fetchIssueReviewComments(number),
  ghJson,
  ghJsonOnce,
  ghJsonEach,
  githubCount,
  GitHubRuntimeBudgetError,
  isBulkFilerExemptAuthorAssociation,
  isSafeGitBranchName: (branch) => isSafeGitBranchName(branch),
  labelNames,
  normalizeAuthorAssociation,
  normalizeLabelName,
  repoRelativePath,
  reportUrl,
  reviewCommentBodyDigest,
  ROOT,
  targetRepo,
});
export const {
  authorPrBudget,
  authorPrBudgetMaxClosesPerRun,
  bulkFilerPolicyInvalidatesCachedReviewForTest,
  bulkFilerThreshold,
  bulkFilerWindowDays,
  closingPullRequestReferenceTarget,
  compactMappedSlice,
  compactMappedWindow,
  compactPullRequestForTest,
  compactReferencingMergedPullRequestForTest,
  detectBulkFilerForTest,
  extractLatestClawSweeperReviewForTest,
  extractLatestClawSweeperReviewFromHydrationForTest,
  filterReviewContextCommentsForTest,
  goodFirstIssueLabelOptedOutForTest,
  openClosingPullRequestApplyReason,
  previousClawSweeperReviewDigestFromReportForTest,
  referencingMergedPullRequestCandidatesForTest,
  referencingMergedPullRequestsForIssueForTest,
  relatedGitHubIssueSearchQueryForTest,
  relatedTitleSearchTerms,
  sameAuthorCounterpartApplyReason,
  updateBulkFilerDetectedFrontMatterForTest,
} = contextHydration;
const { completePullChecksContext, pullChecksContext, structuralExternalRelationSensitivity } =
  contextHydration;

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

const reviewPlanning = createReviewPlanning({
  maxPlanShardCount: MAX_PLAN_SHARD_COUNT,
  targetRepo,
  ghJson,
  ghJsonLines,
  ...githubContext,
  githubCount,
  itemSourceRevisionSha256,
  normalizeAuthorAssociation,
  shouldPlanItem,
  failedReviewRetryStatePath: (stateDir, number) => failedReviewRetryStatePath(stateDir, number),
  readFailedReviewRetryState: (statePath) => readFailedReviewRetryState(statePath),
  failedReviewRetryMarkdownWithState: (markdown, state) =>
    failedReviewRetryMarkdownWithState(markdown, state),
  repoRelativePath,
  dashboardClosedAt: (markdown) => dashboardClosedAt(markdown),
});
export const {
  dashboardFailedReviewRetryActivityForTest,
  shardItemNumbers,
  shouldSkipScheduledHotIntakeExactReviewForTest,
} = reviewPlanning;
const {
  exactLocalReviewNoCandidateError,
  fetchItem,
  fetchOpenItemNumbers,
  fetchPlannedPrActivityRevisions,
  isFresh,
  planCandidates,
  selectCandidates,
} = reviewPlanning;

function fetchReviewStructuralRecord(options: {
  item: Item;
  git: GitInfo;
  reviewPolicy: string;
  reviewModel: string;
  onPullIdentity?: (identity: { baseSha: string; headSha: string }) => void;
}): ReviewStructuralRecord | null {
  if (!options.git.releaseStateComplete) return null;
  const [owner, name] = options.item.repo.split("/");
  if (!owner || !name) return null;
  const externalRelationSensitive = structuralExternalRelationSensitivity(options.item);
  if (externalRelationSensitive === null) {
    throw new Error(`structural relation probe failed for #${options.item.number}`);
  }
  const response = ghJson<unknown>([
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${options.item.number}`,
    "-f",
    `query=${reviewStructuralQuery(options.item.kind)}`,
  ]);
  let pullChecksDigest: string | null = null;
  if (options.item.kind === "pull_request") {
    const pull = asRecord(asRecord(asRecord(response).data).repository).pullRequest;
    const headSha = nonBlankStringOrUndefined(asRecord(pull).headRefOid)?.trim().toLowerCase();
    if (!headSha) return null;
    const pullChecks = pullChecksContext(options.item.number, headSha);
    if (!completePullChecksContext(pullChecks)) return null;
    pullChecksDigest = sha256(stableJson(reviewPullChecksDigestParts(pullChecks)));
    options.onPullIdentity?.({
      baseSha: nonBlankStringOrUndefined(asRecord(pull).baseRefOid)?.trim().toLowerCase() ?? "",
      headSha,
    });
  }
  return reviewStructuralRecordFromGraphql({
    response,
    repo: options.item.repo,
    number: options.item.number,
    kind: options.item.kind,
    targetHeadSha: options.git.mainSha.trim().toLowerCase(),
    latestReleaseTag: options.git.latestRelease?.tagName ?? null,
    latestReleaseSha: options.git.latestRelease?.sha?.trim().toLowerCase() ?? null,
    pullChecksDigest,
    reviewPolicy: options.reviewPolicy,
    reviewModel: options.reviewModel,
    ignoreAuthor: (author) => CLAWSWEEPER_BOT_AUTHORS.has(author.toLowerCase()),
    ignoreLabel: (label) => isIgnorableSourceRevisionLabel(normalizeLabelName(label)),
    externalRelationSensitive,
  });
}

const { collectItemContext } = createItemContext({
  ...contextHydration,
  ...githubContext,
  ghJson,
  hydratedReviewStructuralItemStateDigest,
  itemSourceRevisionSha256,
  pullCommitContentRevision,
  reviewCommentContentRevision,
  reviewTimelineDigestParts,

  targetRepo,
});

const reviewRuntime = createReviewRuntime({
  reviewItemPromptPaths: REVIEW_ITEM_PROMPT_PATHS,
  decisionSchemaPath: CLAWSWEEPER_DECISION_SCHEMA_PATH,
  prCloseCoverageProofPromptPath: PR_CLOSE_COVERAGE_PROOF_PROMPT_PATH,
  targetRepo,
  run,
  untrustedCodexEnv,
  ghJson,
  defaultRootCauseCluster,
  parseDecision,
  ensureDir,
});
export const {
  codexFailureDecisionForTest,
  codexFailureLogKindForTest,
  codexReviewFailureRetryableForTest,
  defaultReviewArtifactDirForTest,
  localExactReviewHistoryPathForTest,
  makeTreeReadOnlyForTest,
  prepareManagedLocalReviewCheckoutForTest,
  restoreTreeModesForTest,
  reviewCodexForcedLoginMethodForTest,
  reviewDecisionSchemaText,
  reviewPromptForTest,
  reviewPromptTelemetryForTest,
  reviewPromptTemplates,
  runCodexForTest,
} = reviewRuntime;
const { codexFailureReason, isSafeGitBranchName, prCloseCoverageProofPromptTemplate } =
  reviewRuntime;

const assistWorkflow = createAssistWorkflow({
  root: ROOT,
  canPatchReviewComment: (comment) => canPatchReviewComment(comment),
  collectItemContext,
  ensureDir,
  fetchItem,
  ghJson,
  ghPaged,
  ghWithRetry,
  repoFromArgs,
  targetRepo,
  untrustedCodexEnv,
  writeCommentPayload: (number, body) => writeCommentPayload(number, body),
});
export const {
  assistIssueUrlMatchesForTest,
  assistPromptContextForTest,
  stripEmptyMaintainerRulingFieldsForTest,
} = assistWorkflow;
const {
  assistGenerateCommand,
  assistPublishCommand,
  assistResolveTargetCommand,
  assistValidateArtifactCommand,
} = assistWorkflow;

const statusContext = createStatusContext({
  targetProfile,
  targetRepo,
  ...repositoryLinks,
  ...sweepStatus,
  ghJson,
  GitHubRuntimeBudgetError,
  numberOrUndefined,
  recordOrUndefined,
});
export const { fixedPullRequestFromCommitPullsForTest } = statusContext;
export {
  currentClosingPullRequestReferenceFromIssueTimeline,
  implementedOnMainCloseProvenanceBlock,
  linkedIssueNumbersForPullRequestBody,
  linkedIssueNumbersForImplementationProvenance,
};
const {
  attachFixedPullRequest,
  displayTitle,
  implementedOnMainPullRequestProvenanceApplyBlock,
  readSweepStatusSummary,
} = statusContext;

const regressionProvenanceVerifier = createRegressionProvenanceVerifier({
  fetchPull: (repo, number) =>
    ghJson<unknown>([
      "api",
      `repos/${repo}/pulls/${number}`,
      "-H",
      "Accept: application/vnd.github+json",
    ]),
  fetchPullDiff: (repo, number) =>
    run("gh", [
      "api",
      `repos/${repo}/pulls/${number}`,
      "-H",
      "Accept: application/vnd.github.v3.diff",
    ]),
});

function verifyRegressionProvenance(
  decision: Decision,
  item: Item,
  context: ItemContext,
  checkoutDir: string,
  git: GitInfo,
): Decision {
  const regressionProvenance = regressionProvenanceVerifier.verify({
    candidate: decision.regressionProvenance,
    item,
    checkoutDir,
    targetBranch: git.targetBranch,
    reviewedCommitShas:
      item.kind === "pull_request"
        ? [git.mainSha, pullHeadShaFromContext(context) ?? undefined]
        : [git.mainSha],
  });
  // Missing local history is incomplete proof. Keep a generic preliminary
  // assessment, if any, but never hydrate history or name a predecessor.
  return {
    ...decision,
    regressionProvenance,
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const reportOrchestration = createReportOrchestration({
  collectItemContext,
  ...contextHydration,
  ...repositoryPaths,
  defaultRootCauseCluster,
  ensureDir,
  ...repositoryLinks,
  ...statusContext,
  ghJson,
  ghObservedMutationCommand,
  ...githubContext,
  GitHubRuntimeBudgetError,
  hasUsableCloseComment: (...args) => hasUsableCloseComment(...args),
  isFresh,
  isImplementationCloseReason: (...args) => isImplementationCloseReason(...args),
  isMaintainerAuthored,
  isVerifiedFixedCloseReason,
  itemSnapshotHash,
  jsonFrontMatterValue: (...args) => jsonFrontMatterValue(...args),
  labelNames,
  normalizeLabelName,
  pullRequestHeadActivity: applyGuards.pullRequestHeadActivity,
  numberOrUndefined,
  parseGitHubItemRef,
  pullHeadShaFromContext: (...args) => pullHeadShaFromContext(...args),
  repairLoopPassModeFromReport: (...args) => repairLoopPassModeFromReport(...args),
  reviewAutomationMarkersFromReport: (...args) => reviewAutomationMarkersFromReport(...args),
  reviewStructuralPullStateFromContext: (...args) => reviewStructuralPullStateFromContext(...args),
  reviewVersionMarkerFromReport: (...args) => reviewVersionMarkerFromReport(...args),
  ROOT,
  runtimeBudgetExceeded: (...args) => runtimeBudgetExceeded(...args),
  targetProfile,
  targetRepo,
  timeoutWithinRuntimeBudget: (...args) => timeoutWithinRuntimeBudget(...args),
  validateCloseDecision: (...args) => validateCloseDecision(...args),
  workStatusForDecision: (...args) => workStatusForDecision(...args),
});
export const {
  contextHasNonAutomationActivityAfterForTest,
  labelJustificationsMarkdownForTest,
  pullRequestFilePathsFromContextForTest,
  renderReviewCommentFromReport,
  renderReviewContextBudgetForTest,
  renderWorkPlanFromReport,
  reviewActionForDecision,
  reviewContextLedgerForTest,
} = reportOrchestration;
const { syncWorkPlanFromReport, workPlanPathForReport } = reportOrchestration;
const { backfillReviewRecordsCommand } = createReviewRecordBackfill(reportOrchestration);

const labelMutations = createLabelMutationOperations({ ghJson, ghObservedMutationCommand });
const labelSyncOperations = createLabelSyncOperations(labelMutations);

export {
  staleVersionBugDecisionBlockReason,
  unsponsoredFeatureDecisionBlockReason,
  validateCloseDecision,
};

const reviewCommentWorkflow = createReviewCommentWorkflow({
  root: ROOT,
  targetRepo,
  heldReviewStartStatusCommentResult,
  gitHubRuntimeBudgetError: GitHubRuntimeBudgetError,
  ghObservedMutationCommand,
  ghPaged,
  reviewCommentBodyDigest,
  parseGitHubItemRef,
  ensureDir,
  ...reportOrchestration,
  removeIssueLabel: labelMutations.removeIssueLabel,
  markdownLink,
});
export const {
  canPatchReviewComment,
  coverageProofRetryExhaustedRuntimeBudget,
  isCodexReviewCommentBody,
  newReviewStartLeaseOwnerForTest,
  recordedLabelSyncCoversUpdate,
  removeCurrentCursorTraceItem,
  renderReviewStartStatusComment,
  reviewArtifactDestination,
  reviewStartLeaseWinnerCommentIdForTest,
  runtimeBudgetExceeded,
  shouldPreserveReviewStartLease,
  timeoutWithinRuntimeBudget,
  withReviewStartStatusLease,
} = reviewCommentWorkflow;
const { fetchIssueReviewComments, writeCommentPayload } = reviewCommentWorkflow;

const planCommand = createPlanCommand({
  defaultBatchSize: DEFAULT_PLAN_BATCH_SIZE,
  defaultItemsDir,
  defaultShardCount: DEFAULT_PLAN_SHARD_COUNT,
  fetchPlannedPrActivityRevisions,
  planCandidates,
  repoFromArgs,
  reviewPolicyHash,
  targetProfile,
});

const buildLocalRangeReview = createLocalRangeReviewer({
  run,
  pullCommitContentRevision,
  reviewCommentContentRevision,
});

export function buildLocalRangeReviewForTest(
  targetDir: string,
  repo: string,
  baseRef: string,
): { item: Item; context: ItemContext; baseSha: string; headSha: string } {
  return buildLocalRangeReview(targetDir, repo, baseRef);
}

const reviewActionLedger = createReviewActionLedger({
  root: ROOT,
  targetRepo,
  repoRelativePath,
  isRuntimeBudgetError: (error) => error instanceof GitHubRuntimeBudgetError,
});
export const { actionLedgerFailureDisposition } = reviewActionLedger;
const { actionLedgerItemKey } = reviewActionLedger;

const commandOperations = createCommandOperations({
  ...reviewActionLedger,
  applyDecisionsCommandInner: (...args) => applyDecisionsCommandInner(...args),
  artifactTargetIsOpen,
  codexFailureReason,
  ...reportOrchestration,
  ...repositoryPaths,
  ensureDir,
  ...gitHubRuntime,
  ...reviewCommentWorkflow,
  fetchItem,
  fetchOpenItemNumbers,
  ghJson,
  ghPaged,
  ghRawOnceWithCheckpoint,
  ghWithRetry,
  GitHubDispatchError,
  itemSourceRevisionSha256,
  reconcileFolders: (...args) => reconcileFolders(...args),
  repoFromArgs,
  repoRelativePath,
  reviewActionLedger,
  ROOT,
  targetRepo,
});
export const {
  applyActionEventDisposition,
  applyRuntimeBudgetForTest,
  applyRuntimeBudgetYieldResultsForTest,
  enforceExpectedIssueSourceRevisionForTest,
  preserveFailedReviewRetryMetadataForTest,
  reviewCommentPublicationEventDisposition,
  reviewRetryActionDisposition,
  reviewRetryActionNeedsItemEventForTest,
  reviewRetryBatchEventDisposition,
  reviewRetryBusinessIdempotencyIdentityForTest,
} = commandOperations;
const {
  applyArtifactsCommand,
  applyDecisionsCommand,
  enforceExpectedIssueSourceRevision,
  failedReviewRetryMarkdownWithState,
  failedReviewRetryStatePath,
  readFailedReviewRetryState,
  reserveReviewLeaseCommand,
  expireReviewLeaseCommand,
  retryFailedReviewsCommand,
} = commandOperations;

const { reviewCommand } = createReviewCommandWorkflow({
  ghJson,
  existingReview,
  reportFileName,
  ...reviewActionLedger,
  get activeReviewMutationRunner() {
    return githubExecution.activeReviewMutationRunner;
  },
  set activeReviewMutationRunner(value: MutationRunner | null) {
    githubExecution.activeReviewMutationRunner = value;
  },
  attachFixedPullRequest,
  verifyRegressionProvenance,
  ...contextHydration,
  buildLocalRangeReview,
  ...reviewRuntime,
  collectItemContext,
  ...reviewCommentWorkflow,
  pullHeadShaFromContext,
  reviewStructuralPullStateFromContext,
  DEFAULT_PLAN_BATCH_SIZE,
  defaultItemsDir,
  enforceExpectedIssueSourceRevision,
  ensureDir,
  exactLocalReviewNoCandidateError,
  fetchReviewStructuralRecord,
  isBulkFilerExemptAuthorAssociation,
  isBulkFilerExemptRepositoryPermission,
  isSuppliedReviewStartLease,
  itemContentDigest,
  itemSnapshotHash,
  ...reportOrchestration,
  repoFromArgs,
  reviewLeaseStillMatchesContext,
  reviewPolicyHash,
  selectCandidates,
  suppliedReviewStartLeaseFromArgs,
  targetRepo,
});

const { applyDecisionsCommandInner } = createApplyDecisionWorkflow({
  ...applyGuards,
  actionLedgerItemKey,
  get activeApplyMutationRunner() {
    return githubExecution.activeApplyMutationRunner;
  },
  set activeApplyMutationRunner(value: MutationRunner | null) {
    githubExecution.activeApplyMutationRunner = value;
  },
  ...labelMutations,
  ...labelSyncOperations,
  ...reportOrchestration,
  applyBlockingProtectedLabels,
  applyKindArg,
  ApplyMutationReviewGuardError,
  applyProtectedLabelReason,
  ...commandOperations,
  authorPrBudgetAgeSkipReason,
  ...contextHydration,
  CLAWSWEEPER_BOT_AUTHORS,
  ...reviewCommentWorkflow,
  freshPullRequestReviewHead,
  pullHeadShaFromContext,
  stalePullRequestReviewComment,
  stalePullRequestReviewHead,
  closeReasonApplyAgeSkipReason,
  closeReasonEnabled,
  closeReasonFilterText,
  closeReasonsArg,
  collectItemContext,
  ...repositoryPaths,
  ensureDir,
  ...gitHubRuntime,
  fetchItem,
  fetchReviewedPrActivityCursor,
  ghJson,
  guardedOpenApplyProofFields,
  isBulkFilerExemptAuthorAssociation,
  isExactEventSourceRevisionChange,
  itemSnapshotHash,
  reviewCommentBodyDigest,
  isMaintainerAuthorAssociation,
  implementedOnMainPullRequestProvenanceApplyBlock,
  isVerifiedFixedCloseReason,
  mutationErrorMessage,
  normalizeAuthorAssociation,
  normalizeLabelName,
  PR_CLOSE_COVERAGE_PROOF_SCHEMA_PATH,
  prCloseCoverageProofPromptTemplate,
  repoFromArgs,
  reportEntriesForDir,
  ROOT,

  targetRepo,
  validateCloseDecision,
});

function artifactTargetIsOpen(number: number, openNumbers: Set<number> | null): boolean {
  if (openNumbers) return openNumbers.has(number);
  return fetchItem(number).state === "open";
}

function reportEntriesForDir(dir: string, itemNumbers?: ReadonlySet<number>): ReportEntry[] {
  return markdownFiles(dir)
    .filter((name) => !itemNumbers || itemNumbers.has(numberForMarkdownFile(name)))
    .map((name) => {
      const path = join(dir, name);
      const markdown = readFileSync(path, "utf8");
      return {
        name,
        number: numberForMarkdownFile(name),
        path,
        repo: markdownRepository(markdown, path),
        markdown,
      };
    });
}

const dashboardAudit = createDashboardAudit({
  ...reviewPlanning,
  applyBlockingProtectedLabels,
  applyHealthStatusArg,
  ...sweepStatus,
  ...statusContext,
  ...repositoryPaths,
  ensureDir,
  ghJson,
  isMaintainerAuthored,
  isProtectedItem,
  ...repositoryLinks,
  repoFromArgs,
  repoRelativePath,
  reportEntriesForDir,
  ROOT,
  shouldPlanItem,
  syncWorkPlanFromReport,
  targetProfile,
  targetRepo,
  withTargetProfile,
  workPlanPathForReport,
});
export const {
  auditFromSnapshot,
  auditHasStrictFailures,
  auditHealthSection,
  dashboardClosedAt,
  formatRecentClosedRows,
} = dashboardAudit;
const {
  auditCommand,
  jsonFrontMatterValue,
  reconcileCommand,
  reconcileFolders,
  statusCommand,
  updateDashboard,
  workStatusForDecision,
} = dashboardAudit;

function applyHealthStatusArg(args: Args): Record<string, unknown> | undefined {
  const filePath = stringArg(args.apply_health_file, "");
  const jsonText = stringArg(args.apply_health_json, "");
  if (filePath && jsonText) {
    throw new Error("--apply-health-file and --apply-health-json are mutually exclusive");
  }
  const text = filePath ? readFileSync(resolve(filePath), "utf8") : jsonText;
  if (!text.trim()) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("apply health status must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function checkCommand(): void {
  JSON.parse(reviewDecisionSchemaText());
  if (!existsSync(join(ROOT, ".github", "workflows", "sweep.yml")))
    throw new Error("Missing workflow");
  console.log("ok");
}

function dashboardCommand(args: Args): void {
  repoFromArgs(args);
  updateDashboard(
    resolve(stringArg(args.items_dir, defaultItemsDir())),
    resolve(stringArg(args.closed_dir, defaultClosedDir())),
  );
}

const liveProofAttachDependencies = {
  reportLiveProofPlan,
  reviewSections: REVIEW_SECTIONS,
  renderReviewCommentFromReport: reportOrchestration.renderReviewCommentFromReport,
  markedReviewCommentBody: reviewCommentWorkflow.markedReviewCommentBody,
  upsertReviewComment: reviewCommentWorkflow.upsertReviewComment,
  selectTarget: (repo: string) => setTargetRepo(repo),
};

const liveProofCommands = createLiveProofCommands({
  repositoryProfileFor,
  reportLiveProofPlan,
  parseLiveProofPlan: (value) => reviewDecisionParser.parseLiveProofPlan(value, "liveProofPlan"),
  attach: liveProofAttachDependencies,
});

const liveProofCommand = liveProofCommands.liveProofCommand;

async function liveProofAttachCommand(args: Args): Promise<void> {
  await liveProofCommands.liveProofAttachCommand(args);
}

function liveProofReviewCommand(args: Args): void {
  const repo = stringArg(args.repo ?? args.target_repo, "").trim();
  const recordsDir = stringArg(args.records_dir, "").trim();
  const checkoutPath = stringArg(args.checkout, "").trim();
  const outputRoot = stringArg(args.output, "").trim();
  const itemNumbers = itemNumbersArg(args.item_numbers, args.item ?? args.item_number);
  if (!repo || !recordsDir || !checkoutPath || !outputRoot || itemNumbers.length === 0) {
    throw new Error(
      "live-proof-review requires --repo, --records-dir, --checkout, --output, and --item-numbers",
    );
  }
  const options = {
    checkoutPath,
    entrypoint: join(ROOT, "dist", "clawsweeper.js"),
    itemNumbers,
    outputRoot,
    recordsDir,
    repo,
  };
  const dependencies = {
    materializePullRequestReviewTree: (
      options: Parameters<typeof contextHydration.materializePullRequestReviewTree>[0],
    ) =>
      // The synchronous metadata resolver reads the active target; restore it before execution.
      withTargetProfile(repositoryProfileFor(repo), () =>
        contextHydration.materializePullRequestReviewTree(options),
      ),
    reportLiveProofPlan,
    repositoryProfileFor,
  };
  const result = boolArg(args.inspect)
    ? inspectReviewLiveProofs(options, dependencies)
    : executeReviewLiveProofs(options, dependencies);
  console.log(JSON.stringify(result));
}

async function liveProofPublishArtifactsCommand(args: Args): Promise<void> {
  const artifactDir = stringArg(args.artifact_dir, "").trim();
  if (!artifactDir) throw new Error("live-proof-publish-artifacts requires --artifact-dir");
  const result = await publishReviewLiveProofArtifacts(artifactDir, {
    ...liveProofAttachDependencies,
    log: () => {},
    fetchPullRequest: async () => {
      throw new Error("merged live-proof publication must not perform a live-head lookup");
    },
  }).catch(() => ({ status: "retryable_failure" }) as const);
  console.log(JSON.stringify(result));
  if (result.status !== "published") process.exitCode = 1;
}

function liveProofCommentCommand(args: Args): void {
  const recordPath = stringArg(args.record, "");
  if (recordPath) {
    const markdown = readFileSync(resolve(recordPath), "utf8");
    const repo = frontMatterValue(markdown, "repository");
    if (repo) setTargetRepo(repo);
  }
  liveProofCommands.liveProofCommentCommand(args);
}

const COMMAND_HANDLERS: Readonly<Record<string, CommandHandler<Args>>> = {
  plan: planCommand,
  "reserve-review-lease": reserveReviewLeaseCommand,
  "expire-review-lease": expireReviewLeaseCommand,
  review: reviewCommand,
  "retry-failed-reviews": retryFailedReviewsCommand,
  "apply-artifacts": applyArtifactsCommand,
  "live-proof": liveProofCommand,
  "live-proof-review": liveProofReviewCommand,
  "live-proof-attach": liveProofAttachCommand,
  "live-proof-comment": liveProofCommentCommand,
  "live-proof-publish-artifacts": liveProofPublishArtifactsCommand,
  "apply-decisions": applyDecisionsCommand,
  "backfill-review-records": backfillReviewRecordsCommand,
  "publish-action-events": publishActionEventsCommand,
  "publish-action-event-paths": publishActionEventPathsCommand,
  audit: auditCommand,
  reconcile: reconcileCommand,
  dashboard: dashboardCommand,
  status: statusCommand,
  "assist-target": assistResolveTargetCommand,
  assist: assistGenerateCommand,
  "assist-generate": assistGenerateCommand,
  "assist-validate": assistValidateArtifactCommand,
  "assist-publish": assistPublishCommand,
  check: checkCommand,
  "finalize-action-events": finalizeActionEventsCommand,
};

export async function main(
  argv = process.argv.slice(2),
  dependencies: {
    flushWorkflowActionEvents?: typeof flushWorkflowActionEvents;
  } = {},
): Promise<void> {
  const args = parseArgs(argv);
  const command = args._[0] ?? "review";
  const flushActionEvents = dependencies.flushWorkflowActionEvents ?? flushWorkflowActionEvents;
  if (!process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION) {
    process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION = sha256(stableJson({ command, args })).slice(
      0,
      16,
    );
  }
  let commandFailed = false;
  let commandError: unknown;
  try {
    await dispatchCommand(command, args, COMMAND_HANDLERS);
  } catch (error) {
    commandFailed = true;
    commandError = error;
  }
  try {
    const shardPaths = await flushActionEvents(ROOT);
    if (shardPaths.length > 0) {
      console.error(
        `[action-ledger] finalized ${shardPaths.length} immutable workflow shard${
          shardPaths.length === 1 ? "" : "s"
        }`,
      );
    }
  } catch (error) {
    if (commandFailed) {
      console.error(
        `[action-ledger] best-effort finalization failed after command failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } else if (isExplicitActionLedgerCommand(command)) {
      commandFailed = true;
      commandError = error;
    } else {
      console.error(
        `[action-ledger] best-effort finalization failed after successful ${command}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (commandFailed) throw commandError;
}
