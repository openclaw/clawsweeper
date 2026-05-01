import assert from "node:assert/strict";
import test from "node:test";

import {
  automergeMergeFailureRepairReason,
  automergeRebaseRepairReason,
} from "./comment-router-core.js";

test("automerge rebase repair reason detects dirty merge state", () => {
  assert.match(
    automergeRebaseRepairReason({ merge_state_status: "DIRTY" }) ?? "",
    /cloud rebase repair/,
  );
});

test("automerge rebase repair reason detects behind merge state", () => {
  assert.match(
    automergeRebaseRepairReason({ mergeStateStatus: "BEHIND" }) ?? "",
    /behind the base branch/,
  );
});

test("automerge rebase repair reason detects conflicting mergeable state", () => {
  assert.match(automergeRebaseRepairReason({ mergeable: "CONFLICTING" }) ?? "", /merge conflicts/);
});

test("automerge rebase repair reason ignores clean merge state", () => {
  assert.equal(automergeRebaseRepairReason({ merge_state_status: "CLEAN" }), null);
  assert.equal(automergeRebaseRepairReason({ mergeStateStatus: "HAS_HOOKS" }), null);
});

test("automerge merge failure repair reason detects GitHub merge conflict errors", () => {
  assert.match(
    automergeMergeFailureRepairReason(
      "merge command failed: GraphQL: Pull Request has merge conflicts (mergePullRequest)",
    ) ?? "",
    /cloud rebase repair/,
  );
});

test("automerge merge failure repair reason ignores unrelated merge failures", () => {
  assert.equal(
    automergeMergeFailureRepairReason("merge command failed: GraphQL: Head sha mismatch"),
    null,
  );
});
