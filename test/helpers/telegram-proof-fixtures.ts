import { createHash } from "node:crypto";
import {
  exportTelegramProofEvidence,
  type TelegramProofBinding,
  type TelegramProofCapture,
} from "../../src/repair/telegram-proof-evidence.ts";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Synthetic normalized TDLib/provider captures, encoded by the public producer-contract exporter.
 * Not browser aliases and not evidence of a live Telegram or actual adapter execution. */
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
  return { binding, capture, ...exportTelegramProofEvidence(binding, capture) };
}
