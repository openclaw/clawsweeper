import type { NextStepAssessment } from "./clawsweeper-types.js";

export function parseNextStep(value: unknown, path = "nextStep"): NextStepAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "text")) {
    throw new Error(`${path} has unexpected keys`);
  }
  if (record.kind !== "none" && record.kind !== "required" && record.kind !== "maintainer") {
    throw new Error(`${path}.kind must be none, required, or maintainer`);
  }
  if (typeof record.text !== "string") throw new Error(`${path}.text must be a string`);
  if (record.kind === "none" && record.text !== "") {
    throw new Error(`${path}.text must be empty for none`);
  }
  const text = record.text.trim();
  if (record.kind !== "none" && !text) {
    throw new Error(`${path}.text must not be empty for ${record.kind}`);
  }
  return { kind: record.kind, text };
}
