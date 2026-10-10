import assert from "node:assert/strict";
import test from "node:test";

import { auditFromSnapshot, auditHealthSection } from "../dist/clawsweeper.js";
import { renderDashboard } from "../dist/clawsweeper-dashboard.js";
import {
  emptyDashboardActivityStats,
  emptyDashboardCadenceBucket,
  emptyDashboardKindStats,
} from "../dist/clawsweeper-review-planning-dashboard.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";

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
  const snapshot = {
    profile: repositoryProfileFor("openclaw/openclaw"),
    status: "<!-- status -->",
    statusSummary: { state: "idle" },
    auditHealth: auditHealthSection(null),
    stats: {
      open: { issues: 0, pullRequests: 0, total: 0 },
      files: 0,
      cadence: {
        hourlyHotItems: emptyDashboardCadenceBucket(),
        dailyPullRequests: emptyDashboardCadenceBucket(),
        dailyNewIssues: emptyDashboardCadenceBucket(),
        weeklyOlderIssues: emptyDashboardCadenceBucket(),
        hourly: emptyDashboardCadenceBucket(),
        daily: emptyDashboardCadenceBucket(),
        weekly: emptyDashboardCadenceBucket(),
        unreviewedOpen: 0,
        due: 0,
      },
      proposedClose: 0,
      workCandidates: 0,
      closed: 0,
      failed: 0,
      stale: 0,
      archivedFiles: 0,
      byKind: {
        issue: emptyDashboardKindStats(),
        pull_request: emptyDashboardKindStats(),
      },
      fresh: 0,
      todo: 0,
      activity: emptyDashboardActivityStats(),
      recent: [],
      recentClosed: [],
      workQueue: [],
    },
  };

  const rendered = renderDashboard([snapshot]);
  for (const heading of ["Fleet", "Repositories", "Current Runs", "Repository Details"]) {
    assert.match(rendered, new RegExp(`^### ${heading}$`, "m"));
  }
  assert.match(rendered, /^\| Metric \| Count \|$/m);
  assert.match(rendered, /<details>\n<summary>OpenClaw \(openclaw\/openclaw\)<\/summary>/);
  assert.match(rendered, /\n### Audit Health\n\n<!-- clawsweeper-audit:/);
});
