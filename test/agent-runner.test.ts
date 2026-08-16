import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  agentRunner,
  codexAgentArgs,
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

test("agent runner preserves review-style Codex argument composition", () => {
  assert.deepEqual(
    codexAgentArgs({
      label: "review-42",
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

test("runAgentProcess delegates the default path to Codex with unchanged argv and stdin", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-test-"));
  const binary = join(root, "fake-codex");
  const argsPath = join(root, "args.json");
  const promptPath = join(root, "prompt.txt");
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
      prompt: "prompt over stdin",
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
      codexExtraArgs: ["--sandbox", "read-only", "-"],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
      "exec",
      "-c",
      'model_reasoning_effort="low"',
      "--sandbox",
      "read-only",
      "-",
    ]);
    assert.equal(readFileSync(promptPath, "utf8"), "prompt over stdin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw runner requires a provider/model override", () => {
  assert.throws(
    () =>
      runAgentProcess({
        label: "missing-model",
        prompt: "prompt",
        model: "internal",
        cwd: process.cwd(),
        env: { CLAWSWEEPER_RUNNER: "openclaw" },
        timeoutMs: 1_000,
      }),
    /CLAWSWEEPER_OPENCLAW_MODEL is required/,
  );
});

test("OpenClaw checkout inspection uses a disposable path-bound challenge", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-test-"));
  const binary = join(root, "fake-openclaw");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "empty",
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
const challenged = fs.readFileSync(path.join(process.env.OPENCLAW_WORKSPACE_DIR, relativePath), "utf8").trim();
const text = process.env.OPENCLAW_TEST_DIFFERENT_PATH === "1" ? "content from another file" : challenged;
process.stdout.write(JSON.stringify({
  payloads: [{ text }],
  meta: { stopReason: "stop", toolSummary: { calls: 1, tools: ["read"], failures: 0 } },
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
    const verified = runAgentCheckoutInspection({ cwd: root, env: baseEnv, timeoutMs: 10_000 });
    assert.equal(verified.status, 0, verified.error?.message);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.startsWith(".clawsweeper-checkout-inspection-")),
      [],
    );

    const wrongPath = runAgentCheckoutInspection({
      cwd: root,
      env: { ...baseEnv, OPENCLAW_TEST_DIFFERENT_PATH: "1" },
      timeoutMs: 10_000,
    });
    assert.equal(wrongPath.status, 1);
    assert.match(wrongPath.error?.message ?? "", /runner challenge/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw checkout inspection reports challenge setup failures", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-agent-runner-missing-test-"));
  try {
    const result = runAgentCheckoutInspection({
      cwd: join(root, "missing"),
      env: {
        ...process.env,
        CLAWSWEEPER_RUNNER: "openclaw",
        CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
      },
      timeoutMs: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.error?.message ?? "", /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
