import assert from "node:assert/strict";
import test from "node:test";

import { issueImplementationTerminalOutcome } from "./issue-implementation-outcome.js";

test("issue implementation treats needs-human repair actions as terminal", () => {
  const outcome = issueImplementationTerminalOutcome({
    status: "needs_human",
    actions: [
      {
        action: "needs_human",
        status: "blocked",
        reason: "rebase conflicts remain unresolved: src/index.ts",
      },
    ],
  });

  assert.deepEqual(outcome, {
    action: "needs_human",
    status: "blocked",
    reason: "rebase conflicts remain unresolved: src/index.ts",
  });
});

test("issue implementation normalizes needs-human report fallback to blocked", () => {
  assert.deepEqual(
    issueImplementationTerminalOutcome({
      status: "needs_human",
      reason: "rebase produced additional conflicts: src/later.ts",
    }),
    {
      action: "issue_implementation",
      status: "blocked",
      reason: "rebase produced additional conflicts: src/later.ts",
    },
  );
});

test("issue implementation ignores non-terminal reports", () => {
  assert.equal(issueImplementationTerminalOutcome({ status: "complete", actions: [] }), null);
});
