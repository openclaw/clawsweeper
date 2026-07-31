import { spawnSync } from "node:child_process";

const MAX_REVIEW_FILES = 80;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
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
}: {
  targetDir: string;
  baseSha: string;
  headSha: string;
  files: readonly unknown[];
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
  const hydrated = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    cwd: targetDir,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    input: `${[...objectIds].join("\n")}\n`,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (hydrated.error || hydrated.status !== 0) return { hydrated: false, blobs: 0 };
  const received = hydrated.stdout.trim().split("\n");
  if (
    received.length !== objectIds.size ||
    received.some((entry) => {
      const [objectId, type] = entry.split(" ");
      return !objectId || !objectIds.has(objectId) || type !== "blob";
    })
  ) {
    return { hydrated: false, blobs: 0 };
  }
  return { hydrated: true, blobs: objectIds.size };
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
