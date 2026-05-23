import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  classifyItemWebhook,
  classifyIssueCommentWebhook,
  classifyWebhook,
  renderFastAckComment,
  verifyGitHubSignature,
} from "../../dist/repair/comment-webhook.js";

test("comment webhook accepts maintainer ClawSweeper commands", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw", default_branch: "trunk" },
      issue: { number: 71898 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper automerge",
        author_association: "MEMBER",
      },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "issue_comment",
    targetRepo: "openclaw/openclaw",
    targetBranch: "trunk",
    itemNumber: 71898,
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
  });
});

test("comment webhook rejects contributor commands before visible ack", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 71898 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper automerge",
        author_association: "CONTRIBUTOR",
      },
    },
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason, /not allowed/);
});

test("comment webhook accepts author read-only re-review commands", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 76991, user: { login: "nickmopen" } },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper Re-run",
        author_association: "CONTRIBUTOR",
        user: { login: "NickMOpen" },
      },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "issue_comment",
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 76991,
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
  });
});

test("comment webhook accepts author read-only hatch commands", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 76992, user: { login: "nickmopen" } },
      installation: { id: 123 },
      comment: {
        id: 457,
        body: "@clawsweeper hatch",
        author_association: "CONTRIBUTOR",
        user: { login: "NickMOpen" },
      },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "issue_comment",
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 76992,
    commentId: 457,
    installationId: 123,
    sourceAction: "created",
  });
});

test("comment webhook ignores hatch commands outside OpenClaw repositories", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "steipete/summarize" },
      issue: { number: 76992, user: { login: "nickmopen" } },
      installation: { id: 123 },
      comment: {
        id: 457,
        body: "@clawsweeper hatch",
        author_association: "CONTRIBUTOR",
        user: { login: "NickMOpen" },
      },
    },
  });

  assert.deepEqual(result, { accepted: false, reason: "PR egg is disabled for this repo" });
});

test("comment webhook rejects commands from ineligible repositories", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: {
        full_name: "openclaw/clawsweeper-state",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 1 },
      installation: { id: 123 },
      comment: { body: "/clawsweeper status", author_association: "MEMBER" },
    },
  });

  assert.deepEqual(result, { accepted: false, reason: "repository not eligible" });
});

test("comment webhook rejects non-author read-only re-review commands", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 76991, user: { login: "nickmopen" } },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper re-run",
        author_association: "CONTRIBUTOR",
        user: { login: "somebody-else" },
      },
    },
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason, /not allowed/);
});

test("webhook accepts eligible issue events for generic OpenClaw repositories", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/gogcli",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "item",
    targetRepo: "openclaw/gogcli",
    targetBranch: "main",
    itemNumber: 597,
    itemKind: "issue",
    installationId: 123,
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  });
});

test("webhook accepts eligible pull request events for generic steipete repositories", () => {
  const result = classifyWebhook({
    event: "pull_request",
    payload: {
      action: "synchronize",
      repository: {
        full_name: "steipete/summarize",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      pull_request: { number: 42 },
      installation: { id: 456 },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "item",
    targetRepo: "steipete/summarize",
    targetBranch: "main",
    itemNumber: 42,
    itemKind: "pull_request",
    installationId: 456,
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
  });
});

test("webhook preserves valid repository default branch for item dispatch", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/gogcli",
        default_branch: "trunk",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.targetBranch, "trunk");
});

test("webhook falls back to main for invalid repository default branch", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/gogcli",
        default_branch: "bad branch",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.targetBranch, "main");
});

test("webhook rejects private and denied target repositories", () => {
  const privateResult = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "steipete/private-tool",
        private: true,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 1 },
      installation: { id: 456 },
    },
  });
  assert.deepEqual(privateResult, { accepted: false, reason: "repository not eligible" });

  const deniedResult = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/clawsweeper-state",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 1 },
      installation: { id: 456 },
    },
  });
  assert.deepEqual(deniedResult, { accepted: false, reason: "repository not eligible" });
});

test("webhook ignores ClawSweeper-owned label mutations", () => {
  const result = classifyItemWebhook({
    event: "pull_request",
    payload: {
      action: "labeled",
      repository: {
        full_name: "openclaw/openclaw",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      pull_request: { number: 76992 },
      installation: { id: 123 },
      label: { name: "status: 🚀 automerge armed" },
      sender: { login: "openclaw-clawsweeper[bot]" },
    },
  });

  assert.deepEqual(result, {
    accepted: false,
    reason: "routine ClawSweeper label mutation",
  });
});

test("webhook preserves human ClawSweeper-owned label mutations", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "labeled",
      repository: {
        full_name: "openclaw/gogcli",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
      label: { name: "status: 👀 ready for maintainer look" },
      sender: { login: "steipete" },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "item",
    targetRepo: "openclaw/gogcli",
    targetBranch: "main",
    itemNumber: 597,
    itemKind: "issue",
    installationId: 123,
    sourceEvent: "issues",
    sourceAction: "labeled",
    supersedesInProgress: false,
  });
});

test("fast ack comment carries source comment marker", () => {
  const body = renderFastAckComment(456);

  assert.match(body, /clawsweeper-command-ack:456/);
  assert.match(body, /ClawSweeper picked this up/);
});

test("webhook signature verification uses sha256 body hmac", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ ok: true });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.doesNotThrow(() => verifyGitHubSignature({ secret, signature, body }));
  assert.throws(
    () => verifyGitHubSignature({ secret, signature: "sha256=bad", body }),
    /invalid GitHub webhook signature/,
  );
});
