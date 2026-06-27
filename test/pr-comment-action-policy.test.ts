import assert from "node:assert/strict";
import test from "node:test";

import { renderReviewCommentFromReport } from "../dist/clawsweeper.js";
import { reportFrontMatter } from "./helpers.ts";

test("pull request review comments stay compact and action-first", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "83400",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "queue_fix_pr",
      pull_head_sha: "abc123def456",
      merge_risk_options: JSON.stringify([
        {
          title: "Repair delivery before merge",
          body: "Fix duplicate active-requester delivery and add regression coverage before merge.",
          category: "fix_before_merge",
          recommended: true,
          automergeInstruction:
            "@clawsweeper autofix this PR: prevent duplicate active-requester delivery and add focused regression coverage before merging.",
        },
      ]),
    })}

## Summary

Keep this PR open because the delivery repair is still needed.

## What This Changes

Updates generated review-comment formatting.

## Best Possible Solution

Repair duplicate delivery and add regression coverage before merge.

## Risks / Open Questions

Delivery repair should not run with nested bot commands in the pasteable instruction.

## Work Candidate

Candidate: queue_fix_pr

Confidence: high

Priority: medium

Status: ready

Reason: prevent duplicate active-requester delivery and add focused regression coverage before merging.

## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.91

Full review comments:

- [P2] Prevent duplicate delivery: \`src/runtime.ts:12\`
`,
    "none",
  );

  assert.match(comment, /\*\*Action\*\*\nAction: Dita should queue a fix-only repair/);
  assert.match(comment, /\*\*Repair target:\*\*/);
  assert.doesNotMatch(comment, /@clawsweeper automerge/);
  assert.doesNotMatch(comment, /@clawsweeper autofix/);
  assert.doesNotMatch(comment, /Copy recommended automerge instruction/);
  assert.doesNotMatch(comment, /<summary>Review details<\/summary>/);
  assert.doesNotMatch(comment, /<summary>Evidence reviewed<\/summary>/);
  assert.ok(comment.length < 4000, `comment was ${comment.length} chars`);
});
