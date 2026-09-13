import {
  COMMAND_PROOF_ARCHIVE_MAX_BYTES,
  commandProofProfile,
  proofNumericId,
  proofRecord,
  type CommandProofClaim,
} from "./command-proof-contract.ts";

export type ProofProducerIdentity = Pick<
  CommandProofClaim,
  | "requestId"
  | "repository"
  | "repositoryId"
  | "scenario"
  | "workflowPath"
  | "workflowRef"
  | "workflowSha"
>;

export function proofApiNumericId(value: unknown): string | null {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return proofNumericId(id) ? id : null;
}

export const proofReceiptArtifactName = (_id: string, runId: string, attempt: number) =>
  "mantis-request-receipt-" + runId + "-" + attempt;

export function trustedRun(claim: ProofProducerIdentity, value: unknown): boolean {
  const run = proofRecord(value);
  return (
    proofApiNumericId(run.id) !== null &&
    run.run_attempt === 1 &&
    run.event === "workflow_dispatch" &&
    run.status === "completed" &&
    ["success", "failure"].includes(String(run.conclusion)) &&
    (run.path === claim.workflowPath ||
      run.path === claim.workflowPath + "@" + claim.workflowRef) &&
    run.display_title ===
      commandProofProfile(claim.scenario)?.runName + " [" + claim.requestId + "]" &&
    run.head_sha === claim.workflowSha &&
    proofApiNumericId(proofRecord(run.repository).id) === claim.repositoryId &&
    proofRecord(run.repository).full_name === claim.repository &&
    proofApiNumericId(proofRecord(run.head_repository).id) === claim.repositoryId
  );
}

/** Metadata admission only; callers must also verify the downloaded bytes' digest. */
export function proofArtifactMetadataMatches(
  value: unknown,
  byteLength: number,
  claim: ProofProducerIdentity,
  run: Record<string, unknown>,
  name: string,
): boolean {
  const artifact = proofRecord(value);
  const producer = proofRecord(artifact.workflow_run);
  return (
    proofApiNumericId(artifact.id) !== null &&
    artifact.name === name &&
    artifact.expired === false &&
    Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes === byteLength &&
    byteLength <= COMMAND_PROOF_ARCHIVE_MAX_BYTES &&
    proofApiNumericId(producer.id) === proofApiNumericId(run.id) &&
    producer.head_sha === claim.workflowSha &&
    proofApiNumericId(producer.repository_id) === claim.repositoryId &&
    proofApiNumericId(producer.head_repository_id) === claim.repositoryId
  );
}
