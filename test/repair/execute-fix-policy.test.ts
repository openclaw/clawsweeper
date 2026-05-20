import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldCloseSupersededSourcePrs,
  shouldSeedReplacementBranchFromSource,
  sourceBranchWriteBlockReason,
} from "../../dist/repair/execute-fix-policy.js";

test("superseded source PR closeout defaults on for replacement PRs", () => {
  assert.equal(shouldCloseSupersededSourcePrs(undefined), true);
  assert.equal(shouldCloseSupersededSourcePrs(""), true);
  assert.equal(shouldCloseSupersededSourcePrs("1"), true);
  assert.equal(shouldCloseSupersededSourcePrs("true"), true);
});

test("superseded source PR closeout can be explicitly disabled", () => {
  assert.equal(shouldCloseSupersededSourcePrs("0"), false);
  assert.equal(shouldCloseSupersededSourcePrs("false"), false);
});

test("only replacement fixes seed the repair branch from a source PR head", () => {
  assert.equal(
    shouldSeedReplacementBranchFromSource({ repair_strategy: "replace_uneditable_branch" }),
    true,
  );
  assert.equal(shouldSeedReplacementBranchFromSource({ repair_strategy: "new_fix_pr" }), false);
  assert.equal(
    shouldSeedReplacementBranchFromSource({ repair_strategy: "repair_contributor_branch" }),
    false,
  );
});

test("sourceBranchWriteBlockReason allows same-repo branches despite maintainer flag", () => {
  assert.equal(
    sourceBranchWriteBlockReason("openclaw/openclaw", {
      maintainer_can_modify: false,
      head: {
        ref: "feature",
        repo: { full_name: "openclaw/openclaw" },
      },
    }),
    null,
  );
});

test("sourceBranchWriteBlockReason allows fork branches with maintainer edits", () => {
  assert.equal(
    sourceBranchWriteBlockReason("openclaw/openclaw", {
      maintainer_can_modify: true,
      head: {
        ref: "feature",
        repo: { full_name: "contributor/openclaw" },
      },
    }),
    null,
  );
});

test("sourceBranchWriteBlockReason blocks fork branches without maintainer edits", () => {
  assert.equal(
    sourceBranchWriteBlockReason("openclaw/openclaw", {
      maintainer_can_modify: false,
      head: {
        ref: "feature",
        repo: { full_name: "contributor/openclaw" },
      },
    }),
    "source PR branch is a fork with maintainer_can_modify=false",
  );
});

test("sourceBranchWriteBlockReason blocks missing head details", () => {
  assert.equal(
    sourceBranchWriteBlockReason("openclaw/openclaw", {
      maintainer_can_modify: true,
      head: { repo: { full_name: "contributor/openclaw" } },
    }),
    "source PR is missing head repo/ref",
  );
});
