import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import type { ActionTaken, CloseReason, Decision, Item } from "./clawsweeper-types.js";
import { reportReviewDecision } from "./report-review-decision.js";
import {
  readReviewRecord,
  readReviewRecordOrLegacy,
  ReviewRecordFormatError,
} from "./review-record.js";

type ApplyCloseDecisionDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  "reportDecision" | "validateCloseDecision"
>;
type CloseDecisionValidation =
  | { ok: true }
  | { ok: false; actionTaken: ActionTaken; reason: string };

function freshReviewReason(error: unknown): string {
  if (!(error instanceof ReviewRecordFormatError)) throw error;
  return `${error.message}; fresh review required`;
}

/**
 * Why the stored review record of a report does not read, or null. The apply does not
 * act on such a report: the item gets a fresh review, which writes a new record.
 */
export function unreadableReviewRecordReason(markdown: string): string | null {
  try {
    readReviewRecord(markdown);
    return null;
  } catch (error) {
    return freshReviewReason(error);
  }
}

// The apply checks the close that it will do. The review record gives the reviewed
// fields; the apply supplies the current close reason and host proof policy.
function applyCloseDecision(
  markdown: string,
  closeReason: CloseReason,
  reportDecision: ApplyCloseDecisionDependencies["reportDecision"],
): Decision {
  const { decision } = readReviewRecordOrLegacy(markdown, (report) =>
    reportDecision(report, closeReason),
  );
  const review = reportReviewDecision(markdown);
  return {
    ...decision,
    decision: "close",
    closeReason,
    confidence: "high",
    closeComment: review.publishedCloseComment,
    realBehaviorProof: review.realBehaviorProof,
  };
}

/**
 * Validates the close of the item of a report. A review record that does not read
 * blocks the close, and the item gets a fresh review.
 */
export function validateReportClose(
  dependencies: ApplyCloseDecisionDependencies,
  item: Pick<Item, "kind" | "labels" | "repo"> & Partial<Pick<Item, "authorAssociation">>,
  markdown: string,
  closeReason: CloseReason,
  options: { requireCloseComment: boolean },
): CloseDecisionValidation {
  let decision: Decision;
  try {
    decision = applyCloseDecision(markdown, closeReason, dependencies.reportDecision);
  } catch (error) {
    return {
      ok: false,
      actionTaken: "skipped_changed_since_review",
      reason: freshReviewReason(error),
    };
  }
  return dependencies.validateCloseDecision(item, decision, options);
}
