import { reviewDecisionParser } from "./clawsweeper-decision-parser.js";
import type { RootCauseNormalizationItem } from "./clawsweeper-types.js";

/** Asks a Codex worker for one repair turn when a final review decision fails validation. */
export interface DecisionRepairOptions {
  item: RootCauseNormalizationItem;
}

const MAX_DECISION_ERROR_CHARS = 4096;

/** Returns the decision validator error for a final review message, or undefined when it is valid. */
export function decisionOutputError(
  text: string,
  item: RootCauseNormalizationItem,
): string | undefined {
  try {
    reviewDecisionParser.parseDecision(JSON.parse(text.trim()), item);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > MAX_DECISION_ERROR_CHARS
      ? `${message.slice(0, MAX_DECISION_ERROR_CHARS)}…`
      : message;
  }
}

/** The repair turn passes the validator's own error text; it adds no other check. */
export function decisionRepairPrompt(error: string): string {
  return [
    "Your final JSON did not pass the ClawSweeper decision validator:",
    "",
    error,
    "",
    "Return the corrected full JSON object. Do not re-investigate unless the fix needs it.",
  ].join("\n");
}
