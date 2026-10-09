import assert from "node:assert/strict";
import test from "node:test";

import { buildClawSweeperReviewDispatchPayload } from "../../dist/repair/comment-router-core.js";

test("autofix review follow-up keeps queue dispatch options and the command status", () => {
  const payload = buildClawSweeperReviewDispatchPayload(
    {
      intent: "autofix",
      repo: "openclaw/fixture",
      issue_number: 123,
      target_branch: "release",
      status_comment_id: 456,
      target: { kind: "pull_request", changed_files: 30, additions: 0, deletions: 0 },
    },
    { dispatchKey: "router-fixture", additionalPrompt: "Preserve the requested scope" },
  );

  assert.deepEqual(payload, {
    event_type: "clawsweeper_item",
    client_payload: {
      target_repo: "openclaw/fixture",
      target_branch: "release",
      item_number: "123",
      item_kind: "pull_request",
      dispatch_key: "router-fixture",
      additional_prompt: "Preserve the requested scope",
      review_options: { codex_timeout_ms: 700_000, media_proof_timeout_ms: 0 },
      command_status_marker: "<!-- clawsweeper-command-status:123:autofix:na -->",
      status_comment_id: "456",
    },
  });
});

test("issue review follow-up has no pull request budget and no command status", () => {
  const payload = buildClawSweeperReviewDispatchPayload(
    {
      intent: "fix_ci",
      repo: "openclaw/fixture",
      issue_number: 7,
      source_delivery_id: "delivery-7",
      target: { kind: "issue" },
    },
    { dispatchKey: "router-issue", additionalPrompt: "" },
  );

  assert.deepEqual(payload.client_payload, {
    target_repo: "openclaw/fixture",
    item_number: "7",
    item_kind: "issue",
    dispatch_key: "router-issue",
    source_delivery_id: "delivery-7",
    additional_prompt: "",
  });
});
