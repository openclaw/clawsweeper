import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";

import { reviewNetworkCapability, runAgentProcess } from "../dist/agent-runner.js";
import {
  parseOpenclawJsonEnvelope,
  runOpenclawProcess,
  retireOpenclawRoleStates,
} from "../dist/openclaw-process.js";
import { codexProcessErrorCode } from "../dist/codex-process.js";

const OPENCLAW_PROCESS_WORKER_PATH = fileURLToPath(
  new URL("../dist/openclaw-process-worker.js", import.meta.url),
);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  // A killed orphan stays a zombie until PID 1 reaps it, and kill(pid, 0) still succeeds
  // for zombies; treat an exited-but-unreaped process as gone.
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const stat = (state.stdout ?? "").trim();
  return stat.length > 0 && !stat.startsWith("Z");
}

function fakeOpenclaw(root: string): string {
  const binary = join(root, "fake-openclaw");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "sandbox") process.exit(0);
if (process.argv[2] === "sessions") {
  if (!process.env.OPENCLAW_TEST_SQLITE_EXPORT) process.exit(4);
  if (process.env.OPENCLAW_TEST_HANG_EXPORT) {
    const cp = require("node:child_process");
    const child = cp.spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:"ignore"});
    fs.writeFileSync(process.env.OPENCLAW_TEST_HANG_EXPORT, JSON.stringify({pid:process.pid, child:child.pid}));
    process.on("SIGTERM",()=>{});
    setInterval(()=>{},1000);
    return;
  }
  const path = require("node:path");
  const key = process.argv[process.argv.indexOf("--session-key") + 1];
  const sessionId = key.slice("agent:main:explicit:".length);
  const outputDir = path.join(process.env.OPENCLAW_STATE_DIR, ".openclaw", "trajectory-exports", "checkout-receipt");
  fs.mkdirSync(outputDir, { recursive: true });
  const entries = JSON.parse(fs.readFileSync(path.join(process.env.OPENCLAW_STATE_DIR, "export-entries.json"), "utf8"));
  const events = entries.flatMap(({message}) => {
    if (message.role === "assistant") return message.content.filter(c => c.type === "toolCall").map(c => ({type: "tool.call", data: {toolCallId: c.id, name: c.name, arguments: c.arguments}}));
    return message.role === "toolResult" ? [{type: "tool.result", data: {message}}] : [];
  }).map(e => ({traceSchema: "openclaw-trajectory", schemaVersion: 1, sessionId, source: "transcript", ...e}));
  fs.writeFileSync(path.join(outputDir, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\\n") + "\\n");
  fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify({sessionId: process.env.OPENCLAW_TEST_WRONG_EXPORT_ID ? "wrong-session" : sessionId, eventCount: events.length}));
  console.log(JSON.stringify({sessionId, outputDir}));
  process.exit(0);
}
const record = {
  args: process.argv.slice(2),
  stateDir: process.env.OPENCLAW_STATE_DIR,
  configPath: process.env.OPENCLAW_CONFIG_PATH,
  workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
  optionalGitLocks: process.env.GIT_OPTIONAL_LOCKS,
  config: JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")),
  prompt: fs.readFileSync(process.argv[process.argv.indexOf("--message-file") + 1], "utf8"),
  env: {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    CLAWSWEEPER_WEBHOOK_SECRET: process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? null,
    CLAWSWEEPER_APP_PRIVATE_KEY: process.env.CLAWSWEEPER_APP_PRIVATE_KEY ?? null,
    KIMI_API_KEY: process.env.KIMI_API_KEY ?? null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? null,
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null,
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
if (process.env.OPENCLAW_TEST_SQLITE_EXPORT) {
  fs.writeFileSync(require("node:path").join(record.stateDir, "export-entries.json"), JSON.stringify(entries));
} else {
  fs.writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
}
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
    assert.equal(record.optionalGitLocks, "0");
    assert.equal(record.prompt, "Inspect this patch.");
    assert.deepEqual(record.config, {
      agents: {
        defaults: {
          skipBootstrap: true,
          workspace: root,
          sandbox: { mode: "off" },
          timeoutSeconds: 13,
        },
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
      codeMode: false,
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

test("OpenClaw canonical export preserves exact read and session binding", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-export-test-"));
  const binary = fakeOpenclaw(root);
  try {
    for (const mode of [
      "valid",
      "wrong-session",
      "wrong-path",
      "failed-read",
      "home",
      "profile",
      "same-home",
      "ambiguous-home",
      "wrong-home-path",
      "missing-home",
      "near-prefix",
      "wrong-workspace",
      "wrong-state",
    ]) {
      const recordPath = join(root, mode + ".json");
      const result = runOpenclawProcess({
        label: mode,
        prompt: "read the tracked file",
        model: "openai/test",
        cwd: root,
        env: {
          ...process.env,
          CLAWSWEEPER_OPENCLAW_BIN: binary,
          OPENCLAW_TEST_RECORD: recordPath,
          OPENCLAW_TEST_SQLITE_EXPORT: "1",
          OPENCLAW_TEST_WRONG_EXPORT_ID: mode === "wrong-session" ? "1" : "",
          OPENCLAW_TEST_READ_ERROR: mode === "failed-read" ? "1" : "",
          HOME: ["profile", "missing-home"].includes(mode) ? undefined : root,
          USERPROFILE: ["profile", "same-home"].includes(mode)
            ? root
            : mode === "ambiguous-home"
              ? join(root, "other-home")
              : undefined,
          OPENCLAW_TEST_READ_PATH:
            mode === "wrong-path"
              ? "other.txt"
              : mode === "wrong-home-path"
                ? "~/other.txt"
                : mode === "near-prefix"
                  ? "~other/tracked.txt"
                  : mode === "wrong-workspace"
                    ? "$WORKSPACE_DIR/tracked.txt"
                    : mode === "wrong-state"
                      ? "$OPENCLAW_STATE_DIR/tracked.txt"
                      : ["home", "profile", "same-home", "ambiguous-home", "missing-home"].includes(
                            mode,
                          )
                        ? "~/tracked.txt"
                        : "tracked.txt",
          OPENCLAW_TEST_STDOUT: JSON.stringify({
            payloads: [{ text: "tracked checkout content" }],
            meta: { stopReason: "stop" },
          }),
        },
        timeoutMs: 10_000,
        checkoutInspection: {
          expectedText: "tracked checkout content",
          expectedPath: "tracked.txt",
        },
      });
      const accepted = ["valid", "home", "profile", "same-home"].includes(mode);
      assert.equal(result.status, accepted ? 0 : 1, mode + ": " + result.error?.message);
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      assert.deepEqual(record.config.tools.allow, ["read"]);
      assert.equal(record.config.tools.codeMode, false);
      assert.equal(record.config.tools.exec.mode, "deny");
      assert.equal(record.config.tools.fs.workspaceOnly, true);
      assert.equal(existsSync(record.stateDir), false);
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

test("OpenClaw runner writes the normalized last message", (t) => {
  useFakeScanner(t);
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
  const binary = fakeOpenclaw(root);
  const outputPath = join(root, "last-message.txt");
  try {
    const result = runAgentProcess({
      label: "managed-output-openclaw",
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
        OPENCLAW_TEST_RECORD: join(root, "managed-output.json"),
      },
      timeoutMs: 10_000,
      codexExtraArgs: ["--output-last-message", outputPath, "--json", "-"],
      outputLastMessageBytes: 4,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(outputPath, "utf8"), "done");

    const oversizedPath = join(root, "oversized-last-message.txt");
    const oversized = runAgentProcess({
      label: "bounded-openclaw",
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
        OPENCLAW_TEST_RECORD: join(root, "bounded.json"),
      },
      timeoutMs: 10_000,
      codexExtraArgs: ["--output-last-message", oversizedPath, "--json", "-"],
      outputLastMessageBytes: 3,
    });
    assert.match(oversized.error?.message ?? "", /exceeded its 3-byte limit/);
    assert.equal(existsSync(oversizedPath), false);
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
      NODE_EXTRA_CA_CERTS: join(root, "trusted-ca.pem"),
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
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
    assert.equal(record.env.NODE_EXTRA_CA_CERTS, env.NODE_EXTRA_CA_CERTS);
    assert.equal(record.env.NODE_TLS_REJECT_UNAUTHORIZED, null);
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

for (const repeated of [false, true]) {
  test(
    `OpenClaw worker kills a child that ignores SIGTERM when the worker itself is terminated${repeated ? " repeatedly" : ""}`,
    { skip: process.platform === "win32" ? "uses POSIX signals" : false },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
      const pidPath = join(root, "openclaw.pid");
      const binary = join(root, "hanging-openclaw");
      writeFileSync(
        binary,
        `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readyPath = process.env.OPENCLAW_TEST_PID_PATH + ".ready";
const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.OPENCLAW_TEST_READY_PATH, '1'); setInterval(() => {}, 1000)"],
  { stdio: "ignore", env: { ...process.env, OPENCLAW_TEST_READY_PATH: readyPath } },
);
process.on("SIGTERM", () => {});
const announce = () => {
  if (!fs.existsSync(readyPath)) return setTimeout(announce, 10);
  fs.writeFileSync(
    process.env.OPENCLAW_TEST_PID_PATH + ".tmp",
    JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
  );
  fs.renameSync(process.env.OPENCLAW_TEST_PID_PATH + ".tmp", process.env.OPENCLAW_TEST_PID_PATH);
};
announce();
setInterval(() => {}, 1000);
`,
      );
      chmodSync(binary, 0o755);
      const optionsPath = join(root, "worker-options.json");
      const resultPath = join(root, "result.json");
      writeFileSync(
        optionsPath,
        JSON.stringify({
          args: [],
          command: binary,
          timeoutMs: 60_000,
          resultPath,
          stdoutPath: join(root, "stdout.log"),
          stderrPath: join(root, "stderr.log"),
          tailBytes: 4096,
          maxOutputFileBytes: 65_536,
        }),
      );
      const worker = spawn(process.execPath, [OPENCLAW_PROCESS_WORKER_PATH, optionsPath], {
        cwd: root,
        env: { ...process.env, OPENCLAW_TEST_PID_PATH: pidPath },
        stdio: "ignore",
      });
      const workerExit = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => worker.once("exit", (code, signal) => resolve({ code, signal })));
      let pids: { child: number; grandchild: number } | undefined;
      try {
        const deadline = Date.now() + 10_000;
        while (!existsSync(pidPath)) {
          if (Date.now() > deadline) throw new Error("hanging OpenClaw child never started");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        pids = JSON.parse(readFileSync(pidPath, "utf8")) as {
          child: number;
          grandchild: number;
        };
        worker.kill("SIGTERM");
        if (repeated) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(worker.kill("SIGTERM"), true, "worker must survive until escalation");
        }
        const exit = await workerExit;
        const reapDeadline = Date.now() + 3_000;
        while (Date.now() < reapDeadline && [pids.child, pids.grandchild].some(processAlive)) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        for (const pid of [pids.child, pids.grandchild]) {
          assert.equal(processAlive(pid), false, `pid ${pid} survived worker termination`);
        }
        assert.equal(exit.code, 0, JSON.stringify(exit));
        const result = JSON.parse(readFileSync(resultPath, "utf8")) as { signal: string | null };
        assert.equal(result.signal, "SIGKILL");
      } finally {
        for (const pid of [pids?.child, pids?.grandchild]) {
          if (pid) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test(
  "OpenClaw worker kills a signal-ignoring grandchild after the direct child exits on SIGTERM",
  { skip: process.platform === "win32" ? "uses POSIX signals" : false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-test-"));
    const pidPath = join(root, "openclaw.pid");
    const binary = join(root, "exiting-openclaw");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readyPath = process.env.OPENCLAW_TEST_PID_PATH + ".ready";
const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.OPENCLAW_TEST_READY_PATH, '1'); setInterval(() => {}, 1000)"],
  { stdio: "ignore", env: { ...process.env, OPENCLAW_TEST_READY_PATH: readyPath } },
);
const announce = () => {
  if (!fs.existsSync(readyPath)) return setTimeout(announce, 10);
  fs.writeFileSync(
    process.env.OPENCLAW_TEST_PID_PATH + ".tmp",
    JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
  );
  fs.renameSync(process.env.OPENCLAW_TEST_PID_PATH + ".tmp", process.env.OPENCLAW_TEST_PID_PATH);
};
announce();
setInterval(() => {}, 1000);
`,
    );
    chmodSync(binary, 0o755);
    const optionsPath = join(root, "worker-options.json");
    const resultPath = join(root, "result.json");
    writeFileSync(
      optionsPath,
      JSON.stringify({
        args: [],
        command: binary,
        timeoutMs: 60_000,
        resultPath,
        stdoutPath: join(root, "stdout.log"),
        stderrPath: join(root, "stderr.log"),
        tailBytes: 4096,
        maxOutputFileBytes: 65_536,
      }),
    );
    const worker = spawn(process.execPath, [OPENCLAW_PROCESS_WORKER_PATH, optionsPath], {
      cwd: root,
      env: { ...process.env, OPENCLAW_TEST_PID_PATH: pidPath },
      stdio: "ignore",
    });
    const workerExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => worker.once("exit", (code, signal) => resolve({ code, signal })),
    );
    let pids: { child: number; grandchild: number } | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidPath)) {
        if (Date.now() > deadline) throw new Error("exiting OpenClaw child never started");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      pids = JSON.parse(readFileSync(pidPath, "utf8")) as { child: number; grandchild: number };
      worker.kill("SIGTERM");
      const exit = await workerExit;
      const reapDeadline = Date.now() + 3_000;
      while (Date.now() < reapDeadline && processAlive(pids.grandchild)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(processAlive(pids.child), false, `child ${pids.child} survived`);
      assert.equal(
        processAlive(pids.grandchild),
        false,
        `grandchild ${pids.grandchild} survived after the direct child exited`,
      );
      assert.equal(exit.code, 0, JSON.stringify(exit));
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as { signal: string | null };
      assert.equal(result.signal, "SIGTERM");
    } finally {
      for (const pid of [pids?.child, pids?.grandchild]) {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const modelId of ["selected", "vendor/selected"])
  test("immutable per-call OpenClaw selection preserves the native model ID: " + modelId, (t) => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-selection-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    useFakeScanner(t);
    const binary = fakeOpenclaw(root);
    const recordPath = join(root, "record.json");
    const envelope = {
      payloads: [{ text: "native answer" }],
      meta: {
        stopReason: "stop",
        agentMeta: {
          provider: "fixture",
          model: modelId,
          sessionId: "safe-session",
          runtimeModelSelection: { provider: "fixture", model: modelId },
          terminalReceipt: {
            requested: { provider: "fixture", model: modelId },
            effective: { provider: "fixture", model: modelId, responseModel: "selected-v1" },
            rerouted: false,
          },
        },
        requestShaping: { thinking: "medium", thinkingClamp: "private clamp prose" },
      },
    };
    const env = {
      ...process.env,
      CLAWSWEEPER_RUNNER: "codex",
      CLAWSWEEPER_OPENCLAW_MODEL: "legacy/old",
      CLAWSWEEPER_OPENCLAW_BIN: binary,
      OPENCLAW_TEST_RECORD: recordPath,
      OPENCLAW_TEST_STDOUT: JSON.stringify(envelope),
      CLAWSWEEPER_OPENCLAW_SANDBOX_IMAGE: "localhost/fixture@sha256:" + "1".repeat(64),
    };
    const before = { ...env };
    const configured = process.platform === "linux" && (process.getuid?.() ?? 0) > 0;
    const result = runAgentProcess({
      label: "selection",
      prompt: "review",
      scanSource: { kind: "prompt" },
      model: "internal",
      cwd: root,
      env,
      timeoutMs: 10_000,
      selection: {
        runner: "openclaw",
        model: "fixture/" + modelId,
        reasoningEffort: "high",
        contextTier: "default",
      },
      ...(configured ? { reviewPhase: "independent" as const } : {}),
    });
    assert.equal(result.status, 0, result.error?.message);
    assert.equal(result.stdout, "native answer");
    assert.equal(result.execution!.terminalReceipt!.effective.responseModel, "selected-v1");
    assert.equal(result.execution!.requestShaping!.thinking, "medium");
    assert.equal(result.execution!.requestShaping!.thinkingClamped, true);
    assert.deepEqual(env, before);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.args[record.args.indexOf("--model") + 1], "fixture/" + modelId);
    assert.equal(record.args[record.args.indexOf("--thinking") + 1], "high");
    assert.equal(record.config.agents.defaults.sandbox.mode, configured ? "all" : "off");
    if (configured) assert.equal(record.config.agents.defaults.sandbox.backend, "podman");
    assert.equal(record.config.tools.exec.host, configured ? "sandbox" : "gateway");
    assert.equal(existsSync(record.stateDir), configured);
    // The surviving assessment owner now retires configured native state. This
    // unit fixture creates no native container; remove only its recorded state.
    rmSync(record.stateDir, { recursive: true, force: true });
  });

test(
  "native receipt export deadline settles SIGTERM-resistant descendants",
  { skip: process.platform !== "linux" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-export-deadline-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const binary = fakeOpenclaw(root),
      pids = join(root, "pids.json"),
      recordPath = join(root, "record.json");
    const started = Date.now();
    const result = runOpenclawProcess({
      label: "export-deadline",
      prompt: "challenge",
      model: "openai/test",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        OPENCLAW_TEST_RECORD: recordPath,
        OPENCLAW_TEST_SQLITE_EXPORT: "1",
        OPENCLAW_TEST_HANG_EXPORT: pids,
        OPENCLAW_TEST_READ_PATH: "tracked.txt",
        OPENCLAW_TEST_STDOUT: JSON.stringify({
          payloads: [{ text: "tracked checkout content" }],
          meta: { stopReason: "stop" },
        }),
      },
      timeoutMs: 1200,
      checkoutInspection: { expectedText: "tracked checkout content", expectedPath: "tracked.txt" },
    });
    assert.equal(result.status, 1);
    // The native process worker reserves its existing one-second kill escalation.
    assert.ok(Date.now() - started < 4000);
    const receipt = JSON.parse(readFileSync(pids, "utf8"));
    assert.equal(processAlive(receipt.pid), false);
    assert.equal(processAlive(receipt.child), false);
    assert.equal(existsSync(JSON.parse(readFileSync(recordPath, "utf8")).stateDir), false);
  },
);

test("configured native state fails closed before launch when a key-bearing state path is tool-readable", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-state-overlap-"));
  try {
    const record = join(root, "record.json");
    const result = runOpenclawProcess({
      label: "overlap",
      prompt: "fixture",
      model: "fixture/model",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: fakeOpenclaw(root),
        OPENCLAW_TEST_RECORD: record,
        CLAWSWEEPER_OPENCLAW_SANDBOX_IMAGE: "localhost/fixture@sha256:" + "1".repeat(64),
      },
      timeoutMs: 1000,
      roleIsolation: { readRoots: [tmpdir()] },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.error?.message ?? "", /provider state.*outside/);
    assert.equal(existsSync(record), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured native state retirement retains binding while dropping provider models and secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-retire-"));
  try {
    const state = join(root, "clawsweeper-openclaw-process-owned");
    const config = {
      agents: { defaults: { sandbox: { mode: "all", backend: "podman" } } },
      models: { providers: { fixture: { apiKey: "SYNTHETIC_ONLY" } } },
    };
    mkdirSync(state);
    writeFileSync(join(state, "role-isolation.json"), "1");
    writeFileSync(join(state, "openclaw.json"), JSON.stringify(config));
    const marker = join(root, "retired.json");
    const binary = join(root, "retire-native.cjs");
    writeFileSync(
      binary,
      "#!" +
        process.execPath +
        "\n" +
        'const fs=require("node:fs"),assert=require("node:assert/strict");' +
        'assert.deepEqual(process.argv.slice(2),["sandbox","recreate","--agent","main","--force"]);' +
        "assert.equal(process.env.OPENAI_API_KEY,undefined);assert.equal(process.env.OPENCLAW_GATEWAY_TOKEN,undefined);" +
        'const c=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8"));' +
        'assert.equal(c.models,undefined);assert.equal(c.agents.defaults.sandbox.backend,"podman");' +
        "fs.writeFileSync(" +
        JSON.stringify(marker) +
        ",JSON.stringify({state:process.env.OPENCLAW_STATE_DIR,config:c}));",
      { mode: 0o755 },
    );
    retireOpenclawRoleStates(
      root,
      {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: binary,
        OPENAI_API_KEY: "SYNTHETIC_ONLY",
        OPENCLAW_GATEWAY_TOKEN: "SYNTHETIC_ONLY",
      },
      Date.now() + 5000,
    );
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, state);
    assert.deepEqual(JSON.parse(readFileSync(join(state, "openclaw.json"), "utf8")), config);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured native roles reject an unsupported host without launching broad host tools", (t) => {
  const root = mkdtempSync(join(tmpdir(), "native-host-refusal-"));
  try {
    if (process.getuid) t.mock.method(process, "getuid", () => 0);
    const record = join(root, "record.json");
    const result = runOpenclawProcess({
      label: "unqualified-host",
      prompt: "fixture",
      model: "fixture/model",
      cwd: root,
      env: {
        ...process.env,
        CLAWSWEEPER_OPENCLAW_BIN: fakeOpenclaw(root),
        OPENCLAW_TEST_RECORD: record,
        CLAWSWEEPER_OPENCLAW_SANDBOX_IMAGE: "localhost/fixture@sha256:" + "1".repeat(64),
      },
      timeoutMs: 1000,
      roleIsolation: { readRoots: [root] },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.error?.message ?? "", /qualified non-root native sandbox host/);
    assert.equal(existsSync(record), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
