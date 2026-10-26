// Local-only synthetic seed/inspection routes. Never deploy this fixture.
import { DurableObject } from "cloudflare:workers";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";
import { decodeStoredJson, STORED_JSON_PLACEHOLDER } from "../../../dashboard/stored-json.ts";

const tables = ["items", "comments", "activity", "workflows"].map((kind) => [
  `github_webhook_read_model_${kind}_v1`,
  "snapshot_json",
]);
tables.push(["exact_review_lifecycle_projection_v1", "projection_json"]);
let outbound = 0;
globalThis.fetch = async () => {
  outbound++;
  throw new Error("outbound prohibited");
};
const repository = "example/project",
  deploymentSha = "a".repeat(40);
const now = 1_800_000_000_000;

export class Queue extends DurableObject {
  private queue;
  private queries: { query: string; bindings: unknown[]; cursor: any }[] = [];
  constructor(ctx, env) {
    super(ctx, env);
    const sql = new Proxy(ctx.storage.sql, {
      get: (target, key) =>
        key === "exec"
          ? (query, ...bindings) => {
              const cursor = target.exec(query, ...bindings);
              this.queries.push({ query, bindings, cursor });
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
    this.queue = new ProductionQueue(state, {
      ...env,
      CLAWSWEEPER_DEPLOY_SHA: deploymentSha,
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    });
  }
  async alarm() {
    await this.ctx.storage.deleteAlarm();
  }
  async fetch(request: Request) {
    const route = new URL(request.url).pathname;
    if (route === "/__proof/seed") {
      await this.queue.fetch(
        new Request("https://queue/admission-capabilities", { method: "POST" }),
      );
      const objects: any[] = [];
      const sourceUpdatedAt = new Date(now).toISOString();
      for (let n = 1; n <= 128; n++) {
        objects.push({
          kind: "item",
          repository,
          number: n,
          itemKind: "issue",
          sourceUpdatedAt,
          snapshot: { number: n, state: "open", comments: 1, body: "雪🦊".repeat(2048) },
        });
        objects.push({
          kind: "comment",
          repository,
          number: n,
          id: n,
          sourceUpdatedAt,
          tombstone: false,
          snapshot: {
            id: n,
            body: `${STORED_JSON_PLACEHOLDER}\n${"placeholder evidence ".repeat(1000)}`,
          },
        });
        objects.push({
          kind: "review",
          repository,
          number: n,
          id: n,
          sourceUpdatedAt,
          tombstone: false,
          snapshot: { id: n, body: "review evidence ".repeat(1000) },
        });
        objects.push({
          kind: "workflow_run",
          repository,
          id: n,
          runId: n,
          sourceUpdatedAt,
          snapshot: { id: n, name: "workflow ".repeat(1000), status: "completed" },
        });
      }
      objects.push({ ...objects[1], id: 900, tombstone: true, snapshot: { id: 900, body: null } });
      const response = await this.queue.fetch(
        new Request("https://queue/github-read-model/ingest", {
          method: "POST",
          body: JSON.stringify({
            version: 1,
            deliveryId: "seed",
            event: "issue_comment",
            action: "created",
            receivedAt: sourceUpdatedAt,
            eventClasses: ["issues", "issue_comments", "pull_request_reviews", "workflow_runs"],
            objects,
          }),
        }),
      );
      if (response.status !== 202) throw new Error(`seed rejected ${response.status}`);
      const lifecycle = (this.queue as any).lifecycleProjectionStore;
      for (let revision = 1; revision <= 16; revision++) {
        const identity = {
          canonicalTargetKey: `${repository}#1`,
          fenceKey: `${repository}#1`,
          revision,
        };
        lifecycle.recordAdmission({
          ...identity,
          deliveryId: `admit:${revision}`,
          sourceAction: "created",
          commandOriginated: true,
          statusMarker: `marker:${revision}`,
          statusCommentId: revision,
          observedAt: now,
        });
        lifecycle.recordTerminalDisposition({
          ...identity,
          kind: "policy_noop",
          operationId: `terminal:${revision}`,
          observedAt: now + 1,
        });
        const row = [
          ...this.ctx.storage.sql.exec(
            "SELECT projection_json FROM exact_review_lifecycle_projection_v1 WHERE revision=?",
            revision,
          ),
        ][0];
        const raw =
          JSON.stringify(
            {
              ...JSON.parse(String(row.projection_json)),
              inlineProof: { old: "preserved legacy field ".repeat(1000) },
            },
            null,
            2,
          ) + "\n";
        this.ctx.storage.sql.exec(
          "UPDATE exact_review_lifecycle_projection_v1 SET projection_json=? WHERE revision=?",
          raw,
          revision,
        );
      }
      return Response.json({ ok: true });
    }
    if (route === "/__proof/inspect") {
      const started = Date.now();
      let storedBytes = 0,
        decodedBytes = 0,
        encoded = 0;
      const all = [];
      for (const [table, column] of tables) {
        const rows = [...this.ctx.storage.sql.exec(`SELECT rowid,* FROM ${table} ORDER BY rowid`)];
        all.push(
          rows.map((row) => {
            const raw = String(row[column]),
              decoded = decodeStoredJson(raw);
            storedBytes += new TextEncoder().encode(raw).length;
            decodedBytes += new TextEncoder().encode(decoded).length;
            if (raw.startsWith("!cs-json:")) encoded++;
            return { ...row, [column]: decoded };
          }),
        );
      }
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(all)),
      );
      return Response.json({
        storedBytes,
        decodedBytes,
        encoded,
        rows: all.reduce((n, rows) => n + rows.length, 0),
        digest: [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join(""),
        databaseBytes: this.ctx.storage.sql.databaseSize,
        decodeMs: Date.now() - started,
        outbound,
        markers: [
          ...this.ctx.storage.sql.exec(
            "SELECT COUNT(*) AS count FROM github_webhook_read_model_comments_v1 WHERE tombstone=0 AND instr(snapshot_json,?)>0",
            STORED_JSON_PLACEHOLDER,
          ),
        ][0].count,
      });
    }
    if (route === "/__proof/probe") {
      const { number } = (await request.json()) as { number: number };
      const response = await this.queue.fetch(
        new Request("https://queue/github-read-model/ingest", {
          method: "POST",
          body: JSON.stringify({
            version: 1,
            deliveryId: `probe:${number}`,
            event: "issues",
            action: "opened",
            receivedAt: new Date(now).toISOString(),
            eventClasses: ["issues"],
            objects: [
              {
                kind: "item",
                repository,
                number,
                itemKind: "issue",
                sourceUpdatedAt: new Date(now).toISOString(),
                snapshot: { body: "probe ".repeat(1000) },
              },
            ],
          }),
        }),
      );
      if (response.status !== 202) throw new Error("probe rejected");
      return Response.json({
        encoded: String(
          [
            ...this.ctx.storage.sql.exec(
              "SELECT snapshot_json FROM github_webhook_read_model_items_v1 WHERE number=?",
              number,
            ),
          ][0].snapshot_json,
        ).startsWith("!cs-json:"),
      });
    }
    if (route === "/__proof/read") {
      const store = (this.queue as any).githubWebhookReadModelStore;
      return Response.json({
        item: await store.readItem({ repository, number: 1 }, now),
        comments: await store.readComments({ repository, number: 1 }, now),
        activity: await store.readActivity({ repository, number: 1 }, now),
        placeholders: await store.readPlaceholders({ repository, state: "open" }, now),
      });
    }
    if (route === "/__proof/retain") {
      const store = (this.queue as any).githubWebhookReadModelStore;
      return Response.json(
        this.ctx.storage.transactionSync(() => store.prunePayloadsSync(now + 31 * 60_000)),
      );
    }
    if (route === "/__proof/ack") {
      const lifecycle = (this.queue as any).lifecycleProjectionStore;
      const identity = {
        canonicalTargetKey: `${repository}#1`,
        fenceKey: `${repository}#1`,
        revision: 16,
      };
      const result = lifecycle.authorizeCommandAcknowledgement({
        ...identity,
        statusMarker: "marker:16",
        statusCommentId: 16,
        observedAt: now + 2,
      });
      const observed = lifecycle.observeCommandAcknowledgement({
        ...identity,
        statusMarker: "marker:16",
        statusCommentId: 16,
        commandCommentId: 100,
        completionCommentId: 16,
        requireExactStatusComment: true,
        observedAt: now + 3,
      });
      return Response.json({
        allowed: result.allowed,
        observed,
        projection: lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, 16),
      });
    }
    this.queries = [];
    const started = Date.now();
    const response = await this.queue.fetch(request);
    const headers = new Headers(response.headers);
    headers.set(
      "x-proof-rows-read",
      String(this.queries.reduce((n, { cursor }) => n + cursor.rowsRead, 0)),
    );
    headers.set(
      "x-proof-max-query-rows-read",
      String(Math.max(0, ...this.queries.map(({ cursor }) => cursor.rowsRead))),
    );
    headers.set("x-proof-ms", String(Date.now() - started));
    return new Response(response.body, { status: response.status, headers });
  }
}

export default {
  fetch(request, env) {
    return env.QUEUE.get(env.QUEUE.idFromName("fixture")).fetch(request);
  },
};
