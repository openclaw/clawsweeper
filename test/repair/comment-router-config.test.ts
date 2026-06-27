import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TRUSTED_BOTS, readCommentRouterConfig } from "../../dist/repair/config.js";

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

test("comment router defaults trust deployed ClawSweeper app identities", () => {
  assert.ok(DEFAULT_TRUSTED_BOTS.includes("clawsweeper[bot]"));
  assert.ok(DEFAULT_TRUSTED_BOTS.includes("openclaw-clawsweeper[bot]"));
  assert.ok(DEFAULT_TRUSTED_BOTS.includes("dita-clawsweeper[bot]"));
  assert.ok(DEFAULT_TRUSTED_BOTS.includes("nico-clawsweeper[bot]"));
});
