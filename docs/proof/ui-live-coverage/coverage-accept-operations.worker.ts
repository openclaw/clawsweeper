// Local proof fixture only; never deployed. Import paths are redirected by the runner.
import worker, { ExactReviewQueue as Queue } from "../../../dashboard/worker.ts";
import { ReviewCoverageCensusStore } from "../../../dashboard/review-coverage-census.ts";

export class ExactReviewQueue extends Queue {
  raw;
  inject = false;
  constructor(state, env) {
    super(state, env);
    this.raw = state.storage;
    const sql = {
      exec: (text, ...bindings) => {
        if (this.inject && text.startsWith("INSERT INTO coverage_census_receipts")) {
          this.inject = false;
          throw new TypeError("private-sql-token-cursor");
        }
        return this.raw.sql.exec(text, ...bindings);
      },
    };
    const storage = new Proxy(this.raw, {
      get(target, property) {
        if (property === "sql") return sql;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.coverageCensus = new ReviewCoverageCensusStore(storage);
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/proof-arm") {
      this.inject = true;
      return Response.json({ armed: true });
    }
    if (path === "/proof-state") {
      const names = [...this.raw.sql.exec("SELECT name FROM sqlite_master WHERE type='table'")]
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
      const tables = Object.fromEntries(
        names.map((name) => [name, [...this.raw.sql.exec('SELECT * FROM "' + name + '"')]]),
      );
      return Response.json({
        tables,
        kv: [...(await this.raw.list())],
        alarm: await this.raw.getAlarm(),
        complete: tables.coverage_census_repositories.filter(
          (row) => JSON.parse(row.state).complete,
        ).length,
      });
    }
    if (path === "/proof-limits") {
      const limits = [];
      for (const binds of [100, 101]) {
        try {
          Array.from(
            this.raw.sql.exec(
              "SELECT ? AS n WHERE 1 IN (" +
                Array(binds - 1)
                  .fill("?")
                  .join(",") +
                ")",
              ...Array(binds).fill(1),
            ),
          );
          limits.push({ binds, ok: true });
        } catch {
          limits.push({ binds, ok: false });
        }
      }
      return Response.json(limits);
    }
    return super.fetch(request);
  }
}
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/proof-")) {
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    }
    return worker.fetch(request, env, ctx);
  },
};
