import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { inflateSync } from "node:zlib";
import { asJsonObject, isJsonObject, type JsonObject } from "./json-types.js";

// Wire contracts owned by openclaw/maintainers: report-accepted-export.mjs,
// report-json.mjs and report-public-acceptance.mjs. No static-report fallback.
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const hash = /^[a-f0-9]{64}$/;
const decodedLimit = 64 * 1024 * 1024;

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("Published maintainer report verification failed");
}

function receipt(value: unknown): JsonObject {
  requireValue(isJsonObject(value));
  requireValue(
    value.schema === "report-accepted-export/v1" &&
      value.publicProjection === "report-public/v1" &&
      value.policyRevision === "report-publication/v1" &&
      typeof value.version === "string" &&
      value.version,
  );
  for (const field of [
    "acceptance",
    "bindingSha256",
    "identitySha256",
    "scopeSha256",
    "coverageSha256",
    "gapsSha256",
  ]) {
    requireValue(typeof value[field] === "string" && hash.test(value[field]));
  }
  requireValue(
    isJsonObject(value.artifacts) &&
      ["html", "markdown", "report"].every(
        (key) => typeof value.artifacts[key] === "string" && hash.test(value.artifacts[key]),
      ),
  );
  requireValue(
    isJsonObject(value.period) &&
      ["day", "week", "month"].includes(value.period.period) &&
      typeof value.period.key === "string" &&
      typeof value.cutoff === "string" &&
      Number.isFinite(Date.parse(value.cutoff)),
  );
  if (value.period.period === "day") {
    const start = Date.parse(value.period.since);
    requireValue(
      /^\d{4}-\d{2}-\d{2}$/.test(value.period.key) &&
        Number.isFinite(start) &&
        value.period.since === `${value.period.key}T00:00:00.000Z` &&
        value.period.until === new Date(start + 86_400_000).toISOString(),
    );
  }
  return value;
}

function decode(bytes: Uint8Array): JsonObject {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!String(value?.schema || "").startsWith("report-json/")) {
    requireValue(isJsonObject(value));
    return value;
  }
  requireValue(
    isJsonObject(value) &&
      Object.keys(value).sort().join(",") === "data,decodedBytes,decodedSha256,encoding,schema" &&
      value.schema === "report-json/v1" &&
      value.encoding === "deflate+base64" &&
      Number.isSafeInteger(value.decodedBytes) &&
      value.decodedBytes > 0 &&
      value.decodedBytes <= decodedLimit &&
      typeof value.decodedSha256 === "string" &&
      hash.test(value.decodedSha256) &&
      typeof value.data === "string" &&
      value.data.length > 0 &&
      value.data.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(value.data),
  );
  const compressed = Buffer.from(value.data, "base64");
  requireValue(compressed.toString("base64") === value.data);
  const raw = inflateSync(compressed, { maxOutputLength: value.decodedBytes });
  requireValue(raw.length === value.decodedBytes && sha256(raw) === value.decodedSha256);
  const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  requireValue(isJsonObject(report) && !String(report.schema || "").startsWith("report-json/"));
  return report;
}

export async function readPublishedDailyReport({
  baseUrl,
  destination,
  date,
  headers,
  fetcher,
}: {
  baseUrl: string;
  destination: string;
  date?: string;
  headers?: Record<string, string>;
  fetcher: typeof fetch;
}): Promise<{ report: JsonObject; date: string; dataUrl: string; acceptance: string } | null> {
  const base = new URL(baseUrl),
    target = new URL(destination);
  requireValue(
    (base.protocol === "https:" ||
      (base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash &&
      target.protocol === "https:" &&
      !target.username &&
      !target.password &&
      !target.search &&
      !target.hash,
  );
  if (date !== undefined)
    requireValue(
      /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date).toISOString().slice(0, 10) === date,
    );
  const signal = AbortSignal.timeout(60_000);
  async function read(url: URL, limit: number): Promise<Uint8Array> {
    const response = await fetcher(url, {
      headers: { ...headers, accept: "application/json" },
      signal,
      redirect: "error",
      cache: "no-store",
    });
    requireValue(
      response.ok &&
        !response.redirected &&
        response.headers.get("cache-control") === "no-store" &&
        response.body,
    );
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        requireValue(size <= limit);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  }
  const catalogUrl = new URL("v1/reports/publications", base);
  catalogUrl.searchParams.set("destination", target.href);
  let catalogBytes = 0;
  async function page(url: URL): Promise<JsonObject> {
    const bytes = await read(url, 256 * 1024);
    catalogBytes += bytes.byteLength;
    requireValue(catalogBytes <= 32 * 1024 * 1024);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    requireValue(
      isJsonObject(value) &&
        value.schema === "report-publication-catalog/v1" &&
        value.destination === target.href &&
        /^report-publications-v1:[a-f0-9]{64}$/.test(value.snapshotRevision) &&
        Number.isSafeInteger(value.totalEntries) &&
        value.totalEntries >= 0 &&
        value.totalEntries <= 10_000 &&
        Array.isArray(value.entries) &&
        value.entries.length <= 64 &&
        value.entries.length <= value.totalEntries &&
        (value.nextCursor === null ||
          (typeof value.nextCursor === "string" &&
            /^[A-Za-z0-9_-]{1,4096}$/.test(value.nextCursor) &&
            value.entries.length > 0)),
    );
    return value;
  }
  try {
    let cursor = "",
      previousKey = "",
      count = 0,
      selected: JsonObject | undefined,
      snapshot: JsonObject | undefined;
    const cursors = new Set<string>();
    do {
      const url = new URL(catalogUrl);
      if (cursor) url.searchParams.set("cursor", cursor);
      const current = await page(url);
      snapshot ??= current;
      requireValue(
        current.snapshotRevision === snapshot.snapshotRevision &&
          current.totalEntries === snapshot.totalEntries,
      );
      for (const entry of current.entries) {
        requireValue(
          isJsonObject(entry) &&
            typeof entry.publishedAt === "string" &&
            Number.isFinite(Date.parse(entry.publishedAt)),
        );
        const candidate = receipt(entry.receipt),
          key = `${candidate.period.period}:${candidate.period.key}`;
        requireValue(key > previousKey);
        previousKey = key;
        count++;
        if (
          candidate.period.period === "day" &&
          (date
            ? candidate.period.key === date
            : !selected || candidate.period.key > selected.period.key)
        )
          selected = candidate;
      }
      requireValue(count <= snapshot.totalEntries);
      cursor = current.nextCursor ?? "";
      requireValue(!cursor || !cursors.has(cursor));
      cursors.add(cursor);
    } while (cursor);
    requireValue(snapshot && count === snapshot.totalEntries);
    if (!selected) return null;
    const url = new URL(`v1/reports/publications/acceptances/${selected.acceptance}`, base);
    url.searchParams.set("destination", target.href);
    url.searchParams.set("snapshot", snapshot.snapshotRevision);
    const accepted = receipt(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(url, 256 * 1024))),
    );
    requireValue(isDeepStrictEqual(accepted, selected));
    url.pathname += "/data";
    const raw = await read(url, 20 * 1024 * 1024);
    requireValue(sha256(raw) === accepted.artifacts.report);
    const report = decode(raw),
      sources = asJsonObject(report.sources),
      database = asJsonObject(sources.database);
    const acknowledgment = asJsonObject(database.acceptance),
      coverage = sources.coverage;
    const errors = asJsonObject(sources.github).errors;
    const timelineGaps = asJsonObject(sources.github).timelineGaps;
    const timelineBound =
      timelineGaps === undefined ||
      (Number.isSafeInteger(timelineGaps.unavailablePullRequests) &&
        timelineGaps.unavailablePullRequests > 0 &&
        timelineGaps.unavailablePullRequests <= 10 &&
        Number.isSafeInteger(timelineGaps.discoveredPullRequestsLowerBound) &&
        timelineGaps.discoveredPullRequestsLowerBound >= 0 &&
        timelineGaps.unavailablePullRequests * 100 <=
          timelineGaps.discoveredPullRequestsLowerBound * 3 &&
        Array.isArray(errors) &&
        errors.includes(
          `${timelineGaps.unavailablePullRequests} unreadable pull request timeline${timelineGaps.unavailablePullRequests === 1 ? "" : "s"} among at least ${timelineGaps.discoveredPullRequestsLowerBound} discovered pull requests. Counts contain observed activity only.`,
        ));
    requireValue(
      isDeepStrictEqual(report.period, accepted.period) &&
        report.window?.since === accepted.period.since &&
        report.window?.until === accepted.period.until &&
        database.version === accepted.version &&
        database.cutoff === accepted.cutoff &&
        database.identitySha256 === accepted.identitySha256 &&
        sources.publicProjection === accepted.publicProjection &&
        acknowledgment.policyRevision === accepted.policyRevision &&
        acknowledgment.coverageSha256 === accepted.coverageSha256 &&
        acknowledgment.gapsSha256 === accepted.gapsSha256 &&
        Array.isArray(coverage) &&
        coverage.every(isJsonObject) &&
        Array.isArray(errors) &&
        sha256(JSON.stringify(coverage)) === accepted.coverageSha256 &&
        sha256(JSON.stringify(coverage.filter((cell) => cell.state !== "complete"))) ===
          accepted.gapsSha256 &&
        sha256(JSON.stringify(errors)) === acknowledgment.githubWarningsSha256 &&
        ["reviewed", "declared-source"].includes(acknowledgment.mode) &&
        ["", "report-declared-sources/v1"].includes(acknowledgment.sourcePolicyRevision) &&
        Array.isArray(acknowledgment.sourceCheckpoints) &&
        acknowledgment.sourceCheckpoints.every(
          (item: JsonObject) =>
            typeof item.source === "string" &&
            item.source &&
            typeof item.watermark === "string" &&
            item.watermark.endsWith("Z") &&
            Number.isFinite(Date.parse(item.watermark)),
        ) &&
        timelineBound &&
        acknowledgment.acknowledgedGaps ===
          coverage.filter((cell) => cell.state !== "complete").length,
    );
    return {
      report,
      date: accepted.period.key,
      dataUrl: url.href,
      acceptance: accepted.acceptance,
    };
  } catch {
    // Neither service responses nor Access credentials belong in notification logs.
    throw new Error("Published maintainer report verification failed");
  }
}
