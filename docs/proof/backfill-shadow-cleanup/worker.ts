// Local proof only. Never deploy: fixture routes seed synthetic SQLite state.
import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";
import { validateDirectPublicationPlan } from "../../../dashboard/exact-review-direct-publication.ts";

const cleanupKey = "record-backfill-shadow-cleanup:v1";
const metrics = new AsyncLocalStorage<{ rowsRead: number; rowsWritten: number }>();
let outbound = 0;
globalThis.fetch = async () => {
  outbound++;
  throw new Error("proof forbids outbound requests");
};
const digest = async (value: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex",
  );

export class ExactReviewQueue extends DurableObject {
  private queue;
  private failCheckpoint = false;

  constructor(ctx, env) {
    super(ctx, env);
    const sql = {
      exec: (query, ...bindings) => {
        const cursor = ctx.storage.sql.exec(query, ...bindings);
        const measure = metrics.getStore();
        const read = cursor.rowsRead;
        const written = cursor.rowsWritten;
        if (measure) {
          measure.rowsRead += read;
          measure.rowsWritten += written;
        }
        return (function* () {
          try {
            yield* cursor;
          } finally {
            if (measure) {
              measure.rowsRead += cursor.rowsRead - read;
              measure.rowsWritten += cursor.rowsWritten - written;
            }
          }
        })();
      },
    };
    const kv = new Proxy(ctx.storage.kv, {
      get: (target, name) => {
        if (name === "put")
          return (key, value) => {
            if (key === cleanupKey && this.failCheckpoint) {
              this.failCheckpoint = false;
              throw new Error("proof checkpoint failure");
            }
            return target.put(key, value);
          };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const storage = new Proxy(ctx.storage, {
      get(target, name) {
        if (name === "sql") return sql;
        if (name === "kv") return kv;
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const state = new Proxy(ctx, {
      get(target, name) {
        if (name === "storage") return storage;
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.queue = new ProductionQueue(state, {
      ...env,
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    });
  }

  async alarm() {
    if (!this.ctx.storage.kv.get("proof_automatic")) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const before = this.ctx.storage.kv.get(cleanupKey);
    const measured = { rowsRead: 0, rowsWritten: 0 };
    const started = Date.now();
    await metrics.run(measured, () => this.queue.alarm());
    const after = this.ctx.storage.kv.get(cleanupKey);
    const passes = this.ctx.storage.kv.get("proof_passes") ?? [];
    this.ctx.storage.kv.put("proof_passes", [
      ...passes,
      { elapsedMs: Date.now() - started, ...measured, before, after },
    ]);
  }

  async fetch(request: Request) {
    const route = new URL(request.url).pathname;
    if (!route.startsWith("/__proof/")) return this.queue.fetch(request);
    const body = (await request.json()) as any;
    const storage = this.ctx.storage;
    const sql = storage.sql;
    const rows = (query: string, ...bindings: any[]) => Array.from(sql.exec(query, ...bindings));
    const store = (this.queue as any).directPublicationStore;
    if (route === "/__proof/enable") {
      storage.kv.put("proof_automatic", true);
      await storage.setAlarm(Date.now() + 50);
    } else if (route === "/__proof/pause") {
      storage.kv.put("proof_automatic", false);
      await storage.deleteAlarm();
    } else if (route === "/__proof/pass") {
      this.failCheckpoint = Boolean(body.fail);
      try {
        await this.queue.alarm();
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: String(error) });
      }
    } else if (route === "/__proof/seed") {
      const slug = body.slug ?? "example-project";
      const size = body.size ?? 64;
      // Allocate one record at a time. Even the maximum batch never retains
      // its aggregate 128 MiB logical / 171 MiB encoded bodies in JS memory.
      for (let id = body.start; id < body.start + body.count; id++) {
        const content = `canonical ${id}\n`.padEnd(size, "x");
        const plan = await validateDirectPublicationPlan({
          canonicalTargetKey: `${slug.replace("-", "/")}#${id}`,
          fenceKey: `${slug.replace("-", "/")}#${id}`,
          revision: 1,
          identity: {
            canonicalTargetKey: `${slug.replace("-", "/")}#${id}`,
            fenceKey: `${slug.replace("-", "/")}#${id}`,
            revision: 1,
            claimGeneration: 1,
          },
          operations: [
            {
              path: `records/${slug}/items/${id}.md`,
              mode: "100644",
              deleted: false,
              bytes: content.length,
              contentBase64: Buffer.from(content).toString("base64"),
            },
          ],
          totalBytes: content.length,
        });
        store.accept(plan, Date.now());
        const old = "old shadow\n".padEnd(size, "y");
        const chunked = size > 128 || id % 2 === 0;
        const chunkSize = 512 * 1024;
        const count = chunked ? Math.ceil(size / chunkSize) : 0;
        const oldDigest = await digest(old);
        storage.transactionSync(() => {
          sql.exec(
            `INSERT INTO exact_review_record_backfill
            (repo_slug, section, record_id, content, digest, byte_length, chunk_count, updated_at)
            VALUES (?, 'items', ?, ?, ?, ?, ?, ?)`,
            slug,
            String(id),
            chunked ? null : old,
            oldDigest,
            size,
            count,
            Date.now(),
          );
          for (let index = 0; index < count; index++)
            sql.exec(
              "INSERT INTO exact_review_record_backfill_chunks VALUES (?, 'items', ?, ?, ?)",
              slug,
              String(id),
              index,
              Buffer.from(old.slice(index * chunkSize, (index + 1) * chunkSize)).toString("base64"),
            );
        });
      }
    } else if (route === "/__proof/held") {
      // Deliberately unresolved ownership cases are outside the export fixture.
      const source = "held";
      const hash = await digest(source);
      storage.transactionSync(() => {
        for (const [id, section] of [
          ["01", "items"],
          ["missing", "items"],
          ["a".repeat(40), "commits"],
          ["b".repeat(40), "commits"],
        ]) {
          sql.exec(
            "INSERT INTO exact_review_record_backfill VALUES ('held-project', ?, ?, ?, ?, 4, 0, 1)",
            section,
            id,
            source,
            hash,
          );
        }
        sql.exec(
          "UPDATE exact_review_record_export_index SET source = 'backfill' WHERE repo_slug = 'held-project' AND record_id = '1'",
        );
        for (const id of ["a".repeat(40), "b".repeat(40)])
          sql.exec(
            "INSERT INTO exact_review_record_export_index VALUES ('held-project', 'commits', ?, ?, 0, 1, ?, ?, 1)",
            id,
            hash,
            id[0] === "a" ? 900001 : 900002,
            id[0] === "a" ? "canonical" : "backfill",
          );
      });
    } else if (route === "/__proof/sql") {
      // The nonce-gated local fixture supplies exact synthetic mutations only.
      storage.transactionSync(() => {
        for (const statement of body.statements) sql.exec(statement.sql, ...statement.bindings);
      });
    } else if (route === "/__proof/inspect") {
      const metadata = rows(
        "SELECT rowid, repo_slug, section, record_id, digest, byte_length, chunk_count FROM exact_review_record_backfill ORDER BY rowid",
      );
      const protectedTables = [
        "exact_review_canonical_records",
        "exact_review_record_export_index",
        "exact_review_direct_publication_plans",
        "canonical_record_tuple_receipts",
        "exact_review_queue_items",
        "exact_review_queue_deliveries",
        "exact_review_lifecycle_projection_v1",
      ];
      return Response.json({
        outbound,
        state: storage.kv.get(cleanupKey) ?? null,
        passes: storage.kv.get("proof_passes") ?? [],
        nextAlarm: await storage.getAlarm(),
        databaseBytes: sql.databaseSize,
        metadata,
        chunks: rows(
          "SELECT COUNT(*) AS count, COALESCE(SUM(length(content_base64)), 0) AS bytes FROM exact_review_record_backfill_chunks",
        )[0],
        logicalBytes: metadata.reduce((sum, row) => sum + Number(row.byte_length), 0),
        protected: body.full
          ? Object.fromEntries(
              protectedTables.map((table) => [
                table,
                rows(`SELECT * FROM ${table} ORDER BY rowid`),
              ]),
            )
          : null,
      });
    }
    return Response.json({ ok: true, outbound });
  }
}

export default {
  async fetch(request: Request, env) {
    if (request.headers.get("x-proof-nonce") !== env.PROOF_NONCE)
      return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    if (url.pathname === "/ready") return Response.json({ ready: true });
    const [, name, route] = url.pathname.match(/^\/([^/]+)(\/.*)$/) ?? [];
    if (!name) return new Response("missing object", { status: 404 });
    url.pathname = route;
    const body = await request.arrayBuffer();
    try {
      return await env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName(name)).fetch(
        new Request(url, { method: request.method, headers: request.headers, body }),
      );
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
