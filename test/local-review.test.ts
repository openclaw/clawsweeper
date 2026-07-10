import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  commitMetadata,
  localReviewAdditionalPrompt,
  LOCAL_REVIEW_SCRUBBED_TOKEN_ENV,
  LOCAL_REVIEW_WEB_SEARCH_CONFIG,
} from "../dist/commit-sweeper.js";

const GIT = process.env.GIT_BIN ?? "git";
const CLI = fileURLToPath(new URL("../dist/commit-sweeper.js", import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lr-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Test Author");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "--author", "Test Author <test@example.com>", "-m", "init");
  return dir;
}

function runLocalReview(dir: string, args: string[]): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [CLI, "local-review", "--target-dir", dir, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env },
  });
  return { status: result.status, out: `${result.stderr ?? ""}${result.stdout ?? ""}` };
}

// The local-review offline contract: commitMetadata(..., offline=true) must read
// only local git and never shell out to `gh`. Using an UNSUPPORTED repo slug proves
// it: a real gh api call against "example/unsupported-repo" would fail, so a passing
// run with populated local fields confirms gh was never invoked.
test("commitMetadata offline mode uses only local git and never contacts GitHub", () => {
  const dir = initRepo();
  try {
    const sha = git(dir, "rev-parse", "HEAD");
    const meta = commitMetadata(dir, "example/unsupported-repo", sha, true);

    assert.equal(meta.githubAuthor, "");
    assert.equal(meta.githubCommitter, "");
    assert.equal(meta.sha, sha);
    assert.equal(meta.authorName, "Test Author");
    assert.equal(meta.authorEmail, "test@example.com");
    assert.equal(meta.subject, "init");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review refuses a dirty working tree", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "dirty.txt"), "x\n"); // untracked -> dirty
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "openclaw/clawsweeper",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /working tree not clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review rejects an unsupported repository instead of a foreign-profile fallback", () => {
  const dir = initRepo();
  try {
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "nobody/not-a-real-profile",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /no review profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review rejects repositories covered only by a generic owner fallback", () => {
  const dir = initRepo();
  try {
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "openclaw/example-tool",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /no review profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review reports nothing to review when HEAD has no commits beyond base", () => {
  const dir = initRepo();
  try {
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "openclaw/clawsweeper",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /no commits on HEAD beyond/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review scrubs both GitHub and GitHub Enterprise token aliases", () => {
  for (const v of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "COMMIT_SWEEPER_TARGET_GH_TOKEN",
    "CLAWSWEEPER_PROOF_INSPECTION_TOKEN",
  ]) {
    assert.ok(
      LOCAL_REVIEW_SCRUBBED_TOKEN_ENV.includes(v),
      `${v} must be in the offline scrub list`,
    );
  }
});

test("local-review disables web search and forbids network lookups in its prompt", () => {
  assert.equal(LOCAL_REVIEW_WEB_SEARCH_CONFIG, 'web_search="disabled"');
  const prompt = localReviewAdditionalPrompt("a".repeat(40), "b".repeat(40), "main");
  assert.match(prompt, /do not run gh/i);
  assert.match(prompt, /do not .*web search/i);
  assert.match(prompt, /do not .*network request/i);
  assert.match(prompt, /only the local checkout and git history/i);
});
