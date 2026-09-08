/** Shared, closed request/receipt boundary. Correlation IDs are not authorization. */
export const COMMAND_PROOF_SOURCE_ACTION = "command_proof_result";
export const COMMAND_PROOF_SCENARIO = "web-ui-chat-proof";
export const COMMAND_PROOF_WORKFLOW = ".github/workflows/mantis-web-ui-chat-proof.yml";
export const TELEGRAM_PROOF_SCENARIO = "telegram-bot-e2e-proof";
export const TELEGRAM_QA_SCENARIO = "telegram-markdown-parser-fidelity";
export const COMMAND_PROOF_PROFILES = {
  [COMMAND_PROOF_SCENARIO]: {
    scenario: COMMAND_PROOF_SCENARIO,
    workflowPath: COMMAND_PROOF_WORKFLOW,
    runName: "Mantis request",
    configPrefix: "CLAWSWEEPER_PROOF",
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
    configPrefix: "CLAWSWEEPER_TELEGRAM_PROOF",
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
  [TELEGRAM_QA_SCENARIO]: {
    scenario: TELEGRAM_QA_SCENARIO,
    workflowPath: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    runName: "Mantis Telegram request",
    configPrefix: "CLAWSWEEPER_TELEGRAM_PROOF",
    observerJob: "Run request-bound Telegram bot proof",
    evidenceArtifactPrefix: "mantis-request-telegram",
    observations: [
      ["qa-execution", "qa-execution.json"],
      ["qa-result", "qa-result.json"],
      ["qa-observations", "qa-observations.json"],
    ],
    scopeNotice:
      "Actual candidate Gateway send and Telegram formatter against a Crabline Bot API emulator; no Telegram Test Server, TDLib, live model, or readiness claim. This scenario tests four specific Markdown payload regressions, not general Telegram behavior.",
  },
} as const;
export type CommandProofScenario = keyof typeof COMMAND_PROOF_PROFILES;
export type CommandProofProducer = {
  workflowPath: string;
  workflowRef: string;
  workflowSha: string;
  harnessSha: string;
};
export type CommandProofProducerRegistry = Partial<
  Record<CommandProofScenario, CommandProofProducer>
>;

export function commandProofProfile(scenario: unknown) {
  return typeof scenario === "string" && Object.hasOwn(COMMAND_PROOF_PROFILES, scenario)
    ? COMMAND_PROOF_PROFILES[scenario as CommandProofScenario]
    : null;
}

export function commandProofProducerFromEnv(
  scenario: unknown,
  env: Record<string, string | undefined>,
): CommandProofProducer | null {
  const profile = commandProofProfile(scenario);
  if (!profile) return null;
  const producer = {
    workflowPath: env[profile.configPrefix + "_WORKFLOW_PATH"] ?? "",
    workflowRef: env[profile.configPrefix + "_WORKFLOW_REF"] ?? "",
    workflowSha: env[profile.configPrefix + "_WORKFLOW_SHA"] ?? "",
    harnessSha: env[profile.configPrefix + "_HARNESS_SHA"] ?? "",
  };
  return producer.workflowPath === profile.workflowPath &&
    proofText(producer.workflowRef, 200) &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(producer.workflowRef) &&
    !/^[0-9a-f]{40}$/.test(producer.workflowRef) &&
    proofSha(producer.workflowSha, 40) &&
    proofSha(producer.harnessSha, 40) &&
    producer.workflowSha === producer.harnessSha
    ? producer
    : null;
}

export function commandProofProducersFromEnv(
  env: Record<string, string | undefined>,
): CommandProofProducerRegistry {
  const producers: CommandProofProducerRegistry = {};
  for (const scenario of Object.keys(COMMAND_PROOF_PROFILES) as CommandProofScenario[]) {
    const producer = commandProofProducerFromEnv(scenario, env);
    if (producer) producers[scenario] = producer;
  }
  return producers;
}
export const COMMAND_PROOF_RECEIPT_MAX_BYTES = 64 * 1024;
export const COMMAND_PROOF_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
export const COMMAND_PROOF_LIFETIME_MS = 60 * 60 * 1000;

export type CommandProofPlan = {
  scenarios: CommandProofScenario[];
  reason: string;
  missingProof: string;
};
export type CommandProofResult = {
  outcome: "pass" | "fail";
  digest: string;
  reviewContext: string;
  runId: string;
  runAttempt: number;
};
export type CommandProofBatch = {
  // The record's claim is a binding anchor, not an assertion that it ran.
  plan?: CommandProofPlan;
  claims: CommandProofClaim[];
  index: number;
  started: boolean;
  results: Array<{ outcome: "inconclusive"; reason: string } | CommandProofResult>;
};
export const COMMAND_PROOF_BATCH_CONTEXT_MAX = 18_000;

export function commandProofBatchBinding(prompt: string) {
  const match =
    /^<!-- command-proof-batch-v1 head=([0-9a-f]{40}) body=([0-9a-f]{64}) base=([0-9a-f]{64}) base_sha=([0-9a-f]{40}) request=([0-9a-f]{64}) -->\n/.exec(
      prompt,
    );
  return match
    ? {
        headSha: match[1]!,
        bodySha256: match[2]!,
        baseRefSha256: match[3]!,
        baseSha: match[4]!,
        requestId: match[5]!,
        scenario: "batch" as const,
      }
    : null;
}

export function parseCommandProofPlan(value: unknown): CommandProofPlan | null {
  const plan = proofRecord(value);
  if (
    Object.keys(plan).sort().join() !== "missingProof,reason,scenarios" ||
    !Array.isArray(plan.scenarios) ||
    plan.scenarios.length > 3 ||
    plan.scenarios.some((id) => !commandProofProfile(id)) ||
    new Set(plan.scenarios).size !== plan.scenarios.length ||
    !proofText(plan.reason, 800) ||
    typeof plan.missingProof !== "string" ||
    plan.missingProof.length > 800 ||
    (!plan.scenarios.length && !plan.missingProof.trim())
  )
    return null;
  return plan as CommandProofPlan;
}

export function proofPlanClaimsMatch(
  anchor: CommandProofClaim,
  claims: unknown,
  plan: CommandProofPlan,
): claims is CommandProofClaim[] {
  return (
    Array.isArray(claims) &&
    claims.length === plan.scenarios.length &&
    claims.every((value, index) => {
      const claim = parseCommandProofClaim(value);
      return (
        claim &&
        claim.scenario === plan.scenarios[index] &&
        [
          "repository",
          "repositoryId",
          "pullRequest",
          "headSha",
          "baseSha",
          "bodySha256",
          "targetBranch",
          "sourceCommentId",
          "sourceCommentUpdatedAt",
          "sourceCommentBodySha256",
        ].every((key) => proofRecord(claim)[key] === proofRecord(anchor)[key])
      );
    }) &&
    new Set(claims.map((claim) => claim.requestId)).size === claims.length
  );
}

export type CommandProofClaim = {
  requestId: string;
  repository: string;
  repositoryId: string;
  pullRequest: number;
  headSha: string;
  baseSha: string;
  bodySha256: string;
  targetBranch: string;
  scenario: CommandProofScenario;
  workflowPath: string;
  workflowRef: string;
  workflowSha: string;
  harnessSha: string;
  sourceCommentId: string;
  sourceCommentUpdatedAt: string;
  sourceCommentBodySha256: string;
};
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
  scenario: CommandProofScenario;
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
export function parseCommandProofClaim(value: unknown): CommandProofClaim | null {
  const c = proofRecord(value);
  const profile = commandProofProfile(c.scenario);
  if (
    !closed(c, [
      "requestId",
      "repository",
      "repositoryId",
      "pullRequest",
      "headSha",
      "baseSha",
      "bodySha256",
      "targetBranch",
      "scenario",
      "workflowPath",
      "workflowRef",
      "workflowSha",
      "harnessSha",
      "sourceCommentId",
      "sourceCommentUpdatedAt",
      "sourceCommentBodySha256",
    ]) ||
    c.repository !== "openclaw/openclaw" ||
    !proofNumericId(c.repositoryId) ||
    !Number.isSafeInteger(c.pullRequest) ||
    Number(c.pullRequest) < 1 ||
    !proofSha(c.requestId, 64) ||
    !proofSha(c.headSha, 40) ||
    !proofSha(c.baseSha, 40) ||
    !proofSha(c.bodySha256, 64) ||
    !profile ||
    !proofText(c.targetBranch, 200) ||
    !proofText(c.workflowRef, 200) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(c.workflowRef) ||
    /^[0-9a-f]{40}$/.test(c.workflowRef) ||
    c.workflowPath !== profile.workflowPath ||
    c.harnessSha !== c.workflowSha ||
    !proofSha(c.workflowSha, 40) ||
    !proofSha(c.harnessSha, 40) ||
    !proofNumericId(c.sourceCommentId) ||
    !proofText(c.sourceCommentUpdatedAt, 40) ||
    !Number.isFinite(Date.parse(c.sourceCommentUpdatedAt)) ||
    !proofSha(c.sourceCommentBodySha256, 64)
  )
    return null;
  return c as CommandProofClaim;
}
export function parseMantisProofReceipt(value: unknown): MantisProofReceipt | null {
  const r = proofRecord(value),
    repo = proofRecord(r.repository),
    workflow = proofRecord(r.workflow);
  const profile = commandProofProfile(r.scenario);
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
