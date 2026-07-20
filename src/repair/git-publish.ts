import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { clawsweeperGitUserEmail, clawsweeperGitUserName } from "./process-env.js";
import {
  chooseRecordTupleWinner,
  RecordTupleError,
  recordTupleIdentityForPath,
  recordTupleMarkdownFileForPath,
  recordTuplePathList,
  recordTuplePaths,
  validateRecordTuple,
  type RecordTupleContents,
  type RecordTupleIdentity,
  type RecordTuplePaths,
  type RecordTupleWinner,
} from "./record-tuple.js";
import { mergeSweepStatusJson } from "./sweep-status-merge.js";
import { mergeCommentRouterLedgers } from "./comment-router-ledger-merge.js";
import { isActionEventPublishPath } from "../action-ledger-paths.js";

export type GitRunResult = {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type GitPublishOptions = {
  message: string;
  paths: readonly string[];
  restorePaths?: readonly string[];
  maxAttempts?: number | undefined;
  pushAttempts?: number | undefined;
  remote?: string;
  branch?: string;
  rebaseStrategy?: RebaseStrategy | undefined;
};

export type RebaseStrategy = "normal" | "theirs" | "apply-records" | "reconcile-records";

export type GitRunOptions = {
  allowFailure?: boolean;
  displayArgs?: readonly string[];
  input?: string;
  maxBuffer?: number;
  quiet?: boolean;
  timeout?: number;
};

export type PublishResult = "committed" | "unchanged";

const GENERATED_PUBLISH_PATHS = [
  "apply-report.json",
  "repair-apply-report.json",
  "jobs",
  "records",
  "results",
  "assets",
] as const;
const GIT_PATHSPEC_BATCH_SIZE = 256;
const GIT_OBJECT_BATCH_SIZE = 512;
const GIT_OBJECT_BATCH_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TREE_LIST_MAX_BUFFER = 64 * 1024 * 1024;
const RECONCILIATION_TUPLE_CHUNK_SIZE = 128;
const PUBLISH_FETCH_TIMEOUT_MS = 60_000;
const SKIP_CI_DIRECTIVE_PATTERN =
  /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks:\s*true$/im;

type GitPublishMetrics = {
  startedAtMs: number;
  processes: number;
  actions: Map<string, number>;
  phase: string;
};

let activeGitPublishMetrics: GitPublishMetrics | null = null;

export function configureGitUser(): void {
  runGit(["config", "user.name", clawsweeperGitUserName()]);
  runGit(["config", "user.email", clawsweeperGitUserEmail()]);
}

export function setTokenOrigin(token: string, repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid repository for token origin: ${repository}`);
  }
  runGit(
    ["remote", "set-url", "origin", `https://x-access-token:${token}@github.com/${repository}.git`],
    {
      displayArgs: [
        "remote",
        "set-url",
        "origin",
        `https://x-access-token:***@github.com/${repository}.git`,
      ],
    },
  );
}

export function runGit(args: readonly string[], options: GitRunOptions = {}): string {
  const result = spawnGit(args, options);
  if (result.timedOut) {
    throw new GitCommandTimeoutError(args, options.timeout ?? 0);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail =
      result.stderr ||
      result.stdout ||
      `${formatGitDisplayCommand(options.displayArgs ?? args)} exited ${result.status}`;
    throw new Error(detail.trim());
  }
  return result.stdout;
}

export function spawnGit(args: readonly string[], options: GitRunOptions = {}): GitRunResult {
  recordGitProcess(args[0]);
  console.log(`$ ${formatGitDisplayCommand(options.displayArgs ?? args)}`);
  const child = spawnSync("git", [...args], {
    cwd: publishRoot(),
    env: process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout,
  });
  if (!options.quiet && child.stdout) process.stdout.write(child.stdout);
  if (!options.quiet && child.stderr) process.stderr.write(child.stderr);
  return {
    status: child.status ?? 1,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    timedOut: (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

export class GitCommandTimeoutError extends Error {
  constructor(args: readonly string[], timeoutMs: number) {
    super(`git ${safeGitDisplayAction(args[0])} timed out after ${timeoutMs}ms`);
    this.name = "GitCommandTimeoutError";
  }
}

function recordGitProcess(action: string | undefined): void {
  if (!activeGitPublishMetrics) return;
  const key = action || "command";
  activeGitPublishMetrics.processes += 1;
  activeGitPublishMetrics.actions.set(key, (activeGitPublishMetrics.actions.get(key) ?? 0) + 1);
}

function formatGitDisplayCommand(args: readonly string[]): string {
  return `git ${safeGitDisplayAction(args[0])} <redacted-args>`;
}

function safeGitDisplayAction(action: string | undefined): string {
  switch (action) {
    case "add":
    case "commit":
    case "config":
    case "diff":
    case "fetch":
    case "checkout":
    case "cat-file":
    case "clean":
    case "log":
    case "ls-files":
    case "ls-tree":
    case "merge-base":
    case "mktree":
    case "push":
    case "read-tree":
    case "rebase":
    case "remote":
    case "restore":
    case "reset":
    case "rev-parse":
    case "rm":
    case "status":
    case "update-ref":
    case "write-tree":
    case "commit-tree":
      return action;
    default:
      return "command";
  }
}

export function stagePaths(paths: readonly string[]): void {
  const pathSpecs = uniqueNonEmpty(paths).map((path) => ({
    path,
    gitPath: normalizedPublishPath(path) || path,
  }));
  if (pathSpecs.length === 0) throw new Error("No paths were provided for publishing");
  let skippedMissing = 0;
  for (const batch of chunked(pathSpecs, GIT_PATHSPEC_BATCH_SIZE)) {
    const trackedFiles = runGit(["ls-files", "-z", "--", ...batch.map(({ gitPath }) => gitPath)], {
      quiet: true,
    })
      .split("\0")
      .filter(Boolean);
    const stageable = batch.filter(({ path, gitPath }) => {
      const worktreePath = resolve(publishRoot() ?? process.cwd(), path);
      return existsSync(worktreePath) || trackedFiles.some((file) => pathIsWithin(gitPath, file));
    });
    skippedMissing += batch.length - stageable.length;
    if (stageable.length > 0) {
      runGit(["add", "-A", "--", ...stageable.map(({ gitPath }) => gitPath)]);
    }
  }
  if (skippedMissing > 0) {
    console.log(
      `Skipped ${skippedMissing} untracked missing publish path(s); staged deletions remain intact`,
    );
  }
}

export function restoreWorktree(paths: readonly string[]): void {
  const uniquePaths = uniqueNonEmpty(paths);
  if (uniquePaths.length === 0) return;
  for (const path of uniquePaths) {
    if (hasWorktreePath(path)) runGit(["restore", "--worktree", "--", path]);
    else console.log(`Skipping untracked restore path: ${path}`);
  }
}

export function hasStagedChanges(): boolean {
  return spawnGit(["diff", "--cached", "--quiet"]).status !== 0;
}

export function hasWorktreePath(path: string): boolean {
  return spawnGit(["ls-files", "--error-unmatch", path]).status === 0;
}

export function publishMainCommit(options: GitPublishOptions): PublishResult {
  const previousMetrics = activeGitPublishMetrics;
  const metrics: GitPublishMetrics = {
    startedAtMs: Date.now(),
    processes: 0,
    actions: new Map(),
    phase: "start",
  };
  activeGitPublishMetrics = metrics;
  try {
    return publishMainCommitInternal(options);
  } catch (error) {
    console.log(
      `Git publish failure: phase=${metrics.phase} processes=${metrics.processes} duration_ms=${Date.now() - metrics.startedAtMs} error=${errorMessage(error)}`,
    );
    throw error;
  } finally {
    const actions = [...metrics.actions]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([action, count]) => `${action}:${count}`)
      .join(",");
    console.log(
      `Git publish metrics: phase=${metrics.phase} processes=${metrics.processes} duration_ms=${Date.now() - metrics.startedAtMs} actions=${actions}`,
    );
    activeGitPublishMetrics = previousMetrics;
  }
}

function publishMainCommitInternal(options: GitPublishOptions): PublishResult {
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? publishDefaultBranch();
  const maxAttempts = positiveInt(options.maxAttempts, 8);
  const pushAttempts = positiveInt(options.pushAttempts, 3);
  const rebaseStrategy = options.rebaseStrategy ?? "normal";
  gitPublishPhase(
    "sync",
    `paths=${uniqueNonEmpty(options.paths).length} strategy=${rebaseStrategy}`,
  );
  prepareReconciliationStateRoot(remote, branch, rebaseStrategy);
  const stateBaseCommit = captureStatePublishBaseline();

  syncPublishPaths(options.paths, { rebaseStrategy });
  configureGitUser();
  gitPublishPhase("stage", `paths=${uniqueNonEmpty(options.paths).length}`);
  stagePaths(options.paths);
  if (!hasStagedChanges()) {
    console.log("No publish changes");
    const synchronized =
      !stateBaseCommit ||
      (rebaseStrategy === "reconcile-records"
        ? pushReconciliationCommit({ remote, branch, pushAttempts, maxAttempts })
        : pushCommit({ remote, branch, pushAttempts, rebaseStrategy }));
    if (!synchronized) {
      throw new Error(`Failed to synchronize unchanged publish with ${remote}/${branch}`);
    }
    return completeStatePublish("unchanged", options.paths, stateBaseCommit);
  }

  const commitMessage = commitMessageForPublishedPaths(options.message, options.paths);
  runGit(["commit", "-m", commitMessage]);
  let sourceCommit = runGit(["rev-parse", "HEAD"]).trim();
  const reconciliationSourceCommit =
    rebaseStrategy === "reconcile-records" ? sourceCommit : undefined;
  let reconciliationTupleKeys: ReadonlySet<string> | undefined;
  if (rebaseStrategy === "reconcile-records") {
    gitPublishPhase("normalize");
    const normalized = normalizeReconciliationCommit(sourceCommit);
    sourceCommit = normalized.commit;
    if (!normalized.changed) {
      restoreWorktree(options.restorePaths ?? []);
      if (
        !pushReconciliationCommit({
          remote,
          branch,
          pushAttempts,
          maxAttempts,
          ...(reconciliationSourceCommit ? { reconciliationSourceCommit } : {}),
        })
      ) {
        throw new Error(`Failed to synchronize unchanged publish with ${remote}/${branch}`);
      }
      return completeStatePublish("unchanged", options.paths, stateBaseCommit);
    }
    const tupleKeys = reconciliationTupleKeysForCommit(sourceCommit);
    reconciliationTupleKeys = new Set(tupleKeys);
    if (tupleKeys.length > RECONCILIATION_TUPLE_CHUNK_SIZE) {
      restoreWorktree(options.restorePaths ?? []);
      const result = publishReconciliationChunks({
        remote,
        branch,
        pushAttempts,
        maxAttempts,
        sourceCommit: reconciliationSourceCommit ?? sourceCommit,
        tupleKeys,
      });
      return completeStatePublish(result, options.paths, stateBaseCommit);
    }
  }
  restoreWorktree(options.restorePaths ?? []);

  gitPublishPhase("push");
  if (rebaseStrategy === "reconcile-records") {
    if (
      !pushReconciliationCommit({
        remote,
        branch,
        pushAttempts,
        maxAttempts,
        ...(reconciliationSourceCommit ? { reconciliationSourceCommit } : {}),
        ...(reconciliationTupleKeys ? { reconciliationTupleKeys } : {}),
      })
    ) {
      throw new Error(
        "Failed to publish reconciliation without overwriting concurrent record tuples",
      );
    }
    return completeStatePublish("committed", options.paths, stateBaseCommit);
  }

  const publishPaths = uniqueNonEmpty(options.paths);
  if (publishPaths.length > 0 && publishPaths.every(isActionEventPublishPath)) {
    const result = pushImmutableActionLedgerCommit({
      remote,
      branch,
      message: commitMessage,
      paths: publishPaths,
      sourceCommit,
      maxAttempts,
      pushAttempts,
    });
    return completeStatePublish(result, options.paths, stateBaseCommit);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (
      pushCommit({
        remote,
        branch,
        pushAttempts,
        rebaseStrategy,
      })
    ) {
      return completeStatePublish("committed", options.paths, stateBaseCommit);
    }
    const rebuildResult = rebuildPublishCommit({
      remote,
      branch,
      message: commitMessage,
      paths: options.paths,
      sourceCommit,
    });
    if (rebuildResult === "unchanged") {
      return completeStatePublish("unchanged", options.paths, stateBaseCommit);
    }
    if (attempt === maxAttempts) break;
    const delaySeconds = attempt * 3 + Math.floor(Math.random() * 11);
    console.log(
      `Publish attempt ${attempt} failed; retrying from ${remote}/${branch} in ${delaySeconds}s`,
    );
    sleep(delaySeconds * 1000);
  }

  if (
    pushCommit({
      remote,
      branch,
      pushAttempts,
      rebaseStrategy,
    })
  ) {
    return completeStatePublish("committed", options.paths, stateBaseCommit);
  }
  throw new Error(`Failed to publish commit after ${maxAttempts} attempts`);
}

function pushImmutableActionLedgerCommit(options: {
  remote: string;
  branch: string;
  message: string;
  paths: readonly string[];
  sourceCommit: string;
  maxAttempts: number;
  pushAttempts: number;
}): PublishResult {
  // Keep both retry knobs additive. Their former nesting multiplied every
  // state race into another complete rebase loop. The floor must also outlast
  // sustained state writers: production exhausted 16 races while the same
  // immutable rebuild remained safe to retry.
  const pushBudget = Math.max(options.maxAttempts + options.pushAttempts + 1, 64);
  const previousCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
  const protectedWorktreePaths = captureDirtyWorktreePaths();
  let candidateCommit = options.sourceCommit;
  let unavailableObjectRecoveryUsed = false;
  const verifiedSourceObjectIds = new Set<string>();
  for (let attempt = 1; attempt <= pushBudget; attempt += 1) {
    const pushArgs = ["push", options.remote, `${candidateCommit}:${options.branch}`];
    const pushDisplayArgs = ["push", options.remote, `<commit>:${options.branch}`];
    let pushResult = spawnGit(pushArgs, { displayArgs: pushDisplayArgs });
    if (pushResult.status !== 0 && unavailableGitObjectIds(pushResult).length > 0) {
      if (unavailableObjectRecoveryUsed) {
        throw gitRunError(pushResult, pushArgs, pushDisplayArgs);
      }
      recoverUnavailableGitObjects(options.remote, options.branch, pushResult);
      unavailableObjectRecoveryUsed = true;
      const rebuilt = rebuildImmutableActionLedgerCommit({
        remote: options.remote,
        branch: options.branch,
        message: options.message,
        paths: options.paths,
        sourceCommit: options.sourceCommit,
        verifiedSourceObjectIds,
      });
      candidateCommit = rebuilt.commit;
      if (rebuilt.result === "unchanged") {
        finalizeImmutableActionLedgerCheckout({
          previousCommit,
          publishedCommit: candidateCommit,
          paths: options.paths,
          protectedWorktreePaths,
        });
        return "unchanged";
      }
      pushResult = spawnGit(["push", options.remote, `${candidateCommit}:${options.branch}`], {
        displayArgs: pushDisplayArgs,
      });
      if (pushResult.status !== 0 && unavailableGitObjectIds(pushResult).length > 0) {
        throw gitRunError(pushResult, pushArgs, pushDisplayArgs);
      }
    }
    if (pushResult.status === 0) {
      finalizeImmutableActionLedgerCheckout({
        previousCommit,
        publishedCommit: candidateCommit,
        paths: options.paths,
        protectedWorktreePaths,
      });
      return "committed";
    }
    const stateRepository = immutableLedgerStateRepository();
    if (attempt === 1 && stateRepository) {
      const publishedCommit = mergeImmutableActionLedgerOnGitHub({
        remote: options.remote,
        branch: options.branch,
        message: options.message,
        paths: options.paths,
        sourceCommit: options.sourceCommit,
        repository: stateRepository,
        token: stateRepositoryToken(),
        pushAttempts: options.pushAttempts,
      });
      finalizeImmutableActionLedgerCheckout({
        previousCommit,
        publishedCommit,
        paths: options.paths,
        protectedWorktreePaths,
      });
      return "committed";
    }
    if (attempt === pushBudget) break;

    // Build only the affected ancestor trees. The state checkout has hundreds
    // of thousands of entries, so rebuilding its full index is slower than the
    // production write rate and guarantees that every retry starts stale.
    let rebuilt;
    try {
      rebuilt = rebuildImmutableActionLedgerCommit({
        remote: options.remote,
        branch: options.branch,
        message: options.message,
        paths: options.paths,
        sourceCommit: options.sourceCommit,
        verifiedSourceObjectIds,
      });
    } catch (error) {
      if (unavailableObjectRecoveryUsed || unavailableGitObjectIds(error).length === 0) throw error;
      recoverUnavailableGitObjects(options.remote, options.branch, error);
      unavailableObjectRecoveryUsed = true;
      rebuilt = rebuildImmutableActionLedgerCommit({
        remote: options.remote,
        branch: options.branch,
        message: options.message,
        paths: options.paths,
        sourceCommit: options.sourceCommit,
        verifiedSourceObjectIds,
      });
    }
    candidateCommit = rebuilt.commit;
    if (rebuilt.result === "unchanged") {
      finalizeImmutableActionLedgerCheckout({
        previousCommit,
        publishedCommit: candidateCommit,
        paths: options.paths,
        protectedWorktreePaths,
      });
      return "unchanged";
    }
  }
  throw new Error(`Failed to publish commit after ${pushBudget} push attempts`);
}

function unavailableGitObjectIds(value: unknown): string[] {
  const message =
    typeof value === "object" && value && "stderr" in value
      ? `${String(value.stderr ?? "")}\n${String("stdout" in value ? value.stdout : "")}`
      : errorMessage(value);
  return [
    ...new Set(
      [...message.matchAll(/object ([a-f0-9]{40,64}) is unavailable/gi)].map((match) =>
        match[1]!.toLowerCase(),
      ),
    ),
  ];
}

function recoverUnavailableGitObjects(remote: string, branch: string, failure: unknown): void {
  const objectIds = unavailableGitObjectIds(failure);
  console.log(
    `Recovering ${objectIds.length || "unidentified"} unavailable Git object(s) from ${remote}`,
  );
  if (objectIds.length > 0) {
    objectIds.every(
      (objectId) =>
        spawnGit(["fetch", remote, objectId], {
          quiet: true,
          timeout: PUBLISH_FETCH_TIMEOUT_MS,
        }).status === 0,
    );
  }

  const shallow = isShallowRepository();
  const refetchDepth = shallow ? ["--depth=1"] : [];
  const refetched = spawnGit(["fetch", "--refetch", ...refetchDepth, remote, branch], {
    quiet: true,
    timeout: PUBLISH_FETCH_TIMEOUT_MS,
  });
  if (refetched.status === 0 && gitObjectIdsAvailable(objectIds)) return;
  if (!shallow) return;
  const deepened = spawnGit(["fetch", "--deepen=1", remote, branch], {
    quiet: true,
    timeout: PUBLISH_FETCH_TIMEOUT_MS,
  });
  if (deepened.status === 0 && (objectIds.length === 0 || gitObjectIdsAvailable(objectIds))) {
    return;
  }
  if (!isShallowRepository()) return;
  spawnGit(["fetch", "--unshallow", remote, branch], {
    quiet: true,
    timeout: PUBLISH_FETCH_TIMEOUT_MS,
  });
}

function gitObjectIdsAvailable(objectIds: readonly string[]): boolean {
  return objectIds.every(
    (objectId) => spawnGit(["cat-file", "-e", objectId], { quiet: true }).status === 0,
  );
}

function immutableLedgerStateRepository(): string | null {
  const repository = process.env.CLAWSWEEPER_STATE_REPOSITORY?.trim();
  if (!repository) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("CLAWSWEEPER_STATE_REPOSITORY must be an owner/repository slug");
  }
  return repository;
}

function stateRepositoryToken(): string {
  // actions/checkout v7 keeps credentials in a separate config selected by a
  // repository-local includeIf. Follow those includes explicitly while
  // retaining local scope so unrelated user or system credentials stay out.
  const config = runGit(
    ["config", "--includes", "--local", "--get-regexp", "^http\\..*\\.extraheader$"],
    { quiet: true },
  );
  for (const line of config.split("\n")) {
    const header = line.slice(line.indexOf(" ") + 1);
    const match = /^AUTHORIZATION:\s*basic\s+(\S+)$/i.exec(header);
    if (!match) continue;
    const credential = Buffer.from(match[1]!, "base64").toString("utf8");
    const separator = credential.indexOf(":");
    if (separator >= 0 && credential.slice(separator + 1)) {
      return credential.slice(separator + 1);
    }
  }
  throw new Error("State checkout credentials are required for immutable server merges");
}

function mergeImmutableActionLedgerOnGitHub(options: {
  remote: string;
  branch: string;
  message: string;
  paths: readonly string[];
  sourceCommit: string;
  repository: string;
  token: string;
  pushAttempts: number;
}): string {
  const runId = (process.env.GITHUB_RUN_ID ?? "local").replace(/[^A-Za-z0-9_.-]/g, "-");
  const runAttempt = (process.env.GITHUB_RUN_ATTEMPT ?? "1").replace(/[^A-Za-z0-9_.-]/g, "-");
  const temporaryBranch = `clawsweeper/immutable-ledger/${runId}-${runAttempt}-${process.pid}-${options.sourceCommit.slice(0, 12)}`;
  const temporaryRef = `refs/heads/${temporaryBranch}`;
  let pushed = false;
  try {
    for (let attempt = 1; attempt <= options.pushAttempts; attempt += 1) {
      if (
        spawnGit(["push", options.remote, `${options.sourceCommit}:${temporaryRef}`], {
          displayArgs: ["push", options.remote, `<commit>:${temporaryRef}`],
        }).status === 0
      ) {
        pushed = true;
        break;
      }
    }
    if (!pushed) throw new Error("Failed to publish immutable ledger temporary ref");

    // GitHub resolves the merge against the live base ref in one server-side
    // transaction, so a fast state writer cannot invalidate a locally rebuilt
    // commit between fetch and push.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      spawnGitHubApi(
        [
          "api",
          `repos/${options.repository}/merges`,
          "--method",
          "POST",
          "-f",
          `base=${options.branch}`,
          "-f",
          `head=${temporaryBranch}`,
          "-f",
          `commit_message=${options.message}`,
        ],
        options.repository,
        options.token,
      );
      fetchPublishRemote(options.remote, options.branch);
      const remoteCommit = runGit(["rev-parse", `${options.remote}/${options.branch}`], {
        quiet: true,
      }).trim();
      if (
        immutableActionLedgerPathsPresent({
          commit: remoteCommit,
          sourceCommit: options.sourceCommit,
          paths: options.paths,
        })
      ) {
        return remoteCommit;
      }
      console.log(`Server merge attempt ${attempt} did not publish the immutable ledger batch`);
    }
    throw new Error("Failed to publish immutable ledger through GitHub server merge");
  } finally {
    if (pushed) {
      spawnGitHubApi(
        [
          "api",
          `repos/${options.repository}/git/refs/heads/${temporaryBranch}`,
          "--method",
          "DELETE",
        ],
        options.repository,
        options.token,
      );
    }
  }
}

function spawnGitHubApi(args: readonly string[], repository: string, token: string): GitRunResult {
  recordGitProcess("gh-api");
  console.log(`$ gh api <immutable-ledger ${repository}>`);
  const child = spawnSync("gh", [...args], {
    cwd: publishRoot(),
    env: { ...process.env, GH_TOKEN: token },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0 && child.stderr) process.stderr.write(child.stderr);
  return {
    status: child.status ?? 1,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    timedOut: false,
  };
}

function immutableActionLedgerPathsPresent(options: {
  commit: string;
  sourceCommit: string;
  paths: readonly string[];
}): boolean {
  const sourceEntries = chunked(options.paths, GIT_PATHSPEC_BATCH_SIZE).flatMap((paths) =>
    readGitTreeEntries(["ls-tree", "-z", "--full-tree", options.sourceCommit, "--", ...paths]),
  );
  const remoteEntries = chunked(options.paths, GIT_PATHSPEC_BATCH_SIZE).flatMap((paths) =>
    readGitTreeEntries(["ls-tree", "-z", "--full-tree", options.commit, "--", ...paths]),
  );
  const sourceByPath = new Map(sourceEntries.map((entry) => [entry.name, entry]));
  const remoteByPath = new Map(remoteEntries.map((entry) => [entry.name, entry]));
  let allPresent = true;
  for (const path of options.paths) {
    const source = sourceByPath.get(path);
    if (!source || source.type !== "blob") {
      throw new Error(`Immutable action-ledger source path is not a blob: ${path}`);
    }
    const remote = remoteByPath.get(path);
    if (!remote) {
      allPresent = false;
      continue;
    }
    if (remote.type !== source.type || remote.mode !== source.mode || remote.oid !== source.oid) {
      throw new Error(`Immutable action-ledger path already has different content: ${path}`);
    }
  }
  return allPresent;
}

function pushReconciliationCommit(options: {
  remote: string;
  branch: string;
  pushAttempts: number;
  maxAttempts: number;
  reconciliationSourceCommit?: string;
  reconciliationTupleKeys?: ReadonlySet<string>;
}): boolean {
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (
      pushCommit({
        remote: options.remote,
        branch: options.branch,
        pushAttempts: options.pushAttempts,
        rebaseStrategy: "reconcile-records",
        ...(options.reconciliationSourceCommit
          ? { reconciliationSourceCommit: options.reconciliationSourceCommit }
          : {}),
        ...(options.reconciliationTupleKeys
          ? { reconciliationTupleKeys: options.reconciliationTupleKeys }
          : {}),
      })
    ) {
      return true;
    }
    if (attempt === options.maxAttempts) break;
    const delaySeconds = attempt * 3 + Math.floor(Math.random() * 11);
    console.log(
      `Reconciliation publish attempt ${attempt} lost continuous ${options.branch} races; retrying in ${delaySeconds}s`,
    );
    sleep(delaySeconds * 1000);
  }
  return pushCommit({
    remote: options.remote,
    branch: options.branch,
    pushAttempts: options.pushAttempts,
    rebaseStrategy: "reconcile-records",
    ...(options.reconciliationSourceCommit
      ? { reconciliationSourceCommit: options.reconciliationSourceCommit }
      : {}),
    ...(options.reconciliationTupleKeys
      ? { reconciliationTupleKeys: options.reconciliationTupleKeys }
      : {}),
  });
}

function completeStatePublish(
  result: PublishResult,
  paths: readonly string[],
  stateBaseCommit: string | null,
): PublishResult {
  gitPublishPhase("refresh", `paths=${uniqueNonEmpty(paths).length}`);
  refreshSourceAfterStatePublish(paths, stateBaseCommit);
  gitPublishPhase("complete", `result=${result}`);
  return result;
}

function gitPublishPhase(phase: string, detail = ""): void {
  if (activeGitPublishMetrics) activeGitPublishMetrics.phase = phase;
  console.log(`Git publish phase=${phase}${detail ? ` ${detail}` : ""}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : String(error);
}

function gitRunError(
  result: GitRunResult,
  args: readonly string[],
  displayArgs: readonly string[] = args,
): Error {
  const detail =
    result.stderr ||
    result.stdout ||
    `${formatGitDisplayCommand(displayArgs)} exited ${result.status}`;
  return new Error(detail.trim());
}

function mergeBaseWithShallowRecovery(
  left: string,
  right: string,
  remote: string,
  branch: string,
): { base: string | null; recoveredShallowMiss: boolean } {
  const args = ["merge-base", left, right];
  let result = spawnGit(args, { quiet: true });
  if (result.status === 0) {
    return { base: result.stdout.trim(), recoveredShallowMiss: false };
  }
  if (result.status !== 1) throw gitRunError(result, args);
  if (!isShallowRepository()) {
    return { base: null, recoveredShallowMiss: false };
  }

  const deepenArgs = ["fetch", "--deepen=32", remote, branch];
  const deepen = spawnGit(deepenArgs, {
    quiet: true,
    timeout: PUBLISH_FETCH_TIMEOUT_MS,
  });
  if (deepen.timedOut) throw new GitCommandTimeoutError(deepenArgs, PUBLISH_FETCH_TIMEOUT_MS);
  if (deepen.status !== 0) throw gitRunError(deepen, deepenArgs);
  result = spawnGit(args, { quiet: true });
  if (result.status === 0) {
    return { base: result.stdout.trim(), recoveredShallowMiss: true };
  }
  if (result.status !== 1) throw gitRunError(result, args);

  if (isShallowRepository()) {
    const unshallowArgs = ["fetch", "--unshallow", remote, branch];
    const unshallow = spawnGit(unshallowArgs, {
      quiet: true,
      timeout: PUBLISH_FETCH_TIMEOUT_MS,
    });
    if (unshallow.timedOut) {
      throw new GitCommandTimeoutError(unshallowArgs, PUBLISH_FETCH_TIMEOUT_MS);
    }
    if (unshallow.status !== 0) throw gitRunError(unshallow, unshallowArgs);
    result = spawnGit(args, { quiet: true });
    if (result.status === 0) {
      return { base: result.stdout.trim(), recoveredShallowMiss: true };
    }
  }
  if (result.status !== 1) throw gitRunError(result, args);
  if (isShallowRepository()) throw gitRunError(result, args);
  return { base: null, recoveredShallowMiss: true };
}

function prepareReconciliationStateRoot(
  remote: string,
  branch: string,
  rebaseStrategy: RebaseStrategy,
): void {
  const stateRoot = publishRoot();
  if (
    rebaseStrategy !== "reconcile-records" ||
    !stateRoot ||
    resolve(stateRoot) === resolve(process.cwd())
  ) {
    return;
  }
  gitPublishPhase("prepare");
  fetchPublishRemote(remote, branch);
  const remoteRef = `${remote}/${branch}`;
  if (spawnGit(["merge-base", "--is-ancestor", "HEAD", remoteRef], { quiet: true }).status === 0) {
    return;
  }
  const semanticBase = mergeBaseWithShallowRecovery("HEAD", remoteRef, remote, branch);
  if (!semanticBase.base) {
    console.log(
      `No common Git base with ${remoteRef}; resetting the unpublished reconciliation checkpoint to the remote head`,
    );
  } else if (semanticBase.recoveredShallowMiss) {
    console.log(
      `Recovered the common Git base with ${remoteRef} after hydrating the shallow state checkout`,
    );
  }
  console.log("Discarding an unpublished reconciliation checkpoint before retry");
  runGit(["reset", "--hard", semanticBase.base ?? remoteRef]);
}

function reconciliationTupleKeysForCommit(sourceCommit: string): string[] {
  const baseCommit = runGit(["rev-parse", `${sourceCommit}^`], { quiet: true }).trim();
  const keys = new Set<string>();
  for (const path of changedPathsBetween(baseCommit, sourceCommit)) {
    const identity = recordTupleIdentityForPath(path);
    if (!identity) throw new Error(`Unsupported reconciliation publish path: ${path}`);
    keys.add(recordTupleIdentityKey(identity));
  }
  return [...keys];
}

function publishReconciliationChunks(options: {
  remote: string;
  branch: string;
  pushAttempts: number;
  maxAttempts: number;
  sourceCommit: string;
  tupleKeys: readonly string[];
}): PublishResult {
  const chunks = chunked(options.tupleKeys, RECONCILIATION_TUPLE_CHUNK_SIZE);
  console.log(
    `Reconciliation checkpoint plan: tuples=${options.tupleKeys.length} chunks=${chunks.length} chunk_size=${RECONCILIATION_TUPLE_CHUNK_SIZE}`,
  );
  let committed = false;
  for (const [index, tupleKeys] of chunks.entries()) {
    gitPublishPhase("checkpoint", `chunk=${index + 1}/${chunks.length} tuples=${tupleKeys.length}`);
    fetchPublishRemote(options.remote, options.branch);
    const remoteRef = `${options.remote}/${options.branch}`;
    const remoteCommit = runGit(["rev-parse", remoteRef], { quiet: true }).trim();
    const allowedTupleKeys = new Set(tupleKeys);
    if (
      !rebuildReconciliationCommit(
        options.remote,
        options.branch,
        options.sourceCommit,
        allowedTupleKeys,
      )
    ) {
      throw new Error(`Failed to build reconciliation checkpoint ${index + 1}/${chunks.length}`);
    }
    const checkpointCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
    if (checkpointCommit === remoteCommit) {
      console.log(`Reconciliation checkpoint ${index + 1}/${chunks.length}: no changes remain`);
      continue;
    }
    committed = true;
    if (
      !pushReconciliationCommit({
        remote: options.remote,
        branch: options.branch,
        pushAttempts: options.pushAttempts,
        maxAttempts: options.maxAttempts,
        reconciliationSourceCommit: options.sourceCommit,
        reconciliationTupleKeys: allowedTupleKeys,
      })
    ) {
      throw new Error(`Failed to publish reconciliation checkpoint ${index + 1}/${chunks.length}`);
    }
    console.log(`Reconciliation checkpoint ${index + 1}/${chunks.length}: published`);
  }
  return committed ? "committed" : "unchanged";
}

export function captureStatePublishBaseline(): string | null {
  return publishRoot() ? runGit(["rev-parse", "HEAD"]).trim() : null;
}

export function refreshSourceAfterStatePublish(
  paths: readonly string[],
  stateBaseCommit: string | null,
): void {
  const stateRoot = publishRoot();
  if (!stateRoot) return;

  for (const path of uniqueNonEmpty(paths)) {
    refreshSourcePathFromState(path, stateRoot);
  }

  if (stateBaseCommit) {
    const publishedPaths = uniqueNonEmpty(paths).map(normalizedPublishPath);
    const changedPaths = runGit([
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      stateBaseCommit,
      "HEAD",
    ])
      .split("\0")
      .filter(Boolean);
    const authoritativeRecordPaths = learnedClosedRecordPaths(changedPaths, stateBaseCommit);
    for (const path of authoritativeRecordPaths) {
      if (!publishedPaths.some((root) => pathIsWithin(root, path))) {
        refreshSourcePathFromState(path, stateRoot);
      }
    }
    for (const path of changedPaths) {
      if (
        !isGeneratedPublishPath(path) ||
        publishedPaths.some((root) => pathIsWithin(root, path)) ||
        authoritativeRecordPaths.has(path)
      ) {
        continue;
      }
      // A narrow status publish can rebase over concurrent generated-state
      // changes. Import only files that still match the pre-rebase snapshot so
      // in-flight local work outside this publish remains authoritative.
      if (!sourcePathMatchesStateCommit(path, stateBaseCommit)) continue;
      refreshSourcePathFromState(path, stateRoot);
    }
  }
}

function learnedClosedRecordPaths(
  changedPaths: readonly string[],
  stateBaseCommit: string,
): Set<string> {
  const recordKeys = new Set<string>();
  for (const path of changedPaths) {
    const match = /^records\/([^/]+)\/(?:items|closed)\/([^/]+\.md)$/.exec(path);
    if (match) recordKeys.add(`${match[1]}/${match[2]}`);
  }

  const tuples = [...recordKeys].map((key) => {
    const separator = key.indexOf("/");
    const repository = key.slice(0, separator);
    const file = key.slice(separator + 1);
    const item = `records/${repository}/items/${file}`;
    const closed = `records/${repository}/closed/${file}`;
    return { repository, file, item, closed };
  });
  const existing = gitObjectExistence(
    tuples.flatMap(({ item, closed }) => [
      { commit: "HEAD", path: item },
      { commit: "HEAD", path: closed },
      { commit: stateBaseCommit, path: item },
      { commit: stateBaseCommit, path: closed },
    ]),
  );
  const hasPath = (commit: string, path: string): boolean =>
    existing.has(gitObjectSpec(commit, path));

  const authoritative = new Set<string>();
  for (const { repository, file, item, closed } of tuples) {
    if (
      !hasPath("HEAD", item) &&
      hasPath("HEAD", closed) &&
      (hasPath(stateBaseCommit, item) || !hasPath(stateBaseCommit, closed))
    ) {
      // A concurrent close is an authoritative state transition, matching the
      // delete-wins behavior of an apply-records rebase. Refresh the full
      // record tuple so pending open-item or plan edits cannot resurrect it.
      authoritative.add(item);
      authoritative.add(closed);
      authoritative.add(`records/${repository}/plans/${file}`);
      authoritative.add(`records/${repository}/decision-packets/${file.replace(/\.md$/, ".json")}`);
    }
  }
  return authoritative;
}

function refreshSourcePathFromState(path: string, stateRoot: string): void {
  const sourceRoot = resolve(".");
  const source = resolve(path);
  const published = resolve(stateRoot, path);
  if (!isPathInsideOrEqual(sourceRoot, source)) {
    throw new Error(`Refusing to refresh outside source root: ${path}`);
  }
  if (!isPathInsideOrEqual(stateRoot, published)) {
    throw new Error(`Refusing to refresh source from outside state root: ${path}`);
  }
  if (source === published) return;
  if (isPathInsideOrEqual(source, stateRoot)) {
    throw new Error(`Refusing to refresh a source path that contains the state root: ${path}`);
  }
  rmSync(source, { force: true, recursive: true });
  if (!existsSync(published)) return;
  mkdirSync(dirname(source), { recursive: true });
  cpSync(published, source, { recursive: true });
}

function sourcePathMatchesStateCommit(path: string, commit: string): boolean {
  const source = resolve(path);
  const committed = spawnGit(["rev-parse", "--verify", `${commit}:${path}`], {
    allowFailure: true,
  });
  if (committed.status !== 0) return !existsSync(source);
  if (!existsSync(source) || !statSync(source).isFile()) return false;
  const current = spawnGit(["hash-object", `--path=${path}`, source], { allowFailure: true });
  return current.status === 0 && current.stdout.trim() === committed.stdout.trim();
}

function normalizedPublishPath(path: string): string {
  return toPosixPath(path).replace(/^\.\//, "").replace(/\/+$/, "");
}

function pathIsWithin(root: string, path: string): boolean {
  return root === path || path.startsWith(`${root}/`);
}

function isGeneratedPublishPath(path: string): boolean {
  return GENERATED_PUBLISH_PATHS.some((root) => pathIsWithin(root, path));
}

export function publishRoot(): string | undefined {
  const root = process.env.CLAWSWEEPER_STATE_DIR || process.env.CLAWSWEEPER_PUBLISH_ROOT;
  return root ? resolve(root) : undefined;
}

function publishDefaultBranch(): string {
  return process.env.CLAWSWEEPER_PUBLISH_BRANCH || (publishRoot() ? "state" : "main");
}

export function syncPublishPaths(
  paths: readonly string[],
  options: { rebaseStrategy?: RebaseStrategy } = {},
): void {
  const stateRoot = publishRoot();
  if (stateRoot) syncStatePublishPaths(paths, stateRoot, options.rebaseStrategy ?? "normal");
}

function syncStatePublishPaths(
  paths: readonly string[],
  stateRoot: string,
  rebaseStrategy: RebaseStrategy,
): void {
  if (rebaseStrategy === "reconcile-records") {
    syncReconciliationStatePublishPaths(paths, stateRoot);
    return;
  }
  for (const path of uniqueNonEmpty(paths)) {
    const source = resolve(path);
    const destination = resolve(stateRoot, path);
    if (!isPathInsideOrEqual(stateRoot, destination)) {
      throw new Error(`Refusing to publish outside state root: ${path}`);
    }
    const statusMerges = planStateSweepStatusSyncs({ path, source, destination });
    const preserved = preserveStateOnlyFiles({ path, source, destination, rebaseStrategy });
    try {
      rmSync(destination, { force: true, recursive: true });
      if (existsSync(source)) {
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(source, destination, { recursive: true });
      }
      restorePreservedFiles(preserved, destination);
      applyStateSweepStatusSyncs(statusMerges, destination);
    } finally {
      rmSync(preserved.root, { force: true, recursive: true });
    }
  }
}

function syncReconciliationStatePublishPaths(paths: readonly string[], stateRoot: string): void {
  const copies = uniqueNonEmpty(paths).map((path) => {
    const normalized = normalizedPublishPath(path);
    if (
      !recordTupleIdentityForPath(normalized) &&
      !/^records\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(normalized)
    ) {
      throw new Error(`Unsupported reconciliation publish path: ${path}`);
    }
    const source = resolve(path);
    const destination = resolve(stateRoot, path);
    if (!isPathInsideOrEqual(stateRoot, destination)) {
      throw new Error(`Refusing to publish outside state root: ${path}`);
    }
    return { source, destination };
  });

  // Reconciliation intentionally copies the candidate snapshot exactly. Its
  // base-aware tuple normalizer restores newer base tuples before the first
  // push, so per-path preservation temp directories are both wrong and costly.
  for (const { source, destination } of copies) {
    rmSync(destination, { force: true, recursive: true });
    if (!existsSync(source)) continue;
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}

function planStateSweepStatusSyncs({
  path,
  source,
  destination,
}: {
  path: string;
  source: string;
  destination: string;
}): { rel: string; content: string }[] {
  if (!existsSync(source) || !existsSync(destination)) return [];
  const destinationFiles = listFiles(destination);
  const syncs: { rel: string; content: string }[] = [];
  for (const destinationFile of destinationFiles) {
    const rel = statSync(destination).isFile()
      ? ""
      : toPosixPath(relative(destination, destinationFile));
    const publishedPath = joinedPublishPath(path, rel);
    if (!/^results\/sweep-status\/[^/]+\.json$/.test(publishedPath)) continue;
    const sourceFile = rel ? resolve(source, rel) : source;
    if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) continue;
    syncs.push({
      rel,
      content: mergeSweepStatusJson({
        path: publishedPath,
        baseText: null,
        localText: readFileSync(sourceFile, "utf8"),
        remoteText: readFileSync(destinationFile, "utf8"),
      }),
    });
  }
  return syncs;
}

function applyStateSweepStatusSyncs(
  syncs: readonly { rel: string; content: string }[],
  destination: string,
): void {
  for (const sync of syncs) {
    const target = sync.rel ? resolve(destination, sync.rel) : destination;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, sync.content, "utf8");
  }
}

function preserveStateOnlyFiles({
  path,
  source,
  destination,
  rebaseStrategy,
}: {
  path: string;
  source: string;
  destination: string;
  rebaseStrategy: RebaseStrategy;
}): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-state-preserve-"));
  if (!existsSync(destination)) return { root, files: [] };
  if (!existsSync(source) && statSync(destination).isFile()) {
    // An exact-file publish with no source file is an intentional deletion.
    return { root, files: [] };
  }

  const files: string[] = [];
  for (const file of listFiles(destination)) {
    const rel = toPosixPath(relative(destination, file));
    if (existsSync(resolve(source, rel))) continue;
    if (
      !shouldPreserveStateOnlyFile(
        path,
        rel,
        (candidate) => existsSync(resolve(candidate)),
        rebaseStrategy,
      )
    ) {
      continue;
    }
    const target = resolve(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
    files.push(rel);
  }
  return { root, files };
}

function shouldPreserveStateOnlyFile(
  path: string,
  rel: string,
  sourceHasPath: (path: string) => boolean,
  rebaseStrategy: RebaseStrategy = "normal",
): boolean {
  if (path === "jobs")
    return /^[^/]+\/inbox\/(?:automerge|issue|self-heal|repair-pr)-.+\.md$/.test(rel);
  const publishedPath = joinedPublishPath(path, rel);
  if (!publishedPath.startsWith("records/")) return false;
  if (rebaseStrategy === "reconcile-records") {
    // Copy the candidate snapshot exactly. The base-aware tuple normalizer runs
    // before the first push and restores any semantically newer base tuple.
    // Preserving individual destination files here would hide intentional
    // whole-tuple and sidecar deletions from that atomic comparison.
    return false;
  }
  if (recordPrimaryCandidatesForSidecar(publishedPath).some(sourceHasPath)) {
    return false;
  }
  const counterpart = recordCounterpartPath(publishedPath);
  return !counterpart || !sourceHasPath(counterpart);
}

function recordPrimaryCandidatesForSidecar(path: string): string[] {
  const planMatch = /^records\/([^/]+)\/plans\/([^/]+\.md)$/.exec(path);
  if (planMatch?.[1] && planMatch[2]) {
    const root = `records/${planMatch[1]}`;
    return [`${root}/items/${planMatch[2]}`, `${root}/closed/${planMatch[2]}`];
  }
  const packetMatch = /^records\/([^/]+)\/decision-packets\/(\d+)\.json$/.exec(path);
  if (!packetMatch?.[1] || !packetMatch[2]) return [];
  const root = `records/${packetMatch[1]}`;
  const files = [`${packetMatch[2]}.md`, `${packetMatch[1]}-${packetMatch[2]}.md`];
  return files.flatMap((file) => [`${root}/items/${file}`, `${root}/closed/${file}`]);
}

function joinedPublishPath(path: string, rel: string): string {
  return [toPosixPath(path).replace(/\/+$/, ""), toPosixPath(rel).replace(/^\/+/, "")]
    .filter(Boolean)
    .join("/");
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function recordCounterpartPath(path: string): string | undefined {
  const match = /^records\/([^/]+)\/(items|closed|plans)\/([^/]+\.md)$/.exec(path);
  if (!match) return undefined;
  const [, repository, section, file] = match;
  if (section === "items") return `records/${repository}/closed/${file}`;
  if (section === "closed") return `records/${repository}/items/${file}`;
  return `records/${repository}/closed/${file}`;
}

function preserveStateOnlyCommitFiles({
  path,
  sourceCommit,
}: {
  path: string;
  sourceCommit: string;
}): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-state-preserve-"));
  const source = resolve(path);
  if (!existsSync(source)) return { root, files: [] };

  const files: string[] = [];
  const commitPathPrefix = path.replace(/\/+$/, "");
  for (const file of listFiles(source)) {
    const rel = toPosixPath(relative(source, file));
    const commitPath = joinedPublishPath(commitPathPrefix, rel);
    if (commitHasPath(sourceCommit, commitPath)) continue;
    if (
      !shouldPreserveStateOnlyFile(path, rel, (candidate) => commitHasPath(sourceCommit, candidate))
    ) {
      continue;
    }
    const target = resolve(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
    files.push(rel);
  }
  return { root, files };
}

function restorePreservedFiles(preserved: { root: string; files: string[] }, destination: string) {
  for (const rel of preserved.files) {
    const source = resolve(preserved.root, rel);
    const target = resolve(destination, rel);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
}

function listFiles(root: string): string[] {
  const stat = statSync(root);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    files.push(...listFiles(resolve(root, entry)));
  }
  return files;
}

export function pushCommit(options: {
  remote?: string;
  branch?: string;
  pushAttempts?: number;
  rebaseStrategy?: RebaseStrategy;
  reconciliationSourceCommit?: string;
  reconciliationTupleKeys?: ReadonlySet<string>;
  boundedRemoteHeadRebuild?: boolean;
}): boolean {
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? publishDefaultBranch();
  const pushAttempts = positiveInt(options.pushAttempts, 3);
  const rebaseStrategy = options.rebaseStrategy ?? "normal";

  for (let pushAttempt = 1; pushAttempt <= pushAttempts; pushAttempt += 1) {
    if (spawnGit(["push", remote, `HEAD:${branch}`]).status === 0) return true;
    console.log(`Push attempt ${pushAttempt} lost the ${branch} race; rebasing`);
    const localCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
    const localCommitMessage = runGit(["log", "-1", "--format=%B"], { quiet: true });
    fetchPublishRemote(remote, branch, { allowFailure: true });
    if (rebaseStrategy === "reconcile-records") {
      const remoteRef = `${remote}/${branch}`;
      const overlaps = reconciliationChangesOverlap(
        remoteRef,
        options.reconciliationSourceCommit,
        options.reconciliationTupleKeys,
      );
      if (!overlaps) {
        if (spawnGit(["rebase", remoteRef]).status === 0) {
          console.log("Rebased reconciliation over disjoint remote tuple changes");
          continue;
        }
        runGit(["rebase", "--abort"], { allowFailure: true });
      }
      if (
        !rebuildReconciliationCommit(
          remote,
          branch,
          options.reconciliationSourceCommit,
          options.reconciliationTupleKeys,
          options.boundedRemoteHeadRebuild,
        )
      ) {
        return false;
      }
      continue;
    }
    const remoteCommit = runGit(["rev-parse", `${remote}/${branch}`], { quiet: true }).trim();
    const mergeBase = spawnGit(["merge-base", localCommit, remoteCommit], { quiet: true });
    if (mergeBase.status !== 0) {
      // A shallow state checkout fetches racing pushes with --depth=1, so the
      // new remote head can share no local ancestry. Rebasing is impossible;
      // hand the race back to the caller, whose rebuild path re-applies this
      // publish directly on the fetched remote head.
      console.log(
        `No common Git base with ${remote}/${branch} after a lost push race; deferring to a remote-head rebuild`,
      );
      return false;
    }
    const baseCommit = mergeBase.stdout.trim();
    const statusMerges = planSweepStatusMerges({ baseCommit, localCommit, remoteCommit });
    const ledgerMerge = planCommentRouterLedgerMerge({ baseCommit, localCommit, remoteCommit });
    const rebaseArgs =
      rebaseStrategy === "theirs" || rebaseStrategy === "apply-records"
        ? ["rebase", "-X", "theirs", `${remote}/${branch}`]
        : ["rebase", `${remote}/${branch}`];
    if (spawnGit(rebaseArgs).status === 0) {
      applySweepStatusMerges({ statusMerges, remoteCommit, localCommitMessage });
      applyCommentRouterLedgerMerge({ ledgerMerge, remoteCommit, localCommitMessage });
      continue;
    }
    if (resolveCommentRouterLedgerConflict(ledgerMerge)) {
      applySweepStatusMerges({ statusMerges, remoteCommit, localCommitMessage });
      applyCommentRouterLedgerMerge({ ledgerMerge, remoteCommit, localCommitMessage });
      continue;
    }
    if (rebaseStrategy === "apply-records" && resolveApplyRecordConflicts(statusMerges)) {
      applySweepStatusMerges({ statusMerges, remoteCommit, localCommitMessage });
      applyCommentRouterLedgerMerge({ ledgerMerge, remoteCommit, localCommitMessage });
      continue;
    } else {
      runGit(["rebase", "--abort"], { allowFailure: true });
      return false;
    }
  }
  return spawnGit(["push", remote, `HEAD:${branch}`]).status === 0;
}

export function pushSingleRecordTupleCommit(options: {
  paths: readonly string[];
  remote?: string;
  branch?: string;
  pushAttempts?: number;
}): boolean {
  const reconciliationTupleKeys = recordTupleKeysForPaths(options.paths);
  if (reconciliationTupleKeys.size !== 1) {
    throw new Error(
      `Single-record reconciliation requires exactly one tuple; received ${reconciliationTupleKeys.size}`,
    );
  }
  const reconciliationSourceCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
  return pushCommit({
    ...(options.remote !== undefined ? { remote: options.remote } : {}),
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    ...(options.pushAttempts !== undefined ? { pushAttempts: options.pushAttempts } : {}),
    rebaseStrategy: "reconcile-records",
    reconciliationSourceCommit,
    reconciliationTupleKeys,
    boundedRemoteHeadRebuild: true,
  });
}

function reconciliationChangesOverlap(
  remoteRef: string,
  reconciliationSourceCommit?: string,
  allowedTupleKeys?: ReadonlySet<string>,
): boolean {
  const sourceCommit = reconciliationSourceCommit ?? "HEAD";
  const args = ["merge-base", sourceCommit, remoteRef];
  const mergeBase = spawnGit(args, { quiet: true });
  if (mergeBase.status !== 0) {
    if (mergeBase.status !== 1) throw gitRunError(mergeBase, args);
    console.log(
      `No common Git base with ${remoteRef}; deferring overlap detection to a remote-head rebuild`,
    );
    return true;
  }
  const baseCommit = mergeBase.stdout.trim();
  const localKeys = recordTupleKeysForPaths(changedPathsBetween(baseCommit, sourceCommit));
  const remoteKeys = recordTupleKeysForPaths(changedPathsBetween(baseCommit, remoteRef), true);
  for (const key of localKeys) {
    if ((!allowedTupleKeys || allowedTupleKeys.has(key)) && remoteKeys.has(key)) return true;
  }
  return false;
}

function recordTupleKeysForPaths(paths: readonly string[], ignoreUnsupported = false): Set<string> {
  const keys = new Set<string>();
  for (const path of paths) {
    const identity = recordTupleIdentityForPath(path);
    if (!identity) {
      if (ignoreUnsupported) continue;
      throw new Error(`Unsupported reconciliation publish path: ${path}`);
    }
    keys.add(recordTupleIdentityKey(identity));
  }
  return keys;
}

function rebuildReconciliationCommit(
  remote: string,
  branch: string,
  reconciliationSourceCommit?: string,
  allowedTupleKeys?: ReadonlySet<string>,
  boundedRemoteHeadRebuild = false,
): boolean {
  const remoteRef = `${remote}/${branch}`;
  const sourceCommit = reconciliationSourceCommit ?? runGit(["rev-parse", "HEAD"]).trim();
  const mergeBase = boundedRemoteHeadRebuild
    ? mergeBaseWithoutHydration(sourceCommit, remoteRef)
    : mergeBaseWithShallowRecovery(sourceCommit, remoteRef, remote, branch);
  let baseCommit: string;
  let localPaths: string[];
  if (!mergeBase.base) {
    if (!reconciliationSourceCommit || !allowedTupleKeys) {
      console.log(
        `No common Git base with ${remoteRef}; refusing an unbounded reconciliation rebuild`,
      );
      return false;
    }
    // A root checkpoint has no parent; the empty tree is the correct baseline
    // there (every publication path is new), so the initial-publication race
    // still reconciles instead of crashing on `<root>^`.
    const sourceParent = spawnGit(["rev-parse", `${sourceCommit}^`], { quiet: true });
    const sourceBaseCommit =
      sourceParent.status === 0
        ? sourceParent.stdout.trim()
        : runGit(["hash-object", "-w", "-t", "tree", "/dev/null"], { quiet: true }).trim();
    // The rebuilt commit is rooted on remoteRef below, but tuple arbitration
    // still needs the publication's real parent to recognize remote changes.
    baseCommit = sourceBaseCommit;
    localPaths = changedPathsBetween(sourceBaseCommit, sourceCommit);
    console.log(
      `No common Git base with ${remoteRef}; rebuilding reconciliation on the remote head`,
    );
  } else {
    baseCommit = mergeBase.base;
    localPaths = changedPathsBetween(baseCommit, sourceCommit);
    if (mergeBase.recoveredShallowMiss) {
      console.log(`Rebuilding reconciliation directly on ${remoteRef} after a shallow fetch`);
    }
  }
  const localIdentities = new Map<string, RecordTupleIdentity>();
  for (const path of localPaths) {
    const identity = recordTupleIdentityForPath(path);
    if (!identity) {
      console.log(`Unsupported reconciliation publish path: ${path}`);
      return false;
    }
    const key = recordTupleIdentityKey(identity);
    if (!allowedTupleKeys || allowedTupleKeys.has(key)) localIdentities.set(key, identity);
  }
  const knownTuplePaths = indexRecordTupleMarkdownPaths(
    [baseCommit, sourceCommit, remoteRef],
    new Set([...localIdentities.values()].map((identity) => identity.repository)),
    new Set(localIdentities.keys()),
  );
  const resolvedTuples = [...localIdentities].map(([key, identity]) => ({
    key,
    paths: resolveRecordTuplePaths({
      identity,
      changedPaths: [...localPaths, ...(knownTuplePaths.get(key) ?? [])],
    }),
  }));
  const snapshots = readRecordTupleSnapshots(
    resolvedTuples.flatMap(({ paths }) => [
      { commit: baseCommit, paths },
      { commit: sourceCommit, paths },
      { commit: remoteRef, paths },
    ]),
  );
  const selectedTuples: { paths: RecordTuplePaths; commit: string }[] = [];
  const deferredTupleKeys = new Set<string>();
  for (const [index, { key, paths }] of resolvedTuples.entries()) {
    const offset = index * 3;
    const winner = chooseReconciliationTupleWinner({
      base: snapshots[offset]!,
      local: snapshots[offset + 1]!,
      remote: snapshots[offset + 2]!,
    });
    if (winner === "local") selectedTuples.push({ paths, commit: sourceCommit });
    else if (winner === "base") selectedTuples.push({ paths, commit: baseCommit });
    else deferredTupleKeys.add(key);
  }

  if (deferredTupleKeys.size > 0) {
    console.log(
      `Deferring reconciliation for ${deferredTupleKeys.size} concurrently updated record tuple(s)`,
    );
  }

  runGit(["reset", "--hard", remoteRef]);
  const selectedPaths = applyRecordTupleSelections(selectedTuples);

  if (selectedPaths.length > 0) stagePaths(selectedPaths);
  if (!hasStagedChanges()) {
    console.log("No reconciliation changes remain after preserving concurrent record tuples");
    return true;
  }

  runGit(["commit", "-C", sourceCommit]);
  return true;
}

function mergeBaseWithoutHydration(
  left: string,
  right: string,
): { base: string | null; recoveredShallowMiss: false } {
  const args = ["merge-base", left, right];
  const result = spawnGit(args, { quiet: true });
  if (result.status === 0) {
    return { base: result.stdout.trim(), recoveredShallowMiss: false };
  }
  if (result.status !== 1) throw gitRunError(result, args);
  return { base: null, recoveredShallowMiss: false };
}

function normalizeReconciliationCommit(sourceCommit: string): {
  commit: string;
  changed: boolean;
} {
  const baseCommit = runGit(["rev-parse", `${sourceCommit}^`], { quiet: true }).trim();
  const localPaths = changedPathsBetween(baseCommit, sourceCommit);
  const identities = new Map<string, RecordTupleIdentity>();
  for (const path of localPaths) {
    const identity = recordTupleIdentityForPath(path);
    if (!identity) throw new Error(`Unsupported reconciliation publish path: ${path}`);
    identities.set(recordTupleIdentityKey(identity), identity);
  }
  gitPublishPhase("normalize", `tuples=${identities.size} paths=${localPaths.length}`);
  const knownTuplePaths = indexRecordTupleMarkdownPaths(
    [baseCommit, sourceCommit],
    new Set([...identities.values()].map((identity) => identity.repository)),
    new Set(identities.keys()),
  );
  const resolvedTuples = [...identities].map(([key, identity]) => ({
    key,
    paths: resolveRecordTuplePaths({
      identity,
      changedPaths: [...localPaths, ...(knownTuplePaths.get(key) ?? [])],
    }),
  }));
  const snapshots = readRecordTupleSnapshots(
    resolvedTuples.flatMap(({ paths }) => [
      { commit: baseCommit, paths },
      { commit: sourceCommit, paths },
    ]),
  );
  const selectedTuples: RecordTuplePaths[] = [];
  for (const [index, { paths }] of resolvedTuples.entries()) {
    const base = snapshots[index * 2]!;
    const local = snapshots[index * 2 + 1]!;
    const winner = chooseReconciliationTupleWinner({ base, local, remote: base });
    if (winner === "local") selectedTuples.push(paths);
  }

  if (selectedTuples.length === identities.size) {
    return { commit: sourceCommit, changed: true };
  }

  const discarded = identities.size - selectedTuples.length;
  console.log(`Discarding ${discarded} stale or ambiguous local record tuple(s) before push`);
  runGit(["reset", "--hard", baseCommit]);
  const selectedPaths = applyRecordTupleSelections(
    selectedTuples.map((paths) => ({ paths, commit: sourceCommit })),
  );
  if (selectedPaths.length > 0) stagePaths(selectedPaths);
  if (!hasStagedChanges()) return { commit: baseCommit, changed: false };
  runGit(["commit", "-C", sourceCommit]);
  return { commit: runGit(["rev-parse", "HEAD"]).trim(), changed: true };
}

function chooseReconciliationTupleWinner(options: {
  base: RecordTupleContents;
  local: RecordTupleContents;
  remote: RecordTupleContents;
}): RecordTupleWinner | undefined {
  // A malformed local tuple must still fail the publish. Once the candidate is
  // structurally valid, however, an unorderable legacy/base conflict can be
  // quarantined to this tuple instead of blocking every independent repair in
  // a broad reconciliation batch.
  validateRecordTuple(options.local, "local reconciliation");
  try {
    return chooseRecordTupleWinner(options);
  } catch (error) {
    if (!(error instanceof RecordTupleError)) throw error;
    console.log(
      `Deferring ambiguous reconciliation for ${options.local.paths.key}: ${error.message}`,
    );
    return undefined;
  }
}

function changedPathsBetween(from: string, to: string): string[] {
  return runGit(["diff", "--no-renames", "--name-only", "-z", from, to], { quiet: true })
    .split("\0")
    .filter(Boolean);
}

function resolveRecordTuplePaths(options: {
  identity: RecordTupleIdentity;
  changedPaths: readonly string[];
}): RecordTuplePaths {
  const markdownFiles = {
    items: new Set<string>(),
    closed: new Set<string>(),
    plans: new Set<string>(),
  };
  const collect = (path: string): void => {
    const identity = recordTupleIdentityForPath(path);
    if (
      !identity ||
      recordTupleIdentityKey(identity) !== recordTupleIdentityKey(options.identity)
    ) {
      return;
    }
    const section = /^records\/[^/]+\/(items|closed|plans)\//.exec(path)?.[1] as
      | keyof typeof markdownFiles
      | undefined;
    const markdownFile = recordTupleMarkdownFileForPath(path);
    if (section && markdownFile) markdownFiles[section].add(markdownFile);
  };
  for (const path of options.changedPaths) {
    collect(path);
  }
  for (const [section, files] of Object.entries(markdownFiles)) {
    if (files.size > 1) {
      throw new Error(
        `Invalid record tuple ${recordTupleIdentityKey(options.identity)}: ambiguous ${section} filenames ${[
          ...files,
        ].join(", ")}`,
      );
    }
  }
  const resolved: { item?: string; closed?: string; plan?: string } = {};
  const item = [...markdownFiles.items][0];
  const closed = [...markdownFiles.closed][0];
  const plan = [...markdownFiles.plans][0];
  if (item) resolved.item = item;
  if (closed) resolved.closed = closed;
  if (plan) resolved.plan = plan;
  return recordTuplePaths(options.identity, resolved);
}

function indexRecordTupleMarkdownPaths(
  commits: readonly string[],
  repositories: ReadonlySet<string>,
  targetKeys?: ReadonlySet<string>,
): Map<string, string[]> {
  const indexed = new Map<string, Set<string>>();
  for (const commit of commits) {
    for (const repository of repositories) {
      const root = `records/${repository}`;
      const paths = runGit(
        [
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          commit,
          "--",
          `${root}/items`,
          `${root}/closed`,
          `${root}/plans`,
        ],
        { quiet: true },
      )
        .split("\0")
        .filter(Boolean);
      for (const path of paths) {
        const identity = recordTupleIdentityForPath(path);
        if (!identity) continue;
        const key = recordTupleIdentityKey(identity);
        if (targetKeys && !targetKeys.has(key)) continue;
        const existing = indexed.get(key) ?? new Set<string>();
        existing.add(path);
        indexed.set(key, existing);
      }
    }
  }
  return new Map([...indexed].map(([key, paths]) => [key, [...paths]]));
}

type RecordTupleSnapshotRequest = { commit: string; paths: RecordTuplePaths };
type GitObjectRequest = { commit: string; path: string };

function readRecordTupleSnapshots(
  requests: readonly RecordTupleSnapshotRequest[],
): RecordTupleContents[] {
  const objects = readGitObjects(
    requests.flatMap(({ commit, paths }) =>
      recordTuplePathList(paths).map((path) => ({ commit, path })),
    ),
  );
  return requests.map(({ commit, paths }) => ({
    paths,
    item: objects.get(gitObjectSpec(commit, paths.item)) ?? null,
    closed: objects.get(gitObjectSpec(commit, paths.closed)) ?? null,
    plan: objects.get(gitObjectSpec(commit, paths.plan)) ?? null,
    packet: objects.get(gitObjectSpec(commit, paths.packet)) ?? null,
  }));
}

function readGitObjects(requests: readonly GitObjectRequest[]): Map<string, string | null> {
  const specs = uniqueNonEmpty(requests.map(({ commit, path }) => gitObjectSpec(commit, path)));
  const objects = new Map<string, string | null>();
  for (const batch of chunked(specs, GIT_OBJECT_BATCH_SIZE)) {
    const output = runGitObjectBatch("--batch", batch);
    let offset = 0;
    for (const spec of batch) {
      const newline = output.indexOf(0x0a, offset);
      if (newline < 0) throw new Error(`Malformed git cat-file batch header for ${spec}`);
      const header = output.subarray(offset, newline).toString("utf8");
      offset = newline + 1;
      if (header.endsWith(" missing")) {
        objects.set(spec, null);
        continue;
      }
      const match = /^([0-9a-f]+) ([^ ]+) (\d+)$/.exec(header);
      if (!match || match[2] !== "blob") {
        throw new Error(`Unexpected git cat-file batch response for ${spec}: ${header}`);
      }
      const size = Number(match[3]);
      if (!Number.isSafeInteger(size) || size < 0 || offset + size >= output.length) {
        throw new Error(`Invalid git cat-file batch size for ${spec}: ${match[3]}`);
      }
      const content = output.subarray(offset, offset + size).toString("utf8");
      offset += size;
      if (output[offset] !== 0x0a) {
        throw new Error(`Malformed git cat-file batch terminator for ${spec}`);
      }
      offset += 1;
      objects.set(spec, content);
    }
    if (offset !== output.length) {
      throw new Error("Unexpected trailing output from git cat-file batch");
    }
  }
  return objects;
}

function gitObjectExistence(requests: readonly GitObjectRequest[]): Set<string> {
  const specs = uniqueNonEmpty(requests.map(({ commit, path }) => gitObjectSpec(commit, path)));
  const existing = new Set<string>();
  for (const batch of chunked(specs, GIT_OBJECT_BATCH_SIZE)) {
    const lines = runGitObjectBatch("--batch-check", batch).toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length !== batch.length) {
      throw new Error(
        `Unexpected git cat-file batch-check response count: ${lines.length}/${batch.length}`,
      );
    }
    for (const [index, line] of lines.entries()) {
      if (line!.endsWith(" missing")) continue;
      if (!/^[0-9a-f]+ [^ ]+ \d+$/.test(line!)) {
        throw new Error(`Unexpected git cat-file batch-check response: ${line}`);
      }
      existing.add(batch[index]!);
    }
  }
  return existing;
}

function runGitObjectBatch(mode: "--batch" | "--batch-check", specs: readonly string[]): Buffer {
  recordGitProcess("cat-file");
  console.log("$ git cat-file <redacted-args>");
  const child = spawnSync("git", ["cat-file", mode], {
    cwd: publishRoot(),
    env: process.env,
    input: Buffer.from(`${specs.join("\n")}\n`, "utf8"),
    maxBuffer: GIT_OBJECT_BATCH_MAX_BUFFER,
  });
  if (child.error) throw child.error;
  const stdout = Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.from(child.stdout ?? "");
  const stderr = Buffer.isBuffer(child.stderr)
    ? child.stderr.toString("utf8")
    : String(child.stderr ?? "");
  if ((child.status ?? 1) !== 0) {
    throw new Error(stderr.trim() || `git cat-file ${mode} exited ${child.status ?? 1}`);
  }
  return stdout;
}

function gitObjectSpec(commit: string, path: string): string {
  const spec = `${commit}:${path}`;
  if (spec.includes("\n") || spec.includes("\0")) {
    throw new Error("Invalid newline or NUL in git object specification");
  }
  return spec;
}

function applyRecordTupleSelections(
  selections: readonly { paths: RecordTuplePaths; commit: string }[],
): string[] {
  const commitByPath = new Map<string, string>();
  for (const selection of selections) {
    for (const path of recordTuplePathList(selection.paths)) {
      const existing = commitByPath.get(path);
      if (existing && existing !== selection.commit) {
        throw new Error(`Conflicting tuple selections for ${path}`);
      }
      commitByPath.set(path, selection.commit);
    }
  }
  const selectedPaths = [...commitByPath.keys()];
  for (const batch of chunked(selectedPaths, GIT_PATHSPEC_BATCH_SIZE)) {
    runGit(["rm", "-r", "--ignore-unmatch", "--", ...batch], {
      allowFailure: true,
      quiet: true,
    });
  }

  const pathsByCommit = new Map<string, string[]>();
  for (const [path, commit] of commitByPath) {
    const paths = pathsByCommit.get(commit) ?? [];
    paths.push(path);
    pathsByCommit.set(commit, paths);
  }
  for (const [commit, paths] of pathsByCommit) {
    const existing = gitObjectExistence(paths.map((path) => ({ commit, path })));
    const checkoutPaths = paths.filter((path) => existing.has(gitObjectSpec(commit, path)));
    for (const batch of chunked(checkoutPaths, GIT_PATHSPEC_BATCH_SIZE)) {
      runGit(["checkout", commit, "--", ...batch]);
    }
  }
  return selectedPaths;
}

function recordTupleIdentityKey(identity: RecordTupleIdentity): string {
  return `${identity.repository}/${identity.number}`;
}

function rebuildPublishCommit(options: {
  remote: string;
  branch: string;
  message: string;
  paths: readonly string[];
  sourceCommit: string;
}): PublishResult {
  console.log(`Rebuilding publish commit on ${options.remote}/${options.branch}`);
  fetchPublishRemote(options.remote, options.branch);
  const remoteCommit = runGit(["rev-parse", `${options.remote}/${options.branch}`], {
    quiet: true,
  }).trim();
  const publishPaths = uniqueNonEmpty(options.paths);
  const statusMerges = planSweepStatusMerges({
    baseCommit: runGit(["rev-parse", `${options.sourceCommit}^`], { quiet: true }).trim(),
    localCommit: options.sourceCommit,
    remoteCommit,
    includeIndependent: true,
    pathspecs: options.paths,
  });
  const ledgerMerge = planCommentRouterLedgerMerge({
    baseCommit: runGit(["rev-parse", `${options.sourceCommit}^`], { quiet: true }).trim(),
    localCommit: options.sourceCommit,
    remoteCommit,
    includeIndependent: true,
    pathspecs: options.paths,
  });
  runGit(["reset", "--hard", remoteCommit]);

  for (const path of publishPaths) {
    const preserved = preserveStateOnlyCommitFiles({ path, sourceCommit: options.sourceCommit });
    try {
      runGit(["rm", "-r", "--ignore-unmatch", "--", path], { allowFailure: true });
      if (commitHasPath(options.sourceCommit, path)) {
        runGit(["checkout", options.sourceCommit, "--", path]);
      }
      restorePreservedFiles(preserved, resolve(path));
    } finally {
      rmSync(preserved.root, { force: true, recursive: true });
    }
  }

  applySweepStatusMergeFiles(statusMerges);
  applyCommentRouterLedgerMergeFiles(ledgerMerge ? [ledgerMerge] : []);
  stagePaths(options.paths);
  if (!hasStagedChanges()) {
    console.log("No publish changes after syncing remote");
    return "unchanged";
  }

  runGit(["commit", "-m", options.message]);
  return "committed";
}

function rebuildImmutableActionLedgerCommit(options: {
  remote: string;
  branch: string;
  message: string;
  paths: readonly string[];
  sourceCommit: string;
  verifiedSourceObjectIds: Set<string>;
}): { result: PublishResult; commit: string } {
  fetchPublishRemote(options.remote, options.branch);
  const remoteCommit = runGit(["rev-parse", `${options.remote}/${options.branch}`], {
    quiet: true,
  }).trim();
  const remoteTree = runGit(["rev-parse", `${remoteCommit}^{tree}`], { quiet: true }).trim();
  const tree = rewriteImmutableActionLedgerTree({
    remoteTree,
    sourceCommit: options.sourceCommit,
    paths: options.paths,
    verifiedSourceObjectIds: options.verifiedSourceObjectIds,
  });
  if (tree === remoteTree) {
    console.log("No immutable action-ledger changes after syncing remote");
    return { result: "unchanged", commit: remoteCommit };
  }

  const commit = runGit(["commit-tree", tree, "-p", remoteCommit, "-m", options.message]).trim();
  return { result: "committed", commit };
}

type GitTreeEntry = {
  mode: string;
  type: string;
  oid: string;
  name: string;
};

type GitTreePatch = {
  files: Map<string, GitTreeEntry>;
  directories: Map<string, GitTreePatch>;
};

function rewriteImmutableActionLedgerTree(options: {
  remoteTree: string;
  sourceCommit: string;
  paths: readonly string[];
  verifiedSourceObjectIds: Set<string>;
}): string {
  const patch: GitTreePatch = { files: new Map(), directories: new Map() };
  const sourceEntries = chunked(options.paths, GIT_PATHSPEC_BATCH_SIZE).flatMap((paths) =>
    readGitTreeEntries(["ls-tree", "-z", "--full-tree", options.sourceCommit, "--", ...paths]),
  );
  const sourceByPath = new Map(sourceEntries.map((entry) => [entry.name, entry]));
  for (const path of options.paths) {
    const entry = sourceByPath.get(path);
    if (!entry || entry.type !== "blob") {
      throw new Error(`Immutable action-ledger source path is not a blob: ${path}`);
    }
    addGitTreePatch(patch, path.split("/"), entry);
  }
  return writePatchedGitTree(options.remoteTree, patch, options.verifiedSourceObjectIds);
}

function addGitTreePatch(patch: GitTreePatch, parts: readonly string[], entry: GitTreeEntry): void {
  const [name, ...rest] = parts;
  if (!name) throw new Error("Immutable action-ledger path is empty");
  if (rest.length === 0) {
    patch.files.set(name, { ...entry, name });
    return;
  }
  const child = patch.directories.get(name) ?? { files: new Map(), directories: new Map() };
  patch.directories.set(name, child);
  addGitTreePatch(child, rest, entry);
}

function writePatchedGitTree(
  baseTree: string | null,
  patch: GitTreePatch,
  verifiedSourceObjectIds: Set<string>,
): string {
  const entries = new Map(
    (baseTree ? readGitTreeEntries(["ls-tree", "-z", baseTree]) : []).map((entry) => [
      entry.name,
      entry,
    ]),
  );
  for (const [name, childPatch] of patch.directories) {
    const existing = entries.get(name);
    if (existing && existing.type !== "tree") {
      throw new Error(`Immutable action-ledger directory collides with ${existing.type}: ${name}`);
    }
    const oid = writePatchedGitTree(existing?.oid ?? null, childPatch, verifiedSourceObjectIds);
    entries.set(name, { mode: "040000", type: "tree", oid, name });
  }
  const locallyRequiredEntries = [...patch.files].flatMap(([name, entry]) => {
    const existing = entries.get(name);
    return !existing ||
      existing.type !== entry.type ||
      existing.mode !== entry.mode ||
      existing.oid !== entry.oid
      ? [entry]
      : [];
  });
  assertLocalGitTreeEntries(locallyRequiredEntries, verifiedSourceObjectIds);
  for (const [name, entry] of patch.files) {
    const existing = entries.get(name);
    if (
      existing &&
      (existing.type !== entry.type || existing.mode !== entry.mode || existing.oid !== entry.oid)
    ) {
      throw new Error(`Immutable action-ledger path already has different content: ${name}`);
    }
    entries.set(name, entry);
  }
  const input = [...entries.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.name}\0`)
    .join("");
  // Unchanged entries came directly from the fetched remote tree. Their
  // objects may be omitted by a partial checkout, but the remote already has
  // them and does not need the client to include them in the push pack.
  return runGit(["mktree", "--missing", "-z"], { input, quiet: true }).trim();
}

function assertLocalGitTreeEntries(
  entries: readonly GitTreeEntry[],
  verifiedSourceObjectIds: Set<string>,
): void {
  const uniqueEntries = [
    ...new Map(
      entries
        .filter((entry) => !verifiedSourceObjectIds.has(entry.oid))
        .map((entry) => [entry.oid, entry]),
    ).values(),
  ];
  if (uniqueEntries.length === 0) return;
  const output = runGit(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: uniqueEntries.map((entry) => `${entry.oid}\n`).join(""),
    quiet: true,
  });
  const results = output.trimEnd().split("\n");
  for (const [index, entry] of uniqueEntries.entries()) {
    if (results[index] !== `${entry.oid} ${entry.type}`) {
      throw new Error(
        `Immutable action-ledger source object is unavailable locally: ${entry.name} (${entry.oid})`,
      );
    }
    verifiedSourceObjectIds.add(entry.oid);
  }
}

function readGitTreeEntries(args: readonly string[]): GitTreeEntry[] {
  // Immutable ledger directories are intentionally flat and can exceed the
  // general Git command cap. A lost push must still be able to rebuild their
  // containing tree without mistaking a truncated listing for a Git failure.
  return runGit(args, { maxBuffer: GIT_TREE_LIST_MAX_BUFFER, quiet: true })
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\t");
      const match = /^(\d+) ([a-z]+) ([a-f0-9]+)$/.exec(record.slice(0, separator));
      if (separator < 0 || !match) throw new Error("Git tree entry is malformed");
      return {
        mode: match[1]!,
        type: match[2]!,
        oid: match[3]!,
        name: record.slice(separator + 1),
      };
    });
}

function finalizeImmutableActionLedgerCheckout(options: {
  previousCommit: string;
  publishedCommit: string;
  paths: readonly string[];
  protectedWorktreePaths: ReadonlySet<string>;
}): void {
  const remoteWorktreePaths = changedPathsBetween(
    options.previousCommit,
    options.publishedCommit,
  ).filter(
    (path) =>
      !options.paths.includes(path) &&
      ![...options.protectedWorktreePaths].some(
        (protectedPath) => pathIsWithin(path, protectedPath) || pathIsWithin(protectedPath, path),
      ),
  );
  // Refresh the large checkout once, after the remote ref accepted the commit.
  // Its cost can no longer make the compare-and-swap candidate stale.
  runGit(["read-tree", "--reset", options.publishedCommit]);
  runGit(["update-ref", "HEAD", options.publishedCommit]);
  syncRemoteWorktreePaths(remoteWorktreePaths, options.publishedCommit);
}

function captureDirtyWorktreePaths(): ReadonlySet<string> {
  const tracked = runGit(["diff", "--name-only", "-z", "HEAD", "--"], { quiet: true });
  const untracked = runGit(["ls-files", "--others", "--directory", "--no-empty-directory", "-z"], {
    quiet: true,
  });
  return new Set(`${tracked}${untracked}`.split("\0").filter(Boolean).map(normalizedPublishPath));
}

function syncRemoteWorktreePaths(paths: readonly string[], commit: string): void {
  if (paths.length === 0) return;
  // Keep pre-existing local edits untouched, but materialize clean paths that
  // changed in the fetched parent so the worktree agrees with the new HEAD.
  const existing = gitObjectExistence(paths.map((path) => ({ commit, path })));
  const restorePaths = paths.filter((path) => existing.has(gitObjectSpec(commit, path)));
  const deletedPaths = paths.filter((path) => !existing.has(gitObjectSpec(commit, path)));
  for (const batch of chunked(restorePaths, GIT_PATHSPEC_BATCH_SIZE)) {
    runGit(["restore", `--source=${commit}`, "--worktree", "--", ...batch]);
  }
  for (const batch of chunked(deletedPaths, GIT_PATHSPEC_BATCH_SIZE)) {
    runGit(["clean", "-f", "-d", "-x", "--", ...batch]);
  }
}

function commitHasPath(commit: string, path: string): boolean {
  return (
    spawnGit(["cat-file", "-e", `${commit}:${path}`], {
      displayArgs: ["cat-file", "-e", "<commit>:<path>"],
    }).status === 0
  );
}

export function hardResetToRemoteMain(remote = "origin", branch = publishDefaultBranch()): void {
  fetchPublishRemote(remote, branch);
  runGit(["reset", "--hard", `${remote}/${branch}`]);
}

function fetchPublishRemote(remote: string, branch: string, options: GitRunOptions = {}): string {
  // Server-side immutable-ledger merges left merge-heavy ancestry on the state
  // branch. Preserve an existing shallow boundary without truncating complete
  // repositories whose reconciliation logic still needs full ancestry.
  const shallow = isShallowRepository();
  const depthArgs = shallow ? ["--depth=1"] : [];
  return runGit(["fetch", ...depthArgs, remote, branch], {
    ...options,
    timeout: PUBLISH_FETCH_TIMEOUT_MS,
  });
}

function isShallowRepository(): boolean {
  return runGit(["rev-parse", "--is-shallow-repository"], { quiet: true }).trim() === "true";
}

export function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function commitMessageForPublishedPaths(message: string, paths: readonly string[]): string {
  if (SKIP_CI_DIRECTIVE_PATTERN.test(message) || !onlyGeneratedPublishPaths(paths)) {
    return message;
  }
  return `${message.trimEnd()}\n\n[skip ci]`;
}

function onlyGeneratedPublishPaths(paths: readonly string[]): boolean {
  const uniquePaths = uniqueNonEmpty(paths);
  return (
    uniquePaths.length > 0 &&
    uniquePaths.every((path) =>
      GENERATED_PUBLISH_PATHS.some(
        (generatedPath) => path === generatedPath || path.startsWith(`${generatedPath}/`),
      ),
    )
  );
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

type SweepStatusMerge = {
  path: string;
  content: string;
};

function planSweepStatusMerges(options: {
  baseCommit?: string;
  localCommit: string;
  remoteCommit: string;
  includeIndependent?: boolean;
  pathspecs?: readonly string[];
}): SweepStatusMerge[] {
  const baseCommit =
    options.baseCommit ??
    runGit(["merge-base", options.localCommit, options.remoteCommit], { quiet: true }).trim();
  if (!baseCommit) {
    throw new Error("Refusing sweep status merge without a common Git base");
  }
  const localPaths = changedSweepStatusPaths(baseCommit, options.localCommit);
  const remotePaths = changedSweepStatusPaths(baseCommit, options.remoteCommit);
  const changedPaths = options.includeIndependent
    ? new Set([...localPaths, ...remotePaths])
    : new Set([...localPaths].filter((path) => remotePaths.has(path)));
  const mergePaths = [...changedPaths].filter(
    (path) =>
      !options.pathspecs ||
      options.pathspecs.some(
        (pathspec) => path === pathspec || path.startsWith(`${pathspec.replace(/\/+$/, "")}/`),
      ),
  );
  return mergePaths.sort().map((path) => ({
    path,
    content: mergeSweepStatusJson({
      path,
      baseText: readGitPath(baseCommit, path),
      localText: readGitPath(options.localCommit, path),
      remoteText: readGitPath(options.remoteCommit, path),
    }),
  }));
}

function changedSweepStatusPaths(baseCommit: string, commit: string): Set<string> {
  const output = runGit(
    ["diff", "--no-renames", "--name-only", "-z", baseCommit, commit, "--", "results/sweep-status"],
    { quiet: true },
  );
  return new Set(
    output.split("\0").filter((path) => /^results\/sweep-status\/[^/]+\.json$/.test(path)),
  );
}

function readGitPath(commit: string, path: string): string | null {
  const result = spawnGit(["show", `${commit}:${path}`], {
    allowFailure: true,
    displayArgs: ["show", "<commit>:<sweep-status-path>"],
    quiet: true,
  });
  return result.status === 0 ? result.stdout : null;
}

type CommentRouterLedgerMerge = { path: string; content: string };

function planCommentRouterLedgerMerge(options: {
  baseCommit?: string;
  localCommit: string;
  remoteCommit: string;
  includeIndependent?: boolean;
  pathspecs?: readonly string[];
}): CommentRouterLedgerMerge | null {
  const path = "results/comment-router.json";
  if (options.pathspecs && !gitPathspecsInclude(options.pathspecs, path)) {
    return null;
  }
  const baseCommit =
    options.baseCommit ??
    runGit(["merge-base", options.localCommit, options.remoteCommit], { quiet: true }).trim();
  if (!baseCommit)
    throw new Error("Refusing comment router ledger merge without a common Git base");
  const base = readGitPath(baseCommit, path);
  const local = readGitPath(options.localCommit, path);
  const remote = readGitPath(options.remoteCommit, path);
  if (!local || !remote) return null;
  const localChanged = local !== base;
  const remoteChanged = remote !== base;
  if (!localChanged || (!options.includeIndependent && !remoteChanged)) return null;
  return { path, content: mergeCommentRouterLedgers(local, remote) };
}

function gitPathspecsInclude(pathspecs: readonly string[], path: string): boolean {
  // Publish accepts Git pathspec syntax, including root and magic forms. Ask
  // Git to evaluate that contract so semantic merges cannot be bypassed by a
  // broader spelling than the literal generated path.
  return runGit(["ls-files", "-z", "--", ...uniqueNonEmpty(pathspecs)], { quiet: true })
    .split("\0")
    .includes(path);
}

function applyCommentRouterLedgerMergeFiles(merges: readonly CommentRouterLedgerMerge[]): void {
  const root = publishRoot() ?? resolve(".");
  for (const merge of merges) {
    const destination = resolve(root, merge.path);
    if (!isPathInsideOrEqual(root, destination)) {
      throw new Error(
        `Refusing to merge comment router ledger outside publish root: ${merge.path}`,
      );
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, merge.content, "utf8");
    runGit(["add", "--", merge.path]);
  }
}

function resolveCommentRouterLedgerConflict(ledgerMerge: CommentRouterLedgerMerge | null): boolean {
  if (!ledgerMerge) return false;
  const conflicts = runGit(["diff", "--name-only", "--diff-filter=U"], { allowFailure: true })
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  if (!conflicts.includes(ledgerMerge.path)) return false;
  applyCommentRouterLedgerMergeFiles([ledgerMerge]);
  if (conflicts.length > 1) return false;
  return spawnGit(["-c", "core.editor=true", "rebase", "--continue"]).status === 0;
}

function applyCommentRouterLedgerMerge(options: {
  ledgerMerge: CommentRouterLedgerMerge | null;
  remoteCommit: string;
  localCommitMessage: string;
}): void {
  if (!options.ledgerMerge) return;
  applyCommentRouterLedgerMergeFiles([options.ledgerMerge]);
  if (!hasStagedChanges()) return;
  if (spawnGit(["diff", "--cached", "--quiet", options.remoteCommit]).status === 0) {
    runGit(["reset", "--hard", options.remoteCommit]);
    return;
  }
  const commitsAhead = Number(
    runGit(["rev-list", "--count", `${options.remoteCommit}..HEAD`], { quiet: true }).trim(),
  );
  if (Number.isInteger(commitsAhead) && commitsAhead > 0)
    runGit(["commit", "--amend", "--no-edit"]);
  else runGit(["commit", "-m", options.localCommitMessage]);
}

function applySweepStatusMergeFiles(statusMerges: readonly SweepStatusMerge[]): void {
  const root = publishRoot() ?? resolve(".");
  for (const statusMerge of statusMerges) {
    const destination = resolve(root, statusMerge.path);
    if (!isPathInsideOrEqual(root, destination)) {
      throw new Error(`Refusing to merge sweep status outside publish root: ${statusMerge.path}`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, statusMerge.content, "utf8");
    runGit(["add", "--", statusMerge.path]);
  }
}

function applySweepStatusMerges(options: {
  statusMerges: readonly SweepStatusMerge[];
  remoteCommit: string;
  localCommitMessage: string;
}): void {
  if (options.statusMerges.length === 0) return;
  applySweepStatusMergeFiles(options.statusMerges);
  if (!hasStagedChanges()) return;
  if (spawnGit(["diff", "--cached", "--quiet", options.remoteCommit]).status === 0) {
    runGit(["reset", "--hard", options.remoteCommit]);
    return;
  }
  const commitsAhead = Number(
    runGit(["rev-list", "--count", `${options.remoteCommit}..HEAD`], { quiet: true }).trim(),
  );
  if (Number.isInteger(commitsAhead) && commitsAhead > 0) {
    runGit(["commit", "--amend", "--no-edit"]);
  } else {
    runGit(["commit", "-m", options.localCommitMessage]);
  }
}

function resolveApplyRecordConflicts(statusMerges: readonly SweepStatusMerge[]): boolean {
  const conflicts = runGit(["diff", "--name-only", "--diff-filter=U"], { allowFailure: true })
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  if (conflicts.length === 0) return false;

  const statusMergePaths = new Set(statusMerges.map((entry) => entry.path));
  applySweepStatusMergeFiles(statusMerges);

  for (const path of conflicts) {
    if (/^records\/[^/]+\/items\/[^/]+\.md$/.test(path)) {
      runGit(["rm", "-f", "--", path], { allowFailure: true });
    } else if (/^records\/[^/]+\/closed\/[^/]+\.md$/.test(path) || path === "apply-report.json") {
      runGit(["add", "--", path]);
    } else if (statusMergePaths.has(path)) {
      runGit(["add", "--", path]);
    } else {
      console.log(`Unsupported apply rebase conflict path: ${path}`);
      return false;
    }
  }

  return spawnGit(["-c", "core.editor=true", "rebase", "--continue"]).status === 0;
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
