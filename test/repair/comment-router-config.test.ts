import assert from "node:assert/strict";
import test from "node:test";

import { forcedReplayCommandFields, readCommentRouterConfig } from "../../dist/repair/config.js";

test("comment router config preserves target branch from dispatch args", () => {
  const config = readCommentRouterConfig({
    repo: "openclaw/example",
    "target-branch": "master",
    "repair-repo": "openclaw/clawsweeper",
    "review-repo": "openclaw/clawsweeper",
  });

  assert.equal(config.targetRepo, "openclaw/example");
  assert.equal(config.targetBranch, "master");
});

test("comment router config omits target branch by default", () => {
  const originalTargetBranch = process.env.CLAWSWEEPER_TARGET_BRANCH;
  delete process.env.CLAWSWEEPER_TARGET_BRANCH;
  try {
    const config = readCommentRouterConfig({
      repo: "openclaw/example",
      "repair-repo": "openclaw/clawsweeper",
      "review-repo": "openclaw/clawsweeper",
    });

    assert.equal(config.targetRepo, "openclaw/example");
    assert.equal(config.targetBranch, "");
  } finally {
    if (originalTargetBranch === undefined) {
      delete process.env.CLAWSWEEPER_TARGET_BRANCH;
    } else {
      process.env.CLAWSWEEPER_TARGET_BRANCH = originalTargetBranch;
    }
  }
});

test("comment router config derives and binds durable forced replay identity", () => {
  const previousRunId = process.env.GITHUB_RUN_ID;
  const previousRunAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ID = "32345";
  process.env.GITHUB_RUN_ATTEMPT = "2";
  try {
    const config = readCommentRouterConfig({
      repo: "openclaw/example",
      "repair-repo": "openclaw/clawsweeper",
      "review-repo": "openclaw/clawsweeper",
      "force-reprocess": true,
    });

    assert.equal(config.attemptId, "forced-replay-32345");
    assert.deepEqual(forcedReplayCommandFields(config), {
      forced_replay: true,
      attempt_id: "forced-replay-32345",
    });

    process.env.GITHUB_RUN_ATTEMPT = "3";
    const retried = readCommentRouterConfig({
      repo: "openclaw/example",
      "repair-repo": "openclaw/clawsweeper",
      "review-repo": "openclaw/clawsweeper",
      "force-reprocess": true,
    });
    assert.equal(retried.attemptId, config.attemptId);
  } finally {
    if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = previousRunId;
    if (previousRunAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousRunAttempt;
  }
});

test("comment router config rejects unscoped or invalid replay attempts", () => {
  const base = {
    repo: "openclaw/example",
    "repair-repo": "openclaw/clawsweeper",
    "review-repo": "openclaw/clawsweeper",
  };

  assert.throws(
    () => readCommentRouterConfig({ ...base, "attempt-id": "forced-replay-1" }),
    /requires --force-reprocess/,
  );
  assert.throws(
    () =>
      readCommentRouterConfig({
        ...base,
        "force-reprocess": true,
        "attempt-id": "invalid replay",
      }),
    /non-empty token/,
  );
});
