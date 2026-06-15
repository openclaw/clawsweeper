import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compactGeneratedBranchHistory } from "./compact-generated-branch.js";

test("generated branch compaction keeps the reviewed tree and removes checkpoint noise", () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-compact-"));
  test.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  git(targetDir, "init", "-b", "main");
  git(targetDir, "config", "user.name", "ClawSweeper");
  git(targetDir, "config", "user.email", "clawsweeper@example.com");
  fs.writeFileSync(path.join(targetDir, "runtime.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(targetDir, "PR_DESCRIPTION.md"), "existing body\n");
  git(targetDir, "add", "--all");
  git(targetDir, "commit", "-m", "initial");
  git(targetDir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(targetDir, "checkout", "-b", "clawsweeper/fix");

  fs.writeFileSync(path.join(targetDir, "runtime.ts"), "export const value = 2;\n");
  fs.writeFileSync(path.join(targetDir, "PR_DESCRIPTION.md"), "worker noise\n");
  git(targetDir, "add", "--all");
  git(targetDir, "commit", "-m", "fix: update runtime");

  fs.writeFileSync(path.join(targetDir, "PR_DESCRIPTION.md"), "existing body\n");
  fs.writeFileSync(path.join(targetDir, "runtime.test.ts"), "test('value', () => {});\n");
  git(targetDir, "add", "--all");
  git(targetDir, "commit", "-m", "fix(clawsweeper): address review");

  const reviewedTree = git(targetDir, "rev-parse", "HEAD^{tree}").trim();
  const result = compactGeneratedBranchHistory({
    targetDir,
    baseRef: "origin/main",
    message: "fix: update runtime",
    trailers: ["Co-authored-by: Contributor <contributor@example.com>"],
  });

  assert.equal(result.status, "compacted");
  assert.equal(result.previous_commit_count, 2);
  assert.equal(git(targetDir, "rev-list", "--count", "origin/main..HEAD").trim(), "1");
  assert.equal(git(targetDir, "rev-parse", "HEAD^{tree}").trim(), reviewedTree);
  assert.deepEqual(
    git(targetDir, "diff", "--name-only", "origin/main", "HEAD").trim().split("\n"),
    ["runtime.test.ts", "runtime.ts"],
  );
  assert.match(
    git(targetDir, "show", "-s", "--format=%B", "HEAD"),
    /Co-authored-by: Contributor <contributor@example\.com>/,
  );
  assert.equal(git(targetDir, "status", "--porcelain"), "");

  const unchanged = compactGeneratedBranchHistory({
    targetDir,
    baseRef: "origin/main",
    message: "fix: update runtime",
  });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.previous_commit_count, 1);
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
