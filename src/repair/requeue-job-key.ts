import { createHash } from "node:crypto";

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
