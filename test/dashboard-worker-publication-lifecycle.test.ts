import {
  assert,
  createHash,
  createHmac,
  test,
  worker,
  ExactReviewQueue,
  mergeBayJourneyState,
  ExactReviewPublicationBatchStore,
  ExactReviewDirectPublicationStore,
  validateDirectPublicationPlan,
  commandAcknowledgementState,
  ExactReviewLifecycleProjectionStore,
  lifecycleState,
  ExactReviewLifecycleTelemetryStore,
  MemoryKv,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  jsonResponse,
  signedGithubWebhookRequest,
  createExactReviewAdmissionHarness,
  buildExactReviewQueueRequest,
  exactReviewPublicationOverrides,
  exactReviewQueueStatusSnapshot,
  leasedExactReviewQueueItem,
  leasedExactReviewPublicationItem,
  type ExactReviewQueueItem,
} from "./dashboard-worker-harness.ts";

function publicationPlan(
  itemNumber: number,
  fenceKey: string,
  revision: number,
  claimGeneration: number,
) {
  return {
    canonicalTargetKey: `openclaw/openclaw#${itemNumber}`,
    fenceKey,
    revision,
    sourceSha: "b".repeat(40),
    identity: {
      canonicalTargetKey: `openclaw/openclaw#${itemNumber}`,
      fenceKey,
      revision,
      claimGeneration,
    },
    operations: [
      {
        path: `records/openclaw-openclaw/items/${itemNumber}.md`,
        deleted: false,
        mode: "100644" as const,
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "router" as const },
  };
}

function publicPublicationQueue(storage: MemoryDurableStorage) {
  return new ExactReviewQueue(
    { storage },
    {
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    },
  );
}

test("publication admission retains producer lineage across provenance refresh, batch deletion, and replay", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    {
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
      EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
      EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "1",
    },
  );
  await queue.fetch(new Request("https://queue/stats"));
  const now = Date.now();
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const producer = {
    canonicalTargetKey: "openclaw/openclaw#71",
    fenceKey: "openclaw/openclaw#71",
    revision: 2,
  };
  lifecycle.recordAdmission({
    ...producer,
    deliveryId: "producer-admission",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    triggeredAt: now - 1_000,
    observedAt: now,
  });
  lifecycle.recordReviewResult({
    ...producer,
    claimGeneration: 7,
    runId: "1071",
    runAttempt: 1,
    outcome: "completed",
    observedAt: now,
  });
  const incoming = leasedExactReviewPublicationItem(71, "1071").decision;
  incoming.publication.leaseRevision = 2;
  incoming.publication.claimGeneration = 7;
  incoming.publication.producerDecision.sourceUpdatedAt = new Date(now - 1_000).toISOString();
  const enqueue = (delivery: string) =>
    queue.fetch(
      buildExactReviewQueueRequest(
        delivery,
        71,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/openclaw",
        incoming,
      ),
    );
  assert.equal((await enqueue("publication-admission")).status, 202);
  const fenceKey = "openclaw/openclaw#71@publish:1071:1";
  const link = { fenceKey: producer.fenceKey, revision: 2, claimGeneration: 7 };
  assert.deepEqual(lifecycle.read(producer.canonicalTargetKey, fenceKey, 1)!.producerLineage, link);
  Object.assign(incoming.publication, {
    producerRunId: "2071",
    artifactName: "exact-review-2071-1",
  });
  assert.equal((await enqueue("refreshed-publication-admission")).status, 202);
  const retained = (await storage.get("exact-review-queue")).items[fenceKey];
  assert.equal(retained.decision.publication.producerRunId, "2071");
  assert.equal(retained.revision, 1);
  assert.deepEqual(lifecycle.read(producer.canonicalTargetKey, fenceKey, 1)!.producerLineage, link);
  const post = (owner: ExactReviewQueue, route: string, body: unknown) =>
    owner.fetch(
      new Request(`https://queue/${route}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  const claimedResponse = await post(queue, "publication-batches/claim", {
    claim_id: "lineage-batch",
    lease_owner: "lineage-worker",
    max_items: 1,
    runner_run_id: "9000",
    runner_run_attempt: 1,
    runner_started_at: new Date(now).toISOString(),
  });
  assert.equal(claimedResponse.status, 200);
  const claimed = await claimedResponse.json();
  assert.equal(claimed.claimed, true);
  const generation = claimed.batch.items[0].claim_generation;
  const content = Buffer.from(
    `---\nreview_comment_id: 106\nreview_comment_sha256: ${"a".repeat(64)}\n---\nReviewed.\n`,
  );
  const plan = {
    ...publicationPlan(71, fenceKey, 1, generation),
    operations: [
      {
        path: "records/openclaw-openclaw/items/71.md",
        deleted: false,
        mode: "100644",
        bytes: content.length,
        contentBase64: content.toString("base64"),
      },
    ],
    totalBytes: content.length,
  };
  assert.equal((await post(queue, "publication-batch-results", plan)).status, 202);
  const router = {
    canonical_target_key: producer.canonicalTargetKey,
    fence_key: fenceKey,
    revision: 1,
    outcome: "durable",
    receipt_id: "router-batch:lineage-batch:71",
  };
  assert.equal((await post(queue, "lifecycle/router-receipt", router)).status, 200);
  const completed = await post(queue, "publication-batches/complete", {
    batch_id: "lineage-batch",
    lease_owner: "lineage-worker",
    items: [
      {
        item_key: fenceKey,
        revision: 1,
        claim_generation: generation,
        terminal_outcome: "published",
      },
    ],
  });
  assert.equal(completed.status, 200);
  assert.equal((await storage.get("exact-review-queue")).items[fenceKey], undefined);
  const restarted = publicPublicationQueue(storage);
  for (let replay = 0; replay < 2; replay++)
    assert.equal((await post(restarted, "lifecycle/router-receipt", router)).status, 200);
  const audit = await (await post(restarted, "lifecycle-audit/inventory", {})).json();
  const current = audit.exact_review_lifecycle_audit_inventory.page.records.filter(
    (card) => card.current_revision,
  );
  assert.equal(current.length, 1);
  assert.equal(current[0].revision, 2);
  assert.equal(current[0].state, "completed");
  const physicalProducer = lifecycle.read(producer.canonicalTargetKey, producer.fenceKey, 2)!;
  assert.equal(physicalProducer.terminalDisposition, null);
  assert.deepEqual(physicalProducer.canonicalReceipts, []);
  assert.deepEqual(physicalProducer.claims, []);
  const physicalPublication = lifecycle.read(producer.canonicalTargetKey, fenceKey, 1)!;
  assert.deepEqual(physicalPublication.producerLineage, link);
  assert.equal(physicalPublication.claims[0]!.runId, "9000");
  assert.equal(physicalPublication.claims[0]!.claimGeneration, generation);
  assert.equal(
    new ExactReviewLifecycleTelemetryStore(storage).baySnapshot(Date.now()).terminal!
      .terminal_count,
    1,
  );
});

function restrictedPublicationFixture() {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(74, "1074");
  for (const decision of [item.decision, item.leaseDecision])
    Object.assign(decision, {
      sourceAction: "manual_explicit_review",
      publicationPolicy: "record_comment_only",
    });
  const owner = {
    leaseId: item.leaseId,
    runId: item.claimedRunId,
    runAttempt: item.claimedRunAttempt,
  };
  const plan = (text = "first") => {
    const content = Buffer.from(`---\npublication_policy: record_comment_only\n---\n${text}\n`);
    return {
      ...publicationPlan(74, item.key, 1, 1),
      owner,
      lifecycle: { kind: "router_not_required" as const },
      operations: [
        {
          path: "records/openclaw-openclaw/items/74.md",
          deleted: false,
          mode: "100644" as const,
          bytes: content.length,
          contentBase64: content.toString("base64"),
        },
      ],
      totalBytes: content.length,
    };
  };
  const save = () =>
    storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const post = (queue: ExactReviewQueue, route: string, body: unknown) =>
    queue.fetch(
      new Request(`https://queue.invalid/${route}`, { method: "POST", body: JSON.stringify(body) }),
    );
  return { storage, item, owner, plan, save, post };
}

test("manual publication requires the current lease/run/attempt across ABA and expiry", async () => {
  const { storage, item, owner, plan, save, post } = restrictedPublicationFixture();
  await save();
  const queue = publicPublicationQueue(storage);
  assert.equal((await post(queue, "publication-authority", plan())).status, 200);
  for (const invalid of [
    undefined,
    { ...owner, leaseId: "old-lease" },
    { ...owner, runId: "2074" },
    { ...owner, runAttempt: 2 },
  ]) {
    assert.ok(
      (await post(queue, "publication-authority", { ...plan(), owner: invalid })).status >= 400,
    );
    assert.equal(
      (await post(queue, "publication-results", { ...plan(), owner: invalid })).status,
      409,
    );
  }
  item.leaseId = "new-independent-lease";
  item.claimedRunId = "2074";
  await save();
  assert.equal((await post(queue, "publication-authority", plan())).status, 409);
  assert.equal((await post(queue, "publication-results", plan())).status, 409);
  Object.assign(owner, { leaseId: item.leaseId, runId: item.claimedRunId });
  assert.equal((await post(queue, "publication-authority", plan())).status, 200);
  item.leaseExpiresAt = Date.now() - 1;
  await save();
  assert.equal((await post(queue, "publication-authority", plan())).status, 409);
});

test("manual canonical submission rechecks owner after admission and never adopts a retained receipt", async () => {
  const { storage, item, plan, save, post } = restrictedPublicationFixture();
  await save();
  const queue = publicPublicationQueue(storage);
  assert.equal((await post(queue, "publication-results", plan())).status, 202);
  assert.equal((await (await post(queue, "publication-results", plan())).json()).deduped, true);
  assert.equal((await post(queue, "publication-results", plan("changed retry"))).status, 400);
  // Simulate interruption after canonical accept but before queue handoff.
  // The still-current producer cannot change its already accepted request.
  await save();
  assert.equal((await post(queue, "publication-results", plan("interrupted retry"))).status, 400);
  item.createdAt = Date.now();
  // A real subsequent admission uses the publication head's next revision.
  item.revision = 2;
  item.leaseRevision = 2;
  item.leaseId = "new-independent-lease";
  item.claimedRunId = "2074";
  await save();
  assert.equal((await post(queue, "publication-results", plan())).status, 409);
  // A new request can publish a new review after the earlier request completed.
  const fresh = {
    ...plan("second review"),
    revision: 2,
    identity: { ...plan().identity, revision: 2 },
    owner: { leaseId: item.leaseId, runId: "2074", runAttempt: 1 },
  };
  assert.equal((await (await post(queue, "publication-results", fresh)).json()).accepted, true);
  const store = new ExactReviewDirectPublicationStore(storage);
  assert.match(store.readCanonical("openclaw-openclaw", "items", 74)!.content!, /second review/);
  await storage.put("exact-review-queue", { deliveries: {}, items: {} });
  assert.equal((await post(queue, "publication-results", fresh)).status, 409);

  await save();
  const raced = new ExactReviewQueue(
    { storage },
    {
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => {
        item.leaseId = "changed-during-probe";
        await save();
        return "public";
      },
    },
  );
  assert.equal((await post(raced, "publication-results", fresh)).status, 409);
  assert.match(store.readCanonical("openclaw-openclaw", "items", 74)!.content!, /second review/);
});

test("manual batch publication binds active batch, member, lease owner and runner", async () => {
  const { storage, item, plan, save, post } = restrictedPublicationFixture();
  item.state = "pending";
  await save();
  const queue = publicPublicationQueue(storage);
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  const now = Date.now();
  const batch = batches.claim({
    batchId: "manual-batch",
    leaseOwner: "worker",
    leaseExpiresAt: now + 60_000,
    now,
    maxItems: 1,
    runner: { runId: "2000", runAttempt: 2, startedAt: now },
    candidates: [{ itemKey: item.key, revision: 1 }],
  })!;
  const owner = {
    batchId: batch.batchId,
    leaseOwner: batch.leaseOwner,
    runId: "2000",
    runAttempt: 2,
  };
  const payload = {
    ...plan(),
    owner,
    identity: { ...plan().identity, claimGeneration: batch.items[0]!.claimGeneration },
  };
  assert.equal((await post(queue, "publication-authority", payload)).status, 200);
  for (const invalid of [
    { ...owner, batchId: "other" },
    { ...owner, leaseOwner: "other" },
    { ...owner, runId: "2001" },
    { ...owner, runAttempt: 1 },
  ]) {
    assert.equal(
      (await post(queue, "publication-authority", { ...payload, owner: invalid })).status,
      409,
    );
    assert.equal(
      (await post(queue, "publication-batch-results", { ...payload, owner: invalid })).status,
      409,
    );
  }
  assert.equal(
    (
      await post(queue, "publication-authority", {
        ...payload,
        identity: { ...payload.identity, claimGeneration: payload.identity.claimGeneration + 1 },
      })
    ).status,
    409,
  );
  assert.equal((await post(queue, "publication-batch-results", payload)).status, 202);
  batches.fetch(batch.batchId, batch.leaseOwner, now + 60_001);
  assert.equal((await post(queue, "publication-authority", payload)).status, 409);
  assert.equal((await post(queue, "publication-batch-results", payload)).status, 409);
  const reclaimed = batches.claim({
    batchId: "manual-batch-reclaimed",
    leaseOwner: "next-worker",
    leaseExpiresAt: Date.now() + 60_000,
    now: Date.now(),
    maxItems: 1,
    runner: { runId: "2001", runAttempt: 1, startedAt: Date.now() },
    candidates: [{ itemKey: item.key, revision: 1 }],
  })!;
  const current = {
    ...payload,
    owner: {
      batchId: reclaimed.batchId,
      leaseOwner: reclaimed.leaseOwner,
      runId: "2001",
      runAttempt: 1,
    },
    identity: { ...payload.identity, claimGeneration: reclaimed.items[0]!.claimGeneration },
  };
  assert.notEqual(current.identity.claimGeneration, payload.identity.claimGeneration);
  assert.equal((await post(queue, "publication-authority", payload)).status, 409);
  assert.equal((await post(queue, "publication-authority", current)).status, 200);
  assert.equal(
    (await (await post(queue, "publication-batch-results", current)).json()).deduped,
    true,
  );
});

const NON_ROUTED_TERMINAL_KINDS = [
  "superseded",
  "requeue",
  "dead_letter",
  "target_closed",
  "target_missing",
  "policy_noop",
  "guarded_open",
  "failure",
] as const;

function lifecycleRouterOrderingFixture({
  terminalKind,
  receiptObservedAt,
  terminalObservedAt,
}: {
  terminalKind: (typeof NON_ROUTED_TERMINAL_KINDS)[number];
  receiptObservedAt?: number;
  terminalObservedAt: number;
}) {
  const storage = new MemoryDurableStorage();
  const queue = publicPublicationQueue(storage);
  const store = new ExactReviewLifecycleProjectionStore(storage);
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#706",
    fenceKey: `router-ordering-${terminalKind}`,
    revision: 1,
  };
  store.recordAdmission({
    ...identity,
    deliveryId: identity.fenceKey,
    sourceAction: "legacy_dispatch",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    observedAt: 1,
  });
  store.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "canonical:706:1",
    observedAt: 2,
  });
  if (receiptObservedAt !== undefined) {
    store.recordRouterReceipt({
      ...identity,
      outcome: "durable",
      receiptId: "router:706:1",
      observedAt: receiptObservedAt,
    });
  }
  store.recordTerminalDisposition({
    ...identity,
    kind: terminalKind,
    observedAt: terminalObservedAt,
  });
  const post = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/lifecycle/router-receipt", {
        method: "POST",
        body: JSON.stringify({
          canonical_target_key: identity.canonicalTargetKey,
          fence_key: identity.fenceKey,
          revision: identity.revision,
          outcome: "durable",
          receipt_id: "router:706:1",
        }),
      }),
    );
  const projection = () =>
    store.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!;
  const driverKey = `terminal-finalization:${identity.fenceKey}:${identity.revision}`;
  return { storage, post, projection, driverKey };
}

test("router receipt repair preserves matching later or equal terminal outcomes", async (t) => {
  for (const terminalKind of NON_ROUTED_TERMINAL_KINDS) {
    for (const relation of ["later", "equal"] as const) {
      await t.test(`${terminalKind} ${relation}`, async () => {
        const receiptObservedAt = 10;
        const { storage, post, projection, driverKey } = lifecycleRouterOrderingFixture({
          terminalKind,
          receiptObservedAt,
          terminalObservedAt: relation === "later" ? 11 : receiptObservedAt,
        });
        const before = {
          terminalDisposition: projection().terminalDisposition,
          terminalDispositions: projection().terminalDispositions,
          queue: storage.sql.readNormalizedQueue(),
        };

        assert.equal((await post()).status, 200);
        assert.deepEqual(
          {
            terminalDisposition: projection().terminalDisposition,
            terminalDispositions: projection().terminalDispositions,
            queue: storage.sql.readNormalizedQueue(),
          },
          before,
        );
        assert.equal(projection().routerReceipts[0]?.operationComplete, true);
        assert.equal(storage.sql.readNormalizedQueue().items[driverKey], undefined);
      });
    }
  }
});

test("router receipt repair rejects a terminal older than its matching receipt atomically", async () => {
  const { storage, post, projection } = lifecycleRouterOrderingFixture({
    terminalKind: "policy_noop",
    receiptObservedAt: 11,
    terminalObservedAt: 10,
  });
  const before = { projection: projection(), queue: storage.sql.readNormalizedQueue() };

  assert.equal((await post()).status, 409);
  assert.deepEqual({ projection: projection(), queue: storage.sql.readNormalizedQueue() }, before);
});

test("router receipt repair rejects a receiptless non-requeue terminal atomically", async () => {
  const { storage, post, projection } = lifecycleRouterOrderingFixture({
    terminalKind: "policy_noop",
    terminalObservedAt: 10,
  });
  const before = { projection: projection(), queue: storage.sql.readNormalizedQueue() };

  assert.equal((await post()).status, 409);
  assert.deepEqual({ projection: projection(), queue: storage.sql.readNormalizedQueue() }, before);
});

test("router receipt repair preserves a receiptless requeue", async () => {
  const { storage, post, projection } = lifecycleRouterOrderingFixture({
    terminalKind: "requeue",
    terminalObservedAt: 10,
  });
  const before = {
    terminalDisposition: projection().terminalDisposition,
    terminalDispositions: projection().terminalDispositions,
    queue: storage.sql.readNormalizedQueue(),
  };

  assert.equal((await post()).status, 200);
  assert.deepEqual(
    {
      terminalDisposition: projection().terminalDisposition,
      terminalDispositions: projection().terminalDispositions,
      queue: storage.sql.readNormalizedQueue(),
    },
    before,
  );
  assert.equal(projection().routerReceipts[0]?.operationComplete, true);
});

for (const route of ["router-receipt", "terminal-disposition"] as const) {
  for (const scenario of [
    "plain",
    "requeue",
    "rollback",
    "derived-replay",
    ...(route === "router-receipt"
      ? ["rollback-requeue", "legacy", "legacy-terminal", "legacy-requeue", "legacy-requeue-tied"]
      : ["conflict"]),
  ]) {
    const legacy = scenario.startsWith("legacy");
    const requeue = scenario.includes("requeue");
    const description = legacy
      ? `${scenario} repairs only incomplete effects and marks completion`
      : scenario === "conflict"
        ? "rejects a conflicting terminal operation kind"
        : scenario === "derived-replay"
          ? "reruns derived Bay and scheduling effects after a committed response failure"
          : scenario === "rollback-requeue"
            ? "preserves a newer requeue after the original transaction rolls back"
            : requeue
              ? "after lost response and newer requeue preserves requeue without a driver"
              : scenario === "rollback"
                ? "after a failed driver write applies all effects atomically"
                : "returns ok without changing durable state";
    test(`lifecycle ${route} replay ${description}`, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 2) });
      const storage = new MemoryDurableStorage();
      let queue = publicPublicationQueue(storage);
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/status"));
      const store = new ExactReviewLifecycleProjectionStore(storage);
      const identity = {
        canonicalTargetKey: "openclaw/openclaw#706",
        fenceKey: "lifecycle-post-effect-replay",
        revision: 1,
      };
      store.recordAdmission({
        ...identity,
        deliveryId: "lifecycle-post-effect-replay",
        sourceAction: "legacy_dispatch",
        commandOriginated: true,
        statusMarker:
          "<!-- clawsweeper-command-status:706:re_review:0123456789abcdef0123456789abcdef01234567 -->",
        statusCommentId: 7061,
        observedAt: Date.now(),
      });
      store.recordCanonicalReceipt({
        ...identity,
        outcome: "accepted",
        receiptId: "canonical:706:1",
        observedAt: Date.now(),
      });
      const wireIdentity = {
        canonical_target_key: identity.canonicalTargetKey,
        fence_key: identity.fenceKey,
        revision: identity.revision,
      };
      const payload = JSON.stringify({
        ...wireIdentity,
        ...(route === "router-receipt"
          ? { outcome: "durable", receipt_id: "router-batch:706:1:fence" }
          : { kind: "policy_noop", operation_id: "terminal-batch:706:1:fence" }),
      });
      const post = (target: string, body: string) =>
        worker.fetch(
          new Request(`https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/${target}`, {
            method: "POST",
            headers: {
              "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", "synthetic-replay-secret").update(body).digest("hex")}`,
            },
            body,
          }),
          {
            CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-replay-secret",
            EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
          },
        );
      const projection = () =>
        store.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!;
      const driverKey = `terminal-finalization:${identity.fenceKey}:${identity.revision}`;
      let alarmAttempts = 0;
      if (scenario === "derived-replay") {
        const setAlarm = storage.setAlarm.bind(storage);
        storage.setAlarm = async (at) => {
          alarmAttempts += 1;
          if (alarmAttempts === 1) throw new Error("injected alarm failure");
          await setAlarm(at);
        };
      }

      if (scenario === "rollback" || scenario === "rollback-requeue") {
        const beforeFailure = projection();
        storage.sql.failNext(/INSERT INTO exact_review_queue_items /);
        assert.equal((await post(route, payload)).status, 409);
        assert.deepEqual(projection(), beforeFailure);
        assert.equal(storage.sql.readNormalizedQueue().items[driverKey], undefined);
      }
      if (scenario === "rollback-requeue") {
        t.mock.timers.tick(1_000);
        assert.equal(
          (await post("terminal-disposition", JSON.stringify({ ...wireIdentity, kind: "requeue" })))
            .status,
          200,
        );
        assert.equal(lifecycleState(projection()), "requeue");
      } else if (legacy) {
        store.recordRouterReceipt({
          ...identity,
          outcome: "durable",
          receiptId: "router-batch:706:1:fence",
          observedAt: Date.now(),
        });
        if (scenario === "legacy-terminal") {
          t.mock.timers.tick(1_000);
          store.recordTerminalDisposition({
            ...identity,
            kind: "review_completed_routed",
            observedAt: Date.now(),
          });
        }
        assert.equal(storage.sql.readNormalizedQueue().items[driverKey], undefined);
      } else {
        // Commit the request, then discard its response as if the transport lost it.
        assert.equal(
          (await post(route, payload)).status,
          scenario === "derived-replay" ? 409 : 200,
        );
        assert.ok(storage.sql.readNormalizedQueue().items[driverKey]);
      }
      if (requeue && scenario !== "rollback-requeue") {
        if (scenario !== "legacy-requeue-tied") t.mock.timers.tick(1_000);
        assert.equal(
          (await post("terminal-disposition", JSON.stringify({ ...wireIdentity, kind: "requeue" })))
            .status,
          200,
        );
        assert.equal(lifecycleState(projection()), "requeue");
        assert.equal(storage.sql.readNormalizedQueue().items[driverKey], undefined);
      }
      const before = {
        projection: projection(),
        queue: storage.sql.readNormalizedQueue(),
      };
      // Reconstruct the queue to require durable dedupe rather than process memory.
      queue = publicPublicationQueue(storage);
      if (scenario === "derived-replay") storage.sql.resetQueryHistory();
      t.mock.timers.tick(1_000);
      const replay = await post(route, payload);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).ok, true);
      if (scenario === "rollback-requeue") {
        assert.equal(projection().routerReceipts.length, 1);
        assert.equal(projection().routerReceipts[0].operationComplete, true);
        assert.deepEqual(projection().terminalDisposition, before.projection.terminalDisposition);
        assert.deepEqual(storage.sql.readNormalizedQueue(), before.queue);
        before.projection = projection();
      } else if (legacy) {
        assert.equal(projection().routerReceipts[0].operationComplete, true);
        assert.equal(projection().routerReceipts[0].observedAt, Date.UTC(2026, 8, 2));
        if (requeue) {
          assert.deepEqual(projection().terminalDisposition, before.projection.terminalDisposition);
          assert.deepEqual(storage.sql.readNormalizedQueue(), before.queue);
        } else {
          assert.equal(lifecycleState(projection()), "acknowledgement_pending");
          assert.ok(storage.sql.readNormalizedQueue().items[driverKey]);
        }
        before.projection = projection();
        before.queue = storage.sql.readNormalizedQueue();
        t.mock.timers.tick(1_000);
        assert.equal((await post(route, payload)).status, 200);
      }
      if (requeue) {
        assert.equal(lifecycleState(projection()), "requeue");
        assert.equal(storage.sql.readNormalizedQueue().items[driverKey], undefined);
      }
      assert.deepEqual(
        { projection: projection(), queue: storage.sql.readNormalizedQueue() },
        before,
      );
      if (scenario === "derived-replay") {
        assert.equal(
          storage.sql.queriesMatching(/INSERT INTO exact_review_lifecycle_bay_pending_v2/).length,
          1,
        );
        assert.equal(alarmAttempts, 2);
        assert.ok(await storage.getAlarm());
      }
      if (scenario === "conflict") {
        const conflicting = await post(
          route,
          JSON.stringify({ ...JSON.parse(payload), kind: "requeue" }),
        );
        assert.equal(conflicting.status, 409);
        assert.deepEqual(await conflicting.json(), {
          error: "conflicting_lifecycle_terminal_operation",
        });
        assert.deepEqual(
          { projection: projection(), queue: storage.sql.readNormalizedQueue() },
          before,
        );
      }
      if (route === "router-receipt") {
        const conflicting = await post(
          route,
          JSON.stringify({ ...JSON.parse(payload), outcome: "not_required" }),
        );
        assert.equal(conflicting.status, 409);
        assert.deepEqual(
          { projection: projection(), queue: storage.sql.readNormalizedQueue() },
          before,
        );
      }
      if (requeue && route === "terminal-disposition") {
        for (const operationId of ["terminal-batch:706:2:fence", undefined]) {
          assert.equal(
            (
              await post(
                route,
                JSON.stringify({
                  ...wireIdentity,
                  kind: "policy_noop",
                  operation_id: operationId,
                }),
              )
            ).status,
            200,
          );
          assert.equal(lifecycleState(projection()), "policy_noop");
          assert.ok(storage.sql.readNormalizedQueue().items[driverKey]);
          assert.equal(
            (await post(route, JSON.stringify({ ...wireIdentity, kind: "requeue" }))).status,
            200,
          );
        }
      }
    });
  }
}

for (const scenario of ["conflict", "lifetime", "old-row", "invalid"] as const) {
  test(`lifecycle terminal operation store ${scenario}`, () => {
    const storage = new MemoryDurableStorage();
    const store = new ExactReviewLifecycleProjectionStore(storage);
    const identity = {
      canonicalTargetKey: "openclaw/openclaw#706",
      fenceKey: "terminal-operation-store",
      revision: 1,
    };
    store.recordAdmission({
      ...identity,
      deliveryId: identity.fenceKey,
      sourceAction: "legacy_dispatch",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      observedAt: Date.now(),
    });
    const operation = (index: number) => ({
      ...identity,
      kind: "policy_noop" as const,
      operationId: `terminal-batch:${index}:1:fence`,
      observedAt: Date.now(),
    });
    let projection = store.recordTerminalDisposition(operation(0));
    if (scenario === "lifetime") {
      for (let index = 1; index < 40; index += 1) {
        projection = store.recordTerminalDisposition(operation(index));
      }
      projection = store.recordTerminalDisposition({
        ...identity,
        kind: "requeue",
        observedAt: Date.now() + 1,
      });
      assert.deepEqual(
        projection.terminalOperationIds,
        Array.from({ length: 40 }, (_, index) => ({
          operationId: operation(index).operationId,
          kind: "policy_noop",
        })),
      );
      assert.deepEqual(store.recordTerminalDisposition(operation(0)), projection);
      assert.equal(projection.terminalDisposition?.kind, "requeue");
    } else if (scenario === "old-row") {
      storage.sql.exec(
        "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ?",
        JSON.stringify({ ...projection, terminalOperationIds: undefined }),
      );
      projection = new ExactReviewLifecycleProjectionStore(storage).read(
        identity.canonicalTargetKey,
        identity.fenceKey,
        identity.revision,
      )!;
      assert.deepEqual(projection.terminalOperationIds, []);
    } else if (scenario === "invalid") {
      for (const terminalOperationIds of [
        [operation(0).operationId],
        [
          { operationId: operation(0).operationId, kind: "policy_noop" },
          { operationId: operation(0).operationId, kind: "policy_noop" },
        ],
      ]) {
        storage.sql.exec(
          "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ?",
          JSON.stringify({ ...projection, terminalOperationIds }),
        );
        assert.throws(
          () => store.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision),
          /invalid lifecycle projection row/,
        );
      }
    } else {
      assert.deepEqual(store.recordTerminalDisposition(operation(0)), projection);
      assert.throws(
        () => store.recordTerminalDisposition({ ...operation(0), kind: "requeue" }),
        /conflicting lifecycle terminal operation/,
      );
      assert.deepEqual(
        store.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision),
        projection,
      );
    }
  });
}

test("canonical record operator auth is scoped to items", async () => {
  const webhookSecret = "record-read-webhook-secret";
  const operatorSecret = "record-read-operator-secret";
  const collections = ["items", "closed", "plans", "decision-packets"];
  const record = {
    content: "canonical record",
    digest: createHash("sha256").update("canonical record").digest("hex"),
    revision: 1,
    updatedAt: "2026-08-12T23:38:00.000Z",
  };
  const queue = {
    async fetch(request: Request) {
      assert.match(
        new URL(request.url).pathname,
        /^\/records\/openclaw-openclaw\/(?:items|closed|plans|decision-packets)\/1148$/,
      );
      assert.equal(request.method, "GET");
      return jsonResponse(record);
    },
  };
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret,
    EXACT_REVIEW_OPERATOR_SECRET: operatorSecret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const signedRequest = (secret: string, collection: string) =>
    new Request(
      `https://clawsweeper.openclaw.ai/internal/state/records/openclaw-openclaw/${collection}/1148`,
      {
        headers: {
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update("").digest("hex")}`,
        },
      },
    );

  for (const collection of collections) {
    const operatorRead = await worker.fetch(signedRequest(operatorSecret, collection), env);
    assert.equal(operatorRead.status, collection === "items" ? 200 : 401, collection);
    assert.deepEqual(
      await operatorRead.json(),
      collection === "items" ? record : { error: "invalid_signature" },
    );

    const webhookRead = await worker.fetch(signedRequest(webhookSecret, collection), env);
    assert.equal(webhookRead.status, 200, collection);
    assert.deepEqual(await webhookRead.json(), record);

    const garbageRead = await worker.fetch(
      signedRequest("garbage-record-read-secret", collection),
      env,
    );
    assert.equal(garbageRead.status, 401, collection);
    assert.deepEqual(await garbageRead.json(), { error: "invalid_signature" });
  }

  const operatorOnlyEnv = {
    EXACT_REVIEW_OPERATOR_SECRET: operatorSecret,
    EXACT_REVIEW_QUEUE: env.EXACT_REVIEW_QUEUE,
  };
  const operatorOnlyItem = await worker.fetch(
    signedRequest(operatorSecret, "items"),
    operatorOnlyEnv,
  );
  assert.equal(operatorOnlyItem.status, 200);
  const operatorOnlyClosed = await worker.fetch(
    signedRequest(operatorSecret, "closed"),
    operatorOnlyEnv,
  );
  assert.equal(operatorOnlyClosed.status, 503);
  assert.deepEqual(await operatorOnlyClosed.json(), { error: "webhook_not_configured" });

  const unconfiguredRead = await worker.fetch(signedRequest(operatorSecret, "items"), {
    EXACT_REVIEW_QUEUE: env.EXACT_REVIEW_QUEUE,
  });
  assert.equal(unconfiguredRead.status, 503);
  assert.deepEqual(await unconfiguredRead.json(), { error: "webhook_not_configured" });
});

test("direct publication endpoint authenticates, dedupes, and returns a structured 413", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(701, "7010");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  leased.admissionDeliveryId = "direct-publication-delivery:701";
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = publicPublicationQueue(storage);
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const payload = {
    canonicalTargetKey: "openclaw/openclaw#701",
    fenceKey: "openclaw/openclaw#701",
    revision: 4,
    sourceSha: "b".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#701",
      fenceKey: "openclaw/openclaw#701",
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/701.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "router" },
  };
  const body = JSON.stringify(payload);
  const url = "https://clawsweeper.openclaw.ai/internal/exact-review/publication-results";
  const unsigned = await worker.fetch(new Request(url, { method: "POST", body }), env);
  assert.equal(unsigned.status, 401);

  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  const { sourceSha: _sourceSha, ...missingSourceSha } = payload;
  const missingSourceBody = JSON.stringify(missingSourceSha);
  const missingSourceSignature = `sha256=${createHmac("sha256", "test-secret").update(missingSourceBody).digest("hex")}`;
  const missingSource = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": missingSourceSignature },
      body: missingSourceBody,
    }),
    env,
  );
  assert.equal(missingSource.status, 400);
  assert.deepEqual(await missingSource.json(), {
    error: "direct_publication_source_sha_required",
    fallback_required: true,
  });
  const urlCredentials = ["alice", "hunter2"].join(":");
  const credentialPath = `https://${urlCredentials}@example.invalid/GITHUB_TOKEN=ghp_${"a".repeat(24)}`;
  const invalidPlanBody = JSON.stringify({
    ...payload,
    operations: [{ ...payload.operations[0], path: credentialPath }],
  });
  const invalidPlanSignature = `sha256=${createHmac("sha256", "test-secret").update(invalidPlanBody).digest("hex")}`;
  const invalidPlan = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": invalidPlanSignature },
      body: invalidPlanBody,
    }),
    env,
  );
  assert.equal(invalidPlan.status, 400);
  const invalidPlanResponse = (await invalidPlan.json()) as {
    error: string;
    fallback_required: boolean;
    detail: string;
  };
  assert.deepEqual(invalidPlanResponse, {
    error: "invalid_direct_publication_plan",
    fallback_required: true,
    detail: "invalid bounded state mutation path",
  });
  const dualPrimaryBody = JSON.stringify({
    ...payload,
    totalBytes: 2,
    operations: [
      payload.operations[0],
      {
        ...payload.operations[0],
        path: "records/openclaw-openclaw/closed/701.md",
      },
    ],
  });
  const dualPrimarySignature = `sha256=${createHmac("sha256", "test-secret").update(dualPrimaryBody).digest("hex")}`;
  const dualPrimary = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": dualPrimarySignature },
      body: dualPrimaryBody,
    }),
    env,
  );
  assert.equal(dualPrimary.status, 400);
  assert.deepEqual(await dualPrimary.json(), {
    error: "invalid_direct_publication_plan",
    fallback_required: true,
    detail: "direct publication tuple writes both primary sections",
  });
  for (const expected of [
    { accepted: true, deduped: false },
    { accepted: false, deduped: true },
  ]) {
    const response = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );
    assert.equal(response.status, 202);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, {
      ok: true,
      ...expected,
      superseded: false,
      superseded_revisions: [],
      canonical_target_key: "openclaw/openclaw#701",
      fence_key: "openclaw/openclaw#701",
      state_commit_sha: "do-revision:4",
    });
  }
  assert.equal(
    new ExactReviewLifecycleProjectionStore(storage).read("openclaw/openclaw#701", leased.key, 4)
      ?.admission.deliveryId,
    "direct-publication-delivery:701",
  );
  assert.deepEqual(
    new ExactReviewLifecycleProjectionStore(storage)
      .read("openclaw/openclaw#701", leased.key, 4)
      ?.canonicalReceipts.map((receipt) => receipt.receiptId),
    ["direct-v2:openclaw/openclaw#701:4:accepted", "direct-v2:openclaw/openclaw#701:4:deduped"],
  );
  const directTelemetry = new ExactReviewLifecycleTelemetryStore(storage).summary(Date.now());
  assert.deepEqual(directTelemetry.publication.direct, {
    accepted: 1,
    deduped: 1,
    superseded: 0,
    fallback: 1,
    unknown: 0,
  });
  const directState = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        decision: {
          sourceAction: string;
          publication?: {
            sourceSha: string;
            leaseRevision: number | null;
            claimGeneration: number | null;
            directLifecycle?: { plan: { kind: string }; receiptOutcome: string };
          };
        };
      }
    >;
  };
  assert.equal(
    directState.items[leased.key]?.decision.sourceAction,
    "exact_review_artifact_publish",
  );
  assert.equal(directState.items[leased.key]?.decision.publication?.sourceSha, "b".repeat(40));
  assert.equal(directState.items[leased.key]?.decision.publication?.leaseRevision, 4);
  assert.equal(directState.items[leased.key]?.decision.publication?.claimGeneration, 2);
  assert.deepEqual(directState.items[leased.key]?.decision.publication?.directLifecycle, {
    plan: { kind: "router" },
    receiptOutcome: "accepted",
  });
  const directRecoveryStatus = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });
  assert.equal(
    directRecoveryStatus?.bay_projection.items.find((item) => item.item_number === 701)
      ?.legacy_batch_path,
    false,
  );
  assert.deepEqual(
    {
      ...Array.from(
        storage.sql.exec(
          `SELECT review_completed_total, publication_enqueued_total, publication_completed_total,
                  publication_published_total
             FROM exact_review_queue_metrics`,
        ),
      )[0],
    },
    {
      review_completed_total: 1,
      publication_enqueued_total: 1,
      publication_completed_total: 0,
      publication_published_total: 0,
    },
  );
  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: leased.leaseRevision,
        claim_generation: leased.claimGeneration,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  const finalizedDirectState = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(finalizedDirectState.items[leased.key], undefined);
  assert.deepEqual(
    {
      ...Array.from(
        storage.sql.exec(
          `SELECT publication_completed_total, publication_published_total
             FROM exact_review_queue_metrics`,
        ),
      )[0],
    },
    { publication_completed_total: 1, publication_published_total: 1 },
  );

  const batchLeased = leasedExactReviewPublicationItem(702, "7020");
  const commandProducerDecision = {
    ...batchLeased.decision.publication.producerDecision,
    itemKind: "pull_request" as const,
    sourceEvent: "issues",
    sourceAction: "legacy_dispatch",
    commandStatusMarker: `<!-- clawsweeper-command-status:702:re_review:${"c".repeat(40)} -->`,
    statusCommentId: 7_020,
  };
  batchLeased.decision.publication.producerDecision = commandProducerDecision;
  batchLeased.leaseDecision.publication.producerDecision = commandProducerDecision;
  batchLeased.revision = 4;
  batchLeased.leaseRevision = 4;
  batchLeased.claimGeneration = 2;
  batchLeased.state = "pending";
  const queueState = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof batchLeased>;
  };
  queueState.items[batchLeased.key] = batchLeased;
  await storage.put("exact-review-queue", queueState);
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  const batch = batches.claim({
    batchId: "worker-publication-proof",
    leaseOwner: "proof-worker",
    leaseExpiresAt: Date.now() + 60_000,
    now: Date.now(),
    maxItems: 1,
    candidates: [{ itemKey: batchLeased.key, revision: 4 }],
  });
  const batchMember = batch?.items[0];
  assert.ok(batchMember);
  const batchPayload = {
    ...payload,
    canonicalTargetKey: "openclaw/openclaw#702",
    fenceKey: batchLeased.key,
    identity: {
      canonicalTargetKey: "openclaw/openclaw#702",
      fenceKey: batchLeased.key,
      revision: 4,
      claimGeneration: batchMember.claimGeneration,
    },
    operations: [
      {
        ...payload.operations[0],
        path: "records/openclaw-openclaw/items/702.md",
      },
    ],
  };
  const targetMismatchPayload = {
    ...batchPayload,
    canonicalTargetKey: "openclaw/openclaw#703",
    identity: { ...batchPayload.identity, canonicalTargetKey: "openclaw/openclaw#703" },
    operations: [
      {
        ...batchPayload.operations[0],
        path: "records/openclaw-openclaw/items/703.md",
      },
    ],
  };
  const targetMismatchBody = JSON.stringify(targetMismatchPayload);
  const targetMismatchSignature = `sha256=${createHmac("sha256", "test-secret").update(targetMismatchBody).digest("hex")}`;
  const targetMismatch = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": targetMismatchSignature },
      body: targetMismatchBody,
    }),
    env,
  );
  assert.equal(targetMismatch.status, 409);
  assert.deepEqual(await targetMismatch.json(), {
    error: "direct_publication_fence_not_owned",
    fallback_required: true,
  });
  const batchBody = JSON.stringify(batchPayload);
  const batchSignature = `sha256=${createHmac("sha256", "test-secret").update(batchBody).digest("hex")}`;
  const batchResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": batchSignature },
      body: batchBody,
    }),
    env,
  );
  assert.equal(batchResponse.status, 202);
  assert.deepEqual(await batchResponse.json(), {
    ok: true,
    accepted: true,
    deduped: false,
    superseded: false,
    superseded_revisions: [],
    canonical_target_key: "openclaw/openclaw#702",
    fence_key: batchLeased.key,
    state_commit_sha: "do-revision:4",
  });
  const repeatedBatch = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": batchSignature },
      body: batchBody,
    }),
    env,
  );
  assert.equal((await repeatedBatch.json()).deduped, true);
  const driftedBatchPayload = {
    ...batchPayload,
    operations: [
      {
        ...batchPayload.operations[0],
        contentBase64: "eQ==",
      },
    ],
  };
  const driftedBatchBody = JSON.stringify(driftedBatchPayload);
  const driftedBatchSignature = `sha256=${createHmac("sha256", "test-secret").update(driftedBatchBody).digest("hex")}`;
  const driftedBatch = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": driftedBatchSignature },
      body: driftedBatchBody,
    }),
    env,
  );
  assert.equal(driftedBatch.status, 202);
  assert.deepEqual(await driftedBatch.json(), {
    ok: true,
    accepted: false,
    deduped: true,
    superseded: false,
    superseded_revisions: [],
    canonical_target_key: "openclaw/openclaw#702",
    fence_key: batchLeased.key,
    state_commit_sha: "do-revision:4",
  });
  const retainedCanonical = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/records/openclaw-openclaw/items/702"),
  );
  assert.equal(retainedCanonical.status, 200);
  assert.equal((await retainedCanonical.json()).content, "x");

  const conflictingDirectPayload = {
    ...payload,
    operations: [{ ...payload.operations[0], contentBase64: "eQ==" }],
  };
  const conflictingDirectBody = JSON.stringify(conflictingDirectPayload);
  const conflictingDirectSignature = `sha256=${createHmac("sha256", "test-secret").update(conflictingDirectBody).digest("hex")}`;
  const conflictingDirect = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": conflictingDirectSignature },
      body: conflictingDirectBody,
    }),
    env,
  );
  assert.equal(conflictingDirect.status, 400);
  assert.deepEqual(await conflictingDirect.json(), {
    error: "invalid_direct_publication_plan",
    fallback_required: true,
    detail: "conflicting direct publication retry",
  });
  const wrongFencePayload = {
    ...batchPayload,
    fenceKey: "openclaw/openclaw#702",
    identity: { ...batchPayload.identity, fenceKey: "openclaw/openclaw#702" },
  };
  const wrongFenceBody = JSON.stringify(wrongFencePayload);
  const wrongFenceSignature = `sha256=${createHmac("sha256", "test-secret").update(wrongFenceBody).digest("hex")}`;
  const wrongFence = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": wrongFenceSignature },
      body: wrongFenceBody,
    }),
    env,
  );
  assert.equal(wrongFence.status, 409);
  assert.deepEqual(await wrongFence.json(), {
    error: "direct_publication_fence_not_owned",
    fallback_required: true,
  });
  storage.sql.exec(
    `INSERT INTO exact_review_publication_heads (target_key, source_revision, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(target_key) DO UPDATE SET source_revision = excluded.source_revision`,
    "openclaw/openclaw#702",
    2,
    Date.now(),
  );
  const staleBatch = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-batch-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": batchSignature },
      body: batchBody,
    }),
    env,
  );
  assert.deepEqual(await staleBatch.json(), {
    ok: true,
    accepted: false,
    deduped: false,
    superseded: true,
    superseded_revisions: [],
    canonical_target_key: "openclaw/openclaw#702",
    fence_key: batchLeased.key,
    state_commit_sha: null,
  });
  assert.deepEqual(
    new ExactReviewLifecycleTelemetryStore(storage).summary(Date.now()).publication.batch,
    { accepted: 1, deduped: 1, superseded: 0, retryable: 0, permanent: 0 },
  );
  const afterBatch = (await storage.get("exact-review-queue")) as typeof queueState;
  assert.equal(afterBatch.items[batchLeased.key]?.state, "pending");
  const staleBatchCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/publication-batches/complete", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "worker-publication-proof",
        lease_owner: "proof-worker",
        items: [
          {
            item_key: batchLeased.key,
            revision: 4,
            claim_generation: batchMember.claimGeneration,
            terminal_outcome: "superseded",
          },
        ],
      }),
    }),
  );
  assert.equal(staleBatchCompletion.status, 200);
  assert.equal((await staleBatchCompletion.json()).accepted, 1);
  assert.deepEqual(
    new ExactReviewLifecycleTelemetryStore(storage).summary(Date.now()).publication.batch,
    { accepted: 1, deduped: 1, superseded: 1, retryable: 0, permanent: 0 },
  );

  const recordUrl =
    "https://clawsweeper.openclaw.ai/internal/state/records/openclaw-openclaw/items/701";
  const unsignedRecord = await worker.fetch(new Request(recordUrl), env);
  assert.equal(unsignedRecord.status, 401);
  const emptySignature = `sha256=${createHmac("sha256", "test-secret").update("").digest("hex")}`;
  const recordResponse = await worker.fetch(
    new Request(recordUrl, {
      headers: { "x-clawsweeper-exact-review-signature": emptySignature },
    }),
    env,
  );
  assert.equal(recordResponse.status, 200);
  const record = await recordResponse.json();
  assert.deepEqual(record, {
    content: "x",
    digest: createHash("sha256").update("x").digest("hex"),
    revision: 4,
    updatedAt: record.updatedAt,
  });
  assert.equal(Number.isFinite(Date.parse(record.updatedAt)), true);

  const listingBody = JSON.stringify({
    repoSlug: "openclaw-openclaw",
    section: "items",
    cursor: 0,
    limit: 500,
  });
  const listingSignature = `sha256=${createHmac("sha256", "test-secret").update(listingBody).digest("hex")}`;
  const listingResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/state/records/list", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": listingSignature },
      body: listingBody,
    }),
    env,
  );
  assert.equal(listingResponse.status, 200);
  const listing = await listingResponse.json();
  assert.deepEqual(listing.records, [
    {
      id: 701,
      digest: createHash("sha256").update("x").digest("hex"),
      revision: 4,
      updatedAt: listing.records[0].updatedAt,
    },
    {
      id: 702,
      digest: createHash("sha256").update("x").digest("hex"),
      revision: 4,
      updatedAt: listing.records[1].updatedAt,
    },
  ]);
  assert.equal(listing.nextCursor, null);

  const oversizedBody = JSON.stringify({ ...payload, padding: "x".repeat(4 * 1024 * 1024) });
  const oversizedSignature = `sha256=${createHmac("sha256", "test-secret").update(oversizedBody).digest("hex")}`;
  const oversized = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": oversizedSignature },
      body: oversizedBody,
    }),
    env,
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {
    error: "direct_publication_payload_too_large",
    max_bytes: 4 * 1024 * 1024,
    fallback_required: true,
  });
});

test("canonical publication rechecks public visibility before direct and batch acceptance", async () => {
  for (const route of ["direct", "batch"] as const) {
    for (const transition of ["private", "internal", "retryable"] as const) {
      const itemNumber =
        7_100 +
        (route === "batch" ? 10 : 0) +
        (transition === "private" ? 1 : transition === "internal" ? 2 : 3);
      const storage = new MemoryDurableStorage();
      const item =
        route === "batch"
          ? leasedExactReviewPublicationItem(itemNumber, `${itemNumber}0`)
          : leasedExactReviewQueueItem(itemNumber, `${itemNumber}0`);
      item.revision = 4;
      item.leaseRevision = 4;
      item.claimGeneration = 2;
      if (route === "batch") item.state = "pending";
      await storage.put("exact-review-queue", {
        deliveries: {},
        items: { [item.key]: item },
      });
      const queue = new ExactReviewQueue(
        { storage },
        {
          hostedTargetPredicate: () => true,
          hostedPublicTargetProbe: async () =>
            transition === "retryable" ? "retryable" : "terminal",
        },
      );
      let claimGeneration = 2;
      if (route === "batch") {
        const batch = new ExactReviewPublicationBatchStore(storage).claim({
          batchId: `visibility-${transition}`,
          leaseOwner: "publication-worker",
          leaseExpiresAt: Date.now() + 60_000,
          now: Date.now(),
          maxItems: 1,
          candidates: [{ itemKey: item.key, revision: 4 }],
        });
        assert.ok(batch?.items[0]);
        claimGeneration = batch.items[0].claimGeneration;
      }
      const response = await queue.fetch(
        new Request(
          `https://clawsweeper-exact-review-queue/${
            route === "batch" ? "publication-batch-results" : "publication-results"
          }`,
          {
            method: "POST",
            body: JSON.stringify(publicationPlan(itemNumber, item.key, 4, claimGeneration)),
          },
        ),
      );

      assert.equal(response.status, transition === "retryable" ? 503 : 202);
      assert.deepEqual(
        await response.json(),
        transition === "retryable"
          ? { error: "target_visibility_unverified", retryable: true }
          : {
              ok: true,
              accepted: false,
              deduped: false,
              superseded: true,
              superseded_revisions: [],
              canonical_target_key: `openclaw/openclaw#${itemNumber}`,
              fence_key: item.key,
              state_commit_sha: null,
            },
      );
      assert.equal(
        (
          await queue.fetch(
            new Request(
              `https://clawsweeper-exact-review-queue/records/openclaw-openclaw/items/${itemNumber}`,
            ),
          )
        ).status,
        404,
      );
      const retained = (await storage.get("exact-review-queue")) as {
        items: Record<string, { state: string; leaseId?: string; revision: number }>;
      };
      assert.equal(retained.items[item.key]?.state, route === "batch" ? "pending" : "leased");
      assert.equal(retained.items[item.key]?.revision, 4);
      if (route === "direct") assert.equal(retained.items[item.key]?.leaseId, item.leaseId);
      assert.equal(
        Number(
          Array.from(
            storage.sql.exec("SELECT COUNT(*) AS count FROM exact_review_direct_publication_plans"),
          )[0]?.count ?? 0,
        ),
        0,
      );
      if (route === "batch") {
        assert.equal(
          new ExactReviewPublicationBatchStore(storage).ownsActiveFence(
            { itemKey: item.key, revision: 4, claimGeneration },
            Date.now(),
          ),
          true,
        );
      }
    }
  }
});

test("canonical publication rejects direct and batch fence replay after its public probe", async () => {
  for (const route of ["direct", "batch"] as const) {
    const itemNumber = route === "direct" ? 7_121 : 7_122;
    const storage = new MemoryDurableStorage();
    const item =
      route === "batch"
        ? leasedExactReviewPublicationItem(itemNumber, `${itemNumber}0`)
        : leasedExactReviewQueueItem(itemNumber, `${itemNumber}0`);
    item.revision = 4;
    item.leaseRevision = 4;
    item.claimGeneration = 2;
    if (route === "batch") item.state = "pending";
    await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
    let releaseProbe!: () => void;
    let signalProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      signalProbe = resolve;
    });
    const probeRelease = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const queue = new ExactReviewQueue(
      { storage },
      {
        hostedTargetPredicate: () => true,
        hostedPublicTargetProbe: async () => {
          signalProbe();
          await probeRelease;
          return "public";
        },
      },
    );
    let claimGeneration = 2;
    if (route === "batch") {
      const batch = new ExactReviewPublicationBatchStore(storage).claim({
        batchId: "fence-race",
        leaseOwner: "publication-worker",
        leaseExpiresAt: Date.now() + 60_000,
        now: Date.now(),
        maxItems: 1,
        candidates: [{ itemKey: item.key, revision: 4 }],
      });
      assert.ok(batch?.items[0]);
      claimGeneration = batch.items[0].claimGeneration;
    }
    const pending = queue.fetch(
      new Request(
        `https://clawsweeper-exact-review-queue/${
          route === "batch" ? "publication-batch-results" : "publication-results"
        }`,
        {
          method: "POST",
          body: JSON.stringify(publicationPlan(itemNumber, item.key, 4, claimGeneration)),
        },
      ),
    );
    await probeStarted;
    if (route === "batch") {
      new ExactReviewPublicationBatchStore(storage).activeLeaseSnapshot(Date.now() + 60_000);
    } else {
      const state = (await storage.get("exact-review-queue")) as {
        items: Record<string, { revision: number }>;
      };
      state.items[item.key]!.revision = 5;
      await storage.put("exact-review-queue", state);
    }
    releaseProbe();

    const response = await pending;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "direct_publication_fence_not_owned",
      fallback_required: true,
    });
    assert.equal(
      (
        await queue.fetch(
          new Request(
            `https://clawsweeper-exact-review-queue/records/openclaw-openclaw/items/${itemNumber}`,
          ),
        )
      ).status,
      404,
    );
  }
});

test("direct publication keeps GitHub casing while using lowercase canonical record slugs", async () => {
  const fixtures = [
    {
      targetRepo: "steipete/CodexBar",
      inputRepoSlug: "steipete-CodexBar",
      repoSlug: "steipete-codexbar",
      itemNumber: 2831,
    },
    {
      targetRepo: "openclaw/Peekaboo",
      inputRepoSlug: "openclaw-peekaboo",
      repoSlug: "openclaw-peekaboo",
      itemNumber: 364,
    },
  ] as const;
  const storage = new MemoryDurableStorage();
  const items: Record<string, ReturnType<typeof leasedExactReviewQueueItem>> = {};
  for (const fixture of fixtures) {
    const leased = leasedExactReviewQueueItem(fixture.itemNumber, String(fixture.itemNumber));
    leased.key = `${fixture.targetRepo}#${fixture.itemNumber}`;
    leased.decision.targetRepo = fixture.targetRepo;
    leased.leaseDecision.targetRepo = fixture.targetRepo;
    leased.revision = 4;
    leased.leaseRevision = 4;
    leased.claimGeneration = 2;
    leased.admissionDeliveryId = `mixed-case-direct:${fixture.itemNumber}`;
    items[leased.key] = leased;
  }
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const queue = publicPublicationQueue(storage);
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "mixed-case-direct-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const url = "https://clawsweeper.openclaw.ai/internal/exact-review/publication-results";

  for (const fixture of fixtures) {
    const canonicalTargetKey = `${fixture.targetRepo}#${fixture.itemNumber}`;
    const content = `mixed-case direct publication for ${canonicalTargetKey}\n`;
    const payload = {
      canonicalTargetKey,
      fenceKey: canonicalTargetKey,
      revision: 4,
      sourceSha: "c".repeat(40),
      identity: {
        canonicalTargetKey,
        fenceKey: canonicalTargetKey,
        revision: 4,
        claimGeneration: 2,
      },
      operations: [
        {
          path: `records/${fixture.inputRepoSlug}/items/${fixture.itemNumber}.md`,
          deleted: false,
          mode: "100644",
          bytes: Buffer.byteLength(content),
          contentBase64: Buffer.from(content).toString("base64"),
        },
      ],
      totalBytes: Buffer.byteLength(content),
      lifecycle: { kind: "router" },
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", env.CLAWSWEEPER_WEBHOOK_SECRET).update(body).digest("hex")}`;
    for (const expected of [
      { accepted: true, deduped: false },
      { accepted: false, deduped: true },
    ]) {
      const response = await worker.fetch(
        new Request(url, {
          method: "POST",
          headers: { "x-clawsweeper-exact-review-signature": signature },
          body,
        }),
        env,
      );
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), {
        ok: true,
        ...expected,
        superseded: false,
        superseded_revisions: [],
        canonical_target_key: canonicalTargetKey,
        fence_key: canonicalTargetKey,
        state_commit_sha: "do-revision:4",
      });
    }

    const canonical = await (
      await queue.fetch(
        new Request(`https://queue/records/${fixture.repoSlug}/items/${fixture.itemNumber}`, {
          method: "GET",
        }),
      )
    ).json();
    assert.equal(canonical.content, content);
    assert.equal(canonical.revision, 4);
    if (fixture.inputRepoSlug !== fixture.repoSlug) {
      assert.equal(
        (
          await queue.fetch(
            new Request(
              `https://queue/records/${fixture.inputRepoSlug}/items/${fixture.itemNumber}`,
              { method: "GET" },
            ),
          )
        ).status,
        404,
      );
    }
  }

  const [parallelNamespaceRows] = Array.from(
    storage.sql.exec(
      `SELECT
         (SELECT COUNT(*) FROM exact_review_canonical_records
           WHERE repo_slug = 'steipete-CodexBar') AS canonical_count,
         (SELECT COUNT(*) FROM exact_review_record_export_index
           WHERE repo_slug = 'steipete-CodexBar') AS export_count`,
    ),
  );
  assert.equal(parallelNamespaceRows?.canonical_count, 0);
  assert.equal(parallelNamespaceRows?.export_count, 0);
});

test("fetching a stale publication batch records a durable superseded telemetry outcome", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(719, "7190");
  item.revision = 4;
  item.leaseRevision = 4;
  item.claimGeneration = 2;
  item.state = "pending";
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1", EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "1" },
  );
  const claim = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
        method: "POST",
        body: JSON.stringify({
          claim_id: "fetch-stale-telemetry-batch",
          lease_owner: "fetch-stale-telemetry-owner",
          max_items: 1,
        }),
      }),
    )
  ).json();
  assert.equal(claim.claimed, true);
  storage.sql.exec(
    `INSERT INTO exact_review_publication_heads (target_key, source_revision, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(target_key) DO UPDATE SET source_revision = excluded.source_revision`,
    "openclaw/openclaw#719",
    2,
    Date.now(),
  );
  const fetched = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/publication-batches/fetch", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "fetch-stale-telemetry-batch",
        lease_owner: "fetch-stale-telemetry-owner",
      }),
    }),
  );
  assert.equal(fetched.status, 200);
  const fetchedBody = (await fetched.json()) as { items: unknown[]; superseded: number };
  assert.equal(fetchedBody.superseded, 1);
  assert.deepEqual(fetchedBody.items, []);
  assert.deepEqual(
    new ExactReviewLifecycleTelemetryStore(storage).summary(Date.now()).publication.batch,
    { accepted: 0, deduped: 0, superseded: 1, retryable: 0, permanent: 0 },
  );
});

test("non-batch publication completions record durable terminal outcomes without inferring acceptance", async () => {
  const storage = new MemoryDurableStorage();
  const retryable = leasedExactReviewPublicationItem(720, "7200");
  const permanent = leasedExactReviewPublicationItem(721, "7210");
  const superseded = leasedExactReviewPublicationItem(722, "7220");
  const published = leasedExactReviewPublicationItem(723, "7230");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: Object.fromEntries(
      [retryable, permanent, superseded, published].map((item) => [item.key, item]),
    ),
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = async (
    item: ExactReviewQueueItem,
    outcome: "success" | "failure",
    completionKind: string,
    reasonCode: string,
  ) => {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: item.key,
          lease_revision: item.leaseRevision,
          claim_generation: item.claimGeneration,
          run_id: item.claimedRunId,
          run_attempt: item.claimedRunAttempt,
          outcome,
          completion_kind: completionKind,
          reason_code: reasonCode,
        }),
      }),
    );
    assert.equal(response.status, 200);
  };
  await complete(retryable, "failure", "retryable_failure", "github_transient");
  await complete(permanent, "failure", "permanent_failure", "invalid_artifact");
  await complete(superseded, "success", "superseded", "remote_newer_tuple");
  await complete(published, "success", "published", "publication_applied");

  assert.deepEqual(
    new ExactReviewLifecycleTelemetryStore(storage).summary(Date.now()).publication.batch,
    { accepted: 0, deduped: 0, superseded: 1, retryable: 1, permanent: 1 },
  );
});

test("direct lifecycle requeue becomes a fresh fenced source-drift revision", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(703, "7030");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = publicPublicationQueue(storage);
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const payload = {
    canonicalTargetKey: "openclaw/openclaw#703",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "c".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#703",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/703.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "requeue" },
  };
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": signature },
      body,
    }),
    env,
  );
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).accepted, true);

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
        direct_lifecycle_requeue: true,
        lifecycle_terminal_disposition: "requeue",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: true });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        admissionDeliveryId?: string;
        decision: { sourceAction: string; publication?: unknown };
        leaseId?: string;
        revision: number;
        state: string;
      }
    >;
  };
  const requeued = state.items[leased.key];
  assert.equal(requeued?.state, "pending");
  assert.equal(requeued?.revision, 5);
  assert.equal(requeued?.leaseId, undefined);
  assert.equal(requeued?.decision.sourceAction, "source_drift_requeue");
  assert.equal(requeued?.decision.publication, undefined);
  assert.equal(requeued?.admissionDeliveryId, "direct-lifecycle-requeue:openclaw/openclaw#703:4");
  assert.equal(
    new ExactReviewLifecycleProjectionStore(storage).read("openclaw/openclaw#703", leased.key, 4)
      ?.terminalDisposition?.kind,
    "requeue",
  );
});

async function savedDirectRequeueFixture(
  receipt: "accepted" | "deduped" | "superseded" = "accepted",
  lifecycle = true,
  decisionOverrides: Partial<ExactReviewQueueItem["decision"]> = {},
) {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(705, "7050");
  Object.assign(leased.decision, decisionOverrides);
  Object.assign(leased.leaseDecision, decisionOverrides);
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const post = (route: string, value: unknown, signed = true) => {
    const body = JSON.stringify(value);
    return worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai/internal/exact-review/${route}`, {
        method: "POST",
        headers: signed
          ? {
              "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
            }
          : {},
        body,
      }),
      env,
    );
  };
  const publication = {
    canonicalTargetKey: leased.key,
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "e".repeat(40),
    identity: {
      canonicalTargetKey: leased.key,
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/705.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    ...(lifecycle ? { lifecycle: { kind: "requeue" } } : {}),
  };
  if (receipt !== "accepted") {
    // Seed canonical acceptance without converting this lease, so the signed
    // producer response itself installs a deduped/superseded saved receipt.
    const store = new ExactReviewDirectPublicationStore(storage);
    store.ensureSchemaSync();
    const prior = await validateDirectPublicationPlan(
      receipt === "deduped"
        ? publication
        : {
            ...publication,
            revision: 5,
            identity: { ...publication.identity, revision: 5 },
            lifecycle: { kind: "policy_noop" },
          },
    );
    assert.equal(store.accept(prior, Date.now()).outcome, "accepted");
  }
  const accepted = await post("publication-results", publication);
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json())[receipt], true);
  const readState = async () =>
    (await storage.get("exact-review-queue")) as {
      items: Record<string, ExactReviewQueueItem>;
    };
  if (lifecycle) {
    assert.deepEqual(
      (await readState()).items[leased.key]?.leaseDecision?.publication?.directLifecycle,
      {
        plan: { kind: "requeue" },
        receiptOutcome: receipt,
      },
    );
  }
  const identity = { canonical_target_key: leased.key, fence_key: leased.key, revision: 4 };
  // This write precedes /complete in the real workflow. Receipt acceptance
  // alone does not reproduce a lost final callback.
  if (lifecycle && receipt !== "superseded") {
    const terminal = await post("lifecycle/terminal-disposition", { ...identity, kind: "requeue" });
    assert.equal(terminal.status, 200);
  }
  const projection = () =>
    new ExactReviewLifecycleProjectionStore(storage).read(leased.key, leased.key, 4);
  const counters = () => ({
    ...Array.from(
      storage.sql.exec(
        "SELECT review_completed_total, publication_retried_total, publication_enqueued_total, publication_completed_total FROM exact_review_queue_metrics",
      ),
    )[0],
  });
  const complete = {
    lease_id: leased.leaseId,
    item_key: leased.key,
    lease_revision: 4,
    claim_generation: 2,
    run_id: leased.claimedRunId,
    run_attempt: leased.claimedRunAttempt,
    outcome: "success",
    completion_kind: "published",
    reason_code: "publication_applied",
    direct_lifecycle_requeue: true,
    lifecycle_terminal_disposition: "requeue",
  };
  const terminalRun = {
    run_id: leased.claimedRunId,
    run_attempt: leased.claimedRunAttempt,
    claimed_run_attempt: leased.claimedRunAttempt,
    claim_generation: 2,
    outcome: "success",
  };
  return { storage, queue, leased, post, readState, projection, counters, complete, terminalRun };
}

test("all exact-review recovery paths preserve proof authority and the complete producer context", async (t) => {
  for (const sourceAction of [
    "command_proof_result",
    "failed_review_shard_recovery",
    "opened",
    "command_proof_result_extra",
  ]) {
    const producerDecision: ExactReviewQueueItem["decision"] = {
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      itemNumber: 705,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction,
      supersedesInProgress: false,
      sourceHeadSha: "a".repeat(40),
      sourceBaseSha: "c".repeat(40),
      sourceDeliveryId: "command-proof-request",
      sourceCommentId: 200,
      sourceCommentUpdatedAt: "2026-09-04T10:00:00Z",
      commandBodyDigest: "e".repeat(64),
      commandOrigin: "comment_router",
      sourceCommentVerified: true,
      commandStatusMarker:
        "<!-- clawsweeper-command-status:705:request_proof:" + "d".repeat(64) + " -->",
      additionalPrompt:
        "<!-- command-proof-assessment-v1 head=" +
        "a".repeat(40) +
        " body=" +
        "b".repeat(64) +
        " base=" +
        createHash("sha256").update("main").digest("hex") +
        " base_sha=" +
        "c".repeat(40) +
        " request=" +
        "d".repeat(64) +
        " scenario=web-ui-chat-proof -->\nVerified request-bound observer evidence; preserve this entire context.",
    };
    const preserved =
      sourceAction === "command_proof_result" || sourceAction === "failed_review_shard_recovery";
    const direct = await savedDirectRequeueFixture("accepted", true, producerDecision);
    t.after(() => direct.storage.sql.close());
    assert.deepEqual(await (await direct.post("complete", direct.complete)).json(), {
      ok: true,
      requeued: true,
    });
    const directItem = (await direct.readState()).items[direct.leased.key]!;
    assert.deepEqual(directItem.decision, {
      ...producerDecision,
      sourceAction: preserved ? sourceAction : "source_drift_requeue",
      supersedesInProgress: true,
    });
    assert.equal(directItem.leaseDecision, undefined);
    for (const path of ["artifact-refresh", "dead-letter"]) {
      const storage = new MemoryDurableStorage();
      t.after(() => storage.sql.close());
      const item = leasedExactReviewPublicationItem(705, "7050") as ExactReviewQueueItem;
      Object.assign(item.decision, {
        itemKind: "pull_request",
        sourceEvent: "pull_request",
        sourceHeadSha: producerDecision.sourceHeadSha,
        sourceBaseSha: producerDecision.sourceBaseSha,
      });
      item.decision.publication!.producerDecision = { ...producerDecision };
      item.leaseDecision = { ...item.decision };
      item.publicationFailureAttempts = 2;
      await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
      // A real command publication has admission/claim provenance. Without it,
      // terminal acknowledgement must retain the original key and recovery waits.
      const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
      const identity = {
        canonicalTargetKey: "openclaw/openclaw#705",
        fenceKey: item.key,
        revision: item.leaseRevision!,
      };
      lifecycle.recordAdmission({
        ...identity,
        deliveryId: "fixture-publication-" + path,
        sourceDeliveryId: producerDecision.sourceDeliveryId,
        sourceAction,
        commandOriginated: true,
        statusMarker: producerDecision.commandStatusMarker!,
        statusCommentId: null,
        observedAt: Date.now(),
      });
      lifecycle.recordClaim({
        ...identity,
        claimGeneration: item.claimGeneration!,
        runId: item.claimedRunId!,
        runAttempt: item.claimedRunAttempt!,
        observedAt: Date.now(),
      });
      const queue = publicPublicationQueue(storage);
      const post = (route: string, body: unknown) =>
        queue.fetch(
          new Request("https://queue/" + route, { method: "POST", body: JSON.stringify(body) }),
        );
      const completion = await post("complete", {
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: path === "artifact-refresh" ? "success" : "failure",
        completion_kind: path === "artifact-refresh" ? "refresh_required" : "permanent_failure",
        reason_code: "invalid_artifact",
      });
      assert.deepEqual(
        await completion.json(),
        path === "dead-letter"
          ? { ok: true, requeued: false, terminal_finalization: true }
          : { ok: true, requeued: false },
      );
      if (path === "dead-letter") {
        const listed = await (await post("dead-letters/list", { limit: 10 })).json();
        assert.equal(listed.dead_letters.length, 1);
        const recovered = await post("dead-letters/recover-fresh", {
          ids: [listed.dead_letters[0].dead_letter_id],
          idempotency_key: "operator:proof-authority:" + sourceAction,
        });
        assert.deepEqual(await recovered.json(), {
          ok: true,
          recovered: 1,
          deduped: 0,
          skipped: 0,
          unparked: 0,
        });
      }
      const state = (await storage.get("exact-review-queue")) as {
        items: Record<string, ExactReviewQueueItem>;
      };
      assert.equal(state.items[item.key], undefined);
      const recovered = state.items["openclaw/openclaw#705"]!;
      assert.equal(recovered.state, "pending");
      assert.deepEqual(
        recovered.decision,
        {
          ...producerDecision,
          sourceAction: preserved ? sourceAction : "artifact_retention_recovery",
          supersedesInProgress: true,
        },
        path + ": " + sourceAction,
      );
    }
  }
});

for (const receipt of ["accepted", "deduped"] as const) {
  for (const delivered of [false, true]) {
    test(`saved direct requeue ${receipt}: ${delivered ? "delivered completion" : "lost callback"}`, async () => {
      const f = await savedDirectRequeueFixture(receipt);
      const before = f.projection();
      const counters = f.counters();
      assert.equal(before?.terminalDisposition?.kind, "requeue");
      const result = await f.post(
        delivered ? "complete" : "reconcile",
        delivered ? f.complete : { terminal_runs: [f.terminalRun] },
      );
      assert.equal(result.status, 200);
      assert.deepEqual(
        await result.json(),
        delivered
          ? { ok: true, requeued: true }
          : { ok: true, reconciled: 1, requeued: 1, completed: 0 },
      );
      const state = await f.readState();
      assert.equal(Object.keys(state.items).length, 1);
      const item = state.items[f.leased.key];
      assert.equal(item.state, "pending");
      assert.equal(item.revision, 5);
      assert.equal(item.leaseId, undefined);
      assert.equal(item.decision.sourceAction, "source_drift_requeue");
      assert.equal(item.decision.publication, undefined);
      assert.equal(item.admissionDeliveryId, `direct-lifecycle-requeue:${f.leased.key}:4`);
      assert.deepEqual(f.projection()?.terminalDisposition, before?.terminalDisposition);
      assert.equal(
        new ExactReviewLifecycleProjectionStore(f.storage).read(f.leased.key, f.leased.key, 5),
        null,
      );
      assert.deepEqual(f.counters(), counters);
      assert.deepEqual(f.projection()?.reviewResults, before?.reviewResults);
      assert.deepEqual(f.projection()?.routerReceipts, before?.routerReceipts);
      assert.deepEqual(f.projection()?.acknowledgement, before?.acknowledgement);
      for (const table of [
        "exact_review_lifecycle_bay_event_v2",
        "exact_review_lifecycle_bay_pending_v2",
        "exact_review_lifecycle_bay_tide_buffer_v2",
      ]) {
        assert.equal(
          Array.from(f.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`))[0]?.count,
          0,
        );
      }
      const repeated = await f.post("reconcile", { terminal_runs: [f.terminalRun] });
      assert.deepEqual(await repeated.json(), {
        ok: true,
        reconciled: 0,
        requeued: 0,
        completed: 0,
      });
      assert.equal((await f.post("complete", f.complete)).status, 409);
      assert.deepEqual(await f.readState(), state);
      assert.deepEqual(f.counters(), counters);
    });
  }
}

for (const scenario of [
  "superseded",
  "no lifecycle",
  "no saved lease",
  "wrong saved source",
] as const) {
  test(`saved direct requeue rejects authority: ${scenario}`, async () => {
    const f = await savedDirectRequeueFixture(
      scenario === "superseded" ? "superseded" : "accepted",
      scenario !== "no lifecycle",
    );
    const state = await f.readState();
    if (scenario === "no saved lease") delete state.items[f.leased.key].leaseDecision;
    if (scenario === "wrong saved source")
      state.items[f.leased.key].leaseDecision = {
        ...state.items[f.leased.key].leaseDecision!,
        sourceAction: "opened",
      };
    await f.storage.put("exact-review-queue", state);
    const invalid = await f.post("complete", f.complete);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await f.readState(), state);
    const response = await f.post("reconcile", { terminal_runs: [f.terminalRun] });
    assert.deepEqual(await response.json(), { ok: true, reconciled: 1, requeued: 0, completed: 1 });
    assert.deepEqual((await f.readState()).items, {});
  });
}

test("saved direct requeue uses the lease plan rather than the mutable decision", async () => {
  const f = await savedDirectRequeueFixture();
  const state = await f.readState();
  const current = state.items[f.leased.key].decision;
  current.publication!.directLifecycle = {
    plan: { kind: "policy_noop" },
    receiptOutcome: "accepted",
  };
  await f.storage.put("exact-review-queue", state);
  const response = await f.post("reconcile", { terminal_runs: [f.terminalRun] });
  assert.deepEqual(await response.json(), { ok: true, reconciled: 1, requeued: 1, completed: 0 });
  const item = (await f.readState()).items[f.leased.key];
  assert.equal(item.state, "pending");
  assert.equal(item.revision, 5);
  assert.equal(item.decision.sourceAction, "source_drift_requeue");
});

test("saved direct requeue preserves newer command and old lifecycle identity", async () => {
  const f = await savedDirectRequeueFixture();
  const counters = f.counters();
  const marker =
    "<!-- clawsweeper-command-status:705:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const command = await f.queue.fetch(
    buildExactReviewQueueRequest(
      "saved-direct-command-follow-up",
      705,
      "legacy_dispatch",
      "pull_request",
      "openclaw/openclaw",
      {
        commandStatusMarker: marker,
        statusCommentId: 7051,
        additionalPrompt: "Keep the new command prompt.",
      },
    ),
  );
  assert.equal(command.status, 202);
  const newer = (await f.readState()).items[f.leased.key];
  assert.equal(newer.revision, 5);
  const before = f.projection();
  const response = await f.post("reconcile", { terminal_runs: [f.terminalRun] });
  assert.deepEqual(await response.json(), { ok: true, reconciled: 1, requeued: 1, completed: 0 });
  const items = (await f.readState()).items;
  assert.equal(Object.keys(items).length, 1);
  assert.equal(items[f.leased.key].state, "pending");
  assert.equal(items[f.leased.key].revision, newer.revision);
  assert.deepEqual(items[f.leased.key].decision, newer.decision);
  assert.equal(items[f.leased.key].decision.commandStatusMarker, marker);
  assert.equal(items[f.leased.key].decision.additionalPrompt, "Keep the new command prompt.");
  assert.deepEqual(f.projection(), before);
  assert.equal(
    new ExactReviewLifecycleProjectionStore(f.storage).read(f.leased.key, f.leased.key, 5)
      ?.terminalDisposition,
    null,
  );
  assert.deepEqual(f.counters(), counters);
  assert.equal((await f.post("complete", f.complete)).status, 409);
});

for (const mismatch of ["attempt", "generation", "ambiguous", "unsigned"] as const) {
  test(`saved direct requeue requires unique signed ownership: ${mismatch}`, async () => {
    const f = await savedDirectRequeueFixture();
    const state = await f.readState();
    if (mismatch === "ambiguous") {
      const duplicate = leasedExactReviewQueueItem(706, f.leased.claimedRunId!);
      duplicate.claimGeneration = 2;
      state.items[duplicate.key] = duplicate;
      await f.storage.put("exact-review-queue", state);
    }
    const run = { ...f.terminalRun };
    if (mismatch === "attempt") {
      run.run_attempt = 2;
      run.claimed_run_attempt = 2;
    }
    if (mismatch === "generation") run.claim_generation = 3;
    const response = await f.post("reconcile", { terminal_runs: [run] }, mismatch !== "unsigned");
    assert.equal(response.status, mismatch === "unsigned" ? 401 : 200);
    if (mismatch !== "unsigned")
      assert.deepEqual(await response.json(), {
        ok: true,
        reconciled: 0,
        requeued: 0,
        completed: 0,
      });
    assert.deepEqual(await f.readState(), state);
  });
}

for (const outcome of ["failure", "cancelled"] as const) {
  test(`saved direct requeue retains ${outcome} publication retry`, async () => {
    const f = await savedDirectRequeueFixture();
    const before = f.projection();
    const response = await f.post("reconcile", { terminal_runs: [{ ...f.terminalRun, outcome }] });
    assert.deepEqual(await response.json(), { ok: true, reconciled: 1, requeued: 1, completed: 0 });
    const item = (await f.readState()).items[f.leased.key];
    assert.equal(item.state, "pending");
    assert.equal(item.revision, 4);
    assert.equal(item.decision.sourceAction, "exact_review_artifact_publish");
    assert.equal(item.attempts, 1);
    assert.deepEqual(f.projection(), before);
  });
}

test("direct lifecycle requeue preserves a newer command follow-up revision", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(704, "7040");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  leased.decision = {
    ...leased.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
  };
  leased.leaseDecision = { ...leased.decision };
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = publicPublicationQueue(storage);
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const publication = {
    canonicalTargetKey: "openclaw/openclaw#704",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "d".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#704",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/704.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "requeue" },
  };
  const publicationBody = JSON.stringify(publication);
  const publicationSignature = `sha256=${createHmac("sha256", "test-secret")
    .update(publicationBody)
    .digest("hex")}`;
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": publicationSignature },
      body: publicationBody,
    }),
    env,
  );
  assert.equal(accepted.status, 202);

  const marker =
    "<!-- clawsweeper-command-status:704:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const command = await queue.fetch(
    buildExactReviewQueueRequest(
      "direct-lifecycle-command-follow-up-704",
      704,
      "legacy_dispatch",
      "pull_request",
      "openclaw/openclaw",
      {
        commandStatusMarker: marker,
        statusCommentId: 7041,
        additionalPrompt: "Preserve this command follow-up after the direct lifecycle receipt.",
      },
    ),
  );
  assert.equal(command.status, 202);
  assert.equal((await command.json()).queued, true);

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
        direct_lifecycle_requeue: true,
        lifecycle_terminal_disposition: "requeue",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: true });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        decision: {
          sourceAction: string;
          commandStatusMarker?: string;
          statusCommentId?: number;
          additionalPrompt?: string;
          publication?: unknown;
        };
        leaseId?: string;
        revision: number;
        state: string;
        terminalFinalization?: unknown;
      }
    >;
  };
  const followUp = state.items[leased.key];
  assert.equal(followUp?.state, "pending");
  assert.equal(followUp?.revision, 5);
  assert.equal(followUp?.leaseId, undefined);
  assert.equal(followUp?.terminalFinalization, undefined);
  assert.equal(followUp?.decision.sourceAction, "legacy_dispatch");
  assert.equal(followUp?.decision.publication, undefined);
  assert.equal(followUp?.decision.commandStatusMarker, marker);
  assert.equal(followUp?.decision.statusCommentId, 7041);
  assert.equal(
    followUp?.decision.additionalPrompt,
    "Preserve this command follow-up after the direct lifecycle receipt.",
  );
  assert.equal(
    new ExactReviewLifecycleProjectionStore(storage).read("openclaw/openclaw#704", leased.key, 4)
      ?.terminalDisposition?.kind,
    "requeue",
  );
});

test("direct lifecycle router completion preserves a newer command follow-up revision", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(705, "7050");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  leased.decision = {
    ...leased.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
  };
  const priorMarker =
    "<!-- clawsweeper-command-status:705:re_review:fedcba9876543210fedcba9876543210fedcba98 -->";
  Object.assign(leased.decision, { commandStatusMarker: priorMarker, statusCommentId: 7050 });
  leased.leaseDecision = { ...leased.decision };
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = publicPublicationQueue(storage);
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const publication = {
    canonicalTargetKey: "openclaw/openclaw#705",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "e".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#705",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/705.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "router" },
  };
  const publicationBody = JSON.stringify(publication);
  const publicationSignature = `sha256=${createHmac("sha256", "test-secret")
    .update(publicationBody)
    .digest("hex")}`;
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": publicationSignature },
      body: publicationBody,
    }),
    env,
  );
  assert.equal(accepted.status, 202);

  const marker =
    "<!-- clawsweeper-command-status:705:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const command = await queue.fetch(
    buildExactReviewQueueRequest(
      "direct-lifecycle-router-command-follow-up-705",
      705,
      "legacy_dispatch",
      "pull_request",
      "openclaw/openclaw",
      {
        commandStatusMarker: marker,
        statusCommentId: 7051,
      },
    ),
  );
  assert.equal(command.status, 202);
  assert.equal((await command.json()).queued, true);

  const routerReceipt = {
    canonical_target_key: "openclaw/openclaw#705",
    fence_key: leased.key,
    revision: 4,
    outcome: "durable",
    receipt_id: "direct-router-recovery:705:1",
  };
  const routerBody = JSON.stringify(routerReceipt);
  const routerSignature = `sha256=${createHmac("sha256", "test-secret")
    .update(routerBody)
    .digest("hex")}`;
  const routed = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/router-receipt", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": routerSignature },
      body: routerBody,
    }),
    env,
  );
  assert.equal(routed.status, 200);

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), {
    ok: true,
    requeued: true,
    terminal_finalization: true,
  });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        decision: {
          sourceAction: string;
          commandStatusMarker?: string;
          statusCommentId?: number;
          publication?: unknown;
        };
        leaseId?: string;
        revision: number;
        state: string;
        terminalFinalization?: unknown;
      }
    >;
  };
  const followUp = state.items[leased.key];
  assert.equal(followUp?.state, "pending");
  assert.equal(followUp?.revision, 5);
  assert.equal(followUp?.leaseId, undefined);
  assert.equal(followUp?.terminalFinalization, undefined);
  assert.equal(followUp?.decision.sourceAction, "legacy_dispatch");
  assert.equal(followUp?.decision.publication, undefined);
  assert.equal(followUp?.decision.commandStatusMarker, marker);
  assert.equal(followUp?.decision.statusCommentId, 7051);
  const finalizationDriver = state.items[`terminal-finalization:${leased.key}:4`];
  assert.equal(finalizationDriver?.state, "pending");

  // The successor now owns a new fence. Its direct receipt must install a
  // new lifecycle projection rather than being mistaken for the old receipt.
  const successorState = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, unknown>;
    items: Record<string, typeof leased>;
  };
  const successor = successorState.items[leased.key]!;
  successor.state = "leased";
  successor.revision = 5;
  successor.leaseId = "direct-lifecycle-router-follow-up-705";
  successor.leaseRevision = 5;
  successor.claimGeneration = 3;
  successor.claimedRunId = "7051";
  successor.claimedRunAttempt = 1;
  successor.claimProtocolVersion = 2;
  successor.leaseDecision = { ...successor.decision };
  successor.leaseExpiresAt = Date.now() + 60_000;
  await storage.put("exact-review-queue", successorState);

  const successorPublication = {
    ...publication,
    revision: 5,
    sourceSha: "f".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#705",
      fenceKey: leased.key,
      revision: 5,
      claimGeneration: 3,
    },
  };
  const successorPublicationBody = JSON.stringify(successorPublication);
  const successorPublicationSignature = `sha256=${createHmac("sha256", "test-secret")
    .update(successorPublicationBody)
    .digest("hex")}`;
  const successorAccepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": successorPublicationSignature },
      body: successorPublicationBody,
    }),
    env,
  );
  assert.equal(successorAccepted.status, 202);
  const successorDirectState = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { decision: { sourceAction: string; publication?: { leaseRevision: number | null } } }
    >;
  };
  assert.equal(
    successorDirectState.items[leased.key]?.decision.sourceAction,
    "exact_review_artifact_publish",
  );
  assert.equal(successorDirectState.items[leased.key]?.decision.publication?.leaseRevision, 5);
  const priorProjection = new ExactReviewLifecycleProjectionStore(storage).read(
    "openclaw/openclaw#705",
    leased.key,
    4,
  );
  assert.equal(priorProjection?.routerReceipt?.outcome, "durable");
  assert.equal(priorProjection?.admission.statusMarker, priorMarker);
  assert.equal(priorProjection?.terminalDisposition?.kind, "review_completed_routed");
  assert.equal(commandAcknowledgementState(priorProjection!), "pending");
});

test("durable direct command acknowledgement survives successor lease expiry", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(706, "7060");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  leased.decision = {
    ...leased.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
  };
  const priorMarker =
    "<!-- clawsweeper-command-status:706:re_review:fedcba9876543210fedcba9876543210fedcba98 -->";
  Object.assign(leased.decision, { commandStatusMarker: priorMarker, statusCommentId: 7060 });
  leased.leaseDecision = { ...leased.decision };
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = publicPublicationQueue(storage);
  const secret = "concurrent-terminal-finalization-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const publication = {
    canonicalTargetKey: "openclaw/openclaw#706",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "a".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#706",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/706.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "router" },
  };
  const publicationBody = JSON.stringify(publication);
  const publicationSignature = `sha256=${createHmac("sha256", secret)
    .update(publicationBody)
    .digest("hex")}`;
  assert.equal(
    (
      await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
          method: "POST",
          headers: { "x-clawsweeper-exact-review-signature": publicationSignature },
          body: publicationBody,
        }),
        env,
      )
    ).status,
    202,
  );

  const successorMarker =
    "<!-- clawsweeper-command-status:706:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const successor = await queue.fetch(
    buildExactReviewQueueRequest(
      "direct-lifecycle-router-command-follow-up-706",
      706,
      "legacy_dispatch",
      "pull_request",
      "openclaw/openclaw",
      { commandStatusMarker: successorMarker, statusCommentId: 7061 },
    ),
  );
  assert.equal(successor.status, 202);

  const driverKey = `terminal-finalization:${leased.key}:4`;
  let state = storage.sql.readNormalizedQueue() as {
    items: Record<string, ExactReviewQueueItem>;
  };
  state.items[leased.key]!.leaseExpiresAt = Date.now() - 1;
  storage.sql.replaceNormalizedQueue(state);
  const expiredClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
      }),
    }),
  );
  assert.deepEqual(await expiredClaim.json(), { error: "lease_not_active" });
  const staleCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await staleCompletion.json(), { error: "lease_not_claimed" });

  // The durable route handoff arrived after the old lease expired and its
  // mutable lease decision was cleared. The immutable old projection must
  // still materialize its own acknowledgement driver rather than attaching
  // the old marker to the successor.
  const routerReceipt = {
    canonical_target_key: publication.canonicalTargetKey,
    fence_key: publication.fenceKey,
    revision: publication.revision,
    outcome: "durable",
    receipt_id: "direct-router-recovery:706:1",
  };
  const routerBody = JSON.stringify(routerReceipt);
  const routerSignature = `sha256=${createHmac("sha256", secret).update(routerBody).digest("hex")}`;
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/router-receipt",
          {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": routerSignature },
            body: routerBody,
          },
        ),
        env,
      )
    ).status,
    200,
  );

  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  const pendingSuccessor = state.items[leased.key]!;
  let driver = state.items[driverKey]!;
  assert.equal(pendingSuccessor.state, "pending");
  assert.equal(pendingSuccessor.revision, 5);
  assert.equal(pendingSuccessor.decision.sourceAction, "legacy_dispatch");
  assert.equal(pendingSuccessor.decision.publication, undefined);
  assert.equal(pendingSuccessor.decision.commandStatusMarker, successorMarker);
  assert.equal(driver.state, "pending");
  assert.equal(driver.decision.sourceAction, "exact_review_artifact_publish");
  assert.equal(driver.decision.publication, undefined);
  assert.equal(driver.decision.commandStatusMarker, priorMarker);
  assert.deepEqual(driver.terminalFinalization?.projection, {
    canonicalTargetKey: "openclaw/openclaw#706",
    fenceKey: leased.key,
    revision: 4,
  });
  assert.equal(
    new ExactReviewLifecycleProjectionStore(storage).read("openclaw/openclaw#706", driverKey, 4),
    null,
  );

  // Requeue ordering is covered separately; this scenario retains the
  // finalizer identity and acknowledgement retry coverage.
  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  driver = state.items[driverKey]!;
  Object.assign(driver, {
    state: "dispatching",
    leaseId: "concurrent-terminal-finalization-lease",
    leaseRevision: 4,
    leaseDecision: driver.decision,
    leaseExpiresAt: Date.now() + 60_000,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
  });
  storage.sql.replaceNormalizedQueue(state);
  const claimedDriver = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "concurrent-terminal-finalization-lease",
        item_key: driverKey,
        lease_revision: 4,
        run_id: "7062",
        run_attempt: 1,
      }),
    }),
  );
  const claimedDriverBody = await claimedDriver.json();
  assert.equal(claimedDriver.status, 200);
  assert.deepEqual(claimedDriverBody.lifecycle_projection, {
    canonicalTargetKey: "openclaw/openclaw#706",
    fenceKey: leased.key,
    revision: 4,
  });

  const finalizerTuple = {
    lease_id: "concurrent-terminal-finalization-lease",
    item_key: driverKey,
    lease_revision: 4,
    claim_generation: claimedDriverBody.claim_generation,
    run_id: "7062",
    run_attempt: 1,
  };
  const rejectedNewerMarker = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          ...finalizerTuple,
          status_marker: successorMarker,
          status_comment_id: 7061,
        }),
      },
    ),
    env,
  );
  assert.deepEqual(await rejectedNewerMarker.json(), {
    ok: true,
    allowed: false,
    lifecycle_state: "acknowledgement_pending",
    acknowledgement_state: "pending",
    terminal_disposition: "review_completed_routed",
    status_state: "Complete",
    status_detail: "The durable review result and its route handoff completed.",
    version: 1,
  });
  const permittedOldMarker = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          ...finalizerTuple,
          status_marker: priorMarker,
          status_comment_id: 7060,
        }),
      },
    ),
    env,
  );
  assert.deepEqual(await permittedOldMarker.json(), {
    ok: true,
    allowed: true,
    lifecycle_state: "acknowledgement_pending",
    acknowledgement_state: "pending",
    terminal_disposition: "review_completed_routed",
    status_state: "Complete",
    status_detail: "The durable review result and its route handoff completed.",
    attempt_id: "ack:1",
    version: 1,
  });
  assert.equal(
    commandAcknowledgementState(
      new ExactReviewLifecycleProjectionStore(storage).read(
        "openclaw/openclaw#706",
        leased.key,
        4,
      )!,
    ),
    "pending",
  );

  const failed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/failed", {
      method: "POST",
      body: JSON.stringify({
        canonical_target_key: "openclaw/openclaw#706",
        fence_key: leased.key,
        revision: 4,
        attempt_id: "ack:1",
        status_marker: priorMarker,
        status_comment_id: 7060,
      }),
    }),
  );
  assert.equal((await failed.json()).released, true);
  const retried = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/retry",
      {
        method: "POST",
        body: JSON.stringify(finalizerTuple),
      },
    ),
    env,
  );
  assert.deepEqual(await retried.json(), { ok: true, requeued: true });

  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  const retryDriver = state.items[driverKey]!;
  const retainedSuccessor = state.items[leased.key]!;
  assert.equal(retainedSuccessor.state, "pending");
  assert.equal(retainedSuccessor.revision, 5);
  assert.equal(retainedSuccessor.decision.commandStatusMarker, successorMarker);
  Object.assign(retryDriver, {
    state: "dispatching",
    leaseId: "concurrent-terminal-finalization-retry",
    leaseRevision: 4,
    leaseDecision: retryDriver.decision,
    leaseExpiresAt: Date.now() + 60_000,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
  });
  storage.sql.replaceNormalizedQueue(state);
  const retryClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "concurrent-terminal-finalization-retry",
        item_key: driverKey,
        lease_revision: 4,
        run_id: "7063",
        run_attempt: 1,
      }),
    }),
  );
  const retryClaimBody = await retryClaim.json();
  const retriedAttempt = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          lease_id: "concurrent-terminal-finalization-retry",
          item_key: driverKey,
          lease_revision: 4,
          claim_generation: retryClaimBody.claim_generation,
          run_id: "7063",
          run_attempt: 1,
          status_marker: priorMarker,
          status_comment_id: 7060,
        }),
      },
    ),
    env,
  );
  assert.equal((await retriedAttempt.json()).attempt_id, "ack:2");
  const observedPayload = {
    canonical_target_key: "openclaw/openclaw#706",
    status_marker: priorMarker,
    command_comment_id: 7060,
    completion_comment_id: 7060,
    observed_at: Date.now(),
  };
  const observedBody = JSON.stringify(observedPayload);
  const observedSignature = `sha256=${createHmac("sha256", secret)
    .update(observedBody)
    .digest("hex")}`;
  const observed = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/command-ack/observed",
      {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": observedSignature },
        body: observedBody,
      },
    ),
    env,
  );
  assert.deepEqual(await observed.json(), {
    ok: true,
    accepted: true,
    lifecycle_state: "completed",
    acknowledgement_state: "observed",
    version: 1,
  });
  const observedState = storage.sql.readNormalizedQueue() as {
    items: Record<string, ExactReviewQueueItem>;
  };
  assert.equal(observedState.items[driverKey], undefined);
  assert.equal(observedState.items[leased.key]?.revision, 5);
  assert.equal(observedState.items[leased.key]?.decision.commandStatusMarker, successorMarker);
});

test("terminal disposition materializes a direct acknowledgement driver after lease expiry", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(789, "7890");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  const marker =
    "<!-- clawsweeper-command-status:789:re_review:fedcba9876543210fedcba9876543210fedcba98 -->";
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7890 });
  leased.leaseDecision = { ...leased.decision };
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = publicPublicationQueue(storage);
  const secret = "expired-terminal-disposition-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const publication = {
    canonicalTargetKey: "openclaw/openclaw#789",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "b".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#789",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/789.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "router" },
  };
  const publicationBody = JSON.stringify(publication);
  const publicationSignature = `sha256=${createHmac("sha256", secret)
    .update(publicationBody)
    .digest("hex")}`;
  assert.equal(
    (
      await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
          method: "POST",
          headers: { "x-clawsweeper-exact-review-signature": publicationSignature },
          body: publicationBody,
        }),
        env,
      )
    ).status,
    202,
  );

  let state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  state.items[leased.key]!.leaseExpiresAt = Date.now() - 1;
  storage.sql.replaceNormalizedQueue(state);
  const expiredClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
      }),
    }),
  );
  assert.deepEqual(await expiredClaim.json(), { error: "lease_not_active" });

  const disposition = {
    canonical_target_key: publication.canonicalTargetKey,
    fence_key: publication.fenceKey,
    revision: publication.revision,
    kind: "target_closed",
  };
  const dispositionBody = JSON.stringify(disposition);
  const dispositionSignature = `sha256=${createHmac("sha256", secret)
    .update(dispositionBody)
    .digest("hex")}`;
  const terminal = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/terminal-disposition",
      {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": dispositionSignature },
        body: dispositionBody,
      },
    ),
    env,
  );
  assert.equal(terminal.status, 200);
  assert.equal((await terminal.json()).acknowledgement_state, "pending");

  const staleCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await staleCompletion.json(), { error: "lease_not_claimed" });

  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  const driverKey = `terminal-finalization:${leased.key}:4`;
  assert.equal(state.items[leased.key], undefined);
  assert.equal(state.items[driverKey]?.state, "pending");
  assert.equal(state.items[driverKey]?.decision.commandStatusMarker, marker);
  assert.deepEqual(state.items[driverKey]?.terminalFinalization, {
    disposition: "target_closed",
    statusState: "Complete",
    statusDetail: "The item is closed; no stale verdict was published.",
    projection: {
      canonicalTargetKey: "openclaw/openclaw#789",
      fenceKey: leased.key,
      revision: 4,
    },
  });
  assert.equal(
    new ExactReviewLifecycleProjectionStore(storage).read("openclaw/openclaw#789", leased.key, 4)
      ?.terminalDisposition?.kind,
    "target_closed",
  );
});

test("fallback canonical routing materializes an acknowledgement driver after lease expiry", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewPublicationItem(791, "7910");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  const marker =
    "<!-- clawsweeper-command-status:791:re_review:fedcba9876543210fedcba9876543210fedcba98 -->";
  Object.assign(leased.decision.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 7910,
  });
  Object.assign(leased.leaseDecision!.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 7910,
  });
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7910 });
  Object.assign(leased.leaseDecision!, { commandStatusMarker: marker, statusCommentId: 7910 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#791",
    fenceKey: leased.key,
    revision: 4,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "fallback-expiry:791",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: marker,
    statusCommentId: 7910,
    observedAt: 1_700_000_000_000,
  });
  lifecycle.recordClaim({
    ...identity,
    claimGeneration: 2,
    runId: "7910",
    runAttempt: 1,
    observedAt: 1_700_000_000_001,
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "fallback-expiry-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const canonicalBody = JSON.stringify({
    canonical_target_key: identity.canonicalTargetKey,
    fence_key: identity.fenceKey,
    revision: identity.revision,
    outcome: "accepted",
    receipt_id: "fallback:791:accepted",
  });
  const canonicalSignature = `sha256=${createHmac("sha256", secret)
    .update(canonicalBody)
    .digest("hex")}`;
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/canonical-receipt",
          {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": canonicalSignature },
            body: canonicalBody,
          },
        ),
        env,
      )
    ).status,
    200,
  );

  let state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  state.items[leased.key]!.leaseExpiresAt = Date.now() - 1;
  storage.sql.replaceNormalizedQueue(state);
  const expiredClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
      }),
    }),
  );
  assert.deepEqual(await expiredClaim.json(), { error: "lease_not_active" });

  const routerBody = JSON.stringify({
    canonical_target_key: identity.canonicalTargetKey,
    fence_key: identity.fenceKey,
    revision: identity.revision,
    outcome: "durable",
    receipt_id: "fallback:791:router",
  });
  const routerSignature = `sha256=${createHmac("sha256", secret).update(routerBody).digest("hex")}`;
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/router-receipt",
          {
            method: "POST",
            headers: { "x-clawsweeper-exact-review-signature": routerSignature },
            body: routerBody,
          },
        ),
        env,
      )
    ).status,
    200,
  );

  const driverKey = `terminal-finalization:${leased.key}:4`;
  state = storage.sql.readNormalizedQueue() as { items: Record<string, ExactReviewQueueItem> };
  assert.equal(state.items[leased.key], undefined);
  const driver = state.items[driverKey]!;
  assert.equal(driver.state, "pending");
  assert.equal(driver.decision.publication, undefined);
  assert.equal(driver.decision.commandStatusMarker, marker);
  assert.deepEqual(driver.terminalFinalization?.projection, identity);
  assert.equal(
    commandAcknowledgementState(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!,
    ),
    "pending",
  );

  Object.assign(driver, {
    state: "dispatching",
    leaseId: "fallback-terminal-finalization-lease",
    leaseRevision: 4,
    leaseDecision: driver.decision,
    leaseExpiresAt: Date.now() + 60_000,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
  });
  storage.sql.replaceNormalizedQueue(state);
  const claimed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "fallback-terminal-finalization-lease",
        item_key: driverKey,
        lease_revision: 4,
        run_id: "7911",
        run_attempt: 1,
      }),
    }),
  );
  const claimedBody = await claimed.json();
  assert.equal(claimed.status, 200);
  const attempted = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/terminal-finalization/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          lease_id: "fallback-terminal-finalization-lease",
          item_key: driverKey,
          lease_revision: 4,
          claim_generation: claimedBody.claim_generation,
          run_id: "7911",
          run_attempt: 1,
          status_marker: marker,
          status_comment_id: 7910,
        }),
      },
    ),
    env,
  );
  assert.equal((await attempted.json()).allowed, true);
});

test("a successor splits a pending terminal finalizer before command merge", async () => {
  const storage = new MemoryDurableStorage();
  const finalizer = leasedExactReviewQueueItem(790, "7900");
  finalizer.revision = 4;
  const oldMarker =
    "<!-- clawsweeper-command-status:790:re_review:fedcba9876543210fedcba9876543210fedcba98 -->";
  const oldDecision = {
    ...finalizer.decision,
    sourceAction: "re_review",
    commandStatusMarker: oldMarker,
    statusCommentId: 7900,
  };
  const publication = exactReviewPublicationOverrides(
    790,
    "7900",
    "re_review",
    4,
    "openclaw/openclaw",
  ).publication;
  publication.producerDecision = oldDecision;
  Object.assign(finalizer, {
    decision: {
      ...oldDecision,
      sourceAction: "exact_review_artifact_publish",
      publication,
    },
    leaseDecision: undefined,
    state: "pending",
    leaseId: undefined,
    leaseRevision: undefined,
    leaseExpiresAt: undefined,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
    claimProtocolVersion: undefined,
    terminalFinalization: {
      disposition: "review_completed_routed",
      statusState: "Complete",
      statusDetail: "The durable review result and its route handoff completed.",
      projection: {
        canonicalTargetKey: "openclaw/openclaw#790",
        fenceKey: finalizer.key,
        revision: 4,
      },
    },
  });
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [finalizer.key]: finalizer },
  });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  lifecycle.ensureSchemaSync();
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#790",
    fenceKey: finalizer.key,
    revision: 4,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "pending-terminal-finalizer:790",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: oldMarker,
    statusCommentId: 7900,
    observedAt: 1_700_000_000_000,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "canonical:790:accepted",
    observedAt: 1_700_000_000_001,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "router:790:durable",
    observedAt: 1_700_000_000_002,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_003,
  });

  const queue = new ExactReviewQueue({ storage }, {});
  const successorMarker =
    "<!-- clawsweeper-command-status:790:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "pending-terminal-finalizer-successor-790",
      790,
      "legacy_dispatch",
      "issue",
      "openclaw/openclaw",
      { commandStatusMarker: successorMarker, statusCommentId: 7901 },
    ),
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, true);

  const state = storage.sql.readNormalizedQueue() as {
    items: Record<string, ExactReviewQueueItem>;
  };
  const driverKey = `terminal-finalization:${finalizer.key}:4`;
  const successor = state.items[finalizer.key]!;
  assert.equal(successor.state, "pending");
  assert.equal(successor.revision, 5);
  assert.equal(successor.terminalFinalization, undefined);
  assert.equal(successor.decision.sourceAction, "legacy_dispatch");
  assert.equal(successor.decision.publication, undefined);
  assert.equal(successor.decision.commandStatusMarker, successorMarker);
  assert.equal(state.items[driverKey]?.state, "pending");
  assert.equal(state.items[driverKey]?.decision.commandStatusMarker, oldMarker);
  assert.deepEqual(state.items[driverKey]?.terminalFinalization?.projection, identity);
});

test("terminal acknowledgement dispatch rejection remains a durable fenced retry", async () => {
  let dispatchStatus = 422;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    dispatch: () =>
      dispatchStatus === 204
        ? new Response(null, { status: 204 })
        : new Response(
            JSON.stringify({
              message: "Validation Failed",
              errors: [{ field: "client_payload", code: "invalid" }],
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
  });
  try {
    const finalizer = leasedExactReviewPublicationItem(788, "7880");
    const driverKey = `terminal-finalization:${finalizer.key}:1`;
    Object.assign(finalizer, {
      key: driverKey,
      state: "pending",
      leaseId: undefined,
      leaseRevision: undefined,
      leaseDecision: undefined,
      leaseExpiresAt: undefined,
      claimedRunId: undefined,
      claimedRunAttempt: undefined,
      claimGeneration: undefined,
      claimProtocolVersion: undefined,
      terminalFinalization: {
        disposition: "failure",
        statusState: "Failed",
        statusDetail:
          "The exact review reached a durable terminal failure and needs operator attention.",
        projection: {
          canonicalTargetKey: "openclaw/openclaw#788",
          fenceKey: "openclaw/openclaw#788",
          revision: 1,
        },
      },
    });
    await harness.storage.put("exact-review-queue", {
      deliveries: {},
      items: { [driverKey]: finalizer },
    });

    await harness.queue.alarm();
    let state = harness.storage.sql.readNormalizedQueue() as {
      items: Record<string, ExactReviewQueueItem>;
    };
    const retained = state.items[driverKey]!;
    assert.equal(retained.state, "pending");
    assert.equal(retained.parkedReason, undefined);
    assert.equal(retained.terminalFinalization?.projection?.fenceKey, "openclaw/openclaw#788");
    assert.equal(retained.dispatchFailureClass, "permanent_rejection");
    assert.equal(retained.attempts, 1);
    assert.ok(retained.nextAttemptAt > Date.now());
    assert.equal(
      harness.dispatched[0]?.client_payload?.source_action,
      "exact_review_command_acknowledgement",
    );

    dispatchStatus = 204;
    retained.nextAttemptAt = Date.now() - 1;
    await harness.storage.put("exact-review-queue", state);
    await harness.queue.alarm();
    state = harness.storage.sql.readNormalizedQueue() as {
      items: Record<string, ExactReviewQueueItem>;
    };
    assert.equal(state.items[driverKey]?.state, "dispatching");
    assert.equal(state.items[driverKey]?.terminalFinalization?.projection?.revision, 1);
  } finally {
    harness.restore();
  }
});

test("direct command publication retains its terminal acknowledgement driver after durable handoff", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewQueueItem(787, "7870");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimGeneration = 2;
  const marker = "<!-- clawsweeper-command-status:787:re_review:direct -->";
  Object.assign(leased.decision, { commandStatusMarker: marker, statusCommentId: 7871 });
  Object.assign(leased.leaseDecision!, { commandStatusMarker: marker, statusCommentId: 7871 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = publicPublicationQueue(storage);
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "direct-command-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const publication = {
    canonicalTargetKey: "openclaw/openclaw#787",
    fenceKey: leased.key,
    revision: 4,
    sourceSha: "c".repeat(40),
    identity: {
      canonicalTargetKey: "openclaw/openclaw#787",
      fenceKey: leased.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/787.md",
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
  };
  const body = JSON.stringify(publication);
  const signature = `sha256=${createHmac("sha256", "direct-command-secret").update(body).digest("hex")}`;
  const published = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publication-results", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": signature },
      body,
    }),
    env,
  );
  assert.equal(published.status, 202);
  const routed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/router-receipt", {
      method: "POST",
      body: JSON.stringify({
        canonical_target_key: publication.canonicalTargetKey,
        fence_key: publication.fenceKey,
        revision: publication.revision,
        outcome: "durable",
        receipt_id: "direct-command:787:router",
      }),
    }),
  );
  assert.equal(routed.status, 200);
  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        claim_generation: 2,
        run_id: leased.claimedRunId,
        run_attempt: leased.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), {
    ok: true,
    requeued: false,
    terminal_finalization: true,
  });
  const driverKey = `terminal-finalization:${leased.key}:4`;
  const terminalState = storage.sql.readNormalizedQueue().items;
  assert.equal(terminalState[leased.key], undefined);
  const driver = terminalState[driverKey]!;
  assert.equal(driver.state, "pending");
  assert.equal(driver.decision.publication, undefined);
  assert.equal(driver.decision.commandStatusMarker, marker);
  assert.deepEqual(driver.terminalFinalization, {
    disposition: "review_completed_routed",
    statusState: "Complete",
    statusDetail: "The durable review result and its route handoff completed.",
    projection: {
      canonicalTargetKey: "openclaw/openclaw#787",
      fenceKey: leased.key,
      revision: 4,
    },
  });
});

test("authenticated fanout cursors round-trip through durable storage", async () => {
  const storage = new MemoryDurableStorage();
  const secret = "fanout-cursor-secret";
  let queue = new ExactReviewQueue({ storage }, {});
  let env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const path = "/internal/state/cursors/normal-review";
  const request = (method: "GET" | "PUT", payload?: unknown, signed = true) => {
    const body = method === "PUT" ? JSON.stringify(payload) : "";
    return new Request(`https://clawsweeper.openclaw.ai${path}`, {
      method,
      headers: signed
        ? {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
          }
        : undefined,
      ...(method === "PUT" ? { body } : {}),
    });
  };

  assert.equal((await worker.fetch(request("GET", undefined, false), env)).status, 401);
  assert.deepEqual(await (await worker.fetch(request("GET"), env)).json(), {
    ok: true,
    mode: "normal-review",
    next_cursor: 0,
    revision: 0,
    updated_at: null,
  });

  const writtenResponse = await worker.fetch(
    request("PUT", { next_cursor: 12, expected_revision: 0 }),
    env,
  );
  assert.equal(writtenResponse.status, 202);
  const written = await writtenResponse.json();
  assert.deepEqual(written, {
    ok: true,
    mode: "normal-review",
    next_cursor: 12,
    revision: 1,
    updated_at: written.updated_at,
  });
  assert.equal(Number.isFinite(Date.parse(written.updated_at)), true);

  const conflict = await worker.fetch(
    request("PUT", { next_cursor: 24, expected_revision: 0 }),
    env,
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "fanout_cursor_revision_conflict");

  queue = new ExactReviewQueue({ storage }, {});
  env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  assert.deepEqual(await (await worker.fetch(request("GET"), env)).json(), written);
});

test("placeholder recovery cursor survives queue reconstruction", async () => {
  const storage = new MemoryDurableStorage();
  const secret = "placeholder-cursor-secret";
  const mode = "review-placeholder-0123456789abcdef-closed";
  const path = `/internal/state/cursors/${mode}`;
  let queue = new ExactReviewQueue({ storage }, {});
  let env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const request = (method: "GET" | "PUT", payload?: unknown) => {
    const body = method === "PUT" ? JSON.stringify(payload) : "";
    return new Request(`https://clawsweeper.openclaw.ai${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      ...(method === "PUT" ? { body } : {}),
    });
  };

  const written = await worker.fetch(
    request("PUT", { next_cursor: 120, expected_revision: 0 }),
    env,
  );
  assert.equal(written.status, 202);

  queue = new ExactReviewQueue({ storage }, {});
  env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  assert.deepEqual(await (await worker.fetch(request("GET"), env)).json(), {
    ok: true,
    mode,
    next_cursor: 120,
    revision: 1,
    updated_at: (await written.clone().json()).updated_at,
  });
});

test("Worker lifecycle projection permits one command acknowledgement after durable routing", async () => {
  const storage = new MemoryDurableStorage();
  const leased = leasedExactReviewPublicationItem(778, "7780");
  leased.revision = 4;
  leased.leaseRevision = 4;
  leased.claimedRunId = undefined;
  leased.claimedRunAttempt = undefined;
  leased.claimGeneration = undefined;
  leased.admissionDeliveryId = "publication-delivery:778";
  const marker = "<!-- clawsweeper-command-status:778:re_review:token -->";
  Object.assign(leased.decision.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 9002,
  });
  Object.assign(leased.leaseDecision!.publication!.producerDecision, {
    sourceAction: "re_review",
    commandStatusMarker: marker,
    statusCommentId: 9002,
  });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [leased.key]: leased } });
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "lifecycle-proof-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const postSigned = async (path: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload);
    return worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai${path}`, {
        method: "POST",
        headers: {
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      }),
      env,
    );
  };

  const claimed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: leased.leaseId,
        item_key: leased.key,
        lease_revision: 4,
        run_id: "7780",
        run_attempt: 1,
      }),
    }),
  );
  assert.equal(claimed.status, 200);
  const stateAfterClaim = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; revision: number; leaseRevision: number; claimGeneration: number }
    >;
  };
  const claimedItem = stateAfterClaim.items[leased.key]!;
  assert.equal(claimedItem.state, "leased");
  assert.equal(claimedItem.revision, 4);
  assert.equal(claimedItem.leaseRevision, 4);
  assert.equal(claimedItem.claimGeneration, 1);
  assert.deepEqual(
    {
      targetRepo: claimedItem.decision.targetRepo,
      itemNumber: claimedItem.decision.itemNumber,
      key: claimedItem.key,
    },
    { targetRepo: "openclaw/openclaw", itemNumber: 778, key: leased.key },
  );
  const claimedLifecycle = new ExactReviewLifecycleProjectionStore(storage).read(
    "openclaw/openclaw#778",
    leased.key,
    4,
  );
  assert.equal(claimedLifecycle?.admission.deliveryId, "publication-delivery:778");
  assert.deepEqual(
    claimedLifecycle?.claims.map(({ claimGeneration, runId, runAttempt }) => ({
      claimGeneration,
      runId,
      runAttempt,
    })),
    [{ claimGeneration: 1, runId: "7780", runAttempt: 1 }],
  );

  const identity = {
    canonical_target_key: "openclaw/openclaw#778",
    fence_key: leased.key,
    revision: 4,
  };
  const canonical = await postSigned("/internal/exact-review/lifecycle/canonical-receipt", {
    ...identity,
    outcome: "accepted",
    receipt_id: "fallback:7780:1",
  });
  assert.deepEqual(await canonical.json(), {
    ok: true,
    lifecycle_state: "pending",
    version: 1,
  });
  const routed = await postSigned("/internal/exact-review/lifecycle/router-receipt", {
    ...identity,
    receipt_id: "router:7780:1",
  });
  assert.deepEqual(await routed.json(), {
    ok: true,
    lifecycle_state: "acknowledgement_pending",
    version: 1,
  });
  const acknowledgement = {
    ...identity,
    status_marker: marker,
    status_comment_id: 9002,
  };
  assert.deepEqual(
    await (
      await postSigned("/internal/exact-review/lifecycle/command-ack/attempt", acknowledgement)
    ).json(),
    {
      ok: true,
      allowed: true,
      lifecycle_state: "acknowledgement_pending",
      acknowledgement_state: "pending",
      attempt_id: "ack:1",
      version: 1,
    },
  );
  assert.deepEqual(
    await (
      await postSigned("/internal/exact-review/lifecycle/command-ack/failed", {
        ...acknowledgement,
        attempt_id: "ack:1",
      })
    ).json(),
    {
      ok: true,
      released: true,
      lifecycle_state: "acknowledgement_pending",
      acknowledgement_state: "pending",
      version: 1,
    },
  );
  assert.deepEqual(
    await (
      await postSigned("/internal/exact-review/lifecycle/command-ack/attempt", acknowledgement)
    ).json(),
    {
      ok: true,
      allowed: true,
      lifecycle_state: "acknowledgement_pending",
      acknowledgement_state: "pending",
      attempt_id: "ack:2",
      version: 1,
    },
  );
  assert.deepEqual(
    await (
      await postSigned("/internal/exact-review/lifecycle/command-ack/attempt", acknowledgement)
    ).json(),
    {
      ok: true,
      allowed: false,
      lifecycle_state: "acknowledgement_pending",
      acknowledgement_state: "pending",
      version: 1,
    },
  );
  const observed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/observed", {
      method: "POST",
      body: JSON.stringify({
        canonical_target_key: "openclaw/openclaw#778",
        status_marker: marker,
        command_comment_id: 123,
        completion_comment_id: 9002,
        observed_at: 1_700_000_000_000,
      }),
    }),
  );
  assert.deepEqual(await observed.json(), {
    ok: true,
    accepted: true,
    lifecycle_state: "completed",
    acknowledgement_state: "observed",
    version: 1,
  });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage).read(
    "openclaw/openclaw#778",
    leased.key,
    4,
  );
  assert.equal(lifecycleState(lifecycle!), "completed");
  assert.deepEqual(
    lifecycle?.canonicalReceipts.map(({ outcome }) => outcome),
    ["accepted"],
  );
  assert.equal(lifecycle?.acknowledgement.attempts.length, 2);
});

test("signed Worker records a status-ID-only terminal acknowledgement", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#779",
    fenceKey: "openclaw/openclaw#779@exact:status-id-only",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "status-id-only-delivery:779",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: null,
    statusCommentId: 9011,
    observedAt: 1_700_000_000_000,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "status-id-only-canonical:779",
    observedAt: 1_700_000_000_001,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "status-id-only-router:779",
    observedAt: 1_700_000_000_002,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_003,
  });
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: null,
      statusCommentId: 9011,
      observedAt: 1_700_000_000_004,
    }).allowed,
    true,
  );

  const secret = "status-id-only-lifecycle-secret";
  const payload = {
    canonical_target_key: "openclaw/openclaw#779",
    command_comment_id: 9010,
    completion_comment_id: 9011,
    observed_at: 1_700_000_000_005,
  };
  const body = JSON.stringify(payload);
  const response = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/command-ack/observed",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret)
            .update(body)
            .digest("hex")}`,
        },
        body,
      },
    ),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: true,
    lifecycle_state: "completed",
    acknowledgement_state: "observed",
    version: 1,
  });
  assert.deepEqual(
    lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
      ?.acknowledgement.observed,
    {
      statusMarker: null,
      commandCommentId: 9010,
      completionCommentId: 9011,
      observedAt: 1_700_000_000_005,
    },
  );
});

test("signed Worker supersedes only an acknowledgement-safe exact stale publication", async () => {
  const storage = new MemoryDurableStorage();
  const stale = leasedExactReviewPublicationItem(17960, "179600");
  const fresh = leasedExactReviewPublicationItem(17960, "179601");
  const marker =
    "<!-- clawsweeper-command-status:17960:re_review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  stale.state = "pending";
  stale.revision = 4;
  stale.decision.publication!.leaseRevision = 1;
  stale.leaseDecision!.publication!.leaseRevision = 1;
  Object.assign(stale.decision.publication!.producerDecision, {
    commandStatusMarker: marker,
    statusCommentId: 179600,
  });
  fresh.state = "pending";
  fresh.decision.publication!.leaseRevision = 2;
  fresh.leaseDecision!.publication!.leaseRevision = 2;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [stale.key]: stale, [fresh.key]: fresh },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const identity = {
    canonicalTargetKey: "openclaw/openclaw#17960",
    fenceKey: stale.key,
    revision: 4,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "signed-supersede-admission",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: marker,
    statusCommentId: 179600,
    observedAt: Date.now() - 4,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "signed-supersede-canonical",
    observedAt: Date.now() - 3,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "signed-supersede-router",
    observedAt: Date.now() - 2,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: Date.now() - 1,
  });
  const secret = "signed-supersede-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const postSigned = (path: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload);
    return worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai/internal/exact-review/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret)
            .update(body)
            .digest("hex")}`,
        },
        body,
      }),
      env,
    );
  };
  const dryRun = await (await postSigned("publications/reconcile", { max_items: 1 })).json();
  assert.deepEqual(dryRun.sample[0], {
    item_key: stale.key,
    queue_revision: 4,
    reason: "stale_revision",
    target_key: "openclaw/openclaw#17960",
    publication_revision: 1,
    superseded_by_revision: 2,
    lineage_claim_generation: 1,
    retained_item_key: null,
    successor_fence_state: null,
    command_context: true,
    acknowledgement_state: "pending",
    acknowledgement_unavailable_reason: null,
    supersede_safe: false,
  });
  const unsafeApply = await (
    await postSigned("publications/reconcile", {
      apply: true,
      max_items: 1,
    })
  ).json();
  assert.equal(unsafeApply.changed, 0);
  assert.equal(unsafeApply.stale_revision_changed, 0);
  assert.deepEqual(unsafeApply.sample, dryRun.sample);
  assert.deepEqual(
    await (
      await postSigned("publications/supersede", {
        items: [{ item_key: stale.key, revision: stale.revision }],
      })
    ).json(),
    { ok: true, superseded: 0, skipped: 1 },
  );
  const attempt = lifecycle.authorizeCommandAcknowledgement({
    ...identity,
    statusMarker: marker,
    statusCommentId: 179600,
    observedAt: Date.now(),
  });
  assert.equal(attempt.allowed, true);
  assert.equal(
    (
      await postSigned("lifecycle/command-ack/observed", {
        canonical_target_key: identity.canonicalTargetKey,
        fence_key: identity.fenceKey,
        revision: identity.revision,
        status_marker: marker,
        command_comment_id: 17960,
        completion_comment_id: 179600,
        observed_at: Date.now(),
      })
    ).status,
    200,
  );
  const before = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.deepEqual(
    await (
      await postSigned("publications/supersede", {
        items: [{ item_key: stale.key, revision: stale.revision }],
      })
    ).json(),
    { ok: true, superseded: 1, skipped: 0 },
  );
  const after = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.equal(
    after.lanes.publication.completed_total,
    before.lanes.publication.completed_total + 1,
  );
  assert.equal(
    after.lanes.publication.superseded_total,
    before.lanes.publication.superseded_total + 1,
  );
  const state = storage.sql.readNormalizedQueue() as {
    items: Record<string, ExactReviewQueueItem>;
  };
  assert.equal(state.items[stale.key], undefined);
  assert.ok(state.items[fresh.key]);
});

test("publication reconciliation derives every acknowledgement state from the exact queue revision", async () => {
  const storage = new MemoryDurableStorage();
  type AcknowledgementCase = {
    name: string;
    producerCommand: boolean;
    admissionCommand?: boolean;
    markerMismatch?: boolean;
    commentMismatch?: boolean;
    forceAcknowledgementNotRequired?: boolean;
    terminal?: "review_completed_routed" | "requeue";
    canonical?: boolean;
    router?: boolean;
    acknowledgement?: "observed" | "skipped_locked" | "skipped_missing_comment";
    requeueAfterAcknowledgement?: boolean;
    acknowledgementState:
      | "not_required"
      | "pending"
      | "observed"
      | "skipped_locked"
      | "skipped_missing_comment"
      | "unavailable";
    supersedeSafe: boolean;
    unavailableReason: string | null;
  };
  const cases: AcknowledgementCase[] = [
    {
      name: "pending",
      producerCommand: true,
      terminal: "review_completed_routed",
      canonical: true,
      router: true,
      acknowledgementState: "pending",
      supersedeSafe: false,
      unavailableReason: null,
    },
    {
      name: "not_required",
      producerCommand: false,
      acknowledgementState: "not_required",
      supersedeSafe: true,
      unavailableReason: null,
    },
    {
      name: "observed",
      producerCommand: true,
      terminal: "review_completed_routed",
      canonical: true,
      router: true,
      acknowledgement: "observed",
      acknowledgementState: "observed",
      supersedeSafe: true,
      unavailableReason: null,
    },
    {
      name: "skipped_locked",
      producerCommand: true,
      terminal: "review_completed_routed",
      canonical: true,
      router: true,
      acknowledgement: "skipped_locked",
      acknowledgementState: "skipped_locked",
      supersedeSafe: true,
      unavailableReason: null,
    },
    {
      name: "skipped_missing_comment",
      producerCommand: true,
      terminal: "review_completed_routed",
      canonical: true,
      router: true,
      acknowledgement: "skipped_missing_comment",
      acknowledgementState: "skipped_missing_comment",
      supersedeSafe: true,
      unavailableReason: null,
    },
    {
      name: "observed_requeued",
      producerCommand: true,
      terminal: "review_completed_routed",
      canonical: true,
      router: true,
      acknowledgement: "observed",
      requeueAfterAcknowledgement: true,
      acknowledgementState: "observed",
      supersedeSafe: true,
      unavailableReason: null,
    },
    {
      name: "skipped_locked_requeued",
      producerCommand: true,
      terminal: "review_completed_routed",
      canonical: true,
      router: true,
      acknowledgement: "skipped_locked",
      requeueAfterAcknowledgement: true,
      acknowledgementState: "skipped_locked",
      supersedeSafe: true,
      unavailableReason: null,
    },
    {
      name: "skipped_missing_comment_requeued",
      producerCommand: true,
      terminal: "review_completed_routed",
      canonical: true,
      router: true,
      acknowledgement: "skipped_missing_comment",
      requeueAfterAcknowledgement: true,
      acknowledgementState: "skipped_missing_comment",
      supersedeSafe: true,
      unavailableReason: null,
    },
    {
      name: "projection_missing",
      producerCommand: true,
      acknowledgementState: "unavailable",
      supersedeSafe: false,
      unavailableReason: "projection_missing",
    },
    {
      name: "projection_not_command",
      producerCommand: true,
      admissionCommand: false,
      acknowledgementState: "unavailable",
      supersedeSafe: false,
      unavailableReason: "projection_not_command",
    },
    {
      name: "marker_mismatch",
      producerCommand: true,
      markerMismatch: true,
      acknowledgementState: "unavailable",
      supersedeSafe: false,
      unavailableReason: "marker_mismatch",
    },
    {
      name: "comment_mismatch",
      producerCommand: true,
      commentMismatch: true,
      acknowledgementState: "unavailable",
      supersedeSafe: false,
      unavailableReason: "comment_mismatch",
    },
    {
      name: "acknowledgement_not_required",
      producerCommand: true,
      forceAcknowledgementNotRequired: true,
      acknowledgementState: "unavailable",
      supersedeSafe: false,
      unavailableReason: "acknowledgement_not_required",
    },
    {
      name: "lifecycle_requeued",
      producerCommand: true,
      terminal: "requeue",
      acknowledgementState: "unavailable",
      supersedeSafe: false,
      unavailableReason: "lifecycle_requeued",
    },
    {
      name: "terminal_missing",
      producerCommand: true,
      acknowledgementState: "unavailable",
      supersedeSafe: false,
      unavailableReason: "terminal_missing",
    },
    {
      name: "routed_receipts_incomplete",
      producerCommand: true,
      terminal: "review_completed_routed",
      acknowledgementState: "unavailable",
      supersedeSafe: false,
      unavailableReason: "routed_receipts_incomplete",
    },
  ];
  const items: Record<string, ExactReviewQueueItem> = {};
  const staleByName = new Map<string, ExactReviewQueueItem>();
  for (const [index, entry] of cases.entries()) {
    const number = 18000 + index;
    const stale = leasedExactReviewPublicationItem(number, `${number}0`);
    const fresh = leasedExactReviewPublicationItem(number, `${number}1`);
    stale.state = "pending";
    stale.revision = 4;
    stale.decision.publication!.leaseRevision = 1;
    stale.leaseDecision!.publication!.leaseRevision = 1;
    fresh.state = "pending";
    fresh.decision.publication!.leaseRevision = 2;
    fresh.leaseDecision!.publication!.leaseRevision = 2;
    if (entry.producerCommand) {
      Object.assign(stale.decision.publication!.producerDecision, {
        commandStatusMarker: `<!-- clawsweeper-command-status:${number}:re_review:${"b".repeat(40)} -->`,
        statusCommentId: number * 10,
      });
    }
    items[stale.key] = stale;
    items[fresh.key] = fresh;
    staleByName.set(entry.name, stale);
  }
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  for (const entry of cases) {
    if (entry.name === "not_required" || entry.name === "projection_missing") continue;
    const item = staleByName.get(entry.name)!;
    const source = item.decision.publication!.producerDecision;
    const identity = {
      canonicalTargetKey: `${source.targetRepo}#${source.itemNumber}`,
      fenceKey: item.key,
      revision: item.revision,
    };
    const projectionMarker = entry.markerMismatch
      ? `<!-- clawsweeper-command-status:${source.itemNumber}:re_review:${"c".repeat(40)} -->`
      : source.commandStatusMarker!;
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `ack-state-${entry.name}`,
      sourceAction: source.sourceAction,
      commandOriginated: entry.admissionCommand ?? entry.producerCommand,
      statusMarker: projectionMarker,
      statusCommentId: entry.commentMismatch
        ? source.statusCommentId! + 1
        : source.statusCommentId!,
      observedAt: 1,
    });
    if (entry.forceAcknowledgementNotRequired) {
      const projection = lifecycle.read(
        identity.canonicalTargetKey,
        identity.fenceKey,
        identity.revision,
      )!;
      projection.acknowledgement.required = false;
      storage.sql.exec(
        "UPDATE exact_review_lifecycle_projection_v1 SET projection_json = ? WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?",
        JSON.stringify(projection),
        identity.canonicalTargetKey,
        identity.fenceKey,
        identity.revision,
      );
    }
    if (entry.canonical) {
      lifecycle.recordCanonicalReceipt({
        ...identity,
        outcome: "accepted",
        receiptId: `canonical-${entry.name}`,
        observedAt: 2,
      });
    }
    if (entry.router) {
      lifecycle.recordRouterReceipt({
        ...identity,
        outcome: "durable",
        receiptId: `router-${entry.name}`,
        observedAt: 3,
      });
    }
    if (entry.terminal) {
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: entry.terminal,
        observedAt: 4,
      });
    }
    if (!entry.acknowledgement) continue;
    const attempt = lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: source.commandStatusMarker!,
      statusCommentId: source.statusCommentId!,
      observedAt: 5,
    });
    assert.equal(attempt.allowed, true);
    if (entry.acknowledgement === "observed") {
      lifecycle.observeCommandAcknowledgement({
        ...identity,
        statusMarker: source.commandStatusMarker!,
        statusCommentId: source.statusCommentId!,
        commandCommentId: source.itemNumber,
        completionCommentId: source.statusCommentId!,
        observedAt: 6,
      });
    } else {
      lifecycle.recordCommandAcknowledgementTerminalSkip({
        ...identity,
        attemptId: attempt.attemptId!,
        statusMarker: source.commandStatusMarker!,
        statusCommentId: source.statusCommentId!,
        reason:
          entry.acknowledgement === "skipped_locked"
            ? "locked_conversation"
            : "missing_status_comment",
        observedAt: 6,
      });
    }
    if (entry.requeueAfterAcknowledgement) {
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: "requeue",
        observedAt: 7,
      });
    }
  }
  const queue = new ExactReviewQueue({ storage }, {});
  const result = await (
    await queue.fetch(
      new Request("https://queue/publications/reconcile", {
        method: "POST",
        body: JSON.stringify({ max_items: 20 }),
      }),
    )
  ).json();
  const sampleByTarget = new Map(result.sample.map((entry) => [entry.target_key, entry]));
  for (const entry of cases) {
    const item = staleByName.get(entry.name)!;
    const source = item.decision.publication!.producerDecision;
    const sample = sampleByTarget.get(`${source.targetRepo}#${source.itemNumber}`);
    assert.deepEqual(
      {
        queueRevision: sample.queue_revision,
        commandContext: sample.command_context,
        acknowledgementState: sample.acknowledgement_state,
        acknowledgementUnavailableReason: sample.acknowledgement_unavailable_reason,
        successorFenceState: sample.successor_fence_state,
        supersedeSafe: sample.supersede_safe,
      },
      {
        queueRevision: 4,
        commandContext: entry.producerCommand,
        acknowledgementState: entry.acknowledgementState,
        acknowledgementUnavailableReason: entry.unavailableReason,
        successorFenceState: entry.name === "terminal_missing" ? "admission_missing" : null,
        supersedeSafe: entry.supersedeSafe,
      },
    );
    assert.equal(
      sample.acknowledgement_state === "unavailable",
      sample.acknowledgement_unavailable_reason !== null,
    );
  }
  const applied = await (
    await queue.fetch(
      new Request("https://queue/publications/reconcile", {
        method: "POST",
        body: JSON.stringify({ apply: true, max_items: 1 }),
      }),
    )
  ).json();
  assert.equal(applied.changed, 0);
  assert.equal(applied.sample[0].target_key, "openclaw/openclaw#18000");
  assert.equal(applied.sample[0].acknowledgement_state, "pending");
  assert.equal(applied.sample[0].acknowledgement_unavailable_reason, null);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, ExactReviewQueueItem>;
  };
  assert.ok(state.items[staleByName.get("pending")!.key]);
  assert.ok(state.items[staleByName.get("not_required")!.key]);
});

test("publication reconciliation preserves and does not transplant an unsafe command lineage", async () => {
  const storage = new MemoryDurableStorage();
  const retained = leasedExactReviewPublicationItem(18020, "180200");
  const ordinary = leasedExactReviewPublicationItem(18020, "180201");
  const command = leasedExactReviewPublicationItem(18020, "180202");
  for (const item of [retained, ordinary, command]) {
    item.state = "pending";
    item.revision = 4;
    item.decision.publication!.leaseRevision = 1;
    item.leaseDecision!.publication!.leaseRevision = 1;
  }
  retained.createdAt = 1;
  ordinary.createdAt = 2;
  command.createdAt = 3;
  Object.assign(command.decision.publication!.producerDecision, {
    commandStatusMarker: `<!-- clawsweeper-command-status:18020:re_review:${"d".repeat(40)} -->`,
    statusCommentId: 180202,
  });
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [retained.key]: retained, [ordinary.key]: ordinary, [command.key]: command },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const result = await (
    await queue.fetch(
      new Request("https://queue/publications/reconcile", {
        method: "POST",
        body: JSON.stringify({ apply: true, max_items: 100 }),
      }),
    )
  ).json();
  assert.equal(result.changed, 1);
  assert.equal(result.lineage_refreshed, 0);
  assert.deepEqual(
    {
      itemKey: result.sample[1].item_key,
      commandContext: result.sample[1].command_context,
      acknowledgementState: result.sample[1].acknowledgement_state,
      supersedeSafe: result.sample[1].supersede_safe,
    },
    {
      itemKey: command.key,
      commandContext: true,
      acknowledgementState: "unavailable",
      supersedeSafe: false,
    },
  );
  const state = storage.sql.readNormalizedQueue() as {
    items: Record<string, ExactReviewQueueItem>;
  };
  assert.ok(state.items[retained.key]);
  assert.equal(state.items[retained.key]!.decision.publication!.producerRunId, "180200");
  assert.equal(state.items[ordinary.key], undefined);
  assert.ok(state.items[command.key]);
});

test("stale command successor diagnostics match the alarm ownership fence", async () => {
  const scenarios = [
    ["stale_projection_mismatch", null],
    ["existing_requeue", null],
    ["missing_successor", "missing"],
    ["ambiguous_successor", "ambiguous"],
    ["successor_projection_missing", "admission_missing"],
    ["successor_command_mismatch", "admission_command_mismatch"],
    ["successor_marker_mismatch", "admission_marker_mismatch"],
    ["successor_comment_mismatch", "admission_comment_mismatch"],
    ["verified", "verified"],
  ] as const;
  for (const [index, [scenario, expectedFenceState]] of scenarios.entries()) {
    const storage = new MemoryDurableStorage();
    const number = 18030 + index;
    const stale = leasedExactReviewPublicationItem(number, `${number}0`);
    const fresh = leasedExactReviewPublicationItem(number, `${number}1`);
    const marker = `<!-- clawsweeper-command-status:${number}:re_review:${"e".repeat(40)} -->`;
    stale.state = "pending";
    stale.revision = 4;
    stale.decision.publication!.leaseRevision = 1;
    Object.assign(stale.decision.publication!.producerDecision, {
      commandStatusMarker: marker,
      statusCommentId: number * 10,
    });
    fresh.state = "pending";
    fresh.decision.publication!.leaseRevision = 2;
    Object.assign(fresh.decision.publication!.producerDecision, {
      commandStatusMarker: marker,
      statusCommentId: number * 10,
    });
    const items = { [stale.key]: stale, [fresh.key]: fresh };
    if (scenario === "missing_successor") delete items[fresh.key];
    if (scenario === "ambiguous_successor") {
      const duplicate = leasedExactReviewPublicationItem(number, `${number}2`);
      duplicate.state = "pending";
      duplicate.decision.publication!.leaseRevision = 2;
      Object.assign(duplicate.decision.publication!.producerDecision, {
        commandStatusMarker: marker,
        statusCommentId: number * 10,
      });
      items[duplicate.key] = duplicate;
    }
    await storage.put("exact-review-queue", { deliveries: {}, items });
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${number}`,
      fenceKey: stale.key,
      revision: stale.revision,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `automatic-terminal-${scenario}`,
      sourceAction: "re_review",
      commandOriginated: true,
      statusMarker: scenario === "stale_projection_mismatch" ? `${marker}:mismatch` : marker,
      statusCommentId: number * 10,
      observedAt: 1,
    });
    if (scenario === "existing_requeue") {
      lifecycle.recordTerminalDisposition({ ...identity, kind: "requeue", observedAt: 2 });
    }
    const queue = publicPublicationQueue(storage);
    if (scenario === "missing_successor") {
      await queue.fetch(new Request("https://queue/stats"));
      storage.sql.exec(
        `INSERT INTO exact_review_publication_heads (target_key, source_revision, updated_at)
         VALUES (?, 2, ?) ON CONFLICT(target_key) DO UPDATE SET source_revision = 2`,
        `openclaw/openclaw#${number}`,
        Date.now(),
      );
    } else if (scenario !== "successor_projection_missing") {
      for (const successor of Object.values(items).filter((item) => item !== stale)) {
        const producer = successor.decision.publication!.producerDecision;
        lifecycle.recordAdmission({
          canonicalTargetKey: `openclaw/openclaw#${number}`,
          fenceKey: successor.key,
          revision: successor.revision,
          deliveryId: `successor-${successor.key}`,
          sourceAction: producer.sourceAction,
          commandOriginated: scenario !== "successor_command_mismatch",
          statusMarker: scenario === "successor_marker_mismatch" ? `${marker}:mismatch` : marker,
          statusCommentId:
            scenario === "successor_comment_mismatch" ? number * 10 + 1 : number * 10,
          observedAt: 3,
        });
      }
    }
    const reconciled = await (
      await queue.fetch(
        new Request("https://queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ max_items: 1 }),
        }),
      )
    ).json();
    assert.equal(reconciled.changed, 0);
    assert.equal(reconciled.sample[0].successor_fence_state, expectedFenceState);
    await queue.alarm();
    const state = storage.sql.readNormalizedQueue() as {
      items: Record<string, ExactReviewQueueItem>;
    };
    if (scenario === "verified") assert.equal(state.items[stale.key], undefined);
    else assert.ok(state.items[stale.key]);
    if (scenario !== "missing_successor") assert.ok(state.items[fresh.key]);
    assert.equal(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)
        ?.terminalDisposition?.kind,
      scenario === "existing_requeue" || scenario === "verified" ? "requeue" : undefined,
    );
    await queue.alarm();
    const replayed = storage.sql.readNormalizedQueue() as {
      items: Record<string, ExactReviewQueueItem>;
    };
    if (scenario === "verified") assert.equal(replayed.items[stale.key], undefined);
    else assert.ok(replayed.items[stale.key]);
  }
});

test("max-items one does not reclaim an unsampled expired lineage lease", async () => {
  const storage = new MemoryDurableStorage();
  const expired = leasedExactReviewPublicationItem(18021, "180210");
  const duplicate = leasedExactReviewPublicationItem(18021, "180211");
  expired.leaseExpiresAt = Date.now() - 1;
  duplicate.state = "pending";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [expired.key]: expired, [duplicate.key]: duplicate },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const result = await (
    await queue.fetch(
      new Request("https://queue/publications/reconcile", {
        method: "POST",
        body: JSON.stringify({ apply: true, max_items: 1 }),
      }),
    )
  ).json();
  assert.equal(result.changed, 0);
  assert.equal(result.sample.length, 0);
  const state = storage.sql.readNormalizedQueue() as {
    items: Record<string, ExactReviewQueueItem>;
  };
  assert.equal(state.items[expired.key]!.state, "leased");
  assert.equal(state.items[expired.key]!.leaseId, expired.leaseId);
});

test("publication supersede preserves stale rows with active ownership or mutable identity", async () => {
  const storage = new MemoryDurableStorage();
  const states = ["safe", "active_batch", "leased", "dispatching", "finalizer"] as const;
  const items: Record<string, ExactReviewQueueItem> = {};
  const staleByState = new Map<(typeof states)[number], ExactReviewQueueItem>();
  for (const [index, state] of states.entries()) {
    const number = 18100 + index;
    const stale = leasedExactReviewPublicationItem(number, `${number}0`);
    const fresh = leasedExactReviewPublicationItem(number, `${number}1`);
    stale.revision = 4;
    stale.decision.publication!.leaseRevision = 1;
    stale.leaseDecision!.publication!.leaseRevision = 1;
    stale.state =
      state === "leased" ? "leased" : state === "dispatching" ? "dispatching" : "pending";
    fresh.state = "pending";
    fresh.decision.publication!.leaseRevision = 2;
    fresh.leaseDecision!.publication!.leaseRevision = 2;
    if (state === "finalizer") {
      stale.terminalFinalization = {
        disposition: "superseded",
        statusState: "Complete",
        statusDetail: "Retained acknowledgement driver.",
        projection: {
          canonicalTargetKey: `${stale.decision.targetRepo}#${stale.decision.itemNumber}`,
          fenceKey: stale.key,
          revision: stale.revision,
        },
      };
    }
    items[stale.key] = stale;
    items[fresh.key] = fresh;
    staleByState.set(state, stale);
  }
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  for (const [state, item] of staleByState) {
    const source = item.decision.publication!.producerDecision;
    lifecycle.recordAdmission({
      canonicalTargetKey: `${source.targetRepo}#${source.itemNumber}`,
      fenceKey: item.key,
      revision: item.revision,
      deliveryId: `supersede-protection-${state}`,
      sourceAction: source.sourceAction,
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      observedAt: 1,
    });
  }
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  const active = staleByState.get("active_batch")!;
  assert.ok(
    batches.claim({
      batchId: "supersede-protection",
      leaseOwner: "worker",
      leaseExpiresAt: Date.now() + 60_000,
      now: Date.now(),
      maxItems: 1,
      candidates: [{ itemKey: active.key, revision: active.revision }],
    }),
  );
  const queue = new ExactReviewQueue({ storage }, {});
  const safe = staleByState.get("safe")!;
  const response = await queue.fetch(
    new Request("https://queue/publications/supersede", {
      method: "POST",
      body: JSON.stringify({
        items: [
          { item_key: safe.key, revision: safe.revision - 1 },
          ...[...staleByState.values()].map((item) => ({
            item_key: item.key,
            revision: item.revision,
          })),
        ],
      }),
    }),
  );
  assert.deepEqual(await response.json(), { ok: true, superseded: 1, skipped: 5 });
  const state = storage.sql.readNormalizedQueue() as {
    items: Record<string, ExactReviewQueueItem>;
  };
  assert.equal(state.items[safe.key], undefined);
  for (const name of states.slice(1)) assert.ok(state.items[staleByState.get(name)!.key]);
});

test("Worker lifecycle acknowledgement preserves canonical GitHub repository casing", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const marker = "<!-- clawsweeper-command-status:780:re_review:token -->";
  const identity = {
    canonicalTargetKey: "steipete/CamSnap#780",
    fenceKey: "steipete/CamSnap#780@exact",
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "case-preserving-delivery:780",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: marker,
    statusCommentId: 9101,
    observedAt: 1_700_000_000_000,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "case-preserving:accepted",
    observedAt: 1_700_000_000_001,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "case-preserving:router",
    observedAt: 1_700_000_000_002,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_003,
  });
  assert.equal(
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: marker,
      statusCommentId: 9101,
      observedAt: 1_700_000_000_004,
    }).allowed,
    true,
  );

  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "case-preserving-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "steipete/CamSnap",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 780 },
        comment: {
          id: 9101,
          body: [
            "<!-- clawsweeper-command-ack:123 -->",
            marker,
            "<!-- clawsweeper-command-progress:start -->",
            "Re-review progress:",
            "- State: Complete",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: "2026-07-30T00:00:00.000Z",
          updated_at: "2026-07-30T00:01:00.000Z",
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "case-preserving-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      STATUS_STORE: new MemoryKv(),
      hostedPublicTargetProbe: async () => "public" as const,
    },
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "recorded Bay journey completion",
  });
  assert.equal(
    lifecycleState(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!,
    ),
    "completed",
  );
});

test("Worker converges legacy and non-review acknowledgement receipts without webhook races", async () => {
  let itemNumber = 780;
  for (const intent of ["re_review", "automerge", "autofix"]) {
    for (const legacy of [false, true]) {
      itemNumber += 1;
      const storage = new MemoryDurableStorage();
      const queue = new ExactReviewQueue({ storage }, {});
      const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
      const statusMarker = `<!-- clawsweeper-command-status:${itemNumber}:${intent}:head -->`;
      const identity = {
        canonicalTargetKey: `openclaw/openclaw#${itemNumber}`,
        fenceKey: `openclaw/openclaw#${itemNumber}@exact`,
        revision: 1,
      };
      lifecycle.recordAdmission({
        ...identity,
        deliveryId: `legacy-acknowledgement:${itemNumber}`,
        sourceAction: intent,
        commandOriginated: true,
        statusMarker,
        statusCommentId: itemNumber + 10_000,
        observedAt: 1_700_000_000_000,
      });
      lifecycle.recordCanonicalReceipt({
        ...identity,
        outcome: "accepted",
        receiptId: `legacy-acknowledgement:${itemNumber}:canonical`,
        observedAt: 1_700_000_000_001,
      });
      lifecycle.recordRouterReceipt({
        ...identity,
        outcome: "durable",
        receiptId: `legacy-acknowledgement:${itemNumber}:router`,
        observedAt: 1_700_000_000_002,
      });
      lifecycle.recordTerminalDisposition({
        ...identity,
        kind: "review_completed_routed",
        observedAt: 1_700_000_000_003,
      });
      assert.equal(
        lifecycle.authorizeCommandAcknowledgement({
          ...identity,
          statusMarker,
          statusCommentId: itemNumber + 10_000,
          observedAt: 1_700_000_000_004,
        }).allowed,
        true,
      );

      const marker = legacy
        ? `<!-- clawsweeper-command:123:2026-08-01T08:13:51Z:${intent}:head -->`
        : "<!-- clawsweeper-command-ack:123 -->";
      const response = await worker.fetch(
        signedGithubWebhookRequest({
          event: "issue_comment",
          secret: "legacy-acknowledgement-secret",
          payload: {
            action: "edited",
            repository: {
              full_name: "openclaw/openclaw",
              private: false,
              archived: false,
              fork: false,
              has_issues: true,
            },
            issue: { number: itemNumber },
            comment: {
              id: itemNumber + 10_000,
              body: [
                marker,
                statusMarker,
                "<!-- clawsweeper-command-progress:start -->",
                "- State: Complete",
                "- Detail: Done.",
                "<!-- clawsweeper-command-progress:end -->",
              ].join("\n"),
              created_at: "2026-07-30T00:00:00.000Z",
              updated_at: "2026-07-30T00:01:00.000Z",
              user: { login: "clawsweeper[bot]" },
            },
          },
        }),
        {
          CLAWSWEEPER_WEBHOOK_SECRET: "legacy-acknowledgement-secret",
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
          STATUS_STORE: new MemoryKv(),
          hostedPublicTargetProbe: async () => "public" as const,
        },
      );
      assert.deepEqual(await response.json(), {
        ok: true,
        accepted: false,
        reason:
          intent === "re_review"
            ? "recorded Bay journey completion"
            : "recorded lifecycle acknowledgement",
      });
      assert.equal(
        lifecycle.observeCommandAcknowledgement({
          canonicalTargetKey: identity.canonicalTargetKey,
          statusMarker,
          commandCommentId: 123,
          completionCommentId: itemNumber + 10_000,
          observedAt: 1_700_000_000_005,
        }).accepted,
        true,
      );
    }
  }
});

test("Worker binds legacy webhooks while preserving marker-only command addresses", async () => {
  for (const mismatch of ["comment", "marker", "marker-only", "id-only"]) {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue({ storage }, {});
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const itemNumber =
      mismatch === "comment"
        ? 910
        : mismatch === "marker"
          ? 911
          : mismatch === "marker-only"
            ? 912
            : 914;
    const expectedMarker = `<!-- clawsweeper-command-status:${itemNumber}:re_review:expected -->`;
    const admissionMarker = mismatch === "id-only" ? null : expectedMarker;
    const receivedMarker =
      mismatch === "marker"
        ? `<!-- clawsweeper-command-status:${itemNumber}:re_review:other -->`
        : expectedMarker;
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${itemNumber}`,
      fenceKey: `openclaw/openclaw#${itemNumber}@exact`,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `legacy-source-fence:${itemNumber}`,
      sourceAction: "re_review",
      commandOriginated: true,
      statusMarker: admissionMarker,
      statusCommentId: mismatch === "marker-only" ? null : 9101,
      observedAt: 1_700_000_000_000,
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: "accepted",
      receiptId: `legacy-source-fence:${itemNumber}:canonical`,
      observedAt: 1_700_000_000_001,
    });
    lifecycle.recordRouterReceipt({
      ...identity,
      outcome: "durable",
      receiptId: `legacy-source-fence:${itemNumber}:router`,
      observedAt: 1_700_000_000_002,
    });
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: 1_700_000_000_003,
    });
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: admissionMarker,
      statusCommentId: mismatch === "marker-only" ? null : 9101,
      observedAt: 1_700_000_000_004,
    });

    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "legacy-source-fence-secret",
        payload: {
          action: "edited",
          repository: {
            full_name: "openclaw/openclaw",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: itemNumber },
          comment: {
            id: mismatch === "comment" || mismatch === "marker-only" ? 9102 : 9101,
            body: [
              `<!-- clawsweeper-command:456:2026-08-01T08:13:51Z:re_review:${mismatch === "marker" ? "other" : "expected"} -->`,
              receivedMarker,
              "<!-- clawsweeper-command-progress:start -->",
              "- State: Complete",
              "- Detail: Done.",
              "<!-- clawsweeper-command-progress:end -->",
            ].join("\n"),
            created_at: "2026-07-30T00:00:00.000Z",
            updated_at: "2026-07-30T00:01:00.000Z",
            user: { login: "clawsweeper[bot]" },
          },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "legacy-source-fence-secret",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
        STATUS_STORE: new MemoryKv(),
        hostedPublicTargetProbe: async () => "public" as const,
      },
    );

    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: false,
      reason:
        mismatch === "marker-only" || mismatch === "id-only"
          ? "recorded Bay journey completion"
          : "unmatched lifecycle acknowledgement",
    });
    assert.equal(
      lifecycleState(lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, 1)!),
      mismatch === "marker-only" || mismatch === "id-only"
        ? "completed"
        : "acknowledgement_pending",
    );
  }
});

test("signed terminal receipts bind legacy migration to its admitted status comment", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const statusStore = new MemoryKv();
  const now = Date.now();
  const canonicalTargetKey = "openclaw/openclaw#915";
  const statusMarker = "<!-- clawsweeper-command-status:915:re_review:migrated -->";
  const identity = {
    canonicalTargetKey,
    fenceKey: `${canonicalTargetKey}@exact`,
    revision: 1,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "migrated-bay:915",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker,
    statusCommentId: 9301,
    observedAt: now,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "migrated-bay:canonical",
    observedAt: now + 1,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "migrated-bay:router",
    observedAt: now + 2,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: now + 3,
  });
  lifecycle.authorizeCommandAcknowledgement({
    ...identity,
    statusMarker,
    statusCommentId: 9301,
    observedAt: now + 4,
  });
  await statusStore.put(
    "openclaw-bay:journey-state:v1",
    JSON.stringify(
      mergeBayJourneyState(
        null,
        [
          {
            repository: "openclaw/openclaw",
            number: 915,
            source_comment_id: 555,
            source_delivery_id: "migrated-bay-delivery",
            triggered_at: new Date(now).toISOString(),
          },
        ],
        [],
        new Date(now).toISOString(),
      ),
    ),
  );

  const secret = "migrated-bay-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    STATUS_STORE: statusStore,
  };
  const sendReceipt = (admittedCommentId: number) => {
    const body = JSON.stringify({
      canonical_target_key: canonicalTargetKey,
      status_marker: statusMarker,
      status_comment_id: admittedCommentId,
      command_comment_id: 555,
      completion_comment_id: 9302,
      completed_at: new Date(now + 5).toISOString(),
      observed_at: now + 15,
    });
    return worker.fetch(
      new Request(
        "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/command-ack/observed",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret)
              .update(body)
              .digest("hex")}`,
          },
          body,
        },
      ),
      env,
    );
  };

  assert.equal((await (await sendReceipt(9302)).json()).accepted, false);
  const incomplete = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1"))!).journeys;
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].completed_at ?? null, null);

  await statusStore.put(
    "openclaw-bay:journey-state:v1",
    JSON.stringify(
      mergeBayJourneyState(
        { schema_version: 1, journeys: incomplete },
        [
          {
            repository: "openclaw/openclaw",
            number: 915,
            source_comment_id: 555,
            source_delivery_id: "newer-edit",
            triggered_at: new Date(now + 10).toISOString(),
          },
        ],
        [],
        new Date(now + 10).toISOString(),
      ),
    ),
  );

  const response = await sendReceipt(9301);

  assert.equal((await response.json()).accepted, true);
  const journeys = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1"))!).journeys;
  const completed = journeys.find(
    (journey) => journey.source_delivery_id === "migrated-bay-delivery",
  );
  const newer = journeys.find((journey) => journey.source_delivery_id === "newer-edit");
  assert.equal(completed.completion_comment_id, 9302);
  assert.equal(completed.completed_at, new Date(now + 5).toISOString());
  assert.equal(newer.completed_at, null);
  assert.equal(
    lifecycleState(lifecycle.read(canonicalTargetKey, identity.fenceKey, 1)!),
    "completed",
  );
});

test("signed migrated receipts cannot complete a newer same-marker lifecycle revision", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const statusStore = new MemoryKv();
  const now = Date.now();
  const target = "openclaw/openclaw#917";
  const marker = "<!-- clawsweeper-command-status:917:re_review:same-head -->";
  for (const [revision, statusCommentId, name] of [
    [1, 9301, "older"],
    [2, 9301, "newer"],
  ] as const) {
    const identity = {
      canonicalTargetKey: target,
      fenceKey: `${target}@exact:${name}`,
      revision,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `publisher:${name}:1`,
      sourceDeliveryId: `github-delivery:${name}`,
      sourceAction: "re_review",
      commandOriginated: true,
      statusMarker: marker,
      statusCommentId,
      observedAt: now + revision,
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: "accepted",
      receiptId: `same-head:canonical:${name}`,
      observedAt: now + 10 + revision,
    });
    lifecycle.recordRouterReceipt({
      ...identity,
      outcome: "durable",
      receiptId: `same-head:router:${name}`,
      observedAt: now + 20 + revision,
    });
    lifecycle.recordTerminalDisposition({
      ...identity,
      kind: "review_completed_routed",
      observedAt: now + 30 + revision,
    });
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: marker,
      statusCommentId,
      observedAt: now + 40 + revision,
    });
  }

  const secret = "same-head-revision-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    STATUS_STORE: statusStore,
    hostedPublicTargetProbe: async () => "public" as const,
  };
  await statusStore.put(
    "openclaw-bay:journey-state:v1",
    JSON.stringify(
      mergeBayJourneyState(
        null,
        [
          {
            repository: "openclaw/openclaw",
            number: 917,
            source_comment_id: 555,
            source_delivery_id: "github-delivery:older",
            triggered_at: new Date(now + 1).toISOString(),
          },
          {
            repository: "openclaw/openclaw",
            number: 917,
            source_comment_id: 555,
            source_delivery_id: "github-delivery:newer",
            triggered_at: new Date(now + 2).toISOString(),
          },
        ],
        [],
        new Date(now).toISOString(),
      ),
    ),
  );
  const payload = {
    canonical_target_key: target,
    fence_key: `${target}@exact:older`,
    revision: 1,
    status_marker: marker,
    status_comment_id: 9301,
    command_comment_id: 555,
    completion_comment_id: 9302,
    completed_at: new Date(now + 50).toISOString(),
    observed_at: now + 51,
  };
  const ambiguousWebhook = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret,
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 917 },
        comment: {
          id: 9302,
          body: [
            "<!-- clawsweeper-command-ack:555 -->",
            marker,
            "<!-- clawsweeper-command-progress:start -->",
            "- State: Complete",
            "- Detail: Done.",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: payload.completed_at,
          updated_at: payload.completed_at,
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    env,
  );
  assert.equal((await ambiguousWebhook.json()).reason, "unmatched lifecycle acknowledgement");
  assert.equal(
    lifecycleState(lifecycle.read(target, `${target}@exact:older`, 1)!),
    "acknowledgement_pending",
  );
  assert.equal(
    lifecycleState(lifecycle.read(target, `${target}@exact:newer`, 2)!),
    "acknowledgement_pending",
  );
  const body = JSON.stringify(payload);
  const response = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/lifecycle/command-ack/observed",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret)
            .update(body)
            .digest("hex")}`,
        },
        body,
      },
    ),
    env,
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: true,
    lifecycle_state: "completed",
    acknowledgement_state: "observed",
    version: 1,
    source_delivery_id: "github-delivery:older",
  });
  assert.equal(lifecycleState(lifecycle.read(target, `${target}@exact:older`, 1)!), "completed");
  assert.equal(
    lifecycleState(lifecycle.read(target, `${target}@exact:newer`, 2)!),
    "acknowledgement_pending",
  );
  const journeys = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1"))!).journeys;
  const older = journeys.find((journey) => journey.source_delivery_id === "github-delivery:older");
  const newer = journeys.find((journey) => journey.source_delivery_id === "github-delivery:newer");
  assert.equal(older.completed_at, payload.completed_at);
  assert.equal(newer.completed_at, null);

  const malformed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/observed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, status_comment_id: "9301" }),
    }),
  );
  assert.equal(malformed.status, 400);

  for (const invalidIdentity of [
    { fence_key: `${target}@exact:older`, revision: undefined },
    { fence_key: undefined, revision: 1 },
    { fence_key: `${target}@exact:older`, revision: "1" },
  ]) {
    const malformedIdentity = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/observed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, ...invalidIdentity }),
      }),
    );
    assert.equal(malformedIdentity.status, 400);
  }
});

test("audit cursor checkpoints survive reconstruction and reject stale batch writers", async () => {
  const { fetchDurableCursor, putDurableCursor } = await import("../dist/durable-cursor-store.js");
  const storage = new MemoryDurableStorage();
  const secret = "synthetic-audit-cursor";
  let queue = new ExactReviewQueue({ storage }, {});
  const store = {
    baseUrl: "https://clawsweeper.openclaw.ai",
    webhookSecret: secret,
    mode: "audit",
    attempts: 1,
    fetchImpl: async (url, init) =>
      worker.fetch(new Request(url, init), {
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      }),
  };
  const batch = {
    remainingTargets: [
      { targetRepo: "synthetic/audit-4", defaultBranch: "main", visibility: "PUBLIC" },
    ],
    outstandingRunIds: ["1", "2", "3"],
    dispatchingTarget: null,
  };
  const empty = await fetchDurableCursor(store);
  assert.equal(empty.auditBatch, null);
  const written = await putDurableCursor(store, 12, empty.revision, batch);
  queue = new ExactReviewQueue({ storage }, {});
  assert.deepEqual(await fetchDurableCursor(store), written);
  assert.deepEqual(written.auditBatch, batch);
  await assert.rejects(putDurableCursor(store, 24, empty.revision, null), /revision_conflict/);
  // An older cursor-only writer cannot erase a live batch.
  const preserved = await putDurableCursor(store, 12, written.revision);
  assert.deepEqual(preserved.auditBatch, batch);
  const completed = await putDurableCursor(store, 12, preserved.revision, null);
  assert.equal(completed.auditBatch, null);
  await assert.rejects(
    putDurableCursor(
      {
        ...store,
        fetchImpl: async () =>
          Response.json({
            ok: true,
            mode: "audit",
            next_cursor: 12,
            revision: 1,
            updated_at: null,
          }),
      },
      12,
      0,
      batch,
    ),
    /invalid audit wave state/,
  );
});
