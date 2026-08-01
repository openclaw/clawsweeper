import assert from "node:assert/strict";
import test from "node:test";

import { auditFromSnapshot, auditHealthSection } from "../dist/clawsweeper.js";
import { createDashboardPresentation } from "../dist/clawsweeper-dashboard.js";

test("audit dashboard markers remain flush and recoverable after modularization", () => {
  const snapshot = auditFromSnapshot({
    openItems: [],
    itemRecords: [],
    closedRecords: [],
    scanComplete: true,
    pagesScanned: 1,
    generatedAt: "2026-04-26T12:00:00.000Z",
  });

  for (const [section, content] of [
    [auditHealthSection(null), "No audit has been published yet."],
    [auditHealthSection(snapshot), "Status: **Passing**"],
  ] as const) {
    assert.match(section, /^### Audit Health\n\n<!-- clawsweeper-audit:[^\n]+:start -->\n/);
    assert.match(section, /\n<!-- clawsweeper-audit:[^\n]+:end -->$/);
    assert.ok(section.includes(content));
  }
});

test("extracted dashboard preserves flush Markdown headings, tables, and embedded audit state", () => {
  const activityBucket = () => ({
    reviews: 0,
    closeDecisions: 0,
    keepOpenDecisions: 0,
    failedOrStaleReviews: 0,
    closes: 0,
    commentSyncs: 0,
    applySkips: 0,
    inheritedLabelCleanups: 0,
    selfHealConflictRepairs: 0,
    failedReviewRetries: 0,
    failedReviewRetryExhaustions: 0,
    botOwnedProofDecisionsRequested: 0,
    botOwnedProofDispatches: 0,
  });
  const activity = () => ({
    last15Minutes: activityBucket(),
    lastHour: activityBucket(),
    last24Hours: activityBucket(),
  });
  const dashboard = createDashboardPresentation({
    closeReasonText: String,
    displayTitle: String,
    emptyDashboardActivityStats: activity,
    formatActivityRow: (label) => `| ${label} |`,
    formatCadenceBucket: () => "0/0",
    formatOperationActivityRow: (label) => `| ${label} |`,
    formatPercent: () => "0%",
    formatStatusNumber: (value) => String(value ?? "unknown"),
    formatTimestamp: (value) => String(value ?? "never"),
    frontMatterValue: () => undefined,
    itemUrlFor: (repo, number) => `https://github.com/${repo}/issues/${number}`,
    latestTimestamp: (current, candidate) => candidate ?? current,
    markdownLink: (label, url) => `[${label}](${url})`,
    repoUrlFor: (repo) => `https://github.com/${repo}`,
    reportFileUrl: (_, reportPath) => reportPath ?? "report",
    targetRepo: () => "openclaw/openclaw",
    timestampMs: () => null,
  });
  const snapshot = {
    profile: { displayName: "OpenClaw", targetRepo: "openclaw/openclaw" },
    status: "<!-- status -->",
    statusSummary: { state: "idle" },
    auditHealth: auditHealthSection(null),
    stats: {
      open: { issues: 0, pullRequests: 0, total: 0 },
      files: 0,
      cadence: { unreviewedOpen: 0, due: 0 },
      proposedClose: 0,
      workCandidates: 0,
      closed: 0,
      failed: 0,
      stale: 0,
      archivedFiles: 0,
      byKind: {
        issue: { fresh: 0, proposedClose: 0 },
        pull_request: { fresh: 0, proposedClose: 0 },
      },
      fresh: 0,
      activity: activity(),
      recent: [],
      recentClosed: [],
      workQueue: [],
    },
  };

  const rendered = dashboard.renderDashboard([snapshot]);
  for (const heading of ["Fleet", "Repositories", "Current Runs", "Repository Details"]) {
    assert.match(rendered, new RegExp(`^### ${heading}$`, "m"));
  }
  assert.match(rendered, /^\| Metric \| Count \|$/m);
  assert.match(rendered, /<details>\n<summary>OpenClaw \(openclaw\/openclaw\)<\/summary>/);
  assert.match(rendered, /\n### Audit Health\n\n<!-- clawsweeper-audit:/);
});
