import assert from "node:assert/strict";
import test from "node:test";

import {
  FINAL_REBASE_HANDOFF_RULE,
  NORMAL_REBASE_COMPLETION_RULE,
  rewriteFinalBaseReconcilePrompt,
} from "../../src/repair/final-base-reconcile-prompt.ts";

test("final base reconcile prompt hands rebase continuation back to isolated Git plumbing", () => {
  const rewritten = rewriteFinalBaseReconcilePrompt(
    `Resolve the final base.\n${NORMAL_REBASE_COMPLETION_RULE}\nKeep the requested change narrow.`,
  );

  assert.doesNotMatch(rewritten, new RegExp(NORMAL_REBASE_COMPLETION_RULE));
  assert.match(rewritten, new RegExp(FINAL_REBASE_HANDOFF_RULE));
  assert.match(rewritten, /Keep the requested change narrow\.$/);
});

test("final base reconcile prompt rejects an unexpected upstream contract", () => {
  assert.throws(
    () => rewriteFinalBaseReconcilePrompt("Resolve the final base without the normal rule."),
    /no longer exposes the expected rebase contract/,
  );
});
