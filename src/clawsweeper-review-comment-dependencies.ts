import type { createDecisionParser } from "./clawsweeper-decision-parser.js";
import type { createGitHubContext } from "./clawsweeper-github-context.js";
import type { LabelMutations } from "./clawsweeper-label-mutations.js";
import type { Item, ReviewStartStatusCommentResult } from "./clawsweeper-types.js";

export interface ReviewCommentWorkflowDependencies {
  root: string;
  targetRepo: () => string;
  heldReviewStartStatusCommentResult: (
    retryAt: string,
    didMutate: boolean,
  ) => ReviewStartStatusCommentResult;
  gitHubRuntimeBudgetError: new (reason: string) => Error;
  ghObservedMutationCommand: (options: {
    identity: string;
    args: string[];
    attempts?: number | undefined;
    onMutation?: (() => void) | undefined;
    didMutate?: ((result: string) => boolean) | undefined;
    knownNoMutation?: ((error: unknown) => boolean) | undefined;
    request?: ((args: string[], attempt: number) => string) | undefined;
    prepareRequest?: ((args: string[], attempt: number) => () => string) | undefined;
    sleepBeforeRetry?: ((waitMs: number) => void) | undefined;
  }) => string;
  ghPaged: ReturnType<typeof createGitHubContext>["ghPaged"];
  reviewCommentBodyDigest: (body: string) => string;
  parseGitHubItemRef: ReturnType<typeof createDecisionParser>["parseGitHubItemRef"];
  ensureDir: (path: string) => void;
  removeIssueLabel: LabelMutations["removeIssueLabel"];
  currentReviewRevision: (item: Item) => string;
  pullRequestHeadSha: (number: number) => string;
  markdownLink: (label: string, url: string) => string;
}
