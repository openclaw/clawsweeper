import { escapeRegExp, markdownFenceStateAfterLine } from "./clawsweeper-markdown.ts";

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

// Decoded field: trimmed, with one pair of enclosing double quotes removed. An empty
// value, quoted or not, is ambiguous.
export function frontMatterField(markdown: string, key: string): FrontMatterField {
  const field = readReportFrontMatterField(markdown, key);
  if (field.status !== "value") return field;
  const raw = field.value.trim();
  const value = raw.length > 1 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return value ? { status: "value", value } : { status: "ambiguous" };
}

export function frontMatterValue(markdown: string, key: string): string | undefined {
  const field = frontMatterField(markdown, key);
  return field.status === "value" ? field.value : undefined;
}

// A list value is a JSON array of strings. Older reports use a comma-separated list.
export function parseFrontMatterStringArray(value: string | undefined): string[] {
  if (!value || value === "none") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // Not JSON: read the comma-separated form.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function frontMatterStringArray(markdown: string, key: string): string[] {
  return parseFrontMatterStringArray(frontMatterValue(markdown, key));
}

export function frontMatterJsonArray(markdown: string, key: string): unknown[] {
  const value = frontMatterValue(markdown, key);
  if (!value || value === "none") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function frontMatterBoolean(markdown: string, key: string): boolean {
  return /^true$/i.test(frontMatterValue(markdown, key) ?? "");
}

// `value` is record data, for example `JSON.stringify(item.labels)` with GitHub label
// names. A replacement string would expand `$&`, `` $` `` and `$'` against the match, so
// a replacement function inserts the text literally. A new key uses the line ending of
// the opening delimiter.
export function replaceFrontMatterValue(markdown: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*.*$`, "m");
  if (pattern.test(markdown)) return markdown.replace(pattern, () => line);
  return markdown.replace(/^---(\r?\n)/, (opening, ending: string) => `${opening}${line}${ending}`);
}

function sectionPattern(heading: string): RegExp {
  return new RegExp(`((?:^|\\n)## ${escapeRegExp(heading)}\\n\\n)([\\s\\S]*?)(?=\\n## |\\n?$)`);
}

export function sectionValue(markdown: string, heading: string): string {
  return markdown.match(sectionPattern(heading))?.[2]?.trim() ?? "";
}

// `value` is often model text. A replacement function keeps `$1` and `$&` literal.
export function replaceSectionValue(markdown: string, heading: string, value: string): string {
  const pattern = sectionPattern(heading);
  if (pattern.test(markdown)) {
    return markdown.replace(pattern, (_match, prefix: string) => `${prefix}${value.trim()}\n`);
  }
  return `${markdown.trimEnd()}\n\n## ${heading}\n\n${value.trim()}\n`;
}

export function appendSectionValue(markdown: string, heading: string, value: string): string {
  const existing = sectionValue(markdown, heading);
  const nextValue = existing ? `${existing.trimEnd()}\n\n${value.trim()}` : value.trim();
  return replaceSectionValue(markdown, heading, nextValue);
}
