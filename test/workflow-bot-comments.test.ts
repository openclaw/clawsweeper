import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  CLAWSWEEPER_APP_BOT_LOGINS,
  CLAWSWEEPER_APP_SLUG,
  CLAWSWEEPER_BOT_LOGINS,
} from "../dist/clawsweeper-bot-identity.js";
import {
  commandReviewStartLeaseCommentMarker,
  reviewStartLeaseCommentMarker,
} from "../dist/review-comment-markers.js";
import { withQuietReviewStartStatusLease } from "../dist/clawsweeper-review-comment-state.js";

test("workflow failure cleanup discovers only owned in-place leases without selecting them for DELETE", () => {
  const body = withQuietReviewStartStatusLease(
    "Codex review: keep open.\n\n<!-- clawsweeper-review item=42 -->",
    {
      number: 42,
      kind: "issue",
      title: "fixture",
      headSha: "a".repeat(64),
      leaseOwner: "run-1",
      startedAt: "2026-10-01T00:00:00Z",
      leaseExpiresAt: "2026-10-01T01:00:00Z",
    },
  );
  const input = JSON.stringify({ id: 10, user: { login: "clawsweeper[bot]" }, body });
  assert.equal(
    workflowBotComments(
      ["review-lease-comment-ids", "--item-number", "42", "--owner", "run-1", "--in-place"],
      input,
    ),
    "10\n",
  );
  assert.equal(
    workflowBotComments(
      ["review-lease-comment-ids", "--item-number", "42", "--owner", "other", "--in-place"],
      input,
    ),
    "",
  );
  assert.equal(
    workflowBotComments(
      ["review-lease-comment-ids", "--item-number", "42", "--owner", "run-1"],
      input,
    ),
    "",
  );
});

// Workflow steps run the source file with the runner Node before any build.
function workflowBotComments(args: string[], input = ""): string {
  return execFileSync(process.execPath, ["src/workflow-bot-comments.ts", ...args], {
    input,
    encoding: "utf8",
  });
}

test("workflow bot logins print every login ClawSweeper writes as", () => {
  assert.deepEqual(JSON.parse(workflowBotComments(["bot-logins"])), [...CLAWSWEEPER_BOT_LOGINS]);
});

test("workflow lease lookup selects only App-authored lease comments for the item and owner", () => {
  const [bot] = CLAWSWEEPER_APP_BOT_LOGINS;
  const status = (owner: string) =>
    `<!-- clawsweeper-review-status:started item=42 owner=${owner} v=1 -->`;
  const comments = [
    {
      id: 1,
      user: { login: bot },
      body: `${status("run-1")}\n${reviewStartLeaseCommentMarker(42)}`,
    },
    {
      id: 2,
      user: { login: bot },
      body: `${status("run-1")}\n${commandReviewStartLeaseCommentMarker(42)}`,
    },
    {
      id: 3,
      user: { login: "octocat" },
      body: `${status("run-1")}\n${reviewStartLeaseCommentMarker(42)}`,
    },
    {
      id: 4,
      user: { login: CLAWSWEEPER_APP_SLUG },
      body: `${status("run-1")}\n${reviewStartLeaseCommentMarker(42)}`,
    },
    {
      id: 5,
      user: { login: bot },
      body: `${status("run-1")}\n${reviewStartLeaseCommentMarker(420)}`,
    },
    {
      id: 6,
      user: { login: bot },
      body: `${status("run-2")}\n${reviewStartLeaseCommentMarker(42)}`,
    },
  ];
  const input = comments.map((comment) => JSON.stringify(comment)).join("\n");

  assert.deepEqual(
    workflowBotComments(["review-lease-comment-ids", "--item-number", "42"], input).split("\n"),
    ["1", "2", "6", ""],
  );
  assert.deepEqual(
    workflowBotComments(
      ["review-lease-comment-ids", "--item-number", "42", "--owner", "run-1"],
      input,
    ).split("\n"),
    ["1", "2", ""],
  );
});
