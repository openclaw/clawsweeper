import type {
  ActionTaken,
  CloseReason,
  Decision,
  Item,
  ItemContext,
  LabelJustification,
  LabelTransitionJustification,
  PullRequestReviewReadiness,
  ReviewCommentRenderOptions,
} from "./clawsweeper-types.js";
import { type ReviewStructuralPullState } from "./review-structural-cache.js";
import type { RepositoryProfile } from "./repository-profiles.js";
import type { ReportReviewDecision } from "./report-review-decision.js";

export interface CreateReportRenderingDependencies {
  collectItemContext: (
    item: Item,
    options?: {
      fullTimelineForRelations?: boolean;
      reviewCacheDigest?: boolean;
      reviewCacheGitDir?: string;
    },
  ) => ItemContext;
  compactPullFilePaths: (value: unknown) => string[];
  ensureDir: (path: string) => void;
  fileUrl: (file: string, sha: string, line?: number, repo?: string) => string;
  formattedMarkdownList: (
    values: readonly string[],
    formatter: (value: string) => string,
  ) => string;
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
  hasUsableCloseComment: (closeComment: string) => boolean;
  inlineCode: (value: string) => string;
  isImplementationCloseReason: (reason: CloseReason) => boolean;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  isVerifiedFixedCloseReason: (reason: unknown) => boolean;
  jsonFrontMatterValue: (value: readonly unknown[]) => string;
  labelJustificationsFromPublicReport: (
    markdown: string,
    decision: ReportReviewDecision,
    options?: ReviewCommentRenderOptions,
  ) => LabelJustification[];
  labelJustificationsMarkdown: (justifications: readonly LabelJustification[]) => string;
  labelTransitionJustificationsFromPublicReport: (
    markdown: string,
    decision: ReportReviewDecision,
    finalJustifications: readonly LabelJustification[],
    options?: ReviewCommentRenderOptions,
  ) => LabelTransitionJustification[];
  labelTransitionJustificationsMarkdown: (
    justifications: readonly LabelTransitionJustification[],
  ) => string;
  linkedRelease: (tag: string) => string;
  linkedSha: (sha: string, repo?: string) => string;
  markdownLink: (label: string, url: string) => string;
  pullHeadShaFromContext: (context: ItemContext) => string | null;
  repairLoopPassModeFromReport: (markdown: string) => "" | "autofix" | "automerge";
  reviewAutomationMarkersFromReport: (
    markdown: string,
    readiness?: PullRequestReviewReadiness,
  ) => string;
  reviewStructuralPullStateFromContext: (context: ItemContext) => ReviewStructuralPullState | null;
  reviewVersionMarkerFromReport: (markdown: string) => string;
  ROOT: string;
  shouldRenderWorkPlanFromReport: (markdown: string) => boolean;
  targetProfile: () => RepositoryProfile;
  targetRepo: () => string;
  validateCloseDecision: (
    item: Pick<Item, "kind" | "labels" | "repo"> & Partial<Pick<Item, "authorAssociation">>,
    decision: Decision,
    options?: { requireCloseComment?: boolean },
  ) => { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string };
  workPlanPathForReport: (file: string, plansDir?: string) => string;
  workStatusForDecision: (decision: Decision) => string;
}
