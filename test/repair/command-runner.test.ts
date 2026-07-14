import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  "Linux containment grants writes only to configured validation roots",
  { skip: process.platform !== "linux" },
  (context) => {
    if (!linuxValidationContainmentAvailable()) {
      context.skip("runner does not provide delegated user namespaces and Landlock ABI 3+");
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-filesystem-isolation-"));
    const target = join(root, "target");
    const profile = join(root, "profile");
    const trustedBin = join(root, "trusted-bin");
    const trustedTool = join(trustedBin, "git");
    const targetMarker = join(target, "target-write");
    const profileMarker = join(profile, "profile-write");
    mkdirSync(target);
    mkdirSync(profile);
    mkdirSync(trustedBin);
    writeFileSync(trustedTool, "trusted\n", { mode: 0o755 });
    try {
      const output = runContainedCommand(
        process.execPath,
        [
          "-e",
          [
            'const fs = require("node:fs");',
            "const [targetMarker, profileMarker, trustedTool] = process.argv.slice(1);",
            'fs.writeFileSync(targetMarker, "target");',
            'fs.writeFileSync(profileMarker, "profile");',
            "let blocked = false;",
            "try { fs.writeFileSync(trustedTool, 'poisoned'); }",
            "catch (error) {",
            "  if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;",
            "  blocked = true;",
            "}",
            "if (!blocked) process.exit(70);",
            'process.stdout.write("blocked");',
          ].join("\n"),
          targetMarker,
          profileMarker,
          trustedTool,
        ],
        {
          cwd: target,
          env: {
            ...process.env,
            CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT: "1",
            PATH: `${trustedBin}:${process.env.PATH ?? ""}`,
          },
          timeoutMs: 3_000,
          writableRoots: [target, profile],
        },
      );

      assert.equal(output, "blocked");
      assert.equal(readFileSync(targetMarker, "utf8"), "target");
      assert.equal(readFileSync(profileMarker, "utf8"), "profile");
      assert.equal(readFileSync(trustedTool, "utf8"), "trusted\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Linux containment protects namespace init from target termination",
  { skip: process.platform !== "linux" },
  (context) => {
    if (!linuxValidationContainmentAvailable()) {
      context.skip("runner does not provide delegated user namespaces and Landlock ABI 3+");
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
                `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped"), 750);`)}], { detached: true, stdio: "ignore" });`,
                "child.unref();",
                'process.kill(process.ppid, "SIGKILL");',
                "setInterval(() => {}, 1000);",
              ].join(" "),
            ],
            {
              env: {
                ...process.env,
                CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT: "1",
              },
              timeoutMs: 3_000,
              writableRoots: [root],
            },
          ),
        /command timed out after 3000ms/,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
      assert.equal(existsSync(marker), false);
    } finally {
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

function linuxValidationContainmentAvailable() {
  const probe = spawnSync(
    "/usr/bin/unshare",
    [
      "--user",
      "--map-root-user",
      "--pid",
      "--fork",
      "--mount-proc",
      "--kill-child=SIGKILL",
      "/usr/bin/python3",
      "-c",
      [
        "import ctypes, os",
        "libc = ctypes.CDLL(None, use_errno=True)",
        "libc.syscall.restype = ctypes.c_long",
        "abi = libc.syscall(ctypes.c_long(444), ctypes.c_void_p(), ctypes.c_size_t(0), ctypes.c_uint32(1))",
        "assert os.getpid() == 1",
        "assert abi >= 3",
      ].join("; "),
    ],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}
