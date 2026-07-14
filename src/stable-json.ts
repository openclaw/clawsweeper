export function stableJson(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

export function sortStable(value: unknown): unknown {
  return sortStableWith(value, (left, right) => left.localeCompare(right));
}

export function stableJsonCodeUnit(value: unknown): string {
  return JSON.stringify(sortStableCodeUnit(value));
}

export function sortStableCodeUnit(value: unknown): unknown {
  return sortStableWith(value, compareCodeUnits);
}

function sortStableWith(
  value: unknown,
  compareKeys: (left: string, right: string) => number,
): unknown {
  if (Array.isArray(value)) return value.map((item) => sortStableWith(item, compareKeys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, item]) => [key, sortStableWith(item, compareKeys)]),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
