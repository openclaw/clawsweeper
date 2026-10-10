import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

import {
  currentClosingPullRequestReferenceFromIssueTimeline,
  isProtectedItem,
  linkedIssueNumbersForPullRequestBody,
  linkedIssueNumbersForImplementationProvenance,
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
import { createStatusContext } from "../dist/clawsweeper-status-context.js";
import { parseCoAuthors } from "../dist/commit-sweeper.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import { closeDecision, git, item, reportFrontMatter, reviewPrompt } from "./helpers.ts";

const { fixedPullRequestFromCommitPulls } = createStatusContext();

function renderedCloseReasons(prompt: string): string[] {
  const section = prompt.slice(
    prompt.indexOf("### Close reasons"),
    prompt.indexOf("### Canonical search and partial work"),
  );
  return [...section.matchAll(/^- `([a-z_]+)`: /gm)].map((match) => match[1]!);
}

test("review prompt renders close reasons from the repository profile for the item kind", () => {
  const schema = JSON.parse(readFileSync("schema/clawsweeper-decision.schema.json", "utf8"));
  const issueReasons = renderedCloseReasons(reviewPrompt("issue"));
  const pullRequestReasons = renderedCloseReasons(reviewPrompt("pull_request"));
  const profile = repositoryProfileFor("openclaw/openclaw");
  // Oversized closure is host-owned and deliberately absent from the model schema.
  assert.deepEqual(
    [...new Set([...Object.values(profile.applyCloseRules).flat(), "none"])]
      .filter((reason) => reason !== "oversized_pull_request")
      .sort(),
    [...schema.properties.closeReason.enum].sort(),
  );
  // Schema compatibility includes reasons that host facts cannot enable in this context.
  assert.deepEqual(
    [...new Set([...issueReasons, ...pullRequestReasons, "none"])].sort(),
    schema.properties.closeReason.enum
      .filter((reason: string) => reason !== "author_pr_budget_exceeded")
      .sort(),
  );
  assert.ok(!pullRequestReasons.includes("author_pr_budget_exceeded"));
  assert.ok(!pullRequestReasons.includes("oversized_pull_request"));
  assert.ok(issueReasons.includes("stale_insufficient_info"));
  assert.ok(!issueReasons.includes("obsolete_fix_pr"));
  assert.ok(pullRequestReasons.includes("obsolete_fix_pr"));
  assert.ok(!pullRequestReasons.includes("stale_insufficient_info"));
  assert.deepEqual(renderedCloseReasons(reviewPrompt("issue", "openclaw/clawhub")), [
    "implemented_on_main",
  ]);
  const closedRepoPrompt = reviewPrompt("pull_request", "steipete/camsnap");
  assert.deepEqual(renderedCloseReasons(closedRepoPrompt), []);
  assert.match(
    closedRepoPrompt,
    /No close reason applies to this item's host facts: keep it open with `closeReason: none`/,
  );
});

test("external desktop-product bugs close without inventing upstream maintainer work", () => {
  const decision = closeDecision({
    closeReason: "not_actionable_in_repo",
    itemCategory: "bug",
    summary:
      "QClaw owns the affected renderer and provider; OpenClaw delivery-evidence and fallback source paths show no defect.",
    closeComment:
      "Please report this QClaw desktop and provider issue to the QClaw application maintainers.",
    workCandidate: "none",
  });
  assert.deepEqual(validateCloseDecision(item(), decision), { ok: true });
  assert.equal(
    reviewActionForDecision({ item: item(), decision, git }).actionTaken,
    "proposed_close",
  );
});

test("close-first triage keeps actionable upstream work and invites better reports", () => {
  for (const closeReason of ["not_actionable_in_repo", "incoherent", "cannot_reproduce"] as const) {
    const decision = closeDecision({
      closeReason,
      itemCategory: "bug",
      summary: "This report does not establish an actionable upstream OpenClaw defect.",
      closeComment:
        "Please reopen with the official OpenClaw version, affected component, and clear reproduction.",
      workCandidate: "none",
    });
    assert.deepEqual(validateCloseDecision(item(), decision), { ok: true }, closeReason);
    assert.equal(
      reviewActionForDecision({ item: item(), decision, git }).actionTaken,
      "proposed_close",
      closeReason,
    );
    for (const securityLabel of [
      "security",
      "impact:security",
      "clawsweeper:needs-security-review",
    ]) {
      assert.equal(
        validateCloseDecision(item({ labels: [securityLabel] }), decision).actionTaken,
        "skipped_protected_label",
        `${closeReason}: ${securityLabel}`,
      );
    }
  }
});

test("all exact-review publication paths inherit the shared automatic-close policy", () => {
  const sweep = parse(readFileSync(".github/workflows/sweep.yml", "utf8"));
  const batch = parse(readFileSync(".github/workflows/exact-review-batch-publish.yml", "utf8"));
  for (const env of [sweep.env, batch.jobs.publish.env]) {
    assert.equal(
      env.CLAWSWEEPER_AUTO_CLOSE_REASONS,
      "${{ vars.CLAWSWEEPER_AUTO_CLOSE_REASONS || 'all' }}",
    );
    for (const name of [
      "UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED",
      "UNSPONSORED_FEATURE_CLOSE_ENABLED",
      "STALE_VERSION_BUG_CLOSE_ENABLED",
      "OBSOLETE_FIX_PR_CLOSE_ENABLED",
      "AUTHOR_PR_BUDGET",
      "AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN",
      "IDEA_REVIVAL_REACTIONS",
    ]) {
      assert.ok(env[`CLAWSWEEPER_${name}`], name);
    }
    assert.equal(env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED, undefined);
  }
  for (const document of [sweep, batch]) {
    for (const job of Object.values(document.jobs) as Array<{ steps?: Array<{ env?: object }> }>) {
      for (const step of job.steps ?? []) assert.equal("CLOSE_REASONS" in (step.env ?? {}), false);
    }
  }
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
  assert.doesNotMatch(action.closeComment, /implementation landing is \[commit/);
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
  // closeDecision owners carry no verified history, so no names are published.
  assert.doesNotMatch(action.closeComment, /Likely related people:|alice|bob|routing candidate/);
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
  const fixingPullRequest = {
    repo: "openclaw/openclaw",
    number: 456,
    url: "https://github.com/openclaw/openclaw/pull/456",
    title: "fix: wire the shell check",
    mergedAt: "2026-04-28T12:00:00Z",
    sha: "fedcba9876543210",
    confidence: "high" as const,
    source: "GitHub closing PR reference",
  };
  assert.deepEqual(
    validateCloseDecision(item(), closeDecision({ fixedPullRequest: fixingPullRequest })),
    { ok: true },
  );
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({ fixedPullRequest: fixingPullRequest }),
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

test("implemented-on-main closure fails closed without a GitHub-verified fixing PR", () => {
  const pullRequest = item({
    kind: "pull_request",
    number: 118679,
    url: "https://github.com/openclaw/openclaw/pull/118679",
  });
  const ambiguousCommit = closeDecision({
    fixedSha: "c2de3206aabbccddeeff00112233445566778899",
    fixedPullRequest: null,
  });
  const noProvenance = validateCloseDecision(pullRequest, ambiguousCommit);
  assert.deepEqual(noProvenance, {
    ok: false,
    actionTaken: "skipped_invalid_decision",
    reason: "implemented-on-main close requires a GitHub-verified fixing pull request",
  });
  assert.equal(
    reviewActionForDecision({ item: pullRequest, decision: ambiguousCommit, git }).actionTaken,
    "skipped_invalid_decision",
  );

  const crossRepository = validateCloseDecision(
    pullRequest,
    closeDecision({
      fixedPullRequest: {
        repo: "other/repository",
        number: 125781,
        url: "https://github.com/other/repository/pull/125781",
        title: "unrelated implementation",
        mergedAt: "2026-04-28T12:00:00Z",
        sha: "c2de3206aabbccddeeff00112233445566778899",
        confidence: "high",
        source: "GitHub closing PR reference",
      },
    }),
  );
  assert.equal(crossRepository.ok, false);
  assert.equal(
    crossRepository.reason,
    "implemented-on-main fixing pull request must be in the reviewed repository",
  );

  const selfReference = validateCloseDecision(
    pullRequest,
    closeDecision({
      fixedPullRequest: {
        repo: "openclaw/openclaw",
        number: 118679,
        url: "https://github.com/openclaw/openclaw/pull/118679",
        title: "the PR being closed",
        mergedAt: "2026-04-28T12:00:00Z",
        sha: "c2de3206aabbccddeeff00112233445566778899",
        confidence: "high",
        source: "GitHub closing PR reference",
      },
    }),
  );
  assert.equal(selfReference.ok, false);
  assert.equal(
    selfReference.reason,
    "implemented-on-main fixing pull request cannot be the pull request being closed",
  );
});

test("PR implementation provenance accepts only explicit same-repository closing issues", () => {
  assert.deepEqual(
    linkedIssueNumbersForPullRequestBody(
      "Fixes #118669\nResolves openclaw/openclaw#118670",
      "openclaw/openclaw",
    ),
    [118669, 118670],
  );
  assert.deepEqual(
    linkedIssueNumbersForPullRequestBody("Fixes #118669.", "openclaw/openclaw"),
    [118669],
  );
  assert.deepEqual(
    linkedIssueNumbersForPullRequestBody(
      "Fixes #118669, fixes #118670 and #118671.",
      "openclaw/openclaw",
    ),
    [118669, 118670, 118671],
  );
  assert.deepEqual(
    linkedIssueNumbersForPullRequestBody(
      "- Fixes #118669 - carried with the current implementation.",
      "openclaw/openclaw",
    ),
    [118669],
  );
  assert.deepEqual(
    linkedIssueNumbersForPullRequestBody(
      "1. Fixes #118669\n- [x] Fixes #118670",
      "openclaw/openclaw",
    ),
    [118669, 118670],
  );
  assert.deepEqual(
    linkedIssueNumbersForPullRequestBody(
      "Resolves https://github.com/openclaw/openclaw/issues/118669",
      "openclaw/openclaw",
    ),
    [118669],
  );
  assert.equal(
    linkedIssueNumbersForPullRequestBody("Fixes other/repository#118669", "openclaw/openclaw"),
    null,
  );
  assert.equal(
    linkedIssueNumbersForPullRequestBody("Related to #118669", "openclaw/openclaw"),
    null,
  );
  assert.equal(
    linkedIssueNumbersForPullRequestBody(
      "Do not write `Fixes #118669` in this explanation.\n\n> Fixes #118670\n\n```md\nFixes #118671\n```\n\n````md\n```\nFixes #118672\n````",
      "openclaw/openclaw",
    ),
    null,
  );
  assert.equal(
    linkedIssueNumbersForPullRequestBody("    Fixes #118669\n\tFixes #118670", "openclaw/openclaw"),
    null,
  );
  assert.equal(
    linkedIssueNumbersForPullRequestBody("\n    - Fixes #118669", "openclaw/openclaw"),
    null,
  );
  assert.deepEqual(
    linkedIssueNumbersForPullRequestBody(
      "<!-- example\n    -->\nFixes #118669",
      "openclaw/openclaw",
    ),
    [118669],
  );
});

test("PR implementation provenance caps linked issue references", () => {
  assert.deepEqual(
    linkedIssueNumbersForImplementationProvenance(
      "Fixes #1\nFixes #2\nFixes #3\nFixes #4\nFixes #5",
      "openclaw/openclaw",
    ),
    [1, 2, 3, 4, 5],
  );
  assert.equal(
    linkedIssueNumbersForImplementationProvenance(
      "Fixes #1\nFixes #2\nFixes #3\nFixes #4\nFixes #5\nFixes #6",
      "openclaw/openclaw",
    ),
    null,
  );
});

test("PR implementation provenance accepts only the current GitHub issue-closing PR", () => {
  assert.equal(
    currentClosingPullRequestReferenceFromIssueTimeline({
      data: {
        repository: {
          issue: {
            state: "CLOSED",
            timelineItems: {
              nodes: [
                {
                  __typename: "ClosedEvent",
                  createdAt: "2026-08-19T12:00:00Z",
                  closer: { __typename: "PullRequest", number: 125023 },
                },
                { __typename: "ReopenedEvent", createdAt: "2026-08-19T12:01:00Z" },
                { __typename: "ClosedEvent", createdAt: "2026-08-19T12:02:00Z", closer: null },
              ],
            },
          },
        },
      },
    }),
    null,
  );
  assert.deepEqual(
    currentClosingPullRequestReferenceFromIssueTimeline({
      data: {
        repository: {
          issue: {
            state: "CLOSED",
            timelineItems: {
              nodes: [
                { __typename: "ReopenedEvent", createdAt: "2026-08-19T12:01:00Z" },
                {
                  __typename: "ClosedEvent",
                  createdAt: "2026-08-19T12:02:00Z",
                  closer: { __typename: "PullRequest", number: 125023 },
                },
              ],
            },
          },
        },
      },
    }),
    { __typename: "PullRequest", number: 125023 },
  );
});

test("commit PR lookup selects the newest merged pull request", () => {
  const fixedPullRequest = fixedPullRequestFromCommitPulls(
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
    "GitHub commit PR lookup",
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
  const fixedPullRequest = fixedPullRequestFromCommitPulls(
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
    "GitHub commit PR lookup",
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
    fixedPullRequestFromCommitPulls(
      [pull],
      "GitHub commit PR lookup",
      123,
      "Fixes other/repository#123",
    ),
    null,
  );
  assert.equal(
    fixedPullRequestFromCommitPulls([pull], "GitHub commit PR lookup", 123, "Fixes #999; see #123"),
    null,
  );
  assert.equal(
    fixedPullRequestFromCommitPulls(
      [pull],
      "GitHub commit PR lookup",
      123,
      "Fixes openclaw/openclaw#123",
    )?.number,
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

  assert.equal(fixedPullRequestFromCommitPulls([pull], "GitHub commit PR lookup", 123), null);
  assert.equal(
    fixedPullRequestFromCommitPulls([pull], "GitHub commit PR lookup", 123, "Fixes #123"),
    null,
  );
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

test("skill-only OpenClaw PRs can close through ClawHub with upload guidance", () => {
  const decision = closeDecision({
    closeReason: "clawhub",
    summary:
      "The branch adds an optional bundled skill and does not change required core behavior.",
    changeSummary: "Adds bundled Higgsfield skill files under skills/higgsfield.",
    systemContext: "",
    architectureDiagram: "",
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

test("ClawHub policy requires verified fixing provenance before main-implemented PR closure", () => {
  const implementedPr = validateCloseDecision(
    item({
      repo: "openclaw/clawhub",
      kind: "pull_request",
      url: "https://github.com/openclaw/clawhub/pull/123",
    }),
    closeDecision(),
  );
  assert.equal(implementedPr.ok, false);
  assert.equal(implementedPr.actionTaken, "skipped_invalid_decision");

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

test("ClawSweeper policy requires verified fixing provenance before self PR closure", () => {
  const implementedPr = validateCloseDecision(
    item({
      repo: "openclaw/clawsweeper",
      kind: "pull_request",
      url: "https://github.com/openclaw/clawsweeper/pull/17",
    }),
    closeDecision(),
  );
  assert.equal(implementedPr.ok, false);
  assert.equal(implementedPr.actionTaken, "skipped_invalid_decision");

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
