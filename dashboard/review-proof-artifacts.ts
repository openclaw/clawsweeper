import {
  proofArtifactMetadataMatches,
  type ProofProducerIdentity,
} from "../src/proof-artifact-contract.ts";
export {
  proofReceiptArtifactName,
  trustedRun,
  type ProofProducerIdentity,
} from "../src/proof-artifact-contract.ts";
import {
  commandProofProfile,
  proofRecord,
  type CommandProofScenario,
} from "../src/command-proof-contract.ts";
import { sha256Hex } from "./exact-review-direct-publication.ts";

export const proofDigest = (bytes: string | Uint8Array) =>
  sha256Hex(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
export function proofEvidenceArtifactName(
  _id: string,
  runId: string,
  attempt: number,
  scenario: CommandProofScenario,
) {
  return commandProofProfile(scenario)!.evidenceArtifactPrefix + "-" + runId + "-" + attempt;
}
export async function trustedArtifact(
  value: unknown,
  bytes: Uint8Array,
  claim: ProofProducerIdentity,
  run: Record<string, unknown>,
  name: string,
) {
  return (
    proofArtifactMetadataMatches(value, bytes.length, claim, run, name) &&
    proofRecord(value).digest === "sha256:" + (await proofDigest(bytes))
  );
}
