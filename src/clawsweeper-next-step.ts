import type { NextStepAssessment } from "./clawsweeper-types.js";
import { parseDocument } from "yaml";
import { parseReportFrontMatter, readReportFrontMatterField } from "./report-front-matter.js";

export function parseNextStep(value: unknown, path = "nextStep"): NextStepAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "text")) {
    throw new Error(`${path} has unexpected keys`);
  }
  if (record.kind !== "none" && record.kind !== "required") {
    throw new Error(`${path}.kind must be none or required`);
  }
  if (typeof record.text !== "string") throw new Error(`${path}.text must be a string`);
  if (record.kind === "none" && record.text !== "") {
    throw new Error(`${path}.text must be empty for none`);
  }
  const text = record.text.trim();
  if (record.kind === "required" && !text) {
    throw new Error(`${path}.text must not be empty for required`);
  }
  return { kind: record.kind, text };
}

export function nextStepFromReport(markdown: string): NextStepAssessment | undefined {
  const field = readReportFrontMatterField(markdown, "next_step");
  if (field.status !== "value") return undefined;
  const header = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  const frontmatter = parseReportFrontMatter(markdown)!;
  // Noncanonical spellings must not hide a competing value beside the literal key.
  if (
    [...frontmatter.fields.keys(), ...frontmatter.competingKeys].some(
      (key) => key !== "next_step" && key.trim().replace(/^["']|["']$/g, "") === "next_step",
    )
  )
    return undefined;
  try {
    // Validate the header as well as the JSON value: repeated (including quoted)
    // keys, fenced examples, or malformed continuations cannot supply intent.
    if (parseDocument(header, { uniqueKeys: true }).errors.length) return undefined;
    const value: unknown = JSON.parse(field.value);
    return parseNextStep(value, "next_step");
  } catch {
    // Malformed historical metadata retains the legacy conservative projection.
    return undefined;
  }
}
