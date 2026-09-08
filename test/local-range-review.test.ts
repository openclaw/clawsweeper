import assert from "node:assert/strict";
import test from "node:test";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLocalRangeReviewForTest,
  renderReviewCommentFromReport,
} from "../dist/clawsweeper.js";
import { buildPullRequestReviewEvidence, readReviewGit } from "../dist/pr-review-evidence.js";
import { createLocalRangeReviewer } from "../dist/clawsweeper-local-review.js";
import { runText, SWEEPER_COMMAND_MAX_BUFFER_BYTES } from "../dist/command.js";
import { changelogReviewDecision, reviewFinding } from "./helpers.ts";

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
    assert.equal(result.context.counts.pullFiles, 2);
    assert.equal(result.context.counts.pullFilesHydrated, 2);
    assert.equal(result.context.counts.pullFilesTruncated, false);
    assert.equal(result.context.counts.pullCommits, 1);
    assert.equal(result.context.counts.pullCommitsHydrated, 1);
    assert.equal(result.context.counts.pullCommitsTruncated, false);
    assert.match(result.context.pullCommitsRevision ?? "", /^[0-9a-f]{64}$/);
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

test("buildLocalRangeReview fingerprints full commit messages beyond prompt truncation", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");
    writeFileSync(join(dir, "feature.txt"), "feature\n");
    git(dir, "add", "feature.txt");
    const prefix = `feat: cache\n\n${"x".repeat(1100)}`;
    git(dir, "commit", "-q", "-m", `${prefix}a`);
    const prior = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");

    git(dir, "commit", "--amend", "-q", "-m", `${prefix}b`);
    const changed = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");
    const priorMessage = (prior.context.pullCommits?.[0] as { message?: string } | undefined)
      ?.message;
    const changedMessage = (changed.context.pullCommits?.[0] as { message?: string } | undefined)
      ?.message;

    assert.equal(priorMessage, changedMessage);
    assert.notEqual(prior.context.pullCommitsRevision, changed.context.pullCommitsRevision);
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

// Simulated external metadata failures; all other commands still execute real Git.
function writeMetadataGit(harness: string): string {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const modeFile = join(harness, "mode.txt");
  const script = join(harness, "git.mjs");
  writeFileSync(
    script,
    `import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (!args.includes("--numstat") && !args.includes("--name-status")) {
  const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: "utf8", env: process.env });
if (result.status !== 0) process.exit(result.status ?? 1);
let output = result.stdout;
const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8");
if (mode === "slow-metadata" && (args.includes("--name-status") || args.includes("--numstat"))) {
  await new Promise(resolve => setTimeout(resolve, 5500));
}
if (args.includes("--numstat")) {
  if (mode === "failed") process.exit(1);
  // Well-framed, otherwise valid decimal counts: only the capture bound makes this unavailable.
  if (mode === "oversized") output = "0".repeat(2 * 1024 * 1024) + output;
  if (mode === "missing-nul") output = output.slice(0, -1);
  if (mode === "mismatched") output = output.replace("file.txt", "other.txt");
  if (mode === "empty") output = "";
  if (mode === "missing-record") output = output.slice(0, output.indexOf("\\0") + 1);
  if (mode === "duplicate") output += output;
  if (mode === "extra-record") output += "1\\t1\\textra.txt\\0";
  if (mode === "late-malformed") output += "broken\\0";
  if (mode === "invalid-utf8") output = Buffer.concat([Buffer.from(output), Buffer.from([255, 0])]);
  if (mode === "invalid-count") output = "bad\\t1\\tfile.txt\\0";
  if (mode === "mixed-binary") output = "-\\t1\\tfile.txt\\0";
  if (mode === "unsafe-count") output = "9007199254740992\\t1\\tfile.txt\\0";
  if (mode === "incomplete-rename") output = "1\\t1\\t\\0old.txt\\0";
  if (mode === "wrong-rename") output = "1\\t1\\t\\0wrong.txt\\0file.txt\\0" + "1\\t0\\tsecond.txt\\0";
  if (mode === "large-names") process.exit(1);
}
if (args.includes("--name-status")) {
  if (mode === "failed-name") process.exit(1);
  if (mode === "incomplete-name") output = "R100\\0old.txt\\0";
  if (mode === "missing-name-nul") output = output.slice(0, -1);
  if (mode === "duplicate-name") output += output;
  if (mode === "invalid-name-status") output = "invalid\\0file.txt\\0";
  if (mode === "invalid-name-utf8") output = Buffer.from([77, 0, 255, 0]);
  if (mode === "large-names") {
    output = Array.from({ length: 2048 }, (_, i) => "M\\0" + "x".repeat(1024) + i + "\\0").join("");
  }
}
process.stdout.write(output);
`,
  );
  writeFileSync(join(harness, "git"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
    mode: 0o755,
  });
  return modeFile;
}

test(
  "local-range tolerates simulated unavailable numstat but refuses invalid required file lists",
  { skip: process.platform === "win32" ? "POSIX Git process wrapper" : false },
  (t) => {
    useFakeScanner(t);
    const dir = initRepo();
    const harness = mkdtempSync(join(tmpdir(), "lrr-git-framing-"));
    const originalPath = process.env.PATH;
    try {
      writeFileSync(join(dir, "file.txt"), "before\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "base");
      git(dir, "branch", "base-ref");
      writeFileSync(join(dir, "file.txt"), "after\n");
      writeFileSync(join(dir, "second.txt"), "second\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "change");
      const modeFile = writeMetadataGit(harness);
      const fakeCodex = writeLocalReviewCodex(harness);
      const decisionPath = join(harness, "decision.json");
      writeFileSync(decisionPath, JSON.stringify(changelogReviewDecision()));
      process.env.PATH = `${harness}${delimiter}${originalPath}`;
      const runReview = (mode: string) =>
        spawnSync(
          process.execPath,
          [
            CLI,
            "review",
            "--local-range",
            "--base",
            "base-ref",
            "--target-repo",
            "openclaw/openclaw",
            "--target-dir",
            dir,
            "--artifact-dir",
            join(harness, mode),
            "--codex-timeout-ms",
            "60000",
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: "1",
              CODEX_BIN: fakeCodex,
              LOCAL_REVIEW_CAPTURE: join(harness, "captures.json"),
              LOCAL_REVIEW_DECISION: decisionPath,
              LOCAL_REVIEW_FAIL: "0",
            },
            timeout: 60000,
          },
        );
      const expected = [
        { filename: "file.txt", status: "M", additions: null, deletions: null },
        { filename: "second.txt", status: "A", additions: null, deletions: null },
      ];
      const assertCompletedReview = (mode: string) => {
        // Actual CLI/report/reload/renderer with fake Codex, scanner, and faulty numstat.
        const result = runReview(mode);
        assert.equal(
          result.status,
          0,
          `${mode}: ${result.error ?? ""}${result.stderr}${result.stdout}`,
        );
        const report = readFileSync(join(harness, mode, "0.md"), "utf8");
        const stored = report.match(/^pr_surface_files: (.*)$/m);
        assert.ok(stored);
        assert.deepEqual(
          JSON.parse(stored[1]!),
          expected.map(({ filename, additions, deletions }) => ({
            path: filename,
            additions,
            deletions,
          })),
        );
        assert.match(report, /^pr_surface_files_truncated: false$/m);
        const comment = renderReviewCommentFromReport(report, "none");
        assert.match(comment, /PR surface statistics unavailable: complete line counts/);
        assert.doesNotMatch(comment, /\| \*\*Total\*\* \|/);
      };
      for (const mode of [
        "failed",
        "oversized",
        "missing-nul",
        "mismatched",
        "empty",
        "missing-record",
        "duplicate",
        "extra-record",
        "late-malformed",
        "invalid-utf8",
        "invalid-count",
        "mixed-binary",
        "unsafe-count",
        "incomplete-rename",
        "wrong-rename",
      ]) {
        writeFileSync(modeFile, mode);
        const review = buildLocalRangeReviewForTest(dir, "openclaw/openclaw", "base-ref");
        for (const files of [review.context.pullFiles]) {
          assert.deepEqual(
            files.map(({ filename, status, additions, deletions }) => ({
              filename,
              status,
              additions,
              deletions,
            })),
            expected,
            mode,
          );
          assert.match(files[0].patch, /-before\n\+after/, mode);
          assert.match(files[1].patch, /\+second/, mode);
        }
        assert.equal(review.context.counts.pullFiles, 2, mode);
        assert.equal(review.context.counts.pullFilesHydrated, 2, mode);
        assert.equal(review.context.counts.pullFilesTruncated, false, mode);
        if (["failed", "oversized", "late-malformed"].includes(mode)) {
          assertCompletedReview(mode);
        }
      }
      // One slow CLI scenario: required names survive 5.5s; optional numstat still times out.
      writeFileSync(modeFile, "slow-metadata");
      assertCompletedReview("slow-metadata");
      t.diagnostic(
        "5.5-second required enumeration completed; optional numstat timed out to null counts",
      );
      for (const mode of [
        "failed-name",
        "incomplete-name",
        "missing-name-nul",
        "duplicate-name",
        "invalid-name-status",
        "invalid-name-utf8",
      ]) {
        writeFileSync(modeFile, mode);
        assert.throws(
          () => buildLocalRangeReviewForTest(dir, "openclaw/openclaw", "base-ref"),
          /Could not read complete local-range Git file list/,
          mode,
        );
        if (mode === "failed-name") {
          const result = runReview(mode);
          assert.notEqual(result.status, 0);
          assert.match(
            result.stderr + result.stdout,
            /Could not read complete local-range Git file list/,
          );
          assert.equal(existsSync(join(harness, mode, "0.md")), false);
        }
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(harness, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "required local-range enumeration retains the runtime capture budget beyond 1 MiB",
  { skip: process.platform === "win32" ? "POSIX Git process wrapper" : false },
  () => {
    const dir = initRepo();
    const harness = mkdtempSync(join(tmpdir(), "lrr-git-budget-"));
    const originalPath = process.env.PATH;
    try {
      git(dir, "commit", "-qm", "base", "--allow-empty");
      git(dir, "branch", "base-ref");
      git(dir, "commit", "-qm", "head", "--allow-empty");
      const modeFile = writeMetadataGit(harness);
      writeFileSync(modeFile, "large-names");
      process.env.PATH = `${harness}${delimiter}${originalPath}`;
      assert.equal(SWEEPER_COMMAND_MAX_BUFFER_BYTES, 128 * 1024 * 1024);
      // Synthetic >2 MiB enumeration; existing factory dependencies avoid per-path Git processes.
      // This proves capture compatibility, not a native Git tree or scanner acceptance.
      let patches = 0;
      const build = createLocalRangeReviewer({
        run: (command, args, options) => {
          if (args.includes("diff")) {
            patches++;
            return "";
          }
          return runText(command, args, options);
        },
        pullCommitContentRevision: () => "fixture-commit-revision",
        reviewCommentContentRevision: () => "fixture-comment-revision",
      });
      const review = build(dir, "openclaw/openclaw", "base-ref");
      for (const files of [review.context.pullFiles]) {
        assert.equal(files.length, 2048);
        assert.deepEqual(
          files.map(({ filename }) => filename),
          Array.from({ length: 2048 }, (_, i) => "x".repeat(1024) + i),
        );
        assert.ok(files.every((file) => file.additions === null && file.deletions === null));
      }
      assert.equal(patches, 2048);
      assert.equal(review.context.counts.pullFilesTruncated, false);
      assert.equal(
        readReviewGit(dir, ["diff", "--name-status", "-z", "base-ref..HEAD", "--"]),
        null,
        "the generic raw Git reader must keep its 1 MiB default",
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(harness, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

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

test("buildLocalRangeReview distinguishes binary counts, real zeros, and edited copies", () => {
  const dir = initRepo();
  try {
    git(dir, "config", "core.filemode", "false");
    git(dir, "config", "diff.renames", "copies");
    writeFileSync(join(dir, "old.txt"), "pure rename\n");
    writeFileSync(join(dir, "mode.sh"), "echo mode\n");
    writeFileSync(join(dir, "binary.dat"), "\0before\n");
    const original = Array.from({ length: 20 }, (_, i) => `copy source line ${i}\n`).join("");
    writeFileSync(join(dir, "source.txt"), original);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    git(dir, "branch", "base-ref");
    renameSync(join(dir, "old.txt"), join(dir, "renamed.txt"));
    writeFileSync(join(dir, "source.txt"), `${original}source append\n`);
    writeFileSync(
      join(dir, "copy.txt"),
      original.replace("copy source line 19", "edited copy line"),
    );
    writeFileSync(join(dir, "binary.dat"), "\0after\n");
    git(dir, "add", "-A");
    git(dir, "update-index", "--chmod=+x", "mode.sh");
    git(dir, "commit", "-qm", "rename, copy, mode, and binary");

    const review = buildLocalRangeReviewForTest(dir, "openclaw/openclaw", "base-ref");
    for (const files of [review.context.pullFiles]) {
      const byName = (filename: string) => files.find((file) => file.filename === filename);
      assert.deepEqual(
        files.map(({ filename, additions, deletions }) => ({ filename, additions, deletions })),
        [
          { filename: "binary.dat", additions: null, deletions: null },
          { filename: "copy.txt", additions: 1, deletions: 1 },
          { filename: "mode.sh", additions: 0, deletions: 0 },
          { filename: "renamed.txt", additions: 0, deletions: 0 },
          { filename: "source.txt", additions: 1, deletions: 0 },
        ],
      );
      assert.equal(byName("renamed.txt").status, "R100");
      assert.equal(byName("renamed.txt").previous_filename, "old.txt");
      assert.match(byName("mode.sh").patch, /old mode 100644\nnew mode 100755/);
      assert.match(byName("copy.txt").status, /^C/);
      assert.equal(byName("copy.txt").previous_filename, "source.txt");
      assert.match(byName("copy.txt").patch, /copy from source.txt/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "local-range producer preserves NUL-framed special paths without executing target helpers",
  {
    skip: process.platform === "win32" ? "Windows cannot represent these Git paths" : false,
  },
  () => {
    const dir = initRepo();
    try {
      git(dir, "config", "diff.renames", "true");
      const old = " old\tname\n.txt ";
      const renamed = " new\nname\t.txt ";
      const added = " added\tfile\n.txt ";
      writeFileSync(join(dir, old), "first\nsecond\nthird\nfourth\nfifth\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "base");
      git(dir, "branch", "base-ref");
      renameSync(join(dir, old), join(dir, renamed));
      writeFileSync(join(dir, renamed), "first\nsecond\nthird\nfourth\nchanged\n");
      writeFileSync(join(dir, added), "new file\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "special paths");
      const review = buildLocalRangeReviewForTest(dir, "openclaw/openclaw", "base-ref");
      for (const files of [review.context.pullFiles]) {
        assert.deepEqual(
          files.map(({ filename, previous_filename, additions, deletions }) => ({
            filename,
            previous_filename,
            additions,
            deletions,
          })),
          [
            { filename: added, previous_filename: undefined, additions: 1, deletions: 0 },
            { filename: renamed, previous_filename: old, additions: 1, deletions: 1 },
          ],
        );
        assert.match(files[0].patch, /\+new file/);
        assert.match(files[1].patch, /-fifth\n\+changed/);
      }
      // This is producer-only coverage; the native scanner still rejects control-character paths.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

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

test("--local-range defaults to the current checkout and isolates gh config in artifacts", (t) => {
  useFakeScanner(t);
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
    const cacheMetrics = JSON.parse(
      readFileSync(join(dirname(ghConfigDir ?? ""), "review-cache-metrics.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(cacheMetrics.structural_cache_hits, 0);
    assert.equal(cacheMetrics.content_cache_hits, 0);
    assert.equal(git(dir, "status", "--porcelain"), "");
  } finally {
    rmSync(codexDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--local-range does not host-download proof video URLs from the body", async (t) => {
  useFakeScanner(t);
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

function writeLocalReviewCodex(harness: string, priorFindingTitle = ""): string {
  const fakeCodexScript = join(harness, "fake-codex.mjs");
  const fakeCodex =
    process.platform === "win32" ? join(harness, "fake-codex.cmd") : join(harness, "fake-codex");
  writeFileSync(
    fakeCodexScript,
    `import { spawnSync } from "node:child_process";
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "sandbox") {
  const separator = args.indexOf("--");
  const result = spawnSync(args[separator + 1], args.slice(separator + 2), {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}
const outputPath = args[args.indexOf("--output-last-message") + 1];
const prompt = fs.readFileSync(0, "utf8");
const captures = fs.existsSync(process.env.LOCAL_REVIEW_CAPTURE)
  ? JSON.parse(fs.readFileSync(process.env.LOCAL_REVIEW_CAPTURE, "utf8"))
  : [];
captures.push({
  hasPreviousReview: prompt.includes('"previousClawSweeperReview"'),
  hasPriorFinding: prompt.includes(${JSON.stringify(priorFindingTitle)}),
  previousReviewedSha: prompt.match(/"reviewedSha":\\s*"([0-9a-f]{40})"/)?.[1] ?? null,
});
fs.writeFileSync(process.env.LOCAL_REVIEW_CAPTURE, JSON.stringify(captures));
if (process.env.LOCAL_REVIEW_FAIL === "1") {
  process.stderr.write("deterministic local review failure\\n");
  process.exit(1);
}
fs.writeFileSync(outputPath, fs.readFileSync(process.env.LOCAL_REVIEW_DECISION));
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }) + "\\n");
`,
  );
  if (process.platform === "win32") {
    writeFileSync(fakeCodex, `@echo off\r\n"${process.execPath}" "${fakeCodexScript}" %*\r\n`);
  } else {
    writeFileSync(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexScript}" "$@"\n`, {
      mode: 0o755,
    });
  }
  return fakeCodex;
}

test("--local-range persists whole-range Git statistics beyond every display evidence cap", (t) => {
  useFakeScanner(t);
  const dir = initRepo();
  const harness = mkdtempSync(join(tmpdir(), "lrr-stats-"));
  const fakeCodex = writeLocalReviewCodex(harness);
  const decisionPath = join(harness, "decision.json");
  writeFileSync(decisionPath, JSON.stringify(changelogReviewDecision()));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string) => {
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", message);
  };
  const runReview = (name: string) => {
    const output = join(harness, name);
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--local-range",
        "--base",
        "base-ref",
        "--target-repo",
        "openclaw/openclaw",
        "--target-dir",
        dir,
        "--artifact-dir",
        output,
        "--codex-timeout-ms",
        "60000",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: "1",
          CODEX_BIN: fakeCodex,
          LOCAL_REVIEW_CAPTURE: join(harness, "captures.json"),
          LOCAL_REVIEW_DECISION: decisionPath,
          LOCAL_REVIEW_FAIL: "0",
        },
        timeout: 60000,
      },
    );
    assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}${result.stdout}`);
    return readFileSync(join(output, "0.md"), "utf8");
  };
  const storedFiles = (report: string) => {
    const field = report.match(/^pr_surface_files: (.*)$/m);
    assert.ok(field);
    return JSON.parse(field[1]!);
  };
  try {
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "config", "diff.renames", "true");
    put("src/early.ts", "original\n");
    put("src/reversed.ts", "unchanged at endpoints\n");
    const oldLines = Array.from({ length: 10 }, (_, i) => `rename line ${i}\n`).join("");
    put("src/old.ts", oldLines);
    put("tests/removed.test.ts", "remove one\nremove two\nremove three\n");
    commit("base");
    git(dir, "branch", "base-ref");
    put("src/early.ts", "original\nearlier only\nstill present\n");
    put("src/reversed.ts", "temporary churn\nmore temporary churn\n");
    commit("earlier change and temporary churn");

    put("src/reversed.ts", "unchanged at endpoints\n");
    renameSync(join(dir, "src/old.ts"), join(dir, "src/renamed.ts"));
    put("src/renamed.ts", oldLines.replace("rename line 9", "edited final line"));
    put(
      "src/large.ts",
      Array.from({ length: 6000 }, (_, i) => `// ${i} ${"x".repeat(100)}\n`).join(""),
    );
    rmSync(join(dir, "tests/removed.test.ts"));
    put("tests/added.test.ts", "test one\ntest two\n");
    put(".github/workflows/check.yml", "name: fixture\n");
    const expected = [
      { path: ".github/workflows/check.yml", additions: 1, deletions: 0 },
      ...Array.from({ length: 81 }, (_, i) => {
        const path = `docs/file-${String(i).padStart(2, "0")}.md`;
        put(path, `Guide ${i}\n`);
        return { path, additions: 1, deletions: 0 };
      }),
      { path: "src/early.ts", additions: 2, deletions: 0 },
      { path: "src/large.ts", additions: 6000, deletions: 0 },
      { path: "src/renamed.ts", additions: 1, deletions: 1 },
      { path: "tests/added.test.ts", additions: 2, deletions: 0 },
      { path: "tests/removed.test.ts", additions: 0, deletions: 3 },
    ];
    commit("later changes and reversal");

    // Independent fixture arithmetic: 6000 + 81 + 2 + 1 + 2 + 1 additions; 1 + 3 deletions.
    assert.match(
      git(dir, "diff", "--shortstat", "base-ref", "HEAD"),
      /87 files changed, 6087 insertions\(\+\), 4 deletions\(-\)/,
    );
    const review = buildLocalRangeReviewForTest(dir, "openclaw/openclaw", "base-ref");
    for (const entries of [review.context.pullFiles]) {
      const files = entries as Array<Record<string, unknown>>;
      assert.deepEqual(
        files.map(({ filename: path, additions, deletions }) => ({ path, additions, deletions })),
        expected,
      );
      const renamed = files.find((file) => file.filename === "src/renamed.ts")!;
      assert.match(String(renamed.status), /^R/);
      assert.equal(renamed.previous_filename, "src/old.ts");
      assert.match(String(renamed.patch), /rename from src\/old.ts/);
      assert.match(String(renamed.patch), /-rename line 9\n\+edited final line/);
      assert.equal(files.find((file) => file.filename === "src/early.ts")?.status, "M");
      assert.equal(files.find((file) => file.filename === "src/large.ts")?.status, "A");
      assert.equal(files.find((file) => file.filename === "tests/removed.test.ts")?.status, "D");
      assert.ok(!files.some((file) => file.filename === "src/reversed.ts"));
    }
    const promptLarge = review.context.pullFiles.find((file) => file.filename === "src/large.ts");
    assert.match(promptLarge.patch, /\[truncated \d+ chars\]$/);
    assert.ok(promptLarge.patch.length < 8100);
    assert.equal(review.context.counts.pullFiles, 87);
    assert.equal(review.context.counts.pullFilesTruncated, false);
    const evidence = buildPullRequestReviewEvidence({
      targetDir: dir,
      context: review.context,
      mainSha: review.baseSha,
    });
    assert.equal(evidence.introduced.files.length, 80);
    assert.equal(evidence.introduced.filesComplete, false);
    assert.equal(evidence.introduced.patch?.length, 24000);
    assert.equal(evidence.introduced.patchComplete, false);

    const report = runReview("numeric");
    assert.deepEqual(storedFiles(report), expected);
    assert.match(report, /^pr_surface_files_truncated: false$/m);
    const comment = renderReviewCommentFromReport(report, "none");
    const total = "| **Total** | **87** | **6087** | **4** | **+6083** |";
    assert.ok(comment.includes(total));
    assert.ok(comment.includes("| Source | 3 | 6003 | 1 | +6002 |"));
    assert.ok(comment.includes("| Tests | 2 | 2 | 3 | -1 |"));
    assert.match(comment, /Total \+6083 across 87 files/);
    const historyPath = resolve(
      dir,
      git(dir, "rev-parse", "--git-path", "clawsweeper/reviews"),
      `local-range-review-history-openclaw-openclaw-${review.baseSha}.md`,
    );
    assert.ok(readFileSync(historyPath, "utf8").includes(total));

    put("binary.dat", "\0binary payload\n");
    commit("binary line counts are unknown");
    const binaryReport = runReview("binary");
    assert.deepEqual(
      storedFiles(binaryReport).find((file) => file.path === "binary.dat"),
      { path: "binary.dat", additions: null, deletions: null },
    );
    const binaryComment = renderReviewCommentFromReport(binaryReport, "none");
    assert.match(binaryComment, /PR surface statistics unavailable: complete line counts/);
    assert.doesNotMatch(binaryComment, /\| \*\*Total\*\* \|/);
    assert.equal(git(dir, "status", "--porcelain"), "");
  } finally {
    rmSync(harness, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--local-range carries hosted-shaped review history across related local iterations", (t) => {
  useFakeScanner(t);
  const dir = initRepo();
  const harness = mkdtempSync(join(tmpdir(), "lrr-history-"));
  const capturePath = join(harness, "captures.json");
  const decisionPath = join(harness, "decision.json");
  const priorFindingTitle = "Preserve earlier local finding";
  writeFileSync(
    decisionPath,
    JSON.stringify(
      changelogReviewDecision({
        summary: "The deterministic local review found one history-sensitive defect.",
        bestSolution: "Preserve earlier local review context on the next iteration.",
        reviewFindings: [
          reviewFinding({
            title: priorFindingTitle,
            body: "A follow-up local review must see this earlier finding.",
            file: "feature.txt",
            lineStart: 1,
            lineEnd: 1,
          }),
        ],
        workReason: "Preserve earlier local review context.",
        workPrompt: "Carry the previous local review into the follow-up prompt.",
        workLikelyFiles: ["feature.txt"],
      }),
    ),
  );
  const fakeCodex = writeLocalReviewCodex(harness, priorFindingTitle);

  function runReview(artifactDir: string, base = "base-ref", shouldFail = false): void {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--local-range",
        "--base",
        base,
        "--target-repo",
        "openclaw/clawsweeper",
        "--target-dir",
        dir,
        "--artifact-dir",
        artifactDir,
        "--codex-timeout-ms",
        "60000",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: "1",
          CODEX_BIN: fakeCodex,
          LOCAL_REVIEW_CAPTURE: capturePath,
          LOCAL_REVIEW_DECISION: decisionPath,
          LOCAL_REVIEW_FAIL: shouldFail ? "1" : "0",
        },
        timeout: 60000,
      },
    );
    if (shouldFail) {
      assert.notEqual(result.status, 0, "deterministic Codex failure must fail the review run");
    } else {
      assert.equal(result.status, 0, `${result.stderr ?? ""}${result.stdout ?? ""}`);
    }
  }

  try {
    writeFileSync(join(dir, "base.txt"), "base\n");
    git(dir, "add", "base.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");
    const baseSha = git(dir, "rev-parse", "base-ref");
    writeFileSync(join(dir, "feature.txt"), "first\n");
    git(dir, "add", "feature.txt");
    git(dir, "commit", "-q", "-m", "feat: first local review");
    const firstHead = git(dir, "rev-parse", "HEAD");

    runReview(join(harness, "run-1"));
    writeFileSync(join(dir, "feature.txt"), "first\nsecond\n");
    git(dir, "add", "feature.txt");
    git(dir, "commit", "-q", "-m", "fix: follow up on local review");
    const failedHead = git(dir, "rev-parse", "HEAD");
    runReview(join(harness, "run-2-failed"), "base-ref", true);
    runReview(join(harness, "run-3"));

    const historyPath = resolve(
      dir,
      git(dir, "rev-parse", "--git-path", "clawsweeper/reviews"),
      `local-range-review-history-openclaw-clawsweeper-${baseSha}.md`,
    );
    const relatedHistory = readFileSync(historyPath, "utf8");
    assert.match(relatedHistory, /Review history \(1 earlier review cycle\)/);
    assert.match(relatedHistory, new RegExp(firstHead));

    git(dir, "branch", "alternate-base", firstHead);
    runReview(join(harness, "run-4"), "alternate-base");

    git(dir, "checkout", "-q", "-b", "unrelated", "base-ref");
    writeFileSync(join(dir, "unrelated.txt"), "different branch\n");
    git(dir, "add", "unrelated.txt");
    git(dir, "commit", "-q", "-m", "feat: unrelated local range");
    runReview(join(harness, "run-5"));

    const captures = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      hasPreviousReview: boolean;
      hasPriorFinding: boolean;
      previousReviewedSha: string | null;
    }>;
    assert.deepEqual(captures, [
      { hasPreviousReview: false, hasPriorFinding: false, previousReviewedSha: null },
      { hasPreviousReview: true, hasPriorFinding: true, previousReviewedSha: firstHead },
      { hasPreviousReview: true, hasPriorFinding: true, previousReviewedSha: firstHead },
      { hasPreviousReview: false, hasPriorFinding: false, previousReviewedSha: null },
      { hasPreviousReview: false, hasPriorFinding: false, previousReviewedSha: null },
    ]);
    assert.doesNotMatch(JSON.stringify(captures[2]), new RegExp(failedHead));
    assert.doesNotMatch(readFileSync(historyPath, "utf8"), /Review history \(/);
    assert.equal(git(dir, "status", "--porcelain"), "");
  } finally {
    rmSync(harness, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
