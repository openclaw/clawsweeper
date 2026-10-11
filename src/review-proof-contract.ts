/** Shared receipt and archive validation for inline hosted review proof. */
export const REVIEW_PROOF_SCENARIO = "web-ui-chat-proof";
export const REVIEW_PROOF_WORKFLOW = ".github/workflows/mantis-web-ui-chat-proof.yml";
export const TELEGRAM_PROOF_SCENARIO = "telegram-bot-e2e-proof";
export const REVIEW_PROOF_PROFILES = {
  [REVIEW_PROOF_SCENARIO]: {
    scenario: REVIEW_PROOF_SCENARIO,
    workflowPath: REVIEW_PROOF_WORKFLOW,
    runName: "Mantis request",
    observerJob: "Run request-bound web chat proof",
    evidenceArtifactPrefix: "mantis-request-web-ui",
    observations: [
      ["chat-send", "chat-send.json"],
      ["final-reply", "final-reply.json"],
      ["final-screenshot", "final-reply.png"],
    ],
    scopeNotice:
      "This is UI chat against a mocked Gateway ONLY; not real providers, channels or authentication.",
  },
  [TELEGRAM_PROOF_SCENARIO]: {
    scenario: TELEGRAM_PROOF_SCENARIO,
    workflowPath: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    runName: "Mantis Telegram request",
    observerJob: "Run request-bound Telegram bot proof",
    evidenceArtifactPrefix: "mantis-request-telegram",
    observations: [
      ["telegram-send", "telegram-send.json"],
      ["provider-request", "provider-request.json"],
      ["telegram-reply", "telegram-reply.json"],
    ],
    scopeNotice:
      "This is Telegram bot DM via TelegramTestServer/TDLib with an external mock provider ONLY; not live Telegram, real providers, groups/topics or blanket authority-chain proof.",
  },
} as const;
export type ReviewProofScenario = keyof typeof REVIEW_PROOF_PROFILES;

export function reviewProofProfile(scenario: unknown) {
  return typeof scenario === "string" && Object.hasOwn(REVIEW_PROOF_PROFILES, scenario)
    ? REVIEW_PROOF_PROFILES[scenario as ReviewProofScenario]
    : null;
}

export const REVIEW_PROOF_RECEIPT_MAX_BYTES = 64 * 1024;
export const REVIEW_PROOF_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;

export type ProofObservation = {
  id: string;
  expected: string;
  actual: string;
  source_path: string;
  sha256: string;
  availability: "present" | "missing" | "partial";
  authority: "trusted_observer" | "candidate_reported";
};
export type MantisProofReceipt = {
  schema: "mantis.request-proof.v1";
  request_id: string;
  repository: { id: string; full_name: string };
  pull_request: number;
  candidate_sha: string;
  scenario: ReviewProofScenario;
  workflow: { path: string; sha: string };
  harness: { sha: string };
  run: { id: string; attempt: number };
  evidence: { artifact_id: string; artifact_name: string; sha256: string } | null;
  execution_outcome: "completed" | "failed" | "cancelled" | "timed_out" | "skipped";
  assertion_outcome: "pass" | "fail" | "inconclusive";
  observations: ProofObservation[];
  limits: string[];
  reason?: string;
};

export function proofRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export const proofSha = (value: unknown, length: 40 | 64): value is string =>
  typeof value === "string" && new RegExp("^[0-9a-f]{" + length + "}$").test(value);
export const proofNumericId = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
export const proofText = (value: unknown, max: number): value is string => {
  if (!(typeof value === "string" && value.length > 0 && value.length <= max)) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 && code !== 9 && code !== 10 && code !== 13) return false;
  }
  return true;
};
export const proofSafePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 240 &&
  /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
  value.split("/").every((segment) => segment !== "." && segment !== "..");
function closed(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
export function parseMantisProofReceipt(value: unknown): MantisProofReceipt | null {
  const r = proofRecord(value),
    repo = proofRecord(r.repository),
    workflow = proofRecord(r.workflow);
  const profile = reviewProofProfile(r.scenario);
  const harness = proofRecord(r.harness),
    run = proofRecord(r.run),
    evidence = proofRecord(r.evidence);
  if (
    !closed(
      r,
      [
        "schema",
        "request_id",
        "repository",
        "pull_request",
        "candidate_sha",
        "scenario",
        "workflow",
        "harness",
        "run",
        "evidence",
        "execution_outcome",
        "assertion_outcome",
        "observations",
        "limits",
      ],
      ["reason"],
    ) ||
    r.schema !== "mantis.request-proof.v1" ||
    !proofSha(r.request_id, 64) ||
    !closed(repo, ["id", "full_name"]) ||
    !proofNumericId(repo.id) ||
    repo.full_name !== "openclaw/openclaw" ||
    !Number.isSafeInteger(r.pull_request) ||
    Number(r.pull_request) < 1 ||
    !proofSha(r.candidate_sha, 40) ||
    !profile ||
    !closed(workflow, ["path", "sha"]) ||
    !proofSafePath(workflow.path) ||
    workflow.path !== profile.workflowPath ||
    !proofSha(workflow.sha, 40) ||
    !closed(harness, ["sha"]) ||
    !proofSha(harness.sha, 40) ||
    !closed(run, ["id", "attempt"]) ||
    !proofNumericId(run.id) ||
    !Number.isSafeInteger(run.attempt) ||
    run.attempt !== 1 ||
    !["completed", "failed", "cancelled", "timed_out", "skipped"].includes(
      String(r.execution_outcome),
    ) ||
    !["pass", "fail", "inconclusive"].includes(String(r.assertion_outcome)) ||
    !Array.isArray(r.observations) ||
    r.observations.length > 32 ||
    !Array.isArray(r.limits) ||
    r.limits.length > 16 ||
    !r.limits.every((limit) => proofText(limit, 2048)) ||
    (Object.hasOwn(r, "reason") && !proofText(r.reason, 2048))
  )
    return null;
  if (r.evidence === null) {
    if (r.assertion_outcome !== "inconclusive" || !proofText(r.reason, 2048)) return null;
  } else if (
    !closed(evidence, ["artifact_id", "artifact_name", "sha256"]) ||
    !proofNumericId(evidence.artifact_id) ||
    !proofText(evidence.artifact_name, 200) ||
    !/^[A-Za-z0-9_.-]+$/.test(evidence.artifact_name) ||
    !proofSha(evidence.sha256, 64)
  )
    return null;
  const ids = new Set<string>(),
    paths = new Set<string>();
  for (const value of r.observations) {
    const o = proofRecord(value);
    if (
      !closed(o, [
        "id",
        "expected",
        "actual",
        "source_path",
        "sha256",
        "availability",
        "authority",
      ]) ||
      !proofText(o.id, 64) ||
      !/^[a-z0-9][a-z0-9-]*$/.test(o.id) ||
      !proofText(o.expected, 2048) ||
      !proofText(o.actual, 2048) ||
      !proofSafePath(o.source_path) ||
      !proofSha(o.sha256, 64) ||
      !["present", "missing", "partial"].includes(String(o.availability)) ||
      !["trusted_observer", "candidate_reported"].includes(String(o.authority)) ||
      ids.has(o.id) ||
      paths.has(o.source_path.toLowerCase())
    )
      return null;
    ids.add(o.id);
    paths.add(o.source_path.toLowerCase());
  }
  return r as MantisProofReceipt;
}
