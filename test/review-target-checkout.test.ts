import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(process.cwd(), "scripts/review-target-checkout.sh");
const realGit = execFileSync("/usr/bin/env", ["which", "git"], { encoding: "utf8" }).trim();

function git(cwd: string, args: string[]): string {
  return execFileSync(realGit, args, { cwd, encoding: "utf8" }).trim();
}

function commit(remote: string, file: string, content: string, message: string): string {
  mkdirSync(join(remote, "dir"), { recursive: true });
  writeFileSync(join(remote, file), content);
  git(remote, ["add", "-A"]);
  git(remote, ["commit", "--quiet", "-m", message]);
  return git(remote, ["rev-parse", "HEAD"]);
}

function createFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-target-checkout-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const remote = join(root, "remote");
  const workspace = join(root, "workspace");
  mkdirSync(remote, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  git(remote, ["init", "--quiet", "--initial-branch=main"]);
  for (const [key, value] of [
    ["user.name", "ClawSweeper test"],
    ["user.email", "clawsweeper@example.invalid"],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    // Serve partial-clone fetches and by-id blob fetches like GitHub does.
    ["uploadpack.allowFilter", "true"],
    ["uploadpack.allowAnySHA1InWant", "true"],
  ]) {
    git(remote, ["config", key, value]);
  }
  commit(remote, "README.md", "one\n", "first");
  commit(remote, "dir/a.txt", "a\n", "second");
  git(remote, ["tag", "-a", "v1.0.0", "-m", "release one"]);
  return {
    root,
    remote,
    url: `file://${remote}`,
    workspace,
    cache: join(workspace, "target-cache.git"),
    output: join(root, "github-output"),
  };
}

type Fixture = ReturnType<typeof createFixture>;

function runCheckout(
  fixture: Fixture,
  checkoutName: string,
  options: { branch?: string; env?: NodeJS.ProcessEnv } = {},
) {
  writeFileSync(fixture.output, "");
  const result = spawnSync(
    "bash",
    [
      script,
      fixture.url,
      fixture.cache,
      join(fixture.workspace, checkoutName),
      options.branch ?? "main",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: fixture.output, ...options.env },
    },
  );
  return {
    ...result,
    checkout: join(fixture.workspace, checkoutName),
    outputs: readFileSync(fixture.output, "utf8"),
  };
}

function missingTipBlobs(cache: string): string[] {
  return git(cache, ["rev-list", "--objects", "--missing=print", "refs/heads/main^{tree}"])
    .split("\n")
    .filter((line) => line.startsWith("?"));
}

function assertCheckoutAt(fixture: Fixture, checkout: string, head: string): void {
  assert.equal(git(checkout, ["rev-parse", "HEAD"]), head);
  assert.equal(git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  assert.equal(git(checkout, ["rev-parse", "refs/remotes/origin/main"]), head);
  assert.equal(git(checkout, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.equal(git(checkout, ["rev-parse", "--is-shallow-repository"]), "false");
  // Same remote contract as `git clone --filter=blob:none --single-branch`.
  assert.equal(git(checkout, ["config", "remote.origin.url"]), fixture.url);
  assert.equal(git(checkout, ["config", "remote.origin.promisor"]), "true");
  assert.equal(git(checkout, ["config", "remote.origin.partialclonefilter"]), "blob:none");
  assert.equal(
    git(checkout, ["config", "--get-all", "remote.origin.fetch"]),
    "+refs/heads/main:refs/remotes/origin/main",
  );
}

test("cold checkout builds a complete tip cache and a clone-equivalent checkout", (t) => {
  const fixture = createFixture(t);
  const head = git(fixture.remote, ["rev-parse", "HEAD"]);

  const cold = runCheckout(fixture, "target");
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stdout, /mode=cold /);
  assert.equal(cold.outputs, "cache_ready=true\n");
  assertCheckoutAt(fixture, cold.checkout, head);
  assert.equal(git(cold.checkout, ["tag", "--list"]), "v1.0.0");
  assert.equal(git(fixture.cache, ["rev-parse", "--is-bare-repository"]), "true");
  assert.deepEqual(missingTipBlobs(fixture.cache), []);
});

test("warm checkout fetches only the delta and materializes locally from the cache", (t) => {
  const fixture = createFixture(t);
  assert.equal(runCheckout(fixture, "first").status, 0);
  const cachedPacks = readdirSync(join(fixture.cache, "objects", "pack")).filter((name) =>
    name.endsWith(".pack"),
  );
  assert.ok(cachedPacks.length > 0);

  commit(fixture.remote, "dir/b.txt", "b\n", "third");
  git(fixture.remote, ["tag", "-a", "v1.1.0", "-m", "release two"]);
  const head = git(fixture.remote, ["rev-parse", "HEAD"]);

  const warm = runCheckout(fixture, "second");
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /mode=warm missing_tip_blobs=1 cache_ready=true/);
  assert.equal(warm.outputs, "cache_ready=true\n");
  assertCheckoutAt(fixture, warm.checkout, head);
  assert.equal(git(warm.checkout, ["tag", "--list"]), "v1.0.0\nv1.1.0");
  assert.deepEqual(missingTipBlobs(fixture.cache), []);
  // The checkout shares the cached pack files instead of copying or re-downloading them.
  for (const pack of cachedPacks) {
    assert.ok(statSync(join(warm.checkout, ".git", "objects", "pack", pack)).nlink > 1, pack);
  }
});

test("restored cache hooks and local config never apply", (t) => {
  const fixture = createFixture(t);
  assert.equal(runCheckout(fixture, "first").status, 0);
  const marker = join(fixture.root, "hook-ran");
  mkdirSync(join(fixture.cache, "hooks"), { recursive: true });
  writeFileSync(
    join(fixture.cache, "hooks", "reference-transaction"),
    `#!/bin/sh\ntouch '${marker}'\n`,
  );
  chmodSync(join(fixture.cache, "hooks", "reference-transaction"), 0o755);
  git(fixture.cache, ["config", "remote.origin.url", "file:///nonexistent/remote"]);
  git(fixture.cache, ["config", "core.hooksPath", join(fixture.cache, "hooks")]);
  const head = commit(fixture.remote, "dir/c.txt", "c\n", "third");

  const warm = runCheckout(fixture, "second");
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /mode=warm /);
  assertCheckoutAt(fixture, warm.checkout, head);
  assert.equal(existsSync(marker), false);
  assert.equal(git(fixture.cache, ["config", "remote.origin.url"]), fixture.url);
  assert.equal(existsSync(join(fixture.cache, "hooks")), false);
});

test("warm checkout refreshes deleted and retargeted tags even when the branch does not move", (t) => {
  const fixture = createFixture(t);
  const first = git(fixture.remote, ["rev-parse", "HEAD~1"]);
  git(fixture.remote, ["tag", "-a", "moving", "-m", "original target"]);
  git(fixture.remote, ["checkout", "--quiet", "-b", "other", first]);
  commit(fixture.remote, "other.txt", "other\n", "unrelated branch");
  git(fixture.remote, ["tag", "-a", "other-only", "-m", "unrelated tag"]);
  git(fixture.remote, ["checkout", "--quiet", "main"]);
  assert.equal(runCheckout(fixture, "first").status, 0);

  git(fixture.remote, ["tag", "-d", "v1.0.0"]);
  git(fixture.remote, ["tag", "-f", "-a", "moving", first, "-m", "updated target"]);
  git(fixture.remote, ["tag", "-a", "new-at-same-head", "-m", "new tag"]);
  const direct = join(fixture.workspace, "direct");
  git(fixture.workspace, [
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--single-branch",
    "--branch",
    "main",
    fixture.url,
    direct,
  ]);

  const warm = runCheckout(fixture, "second");
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /mode=warm /);
  assertCheckoutAt(fixture, warm.checkout, git(fixture.remote, ["rev-parse", "HEAD"]));
  const tagRefs = ["for-each-ref", "--format=%(refname) %(objectname)", "refs/tags/"];
  assert.equal(git(warm.checkout, tagRefs), git(direct, tagRefs));
  assert.equal(git(warm.checkout, ["tag", "--list"]), "moving\nnew-at-same-head");
});

test("a rewound branch rebuilds the cache without tags from its old history", (t) => {
  const fixture = createFixture(t);
  const first = git(fixture.remote, ["rev-parse", "HEAD~1"]);
  assert.equal(runCheckout(fixture, "first").status, 0);
  git(fixture.remote, ["branch", "retained-old-main"]);
  git(fixture.remote, ["tag", "-a", "old-history", "-m", "old branch tip"]);
  git(fixture.remote, ["update-ref", "refs/heads/main", first]);

  const direct = join(fixture.workspace, "direct");
  git(fixture.workspace, [
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--single-branch",
    "--branch",
    "main",
    fixture.url,
    direct,
  ]);
  const warm = runCheckout(fixture, "second");
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /mode=rebuilt /);
  assertCheckoutAt(fixture, warm.checkout, first);
  const tagRefs = ["for-each-ref", "--format=%(refname) %(objectname)", "refs/tags/"];
  assert.equal(git(warm.checkout, tagRefs), git(direct, tagRefs));
  assert.equal(git(warm.checkout, ["tag", "--list"]), "");
});

function gitShim(fixture: Fixture, failWhenArgument: string): NodeJS.ProcessEnv {
  const bin = join(fixture.root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env bash\nfor arg in "$@"; do\n  if [[ "$arg" == "${failWhenArgument}" ]]; then exit 1; fi\ndone\nexec "$REAL_GIT" "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, REAL_GIT: realGit };
}

test("failed cache update fetch rebuilds the cache", (t) => {
  const fixture = createFixture(t);
  assert.equal(runCheckout(fixture, "first").status, 0);
  const head = commit(fixture.remote, "dir/d.txt", "d\n", "third");

  const rebuilt = runCheckout(fixture, "second", {
    env: gitShim(fixture, "+refs/heads/main:refs/heads/main"),
  });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.match(rebuilt.stdout, /Cached target repository cannot be refreshed incrementally/);
  assert.match(rebuilt.stdout, /mode=rebuilt /);
  assert.equal(rebuilt.outputs, "cache_ready=true\n");
  assertCheckoutAt(fixture, rebuilt.checkout, head);
  assert.deepEqual(missingTipBlobs(fixture.cache), []);
});

test("failed local materialization falls back to a clean clone and skips the cache save", (t) => {
  const fixture = createFixture(t);
  const head = git(fixture.remote, ["rev-parse", "HEAD"]);

  const fallback = runCheckout(fixture, "target", { env: gitShim(fixture, "--no-checkout") });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /Cached target checkout failed; retrying without cache reference/);
  assert.match(fallback.stdout, /mode=fallback /);
  assert.equal(fallback.outputs, "cache_ready=false\n");
  assert.equal(existsSync(fixture.cache), false);
  assertCheckoutAt(fixture, fallback.checkout, head);
});

test("rejects option-shaped or traversal branch names before running Git", (t) => {
  const fixture = createFixture(t);
  for (const branch of ["--upload-pack=touch", "main..other", "main branch"]) {
    const result = runCheckout(fixture, "target", { branch });
    assert.equal(result.status, 1, branch);
    assert.match(result.stderr, /Unsafe target branch/);
    assert.equal(existsSync(fixture.cache), false);
  }
});
