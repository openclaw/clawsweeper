import type {
  ExistingReview,
  ExistingReviewIndex,
  FailedReviewRetryState,
  Item,
} from "./clawsweeper-types.js";

export interface ReviewPlanningDependencies {
  maxPlanShardCount: number;
  targetRepo: () => string;
  ghJson: <T>(args: string[]) => T;
  ghJsonLines: <T>(args: string[]) => T[];
  fetchReviewedPrActivityCursor: (
    number: number,
    prefetchedInlineComments?: unknown[],
  ) => string | null;
  ghPaged: <T>(path: string) => T[];
  githubCount: (value: unknown) => number | null;
  itemSourceRevisionSha256: (issue: unknown, comments?: unknown[]) => string;
  asRecord: (value: unknown) => Record<string, unknown>;
  normalizeAuthorAssociation: (value: unknown) => string;
  shouldPlanItem: (item: Pick<Item, "authorAssociation" | "labels">) => boolean;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  buildExistingReviewIndex: (itemsDir: string) => ExistingReviewIndex;
  indexedExistingReview: (
    item: Pick<Item, "number" | "repo">,
    itemsDir: string,
    reviewIndex?: ExistingReviewIndex,
  ) => ExistingReview | null;
  effectiveReviewStatus: (markdown: string) => string;
  stringOrUndefined: (value: unknown) => string | undefined;
  pullHeadShaFromReport: (markdown: string) => string | null;
  failedReviewRetryStatePath: (stateDir: string, number: number) => string;
  readFailedReviewRetryState: (statePath: string) => FailedReviewRetryState | null;
  failedReviewRetryMarkdownWithState: (
    markdown: string,
    state: FailedReviewRetryState | null,
  ) => string;
  repoRelativePath: (filePath: string) => string;
  dashboardClosedAt: (markdown: string) => string | undefined;
}
