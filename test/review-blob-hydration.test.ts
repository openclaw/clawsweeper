import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  githubReviewBlobSizes,
  hydratePullRequestReviewBlobs,
} from "../dist/clawsweeper-review-blobs.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function partialCloneFixture({
  extraFiles = 0,
  largeFiles = [],
}: { extraFiles?: number; largeFiles?: number[] } = {}) {
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
  for (let index = 0; index < extraFiles; index += 1) {
    writeFileSync(join(source, `additional-${index}.txt`), `additional ${index}\n`);
  }
  for (const [index, bytes] of largeFiles.entries()) {
    writeFileSync(join(source, `large-${index}.bin`), Buffer.alloc(bytes, index + 1));
  }
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
  return { root, source, target, baseSha, headSha, addedBlobSha, changedBlobSha };
}

function resolveFixtureBlobSizes(source: string) {
  return (objectIds: readonly string[]) =>
    new Map(
      objectIds.map((objectId) => [objectId, Number(git(source, "cat-file", "-s", objectId))]),
    );
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
      resolveBlobSizes: resolveFixtureBlobSizes(fixture.source),
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

test("missing partial-clone objects are fetched in one bounded network request", () => {
  const fixture = partialCloneFixture({ extraFiles: 12 });
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  const trace = join(fixture.root, "git-trace.jsonl");
  try {
    process.env.GIT_TRACE2_EVENT = trace;
    const result = hydratePullRequestReviewBlobs({
      targetDir: fixture.target,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      resolveBlobSizes: resolveFixtureBlobSizes(fixture.source),
      files: Array.from({ length: 12 }, (_, index) => ({
        filename: `additional-${index}.txt`,
        status: "added",
      })),
    });
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;

    const traceEvents = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; argv?: string[] });
    const fetches = traceEvents.filter(
      (event) => event.event === "start" && event.argv?.includes("fetch"),
    );
    assert.deepEqual(result, { hydrated: true, blobs: 12 });
    assert.equal(fetches.length, 1);
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review hydration enforces per-review byte limits without fetching oversized blobs", () => {
  for (const largeFiles of [[5 * 1024 * 1024], [3 * 1024 * 1024, 2 * 1024 * 1024]]) {
    const fixture = partialCloneFixture({ largeFiles });
    try {
      const oversizedBlob = git(
        fixture.target,
        "rev-parse",
        `${fixture.headSha}:large-${largeFiles.length - 1}.bin`,
      );
      const result = hydratePullRequestReviewBlobs({
        targetDir: fixture.target,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        resolveBlobSizes: resolveFixtureBlobSizes(fixture.source),
        files: [
          { filename: "added.txt", status: "added" },
          ...largeFiles.map((_, index) => ({ filename: `large-${index}.bin`, status: "added" })),
        ],
      });

      assert.equal(result.hydrated, false);
      assert.equal(objectExistsOffline(fixture.target, fixture.addedBlobSha), true);
      assert.equal(objectExistsOffline(fixture.target, oversizedBlob), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("review blob sizes use one bounded GraphQL metadata request", () => {
  const objectIds = ["a".repeat(40), "b".repeat(40)];
  let requests = 0;
  const result = githubReviewBlobSizes({
    repository: "openclaw/clawsweeper",
    objectIds,
    request: (query) => {
      requests += 1;
      assert.match(query, /repository\(owner: "openclaw", name: "clawsweeper"\)/);
      assert.match(query, /b0: object\(oid:/);
      assert.match(query, /b1: object\(oid:/);
      return { data: { repository: { b0: { byteSize: 12 }, b1: { byteSize: 34 } } } };
    },
  });

  assert.equal(requests, 1);
  assert.deepEqual(
    [...result],
    [
      [objectIds[0], 12],
      [objectIds[1], 34],
    ],
  );
  assert.throws(
    () => githubReviewBlobSizes({ repository: "../unsafe", objectIds, request: () => ({}) }),
    /invalid bounded review blob metadata request/,
  );
});

// The review cache materializes a missing base or head with `--depth=1`
// (`ensureReviewTreeCommit`), which leaves both trees present and their shared
// history absent. The attribution rule in `prompts/review-item.md` is written
// around that boundary, so this pins it: the operations the prompt names must
// run offline after hydration, and the ones it forbids must be the ones that
// cannot. Found by the first live ClawSweeper review of openclaw/clawsweeper#1075.
function shallowReviewCacheFixture() {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-shallow-cache-"));
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
  writeFileSync(join(source, "touched.txt"), "before\n");
  writeFileSync(join(source, "moved.txt"), "pre-existing condition\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  git(source, "remote", "add", "origin", origin);
  git(source, "push", "-q", "origin", "main");

  git(source, "checkout", "-qb", "feature");
  writeFileSync(join(source, "touched.txt"), "after\n");
  git(source, "mv", "moved.txt", "renamed.txt");
  git(source, "add", ".");
  git(source, "commit", "-qm", "feature");
  const headSha = git(source, "rev-parse", "HEAD");
  git(source, "push", "-q", "origin", "HEAD:refs/pull/991/head");

  // Exactly what `ensureReviewTreeCommit` runs when neither commit is present.
  git(target === "" ? root : root, "init", "-q", target);
  git(target, "remote", "add", "origin", `file://${origin}`);
  for (const [ref, destination] of [
    ["refs/heads/main", "refs/clawsweeper/review-cache/base-991"],
    ["refs/pull/991/head", "refs/clawsweeper/review-cache/head-991"],
  ] as const) {
    git(
      target,
      "fetch",
      "--force",
      "--filter=blob:none",
      "origin",
      `${ref}:${destination}`,
      "--depth=1",
    );
  }
  return { root, source, target, baseSha, headSha };
}

function gitStatusOffline(cwd: string, ...args: string[]): number {
  return (
    spawnSync("git", args, {
      cwd,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: "ignore",
    }).status ?? -1
  );
}

test("attribution reads survive the depth-1 review cache that has no shared history", () => {
  const fixture = shallowReviewCacheFixture();
  try {
    const result = hydratePullRequestReviewBlobs({
      targetDir: fixture.target,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      resolveBlobSizes: resolveFixtureBlobSizes(fixture.source),
      files: [
        { filename: "touched.txt", status: "modified" },
        { filename: "renamed.txt", previous_filename: "moved.txt", status: "renamed" },
      ],
    });
    assert.equal(result.hydrated, true);

    // Both commits are present — the P1's premise, not a contradiction of it.
    assert.equal(
      gitStatusOffline(fixture.target, "cat-file", "-e", `${fixture.baseSha}^{commit}`),
      0,
    );
    assert.equal(
      gitStatusOffline(fixture.target, "cat-file", "-e", `${fixture.headSha}^{commit}`),
      0,
    );

    // Ancestry is not. These are the two commands the prompt must never name.
    assert.notEqual(
      gitStatusOffline(fixture.target, "merge-base", fixture.baseSha, fixture.headSha),
      0,
    );
    assert.notEqual(
      gitStatusOffline(fixture.target, "diff", `${fixture.baseSha}...${fixture.headSha}`),
      0,
    );

    // What the prompt does name works offline, including the renamed file read
    // through its previous path. Cut the remote so a lazy fetch cannot rescue it.
    git(fixture.target, "remote", "set-url", "origin", "https://invalid.invalid/offline.git");
    assert.equal(git(fixture.target, "show", `${fixture.baseSha}:touched.txt`), "before");
    assert.equal(
      git(fixture.target, "show", `${fixture.baseSha}:moved.txt`),
      "pre-existing condition",
    );
    assert.equal(
      git(fixture.target, "show", `${fixture.headSha}:renamed.txt`),
      "pre-existing condition",
    );

    // The rename trap: the head path does not exist on the base side, and that
    // absence must never be read as "the patch introduced this file".
    assert.notEqual(gitStatusOffline(fixture.target, "show", `${fixture.baseSha}:renamed.txt`), 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
