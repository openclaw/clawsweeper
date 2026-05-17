import assert from "node:assert/strict";
import test from "node:test";

import {
  appendLedger,
  isGitHubAppIntegrationAuthError,
  isAllowedMutationActor,
  normalizeGitHubActor,
  selectCommentsForRouting,
  shouldSuppressProcessedCommentVersion,
  sortCommentsForRouting,
  summarizeChecks,
} from "../../dist/repair/comment-router-utils.js";

test("appendLedger keeps edited comment versions separate", () => {
  const ledger = { updated_at: null, commands: [] };

  appendLedger(ledger, [
    {
      idempotency_key: "first",
      comment_id: "123",
      comment_version_key: "123:2026-04-29T01:00:00Z",
      comment_updated_at: "2026-04-29T01:00:00Z",
      status: "executed",
      intent: "clawsweeper_auto_repair",
      issue_number: 74075,
      repo: "openclaw/openclaw",
    },
    {
      idempotency_key: "second",
      comment_id: "123",
      comment_version_key: "123:2026-04-29T02:00:00Z",
      comment_updated_at: "2026-04-29T02:00:00Z",
      status: "executed",
      intent: "clawsweeper_auto_repair",
      issue_number: 74075,
      repo: "openclaw/openclaw",
    },
  ]);

  assert.equal(ledger.commands.length, 2);
  assert.deepEqual(
    ledger.commands.map((entry) => entry.comment_version_key),
    ["123:2026-04-29T01:00:00Z", "123:2026-04-29T02:00:00Z"],
  );
});

test("appendLedger leaves waiting commands retryable", () => {
  const ledger = { updated_at: null, commands: [] };

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "transient",
        comment_id: "124",
        comment_version_key: "124:2026-04-29T03:00:00Z",
        comment_updated_at: "2026-04-29T03:00:00Z",
        status: "waiting",
        intent: "clawsweeper_re_review",
        issue_number: 74499,
        repo: "openclaw/openclaw",
      },
    ]),
    false,
  );

  assert.equal(ledger.commands.length, 0);
});

test("appendLedger ignores no-op skipped command versions", () => {
  const ledger = { updated_at: null, commands: [] };

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "already-processed",
        comment_id: "124",
        comment_version_key: "124:2026-04-29T03:00:00Z",
        comment_updated_at: "2026-04-29T03:00:00Z",
        status: "skipped",
        reason: "comment version already processed in ledger",
        intent: "automerge",
        issue_number: 74499,
        repo: "openclaw/openclaw",
      },
    ]),
    false,
  );

  assert.equal(ledger.commands.length, 0);
});

test("appendLedger reports compact executed writes", () => {
  const ledger = { updated_at: null, commands: [] };

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "processed",
        comment_id: "125",
        comment_version_key: "125:2026-04-29T03:01:00Z",
        comment_updated_at: "2026-04-29T03:01:00Z",
        status: "executed",
        intent: "clawsweeper_re_review",
        issue_number: 74499,
        repo: "openclaw/openclaw",
      },
    ]),
    true,
  );

  assert.equal(ledger.commands.length, 1);
});

test("appendLedger preserves maintainer identity fields for automerge attribution", () => {
  const ledger = { updated_at: null, commands: [] };

  appendLedger(ledger, [
    {
      idempotency_key: "automerge-opt-in",
      comment_id: "126",
      comment_version_key: "126:2026-04-29T03:02:00Z",
      comment_updated_at: "2026-04-29T03:02:00Z",
      status: "executed",
      intent: "automerge",
      issue_number: 74499,
      repo: "openclaw/openclaw",
      author: "maintainer-user",
      author_id: 123456,
      author_name: "Maintainer User",
    },
  ]);

  assert.equal(ledger.commands[0].author, "maintainer-user");
  assert.equal(ledger.commands[0].author_id, 123456);
  assert.equal(ledger.commands[0].author_name, "Maintainer User");
});

test("appendLedger preserves compact executed actions for repair caps", () => {
  const ledger = { updated_at: null, commands: [] };

  appendLedger(ledger, [
    {
      idempotency_key: "automerge-pass-repair",
      comment_id: "125",
      comment_version_key: "125:2026-04-30T01:12:00Z",
      comment_updated_at: "2026-04-30T01:12:00Z",
      status: "executed",
      intent: "clawsweeper_auto_merge",
      issue_number: 74506,
      repo: "openclaw/openclaw",
      actions: [
        {
          action: "dispatch_repair",
          status: "executed",
          job_path: "jobs/openclaw/inbox/automerge-openclaw-openclaw-74506.md",
          workflow: "repair-cluster-worker.yml",
          ignored_detail: "not persisted",
        },
      ],
    },
  ]);

  assert.deepEqual(ledger.commands[0].actions, [
    {
      action: "dispatch_repair",
      status: "executed",
      label: null,
      job_path: "jobs/openclaw/inbox/automerge-openclaw-openclaw-74506.md",
    },
  ]);
});

test("sortCommentsForRouting prioritizes edited durable review comments", () => {
  const sorted = sortCommentsForRouting([
    {
      id: 2,
      body: "@clawsweeper rebase",
      created_at: "2026-04-30T03:40:00Z",
      updated_at: "2026-04-30T03:40:00Z",
    },
    {
      id: 1,
      body: "<!-- clawsweeper-verdict:pass item=74742 sha=abc confidence=high -->",
      created_at: "2026-04-30T02:00:00Z",
      updated_at: "2026-04-30T03:45:00Z",
    },
  ]);

  assert.deepEqual(
    sorted.map((comment) => comment.id),
    [1, 2],
  );
});

test("selectCommentsForRouting keeps durable review comments beyond the recent cap", () => {
  const selected = selectCommentsForRouting({
    maxComments: 1,
    recentComments: [
      {
        id: 2,
        body: "@clawsweeper status",
        created_at: "2026-04-30T03:40:00Z",
        updated_at: "2026-04-30T03:40:00Z",
      },
      {
        id: 3,
        body: "@clawsweeper rebase",
        created_at: "2026-04-30T03:39:00Z",
        updated_at: "2026-04-30T03:39:00Z",
      },
    ],
    durableComments: [
      {
        id: 1,
        body: "<!-- clawsweeper-verdict:pass item=74742 sha=abc confidence=high -->",
        created_at: "2026-04-30T02:00:00Z",
        updated_at: "2026-04-30T03:45:00Z",
      },
    ],
  });

  assert.deepEqual(
    selected.map((comment) => comment.id),
    [1, 2],
  );
});

test("summarizeChecks ignores cancelled default non-gating checks", () => {
  const checks = summarizeChecks([
    {
      name: "auto-response",
      workflowName: "Auto response",
      status: "COMPLETED",
      conclusion: "CANCELLED",
    },
    {
      name: "dispatch",
      workflowName: "ClawSweeper Dispatch",
      status: "COMPLETED",
      conclusion: "CANCELLED",
    },
    {
      name: "CI",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    },
  ]);

  assert.equal(checks.total, 3);
  assert.deepEqual(checks.blockers, []);
  assert.equal(checks.counts.CANCELLED, 2);
});

test("summarizeChecks still blocks cancelled required checks", () => {
  const checks = summarizeChecks([
    {
      name: "required-build",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "CANCELLED",
    },
  ]);

  assert.deepEqual(checks.blockers, ["required-build:CANCELLED"]);
  assert.deepEqual(checks.pending, []);
  assert.deepEqual(checks.terminalBlockers, ["required-build:CANCELLED"]);
});

test("summarizeChecks separates pending checks from terminal blockers", () => {
  const checks = summarizeChecks([
    {
      name: "slow-required",
      workflowName: "CI",
      status: "IN_PROGRESS",
      conclusion: "",
    },
    {
      name: "failed-required",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "FAILURE",
    },
  ]);

  assert.deepEqual(checks.blockers, ["slow-required:IN_PROGRESS", "failed-required:FAILURE"]);
  assert.deepEqual(checks.pending, ["slow-required:IN_PROGRESS"]);
  assert.deepEqual(checks.terminalBlockers, ["failed-required:FAILURE"]);
});

test("summarizeChecks uses the latest run for duplicate check names", () => {
  const checks = summarizeChecks([
    {
      name: "Real behavior proof",
      workflowName: "Real behavior proof",
      status: "COMPLETED",
      conclusion: "FAILURE",
      completedAt: "2026-05-10T06:01:06Z",
    },
    {
      name: "Real behavior proof",
      workflowName: "Real behavior proof",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      completedAt: "2026-05-11T00:53:06Z",
    },
    {
      name: "CI",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      completedAt: "2026-05-11T00:53:10Z",
    },
  ]);

  assert.equal(checks.total, 2);
  assert.deepEqual(checks.blockers, []);
  assert.equal(checks.counts.SUCCESS, 2);
});

test("skipped automerge ledger entries stay retryable", () => {
  assert.equal(
    shouldSuppressProcessedCommentVersion({
      status: "skipped",
      intent: "clawsweeper_auto_merge",
    }),
    false,
  );
  assert.equal(
    shouldSuppressProcessedCommentVersion({
      status: "skipped",
      intent: "maintainer_approve_automerge",
    }),
    false,
  );
  assert.equal(
    shouldSuppressProcessedCommentVersion({
      status: "executed",
      intent: "clawsweeper_auto_merge",
    }),
    true,
  );
  assert.equal(
    shouldSuppressProcessedCommentVersion({
      status: "skipped",
      intent: "clawsweeper_re_review",
    }),
    true,
  );
});

test("mutation actor guard accepts only trusted bot identities", () => {
  const trustedBots = new Set(["clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);

  assert.equal(normalizeGitHubActor("ClawSweeper[bot]"), "clawsweeper");
  assert.equal(isAllowedMutationActor("ClawSweeper[bot]", trustedBots), true);
  assert.equal(isAllowedMutationActor("clawsweeper[bot]", trustedBots), true);
  assert.equal(isAllowedMutationActor("clawsweeper", trustedBots), false);
  assert.equal(isAllowedMutationActor("openclaw-clawsweeper[bot]", trustedBots), true);
  assert.equal(isAllowedMutationActor("steipete", trustedBots), false);
  assert.equal(isAllowedMutationActor("github-actions[bot]", trustedBots), false);
});

test("mutation actor guard recognizes GitHub App integration auth shape", () => {
  assert.equal(
    isGitHubAppIntegrationAuthError("gh: Resource not accessible by integration (HTTP 403)"),
    true,
  );
  assert.equal(
    isGitHubAppIntegrationAuthError(
      '{"message":"Resource not accessible by integration","status":"403"}',
    ),
    true,
  );
  assert.equal(
    isGitHubAppIntegrationAuthError(
      '{"message":"Resource not accessible by integration","status": "403"}',
    ),
    true,
  );
  assert.equal(isGitHubAppIntegrationAuthError("gh: Resource not accessible (HTTP 403)"), false);
  assert.equal(isGitHubAppIntegrationAuthError("Resource not accessible by integration"), false);
});
