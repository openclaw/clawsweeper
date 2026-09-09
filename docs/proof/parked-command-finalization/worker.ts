// Fixture-only entrypoint. Never deployed; the application entrypoint is unchanged.
import application, { StatusStore } from "../../../dashboard/worker.ts";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";
export { StatusStore };
export class ExactReviewQueue extends ProductionQueue {
  async fetch(request, ...args) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__proof/")) return super.fetch(request, ...args);
    await super.fetch(new Request("https://queue/stats"));
    if (path === "/__proof/identity") return Response.json({ nonce: this["env"].PROOF_NONCE });
    if (path === "/__proof/state") return Response.json(this["readStateSync"]());
    if (path === "/__proof/alarm") {
      await request.text();
      await super.alarm();
      return Response.json({ ok: true });
    }
    if (path === "/__proof/ready-driver") {
      const { key } = await request.json();
      const state = this["readStateSync"]();
      const item = state.items[key];
      if (!item?.terminalFinalization?.parkedCommand || item.state !== "pending")
        return Response.json({ error: "not_pending_fixture_driver" }, { status: 409 });
      item.nextAttemptAt = Date.now() - 1;
      await this["writeState"](state);
      return Response.json({ ok: true });
    }
    if (path === "/__proof/park") {
      const { key, takeover = false } = await request.json();
      const state = this["readStateSync"]();
      const item = state.items[key];
      if (!item) return Response.json({ error: "missing_fixture" }, { status: 404 });
      if (takeover) item.revision += 1;
      else
        Object.assign(item, {
          state: "parked",
          parkedReason: "review_retry_exhausted",
          parkedRecoveryAttempts: 3,
          reviewFailureAttempts: 8,
          attempts: 8,
          parkedRecoveryAt: undefined,
          parkedTerminalCheckedAt: 0,
        });
      // Advance only fixture scheduling timestamps; production still selects
      // one globally due target and performs the real HTTP/fence transitions.
      const priorWindow = Date.now() - 6 * 60_000;
      for (const candidate of Object.values(state.items)) {
        if (candidate.state === "parked") candidate.parkedTerminalCheckedAt = priorWindow;
      }
      item.parkedTerminalCheckedAt = priorWindow - 60_000;
      state.dispatcher = { ...state.dispatcher, parkedTerminalCheckedAt: priorWindow };
      await this["writeState"](state);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unknown_fixture_route" }, { status: 404 });
  }
}
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/__proof/")) {
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    }
    return application.fetch(request, env, ctx);
  },
};
