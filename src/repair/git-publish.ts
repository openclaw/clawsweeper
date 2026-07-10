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
  recordTupleIdentityForPath,
  recordTupleMarkdownFileForPath,
  recordTuplePathList,
  recordTuplePaths,
  type RecordTupleContents,
  type RecordTupleIdentity,
  type RecordTuplePaths,
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
  rebaseStrategy?: RebaseStrategy | undefined;
};

export type RebaseStrategy = "normal" | "theirs" | "apply-records" | "reconcile-records";

export type GitRunOptions = {
  allowFailure?: boolean;
  displayArgs?: readonly string[];
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
] as const;
const SKIP_CI_DIRECTIVE_PATTERN =
  /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks:\s*true$/im;

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
  console.log(`$ ${formatGitDisplayCommand(options.displayArgs ?? args)}`);
  const child = spawnSync("git", [...args], {
    cwd: publishRoot(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!options.quiet && child.stdout) process.stdout.write(child.stdout);
  if (!options.quiet && child.stderr) process.stderr.write(child.stderr);
  return {
    status: child.status ?? 1,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
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
  const uniquePaths = uniqueNonEmpty(paths);
  if (uniquePaths.length === 0) throw new Error("No paths were provided for publishing");
  for (const path of uniquePaths) {
    const status = spawnGit(["status", "--porcelain", "--", path]).stdout.trim();
    const worktreePath = resolve(publishRoot() ?? process.cwd(), path);
    if (hasWorktreePath(path) || existsSync(worktreePath)) {
      runGit(["add", "-A", "--", path]);
    } else if (status) {
      // Rebuilds remove exact missing paths with git rm, so their deletion is
      // already staged and there is no pathspec left for git add to match.
      console.log(`Publish path deletion already staged: ${path}`);
    } else {
      console.log(`Skipping untracked missing publish path: ${path}`);
    }
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
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? publishDefaultBranch();
  const maxAttempts = positiveInt(options.maxAttempts, 8);
  const pushAttempts = positiveInt(options.pushAttempts, 3);
  const rebaseStrategy = options.rebaseStrategy ?? "normal";
  const stateBaseCommit = captureStatePublishBaseline();

  syncPublishPaths(options.paths, { rebaseStrategy });
  configureGitUser();
  stagePaths(options.paths);
  if (!hasStagedChanges()) {
    console.log("No publish changes");
    if (stateBaseCommit && !pushCommit({ remote, branch, pushAttempts, rebaseStrategy })) {
      throw new Error(`Failed to synchronize unchanged publish with ${remote}/${branch}`);
    }
    return completeStatePublish("unchanged", options.paths, stateBaseCommit);
  }

  const commitMessage = commitMessageForPublishedPaths(options.message, options.paths);
  runGit(["commit", "-m", commitMessage]);
  let sourceCommit = runGit(["rev-parse", "HEAD"]).trim();
  const reconciliationSourceCommit =
    rebaseStrategy === "reconcile-records" ? sourceCommit : undefined;
  if (rebaseStrategy === "reconcile-records") {
    const normalized = normalizeReconciliationCommit(sourceCommit);
    sourceCommit = normalized.commit;
    if (!normalized.changed) {
      restoreWorktree(options.restorePaths ?? []);
      if (
        !pushCommit({
          remote,
          branch,
          pushAttempts,
          rebaseStrategy,
          ...(reconciliationSourceCommit ? { reconciliationSourceCommit } : {}),
        })
      ) {
        throw new Error(`Failed to synchronize unchanged publish with ${remote}/${branch}`);
      }
      return completeStatePublish("unchanged", options.paths, stateBaseCommit);
    }
  }
  restoreWorktree(options.restorePaths ?? []);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (
      pushCommit({
        remote,
        branch,
        pushAttempts,
        rebaseStrategy,
        ...(reconciliationSourceCommit ? { reconciliationSourceCommit } : {}),
      })
    ) {
      return completeStatePublish("committed", options.paths, stateBaseCommit);
    }
    if (rebaseStrategy === "reconcile-records") {
      throw new Error(
        "Failed to publish reconciliation without overwriting concurrent record tuples",
      );
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
      ...(reconciliationSourceCommit ? { reconciliationSourceCommit } : {}),
    })
  ) {
    return completeStatePublish("committed", options.paths, stateBaseCommit);
  }
  throw new Error(`Failed to publish commit after ${maxAttempts} attempts`);
}

function completeStatePublish(
  result: PublishResult,
  paths: readonly string[],
  stateBaseCommit: string | null,
): PublishResult {
  refreshSourceAfterStatePublish(paths, stateBaseCommit);
  return result;
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

  const authoritative = new Set<string>();
  for (const key of recordKeys) {
    const separator = key.indexOf("/");
    const repository = key.slice(0, separator);
    const file = key.slice(separator + 1);
    const item = `records/${repository}/items/${file}`;
    const closed = `records/${repository}/closed/${file}`;
    if (
      !commitHasPath("HEAD", item) &&
      commitHasPath("HEAD", closed) &&
      (commitHasPath(stateBaseCommit, item) || !commitHasPath(stateBaseCommit, closed))
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
      if (!rebuildReconciliationCommit(`${remote}/${branch}`, options.reconciliationSourceCommit)) {
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

function rebuildReconciliationCommit(
  remoteRef: string,
  reconciliationSourceCommit?: string,
): boolean {
  const sourceCommit = reconciliationSourceCommit ?? runGit(["rev-parse", "HEAD"]).trim();
  const baseCommit = runGit(["merge-base", sourceCommit, remoteRef]).trim();
  const localPaths = changedPathsBetween(baseCommit, sourceCommit);
  const remotePaths = changedPathsBetween(baseCommit, remoteRef);
  const localTupleKeys = new Map<string, RecordTupleIdentity>();

  for (const path of localPaths) {
    const identity = recordTupleIdentityForPath(path);
    if (!identity) {
      console.log(`Unsupported reconciliation publish path: ${path}`);
      return false;
    }
    localTupleKeys.set(path, identity);
  }

  const changedPaths = [...localPaths, ...remotePaths];
  const localIdentities = new Map<string, RecordTupleIdentity>();
  for (const identity of localTupleKeys.values()) {
    localIdentities.set(recordTupleIdentityKey(identity), identity);
  }
  const knownTuplePaths = indexRecordTupleMarkdownPaths(
    [baseCommit, sourceCommit, remoteRef],
    new Set([...localIdentities.values()].map((identity) => identity.repository)),
  );
  const selectedTuples: { paths: RecordTuplePaths; commit: string }[] = [];
  const deferredTupleKeys = new Set<string>();
  for (const [key, identity] of localIdentities) {
    const tuplePaths = resolveRecordTuplePaths({
      identity,
      changedPaths: [...changedPaths, ...(knownTuplePaths.get(key) ?? [])],
    });
    const winner = chooseRecordTupleWinner({
      base: readRecordTupleAtCommit(baseCommit, tuplePaths),
      local: readRecordTupleAtCommit(sourceCommit, tuplePaths),
      remote: readRecordTupleAtCommit(remoteRef, tuplePaths),
    });
    if (winner === "local") selectedTuples.push({ paths: tuplePaths, commit: sourceCommit });
    else if (winner === "base") selectedTuples.push({ paths: tuplePaths, commit: baseCommit });
    else deferredTupleKeys.add(key);
  }

  if (deferredTupleKeys.size > 0) {
    console.log(
      `Deferring reconciliation for ${deferredTupleKeys.size} concurrently updated record tuple(s)`,
    );
  }

  runGit(["reset", "--hard", remoteRef]);
  const selectedPaths = selectedTuples.flatMap((selection) => recordTuplePathList(selection.paths));
  for (const selection of selectedTuples) {
    for (const path of recordTuplePathList(selection.paths)) {
      runGit(["rm", "-r", "--ignore-unmatch", "--", path], { allowFailure: true });
      if (commitHasPath(selection.commit, path)) {
        runGit(["checkout", selection.commit, "--", path]);
      }
    }
  }

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
  const knownTuplePaths = indexRecordTupleMarkdownPaths(
    [baseCommit, sourceCommit],
    new Set([...identities.values()].map((identity) => identity.repository)),
  );
  const selectedTuples: RecordTuplePaths[] = [];
  for (const [key, identity] of identities) {
    const paths = resolveRecordTuplePaths({
      identity,
      changedPaths: [...localPaths, ...(knownTuplePaths.get(key) ?? [])],
    });
    const base = readRecordTupleAtCommit(baseCommit, paths);
    const local = readRecordTupleAtCommit(sourceCommit, paths);
    const winner = chooseRecordTupleWinner({ base, local, remote: base });
    if (winner === "local") selectedTuples.push(paths);
  }

  if (selectedTuples.length === identities.size) {
    return { commit: sourceCommit, changed: true };
  }

  const discarded = identities.size - selectedTuples.length;
  console.log(`Discarding ${discarded} stale or ambiguous local record tuple(s) before push`);
  runGit(["reset", "--hard", baseCommit]);
  const selectedPaths = selectedTuples.flatMap(recordTuplePathList);
  for (const paths of selectedTuples) {
    for (const path of recordTuplePathList(paths)) {
      runGit(["rm", "-r", "--ignore-unmatch", "--", path], { allowFailure: true });
      if (commitHasPath(sourceCommit, path)) runGit(["checkout", sourceCommit, "--", path]);
    }
  }
  if (selectedPaths.length > 0) stagePaths(selectedPaths);
  if (!hasStagedChanges()) return { commit: baseCommit, changed: false };
  runGit(["commit", "-C", sourceCommit]);
  return { commit: runGit(["rev-parse", "HEAD"]).trim(), changed: true };
}

function changedPathsBetween(from: string, to: string): string[] {
  return runGit(["diff", "--no-renames", "--name-only", "-z", from, to])
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
        const existing = indexed.get(key) ?? new Set<string>();
        existing.add(path);
        indexed.set(key, existing);
      }
    }
  }
  return new Map([...indexed].map(([key, paths]) => [key, [...paths]]));
}

function readRecordTupleAtCommit(commit: string, paths: RecordTuplePaths): RecordTupleContents {
  return {
    paths,
    item: readGitPath(commit, paths.item),
    closed: readGitPath(commit, paths.closed),
    plan: readGitPath(commit, paths.plan),
    packet: readGitPath(commit, paths.packet),
  };
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
