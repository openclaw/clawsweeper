import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { currentMainHeadSha } from "../../dist/repair/git.js";

test("repair main head reads origin/main and throws Git failures", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "repair-main-head-"));
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git(["init", "-q"]);
    const tree = git(["hash-object", "-w", "-t", "tree", "--stdin"]);
    const commit = (message: string) =>
      git([
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit-tree",
        tree,
        "-m",
        message,
      ]);
    const main = commit("main");
    const head = commit("head");
    git(["update-ref", "refs/remotes/origin/main", main]);
    git(["update-ref", "HEAD", head]);
    assert.notEqual(head, main);
    assert.equal(currentMainHeadSha(cwd), main);

    git(["update-ref", "-d", "refs/remotes/origin/main"]);
    assert.throws(() => currentMainHeadSha(cwd), /ambiguous argument 'origin\/main'/);
    assert.throws(() => currentMainHeadSha(path.join(cwd, "absent")), /ENOENT/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
