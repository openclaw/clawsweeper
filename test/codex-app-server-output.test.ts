import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCodexProcess } from "../dist/codex-process.js";
import { CODEX_THREAD_STATE_MAX_BYTES } from "../dist/codex-output-capture.js";
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

for (const scenario of ["repaired", "invalid-twice"] as const) {
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
      const messages = [
        '{"decision":"keep_open"}',
        scenario === "repaired" ? validDecision : "not json",
      ];
      try {
        writeFileSync(schemaPath, '{"type":"object"}');
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
        assert.equal(result.decisionRepairError, "decision.evidence must be an array");
        assert.equal(readFileSync(outputPath, "utf8"), messages[1]);
        const turnStarts = readFileSync(requestsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((message) => message.method === "turn/start")
          .map((message) => message.params);
        assert.equal(turnStarts.length, 2);
        const [first, repair] = turnStarts;
        assert.deepEqual(first.input, [{ type: "text", text: "Review the fixture." }]);
        assert.match(repair.input[0].text, /decision\.evidence must be an array/);
        // Same thread, sandbox, cwd, and output schema; only the input changes.
        assert.deepEqual({ ...repair, input: first.input }, first);
        assert.deepEqual(first.outputSchema, { type: "object" });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
