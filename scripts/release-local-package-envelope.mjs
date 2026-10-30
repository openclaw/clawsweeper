#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const names = ["clawsweeper-local.tgz", "manifest.json", "package-lock.json", "package.json"];
const payloadNames = names.filter((name) => name !== "manifest.json");
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
delete env.TAR_OPTIONS;
delete env.GZIP;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}

function snapshot(input) {
  assert.ok(lstatSync(input).isDirectory(), "envelope input must be a real directory");
  assert.deepEqual(readdirSync(input).sort(), names, "envelope must contain exactly four files");
  return new Map(
    names.map((name) => {
      const path = join(input, name);
      const stat = lstatSync(path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `not a regular input file: ${name}`);
      assert.ok(stat.size > 0 && stat.size < 2 ** 31, `invalid input size: ${name}`);
      return [name, readFileSync(path)];
    }),
  );
}

function sourceIdentity() {
  assert.equal(run("git", ["status", "--porcelain"]).trim(), "", "release checkout must be clean");
  return {
    source: run("git", ["rev-parse", "HEAD"]).trim(),
    sourceTree: run("git", ["rev-parse", "HEAD^{tree}"]).trim(),
    sourceDiffSha256: hash(
      run("git", ["diff", "HEAD", "--binary", "--full-index", "--no-ext-diff", "--no-textconv"]),
    ),
  };
}

function validate(files, identity) {
  const manifest = JSON.parse(files.get("manifest.json"));
  for (const [field, value] of Object.entries(identity))
    assert.equal(manifest[field], value, `envelope ${field} differs from frozen release checkout`);
  assert.equal(manifest.platform, "linux", "release input must be the canonical Linux envelope");
  assert.deepEqual(manifest.files.map(({ path }) => path).sort(), payloadNames);
  for (const file of manifest.files) {
    const bytes = files.get(file.path);
    assert.equal(bytes.length, file.bytes, `envelope input size mismatch: ${file.path}`);
    assert.equal(hash(bytes), file.sha256, `envelope input hash mismatch: ${file.path}`);
  }
  const sourcePackage = JSON.parse(readFileSync("package.json", "utf8"));
  const metadata = JSON.parse(files.get("package.json"));
  const lock = JSON.parse(files.get("package-lock.json"));
  assert.equal(metadata.private, true);
  assert.equal(metadata.name, "clawsweeper-local-install");
  assert.deepEqual(metadata.dependencies, { [sourcePackage.name]: "file:clawsweeper-local.tgz" });
  assert.equal(metadata.scripts, undefined);
  assert.equal(metadata.devDependencies, undefined);
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, metadata.name);
  assert.equal(lock.packages[""].name, metadata.name);
  assert.deepEqual(lock.packages[""].dependencies, metadata.dependencies);
  const localPath = `node_modules/${sourcePackage.name}`;
  const local = lock.packages[localPath];
  assert.equal(local.version, sourcePackage.version);
  assert.equal(local.resolved, "file:clawsweeper-local.tgz");
  assert.equal(
    local.integrity,
    `sha512-${createHash("sha512").update(files.get("clawsweeper-local.tgz")).digest("base64")}`,
  );
  const resolution = Object.entries(lock.packages)
    .filter(([path]) => path !== "")
    .map(([path, entry]) => {
      assert.ok(
        /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path),
        "invalid lock package path",
      );
      assert.ok(
        !path.split("/").some((part) => part === "." || part === ".."),
        "lock path escapes envelope",
      );
      assert.equal(entry.link, undefined);
      assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
      if (path !== localPath) {
        const url = new URL(entry.resolved);
        assert.equal(url.protocol, "https:");
        assert.equal(url.host, "registry.npmjs.org");
        assert.equal(url.username + url.password + url.search + url.hash, "");
      }
      return { path, version: entry.version, resolved: entry.resolved, integrity: entry.integrity };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(resolution, manifest.resolution, "lock differs from qualified resolution");
}

let temporary;
let output;
let createdOutput = false;
try {
  const [artifactId, ...extra] = process.argv.slice(2);
  assert.ok(
    extra.length === 0 &&
      /^[1-9][0-9]*$/.test(artifactId) &&
      Number.isSafeInteger(Number(artifactId)),
    "expected one positive safe artifact ID",
  );
  assert.ok(
    process.env.RELEASE_ASSET_INPUT_DIR && process.env.RELEASE_ASSET_PATH,
    "shared generated input/output paths are required",
  );
  const input = resolve(process.env.RELEASE_ASSET_INPUT_DIR);
  output = resolve(process.env.RELEASE_ASSET_PATH);
  assert.ok(
    output !== input && !output.startsWith(input + sep),
    "output must be separate from input",
  );
  assert.ok(lstatSync(dirname(output)).isDirectory(), "output parent must be a real directory");
  assert.equal(
    realpathSync(dirname(output)),
    dirname(output),
    "output parent must not traverse a symlink",
  );
  const before = snapshot(input);
  const identity = sourceIdentity();
  validate(before, identity);
  assert.match(run("tar", ["--version"]), /tar \(GNU tar\)/, "GNU tar is required");
  assert.match(run("gzip", ["--version"]), /gzip [0-9]/, "GNU gzip is required");
  temporary = mkdtempSync(join(dirname(output), ".envelope-"));
  const archive = join(temporary, "envelope.tar");
  // Only four fixed regular files enter ustar. Normalize metadata; do not
  // rebuild the npm package or replace the lock that the three consumers used.
  run("tar", [
    "--create",
    "--format=ustar",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mode=0644",
    "--file",
    archive,
    "--directory",
    input,
    "--",
    ...names,
  ]);
  const fd = openSync(output, "wx", 0o644);
  createdOutput = true;
  try {
    run("gzip", ["-n", "-9", "--stdout", archive], { stdio: ["ignore", fd, "pipe"] });
  } finally {
    closeSync(fd);
  }
  assert.deepEqual(snapshot(input), before, "packaging changed the qualified envelope");
  assert.deepEqual(sourceIdentity(), identity, "release checkout changed during packaging");
  console.log(
    JSON.stringify({
      artifactId,
      ...identity,
      bytes: lstatSync(output).size,
      sha256: hash(readFileSync(output)),
    }),
  );
} catch (error) {
  if (createdOutput) rmSync(output);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true });
}
