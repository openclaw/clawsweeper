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
