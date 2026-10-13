import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import worker from "../dashboard/worker.ts";
import type { DashboardEnv } from "../dashboard/dashboard-pages.ts";
import type { ReviewUsageDataPoint } from "../dashboard/review-usage.ts";

const SECRET = "review-usage-test-secret";
const PAYLOAD = {
  schema: 1,
  target_repo: "openclaw/openclaw",
  item_number: 42,
  item_kind: "pull_request",
  run_id: "12345678901234567890",
  run_attempt: 2,
  trigger_lane: "scheduled",
  service_tier: "priority",
  reasoning_effort: "high",
  outcome: "ok",
  duration_ms: 12500,
  usage: {
    input_tokens: 1000,
    cached_input_tokens: 200,
    cache_write_input_tokens: 50,
    output_tokens: 100,
    reasoning_output_tokens: 30,
  },
};

function fixture() {
  const points: ReviewUsageDataPoint[] = [];
  const env: DashboardEnv = {
    CLAWSWEEPER_WEBHOOK_SECRET: SECRET,
    REVIEW_USAGE: { writeDataPoint: (point) => points.push(point) },
    get EXACT_REVIEW_QUEUE() {
      throw new Error("Review usage must not access a Durable Object");
    },
    get STATUS_STORE() {
      throw new Error("Review usage must not access the status store");
    },
  };
  return { env, points };
}

function post(body: unknown, env: DashboardEnv, signingSecret = SECRET) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return worker.fetch(
    new Request("https://clawsweeper.test/internal/exact-review/review-usage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature":
          "sha256=" + createHmac("sha256", signingSecret).update(text).digest("hex"),
      },
      body: text,
    }),
    env,
  );
}

test("review usage rejects a bad HMAC before writing or accessing Durable Objects", async () => {
  const { env, points } = fixture();
  const response = await post(PAYLOAD, env, "wrong-secret");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_signature" });
  assert.deepEqual(points, []);
});

test("review usage validates JSON, bounded metadata, identity, and every counter strictly", async () => {
  const { env, points } = fixture();
  const invalid: unknown[] = [
    "{",
    null,
    [],
    { ...PAYLOAD, schema: 2 },
    { ...PAYLOAD, model: "must-not-be-recorded" },
    { ...PAYLOAD, target_repo: "openclaw" },
    { ...PAYLOAD, target_repo: "openclaw/repo/extra" },
    { ...PAYLOAD, target_repo: `${"a".repeat(40)}/repo` },
    { ...PAYLOAD, target_repo: `owner/${"a".repeat(101)}` },
    { ...PAYLOAD, target_repo: "owner/.." },
    { ...PAYLOAD, item_number: "42" },
    { ...PAYLOAD, item_number: 0 },
    { ...PAYLOAD, item_number: 1.5 },
    { ...PAYLOAD, item_kind: "pr" },
    { ...PAYLOAD, run_id: 123 },
    { ...PAYLOAD, run_id: "0" },
    { ...PAYLOAD, run_id: "1".repeat(33) },
    { ...PAYLOAD, run_attempt: 0 },
    { ...PAYLOAD, run_attempt: "2" },
    { ...PAYLOAD, trigger_lane: "a".repeat(65) },
    { ...PAYLOAD, trigger_lane: "line\nbreak" },
    { ...PAYLOAD, service_tier: "a".repeat(65) },
    { ...PAYLOAD, reasoning_effort: null },
    { ...PAYLOAD, reasoning_effort: "a".repeat(65) },
    { ...PAYLOAD, outcome: "success" },
    { ...PAYLOAD, duration_ms: -1 },
    { ...PAYLOAD, duration_ms: Number.MAX_SAFE_INTEGER + 1 },
    { ...PAYLOAD, usage: undefined },
    { ...PAYLOAD, usage: [] },
    { ...PAYLOAD, usage: {} },
    { ...PAYLOAD, usage: { ...PAYLOAD.usage, model: "must-not-be-recorded" } },
  ];
  for (const key of Object.keys(PAYLOAD.usage)) {
    for (const value of [-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      invalid.push({ ...PAYLOAD, usage: { ...PAYLOAD.usage, [key]: value } });
    }
    const missing: Record<string, number> = { ...PAYLOAD.usage };
    delete missing[key];
    invalid.push({ ...PAYLOAD, usage: missing });
  }
  for (const body of invalid) {
    const response = await post(body, env);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: "invalid_review_usage" });
  }
  assert.deepEqual(points, []);
});

test("review usage writes exactly one point with the stable Analytics Engine layout", async () => {
  const { env, points } = fixture();
  const response = await post(PAYLOAD, env);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(points, [
    {
      indexes: ["openclaw/openclaw"],
      blobs: [
        "openclaw/openclaw",
        "pull_request",
        "ok",
        "scheduled",
        "priority",
        "high",
        "12345678901234567890",
        "42",
      ],
      doubles: [1000, 200, 50, 100, 30, 12500, 1],
    },
  ]);
});

test("review usage distinguishes unavailable usage from measured zero and defaults optional labels", async () => {
  const { env, points } = fixture();
  const payload = {
    ...PAYLOAD,
    item_kind: "issue",
    trigger_lane: undefined,
    service_tier: "",
    reasoning_effort: undefined,
    outcome: "timeout",
    usage: null,
  };
  assert.equal((await post(payload, env)).status, 202);
  assert.deepEqual(points, [
    {
      indexes: ["openclaw/openclaw"],
      blobs: ["openclaw/openclaw", "issue", "timeout", "", "standard", "", PAYLOAD.run_id, "42"],
      doubles: [0, 0, 0, 0, 0, 12500, 0],
    },
  ]);
  assert.equal(
    (
      await post(
        {
          ...payload,
          outcome: "failed",
          usage: Object.fromEntries(Object.keys(PAYLOAD.usage).map((key) => [key, 0])),
        },
        env,
      )
    ).status,
    202,
  );
  assert.deepEqual(points[1]?.doubles, [0, 0, 0, 0, 0, 12500, 1]);
});

test("review usage reports an absent dataset without accessing Durable Objects", async () => {
  const { env, points } = fixture();
  delete env.REVIEW_USAGE;
  const response = await post(PAYLOAD, env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "review_usage_unconfigured" });
  assert.deepEqual(points, []);
});
