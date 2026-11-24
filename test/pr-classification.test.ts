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
  headSha: "b".repeat(40),
  baseSha: "a".repeat(40),
  diff: "src/start.ts\n@@ -1 +1 @@\n-crash();\n+start();",
};
const classification = { priority: "P1", impact: ["impact:crash-loop"] };
const tool = {
  type: "function_call",
  name: "read_file",
  call_id: "call_1",
  arguments: JSON.stringify({ path: "src/start.ts", revision: "head", start_line: 1 }),
};
const answer = {
  type: "message",
  content: [{ type: "output_text", text: JSON.stringify(classification) }],
};
const response = (output: unknown[], usage = { input_tokens: 100, output_tokens: 20 }) =>
  Response.json({ status: "completed", output, usage });
const defaults = () => ({
  packet,
  cwd: process.cwd(),
  apiKey: "synthetic",
  recordAttempt() {},
  readTool() {
    return JSON.stringify({ text: "1:start();" });
  },
});

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
test("packet requires pinned source and includes diff in digest with finite byte budget", () => {
  const request = prClassificationRequest({ ...packet, secret: "not sent" } as typeof packet);
  assert.deepEqual(JSON.parse(request.input), packet);
  assert.notEqual(
    request.digest,
    prClassificationRequest({ ...packet, diff: packet.diff + "changed" }).digest,
  );
  assert.throws(
    () => prClassificationRequest({ ...packet, body: "x".repeat(180000) }),
    /byte budget/,
  );
  for (const bad of [{ diff: "" }, { headSha: "branch" }, { baseSha: "" }, { number: 0 }])
    assert.throws(() => prClassificationRequest({ ...packet, ...bad }), /Invalid/);
});
test("diff plus mandatory context tool, no storage, bounded output and aggregate multi-turn usage", async (t) => {
  useFakeScanner(t);
  let calls = 0,
    attempts = 0,
    tools = 0;
  const result = await classifyPullRequest({
    ...defaults(),
    recordAttempt() {
      attempts++;
    },
    readTool(name, args) {
      tools++;
      assert.equal(name, "read_file");
      assert.deepEqual(args, JSON.parse(tool.arguments));
      return "source-context";
    },
    fetch: async (url, init) => {
      calls++;
      assert.equal(attempts, calls);
      assert.equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, PR_CLASSIFICATION_MODEL);
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, 1536);
      assert.equal(body.parallel_tool_calls, false);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.tools.length, 2);
      assert.deepEqual(JSON.parse(body.input[0].content), packet);
      if (calls === 1) {
        assert.equal(body.tool_choice, "required");
        return response([tool]);
      }
      assert.equal(body.input.at(-1).type, "function_call_output");
      assert.equal(body.input.at(-1).output, "source-context");
      return response([answer], { input_tokens: 180, output_tokens: 12 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(tools, 1);
  assert.equal(result.outcome, "classified");
  assert.deepEqual(result.classification, classification);
  assert.deepEqual(result.usage, { inputTokens: 280, outputTokens: 32 });
});
test("cannot classify from metadata or patch without reading source", async (t) => {
  useFakeScanner(t);
  assert.equal(
    (await classifyPullRequest({ ...defaults(), fetch: async () => response([answer]) })).outcome,
    "invalid",
  );
});
test("at most three tool calls and four model requests, final turn disables tools", async (t) => {
  useFakeScanner(t);
  let calls = 0,
    tools = 0;
  const result = await classifyPullRequest({
    ...defaults(),
    readTool() {
      tools++;
      return "context";
    },
    fetch: async (_url, init) => {
      calls++;
      assert.equal(
        JSON.parse(String(init?.body)).tool_choice,
        calls === 1 ? "required" : calls === 4 ? "none" : "auto",
      );
      return response([{ ...tool, call_id: "call_" + calls }]);
    },
  });
  assert.equal(result.outcome, "invalid");
  assert.equal(calls, 4);
  assert.equal(tools, 3);
  assert.deepEqual(result.usage, { inputTokens: 400, outputTokens: 80 });
});
for (const [name, output] of [
  ["arbitrary tool", [{ ...tool, name: "shell" }]],
  ["parallel calls", [tool, tool]],
  ["invalid arguments", [{ ...tool, arguments: "not json" }]],
] as const) {
  test(name + " abstains without executing", async (t) => {
    useFakeScanner(t);
    let tools = 0;
    const result = await classifyPullRequest({
      ...defaults(),
      readTool() {
        tools++;
        return "";
      },
      fetch: async () => response([...output]),
    });
    assert.equal(tools, 0);
    assert.notEqual(result.outcome, "classified");
  });
}
test("tool errors fail closed and retain spend", async (t) => {
  useFakeScanner(t);
  const result = await classifyPullRequest({
    ...defaults(),
    readTool() {
      throw Error("missing file");
    },
    fetch: async () => response([tool]),
  });
  assert.equal(result.outcome, "unavailable");
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
});
test("oversized tool output is not sent", async (t) => {
  useFakeScanner(t);
  let calls = 0;
  const result = await classifyPullRequest({
    ...defaults(),
    readTool() {
      return "x".repeat(16001);
    },
    fetch: async () => {
      calls++;
      return response([tool]);
    },
  });
  assert.equal(result.outcome, "invalid");
  assert.equal(calls, 1);
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
    "malformed answer",
    { status: "completed", output: [{ content: [{ type: "output_text", text: "not json" }] }] },
    "invalid",
  ],
] as const) {
  test("abstains on " + name, async (t) => {
    useFakeScanner(t);
    let calls = 0;
    const result = await classifyPullRequest({
      ...defaults(),
      fetch: async () =>
        ++calls === 1
          ? response([tool])
          : Response.json({ ...body, usage: { input_tokens: 100, output_tokens: 20 } }),
    });
    assert.equal(result.outcome, outcome);
    assert.equal(result.classification, null);
  });
}
test("missing key never spends and provider errors do not retry", async (t) => {
  useFakeScanner(t);
  let calls = 0;
  const options = {
    ...defaults(),
    apiKey: "",
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
test("scanner refusal never dispatches", async (t) => {
  useFakeScanner(t, "process.exit(1);");
  let attempts = 0;
  await assert.rejects(
    classifyPullRequest({
      ...defaults(),
      recordAttempt() {
        attempts++;
      },
      fetch: async () => {
        throw Error("must not dispatch");
      },
    }),
    /scan refused/,
  );
  assert.equal(attempts, 0);
});
test("scanner scans tool content before follow-up spend", async (t) => {
  useFakeScanner(
    t,
    "if(inputs.some(x=>x.bytes.toString('utf8').includes('tool-secret-marker')))process.exit(1);",
  );
  let calls = 0;
  await assert.rejects(
    classifyPullRequest({
      ...defaults(),
      readTool() {
        return "tool-secret-marker";
      },
      fetch: async () => {
        calls++;
        return response([tool]);
      },
    }),
    /scan refused/,
  );
  assert.equal(calls, 1);
});
test("oversized response abstains without retry", async (t) => {
  useFakeScanner(t);
  let calls = 0;
  const result = await classifyPullRequest({
    ...defaults(),
    fetch: async () => {
      calls++;
      return new Response("x".repeat(32001));
    },
  });
  assert.equal(result.outcome, "invalid");
  assert.equal(calls, 1);
});
