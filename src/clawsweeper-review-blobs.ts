import { spawnSync } from "node:child_process";

const MAX_REVIEW_FILES = 80;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_REVIEW_BLOB_BYTES = 4 * 1024 * 1024;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/i;

type ReviewBlobFile = {
  filename?: unknown;
  previous_filename?: unknown;
  status?: unknown;
};

export type ReviewBlobHydration = {
  hydrated: boolean;
  blobs: number;
};

export function hydratePullRequestReviewBlobs({
  targetDir,
  baseSha,
  headSha,
  files,
  resolveBlobSizes,
}: {
  targetDir: string;
  baseSha: string;
  headSha: string;
  files: readonly unknown[];
  resolveBlobSizes?: (objectIds: readonly string[]) => ReadonlyMap<string, number>;
}): ReviewBlobHydration {
  if (
    !GIT_OBJECT_ID.test(baseSha) ||
    !GIT_OBJECT_ID.test(headSha) ||
    files.length > MAX_REVIEW_FILES
  ) {
    return { hydrated: false, blobs: 0 };
  }

  const basePaths = new Set<string>();
  const headPaths = new Set<string>();
  for (const value of files) {
    if (!value || typeof value !== "object") return { hydrated: false, blobs: 0 };
    const file = value as ReviewBlobFile;
    const filename = safeReviewPath(file.filename);
    if (!filename) return { hydrated: false, blobs: 0 };
    const previous =
      file.previous_filename === undefined ? filename : safeReviewPath(file.previous_filename);
    if (!previous) return { hydrated: false, blobs: 0 };
    const status = typeof file.status === "string" ? file.status.toLowerCase() : "";
    if (status !== "added" && status !== "a") basePaths.add(previous);
    if (status !== "removed" && status !== "deleted" && status !== "d") {
      headPaths.add(filename);
    }
  }

  const objectIds = new Set<string>();
  for (const [sha, paths] of [
    [baseSha, basePaths],
    [headSha, headPaths],
  ] as const) {
    if (paths.size === 0) continue;
    const tree = spawnSync("git", ["--literal-pathspecs", "ls-tree", "-z", sha, "--", ...paths], {
      cwd: targetDir,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    if (tree.error || tree.status !== 0) return { hydrated: false, blobs: 0 };
    for (const entry of tree.stdout.split("\0")) {
      if (!entry) continue;
      const match = entry.match(/^\d{6} (blob|commit) ([0-9a-f]{40,64})\t(.*)$/s);
      if (!match || !paths.has(match[3]!)) return { hydrated: false, blobs: 0 };
      if (match[1] === "blob") objectIds.add(match[2]!);
    }
  }

  if (objectIds.size === 0) return { hydrated: true, blobs: 0 };
  const objectInput = `${[...objectIds].join("\n")}\n`;
  const localObjects = spawnSync(
    "git",
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    {
      cwd: targetDir,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
      input: objectInput,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    },
  );
  if (localObjects.error || localObjects.status !== 0) return { hydrated: false, blobs: 0 };
  const found = localObjects.stdout.trim().split("\n");
  if (found.length !== objectIds.size) return { hydrated: false, blobs: 0 };
  const sizes = new Map<string, number>();
  const missing = new Set<string>();
  for (const entry of found) {
    const [objectId, type, size] = entry.split(" ");
    if (!objectId || !objectIds.has(objectId) || (type !== "blob" && type !== "missing")) {
      return { hydrated: false, blobs: 0 };
    }
    if (type === "missing") missing.add(objectId);
    else sizes.set(objectId, Number(size));
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
  let skippedOversizedBlob = false;
  const bounded = new Set<string>();
  for (const objectId of objectIds) {
    const bytes = sizes.get(objectId);
    if (
      bytes === undefined ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_REVIEW_BLOB_BYTES - objectBytes
    ) {
      skippedOversizedBlob = true;
      continue;
    }
    bounded.add(objectId);
    objectBytes += bytes;
  }

  const boundedMissing = [...missing].filter((objectId) => bounded.has(objectId));
  if (boundedMissing.length > 0) {
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
        input: `${boundedMissing.join("\n")}\n`,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      },
    );
    if (fetched.error || fetched.status !== 0) return { hydrated: false, blobs: 0 };
  }
  return { hydrated: !skippedOversizedBlob, blobs: bounded.size };
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
  if (
    !match ||
    match[1] === "." ||
    match[1] === ".." ||
    match[2] === "." ||
    match[2] === ".." ||
    objectIds.length > MAX_REVIEW_FILES * 2
  ) {
    throw new Error("invalid bounded review blob metadata request");
  }
  const objects = objectIds.map((objectId, index) => {
    if (!GIT_OBJECT_ID.test(objectId)) throw new Error("invalid review blob object ID");
    return `b${index}: object(oid: "${objectId}") { ... on Blob { byteSize } }`;
  });
  const query = `query { repository(owner: "${match[1]}", name: "${match[2]}") { ${objects.join(" ")} } }`;
  const response = request(query);
  if (!response || typeof response !== "object") throw new Error("invalid review blob response");
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== "object") throw new Error("missing review blob response data");
  const values = (data as { repository?: unknown }).repository;
  if (!values || typeof values !== "object") throw new Error("missing review blob repository");
  const result = new Map<string, number>();
  for (const [index, objectId] of objectIds.entries()) {
    const object = (values as Record<string, unknown>)[`b${index}`];
    const bytes =
      object && typeof object === "object" ? (object as { byteSize?: unknown }).byteSize : null;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("invalid review blob size");
    }
    result.set(objectId, bytes);
  }
  return result;
}

function safeReviewPath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 4096) return null;
  if (value.startsWith("/") || value.includes("\\")) {
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return null;
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) {
    return null;
  }
  return value;
}
