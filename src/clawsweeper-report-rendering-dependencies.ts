import type {
  ActionTaken,
  CloseReason,
  Decision,
  Evidence,
  FixedPullRequest,
  Item,
  ItemContext,
  ItemKind,
  LabelJustification,
  LabelTransitionJustification,
  PullRequestReviewReadiness,
  RegressionAssessment,
  PublicRegressionProvenance,
  ReviewCommentRenderOptions,
  ReviewMetric,
} from "./clawsweeper-types.js";
import { type PrSurfaceFile } from "./pr-surface-stats.js";
import { type ReviewStructuralPullState } from "./review-structural-cache.js";
import type { RepositoryProfile } from "./repository-profiles.js";

export interface CreateReportRenderingDependencies {
  closeClawHubHandoffBlock: (reason: CloseReason) => string;
  closeIntro: (reason: CloseReason) => string;
  closeOutro: (reason: CloseReason, canonicalLinks?: string[]) => string;
  collectItemContext: (
    item: Item,
    options?: {
      fullTimelineForRelations?: boolean;
      reviewCacheDigest?: boolean;
      reviewCacheGitDir?: string;
    },
  ) => ItemContext;
  compactPullFilePaths: (value: unknown) => string[];
  duplicateCanonicalLinks: (options: {
    reason: CloseReason;
    bestSolutionLine: string;
    evidence: Evidence[];
    currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
  }) => string[];
  duplicateCanonicalPathLine: (options: {
    reason: CloseReason;
    summaryLine: string;
    bestSolutionLine: string;
    evidence: Evidence[];
  }) => string;
  ensureDir: (path: string) => void;
  fileUrl: (file: string, sha: string, line?: number, repo?: string) => string;
  fixedInReportText: (markdown: string) => string;
  fixedInText: (decision: Decision) => string;
  fixedPullRequestFromReport: (markdown: string) => FixedPullRequest | null;
  regressionAssessmentFromReport: (markdown: string) => RegressionAssessment | null;
  regressionProvenanceFromReport: (markdown: string) => PublicRegressionProvenance | null;
  formatReviewFreshnessTimestamp: (iso: string | undefined) => string;
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
    options?: ReviewCommentRenderOptions,
  ) => LabelJustification[];
  labelJustificationsMarkdown: (justifications: readonly LabelJustification[]) => string;
  labelTransitionJustificationsFromPublicReport: (
    markdown: string,
    finalJustifications: readonly LabelJustification[],
    options?: ReviewCommentRenderOptions,
  ) => LabelTransitionJustification[];
  labelTransitionJustificationsMarkdown: (
    justifications: readonly LabelTransitionJustification[],
  ) => string;
  linkedRelease: (tag: string) => string;
  linkedSha: (sha: string, repo?: string) => string;
  markdownLink: (label: string, url: string) => string;
  prSurfaceFilesFromContext: (context: ItemContext) => PrSurfaceFile[] | null;
  pullHeadShaFromContext: (context: ItemContext) => string | null;
  renderOpenClawPrSurfaceFromReport: (markdown: string) => string;
  renderReviewMetricsDigest: (metrics: readonly ReviewMetric[]) => string;
  repairLoopPassModeFromReport: (markdown: string) => "" | "autofix" | "automerge";
  repoRelativePath: (path: string) => string;
  reviewAutomationMarkersFromReport: (
    markdown: string,
    readiness?: PullRequestReviewReadiness,
  ) => string;
  reviewMetricsFromReport: (markdown: string) => ReviewMetric[];
  reviewStructuralPullStateFromContext: (context: ItemContext) => ReviewStructuralPullState | null;
  reviewVersionMarkerFromReport: (markdown: string) => string;
  ROOT: string;
  shouldRenderWorkPlanFromReport: (markdown: string) => boolean;
  targetProfile: () => RepositoryProfile;
  targetRepo: () => string;
  validateCloseDecision: (
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo" | "authorAssociation">>,
    decision: Decision,
    options?: { requireCloseComment?: boolean },
  ) => { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string };
  workCandidateReasonText: (section: string) => string;
  workPlanPathForReport: (file: string, plansDir?: string) => string;
  workStatusForDecision: (decision: Decision) => string;
}
