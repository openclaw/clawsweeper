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
  applyObservation,
  isoAgo,
  jsonResponse,
} from "./dashboard-worker-harness.ts";

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

test("durable lifecycle Bay is a pure, redacted per-target-revision reducer snapshot", async () => {
  const now = Date.now();
  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const record = ({
    number,
    revision = 1,
    terminal,
    command = false,
  }: {
    number: number;
    revision?: number;
    terminal?: "review_completed_routed" | "superseded" | "requeue" | "dead_letter";
    command?: boolean;
  }) => {
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${number}`,
      fenceKey: `fence-secret-${number}-${revision}`,
      revision,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `delivery-secret-${number}-${revision}`,
      sourceAction: "re_review",
      commandOriginated: command,
      statusMarker: command ? `status-secret-${number}-${revision}` : null,
      statusCommentId: command ? number : null,
      observedAt: now - 500 + revision,
    });
    if (terminal === "review_completed_routed") {
      lifecycle.recordCanonicalReceipt({
        ...identity,
        outcome: "accepted",
        receiptId: `receipt-secret-${number}-${revision}`,
        observedAt: now - 400 + revision,
      });
      lifecycle.recordRouterReceipt({
        ...identity,
        outcome: "durable",
        receiptId: `router-secret-${number}-${revision}`,
        observedAt: now - 300 + revision,
      });
    }
    if (terminal) {
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: terminal,
        observedAt: now - 200 + revision,
      });
    }
  };

  // A re-review produces a new revision in its own lane; the first revision
  // remains visible as superseded rather than moving backwards.
  record({ number: 910, revision: 1, terminal: "superseded" });
  record({ number: 910, revision: 2 });
  record({ number: 911, terminal: "review_completed_routed", command: true });
  record({ number: 912, terminal: "review_completed_routed" });
  record({ number: 913, terminal: "requeue" });
  record({ number: 914, terminal: "dead_letter" });

  let initialized = 0;
  const queue = new ExactReviewQueue(
    {
      storage,
      blockConcurrencyWhile: async (callback: () => Promise<void>) => {
        initialized += 1;
        return callback();
      },
    },
    {},
  );
  const exec = storage.sql.exec.bind(storage.sql);
  const queries: string[] = [];
  storage.sql.exec = (query: string, ...bindings: unknown[]) => {
    queries.push(query);
    assert.match(query, /^\s*SELECT\s+projection_json\b/i, "Bay route must be read-only");
    assert.deepEqual(bindings, [513]);
    return exec(query, ...bindings);
  };

  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
  );
  const body = (await response.json()) as {
    durable_lifecycle_bay: {
      collection: { state: string };
      inventory: { lifecycle_records: number } | null;
      lanes: Record<string, number> | null;
      sample: { cards: Array<Record<string, unknown>> } | null;
    };
  };
  const snapshot = body.durable_lifecycle_bay;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(initialized, 0, "pure Bay GET must not initialize queue storage");
  assert.equal(queries.length, 1);
  assert.equal(snapshot.collection.state, "complete");
  assert.equal(snapshot.inventory?.lifecycle_records, 6);
  assert.deepEqual(snapshot.lanes, {
    pending: 1,
    acknowledgement_pending: 1,
    completed: 1,
    superseded: 1,
    requeued: 1,
    terminal_attention: 1,
  });
  assert.equal(snapshot.sample?.cards.length, 6);
  const revisions = snapshot.sample?.cards
    .filter(
      (card) => String((card.target as { repository?: string }).repository) === "openclaw/openclaw",
    )
    .map((card) => [
      (card.target as { number: number }).number,
      card.revision,
      card.lane,
      card.terminal_label,
    ]);
  assert.deepEqual(revisions, [
    [910, 2, "pending", null],
    [911, 1, "acknowledgement_pending", null],
    [912, 1, "completed", null],
    [910, 1, "superseded", null],
    [913, 1, "requeued", null],
    [914, 1, "terminal_attention", "dead_letter"],
  ]);
  const publicText = JSON.stringify(body);
  for (const secret of [
    "fence-secret",
    "delivery-secret",
    "status-secret",
    "receipt-secret",
    "router-secret",
  ]) {
    assert.doesNotMatch(publicText, new RegExp(secret));
  }
  assert.doesNotMatch(publicText, /claimGeneration|commentId|digest|cursor/i);
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

test("durable lifecycle Bay keeps ordinary queue initialization available after a pure direct read", async () => {
  const storage = new MemoryDurableStorage();
  let initialized = 0;
  const queue = new ExactReviewQueue(
    {
      storage,
      blockConcurrencyWhile: async (callback: () => Promise<void>) => {
        initialized += 1;
        return callback();
      },
    },
    {},
  );

  const pure = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle-bay"),
  );
  const pureBody = (await pure.json()) as {
    durable_lifecycle_bay: {
      collection: { state: string; reason: string };
      inventory: unknown;
      lanes: unknown;
      sample: unknown;
    };
  };
  assert.equal(pure.status, 200);
  assert.deepEqual(pureBody.durable_lifecycle_bay.collection, {
    state: "unknown",
    reason: "unavailable",
  });
  assert.equal(pureBody.durable_lifecycle_bay.inventory, null);
  assert.equal(pureBody.durable_lifecycle_bay.lanes, null);
  assert.equal(pureBody.durable_lifecycle_bay.sample, null);
  assert.equal(initialized, 0, "pure /lifecycle-bay must bypass initialization");
  assert.equal(storage.sql.hasNormalizedQueue(), false);

  const ordinary = await queue.fetch(
    new Request(
      "https://clawsweeper-exact-review-queue/recent-durable-publication-events?window=24h",
    ),
  );
  const ordinaryBody = (await ordinary.json()) as {
    recent_durable_publication_events: { collection: { state: string; complete: boolean } };
  };
  assert.equal(ordinary.status, 200);
  assert.equal(initialized, 1, "ordinary queue GET must still initialize normally");
  assert.equal(storage.sql.hasNormalizedQueue(), true);
  assert.equal(ordinaryBody.recent_durable_publication_events.collection.state, "complete");
  assert.equal(ordinaryBody.recent_durable_publication_events.collection.complete, true);
});

test("durable lifecycle Bay fail-closes unknown snapshots without partial cards or counts", async () => {
  const assertUnknown = (snapshot: Record<string, unknown>, reason: string) => {
    assert.deepEqual(snapshot.collection, { state: "unknown", reason });
    assert.equal(snapshot.inventory, null);
    assert.equal(snapshot.lanes, null);
    assert.equal(snapshot.sample, null);
  };
  const unavailable = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    {},
  );
  const unavailableBody = (await unavailable.json()) as {
    durable_lifecycle_bay: Record<string, unknown>;
  };
  assert.equal(unavailable.status, 200);
  assertUnknown(unavailableBody.durable_lifecycle_bay, "unavailable");

  const staleQueue = {
    fetch: async () =>
      new Response(
        JSON.stringify({
          durable_lifecycle_bay: {
            version: 1,
            source: "exact-review-lifecycle-projection-v1",
            generated_at: new Date(Date.now() - 60_001).toISOString(),
            freshness: { maximum_age_ms: 60_000 },
            collection: { state: "complete" },
            inventory: { lifecycle_records: 0, target_revisions: 0, unique_targets: 0 },
            lanes: {
              pending: 0,
              acknowledgement_pending: 0,
              completed: 0,
              superseded: 0,
              requeued: 0,
              terminal_attention: 0,
            },
            sample: { limit: 24, returned: 0, omitted: 0, cards: [] },
          },
        }),
      ),
  };
  const stale = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(staleQueue) },
  );
  const staleBody = (await stale.json()) as { durable_lifecycle_bay: Record<string, unknown> };
  assertUnknown(staleBody.durable_lifecycle_bay, "stale");

  const storage = new MemoryDurableStorage();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  storage.sql.exec(
    "INSERT INTO exact_review_lifecycle_projection_v1 (canonical_target_key, revision, fence_key, projection_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    "openclaw/openclaw#950",
    1,
    "malformed-fence",
    "{not-json",
    Date.now(),
  );
  const malformed = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(new ExactReviewQueue({ storage }, {})) },
  );
  const malformedBody = (await malformed.json()) as {
    durable_lifecycle_bay: Record<string, unknown>;
  };
  assertUnknown(malformedBody.durable_lifecycle_bay, "malformed");

  const nestedMalformedStorage = new MemoryDurableStorage();
  const nestedMalformedLifecycle = new ExactReviewLifecycleProjectionStore(nestedMalformedStorage);
  nestedMalformedLifecycle.ensureSchemaSync();
  nestedMalformedStorage.sql.exec(
    "INSERT INTO exact_review_lifecycle_projection_v1 (canonical_target_key, revision, fence_key, projection_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    "openclaw/openclaw#951",
    1,
    "nested-malformed-fence",
    JSON.stringify({
      version: 1,
      canonicalTargetKey: "openclaw/openclaw#951",
      fenceKey: "nested-malformed-fence",
      revision: 1,
      updatedAt: Date.now(),
      admission: null,
    }),
    Date.now(),
  );
  const nestedMalformed = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    {
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(
        new ExactReviewQueue({ storage: nestedMalformedStorage }, {}),
      ),
    },
  );
  const nestedMalformedBody = (await nestedMalformed.json()) as {
    durable_lifecycle_bay: Record<string, unknown>;
  };
  assertUnknown(nestedMalformedBody.durable_lifecycle_bay, "mixed");

  const missingGithubEffectStorage = new MemoryDurableStorage();
  const missingGithubEffectLifecycle = new ExactReviewLifecycleProjectionStore(
    missingGithubEffectStorage,
  );
  missingGithubEffectLifecycle.ensureSchemaSync();
  missingGithubEffectLifecycle.recordAdmission({
    canonicalTargetKey: "openclaw/openclaw#952",
    fenceKey: "missing-github-effect-fence",
    revision: 1,
    deliveryId: "missing-github-effect-delivery",
    sourceAction: "re_review",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    observedAt: Date.now(),
  });
  const missingGithubEffect = missingGithubEffectLifecycle.read(
    "openclaw/openclaw#952",
    "missing-github-effect-fence",
    1,
  );
  assert.ok(missingGithubEffect);
  const missingGithubEffectJson = { ...missingGithubEffect } as Record<string, unknown>;
  delete missingGithubEffectJson.githubEffect;
  missingGithubEffectStorage.sql.exec(
    "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ? WHERE canonical_target_key = ? AND revision = ? AND fence_key = ?",
    JSON.stringify(missingGithubEffectJson),
    "openclaw/openclaw#952",
    1,
    "missing-github-effect-fence",
  );
  const missingGithubEffectResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    {
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(
        new ExactReviewQueue({ storage: missingGithubEffectStorage }, {}),
      ),
    },
  );
  const missingGithubEffectBody = (await missingGithubEffectResponse.json()) as {
    durable_lifecycle_bay: Record<string, unknown>;
  };
  assertUnknown(missingGithubEffectBody.durable_lifecycle_bay, "mixed");

  const cappedStorage = new MemoryDurableStorage();
  const cappedLifecycle = new ExactReviewLifecycleProjectionStore(cappedStorage);
  cappedLifecycle.ensureSchemaSync();
  for (let index = 1; index <= 513; index += 1) {
    cappedLifecycle.recordAdmission({
      canonicalTargetKey: `openclaw/openclaw#${10_000 + index}`,
      fenceKey: `cap-fence-${index}`,
      revision: 1,
      deliveryId: `cap-delivery-${index}`,
      sourceAction: "re_review",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      observedAt: Date.now() - index,
    });
  }
  const overCap = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/durable-lifecycle-bay"),
    {
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(
        new ExactReviewQueue({ storage: cappedStorage }, {}),
      ),
    },
  );
  const overCapBody = (await overCap.json()) as {
    durable_lifecycle_bay: Record<string, unknown>;
  };
  assertUnknown(overCapBody.durable_lifecycle_bay, "over_cap");
});

test("automerge metric ingestion validates before writes and requires durable storage", async () => {
  const statusStore = new MemoryKv();
  const token = ["test", "token"].join("-");
  const env = { INGEST_TOKEN: token, STATUS_STORE: statusStore };
  const request = (body: Record<string, unknown>) =>
    worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.automerge_metric",
          repository: "openclaw/openclaw",
          item_number: 42,
          phase: "activated",
          occurred_at: "2026-07-17T10:00:00Z",
          ...body,
        }),
      }),
      env,
    );

  assert.equal((await request({})).status, 400);
  assert.equal(await statusStore.get("events"), null);
  assert.equal(await statusStore.get("latest-event"), null);

  assert.equal(
    (
      await request({
        event_id: "activation-42",
        session_id: "openclaw/openclaw#42:100:2026-07-17T10:00:00Z",
      })
    ).status,
    503,
  );
  assert.equal(await statusStore.get("events"), null);
  assert.equal(await statusStore.get("latest-event"), null);
});

test("automerge metric events use isolated durable keys and aggregate through the API", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace({
    fetch: (request: Request, init?: RequestInit) =>
      store.fetch(init ? new Request(request, init) : request),
  });
  const token = ["test", "token"].join("-");
  const env = { INGEST_TOKEN: token, STATUS_STORE: namespace };
  const occurredAt = new Date().toISOString();
  for (const eventId of ["terminal-1", "terminal-2"]) {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.automerge_metric",
          event_id: eventId,
          session_id: `openclaw/openclaw#42:${eventId}:${occurredAt}`,
          repository: "openclaw/openclaw",
          item_number: 42,
          phase: "terminal",
          outcome: "merged",
          occurred_at: occurredAt,
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
  }
  const duplicate = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "clawsweeper.automerge_metric",
        event_id: "terminal-1",
        session_id: `openclaw/openclaw#42:terminal-1:${occurredAt}`,
        repository: "openclaw/openclaw",
        item_number: 42,
        phase: "terminal",
        outcome: "maintainer_stopped",
        occurred_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    }),
    env,
  );
  assert.equal(duplicate.status, 200);

  assert.equal(storage.rawHas("automerge-product-metrics:v1"), false);
  assert.equal(storage.rawHas("automerge-product-metrics:v1:id:terminal-1"), true);
  assert.equal(storage.rawHas("automerge-product-metrics:v1:id:terminal-2"), true);
  const metrics = await (
    await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/automerge-metrics?range=6h"),
      env,
    )
  ).json();
  assert.equal(metrics.summary.terminal_sessions, 2);
  assert.equal(metrics.summary.merged_sessions, 2);
});

test("automerge metrics retain bounded pre-window context for spanning sessions", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace(store);
  const now = Date.now();
  const prefix = "automerge-product-metrics:v1:time:";
  const spanningActivationAt = new Date(now - 7 * 60 * 60_000).toISOString();
  const spanningRepairAt = new Date(now - 5 * 60 * 60_000).toISOString();
  const spanningTerminalAt = new Date(now - 60 * 60_000).toISOString();
  const preWindowActivationAt = new Date(now - 9 * 60 * 60_000).toISOString();
  const preWindowTerminalAt = new Date(now - 7 * 60 * 60_000).toISOString();
  const outsideContextAt = new Date(now - 9 * 24 * 60 * 60_000).toISOString();
  const outsideContextKey = `${prefix}${outsideContextAt}:outside-context`;
  storage.rawPut(outsideContextKey, {
    value: "{not-json",
    expires_at: now + 60_000,
  });
  const rows = [
    {
      event_id: "spanning-activation",
      session_id: "openclaw/openclaw#42:spanning",
      repository: "openclaw/openclaw",
      item_number: 42,
      policy_version: "immediate-v1",
      phase: "activated",
      occurred_at: spanningActivationAt,
    },
    {
      event_id: "spanning-repair",
      session_id: "openclaw/openclaw#42:spanning",
      repository: "openclaw/openclaw",
      item_number: 42,
      policy_version: "immediate-v1",
      phase: "repair_completed",
      base_sync: true,
      occurred_at: spanningRepairAt,
    },
    {
      event_id: "spanning-terminal",
      session_id: "openclaw/openclaw#42:spanning",
      repository: "openclaw/openclaw",
      item_number: 42,
      policy_version: "immediate-v1",
      phase: "terminal",
      outcome: "merged",
      occurred_at: spanningTerminalAt,
    },
    {
      event_id: "pre-window-activation",
      session_id: "openclaw/openclaw#43:pre-window",
      repository: "openclaw/openclaw",
      item_number: 43,
      policy_version: "immediate-v1",
      phase: "activated",
      occurred_at: preWindowActivationAt,
    },
    {
      event_id: "pre-window-terminal",
      session_id: "openclaw/openclaw#43:pre-window",
      repository: "openclaw/openclaw",
      item_number: 43,
      policy_version: "immediate-v1",
      phase: "terminal",
      outcome: "merged",
      occurred_at: preWindowTerminalAt,
    },
  ];
  const rowKeys = rows.map((event) => `${prefix}${event.occurred_at}:${event.event_id}`);
  for (const [index, event] of rows.entries()) {
    storage.rawPut(rowKeys[index]!, {
      value: JSON.stringify(event),
      expires_at: now + 60_000,
    });
  }

  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/automerge-metrics?range=6h"),
    { STATUS_STORE: namespace },
  );
  const metrics = await response.json();
  assert.equal(response.status, 200);
  assert.equal(metrics.summary.terminal_sessions, 1);
  assert.equal(metrics.summary.merged_sessions, 1);
  assert.equal(metrics.summary.command_to_merge_p50_ms, 6 * 60 * 60_000);
  assert.equal(metrics.summary.base_sync_p50, 1);
  assert.equal(metrics.sessions[0]?.repairs, 1);
  assert.equal(metrics.sessions[0]?.activation_missing, false);
  assert.deepEqual(storage.listedKeys(prefix), [...rowKeys].sort());
  assert.equal(storage.listedKeys(prefix).includes(outsideContextKey), false);
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
      new Request("https://clawsweeper.openclaw.ai/api/apply-observability?range=24h"),
      env,
    )
  ).json();
  assert.equal(summary.event_count, 1);
  assert.equal(summary.queue.ready, 2);
  assert.equal(summary.last_60_minutes.closed, 1);
  assert.equal(summary.failures.safe_close_blocked, 1);
  assert.deepEqual(
    summary.repositories.map((entry) => entry.repo),
    ["openclaw/openclaw"],
  );

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
  assert.deepEqual(
    withoutStaleClawhub.repositories.map((entry) => entry.repo),
    ["openclaw/openclaw"],
  );

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
  assert.deepEqual(
    withRunningClawhub.repositories.map((entry) => entry.repo),
    ["openclaw/openclaw", "openclaw/clawhub"],
  );
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
  assert.deepEqual(
    withClawhub.repositories.map((entry) => entry.repo),
    ["openclaw/openclaw", "openclaw/clawhub"],
  );
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

  const bayStoreUrl = `https://clawsweeper-status-store/${encodeURIComponent(
    "openclaw-bay:terminal-state:v1",
  )}`;
  for (const number of [501, 502]) {
    const response = await store.fetch(
      new Request(bayStoreUrl, {
        method: "POST",
        body: JSON.stringify({
          attempts: [
            {
              run_id: number,
              job_id: number,
              repository: "openclaw/openclaw",
              item_numbers: [number],
              outcome: "success",
              terminal_outcome: "success",
              completed_at: `2026-07-11T12:00:${String(number - 500).padStart(2, "0")}Z`,
            },
          ],
          closed_items: [],
          generated_at: `2026-07-11T12:00:${String(number - 500).padStart(2, "0")}Z`,
          ttl_seconds: 60,
        }),
      }),
    );
    assert.equal(response.status, 200);
  }
  const persistedBay = JSON.parse(await (await store.fetch(new Request(bayStoreUrl))).text());
  const bayPutsBeforeReplay = storage.putCount("openclaw-bay:terminal-state:v1");
  const replay = await store.fetch(
    new Request(bayStoreUrl, {
      method: "POST",
      body: JSON.stringify({
        attempts: [
          {
            run_id: 502,
            job_id: 502,
            repository: "openclaw/openclaw",
            item_numbers: [502],
            outcome: "success",
            terminal_outcome: "success",
            completed_at: "2026-07-11T12:00:02Z",
          },
        ],
        closed_items: [],
        generated_at: "2026-07-11T12:00:03Z",
        ttl_seconds: 60,
      }),
    }),
  );
  assert.equal(replay.status, 200);
  assert.equal(storage.putCount("openclaw-bay:terminal-state:v1"), bayPutsBeforeReplay);
  assert.equal(JSON.parse(await replay.text()).updated_at, persistedBay.updated_at);
  assert.deepEqual(
    persistedBay.terminal_buffer.map((item: { number: number }) => item.number),
    [501, 502],
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

test("dashboard reuses a current Bay snapshot from the shared status store", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      bay: {
        timings: { sample_kind: "completed_review_journeys" },
      },
      pipeline: [{ id: "shared-snapshot" }],
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
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pipeline[0].id, "shared-snapshot");
    assert.equal(networkRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
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
    "snapshot",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      bay: { timings: { sample_kind: "completed_review_journeys" } },
      pipeline: [],
      fleet: { active_workflow_runs: 0 },
      diagnostics: { errors: [] },
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
    assert.equal(status.diagnostics.exact_review_queue_error, null);
    assert.equal(status.diagnostics.recent_durable_publication_events_error, "queue_read_failed");

    const cached = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.headers.get("x-clawsweeper-cache"), "fresh");
    const cachedStatus = await cached.json();
    assert.equal(cachedStatus.exact_review_queue.pending, 0);
    assert.equal(cachedStatus.diagnostics.exact_review_queue_error, null);
    assert.equal(
      cachedStatus.diagnostics.recent_durable_publication_events_error,
      "queue_read_failed",
    );
    assert.equal(queueReads, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});
