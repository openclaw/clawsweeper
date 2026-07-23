#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [targetDir, trackedRelativePath, markerPath] = process.argv.slice(2);
if (!targetDir || !trackedRelativePath || !markerPath) {
  fail("usage: index-stat-mutator.mjs <target-dir> <tracked-relative-path> <marker-path>");
}

const deadline = Date.now() + 60_000;
const trackedFile = path.resolve(targetDir, trackedRelativePath);
const relativeTrackedFile = path.relative(path.resolve(targetDir), trackedFile);
if (relativeTrackedFile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTrackedFile)) {
  fail("tracked relative path escapes target directory");
}
const installMarker = path.join(targetDir, "node_modules");
while (!fs.existsSync(trackedFile) || !fs.existsSync(installMarker)) {
  if (Date.now() >= deadline) fail("timed out waiting for target dependency setup");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

// Refresh only Git's index stat cache: content, tree, and hidden flags remain
// unchanged. This reconstructs the administrative-byte drift from the linked
// CI run without requiring OpenClaw's source tree or dependency graph.
const stat = fs.statSync(trackedFile);
fs.utimesSync(trackedFile, stat.atime, new Date(stat.mtimeMs + 2_000));
execFileSync("/usr/bin/git", ["-C", targetDir, "status", "--porcelain"], {
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "1" },
  stdio: "ignore",
});
fs.writeFileSync(markerPath, "git index stat cache refreshed\n");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
