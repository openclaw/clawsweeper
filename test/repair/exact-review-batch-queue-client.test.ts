import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { ExactReviewBatchQueueClient } from "../../dist/repair/exact-review-batch-queue-client.js";

const now = Date.UTC(2026, 8, 2);
const payload = '{ "receipt_id": "stable-receipt", "outcome": "durable" }\n';
const heartbeat = {
  batchId: "batch-proof",
  leaseOwner: "worker-proof",
  leaseExpiresAt: new Date(now + 120_000).toISOString(),
  items: [],
};

function fixture(t, respond) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  t.mock.method(Math, "random", () => 0.5);
  const logs = [];
  t.mock.method(console, "warn", (line) => logs.push(line));
  const calls = [];
  const client = new ExactReviewBatchQueueClient({
    baseUrl: "https://queue.example.test",
    webhookSecret: "synthetic-test-secret",
    fetch: async (url, init) => {
      calls.push({ url, ...init, at: Date.now() });
      return respond(calls.length, init);
    },
  });
  return { client, calls, logs };
}

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

function unavailable(headers = {}) {
  return new Response("exact_review_queue_unavailable", { status: 500, headers });
}

test("post-effect HTTP 500 is attempted once", async (t) => {
  const { client, calls, logs } = fixture(t, () => unavailable());
  await assert.rejects(client.postEffect("router-receipt", payload), /HTTP 500/);
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, []);
});

test("post-effect network failure is attempted once", async (t) => {
  const { client, calls, logs } = fixture(t, () => {
    throw new TypeError("private network detail");
  });
  await assert.rejects(client.postEffect("enqueue", payload), /network_error/);
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, []);
});

for (const status of [400, 401, 403, 404, 409, 422, 429]) {
  test(`post-effect HTTP ${status} is never retried`, async (t) => {
    const { client, calls, logs } = fixture(t, () => new Response("private rejection", { status }));
    await assert.rejects(client.postEffect("enqueue", payload), new RegExp(`HTTP ${status}`));
    assert.equal(calls.length, 1);
    assert.deepEqual(logs, []);
  });
}

for (const status of [409, 500]) {
  test(`post-effect HTTP ${status} preserves the safe server error code`, async (t) => {
    const { client, calls } = fixture(t, () =>
      Response.json({ error: "exact_review_queue_unavailable" }, { status }),
    );
    const result = assert.rejects(client.postEffect("enqueue", payload), {
      message: `Batch queue /internal/exact-review/enqueue failed (HTTP ${status}): exact_review_queue_unavailable`,
    });
    await result;
    assert.equal(calls.length, 1);
  });
}

for (const [name, body] of [
  ["raw text", "private rejection"],
  ["URL", JSON.stringify({ error: "https://private.example.test/token" })],
  ["payload", JSON.stringify({ error: payload })],
  ["long code", JSON.stringify({ error: "a".repeat(65) })],
  ["non-string", JSON.stringify({ error: { private: "detail" } })],
  ["beyond bound", `${" ".repeat(512)}${JSON.stringify({ error: "private_tail" })}`],
]) {
  test(`post-effect omits ${name} from HTTP failure messages`, async (t) => {
    const { client } = fixture(t, () => new Response(body, { status: 409 }));
    await assert.rejects(client.postEffect("enqueue", payload), {
      message: "Batch queue /internal/exact-review/enqueue failed (HTTP 409)",
    });
  });
}

test("post-effect stops reading error bodies at 512 bytes and cancels the stream", async (t) => {
  let cancelled = false;
  const { client } = fixture(
    t,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(" ".repeat(512)));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 409 },
      ),
  );
  await assert.rejects(client.postEffect("enqueue", payload), {
    message: "Batch queue /internal/exact-review/enqueue failed (HTTP 409)",
  });
  assert.equal(cancelled, true);
});

test("heartbeat retries 500 with unchanged signed bytes and returns the renewed expiry", async (t) => {
  const batch = {
    batch_id: heartbeat.batchId,
    lease_owner: heartbeat.leaseOwner,
    lease_expires_at: new Date(now + 240_000).toISOString(),
    server_time: new Date(now).toISOString(),
    items: [],
  };
  const { client, calls } = fixture(t, (attempt) =>
    attempt === 1 ? unavailable() : Response.json({ batch }),
  );
  const result = client.heartbeat(heartbeat);
  await flush();
  t.mock.timers.tick(1_000);
  assert.equal((await result).leaseExpiresAt, batch.lease_expires_at);
  assert.equal((await result).serverTime, batch.server_time);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(calls[0].headers, calls[1].headers);
  assert.equal(
    calls[0].headers["x-clawsweeper-exact-review-signature"],
    `sha256=${createHmac("sha256", "synthetic-test-secret").update(calls[0].body).digest("hex")}`,
  );
  assert.equal(JSON.parse(calls[0].body).leaseExpiresAt, undefined);
});

test("heartbeat retry attempt aborts at the last confirmed lease expiry", async (t) => {
  const { client, calls } = fixture(t, (attempt, init) => {
    if (attempt === 1) return unavailable();
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
    );
  });
  const result = assert.rejects(
    client.heartbeat({ ...heartbeat, leaseExpiresAt: new Date(now + 2_000).toISOString() }),
    /timeout|deadline/i,
  );
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(1_000);
  await result;
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls.length, 2);
});

test("heartbeat backoff never crosses the last confirmed lease expiry", async (t) => {
  const { client, calls } = fixture(t, () => unavailable({ "retry-after": "10" }));
  const result = assert.rejects(
    client.heartbeat({ ...heartbeat, leaseExpiresAt: new Date(now + 500).toISOString() }),
    /HTTP 500/,
  );
  await flush();
  t.mock.timers.tick(500);
  await result;
  assert.equal(calls.length, 1);
});

test("heartbeat with an expired or invalid lease sends no request", async (t) => {
  const { client, calls } = fixture(t, () => Response.json({}));
  await assert.rejects(
    client.heartbeat({ ...heartbeat, leaseExpiresAt: new Date(now).toISOString() }),
    /deadline|expired/i,
  );
  await assert.rejects(client.heartbeat({ ...heartbeat, leaseExpiresAt: "invalid" }), /expiry/i);
  assert.equal(calls.length, 0);
});
