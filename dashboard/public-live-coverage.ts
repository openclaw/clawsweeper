import { publicTimestamp } from "./public-timestamp.ts";
// Closed, observer-only public contract. Repository names are admitted only by
// authenticated inventory metadata, never by a stored record's self-assertion.
const fields = [
  "open_records",
  "reviewable_records",
  "reviewed_recent",
  "stale",
  "failed",
  "expired",
  "unreviewed_records",
  "untracked_open",
  "pending",
  "excluded",
  "record_drift",
] as const;
const censusFields = new Set(["reviewable_records", "excluded"]);
const categories = [
  "reviewed_recent",
  "stale",
  "failed",
  "expired",
  "unreviewed_records",
  "untracked_open",
] as const;
const reasons = new Set([
  "not_in_current_census",
  "census_not_current",
  "incomplete_census",
  "incomplete_or_bounded_census",
  "bounded_census",
  "count_drift",
  "invalid_pagination",
  "incomplete_identity",
  "census_read_failed",
  "missing_counts",
  "canonical_evidence_unavailable",
  "outside_qualified_review_scope",
  "captured_identity_fields_missing",
  "canonical_scan_unavailable",
]);
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000_000;
export function publicLiveCoverage(
  source: Record<string, unknown>,
  generatedAt: string,
  censusAt: string | null,
  windowDays: number,
) {
  if (!Array.isArray(source.fleets) || source.fleets.length > 2000) return null;
  const seen = new Set<string>();
  const fleets = [];
  for (const value of source.fleets) {
    const row = object(value);
    if (!row || row.visibility !== "public") continue;
    if (
      typeof row.repo !== "string" ||
      !/^[a-z0-9_.-]+[/][a-z0-9_.-]+$/.test(row.repo) ||
      row.repo_slug !== row.repo.replace("/", "-") ||
      seen.has(row.repo)
    )
      return null;
    seen.add(row.repo);
    const scope = row.observation_scope ?? "eligible";
    if (
      !["eligible", "observed", "archived", "fork", "alias", "historical"].includes(String(scope))
    )
      return null;
    const countsAt =
      row.counts_observed_at === null ? null : publicTimestamp(row.counts_observed_at);
    const countKnown = row.count_status === "observed" && countsAt !== null;
    const censusKnown =
      scope === "eligible" &&
      countKnown &&
      row.census_status === "complete" &&
      source.inventory_status === "current";
    const known =
      censusKnown &&
      row.coverage_status === "complete" &&
      source.inventory_status === "current" &&
      source.scan_status === "current";
    if (
      censusKnown &&
      Number(row.open_records) !== Number(row.reviewable_records) + Number(row.excluded)
    )
      return null;
    const counts: Record<string, number | null> = {};
    for (const field of fields) {
      const fieldKnown =
        field === "open_records" ? countKnown : censusFields.has(field) ? censusKnown : known;
      if (!count(row[field]) && (fieldKnown || row[field] !== null)) return null;
      counts[field] = fieldKnown ? (row[field] as number) : null;
    }
    if (
      known &&
      (Number(row.open_records) !== Number(row.reviewable_records) + Number(row.excluded) ||
        Number(row.reviewable_records) !==
          categories.reduce((sum, key) => sum + Number(row[key]), 0) ||
        Number(row.pending) !==
          Number(row.expired) + Number(row.unreviewed_records) + Number(row.untracked_open))
    )
      return null;
    const refresh = [];
    if (known && Array.isArray(row.needs_refresh))
      for (const raw of row.needs_refresh.slice(0, 16)) {
        const item = object(raw);
        if (
          !item ||
          !count(item.number) ||
          item.number < 1 ||
          !["issue", "pull_request"].includes(String(item.kind)) ||
          !categories.slice(1).includes(item.category as (typeof categories)[1])
        )
          return null;
        const reviewedAt =
          item.reviewed_at === null
            ? null
            : typeof item.reviewed_at === "string" && Number.isFinite(Date.parse(item.reviewed_at))
              ? new Date(item.reviewed_at).toISOString()
              : undefined;
        if (reviewedAt === undefined) return null;
        refresh.push({
          number: item.number,
          kind: item.kind as string,
          category: item.category as string,
          reviewed_at: reviewedAt,
        });
      }
    fleets.push({
      repo: row.repo,
      visibility: "public",
      observation_scope: String(scope),
      count_status: countKnown
        ? "observed"
        : ["missing", "stale", "future"].includes(String(row.count_status))
          ? String(row.count_status)
          : "missing",
      counts_observed_at: countsAt,
      counts_qualification:
        row.counts_qualification === "identity_scan_drifted" ? "identity_scan_drifted" : null,
      missing_fields: Array.isArray(row.missing_fields)
        ? row.missing_fields
            .filter((field) =>
              ["labels", "latest_reopen", "pr_head", "updated_at"].includes(String(field)),
            )
            .slice(0, 4)
        : [],
      repo_slug: row.repo_slug as string,
      coverage_status: known ? "complete" : "unknown",
      census_status: censusKnown ? "complete" : "unknown",
      reason: known
        ? null
        : reasons.has(String(row.reason))
          ? String(row.reason)
          : "incomplete_census",
      ...counts,
      coverage_percent:
        known && Number(row.reviewable_records) > 0
          ? Math.round((Number(row.reviewed_recent) / Number(row.reviewable_records)) * 1000) / 10
          : null,
      needs_refresh: refresh,
    });
  }
  const metricFleets = fleets.filter((row) =>
    ["eligible", "observed"].includes(row.observation_scope),
  );
  const complete =
    censusAt !== null &&
    source.inventory_status === "current" &&
    metricFleets.length > 0 &&
    metricFleets.every((row) => row.coverage_status === "complete");
  const censusComplete =
    censusAt !== null &&
    source.inventory_status === "current" &&
    metricFleets.length > 0 &&
    metricFleets.every((row) => row.census_status === "complete");
  const countsComplete =
    metricFleets.length > 0 && metricFleets.every((row) => row.count_status === "observed");
  const observedTimes = metricFleets
    .filter((row) => row.count_status === "observed")
    .map((row) => row.counts_observed_at!)
    .sort();
  const totals: Record<string, number | null> = {};
  for (const field of fields)
    totals[field] = (
      field === "open_records"
        ? countsComplete
        : censusFields.has(field)
          ? censusComplete
          : complete
    )
      ? metricFleets.reduce((sum, row) => sum + Number((row as Record<string, unknown>)[field]), 0)
      : null;
  return {
    ok: true,
    cohort: "live-open-identities-v1",
    scan_status: source.scan_status === "current" ? "current" : "unknown",
    scope: "verified-public-inventory",
    count_scope: "eligible-and-unqualified-public-observations",
    totals_exclude_scopes: ["archived", "fork", "alias", "historical"],
    record_scan_observed_at:
      source.record_scan_observed_at === null
        ? null
        : publicTimestamp(source.record_scan_observed_at ?? generatedAt),
    generated_at: generatedAt,
    inventory_generated_at: censusAt,
    inventory_status: source.inventory_status,
    count_status: countsComplete ? "observed" : "unknown",
    counts_observed_at: countsComplete ? (observedTimes[0] ?? null) : null,
    counts_observed_through: countsComplete ? (observedTimes.at(-1) ?? null) : null,
    coverage_status: complete ? "complete" : "unknown",
    census_status: censusComplete ? "complete" : "unknown",
    window_days: windowDays,
    fleets,
    totals: {
      ...totals,
      coverage_percent:
        complete && Number(totals.reviewable_records) > 0
          ? Math.round(
              (Number(totals.reviewed_recent) / Number(totals.reviewable_records)) * 1000,
            ) / 10
          : null,
    },
  };
}
