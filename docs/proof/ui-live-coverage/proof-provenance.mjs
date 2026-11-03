import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const COVERAGE_PROOF_BASE = "96869eede468afe433994130d62edd50884ef43a";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Declared metadata is not evidence of containment. The parent must attach and
// verify the actual external Crabbox wrapper/runtime receipt for this execution.
export function proofEnvironment(args = process.argv.slice(2), env = process.env) {
  if (args.includes("--host-supporting")) {
    return {
      qualification: "supporting-host-only; not contained qualification",
      provider: "host",
      image: null,
      lease: null,
      containment_verified_by_script: false,
      containment_evidence: "Explicit supporting host execution, not Crabbox proof",
    };
  }
  if (
    env.CRABBOX_PROOF_PROVIDER !== "local-container" ||
    !/^cbx_[a-zA-Z0-9_-]+$/.test(env.CRABBOX_PROOF_LEASE ?? "") ||
    !env.CRABBOX_PROOF_IMAGE?.trim() ||
    /[\r\n]/.test(env.CRABBOX_PROOF_IMAGE)
  ) {
    throw new Error(
      "Supply actual local-container provider/lease/image metadata and external wrapper evidence, or explicitly use --host-supporting. Environment values never verify containment.",
    );
  }
  return {
    qualification: "declared-local-container; external wrapper/runtime evidence required",
    provider: env.CRABBOX_PROOF_PROVIDER,
    image: env.CRABBOX_PROOF_IMAGE,
    lease: env.CRABBOX_PROOF_LEASE,
    containment_verified_by_script: false,
    containment_evidence:
      "Caller-supplied metadata must match external Crabbox wrapper/runtime receipt",
  };
}

// Bind the full intended-base-to-HEAD range, not just the last commit or dirty
// files. HEAD's Git tree anchors ALL committed paths; effective file hashes also
// bind reviewed dirty/untracked additions and explicitly retain deleted paths.
export function captureProofSource(root, base = COVERAGE_PROOF_BASE) {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("Proof base must be a pinned full commit ID");
  const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const revision = (ref) => git("rev-parse", "--verify", ref).toString().trim();
  const names = (...args) =>
    git(...args)
      .toString()
      .split("\0")
      .filter(Boolean);
  const realRoot = realpathSync(root);
  const head = revision("HEAD^{commit}");
  const headTree = revision("HEAD^{tree}");
  if (revision(base + "^{commit}") !== base) throw new Error("Proof base mismatch");
  const committed = names("diff", "--name-only", "--no-renames", "-z", base, head);
  const dirty = names("diff", "--name-only", "--no-renames", "-z", "HEAD");
  const untracked = names("ls-files", "--others", "--exclude-standard", "-z");
  const files = Object.fromEntries(
    [...new Set([...committed, ...dirty, ...untracked])].sort().map((file) => {
      const path = join(root, file);
      // Never follow an untracked or modified symlink outside the checkout.
      const stat = lstatIfPresent(path);
      if (!stat) return [file, null];
      if (stat.isSymbolicLink()) return [file, sha256(readlinkSync(path))];
      if (!stat.isFile()) throw new Error("Unsupported proof source path kind");
      const resolved = relative(realRoot, realpathSync(path));
      if (
        resolved === ".." ||
        resolved.startsWith("../") ||
        resolved.startsWith("..\\") ||
        isAbsolute(resolved)
      )
        throw new Error("Proof source resolves outside checkout");
      return [file, sha256(readFileSync(path))];
    }),
  );
  const treeManifest = git("ls-tree", "-r", "-z", "--full-tree", head);
  const trackedDiff = git("diff", "--binary", "--no-ext-diff", base);
  if (revision("HEAD^{commit}") !== head || revision("HEAD^{tree}") !== headTree)
    throw new Error("Proof HEAD changed while binding source");
  return {
    base,
    head,
    head_tree: headTree,
    merge_base: git("merge-base", base, head).toString().trim(),
    committed_range: base + ".." + head,
    whole_committed_tree: {
      git_tree: headTree,
      manifest_sha256: sha256(treeManifest),
      entries: treeManifest.toString().split("\0").filter(Boolean).length,
    },
    committed_files: committed.sort(),
    dirty_files: dirty.sort(),
    untracked_files: untracked.sort(),
    files,
    source_tree_digest: sha256(JSON.stringify(files)),
    patch_sha256: sha256(trackedDiff),
    patch_scope:
      "Tracked base-to-working-tree diff; untracked bytes/deletions separately bound in files",
  };
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
