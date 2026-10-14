import {
  assert,
  createHmac,
  test,
  worker,
  ExactReviewQueue,
  StatusStore,
  ExactReviewLifecycleProjectionStore,
  ExactReviewLifecycleTelemetryStore,
  MemoryKv,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  MemoryCache,
  buildExactReviewQueueRequest,
  readCachedSnapshot,
  applyObservation,
  isoAgo,
  jsonResponse,
} from "./dashboard-worker-harness.ts";
import { publicHealthHistoryContract } from "../dashboard/worker.ts";

test("StatusStore startup removes only retired Bay history keys", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("openclaw-bay:terminal-state:v1", { retired: true });
  await storage.put("openclaw-bay:journey-state:v1", { retired: true });
  await storage.put("snapshot", { current: true });
  for (let restart = 0; restart < 2; restart++) {
    let ready = Promise.resolve();
    new StatusStore({
      storage,
      blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
        ready = callback().then(() => {});
        return ready;
      },
    });
    await ready;
    assert.equal(await storage.get("openclaw-bay:terminal-state:v1"), undefined);
    assert.equal(await storage.get("openclaw-bay:journey-state:v1"), undefined);
    assert.deepEqual(await storage.get("snapshot"), { current: true });
  }
});

test("public durable publication event endpoint returns bounded aggregate-only window data", async () => {
  const storage = new MemoryDurableStorage();
  const telemetry = new ExactReviewLifecycleTelemetryStore(storage);
  telemetry.ensureSchemaSync();
  telemetry.recordDirectOutcome({
    canonicalTargetKey: "openclaw/openclaw#898",
    fenceKey: "openclaw/openclaw#898@exact:1",
    revision: 1,
    claimGeneration: 1,
    outcome: "accepted",
    observedAt: Date.now() - 60_000,
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const exec = storage.sql.exec.bind(storage.sql);
  let sourceReads = 0;
  storage.sql.exec = (query: string, ...bindings: unknown[]) => {
    if (query.includes("SELECT outcome, observed_at")) sourceReads += 1;
    return exec(query, ...bindings);
  };
  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/recent-durable-publication-events?window=6h"),
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
  );
  const body = (await response.json()) as {
    recent_durable_publication_events: Record<string, unknown>;
  };
  assert.equal(response.status, 200);
  assert.equal((body.recent_durable_publication_events.window as { id: string }).id, "6h");
  assert.equal(
    (body.recent_durable_publication_events.collection as { complete: boolean }).complete,
    true,
  );
  assert.equal(JSON.stringify(body).includes("openclaw/openclaw#898"), false);
  assert.equal(JSON.stringify(body).includes("workflow"), false);
  const cached = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/recent-durable-publication-events?window=6h"),
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
  );
  assert.equal(cached.status, 200);
  assert.equal(sourceReads, 2);
});

test("public GitHub egress observability normalizes its query and withholds revisions", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const privateMarker = ["synthetic", "private", "marker"].join("_");
  let requestedPath = "";
  const namespace = new MemoryDurableNamespace({
    async fetch(request: Request) {
      requestedPath = new URL(request.url).pathname + new URL(request.url).search;
      const response = await queue.fetch(request);
      const body = await response.json();
      return jsonResponse({ ...body, unexpected: { repository: privateMarker } });
    },
  });
  const response = await worker.fetch(
    new Request(
      `https://clawsweeper.openclaw.ai/api/github-egress-observability?hours=99&repo=${privateMarker}`,
    ),
    { EXACT_REVIEW_QUEUE: namespace },
  );
  const body = await response.json();
  const serialized = JSON.stringify(body);
  assert.equal(response.status, 200);
  assert.equal(requestedPath, "/github-egress-observability?hours=6");
  assert.equal(serialized.includes(privateMarker), false);
  assert.equal(serialized.includes("deployment_revision"), false);
  assert.equal(serialized.includes("config_revision"), false);
  assert.equal(body.privacy.revision_digests, "withheld");

  const sevenDayResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/github-egress-observability?hours=168"),
    { EXACT_REVIEW_QUEUE: namespace },
  );
  const sevenDayBody = await sevenDayResponse.json();
  assert.equal(sevenDayResponse.status, 200);
  assert.equal(requestedPath, "/github-egress-observability?hours=168");
  assert.equal(sevenDayBody.window.hours, 168);
  assert.equal(sevenDayBody.retention.rate_limit_detail_hours, 24);
  assert.equal(Array.isArray(sevenDayBody.throttle_series.rows), true);
  assert.equal(JSON.stringify(sevenDayBody).includes(privateMarker), false);
});

test("public telemetry routes contain malformed and rejecting durable reads", async () => {
  const privateMarker = ["synthetic", "durable", "exception"].join("_");
  const queueRoutes = [
    ["/api/exact-review-queue", 503, "exact_review_queue_unavailable"],
    ["/api/review-observability", 503, "review_observability_unavailable"],
    ["/api/github-egress-observability", 503, "github_egress_observability_unavailable"],
    ["/api/review-coverage", 503, "review_coverage_unavailable"],
    ["/api/recent-durable-publication-events", 200, null],
  ] as const;
  const storeRoutes = [["/api/apply-observability", "apply_observability_unavailable"]] as const;
  for (const behavior of ["malformed", "reject"] as const) {
    const rejecting = {
      async fetch() {
        if (behavior === "reject") throw new Error(privateMarker);
        return new Response(`{"${privateMarker}":`, {
          headers: { "content-type": "application/json" },
        });
      },
    };
    for (const [path, status, error] of queueRoutes) {
      const response = await worker.fetch(new Request(`https://clawsweeper.openclaw.ai${path}`), {
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(rejecting),
      });
      const body = await response.json();
      assert.equal(response.status, status);
      assert.equal(JSON.stringify(body).includes(privateMarker), false);
      if (path === "/api/exact-review-queue" && behavior === "malformed") {
        assert.deepEqual(body.collection, { state: "unknown", reason: "malformed" });
        assert.deepEqual(body.bay_projection, {
          complete: false,
          activity: {
            complete: false,
            queue_stages: null,
            live_stages: null,
            queue_legacy_batch_stages: null,
            live_legacy_batch_stages: null,
            total: null,
          },
        });
      } else if (error) assert.deepEqual(body, { error });
      else assert.deepEqual(body, { recent_durable_publication_events: null });
    }
    for (const [path, error] of storeRoutes) {
      const response = await worker.fetch(new Request(`https://clawsweeper.openclaw.ai${path}`), {
        STATUS_STORE: new MemoryDurableNamespace(rejecting),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error });
    }
  }
});

test("operator lifecycle audit inventory is signed, redacted, paginated, snapshot-stable, and short-lived", async () => {
  const coldQueue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const cold = await coldQueue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle-audit/inventory", {
      method: "POST",
      body: JSON.stringify({ page_size: 1 }),
    }),
  );
  const coldInventory = (await cold.json()) as {
    exact_review_lifecycle_audit_inventory: {
      collection: { state: string };
      snapshot: { total_records: number } | null;
      page: { returned: number } | null;
    };
  };
  assert.equal(cold.status, 200);
  assert.equal(coldInventory.exact_review_lifecycle_audit_inventory.collection.state, "complete");
  assert.equal(coldInventory.exact_review_lifecycle_audit_inventory.snapshot?.total_records, 0);
  assert.equal(coldInventory.exact_review_lifecycle_audit_inventory.page?.returned, 0);

  const unavailableStorage = new MemoryDurableStorage();
  new ExactReviewLifecycleProjectionStore(unavailableStorage).ensureSchemaSync();
  unavailableStorage.failNextSql(/exact_review_lifecycle_audit_snapshots_v1/);
  const unavailableQueue = new ExactReviewQueue(
    {
      storage: unavailableStorage,
      blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
    },
    {},
  );
  const unavailable = await unavailableQueue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle-audit/inventory", {
      method: "POST",
      body: JSON.stringify({ page_size: 1 }),
    }),
  );
  const unavailableInventory = (await unavailable.json()) as {
    exact_review_lifecycle_audit_inventory: { collection: { state: string; reason: string } };
  };
  assert.deepEqual(unavailableInventory.exact_review_lifecycle_audit_inventory.collection, {
    state: "unknown",
    reason: "unavailable",
  });

  const now = Date.now();
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  for (const number of [960, 961, 962]) {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${number}`,
      fenceKey: `fence-secret-${number}`,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `delivery-secret-${number}`,
      sourceAction: "re_review",
      commandOriginated: number === 960,
      statusMarker: number === 960 ? `status-secret-${number}` : null,
      statusCommentId: number === 960 ? number : null,
      observedAt: now - number,
    });
  }
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "shared-secret",
    EXACT_REVIEW_OPERATOR_SECRET: "operator-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const endpoint =
    "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle-audit/inventory";
  const request = async (body: string, secret = "operator-secret") =>
    worker.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret)
            .update(body)
            .digest("hex")}`,
        },
        body,
      }),
      env,
    );

  const unsigned = await worker.fetch(new Request(endpoint, { method: "POST", body: "{}" }), env);
  assert.equal(unsigned.status, 401);
  const sharedSigned = await request(JSON.stringify({ page_size: 2 }), "shared-secret");
  assert.equal(sharedSigned.status, 401);
  for (const malformedBody of ["", "null", "[]", "true", "{not-json"]) {
    const malformed = await request(malformedBody);
    assert.equal(
      malformed.status,
      400,
      `expected invalid signed body ${JSON.stringify(malformedBody)}`,
    );
  }

  const firstBody = JSON.stringify({ page_size: 2 });
  const first = await request(firstBody);
  assert.equal(first.status, 200);
  const firstInventory = (await first.json()) as {
    exact_review_lifecycle_audit_inventory: {
      collection: { state: string };
      snapshot: { id: string; total_records: number; retention_ms: number } | null;
      page: {
        records: Array<{ target: { number: number }; state: string }>;
        next_cursor: string | null;
      } | null;
    };
  };
  const inventory = firstInventory.exact_review_lifecycle_audit_inventory;
  assert.equal(inventory.collection.state, "complete");
  assert.equal(inventory.snapshot?.total_records, 3);
  assert.equal(inventory.snapshot?.retention_ms, 300_000);
  assert.deepEqual(
    inventory.page?.records.map((record) => record.target.number),
    [960, 961],
  );
  assert.ok(inventory.page?.next_cursor);
  const redacted = JSON.stringify(firstInventory);
  for (const secret of ["fence-secret", "delivery-secret", "status-secret"]) {
    assert.doesNotMatch(redacted, new RegExp(secret));
  }
  assert.doesNotMatch(redacted, /commentId|digest|receiptId|runId/i);

  lifecycle.recordTerminalDisposition({
    canonicalTargetKey: "openclaw/openclaw#962",
    fenceKey: "fence-secret-962",
    revision: 1,
    kind: "dead_letter",
    observedAt: now + 1,
  });
  const nextBody = JSON.stringify({ page_size: 2, cursor: inventory.page?.next_cursor });
  const next = await request(nextBody);
  const nextInventory = (await next.json()) as {
    exact_review_lifecycle_audit_inventory: {
      collection: { state: string };
      page: {
        records: Array<{ target: { number: number }; state: string }>;
        next_cursor: string | null;
      } | null;
    };
  };
  assert.equal(next.status, 200);
  assert.equal(nextInventory.exact_review_lifecycle_audit_inventory.collection.state, "complete");
  assert.deepEqual(
    nextInventory.exact_review_lifecycle_audit_inventory.page?.records.map((record) => [
      record.target.number,
      record.state,
    ]),
    [[962, "pending"]],
  );
  assert.equal(nextInventory.exact_review_lifecycle_audit_inventory.page?.next_cursor, null);

  const invalid = await request(JSON.stringify({ page_size: 101 }));
  assert.equal(invalid.status, 400);
  const expiredAt = Date.now() - 1;
  storage.sql.exec(
    "UPDATE exact_review_lifecycle_audit_snapshots_v1 SET created_at = ?, expires_at = ?",
    expiredAt - 300_000,
    expiredAt,
  );
  const replacement = await request(firstBody);
  assert.equal(
    replacement.status,
    200,
    "a new snapshot prunes expired rows but retains a stale tombstone",
  );
  const stale = await request(nextBody);
  const staleInventory = (await stale.json()) as {
    exact_review_lifecycle_audit_inventory: { collection: { state: string; reason: string } };
  };
  assert.equal(stale.status, 200);
  assert.deepEqual(staleInventory.exact_review_lifecycle_audit_inventory.collection, {
    state: "unknown",
    reason: "stale",
  });
});

test("apply observability accepts signed durable events and exposes the API summary", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace({
    fetch: (request: Request, init?: RequestInit) =>
      store.fetch(init ? new Request(request, init) : request),
  });
  const secret = "apply-observability-secret";
  const now = new Date().toISOString();
  const body = JSON.stringify({
    event: {
      schema_version: 1,
      repo: "openclaw/openclaw",
      run_id: "98765",
      run_attempt: 1,
      occurred_at: now,
      started_at: now,
      lifecycle_started: true,
      outcome: "success",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/98765",
      queue: {
        active: 1,
        capacity: 1,
        ready: 2,
        backoff: null,
        dispatching: 0,
        leased: null,
        oldest_ready_age_seconds: 60,
        oldest_backoff_age_seconds: null,
        oldest_lease_age_seconds: null,
      },
      arrivals: null,
      results: { applied: 2, closed: 1, superseded: null, retried: null, dead_lettered: null },
      lease: { wait_ms: null, hold_ms: null },
      observed_failure_kinds: ["safe_close_blocked"],
      failures: [{ kind: "safe_close_blocked", at: now }],
    },
  });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const env = {
    STATUS_STORE: namespace,
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    APPLY_TARGET_REPOS: "openclaw/openclaw",
    APPLY_OPTIONAL_TARGET_REPOS: "openclaw/clawhub",
  };
  const publicQueryMarker = ["synthetic", "apply", "filter"].join("_");
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/apply-observability", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
    }),
    env,
  );
  assert.equal(accepted.status, 200);
  const summary = await (
    await worker.fetch(
      new Request(
        `https://clawsweeper.openclaw.ai/api/apply-observability?range=24h&repo=${publicQueryMarker}`,
      ),
      env,
    )
  ).json();
  assert.equal(summary.event_count, 1);
  assert.equal(summary.queue.ready, 2);
  assert.equal(summary.last_60_minutes.closed, 1);
  assert.equal(summary.failures.safe_close_blocked, 1);
  assert.equal(Object.hasOwn(summary, "repositories"), false);
  assert.equal(JSON.stringify(summary).includes(publicQueryMarker), false);

  const staleClawhubPayload = JSON.parse(body);
  staleClawhubPayload.event.repo = "openclaw/clawhub";
  staleClawhubPayload.event.run_id = "98766";
  staleClawhubPayload.event.occurred_at = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  staleClawhubPayload.event.started_at = new Date(
    Date.now() - 7 * 60 * 60 * 1000 - 60_000,
  ).toISOString();
  const staleClawhubBody = JSON.stringify(staleClawhubPayload);
  const staleClawhubSignature = `sha256=${createHmac("sha256", secret).update(staleClawhubBody).digest("hex")}`;
  const staleClawhubAccepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/apply-observability", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": staleClawhubSignature,
      },
      body: staleClawhubBody,
    }),
    env,
  );
  assert.equal(staleClawhubAccepted.status, 200);
  const withoutStaleClawhub = await (
    await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/apply-observability?range=6h"),
      env,
    )
  ).json();
  assert.equal(Object.hasOwn(withoutStaleClawhub, "repositories"), false);

  const runningClawhubPayload = JSON.parse(body);
  runningClawhubPayload.event.repo = "openclaw/clawhub";
  runningClawhubPayload.event.run_id = "987661";
  runningClawhubPayload.event.outcome = "in_progress";
  runningClawhubPayload.event.lifecycle_started = true;
  runningClawhubPayload.event.occurred_at = new Date(
    Date.now() - 6.5 * 60 * 60 * 1000,
  ).toISOString();
  runningClawhubPayload.event.started_at = runningClawhubPayload.event.occurred_at;
  const runningClawhubBody = JSON.stringify(runningClawhubPayload);
  const runningClawhubSignature = `sha256=${createHmac("sha256", secret).update(runningClawhubBody).digest("hex")}`;
  const runningClawhubAccepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/apply-observability", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": runningClawhubSignature,
      },
      body: runningClawhubBody,
    }),
    env,
  );
  assert.equal(runningClawhubAccepted.status, 200);
  const withRunningClawhub = await (
    await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/apply-observability?range=6h"),
      env,
    )
  ).json();
  assert.equal(Object.hasOwn(withRunningClawhub, "repositories"), false);
  assert.equal(withRunningClawhub.telemetry_complete, true);

  const currentClawhubPayload = JSON.parse(body);
  currentClawhubPayload.event.repo = "openclaw/clawhub";
  currentClawhubPayload.event.run_id = "98767";
  const clawhubBody = JSON.stringify(currentClawhubPayload);
  const clawhubSignature = `sha256=${createHmac("sha256", secret).update(clawhubBody).digest("hex")}`;
  const clawhubAccepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/apply-observability", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": clawhubSignature,
      },
      body: clawhubBody,
    }),
    env,
  );
  assert.equal(clawhubAccepted.status, 200);
  const withClawhub = await (
    await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/apply-observability?range=24h"),
      env,
    )
  ).json();
  assert.equal(Object.hasOwn(withClawhub, "repositories"), false);
  assert.equal(withClawhub.telemetry_complete, true);
});

test("apply observability merges bucketed writes with legacy rows without double counting", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace(store);
  const now = Date.now();
  const legacyAt = new Date(now - 2 * 60 * 60_000).toISOString();
  const replacementAt = new Date(now - 60 * 60_000).toISOString();
  const secondAt = new Date(now - 30 * 60_000).toISOString();
  storage.rawPut("apply-observability:openclaw%2Fopenclaw:100:1", {
    value: JSON.stringify(
      applyObservation({ runId: "100", occurredAt: legacyAt, outcome: "in_progress" }),
    ),
    expires_at: now + 60_000,
  });
  for (const event of [
    applyObservation({ runId: "100", occurredAt: replacementAt, closed: 3 }),
    applyObservation({ runId: "101", occurredAt: secondAt, closed: 2 }),
  ]) {
    const accepted = await store.fetch(
      new Request("https://clawsweeper-status-store/apply-observability", {
        method: "POST",
        body: JSON.stringify({ event }),
      }),
    );
    assert.equal(accepted.status, 200);
  }

  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/apply-observability?range=24h"),
    { STATUS_STORE: namespace, APPLY_TARGET_REPOS: "openclaw/openclaw" },
  );
  const summary = await response.json();
  assert.equal(response.status, 200);
  assert.equal(summary.event_count, 2);
  assert.equal(summary.totals.closed, 5);
});

test("apply observability stores a UTC-boundary replay exactly once", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace(store);
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const event = applyObservation({ runId: "102", occurredAt: midnight.toISOString(), closed: 1 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accepted = await store.fetch(
      new Request("https://clawsweeper-status-store/apply-observability", {
        method: "POST",
        body: JSON.stringify({ event }),
      }),
    );
    assert.equal(accepted.status, 200);
  }
  storage.resetGetHistory();

  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/apply-observability?range=24h"),
    { STATUS_STORE: namespace, APPLY_TARGET_REPOS: "openclaw/openclaw" },
  );
  const summary = await response.json();
  assert.equal(summary.event_count, 1);
  assert.equal(summary.totals.closed, 1);
  assert.ok(storage.fetchedKeys("apply-observability:day:").length <= 2);
  const bucketKey = `apply-observability:day:${midnight.toISOString().slice(0, 10)}:openclaw%2Fopenclaw`;
  const bucket = storage.rawGet(bucketKey) as { value: string };
  assert.equal(JSON.parse(bucket.value).length, 1);
});

test("dashboard durable status store persists, expires, and prepends events", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const key = "https://clawsweeper-status-store/snapshot";

  assert.equal((await store.fetch(new Request(key))).status, 404);
  assert.equal(
    (
      await store.fetch(
        new Request(key, {
          method: "PUT",
          body: JSON.stringify({ value: "ready" }),
        }),
      )
    ).status,
    204,
  );
  assert.equal(await (await store.fetch(new Request(key))).text(), "ready");

  await store.fetch(
    new Request("https://clawsweeper-status-store/expired", {
      method: "PUT",
      body: JSON.stringify({ value: "old", expires_at: Date.now() - 1 }),
    }),
  );
  assert.equal(
    (await store.fetch(new Request("https://clawsweeper-status-store/expired"))).status,
    404,
  );

  for (const id of ["first", "second"]) {
    assert.equal(
      (
        await store.fetch(
          new Request("https://clawsweeper-status-store/events", {
            method: "POST",
            body: JSON.stringify({ event: { id }, limit: 2, ttl_seconds: 60 }),
          }),
        )
      ).status,
      200,
    );
  }
  assert.deepEqual(
    JSON.parse(
      await (await store.fetch(new Request("https://clawsweeper-status-store/events"))).text(),
    ),
    [{ id: "second" }, { id: "first" }],
  );

  await store.fetch(
    new Request("https://clawsweeper-status-store/events", {
      method: "PUT",
      body: JSON.stringify({
        value: JSON.stringify([{ id: "expired" }]),
        expires_at: Date.now() - 1,
      }),
    }),
  );
  await store.fetch(
    new Request("https://clawsweeper-status-store/events", {
      method: "POST",
      body: JSON.stringify({ event: { id: "fresh" }, limit: 2, ttl_seconds: 60 }),
    }),
  );
  assert.deepEqual(
    JSON.parse(
      await (await store.fetch(new Request("https://clawsweeper-status-store/events"))).text(),
    ),
    [{ id: "fresh" }],
  );

  await store.fetch(
    new Request("https://clawsweeper-status-store/cold-expired", {
      method: "PUT",
      body: JSON.stringify({ value: "old", expires_at: Date.now() - 1 }),
    }),
  );
  assert.equal(storage.has("cold-expired"), true);
  await store.alarm();
  assert.equal(storage.has("cold-expired"), false);
});

test("dashboard reuses a current snapshot from the matching shared status scope", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot:bay-scope:v2:openclaw%2Fopenclaw",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      workers: [],
      automatic_work: [],
      diagnostics: { errors: [], error_count: 0 },
      bay: {
        timings: {
          sample_kind: "completed_review_journeys",
          source: "durable_exact_review_lifecycles",
          completion_source: "verified_final_review_receipts",
          including_legacy_batch: {
            overall: { average_ms: null, median_ms: null, samples: 0 },
            history: { bucket_minutes: 5, points: [] },
          },
        },
      },
      pipeline: [{ id: "shared-snapshot", arbitrary_count: 41, arbitrary_boolean: true }],
      fleet: {
        active_codex_jobs: 1,
        worker_budget: Number.MAX_SAFE_INTEGER,
        available_slots: -1,
      },
      arbitrary_namespace: { active_codex_jobs: 99, complete: true },
    }),
  );
  let networkRequests = 0;
  globalThis.fetch = async () => {
    networkRequests += 1;
    throw new Error("shared snapshot should avoid GitHub requests");
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CACHE_TTL_SECONDS: "60",
        STATUS_STORE: statusStore,
        PUBLIC_BAY_REPOS: "openclaw/openclaw",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.pipeline[0].id, undefined);
    assert.equal(status.pipeline[0].arbitrary_count, undefined);
    assert.equal(status.pipeline[0].arbitrary_boolean, undefined);
    assert.deepEqual(status.fleet, { active_codex_jobs: 1 });
    assert.equal(status.arbitrary_namespace, undefined);
    assert.equal(status.bay.timings, undefined);
    assert.equal(networkRequests, 0);
    const persisted = String(await statusStore.get("snapshot:bay-scope:v2:openclaw%2Fopenclaw"));
    assert.equal(persisted.includes("arbitrary_count"), false);
    assert.equal(persisted.includes("arbitrary_boolean"), false);
    assert.equal(persisted.includes("arbitrary_namespace"), false);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard rejects a current snapshot from a different public scope", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot:bay-scope:v2:openclaw%2Fopenclaw",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      workers: [],
      automatic_work: [],
      diagnostics: { errors: [], error_count: 0 },
      bay: {
        timings: {
          sample_kind: "completed_review_journeys",
          source: "durable_exact_review_lifecycles",
          completion_source: "verified_final_review_receipts",
          including_legacy_batch: {
            overall: { average_ms: null, median_ms: null, samples: 0 },
            history: { bucket_minutes: 5, points: [] },
          },
        },
      },
      pipeline: [],
      fleet: { active_codex_jobs: 41 },
    }),
  );
  let networkRequests = 0;
  globalThis.fetch = async () => {
    networkRequests += 1;
    throw new Error("scope mismatch must rebuild instead of returning the stored snapshot");
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CACHE_TTL_SECONDS: "60",
        STATUS_STORE: statusStore,
        PUBLIC_BAY_REPOS: "openclaw/clawsweeper",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.ok(networkRequests > 0);
    assert.notEqual(status.fleet.active_codex_jobs, 41);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard isolates fresh edge caches by public Bay scope", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: cache },
  });
  await cache.put(
    new Request("https://clawsweeper.openclaw.ai/api/status-cache/v8/openclaw%2Fopenclaw/fresh"),
    jsonResponse({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      workers: [],
      automatic_work: [],
      diagnostics: { errors: [], error_count: 0 },
      bay: {
        timings: {
          sample_kind: "completed_review_journeys",
          source: "durable_exact_review_lifecycles",
          completion_source: "verified_final_review_receipts",
          including_legacy_batch: {
            overall: { average_ms: null, median_ms: null, samples: 0 },
            history: { bucket_minutes: 5, points: [] },
          },
        },
      },
      pipeline: [],
      fleet: { active_codex_jobs: 41 },
    }),
  );
  let networkRequests = 0;
  globalThis.fetch = async () => {
    networkRequests += 1;
    throw new Error("scope mismatch must bypass the old edge cache");
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      PUBLIC_BAY_REPOS: "openclaw/clawsweeper",
    });
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.ok(networkRequests > 0);
    assert.notEqual(status.fleet.active_codex_jobs, 41);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard refreshes a durable snapshot from an obsolete cache generation", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot:bay-scope:v1:_",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      workers: [],
      automatic_work: [],
      pipeline: [{ id: "legacy-shared-snapshot" }],
      diagnostics: { errors: [], error_count: 0 },
      bay: {
        timings: {
          sample_kind: "completed_review_journeys",
          source: "durable_exact_review_lifecycles",
          completion_source: "verified_final_review_receipts",
        },
      },
      fleet: { active_codex_jobs: 1 },
    }),
  );
  let networkRequests = 0;
  globalThis.fetch = async () => {
    networkRequests += 1;
    throw new Error("fresh collection is intentionally unavailable");
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      { CACHE_TTL_SECONDS: "60", STATUS_STORE: statusStore },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.ok(networkRequests > 0);
    assert.equal(status.bay.timings, undefined);
    assert.deepEqual(status.pipeline, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard does not publish a malformed durable root as the current snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: cache },
  });
  const statusStore = new MemoryKv();
  const marker = "synthetic-malformed-durable-root-marker";
  await statusStore.put(
    "snapshot",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      bay: {
        timings: {
          sample_kind: "completed_review_journeys",
          source: "durable_exact_review_lifecycles",
          completion_source: "verified_final_review_receipts",
        },
      },
      nested: { marker },
    }),
  );
  globalThis.fetch = async () => {
    throw new Error("durable shortcut must avoid external collection");
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      { CACHE_TTL_SECONDS: "60", STATUS_STORE: statusStore },
      { waitUntil: () => undefined },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.public_projection_complete, false);
    assert.equal(body.diagnostics.error_count, 1);
    assert.equal(JSON.stringify(body).includes(marker), false);
    assert.equal(body.freshness.state, "unavailable");
    assert.equal(await statusStore.get("snapshot:bay-scope:v2:_"), null);
    assert.equal(
      await cache.match(new Request("https://clawsweeper.openclaw.ai/api/status-cache/v8/_/stale")),
      undefined,
    );
    assert.equal(
      await cache.match(new Request("https://clawsweeper.openclaw.ai/api/status-cache/v8/_/fresh")),
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard rejects malformed, undated, stale, and future durable snapshots", async () => {
  const now = Date.now();
  const marker = "generated-cache-privacy-marker";
  const cases = [
    "{invalid-json",
    JSON.stringify({ schema_version: 1, bay: {}, marker }),
    JSON.stringify({ schema_version: 1, generated_at: "invalid", bay: {}, marker }),
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date(now - 61_000).toISOString(),
      bay: {},
      marker,
    }),
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date(now + 61_000).toISOString(),
      bay: {},
      marker,
    }),
  ];

  for (const value of cases) {
    const statusStore = new MemoryKv();
    await statusStore.put("snapshot", value);
    assert.equal(await readCachedSnapshot({ STATUS_STORE: statusStore }, 60), null);
  }

  const validStore = new MemoryKv();
  await validStore.put(
    "snapshot",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date(now).toISOString(),
      bay: {
        timings: {
          sample_kind: "completed_review_journeys",
          source: "durable_exact_review_lifecycles",
          completion_source: "verified_final_review_receipts",
        },
      },
    }),
  );
  const first = await readCachedSnapshot({ STATUS_STORE: validStore }, 60);
  const restarted = await readCachedSnapshot({ STATUS_STORE: validStore }, 60);
  assert.equal(first?.bay?.timings?.sample_kind, "completed_review_journeys");
  assert.deepEqual(restarted, first);
  assert.equal(JSON.stringify(first).includes(marker), false);
});

test("dashboard health history persists five-minute samples and serves a bounded range", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace(store);
  const sample = {
    at: new Date().toISOString(),
    status: "degraded",
    queued: 12,
    queued_over_30m: 4,
    oldest_queued_minutes: 75,
    running: 3,
    running_over_150m: 0,
    oldest_running_minutes: 40,
    collection_ok: true,
    exact_review: {
      collection_ok: true,
      review: { pending: 317 },
      publication: { pending: 1502 },
    },
  };

  for (const queued of [12, 14]) {
    const response = await store.fetch(
      new Request("https://clawsweeper-status-store/health-history", {
        method: "POST",
        body: JSON.stringify({ sample: { ...sample, queued } }),
      }),
    );
    assert.equal(response.status, 200);
  }

  await store.fetch(
    new Request("https://clawsweeper-status-store/health-history", {
      method: "POST",
      body: JSON.stringify({
        sample: { ...sample, at: new Date(Date.now() - 8 * 60 * 60_000).toISOString(), queued: 3 },
      }),
    }),
  );

  const sixHourResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/health-history?range=6h"),
    { STATUS_STORE: namespace },
  );
  const sixHourHistory = await sixHourResponse.json();
  assert.equal(sixHourResponse.status, 200);
  assert.equal(sixHourHistory.range, "6h");
  assert.equal(sixHourHistory.retention_days, 7);
  assert.equal(sixHourHistory.samples.length, 1);
  assert.equal(sixHourHistory.samples[0].queued, 14);
  assert.equal(sixHourHistory.samples[0].exact_review.review.pending, 317);
  assert.equal(sixHourHistory.coverage.state, "partial");
  const sixHourExpectedSlots =
    Math.floor(Date.parse(sixHourHistory.coverage.window_ended_at) / (5 * 60_000)) -
    Math.ceil(Date.parse(sixHourHistory.coverage.window_started_at) / (5 * 60_000)) +
    1;
  assert.equal(sixHourHistory.coverage.expected_slots, sixHourExpectedSlots);
  assert.equal(sixHourHistory.coverage.observed_slots, 1);
  assert.equal(sixHourHistory.coverage.usable_slots, 1);
  assert.equal(sixHourHistory.coverage.failed_slots, 0);
  assert.equal(sixHourHistory.coverage.missing_slots, sixHourExpectedSlots - 1);
  assert.ok(sixHourHistory.coverage.largest_gap_slots > 0);
  assert.equal(sixHourHistory.freshness.state, "fresh");
  assert.equal(sixHourHistory.freshness.maximum_age_ms, 12 * 60_000);

  const emptyResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/health-history?range=6h"),
    { STATUS_STORE: new MemoryKv() },
  );
  const emptyHistory = await emptyResponse.json();
  assert.equal(emptyHistory.coverage.state, "unavailable");
  const emptyExpectedSlots =
    Math.floor(Date.parse(emptyHistory.coverage.window_ended_at) / (5 * 60_000)) -
    Math.ceil(Date.parse(emptyHistory.coverage.window_started_at) / (5 * 60_000)) +
    1;
  assert.equal(emptyHistory.coverage.expected_slots, emptyExpectedSlots);
  assert.equal(emptyHistory.coverage.observed_slots, 0);
  assert.equal(emptyHistory.coverage.usable_slots, 0);
  assert.equal(emptyHistory.coverage.failed_slots, 0);
  assert.equal(emptyHistory.coverage.missing_slots, emptyExpectedSlots);
  assert.deepEqual(emptyHistory.freshness, {
    state: "unavailable",
    latest_sample_at: null,
    age_ms: null,
    maximum_age_ms: 12 * 60_000,
  });

  for (const [query, expectedRange] of [
    ["24h", "24h"],
    ["7d", "7d"],
    ["invalid", "24h"],
  ]) {
    const response = await worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai/api/health-history?range=${query}`),
      { STATUS_STORE: namespace },
    );
    const history = await response.json();
    assert.equal(history.range, expectedRange);
    assert.equal(history.samples.length, 2);
  }
});

test("health history coverage aligns scheduled slots with an off-boundary query window", () => {
  const interval = 5 * 60_000;
  const rangeMs = 6 * 60 * 60_000;
  const now = Date.UTC(2026, 7, 29, 22, 16, 0);
  const firstSlot = Math.ceil((now - rangeMs) / interval);
  const lastSlot = Math.floor(now / interval);
  const samples = Array.from({ length: lastSlot - firstSlot + 1 }, (_, index) => ({
    at: new Date((firstSlot + index) * interval).toISOString(),
    exact_review: { collection_ok: true },
  }));

  const contract = publicHealthHistoryContract("6h", samples, now);
  assert.equal(contract.coverage.state, "complete");
  assert.equal(contract.coverage.expected_slots, 72);
  assert.equal(contract.coverage.observed_slots, 72);
  assert.equal(contract.coverage.usable_slots, 72);
  assert.equal(contract.coverage.failed_slots, 0);
  assert.equal(contract.coverage.missing_slots, 0);
  assert.equal(contract.coverage.window_started_at, new Date(now - rangeMs).toISOString());
  assert.equal(contract.coverage.window_ended_at, new Date(now).toISOString());
});

test("health history coverage separates failed exact-review polls from usable telemetry", () => {
  const interval = 5 * 60_000;
  const rangeMs = 6 * 60 * 60_000;
  const now = Date.UTC(2026, 7, 29, 22, 16, 0);
  const firstSlot = Math.ceil((now - rangeMs) / interval);
  const lastSlot = Math.floor(now / interval);
  const samples = Array.from({ length: lastSlot - firstSlot + 1 }, (_, index) => ({
    at: new Date((firstSlot + index) * interval).toISOString(),
    exact_review: { collection_ok: index < 2 },
  }));

  const contract = publicHealthHistoryContract("6h", samples, now);
  assert.equal(contract.coverage.state, "partial");
  assert.equal(contract.coverage.observed_slots, 72);
  assert.equal(contract.coverage.usable_slots, 2);
  assert.equal(contract.coverage.failed_slots, 70);
  assert.equal(contract.coverage.missing_slots, 0);
  assert.equal(contract.coverage.coverage_percent, 2.78);
  assert.equal(contract.coverage.largest_gap_slots, 70);
  assert.equal(contract.freshness.state, "stale");
  assert.equal(contract.freshness.latest_sample_at, samples[1].at);

  const unavailable = publicHealthHistoryContract(
    "6h",
    samples.map((sample) => ({ ...sample, exact_review: { collection_ok: false } })),
    now,
  );
  assert.equal(unavailable.coverage.state, "unavailable");
  assert.equal(unavailable.coverage.observed_slots, 72);
  assert.equal(unavailable.coverage.usable_slots, 0);
  assert.equal(unavailable.coverage.failed_slots, 72);
  assert.equal(unavailable.freshness.state, "unavailable");
  assert.equal(unavailable.freshness.latest_sample_at, null);

  const legacyOnly = publicHealthHistoryContract(
    "6h",
    samples.map(({ at }) => ({ at, status: "healthy", collection_ok: true })),
    now,
  );
  assert.equal(legacyOnly.coverage.state, "unavailable");
  assert.equal(legacyOnly.coverage.observed_slots, 0);
  assert.equal(legacyOnly.coverage.usable_slots, 0);
  assert.equal(legacyOnly.coverage.failed_slots, 0);
  assert.equal(legacyOnly.coverage.missing_slots, 72);
});

test("dashboard health history deduplicates and caps malformed legacy cardinality", async () => {
  const now = Date.now();
  const marker = "synthetic-history-private-marker";
  const rows = Array.from({ length: 500 }, (_, index) => ({
    at: new Date(now - (index % 361) * 60_000).toISOString(),
    status: "healthy",
    queued: index % 10,
    queued_over_30m: 0,
    oldest_queued_minutes: 0,
    running: 0,
    running_over_150m: 0,
    oldest_running_minutes: 0,
    collection_ok: true,
    private_value: marker,
  }));
  rows.push({
    ...rows[0],
    at: new Date(now + 60_000).toISOString(),
    private_value: marker,
  });
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const day = row.at.slice(0, 10);
    const values = byDay.get(day) || [];
    values.push(row);
    byDay.set(day, values);
  }
  const statusStore = new MemoryKv();
  for (const [day, values] of byDay) {
    await statusStore.put(`health-history:${day}`, JSON.stringify(values));
  }

  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/health-history?range=6h"),
    { STATUS_STORE: statusStore },
  );
  const history = await response.json();
  const slots = history.samples.map((sample) => Math.floor(Date.parse(sample.at) / (5 * 60_000)));
  assert.ok(history.samples.length <= 73);
  assert.equal(new Set(slots).size, slots.length);
  assert.ok(history.samples.every((sample) => Date.parse(sample.at) <= now));
  assert.equal(JSON.stringify(history).includes(marker), false);
});

test("dashboard cron records only exact-review history without GitHub queries", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace(store);
  const requests: string[] = [];
  let queueReads = 0;
  const exactReviewQueue = {
    idFromName: () => "global",
    get: () => ({
      fetch: async () => {
        queueReads += 1;
        return jsonResponse({
          handoff_health: { status: "healthy" },
          lanes: {
            review: {
              pending: 17,
              enqueued_total: 101,
              completed_total: 83,
              shed_since_reset: 5,
            },
            publication: { pending: 29, enqueued_total: 157, completed_total: 123 },
          },
        });
      },
    }),
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    assert.equal(url.pathname, "/repos/openclaw/clawsweeper/actions/runs");
    const status = url.searchParams.get("status");
    return jsonResponse({
      workflow_runs:
        status === "queued"
          ? Array.from({ length: 100 }, (_, index) => ({
              id: 9001 + index,
              name: "repair cluster worker",
              display_title: "repair cluster worker",
              status: "queued",
              created_at: isoAgo((index === 0 ? 40 : 10) * 60_000),
            }))
          : [],
    });
  };
  let recording: Promise<unknown> | undefined;
  try {
    await worker.scheduled(
      {},
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        EXACT_REVIEW_QUEUE: exactReviewQueue,
        STATUS_STORE: namespace,
      },
      { waitUntil: (promise) => (recording = promise) },
    );
    await recording;
    assert.equal(requests.length, 0);
    assert.equal(queueReads, 1);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/health-history?range=24h"),
      { STATUS_STORE: namespace },
    );
    const history = await response.json();
    assert.equal(history.samples.length, 1);
    assert.equal(history.samples[0].status, undefined);
    assert.equal(history.samples[0].queued, undefined);
    assert.equal(history.samples[0].exact_review.collection_ok, true);
    assert.equal(history.samples[0].exact_review.review.pending, 17);
    assert.equal(history.samples[0].exact_review.review.enqueued_total, 101);
    assert.equal(history.samples[0].exact_review.review.completed_total, 83);
    assert.equal(history.samples[0].exact_review.review.shed_total, 5);
    assert.equal(history.samples[0].exact_review.publication.pending, 29);
    assert.equal(history.samples[0].exact_review.publication.enqueued_total, 157);
    assert.equal(history.samples[0].exact_review.publication.completed_total, 123);

    let failureRecording: Promise<unknown> | undefined;
    await worker.scheduled(
      {},
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        EXACT_REVIEW_QUEUE: {
          idFromName: () => "global",
          get: () => ({ fetch: async () => Promise.reject(new Error("queue unavailable")) }),
        },
        STATUS_STORE: namespace,
      },
      { waitUntil: (promise) => (failureRecording = promise) },
    );
    await failureRecording;
    const afterFailure = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/health-history?range=6h"),
      { STATUS_STORE: namespace },
    );
    const failedQueueHistory = await afterFailure.json();
    assert.equal(failedQueueHistory.samples.length, 1);
    assert.equal(failedQueueHistory.samples[0].queued, undefined);
    assert.deepEqual(failedQueueHistory.samples[0].exact_review, { collection_ok: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("optional exact-review telemetry failures do not freeze an idle status snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot:bay-scope:v2:_",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      workers: [],
      automatic_work: [],
      bay: {
        timings: {
          sample_kind: "completed_review_journeys",
          source: "durable_exact_review_lifecycles",
          completion_source: "verified_final_review_receipts",
          including_legacy_batch: {
            overall: { average_ms: null, median_ms: null, samples: 0 },
            history: { bucket_minutes: 5, points: [] },
          },
        },
      },
      pipeline: [],
      recent: {},
      fleet: { active_workflow_runs: 0 },
      diagnostics: { errors: [], error_count: 0 },
    }),
  );
  globalThis.fetch = async () => {
    throw new Error("shared snapshot should avoid GitHub requests");
  };
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  let queueReads = 0;
  const queueWithUnavailableAggregate = {
    fetch: async (request: Request) => {
      queueReads += 1;
      if (new URL(request.url).pathname === "/recent-durable-publication-events") {
        return new Response(JSON.stringify({ error: "queue_read_failed" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return queue.fetch(request);
    },
  };
  const env = {
    CACHE_TTL_SECONDS: "60",
    STATUS_STORE: statusStore,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queueWithUnavailableAggregate),
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.exact_review_queue.pending, 0);
    assert.equal(status.recent_durable_publication_events, null);
    assert.deepEqual(status.diagnostics.errors, []);
    assert.equal(status.diagnostics.exact_review_queue_error, undefined);
    assert.equal(status.diagnostics.recent_durable_publication_events_error, undefined);
    assert.equal(JSON.stringify(status).includes("queue_read_failed"), false);

    const cached = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.headers.get("x-clawsweeper-cache"), "fresh");
    const cachedStatus = await cached.json();
    assert.equal(cachedStatus.exact_review_queue.pending, 0);
    assert.equal(cachedStatus.diagnostics.exact_review_queue_error, undefined);
    assert.equal(cachedStatus.diagnostics.recent_durable_publication_events_error, undefined);
    assert.equal(JSON.stringify(cachedStatus).includes("queue_read_failed"), false);
    assert.equal(queueReads, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("optional queue status failures remain bounded in public and persisted snapshots", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot:bay-scope:v2:_",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      workers: [],
      automatic_work: [],
      bay: {
        timings: {
          sample_kind: "completed_review_journeys",
          source: "durable_exact_review_lifecycles",
          completion_source: "verified_final_review_receipts",
          including_legacy_batch: {
            overall: { average_ms: null, median_ms: null, samples: 0 },
            history: { bucket_minutes: 5, points: [] },
          },
        },
      },
      pipeline: [],
      recent: {},
      fleet: { active_workflow_runs: 0 },
      diagnostics: { errors: [], error_count: 0 },
    }),
  );
  globalThis.fetch = async () => {
    throw new Error("shared snapshot should avoid GitHub requests");
  };
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const rejectionMarker = "synthetic_queue_probe_rejection";
  let queueReads = 0;
  const queueWithUnavailableStatus = {
    fetch: async (request: Request) => {
      queueReads += 1;
      if (new URL(request.url).pathname === "/stats") {
        return new Response(JSON.stringify({ error: rejectionMarker }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return queue.fetch(request);
    },
  };
  const env = {
    CACHE_TTL_SECONDS: "60",
    STATUS_STORE: statusStore,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queueWithUnavailableStatus),
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.exact_review_queue, null);
    assert.equal(status.dashboard_health.conclusion, "needs_attention");
    assert.equal(status.dashboard_health.severity, "amber");
    assert.equal(status.diagnostics.exact_review_queue_error, undefined);
    assert.equal(JSON.stringify(status).includes(rejectionMarker), false);

    const persisted = await statusStore.get("snapshot:bay-scope:v2:_");
    assert.ok(persisted);
    const persistedSnapshot = JSON.parse(persisted);
    assert.equal(persistedSnapshot.exact_review_queue, null);
    assert.equal(persistedSnapshot.dashboard_health.conclusion, "needs_attention");
    assert.equal(persistedSnapshot.dashboard_health.severity, "amber");
    assert.equal(persisted.includes(rejectionMarker), false);
    assert.equal(persisted.includes("exact_review_queue_error"), false);

    const cached = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.headers.get("x-clawsweeper-cache"), "fresh");
    const cachedStatus = await cached.json();
    assert.equal(cachedStatus.exact_review_queue, null);
    assert.equal(cachedStatus.dashboard_health.conclusion, "needs_attention");
    assert.equal(cachedStatus.dashboard_health.severity, "amber");
    assert.equal(cachedStatus.diagnostics.exact_review_queue_error, undefined);
    assert.equal(JSON.stringify(cachedStatus).includes(rejectionMarker), false);
    assert.equal(queueReads, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("optional queue status failure retains the last complete public Bay queue sample", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  globalThis.fetch = async () => {
    throw new Error("shared snapshot should avoid GitHub requests");
  };

  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const enqueue = await queue.fetch(
    buildExactReviewQueueRequest(
      "bay-status-fallback",
      125_204,
      "opened",
      "issue",
      "openclaw/openclaw",
    ),
  );
  assert.equal(enqueue.status, 202);
  const publicQueueResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/exact-review-queue"),
    {
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      PUBLIC_BAY_REPOS: "openclaw/openclaw",
    },
  );
  assert.equal(publicQueueResponse.status, 200);
  const priorExactReviewQueue = await publicQueueResponse.json();
  assert.equal(priorExactReviewQueue.bay_projection.complete, true);
  assert.equal(priorExactReviewQueue.bay_projection.items.length, 1);
  const [priorQueueItem] = priorExactReviewQueue.bay_projection.items;
  assert.deepEqual(
    { ...priorQueueItem, timing: undefined },
    {
      repository: "openclaw/openclaw",
      item_number: 125_204,
      stage: "arriving",
      source: "queue",
      legacy_batch_path: false,
      timing: undefined,
    },
  );
  assert.equal(priorQueueItem.timing.kind, "queue");
  assert.ok(Number.isFinite(Date.parse(priorQueueItem.timing.started_at)));
  const emptyActivityStages = Object.fromEntries(
    Object.keys(priorExactReviewQueue.bay_projection.stages).map((stage) => [stage, 0]),
  );
  priorExactReviewQueue.bay_projection.activity = {
    complete: true,
    queue_stages: { ...emptyActivityStages, arriving: 1 },
    live_stages: { ...emptyActivityStages, reviewing: 1 },
    total: 2,
    items: [
      {
        repository: "openclaw/openclaw",
        item_number: 125_204,
        stage: "reviewing",
        source: "worker",
      },
    ],
  };
  assert.equal(priorExactReviewQueue.bay_projection.activity.complete, true);

  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot:bay-scope:v2:openclaw%2Fopenclaw",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      public_projection_complete: true,
      health: {},
      workers: [],
      automatic_work: [],
      bay: {
        active_census_complete: false,
        timings: {
          sample_kind: "completed_review_journeys",
          source: "durable_exact_review_lifecycles",
          completion_source: "verified_final_review_receipts",
          including_legacy_batch: {
            overall: { average_ms: null, median_ms: null, samples: 0 },
            history: { bucket_minutes: 5, points: [] },
          },
        },
      },
      pipeline: [],
      recent: {},
      fleet: { active_workflow_runs: 0 },
      diagnostics: { errors: [], error_count: 0 },
      exact_review_queue: priorExactReviewQueue,
    }),
  );
  const rejectionMarker = "synthetic_queue_probe_rejection";
  let queueReads = 0;
  const queueWithUnavailableStatus = {
    fetch: async (request: Request) => {
      queueReads += 1;
      if (new URL(request.url).pathname === "/stats") {
        return new Response(JSON.stringify({ error: rejectionMarker }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return queue.fetch(request);
    },
  };
  const env = {
    CACHE_TTL_SECONDS: "60",
    STATUS_STORE: statusStore,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queueWithUnavailableStatus),
    PUBLIC_BAY_REPOS: "openclaw/openclaw",
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.deepEqual(
      status.exact_review_queue.bay_projection.items,
      priorExactReviewQueue.bay_projection.items,
    );
    assert.deepEqual(status.exact_review_queue.bay_projection.activity, {
      complete: false,
      queue_stages: null,
      live_stages: null,
      queue_legacy_batch_stages: null,
      live_legacy_batch_stages: null,
      total: null,
    });
    assert.equal(status.dashboard_health.conclusion, "needs_attention");
    assert.equal(status.dashboard_health.severity, "amber");
    assert.equal(JSON.stringify(status).includes(rejectionMarker), false);

    const persisted = await statusStore.get("snapshot:bay-scope:v2:openclaw%2Fopenclaw");
    assert.ok(persisted);
    const persistedSnapshot = JSON.parse(persisted);
    assert.deepEqual(
      persistedSnapshot.exact_review_queue.bay_projection.items,
      status.exact_review_queue.bay_projection.items,
    );
    assert.deepEqual(
      persistedSnapshot.exact_review_queue.bay_projection.activity,
      status.exact_review_queue.bay_projection.activity,
    );
    assert.equal(persisted.includes(rejectionMarker), false);

    const cached = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.headers.get("x-clawsweeper-cache"), "fresh");
    const cachedStatus = await cached.json();
    assert.deepEqual(
      cachedStatus.exact_review_queue.bay_projection.items,
      status.exact_review_queue.bay_projection.items,
    );
    assert.deepEqual(
      cachedStatus.exact_review_queue.bay_projection.activity,
      status.exact_review_queue.bay_projection.activity,
    );
    assert.equal(queueReads, 2);

    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { default: new MemoryCache() },
    });
    await statusStore.put(
      "snapshot:bay-scope:v2:openclaw%2Fopenclaw",
      JSON.stringify({
        ...JSON.parse(persisted),
        generated_at: new Date(Date.now() - 61_000).toISOString(),
      }),
    );
    const staleRoot = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const staleRootStatus = await staleRoot.json();
    assert.deepEqual(
      staleRootStatus.exact_review_queue.bay_projection.items,
      status.exact_review_queue.bay_projection.items,
    );
    assert.deepEqual(staleRootStatus.exact_review_queue.bay_projection.activity, {
      complete: false,
      queue_stages: null,
      live_stages: null,
      queue_legacy_batch_stages: null,
      live_legacy_batch_stages: null,
      total: null,
    });

    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { default: new MemoryCache() },
    });
    const stalePriorExactReviewQueue = structuredClone(priorExactReviewQueue);
    const staleQueueGeneratedAt = new Date(Date.now() - 901_000).toISOString();
    stalePriorExactReviewQueue.generated_at = staleQueueGeneratedAt;
    stalePriorExactReviewQueue.handoff_health.observed_at = staleQueueGeneratedAt;
    await statusStore.put(
      "snapshot:bay-scope:v2:openclaw%2Fopenclaw",
      JSON.stringify({
        ...JSON.parse(persisted),
        generated_at: new Date().toISOString(),
        exact_review_queue: stalePriorExactReviewQueue,
      }),
    );
    const expired = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const expiredStatus = await expired.json();
    assert.equal(expiredStatus.exact_review_queue, null);

    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { default: new MemoryCache() },
    });
    const unbound = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CACHE_TTL_SECONDS: "60",
        STATUS_STORE: statusStore,
        PUBLIC_BAY_REPOS: "openclaw/openclaw",
      },
      { waitUntil: () => undefined },
    );
    const unboundStatus = await unbound.json();
    assert.equal(unboundStatus.exact_review_queue, null);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard health grades fresh queue telemetry while retaining prior public Bay activity", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  globalThis.fetch = async () => {
    throw new Error("shared snapshot should avoid GitHub requests");
  };

  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const enqueue = await queue.fetch(
    buildExactReviewQueueRequest(
      "bay-status-fresh-health",
      125_205,
      "opened",
      "issue",
      "openclaw/openclaw",
    ),
  );
  assert.equal(enqueue.status, 202);
  const publicQueueResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/exact-review-queue"),
    {
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      PUBLIC_BAY_REPOS: "openclaw/openclaw",
    },
  );
  assert.equal(publicQueueResponse.status, 200);
  const priorExactReviewQueue = await publicQueueResponse.json();
  const emptyActivityStages = Object.fromEntries(
    Object.keys(priorExactReviewQueue.bay_projection.stages).map((stage) => [stage, 0]),
  );
  priorExactReviewQueue.bay_projection.activity = {
    complete: true,
    queue_stages: { ...emptyActivityStages, arriving: 1 },
    live_stages: { ...emptyActivityStages, reviewing: 1 },
    total: 2,
    items: [
      {
        repository: "openclaw/openclaw",
        item_number: 125_205,
        stage: "reviewing",
        source: "worker",
      },
    ],
  };
  const priorActivity = structuredClone(priorExactReviewQueue.bay_projection.activity);
  assert.equal(priorActivity.complete, true);

  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot:bay-scope:v2:openclaw%2Fopenclaw",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      public_projection_complete: true,
      health: {},
      workers: [],
      automatic_work: [],
      bay: {
        active_census_complete: false,
        timings: {
          sample_kind: "completed_review_journeys",
          source: "durable_exact_review_lifecycles",
          completion_source: "verified_final_review_receipts",
          including_legacy_batch: {
            overall: { average_ms: null, median_ms: null, samples: 0 },
            history: { bucket_minutes: 5, points: [] },
          },
        },
      },
      pipeline: [],
      recent: {},
      fleet: { active_workflow_runs: 0 },
      diagnostics: { errors: [], error_count: 0 },
      exact_review_queue: priorExactReviewQueue,
    }),
  );
  const queueWithCriticalPublicationHealth = {
    fetch: async (request: Request) => {
      const response = await queue.fetch(request);
      if (new URL(request.url).pathname !== "/stats") return response;
      const body = await response.json();
      body.lanes.publication.health = {
        ...body.lanes.publication.health,
        status: "critical",
      };
      body.lanes.publication.dead_letters = {
        ...body.lanes.publication.dead_letters,
        open: 2,
      };
      body.review_failure_health = {
        ...body.review_failure_health,
        status: "critical",
        reasons: ["terminal_status_delivery_failed"],
      };
      return jsonResponse(body);
    },
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CACHE_TTL_SECONDS: "60",
        STATUS_STORE: statusStore,
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queueWithCriticalPublicationHealth),
        PUBLIC_BAY_REPOS: "openclaw/openclaw",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.deepEqual(
      status.exact_review_queue.bay_projection.items,
      priorExactReviewQueue.bay_projection.items,
    );
    assert.equal(status.exact_review_queue.bay_projection.activity.complete, true);
    assert.deepEqual(
      status.exact_review_queue.bay_projection.activity.queue_stages,
      priorActivity.queue_stages,
    );
    assert.deepEqual(
      status.exact_review_queue.bay_projection.activity.live_stages,
      priorActivity.live_stages,
    );
    assert.equal(status.exact_review_queue.bay_projection.activity.total, priorActivity.total);
    assert.equal(status.exact_review_queue.lanes.publication.health, undefined);
    assert.equal(status.exact_review_queue.lanes.publication.dead_letters, undefined);
    assert.equal(status.dashboard_health.reasons.includes("publication_critical"), true);
    assert.equal(status.dashboard_health.reasons.includes("publication_dlq_open"), true);
    assert.equal(status.dashboard_health.reasons.includes("review_status_delivery_failed"), true);
    assert.equal(status.dashboard_health.reasons.includes("publication_health_unavailable"), false);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});
