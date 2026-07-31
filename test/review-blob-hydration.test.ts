import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hydratePullRequestReviewBlobs } from "../dist/clawsweeper-review-blobs.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function partialCloneFixture() {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-promisor-"));
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(source);
  git(root, "init", "--bare", "-q", origin);
  git(origin, "config", "uploadpack.allowFilter", "true");
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "ClawSweeper Review Test");
  git(source, "config", "user.email", "review-test@example.com");
  git(source, "config", "commit.gpgsign", "false");
  writeFileSync(join(source, "changed.txt"), "before\n");
  writeFileSync(join(source, "removed.txt"), "remove me\n");
  git(source, "add", ".");
  git(source, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/library`);
  git(source, "commit", "-qm", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  git(source, "remote", "add", "origin", origin);
  git(source, "push", "-q", "origin", "main");

  git(source, "checkout", "-qb", "feature");
  writeFileSync(join(source, "changed.txt"), "after\n");
  writeFileSync(join(source, "added.txt"), "new implementation\n");
  mkdirSync(join(source, "nested"));
  writeFileSync(join(source, "nested", "feature[1].txt"), "nested literal\n");
  writeFileSync(join(source, ":(glob)literal.txt"), "pathspec literal\n");
  git(source, "rm", "-q", "removed.txt");
  git(source, "add", ".");
  git(source, "update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},vendor/library`);
  git(source, "commit", "-qm", "feature");
  const headSha = git(source, "rev-parse", "HEAD");
  const addedBlobSha = git(source, "rev-parse", "HEAD:added.txt");
  const changedBlobSha = git(source, "rev-parse", "HEAD:changed.txt");
  git(source, "push", "-q", "origin", "HEAD:refs/pull/982/head");
  git(
    root,
    "clone",
    "-q",
    "--filter=blob:none",
    "--branch",
    "main",
    "--single-branch",
    `file://${origin}`,
    target,
  );
  git(
    target,
    "fetch",
    "-q",
    "--filter=blob:none",
    "origin",
    "refs/pull/982/head:refs/clawsweeper/review-cache/head-982",
    "--depth=1",
  );
  return { root, target, baseSha, headSha, addedBlobSha, changedBlobSha };
}

function objectExistsOffline(cwd: string, sha: string): boolean {
  return (
    spawnSync("git", ["cat-file", "-e", sha], {
      cwd,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: "ignore",
    }).status === 0
  );
}

test("restricted PR review can inspect changed blobs from a genuine blobless clone offline", () => {
  const fixture = partialCloneFixture();
  try {
    assert.equal(objectExistsOffline(fixture.target, fixture.addedBlobSha), false);
    assert.equal(objectExistsOffline(fixture.target, fixture.changedBlobSha), false);

    const result = hydratePullRequestReviewBlobs({
      targetDir: fixture.target,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      files: [
        { filename: "added.txt", status: "added" },
        { filename: "nested/feature[1].txt", status: "added" },
        { filename: ":(glob)literal.txt", status: "added" },
        { filename: "changed.txt", status: "modified" },
        { filename: "vendor/library", status: "modified" },
        { filename: "removed.txt", status: "removed" },
      ],
    });

    assert.equal(result.hydrated, true);
    assert.equal(result.blobs, 6);
    assert.equal(objectExistsOffline(fixture.target, fixture.addedBlobSha), true);
    assert.equal(objectExistsOffline(fixture.target, fixture.changedBlobSha), true);
    git(fixture.target, "remote", "set-url", "origin", "https://invalid.invalid/offline.git");
    assert.equal(git(fixture.target, "show", `${fixture.headSha}:added.txt`), "new implementation");
    assert.equal(git(fixture.target, "show", `${fixture.headSha}:changed.txt`), "after");
    assert.equal(
      git(fixture.target, "show", `${fixture.headSha}:nested/feature[1].txt`),
      "nested literal",
    );
    assert.equal(
      git(fixture.target, "show", `${fixture.headSha}::(glob)literal.txt`),
      "pathspec literal",
    );
    assert.match(
      git(fixture.target, "diff", fixture.baseSha, fixture.headSha, "--", "changed.txt"),
      /\+after/,
    );
    assert.equal(git(fixture.target, "status", "--porcelain"), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review blob hydration rejects unsafe paths and oversized changes without fetching", () => {
  const fixture = partialCloneFixture();
  try {
    for (const filename of ["../secret", "/absolute", ".git/config", "nested/../secret", "a\\b"]) {
      assert.deepEqual(
        hydratePullRequestReviewBlobs({
          targetDir: fixture.target,
          baseSha: fixture.baseSha,
          headSha: fixture.headSha,
          files: [{ filename, status: "added" }],
        }),
        { hydrated: false, blobs: 0 },
        filename,
      );
    }
    assert.deepEqual(
      hydratePullRequestReviewBlobs({
        targetDir: fixture.target,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        files: Array.from({ length: 81 }, () => ({ filename: "added.txt", status: "added" })),
      }),
      { hydrated: false, blobs: 0 },
    );
    assert.equal(objectExistsOffline(fixture.target, fixture.addedBlobSha), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
