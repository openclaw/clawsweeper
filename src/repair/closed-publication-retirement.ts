import { fromBufferPromise } from "yauzl";
import { sha256 } from "../content-hash.js";
import { stableJson } from "../stable-json.js";
import { requireRecord } from "../value-coerce.js";
import {
  EXACT_REVIEW_BUNDLE_MAX_ARTIFACT_BYTES,
  EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES,
  EXACT_REVIEW_BUNDLE_MAX_FILES,
  validateManifest,
} from "./exact-review-bundle.js";
import type { ExactReviewBatchQueueClient } from "./exact-review-batch-queue-client.js";

const REPOSITORY = "openclaw/clawsweeper";
const API = "https://api.github.com";
const WORKFLOW = ".github/workflows/sweep.yml";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = EXACT_REVIEW_BUNDLE_MAX_ARTIFACT_BYTES;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;

export interface ClosedPublicationRetirementInput {
  producerRunId: number;
  artifactId: number;
  publicationKeySha256: string;
  queueRevision: number;
  workflowSha: string;
}

export interface ClosedPublicationRetirementPlan {
  version: 1;
  workflowSha: string;
  artifactId: number;
  artifactSha256: string;
  producerRunId: number;
  producerRunAttempt: number;
  producerSourceSha: string;
  sourceRevision: number;
  claimGeneration: number;
  queueRevision: number;
  canonicalTargetKey: string;
  publicationKey: string;
  publicationKeySha256: string;
  targetNodeId: string;
  mergedAt: string;
  mergeCommitSha: string;
}

function check(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid closed publication retirement evidence");
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  check(declared === null || (/^\d+$/.test(declared) && Number(declared) <= limit));
  check(response.body);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      check(bytes <= limit);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, bytes);
}

export async function readRetirementManifest(archive: Buffer, expectedDigest: string) {
  check(HASH.test(expectedDigest) && archive.length <= MAX_ARCHIVE_BYTES);
  // yauzl validates sizes, not file-data CRCs. Authenticate the complete archive
  // against GitHub's independently fetched digest before interpreting any entry.
  check(sha256(archive) === expectedDigest);
  const zip = await fromBufferPromise(archive, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  let manifestBytes: Buffer | undefined;
  let totalBytes = 0;
  const paths = new Set<string>();
  const files = new Map<string, number>();
  try {
    check(zip.entryCount <= EXACT_REVIEW_BUNDLE_MAX_FILES * 2 + 1);
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      check(name && !name.includes("\0") && !name.split("/").includes(".") && !paths.has(name));
      paths.add(name);
      check(!entry.isEncrypted() && [0, 8].includes(entry.compressionMethod));
      check(Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0);
      check(Number.isSafeInteger(entry.compressedSize) && entry.compressedSize >= 0);
      check(entry.compressedSize <= MAX_ARCHIVE_BYTES);
      totalBytes += entry.uncompressedSize;
      check(totalBytes <= MAX_ARCHIVE_BYTES + EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES);
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      const directory = name.endsWith("/");
      check(mode === 0 || mode === (directory ? 0o040000 : 0o100000));
      check(!(entry.externalFileAttributes & 0x10) || directory);
      await zip.readLocalFileHeaderPromise(entry, { minimal: true });
      if (directory) {
        check(entry.uncompressedSize === 0);
        continue;
      }
      if (name !== "manifest.json") {
        files.set(name, entry.uncompressedSize);
        continue;
      }
      check(!manifestBytes && entry.uncompressedSize <= EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES);
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const chunk of stream) {
          bytes += chunk.length;
          check(bytes <= EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES);
          chunks.push(chunk);
        }
      } finally {
        stream.destroy();
      }
      manifestBytes = Buffer.concat(chunks, bytes);
    }
  } finally {
    zip.close();
  }
  check(manifestBytes);
  const manifest = validateManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
  );
  check(files.size === manifest.files.length);
  for (const file of manifest.files) check(files.get(file.path) === file.bytes);
  return manifest;
}

export async function prepareClosedPublicationRetirement(
  input: ClosedPublicationRetirementInput,
  token: string,
  request: typeof fetch = fetch,
): Promise<ClosedPublicationRetirementPlan> {
  check(
    positive(input.producerRunId) && positive(input.artifactId) && positive(input.queueRevision),
  );
  check(HASH.test(input.publicationKeySha256) && SHA.test(input.workflowSha) && token);
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}` };
  async function get(path: string, authenticated = true) {
    const response = await request(`${API}${path}`, {
      headers: authenticated ? headers : { accept: headers.accept },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    check(response.ok);
    return requireRecord(
      JSON.parse((await boundedBody(response, MAX_JSON_BYTES)).toString("utf8")),
      "metadata",
    );
  }
  const artifact = await get(`/repos/${REPOSITORY}/actions/artifacts/${input.artifactId}`);
  const artifactRun = requireRecord(artifact.workflow_run, "artifact run");
  check(artifact.id === input.artifactId && artifactRun.id === input.producerRunId);
  check(
    artifact.expired === false &&
      positive(artifact.size_in_bytes) &&
      artifact.size_in_bytes <= MAX_ARCHIVE_BYTES,
  );
  check(typeof artifact.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(artifact.digest));
  const name =
    typeof artifact.name === "string"
      ? /^exact-review-(\d+)-([1-9]\d*)$/.exec(artifact.name)
      : null;
  check(name && name[1] === String(input.producerRunId) && positive(Number(name[2])));
  const attempt = Number(name[2]);
  const run = await get(
    `/repos/${REPOSITORY}/actions/runs/${input.producerRunId}/attempts/${attempt}`,
  );
  const repo = requireRecord(run.repository, "producer repository");
  check(run.id === input.producerRunId && run.run_attempt === attempt && run.path === WORKFLOW);
  check(repo.full_name === REPOSITORY && repo.id === artifactRun.repository_id);
  check(
    typeof run.head_sha === "string" &&
      SHA.test(run.head_sha) &&
      run.head_sha === artifactRun.head_sha,
  );

  // GitHub authenticates only the exact-ID redirect request. Never forward its
  // token to the signed blob URL, and bound each redirect and body independently.
  let response = await request(
    `${API}/repos/${REPOSITORY}/actions/artifacts/${input.artifactId}/zip`,
    {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    },
  );
  for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects += 1) {
    check(redirects < 3);
    const location = response.headers.get("location");
    check(location);
    const url = new URL(location);
    check(url.protocol === "https:" && !url.username && !url.password);
    await response.body?.cancel();
    response = await request(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  }
  check(response.ok);
  const digest = artifact.digest.slice(7);
  const archive = await boundedBody(response, MAX_ARCHIVE_BYTES);
  check(archive.length === artifact.size_in_bytes);
  const manifest = await readRetirementManifest(archive, digest);
  check(
    manifest.workflow.repository === REPOSITORY && manifest.workflow.source_sha === run.head_sha,
  );
  check(
    manifest.workflow.run_id === String(input.producerRunId) &&
      manifest.workflow.run_attempt === attempt,
  );
  check(manifest.workflow.producer_job === "event-review-apply");
  check(
    manifest.queue.protocol_version === 2 &&
      positive(manifest.queue.lease_revision) &&
      positive(manifest.queue.claim_generation),
  );
  check(manifest.target.item_kind === "pull_request");
  // This is the publication addressing contract in dashboard/exact-review-decision.ts,
  // not the manifest's source-review key or source lease revision.
  const publicationKey = `${manifest.queue.item_key}@publish:${input.producerRunId}:${attempt}`;
  check(sha256(publicationKey) === input.publicationKeySha256);
  const target = await get(
    `/repos/${manifest.target.repo}/pulls/${manifest.target.item_number}`,
    false,
  );
  const targetRepo = requireRecord(
    requireRecord(target.base, "target base").repo,
    "target repository",
  );
  check(targetRepo.private === false && targetRepo.full_name === manifest.target.repo);
  check(
    target.number === manifest.target.item_number &&
      target.state === "closed" &&
      target.merged === true,
  );
  check(
    typeof target.node_id === "string" && target.node_id.length > 0 && target.node_id.length <= 200,
  );
  check(typeof target.merged_at === "string" && Number.isFinite(Date.parse(target.merged_at)));
  check(typeof target.merge_commit_sha === "string" && SHA.test(target.merge_commit_sha));
  return {
    version: 1,
    workflowSha: input.workflowSha,
    artifactId: input.artifactId,
    artifactSha256: digest,
    producerRunId: input.producerRunId,
    producerRunAttempt: attempt,
    producerSourceSha: run.head_sha,
    sourceRevision: manifest.queue.lease_revision,
    claimGeneration: manifest.queue.claim_generation,
    queueRevision: input.queueRevision,
    canonicalTargetKey: manifest.queue.item_key,
    publicationKey,
    publicationKeySha256: input.publicationKeySha256,
    targetNodeId: target.node_id,
    mergedAt: target.merged_at,
    mergeCommitSha: target.merge_commit_sha,
  };
}

export function retirementPlanSummary(plan: ClosedPublicationRetirementPlan) {
  return {
    ok: true,
    status: "preview" as const,
    planSha256: sha256(stableJson(plan)),
    publicationKeySha256: plan.publicationKeySha256,
    artifactSha256: plan.artifactSha256,
    workflowSha: plan.workflowSha,
    queueRevision: plan.queueRevision,
    sourceRevision: plan.sourceRevision,
    claimGeneration: plan.claimGeneration,
    protocolVersion: 2,
  };
}

export async function applyClosedPublicationRetirement(
  value: unknown,
  reviewedPlanSha256: string,
  workflowSha: string,
  createClient: () => Pick<ExactReviewBatchQueueClient, "postEffect">,
) {
  const plan = requireRecord(value, "retirement plan");
  check(Object.keys(plan).length === 16);
  check(
    ["workflowSha", "producerSourceSha", "mergeCommitSha"].every(
      (key) => typeof plan[key] === "string" && SHA.test(plan[key]),
    ),
  );
  check(
    ["artifactSha256", "publicationKeySha256"].every(
      (key) => typeof plan[key] === "string" && HASH.test(plan[key]),
    ),
  );
  check(
    [
      "artifactId",
      "producerRunId",
      "producerRunAttempt",
      "sourceRevision",
      "claimGeneration",
      "queueRevision",
    ].every((key) => positive(plan[key])),
  );
  check(
    typeof plan.targetNodeId === "string" &&
      plan.targetNodeId.length > 0 &&
      plan.targetNodeId.length <= 200,
  );
  check(typeof plan.mergedAt === "string" && Number.isFinite(Date.parse(plan.mergedAt)));
  check(typeof plan.canonicalTargetKey === "string" && typeof plan.publicationKey === "string");
  check(HASH.test(reviewedPlanSha256) && SHA.test(workflowSha));
  check(plan.version === 1 && plan.workflowSha === workflowSha);
  check(sha256(stableJson(plan)) === reviewedPlanSha256);
  check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(plan.canonicalTargetKey));
  check(
    plan.publicationKey ===
      `${plan.canonicalTargetKey}@publish:${plan.producerRunId}:${plan.producerRunAttempt}`,
  );
  check(sha256(plan.publicationKey) === plan.publicationKeySha256);
  const result = await createClient().postEffect(
    "terminal-disposition",
    JSON.stringify({
      canonical_target_key: plan.canonicalTargetKey,
      fence_key: plan.publicationKey,
      revision: plan.queueRevision,
      kind: "target_closed",
      operation_id: `operator-retire-target_closed:${plan.publicationKeySha256}:${plan.queueRevision}`,
    }),
  );
  check(result.ok === true);
  check(
    typeof result.lifecycle_state === "string" &&
      [
        "pending",
        "completed",
        "acknowledgement_pending",
        "acknowledgement_skipped",
        "superseded",
        "requeue",
        "dead_letter",
        "target_closed",
        "target_missing",
        "policy_noop",
        "guarded_open",
        "failed",
      ].includes(result.lifecycle_state),
  );
  check(
    typeof result.acknowledgement_state === "string" &&
      [
        "not_required",
        "pending",
        "observed",
        "skipped_locked",
        "skipped_missing_comment",
        "unavailable",
      ].includes(result.acknowledgement_state),
  );
  return {
    ...retirementPlanSummary(plan as unknown as ClosedPublicationRetirementPlan),
    status: "asserted" as const,
    lifecycleState: result.lifecycle_state,
    acknowledgementState: result.acknowledgement_state,
  };
}
