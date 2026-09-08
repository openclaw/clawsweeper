import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";

import {
  agentRunner,
  codexAgentArgs,
  reviewNetworkCapability,
  runAgentCheckoutInspection,
  runAgentProcess,
} from "../dist/agent-runner.js";

test("agent runner defaults to Codex and fails closed on unknown values", () => {
  assert.equal(agentRunner({}), "codex");
  assert.equal(agentRunner({ CLAWSWEEPER_RUNNER: "codex" }), "codex");
  assert.equal(agentRunner({ CLAWSWEEPER_RUNNER: "openclaw" }), "openclaw");
  assert.throws(
    () => agentRunner({ CLAWSWEEPER_RUNNER: "claude" }),
    /Invalid CLAWSWEEPER_RUNNER.*codex.*openclaw/,
  );
});

test("review network capability follows the selected runner before the Codex sandbox", () => {
  assert.equal(
    reviewNetworkCapability("clawsweeper-review", {}).networkCapability,
    "allowlisted-proxy",
  );
  assert.equal(
    reviewNetworkCapability("clawsweeper-review", { CLAWSWEEPER_RUNNER: " codex " })
      .networkCapability,
    "allowlisted-proxy",
  );
  for (const sandboxMode of ["clawsweeper-review", "read-only", "workspace-write"]) {
    assert.equal(
      reviewNetworkCapability(sandboxMode, { CLAWSWEEPER_RUNNER: " openclaw " }).networkCapability,
      "unrestricted",
    );
  }
  for (const sandboxMode of ["read-only", "workspace-write", "danger-full-access", ""]) {
    assert.equal(
      reviewNetworkCapability(sandboxMode, { CLAWSWEEPER_RUNNER: "codex" }).networkCapability,
      "none",
    );
  }
  assert.throws(
    () => reviewNetworkCapability("clawsweeper-review", { CLAWSWEEPER_RUNNER: "unknown" }),
    /Invalid CLAWSWEEPER_RUNNER/,
  );
});

test("review token capability uses only the supplied child GH_TOKEN", () => {
  for (const runner of ["codex", "openclaw"]) {
    for (const sandboxMode of ["clawsweeper-review", "read-only"]) {
      for (const token of [undefined, "", "   ", "synthetic-inspection-token"]) {
        assert.equal(
          reviewNetworkCapability(sandboxMode, {
            CLAWSWEEPER_RUNNER: runner,
            GH_TOKEN: token,
            GITHUB_TOKEN: "synthetic-ambient-token",
            CLAWSWEEPER_PROOF_INSPECTION_TOKEN: "synthetic-source-token",
          }).hasGitHubToken,
          runner === "codex" && Boolean(token?.trim()),
        );
      }
    }
  }
});

test("agent runner preserves review-style Codex argument composition", () => {
  assert.deepEqual(
    codexAgentArgs({
      label: "review-42",
      scanSource: { kind: "prompt" },
      prompt: "review",
      model: "gpt-public",
      reasoningEffort: "high",
      cwd: "/tmp",
      env: {},
      timeoutMs: 1_000,
      codexExtraArgs: [
        "-c",
        'forced_login_method="api"',
        "-c",
        'approval_policy="never"',
        "-C",
        "/target",
        "--output-schema",
        "/schema.json",
        "--output-last-message",
        "/answer.json",
        "--json",
        "-",
      ],
    }),
    [
      "exec",
      "--model",
      "gpt-public",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'forced_login_method="api"',
      "-c",
      'approval_policy="never"',
      "-C",
      "/target",
      "--output-schema",
      "/schema.json",
      "--output-last-message",
      "/answer.json",
      "--json",
      "-",
    ],
  );
});

test("agent runner preserves ordered repair-worker Codex arguments", () => {
  const ordered = [
    "--cd",
    "/target",
    "--model",
    "gpt-public",
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "-c",
    'model_reasoning_effort="high"',
    "--json",
    "-",
  ];
  assert.deepEqual(
    codexAgentArgs({
      label: "repair",
      scanSource: { kind: "prompt" },
      prompt: "repair",
      model: "gpt-public",
      reasoningEffort: "high",
      cwd: "/target",
      env: {},
      timeoutMs: 1_000,
      codexExtraArgs: ordered,
    }),
    ["exec", ...ordered],
  );
});

test("runAgentProcess delegates the default path to Codex with unchanged argv and stdin", (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-test-"));
  const binary = join(root, "fake-codex");
  const argsPath = join(root, "args.json");
  const promptPath = join(root, "prompt.txt");
  const diagnosticPromptPath = join(root, "diagnostic.prompt.md");
  const schemaPath = join(root, "schema.json");
  const prompt = "prompt over stdin\r\n🦞 exact bytes\n";
  const schema = '{"type":"object","description":"exact schema bytes"}\n';
  writeFileSync(schemaPath, schema);
  writeFileSync(diagnosticPromptPath, "stale prompt", { mode: 0o644 });
  useFakeScanner(
    t,
    `
assert.equal(fs.existsSync(${JSON.stringify(diagnosticPromptPath)}), false);
assert.equal(inputs.find(({name}) => name === 'prompt').bytes.toString(), ${JSON.stringify(prompt)});
assert.equal(inputs.find(({name}) => name === 'schema').bytes.toString(), ${JSON.stringify(schema)});
`,
  );
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.AGENT_RUNNER_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.env.AGENT_RUNNER_PROMPT_PATH, fs.readFileSync(0, "utf8"));
process.stdout.write("ok");
`,
  );
  chmodSync(binary, 0o755);
  try {
    const result = runAgentProcess({
      label: "default-codex",
      scanSource: { kind: "prompt" },
      prompt,
      diagnosticPromptPath,
      model: "internal",
      reasoningEffort: "low",
      cwd: root,
      env: {
        ...process.env,
        CODEX_BIN: binary,
        AGENT_RUNNER_ARGS_PATH: argsPath,
        AGENT_RUNNER_PROMPT_PATH: promptPath,
      },
      timeoutMs: 10_000,
      codexExtraArgs: ["--sandbox", "read-only", "--output-schema", schemaPath, "-"],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
      "exec",
      "-c",
      'model_reasoning_effort="low"',
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaPath,
      "-",
    ]);
    assert.equal(readFileSync(promptPath, "utf8"), prompt);
    assert.equal(readFileSync(diagnosticPromptPath, "utf8"), prompt);
    assert.equal(statSync(diagnosticPromptPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(schemaPath, "utf8"), schema);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw runner requires a provider/model override", () => {
  assert.throws(
    () =>
      runAgentProcess({
        label: "missing-model",
        scanSource: { kind: "prompt" },
        prompt: "prompt",
        model: "internal",
        cwd: process.cwd(),
        env: { CLAWSWEEPER_RUNNER: "openclaw" },
        timeoutMs: 1_000,
      }),
    /CLAWSWEEPER_OPENCLAW_MODEL is required/,
  );
});

test("OpenClaw checkout inspection attests the exact tracked path without checkout writes", (t) => {
  useFakeScanner(t);
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-test-"));
  const binary = join(root, "fake-openclaw");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const trackedPath = join(root, "tracked.txt");
  writeFileSync(trackedPath, "first line\ntracked checkout content\nlast line\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "tracked text",
    ],
    { cwd: root },
  );
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const prompt = fs.readFileSync(process.argv[process.argv.indexOf("--message-file") + 1], "utf8");
const relativePath = JSON.parse(prompt.match(/^Path: (.+)$/m)[1]);
const lineNumber = Number(prompt.match(/^Return exactly line (\\d+)/m)[1]);
const challenged = fs.readFileSync(path.join(process.env.OPENCLAW_WORKSPACE_DIR, relativePath), "utf8").split(/\\r?\\n/)[lineNumber - 1].trim();
const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
const sessionFile = path.join(process.env.OPENCLAW_STATE_DIR, "agents", "main", "sessions", sessionId + ".jsonl");
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
if (process.env.OPENCLAW_TEST_NO_RECEIPT !== "1") {
  const toolCallId = "read-checkout";
  const readPath = process.env.OPENCLAW_TEST_DIFFERENT_PATH === "1" ? "different.txt" : relativePath;
  const entries = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: readPath } }] } },
    { type: "message", message: { role: "toolResult", toolCallId, toolName: "read", isError: false, content: [{ type: "text", text: challenged }] } },
  ];
  fs.writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
}
process.stdout.write(JSON.stringify({
  payloads: [{ text: challenged }],
  meta: { stopReason: "stop" },
}));
`,
  );
  chmodSync(binary, 0o755);
  const baseEnv = {
    ...process.env,
    CLAWSWEEPER_RUNNER: "openclaw",
    CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
    CLAWSWEEPER_OPENCLAW_BIN: binary,
  };
  try {
    chmodSync(trackedPath, 0o444);
    chmodSync(root, 0o555);
    const scan = { scanSource: { kind: "prompt" as const }, initialPrompt: "Review the checkout." };
    const verified = runAgentCheckoutInspection({
      ...scan,
      cwd: root,
      env: baseEnv,
      timeoutMs: 10_000,
    });
    assert.equal(verified.status, 0, verified.error?.message);

    const wrongPath = runAgentCheckoutInspection({
      ...scan,
      cwd: root,
      env: { ...baseEnv, OPENCLAW_TEST_DIFFERENT_PATH: "1" },
      timeoutMs: 10_000,
    });
    assert.equal(wrongPath.status, 1);
    assert.match(wrongPath.error?.message ?? "", /exact challenged path/);

    const missingReceipt = runAgentCheckoutInspection({
      ...scan,
      cwd: root,
      env: { ...baseEnv, OPENCLAW_TEST_NO_RECEIPT: "1" },
      timeoutMs: 10_000,
    });
    assert.equal(missingReceipt.status, 1);
    assert.match(missingReceipt.error?.message ?? "", /exact challenged path/);
  } finally {
    chmodSync(root, 0o755);
    chmodSync(trackedPath, 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw checkout inspection reports challenge setup failures", (t) => {
  useFakeScanner(t);
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-missing-test-"));
  try {
    const result = runAgentCheckoutInspection({
      scanSource: { kind: "prompt" },
      initialPrompt: "Inspect checkout.",
      cwd: join(root, "missing"),
      env: {
        ...process.env,
        CLAWSWEEPER_RUNNER: "openclaw",
        CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
      },
      timeoutMs: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.error?.message ?? "", /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkout inspection lists tracked files beyond the 1 MB spawn default", (t) => {
  useFakeScanner(t);
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-large-index-test-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: "tracked checkout content\n",
      encoding: "utf8",
    }).trim();
    // Index-only entries: ~6000 x 220-byte paths push `git ls-files --stage -z` past 1 MB.
    const indexInfo = Array.from(
      { length: 6000 },
      (_, index) => `100644 blob ${blob}\t${"deep/".repeat(40)}file-${index}.txt\n`,
    ).join("");
    execFileSync("git", ["update-index", "--index-info"], { cwd: root, input: indexInfo });
    const listing = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.ok(listing.length > 1024 * 1024, `listing is ${listing.length} bytes`);

    const result = runAgentCheckoutInspection({
      scanSource: { kind: "prompt" },
      initialPrompt: "Inspect checkout.",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_RUNNER: "openclaw",
        CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
      },
      timeoutMs: 30_000,
    });
    assert.notEqual(result.error?.code, "ENOBUFS", result.error?.message);
    assert.match(result.error?.message ?? "", /could not select a tracked text line/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
