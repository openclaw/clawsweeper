import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hydrateState } from "../../scripts/hydrate-state.ts";

import { publishMainCommit } from "../../dist/repair/git-publish.js";
import { runGit } from "../../dist/repair/git.js";

const identity = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// A state remote with one seed commit on `state`, a state checkout for the publisher, and a
// source tree holding the file to publish.
function stateFixture(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const state = path.join(root, "state");
  const source = path.join(root, "source");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["clone", remote, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(["add", "README.md"], seed);
  git([...identity, "commit", "-m", "seed"], seed);
  git(["push", "origin", "HEAD:state"], seed);
  execFileSync("git", ["clone", "--branch", "state", remote, state]);
  fs.mkdirSync(path.join(source, "results"), { recursive: true });
  fs.writeFileSync(path.join(source, "results/status.json"), "{}\n");
  return { root, remote, seed, state, source };
}

function publishFrom(source: string, state: string, env: NodeJS.ProcessEnv = {}) {
  const previous = process.cwd();
  const previousEnv = { ...process.env };
  try {
    process.chdir(source);
    Object.assign(process.env, { CLAWSWEEPER_STATE_DIR: state }, env);
    return publishMainCommit({
      message: "chore: publish operational state",
      paths: ["results/status.json"],
      branch: "state",
    });
  } finally {
    process.chdir(previous);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

test("a stale state publisher never overwrites a concurrent writer's commit", () => {
  const fixture = stateFixture("clawsweeper-git-publish-race-");
  try {
    // Another writer lands on the remote after this publisher fetched, before it pushes.
    const hooks = path.join(fixture.root, "hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(
      path.join(hooks, "post-checkout"),
      [
        "#!/bin/sh",
        `[ -f "${fixture.root}/raced" ] && exit 0`,
        `touch "${fixture.root}/raced"`,
        "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE",
        `cd "${fixture.seed}"`,
        "echo concurrent > concurrent.txt",
        "git add concurrent.txt",
        `git ${identity.join(" ")} commit -q -m concurrent`,
        "git push -q origin HEAD:state",
      ].join("\n"),
      { mode: 0o755 },
    );
    git(["config", "core.hooksPath", hooks], fixture.state);
    const refsBefore = git(["for-each-ref", "--format=%(refname)"], fixture.remote);

    assert.throws(() => publishFrom(fixture.source, fixture.state), /rejected/);

    const concurrent = git(["rev-parse", "HEAD"], fixture.seed);
    assert.equal(git(["rev-parse", "state"], fixture.remote), concurrent);
    // Publication leaves no side refs (leases or rebuild markers) on the state remote.
    assert.equal(git(["for-each-ref", "--format=%(refname)"], fixture.remote), refsBefore);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an enabled state writer coordinator gates publication before any push", () => {
  const fixture = stateFixture("clawsweeper-git-publish-coordinator-");
  try {
    const before = git(["rev-parse", "state"], fixture.remote);
    assert.throws(
      () =>
        publishFrom(fixture.source, fixture.state, {
          CLAWSWEEPER_STATE_COORDINATOR_ENABLED: "1",
          CLAWSWEEPER_STATE_COORDINATOR_URL: "",
          QUEUE_URL: "",
        }),
      /coordinator URL is required/,
    );
    assert.equal(git(["rev-parse", "state"], fixture.remote), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("remaining git publisher commits an operational path to the requested branch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-git-publish-"));
  const remote = path.join(root, "remote.git");
  const checkout = path.join(root, "checkout");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["clone", remote, checkout]);
  fs.writeFileSync(path.join(checkout, "README.md"), "seed\n");
  execFileSync("git", ["add", "README.md"], { cwd: checkout });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "seed"],
    { cwd: checkout },
  );
  execFileSync("git", ["push", "origin", "HEAD:state"], { cwd: checkout });
  fs.mkdirSync(path.join(checkout, "results"));
  fs.writeFileSync(path.join(checkout, "results/status.json"), "{}\n");

  const previous = process.cwd();
  const previousStateDir = process.env.CLAWSWEEPER_STATE_DIR;
  try {
    process.chdir(checkout);
    delete process.env.CLAWSWEEPER_STATE_DIR;
    assert.equal(
      publishMainCommit({
        message: "chore: publish operational state",
        paths: ["results/status.json"],
        branch: "state",
      }),
      "committed",
    );
    assert.equal(runGit(["show", "origin/state:results/status.json"], { cwd: checkout }), "{}\n");
  } finally {
    process.chdir(previous);
    if (previousStateDir === undefined) delete process.env.CLAWSWEEPER_STATE_DIR;
    else process.env.CLAWSWEEPER_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("built source stays pinned while publication refreshes only the separate state repository", async () => {
  const fixture = stateFixture("clawsweeper-source-generation-");
  try {
    const sourceRemote = path.join(fixture.root, "source.git");
    const sourceWriter = path.join(fixture.root, "source-writer");
    const oldCheckout = path.join(fixture.root, "old-checkout");
    git(["init", "--bare", sourceRemote], fixture.root);
    git(["init", "-b", "main"], fixture.source);
    git(["remote", "add", "origin", sourceRemote], fixture.source);
    fs.writeFileSync(path.join(fixture.source, ".gitignore"), "dist/\nnode_modules/\nresults/\n");
    const writeGeneration = (checkout: string, generation: string) => {
      fs.writeFileSync(
        path.join(checkout, "package.json"),
        JSON.stringify({ type: "module", generation }),
      );
      fs.writeFileSync(path.join(checkout, "runtime.txt"), generation);
    };
    writeGeneration(fixture.source, "A");
    git(["add", "."], fixture.source);
    git([...identity, "commit", "-m", "source A"], fixture.source);
    git(["push", "-u", "origin", "main"], fixture.source);
    const sourceA = git(["rev-parse", "HEAD"], fixture.source);
    git(["clone", "--branch", "main", sourceRemote, oldCheckout], fixture.root);
    git(["clone", "--branch", "main", sourceRemote, sourceWriter], fixture.root);

    fs.mkdirSync(path.join(fixture.seed, "results"));
    fs.writeFileSync(path.join(fixture.seed, "results/status.json"), '{"phase":"hydrated"}\n');
    git(["add", "results"], fixture.seed);
    git([...identity, "commit", "-m", "operational state"], fixture.seed);
    git(["push", "origin", "HEAD:state"], fixture.seed);
    git(["fetch", "origin", "state"], fixture.state);
    git(["checkout", "--detach", "FETCH_HEAD"], fixture.state);

    // Both cases hydrate and build A before either independent remote advances.
    // The fixture entry point uses real Node package/dependency resolution.
    for (const checkout of [fixture.source, oldCheckout]) {
      let workerRequests = 0;
      await hydrateState(
        [
          "--state-dir",
          fixture.state,
          "--worktree",
          checkout,
          "--skip-records",
          "--skip-state-blobs",
        ],
        {},
        (async () => {
          workerRequests += 1;
          throw new Error("Git-only fixture must not contact the Worker");
        }) as typeof fetch,
      );
      assert.equal(workerRequests, 0);
      fs.mkdirSync(path.join(checkout, "dist"));
      fs.mkdirSync(path.join(checkout, "node_modules/fixture-dependency"), { recursive: true });
      fs.writeFileSync(
        path.join(checkout, "node_modules/fixture-dependency/package.json"),
        '{"type":"module","exports":"./index.js"}',
      );
      fs.writeFileSync(
        path.join(checkout, "node_modules/fixture-dependency/index.js"),
        'export default "A";\n',
      );
      fs.writeFileSync(
        path.join(checkout, "dist/generation.mjs"),
        [
          'import { readFileSync } from "node:fs";',
          'import dependency from "fixture-dependency";',
          'const compiled = "A";',
          'const facts = { compiled, dependency, source: readFileSync("runtime.txt", "utf8"), package: JSON.parse(readFileSync("package.json", "utf8")).generation };',
          "console.log(JSON.stringify(facts));",
          "if (Object.values(facts).some((value) => value !== compiled)) process.exitCode = 1;",
        ].join("\n"),
      );
    }
    writeGeneration(sourceWriter, "B");
    git(["add", "."], sourceWriter);
    git([...identity, "commit", "-m", "source B"], sourceWriter);
    git(["push", "origin", "main"], sourceWriter);
    const sourceB = git(["rev-parse", "HEAD"], sourceWriter);
    fs.writeFileSync(path.join(fixture.seed, "concurrent.txt"), "concurrent state\n");
    git(["add", "concurrent.txt"], fixture.seed);
    git([...identity, "commit", "-m", "concurrent state"], fixture.seed);
    git(["push", "origin", "HEAD:state"], fixture.seed);

    const observe = (checkout: string) =>
      spawnSync(process.execPath, ["dist/generation.mjs"], {
        cwd: checkout,
        encoding: "utf8",
      });
    git(["pull", "--rebase", "--autostash"], oldCheckout);
    const mixed = observe(oldCheckout);
    assert.equal(mixed.status, 1, mixed.stderr);
    assert.equal(git(["rev-parse", "HEAD"], oldCheckout), sourceB);
    assert.deepEqual(JSON.parse(mixed.stdout), {
      compiled: "A",
      dependency: "A",
      source: "B",
      package: "B",
    });
    assert.equal(
      fs.readFileSync(path.join(oldCheckout, "results/status.json"), "utf8"),
      '{"phase":"hydrated"}\n',
    );

    const before = observe(fixture.source);
    assert.equal(before.status, 0, before.stderr);
    assert.deepEqual(JSON.parse(before.stdout), {
      compiled: "A",
      dependency: "A",
      source: "A",
      package: "A",
    });
    assert.equal(
      fs.readFileSync(path.join(fixture.source, "results/status.json"), "utf8"),
      '{"phase":"hydrated"}\n',
    );
    fs.writeFileSync(path.join(fixture.source, "results/status.json"), '{"phase":"published"}\n');
    assert.equal(
      publishFrom(fixture.source, fixture.state, { CLAWSWEEPER_STATE_COORDINATOR_ENABLED: "0" }),
      "committed",
    );
    assert.equal(git(["show", "state:concurrent.txt"], fixture.remote), "concurrent state");
    assert.equal(
      git(["show", "state:results/status.json"], fixture.remote),
      '{"phase":"published"}',
    );
    assert.equal(git(["rev-parse", "HEAD"], fixture.source), sourceA);
    assert.equal(git(["rev-parse", "origin/main"], fixture.source), sourceA);
    assert.equal(git(["rev-parse", "main"], sourceRemote), sourceB);
    const after = observe(fixture.source);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before.stdout);
    assert.equal(
      fs.readFileSync(path.join(fixture.source, "results/status.json"), "utf8"),
      '{"phase":"published"}\n',
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
