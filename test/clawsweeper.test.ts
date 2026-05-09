import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tmpPrefix = join(tmpdir(), "clawsweeper-test-");

import {
  applyDecisionPriority,
  auditFromSnapshot,
  auditHasStrictFailures,
  auditHealthSection,
  canPatchReviewComment,
  closeReasonApplyAgeSkipReason,
  closeReasonsArg,
  closingPullRequestReferenceTarget,
  compactMappedSlice,
  compactMappedWindow,
  codexEnv,
  dashboardClosedAt,
  fixedPullRequestFromCommitPullsForTest,
  formatRecentClosedRows,
  githubContextWindowPlan,
  ghPagedContextWindow,
  githubPaginatedPath,
  ghRetryKind,
  hotIntakeRecencyMs,
  isCodexReviewCommentBody,
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
  isProtectedItem,
  itemNumbersArg,
  lockedConversationApplyReason,
  openClosingPullRequestApplyReason,
  parseGhJson,
  parseGhJsonLines,
  parseDecision,
  protectedLabels,
  realBehaviorProofSufficientLabelsForTest,
  relatedTitleSearchTerms,
  renderReviewStartStatusComment,
  reviewArtifactDestination,
  reviewAutomationMarkersFromReport,
  reviewActionForDecision,
  reviewPriority,
  renderReviewCommentFromReport,
  renderWorkPlanFromReport,
  reviewDecisionSchemaText,
  reviewPromptTelemetryForTest,
  reviewPromptTemplate,
  runtimeBudgetExceeded,
  safeOutputTail,
  sameAuthorCounterpartApplyReason,
  sanitizePublicSelfReferences,
  appendFloorBackfillCandidateNumbersForTest,
  selectDueCandidateNumbersForTest,
  shardItemNumbers,
  shouldStopSaturatedPlanScan,
  shouldSyncReviewComment,
  shouldReviewItem,
  shouldRetryGh,
  shouldPlanItem,
  validateCloseDecision,
} from "../dist/clawsweeper.js";
import { checkConclusionForFrontMatter } from "../dist/commit-checks.js";
import { skippedNonCodeReport } from "../dist/commit-classifier.js";
import {
  commitReportRelativePath,
  isReviewableCommitPath,
  parseCommitReportSince,
  parseCoAuthors,
} from "../dist/commit-sweeper.js";
import { parseArgs as parseClawsweeperArgs } from "../dist/clawsweeper-args.js";

function item(overrides = {}) {
  return {
    repo: "openclaw/openclaw",
    number: 123,
    kind: "issue",
    title: "Sample item",
    url: "https://github.com/openclaw/openclaw/issues/123",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    author: "contributor",
    authorAssociation: "NONE",
    labels: [],
    ...overrides,
  };
}

function closeDecision(overrides = {}) {
  return {
    decision: "close",
    closeReason: "implemented_on_main",
    confidence: "high",
    summary: "Current main already implements this.",
    changeSummary: "Requests confirmation that the feature works on current main.",
    evidence: [
      {
        label: "implementation",
        detail: "The feature is present in source.",
        file: "src/example.ts",
        line: 12,
        command: null,
        sha: "abcdef1234567890",
      },
      {
        label: "git history provenance",
        detail: "git blame traces the implemented line to abcdef1234567890.",
        file: "src/example.ts",
        line: 12,
        command: "git blame -L 12,12 -- src/example.ts",
        sha: "abcdef1234567890",
      },
      {
        label: "release provenance",
        detail: "The fix is on current main and no containing release tag was found.",
        file: null,
        line: null,
        command: "git tag --contains abcdef1234567890",
        sha: "abcdef1234567890",
      },
    ],
    likelyOwners: [
      {
        person: "@alice",
        role: "introduced behavior",
        reason: "git blame points the relevant implementation line at abcdef1234567890.",
        commits: ["abcdef1234567890"],
        files: ["src/example.ts"],
        confidence: "high",
      },
      {
        person: "@bob",
        role: "recent maintainer",
        reason: "Recent adjacent commits changed the same code path.",
        commits: ["1234567890abcdef"],
        files: ["src/example.ts"],
        confidence: "medium",
      },
    ],
    risks: [],
    bestSolution: "Keep the implementation as-is.",
    itemCategory: "bug",
    reproductionStatus: "reproduced",
    reproductionConfidence: "high",
    requiresNewFeature: false,
    requiresNewConfigOption: false,
    requiresProductDecision: false,
    reproductionAssessment:
      "Yes. Current main can be checked by inspecting src/example.ts and git blame evidence.",
    solutionAssessment:
      "Yes. Keeping the implementation as-is is the narrowest maintainable outcome.",
    reviewFindings: [],
    securityReview: {
      status: "not_applicable",
      summary: "No patch security review is needed for this issue cleanup decision.",
      concerns: [],
    },
    realBehaviorProof: {
      status: "not_applicable",
      summary: "Real behavior proof is not required for non-PR issue triage.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    },
    overallCorrectness: "not a patch",
    overallConfidenceScore: 0.75,
    fixedRelease: null,
    fixedSha: "abcdef1234567890",
    fixedAt: "2026-04-28T12:00:00Z",
    closeComment: "Closing this as implemented after Codex review.\n\n- Evidence.",
    workCandidate: "none",
    workConfidence: "low",
    workPriority: "low",
    workReason: "Close decisions do not need a fix PR.",
    workPrompt: "",
    workClusterRefs: [],
    workValidation: [],
    workLikelyFiles: [],
    ...overrides,
  };
}

function reviewFinding(overrides = {}) {
  return {
    title: "Missing changelog entry",
    body: "This user-facing fix needs a CHANGELOG.md entry.",
    priority: 3,
    confidenceScore: 0.9,
    file: "src/runtime.ts",
    lineStart: 12,
    lineEnd: 12,
    ...overrides,
  };
}

function changelogReviewDecision(overrides = {}) {
  return closeDecision({
    decision: "keep_open",
    closeReason: "none",
    confidence: "high",
    bestSolution: "Add the required changelog entry before merge.",
    reviewFindings: [reviewFinding({ title: "Add the required changelog entry" })],
    overallCorrectness: "patch is incorrect",
    workCandidate: "queue_fix_pr",
    workConfidence: "high",
    workPriority: "medium",
    workReason: "Add the required changelog entry.",
    workPrompt: "Add a CHANGELOG.md entry.",
    workLikelyFiles: ["CHANGELOG.md"],
    ...overrides,
  });
}

test("githubPaginatedPath requests maximum REST page size by default", () => {
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues/123/comments"),
    "repos/openclaw/openclaw/issues/123/comments?per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?state=open&sort=created"),
    "repos/openclaw/openclaw/issues?state=open&sort=created&per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?per_page=50&state=open"),
    "repos/openclaw/openclaw/issues?per_page=50&state=open",
  );
});

test("compactMappedSlice maps only retained prompt entries", () => {
  const mapped: number[] = [];
  const result = compactMappedSlice([1, 2, 3, 4, 5, 6], 4, (value) => {
    mapped.push(value);
    return value * 10;
  });
  assert.deepEqual(result, [
    10,
    20,
    { omitted: 2, note: "middle entries omitted from prompt context" },
    50,
    60,
  ]);
  assert.deepEqual(mapped, [1, 2, 5, 6]);
});

test("compactMappedSlice maps every entry when no compaction is needed", () => {
  const mapped: number[] = [];
  const result = compactMappedSlice([1, 2, 3], 3, (value) => {
    mapped.push(value);
    return value * 10;
  });
  assert.deepEqual(result, [10, 20, 30]);
  assert.deepEqual(mapped, [1, 2, 3]);
});

test("compactMappedWindow marks omitted entries when hydration is already bounded", () => {
  const mapped: number[] = [];
  const result = compactMappedWindow([1, 2, 5, 6], 6, 4, (value) => {
    mapped.push(value);
    return value * 10;
  });
  assert.deepEqual(result, [
    10,
    20,
    { omitted: 2, note: "middle entries omitted from prompt context" },
    50,
    60,
  ]);
  assert.deepEqual(mapped, [1, 2, 5, 6]);
});

test("compactMappedWindow keeps bounded hydrated context when total is larger than limit", () => {
  const mapped: number[] = [];
  const result = compactMappedWindow([1, 2, 99, 100], 100, 4, (value) => {
    mapped.push(value);
    return value;
  });
  assert.deepEqual(result, [
    1,
    2,
    { omitted: 96, note: "middle entries omitted from prompt context" },
    99,
    100,
  ]);
  assert.deepEqual(mapped, [1, 2, 99, 100]);
});

test("githubContextWindowPlan includes prior page when the tail crosses a page boundary", () => {
  assert.deepEqual(githubContextWindowPlan(101, 80), {
    keepStart: 40,
    keepEnd: 40,
    tailFirstPageNumber: 1,
    lastPageNumber: 2,
    tailOffset: 61,
  });
});

test("githubContextWindowPlan keeps large tails to the final page when possible", () => {
  assert.deepEqual(githubContextWindowPlan(3000, 80), {
    keepStart: 40,
    keepEnd: 40,
    tailFirstPageNumber: 30,
    lastPageNumber: 30,
    tailOffset: 60,
  });
});

test("ghPagedContextWindow reuses first page when tail overlaps the head page", () => {
  const fetchedPages: number[] = [];
  const window = ghPagedContextWindow<number>(
    "repos/openclaw/openclaw/issues/123/comments",
    101,
    80,
    {
      page: (_path, page) => {
        fetchedPages.push(page);
        const start = (page - 1) * 100 + 1;
        const end = Math.min(page * 100, 101);
        return Array.from({ length: end - start + 1 }, (_, index) => start + index);
      },
    },
  );

  assert.deepEqual(fetchedPages, [1, 2]);
  assert.deepEqual(window.items, [
    ...Array.from({ length: 40 }, (_, index) => index + 1),
    ...Array.from({ length: 40 }, (_, index) => index + 62),
  ]);
  assert.equal(window.total, 101);
  assert.equal(window.hydrated, 80);
  assert.equal(window.truncated, true);
});

test("ghPagedContextWindow falls back to full pagination when total is missing", () => {
  const window = ghPagedContextWindow<number>(
    "repos/openclaw/openclaw/pulls/123/files",
    undefined,
    80,
    {
      paged: () => [1, 2, 3],
      page: () => {
        throw new Error("page fetch should not be used without a total count");
      },
    },
  );

  assert.deepEqual(window, {
    items: [1, 2, 3],
    total: 3,
    hydrated: 3,
    truncated: false,
  });
});

test("review prompt assets match tracked files", () => {
  assert.equal(reviewPromptTemplate(), readFileSync("prompts/review-item.md", "utf8"));
  assert.deepEqual(
    JSON.parse(reviewDecisionSchemaText()),
    JSON.parse(readFileSync("schema/clawsweeper-decision.schema.json", "utf8")),
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

const git = {
  mainSha: "abcdef1234567890",
  latestRelease: null,
};

function reportFrontMatter(overrides = {}) {
  const values = {
    repository: "openclaw/openclaw",
    type: "issue",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    action_taken: "kept_open",
    ...overrides,
  };
  return `---
${Object.entries(values)
  .map(([key, value]) => `${key}: ${value}`)
  .join("\n")}
---
`;
}

function realBehaviorProofReportSection(overrides = {}) {
  const values = {
    status: "sufficient",
    evidenceKind: "terminal",
    needsContributorAction: false,
    summary:
      "The PR includes a terminal transcript from a real OpenClaw setup showing the fixed behavior after the patch.",
    ...overrides,
  };
  return `## Real Behavior Proof

Status: ${values.status}

Evidence kind: ${values.evidenceKind}

Needs contributor action: ${values.needsContributorAction}

Summary: ${values.summary}
`;
}

function auditRecord(number, overrides = {}) {
  return {
    repo: "openclaw/openclaw",
    number,
    location: "items",
    path: `items/${number}.md`,
    kind: "issue",
    title: `Item ${number}`,
    labels: [],
    decision: "keep_open",
    closeReason: "none",
    action: "kept_open",
    reviewStatus: "complete",
    currentState: undefined,
    ...overrides,
  };
}

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

test("protected labels are normalized and excluded from normal planning", () => {
  assert.deepEqual(protectedLabels(["Security", "bug", "maintainer", "SECURITY"]), [
    "security",
    "maintainer",
  ]);
  assert.equal(isProtectedItem(item({ labels: ["release-blocker"] })), true);
  assert.equal(shouldPlanItem(item({ labels: ["beta-blocker"] })), false);
  assert.equal(shouldPlanItem(item({ labels: ["bug"] })), true);
});

test("parseGhJson adds gh command context to malformed JSON errors", () => {
  assert.throws(
    () => parseGhJson("{", ["api", "repos/openclaw/openclaw/issues"]),
    /Failed to parse JSON from gh api repos\/openclaw\/openclaw\/issues:/,
  );
});

test("parseGhJsonLines adds line number and command context to malformed JSONL errors", () => {
  assert.throws(
    () => parseGhJsonLines('{"ok":true}\nnot-json\n', ["issue", "list", "--json", "number"]),
    /Failed to parse JSON line 2 from gh issue list --json:/,
  );
});

test("commit review reports use one canonical path per commit", () => {
  const sha = "abcdef1234567890abcdef1234567890abcdef12";
  assert.equal(
    commitReportRelativePath("openclaw/openclaw", sha),
    "records/openclaw-openclaw/commits/abcdef1234567890abcdef1234567890abcdef12.md",
  );
});

test("commit review parses co-authored-by trailers", () => {
  assert.deepEqual(
    parseCoAuthors(`subject

Body text.

Co-authored-by: Alice Example <alice@example.com>
Co-authored-by: Bob Example <bob@example.com>
co-authored-by: Alice Example <alice@example.com>
`),
    ["Alice Example", "Bob Example"],
  );
});

test("commit report since parser accepts compact and natural windows", () => {
  const now = new Date("2026-04-29T12:00:00.000Z");
  assert.equal(parseCommitReportSince("6h", now).toISOString(), "2026-04-29T06:00:00.000Z");
  assert.equal(
    parseCommitReportSince("24 hours ago", now).toISOString(),
    "2026-04-28T12:00:00.000Z",
  );
  assert.equal(parseCommitReportSince("last 7d", now).toISOString(), "2026-04-22T12:00:00.000Z");
});

test("skipped non-code commit reports include commit timestamps for listing", () => {
  const report = skippedNonCodeReport({
    targetRepo: "openclaw/openclaw",
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    metadata: {
      parents: ["0123456789abcdef0123456789abcdef01234567"],
      authorName: "Alice",
      authorEmail: "alice@example.com",
      committerName: "Bob",
      committerEmail: "bob@example.com",
      authoredAt: "2026-04-29T10:00:00Z",
      committedAt: "2026-04-29T10:05:00Z",
      coAuthors: [],
      githubAuthor: "alice",
      githubCommitter: "bob",
    },
    changedFiles: ["docs/usage.md"],
  });
  assert.match(report, /commit_authored_at: "2026-04-29T10:00:00Z"/);
  assert.match(report, /commit_committed_at: "2026-04-29T10:05:00Z"/);
});

test("commit review cheaply skips documentation-only paths", () => {
  assert.equal(isReviewableCommitPath("docs/usage.md"), false);
  assert.equal(isReviewableCommitPath("CHANGELOG.md"), false);
  assert.equal(isReviewableCommitPath("README.md"), false);
  assert.equal(isReviewableCommitPath("assets/logo.png"), false);
  assert.equal(isReviewableCommitPath("test/clawsweeper.test.ts"), true);
  assert.equal(isReviewableCommitPath("src/clawsweeper.ts"), true);
  assert.equal(isReviewableCommitPath(".github/workflows/sweep.yml"), true);
  assert.equal(isReviewableCommitPath("package.json"), true);
});

test("skipped non-code commit reports still publish green checks", () => {
  assert.equal(
    checkConclusionForFrontMatter({ result: "skipped_non_code", highest_severity: "none" }),
    "success",
  );
});

test("commit review check conclusions stay conservative", () => {
  assert.equal(
    checkConclusionForFrontMatter({ result: "nothing_found", highest_severity: "none" }),
    "success",
  );
  assert.equal(
    checkConclusionForFrontMatter({ result: "findings", highest_severity: "high" }),
    "failure",
  );
  assert.equal(
    checkConclusionForFrontMatter({ result: "findings", highest_severity: "medium" }),
    "neutral",
  );
  assert.equal(checkConclusionForFrontMatter({ result: "inconclusive" }), "neutral");
});

test("protected labels block close proposals even for otherwise valid decisions", () => {
  const validation = validateCloseDecision(item({ labels: ["security"] }), closeDecision());
  assert.equal(validation.ok, false);
  assert.equal(validation.actionTaken, "skipped_protected_label");

  const action = reviewActionForDecision({
    item: item({ labels: ["security"] }),
    decision: closeDecision(),
    git,
  });
  assert.equal(action.actionTaken, "skipped_protected_label");
  assert.equal(action.closeComment, "");
});

test("review actions only propose valid closes and never apply directly", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision(),
    git,
    runtime: { model: "gpt-5.5", reasoningEffort: "high" },
  });
  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /Thanks for the context here/);
  assert.match(action.closeComment, /shell check/);
  assert.match(action.closeComment, /already implemented/);
  assert.match(action.closeComment, /<details>\n<summary>Review details<\/summary>/);
  assert.match(
    action.closeComment,
    /Do we have a high-confidence way to reproduce the issue\?\n\nYes\. Current main can be checked/,
  );
  assert.match(
    action.closeComment,
    /Is this the best way to solve the issue\?\n\nYes\. Keeping the implementation as-is/,
  );
  assert.ok(
    action.closeComment.indexOf("Is this the best way to solve the issue?") <
      action.closeComment.indexOf("What I checked:"),
  );
  assert.match(action.closeComment, /Likely related people:/);
  assert.match(action.closeComment, /@alice/);
  assert.match(action.closeComment, /@bob/);
  assert.match(action.closeComment, /Codex review notes: model gpt-5\.5, reasoning high;/);
});

test("close comments reference high-confidence merged fixing PRs", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      fixedPullRequest: {
        repo: "openclaw/openclaw",
        number: 456,
        url: "https://github.com/openclaw/openclaw/pull/456",
        title: "fix: wire the shell check",
        mergedAt: "2026-04-28T12:00:00Z",
        sha: "fedcba9876543210",
        confidence: "high",
        source: "GitHub closing PR reference",
      },
    }),
    git,
    runtime: { model: "gpt-5.5", reasoningEffort: "high" },
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /merged PR that appears to have closed this: \[#456: fix: wire the shell check\]\(https:\/\/github\.com\/openclaw\/openclaw\/pull\/456\)/,
  );
  assert.match(
    action.closeComment,
    /fix evidence: merged PR \[#456\]\(https:\/\/github\.com\/openclaw\/openclaw\/pull\/456\), commit/,
  );
});

test("commit PR lookup selects the newest merged pull request", () => {
  const fixedPullRequest = fixedPullRequestFromCommitPullsForTest([
    {
      number: 455,
      html_url: "https://github.com/openclaw/openclaw/pull/455",
      title: "fix: older candidate",
      merged: true,
      merged_at: "2026-04-27T12:00:00Z",
      merge_commit_sha: "1111111111111111",
    },
    {
      number: 456,
      html_url: "https://github.com/openclaw/openclaw/pull/456",
      title: "fix: wire the shell check",
      merged_at: "2026-04-28T12:00:00Z",
      merge_commit_sha: "fedcba9876543210",
    },
    {
      number: 457,
      html_url: "https://github.com/openclaw/openclaw/pull/457",
      title: "open follow-up",
      merged: false,
    },
  ]);

  assert.deepEqual(fixedPullRequest, {
    repo: "openclaw/openclaw",
    number: 456,
    url: "https://github.com/openclaw/openclaw/pull/456",
    title: "fix: wire the shell check",
    mergedAt: "2026-04-28T12:00:00Z",
    sha: "fedcba9876543210",
    confidence: "high",
    source: "GitHub commit PR lookup",
  });
});

test("report-rendered close comments keep merged fixing PR provenance", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "issue",
      number: "123",
      title: JSON.stringify("Sample item"),
      decision: "close",
      close_reason: "implemented_on_main",
      action_taken: "proposed_close",
      fixed_pr_url: "https://github.com/openclaw/openclaw/pull/456",
      fixed_pr_number: "456",
      fixed_pr_title: JSON.stringify("fix: wire the shell check"),
      fixed_pr_merged_at: "2026-04-28T12:00:00Z",
      fixed_pr_sha: "fedcba9876543210",
      fixed_pr_confidence: "high",
      fixed_pr_source: JSON.stringify("GitHub closing PR reference"),
      fixed_sha: "abcdef1234567890",
      fixed_at: "2026-04-28T12:00:00Z",
      main_sha: "abcdef1234567890",
      review_model: "gpt-5.5",
      review_reasoning_effort: "high",
    })}

## Summary

Current main already implements this.

## Best Possible Solution

Keep the implementation as-is.

## Reproduction Assessment

Yes. Current main can be checked by inspecting source and history.

## Solution Assessment

Yes. Keeping the implementation as-is is the narrowest maintainable outcome.

## Evidence

- **implementation:** The feature is present in source.
  - file: [src/example.ts:12](https://github.com/openclaw/openclaw/blob/abcdef1234567890/src/example.ts#L12)
  - sha: [abcdef1234567890](https://github.com/openclaw/openclaw/commit/abcdef1234567890)

## Likely Owners

- **@alice:** introduced behavior
  - reason: git blame points at the fix.
  - confidence: high
  - commits: abcdef1234567890
  - files: src/example.ts
`,
    "implemented_on_main",
  );

  assert.match(
    comment,
    /merged PR that appears to have closed this: \[#456: fix: wire the shell check\]\(https:\/\/github\.com\/openclaw\/openclaw\/pull\/456\)/,
  );
  assert.match(comment, /fix evidence: merged PR \[#456\]/);
});

test("close comments suppress duplicate best solution text", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      summary: "Keep the implementation as-is.",
      bestSolution: "Keep the implementation as-is.",
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.doesNotMatch(action.closeComment, /Best possible solution:/);
});

test("likely owner commit links ignore non-sha values", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      likelyOwners: [
        {
          person: "@alice",
          role: "feature contributor",
          reason: "The changelog credits a pull request for this feature surface.",
          commits: ["https://github.com/openclaw/openclaw/pull/76079", " abcdef1234567890 "],
          files: ["CHANGELOG.md"],
          confidence: "medium",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.doesNotMatch(action.closeComment, /\/commit\/https:/);
  assert.match(
    action.closeComment,
    /\[abcdef123456\]\(https:\/\/github\.com\/openclaw\/openclaw\/commit\/abcdef1234567890\)/,
  );
});

test("skill-only OpenClaw PRs can close through ClawHub with upload guidance", () => {
  const decision = closeDecision({
    closeReason: "clawhub",
    summary:
      "The branch adds an optional bundled skill and does not change required core behavior.",
    changeSummary: "Adds bundled Higgsfield skill files under skills/higgsfield.",
    bestSolution:
      "Publish the skill through ClawHub so it stays installable outside OpenClaw core.",
    itemCategory: "skill",
    reproductionStatus: "not_applicable",
    reproductionConfidence: "high",
    securityReview: {
      status: "cleared",
      summary:
        "The PR is a skill-only content addition and should move to the community skill path.",
      concerns: [],
    },
    realBehaviorProof: {
      status: "not_applicable",
      summary: "Real behavior proof is not needed for a scope-fit close.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    },
  });
  const pr = item({
    kind: "pull_request",
    url: "https://github.com/openclaw/openclaw/pull/78018",
  });

  assert.equal(validateCloseDecision(pr, decision).ok, true);

  const action = reviewActionForDecision({
    item: pr,
    decision,
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /ClawHub\.com/);
  assert.match(action.closeComment, /upload or publish/i);
  assert.match(action.closeComment, /installable community skill/);
});

test("ClawHub policy only allows implemented-on-main PR close proposals", () => {
  const implementedPr = validateCloseDecision(
    item({
      repo: "openclaw/clawhub",
      kind: "pull_request",
      url: "https://github.com/openclaw/clawhub/pull/123",
    }),
    closeDecision(),
  );
  assert.equal(implementedPr.ok, true);

  const implementedIssue = validateCloseDecision(
    item({
      repo: "openclaw/clawhub",
      kind: "issue",
      url: "https://github.com/openclaw/clawhub/issues/123",
    }),
    closeDecision(),
  );
  assert.equal(implementedIssue.ok, false);
  assert.equal(implementedIssue.actionTaken, "skipped_invalid_decision");

  const nonImplementedPr = validateCloseDecision(
    item({
      repo: "openclaw/clawhub",
      kind: "pull_request",
      url: "https://github.com/openclaw/clawhub/pull/123",
    }),
    closeDecision({ closeReason: "cannot_reproduce" }),
  );
  assert.equal(nonImplementedPr.ok, false);
  assert.equal(nonImplementedPr.actionTaken, "skipped_invalid_decision");
});

test("ClawSweeper policy allows self PR review without issue auto-close", () => {
  const implementedPr = validateCloseDecision(
    item({
      repo: "openclaw/clawsweeper",
      kind: "pull_request",
      url: "https://github.com/openclaw/clawsweeper/pull/17",
    }),
    closeDecision(),
  );
  assert.equal(implementedPr.ok, true);

  const implementedIssue = validateCloseDecision(
    item({
      repo: "openclaw/clawsweeper",
      kind: "issue",
      url: "https://github.com/openclaw/clawsweeper/issues/17",
    }),
    closeDecision(),
  );
  assert.equal(implementedIssue.ok, false);
  assert.equal(implementedIssue.actionTaken, "skipped_invalid_decision");
});

test("review policy changes force fresh complete reports back into planning", () => {
  const reviewedAt = new Date().toISOString();
  const review = {
    path: "items/123.md",
    markdown: "",
    reviewedAt,
    itemUpdatedAt: "2026-01-01T00:00:00Z",
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "old-policy",
  };
  const now = Date.parse(reviewedAt) + 60_000;

  assert.equal(shouldReviewItem(item(), review, now, "new-policy"), true);
  assert.equal(shouldReviewItem(item(), review, now, "old-policy"), false);
});

test("hot new items review hourly before falling back to daily or weekly cadence", () => {
  const now = Date.parse("2026-04-26T12:00:00Z");
  const review = (reviewedAt, itemUpdatedAt) => ({
    path: "items/123.md",
    markdown: "",
    reviewedAt,
    itemUpdatedAt,
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "current",
  });

  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-04-24T00:00:00Z",
        updatedAt: "2026-04-24T00:00:00Z",
      }),
      review("2026-04-26T10:00:00Z", "2026-04-24T00:00:00Z"),
      now,
      "current",
    ),
    true,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-04-24T00:00:00Z",
        updatedAt: "2026-04-24T00:00:00Z",
      }),
      review("2026-04-26T11:45:00Z", "2026-04-24T00:00:00Z"),
      now,
      "current",
    ),
    false,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      review("2026-04-24T12:00:00Z", "2026-03-01T00:00:00Z"),
      now,
      "current",
    ),
    false,
  );
  assert.equal(
    shouldReviewItem(
      item({
        kind: "pull_request",
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      review("2026-04-25T10:00:00Z", "2026-03-01T00:00:00Z"),
      now,
      "current",
    ),
    true,
  );
});

test("scheduler ignores ClawSweeper-owned updated_at churn after review", () => {
  const reviewedAt = "2026-04-30T12:52:57Z";
  const review = {
    path: "items/123.md",
    markdown: "",
    reviewedAt,
    itemUpdatedAt: "2026-04-30T11:17:05Z",
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "current",
  };
  const now = Date.parse("2026-04-30T14:10:00Z");

  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-03-01T11:12:04Z",
        updatedAt: "2026-04-30T12:52:56Z",
      }),
      review,
      now,
      "current",
    ),
    false,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-03-01T11:12:04Z",
        updatedAt: "2026-04-30T13:05:00Z",
      }),
      { ...review, reviewCommentSyncedAt: "2026-04-30T13:04:59Z" },
      now,
      "current",
    ),
    true,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-03-01T11:12:04Z",
        updatedAt: "2026-04-30T13:04:58Z",
      }),
      { ...review, reviewCommentSyncedAt: "2026-04-30T13:04:59Z" },
      now,
      "current",
    ),
    false,
  );
});

test("hot new item priority is protected from older activity churn", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  const review = (reviewedAt, itemUpdatedAt) => ({
    path: "items/123.md",
    markdown: "",
    reviewedAt,
    itemUpdatedAt,
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "current",
  });

  const hotIssue = item({
    createdAt: "2026-04-28T13:38:22Z",
    updatedAt: "2026-04-29T05:46:35Z",
  });
  const olderActiveIssue = item({
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-04-30T11:00:00Z",
  });

  assert.equal(
    reviewPriority(
      hotIssue,
      review("2026-04-29T07:24:53Z", "2026-04-29T05:46:35Z"),
      now,
      "current",
    ) <
      reviewPriority(
        olderActiveIssue,
        review("2026-04-30T10:00:00Z", "2026-04-29T00:00:00Z"),
        now,
        "current",
      ),
    true,
  );
});

test("hot issue priority is protected from hot PR backlog", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  const review = {
    path: "items/123.md",
    markdown: "",
    reviewedAt: "2026-04-29T07:24:53Z",
    itemUpdatedAt: "2026-04-29T05:46:35Z",
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "current",
  };

  assert.equal(
    reviewPriority(
      item({
        kind: "issue",
        createdAt: "2026-04-28T13:38:22Z",
        updatedAt: "2026-04-29T05:46:35Z",
      }),
      review,
      now,
      "current",
    ) <
      reviewPriority(
        item({
          kind: "pull_request",
          createdAt: "2026-04-28T13:38:22Z",
          updatedAt: "2026-04-29T05:46:35Z",
        }),
        review,
        now,
        "current",
      ),
    true,
  );
});

test("hot issue priority is protected from policy mismatch backlog", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  const review = (reviewPolicy) => ({
    path: "items/123.md",
    markdown: "",
    reviewedAt: "2026-04-29T07:24:53Z",
    itemUpdatedAt: "2026-04-29T05:46:35Z",
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy,
  });

  assert.equal(
    reviewPriority(
      item({
        kind: "issue",
        createdAt: "2026-04-28T13:38:22Z",
        updatedAt: "2026-04-29T05:46:35Z",
      }),
      review("old-policy"),
      now,
      "current",
    ) <
      reviewPriority(
        item({
          kind: "issue",
          createdAt: "2026-03-01T00:00:00Z",
          updatedAt: "2026-03-01T00:00:00Z",
        }),
        review("old-policy"),
        now,
        "current",
      ),
    true,
  );
});

test("normal scheduler reserves throughput for PR and older buckets", () => {
  const due = [];
  for (let number = 1; number <= 12; number += 1) {
    due.push({
      item: item({ number, kind: "issue", createdAt: "2026-04-30T00:00:00Z" }),
      bucket: "hot_issue",
      priority: 0,
      nextDueAt: number,
    });
  }
  due.push(
    {
      item: item({
        number: 101,
        kind: "pull_request",
        createdAt: "2026-04-30T00:00:00Z",
      }),
      bucket: "hot_pull_request",
      priority: 1,
      nextDueAt: 1,
    },
    {
      item: item({
        number: 201,
        kind: "pull_request",
        createdAt: "2026-03-01T00:00:00Z",
      }),
      bucket: "daily_pull_request",
      priority: 3,
      nextDueAt: 1,
    },
    {
      item: item({ number: 301, kind: "issue", createdAt: "2026-03-01T00:00:00Z" }),
      bucket: "weekly_issue",
      priority: 6,
      nextDueAt: 1,
    },
  );

  assert.deepEqual(selectDueCandidateNumbersForTest(due, 8), [1, 2, 3, 4, 101, 201, 301, 5]);
});

test("normal scheduler can fill active floor from stale current reviews", () => {
  const selected = [
    {
      item: item({ number: 1, kind: "issue", createdAt: "2026-04-30T00:00:00Z" }),
      bucket: "hot_issue",
      priority: 0,
      nextDueAt: 1,
    },
  ];
  const backfill = [
    {
      item: item({ number: 10, kind: "pull_request", createdAt: "2026-03-01T00:00:00Z" }),
      bucket: "daily_pull_request",
      priority: 3,
      reviewedAt: 100,
      nextDueAt: 1000,
    },
    {
      item: item({ number: 11, kind: "issue", createdAt: "2026-03-01T00:00:00Z" }),
      bucket: "weekly_issue",
      priority: 6,
      reviewedAt: 50,
      nextDueAt: 2000,
    },
    {
      item: item({ number: 1, kind: "issue", createdAt: "2026-04-30T00:00:00Z" }),
      bucket: "hot_issue",
      priority: 0,
      reviewedAt: 25,
      nextDueAt: 3000,
    },
  ];

  assert.deepEqual(
    appendFloorBackfillCandidateNumbersForTest(selected, backfill, 3, 10),
    [1, 10, 11],
  );
  assert.deepEqual(appendFloorBackfillCandidateNumbersForTest(selected, backfill, 3, 2), [1, 10]);
});

test("normal scheduler can stop scanning once planned capacity is saturated", () => {
  assert.equal(shouldStopSaturatedPlanScan({ dueCount: 99, capacity: 100 }), false);
  assert.equal(shouldStopSaturatedPlanScan({ dueCount: 100, capacity: 100 }), true);
  assert.equal(shouldStopSaturatedPlanScan({ dueCount: 150, capacity: 100 }), true);
  assert.equal(shouldStopSaturatedPlanScan({ dueCount: 1, capacity: 0 }), false);
});

test("hot intake recency prefers newly updated or created issues", () => {
  assert.equal(
    hotIntakeRecencyMs(
      item({
        createdAt: "2026-04-29T21:28:12Z",
        updatedAt: "2026-04-29T21:28:12Z",
      }),
    ) >
      hotIntakeRecencyMs(
        item({
          createdAt: "2026-04-27T02:40:44Z",
          updatedAt: "2026-04-27T02:40:44Z",
        }),
      ),
    true,
  );
  assert.equal(
    hotIntakeRecencyMs(
      item({
        createdAt: "2026-04-27T02:40:44Z",
        updatedAt: "2026-04-29T22:30:00Z",
      }),
    ),
    Date.parse("2026-04-29T22:30:00Z"),
  );
});

test("invalid close semantics are rejected", () => {
  const mediumClose = reviewActionForDecision({
    item: item(),
    decision: closeDecision({ confidence: "medium" }),
    git,
  });
  assert.equal(mediumClose.actionTaken, "skipped_invalid_decision");

  const stalePr = validateCloseDecision(
    item({ kind: "pull_request" }),
    closeDecision({ closeReason: "stale_insufficient_info" }),
  );
  assert.equal(stalePr.ok, false);
  assert.equal(stalePr.actionTaken, "skipped_invalid_decision");

  const missingEvidence = validateCloseDecision(item(), closeDecision({ evidence: [] }));
  assert.equal(missingEvidence.ok, false);
  assert.equal(missingEvidence.actionTaken, "skipped_invalid_decision");

  const missingSource = validateCloseDecision(
    item(),
    closeDecision({
      evidence: [
        {
          label: "claim",
          detail: "Looks implemented.",
          file: null,
          line: null,
          command: "rg feature",
          sha: null,
        },
      ],
    }),
  );
  assert.equal(missingSource.ok, false);
  assert.equal(missingSource.actionTaken, "skipped_invalid_decision");
});

test("implemented-on-main closes require fix provenance", () => {
  const missingFixedSha = validateCloseDecision(
    item(),
    closeDecision({
      fixedSha: null,
    }),
  );
  assert.equal(missingFixedSha.ok, false);
  assert.equal(missingFixedSha.reason, "implemented_on_main requires fixedSha");

  const invalidFixedAt = validateCloseDecision(
    item(),
    closeDecision({
      fixedAt: "recently",
    }),
  );
  assert.equal(invalidFixedAt.ok, false);
  assert.equal(invalidFixedAt.reason, "implemented_on_main fixedAt must be an ISO timestamp");

  const dateOnlyFixedAt = validateCloseDecision(
    item(),
    closeDecision({
      fixedAt: "2026-04-28",
    }),
  );
  assert.equal(dateOnlyFixedAt.ok, false);
  assert.equal(dateOnlyFixedAt.reason, "implemented_on_main fixedAt must be an ISO timestamp");

  const missingReleaseOrTimestamp = validateCloseDecision(
    item(),
    closeDecision({
      fixedRelease: null,
      fixedAt: null,
    }),
  );
  assert.equal(missingReleaseOrTimestamp.ok, false);
  assert.equal(
    missingReleaseOrTimestamp.reason,
    "implemented_on_main requires fixedRelease or fixedAt",
  );

  const missingProvenanceEvidence = validateCloseDecision(
    item(),
    closeDecision({
      evidence: [
        {
          label: "implementation",
          detail: "The feature is present in source.",
          file: "src/example.ts",
          line: 12,
          command: null,
          sha: "abcdef1234567890",
        },
      ],
    }),
  );
  assert.equal(missingProvenanceEvidence.ok, false);
  assert.equal(
    missingProvenanceEvidence.reason,
    "implemented_on_main requires git history provenance evidence",
  );

  const missingReleaseStateEvidence = validateCloseDecision(
    item(),
    closeDecision({
      evidence: [
        {
          label: "implementation",
          detail: "The feature is present in source.",
          file: "src/example.ts",
          line: 12,
          command: null,
          sha: "abcdef1234567890",
        },
        {
          label: "git history provenance",
          detail: "git blame traced this line to the fixed commit.",
          file: "src/example.ts",
          line: 12,
          command: "git blame -L 12,12 -- src/example.ts",
          sha: "abcdef1234567890",
        },
      ],
    }),
  );
  assert.equal(missingReleaseStateEvidence.ok, false);
  assert.equal(
    missingReleaseStateEvidence.reason,
    "implemented_on_main requires release or main-only provenance evidence",
  );

  const blameAndMainTimestamp = validateCloseDecision(
    item(),
    closeDecision({
      fixedRelease: null,
      fixedAt: "2026-04-28T12:00:00Z",
      evidence: [
        {
          label: "implementation",
          detail: "The feature is present in source.",
          file: "src/example.ts",
          line: 12,
          command: null,
          sha: "abcdef1234567890",
        },
        {
          label: "git history provenance",
          detail: "git blame traced this line to the fixed commit.",
          file: "src/example.ts",
          line: 12,
          command: "git blame -L 12,12 -- src/example.ts",
          sha: "abcdef1234567890",
        },
        {
          label: "main-only release provenance",
          detail: "No shipped release tag contains the fix; current main includes it.",
          file: null,
          line: null,
          command: "git tag --contains abcdef1234567890",
          sha: "abcdef1234567890",
        },
      ],
    }),
  );
  assert.equal(blameAndMainTimestamp.ok, true);
});

test("duplicate or superseded closes are allowed with evidence and comment", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      evidence: [
        {
          label: "canonical issue",
          detail: "Issue #456 tracks the same remaining work.",
          file: null,
          line: null,
          command: "provided GitHub related item context",
          sha: null,
        },
      ],
      closeComment:
        "Closing this as duplicate or superseded after Codex review.\n\n- Canonical issue: #456 tracks the same remaining work.",
    }),
    git,
  });
  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /duplicate or superseded/);
  assert.match(action.closeComment, /swept through the related work/);
});

test("apply close reason filters support exact fast-close lanes", () => {
  assert.equal(closeReasonsArg("all"), null);
  assert.deepEqual([...closeReasonsArg("implemented_on_main, duplicate_or_superseded")].sort(), [
    "duplicate_or_superseded",
    "implemented_on_main",
  ]);
  assert.throws(() => closeReasonsArg("stale"), /Invalid apply close reason: stale/);
});

test("stale insufficient-info closes require older items while implemented closes can be immediate", () => {
  const now = Date.parse("2026-04-28T12:00:00Z");
  const freshItem = item({ createdAt: "2026-04-28T11:59:00Z" });

  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "implemented_on_main", {
      minAgeMs: 0,
      minAgeDescription: "0 minutes",
      staleMinAgeDays: 30,
      now,
    }),
    null,
  );
  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "duplicate_or_superseded", {
      minAgeMs: 5 * 60 * 1000,
      minAgeDescription: "5 minutes",
      staleMinAgeDays: 30,
      now,
    }),
    "created less than or equal to 5 minutes ago",
  );
  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "stale_insufficient_info", {
      minAgeMs: 0,
      minAgeDescription: "0 minutes",
      staleMinAgeDays: 30,
      now,
    }),
    "stale_insufficient_info requires item older than 30 days",
  );
});

test("open PRs that close an issue block apply closes", () => {
  assert.equal(
    openClosingPullRequestApplyReason([
      { number: 69425, state: "open", title: "daemon: honor OPENCLAW_WRAPPER" },
    ]),
    "open PR #69425 (daemon: honor OPENCLAW_WRAPPER) is a closing reference",
  );
  assert.equal(
    openClosingPullRequestApplyReason([{ number: 69425, state: "closed", title: "done" }]),
    null,
  );
});

test("same-author open issue and PR pairs block one-sided apply closes", () => {
  assert.equal(
    sameAuthorCounterpartApplyReason(item({ number: 42, author: "alice" }), [
      {
        issue: {
          number: 43,
          title: "Fix the same bug",
          state: "open",
          author: "alice",
        },
        pullRequest: {
          number: 43,
          title: "Fix the same bug",
          state: "open",
          author: "alice",
        },
      },
    ]),
    "open PR #43 (Fix the same bug) by the same author is paired with this issue",
  );
  assert.equal(
    sameAuthorCounterpartApplyReason(item({ number: 42, kind: "pull_request", author: "alice" }), [
      {
        localReport: {
          number: 41,
          kind: "issue",
          title: "Fix the same bug",
          author: "Alice",
          location: "items",
        },
      },
    ]),
    "open issue #41 (Fix the same bug) by the same author is paired with this PR",
  );
  assert.equal(
    sameAuthorCounterpartApplyReason(item({ number: 42, author: "alice" }), [
      { issue: { number: 43, title: "Different author", state: "open", author: "bob" } },
    ]),
    null,
  );
});

test("not-actionable-in-repo closes are allowed with evidence and comment", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "not_actionable_in_repo",
      evidence: [
        {
          label: "external administration",
          detail: "The request is for GitHub project settings, not OpenClaw source code.",
          file: null,
          line: null,
          command: "provided GitHub issue context",
          sha: null,
        },
      ],
      closeComment:
        "Closing this as not actionable in this repository after Codex review.\n\n- External administration: GitHub project settings are outside OpenClaw source code.",
    }),
    git,
  });
  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /Thanks for writing this up/);
  assert.match(action.closeComment, /outside the OpenClaw source shell/);
});

test("close reason labels keep incoherent distinct from not actionable in repo", () => {
  const rows = formatRecentClosedRows([
    {
      repo: "openclaw/openclaw",
      number: 1,
      kind: "issue",
      title: "Unclear report",
      closeReason: "incoherent",
      appliedAt: "2026-04-26T20:00:00.000Z",
      reportPath: "records/openclaw-openclaw/closed/1.md",
    },
    {
      repo: "openclaw/openclaw",
      number: 2,
      kind: "issue",
      title: "Repository settings request",
      closeReason: "not_actionable_in_repo",
      appliedAt: "2026-04-26T20:01:00.000Z",
      reportPath: "records/openclaw-openclaw/closed/2.md",
    },
  ]);

  assert.match(rows, /too unclear to act on/);
  assert.match(rows, /not actionable in this repository/);
  assert.doesNotMatch(rows, /\|\s*not actionable\s*\|/);
});

test("public comments avoid self-referencing the current item number", () => {
  const comment = sanitizePublicSelfReferences(
    "Issue #69400 is tracked by PR #69425, which says Fixes #69400. Close #69400 later.",
    69400,
    "issue",
  );

  assert.equal(
    comment,
    "This issue is tracked by PR #69425, which says Fixes this issue. Close this issue later.",
  );
});

test("comment matcher recognizes old and new Codex review comments", () => {
  assert.equal(
    isCodexReviewCommentBody(
      "Closing this as implemented after Codex review.\n\nCodex Review notes: reviewed against abc.",
    ),
    true,
  );
  assert.equal(
    isCodexReviewCommentBody(
      "Codex automated review: keeping this open.\n\nBest possible solution:\n\nShip it.",
    ),
    true,
  );
  assert.equal(
    isCodexReviewCommentBody(
      "Codex review: keeping this open for maintainer follow-up; there is still a little grit to resolve.\n\nBest possible solution:\n\nShip it.",
    ),
    true,
  );
  assert.equal(
    isCodexReviewCommentBody(
      "Codex review: needs maintainer review before merge.\n\nMaintainer follow-up before merge:\n\nShip it.",
    ),
    true,
  );
  assert.equal(isCodexReviewCommentBody("Thanks for the report, I can reproduce this."), false);
});

test("review comment patching only targets ClawSweeper-owned comments", () => {
  assert.equal(canPatchReviewComment({ user: { login: "clawsweeper" } }), true);
  assert.equal(canPatchReviewComment({ user: { login: "clawsweeper[bot]" } }), true);
  assert.equal(canPatchReviewComment({ user: { login: "openclaw-clawsweeper[bot]" } }), true);
  assert.equal(canPatchReviewComment({ user: { login: "steipete" } }), false);
  assert.equal(canPatchReviewComment(undefined), false);
});

test("review start status comment is marker-backed and crustacean-friendly", () => {
  const comment = renderReviewStartStatusComment({
    number: 74453,
    kind: "pull_request",
    title: "fix webhook limiter",
    position: 1,
    total: 3,
    shardIndex: 0,
    shardCount: 2,
  });

  assert.match(comment, /ClawSweeper status: review started\./);
  assert.match(comment, /claws on keyboard/);
  assert.match(comment, /<!-- clawsweeper-review-status:started item=74453 -->/);
  assert.match(comment, /<!-- clawsweeper-review item=74453 -->/);
  assert.doesNotMatch(comment, /Codex review:/);
});

test("pull request keep-open review comments label the change summary", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74265",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this test-only PR open for maintainer review.

## What This Changes

Adds regression coverage for session-scoped model overrides.

## Best Possible Solution

Land the tests after targeted validation is green.

## Reproduction Assessment

Not applicable. This is a test-only PR and the validation path is the targeted test lane.

## Solution Assessment

Yes. Landing the focused regression test after the targeted lane is green is the narrowest useful path.

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Status: none

Reason: Maintainers should review the tests after the targeted lane is green.

## Evidence

- **targeted lane:** The PR is test-only and should run the matching changed-test lane.
	`,
    "none",
  );

  assert.match(comment, /Codex review: needs maintainer review before merge\./);
  assert.match(
    comment,
    /\*\*Summary\*\*\nAdds regression coverage for session-scoped model overrides\./,
  );
  assert.match(comment, /\*\*Next step before merge\*\*/);
  assert.match(comment, /Maintainers should review the tests after the targeted lane is green\./);
  assert.match(comment, /<details>\n<summary>Review details<\/summary>/);
  assert.match(
    comment,
    /Best possible solution:\n\nLand the tests after targeted validation is green\./,
  );
  assert.match(
    comment,
    /Do we have a high-confidence way to reproduce the issue\?\n\nNot applicable\. This is a test-only PR/,
  );
  assert.match(
    comment,
    /Is this the best way to solve the issue\?\n\nYes\. Landing the focused regression test/,
  );
  assert.ok(
    comment.indexOf("Is this the best way to solve the issue?") <
      comment.indexOf("What I checked:"),
  );
  assert.match(comment, /<!-- clawsweeper-verdict:needs-human item=74265 sha=abc123def456/);
});

test("issue keep-open review comments surface reproducibility in the summary", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "issue",
      number: "75877",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "queue_fix_pr",
    })}

## Summary

Keep open. Slack typing callbacks are disabled in message-tool-only group replies.

## Reproduction Assessment

Yes. A source-level reproduction is clear: set a Slack group turn to message-tool-only and inspect the dispatch typing callbacks.

## Work Candidate

Candidate: queue_fix_pr

Confidence: high

Priority: medium

Status: queued

Reason: The bug is narrow and source-reproducible.
`,
    "none",
  );

  assert.match(
    comment,
    /\*\*Summary\*\*\nKeep open\. Slack typing callbacks are disabled in message-tool-only group replies\.\n\nReproducibility: yes\. A source-level reproduction is clear/,
  );
  assert.ok(comment.indexOf("Reproducibility: yes.") < comment.indexOf("**Next step**"));
  assert.doesNotMatch(comment, /\*\*Security\*\*/);
  assert.doesNotMatch(comment, /Not applicable:/);
  assert.match(
    comment,
    /Do we have a high-confidence way to reproduce the issue\?\n\nYes\. A source-level reproduction is clear/,
  );
});

test("pull request review comments include dedicated security review", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74265",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Updates a workflow permission for review comments.

## Best Possible Solution

Land the workflow permission change after normal CI.

## Security Review

Status: needs_attention

Summary: The workflow now asks for issue write permission, so the permission scope needs maintainer confirmation.

Concerns:

- **[medium] Confirm issue write scope:** \`.github/workflows/sweep.yml:652\`
  - body: The review shard now writes comments during review, so maintainers should confirm the app permission is intended.
  - confidence: 0.82

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.85

Full review comments:

- none

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Reason: Normal maintainer review is sufficient.

## Evidence

- **workflow:** Review shard requests issue write permission.

## Likely Related People

- **@alice:** recent workflow maintainer
  - reason: touched the workflow recently
  - commits: abc123
  - files: .github/workflows/sweep.yml
  - confidence: high

## Risks / Open Questions

- none
`,
    "none",
  );

  assert.match(comment, /\*\*Security\*\*/);
  assert.match(comment, /Needs attention:/);
  assert.match(comment, /Confirm issue write scope/);
  assert.match(comment, /Review details/);
  assert.match(comment, /<!-- clawsweeper-security:security-sensitive item=74265 sha=abc123def456/);
  assert.match(comment, /<!-- clawsweeper-verdict:needs-human item=74265 sha=abc123def456/);
});

test("pull request keep-open review comments surface Codex-style findings", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74268",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "queue_fix_pr",
      pull_head_sha: "abc123def456",
    })}

## Summary

This PR needs one correctness fix before merge.

## What This Changes

Adds a config patch command for scripted config edits.

## Best Possible Solution

Reject misspelled replacement paths before writing the updated config.

## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.86

Full review comments:

- **[P1] Validate replace paths:** \`src/config/apply.ts:42-44\`
  - body: A misspelled replace path is currently ignored, so the command can report success while leaving the intended setting unchanged.
  - confidence: 0.9

## Work Candidate

Candidate: queue_fix_pr

Confidence: high

Priority: high

Status: candidate

Reason: The fix is narrow and can be made on the PR branch.
`,
    "none",
  );

  assert.match(comment, /Codex review: needs changes before merge\./);
  assert.match(
    comment,
    /\*\*Review findings\*\*\n- \[P1\] Validate replace paths — `src\/config\/apply\.ts:42-44`/,
  );
  assert.match(comment, /Full review comments:/);
  assert.match(comment, /A misspelled replace path is currently ignored/);
  assert.match(comment, /Overall correctness: patch is incorrect/);
  assert.match(comment, /<!-- clawsweeper-action:fix-required/);
});

test("pull request keep-open review comments suppress duplicate best solution text", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74266",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this docs-only PR open for maintainer review.

## What This Changes

Documents ClawSweeper self-review smoke coverage.

## Best Possible Solution

Land this docs-only PR after maintainer review.
`,
    "none",
  );

  assert.match(
    comment,
    /\*\*Next step before merge\*\*\nLand this docs-only PR after maintainer review\./,
  );
  assert.doesNotMatch(comment, /Best possible solution:/);
});

test("pull request automerge review comments can emit pass verdicts", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74453",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      labels: JSON.stringify(["clawsweeper:automerge"]),
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this focused PR open for automerge.

## What This Changes

Closes the voice-call webhook limiter fail-open path.

## Best Possible Solution

Merge after required checks are green.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
    "none",
  );

  assert.match(comment, /Codex review: passed\./);
  assert.match(comment, /\*\*Next step before merge\*\*\nMerge after required checks are green\./);
  assert.doesNotMatch(comment, /Automerge follow-up:/);
  assert.match(comment, /<!-- clawsweeper-verdict:pass item=74453 sha=abc123def456/);
  assert.doesNotMatch(comment, /clawsweeper-verdict:needs-human/);
});

test("sufficient real behavior proof allows automerge pass markers", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74459",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this focused PR open for automerge.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Merge after required checks are green.

${realBehaviorProofReportSection()}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /\*\*Real behavior proof\*\*\nSufficient \(terminal\):/);
  assert.match(markers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:needs-human/);
});

test("screenshot-only browser runtime proof blocks pass markers", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74460",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this focused PR open for automerge.

## What This Changes

Adds tweakcn.com to the Control UI connect-src directive.

## Best Possible Solution

Ask the contributor to add browser runtime proof from their real setup.

${realBehaviorProofReportSection({
  status: "sufficient",
  evidenceKind: "screenshot",
  needsContributorAction: false,
  summary:
    "The inspected screenshot shows an after-fix Control UI import success state for a tweakcn theme, with no visible console CSP violation.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /Codex review: needs real behavior proof before merge\./);
  assert.match(comment, /Needs stronger real behavior proof before merge:/);
  assert.match(comment, /not enough for browser runtime or security behavior/);
  assert.match(comment, /console, network, terminal, live output, or logs/);
  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(markers, /proof: sufficient/);
});

test("missing real behavior proof blocks pass and repair markers", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74460",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "queue_fix_pr",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this PR open until the contributor proves the fix in a real setup.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Ask the contributor to add after-fix proof from their real setup.

${realBehaviorProofReportSection({
  status: "missing",
  evidenceKind: "none",
  needsContributorAction: true,
  summary:
    "The PR body does not include after-fix evidence from a real setup; terminal screenshots, console output, copied live output, linked artifacts, recordings, and redacted logs count.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /Codex review: needs real behavior proof before merge\./);
  assert.match(comment, /\*\*Real behavior proof\*\*/);
  assert.match(comment, /terminal screenshots, console output, copied live output/);
  assert.match(comment, /update the PR body; ClawSweeper should re-review automatically/);
  assert.match(comment, /@clawsweeper re-review/);
  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(markers, /clawsweeper-action:fix-required/);
});

test("mock-only real behavior proof blocks repair markers", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74461",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["clawsweeper:autofix"]),
    work_candidate: "queue_fix_pr",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this PR open until proof covers real behavior.

${realBehaviorProofReportSection({
  status: "mock_only",
  evidenceKind: "none",
  needsContributorAction: true,
  summary:
    "The PR only cites unit tests and CI; the contributor needs a terminal screenshot, console output, copied live output, recording, linked artifact, or redacted runtime log from a real setup.",
})}

## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.9

Full review comments:

- **[P3] Add a changelog entry:** \`CHANGELOG.md:12\`
  - body: The PR changes user-visible behavior and needs a changelog entry.
  - confidence: 0.8
`;

  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-action:fix-required/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:needs-changes/);
});

test("OpenClaw contributor changelog-entry findings are normalized", () => {
  const decision = parseDecision(
    changelogReviewDecision(),
    item({ repo: "openclaw/openclaw", kind: "pull_request" }),
  );

  assert.deepEqual(decision.reviewFindings, []);
  assert.equal(decision.overallCorrectness, "patch is correct");
  assert.equal(decision.workCandidate, "none");
  assert.equal(decision.workReason, "");
});

test("OpenClaw maintainer changelog-entry findings stay actionable", () => {
  const decision = parseDecision(
    changelogReviewDecision(),
    item({ repo: "openclaw/openclaw", kind: "pull_request", authorAssociation: "MEMBER" }),
  );

  assert.deepEqual(
    decision.reviewFindings.map((finding) => finding.title),
    ["Add the required changelog entry"],
  );
  assert.equal(decision.overallCorrectness, "patch is incorrect");
  assert.equal(decision.workCandidate, "queue_fix_pr");
});

test("OpenClaw changelog normalization keeps real findings actionable", () => {
  const decision = parseDecision(
    changelogReviewDecision({
      reviewFindings: [
        reviewFinding({ file: "CHANGELOG.md" }),
        reviewFinding({
          title: "Preserve the existing option value",
          body: "The patch resets configured values when the dialog is reopened.",
          priority: 1,
          confidenceScore: 0.89,
          file: "src/options.ts",
          lineStart: 42,
          lineEnd: 42,
        }),
      ],
      workReason: "Fix the option reset bug.",
      workPrompt: "Fix src/options.ts and add a regression test.",
      workLikelyFiles: ["src/options.ts"],
    }),
    item({ repo: "openclaw/openclaw", kind: "pull_request" }),
  );

  assert.deepEqual(
    decision.reviewFindings.map((finding) => finding.title),
    ["Preserve the existing option value"],
  );
  assert.equal(decision.overallCorrectness, "patch is incorrect");
  assert.equal(decision.workCandidate, "queue_fix_pr");
});

test("OpenClaw changelog normalization keeps changelog tooling findings actionable", () => {
  const decision = parseDecision(
    changelogReviewDecision({
      reviewFindings: [
        reviewFinding({
          title: "Missing CHANGELOG.md entry validation",
          body: "The parser accepts malformed changelog entries.",
          priority: 2,
          confidenceScore: 0.82,
          file: "src/clawsweeper.ts",
          lineStart: 42,
          lineEnd: 42,
        }),
      ],
      workReason: "Add changelog parser coverage.",
      workPrompt: "Add parser coverage.",
      workLikelyFiles: ["test/clawsweeper.test.ts"],
    }),
    item({ repo: "openclaw/openclaw", kind: "pull_request" }),
  );

  assert.deepEqual(
    decision.reviewFindings.map((finding) => finding.title),
    ["Missing CHANGELOG.md entry validation"],
  );
  assert.equal(decision.overallCorrectness, "patch is incorrect");
  assert.equal(decision.workCandidate, "queue_fix_pr");
});

test("pull request automerge pass is not blocked by generic protected labels", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74716",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      confidence: "high",
      labels: JSON.stringify(["maintainer", "size: XL", "clawsweeper:automerge"]),
      work_candidate: "manual_review",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this protected platform PR open for automerge gates.

## What This Changes

Routes Codex Computer Use through the Mac app node host.

## Best Possible Solution

Merge after ClawSweeper review and required checks are green.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
    "none",
  );

  assert.match(comment, /Codex review: passed\./);
  assert.doesNotMatch(comment, /Codex review: passed for ClawSweeper automerge/);
  assert.match(comment, /<!-- clawsweeper-verdict:pass item=74716 sha=abc123def456/);
  assert.doesNotMatch(comment, /clawsweeper-verdict:needs-human/);
});

test("pull request autofix review comments can emit pass verdicts without merge copy", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74610",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      labels: JSON.stringify(["clawsweeper:autofix"]),
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this draft PR open for autofix.

## What This Changes

Adds the SDK package scaffolding.

## Best Possible Solution

Leave this draft open after fixes are complete.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
    "none",
  );

  assert.match(comment, /Codex review: passed\./);
  assert.match(
    comment,
    /\*\*Next step before merge\*\*\nLeave this draft open after fixes are complete\./,
  );
  assert.doesNotMatch(comment, /Autofix follow-up:/);
  assert.match(comment, /<!-- clawsweeper-verdict:pass item=74610 sha=abc123def456/);
  assert.doesNotMatch(comment, /Codex review: passed for ClawSweeper automerge/);
});

test("pull request automerge review comments with findings require repair", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74454",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    review_status: "complete",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "queue_fix_pr",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this focused PR open for automerge repair.

## What This Changes

Updates the webhook limiter.

## Best Possible Solution

Fix the missing limiter branch, then review again.

## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.9

Full review comments:

- **[P1] Preserve the limiter guard:** \`src/webhooks/voice.ts:42\`
  - body: The new branch can skip the limiter before accepting a webhook.
  - confidence: 0.91
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /Codex review: needs changes before merge\./);
  assert.match(comment, /\*\*Review findings\*\*/);
  assert.doesNotMatch(comment, /clawsweeper-verdict:pass/);
  assert.match(markers, /clawsweeper-verdict:needs-changes/);
  assert.match(markers, /clawsweeper-action:fix-required/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
});

test("pull request automerge findings trigger repair without work candidate frontmatter", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74454",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    review_status: "complete",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    pull_head_sha: "abc123def456",
  })}

## Review Findings

Overall correctness: patch is incorrect

Full review comments:

- **[P1] Preserve the limiter guard:** \`src/webhooks/voice.ts:42\`
  - body: The new branch can skip the limiter before accepting a webhook.
`;

  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(markers, /clawsweeper-verdict:needs-changes/);
  assert.match(markers, /clawsweeper-action:fix-required/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:needs-human/);
});

function workPlanCandidateReport(overrides = {}) {
  const frontmatter = {
    number: 321,
    repository: "openclaw/clawsweeper",
    type: "issue",
    title: "Render work plans",
    reviewed_at: new Date().toISOString(),
    review_status: "complete",
    local_checkout_access: "verified",
    decision: "keep_open",
    action_taken: "kept_open",
    work_candidate: "queue_fix_pr",
    work_status: "candidate",
    work_priority: "medium",
    work_confidence: "high",
    work_likely_files: JSON.stringify(["src/clawsweeper.ts", "test/clawsweeper.test.ts"]),
    work_validation: JSON.stringify(["pnpm run check"]),
    work_cluster_refs: JSON.stringify(["openclaw/clawsweeper#26"]),
    ...overrides,
  };
  return `---
${Object.entries(frontmatter)
  .map(([key, value]) => `${key}: ${value}`)
  .join("\n")}
---

# #321: Render work plans

## Summary

The dashboard has queue_fix_pr candidates but no generated coding plan.

## Repair Work Prompt

Render generated plan markdown from existing report fields.
`;
}

test("renderWorkPlanFromReport renders dashboard plan artifacts for fresh queue_fix_pr candidates", () => {
  const plan = renderWorkPlanFromReport(workPlanCandidateReport(), {
    reportPath: "records/openclaw-clawsweeper/items/321.md",
  });
  assert.ok(plan);
  assert.match(plan, /# Coding Plan for openclaw\/clawsweeper#321: Render work plans/);
  assert.match(plan, /Render generated plan markdown from existing report fields\./);
  assert.match(plan, /- `src\/clawsweeper\.ts`/);
  assert.match(plan, /- `pnpm run check`/);
  assert.match(plan, /openclaw\/clawsweeper#26/);
});

test("renderWorkPlanFromReport returns null for stale, reclassified, or non-candidate reports", () => {
  assert.equal(renderWorkPlanFromReport(workPlanCandidateReport({ work_candidate: "none" })), null);
  assert.equal(
    renderWorkPlanFromReport(workPlanCandidateReport({ work_status: "manual_review" })),
    null,
  );
  assert.equal(renderWorkPlanFromReport(workPlanCandidateReport({ action_taken: "closed" })), null);
  assert.equal(
    renderWorkPlanFromReport(workPlanCandidateReport({ reviewed_at: "2026-01-01T00:00:00.000Z" })),
    null,
  );
});

test("apply-artifacts writes and removes generated work plans", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "321.md"), workPlanCandidateReport(), "utf8");
    execFileSync(process.execPath, [
      "dist/clawsweeper.js",
      "apply-artifacts",
      "--target-repo",
      "openclaw/clawsweeper",
      "--artifact-dir",
      artifactDir,
      "--items-dir",
      itemsDir,
      "--closed-dir",
      closedDir,
      "--plans-dir",
      plansDir,
      "--replay-closed-artifacts",
      "--skip-reconcile",
    ]);
    const planPath = join(plansDir, "321.md");
    assert.ok(existsSync(planPath));
    assert.match(readFileSync(planPath, "utf8"), /## Plan\n\nRender generated plan markdown/);

    writeFileSync(
      join(artifactDir, "321.md"),
      workPlanCandidateReport({ work_candidate: "none", work_status: "none" }),
      "utf8",
    );
    execFileSync(process.execPath, [
      "dist/clawsweeper.js",
      "apply-artifacts",
      "--target-repo",
      "openclaw/clawsweeper",
      "--artifact-dir",
      artifactDir,
      "--items-dir",
      itemsDir,
      "--closed-dir",
      closedDir,
      "--plans-dir",
      plansDir,
      "--replay-closed-artifacts",
      "--skip-reconcile",
    ]);
    assert.equal(existsSync(planPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions removes archived work plans from the scoped plans directory", () => {
  const root = mkdtempSync(tmpPrefix);
  const originalPath = process.env.PATH;
  const defaultPlanDir = join(process.cwd(), "records", "openclaw-clawsweeper", "plans");
  const defaultPlanPath = join(defaultPlanDir, "321.md");
  try {
    const binDir = join(root, "bin");
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    mkdirSync(defaultPlanDir, { recursive: true });
    writeFileSync(
      join(binDir, "gh"),
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args.includes("/comments")) {
  console.log(JSON.stringify([[]]));
} else {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: "2026-05-02T00:00:00Z",
    state: "closed",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: null
  }));
}
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(itemsDir, "321.md"),
      workPlanCandidateReport({
        item_snapshot_hash: "reviewed-snapshot",
        item_updated_at: "2026-05-01T00:00:00Z",
      }),
      "utf8",
    );
    writeFileSync(join(plansDir, "321.md"), "scoped generated plan\n", "utf8");
    writeFileSync(defaultPlanPath, "default generated plan\n", "utf8");

    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    execFileSync(process.execPath, [
      "dist/clawsweeper.js",
      "apply-decisions",
      "--target-repo",
      "openclaw/clawsweeper",
      "--items-dir",
      itemsDir,
      "--closed-dir",
      closedDir,
      "--plans-dir",
      plansDir,
      "--limit",
      "1",
      "--processed-limit",
      "1",
      "--close-delay-ms",
      "0",
    ]);

    assert.equal(existsSync(join(plansDir, "321.md")), false);
    assert.ok(existsSync(defaultPlanPath));
    assert.ok(existsSync(join(closedDir, "321.md")));
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(defaultPlanPath, { force: true });
  }
});

test("security-needs-attention reports block unopted repair and automerge pass markers", () => {
  const securitySection = `
## Security Review

Status: needs_attention

Summary: The patch exposes a broader token scope and needs maintainer security review.

Concerns:

- **[high] Avoid broad token reuse:** \`src/auth/token.ts:42\`
  - body: The patch can reuse a token with broader scopes than the caller requested.
  - confidence: 0.91
`;
  const repairMarkers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74123",
    pull_head_sha: "abc123def456",
    decision: "keep_open",
    confidence: "high",
    work_candidate: "queue_fix_pr",
  })}

## Summary

Needs a repair.

${securitySection}
`);

  assert.match(repairMarkers, /clawsweeper-security:security-sensitive/);
  assert.match(repairMarkers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(repairMarkers, /clawsweeper-verdict:needs-changes/);
  assert.doesNotMatch(repairMarkers, /clawsweeper-action:fix-required/);

  const autofixRepairMarkers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74125",
    pull_head_sha: "abc789def123",
    decision: "keep_open",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:autofix"]),
    work_candidate: "queue_fix_pr",
  })}

## Summary

Needs an opted-in repair.

${securitySection}
`);

  assert.match(autofixRepairMarkers, /clawsweeper-security:security-sensitive/);
  assert.match(autofixRepairMarkers, /clawsweeper-verdict:needs-changes/);
  assert.match(autofixRepairMarkers, /clawsweeper-action:fix-required/);
  assert.match(autofixRepairMarkers, /finding=security-review/);
  assert.doesNotMatch(autofixRepairMarkers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(autofixRepairMarkers, /clawsweeper-verdict:pass/);

  const automergeMarkers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74124",
    pull_head_sha: "def456abc123",
    decision: "keep_open",
    confidence: "high",
    review_status: "complete",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
  })}

## Summary

Would otherwise pass automerge.

${securitySection}
`);

  assert.match(automergeMarkers, /clawsweeper-security:security-sensitive/);
  assert.match(automergeMarkers, /clawsweeper-verdict:needs-changes/);
  assert.match(automergeMarkers, /clawsweeper-action:fix-required/);
  assert.match(automergeMarkers, /finding=security-review/);
  assert.doesNotMatch(automergeMarkers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(automergeMarkers, /clawsweeper-verdict:needs-human/);
});

test("pull request keep-open review comments suppress duplicate remaining risk text", () => {
  const duplicateRisk = "Run the automerge smoke after the repair lane is green.";
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74267",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this smoke-test PR open for maintainer review.

## What This Changes

Adds regression coverage for automerge repair smoke comments.

## Risks / Open Questions

${duplicateRisk}

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Status: none

Reason: ${duplicateRisk}
`,
    "none",
  );

  assert.ok(comment.includes(`**Next step before merge**\n${duplicateRisk}`));
  assert.doesNotMatch(comment, /Remaining risk \/ open question:/);
  assert.equal(comment.split(duplicateRisk).length - 1, 1);
});

test("pull request review reports carry verdict and repair markers", () => {
  const markdown = `${reportFrontMatter({
    type: "pull_request",
    number: "74065",
    pull_head_sha: "abc123def456",
    decision: "keep_open",
    confidence: "high",
    work_candidate: "queue_fix_pr",
  })}

## Summary

Needs one more repair.
`;

  const markers = reviewAutomationMarkersFromReport(markdown);
  assert.match(markers, /clawsweeper-verdict:needs-changes/);
  assert.match(markers, /clawsweeper-action:fix-required/);
  assert.match(markers, /item=74065/);
  assert.match(markers, /sha=abc123def456/);
});

test("pull request reports without a repair candidate pause for human review", () => {
  const markers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74105",
    pull_head_sha: "abc123def456",
    decision: "keep_open",
    confidence: "high",
    work_candidate: "none",
  })}

## Summary

Needs maintainer review.
`);

  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:needs-changes/);
  assert.doesNotMatch(markers, /clawsweeper-action:fix-required/);
  assert.match(markers, /item=74105/);
  assert.match(markers, /sha=abc123def456/);
});

test("non-PR review reports do not carry repair markers", () => {
  assert.equal(reviewAutomationMarkersFromReport(reportFrontMatter({ type: "issue" })), "");
});

test("item number args merge and sort workflow inputs", () => {
  assert.deepEqual(itemNumbersArg("42, 7, nope, 42", "5"), [5, 7, 42]);
  assert.deepEqual(itemNumbersArg("", undefined), []);
});

test("explicit item numbers shard targeted review runs", () => {
  assert.deepEqual(shardItemNumbers([5, 7, 42, 99], 2), [
    { shard: 0, itemNumbers: [5, 42] },
    { shard: 1, itemNumbers: [7, 99] },
  ]);
  assert.deepEqual(shardItemNumbers([5, 7], 50), [
    { shard: 0, itemNumbers: [5] },
    { shard: 1, itemNumbers: [7] },
  ]);
  assert.deepEqual(shardItemNumbers([], 50), [{ shard: 0, itemNumbers: [] }]);
});

test("planned review shards stay within the Codex worker cap", () => {
  const itemNumbers = Array.from({ length: 300 }, (_, index) => index + 1);
  const shards = shardItemNumbers(itemNumbers, 400);
  assert.equal(shards.length, 100);
  assert.equal(
    shards.reduce((total, shard) => total + shard.itemNumbers.length, 0),
    itemNumbers.length,
  );
});

test("apply mode prioritizes matching close proposals before comment sync", () => {
  const issueClose = reportFrontMatter({
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "proposed_close",
  });
  const pullRequestClose = reportFrontMatter({
    type: "pull_request",
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "proposed_close",
  });

  assert.equal(applyDecisionPriority(issueClose, "issue"), 0);
  assert.equal(applyDecisionPriority(pullRequestClose, "issue"), 1);
  assert.equal(applyDecisionPriority(reportFrontMatter(), "issue"), 2);
});

test("comment-only sync creates or refreshes stale durable review comments", () => {
  const now = Date.parse("2026-04-26T12:00:00Z");
  const base = {
    syncCommentsOnly: true,
    isCloseProposal: false,
    commentSyncMinAgeDays: 7,
    reviewCommentSyncedAt: "2026-04-25T12:00:00Z",
    hasExistingReviewComment: true,
    needsReviewCommentBodySync: true,
    needsReviewCommentHashSync: true,
    needsReviewCommentReferenceSync: false,
    now,
  };

  assert.equal(shouldSyncReviewComment(base), false);
  assert.equal(
    shouldSyncReviewComment({
      ...base,
      hasExistingReviewComment: false,
    }),
    true,
  );
  assert.equal(
    shouldSyncReviewComment({
      ...base,
      needsReviewCommentBodySync: false,
      needsReviewCommentHashSync: false,
      needsReviewCommentReferenceSync: true,
    }),
    true,
  );
  assert.equal(
    shouldSyncReviewComment({
      ...base,
      reviewCommentSyncedAt: "2026-04-18T12:00:00Z",
    }),
    true,
  );
  assert.equal(
    shouldSyncReviewComment({
      ...base,
      syncCommentsOnly: false,
    }),
    true,
  );
  assert.equal(
    shouldSyncReviewComment({
      ...base,
      isCloseProposal: true,
    }),
    true,
  );
});

test("review artifacts are ignored once the live item is closed", () => {
  assert.equal(reviewArtifactDestination("kept_open", true), "items");
  assert.equal(reviewArtifactDestination("proposed_close", true), "items");
  assert.equal(reviewArtifactDestination("closed", true), "closed");
  assert.equal(reviewArtifactDestination("proposed_close", false), "skip_closed");
  assert.equal(reviewArtifactDestination("kept_open", false), "skip_closed");
});

test("runtime budget only trips after a positive elapsed limit", () => {
  assert.equal(runtimeBudgetExceeded(1000, 0, 100000), false);
  assert.equal(runtimeBudgetExceeded(1000, 5000, 5999), false);
  assert.equal(runtimeBudgetExceeded(1000, 5000, 6000), true);
});

test("decision parser enforces required schema-shaped evidence", () => {
  assert.equal(parseDecision(closeDecision()).decision, "close");
  assert.equal(parseDecision(closeDecision({ itemCategory: "skill" })).itemCategory, "skill");
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        evidence: [{ label: "partial", detail: "missing nullable fields" }],
      }),
    /decision\.evidence\[0\]\.file/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        likelyOwners: [],
      }),
    /decision\.likelyOwners must not be empty/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        likelyOwners: [{ person: "@alice", reason: "missing fields" }],
      }),
    /decision\.likelyOwners\[0\]\.role/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        workCandidate: "auto_everything",
      }),
    /decision\.workCandidate/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        itemCategory: "mixed_mode",
      }),
    /decision\.itemCategory/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        requiresNewConfigOption: "false",
      }),
    /decision\.requiresNewConfigOption/,
  );
  assert.throws(() => {
    const decision = closeDecision();
    delete decision.securityReview;
    return parseDecision(decision);
  }, /decision\.securityReview/);
  assert.throws(() => {
    const decision = closeDecision();
    delete decision.realBehaviorProof;
    return parseDecision(decision);
  }, /decision\.realBehaviorProof/);
  const workCandidate = parseDecision(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      workCandidate: "queue_fix_pr",
      workConfidence: "high",
      workPriority: "medium",
      workReason: "The bug is narrow and reproducible.",
      workPrompt: "Fix the narrow bug and add a regression test.",
      workClusterRefs: ["#123", "#456"],
      workValidation: ["pnpm test:unit"],
      workLikelyFiles: ["src/example.ts", "test/example.test.ts"],
    }),
  );
  assert.equal(workCandidate.workCandidate, "queue_fix_pr");
  assert.equal(workCandidate.itemCategory, "bug");
  assert.equal(workCandidate.reproductionStatus, "reproduced");
  assert.equal(workCandidate.realBehaviorProof.status, "not_applicable");
  assert.deepEqual(workCandidate.workClusterRefs, ["#123", "#456"]);
});

test("review prompt routes PR likely owners through feature history", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /feature-history hunt/);
  assert.match(prompt, /who introduced the feature/);
  assert.match(prompt, /git log --follow -- <file>/);
  assert.match(prompt, /do not list the PR author solely/);
  assert.match(prompt, /not to the PR\s+author merely for writing the proposal/);
  assert.match(prompt, /Do not include email\s+addresses in `likelyOwners`/);
  assert.match(prompt, /use names without email addresses/);
});

test("review prompt requires a dedicated securityReview section", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Always summarize this pass in `securityReview`/);
  assert.match(prompt, /Always fill `securityReview`/);
  assert.match(prompt, /status: "needs_attention"/);
});

test("review prompt requires real behavior proof for PR reviews", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /realBehaviorProof/);
  assert.match(prompt, /Terminal screenshots|terminal screenshots/);
  assert.match(prompt, /download\/open GitHub attachment links/);
  assert.match(prompt, /generate stills or contact sheets from videos/);
  assert.match(prompt, /compare the proof against the PR diff/);
  assert.match(prompt, /Prefer asking for screenshots or videos/);
  assert.match(prompt, /redact private information like IP addresses, API keys/);
  assert.match(prompt, /screenshot-only proof sufficient/);
  assert.match(prompt, /no visible console violation/);
  assert.match(prompt, /scratch directory/);
  assert.match(prompt, /@clawsweeper re-review/);
  assert.match(
    prompt,
    /Unit tests, mocks, snapshots, lint, typechecks, and CI are supplemental only/,
  );
  assert.match(prompt, /do not request ClawSweeper repair markers/);
});

test("ClawSweeper proof judgement controls the sufficient proof label", () => {
  assert.deepEqual(realBehaviorProofSufficientLabelsForTest(["proof: supplied"], "sufficient"), [
    "proof: supplied",
    "proof: sufficient",
  ]);
  assert.deepEqual(
    realBehaviorProofSufficientLabelsForTest(
      ["proof: supplied", "proof: sufficient"],
      "insufficient",
    ),
    ["proof: supplied"],
  );
  assert.deepEqual(realBehaviorProofSufficientLabelsForTest(["proof: sufficient"], "missing"), []);
});

test("review workflow gives Codex a read-only inspection token", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(workflow, /id: codex-inspection-token/);
  assert.match(workflow, /permission-issues: read/);
  assert.match(workflow, /CLAWSWEEPER_PROOF_INSPECTION_TOKEN/);
});

test("manual exact-item review dispatches avoid broad review concurrency", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && \(github\.event\.inputs\.item_number != '' \|\| github\.event\.inputs\.item_numbers != ''\)\) && format\('clawsweeper-intake-exact-\{0\}'/,
  );
  assert.doesNotMatch(
    workflow,
    /github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.hot_intake == 'true' && \(github\.event\.inputs\.item_number != '' \|\| github\.event\.inputs\.item_numbers != ''\)\) && format\('clawsweeper-intake-exact-\{0\}'/,
  );
});

test("sweep workflow publishes target-scoped state paths", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(workflow, /target_slug="\$TARGET_REPO"/);
  assert.match(workflow, /--path "records\/\$\{target_slug\}"/);
  assert.match(workflow, /--path "results\/sweep-status\/\$\{target_slug\}\.json"/);
  assert.doesNotMatch(workflow, /--path records\s*\\/);
  assert.doesNotMatch(workflow, /--path results\/sweep-status\s*\\/);
});

test("review prompt asks for concise public review fields", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Keep these fields concise because they become the public review comment/);
  assert.match(prompt, /one short sentence for `changeSummary`, `workReason`, `bestSolution`/);
  assert.match(
    prompt,
    /merge\s+automation is reported by the command\/status comment and hidden markers/,
  );
});

test("review prompt keeps automerge opt-in from becoming generic manual review", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /explicitly opted into `clawsweeper:automerge`/);
  assert.match(prompt, /Do not choose `manual_review` solely because/);
  assert.match(prompt, /`maintainer` label/);
  assert.match(prompt, /large `size:\*` label/);
  assert.match(prompt, /choose `queue_fix_pr` even when the\s+finding is process-only or P3/);
  assert.match(prompt, /Changelog entries are maintainer-owned/);
  assert.match(prompt, /do not create a\s+review finding,\s+needs-changes\s+verdict/i);
  assert.match(prompt, /do not ask the PR\s+author to add one/);
  assert.doesNotMatch(prompt, /missing required changelog\s+entry/);
  assert.match(prompt, /does not by itself block a clean automerge verdict/);
});

test("review prompts require reproduction and solution assessment details", () => {
  const itemPrompt = readFileSync("prompts/review-item.md", "utf8");
  const commitPrompt = readFileSync("prompts/review-commit.md", "utf8");

  assert.match(itemPrompt, /Always fill `reproductionAssessment`/);
  assert.match(itemPrompt, /itemCategory: "bug"/);
  assert.match(itemPrompt, /itemCategory: "skill"/);
  assert.match(itemPrompt, /skills\/<vendor>/);
  assert.match(itemPrompt, /upload or publish it through ClawHub\.com/);
  assert.match(itemPrompt, /requiresNewConfigOption/);
  assert.match(itemPrompt, /automatic\s+bug-fix PR creation/);
  assert.match(itemPrompt, /For every other issue or PR reference,\s+use the full GitHub URL/);
  assert.doesNotMatch(itemPrompt, /normal `#123` links/);
  assert.match(itemPrompt, /Always fill `solutionAssessment`/);
  assert.match(itemPrompt, /Do we have a high-confidence way to reproduce the\s+issue\?/);
  assert.match(itemPrompt, /Is this the best way to solve the issue\?/);
  assert.match(commitPrompt, /The checkout is current target\s+`main`, not the commit snapshot/);
  assert.match(commitPrompt, /Do we have a high-confidence way to reproduce the issue\?/);
  assert.match(commitPrompt, /Is this the best way to solve the issue\?/);
});

test("commit review workflow settles and reviews from target main", () => {
  const workflow = readFileSync(".github/workflows/commit-review.yml", "utf8");

  assert.match(workflow, /CLAWSWEEPER_COMMIT_REVIEW_SETTLE_SECONDS \|\| '60'/);
  assert.match(workflow, /sleep "\$SETTLE_SECONDS"/);
  assert.match(workflow, /Check out target main/);
  assert.match(workflow, /checkout -B main refs\/remotes\/origin\/main/);
  assert.doesNotMatch(workflow, /checkout --detach "\$COMMIT_SHA"/);
});

test("sweep target write tokens can merge pull requests", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const targetWriteTokenBlocks = workflow
    .split("- name: Create target write token")
    .slice(1)
    .map((block) => block.split("\n      - ")[0]);

  assert.equal(targetWriteTokenBlocks.length, 3);
  for (const block of targetWriteTokenBlocks) {
    assert.match(block, /permission-contents: write/);
    assert.match(block, /permission-pull-requests: write/);
  }
});

test("sweep review recovery uses explicit failed shard artifacts", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(workflow, /- name: Review shard\n\s+id: review-shard\n\s+continue-on-error: true/);
  assert.match(workflow, /- name: Record failed review shard/);
  assert.match(workflow, /steps\.review-shard\.outcome == 'failure'/);
  assert.match(workflow, /name: review-failed-shard-\$\{\{ matrix\.shard \}\}/);
  assert.match(workflow, /pattern: review-failed-shard-\*/);
  assert.match(workflow, /needs\.review\.result != 'skipped'/);
  assert.doesNotMatch(
    workflow,
    /needs\.review\.result == 'failure' \|\| needs\.review\.result == 'cancelled'/,
  );
});

test("sweep dashboard status writes are scoped to the target repository", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const statusCalls = [...workflow.matchAll(new RegExp("pnpm run status -- \\\\", "g"))];

  assert.ok(statusCalls.length > 0);
  for (const match of statusCalls) {
    const block = workflow.slice(match.index, match.index + 220);
    assert.match(block, /--target-repo /);
  }
});

test("review parser strips environment access caveats from risks", () => {
  const parsed = parseDecision(
    closeDecision({
      risks: [
        "GH_TOKEN was unavailable, so authenticated gh could not be used.",
        "A real product uncertainty remains.",
      ],
    }),
  );
  assert.deepEqual(parsed.risks, ["A real product uncertainty remains."]);
});

test("codex subprocess env strips GitHub and App credentials", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.GH_TOKEN = "gh";
    process.env.GITHUB_TOKEN = "github";
    process.env.COMMIT_SWEEPER_TARGET_GH_TOKEN = "target";
    process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN = "codex-target";
    process.env.CLAWSWEEPER_APP_ID = "123";
    process.env.CLAWSWEEPER_APP_PRIVATE_KEY = "private";
    process.env.OPENAI_API_KEY = "openai";
    process.env.CODEX_API_KEY = "codex";

    const env = codexEnv();

    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.COMMIT_SWEEPER_TARGET_GH_TOKEN, undefined);
    assert.equal(env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN, undefined);
    assert.equal(env.CLAWSWEEPER_APP_ID, undefined);
    assert.equal(env.CLAWSWEEPER_APP_PRIVATE_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  } finally {
    process.env = originalEnv;
  }
});

test("codex subprocess env can expose an explicit read-only GitHub token", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.GH_TOKEN = "ambient";
    process.env.GITHUB_TOKEN = "github";
    process.env.COMMIT_SWEEPER_TARGET_GH_TOKEN = "hidden";
    process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN = "hidden-codex";

    const env = codexEnv({ ghToken: "target-read" });

    assert.equal(env.GH_TOKEN, "target-read");
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.COMMIT_SWEEPER_TARGET_GH_TOKEN, undefined);
    assert.equal(env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN, undefined);
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  } finally {
    process.env = originalEnv;
  }
});

test("related title search terms keep issue-specific words", () => {
  assert.deepEqual(
    relatedTitleSearchTerms(
      "Feature: message:before_send hook to enable content-quality fallback gating",
    ),
    ["message", "before_send", "hook", "enable", "content-quality", "fallback"],
  );
});
test("audit detects live/local state drift and unsafe proposed records", () => {
  const result = auditFromSnapshot({
    openItems: [
      item({ number: 1, title: "tracked open" }),
      item({ number: 2, title: "missing open" }),
      item({ number: 3, title: "reopened archived" }),
    ],
    itemRecords: [
      auditRecord(1),
      auditRecord(4),
      auditRecord(5),
      auditRecord(6, {
        labels: ["security"],
        decision: "close",
        closeReason: "implemented_on_main",
        action: "proposed_close",
      }),
      auditRecord(7, { reviewStatus: "stale_local_checkout_blocked" }),
    ],
    closedRecords: [
      auditRecord(3, { location: "closed", path: "closed/3.md" }),
      auditRecord(5, { location: "closed", path: "closed/5.md" }),
      auditRecord(8, {
        location: "closed",
        path: "closed/8.md",
        labels: ["security"],
        action: "proposed_close",
      }),
    ],
    scanComplete: true,
    pagesScanned: 1,
    generatedAt: "2026-04-26T00:00:00.000Z",
  });

  assert.equal(result.counts.missingOpen, 1);
  assert.equal(result.counts.missingEligibleOpen, 1);
  assert.equal(result.counts.missingMaintainerOpen, 0);
  assert.equal(result.counts.missingProtectedOpen, 0);
  assert.equal(result.counts.missingRecentOpen, 0);
  assert.equal(result.findings.missingOpen[0].number, 2);
  assert.equal(result.findings.missingOpen[0].missingReason, "eligible");
  assert.equal(result.findings.missingEligibleOpen[0].number, 2);
  assert.equal(result.counts.openArchived, 1);
  assert.equal(result.findings.openArchived[0].closedPath, "closed/3.md");
  assert.equal(result.counts.staleItemRecords, 4);
  assert.equal(result.counts.duplicateRecords, 1);
  assert.equal(result.counts.protectedProposed, 1);
  assert.equal(result.findings.protectedProposed[0].number, 6);
  assert.equal(result.counts.staleReviews, 1);
});

test("audit classifies missing open records by actionable reason", () => {
  const base = {
    itemRecords: [],
    closedRecords: [],
    scanComplete: true,
    pagesScanned: 1,
    generatedAt: "2026-04-26T12:00:00.000Z",
  };
  const expectedQueueLag = auditFromSnapshot({
    ...base,
    openItems: [
      item({ number: 1, authorAssociation: "MEMBER" }),
      item({ number: 2, labels: ["beta-blocker"] }),
      item({
        number: 3,
        createdAt: "2026-04-26T11:30:00.000Z",
        updatedAt: "2026-04-26T11:30:00.000Z",
      }),
    ],
  });

  assert.equal(expectedQueueLag.counts.missingOpen, 3);
  assert.equal(expectedQueueLag.counts.missingEligibleOpen, 0);
  assert.equal(expectedQueueLag.counts.missingMaintainerOpen, 1);
  assert.equal(expectedQueueLag.counts.missingProtectedOpen, 1);
  assert.equal(expectedQueueLag.counts.missingRecentOpen, 1);
  assert.deepEqual(
    expectedQueueLag.findings.missingOpen.map((finding) => finding.missingReason),
    ["maintainer_authored", "protected_label", "recently_created"],
  );
  assert.equal(auditHasStrictFailures(expectedQueueLag), false);

  const actionableDrift = auditFromSnapshot({
    ...base,
    openItems: [item({ number: 4, createdAt: "2026-04-24T00:00:00.000Z" })],
  });

  assert.equal(actionableDrift.counts.missingEligibleOpen, 1);
  assert.equal(actionableDrift.findings.missingEligibleOpen[0].missingReason, "eligible");
  assert.equal(auditHasStrictFailures(actionableDrift), true);
});

test("audit health section summarizes strict status and actionable findings", () => {
  const result = auditFromSnapshot({
    openItems: [
      item({
        number: 10,
        title: "eligible missing",
        createdAt: "2026-04-24T00:00:00.000Z",
      }),
      item({ number: 11, title: "reopened archived" }),
      item({ number: 14, title: "stale open review" }),
    ],
    itemRecords: [
      auditRecord(12, { title: "stale local" }),
      auditRecord(13, {
        title: "protected close",
        labels: ["security"],
        action: "proposed_close",
      }),
      auditRecord(14, {
        title: "stale open review",
        currentState: "open",
        reviewStatus: "stale_reopened",
      }),
    ],
    closedRecords: [auditRecord(11, { location: "closed", path: "closed/11.md" })],
    scanComplete: true,
    pagesScanned: 1,
    generatedAt: "2026-04-26T12:00:00.000Z",
  });
  const section = auditHealthSection(result);

  assert.match(section, /### Audit Health/);
  assert.match(section, /<!-- clawsweeper-audit:openclaw-openclaw:start -->/);
  assert.match(
    section,
    /Repository: \[openclaw\/openclaw\]\(https:\/\/github\.com\/openclaw\/openclaw\)/,
  );
  assert.match(section, /Status: \*\*Action needed\*\*/);
  assert.match(section, /Targeted review input: `10,11,14`/);
  assert.match(section, /\| Missing eligible open records \| 1 \|/);
  assert.match(section, /\[#10\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/10\)/);
  assert.match(section, /Missing eligible open/);
  assert.match(section, /\[#13\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/13\)/);
  assert.match(section, /Protected proposed close/);
  assert.match(section, /\[#11\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/11\)/);
  assert.match(section, /Open archived/);
  assert.doesNotMatch(section, /\[#12\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/12\)/);
});

test("audit defers stale item drift until the open scan is complete", () => {
  const result = auditFromSnapshot({
    openItems: [item({ number: 1 })],
    itemRecords: [auditRecord(1), auditRecord(2)],
    closedRecords: [],
    scanComplete: false,
    pagesScanned: 1,
    generatedAt: "2026-04-26T00:00:00.000Z",
  });

  assert.equal(result.scan.complete, false);
  assert.equal(result.counts.staleItemRecords, 0);
  assert.deepEqual(result.findings.staleItemRecords, []);
});

test("recently closed dashboard rows link items and archived reports", () => {
  const rows = formatRecentClosedRows([
    {
      repo: "openclaw/clawhub",
      number: 42,
      kind: "pull_request",
      title: "Fix pipe | title",
      closeReason: "implemented_on_main",
      appliedAt: "2026-04-26T20:00:00.000Z",
      reportPath: "closed/42.md",
    },
  ]);

  assert.match(rows, /\[#42\]\(https:\/\/github\.com\/openclaw\/clawhub\/pull\/42\)/);
  assert.match(
    rows,
    /\[closed\/42\.md\]\(https:\/\/github\.com\/openclaw\/clawsweeper\/blob\/main\/closed\/42\.md\)/,
  );
  assert.match(rows, /Fix pipe \\| title/);
  assert.match(rows, /already implemented on main/);
  assert.match(rows, /Apr 26, 2026, 20:00 UTC/);
});

test("recently closed dashboard rows include reconciled external closes", () => {
  const markdown = reportFrontMatter({
    current_state: "closed",
    current_item_closed_at: "2026-04-28T08:15:03.000Z",
    reconciled_at: "2026-04-28T08:18:02.202Z",
    action_taken: "kept_open",
  });
  const rows = formatRecentClosedRows([
    {
      repo: "openclaw/openclaw",
      number: 73370,
      kind: "issue",
      title: "Externally closed item",
      closeReason: "closed externally after review",
      closedAt: dashboardClosedAt(markdown),
      appliedAt: undefined,
      reportPath: "records/openclaw-openclaw/closed/73370.md",
    },
  ]);

  assert.equal(dashboardClosedAt(markdown), "2026-04-28T08:15:03.000Z");
  assert.equal(
    dashboardClosedAt(
      reportFrontMatter({
        current_state: "closed",
        reconciled_at: "2026-04-28T08:18:02.202Z",
        action_taken: "kept_open",
      }),
    ),
    "2026-04-28T08:18:02.202Z",
  );
  assert.match(rows, /closed externally after review/);
  assert.match(rows, /Apr 28, 2026, 08:15 UTC/);
});

test("GitHub retry classifier distinguishes throttle and transient failures", () => {
  const throttled = new Error("API rate limit exceeded for user ID 1");
  assert.equal(ghRetryKind(throttled), "throttle");
  assert.equal(shouldRetryGh(throttled), true);

  const eof = Object.assign(new Error("Command failed: gh api repos/openclaw/openclaw/issues"), {
    stderr: 'Get "https://api.github.com/repos/openclaw/openclaw/issues?page=54": unexpected EOF\n',
  });
  assert.equal(ghRetryKind(eof), "transient");
  assert.equal(shouldRetryGh(eof), true);

  const connectionReset = new Error(
    "Post https://api.github.com/graphql: read: connection reset by peer",
  );
  assert.equal(ghRetryKind(connectionReset), "transient");

  const badGateway = Object.assign(new Error("gh: HTTP 502: Bad Gateway"), { stderr: "" });
  assert.equal(ghRetryKind(badGateway), "transient");

  const dispatchServerError = Object.assign(
    new Error(
      "could not create workflow dispatch event: HTTP 500: Failed to run workflow dispatch",
    ),
    { stderr: "" },
  );
  assert.equal(ghRetryKind(dispatchServerError), "transient");

  const htmlInsteadOfJson = Object.assign(
    new Error("Command failed: gh api repos/openclaw/openclaw/issues?page=47"),
    { stderr: "invalid character '<' looking for beginning of value\n" },
  );
  assert.equal(ghRetryKind(htmlInsteadOfJson), "transient");

  const authFailure = Object.assign(new Error("gh: HTTP 401: Bad credentials"), {
    stderr: "Bad credentials",
  });
  assert.equal(ghRetryKind(authFailure), "none");
  assert.equal(shouldRetryGh(authFailure), false);

  const authFailureForIssue502 = Object.assign(
    new Error("Command failed: gh api repos/openclaw/openclaw/issues/502/comments"),
    { stderr: "gh: HTTP 401: Bad credentials" },
  );
  assert.equal(ghRetryKind(authFailureForIssue502), "none");
});

test("GitHub not found errors are recognizable non-retryable lookup misses", () => {
  const error = new Error(
    "Command failed: gh api repos/openclaw/openclaw/pulls/228\nHTTP 404: Not Found",
  );
  assert.equal(isGitHubNotFoundError(error), true);
  assert.equal(shouldRetryGh(error), false);
});

test("closing pull request references preserve fork repository identity", () => {
  assert.deepEqual(
    closingPullRequestReferenceTarget(
      {
        number: 228,
        repository: {
          owner: { login: "BingqingLyu" },
          name: "openclaw",
        },
      },
      "openclaw/openclaw",
    ),
    { repo: "BingqingLyu/openclaw", number: 228 },
  );
  assert.deepEqual(closingPullRequestReferenceTarget({ number: 40756 }, "openclaw/openclaw"), {
    repo: "openclaw/openclaw",
    number: 40756,
  });
  assert.equal(closingPullRequestReferenceTarget({ number: "228" }, "openclaw/openclaw"), null);
});

test("GitHub requires-authentication write errors are recognizable apply skips", () => {
  const error = Object.assign(
    new Error("Command failed: gh api repos/openclaw/openclaw/issues/74425/comments"),
    {
      stdout:
        '{\n  "message": "Requires authentication",\n  "documentation_url": "https://docs.github.com/rest",\n  "status": "401"\n}',
      stderr: "gh: Requires authentication (HTTP 401)\n",
    },
  );
  assert.equal(isGitHubRequiresAuthenticationError(error), true);
  assert.equal(shouldRetryGh(error), false);
});

test("locked conversation failures are non-retryable but recognizable apply skips", () => {
  const locked = Object.assign(
    new Error("Command failed: gh api repos/openclaw/openclaw/issues/40088/comments"),
    {
      stdout:
        '{"message":"Unable to create comment because issue is locked.","documentation_url":"https://docs.github.com/articles/locking-conversations/","status":"403"}',
      stderr: "gh: Unable to create comment because issue is locked. (HTTP 403)\n",
    },
  );

  assert.equal(ghRetryKind(locked), "none");
  assert.equal(isLockedConversationCommentError(locked), true);
  assert.equal(
    lockedConversationApplyReason({ locked: true, activeLockReason: "resolved" }),
    "conversation is locked (resolved)",
  );
  assert.equal(lockedConversationApplyReason({ locked: false, activeLockReason: null }), null);
});

test("safeOutputTail tolerates missing process output", () => {
  assert.equal(safeOutputTail(undefined), "");
  assert.equal(safeOutputTail(null), "");
  assert.equal(safeOutputTail("abcdef", 3), "def");
});
