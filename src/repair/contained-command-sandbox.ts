import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXPECTED_SANDBOX_ROOT_CANDIDATE_ERRORS = new Set([
  "EACCES",
  "EDQUOT",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

type TrustedSandboxRootOptions = {
  candidates?: readonly string[];
  makeTemporaryDirectory?: (prefix: string) => string;
};

export function createTrustedSandboxRoot(
  writableRoots: readonly string[],
  {
    candidates = ["/var/tmp", "/tmp", os.tmpdir()],
    makeTemporaryDirectory = fs.mkdtempSync,
  }: TrustedSandboxRootOptions = {},
): string {
  const canonicalWritableRoots = writableRoots.map((root) => fs.realpathSync(root));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const canonical = fs.realpathSync(candidate);
    if (
      canonicalWritableRoots.some(
        (root) => pathWithin(canonical, root) || pathWithin(root, canonical),
      )
    ) {
      continue;
    }
    let sandboxRoot: string;
    try {
      sandboxRoot = makeTemporaryDirectory(path.join(canonical, "clawsweeper-validation-root-"));
    } catch (error) {
      if (isExpectedSandboxRootCandidateError(error)) continue;
      throw error;
    }
    const resolved = fs.realpathSync(sandboxRoot);
    if (
      canonicalWritableRoots.some(
        (root) => pathWithin(resolved, root) || pathWithin(root, resolved),
      )
    ) {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
      continue;
    }
    return sandboxRoot;
  }
  throw new Error("validation sandbox requires a trusted root outside writable roots");
}

function isExpectedSandboxRootCandidateError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return EXPECTED_SANDBOX_ROOT_CANDIDATE_ERRORS.has(String((error as NodeJS.ErrnoException).code));
}

function pathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
