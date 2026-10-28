// Synthetic seed/inspection routes for native local proof. Never deploy this fixture.
import { DurableObject } from "cloudflare:workers";
import worker from "../../../dashboard/worker.ts";
import { ExactReviewQueue } from "../../../dashboard/exact-review-queue.ts";
import { encodeStoredJson, STORED_JSON_PLACEHOLDER } from "../../../dashboard/stored-json.ts";

const asOf = 1_800_000_000_000;
const old = asOf - 30 * 60_000 - 1;
const repository = "example/project";
const items = "github_webhook_read_model_items_v1";
const comments = "github_webhook_read_model_comments_v1";
const activity = "github_webhook_read_model_activity_v1";

export class Queue extends DurableObject {
  private queue;
  private queries: any[] = [];
  constructor(ctx, env) {
    super(ctx, env);
    const sql = new Proxy(ctx.storage.sql, {
      get: (target, key) =>
        key === "exec"
          ? (query, ...bindings) => {
              const cursor = target.exec(query, ...bindings);
              this.queries.push({ query, cursor });
              return cursor;
            }
          : Reflect.get(target, key, target),
    });
    const storage = new Proxy(ctx.storage, {
      get: (target, key) => {
        if (key === "sql") return sql;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const state = new Proxy(ctx, {
      get: (target, key) => {
        if (key === "storage") return storage;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.queue = new ExactReviewQueue(state, env);
  }
  async alarm() {
    await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    const route = new URL(request.url).pathname;
    const sql = this.ctx.storage.sql;
    if (route === "/__proof/seed") {
      const store = this.queue.githubWebhookReadModelStore;
      store.ensureSchemaSync();
      for (let number = 1; number <= 9; number++) {
        store.ingest(
          {
            version: 1,
            deliveryId: `delivery-${number}`,
            event: "issue_comment",
            action: "created",
            receivedAt: new Date(old).toISOString(),
            eventClasses: ["issue_comments"],
            objects: [
              {
                kind: "item",
                repository,
                number,
                itemKind: "issue",
                sourceUpdatedAt: new Date(old).toISOString(),
                snapshot: { number, body: "雪🦊\0" },
              },
              {
                kind: "comment",
                repository,
                number,
                id: number,
                tombstone: number === 3,
                sourceUpdatedAt: new Date(old).toISOString(),
                snapshot: {
                  id: number,
                  body: [2, 9].includes(number) ? STORED_JSON_PLACEHOLDER : "雪🦊\0",
                },
              },
            ],
          },
          old,
        );
      }
      sql.exec(
        `UPDATE ${comments} SET snapshot_json=? WHERE number=2`,
        encodeStoredJson(
          JSON.stringify({ body: `${STORED_JSON_PLACEHOLDER} ${"雪🦊".repeat(1000)}` }),
        ),
      );
      sql.exec(`UPDATE ${comments} SET payload_pruned=1, snapshot_json='{}' WHERE number=4`);
      sql.exec(`UPDATE ${comments} SET payload_retire_at=-1 WHERE number=5`);
      sql.exec(`UPDATE ${items} SET received_at=? WHERE number=6`, asOf - 30 * 60_000);
      sql.exec(`UPDATE ${comments} SET payload_retire_at=? WHERE number=7`, asOf);
      await this.ctx.storage.put("proof-sentinel", { retained: true });
      await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
      return Response.json({ ok: true, asOf });
    }
    if (route === "/__proof/large") {
      // 65 independent capped families exercise indexed probes, not a global join.
      for (let number = 10; number <= 74; number++) {
        sql.exec(
          `INSERT INTO ${items} (repository,number,item_kind,source_updated_at,snapshot_json,delivery_id,watermark,received_at,payload_pruned,payload_retire_at)
          VALUES (?,?,'issue',?,'{}','large',1,?,0,0)`,
          repository,
          number,
          old,
          old,
        );
        sql.exec(
          `WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<500)
          INSERT INTO ${comments} (repository,number,comment_id,source_updated_at,tombstone,snapshot_json,delivery_id,watermark,received_at,payload_pruned,payload_retire_at)
          SELECT ?,?,id,?,0,?,'large',1,?,0,0 FROM ids`,
          repository,
          number,
          old,
          JSON.stringify({ body: "stored evidence ".repeat(32) }),
          old,
        );
        sql.exec(
          `WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<500)
          INSERT INTO ${activity} (repository,number,activity_kind,activity_id,source_updated_at,tombstone,snapshot_json,delivery_id,watermark,received_at,payload_pruned,payload_retire_at)
          SELECT ?,?,'review',id,?,0,?,'large',1,?,0,0 FROM ids`,
          repository,
          number,
          old,
          JSON.stringify({ body: "review evidence ".repeat(32) }),
          old,
        );
        sql.exec(
          `INSERT INTO ${activity}
          (repository,number,activity_kind,activity_id,source_updated_at,tombstone,snapshot_json,delivery_id,watermark,received_at,payload_pruned,payload_retire_at)
          SELECT repository,number,'review_comment',activity_id,source_updated_at,tombstone,snapshot_json,delivery_id,watermark,received_at,payload_pruned,payload_retire_at
          FROM ${activity} WHERE repository=? AND number=? AND activity_kind='review'`,
          repository,
          number,
        );
      }
      return Response.json({ ok: true, families: 65, childrenPerFamily: 1500 });
    }
    if (route === "/__proof/inspect") {
      const tables = [
        ...sql.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
        ),
      ];
      const records = tables.map(({ name }) => [
        name,
        [...sql.exec(`SELECT rowid,* FROM "${String(name).replaceAll('"', '""')}" ORDER BY rowid`)],
      ]);
      const kv = [...(await this.ctx.storage.list())];
      const bytes = new TextEncoder().encode(JSON.stringify({ records, kv }));
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      return Response.json({
        digest,
        alarm: await this.ctx.storage.getAlarm(),
        databaseBytes: sql.databaseSize,
      });
    }
    this.queries = [];
    const started = Date.now();
    const response = await this.queue.fetch(request);
    const headers = new Headers(response.headers);
    headers.set(
      "x-proof-rows-read",
      String(this.queries.reduce((n, q) => n + q.cursor.rowsRead, 0)),
    );
    headers.set(
      "x-proof-rows-written",
      String(this.queries.reduce((n, q) => n + q.cursor.rowsWritten, 0)),
    );
    headers.set("x-proof-query-count", String(this.queries.length));
    headers.set("x-proof-ms", String(Date.now() - started));
    return new Response(response.body, { status: response.status, headers });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = url.searchParams.get("fixture") === "cold" ? "cold" : "main";
    const namespace = {
      idFromName: () => env.QUEUE.idFromName(target),
      get: (id) => env.QUEUE.get(id),
    };
    if (url.pathname.startsWith("/__proof/"))
      return namespace.get(namespace.idFromName()).fetch(request);
    return worker.fetch(
      request,
      { ...env, EXACT_REVIEW_QUEUE: namespace, CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-secret" },
      ctx,
    );
  },
};
