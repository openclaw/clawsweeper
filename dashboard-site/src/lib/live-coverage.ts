// One cohort for every Coverage component. Corpus/history never fills live gaps.
type Json = Record<string, any>;
const names = [
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
];
const censusFields = new Set(["reviewable_records", "excluded"]);
export function liveCoverage(source: Json, now = Date.now()) {
  const census = Date.parse(source.inventory_generated_at ?? "");
  const recordScanAt =
    source.record_scan_observed_at === undefined
      ? source.generated_at
      : source.record_scan_observed_at;
  const scan = Date.parse(recordScanAt ?? "");
  const contract =
    source.cohort === "live-open-identities-v1" && source.scope === "verified-public-inventory";
  const censusCurrent =
    contract && Number.isFinite(census) && census <= now && now - census <= 12 * 3600000;
  const countsDate = Date.parse(source.counts_observed_at ?? "");
  const countKnown =
    contract &&
    source.count_status === "observed" &&
    Number.isFinite(countsDate) &&
    countsDate <= now &&
    now - countsDate <= 12 * 3600000;
  const censusKnown = censusCurrent && countKnown && source.census_status === "complete";
  const current = censusCurrent && Number.isFinite(scan) && scan <= now && now - scan <= 15 * 60000;
  const known = current && censusKnown && source.coverage_status === "complete";
  const unavailableReason = !contract
    ? "Legacy or missing producer: identity-matched live census unavailable"
    : !censusCurrent
      ? "Identity census observation is missing, stale or future"
      : !current
        ? "Canonical scan unavailable or stale; trusted count observations remain visible"
        : "Review evidence incomplete";
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const totals = Object.fromEntries(
    names.map((key) => [
      key,
      (key === "open_records" ? countKnown : censusFields.has(key) ? censusKnown : known)
        ? number(source.totals?.[key])
        : null,
    ]),
  );
  const rows = (Array.isArray(source.fleets) ? source.fleets : []).map((row: Json) => {
    const rowCountsAt = Date.parse(row.counts_observed_at ?? "");
    const rowCountKnown =
      contract &&
      row.count_status === "observed" &&
      Number.isFinite(rowCountsAt) &&
      rowCountsAt <= now &&
      now - rowCountsAt <= 12 * 3600000;
    const rowCensusKnown =
      censusCurrent &&
      rowCountKnown &&
      (row.observation_scope ?? "eligible") === "eligible" &&
      row.census_status === "complete";
    const complete = current && rowCensusKnown && row.coverage_status === "complete";
    return {
      repo: String(row.repo),
      slug: String(row.repo_slug),
      observationScope: row.observation_scope ?? "eligible",
      collectionWindow: row.collection_window ?? null,
      censusComplete:
        censusCurrent &&
        rowCountKnown &&
        ["eligible", "observed"].includes(row.observation_scope ?? "eligible") &&
        row.census_status === "complete",
      known: complete,
      censusKnown: rowCensusKnown,
      countKnown: rowCountKnown,
      countsAt: row.counts_observed_at ?? null,
      countQualification: row.counts_qualification ?? null,
      missingFields: row.missing_fields ?? [],
      reason: row.reason ?? (!current ? unavailableReason : "Incomplete census"),
      ...Object.fromEntries(
        names.map((key) => [
          key,
          (
            key === "open_records"
              ? rowCountKnown
              : censusFields.has(key)
                ? rowCensusKnown
                : complete
          )
            ? number(row[key])
            : null,
        ]),
      ),
      percent: complete ? number(row.coverage_percent) : null,
      needsRefresh: complete && Array.isArray(row.needs_refresh) ? row.needs_refresh : [],
    };
  });
  const refresh = rows
    .flatMap((row: Json) => row.needsRefresh.map((item: Json) => ({ ...item, repo: row.repo })))
    .sort(
      (a: Json, b: Json) =>
        (Date.parse(a.reviewed_at ?? "") || 0) - (Date.parse(b.reviewed_at ?? "") || 0),
    )
    .slice(0, 16);
  return {
    known,
    censusKnown,
    countKnown,
    countsAt: source.counts_observed_at ?? null,
    countsThrough: source.counts_observed_through ?? null,
    rows,
    populationKnown: censusCurrent,
    refresh,
    ...totals,
    percent: known ? number(source.totals?.coverage_percent) : null,
    reason: known
      ? null
      : !current
        ? unavailableReason
        : censusKnown
          ? "Live census is complete; canonical review evidence unavailable"
          : "Incomplete live-open identity census",
    censusAt: source.inventory_generated_at ?? null,
    scanAt: recordScanAt ?? null,
    windowDays: number(source.window_days) ?? 7,
  };
}
