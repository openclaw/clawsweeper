import assert from "node:assert/strict";
import test from "node:test";

import {
  automergeMergeFailureRepairReason,
  automergeRebaseRepairReason,
  branchRepairCanContinueAutomerge,
  trustedAutoRepairShouldOptInAutofix,
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

test("trusted repair markers can auto-opt normal PRs into autofix", () => {
  assert.equal(
    trustedAutoRepairShouldOptInAutofix(
      { intent: "clawsweeper_auto_repair", trusted_bot: true },
      {
        kind: "pull_request",
        labels: [],
      },
    ),
    true,
  );

  assert.equal(
    trustedAutoRepairShouldOptInAutofix(
      { intent: "clawsweeper_auto_repair", trusted_bot: false },
      {
        kind: "pull_request",
        labels: [],
      },
    ),
    false,
  );

  assert.equal(
    trustedAutoRepairShouldOptInAutofix(
      { intent: "clawsweeper_auto_repair", trusted_bot: true },
      {
        kind: "pull_request",
        labels: ["clawsweeper:autofix"],
      },
    ),
    false,
  );
});

test("fix-only branch repairs do not continue automerge", () => {
  assert.equal(
    branchRepairCanContinueAutomerge({
      source: "pr_automerge",
      clusterId: "automerge-proxynico-example-17",
      allowMerge: false,
      blockedActions: ["merge"],
    }),
    false,
  );

  assert.equal(
    branchRepairCanContinueAutomerge({
      source: "pr_automerge",
      clusterId: "automerge-proxynico-example-17",
      allowMerge: true,
      blockedActions: [],
    }),
    true,
  );

  assert.equal(
    branchRepairCanContinueAutomerge({
      source: "issue_implementation",
      clusterId: "issue-proxynico-example-17",
      allowMerge: true,
      blockedActions: [],
    }),
    false,
  );
});
