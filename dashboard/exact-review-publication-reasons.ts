// This vocabulary is shared by completion validation and aggregate telemetry.
// Free-text diagnostics and identifiers must never become public reason labels.
export const EXACT_REVIEW_PUBLICATION_REASONS = {
  published: new Set(["publication_applied"]),
  superseded: new Set(["remote_newer_tuple", "remote_closed", "live_terminal"]),
  retryable_failure: new Set([
    "github_rate_limit",
    "github_transient",
    "state_contention",
    "review_lease_active",
    "workflow_cancelled",
    "artifact_unavailable",
    "unknown_failure",
  ]),
  // Old publishers can finish with this tuple during a deployment. New publishers
  // use deferred/close_coverage_deferred instead of close_coverage_retry.
  refresh_required: new Set([
    "artifact_unavailable",
    "artifact_expired",
    "close_coverage_retry",
    "invalid_artifact",
  ]),
  deferred: new Set(["close_coverage_deferred"]),
  permanent_failure: new Set([
    "invalid_artifact",
    "missing_record_tuple",
    "tuple_protocol_invalid",
    "policy_invariant",
    "unknown_failure",
    "retry_exhausted",
  ]),
} as const;

export type ExactReviewPublicationReasonCode =
  | "publication_applied"
  | "remote_newer_tuple"
  | "remote_closed"
  | "live_terminal"
  | "github_rate_limit"
  | "github_transient"
  | "state_contention"
  | "review_lease_active"
  | "workflow_cancelled"
  | "artifact_unavailable"
  | "artifact_expired"
  | "close_coverage_retry"
  | "close_coverage_deferred"
  | "invalid_artifact"
  | "missing_record_tuple"
  | "tuple_protocol_invalid"
  | "policy_invariant"
  | "unknown_failure"
  | "retry_exhausted";

const reasons = new Set(Object.values(EXACT_REVIEW_PUBLICATION_REASONS).flatMap((set) => [...set]));

export function exactReviewPublicationReasonCode(
  value: unknown,
): ExactReviewPublicationReasonCode | null {
  return typeof value === "string" && reasons.has(value)
    ? (value as ExactReviewPublicationReasonCode)
    : null;
}

export const PUBLICATION_TELEMETRY_REASONS = {
  superseded: [...EXACT_REVIEW_PUBLICATION_REASONS.superseded],
  retryable: [
    ...new Set([
      ...EXACT_REVIEW_PUBLICATION_REASONS.retryable_failure,
      ...EXACT_REVIEW_PUBLICATION_REASONS.refresh_required,
    ]),
  ],
  permanent: [...EXACT_REVIEW_PUBLICATION_REASONS.permanent_failure],
} as const;
