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

test("isolated push rejects an ancestor reset after the expected head was read", () => {
  const fixture = pushLeaseFixture();
  const expectedHead = git(fixture.target, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(fixture.target, "source.txt"), "validated\n");
  git(fixture.target, "commit", "-am", "validated");
  const sourceHead = git(fixture.target, "rev-parse", "HEAD");
  const resetHead = git(fixture.target, "rev-parse", `${expectedHead}^`);
  git(fixture.remote, "update-ref", "refs/heads/main", resetHead);

  assert.throws(() =>
    runIsolatedGitNetwork({
      args: [
        "push",
        `--force-with-lease=refs/heads/main:${expectedHead}`,
        fixture.remote,
        `${sourceHead}:refs/heads/main`,
      ],
      cwd: fixture.target,
      env: process.env,
      timeoutMs: 10_000,
      token: "test-token",
    }),
  );
  assert.equal(git(fixture.remote, "rev-parse", "refs/heads/main"), resetHead);
});

test("isolated push atomically requires a replacement branch to remain absent", () => {
  const fixture = pushLeaseFixture();
  const sourceHead = git(fixture.target, "rev-parse", "HEAD");
  git(fixture.remote, "update-ref", "refs/heads/replacement", sourceHead);
  fs.writeFileSync(path.join(fixture.target, "source.txt"), "replacement\n");
  git(fixture.target, "commit", "-am", "replacement");
  const replacementHead = git(fixture.target, "rev-parse", "HEAD");

  assert.throws(() =>
    runIsolatedGitNetwork({
      args: [
        "push",
        "--force-with-lease=refs/heads/replacement:",
        fixture.remote,
        `${replacementHead}:refs/heads/replacement`,
      ],
      cwd: fixture.target,
      env: process.env,
      timeoutMs: 10_000,
      token: "test-token",
    }),
  );
  assert.equal(git(fixture.remote, "rev-parse", "refs/heads/replacement"), sourceHead);
});

function pushLeaseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-network-lease-"));
  const target = path.join(root, "target");
  const remote = path.join(root, "remote.git");
  git(root, "init", "--bare", remote);
  fs.mkdirSync(target);
  git(target, "init", "-b", "main");
  git(target, "config", "user.email", "clawsweeper@example.invalid");
  git(target, "config", "user.name", "ClawSweeper Test");
  fs.writeFileSync(path.join(target, "source.txt"), "initial\n");
  git(target, "add", ".");
  git(target, "commit", "-m", "initial");
  fs.writeFileSync(path.join(target, "source.txt"), "expected\n");
  git(target, "commit", "-am", "expected");
  git(target, "push", remote, "HEAD:refs/heads/main");
  return { remote, target };
}

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
