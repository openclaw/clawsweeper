import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  ReviewGitError,
} from "../dist/clawsweeper-review-blobs.js";
import { MAX_SCAN_BYTES } from "../dist/agent-input-scan.js";
import { createContextHydration } from "../dist/clawsweeper-context-hydration.js";
import { asRecord } from "../dist/clawsweeper-item-policy.js";
import { createReviewRuntime } from "../dist/clawsweeper-review-runtime.js";
import { runText } from "../dist/command.js";
import { readReviewGit, reviewMergeBase } from "../dist/pr-review-evidence.js";
import { ReviewSourcePreparationError } from "../dist/review-source-preparation.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function ensureShallowPullRequestReviewHead(targetDir: string, headSha: string): boolean {
  git(
    targetDir,
    "fetch",
    "-q",
    "--filter=blob:none",
    "--depth=1",
    "origin",
    "refs/pull/982/head:refs/clawsweeper/review-cache/head-982",
  );
  return objectExistsOffline(targetDir, `${headSha}^{commit}`);
}

function partialCloneFixture({
  extraFiles = 0,
  largeFiles = [],
  prefetchHead = true,
  historicalBase = false,
}: {
  extraFiles?: number;
  largeFiles?: number[];
  prefetchHead?: boolean;
  historicalBase?: boolean;
} = {}) {
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
  if (historicalBase) {
    writeFileSync(join(source, "mode.txt"), "mode only\n");
    for (let index = 0; index < extraFiles; index++) {
      writeFileSync(join(source, `additional-${index}.txt`), `before ${index}\n`);
    }
    for (const [index, bytes] of largeFiles.entries()) {
      const data = Buffer.alloc(bytes, index + 10);
      data[0] = 0;
      writeFileSync(join(source, `large-${index}.bin`), data);
    }
  }
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
    const data = Buffer.alloc(bytes, index + 1);
    data[0] = 0;
    writeFileSync(join(source, `large-${index}.bin`), data);
  }
  git(source, "rm", "-q", "removed.txt");
  git(source, "add", ".");
  git(source, "update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},vendor/library`);
  if (historicalBase) {
    chmodSync(join(source, "mode.txt"), 0o755);
    git(source, "update-index", "--chmod=+x", "mode.txt");
  }
  git(source, "commit", "-qm", "feature");
  const headSha = git(source, "rev-parse", "HEAD");
  const addedBlobSha = git(source, "rev-parse", "HEAD:added.txt");
  const changedBlobSha = git(source, "rev-parse", "HEAD:changed.txt");
  git(source, "push", "-q", "origin", "HEAD:refs/pull/982/head");
  if (historicalBase) {
    git(source, "checkout", "-q", "main");
    writeFileSync(join(source, "changed.txt"), "current main\n");
    git(source, "rm", "-q", "removed.txt");
    for (let index = 0; index < extraFiles; index++) {
      writeFileSync(join(source, `additional-${index}.txt`), `main ${index}\n`);
    }
    for (const [index] of largeFiles.entries()) {
      writeFileSync(join(source, `large-${index}.bin`), "main binary replacement\n");
    }
    git(source, "add", ".");
    git(source, "commit", "-qm", "advance main past pinned base");
    git(source, "push", "-q", "origin", "main");
  }
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
  return (objectIds: readonly string[]) => {
    const output = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objectsize)"], {
      cwd: source,
      encoding: "utf8",
      input: `${objectIds.join("\n")}\n`,
    });
    return new Map(
      output
        .trim()
        .split("\n")
        .map((line) => {
          const [oid, bytes] = line.split(" ");
          return [oid!, Number(bytes)];
        }),
    );
  };
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

// Shallow fixtures must acquire complete ancestry without truncating history
// already retained behind the pinned base.
function reviewHistoryFixture({
  commitsBeforeBranch,
  commitsAfterBranch,
  commitsAfterMerge = 0,
  commitsPastBase = 0,
  cloneDepth,
  baseRefreshDepth = 50,
  mergeBaseIntoFeature = false,
  publishPullRef = true,
}: {
  commitsBeforeBranch: number;
  commitsAfterBranch: number;
  commitsAfterMerge?: number;
  commitsPastBase?: number;
  cloneDepth?: number;
  baseRefreshDepth?: number | null;
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
  // Keep history-fixture construction from racing Git's detached maintenance.
  git(source, "config", "maintenance.auto", "false");
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
  let headSha = git(source, "rev-parse", "HEAD");
  git(source, "checkout", "-q", "main");
  for (let index = 0; index < commitsAfterBranch; index += 1) commit(`base ${index}`);
  // The remote base may advance beyond the selected review tuple. Keep later
  // commits on main to prove acquisition preserves the pinned ancestry.
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
  // Explicitly shallow fixtures exercise recovery independently of metadata refresh.
  if (baseRefreshDepth !== null) {
    git(
      target,
      "fetch",
      "-q",
      "origin",
      "refs/heads/main:refs/remotes/origin/main",
      `--depth=${baseRefreshDepth}`,
    );
  }
  return { root, origin, source, target, baseSha, headSha, branchPoint };
}

function reachable(target: string, sha: string): number {
  const count = spawnSync("git", ["rev-list", "--count", sha], {
    cwd: target,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
  return count.status === 0 ? Number(count.stdout.trim()) : -1;
}

function prepareFixtureCommits(fixture: { target: string; baseSha: string; headSha: string }) {
  assert.ok(
    ensureReviewTreeCommit({
      targetDir: fixture.target,
      sha: fixture.baseSha,
      sourceRef: "refs/heads/main",
      destinationRef: "refs/clawsweeper/review-cache/base-982",
    }),
  );
  assert.ok(
    ensurePullRequestReviewHead({
      targetDir: fixture.target,
      itemNumber: 982,
      headSha: fixture.headSha,
    }),
  );
}

function reviewGitInfo(releaseTag?: string) {
  const unavailable = (): never => {
    throw new Error("Unexpected dependency in native Git preparation fixture");
  };
  return createReviewRuntime({
    reviewItemPromptPath: "",
    decisionSchemaPath: "",
    prCloseCoverageProofPromptPath: "",
    targetRepo: () => "fixture/repository",
    run: runText,
    ghJson: <T>() => (releaseTag ? [{ tagName: releaseTag, isLatest: true }] : []) as T,
    evidenceEntry: unavailable,
    untrustedCodexEnv: unavailable,
    asRecord: unavailable,
    defaultRootCauseCluster: unavailable,
    parseDecision: unavailable,
    ensureDir: unavailable,
    stringOrUndefined: unavailable,
  }).gitInfo;
}

for (const withRelease of [false, true]) {
  test(`metadata refresh preserves complete review history, release=${withRelease}`, (t) => {
    const fixture = reviewHistoryFixture({
      commitsBeforeBranch: 60,
      commitsAfterBranch: 10,
      mergeBaseIntoFeature: true,
      baseRefreshDepth: null,
    });
    const reviewTree = join(fixture.root, "review-tree");
    try {
      const releaseTag = "review-fixture-release";
      if (withRelease) {
        git(fixture.source, "-c", "tag.gpgsign=false", "tag", releaseTag, fixture.branchPoint);
        git(fixture.source, "push", "-q", "origin", `refs/tags/${releaseTag}`);
      }
      const gitInfo = reviewGitInfo(withRelease ? releaseTag : undefined);
      const expectedAncestors = reachable(fixture.source, fixture.baseSha);
      assert.equal(git(fixture.target, "rev-parse", "--is-shallow-repository"), "false");
      const info = gitInfo(fixture.target);
      t.diagnostic(
        JSON.stringify({
          stage: "metadata-refresh",
          withRelease,
          expectedAncestors,
          actualAncestors: reachable(fixture.target, fixture.baseSha),
          shallow: git(fixture.target, "rev-parse", "--is-shallow-repository"),
        }),
      );
      assert.equal(info.mainSha, fixture.baseSha);
      assert.equal(info.releaseStateComplete, true);
      if (withRelease) assert.equal(info.latestRelease?.sha, fixture.branchPoint);
      assert.equal(reachable(fixture.target, fixture.baseSha), expectedAncestors);
      assert.equal(git(fixture.target, "rev-parse", "--is-shallow-repository"), "false");

      prepareFixtureCommits(fixture);
      assert.equal(
        hydratePullRequestReviewHistory({
          targetDir: fixture.target,
          baseSha: fixture.baseSha,
          headSha: fixture.headSha,
          itemNumber: 982,
        }),
        fixture.baseSha,
      );
      hydratePullRequestReviewBlobs({
        targetDir: fixture.target,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        resolveBlobSizes: resolveFixtureBlobSizes(fixture.source),
      });
      assert.ok(
        materializePullRequestReviewTree({
          targetDir: fixture.target,
          worktreeDir: reviewTree,
          itemNumber: 982,
          headSha: fixture.headSha,
        }),
      );

      // Lease revalidation refreshes metadata after the pinned checkout already exists.
      gitInfo(fixture.target);
      assert.equal(git(reviewTree, "rev-parse", "HEAD"), fixture.headSha);
      assert.equal(git(fixture.target, "rev-parse", "HEAD"), fixture.baseSha);
      assert.equal(reachable(reviewTree, fixture.baseSha), expectedAncestors);
      assert.equal(
        reachable(reviewTree, fixture.headSha),
        reachable(fixture.source, fixture.headSha),
      );
      assert.equal(
        reviewMergeBase(reviewTree, fixture.baseSha, fixture.headSha).sha,
        fixture.baseSha,
      );
      assert.equal(git(reviewTree, "status", "--porcelain"), "");
      assert.equal(readFileSync(join(reviewTree, "feature.txt"), "utf8"), "feature\n");
      assert.equal(git(reviewTree, "show", `${fixture.baseSha}:history.txt`), "base 9");
    } finally {
      removePullRequestReviewTree({ targetDir: fixture.target, worktreeDir: reviewTree });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("review acquisition preserves a pinned base after main advances", () => {
  const fixture = partialCloneFixture({ prefetchHead: false });
  try {
    git(fixture.source, "checkout", "-q", "main");
    writeFileSync(join(fixture.source, "main.txt"), "pinned base\n");
    git(fixture.source, "add", "main.txt");
    git(fixture.source, "commit", "-qm", "pinned REST base");
    const pinnedBase = git(fixture.source, "rev-parse", "HEAD");
    writeFileSync(join(fixture.source, "main.txt"), "new main\n");
    git(fixture.source, "commit", "-qam", "advance main");
    git(fixture.source, "push", "-q", "origin", "main");
    assert.equal(objectExistsOffline(fixture.target, pinnedBase), false);
    assert.equal(git(fixture.target, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(
      ensureReviewTreeCommit({
        targetDir: fixture.target,
        sha: pinnedBase,
        sourceRef: "refs/heads/main",
        destinationRef: "refs/clawsweeper/review-cache/base-982",
      }),
      true,
    );
    assert.equal(objectExistsOffline(fixture.target, pinnedBase), true);
    assert.equal(reachable(fixture.target, pinnedBase), reachable(fixture.source, pinnedBase));
    assert.equal(git(fixture.target, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(git(fixture.target, "rev-parse", "HEAD"), fixture.baseSha);
    assert.equal(git(fixture.target, "status", "--porcelain"), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("optional test-merge acquisition preserves prepared head ancestry", (t) => {
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 5,
    commitsAfterBranch: 5,
    mergeBaseIntoFeature: true,
    baseRefreshDepth: null,
  });
  try {
    git(fixture.source, "checkout", "-qb", "test-merge", "main");
    git(fixture.source, "merge", "-q", "--no-ff", fixture.headSha, "-m", "test merge");
    const testMergeSha = git(fixture.source, "rev-parse", "HEAD");
    git(fixture.source, "push", "-q", "origin", "HEAD:refs/pull/982/merge");
    prepareFixtureCommits(fixture);
    assert.equal(
      hydratePullRequestReviewHistory({
        targetDir: fixture.target,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        itemNumber: 982,
        testMergeSha,
      }),
      fixture.baseSha,
    );
    t.diagnostic(
      JSON.stringify({
        stage: "test-merge",
        expectedAncestors: reachable(fixture.source, testMergeSha),
        actualAncestors: reachable(fixture.target, testMergeSha),
      }),
    );
    assert.equal(reachable(fixture.target, testMergeSha), reachable(fixture.source, testMergeSha));
    assert.equal(
      reachable(fixture.target, fixture.headSha),
      reachable(fixture.source, fixture.headSha),
    );
    assert.equal(git(fixture.target, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(git(fixture.target, "rev-parse", "HEAD"), fixture.baseSha);
    assert.equal(git(fixture.target, "status", "--porcelain"), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("supplied checkout exact-review sequence recovers merged base history", () => {
  // Keep the merge from base deep in the PR history so acquisition itself must
  // preserve the ancestry needed to establish the pinned merge base.
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 10,
    commitsAfterBranch: 10,
    commitsAfterMerge: 300,
    mergeBaseIntoFeature: true,
  });
  try {
    prepareFixtureCommits(fixture);
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

test("review source acquisition keeps base ancestry the checkout already had", () => {
  // The shallow PR tip must not discard older ancestry already present behind the
  // pinned base, even when the remote branch has advanced beyond that base.
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 300,
    commitsAfterBranch: 300,
    commitsPastBase: 100,
  });
  try {
    assert.ok(ensureShallowPullRequestReviewHead(fixture.target, fixture.headSha));
    const before = reachable(fixture.target, fixture.baseSha);
    assert.equal(before, reachable(fixture.source, fixture.baseSha));
    assert.equal(
      reviewMergeBase(fixture.target, fixture.baseSha, fixture.headSha).status,
      "unavailable",
    );

    prepareFixtureCommits(fixture);
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
    assert.equal(reachable(fixture.target, fixture.baseSha), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review source acquisition completes a genuinely shallow base and head", () => {
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 10,
    commitsAfterBranch: 20,
    cloneDepth: 1,
    baseRefreshDepth: 1,
  });
  try {
    assert.ok(ensureShallowPullRequestReviewHead(fixture.target, fixture.headSha));
    assert.equal(reachable(fixture.target, fixture.baseSha), 1);
    assert.equal(git(fixture.target, "rev-parse", "--is-shallow-repository"), "true");

    prepareFixtureCommits(fixture);
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
    assert.equal(git(fixture.target, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(
      reachable(fixture.target, fixture.baseSha),
      reachable(fixture.source, fixture.baseSha),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review source acquisition refuses unrelated complete histories", () => {
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 5,
    commitsAfterBranch: 5,
    baseRefreshDepth: null,
  });
  try {
    const tree = git(fixture.source, "rev-parse", `${fixture.headSha}^{tree}`);
    const headSha = git(fixture.source, "commit-tree", tree, "-m", "unrelated review history");
    git(fixture.source, "push", "-q", "--force", "origin", `${headSha}:refs/pull/982/head`);
    prepareFixtureCommits({ ...fixture, headSha });
    assert.equal(git(fixture.target, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(
      hydratePullRequestReviewHistory({
        targetDir: fixture.target,
        baseSha: fixture.baseSha,
        headSha,
        itemNumber: 982,
      }),
      null,
    );
    assert.equal(reviewMergeBase(fixture.target, fixture.baseSha, headSha).status, "unavailable");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review source acquisition refuses an unreachable pull ref", () => {
  const fixture = reviewHistoryFixture({
    commitsBeforeBranch: 5,
    commitsAfterBranch: 5,
    publishPullRef: false,
  });
  try {
    rmSync(join(fixture.root, "origin.git"), { recursive: true, force: true });
    assert.throws(
      () =>
        ensurePullRequestReviewHead({
          targetDir: fixture.target,
          headSha: fixture.headSha,
          itemNumber: 982,
        }),
      (error: unknown) =>
        error instanceof ReviewGitError &&
        error instanceof ReviewSourcePreparationError &&
        error.diagnosticStage === "source_preparation" &&
        error.diagnosticReason === "review_commit_fetch_failed" &&
        error.reviewedHeadSha === fixture.headSha &&
        error.status !== null &&
        error.status > 0,
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
    });

    assert.equal(result, 6);
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

test("review hydration refuses unsafe Git paths and missing source without fetching", () => {
  const fixture = partialCloneFixture();
  try {
    for (const filename of ["a\\b", "C:drive", "control\npath"]) {
      writeFileSync(join(fixture.source, filename), "unsafe path\n");
      git(fixture.source, "add", ".");
      git(fixture.source, "commit", "-qm", "unsafe source");
      const headSha = git(fixture.source, "rev-parse", "HEAD");
      git(fixture.source, "push", "-q", "origin", "HEAD:refs/heads/unsafe");
      git(fixture.target, "fetch", "-q", "--filter=blob:none", "origin", "refs/heads/unsafe");
      assert.throws(
        () =>
          hydratePullRequestReviewBlobs({
            targetDir: fixture.target,
            baseSha: fixture.baseSha,
            headSha,
            resolveBlobSizes: () => {
              throw new Error("unsafe paths must refuse before metadata");
            },
          }),
        { name: "AgentInputScanError", reason: "unsafe_path", retryable: false },
      );
      git(fixture.source, "rm", "-q", "--", filename);
    }
    for (const baseSha of ["--unsafe", "f".repeat(40)]) {
      assert.throws(
        () =>
          hydratePullRequestReviewBlobs({
            targetDir: fixture.target,
            baseSha,
            headSha: fixture.headSha,
          }),
        { name: "AgentInputScanError", reason: "incomplete_source", retryable: false },
      );
    }
    assert.throws(
      () =>
        hydratePullRequestReviewBlobs({
          targetDir: fixture.target,
          baseSha: fixture.baseSha,
          headSha: fixture.headSha,
        }),
      {
        diagnosticStage: "source_preparation",
        diagnosticReason: "review_blob_metadata_unavailable",
      },
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
    assert.equal(result, 18);
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

test("review hydration rejects aggregate scan budget overflow and incomplete size metadata before fetching", () => {
  const fixture = partialCloneFixture();
  try {
    for (const size of [MAX_SCAN_BYTES + 1, Math.ceil(MAX_SCAN_BYTES / 2)]) {
      assert.throws(
        () =>
          hydratePullRequestReviewBlobs({
            targetDir: fixture.target,
            baseSha: fixture.baseSha,
            headSha: fixture.headSha,
            resolveBlobSizes: (ids) => new Map(ids.map((id) => [id, size as number])),
          }),
        { name: "AgentInputScanError", reason: "staging_limit", retryable: false },
      );
      assert.equal(objectExistsOffline(fixture.target, fixture.addedBlobSha), false);
    }
    for (const size of [NaN, -1, undefined]) {
      assert.throws(
        () =>
          hydratePullRequestReviewBlobs({
            targetDir: fixture.target,
            baseSha: fixture.baseSha,
            headSha: fixture.headSha,
            resolveBlobSizes: (ids) => new Map(ids.map((id) => [id, size as number])),
          }),
        {
          diagnosticStage: "source_preparation",
          diagnosticReason: "review_blob_metadata_unavailable",
        },
      );
      assert.equal(objectExistsOffline(fixture.target, fixture.addedBlobSha), false);
    }
    git(fixture.target, "remote", "set-url", "origin", join(fixture.root, "unavailable.git"));
    assert.throws(
      () =>
        hydratePullRequestReviewBlobs({
          targetDir: fixture.target,
          baseSha: fixture.baseSha,
          headSha: fixture.headSha,
          resolveBlobSizes: resolveFixtureBlobSizes(fixture.source),
        }),
      { diagnosticStage: "source_preparation", diagnosticReason: "review_blobs_unavailable" },
    );
    assert.equal(objectExistsOffline(fixture.target, fixture.addedBlobSha), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("source preparation reports unavailable historical blobs before restricted inspection", () => {
  const fixture = partialCloneFixture({ historicalBase: true, prefetchHead: false });
  const reviewTree = join(fixture.root, "review-tree");
  const unavailable = () => {
    throw new Error("Unexpected external dependency in local source-preparation fixture");
  };
  const { hydratePullRequestReviewSource } = createContextHydration(
    new Proxy(
      {
        asRecord,
        stringOrUndefined: (value: unknown) => (typeof value === "string" ? value : undefined),
        isSafeGitBranchName: (branch: string) => branch === "main",
        targetRepo: () => "fixture/repository",
        ghJson: (args: string[]) => {
          const query = args.find((arg) => arg.startsWith("query="));
          assert.ok(query);
          const ids = [...query.matchAll(/b(\d+): object\(oid: "([0-9a-f]+)"\)/g)];
          assert.ok(ids.length);
          const sizes = resolveFixtureBlobSizes(fixture.source)(ids.map((match) => match[2]!));
          return {
            data: {
              repository: Object.fromEntries(
                ids.map((match) => ["b" + match[1], { byteSize: sizes.get(match[2]!) }]),
              ),
            },
          };
        },
      },
      { get: (target, key) => Reflect.get(target, key) ?? unavailable },
    ) as Parameters<typeof createContextHydration>[0],
  );
  try {
    // Construct a main-only unsafe path in Git without relying on host filesystem
    // filename support. Its optional endpoint delta must not block the PR delta.
    const previousBase = git(fixture.source, "rev-parse", "HEAD");
    const mainBlob = git(fixture.source, "rev-parse", "HEAD:changed.txt");
    const baseTree = execFileSync("git", ["ls-tree", "-z", "HEAD"], { cwd: fixture.source });
    const treeSha = execFileSync("git", ["mktree", "-z"], {
      cwd: fixture.source,
      encoding: "utf8",
      input: Buffer.concat([
        baseTree,
        Buffer.from("100644 blob " + mainBlob + "\tbase-only\npath\0"),
      ]),
    }).trim();
    const baseSha = git(
      fixture.source,
      "commit-tree",
      treeSha,
      "-p",
      previousBase,
      "-m",
      "main-only path",
    );
    git(fixture.source, "update-ref", "refs/heads/main", baseSha);
    git(fixture.source, "push", "-q", "origin", "main");
    git(fixture.target, "fetch", "-q", "--filter=blob:none", "origin", "main");
    const removedOid = git(fixture.source, "rev-parse", fixture.baseSha + ":removed.txt");
    assert.ok(
      ensurePullRequestReviewHead({
        targetDir: fixture.target,
        itemNumber: 982,
        headSha: fixture.headSha,
      }),
    );
    assert.equal(reviewMergeBase(fixture.target, baseSha, fixture.headSha).sha, fixture.baseSha);
    assert.equal(objectExistsOffline(fixture.target, removedOid), false);
    const prepare = () =>
      hydratePullRequestReviewSource({
        itemNumber: 982,
        targetDir: fixture.target,
        pullRequest: {
          base: { ref: "main", sha: baseSha },
          head: { sha: fixture.headSha },
        },
      });
    const origin = git(fixture.target, "remote", "get-url", "origin");
    git(fixture.target, "remote", "set-url", "origin", join(fixture.root, "unavailable.git"));
    assert.throws(prepare, {
      diagnosticStage: "source_preparation",
      diagnosticReason: "review_blobs_unavailable",
      reviewedHeadSha: fixture.headSha,
    });
    assert.equal(objectExistsOffline(fixture.target, removedOid), false);

    git(fixture.target, "remote", "set-url", "origin", origin);
    prepare();
    assert.ok(
      materializePullRequestReviewTree({
        targetDir: fixture.target,
        worktreeDir: reviewTree,
        itemNumber: 982,
        headSha: fixture.headSha,
      }),
    );
    assert.equal(git(reviewTree, "rev-parse", "HEAD"), fixture.headSha);
    assert.equal(reviewMergeBase(reviewTree, baseSha, fixture.headSha).sha, fixture.baseSha);
    git(fixture.target, "remote", "set-url", "origin", join(fixture.root, "offline.git"));
    const args = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--ignore-submodules=none",
      fixture.baseSha,
      fixture.headSha,
      "--patch",
      "--binary",
      "--full-index",
      "--",
    ];
    const patch = readReviewGit(reviewTree, args);
    assert.ok(patch);
    assert.deepEqual(patch, readReviewGit(fixture.source, args));
    assert.equal(git(reviewTree, "status", "--porcelain"), "");
  } finally {
    removePullRequestReviewTree({ targetDir: fixture.target, worktreeDir: reviewTree });
    rmSync(fixture.root, { recursive: true, force: true });
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

test("large pinned deltas hydrate historical blobs after head checkout and produce the full offline binary patch", (t) => {
  const fixture = partialCloneFixture({
    extraFiles: 170,
    largeFiles: [3 * 1024 * 1024],
    historicalBase: true,
  });
  const reviewTree = join(fixture.root, "review-tree");
  try {
    assert.notEqual(git(fixture.target, "rev-parse", "HEAD"), fixture.baseSha);
    assert.equal(
      materializePullRequestReviewTree({
        targetDir: fixture.target,
        worktreeDir: reviewTree,
        itemNumber: 982,
        headSha: fixture.headSha,
      }),
      true,
    );
    const mergeBase = reviewMergeBase(reviewTree, fixture.baseSha, fixture.headSha);
    assert.equal(mergeBase.sha, fixture.baseSha, "the REST base must not become current main");
    const args = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--ignore-submodules=none",
      fixture.baseSha,
      fixture.headSha,
    ];
    const raw = readReviewGit(reviewTree, [...args, "--raw", "--no-abbrev", "-z", "--"]);
    assert.ok(raw);
    assert.equal(raw.toString().split("\0").length, 2 * 178 + 1);
    const patchArgs = [...args, "--patch", "--binary", "--full-index", "--"];
    assert.equal(
      readReviewGit(reviewTree, patchArgs),
      null,
      "head checkout leaves historical blobs missing",
    );
    const removedOid = git(fixture.source, "rev-parse", `${fixture.baseSha}:removed.txt`);
    assert.equal(objectExistsOffline(reviewTree, removedOid), false);
    const batches: number[] = [];
    const result = hydratePullRequestReviewBlobs({
      targetDir: reviewTree,
      baseSha: mergeBase.sha!,
      headSha: fixture.headSha,
      resolveBlobSizes: (objectIds) =>
        githubReviewBlobSizes({
          repository: "openclaw/clawsweeper",
          objectIds,
          request: (query) => {
            const ids = [...query.matchAll(/b(\d+): object\(oid: "([0-9a-f]+)"\)/g)];
            batches.push(ids.length);
            const sizes = resolveFixtureBlobSizes(fixture.source)(ids.map((match) => match[2]!));
            return {
              data: {
                repository: Object.fromEntries(
                  ids.map((match) => [`b${match[1]}`, { byteSize: sizes.get(match[2]!) }]),
                ),
              },
            };
          },
        }),
    });
    assert.equal(result, 349);
    assert.deepEqual(batches, [160, 13]);
    assert.equal(objectExistsOffline(reviewTree, removedOid), true);
    git(fixture.target, "remote", "set-url", "origin", join(fixture.root, "offline.git"));
    const patch = readReviewGit(reviewTree, patchArgs);
    assert.ok(patch);
    assert.deepEqual(patch, readReviewGit(fixture.source, patchArgs));
    assert.match(patch.toString(), /GIT binary patch/);
    assert.match(patch.toString(), /old mode 100644\nnew mode 100755/);
    assert.match(patch.toString(), /deleted file mode 100644/);
    assert.match(patch.toString(), /:\(glob\)literal.txt/);
    assert.match(patch.toString(), /feature\[1\].txt/);
    assert.equal(git(reviewTree, "status", "--porcelain"), "");
    t.diagnostic(
      JSON.stringify({
        changedFiles: 178,
        blobs: result,
        metadataBatches: batches,
        patchBytes: patch.length,
        patchSha256: createHash("sha256").update(patch).digest("hex"),
        patchUnreadableBefore: true,
        offlinePatchMatchesSource: true,
      }),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
