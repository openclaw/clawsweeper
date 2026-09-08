/** Closed, observer-only facts. A request never implies execution or sufficient proof. */
export type InlineProofParticipation = "requested" | "not_requested" | "unknown";
export function inlineProofParticipation(value: unknown): InlineProofParticipation {
  return value === "requested" || value === "not_requested" ? value : "unknown";
}
export type InlineProofTimingSet = {
  overall: { samples: number; average_ms: number | null; median_ms: number | null };
  history: {
    bucket_minutes: number;
    points: Array<{ ended_at: string; samples: number; average_ms: number; median_ms: number }>;
  };
};
export type InlineProofCohorts = Record<InlineProofParticipation, InlineProofTimingSet>;

/** Rebuild an allowlisted value: never spread untrusted proof metadata into Bay. */
export function publicInlineProofCohorts(
  value: unknown,
  total: number | null,
): InlineProofCohorts | null {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(total) || total! < 0)
    return null;
  const result = {} as InlineProofCohorts;
  let samples = 0;
  const count = (v: unknown, max: number): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
  for (const key of ["requested", "not_requested", "unknown"] as const) {
    const set = (value as Record<string, InlineProofTimingSet>)[key];
    if (!set || !set.overall || !set.history) return null;
    const { samples: n, average_ms: mean, median_ms: median } = set.overall;
    if (
      !count(n, 100_000) ||
      (n === 0
        ? mean !== null || median !== null
        : !count(mean, 86_400_000) || !count(median, 86_400_000))
    )
      return null;
    if (
      set.history.bucket_minutes !== 5 ||
      !Array.isArray(set.history.points) ||
      set.history.points.length > 13
    )
      return null;
    const points: InlineProofTimingSet["history"]["points"] = [];
    let pointSamples = 0;
    let previous = -Infinity;
    for (const point of set.history.points) {
      if (!point || typeof point.ended_at !== "string") return null;
      const at = Date.parse(point.ended_at);
      if (
        !Number.isFinite(at) ||
        at <= previous ||
        !count(point.samples, 100_000) ||
        point.samples === 0 ||
        !count(point.average_ms, 86_400_000) ||
        !count(point.median_ms, 86_400_000)
      )
        return null;
      previous = at;
      pointSamples += point.samples;
      points.push({
        ended_at: new Date(at).toISOString(),
        samples: point.samples,
        average_ms: point.average_ms,
        median_ms: point.median_ms,
      });
    }
    if (pointSamples > n) return null;
    samples += n;
    result[key] = {
      overall: { samples: n, average_ms: mean, median_ms: median },
      history: { bucket_minutes: 5, points },
    };
  }
  return samples === total ? result : null;
}
