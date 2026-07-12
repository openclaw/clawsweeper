export function stableJson(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

export function compareStableText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([key, item]) => [key, sortStable(item)]),
  );
}
