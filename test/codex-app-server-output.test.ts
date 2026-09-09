import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCodexProcess } from "../dist/codex-process.js";
import { CODEX_THREAD_STATE_MAX_BYTES } from "../dist/codex-output-capture.js";

const uuid = "019f0560-0000-7000-8000-000000000001";
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
        binary,
        `#!${process.execPath}
const fs = require("node:fs");
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
      send({ method: "turn/completed", params: {
        threadId, turn: { id: "turn", status: ["failed", "interrupted"].includes(scenario) ? scenario : "completed" }
      } });
      if (scenario === "completed-shutdown") setTimeout(() => process.exit(1), 5);
    }, 5);
  }
});
`,
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
      } else {
        assert.equal(readFileSync(outputPath, "utf8"), '{"decision":"keep_open"}');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
