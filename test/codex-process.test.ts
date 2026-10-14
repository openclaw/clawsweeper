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
import test, { type TestContext } from "node:test";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  codexProcessCommand,
  codexProcessErrorCode,
  codexSpawnInvocation,
  runCodexProcess,
} from "../dist/codex-process.js";

const tmpPrefix = join(tmpdir(), "clawsweeper-codex-process-test-");

function managedCompletedOutput(text: string): string {
  return `${text}\n`;
}

function runManagedOutputFixture(
  t: TestContext,
  options: {
    payload?: string | Buffer;
    stderr?: string;
    mode?: "payload" | "oversized" | "signal" | "timeout";
    cap: number;
    status?: number;
    timeoutMs?: number;
    outputFileBytes?: number;
    tailBytes?: number;
    existingOutput?: string;
    partialWrite?: "fail" | "replace";
  },
) {
  const root = mkdtempSync(tmpPrefix);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "codex");
  const outputPath = join(root, "last-message.txt");
  const stdoutPath = join(root, "stdout.log");
  const stderrPath = join(root, "stderr.log");
  const preloadPath = join(root, "partial-write.mjs");
  if (options.existingOutput !== undefined) writeFileSync(outputPath, options.existingOutput);
  if (options.partialWrite) {
    writeFileSync(
      preloadPath,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.writeFileSync;
fs.writeFileSync = function(file, ...args) {
  if (typeof file === "number") {
    fs.writeSync(file, "partial");
    ${options.partialWrite === "replace" ? `fs.unlinkSync(${JSON.stringify(outputPath)}); original(${JSON.stringify(outputPath)}, "other writer contents");` : ""}
    throw new Error("injected managed write failure");
  }
  return original.call(this, file, ...args);
};
syncBuiltinESMExports();
`,
    );
  }
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const { writeSync } = require("node:fs");
writeSync(2, process.env.CODEX_TEST_STDERR || "");
if (process.env.CODEX_TEST_MODE === "oversized") {
  writeSync(1, "x".repeat(Number(process.env.CODEX_TEST_LINE_BYTES)) + "\\n");
} else {
  writeSync(1, Buffer.from(process.env.CODEX_TEST_PAYLOAD_BASE64 || "", "base64"));
}
process.exitCode = Number(process.env.CODEX_TEST_STATUS || "0");
if (process.env.CODEX_TEST_MODE === "signal") process.kill(process.pid, "SIGTERM");
if (process.env.CODEX_TEST_MODE === "timeout") setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const result = runCodexProcess({
    args: ["exec", "-"],
    cwd: root,
    env: {
      ...process.env,
      CODEX_BIN: binary,
      CODEX_TEST_MODE: options.mode ?? "payload",
      CODEX_TEST_LINE_BYTES: String(options.cap + 1),
      CODEX_TEST_PAYLOAD_BASE64: Buffer.from(options.payload ?? "").toString("base64"),
      CODEX_TEST_STATUS: String(options.status ?? 0),
      CODEX_TEST_STDERR: options.stderr ?? "",
      ...(options.partialWrite
        ? { NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` }
        : {}),
    },
    input: "",
    timeoutMs: options.timeoutMs ?? 10_000,
    outputLastMessagePath: outputPath,
    outputLastMessageBytes: options.cap,
    ...(options.outputFileBytes === undefined
      ? {}
      : { outputFileBytes: options.outputFileBytes, stdoutPath, stderrPath }),
    ...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
  });
  return { outputPath, result, stdoutPath, stderrPath };
}

test("managed Codex result enforces exact UTF-8 bytes and rejects cap plus one", (t) => {
  const exact = runManagedOutputFixture(t, {
    payload: managedCompletedOutput("🦊"),
    cap: 4,
  });
  assert.equal(exact.result.error, undefined);
  assert.equal(readFileSync(exact.outputPath, "utf8"), "🦊");

  const oversized = runManagedOutputFixture(t, {
    payload: managedCompletedOutput("a🦊"),
    cap: 4,
  });
  assert.match(oversized.result.error?.message ?? "", /exceeded its 4-byte limit/);
  assert.equal(existsSync(oversized.outputPath), false);
});

test("managed Codex result uses authoritative stdout rather than stale streamed stderr", (t) => {
  const fixture = runManagedOutputFixture(t, {
    payload: managedCompletedOutput('{"summary":"recovered final"}'),
    stderr: 'codex\n{"summary":"stale streamed answer"}\ntokens used\n1,024\n',
    cap: 64,
  });
  assert.equal(fixture.result.error, undefined);
  assert.equal(readFileSync(fixture.outputPath, "utf8"), '{"summary":"recovered final"}');
});

for (const failure of [
  {
    name: "invalid UTF-8",
    options: { payload: Buffer.from([0xff, 0x0a]), cap: 64 },
    message: /invalid UTF-8/,
  },
  {
    name: "missing newline frame",
    options: { payload: "partial", cap: 64 },
    message: /newline frame/,
  },
  {
    name: "missing final output",
    options: { payload: "", cap: 64 },
    message: /newline frame/,
  },
  {
    name: "failed turn after a streamed agent message",
    options: {
      stderr: "codex\npartial answer\nERROR: turn failed\ntokens used\n1,024\n",
      cap: 64,
      status: 1,
    },
    message: /newline frame/,
  },
  {
    name: "incomplete turn despite a zero child exit",
    options: { stderr: "codex\npartial answer\n", cap: 64 },
    message: /newline frame/,
  },
  {
    name: "signal after framed output",
    options: { payload: "answer\n", mode: "signal" as const, cap: 64 },
    message: /interrupted by SIGTERM/,
  },
  {
    name: "timeout after framed output",
    options: { payload: "answer\n", mode: "timeout" as const, timeoutMs: 1000, cap: 64 },
    message: /timed out/,
  },
  {
    name: "oversized output",
    options: { mode: "oversized" as const, cap: 64 },
    message: /exceeded its 64-byte limit/,
  },
]) {
  test(
    `managed Codex result fails closed for ${failure.name}`,
    {
      skip: process.platform === "win32" && failure.name === "signal after framed output",
    },
    (t) => {
      const fixture = runManagedOutputFixture(t, failure.options);
      assert.match(fixture.result.error?.message ?? "", failure.message);
      assert.equal(
        fixture.result.processError,
        failure.name === "signal after framed output" ||
          failure.name === "timeout after framed output",
      );
      assert.equal(existsSync(fixture.outputPath), false);
    },
  );
}

test("failed Codex turns preserve an existing managed result file", (t) => {
  const fixture = runManagedOutputFixture(t, {
    stderr: "codex\npartial answer\nERROR: turn failed\n",
    cap: 64,
    status: 1,
    existingOutput: "keep existing contents",
  });

  assert.match(fixture.result.error?.message ?? "", /newline frame/);
  assert.equal(readFileSync(fixture.outputPath, "utf8"), "keep existing contents");
});

test("outer worker timeout overrides an output-only error even when the result file is absent", (t) => {
  const root = mkdtempSync(tmpPrefix);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const timeout = Object.assign(new Error("outer worker timed out"), { code: "ETIMEDOUT" });
  t.mock.method(childProcess, "spawnSync", ((command: string, args: readonly string[]) => {
    assert.equal(command, process.execPath);
    assert.ok(args?.[0]?.endsWith("codex-process-worker.js"));
    const options = JSON.parse(readFileSync(args![1]!, "utf8"));
    writeFileSync(
      options.resultPath,
      JSON.stringify({
        status: 1,
        signal: null,
        error: { message: "missing final stdout frame" },
        processError: false,
        stdout: "",
        stderr: "ERROR: untrusted trailing tool text",
      }),
    );
    return { pid: 0, output: [], stdout: "", stderr: "", status: 1, signal: null, error: timeout };
  }) as typeof spawnSync);
  syncBuiltinESMExports();
  try {
    const result = runCodexProcess({
      args: ["exec", "-"],
      cwd: root,
      env: { CODEX_BIN: process.execPath },
      input: "",
      timeoutMs: 1000,
      outputLastMessagePath: join(root, "absent-final.txt"),
      outputLastMessageBytes: 64,
    });
    assert.equal(result.error, timeout);
    assert.equal(result.processError, true);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("managed Codex exclusive writes preserve pre-existing collisions", (t) => {
  const fixture = runManagedOutputFixture(t, {
    payload: "new answer\n",
    cap: 64,
    existingOutput: "keep existing contents",
  });
  assert.equal(codexProcessErrorCode(fixture.result.error), "EEXIST");
  assert.equal(readFileSync(fixture.outputPath, "utf8"), "keep existing contents");
});

test("managed Codex failed writes remove only their own partial result", (t) => {
  const fixture = runManagedOutputFixture(t, {
    payload: "new answer\n",
    cap: 64,
    partialWrite: "fail",
  });
  assert.match(fixture.result.error?.message ?? "", /injected managed write failure/);
  assert.equal(existsSync(fixture.outputPath), false);
});

test("managed Codex failed-write cleanup preserves a replacement writer's file", (t) => {
  const fixture = runManagedOutputFixture(t, {
    payload: "new answer\n",
    cap: 64,
    partialWrite: "replace",
  });
  assert.match(fixture.result.error?.message ?? "", /injected managed write failure/);
  assert.equal(readFileSync(fixture.outputPath, "utf8"), "other writer contents");
});

test("managed Codex result survives diagnostic capture truncation", (t) => {
  const fixture = runManagedOutputFixture(t, {
    payload: managedCompletedOutput("final result"),
    stderr: "x".repeat(4096),
    cap: 64,
    outputFileBytes: 128,
    tailBytes: 32,
  });
  assert.equal(fixture.result.error, undefined);
  assert.equal(readFileSync(fixture.outputPath, "utf8"), "final result");
  assert.equal(readFileSync(fixture.stdoutPath, "utf8"), "final result\n");
  assert.equal(readFileSync(fixture.stderrPath).length, 128);
  assert.match(readFileSync(fixture.stderrPath, "utf8"), /Codex output truncated/);
});

test("completed Codex result remains available after a non-zero shutdown exit", (t) => {
  const fixture = runManagedOutputFixture(t, {
    payload: managedCompletedOutput("usable result"),
    cap: 64,
    status: 7,
  });
  assert.equal(fixture.result.status, 7);
  assert.equal(fixture.result.error, undefined);
  assert.equal(readFileSync(fixture.outputPath, "utf8"), "usable result");
});

test("Codex worker writes one managed result without duplicating it into the IPC receipt", (t) => {
  const root = mkdtempSync(tmpPrefix);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "codex");
  const optionsPath = join(root, "options.json");
  const resultPath = join(root, "result.json");
  const outputPath = join(root, "last-message.txt");
  const marker = String.raw`quoted "result" with \\ escapes`;
  writeFileSync(
    binary,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(managedCompletedOutput(marker))});
`,
    { mode: 0o755 },
  );
  writeFileSync(
    optionsPath,
    JSON.stringify({
      args: [],
      command: binary,
      timeoutMs: 10_000,
      resultPath,
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
      tailBytes: 0,
      maxOutputFileBytes: 1024,
      outputLastMessageBytes: 128,
      outputLastMessagePath: outputPath,
    }),
  );

  const worker = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/codex-process-worker.js", import.meta.url)), optionsPath],
    { cwd: root, input: "", encoding: "utf8" },
  );
  assert.equal(worker.status, 0, worker.stderr);
  assert.equal(readFileSync(outputPath, "utf8"), marker);
  const receipt = readFileSync(resultPath, "utf8");
  assert.equal(receipt.includes(marker), false);
  assert.equal(Object.hasOwn(JSON.parse(receipt), "outputLastMessage"), false);
});

test("Codex process resolves command overrides and escaped Windows launchers", () => {
  assert.equal(codexProcessCommand({}), "codex");
  assert.equal(codexProcessCommand({ CODEX_BIN: "  custom-codex  " }), "custom-codex");
  assert.equal(
    codexProcessCommand(
      {
        CODEX_BIN: "custom-codex",
        CLAWSWEEPER_PREFER_WINDOWS_CODEX_APP: "1",
      },
      "win32",
    ),
    "custom-codex",
  );
  assert.deepEqual(codexSpawnInvocation(["exec", "-"], { CODEX_BIN: "codex" }, "linux"), {
    command: "codex",
    args: ["exec", "-"],
  });
  const escaped = codexSpawnInvocation(
    ["space value", "a&b"],
    {
      CODEX_BIN: String.raw`C:\repo\node_modules\.bin\codex.cmd`,
      systemroot: String.raw`C:\Windows`,
    },
    "win32",
  );
  assert.match(escaped.command, /C:\\Windows[\\/]System32[\\/]cmd\.exe/);
  assert.deepEqual(escaped.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(escaped.args[3] ?? "", /codex\.cmd/);
  assert.match(escaped.args[3] ?? "", /\^\^\^"space\^\^\^ value\^\^\^"/);
  assert.match(escaped.args[3] ?? "", /\^\^\^"a\^\^\^&b\^\^\^"/);
  assert.equal(escaped.windowsVerbatimArguments, true);
  const root = mkdtempSync(tmpPrefix);
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "codex"), "#!/bin/sh\r\n");
  writeFileSync(join(binDir, "codex.cmd"), "@echo off\r\n");
  try {
    const invocation = codexSpawnInvocation(
      ["exec"],
      {
        CODEX_BIN: "codex",
        Path: binDir,
        PATHEXT: ".CMD",
        SystemRoot: String.raw`C:\Windows`,
      },
      "win32",
      root,
    );
    assert.match(invocation.command, /C:\\Windows[\\/]System32[\\/]cmd\.exe/);
    assert.match(invocation.args[3] ?? "", /codex\.cmd/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.throws(
    () =>
      codexSpawnInvocation(
        ["exec"],
        { CODEX_BIN: "codex", Path: "", SystemRoot: String.raw`C:\Windows` },
        "win32",
      ),
    /Unable to resolve Windows Codex command/,
  );
});

test("Windows Codex selection prefers PATH and falls back to the Desktop app", () => {
  const root = mkdtempSync(tmpPrefix);
  const pathBin = join(root, "path-bin");
  const unsupportedBin = join(root, "unsupported-bin");
  const fallbackPathBin = join(root, "fallback-path-bin");
  const localAppData = join(root, "local-app-data");
  const desktopCodex = join(localAppData, "OpenAI", "Codex", "bin", "codex.exe");
  mkdirSync(pathBin);
  mkdirSync(unsupportedBin);
  mkdirSync(fallbackPathBin);
  mkdirSync(join(localAppData, "OpenAI", "Codex", "bin"), { recursive: true });
  writeFileSync(join(pathBin, "codex.exe"), "");
  writeFileSync(join(unsupportedBin, "codex"), "#!/bin/sh\r\n");
  writeFileSync(join(fallbackPathBin, "codex.exe"), "");
  writeFileSync(desktopCodex, "");
  try {
    const pathEnv = {
      LOCALAPPDATA: localAppData,
      Path: pathBin,
      PATHEXT: ".EXE",
      SystemRoot: String.raw`C:\Windows`,
    };
    const pathInvocation = codexSpawnInvocation(["exec"], pathEnv, "win32", root);
    assert.equal(pathInvocation.command, join(pathBin, "codex.exe"));

    const desktopEnv = { ...pathEnv, Path: "" };
    assert.equal(codexProcessCommand(desktopEnv, "win32", root), desktopCodex);
    const desktopInvocation = codexSpawnInvocation(["exec"], desktopEnv, "win32", root);
    assert.equal(desktopInvocation.command, desktopCodex);

    const unsupportedEnv = { ...pathEnv, Path: unsupportedBin };
    assert.equal(codexProcessCommand(unsupportedEnv, "win32", root), desktopCodex);
    const unsupportedInvocation = codexSpawnInvocation(["exec"], unsupportedEnv, "win32", root);
    assert.equal(unsupportedInvocation.command, desktopCodex);

    const laterPathEnv = { ...pathEnv, Path: `${unsupportedBin}${delimiter}${fallbackPathBin}` };
    const laterPathInvocation = codexSpawnInvocation(["exec"], laterPathEnv, "win32", root);
    assert.equal(laterPathInvocation.command, join(fallbackPathBin, "codex.exe"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows Codex selection resolves relative PATH entries from the launch cwd", () => {
  const root = mkdtempSync(tmpPrefix);
  const launcherDir = join(root, "launcher");
  const targetDir = join(root, "target");
  const localAppData = join(root, "local-app-data");
  const desktopCodex = join(localAppData, "OpenAI", "Codex", "bin", "codex.exe");
  mkdirSync(launcherDir);
  mkdirSync(join(targetDir, "bin"), { recursive: true });
  mkdirSync(join(localAppData, "OpenAI", "Codex", "bin"), { recursive: true });
  writeFileSync(join(targetDir, "bin", "codex.exe"), "");
  writeFileSync(desktopCodex, "");
  try {
    const env = {
      LOCALAPPDATA: localAppData,
      Path: "bin",
      PATHEXT: ".EXE",
      SystemRoot: String.raw`C:\Windows`,
    };
    assert.equal(codexProcessCommand(env, "win32", launcherDir), desktopCodex);
    assert.equal(codexProcessCommand(env, "win32", targetDir), "codex");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex process resolves extensionless Windows node shebang shims", () => {
  const root = mkdtempSync(tmpPrefix);
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(codexPath, "#!/usr/bin/env node\r\n");
  try {
    const invocation = codexSpawnInvocation(
      ["exec", "-"],
      {
        CODEX_BIN: "codex",
        Path: binDir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: String.raw`C:\Windows`,
      },
      "win32",
      root,
    );

    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [codexPath, "exec", "-"]);
    assert.equal(invocation.windowsVerbatimArguments, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex process uses CODEX_BIN and preserves argv and stdin delivery", () => {
  const root = mkdtempSync(tmpPrefix);
  const binDir = join(root, "custom codex bin");
  const markerPath = join(root, "stdin.txt");
  const argvPath = join(root, "argv.json");
  const scriptPath = join(root, "fake-codex.js");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    scriptPath,
    `const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.CODEX_TEST_STDIN_PATH, input);
fs.writeFileSync(process.env.CODEX_TEST_ARGV_PATH, JSON.stringify(process.argv.slice(2)));
process.stdout.write("custom-codex-ok");
`,
  );
  const codexPath =
    process.platform === "win32" ? join(binDir, "custom-codex.cmd") : join(binDir, "custom-codex");
  if (process.platform === "win32") {
    writeFileSync(codexPath, `@echo off\r\nnode "%~dp0\\..\\fake-codex.js" %*\r\n`);
  } else {
    writeFileSync(codexPath, `#!/usr/bin/env node\n${readFileSync(scriptPath, "utf8")}`, {
      mode: 0o755,
    });
  }

  try {
    const result = runCodexProcess({
      args: ["exec", "--cd", join(root, "directory with spaces"), "a&b", "-"],
      cwd: root,
      env: {
        ...process.env,
        CODEX_BIN: codexPath,
        CODEX_TEST_ARGV_PATH: argvPath,
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
    assert.deepEqual(JSON.parse(readFileSync(argvPath, "utf8")), [
      "exec",
      "--cd",
      join(root, "directory with spaces"),
      "a&b",
      "-",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex process accepts a successful child that closes stdin early", () => {
  const result = runCodexProcess({
    args: ["-e", 'process.stdin.destroy(); process.stdout.write("finished")'],
    cwd: process.cwd(),
    env: { ...process.env, CODEX_BIN: process.execPath },
    input: "prompt".repeat(256 * 1024),
    timeoutMs: 10_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /finished/);
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
  const binDir = join(root, "node_modules", ".bin");
  const pidPath = join(root, "codex.pid");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(root, "timeout-codex.cjs");
  writeFileSync(
    scriptPath,
    `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
fs.writeFileSync(
  process.env.CODEX_TEST_PID_PATH,
  JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
);
process.stderr.write("timeout-tail-marker\\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  );
  const codexPath =
    process.platform === "win32" ? join(binDir, "codex.cmd") : join(binDir, "codex");
  if (process.platform === "win32") {
    writeFileSync(codexPath, `@echo off\r\nnode "%~dp0\\..\\..\\timeout-codex.cjs" %*\r\n`);
  } else {
    writeFileSync(codexPath, `#!/usr/bin/env node\n${readFileSync(scriptPath, "utf8")}`, {
      mode: 0o755,
    });
  }

  try {
    const result = runCodexProcess({
      args: [],
      cwd: root,
      env: {
        ...process.env,
        CODEX_BIN: codexPath,
        CODEX_TEST_PID_PATH: pidPath,
      },
      input: "",
      timeoutMs: 5000,
    });

    assert.equal(codexProcessErrorCode(result.error), "ETIMEDOUT", JSON.stringify(result));
    assert.match(result.stderr, /timeout-tail-marker/);
    const pids = JSON.parse(readFileSync(pidPath, "utf8")) as {
      child: number;
      grandchild: number;
    };
    for (const pid of [pids.child, pids.grandchild]) {
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
