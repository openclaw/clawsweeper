export type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};
export type DurableStorage = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};
