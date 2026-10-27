// Per-table size estimate for a Durable Object's SQLite store.
//
// Cloudflare reports occupied SQLite bytes, excluding free pages. This reads each table's row count and
// the average size of a small sample of rows, so the estimate costs one COUNT(*) and two bounded
// samples per table instead of reading every row's content. This estimates content bytes,
// not occupied pages: record headers, indexes, and unused space within pages are not counted.

// Rows sampled from each end of a table (oldest and newest by rowid): old and new rows of a
// growing table can differ in size.
const SAMPLE_ROWS_PER_END = 100;

type SqlStorage = {
  exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
  databaseSize?: number;
};

export type StorageTableStats = {
  table: string;
  rows: number;
  sampledRows: number;
  averageRowBytes: number;
  estimatedBytes: number;
};

export type StorageStats = {
  databaseBytes: number | null;
  estimatedTableBytes: number;
  tables: StorageTableStats[];
};

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

const CENSUS_PAGE_ROWS = 128;

export function storageContentPage(sql: SqlStorage, input: unknown) {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const table = typeof value.table === "string" ? value.table : "";
  const afterRowid = value.afterRowid ?? 0;
  const upper = value.upperRowid;
  if (
    !Number.isSafeInteger(afterRowid) ||
    Number(afterRowid) < 0 ||
    (upper !== undefined && (!Number.isSafeInteger(upper) || Number(upper) < Number(afterRowid))) ||
    (Number(afterRowid) > 0 && upper === undefined)
  ) {
    throw new Error("invalid_storage_census_cursor");
  }
  const definition = Array.from(
    sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table),
  )[0];
  if (!definition || /^(?:sqlite_|_cf_|__cf_)/i.test(table)) {
    throw new Error("invalid_storage_census_table");
  }
  if (
    Array.from(
      sql.exec("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?", table),
    )[0]?.wr
  ) {
    throw new Error("storage_census_requires_rowid");
  }
  const columns = Array.from(sql.exec("SELECT name FROM pragma_table_info(?)", table)).map((row) =>
    String(row.name),
  );
  // Workerd caps result columns at 100; reserve two for row count and last identity.
  if (columns.length > 98) throw new Error("invalid_storage_census_columns");
  if (columns.some((name) => ["rowid", "_rowid_", "oid"].includes(name.toLowerCase()))) {
    throw new Error("storage_census_requires_rowid");
  }
  const quoted = quoteIdentifier(table);
  const range =
    upper === undefined
      ? Array.from(
          sql.exec(
            `SELECT (SELECT MIN(rowid) FROM ${quoted}) AS first_id, MAX(rowid) AS last_id FROM ${quoted}`,
          ),
        )[0]
      : undefined;
  const upperRowid = Number(upper ?? range?.last_id ?? 0);
  if (
    !Number.isSafeInteger(upperRowid) ||
    upperRowid < Number(afterRowid) ||
    (range?.first_id != null && Number(range.first_id) <= 0)
  ) {
    throw new Error("invalid_storage_census_cursor");
  }
  // octet_length of a direct TEXT/BLOB column uses SQLite's length metadata;
  // no large value crosses into JS. Numeric storage and page/index overhead are excluded.
  const sizes = columns.map((name, i) => {
    const column = quoteIdentifier(name);
    return `CASE WHEN typeof(${column}) IN ('text', 'blob') THEN octet_length(${column}) ELSE 0 END AS c${i}`;
  });
  const totals = columns.map((_, i) => `COALESCE(SUM(c${i}), 0) AS c${i}`);
  const row = Array.from(
    sql.exec(
      `SELECT COUNT(*) AS scanned, MAX(id) AS last_id, ${totals.join(", ")} FROM (
       SELECT rowid AS id, ${sizes.join(", ")} FROM ${quoted}
        WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ${CENSUS_PAGE_ROWS}
     )`,
      afterRowid,
      upperRowid,
    ),
  )[0]!;
  const scannedRows = Number(row.scanned);
  const lastRowid = Number(row.last_id ?? upperRowid);
  const complete = scannedRows < CENSUS_PAGE_ROWS || lastRowid === upperRowid;
  return {
    table,
    afterRowid: Number(afterRowid),
    upperRowid,
    scannedRows,
    columns: Object.fromEntries(columns.map((name, i) => [name, Number(row[`c${i}`])])),
    nextCursor: complete ? null : { afterRowid: lastRowid, upperRowid },
    complete,
    semantics:
      "observed TEXT/BLOB bytes; excludes numeric storage, indexes and overhead; concurrent pages are not an atomic snapshot",
  };
}

function tableStats(sql: SqlStorage, table: string): StorageTableStats {
  const quoted = quoteIdentifier(table);
  const columns = Array.from(sql.exec(`SELECT name FROM pragma_table_info(?)`, table)).map((row) =>
    quoteIdentifier(String(row.name)),
  );
  const rows = Number(Array.from(sql.exec(`SELECT COUNT(*) AS rows FROM ${quoted}`))[0]?.rows ?? 0);
  // BLOB length counts encoded bytes, including text after NUL; TEXT length counts code points
  // only up to NUL. Numbers still use their text representation, an intentional approximation.
  const rowBytes =
    columns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(" + ") || "0";
  const sample = (order: string) =>
    Array.from(
      sql.exec(
        `SELECT ${rowBytes} AS row_bytes FROM ${quoted} ${order} LIMIT ${SAMPLE_ROWS_PER_END}`,
      ),
    ).map((row) => Number(row.row_bytes ?? 0));
  let sizes: number[];
  try {
    sizes = [
      ...sample("ORDER BY rowid"),
      ...(rows > SAMPLE_ROWS_PER_END ? sample("ORDER BY rowid DESC") : []),
    ];
  } catch {
    // WITHOUT ROWID tables have no rowid to order by; take the first rows instead.
    sizes = sample("");
  }
  const averageRowBytes = sizes.length
    ? Math.round(sizes.reduce((total, size) => total + size, 0) / sizes.length)
    : 0;
  return {
    table,
    rows,
    sampledRows: sizes.length,
    averageRowBytes,
    estimatedBytes: rows * averageRowBytes,
  };
}

export function storageStats(sql: SqlStorage): StorageStats {
  const tables = Array.from(
    sql.exec(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
        ORDER BY name`,
    ),
  ).map((row) => tableStats(sql, String(row.name)));
  tables.sort((left, right) => right.estimatedBytes - left.estimatedBytes);
  return {
    databaseBytes: typeof sql.databaseSize === "number" ? sql.databaseSize : null,
    estimatedTableBytes: tables.reduce((total, table) => total + table.estimatedBytes, 0),
    tables,
  };
}
