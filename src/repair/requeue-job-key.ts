import { createHash } from "node:crypto";
import path from "node:path";

export function deterministicRequeueDispatchKey({
  repo,
  workflow,
  sourceRunId,
  sourceJobPath,
  authorizationSha256,
  depth,
}: {
  repo: string;
  workflow: string;
  sourceRunId: string | null;
  sourceJobPath: string;
  authorizationSha256: string;
  depth: number;
}) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        repo,
        workflow,
        source_run_id: sourceRunId,
        source_job_path: sourceJobPath,
        authorization_sha256: authorizationSha256,
        depth,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `requeue-${depth}-${digest}`;
}

export function boundedNextRequeueDepth(depth: number, maxDepth: number): number {
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new Error("requeue depth must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error("maximum requeue depth must be a non-negative integer");
  }
  if (depth >= maxDepth) {
    throw new Error(`requeue depth ${depth} reached the maximum ${maxDepth}`);
  }
  return depth + 1;
}

export function normalizedRequeueSourceJobPath(value: unknown, fallback: string): string {
  const candidate = String(value ?? "").trim() || fallback;
  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.startsWith("../") ||
    !normalized.startsWith("jobs/") ||
    !normalized.endsWith(".md")
  ) {
    throw new Error("source job path must be a normalized relative jobs/... markdown path");
  }
  return normalized;
}
