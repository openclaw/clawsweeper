import { appendFileSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { reviewToolArtifact, TRUFFLEHOG_VERSION } from "../../../dist/review-tool-bootstrap.js";

function requiredPath(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value) || /[\x00-\x1f]/.test(value))
    throw new Error(`Invalid ${name} for review archive transport.`);
  return realpathSync(value);
}

function assertPrivate(path, directory) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Review archive transport must be private to the current user.");
}

const root = join(requiredPath("RUNNER_TEMP"), "clawsweeper-review-archive");
const workspaceRelative = relative(requiredPath("GITHUB_WORKSPACE"), root);
if (workspaceRelative !== ".." && !workspaceRelative.startsWith("../"))
  throw new Error("Review archive transport must be outside the checkout.");
try {
  mkdirSync(root, { mode: 0o700 });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
assertPrivate(root, true);
const archive = join(root, "archive.tar.gz");
try {
  assertPrivate(archive, false);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (process.argv[2] === "--validate") {
  if (process.argv[3] !== archive) throw new Error("Unexpected review archive transport path.");
} else {
  const artifact = reviewToolArtifact("linux", "x64");
  if (!artifact) throw new Error("Missing pinned Linux review scanner archive.");
  // Cache only immutable release bytes; each installer still creates and verifies its own binary.
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `archive-path=${archive}\ncache-key=review-scanner-archive-v1-${TRUFFLEHOG_VERSION}-${artifact.platform}-${artifact.sha256}\n`,
  );
}
