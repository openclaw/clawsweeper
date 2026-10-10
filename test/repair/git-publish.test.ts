import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
