import assert from "node:assert/strict";
import test from "node:test";

import { OutputLastMessageParser } from "../dist/codex-output-last-message.js";

function event(type: string, text: string): string {
  return JSON.stringify({ type, text });
}

function agentMessage(text: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text },
  });
}

test("managed result parser accepts multiple bounded lines in one larger chunk", () => {
  const parser = new OutputLastMessageParser(8);
  const diagnostic = event("diagnostic", "x".repeat(30_000));
  const payload = `${diagnostic}\n${diagnostic}\n${diagnostic}\n${agentMessage("accepted")}\n`;
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
  parser.append(Buffer.from(`${final.slice(20)}\n`));

  assert.deepEqual(parser.finish(), { text: "tail copied" });
});

test("managed result parser rejects oversized and unfinished records", () => {
  const oversized = new OutputLastMessageParser(1);
  oversized.append(Buffer.from(`${"x".repeat(oversized.maxLineBytes + 1)}\n`));
  assert.match(oversized.finish().error?.message ?? "", /JSONL line exceeded/);

  const unfinished = new OutputLastMessageParser(8);
  unfinished.append(Buffer.from(agentMessage("partial")));
  assert.match(unfinished.finish().error?.message ?? "", /partial line/);
});
