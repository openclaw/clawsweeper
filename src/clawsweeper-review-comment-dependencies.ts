import type { createDecisionParser } from "./clawsweeper-decision-parser.js";
import type { ghPaged } from "./clawsweeper-github-context.js";
import type { ghObservedMutationCommand } from "./clawsweeper-github-execution.js";
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
  ghObservedMutationCommand: typeof ghObservedMutationCommand;
  ghPaged: typeof ghPaged;
  reviewCommentBodyDigest: (body: string) => string;
  parseGitHubItemRef: ReturnType<typeof createDecisionParser>["parseGitHubItemRef"];
  ensureDir: (path: string) => void;
  removeIssueLabel: LabelMutations["removeIssueLabel"];
  currentReviewRevision: (item: Item) => string;
  pullRequestHeadSha: (number: number) => string;
  markdownLink: (label: string, url: string) => string;
}
