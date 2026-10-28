import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
let progress;

// Explicit operator diagnostic: retain only one bounded page and column totals.
async function main() {
  const table = process.env.STORAGE_CENSUS_TABLE || "";
  const secret = process.env.CLAWSWEEPER_WEBHOOK_SECRET || "";
  const base = new URL(process.env.EXACT_REVIEW_QUEUE_URL || "");
  if (
    base.username ||
    base.password ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))
  )
    throw new Error("invalid census endpoint");
  const maxPages = Number(process.env.STORAGE_CENSUS_MAX_PAGES || 100);
  if (!table || !secret || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000)
    throw new Error("census requires table, secret and 1..1000 pages");
  let cursor = JSON.parse(process.env.STORAGE_CENSUS_CURSOR || "{}");
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor))
    throw new Error("invalid census cursor");
  if (cursor.retention !== undefined && typeof cursor.retention !== "boolean")
    throw new Error("invalid census retention mode");
  const retentionRequested = cursor.retention === true;
  let retention;
  const started = Date.now();
  const columns = Object.create(null);
  let result;
  let scannedRows = 0;
  let pages = 0;
  const rangeStart = cursor.afterRowid ?? 0;
  while (pages < maxPages && Date.now() - started < 240_000) {
    const body = JSON.stringify({ census: { ...cursor, table } });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const response = await fetch(new URL("/internal/exact-review/storage-stats", base), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(Math.min(15_000, 240_000 - (Date.now() - started))),
    });
    if (!response.ok) throw new Error(`storage census HTTP ${response.status}`);
    const value = await response.json();
    const page = value.census;
    if (
      value.ok !== true ||
      page?.table !== table ||
      page.afterRowid !== (cursor.afterRowid ?? 0) ||
      !Number.isSafeInteger(page.upperRowid) ||
      page.upperRowid < page.afterRowid ||
      (cursor.upperRowid !== undefined && page.upperRowid !== cursor.upperRowid) ||
      !Number.isSafeInteger(page.scannedRows) ||
      page.scannedRows < 0 ||
      page.scannedRows > 128 ||
      typeof page.complete !== "boolean" ||
      !page.columns ||
      Array.isArray(page.columns) ||
      typeof page.columns !== "object"
    )
      throw new Error("invalid census response");
    const keys = Object.keys(page.columns);
    if (pages && keys.join("\0") !== Object.keys(columns).join("\0"))
      throw new Error("census columns changed");
    for (const key of keys) {
      const bytes = page.columns[key];
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        !Number.isSafeInteger((columns[key] ?? 0) + bytes)
      )
        throw new Error("invalid census bytes");
    }
    if (retentionRequested) {
      const summary = page.retention;
      if (
        !summary ||
        !Number.isSafeInteger(summary.asOf) ||
        summary.asOf < 0 ||
        (cursor.asOf !== undefined && summary.asOf !== cursor.asOf) ||
        (retention && summary.asOf !== retention.asOf) ||
        page.scannedRows > 64 ||
        !keys.includes("snapshot_json") ||
        !Number.isSafeInteger(summary.eligibleRows) ||
        summary.eligibleRows < 0 ||
        summary.eligibleRows > page.scannedRows ||
        !Number.isSafeInteger(summary.eligibleStoredBytes) ||
        summary.eligibleStoredBytes < 0 ||
        summary.eligibleStoredBytes > page.columns.snapshot_json ||
        (summary.eligibleRows === 0 && summary.eligibleStoredBytes !== 0)
      )
        throw new Error("invalid census retention");
    } else if (page.retention !== undefined) throw new Error("unexpected census retention");
    if (
      page.complete
        ? page.nextCursor !== null
        : !page.nextCursor ||
          !Number.isSafeInteger(page.nextCursor.afterRowid) ||
          page.nextCursor.afterRowid <= page.afterRowid ||
          page.nextCursor.afterRowid > page.upperRowid ||
          page.nextCursor.upperRowid !== page.upperRowid ||
          (retentionRequested &&
            (page.nextCursor.retention !== true || page.nextCursor.asOf !== page.retention.asOf))
    )
      throw new Error("invalid census continuation");
    for (const key of keys) columns[key] = (columns[key] ?? 0) + page.columns[key];
    if (retentionRequested) {
      retention ??= {
        asOf: page.retention.asOf,
        eligibleRows: 0,
        eligibleStoredBytes: 0,
      };
      // Eligibility is a subset of the validated page totals, so their bounds
      // also protect these accumulators from overflow.
      retention.eligibleRows += page.retention.eligibleRows;
      retention.eligibleStoredBytes += page.retention.eligibleStoredBytes;
    }
    scannedRows += page.scannedRows;
    pages++;
    result = {
      table,
      rangeStart,
      upperRowid: page.upperRowid,
      scannedRows,
      columns,
      pages,
      complete: page.complete,
      nextCursor: page.nextCursor,
      databaseBytes: value.databaseBytes,
      semantics: page.semantics,
      ...(retention ? { retention } : {}),
    };
    progress = result;
    if (page.complete) break;
    cursor = page.nextCursor;
  }
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Storage content census\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`,
    );
}

main().catch((error) => {
  if (progress) console.log(JSON.stringify({ ...progress, failed: true }));
  console.error(`storage census failed: ${error.message}`);
  process.exitCode = 1;
});
