import assert from "node:assert/strict";
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
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  codexProcessCommand,
  codexProcessErrorCode,
  codexProcessUsesShell,
  runCodexProcess,
} from "../dist/codex-process.js";

const tmpPrefix = join(tmpdir(), "clawsweeper-codex-process-test-");

test("Codex process resolves command overrides and Windows shell policy", () => {
  assert.equal(codexProcessCommand({}), "codex");
  assert.equal(codexProcessCommand({ CODEX_BIN: "  custom-codex  " }), "custom-codex");
  assert.equal(codexProcessUsesShell("darwin"), false);
  assert.equal(codexProcessUsesShell("linux"), false);
  assert.equal(codexProcessUsesShell("win32"), true);
});

test("Codex process uses CODEX_BIN and preserves stdin delivery", () => {
  const root = mkdtempSync(tmpPrefix);
  const binDir = join(root, "custom codex bin");
  const markerPath = join(root, "stdin.txt");
  const scriptPath = join(binDir, "fake-codex.js");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    scriptPath,
    `const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.CODEX_TEST_STDIN_PATH, input);
process.stdout.write("custom-codex-ok");
`,
  );
  const codexPath =
    process.platform === "win32" ? join(binDir, "custom-codex.cmd") : join(binDir, "custom-codex");
  if (process.platform === "win32") {
    writeFileSync(codexPath, `@echo off\r\nnode "%~dp0\\fake-codex.js" %*\r\n`);
  } else {
    writeFileSync(codexPath, `#!/usr/bin/env node\n${readFileSync(scriptPath, "utf8")}`, {
      mode: 0o755,
    });
  }

  try {
    const result = runCodexProcess({
      args: ["exec", "-"],
      cwd: root,
      env: {
        ...process.env,
        CODEX_BIN: codexPath,
        CODEX_TEST_STDIN_PATH: markerPath,
      },
      input: "prompt over stdin",
      timeoutMs: 10_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /custom-codex-ok/);
    assert.equal(existsSync(markerPath), true);
    assert.equal(readFileSync(markerPath, "utf8"), "prompt over stdin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex process captures bounded rolling tails without terminating large output", () => {
  const root = mkdtempSync(tmpPrefix);
  const binDir = join(root, "bin");
  const stdoutPath = join(root, "codex.stdout.log");
  const stderrPath = join(root, "codex.stderr.log");
  mkdirSync(binDir, { recursive: true });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
process.stdout.write("s".repeat(16 * 1024 * 1024) + "stdout-tail-marker");
process.stderr.write("e".repeat(16 * 1024 * 1024) + "stderr-tail-marker");
`,
  );
  chmodSync(codexPath, 0o755);

  try {
    const result = runCodexProcess({
      args: [],
      cwd: root,
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
      input: "",
      timeoutMs: 10_000,
      tailBytes: 4096,
      stdoutPath,
      stderrPath,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    assert.ok(Buffer.byteLength(result.stdout) <= 4096);
    assert.ok(Buffer.byteLength(result.stderr) <= 4096);
    assert.match(result.stdout, /stdout-tail-marker$/);
    assert.match(result.stderr, /stderr-tail-marker$/);
    assert.equal(readFileSync(stdoutPath, "utf8").length, 16 * 1024 * 1024 + 18);
    assert.equal(readFileSync(stderrPath, "utf8").length, 16 * 1024 * 1024 + 18);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex process caps durable logs while preserving the final output tail", () => {
  const root = mkdtempSync(tmpPrefix);
  const binDir = join(root, "bin");
  const stdoutPath = join(root, "codex.stdout.log");
  const stderrPath = join(root, "codex.stderr.log");
  mkdirSync(binDir, { recursive: true });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
process.stdout.write("s".repeat(2 * 1024 * 1024) + "stdout-tail-marker");
process.stderr.write("e".repeat(2 * 1024 * 1024) + "stderr-tail-marker");
`,
  );
  chmodSync(codexPath, 0o755);

  try {
    const outputFileBytes = 1024 * 1024;
    const result = runCodexProcess({
      args: [],
      cwd: root,
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
      input: "",
      timeoutMs: 10_000,
      tailBytes: 4096,
      outputFileBytes,
      stdoutPath,
      stderrPath,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /stdout-tail-marker$/);
    assert.match(result.stderr, /stderr-tail-marker$/);
    for (const [filePath, tailMarker] of [
      [stdoutPath, "stdout-tail-marker"],
      [stderrPath, "stderr-tail-marker"],
    ] as const) {
      const output = readFileSync(filePath);
      assert.equal(output.length, outputFileBytes);
      assert.match(output.toString("utf8"), /Codex output truncated; final tail follows/);
      assert.match(output.toString("utf8"), new RegExp(`${tailMarker}$`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex process preserves timeout errors and kills a child that ignores SIGTERM", () => {
  const root = mkdtempSync(tmpPrefix);
  const binDir = join(root, "bin");
  const pidPath = join(root, "codex.pid");
  mkdirSync(binDir, { recursive: true });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CODEX_TEST_PID_PATH, String(process.pid));
process.stderr.write("timeout-tail-marker\\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(codexPath, 0o755);

  try {
    const result = runCodexProcess({
      args: [],
      cwd: root,
      env: {
        ...process.env,
        CODEX_TEST_PID_PATH: pidPath,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
      input: "",
      timeoutMs: 1000,
    });

    assert.equal(codexProcessErrorCode(result.error), "ETIMEDOUT");
    assert.match(result.stderr, /timeout-tail-marker/);
    const pid = Number(readFileSync(pidPath, "utf8"));
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex app-server mode persists and resumes a thread", () => {
  const root = mkdtempSync(tmpPrefix);
  const binDir = join(root, "bin");
  const statePath = join(root, "session", "state.json");
  const outputPath = join(root, "last-message.json");
  const requestsPath = join(root, "requests.jsonl");
  mkdirSync(binDir, { recursive: true });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const requestsPath = process.env.CODEX_TEST_REQUESTS_PATH;
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestsPath, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1", sessionId: "session-1" } } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId, sessionId: "session-1" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    setTimeout(() => {
      send({ method: "item/completed", params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: Date.now(),
        item: { type: "agentMessage", id: "message-1", text: '{"status":"planned"}' }
      } });
      send({ method: "turn/completed", params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] }
      } });
    }, 5);
  }
});
`,
  );
  chmodSync(codexPath, 0o755);
  const env = {
    ...process.env,
    CODEX_TEST_REQUESTS_PATH: requestsPath,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
  };

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = runCodexProcess({
        args: [
          "exec",
          "--cd",
          root,
          "--sandbox",
          "workspace-write",
          "-c",
          "sandbox_workspace_write.network_access=false",
          "--output-last-message",
          outputPath,
          "--json",
          "-",
        ],
        cwd: root,
        env,
        input: "Plan the repair.",
        timeoutMs: 10_000,
        appServer: { statePath, label: "test worker" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      assert.equal(readFileSync(outputPath, "utf8"), '{"status":"planned"}');
    }

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.threadId, "thread-1");
    const requests = readFileSync(requestsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(requests.filter((request) => request.method === "thread/start").length, 1);
    assert.equal(requests.filter((request) => request.method === "thread/resume").length, 1);
    assert.equal(requests.filter((request) => request.method === "turn/start").length, 2);
    for (const request of requests.filter((request) => request.method === "turn/start")) {
      assert.deepEqual(request.params.sandboxPolicy, {
        type: "workspaceWrite",
        writableRoots: [root],
        networkAccess: false,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
