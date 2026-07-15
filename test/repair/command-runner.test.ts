import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveSpawnCommand } from "../../dist/command.js";
import { runCommand, runContainedCommand } from "../../dist/repair/command-runner.js";
import { mockCommandBinEnv } from "../helpers.ts";

test("runCommand handles validation output larger than Node's sync spawn default", () => {
  const output = runCommand(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(2 * 1024 * 1024))",
  ]);

  assert.equal(output.length, 2 * 1024 * 1024);
});

test("runCommand reports command timeouts with the rendered command", () => {
  assert.throws(
    () =>
      runCommand(process.execPath, ["-e", "setTimeout(() => process.stdout.write('done'), 1000)"], {
        timeoutMs: 10,
      }),
    /command timed out after 10ms: .*node.* -e/,
  );
});

test("contained commands allow worst-case serialized output within each stream limit", () => {
  const bytesPerStream = 192 * 1024;
  const output = runContainedCommand(
    process.execPath,
    [
      "-e",
      `const output = Buffer.alloc(${bytesPerStream}, 1); process.stdout.write(output); process.stderr.write(output);`,
    ],
    { maxBuffer: 256 * 1024 },
  );

  assert.equal(Buffer.byteLength(output), bytesPerStream);
});

test(
  "contained command overflow force-kills commands that ignore graceful termination",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-command-overflow-"));
    const marker = join(root, "escaped");
    try {
      assert.throws(
        () =>
          runContainedCommand(
            process.execPath,
            [
              "-e",
              [
                'const fs = require("node:fs");',
                'process.on("SIGTERM", () => {});',
                'process.stdout.write("x".repeat(128 * 1024));',
                `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "escaped"), 750);`,
                "setInterval(() => {}, 1000);",
              ].join(" "),
            ],
            { maxBuffer: 1024, timeoutMs: 3_000 },
          ),
        /validation command output exceeded the buffer limit/,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Linux containment exposes only configured writable roots and minimal runtime files",
  { skip: process.platform !== "linux" },
  (context) => {
    if (!linuxValidationNamespacesAvailable()) {
      context.skip("runner does not provide delegated validation namespaces");
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-filesystem-isolation-"));
    const target = join(root, "target");
    const profile = join(root, "profile");
    const hostSecret = join(root, "host-secret");
    const trustedTool = "/usr/bin/python3";
    const targetMarker = join(target, "target-write");
    const profileMarker = join(profile, "profile-write");
    mkdirSync(target);
    mkdirSync(profile);
    writeFileSync(hostSecret, "host-only\n");
    const trustedToolMode = statSync(trustedTool).mode & 0o777;
    try {
      const output = runContainedCommand(
        process.execPath,
        [
          "-e",
          [
            'const fs = require("node:fs");',
            "const [targetMarker, profileMarker, trustedTool, hostSecret] = process.argv.slice(1);",
            'fs.writeFileSync(targetMarker, "target");',
            'fs.writeFileSync(profileMarker, "profile");',
            "try { fs.readFileSync(hostSecret); process.exit(69); }",
            "catch (error) { if (error.code !== 'ENOENT') throw error; }",
            "if (fs.readdirSync('/run').length !== 0) process.exit(70);",
            "let blocked = false;",
            "try { fs.writeFileSync(trustedTool, 'poisoned'); }",
            "catch (error) {",
            "  if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;",
            "  blocked = true;",
            "}",
            "if (!blocked) process.exit(71);",
            "for (const mutate of [",
            "  () => fs.chmodSync(trustedTool, 0o600),",
            "  () => fs.chownSync(trustedTool, process.getuid(), process.getgid()),",
            "  () => fs.utimesSync(trustedTool, new Date(0), new Date(0)),",
            "]) {",
            "  try { mutate(); process.exit(72); }",
            "  catch (error) {",
            "    if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;",
            "  }",
            "}",
            "const xattr = require('node:child_process').spawnSync(",
            "  '/usr/bin/python3',",
            "  ['-c', 'import os,sys; os.setxattr(sys.argv[1], b\"user.clawsweeper\", b\"poisoned\")', trustedTool],",
            "  { encoding: 'utf8' },",
            ");",
            "if (xattr.status === 0) process.exit(73);",
            "const status = fs.readFileSync('/proc/self/status', 'utf8');",
            "for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {",
            "  const value = status.match(new RegExp(`^${name}:\\\\s*([0-9a-f]+)$`, 'mi'))?.[1];",
            "  if (value === undefined || BigInt(`0x${value}`) !== 0n) process.exit(74);",
            "}",
            "const remount = require('node:child_process').spawnSync(",
            "  '/usr/bin/python3',",
            "  ['-c', [",
            "    'import ctypes, os, struct, sys',",
            "    'libc = ctypes.CDLL(None, use_errno=True)',",
            "    'libc.syscall.restype = ctypes.c_long',",
            "    'attributes = (ctypes.c_ubyte * 32).from_buffer_copy(struct.pack(\"=QQQQ\", 0, 1, 0, 0))',",
            "    'result = libc.syscall(ctypes.c_long(442), ctypes.c_int(-100), ctypes.c_char_p(os.fsencode(sys.argv[1])), ctypes.c_uint32(0x8000), ctypes.byref(attributes), ctypes.c_size_t(len(attributes)))',",
            "    'sys.exit(0 if result < 0 and ctypes.get_errno() == 1 else 1)',",
            "  ].join('; '), trustedTool],",
            "  { encoding: 'utf8' },",
            ");",
            "if (remount.status !== 0) process.exit(75);",
            'process.stdout.write("blocked");',
          ].join("\n"),
          targetMarker,
          profileMarker,
          trustedTool,
          hostSecret,
        ],
        {
          cwd: target,
          env: {
            ...process.env,
            CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT: "1",
          },
          timeoutMs: 3_000,
          writableRoots: [target, profile],
        },
      );

      assert.equal(output, "blocked");
      assert.equal(readFileSync(targetMarker, "utf8"), "target");
      assert.equal(readFileSync(profileMarker, "utf8"), "profile");
      assert.equal(readFileSync(hostSecret, "utf8"), "host-only\n");
      assert.equal(statSync(trustedTool).mode & 0o777, trustedToolMode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Linux containment protects namespace init from target termination",
  { skip: process.platform !== "linux" },
  (context) => {
    if (!linuxValidationNamespacesAvailable()) {
      context.skip("runner does not provide delegated validation namespaces");
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-supervisor-kill-"));
    const marker = join(root, "escaped");
    try {
      assert.throws(
        () =>
          runContainedCommand(
            process.execPath,
            [
              "-e",
              [
                'const { spawn } = require("node:child_process");',
                `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped"), 1000);`)}], { detached: true, stdio: "ignore" });`,
                "child.unref();",
                'process.kill(process.ppid, "SIGKILL");',
                "setInterval(() => {}, 1000);",
              ].join(" "),
            ],
            {
              cwd: root,
              env: {
                ...process.env,
                CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT: "1",
              },
              timeoutMs: 250,
              writableRoots: [root],
            },
          ),
        /command timed out after 250ms/,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_250);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Linux network containment preserves isolated loopback communication",
  { skip: process.platform !== "linux" },
  (context) => {
    if (!linuxValidationNamespacesAvailable()) {
      context.skip("runner does not provide delegated validation namespaces");
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-loopback-isolation-"));
    try {
      const output = runContainedCommand(
        process.execPath,
        [
          "-e",
          [
            'const net = require("node:net");',
            "const server = net.createServer((socket) => socket.end('local'));",
            "server.listen(0, '127.0.0.1', () => {",
            "  const address = server.address();",
            "  if (!address || typeof address === 'string') process.exit(70);",
            "  let body = '';",
            "  const client = net.connect({ host: '127.0.0.1', port: address.port });",
            "  client.on('data', (chunk) => { body += chunk; });",
            "  client.on('end', () => server.close(() => {",
            "    if (body !== 'local') process.exit(71);",
            "    process.stdout.write('local');",
            "  }));",
            "});",
          ].join("\n"),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT: "1",
          },
          timeoutMs: 3_000,
          writableRoots: [root],
        },
      );

      assert.equal(output, "local");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Linux containment cannot reach host-local listeners",
  { skip: process.platform !== "linux" },
  (context) => {
    if (!linuxValidationNamespacesAvailable()) {
      context.skip("runner does not provide delegated validation namespaces");
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-network-isolation-"));
    const portFile = join(root, "port");
    const acceptedMarker = join(root, "accepted");
    const server = spawn(
      "/usr/bin/python3",
      [
        "-c",
        [
          "import pathlib, socket, sys",
          "server = socket.socket()",
          "server.bind(('127.0.0.1', 0))",
          "server.listen(1)",
          "pathlib.Path(sys.argv[1]).write_text(str(server.getsockname()[1]))",
          "connection, _address = server.accept()",
          "pathlib.Path(sys.argv[2]).write_text('accepted')",
          "connection.close()",
        ].join("; "),
        portFile,
        acceptedMarker,
      ],
      { stdio: "ignore" },
    );
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(portFile); attempt += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      assert.equal(existsSync(portFile), true);
      const port = Number(readFileSync(portFile, "utf8"));
      const output = runContainedCommand(
        process.execPath,
        [
          "-e",
          [
            'const net = require("node:net");',
            "let finished = false;",
            "const finish = (output, status = 0) => {",
            "  if (finished) return;",
            "  finished = true;",
            "  if (output) process.stdout.write(output);",
            "  process.exit(status);",
            "};",
            `const socket = net.connect({ host: "127.0.0.1", port: ${port} });`,
            'socket.once("connect", () => finish("", 70));',
            'socket.once("error", () => finish("blocked"));',
            'setTimeout(() => { socket.destroy(); finish("blocked"); }, 500);',
          ].join("\n"),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT: "1",
          },
          timeoutMs: 3_000,
          writableRoots: [root],
        },
      );

      assert.equal(output, "blocked");
      assert.equal(existsSync(acceptedMarker), false);
    } finally {
      server.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("runCommand honors shared command bin overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-command-runner-"));
  const commandPath = join(root, "validate.js");
  writeFileSync(commandPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");

  try {
    const args = [
      "space value",
      "a&b",
      "paren(x)",
      "bang!",
      "tail\\",
      "double\\\\",
      "space tail\\",
      'quote"x',
      'quote slash\\"',
    ];
    assert.equal(
      runCommand("validate", args, {
        env: {
          ...process.env,
          ...mockCommandBinEnv("validate", commandPath),
        },
      }),
      JSON.stringify(args),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared spawn resolver escapes Windows batch launcher arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-command-runner-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "validate.CMD"), "@echo off\r\n");

  try {
    const invocation = resolveSpawnCommand(
      "validate",
      ["space value", "a&b", "paren(x)", "tail\\", 'quote"x'],
      {
        cwd: root,
        env: {
          Path: binDir,
          PATHEXT: ".CMD",
          SystemRoot: String.raw`C:\Windows`,
        },
        platform: "win32",
      },
    );

    assert.match(invocation.command, /C:\\Windows[\\/]System32[\\/]cmd\.exe/);
    assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
    const shellCommand = invocation.args[3] ?? "";
    assert.match(shellCommand, /validate\.cmd/i);
    assert.match(shellCommand, /\^\^\^"space\^\^\^ value\^\^\^"/);
    assert.match(shellCommand, /\^\^\^"a\^\^\^&b\^\^\^"/);
    assert.match(shellCommand, /\^\^\^"paren\^\^\^\(x\^\^\^\)\^\^\^"/);
    assert.match(shellCommand, /\^\^\^"tail\\\\\^\^\^"/);
    assert.match(shellCommand, /\^\^\^"quote\\\^\^\^"x\^\^\^"/);
    assert.equal(invocation.windowsVerbatimArguments, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function linuxValidationNamespacesAvailable() {
  const probe = spawnSync(
    "/usr/bin/unshare",
    [
      "--user",
      "--map-root-user",
      "--mount",
      "--net",
      "--pid",
      "--fork",
      "--mount-proc",
      "--kill-child=SIGKILL",
      "/usr/bin/python3",
      "-c",
      ["import os", "assert os.getpid() == 1"].join("; "),
    ],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}
