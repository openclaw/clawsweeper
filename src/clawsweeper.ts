#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TARGET_REPO,
  REPOSITORY_PROFILES,
  isAutoCloseAllowed,
  normalizeRepo,
  repositoryProfileFor,
  repositoryProfileForSlug,
  type RepositoryProfile,
} from "./repository-profiles.js";
import { codexEnv } from "./codex-env.js";
import {
  ghRetryKind,
  ghRetryWaitMs,
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
  shouldRetryGh,
  summarizeGhArgs,
} from "./github-retry.js";
import { parseGhJson, parseGhJsonLines } from "./github-json.js";
import { stableJson } from "./stable-json.js";
import { runText } from "./command.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import {
  boolArg,
  itemNumbersArg,
  numberArg,
  optionalNumberArg,
  parseArgs,
  stringArg,
  type Args,
} from "./clawsweeper-args.js";
import { escapeRegExp, safeOutputTail, trimMiddle, truncateText } from "./clawsweeper-text.js";

export { codexEnv } from "./codex-env.js";
export { parseGhJson, parseGhJsonLines } from "./github-json.js";
export { itemNumbersArg } from "./clawsweeper-args.js";
export { safeOutputTail } from "./clawsweeper-text.js";
export {
  ghRetryKind,
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
  shouldRetryGh,
} from "./github-retry.js";

type ItemKind = "issue" | "pull_request";
type ApplyKind = ItemKind | "all";
type DecisionKind = "close" | "keep_open";
type WorkCandidateKind = "none" | "manual_review" | "queue_fix_pr";
type TriagePriority = "P0" | "P1" | "P2" | "P3" | "none";
type ImpactLabelName =
  | "impact:data-loss"
  | "impact:security"
  | "impact:crash-loop"
  | "impact:message-loss"
  | "impact:session-state"
  | "impact:auth-provider";
type MergeRiskLabelName =
  | "merge-risk: 🚨 compatibility"
  | "merge-risk: 🚨 message-delivery"
  | "merge-risk: 🚨 session-state"
  | "merge-risk: 🚨 auth-provider"
  | "merge-risk: 🚨 security-boundary"
  | "merge-risk: 🚨 availability"
  | "merge-risk: 🚨 automation";
type ItemCategory =
  | "bug"
  | "regression"
  | "feature"
  | "skill"
  | "docs"
  | "cleanup"
  | "support"
  | "admin"
  | "security"
  | "unclear";
type ReproductionStatus =
  | "reproduced"
  | "source_reproducible"
  | "not_reproduced"
  | "unclear"
  | "not_applicable";
type OverallCorrectness = "patch is correct" | "patch is incorrect" | "not a patch";
type SecurityReviewStatus = "cleared" | "needs_attention" | "not_applicable";
type SecurityConcernSeverity = "high" | "medium" | "low";
type RealBehaviorProofStatus =
  | "sufficient"
  | "missing"
  | "mock_only"
  | "insufficient"
  | "not_applicable"
  | "override";
type RealBehaviorProofEvidenceKind =
  | "screenshot"
  | "recording"
  | "terminal"
  | "logs"
  | "live_output"
  | "linked_artifact"
  | "none"
  | "not_applicable";
type PrRatingTier = "S" | "A" | "B" | "C" | "D" | "F" | "NA";
type TelegramVisibleProofStatus = "needed" | "not_needed";
type MantisRecommendationStatus = "recommended" | "not_recommended";
type MantisRecommendationScenario =
  | "none"
  | "telegram_live"
  | "telegram_desktop_proof"
  | "discord_status_reactions"
  | "discord_thread_attachment"
  | "slack_desktop_smoke"
  | "visual_task";
type CloseReason =
  | "implemented_on_main"
  | "mostly_implemented_on_main"
  | "cannot_reproduce"
  | "clawhub"
  | "duplicate_or_superseded"
  | "not_actionable_in_repo"
  | "incoherent"
  | "stale_insufficient_info"
  | "none";
type Confidence = "high" | "medium" | "low";
type ActionTaken =
  | "closed"
  | "kept_open"
  | "proposed_close"
  | "review_comment_synced"
  | "skipped_comment_auth"
  | "skipped_locked_conversation"
  | "skipped_changed_since_review"
  | "skipped_open_closing_pr"
  | "skipped_same_author_pair"
  | "skipped_already_closed"
  | "skipped_maintainer_authored"
  | "skipped_protected_label"
  | "skipped_invalid_decision"
  | "skipped_runtime_budget";

const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface GitHubUser {
  login?: string;
}

interface GitHubIssueListItem {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  author_association?: string;
  user?: GitHubUser;
  labels?: string[];
  pull_request?: unknown;
}

interface Item {
  repo: string;
  number: number;
  kind: ItemKind;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null | undefined;
  author: string;
  authorAssociation: string;
  labels: string[];
  locked?: boolean;
  activeLockReason?: string | null;
}

export interface ReviewStartStatusCommentOptions {
  number: number;
  kind: string;
  title: string;
  position?: number;
  total?: number;
  shardIndex?: number;
  shardCount?: number;
}

interface ExistingReview {
  path: string;
  markdown: string;
  reviewedAt: string | undefined;
  itemUpdatedAt: string | undefined;
  reviewCommentSyncedAt: string | undefined;
  labelsSyncedAt: string | undefined;
  decision: string | undefined;
  reviewStatus: string | undefined;
  reviewPolicy: string | undefined;
}

interface LatestRelease {
  tagName?: string;
  name?: string;
  publishedAt?: string;
  targetCommitish?: string;
  sha?: string | null;
}

interface GitInfo {
  mainSha: string;
  latestRelease: LatestRelease | null;
}

interface Evidence {
  label: string;
  detail: string;
  file: string | null;
  line: number | null;
  command: string | null;
  sha: string | null;
}

interface LikelyOwner {
  person: string;
  role: string;
  reason: string;
  commits: string[];
  files: string[];
  confidence: Confidence;
}

interface ReviewFinding {
  title: string;
  body: string;
  priority: 0 | 1 | 2 | 3;
  confidenceScore: number;
  file: string;
  lineStart: number;
  lineEnd: number;
}

interface SecurityConcern {
  title: string;
  body: string;
  severity: SecurityConcernSeverity;
  confidenceScore: number;
  file: string | null;
  line: number | null;
}

interface SecurityReview {
  status: SecurityReviewStatus;
  summary: string;
  concerns: SecurityConcern[];
}

interface RealBehaviorProof {
  status: RealBehaviorProofStatus;
  summary: string;
  evidenceKind: RealBehaviorProofEvidenceKind;
  needsContributorAction: boolean;
}

interface PrRating {
  proofTier: PrRatingTier;
  patchTier: PrRatingTier;
  overallTier: PrRatingTier;
  summary: string;
  nextSteps: string[];
}

interface TelegramVisibleProof {
  status: TelegramVisibleProofStatus;
  summary: string;
}

interface MantisRecommendation {
  status: MantisRecommendationStatus;
  scenario: MantisRecommendationScenario;
  reason: string;
  maintainerComment: string;
}

interface FixedPullRequest {
  repo: string;
  number: number;
  url: string;
  title: string;
  mergedAt: string | null;
  sha: string | null;
  confidence: Confidence;
  source: string;
}

interface Decision {
  decision: DecisionKind;
  closeReason: CloseReason;
  confidence: Confidence;
  summary: string;
  changeSummary: string;
  evidence: Evidence[];
  likelyOwners: LikelyOwner[];
  risks: string[];
  bestSolution: string;
  triagePriority: TriagePriority;
  impactLabels: ImpactLabelName[];
  mergeRiskLabels: MergeRiskLabelName[];
  itemCategory: ItemCategory;
  reproductionStatus: ReproductionStatus;
  reproductionConfidence: Confidence;
  requiresNewFeature: boolean;
  requiresNewConfigOption: boolean;
  requiresProductDecision: boolean;
  reproductionAssessment: string;
  solutionAssessment: string;
  reviewFindings: ReviewFinding[];
  securityReview: SecurityReview;
  realBehaviorProof: RealBehaviorProof;
  prRating: PrRating;
  telegramVisibleProof: TelegramVisibleProof;
  mantisRecommendation: MantisRecommendation;
  overallCorrectness: OverallCorrectness;
  overallConfidenceScore: number;
  fixedRelease?: string | null;
  fixedSha?: string | null;
  fixedAt?: string | null;
  fixedPullRequest?: FixedPullRequest | null;
  closeComment: string;
  workCandidate: WorkCandidateKind;
  workConfidence: Confidence;
  workPriority: Confidence;
  workReason: string;
  workPrompt: string;
  workClusterRefs: string[];
  workValidation: string[];
  workLikelyFiles: string[];
}

interface ItemContext {
  issue: unknown;
  comments: unknown[];
  timeline: unknown[];
  closingPullRequests?: unknown[];
  relatedItems?: unknown[];
  pullRequest?: unknown;
  pullFiles?: unknown[];
  pullCommits?: unknown[];
  pullReviewComments?: unknown[];
  counts?: {
    comments: number;
    commentsHydrated?: number;
    commentsTruncated?: boolean;
    timeline: number;
    timelineHydrated?: number;
    timelineTruncated?: boolean;
    closingPullRequests?: number;
    relatedItems?: number;
    pullFiles?: number;
    pullFilesHydrated?: number;
    pullFilesTruncated?: boolean;
    pullCommits?: number;
    pullCommitsHydrated?: number;
    pullCommitsTruncated?: boolean;
    pullReviewComments?: number;
    pullReviewCommentsHydrated?: number;
    pullReviewCommentsTruncated?: boolean;
  };
}

interface LocalRelatedTitleEntry {
  number: number;
  kind: ItemKind | undefined;
  title: string;
  url: string | undefined;
  author: string | undefined;
  location: AuditRecordLocation;
  path: string;
  decision: string | undefined;
  closeReason: string | undefined;
  action: string | undefined;
  reviewStatus: string;
  summary: string;
}

interface Action {
  actionTaken: ActionTaken;
  closeComment: string;
}

interface ReviewRuntime {
  model: string;
  reasoningEffort: string;
  sandboxMode?: string;
  serviceTier?: string;
  promptChars?: number;
  staticPromptChars?: number;
  contextChars?: number;
  schemaChars?: number;
  additionalPromptChars?: number;
  contextElapsedMs?: number;
  codexElapsedMs?: number;
}

interface ReviewPromptTelemetry {
  promptChars: number;
  staticPromptChars: number;
  contextChars: number;
  schemaChars: number;
  additionalPromptChars: number;
}

interface ReviewPromptBuild {
  text: string;
  telemetry: ReviewPromptTelemetry;
}

interface ReviewContextLedgerEntry {
  section: string;
  label: string;
  entries: number;
  chars: number;
  total?: number;
  hydrated?: number;
  truncated?: boolean;
}

interface ReviewPromptRuntimeHints {
  proofScratchDir?: string;
}

interface DashboardItem {
  repo: string;
  number: number;
  kind: ItemKind;
  title: string;
  reviewedAt: string | undefined;
  decision: string;
  action: string;
  reviewStatus: string;
  reportPath: string;
  planPath?: string | undefined;
  workCandidate: string;
  workPriority: string;
  workStatus: string;
}

interface DashboardClosedItem {
  repo: string;
  number: number;
  kind: ItemKind;
  title: string;
  closedAt?: string | undefined;
  appliedAt: string | undefined;
  closeReason: string | undefined;
  reportPath: string;
}

interface RepoOpenCountsQuery {
  data?: {
    repository?: {
      issues?: {
        totalCount?: number;
      };
      pullRequests?: {
        totalCount?: number;
      };
    };
  };
}

interface OpenItemCounts {
  issues: number;
  pullRequests: number;
  total: number;
}

interface DashboardKindStats {
  total: number;
  fresh: number;
  proposedClose: number;
}

interface DashboardCadenceBucket {
  total: number;
  current: number;
  proposedClose: number;
}

interface DashboardCadenceStats {
  hourlyHotItems: DashboardCadenceBucket;
  dailyPullRequests: DashboardCadenceBucket;
  dailyNewIssues: DashboardCadenceBucket;
  weeklyOlderIssues: DashboardCadenceBucket;
  hourly: DashboardCadenceBucket;
  daily: DashboardCadenceBucket;
  weekly: DashboardCadenceBucket;
  unreviewedOpen: number;
  due: number;
}

interface DashboardActivityBucket {
  reviews: number;
  closeDecisions: number;
  keepOpenDecisions: number;
  failedOrStaleReviews: number;
  closes: number;
  commentSyncs: number;
  applySkips: number;
}

interface DashboardActivityStats {
  last15Minutes: DashboardActivityBucket;
  lastHour: DashboardActivityBucket;
  last24Hours: DashboardActivityBucket;
  latestReviewAt: string | undefined;
  latestCloseAt: string | undefined;
  latestCommentSyncAt: string | undefined;
}

interface DashboardStats {
  open: OpenItemCounts;
  fresh: number;
  todo: number;
  files: number;
  proposedClose: number;
  closed: number;
  archivedFiles: number;
  failed: number;
  stale: number;
  workCandidates: number;
  byKind: Record<ItemKind, DashboardKindStats>;
  cadence: DashboardCadenceStats;
  activity: DashboardActivityStats;
  recent: DashboardItem[];
  workQueue: DashboardItem[];
  recentClosed: DashboardClosedItem[];
}

interface WorkflowStatusSummary {
  updatedAt: string | undefined;
  state: string;
  detail: string;
  runUrl: string | undefined;
  plannedCount: number | undefined;
  plannedCapacity: number | undefined;
  plannedShards: number | undefined;
  activeCodex: number | undefined;
  dueBacklog: number | undefined;
  oldestUnreviewedAt: string | undefined;
  capacityReason: string | undefined;
}

interface RepoDashboardSnapshot {
  profile: RepositoryProfile;
  stats: DashboardStats;
  status: string;
  statusSummary: WorkflowStatusSummary;
  auditHealth: string;
}

interface PlanShard {
  shard: number;
  itemNumbers: number[];
}

interface PlanCandidateResult {
  shards: PlanShard[];
  scannedPages: number;
  candidates: Item[];
  capacity: number;
  dueBacklog: number;
  activeCodexTarget: number;
  oldestUnreviewedAt: string | undefined;
  capacityReason: string;
  floorBackfill: number;
}

const DEFAULT_PLAN_BATCH_SIZE = 3;
const DEFAULT_PLAN_SHARD_COUNT = AUTOMATION_LIMITS.review_shards.normal_default;
const MAX_PLAN_SHARD_COUNT = AUTOMATION_LIMITS.review_shards.hard_cap;

type SchedulerBucket =
  | "hot_issue"
  | "hot_pull_request"
  | "activity"
  | "daily_pull_request"
  | "recent_issue"
  | "weekly_issue";

interface DueCandidate {
  item: Item;
  review: ExistingReview | null;
  priority: number;
  reviewedAt: number;
  nextDueAt: number;
  bucket: SchedulerBucket;
}

interface ApplyResult {
  repo?: string;
  number: number;
  action: ActionTaken;
  reason: string;
}

interface ReconcileResult {
  openItemsSeen: number;
  pagesScanned: number;
  movedToClosed: number;
  movedToItems: number;
  removedStaleClosedCopies: number;
  fetchedClosedAt: number;
}

type AuditRecordLocation = "items" | "closed";
type MissingOpenReason =
  | "eligible"
  | "maintainer_authored"
  | "protected_label"
  | "recently_created";

interface AuditRecord {
  repo: string;
  number: number;
  location: AuditRecordLocation;
  path: string;
  kind: ItemKind | undefined;
  title: string;
  labels: string[];
  decision: string | undefined;
  closeReason: string | undefined;
  action: string | undefined;
  reviewStatus: string;
  currentState: string | undefined;
}

interface AuditFinding {
  number: number;
  kind?: ItemKind;
  title?: string;
  labels?: string[];
  authorAssociation?: string;
  createdAt?: string;
  updatedAt?: string;
  missingReason?: MissingOpenReason;
  itemPath?: string;
  closedPath?: string;
  action?: string;
  decision?: string;
  closeReason?: string;
  reviewStatus?: string;
  currentState?: string;
}

interface AuditResult {
  generatedAt: string;
  targetRepo: string;
  scan: {
    complete: boolean;
    pagesScanned: number;
    openItemsSeen: number;
  };
  counts: {
    itemRecords: number;
    closedRecords: number;
    missingOpen: number;
    missingEligibleOpen: number;
    missingMaintainerOpen: number;
    missingProtectedOpen: number;
    missingRecentOpen: number;
    openArchived: number;
    staleItemRecords: number;
    duplicateRecords: number;
    protectedProposed: number;
    staleReviews: number;
  };
  findings: {
    missingOpen: AuditFinding[];
    missingEligibleOpen: AuditFinding[];
    missingMaintainerOpen: AuditFinding[];
    missingProtectedOpen: AuditFinding[];
    missingRecentOpen: AuditFinding[];
    openArchived: AuditFinding[];
    staleItemRecords: AuditFinding[];
    duplicateRecords: AuditFinding[];
    protectedProposed: AuditFinding[];
    staleReviews: AuditFinding[];
  };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_REPO = "openclaw/clawsweeper";
const RECORDS_ROOT = join(ROOT, "records");
let activeRepositoryProfile = repositoryProfileFor(
  process.env.CLAWSWEEPER_TARGET_REPO ?? DEFAULT_TARGET_REPO,
);
const FRESH_DAYS = 7;
const HOT_REVIEW_DAYS = 7;
const RECENT_ISSUE_DAYS = 30;
const HOURLY_REVIEW_MS = 60 * 60 * 1000;
const DEFAULT_BACKFILL_REVIEW_AGE_MINUTES = 360;
const DAILY_REVIEW_DAYS = 1;
const WEEKLY_REVIEW_DAYS = 7;
const STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_MISSING_OPEN_MS = DAY_MS;
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_SERVICE_TIER = "";
const REVIEW_POLICY_VERSION = "2026-05-17-policy-v18";
const REVIEW_ITEM_PROMPT_PATH = join(ROOT, "prompts", "review-item.md");
const CLAWSWEEPER_DECISION_SCHEMA_PATH = join(ROOT, "schema", "clawsweeper-decision.schema.json");
const REVIEW_COMMENT_MARKER_PREFIX = "<!-- clawsweeper-review";
const REVIEW_START_STATUS_MARKER_PREFIX = "<!-- clawsweeper-review-status";
const AUTOMERGE_LABEL = "clawsweeper:automerge";
const AUTOFIX_LABEL = "clawsweeper:autofix";
const PROOF_OVERRIDE_LABEL = "proof: override";
const PROOF_SUFFICIENT_LABEL = "proof: sufficient";
const PROOF_SUFFICIENT_LABEL_COLOR = "1A7F37";
const PROOF_SUFFICIENT_LABEL_DESCRIPTION = "Contributor real behavior proof is sufficient.";
const PR_RATING_LABELS = [
  {
    tier: "S",
    name: "rating: 🦀 challenger crab",
    color: "1F883D",
    description: "Exceptional PR readiness: strong proof, clean patch, and convincing validation.",
  },
  {
    tier: "A",
    name: "rating: 🦞 diamond lobster",
    color: "0969DA",
    description: "Very strong PR readiness with only minor maintainer review expected.",
  },
  {
    tier: "B",
    name: "rating: 🐚 platinum hermit",
    color: "0F766E",
    description: "Good normal PR readiness with ordinary maintainer review expected.",
  },
  {
    tier: "C",
    name: "rating: 🦐 gold shrimp",
    color: "B7791F",
    description: "Decent PR readiness signal, but merge confidence is limited.",
  },
  {
    tier: "D",
    name: "rating: 🦪 silver shellfish",
    color: "7A828E",
    description: "Thin PR readiness signal; proof, validation, or implementation needs work.",
  },
  {
    tier: "F",
    name: "rating: 🧂 unranked krab",
    color: "8C2F39",
    description: "Not merge-ready due to missing proof or serious correctness/safety concerns.",
  },
  {
    tier: "NA",
    name: "rating: 🌊 off-meta tidepool",
    color: "6E7781",
    description: "PR readiness rating does not apply to this item.",
  },
] as const satisfies readonly {
  tier: PrRatingTier;
  name: string;
  color: string;
  description: string;
}[];
const PR_RATING_LABEL_NAMES = new Set<string>(PR_RATING_LABELS.map((label) => label.name));
const TELEGRAM_VISIBLE_PROOF_LABEL = "mantis: telegram-visible-proof";
const TELEGRAM_VISIBLE_PROOF_LABEL_COLOR = "57606A";
const TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION = "Mantis should capture Telegram visible proof.";
const PRIORITY_LABELS = [
  {
    priority: 0,
    triagePriority: "P0",
    name: "P0",
    color: "B60205",
    description: "Emergency: data loss, security bypass, crash loop, or unusable core runtime.",
  },
  {
    priority: 1,
    triagePriority: "P1",
    name: "P1",
    color: "D93F0B",
    description: "Urgent regression or broken agent/channel workflow affecting real users now.",
  },
  {
    priority: 2,
    triagePriority: "P2",
    name: "P2",
    color: "FBCA04",
    description: "Normal priority bug or improvement with limited blast radius.",
  },
  {
    priority: 3,
    triagePriority: "P3",
    name: "P3",
    color: "8C959F",
    description: "Low-risk cleanup, docs, polish, ergonomics, or speculative feature.",
  },
] as const;
const PRIORITY_LABEL_NAMES: ReadonlySet<string> = new Set(
  PRIORITY_LABELS.map((label) => label.name),
);
const IMPACT_LABELS = [
  {
    name: "impact:data-loss",
    color: "B60205",
    description:
      "This issue or PR is about lost, corrupted, or silently dropped user/session/config data.",
  },
  {
    name: "impact:security",
    color: "B60205",
    description:
      "This issue or PR is about security boundaries, credentials, authz, sandboxing, or sensitive data.",
  },
  {
    name: "impact:crash-loop",
    color: "D93F0B",
    description:
      "This issue or PR is about crashes, hangs, restart loops, or process-level availability.",
  },
  {
    name: "impact:message-loss",
    color: "D93F0B",
    description:
      "This issue or PR is about lost, duplicated, misrouted, or suppressed channel messages.",
  },
  {
    name: "impact:session-state",
    color: "F9D65C",
    description:
      "This issue or PR is about session, memory, transcript, context, or agent state drift.",
  },
  {
    name: "impact:auth-provider",
    color: "F9D65C",
    description:
      "This issue or PR is about auth, provider routing, model choice, or SecretRef resolution.",
  },
] as const satisfies readonly {
  name: ImpactLabelName;
  color: string;
  description: string;
}[];
const IMPACT_LABEL_NAMES: ReadonlySet<string> = new Set(IMPACT_LABELS.map((label) => label.name));
const MERGE_RISK_LABELS = [
  {
    name: "merge-risk: 🚨 compatibility",
    color: "D1242F",
    description:
      "🚨 Merging this PR could break existing users, config, migrations, defaults, or upgrades.",
  },
  {
    name: "merge-risk: 🚨 message-delivery",
    color: "D1242F",
    description:
      "🚨 Merging this PR could drop, duplicate, misroute, suppress, or wrongly target messages.",
  },
  {
    name: "merge-risk: 🚨 session-state",
    color: "F97316",
    description:
      "🚨 Merging this PR could lose, corrupt, stale, or mis-associate session or agent state.",
  },
  {
    name: "merge-risk: 🚨 auth-provider",
    color: "F97316",
    description:
      "🚨 Merging this PR could break OAuth, tokens, provider routing, model choice, or credentials.",
  },
  {
    name: "merge-risk: 🚨 security-boundary",
    color: "B60205",
    description:
      "🚨 Merging this PR could weaken sandboxing, authorization, credentials, or sensitive data.",
  },
  {
    name: "merge-risk: 🚨 availability",
    color: "D93F0B",
    description:
      "🚨 Merging this PR could cause crashes, hangs, restart loops, stalls, or process outages.",
  },
  {
    name: "merge-risk: 🚨 automation",
    color: "FBCA04",
    description:
      "🚨 Merging this PR could break CI, automerge, proof capture, label sync, or automation.",
  },
] as const satisfies readonly {
  name: MergeRiskLabelName;
  color: string;
  description: string;
}[];
const MERGE_RISK_LABEL_NAMES: ReadonlySet<string> = new Set(
  MERGE_RISK_LABELS.map((label) => label.name),
);
const ISSUE_ADVISORY_LABELS = [
  {
    name: "issue-rating: 🦀 challenger crab",
    color: "1F883D",
    description:
      "Exceptional issue quality: high-confidence current-main reproduction and actionable evidence.",
  },
  {
    name: "issue-rating: 🦞 diamond lobster",
    color: "0969DA",
    description:
      "Very strong issue quality with high-confidence source-level or clear reproduction.",
  },
  {
    name: "issue-rating: 🐚 platinum hermit",
    color: "0F766E",
    description: "Good issue quality with a plausible reproduction path needing some confirmation.",
  },
  {
    name: "issue-rating: 🦐 gold shrimp",
    color: "B7791F",
    description: "Decent issue quality, but reproduction details are still incomplete.",
  },
  {
    name: "issue-rating: 🦪 silver shellfish",
    color: "7A828E",
    description: "Thin issue quality; more reproduction proof or environment detail is needed.",
  },
  {
    name: "issue-rating: 🧂 unranked krab",
    color: "8C2F39",
    description: "Issue quality is currently too unclear to act on safely.",
  },
  {
    name: "issue-rating: 🌊 off-meta tidepool",
    color: "6E7781",
    description: "Issue quality rating does not apply to this item.",
  },
  {
    name: "clawsweeper:current-main-repro",
    color: "0A3069",
    description: "ClawSweeper found a high-confidence current-main issue reproduction.",
  },
  {
    name: "clawsweeper:source-repro",
    color: "0A3069",
    description: "ClawSweeper found a high-confidence source-level issue reproduction.",
  },
  {
    name: "clawsweeper:not-repro-on-main",
    color: "2DA44E",
    description:
      "ClawSweeper found high-confidence evidence that this issue no longer reproduces on main.",
  },
  {
    name: "clawsweeper:needs-live-repro",
    color: "FBCA04",
    description:
      "ClawSweeper needs live local, crabbox, or manual validation to confirm this issue.",
  },
  {
    name: "clawsweeper:needs-info",
    color: "6E7781",
    description: "ClawSweeper needs more reporter information before it can verify this issue.",
  },
  {
    name: "clawsweeper:linked-pr-open",
    color: "57606A",
    description: "ClawSweeper found an open linked pull request for this issue.",
  },
  {
    name: "clawsweeper:no-new-fix-pr",
    color: "8C959F",
    description: "ClawSweeper does not recommend queueing a new automated fix PR for this issue.",
  },
  {
    name: "clawsweeper:queueable-fix",
    color: "0E8A16",
    description: "ClawSweeper marked this issue as an existing queue_fix_pr work candidate.",
  },
  {
    name: "clawsweeper:fix-shape-clear",
    color: "1A7F37",
    description: "ClawSweeper found a clear likely implementation shape for this issue.",
  },
  {
    name: "clawsweeper:needs-maintainer-review",
    color: "FBCA04",
    description: "ClawSweeper marked this issue as needing maintainer review before automation.",
  },
  {
    name: "clawsweeper:needs-product-decision",
    color: "FBCA04",
    description: "ClawSweeper marked this issue as needing a product or behavior decision.",
  },
  {
    name: "clawsweeper:needs-security-review",
    color: "B60205",
    description: "ClawSweeper marked this issue as needing security-sensitive review.",
  },
] as const;
const ISSUE_ADVISORY_LABEL_NAMES = new Set(
  ISSUE_ADVISORY_LABELS.map((label) => label.name.toLowerCase()),
);
const PROTECTED_LABELS = new Set(["security", "beta-blocker", "release-blocker", "maintainer"]);
const ALLOWED_REASONS = new Set<CloseReason>([
  "implemented_on_main",
  "mostly_implemented_on_main",
  "cannot_reproduce",
  "clawhub",
  "duplicate_or_superseded",
  "not_actionable_in_repo",
  "incoherent",
  "stale_insufficient_info",
]);
const ALL_REASONS = new Set<CloseReason>([...ALLOWED_REASONS, "none"]);
const DECISIONS = new Set<DecisionKind>(["close", "keep_open"]);
const WORK_CANDIDATES = new Set<WorkCandidateKind>(["none", "manual_review", "queue_fix_pr"]);
const TRIAGE_PRIORITIES = new Set<TriagePriority>(["P0", "P1", "P2", "P3", "none"]);
const ITEM_CATEGORIES = new Set<ItemCategory>([
  "bug",
  "regression",
  "feature",
  "skill",
  "docs",
  "cleanup",
  "support",
  "admin",
  "security",
  "unclear",
]);
const REPRODUCTION_STATUSES = new Set<ReproductionStatus>([
  "reproduced",
  "source_reproducible",
  "not_reproduced",
  "unclear",
  "not_applicable",
]);
const SECURITY_REVIEW_STATUSES = new Set<SecurityReviewStatus>([
  "cleared",
  "needs_attention",
  "not_applicable",
]);
const SECURITY_CONCERN_SEVERITIES = new Set<SecurityConcernSeverity>(["high", "medium", "low"]);
const IMPACT_LABEL_VALUES = new Set<ImpactLabelName>(IMPACT_LABELS.map((label) => label.name));
const MERGE_RISK_LABEL_VALUES = new Set<MergeRiskLabelName>(
  MERGE_RISK_LABELS.map((label) => label.name),
);
const REAL_BEHAVIOR_PROOF_STATUSES = new Set<RealBehaviorProofStatus>([
  "sufficient",
  "missing",
  "mock_only",
  "insufficient",
  "not_applicable",
  "override",
]);
const PR_RATING_TIERS = new Set<PrRatingTier>(["S", "A", "B", "C", "D", "F", "NA"]);
const REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS = new Set<RealBehaviorProofEvidenceKind>([
  "screenshot",
  "recording",
  "terminal",
  "logs",
  "live_output",
  "linked_artifact",
  "none",
  "not_applicable",
]);
const TELEGRAM_VISIBLE_PROOF_STATUSES = new Set<TelegramVisibleProofStatus>([
  "needed",
  "not_needed",
]);
const MANTIS_RECOMMENDATION_STATUSES = new Set<MantisRecommendationStatus>([
  "recommended",
  "not_recommended",
]);
const MANTIS_RECOMMENDATION_SCENARIOS = new Set<MantisRecommendationScenario>([
  "none",
  "telegram_live",
  "telegram_desktop_proof",
  "discord_status_reactions",
  "discord_thread_attachment",
  "slack_desktop_smoke",
  "visual_task",
]);
const OVERALL_CORRECTNESS_VALUES = new Set<OverallCorrectness>([
  "patch is correct",
  "patch is incorrect",
  "not a patch",
]);

type ReviewArtifactDestination = "items" | "closed" | "skip_closed";
const CONFIDENCES = new Set<Confidence>(["high", "medium", "low"]);
const DECISION_SCHEMA_KEYS = new Set([
  "decision",
  "closeReason",
  "confidence",
  "summary",
  "changeSummary",
  "evidence",
  "likelyOwners",
  "risks",
  "bestSolution",
  "triagePriority",
  "impactLabels",
  "mergeRiskLabels",
  "itemCategory",
  "reproductionStatus",
  "reproductionConfidence",
  "requiresNewFeature",
  "requiresNewConfigOption",
  "requiresProductDecision",
  "reproductionAssessment",
  "solutionAssessment",
  "reviewFindings",
  "securityReview",
  "realBehaviorProof",
  "prRating",
  "telegramVisibleProof",
  "mantisRecommendation",
  "overallCorrectness",
  "overallConfidenceScore",
  "fixedRelease",
  "fixedSha",
  "fixedAt",
  "closeComment",
  "workCandidate",
  "workConfidence",
  "workPriority",
  "workReason",
  "workPrompt",
  "workClusterRefs",
  "workValidation",
  "workLikelyFiles",
]);
const EVIDENCE_SCHEMA_KEYS = new Set(["label", "detail", "file", "line", "command", "sha"]);
const SECURITY_REVIEW_SCHEMA_KEYS = new Set(["status", "summary", "concerns"]);
const REAL_BEHAVIOR_PROOF_SCHEMA_KEYS = new Set([
  "status",
  "summary",
  "evidenceKind",
  "needsContributorAction",
]);
const PR_RATING_SCHEMA_KEYS = new Set([
  "proofTier",
  "patchTier",
  "overallTier",
  "summary",
  "nextSteps",
]);
const TELEGRAM_VISIBLE_PROOF_SCHEMA_KEYS = new Set(["status", "summary"]);
const MANTIS_RECOMMENDATION_SCHEMA_KEYS = new Set([
  "status",
  "scenario",
  "reason",
  "maintainerComment",
]);
const SECURITY_CONCERN_SCHEMA_KEYS = new Set([
  "title",
  "body",
  "severity",
  "confidenceScore",
  "file",
  "line",
]);
const REVIEW_FINDING_SCHEMA_KEYS = new Set([
  "title",
  "body",
  "priority",
  "confidenceScore",
  "file",
  "lineStart",
  "lineEnd",
]);
const LIKELY_OWNER_SCHEMA_KEYS = new Set([
  "person",
  "role",
  "reason",
  "commits",
  "files",
  "confidence",
]);
const REVIEW_SECTIONS = {
  summary: "Summary",
  changeSummary: "What This Changes",
  bestSolution: "Best Possible Solution",
  reproductionAssessment: "Reproduction Assessment",
  solutionAssessment: "Solution Assessment",
  reviewFindings: "Review Findings",
  securityReview: "Security Review",
  realBehaviorProof: "Real Behavior Proof",
  prRating: "PR Rating",
  telegramVisibleProof: "Telegram Visible Proof",
  mantisRecommendation: "Mantis Recommendation",
  workCandidate: "Work Candidate",
  repairWorkPrompt: "Repair Work Prompt",
  evidence: "Evidence",
  likelyOwners: "Likely Related People",
  risks: "Risks / Open Questions",
  closeComment: "Close Comment",
} as const;

type ReviewSection = keyof typeof REVIEW_SECTIONS;

function targetProfile(): RepositoryProfile {
  return activeRepositoryProfile;
}

function targetRepo(): string {
  return activeRepositoryProfile.targetRepo;
}

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

function profileStatusStart(profile = targetProfile()): string {
  return `<!-- clawsweeper-status:${profile.slug}:start -->`;
}

function profileStatusEnd(profile = targetProfile()): string {
  return `<!-- clawsweeper-status:${profile.slug}:end -->`;
}

function profileAuditStart(profile = targetProfile()): string {
  return `<!-- clawsweeper-audit:${profile.slug}:start -->`;
}

function profileAuditEnd(profile = targetProfile()): string {
  return `<!-- clawsweeper-audit:${profile.slug}:end -->`;
}

function sweepStatusPath(profile = targetProfile()): string {
  return join(ROOT, "results", "sweep-status", `${profile.slug}.json`);
}

function sweepStatusRelativePath(profile = targetProfile()): string {
  return join("results", "sweep-status", `${profile.slug}.json`);
}

function auditStatePath(profile = targetProfile()): string {
  return join(ROOT, "results", "audit", `${profile.slug}.json`);
}

function writeSweepStatus(options: {
  state: string;
  detail: string;
  runUrl?: string;
  profile?: RepositoryProfile;
  plannedCount?: number;
  plannedCapacity?: number;
  plannedShards?: number;
  activeCodex?: number;
  dueBacklog?: number;
  oldestUnreviewedAt?: string;
  capacityReason?: string;
}): void {
  const profile = options.profile ?? targetProfile();
  const updatedAt = new Date().toISOString();
  const payload = {
    schema_version: 1,
    slug: profile.slug,
    display_name: profile.displayName,
    target_repo: profile.targetRepo,
    state: options.state,
    detail: options.detail,
    run_url: options.runUrl ?? null,
    planned_count: options.plannedCount ?? null,
    planned_capacity: options.plannedCapacity ?? null,
    planned_shards: options.plannedShards ?? null,
    active_codex: options.activeCodex ?? null,
    due_backlog: options.dueBacklog ?? null,
    oldest_unreviewed_at: options.oldestUnreviewedAt ?? null,
    capacity_reason: options.capacityReason ?? null,
    updated_at: updatedAt,
  };
  const outputPath = sweepStatusPath(profile);
  ensureDir(dirname(outputPath));
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function repoRecordsDir(profile = targetProfile()): string {
  return join(RECORDS_ROOT, profile.slug);
}

function defaultItemsDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "items");
}

function defaultClosedDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "closed");
}

function defaultPlansDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "plans");
}

function reportFileName(repo: string, number: number): string {
  repositoryProfileFor(repo);
  return `${number}.md`;
}

function parseReportFileName(file: string): { repo: string | undefined; number: number } | null {
  const numeric = file.match(/^(\d+)\.md$/);
  if (numeric?.[1]) return { repo: undefined, number: Number(numeric[1]) };
  const prefixed = file.match(/^([a-z0-9][a-z0-9-]*)-(\d+)\.md$/);
  if (!prefixed?.[1] || !prefixed[2]) return null;
  return { repo: repositoryProfileForSlug(prefixed[1])?.targetRepo, number: Number(prefixed[2]) };
}

function markdownRepository(markdown: string, file?: string): string {
  const fromMarkdown = frontMatterValue(markdown, "repository");
  if (fromMarkdown) return normalizeRepo(fromMarkdown);
  if (file) {
    const normalizedPath = repoRelativePath(file);
    const recordsMatch = normalizedPath.match(/^records\/([^/]+)\//);
    if (recordsMatch?.[1]) {
      const profile = repositoryProfileForSlug(recordsMatch[1]);
      if (profile) return profile.targetRepo;
    }
    const parsed = parseReportFileName(basename(file));
    if (parsed?.repo) return parsed.repo;
  }
  return DEFAULT_TARGET_REPO;
}

function isMarkdownForActiveRepo(markdown: string, file?: string): boolean {
  return markdownRepository(markdown, file) === targetRepo();
}

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
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  return runText(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    trim: "both",
  });
}

function gh(args: string[]): string {
  if (args[0] === "api") return run("gh", args);
  return run("gh", ["--repo", targetRepo(), ...args]);
}

function sleepMs(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

let lastThrottleHeartbeatAt = 0;
let throttleHeartbeatContext: (() => string) | null = null;

function maybePublishThrottleHeartbeat(options: {
  args: string[];
  attempt: number;
  attempts: number;
  waitMs: number;
}): void {
  if (process.env.CLAWSWEEPER_PUBLISH_THROTTLE_STATUS !== "true") return;
  const minWaitMs = Number(process.env.CLAWSWEEPER_THROTTLE_STATUS_MIN_WAIT_MS ?? 60_000);
  if (options.waitMs < minWaitMs) return;
  const minIntervalMs = Number(process.env.CLAWSWEEPER_THROTTLE_STATUS_MIN_INTERVAL_MS ?? 120_000);
  const now = Date.now();
  if (now - lastThrottleHeartbeatAt < minIntervalMs) return;
  lastThrottleHeartbeatAt = now;

  try {
    const context = throttleHeartbeatContext?.();
    const checkpoint = process.env.CLAWSWEEPER_APPLY_CHECKPOINT;
    const checkpointText = checkpoint ? `Checkpoint ${checkpoint}. ` : "";
    const detail = [
      `${checkpointText}GitHub throttled while applying close decisions.`,
      context,
      `Last throttled command: \`${summarizeGhArgs(options.args)}\`.`,
      `Retry ${options.attempt + 1}/${Math.max(1, options.attempts - 1)} in ${Math.round(options.waitMs / 1000)}s.`,
    ]
      .filter(Boolean)
      .join(" ");
    const statusOptions: {
      state: string;
      detail: string;
      runUrl?: string;
    } = {
      state: "Apply throttled",
      detail,
    };
    if (process.env.CLAWSWEEPER_RUN_URL) {
      statusOptions.runUrl = process.env.CLAWSWEEPER_RUN_URL;
    }
    writeSweepStatus(statusOptions);
    run("git", ["add", sweepStatusRelativePath()]);
    const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT });
    if (diff.status === 0) return;
    run("git", ["commit", "-m", "chore: update sweep apply throttle status"]);
    try {
      run("git", ["push"]);
    } catch (error) {
      console.error(
        `Best-effort throttle status push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    console.error(
      `Best-effort throttle status update failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function ghWithRetry(args: string[], attempts = 12): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return gh(args);
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      if (retryKind === "none" || attempt === attempts - 1) throw error;
      const waitMs = ghRetryWaitMs(retryKind, attempt);
      const retryLabel =
        retryKind === "throttle" ? "GitHub throttled" : "Transient GitHub API failure";
      console.error(
        `${retryLabel}; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
      );
      if (retryKind === "throttle") {
        maybePublishThrottleHeartbeat({ args, attempt, attempts, waitMs });
      }
      sleepMs(waitMs);
    }
  }
  throw lastError;
}

function ghJson<T>(args: string[]): T {
  return parseGhJson<T>(ghWithRetry(args), args);
}

function ghJsonLines<T>(args: string[]): T[] {
  return parseGhJsonLines<T>(ghWithRetry(args), args);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

let reviewPromptTemplateCache: string | undefined;
let reviewDecisionSchemaCache: string | undefined;

function itemSnapshotHash(item: Item, context: ItemContext): string {
  const snapshotItem = {
    repo: item.repo,
    number: item.number,
    kind: item.kind,
    title: item.title,
    url: item.url,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    author: item.author,
    labels: item.labels,
  };
  return sha256(stableJson({ item: snapshotItem, context }));
}

function reviewPolicyHash(options: {
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: string;
  serviceTier?: string;
}): string {
  return sha256(
    stableJson({
      version: REVIEW_POLICY_VERSION,
      freshDays: FRESH_DAYS,
      model: options.model ?? DEFAULT_CODEX_MODEL,
      reasoningEffort: options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      sandboxMode: options.sandboxMode ?? "read-only",
      serviceTier: options.serviceTier ?? DEFAULT_SERVICE_TIER,
      targetRepo: targetRepo(),
      repositoryProfile: targetProfile(),
      prompt: reviewPromptTemplate(),
      schema: reviewDecisionSchemaText(),
    }),
  ).slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnexpectedKeys(
  record: Record<string, unknown>,
  allowedKeys: Set<string>,
  path: string,
): void {
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unexpected.length) throw new Error(`${path} has unexpected keys: ${unexpected.join(", ")}`);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function requireNullableString(value: unknown, path: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new Error(`${path} must be a string or null`);
}

function requireNullableInteger(value: unknown, path: string): number | null {
  if (value === null) return value;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new Error(`${path} must be an integer or null`);
}

function requireInteger(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new Error(`${path} must be an integer`);
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${path} must be a finite number`);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${path} must be a boolean`);
}

function requireConfidenceScore(value: unknown, path: string): number {
  const score = requireNumber(value, path);
  if (score < 0 || score > 1) throw new Error(`${path} must be between 0 and 1`);
  return score;
}

function requirePriority(value: unknown, path: string): ReviewFinding["priority"] {
  const priority = requireInteger(value, path);
  if (priority === 0 || priority === 1 || priority === 2 || priority === 3) return priority;
  throw new Error(`${path} must be 0, 1, 2, or 3`);
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => requireString(entry, `${path}[${index}]`));
}

function requireEnumArray<T extends string>(value: unknown, allowed: Set<T>, path: string): T[] {
  return requireStringArray(value, path).map((entry, index) =>
    requireEnum(entry, allowed, `${path}[${index}]`),
  );
}

function requireImpactLabels(value: unknown): ImpactLabelName[] {
  const labels = requireEnumArray(value, IMPACT_LABEL_VALUES, "decision.impactLabels");
  if (labels.length > 3) throw new Error("decision.impactLabels must contain at most 3 labels");
  if (new Set(labels).size !== labels.length) {
    throw new Error("decision.impactLabels must not contain duplicates");
  }
  return labels;
}

function requireMergeRiskLabels(value: unknown): MergeRiskLabelName[] {
  const labels = requireEnumArray(value, MERGE_RISK_LABEL_VALUES, "decision.mergeRiskLabels");
  if (labels.length > 3) throw new Error("decision.mergeRiskLabels must contain at most 3 labels");
  if (new Set(labels).size !== labels.length) {
    throw new Error("decision.mergeRiskLabels must not contain duplicates");
  }
  return labels;
}

function isEnvironmentAccessCaveat(value: string): boolean {
  return /(?:GH_TOKEN|GITHUB_TOKEN|authenticated gh|gh (?:was |is )?unavailable|unauthenticated gh|shallow clone|GitHub auth(?:entication)? (?:was |is )?unavailable|could not use authenticated GitHub)/i.test(
    value,
  );
}

function parseEvidence(value: unknown, path: string): Evidence {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, EVIDENCE_SCHEMA_KEYS, path);
  return {
    label: requireString(record.label, `${path}.label`),
    detail: requireString(record.detail, `${path}.detail`),
    file: requireNullableString(record.file, `${path}.file`),
    line: requireNullableInteger(record.line, `${path}.line`),
    command: requireNullableString(record.command, `${path}.command`),
    sha: requireNullableString(record.sha, `${path}.sha`),
  };
}

function parseLikelyOwner(value: unknown, path: string): LikelyOwner {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, LIKELY_OWNER_SCHEMA_KEYS, path);
  return {
    person: requireString(record.person, `${path}.person`),
    role: requireString(record.role, `${path}.role`),
    reason: requireString(record.reason, `${path}.reason`),
    commits: requireStringArray(record.commits, `${path}.commits`),
    files: requireStringArray(record.files, `${path}.files`),
    confidence: requireEnum(record.confidence, CONFIDENCES, `${path}.confidence`),
  };
}

function parseReviewFinding(value: unknown, path: string): ReviewFinding {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, REVIEW_FINDING_SCHEMA_KEYS, path);
  const lineStart = requireInteger(record.lineStart, `${path}.lineStart`);
  const lineEnd = requireInteger(record.lineEnd, `${path}.lineEnd`);
  if (lineStart <= 0) throw new Error(`${path}.lineStart must be positive`);
  if (lineEnd < lineStart) throw new Error(`${path}.lineEnd must be >= lineStart`);
  return {
    title: requireString(record.title, `${path}.title`),
    body: requireString(record.body, `${path}.body`),
    priority: requirePriority(record.priority, `${path}.priority`),
    confidenceScore: requireConfidenceScore(record.confidenceScore, `${path}.confidenceScore`),
    file: requireString(record.file, `${path}.file`),
    lineStart,
    lineEnd,
  };
}

type DecisionNormalizationItem = Pick<Item, "repo" | "kind" | "authorAssociation">;

const CHANGELOG_ENTRY_REVIEW_PATTERN = /\b(?:changelog\.md|changelog\s+entry|release[- ]?note)\b/i;
const MISSING_CHANGELOG_ACTION_PATTERN =
  /\b(?:add|include|missing|no|lacks?|needs?|requires?|required|without)\b/i;
const CHANGELOG_TOOLING_PATTERN =
  /\b(?:coverage|duplicate|generator|malformed|parser|validation|validator|wrong\s+section)\b/i;

function isOpenClawContributorPullRequest(item: DecisionNormalizationItem | undefined): boolean {
  return (
    item !== undefined &&
    normalizeRepo(item.repo) === DEFAULT_TARGET_REPO &&
    item.kind === "pull_request" &&
    !isMaintainerAuthorAssociation(item.authorAssociation)
  );
}

function isContributorChangelogEntryFinding(
  item: DecisionNormalizationItem | undefined,
  finding: ReviewFinding,
): boolean {
  const text = `${finding.title}\n${finding.body}`;
  return (
    isOpenClawContributorPullRequest(item) &&
    CHANGELOG_ENTRY_REVIEW_PATTERN.test(text) &&
    MISSING_CHANGELOG_ACTION_PATTERN.test(text) &&
    !CHANGELOG_TOOLING_PATTERN.test(text)
  );
}

const CLEAN_OPENCLAW_PR_REVIEW_NEXT_STEP =
  "Continue normal maintainer review; ClawSweeper found no patch-correctness issue.";

function normalizeDecisionForItem(
  decision: Decision,
  item: DecisionNormalizationItem | undefined,
): Decision {
  const reviewFindings = decision.reviewFindings.filter(
    (finding) => !isContributorChangelogEntryFinding(item, finding),
  );
  if (reviewFindings.length === decision.reviewFindings.length) return decision;
  if (reviewFindings.length > 0) return { ...decision, reviewFindings };

  return {
    ...decision,
    reviewFindings,
    bestSolution: CLEAN_OPENCLAW_PR_REVIEW_NEXT_STEP,
    triagePriority: decision.triagePriority,
    overallCorrectness:
      decision.overallCorrectness === "patch is incorrect"
        ? "patch is correct"
        : decision.overallCorrectness,
    workCandidate: "none",
    workConfidence: "low",
    workPriority: "low",
    workReason: "",
    workPrompt: "",
    workClusterRefs: [],
    workValidation: [],
    workLikelyFiles: [],
  };
}

function parseSecurityConcern(value: unknown, path: string): SecurityConcern {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, SECURITY_CONCERN_SCHEMA_KEYS, path);
  const line = requireNullableInteger(record.line, `${path}.line`);
  if (line !== null && line <= 0) throw new Error(`${path}.line must be positive`);
  return {
    title: requireString(record.title, `${path}.title`),
    body: requireString(record.body, `${path}.body`),
    severity: requireEnum(record.severity, SECURITY_CONCERN_SEVERITIES, `${path}.severity`),
    confidenceScore: requireConfidenceScore(record.confidenceScore, `${path}.confidenceScore`),
    file: requireNullableString(record.file, `${path}.file`),
    line,
  };
}

function parseSecurityReview(value: unknown, path: string): SecurityReview {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, SECURITY_REVIEW_SCHEMA_KEYS, path);
  const concerns = Array.isArray(record.concerns)
    ? record.concerns.map((entry, index) =>
        parseSecurityConcern(entry, `${path}.concerns[${index}]`),
      )
    : (() => {
        throw new Error(`${path}.concerns must be an array`);
      })();
  return {
    status: requireEnum(record.status, SECURITY_REVIEW_STATUSES, `${path}.status`),
    summary: requireString(record.summary, `${path}.summary`),
    concerns,
  };
}

function parseRealBehaviorProof(value: unknown, path: string): RealBehaviorProof {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, REAL_BEHAVIOR_PROOF_SCHEMA_KEYS, path);
  return {
    status: requireEnum(record.status, REAL_BEHAVIOR_PROOF_STATUSES, `${path}.status`),
    summary: requireString(record.summary, `${path}.summary`),
    evidenceKind: requireEnum(
      record.evidenceKind,
      REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS,
      `${path}.evidenceKind`,
    ),
    needsContributorAction: requireBoolean(
      record.needsContributorAction,
      `${path}.needsContributorAction`,
    ),
  };
}

function parsePrRating(value: unknown, path: string): PrRating {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, PR_RATING_SCHEMA_KEYS, path);
  return normalizePrRating({
    proofTier: requireEnum(record.proofTier, PR_RATING_TIERS, `${path}.proofTier`),
    patchTier: requireEnum(record.patchTier, PR_RATING_TIERS, `${path}.patchTier`),
    overallTier: requireEnum(record.overallTier, PR_RATING_TIERS, `${path}.overallTier`),
    summary: requireString(record.summary, `${path}.summary`),
    nextSteps: requireStringArray(record.nextSteps, `${path}.nextSteps`).slice(0, 3),
  });
}

function parseTelegramVisibleProof(value: unknown, path: string): TelegramVisibleProof {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, TELEGRAM_VISIBLE_PROOF_SCHEMA_KEYS, path);
  return {
    status: requireEnum(record.status, TELEGRAM_VISIBLE_PROOF_STATUSES, `${path}.status`),
    summary: requireString(record.summary, `${path}.summary`),
  };
}

function parseMantisRecommendation(value: unknown, path: string): MantisRecommendation {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, MANTIS_RECOMMENDATION_SCHEMA_KEYS, path);
  return {
    status: requireEnum(record.status, MANTIS_RECOMMENDATION_STATUSES, `${path}.status`),
    scenario: requireEnum(record.scenario, MANTIS_RECOMMENDATION_SCENARIOS, `${path}.scenario`),
    reason: requireString(record.reason, `${path}.reason`),
    maintainerComment: requireString(record.maintainerComment, `${path}.maintainerComment`),
  };
}

function requireEnum<T extends string>(value: unknown, allowed: Set<T>, path: string): T {
  if (typeof value === "string" && allowed.has(value as T)) return value as T;
  throw new Error(`${path} has invalid value`);
}

export function parseDecision(value: unknown, item?: DecisionNormalizationItem): Decision {
  const record = requireRecord(value, "decision");
  rejectUnexpectedKeys(record, DECISION_SCHEMA_KEYS, "decision");
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.map((entry, index) => parseEvidence(entry, `decision.evidence[${index}]`))
    : (() => {
        throw new Error("decision.evidence must be an array");
      })();
  const likelyOwners = Array.isArray(record.likelyOwners)
    ? record.likelyOwners.map((entry, index) =>
        parseLikelyOwner(entry, `decision.likelyOwners[${index}]`),
      )
    : (() => {
        throw new Error("decision.likelyOwners must be an array");
      })();
  if (likelyOwners.length === 0) throw new Error("decision.likelyOwners must not be empty");
  const reviewFindings = Array.isArray(record.reviewFindings)
    ? record.reviewFindings.map((entry, index) =>
        parseReviewFinding(entry, `decision.reviewFindings[${index}]`),
      )
    : (() => {
        throw new Error("decision.reviewFindings must be an array");
      })();
  const decision: Decision = {
    decision: requireEnum(record.decision, DECISIONS, "decision.decision"),
    closeReason: requireEnum(record.closeReason, ALL_REASONS, "decision.closeReason"),
    confidence: requireEnum(record.confidence, CONFIDENCES, "decision.confidence"),
    summary: requireString(record.summary, "decision.summary"),
    changeSummary: requireString(record.changeSummary, "decision.changeSummary"),
    evidence,
    likelyOwners,
    risks: requireStringArray(record.risks, "decision.risks").filter(
      (risk) => !isEnvironmentAccessCaveat(risk),
    ),
    bestSolution: requireString(record.bestSolution, "decision.bestSolution"),
    triagePriority: requireEnum(
      record.triagePriority,
      TRIAGE_PRIORITIES,
      "decision.triagePriority",
    ),
    impactLabels: requireImpactLabels(record.impactLabels),
    mergeRiskLabels: requireMergeRiskLabels(record.mergeRiskLabels),
    itemCategory: requireEnum(record.itemCategory, ITEM_CATEGORIES, "decision.itemCategory"),
    reproductionStatus: requireEnum(
      record.reproductionStatus,
      REPRODUCTION_STATUSES,
      "decision.reproductionStatus",
    ),
    reproductionConfidence: requireEnum(
      record.reproductionConfidence,
      CONFIDENCES,
      "decision.reproductionConfidence",
    ),
    requiresNewFeature: requireBoolean(record.requiresNewFeature, "decision.requiresNewFeature"),
    requiresNewConfigOption: requireBoolean(
      record.requiresNewConfigOption,
      "decision.requiresNewConfigOption",
    ),
    requiresProductDecision: requireBoolean(
      record.requiresProductDecision,
      "decision.requiresProductDecision",
    ),
    reproductionAssessment: requireString(
      record.reproductionAssessment,
      "decision.reproductionAssessment",
    ),
    solutionAssessment: requireString(record.solutionAssessment, "decision.solutionAssessment"),
    reviewFindings,
    securityReview: parseSecurityReview(record.securityReview, "decision.securityReview"),
    realBehaviorProof: parseRealBehaviorProof(
      record.realBehaviorProof,
      "decision.realBehaviorProof",
    ),
    prRating: parsePrRating(record.prRating, "decision.prRating"),
    telegramVisibleProof: parseTelegramVisibleProof(
      record.telegramVisibleProof,
      "decision.telegramVisibleProof",
    ),
    mantisRecommendation: parseMantisRecommendation(
      record.mantisRecommendation,
      "decision.mantisRecommendation",
    ),
    overallCorrectness: requireEnum(
      record.overallCorrectness,
      OVERALL_CORRECTNESS_VALUES,
      "decision.overallCorrectness",
    ),
    overallConfidenceScore: requireConfidenceScore(
      record.overallConfidenceScore,
      "decision.overallConfidenceScore",
    ),
    fixedRelease: requireNullableString(record.fixedRelease, "decision.fixedRelease"),
    fixedSha: requireNullableString(record.fixedSha, "decision.fixedSha"),
    fixedAt: requireNullableString(record.fixedAt, "decision.fixedAt"),
    closeComment: requireString(record.closeComment, "decision.closeComment"),
    workCandidate: requireEnum(record.workCandidate, WORK_CANDIDATES, "decision.workCandidate"),
    workConfidence: requireEnum(record.workConfidence, CONFIDENCES, "decision.workConfidence"),
    workPriority: requireEnum(record.workPriority, CONFIDENCES, "decision.workPriority"),
    workReason: requireString(record.workReason, "decision.workReason"),
    workPrompt: requireString(record.workPrompt, "decision.workPrompt"),
    workClusterRefs: requireStringArray(record.workClusterRefs, "decision.workClusterRefs"),
    workValidation: requireStringArray(record.workValidation, "decision.workValidation"),
    workLikelyFiles: requireStringArray(record.workLikelyFiles, "decision.workLikelyFiles"),
  };
  return normalizeDecisionForItem(decision, item);
}

function login(value: unknown): string | undefined {
  const user = asRecord(value);
  const name = user.login;
  return typeof name === "string" ? name : undefined;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => {
      if (typeof label === "string") return label;
      const name = asRecord(label).name;
      return typeof name === "string" ? name : null;
    })
    .filter((name): name is string => Boolean(name));
}

function normalizeAuthorAssociation(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "NONE";
}

function isMaintainerAuthorAssociation(value: unknown): boolean {
  return MAINTAINER_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(value));
}

function isMaintainerAuthored(item: Pick<Item, "authorAssociation">): boolean {
  return isMaintainerAuthorAssociation(item.authorAssociation);
}

function normalizeLabelName(label: string): string {
  return label.trim().toLowerCase();
}

export function protectedLabels(labels: readonly string[]): string[] {
  return labels
    .map((label) => normalizeLabelName(label))
    .filter(
      (label, index, normalized) =>
        PROTECTED_LABELS.has(label) && normalized.indexOf(label) === index,
    );
}

export function isProtectedItem(item: Pick<Item, "labels">): boolean {
  return protectedLabels(item.labels).length > 0;
}

function protectedLabelReason(labels: readonly string[]): string {
  return `protected label: ${protectedLabels(labels).join(", ")}`;
}

export function shouldPlanItem(item: Pick<Item, "authorAssociation" | "labels">): boolean {
  return !isMaintainerAuthored(item) && !isProtectedItem(item);
}

function isOlderThanDays(isoTimestamp: string, days: number, now = Date.now()): boolean {
  return isOlderThanMs(isoTimestamp, days * DAY_MS, now);
}

function isOlderThanMs(isoTimestamp: string, milliseconds: number, now = Date.now()): boolean {
  if (milliseconds <= 0) return true;
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp > milliseconds;
}

function applyKindArg(value: string | boolean | string[] | undefined): ApplyKind {
  const kind = stringArg(value, "issue");
  if (kind === "issue" || kind === "pull_request" || kind === "all") return kind;
  throw new Error(`Invalid apply kind: ${kind}`);
}

export function closeReasonsArg(
  value: string | boolean | string[] | undefined,
): Set<CloseReason> | null {
  const raw = stringArg(value, "all").trim();
  if (!raw || raw === "all") return null;
  const reasons = new Set<CloseReason>();
  for (const part of raw.split(",")) {
    const reason = part.trim();
    if (!reason) continue;
    if (!ALLOWED_REASONS.has(reason as CloseReason)) {
      throw new Error(`Invalid apply close reason: ${reason}`);
    }
    reasons.add(reason as CloseReason);
  }
  return reasons.size ? reasons : null;
}

function closeReasonFilterText(filter: ReadonlySet<CloseReason> | null): string {
  return filter ? [...filter].sort().join(",") : "all";
}

function closeReasonEnabled(
  closeReason: CloseReason,
  filter: ReadonlySet<CloseReason> | null,
): boolean {
  return filter === null || filter.has(closeReason);
}

export function closeReasonApplyAgeSkipReason(
  item: Pick<Item, "createdAt">,
  closeReason: CloseReason,
  options: {
    minAgeMs: number;
    minAgeDescription: string;
    staleMinAgeDays: number;
    now?: number;
  },
): string | null {
  const now = options.now ?? Date.now();
  if (
    (closeReason === "stale_insufficient_info" || closeReason === "mostly_implemented_on_main") &&
    !isOlderThanDays(item.createdAt, options.staleMinAgeDays, now)
  ) {
    return `${closeReason} requires item older than ${options.staleMinAgeDays} days`;
  }
  if (!isOlderThanMs(item.createdAt, options.minAgeMs, now)) {
    return `created less than or equal to ${options.minAgeDescription} ago`;
  }
  return null;
}

export function compactMappedSlice<T>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => unknown,
): unknown[] {
  return compactMappedWindow(items, items.length, limit, mapper);
}

export function compactMappedWindow<T>(
  items: readonly T[],
  total: number,
  limit: number,
  mapper: (item: T) => unknown,
): unknown[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const boundedTotal = Math.max(0, Math.floor(total));
  if (boundedTotal <= boundedLimit && items.length <= boundedLimit) return items.map(mapper);
  if (boundedLimit === 0) {
    return boundedTotal > 0
      ? [{ omitted: boundedTotal, note: "middle entries omitted from prompt context" }]
      : [];
  }
  const keepStart = Math.floor(boundedLimit / 2);
  const keepEnd = Math.max(0, boundedLimit - keepStart);
  const retained =
    items.length > boundedLimit && boundedTotal === items.length
      ? items
      : items.slice(0, boundedLimit);
  const retainedStart = retained.slice(0, keepStart);
  const retainedEnd =
    keepEnd > 0 ? retained.slice(Math.max(keepStart, retained.length - keepEnd)) : [];
  const omitted = Math.max(0, boundedTotal - retainedStart.length - retainedEnd.length);
  return [
    ...retainedStart.map(mapper),
    ...(omitted > 0 ? [{ omitted, note: "middle entries omitted from prompt context" }] : []),
    ...retainedEnd.map(mapper),
  ];
}

function compactIssue(value: unknown): unknown {
  const issue = asRecord(value);
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.html_url,
    author: login(issue.user),
    authorAssociation: normalizeAuthorAssociation(issue.author_association),
    labels: labelNames(issue.labels),
    comments: issue.comments,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    body: truncateText(issue.body, 12000),
  };
}

function compactComment(value: unknown): unknown {
  const comment = asRecord(value);
  return {
    id: comment.id,
    author: login(comment.user),
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    body: truncateText(comment.body, 6000),
  };
}

function compactTimelineEvent(value: unknown): unknown {
  const event = asRecord(value);
  const sourceIssue = asRecord(asRecord(event.source).issue);
  return {
    id: event.id,
    event: event.event,
    createdAt: event.created_at,
    actor: login(event.actor),
    commitId: event.commit_id,
    label: asRecord(event.label).name,
    rename: event.rename,
    sourceIssue:
      Object.keys(sourceIssue).length > 0
        ? {
            number: sourceIssue.number,
            title: sourceIssue.title,
            url: sourceIssue.html_url,
            state: sourceIssue.state,
          }
        : undefined,
  };
}

function compactPullRequest(value: unknown): unknown {
  const pull = asRecord(value);
  const head = asRecord(pull.head);
  const base = asRecord(pull.base);
  return {
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    mergedAt: pull.merged_at,
    mergeCommitSha: pull.merge_commit_sha,
    mergeable: pull.mergeable,
    author: login(pull.user),
    head: {
      ref: head.ref,
      sha: head.sha,
    },
    base: {
      ref: base.ref,
      sha: base.sha,
    },
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    body: truncateText(pull.body, 12000),
  };
}

interface ClosingPullRequestReference {
  repo: string;
  number: number;
}

export function closingPullRequestReferenceTarget(
  reference: unknown,
  fallbackRepo = targetRepo(),
): ClosingPullRequestReference | null {
  const record = asRecord(reference);
  const number = record.number;
  if (typeof number !== "number" || !Number.isInteger(number)) return null;

  const repository = asRecord(record.repository);
  const owner = asRecord(repository.owner).login;
  const name = repository.name;
  const repo =
    typeof owner === "string" && typeof name === "string" ? `${owner}/${name}` : fallbackRepo;
  return { repo, number };
}

function closingPullRequestReferencesForIssue(number: number): ClosingPullRequestReference[] {
  const issue = ghJson<unknown>([
    "issue",
    "view",
    String(number),
    "--repo",
    targetRepo(),
    "--json",
    "closedByPullRequestsReferences",
  ]);
  const references = asRecord(issue).closedByPullRequestsReferences;
  if (!Array.isArray(references)) return [];
  return references
    .map((reference) => closingPullRequestReferenceTarget(reference))
    .filter((reference): reference is ClosingPullRequestReference => reference !== null);
}

function closingPullRequestsForIssue(number: number): unknown[] {
  const pullRequests: unknown[] = [];
  for (const reference of closingPullRequestReferencesForIssue(number)) {
    try {
      pullRequests.push(
        ghJson<unknown>([
          "api",
          `repos/${reference.repo}/pulls/${reference.number}`,
          "--jq",
          "{number,title,state,html_url,body,user:{login:.user.login},merged:.merged,merged_at:.merged_at,merge_commit_sha:.merge_commit_sha,head:{ref:.head.ref,sha:.head.sha},base:{ref:.base.ref,sha:.base.sha}}",
        ]),
      );
    } catch (error) {
      if (!isGitHubNotFoundError(error)) throw error;
      console.error(
        `Skipping missing closing PR ${reference.repo}#${reference.number} for #${number}`,
      );
    }
  }
  return pullRequests;
}

export function openClosingPullRequestApplyReason(pullRequests: readonly unknown[]): string | null {
  const openPulls = pullRequests
    .map(asRecord)
    .filter((pull) => typeof pull.state === "string" && pull.state.toLowerCase() === "open")
    .map((pull) => ({
      number: typeof pull.number === "number" ? pull.number : null,
      title: typeof pull.title === "string" ? pull.title : "",
    }))
    .filter((pull): pull is { number: number; title: string } => pull.number !== null);
  const first = openPulls[0];
  if (!first) return null;
  const suffix = openPulls.length > 1 ? ` and ${openPulls.length - 1} other open PR(s)` : "";
  return `open PR #${first.number}${first.title ? ` (${first.title})` : ""} is a closing reference${suffix}`;
}

function collectRelatedMentions(options: {
  item: Item;
  issue: unknown;
  comments: unknown[];
  timeline: unknown[];
  pullRequest?: unknown;
  pullReviewComments?: unknown[];
}): Map<number, string[]> {
  const mentions = new Map<number, string[]>();
  const add = (number: number, source: string): void => {
    if (!Number.isInteger(number) || number <= 0 || number === options.item.number) return;
    const current = mentions.get(number) ?? [];
    if (!current.includes(source)) current.push(source);
    mentions.set(number, current);
  };
  const scanText = (value: unknown, source: string): void => {
    if (typeof value !== "string" || !value.trim()) return;
    const [owner, repo] = targetRepo().split("/");
    const escapedRepo = `${escapeRegExp(owner ?? "")}\\/${escapeRegExp(repo ?? "")}`;
    const linked = value.matchAll(
      new RegExp(
        `github\\.com\\/${escapedRepo}\\/(?:issues|pull)\\/(\\d+)|(?<![\\w/])#(\\d+)\\b`,
        "g",
      ),
    );
    for (const match of linked) add(Number(match[1] ?? match[2]), source);
  };

  const issue = asRecord(options.issue);
  scanText(issue.body, "item body");

  options.comments.forEach((comment, index) => {
    scanText(asRecord(comment).body, `comment ${index + 1}`);
  });

  options.pullReviewComments?.forEach((comment, index) => {
    scanText(asRecord(comment).body, `pull review comment ${index + 1}`);
  });

  if (options.pullRequest) {
    scanText(asRecord(options.pullRequest).body, "pull request body");
  }

  options.timeline.forEach((event, index) => {
    const record = asRecord(event);
    scanText(record.body, `timeline ${index + 1}`);
    const sourceIssue = asRecord(asRecord(record.source).issue);
    const number = sourceIssue.number;
    if (typeof number === "number") add(number, `timeline ${index + 1} source issue`);
  });

  return mentions;
}

function compactRelatedItem(number: number, mentionedIn: string[]): Record<string, unknown> | null {
  try {
    const issue = ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${number}`]);
    const issueRecord = asRecord(issue);
    const related: Record<string, unknown> = {
      mentionedIn: mentionedIn.slice(0, 6),
      issue: compactIssue(issue),
      commentCount: issueRecord.comments,
    };

    if (issueRecord.pull_request) {
      try {
        related.pullRequest = compactPullRequest(
          ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]),
        );
      } catch (error) {
        related.pullRequestError = error instanceof Error ? error.message : String(error);
      }
    }

    return related;
  } catch (error) {
    return {
      number,
      mentionedIn: mentionedIn.slice(0, 6),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const RELATED_TITLE_STOP_WORDS = new Set([
  "about",
  "after",
  "allow",
  "already",
  "also",
  "and",
  "are",
  "because",
  "being",
  "bug",
  "cannot",
  "claw",
  "clawhub",
  "claws",
  "codex",
  "does",
  "doesn",
  "don",
  "error",
  "fails",
  "feat",
  "feature",
  "fix",
  "for",
  "from",
  "has",
  "have",
  "into",
  "issue",
  "main",
  "not",
  "openclaw",
  "pr",
  "request",
  "should",
  "that",
  "the",
  "this",
  "through",
  "using",
  "when",
  "with",
  "without",
]);

let localRelatedTitleIndexCache: { repo: string; entries: LocalRelatedTitleEntry[] } | null = null;

export function relatedTitleSearchTerms(title: string, limit = 6): string[] {
  const seen = new Set<string>();
  return relatedTitleCandidateTerms(title)
    .filter((term) => {
      const normalized = trimEdgeChar(term, "_");
      if (RELATED_TITLE_STOP_WORDS.has(normalized)) return false;
      if (isDigitsOnly(normalized)) return false;
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .slice(0, limit);
}

function relatedTitleCandidateTerms(title: string): string[] {
  const lowerTitle = title.toLowerCase();
  const terms: string[] = [];
  let index = 0;

  while (index < lowerTitle.length) {
    if (!isAsciiAlphaNumeric(lowerTitle[index])) {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < lowerTitle.length && isRelatedTitleTermChar(lowerTitle[index])) {
      index += 1;
    }

    if (index - start >= 3) {
      terms.push(lowerTitle.slice(start, index));
    }
  }

  return terms;
}

function isRelatedTitleTermChar(char: string | undefined): boolean {
  return isAsciiAlphaNumeric(char) || char === "_" || char === "-";
}

function isAsciiAlphaNumeric(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

function trimEdgeChar(value: string, char: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === char) start += 1;
  while (end > start && value[end - 1] === char) end -= 1;
  return value.slice(start, end);
}

function isDigitsOnly(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function localRelatedTitleIndex(): LocalRelatedTitleEntry[] {
  if (localRelatedTitleIndexCache?.repo === targetRepo())
    return localRelatedTitleIndexCache.entries;
  const entries: LocalRelatedTitleEntry[] = [];
  for (const [location, dir] of [
    ["items", defaultItemsDir()],
    ["closed", defaultClosedDir()],
  ] as const) {
    for (const file of markdownFiles(dir)) {
      const path = join(dir, file);
      const markdown = readFileSync(path, "utf8");
      if (!isMarkdownForActiveRepo(markdown, file)) continue;
      entries.push({
        number: numberForMarkdownFile(file),
        kind: frontMatterValue(markdown, "type") as ItemKind | undefined,
        title: displayTitle(frontMatterValue(markdown, "title") ?? ""),
        url: frontMatterValue(markdown, "url"),
        author: frontMatterValue(markdown, "author"),
        location,
        path: repoRelativePath(path),
        decision: frontMatterValue(markdown, "decision"),
        closeReason: frontMatterValue(markdown, "close_reason"),
        action: frontMatterValue(markdown, "action_taken"),
        reviewStatus: effectiveReviewStatus(markdown),
        summary: reviewSectionValue(markdown, "summary"),
      });
    }
  }
  localRelatedTitleIndexCache = { repo: targetRepo(), entries };
  return entries;
}

function compactRelatedSearchItems(item: Item, mentioned: Set<number>): unknown[] {
  const terms = relatedTitleSearchTerms(item.title);
  if (terms.length < 2) return [];
  const seen = new Set<number>([item.number, ...mentioned]);
  return localRelatedTitleIndex()
    .flatMap((entry) => {
      if (seen.has(entry.number)) return [];
      const candidateTerms = new Set(relatedTitleSearchTerms(entry.title, 12));
      const overlap = terms.filter((term) => candidateTerms.has(term)).length;
      if (overlap < 2) return [];
      return [{ entry, overlap }];
    })
    .sort((left, right) => right.overlap - left.overlap || left.entry.number - right.entry.number)
    .slice(0, 5)
    .map(({ entry, overlap }) => ({
      mentionedIn: ["local title search"],
      titleSearchOverlap: overlap,
      localReport: {
        ...entry,
        reportUrl: reportUrl(`/blob/main/${entry.path}`),
      },
    }));
}

function relatedItemsContext(options: {
  item: Item;
  issue: unknown;
  comments: unknown[];
  timeline: unknown[];
  pullRequest?: unknown;
  pullReviewComments?: unknown[];
}): unknown[] {
  const mentions = collectRelatedMentions(options);
  const explicitRelated = [...mentions.entries()]
    .sort(([left], [right]) => left - right)
    .slice(0, 10)
    .map(([number, mentionedIn]) => compactRelatedItem(number, mentionedIn))
    .filter((entry) => entry !== null);
  const searchedRelated = compactRelatedSearchItems(options.item, new Set(mentions.keys()));
  return [...explicitRelated, ...searchedRelated].slice(0, 12);
}

function normalizeAuthorLogin(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function relatedCounterpartInfo(value: unknown): {
  number: number | null;
  kind: ItemKind | null;
  author: string | null;
  state: string;
  title: string;
} {
  const record = asRecord(value);
  const localReport = asRecord(record.localReport);
  if (Object.keys(localReport).length > 0) {
    const kind =
      localReport.kind === "issue" || localReport.kind === "pull_request" ? localReport.kind : null;
    return {
      number: typeof localReport.number === "number" ? localReport.number : null,
      kind,
      author: normalizeAuthorLogin(localReport.author),
      state: localReport.location === "items" ? "open" : "closed",
      title: typeof localReport.title === "string" ? localReport.title : "",
    };
  }

  const issue = asRecord(record.issue);
  const pullRequest = asRecord(record.pullRequest);
  const isPullRequest = Object.keys(pullRequest).length > 0;
  const state = isPullRequest ? pullRequest.state : issue.state;
  return {
    number: typeof issue.number === "number" ? issue.number : null,
    kind: isPullRequest ? "pull_request" : "issue",
    author: normalizeAuthorLogin(isPullRequest ? pullRequest.author : issue.author),
    state: typeof state === "string" ? state.toLowerCase() : "",
    title: typeof issue.title === "string" ? issue.title : "",
  };
}

function itemKindLabel(kind: ItemKind): string {
  return kind === "pull_request" ? "PR" : "issue";
}

export function sameAuthorCounterpartApplyReason(
  item: Pick<Item, "number" | "kind" | "author">,
  relatedItems: readonly unknown[],
): string | null {
  const itemAuthor = normalizeAuthorLogin(item.author);
  if (!itemAuthor) return null;
  for (const relatedItem of relatedItems) {
    const related = relatedCounterpartInfo(relatedItem);
    if (related.number === null || related.number === item.number) continue;
    if (!related.kind || related.kind === item.kind) continue;
    if (related.state !== "open") continue;
    if (related.author !== itemAuthor) continue;
    return `open ${itemKindLabel(related.kind)} #${related.number}${related.title ? ` (${related.title})` : ""} by the same author is paired with this ${itemKindLabel(item.kind)}`;
  }
  return null;
}

function compactPullFile(value: unknown): unknown {
  const file = asRecord(value);
  return {
    filename: file.filename,
    previous_filename: file.previous_filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: truncateText(file.patch, 2000),
  };
}

function compactPullFilePaths(value: unknown): string[] {
  const file = asRecord(value);
  return [file.filename, file.previous_filename].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
}

function compactPullCommit(value: unknown): unknown {
  const commit = asRecord(value);
  const commitInfo = asRecord(commit.commit);
  return {
    sha: commit.sha,
    author: login(commit.author),
    message: truncateText(commitInfo.message, 1000),
  };
}

export function githubPaginatedPath(path: string): string {
  const [basePart, query = ""] = path.split("?", 2);
  const base = basePart ?? path;
  const params = new URLSearchParams(query);
  if (!params.has("per_page")) params.set("per_page", "100");
  const serialized = params.toString();
  return serialized ? `${base}?${serialized}` : base;
}

function githubPagePath(path: string, page: number, perPage = 100): string {
  const [basePart, query = ""] = path.split("?", 2);
  const base = basePart ?? path;
  const params = new URLSearchParams(query);
  params.set("per_page", String(Math.max(1, Math.floor(perPage))));
  params.set("page", String(Math.max(1, Math.floor(page))));
  const serialized = params.toString();
  return serialized ? `${base}?${serialized}` : base;
}

function ghPaged<T>(path: string): T[] {
  const pages = ghJson<unknown[]>(["api", githubPaginatedPath(path), "--paginate", "--slurp"]);
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page) => (Array.isArray(page) ? (page as T[]) : []));
}

export interface ContextHydration<T> {
  items: T[];
  total: number;
  hydrated: number;
  truncated: boolean;
}

function ghPage<T>(path: string, page: number): T[] {
  const items = ghJson<unknown[]>(["api", githubPagePath(path, page)]);
  return Array.isArray(items) ? (items as T[]) : [];
}

export interface GithubPageWithHeaders<T> {
  items: T[];
  lastPageNumber: number | null;
}

export function githubLinkLastPageNumber(header: string | undefined): number | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    if (!part.includes('rel="last"')) continue;
    const page = part.match(/[?&]page=(\d+)/)?.[1];
    if (!page) continue;
    const value = Number(page);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function ghPageWithHeaders<T>(path: string, page: number, perPage = 100): GithubPageWithHeaders<T> {
  const apiPath = githubPagePath(path, page, perPage);
  const output = ghWithRetry(["api", "-i", apiPath]);
  const normalized = output.replace(/\r\n/g, "\n");
  const separator = normalized.lastIndexOf("\n\n");
  const headerText = separator >= 0 ? normalized.slice(0, separator) : "";
  const bodyText = separator >= 0 ? normalized.slice(separator + 2) : normalized;
  let linkHeader: string | undefined;
  for (const line of headerText.split("\n")) {
    const delimiter = line.indexOf(":");
    if (delimiter <= 0) continue;
    if (line.slice(0, delimiter).trim().toLowerCase() === "link") {
      linkHeader = line.slice(delimiter + 1).trim();
    }
  }
  const parsed = parseGhJson<unknown>(bodyText, ["api", "-i", apiPath]);
  return {
    items: Array.isArray(parsed) ? (parsed as T[]) : [],
    lastPageNumber: githubLinkLastPageNumber(linkHeader),
  };
}

function githubCount(value: unknown): number | null {
  const count =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(count) || count < 0) return null;
  return Math.floor(count);
}

interface GithubContextWindowPlan {
  keepStart: number;
  keepEnd: number;
  tailFirstPageNumber: number;
  lastPageNumber: number;
  tailOffset: number;
}

export function githubContextWindowPlan(
  total: number,
  promptLimit: number,
  perPage = 100,
): GithubContextWindowPlan {
  const boundedTotal = Math.max(0, Math.floor(total));
  const boundedLimit = Math.max(0, Math.floor(promptLimit));
  const boundedPerPage = Math.max(1, Math.floor(perPage));
  const keepStart = Math.floor(boundedLimit / 2);
  const keepEnd = Math.max(0, boundedLimit - keepStart);
  const tailStartIndex = Math.max(0, boundedTotal - keepEnd);
  const tailFirstPageNumber = Math.floor(tailStartIndex / boundedPerPage) + 1;
  return {
    keepStart,
    keepEnd,
    tailFirstPageNumber,
    lastPageNumber: Math.max(1, Math.ceil(boundedTotal / boundedPerPage)),
    tailOffset: tailStartIndex - (tailFirstPageNumber - 1) * boundedPerPage,
  };
}

export function ghPagedContextWindow<T>(
  path: string,
  totalCount: unknown,
  promptLimit: number,
  fetchers: {
    page?: (path: string, page: number) => T[];
    paged?: (path: string) => T[];
  } = {},
): ContextHydration<T> {
  const fetchPage = fetchers.page ?? ghPage<T>;
  const fetchPaged = fetchers.paged ?? ghPaged<T>;
  const total = githubCount(totalCount);
  const boundedLimit = Math.max(0, Math.floor(promptLimit));
  if (total === null) {
    const items = fetchPaged(path);
    return { items, total: items.length, hydrated: items.length, truncated: false };
  }
  if (total === 0 || boundedLimit === 0) {
    return { items: [], total, hydrated: 0, truncated: total > 0 };
  }
  if (total <= boundedLimit) {
    const items = total <= 100 ? fetchPage(path, 1) : fetchPaged(path);
    return {
      items,
      total: Math.max(total, items.length),
      hydrated: items.length,
      truncated: false,
    };
  }

  const plan = githubContextWindowPlan(total, boundedLimit);
  const firstPage = plan.keepStart > 0 ? fetchPage(path, 1) : [];
  const headItems = firstPage.slice(0, plan.keepStart);
  const tailPages: T[] = [];
  if (plan.keepEnd > 0) {
    for (let page = plan.tailFirstPageNumber; page <= plan.lastPageNumber; page += 1) {
      tailPages.push(...(page === 1 && plan.keepStart > 0 ? firstPage : fetchPage(path, page)));
    }
  }
  const tailItems = tailPages.slice(plan.tailOffset, plan.tailOffset + plan.keepEnd);
  const items = [...headItems, ...tailItems];
  return {
    items,
    total,
    hydrated: items.length,
    truncated: total > items.length,
  };
}

export function ghPagedLinkHeaderContextWindow<T>(
  path: string,
  promptLimit: number,
  fetchers: {
    pageWithHeaders?: (path: string, page: number, perPage: number) => GithubPageWithHeaders<T>;
    paged?: (path: string) => T[];
  } = {},
): ContextHydration<T> {
  const fetchPage = fetchers.pageWithHeaders ?? ghPageWithHeaders<T>;
  const fetchPaged = fetchers.paged ?? ghPaged<T>;
  const boundedLimit = Math.max(0, Math.floor(promptLimit));
  const perPage = 100;
  const pages = new Map<number, T[]>();
  const readPage = (page: number): GithubPageWithHeaders<T> => {
    const cached = pages.get(page);
    if (cached) return { items: cached, lastPageNumber: null };
    const result = fetchPage(path, page, perPage);
    pages.set(page, result.items);
    return result;
  };

  const first = readPage(1);
  const lastPageNumber = first.lastPageNumber ?? (first.items.length < perPage ? 1 : null);
  if (lastPageNumber === null) {
    const items = fetchPaged(path);
    return { items, total: items.length, hydrated: items.length, truncated: false };
  }

  const lastPage = Math.max(1, lastPageNumber);
  const lastItems = lastPage === 1 ? first.items : readPage(lastPage).items;
  const total = Math.max(0, (lastPage - 1) * perPage + lastItems.length);
  if (total === 0 || boundedLimit === 0) {
    return { items: [], total, hydrated: 0, truncated: total > 0 };
  }

  if (total <= boundedLimit) {
    const items: T[] = [];
    for (let page = 1; page <= lastPage; page += 1) {
      items.push(...(page === 1 ? first.items : readPage(page).items));
    }
    return {
      items,
      total: Math.max(total, items.length),
      hydrated: items.length,
      truncated: false,
    };
  }

  const plan = githubContextWindowPlan(total, boundedLimit, perPage);
  const headItems = first.items.slice(0, plan.keepStart);
  const tailPages: T[] = [];
  if (plan.keepEnd > 0) {
    for (let page = plan.tailFirstPageNumber; page <= plan.lastPageNumber; page += 1) {
      tailPages.push(...(page === 1 ? first.items : readPage(page).items));
    }
  }
  const tailItems = tailPages.slice(plan.tailOffset, plan.tailOffset + plan.keepEnd);
  const items = [...headItems, ...tailItems];
  return {
    items,
    total,
    hydrated: items.length,
    truncated: total > items.length,
  };
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function frontMatterValue(markdown: string, key: string): string | undefined {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  const value = match?.[1]?.trim();
  return value?.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

export function applyDecisionPriority(markdown: string, applyKind: ApplyKind): number {
  const closeReason = frontMatterValue(markdown, "close_reason") as CloseReason | undefined;
  const itemKind = frontMatterValue(markdown, "type") as ItemKind | undefined;
  const profile = repositoryProfileFor(markdownRepository(markdown));
  const isCloseProposal =
    frontMatterValue(markdown, "decision") === "close" &&
    frontMatterValue(markdown, "confidence") === "high" &&
    frontMatterValue(markdown, "action_taken") === "proposed_close" &&
    Boolean(
      closeReason &&
      itemKind &&
      ALLOWED_REASONS.has(closeReason) &&
      isAutoCloseAllowed(profile, itemKind, closeReason),
    );
  if (!isCloseProposal) return 2;
  if (applyKind === "all" || itemKind === applyKind || !itemKind) return 0;
  return 1;
}

function applyQueueSortFields(markdown: string, syncCommentsOnly: boolean, applyKind: ApplyKind) {
  const checkedAt = Date.parse(frontMatterValue(markdown, "apply_checked_at") ?? "");
  return {
    priority: syncCommentsOnly ? 0 : applyDecisionPriority(markdown, applyKind),
    applyCheckedAt: Number.isFinite(checkedAt) ? checkedAt : 0,
  };
}

export function shouldSyncReviewComment(options: {
  syncCommentsOnly: boolean;
  isCloseProposal: boolean;
  commentSyncMinAgeDays: number;
  reviewCommentSyncedAt: string | undefined;
  hasExistingReviewComment: boolean;
  needsReviewCommentBodySync: boolean;
  needsReviewCommentHashSync: boolean;
  needsReviewCommentReferenceSync: boolean;
  now?: number;
}): boolean {
  if (
    !options.needsReviewCommentBodySync &&
    !options.needsReviewCommentHashSync &&
    !options.needsReviewCommentReferenceSync
  ) {
    return false;
  }
  if (!options.syncCommentsOnly || options.isCloseProposal) return true;
  if (!options.hasExistingReviewComment || options.needsReviewCommentReferenceSync) return true;
  if (options.commentSyncMinAgeDays <= 0) return true;
  if (!options.reviewCommentSyncedAt) return true;
  return isOlderThanDays(options.reviewCommentSyncedAt, options.commentSyncMinAgeDays, options.now);
}

function replaceFrontMatterValue(markdown: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${key}:\\s*.*$`, "m");
  if (pattern.test(markdown)) return markdown.replace(pattern, line);
  return markdown.replace(/^---\n/, `---\n${line}\n`);
}

function sectionValue(markdown: string, heading: string): string {
  const match = markdown.match(
    new RegExp(`(?:^|\\n)## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |\\n?$)`),
  );
  return match?.[1]?.trim() ?? "";
}

function reviewSectionValue(markdown: string, section: ReviewSection): string {
  return sectionValue(markdown, REVIEW_SECTIONS[section]);
}

function replaceSectionValue(markdown: string, heading: string, value: string): string {
  const pattern = new RegExp(`((?:^|\\n)## ${heading}\\n\\n)([\\s\\S]*?)(?=\\n## |\\n?$)`);
  if (pattern.test(markdown)) return markdown.replace(pattern, `$1${value.trim()}\n`);
  return `${markdown.trimEnd()}\n\n## ${heading}\n\n${value.trim()}\n`;
}

function frontMatterStringArray(markdown: string, key: string): string[] {
  const value = frontMatterValue(markdown, key);
  if (!value || value === "none") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // Older reports used plain comma-separated labels.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function frontMatterBoolean(markdown: string, key: string): boolean {
  return /^true$/i.test(frontMatterValue(markdown, key) ?? "");
}

function existingReview(
  item: Pick<Item, "number" | "repo">,
  itemsDir: string,
): ExistingReview | null {
  const candidates = [join(itemsDir, reportFileName(item.repo, item.number))];
  const path = candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    const markdown = readFileSync(candidate, "utf8");
    return markdownRepository(markdown, candidate) === item.repo;
  });
  if (!path) return null;
  const markdown = readFileSync(path, "utf8");
  return {
    path,
    markdown,
    reviewedAt: frontMatterValue(markdown, "reviewed_at"),
    itemUpdatedAt: frontMatterValue(markdown, "item_updated_at"),
    reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
    labelsSyncedAt: frontMatterValue(markdown, "labels_synced_at"),
    decision: frontMatterValue(markdown, "decision"),
    reviewStatus: effectiveReviewStatus(markdown),
    reviewPolicy: frontMatterValue(markdown, "review_policy"),
  };
}

interface ExistingReviewIndex {
  byKey: Map<string, ExistingReview>;
}

function existingReviewKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function buildExistingReviewIndex(itemsDir: string): ExistingReviewIndex {
  const byKey = new Map<string, ExistingReview>();
  for (const file of markdownFiles(itemsDir)) {
    const path = join(itemsDir, file);
    const markdown = readFileSync(path, "utf8");
    const repo = markdownRepository(markdown, path);
    const number = numberForMarkdownFile(file);
    byKey.set(existingReviewKey(repo, number), {
      path,
      markdown,
      reviewedAt: frontMatterValue(markdown, "reviewed_at"),
      itemUpdatedAt: frontMatterValue(markdown, "item_updated_at"),
      reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
      labelsSyncedAt: frontMatterValue(markdown, "labels_synced_at"),
      decision: frontMatterValue(markdown, "decision"),
      reviewStatus: effectiveReviewStatus(markdown),
      reviewPolicy: frontMatterValue(markdown, "review_policy"),
    });
  }
  return { byKey };
}

function indexedExistingReview(
  item: Pick<Item, "number" | "repo">,
  itemsDir: string,
  reviewIndex?: ExistingReviewIndex,
): ExistingReview | null {
  return (
    reviewIndex?.byKey.get(existingReviewKey(item.repo, item.number)) ??
    existingReview(item, itemsDir)
  );
}

function inferReviewStatus(markdown: string): string {
  return markdown.includes("Codex review failed") ? "failed" : "complete";
}

function hasBlockedLocalCheckoutAccess(markdown: string): boolean {
  return /bwrap: loopback|sandbox wrapper|sandbox startup failed|sandboxed shell failed|local shell (?:access|commands|inspection).*unavailable|local shell .*blocked|local terminal commands were unavailable|could not run local shell/i.test(
    markdown,
  );
}

function hasVerifiedLocalCheckoutAccess(markdown: string): boolean {
  return frontMatterValue(markdown, "local_checkout_access") === "verified";
}

function effectiveReviewStatus(markdown: string): string {
  const status = frontMatterValue(markdown, "review_status") ?? inferReviewStatus(markdown);
  if (status === "complete") {
    if (hasBlockedLocalCheckoutAccess(markdown)) return "stale_local_checkout_blocked";
    if (!hasVerifiedLocalCheckoutAccess(markdown)) return "stale_local_checkout_unverified";
  }
  return status;
}

function isFresh(
  review: { reviewedAt: string | undefined; reviewStatus: string | undefined } | null,
): boolean {
  if (review?.reviewStatus !== "complete") return false;
  if (!review?.reviewedAt) return false;
  const reviewedAt = Date.parse(review.reviewedAt);
  if (!Number.isFinite(reviewedAt)) return false;
  return Date.now() - reviewedAt < FRESH_DAYS * DAY_MS;
}

function isCurrentForCadence(options: {
  reviewedAt: string | undefined;
  reviewStatus: string | undefined;
  cadenceMs: number;
  now: number;
}): boolean {
  if (options.reviewStatus !== "complete") return false;
  if (!options.reviewedAt) return false;
  const reviewedAt = Date.parse(options.reviewedAt);
  if (!Number.isFinite(reviewedAt)) return false;
  return options.now - reviewedAt < options.cadenceMs;
}

function reviewedAtMs(review: ExistingReview | null): number | null {
  if (review?.reviewStatus !== "complete") return null;
  if (!review.reviewedAt) return null;
  const reviewedAt = Date.parse(review.reviewedAt);
  return Number.isFinite(reviewedAt) ? reviewedAt : null;
}

function hasActivitySinceReview(item: Item, review: ExistingReview | null): boolean {
  if (!review) return false;
  const updatedAt = Date.parse(item.updatedAt);
  const reviewedAt = reviewedAtMs(review);
  const reviewCommentSyncedAt = timestampMs(review.reviewCommentSyncedAt);
  const labelsSyncedAt = timestampMs(review.labelsSyncedAt);
  const botOwnedSyncedAt = Math.max(
    reviewCommentSyncedAt ?? -Infinity,
    labelsSyncedAt ?? -Infinity,
  );
  if (review.itemUpdatedAt) {
    if (item.updatedAt === review.itemUpdatedAt) return false;
    if (Number.isFinite(updatedAt) && reviewedAt !== null && updatedAt <= reviewedAt) return false;
    if (
      Number.isFinite(updatedAt) &&
      Number.isFinite(botOwnedSyncedAt) &&
      updatedAt <= botOwnedSyncedAt
    ) {
      return false;
    }
    return true;
  }
  if (
    Number.isFinite(updatedAt) &&
    Number.isFinite(botOwnedSyncedAt) &&
    updatedAt <= botOwnedSyncedAt
  ) {
    return false;
  }
  return reviewedAt !== null && Number.isFinite(updatedAt) && updatedAt > reviewedAt;
}

function isCreatedWithinDays(
  item: Pick<Item, "createdAt">,
  days: number,
  now = Date.now(),
): boolean {
  const createdAt = Date.parse(item.createdAt);
  return Number.isFinite(createdAt) && now - createdAt < days * DAY_MS;
}

function reviewCadenceMs(item: Item, review: ExistingReview | null, now = Date.now()): number {
  if (hasActivitySinceReview(item, review)) return HOURLY_REVIEW_MS;
  if (isCreatedWithinDays(item, HOT_REVIEW_DAYS, now)) return DAILY_REVIEW_DAYS * DAY_MS;
  if (item.kind === "pull_request") return DAILY_REVIEW_DAYS * DAY_MS;
  const createdAt = Date.parse(item.createdAt);
  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) {
    return DAILY_REVIEW_DAYS * DAY_MS;
  }
  return WEEKLY_REVIEW_DAYS * DAY_MS;
}

function hasReviewPolicyMismatch(review: ExistingReview | null, reviewPolicy?: string): boolean {
  return Boolean(review && reviewPolicy && review.reviewPolicy !== reviewPolicy);
}

export function shouldReviewItem(
  item: Item,
  review: ExistingReview | null,
  now = Date.now(),
  reviewPolicy?: string,
): boolean {
  if (hasReviewPolicyMismatch(review, reviewPolicy)) return true;
  const reviewedAt = reviewedAtMs(review);
  if (reviewedAt === null) return true;
  return now - reviewedAt >= reviewCadenceMs(item, review, now);
}

export function reviewPriority(
  item: Item,
  review: ExistingReview | null,
  now = Date.now(),
  reviewPolicy?: string,
): number {
  if (isCreatedWithinDays(item, HOT_REVIEW_DAYS, now) && item.kind === "issue") return 0;
  if (isCreatedWithinDays(item, HOT_REVIEW_DAYS, now)) return 1;
  if (hasActivitySinceReview(item, review)) return 2;
  if (item.kind === "pull_request") return 3;
  const createdAt = Date.parse(item.createdAt);
  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) return 4;
  if (hasReviewPolicyMismatch(review, reviewPolicy)) return 5;
  return 6;
}

function schedulerBucket(
  item: Item,
  review: ExistingReview | null,
  now = Date.now(),
): SchedulerBucket {
  if (isCreatedWithinDays(item, HOT_REVIEW_DAYS, now)) {
    return item.kind === "issue" ? "hot_issue" : "hot_pull_request";
  }
  if (hasActivitySinceReview(item, review)) return "activity";
  if (item.kind === "pull_request") return "daily_pull_request";
  const createdAt = Date.parse(item.createdAt);
  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) {
    return "recent_issue";
  }
  return "weekly_issue";
}

function nextReviewDueAtMs(
  item: Item,
  review: ExistingReview | null,
  now = Date.now(),
  reviewPolicy?: string,
): number {
  if (hasReviewPolicyMismatch(review, reviewPolicy)) return 0;
  const reviewedAt = reviewedAtMs(review);
  if (reviewedAt === null) return 0;
  return reviewedAt + reviewCadenceMs(item, review, now);
}

function dueCandidate(
  item: Item,
  itemsDir: string,
  now = Date.now(),
  reviewPolicy?: string,
  reviewIndex?: ExistingReviewIndex,
): DueCandidate | null {
  const review = indexedExistingReview(item, itemsDir, reviewIndex);
  if (!shouldReviewItem(item, review, now, reviewPolicy)) return null;
  return {
    item,
    review,
    priority: reviewPriority(item, review, now, reviewPolicy),
    reviewedAt: reviewedAtMs(review) ?? 0,
    nextDueAt: nextReviewDueAtMs(item, review, now, reviewPolicy),
    bucket: schedulerBucket(item, review, now),
  };
}

function reviewBackfillCandidate(
  item: Item,
  itemsDir: string,
  now = Date.now(),
  reviewPolicy?: string,
  minReviewAgeMs = 0,
  reviewIndex?: ExistingReviewIndex,
): DueCandidate | null {
  const review = indexedExistingReview(item, itemsDir, reviewIndex);
  if (!review || hasReviewPolicyMismatch(review, reviewPolicy)) return null;
  const reviewedAt = reviewedAtMs(review);
  if (reviewedAt === null) return null;
  if (now - reviewedAt < minReviewAgeMs) return null;
  if (shouldReviewItem(item, review, now, reviewPolicy)) return null;
  return {
    item,
    review,
    priority: reviewPriority(item, review, now, reviewPolicy),
    reviewedAt,
    nextDueAt: nextReviewDueAtMs(item, review, now, reviewPolicy),
    bucket: schedulerBucket(item, review, now),
  };
}

function compareDueCandidates(left: DueCandidate, right: DueCandidate): number {
  return (
    left.priority - right.priority ||
    left.nextDueAt - right.nextDueAt ||
    left.reviewedAt - right.reviewedAt ||
    left.item.number - right.item.number
  );
}

function compareBackfillCandidates(left: DueCandidate, right: DueCandidate): number {
  return (
    left.nextDueAt - right.nextDueAt ||
    left.reviewedAt - right.reviewedAt ||
    left.priority - right.priority ||
    left.item.number - right.item.number
  );
}

const SCHEDULER_BUCKET_WEIGHTS: ReadonlyArray<readonly [SchedulerBucket, number]> = [
  ["hot_issue", 4],
  ["hot_pull_request", 2],
  ["activity", 2],
  ["daily_pull_request", 3],
  ["recent_issue", 2],
  ["weekly_issue", 1],
];

function selectDueCandidates(
  due: DueCandidate[],
  limit: number,
  compare: (left: DueCandidate, right: DueCandidate) => number = compareDueCandidates,
): DueCandidate[] {
  const capacity = Math.max(0, limit);
  if (capacity === 0) return [];
  const buckets = new Map<SchedulerBucket, DueCandidate[]>();
  for (const [bucket] of SCHEDULER_BUCKET_WEIGHTS) buckets.set(bucket, []);
  for (const candidate of due) buckets.get(candidate.bucket)?.push(candidate);
  for (const candidates of buckets.values()) candidates.sort(compare);

  const selected: DueCandidate[] = [];
  const selectedKeys = new Set<string>();
  const take = (candidate: DueCandidate | undefined): void => {
    if (!candidate || selected.length >= capacity) return;
    const key = existingReviewKey(candidate.item.repo, candidate.item.number);
    if (selectedKeys.has(key)) return;
    selectedKeys.add(key);
    selected.push(candidate);
  };

  while (selected.length < capacity) {
    const before = selected.length;
    for (const [bucket, weight] of SCHEDULER_BUCKET_WEIGHTS) {
      const candidates = buckets.get(bucket);
      if (!candidates?.length) continue;
      for (let i = 0; i < weight && candidates.length && selected.length < capacity; i += 1) {
        take(candidates.shift());
      }
    }
    if (selected.length === before) break;
  }

  return selected;
}

function appendFloorBackfillCandidates(
  selected: DueCandidate[],
  backfill: DueCandidate[],
  options: { activeFloor: number; capacity: number },
): DueCandidate[] {
  const activeFloor = Math.max(0, Math.floor(options.activeFloor));
  const capacity = Math.max(0, Math.floor(options.capacity));
  const target = Math.min(activeFloor, capacity);
  if (selected.length >= target) return selected;
  const selectedKeys = new Set(
    selected.map((candidate) => existingReviewKey(candidate.item.repo, candidate.item.number)),
  );
  const filled = [...selected];
  for (const candidate of [...backfill].sort(compareBackfillCandidates)) {
    if (filled.length >= target) break;
    const key = existingReviewKey(candidate.item.repo, candidate.item.number);
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    filled.push(candidate);
  }
  return filled;
}

export function selectDueCandidateNumbersForTest(
  due: Array<{
    item: Item;
    bucket: SchedulerBucket;
    priority?: number;
    reviewedAt?: number;
    nextDueAt?: number;
  }>,
  limit: number,
): number[] {
  return selectDueCandidates(
    due.map((candidate) => ({
      item: candidate.item,
      review: null,
      priority: candidate.priority ?? reviewPriority(candidate.item, null),
      reviewedAt: candidate.reviewedAt ?? 0,
      nextDueAt: candidate.nextDueAt ?? 0,
      bucket: candidate.bucket,
    })),
    limit,
  ).map((candidate) => candidate.item.number);
}

export function appendFloorBackfillCandidateNumbersForTest(
  selected: Array<{
    item: Item;
    bucket: SchedulerBucket;
    priority?: number;
    reviewedAt?: number;
    nextDueAt?: number;
  }>,
  backfill: Array<{
    item: Item;
    bucket: SchedulerBucket;
    priority?: number;
    reviewedAt?: number;
    nextDueAt?: number;
  }>,
  activeFloor: number,
  capacity: number,
): number[] {
  const normalize = (candidate: (typeof selected)[number]): DueCandidate => ({
    item: candidate.item,
    review: null,
    priority: candidate.priority ?? reviewPriority(candidate.item, null),
    reviewedAt: candidate.reviewedAt ?? 0,
    nextDueAt: candidate.nextDueAt ?? 0,
    bucket: candidate.bucket,
  });
  return appendFloorBackfillCandidates(selected.map(normalize), backfill.map(normalize), {
    activeFloor,
    capacity,
  }).map((candidate) => candidate.item.number);
}

function compareHotIntakeDueCandidates(left: DueCandidate, right: DueCandidate): number {
  return (
    left.priority - right.priority ||
    hotIntakeRecencyMs(right.item) - hotIntakeRecencyMs(left.item) ||
    right.item.number - left.item.number
  );
}

export function hotIntakeRecencyMs(item: Pick<Item, "createdAt" | "updatedAt">): number {
  const updatedAt = Date.parse(item.updatedAt);
  const createdAt = Date.parse(item.createdAt);
  return Math.max(
    Number.isFinite(updatedAt) ? updatedAt : 0,
    Number.isFinite(createdAt) ? createdAt : 0,
  );
}

function fetchOpenItemPage(
  page: number,
  sort: "created" | "updated" = "created",
  direction: "asc" | "desc" = "asc",
): Item[] {
  const items = ghJsonLines<GitHubIssueListItem>([
    "api",
    `repos/${targetRepo()}/issues?state=open&sort=${sort}&direction=${direction}&per_page=100&page=${page}`,
    "--jq",
    ".[] | {number,title,html_url,created_at,updated_at,author_association,user:{login:.user.login},labels:[.labels[].name],pull_request:(.pull_request // null)}",
  ]);
  return items
    .map((item) => ({
      repo: targetRepo(),
      number: item.number,
      kind: item.pull_request ? ("pull_request" as const) : ("issue" as const),
      title: item.title,
      url: item.html_url,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      author: item.user?.login ?? "unknown",
      authorAssociation: normalizeAuthorAssociation(item.author_association),
      labels: item.labels ?? [],
    }))
    .sort((a, b) => a.number - b.number);
}

function fetchOpenItems(maxPages: number): {
  items: Item[];
  pagesScanned: number;
  complete: boolean;
} {
  const items: Item[] = [];
  let pagesScanned = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const pageItems = fetchOpenItemPage(page);
    pagesScanned = page;
    items.push(...pageItems);
    if (pageItems.length === 0 || pageItems.length < 100) {
      return { items, pagesScanned, complete: true };
    }
  }
  return { items, pagesScanned, complete: false };
}

function fetchHotIntakeItems(maxPages: number): { items: Item[]; pagesScanned: number } {
  const byNumber = new Map<number, Item>();
  let pagesScanned = 0;
  for (const sort of ["created", "updated"] as const) {
    for (let page = 1; page <= maxPages; page += 1) {
      const pageItems = fetchOpenItemPage(page, sort, "desc");
      pagesScanned = Math.max(pagesScanned, page);
      for (const item of pageItems) byNumber.set(item.number, item);
      if (pageItems.length === 0 || pageItems.length < 100) break;
    }
  }
  return {
    items: [...byNumber.values()].sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.number - left.number,
    ),
    pagesScanned,
  };
}

function fetchOpenItemNumbers(maxPages: number): { numbers: Set<number>; pagesScanned: number } {
  const result = fetchOpenItems(maxPages);
  if (!result.complete) {
    throw new Error(
      `Open item scan reached max_pages=${maxPages} before the final page; refusing to reconcile folders from a partial scan.`,
    );
  }
  return {
    numbers: new Set(result.items.map((item) => item.number)),
    pagesScanned: result.pagesScanned,
  };
}

function fetchItem(number: number): { item: Item; state: string } {
  const issue = ghJson<
    GitHubIssueListItem & {
      active_lock_reason?: string | null;
      locked?: boolean;
      state?: string;
    }
  >([
    "api",
    `repos/${targetRepo()}/issues/${number}`,
    "--jq",
    "{number,title,html_url,created_at,updated_at,closed_at,state,locked,active_lock_reason,author_association,user:{login:.user.login},labels:[.labels[].name],pull_request:(.pull_request // null)}",
  ]);
  return {
    item: {
      repo: targetRepo(),
      number: issue.number,
      kind: issue.pull_request ? "pull_request" : "issue",
      title: issue.title,
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      author: issue.user?.login ?? "unknown",
      authorAssociation: normalizeAuthorAssociation(issue.author_association),
      labels: issue.labels ?? [],
      locked: issue.locked === true,
      activeLockReason: issue.active_lock_reason ?? null,
    },
    state: issue.state ?? "unknown",
  };
}

function fetchOpenItemCounts(): OpenItemCounts {
  const [owner, name] = targetRepo().split("/");
  if (!owner || !name) throw new Error(`Invalid target repo: ${targetRepo()}`);
  const result = ghJson<RepoOpenCountsQuery>([
    "api",
    "graphql",
    "-f",
    `query=query { repository(owner: "${owner}", name: "${name}") { issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount } } }`,
  ]);
  const repository = result.data?.repository;
  const issues = repository?.issues?.totalCount ?? 0;
  const pullRequests = repository?.pullRequests?.totalCount ?? 0;
  return {
    issues,
    pullRequests,
    total: issues + pullRequests,
  };
}

function emptyDashboardKindStats(): DashboardKindStats {
  return {
    total: 0,
    fresh: 0,
    proposedClose: 0,
  };
}

function emptyDashboardCadenceBucket(): DashboardCadenceBucket {
  return {
    total: 0,
    current: 0,
    proposedClose: 0,
  };
}

function emptyDashboardActivityBucket(): DashboardActivityBucket {
  return {
    reviews: 0,
    closeDecisions: 0,
    keepOpenDecisions: 0,
    failedOrStaleReviews: 0,
    closes: 0,
    commentSyncs: 0,
    applySkips: 0,
  };
}

function emptyDashboardActivityStats(): DashboardActivityStats {
  return {
    last15Minutes: emptyDashboardActivityBucket(),
    lastHour: emptyDashboardActivityBucket(),
    last24Hours: emptyDashboardActivityBucket(),
    latestReviewAt: undefined,
    latestCloseAt: undefined,
    latestCommentSyncAt: undefined,
  };
}

function addDashboardCadenceBucket(
  target: DashboardCadenceBucket,
  source: DashboardCadenceBucket,
): void {
  target.total += source.total;
  target.current += source.current;
  target.proposedClose += source.proposedClose;
}

function capDashboardCadenceBucket(
  bucket: DashboardCadenceBucket,
  totalLimit: number,
): DashboardCadenceBucket {
  const total = Math.min(bucket.total, totalLimit);
  return {
    total,
    current: Math.min(bucket.current, total),
    proposedClose: Math.min(bucket.proposedClose, total),
  };
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "-";
  return `${((numerator / denominator) * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

function formatCadenceBucket(bucket: DashboardCadenceBucket): string {
  const due = bucket.total - bucket.current;
  return `${bucket.current}/${bucket.total} current (${due} due, ${formatPercent(bucket.current, bucket.total)})`;
}

function timestampMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWithinWindow(timestamp: number | null, now: number, windowMs: number): boolean {
  return timestamp !== null && timestamp <= now && now - timestamp <= windowMs;
}

function latestTimestamp(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  const candidateMs = timestampMs(candidate);
  if (candidateMs === null) return current;
  const currentMs = timestampMs(current);
  return currentMs === null || candidateMs > currentMs ? candidate : current;
}

function recordDashboardActivity(
  markdown: string,
  activity: DashboardActivityStats,
  now: number,
): void {
  const reviewedAt = frontMatterValue(markdown, "reviewed_at");
  const reviewedAtMs = timestampMs(reviewedAt);
  const closedAt = dashboardClosedAt(markdown);
  const closedAtMs = timestampMs(closedAt);
  const commentSyncedAt = frontMatterValue(markdown, "review_comment_synced_at");
  const commentSyncedAtMs = timestampMs(commentSyncedAt);
  const applyCheckedAt = frontMatterValue(markdown, "apply_checked_at");
  const applyCheckedAtMs = timestampMs(applyCheckedAt);
  const decision = frontMatterValue(markdown, "decision") ?? "unknown";
  const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
  const reviewStatus = effectiveReviewStatus(markdown);

  activity.latestReviewAt = latestTimestamp(activity.latestReviewAt, reviewedAt);
  activity.latestCloseAt = latestTimestamp(activity.latestCloseAt, closedAt);
  activity.latestCommentSyncAt = latestTimestamp(activity.latestCommentSyncAt, commentSyncedAt);

  const buckets: Array<[DashboardActivityBucket, number]> = [
    [activity.last15Minutes, 15 * 60 * 1000],
    [activity.lastHour, 60 * 60 * 1000],
    [activity.last24Hours, 24 * 60 * 60 * 1000],
  ];
  for (const [bucket, windowMs] of buckets) {
    if (isWithinWindow(reviewedAtMs, now, windowMs)) {
      bucket.reviews += 1;
      if (decision === "close") bucket.closeDecisions += 1;
      if (decision === "keep_open") bucket.keepOpenDecisions += 1;
      if (reviewStatus === "failed" || reviewStatus.startsWith("stale_")) {
        bucket.failedOrStaleReviews += 1;
      }
    }
    if (isWithinWindow(closedAtMs, now, windowMs)) bucket.closes += 1;
    if (isWithinWindow(commentSyncedAtMs, now, windowMs)) bucket.commentSyncs += 1;
    if (isWithinWindow(applyCheckedAtMs, now, windowMs) && action.startsWith("skipped_")) {
      bucket.applySkips += 1;
    }
  }
}

function formatActivityRow(label: string, bucket: DashboardActivityBucket): string {
  return `| ${label} | ${bucket.reviews} | ${bucket.closeDecisions} | ${bucket.keepOpenDecisions} | ${bucket.failedOrStaleReviews} | ${bucket.closes} | ${bucket.commentSyncs} | ${bucket.applySkips} |`;
}

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
}): { candidates: Item[]; scannedPages: number } {
  if (options.itemNumbers) {
    const candidates = options.itemNumbers.flatMap((number) => {
      const { item, state } = fetchItem(number);
      return state === "open" ? [item] : [];
    });
    return { candidates, scannedPages: 0 };
  }
  if (options.itemNumber) {
    if (options.shardIndex !== 0) return { candidates: [], scannedPages: 0 };
    const { item, state } = fetchItem(options.itemNumber);
    if (state !== "open") return { candidates: [], scannedPages: 0 };
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

export function shardItemNumbers(itemNumbers: readonly number[], shardCount: number): PlanShard[] {
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
    if (candidate.review) continue;
    const createdAtMs = Date.parse(candidate.item.createdAt);
    if (!Number.isFinite(createdAtMs) || createdAtMs >= oldestMs) continue;
    oldestMs = createdAtMs;
    oldest = candidate.item.createdAt;
  }
  return oldest;
}

export function shouldStopSaturatedPlanScan(options: {
  dueCount: number;
  capacity: number;
}): boolean {
  return options.capacity > 0 && options.dueCount >= options.capacity;
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
      );
      if (candidate) due.push(candidate);
    }
    const candidates = selectDueCandidates(due, capacity, compareHotIntakeDueCandidates).map(
      ({ item }) => item,
    );
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
    if (shouldStopSaturatedPlanScan({ dueCount: due.length, capacity })) break;
  }
  const selected = appendFloorBackfillCandidates(selectDueCandidates(due, capacity), backfill, {
    activeFloor,
    capacity,
  });
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
    capacityReason: planCapacityReason({
      selectedCount: candidates.length,
      dueBacklog: due.length,
      capacity,
      activeFloor,
      floorBackfill,
    }),
  };
}

function collectItemContext(
  item: Item,
  options: { fullTimelineForRelations?: boolean } = {},
): ItemContext {
  const issue = ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${item.number}`]);
  const issueRecord = asRecord(issue);
  const commentsWindow = ghPagedContextWindow<unknown>(
    `repos/${targetRepo()}/issues/${item.number}/comments`,
    issueRecord.comments,
    24,
  );
  const comments = commentsWindow.items;
  const timelineWindow = ghPagedLinkHeaderContextWindow<unknown>(
    `repos/${targetRepo()}/issues/${item.number}/timeline`,
    80,
  );
  const timeline = timelineWindow.items;
  const context: ItemContext = {
    issue: compactIssue(issue),
    comments: compactMappedWindow(comments, commentsWindow.total, 24, compactComment),
    timeline: compactMappedWindow(timeline, timelineWindow.total, 80, compactTimelineEvent),
    counts: {
      comments: commentsWindow.total,
      commentsHydrated: commentsWindow.hydrated,
      commentsTruncated: commentsWindow.truncated,
      timeline: timelineWindow.total,
      timelineHydrated: timelineWindow.hydrated,
      timelineTruncated: timelineWindow.truncated,
    },
  };
  let pullRequest: unknown = null;
  let pullReviewComments: unknown[] | null = null;
  if (item.kind === "issue") {
    const closingPullRequests = closingPullRequestsForIssue(item.number);
    if (closingPullRequests.length > 0) {
      context.closingPullRequests = compactMappedSlice(closingPullRequests, 12, compactPullRequest);
      context.counts = {
        ...context.counts,
        comments: commentsWindow.total,
        commentsHydrated: commentsWindow.hydrated,
        commentsTruncated: commentsWindow.truncated,
        timeline: timelineWindow.total,
        timelineHydrated: timelineWindow.hydrated,
        timelineTruncated: timelineWindow.truncated,
        closingPullRequests: closingPullRequests.length,
      };
    }
  }
  if (item.kind === "pull_request") {
    pullRequest = ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${item.number}`]);
    const pullRecord = asRecord(pullRequest);
    const pullFilesWindow = ghPagedContextWindow<unknown>(
      `repos/${targetRepo()}/pulls/${item.number}/files`,
      pullRecord.changed_files,
      80,
    );
    const pullFiles = pullFilesWindow.items;
    const pullCommitsWindow = ghPagedContextWindow<unknown>(
      `repos/${targetRepo()}/pulls/${item.number}/commits`,
      pullRecord.commits,
      80,
    );
    const pullCommits = pullCommitsWindow.items;
    const pullReviewCommentsWindow = ghPagedContextWindow<unknown>(
      `repos/${targetRepo()}/pulls/${item.number}/comments`,
      pullRecord.review_comments,
      40,
    );
    pullReviewComments = pullReviewCommentsWindow.items;
    context.pullRequest = compactPullRequest(pullRequest);
    context.pullFiles = compactMappedWindow(pullFiles, pullFilesWindow.total, 80, compactPullFile);
    context.pullCommits = compactMappedWindow(
      pullCommits,
      pullCommitsWindow.total,
      80,
      compactPullCommit,
    );
    context.pullReviewComments = compactMappedWindow(
      pullReviewComments,
      pullReviewCommentsWindow.total,
      40,
      compactComment,
    );
    context.counts = {
      ...context.counts,
      comments: commentsWindow.total,
      commentsHydrated: commentsWindow.hydrated,
      commentsTruncated: commentsWindow.truncated,
      timeline: timelineWindow.total,
      timelineHydrated: timelineWindow.hydrated,
      timelineTruncated: timelineWindow.truncated,
      pullFiles: pullFilesWindow.total,
      pullFilesHydrated: pullFilesWindow.hydrated,
      pullFilesTruncated: pullFilesWindow.truncated,
      pullCommits: pullCommitsWindow.total,
      pullCommitsHydrated: pullCommitsWindow.hydrated,
      pullCommitsTruncated: pullCommitsWindow.truncated,
      pullReviewComments: pullReviewCommentsWindow.total,
      pullReviewCommentsHydrated: pullReviewCommentsWindow.hydrated,
      pullReviewCommentsTruncated: pullReviewCommentsWindow.truncated,
    };
  }
  const relationTimeline =
    options.fullTimelineForRelations && timelineWindow.truncated
      ? ghPaged<unknown>(`repos/${targetRepo()}/issues/${item.number}/timeline`)
      : timeline;
  const relatedOptions: Parameters<typeof relatedItemsContext>[0] = {
    item,
    issue,
    comments,
    timeline: relationTimeline,
  };
  if (pullRequest) relatedOptions.pullRequest = pullRequest;
  if (pullReviewComments) relatedOptions.pullReviewComments = pullReviewComments;
  const relatedItems = relatedItemsContext(relatedOptions);
  if (relatedItems.length) {
    context.relatedItems = relatedItems;
    const counts: NonNullable<ItemContext["counts"]> = {
      comments: context.counts?.comments ?? commentsWindow.total,
      commentsHydrated: context.counts?.commentsHydrated ?? commentsWindow.hydrated,
      commentsTruncated: context.counts?.commentsTruncated ?? commentsWindow.truncated,
      timeline: context.counts?.timeline ?? timeline.length,
      relatedItems: relatedItems.length,
    };
    if (context.counts?.timelineHydrated !== undefined)
      counts.timelineHydrated = context.counts.timelineHydrated;
    if (context.counts?.timelineTruncated !== undefined)
      counts.timelineTruncated = context.counts.timelineTruncated;
    if (context.counts?.pullFiles !== undefined) counts.pullFiles = context.counts.pullFiles;
    if (context.counts?.pullFilesHydrated !== undefined)
      counts.pullFilesHydrated = context.counts.pullFilesHydrated;
    if (context.counts?.pullFilesTruncated !== undefined)
      counts.pullFilesTruncated = context.counts.pullFilesTruncated;
    if (context.counts?.pullCommits !== undefined) counts.pullCommits = context.counts.pullCommits;
    if (context.counts?.pullCommitsHydrated !== undefined)
      counts.pullCommitsHydrated = context.counts.pullCommitsHydrated;
    if (context.counts?.pullCommitsTruncated !== undefined)
      counts.pullCommitsTruncated = context.counts.pullCommitsTruncated;
    if (context.counts?.pullReviewComments !== undefined)
      counts.pullReviewComments = context.counts.pullReviewComments;
    if (context.counts?.pullReviewCommentsHydrated !== undefined)
      counts.pullReviewCommentsHydrated = context.counts.pullReviewCommentsHydrated;
    if (context.counts?.pullReviewCommentsTruncated !== undefined)
      counts.pullReviewCommentsTruncated = context.counts.pullReviewCommentsTruncated;
    if (context.counts?.closingPullRequests !== undefined)
      counts.closingPullRequests = context.counts.closingPullRequests;
    context.counts = counts;
  }
  return context;
}

function gitInfo(openclawDir: string): GitInfo {
  run("git", ["fetch", "origin", "main", "--depth=50"], { cwd: openclawDir });
  const mainSha = run("git", ["rev-parse", "origin/main"], { cwd: openclawDir });
  let latestRelease: LatestRelease | null = null;
  try {
    latestRelease = ghJson<LatestRelease>([
      "release",
      "view",
      "--json",
      "tagName,name,publishedAt,targetCommitish",
    ]);
  } catch {
    latestRelease = null;
  }
  if (latestRelease?.tagName) {
    try {
      run("git", ["fetch", "--force", "origin", "tag", latestRelease.tagName, "--depth=1"], {
        cwd: openclawDir,
      });
      latestRelease.sha = run("git", ["rev-list", "-n", "1", latestRelease.tagName], {
        cwd: openclawDir,
      });
    } catch {
      latestRelease.sha = null;
    }
  }
  return { mainSha, latestRelease };
}

export function reviewPromptTemplate(): string {
  reviewPromptTemplateCache ??= readFileSync(REVIEW_ITEM_PROMPT_PATH, "utf8");
  return reviewPromptTemplateCache;
}

export function reviewDecisionSchemaText(): string {
  reviewDecisionSchemaCache ??= readFileSync(CLAWSWEEPER_DECISION_SCHEMA_PATH, "utf8");
  return reviewDecisionSchemaCache;
}

function contextJsonForPrompt(context: ItemContext): string {
  return JSON.stringify(context, null, 2);
}

function buildReviewPrompt(
  item: Item,
  context: ItemContext,
  git: GitInfo,
  additionalPrompt = "",
  runtimeHints: ReviewPromptRuntimeHints = {},
): ReviewPromptBuild {
  const prompt = reviewPromptTemplate();
  const contextJson = contextJsonForPrompt(context);
  const schema = reviewDecisionSchemaText();
  const proofScratchDir = runtimeHints.proofScratchDir?.trim();
  const extra = additionalPrompt.trim()
    ? `

## Maintainer Request

${additionalPrompt.trim()}
`
    : "";
  const text = `${prompt}

## Repository State

- Target repo: ${item.repo}
- Repository policy: ${repositoryProfileFor(item.repo).promptNote}
- Item: #${item.number}
- Type: ${item.kind}
- Title: ${item.title}
- URL: ${item.url}
- Author: ${item.author}
- Author association: ${item.authorAssociation}
- Created at: ${item.createdAt}
- Updated at: ${item.updatedAt}
- Current main SHA: ${git.mainSha}
- Latest release: ${git.latestRelease?.tagName ?? "unknown"} (${git.latestRelease?.sha ?? "unknown sha"})

## Runtime Capabilities

- You may use the available network and read-only GitHub token to inspect PR body links, comments, screenshots, videos, logs, terminal output, and target-repo artifacts.
- Download proof artifacts into ${proofScratchDir ? `\`${proofScratchDir}\`` : "a temporary scratch directory"} before inspecting them.
- The target checkout is read-only for review. Do not modify repository files; use the scratch directory or /tmp for downloaded evidence and generated video stills/contact sheets.

## GitHub Context

\`\`\`json
${contextJson}
\`\`\`
${extra}
`;
  return {
    text,
    telemetry: {
      promptChars: text.length,
      staticPromptChars: prompt.length,
      contextChars: contextJson.length,
      schemaChars: schema.length,
      additionalPromptChars: additionalPrompt.trim().length,
    },
  };
}

function reviewPromptTelemetry(
  item: Item,
  context: ItemContext,
  git: GitInfo,
  additionalPrompt = "",
): ReviewPromptTelemetry {
  return buildReviewPrompt(item, context, git, additionalPrompt).telemetry;
}

export function reviewPromptTelemetryForTest(
  item: Item,
  context: ItemContext,
  git: GitInfo,
  additionalPrompt = "",
): ReviewPromptTelemetry {
  return reviewPromptTelemetry(item, context, git, additionalPrompt);
}

function codexFailureReason(detail: string): string {
  if (detail.includes("Codex dirtied the OpenClaw checkout")) return "dirty checkout";
  if (detail.includes("did not produce output")) return "missing structured output";
  if (detail.includes("invalid JSON")) return "invalid structured output";
  if (detail.includes("ENOBUFS") || detail.includes("maxBuffer")) return "output buffer overflow";
  if (detail.includes("timed out") || detail.includes("ETIMEDOUT")) return "timeout";
  return "codex execution failed";
}

function codexFailureDecision(status: number | null, stderr: string, stdout = ""): Decision {
  const detail = stderr || "No stderr.";
  const reason = codexFailureReason(detail);
  return {
    decision: "keep_open",
    closeReason: "none",
    confidence: "low",
    summary: `Codex review failed: ${reason}${status === null ? "" : ` (exit ${status})`}.`,
    changeSummary: "Review failed before ClawSweeper could summarize the requested change.",
    evidence: [
      evidenceEntry({ label: "failure reason", detail: reason }),
      evidenceEntry({ label: "codex failure detail", detail: trimMiddle(detail, 4000) }),
      evidenceEntry({ label: "codex stdout", detail: trimMiddle(stdout || "No stdout.", 2000) }),
    ],
    likelyOwners: [
      {
        person: "unknown",
        role: "review did not complete",
        reason: "Codex failed before it could trace repository history.",
        commits: [],
        files: [],
        confidence: "low",
      },
    ],
    risks: ["No close action taken because the review did not complete."],
    bestSolution: "Retry the Codex review after fixing the execution failure.",
    triagePriority: "none",
    impactLabels: [],
    mergeRiskLabels: [],
    itemCategory: "unclear",
    reproductionStatus: "unclear",
    reproductionConfidence: "low",
    requiresNewFeature: false,
    requiresNewConfigOption: false,
    requiresProductDecision: false,
    reproductionAssessment:
      "Unclear. The review failed before ClawSweeper could establish a reproduction path.",
    solutionAssessment:
      "Unclear. Retry the review first so ClawSweeper can evaluate the actual issue and fix direction.",
    reviewFindings: [],
    securityReview: {
      status: "not_applicable",
      summary: "Security review did not run because the Codex review failed before completion.",
      concerns: [],
    },
    realBehaviorProof: {
      status: "not_applicable",
      summary: "Real behavior proof was not assessed because the Codex review failed.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    },
    prRating: {
      proofTier: "NA",
      patchTier: "NA",
      overallTier: "NA",
      summary: "PR readiness rating was not assessed because the Codex review failed.",
      nextSteps: [],
    },
    telegramVisibleProof: {
      status: "not_needed",
      summary: "Telegram visible proof was not assessed because the Codex review failed.",
    },
    mantisRecommendation: {
      status: "not_recommended",
      scenario: "none",
      reason: "Mantis was not assessed because the Codex review failed.",
      maintainerComment: "",
    },
    overallCorrectness: "not a patch",
    overallConfidenceScore: 0,
    fixedRelease: null,
    fixedSha: null,
    fixedAt: null,
    fixedPullRequest: null,
    closeComment: "",
    workCandidate: "none",
    workConfidence: "low",
    workPriority: "low",
    workReason: "Review did not complete, so no work-lane recommendation was made.",
    workPrompt: "",
    workClusterRefs: [],
    workValidation: [],
    workLikelyFiles: [],
  };
}

function openclawDirtyStatus(openclawDir: string): string {
  return run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: openclawDir,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
}

interface FileModeSnapshot {
  path: string;
  mode: number;
}

function makeTreeReadOnly(path: string, snapshots: FileModeSnapshot[] = []): FileModeSnapshot[] {
  const stat = statSync(path);
  snapshots.push({ path, mode: stat.mode });
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.name === ".git" && entry.isDirectory()) continue;
    if (entry.isDirectory()) makeTreeReadOnly(child, snapshots);
    else {
      const childStat = statSync(child);
      snapshots.push({ path: child, mode: childStat.mode });
      chmodSync(child, childStat.mode & 0o111 ? 0o555 : 0o444);
    }
  }
  chmodSync(path, 0o555);
  return snapshots;
}

function restoreTreeModes(snapshots: readonly FileModeSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    try {
      chmodSync(snapshot.path, snapshot.mode);
    } catch {
      // Best-effort cleanup after review; missing temp files should not hide the review result.
    }
  }
}

export function makeTreeReadOnlyForTest(path: string): FileModeSnapshot[] {
  return makeTreeReadOnly(path);
}

export function restoreTreeModesForTest(snapshots: readonly FileModeSnapshot[]): void {
  restoreTreeModes(snapshots);
}

export function runCodexForTest(options: Parameters<typeof runCodex>[0]): Decision {
  return runCodex(options);
}

function runCodex(options: {
  item: Item;
  context: ItemContext;
  git: GitInfo;
  model: string;
  openclawDir: string;
  reasoningEffort: string;
  sandboxMode: string;
  serviceTier: string;
  timeoutMs: number;
  workDir: string;
  additionalPrompt?: string;
  proofScratchDir?: string;
  prompt?: string;
}): Decision {
  ensureDir(options.workDir);
  const proofScratchDir =
    options.proofScratchDir ?? join(options.workDir, "proof-scratch", String(options.item.number));
  ensureDir(proofScratchDir);
  const promptPath = join(options.workDir, `${options.item.number}.prompt.md`);
  const outputPath = join(options.workDir, `${options.item.number}.json`);
  const prompt =
    options.prompt ??
    buildReviewPrompt(options.item, options.context, options.git, options.additionalPrompt, {
      proofScratchDir,
    }).text;
  writeFileSync(promptPath, prompt, "utf8");
  const dirtyBefore = openclawDirtyStatus(options.openclawDir);
  if (dirtyBefore) {
    throw new Error(
      `OpenClaw checkout is dirty before reviewing #${options.item.number}:\n${dirtyBefore}`,
    );
  }
  const codexConfig = [
    `model_reasoning_effort="${options.reasoningEffort}"`,
    'forced_login_method="api"',
    'approval_policy="never"',
  ];
  if (options.serviceTier) codexConfig.splice(1, 0, `service_tier="${options.serviceTier}"`);
  const result = spawnSync(
    "codex",
    [
      "exec",
      "-m",
      options.model,
      ...codexConfig.flatMap((config) => ["-c", config]),
      "-C",
      options.openclawDir,
      "--output-schema",
      CLAWSWEEPER_DECISION_SCHEMA_PATH,
      "--output-last-message",
      outputPath,
      "--sandbox",
      options.sandboxMode,
      "--add-dir",
      proofScratchDir,
      "-",
    ],
    {
      cwd: options.openclawDir,
      encoding: "utf8",
      env: {
        ...codexEnv({ ghToken: process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN }),
        CLAWSWEEPER_PROOF_SCRATCH_DIR: proofScratchDir,
      },
      input: prompt,
      maxBuffer: 128 * 1024 * 1024,
      timeout: options.timeoutMs,
    },
  );
  const dirtyAfter = openclawDirtyStatus(options.openclawDir);
  if (dirtyAfter) {
    throw new Error(
      `Codex dirtied the OpenClaw checkout while reviewing #${options.item.number}:\n${dirtyAfter}`,
    );
  }
  if (result.error) {
    throw new Error(
      `Codex review failed for #${options.item.number}: ${result.error.message}\n${
        safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."
      }`,
    );
  }
  if (result.status !== 0) {
    if (existsSync(outputPath)) {
      try {
        const decision = parseDecision(
          JSON.parse(readFileSync(outputPath, "utf8").trim()),
          options.item,
        );
        console.error(
          `[review] ${new Date().toISOString()} codex-exit-nonzero-output-accepted #${
            options.item.number
          } status=${result.status ?? "unknown"} stderr=${JSON.stringify(safeOutputTail(result.stderr))}`,
        );
        return decision;
      } catch (error) {
        throw new Error(
          `Codex review failed for #${options.item.number} with exit ${
            result.status ?? "unknown"
          } and wrote invalid JSON or schema-invalid output to ${outputPath}: ${
            error instanceof Error ? error.message : String(error)
          }.\n${safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."}`,
        );
      }
    }
    throw new Error(
      `Codex review failed for #${options.item.number} with exit ${
        result.status ?? "unknown"
      }.\n${safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."}`,
    );
  }
  if (!existsSync(outputPath)) {
    const decision = codexFailureDecision(
      result.status,
      `Codex exited successfully but did not write ${outputPath}.`,
      result.stdout,
    );
    throw new Error(
      `Codex review did not produce output for #${options.item.number}: ${decision.evidence
        .map((entry) => entry.detail)
        .join("\n")}`,
    );
  }
  try {
    return parseDecision(JSON.parse(readFileSync(outputPath, "utf8").trim()), options.item);
  } catch (error) {
    const decision = codexFailureDecision(
      result.status,
      `Codex wrote invalid JSON or schema-invalid output to ${outputPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      result.stdout,
    );
    throw new Error(
      `Codex review wrote invalid JSON for #${options.item.number}: ${decision.evidence
        .map((entry) => entry.detail)
        .join("\n")}`,
    );
  }
}

function closeReasonText(reason: CloseReason): string {
  switch (reason) {
    case "implemented_on_main":
      return "already implemented on main";
    case "mostly_implemented_on_main":
      return "mostly implemented on main";
    case "cannot_reproduce":
      return "cannot reproduce on current main";
    case "clawhub":
      return "belongs on ClawHub";
    case "duplicate_or_superseded":
      return "duplicate or superseded";
    case "not_actionable_in_repo":
      return "not actionable in this repository";
    case "incoherent":
      return "too unclear to act on";
    case "stale_insufficient_info":
      return "stale with insufficient information";
    case "none":
      return "kept open";
  }
}

function repoUrlFor(repo: string, path = ""): string {
  return `https://github.com/${normalizeRepo(repo)}${path}`;
}

function repoUrl(path = ""): string {
  return repoUrlFor(targetRepo(), path);
}

function reportUrl(path = ""): string {
  return `https://github.com/${REPORT_REPO}${path}`;
}

function commitUrl(sha: string): string {
  return repoUrl(`/commit/${sha}`);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

function releaseUrl(tag: string): string {
  return repoUrl(`/releases/tag/${encodeURIComponent(tag)}`);
}

function itemUrlFor(repo: string, number: number, kind: ItemKind = "issue"): string {
  return repoUrlFor(repo, `/${kind === "pull_request" ? "pull" : "issues"}/${number}`);
}

function reportFileUrl(
  number: number,
  path = `records/${targetProfile().slug}/items/${number}.md`,
): string {
  return reportUrl(`/blob/main/${githubPath(path)}`);
}

function githubPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function splitFileAndLine(
  file: string,
  explicitLine?: number | null,
): { file: string; line?: number } {
  const match = file.match(/^(.*?):(\d+)$/);
  if (match?.[1] && match[2]) return { file: match[1], line: Number(match[2]) };
  if (explicitLine) return { file, line: explicitLine };
  return { file };
}

function fileUrl(file: string, sha: string, line?: number): string {
  return repoUrl(`/blob/${sha}/${githubPath(file)}${line ? `#L${line}` : ""}`);
}

function latestFileUrl(file: string): string {
  return repoUrl(`/blob/main/${githubPath(file)}`);
}

function docsPageUrl(file: string): string | null {
  const docsUrl = targetProfile().docsUrl;
  if (!docsUrl || !file.startsWith("docs/")) return null;
  const page = file
    .replace(/^docs\//, "")
    .replace(/\/index\.mdx?$/, "")
    .replace(/\.mdx?$/, "");
  return `${docsUrl}/${page}`;
}

function markdownLink(label: string, url: string): string {
  return `[${label.replaceAll("|", "\\|")}](${url})`;
}

function linkedSha(sha: string): string {
  return markdownLink(shortSha(sha), commitUrl(sha));
}

function linkedRelease(tag: string): string {
  return markdownLink(tag, releaseUrl(tag));
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function workflowStatusBlock(options?: {
  state?: string | undefined;
  detail?: string | undefined;
  runUrl?: string | undefined;
  updatedAt?: string | undefined;
  profile?: RepositoryProfile | undefined;
  plannedCount?: number | undefined;
  plannedCapacity?: number | undefined;
  plannedShards?: number | undefined;
  activeCodex?: number | undefined;
  dueBacklog?: number | undefined;
  oldestUnreviewedAt?: string | undefined;
  capacityReason?: string | undefined;
}): string {
  const profile = options?.profile ?? targetProfile();
  const updatedAt = formatTimestamp(options?.updatedAt ?? new Date().toISOString());
  const state = options?.state ?? "Idle";
  const detail = options?.detail ?? "No workflow status has been published yet.";
  const metrics = workflowStatusMetricLines(options ?? {});
  const metricBlock = metrics.length > 0 ? `\n\n${metrics.join("\n")}` : "";
  const runLine = options?.runUrl ? `\nRun: ${markdownLink(options.runUrl, options.runUrl)}` : "";
  return `${profileStatusStart(profile)}
**Workflow status**

Repository: ${markdownLink(profile.targetRepo, repoUrlFor(profile.targetRepo))}

Updated: ${updatedAt}

State: ${state}

${detail}${metricBlock}${runLine}
${profileStatusEnd(profile)}`;
}

function workflowStatusMetricLines(options: {
  plannedCount?: number | undefined;
  plannedCapacity?: number | undefined;
  plannedShards?: number | undefined;
  activeCodex?: number | undefined;
  dueBacklog?: number | undefined;
  oldestUnreviewedAt?: string | undefined;
  capacityReason?: string | undefined;
}): string[] {
  const lines: string[] = [];
  if (
    options.plannedCount !== undefined ||
    options.plannedShards !== undefined ||
    options.plannedCapacity !== undefined
  ) {
    lines.push(
      `Plan: ${formatStatusNumber(options.plannedCount)} items across ${formatStatusNumber(
        options.plannedShards,
      )} shards (capacity ${formatStatusNumber(options.plannedCapacity)}).`,
    );
  }
  if (options.activeCodex !== undefined) {
    lines.push(`Active Codex target: ${formatStatusNumber(options.activeCodex)}.`);
  }
  if (options.dueBacklog !== undefined) {
    lines.push(`Due backlog scanned: ${formatStatusNumber(options.dueBacklog)}.`);
  }
  if (options.oldestUnreviewedAt) {
    lines.push(`Oldest unreviewed: ${formatTimestamp(options.oldestUnreviewedAt)}.`);
  }
  if (options.capacityReason) {
    lines.push(`Capacity reason: ${options.capacityReason}.`);
  }
  return lines;
}

function formatStatusNumber(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "unknown" : String(value);
}

function readSweepStatusSummary(profile = targetProfile()): WorkflowStatusSummary | null {
  const path = sweepStatusPath(profile);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      updatedAt: stringOrUndefined(parsed.updated_at),
      state: stringOrUndefined(parsed.state) ?? "Idle",
      detail: stringOrUndefined(parsed.detail) ?? "No workflow status has been published yet.",
      runUrl: stringOrUndefined(parsed.run_url),
      plannedCount: numberOrUndefined(parsed.planned_count),
      plannedCapacity: numberOrUndefined(parsed.planned_capacity),
      plannedShards: numberOrUndefined(parsed.planned_shards),
      activeCodex: numberOrUndefined(parsed.active_codex),
      dueBacklog: numberOrUndefined(parsed.due_backlog),
      oldestUnreviewedAt: stringOrUndefined(parsed.oldest_unreviewed_at),
      capacityReason: stringOrUndefined(parsed.capacity_reason),
    };
  } catch {
    return null;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function currentWorkflowStatusBlock(readme: string, profile = targetProfile()): string {
  const statusSummary = readSweepStatusSummary(profile);
  if (statusSummary) return workflowStatusBlock({ ...statusSummary, profile });
  const profilePattern = new RegExp(
    `${escapeRegExp(profileStatusStart(profile))}[\\s\\S]*?${escapeRegExp(profileStatusEnd(profile))}`,
  );
  const profileMatch = readme.match(profilePattern)?.[0];
  if (profileMatch) {
    const summary = workflowStatusSummary(profileMatch);
    if (
      summary.state === "Idle" &&
      summary.detail === "No workflow status has been published yet." &&
      !summary.runUrl
    ) {
      return workflowStatusBlock({ profile, updatedAt: "unknown" });
    }
    return profileMatch;
  }
  return workflowStatusBlock({ profile, updatedAt: "unknown" });
}

function workflowStatusSummary(block: string): WorkflowStatusSummary {
  const updatedAt = block.match(/^Updated: (.+)$/m)?.[1];
  const state = block.match(/^State: (.+)$/m)?.[1] ?? "Idle";
  const runUrl = block.match(/^Run: \[([^\]]+)\]\([^)]+\)$/m)?.[1];
  const detailMatch = block.match(
    /^State: .+\n\n([\s\S]*?)(?:\n\nPlan: |\n\nActive Codex target: |\nRun: |\n<!-- clawsweeper-status)/m,
  );
  const detail = detailMatch?.[1]?.trim() || "No workflow status has been published yet.";
  const planMatch = block.match(/^Plan: (\d+) items across (\d+) shards \(capacity (\d+)\)\.$/m);
  const activeCodex = numberOrUndefined(block.match(/^Active Codex target: (\d+)\.$/m)?.[1]);
  const dueBacklog = numberOrUndefined(block.match(/^Due backlog scanned: (\d+)\.$/m)?.[1]);
  const oldestUnreviewedAt = block.match(/^Oldest unreviewed: (.+)\.$/m)?.[1];
  const capacityReason = block.match(/^Capacity reason: (.+)\.$/m)?.[1];
  return {
    updatedAt,
    state,
    detail,
    runUrl,
    plannedCount: numberOrUndefined(planMatch?.[1]),
    plannedShards: numberOrUndefined(planMatch?.[2]),
    plannedCapacity: numberOrUndefined(planMatch?.[3]),
    activeCodex,
    dueBacklog,
    oldestUnreviewedAt,
    capacityReason,
  };
}

function displayTitle(title: string): string {
  try {
    const parsed = JSON.parse(title) as unknown;
    if (typeof parsed === "string") return parsed;
  } catch {
    // Front matter from older files may be a plain string.
  }
  return title.replace(/^"|"$/g, "");
}

function fixedInText(decision: Decision): string {
  const parts: string[] = [];
  if (decision.fixedPullRequest?.confidence === "high")
    parts.push(`merged PR ${linkedPullRequest(decision.fixedPullRequest)}`);
  if (decision.fixedRelease) parts.push(`release ${linkedRelease(decision.fixedRelease)}`);
  if (decision.fixedSha) parts.push(`commit ${linkedSha(decision.fixedSha)}`);
  if (!decision.fixedRelease && decision.fixedAt)
    parts.push(`main fix timestamp ${decision.fixedAt}`);
  return parts.length ? parts.join(", ") : "not determined";
}

function fixedPullRequestFromUnknown(value: unknown, source: string): FixedPullRequest | null {
  const pull = asRecord(value);
  const number = pull.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  const url = typeof pull.url === "string" ? pull.url : pull.html_url;
  if (typeof url !== "string" || !url) return null;
  const title = typeof pull.title === "string" ? pull.title : `#${number}`;
  const mergedAt = typeof pull.mergedAt === "string" ? pull.mergedAt : pull.merged_at;
  const merged = pull.merged === true || typeof mergedAt === "string";
  if (!merged) return null;
  const head = asRecord(pull.head);
  const sha =
    typeof pull.mergeCommitSha === "string"
      ? pull.mergeCommitSha
      : typeof pull.merge_commit_sha === "string"
        ? pull.merge_commit_sha
        : typeof head.sha === "string"
          ? head.sha
          : null;
  return {
    repo: targetRepo(),
    number,
    url,
    title,
    mergedAt: typeof mergedAt === "string" ? mergedAt : null,
    sha,
    confidence: "high",
    source,
  };
}

function fixedPullRequestFromContext(
  item: Item,
  context: ItemContext,
  decision: Decision,
): FixedPullRequest | null {
  if (item.kind !== "issue") return null;
  if (decision.decision !== "close" || decision.confidence !== "high") return null;
  if (!Array.isArray(context.closingPullRequests)) return null;
  const candidates = context.closingPullRequests
    .map((pull) => fixedPullRequestFromUnknown(pull, "GitHub closing PR reference"))
    .filter((pull): pull is FixedPullRequest => pull !== null)
    .sort((left, right) => {
      const leftTime = left.mergedAt ? Date.parse(left.mergedAt) : 0;
      const rightTime = right.mergedAt ? Date.parse(right.mergedAt) : 0;
      return rightTime - leftTime;
    });
  return candidates[0] ?? null;
}

function fixedPullRequestFromCommitPulls(
  pulls: readonly unknown[],
  source: string,
): FixedPullRequest | null {
  const candidates = pulls
    .map((pull) => fixedPullRequestFromUnknown(pull, source))
    .filter((pull): pull is FixedPullRequest => pull !== null)
    .sort((left, right) => {
      const leftTime = left.mergedAt ? Date.parse(left.mergedAt) : 0;
      const rightTime = right.mergedAt ? Date.parse(right.mergedAt) : 0;
      return rightTime - leftTime;
    });
  return candidates[0] ?? null;
}

export function fixedPullRequestFromCommitPullsForTest(
  pulls: readonly unknown[],
): FixedPullRequest | null {
  return fixedPullRequestFromCommitPulls(pulls, "GitHub commit PR lookup");
}

function fixedPullRequestFromCommitSha(decision: Decision): FixedPullRequest | null {
  if (decision.decision !== "close" || decision.confidence !== "high") return null;
  const fixedSha = decision.fixedSha?.trim();
  if (!fixedSha || fixedSha === "unknown") return null;
  try {
    const pulls = ghJson<unknown[]>([
      "api",
      `repos/${targetRepo()}/commits/${fixedSha}/pulls`,
      "-H",
      "Accept: application/vnd.github+json",
    ]);
    return fixedPullRequestFromCommitPulls(pulls, "GitHub commit PR lookup");
  } catch (error) {
    if (isGitHubNotFoundError(error)) return null;
    throw error;
  }
}

function attachFixedPullRequest(decision: Decision, item: Item, context: ItemContext): Decision {
  if (decision.fixedPullRequest) return decision;
  const fixedPullRequest =
    fixedPullRequestFromContext(item, context, decision) ??
    (item.kind === "issue" ? fixedPullRequestFromCommitSha(decision) : null);
  return fixedPullRequest ? { ...decision, fixedPullRequest } : decision;
}

function linkedPullRequest(pull: FixedPullRequest): string {
  return markdownLink(`#${pull.number}`, pull.url);
}

function fixedInReportText(markdown: string): string {
  const parts: string[] = [];
  const fixedPullRequest = fixedPullRequestFromReport(markdown);
  const fixedRelease = frontMatterValue(markdown, "fixed_release");
  const fixedSha = frontMatterValue(markdown, "fixed_sha");
  const fixedAt = frontMatterValue(markdown, "fixed_at");
  if (fixedPullRequest?.confidence === "high")
    parts.push(`merged PR ${linkedPullRequest(fixedPullRequest)}`);
  if (fixedRelease && fixedRelease !== "unknown")
    parts.push(`release ${linkedRelease(fixedRelease)}`);
  if (fixedSha && fixedSha !== "unknown") parts.push(`commit ${linkedSha(fixedSha)}`);
  if ((!fixedRelease || fixedRelease === "unknown") && fixedAt && fixedAt !== "unknown")
    parts.push(`main fix timestamp ${fixedAt}`);
  return parts.length ? parts.join(", ") : "not determined";
}

function fixedPullRequestFromReport(markdown: string): FixedPullRequest | null {
  const url = frontMatterValue(markdown, "fixed_pr_url");
  const rawNumber = frontMatterValue(markdown, "fixed_pr_number");
  const number = rawNumber ? Number(rawNumber) : NaN;
  if (!url || url === "unknown" || !Number.isInteger(number) || number <= 0) return null;
  const confidence = frontMatterValue(markdown, "fixed_pr_confidence") as Confidence | undefined;
  return {
    repo: markdownRepository(markdown),
    number,
    url,
    title: displayTitle(frontMatterValue(markdown, "fixed_pr_title") ?? `#${number}`),
    mergedAt: nonUnknownFrontMatter(markdown, "fixed_pr_merged_at"),
    sha: nonUnknownFrontMatter(markdown, "fixed_pr_sha"),
    confidence: confidence && CONFIDENCES.has(confidence) ? confidence : "low",
    source: nonUnknownFrontMatter(markdown, "fixed_pr_source") ?? "report metadata",
  };
}

function nonUnknownFrontMatter(markdown: string, key: string): string | null {
  const value = frontMatterValue(markdown, key);
  return value && value !== "unknown" ? value : null;
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function normalizePublicReviewText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_~#[\]()>.,:;!?'"-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function publicReviewTextDiffers(left: string, right: string): boolean {
  const normalizedLeft = normalizePublicReviewText(left);
  const normalizedRight = normalizePublicReviewText(right);
  if (!normalizedLeft || !normalizedRight) return normalizedLeft !== normalizedRight;
  return (
    normalizedLeft !== normalizedRight &&
    !normalizedLeft.includes(normalizedRight) &&
    !normalizedRight.includes(normalizedLeft)
  );
}

function publicReviewTextIsSame(left: string, right: string): boolean {
  const normalizedLeft = normalizePublicReviewText(left);
  const normalizedRight = normalizePublicReviewText(right);
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}

function isReportNoneList(value: string): boolean {
  return !value.trim() || value.trim() === "- none";
}

function isLinkableSourceRef(file: string): boolean {
  if (file.includes("/")) return true;
  return ["AGENTS.md", "CHANGELOG.md", "README.md", "VISION.md"].includes(file);
}

function linkInlineSourceRefs(value: string, sha?: string | null): string {
  if (!sha) return value;
  return value.replace(
    /`([^`]+\.(?:css|js|json|jsx|md|mdx|mjs|sh|ts|tsx|yaml|yml)(?::\d+)?)`/g,
    (match, ref: string) => {
      const { file, line } = splitFileAndLine(ref);
      if (!isLinkableSourceRef(file)) return match;
      const docsUrl = docsPageUrl(file);
      const url =
        docsUrl ?? (file === "VISION.md" && !line ? latestFileUrl(file) : fileUrl(file, sha, line));
      return markdownLink(`\`${ref}\``, url);
    },
  );
}

function linkPrimaryEvidenceFile(value: string, evidence: Evidence): string {
  if (!evidence.file || !evidence.sha) return value;
  const docsUrl = docsPageUrl(evidence.file);
  if (docsUrl && !value.includes(docsUrl)) {
    return `${value} Public docs: ${markdownLink(`\`${evidence.file}\``, docsUrl)}.`;
  }
  if (evidence.file !== "VISION.md" || value.includes("VISION.md")) return value;
  const link = markdownLink("`VISION.md`", latestFileUrl(evidence.file));
  const linked = value
    .replace(/\b(?:the project vision|project vision|the vision|VISION)\b/i, link)
    .replace(/^Current main says\b/, `${link} says`)
    .replace(/^The roadmap guardrails explicitly list\b/, `${link} guardrails explicitly list`);
  return linked === value ? `${link}: ${value}` : linked;
}

function evidenceLocation(evidence: Evidence): string {
  const parts: string[] = [];
  if (evidence.file) {
    const location = evidence.line ? `${evidence.file}:${evidence.line}` : evidence.file;
    const docsUrl = docsPageUrl(evidence.file);
    const sourceUrl = evidence.sha
      ? fileUrl(evidence.file, evidence.sha, evidence.line ?? undefined)
      : null;
    const url = docsUrl ?? sourceUrl;
    parts.push(url ? markdownLink(`\`${location}\``, url) : `\`${location}\``);
  }
  if (evidence.sha) parts.push(linkedSha(evidence.sha));
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function closeEvidenceLine(evidence: Evidence): string {
  const label = evidence.label.trim();
  const detail = linkPrimaryEvidenceFile(
    linkInlineSourceRefs(sentence(evidence.detail), evidence.sha),
    evidence,
  );
  const prefix = label ? `**${label}:** ` : "";
  return `- ${prefix}${detail}${evidenceLocation(evidence)}`;
}

function publicLikelyOwnerRole(role: string): string {
  return role
    .trim()
    .replace(/\brecent workflow maintainers\b/gi, "recent workflow contributors")
    .replace(/\brecent workflow maintainer\b/gi, "recent workflow contributor")
    .replace(/\brecent adjacent maintainers\b/gi, "recent adjacent contributors")
    .replace(/\brecent adjacent maintainer\b/gi, "recent adjacent contributor")
    .replace(/\brecent maintainers\b/gi, "recent area contributors")
    .replace(/\brecent maintainer\b/gi, "recent area contributor");
}

function likelyOwnerLine(owner: LikelyOwner): string {
  const person = owner.person.trim() || "unknown";
  const role = publicLikelyOwnerRole(owner.role);
  const reason = sentence(owner.reason.trim() || "Related by repository history.");
  const commits = owner.commits
    .map((commit) => commit.trim())
    .filter(isCommitSha)
    .slice(0, 3)
    .map((commit) => linkedSha(commit))
    .join(", ");
  const files = owner.files
    .filter(Boolean)
    .slice(0, 3)
    .map((file) => `\`${file}\``)
    .join(", ");
  const suffix = [
    role ? `role: ${role}` : "",
    `confidence: ${owner.confidence}`,
    commits ? `commits: ${commits}` : "",
    files ? `files: ${files}` : "",
  ].filter(Boolean);
  return `- **${person}:** ${reason}${suffix.length ? ` (${suffix.join("; ")})` : ""}`;
}

function priorityLabel(priority: ReviewFinding["priority"]): string {
  return `P${priority}`;
}

function confidenceText(score: number): string {
  return score.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function reviewFindingLocation(
  finding: Pick<ReviewFinding, "file" | "lineStart" | "lineEnd">,
): string {
  const line =
    finding.lineStart === finding.lineEnd
      ? `${finding.lineStart}`
      : `${finding.lineStart}-${finding.lineEnd}`;
  return `${finding.file}:${line}`;
}

function reviewFindingSummaryLine(finding: ReviewFinding): string {
  return `- [${priorityLabel(finding.priority)}] ${finding.title.trim()} — \`${reviewFindingLocation(
    finding,
  )}\``;
}

function reviewFindingDetailedLine(finding: ReviewFinding): string {
  return [
    reviewFindingSummaryLine(finding),
    `  ${sentence(finding.body)}`,
    `  Confidence: ${confidenceText(finding.confidenceScore)}`,
  ].join("\n");
}

function securityConcernSummaryLine(concern: SecurityConcern): string {
  const location = securityConcernLocation(concern);
  const suffix = location === "not tied to a single file" ? "" : ` — \`${location}\``;
  return `- [${concern.severity}] ${concern.title.trim()}${suffix}`;
}

function securityConcernDetailedLine(concern: SecurityConcern): string {
  return [
    securityConcernSummaryLine(concern),
    `  ${sentence(concern.body)}`,
    `  Confidence: ${confidenceText(concern.confidenceScore)}`,
  ].join("\n");
}

function securityReviewLine(review: SecurityReview): string {
  const prefix =
    review.status === "needs_attention"
      ? "Security review needs attention"
      : review.status === "cleared"
        ? "Security review cleared"
        : "Security review";
  return `${prefix}: ${sentence(review.summary)}`;
}

function publicSecurityReviewLine(review: SecurityReview): string {
  if (review.status === "not_applicable" && review.concerns.length === 0) return "";
  const prefix =
    review.status === "needs_attention"
      ? "Needs attention"
      : review.status === "cleared"
        ? "Cleared"
        : "Not applicable";
  return `${prefix}: ${sentence(review.summary)}`;
}

function realBehaviorProofReReviewGuidance(): string {
  return "After adding proof, update the PR body; ClawSweeper should re-review automatically. If it does not, ask a maintainer to comment `@clawsweeper re-review`.";
}

function realBehaviorProofBlockerSummary(summary: string, fallback: string): string {
  const body = sentence(summary) || fallback;
  if (/\b(?:@clawsweeper re-review|re-review automatically|update the PR body)\b/i.test(body)) {
    return body;
  }
  return `${body} ${realBehaviorProofReReviewGuidance()}`;
}

function publicRealBehaviorProofLine(proof: RealBehaviorProof): string {
  const summary = sentence(proof.summary);
  switch (proof.status) {
    case "sufficient":
      return `Sufficient (${proof.evidenceKind}): ${summary}`;
    case "override":
      return `Override: ${summary || "A maintainer applied proof: override."}`;
    case "missing":
      return `Needs real behavior proof before merge: ${realBehaviorProofBlockerSummary(
        summary,
        "The PR must include after-fix evidence from a real setup. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
      )}`;
    case "mock_only":
      return `Needs real behavior proof before merge: ${realBehaviorProofBlockerSummary(
        summary,
        "Tests, mocks, snapshots, lint, typechecks, and CI are supplemental only. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
      )}`;
    case "insufficient":
      return `Needs stronger real behavior proof before merge: ${realBehaviorProofBlockerSummary(
        summary,
        "Include after-fix evidence from a real setup. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
      )}`;
    case "not_applicable":
      return summary ? `Not applicable: ${summary}` : "";
  }
}

function publicPrRatingLine(rating: PrRating, proof: RealBehaviorProof): string {
  const shiny = hasShinyProof(proof) ? " ✨ media proof bonus" : "";
  const lines = [
    `Overall: ${themedRatingName(rating.overallTier)}`,
    `Proof: ${themedRatingName(rating.proofTier)}${shiny}`,
    `Patch quality: ${themedRatingName(rating.patchTier)}`,
    `Summary: ${sentence(rating.summary)}`,
  ];
  if (rating.nextSteps.length) {
    lines.push("", "Rank-up moves:", ...rating.nextSteps.slice(0, 3).map((step) => `- ${step}`));
  }
  lines.push(
    "",
    "<details>",
    "<summary>What the crustacean ranks mean</summary>",
    "",
    "- 🦀 challenger crab: rare, exceptional readiness with strong proof, clean implementation, and convincing validation.",
    "- 🦞 diamond lobster: very strong readiness with only minor maintainer review expected.",
    "- 🐚 platinum hermit: good normal PR, likely mergeable with ordinary maintainer review.",
    "- 🦐 gold shrimp: useful signal, but proof or patch confidence is still limited.",
    "- 🦪 silver shellfish: thin signal; proof, validation, or implementation needs work.",
    "- 🧂 unranked krab: not merge-ready because proof is missing/unusable or there are serious correctness or safety concerns.",
    "- 🌊 off-meta tidepool: rating does not apply to this item.",
    "",
    "Shiny media proof means a screenshot, video, or linked artifact directly shows the changed behavior. Runtime, network, CSP, and security claims still need visible diagnostics.",
    "",
    "</details>",
  );
  return lines.join("\n");
}

function publicMantisRecommendationBlock(recommendation: MantisRecommendation): string {
  if (recommendation.status !== "recommended" || recommendation.scenario === "none") return "";
  const comment = recommendation.maintainerComment.trim();
  const accountMention = "@openclaw-mantis";
  const ambiguousMantisMention = new RegExp(`@${"mantis"}\\b`, "i");
  if (
    !comment.startsWith(`${accountMention} `) ||
    ambiguousMantisMention.test(comment) ||
    /\b(?:gh\s+workflow|workflow_dispatch|dispatch|trigger\s+the\s+workflow)\b/i.test(comment) ||
    comment.length > 500 ||
    comment.includes("\n")
  ) {
    return "";
  }
  const commandBody = comment.slice(accountMention.length).trim();
  if (!commandBody) return "";
  const reason = sentence(recommendation.reason);
  const intro = reason
    ? `${reason} A maintainer can ask Mantis to capture proof by posting a new PR comment that starts with the OpenClaw Mantis account mention, followed by:`
    : "A maintainer can ask Mantis to capture proof by posting a new PR comment that starts with the OpenClaw Mantis account mention, followed by:";
  return [intro, "", "```text", commandBody, "```"].join("\n");
}

function closeIntro(reason: CloseReason): string {
  switch (reason) {
    case "implemented_on_main":
      return "Thanks for the context here. I did a careful shell check against current `main`, and this is already implemented.";
    case "mostly_implemented_on_main":
      return "Thanks for the context here. I did a careful shell check against current `main`, and the useful part of this older PR is already implemented there.";
    case "cannot_reproduce":
      return "Thanks for the report. I gave this a fresh shell check against current `main`, and I could not reproduce it anymore.";
    case "clawhub":
      return `Thanks for the idea. I checked the current extension path, and this is a better fit for ${markdownLink("ClawHub.com", targetProfile().communityUrl ?? "https://clawhub.ai/")} than OpenClaw core.`;
    case "duplicate_or_superseded":
      return "Thanks for the context here. I swept through the related work, and this is now duplicate or superseded.";
    case "not_actionable_in_repo":
      return "Thanks for writing this up. I checked the repo boundary, and this lives outside the OpenClaw source shell.";
    case "incoherent":
      return "Thanks for the note. I could not crack enough detail here to turn it into a concrete OpenClaw code or docs action.";
    case "stale_insufficient_info":
      return "Thanks for the report. I checked current `main`, but this shell is missing enough reproduction detail to verify a current bug.";
    case "none":
      return "Thanks for the context here. I checked this with Codex and am closing it based on the evidence below.";
  }
}

function closeOutro(reason: CloseReason, canonicalLinks: string[] = []): string {
  switch (reason) {
    case "implemented_on_main":
      return "So I’m closing this as already implemented rather than keeping a duplicate issue open.";
    case "mostly_implemented_on_main":
      return "So I’m closing this older PR as already covered on `main` rather than keeping a mostly-duplicated branch open.";
    case "clawhub":
      return `So I’m closing this as a scope-fit item for the plugin/community path. Please upload or publish it through ${markdownLink("ClawHub.com", targetProfile().communityUrl ?? "https://clawhub.ai/")} so it can live as an installable community skill instead of a bundled OpenClaw core change.`;
    case "duplicate_or_superseded":
      return canonicalLinks.length
        ? `So I’m closing this here and keeping the remaining discussion on ${formatCanonicalLinks(canonicalLinks)}.`
        : "So I’m closing this here because the remaining work is already tracked in the canonical issue.";
    case "not_actionable_in_repo":
      return "So I’m closing this as outside the OpenClaw source repository rather than keeping it open as core work.";
    default:
      return "";
  }
}

function issueOrPullReferenceNumbers(value: string): string[] {
  return [
    ...value.matchAll(/https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/(\d+)|#(\d+)\b/g),
  ].map((match) => match[1] ?? match[2] ?? "");
}

function issueOrPullReferenceUrls(value: string): string[] {
  return [
    ...value.matchAll(
      /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+/g,
    ),
  ].map((match) => match[0]);
}

function itemPublicUrl(item?: { repo?: string; kind?: ItemKind; number?: number }): string {
  if (!item?.number || !Number.isInteger(item.number) || item.number <= 0) return "";
  return repoUrlFor(
    item.repo ?? targetRepo(),
    `/${item.kind === "pull_request" ? "pull" : "issues"}/${item.number}`,
  );
}

function addsIssueOrPullReference(candidate: string, summaryLine: string): boolean {
  const summaryRefs = new Set(issueOrPullReferenceNumbers(summaryLine));
  return issueOrPullReferenceNumbers(candidate).some((ref) => ref && !summaryRefs.has(ref));
}

function duplicateCanonicalTexts(options: {
  reason: CloseReason;
  bestSolutionLine: string;
  evidence: Evidence[];
}): string[] {
  if (options.reason !== "duplicate_or_superseded") return [];
  return [
    options.bestSolutionLine,
    ...options.evidence
      .filter((entry) => /\b(?:canonical|duplicate|superseded|implementation)\b/i.test(entry.label))
      .map((entry) => sentence(entry.detail)),
  ];
}

function duplicateCanonicalLinkTexts(options: {
  reason: CloseReason;
  bestSolutionLine: string;
  evidence: Evidence[];
}): string[] {
  if (options.reason !== "duplicate_or_superseded") return [];
  return [
    options.bestSolutionLine,
    ...options.evidence
      .filter((entry) => /\b(?:canonical|duplicate|superseded|implementation)\b/i.test(entry.label))
      .map((entry) => sentence(entry.detail)),
  ];
}

function duplicateCanonicalLinks(options: {
  reason: CloseReason;
  bestSolutionLine: string;
  evidence: Evidence[];
  currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
}): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  const currentItemUrl = itemPublicUrl(options.currentItem);
  for (const text of duplicateCanonicalLinkTexts(options)) {
    for (const link of issueOrPullReferenceUrls(text)) {
      if (link === currentItemUrl) continue;
      if (seen.has(link)) continue;
      seen.add(link);
      links.push(link);
    }
  }
  return links;
}

function duplicateCanonicalPathLine(options: {
  reason: CloseReason;
  summaryLine: string;
  bestSolutionLine: string;
  evidence: Evidence[];
}): string {
  const candidates = duplicateCanonicalTexts(options);
  const canonical =
    candidates.find(
      (candidate) => candidate && addsIssueOrPullReference(candidate, options.summaryLine),
    ) ??
    candidates.find(
      (candidate) => candidate && publicReviewTextDiffers(candidate, options.summaryLine),
    );
  return canonical ? `Canonical path: ${canonical}` : "";
}

function formatCanonicalLinks(links: string[]): string {
  if (links.length <= 1) return links[0] ?? "the canonical issue";
  if (links.length === 2) return `${links[0]} and ${links[1]}`;
  return `${links.slice(0, -1).join(", ")}, and ${links[links.length - 1]}`;
}

function reportEvidence(markdown: string): Evidence[] {
  const evidence = reviewSectionValue(markdown, "evidence");
  const entries: Evidence[] = [];
  let current: Evidence | null = null;
  for (const line of evidence.split("\n")) {
    const heading = parseBoldListHeading(line);
    if (heading) {
      if (current) entries.push(current);
      current = evidenceEntry({
        label: heading.label,
        detail: heading.detail,
      });
      continue;
    }
    if (!current) continue;
    const file = line.match(/^\s+- file: \[([^\]]+)\]/);
    if (file?.[1]) {
      const location = splitFileAndLine(file[1]);
      current.file = location.file;
      current.line = location.line ?? null;
      continue;
    }
    const sha = line.match(/^\s+- sha: \[([^\]]+)\]/);
    if (sha?.[1]) current.sha = sha[1];
    const command = line.match(/^\s+- command: `([\s\S]+)`$/);
    if (command?.[1]) current.command = command[1];
  }
  if (current) entries.push(current);
  return entries;
}

function reportLikelyOwners(markdown: string): LikelyOwner[] {
  const section = reviewSectionValue(markdown, "likelyOwners");
  const owners: LikelyOwner[] = [];
  let current: LikelyOwner | null = null;
  for (const line of section.split("\n")) {
    const heading = parseBoldListHeading(line);
    if (heading) {
      if (current) owners.push(current);
      current = {
        person: heading.label,
        role: heading.detail,
        reason: "",
        commits: [],
        files: [],
        confidence: "low",
      };
      continue;
    }
    if (!current) continue;
    const reason = line.match(/^\s+- reason: (.*)$/);
    if (reason?.[1]) {
      current.reason = reason[1];
      continue;
    }
    const commits = line.match(/^\s+- commits: (.*)$/);
    if (commits?.[1]) {
      current.commits = commits[1]
        .split(",")
        .map((commit) => commit.trim())
        .filter(Boolean);
      continue;
    }
    const files = line.match(/^\s+- files: (.*)$/);
    if (files?.[1]) {
      current.files = files[1]
        .split(",")
        .map((file) => file.trim())
        .filter(Boolean);
      continue;
    }
    const confidence = line.match(/^\s+- confidence: (high|medium|low)$/);
    if (confidence?.[1]) current.confidence = confidence[1] as Confidence;
  }
  if (current) owners.push(current);
  return owners;
}

function reportOverallCorrectness(markdown: string): OverallCorrectness {
  const section = reviewSectionValue(markdown, "reviewFindings");
  const value = sectionLineValue(section, "Overall correctness");
  return value && OVERALL_CORRECTNESS_VALUES.has(value as OverallCorrectness)
    ? (value as OverallCorrectness)
    : "not a patch";
}

function reportOverallConfidenceScore(markdown: string): number {
  const section = reviewSectionValue(markdown, "reviewFindings");
  const raw = sectionLineValue(section, "Overall confidence");
  const score = raw ? Number(raw) : 0;
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0;
}

function triagePriorityFromReport(markdown: string): TriagePriority {
  const value = frontMatterValue(markdown, "triage_priority");
  return TRIAGE_PRIORITIES.has(value as TriagePriority) ? (value as TriagePriority) : "none";
}

function impactLabelsFromReport(markdown: string): ImpactLabelName[] {
  return frontMatterStringArray(markdown, "impact_labels").filter(
    (label): label is ImpactLabelName => IMPACT_LABEL_NAMES.has(label),
  );
}

function mergeRiskLabelsFromReport(markdown: string): MergeRiskLabelName[] {
  return frontMatterStringArray(markdown, "merge_risk_labels").filter(
    (label): label is MergeRiskLabelName => MERGE_RISK_LABEL_NAMES.has(label),
  );
}

function reportReviewFindings(markdown: string): ReviewFinding[] {
  const section = reviewSectionValue(markdown, "reviewFindings");
  const findings: ReviewFinding[] = [];
  let current: ReviewFinding | null = null;
  for (const line of section.split("\n")) {
    const heading = parseReviewFindingHeading(line);
    if (heading) {
      if (current) findings.push(current);
      current = {
        title: heading.title,
        body: "",
        priority: heading.priority,
        confidenceScore: 0,
        file: heading.file,
        lineStart: heading.lineStart,
        lineEnd: heading.lineEnd,
      };
      continue;
    }
    if (!current) continue;
    const body = line.match(/^\s+- body: (.*)$/);
    if (body?.[1]) {
      current.body = body[1];
      continue;
    }
    const confidence = line.match(/^\s+- confidence: ([0-9.]+)$/);
    if (confidence?.[1]) {
      const score = Number(confidence[1]);
      current.confidenceScore = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
    }
  }
  if (current) findings.push(current);
  return findings;
}

function defaultSecurityReview(markdown: string): SecurityReview {
  const type = frontMatterValue(markdown, "type");
  return {
    status: type === "pull_request" ? "not_applicable" : "not_applicable",
    summary:
      type === "pull_request"
        ? "No dedicated security review was recorded in this older report."
        : "No patch security review is needed for this non-PR item.",
    concerns: [],
  };
}

function reportSecurityReview(markdown: string): SecurityReview {
  const section = reviewSectionValue(markdown, "securityReview");
  if (!section.trim()) return defaultSecurityReview(markdown);
  const statusValue = sectionLineValue(section, "Status");
  const status = SECURITY_REVIEW_STATUSES.has(statusValue as SecurityReviewStatus)
    ? (statusValue as SecurityReviewStatus)
    : undefined;
  const summary = sectionLineValue(section, "Summary");
  if (!status || !summary) return defaultSecurityReview(markdown);
  const concerns: SecurityConcern[] = [];
  let current: SecurityConcern | null = null;
  for (const line of section.split("\n")) {
    const heading = parseSecurityConcernHeading(line);
    if (heading) {
      if (current) concerns.push(current);
      current = {
        title: heading.title,
        body: "",
        severity: heading.severity,
        confidenceScore: 0,
        file: heading.file,
        line: heading.line,
      };
      continue;
    }
    if (!current) continue;
    const body = line.match(/^\s+- body: (.*)$/);
    if (body?.[1]) {
      current.body = body[1];
      continue;
    }
    const confidence = line.match(/^\s+- confidence: ([0-9.]+)$/);
    if (confidence?.[1]) {
      const score = Number(confidence[1]);
      current.confidenceScore = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
    }
  }
  if (current) concerns.push(current);
  return { status, summary, concerns };
}

function defaultRealBehaviorProof(markdown: string): RealBehaviorProof {
  const type = frontMatterValue(markdown, "type");
  if (frontMatterStringArray(markdown, "labels").includes(PROOF_OVERRIDE_LABEL)) {
    return {
      status: "override",
      summary: "A maintainer applied proof: override for this PR.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    };
  }
  if (isDocsOnlyPullRequestReport(markdown)) {
    return {
      status: "not_applicable",
      summary:
        "Real behavior proof is not required because this PR only changes files under docs/.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    };
  }
  return {
    status: "not_applicable",
    summary:
      type === "pull_request"
        ? "No real behavior proof assessment was recorded in this older report."
        : "Real behavior proof is not required for non-PR issue triage.",
    evidenceKind: "not_applicable",
    needsContributorAction: false,
  };
}

function reportRealBehaviorProof(markdown: string): RealBehaviorProof {
  const defaultProof = defaultRealBehaviorProof(markdown);
  if (defaultProof.status === "override" || isDocsOnlyPullRequestReport(markdown)) {
    return defaultProof;
  }
  const section = reviewSectionValue(markdown, "realBehaviorProof");
  if (!section.trim()) {
    if (isExternalPullRequestReport(markdown)) {
      return {
        status: "missing",
        summary:
          "No after-fix real behavior proof was recorded for this external PR; screenshots or videos are preferred when they can show the behavior, and terminal screenshots, console output, copied live output, linked artifacts, recordings, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
        evidenceKind: "none",
        needsContributorAction: true,
      };
    }
    return defaultProof;
  }
  const statusValue = sectionLineValue(section, "Status");
  const evidenceKindValue = sectionLineValue(section, "Evidence kind");
  const summary = sectionLineValue(section, "Summary");
  const needsContributorActionValue = sectionLineValue(section, "Needs contributor action");
  const status = REAL_BEHAVIOR_PROOF_STATUSES.has(statusValue as RealBehaviorProofStatus)
    ? (statusValue as RealBehaviorProofStatus)
    : undefined;
  const evidenceKind = REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS.has(
    evidenceKindValue as RealBehaviorProofEvidenceKind,
  )
    ? (evidenceKindValue as RealBehaviorProofEvidenceKind)
    : undefined;
  if (!status || !evidenceKind || !summary) return defaultRealBehaviorProof(markdown);
  return normalizeRealBehaviorProof({
    status,
    summary,
    evidenceKind,
    needsContributorAction: /^true$/i.test(needsContributorActionValue ?? ""),
  });
}

function reportTelegramVisibleProof(markdown: string): TelegramVisibleProof {
  const section = reviewSectionValue(markdown, "telegramVisibleProof");
  const statusValue = sectionLineValue(section, "Status");
  const status = TELEGRAM_VISIBLE_PROOF_STATUSES.has(statusValue as TelegramVisibleProofStatus)
    ? (statusValue as TelegramVisibleProofStatus)
    : "not_needed";
  return {
    status,
    summary:
      sectionLineValue(section, "Summary") ??
      "No Telegram visible-proof assessment was recorded in this report.",
  };
}

function reportPrRating(markdown: string): PrRating {
  const section = reviewSectionValue(markdown, "prRating");
  const proofTierValue =
    sectionLineValue(section, "Proof tier") ?? frontMatterValue(markdown, "pr_rating_proof");
  const patchTierValue =
    sectionLineValue(section, "Patch tier") ?? frontMatterValue(markdown, "pr_rating_patch");
  const overallTierValue =
    sectionLineValue(section, "Overall tier") ?? frontMatterValue(markdown, "pr_rating_overall");
  const summary = sectionLineValue(section, "Summary");
  const nextSteps = sectionList(section, "Next rank-up steps").slice(0, 3);
  if (
    PR_RATING_TIERS.has(proofTierValue as PrRatingTier) &&
    PR_RATING_TIERS.has(patchTierValue as PrRatingTier) &&
    PR_RATING_TIERS.has(overallTierValue as PrRatingTier) &&
    summary
  ) {
    return normalizePrRating({
      proofTier: proofTierValue as PrRatingTier,
      patchTier: patchTierValue as PrRatingTier,
      overallTier: overallTierValue as PrRatingTier,
      summary,
      nextSteps,
    });
  }
  const proof = reportRealBehaviorProof(markdown);
  return derivedPrRating({
    isPullRequest: frontMatterValue(markdown, "type") === "pull_request",
    proof,
    findings: reportReviewFindings(markdown),
    securityReview: reportSecurityReview(markdown),
    overallCorrectness: reportOverallCorrectness(markdown),
    overallConfidenceScore: reportOverallConfidenceScore(markdown),
  });
}

function reportMantisRecommendation(markdown: string): MantisRecommendation {
  const section = reviewSectionValue(markdown, "mantisRecommendation");
  const statusValue = sectionLineValue(section, "Status");
  const scenarioValue = sectionLineValue(section, "Scenario");
  const status = MANTIS_RECOMMENDATION_STATUSES.has(statusValue as MantisRecommendationStatus)
    ? (statusValue as MantisRecommendationStatus)
    : "not_recommended";
  const scenario = MANTIS_RECOMMENDATION_SCENARIOS.has(
    scenarioValue as MantisRecommendationScenario,
  )
    ? (scenarioValue as MantisRecommendationScenario)
    : "none";
  return {
    status,
    scenario,
    reason:
      sectionLineValue(section, "Reason") ??
      "No Mantis recommendation was recorded in this report.",
    maintainerComment: sectionLineValue(section, "Maintainer comment") ?? "",
  };
}

function screenshotProofNeedsRuntimeOutput(summary: string): boolean {
  if (
    /\b(?:no|without|absence of|zero|none)\b[^.]{0,120}\b(?:visible\s+)?(?:console|network|error|warning|violation|csp|cors)\b/i.test(
      summary,
    )
  ) {
    return true;
  }
  if (
    !/\b(?:csp|content[- ]security[- ]policy|connect-src|script-src|style-src|img-src|cors)\b/i.test(
      summary,
    )
  ) {
    return false;
  }
  return !/\b(?:devtools|developer tools|console output|console panel|network trace|network panel|network tab|terminal|logs?|live output|request|response|status code|har)\b/i.test(
    summary,
  );
}

function normalizeRealBehaviorProof(proof: RealBehaviorProof): RealBehaviorProof {
  if (
    proof.status === "sufficient" &&
    proof.evidenceKind === "screenshot" &&
    screenshotProofNeedsRuntimeOutput(proof.summary)
  ) {
    return {
      status: "insufficient",
      summary:
        "The screenshot proof is not enough for browser runtime or security behavior; include console, network, terminal, live output, or logs showing the changed behavior after the fix.",
      evidenceKind: "screenshot",
      needsContributorAction: true,
    };
  }
  return proof;
}

function ratingIndex(tier: PrRatingTier): number {
  return ["S", "A", "B", "C", "D", "F", "NA"].indexOf(tier);
}

function lowerRatingTier(a: PrRatingTier, b: PrRatingTier): PrRatingTier {
  if (a === "NA") return b;
  if (b === "NA") return a;
  return ratingIndex(a) >= ratingIndex(b) ? a : b;
}

function proofTierFromRealBehaviorProof(proof: RealBehaviorProof): PrRatingTier {
  switch (proof.status) {
    case "sufficient":
      if (
        proof.evidenceKind === "recording" ||
        proof.evidenceKind === "screenshot" ||
        proof.evidenceKind === "linked_artifact"
      ) {
        return "S";
      }
      return "A";
    case "override":
      return "A";
    case "insufficient":
    case "mock_only":
      return "D";
    case "missing":
      return "F";
    case "not_applicable":
      return "NA";
  }
}

function patchTierFromReview(options: {
  isPullRequest: boolean;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  overallCorrectness: OverallCorrectness;
  overallConfidenceScore: number;
}): PrRatingTier {
  if (!options.isPullRequest || options.overallCorrectness === "not a patch") return "NA";
  if (options.securityReview.status === "needs_attention") return "F";
  const highestPriority = Math.min(...options.findings.map((finding) => finding.priority), 4);
  if (options.overallCorrectness === "patch is incorrect") {
    if (highestPriority <= 1) return "F";
    if (highestPriority === 2) return "D";
    return "C";
  }
  if (highestPriority <= 1) return "D";
  if (highestPriority === 2) return "C";
  if (highestPriority === 3) return "B";
  if (options.overallConfidenceScore >= 0.95) return "S";
  if (options.overallConfidenceScore >= 0.8) return "A";
  if (options.overallConfidenceScore >= 0.6) return "B";
  return "C";
}

function ratingLabelForTier(tier: PrRatingTier): (typeof PR_RATING_LABELS)[number] {
  const label = PR_RATING_LABELS.find((candidate) => candidate.tier === tier);
  if (label) return label;
  return PR_RATING_LABELS[6];
}

function themedRatingName(tier: PrRatingTier): string {
  return ratingLabelForTier(tier).name.replace(/^rating:\s*/, "");
}

function hasShinyProof(proof: Pick<RealBehaviorProof, "status" | "evidenceKind">): boolean {
  return (
    proof.status === "sufficient" &&
    (proof.evidenceKind === "recording" ||
      proof.evidenceKind === "screenshot" ||
      proof.evidenceKind === "linked_artifact")
  );
}

function defaultRatingNextSteps(options: {
  proof: RealBehaviorProof;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  overallCorrectness: OverallCorrectness;
  overallTier: PrRatingTier;
}): string[] {
  if (options.overallTier === "S" || options.overallTier === "A" || options.overallTier === "NA") {
    return [];
  }
  const steps: string[] = [];
  if (
    options.proof.status === "missing" ||
    options.proof.status === "mock_only" ||
    options.proof.status === "insufficient"
  ) {
    steps.push(
      "Add after-fix proof from a real setup, such as a short recording, terminal output, linked artifact, or redacted logs.",
    );
  }
  if (options.securityReview.status === "needs_attention") {
    steps.push("Resolve the security review concern or explain why the changed path is safe.");
  }
  const highestPriority = Math.min(...options.findings.map((finding) => finding.priority), 4);
  if (options.overallCorrectness === "patch is incorrect" || highestPriority <= 2) {
    steps.push(
      "Address the highest-priority review finding and re-run the changed-surface validation.",
    );
  }
  if (!steps.length) {
    steps.push(
      "Tighten the PR description with what changed, how it was validated, and any remaining risk.",
    );
  }
  return steps.slice(0, 3);
}

function normalizePrRating(rating: PrRating): PrRating {
  if (rating.overallTier === "S" || rating.overallTier === "A" || rating.overallTier === "NA") {
    return { ...rating, nextSteps: [] };
  }
  return { ...rating, nextSteps: rating.nextSteps.slice(0, 3) };
}

function derivedPrRating(options: {
  isPullRequest: boolean;
  proof: RealBehaviorProof;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  overallCorrectness: OverallCorrectness;
  overallConfidenceScore: number;
}): PrRating {
  const proofTier = proofTierFromRealBehaviorProof(options.proof);
  const patchTier = patchTierFromReview(options);
  const overallTier =
    proofTier === "NA" && patchTier === "NA" ? "NA" : lowerRatingTier(proofTier, patchTier);
  return normalizePrRating({
    proofTier,
    patchTier,
    overallTier,
    summary:
      overallTier === "NA"
        ? "PR readiness rating is not applicable to this item."
        : "PR readiness rating was derived from proof quality, review findings, security review, and reviewer confidence.",
    nextSteps: defaultRatingNextSteps({ ...options, overallTier }),
  });
}

function nextPrRatingLabels(
  labels: readonly string[],
  rating: Pick<PrRating, "overallTier">,
): string[] {
  const nextLabels = labels.filter((label) => !PR_RATING_LABEL_NAMES.has(label));
  nextLabels.push(ratingLabelForTier(rating.overallTier).name);
  return nextLabels;
}

function pullRequestFilePathsFromReport(markdown: string): string[] {
  return frontMatterStringArray(markdown, "pull_files");
}

function isDocsPath(file: string): boolean {
  return file.startsWith("docs/");
}

function isDocsOnlyPullRequestReport(markdown: string): boolean {
  if (frontMatterValue(markdown, "type") !== "pull_request") return false;
  if (frontMatterBoolean(markdown, "pull_files_truncated")) return false;
  const files = pullRequestFilePathsFromReport(markdown);
  return files.length > 0 && files.every(isDocsPath);
}

function nextRealBehaviorProofSufficientLabels(
  labels: readonly string[],
  proof: Pick<RealBehaviorProof, "status">,
): string[] {
  const nextLabels = labels.filter((label) => label !== PROOF_SUFFICIENT_LABEL);
  if (proof.status === "sufficient") nextLabels.push(PROOF_SUFFICIENT_LABEL);
  return nextLabels;
}

export function realBehaviorProofSufficientLabelsForTest(
  labels: readonly string[],
  status: string,
): string[] {
  const proofStatus = REAL_BEHAVIOR_PROOF_STATUSES.has(status as RealBehaviorProofStatus)
    ? (status as RealBehaviorProofStatus)
    : "not_applicable";
  return nextRealBehaviorProofSufficientLabels(labels, { status: proofStatus });
}

export function prRatingLabelsForTest(labels: readonly string[], tier: string): string[] {
  const overallTier = PR_RATING_TIERS.has(tier as PrRatingTier) ? (tier as PrRatingTier) : "NA";
  return nextPrRatingLabels(labels, { overallTier });
}

export function prRatingLabelSchemeForTest(): {
  tier: PrRatingTier;
  name: string;
  color: string;
  description: string;
}[] {
  return PR_RATING_LABELS.map(({ tier, name, color, description }) => ({
    tier,
    name,
    color,
    description,
  }));
}

function nextTelegramVisibleProofLabels(
  labels: readonly string[],
  proof: Pick<TelegramVisibleProof, "status">,
): string[] {
  const nextLabels = labels.filter((label) => label !== TELEGRAM_VISIBLE_PROOF_LABEL);
  if (proof.status === "needed") nextLabels.push(TELEGRAM_VISIBLE_PROOF_LABEL);
  return nextLabels;
}

export function telegramVisibleProofLabelsForTest(
  labels: readonly string[],
  status: string,
): string[] {
  const proofStatus = TELEGRAM_VISIBLE_PROOF_STATUSES.has(status as TelegramVisibleProofStatus)
    ? (status as TelegramVisibleProofStatus)
    : "not_needed";
  return nextTelegramVisibleProofLabels(labels, { status: proofStatus });
}

type PriorityLabelSpec = (typeof PRIORITY_LABELS)[number];

function priorityLabelForTriage(priority: TriagePriority): PriorityLabelSpec | null {
  return PRIORITY_LABELS.find((label) => label.triagePriority === priority) ?? null;
}

function nextPriorityLabels(labels: readonly string[], triagePriority: TriagePriority): string[] {
  const nextLabels = labels.filter((label) => !PRIORITY_LABEL_NAMES.has(label));
  const priorityLabel = priorityLabelForTriage(triagePriority);
  if (priorityLabel) nextLabels.push(priorityLabel.name);
  return nextLabels;
}

export function priorityLabelSchemeForTest(): {
  name: string;
  color: string;
  description: string;
}[] {
  return PRIORITY_LABELS.map(({ name, color, description }) => ({ name, color, description }));
}

export function priorityLabelsForTest(labels: readonly string[], triagePriority: string): string[] {
  const priority = TRIAGE_PRIORITIES.has(triagePriority as TriagePriority)
    ? (triagePriority as TriagePriority)
    : "none";
  return nextPriorityLabels(labels, priority);
}

function nextImpactLabels(
  labels: readonly string[],
  impactLabels: readonly ImpactLabelName[],
): string[] {
  const nextLabels = labels.filter((label) => !IMPACT_LABEL_NAMES.has(label));
  const uniqueImpactLabels = new Set(impactLabels);
  for (const label of IMPACT_LABELS) {
    if (uniqueImpactLabels.has(label.name)) nextLabels.push(label.name);
  }
  return nextLabels;
}

export function impactLabelSchemeForTest(): {
  name: string;
  color: string;
  description: string;
}[] {
  return IMPACT_LABELS.map(({ name, color, description }) => ({ name, color, description }));
}

export function impactLabelsForTest(
  labels: readonly string[],
  impactLabels: readonly string[],
): string[] {
  return nextImpactLabels(
    labels,
    impactLabels.filter((label): label is ImpactLabelName => IMPACT_LABEL_NAMES.has(label)),
  );
}

function nextMergeRiskLabels(
  labels: readonly string[],
  mergeRiskLabels: readonly MergeRiskLabelName[],
): string[] {
  const nextLabels = labels.filter((label) => !MERGE_RISK_LABEL_NAMES.has(label));
  const uniqueMergeRiskLabels = new Set(mergeRiskLabels);
  for (const label of MERGE_RISK_LABELS) {
    if (uniqueMergeRiskLabels.has(label.name)) nextLabels.push(label.name);
  }
  return nextLabels;
}

export function mergeRiskLabelSchemeForTest(): {
  name: string;
  color: string;
  description: string;
}[] {
  return MERGE_RISK_LABELS.map(({ name, color, description }) => ({
    name,
    color,
    description,
  }));
}

export function mergeRiskLabelsForTest(
  labels: readonly string[],
  mergeRiskLabels: readonly string[],
): string[] {
  return nextMergeRiskLabels(
    labels,
    mergeRiskLabels.filter((label): label is MergeRiskLabelName =>
      MERGE_RISK_LABEL_NAMES.has(label),
    ),
  );
}

function ensurePriorityLabel(label: PriorityLabelSpec): void {
  try {
    ghWithRetry(
      ["label", "create", label.name, "--color", label.color, "--description", label.description],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function ensureImpactLabel(name: ImpactLabelName): void {
  const definition = IMPACT_LABELS.find((label) => label.name === name);
  if (!definition) return;
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function ensureMergeRiskLabel(name: MergeRiskLabelName): void {
  const definition = MERGE_RISK_LABELS.find((label) => label.name === name);
  if (!definition) return;
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

interface IssueAdvisoryLabelState {
  type: string | undefined;
  itemCategory: string | undefined;
  reproductionStatus: string | undefined;
  reproductionConfidence: string | undefined;
  requiresProductDecision: boolean;
  securityReviewStatus: string | undefined;
  workCandidate: string | undefined;
  workStatus: string | undefined;
  workConfidence: string | undefined;
  hasWorkShape: boolean;
  hasOpenLinkedPullRequest: boolean;
}

function isIssueAdvisoryLabel(label: string): boolean {
  return ISSUE_ADVISORY_LABEL_NAMES.has(label.toLowerCase());
}

function issueRatingLabelForState(state: IssueAdvisoryLabelState): string {
  if (state.type !== "issue") return "";
  if (state.reproductionStatus === "not_applicable") {
    return "issue-rating: 🌊 off-meta tidepool";
  }
  if (state.reproductionStatus === "reproduced" && state.reproductionConfidence === "high") {
    return "issue-rating: 🦀 challenger crab";
  }
  if (
    (state.reproductionStatus === "source_reproducible" ||
      state.reproductionStatus === "reproduced") &&
    state.reproductionConfidence === "high"
  ) {
    return "issue-rating: 🦞 diamond lobster";
  }
  if (
    (state.reproductionStatus === "source_reproducible" ||
      state.reproductionStatus === "reproduced") &&
    state.reproductionConfidence === "medium"
  ) {
    return "issue-rating: 🐚 platinum hermit";
  }
  if (state.reproductionStatus === "unclear" && state.reproductionConfidence === "medium") {
    return "issue-rating: 🦐 gold shrimp";
  }
  if (
    state.reproductionStatus === "not_reproduced" ||
    (state.reproductionStatus === "unclear" && state.reproductionConfidence === "low")
  ) {
    return "issue-rating: 🦪 silver shellfish";
  }
  return "issue-rating: 🧂 unranked krab";
}

function wantedIssueAdvisoryLabels(state: IssueAdvisoryLabelState): Set<string> {
  const labels = new Set<string>();
  if (state.type !== "issue") return labels;
  const issueRatingLabel = issueRatingLabelForState(state);
  if (issueRatingLabel) labels.add(issueRatingLabel);
  if (state.reproductionConfidence === "high") {
    if (state.reproductionStatus === "reproduced") labels.add("clawsweeper:current-main-repro");
    if (state.reproductionStatus === "source_reproducible") labels.add("clawsweeper:source-repro");
    if (state.reproductionStatus === "not_reproduced") labels.add("clawsweeper:not-repro-on-main");
  }
  if (
    state.reproductionStatus === "source_reproducible" &&
    state.reproductionConfidence !== "high"
  ) {
    labels.add("clawsweeper:needs-live-repro");
  }
  if (state.reproductionStatus === "unclear" && state.reproductionConfidence !== "high") {
    labels.add("clawsweeper:needs-info");
  }
  if (state.hasOpenLinkedPullRequest) {
    labels.add("clawsweeper:linked-pr-open");
  }
  if (
    state.workCandidate === "queue_fix_pr" &&
    state.workStatus === "candidate" &&
    state.workConfidence === "high"
  ) {
    labels.add("clawsweeper:queueable-fix");
  }
  if (
    state.workConfidence === "high" &&
    state.hasWorkShape &&
    (state.workCandidate === "queue_fix_pr" || state.workCandidate === "manual_review")
  ) {
    labels.add("clawsweeper:fix-shape-clear");
  }
  if (state.workCandidate === "manual_review" || state.workStatus === "manual_review") {
    labels.add("clawsweeper:needs-maintainer-review");
  }
  if (state.requiresProductDecision) {
    labels.add("clawsweeper:needs-product-decision");
  }
  if (state.itemCategory === "security" || state.securityReviewStatus === "needs_attention") {
    labels.add("clawsweeper:needs-security-review");
  }
  if (
    state.hasOpenLinkedPullRequest ||
    state.workCandidate === "manual_review" ||
    state.workStatus === "manual_review" ||
    state.requiresProductDecision ||
    state.itemCategory === "security" ||
    state.securityReviewStatus === "needs_attention"
  ) {
    labels.add("clawsweeper:no-new-fix-pr");
  }
  return labels;
}

function nextIssueAdvisoryLabels(
  labels: readonly string[],
  state: IssueAdvisoryLabelState,
): string[] {
  const wantedLabels = wantedIssueAdvisoryLabels(state);
  const nextLabels = labels.filter((label) => !isIssueAdvisoryLabel(label));
  for (const label of ISSUE_ADVISORY_LABELS) {
    if (wantedLabels.has(label.name)) nextLabels.push(label.name);
  }
  return nextLabels;
}

export function issueAdvisoryLabelsForTest(
  labels: readonly string[],
  state: Partial<IssueAdvisoryLabelState>,
): string[] {
  return nextIssueAdvisoryLabels(labels, {
    type: state.type,
    itemCategory: state.itemCategory,
    reproductionStatus: state.reproductionStatus,
    reproductionConfidence: state.reproductionConfidence,
    requiresProductDecision: state.requiresProductDecision ?? false,
    securityReviewStatus: state.securityReviewStatus,
    workCandidate: state.workCandidate,
    workStatus: state.workStatus,
    workConfidence: state.workConfidence,
    hasWorkShape: state.hasWorkShape ?? false,
    hasOpenLinkedPullRequest: state.hasOpenLinkedPullRequest ?? false,
  });
}

function issueAdvisoryLabelStateFromReport(
  markdown: string,
  options: { hasOpenLinkedPullRequest?: boolean } = {},
): IssueAdvisoryLabelState {
  const workLikelyFiles = frontMatterStringArray(markdown, "work_likely_files");
  const workValidation = frontMatterStringArray(markdown, "work_validation");
  const workPrompt = reviewSectionValue(markdown, "repairWorkPrompt").trim();
  return {
    type: frontMatterValue(markdown, "type"),
    itemCategory: frontMatterValue(markdown, "item_category"),
    reproductionStatus: frontMatterValue(markdown, "reproduction_status"),
    reproductionConfidence: frontMatterValue(markdown, "reproduction_confidence"),
    requiresProductDecision: frontMatterValue(markdown, "requires_product_decision") === "true",
    securityReviewStatus: reportSecurityReview(markdown).status,
    workCandidate: frontMatterValue(markdown, "work_candidate"),
    workStatus: frontMatterValue(markdown, "work_status"),
    workConfidence: frontMatterValue(markdown, "work_confidence"),
    hasWorkShape: Boolean(workPrompt || workLikelyFiles.length || workValidation.length),
    hasOpenLinkedPullRequest: options.hasOpenLinkedPullRequest === true,
  };
}

function ensureIssueAdvisoryLabel(name: string): void {
  const definition = ISSUE_ADVISORY_LABELS.find((label) => label.name === name);
  if (!definition) return;
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function syncPriorityLabel(options: {
  number: number;
  labels: readonly string[];
  triagePriority: TriagePriority;
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextPriorityLabels(options.labels, options.triagePriority);
  const labelsToRemove = options.labels.filter(
    (label) => PRIORITY_LABEL_NAMES.has(label) && !nextLabels.includes(label),
  );
  const labelToAdd = nextLabels.find(
    (label) => PRIORITY_LABEL_NAMES.has(label) && !options.labels.includes(label),
  );
  const changed = labelsToRemove.length > 0 || Boolean(labelToAdd);
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  if (labelToAdd) {
    const priorityLabel = PRIORITY_LABELS.find((label) => label.name === labelToAdd);
    if (priorityLabel) ensurePriorityLabel(priorityLabel);
  }
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  if (labelToAdd) {
    ghWithRetry(["issue", "edit", String(options.number), "--add-label", labelToAdd]);
  }
  return { labels: nextLabels, changed };
}

function syncImpactLabels(options: {
  number: number;
  labels: readonly string[];
  impactLabels: readonly ImpactLabelName[];
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextImpactLabels(options.labels, options.impactLabels);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToAdd = nextLabels.filter(
    (label): label is ImpactLabelName =>
      IMPACT_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
  );
  const labelsToRemove = options.labels.filter(
    (label) => IMPACT_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
  );
  const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  for (const label of labelsToAdd) {
    ensureImpactLabel(label);
    ghWithRetry(["issue", "edit", String(options.number), "--add-label", label]);
  }
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  return { labels: nextLabels, changed };
}

function syncMergeRiskLabels(options: {
  number: number;
  labels: readonly string[];
  mergeRiskLabels: readonly MergeRiskLabelName[];
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextMergeRiskLabels(options.labels, options.mergeRiskLabels);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToAdd = nextLabels.filter(
    (label): label is MergeRiskLabelName =>
      MERGE_RISK_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
  );
  const labelsToRemove = options.labels.filter(
    (label) => MERGE_RISK_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
  );
  const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  for (const label of labelsToAdd) {
    ensureMergeRiskLabel(label);
    ghWithRetry(["issue", "edit", String(options.number), "--add-label", label]);
  }
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  return { labels: nextLabels, changed };
}

function syncIssueAdvisoryLabels(options: {
  number: number;
  labels: readonly string[];
  state: IssueAdvisoryLabelState;
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextIssueAdvisoryLabels(options.labels, options.state);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToAdd = nextLabels.filter(
    (label) => isIssueAdvisoryLabel(label) && !currentLabelKeys.has(label.toLowerCase()),
  );
  const labelsToRemove = options.labels.filter(
    (label) => isIssueAdvisoryLabel(label) && !nextLabelKeys.has(label.toLowerCase()),
  );
  const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  for (const label of labelsToAdd) {
    ensureIssueAdvisoryLabel(label);
    ghWithRetry(["issue", "edit", String(options.number), "--add-label", label]);
  }
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  return { labels: nextLabels, changed };
}

function syncTelegramVisibleProofLabel(options: {
  number: number;
  labels: readonly string[];
  proof: Pick<TelegramVisibleProof, "status">;
  dryRun: boolean;
}): string[] {
  const nextLabels = nextTelegramVisibleProofLabels(options.labels, options.proof);
  const hadLabel = options.labels.includes(TELEGRAM_VISIBLE_PROOF_LABEL);
  const wantsLabel = nextLabels.includes(TELEGRAM_VISIBLE_PROOF_LABEL);
  if (hadLabel === wantsLabel) return nextLabels;
  if (options.dryRun) return nextLabels;
  if (wantsLabel) ensureTelegramVisibleProofLabel();
  ghWithRetry([
    "issue",
    "edit",
    String(options.number),
    wantsLabel ? "--add-label" : "--remove-label",
    TELEGRAM_VISIBLE_PROOF_LABEL,
  ]);
  return nextLabels;
}

function ensurePrRatingLabel(tier: PrRatingTier): void {
  const definition = ratingLabelForTier(tier);
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function syncPrRatingLabel(options: {
  number: number;
  labels: readonly string[];
  rating: Pick<PrRating, "overallTier">;
  dryRun: boolean;
}): string[] {
  const nextLabels = nextPrRatingLabels(options.labels, options.rating);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToRemove = options.labels.filter(
    (label) => PR_RATING_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
  );
  const labelToAdd = nextLabels.find(
    (label) => PR_RATING_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
  );
  if (!labelsToRemove.length && !labelToAdd) return nextLabels;
  if (options.dryRun) return nextLabels;
  if (labelToAdd) ensurePrRatingLabel(options.rating.overallTier);
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  if (labelToAdd) {
    ghWithRetry(["issue", "edit", String(options.number), "--add-label", labelToAdd]);
  }
  return nextLabels;
}

function ensureTelegramVisibleProofLabel(): void {
  try {
    ghWithRetry(
      [
        "label",
        "create",
        TELEGRAM_VISIBLE_PROOF_LABEL,
        "--color",
        TELEGRAM_VISIBLE_PROOF_LABEL_COLOR,
        "--description",
        TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function missingLabelError(error: unknown, label: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`'${label}' not found`) || message.includes(`"${label}" not found`);
}

export function isMissingGitHubLabelErrorForTest(message: string, label: string): boolean {
  return missingLabelError(new Error(message), label);
}

function ensureRealBehaviorProofSufficientLabel(): boolean {
  try {
    ghWithRetry(
      [
        "label",
        "create",
        PROOF_SUFFICIENT_LABEL,
        "--color",
        PROOF_SUFFICIENT_LABEL_COLOR,
        "--description",
        PROOF_SUFFICIENT_LABEL_DESCRIPTION,
      ],
      2,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists/i.test(message)) return true;
    console.warn(`Skipping optional label sync for ${PROOF_SUFFICIENT_LABEL}: ${message}`);
    return false;
  }
}

function syncRealBehaviorProofSufficientLabel(options: {
  number: number;
  labels: readonly string[];
  proof: Pick<RealBehaviorProof, "status">;
  dryRun: boolean;
}): string[] {
  const nextLabels = nextRealBehaviorProofSufficientLabels(options.labels, options.proof);
  const hadLabel = options.labels.includes(PROOF_SUFFICIENT_LABEL);
  const wantsLabel = nextLabels.includes(PROOF_SUFFICIENT_LABEL);
  if (hadLabel === wantsLabel) return nextLabels;
  if (options.dryRun) return nextLabels;
  if (wantsLabel && !ensureRealBehaviorProofSufficientLabel()) return [...options.labels];
  try {
    ghWithRetry([
      "issue",
      "edit",
      String(options.number),
      wantsLabel ? "--add-label" : "--remove-label",
      PROOF_SUFFICIENT_LABEL,
    ]);
  } catch (error) {
    if (!missingLabelError(error, PROOF_SUFFICIENT_LABEL)) throw error;
    console.warn(
      `Skipping optional label sync for ${PROOF_SUFFICIENT_LABEL}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return wantsLabel ? [...options.labels] : nextLabels;
  }
  return nextLabels;
}

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

function realBehaviorProofBlocksMerge(markdown: string): boolean {
  if (!isExternalPullRequestReport(markdown)) return false;
  if (frontMatterStringArray(markdown, "labels").includes(PROOF_OVERRIDE_LABEL)) return false;
  if (isDocsOnlyPullRequestReport(markdown)) return false;
  const proof = reportRealBehaviorProof(markdown);
  return (
    proof.needsContributorAction ||
    proof.status === "missing" ||
    proof.status === "mock_only" ||
    proof.status === "insufficient" ||
    (proof.status !== "sufficient" && proof.status !== "override")
  );
}

function parseBoldListHeading(line: string): { label: string; detail: string } | null {
  const prefix = "- **";
  if (!line.startsWith(prefix)) return null;
  const delimiter = ":**";
  const delimiterIndex = line.indexOf(delimiter, prefix.length);
  if (delimiterIndex === -1) return null;
  return {
    label: line.slice(prefix.length, delimiterIndex),
    detail: line.slice(delimiterIndex + delimiter.length).trimStart(),
  };
}

function parseReviewFindingHeading(line: string): {
  priority: ReviewFinding["priority"];
  title: string;
  file: string;
  lineStart: number;
  lineEnd: number;
} | null {
  const prefix = "- **[P";
  if (!line.startsWith(prefix)) return null;
  const priority = Number(line[prefix.length]);
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) return null;
  const titleStart = prefix.length + 3;
  if (line.slice(prefix.length + 1, titleStart) !== "] ") return null;
  const titleEnd = line.indexOf(":**", titleStart);
  if (titleEnd === -1) return null;

  const location = parseBacktickLocation(line.slice(titleEnd + 3).trim());
  if (!location) return null;
  return {
    priority: priority as ReviewFinding["priority"],
    title: line.slice(titleStart, titleEnd),
    ...location,
  };
}

function parseSecurityConcernHeading(line: string): {
  severity: SecurityConcernSeverity;
  title: string;
  file: string | null;
  line: number | null;
} | null {
  const prefix = "- **[";
  if (!line.startsWith(prefix)) return null;
  const severityEnd = line.indexOf("] ", prefix.length);
  if (severityEnd === -1) return null;
  const severity = line.slice(prefix.length, severityEnd);
  if (!SECURITY_CONCERN_SEVERITIES.has(severity as SecurityConcernSeverity)) return null;
  const titleStart = severityEnd + 2;
  const titleEnd = line.indexOf(":**", titleStart);
  if (titleEnd === -1) return null;

  const locationText = line.slice(titleEnd + 3).trim();
  const location = locationText ? parseBacktickLocation(locationText) : null;
  return {
    severity: severity as SecurityConcernSeverity,
    title: line.slice(titleStart, titleEnd),
    file: location?.file ?? null,
    line: location?.lineStart ?? null,
  };
}

function parseBacktickLocation(value: string): {
  file: string;
  lineStart: number;
  lineEnd: number;
} | null {
  if (!value.startsWith("`") || !value.endsWith("`")) return null;
  const location = value.slice(1, -1);
  const separator = location.lastIndexOf(":");
  if (separator <= 0) return null;
  const file = location.slice(0, separator);
  const range = parseLineRange(location.slice(separator + 1));
  return range ? { file, ...range } : null;
}

function parseLineRange(value: string): { lineStart: number; lineEnd: number } | null {
  const separator = value.indexOf("-");
  const lineStartText = separator === -1 ? value : value.slice(0, separator);
  const lineEndText = separator === -1 ? value : value.slice(separator + 1);
  if (!isDigitsOnly(lineStartText) || !isDigitsOnly(lineEndText)) return null;
  const lineStart = Number(lineStartText);
  const lineEnd = Number(lineEndText);
  return lineStart > 0 && lineEnd >= lineStart ? { lineStart, lineEnd } : null;
}

function sectionLineValue(section: string, label: string): string | undefined {
  const prefix = `${label}:`;
  for (const line of section.split("\n")) {
    if (line.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim();
      return value || undefined;
    }
  }
  return undefined;
}

function sectionList(section: string, label: string): string[] {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${label}:`);
  if (start === -1) return [];
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^[A-Z][A-Za-z -]+:/.test(line)) break;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("- ")) continue;
    const item = trimmed.slice(2).trim();
    if (item) values.push(item);
  }
  return values;
}

function workCandidateReasonText(section: string): string {
  const lines = section.split("\n");
  const reasonStart = lines.findIndex((line) => line.startsWith("Reason:"));
  if (reasonStart === -1) return "";

  const reasonLines = [lines[reasonStart]!.slice("Reason:".length).trimStart()];
  for (let index = reasonStart + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nextLine = lines[index + 1] ?? "";
    if (
      line.trim() === "" &&
      (nextLine.startsWith("Cluster refs:") ||
        nextLine.startsWith("Likely files:") ||
        nextLine.startsWith("Validation:"))
    ) {
      break;
    }
    reasonLines.push(line);
  }

  return reasonLines.join("\n").trim();
}

function reportDecision(markdown: string, closeReason: CloseReason): Decision {
  const fixedRelease = frontMatterValue(markdown, "fixed_release");
  const fixedSha = frontMatterValue(markdown, "fixed_sha");
  const fixedAt = frontMatterValue(markdown, "fixed_at");
  return {
    decision: "close",
    closeReason,
    confidence: "high",
    summary: reviewSectionValue(markdown, "summary"),
    changeSummary: reviewSectionValue(markdown, "changeSummary"),
    evidence: reportEvidence(markdown),
    likelyOwners: reportLikelyOwners(markdown),
    risks: [],
    bestSolution: reviewSectionValue(markdown, "bestSolution"),
    triagePriority: triagePriorityFromReport(markdown),
    impactLabels: impactLabelsFromReport(markdown),
    mergeRiskLabels: mergeRiskLabelsFromReport(markdown),
    itemCategory:
      (frontMatterValue(markdown, "item_category") as ItemCategory | undefined) ?? "unclear",
    reproductionStatus:
      (frontMatterValue(markdown, "reproduction_status") as ReproductionStatus | undefined) ??
      "unclear",
    reproductionConfidence:
      (frontMatterValue(markdown, "reproduction_confidence") as Confidence | undefined) ?? "low",
    requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
    requiresNewConfigOption: frontMatterValue(markdown, "requires_new_config_option") === "true",
    requiresProductDecision: frontMatterValue(markdown, "requires_product_decision") === "true",
    reproductionAssessment: reviewSectionValue(markdown, "reproductionAssessment"),
    solutionAssessment: reviewSectionValue(markdown, "solutionAssessment"),
    reviewFindings: reportReviewFindings(markdown),
    securityReview: reportSecurityReview(markdown),
    realBehaviorProof: reportRealBehaviorProof(markdown),
    prRating: reportPrRating(markdown),
    telegramVisibleProof: reportTelegramVisibleProof(markdown),
    mantisRecommendation: reportMantisRecommendation(markdown),
    overallCorrectness: reportOverallCorrectness(markdown),
    overallConfidenceScore: reportOverallConfidenceScore(markdown),
    fixedRelease: fixedRelease && fixedRelease !== "unknown" ? fixedRelease : null,
    fixedSha: fixedSha && fixedSha !== "unknown" ? fixedSha : null,
    fixedAt: fixedAt && fixedAt !== "unknown" ? fixedAt : null,
    fixedPullRequest: fixedPullRequestFromReport(markdown),
    closeComment: reviewSectionValue(markdown, "closeComment"),
    workCandidate:
      (frontMatterValue(markdown, "work_candidate") as WorkCandidateKind | undefined) ?? "none",
    workConfidence:
      (frontMatterValue(markdown, "work_confidence") as Confidence | undefined) ?? "low",
    workPriority: (frontMatterValue(markdown, "work_priority") as Confidence | undefined) ?? "low",
    workReason: reviewSectionValue(markdown, "workCandidate"),
    workPrompt: reviewSectionValue(markdown, "repairWorkPrompt"),
    workClusterRefs: frontMatterStringArray(markdown, "work_cluster_refs"),
    workValidation: frontMatterStringArray(markdown, "work_validation"),
    workLikelyFiles: frontMatterStringArray(markdown, "work_likely_files"),
  };
}

function workPlanPathForReport(file: string, plansDir = defaultPlansDir()): string {
  return join(plansDir, basename(file));
}

function shouldRenderWorkPlanFromReport(markdown: string): boolean {
  return (
    frontMatterValue(markdown, "decision") === "keep_open" &&
    frontMatterValue(markdown, "action_taken") === "kept_open" &&
    frontMatterValue(markdown, "work_candidate") === "queue_fix_pr" &&
    frontMatterValue(markdown, "work_status") === "candidate" &&
    isFresh({
      reviewedAt: frontMatterValue(markdown, "reviewed_at"),
      reviewStatus: effectiveReviewStatus(markdown),
    })
  );
}

function formattedMarkdownList(
  values: readonly string[],
  formatter: (value: string) => string,
): string {
  return values.length ? values.map((value) => `- ${formatter(value)}`).join("\n") : "- none";
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

export function renderWorkPlanFromReport(
  markdown: string,
  options: { reportPath?: string } = {},
): string | null {
  if (!shouldRenderWorkPlanFromReport(markdown)) return null;
  const repo = markdownRepository(markdown);
  const number = frontMatterValue(markdown, "number") ?? "unknown";
  const title = frontMatterValue(markdown, "title") ?? "Untitled";
  const reviewedAt = frontMatterValue(markdown, "reviewed_at") ?? "unknown";
  const workPrompt = reviewSectionValue(markdown, "repairWorkPrompt").trim();
  const likelyFiles = frontMatterStringArray(markdown, "work_likely_files");
  const validation = frontMatterStringArray(markdown, "work_validation");
  const clusterRefs = frontMatterStringArray(markdown, "work_cluster_refs");
  const reportPath = options.reportPath ?? "unknown";
  return `---
number: ${number}
repository: ${repo}
title: ${JSON.stringify(title)}
source_report: ${reportPath}
reviewed_at: ${reviewedAt}
work_candidate: ${frontMatterValue(markdown, "work_candidate") ?? "none"}
work_priority: ${frontMatterValue(markdown, "work_priority") ?? "low"}
work_confidence: ${frontMatterValue(markdown, "work_confidence") ?? "low"}
---

# Coding Plan for ${repo}#${number}: ${title}

Source report: ${reportPath === "unknown" ? "unknown" : markdownLink(reportPath, reportPath)}

## Summary

${reviewSectionValue(markdown, "summary") || "No summary provided."}

## Plan

${workPrompt || "No repair work prompt provided."}

## Likely Files

${formattedMarkdownList(likelyFiles, inlineCode)}

## Validation

${formattedMarkdownList(validation, inlineCode)}

## Cluster References

${formattedMarkdownList(clusterRefs, (value) => value)}

## Notes

- This file is generated dashboard state from the durable review report.
- Regenerate it from the source report instead of editing it by hand.
`;
}

function syncWorkPlanFromReport(options: {
  markdown: string;
  reportPath: string;
  plansDir: string;
  dryRun?: boolean;
}): boolean {
  const planPath = workPlanPathForReport(options.reportPath, options.plansDir);
  const plan = renderWorkPlanFromReport(options.markdown, {
    reportPath: repoRelativePath(options.reportPath),
  });
  if (!plan) {
    if (!options.dryRun && existsSync(planPath)) unlinkSync(planPath);
    return false;
  }
  if (!options.dryRun) {
    ensureDir(dirname(planPath));
    writeFileSync(planPath, plan, "utf8");
  }
  return true;
}

function runtimeReviewText(runtime?: {
  model?: string | undefined;
  reasoningEffort?: string | undefined;
}): string {
  const model = runtime?.model?.trim();
  const reasoningEffort = runtime?.reasoningEffort?.trim();
  if (model && reasoningEffort) return `model ${model}, reasoning ${reasoningEffort}`;
  if (model) return `model ${model}`;
  if (reasoningEffort) return `reasoning ${reasoningEffort}`;
  return "";
}

function reviewTelemetryNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return String(Math.max(0, Math.round(value)));
}

function contextCountText(
  total: number | undefined,
  fallback: number,
  hydrated?: number,
  truncated?: boolean,
): string {
  const displayTotal =
    total === undefined || !Number.isFinite(total) ? Math.max(0, fallback) : Math.max(0, total);
  if (hydrated === undefined || !Number.isFinite(hydrated)) return String(displayTotal);
  const displayHydrated = Math.max(0, Math.round(hydrated));
  if (!truncated && displayHydrated >= displayTotal) return String(displayTotal);
  return `${displayTotal} (hydrated ${displayHydrated}${truncated ? ", truncated" : ""})`;
}

function promptJsonChars(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

function reviewContextLedgerEntry(options: {
  section: string;
  label: string;
  value: unknown;
  entries: number;
  total?: number | undefined;
  hydrated?: number | undefined;
  truncated?: boolean | undefined;
}): ReviewContextLedgerEntry {
  const entry: ReviewContextLedgerEntry = {
    section: options.section,
    label: options.label,
    entries: Math.max(0, Math.round(options.entries)),
    chars: promptJsonChars(options.value),
  };
  if (options.total !== undefined && Number.isFinite(options.total)) {
    entry.total = Math.max(0, Math.round(options.total));
  }
  if (options.hydrated !== undefined && Number.isFinite(options.hydrated)) {
    entry.hydrated = Math.max(0, Math.round(options.hydrated));
  }
  if (options.truncated !== undefined) entry.truncated = options.truncated;
  return entry;
}

function arrayEntries(value: unknown[] | undefined): number {
  return value?.length ?? 0;
}

function reviewContextLedger(context: ItemContext): ReviewContextLedgerEntry[] {
  const counts = context.counts;
  const entries = [
    reviewContextLedgerEntry({
      section: "issue",
      label: "issue",
      value: context.issue,
      entries: 1,
    }),
    reviewContextLedgerEntry({
      section: "comments",
      label: "comments",
      value: context.comments,
      entries: context.comments.length,
      total: counts?.comments,
      hydrated: counts?.commentsHydrated,
      truncated: counts?.commentsTruncated,
    }),
    reviewContextLedgerEntry({
      section: "timeline",
      label: "timeline events",
      value: context.timeline,
      entries: context.timeline.length,
      total: counts?.timeline,
      hydrated: counts?.timelineHydrated,
      truncated: counts?.timelineTruncated,
    }),
    reviewContextLedgerEntry({
      section: "closingPullRequests",
      label: "closing PRs",
      value: context.closingPullRequests ?? [],
      entries: arrayEntries(context.closingPullRequests),
      total: counts?.closingPullRequests,
    }),
    reviewContextLedgerEntry({
      section: "relatedItems",
      label: "related items",
      value: context.relatedItems ?? [],
      entries: arrayEntries(context.relatedItems),
      total: counts?.relatedItems,
    }),
    reviewContextLedgerEntry({
      section: "pullRequest",
      label: "pull request",
      value: context.pullRequest ?? null,
      entries: context.pullRequest === undefined ? 0 : 1,
    }),
    reviewContextLedgerEntry({
      section: "pullFiles",
      label: "PR files",
      value: context.pullFiles ?? [],
      entries: arrayEntries(context.pullFiles),
      total: counts?.pullFiles,
      hydrated: counts?.pullFilesHydrated,
      truncated: counts?.pullFilesTruncated,
    }),
    reviewContextLedgerEntry({
      section: "pullCommits",
      label: "PR commits",
      value: context.pullCommits ?? [],
      entries: arrayEntries(context.pullCommits),
      total: counts?.pullCommits,
      hydrated: counts?.pullCommitsHydrated,
      truncated: counts?.pullCommitsTruncated,
    }),
    reviewContextLedgerEntry({
      section: "pullReviewComments",
      label: "PR review comments",
      value: context.pullReviewComments ?? [],
      entries: arrayEntries(context.pullReviewComments),
      total: counts?.pullReviewComments,
      hydrated: counts?.pullReviewCommentsHydrated,
      truncated: counts?.pullReviewCommentsTruncated,
    }),
    reviewContextLedgerEntry({
      section: "counts",
      label: "context counts",
      value: counts ?? {},
      entries: Object.keys(counts ?? {}).length,
    }),
  ];
  return entries.filter((entry) => entry.entries > 0 || (entry.total ?? 0) > 0);
}

export function reviewContextLedgerForTest(context: ItemContext): ReviewContextLedgerEntry[] {
  return reviewContextLedger(context);
}

function reviewContextLedgerCountText(entry: ReviewContextLedgerEntry): string {
  if (entry.total !== undefined || entry.hydrated !== undefined) {
    const total = entry.total ?? entry.entries;
    const hydrated = entry.hydrated ?? entry.entries;
    const suffix = entry.truncated ? ", truncated" : "";
    return `${hydrated}/${total} hydrated${suffix}`;
  }
  return `${entry.entries} ${entry.entries === 1 ? "entry" : "entries"}`;
}

function renderReviewContextBudget(context: ItemContext): string {
  return reviewContextLedger(context)
    .map(
      (entry) => `- ${entry.label}: ${reviewContextLedgerCountText(entry)}, ${entry.chars} chars`,
    )
    .join("\n");
}

export function renderReviewContextBudgetForTest(context: ItemContext): string {
  return renderReviewContextBudget(context);
}

function runtimeReviewTextFromReport(markdown: string): string {
  return runtimeReviewText({
    model: frontMatterValue(markdown, "review_model") ?? "",
    reasoningEffort: frontMatterValue(markdown, "review_reasoning_effort") ?? "",
  });
}

function closeReviewLineFromDecision(
  decision: Decision,
  git: GitInfo,
  runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">,
): string {
  const fixed = fixedInText(decision);
  const parts = [runtimeReviewText(runtime), `reviewed against ${linkedSha(git.mainSha)}`].filter(
    Boolean,
  );
  if (fixed !== "not determined") parts.push(`fix evidence: ${fixed}`);
  return `Codex review notes: ${parts.join("; ")}.`;
}

function closeReviewLineFromReport(markdown: string): string {
  const mainSha = frontMatterValue(markdown, "main_sha");
  const fixed = fixedInReportText(markdown);
  const parts: string[] = [runtimeReviewTextFromReport(markdown)].filter(Boolean);
  if (mainSha && mainSha !== "unknown") parts.push(`reviewed against ${linkedSha(mainSha)}`);
  if (fixed !== "not determined") parts.push(`fix evidence: ${fixed}`);
  return parts.length ? `Codex review notes: ${parts.join("; ")}.` : "";
}

function renderCloseComment(options: {
  reason: CloseReason;
  summary: string;
  bestSolution?: string;
  reproductionAssessment?: string;
  solutionAssessment?: string;
  evidence: Evidence[];
  likelyOwners?: LikelyOwner[];
  fixedPullRequest?: FixedPullRequest | null;
  securityReview?: SecurityReview;
  reviewLine: string;
  currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
}): string {
  const evidence = options.evidence.slice(0, 6).map(closeEvidenceLine);
  const likelyOwners = (options.likelyOwners ?? []).slice(0, 5).map(likelyOwnerLine);
  const summaryLine = sentence(options.summary);
  const lines = [closeIntro(options.reason), "", summaryLine];
  if (options.fixedPullRequest?.confidence === "high") {
    lines.push(
      "",
      `I found the merged PR that appears to have closed this: ${markdownLink(
        `#${options.fixedPullRequest.number}: ${options.fixedPullRequest.title}`,
        options.fixedPullRequest.url,
      )}.`,
    );
  }
  const bestSolutionLine = sentence(options.bestSolution ?? "");
  const canonicalLinks = duplicateCanonicalLinks({
    reason: options.reason,
    bestSolutionLine,
    evidence: options.evidence,
    currentItem: options.currentItem,
  });
  const canonicalPathLine = duplicateCanonicalPathLine({
    reason: options.reason,
    summaryLine,
    bestSolutionLine,
    evidence: options.evidence,
  });
  if (canonicalPathLine) lines.push("", canonicalPathLine);
  const details: string[] = [];
  if (bestSolutionLine && publicReviewTextDiffers(bestSolutionLine, summaryLine)) {
    details.push("Best possible solution:", "", bestSolutionLine);
  }
  appendReviewQuestionDetails(details, options.reproductionAssessment, options.solutionAssessment);
  if (options.securityReview) {
    details.push("", "Security review:", "", securityReviewLine(options.securityReview));
    if (options.securityReview.concerns.length) {
      details.push("", ...options.securityReview.concerns.map(securityConcernDetailedLine));
    }
  }
  if (evidence.length) details.push("", "What I checked:", "", ...evidence);
  if (likelyOwners.length) details.push("", "Likely related people:", "", ...likelyOwners);

  const outro = closeOutro(options.reason, canonicalLinks);
  if (outro) lines.push("", outro);
  if (options.reviewLine) details.push("", options.reviewLine);
  const detailsBlock = collapsedDetailsBlock("Review details", details);
  if (detailsBlock) lines.push("", detailsBlock);

  return lines.join("\n");
}

function renderCloseCommentFromReport(markdown: string, reason: CloseReason): string {
  return sanitizePublicSelfReferences(
    renderCloseComment({
      reason,
      summary: reviewSectionValue(markdown, "summary"),
      bestSolution: reviewSectionValue(markdown, "bestSolution"),
      reproductionAssessment: reviewSectionValue(markdown, "reproductionAssessment"),
      solutionAssessment: reviewSectionValue(markdown, "solutionAssessment"),
      evidence: reportEvidence(markdown),
      likelyOwners: reportLikelyOwners(markdown),
      fixedPullRequest: fixedPullRequestFromReport(markdown),
      securityReview: reportSecurityReview(markdown),
      reviewLine: closeReviewLineFromReport(markdown),
      currentItem: {
        repo: markdownRepository(markdown),
        number: Number(frontMatterValue(markdown, "number")),
        kind: (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
      },
    }),
    Number(frontMatterValue(markdown, "number")),
    (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
  );
}

export function sanitizePublicSelfReferences(text: string, number: number, kind: ItemKind): string {
  if (!Number.isInteger(number) || number <= 0) return text;
  const noun = kind === "pull_request" ? "this PR" : "this issue";
  const escapedNumber = String(number).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selfRefSource = `#${escapedNumber}\\b`;
  const typedSelfRef = new RegExp(
    `\\b(?:Issue|issue|PR|pr|Pull request|pull request)\\s+${selfRefSource}`,
    "g",
  );
  const closingVerbSelfRef = new RegExp(
    `\\b(Fixes|fixes|Fix|fix|Closes|closes|Resolves|resolves)\\s+${selfRefSource}`,
    "g",
  );
  const selfRef = new RegExp(selfRefSource, "g");
  return text
    .replace(closingVerbSelfRef, (_match, verb: string) => `${verb} ${noun}`)
    .replace(typedSelfRef, noun)
    .replace(selfRef, noun)
    .replace(
      /(^|[.!?]\s+)(this issue|this PR)/g,
      (_match, prefix: string, value: string) =>
        `${prefix}${value[0]?.toUpperCase()}${value.slice(1)}`,
    );
}

function normalizeComment(
  decision: Decision,
  git: GitInfo,
  runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">,
  item?: { repo?: string; kind?: ItemKind; number?: number },
): string {
  return renderCloseComment({
    reason: decision.closeReason,
    summary: decision.summary,
    bestSolution: decision.bestSolution,
    reproductionAssessment: decision.reproductionAssessment,
    solutionAssessment: decision.solutionAssessment,
    evidence: decision.evidence,
    likelyOwners: decision.likelyOwners,
    fixedPullRequest: decision.fixedPullRequest ?? null,
    securityReview: decision.securityReview,
    reviewLine: closeReviewLineFromDecision(decision, git, runtime),
    currentItem: item,
  });
}

function reportWorkCandidateReason(markdown: string): string {
  const workCandidate = reviewSectionValue(markdown, "workCandidate");
  const reason = workCandidateReasonText(workCandidate);
  if (!reason || reason.startsWith("_No work-lane recommendation")) return "";
  return reason;
}

function collapsedDetailsBlock(summary: string, lines: readonly string[]): string {
  const body = lines.join("\n").trim();
  if (!body) return "";
  return ["<details>", `<summary>${summary}</summary>`, "", body, "", "</details>"].join("\n");
}

function appendPublicSection(lines: string[], heading: string, body: string): void {
  lines.push(`**${heading}**`, body, "");
}

function publicReproducibilityLine(reproductionAssessment: string): string {
  const assessmentLine = sentence(reproductionAssessment);
  if (!assessmentLine) return "";
  const match = assessmentLine.match(/^(yes|no|unclear|not applicable)\b/i);
  if (!match) return `Reproducibility: ${assessmentLine}`;
  const status = match[1]?.toLowerCase() ?? "";
  const detail = sentence(assessmentLine.slice(match[0].length).replace(/^[\s,.:;-]+/, ""));
  return `Reproducibility: ${status}.${detail ? ` ${detail}` : ""}`;
}

function publicSummaryBody(summaryLine: string, reproductionAssessment: string): string {
  return [summaryLine, publicReproducibilityLine(reproductionAssessment)]
    .filter(Boolean)
    .join("\n\n");
}

function publicMergeRiskLine(
  risks: string,
  nextStepLine: string,
  bestSolutionLine: string,
): string {
  if (isReportNoneList(risks)) return "";
  if (publicReviewTextIsSame(risks, nextStepLine)) return "";
  if (bestSolutionLine && publicReviewTextIsSame(risks, bestSolutionLine)) return "";
  const choices = mergeRiskResolutionChoices(bestSolutionLine, nextStepLine);
  return [
    `Why this matters: ${risks}`,
    choices.length ? ["", "Maintainer choices:", ...choices].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function mergeRiskResolutionChoices(bestSolutionLine: string, nextStepLine: string): string[] {
  const recommended = sentence(bestSolutionLine) || sentence(nextStepLine);
  const instruction = recommended || "Decide whether the merge risk is acceptable before merging.";
  return [
    mergeRiskAutomergeChoice(instruction),
    mergeRiskAcceptChoice(instruction),
    mergeRiskHumanDecisionChoice(instruction),
  ];
}

function mergeRiskAutomergeChoice(instruction: string): string {
  return [
    "1. (recommended) Fix the PR before merge with ClawSweeper automerge:",
    "",
    "```text",
    "@clawsweeper automerge",
    `Special instructions: ${instruction}`,
    "```",
  ].join("\n");
}

function mergeRiskAcceptChoice(instruction: string): string {
  return [
    "2. Accept the merge risk explicitly:",
    "",
    "```text",
    `Merge as-is only if maintainers intentionally accept this risk: ${instruction}`,
    "```",
  ].join("\n");
}

function mergeRiskHumanDecisionChoice(instruction: string): string {
  return [
    "3. Stop automation and require a human merge decision:",
    "",
    "```text",
    `Do not automerge this PR. Ask a maintainer to decide whether to require changes, merge anyway, or close the PR as not worth the risk: ${instruction}`,
    "```",
  ].join("\n");
}

function issueReproductionHelpSuggestions(markdown: string): string[] {
  if (frontMatterValue(markdown, "type") !== "issue") return [];
  const reproductionStatus = frontMatterValue(markdown, "reproduction_status");
  const reproductionConfidence = frontMatterValue(markdown, "reproduction_confidence");
  if (reproductionStatus === "reproduced" && reproductionConfidence === "high") return [];
  const reproductionAssessment = sentence(reviewSectionValue(markdown, "reproductionAssessment"));
  if (/^yes\b/i.test(reproductionAssessment)) return [];
  const sections = [
    reviewSectionValue(markdown, "summary"),
    reproductionAssessment,
    reviewSectionValue(markdown, "solutionAssessment"),
    reviewSectionValue(markdown, "evidence"),
    reviewSectionValue(markdown, "risks"),
  ];
  const text = sections.join("\n").toLowerCase();
  const suggestions: string[] = [];
  const hasMedia = /\b(?:screenshot|screen shot|video|recording|gif|image)\b/i.test(text);
  const hasSteps = /\b(?:step|steps|command|run|click|launch|workflow)\b/i.test(text);
  const hasExpectedActual = /\bexpected\b/i.test(text) && /\bactual\b/i.test(text);
  const hasLogs = /\b(?:log|logs|terminal|console|stack trace|traceback|output|error)\b/i.test(
    text,
  );
  const hasVersionContext =
    /\b(?:version|platform|os|macos|windows|linux|browser|provider|channel|config|settings)\b/i.test(
      text,
    );
  if (!hasMedia) {
    suggestions.push("Add a screenshot or short recording showing the behavior.");
  }
  if (!hasSteps) {
    suggestions.push("Include the exact command, prompt, or workflow that triggered it.");
  }
  if (!hasExpectedActual) {
    suggestions.push("Add expected vs actual behavior.");
  }
  if (!hasLogs) {
    suggestions.push("Include redacted logs or terminal output.");
  }
  if (!hasVersionContext) {
    suggestions.push("Share version, platform, channel/provider, and relevant config details.");
  }
  return suggestions.slice(0, 3);
}

function appendReviewQuestionDetails(
  details: string[],
  reproductionAssessment: string | undefined,
  solutionAssessment: string | undefined,
): void {
  const append = (heading: string, body: string) => {
    if (details.length) details.push("");
    details.push(heading, "", body);
  };
  const reproductionLine = sentence(reproductionAssessment ?? "");
  if (reproductionLine) {
    append("Do we have a high-confidence way to reproduce the issue?", reproductionLine);
  }
  const solutionLine = sentence(solutionAssessment ?? "");
  if (solutionLine) {
    append("Is this the best way to solve the issue?", solutionLine);
  }
}

function reviewWorkflowCallout(): string[] {
  return [
    "**Workflow note:** Future ClawSweeper reviews update this same comment in place.",
    "",
    collapsedDetailsBlock("How this review workflow works", [
      "- ClawSweeper keeps one durable marker-backed review comment per issue or PR.",
      "- Re-runs edit this comment so the latest verdict, findings, and automation markers stay together instead of adding duplicate bot comments.",
      "- A fresh review can be triggered by maintainer comments, exact-item GitHub events, scheduled/background review runs, or manual workflow dispatch.",
      "- PR/issue authors can comment `@clawsweeper re-review` or `@clawsweeper re-run` on their own open PR or issue to request a fresh review only.",
      "- Maintainers can also comment `@clawsweeper review` to request a fresh review only.",
      "- Fresh-review commands do not start repair, autofix, rebase, CI repair, or automerge.",
      "- Maintainer-only repair and merge flows require explicit commands such as `@clawsweeper autofix`, `@clawsweeper automerge`, `@clawsweeper fix ci`, or `@clawsweeper address review`.",
      "- Maintainers can comment `@clawsweeper explain` to ask for more context, or `@clawsweeper stop` to stop active automation.",
    ]),
    "",
  ];
}

function renderKeepOpenCommentFromReport(markdown: string): string {
  const evidence = reportEvidence(markdown).slice(0, 6).map(closeEvidenceLine);
  const likelyOwners = reportLikelyOwners(markdown).slice(0, 5).map(likelyOwnerLine);
  const reviewFindings = reportReviewFindings(markdown);
  const securityReview = reportSecurityReview(markdown);
  const realBehaviorProof = reportRealBehaviorProof(markdown);
  const prRating = reportPrRating(markdown);
  const mantisRecommendation = reportMantisRecommendation(markdown);
  const summary = reviewSectionValue(markdown, "summary");
  const changeSummary = reviewSectionValue(markdown, "changeSummary");
  const bestSolution = reviewSectionValue(markdown, "bestSolution");
  const reproductionAssessment = reviewSectionValue(markdown, "reproductionAssessment");
  const solutionAssessment = reviewSectionValue(markdown, "solutionAssessment");
  const risks = reviewSectionValue(markdown, "risks");
  const workReason = reportWorkCandidateReason(markdown);
  const workCandidate = frontMatterValue(markdown, "work_candidate");
  const validation = frontMatterStringArray(markdown, "work_validation")
    .slice(0, 5)
    .map((step) => `- ${step}`);
  const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
  const isRepairCandidate = workCandidate === "queue_fix_pr";
  const isRepairLoopPass = isPullRequest && Boolean(repairLoopPassModeFromReport(markdown));
  const hasRealBehaviorProofBlocker = isPullRequest && realBehaviorProofBlocksMerge(markdown);
  const summaryLine = sentence(summary) || "_No summary provided._";
  const changeSummaryLine = sentence(changeSummary || summary) || "_No change summary provided._";
  const fallbackNextStep =
    "Continue tracking this item until the missing behavior is implemented or a maintainer decides the product direction.";
  const nextStepLine = sentence(workReason || bestSolution || fallbackNextStep);
  const bestSolutionLine = sentence(bestSolution);
  const mergeRiskLine = isPullRequest
    ? publicMergeRiskLine(risks, nextStepLine, bestSolutionLine)
    : "";
  const details: string[] = [];
  const hasReviewFindings = isPullRequest && reviewFindings.length > 0;
  const lines = [
    hasRealBehaviorProofBlocker
      ? "Codex review: needs real behavior proof before merge."
      : isRepairLoopPass
        ? "Codex review: passed."
        : isPullRequest && isRepairCandidate
          ? "Codex review: needs changes before merge."
          : hasReviewFindings
            ? "Codex review: found issues before merge."
            : isPullRequest
              ? "Codex review: needs maintainer review before merge."
              : "Codex review: keeping this open for maintainer follow-up; there is still a little grit to resolve.",
    "",
    ...reviewWorkflowCallout(),
  ];
  if (isPullRequest) {
    appendPublicSection(
      lines,
      "Summary",
      publicSummaryBody(changeSummaryLine, reproductionAssessment),
    );
  } else {
    appendPublicSection(lines, "Summary", publicSummaryBody(summaryLine, reproductionAssessment));
  }
  if (!isPullRequest) {
    const reproductionHelp = issueReproductionHelpSuggestions(markdown);
    if (reproductionHelp.length) {
      appendPublicSection(
        lines,
        "Ways to help us reproduce this",
        reproductionHelp.map((suggestion) => `- ${suggestion}`).join("\n"),
      );
    }
  }
  if (isPullRequest) {
    appendPublicSection(lines, "PR rating", publicPrRatingLine(prRating, realBehaviorProof));
    appendPublicSection(
      lines,
      "Real behavior proof",
      publicRealBehaviorProofLine(realBehaviorProof),
    );
  }
  const mantisSuggestion = isPullRequest
    ? publicMantisRecommendationBlock(mantisRecommendation)
    : "";
  if (mantisSuggestion) appendPublicSection(lines, "Mantis proof suggestion", mantisSuggestion);
  if (mergeRiskLine) appendPublicSection(lines, "Risk before merge", mergeRiskLine);
  appendPublicSection(lines, isPullRequest ? "Next step before merge" : "Next step", nextStepLine);
  const securityLine = publicSecurityReviewLine(securityReview);
  if (securityLine) appendPublicSection(lines, "Security", securityLine);
  if (isPullRequest && reviewFindings.length) {
    lines.push("**Review findings**", ...reviewFindings.slice(0, 3).map(reviewFindingSummaryLine));
  }
  if (bestSolutionLine && publicReviewTextDiffers(bestSolutionLine, nextStepLine)) {
    details.push("Best possible solution:", "", bestSolutionLine);
  }
  appendReviewQuestionDetails(details, reproductionAssessment, solutionAssessment);
  if (isPullRequest && reviewFindings.length) {
    details.push(
      "",
      "Full review comments:",
      "",
      ...reviewFindings.map(reviewFindingDetailedLine),
      "",
      `Overall correctness: ${reportOverallCorrectness(markdown)}`,
      `Overall confidence: ${confidenceText(reportOverallConfidenceScore(markdown))}`,
    );
  }
  if (securityReview.concerns.length) {
    details.push(
      "",
      "Security concerns:",
      "",
      ...securityReview.concerns.map(securityConcernDetailedLine),
    );
  }
  if (validation.length) details.push("", "Acceptance criteria:", "", ...validation);
  if (evidence.length) details.push("", "What I checked:", "", ...evidence);
  if (likelyOwners.length) details.push("", "Likely related people:", "", ...likelyOwners);
  if (
    !isReportNoneList(risks) &&
    !mergeRiskLine &&
    publicReviewTextDiffers(risks, nextStepLine) &&
    (!bestSolutionLine || publicReviewTextDiffers(risks, bestSolutionLine))
  ) {
    details.push("", "Remaining risk / open question:", "", risks);
  }
  const reviewLine = closeReviewLineFromReport(markdown);
  if (reviewLine) details.push("", reviewLine);
  const detailsBlock = collapsedDetailsBlock("Review details", details);
  if (detailsBlock) lines.push("", detailsBlock);
  return sanitizePublicSelfReferences(
    lines.join("\n"),
    Number(frontMatterValue(markdown, "number")),
    (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
  );
}

export function renderReviewCommentFromReport(markdown: string, reason: CloseReason): string {
  const decision = frontMatterValue(markdown, "decision");
  const body =
    decision === "close" && reason !== "none"
      ? renderCloseCommentFromReport(markdown, reason)
      : renderKeepOpenCommentFromReport(markdown);
  const markers = reviewAutomationMarkersFromReport(markdown);
  return markers ? `${body.trimEnd()}\n\n${markers}` : body;
}

function hasUsableCloseComment(closeComment: string): boolean {
  const trimmed = closeComment.trim();
  return Boolean(trimmed) && trimmed !== "_No close comment posted._";
}

function hasImplementationSourceEvidence(decision: Decision): boolean {
  return decision.evidence.some(
    (entry) => Boolean(entry.file?.trim()) && Boolean(entry.sha?.trim()),
  );
}

function evidenceText(entry: Evidence): string {
  return [entry.label, entry.detail, entry.command ?? ""].join("\n");
}

function hasImplementationHistoryEvidence(decision: Decision): boolean {
  return decision.evidence.some((entry) =>
    evidenceText(entry).match(/\b(?:git (?:blame|show|log)|blame)\b/i),
  );
}

function hasImplementationReleaseStateEvidence(decision: Decision): boolean {
  return decision.evidence.some((entry) =>
    evidenceText(entry).match(
      /\b(?:release|tag|changelog|CHANGELOG|git (?:tag|describe|branch)|gh release|main-only|unreleased|published)\b/i,
    ),
  );
}

function hasValidFixedAt(decision: Decision): boolean {
  const value = decision.fixedAt?.trim();
  return Boolean(
    value &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)),
  );
}

function canClose(decision: Decision): boolean {
  return (
    decision.decision === "close" &&
    decision.confidence === "high" &&
    ALLOWED_REASONS.has(decision.closeReason)
  );
}

export function validateCloseDecision(
  item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo">>,
  decision: Decision,
  options: { requireCloseComment?: boolean } = {},
): { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string } {
  const requireCloseComment = options.requireCloseComment !== false;
  const profile = repositoryProfileFor(item.repo ?? targetRepo());
  if (decision.decision !== "close") {
    return {
      ok: false,
      actionTaken: "kept_open",
      reason: "not a close decision",
    };
  }
  if (isProtectedItem(item)) {
    return {
      ok: false,
      actionTaken: "skipped_protected_label",
      reason: protectedLabelReason(item.labels),
    };
  }
  if (!canClose(decision)) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "close decision is not high-confidence with an allowed close reason",
    };
  }
  if (!isAutoCloseAllowed(profile, item.kind, decision.closeReason)) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} is not allowed for ${profile.targetRepo} ${item.kind} apply policy`,
    };
  }
  if (item.kind !== "pull_request" && decision.closeReason === "mostly_implemented_on_main") {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "mostly_implemented_on_main is allowed only for pull requests",
    };
  }
  if (item.kind === "pull_request" && decision.closeReason === "stale_insufficient_info") {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "stale_insufficient_info is not allowed for pull requests",
    };
  }
  if (!decision.summary.trim()) {
    return { ok: false, actionTaken: "skipped_invalid_decision", reason: "missing summary" };
  }
  if (requireCloseComment && !hasUsableCloseComment(decision.closeComment)) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "missing close comment",
    };
  }
  if (decision.evidence.length === 0) {
    return { ok: false, actionTaken: "skipped_invalid_decision", reason: "missing evidence" };
  }
  if (
    isImplementationCloseReason(decision.closeReason) &&
    !hasImplementationSourceEvidence(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} requires evidence with file and sha`,
    };
  }
  if (isImplementationCloseReason(decision.closeReason) && !decision.fixedSha?.trim()) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} requires fixedSha`,
    };
  }
  if (
    isImplementationCloseReason(decision.closeReason) &&
    decision.fixedAt &&
    !hasValidFixedAt(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} fixedAt must be an ISO timestamp`,
    };
  }
  if (
    isImplementationCloseReason(decision.closeReason) &&
    !decision.fixedRelease?.trim() &&
    !hasValidFixedAt(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} requires fixedRelease or fixedAt`,
    };
  }
  if (
    isImplementationCloseReason(decision.closeReason) &&
    !hasImplementationHistoryEvidence(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} requires git history provenance evidence`,
    };
  }
  if (
    isImplementationCloseReason(decision.closeReason) &&
    !hasImplementationReleaseStateEvidence(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} requires release or main-only provenance evidence`,
    };
  }
  return { ok: true };
}

function isImplementationCloseReason(reason: CloseReason): boolean {
  return reason === "implemented_on_main" || reason === "mostly_implemented_on_main";
}

function reviewCommentMarker(number: number): string {
  return `${REVIEW_COMMENT_MARKER_PREFIX} item=${number} -->`;
}

function pullHeadShaFromContext(context: ItemContext): string | null {
  const pull = asRecord(context.pullRequest);
  const head = asRecord(pull.head);
  const sha = head.sha;
  return typeof sha === "string" && sha.trim() ? sha.trim() : null;
}

function pullHeadShaFromReport(markdown: string): string | null {
  const value = frontMatterValue(markdown, "pull_head_sha");
  return value && value !== "unknown" ? value : null;
}

function markerAttributeValue(value: string): string {
  return value.trim().replace(/[^\w./:@-]/g, "_") || "unknown";
}

export function reviewAutomationMarkersFromReport(markdown: string): string {
  const itemKind = frontMatterValue(markdown, "type");
  if (itemKind !== "pull_request") return "";
  const number = frontMatterValue(markdown, "number") ?? "unknown";
  const decision = frontMatterValue(markdown, "decision");
  const confidence = frontMatterValue(markdown, "confidence") ?? "unknown";
  const headSha = pullHeadShaFromReport(markdown) ?? "unknown";
  const baseAttrs = [
    `item=${markerAttributeValue(number)}`,
    `sha=${markerAttributeValue(headSha)}`,
    `confidence=${markerAttributeValue(confidence)}`,
  ].join(" ");

  if (frontMatterValue(markdown, "review_status") === "failed") {
    return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
  }
  const hasRealBehaviorProofBlocker = realBehaviorProofBlocksMerge(markdown);
  if (reportSecurityReview(markdown).status === "needs_attention") {
    const markers = [`<!-- clawsweeper-security:security-sensitive ${baseAttrs} -->`];
    if (!hasRealBehaviorProofBlocker && securitySensitiveRepairAllowed(markdown)) {
      markers.push(
        `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
        `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=security-review -->`,
      );
    } else {
      markers.push(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
    }
    return markers.join("\n");
  }
  if (hasRealBehaviorProofBlocker) {
    return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
  }
  if (decision === "keep_open") {
    if (repairLoopPassModeFromReport(markdown)) {
      return `<!-- clawsweeper-verdict:pass ${baseAttrs} -->`;
    }
    if (repairLoopFindingRepairAllowed(markdown)) {
      return [
        `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
        `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=review-feedback -->`,
      ].join("\n");
    }
    if (frontMatterValue(markdown, "work_candidate") !== "queue_fix_pr") {
      return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
    }
    return [
      `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
      `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=review-feedback -->`,
    ].join("\n");
  }
  if (decision === "close") {
    return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
  }
  return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
}

function repairLoopPassModeFromReport(markdown: string): "" | "autofix" | "automerge" {
  if (!isRepairLoopPassReport(markdown)) return "";
  return frontMatterStringArray(markdown, "labels").includes(AUTOFIX_LABEL)
    ? "autofix"
    : "automerge";
}

function securitySensitiveRepairAllowed(markdown: string): boolean {
  const labels = frontMatterStringArray(markdown, "labels");
  return (
    frontMatterValue(markdown, "decision") === "keep_open" &&
    (labels.includes(AUTOFIX_LABEL) || labels.includes(AUTOMERGE_LABEL))
  );
}

function repairLoopFindingRepairAllowed(markdown: string): boolean {
  const labels = frontMatterStringArray(markdown, "labels");
  return (
    (labels.includes(AUTOMERGE_LABEL) || labels.includes(AUTOFIX_LABEL)) &&
    !realBehaviorProofBlocksMerge(markdown) &&
    reportReviewFindings(markdown).length > 0
  );
}

function isRepairLoopPassReport(markdown: string): boolean {
  const labels = frontMatterStringArray(markdown, "labels");
  return (
    (labels.includes(AUTOMERGE_LABEL) || labels.includes(AUTOFIX_LABEL)) &&
    frontMatterValue(markdown, "review_status") === "complete" &&
    frontMatterValue(markdown, "confidence") === "high" &&
    frontMatterValue(markdown, "decision") === "keep_open" &&
    !realBehaviorProofBlocksMerge(markdown) &&
    reportOverallCorrectness(markdown) === "patch is correct" &&
    reportReviewFindings(markdown).length === 0
  );
}

function markedReviewCommentBody(number: number, body: string): string {
  return body.includes(reviewCommentMarker(number))
    ? body
    : `${body.trimEnd()}\n\n${reviewCommentMarker(number)}`;
}

function reviewStartStatusCommentMarker(number: number): string {
  return `${REVIEW_START_STATUS_MARKER_PREFIX}:started item=${number} -->`;
}

export function renderReviewStartStatusComment(options: ReviewStartStatusCommentOptions): string {
  const subject = options.kind === "pull_request" ? "pull request" : "issue";
  const progress =
    Number.isInteger(options.position) && Number.isInteger(options.total)
      ? ` This is item ${options.position}/${options.total} in the current shard.`
      : "";
  const shard =
    Number.isInteger(options.shardIndex) && Number.isInteger(options.shardCount)
      ? ` Shard ${options.shardIndex}/${options.shardCount}.`
      : "";
  const title = options.title.trim();
  const heading = title
    ? `I am starting a fresh review of this ${subject}: ${title}`
    : `I am starting a fresh review of this ${subject}.`;
  return markedReviewCommentBody(
    options.number,
    [
      "ClawSweeper status: review started.",
      "",
      `${heading}${progress}${shard}`,
      "",
      "This placeholder means the worker is alive and reading the current context. I will edit this same comment with the actual review when the claws are done clicking.",
      "",
      "Crustacean status: shell secured, claws on keyboard, evidence pebbles being sorted.",
      "",
      reviewStartStatusCommentMarker(options.number),
    ].join("\n"),
  );
}

export function isCodexReviewCommentBody(body: string): boolean {
  return (
    body.includes("Codex review:") ||
    body.includes("Codex review notes:") ||
    body.includes("Codex Review notes:") ||
    body.includes("Codex automated review:") ||
    body.includes("after Codex review.") ||
    body.includes("after Codex automated review.")
  );
}

function issueReviewComment(
  number: number,
  fallbackBodies: readonly string[] = [],
): Record<string, unknown> | undefined {
  const marker = reviewCommentMarker(number);
  const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(
    asRecord,
  );
  const markedComments = comments.filter((candidate) => {
    const body = candidate.body;
    return typeof body === "string" && body.includes(marker);
  });
  const patchableMarked = markedComments.find(canPatchReviewComment);
  if (patchableMarked) return patchableMarked;
  const marked = markedComments[0];
  if (marked) return marked;
  const exactBodies = new Set(fallbackBodies.map((body) => body.trim()).filter(Boolean));
  const exactComments = comments.filter((candidate) => {
    const body = candidate.body;
    return typeof body === "string" && exactBodies.has(body.trim());
  });
  const patchableExact = exactComments.find(canPatchReviewComment);
  if (patchableExact) return patchableExact;
  const exact = exactComments[0];
  if (exact) return exact;
  const codexComments = comments.filter((candidate) => {
    const body = candidate.body;
    return typeof body === "string" && isCodexReviewCommentBody(body);
  });
  return codexComments.find(canPatchReviewComment) ?? codexComments[0];
}

function commentUpdatedAt(comment: Record<string, unknown> | undefined): string | undefined {
  const updatedAt = comment?.updated_at;
  if (typeof updatedAt === "string") return updatedAt;
  const createdAt = comment?.created_at;
  return typeof createdAt === "string" ? createdAt : undefined;
}

function commentId(comment: Record<string, unknown> | undefined): number | null {
  const id = comment?.id;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

function commentUrl(comment: Record<string, unknown> | undefined): string | null {
  const url = comment?.html_url;
  return typeof url === "string" ? url : null;
}

function commentBody(comment: Record<string, unknown> | undefined): string | undefined {
  const body = comment?.body;
  return typeof body === "string" ? body : undefined;
}

function commentBodyMatches(comment: Record<string, unknown> | undefined, body: string): boolean {
  return commentBody(comment)?.trim() === body.trim();
}

const PATCHABLE_REVIEW_COMMENT_AUTHORS = new Set(
  [
    "clawsweeper",
    "clawsweeper[bot]",
    "openclaw-clawsweeper[bot]",
    process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN,
  ].filter((login): login is string => typeof login === "string" && login.length > 0),
);

function commentAuthorLogin(comment: Record<string, unknown> | undefined): string | undefined {
  const user = comment?.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return undefined;
  const login = (user as Record<string, unknown>).login;
  return typeof login === "string" ? login : undefined;
}

export function canPatchReviewComment(comment: Record<string, unknown> | undefined): boolean {
  const login = commentAuthorLogin(comment);
  return Boolean(login && PATCHABLE_REVIEW_COMMENT_AUTHORS.has(login));
}

export function lockedConversationApplyReason(
  item: Pick<Item, "activeLockReason" | "locked">,
): string | null {
  if (!item.locked) return null;
  return `conversation is locked${item.activeLockReason ? ` (${item.activeLockReason})` : ""}`;
}

export function reviewArtifactDestination(
  action: string | undefined,
  itemIsOpen: boolean,
): ReviewArtifactDestination {
  if (!itemIsOpen) return "skip_closed";
  return action === "closed" || action === "skipped_already_closed" ? "closed" : "items";
}

export function runtimeBudgetExceeded(
  startedAtMs: number,
  maxRuntimeMs: number,
  nowMs: number,
): boolean {
  return maxRuntimeMs > 0 && nowMs - startedAtMs >= maxRuntimeMs;
}

function updateReviewCommentMetadata(
  markdown: string,
  comment: Record<string, unknown> | undefined,
  body: string,
): string {
  let next = replaceFrontMatterValue(markdown, "review_comment_sha256", sha256(body));
  const id = commentId(comment);
  const url = commentUrl(comment);
  if (id !== null) next = replaceFrontMatterValue(next, "review_comment_id", String(id));
  if (url) next = replaceFrontMatterValue(next, "review_comment_url", url);
  next = replaceFrontMatterValue(next, "review_comment_synced_at", new Date().toISOString());
  return next;
}

function writeCommentPayload(number: number, body: string): string {
  const commentFile = join(ROOT, ".artifacts", `comment-${number}.md`);
  ensureDir(dirname(commentFile));
  writeFileSync(commentFile, body, "utf8");
  const commentPayloadFile = join(ROOT, ".artifacts", `comment-${number}.json`);
  writeFileSync(commentPayloadFile, JSON.stringify({ body }), "utf8");
  return commentPayloadFile;
}

function upsertReviewComment(
  number: number,
  body: string,
  existing = issueReviewComment(number, [body]),
): Record<string, unknown> | undefined {
  const markedBody = markedReviewCommentBody(number, body);
  const id = commentId(existing);
  const payload = writeCommentPayload(number, markedBody);
  if (id !== null && canPatchReviewComment(existing)) {
    ghWithRetry([
      "api",
      `repos/${targetRepo()}/issues/comments/${id}`,
      "--method",
      "PATCH",
      "--input",
      payload,
    ]);
  } else {
    ghWithRetry([
      "api",
      `repos/${targetRepo()}/issues/${number}/comments`,
      "--method",
      "POST",
      "--input",
      payload,
    ]);
  }
  return issueReviewComment(number, [markedBody]);
}

function postReviewStartStatusComment(options: {
  item: Item;
  position: number;
  total: number;
  shardIndex: number;
  shardCount: number;
}): "posted" | "existing" {
  if (issueReviewComment(options.item.number)) return "existing";
  const body = renderReviewStartStatusComment({
    number: options.item.number,
    kind: options.item.kind,
    title: options.item.title,
    position: options.position,
    total: options.total,
    shardIndex: options.shardIndex,
    shardCount: options.shardCount,
  });
  const payload = writeCommentPayload(options.item.number, body);
  ghWithRetry([
    "api",
    `repos/${targetRepo()}/issues/${options.item.number}/comments`,
    "--method",
    "POST",
    "--input",
    payload,
  ]);
  return "posted";
}

function closeItem(options: { number: number; kind: ItemKind; reason: CloseReason }): void {
  if (options.kind === "pull_request") {
    ghWithRetry(["pr", "close", String(options.number)]);
  } else {
    const reason = isImplementationCloseReason(options.reason) ? "completed" : "not_planned";
    const closePayloadFile = join(ROOT, ".artifacts", `close-${options.number}.json`);
    writeFileSync(
      closePayloadFile,
      JSON.stringify({ state: "closed", state_reason: reason }),
      "utf8",
    );
    ghWithRetry([
      "api",
      `repos/${targetRepo()}/issues/${options.number}`,
      "--method",
      "PATCH",
      "--input",
      closePayloadFile,
    ]);
  }
}

export function reviewActionForDecision(options: {
  item: Item;
  decision: Decision;
  git: GitInfo;
  runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">;
}): Action {
  if (options.decision.decision !== "close") return { actionTaken: "kept_open", closeComment: "" };
  if (isMaintainerAuthored(options.item)) {
    return { actionTaken: "skipped_maintainer_authored", closeComment: "" };
  }
  const validation = validateCloseDecision(options.item, options.decision, {
    requireCloseComment: false,
  });
  if (!validation.ok) return { actionTaken: validation.actionTaken, closeComment: "" };
  const closeComment = normalizeComment(
    options.decision,
    options.git,
    options.runtime,
    options.item,
  );
  if (!hasUsableCloseComment(closeComment)) {
    return { actionTaken: "skipped_invalid_decision", closeComment: "" };
  }
  return { actionTaken: "proposed_close", closeComment };
}

function markdownList(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- none";
}

function renderWorkCandidateReportSection(decision: Decision): string {
  const lines = [
    `Candidate: ${decision.workCandidate}`,
    "",
    `Confidence: ${decision.workConfidence}`,
    "",
    `Priority: ${decision.workPriority}`,
    "",
    `Status: ${workStatusForDecision(decision)}`,
  ];
  const workReason = decision.workReason.trim();
  if (workReason) lines.push("", `Reason: ${workReason}`);

  const includeDetails =
    decision.workCandidate !== "none" ||
    decision.workClusterRefs.length > 0 ||
    decision.workLikelyFiles.length > 0 ||
    decision.workValidation.length > 0;
  if (includeDetails) {
    lines.push("", "Cluster refs:", "", markdownList(decision.workClusterRefs));
    lines.push("", "Likely files:", "", markdownList(decision.workLikelyFiles));
    lines.push("", "Validation:", "", markdownList(decision.workValidation));
  }
  return lines.join("\n");
}

function renderRepairWorkPromptReportSection(decision: Decision): string {
  const workPrompt = decision.workPrompt.trim();
  return workPrompt ? `\n\n## ${REVIEW_SECTIONS.repairWorkPrompt}\n\n${workPrompt}` : "";
}

function renderReviewFindingsReportSection(decision: Decision): string {
  const lines = [
    `Overall correctness: ${decision.overallCorrectness}`,
    "",
    `Overall confidence: ${confidenceText(decision.overallConfidenceScore)}`,
    "",
    "Full review comments:",
    "",
  ];
  if (!decision.reviewFindings.length) {
    lines.push("- none");
    return lines.join("\n");
  }
  lines.push(
    decision.reviewFindings
      .map((finding) =>
        [
          `- **[${priorityLabel(finding.priority)}] ${finding.title}:** \`${reviewFindingLocation(
            finding,
          )}\``,
          `  - body: ${sentence(finding.body)}`,
          `  - confidence: ${confidenceText(finding.confidenceScore)}`,
        ].join("\n"),
      )
      .join("\n"),
  );
  return lines.join("\n");
}

function securityConcernLocation(concern: SecurityConcern): string {
  if (!concern.file) return "not tied to a single file";
  return `${concern.file}${concern.line ? `:${concern.line}` : ""}`;
}

function renderSecurityReviewReportSection(decision: Decision): string {
  const lines = [
    `Status: ${decision.securityReview.status}`,
    "",
    `Summary: ${sentence(decision.securityReview.summary)}`,
    "",
    "Concerns:",
    "",
  ];
  if (!decision.securityReview.concerns.length) {
    lines.push("- none");
    return lines.join("\n");
  }
  lines.push(
    decision.securityReview.concerns
      .map((concern) => {
        const location = securityConcernLocation(concern);
        const heading =
          location === "not tied to a single file"
            ? `- **[${concern.severity}] ${concern.title}:**`
            : `- **[${concern.severity}] ${concern.title}:** \`${location}\``;
        return [
          heading,
          `  - body: ${sentence(concern.body)}`,
          `  - confidence: ${confidenceText(concern.confidenceScore)}`,
        ].join("\n");
      })
      .join("\n"),
  );
  return lines.join("\n");
}

function renderRealBehaviorProofReportSection(decision: Decision): string {
  return [
    `Status: ${decision.realBehaviorProof.status}`,
    "",
    `Evidence kind: ${decision.realBehaviorProof.evidenceKind}`,
    "",
    `Needs contributor action: ${decision.realBehaviorProof.needsContributorAction}`,
    "",
    `Summary: ${sentence(decision.realBehaviorProof.summary)}`,
  ].join("\n");
}

function renderPrRatingReportSection(decision: Decision): string {
  const nextSteps = decision.prRating.nextSteps.length
    ? decision.prRating.nextSteps.map((step) => `- ${step}`).join("\n")
    : "- none";
  const shiny = hasShinyProof(decision.realBehaviorProof) ? " ✨" : "";
  return [
    `Overall tier: ${decision.prRating.overallTier}`,
    "",
    `Proof tier: ${decision.prRating.proofTier}`,
    "",
    `Patch tier: ${decision.prRating.patchTier}`,
    "",
    `Overall label: ${themedRatingName(decision.prRating.overallTier)}`,
    "",
    `Proof label: ${themedRatingName(decision.prRating.proofTier)}${shiny}`,
    "",
    `Patch label: ${themedRatingName(decision.prRating.patchTier)}`,
    "",
    `Summary: ${sentence(decision.prRating.summary)}`,
    "",
    "Next rank-up steps:",
    "",
    nextSteps,
  ].join("\n");
}

function renderTelegramVisibleProofReportSection(decision: Decision): string {
  return [
    `Status: ${decision.telegramVisibleProof.status}`,
    "",
    `Summary: ${sentence(decision.telegramVisibleProof.summary)}`,
  ].join("\n");
}

function renderMantisRecommendationReportSection(decision: Decision): string {
  return [
    `Status: ${decision.mantisRecommendation.status}`,
    "",
    `Scenario: ${decision.mantisRecommendation.scenario}`,
    "",
    `Reason: ${sentence(decision.mantisRecommendation.reason)}`,
    "",
    `Maintainer comment: ${decision.mantisRecommendation.maintainerComment.trim()}`,
  ].join("\n");
}

export function pullRequestFilePathsFromContextForTest(context: {
  pullFiles?: unknown[];
}): string[] {
  return (context.pullFiles ?? []).flatMap(compactPullFilePaths);
}

function pullRequestFilePathsFromContext(context: ItemContext): string[] {
  return pullRequestFilePathsFromContextForTest(context);
}

function markdownFor(options: {
  item: Item;
  context: ItemContext;
  decision: Decision;
  git: GitInfo;
  action: Action;
  reviewMode: "propose" | "apply";
  snapshotHash: string;
  reviewPolicy: string;
  runtime: ReviewRuntime;
}): string {
  const labels = options.item.labels.length ? options.item.labels.join(", ") : "none";
  const fixedPullRequest = options.decision.fixedPullRequest;
  const evidence = options.decision.evidence.length
    ? options.decision.evidence
        .map((entry) => {
          const bits = [`- **${entry.label}:** ${entry.detail}`];
          if (entry.file) {
            const parsed = splitFileAndLine(entry.file, entry.line);
            const label = `${parsed.file}${parsed.line ? `:${parsed.line}` : ""}`;
            bits.push(
              `  - file: ${markdownLink(label, fileUrl(parsed.file, entry.sha ?? options.git.mainSha, parsed.line))}`,
            );
          }
          if (entry.command) bits.push(`  - command: \`${entry.command}\``);
          if (entry.sha) bits.push(`  - sha: ${linkedSha(entry.sha)}`);
          return bits.join("\n");
        })
        .join("\n")
    : "- none";
  const risks = options.decision.risks.length
    ? options.decision.risks.map((risk) => `- ${risk}`).join("\n")
    : "- none";
  const likelyOwners = options.decision.likelyOwners.length
    ? options.decision.likelyOwners
        .map((owner) => {
          const bits = [`- **${owner.person}:** ${publicLikelyOwnerRole(owner.role)}`];
          bits.push(`  - reason: ${owner.reason}`);
          bits.push(`  - confidence: ${owner.confidence}`);
          if (owner.commits.length) bits.push(`  - commits: ${owner.commits.join(", ")}`);
          if (owner.files.length) bits.push(`  - files: ${owner.files.join(", ")}`);
          return bits.join("\n");
        })
        .join("\n")
    : "- none";
  const bestSolution = options.decision.bestSolution.trim() || "_Not provided._";
  const reproductionAssessment =
    options.decision.reproductionAssessment.trim() || "_Not provided._";
  const solutionAssessment = options.decision.solutionAssessment.trim() || "_Not provided._";
  const reviewFindings = renderReviewFindingsReportSection(options.decision);
  const securityReview = renderSecurityReviewReportSection(options.decision);
  const realBehaviorProof = renderRealBehaviorProofReportSection(options.decision);
  const prRating = renderPrRatingReportSection(options.decision);
  const telegramVisibleProof = renderTelegramVisibleProofReportSection(options.decision);
  const mantisRecommendation = renderMantisRecommendationReportSection(options.decision);
  const workCandidateSection = renderWorkCandidateReportSection(options.decision);
  const repairWorkPromptSection = renderRepairWorkPromptReportSection(options.decision);
  const pullFiles = pullRequestFilePathsFromContext(options.context);
  const pullFilesTruncated = Boolean(options.context.counts?.pullFilesTruncated);
  return `---
number: ${options.item.number}
repository: ${options.item.repo}
type: ${options.item.kind}
title: ${JSON.stringify(options.item.title)}
url: ${options.item.url}
state_at_review: open
item_created_at: ${options.item.createdAt}
item_updated_at: ${options.item.updatedAt}
author: ${options.item.author}
author_association: ${options.item.authorAssociation}
labels: ${JSON.stringify(options.item.labels)}
reviewed_at: ${new Date().toISOString()}
main_sha: ${options.git.mainSha}
pull_head_sha: ${pullHeadShaFromContext(options.context) ?? "unknown"}
latest_release: ${options.git.latestRelease?.tagName ?? "unknown"}
latest_release_sha: ${options.git.latestRelease?.sha ?? "unknown"}
fixed_release: ${options.decision.fixedRelease ?? "unknown"}
fixed_sha: ${options.decision.fixedSha ?? "unknown"}
fixed_at: ${options.decision.fixedAt ?? "unknown"}
fixed_pr_url: ${fixedPullRequest?.url ?? "unknown"}
fixed_pr_number: ${fixedPullRequest?.number ?? "unknown"}
fixed_pr_title: ${fixedPullRequest ? JSON.stringify(fixedPullRequest.title) : "unknown"}
fixed_pr_merged_at: ${fixedPullRequest?.mergedAt ?? "unknown"}
fixed_pr_sha: ${fixedPullRequest?.sha ?? "unknown"}
fixed_pr_confidence: ${fixedPullRequest?.confidence ?? "unknown"}
fixed_pr_source: ${fixedPullRequest ? JSON.stringify(fixedPullRequest.source) : "unknown"}
review_policy: ${options.reviewPolicy}
review_model: ${options.runtime.model}
review_reasoning_effort: ${options.runtime.reasoningEffort}
review_sandbox: ${options.runtime.sandboxMode ?? "unknown"}
review_service_tier: ${options.runtime.serviceTier || "default"}
review_prompt_chars: ${reviewTelemetryNumber(options.runtime.promptChars)}
review_static_prompt_chars: ${reviewTelemetryNumber(options.runtime.staticPromptChars)}
review_context_chars: ${reviewTelemetryNumber(options.runtime.contextChars)}
review_schema_chars: ${reviewTelemetryNumber(options.runtime.schemaChars)}
review_additional_prompt_chars: ${reviewTelemetryNumber(options.runtime.additionalPromptChars)}
review_context_elapsed_ms: ${reviewTelemetryNumber(options.runtime.contextElapsedMs)}
review_codex_elapsed_ms: ${reviewTelemetryNumber(options.runtime.codexElapsedMs)}
review_mode: ${options.reviewMode}
review_status: ${options.decision.summary.startsWith("Codex review failed") ? "failed" : "complete"}
local_checkout_access: verified
item_snapshot_hash: ${options.snapshotHash}
close_comment_sha256: ${options.action.closeComment ? sha256(options.action.closeComment) : "none"}
review_comment_sha256: none
review_comment_id: unknown
review_comment_url: unknown
decision: ${options.decision.decision}
close_reason: ${options.decision.closeReason}
confidence: ${options.decision.confidence}
action_taken: ${options.action.actionTaken}
work_candidate: ${options.decision.workCandidate}
work_confidence: ${options.decision.workConfidence}
work_priority: ${options.decision.workPriority}
work_status: ${workStatusForDecision(options.decision)}
work_reason_sha256: ${options.decision.workReason ? sha256(options.decision.workReason) : "none"}
work_prompt_sha256: ${options.decision.workPrompt ? sha256(options.decision.workPrompt) : "none"}
work_cluster_refs: ${jsonFrontMatterValue(options.decision.workClusterRefs)}
work_validation: ${jsonFrontMatterValue(options.decision.workValidation)}
work_likely_files: ${jsonFrontMatterValue(options.decision.workLikelyFiles)}
triage_priority: ${options.decision.triagePriority}
impact_labels: ${jsonFrontMatterValue(options.decision.impactLabels)}
merge_risk_labels: ${jsonFrontMatterValue(options.decision.mergeRiskLabels)}
pull_files: ${jsonFrontMatterValue(pullFiles)}
pull_files_truncated: ${pullFilesTruncated}
item_category: ${options.decision.itemCategory}
reproduction_status: ${options.decision.reproductionStatus}
reproduction_confidence: ${options.decision.reproductionConfidence}
requires_new_feature: ${options.decision.requiresNewFeature}
requires_new_config_option: ${options.decision.requiresNewConfigOption}
requires_product_decision: ${options.decision.requiresProductDecision}
real_behavior_proof_status: ${options.decision.realBehaviorProof.status}
real_behavior_proof_evidence_kind: ${options.decision.realBehaviorProof.evidenceKind}
real_behavior_proof_needs_contributor_action: ${options.decision.realBehaviorProof.needsContributorAction}
pr_rating_overall: ${options.decision.prRating.overallTier}
pr_rating_proof: ${options.decision.prRating.proofTier}
pr_rating_patch: ${options.decision.prRating.patchTier}
telegram_visible_proof_status: ${options.decision.telegramVisibleProof.status}
mantis_recommendation_status: ${options.decision.mantisRecommendation.status}
mantis_recommendation_scenario: ${options.decision.mantisRecommendation.scenario}
---

# ${markdownLink(`#${options.item.number}: ${options.item.title}`, options.item.url)}

Type: ${options.item.kind}

URL: ${markdownLink(options.item.url, options.item.url)}

Author: ${options.item.author}

Author association: ${options.item.authorAssociation}

Labels: ${labels}

Created at: ${formatTimestamp(options.item.createdAt)}

Updated at: ${formatTimestamp(options.item.updatedAt)}

Reviewed against: ${linkedSha(options.git.mainSha)}

Codex review: ${runtimeReviewText(options.runtime)}

Latest release at review time: ${
    options.git.latestRelease?.tagName
      ? linkedRelease(options.git.latestRelease.tagName)
      : "unknown"
  }${options.git.latestRelease?.sha ? ` (${linkedSha(options.git.latestRelease.sha)})` : ""}

Fixed in: ${fixedInText(options.decision)}

## Decision

${options.decision.decision === "close" ? "Close" : "Keep open"}: ${closeReasonText(options.decision.closeReason)}

Confidence: ${options.decision.confidence}

Action taken: ${options.action.actionTaken}

## ${REVIEW_SECTIONS.summary}

${options.decision.summary}

## ${REVIEW_SECTIONS.changeSummary}

${options.decision.changeSummary}

## ${REVIEW_SECTIONS.bestSolution}

${bestSolution}

## ${REVIEW_SECTIONS.reproductionAssessment}

${reproductionAssessment}

## ${REVIEW_SECTIONS.solutionAssessment}

${solutionAssessment}

## ${REVIEW_SECTIONS.reviewFindings}

${reviewFindings}

## ${REVIEW_SECTIONS.securityReview}

${securityReview}

## ${REVIEW_SECTIONS.realBehaviorProof}

${realBehaviorProof}

## ${REVIEW_SECTIONS.prRating}

${prRating}

## ${REVIEW_SECTIONS.telegramVisibleProof}

${telegramVisibleProof}

## ${REVIEW_SECTIONS.mantisRecommendation}

${mantisRecommendation}

## ${REVIEW_SECTIONS.workCandidate}

${workCandidateSection}${repairWorkPromptSection}

## ${REVIEW_SECTIONS.evidence}

${evidence}

## ${REVIEW_SECTIONS.likelyOwners}

${likelyOwners}

## ${REVIEW_SECTIONS.risks}

${risks}

## ${REVIEW_SECTIONS.closeComment}

${options.action.closeComment ? options.action.closeComment : "_No close comment posted._"}

## GitHub Snapshot

- comments: ${contextCountText(
    options.context.counts?.comments,
    options.context.comments.length,
    options.context.counts?.commentsHydrated,
    options.context.counts?.commentsTruncated,
  )}
- timeline events: ${contextCountText(
    options.context.counts?.timeline,
    options.context.timeline.length,
    options.context.counts?.timelineHydrated,
    options.context.counts?.timelineTruncated,
  )}
- related items: ${options.context.counts?.relatedItems ?? options.context.relatedItems?.length ?? 0}
- PR files: ${contextCountText(
    options.context.counts?.pullFiles,
    options.context.pullFiles?.length ?? 0,
    options.context.counts?.pullFilesHydrated,
    options.context.counts?.pullFilesTruncated,
  )}
- PR commits: ${contextCountText(
    options.context.counts?.pullCommits,
    options.context.pullCommits?.length ?? 0,
    options.context.counts?.pullCommitsHydrated,
    options.context.counts?.pullCommitsTruncated,
  )}
- PR review comments: ${contextCountText(
    options.context.counts?.pullReviewComments,
    options.context.pullReviewComments?.length ?? 0,
    options.context.counts?.pullReviewCommentsHydrated,
    options.context.counts?.pullReviewCommentsTruncated,
  )}

## Review Context Budget

${renderReviewContextBudget(options.context)}

## Review Telemetry

- prompt chars: ${reviewTelemetryNumber(options.runtime.promptChars)}
- static prompt chars: ${reviewTelemetryNumber(options.runtime.staticPromptChars)}
- context chars: ${reviewTelemetryNumber(options.runtime.contextChars)}
- schema chars: ${reviewTelemetryNumber(options.runtime.schemaChars)}
- additional prompt chars: ${reviewTelemetryNumber(options.runtime.additionalPromptChars)}
- context collection ms: ${reviewTelemetryNumber(options.runtime.contextElapsedMs)}
- Codex review ms: ${reviewTelemetryNumber(options.runtime.codexElapsedMs)}
  `;
}

function planCommand(args: Args): void {
  repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const batchSize = numberArg(args.batch_size, DEFAULT_PLAN_BATCH_SIZE);
  const maxPages = numberArg(args.max_pages, 250);
  const shardCount = numberArg(args.shard_count, DEFAULT_PLAN_SHARD_COUNT);
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
  const reviewPolicy = reviewPolicyHash({ model, reasoningEffort, sandboxMode, serviceTier });
  const planOptions: Parameters<typeof planCandidates>[0] = {
    batchSize,
    maxPages,
    shardCount,
    itemsDir,
    reviewPolicy,
    minimumActiveShards,
    minimumBackfillReviewAgeMs,
  };
  if (hasItemNumbersInput || itemNumbers.length > 0) planOptions.itemNumbers = itemNumbers;
  if (hotIntake) planOptions.hotIntake = true;
  const plan = planCandidates(planOptions);
  console.log(
    JSON.stringify(
      {
        ...plan,
        reviewPolicy,
        matrix: plan.shards.map((shard) => ({
          shard: shard.shard,
          item_numbers: shard.itemNumbers.join(",") || "none",
        })),
      },
      null,
      2,
    ),
  );
}

function reviewCommand(args: Args): void {
  const profile = repoFromArgs(args);
  const openclawDir = resolve(
    stringArg(args.target_dir, stringArg(args.openclaw_dir, `../${profile.checkoutDir}`)),
  );
  const artifactDir = resolve(stringArg(args.artifact_dir, "artifacts/reviews"));
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const batchSize = numberArg(args.batch_size, DEFAULT_PLAN_BATCH_SIZE);
  const maxPages = numberArg(args.max_pages, 250);
  const model = stringArg(args.codex_model, DEFAULT_CODEX_MODEL);
  const reasoningEffort = stringArg(args.codex_reasoning_effort, DEFAULT_REASONING_EFFORT);
  const sandboxMode = stringArg(args.codex_sandbox, "read-only");
  const serviceTier = stringArg(args.codex_service_tier, DEFAULT_SERVICE_TIER);
  const timeoutMs = numberArg(args.codex_timeout_ms, 600_000);
  const additionalPrompt = stringArg(
    args.additional_prompt,
    process.env.CLAWSWEEPER_ADDITIONAL_PROMPT ?? "",
  );
  const shardIndex = numberArg(args.shard_index, 0);
  const shardCount = numberArg(args.shard_count, 1);
  const itemNumber = numberArg(args.item_number, 0) || undefined;
  const hotIntake = boolArg(args.hot_intake);
  const hasItemNumbersInput = typeof args.item_numbers === "string" && args.item_numbers.trim();
  const itemNumbers = hasItemNumbersInput
    ? itemNumbersArg(args.item_numbers, undefined)
    : undefined;
  const readonlyOpenclaw = boolArg(args.readonly_openclaw);
  ensureDir(artifactDir);
  const git = gitInfo(openclawDir);
  const reviewPolicy = reviewPolicyHash({ model, reasoningEffort, sandboxMode, serviceTier });
  const readonlyModeSnapshots = readonlyOpenclaw ? makeTreeReadOnly(openclawDir) : [];
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
    if (hotIntake) selectionOptions.hotIntake = true;
    const { candidates, scannedPages } = selectCandidates(selectionOptions);
    console.error(
      `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} selected=${candidates.length} scanned_pages=${scannedPages}`,
    );
    writeFileSync(
      join(artifactDir, "selection.json"),
      JSON.stringify({ shardIndex, shardCount, scannedPages, candidates, reviewPolicy }, null, 2),
    );
    let completed = 0;
    let codexFailures = 0;
    for (const item of candidates) {
      console.error(
        `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start #${item.number} (${completed + 1}/${candidates.length})`,
      );
      const contextStartedAt = Date.now();
      const context = collectItemContext(item);
      const contextElapsedMs = Date.now() - contextStartedAt;
      const codexWorkDir = join(artifactDir, "codex");
      const proofScratchDir = join(codexWorkDir, "proof-scratch", String(item.number));
      const prompt = buildReviewPrompt(item, context, git, additionalPrompt, { proofScratchDir });
      const snapshotHash = itemSnapshotHash(item, context);
      try {
        const startComment = postReviewStartStatusComment({
          item,
          position: completed + 1,
          total: candidates.length,
          shardIndex,
          shardCount,
        });
        console.error(
          `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=${startComment} #${item.number}`,
        );
      } catch (error) {
        console.error(
          `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=failed #${item.number}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      let decision: Decision;
      let codexElapsedMs = 0;
      const codexStartedAt = Date.now();
      try {
        decision = runCodex({
          item,
          context,
          git,
          model,
          openclawDir,
          reasoningEffort,
          sandboxMode,
          serviceTier,
          timeoutMs,
          workDir: codexWorkDir,
          additionalPrompt,
          proofScratchDir,
          prompt: prompt.text,
        });
      } catch (error) {
        codexFailures += 1;
        decision = codexFailureDecision(
          null,
          error instanceof Error ? error.message : String(error),
          "Per-item Codex failure; continuing with the rest of the shard.",
        );
      } finally {
        codexElapsedMs = Date.now() - codexStartedAt;
      }
      decision = attachFixedPullRequest(decision, item, context);
      const runtime = {
        model,
        reasoningEffort,
        sandboxMode,
        serviceTier,
        ...prompt.telemetry,
        contextElapsedMs,
        codexElapsedMs,
      };
      const action = reviewActionForDecision({ item, decision, git, runtime });
      writeFileSync(
        join(artifactDir, reportFileName(item.repo, item.number)),
        markdownFor({
          item,
          context,
          decision,
          git,
          action,
          reviewMode: "propose",
          snapshotHash,
          reviewPolicy,
          runtime,
        }),
        "utf8",
      );
      completed += 1;
      console.error(
        `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} done #${item.number} (${completed}/${candidates.length}) decision=${decision.decision} confidence=${decision.confidence} action=${action.actionTaken}`,
      );
    }
    console.error(
      `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} complete reviewed=${completed}`,
    );
    if (codexFailures > 0) {
      throw new Error(
        `Codex failed for ${codexFailures} item${codexFailures === 1 ? "" : "s"}; review artifacts were written and the workflow recovery lane can requeue the planned set.`,
      );
    }
  } finally {
    restoreTreeModes(readonlyModeSnapshots);
  }
}

function applyDecisionsCommand(args: Args): void {
  repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
  const plansDir = resolve(stringArg(args.plans_dir, defaultPlansDir()));
  const limit = numberArg(args.limit, 20);
  const processedLimit = numberArg(args.processed_limit, Math.max(limit * 2, 50));
  const minAgeDays = numberArg(args.min_age_days, 0);
  const minAgeMinutes = optionalNumberArg(args.min_age_minutes);
  const minAgeMs = minAgeMinutes === undefined ? minAgeDays * DAY_MS : minAgeMinutes * 60 * 1000;
  const minAgeDescription =
    minAgeMinutes === undefined ? `${minAgeDays} days` : `${minAgeMinutes} minutes`;
  const applyKind = applyKindArg(args.apply_kind);
  const applyCloseReasons = closeReasonsArg(args.apply_close_reasons);
  const staleMinAgeDays = numberArg(args.stale_min_age_days, STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS);
  const closeDelayMs = numberArg(args.close_delay_ms, 2_000);
  const progressEvery = Math.max(1, numberArg(args.progress_every, 10));
  const dryRun = boolArg(args.dry_run);
  const syncCommentsOnly = boolArg(args.sync_comments_only);
  const commentSyncMinAgeDays = numberArg(args.comment_sync_min_age_days, 0);
  const maxRuntimeMs = numberArg(args.max_runtime_ms, 0);
  const reportPath = resolve(stringArg(args.report_path, join(ROOT, "apply-report.json")));
  const startedAtMs = Date.now();
  const requestedItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
  const requestedItemNumberSet = new Set(requestedItemNumbers);
  const results: ApplyResult[] = [];
  let closedCount = 0;
  let processedCount = 0;
  throttleHeartbeatContext = () =>
    `Progress: ${closedCount}/${limit} fresh closes, ${processedCount}/${processedLimit} processed records in this apply chunk.`;
  const logProgress = (message: string): void => {
    const counts = results.reduce<Record<string, number>>((accumulator, result) => {
      accumulator[result.action] = (accumulator[result.action] ?? 0) + 1;
      return accumulator;
    }, {});
    console.error(
      [
        `[apply] ${new Date().toISOString()} ${message}`,
        `closed=${closedCount}/${limit}`,
        `processed=${processedCount}/${processedLimit}`,
        `counts=${JSON.stringify(counts)}`,
      ].join(" "),
    );
  };
  const maybeLogProgress = (message: string): void => {
    if (processedCount % progressEvery === 0) logProgress(message);
  };
  if (!existsSync(itemsDir)) {
    console.log("No items directory.");
    return;
  }
  const files = readdirSync(itemsDir)
    .filter((name) => parseReportFileName(name) !== null)
    .filter((name) => {
      const markdown = readFileSync(join(itemsDir, name), "utf8");
      if (!isMarkdownForActiveRepo(markdown, name)) return false;
      return (
        requestedItemNumberSet.size === 0 || requestedItemNumberSet.has(numberForMarkdownFile(name))
      );
    })
    .map((name) => ({
      name,
      number: numberForMarkdownFile(name),
      ...applyQueueSortFields(
        readFileSync(join(itemsDir, name), "utf8"),
        syncCommentsOnly,
        applyKind,
      ),
    }))
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        left.applyCheckedAt - right.applyCheckedAt ||
        left.number - right.number,
    )
    .map((entry) => entry.name);
  logProgress(
    `starting apply: files=${files.length} dry_run=${dryRun} apply_kind=${applyKind} min_age=${minAgeDescription} apply_close_reasons=${closeReasonFilterText(applyCloseReasons)} stale_min_age_days=${staleMinAgeDays} close_delay_ms=${closeDelayMs} sync_comments_only=${syncCommentsOnly} comment_sync_min_age_days=${commentSyncMinAgeDays} max_runtime_ms=${maxRuntimeMs} item_numbers=${requestedItemNumbers.join(",") || "all"}`,
  );
  for (const file of files) {
    if (runtimeBudgetExceeded(startedAtMs, maxRuntimeMs, Date.now())) {
      results.push({
        number: 0,
        action: "skipped_runtime_budget",
        reason: `max runtime ${maxRuntimeMs}ms reached`,
      });
      logProgress(`stopping apply: max runtime ${maxRuntimeMs}ms reached`);
      break;
    }
    const path = join(itemsDir, file);
    let markdown = readFileSync(path, "utf8");
    const repo = markdownRepository(markdown, join(itemsDir, file));
    const number = numberForMarkdownFile(file);
    const decision = frontMatterValue(markdown, "decision");
    const confidence = frontMatterValue(markdown, "confidence");
    const closeReason = frontMatterValue(markdown, "close_reason") as CloseReason | undefined;
    const action = frontMatterValue(markdown, "action_taken");
    const storedHash = frontMatterValue(markdown, "item_snapshot_hash");
    const storedUpdatedAt = frontMatterValue(markdown, "item_updated_at");
    const storedAuthorAssociation = frontMatterValue(markdown, "author_association");
    const archiveClosed = (nextMarkdown: string): void => {
      if (dryRun) return;
      ensureDir(closedDir);
      writeFileSync(path, nextMarkdown, "utf8");
      syncWorkPlanFromReport({
        markdown: nextMarkdown,
        reportPath: path,
        plansDir,
      });
      renameSync(path, join(closedDir, file));
    };
    const markApplySkipped = (actionTaken: ActionTaken, reason: string): boolean => {
      markdown = replaceFrontMatterValue(markdown, "action_taken", actionTaken);
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      if (!dryRun) writeFileSync(path, markdown, "utf8");
      results.push({ number, action: actionTaken, reason });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: ${reason}`);
      return processedCount >= processedLimit;
    };
    if (!hasVerifiedLocalCheckoutAccess(markdown)) {
      if (markApplySkipped("kept_open", "review lacks verified local checkout access")) break;
      continue;
    }
    if (!storedHash || (action !== "proposed_close" && action !== "kept_open")) {
      continue;
    }
    const isCloseProposal =
      decision === "close" &&
      confidence === "high" &&
      Boolean(closeReason && ALLOWED_REASONS.has(closeReason)) &&
      action === "proposed_close";
    if (decision === "close" && !isCloseProposal) {
      continue;
    }
    const { item, state } = fetchItem(number);
    let currentContext: ItemContext | undefined;
    let currentClosingPullRequests: unknown[] | undefined;
    let clawSweeperLabelsChanged = false;
    let issueAdvisoryLabelsChanged = false;
    const currentItemContext = (): ItemContext => {
      currentContext ??= collectItemContext(item, { fullTimelineForRelations: true });
      return currentContext;
    };
    if (syncCommentsOnly && state !== "open") {
      results.push({ number, action: "skipped_already_closed", reason: `state is ${state}` });
      processedCount += 1;
      maybeLogProgress(`skipped comment sync #${number}: already ${state}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    if (state === "open" && item.kind === "pull_request") {
      item.labels = syncRealBehaviorProofSufficientLabel({
        number,
        labels: item.labels,
        proof: reportRealBehaviorProof(markdown),
        dryRun,
      });
      item.labels = syncPrRatingLabel({
        number,
        labels: item.labels,
        rating: reportPrRating(markdown),
        dryRun,
      });
      item.labels = syncTelegramVisibleProofLabel({
        number,
        labels: item.labels,
        proof: reportTelegramVisibleProof(markdown),
        dryRun,
      });
    }
    markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
    const reviewComment = renderReviewCommentFromReport(markdown, closeReason ?? "none");
    const existingReviewComment = issueReviewComment(number, [
      reviewComment,
      reviewSectionValue(markdown, "closeComment"),
    ]);
    const markedReviewComment = markedReviewCommentBody(number, reviewComment);
    if (isProtectedItem(item)) {
      if (isCloseProposal) {
        if (markApplySkipped("skipped_protected_label", protectedLabelReason(item.labels))) break;
      }
      if (isCloseProposal) continue;
    }
    const currentAuthorAssociation = normalizeAuthorAssociation(item.authorAssociation);
    const reviewedAuthorAssociation = normalizeAuthorAssociation(storedAuthorAssociation);
    if (
      isMaintainerAuthorAssociation(currentAuthorAssociation) ||
      isMaintainerAuthorAssociation(reviewedAuthorAssociation)
    ) {
      const authorAssociation = isMaintainerAuthorAssociation(currentAuthorAssociation)
        ? currentAuthorAssociation
        : reviewedAuthorAssociation;
      if (isCloseProposal) {
        markdown = replaceFrontMatterValue(markdown, "author_association", authorAssociation);
        markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_maintainer_authored");
        markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
        if (!dryRun) writeFileSync(path, markdown, "utf8");
      }
      if (isCloseProposal) {
        results.push({
          number,
          action: "skipped_maintainer_authored",
          reason: `author association is ${authorAssociation}`,
        });
        processedCount += 1;
        maybeLogProgress(`skipped #${number}: maintainer authored`);
        if (processedCount >= processedLimit) break;
        continue;
      }
    }
    const updatedSinceReview = Boolean(storedUpdatedAt && item.updatedAt !== storedUpdatedAt);
    const reviewCommentOnlyUpdate = item.updatedAt === commentUpdatedAt(existingReviewComment);
    const unchangedSinceReview = storedUpdatedAt
      ? !updatedSinceReview || reviewCommentOnlyUpdate
      : false;
    if (state !== "open") {
      if (item.closedAt) {
        markdown = replaceFrontMatterValue(markdown, "current_item_closed_at", item.closedAt);
      }
      if (existingReviewComment) {
        markdown = updateReviewCommentMetadata(
          markdown,
          existingReviewComment,
          markedReviewComment,
        );
        markdown = replaceFrontMatterValue(markdown, "action_taken", "closed");
        markdown = replaceFrontMatterValue(
          markdown,
          "applied_at",
          commentUpdatedAt(existingReviewComment) ?? new Date().toISOString(),
        );
        archiveClosed(markdown);
        closedCount += 1;
        processedCount += 1;
        results.push({
          number,
          action: "closed",
          reason: "matching ClawSweeper review comment already exists",
        });
        maybeLogProgress(`archived #${number}: already ${state} with matching review comment`);
        if (processedCount >= processedLimit || closedCount >= limit) break;
        continue;
      }
      markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_already_closed");
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      archiveClosed(markdown);
      results.push({ number, action: "skipped_already_closed", reason: `state is ${state}` });
      processedCount += 1;
      maybeLogProgress(`archived #${number}: already ${state}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    if (isCloseProposal && updatedSinceReview && !reviewCommentOnlyUpdate) {
      markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_changed_since_review");
      markdown = replaceFrontMatterValue(markdown, "current_item_updated_at", item.updatedAt);
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      if (!dryRun) writeFileSync(path, markdown, "utf8");
      results.push({
        number,
        action: "skipped_changed_since_review",
        reason: "updated_at changed",
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: changed since review`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    if (isCloseProposal && !storedUpdatedAt) {
      const currentHash = itemSnapshotHash(item, currentItemContext());
      if (currentHash !== storedHash && !reviewCommentOnlyUpdate) {
        markdown = replaceFrontMatterValue(
          markdown,
          "action_taken",
          "skipped_changed_since_review",
        );
        markdown = replaceFrontMatterValue(markdown, "current_item_snapshot_hash", currentHash);
        markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
        if (!dryRun) writeFileSync(path, markdown, "utf8");
        results.push({
          number,
          action: "skipped_changed_since_review",
          reason: "snapshot changed",
        });
        processedCount += 1;
        maybeLogProgress(`skipped #${number}: snapshot changed`);
        if (processedCount >= processedLimit) break;
        continue;
      }
    }
    const isCurrentCompleteReport =
      frontMatterValue(markdown, "review_status") === "complete" && unchangedSinceReview;
    if (state === "open" && isCurrentCompleteReport) {
      const syncResult = syncPriorityLabel({
        number,
        labels: item.labels,
        triagePriority: triagePriorityFromReport(markdown),
        dryRun,
      });
      item.labels = syncResult.labels;
      clawSweeperLabelsChanged ||= syncResult.changed;
      markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
      const impactSyncResult = syncImpactLabels({
        number,
        labels: item.labels,
        impactLabels: impactLabelsFromReport(markdown),
        dryRun,
      });
      item.labels = impactSyncResult.labels;
      clawSweeperLabelsChanged ||= impactSyncResult.changed;
      markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
      if (item.kind === "pull_request") {
        const mergeRiskSyncResult = syncMergeRiskLabels({
          number,
          labels: item.labels,
          mergeRiskLabels: mergeRiskLabelsFromReport(markdown),
          dryRun,
        });
        item.labels = mergeRiskSyncResult.labels;
        clawSweeperLabelsChanged ||= mergeRiskSyncResult.changed;
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
      }
    }
    if (state === "open" && item.kind === "issue" && !isCloseProposal && isCurrentCompleteReport) {
      currentClosingPullRequests = closingPullRequestsForIssue(number);
      const syncResult = syncIssueAdvisoryLabels({
        number,
        labels: item.labels,
        state: issueAdvisoryLabelStateFromReport(markdown, {
          hasOpenLinkedPullRequest:
            openClosingPullRequestApplyReason(currentClosingPullRequests) !== null,
        }),
        dryRun,
      });
      item.labels = syncResult.labels;
      issueAdvisoryLabelsChanged = syncResult.changed;
      clawSweeperLabelsChanged ||= syncResult.changed;
      markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
    }
    if (isCloseProposal && item.kind === "issue") {
      currentClosingPullRequests ??= closingPullRequestsForIssue(number);
      const openClosingPullRequestReason = openClosingPullRequestApplyReason(
        currentClosingPullRequests,
      );
      if (openClosingPullRequestReason) {
        if (markApplySkipped("skipped_open_closing_pr", openClosingPullRequestReason)) break;
        continue;
      }
    }
    if (isCloseProposal) {
      const sameAuthorCounterpartReason = sameAuthorCounterpartApplyReason(
        item,
        currentItemContext().relatedItems ?? [],
      );
      if (sameAuthorCounterpartReason) {
        if (markApplySkipped("skipped_same_author_pair", sameAuthorCounterpartReason)) break;
        continue;
      }
    }
    const reviewCommentHash = sha256(markedReviewComment);
    const existingReviewCommentMatches = commentBodyMatches(
      existingReviewComment,
      markedReviewComment,
    );
    const needsReviewCommentBodySync = !existingReviewComment || !existingReviewCommentMatches;
    const needsReviewCommentHashSync =
      frontMatterValue(markdown, "review_comment_sha256") !== reviewCommentHash;
    const needsReviewCommentReferenceSync =
      frontMatterValue(markdown, "review_comment_id") === "unknown" ||
      frontMatterValue(markdown, "review_comment_url") === "unknown";
    const needsReviewCommentSync = shouldSyncReviewComment({
      syncCommentsOnly,
      isCloseProposal,
      commentSyncMinAgeDays,
      reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
      hasExistingReviewComment: Boolean(existingReviewComment),
      needsReviewCommentBodySync,
      needsReviewCommentHashSync,
      needsReviewCommentReferenceSync,
    });
    if (clawSweeperLabelsChanged && !dryRun) {
      markdown = replaceFrontMatterValue(markdown, "labels_synced_at", new Date().toISOString());
    }
    const labelSyncReason = issueAdvisoryLabelsChanged
      ? dryRun
        ? "dry-run: would sync advisory issue labels"
        : "synced advisory issue labels"
      : dryRun
        ? "dry-run: would sync ClawSweeper labels"
        : "synced ClawSweeper labels";
    const labelSyncProgressMessage = issueAdvisoryLabelsChanged
      ? `synced advisory issue labels #${number}`
      : `synced ClawSweeper labels #${number}`;
    if (needsReviewCommentSync) {
      const lockedReason = needsReviewCommentBodySync ? lockedConversationApplyReason(item) : null;
      if (lockedReason) {
        if (markApplySkipped("skipped_locked_conversation", lockedReason)) break;
        continue;
      }
      let syncedComment = existingReviewComment;
      let syncReason = "recorded existing durable comment metadata";
      if (needsReviewCommentBodySync) {
        if (dryRun) {
          syncReason = existingReviewComment
            ? "would update durable Codex review comment"
            : "would create durable Codex review comment";
        } else {
          try {
            syncedComment = upsertReviewComment(number, reviewComment, existingReviewComment);
            syncReason = "updated durable Codex review comment";
          } catch (error) {
            const commentAuthError = isGitHubRequiresAuthenticationError(error);
            if (!commentAuthError && !isLockedConversationCommentError(error)) throw error;
            const actionTaken = commentAuthError
              ? "skipped_comment_auth"
              : "skipped_locked_conversation";
            const reason = commentAuthError
              ? "GitHub rejected durable review comment write with Requires authentication"
              : "conversation was locked while syncing review comment";
            if (markApplySkipped(actionTaken, reason)) break;
            continue;
          }
        }
      }
      markdown = updateReviewCommentMetadata(markdown, syncedComment, markedReviewComment);
      if (!dryRun) writeFileSync(path, markdown, "utf8");
      results.push({
        number,
        action: "review_comment_synced",
        reason: syncReason,
      });
      processedCount += 1;
      maybeLogProgress(`synced review comment #${number}`);
      if (processedCount >= processedLimit) break;
    }
    if (
      clawSweeperLabelsChanged &&
      !needsReviewCommentSync &&
      (!isCloseProposal || syncCommentsOnly)
    ) {
      if (!dryRun) writeFileSync(path, markdown, "utf8");
      results.push({
        number,
        action: "kept_open",
        reason: labelSyncReason,
      });
      processedCount += 1;
      maybeLogProgress(labelSyncProgressMessage);
      if (processedCount >= processedLimit) break;
    }
    if (syncCommentsOnly) continue;
    if (!isCloseProposal || !closeReason) {
      continue;
    }
    if (closedCount >= limit) break;
    if (applyKind !== "all" && item.kind !== applyKind) {
      results.push({
        number,
        action: "kept_open",
        reason: `type is ${item.kind}; apply kind is ${applyKind}`,
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: type is ${item.kind}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    if (!closeReasonEnabled(closeReason, applyCloseReasons)) {
      results.push({
        number,
        action: "kept_open",
        reason: `close reason ${closeReason} is not enabled for this apply run`,
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: close reason ${closeReason} not enabled`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    const currentReportValidation = validateCloseDecision(
      { repo, kind: item.kind, labels: item.labels },
      reportDecision(markdown, closeReason),
    );
    if (!currentReportValidation.ok && currentReportValidation.actionTaken !== "kept_open") {
      if (markApplySkipped(currentReportValidation.actionTaken, currentReportValidation.reason))
        break;
      continue;
    }
    const ageSkipReason = closeReasonApplyAgeSkipReason(item, closeReason, {
      minAgeMs,
      minAgeDescription,
      staleMinAgeDays,
    });
    if (ageSkipReason) {
      results.push({
        number,
        action: "kept_open",
        reason: ageSkipReason,
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: ${ageSkipReason}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    logProgress(`closing #${number}`);
    if (dryRun) {
      closedCount += 1;
      processedCount += 1;
      results.push({
        number,
        action: "closed",
        reason: `dry-run: would close as ${closeReasonText(closeReason)}`,
      });
      logProgress(`would close #${number}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    closeItem({ number, kind: item.kind, reason: closeReason });
    sleepMs(closeDelayMs);
    markdown = replaceSectionValue(markdown, REVIEW_SECTIONS.closeComment, reviewComment);
    markdown = replaceFrontMatterValue(markdown, "close_comment_sha256", sha256(reviewComment));
    markdown = replaceFrontMatterValue(markdown, "action_taken", "closed");
    markdown = replaceFrontMatterValue(markdown, "applied_at", new Date().toISOString());
    archiveClosed(markdown);
    closedCount += 1;
    processedCount += 1;
    results.push({ number, action: "closed", reason: closeReasonText(closeReason) });
    logProgress(`closed #${number}`);
    if (processedCount >= processedLimit) break;
  }
  ensureDir(dirname(reportPath));
  writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
  logProgress("finished apply");
  console.log(JSON.stringify(results, null, 2));
}

function applyArtifactsCommand(args: Args): void {
  repoFromArgs(args);
  const artifactDir = resolve(stringArg(args.artifact_dir, "artifacts"));
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
  const plansDir = resolve(stringArg(args.plans_dir, defaultPlansDir()));
  const skipReconcile = boolArg(args.skip_reconcile);
  const replayClosedArtifacts = boolArg(args.replay_closed_artifacts);
  const maxPages = numberArg(args.max_pages, 250);
  const openNumbers = skipReconcile ? null : fetchOpenItemNumbers(maxPages).numbers;
  let appliedArtifacts = 0;
  let skippedClosedArtifacts = 0;
  ensureDir(itemsDir);
  ensureDir(closedDir);
  if (existsSync(artifactDir)) {
    for (const entry of readdirSync(artifactDir, { recursive: true })) {
      const name = String(entry);
      if (!name.endsWith(".md")) continue;
      const source = join(artifactDir, name);
      if (!parseReportFileName(basename(source))) continue;
      const number = numberForMarkdownFile(basename(source));
      const markdown = readFileSync(source, "utf8");
      if (!isMarkdownForActiveRepo(markdown, basename(source))) continue;
      const destinationFile = reportFileName(
        markdownRepository(markdown, basename(source)),
        number,
      );
      const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
      const destination = reviewArtifactDestination(
        action,
        replayClosedArtifacts || artifactTargetIsOpen(number, openNumbers),
      );
      if (destination === "skip_closed") {
        skippedClosedArtifacts += 1;
        continue;
      }
      const destinationDir = destination === "closed" ? closedDir : itemsDir;
      const stalePath = join(destinationDir === itemsDir ? closedDir : itemsDir, destinationFile);
      if (existsSync(stalePath)) unlinkSync(stalePath);
      const reportPath = join(destinationDir, destinationFile);
      writeFileSync(reportPath, markdown, "utf8");
      if (destination === "closed") {
        const planPath = workPlanPathForReport(reportPath, plansDir);
        if (existsSync(planPath)) unlinkSync(planPath);
      } else {
        syncWorkPlanFromReport({ markdown, reportPath, plansDir });
      }
      appliedArtifacts += 1;
    }
  }
  console.error(
    `[apply-artifacts] applied=${appliedArtifacts} skipped_closed=${skippedClosedArtifacts}`,
  );
  if (!skipReconcile) reconcileFolders({ itemsDir, closedDir, plansDir });
}

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

function numberForMarkdownFile(file: string): number {
  const parsed = parseReportFileName(file);
  if (!parsed) throw new Error(`Invalid report filename: ${file}`);
  return parsed.number;
}

function repoRelativePath(path: string): string {
  return relative(ROOT, path).replaceAll("\\", "/");
}

function markdownAuditRecord(
  location: AuditRecordLocation,
  dir: string,
  file: string,
): AuditRecord {
  const path = join(dir, file);
  const markdown = readFileSync(path, "utf8");
  const repo = markdownRepository(markdown, file);
  return {
    repo,
    number: numberForMarkdownFile(file),
    location,
    path: repoRelativePath(path),
    kind: frontMatterValue(markdown, "type") as ItemKind | undefined,
    title: frontMatterValue(markdown, "title") ?? "",
    labels: frontMatterStringArray(markdown, "labels"),
    decision: frontMatterValue(markdown, "decision"),
    closeReason: frontMatterValue(markdown, "close_reason"),
    action: frontMatterValue(markdown, "action_taken"),
    reviewStatus: effectiveReviewStatus(markdown),
    currentState: frontMatterValue(markdown, "current_state"),
  };
}

function auditRecords(location: AuditRecordLocation, dir: string): AuditRecord[] {
  return markdownFiles(dir)
    .map((file) => markdownAuditRecord(location, dir, file))
    .filter((record) => record.repo === targetRepo());
}

function openItemFinding(item: Item, extra: Partial<AuditFinding> = {}): AuditFinding {
  return {
    number: item.number,
    kind: item.kind,
    title: item.title,
    labels: item.labels,
    authorAssociation: item.authorAssociation,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...extra,
  };
}

function isRecentlyCreatedMissingOpen(item: Item, generatedAtMs: number): boolean {
  const createdAt = Date.parse(item.createdAt);
  return Number.isFinite(createdAt) && generatedAtMs - createdAt < RECENT_MISSING_OPEN_MS;
}

function missingOpenReason(item: Item, generatedAtMs: number): MissingOpenReason {
  if (isMaintainerAuthored(item)) return "maintainer_authored";
  if (isProtectedItem(item)) return "protected_label";
  if (isRecentlyCreatedMissingOpen(item, generatedAtMs)) return "recently_created";
  return "eligible";
}

function recordFinding(record: AuditRecord, extra: Partial<AuditFinding> = {}): AuditFinding {
  return {
    number: record.number,
    ...(record.kind ? { kind: record.kind } : {}),
    title: displayTitle(record.title),
    labels: record.labels,
    ...(record.action ? { action: record.action } : {}),
    ...(record.decision ? { decision: record.decision } : {}),
    ...(record.closeReason ? { closeReason: record.closeReason } : {}),
    reviewStatus: record.reviewStatus,
    ...(record.currentState ? { currentState: record.currentState } : {}),
    ...(record.location === "items" ? { itemPath: record.path } : { closedPath: record.path }),
    ...extra,
  };
}

function firstByNumber<T extends { number: number }>(records: T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const record of records) {
    if (!map.has(record.number)) map.set(record.number, record);
  }
  return map;
}

export function auditFromSnapshot(options: {
  openItems: Item[];
  itemRecords: AuditRecord[];
  closedRecords: AuditRecord[];
  scanComplete: boolean;
  pagesScanned: number;
  generatedAt?: string;
}): AuditResult {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const generatedAtMs = Date.parse(generatedAt);
  const openByNumber = firstByNumber(options.openItems);
  const itemByNumber = firstByNumber(options.itemRecords);
  const closedByNumber = firstByNumber(options.closedRecords);
  const missingOpen: AuditFinding[] = [];
  const missingEligibleOpen: AuditFinding[] = [];
  const missingMaintainerOpen: AuditFinding[] = [];
  const missingProtectedOpen: AuditFinding[] = [];
  const missingRecentOpen: AuditFinding[] = [];
  const openArchived: AuditFinding[] = [];

  for (const item of options.openItems) {
    if (itemByNumber.has(item.number)) continue;
    const closedRecord = closedByNumber.get(item.number);
    if (closedRecord) {
      openArchived.push(openItemFinding(item, { closedPath: closedRecord.path }));
    } else {
      const missingReason = missingOpenReason(item, generatedAtMs);
      const finding = openItemFinding(item, { missingReason });
      missingOpen.push(finding);
      if (missingReason === "maintainer_authored") missingMaintainerOpen.push(finding);
      else if (missingReason === "protected_label") missingProtectedOpen.push(finding);
      else if (missingReason === "recently_created") missingRecentOpen.push(finding);
      else missingEligibleOpen.push(finding);
    }
  }

  const staleItemRecords = options.scanComplete
    ? options.itemRecords
        .filter((record) => !openByNumber.has(record.number))
        .map((record) => recordFinding(record))
    : [];
  const duplicateRecords = options.itemRecords
    .filter((record) => closedByNumber.has(record.number))
    .map((record) => {
      const closedRecord = closedByNumber.get(record.number);
      return recordFinding(record, closedRecord ? { closedPath: closedRecord.path } : {});
    });
  const protectedProposed = options.itemRecords
    .filter((record) => record.action === "proposed_close" && isProtectedItem(record))
    .map((record) => recordFinding(record));
  const staleReviews = options.itemRecords
    .filter((record) => record.reviewStatus.startsWith("stale_"))
    .map((record) => recordFinding(record));

  return {
    generatedAt,
    targetRepo: targetRepo(),
    scan: {
      complete: options.scanComplete,
      pagesScanned: options.pagesScanned,
      openItemsSeen: options.openItems.length,
    },
    counts: {
      itemRecords: options.itemRecords.length,
      closedRecords: options.closedRecords.length,
      missingOpen: missingOpen.length,
      missingEligibleOpen: missingEligibleOpen.length,
      missingMaintainerOpen: missingMaintainerOpen.length,
      missingProtectedOpen: missingProtectedOpen.length,
      missingRecentOpen: missingRecentOpen.length,
      openArchived: openArchived.length,
      staleItemRecords: staleItemRecords.length,
      duplicateRecords: duplicateRecords.length,
      protectedProposed: protectedProposed.length,
      staleReviews: staleReviews.length,
    },
    findings: {
      missingOpen,
      missingEligibleOpen,
      missingMaintainerOpen,
      missingProtectedOpen,
      missingRecentOpen,
      openArchived,
      staleItemRecords,
      duplicateRecords,
      protectedProposed,
      staleReviews,
    },
  };
}

function limitAuditFindings(result: AuditResult, limit: number): AuditResult {
  const boundedLimit = Math.max(0, limit);
  return {
    ...result,
    findings: Object.fromEntries(
      Object.entries(result.findings).map(([key, findings]) => [
        key,
        findings.slice(0, boundedLimit),
      ]),
    ) as AuditResult["findings"],
  };
}

export function auditHasStrictFailures(result: AuditResult): boolean {
  return (
    !result.scan.complete ||
    result.counts.missingEligibleOpen > 0 ||
    result.counts.openArchived > 0 ||
    result.counts.staleItemRecords > 0 ||
    result.counts.duplicateRecords > 0 ||
    result.counts.protectedProposed > 0
  );
}

function auditHealthStatus(result: AuditResult): string {
  return auditHasStrictFailures(result) ? "Action needed" : "Passing";
}

function auditFindingCategory(category: keyof AuditResult["findings"]): string {
  switch (category) {
    case "missingEligibleOpen":
      return "Missing eligible open";
    case "openArchived":
      return "Open archived";
    case "staleItemRecords":
      return "Stale item record";
    case "duplicateRecords":
      return "Duplicate record";
    case "protectedProposed":
      return "Protected proposed close";
    case "staleReviews":
      return "Stale review";
    case "missingOpen":
      return "Missing open";
    case "missingMaintainerOpen":
      return "Missing maintainer open";
    case "missingProtectedOpen":
      return "Missing protected open";
    case "missingRecentOpen":
      return "Missing recent open";
  }
}

function auditFindingDetail(finding: AuditFinding): string {
  if (finding.closedPath) return finding.closedPath;
  if (finding.itemPath) return finding.itemPath;
  if (finding.missingReason) return finding.missingReason;
  if (finding.action) return finding.action;
  return "-";
}

function auditReviewTargetNumbers(result: AuditResult, limit = 10): number[] {
  const categories: (keyof AuditResult["findings"])[] = [
    "missingEligibleOpen",
    "openArchived",
    "staleReviews",
  ];
  const numbers = new Set<number>();
  for (const category of categories) {
    for (const finding of result.findings[category]) {
      if (category === "staleReviews" && finding.currentState === "closed") continue;
      numbers.add(finding.number);
      if (numbers.size >= limit) return [...numbers];
    }
  }
  return [...numbers];
}

function auditReviewTargets(result: AuditResult): string {
  const numbers = auditReviewTargetNumbers(result);
  if (numbers.length === 0) return "Targeted review input: _none_";
  return `Targeted review input: \`${numbers.join(",")}\``;
}

function actionableAuditFindings(result: AuditResult, limit = 3): string {
  const categories: (keyof AuditResult["findings"])[] = [
    "missingEligibleOpen",
    "protectedProposed",
    "openArchived",
    "duplicateRecords",
    "staleReviews",
    "staleItemRecords",
  ];
  const rows: string[] = [];
  for (const category of categories) {
    for (const finding of result.findings[category]) {
      rows.push(
        `| ${markdownLink(`#${finding.number}`, itemUrlFor(result.targetRepo, finding.number, finding.kind ?? "issue"))} | ${auditFindingCategory(category)} | ${displayTitle(finding.title ?? "").replaceAll("|", "\\|")} | ${auditFindingDetail(finding).replaceAll("|", "\\|")} |`,
      );
      if (rows.length >= limit) return rows.join("\n");
    }
  }
  return "| _None_ |  |  |  |";
}

export function auditHealthSection(result: AuditResult | null): string {
  const profile = result ? repositoryProfileFor(result.targetRepo) : targetProfile();
  if (!result) {
    return `### Audit Health

${profileAuditStart(profile)}
No audit has been published yet. Run \`npm run audit -- --update-dashboard\` to refresh audit state.
${profileAuditEnd(profile)}`;
  }
  return `### Audit Health

${profileAuditStart(profile)}
Repository: ${markdownLink(result.targetRepo, repoUrlFor(result.targetRepo))}

Last audit: ${formatTimestamp(result.generatedAt)}

Status: **${auditHealthStatus(result)}**

${auditReviewTargets(result)}

| Metric | Count |
| --- | ---: |
| Scan complete | ${result.scan.complete ? "yes" : "no"} |
| Open items seen | ${result.scan.openItemsSeen} |
| Missing eligible open records | ${result.counts.missingEligibleOpen} |
| Missing maintainer-authored open records | ${result.counts.missingMaintainerOpen} |
| Missing protected open records | ${result.counts.missingProtectedOpen} |
| Missing recently-created open records | ${result.counts.missingRecentOpen} |
| Archived records that are open again | ${result.counts.openArchived} |
| Stale item records | ${result.counts.staleItemRecords} |
| Duplicate records | ${result.counts.duplicateRecords} |
| Protected proposed closes | ${result.counts.protectedProposed} |
| Stale reviews | ${result.counts.staleReviews} |

| Item | Category | Title | Detail |
| --- | --- | --- | --- |
${actionableAuditFindings(result)}
${profileAuditEnd(profile)}`;
}

function currentAuditHealthSection(readme: string, profile = targetProfile()): string {
  const profileMatch = readme.match(
    new RegExp(
      `### Audit Health\\n\\n${escapeRegExp(profileAuditStart(profile))}[\\s\\S]*?${escapeRegExp(profileAuditEnd(profile))}`,
    ),
  );
  if (profileMatch?.[0]) return profileMatch[0];
  return withTargetProfile(profile, () => auditHealthSection(null));
}

function updateAuditHealthDashboard(result: AuditResult): void {
  const profile = repositoryProfileFor(result.targetRepo);
  const outputPath = auditStatePath(profile);
  ensureDir(dirname(outputPath));
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function markReconciledState(
  markdown: string,
  state: "open" | "closed",
  options: { closedAt?: string | null | undefined } = {},
): string {
  let nextMarkdown = replaceFrontMatterValue(markdown, "current_state", state);
  nextMarkdown = replaceFrontMatterValue(nextMarkdown, "reconciled_at", new Date().toISOString());
  if (state === "closed" && options.closedAt) {
    nextMarkdown = replaceFrontMatterValue(
      nextMarkdown,
      "current_item_closed_at",
      options.closedAt,
    );
  }
  if (state === "open") {
    nextMarkdown = replaceFrontMatterValue(nextMarkdown, "review_status", "stale_reopened");
    nextMarkdown = replaceFrontMatterValue(nextMarkdown, "action_taken", "kept_open");
  }
  return nextMarkdown;
}

function moveMarkdownFile(options: {
  sourcePath: string;
  destinationPath: string;
  markdown: string;
  dryRun: boolean;
}): void {
  if (options.dryRun) return;
  ensureDir(dirname(options.destinationPath));
  writeFileSync(options.sourcePath, options.markdown, "utf8");
  if (existsSync(options.destinationPath)) unlinkSync(options.destinationPath);
  renameSync(options.sourcePath, options.destinationPath);
}

function reconcileFolders(options: {
  itemsDir: string;
  closedDir: string;
  plansDir?: string;
  maxPages?: number;
  dryRun?: boolean;
  fetchClosedAt?: boolean;
}): ReconcileResult {
  const maxPages = options.maxPages ?? 250;
  const dryRun = options.dryRun ?? false;
  const fetchClosedAt = options.fetchClosedAt ?? true;
  const plansDir = options.plansDir ?? defaultPlansDir();
  ensureDir(options.itemsDir);
  ensureDir(options.closedDir);
  const { numbers: openNumbers, pagesScanned } = fetchOpenItemNumbers(maxPages);
  let movedToClosed = 0;
  let movedToItems = 0;
  let removedStaleClosedCopies = 0;
  let fetchedClosedAt = 0;

  for (const file of markdownFiles(options.itemsDir)) {
    const number = numberForMarkdownFile(file);
    const sourcePath = join(options.itemsDir, file);
    const sourceMarkdown = readFileSync(sourcePath, "utf8");
    if (!isMarkdownForActiveRepo(sourceMarkdown, file)) continue;
    if (openNumbers.has(number)) continue;
    const destinationPath = join(options.closedDir, file);
    let closedAt: string | null | undefined;
    if (fetchClosedAt) {
      try {
        const fetched = fetchItem(number);
        if (fetched.state !== "open") closedAt = fetched.item.closedAt;
        fetchedClosedAt += 1;
      } catch (error) {
        console.error(
          `[reconcile] failed to fetch closed_at for #${number}; using reconciled_at fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const markdown = markReconciledState(sourceMarkdown, "closed", { closedAt });
    moveMarkdownFile({ sourcePath, destinationPath, markdown, dryRun });
    if (!dryRun) {
      const planPath = workPlanPathForReport(sourcePath, plansDir);
      if (existsSync(planPath)) unlinkSync(planPath);
    }
    movedToClosed += 1;
  }

  for (const file of markdownFiles(options.closedDir)) {
    const number = numberForMarkdownFile(file);
    const sourcePath = join(options.closedDir, file);
    const sourceMarkdown = readFileSync(sourcePath, "utf8");
    if (!isMarkdownForActiveRepo(sourceMarkdown, file)) continue;
    if (!openNumbers.has(number)) continue;
    const destinationPath = join(options.itemsDir, file);
    if (existsSync(destinationPath)) {
      if (!dryRun) unlinkSync(sourcePath);
      removedStaleClosedCopies += 1;
      continue;
    }
    const markdown = markReconciledState(sourceMarkdown, "open");
    moveMarkdownFile({ sourcePath, destinationPath, markdown, dryRun });
    syncWorkPlanFromReport({ markdown, reportPath: destinationPath, plansDir, dryRun });
    movedToItems += 1;
  }

  return {
    openItemsSeen: openNumbers.size,
    pagesScanned,
    movedToClosed,
    movedToItems,
    removedStaleClosedCopies,
    fetchedClosedAt,
  };
}

function reconcileCommand(args: Args): void {
  repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
  const plansDir = resolve(stringArg(args.plans_dir, defaultPlansDir()));
  const maxPages = numberArg(args.max_pages, 250);
  const dryRun = boolArg(args.dry_run);
  const fetchClosedAt = !boolArg(args.skip_closed_at);
  const result = reconcileFolders({
    itemsDir,
    closedDir,
    plansDir,
    maxPages,
    dryRun,
    fetchClosedAt,
  });
  console.log(JSON.stringify(result, null, 2));
}

function auditCommand(args: Args): void {
  repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
  const maxPages = numberArg(args.max_pages, 250);
  const sampleLimit = numberArg(args.sample_limit, 25);
  const output = typeof args.output === "string" ? resolve(args.output) : undefined;
  const strict = boolArg(args.strict);
  const updateDashboard = boolArg(args.update_dashboard);
  const openItems = fetchOpenItems(maxPages);
  const result = auditFromSnapshot({
    openItems: openItems.items,
    itemRecords: auditRecords("items", itemsDir),
    closedRecords: auditRecords("closed", closedDir),
    scanComplete: openItems.complete,
    pagesScanned: openItems.pagesScanned,
  });
  if (output) {
    ensureDir(dirname(output));
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  if (updateDashboard) updateAuditHealthDashboard(result);
  console.log(JSON.stringify(limitAuditFindings(result, sampleLimit), null, 2));
  if (strict && auditHasStrictFailures(result)) process.exit(1);
}

function cadenceBucketForReview(
  markdown: string,
  now: number,
): {
  bucket: "hourlyHotItems" | "dailyPullRequests" | "dailyNewIssues" | "weeklyOlderIssues";
  cadenceMs: number;
} {
  const kind = (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue";
  const createdAt = Date.parse(frontMatterValue(markdown, "item_created_at") ?? "");
  if (Number.isFinite(createdAt) && now - createdAt < HOT_REVIEW_DAYS * DAY_MS) {
    return { bucket: "hourlyHotItems", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
  }
  if (kind === "pull_request") {
    return { bucket: "dailyPullRequests", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
  }

  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) {
    return { bucket: "dailyNewIssues", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
  }

  return { bucket: "weeklyOlderIssues", cadenceMs: WEEKLY_REVIEW_DAYS * DAY_MS };
}

function dashboardStats(
  itemsDir: string,
  closedDir = defaultClosedDir(),
  profile = targetProfile(),
): DashboardStats {
  const files = markdownFiles(itemsDir);
  const closedFiles = markdownFiles(closedDir);
  const plansDir = defaultPlansDir(profile);
  const now = Date.now();
  let fresh = 0;
  let proposedClose = 0;
  let closed = 0;
  let failed = 0;
  let stale = 0;
  let workCandidates = 0;
  const byKind: Record<ItemKind, DashboardKindStats> = {
    issue: emptyDashboardKindStats(),
    pull_request: emptyDashboardKindStats(),
  };
  const hourlyHotItems = emptyDashboardCadenceBucket();
  const dailyPullRequests = emptyDashboardCadenceBucket();
  const dailyNewIssues = emptyDashboardCadenceBucket();
  const weeklyOlderIssues = emptyDashboardCadenceBucket();
  const activity = emptyDashboardActivityStats();
  const recent: DashboardItem[] = [];
  const workQueue: DashboardItem[] = [];
  const recentClosed: DashboardClosedItem[] = [];
  for (const file of files) {
    const markdown = readFileSync(join(itemsDir, file), "utf8");
    if (markdownRepository(markdown, join(itemsDir, file)) !== profile.targetRepo) continue;
    const repo = markdownRepository(markdown, join(closedDir, file));
    const number = numberForMarkdownFile(file);
    const reviewedAt = frontMatterValue(markdown, "reviewed_at");
    const reviewStatus = effectiveReviewStatus(markdown);
    const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
    const decision = frontMatterValue(markdown, "decision") ?? "unknown";
    const workCandidate = frontMatterValue(markdown, "work_candidate") ?? "none";
    const workPriority = frontMatterValue(markdown, "work_priority") ?? "low";
    const workStatus = frontMatterValue(markdown, "work_status") ?? "none";
    const kind = (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue";
    const freshReview = isFresh({ reviewedAt, reviewStatus });
    byKind[kind].total += 1;
    if (freshReview) fresh += 1;
    if (freshReview) byKind[kind].fresh += 1;
    if (freshReview && decision === "close" && action === "proposed_close") proposedClose += 1;
    if (freshReview && decision === "close" && action === "proposed_close")
      byKind[kind].proposedClose += 1;
    if (action === "closed") closed += 1;
    if (reviewStatus === "failed") failed += 1;
    if (reviewStatus.startsWith("stale_")) stale += 1;
    if (freshReview && workCandidate === "queue_fix_pr" && workStatus === "candidate") {
      workCandidates += 1;
    }
    recordDashboardActivity(markdown, activity, now);
    const cadence = cadenceBucketForReview(markdown, now);
    const cadenceBucket =
      cadence.bucket === "hourlyHotItems"
        ? hourlyHotItems
        : cadence.bucket === "dailyPullRequests"
          ? dailyPullRequests
          : cadence.bucket === "dailyNewIssues"
            ? dailyNewIssues
            : weeklyOlderIssues;
    cadenceBucket.total += 1;
    if (isCurrentForCadence({ reviewedAt, reviewStatus, cadenceMs: cadence.cadenceMs, now })) {
      cadenceBucket.current += 1;
    }
    if (decision === "close" && action === "proposed_close") cadenceBucket.proposedClose += 1;
    const dashboardItem = {
      repo,
      number,
      kind,
      title: frontMatterValue(markdown, "title") ?? "",
      reviewedAt,
      decision,
      action,
      reviewStatus,
      reportPath: repoRelativePath(join(itemsDir, file)),
      planPath: existsSync(join(plansDir, file))
        ? repoRelativePath(join(plansDir, file))
        : undefined,
      workCandidate,
      workPriority,
      workStatus,
    };
    recent.push(dashboardItem);
    if (freshReview && workCandidate === "queue_fix_pr" && workStatus === "candidate") {
      workQueue.push(dashboardItem);
    }
  }
  for (const file of closedFiles) {
    const markdown = readFileSync(join(closedDir, file), "utf8");
    if (markdownRepository(markdown, join(closedDir, file)) !== profile.targetRepo) continue;
    const repo = markdownRepository(markdown, join(closedDir, file));
    const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
    const closedAt = dashboardClosedAt(markdown);
    if (action === "closed") {
      closed += 1;
    }
    if (closedAt) {
      recentClosed.push({
        repo,
        number: numberForMarkdownFile(file),
        kind: (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
        title: frontMatterValue(markdown, "title") ?? "",
        closedAt,
        appliedAt: frontMatterValue(markdown, "applied_at"),
        closeReason: dashboardCloseReason(markdown),
        reportPath: repoRelativePath(join(closedDir, file)),
      });
    }
    recordDashboardActivity(markdown, activity, now);
  }
  recent.sort((a, b) => Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""));
  workQueue.sort(
    (a, b) =>
      workPriorityScore(b.workPriority) - workPriorityScore(a.workPriority) ||
      Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""),
  );
  recentClosed.sort(
    (a, b) =>
      (timestampMs(b.closedAt ?? b.appliedAt) ?? Number.NEGATIVE_INFINITY) -
        (timestampMs(a.closedAt ?? a.appliedAt) ?? Number.NEGATIVE_INFINITY) || b.number - a.number,
  );
  const open = fetchDashboardOpenItemCounts(profile, {
    issues: byKind.issue.total,
    pullRequests: byKind.pull_request.total,
    total: byKind.issue.total + byKind.pull_request.total,
  });
  const hourly = emptyDashboardCadenceBucket();
  const daily = emptyDashboardCadenceBucket();
  addDashboardCadenceBucket(daily, hourlyHotItems);
  const cappedDailyPullRequests = capDashboardCadenceBucket(dailyPullRequests, open.pullRequests);
  addDashboardCadenceBucket(daily, cappedDailyPullRequests);
  addDashboardCadenceBucket(daily, dailyNewIssues);
  const weekly = emptyDashboardCadenceBucket();
  addDashboardCadenceBucket(weekly, weeklyOlderIssues);
  const unreviewedOpen =
    Math.max(0, open.issues - byKind.issue.total) +
    Math.max(0, open.pullRequests - byKind.pull_request.total);
  const cadenceDue =
    hourly.total -
    hourly.current +
    (daily.total - daily.current) +
    (weekly.total - weekly.current) +
    unreviewedOpen;
  return {
    open,
    fresh,
    todo: cadenceDue,
    files: files.filter(
      (file) =>
        markdownRepository(readFileSync(join(itemsDir, file), "utf8"), join(itemsDir, file)) ===
        profile.targetRepo,
    ).length,
    proposedClose,
    closed,
    archivedFiles: closedFiles.filter(
      (file) =>
        markdownRepository(readFileSync(join(closedDir, file), "utf8"), join(closedDir, file)) ===
        profile.targetRepo,
    ).length,
    failed,
    stale,
    workCandidates,
    byKind,
    cadence: {
      hourlyHotItems,
      dailyPullRequests: cappedDailyPullRequests,
      dailyNewIssues,
      weeklyOlderIssues,
      hourly,
      daily,
      weekly,
      unreviewedOpen,
      due: cadenceDue,
    },
    activity,
    recent,
    workQueue,
    recentClosed,
  };
}

function workPriorityScore(priority: string): number {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  if (priority === "low") return 1;
  return 0;
}

function markdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function jsonFrontMatterValue(value: readonly string[]): string {
  return JSON.stringify(value);
}

function workStatusForDecision(decision: Decision): string {
  if (decision.workCandidate === "queue_fix_pr") return "candidate";
  if (decision.workCandidate === "manual_review") return "manual_review";
  return "none";
}

function displayCloseReason(reason: string | undefined): string {
  if (reason && ALL_REASONS.has(reason as CloseReason))
    return closeReasonText(reason as CloseReason);
  return reason || "unknown";
}

export function dashboardClosedAt(markdown: string): string | undefined {
  const appliedAt = frontMatterValue(markdown, "applied_at");
  if (appliedAt) return appliedAt;
  const currentItemClosedAt = frontMatterValue(markdown, "current_item_closed_at");
  if (currentItemClosedAt) return currentItemClosedAt;
  const currentState = frontMatterValue(markdown, "current_state");
  const action = frontMatterValue(markdown, "action_taken");
  if (currentState === "closed") return frontMatterValue(markdown, "reconciled_at");
  if (action === "skipped_already_closed") return frontMatterValue(markdown, "apply_checked_at");
  return undefined;
}

function dashboardCloseReason(markdown: string): string | undefined {
  const closeReason = frontMatterValue(markdown, "close_reason");
  const action = frontMatterValue(markdown, "action_taken");
  if (action === "closed") return closeReason;
  if (action === "skipped_already_closed") return "already closed before apply";
  if (frontMatterValue(markdown, "current_state") === "closed") {
    if (action === "kept_open") return "closed externally after review";
    if (action === "skipped_changed_since_review") return "closed externally after item changed";
    return action ? `closed externally after ${action}` : "closed externally";
  }
  return closeReason;
}

function fetchDashboardOpenItemCounts(
  profile: RepositoryProfile,
  fallback: OpenItemCounts,
): OpenItemCounts {
  try {
    return withTargetProfile(profile, () => fetchOpenItemCounts());
  } catch (error) {
    console.error(
      `[dashboard] failed to fetch open item counts for ${profile.targetRepo}; using local record counts: ${error instanceof Error ? error.message : String(error)}`,
    );
    return fallback;
  }
}

export function formatRecentClosedRows(items: readonly DashboardClosedItem[], limit = 10): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const reason = markdownTableCell(displayCloseReason(item.closeReason));
        return `| ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${reason} | ${formatTimestamp(item.closedAt ?? item.appliedAt)} | ${markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath))} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |"
  );
}

function formatRecentReviewedRows(items: readonly DashboardItem[], limit = 10): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const outcome = markdownLink(
          `${item.decision} / ${item.action}`,
          reportFileUrl(item.number, item.reportPath),
        );
        return `| ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${outcome} | ${item.reviewStatus} | ${formatTimestamp(item.reviewedAt)} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |"
  );
}

function formatWorkQueueRows(items: readonly DashboardItem[], limit = 10): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const report = markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath));
        const plan = item.planPath
          ? markdownLink(item.planPath, reportFileUrl(item.number, item.planPath))
          : "_pending_";
        return `| ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${item.workPriority} | ${item.workStatus} | ${formatTimestamp(item.reviewedAt)} | ${plan} | ${report} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |  |  |"
  );
}

function formatFleetRecentClosedRows(items: readonly DashboardClosedItem[], limit = 10): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const reason = markdownTableCell(displayCloseReason(item.closeReason));
        return `| ${markdownLink(repo, repoUrlFor(repo))} | ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${reason} | ${formatTimestamp(item.closedAt ?? item.appliedAt)} | ${markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath))} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |  |"
  );
}

function formatFleetRecentReviewedRows(items: readonly DashboardItem[], limit = 10): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const outcome = markdownLink(
          `${item.decision} / ${item.action}`,
          reportFileUrl(item.number, item.reportPath),
        );
        return `| ${markdownLink(repo, repoUrlFor(repo))} | ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${outcome} | ${item.reviewStatus} | ${formatTimestamp(item.reviewedAt)} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |  |"
  );
}

function formatFleetWorkQueueRows(items: readonly DashboardItem[], limit = 15): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const report = markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath));
        const plan = item.planPath
          ? markdownLink(item.planPath, reportFileUrl(item.number, item.planPath))
          : "_pending_";
        return `| ${markdownLink(repo, repoUrlFor(repo))} | ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${item.workPriority} | ${item.workStatus} | ${formatTimestamp(item.reviewedAt)} | ${plan} | ${report} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |  |  |  |"
  );
}

function addActivityBucket(target: DashboardActivityBucket, source: DashboardActivityBucket): void {
  target.reviews += source.reviews;
  target.closeDecisions += source.closeDecisions;
  target.keepOpenDecisions += source.keepOpenDecisions;
  target.failedOrStaleReviews += source.failedOrStaleReviews;
  target.closes += source.closes;
  target.commentSyncs += source.commentSyncs;
  target.applySkips += source.applySkips;
}

function aggregateActivity(snapshots: readonly RepoDashboardSnapshot[]): DashboardActivityStats {
  const activity = emptyDashboardActivityStats();
  for (const snapshot of snapshots) {
    addActivityBucket(activity.last15Minutes, snapshot.stats.activity.last15Minutes);
    addActivityBucket(activity.lastHour, snapshot.stats.activity.lastHour);
    addActivityBucket(activity.last24Hours, snapshot.stats.activity.last24Hours);
    activity.latestReviewAt = latestTimestamp(
      activity.latestReviewAt,
      snapshot.stats.activity.latestReviewAt,
    );
    activity.latestCloseAt = latestTimestamp(
      activity.latestCloseAt,
      snapshot.stats.activity.latestCloseAt,
    );
    activity.latestCommentSyncAt = latestTimestamp(
      activity.latestCommentSyncAt,
      snapshot.stats.activity.latestCommentSyncAt,
    );
  }
  return activity;
}

function buildRepoDashboardSnapshot(
  profile: RepositoryProfile,
  readme: string,
  options: { itemsDir?: string; closedDir?: string } = {},
): RepoDashboardSnapshot {
  const stats = withTargetProfile(profile, () =>
    dashboardStats(
      options.itemsDir ?? defaultItemsDir(profile),
      options.closedDir ?? defaultClosedDir(profile),
      profile,
    ),
  );
  const status = currentWorkflowStatusBlock(readme, profile);
  return {
    profile,
    stats,
    status,
    statusSummary: workflowStatusSummary(status),
    auditHealth: currentAuditHealthSection(readme, profile),
  };
}

function dashboardSnapshots(
  readme: string,
  itemsDir: string,
  closedDir: string,
): RepoDashboardSnapshot[] {
  const scopedDirs = itemsDir !== defaultItemsDir() || closedDir !== defaultClosedDir();
  if (scopedDirs) {
    return [buildRepoDashboardSnapshot(targetProfile(), readme, { itemsDir, closedDir })];
  }
  return REPOSITORY_PROFILES.map((profile) => buildRepoDashboardSnapshot(profile, readme));
}

function formatRepositoryOverviewRow(snapshot: RepoDashboardSnapshot): string {
  const stats = snapshot.stats;
  return `| ${markdownLink(snapshot.profile.displayName, repoUrlFor(snapshot.profile.targetRepo))} | ${stats.open.total} | ${stats.files} | ${stats.cadence.unreviewedOpen} | ${stats.cadence.due} | ${stats.proposedClose} | ${stats.workCandidates} | ${stats.closed} | ${formatTimestamp(stats.activity.latestReviewAt)} | ${formatTimestamp(stats.activity.latestCloseAt)} | ${stats.activity.lastHour.commentSyncs} |`;
}

function formatWorkflowStatusRow(snapshot: RepoDashboardSnapshot): string {
  const run = snapshot.statusSummary.runUrl
    ? markdownLink("run", snapshot.statusSummary.runUrl)
    : "_none_";
  const plan =
    snapshot.statusSummary.plannedCount === undefined &&
    snapshot.statusSummary.plannedCapacity === undefined &&
    snapshot.statusSummary.plannedShards === undefined
      ? "unknown"
      : `${formatStatusNumber(snapshot.statusSummary.plannedCount)}/${formatStatusNumber(
          snapshot.statusSummary.plannedCapacity,
        )} items, ${formatStatusNumber(snapshot.statusSummary.plannedShards)} shards`;
  return `| ${markdownLink(snapshot.profile.displayName, repoUrlFor(snapshot.profile.targetRepo))} | ${markdownTableCell(snapshot.statusSummary.state)} | ${formatStatusNumber(snapshot.statusSummary.activeCodex)} | ${plan} | ${formatStatusNumber(snapshot.statusSummary.dueBacklog)} | ${formatTimestamp(snapshot.statusSummary.oldestUnreviewedAt)} | ${markdownTableCell(snapshot.statusSummary.capacityReason ?? "unknown")} | ${formatTimestamp(snapshot.statusSummary.updatedAt)} | ${run} |`;
}

function renderRepoDashboardDetails(snapshot: RepoDashboardSnapshot): string {
  const stats = snapshot.stats;
  return `<details>
<summary>${snapshot.profile.displayName} (${snapshot.profile.targetRepo})</summary>

<br>

#### Current Run

${snapshot.status}

#### Queue

| Metric | Count |
| --- | ---: |
| Target repository | ${markdownLink(snapshot.profile.targetRepo, repoUrlFor(snapshot.profile.targetRepo))} |
| Open issues | ${stats.open.issues} |
| Open PRs | ${stats.open.pullRequests} |
| Open items total | ${stats.open.total} |
| Reviewed files | ${stats.files} |
| Unreviewed open items | ${stats.cadence.unreviewedOpen} |
| Active Codex target | ${formatStatusNumber(snapshot.statusSummary.activeCodex)} |
| Planned review items | ${formatStatusNumber(snapshot.statusSummary.plannedCount)} |
| Planned review shards | ${formatStatusNumber(snapshot.statusSummary.plannedShards)} |
| Planned review capacity | ${formatStatusNumber(snapshot.statusSummary.plannedCapacity)} |
| Due backlog scanned | ${formatStatusNumber(snapshot.statusSummary.dueBacklog)} |
| Oldest unreviewed scanned | ${formatTimestamp(snapshot.statusSummary.oldestUnreviewedAt)} |
| Capacity reason | ${markdownTableCell(snapshot.statusSummary.capacityReason ?? "unknown")} |
| Archived closed files | ${stats.archivedFiles} |

#### Review Outcomes

| Metric | Count |
| --- | ---: |
| Fresh reviewed issues in the last ${FRESH_DAYS} days | ${stats.byKind.issue.fresh} |
| Proposed issue closes | ${stats.byKind.issue.proposedClose} (${formatPercent(stats.byKind.issue.proposedClose, stats.byKind.issue.fresh)} of reviewed issues) |
| Fresh reviewed PRs in the last ${FRESH_DAYS} days | ${stats.byKind.pull_request.fresh} |
| Proposed PR closes | ${stats.byKind.pull_request.proposedClose} (${formatPercent(stats.byKind.pull_request.proposedClose, stats.byKind.pull_request.fresh)} of reviewed PRs) |
| Fresh verified reviews in the last ${FRESH_DAYS} days | ${stats.fresh} |
| Proposed closes awaiting apply | ${stats.proposedClose} (${formatPercent(stats.proposedClose, stats.fresh)} of fresh reviews) |
| Work candidates awaiting promotion | ${stats.workCandidates} |
| Closed by Codex apply | ${stats.closed} |
| Failed or stale reviews | ${stats.failed + stats.stale} |

#### Cadence

| Metric | Coverage |
| --- | ---: |
| First-week item cadence (<${HOT_REVIEW_DAYS}d) | ${formatCadenceBucket(stats.cadence.hourlyHotItems)} |
| Daily cadence coverage | ${formatCadenceBucket(stats.cadence.daily)} |
| Daily PR cadence | ${formatCadenceBucket(stats.cadence.dailyPullRequests)} |
| Daily new issue cadence (<${RECENT_ISSUE_DAYS}d) | ${formatCadenceBucket(stats.cadence.dailyNewIssues)} |
| Weekly older issue cadence | ${formatCadenceBucket(stats.cadence.weekly)} |
| Due now by cadence | ${stats.cadence.due} |

${snapshot.auditHealth}

#### Latest Run Activity

Latest review: ${formatTimestamp(stats.activity.latestReviewAt)}. Latest close: ${formatTimestamp(stats.activity.latestCloseAt)}. Latest comment sync: ${formatTimestamp(stats.activity.latestCommentSyncAt)}.

| Window | Reviews | Close decisions | Keep-open decisions | Failed/stale reviews | Closed | Comments synced | Apply skips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${formatActivityRow("Last 15 minutes", stats.activity.last15Minutes)}
${formatActivityRow("Last hour", stats.activity.lastHour)}
${formatActivityRow("Last 24 hours", stats.activity.last24Hours)}

#### Recently Closed

| Item | Title | Reason | Closed | Report |
| --- | --- | --- | --- | --- |
${formatRecentClosedRows(stats.recentClosed)}

#### Work Candidates

| Item | Title | Priority | Status | Reviewed | Plan | Report |
| --- | --- | --- | --- | --- | --- | --- |
${formatWorkQueueRows(stats.workQueue)}

#### Recently Reviewed

| Item | Title | Outcome | Status | Reviewed |
| --- | --- | --- | --- | --- |
${formatRecentReviewedRows(stats.recent)}

</details>`;
}

function updateDashboard(itemsDir = defaultItemsDir(), closedDir = defaultClosedDir()): void {
  const readmePath = join(ROOT, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const snapshots = dashboardSnapshots(readme, itemsDir, closedDir);
  const activity = aggregateActivity(snapshots);
  const recent = snapshots
    .flatMap((snapshot) => snapshot.stats.recent)
    .sort((a, b) => Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""));
  const workQueue = snapshots
    .flatMap((snapshot) => snapshot.stats.workQueue)
    .sort(
      (a, b) =>
        workPriorityScore(b.workPriority) - workPriorityScore(a.workPriority) ||
        Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""),
    );
  const recentClosed = snapshots
    .flatMap((snapshot) => snapshot.stats.recentClosed)
    .sort(
      (a, b) =>
        (timestampMs(b.closedAt ?? b.appliedAt) ?? Number.NEGATIVE_INFINITY) -
          (timestampMs(a.closedAt ?? a.appliedAt) ?? Number.NEGATIVE_INFINITY) ||
        b.number - a.number,
    );
  const totals = snapshots.reduce(
    (accumulator, snapshot) => {
      const stats = snapshot.stats;
      accumulator.openIssues += stats.open.issues;
      accumulator.openPullRequests += stats.open.pullRequests;
      accumulator.reviewedFiles += stats.files;
      accumulator.unreviewedOpen += stats.cadence.unreviewedOpen;
      accumulator.due += stats.cadence.due;
      accumulator.activeCodex += snapshot.statusSummary.activeCodex ?? 0;
      accumulator.plannedShards += snapshot.statusSummary.plannedShards ?? 0;
      accumulator.plannedCapacity += snapshot.statusSummary.plannedCapacity ?? 0;
      accumulator.dueBacklog += snapshot.statusSummary.dueBacklog ?? 0;
      accumulator.proposedClose += stats.proposedClose;
      accumulator.workCandidates += stats.workCandidates;
      accumulator.closed += stats.closed;
      accumulator.failedOrStale += stats.failed + stats.stale;
      accumulator.archivedFiles += stats.archivedFiles;
      return accumulator;
    },
    {
      openIssues: 0,
      openPullRequests: 0,
      reviewedFiles: 0,
      unreviewedOpen: 0,
      due: 0,
      activeCodex: 0,
      plannedShards: 0,
      plannedCapacity: 0,
      dueBacklog: 0,
      proposedClose: 0,
      workCandidates: 0,
      closed: 0,
      failedOrStale: 0,
      archivedFiles: 0,
    },
  );
  const dashboard = `## Dashboard

Last dashboard update: ${formatTimestamp(new Date().toISOString())}

### Fleet

| Metric | Count |
| --- | ---: |
| Covered repositories | ${snapshots.length} |
| Open issues | ${totals.openIssues} |
| Open PRs | ${totals.openPullRequests} |
| Open items total | ${totals.openIssues + totals.openPullRequests} |
| Reviewed files | ${totals.reviewedFiles} |
| Unreviewed open items | ${totals.unreviewedOpen} |
| Due now by cadence | ${totals.due} |
| Active Codex target | ${totals.activeCodex} |
| Planned review shards | ${totals.plannedShards} |
| Planned review capacity | ${totals.plannedCapacity} |
| Due backlog scanned | ${totals.dueBacklog} |
| Proposed closes awaiting apply | ${totals.proposedClose} |
| Work candidates awaiting promotion | ${totals.workCandidates} |
| Closed by Codex apply | ${totals.closed} |
| Failed or stale reviews | ${totals.failedOrStale} |
| Archived closed files | ${totals.archivedFiles} |

### Repositories

| Repository | Open | Reviewed | Unreviewed | Due | Proposed closes | Work candidates | Closed | Latest review | Latest close | Comments synced, 1h |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
${snapshots.map(formatRepositoryOverviewRow).join("\n")}

### Current Runs

| Repository | State | Active Codex | Plan | Due backlog | Oldest unreviewed | Capacity reason | Updated | Run |
| --- | --- | ---: | --- | ---: | --- | --- | --- | --- |
${snapshots.map(formatWorkflowStatusRow).join("\n")}

### Fleet Activity

Latest review: ${formatTimestamp(activity.latestReviewAt)}. Latest close: ${formatTimestamp(activity.latestCloseAt)}. Latest comment sync: ${formatTimestamp(activity.latestCommentSyncAt)}.

| Window | Reviews | Close decisions | Keep-open decisions | Failed/stale reviews | Closed | Comments synced | Apply skips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${formatActivityRow("Last 15 minutes", activity.last15Minutes)}
${formatActivityRow("Last hour", activity.lastHour)}
${formatActivityRow("Last 24 hours", activity.last24Hours)}

### Recently Closed Across Repos

| Repository | Item | Title | Reason | Closed | Report |
| --- | --- | --- | --- | --- | --- |
${formatFleetRecentClosedRows(recentClosed)}

### Work Candidates Across Repos

| Repository | Item | Title | Priority | Status | Reviewed | Plan | Report |
| --- | --- | --- | --- | --- | --- | --- | --- |
${formatFleetWorkQueueRows(workQueue)}

<details>
<summary>Recently Reviewed Across Repos</summary>

<br>

| Repository | Item | Title | Outcome | Status | Reviewed |
| --- | --- | --- | --- | --- | --- |
${formatFleetRecentReviewedRows(recent)}

</details>

### Repository Details

${snapshots.map(renderRepoDashboardDetails).join("\n\n")}`;
  const updated = readme.replace(
    /## Dashboard[\s\S]*?## How It Works/,
    `${dashboard}\n\n## How It Works`,
  );
  writeFileSync(readmePath, updated, "utf8");
}

function statusCommand(args: Args): void {
  const profile = repoFromArgs(args);
  const state = stringArg(args.state, "Working");
  const detail = stringArg(args.detail, "Workflow is running.");
  const runUrl = stringArg(args.run_url, "");
  const plannedCount = optionalNumberArg(args.planned_count);
  const plannedCapacity = optionalNumberArg(args.planned_capacity);
  const plannedShards = optionalNumberArg(args.planned_shards);
  const activeCodex = optionalNumberArg(args.active_codex);
  const dueBacklog = optionalNumberArg(args.due_backlog);
  const oldestUnreviewedAt = stringArg(args.oldest_unreviewed_at, "");
  const capacityReason = stringArg(args.capacity_reason, "");
  const statusOptions: Parameters<typeof writeSweepStatus>[0] = {
    state,
    detail,
    profile,
  };
  if (runUrl) statusOptions.runUrl = runUrl;
  if (plannedCount !== undefined) statusOptions.plannedCount = plannedCount;
  if (plannedCapacity !== undefined) statusOptions.plannedCapacity = plannedCapacity;
  if (plannedShards !== undefined) statusOptions.plannedShards = plannedShards;
  if (activeCodex !== undefined) statusOptions.activeCodex = activeCodex;
  if (dueBacklog !== undefined) statusOptions.dueBacklog = dueBacklog;
  if (oldestUnreviewedAt) statusOptions.oldestUnreviewedAt = oldestUnreviewedAt;
  if (capacityReason) statusOptions.capacityReason = capacityReason;
  writeSweepStatus(statusOptions);
  console.log(JSON.stringify({ status_path: sweepStatusRelativePath(profile), state, detail }));
}

function checkCommand(): void {
  JSON.parse(reviewDecisionSchemaText());
  if (!existsSync(join(ROOT, ".github", "workflows", "sweep.yml")))
    throw new Error("Missing workflow");
  console.log("ok");
}

export function main(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const command = args._[0] ?? "review";
  if (command === "plan") planCommand(args);
  else if (command === "review") reviewCommand(args);
  else if (command === "apply-artifacts") applyArtifactsCommand(args);
  else if (command === "apply-decisions") applyDecisionsCommand(args);
  else if (command === "audit") auditCommand(args);
  else if (command === "reconcile") reconcileCommand(args);
  else if (command === "dashboard") {
    repoFromArgs(args);
    updateDashboard(
      resolve(stringArg(args.items_dir, defaultItemsDir())),
      resolve(stringArg(args.closed_dir, defaultClosedDir())),
    );
  } else if (command === "status") statusCommand(args);
  else if (command === "check") checkCommand();
  else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
