import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { devNull } from "node:os";
import type { ItemContext } from "./clawsweeper-types.js";

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_FILES = 80;
const MAX_PATCH_CHARS = 24_000;
const MAX_COMMIT_PARENTS = 8;
// Git for Windows accepts the DOS device spelling but rejects Node's `\\\\.\\nul`
// spelling when it is supplied through GIT_CONFIG_GLOBAL.
const gitNullDevice = process.platform === "win32" ? "NUL" : devNull;

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

type CommitEvidence<Role extends string> = { role: Role } & (
  | { status: "verified"; sha: string; parents: string[] }
  | { status: "unavailable"; sha: string | null; parents: null; reason: string }
);

export type PullRequestReviewEvidence = {
  checkout: CommitEvidence<"actual_checkout">;
  originalHead: CommitEvidence<"original_pr_head">;
  fetchedMainSha: string | null;
  baseSha: string | null;
  mergeBase: MergeBase;
  introduced: DiffEvidence;
  endpointDrift: DiffEvidence;
  baseChanges: DiffEvidence;
  baseOnlyFiles: string[] | null;
  testMerge: {
    role: "github_test_merge";
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

export interface ReviewGitReadOptions {
  executable?: string;
  objectEnv?: NodeJS.ProcessEnv;
  // Omitted uses the five-second read deadline; null explicitly disables it.
  deadlineAt?: number | null;
  maxBytes?: number;
  input?: Buffer;
  configuration?: "normalization";
}

// Read raw objects without target callbacks, replacement objects, grafts, or lazy fetches.
export function readReviewGit(
  targetDir: string | undefined,
  args: string[],
  options: ReviewGitReadOptions = {},
): Buffer | null {
  if (!targetDir) return null;
  const normalizationQuery = options.configuration === "normalization";
  const readsNormalization =
    args[0] === "check-attr" ||
    (args[0] === "config" &&
      args.includes("--get") &&
      ["core.autocrlf", "core.eol", "core.symlinks"].includes(args.at(-1) ?? ""));
  if (normalizationQuery && !readsNormalization) return null;
  const timeout =
    options.deadlineAt === null
      ? undefined
      : (options.deadlineAt ?? Date.now() + 5_000) - Date.now();
  if (timeout !== undefined && timeout <= 0) return null;
  const result = spawnSync(
    options.executable ?? "git",
    [
      "-c",
      "protocol.allow=never",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=" + gitNullDevice,
      "-c",
      "diff.external=",
      ...args,
    ],
    {
      cwd: targetDir,
      ...(options.input ? { input: options.input } : {}),
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...options.objectEnv,
        // Configuration/attribute queries do not execute filters. Honor the
        // host settings that produced a clean checkout, but never inherit them
        // for object reads or canonicalization where callbacks could execute.
        ...(normalizationQuery
          ? {
              HOME: process.env.HOME,
              USERPROFILE: process.env.USERPROFILE,
              XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            }
          : {
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: gitNullDevice,
              GIT_ATTR_NOSYSTEM: "1",
            }),
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        // Legacy graft files alter ancestry independently of replacement refs.
        GIT_GRAFT_FILE: gitNullDevice,
        GIT_TERMINAL_PROMPT: "0",
        GIT_LFS_SKIP_SMUDGE: "1",
      },
      maxBuffer: options.maxBytes ?? 1024 * 1024,
      timeout,
      killSignal: "SIGKILL",
    },
  );
  return result.error || result.signal || result.status !== 0 ? null : result.stdout;
}

// Git consumes LF-delimited parent records only immediately after the tree.
// CRs in identities and later parent-looking headers are not ancestry.
export function reviewCommitParents(raw: string): string[] | null {
  let end = raw.indexOf("\n");
  if (!raw.startsWith("tree ") || end < 0 || end >= raw.length - 1) return null;
  const tree = objectId(raw.slice(5, end).toLowerCase());
  if (!tree) return null;
  const parents: string[] = [];
  let offset = end + 1;
  while (raw.startsWith("parent ", offset)) {
    end = raw.indexOf("\n", offset);
    if (end < 0 || end >= raw.length - 1) return null;
    const parent = objectId(raw.slice(offset + 7, end).toLowerCase());
    if (!parent || parent.length !== tree.length) return null;
    parents.push(parent);
    offset = end + 1;
  }
  return parents;
}

function git(
  targetDir: string | undefined,
  args: string[],
  options?: ReviewGitReadOptions,
): string | null {
  return readReviewGit(targetDir, args, options)?.toString("utf8") ?? null;
}

function commitEvidence<Role extends string>(
  targetDir: string | undefined,
  sha: string | null,
  role: Role,
): CommitEvidence<Role> {
  const unavailable = (reason: string): CommitEvidence<Role> => ({
    role,
    status: "unavailable",
    sha,
    parents: null,
    reason,
  });
  if (!sha) return unavailable("Missing commit identity.");
  // cat-file commit can peel tags; require the exact pinned object to be a commit.
  if (git(targetDir, ["cat-file", "-t", sha])?.trim() !== "commit")
    return unavailable("Exact commit object unavailable in bounded local inspection.");
  const raw = git(targetDir, ["cat-file", "commit", sha]);
  if (raw === null) return unavailable("Raw commit read failed or exceeded its bounds.");
  const parents = reviewCommitParents(raw);
  if (parents === null || parents.length > MAX_COMMIT_PARENTS)
    return unavailable("Invalid raw parent records or more than eight recorded parents.");
  return { role, status: "verified", sha, parents };
}

export function reviewMergeBase(
  targetDir: string | undefined,
  baseSha: string | null,
  headSha: string | null,
  options?: ReviewGitReadOptions,
): MergeBase {
  const unavailable = (reason: string): MergeBase => ({ status: "unavailable", sha: null, reason });
  if (!baseSha || !headSha || !objectId(baseSha) || !objectId(headSha))
    return unavailable("Missing pinned base or head identity.");
  const output = git(targetDir, ["merge-base", "--all", baseSha, headSha], options);
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
  const shallowPath = git(targetDir, ["rev-parse", "--git-path", "shallow"], options)?.trim();
  if (!shallowPath || !targetDir)
    return unavailable("Could not inspect local ancestry boundaries.");
  try {
    const path = resolve(targetDir, shallowPath);
    if (existsSync(path)) {
      const shallow = new Set(readFileSync(path, "utf8").trim().split("\n"));
      const introducedHistory = git(
        targetDir,
        ["rev-list", baseSha, headSha, "--not", sha],
        options,
      );
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
    role: "github_test_merge",
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
    const parents = commit === null ? null : reviewCommitParents(commit);
    if (parents) {
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
    checkout: commitEvidence(
      targetDir,
      objectId(git(targetDir, ["rev-parse", "HEAD"])?.trim()),
      "actual_checkout",
    ),
    originalHead: commitEvidence(targetDir, headSha, "original_pr_head"),
    fetchedMainSha: objectId(options.mainSha),
    baseSha,
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
