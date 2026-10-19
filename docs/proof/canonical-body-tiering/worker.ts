// Local Workerd fixture. No route is deployed or allowed to fetch externally.
import { DurableObject } from "cloudflare:workers";
import { ExactReviewQueue } from "../../../dashboard/exact-review-queue.ts";
import {
  ExactReviewDirectPublicationStore,
  validateDirectPublicationPlan,
  validateCanonicalRecordTupleMutation,
  sha256Hex,
} from "../../../dashboard/exact-review-direct-publication.ts";
import { ExactReviewPublicationBatchStore } from "../../../dashboard/exact-review-publication-batches.ts";
const repo = "example-project",
  deployment = "a".repeat(40);
const gates = {
  operator: "synthetic-operator",
  rollbackFloor: {
    sha: "a".repeat(40),
    supportsFormats: [1, 2] as const,
    proof: "controlled candidate restart reads and writes both storage formats",
  },
  bucketLifecycle: {
    bucketIdentity: "clawsweeper-state-snapshots",
    observedAt: "2026-10-16T00:00:00Z",
    rulesJson: '{"rules":[]}',
    canonicalBodiesDoNotExpire: true as const,
  },
};
function base64(value: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export class Queue extends DurableObject {
  queue: any;
  records: any;
  failR2 = false;
  fault: string | null = null;
  faultKey = "";
  retained: any = null;
  batches: any;
  bucket: any;
  deployment: string;
  r2 = { delayMs: 0, failAt: 0, calls: 0, active: 0, peak: 0, failed: false, putsAfterFailure: 0 };
  r2Started: (() => void) | null = null;
  constructor(ctx: any, env: any) {
    super(ctx, env);
    this.deployment = env.PROOF_DEPLOYMENT_SHA || deployment;
    const bucket = {
      put: async (...args: any[]) => {
        const finish = await this.beginR2("put");
        try {
          return await env.STATE_SNAPSHOTS.put(...args);
        } finally {
          finish();
        }
      },
      get: async (...args: any[]) => {
        const finish = await this.beginR2("get");
        try {
          const result = await env.STATE_SNAPSHOTS.get(...args);
          this.injectFault();
          if (!result?.body) {
            finish();
            return result;
          }
          const reader = result.body.getReader();
          return {
            size: result.size,
            body: new ReadableStream({
              async pull(controller) {
                try {
                  const chunk = await reader.read();
                  if (chunk.done) {
                    finish();
                    reader.releaseLock();
                    controller.close();
                  } else controller.enqueue(chunk.value);
                } catch (error) {
                  finish();
                  controller.error(error);
                }
              },
              async cancel(reason) {
                try {
                  await reader.cancel(reason);
                } finally {
                  finish();
                  reader.releaseLock();
                }
              },
            }),
          };
        } catch (error) {
          finish();
          throw error;
        }
      },
      head: (...args: any[]) => env.STATE_SNAPSHOTS.head(...args),
      delete: (...args: any[]) => env.STATE_SNAPSHOTS.delete(...args),
      createMultipartUpload: (...args: any[]) => env.STATE_SNAPSHOTS.createMultipartUpload(...args),
    };
    this.bucket = bucket;
    this.queue = new ExactReviewQueue(ctx, {
      ...env,
      STATE_SNAPSHOTS: bucket,
      CLAWSWEEPER_DEPLOY_SHA: this.deployment,
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    });
    this.records = new ExactReviewDirectPublicationStore(ctx.storage, bucket);
    this.batches = new ExactReviewPublicationBatchStore(ctx.storage);
  }
  async beginR2(kind: "put" | "get") {
    if (this.failR2) throw Error("synthetic R2 outage");
    const metrics = this.r2,
      call = ++metrics.calls;
    if (metrics.failed && kind === "put") metrics.putsAfterFailure++;
    metrics.active++;
    metrics.peak = Math.max(metrics.peak, metrics.active);
    this.r2Started?.();
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        metrics.active--;
      }
    };
    if (metrics.delayMs) await new Promise((resolve) => setTimeout(resolve, metrics.delayMs));
    if (metrics.failAt === call) {
      metrics.failed = true;
      finish();
      throw Error("synthetic operation failure");
    }
    return finish;
  }
  async alarm() {
    await this.ctx.storage.deleteAlarm();
  }
  injectFault() {
    const fault = this.fault;
    if (!fault) return;
    this.fault = null;
    const sql = this.ctx.storage.sql;
    if (fault === "cancel")
      sql.exec("DELETE FROM exact_review_queue_items WHERE item_key=?", this.faultKey);
    else if (fault === "expire")
      sql.exec(
        "UPDATE exact_review_queue_items SET item_json=json_set(item_json,'$.leaseExpiresAt',?) WHERE item_key=?",
        Date.now() - 1,
        this.faultKey,
      );
    else if (fault === "generation")
      sql.exec(
        "UPDATE exact_review_queue_items SET item_json=json_set(item_json,'$.claimGeneration',99) WHERE item_key=?",
        this.faultKey,
      );
    else if (fault === "batch-replace")
      sql.exec(
        "UPDATE exact_review_publication_batches SET lease_owner='replacement-worker' WHERE state='leased'",
      );
    else if (fault === "batch")
      sql.exec(
        "UPDATE exact_review_publication_batches SET lease_expires_at=? WHERE state='leased'",
        Date.now() - 1,
      );
  }
  async initialize() {
    await this.queue.fetch(new Request("http://queue/admission-capabilities", { method: "POST" }));
  }
  async publication(
    id: number,
    content: string,
    revision = 1,
    owner: any = undefined,
    kind = "policy_noop",
  ) {
    const key = `example/project#${id}`;
    return {
      canonicalTargetKey: key,
      fenceKey: key,
      revision,
      sourceSha: "b".repeat(40),
      ...(owner ? { owner } : {}),
      identity: { canonicalTargetKey: key, fenceKey: key, revision, claimGeneration: 1 },
      lifecycle: { kind },
      operations: [
        {
          path: `records/${repo}/items/${id}.md`,
          deleted: false,
          mode: "100644",
          bytes: new TextEncoder().encode(content).byteLength,
          contentBase64: base64(content),
        },
      ],
      totalBytes: new TextEncoder().encode(content).byteLength,
    };
  }
  async lease(id: number, batch = false) {
    const key = `example/project#${id}`,
      now = Date.now();
    const decision = {
      targetRepo: "example/project",
      targetBranch: "main",
      itemNumber: id,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "opened",
      supersedesInProgress: false,
    };
    const item = {
      key,
      decision,
      leaseDecision: { ...decision },
      state: "leased",
      revision: 1,
      createdAt: now - 60000,
      updatedAt: now - 60000,
      nextAttemptAt: now - 60000,
      attempts: 0,
      leaseId: `lease-${id}`,
      leaseRevision: 1,
      leaseExpiresAt: now + 3600000,
      claimedRunId: String(1000 + id),
      claimedRunAttempt: 1,
      claimGeneration: 1,
      claimProtocolVersion: 2,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO exact_review_queue_items(item_key,item_json) VALUES(?,?) ON CONFLICT(item_key) DO UPDATE SET item_json=excluded.item_json",
      key,
      JSON.stringify(item),
    );
    if (!batch) return { leaseId: item.leaseId, runId: item.claimedRunId, runAttempt: 1 };
    const batchId = `batch-${id}`,
      leaseOwner = `worker-${id}`;
    this.batches.claim({
      batchId,
      leaseOwner,
      leaseExpiresAt: now + 3600000,
      now,
      maxItems: 1,
      maxConcurrentBatches: 20,
      runner: { runId: item.claimedRunId, runAttempt: 1, startedAt: now },
      candidates: [{ itemKey: key, revision: 1 }],
    });
    return { batchId, leaseOwner, runId: item.claimedRunId, runAttempt: 1 };
  }
  profiledRecords(observed: any[]) {
    const sql = this.ctx.storage.sql;
    return new ExactReviewDirectPublicationStore(
      {
        sql: {
          exec: (query: string, ...bindings: any[]) => {
            const cursor = sql.exec(query, ...bindings),
              rows = [...cursor];
            if (/^\s*(SELECT|WITH)/i.test(query))
              observed.push({
                query,
                rowsRead: cursor.rowsRead,
                tuple: query.includes("body_format") && query.includes("ORDER BY section"),
                plan: [...sql.exec("EXPLAIN QUERY PLAN " + query, ...bindings)].map(
                  (row: any) => row.detail,
                ),
              });
            return rows;
          },
        },
        transactionSync: (callback: any) => this.ctx.storage.transactionSync(callback),
        kv: this.ctx.storage.kv,
      } as any,
      this.bucket,
    );
  }
  async fetch(request: Request) {
    const incoming = new URL(request.url);
    if (incoming.pathname.startsWith("/internal/state/")) {
      incoming.pathname = incoming.pathname.slice("/internal/state".length);
      return this.queue.fetch(new Request(incoming, request));
    }
    const route = incoming.pathname;
    const body = request.method === "POST" ? ((await request.json()) as any) : {};
    if (route === "/r2-controls") {
      if (this.r2.active) throw Error("R2 still active");
      this.r2 = {
        delayMs: body.delayMs ?? 0,
        failAt: body.failAt ?? 0,
        calls: 0,
        active: 0,
        peak: 0,
        failed: false,
        putsAfterFailure: 0,
      };
      return Response.json(this.r2);
    }
    if (route === "/r2-metrics") return Response.json(this.r2);
    if (route === "/warm-throughput") {
      for (const content of [
        "shared plan",
        ...Array.from({ length: 24 }, (_, i) => `body-${i + 1}`),
      ]) {
        const bytes = new TextEncoder().encode(content);
        const digest = await sha256Hex(bytes);
        await this.env.STATE_SNAPSHOTS.put("records/bodies/v1/sha256/" + digest, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
        });
      }
      return Response.json({ objects: 25 });
    }
    if (route === "/seed-throughput") {
      await this.initialize();
      for (let id = 1; id <= 24; id++) {
        const mutation = await validateCanonicalRecordTupleMutation({
          deliveryId: `throughput-${id}`,
          key: `${repo}/${id}`,
          operations: ["items", "closed", "plans", "decision-packets"].map((section) => ({
            path: `records/${repo}/${section}/${id}.${section === "decision-packets" ? "json" : "md"}`,
            expectedDigest: null,
            ...(["items", "plans"].includes(section)
              ? { contentBase64: base64(section === "plans" ? "shared plan" : `body-${id}`) }
              : {}),
          })),
        });
        this.records.acceptCanonicalTupleMutation(mutation, 1792108800000);
      }
      return Response.json({ ok: true });
    }
    if (route === "/seed") {
      await this.initialize();
      const cases = ["", "snow 雪🦊\0", "x".repeat(1572865), "z".repeat(2097152)];
      for (let i = 0; i < cases.length; i++)
        this.records.accept(
          await validateDirectPublicationPlan(await this.publication(i + 1, cases[i]!)),
          Date.now(),
        );
      const packet = '{ "decision": "preserve every byte" }',
        digest = await sha256Hex(new TextEncoder().encode(packet));
      const primary = `---\ntype: pull_request\nreview_status: complete\nreviewed_at: 2026-10-15T00:00:00Z\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\nrepository: example/project\nlabels: []\ndecision_packet_path: records/${repo}/decision-packets/5.json\ndecision_packet_sha256: ${digest}\n---\nreview\n`;
      const mutation = await validateCanonicalRecordTupleMutation({
        deliveryId: "record-reconcile:example-project:5:fixture",
        key: repo + "/5",
        operations: [
          {
            path: `records/${repo}/items/5.md`,
            expectedDigest: null,
            contentBase64: base64(primary),
          },
          { path: `records/${repo}/closed/5.md`, expectedDigest: null },
          {
            path: `records/${repo}/plans/5.md`,
            expectedDigest: null,
            contentBase64: base64("work plan 雪"),
          },
          {
            path: `records/${repo}/decision-packets/5.json`,
            expectedDigest: null,
            contentBase64: base64(packet),
          },
        ],
      });
      this.records.acceptCanonicalTupleMutation(mutation, Date.now());
      const completed =
        "---\ntype: pull_request\nreview_status: complete\nreviewed_at: 2026-10-15T00:00:00Z\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\nrepository: example/project\nlabels: []\n---\nreview";
      for (let i = 6; i < Number(body.count ?? 6); i++)
        this.records.accept(
          await validateDirectPublicationPlan(
            await this.publication(
              i,
              i < 10
                ? "q".repeat(2097152)
                : i < 12
                  ? completed
                  : i === 12
                    ? "---\n\0\n" + completed.slice(4)
                    : "small " + i,
              1,
              undefined,
              i === 11 ? "requeue" : "guarded_open",
            ),
          ),
          Date.now(),
        );
      if (body.mixed) {
        const content = "backfill-only plan 雪🦊",
          now = Date.now(),
          digest = await sha256Hex(new TextEncoder().encode(content)),
          sql = this.ctx.storage.sql;
        sql.exec(
          "INSERT INTO exact_review_record_backfill (repo_slug,section,record_id,content,digest,byte_length,chunk_count,updated_at) VALUES (?, 'plans', '1', ?, ?, ?, 0, ?)",
          repo,
          content,
          digest,
          new TextEncoder().encode(content).byteLength,
          now,
        );
        sql.exec(
          "UPDATE exact_review_record_export_meta SET current_revision=current_revision+1 WHERE singleton_id=1",
        );
        sql.exec(
          "INSERT INTO exact_review_record_export_index (repo_slug,section,record_id,digest,deleted,revision,store_revision,source,updated_at) VALUES (?, 'plans', '1', ?, 0, 1, ?, 'backfill', ?)",
          repo,
          digest,
          this.records.currentExportRevision(),
          now,
        );
      }
      this.ctx.storage.kv.put("fixture-count", body.count ?? 6);
      return Response.json({ ok: true });
    }
    if (route === "/facts") {
      const fleets = new Map();
      let cursor = null;
      do {
        cursor = this.records.reviewCoverageScanPageSync(
          fleets,
          cursor,
          200,
          Date.parse("2026-10-16T00:00:00Z"),
        );
      } while (cursor);
      return Response.json({
        coverage: [...fleets],
        ...(body.answers
          ? {
              fresh: this.records.hasCompletedPullRequestReview(repo, 10),
              stale: this.records.hasCompletedPullRequestReview(repo, 11),
            }
          : {}),
      });
    }
    if (route === "/warm-write") {
      // Initialize legacy reconciliation before inserting the synthetic active
      // lease, matching a real warm request rather than an unready cold owner.
      await this.initialize();
      const store = this.queue.directPublicationStore,
        prepare = store.prepareCanonicalWrites.bind(store);
      let intercepted = false;
      store.prepareCanonicalWrites = async (operations: any) => {
        const prepared = await prepare(operations);
        if (!intercepted) {
          intercepted = true;
          await this.queue.fetch(
            new Request("http://queue/canonical-bodies/maintenance", {
              method: "POST",
              body: JSON.stringify({
                action: "activate",
                execute: true,
                expectedDeploymentSha: deployment,
                attestation: gates,
                reviewedPreviewSha256: (await store.tieringPreview(deployment, gates)).sha256,
              }),
            }),
          );
        }
        return prepared;
      };
      try {
        const owner = await this.lease(2200),
          plan = await this.publication(2200, "warm format transition", 1, owner);
        const response = await this.queue.fetch(
          new Request("http://queue/publication-results", {
            method: "POST",
            body: JSON.stringify(plan),
          }),
        );
        return Response.json({ status: response.status, result: await response.json() });
      } finally {
        store.prepareCanonicalWrites = prepare;
      }
    }
    if (route === "/profile") {
      const observed: any[] = [],
        records = this.profiledRecords(observed),
        operations = [];
      for (const operation of ["coverage", "listing", "export"]) {
        observed.length = 0;
        const started = performance.now();
        if (operation === "coverage")
          records.reviewCoverageScanPageSync(new Map(), null, 200, Date.now());
        if (operation === "listing")
          records.listCanonical({ repoSlug: repo, section: "items", cursor: 0, limit: 200 });
        if (operation === "export")
          await records.exportRecords({
            repoSlug: repo,
            sections: ["items", "closed", "plans", "decision-packets"],
            sinceRevision: 0,
            cursor: 0,
            limit: 20,
            maxBytes: 8 * 1024 * 1024,
            maxSourceBytes: 8 * 1024 * 1024,
            maxRecords: 20,
          });
        operations.push({
          operation,
          wallMs: performance.now() - started,
          maxRowsRead: Math.max(0, ...observed.map((query) => query.rowsRead)),
          queries: [...observed],
        });
      }
      return Response.json({ operations });
    }
    if (route === "/inspect") {
      const sql = this.ctx.storage.sql,
        exists = (name: string) =>
          [...sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name)].length;
      return Response.json({
        version: [...sql.exec("SELECT schema_version FROM exact_review_queue_meta")][0]
          .schema_version,
        v1: [...sql.exec("SELECT COUNT(*) AS n FROM exact_review_canonical_records")][0].n,
        chunks: [...sql.exec("SELECT COUNT(*) AS n FROM exact_review_canonical_record_chunks")][0]
          .n,
        v2: exists("exact_review_canonical_records_v2")
          ? [...sql.exec("SELECT COUNT(*) AS n FROM exact_review_canonical_records_v2")][0].n
          : 0,
        databaseBytes: sql.databaseSize,
        watermark: this.records.currentExportRevision(),
        receipts: this.records.list(),
        checkpoint: exists("exact_review_canonical_body_tiering")
          ? this.records.tieringStatusSync()
          : null,
        bodies: (await this.env.STATE_SNAPSHOTS.list({ prefix: "records/bodies/v1/" })).objects
          .length,
      });
    }
    if (route === "/maintenance") {
      const observed: any[] = [],
        original = this.queue.directPublicationStore;
      if (body.action === "migrate")
        this.queue.directPublicationStore = this.profiledRecords(observed);
      try {
        const response = await this.queue.fetch(
          new Request("http://queue/canonical-bodies/maintenance", {
            method: "POST",
            body: JSON.stringify({
              expectedDeploymentSha: this.deployment,
              attestation: {
                ...gates,
                rollbackFloor: { ...gates.rollbackFloor, sha: this.deployment },
              },
              ...body,
            }),
          }),
        );
        if (body.action !== "migrate") return response;
        const tuples = observed.filter((query) => query.tuple);
        return Response.json(
          {
            ...((await response.json()) as any),
            migrationSql: {
              maxRowsRead: Math.max(0, ...observed.map((query) => query.rowsRead)),
              maxRecordRowsRead: Math.max(
                0,
                ...observed
                  .filter((query) => !query.query.includes("sqlite_master"))
                  .map((query) => query.rowsRead),
              ),
              maxSchemaRowsRead: Math.max(
                0,
                ...observed
                  .filter((query) => query.query.includes("sqlite_master"))
                  .map((query) => query.rowsRead),
              ),
              maxTupleRowsRead: Math.max(0, ...tuples.map((query) => query.rowsRead)),
              tupleQueries: tuples.length,
              tuplePlans: [...new Set(tuples.flatMap((query) => query.plan))],
            },
          },
          { status: response.status },
        );
      } finally {
        this.queue.directPublicationStore = original;
      }
    }
    if (route === "/backfill-facts")
      return Response.json({
        rows: [
          ...this.ctx.storage.sql.exec(
            "SELECT * FROM exact_review_record_backfill ORDER BY section,record_id",
          ),
        ],
        pointers: [
          ...this.ctx.storage.sql.exec(
            "SELECT * FROM exact_review_record_export_index WHERE source='backfill' ORDER BY section,record_id",
          ),
        ],
      });
    if (route === "/prepare") {
      this.retained = await this.records.prepareTieringPass();
      return Response.json({
        ok: true,
        bytes: this.retained.bytes,
        scanned: this.retained.scanned,
        tuples: this.retained.tuples.length,
      });
    }
    if (route === "/prepare-failure") {
      try {
        await this.records.prepareTieringPass();
        return Response.json({ failed: false });
      } catch {
        return Response.json({ failed: true, metrics: this.r2 });
      }
    }
    if (route === "/prepare-interleave") {
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      this.r2Started = started;
      const preparing = this.records.prepareTieringPass();
      await entered;
      this.r2Started = null;
      const owner = await this.lease(4);
      const published = await this.queue.fetch(
        new Request("http://queue/publication-results", {
          method: "POST",
          body: JSON.stringify(await this.publication(4, "foreground replacement", 1, owner)),
        }),
      );
      const pass = await preparing;
      return Response.json({
        publicationStatus: published.status,
        captured: pass.tuples[3]?.bodies.get("items"),
        checkpoint: this.records.commitTieringPassSync(pass, Date.now()),
      });
    }
    if (route === "/commit")
      return Response.json({
        checkpoint: this.records.commitTieringPassSync(this.retained, Date.now()),
      });
    if (route === "/publish") {
      await this.initialize();
      const owner = await this.lease(body.id, body.batch === true),
        plan = await this.publication(body.id, body.content ?? "authorized body", 1, owner);
      this.fault = body.fault ?? null;
      this.faultKey = plan.fenceKey;
      const response = await this.queue.fetch(
        new Request(
          "http://queue/" + (body.batch ? "publication-batch-results" : "publication-results"),
          { method: "POST", body: JSON.stringify(plan) },
        ),
      );
      return Response.json({
        status: response.status,
        result: await response.json(),
        key: plan.fenceKey,
      });
    }
    if (route === "/retry") {
      this.failR2 = body.failR2 === true;
      const id = body.id,
        owner = body.batch
          ? {
              batchId: `batch-${id}`,
              leaseOwner: `worker-${id}`,
              runId: String(1000 + id),
              runAttempt: 1,
            }
          : { leaseId: `lease-${id}`, runId: String(1000 + id), runAttempt: 1 };
      const plan = await this.publication(id, body.content ?? "authorized body", 1, owner);
      const response = await this.queue.fetch(
        new Request(
          "http://queue/" + (body.batch ? "publication-batch-results" : "publication-results"),
          { method: "POST", body: JSON.stringify(plan) },
        ),
      );
      return Response.json({ status: response.status, result: await response.json() });
    }
    if (route === "/corrupt") {
      const sql = this.ctx.storage.sql;
      const [row] = [
        ...sql.exec(
          "SELECT digest FROM exact_review_canonical_records_v2 WHERE repo_slug=? AND section='items' AND item_id=?",
          repo,
          body.id,
        ),
      ];
      const key = "records/bodies/v1/sha256/" + row.digest;
      if (body.missing) await this.env.STATE_SNAPSHOTS.delete(key);
      else
        await this.env.STATE_SNAPSHOTS.put(
          key,
          body.sameSize
            ? new Uint8Array(Number((await this.env.STATE_SNAPSHOTS.get(key)).size)).fill(1)
            : "corrupt",
        );
      return Response.json({ ok: true });
    }
    if (route === "/snapshot-bytes") {
      const [snapshot] = [
        ...this.ctx.storage.sql.exec(
          "SELECT object_key FROM exact_review_record_snapshots ORDER BY snapshot_id DESC LIMIT 1",
        ),
      ];
      const object = await this.env.STATE_SNAPSHOTS.get(snapshot.object_key);
      return new Response(object.body);
    }
    if (route === "/point")
      return this.queue.fetch(new Request(`http://queue/records/${repo}/items/${body.id ?? 1}`));
    if (route === "/export")
      return this.queue.fetch(
        new Request("http://queue/records/export", {
          method: "POST",
          body: JSON.stringify({ repoSlug: repo, ...body }),
        }),
      );
    if (route === "/snapshot")
      return this.queue.fetch(
        new Request("http://queue/records/snapshots/trigger", {
          method: "POST",
          body: JSON.stringify({ repoSlug: repo }),
        }),
      );
    return new Response("not found", { status: 404 });
  }
}
export default {
  fetch(request: Request, env: any) {
    const url = new URL(request.url),
      [, object, ...parts] = url.pathname.split("/");
    url.pathname = "/" + parts.join("/");
    return env.QUEUE.get(env.QUEUE.idFromName(object)).fetch(new Request(url, request));
  },
};
