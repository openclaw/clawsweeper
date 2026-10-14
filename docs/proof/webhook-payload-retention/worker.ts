import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { GithubWebhookReadModelStore } from "../../../dashboard/github-webhook-read-model.ts";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";

let outbound = 0;
globalThis.fetch = async () => {
  outbound += 1;
  throw new Error("proof forbids outbound requests");
};
const repository = "example/project";
// The same wrapper also bundles against the pre-retention source revision.
const GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS = 30 * 60_000;
const wallNow = Date.now;
const sqlMetrics = new AsyncLocalStorage<{ rowsRead: number }>();
let proofNow: number | null = null;
Date.now = () => proofNow ?? wallNow();

// Keep the actual queue owner and HTTP entrypoints across both persisted builds.
// Only wall-clock alarm delivery and read-only inspection belong to the fixture.
export class ExactReviewQueue {
  private queue;
  constructor(
    private state,
    env,
  ) {
    this.queue = new ProductionQueue(state, {
      ...env,
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    });
  }
  async alarm() {
    await this.state.storage.deleteAlarm();
  }
  async fetch(request: Request) {
    proofNow = Number(request.headers.get("x-proof-now"));
    const route = new URL(request.url).pathname;
    if (route.startsWith("/__proof/")) await request.arrayBuffer();
    if (route === "/__proof/alarm") {
      await this.queue.alarm();
      return Response.json({ ok: true, outbound });
    }
    if (route === "/__proof/snapshot") {
      const sql = this.state.storage.sql;
      const rows = (query: string) => Array.from(sql.exec(query));
      const names = new Set(
        rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((r: any) => r.name),
      );
      const tableRows = (table: string) =>
        names.has(table) ? rows(`SELECT * FROM ${table} ORDER BY rowid`) : [];
      const payloadTables = ["items", "comments", "activity"].map(
        (kind) => `github_webhook_read_model_${kind}_v1`,
      );
      return Response.json({
        outbound,
        databaseBytes: sql.databaseSize,
        columns: Object.fromEntries(
          payloadTables.map((table) => [
            table,
            rows(`PRAGMA table_info(${table})`).map((r: any) => r.name),
          ]),
        ),
        payloads: Object.fromEntries(payloadTables.map((table) => [table, tableRows(table)])),
        collections: tableRows("github_webhook_read_model_collections_v1"),
        protected: Object.fromEntries(
          [
            "exact_review_queue_items",
            "exact_review_queue_deliveries",
            "exact_review_canonical_records",
            "exact_review_record_export_index",
            "canonical_record_tuple_receipts",
            "exact_review_lifecycle_projection_v1",
          ].map((table) => [table, tableRows(table)]),
        ),
      });
    }
    return this.queue.fetch(request);
  }
}

// This object delivers real wall-clock alarms. Instrumentation observes native
// SQL work and the real store result; it never drives a maintenance pass.
export class AutomaticMaintenanceProof extends DurableObject {
  private queue;
  private summary;

  constructor(ctx, env) {
    super(ctx, env);
    const sql = {
      exec: (query, ...bindings) => {
        const cursor = ctx.storage.sql.exec(query, ...bindings);
        const metrics = sqlMetrics.getStore();
        const initial = cursor.rowsRead;
        if (metrics) metrics.rowsRead += initial;
        return (function* () {
          try {
            yield* cursor;
          } finally {
            if (metrics) metrics.rowsRead += cursor.rowsRead - initial;
          }
        })();
      },
    };
    const storage = new Proxy(ctx.storage, {
      get(target, key) {
        if (key === "sql") return sql;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const state = new Proxy(ctx, {
      get(target, key) {
        if (key === "storage") return storage;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.queue = new ProductionQueue(state, {
      ...env,
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    });
    const store = (this.queue as any).githubWebhookReadModelStore;
    const prune = store.prunePayloadsSync.bind(store);
    store.prunePayloadsSync = (now) => {
      this.summary = prune(now);
      return this.summary;
    };
  }

  async alarm() {
    if (!this.ctx.storage.kv.get("proof_automatic")) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    proofNow = null;
    this.summary = null;
    const started = wallNow();
    const metrics = { rowsRead: 0 };
    await sqlMetrics.run(metrics, () => this.queue.alarm());
    const pass = {
      at: started,
      elapsedMs: wallNow() - started,
      nativeRowsRead: metrics.rowsRead,
      ...this.summary,
      nextAlarm: await this.ctx.storage.getAlarm(),
    };
    const passes = (this.ctx.storage.kv.get("proof_passes") as any[]) ?? [];
    this.ctx.storage.kv.put("proof_passes", [...passes, pass].slice(-32));
  }

  async fetch(request: Request) {
    proofNow = request.headers.has("x-proof-now")
      ? Number(request.headers.get("x-proof-now"))
      : null;
    const route = new URL(request.url).pathname;
    if (route.startsWith("/__proof/") && route !== "/__proof/dispatch-fixture") {
      await request.arrayBuffer();
    }
    if (route === "/__proof/enable") {
      this.ctx.storage.kv.put("proof_automatic", true);
      return Response.json({ ok: true });
    }
    if (route === "/__proof/dispatch-fixture") {
      const { item_key } = (await request.json()) as { item_key: string };
      const sql = this.ctx.storage.sql;
      const row = Array.from(
        sql.exec("SELECT item_json FROM exact_review_queue_items WHERE item_key = ?", item_key),
      )[0];
      if (!row) return Response.json({ error: "missing_enqueued_item" }, { status: 404 });
      const item = JSON.parse(String(row.item_json));
      // Simulate only the external workflow dispatch boundary. Claim and
      // completion still execute the real queue's persisted lease protocol.
      Object.assign(item, {
        state: "dispatching",
        leaseId: "proof-lease",
        leaseRevision: item.revision,
        leaseDecision: item.decision,
        leaseExpiresAt: wallNow() + 60 * 60_000,
      });
      sql.exec(
        "UPDATE exact_review_queue_items SET item_json = ? WHERE item_key = ?",
        JSON.stringify(item),
        item_key,
      );
      return Response.json({
        item_key,
        lease_id: item.leaseId,
        lease_revision: item.leaseRevision,
      });
    }
    if (route === "/__proof/inspect") {
      const tables = ["items", "comments", "activity"].map((kind) => {
        const table = `github_webhook_read_model_${kind}_v1`;
        return [
          kind,
          Array.from(
            this.ctx.storage.sql.exec(`SELECT COUNT(*) AS rows,
          SUM(payload_pruned) AS retired, SUM(length(CAST(snapshot_json AS BLOB))) AS bytes
          FROM ${table}`),
          )[0],
        ];
      });
      return Response.json({
        outbound,
        tables: Object.fromEntries(tables),
        passes: this.ctx.storage.kv.get("proof_passes") ?? [],
        nextAlarm: await this.ctx.storage.getAlarm(),
      });
    }
    const started = wallNow();
    const metrics = { rowsRead: 0 };
    const response = await sqlMetrics.run(metrics, () => this.queue.fetch(request));
    const headers = new Headers(response.headers);
    headers.set("x-proof-rows-read", String(metrics.rowsRead));
    headers.set("x-proof-elapsed-ms", String(wallNow() - started));
    return new Response(response.body, { status: response.status, headers });
  }
}

export class PayloadRetentionProof extends DurableObject {
  async fetch(request: Request) {
    const storage = this.ctx.storage;
    let rowsRead = 0;
    const store = new GithubWebhookReadModelStore({
      transactionSync: (callback) => storage.transactionSync(callback),
      sql: {
        exec(query, ...bindings) {
          const cursor = storage.sql.exec(query, ...bindings);
          return (function* () {
            try {
              yield* cursor;
            } finally {
              rowsRead += cursor.rowsRead;
            }
          })();
        },
      },
    });
    store.ensureSchemaSync();
    const { now } = (await request.json()) as { now: number };
    const sourceUpdatedAt = new Date(
      now - GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS - 1,
    ).toISOString();
    const item = (number: number) => ({
      kind: "item",
      repository,
      number,
      itemKind: "issue",
      sourceUpdatedAt,
      snapshot: { number, state: "open", body: "x".repeat(8192) },
    });
    const comment = {
      kind: "comment",
      repository,
      number: 1,
      id: 1,
      sourceUpdatedAt,
      tombstone: false,
      snapshot: { id: 1, body: "ordinary comment" },
    };
    const route = new URL(request.url).pathname;
    if (route === "/hot") {
      const historical = now - 50 * 60 * 60_000;
      store.ingest(
        {
          version: 1,
          deliveryId: "hot-old",
          event: "issue_comment",
          action: "created",
          receivedAt: new Date(historical).toISOString(),
          eventClasses: ["issues", "issue_comments"],
          objects: [
            item(1),
            ...Array.from({ length: 100 }, (_, index) => ({
              ...comment,
              id: index + 1,
              sourceUpdatedAt: new Date(historical).toISOString(),
            })),
          ],
        },
        historical,
      );
      store.ingest(
        {
          version: 1,
          deliveryId: "hot-new",
          event: "issue_comment",
          action: "created",
          receivedAt: new Date(now).toISOString(),
          eventClasses: ["issue_comments"],
          objects: [{ ...comment, id: 101, sourceUpdatedAt: new Date(now).toISOString() }],
        },
        now,
      );
      rowsRead = 0;
      const pruned = storage.transactionSync(() => store.prunePayloadsSync(now).retired);
      const pruneRowsRead = rowsRead;
      const value = await store.readComments({ repository, number: 1 }, now);
      return Response.json({
        pruned,
        pruneRowsRead,
        usable: value.usable,
        comments: (value.comments as unknown[]).length,
      });
    }
    if (route === "/seed") {
      store.ingest(
        {
          version: 1,
          deliveryId: "fixture-delivery",
          event: "issue_comment",
          action: "created",
          receivedAt: sourceUpdatedAt,
          eventClasses: ["issues", "issue_comments"],
          objects: [
            ...Array.from({ length: 70 }, (_, index) => item(index + 1)),
            comment,
            { ...comment, id: 2, tombstone: true, snapshot: { id: 2, body: null } },
            item(71),
            {
              ...comment,
              id: 3,
              number: 71,
              snapshot: { id: 3, body: "ClawSweeper status: review started." },
            },
          ],
        },
        Date.parse(sourceUpdatedAt),
      );
      store.repair({ repository, repair_kind: "placeholders", objects: [] }, now - 1);
    }
    if (route === "/prune") {
      const pruned = this.ctx.storage.transactionSync(() => store.prunePayloadsSync(now).retired);
      return Response.json({ pruned });
    }
    if (route === "/repair") {
      store.repair(
        {
          repository,
          repair_kind: "placeholders",
          objects: [item(1), comment],
          complete_comment_items: [1],
        },
        now,
      );
    }
    const sql = this.ctx.storage.sql;
    return Response.json({
      databaseBytes: sql.databaseSize,
      payloadBytes: [
        ...sql.exec<{ bytes: number }>(
          `SELECT SUM(length(snapshot_json)) AS bytes FROM github_webhook_read_model_items_v1`,
        ),
      ][0].bytes,
      retainedRows: [
        ...sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM github_webhook_read_model_items_v1`,
        ),
      ][0].count,
      receipts: [
        ...sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM github_webhook_read_model_deliveries_v1`,
        ),
      ][0].count,
      item: await store.readItem({ repository, number: 1 }, now),
      comments: await store.readComments({ repository, number: 1 }, now),
      placeholders: await store.readPlaceholders({ repository, state: "open" }, now),
    });
  }
}

export default {
  async fetch(
    request: Request,
    env: {
      READ_MODEL: DurableObjectNamespace;
      EXACT_REVIEW_QUEUE: DurableObjectNamespace;
      MAINTENANCE: DurableObjectNamespace;
      PROOF_NONCE: string;
    },
  ) {
    if (request.headers.get("x-proof-nonce") !== env.PROOF_NONCE)
      return new Response("forbidden", { status: 403 });
    if (new URL(request.url).pathname === "/ready") return Response.json({ ready: true });
    try {
      const maintenance = new URL(request.url).pathname.match(/^\/maintenance\/([^/]+)(\/.*)$/);
      if (maintenance) {
        const url = new URL(request.url);
        url.pathname = maintenance[2];
        const body = await request.arrayBuffer();
        return await env.MAINTENANCE.get(env.MAINTENANCE.idFromName(maintenance[1])).fetch(
          new Request(url, { method: request.method, headers: request.headers, body }),
        );
      }
      if (new URL(request.url).pathname.startsWith("/queue/")) {
        const url = new URL(request.url);
        url.pathname = url.pathname.slice("/queue".length);
        const body = await request.arrayBuffer();
        return await env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(
          new Request(url, { method: request.method, headers: request.headers, body }),
        );
      }
      return await env.READ_MODEL.get(
        env.READ_MODEL.idFromName(new URL(request.url).pathname === "/hot" ? "hot" : "fixture"),
      ).fetch(request);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
