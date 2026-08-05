import assert from "node:assert/strict";
import test from "node:test";

import {
  LinearRequestError,
  linearRetryKind,
  linearRetryWaitMs,
  shouldRetryLinear,
} from "../dist/linear/retry.js";
import { createLinearTransport } from "../dist/linear/client.js";

// ---------------------------------------------------------------------------
// linearRetryKind
// ---------------------------------------------------------------------------

test("linearRetryKind: LinearRequestError with code RATELIMITED → throttle", () => {
  const err = new LinearRequestError("rate limited", { code: "RATELIMITED" });
  assert.equal(linearRetryKind(err), "throttle");
});

test("linearRetryKind: LinearRequestError status 400 + RATELIMITED in message → throttle", () => {
  const err = new LinearRequestError("RATELIMITED by API", { status: 400 });
  assert.equal(linearRetryKind(err), "throttle");
});

test("linearRetryKind: LinearRequestError status 429 → throttle", () => {
  const err = new LinearRequestError("Too Many Requests", { status: 429 });
  assert.equal(linearRetryKind(err), "throttle");
});

test("linearRetryKind: LinearRequestError status 500 → transient", () => {
  const err = new LinearRequestError("Internal Server Error", { status: 500 });
  assert.equal(linearRetryKind(err), "transient");
});

test("linearRetryKind: LinearRequestError status 502 → transient", () => {
  const err = new LinearRequestError("Bad Gateway", { status: 502 });
  assert.equal(linearRetryKind(err), "transient");
});

test("linearRetryKind: LinearRequestError status 503 → transient", () => {
  const err = new LinearRequestError("Service Unavailable", { status: 503 });
  assert.equal(linearRetryKind(err), "transient");
});

test("linearRetryKind: LinearRequestError status 504 → transient", () => {
  const err = new LinearRequestError("Gateway Timeout", { status: 504 });
  assert.equal(linearRetryKind(err), "transient");
});

test("linearRetryKind: plain Error with ECONNRESET → transient", () => {
  assert.equal(linearRetryKind(new Error("ECONNRESET")), "transient");
});

test("linearRetryKind: plain Error with ETIMEDOUT → transient", () => {
  assert.equal(linearRetryKind(new Error("ETIMEDOUT")), "transient");
});

test("linearRetryKind: plain Error with socket hang up → transient", () => {
  assert.equal(linearRetryKind(new Error("socket hang up")), "transient");
});

test("linearRetryKind: unrelated error → none", () => {
  assert.equal(linearRetryKind(new Error("something unexpected")), "none");
});

test("linearRetryKind: non-Error value → none", () => {
  assert.equal(linearRetryKind("string error"), "none");
  assert.equal(linearRetryKind(42), "none");
  assert.equal(linearRetryKind(null), "none");
});

// ---------------------------------------------------------------------------
// LinearRequestError shape
// ---------------------------------------------------------------------------

test("LinearRequestError has correct name and readonly fields", () => {
  const err = new LinearRequestError("oops", { status: 429, code: "RATELIMITED", resetAtMs: 9000 });
  assert.equal(err.name, "LinearRequestError");
  assert.ok(err instanceof Error);
  assert.equal(err.message, "oops");
  assert.equal(err.status, 429);
  assert.equal(err.code, "RATELIMITED");
  assert.equal(err.resetAtMs, 9000);
});

test("LinearRequestError without options has undefined fields", () => {
  const err = new LinearRequestError("bare");
  assert.equal(err.status, undefined);
  assert.equal(err.code, undefined);
  assert.equal(err.resetAtMs, undefined);
});

// ---------------------------------------------------------------------------
// shouldRetryLinear
// ---------------------------------------------------------------------------

test("shouldRetryLinear returns true for throttle errors", () => {
  assert.equal(shouldRetryLinear(new LinearRequestError("rl", { status: 429 })), true);
});

test("shouldRetryLinear returns true for transient errors", () => {
  assert.equal(shouldRetryLinear(new LinearRequestError("srv", { status: 500 })), true);
});

test("shouldRetryLinear returns false for non-retryable errors", () => {
  assert.equal(shouldRetryLinear(new Error("validation failed")), false);
});

// ---------------------------------------------------------------------------
// linearRetryWaitMs
// ---------------------------------------------------------------------------

test("linearRetryWaitMs: throttle with resetAtMs in future uses reset delta (capped 600000)", () => {
  const nowMs = 1_000_000;
  const resetAtMs = 1_030_000; // 30 seconds in the future
  const wait = linearRetryWaitMs("throttle", 0, resetAtMs, nowMs);
  assert.equal(wait, 30_000);
});

test("linearRetryWaitMs: throttle with resetAtMs exactly at now → does not use reset path", () => {
  const nowMs = 1_000_000;
  const resetAtMs = 1_000_000; // not in the future
  // Falls through to exponential: 30000 * 2^0 = 30000
  const wait = linearRetryWaitMs("throttle", 0, resetAtMs, nowMs);
  assert.equal(wait, 30_000);
});

test("linearRetryWaitMs: throttle with very distant resetAtMs → capped at 600000", () => {
  const nowMs = 1_000_000;
  const resetAtMs = nowMs + 1_000_000; // 1000 seconds future
  const wait = linearRetryWaitMs("throttle", 0, resetAtMs, nowMs);
  assert.equal(wait, 600_000);
});

test("linearRetryWaitMs: throttle without resetAtMs → exponential 30000*2^attempt capped", () => {
  assert.equal(linearRetryWaitMs("throttle", 0), 30_000);
  assert.equal(linearRetryWaitMs("throttle", 1), 60_000);
  assert.equal(linearRetryWaitMs("throttle", 2), 120_000);
  // Large attempt → capped at 600000
  assert.equal(linearRetryWaitMs("throttle", 20), 600_000);
});

test("linearRetryWaitMs: transient → 2000*2^attempt capped at 60000", () => {
  assert.equal(linearRetryWaitMs("transient", 0), 2_000);
  assert.equal(linearRetryWaitMs("transient", 1), 4_000);
  assert.equal(linearRetryWaitMs("transient", 2), 8_000);
  // Large attempt → capped at 60000
  assert.equal(linearRetryWaitMs("transient", 20), 60_000);
});

test("linearRetryWaitMs: none → always 0", () => {
  assert.equal(linearRetryWaitMs("none", 0), 0);
  assert.equal(linearRetryWaitMs("none", 5), 0);
});

// ---------------------------------------------------------------------------
// createLinearTransport retry behaviour (injected fetchImpl + sleep + now)
// ---------------------------------------------------------------------------

test("createLinearTransport: retries once on 400 top-level RATELIMITED then succeeds", async () => {
  const sleepDelays: number[] = [];
  let nowMs = 0;

  // First call: 400 with top-level RATELIMITED body
  // Second call: 200 with data
  let callCount = 0;
  const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
    callCount += 1;
    if (callCount === 1) {
      const body = JSON.stringify({ message: "RATELIMITED: slow down" });
      return new Response(body, { status: 400 });
    }
    const body = JSON.stringify({ data: { ok: true } });
    return new Response(body, { status: 200 });
  };

  const transport = createLinearTransport({
    token: "fake-token",
    endpoint: "https://fake.linear.app/graphql",
    fetchImpl: fakeFetch as typeof fetch,
    sleep: (ms: number) => {
      sleepDelays.push(ms);
      return Promise.resolve();
    },
    now: () => nowMs,
    maxRetries: 3,
  });

  const result = await transport("query { ok }", {});
  assert.deepEqual(result, { ok: true });
  assert.equal(callCount, 2);
  assert.equal(sleepDelays.length, 1);
  // Wait should be exponential throttle: 30000 * 2^0 = 30000
  assert.equal(sleepDelays[0], 30_000);
});

test("createLinearTransport: retries once on 400 GraphQL errors RATELIMITED then succeeds", async () => {
  const sleepDelays: number[] = [];
  let callCount = 0;
  const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
    callCount += 1;
    if (callCount === 1) {
      const body = JSON.stringify({
        errors: [
          {
            message: "Rate limit exceeded",
            extensions: { code: "RATELIMITED" },
          },
        ],
      });
      return new Response(body, {
        status: 400,
        headers: { "x-ratelimit-requests-reset": "1030" },
      });
    }
    const body = JSON.stringify({ data: { ok: true } });
    return new Response(body, { status: 200 });
  };

  const transport = createLinearTransport({
    token: "fake-token",
    endpoint: "https://fake.linear.app/graphql",
    fetchImpl: fakeFetch as typeof fetch,
    sleep: (ms: number) => {
      sleepDelays.push(ms);
      return Promise.resolve();
    },
    now: () => 1_000_000,
    maxRetries: 3,
  });

  const result = await transport("query { ok }", {});
  assert.deepEqual(result, { ok: true });
  assert.equal(callCount, 2);
  assert.deepEqual(sleepDelays, [30_000]);
});

test("createLinearTransport: retries Node fetch failures with transient cause codes", async () => {
  const sleepDelays: number[] = [];
  let callCount = 0;
  const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
    callCount += 1;
    if (callCount === 1) {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }
    const body = JSON.stringify({ data: { ok: true } });
    return new Response(body, { status: 200 });
  };

  const transport = createLinearTransport({
    token: "fake-token",
    endpoint: "https://fake.linear.app/graphql",
    fetchImpl: fakeFetch as typeof fetch,
    sleep: (ms: number) => {
      sleepDelays.push(ms);
      return Promise.resolve();
    },
    now: () => 1_000_000,
    maxRetries: 3,
  });

  const result = await transport("query { ok }", {});
  assert.deepEqual(result, { ok: true });
  assert.equal(callCount, 2);
  assert.deepEqual(sleepDelays, [2_000]);
});

test("createLinearTransport never retries a mutation after a transient network failure", async () => {
  let callCount = 0;
  const transport = createLinearTransport({
    token: "fake-token",
    endpoint: "https://fake.linear.app/graphql",
    fetchImpl: (async () => {
      callCount += 1;
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
    maxRetries: 3,
  });

  await assert.rejects(() => transport("mutation { commentCreate { success } }", {}));
  assert.equal(callCount, 1);
});

test("createLinearTransport: non-retryable error (validation) throws without retry", async () => {
  let callCount = 0;
  const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
    callCount += 1;
    const body = JSON.stringify({
      errors: [{ message: "Field 'foo' not found", extensions: { code: "VALIDATION_ERROR" } }],
    });
    return new Response(body, { status: 200 });
  };

  const transport = createLinearTransport({
    token: "fake-token",
    endpoint: "https://fake.linear.app/graphql",
    fetchImpl: fakeFetch as typeof fetch,
    sleep: () => Promise.resolve(),
    maxRetries: 3,
  });

  await assert.rejects(
    () => transport("query { foo }", {}),
    (err: unknown) => {
      assert.ok(err instanceof LinearRequestError);
      assert.match(err.message, /Field 'foo' not found/);
      return true;
    },
  );

  // Must only call once — validation error is not retryable
  assert.equal(callCount, 1);
});

// ---------------------------------------------------------------------------
// resolveLinearToken
// ---------------------------------------------------------------------------

test("resolveLinearToken: explicit token takes precedence", async () => {
  const { resolveLinearToken } = await import("../dist/linear/client.js");
  const token = resolveLinearToken({ token: "explicit-token", env: {} });
  assert.equal(token, "explicit-token");
});

test("resolveLinearToken: falls back to LINEAR_API_KEY env var", async () => {
  const { resolveLinearToken } = await import("../dist/linear/client.js");
  const token = resolveLinearToken({ env: { LINEAR_API_KEY: "env-key" } });
  assert.equal(token, "env-key");
});

test("resolveLinearToken: falls back to LINEAR_TOKEN env var", async () => {
  const { resolveLinearToken } = await import("../dist/linear/client.js");
  const token = resolveLinearToken({ env: { LINEAR_TOKEN: "token-fallback" } });
  assert.equal(token, "token-fallback");
});

test("resolveLinearToken: throws when no token available", async () => {
  const { resolveLinearToken } = await import("../dist/linear/client.js");
  assert.throws(() => resolveLinearToken({ env: {} }), /No Linear API token/);
});
