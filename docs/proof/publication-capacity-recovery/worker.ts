// Local proof entrypoint only. Production bindings and routes are unchanged.
import application, { StatusStore } from "../../../dashboard/worker.ts";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";
export { StatusStore };

const clockKey = "publication-capacity-proof:clock";
let deniedNetwork = 0;
let triggerFailures = 0;
globalThis.fetch = async () => {
  deniedNetwork += 1;
  throw new Error("publication capacity proof forbids external fetch");
};

export class ExactReviewQueue extends ProductionQueue {
  constructor(state, env) {
    super(state, {
      ...env,
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    });
  }

  async fetch(request, ...args) {
    const storage = this["storage"];
    const now = Number(storage.kv.get(clockKey) ?? this["env"].PROOF_NOW);
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error("invalid proof clock");
    Date.now = () => now;
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__proof/")) {
      try {
        return await super.fetch(request, ...args);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("publication capacity fixture rollback")
        ) {
          triggerFailures = Math.min(2, triggerFailures + 1);
        }
        throw error;
      }
    }
    await super.fetch(new Request("https://queue/stats"));
    if (path === "/__proof/ready") {
      return Response.json({ nonce: this["env"].PROOF_NONCE, now, deniedNetwork });
    }
    if (path === "/__proof/advance") {
      const { milliseconds } = await request.json();
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 86_400_000)
        return Response.json({ error: "invalid_clock_advance" }, { status: 400 });
      storage.kv.put(clockKey, now + milliseconds);
      return Response.json({ now: now + milliseconds });
    }
    if (path === "/__proof/inspect") {
      const state = this["readStateSync"]();
      return Response.json({
        now,
        deniedNetwork,
        triggerFailures,
        control: this["publicationControlSync"](),
        items: Object.values(state.items).map((item) => ({
          key: item.key,
          revision: item.revision,
          state: item.state,
          terminalFinalization: Boolean(item.terminalFinalization),
        })),
        memberships: Array.from(
          storage.sql.exec(
            "SELECT batch_id, item_key, revision, claim_generation, terminal_outcome FROM exact_review_publication_batch_items ORDER BY batch_id, item_key",
          ),
        ),
      });
    }
    if (path === "/__proof/fail-membership") {
      const { key } = await request.json();
      if (typeof key !== "string" || !/^[a-z0-9/#:@._-]{1,200}$/i.test(key))
        return Response.json({ error: "invalid_fixture_key" }, { status: 400 });
      storage.sql.exec(
        "CREATE TRIGGER publication_capacity_proof_failure BEFORE UPDATE OF terminal_outcome ON exact_review_publication_batch_items " +
          "WHEN NEW.item_key = '" +
          key +
          "' BEGIN SELECT RAISE(ABORT, 'publication capacity fixture rollback'); END",
      );
      return Response.json({ armed: true });
    }
    if (path === "/__proof/clear-failure") {
      storage.sql.exec("DROP TRIGGER publication_capacity_proof_failure");
      return Response.json({ cleared: true });
    }
    return Response.json({ error: "unknown_fixture_route" }, { status: 404 });
  }
}

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).hostname !== "127.0.0.1") return new Response(null, { status: 403 });
    if (new URL(request.url).pathname.startsWith("/__proof/"))
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    return application.fetch(
      request,
      {
        ...env,
        hostedTargetPredicate: () => true,
        hostedPublicTargetProbe: async () => "public",
      },
      ctx,
    );
  },
};
