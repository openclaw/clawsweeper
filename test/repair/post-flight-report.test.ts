import assert from "node:assert/strict";
import test from "node:test";

import { summarizePostFlightReport } from "../../dist/repair/post-flight-report.js";

test("post-flight report succeeds only when every generated action completed", () => {
  assert.deepEqual(
    summarizePostFlightReport({
      actions: [
        { action: "finalize_fix_pr", status: "ready" },
        { action: "post_merge_closeout", status: "executed" },
      ],
    }),
    {
      outcome: "success",
      detail: "all generated post-flight actions completed",
    },
  );
});

test("post-flight report classifies terminal generated failures as blocked", () => {
  assert.deepEqual(
    summarizePostFlightReport({
      actions: [
        {
          action: "finalize_fix_pr",
          status: "blocked",
          reason: "checks are not clean",
        },
      ],
    }),
    {
      outcome: "blocked",
      detail: "finalize_fix_pr: checks are not clean",
    },
  );
  assert.equal(summarizePostFlightReport({ actions: [] }).outcome, "blocked");
});

test("post-flight report requests requeue only when every incomplete action is retryable", () => {
  assert.equal(
    summarizePostFlightReport({
      actions: [
        {
          action: "finalize_fix_pr",
          status: "blocked",
          reason: "base branch moved",
          retry_recommended: true,
        },
      ],
    }).outcome,
    "requeue",
  );
  assert.equal(
    summarizePostFlightReport({
      actions: [
        { action: "finalize_fix_pr", status: "blocked", retry_recommended: true },
        { action: "post_merge_closeout", status: "blocked", reason: "manual review required" },
      ],
    }).outcome,
    "blocked",
  );
});
