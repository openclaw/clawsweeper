import { IDEA_ARCHIVE_LABEL } from "./idea-archive-revival.js";
import { ratingLabelForTier } from "./clawsweeper-rating.js";
import {
  BULK_FILED_LABEL_DEFINITION,
  FEATURE_SHOWCASE_LABEL,
  FEATURE_SHOWCASE_LABEL_COLOR,
  FEATURE_SHOWCASE_LABEL_DESCRIPTION,
  GOOD_FIRST_ISSUE_LABEL,
  GOOD_FIRST_ISSUE_LABEL_DEFINITION,
  IDEA_ARCHIVE_LABEL_COLOR,
  IDEA_ARCHIVE_LABEL_DESCRIPTION,
  IMPACT_LABELS,
  ISSUE_ADVISORY_LABELS,
  ISSUE_STALE_PROTECTION_LABEL,
  MATURITY_LABELS,
  MERGE_RISK_LABELS,
  PROOF_MEDIA_LABELS,
  PROOF_SUFFICIENT_LABEL,
  PROOF_SUFFICIENT_LABEL_COLOR,
  PROOF_SUFFICIENT_LABEL_DESCRIPTION,
  TELEGRAM_VISIBLE_PROOF_LABEL,
  TELEGRAM_VISIBLE_PROOF_LABEL_COLOR,
  TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION,
} from "./clawsweeper-policy.js";
import type {
  ImpactLabelName,
  MaturityLabelName,
  MergeRiskLabelName,
  PrRatingTier,
  PrStatusLabelKind,
} from "./clawsweeper-types.js";
import type { LabelSynchronizationDependencies } from "./clawsweeper-label-dependencies.js";
import type { createLabelSelectionPolicy } from "./clawsweeper-label-selection.js";

export function createLabelMutationOperations(
  dependencies: LabelSynchronizationDependencies & ReturnType<typeof createLabelSelectionPolicy>,
) {
  const { ghObservedMutationCommand, prStatusLabelForKind } = dependencies;

  type PriorityLabelSpec = NonNullable<
    ReturnType<ReturnType<typeof createLabelSelectionPolicy>["priorityLabelForTriage"]>
  >;

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

  return {
    removeIssueLabel,
    addIssueLabel,
    labelAlreadyExistsError,
    isGitHubLabelAlreadyExistsErrorForTest,
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
    ensureIdeaArchiveLabel,
    missingLabelError,
    labelCapacityError,
    tryAddOptionalLabel,
    isMissingGitHubLabelErrorForTest,
    isGitHubLabelCapacityErrorForTest,
    ensureRealBehaviorProofSufficientLabel,
    ensureRealBehaviorProofMediaLabel,
  };
}
