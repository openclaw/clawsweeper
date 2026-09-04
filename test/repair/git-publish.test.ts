import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishMainCommit, runGit } from "../../dist/repair/git-publish.js";

test("remaining git publisher performs one ordinary push without lease refs or rebuild recovery", () => {
  const source = fs.readFileSync("src/repair/git-publish.ts", "utf8");
  assert.doesNotMatch(source, /clawsweeper-publish-lease|force-with-lease|--deepen|--unshallow/);
  assert.doesNotMatch(source, /rebuildPublishCommit|rebuildReconciliationCommit|commit_refs/);
  assert.match(source, /acquireStateWriterCoordinator/);
  assert.match(source, /\["push", remote, `HEAD:\$\{branch\}`\]/);
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
    assert.equal(runGit(["show", "origin/state:results/status.json"], { quiet: true }), "{}\n");
  } finally {
    process.chdir(previous);
    if (previousStateDir === undefined) delete process.env.CLAWSWEEPER_STATE_DIR;
    else process.env.CLAWSWEEPER_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
