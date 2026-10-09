import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { codexFailureDecisionForTest, parseDecision } from "../dist/clawsweeper.js";
import { createReportDocumentRendering } from "../dist/clawsweeper-report-document.js";
import { createReportContextRendering } from "../dist/clawsweeper-report-context.js";
import { createDashboardPresentation } from "../dist/clawsweeper-dashboard.js";
import { createRepositoryLinks } from "../dist/clawsweeper-links.js";
import { oversizedPullRequestDecision } from "../dist/clawsweeper-oversized-pr-policy.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import { readReviewRecord } from "../dist/review-record.js";
import { createReviewRecordBackfill } from "../dist/review-record-backfill.js";
import type { Decision } from "../src/clawsweeper-types.ts";
import {
  closeDecision,
  item,
  lowSignalCloseReport,
  tmpPrefix,
  withReviewRecord,
} from "./helpers.ts";

const pullRequest = item({ kind: "pull_request", number: 42 });
const document = createReportDocumentRendering({
  ...createRepositoryLinks({
    reportRepo: "openclaw/clawsweeper-state",
    targetRepo: () => "openclaw/openclaw",
    targetProfile: () => repositoryProfileFor("openclaw/openclaw"),
  }),
  ...createReportContextRendering({} as never),
  ...createDashboardPresentation({} as never),
  compactPullFilePaths: () => [],
  formatTimestamp: String,
  labelJustificationsMarkdown: () => "- none",
  pullHeadShaFromContext: () => "c".repeat(40),
  reviewStructuralPullStateFromContext: () => null,
  targetProfile: () => repositoryProfileFor("openclaw/openclaw"),
} as Parameters<typeof createReportDocumentRendering>[0]);
const { backfillReviewRecord } = createReviewRecordBackfill(document);

// A report from before review_record existed: the current writer without the record line.
function legacyReport(decision: Decision): string {
  const markdown = document.markdownFor({
    item: pullRequest,
    decision,
    context: { issue: {}, comments: [], timeline: [] },
    git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
    action: { actionTaken: "kept_open" },
    reviewMode: "propose",
    snapshotHash: "synthetic-snapshot",
    contentDigest: "synthetic-content",
    reviewPolicy: "synthetic-policy",
    runtime: { model: "Codex", reasoningEffort: "high" },
  } as Parameters<typeof document.markdownFor>[0]);
  return markdown.replace(/^review_record: .*\n/m, "");
}

// The report cannot tell an absent optional field from its empty value.
const OPTIONAL_FIELDS = [
  "fixedRelease",
  "fixedSha",
  "fixedAt",
  "fixedPullRequest",
  "regressionAssessment",
  "regressionProvenance",
  "checkoutInspectionFailed",
  "codexTerminalFailure",
];
function withoutEmptyOptionalFields(decision: Decision): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(JSON.parse(JSON.stringify(decision)) as Record<string, unknown>).filter(
      ([key, value]) => !OPTIONAL_FIELDS.includes(key) || (value !== null && value !== false),
    ),
  );
}

test("the backfill makes the same typed decision from a report the review wrote", () => {
  const model = parseDecision(
    closeDecision({ decision: "keep_open", closeReason: "none", risks: ["One open risk."] }),
    pullRequest,
  );
  const size = {
    threshold: 5000,
    additions: 9000,
    deletions: 10,
    changedFiles: 40,
    head: "d".repeat(40),
  };
  for (const [name, decision] of [
    ["model review", { ...model, localCheckoutAccess: "verified" } as Decision],
    ["failed review", codexFailureDecisionForTest(1, "Codex failed <stdin>", "## out", "err")],
    ["oversized pull request", oversizedPullRequestDecision(size)],
  ] as const) {
    const result = backfillReviewRecord(legacyReport(decision));
    assert.equal(result.status, "lossless", `${name}: ${JSON.stringify(result)}`);
    assert.ok("markdown" in result);
    const record = readReviewRecord(result.markdown);
    assert.equal(record?.origin, "backfill", name);
    assert.deepEqual(
      withoutEmptyOptionalFields(record!.decision),
      withoutEmptyOptionalFields({
        ...decision,
        // The report shows owners as the runner publishes them, and its Close Comment
        // section holds the comment that apply posts: none for a kept-open report.
        likelyOwners: record!.decision.likelyOwners,
        closeComment: "",
      } as Decision),
      name,
    );
  }
});

test("the backfill names the decision fields that the report lost", () => {
  const legacy = legacyReport(
    parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), pullRequest),
  );
  // Older reviews wrote a testing-review line that the decision no longer has.
  const report = legacy.replace("\n\nMissing E2E:", "\n\nAdded test files: 3\n\nMissing E2E:");
  assert.notEqual(report, legacy);
  const result = backfillReviewRecord(report);
  assert.equal(result.status, "lossy");
  assert.ok("differences" in result);
  assert.deepEqual(
    result.differences.map((difference) => difference.field),
    ["## Testing Review"],
  );
});

test("a report that predates a decision field is filled, not lossy", () => {
  const legacy = legacyReport(
    parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), pullRequest),
  );
  const report = legacy.replace(/^product_kind: .*\n/m, "");
  assert.notEqual(report, legacy);
  const result = backfillReviewRecord(report);
  assert.equal(result.status, "filled", JSON.stringify(result));
  assert.ok("differences" in result);
  assert.deepEqual(
    result.differences.map((difference) => difference.field),
    ["product_kind"],
  );
});

test("the backfill leaves typed reports and reports it cannot read", () => {
  const typed = withReviewRecord(lowSignalCloseReport({ number: 7 }));
  assert.deepEqual(backfillReviewRecord(typed), { status: "typed" });
  const invalid = typed.replace(/^review_record: \{/m, "review_record: [");
  assert.equal(backfillReviewRecord(invalid).status, "invalid_record");
  const unparseable = backfillReviewRecord(
    lowSignalCloseReport({ number: 8 }).replace(/^decision: .*\n/m, ""),
  );
  assert.deepEqual(unparseable, { status: "unparseable", reason: "front matter has no decision" });
});

test("backfill-review-records reports counts for a records directory and writes nothing", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const recordsDir = join(root, "records", "openclaw-openclaw");
    for (const section of ["items", "closed"])
      mkdirSync(join(recordsDir, section), { recursive: true });
    const typed = withReviewRecord(lowSignalCloseReport({ number: 7 }));
    const unparseable = lowSignalCloseReport({ number: 8 }).replace(/^decision: .*\n/m, "");
    writeFileSync(join(recordsDir, "items", "7.md"), typed);
    writeFileSync(join(recordsDir, "closed", "8.md"), unparseable);
    const output = join(root, "backfill.json");
    execFileSync(process.execPath, [
      "dist/clawsweeper.js",
      "backfill-review-records",
      "--records-dir",
      recordsDir,
      "--output",
      output,
    ]);
    const summary = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.counts, {
      typed: 1,
      invalid_record: 0,
      unparseable: 1,
      lossless: 0,
      filled: 0,
      lossy: 0,
    });
    assert.deepEqual(summary.reasons, { "front matter has no decision": 1 });
    assert.deepEqual(summary.examples, { typed: ["items/7.md"], unparseable: ["closed/8.md"] });
    assert.equal(readFileSync(join(recordsDir, "items", "7.md"), "utf8"), typed);
    assert.equal(readFileSync(join(recordsDir, "closed", "8.md"), "utf8"), unparseable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
