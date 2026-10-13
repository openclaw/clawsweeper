import assert from "node:assert/strict";
import test from "node:test";
import {
  codexHumanFailureDetail,
  codexHumanRetryHint,
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

test("Codex human failures accept only a terminal error before a native usage trailer", () => {
  const terminal =
    "stream disconnected before completion: The model fixture-model does not exist or you do not have access to it.";
  for (const count of [
    "0",
    "1,234",
    "1.234",
    "1\u202f234",
    "1\u00a0234",
    "1\u2019234",
    "\u0661\u066c\u0662\u0663\u0664",
    "\u061c\u0661\u066c\u0662\u0663\u0664",
  ]) {
    const stderr = `user\nERROR: quoted rate limit reached\nERROR: ${terminal}\ntokens used\n${count}\n`;
    assert.equal(codexHumanFailureDetail(stderr), `ERROR: ${terminal}`);
    assert.equal(isTerminalCodexErrorMessage(codexHumanFailureDetail(stderr)), true);
  }
  assert.equal(codexHumanFailureDetail(`ERROR: ${terminal}\n`), `ERROR: ${terminal}`);
});

test("Codex human classification ignores quoted errors and malformed trailers", () => {
  for (const stderr of [
    "user\nERROR: rate limit reached\nordinary prompt text\n",
    "exec\nERROR: rate limit reached\nturn interrupted\n",
    "ERROR: rate limit reached\ntokens used\nnot a count\n",
    "ERROR: rate limit reached\ntokens used\n1,024\nlater output\n",
    "quoted ERROR: rate limit reached\n",
    "rate limit reached\n",
  ]) {
    assert.equal(codexHumanFailureDetail(stderr), "");
  }
});

test("Codex human trailers preserve transport and capacity classification", () => {
  for (const message of [
    "Rate limit reached for model on tokens per min (TPM).",
    "stream disconnected before completion: fetch failed",
  ]) {
    const detail = codexHumanFailureDetail(`ERROR: ${message}\ntokens used\n1,024\n`);
    assert.equal(detail, `ERROR: ${message}`);
    assert.equal(isRetryableCodexErrorMessage(detail), true);
  }
});

test("Codex multiline retry hints accept bounded LF and CRLF blocks with locale usage", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const trailer of ["", "tokens used\n1,234", "tokens used\n1\u202f234"]) {
      for (const block of [
        "ERROR: upstream response\n\nRate limit reached on tokens per min (TPM).",
        "ERROR: stream disconnected before completion:\nfetch failed",
      ]) {
        const stderr = [block, "", trailer, ""].join("\n").replaceAll("\n", newline);
        assert.equal(codexHumanFailureDetail(stderr), "");
        assert.equal(codexHumanRetryHint(stderr), block);
      }
    }
  }
});

test("Codex multiline retry hints consider only the final column-zero error block", () => {
  const denial = "The model fixture-model does not exist or you do not have access to it.";
  const transient = "ERROR: upstream response\nRate limit reached.";
  assert.equal(
    codexHumanRetryHint(`ERROR: quoted failure\n${denial}\n${transient}\ntokens used\n0\n`),
    transient,
  );
  for (const finalBlock of [
    `ERROR: upstream response\n${denial}`,
    "ERROR: upstream response\nunknown failure",
    "ERROR:malformed final error\nunknown failure",
  ]) {
    assert.equal(codexHumanRetryHint(`${transient}\n${finalBlock}\n`), "");
  }
  for (const prefix of ["quoted ERROR: ", " ERROR: ", ""]) {
    assert.equal(codexHumanRetryHint(`${prefix}upstream response\nRate limit reached.\n`), "");
  }
  const mixed = `ERROR: Rate limit reached\n${denial}`;
  assert.equal(codexHumanRetryHint(mixed), mixed);
  assert.equal(codexHumanFailureDetail(mixed), "");
});

test("Codex multiline retry hints reject malformed or superseded usage frames", () => {
  const block = "ERROR: upstream response\nRate limit reached.";
  for (const suffix of [
    "tokens used\nnot a count",
    "tokens used\n1,024\nlater output",
    "tokens used\n1,024\ntokens used\n2,048",
    " tokens used\n1,024",
    "tokens used\n\n1,024",
  ]) {
    assert.equal(codexHumanRetryHint(`${block}\n${suffix}\n`), "");
    assert.equal(codexHumanFailureDetail(`${block}\n${suffix}\n`), "");
  }
});

test("Codex multiline retry hints bound the complete block without promoting a partial line", () => {
  const prefix = "ERROR: upstream response\nRate limit reached ";
  const atLimit = prefix + "x".repeat(4096 - prefix.length);
  assert.equal(codexHumanRetryHint(atLimit), atLimit);
  assert.equal(codexHumanRetryHint(atLimit + "x"), "");
  assert.equal(codexHumanRetryHint(prefix + "\u00e9".repeat(2048)), "");
  assert.equal(codexHumanRetryHint("quoted " + atLimit), "");
  assert.equal(codexHumanRetryHint("x".repeat(8192) + "\n" + atLimit), atLimit);
  assert.equal(codexHumanRetryHint("ERROR: Rate limit reached.\n"), "");
  assert.equal(codexHumanRetryHint(undefined), "");
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
