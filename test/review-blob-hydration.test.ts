import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensurePullRequestReviewHead,
  ensureReviewTreeCommit,
  githubReviewBlobSizes,
  hydratePullRequestReviewBlobs,
  hydratePullRequestReviewHistory,
  materializePullRequestReviewTree,
  removePullRequestReviewTree,
} from "../dist/clawsweeper-review-blobs.js";
import { reviewMergeBase } from "../dist/pr-review-evidence.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function ensureShallowPullRequestReviewHead(targetDir: string, headSha: string): boolean {
  return ensureReviewTreeCommit({
    targetDir,
    sha: headSha,
    sourceRef: "refs/pull/982/head",
    destinationRef: "refs/clawsweeper/review-cache/head-982",
  });
}

function partialCloneFixture({
  extraFiles = 0,
  largeFiles = [],
  prefetchHead = true,
}: { extraFiles?: number; largeFiles?: number[]; prefetchHead?: boolean } = {}) {
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
  if (prefetchHead) {
    git(
      target,
      "fetch",
      "-q",
      "--filter=blob:none",
      "origin",
      "refs/pull/982/head:refs/clawsweeper/review-cache/head-982",
      "--depth=1",
    );
  }
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

// A review target is a single-branch, blobless clone of the base branch, so the reviewed
// head arrives shallow and history hydration has to reach a merge base. A depth-limited
// fetch re-bounds every revision it names, so hydration must not name a base branch whose
// ancestry the checkout already holds.
function reviewHistoryFixture({
  commitsBeforeBranch,
  commitsAfterBranch,
  commitsOnBranch = 0,
  commitsAfterMerge = 0,
  commitsPastBase = 0,
  cloneDepth,
  baseRefreshDepth = 50,
  mergeBaseIntoFeature = false,
  publishPullRef = true,
}: {
  commitsBeforeBranch: number;
  commitsAfterBranch: number;
  commitsOnBranch?: number;
  commitsAfterMerge?: number;
  commitsPastBase?: number;
  cloneDepth?: number;
  baseRefreshDepth?: number;
  mergeBaseIntoFeature?: boolean;
  publishPullRef?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-history-"));
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(source);
  git(root, "init", "--bare", "-q", origin);
  git(origin, "config", "uploadpack.allowFilter", "true");
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "ClawSweeper Review Test");
  git(source, "config", "user.email", "review-test@example.com");
  git(source, "config", "commit.gpgsign", "false");
  const commit = (name: string) => {
    writeFileSync(join(source, "history.txt"), `${name}\n`);
    git(source, "add", "-A");
    git(source, "commit", "-qm", name);
  };
  commit("root");
  for (let index = 0; index < commitsBeforeBranch; index += 1) commit(`history ${index}`);
  const branchPoint = git(source, "rev-parse", "HEAD");
  git(source, "checkout", "-qb", "feature");
  writeFileSync(join(source, "feature.txt"), "feature\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "feature");
  for (let index = 0; index < commitsOnBranch; index += 1) {
    writeFileSync(join(source, "feature.txt"), `feature ${index}\n`);
    git(source, "commit", "-qam", `feature ${index}`);
  }
  let headSha = git(source, "rev-parse", "HEAD");
  git(source, "checkout", "-q", "main");
  for (let index = 0; index < commitsAfterBranch; index += 1) commit(`base ${index}`);
  // A pull request pins the base branch where it stood when the request was opened, so the
  // branch usually moves on past it. Commits past that point put the pinned base behind the
  // depth-limited refresh boundary, exactly as it sits in a hosted review.
  const baseSha = git(source, "rev-parse", "HEAD");
  for (let index = 0; index < commitsPastBase; index += 1) commit(`past base ${index}`);
  git(source, "remote", "add", "origin", origin);
  git(source, "push", "-q", "origin", "main");
  if (mergeBaseIntoFeature) {
    git(source, "checkout", "-q", "feature");
    git(source, "merge", "-q", "--no-ff", baseSha, "-m", "merge main");
    for (let index = 0; index < commitsAfterMerge; index += 1) {
      writeFileSync(join(source, "feature.txt"), `after merge ${index}\n`);
      git(source, "commit", "-qam", `after merge ${index}`);
    }
    headSha = git(source, "rev-parse", "HEAD");
  }
  if (publishPullRef) git(source, "push", "-q", "origin", "feature:refs/pull/982/head");

  git(
    root,
    "clone",
    "-q",
    "--filter=blob:none",
    "--branch",
    "main",
    "--single-branch",
    ...(cloneDepth ? [`--depth=${cloneDepth}`] : []),
    `file://${origin}`,
    target,
  );
  // The review runtime refreshes the base branch with a depth-limited fetch before reviewing.
  git(
    target,
    "fetch",
    "-q",
    "origin",
    "refs/heads/main:refs/remotes/origin/main",
    `--depth=${baseRefreshDepth}`,
  );
  return { root, target, baseSha, headSha, branchPoint };
}

function reachable(target: string, sha: string): number {
  const count = spawnSync("git", ["rev-list", "--count", sha], {
    cwd: target,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
  return count.status === 0 ? Number(count.stdout.trim()) : -1;
}

test("supplied checkout exact-review sequence recovers merged base history", () => {
  // The hosted workflow supplies a complete base checkout, then review acquisition fetches
  // the PR head. Keep the merge-from-base commit beyond bounded fallback hydration so this
  // fixture proves acquisition itself preserved the history instead of relying on the retry.
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 10,
    commitsAfterBranch: 10,
    commitsAfterMerge: 300,
    mergeBaseIntoFeature: true,
  });
  try {
    assert.ok(
      ensurePullRequestReviewHead({
        targetDir: fixture.target,
        itemNumber: 982,
        headSha: fixture.headSha,
      }),
    );
    assert.equal(
      hydratePullRequestReviewHistory({
        targetDir: fixture.target,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        itemNumber: 982,
      }),
      fixture.baseSha,
    );
    assert.equal(
      reviewMergeBase(fixture.target, fixture.baseSha, fixture.headSha).status,
      "verified",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review history hydration keeps base ancestry the checkout already had", () => {
  // The base branch's history is present and deeper than the bounded deepening, and the
  // merge base is two commits behind the reviewed head but further behind the pinned base
  // than the bound reaches. Naming the base in that fetch re-bounds ancestry the checkout
  // already had and loses the merge base with it; deepening the head alone finds it.
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 300,
    commitsAfterBranch: 300,
    commitsPastBase: 100,
  });
  try {
    assert.ok(ensureShallowPullRequestReviewHead(fixture.target, fixture.headSha));
    const before = reachable(fixture.target, fixture.baseSha);
    assert.ok(before > 256, `expected deep base ancestry, saw ${before}`);
    assert.equal(
      reviewMergeBase(fixture.target, fixture.baseSha, fixture.headSha).status,
      "unavailable",
    );

    assert.equal(
      hydratePullRequestReviewHistory({
        targetDir: fixture.target,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        itemNumber: 982,
      }),
      fixture.branchPoint,
    );

    assert.equal(
      reviewMergeBase(fixture.target, fixture.baseSha, fixture.headSha).status,
      "verified",
    );
    assert.ok(
      reachable(fixture.target, fixture.baseSha) > 256,
      "hydration must not re-bound base ancestry to the fetch depth",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review history hydration still deepens a base branch that is itself shallow", () => {
  // Shallow clone: the pinned base arrives with no ancestry, so reaching a merge base needs
  // the base deepened too. Deepening only the head must not be the whole story.
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 10,
    commitsAfterBranch: 20,
    cloneDepth: 1,
    baseRefreshDepth: 1,
  });
  try {
    assert.ok(ensureShallowPullRequestReviewHead(fixture.target, fixture.headSha));
    assert.equal(reachable(fixture.target, fixture.baseSha), 1);

    assert.equal(
      hydratePullRequestReviewHistory({
        targetDir: fixture.target,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        itemNumber: 982,
      }),
      fixture.branchPoint,
    );
    assert.equal(
      reviewMergeBase(fixture.target, fixture.baseSha, fixture.headSha).status,
      "verified",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review history hydration stays fail-closed when the bounded deepening cannot reach", () => {
  // The merge base is further from the reviewed head than the bounded deepening reaches.
  // That is the documented bound doing its job, not the defect above: no merge base is
  // reported and the caller keeps refusing.
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 5,
    commitsAfterBranch: 400,
    cloneDepth: 1,
    baseRefreshDepth: 1,
  });
  try {
    assert.ok(ensureShallowPullRequestReviewHead(fixture.target, fixture.headSha));
    assert.equal(
      hydratePullRequestReviewHistory({
        targetDir: fixture.target,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        itemNumber: 982,
      }),
      null,
    );
    assert.equal(
      reviewMergeBase(fixture.target, fixture.baseSha, fixture.headSha).status,
      "unavailable",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review history hydration reports no merge base when the pull ref is unreachable", () => {
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 5,
    commitsAfterBranch: 5,
    publishPullRef: false,
  });
  try {
    rmSync(join(fixture.root, "origin.git"), { recursive: true, force: true });
    assert.equal(
      hydratePullRequestReviewHistory({
        targetDir: fixture.target,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        itemNumber: 982,
      }),
      null,
    );
    assert.equal(
      reviewMergeBase(fixture.target, fixture.baseSha, fixture.headSha).status,
      "unavailable",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

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

test("persisted snapshot null previous filenames still hydrate missing blobs", () => {
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
        { filename: "added.txt", previous_filename: null, status: "added" },
        { filename: "changed.txt", previous_filename: null, status: "modified" },
        { filename: "removed.txt", previous_filename: null, status: "removed" },
      ],
    });
    assert.deepEqual(result, { hydrated: true, blobs: 4 });
    assert.equal(objectExistsOffline(fixture.target, fixture.addedBlobSha), true);
    assert.equal(objectExistsOffline(fixture.target, fixture.changedBlobSha), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restricted review materializes the exact pull request head before model execution", () => {
  const fixture = partialCloneFixture({ prefetchHead: false });
  const reviewTree = join(fixture.root, "review-tree");
  try {
    assert.equal(objectExistsOffline(fixture.target, fixture.headSha), false);
    assert.equal(git(fixture.target, "rev-parse", "HEAD"), fixture.baseSha);
    assert.equal(readFileSync(join(fixture.target, "changed.txt"), "utf8"), "before\n");

    assert.equal(
      materializePullRequestReviewTree({
        targetDir: fixture.target,
        worktreeDir: reviewTree,
        itemNumber: 982,
        headSha: fixture.headSha,
      }),
      true,
    );
    assert.equal(objectExistsOffline(fixture.target, fixture.headSha), true);
    assert.equal(git(fixture.target, "rev-parse", "HEAD"), fixture.baseSha);
    assert.equal(readFileSync(join(fixture.target, "changed.txt"), "utf8"), "before\n");
    assert.equal(git(reviewTree, "rev-parse", "HEAD"), fixture.headSha);
    assert.equal(readFileSync(join(reviewTree, "changed.txt"), "utf8"), "after\n");
    assert.equal(readFileSync(join(reviewTree, "added.txt"), "utf8"), "new implementation\n");
    assert.equal(git(fixture.target, "status", "--porcelain"), "");
    assert.equal(git(reviewTree, "status", "--porcelain"), "");
    assert.equal(
      git(fixture.target, "rev-parse", "refs/clawsweeper/review-cache/head-982"),
      fixture.headSha,
    );
    assert.equal(
      removePullRequestReviewTree({ targetDir: fixture.target, worktreeDir: reviewTree }),
      true,
    );
    assert.equal(existsSync(reviewTree), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restricted review binds a force-pushed pull request to the exact REST head", () => {
  const fixture = partialCloneFixture({ prefetchHead: false });
  try {
    git(fixture.source, "push", "-q", "origin", "HEAD:refs/heads/feature");
    git(fixture.source, "push", "-q", "--force", "origin", `${fixture.baseSha}:refs/pull/982/head`);

    assert.equal(
      ensurePullRequestReviewHead({
        targetDir: fixture.target,
        itemNumber: 982,
        headSha: fixture.headSha,
      }),
      true,
    );
    assert.equal(
      git(fixture.target, "rev-parse", "refs/clawsweeper/review-cache/head-982"),
      fixture.headSha,
    );
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
    const paths = Array.from({ length: 12 }, (_, index) => `additional-${index}.txt`);
    const expectedBlobIds = paths.map((path) => git(fixture.source, "rev-parse", `HEAD:${path}`));
    const probeOutput = git(
      fixture.target,
      "--literal-pathspecs",
      "rev-list",
      "--objects",
      "--missing=print",
      `${fixture.baseSha}^{tree}`,
      `${fixture.headSha}^{tree}`,
      "--",
      ...paths,
    );
    const probedObjectIds = new Set(
      probeOutput.split("\n").map((entry) => entry.match(/^\??([0-9a-f]{40,64})(?: |$)/i)?.[1]),
    );
    assert.deepEqual(
      expectedBlobIds.filter((objectId) => !probedObjectIds.has(objectId)),
      [],
      "availability probe must emit every blob ID reached from the bounded commit trees",
    );

    process.env.GIT_TRACE2_EVENT = trace;
    const result = hydratePullRequestReviewBlobs({
      targetDir: fixture.target,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      resolveBlobSizes: resolveFixtureBlobSizes(fixture.source),
      files: paths.map((filename) => ({ filename, status: "added" })),
    });
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;

    const traceEvents = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; argv?: string[] });
    const revLists = traceEvents.filter(
      (event) => event.event === "start" && event.argv?.includes("rev-list"),
    );
    const nestedFetches = traceEvents.filter(
      (event) => event.event === "child_start" && event.argv?.includes("fetch"),
    );
    const explicitFetches = traceEvents.filter(
      (event) => event.event === "start" && event.argv?.includes("fetch"),
    );
    assert.deepEqual(result, { hydrated: true, blobs: 12 });
    assert.equal(revLists.length, 1);
    assert.ok(revLists[0]!.argv?.includes(`${fixture.baseSha}^{tree}`));
    assert.ok(revLists[0]!.argv?.includes(`${fixture.headSha}^{tree}`));
    assert.equal(
      revLists[0]!.argv?.some((argument) => argument.startsWith("--no-walk")),
      false,
    );
    assert.equal(nestedFetches.length, 0, "availability probe must not lazy-fetch blobs");
    assert.equal(explicitFetches.length, 1, "hydration must perform one explicit bounded fetch");
    assert.ok(explicitFetches[0]!.argv?.includes("--stdin"));
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
