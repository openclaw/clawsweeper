import assert from "node:assert/strict";
import test from "node:test";
import {
  intakeRequest,
  intakeLabels,
  parseIntakeAnswers,
  INTAKE_POLICY,
  INTAKE_TIMEOUT_MS,
} from "../dist/intake-triage-contract.js";
import { runResponsesIntake } from "../dist/intake-triage-api.js";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";

test("intake has a bounded, policy-bound identity and refuses truncation", () => {
  const packet = {
    repository: "openclaw/openclaw",
    number: 42,
    kind: "issue" as const,
    title: "Crash",
    body: "On launch",
  };
  assert.equal(intakeRequest(packet).digest, intakeRequest({ ...packet }).digest);
  assert.notEqual(
    intakeRequest(packet).digest,
    intakeRequest({ ...packet, body: "On exit" }).digest,
  );
  const extended = { ...packet, comments: "private comment", source: "source content" };
  assert.equal(intakeRequest(extended).input, intakeRequest(packet).input);
  const prepared = intakeRequest(packet);
  packet.body = "Changed later";
  assert.equal(prepared.packet.body, "On launch");
  assert.throws(() => intakeRequest({ ...packet, body: "x".repeat(12_000) }), /byte budget/);
});

test("ordinary Responses works without Decisions and records intent before sending", async (t) => {
  useFakeScanner(t);
  const calls: string[] = [];
  const request = intakeRequest({
    repository: "openclaw/openclaw",
    number: 42,
    kind: "issue",
    title: "Crash",
    body: "On launch",
  });
  const answers = { category: "bug", reproduction: "present", environment: "missing" };
  const result = await runResponsesIntake({
    cwd: process.cwd(),
    apiKey: "synthetic-key",
    request,
    model: "fixture-responses-model",
    recordAttempt: async () => {
      await Promise.resolve();
      calls.push("intent");
    },
    fetch: async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.redirect, "error");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.tools, undefined);
      assert.equal(payload.model, "fixture-responses-model");
      return Response.json({
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: JSON.stringify(answers) }] },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    },
  });
  assert.deepEqual(calls, ["intent", "https://api.openai.com/v1/responses"]);
  assert.equal(result.outcome, "classified");
  assert.deepEqual(result.answers, answers);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
});

test("missing credentials, refused and oversized outputs never become classifications", async (t) => {
  useFakeScanner(t);
  const request = intakeRequest({
    repository: "openclaw/openclaw",
    number: 42,
    kind: "issue",
    title: "Crash",
    body: "",
  });
  const options = { cwd: process.cwd(), apiKey: "", request, recordAttempt: () => {} };
  assert.equal(
    (
      await runResponsesIntake({
        ...options,
        fetch: async () => {
          throw Error("must not send");
        },
      })
    ).outcome,
    "unavailable",
  );
  for (const [body, expected] of [
    [{ status: "completed", output: [{ content: [{ type: "refusal" }] }] }, "refused"],
    [{ status: "incomplete", output: [] }, "invalid"],
    [{ padding: "x".repeat(33_000) }, "invalid"],
  ] as const) {
    assert.equal(
      (
        await runResponsesIntake({
          ...options,
          apiKey: "synthetic-key",
          fetch: async () => Response.json(body),
        })
      ).outcome,
      expected,
    );
  }
});

test("a ledger failure prevents spend", async (t) => {
  useFakeScanner(t);
  const request = intakeRequest({
    repository: "openclaw/openclaw",
    number: 42,
    kind: "issue",
    title: "Crash",
    body: "",
  });
  let called = false;
  await assert.rejects(
    runResponsesIntake({
      cwd: process.cwd(),
      apiKey: "synthetic-key",
      request,
      recordAttempt: async () => {
        await Promise.resolve();
        throw Error("ledger unavailable");
      },
      fetch: async () => {
        called = true;
        return Response.json({});
      },
    }),
    /ledger unavailable/,
  );
  assert.equal(called, false);
});

test("intake rejects extra authority and only yields provisional submission labels", () => {
  const answers = { category: "bug", reproduction: "missing", environment: "missing" };
  assert.equal(parseIntakeAnswers({ ...answers, goodFirstIssue: true }), null);
  assert.equal(parseIntakeAnswers({ ...answers, category: "verified" }), null);
  const result = {
    policy: INTAKE_POLICY,
    digest: "abc",
    backend: "responses" as const,
    outcome: "classified" as const,
    answers,
    usage: null,
    durationMs: 1,
  };
  assert.deepEqual(intakeLabels(result), [
    "clawsweeper:intake:bug",
    "clawsweeper:intake:needs-repro",
    "clawsweeper:intake:needs-environment",
  ]);
  assert.deepEqual(intakeLabels({ ...result, outcome: "refused" }), []);
  assert.deepEqual(intakeLabels({ ...result, answers: { ...answers, category: "support" } }), [
    "clawsweeper:intake:support",
  ]);
});

test("scanner refusal prevents both ledger recording and provider dispatch", async (t) => {
  useFakeScanner(t, "process.exit(2);");
  const request = intakeRequest({
    repository: "openclaw/openclaw",
    number: 42,
    kind: "issue",
    title: "Crash",
    body: "",
  });
  let touched = false;
  await assert.rejects(
    runResponsesIntake({
      cwd: process.cwd(),
      apiKey: "synthetic-key",
      request,
      recordAttempt: () => {
        touched = true;
      },
      fetch: async () => {
        touched = true;
        return Response.json({});
      },
    }),
  );
  assert.equal(touched, false);
});

test("raw submission boundaries are scanned alongside the exact outgoing payload", async (t) => {
  useFakeScanner(
    t,
    `
const serialized = inputs.find(input => input.name === 'prompt').bytes.toString();
assert.equal(JSON.parse(serialized).input, JSON.stringify({repository:'openclaw/openclaw',number:42,kind:'issue',title:'Crash',body:'Details\\nfixture-secret-marker'}));
assert.ok(inputs.some(input => /\\bfixture-secret-marker\\b/.test(input.bytes.toString())));
assert.ok(inputs.some(input => input.bytes.toString() === 'Crash'));
`,
  );
  let touched = false;
  const result = await runResponsesIntake({
    cwd: process.cwd(),
    apiKey: "synthetic-key",
    request: intakeRequest({
      repository: "openclaw/openclaw",
      number: 42,
      kind: "issue",
      title: "Crash",
      body: "Details\nfixture-secret-marker",
    }),
    recordAttempt: () => {
      touched = true;
    },
    fetch: async () => {
      touched = true;
      return Response.json({});
    },
  });
  assert.equal(result.outcome, "invalid");
  assert.equal(touched, true);
});

test(
  "the intake deadline bounds intent recording and never dispatches after expiry",
  { timeout: 5_000 },
  async (t) => {
    useFakeScanner(t);
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    let finishRecording!: () => void;
    const recording = new Promise<void>((resolve) => {
      finishRecording = resolve;
    });
    let called = false;
    const pending = runResponsesIntake({
      cwd: process.cwd(),
      apiKey: "synthetic-key",
      request: intakeRequest({
        repository: "openclaw/openclaw",
        number: 42,
        kind: "issue",
        title: "Crash",
        body: "",
      }),
      recordAttempt: () => {
        t.mock.timers.tick(5_000);
        return recording;
      },
      fetch: async () => {
        called = true;
        return Response.json({});
      },
    });
    t.mock.timers.tick(INTAKE_TIMEOUT_MS - 5_000);
    assert.equal((await pending).outcome, "timeout");
    finishRecording();
    await Promise.resolve();
    assert.equal(called, false);
  },
);
