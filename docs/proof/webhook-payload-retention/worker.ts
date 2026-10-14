import { DurableObject } from "cloudflare:workers";
import {
  GithubWebhookReadModelStore,
  GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
} from "../../../dashboard/github-webhook-read-model.ts";

globalThis.fetch = async () => {
  throw new Error("proof forbids outbound requests");
};
const repository = "example/project";

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
      const pruned = storage.transactionSync(() => store.prunePayloadsSync(now));
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
      const pruned = this.ctx.storage.transactionSync(() => store.prunePayloadsSync(now));
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
  async fetch(request: Request, env: { READ_MODEL: DurableObjectNamespace; PROOF_NONCE: string }) {
    if (request.headers.get("x-proof-nonce") !== env.PROOF_NONCE)
      return new Response("forbidden", { status: 403 });
    if (new URL(request.url).pathname === "/ready") return Response.json({ ready: true });
    try {
      return await env.READ_MODEL.get(
        env.READ_MODEL.idFromName(new URL(request.url).pathname === "/hot" ? "hot" : "fixture"),
      ).fetch(request);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
