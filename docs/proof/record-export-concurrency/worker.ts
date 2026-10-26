// Controlled fixture only: never deploy. Reuses native body-tiering instrumentation.
import { Queue as TieringQueue } from "../canonical-body-tiering/worker.ts";
import worker from "../../../dashboard/worker.ts";
export { StatusStore } from "../../../dashboard/worker.ts";
import {
  sha256Hex,
  validateDirectPublicationPlan,
} from "../../../dashboard/exact-review-direct-publication.ts";
export class Queue extends TieringQueue {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture-delta") {
      for (const id of [1, 2]) {
        const input = await this.publication(id, "new delta body 雪🦊", 2);
        if (id === 1) {
          input.operations[0] = { ...input.operations[0], deleted: true, bytes: 0 };
          delete input.operations[0].contentBase64;
          input.totalBytes = 0;
        }
        const prepared = await validateDirectPublicationPlan(input);
        this.records.accept(
          prepared,
          1792108801000,
          await this.records.prepareCanonicalWrites(prepared.operations),
        );
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture-seed") {
      await this.initialize();
      for (let id = 1; id <= 32; id++) {
        const input = await this.publication(id, "unused");
        input.operations = ["items", "closed", "plans", "decision-packets"].map((section) => {
          const content =
            section === (id % 2 ? "closed" : "items")
              ? null
              : section === "decision-packets"
                ? JSON.stringify({ id, note: "雪🦊\u0000" })
                : '"\n雪🦊\0'.repeat(100) + section + id;
          return {
            path: `records/example-project/${section}/${id}.${section === "decision-packets" ? "json" : "md"}`,
            mode: "100644",
            deleted: content === null,
            bytes: content === null ? 0 : new TextEncoder().encode(content).byteLength,
            ...(content === null
              ? {}
              : { contentBase64: btoa(unescape(encodeURIComponent(content))) }),
          };
        });
        input.totalBytes = input.operations.reduce((sum: number, op: any) => sum + op.bytes, 0);
        this.records.accept(await validateDirectPublicationPlan(input), 1792108800000);
      }
      for (const [id, bytes] of [
        [33, 1572865],
        [34, 2097152],
      ]) {
        const input = await this.publication(id, "z".repeat(bytes));
        this.records.accept(await validateDirectPublicationPlan(input), 1792108800000);
      }
      const content = "commit evidence 雪🦊";
      this.records.publishCanonicalCommits(
        "example-project",
        [
          {
            section: "commits",
            id: "c".repeat(40),
            content,
            digest: await sha256Hex(new TextEncoder().encode(content)),
            bytes: new TextEncoder().encode(content).byteLength,
          },
        ],
        1792108800000,
      );
      // Leave eight tuples in v1; the same mixed corpus is used by both variants.
      const preview = await this.records.tieringPreview(this.deployment, {
        operator: "synthetic-operator",
        rollbackFloor: {
          sha: this.deployment,
          supportsFormats: [1, 2],
          proof: "controlled native fixture",
        },
        bucketLifecycle: {
          bucketIdentity: "clawsweeper-state-snapshots",
          observedAt: "2026-10-16T00:00:00Z",
          rulesJson: '{"rules":[]}',
          canonicalBodiesDoNotExpire: true,
        },
      });
      this.records.activateTieringSync(preview, 1792108800000);
      for (let i = 0; i < 6; i++)
        this.records.commitTieringPassSync(await this.records.prepareTieringPass(), 1792108800000);
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/records/")) return this.queue.fetch(request);
    return super.fetch(request);
  }
}
export default {
  fetch(request: Request, env: any, ctx: any) {
    if (new URL(request.url).pathname.startsWith("/fixture/")) {
      const url = new URL(request.url);
      url.pathname = url.pathname.slice("/fixture".length);
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(
        new Request(url, request),
      );
    }
    return worker.fetch(request, env, ctx);
  },
};
