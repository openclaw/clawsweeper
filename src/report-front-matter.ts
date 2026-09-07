import { markdownFenceStateAfterLine } from "./clawsweeper-markdown.ts";

export type FrontMatterField =
  | { status: "absent" }
  | { status: "ambiguous" }
  | { status: "value"; value: string };

interface ReportFrontMatter {
  fields: Map<string, string[]>;
  bodyKeys: Set<string>;
  competingKeys: Set<string>;
  ambiguous: boolean;
}

// Preserve literal keys and raw single-line values; decoding belongs to each reader.
// Comments, list entries, and indented data are never top-level fields.
function fieldEntry(line: string): [string, string] | null {
  if (/^(?:\s|#|-(?:\s|$))/.test(line)) return null;
  const separator = line.indexOf(":");
  return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : null;
}

export function parseReportFrontMatter(markdown: string): ReportFrontMatter | null {
  const header = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!header) return null;
  const fields = new Map<string, string[]>();
  for (const line of (header[1] ?? "").split(/\r?\n/)) {
    const entry = fieldEntry(line);
    if (!entry) continue;
    const [key, value] = entry;
    const values = fields.get(key) ?? [];
    values.push(value);
    fields.set(key, values);
  }

  const bodyKeys = new Set<string>();
  let fence: string | null = null;
  // The first body lines can be the rest of a header cut off by an injected ---.
  // After prose, only a complete delimiter-bounded metadata block competes.
  let recordCandidate = true;
  const recordKeys = new Set<string>();
  const competingKeys = new Set<string>();
  for (const line of markdown.slice(header[0].length).split(/\r?\n/)) {
    const entry = fieldEntry(line);
    if (entry) bodyKeys.add(entry[0]);

    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (delimiter && (fence || delimiter[1]?.startsWith("~") || !delimiter[2]?.includes("`"))) {
      fence = markdownFenceStateAfterLine(fence, line);
      recordCandidate = false;
      recordKeys.clear();
      continue;
    }
    if (fence) continue;
    if (line === "---") {
      if (recordCandidate && recordKeys.size > 0) {
        for (const key of recordKeys) competingKeys.add(key);
      }
      recordCandidate = true;
      recordKeys.clear();
    } else if (recordCandidate) {
      if (entry) recordKeys.add(entry[0]);
      else if (line.trim() && !/^(?:\s|#|-(?:\s|$)|[`~]|[\]}][\s,]*$)/.test(line)) {
        recordCandidate = false;
        recordKeys.clear();
      }
    }
  }
  return {
    fields,
    bodyKeys,
    competingKeys,
    ambiguous: [...fields].some(([key, values]) => values.length > 1 || competingKeys.has(key)),
  };
}

export function readReportFrontMatterField(markdown: string, key: string): FrontMatterField {
  const parsed = parseReportFrontMatter(markdown);
  if (!parsed) return { status: "absent" };
  const values = parsed.fields.get(key) ?? [];
  if (parsed.competingKeys.has(key) || values.length > 1) return { status: "ambiguous" };
  if (values.length === 0) {
    return { status: parsed.bodyKeys.has(key) ? "ambiguous" : "absent" };
  }
  return { status: "value", value: values[0]! };
}
