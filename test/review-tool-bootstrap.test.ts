import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  extractTarExecutable,
  darwinAclAllowsUnsafeWriter,
  ensureManagedTruffleHog,
  posixCacheAncestorIsUnsafe,
  reviewToolCacheRoot,
  reviewToolArtifact,
  TRUFFLEHOG_VERSION,
} from "../dist/review-tool-bootstrap.js";

function tarEntry(name: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write(contents.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("0000755\0", 100, "ascii");
  header.write("0", 156, "ascii");
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function allowOtherPrincipalWrites(path: string): void {
  if (process.platform === "darwin") {
    const result = spawnSync(
      "/bin/chmod",
      ["+a", "everyone allow write,delete,append,writeattr,writeextattr,writesecurity,chown", path],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    return;
  }
  if (process.platform !== "win32") {
    chmodSync(path, 0o777);
    return;
  }
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot, "Windows cache-authority tests require SystemRoot");
  const result = spawnSync(
    join(systemRoot, "System32", "icacls.exe"),
    [path, "/grant", "*S-1-1-0:(OI)(CI)F"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

test("review-tool bootstrap rejects dangerous Darwin allow ACLs", () => {
  assert.equal(
    darwinAclAllowsUnsafeWriter(
      "drwx------+ 4 owner staff 128 Aug 31 12:00 cache\n 0: group:everyone deny delete\n",
      "owner",
    ),
    false,
  );
  assert.equal(
    darwinAclAllowsUnsafeWriter(
      "drwx------+ 4 owner staff 128 Aug 31 12:00 cache\n 0: user:other allow read,write,delete\n",
      "owner",
    ),
    true,
  );
  assert.equal(
    darwinAclAllowsUnsafeWriter(
      "drwx------+ 4 owner staff 128 Aug 31 12:00 cache\n 0: user:owner allow read,write,delete\n",
      "owner",
    ),
    false,
  );
  assert.equal(
    darwinAclAllowsUnsafeWriter(
      "drwx------+ 4 owner staff 128 Aug 31 12:00 cache\n unparseable acl entry\n",
      "owner",
    ),
    true,
  );
});

test("review-tool bootstrap rejects ancestors controlled by another POSIX user", () => {
  assert.equal(posixCacheAncestorIsUnsafe(1001, 1000, 0o755), true);
  assert.equal(posixCacheAncestorIsUnsafe(1000, 1000, 0o755), false);
  assert.equal(posixCacheAncestorIsUnsafe(0, 1000, 0o1777), false);
  assert.equal(posixCacheAncestorIsUnsafe(0, 1000, 0o777), true);
});

test("review-tool bootstrap pins the official Windows archive", () => {
  const artifact = reviewToolArtifact("win32", "x64");
  assert.deepEqual(artifact, {
    platform: "win32-x64",
    executable: "trufflehog.exe",
    url: `https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/trufflehog_${TRUFFLEHOG_VERSION}_windows_amd64.tar.gz`,
    sha256: "dc1759892a41d64ee0d46cd5d4391dad7f916f54257154aa1b0732f9c50901b2",
  });
});

test("review-tool bootstrap requires an absolute configured cache root", () => {
  const absolute = resolve("review-tools");
  assert.equal(reviewToolCacheRoot({ CLAWSWEEPER_REVIEW_TOOLS_DIR: absolute }), absolute);
  assert.throws(
    () => reviewToolCacheRoot({ CLAWSWEEPER_REVIEW_TOOLS_DIR: "relative-review-tools" }),
    /must be a safe absolute/,
  );
});

test("review-tool bootstrap extracts only the exact regular executable", () => {
  const executable = Buffer.from("trusted scanner bytes");
  const archive = gzipSync(
    Buffer.concat([
      tarEntry("README.md", Buffer.from("ignored")),
      tarEntry("trufflehog.exe", executable),
      Buffer.alloc(1024),
    ]),
  );
  assert.deepEqual(extractTarExecutable(archive, "trufflehog.exe"), executable);
  assert.throws(() => extractTarExecutable(archive, "other.exe"), /expected executable/);
  const tampered = Buffer.from(archive);
  tampered[0] ^= 0xff;
  assert.throws(() => extractTarExecutable(tampered, "trufflehog.exe"), /decompressed/);
  assert.equal(createHash("sha256").update(executable).digest("hex").length, 64);
});

test("review-tool bootstrap rejects an oversized response before reading its body", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const response = new Response("unread", {
    headers: { "content-length": String(256 * 1024 * 1024 + 1) },
  });
  await assert.rejects(
    ensureManagedTruffleHog({
      timeoutMs: 30_000,
      env: { CLAWSWEEPER_REVIEW_TOOLS_DIR: root },
      fetchImpl: async () => response,
      runtimePlatform: "linux",
      runtimeArch: "x64",
    }),
    /exceeds the archive limit/,
  );
});

test("review-tool bootstrap refuses symlinked managed-cache directories before download", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-tools-"));
  const target = mkdtempSync(join(tmpdir(), "clawsweeper-review-tools-target-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  mkdirSync(root, { recursive: true });
  symlinkSync(target, join(root, "trufflehog"), process.platform === "win32" ? "junction" : "dir");
  let fetched = false;
  await assert.rejects(
    ensureManagedTruffleHog({
      timeoutMs: 30_000,
      env: { CLAWSWEEPER_REVIEW_TOOLS_DIR: root },
      fetchImpl: async () => {
        fetched = true;
        return new Response("unreachable");
      },
      runtimePlatform: "linux",
      runtimeArch: "x64",
    }),
    /unsafe directory entry/,
  );
  assert.equal(fetched, false);
  assert.deepEqual(readdirSync(target), []);
});

test("review-tool bootstrap refuses a symlinked cache root before download", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "clawsweeper-review-tools-base-"));
  const target = mkdtempSync(join(tmpdir(), "clawsweeper-review-tools-target-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  const root = join(base, "cache");
  symlinkSync(target, root, process.platform === "win32" ? "junction" : "dir");
  let fetched = false;
  await assert.rejects(
    ensureManagedTruffleHog({
      timeoutMs: 30_000,
      env: { CLAWSWEEPER_REVIEW_TOOLS_DIR: root },
      fetchImpl: async () => {
        fetched = true;
        return new Response("unreachable");
      },
      runtimePlatform: "linux",
      runtimeArch: "x64",
    }),
    /unsafe directory (?:entry|ancestor)/,
  );
  assert.equal(fetched, false);
  assert.deepEqual(readdirSync(target), []);
});

test(
  "review-tool bootstrap permits a cache below an external symlinked ancestor",
  { skip: process.platform === "win32" },
  async (t) => {
    const base = mkdtempSync(join(tmpdir(), "clawsweeper-review-tools-alias-"));
    const target = join(base, "target");
    const alias = join(base, "alias");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, alias, "dir");
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const root = join(alias, "cache");
    const response = new Response("unread", {
      status: 200,
      headers: { "content-length": String(256 * 1024 * 1024 + 1) },
    });
    await assert.rejects(
      ensureManagedTruffleHog({
        timeoutMs: 30_000,
        env: { CLAWSWEEPER_REVIEW_TOOLS_DIR: root },
        fetchImpl: async () => response,
        runtimePlatform: "linux",
        runtimeArch: "x64",
      }),
      /exceeds the archive limit/,
    );
    assert.equal(existsSync(join(target, "cache")), true);
  },
);

test("review-tool bootstrap refuses a cache root writable by another principal", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "clawsweeper-review-tools-authority-"));
  const root = join(base, "cache");
  const marker = join(base, "scanner-executed");
  const binaryDir = join(root, "trufflehog", `v${TRUFFLEHOG_VERSION}`, "linux-x64");
  mkdirSync(binaryDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(binaryDir, "trufflehog"),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad");`,
    { mode: 0o700 },
  );
  allowOtherPrincipalWrites(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  let fetched = false;
  await assert.rejects(
    ensureManagedTruffleHog({
      timeoutMs: 30_000,
      env: { CLAWSWEEPER_REVIEW_TOOLS_DIR: root },
      fetchImpl: async () => {
        fetched = true;
        return new Response("unreachable");
      },
      runtimePlatform: "linux",
      runtimeArch: "x64",
    }),
    /not private to the current user/,
  );
  assert.equal(fetched, false);
  assert.equal(existsSync(marker), false);
});
