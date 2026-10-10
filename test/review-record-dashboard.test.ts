import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";

import { createDashboardAudit } from "../dist/clawsweeper-dashboard-audit.js";
import { createDashboardPresentation } from "../dist/clawsweeper-dashboard.js";
import { createReviewPlanningDashboard } from "../dist/clawsweeper-review-planning-dashboard.js";
import { markdownFiles, markdownRepository } from "../dist/clawsweeper-repository-paths.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import { ReviewRecordFormatError } from "../dist/review-record.js";
import { reportFrontMatter, tmpPrefix, withReviewRecord } from "./helpers.ts";

const presentation = createDashboardPresentation(
  {} as Parameters<typeof createDashboardPresentation>[0],
);
const planning = createReviewPlanningDashboard({
  dashboardClosedAt: presentation.dashboardClosedAt,
  failedReviewRetryStatePath: (dir, number) => join(dir, `${number}.json`),
  readFailedReviewRetryState: () => null,
  failedReviewRetryMarkdownWithState: (markdown) => markdown,
  repoRelativePath: String,
} as Parameters<typeof createReviewPlanningDashboard>[0]);

function report(number: number, fields: Record<string, unknown> = {}): string {
  return reportFrontMatter({
    number,
    title: `Item ${number}`,
    reviewed_at: new Date().toISOString(),
    review_status: "complete",
    local_checkout_access: "verified",
    work_candidate: "none",
    work_priority: "low",
    work_status: "candidate",
    ...fields,
  });
}

function fixture(t: TestContext) {
  const root = mkdtempSync(tmpPrefix);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const itemsDir = join(root, "items");
  const closedDir = join(root, "closed");
  mkdirSync(itemsDir);
  mkdirSync(closedDir);
  const readmePath = join(root, "README.md");
  writeFileSync(readmePath, "## Dashboard\n\n## How It Works\n");
  const profile = repositoryProfileFor("openclaw/openclaw");
  const audit = createDashboardAudit({
    ...planning,
    ROOT: root,
    targetRepo: () => profile.targetRepo,
    targetProfile: () => profile,
    repoFromArgs: () => profile,
    withTargetProfile: (_profile, fn) => fn(),
    defaultItemsDir: () => join(root, "default-items"),
    defaultClosedDir: () => join(root, "default-closed"),
    defaultPlansDir: () => join(root, "plans"),
    defaultFailedReviewRetryStateDir: () => join(root, "retries"),
    repoRelativePath: (path) => relative(root, path),
    displayTitle: String,
    ensureDir: (path) => mkdirSync(path, { recursive: true }),
    fetchOpenItems: () => ({ items: [], pagesScanned: 1, complete: true }),
    fetchOpenItemCounts: () => ({ issues: 10, pullRequests: 0, total: 10 }),
    isFresh: (review) => review?.reviewStatus === "complete",
    isCurrentForCadence: ({ reviewStatus }) => reviewStatus === "complete",
    isMaintainerAuthored: () => false,
    isProtectedItem: () => false,
    shouldPlanItem: () => true,
    applyBlockingProtectedLabels: () => [],
    currentWorkflowStatusBlock: () => "Idle",
    workflowStatusSummary: () => ({ state: "Idle" }),
    profileAuditStart: () => "<!-- audit:start -->",
    profileAuditEnd: () => "<!-- audit:end -->",
    markdownLink: (label, url) => `[${label}](${url})`,
    repoUrlFor: (repo) => `https://github.com/${repo}`,
    itemUrlFor: (repo, number) => `https://github.com/${repo}/issues/${number}`,
    reportFileUrl: (_number, path) => path ?? "report",
    formatTimestamp: (value) => value ?? "never",
    formatStatusNumber: (value) => String(value ?? "unknown"),
    reportEntriesForDir: (dir) =>
      markdownFiles(dir).map((name) => {
        const path = join(dir, name);
        const markdown = readFileSync(path, "utf8");
        return {
          name,
          path,
          markdown,
          number: Number(name.slice(0, -3)),
          repo: markdownRepository(markdown, name),
        };
      }),
  } as Parameters<typeof createDashboardAudit>[0]);
  return {
    root,
    itemsDir,
    closedDir,
    audit,
    put(number: number, markdown: string, closed = false) {
      writeFileSync(join(closed ? closedDir : itemsDir, `${number}.md`), markdown);
    },
    dashboard() {
      audit.updateDashboard(itemsDir, closedDir);
      return readFileSync(readmePath, "utf8");
    },
    auditResult() {
      const output = join(root, "audit.json");
      t.mock.method(console, "log", () => {});
      audit.auditCommand({ items_dir: itemsDir, closed_dir: closedDir, output });
      return JSON.parse(readFileSync(output, "utf8"));
    },
  };
}

test("audit records prefer typed decision, confidence and close reason without retaining reports", (t) => {
  const f = fixture(t);
  f.put(
    42,
    withReviewRecord(report(42), {
      decision: "close",
      confidence: "medium",
      closeReason: "implemented_on_main",
    }),
  );
  f.put(43, report(43, { decision: "close", confidence: "low", close_reason: "legacy_reason" }));
  f.put(44, report(44, { decision: undefined, confidence: undefined, close_reason: undefined }));
  const findings = f.auditResult().findings.staleItemRecords;
  const typed = findings.find((finding) => finding.number === 42);
  assert.equal(typed.decision, "close");
  assert.equal(typed.confidence, "medium");
  assert.equal(typed.closeReason, "implemented_on_main");
  assert.equal(Object.hasOwn(typed, "markdown"), false);
  assert.equal(Object.hasOwn(typed, "review"), false);
  const legacy = findings.find((finding) => finding.number === 43);
  assert.equal(legacy.decision, "close");
  assert.equal(legacy.confidence, "low");
  assert.equal(legacy.closeReason, "legacy_reason");
  const missing = findings.find((finding) => finding.number === 44);
  for (const key of ["decision", "confidence", "closeReason"]) {
    assert.equal(Object.hasOwn(missing, key), false);
  }
});

test("audit projection preserves metadata and output while filtering other repositories", (t) => {
  const f = fixture(t);
  const reviewedAt = "2026-08-01T12:00:00.000Z";
  const typed = withReviewRecord(
    report(42, {
      title: "Unicode audit title: café 漢字",
      labels: '["audit-label-long-enough-to-slice","bug"]',
      reviewed_at: reviewedAt,
      decision: "keep_open",
      confidence: "low",
      close_reason: "legacy_reason",
      action_taken: "proposed_close",
      current_state: "open",
    }),
    { decision: "close", confidence: "medium", closeReason: "implemented_on_main" },
  );
  const legacy = report(43, {
    reviewed_at: reviewedAt,
    decision: "keep_open",
    confidence: "high",
    close_reason: "none",
    current_state: "open",
  });
  f.put(42, typed);
  f.put(43, legacy);
  f.put(42, typed, true);
  f.put(90, report(90, { repository: "openclaw/clawsweeper" }));
  f.put(91, report(91, { repository: "openclaw/clawsweeper" }), true);

  const before = f.auditResult();
  assert.equal(before.counts.itemRecords, 2);
  assert.equal(before.counts.closedRecords, 1);
  const typedFinding = {
    number: 42,
    kind: "issue",
    title: "Unicode audit title: café 漢字",
    labels: ["audit-label-long-enough-to-slice", "bug"],
    action: "proposed_close",
    decision: "close",
    closeReason: "implemented_on_main",
    confidence: "medium",
    reviewedAt,
    reviewStatus: "complete",
    currentState: "open",
    itemPath: join("items", "42.md"),
  };
  assert.deepEqual(before.findings.staleItemRecords, [
    typedFinding,
    {
      number: 43,
      kind: "issue",
      title: "Item 43",
      labels: [],
      action: "kept_open",
      decision: "keep_open",
      closeReason: "none",
      confidence: "high",
      reviewedAt,
      reviewStatus: "complete",
      currentState: "open",
      itemPath: join("items", "43.md"),
    },
  ]);
  assert.deepEqual(before.findings.duplicateRecords, [
    { ...typedFinding, closedPath: join("closed", "42.md") },
  ]);

  const body = `\n## Evidence\n\n${"Unrelated report evidence. ".repeat(4096)}`;
  f.put(42, typed + body);
  f.put(43, legacy + body);
  f.put(42, typed + body, true);
  const after = f.auditResult();
  // The timestamp is the only output field that depends on when audit runs.
  assert.deepEqual({ ...after, generatedAt: null }, { ...before, generatedAt: null });
});

test("dashboard outcomes, work queue priority and recent closes prefer the review record", (t) => {
  const f = fixture(t);
  f.put(42, withReviewRecord(report(42, { action_taken: "proposed_close" })));
  f.put(
    43,
    withReviewRecord(report(43), {
      decision: "keep_open",
      closeReason: "none",
      workCandidate: "queue_fix_pr",
      workPriority: "high",
    }),
  );
  f.put(44, report(44, { work_candidate: "queue_fix_pr", work_priority: "medium" }));
  f.put(
    45,
    withReviewRecord(
      report(45, {
        action_taken: "closed",
        applied_at: new Date().toISOString(),
        close_reason: "legacy_reason",
      }),
    ),
    true,
  );
  const dashboard = f.dashboard();
  assert.match(dashboard, /\| Proposed closes awaiting apply \| 1 /);
  assert.match(dashboard, /\| Work candidates awaiting promotion \| 2 \|/);
  assert.match(dashboard, /\[close \/ proposed_close\]\(items\/42\.md\)/);
  assert.match(dashboard, /Item 43 \| high \| candidate \|/);
  assert.match(dashboard, /Item 44 \| medium \| candidate \|/);
  assert.ok(dashboard.indexOf("Item 43 | high") < dashboard.indexOf("Item 44 | medium"));
  assert.doesNotMatch(dashboard, /legacy_reason/);
  assert.match(dashboard, /implemented on main/i);
});

test("legacy dashboard outcomes preserve defaults and work queue fields", (t) => {
  const f = fixture(t);
  f.put(
    42,
    report(42, {
      decision: "close",
      action_taken: "proposed_close",
      work_candidate: "queue_fix_pr",
      work_priority: "high",
    }),
  );
  f.put(
    43,
    report(43, { decision: undefined, work_candidate: undefined, work_priority: undefined }),
  );
  const dashboard = f.dashboard();
  assert.match(dashboard, /\| Proposed closes awaiting apply \| 1 /);
  assert.match(dashboard, /\| Work candidates awaiting promotion \| 1 \|/);
  assert.match(dashboard, /Item 42 \| high \| candidate \|/);
  assert.match(dashboard, /\[unknown \/ kept_open\]\(items\/43\.md\)/);
});

test("typed keep-open and no-work decisions suppress stale legacy proposals", (t) => {
  const f = fixture(t);
  f.put(
    42,
    withReviewRecord(
      report(42, {
        decision: "close",
        action_taken: "proposed_close",
        work_candidate: "queue_fix_pr",
        work_priority: "high",
      }),
      { decision: "keep_open", closeReason: "none", workCandidate: "none" },
    ),
  );
  const dashboard = f.dashboard();
  assert.match(dashboard, /\| Proposed closes awaiting apply \| 0 /);
  assert.match(dashboard, /\| Work candidates awaiting promotion \| 0 \|/);
  assert.match(dashboard, /\[keep_open \/ proposed_close\]\(items\/42\.md\)/);
  assert.doesNotMatch(dashboard, /Item 42 \| high \| candidate/);
});

test("dashboard activity counts typed decisions and preserves legacy unknown decisions", () => {
  const now = Date.now();
  const legacy = report(42, { reviewed_at: new Date(now).toISOString() });
  for (const [markdown, closeDecisions, keepOpenDecisions] of [
    [withReviewRecord(legacy), 1, 0],
    [legacy, 0, 1],
    [report(42, { reviewed_at: new Date(now).toISOString(), decision: undefined }), 0, 0],
  ] as const) {
    const activity = planning.emptyDashboardActivityStats();
    planning.recordDashboardActivity(markdown, activity, now);
    for (const bucket of [activity.last15Minutes, activity.lastHour, activity.last24Hours]) {
      assert.equal(bucket.reviews, 1);
      assert.equal(bucket.closeDecisions, closeDecisions);
      assert.equal(bucket.keepOpenDecisions, keepOpenDecisions);
    }
  }
});

test("dashboard close reasons retain host-owned external-close descriptions", () => {
  for (const [fields, expected] of [
    [{ action_taken: "closed" }, "implemented_on_main"],
    [{ action_taken: "skipped_already_closed" }, "already closed before apply"],
    [{ action_taken: "kept_open", current_state: "closed" }, "closed externally after review"],
    [
      { action_taken: "skipped_changed_since_review", current_state: "closed" },
      "closed externally after item changed",
    ],
    [{ action_taken: "other", current_state: "closed" }, "closed externally after other"],
    [{ action_taken: undefined, current_state: "closed" }, "closed externally"],
  ] as const) {
    assert.equal(presentation.dashboardCloseReason(withReviewRecord(report(42, fields))), expected);
  }
  assert.equal(
    presentation.dashboardCloseReason(report(42, { close_reason: "legacy_reason" })),
    "legacy_reason",
  );
  assert.equal(
    presentation.dashboardCloseReason(report(42, { close_reason: undefined })),
    undefined,
  );
});

for (const location of ["items", "closed"] as const) {
  test(`unreadable ${location} review record fails audit and dashboard closed`, (t) => {
    const f = fixture(t);
    const corrupt = withReviewRecord(
      report(42, { action_taken: "closed", applied_at: new Date().toISOString() }),
    ).replace(/^review_record: \{/m, "review_record: {broken");
    f.put(42, corrupt, location === "closed");
    assert.throws(() => f.auditResult(), ReviewRecordFormatError);
    assert.throws(() => f.dashboard(), ReviewRecordFormatError);
    assert.equal(
      readFileSync(join(f.root, "README.md"), "utf8"),
      "## Dashboard\n\n## How It Works\n",
    );
  });
}

test("unreadable review records never fall back in activity or external close descriptions", () => {
  const corrupt = withReviewRecord(
    report(42, {
      action_taken: "kept_open",
      current_state: "closed",
    }),
  ).replace(/^review_record: \{/m, "review_record: {broken");
  assert.throws(() => presentation.dashboardCloseReason(corrupt), ReviewRecordFormatError);
  assert.throws(
    () =>
      planning.recordDashboardActivity(corrupt, planning.emptyDashboardActivityStats(), Date.now()),
    ReviewRecordFormatError,
  );
});
