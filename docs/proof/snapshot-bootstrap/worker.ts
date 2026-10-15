// Local proof only. Never deploy: fixture routes seed synthetic SQLite rows.
import application, { StatusStore } from "../../../dashboard/worker.ts";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";
export { StatusStore };
globalThis.fetch = async () => { throw new Error("proof forbids outbound fetch"); };

export class ExactReviewQueue {
  constructor(state, env) {
    this.state = state;
    this.ranges = [];
    const bucket = env.STATE_SNAPSHOTS;
    this.bucket = bucket;
    this.deleteAfterRange = false;
    this.queue = new ProductionQueue(state, {
      ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public",
      STATE_SNAPSHOTS: {
        createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
        head: bucket.head.bind(bucket),
        delete: bucket.delete.bind(bucket),
        get: () => { throw new Error("snapshot payload entered the queue object"); },
      },
    });
  }
  async alarm() { await this.state.storage.deleteAlarm(); }
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__proof/ranges") return Response.json(this.ranges);
    if (pathname === "/__proof/arm-delete") {
      this.deleteAfterRange = true;
      return Response.json({ armed: true });
    }
    if (pathname === "/records/snapshots/chunk") throw new Error("retired queue chunk route used");
    if (pathname === "/records/snapshots/range") {
      const response = await this.queue.fetch(request);
      this.ranges.push({ status: response.status, bytes: (await response.clone().text()).length });
      if (this.deleteAfterRange && response.ok) {
        this.deleteAfterRange = false;
        const { snapshot } = await response.clone().json();
        await this.bucket.delete(snapshot.objectKey);
      }
      return response;
    }
    if (pathname !== "/__proof/seed") return this.queue.fetch(request);
    await this.queue.fetch(new Request("https://queue/records/export", {
      method: "POST", body: JSON.stringify({ repoSlug: "fixture-repo" }),
    }));
    const rows = await request.json();
    this.state.storage.transactionSync(() => {
      for (const { id, content, digest } of rows) {
        this.state.storage.sql.exec(`INSERT INTO exact_review_canonical_records
          (repo_slug, section, item_id, content, digest, byte_length, chunk_count, deleted,
           revision, item_key, claim_generation, updated_at)
          VALUES ('fixture-repo', 'items', ?, ?, ?, ?, 0, 0, 1, ?, 1, ?)`,
          id, content, digest, new TextEncoder().encode(content).length, `fixture-repo#${id}`, id);
        this.state.storage.sql.exec(`INSERT INTO exact_review_record_export_index
          (repo_slug, section, record_id, digest, deleted, revision, store_revision, source, updated_at)
          VALUES ('fixture-repo', 'items', ?, ?, 0, 1, ?, 'canonical', ?)`, String(id), digest, id, id);
        this.state.storage.sql.exec(`UPDATE exact_review_record_export_meta
          SET current_revision = MAX(current_revision, ?) WHERE singleton_id = 1`, id);
      }
    });
    return Response.json({ seeded: rows.length });
  }
}

export default {
  async fetch(request, env, context) {
    if (new URL(request.url).pathname === "/__proof/ready") return Response.json({ nonce: env.PROOF_NONCE });
    if (["/__proof/seed", "/__proof/ranges", "/__proof/arm-delete"].includes(new URL(request.url).pathname))
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    const response = await application.fetch(request, env, context);
    if (new URL(request.url).pathname.endsWith("/snapshots/latest") && response.ok) {
      const value = await response.json();
      if (value.snapshot) value.snapshot.access.maxChunkBytes = 1024;
      return Response.json(value);
    }
    return response;
  },
};
