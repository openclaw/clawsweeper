export type {
  HydratedWorkspaceItem,
  LinearAttachment,
  LinearConnection,
  LinearCreator,
  LinearIssue,
  LinearLabel,
  LinearPageInfo,
  LinearProject,
  LinearTeam,
  ListIssuesOptions,
  WorkspaceItem,
  WorkspaceSweepOptions,
} from "./types.js";

export {
  LinearRequestError,
  linearRetryKind,
  linearRetryWaitMs,
  shouldRetryLinear,
} from "./retry.js";
export type { LinearRetryKind } from "./retry.js";

export {
  ISSUE_BY_IDENTIFIER_QUERY,
  ISSUE_LABEL_CREATE_MUTATION,
  ISSUE_LABELS_QUERY,
  ISSUE_SET_LABELS_MUTATION,
  ISSUES_QUERY,
  PROJECTS_QUERY,
  TEAMS_QUERY,
} from "./queries.js";

export { createLinearTransport, resolveLinearToken } from "./client.js";
export type { LinearTransport, LinearTransportOptions, ResolveTokenOptions } from "./client.js";

export { LinearItemSource, parseLinearIdentifier } from "./source.js";
export type { ParsedIdentifier } from "./source.js";

export type {
  ExtractOptions,
  MatchedProject,
  ScopeResolution,
  ScopeSource,
  ScopeSpec,
} from "./scope.js";

export {
  canonicalizeIdentifiers,
  chooseScope,
  DEFAULT_ID_FIELDS,
  DEFAULT_LIST_FIELDS,
  extractIdentifiers,
  matchIdentifier,
  resolveScope,
} from "./scope.js";

export type {
  ItemCategory,
  LinearRecordValidationIssue,
  LinearReviewRecord,
  LinearSourceProvider,
  TrackerItemState,
  TriagePriority,
} from "./record.js";

export {
  assertLinearReviewRecord,
  inferItemCategory,
  isStaleIssue,
  LINEAR_SOURCE_PROVIDER,
  linearReviewMarker,
  linearReviewSnapshotHash,
  linearWorkspaceSlug,
  mapLinearPriority,
  mapLinearState,
  mapWorkspaceItem,
  validateLinearReviewRecord,
} from "./record.js";

export type {
  ClassifierOptions,
  CloseCandidateReason,
  LinearClassification,
  ReviewDisposition,
} from "./classifier.js";

export { classifyRecord, classifyRecords, proposesClose } from "./classifier.js";

export type {
  CloseConfidence,
  CloseDecision,
  CloseEvidence,
  CloseReason,
  DriftFingerprint,
  LabelChange,
  MutationAuthorization,
  MutationGates,
  MutationKind,
  MutationReceipt,
  MutationRequest,
} from "./authority.js";

export {
  authorizeMutation,
  authorizeMutations,
  buildMutationReceipt,
  EVIDENCE_CLOSE_REASONS,
  gateForKind,
  mergeLabels,
  resolveGates,
  REVIEW_ONLY_GATES,
} from "./authority.js";

export type { PolicyDecision, PolicySignals, ReviewPolicyRule } from "./policy.js";

export {
  buildPolicySignals,
  DEFAULT_REVIEW_POLICY,
  evaluateReviewPolicy,
  isProtectedActionLabel,
  isReviewRoutingLabel,
  LABEL_HUMAN_REVIEW,
  LABEL_LINKED_PR_OPEN,
  LABEL_NEEDS_INFO,
  LABEL_NEEDS_MAINTAINER_REVIEW,
  LABEL_NEEDS_PRODUCT_DECISION,
  LABEL_NOT_REPRO_ON_MAIN,
  nextReviewLabels,
  PROTECTED_ACTION_LABELS,
  REVIEW_ROUTING_LABELS,
} from "./policy.js";

export type {
  LinearComment,
  ReviewCommentAction,
  ReviewCommentPlan,
  ReviewCommentUpsertInput,
} from "./comment.js";

export {
  COMMENT_CREATE_MUTATION,
  COMMENT_UPDATE_MUTATION,
  findReviewComments,
  hasReviewMarker,
  planReviewCommentUpsert,
  renderReviewCommentBody,
  reviewCommentMutationRequest,
} from "./comment.js";

export type {
  CronTriggerOptions,
  CronTriggerSpec,
  OnDemandHandle,
  RunExpectations,
  RunOutcome,
  RunSentinel,
  RunSentinels,
  RunVerdict,
} from "./trigger.js";

export type {
  AnalyzerDecision,
  AnalyzerEvidence,
  AnalyzerFingerprintInput,
  AnalyzerRecordFrontMatter,
  CloseLeaning,
  CloseLeaningInput,
  ShaVerificationResult,
  ShaVerifier,
} from "./analyzer.js";

export {
  ANALYZER_INTERNAL_MODEL,
  ANALYZER_VERSION,
  analyzerFingerprint,
  citedShas,
  deriveCloseLeaning,
  needsReanalysis,
  renderAnalyzerSections,
  serializeAnalyzerRecord,
  verifyEvidenceShas,
} from "./analyzer.js";

export type {
  FallbackOwnerRule,
  RepoCatalog,
  RepoCatalogEntry,
  RepoInference,
  RepoInferenceItem,
} from "./repo-infer.js";

export { buildRepoCatalog, inferTargetRepo, ownerRepoFromUrls } from "./repo-infer.js";

export {
  DEFAULT_MAX_RUN_AGE_MS,
  DEFAULT_SEMANTIC_FAILURE_PATTERNS,
  detectSentinel,
  evaluateRunExpectations,
  HUB_CLAWSWEEPER_ROOT,
  HUB_USER,
  onDemandTriggerHandle,
  SNAPSHOT_SCRIPT_REL,
  TRIAGE_ALERT_SENTINEL,
  TRIAGE_OK_SENTINEL,
  TRIAGE_SCRIPT_REL,
  triageRunExpectations,
  weeklyTriageCronSpec,
  WEEKLY_TRIAGE_CRON,
  WEEKLY_TRIAGE_TZ,
} from "./trigger.js";
