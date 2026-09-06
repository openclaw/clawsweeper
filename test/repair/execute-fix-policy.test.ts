import assert from "node:assert/strict";
import test from "node:test";
import { parseBooleanEnv } from "../../dist/repair/env-utils.js";

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

test("boolean config coercion preserves tokens without trimming and owner defaults", () => {
  for (const value of ["1", "TrUe", "YeS", "On", true, 1]) {
    assert.equal(parseBooleanEnv(value, false), true, String(value));
    assert.equal(shouldCloseSupersededSourcePrs(value), true, String(value));
  }
  for (const value of ["0", "FaLsE", "No", "OfF", false, 0]) {
    assert.equal(parseBooleanEnv(value, true), false, String(value));
    assert.equal(shouldCloseSupersededSourcePrs(value), false, String(value));
  }
  for (const value of [undefined, null, "", "unknown", " ", " true", "false ", 2]) {
    assert.equal(parseBooleanEnv(value, false), false, String(value));
    assert.equal(parseBooleanEnv(value, true), true, String(value));
    assert.equal(shouldCloseSupersededSourcePrs(value), true, String(value));
  }
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
