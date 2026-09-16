import worker, { publicStatusFreshness, StatusStore } from "../../../dashboard/worker.ts";
import capturedEvents from "./observed-publication-events.json";
import { statusFixture } from "../bay-readable-layout/fixtures.mjs";
import {
  publicationEventsFixture,
  publicationStatusFixture,
} from "../../../test/helpers/publication-status-fixture.ts";

export { StatusStore };

let events = publicationEventsFixture();
let generation = 0;
let blockedRequests = 0;
let storeReads = 0;
let browserSnapshot = null;
let statusOffline = false;
let lifetimeMode = false;
let stallKind = "";
let stallGeneration = 0;
async function holdRead() {
  const heldGeneration = stallGeneration;
  const deadline = Date.now() + 30_000;
  // Keep pending events in the request that owns the read; Workerd rejects a
  // bare unresolved Promise, and another request must not own its completion.
  while (heldGeneration === stallGeneration) {
    if (Date.now() >= deadline) throw new Error("proof stall was not released");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
function releaseStall() {
  stallGeneration += 1;
}
let snapshotReads = 0;
let snapshotWrites = 0;
let lifetimeResponses = 0;
let snapshotPublications = 0;
let lifetimeWorkers = 17;
let lifetimeTtl = 3600;

function lifetimeSnapshot() {
  const snapshot = statusFixture("empty", Date.parse(events.captured_at));
  return {
    ...snapshot,
    fleet: {
      ...snapshot.fleet,
      active_workflow_runs: 1,
      active_codex_jobs: lifetimeWorkers,
      budget_used_percent: Math.round((lifetimeWorkers / snapshot.fleet.worker_budget) * 100),
    },
    recent_durable_publication_events: events,
  };
}

globalThis.fetch = async () => {
  blockedRequests += 1;
  throw new Error("external network denied by publication proof");
};

export default {
  async fetch(request, bindings, ctx) {
    const url = new URL(request.url);
    if (url.hostname !== "127.0.0.1") return new Response(null, { status: 403 });
    const store = {
      idFromName: (name) => bindings.LOCAL_STATUS_STORE.idFromName(`${generation}:${name}`),
      get: (id) => ({
        async fetch(input, init) {
          if (input.method === "GET") storeReads += 1;
          const snapshot = decodeURIComponent(new URL(input.url).pathname).startsWith("/snapshot:");
          if (lifetimeMode && snapshot) {
            if (input.method === "GET") snapshotReads += 1;
            if (input.method === "PUT") snapshotWrites += 1;
            if (input.method === "GET" && stallKind === "read") await holdRead();
            if (input.method === "PUT" && stallKind === "write" && snapshotWrites === 1)
              await holdRead();
          }
          const response = await bindings.LOCAL_STATUS_STORE.get(id).fetch(input, init);
          if (lifetimeMode && snapshot && input.method === "PUT" && response.ok)
            snapshotPublications += 1;
          if (lifetimeMode && snapshot && input.method === "GET" && stallKind === "body") {
            const body = await response.text();
            const held = holdRead();
            return new Response(
              new ReadableStream({
                async start(controller) {
                  await held;
                  controller.enqueue(new TextEncoder().encode(body));
                  controller.close();
                },
              }),
              { status: response.status },
            );
          }
          return response;
        },
      }),
    };
    if (url.pathname === "/__proof/ready") return Response.json({ ready: true });
    if (url.pathname === "/__proof/lifetime" && request.method === "POST") {
      const { stall = "", count = 17, ttl = 3600, advance = false } = await request.json();
      if (!advance) {
        releaseStall();
        stallKind = stall;
        generation += 1;
        snapshotReads = 0;
        snapshotWrites = 0;
        snapshotPublications = 0;
        lifetimeResponses = 0;
        blockedRequests = 0;
      }
      lifetimeMode = true;
      lifetimeWorkers = count;
      lifetimeTtl = ttl;
      events = publicationEventsFixture(Date.now() - 1_000);
      for (const bucket of ["fresh", "stale"]) {
        await caches.default.delete(new Request(`${url.origin}/api/status-cache/v7/_/${bucket}`));
      }
      const seed = lifetimeSnapshot();
      await bindings.LOCAL_STATUS_STORE.get(store.idFromName("global")).fetch(
        new Request("https://clawsweeper-status-store/snapshot%3Abay-scope%3Av1%3A_", {
          method: "PUT",
          body: JSON.stringify({ value: JSON.stringify(seed) }),
        }),
      );
      return Response.json({ seeded: true });
    }
    if (url.pathname === "/__proof/release" && request.method === "POST") {
      stallKind = "";
      releaseStall();
      return Response.json({ released: true });
    }
    if (url.pathname === "/__proof/seed" && request.method === "POST") {
      const { mode, kind, now, offline = false } = await request.json();
      generation += 1;
      blockedRequests = 0;
      storeReads = 0;
      browserSnapshot = null;
      statusOffline = offline;
      events = publicationEventsFixture(
        now,
        kind === "mixed"
          ? [true, false]
          : kind === "mixed-batch"
            ? [false, true]
            : kind === "unknown"
              ? [false, false]
              : [true, true],
        kind === "idle",
      );
      if (kind === "captured") events = structuredClone(capturedEvents);
      const snapshot = publicationStatusFixture(events);
      snapshot.fleet = { active_codex_jobs: 17 };
      snapshot.recent_durable_publication_events = {
        ...events,
        private_marker: "withheld-publication-identity",
        direct: { ...events.direct, private_marker: "withheld-publication-identity" },
      };
      if (kind === "lossy") snapshot.recent_durable_publication_events.direct.counts = {};
      if (mode === "browser") {
        if (kind === "lossy") snapshot.recent_durable_publication_events.batch.counts = {};
        if (kind === "missing") delete snapshot.recent_durable_publication_events;
        if (kind === "null") snapshot.recent_durable_publication_events = null;
        browserSnapshot = snapshot;
      }
      for (const bucket of ["fresh", "stale"]) {
        await caches.default.delete(new Request(`${url.origin}/api/status-cache/v7/_/${bucket}`));
      }
      if (mode === "fresh" || mode === "stale") {
        await caches.default.put(
          new Request(`${url.origin}/api/status-cache/v7/_/${mode}`),
          Response.json(snapshot, { headers: { "cache-control": "public, max-age=3600" } }),
        );
      }
      if (mode === "durable") {
        const response = await store.get(store.idFromName("global")).fetch(
          new Request("https://clawsweeper-status-store/snapshot%3Abay-scope%3Av1%3A_", {
            method: "PUT",
            body: JSON.stringify({ value: JSON.stringify(snapshot) }),
          }),
        );
        if (!response.ok) throw new Error("local StatusStore seed failed");
      }
      return Response.json({ seeded: true });
    }
    if (url.pathname === "/__proof/observations") {
      let storedStatus = null;
      if (lifetimeMode) {
        const response = await bindings.LOCAL_STATUS_STORE.get(store.idFromName("global")).fetch(
          new Request("https://clawsweeper-status-store/snapshot%3Abay-scope%3Av1%3A_"),
        );
        if (response.ok) {
          const snapshot = await response.json();
          storedStatus = {
            active_codex_jobs: snapshot.fleet?.active_codex_jobs,
            generated_at: snapshot.generated_at,
            // Complementary projection of the actual durable body, not an API observation.
            canonical_freshness: publicStatusFreshness(snapshot, "miss", lifetimeTtl * 1000),
          };
        }
      }
      return Response.json({
        blocked_requests: blockedRequests,
        store_reads: storeReads,
        snapshot_reads: snapshotReads,
        snapshot_writes: snapshotWrites,
        snapshot_publications: snapshotPublications,
        stored_status: storedStatus,
        status_responses: lifetimeResponses,
      });
    }
    if (url.pathname === "/__proof/status-offline" && request.method === "POST") {
      statusOffline = true;
      return Response.json({ offline: true });
    }
    if (url.pathname === "/__proof/browser-snapshot") return Response.json(browserSnapshot);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (url.pathname === "/api/status" && statusOffline)
      return Response.json({ error: "controlled offline refresh" }, { status: 503 });
    if (url.pathname === "/api/status" && browserSnapshot)
      return Response.json(browserSnapshot, { headers: { "x-clawsweeper-cache": "fresh" } });
    const env = {
      ...(lifetimeMode ? { CACHE_TTL_SECONDS: String(lifetimeTtl) } : {}),
      STATUS_STORE: store,
      EXACT_REVIEW_QUEUE: {
        idFromName: (name) => name,
        get: () => ({
          async fetch(input) {
            const pathname = new URL(input.url).pathname;
            if (pathname === "/recent-durable-publication-events")
              return Response.json({ recent_durable_publication_events: events });
            if (lifetimeMode && pathname === "/stats")
              return Response.json(lifetimeSnapshot().exact_review_queue);
            return Response.json({ error: "unavailable in publication proof" }, { status: 503 });
          },
        }),
      },
    };
    const pending = [];
    const response = await worker.fetch(request, env, {
      waitUntil: (promise) => pending.push(promise),
    });
    if (lifetimeMode) {
      // Preserve the real Worker response/waitUntil boundary while reads are held.
      for (const promise of pending) ctx.waitUntil(promise);
      if (url.pathname === "/api/status") lifetimeResponses += 1;
    } else {
      // Drain the real stale refresh before reseeding the next isolated scenario.
      await Promise.all(pending);
    }
    return response;
  },
};
