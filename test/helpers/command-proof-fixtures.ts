import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type { CommandProofClaim, MantisProofReceipt } from "../../src/command-proof-contract.ts";
import {
  proofReceiptArtifactName,
  proofEvidenceArtifactName,
} from "../../dist/repair/proof-receipt-verification.js";
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function proofFixture(requestId = "d".repeat(64)) {
  const head = "a".repeat(40),
    workflow = "b".repeat(40),
    body = "Change browser chat rendering.";
  const command = "/clawsweeper proof web-ui-chat-proof " + head;
  const updatedAt = new Date().toISOString();
  const claim: CommandProofClaim = {
    requestId,
    repository: "openclaw/openclaw",
    repositoryId: "123",
    pullRequest: 42,
    headSha: head,
    baseSha: "c".repeat(40),
    bodySha256: digest(body),
    targetBranch: "main",
    scenario: "web-ui-chat-proof",
    workflowPath: ".github/workflows/mantis-web-ui-chat-proof.yml",
    workflowRef: "mantis-proof-v1",
    workflowSha: workflow,
    harnessSha: workflow,
    sourceCommentId: "200",
    sourceCommentUpdatedAt: updatedAt,
    sourceCommentBodySha256: digest(command),
  };
  const live = {
    repository: { id: 123, full_name: claim.repository, private: false, archived: false },
    pull: {
      number: 42,
      state: "open",
      locked: false,
      body,
      head: { sha: head, repo: { id: 123 } },
      base: { ref: "main", sha: claim.baseSha },
    },
    comment: {
      id: 200,
      body: command,
      updated_at: updatedAt,
      user: { type: "User", login: "maintainer" },
      issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/42",
    },
    permission: { permission: "maintain" },
  };
  const run = {
    id: 300,
    run_attempt: 1,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    path: claim.workflowPath,
    head_sha: workflow,
    repository: { id: 123, full_name: claim.repository },
    head_repository: { id: 123 },
    display_title: "Mantis [" + requestId + "]",
  };
  const observation = Buffer.from(
    JSON.stringify({ finalReply: "fixture final reply", phase: "final" }),
  );
  const sourceFiles = ["chat-send.json", "final-reply.json", "final-reply.png"];
  const evidenceArchive = zip(sourceFiles.map((name) => ({ name, content: observation })));
  const jobs = {
    total_count: 2,
    jobs: ["Run request-bound web chat proof", "Finalize request-bound evidence"].map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
      run_id: 300,
      head_sha: workflow,
    })),
  };
  const evidenceArtifact = artifactMetadata(
    400,
    proofEvidenceArtifactName(requestId, "300", 1),
    evidenceArchive,
    workflow,
  );
  const receipt: MantisProofReceipt = {
    schema: "mantis.request-proof.v1",
    request_id: requestId,
    repository: { id: "123", full_name: claim.repository },
    pull_request: 42,
    candidate_sha: head,
    scenario: claim.scenario,
    workflow: { path: claim.workflowPath, sha: workflow },
    harness: { sha: workflow },
    run: { id: "300", attempt: 1 },
    evidence: {
      artifact_id: "400",
      artifact_name: evidenceArtifact.name,
      sha256: digest(evidenceArchive),
    },
    execution_outcome: "completed",
    assertion_outcome: "pass",
    observations: ["chat-send", "final-reply", "final-screenshot"].map((id, index) => ({
      id,
      expected: "fixture final reply",
      actual: "fixture final reply",
      source_path: sourceFiles[index]!,
      sha256: digest(observation),
      availability: "present",
      authority: "trusted_observer",
    })),
    limits: ["UI with mocked Gateway only; not live channel or provider proof."],
  };
  const receiptArchive = zip([
    { name: "receipt.json", content: Buffer.from(JSON.stringify(receipt)) },
  ]);
  const receiptArtifact = artifactMetadata(
    401,
    proofReceiptArtifactName(requestId, "300", 1),
    receiptArchive,
    workflow,
  );
  return {
    claim,
    live,
    run,
    jobs,
    receipt,
    evidenceArchive,
    evidenceArtifact,
    receiptArchive,
    receiptArtifact,
  };
}
export function artifactMetadata(id: number, name: string, bytes: Buffer, sha: string) {
  return {
    id,
    name,
    expired: false,
    digest: "sha256:" + digest(bytes),
    size_in_bytes: bytes.length,
    workflow_run: { id: 300, head_sha: sha, repository_id: 123, head_repository_id: 123 },
  };
}
export function replaceReceipt(fixture: ReturnType<typeof proofFixture>, receipt: unknown) {
  const receiptArchive = zip([
    { name: "receipt.json", content: Buffer.from(JSON.stringify(receipt)) },
  ]);
  return {
    ...fixture,
    receiptArchive,
    receiptArtifact: artifactMetadata(
      401,
      fixture.receiptArtifact.name,
      receiptArchive,
      fixture.claim.workflowSha,
    ),
  };
}
export function zip(
  entries: Array<{ name: string; content: Buffer; mode?: number; compressed?: boolean }>,
): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = entry.compressed ? deflateRawSync(entry.content) : entry.content;
    const method = entry.compressed ? 8 : 0,
      crc = crc32(entry.content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(entry.content.length, 22);
    header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(0x314, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(0x800, 8);
    index.writeUInt16LE(method, 10);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(entry.content.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(((entry.mode ?? 0x81a4) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(index, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function crc32(value: Buffer) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
