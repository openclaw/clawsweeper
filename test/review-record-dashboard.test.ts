import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";

import { createDashboardAudit } from "../dist/clawsweeper-dashboard-audit.js";
import * as presentation from "../dist/clawsweeper-dashboard.js";
import { createReviewPlanningDashboard } from "../dist/clawsweeper-review-planning-dashboard.js";
import * as planning from "../dist/clawsweeper-review-planning-dashboard.js";
import { markdownFiles, markdownRepository } from "../dist/clawsweeper-repository-paths.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import { reportFrontMatter, tmpPrefix, withReviewRecord } from "./helpers.ts";

const overlay = createReviewPlanningDashboard({
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
    ...overlay,
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
    formatTimestamp: (value) => value ?? "never",
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
  for (const key of ["decision", "confidence", "closeReason"]) {
    assert.equal(Object.hasOwn(legacy, key), false);
  }
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
  assert.match(dashboard, /\| Work candidates awaiting promotion \| 1 \|/);
  assert.match(
    dashboard,
    /\[close \/ proposed_close\]\(https:\/\/github\.com\/openclaw\/clawsweeper\/blob\/main\/items\/42\.md\)/,
  );
  assert.match(dashboard, /Item 43 \| high \| candidate \|/);
  assert.match(dashboard, /\[unknown \/ kept_open\].*items\/44\.md/);
  assert.doesNotMatch(dashboard, /Item 44 \| medium \| candidate \|/);
  assert.doesNotMatch(dashboard, /legacy_reason/);
  assert.match(dashboard, /implemented on main/i);
});

test("missing dashboard decisions ignore legacy proposal and work fields", (t) => {
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
  assert.match(dashboard, /\| Proposed closes awaiting apply \| 0 /);
  assert.match(dashboard, /\| Work candidates awaiting promotion \| 0 \|/);
  assert.doesNotMatch(dashboard, /Item 42 \| high \| candidate \|/);
  assert.match(dashboard, /\[unknown \/ proposed_close\].*items\/42\.md/);
  assert.match(
    dashboard,
    /\[unknown \/ kept_open\]\(https:\/\/github\.com\/openclaw\/clawsweeper\/blob\/main\/items\/43\.md\)/,
  );
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
  assert.match(
    dashboard,
    /\[keep_open \/ proposed_close\]\(https:\/\/github\.com\/openclaw\/clawsweeper\/blob\/main\/items\/42\.md\)/,
  );
  assert.doesNotMatch(dashboard, /Item 42 \| high \| candidate/);
});

test("dashboard activity counts typed decisions but not missing decisions", () => {
  const now = Date.now();
  const legacy = report(42, { reviewed_at: new Date(now).toISOString() });
  for (const [markdown, closeDecisions, keepOpenDecisions] of [
    [withReviewRecord(legacy), 1, 0],
    [withReviewRecord(legacy, { decision: "keep_open", closeReason: "none" }), 0, 1],
    [legacy, 0, 0],
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
    undefined,
  );
  assert.equal(
    presentation.dashboardCloseReason(report(42, { close_reason: undefined })),
    undefined,
  );
});

for (const location of ["items", "closed"] as const) {
  test(`mixed ${location} records retain host metadata without unreadable decisions`, (t) => {
    const f = fixture(t);
    const timestamp = new Date().toISOString();
    const fields = {
      action_taken: location === "closed" ? "closed" : "proposed_close",
      applied_at: location === "closed" ? timestamp : undefined,
      decision: "close",
      close_reason: "legacy_reason",
      confidence: "high",
      work_candidate: "queue_fix_pr",
      work_priority: "high",
    };
    const missing = report(42, fields);
    const corrupt = withReviewRecord(report(43, fields)).replace(
      /^review_record: \{/m,
      "review_record: {broken",
    );
    const valid = withReviewRecord(report(44, fields), {
      decision: "close",
      confidence: "medium",
      closeReason: "implemented_on_main",
      workCandidate: "queue_fix_pr",
      workPriority: "high",
    });
    f.put(42, missing, location === "closed");
    f.put(43, corrupt, location === "closed");
    f.put(44, valid, location === "closed");

    const result = f.auditResult();
    assert.equal(result.counts[location === "closed" ? "closedRecords" : "itemRecords"], 3);
    if (location === "items") {
      const findings = result.findings.staleItemRecords;
      for (const number of [42, 43]) {
        const finding = findings.find((entry) => entry.number === number);
        assert.equal(finding.title, `Item ${number}`);
        assert.equal(finding.action, "proposed_close");
        assert.equal(finding.reviewStatus, "complete");
        for (const key of ["decision", "closeReason", "confidence"]) {
          assert.equal(Object.hasOwn(finding, key), false);
        }
      }
      const typed = findings.find((entry) => entry.number === 44);
      assert.equal(typed.decision, "close");
      assert.equal(typed.closeReason, "implemented_on_main");
      assert.equal(typed.confidence, "medium");
    }

    const dashboard = f.dashboard();
    const dir = location === "closed" ? f.closedDir : f.itemsDir;
    assert.equal(readFileSync(join(dir, "42.md"), "utf8"), missing);
    assert.equal(readFileSync(join(dir, "43.md"), "utf8"), corrupt);
    assert.equal(readFileSync(join(dir, "44.md"), "utf8"), valid);
    assert.doesNotMatch(dashboard, /legacy_reason/);
    for (const number of [42, 43, 44]) {
      assert.match(dashboard, new RegExp(`Item ${number}`));
    }
    if (location === "items") {
      assert.match(dashboard, /\| Proposed closes awaiting apply \| 1 /);
      assert.match(dashboard, /\| Work candidates awaiting promotion \| 1 \|/);
      assert.match(dashboard, /Item 44 \| high \| candidate \|/);
      for (const number of [42, 43]) {
        assert.match(dashboard, new RegExp(`\\[unknown / proposed_close\\].*items/${number}\\.md`));
        assert.doesNotMatch(dashboard, new RegExp(`Item ${number} \\| high \\| candidate`));
      }
    } else {
      assert.match(dashboard, /Item 42 \| unknown \|/);
      assert.match(dashboard, /Item 43 \| unknown \|/);
      assert.match(dashboard, /Item 44 \| already implemented on main \|/i);
    }
  });
}

test("unreadable review activity and external close descriptions retain only host metadata", () => {
  const now = Date.now();
  const missing = report(42, {
    reviewed_at: new Date(now).toISOString(),
    action_taken: "kept_open",
    current_state: "closed",
    applied_at: new Date(now).toISOString(),
  });
  const corrupt = withReviewRecord(missing).replace(
    /^review_record: \{/m,
    "review_record: {broken",
  );
  for (const markdown of [missing, corrupt]) {
    assert.equal(presentation.dashboardCloseReason(markdown), "closed externally after review");
    const activity = planning.emptyDashboardActivityStats();
    planning.recordDashboardActivity(markdown, activity, now);
    for (const bucket of [activity.last15Minutes, activity.lastHour, activity.last24Hours]) {
      assert.equal(bucket.reviews, 1);
      assert.equal(bucket.closes, 1);
      assert.equal(bucket.closeDecisions, 0);
      assert.equal(bucket.keepOpenDecisions, 0);
    }
  }
});
