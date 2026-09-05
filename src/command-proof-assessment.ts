import { createHash } from "node:crypto";
import { parseReportFrontMatter, readReportFrontMatterField } from "./report-front-matter.js";
import { AUTHORITY_CHAIN_PROOF_MARKER } from "./clawsweeper-policy.js";
import { stableJson } from "./stable-json.js";
import { primaryBodySourceSha256 } from "./clawsweeper-primary-body.js";
import {
  COMMAND_PROOF_SCENARIO,
  TELEGRAM_PROOF_SCENARIO,
  type CommandProofScenario,
  proofText,
} from "./command-proof-contract.js";

/** A canonical proof-only marker reduces publication authority; malformed markers fail closed. */
export function commandProofOnlyReport(markdown: string): boolean {
  const marker = readReportFrontMatterField(markdown, "command_proof_only");
  if (marker.status === "absent") return false;
  if (marker.status === "value") {
    if (marker.value.trim() === "true") return true;
    if (marker.value.trim() === "false") return false;
  }
  throw new Error("invalid or ambiguous proof-only publication marker");
}

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
  scenario: CommandProofScenario;
} | null {
  const match =
    /^<!-- command-proof-assessment-v1 head=([0-9a-f]{40}) body=([0-9a-f]{64}) base=([0-9a-f]{64}) base_sha=([0-9a-f]{40}) request=([0-9a-f]{64}) scenario=(web-ui-chat-proof|telegram-bot-e2e-proof) -->\n/.exec(
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
  baseSha: unknown,
) {
  if (
    head !== binding.headSha ||
    baseSha !== binding.baseSha ||
    commandProofBaseRefSha256(baseRef) !== binding.baseRefSha256 ||
    (typeof body === "string"
      ? createHash("sha256").update(body).digest("hex")
      : primaryBodySourceSha256(body)) !== binding.bodySha256
  )
    throw new Error("commanded proof subject changed; new explicit proof request required");
}

export function assertNoNewProofReviewBlockers(
  prior: readonly unknown[],
  reviewed: readonly unknown[],
): void {
  const normalize = (value: unknown) => {
    const record = { ...(value as Record<string, unknown>) };
    delete record.confidenceScore;
    return stableJson(record);
  };
  const known = new Set(prior.map(normalize));
  if (reviewed.some((finding) => !known.has(normalize(finding)))) {
    throw new Error(
      "proof reassessment found additional non-proof concerns; full review required before promotion",
    );
  }
}

const REAL_BEHAVIOR_PROOF_FIELDS = [
  "real_behavior_proof_status",
  "real_behavior_proof_evidence_kind",
  "real_behavior_proof_needs_contributor_action",
];
const TELEGRAM_PROOF_FIELDS = ["telegram_visible_proof_status"];
// Lease ownership follows the current publication, not full-review freshness.
const HANDOFF_FIELDS = new Set(["review_lease_owner", "review_lease_comment_id"]);
const field = (markdown: string, key: string) => {
  const result = readReportFrontMatterField(markdown, key);
  return result.status === "value" ? result.value.trim() : null;
};
/** Only independent proof assessment crosses into the canonical report. All
 * code/security/CI/decision/rating sections and the last FULL review age survive. */
export function foldCommandProofAssessment(
  prior: string | undefined,
  assessed: string,
  requestId: string,
  expectedBodySha256: string,
  expectedBaseRefSha256: string,
  expectedBaseSha: string,
  scenario: CommandProofScenario = COMMAND_PROOF_SCENARIO,
): string {
  if (!prior) throw new Error("commanded proof requires an existing full review");
  const old = parseReportFrontMatter(prior),
    fresh = parseReportFrontMatter(assessed);
  if (
    !old ||
    !fresh ||
    old.ambiguous ||
    fresh.ambiguous ||
    field(prior, "review_status") !== "complete" ||
    field(assessed, "review_status") !== "complete"
  )
    throw new Error("commanded proof requires complete unambiguous reviews");
  for (const key of ["repository", "number", "type", "pull_head_sha"]) {
    const before = field(prior, key),
      after = field(assessed, key);
    if (!before || before === "unknown" || before !== after)
      throw new Error("commanded proof review identity mismatch");
  }
  if (
    !/^[0-9a-f]{64}$/.test(expectedBodySha256) ||
    field(prior, "reviewed_body_sha256") !== expectedBodySha256 ||
    field(assessed, "reviewed_body_sha256") !== expectedBodySha256
  ) {
    throw new Error(
      "commanded proof requires a full review bound to the claimed PR body; full review required",
    );
  }
  const oldHeader = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(prior)!;
  const freshHeader = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(assessed)!;
  if (
    !/^[0-9a-f]{64}$/.test(expectedBaseRefSha256) ||
    field(prior, "reviewed_base_ref_sha256") !== expectedBaseRefSha256 ||
    field(assessed, "reviewed_base_ref_sha256") !== expectedBaseRefSha256
  ) {
    throw new Error(
      "commanded proof requires a full review bound to the claimed PR base; full review required",
    );
  }
  if (
    !/^[0-9a-f]{40}$/.test(expectedBaseSha) ||
    field(prior, "reviewed_base_sha") !== expectedBaseSha ||
    field(assessed, "reviewed_base_sha") !== expectedBaseSha
  ) {
    throw new Error(
      "commanded proof requires a full review bound to the claimed PR base commit; full review required",
    );
  }
  const values = new Map([...old.fields].map(([key, entries]) => [key, entries[0]!]));
  const proofFields = [
    ...REAL_BEHAVIOR_PROOF_FIELDS,
    ...(scenario === TELEGRAM_PROOF_SCENARIO ? TELEGRAM_PROOF_FIELDS : []),
  ];
  for (const [key, entries] of fresh.fields) {
    if (proofFields.includes(key) || HANDOFF_FIELDS.has(key)) values.set(key, entries[0]!);
  }
  for (const key of proofFields)
    if (!fresh.fields.has(key)) throw new Error("incomplete independent proof assessment");
  values.set("command_proof_only", " true");
  values.set("command_proof_assessed_at", " " + (field(assessed, "reviewed_at") || "unknown"));
  values.set("command_proof_request_id", " " + requestId);
  values.set("command_proof_prior_reviewed_at", " " + (field(prior, "reviewed_at") || "unknown"));
  const beforeBody = prior.slice(oldHeader[0].length),
    afterBody = assessed.slice(freshHeader[0].length);
  const beforeSection = proofSection(beforeBody, "Real Behavior Proof"),
    afterSection = proofSection(afterBody, "Real Behavior Proof");
  if (
    beforeBody
      .slice(beforeSection.start, beforeSection.end)
      .includes("Summary: " + AUTHORITY_CHAIN_PROOF_MARKER)
  ) {
    throw new Error("limited commanded proof cannot replace required authority-chain proof");
  }
  let body =
    beforeBody.slice(0, beforeSection.start) +
    afterBody.slice(afterSection.start, afterSection.end) +
    beforeBody.slice(beforeSection.end);
  if (scenario === TELEGRAM_PROOF_SCENARIO) {
    const currentTelegram = proofSection(body, "Telegram Visible Proof"),
      freshTelegram = proofSection(afterBody, "Telegram Visible Proof");
    body =
      body.slice(0, currentTelegram.start) +
      afterBody.slice(freshTelegram.start, freshTelegram.end) +
      body.slice(currentTelegram.end);
  }
  return (
    "---\n" + [...values].map(([key, value]) => key + ":" + value).join("\n") + "\n---\n" + body
  );
}
function proofSection(body: string, title: "Real Behavior Proof" | "Telegram Visible Proof") {
  const marker = "## " + title + "\n";
  const matches = [...body.matchAll(new RegExp("^## " + title + "\\r?\\n", "gm"))];
  if (matches.length !== 1) throw new Error("ambiguous proof report section");
  const start = matches[0]!.index!;
  const next = body.indexOf("\n## ", start + marker.length);
  return { start, end: next < 0 ? body.length : next + 1 };
}
