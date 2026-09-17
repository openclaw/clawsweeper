// LOCAL PROOF ONLY. Production owns decisions, claims, completions and projections.
import application, { StatusStore } from "../../../dashboard/worker.ts";
import { ExactReviewQueue as ProductionQueue } from "../../../dashboard/exact-review-queue.ts";
export { StatusStore };
export class ExactReviewQueue extends ProductionQueue {
  async fetch(request, ...args) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__proof/")) return super.fetch(request, ...args);
    if (request.headers.get("x-proof-nonce") !== this["env"].PROOF_NONCE)
      return Response.json({ error: "fixture_unauthorized" }, { status: 403 });
    await super.fetch(new Request("https://queue/stats"));
    if (path === "/__proof/identity") return Response.json({ nonce: this["env"].PROOF_NONCE });
    if (path === "/__proof/state") return Response.json(this["readStateSync"]());
    if (path === "/__proof/alarm") {
      await request.text();
      await super.alarm();
      return Response.json({ ok: true });
    }
    const { key, mode } = await request.json();
    const state = this["readStateSync"](),
      item = state.items[key];
    if (!item) return Response.json({ error: "missing_fixture" }, { status: 404 });
    if (path === "/__proof/park") {
      Object.assign(item, {
        state: "parked",
        parkedReason: "review_retry_exhausted",
        parkedRecoveryAttempts: 3,
        reviewFailureAttempts: 8,
        attempts: 8,
        parkedRecoveryAt: undefined,
      });
      const now = Date.now();
      for (const candidate of Object.values(state.items)) {
        if (candidate.state === "parked") candidate.parkedTerminalCheckedAt = now - 6 * 60_000;
      }
      item.parkedTerminalCheckedAt = now - 7 * 60_000;
      state.dispatcher = { ...state.dispatcher, parkedTerminalCheckedAt: now - 6 * 60_000 };
    } else if (path === "/__proof/ready") {
      if (item.state !== "pending") return Response.json({ error: "not_pending" }, { status: 409 });
      item.nextAttemptAt = Date.now() - 1;
    } else if (path === "/__proof/retry-control") {
      item.parkedRecoveryAttempts = 1;
      item.parkedRecoveryAt = Date.now() + 24 * 60 * 60_000;
      item.nextAttemptAt = item.parkedRecoveryAt;
      item.parkedTerminalCheckedAt = Date.now();
    } else if (path === "/__proof/race") {
      if (mode === "revision") item.revision += 1;
      else if (mode === "command")
        item.decision = {
          ...item.decision,
          commandStatusMarker: "<!-- clawsweeper-command-status:999:re_review:successor -->",
        };
      else if (mode === "head") item.decision = { ...item.decision, sourceHeadSha: "b".repeat(40) };
      else return Response.json({ error: "invalid_race" }, { status: 400 });
    } else return Response.json({ error: "unknown_fixture_route" }, { status: 404 });
    await this["writeState"](state);
    return Response.json({ ok: true });
  }
}
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/__proof/"))
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    return application.fetch(request, env, ctx);
  },
};
