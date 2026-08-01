import {
  ALL_REASONS,
  FRESH_DAYS,
  HOT_REVIEW_DAYS,
  RECENT_ISSUE_DAYS,
} from "./clawsweeper-policy.js";
import type {
  CloseReason,
  DashboardActivityBucket,
  DashboardActivityStats,
  DashboardCadenceBucket,
  DashboardClosedItem,
  DashboardItem,
  Decision,
  ItemKind,
  RepoDashboardSnapshot,
} from "./clawsweeper-types.js";

interface DashboardDependencies {
  closeReasonText: (reason: CloseReason) => string;
  displayTitle: (title: string) => string;
  emptyDashboardActivityStats: () => DashboardActivityStats;
  formatActivityRow: (label: string, bucket: DashboardActivityBucket) => string;
  formatCadenceBucket: (bucket: DashboardCadenceBucket) => string;
  formatOperationActivityRow: (label: string, bucket: DashboardActivityBucket) => string;
  formatPercent: (numerator: number, denominator: number) => string;
  formatStatusNumber: (value: number | undefined) => string;
  formatTimestamp: (iso: string | undefined) => string;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  itemUrlFor: (repo: string, number: number, kind?: ItemKind) => string;
  latestTimestamp: (
    current: string | undefined,
    candidate: string | undefined,
  ) => string | undefined;
  markdownLink: (label: string, url: string) => string;
  repoUrlFor: (repo: string) => string;
  reportFileUrl: (number: number, path?: string) => string;
  targetRepo: () => string;
  timestampMs: (iso: string | undefined) => number | null;
}

function flushDashboardMarkdown(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce(
    (markdown, segment, index) =>
      `${markdown}${segment.replace(/^  /gm, "")}${index < values.length ? String(values[index]) : ""}`,
    "",
  );
}

export function createDashboardPresentation({
  closeReasonText,
  displayTitle,
  emptyDashboardActivityStats,
  formatActivityRow,
  formatCadenceBucket,
  formatOperationActivityRow,
  formatPercent,
  formatStatusNumber,
  formatTimestamp,
  frontMatterValue,
  itemUrlFor,
  latestTimestamp,
  markdownLink,
  repoUrlFor,
  reportFileUrl,
  targetRepo,
  timestampMs,
}: DashboardDependencies) {
  function workPriorityScore(priority: string): number {
    if (priority === "high") return 3;
    if (priority === "medium") return 2;
    if (priority === "low") return 1;
    return 0;
  }

  function markdownTableCell(value: string): string {
    return value.replaceAll("|", "\\|");
  }

  function jsonFrontMatterValue(value: readonly unknown[]): string {
    return JSON.stringify(value);
  }

  function workStatusForDecision(decision: Decision): string {
    if (decision.workCandidate === "queue_fix_pr") return "candidate";
    if (decision.workCandidate === "manual_review") return "manual_review";
    return "none";
  }

  function displayCloseReason(reason: string | undefined): string {
    if (reason && ALL_REASONS.has(reason as CloseReason))
      return closeReasonText(reason as CloseReason);
    return reason || "unknown";
  }

  function dashboardClosedAt(markdown: string): string | undefined {
    const appliedAt = frontMatterValue(markdown, "applied_at");
    if (appliedAt) return appliedAt;
    const currentItemClosedAt = frontMatterValue(markdown, "current_item_closed_at");
    if (currentItemClosedAt) return currentItemClosedAt;
    const currentState = frontMatterValue(markdown, "current_state");
    const action = frontMatterValue(markdown, "action_taken");
    if (currentState === "closed") return frontMatterValue(markdown, "reconciled_at");
    if (action === "skipped_already_closed") return frontMatterValue(markdown, "apply_checked_at");
    return undefined;
  }

  function dashboardCloseReason(markdown: string): string | undefined {
    const closeReason = frontMatterValue(markdown, "close_reason");
    const action = frontMatterValue(markdown, "action_taken");
    if (action === "closed") return closeReason;
    if (action === "skipped_already_closed") return "already closed before apply";
    if (frontMatterValue(markdown, "current_state") === "closed") {
      if (action === "kept_open") return "closed externally after review";
      if (action === "skipped_changed_since_review") return "closed externally after item changed";
      return action ? `closed externally after ${action}` : "closed externally";
    }
    return closeReason;
  }

  function formatRecentClosedRows(items: readonly DashboardClosedItem[], limit = 10): string {
    return (
      items
        .slice(0, limit)
        .map((item) => {
          const repo = item.repo ?? targetRepo();
          const title = markdownTableCell(displayTitle(item.title));
          const reason = markdownTableCell(displayCloseReason(item.closeReason));
          return `| ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${reason} | ${formatTimestamp(item.closedAt ?? item.appliedAt)} | ${markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath))} |`;
        })
        .join("\n") || "| _None_ |  |  |  |  |"
    );
  }

  function formatRecentReviewedRows(items: readonly DashboardItem[], limit = 10): string {
    return (
      items
        .slice(0, limit)
        .map((item) => {
          const repo = item.repo ?? targetRepo();
          const title = markdownTableCell(displayTitle(item.title));
          const outcome = markdownLink(
            `${item.decision} / ${item.action}`,
            reportFileUrl(item.number, item.reportPath),
          );
          return `| ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${outcome} | ${item.reviewStatus} | ${formatTimestamp(item.reviewedAt)} |`;
        })
        .join("\n") || "| _None_ |  |  |  |  |"
    );
  }

  function formatWorkQueueRows(items: readonly DashboardItem[], limit = 10): string {
    return (
      items
        .slice(0, limit)
        .map((item) => {
          const repo = item.repo ?? targetRepo();
          const title = markdownTableCell(displayTitle(item.title));
          const report = markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath));
          const plan = item.planPath
            ? markdownLink(item.planPath, reportFileUrl(item.number, item.planPath))
            : "_pending_";
          return `| ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${item.workPriority} | ${item.workStatus} | ${formatTimestamp(item.reviewedAt)} | ${plan} | ${report} |`;
        })
        .join("\n") || "| _None_ |  |  |  |  |  |  |"
    );
  }

  function formatFleetRecentClosedRows(items: readonly DashboardClosedItem[], limit = 10): string {
    return (
      items
        .slice(0, limit)
        .map((item) => {
          const repo = item.repo ?? targetRepo();
          const title = markdownTableCell(displayTitle(item.title));
          const reason = markdownTableCell(displayCloseReason(item.closeReason));
          return `| ${markdownLink(repo, repoUrlFor(repo))} | ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${reason} | ${formatTimestamp(item.closedAt ?? item.appliedAt)} | ${markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath))} |`;
        })
        .join("\n") || "| _None_ |  |  |  |  |  |"
    );
  }

  function formatFleetRecentReviewedRows(items: readonly DashboardItem[], limit = 10): string {
    return (
      items
        .slice(0, limit)
        .map((item) => {
          const repo = item.repo ?? targetRepo();
          const title = markdownTableCell(displayTitle(item.title));
          const outcome = markdownLink(
            `${item.decision} / ${item.action}`,
            reportFileUrl(item.number, item.reportPath),
          );
          return `| ${markdownLink(repo, repoUrlFor(repo))} | ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${outcome} | ${item.reviewStatus} | ${formatTimestamp(item.reviewedAt)} |`;
        })
        .join("\n") || "| _None_ |  |  |  |  |  |"
    );
  }

  function formatFleetWorkQueueRows(items: readonly DashboardItem[], limit = 15): string {
    return (
      items
        .slice(0, limit)
        .map((item) => {
          const repo = item.repo ?? targetRepo();
          const title = markdownTableCell(displayTitle(item.title));
          const report = markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath));
          const plan = item.planPath
            ? markdownLink(item.planPath, reportFileUrl(item.number, item.planPath))
            : "_pending_";
          return `| ${markdownLink(repo, repoUrlFor(repo))} | ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${item.workPriority} | ${item.workStatus} | ${formatTimestamp(item.reviewedAt)} | ${plan} | ${report} |`;
        })
        .join("\n") || "| _None_ |  |  |  |  |  |  |  |"
    );
  }

  function addActivityBucket(
    target: DashboardActivityBucket,
    source: DashboardActivityBucket,
  ): void {
    target.reviews += source.reviews;
    target.closeDecisions += source.closeDecisions;
    target.keepOpenDecisions += source.keepOpenDecisions;
    target.failedOrStaleReviews += source.failedOrStaleReviews;
    target.closes += source.closes;
    target.commentSyncs += source.commentSyncs;
    target.applySkips += source.applySkips;
    target.inheritedLabelCleanups += source.inheritedLabelCleanups;
    target.selfHealConflictRepairs += source.selfHealConflictRepairs;
    target.failedReviewRetries += source.failedReviewRetries;
    target.failedReviewRetryExhaustions += source.failedReviewRetryExhaustions;
    target.botOwnedProofDecisionsRequested += source.botOwnedProofDecisionsRequested;
    target.botOwnedProofDispatches += source.botOwnedProofDispatches;
  }

  function aggregateActivity(snapshots: readonly RepoDashboardSnapshot[]): DashboardActivityStats {
    const activity = emptyDashboardActivityStats();
    for (const snapshot of snapshots) {
      addActivityBucket(activity.last15Minutes, snapshot.stats.activity.last15Minutes);
      addActivityBucket(activity.lastHour, snapshot.stats.activity.lastHour);
      addActivityBucket(activity.last24Hours, snapshot.stats.activity.last24Hours);
      activity.latestReviewAt = latestTimestamp(
        activity.latestReviewAt,
        snapshot.stats.activity.latestReviewAt,
      );
      activity.latestCloseAt = latestTimestamp(
        activity.latestCloseAt,
        snapshot.stats.activity.latestCloseAt,
      );
      activity.latestCommentSyncAt = latestTimestamp(
        activity.latestCommentSyncAt,
        snapshot.stats.activity.latestCommentSyncAt,
      );
    }
    return activity;
  }

  function formatRepositoryOverviewRow(snapshot: RepoDashboardSnapshot): string {
    const stats = snapshot.stats;
    return `| ${markdownLink(snapshot.profile.displayName, repoUrlFor(snapshot.profile.targetRepo))} | ${stats.open.total} | ${stats.files} | ${stats.cadence.unreviewedOpen} | ${stats.cadence.due} | ${stats.proposedClose} | ${stats.workCandidates} | ${stats.closed} | ${formatTimestamp(stats.activity.latestReviewAt)} | ${formatTimestamp(stats.activity.latestCloseAt)} | ${stats.activity.lastHour.commentSyncs} |`;
  }

  function formatWorkflowStatusRow(snapshot: RepoDashboardSnapshot): string {
    const run = snapshot.statusSummary.runUrl
      ? markdownLink("run", snapshot.statusSummary.runUrl)
      : "_none_";
    const plan =
      snapshot.statusSummary.plannedCount === undefined &&
      snapshot.statusSummary.plannedCapacity === undefined &&
      snapshot.statusSummary.plannedShards === undefined
        ? "unknown"
        : `${formatStatusNumber(snapshot.statusSummary.plannedCount)}/${formatStatusNumber(
            snapshot.statusSummary.plannedCapacity,
          )} items, ${formatStatusNumber(snapshot.statusSummary.plannedShards)} shards`;
    return `| ${markdownLink(snapshot.profile.displayName, repoUrlFor(snapshot.profile.targetRepo))} | ${markdownTableCell(snapshot.statusSummary.state)} | ${formatStatusNumber(snapshot.statusSummary.activeCodex)} | ${plan} | ${formatStatusNumber(snapshot.statusSummary.dueBacklog)} | ${formatTimestamp(snapshot.statusSummary.oldestUnreviewedAt)} | ${markdownTableCell(snapshot.statusSummary.capacityReason ?? "unknown")} | ${formatTimestamp(snapshot.statusSummary.updatedAt)} | ${run} |`;
  }

  function renderRepoDashboardDetails(snapshot: RepoDashboardSnapshot): string {
    const stats = snapshot.stats;
    return flushDashboardMarkdown`<details>
  <summary>${snapshot.profile.displayName} (${snapshot.profile.targetRepo})</summary>

  <br>

  #### Current Run

  ${snapshot.status}

  #### Queue

  | Metric | Count |
  | --- | ---: |
  | Target repository | ${markdownLink(snapshot.profile.targetRepo, repoUrlFor(snapshot.profile.targetRepo))} |
  | Open issues | ${stats.open.issues} |
  | Open PRs | ${stats.open.pullRequests} |
  | Open items total | ${stats.open.total} |
  | Reviewed files | ${stats.files} |
  | Unreviewed open items | ${stats.cadence.unreviewedOpen} |
  | Active Codex target | ${formatStatusNumber(snapshot.statusSummary.activeCodex)} |
  | Planned review items | ${formatStatusNumber(snapshot.statusSummary.plannedCount)} |
  | Planned review shards | ${formatStatusNumber(snapshot.statusSummary.plannedShards)} |
  | Planned review capacity | ${formatStatusNumber(snapshot.statusSummary.plannedCapacity)} |
  | Due backlog scanned | ${formatStatusNumber(snapshot.statusSummary.dueBacklog)} |
  | Oldest unreviewed scanned | ${formatTimestamp(snapshot.statusSummary.oldestUnreviewedAt)} |
  | Capacity reason | ${markdownTableCell(snapshot.statusSummary.capacityReason ?? "unknown")} |
  | Archived closed files | ${stats.archivedFiles} |

  #### Review Outcomes

  | Metric | Count |
  | --- | ---: |
  | Fresh reviewed issues in the last ${FRESH_DAYS} days | ${stats.byKind.issue.fresh} |
  | Proposed issue closes | ${stats.byKind.issue.proposedClose} (${formatPercent(stats.byKind.issue.proposedClose, stats.byKind.issue.fresh)} of reviewed issues) |
  | Fresh reviewed PRs in the last ${FRESH_DAYS} days | ${stats.byKind.pull_request.fresh} |
  | Proposed PR closes | ${stats.byKind.pull_request.proposedClose} (${formatPercent(stats.byKind.pull_request.proposedClose, stats.byKind.pull_request.fresh)} of reviewed PRs) |
  | Fresh verified reviews in the last ${FRESH_DAYS} days | ${stats.fresh} |
  | Proposed closes awaiting apply | ${stats.proposedClose} (${formatPercent(stats.proposedClose, stats.fresh)} of fresh reviews) |
  | Work candidates awaiting promotion | ${stats.workCandidates} |
  | Closed by Codex apply | ${stats.closed} |
  | Failed or stale reviews | ${stats.failed + stats.stale} |

  #### Cadence

  | Metric | Coverage |
  | --- | ---: |
  | First-week item cadence (<${HOT_REVIEW_DAYS}d) | ${formatCadenceBucket(stats.cadence.hourlyHotItems)} |
  | Daily cadence coverage | ${formatCadenceBucket(stats.cadence.daily)} |
  | Daily PR cadence | ${formatCadenceBucket(stats.cadence.dailyPullRequests)} |
  | Daily new issue cadence (<${RECENT_ISSUE_DAYS}d) | ${formatCadenceBucket(stats.cadence.dailyNewIssues)} |
  | Weekly older issue cadence | ${formatCadenceBucket(stats.cadence.weekly)} |
  | Due now by cadence | ${stats.cadence.due} |

  ${snapshot.auditHealth}

  #### Latest Run Activity

  Latest review: ${formatTimestamp(stats.activity.latestReviewAt)}. Latest close: ${formatTimestamp(stats.activity.latestCloseAt)}. Latest comment sync: ${formatTimestamp(stats.activity.latestCommentSyncAt)}.

  | Window | Reviews | Close decisions | Keep-open decisions | Failed/stale reviews | Closed | Comments synced | Apply skips |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  ${formatActivityRow("Last 15 minutes", stats.activity.last15Minutes)}
  ${formatActivityRow("Last hour", stats.activity.lastHour)}
  ${formatActivityRow("Last 24 hours", stats.activity.last24Hours)}

  #### Operation Counters

  | Window | Inherited-label cleanups | Self-heal conflict repairs | Failed-review retries | Exhausted review retries | Bot proof decisions | Bot proof dispatches |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  ${formatOperationActivityRow("Last 15 minutes", stats.activity.last15Minutes)}
  ${formatOperationActivityRow("Last hour", stats.activity.lastHour)}
  ${formatOperationActivityRow("Last 24 hours", stats.activity.last24Hours)}

  #### Recently Closed

  | Item | Title | Reason | Closed | Report |
  | --- | --- | --- | --- | --- |
  ${formatRecentClosedRows(stats.recentClosed)}

  #### Work Candidates

  | Item | Title | Priority | Status | Reviewed | Plan | Report |
  | --- | --- | --- | --- | --- | --- | --- |
  ${formatWorkQueueRows(stats.workQueue)}

  #### Recently Reviewed

  | Item | Title | Outcome | Status | Reviewed |
  | --- | --- | --- | --- | --- |
  ${formatRecentReviewedRows(stats.recent)}

  </details>`;
  }

  function renderDashboard(snapshots: readonly RepoDashboardSnapshot[]): string {
    const activity = aggregateActivity(snapshots);
    const recent = snapshots
      .flatMap((snapshot) => snapshot.stats.recent)
      .sort((a, b) => Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""));
    const workQueue = snapshots
      .flatMap((snapshot) => snapshot.stats.workQueue)
      .sort(
        (a, b) =>
          workPriorityScore(b.workPriority) - workPriorityScore(a.workPriority) ||
          Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""),
      );
    const recentClosed = snapshots
      .flatMap((snapshot) => snapshot.stats.recentClosed)
      .sort(
        (a, b) =>
          (timestampMs(b.closedAt ?? b.appliedAt) ?? Number.NEGATIVE_INFINITY) -
            (timestampMs(a.closedAt ?? a.appliedAt) ?? Number.NEGATIVE_INFINITY) ||
          b.number - a.number,
      );
    const totals = snapshots.reduce(
      (accumulator, snapshot) => {
        const stats = snapshot.stats;
        accumulator.openIssues += stats.open.issues;
        accumulator.openPullRequests += stats.open.pullRequests;
        accumulator.reviewedFiles += stats.files;
        accumulator.unreviewedOpen += stats.cadence.unreviewedOpen;
        accumulator.due += stats.cadence.due;
        accumulator.activeCodex += snapshot.statusSummary.activeCodex ?? 0;
        accumulator.plannedShards += snapshot.statusSummary.plannedShards ?? 0;
        accumulator.plannedCapacity += snapshot.statusSummary.plannedCapacity ?? 0;
        accumulator.dueBacklog += snapshot.statusSummary.dueBacklog ?? 0;
        accumulator.proposedClose += stats.proposedClose;
        accumulator.workCandidates += stats.workCandidates;
        accumulator.closed += stats.closed;
        accumulator.failedOrStale += stats.failed + stats.stale;
        accumulator.archivedFiles += stats.archivedFiles;
        return accumulator;
      },
      {
        openIssues: 0,
        openPullRequests: 0,
        reviewedFiles: 0,
        unreviewedOpen: 0,
        due: 0,
        activeCodex: 0,
        plannedShards: 0,
        plannedCapacity: 0,
        dueBacklog: 0,
        proposedClose: 0,
        workCandidates: 0,
        closed: 0,
        failedOrStale: 0,
        archivedFiles: 0,
      },
    );
    const dashboard = flushDashboardMarkdown`## Dashboard

  Last dashboard update: ${formatTimestamp(new Date().toISOString())}

  ### Fleet

  | Metric | Count |
  | --- | ---: |
  | Covered repositories | ${snapshots.length} |
  | Open issues | ${totals.openIssues} |
  | Open PRs | ${totals.openPullRequests} |
  | Open items total | ${totals.openIssues + totals.openPullRequests} |
  | Reviewed files | ${totals.reviewedFiles} |
  | Unreviewed open items | ${totals.unreviewedOpen} |
  | Due now by cadence | ${totals.due} |
  | Active Codex target | ${totals.activeCodex} |
  | Planned review shards | ${totals.plannedShards} |
  | Planned review capacity | ${totals.plannedCapacity} |
  | Due backlog scanned | ${totals.dueBacklog} |
  | Proposed closes awaiting apply | ${totals.proposedClose} |
  | Work candidates awaiting promotion | ${totals.workCandidates} |
  | Closed by Codex apply | ${totals.closed} |
  | Failed or stale reviews | ${totals.failedOrStale} |
  | Archived closed files | ${totals.archivedFiles} |

  ### Repositories

  | Repository | Open | Reviewed | Unreviewed | Due | Proposed closes | Work candidates | Closed | Latest review | Latest close | Comments synced, 1h |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
  ${snapshots.map(formatRepositoryOverviewRow).join("\n")}

  ### Current Runs

  | Repository | State | Active Codex | Plan | Due backlog | Oldest unreviewed | Capacity reason | Updated | Run |
  | --- | --- | ---: | --- | ---: | --- | --- | --- | --- |
  ${snapshots.map(formatWorkflowStatusRow).join("\n")}

  ### Fleet Activity

  Latest review: ${formatTimestamp(activity.latestReviewAt)}. Latest close: ${formatTimestamp(activity.latestCloseAt)}. Latest comment sync: ${formatTimestamp(activity.latestCommentSyncAt)}.

  | Window | Reviews | Close decisions | Keep-open decisions | Failed/stale reviews | Closed | Comments synced | Apply skips |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  ${formatActivityRow("Last 15 minutes", activity.last15Minutes)}
  ${formatActivityRow("Last hour", activity.lastHour)}
  ${formatActivityRow("Last 24 hours", activity.last24Hours)}

  ### Fleet Operation Counters

  | Window | Inherited-label cleanups | Self-heal conflict repairs | Failed-review retries | Exhausted review retries | Bot proof decisions | Bot proof dispatches |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  ${formatOperationActivityRow("Last 15 minutes", activity.last15Minutes)}
  ${formatOperationActivityRow("Last hour", activity.lastHour)}
  ${formatOperationActivityRow("Last 24 hours", activity.last24Hours)}

  ### Recently Closed Across Repos

  | Repository | Item | Title | Reason | Closed | Report |
  | --- | --- | --- | --- | --- | --- |
  ${formatFleetRecentClosedRows(recentClosed)}

  ### Work Candidates Across Repos

  | Repository | Item | Title | Priority | Status | Reviewed | Plan | Report |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  ${formatFleetWorkQueueRows(workQueue)}

  <details>
  <summary>Recently Reviewed Across Repos</summary>

  <br>

  | Repository | Item | Title | Outcome | Status | Reviewed |
  | --- | --- | --- | --- | --- | --- |
  ${formatFleetRecentReviewedRows(recent)}

  </details>

  ### Repository Details

  ${snapshots.map(renderRepoDashboardDetails).join("\n\n")}`;
    return dashboard;
  }

  return {
    dashboardClosedAt,
    dashboardCloseReason,
    formatRecentClosedRows,
    jsonFrontMatterValue,
    renderDashboard,
    workPriorityScore,
    workStatusForDecision,
  };
}
