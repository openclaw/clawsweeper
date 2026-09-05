import {
  proofRecord,
  proofNumericId,
  proofText,
  TELEGRAM_QA_SCENARIO,
  type CommandProofClaim,
} from "../command-proof-contract.js";

const CASES = ["all-space-code", "unclosed-link-label", "ipv6-link", "table-code-leading-space"];
// An observed empty payload is data too: the canonical runner decides failure.
const observationText = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max;
function closed(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Facts from the pinned trusted QA observer, never candidate verdicts or receipt prose. */
export function verifyTelegramQaEvidence(
  files: Map<string, Buffer>,
  claim: CommandProofClaim,
  runId: string,
) {
  const read = (name: string) => {
    const bytes = files.get(name);
    if (!bytes || bytes.length > 64 * 1024) throw new Error("invalid QA evidence size");
    return proofRecord(JSON.parse(bytes.toString("utf8")));
  };
  if (files.size !== 3) throw new Error("invalid QA inventory");
  const execution = read("qa-execution.json"),
    result = read("qa-result.json"),
    observations = read("qa-observations.json");
  if (
    !closed(execution, [
      "schema",
      "request_id",
      "candidate_sha",
      "harness_sha",
      "run_id",
      "run_attempt",
      "scenario",
      "transport",
      "live_service",
      "candidate_quiescent",
    ]) ||
    execution.schema !== "mantis.telegram-qa-execution.v1" ||
    execution.request_id !== claim.requestId ||
    execution.candidate_sha !== claim.headSha ||
    execution.harness_sha !== claim.harnessSha ||
    execution.run_id !== runId ||
    execution.run_attempt !== 1 ||
    execution.scenario !== TELEGRAM_QA_SCENARIO ||
    execution.transport !== "Crabline" ||
    execution.live_service !== false ||
    execution.candidate_quiescent !== true
  )
    throw new Error("invalid QA execution identity");
  if (
    !closed(result, ["schema", "scenario", "status", "steps"]) ||
    result.schema !== "mantis.telegram-qa-result.v1" ||
    result.scenario !== TELEGRAM_QA_SCENARIO ||
    !["pass", "fail"].includes(String(result.status)) ||
    !Array.isArray(result.steps) ||
    result.steps.length < 1 ||
    result.steps.length > 8
  )
    throw new Error("incomplete QA result");
  const steps = result.steps.map(proofRecord);
  if (
    steps.some(
      (step) =>
        !closed(step, ["name", "status"]) ||
        !proofText(step.name, 240) ||
        !["pass", "fail"].includes(String(step.status)),
    ) ||
    result.status !== (steps.every((step) => step.status === "pass") ? "pass" : "fail")
  )
    throw new Error("inconsistent QA result");
  if (
    !closed(observations, ["schema", "scenario", "cases"]) ||
    observations.schema !== "mantis.telegram-qa-observations.v1" ||
    observations.scenario !== TELEGRAM_QA_SCENARIO ||
    !Array.isArray(observations.cases) ||
    observations.cases.length !== CASES.length
  )
    throw new Error("incomplete QA observations");
  const cases = observations.cases.map(proofRecord);
  if (
    new Set(cases.map((entry) => entry.case)).size !== CASES.length ||
    cases.some(
      (entry) =>
        !closed(entry, ["case", "messageId", "expectedHtml", "outboundHtml", "acceptedPayloads"]) ||
        !CASES.includes(String(entry.case)) ||
        !proofNumericId(entry.messageId) ||
        !observationText(entry.expectedHtml, 4096) ||
        !observationText(entry.outboundHtml, 4096) ||
        !Array.isArray(entry.acceptedPayloads) ||
        entry.acceptedPayloads.length < 1 ||
        entry.acceptedPayloads.length > 8 ||
        entry.acceptedPayloads.some((raw) => {
          const payload = proofRecord(raw);
          return (
            !closed(payload, ["text", "parseMode"]) ||
            !observationText(payload.text, 4096) ||
            !(payload.parseMode === null || observationText(payload.parseMode, 32))
          );
        }),
    )
  )
    throw new Error("invalid QA observations");
  return {
    outcome: result.status as "pass" | "fail",
    observations: [
      {
        id: "qa-execution",
        expected: "Isolated exact candidate; emulated Telegram transport",
        actual: "Crabline; candidate quiescent; no live service",
      },
      {
        id: "qa-result",
        expected: "Trusted catalog scenario assertions",
        actual: JSON.stringify({ status: result.status, steps }),
      },
      {
        id: "qa-observations",
        expected: "Four Markdown payload regression cases",
        actual: JSON.stringify(cases),
      },
    ],
  };
}
