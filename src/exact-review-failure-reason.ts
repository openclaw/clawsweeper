export const AGENT_INPUT_SCAN_FAILURE_REASONS = [
  "scanner_unavailable",
  "scanner_failed",
  "findings",
  "deadline",
  "staging_limit",
  "incomplete_source",
  "source_drift",
  "unsafe_path",
  "unsupported_content",
] as const;

export type AgentInputScanFailureReason = (typeof AGENT_INPUT_SCAN_FAILURE_REASONS)[number];
export type TerminalReviewFailureReason =
  | AgentInputScanFailureReason
  | "source_incompatible"
  | "batch_nonretryable";

export function agentInputScanFailureReason(value: unknown): AgentInputScanFailureReason | null {
  return AGENT_INPUT_SCAN_FAILURE_REASONS.find((reason) => reason === value) ?? null;
}

export function terminalReviewFailureReason(value: unknown): TerminalReviewFailureReason | null {
  return value === "source_incompatible" || value === "batch_nonretryable"
    ? value
    : agentInputScanFailureReason(value);
}

/** Workflow protocol: a settled batch failure must not authorize another paid batch. */
export const NONRETRYABLE_REVIEW_BATCH_EXIT_CODE = 82;
export class NonretryableReviewBatchError extends Error {
  constructor(cause: unknown) {
    super(
      "The configured review batch did not produce an accepted consolidated verdict; automatic retry is disabled.",
      { cause },
    );
    this.name = "NonretryableReviewBatchError";
  }
}
export function nonretryableReviewBatchExitCode(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof NonretryableReviewBatchError) return NONRETRYABLE_REVIEW_BATCH_EXIT_CODE;
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}
