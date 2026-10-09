import type { ItemContext } from "./clawsweeper-types.js";
import { fetchReviewBlobs, ReviewGitError } from "./clawsweeper-review-blobs.js";
import { readReviewGit, reviewMergeBase, reviewRecord as record } from "./pr-review-evidence.js";

// The review checkout is a blob:none partial clone. The sandboxed reviewer
// cannot lazily fetch old blobs: Git's object fetch is a smart-HTTP POST and
// the review proxy allows only read methods. The host therefore fetches the
// history of the changed files (and their rename predecessors) before review,
// and the reviewer runs with lazy fetch disabled so any other miss fails fast.
const DEADLINE_MS = 60_000;
const MAX_PATHS = 100;
// Measured on openclaw/openclaw: the full history of 2-20 changed files and
// their earlier names is 160-1,058 blobs, 0.3-6.6 MiB, in 2.5-12 s.
const MAX_OBJECTS = 5_000;
// Uncompressed estimates from the largest local version of each path. The
// per-path cap keeps one hot large file, such as a lockfile, from spending
// the whole budget; that file then keeps only its newest versions.
const MAX_ESTIMATED_BYTES = 1024 * 1024 * 1024;
const MAX_PATH_ESTIMATED_BYTES = 128 * 1024 * 1024;
const UNKNOWN_BLOB_BYTES = 64 * 1024;
// `git log --follow` and blame compare an added file with every file deleted
// in that commit; past this many deletions only same-name candidates are kept.
const MAX_RENAME_SOURCES = 200;
const MAX_RENAME_GENERATIONS = 2;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_LISTED = 5;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ZERO_OBJECT_ID = /^0+$/;
const BLOB_MODE = /^(?:100644|100755|120000)$/;
const RAW_ENTRY =
  /^:(\d{6}) (\d{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([A-Z])\d*$/;
const COMMIT_FORMAT = "--format=%x01%H %P%x00%cI";

export type ReviewHistoryCoverage = {
  status: "complete" | "partial" | "unavailable";
  changedPaths: number;
  // Earlier names found by rename detection, newest first.
  renames: Array<{ from: string; to: string; commit: string }>;
  blobs: number;
  fetched: number;
  // Paths whose contents at and before `before` (a commit date) are not local.
  truncated: Array<{ path: string; before: string }>;
  reason?: string;
  elapsedMs: number;
};

type RawEntry = {
  commit: string;
  date: string;
  parents: string[];
  status: string;
  path: string;
  // Destination of a rename; only `diff-tree -M` output carries one.
  renamedTo?: string;
  oldOid: string | null;
  newOid: string | null;
};

export type ReviewHistoryGit = (args: string[], input?: string) => string | null;

/** Parse `-z --raw` output, with optional `%x01%H %P%x00%cI` commit headers. */
export function parseRawHistory(output: string): RawEntry[] {
  const tokens = output.split("\0");
  const entries: RawEntry[] = [];
  let commit = "";
  let date = "";
  let parents: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!.replace(/^\n/, "");
    if (token.startsWith("\x01")) {
      const [sha = "", ...parentShas] = token.slice(1).split(" ");
      commit = sha;
      parents = parentShas.filter(Boolean);
      date = tokens[++index] ?? "";
      continue;
    }
    const raw = RAW_ENTRY.exec(token);
    if (!raw) continue;
    const path = tokens[++index];
    if (path === undefined) break;
    const renamedTo = raw[5] === "R" || raw[5] === "C" ? tokens[++index] : undefined;
    entries.push({
      commit,
      date,
      parents,
      status: raw[5]!,
      path,
      ...(renamedTo !== undefined ? { renamedTo } : {}),
      oldOid: BLOB_MODE.test(raw[1]!) && !ZERO_OBJECT_ID.test(raw[3]!) ? raw[3]! : null,
      newOid: BLOB_MODE.test(raw[2]!) && !ZERO_OBJECT_ID.test(raw[4]!) ? raw[4]! : null,
    });
  }
  return entries;
}

/** Split object ids into local blob sizes and missing ids without fetching. */
function localBlobs(
  git: ReviewHistoryGit,
  oids: readonly string[],
): { sizes: Map<string, number>; missing: Set<string> } {
  const sizes = new Map<string, number>();
  const missing = new Set<string>();
  if (oids.length === 0) return { sizes, missing };
  // rev-list reports missing promisor objects without fetching on every Git
  // version; cat-file then inspects only installed blobs.
  const listed = git(
    ["rev-list", "--objects", "--no-walk", "--missing=print", "--stdin"],
    `${oids.join("\n")}\n`,
  );
  if (listed === null) return { sizes, missing: new Set(oids) };
  const present: string[] = [];
  for (const line of listed.split("\n")) {
    const match = /^(\??)([0-9a-f]{40}(?:[0-9a-f]{24})?)$/.exec(line.trim());
    if (!match) continue;
    if (match[1]) missing.add(match[2]!);
    else present.push(match[2]!);
  }
  if (present.length === 0) return { sizes, missing };
  const checked = git(["cat-file", "--batch-check"], `${present.join("\n")}\n`);
  for (const line of checked?.split("\n") ?? []) {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) blob (\d+)$/.exec(line);
    if (match) sizes.set(match[1]!, Number(match[2]));
  }
  return { sizes, missing };
}

/**
 * Make the history of the changed files local in one batched fetch per rename
 * generation: every version on the walk from the head, base, test merge and
 * main tips, newest first, within the object and estimated byte budgets.
 */
export function prefetchReviewHistory(options: {
  git: ReviewHistoryGit;
  fetchBlobs: (objectIds: string[], deadlineAt: number) => unknown;
  mergeBaseSha: string;
  headSha: string;
  // Other local commits whose versions of the changed paths the reviewer may read.
  tips: readonly string[];
  deadlineAt: number;
  now?: () => number;
}): ReviewHistoryCoverage {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { git, deadlineAt } = options;
  const reasons: string[] = [];
  let failed = false;
  const selected = new Set<string>();
  const truncated = new Map<string, string>();
  let fetched = 0;
  const renames: ReviewHistoryCoverage["renames"] = [];
  let changedPaths = 0;
  const finish = (): ReviewHistoryCoverage => ({
    status: failed
      ? "unavailable"
      : reasons.length > 0 || truncated.size > 0
        ? "partial"
        : "complete",
    changedPaths,
    renames,
    blobs: selected.size,
    fetched,
    truncated: [...truncated]
      .map(([path, before]) => ({ path, before }))
      .sort((a, b) => b.before.localeCompare(a.before)),
    ...(reasons.length > 0 ? { reason: reasons.join(" ") } : {}),
    elapsedMs: now() - startedAt,
  });
  const changed = git([
    "diff",
    "--raw",
    "-z",
    "--no-renames",
    "--no-abbrev",
    "--ignore-submodules=all",
    options.mergeBaseSha,
    options.headSha,
    "--",
  ]);
  if (changed === null) {
    failed = true;
    reasons.push("The merge-base to head diff failed.");
    return finish();
  }
  const paths = [...new Set(parseRawHistory(changed).map((entry) => entry.path))];
  changedPaths = paths.length;
  if (paths.length > MAX_PATHS)
    reasons.push(
      `${paths.length - MAX_PATHS} changed files beyond the ${MAX_PATHS}-file cap have no local history.`,
    );

  const tips = [...new Set([options.headSha, ...options.tips])];
  // Budgets count only blobs to fetch; local versions are free.
  let queued = 0;
  let estimatedBytes = 0;
  let budgetExhausted = false;
  const pathBytes = new Map<string, number>();
  let round = paths.slice(0, MAX_PATHS).map((path) => ({ path, estimate: 0 }));
  const seenPaths = new Set(round.map(({ path }) => path));
  for (let generation = 0; round.length > 0; generation++) {
    if (generation > MAX_RENAME_GENERATIONS) {
      reasons.push(`History before ${round.length} older file names is not local.`);
      break;
    }
    if (now() >= deadlineAt) {
      reasons.push("The host deadline ended history preparation early.");
      break;
    }
    const history = git([
      "--literal-pathspecs",
      "log",
      "-z",
      "--raw",
      "--no-renames",
      "--no-abbrev",
      // Merge results the reviewer reads, such as GitHub's test merge.
      "--diff-merges=first-parent",
      COMMIT_FORMAT,
      ...tips,
      "--",
      ...round.map(({ path }) => path),
    ]);
    if (history === null) {
      failed = generation === 0;
      reasons.push("The changed-file history walk failed or exceeded its host bounds.");
      break;
    }
    const entries = parseRawHistory(history);
    const local = localBlobs(git, [
      ...new Set(
        entries.flatMap((entry) => [entry.newOid, entry.oldOid]).filter((oid) => oid !== null),
      ),
    ]);
    const estimates = new Map(round.map(({ path, estimate }) => [path, estimate]));
    for (const entry of entries)
      for (const oid of [entry.newOid, entry.oldOid]) {
        const bytes = oid ? local.sizes.get(oid) : undefined;
        if (bytes !== undefined && bytes > (estimates.get(entry.path) ?? 0))
          estimates.set(entry.path, bytes);
      }

    // Newest first: a global cap cuts every path at one date; a per-path cap
    // cuts only that path.
    const creations: Array<{ commit: string; date: string; path: string; oid: string }> = [];
    for (const entry of entries) {
      if (!estimates.has(entry.path) || truncated.has(entry.path)) continue;
      const wanted = [entry.newOid, entry.oldOid].filter(
        (oid): oid is string => oid !== null && !selected.has(oid),
      );
      const absent = wanted.filter((oid) => !local.sizes.has(oid));
      const bytes = absent.length * (estimates.get(entry.path) || UNKNOWN_BLOB_BYTES);
      if (absent.length > 0) {
        budgetExhausted ||=
          queued + absent.length > MAX_OBJECTS || estimatedBytes + bytes > MAX_ESTIMATED_BYTES;
        if (
          budgetExhausted ||
          (pathBytes.get(entry.path) ?? 0) + bytes > MAX_PATH_ESTIMATED_BYTES
        ) {
          truncated.set(entry.path, entry.date);
          continue;
        }
      }
      for (const oid of wanted) selected.add(oid);
      queued += absent.length;
      estimatedBytes += bytes;
      pathBytes.set(entry.path, (pathBytes.get(entry.path) ?? 0) + bytes);
      if (entry.status !== "A" || !entry.newOid) continue;
      // A merge adds a path from its other parent, whose history the walk
      // continues. A merge whose other parents lack the path created it, maybe
      // renaming while resolving; that earlier name is not searched.
      if (entry.parents.length > 1) {
        // ls-tree reads only trees; `cat-file -e rev:path` also needs the blob.
        if (
          entry.parents
            .slice(1)
            .every(
              (parent) => !git(["--literal-pathspecs", "ls-tree", "-z", parent, "--", entry.path]),
            )
        )
          truncated.set(entry.path, entry.date);
      } else if (entry.parents.length === 1)
        creations.push({
          commit: entry.commit,
          date: entry.date,
          path: entry.path,
          oid: entry.newOid,
        });
    }

    // Files deleted in a creation commit are the rename candidates that
    // `git log --follow` and blame compare against.
    const renameSources = new Map<string, RawEntry[]>();
    const creationCommits = [...new Set(creations.map(({ commit }) => commit))];
    const deletions =
      creationCommits.length > 0 && !budgetExhausted
        ? git([
            "log",
            "-z",
            "--raw",
            "--no-renames",
            "--no-abbrev",
            "--no-walk=unsorted",
            "--diff-filter=D",
            COMMIT_FORMAT,
            ...creationCommits,
            "--",
          ])
        : null;
    for (const entry of deletions === null ? [] : parseRawHistory(deletions))
      if (entry.oldOid)
        renameSources.set(entry.commit, [...(renameSources.get(entry.commit) ?? []), entry]);
    const named = new Map(
      creations.map((creation) => {
        const sources = renameSources.get(creation.commit) ?? [];
        const name = creation.path.slice(creation.path.lastIndexOf("/") + 1);
        return [
          creation,
          sources.length <= MAX_RENAME_SOURCES
            ? sources
            : sources.filter(
                (source) =>
                  source.oldOid === creation.oid ||
                  source.path.slice(source.path.lastIndexOf("/") + 1) === name,
              ),
        ];
      }),
    );
    // One batched check without lazy fetch: installed candidates cost nothing.
    const installed = localBlobs(git, [
      ...new Set(
        [...named.values()].flatMap((sources) =>
          sources.map((source) => source.oldOid!).filter((oid) => !selected.has(oid)),
        ),
      ),
    ]).sizes;
    const candidates = new Map<
      (typeof creations)[number],
      { sources: RawEntry[]; unchecked: boolean }
    >();
    for (const creation of creations) {
      const sources = renameSources.get(creation.commit) ?? [];
      const kept: RawEntry[] = [];
      for (const source of named.get(creation)!) {
        if (selected.has(source.oldOid!)) {
          kept.push(source);
          continue;
        }
        if (!installed.has(source.oldOid!)) {
          budgetExhausted ||=
            queued >= MAX_OBJECTS || estimatedBytes + UNKNOWN_BLOB_BYTES > MAX_ESTIMATED_BYTES;
          if (budgetExhausted) break;
          queued += 1;
          estimatedBytes += UNKNOWN_BLOB_BYTES;
        }
        selected.add(source.oldOid!);
        kept.push(source);
      }
      // Unchecked candidates may hide the earlier name unless a kept one is it.
      const unchecked = deletions === null || kept.length < sources.length;
      if (kept.length > 0) candidates.set(creation, { sources: kept, unchecked });
      else if (unchecked) truncated.set(creation.path, creation.date);
    }

    const missing = localBlobs(git, [...selected]).missing;
    if (missing.size > 0) {
      if (now() >= deadlineAt) {
        reasons.push("The host deadline ended history preparation early.");
        break;
      }
      options.fetchBlobs([...missing], deadlineAt);
      const unresolved = localBlobs(git, [...missing]).missing;
      fetched += missing.size - unresolved.size;
      if (unresolved.size > 0)
        reasons.push(`The remote did not supply ${unresolved.size} historical blobs.`);
    }

    // Exact pathspecs keep rename detection on the fetched candidates.
    const next: typeof round = [];
    for (const [creation, { sources, unchecked }] of candidates) {
      const detected =
        now() < deadlineAt
          ? git([
              "--literal-pathspecs",
              "diff-tree",
              "-r",
              "-z",
              "-M",
              "--raw",
              "--no-abbrev",
              "--no-commit-id",
              creation.commit,
              "--",
              creation.path,
              ...sources.map(({ path }) => path),
            ])
          : null;
      const earlier = (detected === null ? [] : parseRawHistory(detected)).filter(
        (rename) => rename.status === "R" && rename.renamedTo === creation.path,
      );
      // An unknown earlier name leaves the history before this commit unfetched.
      if (detected === null || (unchecked && earlier.length === 0))
        truncated.set(creation.path, creation.date);
      for (const rename of earlier) {
        if (seenPaths.has(rename.path)) continue;
        seenPaths.add(rename.path);
        renames.push({ from: rename.path, to: creation.path, commit: creation.commit });
        next.push({ path: rename.path, estimate: estimates.get(creation.path) ?? 0 });
      }
    }
    round = next;
  }
  return finish();
}

export function pullRequestHistoryCoverage(options: {
  targetDir: string | undefined;
  context: ItemContext;
  mainSha: string | null | undefined;
}): ReviewHistoryCoverage {
  const unavailable = (reason: string): ReviewHistoryCoverage => ({
    status: "unavailable",
    changedPaths: 0,
    renames: [],
    blobs: 0,
    fetched: 0,
    truncated: [],
    reason,
    elapsedMs: 0,
  });
  const { targetDir } = options;
  if (!targetDir) return unavailable("No host target checkout is available.");
  const pull = record(options.context.pullRequest);
  const baseSha = record(pull.base).sha;
  const headSha = record(pull.head).sha;
  const mergeBase = reviewMergeBase(
    targetDir,
    typeof baseSha === "string" ? baseSha : null,
    typeof headSha === "string" ? headSha : null,
  );
  if (mergeBase.status !== "verified" || typeof headSha !== "string")
    return unavailable(
      mergeBase.status === "verified" ? "Missing pinned head identity." : mergeBase.reason,
    );
  const deadlineAt = Date.now() + DEADLINE_MS;
  // Lazy fetch stays blocked: listing history must not fetch it one blob at a time.
  const git: ReviewHistoryGit = (args, input) =>
    readReviewGit(targetDir, args, {
      deadlineAt,
      maxBytes: MAX_LOG_BYTES,
      ...(input !== undefined ? { input: Buffer.from(input) } : {}),
    })?.toString("utf8") ?? null;
  // Only commits already local; naming a missing one would fail the walk.
  const tips = [baseSha, pull.merge_commit_sha, options.mainSha].filter(
    (sha): sha is string =>
      typeof sha === "string" &&
      OBJECT_ID.test(sha) &&
      git(["cat-file", "-e", `${sha}^{commit}`]) !== null,
  );
  try {
    return prefetchReviewHistory({
      git,
      fetchBlobs: (objectIds, fetchDeadlineAt) =>
        fetchReviewBlobs(targetDir, objectIds, fetchDeadlineAt),
      mergeBaseSha: mergeBase.sha,
      headSha,
      tips,
      deadlineAt,
    });
  } catch (error) {
    // An unsettled Git process must stop the workspace; other failures only
    // leave history missing, which the reviewer is told.
    if (error instanceof ReviewGitError && error.errorCode === "EPROCESSSETTLEMENT") throw error;
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim();
    return unavailable(`History prefetch failed: ${detail.slice(0, 200)}`);
  }
}

/** One Runtime Capabilities line, in plain words, so the model reports a gap once. */
export function reviewHistoryCapability(
  coverage: ReviewHistoryCoverage,
  networkCapability: "allowlisted-proxy" | "unrestricted" | "none" | undefined,
): string {
  // Only an unrestricted runner can lazily download what the host did not fetch.
  const downloads = networkCapability === "unrestricted";
  const miss = downloads
    ? "Git downloads any other old blob on demand, more slowly."
    : networkCapability === "allowlisted-proxy"
      ? "Git reports any other old blob as missing (`lazy fetching disabled`, `could not fetch`, `bad object`, `unable to read`) instead of downloading it; report such a gap once as a local limit."
      : "Git cannot download any other old blob without network access; report such a gap once as a local limit.";
  if (coverage.status === "unavailable")
    return `Old file contents were not prefetched: ${coverage.reason ?? "the host could not prepare file history."} ${miss}`;
  const listed = <T>(items: readonly T[], format: (item: T) => string) =>
    `${items.slice(0, MAX_LISTED).map(format).join(", ")}${items.length > MAX_LISTED ? `, and ${items.length - MAX_LISTED} more` : ""}`;
  const renames =
    coverage.renames.length > 0
      ? ` Continue across renames with \`git log -- <earlier name>\`: ${listed(coverage.renames, ({ from, to, commit }) => `\`${from}\` became \`${to}\` in ${commit.slice(0, 10)}`)}.`
      : "";
  return [
    `Git history of the ${coverage.changedPaths} changed files and their earlier names is local on main and the PR; scope \`git log -S/-G\` to those paths.`,
    downloads
      ? renames.trim()
      : `\`git log --follow\` ends with a missing-object error at each file's creation commit; that is not missing history.${renames}`,
    coverage.truncated.length > 0
      ? `Not prefetched: ${listed(coverage.truncated, ({ path, before }) => `\`${path}\` from ${before.slice(0, 10)} back`)}.`
      : "",
    coverage.reason ?? "",
    miss,
  ]
    .filter(Boolean)
    .join(" ");
}
