// Per-table size estimate for a Durable Object's SQLite store.
//
// Cloudflare reports only the total stored bytes. This reads, for each table, its row count and
// the average size of a small sample of rows, so the estimate costs one COUNT(*) and two bounded
// samples per table instead of reading every row's content. Index pages are not counted.

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

function tableStats(sql: SqlStorage, table: string): StorageTableStats {
  const quoted = quoteIdentifier(table);
  const columns = Array.from(sql.exec(`SELECT name FROM pragma_table_info(?)`, table)).map((row) =>
    quoteIdentifier(String(row.name)),
  );
  const rows = Number(Array.from(sql.exec(`SELECT COUNT(*) AS rows FROM ${quoted}`))[0]?.rows ?? 0);
  // length() of a number is its text length; close enough for an estimate of stored bytes.
  const rowBytes = columns.map((column) => `COALESCE(length(${column}), 0)`).join(" + ") || "0";
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
