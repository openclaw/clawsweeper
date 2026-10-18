// Local-only fixture. Never deploy these synthetic seed and inspection routes.
import { DurableObject } from "cloudflare:workers";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";
import { storageContentPage } from "../../../dashboard/storage-stats.ts";
const coverage = "github_webhook_read_model_workflow_coverage_v1";
globalThis.fetch = async () => {
  throw new Error("proof forbids outbound requests");
};

export class Queue extends DurableObject {
  private queue;
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = new ProductionQueue(ctx, {
      ...env,
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    });
  }
  async alarm() {
    if (!this.ctx.storage.kv.get("enabled")) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const sql = this.ctx.storage.sql;
    const count = () => Number([...sql.exec(`SELECT COUNT(*) AS n FROM ${coverage}`)][0].n);
    const before = count();
    const start = Date.now();
    await this.queue.alarm();
    const passes = this.ctx.storage.kv.get("passes") ?? [];
    this.ctx.storage.kv.put("passes", [
      ...passes,
      { retired: before - count(), ms: Date.now() - start },
    ]);
  }
  async fetch(request: Request) {
    const route = new URL(request.url).pathname;
    const sql = this.ctx.storage.sql;
    if (route === "/seed") {
      const body = (await request.json()) as any;
      await this.queue.fetch(
        new Request("http://queue/admission-capabilities", { method: "POST" }),
      );
      const now = Date.now();
      sql.exec(
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ?)
        INSERT INTO ${coverage} SELECT 'example/project', CASE WHEN n % 2 THEN 'run_jobs_v2' ELSE 'run_jobs' END,
          n, ?, 1 FROM seq`,
        body.count,
        now - 600_000,
      );
      sql.exec(
        `INSERT INTO ${coverage} VALUES ('example/project','run_census',0,0,1),
        ('example/project','unknown',0,0,1),('example/project','run_jobs_v2',999999,?,1)`,
        now + 60_000,
      );
      sql.exec("CREATE TABLE census_sample (body TEXT, payload BLOB, n INTEGER)");
      for (const width of [98, 99])
        sql.exec(
          `CREATE TABLE wide${width} (${Array.from({ length: width }, (_, i) => `c${i} TEXT`).join(",")})`,
        );
      for (let id = 1; id <= 130; id++)
        sql.exec(
          "INSERT INTO census_sample(rowid,body,payload,n) VALUES(?,?,?,?)",
          id * 2,
          id === 130 ? "雪🦊\0".repeat(10000) : "a",
          new Uint8Array([1, 2]),
          123,
        );
      return Response.json({ ok: true });
    }
    if (route === "/enable") {
      this.ctx.storage.kv.put("enabled", true);
      // Run the ordinary admission handler: initialization/scheduling owns the wake.
      return this.queue.fetch(
        new Request("http://queue/admission-capabilities", { method: "POST" }),
      );
    }
    if (route === "/inspect")
      return Response.json({
        coverage: [
          ...sql.exec(
            `SELECT coverage_kind, COUNT(*) AS n FROM ${coverage} GROUP BY coverage_kind ORDER BY coverage_kind`,
          ),
        ],
        nextAlarm: await this.ctx.storage.getAlarm(),
        passes: this.ctx.storage.kv.get("passes") ?? [],
        index: [
          ...sql.exec(
            `SELECT name FROM sqlite_master WHERE name='github_webhook_read_model_workflow_coverage_expiry_v1'`,
          ),
        ],
        plan: [
          ...sql.exec(
            `EXPLAIN QUERY PLAN SELECT rowid FROM ${coverage}
        WHERE coverage_kind IN ('run_jobs','run_jobs_v2') AND repaired_at <= ? ORDER BY repaired_at LIMIT 256`,
            Date.now() - 300_000,
          ),
        ],
      });
    if (route === "/append") {
      sql.exec("INSERT INTO census_sample VALUES ('later',NULL,0)");
      return Response.json({ ok: true });
    }
    if (route === "/census-plan") {
      const queries: { query: string; bindings: unknown[]; cursor: any }[] = [];
      storageContentPage(
        {
          exec(query, ...bindings) {
            const cursor = sql.exec(query, ...bindings);
            queries.push({ query, bindings, cursor });
            return cursor;
          },
        },
        { table: "census_sample" },
      );
      return Response.json(
        queries.map(({ query, bindings, cursor }) => ({
          rowsRead: cursor.rowsRead,
          rowsWritten: cursor.rowsWritten,
          plan: [...sql.exec(`EXPLAIN QUERY PLAN ${query}`, ...bindings)],
        })),
      );
    }
    if (route === "/future") {
      // Exercise a due-soon persisted deadline without waiting five minutes.
      sql.exec(`UPDATE ${coverage} SET repaired_at = ? WHERE run_id=999999`, Date.now() - 298_000);
      return Response.json({ ok: true });
    }
    if (route === "/refresh") {
      sql.exec(`UPDATE ${coverage} SET repaired_at = ? WHERE run_id=999999`, Date.now());
      return Response.json({ ok: true });
    }
    if (route === "/wake") {
      const at = Date.now() + 400;
      await this.ctx.storage.setAlarm(at);
      return Response.json({ at });
    }
    return this.queue.fetch(request);
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const [, object, ...parts] = url.pathname.split("/");
    url.pathname = `/${parts.join("/")}`;
    return env.QUEUE.get(env.QUEUE.idFromName(object)).fetch(new Request(url, request));
  },
};
