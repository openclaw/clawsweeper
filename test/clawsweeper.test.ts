import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
  ghPagedLinkHeaderContextWindow,
  ghPagedContextWindow,
  githubLinkLastPageNumber,
  githubPaginatedPath,
  ghRetryKind,
  hotIntakeRecencyMs,
  isCodexReviewCommentBody,
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
  isMissingGitHubLabelErrorForTest,
  issueAdvisoryLabelsForTest,
  isProtectedItem,
  labelJustificationsMarkdownForTest,
  itemNumbersArg,
  lockedConversationApplyReason,
  makeTreeReadOnlyForTest,
  openClosingPullRequestApplyReason,
  parseGhJson,
  parseGhJsonLines,
  parseDecision,
  mergeRiskLabelsForTest,
  mergeRiskLabelSchemeForTest,
  prRatingLabelsForTest,
  prRatingLabelSchemeForTest,
  prepareMediaProofArtifactsForTest,
  prEggCreatureForTest,
  prEggImagePromptForTest,
  prEggSpriteMetricsForTest,
  proofVideoUrlsFromContextForTest,
  renderPrEggCommentForTest,
  prStatusLabelsForTest,
  prStatusLabelSchemeForTest,
  priorityLabelsForTest,
  priorityLabelSchemeForTest,
  protectedLabels,
  realBehaviorProofMediaLabelsForTest,
  realBehaviorProofSufficientLabelsForTest,
  relatedTitleSearchTerms,
  renderReviewStartStatusComment,
  reviewArtifactDestination,
  reviewAutomationMarkersFromReport,
  reviewActionForDecision,
  reviewPriority,
  reviewPromptForTest,
  renderReviewCommentFromReport,
  renderReviewContextBudgetForTest,
  renderWorkPlanFromReport,
  restoreTreeModesForTest,
  reviewContextLedgerForTest,
  reviewDecisionSchemaText,
  reviewPromptTelemetryForTest,
  reviewPromptTemplate,
  runCodexForTest,
  impactLabelsForTest,
  impactLabelSchemeForTest,
  runtimeBudgetExceeded,
  safeOutputTail,
  sameAuthorCounterpartApplyReason,
  sanitizePublicSelfReferences,
  appendFloorBackfillCandidateNumbersForTest,
  pullRequestFilePathsFromContextForTest,
  selectDueCandidateNumbersForTest,
  shardItemNumbers,
  shouldStopSaturatedPlanScan,
  shouldSyncReviewComment,
  shouldReviewItem,
  shouldRetryGh,
  shouldPlanItem,
  telegramVisibleProofLabelsForTest,
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
import { AUTOMATION_LIMITS } from "../dist/limits.js";

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
    triagePriority: "P2",
    impactLabels: [],
    mergeRiskLabels: [],
    mergeRiskOptions: [],
    labelJustifications: [
      {
        label: "P2",
        reason: "Normal priority applies to this limited-scope implemented behavior check.",
      },
    ],
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
    prRating: {
      proofTier: "NA",
      patchTier: "NA",
      overallTier: "NA",
      summary: "PR readiness rating is not applicable to this issue cleanup decision.",
      nextSteps: [],
    },
    telegramVisibleProof: {
      status: "not_needed",
      summary: "This non-PR issue triage does not need Telegram visible proof.",
    },
    mantisRecommendation: {
      status: "not_recommended",
      scenario: "none",
      reason: "Mantis proof is not useful for this issue triage.",
      maintainerComment: "",
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

test("githubLinkLastPageNumber extracts the final REST page", () => {
  assert.equal(
    githubLinkLastPageNumber(
      '<https://api.github.com/repositories/123/issues/1/timeline?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/123/issues/1/timeline?per_page=100&page=30>; rel="last"',
    ),
    30,
  );
  assert.equal(githubLinkLastPageNumber(undefined), null);
});

test("ghPagedLinkHeaderContextWindow uses GitHub link headers for large timeline tails", () => {
  const fetchedPages: number[] = [];
  const window = ghPagedLinkHeaderContextWindow<number>(
    "repos/openclaw/openclaw/issues/123/timeline",
    80,
    {
      pageWithHeaders: (_path, page) => {
        fetchedPages.push(page);
        const start = (page - 1) * 100 + 1;
        return {
          items: Array.from({ length: 100 }, (_, index) => start + index),
          lastPageNumber: page === 1 ? 30 : null,
        };
      },
      paged: () => {
        throw new Error("full pagination should not be used with link headers");
      },
    },
  );

  assert.deepEqual(fetchedPages, [1, 30]);
  assert.deepEqual(window.items, [
    ...Array.from({ length: 40 }, (_, index) => index + 1),
    ...Array.from({ length: 40 }, (_, index) => index + 2961),
  ]);
  assert.equal(window.total, 3000);
  assert.equal(window.hydrated, 80);
  assert.equal(window.truncated, true);
});

test("ghPagedLinkHeaderContextWindow keeps timeline tails that cross the first page", () => {
  const fetchedPages: number[] = [];
  const window = ghPagedLinkHeaderContextWindow<number>(
    "repos/openclaw/openclaw/issues/123/timeline",
    80,
    {
      pageWithHeaders: (_path, page) => {
        fetchedPages.push(page);
        if (page === 1) {
          return {
            items: Array.from({ length: 100 }, (_, index) => index + 1),
            lastPageNumber: 2,
          };
        }
        return { items: [101], lastPageNumber: null };
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

test("ghPagedLinkHeaderContextWindow falls back when link headers are unavailable", () => {
  const window = ghPagedLinkHeaderContextWindow<number>(
    "repos/openclaw/openclaw/issues/123/timeline",
    80,
    {
      pageWithHeaders: () => ({
        items: Array.from({ length: 100 }, (_, index) => index + 1),
        lastPageNumber: null,
      }),
      paged: () => [1, 2, 3],
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

function prRatingReportSection(overrides = {}) {
  const values = {
    overallTier: "B",
    proofTier: "A",
    patchTier: "B",
    overallLabel: "🐚 platinum hermit",
    proofLabel: "🦞 diamond lobster",
    patchLabel: "🐚 platinum hermit",
    summary: "This PR has strong proof and normal merge-ready implementation quality.",
    nextSteps: "- none",
    ...overrides,
  };
  return `## PR Rating

Overall tier: ${values.overallTier}

Proof tier: ${values.proofTier}

Patch tier: ${values.patchTier}

Overall label: ${values.overallLabel}

Proof label: ${values.proofLabel}

Patch label: ${values.patchLabel}

Summary: ${values.summary}

Next rank-up steps:

${values.nextSteps}
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

test("review context ledger records ordered section budgets", () => {
  const context = {
    issue: { number: 123, title: "Sample PR" },
    comments: [{ author: "alice", body: "Please review this." }],
    timeline: [{ event: "committed", sha: "abc123" }],
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
  assert.doesNotMatch(action.closeComment, /role: recent maintainer/);
  assert.match(action.closeComment, /role: recent area contributor/);
  assert.match(action.closeComment, /Codex review notes: model gpt-5\.5, reasoning high;/);
});

test("review actions render deterministic close comments when model close comment is empty", () => {
  const decision = closeDecision({ closeComment: "" });
  const action = reviewActionForDecision({
    item: item(),
    decision,
    git,
    runtime: { model: "gpt-5.5", reasoningEffort: "high" },
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /Thanks for the context here/);
  assert.match(action.closeComment, /already implemented/);

  const applyValidation = validateCloseDecision(item(), decision);
  assert.equal(applyValidation.ok, false);
  assert.equal(applyValidation.reason, "missing close comment");
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

test("ClawHub policy only allows main-implemented PR close proposals", () => {
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

test("hot new items review daily unless target-side activity requires hourly cadence", () => {
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
    false,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-04-24T00:00:00Z",
        updatedAt: "2026-04-24T00:00:00Z",
      }),
      review("2026-04-25T10:00:00Z", "2026-04-24T00:00:00Z"),
      now,
      "current",
    ),
    true,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-04-24T00:00:00Z",
        updatedAt: "2026-04-26T11:10:00Z",
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
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-03-01T11:12:04Z",
        updatedAt: "2026-04-30T13:04:58Z",
      }),
      { ...review, labelsSyncedAt: "2026-04-30T13:04:59Z" },
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
      { ...review, labelsSyncedAt: "2026-04-30T13:04:59Z" },
      now,
      "current",
    ),
    true,
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

  const mostlyImplementedIssue = validateCloseDecision(
    item({ kind: "issue" }),
    closeDecision({ closeReason: "mostly_implemented_on_main" }),
  );
  assert.equal(mostlyImplementedIssue.ok, false);
  assert.equal(mostlyImplementedIssue.actionTaken, "skipped_invalid_decision");
  assert.equal(
    mostlyImplementedIssue.reason,
    "mostly_implemented_on_main is allowed only for pull requests",
  );

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

  const mostlyImplementedPr = validateCloseDecision(
    item({ kind: "pull_request" }),
    closeDecision({
      closeReason: "mostly_implemented_on_main",
      summary: "Current main implements the useful part of this older PR.",
      closeComment:
        "Closing this older PR because current main already covers the useful change and the remaining branch diff is obsolete.",
    }),
  );
  assert.equal(mostlyImplementedPr.ok, true);
});

test("duplicate or superseded closes are allowed with evidence and comment", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close as duplicate: an older open tracker already covers this.",
      bestSolution:
        "Keep the design thread on https://github.com/openclaw/openclaw/issues/63829, with https://github.com/openclaw/openclaw/pull/67584 as the active implementation path.",
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
  assert.match(
    action.closeComment,
    /Canonical path: Keep the design thread on https:\/\/github\.com\/openclaw\/openclaw\/issues\/63829, with https:\/\/github\.com\/openclaw\/openclaw\/pull\/67584 as the active implementation path\./,
  );
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/63829 and https:\/\/github\.com\/openclaw\/openclaw\/pull\/67584\./,
  );
  assert.ok(
    action.closeComment.indexOf("Canonical path:") <
      action.closeComment.indexOf("<details>\n<summary>Review details</summary>"),
  );
});

test("duplicate or superseded comments surface canonical refs appended to summary text", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close as duplicate: an older tracker already covers this.",
      bestSolution:
        "Close as duplicate: an older tracker already covers this in https://github.com/openclaw/openclaw/issues/63829.",
      evidence: [
        {
          label: "canonical issue",
          detail: "Older tracker exists at https://github.com/openclaw/openclaw/issues/63829.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /Canonical path: Close as duplicate: an older tracker already covers this in https:\/\/github\.com\/openclaw\/openclaw\/issues\/63829\./,
  );
});

test("duplicate or superseded comments prefer canonical refs over generic best solution", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close as duplicate: an older tracker already covers this.",
      bestSolution: "Keep following the canonical issue.",
      evidence: [
        {
          label: "canonical issue",
          detail: "Older tracker exists at https://github.com/openclaw/openclaw/issues/63829.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /Canonical path: Older tracker exists at https:\/\/github\.com\/openclaw\/openclaw\/issues\/63829\./,
  );
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/63829\./,
  );
});

test("duplicate or superseded close sentence surfaces multiple canonical refs", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary:
        "Close as duplicate: the remaining timeout contract work is tracked in canonical timeout threads.",
      bestSolution: "Resolve timeout precedence in the canonical timeout-policy threads.",
      evidence: [
        {
          label: "Canonical provider-timeout issue remains open",
          detail:
            "Live GitHub context for https://github.com/openclaw/openclaw/issues/77744 covers provider timeout behavior.",
        },
        {
          label: "Canonical idle-timeout policy issue remains open",
          detail:
            "Live GitHub context for https://github.com/openclaw/openclaw/issues/78361 covers user-facing idle-timeout precedence.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/77744 and https:\/\/github\.com\/openclaw\/openclaw\/issues\/78361\./,
  );
  assert.ok(
    action.closeComment.indexOf("https://github.com/openclaw/openclaw/issues/77744") <
      action.closeComment.indexOf("<details>\n<summary>Review details</summary>"),
  );
});

test("duplicate or superseded close sentence ignores ambiguous shorthand refs", () => {
  const action = reviewActionForDecision({
    item: item({ number: 123 }),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close #123 as duplicate of PR #456.",
      bestSolution: "Close #123 as duplicate of PR #456.",
      evidence: [
        {
          label: "canonical pull request",
          detail: "PR #456 tracks the same work.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /So I’m closing this here because the remaining work is already tracked in the canonical issue\./,
  );
  assert.doesNotMatch(
    action.closeComment,
    /https:\/\/github\.com\/openclaw\/openclaw\/issues\/123/,
  );
  assert.doesNotMatch(
    action.closeComment,
    /https:\/\/github\.com\/openclaw\/openclaw\/issues\/456/,
  );
});

test("duplicate or superseded close sentence filters current item URLs", () => {
  const action = reviewActionForDecision({
    item: item({ number: 123 }),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close as duplicate of the canonical tracker.",
      bestSolution: "Keep remaining work on https://github.com/openclaw/openclaw/issues/456.",
      evidence: [
        {
          label: "Duplicate report context",
          detail:
            "https://github.com/openclaw/openclaw/issues/123 is the duplicate report being closed.",
        },
        {
          label: "Canonical issue",
          detail: "https://github.com/openclaw/openclaw/issues/456 tracks the same work.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/456\./,
  );
  assert.doesNotMatch(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/123/,
  );
});

test("duplicate or superseded reference extraction ignores repeated malformed GitHub URLs", () => {
  const repeatedMalformedUrl = Array.from({ length: 100 }, () => "https://github.com/").join("");
  const action = reviewActionForDecision({
    item: item({ number: 123 }),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: `Close as duplicate after checking ${repeatedMalformedUrl}.`,
      bestSolution: "Keep remaining work on https://github.com/openclaw/openclaw/issues/456.",
      evidence: [
        {
          label: "Malformed URL noise",
          detail: repeatedMalformedUrl,
        },
        {
          label: "Canonical issue",
          detail: "https://github.com/openclaw/openclaw/issues/456 tracks the same work.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/456\./,
  );
});

test("duplicate or superseded close sentence includes duplicate-labeled canonical URL", () => {
  const action = reviewActionForDecision({
    item: item({ number: 123 }),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close as duplicate of the older tracker.",
      bestSolution: "Follow the linked duplicate tracker.",
      evidence: [
        {
          label: "Duplicate issue",
          detail: "https://github.com/openclaw/openclaw/issues/456 is the older open tracker.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/456\./,
  );
});

test("apply close reason filters support exact fast-close lanes", () => {
  assert.equal(closeReasonsArg("all"), null);
  assert.deepEqual([...closeReasonsArg("implemented_on_main, duplicate_or_superseded")].sort(), [
    "duplicate_or_superseded",
    "implemented_on_main",
  ]);
  assert.throws(() => closeReasonsArg("stale"), /Invalid apply close reason: stale/);
});

test("stale and mostly-implemented closes require older items while implemented closes can be immediate", () => {
  const now = Date.parse("2026-04-28T12:00:00Z");
  const freshItem = item({ createdAt: "2026-04-28T11:59:00Z" });
  const oldItem = item({ createdAt: "2026-01-01T00:00:00Z" });

  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "implemented_on_main", {
      minAgeMs: 0,
      minAgeDescription: "0 minutes",
      staleMinAgeDays: 60,
      now,
    }),
    null,
  );
  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "duplicate_or_superseded", {
      minAgeMs: 5 * 60 * 1000,
      minAgeDescription: "5 minutes",
      staleMinAgeDays: 60,
      now,
    }),
    "created less than or equal to 5 minutes ago",
  );
  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "stale_insufficient_info", {
      minAgeMs: 0,
      minAgeDescription: "0 minutes",
      staleMinAgeDays: 60,
      now,
    }),
    "stale_insufficient_info requires item older than 60 days",
  );
  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "mostly_implemented_on_main", {
      minAgeMs: 0,
      minAgeDescription: "0 minutes",
      staleMinAgeDays: 60,
      now,
    }),
    "mostly_implemented_on_main requires item older than 60 days",
  );
  assert.equal(
    closeReasonApplyAgeSkipReason(oldItem, "mostly_implemented_on_main", {
      minAgeMs: 0,
      minAgeDescription: "0 minutes",
      staleMinAgeDays: 60,
      now,
    }),
    null,
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
    /\*\*Workflow note:\*\* Future ClawSweeper reviews update this same comment in place\./,
  );
  assert.match(comment, /<summary>How this review workflow works<\/summary>/);
  assert.match(
    comment,
    /- Re-runs edit this comment so the latest verdict, findings, and automation markers stay together instead of adding duplicate bot comments\./,
  );
  assert.match(
    comment,
    /- A fresh review can be triggered by eligible `@clawsweeper re-review` comments, exact-item GitHub events, scheduled\/background review runs, or manual workflow dispatch\./,
  );
  assert.match(
    comment,
    /- PR\/issue authors and users with repository write access can comment `@clawsweeper re-review` or `@clawsweeper re-run` on an open PR or issue to request a fresh review only\./,
  );
  assert.match(
    comment,
    /- Maintainers can also comment `@clawsweeper review` to request a fresh review only\./,
  );
  assert.match(
    comment,
    /- Fresh-review commands do not start repair, autofix, rebase, CI repair, or automerge\./,
  );
  assert.match(
    comment,
    /- Maintainer-only repair and merge flows require explicit commands such as `@clawsweeper autofix`, `@clawsweeper automerge`, `@clawsweeper fix ci`, or `@clawsweeper address review`\./,
  );
  assert.match(
    comment,
    /- Maintainers can comment `@clawsweeper explain` to ask for more context, or `@clawsweeper stop` to stop active automation\./,
  );
  assert.match(
    comment,
    /ℹ️ \*\*INFO\*\* \*\*Summary\*\* \*\*Review the changed behavior\*\*\n\nAdds regression coverage for session-scoped model overrides\./,
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
    /ℹ️ \*\*INFO\*\* \*\*Summary\*\* \*\*Review the reported behavior\*\*\n\nKeep open\. Slack typing callbacks are disabled in message-tool-only group replies\.\n\nReproducibility: yes\. A source-level reproduction is clear/,
  );
  assert.ok(comment.indexOf("Reproducibility: yes.") < comment.indexOf("**Next step**"));
  assert.doesNotMatch(comment, /\*\*Ways to help us reproduce this\*\*/);
  assert.doesNotMatch(comment, /\*\*Security\*\*/);
  assert.doesNotMatch(comment, /Not applicable:/);
  assert.match(
    comment,
    /Do we have a high-confidence way to reproduce the issue\?\n\nYes\. A source-level reproduction is clear/,
  );
});

test("issue keep-open review comments suggest concrete reproduction help", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "issue",
      number: "75878",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "manual_review",
      reproduction_status: "unclear",
      reproduction_confidence: "low",
    })}

## Summary

Keep open. The app sometimes does the wrong thing.

## Reproduction Assessment

Unclear. The report describes an intermittent visible failure but does not include enough information to reproduce it.

## Best Possible Solution

Ask for enough details to reproduce the issue before planning a fix.
`,
    "none",
  );

  assert.match(comment, /\*\*Ways to help us reproduce this\*\*/);
  assert.match(comment, /- Add a screenshot or short recording showing the behavior\./);
  assert.match(comment, /- Include the exact command, prompt, or workflow that triggered it\./);
  assert.match(comment, /- Add expected vs actual behavior\./);
  assert.ok(
    comment.indexOf("**Ways to help us reproduce this**") < comment.indexOf("**Next step**"),
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
  assert.doesNotMatch(comment, /recent workflow maintainer/);
  assert.match(comment, /recent workflow contributor/);
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
    /\*\*Workflow note:\*\* Future ClawSweeper reviews update this same comment in place\./,
  );
  assert.match(
    comment,
    /🚨 \*\*P1\*\* \*\*Review findings\*\* \*\*Address the highest-signal findings\*\*[\s\S]*- \[P1\] Validate replace paths — `src\/config\/apply\.ts:42-44`/,
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
    /ℹ️ \*\*INFO\*\* \*\*Next step before merge\*\* \*\*Take the next merge decision\*\*\n\nLand this docs-only PR after maintainer review\./,
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
  assert.match(
    comment,
    /✅ \*\*DONE\*\* \*\*Next step before merge\*\* \*\*Take the next merge decision\*\*\n\nMerge after required checks are green\./,
  );
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

  const comment = renderReviewCommentFromReport(report, "none", {
    prStatusKind: "ready_for_maintainer_look",
  });
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /✅ \*\*DONE\*\* \*\*PR rating\*\*/);
  assert.match(
    comment,
    /Overall 🦞 diamond lobster with proof 🦞 diamond lobster and patch quality 🦞 diamond lobster\./,
  );
  assert.match(comment, /<summary>What the crustacean ranks mean<\/summary>/);
  assert.match(comment, /🧂 unranked krab: not merge-ready/);
  assert.match(
    comment,
    /✅ \*\*DONE\*\* \*\*Real behavior proof\*\* \*\*Assess whether proof is merge-ready\*\*\n\nSufficient \(terminal\):/,
  );
  assert.match(markers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:needs-human/);
});

test("public PR review comments explain label changes without duplicate justifications", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74461",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    triage_priority: "P1",
    impact_labels: JSON.stringify(["impact:message-loss"]),
    merge_risk_labels: JSON.stringify(["merge-risk: 🚨 compatibility"]),
    label_justifications: JSON.stringify([
      {
        label: "P1",
        reason: "The PR changes an active channel workflow affecting real users.",
      },
      {
        label: "impact:message-loss",
        reason: "The diff touches message retry and delivery ordering.",
      },
      {
        label: "merge-risk: 🚨 compatibility",
        reason: "Merging changes the default upgrade behavior for existing configs.",
      },
    ]),
  })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Changes message delivery behavior.

## Best Possible Solution

Review the compatibility impact before merge.

## Risks

Compatibility risk remains for existing configs.

${realBehaviorProofReportSection({
  status: "insufficient",
  needsContributorAction: true,
  summary: "The PR has tests but no real setup proof yet.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.8

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");

  assert.match(comment, /<details>\n<summary>Review details<\/summary>/);
  assert.match(comment, /Label changes:/);
  assert.match(
    comment,
    /- add `P1`: The PR changes an active channel workflow affecting real users\./,
  );
  assert.match(
    comment,
    /- add `merge-risk: 🚨 compatibility`: Merging changes the default upgrade behavior for existing configs\./,
  );
  assert.match(comment, /Label justifications:/);
  assert.match(comment, /- `P1`: The PR changes an active channel workflow affecting real users\./);
  assert.match(
    comment,
    /- `impact:message-loss`: The diff touches message retry and delivery ordering\./,
  );
});

test("public PR review details justify derived rating label changes", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "84006",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["rating: 🦞 diamond lobster"]),
    work_candidate: "none",
    triage_priority: "none",
    impact_labels: JSON.stringify([]),
    merge_risk_labels: JSON.stringify([]),
    label_justifications: JSON.stringify([]),
  })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Changes a PR under active review.

## Best Possible Solution

Add proof before merge.

${realBehaviorProofReportSection({
  status: "insufficient",
  needsContributorAction: true,
  summary: "The PR still needs current real-environment proof for the changed behavior.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");

  assert.match(comment, /Label changes:/);
  assert.match(
    comment,
    /- add `rating: 🦪 silver shellfish`: Current PR rating is 🦪 silver shellfish because proof is 🦪 silver shellfish, patch quality is 🦞 diamond lobster, and PR readiness rating was derived from proof quality, review findings, security review, and reviewer confidence\./,
  );
  assert.match(
    comment,
    /- remove `rating: 🦞 diamond lobster`: Current PR rating is `rating: 🦪 silver shellfish`, so this older rating label is no longer current\./,
  );
  assert.match(comment, /Label justifications:/);
  assert.match(
    comment,
    /- `rating: 🦪 silver shellfish`: Current PR rating is 🦪 silver shellfish because proof is 🦪 silver shellfish, patch quality is 🦞 diamond lobster, and PR readiness rating was derived from proof quality, review findings, security review, and reviewer confidence\. Replaced prior `rating: 🦞 diamond lobster`\./,
  );
});

test("public PR review details justify stale owned label removals", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "84007",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["status: 📣 needs proof"]),
    work_candidate: "none",
    triage_priority: "none",
    impact_labels: JSON.stringify([]),
    merge_risk_labels: JSON.stringify([]),
    label_justifications: JSON.stringify([]),
  })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Updates an already-reviewed PR.

## Best Possible Solution

Add current real behavior proof before merge.

${realBehaviorProofReportSection({
  status: "insufficient",
  evidenceKind: "none",
  needsContributorAction: true,
  summary: "The current review has no usable real behavior proof.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none", {
    prStatusKind: "needs_proof",
    previousLabels: [
      "P1",
      "impact:message-loss",
      "merge-risk: 🚨 compatibility",
      "proof: sufficient",
      "proof: 🎥 video",
      "mantis: telegram-visible-proof",
      "status: 📣 needs proof",
    ],
  });

  assert.match(comment, /Label changes:/);
  assert.match(comment, /- remove `P1`: Current review triage priority is none\./);
  assert.match(
    comment,
    /- remove `impact:message-loss`: Current review selected no impact labels\./,
  );
  assert.match(
    comment,
    /- remove `merge-risk: 🚨 compatibility`: Current PR review selected no merge-risk labels\./,
  );
  assert.match(
    comment,
    /- remove `proof: sufficient`: Current real behavior proof status is insufficient, not sufficient\./,
  );
  assert.match(
    comment,
    /- remove `proof: 🎥 video`: Current real behavior proof evidence kind is none\./,
  );
  assert.match(
    comment,
    /- remove `mantis: telegram-visible-proof`: Current Telegram visible-proof status is not_needed\./,
  );
  assert.doesNotMatch(comment, /remove `status: 📣 needs proof`/);
});

test("media proof receives a shiny proof rating boost", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74460",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
  })}

## Summary

Keep this focused PR open.

## What This Changes

Fixes a visible UI behavior.

## Best Possible Solution

Merge after maintainer review.

${realBehaviorProofReportSection({
  evidenceKind: "recording",
  summary: "The PR includes a short recording from a real setup showing the fixed UI behavior.",
})}

${prRatingReportSection({
  overallTier: "S",
  proofTier: "S",
  patchTier: "S",
  overallLabel: "🦀 challenger crab",
  proofLabel: "🦀 challenger crab ✨",
  patchLabel: "🦀 challenger crab",
  summary: "The PR has direct media proof and a clean, high-confidence patch.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.98

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");

  assert.match(comment, /ℹ️ \*\*INFO\*\* \*\*PR rating\*\*/);
  assert.match(
    comment,
    /Overall 🦀 challenger crab with proof 🦀 challenger crab ✨ media proof bonus and patch quality 🦀 challenger crab\./,
  );
  assert.match(comment, /Shiny media proof means a screenshot, video, or linked artifact/);
  assert.doesNotMatch(comment, /Rank-up moves:/);
});

test("pull request review comments omit PR egg while egg comment teases until proof passes", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74470",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this PR open until proof is added.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Add proof and re-review.

${realBehaviorProofReportSection({
  status: "missing",
  evidenceKind: "none",
  needsContributorAction: true,
  summary: "The PR has no real behavior proof yet.",
})}

${prRatingReportSection({
  overallTier: "F",
  proofTier: "F",
  patchTier: "B",
  overallLabel: "🧂 unranked krab",
  proofLabel: "🧂 unranked krab",
  patchLabel: "🐚 platinum hermit",
  summary: "Proof is missing, so this PR is not ready yet.",
  nextSteps: "- Add after-fix proof from a real setup.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const eggComment = renderPrEggCommentForTest(74470, report);

  assert.doesNotMatch(comment, /\*\*PR egg\*\*/);
  assert.match(comment, /\*\*Real behavior proof\*\*/);
  assert.match(eggComment, /ClawSweeper PR egg/);
  assert.match(eggComment, /🎁 Pass real behavior proof/);
  assert.match(eggComment, /wake the egg and unlock a hatchable treat/);
  assert.match(eggComment, /<summary>Where did the egg go\?<\/summary>/);
  assert.match(eggComment, /no creature or rarity is rolled/);
  assert.doesNotMatch(eggComment, /```text/);
  assert.doesNotMatch(eggComment, /🔥 Warming up:/);
  assert.doesNotMatch(eggComment, /✨ Hatched:/);
  assert.doesNotMatch(eggComment, /Share on X:/);
});

test("PR egg comment renders warming PR egg from active status after proof passes", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74470",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this PR open until the follow-up is resolved.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Resolve the remaining review follow-up.

${realBehaviorProofReportSection({
  status: "sufficient",
  evidenceKind: "terminal",
  needsContributorAction: false,
  summary: "The PR includes terminal output from a real setup.",
})}

${prRatingReportSection({
  overallTier: "B",
  proofTier: "A",
  patchTier: "B",
  overallLabel: "🐚 platinum hermit",
  proofLabel: "🦀 challenger crab",
  patchLabel: "🐚 platinum hermit",
  summary: "Proof is present, but one follow-up remains.",
  nextSteps: "- Add after-fix validation output from the changed path.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none", {
    prStatusKind: "actively_grinding",
  });
  const eggComment = renderPrEggCommentForTest(74470, report, "actively_grinding");

  assert.doesNotMatch(comment, /\*\*PR egg\*\*/);
  assert.match(eggComment, /ClawSweeper PR egg/);
  assert.match(
    eggComment,
    /🔥 Warming up: real-behavior proof passed; findings, security review, or rank-up moves are still in progress\./,
  );
  assert.doesNotMatch(eggComment, /```text/);
  assert.match(eggComment, /<summary>What is this egg doing here\?<\/summary>/);
  assert.match(eggComment, /Eggs appear after the PR passes real-behavior proof/);
  assert.match(eggComment, /It is here for vibes, not verdicts/);
  assert.match(
    eggComment,
    /🔥 Warming up:[\s\S]+### Hatch command[\s\S]+Hatchability rules:[\s\S]+- Merged PRs are hatchable\.[\s\S]+- Open PRs are hatchable when they are `status: 👀 ready for maintainer look`, `status: 🚀 automerge armed`, or labeled `clawsweeper:automerge`\.[\s\S]+- Closed unmerged PRs are hatchable only when one of those hatchable labels is still present in the durable record\./,
  );
  assert.match(
    eggComment,
    /Hatchability usually comes from sufficient real-behavior proof, no blocking P0\/P1\/P2 findings/,
  );
  assert.match(eggComment, /no security attention needed, and clean correctness/);
  assert.match(eggComment, /Comment `@clawsweeper hatch` when this PR is/);
  assert.match(eggComment, /🥚 common, 🌱 uncommon, 💎 rare, ✨ glimmer, and 🌈 legendary/);
  assert.doesNotMatch(eggComment, /🎁 Pass real behavior proof/);
  assert.doesNotMatch(eggComment, /proof, findings, or rank-up moves are still in progress/);
  assert.doesNotMatch(eggComment, /✨ Hatched:/);
  assert.doesNotMatch(eggComment, /Share on X:/);
});

test("PR egg comment hatches deterministic collectible PR egg", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74471",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["protected: maintainer-authored"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
    review_comment_url: "https://github.com/openclaw/openclaw/pull/74471#issuecomment-987654321",
  })}

## Summary

Keep this clean PR open for maintainer review.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Merge after maintainer review.

${realBehaviorProofReportSection()}

${prRatingReportSection({
  overallTier: "B",
  proofTier: "A",
  patchTier: "B",
  summary: "This PR has strong proof and normal merge-ready implementation quality.",
  nextSteps: "",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const reviewComment = renderReviewCommentFromReport(report, "none", {
    prStatusKind: "ready_for_maintainer_look",
  });
  const first = renderPrEggCommentForTest(74471, report, "ready_for_maintainer_look");
  const second = renderPrEggCommentForTest(74471, report, "ready_for_maintainer_look");

  assert.doesNotMatch(reviewComment, /\*\*PR egg\*\*/);
  assert.match(first, /ClawSweeper PR egg/);
  assert.match(first, /✨ Hatched: [^\n]+/);
  assert.doesNotMatch(first, /```text/);
  assert.match(first, /### Hatch command/);
  assert.match(first, /Rarity: [^\n]+\./);
  assert.match(first, /Trait: [^.]+\./);
  assert.match(
    first,
    /Image traits: location [^;]+; accessory [^;]+; palette [^;]+; mood [^;]+; pose [^;]+; shell [^;]+; lighting [^;]+; background [^.]+\./,
  );
  assert.match(
    first,
    /Share on X: \[post this hatch\]\(https:\/\/x\.com\/intent\/tweet\?text=[^)]+&url=https%3A%2F%2Fgithub\.com%2Fopenclaw%2Fopenclaw%2Fpull%2F74471%23issuecomment-987654321\)/,
  );
  assert.match(first, /Copy: My PR egg hatched a [^\n]+ in ClawSweeper\./);
  assert.match(
    first,
    /### Hatch command[\s\S]+Merged PRs are hatchable\.[\s\S]+Closed unmerged PRs are hatchable only when one of those hatchable labels is still present in the durable record\.[\s\S]+Rarity:/,
  );
  assert.match(first, /same PR keeps the same creature/);
  assert.equal(first, second);
});

test("PR egg hatch identity stays stable across reviewed PR revisions", () => {
  const reportForHead = (headSha: string) => `${reportFrontMatter({
    type: "pull_request",
    number: "74471",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["protected: maintainer-authored"]),
    work_candidate: "none",
    pull_head_sha: headSha,
  })}

## Summary

Keep this clean PR open for maintainer review.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Merge after maintainer review.

${realBehaviorProofReportSection()}

${prRatingReportSection({
  overallTier: "B",
  proofTier: "A",
  patchTier: "B",
  summary: "This PR has strong proof and normal merge-ready implementation quality.",
  nextSteps: "",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const first = renderPrEggCommentForTest(
    74471,
    reportForHead("abc123def456"),
    "ready_for_maintainer_look",
  );
  const second = renderPrEggCommentForTest(
    74471,
    reportForHead("def456abc123"),
    "ready_for_maintainer_look",
  );

  assert.equal(first.match(/✨ Hatched: [^\n]+/)?.[0], second.match(/✨ Hatched: [^\n]+/)?.[0]);
  assert.equal(first.match(/Rarity: [^\n]+/)?.[0], second.match(/Rarity: [^\n]+/)?.[0]);
  assert.equal(first.match(/Trait: [^\n]+/)?.[0], second.match(/Trait: [^\n]+/)?.[0]);
  assert.equal(first.match(/Image traits: [^\n]+/)?.[0], second.match(/Image traits: [^\n]+/)?.[0]);
  assert.equal(first.match(/Copy: [^\n]+/)?.[0], second.match(/Copy: [^\n]+/)?.[0]);
  assert.match(first, /same PR keeps the same creature/);
});

test("PR egg creature exposes deterministic image traits", () => {
  const first = prEggCreatureForTest("openclaw/openclaw#74471", "openclaw/openclaw#74471@abc123");
  const second = prEggCreatureForTest("openclaw/openclaw#74471", "openclaw/openclaw#74471@def456");

  assert.deepEqual(first.imageTraits, second.imageTraits);
  assert.deepEqual(Object.keys(first.imageTraits).sort(), [
    "accessory",
    "backgroundDetail",
    "lighting",
    "location",
    "mood",
    "palette",
    "pose",
    "texture",
  ]);
  for (const value of Object.values(first.imageTraits)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0);
  }
});

test("PR egg image prompt uses deterministic hatch traits with badge constraints", () => {
  const prompt = prEggImagePromptForTest(
    "openclaw/openclaw#74471",
    "openclaw/openclaw#74471@abc123",
  );

  assert.match(prompt, /square collectible mascot badge/);
  assert.match(prompt, /GitHub pull request hatch/);
  assert.match(prompt, /Scene location:/);
  assert.match(prompt, /Accessory:/);
  assert.match(prompt, /Palette:/);
  assert.match(prompt, /displayed at 256x256/);
  assert.match(prompt, /no text, no letters, no numbers, no logos/);
});

test("hatched PR egg embeds durable image URL above hatch metadata", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74476",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
    pr_egg_image_url:
      "https://raw.githubusercontent.com/openclaw/clawsweeper-state/state/assets/pr-eggs/openclaw-openclaw/74476.png",
  })}

## Summary

Keep this clean PR open for maintainer review.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Merge after maintainer review.

${realBehaviorProofReportSection()}

${prRatingReportSection({
  overallTier: "B",
  proofTier: "A",
  patchTier: "B",
  summary: "This PR has strong proof and normal merge-ready implementation quality.",
  nextSteps: "",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none", {
    prStatusKind: "ready_for_maintainer_look",
  });
  const eggComment = renderPrEggCommentForTest(74476, report, "ready_for_maintainer_look");

  assert.doesNotMatch(comment, /\*\*PR egg\*\*/);
  assert.match(
    eggComment,
    /<img src="https:\/\/raw\.githubusercontent\.com\/openclaw\/clawsweeper-state\/state\/assets\/pr-eggs\/openclaw-openclaw\/74476\.png" width="256" height="256" alt="Hatched PR egg: [^"]+">/,
  );
  assert.doesNotMatch(eggComment, /```text/);
  assert.ok(eggComment.indexOf("<img ") < eggComment.indexOf("### Hatch command"));
});

test("PR egg share link falls back to PR URL before durable comment metadata exists", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74474",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this clean PR open for maintainer review.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Merge after maintainer review.

${realBehaviorProofReportSection()}

${prRatingReportSection({
  overallTier: "B",
  proofTier: "A",
  patchTier: "B",
  summary: "This PR has strong proof and normal merge-ready implementation quality.",
  nextSteps: "",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none", {
    prStatusKind: "ready_for_maintainer_look",
  });
  const eggComment = renderPrEggCommentForTest(74474, report, "ready_for_maintainer_look");

  assert.doesNotMatch(comment, /\*\*PR egg\*\*/);
  assert.match(
    eggComment,
    /Share on X: \[post this hatch\]\(https:\/\/x\.com\/intent\/tweet\?text=[^)]+&url=https%3A%2F%2Fgithub\.com%2Fopenclaw%2Fopenclaw%2Fpull%2F74474\)/,
  );
});

test("PR egg hatches from ready status despite non-contributor rank-up sentinels", () => {
  const reportForNextSteps = (nextSteps: string) => `${reportFrontMatter({
    type: "pull_request",
    number: "83606",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this proof-sufficient PR open for maintainer review.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Merge after maintainer review.

${realBehaviorProofReportSection()}

${prRatingReportSection({
  overallTier: "B",
  proofTier: "A",
  patchTier: "B",
  summary: "This PR has strong proof and normal merge-ready implementation quality.",
  nextSteps,
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  for (const nextSteps of [
    "- none",
    "- n/a",
    "- Maintainer accepts the relative details.reportPath contract change before merge.",
  ]) {
    const comment = renderReviewCommentFromReport(reportForNextSteps(nextSteps), "none", {
      prStatusKind: "ready_for_maintainer_look",
    });
    const eggComment = renderPrEggCommentForTest(
      83606,
      reportForNextSteps(nextSteps),
      "ready_for_maintainer_look",
    );

    assert.doesNotMatch(comment, /\*\*PR egg\*\*/);
    assert.match(eggComment, /✨ Hatched: [^\n]+/);
    assert.doesNotMatch(eggComment, /🔥 Warming up:/);
  }
});

test("PR egg hatches from ready status label when explicit status signal is absent", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "83632",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["proof: sufficient", "status: 👀 ready for maintainer look"]),
    work_candidate: "none",
    pull_head_sha: "27d246732015a4ea4fc48dd828c121857f1e5124",
    review_comment_url: "https://github.com/openclaw/openclaw/pull/83632#issuecomment-4478578658",
  })}

## Summary

Focused patch with proof and maintainer-facing follow-up decisions.

## What This Changes

Improves Telegram proof capture.

## Best Possible Solution

Merge after maintainer review.

${realBehaviorProofReportSection({
  status: "sufficient",
  evidenceKind: "terminal",
  needsContributorAction: false,
  summary: "The PR includes terminal output from a real setup.",
})}

${prRatingReportSection({
  overallTier: "A",
  proofTier: "A",
  patchTier: "A",
  overallLabel: "🐚 platinum hermit",
  proofLabel: "🐚 platinum hermit",
  patchLabel: "🐚 platinum hermit",
  summary: "Proof is present, with maintainer policy decisions remaining.",
  nextSteps: [
    "- Decide whether `guest.enabled` should remain `auto` by default or require explicit opt-in.",
    "- If keeping auto, add or run upgrade-safety proof for omitted guest config and account allowlist combinations.",
  ].join("\n"),
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const eggComment = renderPrEggCommentForTest(83632, report);

  assert.doesNotMatch(comment, /\*\*PR egg\*\*/);
  assert.match(eggComment, /✨ Hatched: [^\n]+/);
  assert.match(eggComment, /Rarity: [^\n]+\./);
  assert.match(
    eggComment,
    /Share on X: \[post this hatch\]\(https:\/\/x\.com\/intent\/tweet\?text=[^)]+&url=https%3A%2F%2Fgithub\.com%2Fopenclaw%2Fopenclaw%2Fpull%2F83632%23issuecomment-4478578658\)/,
  );
  assert.doesNotMatch(eggComment, /🔥 Warming up:/);
});

test("PR egg lifecycle follows the current PR status signal", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74475",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this PR open for status-driven egg rendering.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Follow the current PR status.

${realBehaviorProofReportSection({
  status: "sufficient",
  evidenceKind: "terminal",
  needsContributorAction: false,
  summary: "The PR includes terminal output from a real setup.",
})}

${prRatingReportSection({
  overallTier: "B",
  proofTier: "A",
  patchTier: "B",
  summary: "Proof is present; lifecycle is status-driven.",
  nextSteps: "",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const cases = [
    ["automerge_armed", /✨ Hatched:/],
    ["ready_for_maintainer_look", /✨ Hatched:/],
    ["re_review_loop", /🔁 Wobbling:/],
    [
      "actively_grinding",
      /🔥 Warming up: real-behavior proof passed; findings, security review, or rank-up moves are still in progress\./,
    ],
    [
      "waiting_on_author",
      /🔥 Warming up: real-behavior proof passed; findings, security review, or rank-up moves are still in progress\./,
    ],
    [
      "needs_proof",
      /🔥 Warming up: real-behavior proof passed; findings, security review, or rank-up moves are still in progress\./,
    ],
    [null, /🥚 Incubating:/],
  ] as const;

  for (const [prStatusKind, expected] of cases) {
    const reviewComment = renderReviewCommentFromReport(report, "none", { prStatusKind });
    const eggComment = renderPrEggCommentForTest(74475, report, prStatusKind);
    assert.doesNotMatch(reviewComment, /\*\*PR egg\*\*/);
    assert.match(eggComment, expected);
  }
});

test("PR egg wobbling follows current re-review status signal", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74473",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this PR open during the requested re-review loop.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Re-review the latest author update.

${realBehaviorProofReportSection({
  status: "sufficient",
  evidenceKind: "terminal",
  needsContributorAction: false,
  summary: "The PR includes terminal output from a real setup.",
})}

${prRatingReportSection({
  overallTier: "B",
  proofTier: "A",
  patchTier: "B",
  overallLabel: "🐚 platinum hermit",
  proofLabel: "🦀 challenger crab",
  patchLabel: "🐚 platinum hermit",
  summary: "Proof is present, but one follow-up remains.",
  nextSteps: "- Wait for the requested re-review result.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  assert.match(renderPrEggCommentForTest(74473, report, "re_review_loop"), /🔁 Wobbling:/);
  assert.doesNotMatch(
    renderReviewCommentFromReport(report, "none", { prStatusKind: "re_review_loop" }),
    /\*\*PR egg\*\*/,
  );
  assert.match(renderPrEggCommentForTest(74473, report), /🥚 Incubating:/);
});

test("issues do not render PR egg game", () => {
  const report = `${reportFrontMatter({
    type: "issue",
    number: "74472",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "medium",
    work_candidate: "none",
  })}

## Summary

Keep this issue open for more reproduction detail.

## Best Possible Solution

Ask for reproduction details.
`;

  const comment = renderReviewCommentFromReport(report, "none");

  assert.doesNotMatch(comment, /\*\*PR egg\*\*/);
});

test("PR egg creature generation exposes emoji rarity collectibles", () => {
  const stable = prEggCreatureForTest("openclaw/openclaw#74471@abc123def456");
  assert.deepEqual(stable, prEggCreatureForTest("openclaw/openclaw#74471@abc123def456"));
  assert.match(stable.rarityLabel, /^(🥚 common|🌱 uncommon|💎 rare|✨ glimmer|🌈 legendary)$/);

  let glimmerOrLegendary: ReturnType<typeof prEggCreatureForTest> | null = null;
  for (let index = 0; index < 50000; index += 1) {
    const candidate = prEggCreatureForTest(`rarity-seed-${index}`);
    if (candidate.rarity === "glimmer" || candidate.rarity === "legendary") {
      glimmerOrLegendary = candidate;
      break;
    }
  }

  assert.ok(glimmerOrLegendary);
  assert.match(glimmerOrLegendary.rarityLabel, /^(✨ glimmer|🌈 legendary)$/);
  assert.match(glimmerOrLegendary.shareText, /^My PR egg hatched a .+ in ClawSweeper\.$/);
});

test("PR egg ASCII sprites render fixed-width deterministic silhouettes", () => {
  const first = prEggSpriteMetricsForTest("openclaw/openclaw#74471@abc123def456");
  const second = prEggSpriteMetricsForTest("openclaw/openclaw#74471@abc123def456");
  const other = prEggSpriteMetricsForTest("openclaw/openclaw#74471@def456abc123");

  assert.deepEqual(first, second);
  assert.equal(first.lines.length, 12);
  assert.equal(first.width, 29);
  assert.ok(first.lines.some((line) => /[^\s]/.test(line)));
  for (const line of first.lines) {
    assert.equal(line.length, first.width);
    assert.doesNotMatch(line, /[\p{Extended_Pictographic}]/u);
    assert.match(line, /\S/, "sprite lines should stay visually dense");
  }
  assert.ok(
    first.lines.some((line, index) => line !== other.lines[index]),
    "different head SHAs should alter at least one composed sprite layer",
  );
});

test("docs-only external PRs do not require real behavior proof", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74462",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
    pull_files: JSON.stringify(["docs/usage.md", "docs/plugins/building-plugins.md"]),
    pull_files_truncated: false,
  })}

## Summary

Keep this docs-only PR open for automerge.

## What This Changes

Clarifies plugin docs.

## Best Possible Solution

Merge after required checks are green.

${realBehaviorProofReportSection({
  status: "missing",
  evidenceKind: "none",
  needsContributorAction: true,
  summary: "The PR body does not include after-fix evidence from a real setup.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(
    comment,
    /✅ \*\*DONE\*\* \*\*Real behavior proof\*\* \*\*Assess whether proof is merge-ready\*\*\n\nNot applicable:/,
  );
  assert.match(comment, /only changes files under docs\//);
  assert.match(markers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:needs-human/);
});

test("renamed source paths remain part of docs-only proof checks", () => {
  assert.deepEqual(
    pullRequestFilePathsFromContextForTest({
      pullFiles: [
        {
          filename: "docs/runtime.md",
          previous_filename: "src/runtime.ts",
          status: "renamed",
        },
      ],
    }),
    ["docs/runtime.md", "src/runtime.ts"],
  );
});

test("mixed docs and source external PRs still require real behavior proof", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74463",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
    pull_files: JSON.stringify(["docs/usage.md", "src/runtime.ts"]),
    pull_files_truncated: false,
  })}

## Summary

Keep this PR open until the contributor proves the fix in a real setup.

## What This Changes

Changes runtime behavior and docs.

## Best Possible Solution

Ask the contributor to add after-fix proof from their real setup.

${realBehaviorProofReportSection({
  status: "missing",
  evidenceKind: "none",
  needsContributorAction: true,
  summary: "The PR body does not include after-fix evidence from a real setup.",
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
  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
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
    /✅ \*\*DONE\*\* \*\*Next step before merge\*\* \*\*Take the next merge decision\*\*\n\nLeave this draft open after fixes are complete\./,
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

function markedReviewCommentForTest(number: number, body: string): string {
  return `${body.trimEnd()}\n\n<!-- clawsweeper-review item=${number} -->`;
}

function sha256ForTest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function reportWithSyncedReviewComment(
  report: string,
  number: number,
  reason = "none",
): {
  report: string;
  comment: string;
} {
  const comment = markedReviewCommentForTest(number, renderReviewCommentFromReport(report, reason));
  return {
    report: report.replace(
      /^---\n/,
      [
        "---",
        `review_comment_sha256: ${sha256ForTest(comment)}`,
        `review_comment_id: ${9000 + number}`,
        `review_comment_url: https://github.com/openclaw/clawsweeper/issues/${number}#issuecomment-${9000 + number}`,
        "review_comment_synced_at: 2026-05-01T01:00:00Z",
        "",
      ].join("\n"),
    ),
    comment,
  };
}

function withMockGh(root: string, script: string, run: () => void): void {
  const originalGhBin = process.env.GH_BIN;
  const originalGhBinArgs = process.env.GH_BIN_ARGS;
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const ghPath = join(binDir, "gh.js");
  writeFileSync(ghPath, script, { mode: 0o755 });
  try {
    process.env.GH_BIN = process.execPath;
    process.env.GH_BIN_ARGS = JSON.stringify([ghPath]);
    run();
  } finally {
    if (originalGhBin === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = originalGhBin;
    if (originalGhBinArgs === undefined) delete process.env.GH_BIN_ARGS;
    else process.env.GH_BIN_ARGS = originalGhBinArgs;
  }
}

function runApplyDecisionsForTest(options: {
  itemsDir: string;
  closedDir: string;
  plansDir: string;
  reportPath: string;
  extraArgs?: string[];
}): void {
  execFileSync(process.execPath, [
    "dist/clawsweeper.js",
    "apply-decisions",
    "--target-repo",
    "openclaw/clawsweeper",
    "--items-dir",
    options.itemsDir,
    "--closed-dir",
    options.closedDir,
    "--plans-dir",
    options.plansDir,
    "--report-path",
    options.reportPath,
    "--limit",
    "10",
    "--processed-limit",
    "1",
    "--close-delay-ms",
    "0",
    ...(options.extraArgs ?? []),
  ]);
}

function runReconcileForTest(options: {
  itemsDir: string;
  closedDir: string;
  plansDir: string;
  extraArgs?: string[];
}): string {
  return execFileSync(
    process.execPath,
    [
      "dist/clawsweeper.js",
      "reconcile",
      "--target-repo",
      "openclaw/clawsweeper",
      "--items-dir",
      options.itemsDir,
      "--closed-dir",
      options.closedDir,
      "--plans-dir",
      options.plansDir,
      "--skip-closed-at",
      ...(options.extraArgs ?? []),
    ],
    { encoding: "utf8" },
  );
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
  const originalGhBin = process.env.GH_BIN;
  const originalGhBinArgs = process.env.GH_BIN_ARGS;
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
    const ghMock = `#!/usr/bin/env node
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
`;
    writeFileSync(join(binDir, "gh.js"), ghMock, { mode: 0o755 });
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

    process.env.GH_BIN = process.execPath;
    process.env.GH_BIN_ARGS = JSON.stringify([join(binDir, "gh.js")]);
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
    if (originalGhBin === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = originalGhBin;
    if (originalGhBinArgs === undefined) delete process.env.GH_BIN_ARGS;
    else process.env.GH_BIN_ARGS = originalGhBinArgs;
    rmSync(root, { recursive: true, force: true });
    rmSync(defaultPlanPath, { force: true });
  }
});

test("apply-decisions skips advisory label sync when a close report changed since review", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "321.md"),
      workPlanCandidateReport({
        decision: "close",
        action_taken: "proposed_close",
        close_reason: "implemented_on_main",
        confidence: "high",
        item_snapshot_hash: "reviewed-snapshot",
        item_updated_at: "2026-05-01T00:00:00Z",
        reproduction_status: "reproduced",
        reproduction_confidence: "high",
      }),
      "utf8",
    );

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-03T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "skipped_changed_since_review",
        reason: "updated_at changed",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions reports hatch requests with no durable item record", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/84244\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    appendFileSync(logPath, JSON.stringify(["comment-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
    console.log(JSON.stringify({
      id: 984244,
      html_url: "https://github.com/openclaw/clawsweeper/pull/84244#issuecomment-984244"
    }));
  } else {
    console.log(JSON.stringify([[]]));
  }
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--sync-comments-only",
          "--hatch-pr-egg-image",
          "--item-numbers",
          "84244",
          "--processed-limit",
          "10",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 84244,
        action: "skipped_missing_record",
        reason: "no current durable ClawSweeper review record; posted hatch-missing-record comment",
      },
    ]);
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "api" &&
          args[1] === "repos/openclaw/clawsweeper/issues/84244/comments" &&
          args.includes("POST"),
      ),
    );
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "comment-body" &&
          /no current durable ClawSweeper review record/.test(args[1]) &&
          /@clawsweeper re-review/.test(args[1]) &&
          /clawsweeper-hatch-missing-record:84244/.test(args[1]),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile preserves exact open item records missed by the broad open scan", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(closedDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "84347.md"),
      `${reportFrontMatter({
        repository: "openclaw/clawsweeper",
        type: "pull_request",
        number: "84347",
        title: "Preserve exact PR",
        url: "https://github.com/openclaw/clawsweeper/pull/84347",
      })}

## Summary

Keep this open PR record.
`,
      "utf8",
    );

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\?state=open/.test(path)) {
  console.log("");
} else if (args[0] === "api" && /\\/issues\\/84347$/.test(path)) {
  console.log(JSON.stringify({
    number: 84347,
    title: "Preserve exact PR",
    html_url: "https://github.com/openclaw/clawsweeper/pull/84347",
    created_at: "2026-05-19T22:39:22Z",
    updated_at: "2026-05-19T22:56:27Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    pull_request: {}
  }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      const output = runReconcileForTest({
        itemsDir,
        closedDir,
        plansDir,
        extraArgs: ["--item-numbers", "84347"],
      });
      assert.equal(JSON.parse(output).movedToClosed, 0);
    });

    assert.ok(existsSync(join(itemsDir, "84347.md")));
    assert.equal(existsSync(join(closedDir, "84347.md")), false);
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args[0] === "api" && args[1].endsWith("/issues/84347")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hatch sync posts PR egg comment without publishing stale review changes", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "74476.md"),
      `${reportFrontMatter({
        repository: "openclaw/clawsweeper",
        type: "pull_request",
        number: "74476",
        title: "Keep hatch separate",
        url: "https://github.com/openclaw/clawsweeper/pull/74476",
        decision: "keep_open",
        close_reason: "none",
        confidence: "high",
        action_taken: "kept_open",
        review_status: "complete",
        local_checkout_access: "verified",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify([
          "proof: sufficient",
          "rating: 🐚 platinum hermit",
          "status: 👀 ready for maintainer look",
        ]),
        item_snapshot_hash: "snapshot-a",
        item_updated_at: "2026-05-19T20:00:00Z",
        pull_head_sha: "abc123def456",
        pr_egg_image_url:
          "https://raw.githubusercontent.com/openclaw/clawsweeper-state/state/assets/pr-eggs/openclaw-clawsweeper/74476.png",
      })}

## Summary

This newer durable record contains a stale pending P2 finding that must not be published by hatch.

## What This Changes

Keeps hatch isolated.

## Best Possible Solution

Merge after maintainer review.

${realBehaviorProofReportSection()}

${prRatingReportSection()}

## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.84

Full review comments:

- **[P2] Pending stale finding:** \`src/example.ts:1\`
  - body: This finding should not appear in the existing review comment during hatch.
`,
      "utf8",
    );

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/74476$/.test(path)) {
  console.log(JSON.stringify({
    number: 74476,
    title: "Keep hatch separate",
    html_url: "https://github.com/openclaw/clawsweeper/pull/74476",
    created_at: "2026-05-19T19:00:00Z",
    updated_at: "2026-05-19T20:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [{ name: "status: 👀 ready for maintainer look" }],
    pull_request: {}
  }));
} else if (args[0] === "api" && /\\/issues\\/74476\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    appendFileSync(logPath, JSON.stringify(["comment-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
    console.log(JSON.stringify({
      id: 987476,
      html_url: "https://github.com/openclaw/clawsweeper/pull/74476#issuecomment-987476"
    }));
  } else {
    console.log(JSON.stringify([[
      {
        id: 444,
        html_url: "https://github.com/openclaw/clawsweeper/pull/74476#issuecomment-444",
        body: "Codex review: needs maintainer review before merge.\\n\\n<!-- clawsweeper-review item=74476 -->",
        user: { login: "clawsweeper" },
        created_at: "2026-05-19T19:55:00Z",
        updated_at: "2026-05-19T19:55:00Z"
      }
    ]]));
  }
} else if (args[0] === "api" && /\\/issues\\/comments\\/444$/.test(path)) {
  appendFileSync(logPath, JSON.stringify(["patched-review-comment"]) + "\\n");
  process.exit(1);
} else if (args[0] === "label" || args[0] === "issue") {
  appendFileSync(logPath, JSON.stringify(["unexpected-label-or-issue-command", ...args]) + "\\n");
  process.exit(1);
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--sync-comments-only",
          "--hatch-pr-egg-image",
          "--item-numbers",
          "74476",
          "--processed-limit",
          "10",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 74476,
        action: "hatch_comment_synced",
        reason: "synced PR egg hatch comment",
      },
    ]);
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "api" &&
          args[1] === "repos/openclaw/clawsweeper/issues/74476/comments" &&
          args.includes("POST"),
      ),
    );
    assert.equal(
      calls.some((args) => args[0] === "patched-review-comment"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "unexpected-label-or-issue-command"),
      false,
    );
    const hatchBody = calls.find((args) => args[0] === "comment-body")?.[1] ?? "";
    assert.match(hatchBody, /ClawSweeper PR egg/);
    assert.match(
      hatchBody,
      /<img src="https:\/\/raw\.githubusercontent\.com\/openclaw\/clawsweeper-state\/state\/assets\/pr-eggs\/openclaw-clawsweeper\/74476\.png"/,
    );
    assert.doesNotMatch(hatchBody, /```text/);
    assert.match(hatchBody, /### Hatch command/);
    assert.match(hatchBody, /clawsweeper-pr-egg-hatch:74476/);
    assert.doesNotMatch(hatchBody, /Pending stale finding/);
    assert.doesNotMatch(hatchBody, /Codex review: needs changes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hatch sync can use archived merged PR records without hatchable labels", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(closedDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(closedDir, "74479.md"),
      `${reportFrontMatter({
        repository: "openclaw/clawsweeper",
        type: "pull_request",
        number: "74479",
        title: "Closed hatch",
        url: "https://github.com/openclaw/clawsweeper/pull/74479",
        decision: "keep_open",
        close_reason: "none",
        confidence: "high",
        action_taken: "kept_open",
        review_status: "complete",
        local_checkout_access: "verified",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify(["proof: sufficient"]),
        current_state: "closed",
        current_item_closed_at: "2026-05-19T21:00:00Z",
        pull_head_sha: "abc123def456",
      })}

## Summary

This PR closed after review.

${realBehaviorProofReportSection()}

${prRatingReportSection()}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.95

Full review comments:

- none
`,
      "utf8",
    );

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/74479$/.test(path)) {
  console.log(JSON.stringify({
    number: 74479,
    title: "Closed hatch",
    html_url: "https://github.com/openclaw/clawsweeper/pull/74479",
    created_at: "2026-05-19T19:00:00Z",
    updated_at: "2026-05-19T21:00:00Z",
    closed_at: "2026-05-19T21:00:00Z",
    state: "closed",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [{ name: "proof: sufficient" }],
    pull_request: {}
  }));
} else if (args[0] === "api" && /\\/issues\\/74479\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    appendFileSync(logPath, JSON.stringify(["comment-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
    console.log(JSON.stringify({
      id: 987479,
      html_url: "https://github.com/openclaw/clawsweeper/pull/74479#issuecomment-987479"
    }));
  } else {
    console.log(JSON.stringify([[]]));
  }
} else if (args[0] === "api" && /\\/pulls\\/74479$/.test(path)) {
  console.log(JSON.stringify({
    merged: true,
    merged_at: "2026-05-19T21:00:00Z"
  }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--sync-comments-only",
          "--hatch-pr-egg-image",
          "--item-numbers",
          "74479",
          "--processed-limit",
          "10",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 74479,
        action: "hatch_comment_synced",
        reason: "synced PR egg hatch comment",
      },
    ]);
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const hatchBody = calls.find((args) => args[0] === "comment-body")?.[1] ?? "";
    assert.match(hatchBody, /✨ Hatched: [^\n]+/);
    assert.match(hatchBody, /### Hatch command/);
    assert.match(hatchBody, /Merged PRs are hatchable/);
    assert.match(
      hatchBody,
      /Closed unmerged PRs are hatchable only when one of those hatchable labels/,
    );
    assert.doesNotMatch(hatchBody, /```text/);
    assert.match(hatchBody, /clawsweeper-pr-egg-hatch:74479/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed PR egg hatch still requires hatchable durable labels", () => {
  const report = `${reportFrontMatter({
    repository: "openclaw/clawsweeper",
    type: "pull_request",
    number: "74480",
    title: "Closed without hatch label",
    url: "https://github.com/openclaw/clawsweeper/pull/74480",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    action_taken: "kept_open",
    review_status: "complete",
    local_checkout_access: "verified",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["proof: sufficient"]),
    current_state: "closed",
    current_item_closed_at: "2026-05-19T21:00:00Z",
    pull_head_sha: "abc123def456",
  })}

## Summary

This PR closed after review.

${realBehaviorProofReportSection()}

${prRatingReportSection()}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.95

Full review comments:

- none
`;

  const eggComment = renderPrEggCommentForTest(74480, report);
  assert.match(eggComment, /🥚 Incubating:/);
  assert.match(eggComment, /clawsweeper:automerge/);
  assert.doesNotMatch(eggComment, /✨ Hatched:/);
});

test("normal PR comment sync moves PR egg into a separate marker-backed comment", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "74477.md"),
      `${reportFrontMatter({
        repository: "openclaw/clawsweeper",
        type: "pull_request",
        number: "74477",
        title: "Move egg comment",
        url: "https://github.com/openclaw/clawsweeper/pull/74477",
        decision: "keep_open",
        close_reason: "none",
        confidence: "high",
        action_taken: "kept_open",
        review_status: "complete",
        local_checkout_access: "verified",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify([
          "proof: sufficient",
          "rating: 🐚 platinum hermit",
          "status: 👀 ready for maintainer look",
        ]),
        item_snapshot_hash: "snapshot-a",
        item_updated_at: "2026-05-19T20:00:00Z",
        pull_head_sha: "abc123def456",
      })}

## Summary

This PR should keep the review comment focused.

## What This Changes

Moves the pet into its own comment.

## Best Possible Solution

Merge after maintainer review.

${realBehaviorProofReportSection()}

${prRatingReportSection()}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
      "utf8",
    );

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/74477$/.test(path)) {
  console.log(JSON.stringify({
    number: 74477,
    title: "Move egg comment",
    html_url: "https://github.com/openclaw/clawsweeper/pull/74477",
    created_at: "2026-05-19T19:00:00Z",
    updated_at: "2026-05-19T20:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [
      "proof: sufficient",
      "rating: 🐚 platinum hermit",
      "status: 👀 ready for maintainer look"
    ],
    pull_request: {}
  }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/74477\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/74477\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/pulls\\/74477$/.test(path)) {
  console.log(JSON.stringify({
    number: 74477,
    html_url: "https://github.com/openclaw/clawsweeper/pull/74477",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    head: { sha: "abc123def456", ref: "branch", repo: { full_name: "fork/clawsweeper" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/clawsweeper" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74477\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74477\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    appendFileSync(logPath, JSON.stringify(["posted-comment-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
    console.log(JSON.stringify({
      id: 987477,
      html_url: "https://github.com/openclaw/clawsweeper/pull/74477#issuecomment-987477"
    }));
  } else {
    console.log(JSON.stringify([[
      {
        id: 555,
        html_url: "https://github.com/openclaw/clawsweeper/pull/74477#issuecomment-555",
        body: "Codex review: stale body with old embedded pet.\\n\\n**PR egg**\\nold egg\\n\\n<!-- clawsweeper-review item=74477 -->",
        user: { login: "clawsweeper" },
        created_at: "2026-05-19T19:55:00Z",
        updated_at: "2026-05-19T19:55:00Z"
      }
    ]]));
  }
} else if (args[0] === "api" && /\\/issues\\/comments\\/555$/.test(path)) {
  const input = args[args.indexOf("--input") + 1];
  appendFileSync(logPath, JSON.stringify(["patched-review-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
  console.log(JSON.stringify({
    id: 555,
    html_url: "https://github.com/openclaw/clawsweeper/pull/74477#issuecomment-555"
  }));
} else if (args[0] === "label" || args[0] === "issue") {
  appendFileSync(logPath, JSON.stringify(["unexpected-label-or-issue-command", ...args]) + "\\n");
  process.exit(1);
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only", "--item-numbers", "74477", "--processed-limit", "10"],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 74477,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment; synced durable PR egg comment",
      },
    ]);
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const patchedReviewBody = calls.find((args) => args[0] === "patched-review-body")?.[1] ?? "";
    const eggBody = calls.find((args) => args[0] === "posted-comment-body")?.[1] ?? "";
    assert.match(patchedReviewBody, /Codex review:/);
    assert.doesNotMatch(patchedReviewBody, /\*\*PR egg\*\*/);
    assert.match(eggBody, /ClawSweeper PR egg/);
    assert.match(eggBody, /✨ Hatched: [^\n]+/);
    assert.match(eggBody, /@clawsweeper hatch/);
    assert.match(eggBody, /clawsweeper-pr-egg-hatch:74477/);
    assert.doesNotMatch(eggBody, /<img src=/);
    assert.equal(
      calls.some((args) => args[0] === "unexpected-label-or-issue-command"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions records PR label sync as ClawSweeper-owned churn", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74478.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      itemPath,
      `${reportFrontMatter({
        repository: "openclaw/clawsweeper",
        type: "pull_request",
        number: "74478",
        title: "Record PR label churn",
        url: "https://github.com/openclaw/clawsweeper/pull/74478",
        decision: "keep_open",
        close_reason: "none",
        confidence: "high",
        action_taken: "kept_open",
        review_status: "complete",
        local_checkout_access: "verified",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify([]),
        item_snapshot_hash: "snapshot-a",
        item_updated_at: "2026-05-19T20:00:00Z",
        pull_head_sha: "abc123def456",
      })}

## Summary

This PR has complete review metadata and needs only ClawSweeper-owned labels.

${realBehaviorProofReportSection({ evidenceKind: "screenshot" })}

${prRatingReportSection({ overallTier: "A" })}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
      "utf8",
    );

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/74478$/.test(path)) {
  console.log(JSON.stringify({
    number: 74478,
    title: "Record PR label churn",
    html_url: "https://github.com/openclaw/clawsweeper/pull/74478",
    created_at: "2026-05-19T19:00:00Z",
    updated_at: "2026-05-19T20:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/74478\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/74478\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/pulls\\/74478$/.test(path)) {
  console.log(JSON.stringify({
    number: 74478,
    html_url: "https://github.com/openclaw/clawsweeper/pull/74478",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    head: { sha: "abc123def456", ref: "branch", repo: { full_name: "fork/clawsweeper" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/clawsweeper" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74478\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74478\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    appendFileSync(logPath, JSON.stringify(["posted-comment-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
    console.log(JSON.stringify({
      id: 987478,
      html_url: "https://github.com/openclaw/clawsweeper/pull/74478#issuecomment-987478"
    }));
  } else {
    console.log(JSON.stringify([[]]));
  }
} else if (args[0] === "label" && args[1] === "create") {
  console.log(JSON.stringify({ name: args[2] }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only", "--item-numbers", "74478"],
      });
    });

    const report = readFileSync(itemPath, "utf8");
    assert.match(report, /^labels_synced_at: /m);
    assert.match(report, /proof: sufficient/);
    assert.match(report, /proof: 📸 screenshot/);
    assert.match(report, /rating: 🦞 diamond lobster/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions refreshes recent PR comments after label sync adds justifications", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74479.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      itemPath,
      `${reportFrontMatter({
        repository: "openclaw/clawsweeper",
        type: "pull_request",
        number: "74479",
        title: "Refresh label explanation",
        url: "https://github.com/openclaw/clawsweeper/pull/74479",
        decision: "keep_open",
        close_reason: "none",
        confidence: "high",
        action_taken: "kept_open",
        review_status: "complete",
        local_checkout_access: "verified",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify([]),
        item_snapshot_hash: "snapshot-a",
        item_updated_at: "2026-05-19T20:00:00Z",
        pull_head_sha: "abc123def456",
        review_comment_synced_at: "2026-05-19T23:59:00Z",
      })}

## Summary

This PR needs labels and the latest comment must explain them.

${realBehaviorProofReportSection({ evidenceKind: "screenshot" })}

${prRatingReportSection({ overallTier: "A" })}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
      "utf8",
    );

    const staleCommentBody =
      "Codex review: needs maintainer review before merge.\n\n<!-- clawsweeper-review item=74479 -->";
    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const staleCommentBody = ${JSON.stringify(staleCommentBody)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/74479$/.test(path)) {
  console.log(JSON.stringify({
    number: 74479,
    title: "Refresh label explanation",
    html_url: "https://github.com/openclaw/clawsweeper/pull/74479",
    created_at: "2026-05-19T19:00:00Z",
    updated_at: "2026-05-19T20:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/74479\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/74479\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/pulls\\/74479$/.test(path)) {
  console.log(JSON.stringify({
    number: 74479,
    html_url: "https://github.com/openclaw/clawsweeper/pull/74479",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    head: { sha: "abc123def456", ref: "branch", repo: { full_name: "fork/clawsweeper" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/clawsweeper" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74479\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74479\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[
    {
      id: 987479,
      html_url: "https://github.com/openclaw/clawsweeper/pull/74479#issuecomment-987479",
      body: staleCommentBody,
      user: { login: "clawsweeper[bot]" },
      created_at: "2026-05-19T23:59:00Z",
      updated_at: "2026-05-19T23:59:00Z"
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/comments\\/987479$/.test(path)) {
  const input = args[args.indexOf("--input") + 1];
  appendFileSync(logPath, JSON.stringify(["patched-review-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
  console.log(JSON.stringify({
    id: 987479,
    html_url: "https://github.com/openclaw/clawsweeper/pull/74479#issuecomment-987479"
  }));
} else if (args[0] === "label" && args[1] === "create") {
  console.log(JSON.stringify({ name: args[2] }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--sync-comments-only",
          "--comment-sync-min-age-days",
          "7",
          "--item-numbers",
          "74479",
        ],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const patchedBody = calls.find((args) => args[0] === "patched-review-body")?.[1] ?? "";
    assert.match(patchedBody, /Label justifications:/);
    assert.match(patchedBody, /`proof: sufficient`/);
    assert.match(patchedBody, /`proof: 📸 screenshot`/);
    assert.match(patchedBody, /`rating: 🦞 diamond lobster`/);
    assert.match(readFileSync(itemPath, "utf8"), /^labels_synced_at: /m);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 74479,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment; synced durable PR egg comment",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not advisory-label close proposals before close gates finish", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const closeReport = workPlanCandidateReport({
      decision: "close",
      action_taken: "proposed_close",
      close_reason: "implemented_on_main",
      confidence: "high",
      item_snapshot_hash: "reviewed-snapshot",
      item_updated_at: "2026-05-01T00:00:00Z",
      reproduction_status: "reproduced",
      reproduction_confidence: "high",
    });
    const synced = reportWithSyncedReviewComment(closeReport, 321, "implemented_on_main");
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  const timeline = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  console.log('HTTP/2 200\\nlink: <https://api.github.com/repos/openclaw/clawsweeper/issues/321/timeline?per_page=100&page=2>; rel="last"\\n\\n' + JSON.stringify(timeline));
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321",
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comment
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--apply-close-reasons", "stale_insufficient_info"],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "api" &&
          (args[1] ?? "").endsWith("/issues/321/timeline?per_page=100") &&
          args.includes("--paginate"),
      ),
      true,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "kept_open",
        reason: "close reason implemented_on_main is not enabled for this apply run",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions posts an explicit close-time note before closing PR proposals", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const postedBodiesPath = join(root, "posted-bodies.jsonl");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const closeReport = `${workPlanCandidateReport({
      type: "pull_request",
      decision: "close",
      action_taken: "proposed_close",
      close_reason: "implemented_on_main",
      confidence: "high",
      item_snapshot_hash: "reviewed-snapshot",
      item_updated_at: "2026-05-01T00:00:00Z",
      reproduction_status: "reproduced",
      reproduction_confidence: "high",
      fixed_pr_url: "https://github.com/openclaw/clawsweeper/pull/900",
      fixed_pr_number: "900",
      fixed_sha: "1234567890abcdef1234567890abcdef12345678",
      fixed_at: "2026-05-01T02:00:00Z",
    })}\n\n## Evidence\n\n- **main fix:** git show confirms current main has the replacement implementation and it is not in the latest release yet\n  - file: [src/clawsweeper.ts](https://github.com/openclaw/clawsweeper/blob/1234567890abcdef1234567890abcdef12345678/src/clawsweeper.ts)\n  - sha: [1234567890ab](https://github.com/openclaw/clawsweeper/commit/1234567890abcdef1234567890abcdef12345678)\n\n## Close Comment\n\nClosing this PR because the fix is already on main.\n`;
    const synced = reportWithSyncedReviewComment(closeReport, 321, "implemented_on_main");
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const postedBodiesPath = ${JSON.stringify(postedBodiesPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    const payload = JSON.parse(readFileSync(input, "utf8"));
    appendFileSync(postedBodiesPath, JSON.stringify(payload.body) + "\\n");
    console.log(JSON.stringify({ id: 9322, html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9322" }));
  } else {
    console.log(JSON.stringify([[{
      id: 9321,
      html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9321",
      created_at: "2026-05-01T01:00:00Z",
      updated_at: "2026-05-01T01:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: comment
    }]]));
  }
} else if (args[0] === "api" && /\\/issues\\/comments\\/9321$/.test(path)) {
  console.log(JSON.stringify({ id: 9321, html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9321" }));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/pull/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/clawsweeper/pulls/321" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    html_url: "https://github.com/openclaw/clawsweeper/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/clawsweeper" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/clawsweeper" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "pr" && args[1] === "close" && args[2] === "321") {
  console.log("");
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else if (args[0] === "label") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--apply-kind", "all", "--processed-limit", "2"],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const postIndex = calls.findIndex(
      (args) =>
        args[0] === "api" &&
        (args[1] ?? "").endsWith("/issues/321/comments") &&
        args.includes("POST"),
    );
    const closeIndex = calls.findIndex(
      (args) => args[0] === "pr" && args[1] === "close" && args[2] === "321",
    );
    assert.ok(postIndex >= 0);
    assert.ok(closeIndex > postIndex);
    const postedBodies = readFileSync(postedBodiesPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string);
    assert.equal(postedBodies.length, 1);
    assert.match(postedBodies[0], /ClawSweeper applied the proposed close for this PR/);
    assert.match(postedBodies[0], /Close reason: already implemented on main/);
    assert.match(postedBodies[0], /durable ClawSweeper review/);
    assert.match(postedBodies[0], /clawsweeper-close-applied item=321/);
    assert.ok(existsSync(join(closedDir, "321.md")));
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
      },
      {
        number: 321,
        action: "closed",
        reason: "already implemented on main; posted close-applied comment",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions skips advisory labels for failed or stale kept-open reports", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const failed = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 321,
        review_status: "failed",
        item_snapshot_hash: "reviewed-snapshot-321",
        item_updated_at: "2026-05-01T00:00:00Z",
        reproduction_status: "unclear",
        reproduction_confidence: "low",
        work_candidate: "none",
        work_status: "none",
        work_confidence: "low",
      }),
      321,
    );
    const stale = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 322,
        item_snapshot_hash: "reviewed-snapshot-322",
        item_updated_at: "2026-05-01T00:00:00Z",
        triage_priority: "P1",
        reproduction_status: "reproduced",
        reproduction_confidence: "high",
      }),
      322,
    );
    writeFileSync(join(itemsDir, "321.md"), failed.report, "utf8");
    writeFileSync(join(itemsDir, "322.md"), stale.report, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comments = ${JSON.stringify({ 321: failed.comment, 322: stale.comment })};
const updatedAt = { 321: "2026-05-01T00:00:00Z", 322: "2026-05-02T00:00:00Z" };
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
const commentMatch = path.match(/\\/issues\\/(\\d+)\\/comments(?:\\?|$)/);
const issueMatch = path.match(/\\/issues\\/(\\d+)$/);
if (args[0] === "api" && commentMatch) {
  const number = Number(commentMatch[1]);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && issueMatch) {
  const number = Number(issueMatch[1]);
  console.log(JSON.stringify({
    number,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: updatedAt[number],
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions counts unverified local-checkout reports against the processed limit", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const unverified = workPlanCandidateReport({ number: 321 }).replace(
      /^local_checkout_access: verified\n/m,
      "",
    );
    const secondUnverified = workPlanCandidateReport({ number: 322 }).replace(
      /^local_checkout_access: verified\n/m,
      "",
    );
    writeFileSync(join(itemsDir, "321.md"), unverified, "utf8");
    writeFileSync(join(itemsDir, "322.md"), secondUnverified, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.error("unexpected gh call");
process.exit(1);
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "kept_open",
        reason: "review lacks verified local checkout access",
      },
    ]);
    assert.equal(existsSync(logPath), false);
    assert.match(readFileSync(join(itemsDir, "321.md"), "utf8"), /^apply_checked_at: /m);
    assert.doesNotMatch(readFileSync(join(itemsDir, "322.md"), "utf8"), /^apply_checked_at: /m);

    runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 322,
        action: "kept_open",
        reason: "review lacks verified local checkout access",
      },
    ]);
    assert.match(readFileSync(join(itemsDir, "322.md"), "utf8"), /^apply_checked_at: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions counts advisory label-only syncs against the processed limit", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const first = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 321,
        reviewed_at: "2026-05-01T00:00:00Z",
        item_snapshot_hash: "reviewed-snapshot-321",
        item_updated_at: "2026-05-01T00:00:00Z",
      }),
      321,
    );
    const second = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 322,
        reviewed_at: "2026-05-01T00:00:00Z",
        item_snapshot_hash: "reviewed-snapshot-322",
        item_updated_at: "2026-05-01T00:00:00Z",
      }),
      322,
    );
    writeFileSync(join(itemsDir, "321.md"), first.report, "utf8");
    writeFileSync(join(itemsDir, "322.md"), second.report, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comments = ${JSON.stringify({ 321: first.comment, 322: second.comment })};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
const commentMatch = path.match(/\\/issues\\/(\\d+)\\/comments(?:\\?|$)/);
const issueMatch = path.match(/\\/issues\\/(\\d+)$/);
if (args[0] === "api" && commentMatch) {
  const number = Number(commentMatch[1]);
  const body = comments[number];
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body
  }]]));
} else if (args[0] === "api" && issueMatch) {
  const number = Number(issueMatch[1]);
  console.log(JSON.stringify({
    number,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" && args[1] === "create") {
  console.log("");
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const editCalls = calls.filter((args) => args[0] === "issue" && args[1] === "edit");
    assert.ok(editCalls.length > 0);
    assert.deepEqual([...new Set(editCalls.map((args) => args[2]))], ["321"]);
    assert.equal(
      calls.some((args) => args.some((arg) => arg.includes("/issues/322"))),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "kept_open",
        reason: "synced advisory issue labels",
      },
    ]);
    assert.match(readFileSync(join(itemsDir, "321.md"), "utf8"), /^labels_synced_at: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions dry-run computes advisory labels without mutating GitHub labels", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const synced = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 321,
        reviewed_at: "2026-05-01T00:00:00Z",
        item_snapshot_hash: "reviewed-snapshot-321",
        item_updated_at: "2026-05-01T00:00:00Z",
      }),
      321,
    );
    const itemPath = join(itemsDir, "321.md");
    writeFileSync(itemPath, synced.report, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321",
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comment
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--dry-run"],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "kept_open",
        reason: "dry-run: would sync advisory issue labels",
      },
    ]);
    assert.doesNotMatch(readFileSync(itemPath, "utf8"), /clawsweeper:queueable-fix/);
    assert.doesNotMatch(readFileSync(itemPath, "utf8"), /^labels_synced_at: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

  assert.ok(
    comment.includes(
      `ℹ️ **INFO** **Next step before merge** **Take the next merge decision**\n\n${duplicateRisk}`,
    ),
  );
  assert.doesNotMatch(comment, /Remaining risk \/ open question:/);
  assert.doesNotMatch(comment, /\*\*Risk before merge\*\*/);
  assert.equal(comment.split(duplicateRisk).length - 1, 1);
});

function mergeRiskReviewComment({
  risk,
  options,
  bestSolution = "Resolve the merge risk before maintainers decide whether to land this PR.",
}: {
  risk: string;
  options: readonly Record<string, unknown>[];
  bestSolution?: string;
}): string {
  return renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "83400",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
      merge_risk_options: JSON.stringify(options),
    })}

## Summary

Keep this fail-closed provider-routing PR open for maintainer review.

## What This Changes

Changes missing Codex harness selection from fallback-tolerant behavior to a typed fail-closed error.

## Best Possible Solution

${bestSolution}

## Risks / Open Questions

${risk}

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Status: none

Reason: Confirm whether this intentional fail-closed behavior is acceptable for existing fallback users.
`,
    "none",
  );
}

test("pull request keep-open review comments render repairable merge-risk options with one copy block", () => {
  const mergeRisk =
    "Existing users configured with a missing Codex harness would fail closed instead of continuing through their fallback model.";
  const comment = mergeRiskReviewComment({
    risk: mergeRisk,
    bestSolution:
      "Keep fallback behavior as the default and add a strict config option for the fail-closed behavior.",
    options: [
      {
        title: "Preserve existing behavior by default",
        body: "Keep fallback behavior as the default and add a strict config option for the fail-closed behavior.",
        category: "fix_before_merge",
        recommended: true,
        automergeInstruction:
          "Keep fallback behavior as the default and add a strict config option for the fail-closed behavior.",
      },
      {
        title: "Make the breaking change explicit",
        body: "Keep fail-closed behavior only if docs, tests, and release notes warn existing fallback users.",
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
      {
        title: "Do not merge as-is",
        body: "Pause or close this PR if maintainers do not want to take this compatibility risk.",
        category: "pause_or_close",
        recommended: false,
        automergeInstruction: "",
      },
    ],
  });

  assert.match(comment, /\*\*Risk before merge\*\*/);
  assert.match(comment, new RegExp(escapeRegExpForTest(mergeRisk)));
  assert.doesNotMatch(comment, /Why this matters:/);
  assert.match(
    comment,
    /\*\*Maintainer options:\*\*\n1\. \*\*Preserve existing behavior by default \(recommended\)\*\*/,
  );
  assert.match(comment, /2\. \*\*Make the breaking change explicit\*\*/);
  assert.match(comment, /3\. \*\*Do not merge as-is\*\*/);
  assert.match(
    comment,
    /<summary>Copy recommended automerge instruction<\/summary>[\s\S]*@clawsweeper automerge\n\nSpecial instructions:\nKeep fallback behavior as the default and add a strict config option for the fail-closed behavior\./,
  );
  assert.doesNotMatch(comment, /Remaining risk \/ open question:/);
});

test("pull request keep-open review comments strip nested ClawSweeper commands from copy block", () => {
  const comment = mergeRiskReviewComment({
    risk: "Delivery repair should not run with nested bot commands in the pasteable instruction.",
    bestSolution: "Repair duplicate delivery and add regression coverage before merge.",
    options: [
      {
        title: "Repair delivery before merge",
        body: "Fix duplicate active-requester delivery and add regression coverage before merge.",
        category: "fix_before_merge",
        recommended: true,
        automergeInstruction:
          "@clawsweeper autofix this PR: prevent duplicate active-requester delivery and add focused regression coverage before merging.",
      },
    ],
  });

  assert.match(
    comment,
    /@clawsweeper automerge\n\nSpecial instructions:\nprevent duplicate active-requester delivery and add focused regression coverage before merging\./,
  );
  assert.doesNotMatch(comment, /Special instructions: @clawsweeper/);
  assert.doesNotMatch(comment, /autofix this PR:/);
});

test("pull request keep-open review comments can recommend accepting intentional risk without a copy block", () => {
  const comment = mergeRiskReviewComment({
    risk: "This hardening intentionally rejects requests that older integrations currently pass.",
    bestSolution:
      "Merge only if maintainers accept the compatibility break as intentional hardening.",
    options: [
      {
        title: "Accept the behavior change explicitly",
        body: "Merge only if maintainers agree the security hardening is worth the compatibility break.",
        category: "accept_risk",
        recommended: true,
        automergeInstruction: "",
      },
      {
        title: "Add migration guidance before merge",
        body: "Document the rejected request shape and add release-note guidance for affected integrations.",
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
    ],
  });

  assert.match(comment, /1\. \*\*Accept the behavior change explicitly \(recommended\)\*\*/);
  assert.doesNotMatch(comment, /Copy recommended ClawSweeper instruction/);
});

test("pull request keep-open review comments do not force a recommendation for unclear merge risk", () => {
  const comment = mergeRiskReviewComment({
    risk: "The PR changes session ownership without proving how existing resumed sessions transition.",
    options: [
      {
        title: "Require a maintainer design decision",
        body: "Decide whether resumed sessions should migrate, fail fast, or continue using the old ownership model.",
        category: "pause_or_close",
        recommended: false,
        automergeInstruction: "",
      },
      {
        title: "Add migration proof before merge",
        body: "Add tests or manual validation covering sessions created before this change.",
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
    ],
  });

  assert.doesNotMatch(comment, /\(recommended\)/);
  assert.doesNotMatch(comment, /Copy recommended ClawSweeper instruction/);
});

test("pull request keep-open review comments allow multiple fix-before-merge options", () => {
  const comment = mergeRiskReviewComment({
    risk: "The retry path may duplicate queued user messages after partial provider sends.",
    bestSolution: "Guard retries with delivery state before merge.",
    options: [
      {
        title: "Guard retries with delivery state",
        body: "Track whether the user message was already sent before retrying provider fallback.",
        category: "fix_before_merge",
        recommended: true,
        automergeInstruction:
          "Track whether the user message was already sent before retrying provider fallback.",
      },
      {
        title: "Disable fallback after partial sends",
        body: "Fail fast once delivery starts instead of retrying through another provider.",
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
    ],
  });

  assert.match(comment, /1\. \*\*Guard retries with delivery state \(recommended\)\*\*/);
  assert.match(comment, /2\. \*\*Disable fallback after partial sends\*\*/);
  assert.match(comment, /@clawsweeper automerge/);
});

test("pull request keep-open review comments include pause or close when risk may outweigh value", () => {
  const comment = mergeRiskReviewComment({
    risk: "The PR changes automation proof capture without proving failed paths still upload artifacts.",
    options: [
      {
        title: "Prove artifact parity before merge",
        body: "Show that artifacts upload on success, failure, and skipped-review paths.",
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
      {
        title: "Pause or close",
        body: "Close this PR if maintainers decide the proof-capture regression risk outweighs the workflow cleanup.",
        category: "pause_or_close",
        recommended: false,
        automergeInstruction: "",
      },
    ],
  });

  assert.match(
    comment,
    /2\. \*\*Pause or close\*\*  \n   Close this PR if maintainers decide the proof-capture regression risk outweighs the workflow cleanup\./,
  );
  assert.doesNotMatch(comment, /Copy recommended ClawSweeper instruction/);
});

function escapeRegExpForTest(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  assert.equal(shards.length, AUTOMATION_LIMITS.review_shards.hard_cap);
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

test("runCodex accepts valid structured output after non-zero Codex exit", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex === -1) process.exit(2);
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
process.stderr.write("wrote structured output before shutdown failure\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const originalPath = process.env.PATH;
  const originalDecision = process.env.CODEX_DECISION_JSON;
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      summary: "Keep open for maintainer follow-up.",
      bestSolution: "Review the routing invariant.",
      closeComment: "",
      workReason: "Maintainer review is required.",
    }),
  );
  try {
    const decision = runCodexForTest({
      item: item({ number: 83393 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "gpt-test",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });

    assert.equal(decision.decision, "keep_open");
    assert.equal(decision.summary, "Keep open for maintainer follow-up.");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDecision === undefined) delete process.env.CODEX_DECISION_JSON;
    else process.env.CODEX_DECISION_JSON = originalDecision;
    rmSync(root, { recursive: true, force: true });
  }
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
        triagePriority: "urgent",
      }),
    /decision\.triagePriority/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        impactLabels: ["impact:unknown"],
      }),
    /decision\.impactLabels\[0\]/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        impactLabels: [
          "impact:data-loss",
          "impact:security",
          "impact:crash-loop",
          "impact:message-loss",
        ],
      }),
    /decision\.impactLabels must contain at most 3 labels/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        impactLabels: ["impact:data-loss", "impact:data-loss"],
      }),
    /decision\.impactLabels must not contain duplicates/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk:unknown"],
      }),
    /decision\.mergeRiskLabels\[0\]/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: [
          "merge-risk: 🚨 compatibility",
          "merge-risk: 🚨 message-delivery",
          "merge-risk: 🚨 session-state",
          "merge-risk: 🚨 auth-provider",
        ],
      }),
    /decision\.mergeRiskLabels must contain at most 3 labels/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk: 🚨 compatibility", "merge-risk: 🚨 compatibility"],
      }),
    /decision\.mergeRiskLabels must not contain duplicates/,
  );
  assert.equal(
    parseDecision({
      ...closeDecision(),
      mergeRiskOptions: undefined,
    }).mergeRiskOptions.length,
    0,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskOptions: [
          {
            title: "Accept the risk",
            body: "Merge only if maintainers accept this risk.",
            category: "accept_risk",
            recommended: false,
            automergeInstruction: "",
          },
        ],
      }),
    /decision\.mergeRiskOptions must be empty when mergeRiskLabels is empty/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk: 🚨 compatibility"],
      }),
    /decision\.mergeRiskOptions must include 1-3 options when mergeRiskLabels is not empty/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk: 🚨 compatibility"],
        mergeRiskOptions: [
          {
            title: "Preserve behavior",
            body: "Keep the existing default behavior before merge.",
            category: "fix_before_merge",
            recommended: true,
            automergeInstruction: "Keep the existing default behavior before merge.",
          },
          {
            title: "Accept risk",
            body: "Merge only if maintainers accept the compatibility break.",
            category: "accept_risk",
            recommended: true,
            automergeInstruction: "",
          },
        ],
      }),
    /decision\.mergeRiskOptions must not contain more than one recommended option/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk: 🚨 security-boundary"],
        mergeRiskOptions: [
          {
            title: "Accept risk",
            body: "Merge only if maintainers accept the hardening tradeoff.",
            category: "accept_risk",
            recommended: true,
            automergeInstruction: "Merge the intentional hardening change.",
          },
        ],
      }),
    /decision\.mergeRiskOptions\[0\]\.automergeInstruction requires fix_before_merge category/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk: 🚨 message-delivery"],
        mergeRiskOptions: [
          {
            title: "Guard delivery",
            body: "Add delivery-state tests before merge.",
            category: "fix_before_merge",
            recommended: false,
            automergeInstruction: "Add delivery-state tests before merge.",
          },
        ],
      }),
    /decision\.mergeRiskOptions\[0\]\.automergeInstruction requires a recommended option/,
  );
  assert.throws(() => {
    const decision = closeDecision();
    delete decision.labelJustifications;
    return parseDecision(decision);
  }, /decision\.labelJustifications must be an array/);
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision({
          impactLabels: ["impact:message-loss"],
          labelJustifications: [
            {
              label: "P2",
              reason: "Normal priority applies to this limited-scope implemented behavior check.",
            },
          ],
        }),
      }),
    /decision\.labelJustifications missing selected labels: impact:message-loss/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision({
          labelJustifications: [
            {
              label: "P2",
              reason: "Normal priority applies to this limited-scope implemented behavior check.",
            },
            {
              label: "impact:data-loss",
              reason: "The selected labels did not include this impact area.",
            },
          ],
        }),
      }),
    /decision\.labelJustifications contains unselected labels: impact:data-loss/,
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
  assert.equal(workCandidate.triagePriority, "P2");
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
  assert.match(prompt, /Do\s+not use `maintainer` as a likely-owner role/);
  assert.match(prompt, /Do not include email\s+addresses in `likelyOwners`/);
  assert.match(prompt, /use names without email addresses/);
});

test("review prompt reads maintainer notes before PR diffs", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /\.agents\/maintainer-notes\//);
  assert.match(prompt, /before reviewing the diff/);
  assert.match(prompt, /Treat matching notes as maintainer decisions/);
  assert.match(prompt, /do not publish raw internal note contents/);
});

test("review prompt requires a dedicated securityReview section", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Always summarize this pass in `securityReview`/);
  assert.match(prompt, /Always fill `securityReview`/);
  assert.match(prompt, /status: "needs_attention"/);
});

test("review prompt treats duplicated behavior as a P1 PR finding", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /dedicated solution-fit and upgrade-safety pass/);
  assert.match(prompt, /current code, documented configuration, CLI flags, env vars/);
  assert.match(prompt, /Search the codebase and docs for the existing capability/);
  assert.match(prompt, /Treat duplicated behavior as a high-priority defect/);
  assert.match(prompt, /add a P1 review finding unless the PR proves/);
  assert.match(prompt, /maintenance drift, conflicting behavior,\s+or user confusion/);
});

test("review prompt requires upgrade and preference overwrite checks", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Treat compatibility and user settings as merge-critical/);
  assert.match(prompt, /override existing preferences, persisted config, provider choices/);
  assert.match(
    prompt,
    /A new default must not change an existing user's stored\s+value during upgrade/,
  );
  assert.match(prompt, /Call out upgrade and settings breakage directly in `reviewFindings`/);
  assert.match(prompt, /existing config\/preferences can be overwritten/);
  assert.match(prompt, /preserving the existing\s+behavior as the default/);
  assert.match(prompt, /explicit strict config option/);
  assert.match(prompt, /default compatibility mode and the\s+opt-in strict mode/);
  assert.match(prompt, /require evidence for both fresh-install behavior and upgrade\s+behavior/);
  assert.match(prompt, /If upgrade behavior is ambiguous, mark the PR incorrect/);
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

test("media proof preparation extracts browser-unplayable ffmpeg-decodeable video proof", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-media-proof-"));
  try {
    const context = {
      issue: {},
      comments: [
        {
          body: [
            "Chromium media error code 4 on this upload, but ffmpeg can decode it:",
            "https://github.com/user/repo/releases/download/proof/Screen.Recording.mov",
          ].join("\n"),
        },
      ],
      timeline: [],
    };
    const calls: string[] = [];
    const prepared = prepareMediaProofArtifactsForTest(context, dir, (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "curl") {
        const outputIndex = args.indexOf("--output");
        assert.notEqual(outputIndex, -1);
        writeFileSync(String(args[outputIndex + 1]), "fake mov bytes");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "ffprobe") {
        return {
          status: 0,
          stdout: JSON.stringify({
            format: { duration: "46.49" },
            streams: [{ codec_name: "h264", width: 734, height: 1038 }],
          }),
          stderr: "",
        };
      }
      if (command === "ffmpeg") {
        const output = String(args.at(-1));
        writeFileSync(output, "fake contact sheet");
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    assert.equal(prepared.artifacts.length, 1);
    assert.equal(prepared.artifacts[0]?.status, "prepared");
    assert.ok(prepared.manifestPath);
    assert.ok(prepared.summaryPath);
    assert.ok(prepared.artifacts[0]?.metadataPath);
    assert.ok(prepared.artifacts[0]?.contactSheetPath);
    assert.equal(existsSync(prepared.manifestPath), true);
    assert.equal(existsSync(prepared.artifacts[0].metadataPath), true);
    assert.equal(existsSync(prepared.artifacts[0].contactSheetPath), true);
    assert.match(calls.join("\n"), /^curl /m);
    assert.match(calls.join("\n"), /^ffprobe /m);
    assert.match(calls.join("\n"), /^ffmpeg /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime prompt tells Codex to inspect ffmpeg video artifacts before browser fallback", () => {
  const context = {
    issue: {},
    comments: [{ body: "Proof: https://github.com/user/repo/releases/download/proof/demo.mov" }],
    timeline: [],
  };
  const prompt = reviewPromptForTest(
    item({ kind: "pull_request" }),
    context,
    { mainSha: "abc123", latestRelease: null },
    "",
    {
      proofScratchDir: "/tmp/proof",
      mediaProofManifestPath: "/tmp/proof/media-proof-manifest.json",
      mediaProofSummary: "prepared: https://github.com/user/repo/releases/download/proof/demo.mov",
    },
  );

  assert.deepEqual(proofVideoUrlsFromContextForTest(context), [
    "https://github.com/user/repo/releases/download/proof/demo.mov",
  ]);
  assert.match(prompt, /preprocessed linked video proof with ffprobe\/ffmpeg/);
  assert.match(prompt, /generated contact-sheet image paths before trying browser playback/);
  assert.match(
    prompt,
    /Only fall back to browser playback after checking the prepared ffmpeg artifacts/,
  );
  assert.match(
    prompt,
    /If browser playback fails but ffprobe metadata and ffmpeg contact sheets are readable/,
  );
});

test("review prompt keeps draft and protected workflow state out of PR rank", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Rate PR evidence\s+and patch quality/);
  assert.match(prompt, /weaker proof-or-patch quality signal/);
  assert.match(
    prompt,
    /Do not lower `proofTier`, `patchTier`,\s+or `overallTier` solely because the PR is draft/,
  );
  assert.match(prompt, /has protected labels/);
  assert.match(prompt, /not\s+automerge-eligible/);
  assert.match(prompt, /workflow\s+state signals, not proof or patch quality defects/);
});

test("decision schema keeps draft and protected workflow state out of PR rank", () => {
  const schema = JSON.parse(readFileSync("schema/clawsweeper-decision.schema.json", "utf8"));
  const prRating = schema.properties.prRating;

  assert.match(prRating.description, /Calibrated PR quality rating/);
  assert.match(prRating.description, /Rate the PR evidence and patch quality/);
  assert.match(prRating.description, /Do not lower any tier solely because the PR is draft/);
  assert.match(prRating.description, /has protected labels/);
  assert.match(prRating.description, /not automerge-eligible/);
  assert.match(
    prRating.properties.overallTier.description,
    /Draft, protected-label, automerge eligibility, and maintainer-waiting workflow states must not lower this tier by themselves/,
  );
});

test("review prompt classifies Telegram visible proof candidates", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /telegramVisibleProof/);
  assert.match(prompt, /telegram-crabbox-e2e-proof/);
  assert.match(prompt, /message formatting/);
  assert.match(prompt, /mantis: telegram-visible-proof/);
  assert.match(prompt, /mantisRecommendation/);
  assert.match(prompt, /@openclaw-mantis/);
  assert.match(prompt, /ambiguous Mantis account mention/);
});

test("pull request review comments suggest copy-paste Mantis proof comments", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "83140",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this Telegram PR open for maintainer review.

## What This Changes

Fixes Telegram topic stop targeting.

## Real Behavior Proof

Status: mock_only

Evidence kind: none

Needs contributor action: true

Summary: Current proof is test-only for visible Telegram topic behavior.

## Mantis Recommendation

Status: recommended

Scenario: telegram_desktop_proof

Reason: This changes visible Telegram topic behavior that should be proven in native Telegram Desktop.

Maintainer comment: @openclaw-mantis telegram desktop proof: verify that /stop targets the active topic and does not affect other topics.

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Status: none

Reason: Maintainers should review the proof before merge.
	`,
    "none",
  );

  assert.match(comment, /\*\*Mantis proof suggestion\*\*/);
  assert.match(comment, /starts with the OpenClaw Mantis account mention/);
  assert.match(comment, /```text\ntelegram desktop proof:/);
  assert.doesNotMatch(comment, /@openclaw-mantis/);
});

test("pull request review comments suppress unsafe Mantis recommendations", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "83140",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this Telegram PR open for maintainer review.

## Mantis Recommendation

Status: recommended

Scenario: telegram_desktop_proof

Reason: This changes visible Telegram behavior.

Maintainer comment: @${"mantis"} telegram desktop proof

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Status: none

Reason: Maintainers should review the proof before merge.
	`,
    "none",
  );

  assert.doesNotMatch(comment, /\*\*Mantis proof suggestion\*\*/);
  assert.doesNotMatch(comment, /@openclaw-mantis/);
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

test("ClawSweeper proof evidence kind controls media proof labels", () => {
  assert.deepEqual(realBehaviorProofMediaLabelsForTest(["bug"], "screenshot"), [
    "bug",
    "proof: 📸 screenshot",
  ]);
  assert.deepEqual(realBehaviorProofMediaLabelsForTest(["proof: 📸 screenshot"], "recording"), [
    "proof: 🎥 video",
  ]);
  assert.deepEqual(
    realBehaviorProofMediaLabelsForTest(["proof: 📸 screenshot", "proof: 🎥 video"], "terminal"),
    [],
  );
});

test("ClawSweeper proof label sync recognizes missing optional labels", () => {
  assert.equal(
    isMissingGitHubLabelErrorForTest(
      "failed to update https://github.com/openclaw/fs-safe/pull/18: 'proof: sufficient' not found",
      "proof: sufficient",
    ),
    true,
  );
  assert.equal(
    isMissingGitHubLabelErrorForTest(
      "failed to update https://github.com/openclaw/fs-safe/pull/18: 'other label' not found",
      "proof: sufficient",
    ),
    false,
  );
});

test("ClawSweeper PR rating labels use one themed overall label", () => {
  assert.deepEqual(prRatingLabelsForTest(["bug"], "A"), ["bug", "rating: 🦞 diamond lobster"]);
  assert.deepEqual(
    prRatingLabelsForTest(["rating: 🦀 challenger crab", "bug", "rating: 🦐 gold shrimp"], "D"),
    ["bug", "rating: 🦪 silver shellfish"],
  );
  assert.deepEqual(prRatingLabelsForTest(["bug"], "bogus"), [
    "bug",
    "rating: 🌊 off-meta tidepool",
  ]);
});

test("ClawSweeper PR rating label scheme exposes boring internal tiers", () => {
  assert.deepEqual(
    prRatingLabelSchemeForTest().map(({ tier, name, color }) => ({ tier, name, color })),
    [
      { tier: "S", name: "rating: 🦀 challenger crab", color: "1F883D" },
      { tier: "A", name: "rating: 🦞 diamond lobster", color: "0969DA" },
      { tier: "B", name: "rating: 🐚 platinum hermit", color: "0F766E" },
      { tier: "C", name: "rating: 🦐 gold shrimp", color: "B7791F" },
      { tier: "D", name: "rating: 🦪 silver shellfish", color: "7A828E" },
      { tier: "F", name: "rating: 🧂 unranked krab", color: "8C2F39" },
      { tier: "NA", name: "rating: 🌊 off-meta tidepool", color: "6E7781" },
    ],
  );
});

test("ClawSweeper PR status labels use one current workflow status", () => {
  assert.deepEqual(
    prStatusLabelsForTest(["bug", "status: ⏳ waiting on author"], {
      findingPriorities: [2],
      hasRecentAuthorActivity: true,
    }),
    ["bug", "status: 🛠️ actively grinding"],
  );
  assert.deepEqual(
    prStatusLabelsForTest(["bug", "status: 🛠️ actively grinding"], {
      proofStatus: "sufficient",
      overallCorrectness: "patch is correct",
    }),
    ["bug", "status: 👀 ready for maintainer look"],
  );
});

test("ClawSweeper PR status labels preserve other label families", () => {
  assert.deepEqual(
    prStatusLabelsForTest(
      [
        "rating: 🦞 diamond lobster",
        "merge-risk: 🚨 compatibility",
        "proof: sufficient",
        "status: custom-user-label",
      ],
      {
        proofStatus: "missing",
      },
    ),
    [
      "rating: 🦞 diamond lobster",
      "merge-risk: 🚨 compatibility",
      "proof: sufficient",
      "status: custom-user-label",
      "status: 📣 needs proof",
    ],
  );
});

test("ClawSweeper PR status labels respect priority ordering", () => {
  assert.deepEqual(
    prStatusLabelsForTest(["clawsweeper:automerge"], {
      proofStatus: "missing",
      hasRecentReReviewRequest: true,
    }),
    ["clawsweeper:automerge", "status: 🚀 automerge armed"],
  );
  assert.deepEqual(
    prStatusLabelsForTest([], {
      proofStatus: "missing",
      hasRecentAuthorActivity: true,
      hasRecentReReviewRequest: true,
    }),
    ["status: 🔁 re-review loop"],
  );
  assert.deepEqual(
    prStatusLabelsForTest([], {
      proofStatus: "missing",
      hasRecentAuthorActivity: true,
    }),
    ["status: 🛠️ actively grinding"],
  );
  assert.deepEqual(
    prStatusLabelsForTest([], {
      proofStatus: "missing",
    }),
    ["status: 📣 needs proof"],
  );
  assert.deepEqual(
    prStatusLabelsForTest([], {
      findingPriorities: [2],
    }),
    ["status: ⏳ waiting on author"],
  );
});

test("ClawSweeper PR status ignores bot-authored re-review guidance", () => {
  assert.deepEqual(
    prStatusLabelsForTest([], {
      proofStatus: "missing",
      reviewedAt: "2026-01-01T00:00:00Z",
      comments: [
        {
          author: "openclaw-clawsweeper[bot]",
          body: "After adding proof, comment `@clawsweeper re-review`.",
          updatedAt: "2026-01-01T00:01:00Z",
        },
      ],
    }),
    ["status: 📣 needs proof"],
  );
  assert.deepEqual(
    prStatusLabelsForTest([], {
      proofStatus: "missing",
      reviewedAt: "2026-01-01T00:00:00Z",
      comments: [
        {
          author: "contributor",
          body: "@clawsweeper re-review",
          createdAt: "2026-01-01T00:01:00Z",
        },
      ],
    }),
    ["status: 🔁 re-review loop"],
  );
});

test("ClawSweeper PR status treats maintainer-only rank-up moves as ready", () => {
  assert.deepEqual(
    prStatusLabelsForTest([], {
      nextSteps: [
        "Maintainer accepts the relative details.reportPath contract change before merge.",
      ],
      proofStatus: "sufficient",
      overallCorrectness: "patch is correct",
    }),
    ["status: 👀 ready for maintainer look"],
  );
});

test("ClawSweeper PR status labels are PR-only", () => {
  assert.deepEqual(
    prStatusLabelsForTest(["bug", "status: ⏳ waiting on author"], {
      isPullRequest: false,
      nextSteps: ["Add proof."],
    }),
    ["bug"],
  );
});

test("ClawSweeper PR status label scheme exposes workflow states", () => {
  assert.deepEqual(
    prStatusLabelSchemeForTest().map(({ kind, name, color }) => ({ kind, name, color })),
    [
      { kind: "automerge_armed", name: "status: 🚀 automerge armed", color: "0E8A16" },
      { kind: "re_review_loop", name: "status: 🔁 re-review loop", color: "8250DF" },
      { kind: "actively_grinding", name: "status: 🛠️ actively grinding", color: "0969DA" },
      { kind: "needs_proof", name: "status: 📣 needs proof", color: "D93F0B" },
      { kind: "waiting_on_author", name: "status: ⏳ waiting on author", color: "FBCA04" },
      {
        kind: "ready_for_maintainer_look",
        name: "status: 👀 ready for maintainer look",
        color: "2DA44E",
      },
    ],
  );
});

test("ClawSweeper Telegram proof judgement controls the Mantis proof label", () => {
  assert.deepEqual(telegramVisibleProofLabelsForTest(["channel: telegram"], "needed"), [
    "channel: telegram",
    "mantis: telegram-visible-proof",
  ]);
  assert.deepEqual(
    telegramVisibleProofLabelsForTest(
      ["channel: telegram", "mantis: telegram-visible-proof"],
      "not_needed",
    ),
    ["channel: telegram"],
  );
});

test("ClawSweeper priority label scheme exposes P0 through P3 labels", () => {
  assert.deepEqual(priorityLabelSchemeForTest(), [
    {
      name: "P0",
      color: "B60205",
      description: "Emergency: data loss, security bypass, crash loop, or unusable core runtime.",
    },
    {
      name: "P1",
      color: "D93F0B",
      description: "Urgent regression or broken agent/channel workflow affecting real users now.",
    },
    {
      name: "P2",
      color: "FBCA04",
      description: "Normal priority bug or improvement with limited blast radius.",
    },
    {
      name: "P3",
      color: "8C959F",
      description: "Low-risk cleanup, docs, polish, ergonomics, or speculative feature.",
    },
  ]);
});

test("ClawSweeper priority label descriptions fit GitHub label limits", () => {
  for (const label of priorityLabelSchemeForTest()) {
    assert.ok(
      label.description.length <= 100,
      `${label.name} description is ${label.description.length} characters`,
    );
  }
});

test("ClawSweeper priority label descriptions stay aligned with prompt and schema", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      triagePriority?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.triagePriority?.description ?? "";
  const prompt = reviewPromptTemplate();
  for (const label of priorityLabelSchemeForTest()) {
    assert.ok(
      prompt.includes(`\`${label.name}\`: ${label.description}`),
      `${label.name} description is missing from the review prompt`,
    );
    assert.ok(
      schemaDescription.includes(`${label.name}: ${label.description}`),
      `${label.name} description is missing from the schema`,
    );
  }
});

test("ClawSweeper priority labels follow triage priority", () => {
  assert.deepEqual(priorityLabelsForTest(["bug"], "P2"), ["bug", "P2"]);
  assert.deepEqual(priorityLabelsForTest(["bug", "P3"], "P1"), ["bug", "P1"]);
  assert.deepEqual(priorityLabelsForTest(["P0", "bug"], "none"), ["bug"]);
});

test("ClawSweeper label justifications render selected label reasons", () => {
  assert.equal(
    labelJustificationsMarkdownForTest([
      {
        label: "P1",
        reason: "The PR changes an active channel workflow affecting real users.",
      },
      {
        label: "impact:message-loss",
        reason: "The diff touches message retry and delivery ordering.",
      },
      {
        label: "merge-risk: 🚨 compatibility",
        reason: "Merging changes the default upgrade behavior for existing configs.",
      },
    ]),
    [
      "- `P1`: The PR changes an active channel workflow affecting real users.",
      "- `impact:message-loss`: The diff touches message retry and delivery ordering.",
      "- `merge-risk: 🚨 compatibility`: Merging changes the default upgrade behavior for existing configs.",
    ].join("\n"),
  );
});

test("ClawSweeper impact label scheme exposes owned impact labels", () => {
  assert.deepEqual(impactLabelSchemeForTest(), [
    {
      name: "impact:data-loss",
      color: "B60205",
      description:
        "This issue is about lost, corrupted, or silently dropped user/session/config data.",
    },
    {
      name: "impact:security",
      color: "B60205",
      description:
        "This issue is about security boundaries, credentials, authz, sandboxing, or sensitive data.",
    },
    {
      name: "impact:crash-loop",
      color: "D93F0B",
      description:
        "This issue is about crashes, hangs, restart loops, or process-level availability.",
    },
    {
      name: "impact:message-loss",
      color: "D93F0B",
      description:
        "This issue is about lost, duplicated, misrouted, or suppressed channel messages.",
    },
    {
      name: "impact:session-state",
      color: "F9D65C",
      description:
        "This issue is about session, memory, transcript, context, or agent state drift.",
    },
    {
      name: "impact:auth-provider",
      color: "F9D65C",
      description:
        "This issue is about auth, provider routing, model choice, or SecretRef resolution.",
    },
  ]);
});

test("ClawSweeper impact label descriptions fit GitHub label limits", () => {
  for (const label of impactLabelSchemeForTest()) {
    assert.ok(
      label.description.length <= 100,
      `${label.name} description is ${label.description.length} characters`,
    );
  }
});

test("ClawSweeper impact label descriptions stay aligned with prompt and schema", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      impactLabels?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.impactLabels?.description ?? "";
  const prompt = reviewPromptTemplate();
  for (const label of impactLabelSchemeForTest()) {
    assert.ok(
      prompt.includes(`\`${label.name}\`: ${label.description}`),
      `${label.name} description is missing from the review prompt`,
    );
    assert.ok(
      schemaDescription.includes(`${label.name}: ${label.description}`),
      `${label.name} description is missing from the schema`,
    );
  }
});

test("ClawSweeper impact label schema avoids unsupported response-format keywords", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      impactLabels?: Record<string, unknown>;
    };
  };
  assert.equal(schema.properties?.impactLabels?.uniqueItems, undefined);
});

test("ClawSweeper merge-risk label scheme exposes PR-only merge warning labels", () => {
  assert.deepEqual(mergeRiskLabelSchemeForTest(), [
    {
      name: "merge-risk: 🚨 compatibility",
      color: "D1242F",
      description:
        "🚨 Merging this PR could break existing users, config, migrations, defaults, or upgrades.",
    },
    {
      name: "merge-risk: 🚨 message-delivery",
      color: "D1242F",
      description:
        "🚨 Merging this PR could drop, duplicate, misroute, suppress, or wrongly target messages.",
    },
    {
      name: "merge-risk: 🚨 session-state",
      color: "F97316",
      description:
        "🚨 Merging this PR could lose, corrupt, stale, or mis-associate session or agent state.",
    },
    {
      name: "merge-risk: 🚨 auth-provider",
      color: "F97316",
      description:
        "🚨 Merging this PR could break OAuth, tokens, provider routing, model choice, or credentials.",
    },
    {
      name: "merge-risk: 🚨 security-boundary",
      color: "B60205",
      description:
        "🚨 Merging this PR could weaken sandboxing, authorization, credentials, or sensitive data.",
    },
    {
      name: "merge-risk: 🚨 availability",
      color: "D93F0B",
      description:
        "🚨 Merging this PR could cause crashes, hangs, restart loops, stalls, or process outages.",
    },
    {
      name: "merge-risk: 🚨 automation",
      color: "FBCA04",
      description:
        "🚨 Merging this PR could break CI, automerge, proof capture, label sync, or automation.",
    },
  ]);
});

test("ClawSweeper merge-risk label descriptions fit GitHub label limits", () => {
  for (const label of mergeRiskLabelSchemeForTest()) {
    assert.ok(
      label.description.length <= 100,
      `${label.name} description is ${label.description.length} characters`,
    );
  }
});

test("ClawSweeper merge-risk label descriptions stay aligned with prompt and schema", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      mergeRiskLabels?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.mergeRiskLabels?.description ?? "";
  const prompt = reviewPromptTemplate();
  for (const label of mergeRiskLabelSchemeForTest()) {
    assert.ok(
      prompt.includes(`\`${label.name}\`: ${label.description}`),
      `${label.name} description is missing from the review prompt`,
    );
    assert.ok(
      schemaDescription.includes(`${label.name}: ${label.description}`),
      `${label.name} description is missing from the schema`,
    );
  }
});

test("ClawSweeper merge-risk labels remove stale owned labels and preserve unrelated labels", () => {
  assert.deepEqual(
    mergeRiskLabelsForTest(
      ["bug", "merge-risk: 🚨 compatibility", "merge-risk: 🚨 availability", "impact:message-loss"],
      ["merge-risk: 🚨 message-delivery", "merge-risk: 🚨 automation", "not-a-merge-risk-label"],
    ),
    ["bug", "impact:message-loss", "merge-risk: 🚨 message-delivery", "merge-risk: 🚨 automation"],
  );
  assert.deepEqual(mergeRiskLabelsForTest(["bug", "merge-risk: 🚨 auth-provider"], []), ["bug"]);
});

test("ClawSweeper impact labels remove stale owned labels and preserve unrelated labels", () => {
  assert.deepEqual(
    impactLabelsForTest(
      ["bug", "impact:data-loss", "impact:security", "proof: sufficient", "P1"],
      ["impact:message-loss", "impact:session-state", "not-an-impact-label"],
    ),
    ["bug", "proof: sufficient", "P1", "impact:message-loss", "impact:session-state"],
  );
  assert.deepEqual(impactLabelsForTest(["bug", "impact:auth-provider"], []), ["bug"]);
});

test("ClawSweeper impact labels do not alter PR review finding priorities", () => {
  const decision = parseDecision(
    closeDecision({
      impactLabels: ["impact:data-loss", "impact:security"],
      labelJustifications: [
        {
          label: "P2",
          reason: "Normal priority applies to this limited-scope implemented behavior check.",
        },
        {
          label: "impact:data-loss",
          reason: "The selected labels include a data-loss impact classification.",
        },
        {
          label: "impact:security",
          reason: "The selected labels include a security impact classification.",
        },
      ],
      reviewFindings: [
        {
          title: "A concrete review finding",
          body: "This remains a PR review finding priority, not an impact label.",
          priority: 1,
          confidenceScore: 0.9,
          file: "src/example.ts",
          lineStart: 10,
          lineEnd: 10,
        },
      ],
    }),
  );
  assert.deepEqual(decision.impactLabels, ["impact:data-loss", "impact:security"]);
  assert.equal(decision.reviewFindings[0]?.priority, 1);
});

test("ClawSweeper issue advisory labels expose high-confidence reproduction state", () => {
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "reproduced",
      reproductionConfidence: "high",
    }),
    ["bug", "issue-rating: 🦀 challenger crab", "clawsweeper:current-main-repro"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "source_reproducible",
      reproductionConfidence: "high",
    }),
    ["bug", "issue-rating: 🦞 diamond lobster", "clawsweeper:source-repro"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "reproduced",
      reproductionConfidence: "medium",
    }),
    ["bug", "issue-rating: 🐚 platinum hermit"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "not_reproduced",
      reproductionConfidence: "high",
    }),
    ["bug", "issue-rating: 🦪 silver shellfish", "clawsweeper:not-repro-on-main"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "source_reproducible",
      reproductionConfidence: "medium",
    }),
    ["bug", "issue-rating: 🐚 platinum hermit", "clawsweeper:needs-live-repro"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "unclear",
      reproductionConfidence: "low",
    }),
    ["bug", "issue-rating: 🦪 silver shellfish", "clawsweeper:needs-info"],
  );
});

test("ClawSweeper issue advisory labels expose work-lane routing state", () => {
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["clawsweeper"], {
      type: "issue",
      workCandidate: "queue_fix_pr",
      workStatus: "candidate",
      workConfidence: "high",
      hasWorkShape: true,
    }),
    [
      "clawsweeper",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:queueable-fix",
      "clawsweeper:fix-shape-clear",
    ],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["clawsweeper"], {
      type: "issue",
      workCandidate: "queue_fix_pr",
      workStatus: "candidate",
      workConfidence: "medium",
    }),
    ["clawsweeper", "issue-rating: 🧂 unranked krab"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["clawsweeper"], {
      type: "issue",
      workCandidate: "manual_review",
    }),
    [
      "clawsweeper",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:no-new-fix-pr",
      "clawsweeper:needs-maintainer-review",
    ],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["clawsweeper"], {
      type: "issue",
      workStatus: "manual_review",
    }),
    [
      "clawsweeper",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:no-new-fix-pr",
      "clawsweeper:needs-maintainer-review",
    ],
  );
});

test("ClawSweeper issue advisory labels expose linked PR and human decision blockers", () => {
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      hasOpenLinkedPullRequest: true,
    }),
    [
      "bug",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:linked-pr-open",
      "clawsweeper:no-new-fix-pr",
    ],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      requiresProductDecision: true,
    }),
    [
      "bug",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:no-new-fix-pr",
      "clawsweeper:needs-product-decision",
    ],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      securityReviewStatus: "needs_attention",
    }),
    [
      "bug",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:no-new-fix-pr",
      "clawsweeper:needs-security-review",
    ],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      itemCategory: "security",
    }),
    [
      "bug",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:no-new-fix-pr",
      "clawsweeper:needs-security-review",
    ],
  );
});

test("ClawSweeper issue advisory labels remove stale owned labels and preserve other labels", () => {
  assert.deepEqual(
    issueAdvisoryLabelsForTest(
      [
        "bug",
        "clawsweeper:source-repro",
        "clawsweeper:not-repro-on-main",
        "clawsweeper:needs-live-repro",
        "clawsweeper:needs-info",
        "clawsweeper:linked-pr-open",
        "clawsweeper:no-new-fix-pr",
        "clawsweeper:queueable-fix",
        "clawsweeper:fix-shape-clear",
        "clawsweeper:needs-product-decision",
        "clawsweeper:needs-security-review",
        "issue-rating: 🦞 diamond lobster",
        "issue-rating: 🌊 off-meta tidepool",
        "clawsweeper:autofix",
        "clawsweeper:automerge",
        "clawsweeper:human-review",
        "clawsweeper:merge-ready",
        "proof: sufficient",
        "mantis: telegram-visible-proof",
      ],
      {
        type: "issue",
        reproductionStatus: "reproduced",
        reproductionConfidence: "high",
      },
    ),
    [
      "bug",
      "clawsweeper:autofix",
      "clawsweeper:automerge",
      "clawsweeper:human-review",
      "clawsweeper:merge-ready",
      "proof: sufficient",
      "mantis: telegram-visible-proof",
      "issue-rating: 🦀 challenger crab",
      "clawsweeper:current-main-repro",
    ],
  );
});

test("ClawSweeper issue advisory labels do not apply to pull requests", () => {
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "pull_request",
      reproductionStatus: "reproduced",
      reproductionConfidence: "high",
      workCandidate: "queue_fix_pr",
      workStatus: "candidate",
      workConfidence: "high",
      hasOpenLinkedPullRequest: true,
      requiresProductDecision: true,
      securityReviewStatus: "needs_attention",
      hasWorkShape: true,
    }),
    ["bug"],
  );
});

test("review workflow gives Codex a read-only inspection token", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(workflow, /id: codex-inspection-token/);
  assert.match(workflow, /permission-issues: read/);
  assert.match(workflow, /CLAWSWEEPER_PROOF_INSPECTION_TOKEN/);
});

test("read-only checkout mode restores file modes and leaves git metadata writable", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const target = join(root, "target");
    const nested = join(target, "src");
    const gitDir = join(target, ".git");
    mkdirSync(nested, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    const sourceFile = join(nested, "app.ts");
    const executableFile = join(target, "tool.sh");
    const gitConfig = join(gitDir, "config");
    writeFileSync(sourceFile, "export const value = 1;\n");
    writeFileSync(executableFile, "#!/bin/sh\n");
    writeFileSync(gitConfig, "[core]\n");
    chmodSync(target, 0o755);
    chmodSync(nested, 0o750);
    chmodSync(sourceFile, 0o640);
    chmodSync(executableFile, 0o755);
    chmodSync(gitDir, 0o700);
    chmodSync(gitConfig, 0o600);

    const snapshots = makeTreeReadOnlyForTest(target);
    assert.equal(statSync(target).mode & 0o777, 0o555);
    assert.equal(statSync(nested).mode & 0o777, 0o555);
    assert.equal(statSync(sourceFile).mode & 0o777, 0o444);
    assert.equal(statSync(executableFile).mode & 0o777, 0o555);
    assert.equal(statSync(gitDir).mode & 0o777, 0o700);
    assert.equal(statSync(gitConfig).mode & 0o777, 0o600);

    restoreTreeModesForTest(snapshots);
    assert.equal(statSync(target).mode & 0o777, 0o755);
    assert.equal(statSync(nested).mode & 0o777, 0o750);
    assert.equal(statSync(sourceFile).mode & 0o777, 0o640);
    assert.equal(statSync(executableFile).mode & 0o777, 0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("event review completion removes ClawSweeper eyes reaction", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const block = workflow.slice(
    workflow.indexOf("- name: React to target item completion"),
    workflow.indexOf("\n\n  plan:"),
  );

  assert.match(block, /-f content="\+1"/);
  assert.match(block, /-f content="eyes"/);
  assert.match(block, /repos\/\$TARGET_REPO\/issues\/\$ITEM_NUMBER\/reactions\/\$reaction_id/);
  assert.match(block, /"openclaw-clawsweeper\[bot\]"/);
  assert.doesNotMatch(block, /issues\/comments\/\$ITEM_NUMBER\/reactions/);
});

test("event re-review status explains superseded cancellations", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const block = workflow.slice(
    workflow.indexOf("- name: Mark re-review complete"),
    workflow.indexOf("- name: Commit event comment router ledger"),
  );

  assert.match(block, /\[ "\$REVIEW_OUTCOME" = "cancelled" \]/);
  assert.match(block, /state="Superseded"/);
  assert.match(block, /A newer re-review for this item started before this run finished/);
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

test("sweep workflow requires hatch command dispatch provenance for PR egg images", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(workflow, /types: \[clawsweeper_item, clawsweeper_hatch\]/);
  assert.doesNotMatch(workflow, /^\s+hatch_pr_egg_image:\s*$/m);
  assert.match(
    workflow,
    /github\.event_name == 'repository_dispatch' && github\.event\.action == 'clawsweeper_hatch'/,
  );
  assert.match(
    workflow,
    /hatch_pr_egg_image="\$\{\{ github\.event_name == 'repository_dispatch' && github\.event\.action == 'clawsweeper_hatch' && github\.event\.client_payload\.hatch_pr_egg_image == 'true' && 'true' \|\| 'false' \}\}"/,
  );
  assert.doesNotMatch(workflow, /github\.event\.inputs\.hatch_pr_egg_image/);
});

test("sweep workflow publishes target-scoped state paths", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(workflow, /target_slug="\$TARGET_REPO"/);
  assert.match(workflow, /--path "records\/\$\{target_slug\}"/);
  assert.match(workflow, /--path "results\/sweep-status\/\$\{target_slug\}\.json"/);
  assert.doesNotMatch(workflow, /--path records\s*\\/);
  assert.doesNotMatch(workflow, /--path results\/sweep-status\s*\\/);
});

test("sweep workflow schedules cursor-based PR comment sync batches", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(workflow, /cron: "6,21,36,51 \* \* \* \*"/);
  assert.doesNotMatch(workflow, /apply_sync_open_pr_batch:/);
  assert.match(
    workflow,
    /sync_batch_size="\$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.apply_limit \|\| '25' \}\}"/,
  );
  assert.match(workflow, /\$item_numbers" = "__cursor__"/);
  assert.match(workflow, /comment-sync-batch/);
  assert.match(workflow, /write-comment-sync-cursor/);
  assert.match(workflow, /results\/comment-sync-cursors\/\$\{target_slug\}\.json/);
  assert.match(workflow, /APPLY_SYNC_OPEN_PR_BATCH/);
  assert.match(workflow, /github\.event\.schedule == '6,21,36,51 \* \* \* \*'/);
});

test("sweep target checkouts retry without cached references", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const checkoutBlocks =
    workflow.match(/- name: Check out target repository[\s\S]*?rev-parse --short HEAD/g) ?? [];

  assert.equal(checkoutBlocks.length, 2);
  for (const block of checkoutBlocks) {
    assert.match(block, /Cached target repository fetch failed; rebuilding cache/);
    assert.match(block, /Cached target checkout failed; retrying without cache reference/);
    assert.match(block, /rm -rf "\$checkout_dir" "\$cache_dir"/);
    assert.match(
      block,
      /git clone --filter=blob:none --branch main --single-branch "\$url" "\$checkout_dir"/,
    );
  }
});

test("sweep planning-started status publish is bounded", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const block = workflow.slice(
    workflow.indexOf("- name: Publish planning-started status"),
    workflow.indexOf("- id: mode"),
  );

  assert.match(block, /timeout 20s pnpm run repair:publish-main/);
  assert.match(block, /Skipped slow planning-started dashboard publish/);
});

test("review capacity probes use REST actions run listing", () => {
  const sweepWorkflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const sweepBlock = sweepWorkflow.slice(
    sweepWorkflow.indexOf("- id: mode"),
    sweepWorkflow.indexOf("- id: select"),
  );
  const commitWorkflow = readFileSync(".github/workflows/commit-review.yml", "utf8");
  const commitBlock = commitWorkflow.slice(
    commitWorkflow.indexOf("- name: Select commits"),
    commitWorkflow.indexOf('if [ "$ENABLED" = "false" ]'),
  );

  for (const block of [sweepBlock, commitBlock]) {
    assert.match(block, /active_runs_json\(\)/);
    assert.match(block, /actions\/runs\?per_page=100/);
    assert.match(block, /status=\$\{run_status\}/);
    assert.match(block, /workflowName:\.name/);
    assert.match(block, /displayTitle:\.display_title/);
    assert.doesNotMatch(block, /gh run list/);
  }
});

test("background review capacity reserves expanding matrices and caps broad manual input", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("- id: select"),
  );
  const commitWorkflow = readFileSync(".github/workflows/commit-review.yml", "utf8");
  const commitBlock = commitWorkflow.slice(
    commitWorkflow.indexOf("- name: Select commits"),
    commitWorkflow.indexOf('if [ "$ENABLED" = "false" ]'),
  );

  assert.match(modeBlock, /limit review_shards\.hot_intake_default/);
  assert.match(modeBlock, /limit review_shards\.normal_default/);
  assert.match(modeBlock, /STALE_QUEUED_CUTOFF/);
  assert.match(modeBlock, /updatedAt:\.updated_at/);
  assert.match(modeBlock, /lane_shard_cap="\$normal_shards"/);
  assert.match(modeBlock, /lane_shard_cap="\$hot_intake_shards"/);
  assert.match(modeBlock, /Capping broad background review shards/);
  assert.match(commitBlock, /limit review_shards\.hot_intake_default/);
  assert.match(commitBlock, /limit review_shards\.normal_default/);
});

test("github activity workflow coalesces noisy observer runs", () => {
  const workflow = readFileSync(".github/workflows/github-activity.yml", "utf8");

  assert.match(workflow, /group: >-/);
  assert.match(workflow, /github-activity-\$\{\{ github\.event_name \}\}/);
  assert.match(workflow, /github\.event\.repository\.full_name/);
  assert.match(workflow, /github\.event\.action/);
  assert.match(workflow, /github\.event\.client_payload\.activity\.type/);
  assert.match(workflow, /github\.event\.client_payload\.activity\.action/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.doesNotMatch(
    workflow,
    /group: github-activity-\$\{\{ github\.event_name \}\}-\$\{\{ github\.run_id \}\}/,
  );
  assert.doesNotMatch(workflow, /github\.event\.issue\.number/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.number/);
  assert.doesNotMatch(workflow, /github\.event\.client_payload\.activity\.subject\.number/);
});

test("spam comment intake coalesces duplicate comment deliveries", () => {
  const workflow = readFileSync(".github/workflows/spam-comment-intake.yml", "utf8");

  assert.match(workflow, /group: >-/);
  assert.match(workflow, /spam-comment-intake-\$\{\{ github\.event\.client_payload\.target_repo/);
  assert.match(workflow, /github\.event\.client_payload\.comment_id/);
  assert.match(workflow, /github\.event\.client_payload\.review_comment_id/);
  assert.match(workflow, /github\.event\.client_payload\.activity\.comment\.id/);
  assert.match(workflow, /github\.run_id/);
  assert.match(workflow, /cancel-in-progress: true/);
});

test("spam scanner exact dispatches publish only per-comment audit records", () => {
  const workflow = readFileSync(".github/workflows/spam-scanner.yml", "utf8");

  assert.match(workflow, /format\('spam-scanner-\{0\}-issue-comment-\{1\}'/);
  assert.match(workflow, /format\('spam-scanner-\{0\}-review-comment-\{1\}'/);
  assert.match(workflow, /results\/spam-audit\/\$\{target_slug\}\/issue_comment-\$\{id\}\.json/);
  assert.match(
    workflow,
    /results\/spam-audit\/\$\{target_slug\}\/pull_request_review_comment-\$\{id\}\.json/,
  );
  assert.match(workflow, /--path results\/spam-scanner\.json/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("issue implementation workflow lets job intent choose dispatch capacity", () => {
  const workflow = readFileSync(".github/workflows/repair-issue-implementation-intake.yml", "utf8");

  assert.match(workflow, /cap_args=\(\)/);
  assert.match(workflow, /--max-live-workers "\$MAX_LIVE_WORKERS"/);
  assert.match(workflow, /"\$\{cap_args\[@\]\}"/);
  assert.doesNotMatch(workflow, /worker-limit issue_implementation/);
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
  assert.match(itemPrompt, /Always fill `triagePriority`/);
  assert.match(itemPrompt, /maintainers\s+can find issues and pull requests\s+by priority/);
  assert.match(itemPrompt, /not just\s+from PR review findings/);
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

  assert.match(
    workflow,
    /- name: Review shard\r?\n\s+id: review-shard\r?\n\s+continue-on-error: true/,
  );
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
