import assert from "node:assert/strict";
import test from "node:test";
import {
  intakeRequest,
  intakeLabels,
  parseIntakeAnswers,
  INTAKE_POLICY,
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
    recordAttempt: async () => {
      await Promise.resolve();
      calls.push("intent");
    },
    fetch: async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.redirect, "error");
      assert.equal(JSON.parse(String(init?.body)).tools, undefined);
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
