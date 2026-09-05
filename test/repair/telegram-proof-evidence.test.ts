import assert from "node:assert/strict";
import test from "node:test";
import {
  exportTelegramProofEvidence,
  verifyTelegramProofEvidence,
  TELEGRAM_OBSERVATION_MAX_BYTES,
} from "../../src/repair/telegram-proof-evidence.ts";
import { telegramProofFixture } from "../helpers/telegram-proof-fixtures.ts";

function changed(files: Map<string, Buffer>, file: string, patch: Record<string, unknown>) {
  const result = new Map(files);
  result.set(
    file,
    Buffer.from(JSON.stringify({ ...JSON.parse(files.get(file)!.toString("utf8")), ...patch })),
  );
  return result;
}

test("trusted blocked Telegram egress is fail, never delivered-message or pass evidence", () => {
  const fixture = telegramProofFixture(undefined, "fail", "blocked_before_forward");
  assert.equal(fixture.outcome, "fail");
  assert.match(fixture.observations[2]!.actual, /blocked before Telegram forwarding/);
  const reply = JSON.parse(fixture.files.get("telegram-reply.json")!.toString());
  assert.equal(reply.message_id, null);
  assert.equal(reply.in_reply_to, null);
  assert.throws(
    () => telegramProofFixture(undefined, "pass", "blocked_before_forward"),
    /binding_mismatch/,
  );
  for (const patch of [
    { delivery: "delivered" },
    { message_id: "102" },
    { in_reply_to: "101" },
    { from_sut: false },
    { text_sha256: fixture.capture.provider.response_sha256 },
    { text: "private candidate output" },
    { request_id: "f".repeat(64) },
    { conversation_digest: "f".repeat(64) },
    { capture: "partial" },
  ]) {
    assert.equal(
      verifyTelegramProofEvidence(
        changed(fixture.files, "telegram-reply.json", patch),
        fixture.binding,
      ).outcome,
      "inconclusive",
    );
  }
  const noDelivery = new Map(fixture.files);
  delete reply.delivery;
  noDelivery.set("telegram-reply.json", Buffer.from(JSON.stringify(reply)));
  assert.equal(verifyTelegramProofEvidence(noDelivery, fixture.binding).outcome, "inconclusive");
});

test("Telegram normalized exporter derives pass and fail only from a correlated SUT reply hash", () => {
  for (const outcome of ["pass", "fail"] as const) {
    const fixture = telegramProofFixture(undefined, outcome);
    assert.equal(verifyTelegramProofEvidence(fixture.files, fixture.binding).outcome, outcome);
    assert.equal(fixture.outcome, outcome);
    assert.deepEqual(
      [...fixture.files.keys()],
      ["telegram-send.json", "provider-request.json", "telegram-reply.json"],
    );
    for (const bytes of fixture.files.values()) {
      assert.ok(bytes.length <= TELEGRAM_OBSERVATION_MAX_BYTES);
      assert.doesNotMatch(
        bytes.toString("utf8"),
        /"(?:request_sha256|chat_id|bot_id|user_id|token|authorization|timestamp|sent_at_ms|received_at_ms)"/,
      );
    }
  }
  const fixture = telegramProofFixture();
  fixture.capture.reply.in_reply_to = null;
  assert.equal(exportTelegramProofEvidence(fixture.binding, fixture.capture).outcome, "pass");
});

test("Telegram normalized records reject every cross-identity, incomplete or unknown-field projection", () => {
  const { files, binding } = telegramProofFixture();
  for (const file of files.keys()) {
    for (const patch of [
      { request_id: "f".repeat(64) },
      { candidate_sha: "f".repeat(40) },
      { harness_sha: "f".repeat(40) },
      { run_id: "301" },
      { run_attempt: 2 },
      { nonce: "f".repeat(64) },
      { conversation_digest: "f".repeat(64) },
      { schema: "browser-observation" },
      { scenario: "web-ui-chat-proof" },
      { transport: "Telegram" },
      { test_dc: false },
      { chat_type: "group" },
      { capture: "partial" },
      { chat_id: "private-not-allowed" },
    ]) {
      assert.equal(
        verifyTelegramProofEvidence(changed(files, file, patch), binding).outcome,
        "inconclusive",
        file + " " + Object.keys(patch)[0],
      );
    }
    const value = JSON.parse(files.get(file)!.toString("utf8"));
    delete value.conversation_digest;
    const missing = new Map(files);
    missing.set(file, Buffer.from(JSON.stringify(value)));
    assert.equal(verifyTelegramProofEvidence(missing, binding).outcome, "inconclusive");
  }
});

test("Telegram invalid stimulus/provider/peer binding is inconclusive rather than a conclusive failure", () => {
  const { files, binding } = telegramProofFixture();
  for (const [file, patch] of [
    ["telegram-send.json", { text_sha256: "f".repeat(64) }],
    ["telegram-send.json", { message_id: "0" }],
    ["provider-request.json", { input_nonce: "f".repeat(64) }],
    ["provider-request.json", { response_sha256: "f".repeat(64) }],
    ["provider-request.json", { request_sha256: "f".repeat(64) }],
    ["telegram-reply.json", { message_id: "101" }],
    ["telegram-reply.json", { message_id: "0102" }],
    ["telegram-reply.json", { in_reply_to: "999" }],
    ["telegram-reply.json", { from_sut: false }],
    ["telegram-reply.json", { text_sha256: "unknown" }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.equal(
      verifyTelegramProofEvidence(changed(files, file, patch), binding).outcome,
      "inconclusive",
      file + " " + Object.keys(patch)[0],
    );
  }
  assert.equal(
    verifyTelegramProofEvidence(
      changed(files, "telegram-reply.json", { text_sha256: "f".repeat(64) }),
      binding,
    ).outcome,
    "fail",
  );
});

test("Telegram canonical decimal identifiers reject oversized correlated message IDs", () => {
  const fixture = telegramProofFixture();
  fixture.capture.send.message_id = "1".repeat(20);
  fixture.capture.reply.message_id = "2".repeat(20);
  fixture.capture.reply.in_reply_to = fixture.capture.send.message_id;
  assert.equal(exportTelegramProofEvidence(fixture.binding, fixture.capture).outcome, "pass");
  fixture.capture.reply.message_id = "2".repeat(21);
  assert.throws(
    () => exportTelegramProofEvidence(fixture.binding, fixture.capture),
    /invalid_telegram_observation_facts/,
  );
  fixture.capture.reply.message_id = "2".repeat(20);
  fixture.capture.send.message_id = "1".repeat(21);
  fixture.capture.reply.in_reply_to = fixture.capture.send.message_id;
  assert.throws(
    () => exportTelegramProofEvidence(fixture.binding, fixture.capture),
    /invalid_telegram_observation_facts/,
  );
  assert.equal(telegramProofFixture({ ...fixture.binding, runId: "3".repeat(20) }).outcome, "pass");
  assert.throws(
    () => telegramProofFixture({ ...fixture.binding, runId: "3".repeat(21) }),
    /invalid_telegram_observation_schema/,
  );
});

test("Telegram evidence bounds raw UTF8, duplicate keys, inventory and run attempts", () => {
  const { files, binding } = telegramProofFixture();
  const file = "telegram-send.json";
  const raw = files.get(file)!.toString("utf8");
  const exactLimit = new Map(files);
  exactLimit.set(file, Buffer.from(raw.padEnd(TELEGRAM_OBSERVATION_MAX_BYTES, " ")));
  assert.equal(verifyTelegramProofEvidence(exactLimit, binding).outcome, "pass");
  for (const bytes of [
    Buffer.from(raw.padEnd(TELEGRAM_OBSERVATION_MAX_BYTES + 1, " ")),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("[]"),
    Buffer.from("null"),
    Buffer.from('{"nonce":' + JSON.stringify(JSON.parse(raw).nonce) + "," + raw.slice(1)),
    Buffer.from('{"\\u006eonce":' + JSON.stringify(JSON.parse(raw).nonce) + "," + raw.slice(1)),
  ]) {
    const invalid = new Map(files);
    invalid.set(file, bytes);
    assert.equal(verifyTelegramProofEvidence(invalid, binding).outcome, "inconclusive");
  }
  const missing = new Map(files);
  missing.delete(file);
  assert.equal(verifyTelegramProofEvidence(missing, binding).outcome, "inconclusive");
  const extra = new Map(files);
  extra.set("gateway-private.log", Buffer.from("not public"));
  assert.equal(verifyTelegramProofEvidence(extra, binding).outcome, "inconclusive");
  assert.equal(telegramProofFixture({ ...binding, runAttempt: 1 }).outcome, "pass");
  assert.throws(
    () => telegramProofFixture({ ...binding, requestId: binding.requestId + "\n" }),
    /invalid_telegram_observation_schema/,
  );
  assert.throws(
    () => telegramProofFixture({ ...binding, runId: binding.runId + "\n" }),
    /invalid_telegram_observation_schema/,
  );
  assert.throws(
    () => telegramProofFixture({ ...binding, runAttempt: 2 }),
    /invalid_telegram_observation_schema/,
  );
});
