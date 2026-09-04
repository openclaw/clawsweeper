export type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};
export type DurableStorage = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};

export function sqlColumnNames(storage: DurableStorage, table: string): Set<string> {
  return new Set(
    Array.from(storage.sql.exec(`SELECT name FROM pragma_table_info('${table}')`)).map((row) =>
      String(row.name || ""),
    ),
  );
}
