import { DatabaseSync } from "node:sqlite";

class SqlCursor<T extends Record<string, unknown>> implements Iterable<T> {
  private readonly rows: T[];

  constructor(rows: T[]) {
    this.rows = rows;
  }

  *[Symbol.iterator]() {
    yield* this.rows;
  }
}

export class TestStorage {
  private readonly database = new DatabaseSync(":memory:");
  private readonly values = new Map<string, unknown>();
  private failSqlPattern: RegExp | null = null;
  private failSqlMatchesRemaining = 0;
  private alarmAt: number | null = null;
  readonly sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      if (this.failSqlPattern?.test(query)) {
        this.failSqlMatchesRemaining -= 1;
        if (this.failSqlMatchesRemaining === 0) {
          this.failSqlPattern = null;
          throw new Error("injected telemetry state write failure");
        }
      }
      const statement = this.database.prepare(query);
      if (/^\s*(?:SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return new SqlCursor(statement.all(...bindings) as Record<string, unknown>[]);
      }
      statement.run(...bindings);
      return new SqlCursor<Record<string, unknown>>([]);
    },
  };

  failNextSqlMatching(pattern: RegExp) {
    this.failSqlPattern = pattern;
    this.failSqlMatchesRemaining = 1;
  }

  failSqlMatchingAfter(pattern: RegExp, successfulMatches: number) {
    this.failSqlPattern = pattern;
    this.failSqlMatchesRemaining = successfulMatches + 1;
  }
  readonly kv = {
    get: (key: string) => this.values.get(key),
    put: (key: string, value: unknown) => this.values.set(key, structuredClone(value)),
    delete: (key: string) => this.values.delete(key),
  };

  transactionSync<T>(callback: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  scalar(query: string) {
    return Number((this.database.prepare(query).get() as { value: number }).value);
  }

  exec(query: string) {
    this.database.exec(query);
  }

  run(query: string, ...bindings: unknown[]) {
    this.database.prepare(query).run(...bindings);
  }

  async get(key: string) {
    return this.values.get(key);
  }

  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string) {
    this.values.delete(key);
  }

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix || "";
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  async getAlarm() {
    return this.alarmAt;
  }

  async setAlarm(at: number) {
    this.alarmAt = at;
  }

  async deleteAlarm() {
    this.alarmAt = null;
  }

  scheduledAlarm() {
    return this.alarmAt;
  }
}
