import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCodexProcess } from "../dist/codex-process.js";
import { CODEX_THREAD_STATE_MAX_BYTES } from "../dist/codex-output-capture.js";
import { decisionOutputError } from "../dist/review-decision-repair.js";
import { closeDecision } from "./helpers.ts";

const uuid = "019f0560-0000-7000-8000-000000000001";
const turnFailure = "Rate limit reached for tokens per min (TPM). Please try again in 20s.";
const scenarios = [
  "completed",
  "failed",
  "interrupted",
  "incomplete",
  "completed-shutdown",
  "boundary-thread",
  "oversized-thread",
];

for (const scenario of scenarios) {
  test(`app-server managed output: ${scenario}`, { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-app-server-output-"));
    const statePath = join(root, "thread.json");
    const outputPath = join(root, "result.json");
    const requestsPath = join(root, "requests");
    const binary = join(root, "codex");
    const fixture = join(root, "codex-fixture.cjs");
    const priorState = JSON.stringify({ threadId: uuid, sessionId: uuid, updatedAt: "prior" });
    const stateOverhead = Buffer.byteLength(
      JSON.stringify(
        {
          threadId: "",
          sessionId: uuid,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    const threadId = scenario.endsWith("-thread")
      ? "t".repeat(
          CODEX_THREAD_STATE_MAX_BYTES - stateOverhead + (scenario === "oversized-thread" ? 1 : 0),
        )
      : uuid;
    try {
      if (scenario === "oversized-thread") writeFileSync(statePath, priorState);
      writeFileSync(
        fixture,
        `const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const scenario = ${JSON.stringify(scenario)};
const threadId = ${JSON.stringify(threadId)};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(requestsPath)}, message.method + "\\n");
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: threadId, sessionId: ${JSON.stringify(uuid)} } } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn", status: "inProgress" } } });
    setTimeout(() => {
      send({ method: "item/completed", params: {
        threadId, turnId: "turn", item: { type: "agentMessage", id: "message", text: '{"decision":"keep_open"}' }
      } });
      if (scenario === "incomplete") return process.exit(1);
      const status = ["failed", "interrupted"].includes(scenario) ? scenario : "completed";
      send({ method: "turn/completed", params: {
        threadId, turn: {
          id: "turn",
          status,
          error: scenario === "failed" ? { message: ${JSON.stringify(turnFailure)}, codexErrorInfo: null } : null,
        }
      } });
      if (scenario === "completed-shutdown") setTimeout(() => process.exit(1), 5);
    }, 5);
  }
});
`,
      );
      // This stands in for the external Codex CLI. Its own exit after the turn races the
      // worker's process-group SIGTERM, which can cut its V8 coverage write short and
      // leave an empty profile that fails the whole coverage report.
      writeFileSync(
        binary,
        `#!/bin/sh\nexec /usr/bin/env -u NODE_V8_COVERAGE ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
        { mode: 0o700 },
      );
      const result = runCodexProcess({
        args: [
          "exec",
          "--cd",
          root,
          "--sandbox",
          "read-only",
          "--output-last-message",
          outputPath,
          "--json",
          "-",
        ],
        cwd: root,
        env: { ...process.env, CODEX_BIN: binary },
        input: "Review the fixture.",
        timeoutMs: 10_000,
        outputLastMessagePath: outputPath,
        outputLastMessageBytes: 128,
        appServer: { statePath },
      });
      if (scenario === "oversized-thread") {
        assert.match(result.error?.message ?? "", /thread state exceeded its 1024-byte limit/);
        assert.equal(readFileSync(statePath, "utf8"), priorState);
        assert.doesNotMatch(readFileSync(requestsPath, "utf8"), /turn\/start/);
        assert.equal(
          readdirSync(root).some((name) => name.includes(".tmp-")),
          false,
        );
      } else {
        const state = readFileSync(statePath, "utf8");
        assert.ok(Buffer.byteLength(state) <= CODEX_THREAD_STATE_MAX_BYTES);
        assert.equal(JSON.parse(state).threadId, threadId);
        if (scenario === "boundary-thread")
          assert.equal(Buffer.byteLength(state), CODEX_THREAD_STATE_MAX_BYTES);
      }
      if (["failed", "interrupted", "incomplete", "oversized-thread"].includes(scenario)) {
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(outputPath), false);
        // The turn outcome, not the missing managed result file, explains the failure.
        assert.doesNotMatch(result.error?.message ?? "", /ENOENT/);
        if (scenario === "failed") {
          assert.equal(result.error?.message, `Codex turn failed: ${turnFailure}`);
        }
        if (scenario === "interrupted") {
          assert.equal(result.error?.message, "Codex turn interrupted.");
        }
      } else {
        assert.equal(readFileSync(outputPath, "utf8"), '{"decision":"keep_open"}');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  "repaired",
  "invalid-twice",
  "inactive-decision-repaired",
  "inactive-decision-invalid-twice",
] as const) {
  test(
    `app-server decision repair turn: ${scenario}`,
    { skip: process.platform === "win32" },
    () => {
      const root = mkdtempSync(join(tmpdir(), "clawsweeper-app-server-repair-"));
      const outputPath = join(root, "result.json");
      const schemaPath = join(root, "schema.json");
      const requestsPath = join(root, "requests.jsonl");
      const binary = join(root, "codex");
      const fixture = join(root, "codex-fixture.cjs");
      const validDecision = JSON.stringify(
        closeDecision({
          decision: "keep_open",
          closeReason: "none",
          confidence: "medium",
          summary: "Repaired decision.",
          bestSolution: "Keep the validator.",
          closeComment: "",
          workReason: "Maintainer review is required.",
        }),
      );
      const inactiveDecision = JSON.parse(validDecision);
      inactiveDecision.maintainerDecision.likelyOwner = { person: "@alice" };
      const invalidDecision = JSON.stringify(inactiveDecision);
      const inactiveScenario = scenario.startsWith("inactive-decision-");
      const validationError = inactiveScenario
        ? "decision.maintainerDecision must be empty when no decision is required"
        : "decision.evidence must be an array";
      const schema = JSON.parse(
        readFileSync(
          new URL("../schema/clawsweeper-decision.schema.json", import.meta.url),
          "utf8",
        ),
      );
      const messages = [
        inactiveScenario ? invalidDecision : '{"decision":"keep_open"}',
        scenario === "inactive-decision-invalid-twice"
          ? invalidDecision
          : scenario === "invalid-twice"
            ? "not json"
            : validDecision,
      ];
      try {
        writeFileSync(schemaPath, JSON.stringify(schema));
        writeFileSync(
          fixture,
          `const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const messages = ${JSON.stringify(messages)};
let turns = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(requestsPath)}, line + "\\n");
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: ${JSON.stringify(uuid)} } } });
  }
  if (message.method === "turn/start") {
    const turnId = "turn-" + turns;
    const text = messages[turns++];
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: ${JSON.stringify(uuid)}, turnId, item: { type: "agentMessage", id: "m", text } } });
    send({ method: "turn/completed", params: { threadId: ${JSON.stringify(uuid)}, turn: { id: turnId, status: "completed", error: null } } });
  }
});
`,
        );
        writeFileSync(
          binary,
          `#!/bin/sh\nexec /usr/bin/env -u NODE_V8_COVERAGE ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
          { mode: 0o700 },
        );
        const result = runCodexProcess({
          args: [
            "exec",
            "--cd",
            root,
            "--sandbox",
            "read-only",
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            "--json",
            "-",
          ],
          cwd: root,
          env: { ...process.env, CODEX_BIN: binary },
          input: "Review the fixture.",
          timeoutMs: 10_000,
          outputLastMessagePath: outputPath,
          outputLastMessageBytes: 64 * 1024,
          appServer: { statePath: join(root, "thread.json") },
          decisionRepair: { item: { repo: "openclaw/openclaw", number: 123, kind: "issue" } },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.decisionRepairError, validationError);
        const output = readFileSync(outputPath, "utf8");
        assert.equal(output, messages[1]);
        const outputError = decisionOutputError(output, {
          repo: "openclaw/openclaw",
          number: 123,
          kind: "issue",
        });
        if (scenario.endsWith("invalid-twice")) {
          assert.ok(outputError);
          if (inactiveScenario) assert.equal(outputError, validationError);
        } else {
          assert.equal(outputError, undefined);
        }
        const turnStarts = readFileSync(requestsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((message) => message.method === "turn/start")
          .map((message) => message.params);
        assert.equal(turnStarts.length, 2);
        const [first, repair] = turnStarts;
        assert.deepEqual(first.input, [{ type: "text", text: "Review the fixture." }]);
        assert.ok(repair.input[0].text.includes(validationError));
        // Same thread, sandbox, cwd, and output schema; only the input changes.
        assert.deepEqual({ ...repair, input: first.input }, first);
        assert.deepEqual(first.outputSchema, schema);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test(
  "app-server usage counts only this run on a resumed thread",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-app-server-usage-"));
    const statePath = join(root, "thread.json");
    const outputPath = join(root, "result.json");
    const binary = join(root, "codex");
    const fixture = join(root, "codex-fixture.cjs");
    // The stored thread already carries 1,000 input / 100 output tokens from an earlier attempt.
    const breakdown = (input: number, cached: number, write: number, output: number) => ({
      inputTokens: input,
      cachedInputTokens: cached,
      cacheWriteInputTokens: write,
      outputTokens: output,
      reasoningOutputTokens: output / 2,
      totalTokens: input + output,
    });
    const earlier = {
      total: breakdown(1_000, 800, 100, 100),
      last: breakdown(1_000, 800, 100, 100),
    };
    const updates = [
      { total: breakdown(1_200, 900, 200, 110), last: breakdown(200, 100, 100, 10) },
      { total: breakdown(1_500, 1_100, 300, 130), last: breakdown(300, 200, 100, 20) },
    ];
    try {
      writeFileSync(
        statePath,
        JSON.stringify({ threadId: uuid, sessionId: uuid, updatedAt: "prior" }),
      );
      writeFileSync(
        fixture,
        `const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const threadId = ${JSON.stringify(uuid)};
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: threadId, sessionId: threadId } } });
    // Codex replays the earlier attempt's last update when it resumes a thread.
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "earlier-turn", tokenUsage: ${JSON.stringify(earlier)} } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn", status: "inProgress" } } });
    for (const tokenUsage of ${JSON.stringify(updates)}) {
      send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "turn", tokenUsage } });
    }
    send({ method: "item/completed", params: {
      threadId, turnId: "turn", item: { type: "agentMessage", id: "message", text: '{"decision":"keep_open"}' }
    } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn", status: "completed", error: null } } });
  }
});
`,
      );
      writeFileSync(
        binary,
        `#!/bin/sh\nexec /usr/bin/env -u NODE_V8_COVERAGE ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
        { mode: 0o700 },
      );
      const result = runCodexProcess({
        args: ["exec", "--cd", root, "--output-last-message", outputPath, "--json", "-"],
        cwd: root,
        env: { ...process.env, CODEX_BIN: binary },
        input: "Review the fixture.",
        timeoutMs: 10_000,
        outputLastMessagePath: outputPath,
        outputLastMessageBytes: 128,
        appServer: { statePath },
      });
      assert.equal(result.status, 0);
      // Final total minus the earlier attempt's 1,000/800/100/100; the replayed update is ignored.
      assert.deepEqual(result.usage, {
        input_tokens: 500,
        cached_input_tokens: 300,
        cache_write_input_tokens: 200,
        output_tokens: 30,
        reasoning_output_tokens: 15,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
