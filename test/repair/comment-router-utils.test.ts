import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPERSEDED_RE_REVIEW_REASON,
  appendLedger,
  commentBodySha256,
  dispatchClaimDecision,
  dispatchClaimLookupKeys,
  dispatchReceiptKeyMaterial,
  exactCommentVersionFastPathDecision,
  exactCommentVersionMatchesLive,
  hasSuccessfulDispatchExecutionJob,
  isGitHubAppIntegrationAuthError,
  isAllowedMutationActor,
  normalizeGitHubActor,
  routerDispatchReceiptKey,
  selectCommentsForRouting,
  shouldSuppressProcessedCommentVersion,
  sortCommentsForRouting,
  supersededReReviewCommentVersions,
  summarizeChecks,
} from "../../dist/repair/comment-router-utils.js";
import { forcedReplayCommandFields, readCommentRouterConfig } from "../../dist/repair/config.js";

test("exact terminal comment versions short-circuit duplicate created deliveries", () => {
  const body = "@clawsweeper re-review";
  const ledger = exactVersionLedger({
    status: "executed",
    body,
  });

  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      authenticated: true,
      sourceAction: "created",
      targetRepo: "openclaw/openclaw",
      commentId: 456,
      commentUpdatedAt: "2026-07-12T20:00:00Z",
      commentBodyDigest: commentBodySha256(body),
      forceReprocess: false,
      ledger,
      verificationLedgers: [structuredClone(ledger), structuredClone(ledger)],
    }),
    {
      suppress: true,
      reason: "exact_terminal_comment_version",
      commentVersionKey: "456:2026-07-12T20:00:00Z",
      status: "executed",
    },
  );
});

test("edited comments and changed body bytes always use the full router path", () => {
  const ledger = exactVersionLedger({
    status: "executed",
    body: "@clawsweeper re-review",
  });

  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      authenticated: true,
      sourceAction: "edited",
      targetRepo: "openclaw/openclaw",
      commentId: 456,
      commentUpdatedAt: "2026-07-12T20:01:00Z",
      commentBodyDigest: commentBodySha256("@clawsweeper re-review with new context"),
      forceReprocess: false,
      ledger,
      verificationLedgers: [structuredClone(ledger), structuredClone(ledger)],
    }),
    { suppress: false, reason: "edited_or_unknown_action" },
  );
  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      authenticated: true,
      sourceAction: "created",
      targetRepo: "openclaw/openclaw",
      commentId: 456,
      commentUpdatedAt: "2026-07-12T20:00:00Z",
      commentBodyDigest: commentBodySha256("@clawsweeper re-review with changed bytes"),
      forceReprocess: false,
      ledger,
      verificationLedgers: [structuredClone(ledger), structuredClone(ledger)],
    }),
    { suppress: false, reason: "body_digest_mismatch" },
  );
});

test("terminal cleanup requires the same live comment version", () => {
  const body = "@clawsweeper re-review";
  const command = {
    comment_id: "456",
    comment_updated_at: "2026-07-12T20:00:00Z",
    comment_body_sha256: commentBodySha256(body),
  };

  assert.equal(
    exactCommentVersionMatchesLive(command, {
      id: 456,
      updated_at: "2026-07-12T20:00:00Z",
      body,
    }),
    true,
  );
  assert.equal(
    exactCommentVersionMatchesLive(command, {
      id: 456,
      updated_at: "2026-07-12T20:01:00Z",
      body: `${body} now`,
    }),
    false,
  );
});

test("missing timestamps or authenticated provenance use the full router path", () => {
  const ledger = exactVersionLedger({
    status: "executed",
    body: "@clawsweeper re-review",
  });
  const base = {
    sourceAction: "created",
    targetRepo: "openclaw/openclaw",
    commentId: 456,
    commentUpdatedAt: "2026-07-12T20:00:00Z",
    commentBodyDigest: commentBodySha256("@clawsweeper re-review"),
    forceReprocess: false,
    ledger,
    verificationLedgers: [structuredClone(ledger), structuredClone(ledger)],
  };

  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      ...base,
      authenticated: true,
      commentUpdatedAt: null,
    }),
    { suppress: false, reason: "incomplete_exact_version" },
  );
  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      ...base,
      authenticated: false,
    }),
    { suppress: false, reason: "auth_uncertain" },
  );
});

test("retryable claims and failed action leases are never short-circuited", () => {
  for (const status of ["waiting", "claimed"]) {
    const ledger = exactVersionLedger({
      status,
      body: "@clawsweeper re-review",
      actions: [{ action: "dispatch_clawsweeper", status }],
    });
    assert.deepEqual(
      exactCommentVersionFastPathDecision({
        authenticated: true,
        sourceAction: "created",
        targetRepo: "openclaw/openclaw",
        commentId: 456,
        commentUpdatedAt: "2026-07-12T20:00:00Z",
        commentBodyDigest: commentBodySha256("@clawsweeper re-review"),
        forceReprocess: false,
        ledger,
        verificationLedgers: [structuredClone(ledger), structuredClone(ledger)],
      }),
      { suppress: false, reason: "version_retryable" },
    );
  }

  const failedLedger = exactVersionLedger({
    status: "executed",
    body: "@clawsweeper re-review",
    actions: [{ action: "dispatch_clawsweeper", status: "failed" }],
  });
  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      authenticated: true,
      sourceAction: "created",
      targetRepo: "openclaw/openclaw",
      commentId: 456,
      commentUpdatedAt: "2026-07-12T20:00:00Z",
      commentBodyDigest: commentBodySha256("@clawsweeper re-review"),
      forceReprocess: false,
      ledger: failedLedger,
      verificationLedgers: [structuredClone(failedLedger), structuredClone(failedLedger)],
    }),
    { suppress: false, reason: "lease_uncertain" },
  );
});

test("concurrent ledger changes fail closed to the full router path", () => {
  const ledger = exactVersionLedger({
    status: "executed",
    body: "@clawsweeper re-review",
  });
  const changedLedger = structuredClone(ledger);
  changedLedger.updated_at = "2026-07-12T20:01:00Z";

  assert.deepEqual(
    exactCommentVersionFastPathDecision({
      authenticated: true,
      sourceAction: "created",
      targetRepo: "openclaw/openclaw",
      commentId: 456,
      commentUpdatedAt: "2026-07-12T20:00:00Z",
      commentBodyDigest: commentBodySha256("@clawsweeper re-review"),
      forceReprocess: false,
      ledger,
      verificationLedgers: [structuredClone(ledger), changedLedger],
    }),
    { suppress: false, reason: "state_drift" },
  );
});

test("synthetic dispatch claims retain a stable idempotency lookup across router runs", () => {
  const idempotencyKey = "repair-loop-label-sweep:openclaw/openclaw:automerge:74499";
  const first = dispatchClaimLookupKeys({
    idempotency_key: idempotencyKey,
    comment_id: "repair-loop-label-sweep:automerge:74499",
    comment_updated_at: "2026-04-29T03:01:00Z",
  });
  const replay = dispatchClaimLookupKeys({
    idempotency_key: idempotencyKey,
    comment_id: "repair-loop-label-sweep:automerge:74499",
    comment_updated_at: "2026-04-29T03:06:00Z",
  });

  assert.deepEqual(
    first.filter((key) => replay.includes(key)),
    [`idempotency:${idempotencyKey}`],
  );
});

test("synthetic dispatch receipt material is stable within an attempt and changes next attempt", () => {
  const command = {
    idempotency_key: "repair-loop-label-sweep:openclaw/openclaw:automerge:74499",
    automation_source: "repair_loop_label_sweep",
    comment_updated_at: "2026-04-29T03:01:00Z",
  };
  const firstClaim = { processed_at: "2026-04-29T03:01:01Z" };
  const replayedClaim = { processed_at: "2026-04-29T03:01:01Z" };
  const nextClaim = { processed_at: "2026-04-29T04:15:00Z" };

  assert.equal(
    dispatchReceiptKeyMaterial(command, firstClaim),
    dispatchReceiptKeyMaterial(command, replayedClaim),
  );
  assert.notEqual(
    dispatchReceiptKeyMaterial(command, firstClaim),
    dispatchReceiptKeyMaterial(command, nextClaim),
  );
});

test("production forced replay parsing scopes claims and dispatch keys by durable attempt", () => {
  const baseArgs = {
    repo: "openclaw/openclaw",
    "repair-repo": "openclaw/clawsweeper",
    "review-repo": "openclaw/clawsweeper",
  };
  const baseCommand = {
    idempotency_key:
      "clawsweeper-repair:openclaw/openclaw:74499:991122:2026-07-12T20:00:00Z:automerge",
    comment_id: "991122",
    comment_updated_at: "2026-07-12T20:00:00Z",
  };
  const forcedCommand = (attemptId: string) => ({
    ...baseCommand,
    ...forcedReplayCommandFields(
      readCommentRouterConfig({
        ...baseArgs,
        "force-reprocess": true,
        "attempt-id": attemptId,
      }),
    ),
  });

  const first = forcedCommand("forced-replay-41001");
  const firstRetry = forcedCommand("forced-replay-41001");
  const second = forcedCommand("forced-replay-41002");
  assert.deepEqual(dispatchClaimLookupKeys(first), dispatchClaimLookupKeys(firstRetry));
  assert.equal(routerDispatchReceiptKey(first, null), routerDispatchReceiptKey(firstRetry, null));
  assert.deepEqual(
    dispatchClaimLookupKeys(first).filter((key) => dispatchClaimLookupKeys(second).includes(key)),
    [],
  );
  assert.notEqual(routerDispatchReceiptKey(first, null), routerDispatchReceiptKey(second, null));

  const normalReplay = { ...baseCommand, processed_at: "2026-07-12T20:05:00Z" };
  assert.deepEqual(dispatchClaimLookupKeys(baseCommand), dispatchClaimLookupKeys(normalReplay));
  assert.equal(
    routerDispatchReceiptKey(baseCommand, null),
    routerDispatchReceiptKey(normalReplay, null),
  );
});

test("synthetic dispatch attempt replaces its durable claim in the ledger", () => {
  const ledger = { updated_at: null, commands: [] };
  const base = {
    idempotency_key: "repair-loop-label-sweep:openclaw/openclaw:automerge:74499",
    comment_id: "repair-loop-label-sweep:automerge:74499",
    comment_version_key: null,
    automation_source: "repair_loop_label_sweep",
    repo: "openclaw/openclaw",
    issue_number: 74499,
    intent: "automerge",
  };

  assert.equal(
    appendLedger(ledger, [
      {
        ...base,
        comment_updated_at: "2026-04-29T03:01:00Z",
        processed_at: "2026-04-29T03:01:01Z",
        status: "claimed",
      },
    ]),
    true,
  );
  assert.equal(
    appendLedger(ledger, [
      {
        ...base,
        comment_updated_at: "2026-04-29T03:06:00Z",
        processed_at: "2026-04-29T03:01:01Z",
        status: "executed",
      },
    ]),
    true,
  );
  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0]?.status, "executed");
});

test("newer re-review commands supersede older retries from the same requester", () => {
  const commands = [
    {
      repo: "openclaw/gogcli",
      issue_number: 749,
      author_id: 58493,
      intent: "re_review",
      comment_id: "4679061453",
      comment_version_key: "4679061453:2026-06-11T09:20:23Z",
      comment_updated_at: "2026-06-11T09:20:23Z",
    },
    {
      repo: "openclaw/gogcli",
      issue_number: 749,
      author_id: 58493,
      intent: "re_review",
      comment_id: "4679167308",
      comment_version_key: "4679167308:2026-06-11T09:33:21Z",
      comment_updated_at: "2026-06-11T09:33:21Z",
    },
    {
      repo: "openclaw/gogcli",
      issue_number: 749,
      author_id: 999,
      intent: "re_review",
      comment_id: "4679167400",
      comment_version_key: "4679167400:2026-06-11T09:34:00Z",
      comment_updated_at: "2026-06-11T09:34:00Z",
    },
  ];

  assert.deepEqual(
    [...supersededReReviewCommentVersions(commands)],
    ["4679061453:2026-06-11T09:20:23Z"],
  );
});

test("superseded re-review commands become terminal ledger entries", () => {
  const ledger = { updated_at: null, commands: [] };

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "superseded",
        comment_id: "4679061453",
        comment_version_key: "4679061453:2026-06-11T09:20:23Z",
        comment_updated_at: "2026-06-11T09:20:23Z",
        status: "skipped",
        reason: SUPERSEDED_RE_REVIEW_REASON,
        intent: "re_review",
        issue_number: 749,
        repo: "openclaw/gogcli",
      },
    ]),
    true,
  );
  assert.equal(ledger.commands.length, 1);
});

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

test("appendLedger records waiting commands without making them terminal", () => {
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
    true,
  );

  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0].status, "waiting");
  assert.equal(shouldSuppressProcessedCommentVersion(ledger.commands[0]), false);
});

test("appendLedger records claimed dispatch commands as recoverable idempotency claims", () => {
  const ledger = { updated_at: null, commands: [] };

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "claim-before-dispatch",
        comment_id: "125",
        comment_version_key: "125:2026-04-29T03:01:00Z",
        comment_updated_at: "2026-04-29T03:01:00Z",
        status: "claimed",
        intent: "clawsweeper_re_review",
        issue_number: 74499,
        repo: "openclaw/openclaw",
        actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
      },
    ]),
    true,
  );

  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0].status, "claimed");
  assert.equal(shouldSuppressProcessedCommentVersion(ledger.commands[0]), false);
  assert.deepEqual(ledger.commands[0].actions, [
    {
      action: "dispatch_clawsweeper",
      status: "claimed",
      label: null,
      job_path: null,
    },
  ]);
});

test("fresh dispatch claims wait for the Actions receipt visibility window", () => {
  const claim = { processed_at: "2026-04-29T03:01:00Z" };

  assert.deepEqual(
    dispatchClaimDecision({
      claim,
      runs: [],
      expectedTitle: "Review event item openclaw/openclaw#74499 [router-abc]",
      nowMs: Date.parse("2026-04-29T03:04:00Z"),
    }),
    { action: "wait", run: null },
  );
});

test("dispatch claims recover the exact Actions receipt created after the claim", () => {
  const claim = { processed_at: "2026-04-29T03:01:00Z" };
  const matchingRun = {
    id: 991,
    display_title: "Review event item openclaw/openclaw#74499 [router-abc]",
    created_at: "2026-04-29T03:01:02Z",
    status: "completed",
    conclusion: "success",
  };

  assert.deepEqual(
    dispatchClaimDecision({
      claim,
      runs: [
        {
          id: 990,
          display_title: matchingRun.display_title,
          created_at: "2026-04-29T02:59:00Z",
        },
        matchingRun,
      ],
      expectedTitle: matchingRun.display_title,
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
    }),
    { action: "recover", run: matchingRun },
  );
});

test("dispatch claims wait for active receipts and retry terminal failures", () => {
  const claim = { processed_at: "2026-04-29T03:01:00Z" };
  const expectedTitle = "Review event item openclaw/openclaw#74499 [router-abc]";
  const run = {
    id: 991,
    display_title: expectedTitle,
    created_at: "2026-04-29T03:01:02Z",
  };

  assert.deepEqual(
    dispatchClaimDecision({
      claim,
      runs: [{ ...run, status: "in_progress", conclusion: null }],
      expectedTitle,
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
    }),
    { action: "wait", run: null },
  );
  for (const conclusion of ["cancelled", "failure", "skipped", "timed_out"]) {
    assert.deepEqual(
      dispatchClaimDecision({
        claim,
        runs: [{ ...run, status: "completed", conclusion }],
        expectedTitle,
        nowMs: Date.parse("2026-04-29T03:10:00Z"),
      }),
      { action: "dispatch", run: null },
    );
  }
});

test("dispatch claim recovery prefers an older success over a newer cancelled duplicate", () => {
  const claim = { processed_at: "2026-04-29T03:01:00Z" };
  const expectedTitle = "Review event item openclaw/openclaw#74499 [router-abc]";
  const successfulRun = {
    id: 991,
    display_title: expectedTitle,
    created_at: "2026-04-29T03:01:02Z",
    status: "completed",
    conclusion: "success",
  };

  assert.deepEqual(
    dispatchClaimDecision({
      claim,
      runs: [
        {
          ...successfulRun,
          id: 992,
          created_at: "2026-04-29T03:02:00Z",
          conclusion: "cancelled",
        },
        successfulRun,
      ],
      expectedTitle,
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
    }),
    { action: "recover", run: successfulRun },
  );
});

test("dispatch claims ignore receipt-only duplicate successes", () => {
  const expectedTitle = "Assist openclaw/openclaw#74499 [router-abc]";
  assert.deepEqual(
    dispatchClaimDecision({
      claim: { processed_at: "2026-04-29T03:01:00Z" },
      runs: [
        {
          id: 991,
          display_title: expectedTitle,
          created_at: "2026-04-29T03:01:02Z",
          status: "completed",
          conclusion: "failure",
        },
        {
          id: 992,
          display_title: expectedTitle,
          created_at: "2026-04-29T03:02:00Z",
          status: "completed",
          conclusion: "success",
          dispatch_execution_verified: false,
        },
      ],
      expectedTitle,
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
      graceMs: 300_000,
    }),
    { action: "dispatch", run: null },
  );
});

test("dispatch execution verification requires the real worker job to succeed", () => {
  assert.equal(
    hasSuccessfulDispatchExecutionJob(
      [
        { name: "Deduplicate command dispatch receipt", conclusion: "success" },
        { name: "assist", conclusion: "skipped" },
      ],
      "assist",
    ),
    false,
  );
  assert.equal(
    hasSuccessfulDispatchExecutionJob(
      [
        { name: "Deduplicate command dispatch receipt", conclusion: "success" },
        { name: "assist", conclusion: "success" },
      ],
      "assist",
    ),
    true,
  );
});

test("appendLedger refreshes a stale dispatch claim before retry", () => {
  const ledger = { updated_at: null, commands: [] };
  const base = {
    idempotency_key: "claim-before-dispatch",
    comment_id: "125",
    comment_version_key: "125:2026-04-29T03:01:00Z",
    status: "claimed",
    intent: "clawsweeper_re_review",
    actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
  };
  appendLedger(ledger, [{ ...base, processed_at: "2026-04-29T03:01:00Z" }]);
  appendLedger(ledger, [{ ...base, processed_at: "2026-04-29T03:10:00Z" }]);

  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0]?.processed_at, "2026-04-29T03:10:00Z");
});

test("stale dispatch claims without an exact receipt become retryable", () => {
  assert.deepEqual(
    dispatchClaimDecision({
      claim: { processed_at: "2026-04-29T03:01:00Z" },
      runs: [
        {
          id: 990,
          display_title: "Review event item openclaw/openclaw#74499 [router-other]",
          created_at: "2026-04-29T03:01:02Z",
        },
      ],
      expectedTitle: "Review event item openclaw/openclaw#74499 [router-abc]",
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
      graceMs: Number.NaN,
    }),
    { action: "dispatch", run: null },
  );
});

test("dispatch claims with malformed timestamps fail closed", () => {
  assert.deepEqual(
    dispatchClaimDecision({
      claim: { processed_at: "not-a-timestamp" },
      runs: [
        {
          id: 991,
          display_title: "Review event item openclaw/openclaw#74499 [router-abc]",
          created_at: "2026-04-29T03:01:02Z",
        },
      ],
      expectedTitle: "Review event item openclaw/openclaw#74499 [router-abc]",
      nowMs: Date.parse("2026-04-29T03:10:00Z"),
    }),
    { action: "wait", run: null },
  );
});

test("appendLedger preserves the original timestamp while a claim waits", () => {
  const ledger = { updated_at: null, commands: [] };
  const processedAt = "2026-04-29T03:01:00Z";

  appendLedger(ledger, [
    {
      idempotency_key: "claim-before-dispatch",
      comment_id: "125",
      comment_version_key: "125:2026-04-29T03:01:00Z",
      status: "claimed",
      intent: "clawsweeper_re_review",
      processed_at: processedAt,
      actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
    },
  ]);

  assert.equal(ledger.commands[0].processed_at, processedAt);
});

test("appendLedger upgrades claimed dispatch commands after execution", () => {
  const ledger = { updated_at: null, commands: [] };

  appendLedger(ledger, [
    {
      idempotency_key: "claim-before-dispatch",
      comment_id: "125",
      comment_version_key: "125:2026-04-29T03:01:00Z",
      comment_updated_at: "2026-04-29T03:01:00Z",
      status: "claimed",
      intent: "clawsweeper_re_review",
      issue_number: 74499,
      repo: "openclaw/openclaw",
      actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
    },
  ]);

  assert.equal(
    appendLedger(ledger, [
      {
        idempotency_key: "claim-before-dispatch",
        comment_id: "125",
        comment_version_key: "125:2026-04-29T03:01:00Z",
        comment_updated_at: "2026-04-29T03:01:00Z",
        status: "executed",
        intent: "clawsweeper_re_review",
        issue_number: 74499,
        repo: "openclaw/openclaw",
        actions: [{ action: "dispatch_clawsweeper", status: "executed" }],
      },
    ]),
    true,
  );

  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0].status, "executed");
  assert.deepEqual(ledger.commands[0].actions, [
    {
      action: "dispatch_clawsweeper",
      status: "executed",
      label: null,
      job_path: null,
    },
  ]);
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
        comment_body_sha256: commentBodySha256("@clawsweeper re-review"),
        status: "executed",
        intent: "clawsweeper_re_review",
        issue_number: 74499,
        repo: "openclaw/openclaw",
      },
    ]),
    true,
  );

  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.commands[0].comment_body_sha256, commentBodySha256("@clawsweeper re-review"));
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

function exactVersionLedger({
  status,
  body,
  actions = [],
}: {
  status: string;
  body: string;
  actions?: Array<Record<string, string>>;
}) {
  return {
    updated_at: "2026-07-12T20:00:01Z",
    commands: [
      {
        repo: "openclaw/openclaw",
        comment_id: "456",
        comment_version_key: "456:2026-07-12T20:00:00Z",
        comment_updated_at: "2026-07-12T20:00:00Z",
        comment_body_sha256: commentBodySha256(body),
        status,
        intent: "re_review",
        actions,
      },
    ],
  };
}

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
      name: "notify",
      workflowName: "notify",
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

  assert.equal(checks.total, 4);
  assert.equal(checks.gatingTotal, 1);
  assert.deepEqual(checks.blockers, []);
  assert.equal(checks.counts.CANCELLED, 3);
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

test("summarizeChecks waits for a cancelled real behavior proof replacement", () => {
  const checks = summarizeChecks([
    {
      name: "Real behavior proof",
      workflowName: "Real behavior proof",
      status: "COMPLETED",
      conclusion: "CANCELLED",
    },
  ]);

  assert.deepEqual(checks.blockers, ["Real behavior proof:CANCELLED"]);
  assert.deepEqual(checks.pending, ["Real behavior proof:CANCELLED"]);
  assert.deepEqual(checks.terminalBlockers, []);
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

test("summarizeChecks marks Vercel authorization checks as external action required", () => {
  const checks = summarizeChecks([
    {
      context: "Vercel – clawhub",
      state: "FAILURE",
      targetUrl: "https://vercel.com/git/authorize?team=OpenClaw&type=github",
    },
  ]);

  assert.deepEqual(checks.blockers, ["Vercel – clawhub:ACTION_REQUIRED"]);
  assert.deepEqual(checks.pending, []);
  assert.deepEqual(checks.terminalBlockers, ["Vercel – clawhub:ACTION_REQUIRED"]);
  assert.deepEqual(checks.externalBlockers, ["Vercel – clawhub:ACTION_REQUIRED"]);
  assert.equal(checks.counts.ACTION_REQUIRED, 1);
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
