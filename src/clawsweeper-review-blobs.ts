import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readReviewGit, reviewMergeBase } from "./pr-review-evidence.js";
import { MAX_SCAN_BYTES } from "./agent-input-scan.js";

const MAX_BLOB_SIZE_OBJECTS = 160;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/i;

export type ReviewBlobHydration = {
  hydrated: boolean;
  blobs: number;
};

function gitCommitExists(targetDir: string, sha: string): boolean {
  return (
    spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: targetDir,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
      stdio: "ignore",
    }).status === 0
  );
}

function gitRepositoryIsShallow(targetDir: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: targetDir,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return !result.error && result.status === 0 && result.stdout.trim() === "true";
}

export function ensureReviewTreeCommit({
  targetDir,
  sha,
  sourceRef,
  destinationRef,
  completeHistory = false,
}: {
  targetDir: string;
  sha: string;
  sourceRef: string;
  destinationRef: string;
  completeHistory?: boolean;
}): boolean {
  if (!GIT_OBJECT_ID.test(sha)) return false;
  const shallow = completeHistory && gitRepositoryIsShallow(targetDir);
  if (gitCommitExists(targetDir, sha) && !shallow) return true;
  const fetched = spawnSync(
    "git",
    [
      "fetch",
      "--force",
      "--filter=blob:none",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      ...(completeHistory ? (shallow ? ["--unshallow"] : []) : ["--depth=1"]),
      "origin",
      `${sourceRef}:${destinationRef}`,
    ],
    {
      cwd: targetDir,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: "ignore",
      timeout: 30_000,
    },
  );
  return !fetched.error && fetched.status === 0 && gitCommitExists(targetDir, sha);
}

export function ensurePullRequestReviewHead({
  targetDir,
  itemNumber,
  headSha,
}: {
  targetDir: string;
  itemNumber: number;
  headSha: string;
}): boolean {
  if (!Number.isSafeInteger(itemNumber) || itemNumber <= 0) return false;
  const destinationRef = `refs/clawsweeper/review-cache/head-${itemNumber}`;
  return (
    ensureReviewTreeCommit({
      targetDir,
      sha: headSha,
      sourceRef: `refs/pull/${itemNumber}/head`,
      destinationRef,
      completeHistory: true,
    }) ||
    // The PR ref and REST head can briefly disagree after a force-push. Fetching the
    // exact validated object keeps the model bound to the revision under review.
    ensureReviewTreeCommit({
      targetDir,
      sha: headSha,
      sourceRef: headSha,
      destinationRef,
      completeHistory: true,
    })
  );
}

const REVIEW_HISTORY_DEPTH = 256;

function deepenReviewHistory(targetDir: string, revisions: readonly string[]): void {
  spawnSync(
    "git",
    [
      "fetch",
      "--filter=blob:none",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      `--depth=${REVIEW_HISTORY_DEPTH}`,
      "origin",
      ...revisions,
    ],
    {
      cwd: targetDir,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: "ignore",
      timeout: 30_000,
    },
  );
}

export function hydratePullRequestReviewHistory(options: {
  targetDir: string;
  baseSha: string;
  headSha: string;
  itemNumber: number;
  testMergeSha?: string;
}): string | null {
  const { targetDir, baseSha, headSha, itemNumber, testMergeSha } = options;
  if (
    !GIT_OBJECT_ID.test(baseSha) ||
    !GIT_OBJECT_ID.test(headSha) ||
    !Number.isSafeInteger(itemNumber) ||
    itemNumber <= 0
  )
    return null;
  if (reviewMergeBase(targetDir, baseSha, headSha).status === "unavailable") {
    // Existing tree hydration may have fetched only the PR tip. Bound history, not
    // the reviewed identity; failure remains explicit in the local evidence reader.
    //
    // Deepen the reviewed head on its own first. A depth-limited fetch re-bounds the
    // ancestry of every revision it names, so naming the pinned base here as well
    // truncates a base branch whose history the checkout already had -- the very
    // ancestry a merge base is found in. Only deepen the base when the head alone did
    // not establish one, which is the case where the base is itself shallow.
    deepenReviewHistory(targetDir, [headSha]);
    if (reviewMergeBase(targetDir, baseSha, headSha).status === "unavailable") {
      // Unchanged fallback: the same fetch this function has always issued, for the case
      // where the base is itself shallow and has to be deepened to reach an ancestor.
      deepenReviewHistory(targetDir, [baseSha, headSha]);
    }
  }
  if (testMergeSha && GIT_OBJECT_ID.test(testMergeSha)) {
    ensureReviewTreeCommit({
      targetDir,
      sha: testMergeSha,
      sourceRef: `refs/pull/${itemNumber}/merge`,
      destinationRef: `refs/clawsweeper/review-cache/merge-${itemNumber}`,
    });
  }
  return reviewMergeBase(targetDir, baseSha, headSha).sha;
}

function reviewTreeMatchesCommit({ targetDir, sha }: { targetDir: string; sha: string }): boolean {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: targetDir,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (head.error || head.status !== 0 || head.stdout.trim().toLowerCase() !== sha.toLowerCase()) {
    return false;
  }
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: targetDir,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  return !status.error && status.status === 0 && status.stdout.trim() === "";
}

export function materializePullRequestReviewTree({
  targetDir,
  worktreeDir,
  itemNumber,
  headSha,
}: {
  targetDir: string;
  worktreeDir: string;
  itemNumber: number;
  headSha: string;
}): boolean {
  if (!ensurePullRequestReviewHead({ targetDir, itemNumber, headSha })) return false;
  if (existsSync(worktreeDir)) return false;
  const worktree = spawnSync(
    "git",
    ["worktree", "add", "--detach", "--force", worktreeDir, headSha],
    {
      cwd: targetDir,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: "ignore",
    },
  );
  return (
    !worktree.error &&
    worktree.status === 0 &&
    reviewTreeMatchesCommit({ targetDir: worktreeDir, sha: headSha })
  );
}

export function removePullRequestReviewTree({
  targetDir,
  worktreeDir,
}: {
  targetDir: string;
  worktreeDir: string;
}): boolean {
  if (!existsSync(worktreeDir)) return true;
  const removed = spawnSync("git", ["worktree", "remove", "--force", worktreeDir], {
    cwd: targetDir,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: "ignore",
  });
  return !removed.error && removed.status === 0 && !existsSync(worktreeDir);
}

export function hydratePullRequestReviewBlobs({
  targetDir,
  baseSha,
  headSha,
  resolveBlobSizes,
}: {
  targetDir: string;
  baseSha: string;
  headSha: string;
  resolveBlobSizes?: (objectIds: readonly string[]) => ReadonlyMap<string, number>;
}): ReviewBlobHydration {
  if (!GIT_OBJECT_ID.test(baseSha) || !GIT_OBJECT_ID.test(headSha)) {
    return { hydrated: false, blobs: 0 };
  }
  const deadlineAt = Date.now() + 30_000;
  const readOptions = { deadlineAt, maxBytes: MAX_GIT_OUTPUT_BYTES };
  const raw = readReviewGit(
    targetDir,
    [
      "diff",
      "--raw",
      "--no-abbrev",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      baseSha,
      headSha,
      "--",
    ],
    readOptions,
  );
  if (!raw) return { hydrated: false, blobs: 0 };
  let fields: string[];
  try {
    fields = new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\0");
  } catch {
    return { hydrated: false, blobs: 0 };
  }
  if (fields.pop() !== "" || fields.length % 2 !== 0) return { hydrated: false, blobs: 0 };
  const paths = new Set<string>();
  const objectIds = new Set<string>();
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [AMDT]$/.exec(
      fields[index]!,
    );
    const path = safeReviewPath(fields[index + 1]);
    if (!match || !path) return { hydrated: false, blobs: 0 };
    paths.add(path);
    for (const [mode, oid] of [
      [match[1]!, match[3]!],
      [match[2]!, match[4]!],
    ]) {
      // Gitlinks are not blobs; the scanner still refuses changed gitlinks.
      if (mode === "000000" || mode === "160000") continue;
      if (!["100644", "100755", "120000"].includes(mode!)) return { hydrated: false, blobs: 0 };
      objectIds.add(oid!);
    }
  }

  if (objectIds.size === 0) return { hydrated: true, blobs: 0 };
  // Git before 2.45 exits without batch output when GIT_NO_LAZY_FETCH blocks a promisor fetch.
  // Traverse only the two commit trees: this emits their blobs without walking either history.
  // rev-list's missing-object mode suppresses lazy fetches and reports them on older clients too.
  const objectAvailability = spawnSync(
    "git",
    [
      "--literal-pathspecs",
      "rev-list",
      "--objects",
      "--missing=print",
      `${baseSha}^{tree}`,
      `${headSha}^{tree}`,
      "--",
      ...paths,
    ],
    {
      cwd: targetDir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: Math.max(1, deadlineAt - Date.now()),
    },
  );
  if (objectAvailability.error || objectAvailability.status !== 0) {
    return { hydrated: false, blobs: 0 };
  }
  const observed = new Set<string>();
  const missing = new Set<string>();
  for (const entry of objectAvailability.stdout.split("\n")) {
    const match = entry.match(/^(\??)([0-9a-f]{40,64})(?: |$)/i);
    if (!match || !objectIds.has(match[2]!)) continue;
    observed.add(match[2]!);
    if (match[1] === "?") missing.add(match[2]!);
  }
  if (observed.size !== objectIds.size) return { hydrated: false, blobs: 0 };

  const sizes = new Map<string, number>();
  const localObjectIds = [...objectIds].filter((objectId) => !missing.has(objectId));
  if (localObjectIds.length > 0) {
    const localObjects = readReviewGit(
      targetDir,
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      { ...readOptions, input: Buffer.from(`${localObjectIds.join("\n")}\n`) },
    );
    if (!localObjects) return { hydrated: false, blobs: 0 };
    const found = localObjects.toString().trim().split("\n");
    if (found.length !== localObjectIds.length) return { hydrated: false, blobs: 0 };
    for (const entry of found) {
      const [objectId, type, size] = entry.split(" ");
      if (!objectId || !objectIds.has(objectId) || type !== "blob") {
        return { hydrated: false, blobs: 0 };
      }
      sizes.set(objectId, Number(size));
    }
  }
  if (missing.size > 0) {
    if (!resolveBlobSizes) return { hydrated: false, blobs: 0 };
    let remoteSizes: ReadonlyMap<string, number>;
    try {
      remoteSizes = resolveBlobSizes([...missing]);
    } catch {
      return { hydrated: false, blobs: 0 };
    }
    for (const objectId of missing) {
      const bytes = remoteSizes.get(objectId);
      if (bytes === undefined) return { hydrated: false, blobs: 0 };
      sizes.set(objectId, bytes);
    }
  }

  let objectBytes = 0;
  for (const objectId of objectIds) {
    const bytes = sizes.get(objectId);
    if (
      bytes === undefined ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_SCAN_BYTES - objectBytes
    ) {
      return { hydrated: false, blobs: 0 };
    }
    objectBytes += bytes;
  }

  if (Date.now() >= deadlineAt) return { hydrated: false, blobs: 0 };
  if (missing.size > 0) {
    const fetched = spawnSync(
      "git",
      [
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "origin",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "--stdin",
      ],
      {
        cwd: targetDir,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        input: `${[...missing].join("\n")}\n`,
        timeout: Math.max(1, deadlineAt - Date.now()),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      },
    );
    if (fetched.error || fetched.status !== 0) return { hydrated: false, blobs: 0 };
  }
  return { hydrated: true, blobs: objectIds.size };
}

export function githubReviewBlobSizes({
  repository,
  objectIds,
  request,
}: {
  repository: string;
  objectIds: readonly string[];
  request: (query: string) => unknown;
}): ReadonlyMap<string, number> {
  const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw new Error("invalid bounded review blob metadata request");
  }
  if (objectIds.some((objectId) => !GIT_OBJECT_ID.test(objectId))) {
    throw new Error("invalid review blob object ID");
  }
  const result = new Map<string, number>();
  const deadlineAt = Date.now() + 30_000;
  for (let offset = 0; offset < objectIds.length; offset += MAX_BLOB_SIZE_OBJECTS) {
    if (Date.now() >= deadlineAt) throw new Error("review blob metadata deadline exceeded");
    const batch = objectIds.slice(offset, offset + MAX_BLOB_SIZE_OBJECTS);
    const objects = batch.map(
      (objectId, index) => `b${index}: object(oid: "${objectId}") { ... on Blob { byteSize } }`,
    );
    const query = `query { repository(owner: "${match[1]}", name: "${match[2]}") { ${objects.join(" ")} } }`;
    const response = request(query);
    if (!response || typeof response !== "object") throw new Error("invalid review blob response");
    const data = (response as { data?: unknown }).data;
    if (!data || typeof data !== "object") throw new Error("missing review blob response data");
    const values = (data as { repository?: unknown }).repository;
    if (!values || typeof values !== "object") throw new Error("missing review blob repository");
    for (const [index, objectId] of batch.entries()) {
      const object = (values as Record<string, unknown>)[`b${index}`];
      const bytes =
        object && typeof object === "object" ? (object as { byteSize?: unknown }).byteSize : null;
      if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error("invalid review blob size");
      }
      result.set(objectId, bytes);
    }
  }
  return result;
}

function safeReviewPath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 4096) return null;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) {
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return null;
  }
  const parts = value.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    return null;
  }
  return value;
}
