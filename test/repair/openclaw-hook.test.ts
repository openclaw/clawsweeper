import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientOpenClawHookError,
  OpenClawHookHttpError,
  postOpenClawAgentHook,
  resolveOpenClawHookConfig,
} from "../../dist/repair/openclaw-hook.js";

const config = {
  hookUrl: "https://claw.example/hooks/agent",
  token: "secret",
  agentId: "clawsweeper",
  channel: "discord",
  discordTarget: "channel:123",
  thinking: "low",
  timeoutSeconds: 1,
  retryAttempts: 3,
};

const post = {
  name: "GitHub activity",
  message: "hello",
  idempotencyKey: "github-activity:test",
  deliver: false,
};

test("postOpenClawAgentHook retries transient hook failures with the same idempotency key", async () => {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    bodies.push(JSON.parse(String(init?.body)));
    if (calls.length === 1) return new Response("bad gateway", { status: 502 });
    if (calls.length === 2) throw new Error("read ECONNRESET");
    return new Response(
      JSON.stringify({
        runId: "run-123",
        completion: {
          status: "skipped",
          replyDisposition: "silent",
          delivered: false,
          deliveryAttempted: false,
          deliverySuppressionReason: "silent",
        },
      }),
      { status: 200 },
    );
  };

  const result = await postOpenClawAgentHook({
    config,
    fetcher,
    post,
    retryDelaysMs: [0, 0],
  });

  assert.equal(result.runId, "run-123");
  assert.deepEqual(result.delivery, {
    status: "suppressed",
    suppressionReason: "silent",
    error: null,
  });
  assert.deepEqual(calls, ["github-activity:test", "github-activity:test", "github-activity:test"]);
  assert.equal(
    bodies.every((body) => body.waitForCompletion === true),
    true,
  );
});

test("postOpenClawAgentHook does not retry non-transient hook failures", async () => {
  let calls = 0;
  await assert.rejects(
    postOpenClawAgentHook({
      config,
      fetcher: async () => {
        calls += 1;
        return new Response("denied", { status: 401 });
      },
      post,
      retryDelaysMs: [0, 0],
    }),
    /OpenClaw hook returned 401/,
  );
  assert.equal(calls, 1);
});

test("postOpenClawAgentHook accepts legacy admission without retrying", async () => {
  let calls = 0;
  const result = await postOpenClawAgentHook({
    config,
    fetcher: async () => {
      calls += 1;
      return Response.json({ ok: true, runId: "legacy-run" });
    },
    post,
    retryDelaysMs: [0, 0],
  });

  assert.equal(calls, 1);
  assert.equal(result.runId, "legacy-run");
  assert.deepEqual(result.delivery, {
    status: "admitted",
    suppressionReason: null,
    error: null,
  });
});

test("postOpenClawAgentHook classifies bounded completion results", async () => {
  const cases = [
    {
      name: "deliver false with verified message-tool delivery",
      deliver: false,
      completion: {
        status: "ok",
        replyDisposition: "silent",
        delivered: true,
        deliveryAttempted: true,
      },
      expected: { status: "delivered", suppressionReason: null, error: null },
    },
    {
      name: "deliver false with exact silent reply",
      deliver: false,
      completion: {
        status: "ok",
        replyDisposition: "silent",
        delivered: false,
        deliveryAttempted: false,
      },
      expected: { status: "suppressed", suppressionReason: "silent", error: null },
    },
    {
      name: "exact silent reply wins over later error fields",
      deliver: false,
      completion: {
        status: "error",
        replyDisposition: "silent",
        delivered: false,
        deliveryAttempted: true,
        deliveryError: "delivery-failed",
      },
      expected: { status: "suppressed", suppressionReason: "silent", error: null },
    },
    {
      name: "deliver false with private visible reply",
      deliver: false,
      completion: {
        status: "ok",
        replyDisposition: "visible",
        delivered: false,
        deliveryAttempted: false,
      },
      expected: { status: "unknown", suppressionReason: null, error: null },
    },
    {
      name: "deliver false with no delivery or model reply",
      deliver: false,
      completion: {
        status: "ok",
        replyDisposition: "empty",
        delivered: false,
        deliveryAttempted: false,
      },
      expected: { status: "not-requested", suppressionReason: null, error: null },
    },
    {
      name: "automatic delivery with explicit suppression",
      deliver: true,
      completion: {
        status: "skipped",
        replyDisposition: "empty",
        delivered: false,
        deliveryAttempted: false,
        deliverySuppressionReason: "heartbeat",
      },
      expected: { status: "suppressed", suppressionReason: "heartbeat", error: null },
    },
    {
      name: "verified delivery wins over terminal errors",
      deliver: true,
      completion: {
        status: "error",
        replyDisposition: "visible",
        delivered: true,
        deliveryAttempted: true,
        deliveryError: "delivery-failed",
      },
      expected: { status: "delivered", suppressionReason: null, error: null },
    },
    {
      name: "terminal delivery error",
      deliver: true,
      completion: {
        status: "error",
        replyDisposition: "empty",
        deliveryError: `secret\n${"x".repeat(600)}`,
      },
      expectedStatus: "failed",
    },
    {
      name: "deliver false skipped without explicit suppression evidence",
      deliver: false,
      completion: {
        status: "skipped",
        replyDisposition: "empty",
        delivered: false,
        deliveryAttempted: false,
      },
      expected: { status: "unknown", suppressionReason: null, error: null },
    },
    {
      name: "missing reply disposition",
      deliver: false,
      completion: { status: "ok", deliveryAttempted: false },
      expected: { status: "unknown", suppressionReason: null, error: null },
    },
  ] as const;

  for (const fixture of cases) {
    const result = await postOpenClawAgentHook({
      config,
      fetcher: async () => Response.json({ runId: "run-123", completion: fixture.completion }),
      post: { ...post, deliver: fixture.deliver },
    });
    if ("expected" in fixture) {
      assert.deepEqual(result.delivery, fixture.expected);
      continue;
    }
    assert.equal(result.delivery.status, fixture.expectedStatus);
    assert.equal(result.delivery.error?.includes("\n"), false);
    assert.equal(result.delivery.error?.includes("secret"), false);
    assert.equal(result.delivery.error?.length, 500);
  }
});

test("postOpenClawAgentHook rejects malformed completion as unknown", async () => {
  const result = await postOpenClawAgentHook({
    config,
    fetcher: async () =>
      Response.json({ ok: true, runId: "run-123", completion: { status: "skipped" } }),
    post,
  });

  assert.deepEqual(result.delivery, {
    status: "unknown",
    suppressionReason: null,
    error: null,
  });
});

test("resolveOpenClawHookConfig supports explicit retry attempts", () => {
  assert.equal(
    resolveOpenClawHookConfig({
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
      CLAWSWEEPER_OPENCLAW_HOOK_RETRY_ATTEMPTS: "5",
    })?.retryAttempts,
    5,
  );
});

test("isTransientOpenClawHookError classifies retryable HTTP statuses and socket failures", () => {
  assert.equal(isTransientOpenClawHookError(new OpenClawHookHttpError(502, "bad")), true);
  assert.equal(isTransientOpenClawHookError(new OpenClawHookHttpError(401, "bad")), false);
  assert.equal(isTransientOpenClawHookError(new Error("read ECONNRESET")), true);
});
