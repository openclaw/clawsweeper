// Public Actions summaries consume ONLY the anonymous aggregate endpoint. Never
// use private build/control payloads or persisted repo identity as disclosure authority.
export const COVERAGE_SUMMARY_READ = { bytes: 64 * 1024, timeoutMs: 5_000 } as const;
const counts = [
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
type CountName = (typeof counts)[number];
type Aggregate = {
  windowDays: number;
  generatedAt: string;
  recordAt: string | null;
  countsAt: string | null;
  countsThrough: string | null;
  inventoryAt: string | null;
  factsCurrent: boolean;
  countsObserved: boolean;
  censusComplete: boolean;
  coverageComplete: boolean;
  totals: Record<CountName, number | null> & { coverage_percent: number | null };
};
export type CoverageSummaryRead =
  | { available: true; aggregate: Aggregate }
  | { available: false; reason: "unavailable" | "invalid" | "too_large" | "timeout" };
const record = (x: unknown): Record<string, unknown> | null =>
  typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
function iso(x: unknown) {
  if (x === null) return null;
  if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(x))
    throw new Error("invalid aggregate date");
  const n = Date.parse(x);
  if (!Number.isFinite(n)) throw new Error("invalid aggregate date");
  const normalized = new Date(n).toISOString();
  if (normalized.slice(0, 19) !== x.slice(0, 19)) throw new Error("invalid aggregate date");
  return normalized;
}
function parse(value: unknown): Aggregate {
  const p = record(value),
    t = record(p?.totals);
  if (
    !p ||
    !t ||
    p.ok !== true ||
    p.cohort !== "live-open-identities-v1" ||
    p.scope !== "aggregate-only" ||
    p.count_scope !== "fleet-inventory-aggregate" ||
    p.fleets !== undefined ||
    !Number.isSafeInteger(p.window_days) ||
    Number(p.window_days) <= 0
  )
    throw new Error("invalid aggregate scope");
  const totals = {} as Aggregate["totals"];
  for (const k of counts) {
    const v = t[k];
    if (v !== null && !(typeof v === "number" && Number.isSafeInteger(v) && v >= 0))
      throw new Error("invalid aggregate count");
    totals[k] = v as number | null;
  }
  const percent = t.coverage_percent;
  if (
    percent !== null &&
    !(typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100)
  )
    throw new Error("invalid aggregate percent");
  totals.coverage_percent = percent as number | null;
  if (
    totals.reviewable_records !== null &&
    totals.reviewed_recent !== null &&
    totals.reviewed_recent > totals.reviewable_records
  )
    throw new Error("invalid aggregate partition");
  const generatedAt = iso(p.generated_at);
  if (!generatedAt) throw new Error("missing aggregate date");
  return {
    windowDays: Number(p.window_days),
    generatedAt,
    recordAt: iso(p.record_scan_observed_at),
    countsAt: iso(p.counts_observed_at),
    countsThrough: iso(p.counts_observed_through),
    inventoryAt: iso(p.inventory_generated_at),
    factsCurrent: p.scan_status === "current",
    countsObserved: p.count_status === "observed",
    censusComplete: p.census_status === "complete",
    coverageComplete: p.coverage_status === "complete",
    totals,
  };
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("aggregate timeout");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("aggregate timeout"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}
export async function readPublicCoverageSummary(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CoverageSummaryRead> {
  let reason: "unavailable" | "invalid" | "too_large" = "unavailable",
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    done = false;
  const signal = AbortSignal.timeout(COVERAGE_SUMMARY_READ.timeoutMs);
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "https:" || base.username || base.password)
      throw new Error("invalid report origin");
    const url = new URL("/api/review-coverage", base);
    const response = await bounded(
      fetchImpl(url.href, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal,
      }),
      signal,
    );
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return { available: false, reason };
    }
    reason = "invalid";
    reader = response.body?.getReader();
    if (!reader) throw new Error("missing aggregate body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await bounded(reader.read(), signal);
      if (part.done) {
        done = true;
        break;
      }
      size += part.value.byteLength;
      if (size > COVERAGE_SUMMARY_READ.bytes) {
        reason = "too_large";
        throw new Error("aggregate too large");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const b of chunks) {
      bytes.set(b, offset);
      offset += b.byteLength;
    }
    const aggregate = parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return { available: true, aggregate };
  } catch {
    return { available: false, reason: signal.aborted ? "timeout" : reason };
  } finally {
    if (reader) {
      if (!done) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
export function renderPublicCoverageSummary(
  read: CoverageSummaryRead,
  windowDays: number,
  now = Date.now(),
): string {
  const a = read.available ? read.aggregate : null,
    windowMatches = a?.windowDays === windowDays,
    facts = !!a && a.factsCurrent && windowMatches && a.censusComplete && a.countsObserved,
    known = (n: number | null | undefined) =>
      n === null || n === undefined ? "Unknown" : String(n),
    review = (k: CountName) => (facts ? known(a!.totals[k]) : "Unknown"),
    open = a?.countsObserved ? known(a.totals.open_records) : "Unknown",
    percent =
      facts &&
      a?.censusComplete &&
      a.coverageComplete &&
      a.countsObserved &&
      a.totals.coverage_percent !== null &&
      a.totals.reviewable_records !== null &&
      a.totals.reviewable_records > 0 &&
      a.totals.reviewed_recent !== null
        ? a.totals.coverage_percent.toFixed(1) + "%"
        : "Unknown";
  const unavailable = read.available
    ? !windowMatches
      ? "Requested review window unavailable: the aggregate source exposes " +
        a!.windowDays +
        " days, not " +
        windowDays +
        ". Review-window metrics are Unknown."
      : !a!.factsCurrent
        ? "Canonical review facts are unavailable; current count observations do not establish review coverage."
        : !a!.countsObserved
          ? "Current count observations are unavailable or stale; fleet coverage remains Unknown."
          : !a!.censusComplete
            ? "The census is incomplete or stale; fleet coverage remains Unknown."
            : !a!.coverageComplete
              ? "The aggregate source cannot establish a current fleet percentage."
              : null
    : (
        {
          unavailable: "The public aggregate read is unavailable.",
          invalid: "The public aggregate response was rejected.",
          too_large: "The public aggregate response exceeded its byte bound.",
          timeout: "The public aggregate read timed out.",
        } as const
      )[read.reason];
  return (
    (windowDays === 7
      ? "## Weekly review coverage"
      : "## Review coverage — trailing " + windowDays + " days") +
    "\n\nReport generated " +
    new Date(now).toISOString() +
    ". Aggregate-only current live-open observations; not a historical-record denominator.\n\n" +
    (unavailable ? unavailable + "\n\n" : "") +
    "| Metric | Value |\n| --- | ---: |\n" +
    "| Requested review window | " +
    windowDays +
    " days |\n| Source review window | " +
    (a ? a.windowDays + " days" : "Unknown") +
    " |\n| Current observed open items | " +
    open +
    " |\n| Qualified live-open identities | " +
    (a?.censusComplete && a.countsObserved ? known(a.totals.reviewable_records) : "Unknown") +
    " |\n| Fresh in trailing " +
    windowDays +
    " days | " +
    review("reviewed_recent") +
    " |\n| Stale reviews | " +
    review("stale") +
    " |\n| Failed or incomplete reviews | " +
    review("failed") +
    " |\n| Expired reviews | " +
    review("expired") +
    " |\n| Pending or unreviewed | " +
    review("pending") +
    " |\n| Excluded live-open identities | " +
    review("excluded") +
    " |\n| Trailing coverage | " +
    percent +
    " |\n| Census status | " +
    (a?.censusComplete ? "Complete" : "Unknown") +
    " |\n| Census Complete/Total | Unknown (not exposed by aggregate endpoint) |\n| Canonical review facts | " +
    (a?.factsCurrent ? "Available" : "Unknown") +
    " |\n\n" +
    "Counts observed as of: " +
    (a?.countsAt ?? "Unknown") +
    " through " +
    (a?.countsThrough ?? "Unknown") +
    ". Census observations: " +
    (a?.inventoryAt ?? "Unknown") +
    ". Canonical facts observed as of: " +
    (a?.recordAt ?? "Unknown") +
    ". Source generated: " +
    (a?.generatedAt ?? "Unknown") +
    ".\n\nPer-repository identities/cardinalities and collection-window details are intentionally not copied into the public job summary. See the observer-only [Coverage page](https://clawsweeper.openclaw.ai/coverage/), whose build owns current public-visibility verification.\n"
  );
}
