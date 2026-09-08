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
export type TerminalReviewFailureReason = AgentInputScanFailureReason | "source_incompatible";

export function agentInputScanFailureReason(value: unknown): AgentInputScanFailureReason | null {
  return AGENT_INPUT_SCAN_FAILURE_REASONS.find((reason) => reason === value) ?? null;
}

export function terminalReviewFailureReason(value: unknown): TerminalReviewFailureReason | null {
  return value === "source_incompatible" ? value : agentInputScanFailureReason(value);
}
