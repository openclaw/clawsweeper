import type { createLabelPolicy } from "./clawsweeper-label-policy.js";
import type { SecurityReview } from "./clawsweeper-types.js";

export interface LabelSynchronizationDependencies {
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
