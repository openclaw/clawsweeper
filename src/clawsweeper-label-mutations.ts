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
import { compareCodeUnits } from "./stable-json.js";
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
  const { ghJson, ghObservedMutationCommand, normalizeLabelName, prStatusLabelForKind } =
    dependencies;

  type PriorityLabelSpec = NonNullable<
    ReturnType<ReturnType<typeof createLabelSelectionPolicy>["priorityLabelForTriage"]>
  >;

  type LabelDefinition = {
    name: string;
    color: string;
    description: string;
    force?: boolean;
  };

  type PendingIssueLabelBatch = {
    number: number;
    additions: Map<string, string>;
    optionalAdditions: Set<string>;
    optionalDefinitions: Set<string>;
    removals: Map<string, string>;
    definitions: Map<string, LabelDefinition>;
    onMutation?: (() => void) | undefined;
  };

  let pendingIssueLabelBatch: PendingIssueLabelBatch | null = null;
  let repositoryLabelCatalogCache: Map<string, { color: string; description: string }> | null =
    null;

  function beginIssueLabelMutationBatch(number: number): void {
    if (pendingIssueLabelBatch) {
      throw new Error(
        `cannot begin label batch for #${number}; #${pendingIssueLabelBatch.number} is still active`,
      );
    }
    pendingIssueLabelBatch = {
      number,
      additions: new Map(),
      optionalAdditions: new Set(),
      optionalDefinitions: new Set(),
      removals: new Map(),
      definitions: new Map(),
    };
  }

  function discardIssueLabelMutationBatch(number: number): void {
    if (!pendingIssueLabelBatch) return;
    if (pendingIssueLabelBatch.number !== number) {
      throw new Error(
        `cannot discard label batch for #${number}; #${pendingIssueLabelBatch.number} is active`,
      );
    }
    pendingIssueLabelBatch = null;
  }

  function activeIssueLabelBatch(number: number): PendingIssueLabelBatch | null {
    if (!pendingIssueLabelBatch) return null;
    if (pendingIssueLabelBatch.number !== number) {
      throw new Error(
        `label mutation for #${number} cannot join active batch for #${pendingIssueLabelBatch.number}`,
      );
    }
    return pendingIssueLabelBatch;
  }

  function rememberBatchMutationCallback(
    batch: PendingIssueLabelBatch,
    onMutation: (() => void) | undefined,
  ): void {
    batch.onMutation ??= onMutation;
  }

  function queueIssueLabelMutation(
    batch: PendingIssueLabelBatch,
    kind: "add" | "remove",
    label: string,
    onMutation?: () => void,
    optional = false,
  ): void {
    if (label.includes(",")) {
      throw new Error(`cannot batch GitHub label containing a comma: ${label}`);
    }
    rememberBatchMutationCallback(batch, onMutation);
    const key = normalizeLabelName(label);
    const same = kind === "add" ? batch.additions : batch.removals;
    const opposite = kind === "add" ? batch.removals : batch.additions;
    opposite.delete(key);
    same.set(key, label);
    if (kind === "add" && optional) batch.optionalAdditions.add(key);
    else batch.optionalAdditions.delete(key);
  }

  function queueLabelDefinition(
    batch: PendingIssueLabelBatch,
    definition: LabelDefinition,
    onMutation?: () => void,
    optional = false,
  ): void {
    rememberBatchMutationCallback(batch, onMutation);
    const key = normalizeLabelName(definition.name);
    const previous = batch.definitions.get(key);
    batch.definitions.set(key, {
      ...definition,
      force: Boolean(previous?.force || definition.force),
    });
    if (optional && !previous) batch.optionalDefinitions.add(key);
    else if (!optional) batch.optionalDefinitions.delete(key);
  }

  function labelDefinitionMatches(
    current: { color: string; description: string },
    expected: LabelDefinition,
  ): boolean {
    return (
      current.color.toLowerCase() === expected.color.replace(/^#/, "").toLowerCase() &&
      current.description === expected.description
    );
  }

  function repositoryLabelCatalog(): Map<string, { color: string; description: string }> {
    if (repositoryLabelCatalogCache) return repositoryLabelCatalogCache;
    const raw = ghJson<unknown>([
      "label",
      "list",
      "--limit",
      "1000",
      "--json",
      "name,color,description",
    ]);
    if (!Array.isArray(raw)) throw new Error("GitHub label catalog was not an array");
    const catalog = new Map<string, { color: string; description: string }>();
    for (const value of raw) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const label = value as Record<string, unknown>;
      if (typeof label.name !== "string" || typeof label.color !== "string") continue;
      catalog.set(normalizeLabelName(label.name), {
        color: label.color,
        description: typeof label.description === "string" ? label.description : "",
      });
    }
    repositoryLabelCatalogCache = catalog;
    return repositoryLabelCatalogCache;
  }

  function ensureLabelDefinitionNow(definition: LabelDefinition, onMutation?: () => void): boolean {
    const force = definition.force === true;
    try {
      ghObservedMutationCommand({
        identity: `${force ? "label_upsert" : "label_create"}:${definition.name}`,
        args: [
          "label",
          "create",
          definition.name,
          ...(force ? ["--force"] : []),
          "--color",
          definition.color,
          "--description",
          definition.description,
        ],
        attempts: 2,
        onMutation,
        ...(force ? {} : { knownNoMutation: labelAlreadyExistsError }),
      });
      return true;
    } catch (error) {
      if (force || !labelAlreadyExistsError(error)) throw error;
      return false;
    }
  }

  function ensureLabelDefinition(
    definition: LabelDefinition,
    onMutation?: () => void,
    optional = false,
  ): void {
    const batch = pendingIssueLabelBatch;
    if (batch) {
      queueLabelDefinition(batch, definition, onMutation, optional);
      return;
    }
    ensureLabelDefinitionNow(definition, onMutation);
  }

  function flushIssueLabelMutationBatch(
    number: number,
    beforeItemMutation?: () => void,
    afterItemMutation?: (confirmed: boolean) => void,
  ): {
    itemMutationPublished: boolean;
    repositoryDefinitionMutated: boolean;
    skippedAdditions: string[];
  } {
    const batch = activeIssueLabelBatch(number);
    if (!batch) {
      return {
        itemMutationPublished: false,
        repositoryDefinitionMutated: false,
        skippedAdditions: [],
      };
    }
    pendingIssueLabelBatch = null;
    // Recorded mutation identities must not depend on locale or collator ties.
    let additions = [...batch.additions.values()].sort(compareCodeUnits);
    const removals = [...batch.removals.values()].sort(compareCodeUnits);
    const definitionKeys = new Set(additions.map((label) => normalizeLabelName(label)));
    for (const [key, definition] of batch.definitions) {
      if (definition.force) definitionKeys.add(key);
    }
    let definitionMutated = false;
    const skippedAdditions: string[] = [];
    if (definitionKeys.size > 0) {
      const catalog = repositoryLabelCatalog();
      for (const key of definitionKeys) {
        const definition = batch.definitions.get(key);
        if (!definition) continue;
        const current = catalog.get(key);
        if (!current || (definition.force && !labelDefinitionMatches(current, definition))) {
          try {
            definitionMutated =
              ensureLabelDefinitionNow(definition, batch.onMutation) || definitionMutated;
          } catch (error) {
            if (
              !batch.optionalDefinitions.has(key) ||
              !batch.optionalAdditions.has(key) ||
              (error instanceof Error && error.name === "ApplyMutationReviewGuardError")
            ) {
              throw error;
            }
            const skippedLabel = batch.additions.get(key);
            if (skippedLabel) skippedAdditions.push(skippedLabel);
            additions = additions.filter((label) => normalizeLabelName(label) !== key);
            console.warn(
              `Skipping optional label sync for ${definition.name}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            continue;
          }
          catalog.set(key, {
            color: definition.color.replace(/^#/, ""),
            description: definition.description,
          });
        }
      }
    }

    if (additions.length === 0 && removals.length === 0) {
      return {
        itemMutationPublished: false,
        repositoryDefinitionMutated: definitionMutated,
        skippedAdditions,
      };
    }

    const args = ["issue", "edit", String(number)];
    if (additions.length > 0) args.push("--add-label", additions.join(","));
    if (removals.length > 0) args.push("--remove-label", removals.join(","));
    const isOptionalFailure = (error: unknown): boolean =>
      labelCapacityError(error) ||
      additions.some(
        (label) =>
          batch.optionalAdditions.has(normalizeLabelName(label)) && missingLabelError(error, label),
      );
    try {
      beforeItemMutation?.();
      ghObservedMutationCommand({
        identity: `issue_labels_sync:${number}:add=${additions.join("|")}:remove=${removals.join("|")}`,
        args,
        onMutation: batch.onMutation,
      });
      afterItemMutation?.(true);
      return {
        itemMutationPublished: true,
        repositoryDefinitionMutated: definitionMutated,
        skippedAdditions,
      };
    } catch (error) {
      if (!isOptionalFailure(error)) throw error;
      // `gh issue edit` can apply removals before a missing optional addition
      // makes the command exit nonzero. Refresh the live self-mutation receipt
      // before any guarded fallback command, but do not claim a confirmed label
      // sync unless a fallback succeeds.
      afterItemMutation?.(false);
      console.warn(
        `Combined optional label sync for item ${number} failed; retrying its final operations individually: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      let itemMutationPublished = false;
      if (removals.length > 0) {
        beforeItemMutation?.();
        ghObservedMutationCommand({
          identity: `issue_labels_sync_fallback_remove:${number}:${removals.join("|")}`,
          args: ["issue", "edit", String(number), "--remove-label", removals.join(",")],
          onMutation: batch.onMutation,
        });
        afterItemMutation?.(true);
        itemMutationPublished = true;
      }
      const fallbackAdditions = [
        ...additions.filter((label) => !batch.optionalAdditions.has(normalizeLabelName(label))),
        ...additions.filter((label) => batch.optionalAdditions.has(normalizeLabelName(label))),
      ];
      for (const label of fallbackAdditions) {
        const optional = batch.optionalAdditions.has(normalizeLabelName(label));
        try {
          beforeItemMutation?.();
          ghObservedMutationCommand({
            identity: `issue_labels_sync_fallback_add:${number}:${label}`,
            args: ["issue", "edit", String(number), "--add-label", label],
            onMutation: batch.onMutation,
            knownNoMutation: (fallbackError) =>
              optional &&
              (missingLabelError(fallbackError, label) || labelCapacityError(fallbackError)),
          });
          afterItemMutation?.(true);
          itemMutationPublished = true;
        } catch (fallbackError) {
          if (
            !optional ||
            (!missingLabelError(fallbackError, label) && !labelCapacityError(fallbackError))
          ) {
            throw fallbackError;
          }
          skippedAdditions.push(label);
          console.warn(
            `Skipping optional label sync for ${label}: ${
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            }`,
          );
        }
      }
      return {
        itemMutationPublished,
        repositoryDefinitionMutated: definitionMutated,
        skippedAdditions,
      };
    }
  }

  function removeIssueLabel(number: number, label: string, onMutation?: () => void): void {
    const batch = activeIssueLabelBatch(number);
    if (batch) {
      queueIssueLabelMutation(batch, "remove", label, onMutation);
      return;
    }
    ghObservedMutationCommand({
      identity: `issue_label_remove:${number}:${label}`,
      args: ["issue", "edit", String(number), "--remove-label", label],
      onMutation,
    });
  }
  function addIssueLabel(number: number, label: string, onMutation?: () => void): void {
    const batch = activeIssueLabelBatch(number);
    if (batch) {
      queueIssueLabelMutation(batch, "add", label, onMutation);
      return;
    }
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
    ensureLabelDefinition(label, onMutation);
  }
  function ensureImpactLabel(name: ImpactLabelName, onMutation?: () => void): void {
    const definition = IMPACT_LABELS.find((label) => label.name === name);
    if (!definition) return;
    ensureLabelDefinition(definition, onMutation);
  }
  function ensureBulkFilerLabel(onMutation?: () => void): void {
    ensureLabelDefinition(BULK_FILED_LABEL_DEFINITION, onMutation);
  }
  function ensureMergeRiskLabel(name: MergeRiskLabelName, onMutation?: () => void): void {
    const definition = MERGE_RISK_LABELS.find((label) => label.name === name);
    if (!definition) return;
    ensureLabelDefinition(definition, onMutation);
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
    ensureLabelDefinition(definition, onMutation);
  }
  function ensureMaturityLabel(name: MaturityLabelName, onMutation?: () => void): void {
    const definition = MATURITY_LABELS.find((label) => label.name === name);
    if (!definition) return;
    ensureLabelDefinition({ ...definition, force: true }, onMutation);
  }
  function ensurePrRatingLabel(tier: PrRatingTier, onMutation?: () => void): void {
    const definition = ratingLabelForTier(tier);
    ensureLabelDefinition(definition, onMutation);
  }
  function ensureFeatureShowcaseLabel(onMutation?: () => void): void {
    ensureLabelDefinition(
      {
        name: FEATURE_SHOWCASE_LABEL,
        color: FEATURE_SHOWCASE_LABEL_COLOR,
        description: FEATURE_SHOWCASE_LABEL_DESCRIPTION,
      },
      onMutation,
    );
  }
  function ensurePrStatusLabel(kind: PrStatusLabelKind, onMutation?: () => void): void {
    const definition = prStatusLabelForKind(kind);
    ensureLabelDefinition(definition, onMutation);
  }
  function ensureTelegramVisibleProofLabel(onMutation?: () => void): void {
    ensureLabelDefinition(
      {
        name: TELEGRAM_VISIBLE_PROOF_LABEL,
        color: TELEGRAM_VISIBLE_PROOF_LABEL_COLOR,
        description: TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION,
      },
      onMutation,
    );
  }
  function ensureIdeaArchiveLabel(onMutation?: () => void): void {
    ensureLabelDefinition(
      {
        name: IDEA_ARCHIVE_LABEL,
        color: IDEA_ARCHIVE_LABEL_COLOR,
        description: IDEA_ARCHIVE_LABEL_DESCRIPTION,
      },
      onMutation,
    );
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
    const batch = activeIssueLabelBatch(options.number);
    if (batch) {
      queueIssueLabelMutation(batch, "add", options.label, options.onMutation, true);
      return true;
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
      ensureLabelDefinition(
        {
          name: PROOF_SUFFICIENT_LABEL,
          color: PROOF_SUFFICIENT_LABEL_COLOR,
          description: PROOF_SUFFICIENT_LABEL_DESCRIPTION,
        },
        onMutation,
        true,
      );
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
      ensureLabelDefinition(definition, onMutation, true);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (labelAlreadyExistsError(error)) return true;
      console.warn(`Skipping optional label sync for ${definition.name}: ${message}`);
      return false;
    }
  }

  return {
    beginIssueLabelMutationBatch,
    discardIssueLabelMutationBatch,
    flushIssueLabelMutationBatch,
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
