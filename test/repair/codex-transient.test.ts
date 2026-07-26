import assert from "node:assert/strict";
import test from "node:test";
import {
  codexJsonlFailureDetail,
  codexRetryDelayMs,
  codexTerminalErrorDetail,
  isCodexContextLimitError,
  isRetryableCodexErrorMessage,
  isRetryableCodexTransportError,
  isTerminalCodexErrorMessage,
} from "../../dist/codex-transient.js";

test("Codex closed-stdin tool transport errors are retryable", () => {
  assert.equal(
    isRetryableCodexTransportError(
      "ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true",
    ),
    true,
  );
});

test("ordinary Codex failures are not classified as transient transport", () => {
  assert.equal(isRetryableCodexTransportError("Codex /review found an actionable bug"), false);
  assert.equal(
    isRetryableCodexTransportError("validation command failed: pnpm check:changed"),
    false,
  );
});

test("Codex TPM rate-limit errors are retryable transport failures", () => {
  const message =
    "stream disconnected before completion: Rate limit reached for gpt-5.6-sol on tokens per min (TPM): Limit 40000000, Used 40000000, Requested 126092. Please try again in 189ms.";
  assert.equal(isRetryableCodexTransportError(message), true);
  assert.equal(isCodexContextLimitError(message), false);
});

test("Codex model access failures are terminal even when the stream disconnects", () => {
  const message =
    "ERROR: stream disconnected before completion: The model secret-model-for-test does not exist or you do not have access to it.";
  assert.equal(isRetryableCodexTransportError(message), true);
  assert.equal(isRetryableCodexErrorMessage(message), false);
});

test("Codex JSONL model access errors are trusted terminal failures", () => {
  const message =
    "stream disconnected before completion: The model secret-model-for-test does not exist or you do not have access to it.";
  const jsonl = [
    JSON.stringify({ type: "error", message: "fetch failed" }),
    JSON.stringify({ type: "turn.failed", error: { message } }),
  ].join("\n");

  assert.equal(codexJsonlFailureDetail(jsonl), message);
  assert.equal(isTerminalCodexErrorMessage(message), true);
  assert.equal(isRetryableCodexErrorMessage(message), false);
});

test("quoted model access failures do not override the final Codex error", () => {
  const message = [
    "user",
    "ERROR: stream disconnected before completion: The model quoted-model does not exist or you do not have access to it.",
    "ERROR: stream disconnected before completion: fetch failed",
  ].join("\n");
  assert.equal(isRetryableCodexTransportError(message), true);
  assert.equal(isRetryableCodexErrorMessage(message), true);
});

test("Codex terminal classification stays bounded on repeated model prefixes", () => {
  const message = `${"the model ".repeat(20_000)}missing suffix`;
  const startedAt = performance.now();

  assert.equal(isTerminalCodexErrorMessage(message), false);
  assert.ok(performance.now() - startedAt < 500);
});

test("Codex terminal detail returns only the final trusted diagnostic line", () => {
  const terminalError =
    "ERROR: stream disconnected before completion: The model secret-model-for-test does not exist or you do not have access to it.";
  assert.equal(codexTerminalErrorDetail(`reviewed patch text\n${terminalError}`), terminalError);
});

test("Codex context-limit errors are blocked automation outcomes", () => {
  assert.equal(
    isCodexContextLimitError("Error: Requested 142470. Please try again with a smaller input."),
    true,
  );
  assert.equal(isCodexContextLimitError("maximum context length exceeded"), true);
  assert.equal(isCodexContextLimitError("validation command failed: pnpm check:changed"), false);
});

test("Codex retry delay ignores blank and non-positive environment settings", () => {
  const previous = {
    CLAWSWEEPER_CODEX_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_RETRY_DELAY_MS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
  };
  try {
    process.env.CLAWSWEEPER_CODEX_RETRY_DELAY_MS = "";
    process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "7";
    assert.equal(codexRetryDelayMs("", 1), 7);

    process.env.CLAWSWEEPER_CODEX_RETRY_DELAY_MS = "0";
    process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "";
    assert.equal(codexRetryDelayMs("", 1), 15_000);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
