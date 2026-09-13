import worker, { StatusStore } from "../../../dashboard/worker.ts";
import capturedEvents from "./observed-publication-events.json";
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

globalThis.fetch = async () => {
  blockedRequests += 1;
  throw new Error("external network denied by publication proof");
};

export default {
  async fetch(request, bindings) {
    const url = new URL(request.url);
    if (url.hostname !== "127.0.0.1") return new Response(null, { status: 403 });
    const store = {
      idFromName: (name) => bindings.LOCAL_STATUS_STORE.idFromName(`${generation}:${name}`),
      get: (id) => ({
        fetch(input, init) {
          if (input.method === "GET") storeReads += 1;
          return bindings.LOCAL_STATUS_STORE.get(id).fetch(input, init);
        },
      }),
    };
    if (url.pathname === "/__proof/ready") return Response.json({ ready: true });
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
      return Response.json({ blocked_requests: blockedRequests, store_reads: storeReads });
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
      STATUS_STORE: store,
      EXACT_REVIEW_QUEUE: {
        idFromName: (name) => name,
        get: () => ({
          async fetch(input) {
            return new URL(input.url).pathname === "/recent-durable-publication-events"
              ? Response.json({ recent_durable_publication_events: events })
              : Response.json({ error: "unavailable in publication proof" }, { status: 503 });
          },
        }),
      },
    };
    const pending = [];
    const response = await worker.fetch(request, env, {
      waitUntil: (promise) => pending.push(promise),
    });
    // Drain the real stale refresh before reseeding the next isolated scenario.
    await Promise.all(pending);
    return response;
  },
};
