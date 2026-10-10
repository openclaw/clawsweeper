import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydratePullRequestReviewSource } from "../../dist/clawsweeper-context-hydration.js";
import { withGitHubRun } from "../../dist/clawsweeper-github-runtime.js";
import { repositoryProfileFor, withTargetProfile } from "../../dist/repository-profiles.js";
import { writeExactReviewFailureDiagnostics } from "../../dist/clawsweeper-review-failure-diagnostics.js";

// Run after pnpm build. Real Git repositories exercise source preparation only;
// fixture metadata replaces GitHub reads, without model or publication work.
const root = mkdtempSync(join(tmpdir(), "clawsweeper-pinned-base-proof-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const present = (cwd, sha) =>
  spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
    cwd,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    stdio: "ignore",
  }).status === 0;
try {
  for (const deleted of [false, true]) {
    const dir = join(root, deleted ? "deleted" : "rewritten");
    const source = join(dir, "source");
    const origin = join(dir, "origin.git");
    const target = join(dir, "target");
    mkdirSync(source, { recursive: true });
    git(dir, "init", "--bare", "-q", origin);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(source, "init", "-q", "-b", "main");
    git(source, "config", "user.name", "Review acquisition proof");
    git(source, "config", "user.email", "review-proof@example.com");
    git(source, "config", "commit.gpgsign", "false");
    writeFileSync(join(source, "common.txt"), "common\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "common ancestor");
    const ancestor = git(source, "rev-parse", "HEAD");
    git(source, "remote", "add", "origin", origin);
    git(source, "push", "-q", "origin", "main");
    git(
      dir,
      "clone",
      "-q",
      "--filter=blob:none",
      "--single-branch",
      "--branch",
      "main",
      `file://${origin}`,
      target,
    );
    writeFileSync(join(source, "base.txt"), "pinned endpoint\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "pinned base");
    const base = git(source, "rev-parse", "HEAD");
    git(source, "push", "-q", "origin", "main", "HEAD:refs/heads/retained-base");
    git(source, "checkout", "-qb", "feature", ancestor);
    writeFileSync(join(source, "feature.txt"), "introduced change\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "pinned head");
    const head = git(source, "rev-parse", "HEAD");
    git(source, "push", "-q", "origin", "HEAD:refs/pull/1/head");
    git(source, "checkout", "-q", "main");
    git(source, "reset", "--hard", ancestor);
    writeFileSync(join(source, "replacement.txt"), "rewritten base\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "replacement base");
    git(source, "push", "-q", "--force", "origin", "main");
    if (deleted) git(origin, "update-ref", "-d", "refs/heads/main");

    const before = spawnSync(
      "git",
      [
        "fetch",
        "--no-auto-maintenance",
        "--filter=blob:none",
        "--no-tags",
        "--no-write-fetch-head",
        "origin",
        "refs/heads/main:refs/proof-before",
      ],
      { cwd: target, encoding: "utf8" },
    );
    assert.equal(deleted ? before.status !== 0 : before.status === 0, true);
    assert.equal(present(target, base), false, "branch-only acquisition cannot supply the pin");
    const ghFixture = join(dir, "gh.cjs");
    writeFileSync(
      ghFixture,
      `
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const revision = args[1].match(/\\/git\\/trees\\/([0-9a-f]+)\\?recursive=1$/)?.[1];
if (!revision) throw new Error("Unexpected GitHub request: " + args.join(" "));
const tree = execFileSync("git", ["ls-tree", "-r", "-l", revision], {
  cwd: ${JSON.stringify(source)}, encoding: "utf8",
}).trim().split("\\n").map(line => {
  const match = line.match(/^\\d+ (\\w+) ([0-9a-f]+)\\s+(\\d+)\\t/);
  if (!match) throw new Error("Invalid tree line");
  return { type: match[1], sha: match[2], size: Number(match[3]) };
});
console.log(JSON.stringify({ truncated: false, tree }));
`,
    );
    const profile = {
      ...repositoryProfileFor("openclaw/clawsweeper"),
      targetRepo: "fixture/repository",
    };
    process.env.GH_BIN = process.execPath;
    process.env.GH_BIN_ARGS = JSON.stringify([ghFixture]);
    process.env.GH_TOKEN = "synthetic-pinned-base-proof";
    const prepare = (pin = base) =>
      withTargetProfile(profile, () =>
        withGitHubRun(() =>
          hydratePullRequestReviewSource({
            itemNumber: 1,
            targetDir: target,
            pullRequest: { base: { ref: "main", sha: pin }, head: { sha: head } },
          }),
        ),
      );
    prepare();
    assert.equal(present(target, base), true);
    assert.equal(present(target, head), true);
    assert.equal(git(target, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(git(target, "merge-base", base, head), ancestor);
    assert.equal(
      git(target, "diff", ancestor, head, "--"),
      git(source, "diff", ancestor, head, "--"),
    );
    git(target, "remote", "set-url", "origin", join(dir, "offline.git"));
    prepare();
    assert.equal(git(target, "rev-parse", "HEAD"), ancestor);
    assert.equal(git(target, "status", "--porcelain"), "");
    git(target, "remote", "set-url", "origin", origin);
    let failure;
    try {
      prepare("f".repeat(40));
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    const diagnosticDir = writeExactReviewFailureDiagnostics({
      artifactDir: join(dir, "diagnostic"),
      error: failure,
      prompt: "",
      model: "",
      classification: "source_preparation",
      repo: "fixture/repository",
      itemKind: "pull_request",
      itemNumber: 1,
      sourceSha: failure.reviewedHeadSha,
      retryable: true,
      workflowExit: 1,
      env: {},
    });
    const diagnostic = JSON.parse(readFileSync(join(diagnosticDir, "manifest.json"), "utf8"));
    assert.equal(diagnostic.source.sha, head);
    assert.equal(diagnostic.failure.acquisition.phase, "base");
    assert.equal(diagnostic.failure.acquisition.requested_sha, "f".repeat(40));
    assert.equal(diagnostic.failure.acquisition.commit, "missing");
    assert.ok(diagnostic.process.status > 0);
    console.log(
      JSON.stringify({
        scenario: deleted ? "deleted_base" : "rewritten_base",
        branchOnlyMissing: true,
        coldPrepared: true,
        warmOfflinePrepared: true,
        exactAncestry: true,
        unavailablePinDiagnosed: true,
      }),
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
