/**
 * Canonical JSON for content digests and equality checks.
 *
 * Keys are ordered by UTF-16 code unit, never by locale collation.
 * `String.prototype.localeCompare` is unusable here for two reasons:
 *
 *   1. It is not a strict total order. Collation-ignorable characters (zero-width
 *      joiner, soft hyphen, most control characters) make distinct keys compare
 *      equal, and `Array.prototype.sort` is stable, so a tie leaves the keys in
 *      property-insertion order. Two objects with the same key/value set then
 *      serialize differently and hash differently.
 *   2. It is locale and ICU dependent. With no locale argument it follows the
 *      runtime default, and collation tables differ between locales and ICU
 *      releases - `cs-CZ`, for example, orders `ch` after `h`, which reorders
 *      keys such as `changedFiles` and `checksDigest`. A digest computed on one
 *      runner would then not match the same input on another.
 *
 * `stableJsonCodeUnit` / `sortStableCodeUnit` are retained as explicit aliases;
 * they are equivalent to the unsuffixed pair.
 */

export function stableJson(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

export function sortStable(value: unknown): unknown {
  return sortStableWith(value, compareCodeUnits);
}

export function stableJsonCodeUnit(value: unknown): string {
  return stableJson(value);
}

export function sortStableCodeUnit(value: unknown): unknown {
  return sortStable(value);
}

/** Total order over UTF-16 code units; never returns 0 for distinct strings. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
