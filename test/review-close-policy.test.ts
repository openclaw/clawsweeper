import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  fixedPullRequestFromCommitPullsForTest,
  isProtectedItem,
  parseGhJson,
  parseGhJsonLines,
  parseGhJsonWithRetry,
  protectedLabels,
  reviewAutomationMarkersFromReport,
  renderReviewCommentFromReport,
  reviewActionForDecision,
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
import { closeDecision, git, item, reportFrontMatter } from "./helpers.ts";

test("review prompt documents gated backlog close policies", () => {
  const prompt = readFileSync(new URL("../prompts/review-item.md", import.meta.url), "utf8");
  const sweepWorkflow = readFileSync(
    new URL("../.github/workflows/sweep.yml", import.meta.url),
    "utf8",
  );
  assert.match(prompt, /`unsponsored_feature_request`/);
  assert.match(prompt, /reversible idea-archive park, not a rejection/);
  assert.match(prompt, /label whose normalized name contains `security`/);
  assert.match(prompt, /configured positive-reaction threshold automatically reopens it/);
  assert.match(prompt, /commenting `@clawsweeper revive`/);
  assert.match(prompt, /no human comment in the last 60 days/);
  assert.match(prompt, /significantly outdated version or behavior/);
  assert.match(prompt, /not cleanly mergeable \(merge conflicts\) on its current head/);
  assert.match(prompt, /`author_pr_budget_exceeded`/);
  assert.match(prompt, /Never propose this reason when the author open-PR count is unknown/);
  assert.match(prompt, /default path is apply-side deterministic promotion/);
  assert.equal(
    [...sweepWorkflow.matchAll(/CLAWSWEEPER_IDEA_REVIVAL_REACTIONS:.*\|\| '5'/g)].length,
    2,
  );
});

test("unsponsored feature issue proposals emit source-bound trusted close markers", () => {
  const markers = reviewAutomationMarkersFromReport(
    reportFrontMatter({
      type: "issue",
      number: 321,
      decision: "close",
      confidence: "high",
      close_reason: "unsponsored_feature_request",
      action_taken: "proposed_close",
      item_updated_at: "2026-01-01T00:00:00Z",
      reviewed_at: "2026-07-11T00:00:00Z",
      item_source_revision: "0123456789abcdef",
    }),
  );
  assert.match(markers, /clawsweeper-verdict:close/);
  assert.match(markers, /clawsweeper-action:close-required/);
  assert.match(markers, /reason=unsponsored_feature_request/);
  assert.match(markers, /source_revision=0123456789abcdef/);
  assert.doesNotMatch(markers, /needs-human/);
});

test("protected labels are normalized and only maintainer-only items stay plannable", () => {
  assert.deepEqual(protectedLabels(["Security", "bug", "maintainer", "SECURITY"]), [
    "security",
    "maintainer",
  ]);
  assert.equal(isProtectedItem(item({ labels: ["release-blocker"] })), true);
  assert.equal(shouldPlanItem(item({ authorAssociation: "MEMBER" })), true);
  assert.equal(shouldPlanItem(item({ labels: ["maintainer"] })), true);
  assert.equal(shouldPlanItem(item({ labels: ["maintainer", "security"] })), false);
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

test("parseGhJsonWithRetry reloads malformed successful responses", () => {
  const responses = ['{"items":', '{"items":[1]}'];
  const retries: number[] = [];
  const parsed = parseGhJsonWithRetry<{ items: number[] }>(
    () => responses.shift() ?? "",
    ["api", "repos/openclaw/openclaw/pulls/42/files"],
    { onRetry: (_error, attempt) => retries.push(attempt) },
  );

  assert.deepEqual(parsed, { items: [1] });
  assert.deepEqual(retries, [1]);
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

test("PR close-exemption labels produce a distinct guarded-open action", () => {
  const cases = [
    ["clawsweeper:human-review", "unconfirmed_product_direction", "product-direction"],
    ["clawsweeper:manual-only", "stalled_unproven_pr", "stalled-unproven"],
    ["clawsweeper:automerge", "abandoned_pr", "abandoned-PR"],
    ["clawsweeper:autofix", "stalled_unproven_pr", "stalled-unproven"],
  ] as const;

  for (const [label, closeReason, reasonText] of cases) {
    const pr = item({
      kind: "pull_request",
      url: "https://github.com/openclaw/openclaw/pull/123",
      labels: [label],
    });
    const validation = validateCloseDecision(pr, closeDecision({ closeReason }));
    assert.equal(validation.ok, false, label);
    assert.equal(validation.actionTaken, "skipped_close_exempt_label", label);
    assert.match(validation.reason, new RegExp(`${label} exempts this PR from ${reasonText}`));

    const action = reviewActionForDecision({
      item: pr,
      decision: closeDecision({ closeReason }),
      git,
    });
    assert.equal(action.actionTaken, "skipped_close_exempt_label", label);
    assert.equal(action.closeComment, "", label);
  }
});

test("verified fixed maintainer items can become close proposals", () => {
  const validation = validateCloseDecision(item({ labels: ["maintainer"] }), closeDecision());
  assert.deepEqual(validation, { ok: true });

  const action = reviewActionForDecision({
    item: item({ authorAssociation: "MEMBER", labels: ["maintainer"] }),
    decision: closeDecision(),
    git,
  });
  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /already implemented/);
});

test("maintainer items stay protected for non-fixed close reasons", () => {
  const validation = validateCloseDecision(
    item({ labels: ["maintainer"] }),
    closeDecision({ closeReason: "duplicate_or_superseded" }),
  );
  assert.equal(validation.ok, false);
  assert.equal(validation.actionTaken, "skipped_protected_label");

  const action = reviewActionForDecision({
    item: item({ authorAssociation: "MEMBER" }),
    decision: closeDecision({ closeReason: "duplicate_or_superseded" }),
    git,
  });
  assert.equal(action.actionTaken, "skipped_maintainer_authored");
  assert.equal(action.closeComment, "");
});

test("review actions only propose valid closes and never apply directly", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision(),
    git,
    runtime: { model: "gpt-5.6-sol", reasoningEffort: "high" },
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
  assert.match(action.closeComment, /Codex review notes: model gpt-5\.6-sol, reasoning high;/);
});

test("review actions render deterministic close comments when model close comment is empty", () => {
  const decision = closeDecision({ closeComment: "" });
  const action = reviewActionForDecision({
    item: item(),
    decision,
    git,
    runtime: { model: "gpt-5.6-sol", reasoningEffort: "high" },
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
    runtime: { model: "gpt-5.6-sol", reasoningEffort: "high" },
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
  const fixedPullRequest = fixedPullRequestFromCommitPullsForTest(
    [
      {
        number: 455,
        html_url: "https://github.com/openclaw/openclaw/pull/455",
        title: "fix: older candidate",
        merged: true,
        merged_at: "2026-04-27T12:00:00Z",
        merge_commit_sha: "1111111111111111",
        body: "Fixes openclaw/openclaw#123",
        base: { ref: "main" },
      },
      {
        number: 456,
        html_url: "https://github.com/openclaw/openclaw/pull/456",
        title: "fix: wire the shell check",
        merged_at: "2026-04-28T12:00:00Z",
        merge_commit_sha: "fedcba9876543210",
        body: "Resolves https://github.com/openclaw/openclaw/issues/123",
        base: { ref: "main" },
      },
      {
        number: 457,
        html_url: "https://github.com/openclaw/openclaw/pull/457",
        title: "open follow-up",
        merged: false,
        body: "Closes #123",
        base: { ref: "main" },
      },
    ],
    123,
  );

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

test("commit PR lookup rejects unrelated closing references at the claimed fixed SHA", () => {
  const fixedPullRequest = fixedPullRequestFromCommitPullsForTest(
    [
      {
        number: 456,
        html_url: "https://github.com/openclaw/openclaw/pull/456",
        title: "fix: unrelated main-head change",
        merged_at: "2026-04-28T12:00:00Z",
        merge_commit_sha: "fedcba9876543210",
        body: "Fixes #999",
      },
      {
        number: 457,
        html_url: "https://github.com/openclaw/openclaw/pull/457",
        title: "fix: mentions the issue without closing it",
        merged_at: "2026-04-29T12:00:00Z",
        merge_commit_sha: "abcdef9876543210",
        body: "Fixes #999; related to #123",
      },
      {
        number: 458,
        html_url: "https://github.com/openclaw/openclaw/pull/458",
        title: "fix: closes the same number in another repository",
        merged_at: "2026-04-30T12:00:00Z",
        merge_commit_sha: "1234567890abcdef",
        body: "Fixes other/repository#123",
      },
    ],
    123,
  );

  assert.equal(fixedPullRequest, null);
});

test("commit PR lookup accepts an exact closing reference in the fixed commit message", () => {
  const pull = {
    number: 456,
    html_url: "https://github.com/openclaw/openclaw/pull/456",
    title: "fix: wire the shell check",
    merged_at: "2026-04-28T12:00:00Z",
    merge_commit_sha: "fedcba9876543210",
    body: "Related to #123",
    base: { ref: "main" },
  };

  assert.equal(
    fixedPullRequestFromCommitPullsForTest([pull], 123, "Fixes other/repository#123"),
    null,
  );
  assert.equal(fixedPullRequestFromCommitPullsForTest([pull], 123, "Fixes #999; see #123"), null);
  assert.equal(
    fixedPullRequestFromCommitPullsForTest([pull], 123, "Fixes openclaw/openclaw#123")?.number,
    456,
  );
});

test("commit PR lookup rejects closing references on a non-default branch", () => {
  const pull = {
    number: 456,
    html_url: "https://github.com/openclaw/openclaw/pull/456",
    title: "fix: backport the shell check",
    merged_at: "2026-04-28T12:00:00Z",
    merge_commit_sha: "fedcba9876543210",
    body: "Fixes #123",
    base: { ref: "release" },
  };

  assert.equal(fixedPullRequestFromCommitPullsForTest([pull], 123), null);
  assert.equal(fixedPullRequestFromCommitPullsForTest([pull], 123, "Fixes #123"), null);
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
      review_model: "gpt-5.6-sol",
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

test("review details show applied AGENTS.md policy status", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision(),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /<summary>Review details<\/summary>/);
  assert.match(action.closeComment, /AGENTS\.md: found and applied where relevant\./);
});

test("review details show missing AGENTS.md policy status", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      agentsPolicyStatus: {
        found: false,
        readFully: false,
        applied: false,
        status: "not_found",
        summary: "No target repository AGENTS.md was found.",
      },
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /AGENTS\.md: not found in the target repository\./);
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
  assert.match(action.closeComment, /ClawHub handoff/);
  assert.match(action.closeComment, /skill, plugin, provider, channel, bundle, or MCP integration/);
  assert.match(action.closeComment, /package metadata\/manifest/);
  assert.match(action.closeComment, /will not open a ClawHub issue or PR/);
  assert.match(action.closeComment, /installable ClawHub package/);
});

test("ClawHub policy allows main-implemented issue and PR close proposals", () => {
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
  assert.equal(implementedIssue.ok, true);

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

test("ClawSweeper policy allows self implemented-on-main issue and PR close proposals", () => {
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
  assert.equal(implementedIssue.ok, true);
});
