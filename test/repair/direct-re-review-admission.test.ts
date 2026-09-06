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

test("verified review intake preserves explicit denied or selected proof scope through JSON", () => {
  const unrestricted = directReReviewIntake(options);
  assert.equal(Object.hasOwn(unrestricted.decision, "proofAllowedScenarios"), false);
  for (const proofAllowedScenarios of [
    [],
    ["web-ui-chat-proof"],
    ["telegram-bot-e2e-proof"],
    ["web-ui-chat-proof", "telegram-bot-e2e-proof"],
  ] as const) {
    const intake = directReReviewIntake({
      ...options,
      proofAllowedScenarios: [...proofAllowedScenarios],
    });
    const restored = validateDirectReReviewIntake(JSON.parse(JSON.stringify(intake)));
    assert.ok(restored);
    assert.deepEqual(restored.decision.proofAllowedScenarios, proofAllowedScenarios);
  }
});

test("malformed proof scope cannot become an unrestricted admitted review", () => {
  const intake = directReReviewIntake(options);
  for (const scope of [
    null,
    undefined,
    "web-ui-chat-proof",
    ["unknown"],
    ["web-ui-chat-proof", "web-ui-chat-proof"],
    ["web-ui-chat-proof", "telegram-bot-e2e-proof", "unknown"],
  ]) {
    assert.equal(
      validateDirectReReviewIntake({
        ...intake,
        decision: { ...intake.decision, proofAllowedScenarios: scope },
      }),
      null,
    );
  }
});
