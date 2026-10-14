import assert from "node:assert/strict";
import test from "node:test";
import {
  directReReviewIntake,
  validateDirectReReviewIntake,
} from "../../dist/repair/direct-re-review-admission.js";

const options = {
  targetRepo: "openclaw/openclaw",
  targetBranch: "main",
  itemNumber: 12,
  itemKind: "pull_request" as const,
  installationId: 123,
  sourceCommentId: 456,
  sourceCommentUpdatedAt: "2026-09-06T12:00:00.000Z",
  commandBodyDigest: "a".repeat(64),
  commandOrigin: "comment_router" as const,
  additionalPrompt: "Review this PR.",
};

test("verified review intake preserves its canonical identity through JSON", () => {
  const intake = directReReviewIntake(options);
  assert.deepEqual(validateDirectReReviewIntake(JSON.parse(JSON.stringify(intake))), intake);
});

test("historical command intake retains canonical identity despite retired journey metadata", () => {
  const intake = directReReviewIntake(options);
  for (const bayJourneyDeliveryId of ["historical-delivery", null, { legacy: true }]) {
    const restored = validateDirectReReviewIntake({
      ...intake,
      decision: { ...intake.decision, bayJourneyDeliveryId },
    });
    assert.deepEqual(restored, intake);
  }
});
