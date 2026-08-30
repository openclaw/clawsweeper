import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  extractTarExecutable,
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
    /must be absolute/,
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
