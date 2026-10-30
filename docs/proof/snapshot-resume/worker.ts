// Local proof only. Never deploy: the fixture route writes synthetic SQLite rows.
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
    if (new URL(request.url).pathname !== "/__proof/write") return this.queue.fetch(request);
    await this.queue.fetch(new Request("https://queue/records/export", {
      method: "POST", body: JSON.stringify({ repoSlug: "fixture-repo" }),
    }));
    const writes = await request.json();
    const sql = this.state.storage.sql;
    this.state.storage.transactionSync(() => {
      // Each write takes the next revision from the single monotonic counter,
      // as canonical publication does; rewrites move an identity forward.
      for (const { id, content, digest } of writes) {
        const revision = Number(Array.from(sql.exec(`UPDATE exact_review_record_export_meta
          SET current_revision = current_revision + 1 WHERE singleton_id = 1
          RETURNING current_revision`))[0].current_revision);
        if (content === null) {
          sql.exec(`UPDATE exact_review_canonical_records SET deleted = 1, content = NULL,
            digest = NULL, byte_length = 0 WHERE repo_slug = 'fixture-repo' AND section = 'items'
            AND item_id = ?`, id);
          sql.exec(`UPDATE exact_review_record_export_index SET deleted = 1, digest = NULL,
            revision = revision + 1, store_revision = ? WHERE repo_slug = 'fixture-repo'
            AND section = 'items' AND record_id = ?`, revision, String(id));
          continue;
        }
        sql.exec(`INSERT INTO exact_review_canonical_records
          (repo_slug, section, item_id, content, digest, byte_length, chunk_count, deleted,
           revision, item_key, claim_generation, updated_at)
          VALUES ('fixture-repo', 'items', ?, ?, ?, ?, 0, 0, 1, ?, 1, ?)
          ON CONFLICT DO UPDATE SET content = excluded.content, digest = excluded.digest,
            byte_length = excluded.byte_length, deleted = 0, revision = revision + 1`,
          id, content, digest, new TextEncoder().encode(content).length, `fixture-repo#${id}`, revision);
        sql.exec(`INSERT INTO exact_review_record_export_index
          (repo_slug, section, record_id, digest, deleted, revision, store_revision, source, updated_at)
          VALUES ('fixture-repo', 'items', ?, ?, 0, 1, ?, 'canonical', ?)
          ON CONFLICT DO UPDATE SET digest = excluded.digest, deleted = 0,
            revision = revision + 1, store_revision = excluded.store_revision`,
          String(id), digest, revision, revision);
      }
    });
    return Response.json({ written: writes.length });
  }
}

export default {
  fetch(request, env, context) {
    if (new URL(request.url).pathname === "/__proof/ready") return Response.json({ nonce: env.PROOF_NONCE });
    if (new URL(request.url).pathname === "/__proof/write")
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    // Labeled synthetic latency: production export pages take seconds (R2 body
    // reads); local pages take milliseconds, which would never reach a budget.
    if (new URL(request.url).pathname === "/internal/state/records/export")
      return new Promise((resolve) => setTimeout(resolve, 300)).then(() =>
        application.fetch(request, env, context));
    return application.fetch(request, env, context);
  },
};
