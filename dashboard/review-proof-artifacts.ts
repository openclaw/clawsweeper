import {
  commandProofProfile,
  proofNumericId,
  proofRecord,
  type CommandProofScenario,
} from "../src/command-proof-contract.ts";
import { sha256Hex } from "./exact-review-direct-publication.ts";

export const proofDigest = (bytes: string | Uint8Array) =>
  sha256Hex(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
export const proofReceiptArtifactName = (_id: string, runId: string, attempt: number) =>
  "mantis-request-receipt-" + runId + "-" + attempt;
export function proofEvidenceArtifactName(
  _id: string,
  runId: string,
  attempt: number,
  scenario: CommandProofScenario,
) {
  return commandProofProfile(scenario)!.evidenceArtifactPrefix + "-" + runId + "-" + attempt;
}
export type ProofProducerIdentity = {
  requestId: string;
  repository: string;
  repositoryId: string;
  scenario: CommandProofScenario;
  workflowPath: string;
  workflowRef: string;
  workflowSha: string;
};
function numericId(value: unknown): string | null {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return proofNumericId(id) ? id : null;
}
export function trustedRun(claim: ProofProducerIdentity, value: unknown): boolean {
  const run = proofRecord(value);
  return (
    numericId(run.id) !== null &&
    run.run_attempt === 1 &&
    run.event === "workflow_dispatch" &&
    run.status === "completed" &&
    ["success", "failure"].includes(String(run.conclusion)) &&
    (run.path === claim.workflowPath ||
      run.path === claim.workflowPath + "@" + claim.workflowRef) &&
    run.display_title ===
      commandProofProfile(claim.scenario)?.runName + " [" + claim.requestId + "]" &&
    run.head_sha === claim.workflowSha &&
    numericId(proofRecord(run.repository).id) === claim.repositoryId &&
    proofRecord(run.repository).full_name === claim.repository &&
    numericId(proofRecord(run.head_repository).id) === claim.repositoryId
  );
}
export async function trustedArtifact(
  value: unknown,
  bytes: Uint8Array,
  claim: ProofProducerIdentity,
  run: Record<string, unknown>,
  name: string,
) {
  const artifact = proofRecord(value),
    producer = proofRecord(artifact.workflow_run);
  return (
    numericId(artifact.id) !== null &&
    artifact.name === name &&
    artifact.expired === false &&
    Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes === bytes.length &&
    bytes.length <= 16 * 1024 * 1024 &&
    artifact.digest === "sha256:" + (await proofDigest(bytes)) &&
    numericId(producer.id) === numericId(run.id) &&
    producer.head_sha === claim.workflowSha &&
    numericId(producer.repository_id) === claim.repositoryId &&
    numericId(producer.head_repository_id) === claim.repositoryId
  );
}
