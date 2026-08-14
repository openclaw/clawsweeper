export const GITHUB_EGRESS_TELEMETRY_VERSION = 2 as const;

export const GITHUB_EGRESS_POOL_CLASSES = [
  "repository_actions",
  "target_app",
  "public_read_fallback",
  "other",
] as const;
export type GitHubEgressPoolClass = (typeof GITHUB_EGRESS_POOL_CLASSES)[number];

export const GITHUB_EGRESS_STAGES = [
  "publication_prepare",
  "publication_apply",
  "publication_router",
  "publication_recovery",
  "unknown",
] as const;
export type GitHubEgressStage = (typeof GITHUB_EGRESS_STAGES)[number];

export const GITHUB_EGRESS_SOURCE_ACTIONS = [
  "exact_event",
  "command",
  "scheduled_hot",
  "scheduled_normal",
  "repair",
  "publication_retry",
  "unknown",
] as const;
export type GitHubEgressSourceAction = (typeof GITHUB_EGRESS_SOURCE_ACTIONS)[number];

export const GITHUB_EGRESS_OPERATIONS = [
  "artifact_download",
  "item_metadata",
  "comments",
  "reviews",
  "labels",
  "reactions",
  "checks",
  "contents",
  "authorization",
  "graphql",
  "workflow_dispatch",
  "rate_status",
  "other",
] as const;
export type GitHubEgressOperation = (typeof GITHUB_EGRESS_OPERATIONS)[number];

export const GITHUB_EGRESS_METHODS = [
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
  "HEAD",
  "UNKNOWN",
] as const;
export type GitHubEgressMethod = (typeof GITHUB_EGRESS_METHODS)[number];

export const GITHUB_EGRESS_ROUTE_TEMPLATES = [
  "actions_artifact_archive",
  "actions_runs",
  "actions_run_jobs",
  "actions_run_artifacts",
  "actions_workflow_dispatch",
  "authenticated_user",
  "collaborator_permission",
  "commit_check_runs",
  "commit_metadata",
  "commit_pulls",
  "commit_status",
  "commits_collection",
  "external_artifact_blob",
  "graphql",
  "issue_comments",
  "issue_comment",
  "issue_labels",
  "issue_metadata",
  "issue_reactions",
  "issue_timeline",
  "issues_collection",
  "multiple",
  "pull_comments",
  "pull_commits",
  "pull_files",
  "pull_metadata",
  "pull_reviews",
  "rate_limit",
  "repository_contents",
  "repository_labels",
  "repository_metadata",
  "search_issues",
  "unknown",
] as const;
export type GitHubEgressRouteTemplate = (typeof GITHUB_EGRESS_ROUTE_TEMPLATES)[number];

export const GITHUB_EGRESS_PAGE_BUCKETS = [
  "none",
  "1",
  "2",
  "3_5",
  "6_10",
  "11_plus",
  "unknown",
] as const;
export type GitHubEgressPageBucket = (typeof GITHUB_EGRESS_PAGE_BUCKETS)[number];

export const GITHUB_EGRESS_UNITS = [
  "invocation",
  "wire_attempt",
  "member",
  "broker_lookup",
  "conditional_response",
] as const;
export type GitHubEgressUnit = (typeof GITHUB_EGRESS_UNITS)[number];

export const GITHUB_EGRESS_OUTCOMES = [
  "attempted",
  "success",
  "throttle",
  "transient",
  "error",
  "ambiguous",
  "pre_wire_failure",
  "legacy_avoided",
  "cache_hit",
  "cache_miss",
  "cache_skip",
  "cache_200_stored",
  "cache_304_served",
] as const;
export type GitHubEgressOutcome = (typeof GITHUB_EGRESS_OUTCOMES)[number];

export const GITHUB_EGRESS_STATUS_BUCKETS = [
  "none",
  "2xx",
  "3xx",
  "403",
  "429",
  "4xx_other",
  "5xx",
  "other",
] as const;
export type GitHubEgressStatusBucket = (typeof GITHUB_EGRESS_STATUS_BUCKETS)[number];

export const GITHUB_EGRESS_LATENCY_BUCKETS = [
  "unknown",
  "lt_100ms",
  "100_249ms",
  "250_499ms",
  "500_999ms",
  "1_2s",
  "2_5s",
  "5s_plus",
] as const;
export type GitHubEgressLatencyBucket = (typeof GITHUB_EGRESS_LATENCY_BUCKETS)[number];

export const GITHUB_EGRESS_CLAIM_GENERATION_BUCKETS = [
  "none",
  "1",
  "2",
  "3_5",
  "6_10",
  "11_32",
  "33_plus",
  "unknown",
] as const;
export type GitHubEgressClaimGenerationBucket =
  (typeof GITHUB_EGRESS_CLAIM_GENERATION_BUCKETS)[number];

export type GitHubEgressMetricV2 = {
  version: typeof GITHUB_EGRESS_TELEMETRY_VERSION;
  bucketStart: string;
  deploymentRevision: string;
  configRevision: string;
  poolClass: GitHubEgressPoolClass;
  poolIdentity: string;
  stage: GitHubEgressStage;
  sourceAction: GitHubEgressSourceAction;
  operation: GitHubEgressOperation;
  method: GitHubEgressMethod;
  routeTemplate: GitHubEgressRouteTemplate;
  pageBucket: GitHubEgressPageBucket;
  unit: GitHubEgressUnit;
  outcome: GitHubEgressOutcome;
  statusBucket: GitHubEgressStatusBucket;
  latencyBucket: GitHubEgressLatencyBucket;
  claimGenerationBucket: GitHubEgressClaimGenerationBucket;
  firstRepeat: "first" | "repeat" | "unknown";
  attempted: boolean;
  telemetryComplete: boolean;
  count: number;
};

export type GitHubRateLimitHeadersV2 = {
  retryAfterPresent: boolean;
  retryAfterSeconds: number | null;
  limitPresent: boolean;
  limit: number | null;
  remainingPresent: boolean;
  remaining: number | null;
  usedPresent: boolean;
  used: number | null;
  resetPresent: boolean;
  resetEpochSeconds: number | null;
  resourcePresent: boolean;
  resource: "core" | "graphql" | "search" | "integration_manifest" | "unknown" | null;
};

export type GitHubRateLimitObservationV2 = {
  version: typeof GITHUB_EGRESS_TELEMETRY_VERSION;
  observedAt: string;
  deploymentRevision: string;
  configRevision: string;
  poolClass: GitHubEgressPoolClass;
  poolIdentity: string;
  stage: GitHubEgressStage;
  sourceAction: GitHubEgressSourceAction;
  operation: GitHubEgressOperation;
  method: GitHubEgressMethod;
  routeTemplate: GitHubEgressRouteTemplate;
  pageBucket: GitHubEgressPageBucket;
  status: 403 | 429;
  headers: GitHubRateLimitHeadersV2;
  resetAuthorityCandidate: "retry_after" | "rate_limit_reset" | "absent" | "invalid";
  telemetryComplete: boolean;
};

export function githubEgressSourceAction(value: string | undefined): GitHubEgressSourceAction {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "scheduled_hot_intake") return "scheduled_hot";
  if (normalized === "scheduled_normal_backfill") return "scheduled_normal";
  if (
    normalized === "failed_review_shard_recovery" ||
    normalized.includes("repair") ||
    normalized.includes("recovery")
  ) {
    return "repair";
  }
  if (normalized === "source_drift_requeue" || normalized === "exact_review_artifact_publish") {
    return "publication_retry";
  }
  if (normalized.includes("command") || normalized.includes("comment")) return "command";
  if (normalized) return "exact_event";
  return "unknown";
}

export function githubEgressPageBucket(value: number | null): GitHubEgressPageBucket {
  if (value === null) return "none";
  if (!Number.isSafeInteger(value) || value < 1) return "unknown";
  if (value === 1) return "1";
  if (value === 2) return "2";
  if (value <= 5) return "3_5";
  if (value <= 10) return "6_10";
  return "11_plus";
}

export function githubEgressClaimGenerationBucket(
  value: number | null,
): GitHubEgressClaimGenerationBucket {
  if (value === null) return "none";
  if (!Number.isSafeInteger(value) || value < 1) return "unknown";
  if (value === 1) return "1";
  if (value === 2) return "2";
  if (value <= 5) return "3_5";
  if (value <= 10) return "6_10";
  if (value <= 32) return "11_32";
  return "33_plus";
}

export function githubEgressStatusBucket(status: number | null): GitHubEgressStatusBucket {
  if (status === null) return "none";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status === 403) return "403";
  if (status === 429) return "429";
  if (status >= 400 && status < 500) return "4xx_other";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

export function githubEgressLatencyBucket(milliseconds: number | null): GitHubEgressLatencyBucket {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  if (milliseconds < 100) return "lt_100ms";
  if (milliseconds < 250) return "100_249ms";
  if (milliseconds < 500) return "250_499ms";
  if (milliseconds < 1_000) return "500_999ms";
  if (milliseconds < 2_000) return "1_2s";
  if (milliseconds < 5_000) return "2_5s";
  return "5s_plus";
}

export function githubEgressFiveMinuteBucket(timestampMs: number): string {
  return new Date(Math.floor(timestampMs / 300_000) * 300_000).toISOString();
}
