import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

import {
  actionEventPublishContentsEquivalent,
  isActionEventPublishPath,
} from "../action-ledger.js";
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

export type GitRunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type GitPublishOptions = {
  message: string;
  paths: readonly string[];
  restorePaths?: readonly string[];
  maxAttempts?: number | undefined;
  pushAttempts?: number | undefined;
  remote?: string;
  branch?: string;
  coordination?: PublishCoordination | undefined;
  rebaseStrategy?: RebaseStrategy | undefined;
};

export type PublishCoordination = "exclusive" | "immutable";
export type RebaseStrategy = "normal" | "theirs" | "apply-records" | "reconcile-records";

export type GitRunOptions = {
  allowFailure?: boolean;
  deadlineAtMs?: number;
  displayArgs?: readonly string[];
  ignorePublishDeadline?: boolean;
  input?: string;
  quiet?: boolean;
};

export type PublishResult = "committed" | "unchanged";

const GENERATED_PUBLISH_PATHS = [
  "apply-report.json",
  "repair-apply-report.json",
  "jobs",
  "records",
  "results",
  "assets",
  "ledger",
] as const;
const GIT_PATHSPEC_BATCH_SIZE = 256;
const GIT_OBJECT_BATCH_SIZE = 512;
const GIT_OBJECT_BATCH_MAX_BUFFER = 64 * 1024 * 1024;
const RECONCILIATION_TUPLE_CHUNK_SIZE = 128;
const STATE_PUBLISH_LEASE_REF_ROOT = "refs/heads/clawsweeper-publish-lease";
export const STATE_PUBLISH_TIMING_DEFAULTS = Object.freeze({
  acquisitionDeadlineMs: 3 * 60 * 1000,
  operationDeadlineMs: 90 * 1000,
  commandTimeoutMs: 30 * 1000,
  immutableLeasePriorityMaxMs: 15 * 1000,
  leaseTtlMs: 2 * 60 * 1000,
  leaseMaxWaitMs: 15 * 1000,
  leaseProtocolVersion: 1,
  leaseProtocolMaxTtlMs: 2 * 60 * 1000,
  workflowMarginMs: 5 * 60 * 1000,
  workflowTimeoutMs: 15 * 60 * 1000,
});
const STATE_PUBLISH_LEASE_ISSUED_AT_SKEW_MS = 5 * 1000;
const STATE_PUBLISH_LEASE_ATTEMPTS = 24;
const STATE_PUBLISH_LEASE_WAIT_MS = 3 * 1000;
const STATE_PUBLISH_STALE_RECOVERY_ATTEMPTS = 2;
const SKIP_CI_DIRECTIVE_PATTERN =
  /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks:\s*true$/im;

type GitPublishMetrics = {
  startedAtMs: number;
  deadlineAtMs: number | null;
  commandTimeoutMs: number | null;
  operationDeadlineMs: number | null;
  leaseTtlMs: number | null;
  processes: number;
  actions: Map<string, number>;
  phase: string;
};

type StatePublishLease = {
  ref: string;
  oid: string;
  owner: string;
  expiresAtMs: number;
};

type ObservedStatePublishLease = {
  oid: string;
  owner: string;
  expiresAtMs: number;
};

let activeGitPublishMetrics: GitPublishMetrics | null = null;

validateStatePublishTimingDefaults();

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
  const timeout = gitCommandTimeoutMs(options);
  const child = spawnSync("git", [...args], {
    cwd: publishRoot(),
    env: process.env,
    encoding: "utf8",
    ...(options.input !== undefined ? { input: options.input } : {}),
    maxBuffer: 16 * 1024 * 1024,
    ...(timeout !== undefined ? { timeout } : {}),
  });
  if (child.error) {
    if ("code" in child.error && child.error.code === "ETIMEDOUT") {
      const deadlineAtMs = activeGitPublishMetrics?.deadlineAtMs;
      if (deadlineAtMs !== null && deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
        throw new Error(
          `State publication deadline exceeded while running git ${safeGitDisplayAction(args[0])}`,
        );
      }
      const error = new Error(
        `git ${safeGitDisplayAction(args[0])} timed out after ${timeout ?? 0}ms during state publication`,
      );
      (error as NodeJS.ErrnoException).code = "ETIMEDOUT";
      throw error;
    }
    throw child.error;
  }
  if (!options.quiet && child.stdout) process.stdout.write(child.stdout);
  if (!options.quiet && child.stderr) process.stderr.write(child.stderr);
  return {
    status: child.status ?? 1,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

function gitCommandTimeoutMs(options: GitRunOptions): number | undefined {
  const metrics = activeGitPublishMetrics;
  const publishDeadlineAtMs =
    options.ignorePublishDeadline || metrics?.deadlineAtMs === null
      ? undefined
      : (metrics?.deadlineAtMs ?? undefined);
  const deadlineAtMs =
    options.deadlineAtMs === undefined
      ? publishDeadlineAtMs
      : Math.min(options.deadlineAtMs, publishDeadlineAtMs ?? options.deadlineAtMs);
  if (!metrics?.commandTimeoutMs && deadlineAtMs === undefined) return undefined;
  if (deadlineAtMs === undefined) {
    return metrics?.commandTimeoutMs ?? undefined;
  }
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) {
    if (
      options.deadlineAtMs !== undefined &&
      (publishDeadlineAtMs === undefined || options.deadlineAtMs < publishDeadlineAtMs)
    ) {
      const error = new Error("Git command-specific deadline elapsed during state publication");
      (error as NodeJS.ErrnoException).code = "ETIMEDOUT";
      throw error;
    }
    throw new Error("State publication deadline exceeded before the next git command");
  }
  return Math.max(1, Math.min(metrics?.commandTimeoutMs ?? remaining, remaining));
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
    case "ls-files":
    case "push":
    case "rebase":
    case "remote":
    case "restore":
    case "reset":
    case "rev-parse":
    case "rm":
    case "status":
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
  const startedAtMs = Date.now();
  const coordination = options.coordination ?? "exclusive";
  validatePublishCoordination(options, coordination);
  const leased = coordination === "exclusive" && statePublishLeaseEnabled();
  const boundedImmutable = coordination === "immutable" && publishRoot() !== undefined;
  const timing = leased || boundedImmutable ? statePublishTiming() : null;
  const metrics: GitPublishMetrics = {
    startedAtMs,
    deadlineAtMs: timing
      ? startedAtMs + (leased ? timing.acquisitionDeadlineMs : timing.operationDeadlineMs)
      : null,
    commandTimeoutMs: timing?.commandTimeoutMs ?? null,
    operationDeadlineMs: timing?.operationDeadlineMs ?? null,
    leaseTtlMs: leased ? (timing?.leaseTtlMs ?? null) : null,
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
  if (options.coordination === "immutable") {
    return publishImmutableMainCommit(options);
  }
  if (!statePublishLeaseEnabled()) return publishMainCommitWithoutLease(options);
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? publishDefaultBranch();
  configureGitUser();
  gitPublishPhase("lease", `branch=${branch}`);
  const lease = acquireStatePublishLease(remote, branch);
  startStatePublishOperationDeadline(lease);
  try {
    return publishMainCommitWhileLeased(options, lease);
  } finally {
    releaseStatePublishLease(remote, lease);
  }
}

function validatePublishCoordination(
  options: GitPublishOptions,
  coordination: PublishCoordination,
): void {
  if (coordination !== "immutable") return;
  if ((options.rebaseStrategy ?? "normal") !== "normal") {
    throw new Error("Immutable action ledger publication requires the normal rebase strategy");
  }
  const paths = uniqueNonEmpty(options.paths);
  if (paths.length === 0 || paths.some((path) => !isActionEventPublishPath(path))) {
    throw new Error(
      "Immutable publication accepts only exact action ledger event and import-binding paths",
    );
  }
}

function publishImmutableMainCommit(options: GitPublishOptions): PublishResult {
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? publishDefaultBranch();
  const maxAttempts = positiveInt(options.maxAttempts, 32);
  const paths = uniqueNonEmpty(options.paths);
  const stateBaseCommit = captureStatePublishBaseline();
  const stateRoot = publishRoot();
  let stateCheckoutAdvanced = false;

  gitPublishPhase("sync", `paths=${paths.length} coordination=immutable`);
  try {
    if (stateRoot && resolve(stateRoot) !== resolve(process.cwd())) {
      runGit(["fetch", remote, branch]);
      runGit(["reset", "--hard", `${remote}/${branch}`]);
      stateCheckoutAdvanced = true;
    }

    syncPublishPaths(paths, { rebaseStrategy: "normal" });
    configureGitUser();
    gitPublishPhase("stage", `paths=${paths.length} coordination=immutable`);
    stagePaths(paths);
    if (!hasStagedChanges()) {
      console.log("No immutable publish changes");
      verifyRemotePublishedPaths("HEAD", remote, branch, paths);
      return completeStatePublish("unchanged", paths, stateBaseCommit);
    }

    const message = commitMessageForPublishedPaths(options.message, paths);
    runGit(["commit", "-m", message]);
    const sourceCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
    restoreWorktree(options.restorePaths ?? []);
    gitPublishPhase("push", `coordination=immutable`);
    const result = convergeImmutablePublish({
      remote,
      branch,
      paths,
      message,
      sourceCommit,
      maxAttempts,
    });
    return completeStatePublish(result, paths, stateBaseCommit);
  } catch (error) {
    if (stateCheckoutAdvanced) {
      try {
        restoreFailedLeasedStatePublish({
          remote,
          branch,
          paths,
          stateBaseCommit,
        });
      } catch (recoveryError) {
        throw new Error(
          `Immutable state publish failed: ${errorMessage(error)}; state/source recovery failed: ${errorMessage(recoveryError)}`,
        );
      }
    }
    throw error;
  }
}

function convergeImmutablePublish(options: {
  remote: string;
  branch: string;
  paths: readonly string[];
  message: string;
  sourceCommit: string;
  maxAttempts: number;
}): PublishResult {
  const observedLeases = new Map<string, ObservedStatePublishLease>();
  const exclusiveLeasePriorityDeadlineMs = immutableExclusiveLeasePriorityDeadlineMs();
  let exclusiveLeasePriorityExhausted = false;
  let exclusiveLeaseObserved = false;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    assertStatePublishDeadline("publishing immutable action ledger paths");
    if (!exclusiveLeasePriorityExhausted) {
      const priority = waitForExclusiveStatePublishLeaseGap(
        options.remote,
        options.branch,
        observedLeases,
        exclusiveLeasePriorityDeadlineMs,
        exclusiveLeaseObserved,
      );
      exclusiveLeasePriorityExhausted = priority.exhausted;
      exclusiveLeaseObserved = priority.observed;
    }
    const compatibility = immutableRemoteCompatibility({
      remote: options.remote,
      branch: options.branch,
      paths: options.paths,
      sourceCommit: options.sourceCommit,
    });
    if (compatibility.missing.length === 0) {
      verifyRemoteImmutablePaths(
        options.sourceCommit,
        options.remote,
        options.branch,
        options.paths,
      );
      return "unchanged";
    }
    const expectedCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
    let pushed = false;
    try {
      pushed =
        spawnGit(["push", options.remote, `HEAD:${options.branch}`], {
          allowFailure: true,
        }).status === 0;
    } catch (error) {
      if (!isGitTimeoutError(error)) throw error;
      console.log(
        `Immutable ${options.branch} push timed out attempt=${attempt}; verifying remote blobs`,
      );
    }
    if (
      pushed ||
      remotePublishedPathsMatch(expectedCommit, options.remote, options.branch, options.paths)
    ) {
      verifyRemoteImmutablePaths(expectedCommit, options.remote, options.branch, options.paths);
      return "committed";
    }

    const rebuild = rebuildImmutablePublishCommit({
      remote: options.remote,
      branch: options.branch,
      paths: options.paths,
      message: options.message,
      sourceCommit: options.sourceCommit,
    });
    if (rebuild === "unchanged") {
      verifyRemoteImmutablePaths(
        options.sourceCommit,
        options.remote,
        options.branch,
        options.paths,
      );
      return "unchanged";
    }
    if (attempt === options.maxAttempts) break;
    const waitMs = immutablePublishRetryWaitMs(attempt);
    console.log(
      `Immutable publish lost ${options.branch} race attempt=${attempt}/${options.maxAttempts}; retrying in ${waitMs}ms`,
    );
    sleepWithinStatePublishDeadline(waitMs, "waiting to retry immutable action ledger publication");
  }
  throw new Error(
    `Failed to publish immutable action ledger paths after ${options.maxAttempts} attempts`,
  );
}

function verifyRemoteImmutablePaths(
  sourceCommit: string,
  remote: string,
  branch: string,
  paths: readonly string[],
): void {
  gitPublishPhase("verify", `paths=${uniqueNonEmpty(paths).length} coordination=immutable`);
  const compatibility = immutableRemoteCompatibility({
    remote,
    branch,
    paths,
    sourceCommit,
  });
  if (compatibility.missing.length > 0) {
    throw new Error(`Remote ${remote}/${branch} is missing immutable action ledger paths`);
  }
  adoptVerifiedRemoteHead(remote, branch);
}

function rebuildImmutablePublishCommit(options: {
  remote: string;
  branch: string;
  paths: readonly string[];
  message: string;
  sourceCommit: string;
}): PublishResult {
  const compatibility = immutableRemoteCompatibility(options);
  const remoteCommit = compatibility.remoteCommit;
  const missing = compatibility.missing;

  runGit(["reset", "--hard", remoteCommit]);
  if (missing.length === 0) {
    console.log("Immutable action ledger paths are already published");
    return "unchanged";
  }
  for (const batch of chunked(missing, GIT_PATHSPEC_BATCH_SIZE)) {
    runGit(["checkout", options.sourceCommit, "--", ...batch]);
  }
  stagePaths(missing);
  if (!hasStagedChanges()) {
    throw new Error("Immutable action ledger rebuild produced no candidate changes");
  }
  runGit(["commit", "-m", options.message]);
  return "committed";
}

function immutableRemoteCompatibility(options: {
  remote: string;
  branch: string;
  paths: readonly string[];
  sourceCommit: string;
}): { remoteCommit: string; missing: string[] } {
  runGit(["fetch", options.remote, options.branch]);
  const remoteCommit = runGit(["rev-parse", `${options.remote}/${options.branch}`], {
    quiet: true,
  }).trim();
  const sourceObjects = gitObjectOids(
    options.paths.map((path) => ({ commit: options.sourceCommit, path })),
  );
  const remoteObjects = gitObjectOids(
    options.paths.map((path) => ({ commit: remoteCommit, path })),
  );
  const missing: string[] = [];
  const differing: string[] = [];
  for (const path of options.paths) {
    const sourceSpec = gitObjectSpec(options.sourceCommit, path);
    const remoteSpec = gitObjectSpec(remoteCommit, path);
    const sourceOid = sourceObjects.get(sourceSpec);
    if (!sourceOid) {
      throw new Error(`Immutable action ledger source path is missing: ${path}`);
    }
    const remoteOid = remoteObjects.get(remoteSpec);
    if (!remoteOid) {
      missing.push(path);
      continue;
    }
    if (remoteOid !== sourceOid) {
      differing.push(path);
    }
  }
  if (differing.length > 0) {
    const contents = readGitObjects(
      differing.flatMap((path) => [
        { commit: options.sourceCommit, path },
        { commit: remoteCommit, path },
      ]),
    );
    for (const path of differing) {
      const sourceContent = contents.get(gitObjectSpec(options.sourceCommit, path));
      const remoteContent = contents.get(gitObjectSpec(remoteCommit, path));
      if (
        sourceContent === null ||
        sourceContent === undefined ||
        remoteContent === null ||
        remoteContent === undefined ||
        !actionEventPublishContentsEquivalent(path, sourceContent, remoteContent)
      ) {
        throw new Error(`Immutable action ledger path conflict: ${path}`);
      }
    }
  }
  return { remoteCommit, missing };
}

function waitForExclusiveStatePublishLeaseGap(
  remote: string,
  branch: string,
  observedByOid: Map<string, ObservedStatePublishLease>,
  priorityDeadlineMs: number,
  previouslyObserved: boolean,
): { exhausted: boolean; observed: boolean } {
  const leaseRef = `${STATE_PUBLISH_LEASE_REF_ROOT}/${branch}`;
  let lastObserved: ObservedStatePublishLease | null = null;
  for (;;) {
    assertStatePublishDeadline("waiting for exclusive state publication");
    if (Date.now() >= priorityDeadlineMs) {
      if (lastObserved) {
        console.log(
          `Immutable publish priority yield exhausted; proceeding alongside active exclusive state lease owner=${lastObserved.owner}`,
        );
      } else if (previouslyObserved) {
        console.log(
          "Immutable publish priority yield exhausted after earlier exclusive lease contention; proceeding without further lease preference",
        );
      }
      return { exhausted: true, observed: previouslyObserved || lastObserved !== null };
    }
    let observed: ObservedStatePublishLease | null;
    try {
      observed = observeStatePublishLease(remote, leaseRef, observedByOid, priorityDeadlineMs);
    } catch (error) {
      if (!isGitTimeoutError(error)) throw error;
      console.log(
        "Immutable publish priority yield exhausted during lease observation; proceeding without further exclusive lease preference",
      );
      return { exhausted: true, observed: true };
    }
    lastObserved = observed;
    const now = Date.now();
    const remainingMs = observed ? observed.expiresAtMs - now : 0;
    if (!observed || remainingMs <= 0) {
      return { exhausted: false, observed: previouslyObserved || observed !== null };
    }
    const priorityRemainingMs = priorityDeadlineMs - now;
    if (priorityRemainingMs <= 0) {
      console.log(
        `Immutable publish priority yield exhausted; proceeding alongside active exclusive state lease owner=${observed.owner}`,
      );
      return { exhausted: true, observed: true };
    }
    const waitMs = Math.min(remainingMs, priorityRemainingMs, 1_000);
    console.log(
      `Immutable publish yielding to exclusive state lease owner=${observed.owner} wait_ms=${waitMs}`,
    );
    sleepWithinStatePublishDeadline(waitMs, "waiting for exclusive state publication");
  }
}

function immutableExclusiveLeasePriorityDeadlineMs(): number {
  const startedAtMs = activeGitPublishMetrics?.startedAtMs ?? Date.now();
  const operationDeadlineMs =
    activeGitPublishMetrics?.operationDeadlineMs ??
    STATE_PUBLISH_TIMING_DEFAULTS.operationDeadlineMs;
  const priorityBudgetMs = Math.min(
    STATE_PUBLISH_TIMING_DEFAULTS.immutableLeasePriorityMaxMs,
    Math.max(1, Math.floor(operationDeadlineMs / 6)),
  );
  const priorityDeadlineMs = startedAtMs + priorityBudgetMs;
  return Math.min(priorityDeadlineMs, activeGitPublishMetrics?.deadlineAtMs ?? priorityDeadlineMs);
}

function immutablePublishRetryWaitMs(attempt: number): number {
  const ceilingMs = Math.min(50 * 2 ** Math.min(Math.max(attempt - 1, 0), 5), 1_000);
  return Math.max(25, Math.floor(Math.random() * ceilingMs));
}

function publishMainCommitWithoutLease(options: GitPublishOptions): PublishResult {
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
      rebaseStrategy,
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

function publishMainCommitWhileLeased(
  options: GitPublishOptions,
  lease: StatePublishLease,
): PublishResult {
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? publishDefaultBranch();
  const rebaseStrategy = options.rebaseStrategy ?? "normal";
  gitPublishPhase(
    "sync",
    `paths=${uniqueNonEmpty(options.paths).length} strategy=${rebaseStrategy} lease=${lease.owner}`,
  );
  const stateBaseCommit = captureStatePublishBaseline();
  const remoteRef = `${remote}/${branch}`;
  const stateRoot = publishRoot();
  let stateCheckoutAdvanced = false;

  try {
    runGit(["fetch", remote, branch]);
    if (stateRoot && resolve(stateRoot) !== resolve(process.cwd())) {
      runGit(["reset", "--hard", remoteRef]);
      stateCheckoutAdvanced = true;
    }

    syncPublishPaths(options.paths, { rebaseStrategy });
    gitPublishPhase("stage", `paths=${uniqueNonEmpty(options.paths).length}`);
    stagePaths(options.paths);
    if (!hasStagedChanges()) {
      console.log("No publish changes");
      verifyRemotePublishedPaths("HEAD", remote, branch, options.paths);
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
        verifyRemotePublishedPaths("HEAD", remote, branch, options.paths);
        return completeStatePublish("unchanged", options.paths, stateBaseCommit);
      }
      const tupleKeys = reconciliationTupleKeysForCommit(sourceCommit);
      reconciliationTupleKeys = new Set(tupleKeys);
      if (tupleKeys.length > RECONCILIATION_TUPLE_CHUNK_SIZE) {
        restoreWorktree(options.restorePaths ?? []);
        const result = publishReconciliationChunks({
          remote,
          branch,
          pushAttempts: 1,
          maxAttempts: 1,
          sourceCommit: reconciliationSourceCommit ?? sourceCommit,
          tupleKeys,
          lease,
        });
        verifyRemotePublishedPaths("HEAD", remote, branch, options.paths);
        return completeStatePublish(result, options.paths, stateBaseCommit);
      }
    }
    restoreWorktree(options.restorePaths ?? []);

    gitPublishPhase("push");
    if (rebaseStrategy === "reconcile-records") {
      publishLeasedReconciliationHead({
        remote,
        branch,
        lease,
        paths: options.paths,
        ...(reconciliationSourceCommit ? { reconciliationSourceCommit } : {}),
        ...(reconciliationTupleKeys ? { reconciliationTupleKeys } : {}),
      });
      return completeStatePublish("committed", options.paths, stateBaseCommit);
    }

    const result = publishLeasedCommit({
      remote,
      branch,
      lease,
      message: commitMessage,
      paths: options.paths,
      sourceCommit,
      rebaseStrategy,
    });
    return completeStatePublish(result, options.paths, stateBaseCommit);
  } catch (error) {
    if (stateCheckoutAdvanced) {
      try {
        restoreFailedLeasedStatePublish({
          remote,
          branch,
          paths: options.paths,
          stateBaseCommit,
        });
      } catch (recoveryError) {
        throw new Error(
          `Leased state publish failed: ${errorMessage(error)}; state/source recovery failed: ${errorMessage(recoveryError)}`,
        );
      }
    }
    throw error;
  }
}

function restoreFailedLeasedStatePublish(options: {
  remote: string;
  branch: string;
  paths: readonly string[];
  stateBaseCommit: string | null;
}): void {
  gitPublishPhase("recover", `paths=${uniqueNonEmpty(options.paths).length}`);
  const metrics = activeGitPublishMetrics;
  const deadlineAtMs = metrics?.deadlineAtMs;
  if (metrics) metrics.deadlineAtMs = null;
  try {
    runGit(["fetch", options.remote, options.branch]);
    runGit(["reset", "--hard", `${options.remote}/${options.branch}`]);
    refreshSourceAfterStatePublish(options.paths, options.stateBaseCommit);
  } finally {
    if (metrics) metrics.deadlineAtMs = deadlineAtMs ?? null;
  }
}

function publishLeasedCommit(options: {
  remote: string;
  branch: string;
  lease: StatePublishLease;
  message: string;
  paths: readonly string[];
  sourceCommit: string;
  rebaseStrategy: RebaseStrategy;
}): PublishResult {
  for (let attempt = 1; ; attempt += 1) {
    const expectedCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
    const pushed = pushLeasedHead(options.remote, options.branch, options.lease);
    if (remotePublishedPathsMatch(expectedCommit, options.remote, options.branch, options.paths)) {
      if (!pushed) {
        console.log("Leased publish push was ambiguous but the expected blobs are remote");
      }
      adoptVerifiedRemoteHead(options.remote, options.branch);
      return "committed";
    }

    console.log(
      `Leased publish ${pushed ? "was superseded after an accepted push" : `lost an unexpected ${options.branch} race`}; rebuilding attempt=${attempt}`,
    );
    const rebuildResult = rebuildPublishCommit({
      remote: options.remote,
      branch: options.branch,
      message: options.message,
      paths: options.paths,
      sourceCommit: options.sourceCommit,
      rebaseStrategy: options.rebaseStrategy,
    });
    if (rebuildResult === "unchanged") {
      const rebuiltCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
      if (remotePublishedPathsMatch(rebuiltCommit, options.remote, options.branch, options.paths)) {
        adoptVerifiedRemoteHead(options.remote, options.branch);
        return "unchanged";
      }
    }
  }
}

function publishLeasedReconciliationHead(options: {
  remote: string;
  branch: string;
  lease: StatePublishLease;
  paths?: readonly string[];
  reconciliationSourceCommit?: string;
  reconciliationTupleKeys?: ReadonlySet<string>;
}): void {
  for (let attempt = 1; ; attempt += 1) {
    const expectedCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
    const pushed = pushLeasedHead(options.remote, options.branch, options.lease);
    if (
      remotePublishExpectationMatches(expectedCommit, options.remote, options.branch, options.paths)
    ) {
      if (!pushed) {
        console.log("Leased reconciliation push was ambiguous but the expected state is remote");
      }
      adoptVerifiedRemoteHead(options.remote, options.branch);
      return;
    }

    console.log(
      `Leased reconciliation ${pushed ? "was superseded after an accepted push" : `lost an unexpected ${options.branch} race`}; rebuilding attempt=${attempt}`,
    );
    runGit(["fetch", options.remote, options.branch]);
    const remoteRef = `${options.remote}/${options.branch}`;
    if (
      !rebuildReconciliationCommit(
        remoteRef,
        options.reconciliationSourceCommit,
        options.reconciliationTupleKeys,
      )
    ) {
      throw new Error("Failed to rebuild leased reconciliation publish");
    }
  }
}

function pushLeasedHead(remote: string, branch: string, lease: StatePublishLease): boolean {
  assertStatePublishLeaseOwner(remote, lease);
  try {
    return spawnGit(["push", remote, `HEAD:${branch}`]).status === 0;
  } catch (error) {
    if (!isGitTimeoutError(error)) throw error;
    console.log(`Leased ${branch} push timed out; verifying the expected remote state`);
    return false;
  }
}

function verifyRemotePublishedPaths(
  expectedCommit: string,
  remote: string,
  branch: string,
  paths: readonly string[],
): void {
  gitPublishPhase("verify", `paths=${uniqueNonEmpty(paths).length}`);
  if (!remotePublishedPathsMatch(expectedCommit, remote, branch, paths)) {
    throw new Error(`Remote ${remote}/${branch} failed expected-blob verification`);
  }
  adoptVerifiedRemoteHead(remote, branch);
}

function remotePublishedPathsMatch(
  expectedCommit: string,
  remote: string,
  branch: string,
  paths: readonly string[],
): boolean {
  runGit(["fetch", remote, branch]);
  const result = spawnGit(
    ["diff", "--quiet", expectedCommit, `${remote}/${branch}`, "--", ...uniqueNonEmpty(paths)],
    { allowFailure: true, quiet: true },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr.trim() || `Failed to verify expected blobs on ${remote}/${branch}`);
}

function remotePublishExpectationMatches(
  expectedCommit: string,
  remote: string,
  branch: string,
  paths?: readonly string[],
): boolean {
  if (paths) return remotePublishedPathsMatch(expectedCommit, remote, branch, paths);
  runGit(["fetch", remote, branch]);
  return runGit(["rev-parse", `${remote}/${branch}`], { quiet: true }).trim() === expectedCommit;
}

function adoptVerifiedRemoteHead(remote: string, branch: string): void {
  runGit(["reset", "--hard", `${remote}/${branch}`]);
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

function isGitTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
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
  runGit(["fetch", remote, branch]);
  const remoteRef = `${remote}/${branch}`;
  if (spawnGit(["merge-base", "--is-ancestor", "HEAD", remoteRef], { quiet: true }).status === 0) {
    return;
  }
  const semanticBase = runGit(["merge-base", "HEAD", remoteRef], { quiet: true }).trim();
  console.log("Discarding an unpublished reconciliation checkpoint before retry");
  runGit(["reset", "--hard", semanticBase]);
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
  lease?: StatePublishLease;
}): PublishResult {
  const chunks = chunked(options.tupleKeys, RECONCILIATION_TUPLE_CHUNK_SIZE);
  console.log(
    `Reconciliation checkpoint plan: tuples=${options.tupleKeys.length} chunks=${chunks.length} chunk_size=${RECONCILIATION_TUPLE_CHUNK_SIZE}`,
  );
  let committed = false;
  for (const [index, tupleKeys] of chunks.entries()) {
    gitPublishPhase("checkpoint", `chunk=${index + 1}/${chunks.length} tuples=${tupleKeys.length}`);
    runGit(["fetch", options.remote, options.branch]);
    const remoteRef = `${options.remote}/${options.branch}`;
    const remoteCommit = runGit(["rev-parse", remoteRef], { quiet: true }).trim();
    const allowedTupleKeys = new Set(tupleKeys);
    if (!rebuildReconciliationCommit(remoteRef, options.sourceCommit, allowedTupleKeys)) {
      throw new Error(`Failed to build reconciliation checkpoint ${index + 1}/${chunks.length}`);
    }
    const checkpointCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
    if (checkpointCommit === remoteCommit) {
      console.log(`Reconciliation checkpoint ${index + 1}/${chunks.length}: no changes remain`);
      continue;
    }
    committed = true;
    if (options.lease) {
      publishLeasedReconciliationHead({
        remote: options.remote,
        branch: options.branch,
        lease: options.lease,
        reconciliationSourceCommit: options.sourceCommit,
        reconciliationTupleKeys: allowedTupleKeys,
      });
    } else if (
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

function statePublishLeaseEnabled(): boolean {
  if (!publishRoot()) return false;
  const configured = process.env.CLAWSWEEPER_PUBLISH_LEASE?.trim().toLowerCase();
  return configured !== "0" && configured !== "false" && configured !== "off";
}

function validateStatePublishTimingDefaults(): void {
  const timing = STATE_PUBLISH_TIMING_DEFAULTS;
  if (timing.leaseTtlMs > timing.leaseProtocolMaxTtlMs) {
    throw new Error("Default state publish lease TTL exceeds the protocol maximum");
  }
  const recoveryFloorMs =
    timing.leaseProtocolMaxTtlMs + timing.leaseMaxWaitMs + timing.commandTimeoutMs;
  if (timing.acquisitionDeadlineMs <= recoveryFloorMs) {
    throw new Error("Default state publish acquisition deadline cannot recover an expired lease");
  }
  if (timing.operationDeadlineMs >= timing.leaseTtlMs) {
    throw new Error("Default state publish operation deadline must be shorter than the lease TTL");
  }
  if (timing.immutableLeasePriorityMaxMs >= timing.operationDeadlineMs) {
    throw new Error(
      "Default immutable lease priority budget must be shorter than the operation deadline",
    );
  }
  const workflowBoundMs =
    timing.acquisitionDeadlineMs +
    timing.operationDeadlineMs +
    timing.commandTimeoutMs +
    timing.workflowMarginMs;
  if (workflowBoundMs > timing.workflowTimeoutMs) {
    throw new Error("Default state publish deadlines exceed the workflow timeout margin");
  }
}

function statePublishTiming(): {
  acquisitionDeadlineMs: number;
  operationDeadlineMs: number;
  commandTimeoutMs: number;
  leaseTtlMs: number;
} {
  const acquisitionDeadlineMs = positiveEnvInt(
    "CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS",
    STATE_PUBLISH_TIMING_DEFAULTS.acquisitionDeadlineMs,
  );
  const operationDeadlineMs = positiveEnvInt(
    "CLAWSWEEPER_PUBLISH_DEADLINE_MS",
    STATE_PUBLISH_TIMING_DEFAULTS.operationDeadlineMs,
  );
  const commandTimeoutMs = positiveEnvInt(
    "CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS",
    STATE_PUBLISH_TIMING_DEFAULTS.commandTimeoutMs,
  );
  const leaseTtlMs = positiveEnvInt(
    "CLAWSWEEPER_PUBLISH_LEASE_TTL_MS",
    STATE_PUBLISH_TIMING_DEFAULTS.leaseTtlMs,
  );
  if (leaseTtlMs > STATE_PUBLISH_TIMING_DEFAULTS.leaseProtocolMaxTtlMs) {
    throw new Error(
      `State publish lease TTL ${leaseTtlMs}ms exceeds protocol maximum ${STATE_PUBLISH_TIMING_DEFAULTS.leaseProtocolMaxTtlMs}ms`,
    );
  }
  if (operationDeadlineMs >= leaseTtlMs) {
    throw new Error(
      `State publish operation deadline ${operationDeadlineMs}ms must be shorter than lease TTL ${leaseTtlMs}ms`,
    );
  }
  return {
    acquisitionDeadlineMs,
    operationDeadlineMs,
    commandTimeoutMs,
    leaseTtlMs,
  };
}

function startStatePublishOperationDeadline(lease: StatePublishLease): void {
  const metrics = activeGitPublishMetrics;
  if (!metrics?.operationDeadlineMs) return;
  metrics.deadlineAtMs = Math.min(Date.now() + metrics.operationDeadlineMs, lease.expiresAtMs - 1);
  assertStatePublishDeadline("starting the leased state publication");
}

function acquireStatePublishLease(remote: string, branch: string): StatePublishLease {
  const leaseRef = `${STATE_PUBLISH_LEASE_REF_ROOT}/${branch}`;
  runGit(["check-ref-format", leaseRef], { quiet: true });
  const owner = randomUUID();
  const ttlMs =
    activeGitPublishMetrics?.leaseTtlMs ??
    positiveEnvInt("CLAWSWEEPER_PUBLISH_LEASE_TTL_MS", STATE_PUBLISH_TIMING_DEFAULTS.leaseTtlMs);
  const maxAttempts = positiveEnvInt(
    "CLAWSWEEPER_PUBLISH_LEASE_ATTEMPTS",
    STATE_PUBLISH_LEASE_ATTEMPTS,
  );
  const waitMs = positiveEnvInt("CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS", STATE_PUBLISH_LEASE_WAIT_MS);
  const maxStaleRecoveries = positiveEnvInt(
    "CLAWSWEEPER_PUBLISH_STALE_RECOVERY_ATTEMPTS",
    STATE_PUBLISH_STALE_RECOVERY_ATTEMPTS,
  );
  const observedByOid = new Map<string, ObservedStatePublishLease>();
  let staleRecoveries = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assertStatePublishDeadline("acquiring the remote state publish lease");
    const observed = observeStatePublishLease(remote, leaseRef, observedByOid);
    const now = Date.now();
    if (!observed || observed.expiresAtMs <= now) {
      if (observed && staleRecoveries >= maxStaleRecoveries) {
        throw new Error(
          `State publish lease remained stale after ${maxStaleRecoveries} recovery attempts`,
        );
      }
      const expiresAtMs = now + ttlMs;
      const leaseOid = createStatePublishLeaseCommit({
        branch,
        owner,
        issuedAtMs: now,
        expiresAtMs,
        ttlMs,
      });
      const expectedOid = observed?.oid ?? "";
      let acquired = false;
      let timeoutRecovered = false;
      try {
        acquired =
          spawnGit(
            [
              "push",
              `--force-with-lease=${leaseRef}:${expectedOid}`,
              remote,
              `${leaseOid}:${leaseRef}`,
            ],
            { allowFailure: true, quiet: true },
          ).status === 0;
      } catch (error) {
        if (!isGitTimeoutError(error)) throw error;
        console.log(
          `State publish lease push timed out owner=${owner} attempt=${attempt}; verifying remote ownership`,
        );
        acquired = remoteRefOid(remote, leaseRef) === leaseOid;
        timeoutRecovered = acquired;
        if (!acquired) {
          console.log(
            `State publish lease push timeout was not accepted owner=${owner} attempt=${attempt}; retrying`,
          );
        }
      }
      if (acquired) {
        console.log(
          `Acquired state publish lease owner=${owner} attempt=${attempt} stale_recovery=${observed ? "true" : "false"} timeout_recovered=${timeoutRecovered ? "true" : "false"}`,
        );
        return { ref: leaseRef, oid: leaseOid, owner, expiresAtMs };
      }
      if (observed) staleRecoveries += 1;
    } else {
      console.log(
        `State publish lease busy owner=${observed.owner} attempt=${attempt}/${maxAttempts}`,
      );
    }
    if (attempt < maxAttempts) {
      sleepWithinStatePublishDeadline(statePublishLeaseWaitMs(waitMs, attempt));
    }
  }
  throw new Error(`Failed to acquire state publish lease after ${maxAttempts} attempts`);
}

function statePublishLeaseWaitMs(waitMs: number, attempt: number): number {
  const multiplier = 2 ** Math.min(Math.max(attempt - 1, 0), 10);
  return Math.min(waitMs * multiplier, STATE_PUBLISH_TIMING_DEFAULTS.leaseMaxWaitMs);
}

function observeStatePublishLease(
  remote: string,
  leaseRef: string,
  observedByOid: Map<string, ObservedStatePublishLease>,
  deadlineAtMs?: number,
): ObservedStatePublishLease | null {
  const oid = remoteRefOid(remote, leaseRef, deadlineAtMs);
  if (!oid) return null;
  const cached = observedByOid.get(oid);
  if (cached) return cached;

  const fetch = spawnGit(["fetch", "--no-tags", "--quiet", remote, leaseRef], {
    allowFailure: true,
    ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    quiet: true,
  });
  if (fetch.status !== 0) {
    if (!remoteRefOid(remote, leaseRef, deadlineAtMs)) {
      observedByOid.delete(oid);
      return null;
    }
    throw new Error(
      fetch.stderr.trim() || `Failed to fetch remote state publish lease ${leaseRef}`,
    );
  }
  const raw = runGit(["show", "-s", "--format=%H%x00%ct%x00%B", "FETCH_HEAD"], {
    ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    quiet: true,
  });
  const [fetchedOid, committedAtRaw, ...messageParts] = raw.split("\0");
  if (!fetchedOid || !/^[a-f0-9]{40,64}$/.test(fetchedOid)) {
    throw new Error("Remote state publish lease did not resolve to a commit");
  }
  const committedAtMs = Number(committedAtRaw) * 1000;
  const message = messageParts.join("\0");
  const owner = /^owner: ([0-9a-f-]+)$/m.exec(message)?.[1] ?? "unknown";
  const protocolVersion = Number(/^lease_protocol: ([0-9]+)$/m.exec(message)?.[1] ?? "");
  const advertisedTtlMs = Number(/^ttl_ms: ([0-9]+)$/m.exec(message)?.[1] ?? "");
  const validAdvertisedTtl =
    protocolVersion === STATE_PUBLISH_TIMING_DEFAULTS.leaseProtocolVersion &&
    Number.isSafeInteger(advertisedTtlMs) &&
    advertisedTtlMs > 0 &&
    advertisedTtlMs <= STATE_PUBLISH_TIMING_DEFAULTS.leaseProtocolMaxTtlMs;
  const ownerTtlMs = validAdvertisedTtl
    ? advertisedTtlMs
    : STATE_PUBLISH_TIMING_DEFAULTS.leaseProtocolMaxTtlMs;
  const parsedIssuedAt = Date.parse(/^issued_at: (.+)$/m.exec(message)?.[1] ?? "");
  const validCommittedAt = Number.isFinite(committedAtMs) && committedAtMs > 0;
  const validIssuedAt =
    Number.isFinite(parsedIssuedAt) &&
    parsedIssuedAt > 0 &&
    validCommittedAt &&
    Math.abs(parsedIssuedAt - committedAtMs) <= STATE_PUBLISH_LEASE_ISSUED_AT_SKEW_MS;
  const issuedAtMs = validIssuedAt ? parsedIssuedAt : Date.now();
  const parsedExpiry = Date.parse(/^expires_at: (.+)$/m.exec(message)?.[1] ?? "");
  const reportedExpiresAtMs =
    Number.isFinite(parsedExpiry) && parsedExpiry >= issuedAtMs
      ? parsedExpiry
      : issuedAtMs + ownerTtlMs;
  const observed = {
    oid: fetchedOid,
    owner,
    expiresAtMs: Math.min(
      reportedExpiresAtMs,
      issuedAtMs + ownerTtlMs,
      Date.now() + STATE_PUBLISH_TIMING_DEFAULTS.leaseProtocolMaxTtlMs,
    ),
  };
  observedByOid.set(observed.oid, observed);
  return observed;
}

function createStatePublishLeaseCommit(options: {
  branch: string;
  owner: string;
  issuedAtMs: number;
  expiresAtMs: number;
  ttlMs: number;
}): string {
  const tree = runGit(["mktree"], { input: "", quiet: true }).trim();
  if (!tree) throw new Error("Failed to create the state publish lease tree");
  const message = [
    "ClawSweeper state publish lease",
    "",
    `owner: ${options.owner}`,
    `branch: ${options.branch}`,
    `lease_protocol: ${STATE_PUBLISH_TIMING_DEFAULTS.leaseProtocolVersion}`,
    `issued_at: ${new Date(options.issuedAtMs).toISOString()}`,
    `ttl_ms: ${options.ttlMs}`,
    `expires_at: ${new Date(options.expiresAtMs).toISOString()}`,
    "",
  ].join("\n");
  return runGit(["commit-tree", tree], {
    input: message,
    quiet: true,
  }).trim();
}

function releaseStatePublishLease(remote: string, lease: StatePublishLease): void {
  try {
    const result = spawnGit(
      ["push", `--force-with-lease=${lease.ref}:${lease.oid}`, remote, `:${lease.ref}`],
      {
        allowFailure: true,
        ignorePublishDeadline: true,
        quiet: true,
      },
    );
    if (result.status === 0) {
      console.log(`Released state publish lease owner=${lease.owner}`);
    } else {
      console.log(
        `State publish lease release skipped owner=${lease.owner}; ownership changed or remote cleanup failed`,
      );
    }
  } catch (error) {
    console.log(
      `State publish lease release failed owner=${lease.owner}; expiry will recover it: ${errorMessage(error)}`,
    );
  }
}

function assertStatePublishLeaseOwner(remote: string, lease: StatePublishLease): void {
  if (Date.now() >= lease.expiresAtMs) {
    throw new Error("State publish lease expired before branch publication");
  }
  const remoteOid = remoteRefOid(remote, lease.ref);
  if (remoteOid !== lease.oid) {
    throw new Error("State publish lease ownership changed before branch publication");
  }
}

function remoteRefOid(remote: string, ref: string, deadlineAtMs?: number): string | null {
  const result = spawnGit(["ls-remote", "--refs", remote, ref], {
    allowFailure: true,
    ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    quiet: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Failed to inspect remote ref ${ref}`);
  }
  const output = result.stdout.trim();
  if (!output) return null;
  const match = /^([a-f0-9]{40,64})\s+(.+)$/.exec(output);
  if (!match || match[2] !== ref) throw new Error(`Malformed remote ref response for ${ref}`);
  return match[1]!;
}

function assertStatePublishDeadline(action: string): void {
  const deadlineAtMs = activeGitPublishMetrics?.deadlineAtMs;
  if (deadlineAtMs !== null && deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    throw new Error(`State publication deadline exceeded while ${action}`);
  }
}

function sleepWithinStatePublishDeadline(
  milliseconds: number,
  action = "waiting for the remote lease",
): void {
  const deadlineAtMs = activeGitPublishMetrics?.deadlineAtMs;
  const remaining =
    deadlineAtMs === null || deadlineAtMs === undefined
      ? milliseconds
      : Math.min(milliseconds, deadlineAtMs - Date.now());
  if (remaining <= 0) {
    throw new Error(`State publication deadline exceeded while ${action}`);
  }
  sleep(remaining);
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
    runGit(["fetch", remote, branch], { allowFailure: true });
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
          remoteRef,
          options.reconciliationSourceCommit,
          options.reconciliationTupleKeys,
        )
      ) {
        return false;
      }
      continue;
    }
    const remoteCommit = runGit(["rev-parse", `${remote}/${branch}`], { quiet: true }).trim();
    const statusMerges = planSweepStatusMerges({ localCommit, remoteCommit });
    const rebaseArgs =
      rebaseStrategy === "theirs" || rebaseStrategy === "apply-records"
        ? ["rebase", "-X", "theirs", `${remote}/${branch}`]
        : ["rebase", `${remote}/${branch}`];
    if (spawnGit(rebaseArgs).status === 0) {
      applySweepStatusMerges({ statusMerges, remoteCommit, localCommitMessage });
      continue;
    }
    if (rebaseStrategy === "apply-records" && resolveApplyRecordConflicts(statusMerges)) {
      applySweepStatusMerges({ statusMerges, remoteCommit, localCommitMessage });
      continue;
    } else {
      runGit(["rebase", "--abort"], { allowFailure: true });
      return false;
    }
  }
  return spawnGit(["push", remote, `HEAD:${branch}`]).status === 0;
}

function reconciliationChangesOverlap(
  remoteRef: string,
  reconciliationSourceCommit?: string,
  allowedTupleKeys?: ReadonlySet<string>,
): boolean {
  const sourceCommit = reconciliationSourceCommit ?? "HEAD";
  const baseCommit = runGit(["merge-base", sourceCommit, remoteRef], { quiet: true }).trim();
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
  remoteRef: string,
  reconciliationSourceCommit?: string,
  allowedTupleKeys?: ReadonlySet<string>,
): boolean {
  const sourceCommit = reconciliationSourceCommit ?? runGit(["rev-parse", "HEAD"]).trim();
  const baseCommit = runGit(["merge-base", sourceCommit, remoteRef]).trim();
  const localPaths = changedPathsBetween(baseCommit, sourceCommit);
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
  return new Set(
    [...gitObjectOids(requests)].filter(([, oid]) => oid !== null).map(([spec]) => spec),
  );
}

function gitObjectOids(requests: readonly GitObjectRequest[]): Map<string, string | null> {
  const specs = uniqueNonEmpty(requests.map(({ commit, path }) => gitObjectSpec(commit, path)));
  const objects = new Map<string, string | null>();
  for (const batch of chunked(specs, GIT_OBJECT_BATCH_SIZE)) {
    const lines = runGitObjectBatch("--batch-check", batch).toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length !== batch.length) {
      throw new Error(
        `Unexpected git cat-file batch-check response count: ${lines.length}/${batch.length}`,
      );
    }
    for (const [index, line] of lines.entries()) {
      const spec = batch[index]!;
      if (line!.endsWith(" missing")) {
        objects.set(spec, null);
        continue;
      }
      const match = /^([0-9a-f]+) [^ ]+ \d+$/.exec(line!);
      if (!match) {
        throw new Error(`Unexpected git cat-file batch-check response: ${line}`);
      }
      objects.set(spec, match[1]!);
    }
  }
  return objects;
}

function runGitObjectBatch(mode: "--batch" | "--batch-check", specs: readonly string[]): Buffer {
  recordGitProcess("cat-file");
  console.log("$ git cat-file <redacted-args>");
  const timeout = gitCommandTimeoutMs({});
  const child = spawnSync("git", ["cat-file", mode], {
    cwd: publishRoot(),
    env: process.env,
    input: Buffer.from(`${specs.join("\n")}\n`, "utf8"),
    maxBuffer: GIT_OBJECT_BATCH_MAX_BUFFER,
    ...(timeout !== undefined ? { timeout } : {}),
  });
  if (child.error) {
    if ("code" in child.error && child.error.code === "ETIMEDOUT") {
      throw new Error(`git cat-file timed out after ${timeout ?? 0}ms during state publication`);
    }
    throw child.error;
  }
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
  rebaseStrategy: RebaseStrategy;
}): PublishResult {
  console.log(`Rebuilding publish commit on ${options.remote}/${options.branch}`);
  runGit(["fetch", options.remote, options.branch]);
  const remoteCommit = runGit(["rev-parse", `${options.remote}/${options.branch}`], {
    quiet: true,
  }).trim();
  const statusMerges = planSweepStatusMerges({
    baseCommit: runGit(["rev-parse", `${options.sourceCommit}^`], { quiet: true }).trim(),
    localCommit: options.sourceCommit,
    remoteCommit,
    includeIndependent: true,
    pathspecs: options.paths,
  });
  if (options.rebaseStrategy === "apply-records") {
    return rebuildApplyRecordsPublishCommit({
      remoteCommit,
      sourceCommit: options.sourceCommit,
      message: options.message,
      statusMerges,
    });
  }
  runGit(["reset", "--hard", remoteCommit]);

  for (const path of uniqueNonEmpty(options.paths)) {
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
  stagePaths(options.paths);
  if (!hasStagedChanges()) {
    console.log("No publish changes after syncing remote");
    return "unchanged";
  }

  runGit(["commit", "-m", options.message]);
  return "committed";
}

function rebuildApplyRecordsPublishCommit(options: {
  remoteCommit: string;
  sourceCommit: string;
  message: string;
  statusMerges: readonly SweepStatusMerge[];
}): PublishResult {
  runGit(["reset", "--hard", options.sourceCommit]);
  const rebase = spawnGit(["rebase", "-X", "theirs", options.remoteCommit], {
    allowFailure: true,
  });
  if (rebase.status !== 0 && !resolveApplyRecordConflicts(options.statusMerges)) {
    runGit(["rebase", "--abort"], { allowFailure: true });
    throw new Error("Failed to rebuild apply-records publish with delete-wins semantics");
  }
  applySweepStatusMerges({
    statusMerges: options.statusMerges,
    remoteCommit: options.remoteCommit,
    localCommitMessage: options.message,
  });
  const rebuiltCommit = runGit(["rev-parse", "HEAD"], { quiet: true }).trim();
  if (rebuiltCommit === options.remoteCommit) {
    console.log("No apply-records publish changes remain after syncing remote");
    return "unchanged";
  }
  return "committed";
}

function commitHasPath(commit: string, path: string): boolean {
  return (
    spawnGit(["cat-file", "-e", `${commit}:${path}`], {
      displayArgs: ["cat-file", "-e", "<commit>:<path>"],
    }).status === 0
  );
}

export function hardResetToRemoteMain(remote = "origin", branch = publishDefaultBranch()): void {
  runGit(["fetch", remote, branch]);
  runGit(["reset", "--hard", `${remote}/${branch}`]);
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

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
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
