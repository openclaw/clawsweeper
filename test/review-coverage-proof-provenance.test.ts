import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureProofSource,
  proofEnvironment,
} from "../docs/proof/ui-live-coverage/proof-provenance.mjs";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "coverage-proof-provenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic proof fixture");
  git("config", "user.email", "fixture@example.invalid");
  const put = (path: string, value: string) => writeFileSync(join(root, path), value);
  const commit = () => {
    git("add", "-A");
    git("commit", "-qm", "Synthetic source binding fixture");
  };
  put(".gitignore", "private/\nnode_modules/\n.openclaw/\n.artifacts/\n");
  for (const name of ["first", "second", "stable", "gone"]) put(name + ".txt", "base " + name);
  commit();
  const base = git("rev-parse", "HEAD");
  put("first.txt", "first committed change");
  rmSync(join(root, "gone.txt"));
  commit();
  put("second.txt", "second committed change");
  commit();
  return { root, git, put, base };
}

test("clean committed proof binds the entire pinned range and whole HEAD tree, not only dirty/last commit", (t) => {
  const f = fixture(t),
    source = captureProofSource(f.root, f.base);
  assert.equal(source.head, f.git("rev-parse", "HEAD"));
  assert.equal(source.head_tree, f.git("rev-parse", "HEAD^{tree}"));
  assert.equal(source.merge_base, f.base);
  assert.equal(source.committed_range, f.base + ".." + source.head);
  assert.deepEqual(source.committed_files, ["first.txt", "gone.txt", "second.txt"]);
  assert.deepEqual(source.dirty_files, []);
  assert.deepEqual(source.untracked_files, []);
  assert.deepEqual(source.files, {
    "first.txt": hash("first committed change"),
    "gone.txt": null,
    "second.txt": hash("second committed change"),
  });
  const manifest = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    cwd: f.root,
  });
  assert.deepEqual(source.whole_committed_tree, {
    git_tree: source.head_tree,
    manifest_sha256: hash(manifest),
    entries: 4,
  });
  assert.equal(source.source_tree_digest, hash(JSON.stringify(source.files)));
});

test("proof overlays staged/unstaged/untracked reviewed bytes and deletions without hashing ignored scratch", (t) => {
  const f = fixture(t);
  f.put("first.txt", "unstaged reviewed bytes");
  f.put("second.txt", "staged reviewed bytes");
  f.git("add", "second.txt");
  rmSync(join(f.root, "stable.txt"));
  const newName = "new reviewed\nfile.txt";
  f.put(newName, "new source");
  for (const dir of ["private", "node_modules", ".openclaw", ".artifacts"]) {
    mkdirSync(join(f.root, dir));
    f.put(dir + "/excluded.txt", "synthetic ignored content");
  }
  const source = captureProofSource(f.root, f.base);
  assert.equal(source.files["first.txt"], hash("unstaged reviewed bytes"));
  assert.equal(source.files["second.txt"], hash("staged reviewed bytes"));
  assert.equal(source.files["stable.txt"], null);
  assert.equal(source.files["gone.txt"], null);
  assert.equal(source.files[newName], hash("new source"));
  assert.deepEqual(source.untracked_files, [newName]);
  assert.deepEqual(source.dirty_files, ["first.txt", "second.txt", "stable.txt"]);
  assert.equal(
    Object.keys(source.files).some((p) => p.includes("excluded")),
    false,
  );
  assert.match(source.patch_scope, /untracked bytes\/deletions separately bound/);
});

test("proof hashes link identity rather than following changed/untracked symlinks outside the checkout", (t) => {
  if (process.platform === "win32")
    return t.skip("Symlink privileges are not guaranteed on Windows");
  const f = fixture(t);
  symlinkSync(process.execPath, join(f.root, "external-link"));
  symlinkSync("nonexistent-target", join(f.root, "broken-link"));
  const source = captureProofSource(f.root, f.base);
  assert.equal(source.files["external-link"], hash(process.execPath));
  assert.equal(source.files["broken-link"], hash("nonexistent-target"));
});

test("proof refuses file reads through a changed parent directory symlink outside checkout", (t) => {
  if (process.platform === "win32")
    return t.skip("Symlink privileges are not guaranteed on Windows");
  const f = fixture(t);
  mkdirSync(join(f.root, "nested"));
  f.put("nested/file.txt", "tracked source");
  f.git("add", "nested/file.txt");
  f.git("commit", "-qm", "Synthetic parent-link fixture");
  const external = mkdtempSync(join(tmpdir(), "coverage-proof-external-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(join(external, "file.txt"), "synthetic outside content must not be hashed");
  rmSync(join(f.root, "nested"), { recursive: true });
  symlinkSync(external, join(f.root, "nested"));
  assert.throws(() => captureProofSource(f.root, f.base), /outside checkout/);
});

test("proof source requires an existing pinned full base commit", (t) => {
  const f = fixture(t);
  assert.throws(() => captureProofSource(f.root, "HEAD"), /pinned full commit/);
  assert.throws(() => captureProofSource(f.root, "0".repeat(40)));
});

test("host support is explicit and supplied container metadata never claims containment verification", () => {
  assert.throws(() => proofEnvironment([], {}), /explicitly use --host-supporting/);
  const supplied = {
    CRABBOX_PROOF_PROVIDER: "local-container",
    CRABBOX_PROOF_LEASE: "cbx_fixture",
    CRABBOX_PROOF_IMAGE: "synthetic-image@sha256:fixture",
  };
  const container = proofEnvironment([], supplied);
  assert.equal(container.provider, "local-container");
  assert.equal(container.lease, "cbx_fixture");
  assert.equal(container.image, supplied.CRABBOX_PROOF_IMAGE);
  assert.equal(container.containment_verified_by_script, false);
  assert.match(container.qualification, /declared-local-container/);
  assert.match(container.containment_evidence, /external Crabbox wrapper\/runtime receipt/);
  const host = proofEnvironment(["--host-supporting"], supplied);
  assert.equal(host.provider, "host");
  assert.equal(host.lease, null);
  assert.equal(host.containment_verified_by_script, false);
  for (const bad of [
    { ...supplied, CRABBOX_PROOF_PROVIDER: "aws" },
    { ...supplied, CRABBOX_PROOF_LEASE: "" },
    { ...supplied, CRABBOX_PROOF_IMAGE: "" },
  ])
    assert.throws(() => proofEnvironment([], bad));
});

test("all three current proof entrypoints use the shared explicit environment and full-range source binding", () => {
  for (const file of ["run-proof.mjs", "refresh-cadence-proof.mjs", "post-producer-replay.mjs"]) {
    const source = readFileSync("docs/proof/ui-live-coverage/" + file, "utf8");
    assert.match(source, /const environment = proofEnvironment\(\)/);
    assert.match(source, /\.\.\.captureProofSource\(root(?:, base)?\)/);
    assert.match(source, /\.\.\.environment/);
    assert.doesNotMatch(source, /qualification: "supporting host/);
  }
});
