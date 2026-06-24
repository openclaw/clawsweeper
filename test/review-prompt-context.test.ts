import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compactPullRequestForTest,
  renderReviewContextBudgetForTest,
  reviewContextLedgerForTest,
  reviewDecisionSchemaText,
  reviewPromptForTest,
  reviewPromptTelemetryForTest,
  reviewPromptTemplate,
} from "../dist/clawsweeper.js";
import { parseArgs as parseClawsweeperArgs } from "../dist/clawsweeper-args.js";
import { git, item } from "./helpers.ts";

test("review prompt assets match tracked files", () => {
  assert.equal(reviewPromptTemplate(), readFileSync("prompts/review-item.md", "utf8"));
  assert.deepEqual(
    JSON.parse(reviewDecisionSchemaText()),
    JSON.parse(readFileSync("schema/clawsweeper-decision.schema.json", "utf8")),
  );
});

test("sweep apply jobs wire the default-off product direction policy gate", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  assert.equal(
    workflow.match(/CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED:/g)?.length,
    2,
  );
  assert.match(
    workflow,
    /vars\.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED \|\| 'false'/,
  );
});

test("main CLI args ignore package-manager double dash separators", () => {
  assert.deepEqual(parseClawsweeperArgs(["apply-decisions", "--", "--dry-run"]), {
    _: ["apply-decisions"],
    dry_run: true,
  });
  assert.deepEqual(parseClawsweeperArgs(["apply-decisions", "--limit", "1", "--", "--dry-run"]), {
    _: ["apply-decisions"],
    limit: "1",
    dry_run: true,
  });
});

test("review prompt telemetry records durable cost proxies", () => {
  const context = {
    issue: { number: 123, title: "Sample item" },
    comments: [{ author: "contributor", body: "This still reproduces." }],
    timeline: [],
    counts: { comments: 1, timeline: 0 },
  };

  const telemetry = reviewPromptTelemetryForTest(
    item({ title: "Telemetry regression" }),
    context,
    git,
    "keep extra instructions visible",
  );

  assert.ok(telemetry.staticPromptChars > 1000);
  assert.ok(telemetry.schemaChars > 1000);
  assert.ok(telemetry.contextChars >= JSON.stringify(context, null, 2).length);
  assert.ok(telemetry.promptChars > telemetry.staticPromptChars + telemetry.contextChars);
  assert.equal(telemetry.additionalPromptChars, "keep extra instructions visible".length);
});

test("review prompt includes compact previous review state without raw durable review body", () => {
  const context = {
    issue: { number: 123, title: "Sample PR" },
    comments: [{ author: "contributor", body: "After-fix proof is attached." }],
    timeline: [],
    previousClawSweeperReview: {
      status: "found issues before merge.",
      reviewedSha: "abc123",
      summary: "Prior review found one blocker.",
    },
    counts: { comments: 3, commentsIncluded: 1, commentsFiltered: 2, timeline: 0 },
  };

  const prompt = reviewPromptForTest(item({ kind: "pull_request", number: 123 }), context, git);

  assert.match(prompt, /"previousClawSweeperReview"/);
  assert.match(prompt, /Prior review found one blocker/);
  assert.match(prompt, /"commentsFiltered": 2/);
  assert.doesNotMatch(prompt, /How this review workflow works/);
});

test("review prompt includes merge state and guards clean behind-branch drift", () => {
  const compactPullRequest = compactPullRequestForTest({
    number: 123,
    title: "Sample PR",
    html_url: "https://github.com/openclaw/openclaw/pull/123",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { ref: "feature", sha: "head123" },
    base: { ref: "main", sha: "base123" },
    user: { login: "contributor" },
    additions: 10,
    deletions: 2,
    changed_files: 1,
  });
  const context = {
    issue: { number: 123, title: "Sample PR" },
    comments: [],
    timeline: [],
    pullRequest: compactPullRequest,
    counts: { comments: 0, timeline: 0 },
  };

  const prompt = reviewPromptForTest(item({ kind: "pull_request", number: 123 }), context, git);

  assert.deepEqual((compactPullRequest as { mergeableState?: unknown }).mergeableState, "clean");
  assert.match(prompt, /"mergeableState": "clean"/);
  assert.match(prompt, /Do not treat a branch being behind the current base as proof/);
  assert.match(prompt, /actual three-way merge result/);
});

test("review context ledger records ordered section budgets", () => {
  const context = {
    issue: { number: 123, title: "Sample PR" },
    comments: [{ author: "alice", body: "Please review this." }],
    timeline: [{ event: "committed", sha: "abc123" }],
    previousClawSweeperReview: {
      status: "found issues before merge.",
      reviewedSha: "abc123",
      summary: "Prior review found one blocker.",
    },
    relatedItems: [{ number: 122, title: "Related issue" }],
    pullRequest: { number: 123, additions: 12 },
    pullFiles: [
      { filename: "src/example.ts", patch: "line\n".repeat(20) },
      { filename: "test/example.test.ts", patch: "test\n".repeat(20) },
    ],
    pullCommits: [{ sha: "abc123", message: "fix example" }],
    pullReviewComments: [],
    counts: {
      comments: 10,
      commentsHydrated: 1,
      commentsTruncated: true,
      timeline: 1,
      timelineHydrated: 1,
      timelineTruncated: false,
      relatedItems: 1,
      pullFiles: 120,
      pullFilesHydrated: 2,
      pullFilesTruncated: true,
      pullCommits: 1,
      pullCommitsHydrated: 1,
      pullCommitsTruncated: false,
      pullReviewComments: 0,
      pullReviewCommentsHydrated: 0,
      pullReviewCommentsTruncated: false,
    },
  };

  const ledger = reviewContextLedgerForTest(context);

  assert.deepEqual(
    ledger.map(({ section, entries, total, hydrated, truncated }) => [
      section,
      entries,
      total,
      hydrated,
      truncated,
    ]),
    [
      ["issue", 1, undefined, undefined, undefined],
      ["comments", 1, 10, 1, true],
      ["timeline", 1, 1, 1, false],
      ["previousClawSweeperReview", 1, undefined, undefined, undefined],
      ["relatedItems", 1, 1, undefined, undefined],
      ["pullRequest", 1, undefined, undefined, undefined],
      ["pullFiles", 2, 120, 2, true],
      ["pullCommits", 1, 1, 1, false],
      ["counts", 16, undefined, undefined, undefined],
    ],
  );
  assert.equal(
    ledger.find((entry) => entry.section === "pullFiles")?.chars,
    JSON.stringify(context.pullFiles, null, 2).length,
  );
  assert.match(
    renderReviewContextBudgetForTest(context),
    /- PR files: 2\/120 hydrated, truncated, \d+ chars/,
  );
  assert.match(renderReviewContextBudgetForTest(context), /- timeline events: 1\/1 hydrated/);
  assert.match(renderReviewContextBudgetForTest(context), /- previous ClawSweeper review: 1 entry/);
});
