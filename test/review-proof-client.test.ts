import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalProofPlan,
  requestReviewProof,
  reviewProofCapabilityFromEnv,
} from "../dist/review-proof-client.js";
import { validReviewProofPlan } from "../dist/review-proof-plan.js";

const plan = {
  claim: "Native help replies",
  actions: [{ type: "send", atMs: 0, text: "/help" }],
  modelReplies: [],
  settings: { streaming: "off", nativeCommands: true },
  maxDurationMs: 1000,
  expectations: ["A help response arrives"],
};
const env = {
  EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#12",
  EXACT_REVIEW_LEASE_ID: "secret-lease",
  EXACT_REVIEW_LEASE_REVISION: "1",
  EXACT_REVIEW_CLAIM_GENERATION: "2",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  EXACT_REVIEW_SOURCE_HEAD_SHA: "a".repeat(40),
};
test("inline proof requires existing exact-head review capability, without new configuration", () => {
  assert.ok(reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), env));
  for (const key of Object.keys(env))
    assert.equal(
      reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), { ...env, [key]: "" }),
      undefined,
      key,
    );
  assert.equal(reviewProofCapabilityFromEnv("openclaw/openclaw", "b".repeat(40), env), undefined);
  assert.equal(
    reviewProofCapabilityFromEnv("openclaw/clawsweeper", "a".repeat(40), env),
    undefined,
  );
  assert.equal(
    reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), {
      ...env,
      QUEUE_URL: "https://user:secret@example.com",
    }),
    undefined,
  );
});
test("plan accepts recorder data and rejects executable DSL and invalid timing", () => {
  assert.equal(validReviewProofPlan(plan), true);
  for (const invalid of [
    { ...plan, command: "anything" },
    { ...plan, settings: { ...plan.settings, token: "anything" } },
    { ...plan, actions: [{ type: "command", atMs: 0, text: "anything" }] },
    { ...plan, actions: [{ type: "send", atMs: 1000, text: "late" }] },
    { ...plan, modelReplies: ["x".repeat(4097)] },
  ])
    assert.equal(validReviewProofPlan(invalid), false);
  assert.equal(
    canonicalProofPlan({ z: { b: 2, a: 1 }, a: [2, 1] }),
    '{"a":[2,1],"z":{"a":1,"b":2}}',
  );
});
test("proof returns complete observations from trusted transport without judging pass", async () => {
  const capability = reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), env)!;
  const observation = {
    state: "completed",
    result: { observations: { events: [{ text: "help" }] }, assertion: "reviewer_must_evaluate" },
  };
  const result = await requestReviewProof(
    capability,
    plan,
    new AbortController().signal,
    async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.lease.leaseId, "secret-lease");
      assert.equal(body.operation, "request");
      assert.equal(body.planSha256.length, 64);
      return Response.json(observation);
    },
  );
  assert.deepEqual(result, observation);
  assert.equal(JSON.stringify(result).includes("secret-lease"), false);
});
test("rejection, invalid data, oversized evidence and cancellation remain inconclusive", async () => {
  const capability = reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), env)!;
  for (const response of [
    new Response("private detail", { status: 409 }),
    new Response("x".repeat(262145)),
    new Response("not json"),
  ]) {
    const result = await requestReviewProof(
      capability,
      plan,
      new AbortController().signal,
      async () => response,
    );
    assert.equal((result as { status: string }).status, "inconclusive");
    assert.equal(JSON.stringify(result).includes("private detail"), false);
  }
  const result = await requestReviewProof(
    capability,
    { command: "bad" },
    new AbortController().signal,
    async () => {
      throw new Error("must not call");
    },
  );
  assert.equal((result as { status: string }).status, "inconclusive");
});
