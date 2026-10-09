// Local proof only. Never deploy: fixture routes seed synthetic SQLite rows.
import application, { StatusStore } from "../../../dashboard/worker.ts";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";
export { StatusStore };
globalThis.fetch = async () => { throw new Error("proof forbids outbound fetch"); };

export class ExactReviewQueue {
  constructor(state, env) {
    this.state = state;
    this.queue = new ProductionQueue(state, {
      ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public",
    });
  }
  async alarm() { await this.state.storage.deleteAlarm(); }
  async fetch(request) {
    if (new URL(request.url).pathname !== "/__proof/seed") return this.queue.fetch(request);
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
  fetch(request, env, context) {
    if (new URL(request.url).pathname === "/__proof/ready") return Response.json({ nonce: env.PROOF_NONCE });
    if (new URL(request.url).pathname === "/__proof/seed")
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    return application.fetch(request, env, context);
  },
};
