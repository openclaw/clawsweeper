import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runGitResult } from "../../dist/repair/git.js";
import { mockCommandBinEnv } from "../helpers.ts";

test("git helper bounds execution and terminates the timed-out process", async (t) => {
  const fixture = fakeGitFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const controlMarker = path.join(fixture.root, "control-marker");
  const marker = path.join(fixture.root, "late-marker");

  const control = runGitResult(["stall", controlMarker], {
    cwd: fixture.root,
    env: fixture.env,
  });
  assert.equal(control.status, 0);
  assert.match(control.stderr, /waiting for timeout/);
  assert.equal(fs.readFileSync(controlMarker, "utf8"), "late\n");

  assert.throws(
    () =>
      runGitResult(["stall", marker], {
        cwd: fixture.root,
        timeoutMs: 250,
        env: fixture.env,
      }),
    /command timed out after 250ms: git stall/,
  );
  await delay(750);
  assert.equal(fs.existsSync(marker), false);
});

test("git helper preserves stderr in timeout errors", (t) => {
  t.mock.method(childProcess, "spawnSync", () => ({
    error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "waiting for timeout\n",
  }));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.throws(
    () => runGitResult(["stall"], { cwd: process.cwd(), timeoutMs: 250 }),
    /command timed out after 250ms: git stall\nwaiting for timeout/,
  );
});

test("git helper preserves ordinary nonzero status and stderr", () => {
  const fixture = fakeGitFixture();
  const child = runGitResult(["fail"], {
    cwd: fixture.root,
    timeoutMs: 1_000,
    env: fixture.env,
  });

  assert.equal(child.status, 23);
  assert.equal(child.signal, null);
  assert.match(child.stderr, /ordinary git failure/);
});

test("git helper reports spawn errors instead of returning an empty status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-git-spawn-"));
  assert.throws(
    () =>
      runGitResult(["status"], {
        cwd: root,
        timeoutMs: 1_000,
        env: {
          ...process.env,
          GIT_BIN: path.join(root, "missing-git-command"),
          GIT_BIN_ARGS: "[]",
        },
      }),
    /ENOENT|not found/i,
  );
});

test(
  "git helper preserves signal termination semantics",
  { skip: process.platform === "win32" },
  () => {
    const fixture = fakeGitFixture();
    const child = runGitResult(["signal"], {
      cwd: fixture.root,
      timeoutMs: 1_000,
      env: fixture.env,
    });

    assert.equal(child.status, null);
    assert.equal(child.signal, "SIGTERM");
  },
);

function fakeGitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fake-git-"));
  const scriptPath = path.join(root, "fake-git.cjs");
  fs.writeFileSync(
    scriptPath,
    [
      'const fs = require("node:fs");',
      "const [mode, marker] = process.argv.slice(2);",
      'if (mode === "fail") { process.stderr.write("ordinary git failure\\n"); process.exit(23); }',
      'if (mode === "signal") process.kill(process.pid, "SIGTERM");',
      'if (mode === "stall") {',
      '  process.stderr.write("waiting for timeout\\n");',
      '  setTimeout(() => fs.writeFileSync(marker, "late\\n"), 600);',
      "}",
      "",
    ].join("\n"),
  );
  return {
    root,
    env: { ...process.env, ...mockCommandBinEnv("git", scriptPath) },
  };
}
