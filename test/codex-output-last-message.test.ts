import assert from "node:assert/strict";
import test from "node:test";

import { OutputLastMessageParser } from "../dist/codex-output-last-message.js";

function event(type: string, text: string): string {
  return JSON.stringify({ type, text });
}

function agentMessage(text: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text },
  });
}

const turnCompleted = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
});
const turnFailed = JSON.stringify({ type: "turn.failed", error: { message: "turn failed" } });

test("managed result parser accepts multiple bounded lines in one larger chunk", () => {
  const parser = new OutputLastMessageParser(8);
  const diagnostic = event("diagnostic", "x".repeat(30_000));
  const payload = `${diagnostic}\n${diagnostic}\n${diagnostic}\n${agentMessage("accepted")}\n${turnCompleted}\n`;
  assert.ok(Buffer.byteLength(payload) > parser.maxLineBytes);

  parser.append(Buffer.from(payload));

  assert.deepEqual(parser.finish(), { text: "accepted" });
});

test("managed result parser combines a prefix and copies an unfinished tail", () => {
  const parser = new OutputLastMessageParser(16);
  const diagnostic = event("diagnostic", "prefix");
  const final = agentMessage("tail copied");
  parser.append(Buffer.from(diagnostic.slice(0, 8)));
  const middle = Buffer.from(
    `${diagnostic.slice(8)}\n${event("diagnostic", "middle")}\n${final.slice(0, 20)}`,
  );
  parser.append(middle);
  middle.fill(0);
  parser.append(Buffer.from(`${final.slice(20)}\n${turnCompleted}\n`));

  assert.deepEqual(parser.finish(), { text: "tail copied" });
});

test("managed result parser requires terminal success after the agent message", () => {
  const parser = new OutputLastMessageParser(16);
  const payload = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    agentMessage("final answer"),
    turnCompleted,
    "",
  ].join("\n");
  for (const byte of Buffer.from(payload)) parser.append(Buffer.from([byte]));

  assert.deepEqual(parser.finish(), { text: "final answer" });
});

for (const [name, events, message] of [
  ["failed turn", [agentMessage("partial answer"), turnFailed], /turn failed/],
  ["failed turn before a message", [turnFailed, agentMessage("partial answer")], /turn failed/],
  [
    "failed turn followed by terminal success",
    [agentMessage("partial answer"), turnFailed, turnCompleted],
    /turn failed/,
  ],
  ["interrupted or incomplete turn", [agentMessage("partial answer")], /completed turn/],
  [
    "stream error without terminal success",
    [agentMessage("partial answer"), JSON.stringify({ type: "error", message: "stream failed" })],
    /completed turn/,
  ],
  [
    "nested terminal-success lookalike",
    [agentMessage("partial answer"), JSON.stringify({ payload: JSON.parse(turnCompleted) })],
    /completed turn/,
  ],
] as const) {
  test(`managed result parser does not publish a message from a ${name}`, () => {
    const parser = new OutputLastMessageParser(16);
    parser.append(Buffer.from(`${events.join("\n")}\n`));

    const result = parser.finish();
    assert.match(result.error?.message ?? "", message);
    assert.equal(result.text, undefined);
    assert.deepEqual(parser.finish(), result);
  });
}

test("managed result parser does not replace a completed result with a later item", () => {
  const parser = new OutputLastMessageParser(16);
  parser.append(
    Buffer.from(`${agentMessage("completed")}\n${turnCompleted}\n${agentMessage("late item")}\n`),
  );

  assert.deepEqual(parser.finish(), { text: "completed" });
});

test("managed result parser preserves UTF-8 and rejects malformed bytes after terminal success", () => {
  const parser = new OutputLastMessageParser(2);
  for (const byte of Buffer.from(`${agentMessage("\u00e9")}\n${turnCompleted}\n`)) {
    parser.append(Buffer.from([byte]));
  }
  assert.deepEqual(parser.finish(), { text: "\u00e9" });

  const malformed = new OutputLastMessageParser(2);
  malformed.append(Buffer.from(`${agentMessage("ok")}\n${turnCompleted}\n`));
  malformed.append(Buffer.from([0xff, 0x0a]));
  assert.match(malformed.finish().error?.message ?? "", /malformed line/);
  assert.equal(malformed.finish().text, undefined);
});

test("managed result parser rejects oversized and unfinished records", () => {
  const oversized = new OutputLastMessageParser(1);
  oversized.append(Buffer.from(`${"x".repeat(oversized.maxLineBytes + 1)}\n`));
  assert.match(oversized.finish().error?.message ?? "", /JSONL line exceeded/);

  const unfinished = new OutputLastMessageParser(8);
  unfinished.append(Buffer.from(agentMessage("partial")));
  assert.match(unfinished.finish().error?.message ?? "", /partial line/);

  const unfinishedSuccess = new OutputLastMessageParser(8);
  unfinishedSuccess.append(Buffer.from(`${agentMessage("partial")}\n${turnCompleted}`));
  assert.match(unfinishedSuccess.finish().error?.message ?? "", /partial line/);
});
