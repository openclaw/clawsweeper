import assert from "node:assert/strict";
import test from "node:test";

import {
  canPatchReviewComment,
  isCodexReviewCommentBody,
  renderReviewCommentFromReport,
  renderReviewStartStatusComment,
  reviewAutomationMarkersFromReport,
} from "../dist/clawsweeper.js";
import { detailsBody, reportFrontMatter } from "./helpers.ts";

function implementedCloseReport(overrides = {}) {
  const frontmatter = {
    repository: "openclaw/clawsweeper",
    number: 321,
    type: "issue",
    title: "Render work plans",
    reviewed_at: new Date().toISOString(),
    review_status: "complete",
    local_checkout_access: "verified",
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "implemented_on_main",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-05-01T00:00:00Z",
    item_updated_at: "2026-05-01T00:00:00Z",
    reproduction_status: "reproduced",
    reproduction_confidence: "high",
    fixed_sha: "1234567890abcdef1234567890abcdef12345678",
    fixed_at: "2026-05-01T02:00:00Z",
    ...overrides,
  };
  return [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => key + ": " + value),
    "---",
    "",
    "## Evidence",
    "",
    "- **main fix:** git show confirms current main has the replacement implementation and it is not in the latest release yet",
    "  - file: [src/clawsweeper.ts](https://github.com/openclaw/clawsweeper/blob/1234567890abcdef1234567890abcdef12345678/src/clawsweeper.ts)",
    "  - sha: [1234567890ab](https://github.com/openclaw/clawsweeper/commit/1234567890abcdef1234567890abcdef12345678)",
    "",
    "## Close Comment",
    "",
    "Closing this because the requested behavior is already on main.",
    "",
  ].join("\n");
}

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
      reviewed_at: "2026-05-22T04:43:12.000Z",
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

## AGENTS.md Policy Status

Status: found_applied

Found: true

Read fully: true

Applied: true

Summary: Found AGENTS.md and applied relevant repository review guidance.

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

  assert.match(
    comment,
    /Codex review: needs maintainer review before merge\. _Reviewed May 22, 2026, 12:43 AM ET \/ 04:43 UTC\._/,
  );
  assert.doesNotMatch(comment, /\*\*Latest ClawSweeper review:\*\*/);
  assert.match(
    comment,
    /\*\*Summary\*\*\nAdds regression coverage for session-scoped model overrides\./,
  );
  assert.doesNotMatch(comment, /\*\*Workflow note:\*\*/);
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
  assert.match(
    detailsBody(comment, "Review details"),
    /AGENTS\.md: found and applied where relevant\./,
  );
  assert.doesNotMatch(
    detailsBody(comment, "Evidence reviewed"),
    /AGENTS\.md: found and applied where relevant\./,
  );
  assert.ok(
    comment.indexOf("Is this the best way to solve the issue?") <
      comment.indexOf("<summary>Evidence reviewed</summary>"),
  );
  assert.match(detailsBody(comment, "Evidence reviewed"), /What I checked:/);
  assert.ok(
    comment.indexOf("<summary>Review details</summary>") <
      comment.indexOf("<summary>Evidence reviewed</summary>"),
  );
  assert.ok(
    comment.indexOf("<summary>Evidence reviewed</summary>") <
      comment.indexOf("<summary>What the crustacean ranks mean</summary>"),
  );
  assert.ok(
    comment.indexOf("<summary>What the crustacean ranks mean</summary>") <
      comment.indexOf("<summary>How this review workflow works</summary>"),
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
  assert.doesNotMatch(comment, /\*\*Ways to help us reproduce this\*\*/);
  assert.doesNotMatch(comment, /\*\*Security\*\*/);
  assert.doesNotMatch(comment, /Not applicable:/);
  assert.match(
    comment,
    /Do we have a high-confidence way to reproduce the issue\?\n\nYes\. A source-level reproduction is clear/,
  );
});

test("high-confidence root-cause clusters appear in keep-open review comments", () => {
  const rootCauseCluster = {
    confidence: "high",
    canonicalRef: "https://github.com/openclaw/openclaw/pull/75880",
    currentItemRelationship: "same_root_cause",
    summary: "The issue and candidate PR cover the same reproduced callback failure.",
    members: [
      {
        ref: "https://github.com/openclaw/openclaw/pull/75880",
        relationship: "canonical",
        reason: "This PR contains the focused fix and regression coverage.",
      },
    ],
  };
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "issue",
      number: "75877",
      root_cause_cluster: JSON.stringify(rootCauseCluster),
    })}

## Summary

Keep open while maintainers evaluate the candidate fix.

## Best Possible Solution

Review the linked candidate PR.
`,
    "none",
  );

  assert.match(comment, /\*\*Root-cause cluster\*\*/);
  assert.match(comment, /Relationship: `same_root_cause`/);
  assert.match(comment, /Canonical: https:\/\/github\.com\/openclaw\/openclaw\/pull\/75880/);
  assert.match(comment, /- `canonical`: https:\/\/github\.com\/openclaw\/openclaw\/pull\/75880/);
  assert.match(comment, /Proposal only: this assessment does not dispatch repair/);
});

test("low-confidence root-cause clusters stay out of public comments", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "issue",
      number: "75877",
      root_cause_cluster: JSON.stringify({
        confidence: "low",
        canonicalRef: null,
        currentItemRelationship: "independent",
        summary: "No evidence-backed root-cause cluster was established.",
        members: [],
      }),
    })}

## Summary

Keep open for more evidence.
`,
    "none",
  );

  assert.doesNotMatch(comment, /\*\*Root-cause cluster\*\*/);
  assert.doesNotMatch(comment, /Proposal only: this assessment/);
});

test("high-confidence root-cause clusters appear in close comments", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      root_cause_cluster: JSON.stringify({
        confidence: "high",
        canonicalRef: "https://github.com/openclaw/clawsweeper/issues/400",
        currentItemRelationship: "duplicate",
        summary: "The canonical issue tracks the remaining work.",
        members: [
          {
            ref: "https://github.com/openclaw/clawsweeper/issues/400",
            relationship: "canonical",
            reason: "This issue has the broader accepted scope.",
          },
        ],
      }),
    }),
    "implemented_on_main",
  );

  assert.match(comment, /\*\*Root-cause cluster\*\*/);
  assert.match(comment, /Relationship: `duplicate`/);
  assert.match(comment, /Canonical: https:\/\/github\.com\/openclaw\/clawsweeper\/issues\/400/);
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
  assert.doesNotMatch(comment, /\*\*Workflow note:\*\*/);
  assert.match(comment, /<summary>How this review workflow works<\/summary>/);
  assert.match(
    comment,
    /\*\*Review findings\*\*\n- \[P1\] Validate replace paths — `src\/config\/apply\.ts:42-44`/,
  );
  assert.doesNotMatch(comment, /\*\*\[P[0-2]\]\*\*/);
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
    /\*\*Next step before merge\*\*\n- Land this docs-only PR after maintainer review\./,
  );
  assert.doesNotMatch(comment, /\[P2\] Land this docs-only PR/);
  assert.doesNotMatch(comment, /Best possible solution:/);
});

test("pull request review comments do not priority-prefix routine no-op guidance", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74269",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this narrow PR open for maintainer review.

## PR Rating

Overall tier: B
Proof tier: B
Patch tier: B
Summary: Ready for review.
Next rank-up steps:
- none

## Best Possible Solution

No ClawSweeper repair lane is needed; the submitted PR is narrow and the remaining action is normal maintainer review and CI.
`,
    "none",
  );

  assert.match(comment, /Rank-up moves:\n- none/);
  assert.match(
    comment,
    /\*\*Next step before merge\*\*\n- No ClawSweeper repair lane is needed; the submitted PR is narrow and the remaining action is normal maintainer review and CI\./,
  );
  assert.doesNotMatch(comment, /\[P2\] none/);
  assert.doesNotMatch(comment, /\[P2\] No ClawSweeper repair lane is needed/);
});

test("pull request next-step priority prefixes classify fail-closed work as P1", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74268",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this compatibility PR open for maintainer review.

## What This Changes

Changes relay restart handling.

## Best Possible Solution

Prove the fail-closed compatibility break is handled before merge.
`,
    "none",
  );

  assert.match(
    comment,
    /\*\*Next step before merge\*\*\n- \[P1\] Prove the fail-closed compatibility break is handled before merge\./,
  );
  assert.doesNotMatch(comment, /\*\*\[P1\]\*\*/);
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
    /\*\*Next step before merge\*\*\n- Merge after required checks are green\./,
  );
  assert.doesNotMatch(comment, /\[P2\] Merge after required checks are green/);
  assert.doesNotMatch(comment, /Automerge follow-up:/);
  assert.match(comment, /<!-- clawsweeper-verdict:pass item=74453 sha=abc123def456/);
  assert.doesNotMatch(comment, /clawsweeper-verdict:needs-human/);
});

test("coverage-proof blocked PR reports do not emit repair pass verdicts", () => {
  const markers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74456",
    decision: "keep_open",
    close_reason: "none",
    action_taken: "skipped_pr_close_coverage_proof",
    review_status: "complete",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this superseded PR open until coverage proof passes.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`);

  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
});
