// Fixture-only entrypoint; never deploy this Worker.
import application, { StatusStore } from "../../../dashboard/worker.ts";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";
export { StatusStore };
let outbound = 0;
globalThis.fetch = async () => {
  outbound += 1;
  throw new Error("proof forbids outbound fetch");
};
export class ExactReviewQueue {
  constructor(state, env) {
    this.state = state;
    this.env = {
      ...env,
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    };
    this.queue = new ProductionQueue(state, this.env);
  }
  async alarm() {
    // This proof ends at durable finalization-driver creation, before dispatch.
    await this.state.storage.deleteAlarm();
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__proof/")) return this.queue.fetch(request);
    await this.queue.fetch(new Request("https://queue/status"));
    if (path === "/__proof/ready") return Response.json({ nonce: this.env.PROOF_NONCE });
    const input = await request.json();
    if (path === "/__proof/reconstruct") {
      this.queue = new ProductionQueue(this.state, this.env);
      await this.queue.fetch(new Request("https://queue/status"));
      return Response.json({ ok: true });
    }
    const q = this.queue;
    const store = q["lifecycleProjectionStore"];
    if (path === "/__proof/seed") {
      store.recordAdmission({
        ...input,
        deliveryId: input.fenceKey,
        sourceAction: "legacy_dispatch",
        commandOriginated: true,
        statusMarker:
          "<!-- clawsweeper-command-status:706:re_review:0123456789abcdef0123456789abcdef01234567 -->",
        statusCommentId: 7061,
        observedAt: Date.now(),
      });
      store.recordCanonicalReceipt({
        ...input,
        outcome: "accepted",
        receiptId: `canonical:${input.fenceKey}`,
        observedAt: Date.now(),
      });
      return Response.json({ ok: true });
    }
    if (path === "/__proof/read") {
      return Response.json({
        projection: store.read(input.canonicalTargetKey, input.fenceKey, input.revision),
        drivers: Object.keys(q["readStateSync"]().items).filter((key) =>
          key.includes(input.fenceKey),
        ),
        outbound,
      });
    }
    return Response.json({ error: "unknown proof route" }, { status: 404 });
  }
}
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/__proof/"))
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    return application.fetch(request, env, ctx);
  },
};
