import { createHash } from "node:crypto";
import { isRecord } from "./value-coerce.js";

export const INTAKE_POLICY = "intake-v1";
export const INTAKE_MAX_INPUT_BYTES = 12_000;
export const INTAKE_MAX_RESPONSE_BYTES = 32_000;
export const INTAKE_TIMEOUT_MS = 20_000;

// These describe the submission, never the truth of its claims or patch quality.
export const INTAKE_QUESTIONS = [
  {
    name: "category",
    instructions:
      "Classify the author's request, not whether the claimed bug is real. Use unclear when ambiguous.",
    choices: [
      {
        value: "bug",
        description: "Reports existing behavior failing, including a claimed regression.",
      },
      { value: "feature", description: "Requests a new capability." },
      { value: "docs", description: "Documentation-only request or correction." },
      { value: "support", description: "Asks how to use or configure existing behavior." },
      { value: "unclear", description: "Insufficient or ambiguous evidence." },
    ],
  },
  {
    name: "reproduction",
    instructions:
      "Does the submission itself include concrete actions or an executable example to trigger the claimed failure? Do not reproduce anything.",
    choices: [
      {
        value: "present",
        description: "Concrete trigger actions or an executable reproducer are supplied.",
      },
      {
        value: "missing",
        description: "A failure is claimed but no concrete trigger is supplied.",
      },
      { value: "not_applicable", description: "No failure is claimed." },
      { value: "unclear", description: "Cannot determine from the submission." },
    ],
  },
  {
    name: "environment",
    instructions:
      "Does the submission identify a product version and relevant platform/runtime? Only inspect supplied text.",
    choices: [
      { value: "present", description: "Both version and relevant environment are supplied." },
      {
        value: "missing",
        description: "A failure is claimed and version or environment is absent.",
      },
      { value: "not_applicable", description: "No failure is claimed." },
      { value: "unclear", description: "Cannot determine from the submission." },
    ],
  },
] as const;

export type IntakeQuestion = (typeof INTAKE_QUESTIONS)[number]["name"];
export type IntakeAnswers = Record<IntakeQuestion, string>;
export interface IntakePacket {
  repository: string;
  number: number;
  kind: "issue" | "pull_request";
  title: string;
  body: string;
}
export interface IntakeRequest {
  packet: IntakePacket;
  input: string;
  digest: string;
}
export type IntakeUsage = { inputTokens: number; outputTokens: number } | null;
export interface IntakeResult {
  policy: typeof INTAKE_POLICY;
  digest: string;
  backend: "responses" | "decisions";
  outcome: "classified" | "unavailable" | "refused" | "invalid" | "timeout";
  answers: IntakeAnswers | null;
  usage: IntakeUsage;
  decisionProbabilities?: Record<IntakeQuestion, Record<string, number>>;
  durationMs: number;
}

export function intakeRequest(packet: IntakePacket): IntakeRequest {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(packet.repository) ||
    !Number.isSafeInteger(packet.number) ||
    packet.number <= 0 ||
    !["issue", "pull_request"].includes(packet.kind) ||
    typeof packet.title !== "string" ||
    typeof packet.body !== "string"
  )
    throw new Error("Invalid intake packet");
  const submission: IntakePacket = {
    repository: packet.repository,
    number: packet.number,
    kind: packet.kind,
    title: packet.title,
    body: packet.body,
  };
  const input = JSON.stringify(submission);
  // Do not classify a silently truncated issue: missing fields would be invented.
  if (Buffer.byteLength(input) > INTAKE_MAX_INPUT_BYTES)
    throw new Error("Intake packet exceeds byte budget");
  return {
    packet: submission,
    input,
    digest: createHash("sha256").update(INTAKE_POLICY).update("\0").update(input).digest("hex"),
  };
}

export const INTAKE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    INTAKE_QUESTIONS.map((q) => [
      q.name,
      { type: "string", enum: q.choices.map((c) => c.value), description: q.instructions },
    ]),
  ),
  required: INTAKE_QUESTIONS.map((q) => q.name),
  additionalProperties: false,
};

export function parseIntakeAnswers(value: unknown): IntakeAnswers | null {
  if (!isRecord(value) || Object.keys(value).length !== INTAKE_QUESTIONS.length) return null;
  for (const question of INTAKE_QUESTIONS) {
    if (!question.choices.some((choice) => choice.value === value[question.name])) return null;
  }
  return value as IntakeAnswers;
}

export const INTAKE_LABELS = [
  "clawsweeper:intake:bug",
  "clawsweeper:intake:feature",
  "clawsweeper:intake:docs",
  "clawsweeper:intake:support",
  "clawsweeper:intake:needs-repro",
  "clawsweeper:intake:needs-environment",
] as const;

export function intakeLabels(result: IntakeResult): string[] {
  const answers = result.outcome === "classified" ? parseIntakeAnswers(result.answers) : null;
  if (!answers) return [];
  const labels: string[] = [];
  if (answers.category !== "unclear") labels.push(`clawsweeper:intake:${answers.category}`);
  if (answers.category === "bug") {
    if (answers.reproduction === "missing") labels.push("clawsweeper:intake:needs-repro");
    if (answers.environment === "missing") labels.push("clawsweeper:intake:needs-environment");
  }
  return labels;
}
