import assert from "node:assert/strict";
import test from "node:test";
import { codexFailureDecisionForTest, parseDecision } from "../dist/clawsweeper.js";
import { createReportDocumentRendering } from "../dist/clawsweeper-report-document.js";
import { createReportContextRendering } from "../dist/clawsweeper-report-context.js";
import { createDashboardPresentation } from "../dist/clawsweeper-dashboard.js";
import * as repositoryLinks from "../dist/clawsweeper-links.js";
import { oversizedPullRequestDecision } from "../dist/clawsweeper-oversized-pr-policy.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import { replaceFrontMatterValue } from "../dist/report-front-matter.js";
import { readReviewRecord, updateReviewRecordDecision } from "../dist/review-record.js";
import type { Decision } from "../src/clawsweeper-types.ts";
import { closeDecision, item } from "./helpers.ts";

const pullRequest = item({ kind: "pull_request", number: 42 });

function report(decision: Decision): string {
  const document = createReportDocumentRendering({
    ...repositoryLinks,
    ...createReportContextRendering({} as never),
    ...createDashboardPresentation({} as never),
    compactPullFilePaths: () => [],
    formatTimestamp: String,
    labelJustificationsMarkdown: () => "- none",
    pullHeadShaFromContext: () => "c".repeat(40),
    reviewStructuralPullStateFromContext: () => null,
    targetProfile: () => repositoryProfileFor("openclaw/openclaw"),
  } as Parameters<typeof createReportDocumentRendering>[0]);
  return document.markdownFor({
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
}

function recordLine(markdown: string): string {
  const lines = markdown.split("\n").filter((line) => line.startsWith("review_record: "));
  assert.equal(lines.length, 1);
  return lines[0]!;
}

function withStoredRecord(markdown: string, stored: unknown): string {
  return replaceFrontMatterValue(markdown, "review_record", JSON.stringify(stored));
}

function storedRecord(markdown: string): { version: number; decision: Record<string, unknown> } {
  return JSON.parse(recordLine(markdown).slice("review_record: ".length));
}

const modelDecision = (): Decision =>
  parseDecision(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      rootCauseCluster: {
        confidence: "high",
        canonicalRef: "https://github.com/openclaw/openclaw/issues/7",
        currentItemRelationship: "fixed_by_candidate",
        summary: "This PR fixes the canonical issue.",
        members: [
          {
            ref: "https://github.com/openclaw/openclaw/issues/7",
            relationship: "canonical",
            reason: "The issue reports the bug.",
          },
        ],
      },
    }),
    pullRequest,
  );

const runnerFields = {
  localCheckoutAccess: "verified",
  fixedPullRequest: {
    repo: "openclaw/openclaw",
    number: 9,
    url: "https://github.com/openclaw/openclaw/pull/9",
    title: "Fix it",
    mergedAt: "2026-07-31T12:00:00Z",
    sha: "b".repeat(40),
    confidence: "high",
    source: "GitHub commit PR lookup",
  },
  regressionProvenance: {
    repo: "openclaw/openclaw",
    pullRequestNumber: 936,
    pullRequestUrl: "https://github.com/openclaw/openclaw/pull/936",
    mergeCommitSha: "a".repeat(40),
    sourcePath: "src/runtime.ts",
    sourceLine: 42,
    verificationSource: "raw_parent_line_v1",
    evidenceType: "blame_to_merge_commit",
    mergedAt: "2026-07-31T12:00:00Z",
    reviewedCommitSha: "b".repeat(40),
    sourceCommitSha: "a".repeat(40),
    sourceAuthor: "Source Author",
  },
} as const;

test("review reports store the typed decision and read it back unchanged", () => {
  const size = {
    threshold: 5000,
    additions: 9000,
    deletions: 10,
    changedFiles: 40,
    head: "d".repeat(40),
  };
  const source = {
    fingerprint: "e".repeat(64),
    updatedAt: "2026-07-31T12:00:00Z",
    observedAt: "2026-07-31T12:05:00Z",
    comments: 2,
    reviewComments: 0,
  };
  for (const [name, decision] of [
    ["model review", modelDecision()],
    [
      "model review with runner fields",
      {
        ...modelDecision(),
        ...runnerFields,
        likelyOwners: modelDecision().likelyOwners.map((owner) => ({
          ...owner,
          attributionSource: "raw_parent_line_v1",
        })),
      } as Decision,
    ],
    ["failed review", codexFailureDecisionForTest(1, "Codex failed", "out", "err")],
    ["oversized pull request", oversizedPullRequestDecision(size, source)],
    [
      "failed review with raw output",
      codexFailureDecisionForTest(1, "Codex failed <stdin>", "## Summary\n<b>", "# err\u2028tail"),
    ],
  ] as const) {
    const markdown = report(decision);
    const frontMatter = markdown.slice(0, markdown.indexOf("\n---\n", 4));
    assert.equal(frontMatter.split("\n").at(-1), recordLine(markdown), name);
    assert.deepEqual(
      JSON.parse(JSON.stringify(readReviewRecord(markdown))),
      JSON.parse(JSON.stringify({ decision })),
      name,
    );
  }
});

test("a review record stays on one front-matter line", () => {
  const decision = { ...modelDecision(), summary: "Line one\u2028line two\u2029line three." };
  const markdown = report(decision);
  assert.doesNotMatch(recordLine(markdown), /[\u2028\u2029]/);
  const stamped = replaceFrontMatterValue(markdown, "action_taken", "proposed_close");
  assert.equal(readReviewRecord(stamped)?.decision.summary, decision.summary);
});

test("a review record that changed outside its writer is rejected", () => {
  const markdown = report({ ...modelDecision(), ...runnerFields } as Decision);
  const stored = storedRecord(markdown);
  const invalid: Array<[string, string]> = [
    ["not JSON", replaceFrontMatterValue(markdown, "review_record", "{")],
    ["unknown version", withStoredRecord(markdown, { ...stored, version: 2 })],
    ["unknown key", withStoredRecord(markdown, { ...stored, note: "x" })],
    ["unknown origin", withStoredRecord(markdown, { ...stored, origin: "manual" })],
    [
      "invalid enum",
      withStoredRecord(markdown, {
        ...stored,
        decision: { ...stored.decision, decision: "maybe" },
      }),
    ],
    [
      "unknown runner key",
      withStoredRecord(markdown, {
        ...stored,
        decision: {
          ...stored.decision,
          fixedPullRequest: { ...runnerFields.fixedPullRequest, note: "x" },
        },
      }),
    ],
    [
      "root-cause cluster that is not valid for the item",
      withStoredRecord(markdown, {
        ...stored,
        decision: {
          ...stored.decision,
          rootCauseCluster: {
            confidence: "high",
            canonicalRef: null,
            currentItemRelationship: "duplicate",
            summary: "Duplicate without a canonical item.",
            members: [],
          },
        },
      }),
    ],
    ["two record lines", markdown.replace("\n---\n", `\n${recordLine(markdown)}\n---\n`)],
  ];
  for (const [name, value] of invalid) {
    assert.throws(() => readReviewRecord(value), { name: "ReviewRecordFormatError" }, name);
  }
  assert.equal(readReviewRecord(markdown.replace(`${recordLine(markdown)}\n`, "")), null);
  for (const [name, value] of invalid) {
    const updated = updateReviewRecordDecision(value, () => ({ decision: "close" }));
    assert.equal(readReviewRecord(updated), null, name);
    assert.equal(
      updated.replace(/^---\n[\s\S]*?\n---\n/, ""),
      value.replace(/^---\n[\s\S]*?\n---\n/, ""),
    );
  }
});

test("decision updates change the stored record and keep its origin", () => {
  const markdown = report(modelDecision());
  const backfilled = withStoredRecord(markdown, { ...storedRecord(markdown), origin: "backfill" });
  const updated = updateReviewRecordDecision(backfilled, (decision) => ({
    decision: "close",
    closeReason: "duplicate_or_superseded",
    risks: [...decision.risks, "Closed by host evidence."],
  }));
  const record = readReviewRecord(updated);
  assert.equal(record?.origin, "backfill");
  assert.equal(record?.decision.decision, "close");
  assert.equal(record?.decision.closeReason, "duplicate_or_superseded");
  assert.deepEqual(record?.decision.risks.at(-1), "Closed by host evidence.");
  assert.equal(
    updated.replace(recordLine(updated), ""),
    backfilled.replace(recordLine(backfilled), ""),
  );

  const legacy = markdown.replace(`${recordLine(markdown)}\n`, "");
  assert.equal(
    updateReviewRecordDecision(legacy, () => ({ decision: "close" })),
    legacy,
  );
});

test("a decision that would not read back is not stored", () => {
  const invalid = { ...modelDecision(), confidence: "certain" } as unknown as Decision;
  assert.doesNotMatch(report(invalid), /^review_record:/m);
  const markdown = report(modelDecision());
  const updated = updateReviewRecordDecision(markdown, () => ({
    workCandidate: "maybe" as Decision["workCandidate"],
  }));
  assert.equal(readReviewRecord(updated), null);
  assert.equal(updated, markdown.replace(`${recordLine(markdown)}\n`, ""));
});
