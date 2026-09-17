/** Closed public vocabulary. Never publish diagnostic text or infer historical causes. */
export const PUBLIC_REVIEW_FAILURE_STAGES = [
  "agent_input_scan",
  "source_preparation",
  "provider_or_model",
  "workflow",
] as const;
export const PUBLIC_REVIEW_FAILURE_REASONS = [
  "scanner_unavailable",
  "scanner_failed",
  "findings",
  "deadline",
  "staging_limit",
  "incomplete_source",
  "source_drift",
  "unsafe_path",
  "unsupported_content",
  "configuration_missing",
  "setup_script_failed",
  "source_incompatible",
  "review_commits_unavailable",
  "review_history_unavailable",
  "review_blob_metadata_unavailable",
  "review_blobs_unavailable",
  "review_checkout_unavailable",
  "review_commit_fetch_failed",
  "review_checkout_failed",
  "review_git_inspection_failed",
  "provider_throttle",
  "transport_network",
  "content_or_output",
  "model_access",
  "timeout",
  "codex_execution",
  "workflow_failed",
  "workflow_cancelled",
  "unknown",
] as const;
export type PublicReviewFailure = {
  stage: (typeof PUBLIC_REVIEW_FAILURE_STAGES)[number];
  reason: (typeof PUBLIC_REVIEW_FAILURE_REASONS)[number];
};

export function normalizePublicReviewFailure(value: unknown): PublicReviewFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "stage") ||
    !Object.hasOwn(record, "reason")
  )
    return null;
  if (
    typeof record.stage !== "string" ||
    typeof record.reason !== "string" ||
    !(PUBLIC_REVIEW_FAILURE_STAGES as readonly string[]).includes(record.stage) ||
    !(PUBLIC_REVIEW_FAILURE_REASONS as readonly string[]).includes(record.reason)
  )
    return null;
  return {
    stage: record.stage as PublicReviewFailure["stage"],
    reason: record.reason as PublicReviewFailure["reason"],
  };
}

export const PUBLIC_REVIEW_FAILURE_STAGE_LABELS: Record<PublicReviewFailure["stage"], string> = {
  agent_input_scan: "Input safety scan",
  source_preparation: "Source preparation",
  provider_or_model: "Provider or model",
  workflow: "Workflow",
};

const EXPLANATIONS: Record<PublicReviewFailure["reason"], string> = {
  scanner_unavailable: "The agent-input scanner was unavailable.",
  scanner_failed: "The agent-input scan failed.",
  findings: "The agent-input scan reported findings.",
  deadline: "The review preparation deadline was reached.",
  staging_limit: "The source staging limit was reached.",
  incomplete_source: "The review source was incomplete.",
  source_drift: "The source changed during review preparation.",
  unsafe_path: "Source preparation encountered an unsafe path.",
  unsupported_content: "Source preparation encountered unsupported content.",
  configuration_missing: "Required review configuration was missing.",
  setup_script_failed: "The review setup script failed.",
  source_incompatible: "The source was incompatible with review preparation.",
  review_commits_unavailable: "Required review commits were unavailable.",
  review_history_unavailable: "Required review history was unavailable.",
  review_blob_metadata_unavailable: "Review blob metadata was unavailable.",
  review_blobs_unavailable: "Required review blobs were unavailable.",
  review_checkout_unavailable: "The review checkout was unavailable.",
  review_commit_fetch_failed: "Fetching a review commit failed.",
  review_checkout_failed: "Preparing the review checkout failed.",
  review_git_inspection_failed: "Review Git inspection failed.",
  provider_throttle: "The review provider limited requests.",
  transport_network: "The review encountered a network or transport failure.",
  content_or_output: "The review encountered a content or output failure.",
  model_access: "The requested review model was unavailable.",
  timeout: "The review timed out.",
  codex_execution: "The review execution failed.",
  workflow_failed: "The review workflow failed.",
  workflow_cancelled: "The review workflow was cancelled.",
  unknown: "The recorded failure cause is unknown.",
};

export function reviewFailureExplanation(value: unknown): string | null {
  const failure = normalizePublicReviewFailure(value);
  return failure
    ? `${PUBLIC_REVIEW_FAILURE_STAGE_LABELS[failure.stage]}: ${EXPLANATIONS[failure.reason]}`
    : null;
}
