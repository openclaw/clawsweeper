import assert from "node:assert/strict";
import test from "node:test";
import { runDecisionsIntake } from "../dist/intake-triage-decisions.js";
import { INTAKE_QUESTIONS, intakeRequest } from "../dist/intake-triage-contract.js";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";

const request = intakeRequest({
  repository: "openclaw/openclaw",
  number: 42,
  kind: "issue",
  title: "Crash",
  body: "On launch",
});
function fixture() {
  return {
    answers: INTAKE_QUESTIONS.map((q) => ({
      type: "choice",
      name: q.name,
      choice: q.choices[0].value,
      confidence: 1,
      probabilities: q.choices.map((c, index) => ({
        value: c.value,
        probability: index === 0 ? 1 : 0,
      })),
    })),
    usage: { input_tokens: 100, output_tokens: 0 },
  };
}

test("Decisions uses the shared bounded questions and preserves native distributions", async (t) => {
  useFakeScanner(t);
  let recorded = false;
  const result = await runDecisionsIntake({
    cwd: process.cwd(),
    apiKey: "synthetic-key",
    request,
    recordAttempt: () => {
      recorded = true;
    },
    fetch: async (url, options) => {
      assert.equal(recorded, true);
      assert.equal(String(url), "https://api.openai.com/v1/decisions");
      const payload = JSON.parse(String(options?.body));
      assert.equal(payload.input, request.input);
      assert.equal(payload.questions.length, 3);
      assert.equal(payload.tools, undefined);
      assert.equal(payload.questions[0].type, "choice");
      return Response.json(fixture());
    },
  });
  assert.equal(result.outcome, "classified");
  assert.equal(result.answers?.category, "bug");
  assert.equal(result.decisionProbabilities?.category.bug, 1);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 0 });
});

test("Decisions refuses partial, duplicated, invented and malformed native answers", async (t) => {
  useFakeScanner(t);
  const valid = fixture();
  const cases: unknown[] = [
    { answers: valid.answers.slice(1) },
    { answers: [valid.answers[0], valid.answers[0], valid.answers[2]] },
    { answers: valid.answers.map((a) => ({ ...a, choice: "verified" })) },
    { answers: valid.answers.map((a) => ({ ...a, confidence: 2 })) },
    {
      answers: valid.answers.map((a) => ({
        ...a,
        probabilities: [{ value: a.choice, probability: 1 }],
      })),
    },
    {
      answers: valid.answers.map((a) => ({
        ...a,
        probabilities: a.probabilities.map((p) => ({ ...p, probability: 0 })),
      })),
    },
  ];
  for (const body of cases) {
    const result = await runDecisionsIntake({
      cwd: process.cwd(),
      apiKey: "synthetic-key",
      request,
      recordAttempt: () => {},
      fetch: async () => Response.json(body),
    });
    assert.equal(result.outcome, "invalid");
    assert.equal(result.answers, null);
  }
  const refusal = await runDecisionsIntake({
    cwd: process.cwd(),
    apiKey: "synthetic-key",
    request,
    recordAttempt: () => {},
    fetch: async () => Response.json({ answers: [{ type: "refusal", name: "category" }] }),
  });
  assert.equal(refusal.outcome, "refused");
});
