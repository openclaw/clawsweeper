import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPullRequest,
  parsePrClassification,
  prClassificationRequest,
  PR_CLASSIFICATION_MODEL,
} from "../dist/pr-classification.js";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";

const packet = {
  repository: "openclaw/openclaw",
  number: 42,
  title: "Fix startup crash",
  body: "The app crashes on startup.",
};
const classification = { priority: "P1", impact: ["impact:crash-loop"] };

test("classification accepts only finite priority and impact labels", () => {
  assert.deepEqual(parsePrClassification(classification), classification);
  for (const value of [
    null,
    {},
    { ...classification, priority: "P4" },
    { ...classification, impact: ["maintainer"] },
    { ...classification, impact: ["impact:other", "impact:other"] },
    { ...classification, review: "approved" },
  ])
    assert.equal(parsePrClassification(value), null);
  assert.ok(parsePrClassification({ priority: "unclear", impact: [] }));
});

test("packet has a finite byte budget and excludes extra fields", () => {
  const request = prClassificationRequest({ ...packet, secret: "not sent" } as typeof packet);
  assert.deepEqual(JSON.parse(request.input), packet);
  assert.equal(request.digest, prClassificationRequest(packet).digest);
  assert.notEqual(request.digest, prClassificationRequest({ ...packet, title: "changed" }).digest);
  assert.throws(
    () => prClassificationRequest({ ...packet, body: "x".repeat(12_000) }),
    /byte budget/,
  );
  assert.throws(() => prClassificationRequest({ ...packet, number: 0 }), /Invalid/);
});

test("one native request: scanned metadata, no tools, no storage, bounded output and usage", async (t) => {
  useFakeScanner(t);
  const cwd = process.cwd();
  let attempts = 0;
  let calls = 0;
  const result = await classifyPullRequest({
    packet,
    cwd,
    apiKey: "synthetic",
    recordAttempt: () => {
      attempts++;
    },
    fetch: async (url, init) => {
      calls++;
      assert.equal(attempts, 1);
      assert.equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, PR_CLASSIFICATION_MODEL);
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      assert.equal(body.max_output_tokens, 256);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.schema.additionalProperties, false);
      assert.deepEqual(JSON.parse(body.input), packet);
      return Response.json({
        status: "completed",
        output: [{ content: [{ type: "output_text", text: JSON.stringify(classification) }] }],
        usage: { input_tokens: 110, output_tokens: 15 },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome, "classified");
  assert.deepEqual(result.classification, classification);
  assert.deepEqual(result.usage, { inputTokens: 110, outputTokens: 15 });
});

for (const [name, body, outcome] of [
  ["refusal", { status: "completed", output: [{ content: [{ type: "refusal" }] }] }, "refused"],
  ["incomplete", { status: "incomplete", output: [] }, "invalid"],
  [
    "unknown label",
    {
      status: "completed",
      output: [{ content: [{ type: "output_text", text: '{"priority":"P9","impact":[]}' }] }],
    },
    "invalid",
  ],
  [
    "malformed classification",
    { status: "completed", output: [{ content: [{ type: "output_text", text: "not json" }] }] },
    "invalid",
  ],
] as const) {
  test("abstains on " + name, async (t) => {
    const result = await classifyPullRequest({
      packet,
      cwd: (useFakeScanner(t), process.cwd()),
      apiKey: "synthetic",
      recordAttempt() {},
      fetch: async () => Response.json(body),
    });
    assert.equal(result.outcome, outcome);
    assert.equal(result.classification, null);
  });
}

test("missing key does not scan or spend; provider errors are not retried", async (t) => {
  let calls = 0;
  const options = {
    packet,
    cwd: (useFakeScanner(t), process.cwd()),
    apiKey: "",
    recordAttempt() {},
    fetch: async () => {
      calls++;
      return new Response(null, { status: 429 });
    },
  };
  assert.equal((await classifyPullRequest(options)).outcome, "unavailable");
  assert.equal(calls, 0);
  assert.equal(
    (await classifyPullRequest({ ...options, apiKey: "synthetic" })).outcome,
    "unavailable",
  );
  assert.equal(calls, 1);
});

test("scanner refusal never sends a request or paid intent", async (t) => {
  useFakeScanner(t, "process.exit(1);");
  let attempts = 0;
  await assert.rejects(
    classifyPullRequest({
      packet,
      cwd: process.cwd(),
      apiKey: "synthetic",
      recordAttempt: () => {
        attempts++;
      },
      fetch: async () => {
        throw new Error("must not dispatch");
      },
    }),
    /scan refused/,
  );
  assert.equal(attempts, 0);
});

test("oversized response abstains without retry", async (t) => {
  useFakeScanner(t);
  let calls = 0;
  const result = await classifyPullRequest({
    packet,
    cwd: process.cwd(),
    apiKey: "synthetic",
    recordAttempt() {},
    fetch: async () => {
      calls++;
      return new Response("x".repeat(32_001));
    },
  });
  assert.equal(result.outcome, "invalid");
  assert.equal(calls, 1);
});
