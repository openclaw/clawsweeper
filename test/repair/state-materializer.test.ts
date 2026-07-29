import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  DEFAULT_STATE_MATERIALIZER_MAX_BYTES,
  DEFAULT_STATE_MATERIALIZER_MAX_ROWS,
  runStateMaterializer,
} from "../../dist/repair/state-materializer.js";

const secret = "state-window-compactor-test-secret";

test("state window compactor requires its signed Worker boundary", async () => {
  assert.deepEqual(await runStateMaterializer({ env: {} }), {
    drained: 0,
    acked: 0,
    errors: 1,
  });
});

test("state window compactor drains and acknowledges without projecting files", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let drain = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const bodyText = String(init?.body ?? "");
    const signature = `sha256=${createHmac("sha256", secret).update(bodyText).digest("hex")}`;
    assert.equal(new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"), signature);
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/drain")) {
      drain += 1;
      return Response.json(
        drain === 1
          ? {
              ok: true,
              drain_token: "window-1",
              records: [
                { kind: "record_tuple", payload: { legacy: true } },
                { kind: "apply_proof", payload: { legacy: true } },
              ],
            }
          : { ok: true, drain_token: null, records: [] },
      );
    }
    assert.equal(url.pathname.endsWith("/ack"), true);
    return Response.json({ ok: true, acked: 2 });
  }) as typeof fetch;

  const summary = await runStateMaterializer({
    env: { QUEUE_URL: "https://queue.test", CLAWSWEEPER_WEBHOOK_SECRET: secret },
    fetchImpl,
  });

  assert.deepEqual(summary, { drained: 2, acked: 2, errors: 0 });
  assert.deepEqual(requests, [
    {
      path: "/internal/state/drain",
      body: {
        max_rows: DEFAULT_STATE_MATERIALIZER_MAX_ROWS,
        max_bytes: DEFAULT_STATE_MATERIALIZER_MAX_BYTES,
      },
    },
    { path: "/internal/state/ack", body: { drain_token: "window-1" } },
    {
      path: "/internal/state/drain",
      body: {
        max_rows: DEFAULT_STATE_MATERIALIZER_MAX_ROWS,
        max_bytes: DEFAULT_STATE_MATERIALIZER_MAX_BYTES,
      },
    },
  ]);
});

test("state window compactor leaves a failed window for redelivery", async () => {
  let calls = 0;
  const summary = await runStateMaterializer({
    env: { QUEUE_URL: "https://queue.test", CLAWSWEEPER_WEBHOOK_SECRET: secret },
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ ok: true, drain_token: "window-1", records: [{}] });
      }
      return Response.json({ error: "unavailable" }, { status: 503 });
    }) as typeof fetch,
  });
  assert.deepEqual(summary, { drained: 1, acked: 0, errors: 1 });
  assert.equal(calls, 2);
});

test("state window compactor honors configured bounds", async () => {
  let requestBody: unknown;
  await runStateMaterializer({
    env: {
      QUEUE_URL: "https://queue.test",
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      CLAWSWEEPER_STATE_MATERIALIZER_MAX_ROWS: "17",
      CLAWSWEEPER_STATE_MATERIALIZER_MAX_BYTES: "4096",
    },
    fetchImpl: (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ ok: true, drain_token: null, records: [] });
    }) as typeof fetch,
  });
  assert.deepEqual(requestBody, { max_rows: 17, max_bytes: 4096 });
});
