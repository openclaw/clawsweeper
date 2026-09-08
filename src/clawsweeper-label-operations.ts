import { nextPrRatingLabels } from "./clawsweeper-rating.js";
import {
  BULK_FILED_LABEL,
  FEATURE_SHOWCASE_LABEL,
  GOOD_FIRST_ISSUE_LABEL,
  IMPACT_LABEL_NAMES,
  LEGACY_TELEGRAM_VISIBLE_PROOF_LABEL,
  MATURITY_LABEL_NAMES,
  MERGE_RISK_LABEL_NAMES,
  NO_STALE_LABEL,
  PRIORITY_LABELS,
  PRIORITY_LABEL_NAMES,
  PROOF_MEDIA_LABEL_NAMES,
  PROOF_SUFFICIENT_LABEL,
  PR_RATING_LABEL_NAMES,
  PR_STATUS_LABEL_NAMES,
  STALE_LABEL,
  TELEGRAM_VISIBLE_PROOF_LABEL,
} from "./clawsweeper-policy.js";
import type {
  FeatureShowcase,
  ImpactLabelName,
  IssueAdvisoryLabelState,
  MaturityLabelName,
  MergeRiskLabelName,
  OverallCorrectness,
  PrRating,
  PrStatusLabelKind,
  RealBehaviorProof,
  SecurityReview,
  TelegramVisibleProof,
  TriagePriority,
} from "./clawsweeper-types.js";
import type { LabelSynchronizationDependencies } from "./clawsweeper-label-dependencies.js";
import type { createLabelSelectionPolicy } from "./clawsweeper-label-selection.js";
import type { createLabelMutationOperations } from "./clawsweeper-label-mutations.js";

export function createLabelSyncOperations(
  dependencies: LabelSynchronizationDependencies &
    ReturnType<typeof createLabelSelectionPolicy> &
    ReturnType<typeof createLabelMutationOperations>,
) {
  const {
    hasNormalizedLabel,
    normalizeLabelName,
    isBulkFilerExemptAuthorAssociation,
    isBulkFilerExemptRepositoryPermission,
    nextFeatureShowcaseLabels,
    nextPrStatusLabels,
    nextRealBehaviorProofSufficientLabels,
    nextRealBehaviorProofMediaLabels,
    nextTelegramVisibleProofLabels,
    nextPriorityLabels,
    nextImpactLabels,
    nextMaturityLabels,
    nextMergeRiskLabels,
    isIssueAdvisoryLabel,
    nextIssueAdvisoryLabels,
    removeIssueLabel,
    ensurePriorityLabel,
    ensureImpactLabel,
    ensureBulkFilerLabel,
    ensureMergeRiskLabel,
    ensureIssueAdvisorySyncLabel,
    ensureMaturityLabel,
    ensurePrRatingLabel,
    ensureFeatureShowcaseLabel,
    ensurePrStatusLabel,
    ensureTelegramVisibleProofLabel,
    missingLabelError,
    tryAddOptionalLabel,
    ensureRealBehaviorProofSufficientLabel,
    ensureRealBehaviorProofMediaLabel,
  } = dependencies;

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
  function syncOwnedLabels<LabelName extends string>(options: {
    number: number;
    labels: readonly string[];
    nextLabels: string[];
    ownedLabelNames: ReadonlySet<string>;
    dryRun: boolean;
    onMutation?: () => void;
    ensureLabel: (label: LabelName, onMutation?: () => void) => void;
  }): { labels: string[]; changed: boolean } {
    const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
    const nextLabelKeys = new Set(options.nextLabels.map((label) => label.toLowerCase()));
    const labelsToAdd = options.nextLabels.filter(
      (label): label is LabelName =>
        options.ownedLabelNames.has(label) && !currentLabelKeys.has(label.toLowerCase()),
    );
    const labelsToRemove = options.labels.filter(
      (label) => options.ownedLabelNames.has(label) && !nextLabelKeys.has(label.toLowerCase()),
    );
    const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
    if (!changed) return { labels: options.nextLabels, changed };
    if (options.dryRun) return { labels: options.nextLabels, changed };
    for (const label of labelsToRemove) {
      removeIssueLabel(options.number, label, options.onMutation);
    }
    const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
    let added = false;
    for (const label of labelsToAdd) {
      options.ensureLabel(label, options.onMutation);
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
  function syncImpactLabels(options: {
    number: number;
    labels: readonly string[];
    impactLabels: readonly ImpactLabelName[];
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    return syncOwnedLabels<ImpactLabelName>({
      ...options,
      nextLabels: nextImpactLabels(options.labels, options.impactLabels),
      ownedLabelNames: IMPACT_LABEL_NAMES,
      ensureLabel: ensureImpactLabel,
    });
  }
  function syncMaturityLabels(options: {
    number: number;
    labels: readonly string[];
    maturityLabels: readonly MaturityLabelName[];
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    return syncOwnedLabels<MaturityLabelName>({
      ...options,
      nextLabels: nextMaturityLabels(options.labels, options.maturityLabels),
      ownedLabelNames: MATURITY_LABEL_NAMES,
      ensureLabel: ensureMaturityLabel,
    });
  }
  function syncMergeRiskLabels(options: {
    number: number;
    labels: readonly string[];
    mergeRiskLabels: readonly MergeRiskLabelName[];
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    return syncOwnedLabels<MergeRiskLabelName>({
      ...options,
      nextLabels: nextMergeRiskLabels(options.labels, options.mergeRiskLabels),
      ownedLabelNames: MERGE_RISK_LABEL_NAMES,
      ensureLabel: ensureMergeRiskLabel,
    });
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
    const hadLegacyLabel = options.labels.includes(LEGACY_TELEGRAM_VISIBLE_PROOF_LABEL);
    const wantsLabel = nextLabels.includes(TELEGRAM_VISIBLE_PROOF_LABEL);
    const changed = hadLegacyLabel || hadLabel !== wantsLabel;
    if (!changed) return { labels: nextLabels, changed };
    if (options.dryRun) return { labels: nextLabels, changed };
    if (wantsLabel && !hadLabel) {
      ensureTelegramVisibleProofLabel(options.onMutation);
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
    }
    if (!wantsLabel && hadLabel) {
      removeIssueLabel(options.number, TELEGRAM_VISIBLE_PROOF_LABEL, options.onMutation);
    }
    if (hadLegacyLabel) {
      removeIssueLabel(options.number, LEGACY_TELEGRAM_VISIBLE_PROOF_LABEL, options.onMutation);
    }
    return { labels: nextLabels, changed };
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
    syncBulkFilerLabel,
    syncBulkFilerLabelForTest,
    syncPriorityLabel,
    syncImpactLabels,
    syncMaturityLabels,
    syncMergeRiskLabels,
    syncIssueAdvisoryLabels,
    syncTelegramVisibleProofLabel,
    syncFeatureShowcaseLabel,
    syncPrRatingLabel,
    syncPrStatusLabel,
    syncRealBehaviorProofSufficientLabel,
    syncRealBehaviorProofMediaLabels,
  };
}
