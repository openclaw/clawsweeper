import { createHash } from "node:crypto";
import { primaryBodySourceSha256 } from "./clawsweeper-primary-body.js";
import { type CommandProofScenario, proofText } from "./command-proof-contract.js";
import { commandProofBatchBinding } from "./command-proof-contract.js";

/** Hash the exact bounded ref; never normalize or infer a missing target. */
export function commandProofBaseRefSha256(ref: unknown): string | null {
  return proofText(ref, 200) ? createHash("sha256").update(ref).digest("hex") : null;
}

export function commandProofBinding(prompt: string): {
  headSha: string;
  bodySha256: string;
  baseRefSha256: string;
  baseSha: string;
  requestId: string;
  scenario: CommandProofScenario | "batch";
} | null {
  const batch = commandProofBatchBinding(prompt);
  if (batch) return batch;
  const match =
    /^<!-- command-proof-assessment-v1 head=([0-9a-f]{40}) body=([0-9a-f]{64}) base=([0-9a-f]{64}) base_sha=([0-9a-f]{40}) request=([0-9a-f]{64}) scenario=(web-ui-chat-proof|telegram-bot-e2e-proof|telegram-markdown-parser-fidelity) -->\n/.exec(
      prompt,
    );
  return match
    ? {
        headSha: match[1]!,
        bodySha256: match[2]!,
        baseRefSha256: match[3]!,
        baseSha: match[4]!,
        requestId: match[5]!,
        scenario: match[6]! as CommandProofScenario,
      }
    : null;
}
export function assertCommandProofSubject(
  binding: NonNullable<ReturnType<typeof commandProofBinding>>,
  head: string | null,
  body: unknown,
  baseRef: unknown,
  _baseSha: unknown,
) {
  if (
    head !== binding.headSha ||
    commandProofBaseRefSha256(baseRef) !== binding.baseRefSha256 ||
    (typeof body === "string"
      ? createHash("sha256").update(body).digest("hex")
      : primaryBodySourceSha256(body)) !== binding.bodySha256
  )
    throw new Error("commanded proof subject changed; new explicit proof request required");
}
