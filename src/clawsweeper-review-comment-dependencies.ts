import type { createDecisionParser } from "./clawsweeper-decision-parser.js";
import type { createGitHubContext } from "./clawsweeper-github-context.js";
import type { createLabelSynchronization } from "./clawsweeper-label-sync.js";
import type { createReviewPresentation } from "./clawsweeper-review-presentation.js";
import type {
  Item,
  PullRequestReviewReadiness,
  ReviewStartStatusCommentResult,
} from "./clawsweeper-types.js";
import { type ReviewHistoryLedger } from "./review-history.js";

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
  githubCount: ReturnType<typeof createGitHubContext>["githubCount"];
  ghPaged: ReturnType<typeof createGitHubContext>["ghPaged"];
  reviewCommentBodyDigest: (body: string) => string;
  parseGitHubItemRef: ReturnType<typeof createDecisionParser>["parseGitHubItemRef"];
  ensureDir: (path: string) => void;
  sentence: ReturnType<typeof createReviewPresentation>["sentence"];
  pullRequestReviewReadinessFromReport: (markdown: string) => PullRequestReviewReadiness;
  securitySensitiveRepairAllowed: (markdown: string) => boolean;
  isIssueAdvisoryLabel: ReturnType<typeof createLabelSynchronization>["isIssueAdvisoryLabel"];
  removeIssueLabel: ReturnType<typeof createLabelSynchronization>["removeIssueLabel"];
  realBehaviorProofBlocksMerge: (markdown: string) => boolean;
  normalizedLabelSet: (labels: readonly string[]) => Set<string>;
  isClawSweeperOwnedLabel: (label: string) => boolean;
  reviewHistoryForStaleComment: (body: string | undefined) => ReviewHistoryLedger;
  currentReviewRevision: (item: Item) => string;
  pullRequestHeadSha: (number: number) => string;
  markdownLink: (label: string, url: string) => string;
}
