import assert from "node:assert/strict";
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
  automergeGateBlockReason,
  automergeJobBranch,
  automergeJobPath,
  automergeReadinessRepairReason,
  automergeTransientWaitConfig,
  buildAutomergeMergeArgs,
  buildAutomergeSquashMessage,
  commandHasAction,
  createCachedIssueCommentsLookup,
  createCachedIssueCommentsLookupAsync,
  commandResponseMarker,
  commandResponseMarkerPrefix,
  commandStatusMarkerPrefix,
  createCachedLabelNumberLookup,
  existingCommandStatusBlocksReplay,
  existingModeStatusBlocksReplay,
  hasCommandResponseMarker,
  issueImplementationClusterId,
  issueImplementationJobBranch,
  issueImplementationJobPath,
  isAuthorReadOnlyCommandAllowed,
  isCanonicalLandingNeedsHumanText,
  isMaintainerCommandAllowed,
  maintainerAutomergeOptInApprovesNeedsHuman,
  parseCommand,
  pausedModeStatusBlocksReplay,
  parseTrustedAutomation,
  repairableCheckBlockers,
  repairLoopPauseLabels,
  repairLoopStopPauseReason,
  reviewedHeadShaBlockReason,
  renderAutomergeJob,
  renderIssueImplementationJob,
  renderResponse,
  sharedAutomergeStatusMarkerPrefix,
  staleAutomergeActivationReason,
  usesSharedAutomergeStatus,
} from "../../dist/repair/comment-router-core.js";
import { parseSimpleYaml, validateJob } from "../../dist/repair/lib.js";

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
    intent: "help",
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
        model: "gpt-5.5",
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

test("renderAutomergeJob validates and keeps merge owned by router", () => {
  const raw = renderAutomergeJob({
    repo: "openclaw/openclaw",
    issueNumber: 74112,
    title: "Tighten cross-session message handling",
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
  assert.equal(job.frontmatter.allow_fix_pr, true);
  assert.equal(job.frontmatter.allow_merge, false);
  assert.deepEqual(job.frontmatter.blocked_actions, ["close", "merge"]);
  assert.deepEqual(job.frontmatter.allowed_actions, ["comment", "label", "fix", "raise_pr"]);
  assert.match(job.body, /repair_contributor_branch/);
  assert.match(job.body, /Codex edit pass can make this PR merge-ready/);
  assert.match(job.body, /rebase onto latest main/);
  assert.match(job.body, /fix CI\/check failures/);
  assert.match(job.body, /add a changelog entry when required/);
  assert.match(job.body, /Never add forbidden changelog credit lines/);
  assert.match(job.body, /router owns final merge/);
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
  assert.deepEqual(job.frontmatter.blocked_actions, ["close", "merge"]);
  assert.deepEqual(job.frontmatter.allowed_actions, ["comment", "label", "fix", "raise_pr"]);
  assert.match(job.body, /Source issue: https:\/\/github\.com\/openclaw\/openclaw\/issues\/74113/);
  assert.match(job.body, /repair_strategy: "new_fix_pr"/);
  assert.match(job.body, /Do not close the issue from this lane/);
  assert.match(job.body, /Keep it scoped to the toolbar/);
});

test("automerge changelog gate blocks user-facing OpenClaw changes without changelog", () => {
  assert.equal(
    automergeChangelogBlockReason({
      repo: "openclaw/openclaw",
      title: "fix(discord): cool down Cloudflare 429 responses",
      files: [
        { path: "extensions/discord/src/api.ts" },
        { path: "extensions/discord/src/api.test.ts" },
      ],
    }),
    "CHANGELOG.md entry is required for user-facing ClawSweeper automerge changes",
  );

  assert.equal(
    automergeChangelogBlockReason({
      repo: "openclaw/openclaw",
      title: "fix(agents): normalize Copilot replay tool IDs",
      files: [{ filename: "src/agents/openai-transport-stream.ts" }],
    }),
    "CHANGELOG.md entry is required for user-facing ClawSweeper automerge changes",
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

test("automerge activation sends missing changelog directly to repair", () => {
  assert.equal(
    automergeActivationRepairReason({
      intent: "automerge",
      repo: "openclaw/openclaw",
      title: "fix(memory): preserve session corpus labels",
      files: [
        { path: "extensions/memory-core/src/tools.ts" },
        { path: "extensions/memory-core/src/tools.test.ts" },
      ],
      target: { checks: { blockers: [] }, merge_state_status: "CLEAN", mergeable: "MERGEABLE" },
    }),
    "CHANGELOG.md entry is required before automerge; dispatch a focused changelog repair",
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
  assert.equal(parseCommand("/not-clawsweeper fix ci"), null);
});

test("parseTrustedAutomation accepts only trusted ClawSweeper repair signals", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const comment = {
    user: { login: "clawsweeper[bot]" },
    body: "Codex review:\n<!-- clawsweeper-action: fix-required -->\nPlease fix this before merge.",
  };

  const parsed = parseTrustedAutomation(comment, { trustedAuthors });
  assert.equal(parsed.intent, "clawsweeper_auto_repair");
  assert.equal(parsed.trusted_bot, true);
  assert.equal(parsed.trusted_bot_author, "clawsweeper[bot]");
  assert.match(parsed.repair_reason, /structured ClawSweeper/);

  assert.equal(
    parseTrustedAutomation({ ...comment, user: { login: "random-user" } }, { trustedAuthors }),
    null,
  );
});

test("parseTrustedAutomation accepts trusted ClawSweeper pass verdicts for automerge", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: "ClawSweeper review passed.\n<!-- clawsweeper-verdict:pass sha=abc123 -->",
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_auto_merge");
  assert.equal(parsed.expected_head_sha, "abc123");
  assert.match(parsed.repair_reason, /verdict: pass/);
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

test("parseTrustedAutomation treats trusted ClawSweeper needs-human as a pause", () => {
  const trustedAuthors = new Set(["clawsweeper[bot]"]);
  const parsed = parseTrustedAutomation(
    {
      user: { login: "clawsweeper[bot]" },
      body: "ClawSweeper needs maintainer judgment.\n<!-- clawsweeper-verdict:needs-human sha=abc123 -->",
    },
    { trustedAuthors },
  );

  assert.equal(parsed.intent, "clawsweeper_needs_human");
  assert.equal(parsed.expected_head_sha, "abc123");
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
      model: "gpt-5.5",
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
    { model: "gpt-5.5" },
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
        model: "gpt-5.5",
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
      model: "gpt-5.5",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/25242426839",
    },
  );

  assert.match(body, /ClawSweeper issue implementation requested/);
  assert.match(body, /open or update one narrow implementation PR/);
  assert.match(body, /Action: repair worker queued/);
  assert.match(body, /does not merge or close the issue/);
  assert.doesNotMatch(body, /automerge/);
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
  assert.match(body, /read-only assist pass/);
  assert.match(body, /why did automerge stop here/);
  assert.doesNotMatch(body, /repair worker/);
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
      model: "gpt-5.5",
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
        model: "gpt-5.5",
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
      repair_reason: "structured ClawSweeper verdict: human-review",
      target: { head_sha: "def458" },
    },
    null,
  );

  assert.match(body, /pausing this repair loop/);
  assert.match(body, /`clawsweeper:human-review`/);
  assert.doesNotMatch(body, /did not dispatch/);
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

test("automerge squash message credits the initiating maintainer with approval and co-author trailers", () => {
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
  assert.match(message.body, /^Approved-by: maintainer-user$/m);
  assert.match(
    message.body,
    /^Co-authored-by: maintainer-user <123456\+maintainer-user@users\.noreply\.github\.com>$/m,
  );
});

test("automerge squash message dedupes maintainer co-author trailer", () => {
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

test("author read-only command authorization only allows own re-review", () => {
  assert.equal(
    isAuthorReadOnlyCommandAllowed({
      command: { intent: "re_review", author: "NickMOpen" },
      target: { kind: "pull_request", author: "nickmopen" },
    }),
    true,
  );
  assert.equal(
    isAuthorReadOnlyCommandAllowed({
      command: { intent: "fix_ci", author: "nickmopen" },
      target: { kind: "pull_request", author: "nickmopen" },
    }),
    false,
  );
  assert.equal(
    isAuthorReadOnlyCommandAllowed({
      command: { intent: "re_review", author: "somebody-else" },
      target: { kind: "pull_request", author: "nickmopen" },
    }),
    false,
  );
});
