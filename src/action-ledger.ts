import { createHash } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";

import {
  prepareSafeReadTarget,
  prepareSafeReadRoot,
  prepareSafeWriteTarget,
  readDirectoryEntriesNoFollow,
  readUtf8FileIfExistsNoFollow,
  readUtf8FileNoFollow,
  writeUtf8FileCreateOnlyNoFollow,
  type SafeWriteTarget,
  type SafeReadRoot,
} from "./action-ledger-files.js";
import { normalizeRepo, slugForRepo } from "./repository-profiles.js";

export const ACTION_EVENT_SCHEMA = "clawsweeper.state-ledger-event.v1";

export const ACTION_EVENT_TYPES = {
  // Compatibility types already emitted by v1 writers.
  reviewStarted: "review.started",
  reviewCompleted: "review.completed",
  reviewFailed: "review.failed",
  reviewPublished: "review.published",
  commandClaimed: "command.claimed",
  commandDispatched: "command.dispatched",
  commandCompleted: "command.completed",
  commandFailed: "command.failed",
  commandSkipped: "command.skipped",
  repairPlanned: "repair.planned",
  repairExecuted: "repair.executed",
  repairValidated: "repair.validated",
  repairReviewed: "repair.reviewed",
  repairPublished: "repair.published",
  applyPlanned: "apply.planned",
  applyExecuted: "apply.executed",
  applyBlocked: "apply.blocked",
  applyFailed: "apply.failed",
  notificationSent: "notification.sent",
  notificationFailed: "notification.failed",
  sessionRegistered: "session.registered",
  sessionPhaseChanged: "session.phase_changed",
  sessionCompleted: "session.completed",
  sessionBlocked: "session.blocked",
  projectionFailed: "projection.failed",
  gitcrawlEvidenceBound: "evidence.gitcrawl_bound",
  proofStageCompleted: "evidence.proof_stage_completed",

  // Canonical phase-oriented types for new writers.
  reviewBatch: "review.batch",
  reviewItem: "review.item",
  reviewRetry: "review.retry",
  reviewLogPublication: "review.log_publication",
  reviewCommentPublication: "review.comment_publication",
  commandReceived: "command.received",
  commandClassified: "command.classified",
  commandClaimRefreshed: "command.claim_refreshed",
  commandProgress: "command.progress",
  commandWait: "command.wait",
  commandRequeue: "command.requeue",
  commandRecover: "command.recover",
  repairIntake: "repair.intake",
  repairDispatch: "repair.dispatch",
  repairPlan: "repair.plan",
  repairExecute: "repair.execute",
  repairValidate: "repair.validate",
  repairReview: "repair.review",
  repairPublish: "repair.publish",
  repairPostflight: "repair.postflight",
  repairRequeue: "repair.requeue",
  repairRecover: "repair.recover",
  repairQueue: "repair.queue",
  repairBlocked: "repair.blocked",
  repairFailed: "repair.failed",
  applyAction: "apply.action",
  applyBatch: "apply.batch",
  applyPublish: "apply.publish",
  workflowAttempt: "workflow.attempt",
  dispatchLifecycle: "dispatch.lifecycle",
  retryLifecycle: "retry.lifecycle",
  queueLifecycle: "queue.lifecycle",
  notificationDelivery: "notification.delivery",
  notificationPlanned: "notification.planned",
  notificationSkipped: "notification.skipped",
  notificationRetried: "notification.retried",
  publicationLifecycle: "publication.lifecycle",
  statusLifecycle: "status.lifecycle",
  dashboardLifecycle: "dashboard.lifecycle",
  sessionLifecycle: "session.lifecycle",
  sessionCancelled: "session.cancelled",
  gitcrawlSnapshot: "gitcrawl.snapshot",
  gitcrawlQuery: "gitcrawl.query",
  gitcrawlBinding: "gitcrawl.binding",
  proofStage: "proof.stage",
  proofBinding: "proof.binding",
} as const;

export const ACTION_EVENT_FAMILIES = {
  review: [
    ACTION_EVENT_TYPES.reviewStarted,
    ACTION_EVENT_TYPES.reviewCompleted,
    ACTION_EVENT_TYPES.reviewFailed,
    ACTION_EVENT_TYPES.reviewPublished,
    ACTION_EVENT_TYPES.reviewBatch,
    ACTION_EVENT_TYPES.reviewItem,
    ACTION_EVENT_TYPES.reviewRetry,
    ACTION_EVENT_TYPES.reviewLogPublication,
    ACTION_EVENT_TYPES.reviewCommentPublication,
  ],
  command: [
    ACTION_EVENT_TYPES.commandClaimed,
    ACTION_EVENT_TYPES.commandDispatched,
    ACTION_EVENT_TYPES.commandCompleted,
    ACTION_EVENT_TYPES.commandFailed,
    ACTION_EVENT_TYPES.commandSkipped,
    ACTION_EVENT_TYPES.commandReceived,
    ACTION_EVENT_TYPES.commandClassified,
    ACTION_EVENT_TYPES.commandClaimRefreshed,
    ACTION_EVENT_TYPES.commandProgress,
    ACTION_EVENT_TYPES.commandWait,
    ACTION_EVENT_TYPES.commandRequeue,
    ACTION_EVENT_TYPES.commandRecover,
  ],
  repair: [
    ACTION_EVENT_TYPES.repairPlanned,
    ACTION_EVENT_TYPES.repairExecuted,
    ACTION_EVENT_TYPES.repairValidated,
    ACTION_EVENT_TYPES.repairReviewed,
    ACTION_EVENT_TYPES.repairPublished,
    ACTION_EVENT_TYPES.repairIntake,
    ACTION_EVENT_TYPES.repairDispatch,
    ACTION_EVENT_TYPES.repairPlan,
    ACTION_EVENT_TYPES.repairExecute,
    ACTION_EVENT_TYPES.repairValidate,
    ACTION_EVENT_TYPES.repairReview,
    ACTION_EVENT_TYPES.repairPublish,
    ACTION_EVENT_TYPES.repairPostflight,
    ACTION_EVENT_TYPES.repairRequeue,
    ACTION_EVENT_TYPES.repairRecover,
    ACTION_EVENT_TYPES.repairQueue,
    ACTION_EVENT_TYPES.repairBlocked,
    ACTION_EVENT_TYPES.repairFailed,
  ],
  apply: [
    ACTION_EVENT_TYPES.applyPlanned,
    ACTION_EVENT_TYPES.applyExecuted,
    ACTION_EVENT_TYPES.applyBlocked,
    ACTION_EVENT_TYPES.applyFailed,
    ACTION_EVENT_TYPES.applyAction,
    ACTION_EVENT_TYPES.applyBatch,
    ACTION_EVENT_TYPES.applyPublish,
  ],
  operations: [
    ACTION_EVENT_TYPES.workflowAttempt,
    ACTION_EVENT_TYPES.dispatchLifecycle,
    ACTION_EVENT_TYPES.retryLifecycle,
    ACTION_EVENT_TYPES.queueLifecycle,
    ACTION_EVENT_TYPES.notificationDelivery,
    ACTION_EVENT_TYPES.notificationPlanned,
    ACTION_EVENT_TYPES.notificationSkipped,
    ACTION_EVENT_TYPES.notificationRetried,
    ACTION_EVENT_TYPES.notificationSent,
    ACTION_EVENT_TYPES.notificationFailed,
    ACTION_EVENT_TYPES.publicationLifecycle,
    ACTION_EVENT_TYPES.statusLifecycle,
    ACTION_EVENT_TYPES.dashboardLifecycle,
    ACTION_EVENT_TYPES.sessionLifecycle,
    ACTION_EVENT_TYPES.sessionRegistered,
    ACTION_EVENT_TYPES.sessionPhaseChanged,
    ACTION_EVENT_TYPES.sessionCompleted,
    ACTION_EVENT_TYPES.sessionBlocked,
    ACTION_EVENT_TYPES.sessionCancelled,
    ACTION_EVENT_TYPES.projectionFailed,
  ],
  evidence: [
    ACTION_EVENT_TYPES.gitcrawlSnapshot,
    ACTION_EVENT_TYPES.gitcrawlQuery,
    ACTION_EVENT_TYPES.gitcrawlBinding,
    ACTION_EVENT_TYPES.proofStage,
    ACTION_EVENT_TYPES.proofBinding,
    ACTION_EVENT_TYPES.gitcrawlEvidenceBound,
    ACTION_EVENT_TYPES.proofStageCompleted,
  ],
} as const;

export const ACTION_EVENT_PHASE_TYPES = {
  reviewBatch: ACTION_EVENT_TYPES.reviewBatch,
  reviewItem: ACTION_EVENT_TYPES.reviewItem,
  reviewRetry: ACTION_EVENT_TYPES.reviewRetry,
  reviewLogPublication: ACTION_EVENT_TYPES.reviewLogPublication,
  reviewCommentPublication: ACTION_EVENT_TYPES.reviewCommentPublication,
  commandReceived: ACTION_EVENT_TYPES.commandReceived,
  commandClassified: ACTION_EVENT_TYPES.commandClassified,
  commandClaimRefreshed: ACTION_EVENT_TYPES.commandClaimRefreshed,
  commandProgress: ACTION_EVENT_TYPES.commandProgress,
  commandWait: ACTION_EVENT_TYPES.commandWait,
  commandRequeue: ACTION_EVENT_TYPES.commandRequeue,
  commandRecover: ACTION_EVENT_TYPES.commandRecover,
  repairIntake: ACTION_EVENT_TYPES.repairIntake,
  repairDispatch: ACTION_EVENT_TYPES.repairDispatch,
  repairPlan: ACTION_EVENT_TYPES.repairPlan,
  repairExecute: ACTION_EVENT_TYPES.repairExecute,
  repairValidate: ACTION_EVENT_TYPES.repairValidate,
  repairReview: ACTION_EVENT_TYPES.repairReview,
  repairPublish: ACTION_EVENT_TYPES.repairPublish,
  repairPostflight: ACTION_EVENT_TYPES.repairPostflight,
  repairRequeue: ACTION_EVENT_TYPES.repairRequeue,
  repairRecover: ACTION_EVENT_TYPES.repairRecover,
  repairQueue: ACTION_EVENT_TYPES.repairQueue,
  repairBlocked: ACTION_EVENT_TYPES.repairBlocked,
  repairFailed: ACTION_EVENT_TYPES.repairFailed,
  applyAction: ACTION_EVENT_TYPES.applyAction,
  applyBatch: ACTION_EVENT_TYPES.applyBatch,
  applyPublish: ACTION_EVENT_TYPES.applyPublish,
  workflowAttempt: ACTION_EVENT_TYPES.workflowAttempt,
  dispatchLifecycle: ACTION_EVENT_TYPES.dispatchLifecycle,
  retryLifecycle: ACTION_EVENT_TYPES.retryLifecycle,
  queueLifecycle: ACTION_EVENT_TYPES.queueLifecycle,
  notificationDelivery: ACTION_EVENT_TYPES.notificationDelivery,
  notificationPlanned: ACTION_EVENT_TYPES.notificationPlanned,
  notificationSkipped: ACTION_EVENT_TYPES.notificationSkipped,
  notificationRetried: ACTION_EVENT_TYPES.notificationRetried,
  publicationLifecycle: ACTION_EVENT_TYPES.publicationLifecycle,
  statusLifecycle: ACTION_EVENT_TYPES.statusLifecycle,
  dashboardLifecycle: ACTION_EVENT_TYPES.dashboardLifecycle,
  sessionLifecycle: ACTION_EVENT_TYPES.sessionLifecycle,
  sessionCancelled: ACTION_EVENT_TYPES.sessionCancelled,
  gitcrawlSnapshot: ACTION_EVENT_TYPES.gitcrawlSnapshot,
  gitcrawlQuery: ACTION_EVENT_TYPES.gitcrawlQuery,
  gitcrawlBinding: ACTION_EVENT_TYPES.gitcrawlBinding,
  proofStage: ACTION_EVENT_TYPES.proofStage,
  proofBinding: ACTION_EVENT_TYPES.proofBinding,
} as const;

export const ACTION_EVENT_STATUSES = {
  blocked: "blocked",
  cached: "cached",
  cancelled: "cancelled",
  claimed: "claimed",
  classified: "classified",
  completed: "completed",
  dispatched: "dispatched",
  executed: "executed",
  failed: "failed",
  inProgress: "in_progress",
  planned: "planned",
  published: "published",
  queued: "queued",
  received: "received",
  recovered: "recovered",
  refreshed: "refreshed",
  registered: "registered",
  released: "released",
  requeued: "requeued",
  retried: "retried",
  scheduled: "scheduled",
  sent: "sent",
  skipped: "skipped",
  started: "started",
  unchanged: "unchanged",
  validated: "validated",
  waiting: "waiting",
  yielded: "yielded",
} as const;

export const ACTION_EVENT_REASON_CODES = {
  accepted: "accepted",
  alreadyComplete: "already_complete",
  alreadyExists: "already_exists",
  alreadyProcessed: "already_processed",
  appendFailed: "append_failed",
  authorizationFailed: "authorization_failed",
  cancelled: "cancelled",
  capacityExhausted: "capacity_exhausted",
  completed: "completed",
  contentUnchanged: "content_unchanged",
  dependencyPending: "dependency_pending",
  dryRun: "dry_run",
  duplicate: "duplicate",
  exception: "exception",
  invalidInput: "invalid_input",
  leaseActive: "lease_active",
  manual: "manual",
  mutationGuard: "mutation_guard",
  noChanges: "no_changes",
  notApplicable: "not_applicable",
  notFound: "not_found",
  policyBlocked: "policy_blocked",
  published: "published",
  rateLimited: "rate_limited",
  recoveredStaleClaim: "recovered_stale_claim",
  retryExhausted: "retry_exhausted",
  retryScheduled: "retry_scheduled",
  runtimeBudget: "runtime_budget",
  selected: "selected",
  sourceChanged: "source_changed",
  stale: "stale",
  stateChanged: "state_changed",
  superseded: "superseded",
  timeout: "timeout",
  unavailable: "unavailable",
  validationFailed: "validation_failed",
  workerLost: "worker_lost",
  workflowFailed: "workflow_failed",
} as const;

export const ACTION_EVENT_SUBJECT_KINDS = [
  "issue",
  "pull_request",
  "cluster",
  "command",
  "workflow",
  "repository",
  "notification",
  "commit",
  "queue_item",
  "deployment",
  "publication",
] as const;

export const ACTION_EVENT_ATTRIBUTE_KEYS = [
  "action_count",
  "attempt",
  "batch_index",
  "batch_size",
  "cache_mode",
  "cached",
  "candidate_count",
  "closed_count",
  "comment_count",
  "completion_reason",
  "cost_usd_micros",
  "coverage_complete",
  "coverage_ratio",
  "delivery_kind",
  "dispatch_kind",
  "duration_ms",
  "failed_count",
  "final_attempt",
  "finding_count",
  "input_tokens",
  "item_count",
  "lease_duration_ms",
  "log_count",
  "log_kind",
  "model",
  "output_tokens",
  "partial",
  "phase",
  "processed_count",
  "publication_kind",
  "published_count",
  "queue_depth",
  "queue_kind",
  "query_version",
  "reasoning_effort",
  "result_count",
  "retry_count",
  "retry_delay_ms",
  "review_mode",
  "shard_count",
  "shard_index",
  "skipped_count",
  "state",
  "status_kind",
  "validation_count",
  "validation_kind",
  "wait_duration_ms",
  "warning_count",
  "work_kind",
  "workflow_phase",
] as const;

export const ACTION_EVENT_MACHINE_TEXT_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9_.:/@+\\-]*$";
export const ACTION_EVENT_RELATIVE_DATA_PATH_PATTERN_SOURCE =
  "^(?:\\.artifacts|artifacts|jobs|ledger|logs|notifications|records|results)(?:/(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\\.|/|$))[A-Za-z0-9_](?:[A-Za-z0-9._+@\\-]{0,253}[A-Za-z0-9_+@\\-])?)+$";
export const ACTION_EVENT_TIMESTAMP_PATTERN_SOURCE =
  "^(?:(?:(?!0000)[0-9]{4})-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:0[48]|[2468][048]|[13579][26])00)-02-29)T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$";
export const ACTION_LEDGER_CANONICAL_JSON_LIMITS = {
  maxDepth: 64,
  maxNodes: 10_000,
  maxBytes: 1024 * 1024,
} as const;
export const ACTION_EVENT_SHARD_FILE_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxEvents: 1_024,
} as const;
export const ACTION_EVENT_SHARD_SET_LIMITS = {
  maxEvents: 65_536,
} as const;
export const ACTION_EVENT_SPOOL_READ_LIMITS = {
  maxRepositories: 256,
  maxEntriesPerRepository: 4_096,
  maxEvents: 65_536,
  maxProducers: 256,
  maxTotalBytes: 64 * 1024 * 1024,
} as const;
export const ACTION_EVENT_CONFIDENTIAL_IDENTIFIER_PATTERN_SOURCES = [
  "/(?:[Uu][Ss][Ee][Rr][Ss]|[Hh][Oo][Mm][Ee]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee]|[Tt][Mm][Pp])/",
  "\\\\[Uu][Ss][Ee][Rr][Ss]\\\\",
  "(?:^|[\\\\/])[A-Za-z]:[\\\\/]",
  "(?:^|[^A-Za-z0-9+.-])[A-Za-z0-9_.@+-]+:(?:/(?!/)|[A-Za-z]:/)",
  "%[0-9A-Fa-f]{2}",
  "(?:^|[^A-Za-z0-9+.-])[Ff][Ii][Ll][Ee]:",
  "(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*://[^\\s/@]+@",
  "(?:^|[^A-Za-z0-9+.-])(?:[Hh][Tt][Tt][Pp][Ss]?|[Ff][Tt][Pp]|[Ss][Ss][Hh]|[Ww][Ss]?):(?://)?[^\\s/@]+@",
  "BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY",
  "(?:[Gg][Hh][PpOoUuSsRr]_[A-Za-z0-9]{16,}|[Gg][Ii][Tt][Hh][Uu][Bb]_[Pp][Aa][Tt]_[A-Za-z0-9_]{16,}|[Ss][Kk]-[A-Za-z0-9_-]{16,})",
  "(?:^|[^A-Za-z0-9])[Nn][Pp][Mm]_[A-Za-z0-9]{36}(?:$|[^A-Za-z0-9])",
  "(?:^|[^A-Za-z0-9])[Xx][Oo][Xx][A-Za-z]-[A-Za-z0-9-]{10,}(?:$|[^A-Za-z0-9-])",
  "(?:^|[^A-Za-z0-9])(?:[Aa][Kk][Ii][Aa]|[Aa][Ss][Ii][Aa])[A-Za-z0-9]{16}(?:$|[^A-Za-z0-9])",
  "eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{16,}",
  "(?:[Bb][Ee][Aa][Rr][Ee][Rr]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Aa][Pp][Ii][_-]?(?:[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn])|[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Tt][Oo][Kk][Ee][Nn]|[Cc][Ll][Ii][Ee][Nn][Tt][_-]?[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Ll][Oo][Uu][Dd][Ff][Ll][Aa][Rr][Ee][_-]?(?:[Aa][Pp][Ii][_-]?)?(?:[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]))(?:\\s+|%20|\\s*[:=_+\\-]\\s*)[A-Za-z0-9._~+\\/-]{16,}={0,2}",
  "[Bb][Aa][Ss][Ii][Cc](?:\\s+|%20|\\s*[:+]\\s*)(?:[A-Za-z0-9+/]{4}){1,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?:$|[^A-Za-z0-9+/=])",
  "[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?",
  "(?:^|[/:@])(?:[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]|(?:[A-Za-z0-9-]+\\.)+(?:[Ll][Oo][Cc][Aa][Ll]|[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]|[Ii][Nn][Tt][Ee][Rr][Nn][Aa][Ll]|[Cc][Oo][Rr][Pp]|[Ll][Aa][Nn]|[Hh][Oo][Mm][Ee](?:\\.[Aa][Rr][Pp][Aa])?)|(?:[Ii][Nn][Tt][Ee][Rr][Nn][Aa][Ll]|[Ii][Nn][Tt][Rr][Aa][Nn][Ee][Tt])\\.(?:[A-Za-z0-9-]+\\.)*[A-Za-z0-9-]+)\\.*(?:$|[/:])",
  "(?:^|[^0-9])(?:10(?:\\.[0-9]{1,3}){3}|127(?:\\.[0-9]{1,3}){3}|100\\.(?:6[4-9]|[78][0-9]|9[0-9]|1[01][0-9]|12[0-7])(?:\\.[0-9]{1,3}){2}|169\\.254(?:\\.[0-9]{1,3}){2}|192\\.168(?:\\.[0-9]{1,3}){2}|172\\.(?:1[6-9]|2[0-9]|3[01])(?:\\.[0-9]{1,3}){2})(?:$|[^0-9])",
  "(?:^|[^0-9])(?:0[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+|[0-9]+\\.0[0-9]+\\.[0-9]+\\.[0-9]+|[0-9]+\\.[0-9]+\\.0[0-9]+\\.[0-9]+|[0-9]+\\.[0-9]+\\.[0-9]+\\.0[0-9]+)(?:$|[^0-9])",
  "(?:^|[\\[/:@])(?:(?:::)(?:0{1,4}:){0,6}0*1|(?:0{1,4}:){1,6}:(?:0{1,4}:){0,6}0*1|(?:0{1,4}:){7}0*1|(?:(?:::)(?:[Ff]{4}:)?|(?:0{1,4}:){5}[Ff]{4}:|(?:0{1,4}:){6})7[fF][0-9A-Fa-f]{2}:[0-9A-Fa-f]{1,4}|(?:[Ff][CcDd][0-9A-Fa-f]{2}|[Ff][Ee][89AaBb][0-9A-Fa-f]):[0-9A-Fa-f:]+)(?:\\]|$|[/:])",
  "(?:^|[\\[/:@])(?:(?:::)(?:[Ff]{4}:)?|(?:0{1,4}:){5}[Ff]{4}:|(?:0{1,4}:){6})(?:[0]?[Aa][0-9A-Fa-f]{2}|64(?:4[0-9A-Fa-f]|[5-7][0-9A-Fa-f])|7[Ff][0-9A-Fa-f]{2}|[Aa]9[Ff][Ee]|[Aa][Cc]1[0-9A-Fa-f]|[Cc]0[Aa]8):[0-9A-Fa-f]{1,4}(?:\\]|$|[/:])",
  "(?:^|[\\[/:@])(?:(?:(?:0{1,4}:){0,3}0{1,4})?::[Ff]{4}:|(?:(?:0{1,4}:){0,4}0{1,4})?::)(?:[0]?[Aa][0-9A-Fa-f]{2}|64(?:4[0-9A-Fa-f]|[5-7][0-9A-Fa-f])|7[Ff][0-9A-Fa-f]{2}|[Aa]9[Ff][Ee]|[Aa][Cc]1[0-9A-Fa-f]|[Cc]0[Aa]8):[0-9A-Fa-f]{1,4}(?:\\]|$|[/:])",
  "(?:^|[^A-Za-z0-9+.-])(?:[Hh][Tt][Tt][Pp][Ss]?|[Ff][Tt][Pp]|[Ww][Ss][Ss]?):/{0,2}(?:(?:10|127)(?:\\.[0-9]+){1,2}|(?:100\\.(?:6[4-9]|[78][0-9]|9[0-9]|1[01][0-9]|12[0-7])|169\\.254|192\\.168|172\\.(?:1[6-9]|2[0-9]|3[01]))\\.[0-9]+)(?:$|[/:])",
  "(?:^|[^A-Za-z0-9+.-])(?:[Hh][Tt][Tt][Pp][Ss]?|[Ff][Tt][Pp]|[Ww][Ss][Ss]?):/{0,2}(?:0[Xx][0-9A-Fa-f]+|0[0-7]+|[0-9]+)(?:$|[/:])",
  "(?:^|[^A-Za-z0-9+.-])(?:[Hh][Tt][Tt][Pp][Ss]?|[Ff][Tt][Pp]|[Ww][Ss][Ss]?):/{0,2}(?:[A-Za-z0-9-]+\\.)*(?:0[Xx][0-9A-Fa-f]+|0[0-9]+)(?:\\.|[/:]|$)",
] as const;

const POSITIVE_INTEGER_ATTRIBUTE_KEYS = new Set<ActionEventAttributeKey>([
  "attempt",
  "batch_size",
  "shard_count",
]);
const RELATIVE_DATA_PATH_PATTERN = new RegExp(ACTION_EVENT_RELATIVE_DATA_PATH_PATTERN_SOURCE);
const NON_NEGATIVE_INTEGER_ATTRIBUTE_KEYS = new Set<ActionEventAttributeKey>([
  "action_count",
  "batch_index",
  "candidate_count",
  "closed_count",
  "comment_count",
  "cost_usd_micros",
  "duration_ms",
  "failed_count",
  "finding_count",
  "input_tokens",
  "item_count",
  "lease_duration_ms",
  "log_count",
  "output_tokens",
  "processed_count",
  "published_count",
  "queue_depth",
  "result_count",
  "retry_count",
  "retry_delay_ms",
  "shard_index",
  "skipped_count",
  "validation_count",
  "wait_duration_ms",
  "warning_count",
]);
const BOOLEAN_ATTRIBUTE_KEYS = new Set<ActionEventAttributeKey>([
  "cached",
  "coverage_complete",
  "final_attempt",
  "partial",
]);
const UNIT_INTERVAL_ATTRIBUTE_KEYS = new Set<ActionEventAttributeKey>(["coverage_ratio"]);
const MACHINE_TEXT_ATTRIBUTE_KEYS = new Set<ActionEventAttributeKey>([
  "cache_mode",
  "completion_reason",
  "delivery_kind",
  "dispatch_kind",
  "log_kind",
  "model",
  "phase",
  "publication_kind",
  "queue_kind",
  "query_version",
  "reasoning_effort",
  "review_mode",
  "state",
  "status_kind",
  "validation_kind",
  "work_kind",
  "workflow_phase",
]);
const MAX_EVENT_COLLECTION_ITEMS = 64;
const MACHINE_TEXT_PATTERN = new RegExp(ACTION_EVENT_MACHINE_TEXT_PATTERN_SOURCE);
const TIMESTAMP_PATTERN = new RegExp(ACTION_EVENT_TIMESTAMP_PATTERN_SOURCE);
const CONFIDENTIAL_IDENTIFIER_PATTERNS = ACTION_EVENT_CONFIDENTIAL_IDENTIFIER_PATTERN_SOURCES.map(
  (source) => new RegExp(source),
);
const HIGH_RISK_CREDENTIAL_FIELD_NAMES = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "apikey",
  "apitoken",
  "authtoken",
  "githubtoken",
  "refreshtoken",
  "cloudflareapitoken",
  "privatekey",
  "clientsecret",
]);

export type ActionEventAttributeKey = (typeof ACTION_EVENT_ATTRIBUTE_KEYS)[number];
export type ActionEventType = (typeof ACTION_EVENT_TYPES)[keyof typeof ACTION_EVENT_TYPES];
export type ActionEventFamily = keyof typeof ACTION_EVENT_FAMILIES;
export type ActionEventPhaseType =
  (typeof ACTION_EVENT_PHASE_TYPES)[keyof typeof ACTION_EVENT_PHASE_TYPES];
export type ActionEventStatus = (typeof ACTION_EVENT_STATUSES)[keyof typeof ACTION_EVENT_STATUSES];
export type ActionEventReasonCode =
  (typeof ACTION_EVENT_REASON_CODES)[keyof typeof ACTION_EVENT_REASON_CODES];
export type ActionEventSubjectKind = (typeof ACTION_EVENT_SUBJECT_KINDS)[number];
export type ActionEventScalar = string | number | boolean;
export type ActionEventAttributes = Partial<
  Record<ActionEventAttributeKey, ActionEventScalar | readonly ActionEventScalar[]>
>;

export type ActionEventProducer = {
  repository: string;
  sha: string;
  workflow: string;
  job: string;
  runId: string;
  runAttempt: number;
  component: string;
};

export type ActionEventSubject = {
  repository: string;
  kind: ActionEventSubjectKind;
  subjectId?: string;
  number?: number;
  clusterId?: string;
  sourceRevision?: string;
  recordPath?: string;
};

export type ActionEventAction = {
  name: string;
  status: string;
  reasonCode?: string;
  retryable: boolean;
  mutation: boolean;
};

export type ActionEventLearning = {
  category: string;
  signal: string;
  ruleId?: string;
  confidence?: number;
};

export type ActionEventEvidence = {
  kind: string;
  sha256?: string;
  reportPath?: string;
  runUrl?: string;
  snapshotId?: string;
};

export type ActionEventPrivacy = {
  classification: "public" | "internal";
  redactionVersion: string;
  fieldsDropped: readonly string[];
};

export type ActionEventOccurrenceSource = "source" | "generated";

export type ActionEventInput = {
  eventKey: string;
  operationId: string;
  attemptId: string;
  parentEventId?: string | null;
  phaseSeq: number;
  idempotencyKeySha256: string;
  type: string;
  producer: ActionEventProducer;
  subject: ActionEventSubject;
  action: ActionEventAction;
  learning?: ActionEventLearning;
  evidence?: readonly ActionEventEvidence[];
  attributes?: ActionEventAttributes;
  privacy?: ActionEventPrivacy;
  occurredAt?: string;
};

export type ActionEvent = {
  schema: typeof ACTION_EVENT_SCHEMA;
  schema_version: 1;
  event_id: string;
  event_key: string;
  operation_id: string;
  attempt_id: string;
  parent_event_id: string | null;
  phase_seq: number;
  idempotency_key_sha256: string;
  semantic_sha256: string;
  occurred_at: string;
  occurred_at_source: ActionEventOccurrenceSource;
  recorded_at: string;
  event_type: string;
  producer: {
    repository: string;
    sha: string;
    workflow: string;
    job: string;
    run_id: string;
    run_attempt: number;
    component: string;
  };
  subject: {
    repository: string;
    kind: ActionEventSubject["kind"];
    subject_id?: string;
    number?: number;
    cluster_id?: string;
    source_revision?: string;
    record_path?: string;
  };
  action: {
    name: string;
    status: string;
    reason_code?: string;
    retryable: boolean;
    mutation: boolean;
  };
  learning?: {
    category: string;
    signal: string;
    rule_id?: string;
    confidence?: number;
  };
  evidence?: Array<{
    kind: string;
    sha256?: string;
    report_path?: string;
    run_url?: string;
    snapshot_id?: string;
  }>;
  attributes?: Record<string, ActionEventScalar | ActionEventScalar[]>;
  privacy: {
    classification: "public" | "internal";
    redaction_version: string;
    fields_dropped: string[];
  };
};

export type ActionEventWriteResult = {
  status: "created" | "unchanged";
  event: ActionEvent;
  path: string;
  relativePath: string;
};

export type ActionEventShardIdentity = {
  repository: string;
  sha: string;
  producer: string;
  workflow: string;
  job: string;
  runId: string;
  runAttempt: number;
  partitionDate: string;
};

export type ActionEventShardWriteResult = {
  status: "created" | "unchanged";
  path: string;
  relativePath: string;
  sha256: string;
  eventCount: number;
};

export class ActionEventConflictError extends Error {
  readonly eventPath: string;
  readonly expectedSemanticSha256: string;
  readonly actualSemanticSha256: string;

  constructor({
    eventPath,
    expectedSemanticSha256,
    actualSemanticSha256,
  }: {
    eventPath: string;
    expectedSemanticSha256: string;
    actualSemanticSha256: string;
  }) {
    super(
      `action event conflict at ${eventPath}: ${expectedSemanticSha256} != ${actualSemanticSha256}`,
    );
    this.name = "ActionEventConflictError";
    this.eventPath = eventPath;
    this.expectedSemanticSha256 = expectedSemanticSha256;
    this.actualSemanticSha256 = actualSemanticSha256;
  }
}

export class ActionEventShardConflictError extends Error {
  readonly shardPath: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;

  constructor({
    shardPath,
    expectedSha256,
    actualSha256,
  }: {
    shardPath: string;
    expectedSha256: string;
    actualSha256: string;
  }) {
    super(`action event shard conflict at ${shardPath}: ${expectedSha256} != ${actualSha256}`);
    this.name = "ActionEventShardConflictError";
    this.shardPath = shardPath;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

const ACTION_EVENT_PHASE_TYPE_VALUES = new Set<string>(Object.values(ACTION_EVENT_PHASE_TYPES));
const ACTION_EVENT_STATUS_VALUES = new Set<string>(Object.values(ACTION_EVENT_STATUSES));
const ACTION_EVENT_REASON_CODE_VALUES = new Set<string>(Object.values(ACTION_EVENT_REASON_CODES));

export function isActionEventPhaseType(value: string): value is ActionEventPhaseType {
  return ACTION_EVENT_PHASE_TYPE_VALUES.has(value);
}

export function isActionEventStatus(value: string): value is ActionEventStatus {
  return ACTION_EVENT_STATUS_VALUES.has(value);
}

export function isActionEventReasonCode(value: string): value is ActionEventReasonCode {
  return ACTION_EVENT_REASON_CODE_VALUES.has(value);
}

export function actionLedgerJson(value: unknown): string {
  return serializeCanonicalJson(canonicalJsonValue(value));
}

export function actionEventKey(scope: string, identity: unknown): string {
  const normalizedScope = eventScope(scope);
  return `${normalizedScope}:${sha256(canonicalIdentityJson(identity))}`;
}

export function actionOperationId(
  repository: string,
  operation: string,
  identity: unknown,
): string {
  return sha256(
    canonicalIdentityJson({
      repository: requiredRepo(repository),
      operation: eventScope(operation),
      identity,
    }),
  );
}

export function actionAttemptId(operationId: string, identity: unknown): string {
  return sha256(
    canonicalIdentityJson({
      operation_id: requiredSha256(operationId, "action operation id"),
      identity,
    }),
  );
}

export function actionIdempotencyKey(identity: unknown): string {
  return sha256(canonicalIdentityJson(identity));
}

export function actionEventId(repository: string, eventKey: string): string {
  return sha256(`${requiredRepo(repository)}\n${requiredEventKey(eventKey)}`);
}

export function actionEventSpoolRelativePath(repository: string, eventId: string): string {
  const normalizedRepo = requiredRepo(repository);
  requiredSha256(eventId, "action event id");
  return path.join(
    ".clawsweeper-repair",
    "action-events",
    actionEventSpoolRepositoryDirectory(normalizedRepo),
    `${eventId}.json`,
  );
}

function actionEventSpoolRepositoryDirectory(repository: string): string {
  return `${slugForRepo(repository)}-${sha256(repository).slice(0, 12)}`;
}

export function actionEventShardRelativePath(
  identity: ActionEventShardIdentity,
  events: readonly ActionEvent[],
  shardIndex?: number,
  shardCount?: number,
): string {
  assertRawActionEventShardInput(events, ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents);
  const normalizedIdentity = normalizeShardIdentity(identity);
  const normalizedEvents = normalizeShardEvents(events);
  if (normalizedEvents.length === 0) throw new Error("action event shard requires events");
  if ((shardIndex === undefined) !== (shardCount === undefined)) {
    throw new Error("action event shard index and count must be provided together");
  }
  const [year, month, date] = normalizedIdentity.partitionDate.split("-");
  const identityDigest = sha256(actionLedgerJson(normalizedIdentity)).slice(0, 12);
  const filenameBase = [
    boundedPathSegment(normalizedIdentity.runId, 64),
    String(normalizedIdentity.runAttempt),
    boundedPathSegment(normalizedIdentity.job, 64),
    identityDigest,
  ].join("-");
  const normalizedShardIndex =
    shardIndex === undefined ? undefined : actionEventShardIndex(shardIndex);
  const normalizedShardCount =
    shardCount === undefined ? undefined : actionEventShardIndex(shardCount);
  if (
    normalizedShardIndex !== undefined &&
    normalizedShardCount !== undefined &&
    normalizedShardIndex > normalizedShardCount
  ) {
    throw new Error("action event shard index cannot exceed shard count");
  }
  const filename =
    normalizedShardIndex === undefined
      ? filenameBase
      : `${filenameBase}-part-${String(normalizedShardIndex).padStart(6, "0")}-of-${String(
          normalizedShardCount,
        ).padStart(6, "0")}`;
  return path.join(
    "ledger",
    "v1",
    "events",
    String(year),
    String(month),
    String(date),
    boundedPathSegment(slugForRepo(normalizedIdentity.repository), 120),
    boundedPathSegment(normalizedIdentity.producer, 120),
    `${filename}.jsonl`,
  );
}

export function createActionEvent(
  input: ActionEventInput,
  options: { now?: () => Date; generatedOccurredAt?: string } = {},
): ActionEvent {
  const semantic = actionEventSemanticValue(input);
  const recordedAt = requiredTimestamp(
    (options.now ?? (() => new Date()))().toISOString(),
    "action event recorded_at",
  );
  const hasSourceOccurrence = input.occurredAt !== undefined;
  const occurredAtSource: ActionEventOccurrenceSource = hasSourceOccurrence
    ? "source"
    : "generated";
  const occurredAt =
    input.occurredAt !== undefined
      ? requiredTimestamp(input.occurredAt, "action event occurredAt")
      : options.generatedOccurredAt !== undefined
        ? requiredTimestamp(options.generatedOccurredAt, "generated action event occurredAt")
        : recordedAt;
  const semanticSha256 = actionEventSemanticSha256(semantic, occurredAt, occurredAtSource);
  const eventId = actionEventId(semantic.subject.repository, input.eventKey);
  if (semantic.parent_event_id === eventId) {
    throw new Error("action event cannot reference itself as its parent");
  }
  return canonicalJsonValue({
    schema: ACTION_EVENT_SCHEMA,
    schema_version: 1,
    event_id: eventId,
    event_key: requiredEventKey(input.eventKey),
    semantic_sha256: semanticSha256,
    occurred_at: occurredAt,
    occurred_at_source: occurredAtSource,
    recorded_at: recordedAt,
    ...semantic,
  }) as ActionEvent;
}

export function writeActionEvent(
  root: string,
  input: ActionEventInput,
  options: { now?: () => Date; generatedOccurredAt?: string } = {},
): ActionEventWriteResult {
  const candidate = createActionEvent(input, options);
  const relativePath = actionEventSpoolRelativePath(
    candidate.subject.repository,
    candidate.event_id,
  );
  const target = prepareSafeWriteTarget(root, relativePath, "action event");
  const eventPath = target.path;

  const existing = readActionEventIfExists(target);
  if (existing) {
    return compareExistingActionEvent(eventPath, relativePath, existing, candidate);
  }

  const content = `${actionLedgerJson(candidate)}\n`;
  const status = writeCreateOnlyFile(target, content, () => {
    const raced = readActionEventIfExists(target);
    if (!raced) throw new Error(`action event appeared without readable content: ${eventPath}`);
    compareExistingActionEvent(eventPath, relativePath, raced, candidate);
  });
  return {
    status,
    event: status === "unchanged" ? readActionEventTarget(target) : candidate,
    path: eventPath,
    relativePath,
  };
}

export function writeActionEventShard(
  root: string,
  identity: ActionEventShardIdentity,
  events: readonly ActionEvent[],
  shardIndex?: number,
  shardCount?: number,
): ActionEventShardWriteResult {
  assertRawActionEventShardInput(events, ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents);
  const normalizedEvents = normalizeShardEvents(events);
  if (normalizedEvents.length === 0) throw new Error("action event shard requires events");
  validateShardProducer(identity, normalizedEvents);
  const relativePath = actionEventShardRelativePath(
    identity,
    normalizedEvents,
    shardIndex,
    shardCount,
  );
  const content = normalizedEvents.map((event) => actionLedgerJson(event)).join("\n") + "\n";
  assertActionEventShardFileLimits(content, normalizedEvents.length);
  const target = prepareSafeWriteTarget(root, relativePath, "action event shard");
  const shardPath = target.path;
  const digest = sha256(content);
  const existing = readUtf8FileIfExistsNoFollow(target, ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes);
  if (existing !== null) {
    return compareExistingShard(shardPath, relativePath, existing, digest, normalizedEvents);
  }
  const status = writeCreateOnlyFile(target, content, () => {
    const raced = readUtf8FileIfExistsNoFollow(target, ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes);
    if (raced === null) {
      throw new Error(`action event shard appeared without readable content: ${shardPath}`);
    }
    compareExistingShard(shardPath, relativePath, raced, digest, normalizedEvents);
  });
  return {
    status,
    path: shardPath,
    relativePath,
    sha256: digest,
    eventCount: normalizedEvents.length,
  };
}

export function writeActionEventShards(
  root: string,
  identity: ActionEventShardIdentity,
  events: readonly ActionEvent[],
): ActionEventShardWriteResult[] {
  assertRawActionEventShardInput(events, ACTION_EVENT_SHARD_SET_LIMITS.maxEvents);
  const normalizedEvents = normalizeShardEvents(events);
  if (normalizedEvents.length === 0) throw new Error("action event shard requires events");
  validateShardProducer(identity, normalizedEvents);
  const shardEvents = splitActionEventShardEvents(normalizedEvents);
  return shardEvents.map((eventsForShard, index) =>
    writeActionEventShard(root, identity, eventsForShard, index + 1, shardEvents.length),
  );
}

export function readActionEvent(filePath: string): ActionEvent {
  return readActionEventTarget(
    prepareSafeReadTarget(path.dirname(filePath), path.basename(filePath), "action event"),
  );
}

export function readActionEventShard(filePath: string): ActionEvent[] {
  return readActionEventShardTarget(
    prepareSafeReadTarget(path.dirname(filePath), path.basename(filePath), "action event shard"),
  );
}

export function readActionEventShardAt(
  root: string | SafeReadRoot,
  relativePath: string,
): ActionEvent[] {
  return readActionEventShardTarget(
    prepareSafeReadTarget(root, relativePath, "action event shard"),
  );
}

function readActionEventShardTarget(target: SafeWriteTarget): ActionEvent[] {
  const events = parseActionEventShardContent(
    readUtf8FileNoFollow(target, ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes),
    target.path,
  );
  validateDirectActionEventShard(events, target.path);
  return events;
}

export function readSpooledActionEvents(
  root: string | SafeReadRoot,
  repository: string,
): ActionEvent[] {
  const safeRoot =
    typeof root === "string" ? prepareSafeReadRoot(root, "action event spool") : root;
  const normalizedRepository = requiredRepo(repository);
  const relativeDirectory = path.join(
    ".clawsweeper-repair",
    "action-events",
    actionEventSpoolRepositoryDirectory(normalizedRepository),
  );
  let entries;
  try {
    entries = readDirectoryEntriesNoFollow(
      safeRoot,
      relativeDirectory,
      "action event spool",
      ACTION_EVENT_SPOOL_READ_LIMITS.maxEntriesPerRepository,
    );
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const budget = createActionEventSpoolReadBudget();
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(
        `refusing unsafe action event spool entry: ${path.join(relativeDirectory, entry.name)}`,
      );
    }
    if (!entry.name.endsWith(".json")) continue;
    const relativePath = path.join(relativeDirectory, entry.name);
    const event = readActionEventTarget(
      prepareSafeReadTarget(safeRoot, relativePath, "action event spool entry"),
    );
    assertCanonicalSpooledEventPath(event, relativePath, normalizedRepository);
    retainSpooledActionEvent(budget, event);
  }
  return budget.events.sort(compareEvents);
}

export function readAllSpooledActionEvents(root: string | SafeReadRoot): ActionEvent[] {
  const safeRoot =
    typeof root === "string" ? prepareSafeReadRoot(root, "action event spool") : root;
  const relativeRoot = path.join(".clawsweeper-repair", "action-events");
  let repositoryEntries;
  try {
    repositoryEntries = readDirectoryEntriesNoFollow(
      safeRoot,
      relativeRoot,
      "action event spool",
      ACTION_EVENT_SPOOL_READ_LIMITS.maxRepositories + 3,
    );
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const budget = createActionEventSpoolReadBudget();
  let repositoryCount = 0;
  for (const repositoryEntry of repositoryEntries) {
    if (
      repositoryEntry.name === "_partitions" ||
      repositoryEntry.name === "_finalizations" ||
      repositoryEntry.name === "_locks"
    ) {
      if (!repositoryEntry.isDirectory()) {
        throw new Error(`refusing unsafe action event spool entry: ${repositoryEntry.name}`);
      }
      continue;
    }
    if (!repositoryEntry.isDirectory()) {
      throw new Error(`refusing unsafe action event spool entry: ${repositoryEntry.name}`);
    }
    repositoryCount += 1;
    if (repositoryCount > ACTION_EVENT_SPOOL_READ_LIMITS.maxRepositories) {
      throw new Error(
        `action event spool exceeds ${ACTION_EVENT_SPOOL_READ_LIMITS.maxRepositories} repository limit`,
      );
    }
    const relativeDirectory = path.join(relativeRoot, repositoryEntry.name);
    const files = readDirectoryEntriesNoFollow(
      safeRoot,
      relativeDirectory,
      "action event spool",
      ACTION_EVENT_SPOOL_READ_LIMITS.maxEntriesPerRepository,
    );
    for (const file of files) {
      if (!file.isFile()) {
        throw new Error(
          `refusing unsafe action event spool entry: ${path.join(relativeDirectory, file.name)}`,
        );
      }
      if (!file.name.endsWith(".json")) continue;
      const relativePath = path.join(relativeDirectory, file.name);
      const event = readActionEventTarget(
        prepareSafeReadTarget(safeRoot, relativePath, "action event spool entry"),
      );
      assertCanonicalSpooledEventPath(event, relativePath);
      retainSpooledActionEvent(budget, event);
    }
  }
  return budget.events.sort(compareEvents);
}

type ActionEventSpoolReadBudget = {
  events: ActionEvent[];
  producerKeys: Set<string>;
  totalBytes: number;
};

function createActionEventSpoolReadBudget(): ActionEventSpoolReadBudget {
  return { events: [], producerKeys: new Set(), totalBytes: 0 };
}

function retainSpooledActionEvent(budget: ActionEventSpoolReadBudget, event: ActionEvent): void {
  if (budget.events.length >= ACTION_EVENT_SPOOL_READ_LIMITS.maxEvents) {
    throw new Error(
      `action event spool exceeds ${ACTION_EVENT_SPOOL_READ_LIMITS.maxEvents} event limit`,
    );
  }
  const eventBytes = Buffer.byteLength(`${actionLedgerJson(event)}\n`, "utf8");
  const nextTotalBytes = budget.totalBytes + eventBytes;
  if (nextTotalBytes > ACTION_EVENT_SPOOL_READ_LIMITS.maxTotalBytes) {
    throw new Error(
      `action event spool exceeds ${ACTION_EVENT_SPOOL_READ_LIMITS.maxTotalBytes} total byte limit`,
    );
  }
  const producerKey = actionLedgerJson(event.producer);
  if (!budget.producerKeys.has(producerKey)) {
    if (budget.producerKeys.size >= ACTION_EVENT_SPOOL_READ_LIMITS.maxProducers) {
      throw new Error(
        `action event spool exceeds ${ACTION_EVENT_SPOOL_READ_LIMITS.maxProducers} producer limit`,
      );
    }
    budget.producerKeys.add(producerKey);
  }
  budget.totalBytes = nextTotalBytes;
  budget.events.push(event);
}

function assertCanonicalSpooledEventPath(
  event: ActionEvent,
  relativePath: string,
  expectedRepository?: string,
): void {
  if (expectedRepository && event.subject.repository !== expectedRepository) {
    throw new Error(
      `action event spool repository mismatch: ${event.subject.repository} != ${expectedRepository}`,
    );
  }
  const canonicalPath = actionEventSpoolRelativePath(event.subject.repository, event.event_id);
  if (path.normalize(relativePath) !== path.normalize(canonicalPath)) {
    throw new Error(`action event spool path is not canonical: ${relativePath}`);
  }
}

function actionEventSemanticValue(input: ActionEventInput) {
  const producerRepository = requiredRepo(input.producer.repository);
  const subjectRepository = requiredRepo(input.subject.repository);
  const value = {
    operation_id: requiredSha256(input.operationId, "action event operation id"),
    attempt_id: requiredSha256(input.attemptId, "action event attempt id"),
    parent_event_id:
      input.parentEventId === undefined || input.parentEventId === null
        ? null
        : requiredSha256(input.parentEventId, "action event parent id"),
    phase_seq: positiveInteger(input.phaseSeq, "action event phase sequence"),
    idempotency_key_sha256: requiredSha256(
      input.idempotencyKeySha256,
      "action event idempotency key",
    ),
    event_type: machineText(input.type, "action event type"),
    producer: {
      repository: producerRepository,
      sha: machineText(input.producer.sha, "action event producer sha"),
      workflow: machineText(input.producer.workflow, "action event producer workflow", 128),
      job: machineText(input.producer.job, "action event producer job", 128),
      run_id: machineText(input.producer.runId, "action event producer run id"),
      run_attempt: positiveInteger(input.producer.runAttempt, "action event producer run attempt"),
      component: machineText(input.producer.component, "action event producer component"),
    },
    subject: normalizeSubject(input.subject, subjectRepository),
    action: normalizeAction(input.action),
    ...(input.learning ? { learning: normalizeLearning(input.learning) } : {}),
    ...(input.evidence?.length
      ? {
          evidence: boundedEvidence(input.evidence).map(normalizeEvidence).sort(compareEvidence),
        }
      : {}),
    ...(input.attributes ? { attributes: normalizeAttributes(input.attributes) } : {}),
    privacy: normalizePrivacy(input.privacy),
  };
  return canonicalJsonValue(value) as Omit<
    ActionEvent,
    | "schema"
    | "schema_version"
    | "event_id"
    | "event_key"
    | "semantic_sha256"
    | "occurred_at"
    | "occurred_at_source"
    | "recorded_at"
  >;
}

function normalizeSubject(subject: ActionEventSubject, repository: string) {
  const kinds = new Set<ActionEventSubject["kind"]>(ACTION_EVENT_SUBJECT_KINDS);
  if (!kinds.has(subject.kind))
    throw new Error(`invalid action event subject kind: ${subject.kind}`);
  const number =
    subject.number === undefined
      ? undefined
      : positiveInteger(subject.number, "action event subject number");
  return {
    repository,
    kind: subject.kind,
    ...(subject.subjectId
      ? {
          subject_id: machineText(subject.subjectId, "action event subject id"),
        }
      : {}),
    ...(number !== undefined ? { number } : {}),
    ...(subject.clusterId
      ? {
          cluster_id: machineText(subject.clusterId, "action event subject cluster id"),
        }
      : {}),
    ...(subject.sourceRevision
      ? {
          source_revision: machineText(
            subject.sourceRevision,
            "action event subject source revision",
          ),
        }
      : {}),
    ...(subject.recordPath
      ? {
          record_path: relativeDataPath(subject.recordPath, "action event subject record path"),
        }
      : {}),
  };
}

function normalizeAction(action: ActionEventAction) {
  return {
    name: machineText(action.name, "action event action name"),
    status: machineText(action.status, "action event action status"),
    ...(action.reasonCode
      ? { reason_code: machineText(action.reasonCode, "action event action reason code") }
      : {}),
    retryable: requiredBoolean(action.retryable, "action event action retryable"),
    mutation: requiredBoolean(action.mutation, "action event action mutation"),
  };
}

function normalizeLearning(learning: ActionEventLearning) {
  if (
    learning.confidence !== undefined &&
    (!Number.isFinite(learning.confidence) || learning.confidence < 0 || learning.confidence > 1)
  ) {
    throw new Error("action event learning confidence must be between 0 and 1");
  }
  return {
    category: machineText(learning.category, "action event learning category"),
    signal: machineText(learning.signal, "action event learning signal"),
    ...(learning.ruleId
      ? { rule_id: machineText(learning.ruleId, "action event learning rule id") }
      : {}),
    ...(learning.confidence !== undefined ? { confidence: learning.confidence } : {}),
  };
}

function normalizeEvidence(evidence: ActionEventEvidence) {
  const digest =
    evidence.sha256 !== undefined
      ? requiredSha256(evidence.sha256, "action event evidence sha256")
      : undefined;
  return {
    kind: machineText(evidence.kind, "action event evidence kind"),
    ...(digest ? { sha256: digest } : {}),
    ...(evidence.reportPath !== undefined
      ? {
          report_path: relativeDataPath(evidence.reportPath, "action event evidence report path"),
        }
      : {}),
    ...(evidence.runUrl !== undefined
      ? { run_url: publicUrl(evidence.runUrl, "action event evidence run URL") }
      : {}),
    ...(evidence.snapshotId !== undefined
      ? {
          snapshot_id: machineText(evidence.snapshotId, "action event evidence snapshot id"),
        }
      : {}),
  };
}

function boundedEvidence(evidence: readonly ActionEventEvidence[]): readonly ActionEventEvidence[] {
  if (evidence.length > MAX_EVENT_COLLECTION_ITEMS) {
    throw new Error(`action event evidence exceeds ${MAX_EVENT_COLLECTION_ITEMS} entries`);
  }
  return evidence;
}

function compareEvidence(
  left: ReturnType<typeof normalizeEvidence>,
  right: ReturnType<typeof normalizeEvidence>,
): number {
  return compareLedgerText(actionLedgerJson(left), actionLedgerJson(right));
}

function normalizeAttributes(attributes: ActionEventAttributes) {
  const normalized: Record<string, ActionEventScalar | ActionEventScalar[]> = {};
  const allowedKeys = new Set<string>(ACTION_EVENT_ATTRIBUTE_KEYS);
  for (const [key, raw] of Object.entries(attributes).sort(([left], [right]) =>
    compareLedgerText(left, right),
  )) {
    const normalizedKey = machineText(key, "action event attribute key");
    if (!allowedKeys.has(normalizedKey)) {
      throw new Error(`action event attribute is not allowlisted: ${normalizedKey}`);
    }
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > MAX_EVENT_COLLECTION_ITEMS) {
      throw new Error(
        `action event attribute ${normalizedKey} exceeds ${MAX_EVENT_COLLECTION_ITEMS} values`,
      );
    }
    const normalizedValues = values.map((value) =>
      normalizeAttributeScalar(normalizedKey as ActionEventAttributeKey, value),
    );
    normalized[normalizedKey] = Array.isArray(raw) ? normalizedValues : normalizedValues[0]!;
  }
  return normalized;
}

function normalizeAttributeScalar(
  key: ActionEventAttributeKey,
  value: ActionEventScalar,
): ActionEventScalar {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`action event attribute ${key} must be a scalar`);
  }
  if (POSITIVE_INTEGER_ATTRIBUTE_KEYS.has(key)) {
    return positiveIntegerValue(value, `action event attribute ${key}`);
  }
  if (NON_NEGATIVE_INTEGER_ATTRIBUTE_KEYS.has(key)) {
    return nonNegativeIntegerValue(value, `action event attribute ${key}`);
  }
  if (BOOLEAN_ATTRIBUTE_KEYS.has(key)) {
    if (typeof value !== "boolean") {
      throw new Error(`action event attribute ${key} must be a boolean`);
    }
    return value;
  }
  if (UNIT_INTERVAL_ATTRIBUTE_KEYS.has(key)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`action event attribute ${key} must be between 0 and 1`);
    }
    return value;
  }
  if (MACHINE_TEXT_ATTRIBUTE_KEYS.has(key)) {
    if (typeof value !== "string") {
      throw new Error(`action event attribute ${key} must be machine-readable text`);
    }
    const normalized = machineText(value, `action event attribute ${key}`);
    if (containsConfidentialIdentifier(normalized)) {
      throw new Error(`action event attribute ${key} contains a confidential identifier`);
    }
    return normalized;
  }
  throw new Error(`action event attribute has no value contract: ${key}`);
}

function normalizePrivacy(privacy: ActionEventPrivacy | undefined) {
  const value = privacy ?? {
    classification: "internal" as const,
    redactionVersion: "v1",
    fieldsDropped: [],
  };
  const classification = String(value.classification);
  if (classification !== "public" && classification !== "internal") {
    throw new Error(`invalid action event privacy classification: ${classification}`);
  }
  if (value.fieldsDropped.length > MAX_EVENT_COLLECTION_ITEMS) {
    throw new Error(
      `action event privacy fieldsDropped exceeds ${MAX_EVENT_COLLECTION_ITEMS} entries`,
    );
  }
  return {
    classification,
    redaction_version: machineText(
      value.redactionVersion,
      "action event privacy redaction version",
    ),
    fields_dropped: [
      ...new Set(value.fieldsDropped.map((field) => machineText(field, "field"))),
    ].sort(compareLedgerText),
  };
}

function normalizeShardEvents(events: readonly ActionEvent[]): ActionEvent[] {
  const byId = new Map<string, ActionEvent>();
  for (const event of events) {
    const validated = validateActionEvent(event, `event:${event.event_id}`);
    const existing = byId.get(validated.event_id);
    if (existing && existing.semantic_sha256 !== validated.semantic_sha256) {
      throw new ActionEventConflictError({
        eventPath: validated.event_id,
        expectedSemanticSha256: existing.semantic_sha256,
        actualSemanticSha256: validated.semantic_sha256,
      });
    }
    if (existing && actionEventReplayJson(existing) !== actionEventReplayJson(validated)) {
      throw new Error(`action event ${validated.event_id} has conflicting duplicate metadata`);
    }
    byId.set(validated.event_id, existing ?? validated);
  }
  return sortActionEventsCausally([...byId.values()]);
}

function assertRawActionEventShardInput(events: readonly ActionEvent[], maxEvents: number): void {
  if (events.length > maxEvents) {
    throw new Error(`action event shard input exceeds ${maxEvents} raw event limit`);
  }
}

function splitActionEventShardEvents(events: readonly ActionEvent[]): ActionEvent[][] {
  const shards: ActionEvent[][] = [];
  let current: ActionEvent[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const eventBytes = Buffer.byteLength(`${actionLedgerJson(event)}\n`, "utf8");
    if (eventBytes > ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes) {
      throw new Error(
        `action event ${event.event_id} exceeds ${ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes} shard byte limit`,
      );
    }
    if (
      current.length > 0 &&
      (current.length >= ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents ||
        currentBytes + eventBytes > ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes)
    ) {
      shards.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += eventBytes;
  }
  if (current.length > 0) shards.push(current);
  return shards;
}

function assertActionEventShardFileLimits(content: string, eventCount: number): void {
  if (eventCount > ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents) {
    throw new Error(
      `action event shard exceeds ${ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents} event limit`,
    );
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes) {
    throw new Error(
      `action event shard exceeds ${ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes} byte limit`,
    );
  }
}

function actionEventShardIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999_999) {
    throw new Error("action event shard index must be an integer between 1 and 999999");
  }
  return value;
}

function normalizeShardIdentity(identity: ActionEventShardIdentity) {
  return {
    repository: requiredRepo(identity.repository),
    sha: machineText(identity.sha, "action event shard producer sha"),
    producer: machineText(identity.producer, "action event shard producer"),
    workflow: machineText(identity.workflow, "action event shard workflow", 128),
    job: machineText(identity.job, "action event shard job", 128),
    runId: machineText(identity.runId, "action event shard run id"),
    runAttempt: positiveInteger(identity.runAttempt, "action event shard run attempt"),
    partitionDate: requiredCalendarDate(
      identity.partitionDate,
      "action event shard partition date",
    ),
  };
}

function validateShardProducer(
  identity: ActionEventShardIdentity,
  events: readonly ActionEvent[],
): void {
  const normalized = normalizeShardIdentity(identity);
  for (const event of events) {
    if (
      event.producer.repository !== normalized.repository ||
      event.producer.sha !== normalized.sha ||
      event.producer.component !== normalized.producer ||
      event.producer.workflow !== normalized.workflow ||
      event.producer.job !== normalized.job ||
      event.producer.run_id !== normalized.runId ||
      event.producer.run_attempt !== normalized.runAttempt
    ) {
      throw new Error(`action event ${event.event_id} does not match shard producer identity`);
    }
  }
}

function compareEvents(left: ActionEvent, right: ActionEvent): number {
  if (left.occurred_at_source === "source" && right.occurred_at_source === "source") {
    return (
      compareActionEventTimestamps(left.occurred_at, right.occurred_at) ||
      compareLedgerText(left.event_id, right.event_id)
    );
  }
  if (left.occurred_at_source !== right.occurred_at_source) {
    return left.occurred_at_source === "source" ? -1 : 1;
  }
  return compareLedgerText(left.event_id, right.event_id);
}

export function sortActionEventsCausally(events: readonly ActionEvent[]): ActionEvent[] {
  const byId = new Map<string, ActionEvent>();
  const childIds = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const event of events) {
    if (byId.has(event.event_id)) {
      throw new Error(`action event shard contains duplicate event: ${event.event_id}`);
    }
    byId.set(event.event_id, event);
    inDegree.set(event.event_id, 0);
  }
  for (const event of events) {
    const parentId = event.parent_event_id;
    if (!parentId || !byId.has(parentId)) continue;
    inDegree.set(event.event_id, (inDegree.get(event.event_id) ?? 0) + 1);
    const children = childIds.get(parentId) ?? [];
    children.push(event.event_id);
    childIds.set(parentId, children);
  }

  const ready: ActionEvent[] = [];
  for (const event of events) {
    if (inDegree.get(event.event_id) === 0) pushReadyEvent(ready, event);
  }
  const sorted: ActionEvent[] = [];
  while (ready.length > 0) {
    const event = popReadyEvent(ready);
    sorted.push(event);
    for (const childId of childIds.get(event.event_id) ?? []) {
      const remaining = (inDegree.get(childId) ?? 0) - 1;
      inDegree.set(childId, remaining);
      if (remaining === 0) pushReadyEvent(ready, byId.get(childId)!);
    }
  }
  if (sorted.length !== events.length) {
    throw new Error("action event shard contains a causal cycle");
  }
  return sorted;
}

function pushReadyEvent(heap: ActionEvent[], event: ActionEvent): void {
  heap.push(event);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareEvents(heap[parent]!, event) <= 0) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = event;
}

function popReadyEvent(heap: ActionEvent[]): ActionEvent {
  const first = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child =
      right < heap.length && compareEvents(heap[right]!, heap[left]!) < 0 ? right : left;
    if (compareEvents(last, heap[child]!) <= 0) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

export function compareActionEventTimestamps(left: string, right: string): number {
  const leftInstant = actionEventTimestampInstant(left);
  const rightInstant = actionEventTimestampInstant(right);
  if (leftInstant.epochSecond !== rightInstant.epochSecond) {
    return leftInstant.epochSecond < rightInstant.epochSecond ? -1 : 1;
  }
  const length = Math.max(leftInstant.fraction.length, rightInstant.fraction.length);
  for (let index = 0; index < length; index += 1) {
    const leftDigit = leftInstant.fraction.charCodeAt(index) || 48;
    const rightDigit = rightInstant.fraction.charCodeAt(index) || 48;
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
}

function actionEventTimestampInstant(value: string): {
  epochSecond: bigint;
  fraction: string;
} {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match) throw new Error(`invalid action event timestamp: ${value}`);
  const epochMilliseconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(epochMilliseconds)) {
    throw new Error(`invalid action event timestamp: ${value}`);
  }
  return {
    epochSecond: BigInt(epochMilliseconds / 1000),
    fraction: match[2] ?? "",
  };
}

function compareExistingActionEvent(
  eventPath: string,
  relativePath: string,
  existing: ActionEvent,
  candidate: ActionEvent,
): ActionEventWriteResult {
  if (actionEventReplayJson(existing) === actionEventReplayJson(candidate)) {
    return { status: "unchanged", event: existing, path: eventPath, relativePath };
  }
  throw new ActionEventConflictError({
    eventPath,
    expectedSemanticSha256: existing.semantic_sha256,
    actualSemanticSha256: candidate.semantic_sha256,
  });
}

function compareExistingShard(
  shardPath: string,
  relativePath: string,
  existing: string,
  candidateSha256: string,
  candidateEvents: readonly ActionEvent[],
): ActionEventShardWriteResult {
  const existingSha256 = sha256(existing);
  if (existingSha256 !== candidateSha256) {
    if (!actionEventShardContentReplayEquivalent(existing, candidateEvents, shardPath)) {
      throw new ActionEventShardConflictError({
        shardPath,
        expectedSha256: existingSha256,
        actualSha256: candidateSha256,
      });
    }
  }
  return {
    status: "unchanged",
    path: shardPath,
    relativePath,
    sha256: existingSha256,
    eventCount: candidateEvents.length,
  };
}

export function actionEventReplayJson(event: ActionEvent): string {
  if (event.occurred_at_source === "generated") {
    const { occurred_at: _occurredAt, recorded_at: _recordedAt, ...generatedReplayValue } = event;
    return actionLedgerJson(generatedReplayValue);
  }
  const { recorded_at: _recordedAt, ...replayValue } = event;
  return actionLedgerJson(replayValue);
}

function actionEventSemanticSha256(
  semantic: ReturnType<typeof actionEventSemanticValue>,
  occurredAt: string,
  occurredAtSource: ActionEventOccurrenceSource,
): string {
  const occurrence =
    occurredAtSource === "source"
      ? { occurred_at: occurredAt, occurred_at_source: occurredAtSource }
      : { occurred_at_source: occurredAtSource };
  return sha256(actionLedgerJson({ occurrence, semantic }));
}

export function actionEventShardsReplayEquivalent(
  left: readonly ActionEvent[],
  right: readonly ActionEvent[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (event, index) => actionEventReplayJson(event) === actionEventReplayJson(right[index]!),
    )
  );
}

export function actionEventShardContentReplayEquivalent(
  content: string,
  events: readonly ActionEvent[],
  filePath = "action event shard",
): boolean {
  const parsed = parseActionEventShardContent(content, filePath);
  const canonical = `${parsed.map((event) => actionLedgerJson(event)).join("\n")}\n`;
  if (content !== canonical) {
    throw new Error(`action event shard content is not canonical: ${filePath}`);
  }
  return actionEventShardsReplayEquivalent(parsed, events);
}

export function parseActionEventShardContent(content: string, filePath: string): ActionEvent[] {
  if (content.length === 0) return [];
  if (!content.endsWith("\n")) {
    throw new Error(`action event shard must end with a newline: ${filePath}`);
  }
  const lines = content.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0 || line.endsWith("\r"))) {
    throw new Error(`action event shard content is not canonical: ${filePath}`);
  }
  return lines.map((line, index) =>
    parseCanonicalActionEventJson(line, `${filePath}:${index + 1}`),
  );
}

function validateDirectActionEventShard(events: readonly ActionEvent[], filePath: string): void {
  if (events.length === 0) {
    throw new Error(`action event shard requires events: ${filePath}`);
  }
  if (events.length > ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents) {
    throw new Error(
      `action event shard exceeds ${ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents} event limit: ${filePath}`,
    );
  }
  const ordered = sortActionEventsCausally(events);
  if (ordered.some((event, index) => event.event_id !== events[index]?.event_id)) {
    throw new Error(`action event shard events are not in canonical causal order: ${filePath}`);
  }
}

function readActionEventTarget(target: SafeWriteTarget): ActionEvent {
  return parseCanonicalActionEventFile(
    readUtf8FileNoFollow(target, ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes),
    target.path,
  );
}

function readActionEventIfExists(target: SafeWriteTarget): ActionEvent | null {
  const content = readUtf8FileIfExistsNoFollow(
    target,
    ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes,
  );
  return content === null ? null : parseCanonicalActionEventFile(content, target.path);
}

function parseCanonicalActionEventFile(content: string, source: string): ActionEvent {
  if (
    !content.endsWith("\n") ||
    content.slice(0, -1).includes("\n") ||
    content.slice(0, -1).endsWith("\r")
  ) {
    throw new Error(`action event file content is not canonical: ${source}`);
  }
  return parseCanonicalActionEventJson(content.slice(0, -1), source);
}

function parseCanonicalActionEventJson(content: string, source: string): ActionEvent {
  assertNoDuplicateJsonObjectKeys(content, source);
  const event = validateActionEvent(JSON.parse(content) as unknown, source);
  if (actionLedgerJson(event) !== content) {
    throw new Error(`action event JSON is not canonical: ${source}`);
  }
  return event;
}

function assertNoDuplicateJsonObjectKeys(content: string, source: string): void {
  let index = 0;
  let nodes = 0;
  const numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

  const fail = (): never => {
    throw new Error(`invalid action event JSON: ${source}`);
  };
  const skipWhitespace = (): void => {
    while (index < content.length && /[\t\n\r ]/.test(content[index]!)) index += 1;
  };
  const parseString = (): string => {
    if (content[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < content.length) {
      const character = content[index]!;
      index += 1;
      if (character === '"') {
        try {
          const value = JSON.parse(content.slice(start, index)) as unknown;
          if (typeof value !== "string") fail();
          return value as string;
        } catch {
          fail();
        }
      }
      if (character === "\\") {
        if (index >= content.length) fail();
        index += 1;
      } else if (character.charCodeAt(0) < 0x20) {
        fail();
      }
    }
    return fail();
  };
  const parseValue = (depth: number): void => {
    nodes += 1;
    if (
      nodes > ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxNodes ||
      depth > ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxDepth
    ) {
      throw new Error(`action event JSON exceeds canonical complexity limits: ${source}`);
    }
    skipWhitespace();
    const character = content[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (content[index] === "}") {
        index += 1;
        return;
      }
      while (index < content.length) {
        const key = parseString();
        if (keys.has(key)) {
          throw new Error(`action event JSON contains a duplicate object key: ${source}`);
        }
        keys.add(key);
        skipWhitespace();
        if (content[index] !== ":") fail();
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (content[index] === "}") {
          index += 1;
          return;
        }
        if (content[index] !== ",") fail();
        index += 1;
        skipWhitespace();
      }
      fail();
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (content[index] === "]") {
        index += 1;
        return;
      }
      while (index < content.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (content[index] === "]") {
          index += 1;
          return;
        }
        if (content[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (character === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (content.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    numberPattern.lastIndex = index;
    const match = numberPattern.exec(content);
    if (!match) fail();
    index = numberPattern.lastIndex;
  };

  parseValue(0);
  skipWhitespace();
  if (index !== content.length) fail();
}

export function validateActionEvent(value: unknown, source = "action event"): ActionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid action event object: ${source}`);
  }
  const event = value as Partial<ActionEvent>;
  if (
    event.schema !== ACTION_EVENT_SCHEMA ||
    event.schema_version !== 1 ||
    typeof event.event_id !== "string" ||
    typeof event.event_key !== "string" ||
    typeof event.operation_id !== "string" ||
    typeof event.attempt_id !== "string" ||
    (event.parent_event_id !== null && typeof event.parent_event_id !== "string") ||
    typeof event.phase_seq !== "number" ||
    typeof event.idempotency_key_sha256 !== "string" ||
    typeof event.semantic_sha256 !== "string" ||
    typeof event.occurred_at_source !== "string" ||
    !event.producer ||
    !event.subject ||
    !event.action ||
    !event.privacy
  ) {
    throw new Error(`invalid action event schema: ${source}`);
  }
  if (event.parent_event_id === event.event_id) {
    throw new Error(`action event cannot reference itself as its parent: ${source}`);
  }
  const semantic = actionEventSemanticValue({
    eventKey: event.event_key,
    operationId: event.operation_id,
    attemptId: event.attempt_id,
    parentEventId: event.parent_event_id,
    phaseSeq: event.phase_seq,
    idempotencyKeySha256: event.idempotency_key_sha256,
    type: String(event.event_type ?? ""),
    producer: {
      repository: String(event.producer.repository ?? ""),
      sha: String(event.producer.sha ?? ""),
      workflow: String(event.producer.workflow ?? ""),
      job: String(event.producer.job ?? ""),
      runId: String(event.producer.run_id ?? ""),
      runAttempt: Number(event.producer.run_attempt ?? 0),
      component: String(event.producer.component ?? ""),
    },
    subject: {
      repository: String(event.subject.repository ?? ""),
      kind: event.subject.kind,
      ...(event.subject.subject_id ? { subjectId: event.subject.subject_id } : {}),
      ...(event.subject.number !== undefined ? { number: event.subject.number } : {}),
      ...(event.subject.cluster_id ? { clusterId: event.subject.cluster_id } : {}),
      ...(event.subject.source_revision ? { sourceRevision: event.subject.source_revision } : {}),
      ...(event.subject.record_path ? { recordPath: event.subject.record_path } : {}),
    },
    action: {
      name: String(event.action.name ?? ""),
      status: String(event.action.status ?? ""),
      ...(event.action.reason_code ? { reasonCode: event.action.reason_code } : {}),
      retryable: event.action.retryable,
      mutation: event.action.mutation,
    },
    ...(event.learning
      ? {
          learning: {
            category: String(event.learning.category ?? ""),
            signal: String(event.learning.signal ?? ""),
            ...(event.learning.rule_id ? { ruleId: event.learning.rule_id } : {}),
            ...(event.learning.confidence !== undefined
              ? { confidence: event.learning.confidence }
              : {}),
          },
        }
      : {}),
    ...(event.evidence
      ? {
          evidence: event.evidence.map((entry) => ({
            kind: entry.kind,
            ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
            ...(entry.report_path !== undefined ? { reportPath: entry.report_path } : {}),
            ...(entry.run_url !== undefined ? { runUrl: entry.run_url } : {}),
            ...(entry.snapshot_id !== undefined ? { snapshotId: entry.snapshot_id } : {}),
          })),
        }
      : {}),
    ...(event.attributes ? { attributes: event.attributes } : {}),
    privacy: {
      classification: event.privacy.classification,
      redactionVersion: event.privacy.redaction_version,
      fieldsDropped: event.privacy.fields_dropped,
    },
  });
  if (actionEventId(semantic.subject.repository, event.event_key) !== event.event_id) {
    throw new Error(`invalid action event identity: ${source}`);
  }
  const occurredAt = requiredTimestamp(String(event.occurred_at ?? ""), "action event occurred_at");
  const occurredAtSource = requiredOccurrenceSource(event.occurred_at_source);
  if (actionEventSemanticSha256(semantic, occurredAt, occurredAtSource) !== event.semantic_sha256) {
    throw new Error(`invalid action event semantic digest: ${source}`);
  }
  const canonical = canonicalJsonValue({
    schema: ACTION_EVENT_SCHEMA,
    schema_version: 1,
    event_id: event.event_id,
    event_key: event.event_key,
    semantic_sha256: event.semantic_sha256,
    occurred_at: occurredAt,
    occurred_at_source: occurredAtSource,
    recorded_at: requiredTimestamp(String(event.recorded_at ?? ""), "action event recorded_at"),
    ...semantic,
  }) as ActionEvent;
  if (actionLedgerJson(canonical) !== actionLedgerJson(value)) {
    throw new Error(`action event contains unknown or non-canonical fields: ${source}`);
  }
  return canonical;
}

function writeCreateOnlyFile(
  destination: SafeWriteTarget,
  content: string,
  handleRace: () => void,
): "created" | "unchanged" {
  const status = writeUtf8FileCreateOnlyNoFollow(destination, content);
  if (status === "created") return "created";
  handleRace();
  return "unchanged";
}

function relativeDataPath(value: string, label: string): string {
  const raw = boundedText(value, label, 512);
  const normalized = raw.replace(/^\.\//, "");
  if (!RELATIVE_DATA_PATH_PATTERN.test(normalized)) {
    throw new Error(
      `${label} must be a namespaced repository-relative data path using portable segments`,
    );
  }
  if (containsConfidentialIdentifier(normalized)) {
    throw new Error(`${label} contains a confidential identifier`);
  }
  return normalized;
}

function publicUrl(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (normalized.includes("?") || normalized.includes("#")) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  const parsed = new URL(normalized);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  if (
    parsed.hostname !== "github.com" ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/.test(parsed.pathname)
  ) {
    throw new Error(`${label} must identify a public github.com Actions run`);
  }
  return parsed.toString();
}

function requiredRepo(value: string): string {
  const repository = normalizeRepo(requiredText(value, "action event repository"));
  if (!/^[a-z0-9_][a-z0-9_.-]*\/[a-z0-9_][a-z0-9_.-]*$/.test(repository)) {
    throw new Error(`invalid action event repository: ${value}`);
  }
  return repository;
}

function machineText(value: string, label: string, maxLength = 256): string {
  const normalized = boundedText(value, label, maxLength);
  if (containsConfidentialIdentifier(normalized)) {
    throw new Error(`${label} contains a confidential identifier`);
  }
  if (!MACHINE_TEXT_PATTERN.test(normalized)) {
    throw new Error(`${label} must be machine-readable text`);
  }
  return normalized;
}

function eventScope(value: string): string {
  const normalized = boundedText(value, "action event scope", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(normalized)) {
    throw new Error("action event scope must be machine-readable text");
  }
  if (containsConfidentialIdentifier(normalized)) {
    throw new Error("action event scope contains a confidential identifier");
  }
  return normalized;
}

function requiredEventKey(value: string): string {
  const normalized = boundedText(value, "action event key", 193);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}:[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("action event key must be generated from a machine-readable scope and digest");
  }
  eventScope(normalized.slice(0, normalized.indexOf(":")));
  return normalized;
}

function requiredOccurrenceSource(value: string): ActionEventOccurrenceSource {
  if (value !== "source" && value !== "generated") {
    throw new Error("action event occurred_at_source must be source or generated");
  }
  return value;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code <= 31 || code === 127) {
      throw new Error(`${label} contains control characters`);
    }
  }
  return normalized;
}

function boundedText(value: string, label: string, maxLength: number): string {
  const normalized = requiredText(value, label);
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function requiredTimestamp(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (!TIMESTAMP_PATTERN.test(normalized)) {
    throw new Error(`${label} must be an ISO date-time timestamp`);
  }
  const match =
    /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(Z|[+-]([0-9]{2}):([0-9]{2}))$/.exec(
      normalized,
    );
  if (!match) throw new Error(`${label} must be an ISO date-time timestamp`);
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHour,
    offsetMinute,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendar = strictUtcCalendarDate(year, month, day);
  const validCalendar =
    year >= 1 &&
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day;
  const validClock =
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (offsetHour === undefined || Number(offsetHour) <= 23) &&
    (offsetMinute === undefined || Number(offsetMinute) <= 59);
  if (!validCalendar || !validClock || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label} must be an ISO date-time timestamp`);
  }
  return normalized;
}

function requiredCalendarDate(value: string, label: string): string {
  const normalized = requiredText(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw new Error(`${label} must be an ISO calendar date`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const calendar = strictUtcCalendarDate(year, month, day);
  if (
    year < 1 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be an ISO calendar date`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function positiveIntegerValue(value: ActionEventScalar, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a positive integer`);
  return positiveInteger(value, label);
}

function nonNegativeIntegerValue(value: ActionEventScalar, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requiredSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return !safe || safe === "." || safe === ".." ? "unknown" : safe;
}

function boundedPathSegment(value: string, maxLength: number): string {
  let safe = safePathSegment(value);
  const reservedDevice = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe);
  const trailingDot = safe.endsWith(".");
  if (!reservedDevice && !trailingDot && safe.length <= maxLength) return safe;
  const digest = sha256(value).slice(0, 12);
  if (reservedDevice) safe = `_${safe}`;
  if (trailingDot) safe = safe.replace(/\.+$/, "");
  return `${safe.slice(0, maxLength - digest.length - 1)}-${digest}`;
}

function canonicalIdentityJson(value: unknown): string {
  return serializeCanonicalJson(canonicalJsonValue(value, true));
}

function canonicalJsonValue(value: unknown, rejectCredentialFields = false): unknown {
  validateCanonicalJsonComplexity(value);
  return canonicalizeJsonValue(value, new Set<object>(), "$", rejectCredentialFields);
}

function canonicalizeJsonValue(
  value: unknown,
  ancestors: Set<object>,
  location: string,
  rejectCredentialFields: boolean,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new Error(`action event data contains a lossy number at ${location}`);
    }
    return value;
  }
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new Error(`action event data contains a non-JSON value at ${location}`);
  }
  if (ancestors.has(value)) {
    throw new Error(`action event data contains a cycle at ${location}`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`action event data contains an array class instance at ${location}`);
      }
      const ownKeys = Reflect.ownKeys(value);
      const expectedKeys = new Set([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ]);
      if (
        ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) ||
        ownKeys.length !== expectedKeys.size
      ) {
        throw new Error(`action event data contains a sparse or decorated array at ${location}`);
      }
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error(`action event data contains a non-data array item at ${location}`);
        }
        return canonicalizeJsonValue(
          descriptor.value,
          ancestors,
          `${location}[${index}]`,
          rejectCredentialFields,
        );
      });
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`action event data contains a class instance at ${location}`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new Error(`action event data contains a symbol key at ${location}`);
    }
    for (const key of ownKeys as string[]) {
      if (hasUnpairedSurrogate(key)) {
        throw new Error(`action event data contains an unsupported object key at ${location}`);
      }
    }
    const normalized: Record<string, unknown> = {};
    for (const key of (ownKeys as string[]).sort(compareCanonicalKeys)) {
      if (rejectCredentialFields && highRiskCredentialField(key)) {
        throw new Error(
          `action event identity contains a high-risk credential field at ${location}`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`action event data contains a non-data property at ${location}.${key}`);
      }
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: canonicalizeJsonValue(
          descriptor.value,
          ancestors,
          `${location}.${key}`,
          rejectCredentialFields,
        ),
        writable: true,
      });
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function validateCanonicalJsonComplexity(root: unknown): void {
  type Frame =
    | { kind: "value"; value: unknown; location: string; depth: number }
    | { kind: "exit"; value: object };

  const stack: Frame[] = [{ kind: "value", value: root, location: "$", depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;

  const addBytes = (amount: number, location: string): void => {
    bytes += amount;
    if (bytes > ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes) {
      throw new Error(
        `action event data exceeds canonical JSON size limit ${ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes} bytes at ${location}`,
      );
    }
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "exit") {
      ancestors.delete(frame.value);
      continue;
    }

    nodes += 1;
    if (nodes > ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxNodes) {
      throw new Error(
        `action event data exceeds canonical JSON node limit ${ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxNodes} at ${frame.location}`,
      );
    }
    if (frame.depth > ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxDepth) {
      throw new Error(
        `action event data exceeds canonical JSON depth limit ${ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxDepth} at ${frame.location}`,
      );
    }

    const value = frame.value;
    if (value === null) {
      addBytes(4, frame.location);
      continue;
    }
    if (typeof value === "string") {
      addBytes(Buffer.byteLength(JSON.stringify(value), "utf8"), frame.location);
      continue;
    }
    if (typeof value === "number") {
      addBytes(24, frame.location);
      continue;
    }
    if (typeof value === "boolean") {
      addBytes(5, frame.location);
      continue;
    }
    if (!value || typeof value !== "object") {
      addBytes(8, frame.location);
      continue;
    }
    if (ancestors.has(value)) {
      continue;
    }

    ancestors.add(value);
    stack.push({ kind: "exit", value });
    addBytes(2, frame.location);

    if (Array.isArray(value)) {
      if (value.length > 0) addBytes(value.length - 1, frame.location);
      if (nodes + value.length > ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxNodes) {
        throw new Error(
          `action event data exceeds canonical JSON node limit ${ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxNodes} at ${frame.location}`,
        );
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor && "value" in descriptor) {
          stack.push({
            kind: "value",
            value: descriptor.value,
            location: `${frame.location}[${index}]`,
            depth: frame.depth + 1,
          });
        }
      }
      continue;
    }

    const ownKeys = Reflect.ownKeys(value);
    if (nodes + ownKeys.length > ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxNodes) {
      throw new Error(
        `action event data exceeds canonical JSON node limit ${ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxNodes} at ${frame.location}`,
      );
    }
    for (let index = ownKeys.length - 1; index >= 0; index -= 1) {
      const key = ownKeys[index];
      if (typeof key !== "string") continue;
      addBytes(Buffer.byteLength(JSON.stringify(key), "utf8") + 2, `${frame.location}.${key}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) {
        stack.push({
          kind: "value",
          value: descriptor.value,
          location: `${frame.location}.${key}`,
          depth: frame.depth + 1,
        });
      }
    }
  }
}

function compareCanonicalKeys(left: string, right: string): number {
  return compareLedgerText(left, right);
}

function compareLedgerText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function serializeCanonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value)!;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeCanonicalJson(entry)).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    throw new Error("action event data contains a non-JSON value");
  }
  const entries = Object.keys(value)
    .sort(compareCanonicalKeys)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeCanonicalJson((value as Record<string, unknown>)[key])}`,
    );
  return `{${entries.join(",")}}`;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function strictUtcCalendarDate(year: number, month: number, day: number): Date {
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  return calendar;
}

function highRiskCredentialField(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (
    HIGH_RISK_CREDENTIAL_FIELD_NAMES.has(normalized) ||
    /(?:authorization(?:header)?|authheader|bearertoken|credential|credentials|password|passwd|privatekey|secret|token)$/.test(
      normalized,
    )
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function containsConfidentialIdentifier(value: string): boolean {
  if (CONFIDENTIAL_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }
  if (privateUrl(value)) return true;
  if (privateHost(value)) return true;
  const privateAddressCandidates = [
    ...(value.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []),
    ...(value.match(/\[[0-9a-f:]+\]/gi) ?? []),
  ];
  if (privateAddressCandidates.some(privateHost)) return true;
  const embeddedUrls = value.match(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g) ?? [];
  return embeddedUrls.some(privateUrl);
}

function privateUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(
      parsed.protocol === "file:" ||
      parsed.username ||
      parsed.password ||
      privateHost(parsed.hostname),
    );
  } catch {
    return false;
  }
}

function privateHost(value: string): boolean {
  let host = value
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (!host) return false;
  if (isIP(host) === 6) {
    const normalized = new URL(`http://[${host}]/`).hostname;
    host = normalized.slice(1, -1);
  }
  if (
    host === "localhost" ||
    [".local", ".localhost", ".internal", ".corp", ".lan", ".home", ".home.arpa"].some((suffix) =>
      host.endsWith(suffix),
    ) ||
    (/^(?:internal|intranet)\./.test(host) && host.includes("."))
  ) {
    return true;
  }
  if (host === "::1" || /^(?:fc|fd)[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    const embedded = [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff].join(".");
    if (privateHost(embedded)) return true;
  }
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31)
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
