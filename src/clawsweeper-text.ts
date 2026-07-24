export const OWNED_REVIEW_SECTION_HEADINGS = new Set([
  "summary",
  "what this changes",
  "merge readiness",
  "review scores",
  "verification",
  "how this fits together",
  "decision needed",
  "before merge",
  "next step",
  "next step before merge",
  "automerge follow-up",
  "autofix follow-up",
  "findings",
  "review findings",
  "security",
  "label changes",
]);

// Model-generated text is rendered above renderer-owned sections such as
// "## Before merge", and downstream routing extracts those sections from the first
// matching Markdown heading. Escape heading-shaped lines in model text so injected
// content can never spoof a renderer-owned section boundary.
export function neutralizeOwnedSectionSpoofing(value: string): string {
  // GitHub normalizes CRLF and bare CR to line endings, so normalize first or a
  // bare-CR line break could smuggle a heading past the per-line checks.
  return value
    .replace(/\r\n?/g, "\n")
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

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function truncateText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} chars]`;
}

export function trimMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const edge = Math.floor((maxLength - 120) / 2);
  if (edge <= 0) return text.slice(0, Math.max(0, maxLength));
  return `${text.slice(0, edge)}\n\n... truncated ${text.length - edge * 2} chars ...\n\n${text.slice(-edge)}`;
}

export function safeOutputTail(
  value: string | Buffer | null | undefined,
  maxLength = 6000,
): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : value.toString("utf8");
  return text.slice(-maxLength);
}
