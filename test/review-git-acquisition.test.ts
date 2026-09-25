import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runGitAcquisitionResult } from "../dist/repair/command-runner.js";
import { forceTerminateProcessTree } from "../dist/repair/contained-command-worker.js";

const maxBuffer = 1024 * 1024;

for (const outcome of [
  { status: 0 },
  { status: 128 },
  { status: null, error: new Error("timeout") },
]) {
  test(`Windows acquisition requires successful taskkill receipt: status=${outcome.status}`, (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const oldRoot = process.env.SystemRoot;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.SystemRoot = "C:\\Windows";
      t.mock.method(childProcess, "spawnSync", (command, args, options) => {
        assert.match(command, /taskkill\.exe$/);
        assert.deepEqual(args, ["/pid", "12345", "/t", "/f"]);
        assert.ok(options.timeout > 0 && options.timeout <= 500);
        assert.equal(options.killSignal, "SIGKILL");
        return outcome;
      });
      syncBuiltinESMExports();
      const terminate = () => forceTerminateProcessTree(12345, Date.now() + 500);
      if (outcome.status === 0) assert.doesNotThrow(terminate);
      else assert.throws(terminate, /settlement could not be verified/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", descriptor);
      if (oldRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = oldRoot;
    }
  });
}

for (const mode of ["settled", "not-found", "signaled"]) {
  test(
    `Windows worker abort classification preserves settlement uncertainty: ${mode}`,
    { skip: process.platform === "win32" },
    (t) => {
      const root = mkdtempSync(join(tmpdir(), "review-git-windows-contract-"));
      const pidFile = join(root, "child.pid");
      t.after(() => {
        try {
          if (existsSync(pidFile)) {
            try {
              process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
      const preload = join(root, "windows-contract.mjs");
      const script = join(root, "git.mjs");
      const executable = join(root, "git.exe");
      symlinkSync(process.execPath, executable);
      writeFileSync(
        preload,
        `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
if (process.argv[1]?.endsWith("git-acquisition-worker.js")) {
  Object.defineProperty(process, "platform", { value: "win32" });
  const native = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, options) => {
    if (!command.endsWith("taskkill.exe")) return native(command, args, options);
    ${mode === "settled" ? 'process.kill(Number(args[1]), "SIGKILL"); return { status: 0 };' : "return { status: 128 };"}
  };
  syncBuiltinESMExports();
}`,
      );
      writeFileSync(
        script,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
${mode === "signaled" ? 'process.kill(process.pid, "SIGTERM");' : "setInterval(() => {}, 1000);"}`,
      );
      const result = runGitAcquisitionResult(["fetch"], {
        cwd: root,
        maxBuffer,
        timeoutMs: 1200,
        env: {
          ...process.env,
          SystemRoot: "C:\\Windows",
          NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
          GIT_BIN: executable,
          GIT_BIN_ARGS: JSON.stringify([script]),
        },
      });
      assert.equal(
        (result.error as NodeJS.ErrnoException)?.code,
        mode === "settled" ? "ETIMEDOUT" : "EPROCESSSETTLEMENT",
        result.stderr,
      );
      if (mode !== "settled") assert.match(result.error?.message ?? "", /recovery required/i);
    },
  );
}

function shallowFixture() {
  const root = mkdtempSync(join(tmpdir(), "review-git-settlement-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, "config"),
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete env.GIT_BIN;
  delete env.GIT_BIN_ARGS;
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const target = join(root, "target");
  mkdirSync(source);
  git(root, "init", "--bare", "-q", origin);
  git(origin, "config", "uploadpack.allowFilter", "true");
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  git(source, "config", "commit.gpgsign", "false");
  for (const content of ["one", "two"]) {
    writeFileSync(join(source, "source.txt"), content);
    git(source, "add", ".");
    git(source, "commit", "-qm", content);
  }
  git(source, "push", "-q", origin, "main");
  git(
    root,
    "clone",
    "-q",
    "--depth=1",
    "--filter=blob:none",
    "--no-checkout",
    "--branch",
    "main",
    `file://${origin}`,
    target,
  );
  const args = [
    "fetch",
    "--no-auto-maintenance",
    "--filter=blob:none",
    "--no-tags",
    "--no-write-fetch-head",
    "--recurse-submodules=no",
    "--unshallow",
    "origin",
    "refs/heads/main:refs/remotes/origin/main",
  ];
  return { root, env, target, git, args, lock: join(target, ".git", "shallow.lock") };
}

test(
  "interrupted native unshallow cleans its lock and settles transport before retry",
  { skip: process.platform === "win32" },
  () => {
    const fixture = shallowFixture();
    const { root, env, target, args, git, lock } = fixture;
    try {
      const hook = join(root, "pack-hook");
      const marker = join(root, "pack-started");
      writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$$" > '${marker}'\nsleep 3\nexec "$@"\n`, {
        mode: 0o700,
      });
      git(root, "config", "--file", env.GIT_CONFIG_GLOBAL, "uploadpack.packObjectsHook", hook);
      const started = Date.now();
      const failed = runGitAcquisitionResult(args, {
        cwd: target,
        env,
        maxBuffer,
        timeoutMs: 1000,
      });
      assert.equal((failed.error as NodeJS.ErrnoException)?.code, "ETIMEDOUT", failed.stderr);
      assert.ok(Date.now() - started < 1500, "termination and settlement share the attempt budget");
      assert.equal(
        existsSync(marker),
        true,
        "interrupt an actual pack transfer after shallow.lock acquisition",
      );
      assert.equal(existsSync(lock), false);
      const hookPid = Number(readFileSync(marker, "utf8").trim());
      assert.throws(() => process.kill(hookPid, 0), { code: "ESRCH" });
      assert.equal(git(target, "rev-parse", "--is-shallow-repository"), "true");
      const retry = runGitAcquisitionResult(args, { cwd: target, env, maxBuffer, timeoutMs: 5000 });
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(git(target, "rev-parse", "--is-shallow-repository"), "false");
      assert.equal(existsSync(lock), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Git acquisition never removes a preexisting shallow lock", () => {
  const { root, target, env, args, lock } = shallowFixture();
  try {
    writeFileSync(lock, "another acquisition owns this lock\n");
    const result = runGitAcquisitionResult(args, { cwd: target, env, maxBuffer, timeoutMs: 3000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shallow\.lock/);
    assert.equal(readFileSync(lock, "utf8"), "another acquisition owns this lock\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted Git overrides preserve arguments and cannot spoof supervisor output", () => {
  const root = mkdtempSync(join(tmpdir(), "review-git-override-"));
  try {
    const script = join(root, "git.mjs");
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({pid:1}) + "\\n" + JSON.stringify(process.argv.slice(2)));',
    );
    const result = runGitAcquisitionResult(["fetch", "argument with space"], {
      cwd: root,
      maxBuffer,
      timeoutMs: 3000,
      env: {
        ...process.env,
        GIT_BIN: process.execPath,
        GIT_BIN_ARGS: JSON.stringify([script, "prefix"]),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '{"pid":1}\n["prefix","fetch","argument with space"]');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relative acquisition cwd is resolved once before both spawn levels", () => {
  const root = mkdtempSync(join(tmpdir(), "review-git-relative-cwd-"));
  try {
    const target = join(root, "target");
    mkdirSync(target);
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import { runGitAcquisitionResult } from ${JSON.stringify(new URL("../dist/repair/command-runner.js", import.meta.url).href)};
const result = runGitAcquisitionResult(["fetch"], {
  cwd: "target", maxBuffer: 1048576, timeoutMs: 3000,
  env: { ...process.env, GIT_BIN: process.execPath,
    GIT_BIN_ARGS: JSON.stringify(["-e", "process.stdout.write(process.cwd())"]) }
});
console.log(JSON.stringify(result));
`,
        ],
        { cwd: root, encoding: "utf8", timeout: 5000 },
      ),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, realpathSync(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an expired startup budget does not start Git or grant extra cleanup time", () => {
  const root = mkdtempSync(join(tmpdir(), "review-git-deadline-"));
  try {
    const marker = join(root, "started");
    const started = Date.now();
    const result = runGitAcquisitionResult(["fetch"], {
      cwd: root,
      maxBuffer,
      timeoutMs: 1,
      env: {
        ...process.env,
        GIT_BIN: process.execPath,
        GIT_BIN_ARGS: JSON.stringify([
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`,
        ]),
      },
    });
    assert.equal((result.error as NodeJS.ErrnoException)?.code, "EPROCESSSETTLEMENT");
    assert.ok(Date.now() - started < 500);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("early Git rejection while sending a large object list preserves its settled failure", () => {
  const result = runGitAcquisitionResult(["fetch"], {
    cwd: process.cwd(),
    maxBuffer,
    timeoutMs: 3000,
    input: "a".repeat(2 * 1024 * 1024),
    env: {
      ...process.env,
      GIT_BIN: process.execPath,
      GIT_BIN_ARGS: JSON.stringify([
        "-e",
        'process.stderr.write("fatal: HTTP 403\\n"); process.exit(128);',
        "--",
      ]),
    },
  });
  assert.equal(result.status, 128);
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, "fatal: HTTP 403\n");
});

test(
  "Git supervisor kills TERM-resistant descendants within the original deadline",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "review-git-descendants-"));
    try {
      const script = join(root, "git.mjs");
      const marker = join(root, "escaped");
      const pids = join(root, "pids");
      writeFileSync(
        script,
        `import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
process.on("SIGTERM", () => {});
appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");
spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); require("node:fs").appendFileSync(process.argv[1], process.pid + String.fromCharCode(10)); setTimeout(() => require("node:fs").writeFileSync(process.argv[2], "escaped"), 2000); setInterval(() => {}, 1000);', ${JSON.stringify(pids)}, ${JSON.stringify(marker)}], { stdio: "inherit" });
setInterval(() => {}, 1000);`,
      );
      const started = Date.now();
      const result = runGitAcquisitionResult(["fetch"], {
        cwd: root,
        maxBuffer,
        timeoutMs: 1200,
        env: { ...process.env, GIT_BIN: process.execPath, GIT_BIN_ARGS: JSON.stringify([script]) },
      });
      assert.equal((result.error as NodeJS.ErrnoException)?.code, "ETIMEDOUT", result.stderr);
      assert.ok(Date.now() - started < 1700);
      const children = readFileSync(pids, "utf8").trim().split("\n").map(Number);
      assert.equal(children.length, 2);
      for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
