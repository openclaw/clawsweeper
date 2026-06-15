import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitMetadata } from "../dist/commit-sweeper.js";

const GIT = process.env.GIT_BIN ?? "git";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();
}

// The local-review offline contract: commitMetadata(..., offline=true) must read
// only local git and never shell out to `gh`. Using an UNSUPPORTED repo slug proves
// it: a real gh api call against "example/unsupported-repo" would fail, so a passing
// run with populated local fields confirms gh was never invoked.
test("commitMetadata offline mode uses only local git and never contacts GitHub", () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-meta-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.name", "Test Author");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "f.txt"), "hello\n");
    git(dir, "add", "f.txt");
    git(dir, "commit", "-q", "-m", "initial");
    const sha = git(dir, "rev-parse", "HEAD");

    const meta = commitMetadata(dir, "example/unsupported-repo", sha, true);

    // Offline: gh-api author/committer hydration is skipped entirely.
    assert.equal(meta.githubAuthor, "");
    assert.equal(meta.githubCommitter, "");
    // Local git metadata is still populated from `git show`.
    assert.equal(meta.sha, sha);
    assert.equal(meta.authorName, "Test Author");
    assert.equal(meta.authorEmail, "test@example.com");
    assert.equal(meta.subject, "initial");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
