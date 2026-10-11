import { createHash } from "node:crypto";
interface TelegramProofBinding {
  requestId: string;
  headSha: string;
  harnessSha: string;
  runId: string;
  runAttempt: number;
}
interface TelegramProofCapture {
  common: {
    transport: "TelegramTestServer";
    nonce: string;
    capture: "complete";
    test_dc: true;
    chat_type: "dm";
    conversation_digest: string;
  };
  send: { message_id: string; text_sha256: string };
  provider: { input_nonce: string; response_nonce: string; response_sha256: string };
  reply: {
    message_id: string | null;
    in_reply_to: string | null;
    text_sha256: string;
    from_sut: true;
    delivery?: "blocked_before_forward";
  };
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Synthetic normalized captures, not evidence of live Telegram or adapter execution. */
export function telegramProofFixture(
  binding: TelegramProofBinding = {
    requestId: "d".repeat(64),
    headSha: "a".repeat(40),
    harnessSha: "e".repeat(40),
    runId: "300",
    runAttempt: 1,
  },
  outcome: "pass" | "fail" = "pass",
  delivery?: "blocked_before_forward",
) {
  const nonce = digest("public test challenge:" + binding.requestId);
  const responseNonce = digest("trusted external mock response:" + binding.requestId);
  const responseHash = digest("MANTIS_TELEGRAM_REPLY_" + responseNonce);
  const capture: TelegramProofCapture = {
    common: {
      transport: "TelegramTestServer",
      nonce,
      capture: "complete",
      test_dc: true,
      chat_type: "dm",
      conversation_digest: digest(
        "synthetic run-local salt:" + binding.runId + ":" + binding.runAttempt + ":" + nonce,
      ),
    },
    send: { message_id: "101", text_sha256: digest("Mantis Telegram request " + nonce) },
    provider: {
      input_nonce: nonce,
      response_nonce: responseNonce,
      response_sha256: responseHash,
    },
    reply: {
      message_id: "102",
      in_reply_to: "101",
      text_sha256: outcome === "pass" ? responseHash : digest("actual mismatching SUT reply"),
      from_sut: true,
    },
  };
  if (delivery === "blocked_before_forward") {
    capture.reply = { ...capture.reply, delivery, message_id: null, in_reply_to: null };
  }
  const common = {
    schema: "mantis.telegram-observation.v1",
    request_id: binding.requestId,
    scenario: "telegram-bot-e2e-proof",
    candidate_sha: binding.headSha,
    harness_sha: binding.harnessSha,
    run_id: binding.runId,
    run_attempt: binding.runAttempt,
    ...capture.common,
  };
  const files = new Map(
    [
      ["telegram-send.json", { ...common, kind: "telegram-send", ...capture.send }],
      ["provider-request.json", { ...common, kind: "provider-request", ...capture.provider }],
      ["telegram-reply.json", { ...common, kind: "telegram-reply", ...capture.reply }],
    ].map(([file, value]) => [String(file), Buffer.from(JSON.stringify(value), "utf8")]),
  );
  return {
    binding,
    capture,
    files,
    outcome,
    observations: [
      {
        id: "telegram-send",
        expected: "Request-bound DM observed by TDLib on TelegramTestServer",
        actual: "Complete test-DC DM capture; sent text SHA256 " + capture.send.text_sha256,
      },
      {
        id: "provider-request",
        expected: "External mock provider captured the same input nonce and supplied its response",
        actual: "Correlated input nonce; response SHA256 " + responseHash,
      },
      {
        id: "telegram-reply",
        expected: "SUT reply SHA256 " + responseHash,
        actual:
          (delivery
            ? "Wrong SUT egress blocked before Telegram forwarding; SHA256 "
            : "SUT reply SHA256 ") + capture.reply.text_sha256,
      },
    ],
  };
}
