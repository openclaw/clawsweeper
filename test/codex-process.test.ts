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
import childProcess, { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { codexEnv } from "../dist/codex-env.js";
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

test("inline proof returns real HTTP observations to one original app-server turn", async () => {
  const root = mkdtempSync(tmpPrefix);
  const script = join(root, "proof-app-server.cjs");
  const outputPath = join(root, "decision.json");
  const transcript = join(root, "rpc.jsonl");
  const server = spawn(
    process.execPath,
    [
      "-e",
      `
    const http = require('node:http');
    const server = http.createServer((req,res) => {
      let body=''; req.on('data', c => body+=c); req.on('end', () => {
        const value=JSON.parse(body);
        if (value.lease.leaseId === 'test-lease' && value.operation === 'capabilities') { res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,allowedScenarios:['telegram-bot-e2e-proof']}));return; }
        if (value.lease.leaseId !== 'test-lease' || value.operation !== 'request') { res.writeHead(409);res.end();return; }
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({state:'completed',expiresAt:Date.now()+20*60000,result:{assertion:'reviewer_must_evaluate',observations:[{text:'Observed help response'}]}}));
      });
    });
    server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture server did not start")), 5000);
      const lines = createInterface({ input: server.stdout! });
      lines.once("line", (line) => {
        clearTimeout(timer);
        lines.close();
        resolve(line);
      });
      server.once("error", reject);
    });
    writeFileSync(
      script,
      `
      const fs=require('node:fs'), readline=require('node:readline');
      const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
      const plan={claim:'help responds',actions:[{type:'send',atMs:0,text:'/help'}],modelReplies:[],settings:{streaming:'off',nativeCommands:true},maxDurationMs:1000,expectations:['help response']};
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);fs.appendFileSync(process.env.PROOF_RPC_TRANSCRIPT,line+'\\n');
        if(m.method==='initialize')send({id:m.id,result:{}});
        if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'proof-thread'}}});
        if(m.method==='turn/start'){
          send({id:m.id,result:{turn:{id:'proof-turn'}}});
          setTimeout(()=>send({id:'tool-request',method:'item/tool/call',params:{threadId:'proof-thread',turnId:'proof-turn',callId:'proof-call',tool:'request_behavior_proof',arguments:plan}}),20);
        }
        if(m.id==='tool-request'){
          const result=JSON.parse(m.result.contentItems[0].text);
          if(result.result?.observations?.[0]?.text!=='Observed help response')process.exit(2);
          send({method:'item/completed',params:{threadId:'proof-thread',turnId:'proof-turn',item:{type:'agentMessage',text:JSON.stringify({decision:'evaluated after observations'})}}});
          send({method:'turn/completed',params:{threadId:'proof-thread',turn:{id:'proof-turn',status:'completed'}}});
        }
      });
    `,
    );
    const bin = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
    writeFileSync(
      bin,
      process.platform === "win32"
        ? `@echo off\r\nnode "%~dp0proof-app-server.cjs" %*\r\n`
        : `#!/usr/bin/env node\n${readFileSync(script, "utf8")}`,
      { mode: 0o755 },
    );
    const result = runCodexProcess({
      args: [
        "exec",
        "--cd",
        root,
        "--sandbox",
        "read-only",
        "--output-last-message",
        outputPath,
        "-",
      ],
      cwd: root,
      env: { ...process.env, CODEX_BIN: bin, PROOF_RPC_TRANSCRIPT: transcript },
      input: "Review using proof if useful.",
      timeoutMs: 10_000,
      appServer: {
        statePath: join(root, "thread.json"),
        reviewProof: {
          queueUrl: `http://127.0.0.1:${port}`,
          lease: {
            itemKey: "openclaw/openclaw#12",
            leaseId: "test-lease",
            leaseRevision: 1,
            claimGeneration: 1,
            runId: "100",
            runAttempt: 1,
            sourceHeadSha: "a".repeat(40),
          },
        },
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.equal(
      JSON.parse(readFileSync(outputPath, "utf8")).decision,
      "evaluated after observations",
    );
    const messages = readFileSync(transcript, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(messages.filter((m) => m.method === "turn/start").length, 1);
    assert.equal(messages.filter((m) => m.method === "thread/resume").length, 0);
    assert.equal(
      messages.find((m) => m.method === "thread/start").params.dynamicTools[0].name,
      "request_behavior_proof",
    );
    assert.equal(readFileSync(transcript, "utf8").includes("test-lease"), false);
  } finally {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  }
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

for (const configuredProfile of [false, true]) {
  test(`Codex app-server persists and resumes with configured profile: ${configuredProfile}`, () => {
    const root = mkdtempSync(tmpPrefix);
    const binDir = join(root, "node_modules", ".bin");
    const statePath = join(root, "session", "state.json");
    const outputPath = join(root, "last-message.json");
    const requestsPath = join(root, "requests.jsonl");
    const argsPath = join(root, "args.json");
    mkdirSync(binDir, { recursive: true });
    const scriptPath = join(root, "app-server-codex.cjs");
    writeFileSync(
      scriptPath,
      `
const fs = require("node:fs");
const readline = require("node:readline");
const requestsPath = process.env.CODEX_TEST_REQUESTS_PATH;
require("node:assert/strict").equal(process.env.GH_TOKEN, "synthetic-inspection-token");
require("node:assert/strict").equal(process.env.GITHUB_TOKEN, undefined);
require("node:assert/strict").equal(process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN, undefined);
fs.writeFileSync(process.env.CODEX_TEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
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
    const codexPath =
      process.platform === "win32" ? join(binDir, "codex.cmd") : join(binDir, "codex");
    if (process.platform === "win32") {
      writeFileSync(codexPath, `@echo off\r\nnode "%~dp0\\..\\..\\app-server-codex.cjs" %*\r\n`);
    } else {
      writeFileSync(codexPath, `#!/usr/bin/env node\n${readFileSync(scriptPath, "utf8")}`, {
        mode: 0o755,
      });
    }
    const env = {
      ...codexEnv({ ghToken: "synthetic-inspection-token" }),
      CODEX_BIN: codexPath,
      CODEX_TEST_ARGS_PATH: argsPath,
      CODEX_TEST_REQUESTS_PATH: requestsPath,
    };

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        rmSync(outputPath, { force: true });
        const exactResultBytes = Buffer.byteLength('{"status":"planned"}');
        const result = runCodexProcess({
          args: [
            "exec",
            "--cd",
            root,
            ...(configuredProfile
              ? ["-c", 'default_permissions="clawsweeper-review"']
              : ["--sandbox", "workspace-write"]),
            "-c",
            "sandbox_workspace_write.network_access=false",
            "-c",
            'forced_login_method="chatgpt"',
            "--output-last-message",
            outputPath,
            "--json",
            "-",
          ],
          cwd: root,
          env,
          input: "Plan the repair.",
          timeoutMs: 10_000,
          outputLastMessagePath: outputPath,
          outputLastMessageBytes: exactResultBytes - attempt,
          appServer: { statePath, label: "test worker" },
        });
        if (attempt === 1) {
          assert.match(result.error?.message ?? "", /exceeded its 19-byte limit/);
          assert.equal(existsSync(outputPath), false);
          continue;
        }
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.error, undefined);
        assert.equal(readFileSync(outputPath, "utf8"), '{"status":"planned"}');
      }

      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(state.threadId, "thread-1");
      assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
        "-c",
        'forced_login_method="chatgpt"',
        ...(configuredProfile ? ["-c", 'default_permissions="clawsweeper-review"'] : []),
        "app-server",
        "--listen",
        "stdio://",
      ]);
      const requests = readFileSync(requestsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(requests.filter((request) => request.method === "thread/start").length, 1);
      assert.equal(requests.filter((request) => request.method === "thread/resume").length, 1);
      assert.equal(requests.filter((request) => request.method === "turn/start").length, 2);
      if (configuredProfile) {
        for (const request of requests.filter((request) => request.method.startsWith("thread/"))) {
          assert.equal(request.params.sandbox, undefined);
        }
      }
      for (const request of requests.filter((request) => request.method === "turn/start")) {
        if (configuredProfile) {
          assert.equal(request.params.sandboxPolicy, undefined);
          continue;
        }
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
}

test(
  "Codex app-server mode aborts hung CrabFleet work-state updates",
  { timeout: 90_000 },
  async () => {
    const root = mkdtempSync(tmpPrefix);
    const binDir = join(root, "node_modules", ".bin");
    const statePath = join(root, "session", "state.json");
    const outputPath = join(root, "last-message.json");
    const requestsPath = join(root, "requests.jsonl");
    const workStatePath = join(root, "work-state.jsonl");
    const portPath = join(root, "work-state-port.txt");
    mkdirSync(binDir, { recursive: true });
    const scriptPath = join(root, "app-server-codex.cjs");
    writeFileSync(
      scriptPath,
      `
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
    const codexPath =
      process.platform === "win32" ? join(binDir, "codex.cmd") : join(binDir, "codex");
    if (process.platform === "win32") {
      writeFileSync(codexPath, `@echo off\r\nnode "%~dp0\\..\\..\\app-server-codex.cjs" %*\r\n`);
    } else {
      writeFileSync(codexPath, `#!/usr/bin/env node\n${readFileSync(scriptPath, "utf8")}`, {
        mode: 0o755,
      });
    }

    // The work-state endpoint runs in its own process because runCodexProcess blocks the
    // test event loop with spawnSync. The first update never receives a response and the
    // server records when that stalled socket closes; later updates get 204.
    const serverPath = join(root, "work-state-server.cjs");
    writeFileSync(
      serverPath,
      `
const fs = require("node:fs");
const http = require("node:http");
const logPath = process.env.WORK_STATE_LOG_PATH;
let updates = 0;
const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    updates += 1;
    const record = { at: Date.now(), authorization: request.headers.authorization, body };
    fs.appendFileSync(logPath, JSON.stringify({ event: "request", ...record }) + "\\n");
    if (updates === 1) {
      request.socket.once("close", () => {
        fs.appendFileSync(logPath, JSON.stringify({ event: "stalled-socket-closed", at: Date.now() }) + "\\n");
      });
      return;
    }
    response.writeHead(204);
    response.end();
  });
});
server.listen(0, "127.0.0.1", () => {
  // Publish readiness only after the port file is complete.
  const temporaryPath = process.env.WORK_STATE_PORT_PATH + ".tmp";
  fs.writeFileSync(temporaryPath, String(server.address().port));
  fs.renameSync(temporaryPath, process.env.WORK_STATE_PORT_PATH);
});
`,
    );
    const server = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        WORK_STATE_LOG_PATH: workStatePath,
        WORK_STATE_PORT_PATH: portPath,
      },
      stdio: "ignore",
    });

    try {
      for (let attempt = 0; attempt < 200 && !existsSync(portPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const port = Number(readFileSync(portPath, "utf8"));
      assert.ok(Number.isInteger(port) && port > 0, "work-state server did not start");

      const startedAt = Date.now();
      const result = runCodexProcess({
        args: ["exec", "--cd", root, "--output-last-message", outputPath, "--json", "-"],
        cwd: root,
        env: {
          ...process.env,
          CODEX_BIN: codexPath,
          CODEX_TEST_REQUESTS_PATH: requestsPath,
        },
        input: "Plan the repair.",
        timeoutMs: 30_000,
        appServer: {
          statePath,
          label: "test worker",
          workStateUrl: `http://127.0.0.1:${port}/work-state`,
          agentToken: "agent-token",
        },
      });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      assert.equal(readFileSync(outputPath, "utf8"), '{"status":"planned"}');
      assert.match(result.stderr, /CrabFleet work-state update failed: .*timeout/i);
      assert.equal(result.stderr.match(/CrabFleet work-state update failed/g)?.length, 1);
      assert.ok(
        elapsedMs >= 15_000 && elapsedMs < 25_000,
        `stalled update should abort after ~15s, took ${elapsedMs}ms`,
      );

      const requests = readFileSync(requestsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(requests.filter((request) => request.method === "turn/start").length, 1);

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (readFileSync(workStatePath, "utf8").includes("stalled-socket-closed")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const events = readFileSync(workStatePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const updates = events.filter((event) => event.event === "request");
      assert.deepEqual(
        updates.map((update) => JSON.parse(update.body).summary),
        ["Codex turn starting", "Codex turn active", "Codex turn complete; validating result"],
      );
      for (const update of updates) {
        assert.equal(update.authorization, "Bearer agent-token");
      }
      assert.equal(events.filter((event) => event.event === "stalled-socket-closed").length, 1);
    } finally {
      server.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
