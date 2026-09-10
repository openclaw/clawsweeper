// Local-only entrypoint. Production route, closed projection and real DO storage.
// Never deploy this config: fixture seeding deliberately has no live credentials.
import productionWorker, { StatusStore } from "../../../dashboard/worker.ts";
import { InlineProofFixtureQueue } from "../bay-inline-proof/fixture-worker.mjs";
import { statusFixture, repositories } from "./fixtures.mjs";
export { StatusStore, InlineProofFixtureQueue };
const key = "bay-readable-layout-fixture";
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return new Response("Local proof only", { status: 403 });
    const store = env.STATUS_STORE.get(env.STATUS_STORE.idFromName("global"));
    if (url.pathname === "/fixture/snapshot" && request.method === "POST") {
      const { scenario, epoch } = await request.json();
      const snapshot = statusFixture(scenario, epoch);
      const receipt = await store.fetch(
        new Request("https://status/" + key, {
          method: "PUT",
          body: JSON.stringify({ value: JSON.stringify(snapshot) }),
        }),
      );
      if (!receipt.ok) return receipt;
      return Response.json({
        scenario,
        generated_at: snapshot.generated_at,
        persistence: "StatusStore Durable Object",
      });
    }
    if (url.pathname.startsWith("/fixture/"))
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    if (request.method !== "GET")
      return new Response("Observer proof: mutation refused", { status: 405 });
    if (url.pathname === "/api/status") {
      const stored = await store.fetch(new Request("https://status/" + key));
      if (stored.ok) {
        // Exercise the same cached-snapshot reader and closed projection as production.
        // Pin this cache version to the inspected baseline; a version change fails the
        // harness's x-clawsweeper-cache assertion rather than silently proving another path.
        const scope = encodeURIComponent([...repositories].sort().join(","));
        const cacheKey = new Request(new URL("/api/status-cache/v7/" + scope + "/fresh", url));
        await caches.default.put(
          cacheKey,
          new Response(await stored.text(), {
            headers: { "cache-control": "public,max-age=300", "content-type": "application/json" },
          }),
        );
      }
    }
    return productionWorker.fetch(request, env, ctx);
  },
};
