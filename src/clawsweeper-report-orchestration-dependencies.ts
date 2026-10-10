import type {
  ActionTaken,
  CloseReason,
  ContextHydration,
  Decision,
  GithubPageWithHeaders,
  Item,
  ItemContext,
  ParsedGitHubItemRef,
  PullRequestLiveActivity,
  RootCauseClusterAssessment,
} from "./clawsweeper-types.js";
import { type RepositoryProfile } from "./repository-profiles.js";
import { type ReviewStructuralPullState } from "./review-structural-cache.js";

export interface CreateReportOrchestrationDependencies {
  collectItemContext: (
    item: Item,
    options?: {
      fullTimelineForRelations?: boolean;
      reviewCacheDigest?: boolean;
      reviewCacheGitDir?: string;
    },
  ) => ItemContext;
  compactPullFilePaths: (value: unknown) => string[];
  defaultPlansDir: (profile?: RepositoryProfile) => string;
  defaultRootCauseCluster: () => RootCauseClusterAssessment;
  ensureDir: (path: string) => void;
  fileUrl: (file: string, sha: string, line?: number, repo?: string) => string;
  filterReviewContextComments: (
    comments: readonly unknown[],
    number: number,
  ) => { included: unknown[]; filtered: number };
  formatTimestamp: (iso: string | undefined) => string;
  ghJson: <T>(args: string[]) => T;
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
  ghPaged: <T>(path: string) => T[];
  ghPagedContextWindow: <T>(
    path: string,
    totalCount: unknown,
    promptLimit: number,
    fetchers?: { page?: (path: string, page: number) => T[]; paged?: (path: string) => T[] },
  ) => ContextHydration<T>;
  ghPagedLinkHeaderContextWindow: <T>(
    path: string,
    promptLimit: number,
    fetchers?: {
      pageWithHeaders?: (path: string, page: number, perPage: number) => GithubPageWithHeaders<T>;
      paged?: (path: string) => T[];
    },
  ) => ContextHydration<T>;
  GitHubRuntimeBudgetError: new (reason: string) => Error & { readonly reason: string };
  hasUsableCloseComment: (closeComment: string) => boolean;
  isFresh: (
    review: { reviewedAt: string | undefined; reviewStatus: string | undefined } | null,
  ) => boolean;
  isImplementationCloseReason: (reason: CloseReason) => boolean;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  isVerifiedFixedCloseReason: (reason: unknown) => boolean;
  itemSnapshotHash: (item: Item, context: ItemContext) => string;
  jsonFrontMatterValue: (value: readonly unknown[]) => string;
  labelNames: (value: unknown) => string[];
  linkedRelease: (tag: string) => string;
  linkedSha: (sha: string, repo?: string) => string;
  markdownLink: (label: string, url: string) => string;
  normalizeLabelName: (label: string) => string;
  numberOrUndefined: (value: unknown) => number | undefined;
  parseGitHubItemRef: (value: string, path: string) => ParsedGitHubItemRef;
  pullHeadShaFromContext: (context: ItemContext) => string | null;
  pullRequestHeadActivity: (
    number: number,
    pull: {
      created_at?: string;
      head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
    },
    timeline?: unknown[],
  ) => Pick<PullRequestLiveActivity, "headSha" | "headActivityAtMs">;
  repairLoopPassModeFromReport: (markdown: string) => "" | "autofix" | "automerge";
  repoUrlFor: (repo: string, path?: string) => string;
  reviewAutomationMarkersFromReport: (markdown: string) => string;
  reviewStructuralPullStateFromContext: (context: ItemContext) => ReviewStructuralPullState | null;
  reviewVersionMarkerFromReport: (markdown: string) => string;
  ROOT: string;
  runtimeBudgetExceeded: (startedAtMs: number, maxRuntimeMs: number, nowMs: number) => boolean;
  targetProfile: () => RepositoryProfile;
  targetRepo: () => string;
  timeoutWithinRuntimeBudget: (
    startedAtMs: number,
    maxRuntimeMs: number,
    requestedTimeoutMs: number,
    nowMs: number,
  ) => number | null;
  validateCloseDecision: (
    item: Pick<Item, "kind" | "labels" | "repo"> & Partial<Pick<Item, "authorAssociation">>,
    decision: Decision,
    options?: { requireCloseComment?: boolean },
  ) => { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string };
  workStatusForDecision: (decision: Decision) => string;
}
