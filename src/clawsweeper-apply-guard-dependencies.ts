import type { Item, PrRating, RealBehaviorProof } from "./clawsweeper-types.js";

export interface ApplyGuardDependencies {
  authorPrBudget: () => number;
  authorPrBudgetAgeSkipReason: (item: Pick<Item, "createdAt">, now?: number) => string | null;
  authorPrBudgetCloseEnabled: () => boolean;
  ghJson: <T>(args: string[]) => T;
  ghPaged: <T>(path: string) => T[];
  isMaintainerAuthorAssociation: (value: unknown) => boolean;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  labelNames: (value: unknown) => string[];
  normalizeLabelName: (label: string) => string;
  obsoleteFixPrAgeSkipReason: (item: Pick<Item, "createdAt">, now?: number) => string | null;
  obsoleteFixPrCloseEnabled: () => boolean;
  protectedLabels: (labels: readonly string[]) => string[];
  quoteGitHubSearchTerm: (term: string) => string;
  reportPrRating: (markdown: string) => PrRating;
  reportRealBehaviorProof: (markdown: string) => RealBehaviorProof;
  staleVersionBugAgeSkipReason: (item: Pick<Item, "createdAt">, now?: number) => string | null;
  staleVersionBugCloseEnabled: () => boolean;
  targetRepo: () => string;
  unconfirmedProductDirectionAgeSkipReason: (
    item: Pick<Item, "createdAt">,
    reviewedUpdatedAt: string | undefined,
    reviewedAt: string | undefined,
    now?: number,
  ) => string | null;
  unconfirmedProductDirectionCloseEnabled: () => boolean;
  unsponsoredFeatureAgeSkipReason: (item: Pick<Item, "createdAt">, now?: number) => string | null;
  unsponsoredFeatureCloseEnabled: () => boolean;
}

export const STALLED_UNPROVEN_PROOF_STATUSES = new Set(["missing", "mock_only", "insufficient"]);
