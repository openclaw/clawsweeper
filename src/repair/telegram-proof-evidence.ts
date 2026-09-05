import { createHash } from "node:crypto";

export const TELEGRAM_OBSERVATION_MAX_BYTES = 8 * 1024;
const SCENARIO = "telegram-bot-e2e-proof";
const SCHEMA = "mantis.telegram-observation.v1";
const COMMON = [
  "schema",
  "request_id",
  "scenario",
  "candidate_sha",
  "harness_sha",
  "run_id",
  "run_attempt",
  "transport",
  "nonce",
  "capture",
  "test_dc",
  "chat_type",
  "conversation_digest",
];
const SHAPES = [
  { file: "telegram-send.json", kind: "telegram-send", fields: ["message_id", "text_sha256"] },
  {
    file: "provider-request.json",
    kind: "provider-request",
    fields: ["input_nonce", "response_nonce", "response_sha256"],
  },
  {
    file: "telegram-reply.json",
    kind: "telegram-reply",
    fields: ["message_id", "in_reply_to", "text_sha256", "from_sut"],
  },
] as const;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown, length: number): value is string =>
  typeof value === "string" &&
  value.length === length &&
  new RegExp("^[0-9a-f]{" + length + "}$").test(value);
const decimal = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && /^[1-9][0-9]{0,19}$/.test(value);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export interface TelegramProofBinding {
  requestId: string;
  headSha: string;
  harnessSha: string;
  runId: string;
  runAttempt: number;
}
export interface TelegramProofCapture {
  common: {
    transport: "TelegramTestServer";
    nonce: string;
    capture: "complete";
    test_dc: true;
    chat_type: "dm";
    conversation_digest: string;
  };
  send: { message_id: string; text_sha256: string };
  provider: {
    input_nonce: string;
    response_nonce: string;
    response_sha256: string;
  };
  reply:
    | { message_id: string; in_reply_to: string | null; text_sha256: string; from_sut: true }
    | {
        delivery: "blocked_before_forward";
        message_id: null;
        in_reply_to: null;
        text_sha256: string;
        from_sut: true;
      };
}
type Summary = { id: string; expected: string; actual: string };
export type TelegramProofVerification =
  | { outcome: "inconclusive"; reason: string }
  | { outcome: "pass" | "fail"; observations: Summary[] };

// These files are flat JSON records. Detect repeated/escaped duplicate keys in
// addition to JSON.parse: a last-value-wins parser must not hide a conflicting identity.
function decode(bytes: Uint8Array | undefined): Record<string, unknown> | null {
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > TELEGRAM_OBSERVATION_MAX_BYTES)
    return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = record(JSON.parse(text));
    if (!value) return null;
    const keys = new Set<string>();
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== '"') continue;
      const start = index++;
      for (; index < text.length; index++) {
        if (text[index] === "\\") {
          index++;
          continue;
        }
        if (text[index] === '"') break;
      }
      let next = index + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (text[next] !== ":") continue;
      const key: string = JSON.parse(text.slice(start, index + 1));
      if (keys.has(key)) return null;
      keys.add(key);
    }
    return value;
  } catch {
    return null;
  }
}

/** Verify public normalized facts, never raw TDLib/provider logs or candidate claims. */
export function verifyTelegramProofEvidence(
  files: ReadonlyMap<string, Uint8Array>,
  binding: TelegramProofBinding,
): TelegramProofVerification {
  const invalid = (reason: string): TelegramProofVerification => ({
    outcome: "inconclusive",
    reason,
  });
  if (files.size !== SHAPES.length || SHAPES.some(({ file }) => !files.has(file)))
    return invalid("telegram_evidence_inventory_mismatch");
  const values: Record<string, unknown>[] = [];
  for (const shape of SHAPES) {
    const value = decode(files.get(shape.file));
    const extra =
      shape.kind === "telegram-reply" && value?.delivery === "blocked_before_forward"
        ? ["delivery"]
        : [];
    if (
      !value ||
      !closed(value, [...COMMON, "kind", ...shape.fields, ...extra]) ||
      value.schema !== SCHEMA ||
      value.kind !== shape.kind ||
      value.scenario !== SCENARIO ||
      value.transport !== "TelegramTestServer" ||
      value.test_dc !== true ||
      value.chat_type !== "dm" ||
      value.capture !== "complete" ||
      !hex(value.request_id, 64) ||
      !hex(value.candidate_sha, 40) ||
      !hex(value.harness_sha, 40) ||
      !decimal(value.run_id) ||
      !Number.isSafeInteger(value.run_attempt) ||
      Number(value.run_attempt) < 1 ||
      Number(value.run_attempt) > 1 ||
      !hex(value.nonce, 64) ||
      !hex(value.conversation_digest, 64)
    )
      return invalid("invalid_telegram_observation_schema");
    if (
      value.request_id !== binding.requestId ||
      value.candidate_sha !== binding.headSha ||
      value.harness_sha !== binding.harnessSha ||
      value.run_id !== binding.runId ||
      value.run_attempt !== binding.runAttempt
    )
      return invalid("telegram_observation_identity_mismatch");
    values.push(value);
  }
  const [send, provider, reply] = values as [
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  const blocked = reply.delivery === "blocked_before_forward";
  if (
    values.some(
      (value) =>
        value.nonce !== send.nonce || value.conversation_digest !== send.conversation_digest,
    )
  )
    return invalid("uncorrelated_telegram_observations");
  if (
    !decimal(send.message_id) ||
    !hex(send.text_sha256, 64) ||
    !hex(provider.input_nonce, 64) ||
    !hex(provider.response_nonce, 64) ||
    !hex(provider.response_sha256, 64) ||
    (blocked
      ? reply.message_id !== null || reply.in_reply_to !== null
      : !decimal(reply.message_id)) ||
    !hex(reply.text_sha256, 64) ||
    reply.from_sut !== true ||
    (reply.in_reply_to !== null && !decimal(reply.in_reply_to))
  )
    return invalid("invalid_telegram_observation_facts");
  const expectedSend = hash("Mantis Telegram request " + String(send.nonce));
  const expectedReply = hash("MANTIS_TELEGRAM_REPLY_" + provider.response_nonce);
  if (
    send.text_sha256 !== expectedSend ||
    provider.input_nonce !== send.nonce ||
    provider.response_sha256 !== expectedReply ||
    (blocked && reply.text_sha256 === expectedReply) ||
    reply.message_id === send.message_id ||
    (reply.in_reply_to !== null && reply.in_reply_to !== send.message_id)
  )
    return invalid("telegram_observation_binding_mismatch");
  return {
    outcome: reply.text_sha256 === expectedReply ? "pass" : "fail",
    observations: [
      {
        id: "telegram-send",
        expected: "Request-bound DM observed by TDLib on TelegramTestServer",
        actual: "Complete test-DC DM capture; sent text SHA256 " + expectedSend,
      },
      {
        id: "provider-request",
        expected: "External mock provider captured the same input nonce and supplied its response",
        actual: "Correlated input nonce; response SHA256 " + expectedReply,
      },
      {
        id: "telegram-reply",
        expected: "SUT reply SHA256 " + expectedReply,
        actual:
          (blocked
            ? "Wrong SUT egress blocked before Telegram forwarding; SHA256 "
            : "SUT reply SHA256 ") + reply.text_sha256,
      },
    ],
  };
}

/** Public exporter shared by normalized-capture fixtures and the producer adapter contract.
 * The adapter must supply actual post-send, matching-peer captures. No clock,
 * account identifiers, candidate attestations or raw logs are inferred/exported. */
export function exportTelegramProofEvidence(
  binding: TelegramProofBinding,
  capture: TelegramProofCapture,
) {
  const common = {
    schema: SCHEMA,
    request_id: binding.requestId,
    scenario: SCENARIO,
    candidate_sha: binding.headSha,
    harness_sha: binding.harnessSha,
    run_id: binding.runId,
    run_attempt: binding.runAttempt,
    ...capture.common,
  };
  const data = [
    { ...common, kind: "telegram-send", ...capture.send },
    { ...common, kind: "provider-request", ...capture.provider },
    { ...common, kind: "telegram-reply", ...capture.reply },
  ];
  const files = new Map(
    SHAPES.map(({ file }, index) => [file, Buffer.from(JSON.stringify(data[index]), "utf8")]),
  );
  const verified = verifyTelegramProofEvidence(files, binding);
  if (verified.outcome === "inconclusive") throw new Error(verified.reason);
  return { files, ...verified };
}
