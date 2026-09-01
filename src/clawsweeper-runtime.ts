#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flushWorkflowActionEvents } from "./action-ledger-runtime.js";
import { boolArg, itemNumbersArg, parseArgs, stringArg, type Args } from "./clawsweeper-args.js";
import { dispatchCommand, type CommandHandler } from "./clawsweeper-command-dispatch.js";
import { createDecisionParser } from "./clawsweeper-decision-parser.js";
import { runText, SWEEPER_COMMAND_MAX_BUFFER_BYTES } from "./command.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import {
  DEFAULT_TARGET_REPO,
  normalizeRepo,
  repositoryProfileFor,
  type RepositoryProfile,
} from "./repository-profiles.js";
import { reviewPullChecksDigestParts } from "./review-checks-digest.js";
import {
  reviewStructuralQuery,
  reviewStructuralRecordFromGraphql,
  type ReviewStructuralRecord,
} from "./review-structural-cache.js";
import { stableJson } from "./stable-json.js";

import { createActionCommands } from "./clawsweeper-action-commands.js";
import { createApplyDecisionWorkflow } from "./clawsweeper-apply-decision-workflow.js";
import { implementedOnMainCloseProvenanceBlock } from "./clawsweeper-apply-close-execution.js";
import { createApplyGuards } from "./clawsweeper-apply-guards.js";
import { createAssistWorkflow } from "./clawsweeper-assist.js";
import { isDocsPath } from "./clawsweeper-change-detection.js";
import { createCloseDecisionWorkflow } from "./clawsweeper-close-decision.js";
import { createCommandOperations } from "./clawsweeper-command-operations.js";
import { createContextHydration } from "./clawsweeper-context-hydration.js";
import { createDashboardAudit } from "./clawsweeper-dashboard-audit.js";
import { createGitHubContext } from "./clawsweeper-github-context.js";
import { createGitHubExecution } from "./clawsweeper-github-execution.js";
import { createGitHubRuntime } from "./clawsweeper-github-runtime.js";
import { exactPublicationPublicReadToken } from "./github-public-read.js";
import { createItemContext } from "./clawsweeper-item-context.js";
import {
  applyBlockingProtectedLabels,
  applyKindArg,
  applyProtectedLabelReason,
  asRecord,
  authorPrBudgetAgeSkipReason,
  closeReasonApplyAgeSkipReason,
  closeReasonEnabled,
  closeReasonFilterText,
  closeReasonsArg,
  isBulkFilerExemptAuthorAssociation,
  isBulkFilerExemptRepositoryPermission,
  isMaintainerAuthorAssociation,
  isMaintainerAuthored,
  isOlderThanDays,
  isProtectedItem,
  isVerifiedFixedCloseReason,
  labelNames,
  login,
  normalizeAuthorAssociation,
  normalizeLabelName,
  obsoleteFixPrAgeSkipReason,
  protectedLabels,
  shouldPlanItem,
  staleVersionBugAgeSkipReason,
  unconfirmedProductDirectionAgeSkipReason,
  unsponsoredFeatureAgeSkipReason,
} from "./clawsweeper-item-policy.js";
import { createLabelPolicy } from "./clawsweeper-label-policy.js";
import { createRealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import { createLiveProofCommands } from "./live-proof/commands.js";
import { publishReviewLiveProofArtifacts } from "./live-proof/publication-artifacts.js";
import { executeReviewLiveProofs, inspectReviewLiveProofs } from "./live-proof/review-artifacts.js";
import { createRepositoryLinks } from "./clawsweeper-links.js";
import { createLocalRangeReviewer } from "./clawsweeper-local-review.js";
import { createPlanCommand } from "./clawsweeper-plan-command.js";
import {
  DEFAULT_REASONING_EFFORT,
  EVENT_GUARDED_OPEN_ACTIONS,
  FRESH_DAYS,
  REVIEW_SECTIONS,
  REVIEW_POLICY_VERSION,
} from "./clawsweeper-policy.js";
import { createRecordMetadata } from "./clawsweeper-record-metadata.js";
import { createRegressionProvenanceVerifier } from "./clawsweeper-regression-provenance.js";
import { createReportHelpers } from "./clawsweeper-report-helpers.js";
import { createReportOrchestration } from "./clawsweeper-report-orchestration.js";
import { createReportParser } from "./clawsweeper-report-parser.js";
import { createRepositoryPaths } from "./clawsweeper-repository-paths.js";
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
import { createReviewPresentation } from "./clawsweeper-review-presentation.js";
import { createReviewRuntime } from "./clawsweeper-review-runtime.js";
import { createSourceRevisionTools } from "./clawsweeper-source-revision.js";
import {
  currentClosingPullRequestReferenceFromIssueTimeline,
  createStatusContext,
  linkedIssueNumbersForImplementationProvenance,
  linkedIssueNumbersForPullRequestBody,
} from "./clawsweeper-status-context.js";
import { createSweepStatus } from "./clawsweeper-sweep-status.js";
import type {
  Decision,
  DecisionNormalizationItem,
  Evidence,
  GitInfo,
  Item,
  ItemContext,
  MantisRecommendation,
  MutationRunner,
  ReportEntry,
  SecurityConcern,
} from "./clawsweeper-types.js";
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
  configSurfaceChangeFromPullFilesForTest,
  dataModelChangeFromPullFilesForTest,
  sqliteSchemaChangeFromPullFilesForTest,
} from "./clawsweeper-change-detection.js";
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_REPO = "openclaw/clawsweeper";
const RECORDS_ROOT = join(ROOT, "records");
let activeRepositoryProfile = repositoryProfileFor(
  process.env.CLAWSWEEPER_TARGET_REPO ?? DEFAULT_TARGET_REPO,
);
const REVIEW_ITEM_PROMPT_PATH = join(ROOT, "prompts", "review-item.md");
const CLAWSWEEPER_DECISION_SCHEMA_PATH = join(ROOT, "schema", "clawsweeper-decision.schema.json");
const MATURITY_STABLE_SHORTLIST_SCRIPT_PATH = join(
  ROOT,
  "scripts",
  "maturity-stable-shortlist.mjs",
);
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

function targetProfile(): RepositoryProfile {
  return activeRepositoryProfile;
}

function targetRepo(): string {
  return activeRepositoryProfile.targetRepo;
}

const repositoryLinks = createRepositoryLinks({
  reportRepo: REPORT_REPO,
  normalizeRepo,
  targetProfile,
  targetRepo,
});
const {
  docsPageUrl,
  fileUrl,
  isCommitSha,
  latestFileUrl,
  linkedSha,
  markdownLink,
  reportUrl,
  splitFileAndLine,
} = repositoryLinks;

function setTargetRepo(targetRepoName: string): RepositoryProfile {
  activeRepositoryProfile = repositoryProfileFor(targetRepoName);
  return activeRepositoryProfile;
}

function targetRepoInput(args: Args): string {
  return stringArg(
    args.target_repo,
    process.env.CLAWSWEEPER_TARGET_REPO ?? process.env.TARGET_REPO ?? DEFAULT_TARGET_REPO,
  );
}

function repoFromArgs(args: Args): RepositoryProfile {
  return setTargetRepo(targetRepoInput(args));
}

function withTargetProfile<T>(profile: RepositoryProfile, fn: () => T): T {
  const previousProfile = activeRepositoryProfile;
  activeRepositoryProfile = profile;
  try {
    return fn();
  } finally {
    activeRepositoryProfile = previousProfile;
  }
}

const sweepStatus = createSweepStatus({
  ensureDir,
  readSweepStatusSummary: (...args) => readSweepStatusSummary(...args),
  ROOT,
  targetProfile,
});
export const { sweepStatusApplyHealthForTest } = sweepStatus;
const repositoryPaths = createRepositoryPaths({
  frontMatterValue: (...args) => frontMatterValue(...args),
  RECORDS_ROOT,
  repoRelativePath,
  ROOT,
  targetProfile,
  targetRepo,
});
const {
  defaultClosedDir,
  defaultItemsDir,
  markdownRepository,
  parseReportFileName,
  reportFileName,
} = repositoryPaths;

function evidenceEntry(options: Partial<Evidence> & Pick<Evidence, "label" | "detail">): Evidence {
  return {
    label: options.label,
    detail: options.detail,
    file: options.file ?? null,
    line: options.line ?? null,
    command: options.command ?? null,
    sha: options.sha ?? null,
  };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number | undefined } = {},
): string {
  return runText(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env,
    maxBuffer: SWEEPER_COMMAND_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: options.timeoutMs,
    trim: "both",
  });
}

const gitHubRuntime = createGitHubRuntime({
  ROOT,
  run,
  targetRepo,
});
export const { untrustedCodexEnvForTest } = gitHubRuntime;
const { GitHubRuntimeBudgetError, untrustedCodexEnv } = gitHubRuntime;

const githubExecution = createGitHubExecution({
  ROOT,
  gitHubRuntime,
  labelAlreadyExistsError: (error) => labelAlreadyExistsError(error),
});
export const { classifyGitHubDispatchResultForTest, observedGitHubMutationAttemptsForTest } =
  githubExecution;
const {
  ApplyMutationReviewGuardError,
  GitHubDispatchError,
  ghJson,
  ghJsonLines,
  ghJsonOnce,
  ghObservedMutationCommand,
  ghRawOnceWithCheckpoint,
  ghWithRetry,
  mutationErrorMessage,
} = githubExecution;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const CLAWSWEEPER_BOT_AUTHORS = new Set(
  [
    "clawsweeper",
    "clawsweeper[bot]",
    "openclaw-clawsweeper[bot]",
    process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN,
  ]
    .filter((login): login is string => typeof login === "string" && login.length > 0)
    .map((login) => login.toLowerCase()),
);

const githubContext = createGitHubContext({ ghJson, ghWithRetry, targetRepo });
export const {
  ghPagedContextWindow,
  ghPagedLinkHeaderContextWindow,
  githubContextWindowPlan,
  githubLinkLastPageNumber,
  githubPaginatedPath,
} = githubContext;
const { fetchReviewedPrActivityCursor, ghPaged, githubCount } = githubContext;

const sourceRevisionTools = createSourceRevisionTools({
  asRecord,
  clawsweeperBotAuthors: CLAWSWEEPER_BOT_AUTHORS,
  githubCount,
  isClawSweeperComment: (value) => isClawSweeperComment(value),
  login,
  normalizeAuthorAssociation,
  normalizeLabelName,
  pullHeadShaFromContext: (context) => pullHeadShaFromContext(context),
  sha256,
  stringOrUndefined,
});
export const {
  isExactEventSourceRevisionChange,
  itemContentDigestForTest,
  itemSourceRevisionSha256ForTest,
  reviewCommentContentRevisionForTest,
} = sourceRevisionTools;
const {
  isIgnorableSourceRevisionLabel,
  itemContentDigest,
  itemSnapshotHash,
  itemSourceRevisionSha256,
  pullCommitContentRevision,
  reviewCommentBodyDigest,
  reviewCommentContentRevision,
} = sourceRevisionTools;

function reviewPolicyHash(options: {
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: string;
  serviceTier?: string;
}): string {
  const policyTargetRepo = targetRepo();
  return sha256(
    stableJson({
      version: REVIEW_POLICY_VERSION,
      freshDays: FRESH_DAYS,
      // Maintainer decision 2026-07-17: the model is deliberately NOT part of
      // review-policy identity. Baking it in made every model change invalidate
      // all stored reviews (a fleet-wide re-review wave), which makes model
      // swaps untestable in production. Model changes now roll through the
      // normal review cadence instead; bump REVIEW_POLICY_VERSION explicitly
      // when a full re-review is actually wanted. The sentinel migrates all
      // hashes once, riding the 2026-07 prompt-change wave already in flight.
      model: "model-excluded-2026-07",
      reasoningEffort: options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      sandboxMode: options.sandboxMode ?? "read-only",
      // Service tier changes latency, never decisions. Pinned to the historical
      // hash value so tier changes cannot mark every stored review policy-stale
      // and trigger a fleet-wide re-review wave.
      serviceTier: "",
      targetRepo: policyTargetRepo,
      ...(policyTargetRepo.toLowerCase() === "openclaw/openclaw"
        ? { openclawCodexSourceProvisioning: "v1" }
        : {}),
      repositoryProfile: targetProfile(),
      prompt: reviewPromptTemplate(),
      schema: reviewDecisionSchemaText(),
    }),
  ).slice(0, 16);
}

export function reviewPolicyHashForTest(
  options: {
    model?: string;
    reasoningEffort?: string;
    sandboxMode?: string;
    serviceTier?: string;
  } = {},
): string {
  return reviewPolicyHash(options);
}

const decisionParser = createDecisionParser({
  isMaintainerAuthorAssociation,
  neutralizeOwnedSectionSpoofing: (...args) => neutralizeOwnedSectionSpoofing(...args),
  sanitizeArchitectureDiagram: (...args) => sanitizeArchitectureDiagram(...args),
});
const { defaultRootCauseCluster, parseGitHubItemRef } = decisionParser;

export function parseDecision(value: unknown, item?: DecisionNormalizationItem): Decision {
  return decisionParser.parseDecision(value, item);
}

const recordMetadata = createRecordMetadata({
  reportFileName,
  markdownRepository,
  isVerifiedFixedCloseReason,
  isOlderThanDays,
  timestampMs: (timestamp) => timestampMs(timestamp),
  pullHeadShaFromReport: (markdown) => pullHeadShaFromReport(markdown),
  reviewLeaseRevisionFromReport: (markdown) => reviewLeaseRevisionFromReport(markdown),
  lockedConversationApplyReason: (item) => lockedConversationApplyReason(item),
  markdownFiles,
  numberForMarkdownFile,
});
export const {
  applyDecisionPriority,
  effectiveReviewStatus: effectiveReviewStatusForTest,
  exactEventReviewLeaseDispositionForTest,
  failedReviewRetryEligibilityForTest,
  isInfrastructureFailedReviewForTest,
  reviewReportCanPromoteToCloseForTest,
  shouldSyncReviewComment,
} = recordMetadata;
const { frontMatterBoolean, frontMatterStringArray, frontMatterValue } = recordMetadata;

const reportParser = createReportParser({
  agentsPolicyStatusLine: (...args) => agentsPolicyStatusLine(...args),
  ...decisionParser,
  evidenceEntry,
  ...recordMetadata,
  isDocsOnlyPullRequestReport,
  isExternalPullRequestReport,
  markdownRepository,
  parseBoldListHeading: (...args) => parseBoldListHeading(...args),
  parseReviewFindingHeading: (...args) => parseReviewFindingHeading(...args),
  parseSecurityConcernHeading: (...args) => parseSecurityConcernHeading(...args),
  sectionLineValue: (...args) => sectionLineValue(...args),
  sectionList: (...args) => sectionList(...args),
  splitFileAndLine,
});
export const { reportLiveProofPlan, rootCauseClusterFromReportForTest } = reportParser;
export const reportLiveProofPlanForTest = reportLiveProofPlan;
const {
  reportEvidence,
  reportOverallCorrectness,
  reportAttachedLiveVerification,
  mergeRiskOptionsFromReport,
  reportReviewFindings,
  reportSecurityReview,
  reportRealBehaviorProof,
  reportPrRating,
} = reportParser;

const reportRealBehaviorProofPolicy = createRealBehaviorProofPolicy({
  ...recordMetadata,
  isDocsOnlyPullRequestReport,
  isExternalPullRequestReport,
  reportAttachedLiveVerification,
  reportRealBehaviorProof,
});

const labelPolicy = createLabelPolicy({
  asRecord,
  frontMatterValue,
  isAutomationReportAuthor,
  mergeRiskOptionsFromReport,
  reportOverallCorrectness,
  reportRealBehaviorProofPolicy,
  reportReviewFindings,
  reportSecurityReview,
  stringOrUndefined,
  timestampMs: (value) => timestampMs(value),
});
export const { featureShowcaseLabelsForTest, prStatusLabelsForTest, prStatusLabelSchemeForTest } =
  labelPolicy;
const { hasRepairLoopPauseLabel, prStatusLabelKindFromReport } = labelPolicy;

const applyGuards = createApplyGuards({
  asRecord,
  authorPrBudget: () => authorPrBudget(),
  authorPrBudgetAgeSkipReason,
  authorPrBudgetCloseEnabled: () => authorPrBudgetCloseEnabled(),
  ghJson: <T>(args: string[]): T =>
    ghJson<T>(
      exactPublicationPublicReadToken(args, targetRepo()) ? [...args, "--method", "GET"] : args,
    ),
  ghPaged: <T>(path: string): T[] => ghPaged<T>(path, { requireApp: true }),
  isMaintainerAuthorAssociation,
  isMaintainerAuthored,
  isOlderThanDays,
  labelNames,
  login,
  normalizeLabelName,
  obsoleteFixPrAgeSkipReason,
  obsoleteFixPrCloseEnabled: () => obsoleteFixPrCloseEnabled(),
  protectedLabels,
  quoteGitHubSearchTerm: (term) => quoteGitHubSearchTerm(term),
  reportPrRating,
  reportRealBehaviorProof,
  staleVersionBugAgeSkipReason,
  staleVersionBugCloseEnabled: () => staleVersionBugCloseEnabled(),
  stringOrUndefined,
  targetRepo,
  unconfirmedProductDirectionAgeSkipReason,
  unconfirmedProductDirectionCloseEnabled: () => unconfirmedProductDirectionCloseEnabled(),
  unsponsoredFeatureAgeSkipReason,
  unsponsoredFeatureCloseEnabled: () => unsponsoredFeatureCloseEnabled(),
});
const { resetGuardReadCache } = applyGuards;
export const {
  abandonedPrAgeSkipReason,
  issueRecentHumanCommentBlockReasonFromComments,
  stalledUnprovenPrAgeSkipReason,
} = applyGuards;
export function stalledUnprovenProofRequestBlockReason(
  ...args: Parameters<typeof applyGuards.stalledUnprovenProofRequestBlockReason>
): ReturnType<typeof applyGuards.stalledUnprovenProofRequestBlockReason> {
  resetGuardReadCache();
  return applyGuards.stalledUnprovenProofRequestBlockReason(...args);
}
const { prAutoCloseExemptDecisionReason, prAutoCloseExemptLabel } = applyGuards;

const contextHydration = createContextHydration({
  asRecord,
  CLAWSWEEPER_BOT_AUTHORS,
  ...repositoryPaths,
  displayTitle: (title) => displayTitle(title),
  ...recordMetadata,
  fetchIssueReviewComments: (number) => fetchIssueReviewComments(number),
  ghJson,
  ghJsonOnce,
  githubCount,
  GitHubRuntimeBudgetError,
  isAutomationReportAuthor,
  isBulkFilerExemptAuthorAssociation,
  isSafeGitBranchName: (branch) => isSafeGitBranchName(branch),
  labelNames,
  login,
  markdownFiles,
  normalizeAuthorAssociation,
  normalizeLabelName,
  numberForMarkdownFile,
  repoRelativePath,
  reportUrl,
  reviewCommentBodyDigest,
  ROOT,
  stringOrUndefined,
  targetRepo,
});
export const {
  authorPrBudget,
  authorPrBudgetCloseEnabled,
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
  obsoleteFixPrCloseEnabled,
  openClosingPullRequestApplyReason,
  previousClawSweeperReviewDigestFromReportForTest,
  referencingMergedPullRequestCandidatesForTest,
  referencingMergedPullRequestsForIssueForTest,
  relatedGitHubIssueSearchQueryForTest,
  relatedTitleSearchTerms,
  sameAuthorCounterpartApplyReason,
  staleVersionBugCloseEnabled,
  unconfirmedProductDirectionCloseEnabled,
  unsponsoredFeatureCloseEnabled,
  updateBulkFilerDetectedFrontMatterForTest,
} = contextHydration;
const {
  completePullChecksContext,
  isClawSweeperComment,
  pullChecksContext,
  pullFileTreeIdentity,
  quoteGitHubSearchTerm,
  structuralExternalRelationSensitivity,
} = contextHydration;

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

const reviewPlanning = createReviewPlanning({
  maxPlanShardCount: MAX_PLAN_SHARD_COUNT,
  targetRepo,
  ghJson,
  ghJsonLines,
  ...githubContext,
  itemSourceRevisionSha256,
  asRecord,
  normalizeAuthorAssociation,
  shouldPlanItem,
  ...recordMetadata,
  stringOrUndefined,
  pullHeadShaFromReport: (markdown) => pullHeadShaFromReport(markdown),
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
  timestampMs,
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
    const headSha = stringOrUndefined(asRecord(pull).headRefOid)?.trim().toLowerCase();
    if (!headSha) return null;
    const pullChecks = pullChecksContext(options.item.number, headSha);
    if (!completePullChecksContext(pullChecks)) return null;
    pullChecksDigest = sha256(stableJson(reviewPullChecksDigestParts(pullChecks)));
    options.onPullIdentity?.({
      baseSha: stringOrUndefined(asRecord(pull).baseRefOid)?.trim().toLowerCase() ?? "",
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
  asRecord,
  ...contextHydration,
  ...githubContext,
  ghJson,
  ...sourceRevisionTools,
  sha256,
  stringOrUndefined,
  targetRepo,
});

const reviewRuntime = createReviewRuntime({
  reviewItemPromptPath: REVIEW_ITEM_PROMPT_PATH,
  decisionSchemaPath: CLAWSWEEPER_DECISION_SCHEMA_PATH,
  maturityStableShortlistScriptPath: MATURITY_STABLE_SHORTLIST_SCRIPT_PATH,
  prCloseCoverageProofPromptPath: PR_CLOSE_COVERAGE_PROOF_PROMPT_PATH,
  targetRepo,
  evidenceEntry,
  run,
  untrustedCodexEnv,
  ghJson,
  asRecord,
  defaultRootCauseCluster,
  parseDecision,
  ensureDir,
  stringOrUndefined,
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
  reviewPromptTemplate,
  runCodexForTest,
} = reviewRuntime;
const { codexFailureReason, isSafeGitBranchName, prCloseCoverageProofPromptTemplate } =
  reviewRuntime;

const assistWorkflow = createAssistWorkflow({
  root: ROOT,
  asRecord,
  canPatchReviewComment: (comment) => canPatchReviewComment(comment),
  collectItemContext,
  ensureDir,
  fetchItem,
  ghJson,
  ghPaged,
  ghWithRetry,
  repoFromArgs,
  sha256,
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
  markdownRepository,
  ghJson,
  GitHubRuntimeBudgetError,
  asRecord,
  frontMatterValue,
  stringOrUndefined,
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
  decision: import("./clawsweeper-types.js").Decision,
  item: import("./clawsweeper-types.js").Item,
  context: import("./clawsweeper-types.js").ItemContext,
  checkoutDir: string,
  git: import("./clawsweeper-types.js").GitInfo,
): import("./clawsweeper-types.js").Decision {
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

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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

const reviewPresentation = createReviewPresentation({
  docsPageUrl,
  fileUrl,
  frontMatterStringArray,
  frontMatterValue,
  hasDispatchableMantisScenario,
  hasRepairLoopPauseLabel,
  isCommitSha,
  latestFileUrl,
  linkedSha,
  markdownLink,
  publicTableCell: (...args) => publicTableCell(...args),
  reportEvidence,
  reportRealBehaviorProofPolicy,
  securityConcernLocation,
  splitFileAndLine,
});
const { isSupportedMantisScenario, sentence, validMantisMaintainerComment } = reviewPresentation;

const reportOrchestration = createReportOrchestration({
  reportRealBehaviorProofPolicy,
  agentsPolicyStatusLine: (...args) => agentsPolicyStatusLine(...args),
  asRecord,
  ...reviewPresentation,
  collectItemContext,
  ...contextHydration,
  ...reportParser,
  ...repositoryPaths,
  defaultRootCauseCluster,
  ...recordMetadata,
  ensureDir,
  ...labelPolicy,
  ...repositoryLinks,
  ...statusContext,
  ghJson,
  ghObservedMutationCommand,
  ...githubContext,
  GitHubRuntimeBudgetError,
  hasUsableCloseComment: (...args) => hasUsableCloseComment(...args),
  isAutomationReportAuthor,
  isBulkFilerExemptAuthorAssociation,
  isBulkFilerExemptRepositoryPermission,
  isDocsOnlyPullRequestReport,
  isExternalPullRequestReport,
  isFresh,
  isImplementationCloseReason: (...args) => isImplementationCloseReason(...args),
  isIssueAdvisoryLabel: (...args) => isIssueAdvisoryLabel(...args),
  isMaintainerAuthored,
  isOlderThanDays,
  issueAdvisoryLabelStateFromReport: (...args) => issueAdvisoryLabelStateFromReport(...args),
  isVerifiedFixedCloseReason,
  itemSnapshotHash,
  jsonFrontMatterValue: (...args) => jsonFrontMatterValue(...args),
  labelNames,
  labelPolicy,
  ...applyGuards,
  neutralizeOwnedSectionSpoofing: (...args) => neutralizeOwnedSectionSpoofing(...args),
  nextImpactLabels: (...args) => nextImpactLabels(...args),
  nextIssueAdvisoryLabels: (...args) => nextIssueAdvisoryLabels(...args),
  nextMaturityLabels: (...args) => nextMaturityLabels(...args),
  nextMergeRiskLabels: (...args) => nextMergeRiskLabels(...args),
  nextPriorityLabels: (...args) => nextPriorityLabels(...args),
  nextRealBehaviorProofMediaLabels: (...args) => nextRealBehaviorProofMediaLabels(...args),
  nextRealBehaviorProofSufficientLabels: (...args) =>
    nextRealBehaviorProofSufficientLabels(...args),
  nextTelegramVisibleProofLabels: (...args) => nextTelegramVisibleProofLabels(...args),
  normalizeLabelName,
  numberOrUndefined,
  parseGitHubItemRef,
  protectedLabels,
  publicTableCell: (...args) => publicTableCell(...args),
  pullHeadShaFromContext: (...args) => pullHeadShaFromContext(...args),
  pullHeadShaFromReport: (...args) => pullHeadShaFromReport(...args),
  repairLoopPassModeFromReport: (...args) => repairLoopPassModeFromReport(...args),
  repoRelativePath,
  reviewAutomationMarkersFromReport: (...args) => reviewAutomationMarkersFromReport(...args),
  reviewStructuralPullStateFromContext: (...args) => reviewStructuralPullStateFromContext(...args),
  reviewVersionMarkerFromReport: (...args) => reviewVersionMarkerFromReport(...args),
  ROOT,
  runtimeBudgetExceeded: (...args) => runtimeBudgetExceeded(...args),
  sanitizeArchitectureDiagram: (...args) => sanitizeArchitectureDiagram(...args),
  sectionLineValue: (...args) => sectionLineValue(...args),
  securityConcernLocation,
  sha256,
  stringOrUndefined,
  targetProfile,
  targetRepo,
  timeoutWithinRuntimeBudget: (...args) => timeoutWithinRuntimeBudget(...args),
  timestampMs,
  validateCloseDecision: (...args) => validateCloseDecision(...args),
  workStatusForDecision: (...args) => workStatusForDecision(...args),
});
export const {
  contextHasNonAutomationActivityAfterForTest,
  impactLabelSchemeForTest,
  impactLabelsForTest,
  isGitHubLabelAlreadyExistsErrorForTest,
  isGitHubLabelCapacityErrorForTest,
  isMissingGitHubLabelErrorForTest,
  issueAdvisoryLabelsForTest,
  labelJustificationsMarkdownForTest,
  maturityLabelSchemeForTest,
  maturityLabelsForTest,
  mergeRiskLabelSchemeForTest,
  mergeRiskLabelsForTest,
  prRatingLabelSchemeForTest,
  prRatingLabelsForTest,
  priorityLabelSchemeForTest,
  priorityLabelsForTest,
  pullRequestFilePathsFromContextForTest,
  realBehaviorProofMediaLabelsForTest,
  realBehaviorProofSufficientLabelsForTest,
  renderLiveProofReportSection: renderLiveProofReportSectionForTest,
  renderReviewCommentFromReport,
  renderReviewContextBudgetForTest,
  renderWorkPlanFromReport,
  reviewActionForDecision,
  reviewContextLedgerForTest,
  sanitizePublicSelfReferences,
  syncBulkFilerLabelForTest,
  telegramVisibleProofLabelsForTest,
} = reportOrchestration;
const {
  OWNED_REVIEW_SECTION_HEADINGS,
  labelSynchronization,
  parseBacktickLocation,
  pullRequestFilePathsFromReport,
  syncWorkPlanFromReport,
  workPlanPathForReport,
} = reportOrchestration;

function isDocsOnlyPullRequestReport(markdown: string): boolean {
  if (frontMatterValue(markdown, "type") !== "pull_request") return false;
  if (frontMatterBoolean(markdown, "pull_files_truncated")) return false;
  const files = pullRequestFilePathsFromReport(markdown);
  return files.length > 0 && files.every(isDocsPath);
}

const {
  isIssueAdvisoryLabel,
  issueAdvisoryLabelStateFromReport,
  labelAlreadyExistsError,
  nextImpactLabels,
  nextIssueAdvisoryLabels,
  nextMaturityLabels,
  nextMergeRiskLabels,
  nextPriorityLabels,
  nextRealBehaviorProofMediaLabels,
  nextRealBehaviorProofSufficientLabels,
  nextTelegramVisibleProofLabels,
  removeIssueLabel,
} = labelSynchronization;

function isAutomationReportAuthor(author: string | undefined): boolean {
  return Boolean(author && (/\[bot\]$/i.test(author) || author.startsWith("app/")));
}

function isExternalPullRequestReport(markdown: string): boolean {
  if (frontMatterValue(markdown, "type") !== "pull_request") return false;
  const authorAssociation = frontMatterValue(markdown, "author_association");
  if (!authorAssociation) return false;
  if (isMaintainerAuthorAssociation(authorAssociation)) return false;
  return !isAutomationReportAuthor(frontMatterValue(markdown, "author"));
}

function hasDispatchableMantisScenario(recommendation: MantisRecommendation): boolean {
  return (
    recommendation.status === "recommended" &&
    isSupportedMantisScenario(recommendation.scenario) &&
    Boolean(validMantisMaintainerComment(recommendation))
  );
}

const reportHelpers = createReportHelpers({
  OWNED_REVIEW_SECTION_HEADINGS,
  parseBacktickLocation,
});
const {
  agentsPolicyStatusLine,
  neutralizeOwnedSectionSpoofing,
  parseBoldListHeading,
  parseReviewFindingHeading,
  parseSecurityConcernHeading,
  publicTableCell,
  sanitizeArchitectureDiagram,
  sectionLineValue,
  sectionList,
} = reportHelpers;

// A routine phrase inside a larger actionable or negated sentence ("Do not merge
// after required checks are green; rotate the token first") must not suppress the
// step, so require the routine phrase, reject negation, and re-check actionability.

// Checklist entries are list items, not table cells; only flatten newlines so
// downstream consumers of the checklist see command/path text unaltered.

// Labels are wrapped in renderer-owned bold markers, so Markdown delimiters inside
// report-provided titles must be escaped or they would break the bold span and the
// downstream label-stripping parsers.

// Model-generated text is rendered above renderer-owned sections such as
// "## Before merge", and downstream routing extracts those sections from the first
// matching Markdown heading. Escape heading-shaped lines in model text so injected
// content can never spoof a renderer-owned section boundary.

// The review prompt and schema require Mermaid flowchart source with no code fences,
// click directives, URLs, HTML, or initialization/styling directives. The diagram is
// model output that crosses into a trusted bot comment, so enforce that allowlist
// here and drop the diagram entirely when it does not comply.

const closeDecisionWorkflow = createCloseDecisionWorkflow({
  targetRepo,
  isMaintainerAuthorAssociation,
  normalizeLabelName,
  applyBlockingProtectedLabels,
  applyProtectedLabelReason,
  prAutoCloseExemptLabel,
  prAutoCloseExemptDecisionReason,
});
export const {
  staleVersionBugDecisionBlockReason,
  unsponsoredFeatureDecisionBlockReason,
  validateCloseDecision,
} = closeDecisionWorkflow;
const { hasUsableCloseComment, isImplementationCloseReason } = closeDecisionWorkflow;

const reviewCommentWorkflow = createReviewCommentWorkflow({
  root: ROOT,
  targetRepo,
  heldReviewStartStatusCommentResult,
  gitHubRuntimeBudgetError: GitHubRuntimeBudgetError,
  ghObservedMutationCommand,
  sha256,
  githubCount,
  ghPaged,
  reviewCommentBodyDigest,
  asRecord,
  parseGitHubItemRef,
  ...reportParser,
  ensureDir,
  ...recordMetadata,
  timestampMs,
  stringOrUndefined,
  sentence,
  ...reportOrchestration,
  isIssueAdvisoryLabel,
  removeIssueLabel,
  sectionLineValue,
  markdownLink,
});
export const {
  canPatchReviewComment,
  coverageProofRetryExhaustedRuntimeBudget,
  isCodexReviewCommentBody,
  lockedConversationApplyReason,
  newReviewStartLeaseOwnerForTest,
  recordedLabelSyncCoversUpdate,
  removeCurrentCursorTraceItem,
  renderReviewStartStatusComment,
  reviewArtifactDestination,
  reviewAutomationMarkersFromReport,
  reviewStartLeaseWinnerCommentIdForTest,
  runtimeBudgetExceeded,
  shouldPreserveReviewStartLease,
  supersededReviewPlaceholderCommentIds,
  timeoutWithinRuntimeBudget,
  withReviewStartStatusLease,
} = reviewCommentWorkflow;
const {
  pullHeadShaFromContext,
  fetchIssueReviewComments,
  reviewLeaseRevisionFromReport,
  pullHeadShaFromReport,
  writeCommentPayload,
  repairLoopPassModeFromReport,
  reviewVersionMarkerFromReport,
  reviewStructuralPullStateFromContext,
} = reviewCommentWorkflow;

function securityConcernLocation(concern: SecurityConcern): string {
  if (!concern.file) return "not tied to a single file";
  return `${concern.file}${concern.line ? `:${concern.line}` : ""}`;
}

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

// Offline local-range review: synthesize the Item + ItemContext from the local
// git range (merge-base(base, HEAD)..HEAD) so the FULL review (real-behavior
// proof + mantis decision) can run BEFORE a PR exists — the "advisory review
// before submission" #357 describes but gates behind an already-open PR. No
// GitHub fetch: the diff comes from `git diff`, the body from the commit message
// (or --body-file), so it works offline on a fork checkout.
const buildLocalRangeReview = createLocalRangeReviewer({
  run,
  pullCommitContentRevision,
  pullFileTreeIdentity,
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
  sha256,
  isRuntimeBudgetError: (error) => error instanceof GitHubRuntimeBudgetError,
});
export const { actionLedgerFailureDisposition } = reviewActionLedger;
const { actionLedgerItemKey } = reviewActionLedger;

const commandOperations = createCommandOperations({
  ...reviewActionLedger,
  ...recordMetadata,
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
  markdownFiles,
  numberForMarkdownFile,
  reconcileFolders: (...args) => reconcileFolders(...args),
  repoFromArgs,
  repoRelativePath,
  reviewActionLedger,
  ROOT,
  sha256,
  targetRepo,
});
export const {
  applyActionEventDisposition,
  applyItemBusinessIdempotencyIdentityForTest,
  applyMutationBusinessIdempotencyIdentityForTest,
  applyPhaseSequenceForTest,
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
  retryFailedReviewsCommand,
} = commandOperations;

const { reviewCommand } = createReviewCommandWorkflow({
  ...reviewActionLedger,
  get activeReviewMutationRunner() {
    return githubExecution.activeReviewMutationRunner;
  },
  set activeReviewMutationRunner(value: MutationRunner | null) {
    githubExecution.activeReviewMutationRunner = value;
  },
  asRecord,
  attachFixedPullRequest,
  verifyRegressionProvenance,
  ...contextHydration,
  buildLocalRangeReview,
  ...reviewRuntime,
  collectItemContext,
  ...reviewCommentWorkflow,
  DEFAULT_PLAN_BATCH_SIZE,
  defaultItemsDir,
  enforceExpectedIssueSourceRevision,
  ensureDir,
  exactLocalReviewNoCandidateError,
  ...recordMetadata,
  fetchReviewStructuralRecord,
  isBulkFilerExemptAuthorAssociation,
  isBulkFilerExemptRepositoryPermission,
  isSuppliedReviewStartLease,
  itemContentDigest,
  itemSnapshotHash,
  ...reportOrchestration,
  repoFromArgs,
  reportFileName,
  reportReviewFindings,
  reviewLeaseStillMatchesContext,
  reviewPolicyHash,
  selectCandidates,
  stringOrUndefined,
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
  ...labelSynchronization,
  ...reportOrchestration,
  applyBlockingProtectedLabels,
  applyKindArg,
  ApplyMutationReviewGuardError,
  applyProtectedLabelReason,
  ...recordMetadata,
  ...commandOperations,
  asRecord,
  authorPrBudgetAgeSkipReason,
  ...contextHydration,
  CLAWSWEEPER_BOT_AUTHORS,
  ...reviewCommentWorkflow,
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
  ...reportParser,
  isBulkFilerExemptAuthorAssociation,
  ...sourceRevisionTools,
  isMaintainerAuthorAssociation,
  implementedOnMainPullRequestProvenanceApplyBlock,
  isVerifiedFixedCloseReason,
  login,
  mutationErrorMessage,
  normalizeAuthorAssociation,
  normalizeLabelName,
  numberForMarkdownFile,
  PR_CLOSE_COVERAGE_PROOF_SCHEMA_PATH,
  prCloseCoverageProofPromptTemplate,
  prStatusLabelKindFromReport,
  repoFromArgs,
  reportEntriesForDir,
  ROOT,
  sha256,
  stringOrUndefined,
  targetRepo,
  timestampMs,
  validateCloseDecision,
});

function artifactTargetIsOpen(number: number, openNumbers: Set<number> | null): boolean {
  if (openNumbers) return openNumbers.has(number);
  return fetchItem(number).state === "open";
}

function markdownFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => parseReportFileName(name) !== null)
        .sort((left, right) => {
          const leftParsed = parseReportFileName(left);
          const rightParsed = parseReportFileName(right);
          return (
            (leftParsed?.repo ?? DEFAULT_TARGET_REPO).localeCompare(
              rightParsed?.repo ?? DEFAULT_TARGET_REPO,
            ) || (leftParsed?.number ?? 0) - (rightParsed?.number ?? 0)
          );
        })
    : [];
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

function numberForMarkdownFile(file: string): number {
  const parsed = parseReportFileName(file);
  if (!parsed) throw new Error(`Invalid report filename: ${file}`);
  return parsed.number;
}

function repoRelativePath(path: string): string {
  return relative(ROOT, path).replaceAll("\\", "/");
}

const dashboardAudit = createDashboardAudit({
  ...reviewPlanning,
  applyBlockingProtectedLabels,
  applyHealthStatusArg,
  ...sweepStatus,
  ...statusContext,
  ...repositoryPaths,
  ...recordMetadata,
  ensureDir,
  ghJson,
  isMaintainerAuthored,
  isProtectedItem,
  ...repositoryLinks,
  markdownFiles,
  numberForMarkdownFile,
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

const actionCommands = createActionCommands({
  defaultClosedDir,
  defaultItemsDir,
  repoFromArgs,
  ROOT,
  updateDashboard,
});
export const { actionEventPublishPathsForTest } = actionCommands;
const {
  dashboardCommand,
  finalizeActionEventsCommand,
  isExplicitActionLedgerCommand,
  publishActionEventPathsCommand,
  publishActionEventsCommand,
} = actionCommands;

const liveProofAttachDependencies = {
  reportLiveProofPlan: reportParser.reportLiveProofPlan,
  frontMatterValue: recordMetadata.frontMatterValue,
  sectionValue: recordMetadata.sectionValue,
  replaceSectionValue: recordMetadata.replaceSectionValue,
  reviewSections: REVIEW_SECTIONS,
  renderReviewCommentFromReport: reportOrchestration.renderReviewCommentFromReport,
  markedReviewCommentBody: reviewCommentWorkflow.markedReviewCommentBody,
  upsertReviewComment: reviewCommentWorkflow.upsertReviewComment,
  selectTarget: (repo: string) => setTargetRepo(repo),
};

const liveProofCommands = createLiveProofCommands({
  repositoryProfileFor,
  reportLiveProofPlan: reportParser.reportLiveProofPlan,
  parseLiveProofPlan: (value) => decisionParser.parseLiveProofPlan(value, "liveProofPlan"),
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
    frontMatterValue: recordMetadata.frontMatterValue,
    reportLiveProofPlan: reportParser.reportLiveProofPlan,
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
  review: reviewCommand,
  "retry-failed-reviews": retryFailedReviewsCommand,
  "apply-artifacts": applyArtifactsCommand,
  "live-proof": liveProofCommand,
  "live-proof-review": liveProofReviewCommand,
  "live-proof-attach": liveProofAttachCommand,
  "live-proof-comment": liveProofCommentCommand,
  "live-proof-publish-artifacts": liveProofPublishArtifactsCommand,
  "apply-decisions": applyDecisionsCommand,
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
