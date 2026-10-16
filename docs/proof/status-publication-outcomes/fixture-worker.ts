import { ExactReviewQueue } from "../../../dashboard/exact-review-queue.ts";
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
let cacheOwner = "durable";
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
let snapshotSettled = 0;
let lifetimeWorkers = 17;
let lifetimeTtl = 3600;

function lifetimeSnapshot() {
  const snapshot = statusFixture("empty", Date.parse(events.captured_at));
  return {
    ...snapshot,
    public_projection_complete: true,
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
    if (url.pathname.startsWith("/__proof/reasons/")) {
      const queue = bindings.LOCAL_REASON_QUEUE.get(
        bindings.LOCAL_REASON_QUEUE.idFromName("proof"),
      );
      const route = url.pathname.slice("/__proof/reasons/".length);
      if (route === "events") {
        return worker.fetch(
          new Request("http://127.0.0.1/api/recent-durable-publication-events"),
          {
            EXACT_REVIEW_QUEUE: { idFromName: () => "proof", get: () => queue },
          },
          ctx,
        );
      }
      const body =
        request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
      return queue.fetch(
        new Request(`https://queue/${route}`, {
          method: request.method,
          headers: request.headers,
          body,
        }),
      );
    }
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
    if (url.pathname === "/__proof/publication-order" && request.method === "POST") {
      const { action, at, count, held = false, scope = "_", ttl = 3600 } = await request.json();
      if (action === "reset") {
        releaseStall();
        generation += 1;
        lifetimeMode = true;
        lifetimeTtl = ttl;
        snapshotWrites = snapshotPublications = snapshotSettled = 0;
        for (const bucket of ["fresh", "stale"])
          await caches.default.delete(new Request(`${url.origin}/api/status-cache/v8/_/${bucket}`));
        return Response.json({ reset: true });
      }
      const snapshot = {
        ...publicationStatusFixture(publicationEventsFixture(at)),
        public_projection_complete: true,
      };
      snapshot.fleet = { ...snapshot.fleet, active_workflow_runs: 1, active_codex_jobs: count };
      if (action === "edge") {
        for (const bucket of ["fresh", "stale"])
          await caches.default.put(
            new Request(`${url.origin}/api/status-cache/v8/_/${bucket}`),
            Response.json(snapshot, { headers: { "cache-control": "public, max-age=3600" } }),
          );
        return Response.json({ seeded: true });
      }
      if (action === "ttl") {
        lifetimeTtl = ttl;
        return Response.json({ updated: true });
      }
      if (action !== "write") return new Response(null, { status: 400 });
      const publish = async () => {
        snapshotWrites += 1;
        if (held) await holdRead();
        const response = await bindings.LOCAL_STATUS_STORE.get(store.idFromName("global")).fetch(
          new Request(
            `https://clawsweeper-status-store/${encodeURIComponent(`snapshot:bay-scope:v2:${scope}`)}`,
            {
              method: "PUT",
              body: JSON.stringify({ value: JSON.stringify(snapshot) }),
            },
          ),
        );
        if (!response.ok) throw new Error("proof snapshot write failed");
        snapshotSettled += 1;
        if (response.headers.get("X-ClawSweeper-Snapshot") !== "retained")
          snapshotPublications += 1;
        return Response.json({ disposition: response.headers.get("X-ClawSweeper-Snapshot") });
      };
      if (!held) return publish();
      ctx.waitUntil(publish());
      return Response.json({ held: true });
    }
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
        await caches.default.delete(new Request(`${url.origin}/api/status-cache/v8/_/${bucket}`));
      }
      const seed = lifetimeSnapshot();
      await bindings.LOCAL_STATUS_STORE.get(store.idFromName("global")).fetch(
        new Request("https://clawsweeper-status-store/snapshot%3Abay-scope%3Av2%3A_", {
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
      const {
        mode,
        kind,
        now,
        offline = false,
        cache_owner = "durable",
        historical_cache = false,
      } = await request.json();
      // The recorded September baseline uses v7 edge and v1 scoped store keys.
      const edgeVersion = historical_cache ? "v7" : "v8";
      const snapshotVersion = historical_cache ? "v1" : "v2";
      cacheOwner = cache_owner;
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
      const snapshot = {
        ...publicationStatusFixture(events),
        public_projection_complete: true,
      };
      if (mode === "stale") snapshot.generated_at = new Date(Date.now() - 61_000).toISOString();
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
        await caches.default.delete(
          new Request(`${url.origin}/api/status-cache/${edgeVersion}/_/${bucket}`),
        );
      }
      if (mode === "fresh" || mode === "stale") {
        await caches.default.put(
          new Request(`${url.origin}/api/status-cache/${edgeVersion}/_/${mode}`),
          Response.json(snapshot, { headers: { "cache-control": "public, max-age=3600" } }),
        );
      }
      if (cacheOwner === "durable" && ["durable", "fresh", "stale"].includes(mode)) {
        const response = await store.get(store.idFromName("global")).fetch(
          new Request(
            `https://clawsweeper-status-store/${encodeURIComponent(`snapshot:bay-scope:${snapshotVersion}:_`)}`,
            {
              method: "PUT",
              body: JSON.stringify({ value: JSON.stringify(snapshot) }),
            },
          ),
        );
        if (!response.ok) throw new Error("local StatusStore seed failed");
      }
      return Response.json({ seeded: true });
    }
    if (url.pathname === "/__proof/observations") {
      let storedStatus = null;
      if (lifetimeMode) {
        const response = await bindings.LOCAL_STATUS_STORE.get(store.idFromName("global")).fetch(
          new Request("https://clawsweeper-status-store/snapshot%3Abay-scope%3Av2%3A_"),
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
        snapshot_settled: snapshotSettled,
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
      STATUS_STORE: cacheOwner === "durable" ? store : undefined,
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

// This isolated binding seeds old SQLite and synthetic leases, then invokes the
// production queue. No production bindings, credentials or outbound fetch exist.
export class PublicationReasonQueue {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async fetch(request) {
    if (new URL(request.url).pathname === "/seed") {
      const now = Date.now();
      const items = Object.fromEntries(
        [9101, 9102, 9103].map((number) => {
          const run = String(number * 10);
          const target = `openclaw/openclaw#${number}`;
          const producer = {
            targetRepo: "openclaw/openclaw",
            targetBranch: "main",
            itemNumber: number,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction: "opened",
            supersedesInProgress: false,
          };
          const decision = {
            ...producer,
            sourceAction: "exact_review_artifact_publish",
            publication: {
              artifactName: `exact-review-${run}-1`,
              producerRunId: run,
              producerRunAttempt: 1,
              sourceSha: "a".repeat(40),
              itemKey: target,
              protocolVersion: 2,
              leaseRevision: 1,
              claimGeneration: 1,
              liveProceeded: true,
              liveTerminalNoop: false,
              liveTerminalMissing: false,
              liveGuardedOpen: false,
              producerDecision: producer,
            },
          };
          const item = {
            key: `${target}@publish:${run}:1`,
            decision,
            leaseDecision: decision,
            state: number === 9103 ? "pending" : "leased",
            revision: 1,
            createdAt: now - 60_000,
            updatedAt: now - 60_000,
            nextAttemptAt: now - 60_000,
            attempts: 0,
            leaseId: `lease-${number}`,
            leaseRevision: 1,
            leaseExpiresAt: now + 3_600_000,
            claimedRunId: run,
            claimedRunAttempt: 1,
            claimGeneration: 1,
            claimProtocolVersion: 2,
          };
          return [item.key, item];
        }),
      );
      await this.ctx.storage.put("exact-review-queue", { deliveries: {}, items });
      this.ctx.storage.sql.exec(`CREATE TABLE exact_review_lifecycle_telemetry_batch_v1 (
        event_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, canonical_target_key TEXT NOT NULL,
        fence_key TEXT NOT NULL, revision INTEGER NOT NULL, claim_generation INTEGER NOT NULL,
        outcome TEXT NOT NULL, observed_at INTEGER NOT NULL
      ) STRICT`);
      this.ctx.storage.sql.exec(
        `INSERT INTO exact_review_lifecycle_telemetry_batch_v1 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "old-event",
        "old-batch",
        "openclaw/openclaw#9100",
        "private-fence",
        1,
        1,
        "permanent",
        now,
      );
      return Response.json({ seeded: true });
    }
    return this.queue().fetch(request);
  }
  alarm() {
    return this.queue().alarm();
  }
  queue() {
    return new ExactReviewQueue(this.ctx, {
      // Admission is fixture-owned so synthetic public leases need no network.
      hostedTargetPredicate: (repo) => repo === "openclaw/openclaw",
      hostedPublicTargetProbe: async () => "public",
      EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
      EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "1",
    });
  }
}
