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
import { fileURLToPath } from "node:url";

import {
  extractTarExecutable,
  darwinAclAllowsUnsafeWriter,
  ensureManagedTruffleHog,
  formatReviewToolBootstrapDiagnostic,
  parseReviewToolBootstrapDiagnostic,
  ReviewToolBootstrapError,
  posixCacheAncestorIsUnsafe,
  reviewToolCacheRoot,
  reviewToolArtifact,
  TRUFFLEHOG_VERSION,
} from "../dist/review-tool-bootstrap.js";

function bootstrapFailure(phase: string, category: string) {
  return (error: unknown) =>
    error instanceof ReviewToolBootstrapError &&
    error.diagnostic.phase === phase &&
    error.diagnostic.category === category;
}

test("bootstrap HTTP failures retain only the observed status", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const status of [403, 404, 429, 500]) {
    await assert.rejects(
      ensureManagedTruffleHog({
        timeoutMs: 30_000,
        env: { CLAWSWEEPER_REVIEW_TOOLS_DIR: root },
        runtimePlatform: "linux",
        runtimeArch: "x64",
        fetchImpl: async (url, options) => {
          assert.equal(url, reviewToolArtifact("linux", "x64")!.url);
          assert.equal([...new Headers(options?.headers)].length, 0);
          return new Response("private response body", {
            status,
            statusText: "private status text",
          });
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewToolBootstrapError);
        assert.deepEqual(error.diagnostic, {
          phase: "download",
          category: "http",
          http_status: status,
        });
        assert.equal(
          formatReviewToolBootstrapDiagnostic(error.diagnostic),
          `{"event":"review_tool_bootstrap_failed","phase":"download","category":"http","http_status":${status}}`,
        );
        assert.equal(error.cause, undefined);
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
  }
});

test("bootstrap transport failures neither expose text nor infer a cause", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const error = Object.assign(new Error("private proxy credentials /private/operator/cache TLS"), {
    name: "TimeoutError",
    code: "ETIMEDOUT",
    cause: new Error("private underlying cause"),
  });
  await assert.rejects(
    ensureManagedTruffleHog({
      timeoutMs: 30_000,
      env: { CLAWSWEEPER_REVIEW_TOOLS_DIR: root },
      runtimePlatform: "linux",
      runtimeArch: "x64",
      fetchImpl: async () => {
        throw error;
      },
    }),
    (caught: unknown) => {
      assert.ok(caught instanceof ReviewToolBootstrapError);
      assert.deepEqual(caught.diagnostic, { phase: "download", category: "failed" });
      assert.equal(caught.cause, undefined);
      assert.equal(
        formatReviewToolBootstrapDiagnostic(caught.diagnostic),
        '{"event":"review_tool_bootstrap_failed","phase":"download","category":"failed"}',
      );
      return true;
    },
  );
});

test("bootstrap rejects changed download bytes with a checksum diagnostic", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    ensureManagedTruffleHog({
      timeoutMs: 30_000,
      env: { CLAWSWEEPER_REVIEW_TOOLS_DIR: root },
      runtimePlatform: "linux",
      runtimeArch: "x64",
      fetchImpl: async () => new Response("private untrusted archive bytes"),
    }),
    bootstrapFailure("download", "checksum"),
  );
});

test("bootstrap diagnostics accept one bounded record and reject extra data", () => {
  const fact = { phase: "download", category: "http", http_status: 403 } as const;
  const line = formatReviewToolBootstrapDiagnostic(fact) + "\n";
  assert.deepEqual(parseReviewToolBootstrapDiagnostic(line), fact);
  assert.equal(Buffer.byteLength(line) <= 256, true);
  const record = JSON.parse(line);
  for (const text of [
    "",
    line.trimEnd(),
    line + line,
    "private loader error\n" + line,
    line + "private extra output\n",
    " ".repeat(256) + line,
    JSON.stringify({ ...record, private: "secret" }) + "\n",
    JSON.stringify({ ...record, event: "other" }) + "\n",
    JSON.stringify({ ...record, phase: "private path" }) + "\n",
    JSON.stringify({ ...record, category: "private message" }) + "\n",
    JSON.stringify({ ...record, phase: "cache" }) + "\n",
    JSON.stringify({ event: record.event, phase: "cache", category: "http" }) + "\n",
    ...[0, 600, 403.5, "403", null].map(
      (status) => JSON.stringify({ ...record, http_status: status }) + "\n",
    ),
  ])
    assert.equal(parseReviewToolBootstrapDiagnostic(text), undefined);
});

test("the real setup script refuses an invalid cache without outputting private text", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/setup-review-tools.mjs", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        SystemRoot: process.env.SystemRoot,
        CLAWSWEEPER_REVIEW_TOOLS_DIR: "private-relative-cache",
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(parseReviewToolBootstrapDiagnostic(result.stderr), {
    phase: "setup",
    category: "failed",
  });
  assert.equal(result.stderr.includes("private-relative-cache"), false);
});

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
    sha256: "97749c11ec76ef93ca50a3a50bd2a40f25fb92dfee4366d4bff0ba0d951307a8",
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
    bootstrapFailure("download", "limit"),
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
    bootstrapFailure("cache", "failed"),
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
    bootstrapFailure("cache", "failed"),
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
      bootstrapFailure("download", "limit"),
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
    bootstrapFailure("cache", "failed"),
  );
  assert.equal(fetched, false);
  assert.equal(existsSync(marker), false);
});
