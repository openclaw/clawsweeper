import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";

import { reviewNetworkCapability, runAgentProcess } from "../dist/agent-runner.js";
import { parseOpenclawJsonEnvelope, runOpenclawProcess } from "../dist/openclaw-process.js";
import { codexProcessErrorCode } from "../dist/codex-process.js";

function fakeOpenclaw(root: string): string {
  const binary = join(root, "fake-openclaw");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const record = {
  args: process.argv.slice(2),
  stateDir: process.env.OPENCLAW_STATE_DIR,
  configPath: process.env.OPENCLAW_CONFIG_PATH,
  workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
  config: JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")),
  prompt: fs.readFileSync(process.argv[process.argv.indexOf("--message-file") + 1], "utf8"),
  env: {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    CLAWSWEEPER_WEBHOOK_SECRET: process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? null,
    CLAWSWEEPER_APP_PRIVATE_KEY: process.env.CLAWSWEEPER_APP_PRIVATE_KEY ?? null,
    KIMI_API_KEY: process.env.KIMI_API_KEY ?? null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
  },
};
fs.writeFileSync(process.env.OPENCLAW_TEST_RECORD, JSON.stringify(record));
if (process.env.OPENCLAW_TEST_READ_PATH) {
  const sessionId = record.args[record.args.indexOf("--session-id") + 1];
  const sessionFile = require("node:path").join(record.stateDir, "agents", "main", "sessions", sessionId + ".jsonl");
  fs.mkdirSync(require("node:path").dirname(sessionFile), { recursive: true });
  const toolCallId = "read-checkout";
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: process.env.OPENCLAW_TEST_READ_PATH } }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        isError: process.env.OPENCLAW_TEST_READ_ERROR === "1",
        content: [{ type: "text", text: "file contents" }],
      },
    },
  ];
  if (process.env.OPENCLAW_TEST_RECEIPT_EXTRA) {
    entries.push(...JSON.parse(process.env.OPENCLAW_TEST_RECEIPT_EXTRA));
  }
  fs.writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
}
process.stderr.write(process.env.OPENCLAW_TEST_STDERR || "");
process.stdout.write(process.env.OPENCLAW_TEST_STDOUT || JSON.stringify({ payloads: [{ text: "done" }], meta: { stopReason: "stop" } }));
`,
  );
  chmodSync(binary, 0o755);
  return binary;
}

test("OpenClaw process emits isolated config and invocation, joins payloads, and cleans state", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const recordPath = join(root, "record.json");
  const binary = fakeOpenclaw(root);
  try {
    const result = runOpenclawProcess({
      label: "Review #42",
      prompt: "Inspect this patch.",
      model: "kimi/kimi-for-coding",
      reasoningEffort: "high",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON: JSON.stringify({
          kimi: {
            baseUrl: "https://api.kimi.com/coding/",
            apiKey: "${KIMI_API_KEY}",
            api: "anthropic-messages",
            models: [{ id: "kimi-for-coding" }],
          },
        }),
        OPENCLAW_TEST_RECORD: recordPath,
        OPENCLAW_TEST_STDOUT: JSON.stringify({
          payloads: [{ text: "first" }, { text: "second" }],
          meta: { stopReason: "stop" },
        }),
      },
      timeoutMs: 12_345,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.equal(result.stdout, "first\nsecond");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.workspaceDir, root);
    assert.equal(record.prompt, "Inspect this patch.");
    assert.deepEqual(record.config, {
      agents: {
        defaults: { skipBootstrap: true, sandbox: { mode: "off" }, timeoutSeconds: 13 },
      },
      tools: {
        profile: "coding",
        fs: { workspaceOnly: true },
        exec: { host: "gateway", mode: "full" },
      },
      models: {
        mode: "merge",
        providers: {
          kimi: {
            baseUrl: "https://api.kimi.com/coding/",
            apiKey: "${KIMI_API_KEY}",
            api: "anthropic-messages",
            // name defaults to the id: OpenClaw config validation requires it.
            models: [{ id: "kimi-for-coding", name: "kimi-for-coding" }],
          },
        },
      },
    });
    assert.deepEqual(record.args.slice(0, 6), [
      "agent",
      "--local",
      "--agent",
      "main",
      "--session-id",
      record.args[5],
    ]);
    assert.match(record.args[5], /^review-42-/);
    assert.equal(record.args[record.args.indexOf("--model") + 1], "kimi/kimi-for-coding");
    assert.equal(record.args[record.args.indexOf("--timeout") + 1], "13");
    assert.equal(record.args[record.args.indexOf("--thinking") + 1], "high");
    assert.equal(record.args.at(-1), "--json");
    assert.equal(existsSync(record.stateDir), false);
    assert.equal(existsSync(record.configPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw checkout inspection requires structured read evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const recordPath = join(root, "record.json");
  const binary = fakeOpenclaw(root);
  const checkoutInspection = {
    expectedText: "tracked checkout content",
    expectedPath: "tracked.txt",
  };
  try {
    const result = runOpenclawProcess({
      label: "checkout-inspection",
      prompt: "Read the challenged line.",
      model: "openai/test",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        OPENCLAW_TEST_RECORD: recordPath,
        OPENCLAW_TEST_READ_PATH: "tracked.txt",
        OPENCLAW_TEST_STDOUT: JSON.stringify({
          payloads: [{ text: "tracked checkout content" }],
          meta: { stopReason: "stop" },
        }),
      },
      timeoutMs: 10_000,
      checkoutInspection,
    });
    assert.equal(result.status, 0, result.error?.message);
    assert.equal(result.stdout, "");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(record.config.tools, {
      allow: ["read"],
      fs: { workspaceOnly: true },
      exec: { host: "gateway", mode: "deny" },
    });

    const wrongText = runOpenclawProcess({
      label: "checkout-inspection-wrong-text",
      prompt: "Read the challenged line.",
      model: "openai/test",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        OPENCLAW_TEST_RECORD: recordPath,
        OPENCLAW_TEST_READ_PATH: "tracked.txt",
        OPENCLAW_TEST_STDOUT: JSON.stringify({
          payloads: [{ text: "different checkout content" }],
          meta: { stopReason: "stop" },
        }),
      },
      timeoutMs: 10_000,
      checkoutInspection,
    });
    assert.equal(wrongText.status, 1);
    assert.match(wrongText.error?.message ?? "", /runner challenge/);

    const wrongReadPath = runOpenclawProcess({
      label: "checkout-inspection-wrong-path",
      prompt: "Read the challenged line.",
      model: "openai/test",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        OPENCLAW_TEST_RECORD: recordPath,
        OPENCLAW_TEST_READ_PATH: "different.txt",
        OPENCLAW_TEST_STDOUT: JSON.stringify({
          payloads: [{ text: "tracked checkout content" }],
          meta: { stopReason: "stop" },
        }),
      },
      timeoutMs: 10_000,
      checkoutInspection,
    });
    assert.equal(wrongReadPath.status, 1);
    assert.match(wrongReadPath.error?.message ?? "", /exact challenged path/);

    const failedRead = runOpenclawProcess({
      label: "checkout-inspection-failed-read",
      prompt: "Read the challenged line.",
      model: "openai/test",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        OPENCLAW_TEST_RECORD: recordPath,
        OPENCLAW_TEST_READ_PATH: "tracked.txt",
        OPENCLAW_TEST_READ_ERROR: "1",
        OPENCLAW_TEST_STDOUT: JSON.stringify({
          payloads: [{ text: "tracked checkout content" }],
          meta: { stopReason: "stop" },
        }),
      },
      timeoutMs: 10_000,
      checkoutInspection,
    });
    assert.equal(failedRead.status, 1);
    assert.match(failedRead.error?.message ?? "", /exact challenged path/);

    for (const [label, extraReceipt] of [
      [
        "non-read tool",
        [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "exec-after-read", name: "exec", arguments: {} }],
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "exec-after-read",
              toolName: "exec",
              isError: false,
              content: [],
            },
          },
        ],
      ],
      [
        "failed later read",
        [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "failed-read-after-success",
                  name: "read",
                  arguments: { path: "tracked.txt" },
                },
              ],
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "failed-read-after-success",
              toolName: "read",
              isError: true,
              content: [],
            },
          },
        ],
      ],
    ] as const) {
      const mixedReceipt = runOpenclawProcess({
        label: `checkout-inspection-${label}`,
        prompt: "Read the challenged line.",
        model: "openai/test",
        cwd: root,
        env: {
          ...process.env,
          CLAWSWEEPER_OPENCLAW_BIN: binary,
          OPENCLAW_TEST_RECORD: recordPath,
          OPENCLAW_TEST_READ_PATH: "tracked.txt",
          OPENCLAW_TEST_RECEIPT_EXTRA: JSON.stringify(extraReceipt),
          OPENCLAW_TEST_STDOUT: JSON.stringify({
            payloads: [{ text: "tracked checkout content" }],
            meta: { stopReason: "stop" },
          }),
        },
        timeoutMs: 10_000,
        checkoutInspection,
      });
      assert.equal(mixedReceipt.status, 1, label);
      assert.match(mixedReceipt.error?.message ?? "", /exact challenged path/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw exit-zero error envelopes synthesize process failures", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const binary = fakeOpenclaw(root);
  try {
    for (const [name, envelope, expected] of [
      [
        "meta error",
        { payloads: [], meta: { error: { message: "provider unavailable" } } },
        /provider unavailable/,
      ],
      [
        "error payload",
        { payloads: [{ text: "tool failed", isError: true }], meta: {} },
        /tool failed/,
      ],
      [
        "fallback exhaustion",
        { payloads: [], meta: { executionTrace: { exhausted: true } } },
        /fallbacks were exhausted/,
      ],
    ] as const) {
      const result = runOpenclawProcess({
        label: name,
        prompt: "prompt",
        model: "openai/test",
        cwd: root,
        env: {
          ...process.env,
          CLAWSWEEPER_OPENCLAW_BIN: binary,
          OPENCLAW_TEST_RECORD: join(root, `${name}.json`),
          OPENCLAW_TEST_STDOUT: JSON.stringify(envelope),
        },
        timeoutMs: 10_000,
      });
      assert.equal(result.status, 1);
      assert.match(result.error?.message ?? "", expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw timeout stop reasons are exposed as ETIMEDOUT", () => {
  const parsed = parseOpenclawJsonEnvelope(
    JSON.stringify({ payloads: [], meta: { aborted: true, stopReason: "timeout" } }),
  );
  assert.match(parsed.failure?.message ?? "", /timeout/);

  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const binary = fakeOpenclaw(root);
  try {
    const result = runOpenclawProcess({
      label: "timeout",
      prompt: "prompt",
      model: "openai/test",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        OPENCLAW_TEST_RECORD: join(root, "timeout.json"),
        OPENCLAW_TEST_STDOUT: JSON.stringify({
          payloads: [],
          meta: { aborted: true, stopReason: "timeout" },
        }),
      },
      timeoutMs: 10_000,
    });
    assert.equal(result.status, 1);
    assert.equal(codexProcessErrorCode(result.error), "ETIMEDOUT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw invalid JSON fails closed with a bounded stderr tail", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const binary = fakeOpenclaw(root);
  try {
    const result = runOpenclawProcess({
      label: "invalid-json",
      prompt: "prompt",
      model: "openai/test",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        OPENCLAW_TEST_RECORD: join(root, "invalid.json"),
        OPENCLAW_TEST_STDOUT: "not-json",
        OPENCLAW_TEST_STDERR: `${"x".repeat(12_000)}stderr-tail-marker`,
      },
      timeoutMs: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.error?.message ?? "", /invalid JSON/);
    assert.match(result.error?.message ?? "", /stderr-tail-marker/);
    assert.ok(Buffer.byteLength(result.error?.message ?? "") < 9 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw runner writes the normalized last message and notes ignored steering", (t) => {
  useFakeScanner(t);
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const binary = fakeOpenclaw(root);
  const outputPath = join(root, "last-message.txt");
  try {
    const result = runAgentProcess({
      label: "steerable-openclaw",
      scanSource: { kind: "prompt" },
      prompt: "prompt",
      model: "internal",
      reasoningEffort: "medium",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_RUNNER: "openclaw",
        CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        OPENCLAW_TEST_RECORD: join(root, "steerable.json"),
      },
      timeoutMs: 10_000,
      codexExtraArgs: ["--output-last-message", outputPath, "--json", "-"],
      appServer: { statePath: join(root, "thread.json") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(outputPath, "utf8"), "done");
    assert.equal(result.stderr.match(/CLAWSWEEPER_STEERABLE_CODEX is Codex-specific/g)?.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw provider config rejects malformed and non-object JSON without echoing it", () => {
  for (const value of ["{secret-api-key", "[]"]) {
    const result = runOpenclawProcess({
      label: "bad-provider-config",
      prompt: "prompt",
      model: "openai/test",
      cwd: process.cwd(),
      env: { CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON: value },
      timeoutMs: 1_000,
    });
    assert.match(result.error?.message ?? "", /CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON/);
    assert.doesNotMatch(result.error?.message ?? "", /secret-api-key/);
  }
});

test("OpenClaw kimi models get built-in provider defaults when none are configured", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const recordPath = join(root, "record.json");
  const binary = fakeOpenclaw(root);
  try {
    const result = runOpenclawProcess({
      label: "kimi-defaults",
      prompt: "hi",
      model: "kimi/k3",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        CLAWSWEEPER_OPENCLAW_MODEL: "kimi/k3",
        CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON: "",
        OPENCLAW_TEST_RECORD: recordPath,
      },
      timeoutMs: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(record.config.models, {
      mode: "merge",
      providers: {
        kimi: {
          baseUrl: "https://api.kimi.com/coding/",
          apiKey: "${KIMI_API_KEY}",
          api: "anthropic-messages",
          models: [
            { id: "kimi-for-coding", name: "Kimi Code", contextWindow: 262144, maxTokens: 65536 },
            { id: "k3", name: "Kimi K3", contextWindow: 1048576, maxTokens: 131072 },
          ],
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw non-kimi models get no built-in provider block", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const recordPath = join(root, "record.json");
  const binary = fakeOpenclaw(root);
  try {
    const result = runOpenclawProcess({
      label: "no-defaults",
      prompt: "hi",
      model: "openai/gpt-5.6-sol",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        CLAWSWEEPER_OPENCLAW_MODEL: "openai/gpt-5.6-sol",
        OPENCLAW_TEST_RECORD: recordPath,
      },
      timeoutMs: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.config.models, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw subprocess env strips workflow credentials and keeps provider keys", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const recordPath = join(root, "record.json");
  const binary = fakeOpenclaw(root);
  try {
    const env = {
      ...process.env,
      CLAWSWEEPER_OPENCLAW_BIN: binary,
      OPENCLAW_TEST_RECORD: recordPath,
      GITHUB_TOKEN: "workflow-github",
      GH_TOKEN: "workflow-gh",
      CLAWSWEEPER_WEBHOOK_SECRET: "workflow-webhook",
      CLAWSWEEPER_APP_PRIVATE_KEY: "workflow-app",
      KIMI_API_KEY: "provider-kimi",
    };
    const capability = reviewNetworkCapability("clawsweeper-review", {
      ...env,
      CLAWSWEEPER_RUNNER: "openclaw",
    });
    const result = runOpenclawProcess({
      label: "env-allowlist",
      prompt: JSON.stringify(capability),
      model: "kimi/k3",
      cwd: root,
      env,
      timeoutMs: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.env.GITHUB_TOKEN, null);
    assert.equal(record.env.GH_TOKEN, null);
    assert.equal(capability.hasGitHubToken, Boolean(record.env.GH_TOKEN));
    assert.deepEqual(JSON.parse(record.prompt), capability);
    assert.equal(record.env.CLAWSWEEPER_WEBHOOK_SECRET, null);
    assert.equal(record.env.CLAWSWEEPER_APP_PRIVATE_KEY, null);
    assert.equal(record.env.KIMI_API_KEY, "provider-kimi");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw cerebras models get built-in provider defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const recordPath = join(root, "record.json");
  const binary = fakeOpenclaw(root);
  try {
    const result = runOpenclawProcess({
      label: "cerebras-defaults",
      prompt: "hi",
      model: "cerebras/zai-glm-4.7",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        CLAWSWEEPER_OPENCLAW_MODEL: "cerebras/zai-glm-4.7",
        OPENCLAW_TEST_RECORD: recordPath,
      },
      timeoutMs: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(record.config.models, {
      mode: "merge",
      providers: {
        cerebras: {
          baseUrl: "https://api.cerebras.ai/v1",
          apiKey: "${CEREBRAS_API_KEY}",
          api: "openai-completions",
          models: [
            { id: "zai-glm-4.7", name: "Z.ai GLM 4.7", contextWindow: 128000, maxTokens: 8192 },
          ],
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw zai models get built-in Coding Plan endpoint defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const recordPath = join(root, "record.json");
  const binary = fakeOpenclaw(root);
  try {
    const result = runOpenclawProcess({
      label: "zai-defaults",
      prompt: "hi",
      model: "zai/glm-5.2",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        CLAWSWEEPER_OPENCLAW_MODEL: "zai/glm-5.2",
        OPENCLAW_TEST_RECORD: recordPath,
      },
      timeoutMs: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(record.config.models, {
      mode: "merge",
      providers: {
        zai: {
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          apiKey: "${ZAI_API_KEY}",
          api: "openai-completions",
          models: [{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 1000000, maxTokens: 131072 }],
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
