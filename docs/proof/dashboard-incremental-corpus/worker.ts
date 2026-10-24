// Local proof only. Never deploy. The production Worker and exact-review queue serve every
// request unchanged; the fixture only blocks outbound fetches and alarm dispatch.
import application, { StatusStore } from "../../../dashboard/worker.ts";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";
export { StatusStore };
globalThis.fetch = async () => {
  throw new Error("proof forbids outbound fetch");
};

export class ExactReviewQueue {
  constructor(state, env) {
    this.state = state;
    this.queue = new ProductionQueue(state, {
      ...env,
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    });
  }
  async alarm() {
    await this.state.storage.deleteAlarm();
  }
  fetch(request) {
    return this.queue.fetch(request);
  }
}

export default {
  fetch(request, env, context) {
    if (new URL(request.url).pathname === "/__proof/ready")
      return Response.json({ nonce: env.PROOF_NONCE });
    return application.fetch(request, env, context);
  },
};
