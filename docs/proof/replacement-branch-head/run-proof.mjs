import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  materializeTargetCommitWithIsolation,
  switchTargetBranchWithPlumbing,
} from "../../../dist/repair/target-validation.js";

const root = resolve(import.meta.dirname, "../../..");
const sourcePath = "src/repair/execute-fix-artifact.ts";
const env = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function checkoutFunction(text, materialize = materializeTargetCommitWithIsolation) {
  const start = text.indexOf("function checkoutRecoverableReplacementBranch(");
  const end = text.indexOf("function commitCheckpointIfNeeded(", start);
  assert.ok(start >= 0 && end > start);
  const code = stripTypeScriptTypes(text.slice(start, end));
  // Execute the production control flow with real Git owners; only remote-PR discovery is absent.
  return new Function("run", "materializeTargetCommitWithIsolation", "switchTargetBranchWithPlumbing", "shouldSeedReplacementBranchFromSource", "trustedRemoteBranchSha", "result", "targetValidationTimeoutMs", `${code}; return checkoutRecoverableReplacementBranch;`)(
    (command, args, options) => { assert.equal(command, "git"); return git(options.cwd, ...args); },
    materialize, switchTargetBranchWithPlumbing, () => false, () => "", { repo: "openclaw/clawsweeper" }, 30000,
  );
}

function fixture(parent, name) {
  const dir = join(parent, name); mkdirSync(dir);
  const origin = join(dir, "origin.git"); const writer = join(dir, "writer"); const target = join(dir, "target");
  git(dir, "init", "--bare", "--initial-branch=main", origin);
  git(dir, "clone", origin, writer);
  git(writer, "config", "user.name", "Synthetic fixture");
  git(writer, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(writer, "source.txt"), "base A\n");
  git(writer, "add", "source.txt"); git(writer, "-c", "commit.gpgsign=false", "commit", "-m", "fixture base A");
  git(writer, "push", "origin", "main");
  git(dir, "clone", origin, target);
  git(target, "config", "user.name", "Synthetic fixture");
  git(target, "config", "user.email", "fixture@example.invalid");
  const oldHead = git(target, "rev-parse", "HEAD");
  writeFileSync(join(writer, "source.txt"), "base B\n");
  git(writer, "add", "source.txt"); git(writer, "-c", "commit.gpgsign=false", "commit", "-m", "fixture base B");
  git(writer, "push", "origin", "main");
  git(target, "fetch", "origin");
  const fetchedHead = git(target, "rev-parse", "origin/main");
  assert.notEqual(oldHead, fetchedHead);
  assert.equal(git(target, "rev-parse", "HEAD"), oldHead);
  return { target, oldHead, fetchedHead };
}

export function runReplacementBranchProof(base) {
  const scratch = mkdtempSync(join(tmpdir(), "replacement-branch-proof-"));
  const candidate = readFileSync(join(root, "dist/repair/execute-fix-artifact.js"), "utf8");
  const branch = "clawsweeper/synthetic-replacement";
  const options = targetDir => ({ targetDir, branch, baseBranch: "main", fixArtifact: {} });
  const observations = {};
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const privateConfig = join(scratch, "global.gitconfig");
  writeFileSync(privateConfig, "", { mode: 0o600 });
  process.env.GIT_CONFIG_GLOBAL = privateConfig;
  try {
    if (base) {
      assert.match(base, /^[0-9a-f]{40}$/);
      const before = git(root, "show", `${base}:${sourcePath}`);
      const f = fixture(scratch, "before");
      assert.throws(() => checkoutFunction(before)(options(f.target)), /target checkout head changed before branch switch/);
      assert.equal(git(f.target, "rev-parse", "HEAD"), f.oldHead);
      observations.baseline = "reproduced head mismatch after fetch";
    }
    const fresh = fixture(scratch, "fresh");
    const result = checkoutFunction(candidate)(options(fresh.target));
    assert.equal(result.resumed, false);
    assert.equal(git(fresh.target, "rev-parse", "HEAD"), fresh.fetchedHead);
    assert.equal(git(fresh.target, "symbolic-ref", "--short", "HEAD"), branch);
    assert.equal(readFileSync(join(fresh.target, "source.txt"), "utf8"), "base B\n");
    assert.equal(git(fresh.target, "status", "--porcelain"), "");
    observations.fresh = "attached replacement to the fetched base with a clean matching tree";
    const dirty = fixture(scratch, "dirty");
    writeFileSync(join(dirty.target, "source.txt"), "uncommitted work\n");
    assert.throws(() => checkoutFunction(candidate)(options(dirty.target)), /cannot materialize target commit over a changed checkout/);
    assert.equal(git(dirty.target, "rev-parse", "HEAD"), dirty.oldHead);
    assert.equal(readFileSync(join(dirty.target, "source.txt"), "utf8"), "uncommitted work\n");
    observations.dirty = "refused and preserved uncommitted source";
    const race = fixture(scratch, "race");
    const racingMaterialize = options => {
      const result = materializeTargetCommitWithIsolation(options);
      git(options.cwd, "update-ref", "HEAD", race.oldHead);
      return result;
    };
    assert.throws(() => checkoutFunction(candidate, racingMaterialize)(options(race.target)), /target checkout head changed before branch switch/);
    observations.race = "retained the final head-drift guard";
    return { runtime: process.version, base: base ?? null, executor_source_sha256: createHash("sha256").update(readFileSync(join(root, sourcePath))).digest("hex"), observations, production_mutations: 0 };
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = runReplacementBranchProof(process.argv[2]);
  mkdirSync(join(root, ".artifacts"), { recursive: true });
  writeFileSync(join(root, ".artifacts/replacement-branch-proof.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
}
