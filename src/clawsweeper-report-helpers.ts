import { SECURITY_CONCERN_SEVERITIES } from "./clawsweeper-policy.js";
import type {
  AgentsPolicyStatus,
  ReviewFinding,
  SecurityConcernSeverity,
} from "./clawsweeper-types.js";

interface CreateReportHelpersDependencies {
  OWNED_REVIEW_SECTION_HEADINGS: Set<string>;
  parseBacktickLocation: (
    value: string,
  ) => { file: string; lineStart: number; lineEnd: number } | null;
}

export function createReportHelpers(dependencies: CreateReportHelpersDependencies) {
  const { OWNED_REVIEW_SECTION_HEADINGS, parseBacktickLocation } = dependencies;

  function parseBoldListHeading(line: string): { label: string; detail: string } | null {
    const prefix = "- **";
    if (!line.startsWith(prefix)) return null;
    const delimiter = ":**";
    const delimiterIndex = line.indexOf(delimiter, prefix.length);
    if (delimiterIndex === -1) return null;
    return {
      label: line.slice(prefix.length, delimiterIndex),
      detail: line.slice(delimiterIndex + delimiter.length).trimStart(),
    };
  }

  function parseReviewFindingHeading(line: string): {
    priority: ReviewFinding["priority"];
    title: string;
    file: string;
    lineStart: number;
    lineEnd: number;
  } | null {
    const prefix = "- **[P";
    if (!line.startsWith(prefix)) return null;
    const priority = Number(line[prefix.length]);
    if (!Number.isInteger(priority) || priority < 0 || priority > 3) return null;
    const titleStart = prefix.length + 3;
    if (line.slice(prefix.length + 1, titleStart) !== "] ") return null;
    const titleEnd = line.indexOf(":**", titleStart);
    if (titleEnd === -1) return null;

    const location = parseBacktickLocation(line.slice(titleEnd + 3).trim());
    if (!location) return null;
    return {
      priority: priority as ReviewFinding["priority"],
      title: line.slice(titleStart, titleEnd),
      ...location,
    };
  }

  function parseSecurityConcernHeading(line: string): {
    severity: SecurityConcernSeverity;
    title: string;
    file: string | null;
    line: number | null;
  } | null {
    const prefix = "- **[";
    if (!line.startsWith(prefix)) return null;
    const severityEnd = line.indexOf("] ", prefix.length);
    if (severityEnd === -1) return null;
    const severity = line.slice(prefix.length, severityEnd);
    if (!SECURITY_CONCERN_SEVERITIES.has(severity as SecurityConcernSeverity)) return null;
    const titleStart = severityEnd + 2;
    const titleEnd = line.indexOf(":**", titleStart);
    if (titleEnd === -1) return null;

    const locationText = line.slice(titleEnd + 3).trim();
    const location = locationText ? parseBacktickLocation(locationText) : null;
    return {
      severity: severity as SecurityConcernSeverity,
      title: line.slice(titleStart, titleEnd),
      file: location?.file ?? null,
      line: location?.lineStart ?? null,
    };
  }

  function sectionLineValue(section: string, label: string): string | undefined {
    const prefix = `${label}:`;
    for (const line of section.split("\n")) {
      if (line.startsWith(prefix)) {
        const value = line.slice(prefix.length).trim();
        return value || undefined;
      }
    }
    return undefined;
  }

  function sectionList(section: string, label: string): string[] {
    const lines = section.split("\n");
    const start = lines.findIndex((line) => line.trim() === `${label}:`);
    if (start === -1) return [];
    const values: string[] = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/^[A-Z][A-Za-z -]+:/.test(line)) break;
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("- ")) continue;
      const item = trimmed.slice(2).trim();
      if (item) values.push(item);
    }
    return values;
  }

  function agentsPolicyStatusLine(status: AgentsPolicyStatus | undefined): string {
    switch (status?.status) {
      case "found_applied":
        return "AGENTS.md: found and applied where relevant.";
      case "found_not_applicable":
        return "AGENTS.md: found, but no applicable review policy affected this item.";
      case "not_found":
        return "AGENTS.md: not found in the target repository.";
      case "conflict_not_applied":
        return "AGENTS.md: found but not applied because it conflicted with ClawSweeper's review contract.";
      case "unreadable_or_unclear":
        return "AGENTS.md: unclear because the file could not be read completely.";
      default:
        return "";
    }
  }

  function publicTableCell(value: string): string {
    // Escape report-provided HTML (tags and comment openers) before inserting the
    // renderer-owned <br> tags; &lt; renders identically to a literal <.
    return value
      .replace(/\\/g, "\\\\")
      .replace(/<(?=[a-z/!?])/gi, "&lt;")
      .replace(/\r?\n|\r/g, "<br>")
      .replace(/\|/g, "\\|")
      .trim();
  }

  function neutralizeOwnedSectionSpoofing(value: string): string {
    // GitHub normalizes CRLF and bare CR to line endings, so normalize first or a
    // bare-CR line break could smuggle a heading past the per-line checks.
    return value
      .replace(/\r\n?|[\u2028\u2029]/g, "\n")
      .split("\n")
      .map((line) => {
        // Strip blockquote/list container prefixes so nested heading constructs are
        // neutralized too.
        // CommonMark accepts blockquotes without a following space and ordered lists
        // with either "1." or "1)".
        const containerPrefix =
          line.match(/^[ \t]*(?:(?:>|(?:[-*+]|\d+[.)])[ \t])[ \t]*)*/)?.[0] ?? "";
        // Escape every raw HTML delimiter (renderer-emitted <br> excepted) so inline
        // tags and comment openers cannot restructure or hide trusted sections;
        // &lt; renders identically to a literal <.
        const content = line.slice(containerPrefix.length).replace(/<(?!br\s*\/?>)/gi, "&lt;");
        const trimmed = content.trim();
        if (/^#{1,6}\s+\S/.test(trimmed)) {
          return `${containerPrefix}${content.replace("#", "\\#")}`;
        }
        if (/^\*\*[^*\n]+\*\*:?\s*$/.test(trimmed)) {
          return `${containerPrefix}${content.replace("**", "\\*\\*")}`;
        }
        // "- **[P0] title:** `file:1`" and "- **[high] title:**" are the review-finding
        // and security-concern heading grammar the report re-parser trusts; escaping the
        // bold opener keeps heading-shaped prose from becoming a finding on re-parse.
        if (/^\*\*\[[^\]\n]+\] [^\n]*:\*\*/.test(trimmed)) {
          return `${containerPrefix}${content.replace("**", "\\*\\*")}`;
        }
        // "- body:", "- late:", and "- confidence:" list items are finding continuation
        // lines where the last occurrence wins on re-parse; &#58; renders as a colon.
        if (/-[ \t]+$/.test(containerPrefix) && /^(?:body|late|confidence):/.test(trimmed)) {
          return `${containerPrefix}${content.replace(":", "&#58;")}`;
        }
        if (/^(?:```|~~~)/.test(trimmed)) {
          return `${containerPrefix}${content.replace(/[`~]/, "\\$&")}`;
        }
        // A run of = or - alone on a line is a Setext underline that would promote the
        // previous line to a heading.
        if (/^(?:=+|-+)[ \t]*$/.test(trimmed)) {
          return `${containerPrefix}${content.replace(/[=-]/, "\\$&")}`;
        }
        if (
          trimmed.endsWith(":") &&
          OWNED_REVIEW_SECTION_HEADINGS.has(trimmed.slice(0, -1).trim().toLowerCase())
        ) {
          return `${containerPrefix}${content.trimEnd().slice(0, -1)}&#58;`;
        }
        return `${containerPrefix}${content}`;
      })
      .join("\n");
  }

  function sanitizeArchitectureDiagram(value: string): string {
    const diagram = value.trim();
    if (!diagram || diagram.length > 4000) return "";
    if (!/^flowchart\b/i.test(diagram)) return "";
    // No fence-breaking backticks, node metadata (image/icon nodes), HTML tags, init
    // directives, or URLs of any form, including scheme-relative and data: URLs.
    if (diagram.includes("`") || diagram.includes("~~~") || diagram.includes("@{")) return "";
    if (/<[a-z!/]/i.test(diagram)) return "";
    // Heading-shaped lines could terminate the report section the diagram is
    // serialized into; Mermaid flowcharts never need a leading #.
    if (/^[ \t]*#/m.test(diagram)) return "";
    if (/%%\{/.test(diagram)) return "";
    if (diagram.includes("//")) return "";
    // Require a non-space after the colon so human-readable labels such as
    // "Data: PR input" are not mistaken for data:/file: URLs.
    if (/\b(?:data|javascript|vbscript|https?|ftp|file|blob|mailto):\S/i.test(diagram)) return "";
    // The declaration line must be exactly "flowchart <direction>" so no further
    // statement can hide after it on the same line.
    const declarationLine = diagram.split(/\r?\n/, 1)[0] ?? "";
    if (!/^flowchart[ \t]+(?:LR|RL|TB|BT|TD)[ \t]*;?[ \t]*$/i.test(declarationLine)) return "";
    // Interaction and styling directives start a statement (newline- or
    // semicolon-separated); the same words are fine inside human-readable node labels.
    for (const statement of diagram.split(/[;\r\n]+/)) {
      if (/^\s*(?:click|style|classDef|class|linkStyle)\b/i.test(statement)) return "";
    }
    // Directive shapes are also rejected mid-line, where Mermaid can begin a new
    // statement without a separator.
    if (/\bclick[ \t]+[\w-]+[ \t]+(?:href|call)\b/i.test(diagram)) return "";
    if (/\b(?:style|linkStyle)[ \t]+[\w-]+[ \t]+[\w-]+[ \t]*:/i.test(diagram)) return "";
    if (/\bclassDef[ \t]+[\w-]+[ \t]+[\w-]+[ \t]*:/i.test(diagram)) return "";
    return diagram;
  }

  return {
    agentsPolicyStatusLine,
    neutralizeOwnedSectionSpoofing,
    parseBoldListHeading,
    parseReviewFindingHeading,
    parseSecurityConcernHeading,
    publicTableCell,
    sanitizeArchitectureDiagram,
    sectionLineValue,
    sectionList,
  };
}
