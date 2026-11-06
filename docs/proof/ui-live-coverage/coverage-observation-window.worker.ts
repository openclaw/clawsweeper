// Synthetic-only native-runtime fixture. Never deployed; no production credentials.
import worker, { ExactReviewQueue as Queue } from "../../../dashboard/worker.ts";
import { ReviewCoverageCensusStore } from "../../../dashboard/review-coverage-census.ts";

export class ExactReviewQueue extends Queue {
  raw;
  requestClock = 0;
  clockOffset = 0;
  constructor(state, env) {
    super(state, env);
    this.raw = state.storage;
    const store = new ReviewCoverageCensusStore(state.storage);
    const temporal = new Set(["prepare", "start", "next", "accept", "fail"]);
    this.coverageCensus = new Proxy(store, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return temporal.has(String(key))
          ? (body) => value.call(target, body, this.requestClock)
          : value.bind(target);
      },
    });
  }
  async fetch(request) {
    // Independent, advancing server clock, captured at each real request I/O.
    // The signed body and all production method/lease/CAS/SQLite paths are intact.
    if (new URL(request.url).pathname === "/proof-clock") {
      this.clockOffset = Number(request.headers.get("x-proof-clock-offset"));
      return Response.json({ clockOffset: this.clockOffset });
    }
    this.requestClock = Date.now() + this.clockOffset;
    if (new URL(request.url).pathname === "/proof-state") {
      const names = [...this.raw.sql.exec("SELECT name FROM sqlite_master WHERE type='table'")]
        .map((row) => String(row.name))
        .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
      return Response.json({
        tables: Object.fromEntries(
          names.map((name) => [name, [...this.raw.sql.exec('SELECT * FROM "' + name + '"')]]),
        ),
        kv: [...(await this.raw.list())],
        alarm: await this.raw.getAlarm(),
      });
    }
    const reply = await super.fetch(request);
    const headers = new Headers(reply.headers);
    headers.set("x-proof-server-time", String(this.requestClock));
    return new Response(reply.body, { status: reply.status, headers });
  }
}
export default {
  async fetch(request, env, ctx) {
    if (["/proof-state", "/proof-clock"].includes(new URL(request.url).pathname))
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    return worker.fetch(request, env, ctx);
  },
};
