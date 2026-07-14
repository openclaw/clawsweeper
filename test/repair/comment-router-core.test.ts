import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUTOCLOSE_INTENTS,
  MERGE_INTENTS,
  REPAIR_INTENTS,
  autocloseReasonFromCommand,
  autoRepairBlockReason,
  autoRepairHeadKey,
  automergeActivationRepairReason,
  automergeChangelogBlockReason,
  automergeFailedChecksRepairReason,
  automergeClusterId,
  automergeRequestedByFromComments,
  automergeRequestedByFromBody,
  automergeGateBlockReason,
  automergeJobBranch,
  automergeJobPath,
  automergeReadinessRepairReason,
  automergeTransientWaitConfig,
  buildClawSweeperAssistDispatchPayload,
  buildAutomergeMergeArgs,
  buildAutomergeSquashMessage,
  commandHasAction,
  createCachedIssueCommentsLookup,
  createCachedIssueCommentsLookupAsync,
  commandResponseMarker,
  commandResponseMarkerPrefix,
  commandStatusMarkerFromBody,
  commandStatusMarkerPrefix,
  createCachedLabelNumberLookup,
  existingCommandStatusBlocksReplay,
  existingModeStatusBlocksReplay,
  expiredReviewStartStatusLeases,
  freshExactHeadReviewStartLease,
  hasCommandResponseMarker,
  issueImplementationClusterId,
  issueImplementationBlockerClass,
  issueImplementationJobBranch,
  issueImplementationJobPath,
  isCanonicalLandingNeedsHumanText,
  isReadyHumanReviewPause,
  latestRepairLoopResumeTime,
  isAuthorReadOnlyCommandAllowed,
  isMaintainerCommandAllowed,
  isIssueImplementationCommandAllowed,
  maintainerAutomergeOptInApprovesNeedsHuman,
  maintainerModeCommandCanResumePausedMode,
  parseCommand,
  parseRoutedCommentCommand,
  planCommandAckConvergence,
  pausedModeStatusBlocksReplay,
  parseTrustedAutomation,
  repairableCheckBlockers,
  reviewOnlyRepairLoopCompletionLabels,
  reviewOnlyRepairLoopMergeStateBlockReason,
  reviewOnlyRepairLoopMissingChecks,
  reviewOnlyRepairLoopPendingChecks,
  reviewOnlyRepairLoopTerminalChecks,
  repairLoopPauseLabels,
  repairLoopStopPauseReason,
  reviewedHeadShaBlockReason,
  renderAutomergeJob,
  renderIssueImplementationJob,
  renderResponse,
  selectPullRepairJob,
  sharedAutomergeStatusMarkerPrefix,
  staleAutomergeActivationReason,
  staleClosedItemCommandReason,
  shouldClearMaintainerCommandReaction,
  trustedAutomationPredatesReviewStartLease,
  trustedExactHeadReviewCompletionSince,
  trustedCloseBlockReason,
  usesSharedAutomergeStatus,
} from "../../dist/repair/comment-router-core.js";
import { CLAWSWEEPER_CO_AUTHOR_TRAILER } from "../../dist/repair/co-author-credit.js";
import { issueSourceRevisionSha256 } from "../../dist/repair/issue-source-guard.js";
import { parseSimpleYaml, validateJob } from "../../dist/repair/lib.js";

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

test("parseCommand recognizes maintainer slash commands", () => {
  assert.deepEqual(parseCommand("/clawsweeper fix ci"), {
    trigger: "slash",
    command: "fix ci",
    intent: "fix_ci",
  });
  assert.deepEqual(parseCommand("notes\n  /clawsweeper address   review  \nthanks"), {
    trigger: "slash",
    command: "address review",
    intent: "address_review",
  });
  assert.deepEqual(parseCommand("/clawsweeper"), {
    trigger: "slash",
    command: "status",
    intent: "status",
  });
  assert.deepEqual(parseCommand("/clawsweeper automerge"), {
    trigger: "slash",
    command: "automerge",
    intent: "automerge",
  });
  assert.deepEqual(parseCommand("/clawsweeper auto-merge"), {
    trigger: "slash",
    command: "auto-merge",
    intent: "automerge",
  });
  assert.deepEqual(parseCommand("/clawsweeper auto merge"), {
    trigger: "slash",
    command: "auto merge",
    intent: "automerge",
  });
  assert.deepEqual(parseCommand("@clawsweeper automerge."), {
    trigger: "mention",
    command: "automerge",
    intent: "automerge",
  });
  assert.deepEqual(parseCommand("@clawsweeper auto-merge"), {
    trigger: "mention",
    command: "auto-merge",
    intent: "automerge",
  });
  assert.deepEqual(parseCommand("@clawsweeper auto merge"), {
    trigger: "mention",
    command: "auto merge",
    intent: "automerge",
  });
  assert.deepEqual(
    parseCommand(
      "@clawsweeper automerge\nSpecial instructions: preserve fallback behavior by default.",
    ),
    {
      trigger: "mention",
      command: "automerge",
      intent: "automerge",
      automerge_instructions: "Special instructions: preserve fallback behavior by default.",
    },
  );
  assert.deepEqual(parseCommand("/clawsweeper automerge\nPreserve existing config behavior."), {
    trigger: "slash",
    command: "automerge",
    intent: "automerge",
    automerge_instructions: "Preserve existing config behavior.",
  });
  assert.deepEqual(parseCommand("/clawsweeper automerge!"), {
    trigger: "slash",
    command: "automerge",
    intent: "automerge",
  });
  assert.deepEqual(parseCommand("/clawsweeper autofix"), {
    trigger: "slash",
    command: "autofix",
    intent: "autofix",
  });
  assert.deepEqual(parseCommand("/clawsweeper re-review"), {
    trigger: "slash",
    command: "re-review",
    intent: "re_review",
  });
  assert.deepEqual(parseCommand("/clawsweeper re-run"), {
    trigger: "slash",
    command: "re-run",
    intent: "re_review",
  });
  assert.deepEqual(parseCommand("/review"), {
    trigger: "slash",
    command: "review",
    intent: "re_review",
  });
  assert.deepEqual(parseCommand("/clawsweeper review"), {
    trigger: "slash",
    command: "review",
    intent: "re_review",
  });
  assert.deepEqual(parseCommand("/clawsweeper review again"), {
    trigger: "slash",
    command: "review again",
    intent: "re_review",
  });
  assert.deepEqual(parseCommand("/clawsweeper implement"), {
    trigger: "slash",
    command: "implement",
    intent: "implement_issue",
    implementation_prompt: "",
  });
  assert.deepEqual(parseCommand("/clawsweeper build add export support"), {
    trigger: "slash",
    command: "build add export support",
    intent: "implement_issue",
    implementation_prompt: "add export support",
  });
  assert.deepEqual(parseCommand("/clawsweeper build override"), {
    trigger: "slash",
    command: "build override",
    intent: "implement_issue",
    implementation_prompt: "",
    operator_override: true,
  });
  assert.deepEqual(parseCommand("/clawsweeper build override\nKeep the handoff concrete."), {
    trigger: "slash",
    command: "build override keep the handoff concrete",
    intent: "implement_issue",
    implementation_prompt: "Keep the handoff concrete.",
    operator_override: true,
  });
  assert.deepEqual(parseCommand("/clawsweeper create pr keep the fix narrow"), {
    trigger: "slash",
    command: "create pr keep the fix narrow",
    intent: "implement_issue",
    implementation_prompt: "keep the fix narrow",
  });
  assert.deepEqual(parseCommand("/clawsweeper implement\nKeep it small.\nAdd tests."), {
    trigger: "slash",
    command: "implement keep it small. add tests",
    intent: "implement_issue",
    implementation_prompt: "Keep it small.\nAdd tests.",
  });
  assert.deepEqual(parseCommand("/clawsweeper approve"), {
    trigger: "slash",
    command: "approve",
    intent: "maintainer_approve_automerge",
  });
  assert.deepEqual(parseCommand("/clawsweeper approve automerge"), {
    trigger: "slash",
    command: "approve automerge",
    intent: "maintainer_approve_automerge",
  });
  assert.deepEqual(parseCommand("/clawsweeper merge"), {
    trigger: "slash",
    command: "merge",
    intent: "maintainer_approve_automerge",
  });
  assert.deepEqual(parseCommand("@clawsweeper merge"), {
    trigger: "mention",
    command: "merge",
    intent: "maintainer_approve_automerge",
  });
  assert.deepEqual(parseCommand("/automerge"), {
    trigger: "slash",
    command: "automerge",
    intent: "automerge",
  });
  assert.deepEqual(parseCommand("/auto-merge"), {
    trigger: "slash",
    command: "automerge",
    intent: "automerge",
  });
  assert.deepEqual(parseCommand("/auto merge"), {
    trigger: "slash",
    command: "automerge",
    intent: "automerge",
  });
  assert.deepEqual(parseCommand("/autoclose We do not plan to support this feature"), {
    trigger: "slash",
    command: "autoclose we do not plan to support this feature",
    intent: "autoclose",
    autoclose_message: "We do not plan to support this feature",
  });
  assert.deepEqual(parseCommand("/clawsweeper autoclose Not a direction for OpenClaw"), {
    trigger: "slash",
    command: "autoclose not a direction for openclaw",
    intent: "autoclose",
    autoclose_message: "Not a direction for OpenClaw",
  });
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

test("cached label number lookup fetches each label once and returns stable copies", () => {
  const calls: string[] = [];
  const lookup = createCachedLabelNumberLookup((label) => {
    calls.push(label);
    return label === "clawsweeper:autofix" ? ["10", 10, 0, "bad", 11, 10] : [20];
  });

  const first = lookup("clawsweeper:autofix");
  first.push(99);

  assert.deepEqual(first, [10, 11, 99]);
  assert.deepEqual(lookup("clawsweeper:autofix"), [10, 11]);
  assert.deepEqual(lookup("clawsweeper:automerge"), [20]);
  assert.deepEqual(lookup("clawsweeper:autofix"), [10, 11]);
  assert.deepEqual(calls, ["clawsweeper:autofix", "clawsweeper:automerge"]);
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

test("cached issue comments lookup does not cache malformed fetch results", async () => {
  const cache = new Map<number, { id: number }[]>();
  let syncCalls = 0;
  const syncLookup = createCachedIssueCommentsLookup(() => {
    syncCalls += 1;
    return "bad" as never;
  }, cache);

  assert.deepEqual(syncLookup(12), []);
  assert.deepEqual(syncLookup(12), []);
  assert.equal(syncCalls, 2);

  let asyncCalls = 0;
  const asyncLookup = createCachedIssueCommentsLookupAsync(async () => {
    asyncCalls += 1;
    return "bad" as never;
  }, cache);

  assert.deepEqual(await asyncLookup(12), []);
  assert.deepEqual(await asyncLookup(12), []);
  assert.equal(asyncCalls, 2);
});

test("autoclose reason parser preserves maintainer wording", () => {
  assert.equal(
    autocloseReasonFromCommand("autoclose We don't want this feature"),
    "We don't want this feature",
  );
  assert.equal(autocloseReasonFromCommand("autoclose"), "");
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

  const existingEnabled = {
    hasModeLabel: true,
    hasJobPath: true,
    hasPauseLabels: false,
    hasOppositeModeLabel: false,
    hasExistingModeStatusResponse: true,
  };
  assert.equal(existingModeStatusBlocksReplay({ ...existingEnabled, forceReprocess: false }), true);
  assert.equal(existingModeStatusBlocksReplay({ ...existingEnabled, forceReprocess: true }), false);
  assert.equal(
    pausedModeStatusBlocksReplay({
      hasPauseLabels: true,
      hasExistingModeStatusResponse: true,
      forceReprocess: false,
    }),
    true,
  );
  assert.equal(
    pausedModeStatusBlocksReplay({
      hasPauseLabels: true,
      hasExistingModeStatusResponse: true,
      allowNewMaintainerModeCommand: true,
      forceReprocess: false,
    }),
    false,
    "old shared automerge status plus human-review must not block a fresh maintainer automerge command",
  );
  assert.equal(
    pausedModeStatusBlocksReplay({
      hasPauseLabels: true,
      hasExistingModeStatusResponse: true,
      allowNewMaintainerModeCommand: false,
      forceReprocess: false,
    }),
    true,
    "bot replay and label-sweep mode status should stay paused until a maintainer asks again",
  );
  assert.equal(
    pausedModeStatusBlocksReplay({
      hasPauseLabels: true,
      hasExistingModeStatusResponse: true,
      forceReprocess: true,
    }),
    false,
  );
});

test("automerge status marker prefix is stable across head changes", () => {
  assert.equal(
    commandStatusMarkerPrefix({
      issue_number: 75338,
      intent: "automerge",
      target: { head_sha: "old" },
    }),
    "<!-- clawsweeper-command-status:75338:automerge:",
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
    {
      repair: {
        workflow: "repair cluster worker",
        job_path: "jobs/openclaw/inbox/automerge-openclaw-openclaw-75423.md",
        mode: "maintainer-command",
        model: "gpt-5.6-sol",
      },
    },
  );

  assert.match(body, /clawsweeper-command:4358615144:fix_ci:dc3e9a97a2c655/);
  assert.equal(
    commandResponseMarker({
      commentId: "4358615144",
      intent: "fix_ci",
      headSha: "dc3e9a97a2c655c0c054cddb5a64e7b6fc51dd10",
    }),
    "<!-- clawsweeper-command:4358615144:fix_ci:dc3e9a97a2c655c0c054cddb5a64e7b6fc51dd10 -->",
  );
  assert.equal(
    commandResponseMarkerPrefix({ commentId: "4358615144", intent: "fix_ci" }),
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

test("stale automerge activation commands after merge are skipped silently", () => {
  assert.equal(
    staleAutomergeActivationReason({
      command: {
        intent: "automerge",
        comment_created_at: "2026-05-01T01:27:37Z",
      },
      issue: { state: "closed", closed_at: "2026-05-01T01:49:03Z" },
      pull: { state: "MERGED", mergedAt: "2026-05-01T01:49:03Z" },
    }),
    "automerge already completed after this command",
  );
  assert.equal(
    staleAutomergeActivationReason({
      command: {
        intent: "automerge",
        comment_created_at: "2026-05-01T01:50:00Z",
      },
      issue: { state: "closed", closed_at: "2026-05-01T01:49:03Z" },
      pull: { state: "MERGED", mergedAt: "2026-05-01T01:49:03Z" },
    }),
    null,
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

test("later stop command pauses older automerge automation", () => {
  const entries = [
    {
      repo: "openclaw/openclaw",
      issue_number: 76686,
      intent: "automerge",
      comment_updated_at: "2026-05-03T12:55:27Z",
    },
    {
      repo: "openclaw/openclaw",
      issue_number: 76686,
      intent: "stop",
      comment_updated_at: "2026-05-03T12:59:16Z",
    },
  ];

  assert.equal(
    repairLoopStopPauseReason({
      command: {
        repo: "openclaw/openclaw",
        issue_number: 76686,
        intent: "clawsweeper_auto_merge",
        trusted_bot: true,
        comment_updated_at: "2026-05-03T13:00:07Z",
      },
      entries,
    }),
    "ClawSweeper automation was paused by a later /clawsweeper stop command",
  );
  assert.equal(
    repairLoopStopPauseReason({
      command: {
        repo: "openclaw/openclaw",
        issue_number: 76686,
        intent: "automerge",
        comment_updated_at: "2026-05-03T13:05:00Z",
      },
      entries,
    }),
    null,
  );
});

test("paused mode resume requires a maintainer command after the pause", () => {
  const entries = [
    {
      repo: "openclaw/openclaw",
      issue_number: 93209,
      intent: "automerge",
      status: "executed",
      comment_updated_at: "2026-06-15T09:45:21Z",
    },
    {
      repo: "openclaw/openclaw",
      issue_number: 93209,
      intent: "stop",
      status: "executed",
      comment_updated_at: "2026-06-15T09:45:57Z",
    },
  ];

  assert.equal(
    maintainerModeCommandCanResumePausedMode({
      command: {
        repo: "openclaw/openclaw",
        issue_number: 93209,
        intent: "automerge",
        comment_updated_at: "2026-06-15T09:45:21Z",
      },
      entries,
    }),
    false,
  );
  assert.equal(
    maintainerModeCommandCanResumePausedMode({
      command: {
        repo: "openclaw/openclaw",
        issue_number: 93209,
        intent: "automerge",
        comment_updated_at: "2026-07-02T02:31:23Z",
      },
      entries,
    }),
    true,
  );
  assert.equal(
    maintainerModeCommandCanResumePausedMode({
      command: {
        repo: "openclaw/openclaw",
        issue_number: 93209,
        intent: "automerge",
        trusted_bot: true,
        comment_updated_at: "2026-07-02T02:31:23Z",
      },
      entries,
    }),
    false,
  );
});

test("automerge job helpers create stable adopted PR job identity", () => {
  assert.equal(automergeClusterId("openclaw/openclaw", 74112), "automerge-openclaw-openclaw-74112");
  assert.equal(
    automergeJobBranch("openclaw/openclaw", 74112),
    "clawsweeper/automerge-openclaw-openclaw-74112",
  );
  assert.equal(
    automergeJobPath("openclaw/openclaw", 74112),
    "jobs/openclaw/inbox/automerge-openclaw-openclaw-74112.md",
  );
});

test("issue implementation job helpers create stable issue PR job identity", () => {
  assert.equal(
    issueImplementationClusterId("openclaw/openclaw", 74112),
    "issue-openclaw-openclaw-74112",
  );
  assert.equal(
    issueImplementationJobBranch("openclaw/openclaw", 74112),
    "clawsweeper/issue-openclaw-openclaw-74112",
  );
  assert.equal(
    issueImplementationJobPath("openclaw/openclaw", 74112),
    "jobs/openclaw/inbox/issue-openclaw-openclaw-74112.md",
  );
});

test("generated PR repairs adopt a PR-specific job without losing the source job", () => {
  assert.deepEqual(
    selectPullRepairJob({
      sourceJobPath: "jobs/openclaw/inbox/issue-openclaw-clawsweeper-225.md",
      automergePath: "jobs/openclaw/inbox/automerge-openclaw-clawsweeper-279.md",
    }),
    {
      jobPath: "jobs/openclaw/inbox/issue-openclaw-clawsweeper-225.md",
      sourceJobPath: "jobs/openclaw/inbox/issue-openclaw-clawsweeper-225.md",
      automergeJobPath: "jobs/openclaw/inbox/automerge-openclaw-clawsweeper-279.md",
      hasAutomergeJob: false,
    },
  );

  assert.deepEqual(
    selectPullRepairJob({
      sourceJobPath: "jobs/openclaw/inbox/issue-openclaw-clawsweeper-225.md",
      adoptedJobPath: "jobs/openclaw/inbox/automerge-openclaw-clawsweeper-279.md",
      automergePath: "jobs/openclaw/inbox/automerge-openclaw-clawsweeper-279.md",
    }),
    {
      jobPath: "jobs/openclaw/inbox/automerge-openclaw-clawsweeper-279.md",
      sourceJobPath: "jobs/openclaw/inbox/issue-openclaw-clawsweeper-225.md",
      automergeJobPath: "jobs/openclaw/inbox/automerge-openclaw-clawsweeper-279.md",
      hasAutomergeJob: true,
    },
  );
});

test("renderAutomergeJob validates and keeps merge owned by router", () => {
  const raw = renderAutomergeJob({
    repo: "openclaw/openclaw",
    issueNumber: 74112,
    title: "Tighten cross-session message handling",
    author: "maintainer-user",
    authorId: 123456,
    commentUrl: "https://github.com/openclaw/openclaw/pull/74112#issuecomment-1",
    automergeInstructions: "Special instructions: preserve existing behavior by default.",
  });
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  assert.ok(match);
  const job = {
    frontmatter: parseSimpleYaml(match[1]),
    body: match[2].trim(),
  };

  assert.deepEqual(validateJob(job), []);
  assert.equal(job.frontmatter.job_intent, "automerge_pr");
  assert.equal(job.frontmatter.source, "pr_automerge");
  assert.equal(job.frontmatter.requested_by, "maintainer-user");
  assert.equal(job.frontmatter.requested_by_id, "123456");
  assert.equal(
    job.frontmatter.request_comment_url,
    "https://github.com/openclaw/openclaw/pull/74112#issuecomment-1",
  );
  assert.equal(job.frontmatter.allow_fix_pr, true);
  assert.equal(job.frontmatter.allow_merge, false);
  assert.deepEqual(job.frontmatter.blocked_actions, ["close", "merge"]);
  assert.deepEqual(job.frontmatter.allowed_actions, ["comment", "label", "fix", "raise_pr"]);
  assert.match(job.body, /repair_contributor_branch/);
  assert.match(job.body, /Codex edit pass can make this PR merge-ready/);
  assert.match(job.body, /rebase onto latest main/);
  assert.match(job.body, /fix CI\/check failures/);
  assert.match(job.body, /preserve release-note context when required/);
  assert.match(job.body, /Never add forbidden changelog credit lines/);
  assert.match(job.body, /router owns final merge/);
  assert.match(job.body, /Requested by: maintainer-user/);
  assert.match(job.body, /Maintainer special instructions:/);
  assert.match(job.body, /Special instructions: preserve existing behavior by default\./);
});

test("renderIssueImplementationJob validates and opens one non-closing fix PR lane", () => {
  const raw = renderIssueImplementationJob({
    repo: "openclaw/openclaw",
    issueNumber: 74113,
    title: "Add session export button",
    commentUrl: "https://github.com/openclaw/openclaw/issues/74113#issuecomment-1",
    author: "steipete",
    implementationPrompt: "Keep it scoped to the toolbar.",
  });
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  assert.ok(match);
  const job = {
    frontmatter: parseSimpleYaml(match[1]),
    body: match[2].trim(),
  };

  assert.deepEqual(validateJob(job), []);
  assert.equal(job.frontmatter.job_intent, "implement_issue");
  assert.equal(job.frontmatter.source, "issue_implementation");
  assert.equal(job.frontmatter.allow_fix_pr, true);
  assert.equal(job.frontmatter.allow_merge, false);
  assert.equal(job.frontmatter.allow_post_merge_close, false);
  assert.deepEqual(job.frontmatter.required_pr_labels, [
    "clawsweeper:autogenerated",
    "clawsweeper:autofix",
  ]);
  assert.deepEqual(job.frontmatter.blocked_actions, ["close", "merge"]);
  assert.deepEqual(job.frontmatter.allowed_actions, ["comment", "label", "fix", "raise_pr"]);
  assert.match(job.body, /Source issue: https:\/\/github\.com\/openclaw\/openclaw\/issues\/74113/);
  assert.match(job.body, /repair_strategy: "new_fix_pr"/);
  assert.match(job.body, /Do not close the issue from this lane/);
  assert.match(job.body, /Keep it scoped to the toolbar/);
});

test("review-only repair loops terminate on a clean exact-head review", () => {
  assert.deepEqual(
    reviewOnlyRepairLoopCompletionLabels(["clawsweeper:autofix", "clawsweeper:human-review"]),
    ["clawsweeper:human-review", "clawsweeper:autofix"],
  );
  assert.deepEqual(
    reviewOnlyRepairLoopCompletionLabels(["clawsweeper:autogenerated", "clawsweeper:automerge"]),
    ["clawsweeper:automerge"],
  );
  assert.deepEqual(reviewOnlyRepairLoopCompletionLabels(["clawsweeper:automerge"]), []);
  assert.equal(reviewOnlyRepairLoopMissingChecks(["clawsweeper:autofix"], { total: 0 }), true);
  assert.equal(reviewOnlyRepairLoopMissingChecks(["clawsweeper:autofix"], { total: 1 }), false);
  assert.equal(
    reviewOnlyRepairLoopMissingChecks(["clawsweeper:autofix"], {
      total: 1,
      gatingTotal: 0,
    }),
    true,
  );
  assert.equal(reviewOnlyRepairLoopMissingChecks(["clawsweeper:automerge"], { total: 0 }), false);
  assert.deepEqual(
    reviewOnlyRepairLoopPendingChecks(["clawsweeper:autofix"], {
      pending: ["build", "test"],
    }),
    ["build", "test"],
  );
  assert.deepEqual(
    reviewOnlyRepairLoopPendingChecks(["clawsweeper:automerge"], {
      pending: ["build"],
    }),
    [],
  );
  assert.deepEqual(
    reviewOnlyRepairLoopTerminalChecks(["clawsweeper:autofix"], {
      terminalBlockers: ["required-build:CANCELLED", "Vercel:ACTION_REQUIRED"],
    }),
    ["required-build:CANCELLED", "Vercel:ACTION_REQUIRED"],
  );
  assert.deepEqual(
    reviewOnlyRepairLoopTerminalChecks(["clawsweeper:automerge"], {
      terminalBlockers: ["required-build:CANCELLED"],
    }),
    [],
  );
  assert.equal(
    reviewOnlyRepairLoopMergeStateBlockReason(["clawsweeper:autofix"], {
      merge_state_status: "BLOCKED",
    }),
    "waiting for GitHub merge readiness before autofix completion: blocked",
  );
  assert.equal(
    reviewOnlyRepairLoopMergeStateBlockReason(["clawsweeper:autofix"], {
      merge_state_status: "CLEAN",
    }),
    null,
  );
  assert.equal(
    reviewOnlyRepairLoopMergeStateBlockReason(["clawsweeper:automerge"], {
      merge_state_status: "BLOCKED",
    }),
    null,
  );
});

test("renderIssueImplementationJob records maintainer build override metadata", () => {
  const raw = renderIssueImplementationJob({
    repo: "openclaw/openclaw",
    issueNumber: 74114,
    title: "Plan unsafe issue",
    author: "maintainer-user",
    operatorOverride: true,
    overrideRequestedBy: "maintainer-user",
    overrideReason: "maintainer requested /clawsweeper build override",
    overrideBlockerClass: "hard",
    overrideAction: "produce a safe non-code plan, decomposition, or human-review handoff",
  });
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  assert.ok(match);
  const job = {
    frontmatter: parseSimpleYaml(match[1]),
    body: match[2].trim(),
  };

  assert.deepEqual(validateJob(job), []);
  assert.equal(job.frontmatter.operator_override, true);
  assert.equal(job.frontmatter.override_requested_by, "maintainer-user");
  assert.equal(job.frontmatter.override_reason, "maintainer requested /clawsweeper build override");
  assert.equal(job.frontmatter.override_blocker_class, "hard");
  assert.equal(job.frontmatter.allow_fix_pr, false);
  assert.equal(job.frontmatter.security_sensitive, false);
  assert.deepEqual(job.frontmatter.allowed_actions, ["comment", "label"]);
  assert.deepEqual(job.frontmatter.blocked_actions, ["fix", "raise_pr", "close", "merge"]);
  assert.match(job.body, /hard blocker/);
  assert.match(job.body, /non-code artifact/);
  assert.match(job.body, /do not emit a `new_fix_pr` artifact/);
  assert.doesNotMatch(job.body, /repair_strategy: "new_fix_pr"/);
});

test("issue implementation blocker classifier treats linked PR evidence as hard", () => {
  assert.equal(issueImplementationBlockerClass("open PR already mentions this issue"), "hard");
  assert.equal(issueImplementationBlockerClass("work cluster references a PR"), "hard");
  assert.equal(issueImplementationBlockerClass("report repository is openclaw/other"), "hard");
  assert.equal(issueImplementationBlockerClass("missing validation commands"), "soft");
});

test("automerge changelog gate does not block user-facing OpenClaw changes", () => {
  assert.equal(
    automergeChangelogBlockReason({
      repo: "openclaw/openclaw",
      title: "fix(discord): cool down Cloudflare 429 responses",
      files: [
        { path: "extensions/discord/src/api.ts" },
        { path: "extensions/discord/src/api.test.ts" },
      ],
    }),
    null,
  );

  assert.equal(
    automergeChangelogBlockReason({
      repo: "openclaw/openclaw",
      title: "fix(agents): normalize Copilot replay tool IDs",
      files: [{ filename: "src/agents/openai-transport-stream.ts" }],
    }),
    null,
  );

  assert.equal(
    automergeChangelogBlockReason({
      repo: "openclaw/openclaw",
      title: "Log Telegram outbound delivery success",
      files: [
        { path: "extensions/telegram/src/send.ts" },
        { path: "extensions/telegram/src/send.test.ts" },
      ],
    }),
    null,
  );

  assert.equal(
    automergeChangelogBlockReason({
      repo: "openclaw/openclaw",
      title: "fix(discord): cool down Cloudflare 429 responses",
      files: [{ path: "CHANGELOG.md" }, { path: "extensions/discord/src/api.ts" }],
    }),
    null,
  );
});

test("automerge changelog gate ignores docs-only and tests-only changes", () => {
  assert.equal(
    automergeChangelogBlockReason({
      repo: "openclaw/openclaw",
      title: "docs(discord): clarify setup",
      files: [{ path: "docs/channels/discord.md" }],
    }),
    null,
  );
  assert.equal(
    automergeChangelogBlockReason({
      repo: "openclaw/openclaw",
      title: "fix(sdk): align test expectation",
      files: [{ path: "packages/sdk/src/index.test.ts" }],
    }),
    null,
  );
});

test("automerge activation does not send missing changelog to repair", () => {
  assert.equal(
    automergeActivationRepairReason({
      intent: "automerge",
      repo: "openclaw/openclaw",
      title: "Preserve session corpus labels",
      files: [
        { path: "extensions/memory-core/src/tools.ts" },
        { path: "extensions/memory-core/src/tools.test.ts" },
      ],
      target: { checks: { blockers: [] }, merge_state_status: "CLEAN", mergeable: "MERGEABLE" },
    }),
    null,
  );

  assert.equal(
    automergeActivationRepairReason({
      intent: "autofix",
      repo: "openclaw/openclaw",
      title: "fix(memory): preserve session corpus labels",
      files: [{ path: "extensions/memory-core/src/tools.ts" }],
      target: { checks: { blockers: [] }, merge_state_status: "CLEAN", mergeable: "MERGEABLE" },
    }),
    null,
  );
});

test("renderAutomergeJob documents autofix as repair-only", () => {
  const raw = renderAutomergeJob({
    repo: "openclaw/openclaw",
    issueNumber: 74610,
    title: "Add SDK package",
    repairMode: "autofix",
  });

  assert.match(raw, /Maintainer opted #74610 into ClawSweeper autofix/);
  assert.match(raw, /Final merge is disabled for autofix/);
  assert.doesNotMatch(raw, /opted #74610 into ClawSweeper automerge/);
});

test("parseCommand recognizes ClawSweeper bot mentions", () => {
  assert.deepEqual(parseCommand("@openclaw-clawsweeper[bot] rebase"), {
    trigger: "mention",
    command: "rebase",
    intent: "rebase",
  });
  assert.deepEqual(parseCommand("@openclaw-clawsweeper explain"), {
    trigger: "mention",
    command: "explain",
    intent: "explain",
  });
  assert.deepEqual(parseCommand("@clawsweeper re-review"), {
    trigger: "mention",
    command: "re-review",
    intent: "re_review",
  });
  assert.deepEqual(parseCommand("@clawsweeper Re-run"), {
    trigger: "mention",
    command: "re-run",
    intent: "re_review",
  });
  assert.deepEqual(parseCommand("@clawsweeper review"), {
    trigger: "mention",
    command: "review",
    intent: "re_review",
  });
  assert.deepEqual(parseCommand("@clawsweeper re-review based on latest comments"), {
    trigger: "mention",
    command: "re-review based on latest comments",
    intent: "re_review",
    freeform_prompt: "based on latest comments",
  });
  assert.deepEqual(parseCommand("@clawsweeper re-review: focus on CI"), {
    trigger: "mention",
    command: "re-review: focus on ci",
    intent: "re_review",
    freeform_prompt: "focus on CI",
  });
  assert.deepEqual(parseCommand("@clawsweeper review based on full details in the issue."), {
    trigger: "mention",
    command: "review based on full details in the issue",
    intent: "re_review",
    freeform_prompt: "based on full details in the issue.",
  });
  assert.deepEqual(parseCommand("/clawsweeper re-run after my last comment"), {
    trigger: "slash",
    command: "re-run after my last comment",
    intent: "re_review",
    freeform_prompt: "after my last comment",
  });
  assert.deepEqual(parseCommand("@clawsweeper implement"), {
    trigger: "mention",
    command: "implement",
    intent: "implement_issue",
    implementation_prompt: "",
  });
  assert.deepEqual(parseCommand("@clawsweeper fix"), {
    trigger: "mention",
    command: "fix",
    intent: "implement_issue",
    implementation_prompt: "",
  });
  assert.deepEqual(parseCommand("@clawsweeper fix\nPlease keep it narrow."), {
    trigger: "mention",
    command: "fix issue please keep it narrow",
    intent: "implement_issue",
    implementation_prompt: "Please keep it narrow.",
  });
  assert.deepEqual(parseCommand("@clawsweeper build\nAdd export support."), {
    trigger: "mention",
    command: "build add export support",
    intent: "implement_issue",
    implementation_prompt: "Add export support.",
  });
  assert.deepEqual(parseCommand("@clawsweeper fix issue\nPlease keep the UI small."), {
    trigger: "mention",
    command: "fix issue please keep the ui small",
    intent: "implement_issue",
    implementation_prompt: "Please keep the UI small.",
  });
  assert.deepEqual(parseCommand("@clawsweeper create pr\nKeep it small.\nAdd tests."), {
    trigger: "mention",
    command: "create pr keep it small. add tests",
    intent: "implement_issue",
    implementation_prompt: "Keep it small.\nAdd tests.",
  });
  assert.deepEqual(parseCommand("@clawsweeper[bot] rerun review"), {
    trigger: "mention",
    command: "rerun review",
    intent: "re_review",
  });
  assert.deepEqual(parseCommand("@clawsweeper why did automerge stop here?"), {
    trigger: "mention",
    command: "why did automerge stop here?",
    intent: "freeform_assist",
    freeform_prompt: "why did automerge stop here?",
  });
  assert.deepEqual(parseCommand("/clawsweeper ask is this blocked on flaky CI?"), {
    trigger: "slash",
    command: "ask is this blocked on flaky ci?",
    intent: "freeform_assist",
    freeform_prompt: "is this blocked on flaky CI?",
  });
  assert.deepEqual(parseCommand("/clawsweeper explain why this PR is not automerge-ready"), {
    trigger: "slash",
    command: "explain why this pr is not automerge-ready",
    intent: "freeform_assist",
    freeform_prompt: "why this PR is not automerge-ready",
  });
  assert.deepEqual(parseCommand("@clawsweeper visualize state"), {
    trigger: "mention",
    command: "visualize state",
    intent: "visualize",
    visual_lens: "state",
  });
  assert.deepEqual(parseCommand("@clawsweeper visualize"), {
    trigger: "mention",
    command: "visualize",
    intent: "visualize",
    visual_lens: "auto",
  });
  assert.deepEqual(parseCommand("/clawsweeper visualize"), {
    trigger: "slash",
    command: "visualize",
    intent: "visualize",
    visual_lens: "auto",
  });
  assert.deepEqual(parseCommand("@clawsweeper: why did automerge stop here?"), {
    trigger: "mention",
    command: "why did automerge stop here?",
    intent: "freeform_assist",
    freeform_prompt: "why did automerge stop here?",
  });
  assert.deepEqual(parseCommand("@clawsweeper, why did automerge stop here?"), {
    trigger: "mention",
    command: "why did automerge stop here?",
    intent: "freeform_assist",
    freeform_prompt: "why did automerge stop here?",
  });
  assert.deepEqual(parseCommand("@clawsweeper fix this if it is safe"), {
    trigger: "mention",
    command: "fix this if it is safe",
    intent: "freeform_assist",
    freeform_prompt: "fix this if it is safe",
  });
  assert.deepEqual(parseCommand("@clawsweeper\nwhy did automerge stop here?"), {
    trigger: "mention",
    command: "why did automerge stop here?",
    intent: "freeform_assist",
    freeform_prompt: "why did automerge stop here?",
  });
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

test("parseTrustedAutomation accepts only trusted ClawSweeper repair signals", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const comment = {
    user: { login: "clawsweeper[bot]" },
    body: "Codex review:\n<!-- clawsweeper-action: fix-required reviewed_at=2026-07-09T21:00:00.000Z -->\nPlease fix this before merge.",
  };

  const parsed = parseTrustedAutomation(comment, { trustedAuthors });
  assert.equal(parsed.intent, "clawsweeper_auto_repair");
  assert.equal(parsed.trusted_bot, true);
  assert.equal(parsed.trusted_bot_author, "clawsweeper[bot]");
  assert.equal(parsed.reviewed_at, "2026-07-09T21:00:00.000Z");
  assert.match(parsed.repair_reason, /structured ClawSweeper/);

  assert.equal(
    parseTrustedAutomation({ ...comment, user: { login: "random-user" } }, { trustedAuthors }),
    null,
  );
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

test("parseRoutedCommentCommand prefers trusted verdict markers over copyable commands", () => {
  const trustedAuthors = new Set(["clawsweeper"]);
  const parsed = parseRoutedCommentCommand(
    {
      user: { login: "clawsweeper" },
      body: [
        "Codex review: needs changes before merge.",
        "",
        "<details>",
        "<summary>Copy recommended automerge instruction</summary>",
        "",
        "```text",
        "@clawsweeper automerge",
        "",
        "Special instructions:",
        "Only expose structured content to the model.",
        "```",
        "</details>",
        "",
        "<!-- clawsweeper-verdict:needs-changes item=87540 sha=380baaba8f4490cbb64ae36ba8cb0b78912c45f1 confidence=high -->",
        "<!-- clawsweeper-action:fix-required item=87540 sha=380baaba8f4490cbb64ae36ba8cb0b78912c45f1 source_revision=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef confidence=high finding=review-feedback -->",
      ].join("\n"),
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_auto_repair");
  assert.equal(parsed.expected_head_sha, "380baaba8f4490cbb64ae36ba8cb0b78912c45f1");
  assert.equal(
    parsed.expected_source_revision,
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.match(parsed.repair_reason, /fix-required/);
});

test("parseTrustedAutomation accepts trusted ClawSweeper pass verdicts for automerge", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: "ClawSweeper review passed.\n<!-- clawsweeper-verdict:pass sha=abc123 source_revision=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef review_activity_cursor=v1:0:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef reviewed_at=2026-07-09T21:00:00.000Z -->",
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_auto_merge");
  assert.equal(parsed.expected_head_sha, "abc123");
  assert.equal(parsed.reviewed_at, "2026-07-09T21:00:00.000Z");
  assert.equal(
    parsed.expected_source_revision,
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.equal(
    parsed.expected_review_activity_cursor,
    "v1:0:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.match(parsed.repair_reason, /verdict: pass/);
});

test("parseTrustedAutomation accepts trusted ClawSweeper close markers for autoclose", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: [
        "ClawSweeper proposed closing this PR.",
        "<!-- clawsweeper-verdict:close item=96097 sha=abc123 confidence=high reason=duplicate_or_superseded -->",
        "<!-- clawsweeper-action:close-required item=96097 sha=abc123 confidence=high reason=duplicate_or_superseded -->",
      ].join("\n"),
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "autoclose");
  assert.equal(parsed.trusted_bot, true);
  assert.equal(parsed.expected_head_sha, "abc123");
  assert.equal(parsed.close_reason, "duplicate_or_superseded");
  assert.match(parsed.autoclose_message, /close-required/);

  const issueParsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: "<!-- clawsweeper-action:close-required item=321 confidence=high updated_at=2026-01-01T00:00:00Z reviewed_at=2026-07-11T00:00:00Z source_revision=0123456789abcdef action_taken=proposed_close reason=unsponsored_feature_request -->",
    },
    { trustedAuthors },
  );
  assert.equal(issueParsed.intent, "autoclose");
  assert.equal(issueParsed.expected_head_sha, null);
  assert.equal(issueParsed.close_reason, "unsponsored_feature_request");
  assert.equal(issueParsed.expected_source_revision, "0123456789abcdef");
});

test("trusted close markers carry close policy metadata into autoclose commands", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: [
        "ClawSweeper proposed closing this PR.",
        "<!-- clawsweeper-action:close-required item=96097 sha=abc123 confidence=high updated_at=2026-06-25T22:00:00Z reviewed_at=2026-06-25T22:05:00Z source_revision=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef action_taken=proposed_close reason=duplicate_or_superseded -->",
      ].join("\n"),
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "autoclose");
  assert.equal(parsed.close_reason, "duplicate_or_superseded");
  assert.equal(parsed.close_confidence, "high");
  assert.equal(parsed.close_action_taken, "proposed_close");
  assert.equal(parsed.expected_item_updated_at, "2026-06-25T22:00:00Z");
  assert.equal(parsed.reviewed_at, "2026-06-25T22:05:00Z");
  assert.equal(
    parsed.expected_source_revision,
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
});

test("repairLoopPauseLabels identifies pause labels for trusted pass resume", () => {
  assert.deepEqual(
    repairLoopPauseLabels([
      "clawsweeper:automerge",
      "ClawSweeper:Human-Review",
      "clawsweeper:merge-ready",
    ]),
    ["clawsweeper:human-review", "clawsweeper:merge-ready"],
  );
  assert.deepEqual(repairLoopPauseLabels(["clawsweeper:automerge"]), []);
  assert.deepEqual(repairLoopPauseLabels(null), []);
});

test("ready human-review commands block same-run label sweeps", () => {
  assert.equal(
    isReadyHumanReviewPause({
      intent: "clawsweeper_needs_human",
      status: "ready",
      actions: [{ action: "label", label: "clawsweeper:human-review" }],
    }),
    true,
  );
  assert.equal(
    isReadyHumanReviewPause({
      intent: "clawsweeper_needs_human",
      status: "skipped",
      actions: [{ action: "label", label: "clawsweeper:human-review" }],
    }),
    false,
  );
  assert.equal(
    isReadyHumanReviewPause({
      intent: "clawsweeper_auto_merge",
      status: "ready",
      actions: [{ action: "merge" }],
    }),
    false,
  );
});

test("router classifies fresh human-review pauses before label sweeps", () => {
  const source = readFileSync("src/repair/comment-router.ts", "utf8");
  const classifyComments = source.indexOf("const classifiedCommentCommands");
  const repairLoopSweeps = source.indexOf("listRepairLoopSweepCommands(classifiedCommentCommands)");

  assert.ok(classifyComments >= 0);
  assert.ok(repairLoopSweeps > classifyComments);
  assert.match(source, /\.filter\(isReadyHumanReviewPause\)/);
});

test("label sweeps honor fresh trusted exact-head review start leases", () => {
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const comment = {
    user: { login: "clawsweeper[bot]" },
    body: [
      "ClawSweeper status: review started.",
      `<!-- clawsweeper-review-status:started item=103109 sha=${headSha} started_at=2026-07-09T21:01:47.000Z lease_expires_at=2026-07-09T21:31:47.000Z v=1 -->`,
      "<!-- clawsweeper-review-lease item=103109 -->",
    ].join("\n"),
  };
  const options = {
    comments: [comment],
    itemNumber: 103109,
    headSha,
    trustedAuthors: new Set(["clawsweeper[bot]"]),
    nowMs: Date.parse("2026-07-09T21:07:21.000Z"),
  };

  assert.deepEqual(freshExactHeadReviewStartLease(options), {
    startedAt: "2026-07-09T21:01:47.000Z",
    expiresAt: "2026-07-09T21:31:47.000Z",
    owner: null,
    commentId: null,
  });
  assert.equal(
    freshExactHeadReviewStartLease({
      ...options,
      headSha: "fedcba9876543210fedcba9876543210fedcba98",
    }),
    null,
  );
  assert.equal(
    freshExactHeadReviewStartLease({ ...options, nowMs: Date.parse("2026-07-09T21:31:47.001Z") }),
    null,
  );
  assert.equal(
    freshExactHeadReviewStartLease({
      ...options,
      trustedAuthors: new Set(["other-bot[bot]"]),
    }),
    null,
  );
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

  const command = parseRoutedCommentCommand(
    {
      user: { login: "clawsweeper[bot]" },
      body: `<!-- clawsweeper-verdict:pass item=${itemNumber} sha=${headSha} reviewed_at=2026-07-09T21:05:00.000Z -->`,
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
  const comment = {
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-07-09T21:00:00.000Z",
    updated_at: "2026-07-09T21:05:30.000Z",
    body: `<!-- clawsweeper-verdict:pass item=103109 sha=${headSha} reviewed_at=2026-07-09T21:04:30.000Z -->`,
  };

  assert.deepEqual(
    trustedExactHeadReviewCompletionSince({
      comments: [comment],
      headSha,
      trustedAuthors: new Set(["clawsweeper[bot]"]),
      sinceMs: Date.parse("2026-07-09T21:05:00.000Z"),
    }),
    {
      reviewedAt: "2026-07-09T21:04:30.000Z",
      publishedAt: "2026-07-09T21:05:30.000Z",
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
      `<!-- clawsweeper-verdict:pass item=103109 sha=${headSha} -->`,
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

test("label-sweep classification checks the exact-head review lease before dispatch planning", () => {
  const source = readFileSync("src/repair/comment-router.ts", "utf8");
  const activeLease = source.indexOf("freshExactHeadReviewStartLease({");
  const repairPlanning = source.indexOf("const failedChecksRepairReason", activeLease);

  assert.ok(activeLease >= 0);
  assert.ok(repairPlanning > activeLease);
  assert.match(source, /same-head ClawSweeper review is active until/);
  assert.match(
    source,
    /prehydrate_comment_commands[\s\S]*?prehydrateCommandLookups\(rawCommands,\s*\{\s*refreshIssueComments:\s*true\s*\}\)/,
  );
  assert.match(
    source,
    /prehydrate_repair_loop_sweeps[\s\S]*?prehydrateCommandLookups\(sweepCommands,\s*\{\s*refreshIssueComments:\s*true\s*\}\)/,
  );
  const prehydrate = source.slice(
    source.indexOf("async function prehydrateCommandLookups"),
    source.indexOf("function classifyCommand"),
  );
  assert.ok(prehydrate.indexOf("issueCommentsCache.delete(number)") >= 0);
  assert.ok(
    prehydrate.indexOf("issueCommentsCache.delete(number)") <
      prehydrate.indexOf("cachedIssueCommentsAsync(number)"),
  );

  const executeCommand = source.slice(
    source.indexOf("function executeCommand"),
    source.indexOf("function applyRemoveLabelActions"),
  );
  const trustedVerdictCheck = executeCommand.indexOf(
    "trustedAutomationReviewLeaseBlockReason(command)",
  );
  const preMutationCheck = executeCommand.indexOf("repairLoopReviewDispatchBlockReason(command)");
  const firstMutation = executeCommand.indexOf("ensureAutomergeJob(command)", preMutationCheck);
  const dispatchRecheck = executeCommand.indexOf(
    "repairLoopReviewDispatchBlockReason(command)",
    preMutationCheck + 1,
  );
  const dispatch = executeCommand.indexOf("dispatchClawSweeperReview(command)", dispatchRecheck);
  assert.ok(trustedVerdictCheck >= 0);
  assert.ok(trustedVerdictCheck < executeCommand.indexOf("let dispatched"));
  assert.ok(preMutationCheck >= 0);
  assert.ok(firstMutation > preMutationCheck);
  assert.ok(dispatchRecheck > firstMutation);
  assert.ok(dispatch > dispatchRecheck);

  const dispatchGuard = source.slice(
    source.indexOf("function repairLoopReviewDispatchBlockReason"),
    source.indexOf("function trustedAutomationReviewLeaseBlockReason"),
  );
  assert.equal(dispatchGuard.match(/fetchPullRequestView\(number\)/g)?.length, 2);
  assert.match(dispatchGuard, /issues\/\$\{number\}\/comments\?per_page=100/);
  assert.match(dispatchGuard, /nowMs:\s*Date\.now\(\)/);
  assert.match(dispatchGuard, /trustedExactHeadReviewCompletionSince\(\{/);
  assert.match(dispatchGuard, /sinceMs:\s*sweepStartedAtMs/);
  assert.match(dispatchGuard, /next router pass will route it/);
  const sourceRevisionGuard = source.slice(
    source.indexOf("function trustedAutomationSourceRevisionBlockReason"),
    source.indexOf("function trustedAutomationReviewLeaseBlockReason"),
  );
  const issueBefore = sourceRevisionGuard.indexOf("const before = fetchIssue(number)");
  const commentsBetween = sourceRevisionGuard.indexOf(
    "issues/${number}/comments?per_page=100",
    issueBefore,
  );
  const issueAfter = sourceRevisionGuard.indexOf("const after = fetchIssue(number)");
  assert.ok(issueBefore >= 0);
  assert.ok(commentsBetween > issueBefore);
  assert.ok(issueAfter > commentsBetween);
  assert.match(sourceRevisionGuard, /revisionBefore !== revisionAfter/);
  assert.match(sourceRevisionGuard, /revisionAfter !== expectedRevision/);
  assert.match(sourceRevisionGuard, /same-revision ClawSweeper review is active until/);
  const classify = source.slice(
    source.indexOf("function classifyCommand"),
    source.indexOf("function classifyAutoclose"),
  );
  assert.ok(
    classify.indexOf("trustedAutomationSourceRevisionBlockReason") <
      classify.indexOf("if (command.trusted_bot && pull)"),
  );
  const trustedVerdictGuard = source.slice(
    source.indexOf("function trustedAutomationReviewLeaseBlockReason"),
    source.indexOf("function dispatchClawSweeperReview"),
  );
  assert.equal(trustedVerdictGuard.match(/fetchPullRequestView\(number\)/g)?.length, 2);
  assert.ok(
    trustedVerdictGuard.indexOf('command.target?.kind !== "pull_request"') <
      trustedVerdictGuard.indexOf("fetchPullRequestView(number)"),
  );
  assert.match(trustedVerdictGuard, /trustedAutomationPredatesReviewStartLease\(\{/);
});

test("comment router durably claims dispatch commands and recovers exact workflow receipts", () => {
  const source = readFileSync("src/repair/comment-router.ts", "utf8");
  const sweepWorkflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const assistWorkflow = readFileSync(".github/workflows/assist.yml", "utf8");
  const repairWorkflow = readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const executeBlock = source.slice(
    source.indexOf('await measureAsync("execute_commands"'),
    source.indexOf('report.ledger_changed = measure("append_ledger"'),
  );
  const claimIndex = executeBlock.indexOf("claimDispatchCommands(actionable)");
  const ackIndex = executeBlock.indexOf("convergePrecreatedCommandAckComments(command)");
  const executeIndex = executeBlock.indexOf("executeCommandWithReceipt(command)");
  const claimFunction = source.slice(
    source.indexOf("function claimDispatchCommands"),
    source.indexOf("function assertMutationActorIsClawsweeperBot"),
  );

  assert.ok(claimIndex >= 0);
  assert.ok(ackIndex > claimIndex);
  assert.ok(executeIndex > claimIndex);
  assert.match(claimFunction, /status:\s*"claimed"/);
  assert.match(claimFunction, /commandHasAction\(command,\s*"dispatch_clawsweeper"\)/);
  assert.match(claimFunction, /commandHasAction\(command,\s*"dispatch_repair"\)/);
  assert.match(claimFunction, /commandHasAction\(command,\s*"dispatch_assist"\)/);
  assert.match(source, /function claimedDispatchState/);
  assert.match(source, /function refreshDispatchClaim/);
  assert.match(source, /writeLedger\(ledgerPath\(\), ledger\)/);
  assert.match(source, /function verifyDispatchExecutionRuns/);
  assert.match(source, /actions\/runs\/\$\{runId\}\/jobs\?per_page=100/);
  assert.match(source, /Plan and review cluster/);
  assert.match(source, /dispatch_execution_verified/);
  assert.match(source, /dispatchClaimDecision\(\{/);
  assert.match(source, /dispatchClaimLookupKeys\(entry\)/);
  assert.match(claimFunction, /dispatchClaimLookupKeys\(command\)/);
  assert.match(source, /\/runs\?per_page=100&page=\$\{page\}/);
  assert.match(source, /status:\s*"recovered"/);
  assert.match(source, /`item_numbers=\$\{dispatchKey\}`/);
  assert.match(source, /event:\s*"workflow_dispatch"/);
  assert.match(source, /workflow_dispatch=\$\{fallback\.stderr \|\| fallback\.stdout\}/);
  assert.match(sweepWorkflow, /Review event item \{0\}#\{1\} \[\{2\}\]/);
  assert.match(sweepWorkflow, /startsWith\(github\.event\.inputs\.item_numbers, 'router-'\)/);
  assert.match(
    sweepWorkflow,
    /ITEM_NUMBERS:.*startsWith\(github\.event\.inputs\.item_numbers, 'router-'\)/,
  );
  assert.match(assistWorkflow, /Assist \{0\}#\{1\} \[\{2\}\]/);
  assert.match(sweepWorkflow, /delivery_id: dispatchKey/);
  assert.match(sweepWorkflow, /`router:\$\{dispatchKey\}`/);
  assert.match(assistWorkflow, /dispatch-receipt-owner\.sh/);
  assert.match(assistWorkflow, /assist\.yml.*assist/s);
  assert.match(repairWorkflow, /dispatch-receipt-owner\.sh/);
  assert.match(repairWorkflow, /repair-cluster-worker\.yml.*Plan and review cluster/s);
  assert.match(repairWorkflow, /dispatch_key:/);
});

test("exact comment fast path converges terminal acknowledgement before own reaction cleanup", () => {
  const source = readFileSync("src/repair/comment-router.ts", "utf8");
  const retryConstant = source.indexOf("const TARGET_LOOKUP_RETRY_ATTEMPTS = 3");
  const preflightBlock = source.slice(
    source.indexOf("const exactCommentVersionFastPathCommand"),
    source.indexOf("const priorDispatchClaims"),
  );
  const cleanupBlock = source.slice(
    source.indexOf('measure("verify_exact_comment_version_cleanup"'),
    source.indexOf("if (execute && !exactCommentVersionFastPath.suppress)"),
  );

  assert.match(
    preflightBlock,
    /!exactCommentVersionStillCurrent\(exactCommentVersionFastPathCommand\)/,
  );
  assert.ok(retryConstant < source.indexOf("const exactCommentVersionFastPathCommand"));
  assert.match(preflightBlock, /reason: "source_drift"/);
  assert.ok(
    source.indexOf("!exactCommentVersionStillCurrent(exactCommentVersionFastPathCommand)") <
      source.indexOf('measure("list_candidate_comments"'),
  );
  assert.match(
    cleanupBlock,
    /exactCommentVersionStillCurrent\(exactCommentVersionFastPathCommand\)/,
  );
  assert.match(cleanupBlock, /convergeExactCommentVersionFastPathAck\(/);
  assert.match(cleanupBlock, /statusCommentId/);
  assert.match(cleanupBlock, /clear_exact_comment_version_reaction/);
  assert.match(
    cleanupBlock,
    /removeOwnCommentReaction\(exactCommentVersionFastPathCommand,\s*"eyes"\)/,
  );
  assert.match(cleanupBlock, /skipped_source_drift/);
  assert.match(cleanupBlock, /reason: "cleanup_source_drift"/);
  assert.match(cleanupBlock, /exactCommentVersionAckFailed\(ackConvergence\)/);
  assert.match(cleanupBlock, /if \(versionStillCurrent\) assertMutationActorIsClawsweeperBot\(\)/);
  assert.match(cleanupBlock, /throw new Error/);
  assert.ok(
    cleanupBlock.indexOf("exactCommentVersionAckFailed(ackConvergence)") <
      cleanupBlock.indexOf('measure("clear_exact_comment_version_reaction"'),
  );
  assert.match(cleanupBlock, /list_candidate_comments_after_cleanup_drift/);
  assert.match(cleanupBlock, /prehydrate_cleanup_drift_commands/);
  assert.match(cleanupBlock, /classify_cleanup_drift_commands/);
  assert.match(cleanupBlock, /commands\.push/);
  assert.match(cleanupBlock, /report\.short_circuited = false/);
  assert.doesNotMatch(
    cleanupBlock,
    /cleanupTerminalCommentAck\(exactCommentVersionFastPathCommand\)/,
  );
  assert.doesNotMatch(
    cleanupBlock,
    /clearTerminalMaintainerCommandReaction\(exactCommentVersionFastPathCommand\)/,
  );
  assert.doesNotMatch(source, /function cleanupTerminalCommentAck/);
  const ackConvergence = source.slice(
    source.indexOf("function convergeExactCommentVersionFastPathAck"),
    source.indexOf("function convergePrecreatedCommandAckCommentsInner"),
  );
  assert.match(ackConvergence, /isTrustedStatusComment\(comment\)/);
  assert.match(ackConvergence, /issueNumberFromUrl\(comment\.issue_url\)/);
  assert.match(ackConvergence, /commandAckMarkerFromBody\(comment\.body\)/);
  assert.match(ackConvergence, /commandStatusMarkerFromBody\(comment\.body\)/);
  assert.match(ackConvergence, /exactCommentVersionTerminalResponse\(command, id\)/);
  assert.match(ackConvergence, /hasCommandResponseMarker\(comment\.body/);
  assert.match(ackConvergence, /exactCommentVersionMissingTerminalBody\(command\)/);
  assert.match(ackConvergence, /commandResponseMarker\(\{/);
  assert.match(ackConvergence, /"--method",\s*"PATCH"/);
  assert.match(ackConvergence, /githubNotFoundNoMutation/);
  assert.doesNotMatch(ackConvergence, /renderResponse\(/);
  assert.doesNotMatch(ackConvergence, /"DELETE"/);
  assert.doesNotMatch(ackConvergence, /clearTerminalMaintainerCommandReaction/);
  const reactionCleanup = source.slice(
    source.indexOf("function removeOwnCommentReaction"),
    source.indexOf("function ensureAutomergeLabel"),
  );
  assert.match(reactionCleanup, /isOwnCommentReaction\(reaction, content\)/);
  assert.match(reactionCleanup, /reactions\/\$\{reaction\.id\}/);
  assert.match(reactionCleanup, /"--method",\s*"DELETE"/);
  assert.match(reactionCleanup, /isAllowedMutationActor\(login, DEFAULT_TRUSTED_BOTS\)/);
  assert.doesNotMatch(reactionCleanup, /isAllowedMutationActor\(login, trustedBots\)/);
});

test("command receipt gates let the oldest same-key run proceed when a newer duplicate is pending", () => {
  const receiptGate = readFileSync("scripts/dispatch-receipt-owner.sh", "utf8");

  assert.match(receiptGate, /\.display_title == \$title and \.id < \(\$current \| tonumber\)/);
  assert.match(receiptGate, /\.status == "in_progress"/);
  assert.match(receiptGate, /\.conclusion == "success"/);
  assert.match(receiptGate, /actions\/runs\/\$\{run_id\}\/jobs\?per_page=100/);
  assert.match(receiptGate, /\.name == \$required and \.conclusion == "success"/);
  assert.doesNotMatch(receiptGate, /\(\.id \| tostring\) != \$current/);
});

test("trusted autoclose markers are live close gated before close execution", () => {
  const source = readFileSync("src/repair/comment-router.ts", "utf8");
  const autocloseClassifier = source.slice(
    source.indexOf("function classifyAutoclose"),
    source.indexOf("function executeAutoclose"),
  );
  const autocloseExecutor = source.slice(
    source.indexOf("function executeAutoclose"),
    source.indexOf("function discoverAutocloseTargets"),
  );
  const coreSource = readFileSync("src/repair/comment-router-core.ts", "utf8");
  const trustedCloseGate = coreSource.slice(
    coreSource.indexOf("export function trustedCloseBlockReason"),
    coreSource.indexOf("type AutoRepairDispatchEntry"),
  );

  assert.match(autocloseClassifier, /command\.trusted_bot && pull/);
  assert.match(autocloseClassifier, /trustedCloseBlockReason\(\{/);
  assert.match(autocloseClassifier, /createdAt:\s*issue\.created_at/);
  assert.match(autocloseClassifier, /fetchPullRequestApi\(command\.issue_number\)/);
  assert.match(autocloseClassifier, /requestedReviewers:\s*pullApi\.requested_reviewers/);
  assert.match(autocloseExecutor, /liveTrustedCloseBlockReason\(command,\s*liveTarget\)/);
  assert.match(trustedCloseGate, /reviewedHeadShaBlockReason\(\{/);
  assert.match(trustedCloseGate, /markerName:\s*"close"/);
  assert.match(autocloseClassifier, /status:\s*"skipped"/);
  assert.match(autocloseClassifier, /unsponsoredFeatureLinkedPrBlockReason/);
  assert.match(source, /"closedByPullRequestsReferences"/);
  assert.ok((source.match(/unsponsoredFeatureLinkedPrBlockReason\(/g) ?? []).length >= 3);
});

test("trusted close gates block protected labels, source drift, and unsupported reasons", () => {
  const base = {
    repo: "openclaw/openclaw",
    kind: "pull_request",
    labels: [],
    closeReason: "duplicate_or_superseded",
    closeConfidence: "high",
    closeActionTaken: "proposed_close",
    expectedHeadSha: "abc123",
    currentHeadSha: "abc123",
    expectedItemUpdatedAt: "2026-06-25T22:00:00Z",
    currentItemUpdatedAt: "2026-06-25T22:00:00Z",
    authorAssociation: "CONTRIBUTOR",
    reviewedAt: "2026-06-25T22:05:00Z",
    expectedSourceRevision: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    currentSourceRevision: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    trustedAuthors: new Set(["clawsweeper[bot]"]),
  };

  assert.equal(trustedCloseBlockReason(base), null);
  const reviewedIssue = {
    title: "Close duplicate PR",
    body: "Superseded by the canonical fix.",
    labels: [{ name: "bug" }],
  };
  const reviewedRevision = issueSourceRevisionSha256(reviewedIssue, []);
  const advisoryLabelRevision = issueSourceRevisionSha256(
    {
      ...reviewedIssue,
      labels: [
        ...reviewedIssue.labels,
        { name: "status: ⏳ waiting on author" },
        { name: "rating: 🧂 unranked krab" },
        { name: "proof: sufficient" },
        { name: "merge-risk: 🚨 automation" },
        { name: "P1" },
      ],
    },
    [],
  );
  const userLabelRevision = issueSourceRevisionSha256(
    { ...reviewedIssue, labels: [...reviewedIssue.labels, { name: "needs-design" }] },
    [],
  );
  assert.equal(advisoryLabelRevision, reviewedRevision);
  assert.notEqual(userLabelRevision, reviewedRevision);
  assert.equal(
    trustedCloseBlockReason({
      ...base,
      expectedSourceRevision: reviewedRevision,
      currentSourceRevision: advisoryLabelRevision,
      currentItemUpdatedAt: "2026-06-25T22:07:00Z",
      sourceCommentId: "123",
      comments: [
        {
          id: "123",
          user: { login: "clawsweeper[bot]" },
          created_at: "2026-06-25T22:05:00Z",
          updated_at: "2026-06-25T22:07:00Z",
        },
      ],
    }),
    null,
  );
  assert.match(
    trustedCloseBlockReason({
      ...base,
      expectedSourceRevision: reviewedRevision,
      currentSourceRevision: userLabelRevision,
      currentItemUpdatedAt: "2026-06-25T22:07:00Z",
      sourceCommentId: "123",
      comments: [
        {
          id: "123",
          user: { login: "clawsweeper[bot]" },
          created_at: "2026-06-25T22:05:00Z",
          updated_at: "2026-06-25T22:07:00Z",
        },
      ],
    }),
    /source issue\/PR changed since trusted close review/,
  );
  assert.equal(
    trustedCloseBlockReason({ ...base, labels: ["release-blocker"] }),
    "protected label: release-blocker",
  );
  assert.match(
    trustedCloseBlockReason({
      ...base,
      comments: [
        {
          user: { login: "maintainer" },
          created_at: "2026-06-25T22:06:00Z",
          updated_at: "2026-06-25T22:06:00Z",
        },
      ],
    }),
    /non-automation activity after trusted close review by maintainer/,
  );
  assert.match(
    trustedCloseBlockReason({ ...base, closeReason: "stale_insufficient_info" }),
    /stale_insufficient_info is not allowed for openclaw\/openclaw pull_request apply policy/,
  );
  const originalProductDirectionPolicy =
    process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
  delete process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
  const productDirectionBase = {
    ...base,
    closeReason: "unconfirmed_product_direction",
    createdAt: "2026-05-01T00:00:00Z",
    expectedItemUpdatedAt: "2026-06-01T00:00:00Z",
    currentItemUpdatedAt: "2026-06-01T00:00:00Z",
    reviewedAt: "2026-06-10T00:00:00Z",
    now: Date.parse("2026-06-25T00:00:00Z"),
  };
  try {
    assert.match(
      trustedCloseBlockReason(productDirectionBase),
      /unconfirmed product-direction apply policy is disabled/,
    );
    process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED = "true";
    assert.equal(trustedCloseBlockReason(productDirectionBase), null);
    assert.match(
      trustedCloseBlockReason({
        ...productDirectionBase,
        createdAt: "2026-06-20T00:00:00Z",
      }),
      /requires PR older than 14 days/,
    );
    assert.match(
      trustedCloseBlockReason({
        ...productDirectionBase,
        expectedItemUpdatedAt: "2026-06-08T00:00:00Z",
      }),
      /requires 7 days without source activity/,
    );
    assert.match(
      trustedCloseBlockReason({
        ...productDirectionBase,
        labels: ["clawsweeper:human-review"],
      }),
      /clawsweeper:human-review exempts this PR from product-direction auto-close/,
    );
    assert.match(
      trustedCloseBlockReason({ ...productDirectionBase, assignees: [{ login: "maintainer" }] }),
      /assigned PR has active human signal/,
    );
    assert.match(
      trustedCloseBlockReason({
        ...productDirectionBase,
        requestedReviewers: [{ login: "reviewer" }],
      }),
      /requested reviewers or teams indicate active review signal/,
    );
    assert.match(
      trustedCloseBlockReason({
        ...productDirectionBase,
        comments: [{ author_association: "MEMBER" }],
      }),
      /maintainer issue comment calibrates product direction/,
    );
    assert.match(
      trustedCloseBlockReason({
        ...productDirectionBase,
        reviews: [{ author_association: "OWNER" }],
      }),
      /maintainer PR review calibrates product direction/,
    );
    assert.match(
      trustedCloseBlockReason({
        ...productDirectionBase,
        reviewComments: [{ author_association: "COLLABORATOR" }],
      }),
      /maintainer inline review comment calibrates product direction/,
    );
  } finally {
    if (originalProductDirectionPolicy === undefined) {
      delete process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
    } else {
      process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED =
        originalProductDirectionPolicy;
    }
  }
  const originalUnsponsoredPolicy = process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED;
  delete process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED;
  const unsponsoredBase = {
    ...base,
    kind: "issue",
    closeReason: "unsponsored_feature_request",
    createdAt: "2026-01-01T00:00:00Z",
    comments: [],
    assignees: [],
    milestone: null,
    reactions: { total_count: 0 },
    now: Date.parse("2026-07-11T00:00:00Z"),
  };
  try {
    assert.match(
      trustedCloseBlockReason(unsponsoredBase),
      /unsponsored feature-request apply policy is disabled/,
    );
    process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED = "true";
    assert.equal(trustedCloseBlockReason(unsponsoredBase), null);
    assert.match(
      trustedCloseBlockReason({
        ...unsponsoredBase,
        comments: [
          {
            author_association: "NONE",
            created_at: "2026-07-01T00:00:00Z",
            user: { type: "User" },
          },
        ],
      }),
      /non-bot comment within the last 60 days/,
    );
  } finally {
    if (originalUnsponsoredPolicy === undefined) {
      delete process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED;
    } else {
      process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED = originalUnsponsoredPolicy;
    }
  }
  assert.match(
    trustedCloseBlockReason({ ...base, closeReason: "low_signal_unmergeable_pr" }),
    /require apply-decisions live conflict and author-activity proof/,
  );
  assert.match(
    trustedCloseBlockReason({
      ...base,
      closeReason: "low_signal_unmergeable_pr",
      assignees: [{ login: "maintainer" }],
    }),
    /assigned PR has maintainer\/human signal/,
  );
  assert.match(
    trustedCloseBlockReason({
      ...base,
      closeReason: "low_signal_unmergeable_pr",
      requestedTeams: [{ slug: "maintainers" }],
    }),
    /requested reviewers or teams indicate active review signal/,
  );
  assert.match(
    trustedCloseBlockReason({
      ...base,
      closeReason: "low_signal_unmergeable_pr",
      comments: [{ author_association: "MEMBER" }],
    }),
    /maintainer issue comment blocks low-signal auto-close/,
  );
  assert.match(
    trustedCloseBlockReason({
      ...base,
      closeReason: "low_signal_unmergeable_pr",
      reviews: [{ author_association: "OWNER" }],
    }),
    /maintainer PR review blocks low-signal auto-close/,
  );
  assert.match(
    trustedCloseBlockReason({ ...base, closeConfidence: "medium" }),
    /confidence must be high/,
  );
  assert.match(
    trustedCloseBlockReason({ ...base, closeActionTaken: "kept_open" }),
    /action_taken must be proposed_close/,
  );
  assert.equal(
    trustedCloseBlockReason({
      ...base,
      currentItemUpdatedAt: "2026-06-25T22:07:00Z",
      sourceCommentId: "123",
      comments: [
        {
          id: "123",
          user: { login: "clawsweeper[bot]" },
          created_at: "2026-06-25T22:05:00Z",
          updated_at: "2026-06-25T22:07:00Z",
        },
      ],
    }),
    null,
  );
  assert.match(
    trustedCloseBlockReason({
      ...base,
      currentItemUpdatedAt: "2026-06-25T22:07:00Z",
      currentSourceRevision: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      sourceCommentId: "123",
      comments: [
        {
          id: "123",
          user: { login: "clawsweeper[bot]" },
          created_at: "2026-06-25T22:05:00Z",
          updated_at: "2026-06-25T22:07:00Z",
        },
      ],
    }),
    /source issue\/PR changed since trusted close review/,
  );
  assert.match(
    trustedCloseBlockReason({
      ...base,
      currentItemUpdatedAt: "2026-06-25T22:08:00Z",
      sourceCommentId: "123",
      comments: [
        {
          id: "123",
          user: { login: "clawsweeper[bot]" },
          created_at: "2026-06-25T22:05:00Z",
          updated_at: "2026-06-25T22:07:00Z",
        },
      ],
    }),
    /live issue\/PR updated_at changed since trusted close review/,
  );
});

test("parseTrustedAutomation repairs trusted pass verdicts that still contain P findings", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: [
        "ClawSweeper review passed.",
        "",
        "**Review findings**",
        "- **[P2] Preserve queued delivery:** `src/queue.ts:42`",
        "<!-- clawsweeper-verdict:pass sha=abc123 -->",
      ].join("\n"),
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_auto_repair");
  assert.equal(parsed.expected_head_sha, "abc123");
  assert.match(parsed.repair_reason, /P-severity findings/);
});

test("parseTrustedAutomation does not treat pass verdict risk notes as repair findings", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: [
        "Codex review: passed.",
        "",
        "**Risk before merge**",
        "- [P1] Maintainers should accept the shared directory cleanup boundary.",
        "- [P1] A bad predicate could remove a live bridge record.",
        "",
        "**Next step before merge**",
        "- [P2] No repair lane is needed; the remaining action is landing risk acceptance.",
        "",
        "<!-- clawsweeper-verdict:pass item=87563 sha=613071ef179bd015ec9071d5dde2edc1ad3d9424 confidence=high -->",
      ].join("\n"),
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_auto_merge");
  assert.equal(parsed.expected_head_sha, "613071ef179bd015ec9071d5dde2edc1ad3d9424");
  assert.match(parsed.repair_reason, /verdict: pass/);
});

test("parseTrustedAutomation treats trusted ClawSweeper needs-human as a pause", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: "ClawSweeper needs maintainer judgment.\n<!-- clawsweeper-verdict:needs-human sha=abc123 source_revision=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef reviewed_at=2026-07-09T21:00:00.000Z -->",
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_needs_human");
  assert.equal(
    parsed.expected_source_revision,
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.equal(parsed.expected_head_sha, "abc123");
  assert.equal(parsed.reviewed_at, "2026-07-09T21:00:00.000Z");
  assert.match(parsed.repair_reason, /needs-human/);
});

test("canonical landing needs-human text can be approved by active automerge opt-in", () => {
  assert.equal(
    isCanonicalLandingNeedsHumanText(
      "No repair lane is needed because the PR already contains the narrow fix; maintainer action is to land one canonical fix.",
    ),
    true,
  );
  assert.equal(
    isCanonicalLandingNeedsHumanText(
      "The PR is an active automerge candidate with no code finding, but the protected label and missing real behavior proof require maintainer handling.",
    ),
    true,
  );
  assert.equal(
    isCanonicalLandingNeedsHumanText(
      "No repair lane is needed, but Security needs attention before merge.",
    ),
    false,
  );
  assert.equal(
    isCanonicalLandingNeedsHumanText(
      "Maintainer action is to land the canonical fix.\n- [P1] Still broken",
    ),
    false,
  );
  assert.equal(
    maintainerAutomergeOptInApprovesNeedsHuman({
      reason:
        "The PR is an active automerge candidate with no code finding, but missing proof needs maintainer handling.",
      commentCreatedAt: "2026-05-17T00:45:00Z",
      commentUpdatedAt: "2026-05-17T00:55:00Z",
      optInTime: "2026-05-17T00:50:00Z",
    }),
    true,
  );
  assert.equal(
    maintainerAutomergeOptInApprovesNeedsHuman({
      reason:
        "The PR is an active automerge candidate with no code finding, but missing proof needs maintainer handling.",
      commentCreatedAt: "2026-05-17T00:55:00Z",
      optInTime: "2026-05-17T00:50:00Z",
    }),
    true,
  );
  assert.equal(
    maintainerAutomergeOptInApprovesNeedsHuman({
      reason:
        "The PR is an active automerge candidate with no code finding, but missing proof needs maintainer handling.",
      commentCreatedAt: "2026-05-17T00:55:00Z",
      optInTime: 0,
    }),
    false,
  );
});

test("canonical landing needs-human accepts waiting automerge opt-in as active resume intent", () => {
  const optInTime = latestRepairLoopResumeTime(
    [
      {
        repo: "openclaw/openclaw",
        issue_number: 83186,
        intent: "automerge",
        status: "waiting",
        comment_updated_at: "2026-05-17T17:09:01Z",
      },
      {
        repo: "openclaw/openclaw",
        issue_number: 83186,
        intent: "automerge",
        status: "blocked",
        comment_updated_at: "2026-05-17T17:10:01Z",
      },
      {
        repo: "openclaw/openclaw",
        issue_number: 83186,
        intent: "status",
        status: "executed",
        comment_updated_at: "2026-05-17T17:11:01Z",
      },
    ],
    {
      repo: "openclaw/openclaw",
      issue_number: 83186,
    },
  );

  assert.equal(optInTime, Date.parse("2026-05-17T17:09:01Z"));
  assert.equal(
    maintainerAutomergeOptInApprovesNeedsHuman({
      reason:
        "No repair lane is needed; the open PR already contains the focused implementation and this review found no actionable blocker for automation to fix.",
      commentCreatedAt: "2026-05-17T16:54:05Z",
      optInTime,
    }),
    true,
  );
});

test("canonical landing needs-human accepts replacement PR automerge requester marker", () => {
  const replacementBody = [
    "Makes https://github.com/openclaw/openclaw/pull/83186 merge-ready for the ClawSweeper automerge loop.",
    "",
    "ClawSweeper replacement notes:",
    "- Automerge requested by: @Takhoffman",
    '<!-- clawsweeper-automerge-requested-by login="Takhoffman" id="781889" -->',
  ].join("\n");

  assert.deepEqual(automergeRequestedByFromBody(replacementBody), {
    author: "Takhoffman",
    author_id: "781889",
    author_name: null,
  });
  assert.equal(
    maintainerAutomergeOptInApprovesNeedsHuman({
      reason:
        "No repair lane is needed; this automerge-opted replacement PR should proceed through exact-head checks and normal merge gates.",
      commentCreatedAt: "2026-05-17T18:03:35Z",
      optInTime: 0,
      replacementAutomergeRequestedBy: automergeRequestedByFromBody(replacementBody),
    }),
    true,
  );
});

test("canonical landing needs-human ignores bot replacement PR automerge requester markers", () => {
  assert.equal(
    maintainerAutomergeOptInApprovesNeedsHuman({
      reason:
        "No repair lane is needed; this automerge-opted replacement PR should proceed through exact-head checks and normal merge gates.",
      commentCreatedAt: "2026-05-17T18:03:35Z",
      optInTime: 0,
      replacementAutomergeRequestedBy: {
        author: "clawsweeper[bot]",
        author_id: "274271284",
      },
    }),
    false,
  );
});

test("parseTrustedAutomation explains security-sensitive human-review pauses", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: [
        "Codex review: found issues before merge.",
        "",
        "**Next step before merge**",
        "Automerge should pause for maintainer/security handling of the remaining sudo -k carrier bypass.",
        "",
        "**Security**",
        "Needs attention: Needs attention: the PR still leaves a sudo reset-timestamp carrier form unwrapped.",
        "",
        "**Review findings**",
        "- [P1] Treat sudo -k as a command-carrying option — `src/infra/command-carriers.ts:74-83`",
        "",
        "<!-- clawsweeper-security:security-sensitive item=76672 sha=abc123 confidence=high -->",
        "<!-- clawsweeper-verdict:needs-human item=76672 sha=abc123 confidence=high -->",
      ].join("\n"),
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_needs_human");
  assert.equal(parsed.expected_head_sha, "abc123");
  assert.match(parsed.repair_reason, /sudo -k carrier bypass/);
  assert.match(parsed.repair_reason, /sudo reset-timestamp carrier form/);
  assert.match(parsed.repair_reason, /\[P1\] Treat sudo -k/);
  assert.match(parsed.repair_reason, /sha=abc123/);
});

test("parseTrustedAutomation repairs needs-human verdicts with concrete P findings", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: [
        "ClawSweeper says this needs maintainer judgment.",
        "",
        "**Review findings**",
        "- **[P1] Unwrap sudo reset-timestamp carriers:** `src/infra/command-carriers.ts:74`",
        "<!-- clawsweeper-verdict:needs-human sha=abc123 -->",
      ].join("\n"),
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_auto_repair");
  assert.equal(parsed.expected_head_sha, "abc123");
  assert.match(parsed.repair_reason, /repairable P-severity findings/);
});

test("parseTrustedAutomation accepts explicit repair verdicts", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: "ClawSweeper requests another repair pass.\n<!-- clawsweeper-verdict:needs-repair sha=abc123 -->",
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_auto_repair");
  assert.equal(parsed.expected_head_sha, "abc123");
  assert.match(parsed.repair_reason, /needs-repair/);
});

test("parseTrustedAutomation preserves explicit human-review verdicts as pauses", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: "ClawSweeper needs explicit human review.\n<!-- clawsweeper-verdict:human-review sha=abc123 -->",
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_needs_human");
  assert.equal(parsed.expected_head_sha, "abc123");
});

test("reviewedHeadShaBlockReason rejects stale trusted verdict heads", () => {
  assert.equal(
    reviewedHeadShaBlockReason({
      expectedHeadSha: "abc123",
      currentHeadSha: "abc123",
      markerName: "human-review",
    }),
    null,
  );
  assert.equal(
    reviewedHeadShaBlockReason({
      expectedHeadSha: null,
      currentHeadSha: "def456",
      markerName: "human-review",
    }),
    "ClawSweeper human-review marker must include the reviewed PR head SHA",
  );
  assert.equal(
    reviewedHeadShaBlockReason({
      expectedHeadSha: "abc123",
      currentHeadSha: "def456",
      markerName: "human-review",
    }),
    "ClawSweeper human-review marker targets a stale PR head SHA",
  );
});

test("auto repair cap allows ten PR repair rounds and blocks the eleventh", () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    repo: "openclaw/openclaw",
    issue_number: 74453,
    intent: "clawsweeper_auto_repair",
    status: "executed",
    target: { head_sha: `sha-${index}` },
    comment_updated_at: `2026-04-29T10:0${index}:00Z`,
  }));

  assert.equal(
    autoRepairBlockReason({
      entries: entries.slice(0, 9),
      repo: "openclaw/openclaw",
      issueNumber: 74453,
      headSha: "sha-10",
      maxRepairsPerPr: 10,
      maxRepairsPerHead: 1,
    }),
    null,
  );
  assert.equal(
    autoRepairBlockReason({
      entries,
      repo: "openclaw/openclaw",
      issueNumber: 74453,
      headSha: "sha-10",
      maxRepairsPerPr: 10,
      maxRepairsPerHead: 1,
    }),
    "ClawSweeper auto repair already dispatched 10 total time(s) for this PR",
  );
});

test("auto repair cap blocks duplicate head dispatches in the same review round", () => {
  const entries = [
    {
      repo: "openclaw/openclaw",
      issue_number: 74453,
      intent: "clawsweeper_auto_repair",
      status: "executed",
      target: { head_sha: "same-head" },
      comment_updated_at: "2026-04-29T10:00:00Z",
    },
  ];

  assert.equal(
    autoRepairHeadKey({
      repo: "openclaw/openclaw",
      issueNumber: 74453,
      headSha: "same-head",
    }),
    "openclaw/openclaw#74453:same-head",
  );
  assert.equal(
    autoRepairBlockReason({
      entries,
      repo: "openclaw/openclaw",
      issueNumber: 74453,
      headSha: "same-head",
      maxRepairsPerPr: 5,
      maxRepairsPerHead: 1,
    }),
    "ClawSweeper auto repair already dispatched 1 time(s) for this PR head",
  );
  assert.equal(
    autoRepairBlockReason({
      entries: [],
      plannedHeads: new Set(["openclaw/openclaw#74453:same-head"]),
      repo: "openclaw/openclaw",
      issueNumber: 74453,
      headSha: "same-head",
      maxRepairsPerPr: 5,
      maxRepairsPerHead: 1,
    }),
    "ClawSweeper auto repair already planned for this PR head in this scan",
  );
});

test("auto repair cap counts pass-marker CI repair dispatches", () => {
  const entries = [
    {
      repo: "openclaw/openclaw",
      issue_number: 74506,
      intent: "clawsweeper_auto_merge",
      status: "executed",
      target: { head_sha: "same-head" },
      actions: [{ action: "dispatch_repair", status: "executed" }],
      comment_updated_at: "2026-04-30T01:12:00Z",
    },
  ];

  assert.equal(
    autoRepairBlockReason({
      entries,
      repo: "openclaw/openclaw",
      issueNumber: 74506,
      headSha: "same-head",
      maxRepairsPerPr: 10,
      maxRepairsPerHead: 1,
    }),
    "ClawSweeper auto repair already dispatched 1 time(s) for this PR head",
  );
});

test("auto repair cap resets after a fresh maintainer automerge command", () => {
  const entries = [
    {
      repo: "openclaw/openclaw",
      issue_number: 74453,
      intent: "clawsweeper_auto_repair",
      status: "executed",
      target: { head_sha: "old-head" },
      comment_updated_at: "2026-04-29T09:00:00Z",
    },
  ];

  assert.equal(
    autoRepairBlockReason({
      entries,
      repo: "openclaw/openclaw",
      issueNumber: 74453,
      headSha: "old-head",
      maxRepairsPerPr: 5,
      maxRepairsPerHead: 1,
      resumeBoundary: Date.parse("2026-04-29T10:00:00Z"),
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

test("renderResponse keeps public command replies friendly and scoped", () => {
  const command = {
    comment_id: "123",
    intent: "help",
    target: { head_sha: "abc123" },
  };

  const body = renderResponse(command, null);
  assert.match(body, /ClawSweeper is here and listening/);
  assert.match(body, /only act for maintainers/);
  assert.doesNotMatch(body, /ClawSweeper Repair/i);
});

test("renderResponse reports trusted repair dispatches without losing guardrails", () => {
  const body = renderResponse(
    {
      comment_id: "456",
      comment_version_key: "456:2026-04-29T07:12:31Z",
      intent: "clawsweeper_auto_repair",
      trusted_bot_author: "clawsweeper[bot]",
      repair_reason: "structured ClawSweeper marker: fix-required",
      target: { head_sha: "def456" },
    },
    {
      workflow: "repair-cluster-worker.yml",
      job_path: "jobs/openclaw/inbox/example.md",
      mode: "autonomous",
      model: "gpt-5.6-sol",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/123456789",
    },
  );

  assert.match(body, /ClawSweeper picked up the repair feedback/);
  assert.doesNotMatch(body, /Thanks, ClawSweeper/);
  assert.match(body, /clawsweeper-command:456:2026-04-29T07:12:31Z:clawsweeper_auto_repair:def456/);
  assert.match(
    body,
    /Action: repair worker queued\. Run: https:\/\/github\.com\/openclaw\/clawsweeper\/actions\/runs\/123456789/,
  );
  assert.doesNotMatch(body, /repair-cluster-worker\.yml/);
  assert.doesNotMatch(body, /jobs\/openclaw\/inbox\/example\.md/);
  assert.match(body, /safe credited replacement/);
  assert.match(body, /narrow fix/);
  assert.doesNotMatch(body, /ClawSweeper Repair/i);
});

test("renderResponse gives command replies stateful lobster badges", () => {
  const body = renderResponse({ comment_id: "456", intent: "help", target: {} }, null);
  const reviewBody = renderResponse(
    { comment_id: "457", intent: "re_review", target: {} },
    { clawsweeper: { workflow: "sweep.yml" } },
  );
  const repairBody = renderResponse(
    { comment_id: "458", intent: "implement_issue", target: {} },
    { model: "gpt-5.6-sol" },
  );
  const doneBody = renderResponse(
    {
      comment_id: "459",
      intent: "clawsweeper_auto_merge",
      target: {},
      trusted_bot_author: "clawsweeper[bot]",
    },
    { merge: { status: "executed" } },
  );

  assert.match(
    body,
    /^<!-- clawsweeper-command-status:unknown:help:na -->\n<!-- clawsweeper-command:456:help:na -->\n🦞👀\nClawSweeper is here/,
  );
  assert.match(reviewBody, /\n🦞🧹\nClawSweeper re-review requested/);
  assert.match(repairBody, /\n🦞🔧\nClawSweeper issue implementation requested/);
  assert.match(doneBody, /\n🦞✅\nClawSweeper merged this PR/);
  assert.match(body, /@clawsweeper fix/);
  assert.match(body, /\/clawsweeper visualize \[lens\]/);
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

test("renderResponse avoids self-linking current item numbers in status replies", () => {
  const prBody = renderResponse(
    {
      comment_id: "74578",
      intent: "status",
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
      intent: "status",
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

test("renderResponse reports automerge resume actions", () => {
  const body = renderResponse(
    {
      comment_id: "459",
      intent: "automerge",
      repo: "openclaw/openclaw",
      target: { head_sha: "def459" },
      actions: [{ action: "remove_label", label: "clawsweeper:human-review", status: "executed" }],
    },
    {
      clawsweeper: {
        workflow: "sweep.yml",
        event: "repository_dispatch",
      },
    },
  );

  assert.match(body, /pause labels cleared/);
  assert.match(body, /Head: `def459`/);
  assert.match(body, /repair\/rebase/);
});

test("renderResponse reports automerge repair dispatches as enabled", () => {
  const body = renderResponse(
    {
      comment_id: "460",
      intent: "automerge",
      repo: "openclaw/openclaw",
      target: { head_sha: "def460" },
      actions: [
        { action: "label", label: "clawsweeper:automerge", status: "executed" },
        { action: "dispatch_repair", status: "executed" },
      ],
    },
    {
      repair: {
        workflow: "repair cluster worker",
        job_path: "jobs/openclaw/inbox/automerge-openclaw-openclaw-75401.md",
        mode: "autonomous",
        model: "gpt-5.6-sol",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/25242426838",
      },
    },
  );

  assert.match(body, /ClawSweeper automerge is enabled/);
  assert.match(body, /- Action: repair worker queued/);
  assert.doesNotMatch(body, /could not enable automerge/);
  assert.doesNotMatch(body, /requires a pull request/);
  assert.doesNotMatch(body, /automerge-openclaw-openclaw-75401/);
});

test("renderResponse reports autofix repair-only opt-in", () => {
  const body = renderResponse(
    {
      comment_id: "459",
      intent: "autofix",
      target: { head_sha: "def459" },
      actions: [{ action: "remove_label", label: "clawsweeper:merge-ready", status: "executed" }],
    },
    {
      clawsweeper: {
        workflow: "sweep.yml",
        event: "repository_dispatch",
      },
    },
  );

  assert.match(body, /ClawSweeper autofix is enabled/);
  assert.match(body, /`clawsweeper:autofix`/);
  assert.match(body, /fix-only/);
  assert.doesNotMatch(body, /will merge/);
});

test("renderResponse reports terminal autofix success without merge", () => {
  const body = renderResponse(
    {
      comment_id: "462",
      intent: "clawsweeper_auto_merge",
      issue_number: 74108,
      expected_head_sha: "abc462",
      autofix_complete: true,
      repair_reason: "structured ClawSweeper verdict: pass",
      trusted_bot_author: "clawsweeper[bot]",
      target: { head_sha: "abc462" },
    },
    null,
  );

  assert.match(body, /autofix is complete for this exact head/);
  assert.match(body, /No actionable findings remain/);
  assert.match(body, /left the PR open for maintainer review and merge/);
  assert.doesNotMatch(body, /merged this PR/);
  assert.doesNotMatch(body, /did not merge yet/);
});

test("renderResponse reports maintainer re-review dispatches", () => {
  const body = renderResponse(
    {
      comment_id: "461",
      intent: "re_review",
      issue_number: 74107,
      target: { head_sha: "def461" },
    },
    {
      clawsweeper: {
        workflow: "sweep.yml",
        event: "repository_dispatch",
      },
    },
  );

  assert.match(body, /re-review requested/);
  assert.match(body, /review this item again/);
  assert.match(body, /Action: item re-review queued/);
  assert.match(body, /existing ClawSweeper review comment will be edited in place/);
  assert.match(body, /clawsweeper-command-status:74107:re_review:def461/);
  assert.doesNotMatch(body, /repair worker/);
});

test("renderResponse reports issue implementation repair dispatches", () => {
  const body = renderResponse(
    {
      comment_id: "463",
      intent: "implement_issue",
      issue_number: 74113,
      target: { kind: "issue", head_sha: null },
    },
    {
      workflow: "repair cluster worker",
      job_path: "jobs/openclaw/inbox/issue-openclaw-openclaw-74113.md",
      mode: "autonomous",
      model: "gpt-5.6-sol",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/25242426839",
    },
  );

  assert.match(body, /ClawSweeper issue implementation requested/);
  assert.match(body, /open or update one narrow implementation PR/);
  assert.match(body, /Action: repair worker queued/);
  assert.match(body, /does not merge or close the issue/);
  assert.doesNotMatch(body, /automerge/);
});

test("renderResponse includes build override path for issue implementation refusals", () => {
  const body = renderResponse(
    {
      comment_id: "464",
      intent: "implement_issue",
      issue_number: 74113,
      reason: "implementation PR creation requires an open issue",
      target: { kind: "issue", head_sha: null },
    },
    null,
  );

  assert.match(body, /could not start an implementation PR/);
  assert.match(body, /Reason: implementation PR creation requires an open issue/);
  assert.match(body, /Blocker: hard/);
  assert.match(body, /Evidence: implementation PR creation requires an open issue/);
  assert.match(body, /Override: `\/clawsweeper build override`/);
  assert.match(body, /safe non-code plan/);
});

test("renderResponse reports freeform assist dispatches as read-only", () => {
  const body = renderResponse(
    {
      comment_id: "462",
      intent: "freeform_assist",
      freeform_prompt: "why did automerge stop here?",
      target: { head_sha: "def462" },
    },
    {
      clawsweeper: {
        workflow: "sweep.yml",
        event: "repository_dispatch",
      },
    },
  );

  assert.match(body, /taking a look at your question/);
  assert.match(body, /lightweight read-only assist pass/);
  assert.match(body, /separate answer comment/);
  assert.match(body, /will not edit the durable ClawSweeper review comment/);
  assert.match(body, /why did automerge stop here/);
  assert.doesNotMatch(body, /repair worker/);
});

test("renderResponse reports visualize dispatches as marker-backed read-only briefs", () => {
  const body = renderResponse(
    {
      comment_id: "463",
      intent: "visualize",
      visual_lens: "state",
      target: { head_sha: "def463" },
    },
    {
      clawsweeper: {
        workflow: "assist.yml",
        event: "repository_dispatch",
      },
    },
  );

  assert.match(body, /visual brief is being prepared/);
  assert.match(body, /read-only visual pass/);
  assert.match(body, /marker-backed visual brief comment/);
  assert.match(body, /Lens: `state`/);
  assert.doesNotMatch(body, /repair worker/);
});

test("visualize assist dispatch payload stays within repository_dispatch key limit", () => {
  const payload = buildClawSweeperAssistDispatchPayload({
    repo: "openclaw/clawsweeper",
    issue_number: 202,
    target: { kind: "issue" },
    comment_id: "4545883320",
    comment_url: "https://github.com/openclaw/clawsweeper/issues/202#issuecomment-4545883320",
    author: "maintainer",
    command: "visualize state",
    intent: "visualize",
    visual_lens: "state",
  });

  const clientPayload = payload.client_payload;
  assert.equal(payload.event_type, "clawsweeper_assist");
  assert.equal(Object.keys(clientPayload).length <= 10, true);
  assert.equal(clientPayload.target_repo, "openclaw/clawsweeper");
  assert.equal(clientPayload.item_number, "202");
  assert.equal(clientPayload.question, "visualize state");
  assert.equal(clientPayload.assist.mode, "visual");
  assert.equal(clientPayload.assist.lens, "state");
  assert.equal(clientPayload.assist.model, "internal");
  assert.equal(clientPayload.assist.reasoning_effort, "high");
  assert.equal(clientPayload.assist.timeout_ms, "120000");
  assert.equal("mode" in clientPayload, false);
  assert.equal("lens" in clientPayload, false);
});

test("bare visualize dispatch defaults to auto lens within repository_dispatch key limit", () => {
  const parsed = parseCommand("@clawsweeper visualize");
  assert.deepEqual(parsed, {
    trigger: "mention",
    command: "visualize",
    intent: "visualize",
    visual_lens: "auto",
  });

  const payload = buildClawSweeperAssistDispatchPayload({
    repo: "openclaw/clawsweeper",
    issue_number: 213,
    target: { kind: "pull_request" },
    comment_id: "4560428808",
    comment_url: "https://github.com/openclaw/clawsweeper/pull/213#issuecomment-4560428808",
    author: "maintainer",
    ...parsed,
  });

  const clientPayload = payload.client_payload;
  assert.equal(payload.event_type, "clawsweeper_assist");
  assert.equal(Object.keys(clientPayload).length <= 10, true);
  assert.equal(clientPayload.question, "visualize");
  assert.equal(clientPayload.assist.mode, "visual");
  assert.equal(clientPayload.assist.lens, "auto");
  assert.equal("mode" in clientPayload, false);
  assert.equal("lens" in clientPayload, false);
});

test("assist workflow preserves flat field fallbacks after nested dispatch fields", () => {
  const workflow = readFileSync(".github/workflows/assist.yml", "utf8");

  assert.match(
    workflow,
    /MODE: \$\{\{ github\.event\.client_payload\.assist\.mode \|\| github\.event\.client_payload\.mode \|\| inputs\.mode \|\| 'assist' \}\}/,
  );
  assert.match(
    workflow,
    /LENS: \$\{\{ github\.event\.client_payload\.assist\.lens \|\| github\.event\.client_payload\.lens \|\| inputs\.lens \|\| 'auto' \}\}/,
  );
  assert.match(workflow, /MODEL: internal/);
  assert.match(workflow, /CLAWSWEEPER_INTERNAL_MODEL: \$\{\{ secrets\.CLAWSWEEPER_MODEL \}\}/);
  assert.match(workflow, /REASONING_EFFORT: high/);
  assert.doesNotMatch(workflow, /client_payload\.(?:assist\.)?reasoning_effort/);
  assert.match(
    workflow,
    /TIMEOUT_MS: \$\{\{ github\.event\.client_payload\.assist\.timeout_ms \|\| github\.event\.client_payload\.timeout_ms \|\| '120000' \}\}/,
  );
});

test("renderResponse reports maintainer autoclose results", () => {
  const body = renderResponse(
    {
      comment_id: "460",
      intent: "autoclose",
      autoclose_reason: "We do not plan to support this feature.",
      target: { head_sha: null },
    },
    {
      autoclose: {
        status: "executed",
        targets: [
          { ref: "#123", title: "Add unsupported provider", status: "closed" },
          { ref: "#124", title: "Same unsupported provider", status: "closed" },
        ],
      },
    },
  );

  assert.match(body, /autoclose is complete/);
  assert.match(body, /We do not plan to support this feature/);
  assert.match(body, /Closed #123/);
  assert.doesNotMatch(body, /ClawSweeper Repair/i);
});

test("renderResponse documents explicit autoclose linked-target scope", () => {
  const body = renderResponse({
    comment_id: "461",
    intent: "autoclose",
    reason: "autoclose requires a maintainer close reason",
    target: { head_sha: null },
  });

  assert.match(body, /explicitly referenced in the command text/);
  assert.doesNotMatch(body, /bounded linked open same-repo items/);
});

test("renderResponse reports automerge repair dispatches", () => {
  const body = renderResponse(
    {
      comment_id: "457",
      intent: "clawsweeper_auto_repair",
      trusted_bot_author: "clawsweeper[bot]",
      repair_reason: "structured ClawSweeper verdict: needs-repair",
      target: { head_sha: "def457" },
    },
    {
      workflow: "repair-cluster-worker.yml",
      job_path: "jobs/openclaw/inbox/automerge-openclaw-openclaw-74156.md",
      mode: "autonomous",
      model: "gpt-5.6-sol",
    },
  );

  assert.match(body, /picked up the repair feedback/);
  assert.match(body, /Action: repair worker queued/);
  assert.doesNotMatch(body, /repair-cluster-worker\.yml/);
  assert.doesNotMatch(body, /automerge-openclaw-openclaw-74156/);
  assert.doesNotMatch(body, /did not dispatch/);
});

test("renderResponse reports automerge pass with failing checks as repair dispatch", () => {
  const body = renderResponse(
    {
      comment_id: "788",
      intent: "clawsweeper_auto_merge",
      trusted_bot_author: "clawsweeper[bot]",
      repair_reason:
        "structured ClawSweeper verdict: pass; current checks are failing: checks-node-core:FAILURE",
      target: { head_sha: "abc788" },
    },
    {
      repair: {
        workflow: "repair cluster worker",
        job_path: "jobs/openclaw/inbox/automerge-openclaw-openclaw-74506.md",
        mode: "autonomous",
        model: "gpt-5.6-sol",
      },
    },
  );

  assert.match(body, /current checks are failing/);
  assert.match(body, /Action: repair worker queued/);
  assert.doesNotMatch(body, /repair cluster worker/);
  assert.doesNotMatch(body, /automerge-openclaw-openclaw-74506/);
  assert.doesNotMatch(body, /did not merge yet/);
});

test("automerge loop intents share one status comment thread", () => {
  assert.equal(usesSharedAutomergeStatus({ intent: "automerge" }), true);
  assert.equal(usesSharedAutomergeStatus({ intent: "clawsweeper_auto_repair" }), true);
  assert.equal(usesSharedAutomergeStatus({ intent: "clawsweeper_auto_merge" }), true);
  assert.equal(usesSharedAutomergeStatus({ intent: "status" }), false);
  assert.equal(
    sharedAutomergeStatusMarkerPrefix({ issue_number: 75183 }),
    "<!-- clawsweeper-command-status:75183:",
  );
});

test("renderResponse reports explicit human-review pause actions", () => {
  const body = renderResponse(
    {
      comment_id: "458",
      intent: "clawsweeper_needs_human",
      trusted_bot_author: "clawsweeper[bot]",
      repair_reason:
        "Protected maintainer labeling plus proof-label automation risk make this a maintainer validation item rather than a ClawSweeper repair job.",
      target: { head_sha: "def458" },
    },
    null,
  );

  assert.match(body, /pausing this repair loop/);
  assert.match(body, /Why human review is needed:/);
  assert.match(body, /proof-label or proof-gate automation/);
  assert.match(body, /What the maintainer can do as a next step:/);
  assert.match(body, /@clawsweeper approve/);
  assert.match(body, /add redacted real behavior proof/);
  assert.match(body, /@clawsweeper automerge/);
  assert.match(body, /@clawsweeper stop/);
  assert.match(body, /`clawsweeper:human-review`/);
  assert.doesNotMatch(body, /did not dispatch/);
});

test("renderResponse gives generic human-review pauses a next action", () => {
  const body = renderResponse(
    {
      comment_id: "459",
      intent: "clawsweeper_needs_human",
      trusted_bot_author: "clawsweeper[bot]",
      repair_reason: "structured ClawSweeper verdict: human-review",
      target: { head_sha: "def459" },
    },
    null,
  );

  assert.match(body, /Why human review is needed:/);
  assert.match(body, /resolved or accepted by a maintainer/);
  assert.match(body, /What the maintainer can do as a next step:/);
  assert.match(body, /@clawsweeper approve/);
  assert.match(body, /resolve the blocker first/);
  assert.match(body, /@clawsweeper automerge/);
  assert.match(body, /@clawsweeper stop/);
  assert.match(body, /`clawsweeper:human-review`/);
});

test("renderResponse reports automerge completion", () => {
  const body = renderResponse(
    {
      comment_id: "789",
      intent: "clawsweeper_auto_merge",
      repo: "openclaw/openclaw",
      trusted_bot_author: "clawsweeper[bot]",
      repair_reason: "structured ClawSweeper verdict: pass",
      target: { head_sha: "abc789" },
    },
    {
      merge: {
        status: "executed",
        reason: "merged by ClawSweeper automerge",
        merged_at: "2026-04-29T05:00:00Z",
        merge_commit_sha: "def789abcdef789abcdef789abcdef789abcdef7",
        summary_lines: ["Added queued retry handling for Discord REST 429s."],
        fixup_lines: [
          "Included post-review commit in the final squash: fix(discord): avoid stale requeues",
        ],
      },
    },
  );

  assert.match(body, /merged this PR/);
  assert.doesNotMatch(body, /Thanks, ClawSweeper/);
  assert.match(body, /What merged:/);
  assert.match(body, /Added queued retry handling/);
  assert.match(body, /Automerge notes:/);
  assert.match(body, /avoid stale requeues/);
  assert.match(
    body,
    /Merge commit: \[`def789abcdef`\]\(https:\/\/github\.com\/openclaw\/openclaw\/commit\/def789abcdef789abcdef789abcdef789abcdef7\)/,
  );
  assert.match(body, /automerge loop is complete/);
  assert.doesNotMatch(body, /ClawSweeper Repair/i);
});

test("renderResponse reports maintainer-approved automerge completion", () => {
  const body = renderResponse(
    {
      comment_id: "790",
      intent: "maintainer_approve_automerge",
      repo: "openclaw/openclaw",
      author: "steipete",
      expected_head_sha: "abc790",
      target: { head_sha: "abc790" },
    },
    {
      merge: {
        status: "executed",
        reason: "merged by ClawSweeper automerge",
        merged_at: "2026-04-29T05:00:00Z",
        merge_commit_sha: "def790abcdef790abcdef790abcdef790abcdef7",
        summary_lines: ["Updated queue scheduling defaults."],
        fixup_lines: ["No ClawSweeper repair was needed after automerge opt-in."],
      },
    },
  );

  assert.match(body, /Maintainer-approved ClawSweeper automerge is complete/);
  assert.match(body, /Approver: `steipete`/);
  assert.match(body, /Head: `abc790`/);
  assert.match(
    body,
    /Merge commit: \[`def790abcdef`\]\(https:\/\/github\.com\/openclaw\/openclaw\/commit\/def790abcdef790abcdef790abcdef790abcdef7\)/,
  );
  assert.match(body, /What merged:/);
  assert.match(body, /Updated queue scheduling defaults/);
  assert.match(body, /Automerge notes:/);
  assert.match(body, /automerge loop is complete/);
});

test("repair intent set documents executable repair commands", () => {
  assert.deepEqual([...REPAIR_INTENTS].sort(), [
    "address_review",
    "clawsweeper_auto_repair",
    "fix_ci",
    "implement_issue",
    "rebase",
  ]);
});

test("merge intent set documents ClawSweeper pass automerge", () => {
  assert.deepEqual([...MERGE_INTENTS], ["clawsweeper_auto_merge", "maintainer_approve_automerge"]);
});

test("repairable check blockers only include completed failures", () => {
  assert.deepEqual(
    repairableCheckBlockers({
      blockers: [
        "checks-node-core:FAILURE",
        "checks-node-channels:TIMED_OUT",
        "checks-node-start:STARTUP_FAILURE",
        "checks-node-docs:IN_PROGRESS",
        "auto-response:CANCELLED",
        "label:SKIPPED",
      ],
    }),
    [
      "checks-node-core:FAILURE",
      "checks-node-channels:TIMED_OUT",
      "checks-node-start:STARTUP_FAILURE",
    ],
  );
});

test("repairable check blockers exclude external action-required checks", () => {
  assert.deepEqual(
    repairableCheckBlockers({
      blockers: ["Vercel – clawhub:ACTION_REQUIRED", "checks-node-core:FAILURE"],
      externalBlockers: ["Vercel – clawhub:ACTION_REQUIRED"],
    }),
    ["checks-node-core:FAILURE"],
  );
});

test("automerge failed checks become repair reasons", () => {
  assert.equal(
    automergeFailedChecksRepairReason({
      blockers: ["checks-node-core:FAILURE", "auto-response:CANCELLED", "slow:TIMED_OUT"],
    }),
    "current checks are failing: checks-node-core:FAILURE, slow:TIMED_OUT",
  );
  assert.equal(
    automergeFailedChecksRepairReason({
      blockers: ["auto-response:CANCELLED", "label:SKIPPED"],
    }),
    null,
  );
});

test("automerge live readiness blocks become repair reasons", () => {
  assert.equal(
    automergeReadinessRepairReason("mergeable state is CONFLICTING"),
    "PR has merge conflicts and needs a cloud rebase repair before automerge",
  );
  assert.equal(
    automergeReadinessRepairReason("merge state status is DIRTY"),
    "PR is behind or has merge conflicts and needs a cloud rebase repair before automerge",
  );
  assert.equal(
    automergeReadinessRepairReason("merge state status is BEHIND"),
    "PR is behind the base branch and needs a cloud rebase repair before automerge",
  );
  assert.equal(automergeReadinessRepairReason("pull request is draft"), null);
});

test("autoclose intent set documents destructive maintainer commands", () => {
  assert.deepEqual([...AUTOCLOSE_INTENTS], ["autoclose"]);
});

test("automerge merge args pin the reviewed head SHA", () => {
  assert.deepEqual(
    buildAutomergeMergeArgs({
      issueNumber: 123,
      repo: "openclaw/openclaw",
      expectedHeadSha: "abc123",
      subject: "fix: test (#123)",
      bodyFile: "/tmp/body.txt",
    }),
    [
      "pr",
      "merge",
      "123",
      "--repo",
      "openclaw/openclaw",
      "--squash",
      "--subject",
      "fix: test (#123)",
      "--body-file",
      "/tmp/body.txt",
      "--match-head-commit",
      "abc123",
    ],
  );
});

test("automerge squash message credits contributors and records maintainer approval", () => {
  const message = buildAutomergeSquashMessage({
    command: {
      issue_number: 123,
      expected_head_sha: "abc123",
      target: { title: "fix: test" },
      maintainer_attribution: {
        author: "maintainer-user",
        author_id: 123456,
      },
    },
    target: { head_sha: "abc123", title: "fix: test" },
    view: {
      title: "fix: test",
      commits: [
        {
          authors: [
            {
              name: "Contributor",
              email: "111+contributor@users.noreply.github.com",
            },
          ],
        },
      ],
    },
    comments: [],
  });

  assert.match(
    message.body,
    /^Co-authored-by: Contributor <111\+contributor@users\.noreply\.github\.com>$/m,
  );
  assert.doesNotMatch(message.body, /Co-authored-by: clawsweeper\[bot\]/);
  assert.match(message.body, /^Approved-by: maintainer-user$/m);
  assert.doesNotMatch(message.body, /Co-authored-by: maintainer-user/);
});

test("automerge squash message does not duplicate a contributor as approving maintainer", () => {
  const message = buildAutomergeSquashMessage({
    command: {
      issue_number: 123,
      expected_head_sha: "abc123",
      target: { title: "fix: test" },
      maintainer_attribution: {
        author: "maintainer-user",
        author_id: 123456,
      },
    },
    target: { head_sha: "abc123", title: "fix: test" },
    view: {
      title: "fix: test",
      commits: [
        {
          authors: [
            {
              name: "maintainer-user",
              email: "123456+maintainer-user@users.noreply.github.com",
            },
          ],
        },
      ],
    },
    comments: [],
  });

  assert.equal(
    message.body.match(
      /^Co-authored-by: maintainer-user <123456\+maintainer-user@users\.noreply\.github\.com>$/gm,
    )?.length,
    1,
  );
  assert.match(message.body, /^Approved-by: maintainer-user$/m);
});

test("automerge squash message omits ClawSweeper co-author trailer", () => {
  const message = buildAutomergeSquashMessage({
    command: {
      issue_number: 123,
      expected_head_sha: "abc123",
      target: { title: "fix: test" },
      maintainer_attribution: {
        author: "maintainer-user",
        author_id: 123456,
      },
    },
    target: { head_sha: "abc123", title: "fix: test" },
    view: {
      title: "fix: test",
      commits: [
        {
          authors: [
            {
              name: "clawsweeper[bot]",
              email: "274271284+clawsweeper[bot]@users.noreply.github.com",
            },
          ],
        },
      ],
    },
    comments: [],
  });

  assert.equal(
    message.body.split("\n").filter((line) => line === CLAWSWEEPER_CO_AUTHOR_TRAILER).length,
    0,
  );
  assert.match(message.body, /^Approved-by: maintainer-user$/m);
});

test("automerge squash message credits maintainer metadata carried by replacement PR body", () => {
  const body = [
    "Replacement PR body",
    '<!-- clawsweeper-automerge-requested-by login="maintainer-user" id="123456" -->',
  ].join("\n");
  assert.deepEqual(automergeRequestedByFromBody(body), {
    author: "maintainer-user",
    author_id: "123456",
    author_name: null,
  });

  const message = buildAutomergeSquashMessage({
    command: {
      issue_number: 124,
      expected_head_sha: "def456",
      target: { title: "fix: replacement", body },
    },
    target: { head_sha: "def456", title: "fix: replacement", body },
    view: {
      title: "fix: replacement",
      commits: [],
    },
    comments: [],
  });

  assert.match(message.body, /^Approved-by: maintainer-user$/m);
  assert.doesNotMatch(message.body, /Co-authored-by: clawsweeper\[bot\]/);
  assert.doesNotMatch(message.body, /Co-authored-by: maintainer-user/);
});

test("automerge squash message credits requester from earlier automerge status marker", () => {
  const comments = [
    {
      id: 4479302465,
      user: {
        login: "maintainer-user",
        id: 123456,
      },
      created_at: "2026-05-18T15:39:35Z",
      body: "@clawsweeper automerge",
    },
    {
      id: 4479324116,
      user: {
        login: "clawsweeper[bot]",
        id: 274271284,
      },
      created_at: "2026-05-18T15:42:14Z",
      body: [
        "<!-- clawsweeper-command-status:83614:automerge:2239f3ec0c513b0e7b467331c11ab75a6656617d -->",
        "<!-- clawsweeper-command:4479302465:2026-05-18T15:39:35Z:automerge:2239f3ec0c513b0e7b467331c11ab75a6656617d -->",
        "ClawSweeper automerge is enabled.",
      ].join("\n"),
    },
  ];

  assert.deepEqual(automergeRequestedByFromComments(comments), {
    author: "maintainer-user",
    author_id: 123456,
    author_name: null,
  });

  const message = buildAutomergeSquashMessage({
    command: {
      issue_number: 83614,
      expected_head_sha: "9f19a96427f9dbb50e69ea310518984e776eb48d",
      target: { title: "fix: two phase" },
      author: "clawsweeper[bot]",
      author_id: 274271284,
      trusted_bot: true,
    },
    target: {
      head_sha: "9f19a96427f9dbb50e69ea310518984e776eb48d",
      title: "fix: two phase",
    },
    view: {
      title: "fix: two phase",
      commits: [],
    },
    comments,
  });

  assert.match(message.body, /^Approved-by: maintainer-user$/m);
  assert.doesNotMatch(message.body, /Co-authored-by: maintainer-user/);
});

test("automerge gate block only reports the global merge policy gate", () => {
  assert.equal(
    automergeGateBlockReason({
      CLAWSWEEPER_ALLOW_MERGE: "0",
      CLAWSWEEPER_ALLOW_AUTOMERGE: "1",
    }),
    "merge requires CLAWSWEEPER_ALLOW_MERGE=1",
  );
  assert.equal(
    automergeGateBlockReason({
      CLAWSWEEPER_ALLOW_MERGE: "1",
      CLAWSWEEPER_ALLOW_AUTOMERGE: "0",
    }),
    "",
  );
  assert.equal(
    automergeGateBlockReason({
      CLAWSWEEPER_ALLOW_MERGE: "1",
    }),
    "",
  );
});

test("automerge transient wait config defaults to an in-run retry window", () => {
  assert.deepEqual(automergeTransientWaitConfig({}), {
    maxWaitMs: 600000,
    intervalMs: 15000,
  });
  assert.deepEqual(
    automergeTransientWaitConfig({
      CLAWSWEEPER_AUTOMERGE_TRANSIENT_WAIT_MS: "0",
      CLAWSWEEPER_AUTOMERGE_TRANSIENT_POLL_MS: "0",
    }),
    {
      maxWaitMs: 0,
      intervalMs: 1000,
    },
  );
  assert.deepEqual(
    automergeTransientWaitConfig({
      CLAWSWEEPER_AUTOMERGE_TRANSIENT_WAIT_MS: "90000",
      CLAWSWEEPER_AUTOMERGE_TRANSIENT_POLL_MS: "5000",
    }),
    {
      maxWaitMs: 90000,
      intervalMs: 5000,
    },
  );
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

test("organization members can explicitly request issue implementation", () => {
  const allowedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
  assert.equal(
    isIssueImplementationCommandAllowed({
      authorAssociation: "MEMBER",
      repositoryPermission: "read",
      allowedAssociations,
    }),
    true,
  );
  assert.equal(
    isIssueImplementationCommandAllowed({
      authorAssociation: "COLLABORATOR",
      repositoryPermission: "read",
      allowedAssociations,
    }),
    false,
  );
  assert.equal(
    isIssueImplementationCommandAllowed({
      authorAssociation: "CONTRIBUTOR",
      repositoryPermission: "write",
      allowedAssociations,
    }),
    true,
  );
});

test("manual issue implementation blocks linked pull requests before dispatch", () => {
  const source = readFileSync("src/repair/comment-router.ts", "utf8");

  assert.match(
    source,
    /issueImplementationLinkedPrSignal\(target\) && command\.operator_override !== true/,
  );
  assert.match(source, /implementation PR creation is blocked by an existing linked PR/);
  assert.match(source, /addIssueReferenceNumbersFromText\(relatedIssues, text\)/);
  assert.match(source, /searchOpenPullRequestsMentioningIssue\(relatedNumber\)/);
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
