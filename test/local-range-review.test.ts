import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLocalRangeReviewForTest } from "../dist/clawsweeper.js";

const CLI = fileURLToPath(new URL("../dist/clawsweeper.js", import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lrr-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Range Tester");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

test("buildLocalRangeReview synthesizes a PR item + offline diff from the local range", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "--author", "Range Tester <test@example.com>", "-m", "init");
    // a ref at the base commit, so HEAD is one commit ahead of it
    git(dir, "branch", "base-ref");

    // a second changed path (modify) alongside the new file (add), so the
    // name-status parsing is exercised across multiple lines and both statuses.
    writeFileSync(join(dir, "feature.txt"), "hello world\n");
    writeFileSync(join(dir, "keep.txt"), "base\nmore\n");
    git(dir, "add", "feature.txt", "keep.txt");
    git(
      dir,
      "commit",
      "-q",
      "--author",
      "Range Tester <test@example.com>",
      "-m",
      "feat: add a feature\n\nthis is the body line",
    );

    const headSha = git(dir, "rev-parse", "HEAD");
    const committedAt = git(dir, "log", "-1", "--format=%cI", "HEAD");
    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");

    // synthetic item: a PR #0 titled from the commit subject, no GitHub involved
    assert.equal(result.item.number, 0);
    assert.equal(result.item.kind, "pull_request");
    assert.equal(result.item.title, "feat: add a feature");
    assert.equal(result.item.repo, "openclaw/clawsweeper");
    assert.equal(result.item.author, "Range Tester");
    assert.equal(result.item.authorAssociation, "CONTRIBUTOR");
    assert.deepEqual(result.item.labels, []);
    assert.equal(result.item.url, `local:${headSha}`);
    assert.equal(result.item.createdAt, committedAt);
    assert.equal(result.item.updatedAt, committedAt);

    // synthetic context: body + issue mirror, diff from `git diff`
    const issue = result.context.issue as {
      body: string;
      title: string;
      state: string;
      user: { login: string };
      html_url: string;
    };
    assert.match(issue.body, /this is the body line/);
    assert.equal(issue.title, "feat: add a feature");
    assert.equal(issue.state, "open");
    assert.equal(issue.user.login, "Range Tester");
    assert.equal(issue.html_url, `local:${headSha}`);
    assert.deepEqual(result.context.comments, []);
    assert.deepEqual(result.context.timeline, []);

    const files = result.context.pullFiles as Array<{
      filename: string;
      status: string;
      patch: string;
    }>;
    assert.equal(files.length, 2);
    const byName = (name: string) => files.find((f) => f.filename === name);
    assert.equal(byName("feature.txt")?.status, "A");
    assert.match(byName("feature.txt")?.patch ?? "", /\+hello world/);
    assert.equal(byName("keep.txt")?.status, "M");
    assert.match(byName("keep.txt")?.patch ?? "", /\+more/);
    const semanticFiles = result.context.semanticPullFiles as Array<Record<string, unknown>>;
    const semanticByName = (name: string) => semanticFiles.find((file) => file.filename === name);
    assert.deepEqual(
      {
        baseMode: semanticByName("feature.txt")?.baseMode,
        baseType: semanticByName("feature.txt")?.baseType,
        headMode: semanticByName("feature.txt")?.headMode,
        headType: semanticByName("feature.txt")?.headType,
        treeModesComplete: semanticByName("feature.txt")?.treeModesComplete,
      },
      {
        baseMode: null,
        baseType: null,
        headMode: "100644",
        headType: "blob",
        treeModesComplete: true,
      },
    );

    assert.deepEqual(result.context.counts, { comments: 0, timeline: 0, pullFiles: 2 });
    assert.equal(result.baseSha, git(dir, "rev-parse", "base-ref"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview falls back to a range title when the commit subject is empty", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");

    writeFileSync(join(dir, "f.txt"), "x\n");
    git(dir, "add", "f.txt");
    git(dir, "commit", "-q", "--allow-empty-message", "-m", ""); // no subject

    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");
    const baseSha = git(dir, "rev-parse", "base-ref");
    const headSha = git(dir, "rev-parse", "HEAD");
    // title = `local range ${baseSha.slice(0,8)}..${headSha.slice(0,8)}`
    assert.equal(result.item.title, `local range ${baseSha.slice(0, 8)}..${headSha.slice(0, 8)}`);
    assert.equal(result.item.title, result.context.issue.title);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview defaults base to origin/main when baseRef is empty", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "-m", "init");
    const baseSha = git(dir, "rev-parse", "HEAD");
    // stand in for the remote-tracking ref the empty-base default resolves to
    git(dir, "update-ref", "refs/remotes/origin/main", baseSha);

    writeFileSync(join(dir, "feature.txt"), "hi\n");
    git(dir, "add", "feature.txt");
    git(dir, "commit", "-q", "-m", "feat: x");

    // empty baseRef → base falls back to "origin/main"
    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "");
    assert.equal(result.baseSha, baseSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview yields no pullFiles for a commit that changes nothing", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");
    git(dir, "commit", "-q", "--allow-empty", "-m", "empty: no file changes");

    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");
    assert.deepEqual(result.context.pullFiles, []);
    assert.equal(result.context.counts.pullFiles, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview handles renamed files (new path, non-empty patch, no tab leak)", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "old-name.txt"), "alpha\nbravo\ncharlie\ndelta\necho\n");
    git(dir, "add", "old-name.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");
    rmSync(join(dir, "old-name.txt"));
    writeFileSync(join(dir, "new-name.txt"), "alpha\nbravo\ncharlie\ndelta\nFOXTROT\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "rename old-name -> new-name with one edit");

    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");
    const files = result.context.pullFiles as Array<{
      filename: string;
      status: string;
      patch: string;
    }>;
    // the new path is what surfaces — NOT the literal "old-name.txt\tnew-name.txt"
    assert.ok(!files.some((f) => f.filename.includes("\t")), "filename must not be tab-joined");
    const renamed = files.find((f) => f.filename === "new-name.txt");
    assert.ok(renamed, "renamed file should appear under its new path");
    assert.match(renamed?.status ?? "", /^R/);
    assert.match(renamed?.patch ?? "", /FOXTROT/); // patch resolved against the new path
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview refuses a dirty working tree (committed-range contract)", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");
    writeFileSync(join(dir, "feature.txt"), "x\n");
    git(dir, "add", "feature.txt");
    git(dir, "commit", "-q", "-m", "feat: x");
    writeFileSync(join(dir, "uncommitted.txt"), "dirty\n"); // untracked → dirty tree

    assert.throws(() => buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref"), {
      message: /not clean|commit or stash/i,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview throws when HEAD has no commits beyond base", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "only.txt"), "x\n");
    git(dir, "add", "only.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref"); // points at HEAD — empty range

    assert.throws(() => buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref"), {
      message: /no commits beyond/i,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review rejects --item-number combined with --local-range", () => {
  // The guard fires before any checkout/fetch, so a non-git temp dir is enough.
  const dir = mkdtempSync(join(tmpdir(), "lrr-guard-"));
  try {
    const r = spawnSync(
      "node",
      [
        CLI,
        "review",
        "--local-only",
        "--local-range",
        "--item-number",
        "5",
        "--target-repo",
        "openclaw/clawsweeper",
        "--target-dir",
        dir,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(r.status, 0, "should exit non-zero on the flag conflict");
    assert.match((r.stderr ?? "") + (r.stdout ?? ""), /cannot be combined with --local-range/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--local-range defaults to the current checkout and isolates gh config in artifacts", () => {
  const dir = initRepo();
  const codexDir = mkdtempSync(join(tmpdir(), "lrr-default-codex-"));
  const fakeCodex = join(codexDir, "fake-codex.sh");
  const fakeCodexMarker = join(codexDir, "fake-codex-ran.txt");
  writeFileSync(
    fakeCodex,
    '#!/bin/sh\nprintf "%s\\n%s\\n" "$PWD" "$GH_CONFIG_DIR" > "$FAKE_CODEX_MARKER"\nexit 1\n',
  );
  chmodSync(fakeCodex, 0o755);
  try {
    writeFileSync(join(dir, "a.txt"), "base\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");
    writeFileSync(join(dir, "a.txt"), "base\nfeature\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", "feat: local range");

    const result = spawnSync(
      "node",
      [
        CLI,
        "review",
        "--local-range",
        "--base",
        "base-ref",
        "--target-repo",
        "openclaw/clawsweeper",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: "1",
          CODEX_BIN: fakeCodex,
          FAKE_CODEX_MARKER: fakeCodexMarker,
        },
        timeout: 60000,
      },
    );

    assert.notEqual(result.status, 0, "fake Codex should make the review fail after setup");
    const [codexCwd, ghConfigDir] = readFileSync(fakeCodexMarker, "utf8").trim().split("\n");
    assert.equal(realpathSync(codexCwd ?? ""), realpathSync(dir));
    assert.equal(basename(ghConfigDir ?? ""), ".gh-empty");
    assert.match(basename(dirname(ghConfigDir ?? "")), /^local-range-\d+-\d+$/);
    const gitArtifactRoot = resolve(
      dir,
      git(dir, "rev-parse", "--git-path", "clawsweeper/reviews"),
    );
    assert.equal(realpathSync(dirname(dirname(ghConfigDir ?? ""))), realpathSync(gitArtifactRoot));
    assert.ok(existsSync(ghConfigDir ?? ""));
    assert.equal(git(dir, "status", "--porcelain"), "");
  } finally {
    rmSync(codexDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--local-range does not host-download proof video URLs from the body", async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = initRepo();
  const codexDir = mkdtempSync(join(tmpdir(), "lrr-codex-"));
  const fakeCodex = join(codexDir, "fake-codex.sh");
  const fakeCodexMarker = join(codexDir, "fake-codex-ran.txt");
  writeFileSync(fakeCodex, '#!/bin/sh\nprintf "ran\\n" > "$FAKE_CODEX_MARKER"\nexit 1\n');
  chmodSync(fakeCodex, 0o755);
  try {
    writeFileSync(join(dir, "a.txt"), "x\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");
    writeFileSync(join(dir, "b.txt"), "y\n");
    git(dir, "add", "b.txt");
    // a video URL in the commit body that media-proof preprocessing would otherwise curl
    git(
      dir,
      "commit",
      "-q",
      "-m",
      `feat: thing\n\nproof video: http://127.0.0.1:${port}/proof.mp4`,
    );
    // codex is stubbed (CODEX_BIN exits 1) so no real engine runs; media-proof would still
    // curl the URL BEFORE the engine if it weren't skipped for --local-range.
    const result = spawnSync(
      "node",
      [
        CLI,
        "review",
        "--local-only",
        "--local-range",
        "--base",
        "base-ref",
        "--target-repo",
        "openclaw/clawsweeper",
        "--target-dir",
        dir,
        "--artifact-dir",
        join(codexDir, "artifacts"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: "1",
          CODEX_BIN: fakeCodex,
          FAKE_CODEX_MARKER: fakeCodexMarker,
        },
        timeout: 60000,
      },
    );
    assert.notEqual(result.status, 0, "fake Codex should make the review fail after setup");
    assert.equal(readFileSync(fakeCodexMarker, "utf8"), "ran\n");
    assert.equal(
      hits.length,
      0,
      `--local-range must not host-download body video URLs (server hits: ${JSON.stringify(hits)})`,
    );
  } finally {
    if (existsSync(fakeCodexMarker)) rmSync(fakeCodexMarker, { force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(codexDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
