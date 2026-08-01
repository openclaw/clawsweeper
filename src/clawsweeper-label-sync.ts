import { IDEA_ARCHIVE_LABEL } from "./idea-archive-revival.js";
import type { createLabelPolicy } from "./clawsweeper-label-policy.js";
import { nextPrRatingLabels, ratingLabelForTier } from "./clawsweeper-rating.js";
import {
  BULK_FILED_LABEL,
  BULK_FILED_LABEL_DEFINITION,
  FEATURE_SHOWCASE_LABEL,
  FEATURE_SHOWCASE_LABEL_COLOR,
  FEATURE_SHOWCASE_LABEL_DESCRIPTION,
  GOOD_FIRST_ISSUE_LABEL,
  GOOD_FIRST_ISSUE_LABEL_DEFINITION,
  IDEA_ARCHIVE_LABEL_COLOR,
  IDEA_ARCHIVE_LABEL_DESCRIPTION,
  IMPACT_LABELS,
  IMPACT_LABEL_NAMES,
  ISSUE_ADVISORY_LABELS,
  ISSUE_ADVISORY_LABEL_NAMES,
  ISSUE_STALE_PROTECTION_LABEL,
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
  PROOF_SUFFICIENT_LABEL_COLOR,
  PROOF_SUFFICIENT_LABEL_DESCRIPTION,
  PR_RATING_LABELS,
  PR_RATING_LABEL_NAMES,
  PR_RATING_TIERS,
  PR_STATUS_LABEL_NAMES,
  QUEUEABLE_FIX_LABEL,
  REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS,
  REAL_BEHAVIOR_PROOF_STATUSES,
  STALE_LABEL,
  TELEGRAM_VISIBLE_PROOF_LABEL,
  TELEGRAM_VISIBLE_PROOF_LABEL_COLOR,
  TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION,
  TELEGRAM_VISIBLE_PROOF_STATUSES,
  TRIAGE_PRIORITIES,
} from "./clawsweeper-policy.js";
import type {
  FeatureShowcase,
  ImpactLabelName,
  IssueAdvisoryLabelState,
  MaturityLabelName,
  MergeRiskLabelName,
  OverallCorrectness,
  PrRating,
  PrRatingTier,
  PrStatusLabelKind,
  RealBehaviorProof,
  RealBehaviorProofEvidenceKind,
  RealBehaviorProofStatus,
  SecurityReview,
  TelegramVisibleProof,
  TelegramVisibleProofStatus,
  TriagePriority,
} from "./clawsweeper-types.js";

interface LabelSynchronizationDependencies {
  ghObservedMutationCommand: (options: {
    identity: string;
    args: string[];
    attempts?: number | undefined;
    onMutation?: (() => void) | undefined;
    knownNoMutation?: ((error: unknown) => boolean) | undefined;
  }) => string;
  hasNormalizedLabel: (labels: readonly string[], label: string) => boolean;
  normalizeLabelName: (label: string) => string;
  protectedLabels: (labels: readonly string[]) => string[];
  isBulkFilerExemptAuthorAssociation: (value: unknown) => boolean;
  isBulkFilerExemptRepositoryPermission: (value: unknown) => boolean;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  frontMatterStringArray: (markdown: string, key: string) => string[];
  reportSecurityReview: (markdown: string) => SecurityReview;
  reviewSectionValue: (markdown: string, section: "repairWorkPrompt") => string;
  labelPolicy: ReturnType<typeof createLabelPolicy>;
}

export function createLabelSynchronization({
  ghObservedMutationCommand,
  hasNormalizedLabel,
  normalizeLabelName,
  protectedLabels,
  isBulkFilerExemptAuthorAssociation,
  isBulkFilerExemptRepositoryPermission,
  frontMatterValue,
  frontMatterStringArray,
  reportSecurityReview,
  reviewSectionValue,
  labelPolicy,
}: LabelSynchronizationDependencies) {
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

  function removeIssueLabel(number: number, label: string, onMutation?: () => void): void {
    ghObservedMutationCommand({
      identity: `issue_label_remove:${number}:${label}`,
      args: ["issue", "edit", String(number), "--remove-label", label],
      onMutation,
    });
  }

  function addIssueLabel(number: number, label: string, onMutation?: () => void): void {
    ghObservedMutationCommand({
      identity: `issue_label_add:${number}:${label}`,
      args: ["issue", "edit", String(number), "--add-label", label],
      onMutation,
      knownNoMutation: (error) => missingLabelError(error, label) || labelCapacityError(error),
    });
  }

  function labelAlreadyExistsError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /already exists/i.test(message);
  }

  function isGitHubLabelAlreadyExistsErrorForTest(message: string): boolean {
    return labelAlreadyExistsError(new Error(message));
  }

  function ensurePriorityLabel(label: PriorityLabelSpec, onMutation?: () => void): void {
    try {
      ghObservedMutationCommand({
        identity: `label_create:${label.name}`,
        args: [
          "label",
          "create",
          label.name,
          "--color",
          label.color,
          "--description",
          label.description,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
  }

  function ensureImpactLabel(name: ImpactLabelName, onMutation?: () => void): void {
    const definition = IMPACT_LABELS.find((label) => label.name === name);
    if (!definition) return;
    try {
      ghObservedMutationCommand({
        identity: `label_create:${definition.name}`,
        args: [
          "label",
          "create",
          definition.name,
          "--color",
          definition.color,
          "--description",
          definition.description,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
  }

  function ensureBulkFilerLabel(onMutation?: () => void): void {
    try {
      ghObservedMutationCommand({
        identity: `label_create:${BULK_FILED_LABEL_DEFINITION.name}`,
        args: [
          "label",
          "create",
          BULK_FILED_LABEL_DEFINITION.name,
          "--color",
          BULK_FILED_LABEL_DEFINITION.color,
          "--description",
          BULK_FILED_LABEL_DEFINITION.description,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
  }

  function syncBulkFilerLabel(options: {
    number: number;
    labels: readonly string[];
    bulkFilerDetected: boolean;
    authorAssociation: string;
    repositoryPermission?: string | null;
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const hasBulkFilerLabel = hasNormalizedLabel(options.labels, BULK_FILED_LABEL);
    if (
      isBulkFilerExemptAuthorAssociation(options.authorAssociation) ||
      isBulkFilerExemptRepositoryPermission(options.repositoryPermission)
    ) {
      if (!hasBulkFilerLabel) return { labels: [...options.labels], changed: false };
      // This is ClawSweeper policy state, not a human triage label. Remove a
      // pre-exemption value so owners and members are not still deprioritized.
      const nextLabels = options.labels.filter(
        (label) => normalizeLabelName(label) !== normalizeLabelName(BULK_FILED_LABEL),
      );
      if (options.dryRun) return { labels: nextLabels, changed: true };
      removeIssueLabel(options.number, BULK_FILED_LABEL, options.onMutation);
      return { labels: nextLabels, changed: true };
    }
    if (!options.bulkFilerDetected || hasBulkFilerLabel) {
      return { labels: [...options.labels], changed: false };
    }
    const nextLabels = [...options.labels, BULK_FILED_LABEL];
    if (options.dryRun) return { labels: nextLabels, changed: true };
    ensureBulkFilerLabel(options.onMutation);
    const applied = tryAddOptionalLabel({
      number: options.number,
      label: BULK_FILED_LABEL,
      currentLabels: options.labels,
      onMutation: options.onMutation,
    });
    return { labels: applied ? nextLabels : [...options.labels], changed: applied };
  }

  function syncBulkFilerLabelForTest(options: {
    number: number;
    labels: readonly string[];
    bulkFilerDetected: boolean;
    authorAssociation: string;
    repositoryPermission?: string | null;
    dryRun: boolean;
  }): { labels: string[]; changed: boolean } {
    return syncBulkFilerLabel(options);
  }

  function ensureMergeRiskLabel(name: MergeRiskLabelName, onMutation?: () => void): void {
    const definition = MERGE_RISK_LABELS.find((label) => label.name === name);
    if (!definition) return;
    try {
      ghObservedMutationCommand({
        identity: `label_create:${definition.name}`,
        args: [
          "label",
          "create",
          definition.name,
          "--color",
          definition.color,
          "--description",
          definition.description,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
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

  function ensureIssueAdvisorySyncLabel(name: string, onMutation?: () => void): void {
    const definition =
      ISSUE_ADVISORY_LABELS.find((label) => label.name === name) ??
      (name.toLowerCase() === GOOD_FIRST_ISSUE_LABEL
        ? GOOD_FIRST_ISSUE_LABEL_DEFINITION
        : undefined) ??
      (name.toLowerCase() === ISSUE_STALE_PROTECTION_LABEL.name
        ? ISSUE_STALE_PROTECTION_LABEL
        : undefined);
    if (!definition) return;
    try {
      ghObservedMutationCommand({
        identity: `label_create:${definition.name}`,
        args: [
          "label",
          "create",
          definition.name,
          "--color",
          definition.color,
          "--description",
          definition.description,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
  }

  function ensureMaturityLabel(name: MaturityLabelName, onMutation?: () => void): void {
    const definition = MATURITY_LABELS.find((label) => label.name === name);
    if (!definition) return;
    try {
      ghObservedMutationCommand({
        identity: `label_create:${definition.name}`,
        args: [
          "label",
          "create",
          definition.name,
          "--color",
          definition.color,
          "--description",
          definition.description,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
  }

  function syncPriorityLabel(options: {
    number: number;
    labels: readonly string[];
    triagePriority: TriagePriority;
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextPriorityLabels(options.labels, options.triagePriority);
    const labelsToRemove = options.labels.filter(
      (label) => PRIORITY_LABEL_NAMES.has(label) && !nextLabels.includes(label),
    );
    const labelToAdd = nextLabels.find(
      (label) => PRIORITY_LABEL_NAMES.has(label) && !options.labels.includes(label),
    );
    const changed = labelsToRemove.length > 0 || Boolean(labelToAdd);
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    if (labelToAdd) {
      const priorityLabel = PRIORITY_LABELS.find((label) => label.name === labelToAdd);
      if (priorityLabel) ensurePriorityLabel(priorityLabel, options.onMutation);
    }
    for (const label of labelsToRemove) {
      removeIssueLabel(options.number, label, options.onMutation);
    }
    const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
    const added =
      labelToAdd !== undefined &&
      tryAddOptionalLabel({
        number: options.number,
        label: labelToAdd,
        currentLabels: syncedLabels,
        onMutation: options.onMutation,
      });
    if (added) syncedLabels.push(labelToAdd);
    return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
  }

  function syncImpactLabels(options: {
    number: number;
    labels: readonly string[];
    impactLabels: readonly ImpactLabelName[];
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextImpactLabels(options.labels, options.impactLabels);
    const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
    const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
    const labelsToAdd = nextLabels.filter(
      (label): label is ImpactLabelName =>
        IMPACT_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
    );
    const labelsToRemove = options.labels.filter(
      (label) => IMPACT_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
    );
    const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    for (const label of labelsToRemove) {
      removeIssueLabel(options.number, label, options.onMutation);
    }
    const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
    let added = false;
    for (const label of labelsToAdd) {
      ensureImpactLabel(label, options.onMutation);
      if (
        tryAddOptionalLabel({
          number: options.number,
          label,
          currentLabels: syncedLabels,
          onMutation: options.onMutation,
        })
      ) {
        syncedLabels.push(label);
        added = true;
      }
    }
    return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
  }

  function syncMaturityLabels(options: {
    number: number;
    labels: readonly string[];
    maturityLabels: readonly MaturityLabelName[];
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextMaturityLabels(options.labels, options.maturityLabels);
    const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
    const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
    const labelsToAdd = nextLabels.filter(
      (label): label is MaturityLabelName =>
        MATURITY_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
    );
    const labelsToRemove = options.labels.filter(
      (label) => MATURITY_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
    );
    const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    for (const label of labelsToRemove) {
      removeIssueLabel(options.number, label, options.onMutation);
    }
    const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
    let added = false;
    for (const label of labelsToAdd) {
      ensureMaturityLabel(label, options.onMutation);
      if (
        tryAddOptionalLabel({
          number: options.number,
          label,
          currentLabels: syncedLabels,
          onMutation: options.onMutation,
        })
      ) {
        syncedLabels.push(label);
        added = true;
      }
    }
    return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
  }

  function syncMergeRiskLabels(options: {
    number: number;
    labels: readonly string[];
    mergeRiskLabels: readonly MergeRiskLabelName[];
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextMergeRiskLabels(options.labels, options.mergeRiskLabels);
    const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
    const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
    const labelsToAdd = nextLabels.filter(
      (label): label is MergeRiskLabelName =>
        MERGE_RISK_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
    );
    const labelsToRemove = options.labels.filter(
      (label) => MERGE_RISK_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
    );
    const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    for (const label of labelsToRemove) {
      removeIssueLabel(options.number, label, options.onMutation);
    }
    const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
    let added = false;
    for (const label of labelsToAdd) {
      ensureMergeRiskLabel(label, options.onMutation);
      if (
        tryAddOptionalLabel({
          number: options.number,
          label,
          currentLabels: syncedLabels,
          onMutation: options.onMutation,
        })
      ) {
        syncedLabels.push(label);
        added = true;
      }
    }
    return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
  }

  function syncIssueAdvisoryLabels(options: {
    number: number;
    labels: readonly string[];
    state: IssueAdvisoryLabelState;
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextIssueAdvisoryLabels(options.labels, options.state);
    const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
    const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
    const labelsToAdd = nextLabels.filter(
      (label) =>
        (isIssueAdvisoryLabel(label) ||
          label.toLowerCase() === GOOD_FIRST_ISSUE_LABEL ||
          label.toLowerCase() === NO_STALE_LABEL) &&
        !currentLabelKeys.has(label.toLowerCase()),
    );
    const labelsToRemove = options.labels.filter(
      (label) =>
        (isIssueAdvisoryLabel(label) ||
          label.toLowerCase() === STALE_LABEL ||
          label.toLowerCase() === NO_STALE_LABEL) &&
        !nextLabelKeys.has(label.toLowerCase()),
    );
    const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    for (const label of labelsToRemove) {
      removeIssueLabel(options.number, label, options.onMutation);
    }
    const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
    let added = false;
    for (const label of labelsToAdd) {
      ensureIssueAdvisorySyncLabel(label, options.onMutation);
      if (
        tryAddOptionalLabel({
          number: options.number,
          label,
          currentLabels: syncedLabels,
          onMutation: options.onMutation,
        })
      ) {
        syncedLabels.push(label);
        added = true;
      }
    }
    return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
  }

  function syncTelegramVisibleProofLabel(options: {
    number: number;
    labels: readonly string[];
    proof: Pick<TelegramVisibleProof, "status">;
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextTelegramVisibleProofLabels(options.labels, options.proof);
    const hadLabel = options.labels.includes(TELEGRAM_VISIBLE_PROOF_LABEL);
    const wantsLabel = nextLabels.includes(TELEGRAM_VISIBLE_PROOF_LABEL);
    const changed = hadLabel !== wantsLabel;
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    if (wantsLabel) ensureTelegramVisibleProofLabel(options.onMutation);
    if (wantsLabel) {
      if (
        !tryAddOptionalLabel({
          number: options.number,
          label: TELEGRAM_VISIBLE_PROOF_LABEL,
          currentLabels: options.labels,
          onMutation: options.onMutation,
        })
      ) {
        return { labels: [...options.labels], changed: false };
      }
    } else {
      removeIssueLabel(options.number, TELEGRAM_VISIBLE_PROOF_LABEL, options.onMutation);
    }
    return { labels: nextLabels, changed };
  }

  function ensurePrRatingLabel(tier: PrRatingTier, onMutation?: () => void): void {
    const definition = ratingLabelForTier(tier);
    try {
      ghObservedMutationCommand({
        identity: `label_create:${definition.name}`,
        args: [
          "label",
          "create",
          definition.name,
          "--color",
          definition.color,
          "--description",
          definition.description,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
  }

  function ensureFeatureShowcaseLabel(onMutation?: () => void): void {
    try {
      ghObservedMutationCommand({
        identity: `label_create:${FEATURE_SHOWCASE_LABEL}`,
        args: [
          "label",
          "create",
          FEATURE_SHOWCASE_LABEL,
          "--color",
          FEATURE_SHOWCASE_LABEL_COLOR,
          "--description",
          FEATURE_SHOWCASE_LABEL_DESCRIPTION,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
  }

  function ensurePrStatusLabel(kind: PrStatusLabelKind, onMutation?: () => void): void {
    const definition = prStatusLabelForKind(kind);
    try {
      ghObservedMutationCommand({
        identity: `label_create:${definition.name}`,
        args: [
          "label",
          "create",
          definition.name,
          "--color",
          definition.color,
          "--description",
          definition.description,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
  }

  function syncFeatureShowcaseLabel(options: {
    number: number;
    labels: readonly string[];
    isPullRequest: boolean;
    itemCategory: string | undefined;
    requiresNewFeature: boolean;
    showcase: FeatureShowcase;
    securityReview: Pick<SecurityReview, "status">;
    overallCorrectness: OverallCorrectness;
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextFeatureShowcaseLabels(options.labels, options);
    const changed =
      nextLabels.includes(FEATURE_SHOWCASE_LABEL) &&
      !options.labels.includes(FEATURE_SHOWCASE_LABEL);
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    ensureFeatureShowcaseLabel(options.onMutation);
    if (
      !tryAddOptionalLabel({
        number: options.number,
        label: FEATURE_SHOWCASE_LABEL,
        currentLabels: options.labels,
        onMutation: options.onMutation,
      })
    ) {
      return { labels: [...options.labels], changed: false };
    }
    return { labels: nextLabels, changed };
  }

  function syncPrRatingLabel(options: {
    number: number;
    labels: readonly string[];
    rating: Pick<PrRating, "overallTier">;
    reviewFailed?: boolean;
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextPrRatingLabels(options.labels, options.rating, options.reviewFailed);
    const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
    const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
    const labelsToRemove = options.labels.filter(
      (label) => PR_RATING_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
    );
    const labelToAdd = nextLabels.find(
      (label) => PR_RATING_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
    );
    const changed = labelsToRemove.length > 0 || Boolean(labelToAdd);
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    if (labelToAdd) ensurePrRatingLabel(options.rating.overallTier, options.onMutation);
    for (const label of labelsToRemove) {
      removeIssueLabel(options.number, label, options.onMutation);
    }
    const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
    const added =
      labelToAdd !== undefined &&
      tryAddOptionalLabel({
        number: options.number,
        label: labelToAdd,
        currentLabels: syncedLabels,
        onMutation: options.onMutation,
      });
    if (added) syncedLabels.push(labelToAdd);
    return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
  }

  function syncPrStatusLabel(options: {
    number: number;
    labels: readonly string[];
    statusKind: PrStatusLabelKind | null;
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextPrStatusLabels(options.labels, options.statusKind);
    const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
    const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
    const labelsToRemove = options.labels.filter(
      (label) => PR_STATUS_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
    );
    const labelToAdd = nextLabels.find(
      (label) => PR_STATUS_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
    );
    const changed = labelsToRemove.length > 0 || Boolean(labelToAdd);
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    if (options.statusKind && labelToAdd) {
      ensurePrStatusLabel(options.statusKind, options.onMutation);
    }
    for (const label of labelsToRemove) {
      removeIssueLabel(options.number, label, options.onMutation);
    }
    const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
    const added =
      labelToAdd !== undefined &&
      tryAddOptionalLabel({
        number: options.number,
        label: labelToAdd,
        currentLabels: syncedLabels,
        onMutation: options.onMutation,
      });
    if (added) syncedLabels.push(labelToAdd);
    return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
  }

  function ensureTelegramVisibleProofLabel(onMutation?: () => void): void {
    try {
      ghObservedMutationCommand({
        identity: `label_create:${TELEGRAM_VISIBLE_PROOF_LABEL}`,
        args: [
          "label",
          "create",
          TELEGRAM_VISIBLE_PROOF_LABEL,
          "--color",
          TELEGRAM_VISIBLE_PROOF_LABEL_COLOR,
          "--description",
          TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
  }

  function ensureIdeaArchiveLabel(onMutation?: () => void): void {
    try {
      ghObservedMutationCommand({
        identity: `label_create:${IDEA_ARCHIVE_LABEL}`,
        args: [
          "label",
          "create",
          IDEA_ARCHIVE_LABEL,
          "--color",
          IDEA_ARCHIVE_LABEL_COLOR,
          "--description",
          IDEA_ARCHIVE_LABEL_DESCRIPTION,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
    } catch (error) {
      if (!labelAlreadyExistsError(error)) throw error;
    }
  }

  function missingLabelError(error: unknown, label: string): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(`'${label}' not found`) || message.includes(`"${label}" not found`);
  }

  function labelCapacityError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /labels can have a maximum of 100 labels/i.test(message);
  }

  function tryAddOptionalLabel(options: {
    number: number;
    label: string;
    currentLabels: readonly string[];
    onMutation?: (() => void) | undefined;
  }): boolean {
    if (options.currentLabels.length >= 100) {
      console.warn(
        `Skipping optional label sync for ${options.label}: item ${options.number} already has 100 labels`,
      );
      return false;
    }
    try {
      addIssueLabel(options.number, options.label, options.onMutation);
      return true;
    } catch (error) {
      if (!missingLabelError(error, options.label) && !labelCapacityError(error)) throw error;
      console.warn(
        `Skipping optional label sync for ${options.label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  function isMissingGitHubLabelErrorForTest(message: string, label: string): boolean {
    return missingLabelError(new Error(message), label);
  }

  function isGitHubLabelCapacityErrorForTest(message: string): boolean {
    return labelCapacityError(new Error(message));
  }

  function ensureRealBehaviorProofSufficientLabel(onMutation?: () => void): boolean {
    try {
      ghObservedMutationCommand({
        identity: `label_create:${PROOF_SUFFICIENT_LABEL}`,
        args: [
          "label",
          "create",
          PROOF_SUFFICIENT_LABEL,
          "--color",
          PROOF_SUFFICIENT_LABEL_COLOR,
          "--description",
          PROOF_SUFFICIENT_LABEL_DESCRIPTION,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (labelAlreadyExistsError(error)) return true;
      console.warn(`Skipping optional label sync for ${PROOF_SUFFICIENT_LABEL}: ${message}`);
      return false;
    }
  }

  function ensureRealBehaviorProofMediaLabel(name: string, onMutation?: () => void): boolean {
    const definition = PROOF_MEDIA_LABELS.find((label) => label.name === name);
    if (!definition) return false;
    try {
      ghObservedMutationCommand({
        identity: `label_create:${definition.name}`,
        args: [
          "label",
          "create",
          definition.name,
          "--color",
          definition.color,
          "--description",
          definition.description,
        ],
        attempts: 2,
        onMutation,
        knownNoMutation: labelAlreadyExistsError,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (labelAlreadyExistsError(error)) return true;
      console.warn(`Skipping optional label sync for ${definition.name}: ${message}`);
      return false;
    }
  }

  function syncRealBehaviorProofSufficientLabel(options: {
    number: number;
    labels: readonly string[];
    proof: Pick<RealBehaviorProof, "status">;
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextRealBehaviorProofSufficientLabels(options.labels, options.proof);
    const hadLabel = options.labels.includes(PROOF_SUFFICIENT_LABEL);
    const wantsLabel = nextLabels.includes(PROOF_SUFFICIENT_LABEL);
    const changed = hadLabel !== wantsLabel;
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    if (wantsLabel && !ensureRealBehaviorProofSufficientLabel(options.onMutation)) {
      return { labels: [...options.labels], changed: false };
    }
    if (wantsLabel) {
      if (
        !tryAddOptionalLabel({
          number: options.number,
          label: PROOF_SUFFICIENT_LABEL,
          currentLabels: options.labels,
          onMutation: options.onMutation,
        })
      ) {
        return { labels: [...options.labels], changed: false };
      }
    } else {
      try {
        removeIssueLabel(options.number, PROOF_SUFFICIENT_LABEL, options.onMutation);
      } catch (error) {
        if (!missingLabelError(error, PROOF_SUFFICIENT_LABEL)) throw error;
        console.warn(
          `Skipping optional label sync for ${PROOF_SUFFICIENT_LABEL}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { labels: nextLabels, changed };
  }

  function syncRealBehaviorProofMediaLabels(options: {
    number: number;
    labels: readonly string[];
    proof: Pick<RealBehaviorProof, "evidenceKind">;
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const nextLabels = nextRealBehaviorProofMediaLabels(options.labels, options.proof);
    const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
    const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
    const labelsToAdd = nextLabels.filter(
      (label) => PROOF_MEDIA_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
    );
    const labelsToRemove = options.labels.filter(
      (label) => PROOF_MEDIA_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
    );
    const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    const syncedLabels = [...options.labels];
    for (const label of labelsToRemove) {
      try {
        removeIssueLabel(options.number, label, options.onMutation);
        const index = syncedLabels.indexOf(label);
        if (index >= 0) syncedLabels.splice(index, 1);
      } catch (error) {
        if (!missingLabelError(error, label)) throw error;
        console.warn(
          `Skipping optional label sync for ${label}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    for (const label of labelsToAdd) {
      if (!ensureRealBehaviorProofMediaLabel(label, options.onMutation)) continue;
      if (
        tryAddOptionalLabel({
          number: options.number,
          label,
          currentLabels: syncedLabels,
          onMutation: options.onMutation,
        })
      ) {
        syncedLabels.push(label);
      }
    }
    return {
      labels: syncedLabels,
      changed:
        syncedLabels.length !== options.labels.length ||
        syncedLabels.some((label, index) => label !== options.labels[index]),
    };
  }

  return {
    impactLabelSchemeForTest,
    impactLabelsForTest,
    isGitHubLabelAlreadyExistsErrorForTest,
    isGitHubLabelCapacityErrorForTest,
    isMissingGitHubLabelErrorForTest,
    issueAdvisoryLabelsForTest,
    maturityLabelSchemeForTest,
    maturityLabelsForTest,
    mergeRiskLabelSchemeForTest,
    mergeRiskLabelsForTest,
    priorityLabelSchemeForTest,
    priorityLabelsForTest,
    prRatingLabelSchemeForTest,
    prRatingLabelsForTest,
    realBehaviorProofMediaLabelsForTest,
    realBehaviorProofSufficientLabelsForTest,
    syncBulkFilerLabelForTest,
    telegramVisibleProofLabelsForTest,
    addIssueLabel,
    ensureIdeaArchiveLabel,
    isGoodFirstIssue,
    isIssueAdvisoryLabel,
    issueAdvisoryLabelStateFromReport,
    labelAlreadyExistsError,
    nextImpactLabels,
    nextIssueAdvisoryLabels,
    nextMaturityLabels,
    nextMergeRiskLabels,
    nextPriorityLabels,
    nextRealBehaviorProofMediaLabels,
    nextRealBehaviorProofSufficientLabels,
    nextTelegramVisibleProofLabels,
    removeIssueLabel,
    syncBulkFilerLabel,
    syncFeatureShowcaseLabel,
    syncImpactLabels,
    syncIssueAdvisoryLabels,
    syncMaturityLabels,
    syncMergeRiskLabels,
    syncPriorityLabel,
    syncPrRatingLabel,
    syncPrStatusLabel,
    syncRealBehaviorProofMediaLabels,
    syncRealBehaviorProofSufficientLabel,
    syncTelegramVisibleProofLabel,
  };
}
