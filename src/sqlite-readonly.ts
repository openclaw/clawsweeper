import { DatabaseSync } from "node:sqlite";

export type SqliteRow = Record<string, unknown>;

export function querySqliteRows(dbPath: string, sql: string): SqliteRow[] {
  return withReadOnlyDatabase(dbPath, (database) => {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all().map(normalizeRow);
  });
}

export function querySqliteScalar(dbPath: string, sql: string): string {
  return withReadOnlyDatabase(dbPath, (database) => {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    const row = statement.get();
    if (!row) return "";
    const value = Object.values(row)[0];
    return value === null || value === undefined ? "" : String(value);
  });
}

function withReadOnlyDatabase<T>(dbPath: string, operation: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function normalizeRow(row: SqliteRow): SqliteRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      // sqlite3 -json emitted integer literals which JSON.parse exposed as numbers,
      // including its established precision loss above Number.MAX_SAFE_INTEGER.
      typeof value === "bigint" ? Number(value) : value,
    ]),
  );
}
