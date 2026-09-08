import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { BULK_FILED_LABEL, GOOD_FIRST_ISSUE_LABEL } from "./clawsweeper-policy.js";
import type {
  BulkFilerRepositoryPermissionCache,
  Item,
  ItemContext,
  ReviewCommentRenderOptions,
} from "./clawsweeper-types.js";
import { isGitHubRequiresAuthenticationError } from "./github-retry.js";
import { reportAllowsAutomation } from "./manual-publication-policy.js";

type ApplyReportLabelDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "bulkFilerRepositoryPermission"
  | "closingPullRequestsForIssue"
  | "frontMatterBoolean"
  | "hasNormalizedLabel"
  | "impactLabelsFromReport"
  | "isBulkFilerExemptAuthorAssociation"
  | "isGoodFirstIssue"
  | "issueAdvisoryLabelStateFromReport"
  | "maturityLabelsFromReport"
  | "mergeRiskLabelsFromReport"
  | "openClosingPullRequestApplyReason"
  | "replaceFrontMatterValue"
  | "syncBulkFilerLabel"
  | "syncImpactLabels"
  | "syncIssueAdvisoryLabels"
  | "syncMaturityLabels"
  | "syncMergeRiskLabels"
  | "syncPriorityLabel"
  | "triagePriorityFromReport"
>;

interface ApplyReportLabelOptions {
  bulkFilerRepositoryPermissionCache: BulkFilerRepositoryPermissionCache;
  clawSweeperLabelsChanged: boolean;
  currentApplyMutationLeaseBlockReason: () => string | null;
  currentClosingPullRequests: unknown[] | undefined;
  currentItemContext: () => ItemContext;
  dryRun: boolean;
  isCloseProposal: boolean;
  isCurrentCompleteReport: boolean;
  isCurrentLabelSyncReport: boolean;
  item: Item;
  markLabelSyncAuthSkipped: (kind: string) => boolean;
  markdown: string;
  number: number;
  onMutation: (parentEventId?: string | null) => void;
  recordReviewLeaseSkip: (reason: string, restoreOriginal?: boolean) => boolean;
  rememberSelfMutationUpdatedAt: () => void;
  renderOptions: ReviewCommentRenderOptions;
  reportLabelsBeforeApply: readonly string[];
  setMarkdown: (markdown: string) => void;
  state: string;
}

interface ApplyReportLabelResult {
  clawSweeperLabelsChanged: boolean;
  currentClosingPullRequests: unknown[] | undefined;
  issueAdvisoryLabelsChanged: boolean;
  markdown: string;
  skipCurrentItem: boolean;
  stopApply: boolean;
}

export function syncApplyReportLabels(
  dependencies: ApplyReportLabelDependencies,
  options: ApplyReportLabelOptions,
): ApplyReportLabelResult {
  const {
    bulkFilerRepositoryPermission,
    closingPullRequestsForIssue,
    frontMatterBoolean,
    hasNormalizedLabel,
    impactLabelsFromReport,
    isBulkFilerExemptAuthorAssociation,
    isGoodFirstIssue,
    issueAdvisoryLabelStateFromReport,
    maturityLabelsFromReport,
    mergeRiskLabelsFromReport,
    openClosingPullRequestApplyReason,
    replaceFrontMatterValue,
    syncBulkFilerLabel,
    syncImpactLabels,
    syncIssueAdvisoryLabels,
    syncMaturityLabels,
    syncMergeRiskLabels,
    syncPriorityLabel,
    triagePriorityFromReport,
  } = dependencies;
  const {
    bulkFilerRepositoryPermissionCache,
    currentApplyMutationLeaseBlockReason,
    currentItemContext,
    dryRun,
    isCloseProposal,
    isCurrentCompleteReport,
    isCurrentLabelSyncReport,
    item,
    markLabelSyncAuthSkipped,
    number,
    onMutation,
    recordReviewLeaseSkip,
    rememberSelfMutationUpdatedAt,
    renderOptions,
    reportLabelsBeforeApply,
    setMarkdown,
    state,
  } = options;
  let { clawSweeperLabelsChanged, currentClosingPullRequests, markdown } = options;
  let issueAdvisoryLabelsChanged = false;
  const result = (skipCurrentItem = false, stopApply = false): ApplyReportLabelResult => ({
    clawSweeperLabelsChanged,
    currentClosingPullRequests,
    issueAdvisoryLabelsChanged,
    markdown,
    skipCurrentItem,
    stopApply,
  });
  const leaseBlockResult = (): ApplyReportLabelResult | null => {
    const blockReason = currentApplyMutationLeaseBlockReason();
    if (!blockReason) return null;
    setMarkdown(markdown);
    return result(true, recordReviewLeaseSkip(blockReason, false));
  };
  if (!reportAllowsAutomation(markdown)) return result();
  const skipLabelAuth = (kind: string): ApplyReportLabelResult => {
    setMarkdown(markdown);
    return result(true, markLabelSyncAuthSkipped(kind));
  };

  if (state === "open" && isCurrentLabelSyncReport) {
    const blocked = leaseBlockResult();
    if (blocked) return blocked;
    try {
      const bulkFilerDetected = frontMatterBoolean(markdown, "bulk_filer_detected");
      const needsPermission =
        item.kind === "issue" &&
        !isBulkFilerExemptAuthorAssociation(item.authorAssociation) &&
        (bulkFilerDetected || hasNormalizedLabel(item.labels, BULK_FILED_LABEL));
      const synced = syncBulkFilerLabel({
        number,
        labels: item.labels,
        bulkFilerDetected,
        authorAssociation: item.authorAssociation,
        repositoryPermission: needsPermission
          ? bulkFilerRepositoryPermission(item.author, bulkFilerRepositoryPermissionCache)
          : null,
        dryRun,
        onMutation,
      });
      item.labels = synced.labels;
      clawSweeperLabelsChanged ||= synced.changed;
      markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
      setMarkdown(markdown);
      if (synced.changed) rememberSelfMutationUpdatedAt();
    } catch (error) {
      if (!isGitHubRequiresAuthenticationError(error)) throw error;
      return skipLabelAuth("ClawSweeper bulk-filer");
    }
  }

  if (state === "open" && isCurrentCompleteReport) {
    const blocked = leaseBlockResult();
    if (blocked) return blocked;
    try {
      let labelsChanged = false;
      const applyResult = (synced: { labels: string[]; changed: boolean }): void => {
        item.labels = synced.labels;
        labelsChanged ||= synced.changed;
        clawSweeperLabelsChanged ||= synced.changed;
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        setMarkdown(markdown);
      };
      applyResult(
        syncPriorityLabel({
          number,
          labels: item.labels,
          triagePriority: triagePriorityFromReport(markdown),
          dryRun,
          onMutation,
        }),
      );
      applyResult(
        syncImpactLabels({
          number,
          labels: item.labels,
          impactLabels: item.kind === "pull_request" ? [] : impactLabelsFromReport(markdown),
          dryRun,
          onMutation,
        }),
      );
      applyResult(
        syncMaturityLabels({
          number,
          labels: item.labels,
          maturityLabels: item.kind === "pull_request" ? [] : maturityLabelsFromReport(markdown),
          dryRun,
          onMutation,
        }),
      );
      if (item.kind === "pull_request") {
        applyResult(
          syncMergeRiskLabels({
            number,
            labels: item.labels,
            mergeRiskLabels: mergeRiskLabelsFromReport(markdown),
            dryRun,
            onMutation,
          }),
        );
      }
      if (labelsChanged) rememberSelfMutationUpdatedAt();
    } catch (error) {
      if (!isGitHubRequiresAuthenticationError(error)) throw error;
      return skipLabelAuth("ClawSweeper");
    }
  }

  if (state !== "open" || item.kind !== "issue" || isCloseProposal || !isCurrentCompleteReport) {
    return result();
  }
  const blocked = leaseBlockResult();
  if (blocked) return blocked;
  currentClosingPullRequests = closingPullRequestsForIssue(number);
  try {
    const hasOpenLinkedPullRequest =
      openClosingPullRequestApplyReason(currentClosingPullRequests) !== null;
    renderOptions.hasOpenLinkedPullRequest = hasOpenLinkedPullRequest;
    const advisory = issueAdvisoryLabelStateFromReport(markdown, {
      hasOpenLinkedPullRequest,
      locked: item.locked === true,
    });
    const currentHasGoodFirstIssue = item.labels.some(
      (label) => label.toLowerCase() === GOOD_FIRST_ISSUE_LABEL,
    );
    if (!currentHasGoodFirstIssue && isGoodFirstIssue(advisory, item.labels)) {
      const reportHadGoodFirstIssue = reportLabelsBeforeApply.some(
        (label) => label.toLowerCase() === GOOD_FIRST_ISSUE_LABEL,
      );
      const humanLabelState = currentItemContext().goodFirstIssueHumanLabelState ?? "unknown";
      advisory.goodFirstIssueOptedOut =
        humanLabelState === "removed" || (humanLabelState === "unknown" && reportHadGoodFirstIssue);
    }
    const synced = syncIssueAdvisoryLabels({
      number,
      labels: item.labels,
      state: advisory,
      dryRun,
      onMutation,
    });
    item.labels = synced.labels;
    issueAdvisoryLabelsChanged = synced.changed;
    clawSweeperLabelsChanged ||= synced.changed;
    markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
    setMarkdown(markdown);
    if (synced.changed) rememberSelfMutationUpdatedAt();
    return result();
  } catch (error) {
    if (!isGitHubRequiresAuthenticationError(error)) throw error;
    return skipLabelAuth("advisory issue");
  }
}
