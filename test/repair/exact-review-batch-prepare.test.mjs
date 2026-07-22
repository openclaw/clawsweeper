import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createIsolatedStateClone,
  run,
  runBoundedPool,
} from "../../scripts/prepare-exact-review-batch.mjs";

test("bounded preparation never exceeds four workers and preserves manifest order", async () => {
  const completionOrder = [];
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 32 }, (_, index) => index);
  const { results, peak: reportedPeak } = await runBoundedPool(items, 4, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, (7 - (item % 7)) * 2));
    completionOrder.push(item);
    active -= 1;
    return `outcome-${item}`;
  });

  assert.equal(peak, 4);
  assert.equal(reportedPeak, 4);
  assert.notDeepEqual(completionOrder, items);
  assert.deepEqual(
    results,
    items.map((item) => `outcome-${item}`),
  );
});

test("concurrency one is serial and invalid concurrency fails closed", async () => {
  const order = [];
  const { results, peak } = await runBoundedPool([3, 2, 1], 1, async (item) => {
    order.push(item);
    return item * 2;
  });
  assert.deepEqual(order, [3, 2, 1]);
  assert.deepEqual(results, [6, 4, 2]);
  assert.equal(peak, 1);
  await assert.rejects(() => runBoundedPool([1], 5, async () => 1), /between 1 and 4/);
});

test("a process timeout terminates the full worker process group", async () => {
  const startedAt = Date.now();
  const result = await run(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    timeoutMs: 25,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("parallel preparers use independent shallow state repositories", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-exact-review-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const stateRoot = join(root, "state");
  git(root, "init", "--bare", origin);
  git(root, "clone", origin, source);
  git(source, "config", "user.name", "ClawSweeper Test");
  git(source, "config", "user.email", "clawsweeper@example.com");
  writeFileSync(join(source, "record.md"), "record\n");
  git(source, "add", "record.md");
  git(source, "commit", "-m", "seed state");
  git(source, "branch", "-M", "state");
  git(source, "push", "origin", "state");
  const remoteUrl = `file://${origin}`;
  git(root, "clone", "--depth", "1", "--branch", "state", remoteUrl, stateRoot);
  const baselineSha = git(stateRoot, "rev-parse", "HEAD");
  const left = join(root, "left");
  const right = join(root, "right");

  await Promise.all([
    createIsolatedStateClone({
      stateRoot,
      destination: left,
      baselineSha,
      timeoutMs: 5_000,
    }),
    createIsolatedStateClone({
      stateRoot,
      destination: right,
      baselineSha,
      timeoutMs: 5_000,
    }),
  ]);

  assert.equal(git(left, "remote", "get-url", "origin"), remoteUrl);
  assert.equal(git(right, "remote", "get-url", "origin"), remoteUrl);
  assert.equal(git(left, "rev-parse", "HEAD"), baselineSha);
  assert.equal(git(right, "rev-parse", "HEAD"), baselineSha);
  assert.equal(git(left, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(git(right, "rev-parse", "--is-shallow-repository"), "true");
  const leftGitDir = git(left, "rev-parse", "--absolute-git-dir");
  const rightGitDir = git(right, "rev-parse", "--absolute-git-dir");
  assert.notEqual(leftGitDir, rightGitDir);
  assert.notEqual(join(leftGitDir, "shallow"), join(rightGitDir, "shallow"));

  writeFileSync(join(source, "record.md"), "updated\n");
  git(source, "commit", "-am", "update state");
  git(source, "push", "origin", "state");
  const updatedSha = git(source, "rev-parse", "HEAD");
  const fetches = await Promise.all([
    run("git", ["-C", left, "fetch", "--depth=1", "origin", "state"]),
    run("git", ["-C", right, "fetch", "--depth=1", "origin", "state"]),
  ]);
  assert.deepEqual(
    fetches.map(({ code }) => code),
    [0, 0],
  );
  git(left, "reset", "--hard", "FETCH_HEAD");
  git(right, "reset", "--hard", "FETCH_HEAD");
  assert.equal(git(left, "rev-parse", "HEAD"), updatedSha);
  assert.equal(git(right, "rev-parse", "HEAD"), updatedSha);
});

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
