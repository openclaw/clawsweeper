import type { FailedReviewRetryState, Item } from "./clawsweeper-types.js";

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
  normalizeAuthorAssociation: (value: unknown) => string;
  shouldPlanItem: (item: Pick<Item, "authorAssociation" | "labels">) => boolean;
  failedReviewRetryStatePath: (stateDir: string, number: number) => string;
  readFailedReviewRetryState: (statePath: string) => FailedReviewRetryState | null;
  failedReviewRetryMarkdownWithState: (
    markdown: string,
    state: FailedReviewRetryState | null,
  ) => string;
  repoRelativePath: (filePath: string) => string;
  githubReadModelRequestSync?: (
    operation: "item" | "comments" | "activity" | "workflows" | "placeholders" | "repair",
    payload: Record<string, unknown>,
  ) => (Record<string, unknown> & { usable?: boolean; hit?: boolean }) | null;
}
