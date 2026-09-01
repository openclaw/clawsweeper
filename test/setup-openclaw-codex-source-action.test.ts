import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = ".github/actions/setup-openclaw-codex-source/install.sh";
const realGit = execFileSync("/usr/bin/env", ["which", "git"], { encoding: "utf8" }).trim();

type Fixture = ReturnType<typeof createFixture>;

function git(cwd: string, args: string[]): string {
  return execFileSync(realGit, args, { cwd, encoding: "utf8" }).trim();
}

function writePin(root: string, version: string): void {
  mkdirSync(join(root, "extensions", "codex"), { recursive: true });
  writeFileSync(
    join(root, "extensions", "codex", "package.json"),
    `${JSON.stringify({ dependencies: { "@openai/codex": version } })}\n`,
  );
}

function addVersion(fixture: { remote: string }, version: string, selection: string): string {
  writeFileSync(
    join(fixture.remote, "contract.rs"),
    `pub const SKILL_SELECTION: &str = "${selection}";\n`,
  );
  git(fixture.remote, ["add", "contract.rs"]);
  git(fixture.remote, ["commit", "--quiet", "-m", `fixture ${version}`]);
  git(fixture.remote, ["tag", `rust-v${version}`]);
  return git(fixture.remote, ["rev-parse", "HEAD"]);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-codex-source-"));
  const workspace = join(root, "workspace");
  const target = join(workspace, "openclaw");
  const remote = join(root, "codex-remote");
  const cache = join(workspace, "openclaw-codex-cache.git");
  const artifacts = join(workspace, "artifacts", "event");
  const githubEnv = join(workspace, "github-env");
  const bin = join(root, "bin");
  const fetchLog = join(root, "git-fetch.log");
  mkdirSync(remote, { recursive: true });
  git(remote, ["init", "--quiet"]);
  for (const [key, value] of [
    ["user.name", "ClawSweeper test"],
    ["user.email", "clawsweeper@example.invalid"],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
  ]) {
    git(remote, ["config", key, value]);
  }
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    '#!/usr/bin/env bash\nfor arg in "$@"; do\n  if [[ "$arg" == "fetch" ]]; then\n    printf "fetch\\n" >> "$GIT_FETCH_LOG"\n    break\n  fi\ndone\nexec "$REAL_GIT" "$@"\n',
  );
  chmodSync(join(bin, "git"), 0o755);
  writePin(target, "1.2.3");
  const initialHead = addVersion({ remote }, "1.2.3", "path");
  return {
    artifacts,
    bin,
    cache,
    fetchLog,
    githubEnv,
    initialHead,
    remote,
    root,
    source: join(workspace, "codex"),
    target,
    workspace,
  };
}

function runSetup(
  fixture: Fixture,
  options: { pinRoot?: string; sourceUrl?: string } = {},
): ReturnType<typeof spawnSync> & { fetchCount: number } {
  rmSync(fixture.fetchLog, { force: true });
  const result = spawnSync(
    "bash",
    [
      script,
      "openclaw/openclaw",
      fixture.target,
      fixture.artifacts,
      fixture.cache,
      options.sourceUrl ?? fixture.remote,
      options.pinRoot ?? fixture.target,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_ENV: fixture.githubEnv,
        GITHUB_WORKSPACE: fixture.workspace,
        GIT_FETCH_LOG: fixture.fetchLog,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        REAL_GIT: realGit,
      },
      encoding: "utf8",
    },
  );
  const fetchCount = existsSync(fixture.fetchLog)
    ? readFileSync(fixture.fetchLog, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  return Object.assign(result, { fetchCount });
}

function createReviewTree(fixture: Fixture, name: string, version: string): string {
  const tree = join(fixture.artifacts, "review-trees", name);
  writePin(tree, version);
  return tree;
}

function assertPrepared(fixture: Fixture, expectedHead: string, selection: string): void {
  assert.equal(git(fixture.source, ["rev-parse", "HEAD"]), expectedHead);
  assert.equal(git(fixture.source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.equal(
    readFileSync(join(fixture.source, "contract.rs"), "utf8"),
    `pub const SKILL_SELECTION: &str = "${selection}";\n`,
  );
}

function useFixture(t: test.TestContext): Fixture {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { force: true, recursive: true }));
  return fixture;
}

test("reuses a complete same-pin cache without network access", (t) => {
  const fixture = useFixture(t);
  const first = runSetup(fixture);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.fetchCount, 1);

  renameSync(fixture.remote, `${fixture.remote}.offline`);
  const offline = runSetup(fixture);
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(offline.fetchCount, 0);
  assertPrepared(fixture, fixture.initialHead, "path");

  const reviewSibling = join(fixture.artifacts, "review-trees", "codex");
  assert.equal(lstatSync(reviewSibling).isSymbolicLink(), true);
  assert.equal(realpathSync(reviewSibling), realpathSync(fixture.source));
  assert.equal(
    readFileSync(fixture.githubEnv, "utf8").includes("CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT="),
    true,
  );
});

test("publishes the runtime contract before deferring an incompatible base pin", (t) => {
  const fixture = useFixture(t);
  writePin(fixture.target, "^1.2.3");

  const incompatible = runSetup(fixture);
  assert.equal(incompatible.status, 80, incompatible.stderr);
  const environment = readFileSync(fixture.githubEnv, "utf8");
  for (const name of [
    "CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT",
    "CLAWSWEEPER_OPENCLAW_CODEX_TARGET_DIR",
    "CLAWSWEEPER_OPENCLAW_CODEX_ARTIFACT_DIR",
    "CLAWSWEEPER_OPENCLAW_CODEX_CACHE_DIR",
    "CLAWSWEEPER_OPENCLAW_CODEX_SOURCE_URL",
  ]) {
    assert.match(environment, new RegExp(`^${name}=`, "m"));
  }
});

test("retargets to a cached pin offline and replaces a wrong dirty checkout", (t) => {
  const fixture = useFixture(t);
  assert.equal(runSetup(fixture).status, 0);
  const updatedHead = addVersion(fixture, "2.0.0", "name");
  const pullRequestTree = createReviewTree(fixture, "131584", "2.0.0");
  assert.equal(runSetup(fixture, { pinRoot: pullRequestTree }).status, 0);
  assertPrepared(fixture, updatedHead, "name");

  writeFileSync(join(fixture.source, "dirty.txt"), "dirty\n");
  renameSync(fixture.remote, `${fixture.remote}.offline`);
  const retarget = runSetup(fixture);
  assert.equal(retarget.status, 0, retarget.stderr);
  assert.equal(retarget.fetchCount, 0);
  assertPrepared(fixture, fixture.initialHead, "path");
});

test("fetches a missing changed pin exactly once and checks out its peeled commit", (t) => {
  const fixture = useFixture(t);
  assert.equal(runSetup(fixture).status, 0);
  const updatedHead = addVersion(fixture, "2.0.0", "name");
  const pullRequestTree = createReviewTree(fixture, "131584", "2.0.0");

  const retarget = runSetup(fixture, { pinRoot: pullRequestTree });
  assert.equal(retarget.status, 0, retarget.stderr);
  assert.equal(retarget.fetchCount, 1);
  assertPrepared(fixture, updatedHead, "name");
});

test("rebuilds an existing tag whose object graph is incomplete", (t) => {
  const fixture = useFixture(t);
  assert.equal(runSetup(fixture).status, 0);
  const commit = git(fixture.remote, ["cat-file", "commit", fixture.initialHead]);
  rmSync(fixture.cache, { force: true, recursive: true });
  git(fixture.root, ["init", "--bare", "--quiet", fixture.cache]);
  git(fixture.cache, ["remote", "add", "origin", fixture.remote]);
  const recreatedHead = execFileSync(
    realGit,
    ["-C", fixture.cache, "hash-object", "-t", "commit", "-w", "--stdin"],
    { encoding: "utf8", input: `${commit}\n` },
  ).trim();
  assert.equal(recreatedHead, fixture.initialHead);
  git(fixture.cache, ["update-ref", "refs/tags/rust-v1.2.3", recreatedHead]);
  rmSync(fixture.source, { force: true, recursive: true });

  const recovered = runSetup(fixture);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.fetchCount, 1);
  assertPrepared(fixture, fixture.initialHead, "path");
});

test("fails closed when a missing changed pin cannot be fetched", (t) => {
  const fixture = useFixture(t);
  assert.equal(runSetup(fixture).status, 0);
  const pullRequestTree = createReviewTree(fixture, "131584", "2.0.0");
  renameSync(fixture.remote, `${fixture.remote}.offline`);

  const missing = runSetup(fixture, { pinRoot: pullRequestTree });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.fetchCount, 1);
  assert.doesNotMatch(missing.stdout, /Prepared Codex/u);
  assertPrepared(fixture, fixture.initialHead, "path");
});

test("fails closed when an incomplete requested pin cannot be rebuilt", (t) => {
  const fixture = useFixture(t);
  assert.equal(runSetup(fixture).status, 0);
  const commit = git(fixture.remote, ["cat-file", "commit", fixture.initialHead]);
  rmSync(fixture.cache, { force: true, recursive: true });
  git(fixture.root, ["init", "--bare", "--quiet", fixture.cache]);
  git(fixture.cache, ["remote", "add", "origin", fixture.remote]);
  execFileSync(realGit, ["-C", fixture.cache, "hash-object", "-t", "commit", "-w", "--stdin"], {
    input: `${commit}\n`,
  });
  git(fixture.cache, ["update-ref", "refs/tags/rust-v1.2.3", fixture.initialHead]);
  renameSync(fixture.remote, `${fixture.remote}.offline`);

  const incomplete = runSetup(fixture);
  assert.notEqual(incomplete.status, 0);
  assert.equal(incomplete.fetchCount, 1);
  assert.doesNotMatch(incomplete.stdout, /Prepared Codex/u);
  assertPrepared(fixture, fixture.initialHead, "path");
});

test("rejects nonnumeric review trees and escaped pin manifests", (t) => {
  const fixture = useFixture(t);
  const invalidTree = createReviewTree(fixture, "not-a-pr", "1.2.3");
  const invalidTreeResult = runSetup(fixture, { pinRoot: invalidTree });
  assert.notEqual(invalidTreeResult.status, 0);
  assert.match(invalidTreeResult.stderr, /version pin must come from/u);

  const pullRequestTree = createReviewTree(fixture, "131584", "1.2.3");
  const pullRequestManifest = join(pullRequestTree, "extensions", "codex", "package.json");
  rmSync(pullRequestManifest);
  symlinkSync(join(fixture.target, "extensions", "codex", "package.json"), pullRequestManifest);
  const escapedPinResult = runSetup(fixture, { pinRoot: pullRequestTree });
  assert.notEqual(escapedPinResult.status, 0);
  assert.match(escapedPinResult.stderr, /regular file|stay inside/u);
});
