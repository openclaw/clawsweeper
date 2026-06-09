import assert from "node:assert/strict";
import test from "node:test";

import { readCommentRouterConfig } from "../../dist/repair/config.js";

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
