import assert from "node:assert/strict";
import test from "node:test";

import {
  rebaseConflictEditDecision,
  unresolvedRebaseConflictReason,
} from "./rebase-conflict-policy.js";

test("unresolved rebase conflicts retry within the edit budget", () => {
  assert.deepEqual(
    rebaseConflictEditDecision({
      rebaseStatus: "conflicts",
      unmergedPaths: ["src/index.ts", "CHANGELOG.md"],
      attempt: 1,
      maxEditAttempts: 2,
    }),
    {
      action: "retry",
      reason: "rebase conflicts remain unresolved: src/index.ts, CHANGELOG.md",
    },
  );
});

test("unresolved rebase conflicts require human help after the edit budget", () => {
  const decision = rebaseConflictEditDecision({
    rebaseStatus: "conflicts",
    unmergedPaths: ["src/index.ts"],
    attempt: 2,
    maxEditAttempts: 2,
  });

  assert.deepEqual(decision, {
    action: "needs_human",
    reason: "rebase conflicts remain unresolved: src/index.ts",
  });
  assert.equal(unresolvedRebaseConflictReason(new Error(decision.reason)), decision.reason);
});

test("resolved or non-conflicting rebases proceed", () => {
  assert.deepEqual(
    rebaseConflictEditDecision({
      rebaseStatus: "conflicts",
      unmergedPaths: [],
      attempt: 1,
      maxEditAttempts: 2,
    }),
    { action: "proceed" },
  );
  assert.deepEqual(
    rebaseConflictEditDecision({
      rebaseStatus: "rebased",
      unmergedPaths: ["src/index.ts"],
      attempt: 2,
      maxEditAttempts: 2,
    }),
    { action: "proceed" },
  );
});

test("later conflicts from rebase continuation require human help", () => {
  const reason = "rebase produced additional conflicts: src/later.ts";
  assert.equal(unresolvedRebaseConflictReason(new Error(reason)), reason);
});
