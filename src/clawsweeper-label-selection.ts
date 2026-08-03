import { nextPrRatingLabels } from "./clawsweeper-rating.js";
import {
  BULK_FILED_LABEL,
  GOOD_FIRST_ISSUE_LABEL,
  IMPACT_LABELS,
  IMPACT_LABEL_NAMES,
  ISSUE_ADVISORY_LABELS,
  ISSUE_ADVISORY_LABEL_NAMES,
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
  PR_RATING_LABELS,
  PR_RATING_TIERS,
  QUEUEABLE_FIX_LABEL,
  REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS,
  REAL_BEHAVIOR_PROOF_STATUSES,
  STALE_LABEL,
  TELEGRAM_VISIBLE_PROOF_LABEL,
  TELEGRAM_VISIBLE_PROOF_STATUSES,
  TRIAGE_PRIORITIES,
} from "./clawsweeper-policy.js";
import type {
  ImpactLabelName,
  IssueAdvisoryLabelState,
  MaturityLabelName,
  MergeRiskLabelName,
  PrRatingTier,
  RealBehaviorProof,
  RealBehaviorProofEvidenceKind,
  RealBehaviorProofStatus,
  TelegramVisibleProof,
  TelegramVisibleProofStatus,
  TriagePriority,
} from "./clawsweeper-types.js";
import type { LabelSynchronizationDependencies } from "./clawsweeper-label-dependencies.js";

export function createLabelSelectionPolicy(dependencies: LabelSynchronizationDependencies) {
  const {
    hasNormalizedLabel,
    normalizeLabelName,
    protectedLabels,
    frontMatterValue,
    frontMatterStringArray,
    reportSecurityReview,
    reviewSectionValue,
    labelPolicy,
  } = dependencies;

  const { nextFeatureShowcaseLabels, nextPrStatusLabels, prStatusLabelForKind } = labelPolicy;
  function nextRealBehaviorProofSufficientLabels(
    labels: readonly string[],
    proof: Pick<RealBehaviorProof, "status">,
  ): string[] {
    const nextLabels = labels.filter((label) => label !== PROOF_SUFFICIENT_LABEL);
    if (proof.status === "sufficient") nextLabels.push(PROOF_SUFFICIENT_LABEL);
    return nextLabels;
  }
  function nextRealBehaviorProofMediaLabels(
    labels: readonly string[],
    proof: Pick<RealBehaviorProof, "evidenceKind">,
  ): string[] {
    const nextLabels = labels.filter((label) => !PROOF_MEDIA_LABEL_NAMES.has(label));
    const mediaLabel = PROOF_MEDIA_LABELS.find(
      (label) => label.evidenceKind === proof.evidenceKind,
    );
    if (mediaLabel) nextLabels.push(mediaLabel.name);
    return nextLabels;
  }
  function realBehaviorProofSufficientLabelsForTest(
    labels: readonly string[],
    status: string,
  ): string[] {
    const proofStatus = REAL_BEHAVIOR_PROOF_STATUSES.has(status as RealBehaviorProofStatus)
      ? (status as RealBehaviorProofStatus)
      : "not_applicable";
    return nextRealBehaviorProofSufficientLabels(labels, { status: proofStatus });
  }
  function realBehaviorProofMediaLabelsForTest(
    labels: readonly string[],
    evidenceKind: string,
  ): string[] {
    const proofEvidenceKind = REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS.has(
      evidenceKind as RealBehaviorProofEvidenceKind,
    )
      ? (evidenceKind as RealBehaviorProofEvidenceKind)
      : "not_applicable";
    return nextRealBehaviorProofMediaLabels(labels, { evidenceKind: proofEvidenceKind });
  }
  function prRatingLabelsForTest(
    labels: readonly string[],
    tier: string,
    reviewFailed = false,
  ): string[] {
    const overallTier = PR_RATING_TIERS.has(tier as PrRatingTier) ? (tier as PrRatingTier) : "NA";
    return nextPrRatingLabels(labels, { overallTier }, reviewFailed);
  }
  function prRatingLabelSchemeForTest(): {
    tier: PrRatingTier;
    name: string;
    color: string;
    description: string;
  }[] {
    return PR_RATING_LABELS.map(({ tier, name, color, description }) => ({
      tier,
      name,
      color,
      description,
    }));
  }
  function nextTelegramVisibleProofLabels(
    labels: readonly string[],
    proof: Pick<TelegramVisibleProof, "status">,
  ): string[] {
    const nextLabels = labels.filter((label) => label !== TELEGRAM_VISIBLE_PROOF_LABEL);
    if (proof.status === "needed") nextLabels.push(TELEGRAM_VISIBLE_PROOF_LABEL);
    return nextLabels;
  }
  function telegramVisibleProofLabelsForTest(labels: readonly string[], status: string): string[] {
    const proofStatus = TELEGRAM_VISIBLE_PROOF_STATUSES.has(status as TelegramVisibleProofStatus)
      ? (status as TelegramVisibleProofStatus)
      : "not_needed";
    return nextTelegramVisibleProofLabels(labels, { status: proofStatus });
  }
  type PriorityLabelSpec = (typeof PRIORITY_LABELS)[number];
  function priorityLabelForTriage(priority: TriagePriority): PriorityLabelSpec | null {
    return PRIORITY_LABELS.find((label) => label.triagePriority === priority) ?? null;
  }
  function nextPriorityLabels(labels: readonly string[], triagePriority: TriagePriority): string[] {
    const nextLabels = labels.filter((label) => !PRIORITY_LABEL_NAMES.has(label));
    const priorityLabel = priorityLabelForTriage(triagePriority);
    if (priorityLabel) nextLabels.push(priorityLabel.name);
    return nextLabels;
  }
  function priorityLabelSchemeForTest(): {
    name: string;
    color: string;
    description: string;
  }[] {
    return PRIORITY_LABELS.map(({ name, color, description }) => ({ name, color, description }));
  }
  function priorityLabelsForTest(labels: readonly string[], triagePriority: string): string[] {
    const priority = TRIAGE_PRIORITIES.has(triagePriority as TriagePriority)
      ? (triagePriority as TriagePriority)
      : "none";
    return nextPriorityLabels(labels, priority);
  }
  function nextImpactLabels(
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
  function impactLabelSchemeForTest(): {
    name: string;
    color: string;
    description: string;
  }[] {
    return IMPACT_LABELS.map(({ name, color, description }) => ({ name, color, description }));
  }
  function impactLabelsForTest(
    labels: readonly string[],
    impactLabels: readonly string[],
  ): string[] {
    return nextImpactLabels(
      labels,
      impactLabels.filter((label): label is ImpactLabelName => IMPACT_LABEL_NAMES.has(label)),
    );
  }
  function nextMaturityLabels(
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
  function maturityLabelSchemeForTest(): {
    name: string;
    color: string;
    description: string;
  }[] {
    return MATURITY_LABELS.map(({ name, color, description }) => ({ name, color, description }));
  }
  function maturityLabelsForTest(
    labels: readonly string[],
    maturityLabels: readonly string[],
  ): string[] {
    return nextMaturityLabels(
      labels,
      maturityLabels.filter((label): label is MaturityLabelName => MATURITY_LABEL_NAMES.has(label)),
    );
  }
  function nextMergeRiskLabels(
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
  function mergeRiskLabelSchemeForTest(): {
    name: string;
    color: string;
    description: string;
  }[] {
    return MERGE_RISK_LABELS.map(({ name, color, description }) => ({
      name,
      color,
      description,
    }));
  }
  function mergeRiskLabelsForTest(
    labels: readonly string[],
    mergeRiskLabels: readonly string[],
  ): string[] {
    return nextMergeRiskLabels(
      labels,
      mergeRiskLabels.filter((label): label is MergeRiskLabelName =>
        MERGE_RISK_LABEL_NAMES.has(label),
      ),
    );
  }
  function isIssueAdvisoryLabel(label: string): boolean {
    return ISSUE_ADVISORY_LABEL_NAMES.has(label.toLowerCase());
  }
  function isSecuritySensitiveLabel(label: string): boolean {
    const normalized = normalizeLabelName(label);
    return (
      normalized === "impact:security" ||
      normalized === "security" ||
      normalized === "security-sensitive" ||
      normalized === "security sensitive" ||
      normalized === "type: security" ||
      normalized === "type:security" ||
      normalized === "kind: security" ||
      normalized === "kind:security" ||
      normalized.startsWith("security:") ||
      normalized.startsWith("security/")
    );
  }
  function isGoodFirstIssue(
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
      !currentLabels.some(isSecuritySensitiveLabel) &&
      protectedLabels(currentLabels).length === 0 &&
      !state.hasOpenLinkedPullRequest
    );
  }
  function issueRatingLabelForState(state: IssueAdvisoryLabelState): string {
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
  function wantedIssueAdvisoryLabels(
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
      if (state.reproductionStatus === "source_reproducible")
        labels.add("clawsweeper:source-repro");
      if (state.reproductionStatus === "not_reproduced")
        labels.add("clawsweeper:not-repro-on-main");
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
      labels.add("clawsweeper:needs-maintainer-review");
    }
    if (state.requiresProductDecision) {
      labels.add("clawsweeper:needs-product-decision");
    }
    if (state.itemCategory === "security" || state.securityReviewStatus === "needs_attention") {
      labels.add("clawsweeper:needs-security-review");
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
  function issueAdvisoryStateNeedsStaleProtection(
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
  function issueAdvisoryLabelsHadQueueableProtection(labels: readonly string[]): boolean {
    return labels.some((label) => label.toLowerCase() === QUEUEABLE_FIX_LABEL);
  }
  function nextIssueAdvisoryLabels(
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
        !(
          !needsStaleProtection &&
          hadQueueableProtection &&
          label.toLowerCase() === NO_STALE_LABEL
        ),
    );
    if (
      needsStaleProtection &&
      !nextLabels.some((label) => label.toLowerCase() === NO_STALE_LABEL)
    ) {
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
  function issueAdvisoryLabelsForTest(
    labels: readonly string[],
    state: Partial<IssueAdvisoryLabelState>,
  ): string[] {
    return nextIssueAdvisoryLabels(labels, {
      type: state.type,
      itemCategory: state.itemCategory,
      reproductionStatus: state.reproductionStatus,
      reproductionConfidence: state.reproductionConfidence,
      requiresNewFeature: state.requiresNewFeature ?? false,
      requiresNewConfigOption: state.requiresNewConfigOption ?? false,
      requiresProductDecision: state.requiresProductDecision ?? false,
      implementationComplexity: state.implementationComplexity,
      autoImplementationCandidate: state.autoImplementationCandidate,
      securityReviewStatus: state.securityReviewStatus,
      workCandidate: state.workCandidate,
      workStatus: state.workStatus,
      workConfidence: state.workConfidence,
      hasWorkShape: state.hasWorkShape ?? false,
      hasWorkPrompt: state.hasWorkPrompt ?? false,
      hasWorkValidation: state.hasWorkValidation ?? false,
      goodFirstIssueOptedOut: state.goodFirstIssueOptedOut ?? false,
      locked: state.locked ?? false,
      hasOpenLinkedPullRequest: state.hasOpenLinkedPullRequest ?? false,
    });
  }
  function issueAdvisoryLabelStateFromReport(
    markdown: string,
    options: {
      goodFirstIssueOptedOut?: boolean;
      hasOpenLinkedPullRequest?: boolean;
      locked?: boolean;
    } = {},
  ): IssueAdvisoryLabelState {
    const workLikelyFiles = frontMatterStringArray(markdown, "work_likely_files");
    const workValidation = frontMatterStringArray(markdown, "work_validation");
    const workPrompt = reviewSectionValue(markdown, "repairWorkPrompt").trim();
    return {
      type: frontMatterValue(markdown, "type"),
      itemCategory: frontMatterValue(markdown, "item_category"),
      reproductionStatus: frontMatterValue(markdown, "reproduction_status"),
      reproductionConfidence: frontMatterValue(markdown, "reproduction_confidence"),
      requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
      requiresNewConfigOption: frontMatterValue(markdown, "requires_new_config_option") === "true",
      requiresProductDecision: frontMatterValue(markdown, "requires_product_decision") === "true",
      implementationComplexity: frontMatterValue(markdown, "implementation_complexity"),
      autoImplementationCandidate: frontMatterValue(markdown, "auto_implementation_candidate"),
      securityReviewStatus: reportSecurityReview(markdown).status,
      workCandidate: frontMatterValue(markdown, "work_candidate"),
      workStatus: frontMatterValue(markdown, "work_status"),
      workConfidence: frontMatterValue(markdown, "work_confidence"),
      hasWorkShape: Boolean(workPrompt || workLikelyFiles.length || workValidation.length),
      hasWorkPrompt: Boolean(workPrompt),
      hasWorkValidation: workValidation.length > 0,
      goodFirstIssueOptedOut: options.goodFirstIssueOptedOut === true,
      locked: options.locked === true,
      hasOpenLinkedPullRequest: options.hasOpenLinkedPullRequest === true,
    };
  }

  return {
    nextFeatureShowcaseLabels,
    nextPrStatusLabels,
    prStatusLabelForKind,
    nextRealBehaviorProofSufficientLabels,
    nextRealBehaviorProofMediaLabels,
    realBehaviorProofSufficientLabelsForTest,
    realBehaviorProofMediaLabelsForTest,
    prRatingLabelsForTest,
    prRatingLabelSchemeForTest,
    nextTelegramVisibleProofLabels,
    telegramVisibleProofLabelsForTest,
    priorityLabelForTriage,
    nextPriorityLabels,
    priorityLabelSchemeForTest,
    priorityLabelsForTest,
    nextImpactLabels,
    impactLabelSchemeForTest,
    impactLabelsForTest,
    nextMaturityLabels,
    maturityLabelSchemeForTest,
    maturityLabelsForTest,
    nextMergeRiskLabels,
    mergeRiskLabelSchemeForTest,
    mergeRiskLabelsForTest,
    isIssueAdvisoryLabel,
    isSecuritySensitiveLabel,
    isGoodFirstIssue,
    issueRatingLabelForState,
    wantedIssueAdvisoryLabels,
    issueAdvisoryStateNeedsStaleProtection,
    issueAdvisoryLabelsHadQueueableProtection,
    nextIssueAdvisoryLabels,
    issueAdvisoryLabelsForTest,
    issueAdvisoryLabelStateFromReport,
  };
}
