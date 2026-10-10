import type { JsonValue, LooseRecord } from "./json-types.js";

export type SecuritySignalInput = {
  labels?: LooseRecord[];
  comments?: LooseRecord[];
  frontmatter?: LooseRecord;
};

const SECURITY_LABELS = new Set([
  "security",
  "security-sensitive",
  "security sensitive",
  "type: security",
  "type:security",
  "kind: security",
  "kind:security",
]);

const SECURITY_MARKERS = [
  "clawsweeper-security:security",
  "clawsweeper-security:security-sensitive",
  "clawsweeper-security:sensitive",
  "clawsweeper-route:security",
  "clawsweeper-route:route-security",
  "clawsweeper-route:central-security",
  "clawsweeper-verdict:security",
  "clawsweeper-verdict:security-sensitive",
];

export function hasDeterministicSecuritySignal({ labels = [], comments = [] }: LooseRecord = {}) {
  return hasSecuritySignal({ labels, comments });
}

export function hasSecuritySignal({
  labels = [],
  comments = [],
  frontmatter = {},
}: SecuritySignalInput = {}) {
  return (
    hasSecurityFrontmatter(frontmatter) ||
    hasSecurityLabel(labels) ||
    comments.some(hasStructuredSecurityText)
  );
}

function hasSecurityFrontmatter(frontmatter: LooseRecord) {
  return (
    frontmatter.security_sensitive === true ||
    String(frontmatter.route ?? "").toLowerCase() === "security" ||
    String(frontmatter.verdict ?? "").toLowerCase() === "security"
  );
}

function hasSecurityLabel(labels: LooseRecord[]) {
  return labels.flatMap(labelTexts).some(isSecurityLabel);
}

function labelTexts(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.flatMap(labelTexts);
  if (value && typeof value === "object") {
    const record = value as Record<string, JsonValue>;
    return [record.name, record.label, record.value].flatMap(labelTexts);
  }
  return [String(value ?? "")];
}

export function isSecurityLabel(value: string): boolean {
  return SECURITY_LABELS.has(normalizeToken(value));
}

function hasStructuredSecurityText(value: JsonValue): boolean {
  return flattenSecurityText(value).some((entry) =>
    entry
      .split("<!--")
      .slice(1)
      .some((comment) => {
        const end = comment.indexOf("-->");
        if (end === -1) return false;
        const marker = normalizeToken(comment.slice(0, end)).split(" ")[0] ?? "";
        return SECURITY_MARKERS.includes(marker);
      }),
  );
}

function normalizeToken(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function flattenSecurityText(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenSecurityText);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(flattenSecurityText);
  }
  return [String(value ?? "")];
}
