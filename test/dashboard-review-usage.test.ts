import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
    for (const value of [
      -1,
      0.5,
      "1",
      ...(key === "cache_write_input_tokens" ? [] : [null]),
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
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
      doubles: [1000, 200, 50, 100, 30, 12500, 1, 1],
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
      doubles: [0, 0, 0, 0, 0, 12500, 0, 0],
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
  assert.deepEqual(points[1]?.doubles, [0, 0, 0, 0, 0, 12500, 1, 1]);
});

test("partial usage records measured core counters without claiming a cache-write zero", async () => {
  const { env, points } = fixture();
  assert.equal(
    (
      await post(
        {
          ...PAYLOAD,
          usage: { ...PAYLOAD.usage, cache_write_input_tokens: null },
        },
        env,
      )
    ).status,
    202,
  );
  assert.deepEqual(points[0]?.doubles, [1000, 200, 0, 100, 30, 12500, 0, 1]);
});

test("documented SQL weights full, partial, missing, and legacy usage cohorts", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE clawsweeper_review_usage (
      timestamp TEXT, blob1 TEXT, blob4 TEXT, _sample_interval REAL,
      double1 REAL, double2 REAL, double3 REAL, double4 REAL,
      double5 REAL, double6 REAL, double7 REAL, double8 REAL
    )`);
    const insert = database.prepare(
      "INSERT INTO clawsweeper_review_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Old complete rows lack double8. Measured zeros still belong in the denominator.
    for (const [lane, weight, counters] of [
      ["review", 2, [1000, 200, 50, 100, 30, 20, 1, 0]],
      ["review", 3, [1000, 200, 0, 100, 30, 30, 0, 1]],
      ["missing", 5, [0, 0, 0, 0, 0, 40, 0, 0]],
      ["review", 7, [0, 0, 0, 0, 0, 50, 1, 1]],
    ] as const)
      insert.run("2026-10-14", "owner/repo", lane, weight, ...counters);
    const documentation = readFileSync(
      new URL("../docs/live-dashboard.md", import.meta.url),
      "utf8",
    );
    const queries = [...documentation.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!);
    const execute = (query: string) =>
      database
        .prepare(
          query
            // Only adapt engine-specific time/percentile syntax; execute the documented cohort arithmetic.
            .replace("toStartOfInterval(timestamp, INTERVAL '1' DAY)", "timestamp")
            .replace("NOW() - INTERVAL '30' DAY", "'2026-10-01'")
            .replaceAll(
              /quantileExactWeighted\(0\.(?:50|95)\)\(double6, _sample_interval\)/g,
              "NULL",
            )
            .replaceAll("if(", "iif("),
        )
        .all();
    const daily = queries.find((query) => query.includes("AS full_usage_estimated_usd"));
    const averages = queries.find((query) => query.includes("AS avg_input_tokens"));
    assert.ok(daily && averages);
    assert.deepEqual(
      { ...execute(daily)[0] },
      {
        day: "2026-10-14",
        repo: "owner/repo",
        reviews: 17,
        reviews_with_full_usage: 9,
        reviews_with_partial_usage: 3,
        reviews_without_usage: 5,
        input_tokens: 5000,
        cached_input_tokens: 1000,
        known_cache_write_input_tokens: 100,
        output_tokens: 500,
        reasoning_output_tokens: 150,
        full_usage_estimated_usd: 0.00529,
      },
    );
    assert.deepEqual(
      execute(averages).map((row) => ({ ...row })),
      [
        {
          repo: "owner/repo",
          lane: "review",
          reviews: 12,
          reviews_with_core_usage: 12,
          duration_p50_ms: null,
          duration_p95_ms: null,
          avg_input_tokens: 5000 / 12,
          avg_output_tokens: 500 / 12,
          avg_total_tokens: 5500 / 12,
        },
      ],
    );
  } finally {
    database.close();
  }
});

test("review usage reports an absent dataset without accessing Durable Objects", async () => {
  const { env, points } = fixture();
  delete env.REVIEW_USAGE;
  const response = await post(PAYLOAD, env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "review_usage_unconfigured" });
  assert.deepEqual(points, []);
});
