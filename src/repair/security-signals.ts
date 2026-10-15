const SECURITY_LABELS = new Set([
  "security",
  "security-sensitive",
  "security sensitive",
  "type: security",
  "type:security",
  "kind: security",
  "kind:security",
]);

export function isSecurityLabel(value: string): boolean {
  return SECURITY_LABELS.has(normalizeToken(value));
}

function normalizeToken(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
