import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { REVIEW_PROOF_RESPONSE_MAX_BYTES } from "../dist/review-proof-limits.js";
import {
  canonicalProofPlan,
  requestReviewProof,
  resolveReviewProofCapability,
  reviewProofTools,
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

test("a second proof call cannot deliver after the first plan's authoritative expiry", async (t) => {
  const started = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: started });
  const capability = reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), env)!;
  capability.allowedScenarios = ["telegram-bot-e2e-proof"];
  const completed = {
    state: "completed",
    expiresAt: started + 20 * 60_000,
    result: { observations: "synthetic" },
  };
  assert.deepEqual(
    await requestReviewProof(capability, plan, new AbortController().signal, async () =>
      Response.json(completed),
    ),
    completed,
  );
  t.mock.timers.tick(16 * 60_000);
  const result = await requestReviewProof(
    capability,
    { ...plan, claim: "Second claim" },
    new AbortController().signal,
    async () => {
      t.mock.timers.tick(4 * 60_000);
      return Response.json(completed);
    },
  );
  assert.equal((result as { status: string }).status, "inconclusive");
  assert.equal((result as { result?: unknown }).result, undefined);
});

test("proof expiry is mandatory, safe, and cannot extend earlier queue authority", async (t) => {
  const started = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: started });
  const capability = reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), env)!;
  capability.allowedScenarios = ["telegram-bot-e2e-proof"];
  for (const expiresAt of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "later"]) {
    const result = await requestReviewProof(
      capability,
      plan,
      new AbortController().signal,
      async () =>
        Response.json({ state: "completed", expiresAt, result: { observations: "synthetic" } }),
    );
    assert.equal((result as { status: string }).status, "inconclusive");
  }
  const result = await requestReviewProof(
    capability,
    plan,
    new AbortController().signal,
    async () => Response.json({ state: "completed", expiresAt: started + 60_000 }),
  );
  assert.equal((result as { state: string }).state, "completed");
  t.mock.timers.tick(60_000);
  let calls = 0;
  assert.equal(
    (
      (await requestReviewProof(capability, plan, new AbortController().signal, async () => {
        calls++;
        return Response.json({ state: "completed", expiresAt: Date.now() + 20 * 60_000 });
      })) as { status: string }
    ).status,
    "inconclusive",
  );
  assert.equal(calls, 0);
  capability.lease = { ...capability.lease, leaseId: "new-owner", claimGeneration: 3 };
  assert.equal(
    (
      (await requestReviewProof(capability, plan, new AbortController().signal, async () =>
        Response.json({ state: "completed", expiresAt: Date.now() + 20 * 60_000 }),
      )) as { state: string }
    ).state,
    "completed",
  );
});

test("pending proof keeps polling after fifteen minutes and returns as soon as completed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const capability = reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), env)!;
  capability.allowedScenarios = ["telegram-bot-e2e-proof"];
  let calls = 0;
  const completed = {
    state: "completed",
    expiresAt: Date.now() + 20 * 60_000,
    result: { observations: "synthetic" },
  };
  const result = await requestReviewProof(
    capability,
    plan,
    new AbortController().signal,
    async () => {
      calls++;
      if (calls === 1) {
        t.mock.timers.tick(16 * 60_000);
        return Response.json({ state: "pending", expiresAt: completed.expiresAt });
      }
      return Response.json(completed);
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, completed);
});

for (const elapsed of [0, 16 * 60_000, 20 * 60_000]) {
  test(`proof completion respects the shared twenty-minute ceiling (${elapsed}ms)`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const capability = reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), env)!;
    capability.allowedScenarios = ["telegram-bot-e2e-proof"];
    const response = {
      state: "completed",
      expiresAt: Date.now() + 20 * 60_000,
      result: { observations: "synthetic" },
    };
    let calls = 0;
    const result = await requestReviewProof(
      capability,
      plan,
      new AbortController().signal,
      async () => {
        calls++;
        t.mock.timers.tick(elapsed);
        return Response.json(response);
      },
    );
    assert.equal(calls, 1);
    if (elapsed < 20 * 60_000) assert.deepEqual(result, response);
    else {
      assert.equal((result as { status: string }).status, "inconclusive");
      assert.equal((result as { result?: unknown }).result, undefined);
    }
  });
}
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
  capability.allowedScenarios = ["telegram-bot-e2e-proof"];
  const observation = {
    state: "completed",
    expiresAt: Date.now() + 20 * 60_000,
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
test("proof HTTP response beyond bounded envelope headroom is rejected", async () => {
  const envelope = { state: "completed", result: { text: "" } };
  envelope.result.text = "x".repeat(
    REVIEW_PROOF_RESPONSE_MAX_BYTES + 1 - Buffer.byteLength(JSON.stringify(envelope)),
  );
  const wire = JSON.stringify(envelope);
  assert.equal(Buffer.byteLength(wire), REVIEW_PROOF_RESPONSE_MAX_BYTES + 1);
  const server = createServer((_request, response) => response.end(wire));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const capability = reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), env)!;
    capability.queueUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    capability.allowedScenarios = ["telegram-bot-e2e-proof"];
    const result = await requestReviewProof(capability, plan, new AbortController().signal);
    assert.equal((result as { status: string }).status, "inconclusive");
    assert.equal((result as { result?: unknown }).result, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("rejection, invalid data, oversized evidence and cancellation remain inconclusive", async () => {
  const capability = reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), env)!;
  capability.allowedScenarios = ["telegram-bot-e2e-proof"];
  for (const response of [
    new Response("private detail", { status: 409 }),
    new Response("x".repeat(REVIEW_PROOF_RESPONSE_MAX_BYTES + 1)),
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

test("proof capabilities fail closed and enforce explicit scenario scope before fetch", async () => {
  const capability = reviewProofCapabilityFromEnv("openclaw/openclaw", "a".repeat(40), env)!;
  const signal = new AbortController().signal;
  assert.deepEqual(reviewProofTools(capability), []);
  let handshake: unknown;
  const selected = await resolveReviewProofCapability(capability, signal, async (_url, options) => {
    handshake = JSON.parse(String(options?.body));
    return Response.json({ ok: true, allowedScenarios: ["web-ui-chat-proof"] });
  });
  assert.deepEqual(handshake, { operation: "capabilities", lease: capability.lease });
  assert.deepEqual(
    reviewProofTools(selected).map((tool) => tool.name),
    ["request_web_ui_chat_proof"],
  );
  let fetched = false;
  const denied = await requestReviewProof(selected, plan, signal, async () => {
    fetched = true;
    return Response.json({});
  });
  assert.equal(fetched, false);
  assert.match(JSON.stringify(denied), /not authorized/);
  for (const value of [
    null,
    {},
    { ok: true, allowedScenarios: ["auto"] },
    { ok: true, allowedScenarios: [] },
  ]) {
    const resolved = await resolveReviewProofCapability(capability, signal, async () =>
      Response.json(value),
    );
    assert.deepEqual(reviewProofTools(resolved), []);
  }
  const unavailable = await resolveReviewProofCapability(capability, signal, async () => {
    throw new Error("unavailable");
  });
  assert.deepEqual(reviewProofTools(unavailable), []);
});
