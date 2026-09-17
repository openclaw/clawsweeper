import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePublicReviewFailure,
  reviewFailureExplanation,
  PUBLIC_REVIEW_FAILURE_STAGES,
  PUBLIC_REVIEW_FAILURE_REASONS,
} from "../src/review-failure-explanation.ts";

test("public failure vocabulary is closed and copy never contains raw diagnostics", () => {
  for (const stage of PUBLIC_REVIEW_FAILURE_STAGES)
    for (const reason of PUBLIC_REVIEW_FAILURE_REASONS) {
      assert.deepEqual(normalizePublicReviewFailure({ stage, reason }), { stage, reason });
      assert.equal(typeof reviewFailureExplanation({ stage, reason }), "string");
    }
  for (const invalid of [
    null,
    [],
    "secret",
    {},
    { stage: "private/path", reason: "unknown" },
    { stage: "workflow", reason: "secret" },
    { stage: "workflow", reason: "unknown", diagnostic: "secret" },
    { stage: 1, reason: "unknown" },
    { stage: "workflow", reason: "unknown " },
    Object.create({ stage: "workflow", reason: "unknown" }),
  ]) {
    assert.equal(normalizePublicReviewFailure(invalid), null);
    assert.equal(reviewFailureExplanation(invalid), null);
  }
  assert.doesNotMatch(
    reviewFailureExplanation({ stage: "agent_input_scan", reason: "incomplete_source" })!,
    /ancestor|ancestry|merge base/i,
  );
});
