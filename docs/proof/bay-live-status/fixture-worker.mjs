// LOCAL PROOF ONLY. Never deploy this entrypoint or configure live credentials.
import productionWorker, { StatusStore } from "../../../dashboard/worker.ts";
import { statusFixture } from "../bay-readable-layout/fixtures.mjs";

export { StatusStore };
const repository = "openclaw/clawsweeper";
const key = "bay-live-status-fixture";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return new Response("Local proof only", { status: 403 });
    const store = env.STATUS_STORE.get(env.STATUS_STORE.idFromName("global"));
    const persist = (body) =>
      store.fetch(
        new Request("https://status/" + key, {
          method: "PUT",
          body: JSON.stringify({ value: body }),
        }),
      );
    if (url.pathname === "/fixture/reset" && request.method === "POST") {
      const { scenario = "normal" } = await request.json();
      if (!["normal", "forward", "malformed"].includes(scenario))
        return new Response("Unknown proof scenario", { status: 400 });
      const snapshot = statusFixture(scenario === "forward" ? "forward" : "normal", Date.now());
      snapshot.source.target_repository_count = 1;
      const queue = snapshot.exact_review_queue;
      queue.lanes.review.parked = scenario === "malformed" ? 3 : 2;
      queue.lanes.review.parked_reasons = { source_incompatible: 1, unknown: 1 };
      queue.manual_publication = { policy: "record_comment_only", enabled: false };
      for (const row of [
        ...queue.bay_projection.items,
        ...queue.bay_projection.activity.items,
        ...snapshot.bay.terminal_buffer,
      ])
        row.repository = repository;
      const receipt = await persist(JSON.stringify(snapshot));
      if (!receipt.ok) return receipt;
      return Response.json({ scenario, persistence: "StatusStore Durable Object" });
    }
    if (request.method !== "GET")
      return new Response("Observer proof: mutation refused", { status: 405 });
    if (url.pathname === "/api/status") {
      const stored = await store.fetch(new Request("https://status/" + key));
      if (!stored.ok) return new Response("Seed the proof fixture first", { status: 503 });
      // Pin the real cache key: schema changes must update this proof deliberately.
      const cacheKey = new Request(
        new URL("/api/status-cache/v7/" + encodeURIComponent(repository) + "/fresh", url),
      );
      await caches.default.put(
        cacheKey,
        new Response(await stored.text(), {
          headers: { "cache-control": "public,max-age=300", "content-type": "application/json" },
        }),
      );
      const response = await productionWorker.fetch(request, env, ctx);
      if (response.headers.get("x-clawsweeper-cache") !== "fresh")
        return new Response("Proof did not traverse the production cached status route", {
          status: 500,
        });
      // Production stores projected snapshots. Re-read the exact response so the
      // next request catches fields lost on the first serialization boundary.
      const receipt = await persist(await response.clone().text());
      if (!receipt.ok) return receipt;
      return response;
    }
    return productionWorker.fetch(request, env, ctx);
  },
};
