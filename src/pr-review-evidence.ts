import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ItemContext } from "./clawsweeper-types.js";

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_FILES = 80;
const MAX_PATCH_CHARS = 24_000;

type MergeBase =
  | { status: "verified"; sha: string }
  | { status: "unavailable" | "ambiguous"; sha: null; reason: string };

type DiffRole =
  | "pr_introduced"
  | "endpoint_drift_not_introduction"
  | "base_branch_changes_since_merge_base"
  | "verified_test_merge_vs_its_main_parent";

type DiffEvidence = {
  role: DiffRole;
  fromSha: string | null;
  toSha: string | null;
  files: string[];
  filesComplete: boolean;
  patch?: string | null;
  patchComplete?: boolean;
};

export type PullRequestReviewEvidence = {
  checkoutSha: string | null;
  fetchedMainSha: string | null;
  baseSha: string | null;
  headSha: string | null;
  mergeBase: MergeBase;
  introduced: DiffEvidence;
  endpointDrift: DiffEvidence;
  baseChanges: DiffEvidence;
  baseOnlyFiles: string[] | null;
  testMerge: {
    status: "verified" | "unavailable" | "stale" | "not_test_merge";
    sha: string | null;
    parents?: string[];
    reason?: string;
    result?: DiffEvidence;
  };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function objectId(value: unknown): string | null {
  return typeof value === "string" && OBJECT_ID.test(value) ? value : null;
}

// This host-side reader never invokes a diff driver or lazily fetches target objects.
function git(targetDir: string | undefined, args: string[]): string | null {
  if (!targetDir) return null;
  const result = spawnSync("git", ["-c", "protocol.allow=never", ...args], {
    cwd: targetDir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  });
  return result.error || result.status !== 0 ? null : result.stdout;
}

export function reviewMergeBase(
  targetDir: string | undefined,
  baseSha: string | null,
  headSha: string | null,
): MergeBase {
  const unavailable = (reason: string): MergeBase => ({ status: "unavailable", sha: null, reason });
  if (!baseSha || !headSha || !objectId(baseSha) || !objectId(headSha))
    return unavailable("Missing pinned base or head identity.");
  const output = git(targetDir, ["merge-base", "--all", baseSha, headSha]);
  if (!output?.trim())
    return unavailable(
      "No merge base available in bounded local history; ancestry may be shallow or unrelated.",
    );
  const bases = output.trim().split("\n");
  if (bases.length !== 1)
    return {
      status: "ambiguous",
      sha: null,
      reason: "Multiple merge bases; no single introduced delta is established.",
    };
  const sha = objectId(bases[0]);
  if (!sha) return unavailable("Invalid merge-base identity.");
  const shallowPath = git(targetDir, ["rev-parse", "--git-path", "shallow"])?.trim();
  if (!shallowPath || !targetDir)
    return unavailable("Could not inspect local ancestry boundaries.");
  try {
    const path = resolve(targetDir, shallowPath);
    if (existsSync(path)) {
      const shallow = new Set(readFileSync(path, "utf8").trim().split("\n"));
      const introducedHistory = git(targetDir, ["rev-list", baseSha, headSha, "--not", sha]);
      if (
        introducedHistory === null ||
        introducedHistory
          .trim()
          .split("\n")
          .some((commit) => shallow.has(commit))
      ) {
        return unavailable(
          "Shallow boundary before the candidate merge base; introduction ancestry is incomplete.",
        );
      }
    }
  } catch {
    return unavailable("Could not inspect local ancestry boundaries.");
  }
  return { status: "verified", sha };
}

function diff(
  targetDir: string | undefined,
  fromSha: string | null,
  toSha: string | null,
  role: DiffRole,
  includePatch = false,
): DiffEvidence {
  const args =
    fromSha && toSha
      ? ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", fromSha, toSha]
      : null;
  const paths = args ? git(targetDir, [...args, "--name-only", "-z", "--"]) : null;
  const files = paths === null ? [] : paths.split("\0").filter(Boolean);
  const result: DiffEvidence = {
    role,
    fromSha,
    toSha,
    files: files.slice(0, MAX_FILES),
    filesComplete: paths !== null && files.length <= MAX_FILES,
  };
  if (includePatch) {
    const patch = args ? git(targetDir, [...args, "--patch", "--unified=3", "--"]) : null;
    result.patch = patch === null ? null : patch.slice(0, MAX_PATCH_CHARS);
    result.patchComplete =
      patch !== null &&
      patch.length <= MAX_PATCH_CHARS &&
      !/^Binary files |^Submodule /m.test(patch);
  }
  return result;
}

export function buildPullRequestReviewEvidence(options: {
  targetDir?: string;
  context: ItemContext;
  mainSha: string;
}): PullRequestReviewEvidence {
  const { targetDir, context } = options;
  const pull = record(context.pullRequest);
  const baseSha = objectId(record(pull.base).sha);
  const headSha = objectId(record(pull.head).sha);
  const mergeBase = reviewMergeBase(targetDir, baseSha, headSha);
  const introduced = diff(targetDir, mergeBase.sha, headSha, "pr_introduced", true);
  const baseChanges = diff(
    targetDir,
    mergeBase.sha,
    baseSha,
    "base_branch_changes_since_merge_base",
  );
  const testMerge: PullRequestReviewEvidence["testMerge"] = {
    status: "unavailable",
    sha: objectId(pull.mergeCommitSha),
    reason:
      "No locally available pinned test merge; mergeable metadata alone is not merge evidence.",
  };
  if (pull.merged !== false || pull.state !== "open") {
    testMerge.status = "not_test_merge";
    testMerge.reason = "Not an open unmerged PR; a final merge commit is not a test merge.";
  } else if (testMerge.sha) {
    const commit = git(targetDir, ["cat-file", "commit", testMerge.sha]);
    if (commit !== null) {
      const parents = commit
        .split("\n\n", 1)[0]!
        .split("\n")
        .filter((line) => line.startsWith("parent "))
        .map((line) => line.slice(7));
      testMerge.parents = parents;
      if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha) {
        testMerge.status = "stale";
        testMerge.reason = "Test merge parents do not equal the pinned base then exact PR head.";
      } else {
        testMerge.status = "verified";
        delete testMerge.reason;
        testMerge.result = diff(
          targetDir,
          baseSha,
          testMerge.sha,
          "verified_test_merge_vs_its_main_parent",
        );
      }
    }
  }
  return {
    checkoutSha: objectId(git(targetDir, ["rev-parse", "HEAD"])?.trim()),
    fetchedMainSha: objectId(options.mainSha),
    baseSha,
    headSha,
    mergeBase,
    introduced,
    endpointDrift: diff(targetDir, baseSha, headSha, "endpoint_drift_not_introduction"),
    baseChanges,
    baseOnlyFiles:
      introduced.filesComplete && baseChanges.filesComplete
        ? baseChanges.files.filter((path) => !introduced.files.includes(path))
        : null,
    testMerge,
  };
}
