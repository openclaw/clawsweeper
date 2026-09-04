import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBooleanCountArtifact,
  assertMatchesJsonSchema,
  runWithWithheldDiagnostics,
  summarizeHostedReviewTrace,
} from "../scripts/hosted-review-canary-proof.mjs";

test("hosted review trace proves a command round before the final review", () => {
  const marker = "9ccfabf3-8158-437d-a168-173ee10d102a";
  const expectedCommand = "git diff --no-ext-diff --unified=0 base head -- review-fixture.js";
  const finalDecisionText = JSON.stringify({
    summary: `Hosted review canary observed marker ${marker}.`,
  });
  const jsonl = [
    { type: "thread.started", thread_id: "private-thread" },
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: "private-command",
        type: "command_execution",
        command: `/bin/bash -lc "${expectedCommand}"`,
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "private-command",
        type: "command_execution",
        command: `/bin/bash -lc "${expectedCommand}"`,
        aggregated_output: `private output ${marker}`,
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: { id: "private-message", type: "agent_message", text: finalDecisionText },
    },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  const proof = summarizeHostedReviewTrace({
    jsonl,
    marker,
    expectedCommand,
    finalDecisionText,
    checkoutUnchanged: true,
  });
  assert.deepEqual(proof, {
    eventCount: 6,
    toolAttemptCount: 1,
    completedToolCount: 1,
    fixtureToolCount: 1,
    reviewAfterToolCount: 1,
    terminalTurnCount: 1,
    checkoutUnchanged: true,
  });
  assertBooleanCountArtifact(proof);
  const published = JSON.stringify(proof);
  assert.doesNotMatch(published, /private|9ccfabf3|command":|output|prompt|transcript/i);
});

test("hosted review trace rejects a final review emitted before its tool result", () => {
  const marker = "0fcb2fea-c4f8-4c7e-9fc9-f854f66b7e15";
  const expectedCommand = "git diff --no-ext-diff --unified=0 base head -- review-fixture.js";
  const finalDecisionText = JSON.stringify({
    summary: `Hosted review canary observed marker ${marker}.`,
  });
  const jsonl = [
    {
      type: "item.completed",
      item: { type: "agent_message", text: finalDecisionText },
    },
    {
      type: "item.completed",
      item: {
        id: "expected-command",
        type: "command_execution",
        command: `/bin/bash -c '${expectedCommand}'`,
        aggregated_output: marker,
        exit_code: 0,
        status: "completed",
      },
    },
    { type: "turn.completed", usage: {} },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  assert.throws(
    () =>
      summarizeHostedReviewTrace({
        jsonl,
        marker,
        expectedCommand,
        finalDecisionText,
        checkoutUnchanged: true,
      }),
    /final review was not emitted after the command/,
  );
});

test("hosted review trace rejects a different marker-emitting command", () => {
  const marker = "73c2d862-ff1a-4681-b2df-204dd24a26e5";
  const expectedCommand = "git diff --no-ext-diff --unified=0 base head -- review-fixture.js";
  const finalDecisionText = JSON.stringify({
    summary: `Hosted review canary observed marker ${marker}.`,
  });
  const jsonl = [
    {
      type: "item.completed",
      item: {
        id: "different-command",
        type: "command_execution",
        command: "/bin/bash -lc 'cat review-fixture.js'",
        aggregated_output: marker,
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: { type: "agent_message", text: finalDecisionText },
    },
    { type: "turn.completed", usage: {} },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  assert.throws(
    () =>
      summarizeHostedReviewTrace({
        jsonl,
        marker,
        expectedCommand,
        finalDecisionText,
        checkoutUnchanged: true,
      }),
    /command did not match the required diff inspection/,
  );
});

test("hosted review trace rejects an additional failed command attempt", () => {
  const marker = "cb32ac71-5dfc-4258-a2bb-26e99857cc34";
  const expectedCommand = "git diff --no-ext-diff --unified=0 base head -- review-fixture.js";
  const finalDecisionText = JSON.stringify({
    summary: `Hosted review canary observed marker ${marker}.`,
  });
  const jsonl = [
    {
      type: "item.completed",
      item: {
        id: "failed-command",
        type: "command_execution",
        command: "/bin/bash -lc 'cat missing'",
        aggregated_output: "",
        exit_code: 1,
        status: "failed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "expected-command",
        type: "command_execution",
        command: `/bin/bash -lc '${expectedCommand}'`,
        aggregated_output: marker,
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: { type: "agent_message", text: finalDecisionText },
    },
    { type: "turn.completed", usage: {} },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  assert.throws(
    () =>
      summarizeHostedReviewTrace({
        jsonl,
        marker,
        expectedCommand,
        finalDecisionText,
        checkoutUnchanged: true,
      }),
    /must attempt exactly one review tool/,
  );
});

test("hosted review trace rejects an additional non-command tool attempt", () => {
  const marker = "6cf142b3-e43a-4dc7-a0c4-acaa99de4818";
  const expectedCommand = "git diff --no-ext-diff --unified=0 base head -- review-fixture.js";
  const finalDecisionText = JSON.stringify({
    summary: `Hosted review canary observed marker ${marker}.`,
  });
  const jsonl = [
    {
      type: "item.completed",
      item: { id: "todo", type: "todo_list", items: [], status: "completed" },
    },
    {
      type: "item.completed",
      item: {
        id: "expected-command",
        type: "command_execution",
        command: `/bin/bash -lc '${expectedCommand}'`,
        aggregated_output: marker,
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: { id: "final-message", type: "agent_message", text: finalDecisionText },
    },
    { type: "turn.completed", usage: {} },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  assert.throws(
    () =>
      summarizeHostedReviewTrace({
        jsonl,
        marker,
        expectedCommand,
        finalDecisionText,
        checkoutUnchanged: true,
      }),
    /must attempt exactly one review tool/,
  );
});

test("hosted review output must match the checked-in schema", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["nextStep", "score"],
    properties: {
      nextStep: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "text"],
            properties: {
              kind: { type: "string", const: "none" },
              text: { type: "string", const: "" },
            },
          },
        ],
      },
      score: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    },
  };
  assertMatchesJsonSchema({ nextStep: { kind: "none", text: "" }, score: 0.75 }, schema);
  assert.throws(() => assertMatchesJsonSchema({ score: 0.75 }, schema), /nextStep is required/);
  assert.throws(
    () => assertMatchesJsonSchema({ nextStep: { kind: "none", text: "" }, score: 2 }, schema),
    /above its maximum/,
  );
});

test("hosted review artifacts reject string payloads", () => {
  assert.throws(
    () => assertBooleanCountArtifact({ safe: true, leaked: "raw transcript" }),
    /only booleans and integer counts/,
  );
});

test("hosted review failures withhold private diagnostics", () => {
  const privateMarker = "a36a5710-0818-4680-969c-86496901b59f";
  assert.throws(
    () =>
      runWithWithheldDiagnostics("Hosted review failed; diagnostics withheld.", () => {
        throw new Error(`provider output ${privateMarker}`);
      }),
    (error: Error) => {
      assert.equal(error.message, "Hosted review failed; diagnostics withheld.");
      assert.doesNotMatch(error.message, new RegExp(privateMarker));
      return true;
    },
  );
});
