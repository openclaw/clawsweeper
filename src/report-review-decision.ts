import { reviewSectionValue } from "./clawsweeper-record-metadata.js";
import {
  impactLabelsFromReport,
  labelJustificationsFromReport,
  maturityLabelsFromReport,
  mergeRiskLabelsFromReport,
  reportSecurityReview,
  reportTelegramVisibleProof,
  selectedLabelJustifications,
  triagePriorityFromReport,
} from "./clawsweeper-report-parser.js";
import type { Decision } from "./clawsweeper-types.js";
import { frontMatterStringArray, frontMatterValue } from "./report-front-matter.js";
import { readReviewRecord } from "./review-record.js";

/**
 * The reviewed decision fields that select labels outside PR merge readiness.
 * `labelJustifications` has one entry for each selected label.
 */
export type ReportReviewDecision = Pick<
  Decision,
  | "triagePriority"
  | "impactLabels"
  | "mergeRiskLabels"
  | "maturityLabels"
  | "labelJustifications"
  | "telegramVisibleProof"
  | "securityReview"
  | "itemCategory"
  | "reproductionStatus"
  | "reproductionConfidence"
  | "requiresNewFeature"
  | "requiresNewConfigOption"
  | "requiresProductDecision"
  | "implementationComplexity"
  | "autoImplementationCandidate"
  | "workCandidate"
  | "workConfidence"
  | "workPrompt"
  | "workValidation"
  | "workLikelyFiles"
>;

/**
 * Reads the reviewed decision of a report from its typed review_record. A report from
 * before review_record existed gets the decision from its text. A record that does not
 * read throws ReviewRecordFormatError: it gets no fallback.
 */
export function reportReviewDecision(markdown: string): ReportReviewDecision {
  const record = readReviewRecord(markdown);
  if (!record) return legacyReportReviewDecision(markdown);
  const { decision } = record;
  return {
    ...decision,
    labelJustifications: selectedLabelJustifications(decision.labelJustifications, decision),
  };
}

// The report readers that labels used before review_record existed. Remove this
// fallback when the backfill shows that no stored report is without a record.
function legacyReportReviewDecision(markdown: string): ReportReviewDecision {
  const labels = {
    triagePriority: triagePriorityFromReport(markdown),
    impactLabels: impactLabelsFromReport(markdown),
    mergeRiskLabels: mergeRiskLabelsFromReport(markdown),
    maturityLabels: maturityLabelsFromReport(markdown),
  };
  // An older report can have no value, or a value that is not in the type. The labels
  // compare these values to known values, as they did before review_record existed.
  const stored = <T extends string>(key: string) => frontMatterValue(markdown, key) as T;
  return {
    ...labels,
    labelJustifications: labelJustificationsFromReport(markdown, labels),
    telegramVisibleProof: reportTelegramVisibleProof(markdown),
    securityReview: reportSecurityReview(markdown),
    itemCategory: stored("item_category"),
    reproductionStatus: stored("reproduction_status"),
    reproductionConfidence: stored("reproduction_confidence"),
    requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
    requiresNewConfigOption: frontMatterValue(markdown, "requires_new_config_option") === "true",
    requiresProductDecision: frontMatterValue(markdown, "requires_product_decision") === "true",
    implementationComplexity: stored("implementation_complexity"),
    autoImplementationCandidate: stored("auto_implementation_candidate"),
    workCandidate: stored("work_candidate"),
    workConfidence: stored("work_confidence"),
    workPrompt: reviewSectionValue(markdown, "repairWorkPrompt"),
    workValidation: frontMatterStringArray(markdown, "work_validation"),
    workLikelyFiles: frontMatterStringArray(markdown, "work_likely_files"),
  };
}
