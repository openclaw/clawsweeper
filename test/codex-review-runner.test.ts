import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  codexFailureDecisionForTest,
  redactInternalCodexModel,
  runCodexForTest,
} from "../dist/clawsweeper.js";
import { closeDecision, item, tmpPrefix } from "./helpers.ts";

test("runCodex accepts valid structured output after non-zero Codex exit", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex === -1) process.exit(2);
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
process.stderr.write("wrote structured output before shutdown failure\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const originalPath = process.env.PATH;
  const originalDecision = process.env.CODEX_DECISION_JSON;
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      summary: "Keep open for maintainer follow-up.",
      bestSolution: "Review the routing invariant.",
      closeComment: "",
      workReason: "Maintainer review is required.",
    }),
  );
  try {
    const decision = runCodexForTest({
      item: item({ number: 83393 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "model-test",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });

    assert.equal(decision.decision, "keep_open");
    assert.equal(decision.summary, "Keep open for maintainer follow-up.");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDecision === undefined) delete process.env.CODEX_DECISION_JSON;
    else process.env.CODEX_DECISION_JSON = originalDecision;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex honors env login config unless preserving local Codex auth", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const argsPath = join(root, "codex-args.json");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CODEX_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex === -1) process.exit(2);
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ARGS_PATH: process.env.CODEX_ARGS_PATH,
    CODEX_DECISION_JSON: process.env.CODEX_DECISION_JSON,
    CLAWSWEEPER_CODEX_LOGIN_METHOD: process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ARGS_PATH = argsPath;
  process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD = "chatgpt";
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      summary: "Keep open for maintainer follow-up.",
      bestSolution: "Review the routing invariant.",
      closeComment: "",
      workReason: "Maintainer review is required.",
    }),
  );

  const runAndReadArgs = (preserveCodexAuth: boolean): string[] => {
    const decision = runCodexForTest({
      item: item({ number: 83395 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "model-test",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      preserveCodexAuth,
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });
    assert.equal(decision.decision, "keep_open");
    return JSON.parse(readFileSync(argsPath, "utf8")) as string[];
  };

  try {
    assert.ok(runAndReadArgs(false).includes('forced_login_method="chatgpt"'));
    assert.equal(runAndReadArgs(true).includes('forced_login_method="chatgpt"'), false);
    assert.equal(
      runAndReadArgs(true).some((arg) => arg.startsWith("forced_login_method=")),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex preserves redacted process output when Codex exits without a decision", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
process.stdout.write("startup banner GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 CODEX_ACCESS_TOKEN=codex-access-token-secret\\n");
process.stderr.write("Rate limit reached for model-test on tokens per min (TPM); OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456 {\\"CODEX_ACCESS_TOKEN\\":\\"codex-json-token-secret\\"}\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const originalPath = process.env.PATH;
  const originalAttempts = process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS;
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "1";
  try {
    assert.throws(
      () =>
        runCodexForTest({
          item: item({ number: 83394 }),
          context: { issue: {}, comments: [], timeline: [] },
          git: { mainSha: "abc123", latestRelease: null },
          model: "model-test",
          openclawDir,
          reasoningEffort: "high",
          sandboxMode: "read-only",
          serviceTier: "",
          timeoutMs: 10_000,
          workDir,
          prompt: "Return a review decision.",
        }),
      (error: unknown) => {
        const reviewError = error as Error & {
          status?: number | null;
          stderr?: string;
          stdout?: string;
        };
        assert.equal(reviewError.status, 1);
        assert.match(reviewError.stderr ?? "", /Rate limit reached/);
        assert.match(reviewError.stderr ?? "", /OPENAI_API_KEY=\[REDACTED\]/);
        assert.match(reviewError.stderr ?? "", /"CODEX_ACCESS_TOKEN":"\[REDACTED\]"/);
        assert.doesNotMatch(reviewError.stderr ?? "", /sk-proj-/);
        assert.doesNotMatch(reviewError.stderr ?? "", /codex-json-token-secret/);
        assert.match(reviewError.stdout ?? "", /startup banner/);
        assert.match(reviewError.stdout ?? "", /GH_TOKEN=\[REDACTED\]/);
        assert.match(reviewError.stdout ?? "", /CODEX_ACCESS_TOKEN=\[REDACTED\]/);
        assert.doesNotMatch(reviewError.stdout ?? "", /ghp_/);
        assert.doesNotMatch(reviewError.stdout ?? "", /codex-access-token-secret/);
        return true;
      },
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalAttempts === undefined) delete process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS;
    else process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = originalAttempts;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex accepts structured output after more than 128 MiB of process output", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const chunk = Buffer.alloc(1024 * 1024, "x");
for (let index = 0; index < 129; index += 1) fs.writeSync(1, chunk);
const outputIndex = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
`,
  );
  chmodSync(codexPath, 0o755);
  const originalPath = process.env.PATH;
  const originalDecision = process.env.CODEX_DECISION_JSON;
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      summary: "Review survived verbose Codex output.",
      bestSolution: "Keep file-backed process output.",
      closeComment: "",
      workReason: "No additional implementation is required.",
    }),
  );
  try {
    const decision = runCodexForTest({
      item: item({ number: 83395 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "model-test",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 20_000,
      workDir,
      prompt: "Return a review decision.",
    });

    assert.equal(decision.summary, "Review survived verbose Codex output.");
    assert.equal(statSync(join(workDir, "83395.1.codex.stdout.log")).size, 128 * 1024 * 1024);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDecision === undefined) delete process.env.CODEX_DECISION_JSON;
    else process.env.CODEX_DECISION_JSON = originalDecision;
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex failure decisions expose stderr and stdout separately", () => {
  const errorMessage =
    "Rate limit reached for model-test on tokens per min (TPM). Please try again in 1ms.";
  const decision = codexFailureDecisionForTest(
    1,
    "Codex review failed for #278 with exit 1.",
    JSON.stringify({ type: "turn.failed", error: { message: errorMessage } }),
    "user\nThe reviewed prompt discusses rate limits.",
  );

  assert.equal(
    decision.summary,
    "Codex review failed: retryable codex transport failure (capacity) (exit 1).",
  );
  assert.equal(
    decision.evidence.find((entry) => entry.label === "codex stderr")?.detail,
    "user\nThe reviewed prompt discusses rate limits.",
  );
  assert.match(
    decision.evidence.find((entry) => entry.label === "codex stdout")?.detail ?? "",
    /"type":"turn.failed"/,
  );
});

test("codex failure decisions do not infer buffer overflow from reviewed content", () => {
  const terminalError =
    "stream disconnected before completion: The model secret-model-for-test does not exist or you do not have access to it.";
  const decision = codexFailureDecisionForTest(
    1,
    "Codex review failed for #89041 with exit 1.",
    JSON.stringify({ type: "turn.failed", error: { message: terminalError } }),
    "user\nThe reviewed PR discusses maxBufferedChunks and maxBuffer behavior.",
  );

  assert.equal(
    decision.summary,
    "Codex review failed: model unavailable or access denied (exit 1).",
  );
  assert.equal(
    decision.evidence.find((entry) => entry.label === "codex terminal error")?.detail,
    terminalError,
  );
  assert.equal(decision.codexTerminalFailure, true);
});

test("codex failure decisions classify structured ENOBUFS as output overflow", () => {
  const decision = codexFailureDecisionForTest(
    null,
    "Codex review failed before producing output.",
    "",
    "",
    { errorCode: "ENOBUFS", signal: "SIGTERM" },
  );

  assert.equal(decision.summary, "Codex review failed: output buffer overflow.");
  assert.equal(
    decision.evidence.find((entry) => entry.label === "process error code")?.detail,
    "ENOBUFS",
  );
  assert.equal(
    decision.evidence.find((entry) => entry.label === "process signal")?.detail,
    "SIGTERM",
  );
});

test("codex failure decisions ignore unstructured output and prompt stderr", () => {
  const decision = codexFailureDecisionForTest(
    1,
    "Codex review failed for #92565 with exit 1.",
    "ERROR: The model quoted-model does not exist or you do not have access to it.",
    "ERROR: fetch failed",
  );

  assert.equal(decision.summary, "Codex review failed: codex execution failed (exit 1).");
  assert.equal(
    decision.evidence.find((entry) => entry.label === "codex terminal error"),
    undefined,
  );
  assert.equal(decision.codexTerminalFailure, false);
});

test("codex failure decisions trust a final stderr model access denial", () => {
  const terminalError =
    "ERROR: stream disconnected before completion: The model secret-model-for-test does not exist or you do not have access to it.";
  const decision = codexFailureDecisionForTest(
    1,
    "Codex review failed for #92565 with exit 1.",
    "",
    `reviewed patch text\n${terminalError}`,
  );

  assert.equal(
    decision.summary,
    "Codex review failed: model unavailable or access denied (exit 1).",
  );
  assert.equal(
    decision.evidence.find((entry) => entry.label === "codex terminal error")?.detail,
    terminalError,
  );
  assert.equal(decision.codexTerminalFailure, true);
});

test("runCodex retries a transient failure in a fresh process", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const codexHome = join(root, "codex-home");
  const attemptsPath = join(root, "attempts");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  writeFileSync(join(codexHome, "config.toml"), 'model = "secret-model-for-test"\n');
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const attemptsPath = process.env.CODEX_ATTEMPTS_PATH;
const attempt = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, "utf8")) + 1 : 1;
fs.writeFileSync(attemptsPath, String(attempt));
if (attempt === 1) {
  process.stderr.write("user\\nERROR: The model contributor-quoted-model does not exist or you do not have access to it.\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.failed",
    error: {
      message: "stream disconnected: Rate limit reached for secret-model-for-test (for limit test) on tokens per min (TPM). Please try again in 1ms."
    }
  }) + "\\n");
  process.exit(1);
}
const outputIndex = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ATTEMPTS_PATH: process.env.CODEX_ATTEMPTS_PATH,
    CODEX_DECISION_JSON: process.env.CODEX_DECISION_JSON,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ATTEMPTS_PATH = attemptsPath;
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      summary: "Review completed after a fresh Codex process.",
      bestSolution: "Continue the existing review loop.",
      closeComment: "",
      workReason: "No additional implementation is required.",
    }),
  );
  process.env.CODEX_HOME = codexHome;
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "2";
  process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "1";
  try {
    const decision = runCodexForTest({
      item: item({ number: 83394 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "internal",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });

    assert.equal(readFileSync(attemptsPath, "utf8"), "2");
    assert.equal(decision.summary, "Review completed after a fresh Codex process.");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex keeps high reasoning for the final transport retry", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const attemptsPath = join(root, "attempts");
  const attemptTimesPath = join(root, "attempt-times");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = process.argv.find((a) => a.startsWith("model_reasoning_effort="));
const effort = cfg ? cfg.split("=")[1].replace(/"/g, "") : "";
const attemptsPath = process.env.CODEX_ATTEMPTS_PATH;
const n = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, "utf8")) + 1 : 1;
fs.writeFileSync(attemptsPath, String(n));
fs.appendFileSync(process.env.CODEX_ATTEMPT_TIMES_PATH, \`\${Date.now()}\\n\`);
if (effort !== "high") {
  process.stderr.write(\`unexpected reasoning effort: \${effort}\\n\`);
  process.exit(9);
}
if (n < 3) {
  process.stderr.write("Rate limit reached on tokens per min (TPM). Please try again in 100ms.\\n");
  process.exit(1);
}
const outputIndex = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ATTEMPTS_PATH: process.env.CODEX_ATTEMPTS_PATH,
    CODEX_ATTEMPT_TIMES_PATH: process.env.CODEX_ATTEMPT_TIMES_PATH,
    CODEX_DECISION_JSON: process.env.CODEX_DECISION_JSON,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
    CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS: process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ATTEMPTS_PATH = attemptsPath;
  process.env.CODEX_ATTEMPT_TIMES_PATH = attemptTimesPath;
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "close",
      closeReason: "duplicate_or_superseded",
      confidence: "high",
      summary: "Resolved on main already.",
      bestSolution: "Close as superseded.",
      closeComment: "Superseded by main.",
      workReason: "No additional implementation is required.",
    }),
  );
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "2";
  process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "1";
  process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS = "1";
  try {
    const decision = runCodexForTest({
      item: item({ number: 92181 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "internal",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });

    assert.equal(readFileSync(attemptsPath, "utf8"), "3");
    const attemptTimes = readFileSync(attemptTimesPath, "utf8").trim().split("\n").map(Number);
    assert.equal(attemptTimes.length, 3);
    assert.ok((attemptTimes[2] ?? 0) - (attemptTimes[1] ?? 0) >= 90);
    assert.equal(decision.decision, "close");
    assert.equal(decision.confidence, "high");
    assert.equal(decision.summary, "Resolved on main already.");
    assert.equal(
      decision.evidence.some((entry) => entry.label === "degraded review mode"),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex keeps the transport classification when the final high retry also fails", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const attemptsPath = join(root, "attempts");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const attemptsPath = process.env.CODEX_ATTEMPTS_PATH;
const n = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, "utf8")) + 1 : 1;
fs.writeFileSync(attemptsPath, String(n));
process.stderr.write("Rate limit reached on tokens per min (TPM). Please try again in 1ms.\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ATTEMPTS_PATH: process.env.CODEX_ATTEMPTS_PATH,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
    CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS: process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ATTEMPTS_PATH = attemptsPath;
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "2";
  process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "1";
  process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS = "1";
  try {
    assert.throws(
      () =>
        runCodexForTest({
          item: item({ number: 92181 }),
          context: { issue: {}, comments: [], timeline: [] },
          git: { mainSha: "abc123", latestRelease: null },
          model: "internal",
          openclawDir,
          reasoningEffort: "high",
          sandboxMode: "read-only",
          serviceTier: "",
          timeoutMs: 10_000,
          workDir,
          prompt: "Return a review decision.",
        }),
      (error: unknown) => {
        const reviewError = error as Error;
        assert.equal(readFileSync(attemptsPath, "utf8"), "3");
        assert.match(reviewError.message, /Final high-reasoning retry also failed/);
        const failure = codexFailureDecisionForTest(
          1,
          reviewError.message,
          (reviewError as { stdout?: string }).stdout ?? "",
          (reviewError as { stderr?: string }).stderr ?? "",
        );
        assert.match(failure.summary, /retryable codex transport failure \(capacity\)/);
        return true;
      },
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex skips the final high retry when the time budget is too small", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const attemptsPath = join(root, "attempts");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const attemptsPath = process.env.CODEX_ATTEMPTS_PATH;
const n = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, "utf8")) + 1 : 1;
fs.writeFileSync(attemptsPath, String(n));
process.stderr.write("Rate limit reached on tokens per min (TPM). Please try again in 1ms.\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ATTEMPTS_PATH: process.env.CODEX_ATTEMPTS_PATH,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
    CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS: process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ATTEMPTS_PATH = attemptsPath;
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "2";
  process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "1";
  process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS = "10000000";
  try {
    assert.throws(() =>
      runCodexForTest({
        item: item({ number: 92181 }),
        context: { issue: {}, comments: [], timeline: [] },
        git: { mainSha: "abc123", latestRelease: null },
        model: "internal",
        openclawDir,
        reasoningEffort: "high",
        sandboxMode: "read-only",
        serviceTier: "",
        timeoutMs: 10_000,
        workDir,
        prompt: "Return a review decision.",
      }),
    );
    assert.equal(readFileSync(attemptsPath, "utf8"), "2");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex does not retry terminal model access failures", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const attemptsPath = join(root, "attempts");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const attemptsPath = process.env.CODEX_ATTEMPTS_PATH;
const attempt = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, "utf8")) + 1 : 1;
fs.writeFileSync(attemptsPath, String(attempt));
process.stderr.write("reviewed patch text\\n");
process.stderr.write("stream disconnected before completion: The model secret-model-for-test does not exist or you do not have access to it.\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ATTEMPTS_PATH: process.env.CODEX_ATTEMPTS_PATH,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ATTEMPTS_PATH = attemptsPath;
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "3";
  process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "1";
  try {
    assert.throws(
      () =>
        runCodexForTest({
          item: item({ number: 89041 }),
          context: { issue: {}, comments: [], timeline: [] },
          git: { mainSha: "abc123", latestRelease: null },
          model: "internal",
          openclawDir,
          reasoningEffort: "high",
          sandboxMode: "read-only",
          serviceTier: "",
          timeoutMs: 10_000,
          workDir,
          prompt: "Return a review decision.",
        }),
      (error: unknown) => {
        const reviewError = error as Error & { stderr?: string };
        assert.match(reviewError.stderr ?? "", /does not exist or you do not have access/);
        return true;
      },
    );
    assert.equal(readFileSync(attemptsPath, "utf8"), "1");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex failure redaction hides the configured internal model", () => {
  const root = mkdtempSync(tmpPrefix);
  writeFileSync(join(root, "config.toml"), 'model = "secret-model-for-test"\n');
  try {
    const redacted = redactInternalCodexModel(
      "selected secret-model-for-test; Rate limit reached for unknown-model (for limit test)",
      root,
    );
    assert.doesNotMatch(redacted, /secret-model-for-test|unknown-model/);
    assert.equal(redacted.match(/\[REDACTED_INTERNAL_MODEL\]/g)?.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex failure redaction reads the default home configuration", () => {
  const root = mkdtempSync(tmpPrefix);
  const codexHome = join(root, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'model = "default-secret-model"\n');
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAWSWEEPER_INTERNAL_MODEL: process.env.CLAWSWEEPER_INTERNAL_MODEL,
  };
  try {
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.CODEX_HOME;
    delete process.env.CLAWSWEEPER_INTERNAL_MODEL;
    assert.equal(
      redactInternalCodexModel("selected default-secret-model"),
      "selected [REDACTED_INTERNAL_MODEL]",
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
