import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runIsolatedGitNetwork } from "../../dist/repair/git-network-isolation.js";

test("authenticated Git ignores target-local callbacks, signing, and URL rewrites", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-network-isolation-"));
  const target = path.join(root, "target");
  const remote = path.join(root, "remote.git");
  const redirected = path.join(root, "redirected.git");
  const marker = path.join(root, "callback-ran");
  git(root, "init", "--bare", remote);
  git(root, "init", "--bare", redirected);
  fs.mkdirSync(target);
  git(target, "init", "-b", "main");
  git(target, "config", "user.email", "clawsweeper@example.invalid");
  git(target, "config", "user.name", "ClawSweeper Test");
  fs.writeFileSync(path.join(target, "source.txt"), "validated\n");
  git(target, "add", ".");
  git(target, "commit", "-m", "validated");
  const head = git(target, "rev-parse", "HEAD");
  const callback = path.join(root, "callback.sh");
  fs.writeFileSync(callback, `#!/bin/sh\nprintf ran >${shellQuote(marker)}\nexit 91\n`, {
    mode: 0o755,
  });
  git(target, "config", "push.gpgSign", "true");
  git(target, "config", "gpg.program", callback);
  git(target, "config", `url.${redirected}.insteadOf`, remote);

  runIsolatedGitNetwork({
    args: ["push", remote, `${head}:refs/heads/validated`],
    cwd: target,
    env: process.env,
    timeoutMs: 10_000,
    token: "test-token",
  });

  assert.equal(git(remote, "rev-parse", "refs/heads/validated"), head);
  assert.throws(() => git(redirected, "rev-parse", "refs/heads/validated"));
  assert.equal(fs.existsSync(marker), false);
});

test("isolated authenticated fetch mirrors only the verified destination ref", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-network-fetch-"));
  const target = path.join(root, "target");
  const remote = path.join(root, "remote.git");
  git(root, "init", "--bare", remote);
  fs.mkdirSync(target);
  git(target, "init", "-b", "main");
  git(target, "config", "user.email", "clawsweeper@example.invalid");
  git(target, "config", "user.name", "ClawSweeper Test");
  fs.writeFileSync(path.join(target, "source.txt"), "validated\n");
  git(target, "add", ".");
  git(target, "commit", "-m", "validated");
  const head = git(target, "rev-parse", "HEAD");
  git(target, "push", remote, `${head}:refs/heads/main`);

  runIsolatedGitNetwork({
    args: ["fetch", remote, "+refs/heads/main:refs/remotes/origin/main"],
    cwd: target,
    env: process.env,
    timeoutMs: 10_000,
    token: "test-token",
  });

  assert.equal(git(target, "rev-parse", "refs/remotes/origin/main"), head);
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
