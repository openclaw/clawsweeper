import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  branchHasBaseDiff,
  ensureMergeBaseAvailable,
  runGitCommand,
} from "../../dist/repair/git-repo-utils.js";
import { mockCommandBinEnv } from "../helpers.ts";

test("git helper bounds execution and terminates the timed-out process", async () => {
  const fixture = fakeGitFixture();
  const marker = path.join(fixture.root, "late-marker");

  assert.throws(
    () =>
      runGitCommand(["stall", marker], {
        targetDir: fixture.root,
        timeoutMs: 250,
        env: fixture.env,
      }),
    /command timed out after 250ms: git stall.*waiting for timeout/s,
  );
  await delay(750);
  assert.equal(fs.existsSync(marker), false);
});

test("git helper preserves ordinary nonzero status and stderr", () => {
  const fixture = fakeGitFixture();
  const child = runGitCommand(["fail"], {
    targetDir: fixture.root,
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
      runGitCommand(["status"], {
        targetDir: root,
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
    const child = runGitCommand(["signal"], {
      targetDir: fixture.root,
      timeoutMs: 1_000,
      env: fixture.env,
    });

    assert.equal(child.status, null);
    assert.equal(child.signal, "SIGTERM");
  },
);

for (const pruneConfig of ["fetch.prune", "remote.origin.prune"]) {
  test(`base fetch updates its requested ref with ${pruneConfig}=true`, () => {
    const { root, remote, work } = fixtureRepo();
    try {
      const originalBase = run("git", ["rev-parse", "HEAD"], { cwd: work });
      fs.writeFileSync(path.join(work, "main.txt"), "new base\n");
      run("git", ["add", "main.txt"], { cwd: work });
      run("git", ["commit", "-m", "advance main"], { cwd: work });
      const newBase = run("git", ["rev-parse", "HEAD"], { cwd: work });
      run("git", ["push", "origin", "main"], { cwd: work });
      run("git", ["update-ref", "refs/remotes/origin/main", originalBase], { cwd: work });
      if (pruneConfig === "remote.origin.prune") {
        run("git", ["config", "fetch.prune", "false"], { cwd: work });
      }
      run("git", ["config", pruneConfig, "true"], { cwd: work });

      assert.equal(ensureMergeBaseAvailable({ targetDir: work, baseBranch: "main" }), newBase);
      assert.equal(run("git", ["rev-parse", "origin/main"], { cwd: work }), newBase);

      // A shallow feature checkout needs the deeper-history fallback before diffing.
      run("git", ["checkout", "-b", "feature", originalBase], { cwd: work });
      fs.writeFileSync(path.join(work, "feature.txt"), "feature\n");
      run("git", ["add", "feature.txt"], { cwd: work });
      run("git", ["commit", "-m", "feature"], { cwd: work });
      run("git", ["push", "origin", "feature"], { cwd: work });
      const shallow = path.join(root, "shallow");
      run("git", ["clone", "--no-local", "--depth=1", "--branch=feature", remote, shallow]);
      run("git", ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main", "--depth=1"], {
        cwd: shallow,
      });
      if (pruneConfig === "remote.origin.prune") {
        run("git", ["config", "fetch.prune", "false"], { cwd: shallow });
      }
      run("git", ["config", pruneConfig, "true"], { cwd: shallow });
      assert.notEqual(
        spawnSync("git", ["merge-base", "origin/main", "HEAD"], { cwd: shallow }).status,
        0,
      );
      assert.equal(branchHasBaseDiff({ targetDir: shallow, baseBranch: "main" }), true);
      assert.equal(run("git", ["rev-parse", "origin/main"], { cwd: shallow }), newBase);
      assert.equal(
        run("git", ["merge-base", "origin/main", "HEAD"], { cwd: shallow }),
        originalBase,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("ensureMergeBaseAvailable deepens shallow history without pruning the base ref", (t) => {
  const { root, remote, work } = fixtureRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseSha = run("git", ["rev-parse", "HEAD"], { cwd: work });
  run("git", ["checkout", "-b", "feature"], { cwd: work });
  fs.writeFileSync(path.join(work, "feature.txt"), "feature\n");
  run("git", ["add", "feature.txt"], { cwd: work });
  run("git", ["commit", "-m", "feature"], { cwd: work });
  run("git", ["push", "origin", "feature"], { cwd: work });

  run("git", ["checkout", "main"], { cwd: work });
  fs.writeFileSync(path.join(work, "main.txt"), "main\n");
  run("git", ["add", "main.txt"], { cwd: work });
  run("git", ["commit", "-m", "main update"], { cwd: work });
  run("git", ["push", "origin", "main"], { cwd: work });

  const shallow = path.join(root, "shallow");
  run("git", [
    "clone",
    "--depth=1",
    "--no-single-branch",
    "--branch",
    "feature",
    pathToFileURL(remote).href,
    shallow,
  ]);
  run("git", ["config", "--local", "fetch.prune", "true"], { cwd: shallow });
  assert.equal(run("git", ["rev-parse", "--is-shallow-repository"], { cwd: shallow }), "true");
  assert.equal(
    runGitCommand(["merge-base", "origin/main", "HEAD"], { targetDir: shallow }).status,
    1,
  );

  assert.equal(ensureMergeBaseAvailable({ targetDir: shallow, baseBranch: "main" }), baseSha);
  assert.equal(run("git", ["rev-parse", "--is-shallow-repository"], { cwd: shallow }), "false");
  assert.equal(run("git", ["merge-base", "origin/main", "HEAD"], { cwd: shallow }), baseSha);
});

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-git-utils-"));
  const remote = path.join(root, "origin.git");
  const work = path.join(root, "work");
  run("git", ["init", "--bare", "--initial-branch=main", remote]);
  fs.mkdirSync(work);
  run("git", ["init", "--initial-branch=main"], { cwd: work });
  run("git", ["config", "core.autocrlf", "false"], { cwd: work });
  run("git", ["config", "core.eol", "lf"], { cwd: work });
  run("git", ["config", "--local", "fetch.prune", "true"], { cwd: work });
  run("git", ["config", "user.name", "ClawSweeper Test"], { cwd: work });
  run("git", ["config", "user.email", "clawsweeper-test@example.com"], { cwd: work });
  run("git", ["remote", "add", "origin", remote], { cwd: work });
  fs.writeFileSync(path.join(work, "shared.txt"), "base\n");
  run("git", ["add", "shared.txt"], { cwd: work });
  run("git", ["commit", "-m", "base"], { cwd: work });
  run("git", ["push", "-u", "origin", "main"], { cwd: work });
  return { root, remote, work };
}

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

function run(command, args, options = {}) {
  const child = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(
    child.status,
    0,
    `${command} ${args.join(" ")} failed\n${child.stderr}\n${child.stdout}`,
  );
  return child.stdout.trim();
}
