#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const model = argValue("--model") ?? process.env.CLAWSWEEPER_LOCAL_CODEX_MODEL ?? "gpt-5.6-sol";
const { codexSpawnInvocation } = await loadCodexLauncher();
const codexEnv = { ...process.env, CLAWSWEEPER_PREFER_WINDOWS_CODEX_APP: "1" };
const codex = codexInvocation([]);

console.log(`Codex binary: ${codex.command}${codex.args.length ? ` ${codex.args.join(" ")}` : ""}`);

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

const smoke = runCodex(
  `Running Codex smoke test with ${model}`,
  [
    "exec",
    "-m",
    model,
    "-c",
    'service_tier="fast"',
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    'approval_policy="never"',
    "--sandbox",
    "read-only",
    "-",
  ],
  "Reply with exactly: ok",
);
if (smoke.status !== 0) {
  console.error("Codex exec smoke failed.");
  printTail(smoke);
  printSetupHint();
  process.exit(1);
}

console.log("Codex local preflight passed.");

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
