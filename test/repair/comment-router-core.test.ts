import assert from "node:assert/strict";
import test from "node:test";

import {
  commandHasAction,
  createCachedIssueCommentsLookup,
  createCachedIssueCommentsLookupAsync,
  existingCommandStatusBlocksReplay,
  hasCommandResponseMarker,
  reviewSummaryFromCommentBody,
  renderResponse,
  staleClosedItemCommandReason,
  shouldClearMaintainerCommandReaction,
} from "../../dist/repair/comment-router-core.js";
import {
  expiredReviewStartStatusLeases,
  freshExactHeadReviewStartLease,
  isAuthorReadOnlyCommandAllowed,
  isMaintainerCommandAllowed,
  isTrustedStatusCommentAuthor,
  latestTrustedExactHeadReview,
  parseCommand,
  parseRoutedCommentCommand,
  parseTrustedAutomation,
  supersededReviewStartStatusLeases,
  trustedAutomationPredatesReviewStartLease,
  trustedExactHeadReviewCompletionSince,
} from "../../dist/repair/comment-router/admission.js";
import { planCommandAckConvergence } from "../../dist/repair/command-ack-convergence.js";
import {
  commandResponseMarker,
  commandResponseMarkerPrefix,
  commandStatusMarkerFromBody,
} from "../../dist/repair/markers.js";

test("status comment authors fail closed even when the allowlist contains an empty login", () => {
  const trusted = new Set(["", "clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);
  for (const comment of [
    null,
    undefined,
    {},
    { user: null },
    { user: {} },
    { user: { login: null } },
    ...["", " ", "ghost", "contributor", " clawsweeper[bot] "].map((login) => ({
      user: { login },
    })),
  ]) {
    assert.equal(isTrustedStatusCommentAuthor(comment, trusted), false, JSON.stringify(comment));
  }
});

test("status comment authors preserve consumer allowlists and untrimmed case-insensitive matching", () => {
  const fixed = new Set(["clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);
  const configured = new Set(["custom[bot]"]);
  for (const login of [
    "clawsweeper",
    "CLAWSWEEPER",
    "ClawSweeper[bot]",
    "OpenClaw-ClawSweeper[bot]",
  ]) {
    assert.equal(isTrustedStatusCommentAuthor({ user: { login } }, fixed), true, login);
  }
  assert.equal(isTrustedStatusCommentAuthor({ user: { login: "CUSTOM[bot]" } }, configured), true);
  assert.equal(isTrustedStatusCommentAuthor({ user: { login: "CUSTOM[bot]" } }, fixed), false);
  assert.equal(
    isTrustedStatusCommentAuthor({ user: { login: "clawsweeper[bot]" } }, configured),
    false,
  );
  assert.equal(isTrustedStatusCommentAuthor({ user: { login: "clawsweeper" } }, new Set()), true);
  assert.equal(isTrustedStatusCommentAuthor({ user: { login: " clawsweeper " } }, fixed), false);
});

test("review summaries use the shared section reader and stop at metadata", () => {
  const body = [
    "# ClawSweeper review",
    "",
    "## What this changes",
    "",
    "Adds a human-first review summary.",
    "",
    "A second paragraph stays with the summary.",
    "",
    "## Merge readiness",
    "",
    "| **Status** | Needs review |",
    "",
    "<details>",
    "<summary>Agent review details</summary>",
    "Hidden diagnostics.",
    "</details>",
    "",
    "<!-- clawsweeper-verdict:needs-human sha=abc123 -->",
  ].join("\n");

  assert.equal(
    reviewSummaryFromCommentBody(body),
    "Adds a human-first review summary.\n\nA second paragraph stays with the summary.",
  );
  assert.equal(
    reviewSummaryFromCommentBody("**Summary**\n\nLegacy summary.\n\n**Next step**\n\nWait."),
    "Legacy summary.",
  );
  // The shared reader does not accept `Summary:` as a heading. No current comment uses it.
  assert.equal(
    reviewSummaryFromCommentBody("Summary:\n\nColon-style summary.\n\nNext step:\nWait."),
    null,
  );
  assert.equal(reviewSummaryFromCommentBody(body.replace("What this changes", "Other")), null);
});

test("review summaries prefer the human-first change summary over legacy summary text", () => {
  const body = [
    "**Summary**",
    "Legacy automation summary.",
    "",
    "## What this changes",
    "",
    "Plain-language change summary.",
    "",
    "## Merge readiness",
    "",
    "Ready for review.",
  ].join("\n");

  assert.equal(reviewSummaryFromCommentBody(body), "Plain-language change summary.");
  assert.equal(reviewSummaryFromCommentBody("**Summary**\n\nLegacy only."), "Legacy only.");
});

test("planCommandAckConvergence scopes duplicate cleanup to the current status marker", () => {
  const requestedStatus = "<!-- clawsweeper-command-status:81564:re_review:new -->";
  const otherStatus = "<!-- clawsweeper-command-status:81564:re_review:old -->";
  const comments = [
    {
      id: 101,
      created_at: "2026-05-29T10:00:00Z",
      updated_at: "2026-05-29T10:01:00Z",
      body: `${otherStatus}\n<!-- clawsweeper-command-ack:456 -->\nOld status.`,
    },
    {
      id: 102,
      created_at: "2026-05-29T10:02:00Z",
      updated_at: "2026-05-29T10:02:00Z",
      body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
    },
    {
      id: 103,
      created_at: "2026-05-29T10:03:00Z",
      updated_at: "2026-05-29T10:05:00Z",
      body: `${requestedStatus}\n<!-- clawsweeper-command-ack:456 -->\nCurrent status.`,
    },
    {
      id: 104,
      created_at: "2026-05-29T10:04:00Z",
      updated_at: "2026-05-29T10:04:00Z",
      body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
    },
  ];

  const plan = planCommandAckConvergence(comments, requestedStatus);

  assert.equal(plan.keep?.id, 103);
  assert.deepEqual(
    plan.prunable.map((comment) => comment.id),
    [102, 104],
  );
  assert.equal(commandStatusMarkerFromBody(comments[0].body), otherStatus);
});

test("planCommandAckConvergence keeps a new bare ack over an unrelated status comment", () => {
  const requestedStatus = "<!-- clawsweeper-command-status:81564:re_review:new -->";
  const otherStatus = "<!-- clawsweeper-command-status:81564:re_review:old -->";
  const comments = [
    {
      id: 101,
      created_at: "2026-05-29T10:00:00Z",
      updated_at: "2026-05-29T10:01:00Z",
      body: `${otherStatus}\n<!-- clawsweeper-command-ack:456 -->\nOld status.`,
    },
    {
      id: 102,
      created_at: "2026-05-29T10:02:00Z",
      updated_at: "2026-05-29T10:02:00Z",
      body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
    },
    {
      id: 103,
      created_at: "2026-05-29T10:03:00Z",
      updated_at: "2026-05-29T10:03:00Z",
      body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
    },
  ];

  const plan = planCommandAckConvergence(comments, requestedStatus);

  assert.equal(plan.keep?.id, 102);
  assert.deepEqual(
    plan.prunable.map((comment) => comment.id),
    [103],
  );
});

test("terminal maintainer command reactions clear after successful handling", () => {
  assert.equal(
    shouldClearMaintainerCommandReaction({
      trusted_bot: false,
      comment_id: "4472074866",
      status: "executed",
      intent: "automerge",
    }),
    true,
  );
});

test("terminal maintainer command reactions clear after skipped handling", () => {
  assert.equal(
    shouldClearMaintainerCommandReaction({
      trusted_bot: false,
      comment_id: "4472074866",
      status: "skipped",
      reason: "comment version already processed in ledger",
      intent: "automerge",
    }),
    true,
  );
});

test("in-progress maintainer command reactions stay visible", () => {
  assert.equal(
    shouldClearMaintainerCommandReaction({
      trusted_bot: false,
      comment_id: "4472074866",
      status: "waiting",
      intent: "automerge",
    }),
    false,
  );
  assert.equal(
    shouldClearMaintainerCommandReaction({
      trusted_bot: true,
      comment_id: "4472074866",
      status: "executed",
      intent: "clawsweeper_auto_merge",
    }),
    false,
  );
});

test("cached issue comments lookup fetches each issue once and returns stable copies", () => {
  const calls: number[] = [];
  const lookup = createCachedIssueCommentsLookup((number) => {
    calls.push(number);
    return [{ id: number * 10 }, { id: number * 10 + 1 }];
  });

  const first = lookup(12);
  first.push({ id: 999 });

  assert.deepEqual(first, [{ id: 120 }, { id: 121 }, { id: 999 }]);
  assert.deepEqual(lookup("12"), [{ id: 120 }, { id: 121 }]);
  assert.deepEqual(lookup(13), [{ id: 130 }, { id: 131 }]);
  assert.deepEqual(lookup(0), []);
  assert.deepEqual(calls, [12, 13]);
});

test("cached async issue comments lookup shares cache and in-flight fetches", async () => {
  const cache = new Map<number, { id: number }[]>();
  const calls: number[] = [];
  const asyncLookup = createCachedIssueCommentsLookupAsync(async (number) => {
    calls.push(number);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [{ id: number * 10 }];
  }, cache);
  const syncLookup = createCachedIssueCommentsLookup((number) => {
    calls.push(number);
    return [{ id: number * 100 }];
  }, cache);

  const [first, second] = await Promise.all([asyncLookup(12), asyncLookup("12")]);
  first.push({ id: 999 });

  assert.deepEqual(first, [{ id: 120 }, { id: 999 }]);
  assert.deepEqual(second, [{ id: 120 }]);
  assert.deepEqual(syncLookup(12), [{ id: 120 }]);
  assert.deepEqual(await asyncLookup(0), []);
  assert.deepEqual(calls, [12]);
});

test("comment router side effects are driven by planned actions", () => {
  const blockedReReview = {
    intent: "re_review",
    reason: "re-review requires an open issue or PR",
    actions: [{ action: "comment", status: "planned" }],
  };

  assert.equal(commandHasAction(blockedReReview, "dispatch_clawsweeper"), false);
  assert.equal(commandHasAction(blockedReReview, "comment"), true);

  const body = renderResponse(blockedReReview, null);
  assert.match(body, /could not start a re-review/);
  assert.match(body, /re-review requires an open issue or PR/);
  assert.doesNotMatch(body, /re-review requested/);

  const staleReReview = {
    intent: "re_review",
    status: "skipped",
    reason: "PR closed after this re_review command",
  };

  assert.equal(commandHasAction(staleReReview, "dispatch_clawsweeper"), false);
  assert.equal(commandHasAction(staleReReview, "comment"), false);

  const staleBody = renderResponse(staleReReview, null);
  assert.match(staleBody, /could not start a re-review/);
  assert.match(staleBody, /PR closed after this re_review command/);
  assert.doesNotMatch(staleBody, /re-review requested/);
});

test("force reprocess bypasses existing command status guards", () => {
  assert.equal(
    existingCommandStatusBlocksReplay({ hasExistingResponse: true, forceReprocess: false }),
    true,
  );
  assert.equal(
    existingCommandStatusBlocksReplay({ hasExistingResponse: true, forceReprocess: true }),
    false,
  );
  assert.equal(
    existingCommandStatusBlocksReplay({
      hasExistingResponse: true,
      forceReprocess: false,
      retryPending: true,
    }),
    false,
  );
});

test("command response markers can match across head changes", () => {
  const body = renderResponse(
    {
      comment_id: "4358615144",
      intent: "fix_ci",
      issue_number: 75423,
      target: { head_sha: "dc3e9a97a2c655c0c054cddb5a64e7b6fc51dd10" },
    },
    null,
  );

  assert.match(body, /clawsweeper-command:4358615144:fix_ci:dc3e9a97a2c655/);
  assert.equal(
    commandResponseMarker("4358615144", "fix_ci", "dc3e9a97a2c655c0c054cddb5a64e7b6fc51dd10"),
    "<!-- clawsweeper-command:4358615144:fix_ci:dc3e9a97a2c655c0c054cddb5a64e7b6fc51dd10 -->",
  );
  assert.equal(
    commandResponseMarkerPrefix("4358615144", "fix_ci"),
    "<!-- clawsweeper-command:4358615144:fix_ci:",
  );
  assert.equal(
    hasCommandResponseMarker(body, {
      commentId: "4358615144",
      intent: "fix_ci",
      headSha: "f7dfc41af791f92efbc469a495816f590155a5db",
      matchAnyHead: true,
    }),
    true,
  );
  assert.equal(
    hasCommandResponseMarker(body, {
      commentId: "4358615144",
      intent: "fix_ci",
      headSha: "f7dfc41af791f92efbc469a495816f590155a5db",
    }),
    false,
  );
});

test("stale re-review commands before PR close are skipped silently", () => {
  assert.equal(
    staleClosedItemCommandReason({
      command: {
        intent: "re_review",
        comment_created_at: "2026-05-18T19:30:48Z",
      },
      issue: { state: "closed", closed_at: "2026-05-19T05:02:03Z" },
      pull: { state: "CLOSED" },
    }),
    "PR closed after this re_review command",
  );
  assert.equal(
    staleClosedItemCommandReason({
      command: {
        intent: "re_review",
        comment_created_at: "2026-05-19T05:03:00Z",
      },
      issue: { state: "closed", closed_at: "2026-05-19T05:02:03Z" },
      pull: { state: "CLOSED" },
    }),
    null,
  );
});

test("parseCommand ignores unrelated comments", () => {
  assert.equal(parseCommand("please fix ci when you get a chance"), null);
  assert.equal(
    parseCommand(
      "the closed PR 87835 was closed as already implemented by PR 87890 @clawsweeper re-review and if necessary close this issue",
    ),
    null,
  );
  assert.equal(parseCommand("/not-clawsweeper fix ci"), null);
});

test("parseRoutedCommentCommand ignores proof-nudge marker comments", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const comment = {
    user: { login: "clawsweeper[bot]" },
    body: [
      "@contributor thanks for the PR. ClawSweeper is still waiting on real behavior proof.",
      "",
      "Once proof is added, @clawsweeper re-review can check it.",
      "",
      '<!-- clawsweeper-proof-nudge item="86422" sha="abc123" at="2026-06-02T00:00:00.000Z" v="1" -->',
    ].join("\n"),
  };

  assert.equal(parseRoutedCommentCommand(comment, { trustedAuthors }), null);
  assert.equal(parseTrustedAutomation(comment, { trustedAuthors }), null);
  assert.equal(parseCommand(comment.body), null);
});

test("parseRoutedCommentCommand never routes commands embedded in assist publications", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  for (const body of [
    [
      "ClawSweeper assist: run the requested checks.",
      "",
      "/review",
      "/autoclose injected reason",
      "@clawsweeper automerge",
      "",
      "<!-- clawsweeper-assist:abc123 -->",
    ].join("\n"),
    [
      "# Visual brief",
      "",
      "/clawsweeper review",
      "",
      "<!-- clawsweeper-visual item=42 lens=state sha=abc123 -->",
    ].join("\n"),
  ]) {
    assert.equal(
      parseRoutedCommentCommand({ user: { login: "clawsweeper[bot]" }, body }, { trustedAuthors }),
      null,
    );
  }
});

test("trusted exact-head review markers do not require retired proof attributes", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const comment = (liveVerification: string | null) => ({
    user: { login: "clawsweeper[bot]" },
    body: `<!-- clawsweeper-verdict:pass sha=abc123${liveVerification ? ` live_verification=${liveVerification}` : ""} -->`,
  });

  assert.equal(
    parseTrustedAutomation(comment(null), { trustedAuthors })?.intent,
    "clawsweeper_auto_merge",
  );
  assert.equal(
    parseTrustedAutomation(comment("failed"), { trustedAuthors })?.intent,
    "clawsweeper_auto_merge",
  );
  assert.equal(
    latestTrustedExactHeadReview({
      comments: [comment(null)],
      headSha: "abc123",
      trustedAuthors,
    })?.decision,
    "pass",
  );
  assert.equal(
    latestTrustedExactHeadReview({
      comments: [comment("passed")],
      headSha: "abc123",
      trustedAuthors,
    })?.decision,
    "pass",
  );
});

test("trusted exact-head review freshness uses edited publication time, not input order", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const headSha = "abc123";
  const editedPass = {
    id: 101,
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-08-27T12:00:00Z",
    updated_at: "2026-08-27T12:05:00Z",
    body: `<!-- clawsweeper-verdict:pass live_verification=absent sha=${headSha} -->`,
  };
  const repair = {
    id: 102,
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-08-27T12:02:00Z",
    updated_at: "2026-08-27T12:02:00Z",
    body: `<!-- clawsweeper-action:fix-required sha=${headSha} -->`,
  };

  for (const comments of [
    [editedPass, repair],
    [repair, editedPass],
  ]) {
    const review = latestTrustedExactHeadReview({ comments, headSha, trustedAuthors });
    assert.equal(review?.decision, "pass");
    assert.equal(review?.commentUpdatedAt, editedPass.updated_at);
  }

  const tiedRepair = { ...repair, updated_at: editedPass.updated_at };
  for (const comments of [
    [editedPass, tiedRepair],
    [tiedRepair, editedPass],
  ]) {
    assert.equal(
      latestTrustedExactHeadReview({ comments, headSha, trustedAuthors })?.decision,
      "repair",
    );
  }
});

test("expired review start leases select only provably lapsed dedicated lease comments", () => {
  const itemNumber = 24;
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const leaseComment = (id, owner, startedAt, expiresAt, overrides = {}) => ({
    id,
    user: { login: overrides.login ?? "clawsweeper[bot]" },
    body: [
      "ClawSweeper status: review started.",
      `<!-- clawsweeper-review-status:started item=${itemNumber} sha=${headSha} started_at=${startedAt} lease_expires_at=${expiresAt}${owner ? ` owner=${owner}` : ""} v=${overrides.version ?? "1"} -->`,
      overrides.identityMarker ?? `<!-- clawsweeper-review-lease item=${itemNumber} -->`,
    ].join("\n"),
  });
  const nowMs = Date.parse("2026-07-11T01:38:00.000Z");
  const options = {
    itemNumber,
    trustedAuthors: new Set(["clawsweeper[bot]"]),
    nowMs,
  };

  const expiredUuidOwner = leaseComment(
    101,
    "5749cf7a-f0ff-4a0f-ad39-e4e0534b38e0",
    "2026-07-10T20:14:01.432Z",
    "2026-07-10T20:44:01.432Z",
  );
  const expiredRunOwner = leaseComment(
    102,
    "github-run-29134971283-1",
    "2026-07-10T20:49:54.000Z",
    "2026-07-10T21:19:54.000Z",
  );
  const freshLease = leaseComment(
    103,
    "github-run-29135098886-1",
    "2026-07-11T01:37:58.000Z",
    "2026-07-11T02:07:58.000Z",
  );
  const malformedExpiry = leaseComment(104, "owner-a", "2026-07-10T20:14:01.432Z", "not-a-date");
  const untrustedAuthor = leaseComment(
    105,
    "owner-b",
    "2026-07-10T20:14:01.432Z",
    "2026-07-10T20:44:01.432Z",
    { login: "impostor" },
  );
  const legacyReviewComment = leaseComment(
    106,
    "owner-c",
    "2026-07-10T20:14:01.432Z",
    "2026-07-10T20:44:01.432Z",
    { identityMarker: `<!-- clawsweeper-review item=${itemNumber} -->` },
  );
  const idlessExpired = {
    ...leaseComment(0, "owner-d", "2026-07-10T20:14:01.432Z", "2026-07-10T20:44:01.432Z"),
    id: undefined,
  };

  assert.deepEqual(
    expiredReviewStartStatusLeases({
      ...options,
      comments: [
        expiredUuidOwner,
        expiredRunOwner,
        freshLease,
        malformedExpiry,
        untrustedAuthor,
        legacyReviewComment,
        idlessExpired,
      ],
    }),
    [
      { commentId: 101, expiresAt: "2026-07-10T20:44:01.432Z" },
      { commentId: 102, expiresAt: "2026-07-10T21:19:54.000Z" },
    ],
  );
  assert.deepEqual(expiredReviewStartStatusLeases({ ...options, comments: [freshLease] }), []);
  assert.deepEqual(
    expiredReviewStartStatusLeases({
      ...options,
      itemNumber: 25,
      comments: [expiredUuidOwner],
    }),
    [],
  );
});

test("superseded review start leases select only trusted dedicated comments for older heads", () => {
  const itemNumber = 24;
  const currentHead = "b".repeat(40);
  const oldHead = "a".repeat(40);
  const leaseComment = (id, headSha, overrides = {}) => ({
    id,
    user: { login: overrides.login ?? "clawsweeper[bot]" },
    body: [
      "ClawSweeper status: review started.",
      `<!-- clawsweeper-review-status:started item=${itemNumber} sha=${headSha} started_at=2026-07-21T05:00:00.000Z lease_expires_at=2026-07-21T06:00:00.000Z owner=run-${id} v=${overrides.version ?? "1"} -->`,
      overrides.identityMarker ?? `<!-- clawsweeper-review-lease item=${itemNumber} -->`,
    ].join("\n"),
  });

  assert.deepEqual(
    supersededReviewStartStatusLeases({
      comments: [
        leaseComment(101, oldHead),
        leaseComment(102, currentHead),
        leaseComment(103, oldHead, { login: "contributor" }),
        leaseComment(104, oldHead, { version: "2" }),
        leaseComment(105, oldHead, {
          identityMarker: `<!-- clawsweeper-review item=${itemNumber} -->`,
        }),
      ],
      itemNumber,
      headSha: currentHead,
      authoritativeHeadSha: currentHead,
      trustedAuthors: new Set(["clawsweeper[bot]"]),
    }),
    [{ commentId: 101, headSha: oldHead }],
  );
});

test("stale review A cannot classify newer-head lease B as superseded", () => {
  const itemNumber = 24;
  const staleHead = "a".repeat(40);
  const authoritativeHead = "b".repeat(40);
  const newerLease = {
    id: 202,
    user: { login: "clawsweeper[bot]" },
    body: [
      "ClawSweeper status: review started.",
      `<!-- clawsweeper-review-status:started item=${itemNumber} sha=${authoritativeHead} started_at=2026-07-21T05:01:00.000Z lease_expires_at=2026-07-21T06:01:00.000Z owner=worker-b v=1 -->`,
      `<!-- clawsweeper-review-lease item=${itemNumber} -->`,
    ].join("\n"),
  };

  assert.deepEqual(
    supersededReviewStartStatusLeases({
      comments: [newerLease],
      itemNumber,
      headSha: staleHead,
      authoritativeHeadSha: authoritativeHead,
      trustedAuthors: new Set(["clawsweeper[bot]"]),
    }),
    [],
  );
});

test("first server-created same-head review lease suppresses verdicts without its exact identity", () => {
  const itemNumber = 103109;
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const leaseComment = (
    id: number,
    owner: string,
    startedAt: string,
    expiresAt: string,
    login = "clawsweeper[bot]",
  ) => ({
    id,
    user: { login },
    body: [
      `<!-- clawsweeper-review-status:started item=${itemNumber} sha=${headSha} started_at=${startedAt} lease_expires_at=${expiresAt} owner=${owner} v=1 -->`,
      `<!-- clawsweeper-review-lease item=${itemNumber} -->`,
    ].join("\n"),
  });
  const lease = freshExactHeadReviewStartLease({
    comments: [
      leaseComment(100, "worker-old", "2026-07-09T21:00:00.000Z", "2026-07-09T21:30:00.000Z"),
      leaseComment(200, "worker-new", "2026-07-09T21:10:00.000Z", "2026-07-09T21:40:00.000Z"),
    ],
    itemNumber,
    headSha,
    trustedAuthors: new Set(["clawsweeper[bot]"]),
    nowMs: Date.parse("2026-07-09T21:15:00.000Z"),
  });
  assert.deepEqual(lease, {
    startedAt: "2026-07-09T21:00:00.000Z",
    expiresAt: "2026-07-09T21:30:00.000Z",
    owner: "worker-old",
    commentId: 100,
  });

  const command = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: `<!-- clawsweeper-verdict:pass live_verification=absent item=${itemNumber} sha=${headSha} reviewed_at=2026-07-09T21:05:00.000Z -->`,
    },
    { trustedAuthors: new Set(["clawsweeper[bot]"]) },
  );
  assert.equal(command?.intent, "clawsweeper_auto_merge");
  assert.equal(
    trustedAutomationPredatesReviewStartLease({ command, currentHeadSha: headSha, lease }),
    true,
  );
  assert.equal(
    trustedAutomationPredatesReviewStartLease({
      command: { ...command, reviewed_at: null },
      currentHeadSha: headSha,
      lease,
    }),
    true,
  );
  assert.equal(
    trustedAutomationPredatesReviewStartLease({
      command: {
        ...command,
        reviewed_at: "2026-07-09T21:10:00.000Z",
        review_lease_owner: "worker-old",
        review_lease_comment_id: "100",
      },
      currentHeadSha: headSha,
      lease,
    }),
    false,
  );
  assert.equal(
    trustedAutomationPredatesReviewStartLease({
      command: {
        ...command,
        reviewed_at: "2026-07-09T21:11:00.000Z",
        review_lease_owner: "other-worker",
        review_lease_comment_id: "100",
      },
      currentHeadSha: headSha,
      lease,
    }),
    true,
  );
  assert.equal(
    trustedAutomationPredatesReviewStartLease({
      command: {
        ...command,
        expected_head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      currentHeadSha: headSha,
      lease,
    }),
    true,
  );
  assert.equal(
    trustedAutomationPredatesReviewStartLease({ command, currentHeadSha: headSha, lease: null }),
    false,
  );
});

test("review start leases reject malformed, future, and overlong markers", () => {
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const lease = (attributes: string) =>
    freshExactHeadReviewStartLease({
      comments: [
        {
          user: { login: "clawsweeper[bot]" },
          body: [
            `<!-- clawsweeper-review-status:started item=103109 sha=${headSha} ${attributes} v=1 -->`,
            "<!-- clawsweeper-review-lease item=103109 -->",
          ].join("\n"),
        },
      ],
      itemNumber: 103109,
      headSha,
      trustedAuthors: new Set(["clawsweeper[bot]"]),
      nowMs: Date.parse("2026-07-09T21:07:21.000Z"),
    });

  assert.equal(lease("started_at=invalid lease_expires_at=2026-07-09T21:31:47.000Z"), null);
  assert.equal(
    lease("started_at=2026-07-09T21:13:00.000Z lease_expires_at=2026-07-09T21:31:47.000Z"),
    null,
  );
  assert.equal(
    lease("started_at=2026-07-09T21:01:47.000Z lease_expires_at=2026-07-09T23:01:47.001Z"),
    null,
  );
});

test("same-head completion freshness uses durable publication time", () => {
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const sourceRevision = "1".repeat(64);
  const comment = {
    id: 1234,
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-07-09T21:00:00.000Z",
    updated_at: "2026-07-09T21:05:30.000Z",
    body: `<!-- clawsweeper-verdict:pass live_verification=absent item=103109 sha=${headSha} source_revision=${sourceRevision} reviewed_at=2026-07-09T21:04:30.000Z -->`,
  };

  assert.deepEqual(
    trustedExactHeadReviewCompletionSince({
      comments: [comment],
      headSha,
      trustedAuthors: new Set(["clawsweeper[bot]"]),
      sinceMs: Date.parse("2026-07-09T21:05:00.000Z"),
    }),
    {
      commentId: 1234,
      reviewedAt: "2026-07-09T21:04:30.000Z",
      publishedAt: "2026-07-09T21:05:30.000Z",
      sourceRevision,
    },
  );
  assert.equal(
    trustedExactHeadReviewCompletionSince({
      comments: [comment],
      headSha,
      trustedAuthors: new Set(["clawsweeper[bot]"]),
      sinceMs: Date.parse("2026-07-09T21:06:00.000Z"),
    }),
    null,
  );
});

test("review start leases parse only the canonical marker beside the durable identity", () => {
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const comment = {
    user: { login: "clawsweeper[bot]" },
    body: [
      `Echoed title <!-- clawsweeper-review-status:started item=103109 sha=${headSha} started_at=2026-07-09T21:01:47.000Z lease_expires_at=2026-07-09T22:01:47.000Z v=1 -->`,
      `<!-- clawsweeper-review-status:started item=103109 sha=${headSha} started_at=2026-07-09T20:31:47.000Z lease_expires_at=2026-07-09T21:00:00.000Z v=1 -->`,
      "<!-- clawsweeper-review item=103109 -->",
    ].join("\n\n"),
  };

  assert.equal(
    freshExactHeadReviewStartLease({
      comments: [comment],
      itemNumber: 103109,
      headSha,
      trustedAuthors: new Set(["clawsweeper[bot]"]),
      nowMs: Date.parse("2026-07-09T21:07:21.000Z"),
    }),
    null,
  );
});

test("active review comments cannot replay their previous trusted verdict", () => {
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const comment = {
    user: { login: "clawsweeper[bot]" },
    body: [
      `<!-- clawsweeper-verdict:pass live_verification=absent item=103109 sha=${headSha} -->`,
      `<!-- clawsweeper-review-status:started item=103109 sha=${headSha} started_at=2026-07-09T21:01:47.000Z lease_expires_at=2026-07-09T21:31:47.000Z v=1 -->`,
      "<!-- clawsweeper-review item=103109 -->",
    ].join("\n\n"),
  };

  assert.equal(
    parseRoutedCommentCommand(comment, {
      trustedAuthors: new Set(["clawsweeper[bot]"]),
    }),
    null,
  );
});

test("parseTrustedAutomation ignores prose-only ClawSweeper review text", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  assert.equal(
    parseTrustedAutomation(
      {
        user: { login: "clawsweeper[bot]" },
        body: "ClawSweeper review: this PR still has failing checks; please fix.",
      },
      { trustedAuthors },
    ),
    null,
  );
  assert.equal(
    parseTrustedAutomation(
      {
        user: { login: "clawsweeper[bot]" },
        body: "ClawSweeper review: looks good, no actionable findings.",
      },
      { trustedAuthors },
    ),
    null,
  );
});

test("renderResponse describes stop as revoking repair-loop labels", () => {
  const body = renderResponse(
    {
      comment_id: "456",
      intent: "stop",
      target: { head_sha: "abc123" },
      actions: [
        { action: "remove_label", label: "clawsweeper:automerge", status: "executed" },
        { action: "label", label: "clawsweeper:human-review", status: "executed" },
      ],
    },
    null,
  );

  assert.match(body, /added `clawsweeper:human-review`/);
  assert.match(body, /removed `clawsweeper:automerge`/);
});

test("renderResponse avoids self-linking current item numbers in explain replies", () => {
  const prBody = renderResponse(
    {
      comment_id: "74578",
      intent: "explain",
      issue_number: 74578,
      target: {
        kind: "pull_request",
        head_sha: "abc74578",
        branch: "fix/example",
        labels: ["clawsweeper:automerge"],
        checks: { counts: { SUCCESS: 3 }, blockers: [] },
      },
    },
    null,
  );
  const issueBody = renderResponse(
    {
      comment_id: "74579",
      intent: "explain",
      issue_number: 74579,
      target: {
        kind: "issue",
        head_sha: null,
        state: "open",
      },
    },
    null,
  );

  assert.match(prBody, /- Current PR: `74578`/);
  assert.doesNotMatch(prBody, /- PR: #74578/);
  assert.match(issueBody, /- Current issue: `74579`/);
  assert.doesNotMatch(issueBody, /- Issue: #74579/);
});

test("maintainer command authorization requires maintainer repository permission", () => {
  const allowedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
  assert.equal(
    isMaintainerCommandAllowed({
      authorAssociation: "MEMBER",
      repositoryPermission: null,
      allowedAssociations,
    }),
    false,
  );
  assert.equal(
    isMaintainerCommandAllowed({
      authorAssociation: "MEMBER",
      repositoryPermission: "write",
      allowedAssociations,
    }),
    true,
  );
  assert.equal(
    isMaintainerCommandAllowed({
      authorAssociation: "CONTRIBUTOR",
      repositoryPermission: "admin",
      allowedAssociations,
    }),
    true,
  );
  assert.equal(
    isMaintainerCommandAllowed({
      authorAssociation: "CONTRIBUTOR",
      repositoryPermission: "read",
      allowedAssociations,
    }),
    false,
  );
  assert.equal(
    isMaintainerCommandAllowed({
      authorAssociation: "OWNER",
      repositoryPermission: null,
      allowedAssociations,
    }),
    true,
  );
});

test("issue authors can request read-only re-review with trailing context", () => {
  const command = {
    ...parseCommand("@clawsweeper re-review based on latest comments"),
    author: "issue-author",
  };

  assert.equal(
    isAuthorReadOnlyCommandAllowed({
      command,
      target: { author: "issue-author" },
    }),
    true,
  );
  assert.equal(
    isAuthorReadOnlyCommandAllowed({
      command,
      target: { author: "someone-else" },
    }),
    false,
  );
});

test("retired commands produce one short durable response and no repair actions", () => {
  for (const text of [
    "autofix",
    "automerge",
    "fix ci",
    "address review",
    "rebase",
    "implement",
    "build override fix this",
    "autoclose duplicate",
    "ask why",
    "visualize",
    "proof",
    "approve",
    "fix_ci",
    "address_review",
    "implement_issue",
    "status",
  ]) {
    const parsed = parseCommand(`@clawsweeper ${text}`);
    assert.equal(parsed?.intent, "retired", text);
    const command = { ...parsed, comment_id: "123", comment_version_key: "123:v1", target: {} };
    const body = renderResponse(command, null);
    assert.equal(body.split("\n").filter((line) => !line.startsWith("<!--")).length, 1);
    assert.match(body, /is retired; ClawSweeper now only reviews\./);
    assert.equal(
      hasCommandResponseMarker(body, {
        commentId: "123:v1",
        intent: "retired",
        matchAnyHead: true,
      }),
      true,
    );
    assert.equal(existingCommandStatusBlocksReplay({ hasExistingResponse: true }), true);
    assert.equal(commandHasAction(command, "dispatch_repair"), false);
    assert.equal(commandHasAction(command, "merge"), false);
  }
});

test("kept command spellings still enter the review-only router", () => {
  for (const text of ["review", "re-review", "review again", "re_review"]) {
    assert.equal(parseCommand(`@clawsweeper ${text}`)?.intent, "re_review", text);
  }
  for (const body of [
    "@clawsweeper\nreview\nFocus on the timeout failure",
    "@clawsweeper review\nFocus on the timeout failure",
    "/clawsweeper review\nFocus on the timeout failure",
  ]) {
    assert.equal(parseCommand(body)?.intent, "re_review");
    assert.equal(parseCommand(body)?.freeform_prompt, "Focus on the timeout failure");
  }
  assert.equal(parseCommand("@clawsweeper explain")?.intent, "explain");
  assert.equal(parseCommand("@clawsweeper stop")?.intent, "stop");
  assert.equal(parseCommand("/review")?.intent, "re_review");
});

test("automatic bot feedback is readable history but never routed", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  for (const action of ["pass", "needs-changes", "human-review", "close"]) {
    const comment = {
      user: { login: "clawsweeper[bot]" },
      body: `<!-- clawsweeper-verdict:${action} live_verification=absent sha=abc123 -->\n@clawsweeper autofix`,
    };
    assert.notEqual(parseTrustedAutomation(comment, { trustedAuthors }), null);
    assert.equal(parseRoutedCommentCommand(comment, { trustedAuthors }), null);
  }
});
