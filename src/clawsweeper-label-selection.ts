import {
  GOOD_FIRST_ISSUE_LABEL,
  IMPACT_LABELS,
  IMPACT_LABEL_NAMES,
  ISSUE_ADVISORY_LABELS,
  ISSUE_ADVISORY_LABEL_NAMES,
  LEGACY_TELEGRAM_VISIBLE_PROOF_LABEL,
  MATURITY_LABELS,
  MATURITY_LABEL_NAMES,
  MERGE_RISK_LABELS,
  MERGE_RISK_LABEL_NAMES,
  NO_STALE_LABEL,
  PRIORITY_LABELS,
  PRIORITY_LABEL_NAMES,
  PROOF_MEDIA_LABELS,
  PROOF_MEDIA_LABEL_NAMES,
  PROOF_SUFFICIENT_LABEL,
  QUEUEABLE_FIX_LABEL,
  STALE_LABEL,
  TELEGRAM_VISIBLE_PROOF_LABEL,
  type MergeRiskLabelName,
} from "./clawsweeper-policy.js";
import type {
  ImpactLabelName,
  IssueAdvisoryLabelState,
  MaturityLabelName,
  RealBehaviorProof,
  TelegramVisibleProof,
  TriagePriority,
} from "./clawsweeper-types.js";
import {
  BULK_FILED_LABEL,
  NEEDS_MAINTAINER_REVIEW_LABEL,
  NEEDS_PRODUCT_DECISION_LABEL,
  NEEDS_SECURITY_REVIEW_LABEL,
} from "./repair/exact-review-guard-labels.js";
import { hasNormalizedLabel, protectedLabels } from "./clawsweeper-item-policy.js";
import { frontMatterValue } from "./report-front-matter.js";
import { isSecurityLabel } from "./repair/security-signals.js";
import type { ReportReviewDecision } from "./report-review-decision.js";
import { reviewDecisionParser } from "./clawsweeper-decision-parser.js";
import type { Decision, LabelJustification } from "./clawsweeper-types.js";

/** One justification for each label that the review selected, in the order of the labels. */
export function selectedLabelJustifications(
  justifications: readonly LabelJustification[],
  labels: Pick<Decision, "triagePriority" | "impactLabels" | "mergeRiskLabels" | "maturityLabels">,
): LabelJustification[] {
  const reasons = new Map(justifications.map((entry) => [entry.label, entry.reason]));
  return reviewDecisionParser.selectedReviewLabels(labels).map((label) => ({
    label,
    reason:
      reasons.get(label) ?? "Older review report did not store a label-specific justification.",
  }));
}

export function nextRealBehaviorProofSufficientLabels(
  labels: readonly string[],
  proof: Pick<RealBehaviorProof, "status">,
): string[] {
  const nextLabels = labels.filter((label) => label !== PROOF_SUFFICIENT_LABEL);
  if (proof.status === "sufficient") nextLabels.push(PROOF_SUFFICIENT_LABEL);
  return nextLabels;
}
export function nextRealBehaviorProofMediaLabels(
  labels: readonly string[],
  proof: Pick<RealBehaviorProof, "evidenceKind">,
): string[] {
  const nextLabels = labels.filter((label) => !PROOF_MEDIA_LABEL_NAMES.has(label));
  const mediaLabel = PROOF_MEDIA_LABELS.find((label) => label.evidenceKind === proof.evidenceKind);
  if (mediaLabel) nextLabels.push(mediaLabel.name);
  return nextLabels;
}
export function nextTelegramVisibleProofLabels(
  labels: readonly string[],
  proof: Pick<TelegramVisibleProof, "status">,
): string[] {
  const nextLabels = labels.filter(
    (label) =>
      label !== TELEGRAM_VISIBLE_PROOF_LABEL && label !== LEGACY_TELEGRAM_VISIBLE_PROOF_LABEL,
  );
  if (proof.status === "needed") nextLabels.push(TELEGRAM_VISIBLE_PROOF_LABEL);
  return nextLabels;
}
export type PriorityLabelSpec = (typeof PRIORITY_LABELS)[number];
export function priorityLabelForTriage(priority: TriagePriority): PriorityLabelSpec | null {
  return PRIORITY_LABELS.find((label) => label.triagePriority === priority) ?? null;
}
export function nextPriorityLabels(
  labels: readonly string[],
  triagePriority: TriagePriority,
): string[] {
  const nextLabels = labels.filter((label) => !PRIORITY_LABEL_NAMES.has(label));
  const priorityLabel = priorityLabelForTriage(triagePriority);
  if (priorityLabel) nextLabels.push(priorityLabel.name);
  return nextLabels;
}
export function nextImpactLabels(
  labels: readonly string[],
  impactLabels: readonly ImpactLabelName[],
): string[] {
  const nextLabels = labels.filter((label) => !IMPACT_LABEL_NAMES.has(label));
  const uniqueImpactLabels = new Set(impactLabels);
  for (const label of IMPACT_LABELS) {
    if (uniqueImpactLabels.has(label.name)) nextLabels.push(label.name);
  }
  return nextLabels;
}
export function nextMaturityLabels(
  labels: readonly string[],
  maturityLabels: readonly MaturityLabelName[],
): string[] {
  const nextLabels = labels.filter((label) => !MATURITY_LABEL_NAMES.has(label));
  const uniqueMaturityLabels = new Set(maturityLabels);
  for (const label of MATURITY_LABELS) {
    if (uniqueMaturityLabels.has(label.name)) nextLabels.push(label.name);
  }
  return nextLabels;
}
export function nextMergeRiskLabels(
  labels: readonly string[],
  mergeRiskLabels: readonly MergeRiskLabelName[],
): string[] {
  const nextLabels = labels.filter((label) => !MERGE_RISK_LABEL_NAMES.has(label));
  const uniqueMergeRiskLabels = new Set(mergeRiskLabels);
  for (const label of MERGE_RISK_LABELS) {
    if (uniqueMergeRiskLabels.has(label.name)) nextLabels.push(label.name);
  }
  return nextLabels;
}
export function isIssueAdvisoryLabel(label: string): boolean {
  return ISSUE_ADVISORY_LABEL_NAMES.has(label.toLowerCase());
}
export function isGoodFirstIssue(
  state: IssueAdvisoryLabelState,
  currentLabels: readonly string[],
): boolean {
  return (
    state.type === "issue" &&
    state.itemCategory === "bug" &&
    state.reproductionStatus === "reproduced" &&
    state.reproductionConfidence === "high" &&
    !state.requiresNewFeature &&
    !state.requiresNewConfigOption &&
    !state.requiresProductDecision &&
    state.implementationComplexity === "small" &&
    state.autoImplementationCandidate === "strict_bug" &&
    state.securityReviewStatus !== "needs_attention" &&
    state.workCandidate === "queue_fix_pr" &&
    state.workStatus === "candidate" &&
    state.workConfidence === "high" &&
    state.hasWorkPrompt &&
    state.hasWorkValidation &&
    !state.goodFirstIssueOptedOut &&
    !state.locked &&
    !hasNormalizedLabel(currentLabels, BULK_FILED_LABEL) &&
    !currentLabels.some(isSecurityLabel) &&
    !hasNormalizedLabel(currentLabels, "impact:security") &&
    protectedLabels(currentLabels).length === 0 &&
    !state.hasOpenLinkedPullRequest
  );
}
export function issueRatingLabelForState(state: IssueAdvisoryLabelState): string {
  if (state.type !== "issue") return "";
  if (state.reproductionStatus === "not_applicable") {
    return "issue-rating: 🌊 off-meta tidepool";
  }
  if (state.reproductionStatus === "reproduced" && state.reproductionConfidence === "high") {
    return "issue-rating: 🦀 challenger crab";
  }
  if (
    (state.reproductionStatus === "source_reproducible" ||
      state.reproductionStatus === "reproduced") &&
    state.reproductionConfidence === "high"
  ) {
    return "issue-rating: 🦞 diamond lobster";
  }
  if (
    (state.reproductionStatus === "source_reproducible" ||
      state.reproductionStatus === "reproduced") &&
    state.reproductionConfidence === "medium"
  ) {
    return "issue-rating: 🐚 platinum hermit";
  }
  if (state.reproductionStatus === "unclear" && state.reproductionConfidence === "medium") {
    return "issue-rating: 🦐 gold shrimp";
  }
  if (
    state.reproductionStatus === "not_reproduced" ||
    (state.reproductionStatus === "unclear" && state.reproductionConfidence === "low")
  ) {
    return "issue-rating: 🦪 silver shellfish";
  }
  return "issue-rating: 🧂 unranked krab";
}
export function wantedIssueAdvisoryLabels(
  state: IssueAdvisoryLabelState,
  currentLabels: readonly string[],
): Set<string> {
  const labels = new Set<string>();
  if (state.type !== "issue") return labels;
  const isBulkFiled = hasNormalizedLabel(currentLabels, BULK_FILED_LABEL);
  const issueRatingLabel = issueRatingLabelForState(state);
  if (issueRatingLabel) labels.add(issueRatingLabel);
  if (state.reproductionConfidence === "high") {
    if (state.reproductionStatus === "reproduced") labels.add("clawsweeper:current-main-repro");
    if (state.reproductionStatus === "source_reproducible") labels.add("clawsweeper:source-repro");
    if (state.reproductionStatus === "not_reproduced") labels.add("clawsweeper:not-repro-on-main");
  }
  if (
    state.reproductionStatus === "source_reproducible" &&
    state.reproductionConfidence !== "high"
  ) {
    labels.add("clawsweeper:needs-live-repro");
  }
  if (state.reproductionStatus === "unclear" && state.reproductionConfidence !== "high") {
    labels.add("clawsweeper:needs-info");
  }
  if (state.hasOpenLinkedPullRequest) {
    labels.add("clawsweeper:linked-pr-open");
  }
  if (
    !isBulkFiled &&
    state.workCandidate === "queue_fix_pr" &&
    state.workStatus === "candidate" &&
    state.workConfidence === "high"
  ) {
    labels.add(QUEUEABLE_FIX_LABEL);
  }
  if (isGoodFirstIssue(state, currentLabels)) {
    labels.add(GOOD_FIRST_ISSUE_LABEL);
  }
  if (
    state.workConfidence === "high" &&
    state.hasWorkShape &&
    (state.workCandidate === "queue_fix_pr" || state.workCandidate === "manual_review")
  ) {
    labels.add("clawsweeper:fix-shape-clear");
  }
  if (state.workCandidate === "manual_review" || state.workStatus === "manual_review") {
    labels.add(NEEDS_MAINTAINER_REVIEW_LABEL);
  }
  if (state.requiresProductDecision) {
    labels.add(NEEDS_PRODUCT_DECISION_LABEL);
  }
  if (state.itemCategory === "security" || state.securityReviewStatus === "needs_attention") {
    labels.add(NEEDS_SECURITY_REVIEW_LABEL);
  }
  if (
    state.hasOpenLinkedPullRequest ||
    state.workCandidate === "manual_review" ||
    state.workStatus === "manual_review" ||
    state.requiresProductDecision ||
    state.itemCategory === "security" ||
    state.securityReviewStatus === "needs_attention" ||
    isBulkFiled
  ) {
    labels.add("clawsweeper:no-new-fix-pr");
  }
  return labels;
}
export function issueAdvisoryStateNeedsStaleProtection(
  state: IssueAdvisoryLabelState,
  currentLabels: readonly string[],
): boolean {
  return (
    state.type === "issue" &&
    !hasNormalizedLabel(currentLabels, BULK_FILED_LABEL) &&
    state.workCandidate === "queue_fix_pr" &&
    state.workStatus === "candidate" &&
    state.workConfidence === "high"
  );
}
export function issueAdvisoryLabelsHadQueueableProtection(labels: readonly string[]): boolean {
  return labels.some((label) => label.toLowerCase() === QUEUEABLE_FIX_LABEL);
}
export function nextIssueAdvisoryLabels(
  labels: readonly string[],
  state: IssueAdvisoryLabelState,
): string[] {
  const wantedLabels = wantedIssueAdvisoryLabels(state, labels);
  const needsStaleProtection = issueAdvisoryStateNeedsStaleProtection(state, labels);
  const hadQueueableProtection = issueAdvisoryLabelsHadQueueableProtection(labels);
  const nextLabels = labels.filter(
    (label) =>
      !isIssueAdvisoryLabel(label) &&
      !(needsStaleProtection && label.toLowerCase() === STALE_LABEL) &&
      !(!needsStaleProtection && hadQueueableProtection && label.toLowerCase() === NO_STALE_LABEL),
  );
  if (needsStaleProtection && !nextLabels.some((label) => label.toLowerCase() === NO_STALE_LABEL)) {
    nextLabels.push(NO_STALE_LABEL);
  }
  for (const label of ISSUE_ADVISORY_LABELS) {
    if (wantedLabels.has(label.name)) nextLabels.push(label.name);
  }
  if (
    wantedLabels.has(GOOD_FIRST_ISSUE_LABEL) &&
    !nextLabels.some((label) => label.toLowerCase() === GOOD_FIRST_ISSUE_LABEL)
  ) {
    nextLabels.push(GOOD_FIRST_ISSUE_LABEL);
  }
  return nextLabels;
}
/** The issue advisory label state of a report. The report gives the host fields. */
export function issueAdvisoryLabelState(
  markdown: string,
  decision: ReportReviewDecision,
  options: {
    goodFirstIssueOptedOut?: boolean;
    hasOpenLinkedPullRequest?: boolean;
    locked?: boolean;
  } = {},
): IssueAdvisoryLabelState {
  const workPrompt = decision.workPrompt.trim();
  return {
    type: frontMatterValue(markdown, "type"),
    itemCategory: decision.itemCategory,
    reproductionStatus: decision.reproductionStatus,
    reproductionConfidence: decision.reproductionConfidence,
    requiresNewFeature: decision.requiresNewFeature,
    requiresNewConfigOption: decision.requiresNewConfigOption,
    requiresProductDecision: decision.requiresProductDecision,
    implementationComplexity: decision.implementationComplexity,
    autoImplementationCandidate: decision.autoImplementationCandidate,
    securityReviewStatus: decision.securityReview.status,
    workCandidate: decision.workCandidate,
    workStatus: frontMatterValue(markdown, "work_status"),
    workConfidence: decision.workConfidence,
    hasWorkShape: Boolean(
      workPrompt || decision.workLikelyFiles.length || decision.workValidation.length,
    ),
    hasWorkPrompt: Boolean(workPrompt),
    hasWorkValidation: decision.workValidation.length > 0,
    goodFirstIssueOptedOut: options.goodFirstIssueOptedOut === true,
    locked: options.locked === true,
    hasOpenLinkedPullRequest: options.hasOpenLinkedPullRequest === true,
  };
}
