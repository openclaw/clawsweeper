#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtime =
  process.env.CLAWSWEEPER_MODEL_RUNTIME?.trim().toLowerCase() === "claude" ? "claude" : "codex";
const model =
  argValue("--model") ??
  (runtime === "claude"
    ? (process.env.CLAWSWEEPER_LOCAL_CLAUDE_MODEL ?? "claude-opus-5")
    : (process.env.CLAWSWEEPER_LOCAL_CODEX_MODEL ?? "gpt-5.6-sol"));
const { codexSpawnInvocation } = await loadCodexLauncher();
const codexEnv = { ...process.env };
const codex = codexInvocation([]);
const runtimeName = runtime === "claude" ? "Claude CLI" : "Codex";

console.log(
  `${runtimeName} command: ${codex.command}${codex.args.length ? ` ${codex.args.join(" ")}` : ""}`,
);

if (runtime === "codex") {
  const status = runCodex("Checking Codex login status", [
    "login",
    "status",
    "-c",
    'service_tier="fast"',
  ]);
  if (status.status !== 0) {
    console.error("Codex login status failed.");
    printTail(status);
    printSetupHint();
    process.exit(1);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "clawsweeper-model-check-"));
const outputPath = join(workDir, "result.txt");
try {
  const smoke = runCodex(
    `Running ${runtimeName} smoke test with ${model}`,
    [
      "exec",
      "-m",
      model,
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'approval_policy="never"',
      "--sandbox",
      "read-only",
      "--disable",
      "shell_tool",
      "--output-last-message",
      outputPath,
      "-",
    ],
    "Reply with exactly: ok",
  );
  if (smoke.status !== 0) {
    console.error(`${runtimeName} smoke failed.`);
    printTail(smoke);
    printSetupHint();
    process.exit(1);
  }
  const output = readFileSync(outputPath, "utf8").trim().toLowerCase();
  if (output !== "ok") {
    console.error(`${runtimeName} smoke returned an unexpected response: ${output || "<empty>"}`);
    process.exit(1);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`${runtimeName} local preflight passed.`);

function argValue(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

async function loadCodexLauncher() {
  try {
    return await import("../dist/codex-process.js");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_MODULE_NOT_FOUND"
    ) {
      console.error("Built Codex launcher module not found. Run `pnpm run build` and retry.");
      process.exit(1);
    }
    throw error;
  }
}

function codexInvocation(args) {
  return codexSpawnInvocation(args, codexEnv, process.platform, process.cwd());
}

function runCodex(label, args, input = "") {
  const invocation = codexInvocation(args);
  const startedAt = Date.now();
  console.log(`${label}...`);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: codexEnv,
    input,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  console.log(`${label} completed in ${formatElapsed(Date.now() - startedAt)}.`);
  return {
    status: result.status,
    error: result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function formatElapsed(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function printTail(result) {
  if (result.error) console.error(result.error.message);
  const text = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  if (text) console.error(tail(text, 3000));
}

function tail(text, maxChars) {
  return text.length <= maxChars ? text : `...${text.slice(text.length - maxChars)}`;
}

function printSetupHint() {
  if (runtime === "claude") {
    console.error(`
Configure Claude CLI with one supported provider, then retry:

  Anthropic: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
  Bedrock: CLAUDE_CODE_USE_BEDROCK=1 plus AWS credentials
  Vertex: CLAUDE_CODE_USE_VERTEX=1 plus Google application credentials
  Foundry: CLAUDE_CODE_USE_FOUNDRY=1 plus Foundry credentials

Set CLAUDE_BIN when the Claude CLI is not on PATH.
`);
    return;
  }
  const apiKeySetup =
    process.platform === "win32"
      ? `$env:OPENAI_API_KEY = Read-Host "OpenAI API key"
  $env:OPENAI_API_KEY | codex login --with-api-key -c 'service_tier="fast"'
  Remove-Item Env:OPENAI_API_KEY`
      : `printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key -c 'service_tier="fast"'
  unset OPENAI_API_KEY`;
  console.error(`
Set up Codex CLI auth without committing secrets:

  codex login --device-auth -c 'service_tier="fast"'

Or store an API key in the Codex CLI auth store:

  ${apiKeySetup}

If your Codex binary is not on PATH, set CODEX_BIN to the full local executable path before rerunning this check.
`);
}
