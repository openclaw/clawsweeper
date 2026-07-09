import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createContext, Script } from "node:vm";

import worker, {
  automaticIssueWork,
  ExactReviewQueue,
  exactReviewQueueCapacity,
  StatusStore,
  workerWorkKind,
} from "../dashboard/worker.ts";
import {
  TRIAGE_ROUTING_GROUPS,
  triageRoutingGroupsForLabels,
} from "../dashboard/triage-routing-groups.ts";

test("exact-review queue defaults to 28 of the 128 global workers", () => {
  assert.equal(exactReviewQueueCapacity({}), 28);
  assert.equal(exactReviewQueueCapacity({ EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "32" }), 32);
  assert.equal(exactReviewQueueCapacity({ EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "100" }), 32);
});

test("triage routing groups classify impact labels without forcing one primary group", () => {
  assert.deepEqual(
    triageRoutingGroupsForLabels([
      "impact:message-loss",
      { name: "impact:security" },
      "clawsweeper:queueable-fix",
    ]).map((group) => group.id),
    ["message-delivery", "security"],
  );
  assert.deepEqual(
    triageRoutingGroupsForLabels(["impact:unknown"]).map((group) => group.id),
    ["unclassified"],
  );
  assert.deepEqual(
    triageRoutingGroupsForLabels(["impact:ux-release-blocker"]).map((group) => group.id),
    ["user-experience"],
  );
  assert.deepEqual(
    triageRoutingGroupsForLabels([{ name: "impact:ux-friction" }]).map((group) => group.id),
    ["user-experience"],
  );
  assert.equal(TRIAGE_ROUTING_GROUPS.at(-1)?.id, "unclassified");
});

test("issue triage exposes impact-group controls without changing PR proof triage", async () => {
  const issuePage = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/triage"), {});
  const proofPage = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/pr-proof-triage"),
    {},
  );
  const issueHtml = await issuePage.text();
  assert.match(issueHtml, /id="routing-group"/);
  assert.match(issueHtml, /Impact group/);
  assert.doesNotMatch(await proofPage.text(), /id="routing-group"/);
});

class MemoryKv {
  private values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

class MemoryDurableStorage {
  private values = new Map<string, unknown>();
  private alarmAt: number | null = null;

  async get(key: string) {
    return this.values.get(key);
  }

  async put(key: string, value: unknown) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }

  async list() {
    return new Map(this.values);
  }

  async getAlarm() {
    return this.alarmAt;
  }

  async setAlarm(at: number) {
    this.alarmAt = at;
  }

  async deleteAlarm() {
    this.alarmAt = null;
  }

  has(key: string) {
    return this.values.has(key);
  }
}

class MemoryDurableNamespace {
  private stub;

  constructor(stub) {
    this.stub = stub;
  }

  idFromName(name: string) {
    return name;
  }

  get() {
    return this.stub;
  }
}

class MemoryCache {
  private values = new Map<string, Response>();

  async match(request: Request) {
    return this.values.get(request.url)?.clone();
  }

  async put(request: Request, response: Response) {
    this.values.set(request.url, response.clone());
  }
}

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

test("exact-review queue coalesces deliveries, leases bounded work, and rejects duplicate claims", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  let workflowState = "disabled_manually";
  let signalWorkflowCheckStarted!: () => void;
  let releaseWorkflowCheck!: () => void;
  const workflowCheckStarted = new Promise<void>((resolve) => {
    signalWorkflowCheckStarted = resolve;
  });
  const workflowCheckRelease = new Promise<void>((resolve) => {
    releaseWorkflowCheck = resolve;
  });
  let wroteActiveLease = false;
  const storagePut = storage.put.bind(storage);
  storage.put = async (key, value) => {
    if (key === "exact-review-queue") {
      const snapshot = value as { items?: Record<string, { state?: string }> };
      wroteActiveLease ||= Object.values(snapshot.items || {}).some(
        (item) => item.state === "dispatching" || item.state === "leased",
      );
    }
    await storagePut(key, value);
  };
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      signalWorkflowCheckStarted();
      await workflowCheckRelease;
      return jsonResponse({ state: workflowState });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer dispatch-token");
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "1",
      },
    );
    const commandStatusMarker =
      "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
    const first = buildExactReviewQueueRequest("delivery-1", 597, "opened", "issue", undefined, {
      commandStatusMarker,
      statusCommentId: 9001,
      additionalPrompt: "Check the maintainer-requested regression path.",
      codexTimeoutMs: 1_200_000,
      mediaProofTimeoutMs: 480_000,
    });
    const duplicate = first.clone();
    const latest = buildExactReviewQueueRequest("delivery-2", 597, "edited");
    const second = buildExactReviewQueueRequest("delivery-3", 598, "opened");
    assert.equal((await queue.fetch(duplicate)).status, 202);
    assert.equal((await queue.fetch(latest)).status, 202);
    assert.equal((await queue.fetch(second)).status, 202);
    assert.equal((await queue.fetch(first)).status, 202);

    const alarm = queue.alarm();
    await workflowCheckStarted;
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-during-preflight", 600, "opened")))
        .status,
      202,
    );
    releaseWorkflowCheck();
    await alarm;
    let stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 3);
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.dispatcher.state, "paused");
    assert.equal(stats.dispatcher.reason, "workflow_not_active");
    assert.equal(stats.dispatcher.workflow_state, "disabled_manually");
    assert.equal(wroteActiveLease, false);
    assert.equal(dispatched.length, 0);

    const pausedState = (await storage.get("exact-review-queue")) as {
      dispatcher: { retryAt: number };
      items: Record<string, { nextAttemptAt: number }>;
    };
    workflowState = "active";
    pausedState.dispatcher.retryAt = Date.now() - 1;
    for (const item of Object.values(pausedState.items)) item.nextAttemptAt = Date.now() - 1;
    await storage.put("exact-review-queue", pausedState);
    await queue.alarm();
    assert.equal(dispatched.length, 1);
    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm > Date.now() + 60_000);
    const payload = dispatched[0].client_payload as Record<string, unknown>;
    assert.equal(payload.item_number, 597);
    assert.equal(payload.source_action, "edited");
    assert.ok(Object.keys(payload).length <= 10);
    assert.deepEqual(payload.review_options, {
      codex_timeout_ms: 1_200_000,
      media_proof_timeout_ms: 480_000,
      command_status_marker: commandStatusMarker,
      status_comment_id: 9001,
      additional_prompt: "Check the maintainer-requested regression path.",
    });
    const leaseId = String(payload.queue_lease_id || "");
    assert.match(leaseId, /^[0-9a-f-]{36}$/);

    const claimed = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({ lease_id: leaseId, run_id: "100" }),
      }),
    );
    assert.equal(claimed.status, 200);
    assert.deepEqual(await claimed.json(), {
      ok: true,
      claimed: true,
      item_key: "openclaw/gogcli#597",
      revision: 2,
    });
    assert.equal(
      (
        await queue.fetch(
          new Request("https://clawsweeper-exact-review-queue/claim", {
            method: "POST",
            body: JSON.stringify({ lease_id: leaseId, run_id: "101" }),
          }),
        )
      ).status,
      409,
    );

    const newer = buildExactReviewQueueRequest("delivery-4", 597, "synchronize", "pull_request");
    assert.equal((await queue.fetch(newer)).status, 202);
    const completed = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({ lease_id: leaseId, run_id: "100" }),
      }),
    );
    assert.deepEqual(await completed.json(), { ok: true, requeued: true });
    const requeued = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: Record<string, unknown> }>;
    };
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.commandStatusMarker, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.statusCommentId, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.additionalPrompt, undefined);
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 3);
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.leased, 0);
    assert.match(String(stats.oldest_pending_at), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue admits at most one active item per target repository", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      return jsonResponse({ state: "active" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "2",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "1",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-target-a-1", 601, "opened"));
    await queue.fetch(buildExactReviewQueueRequest("delivery-target-a-2", 602, "opened"));
    await queue.fetch(
      buildExactReviewQueueRequest(
        "delivery-target-b-1",
        603,
        "opened",
        "issue",
        "openclaw/openclaw",
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "delivery-target-c-1",
        604,
        "opened",
        "issue",
        "openclaw/clawsweeper",
      ),
    );

    await queue.alarm();
    assert.equal(dispatched.length, 2);
    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm > Date.now() + 60_000);
    const targets = dispatched.map(
      (payload) => (payload.client_payload as Record<string, unknown>).target_repo,
    );
    assert.equal(new Set(targets).size, 2);
    assert.equal(targets.filter((target) => target === "openclaw/gogcli").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue can use the global capacity for one target", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (url.pathname === "/repos/openclaw/clawsweeper/installation")
      return jsonResponse({ id: 999 });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "4",
      },
    );
    for (const itemNumber of [701, 702, 703, 704]) {
      await queue.fetch(
        buildExactReviewQueueRequest(`delivery-${itemNumber}`, itemNumber, "opened"),
      );
    }

    await queue.alarm();

    assert.equal(dispatched.length, 4);
    assert.equal(
      new Set(
        dispatched.map(
          (payload) => (payload.client_payload as Record<string, unknown>).target_repo,
        ),
      ).size,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue wakes while target capacity remains", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (url.pathname === "/repos/openclaw/clawsweeper/installation")
      return jsonResponse({ id: 999 });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "2",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-801", 801, "opened"));
    await queue.alarm();
    await queue.fetch(buildExactReviewQueueRequest("delivery-802", 802, "opened"));

    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm <= Date.now() + 5_000);

    await queue.alarm();
    assert.equal(dispatched.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated legacy exact-review intake enters the durable queue", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const payload = JSON.stringify({
    delivery_id: "legacy:100:1",
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 597,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "legacy_dispatch",
      supersedesInProgress: false,
      commandStatusMarker,
      statusCommentId: "9001",
      additionalPrompt: "Check the maintainer-requested regression path.",
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`;

  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/enqueue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/gogcli#597",
  });
  const stored = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: Record<string, unknown> }>;
  };
  assert.deepEqual(
    {
      commandStatusMarker: stored.items["openclaw/gogcli#597"].decision.commandStatusMarker,
      statusCommentId: stored.items["openclaw/gogcli#597"].decision.statusCommentId,
      additionalPrompt: stored.items["openclaw/gogcli#597"].decision.additionalPrompt,
    },
    {
      commandStatusMarker,
      statusCommentId: 9001,
      additionalPrompt: "Check the maintainer-requested regression path.",
    },
  );

  const denied = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(denied.status, 401);
});

test("exact-review queue rejects unbounded or unsafe command context", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const invalidDecisions = [
    {
      commandStatusMarker: "<!-- clawsweeper-command-status:597:re_review:na -->\nextra",
    },
    { statusCommentId: Number.MAX_SAFE_INTEGER + 1 },
    { additionalPrompt: "x".repeat(5001) },
    { additionalPrompt: "unsafe\0prompt" },
  ];

  for (const [index, decision] of invalidDecisions.entries()) {
    const response = await queue.fetch(
      buildExactReviewQueueRequest(
        `invalid-command-context-${index}`,
        597,
        "legacy_dispatch",
        "issue",
        undefined,
        decision,
      ),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_exact_review_item" });
  }
});

test("exact-review queue retries dispatch failures and reclaims an unclaimed lease", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchAttempts = 0;
  let workflowStatusAvailable = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      if (!workflowStatusAvailable) {
        return new Response(JSON.stringify({ message: "temporarily unavailable" }), {
          status: 503,
        });
      }
      return jsonResponse({ state: "active" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/installation")
      return jsonResponse({ id: 999 });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatchAttempts += 1;
      if (dispatchAttempts === 1) {
        return new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_LEASE_MS: "60000",
      },
    );
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-1", 599, "opened"))).status,
      202,
    );

    await queue.alarm();
    let state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 1, dispatching: 0, leased: 0 },
    );
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "workflow_status_unavailable");
    assert.equal(dispatchAttempts, 0);

    const stored = (await storage.get("exact-review-queue")) as {
      dispatcher: { retryAt: number };
      items: Record<string, { nextAttemptAt: number }>;
    };
    workflowStatusAvailable = true;
    stored.dispatcher.retryAt = Date.now() - 1;
    stored.items["openclaw/gogcli#599"].nextAttemptAt = Date.now() - 1;
    await storage.put("exact-review-queue", stored);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 1, dispatching: 0, leased: 0 },
    );
    assert.equal(state.dispatcher.state, "active");
    assert.equal(dispatchAttempts, 1);

    const retried = (await storage.get("exact-review-queue")) as {
      items: Record<string, { nextAttemptAt: number }>;
    };
    retried.items["openclaw/gogcli#599"].nextAttemptAt = Date.now() - 1;
    await storage.put("exact-review-queue", retried);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 0, dispatching: 1, leased: 0 },
    );

    const leased = (await storage.get("exact-review-queue")) as {
      items: Record<string, { leaseExpiresAt: number }>;
    };
    leased.items["openclaw/gogcli#599"].leaseExpiresAt = Date.now() - 1;
    await storage.put("exact-review-queue", leased);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 0, dispatching: 1, leased: 0 },
    );
    assert.equal(dispatchAttempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue preserves a claimed lease after an ambiguous dispatch failure", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let signalDispatchStarted!: () => void;
  let releaseDispatch!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => {
    signalDispatchStarted = resolve;
  });
  const dispatchRelease = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (url.pathname === "/repos/openclaw/clawsweeper/installation")
      return jsonResponse({ id: 999 });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "t" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      signalDispatchStarted();
      await dispatchRelease;
      return new Response(JSON.stringify({ message: "gateway timeout" }), { status: 504 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      },
    );
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("ambiguous-dispatch", 601, "opened"))).status,
      202,
    );

    const alarm = queue.alarm();
    await dispatchStarted;
    const dispatching = (await storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string }>;
    };
    const leaseId = dispatching.items["openclaw/gogcli#601"].leaseId;
    const claim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({ lease_id: leaseId, run_id: "ambiguous-run" }),
      }),
    );
    assert.equal(claim.status, 200);
    releaseDispatch();
    await alarm;

    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: stats.pending, dispatching: stats.dispatching, leased: stats.leased },
      { pending: 0, dispatching: 0, leased: 1 },
    );
    const completed = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({ lease_id: leaseId, run_id: "ambiguous-run" }),
      }),
    );
    assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review stats heals a missing alarm and expired lease", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#700": {
        key: "openclaw/openclaw#700",
        decision: {
          targetRepo: "openclaw/openclaw",
          targetBranch: "main",
          itemNumber: 700,
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceAction: "synchronize",
          supersedesInProgress: true,
        },
        state: "leased",
        revision: 1,
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now() - 120_000,
        nextAttemptAt: Date.now() - 120_000,
        attempts: 0,
        leaseId: "expired-lease",
        leaseRevision: 1,
        leaseExpiresAt: Date.now() - 1,
        claimedRunId: "run-700",
      },
    },
  });

  const response = await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.dispatching, 0);
  assert.equal(stats.leased, 0);
  assert.equal(stats.target_stats[0].target_repo, "openclaw/openclaw");
  assert.equal(stats.target_stats[0].pending, 1);
  assert.ok(stats.oldest_pending_age_seconds >= 120);
  assert.ok(stats.next_wake_at);
  assert.ok((await storage.getAlarm()) !== null);

  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, Record<string, unknown>>;
  };
  const activeLeaseExpiry = Date.now() + 60_000;
  state.items["openclaw/openclaw#701"] = {
    key: "openclaw/openclaw#701",
    decision: state.items["openclaw/openclaw#700"].decision,
    state: "leased",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: Date.now(),
    attempts: 0,
    leaseId: "active-lease",
    leaseRevision: 1,
    leaseExpiresAt: activeLeaseExpiry,
    claimedRunId: "run-701",
  };
  state.items["openclaw/openclaw#702"] = {
    key: "openclaw/openclaw#702",
    decision: {
      ...state.items["openclaw/openclaw#700"].decision,
      itemNumber: 702,
    },
    state: "pending",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: Date.now(),
    attempts: 0,
  };
  await storage.put("exact-review-queue", state);
  await storage.setAlarm(Date.now() + 1_000);
  const scheduledBeforePoll = await storage.getAlarm();
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const scheduledAfterPoll = await storage.getAlarm();
  assert.ok(scheduledBeforePoll !== null && scheduledAfterPoll !== null);
  assert.ok(scheduledAfterPoll <= scheduledBeforePoll);
});

function isoAgo(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

function completedReviewRun(id: number, itemNumber: number, conclusion: string, ageMs: number) {
  return {
    id,
    name: "Review ClawSweeper items",
    display_title: `Review event item openclaw/openclaw#${itemNumber}`,
    status: "completed",
    conclusion,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: isoAgo(ageMs),
    updated_at: isoAgo(Math.max(0, ageMs - 10_000)),
  };
}

test("dashboard classifies issue conversion and PR repair workers", () => {
  assert.equal(
    workerWorkKind(
      { title: "repair cluster jobs/openclaw/inbox/issue-openclaw-openclaw-123.md" },
      "Execute and apply cluster actions",
    ),
    "issue_to_pr",
  );
  assert.equal(
    workerWorkKind({ title: "automerge repair jobs/openclaw/inbox/automerge-456.md" }, ""),
    "pr_repair",
  );
  assert.equal(
    workerWorkKind({ title: "repair cluster jobs/openclaw/inbox/cluster-1.md" }, ""),
    "repair_cluster",
  );
});

test("dashboard HTML preserves UTF-8 emoji labels", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/"), {
    CLAWSWEEPER_CRABFLEET_URL: "https://fleet.example.test/terminal?view=live&mode=all",
  });
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.match(html, /<title>🦞 ClawSweeper Live<\/title>/);
  assert.match(html, /content: "🦞"/);
  assert.match(html, /Claw Workers/);
  assert.match(html, /Active Sweeps/);
  assert.match(html, /Queue Depth/);
  assert.match(html, /Error Rate/);
  assert.match(html, /Recovery Rate/);
  assert.match(html, /Capacity/);
  assert.match(html, /Live terminals/);
  assert.match(html, /href="https:\/\/fleet\.example\.test\/terminal\?view=live&amp;mode=all"/);
  assert.match(html, /Loading pipeline state/);
  assert.match(html, /System Overview/);
  assert.match(html, /id="apply-health"/);
  assert.match(html, /function renderApplyHealth/);
  assert.match(html, /candidate examined count unavailable for this lane/);
  assert.match(html, /Pruning sweep/);
  assert.match(html, /Copy command/);
  assert.match(html, /applyHealthRecommendedAction/);
  assert.match(html, /Rotation cursor missing/);
  assert.match(html, /Inspect the cursor-write and state-publish steps/);
  assert.match(html, /const skipCount = skipReasons\[reason\]/);
  assert.doesNotMatch(html, /Apply needs attention/);
  assert.match(html, /Automatic Builds/);
  assert.match(html, /id="automatic-work"/);
  assert.match(html, /Lifecycle Timeline/);
  assert.match(html, /Active Workers/);
  assert.match(html, /id="worker-dialog"/);
  assert.match(html, /Step Timeline/);
  assert.match(html, /worker-target-title/);
  assert.match(html, /Refreshing live status in the background/);
  assert.match(html, /Cluster Intake/);
  assert.match(html, /Active Pipeline/);
  assert.match(html, /Closed by ClawSweeper/);
  assert.match(html, /Worker Health/);
  assert.match(html, /Recent Activity/);
  assert.doesNotMatch(html, /ðŸ|â|âš|âœ/);
});

test("dashboard hero treats apply health attention as needs attention", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/"));
  const html = await response.text();
  const script = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].at(-1)?.[1];
  assert.ok(script);

  const elements = new Map();
  const elementFor = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        addEventListener: () => undefined,
        className: "",
        close() {
          this.open = false;
        },
        dataset: {},
        id,
        innerHTML: "",
        open: false,
        showModal() {
          this.open = true;
        },
        style: {},
        textContent: "",
      });
    }
    return elements.get(id);
  };
  const status = {
    generated_at: "2026-07-05T11:22:43.934Z",
    source: { target_repositories: ["openclaw/openclaw"] },
    health: {
      attempts: 0,
      error_rate_percent: 0,
      failed_attempts: 0,
      failures: [],
      recovered_failures: 0,
      recovery_rate_percent: 100,
      unresolved_failures: 0,
    },
    fleet: {
      active_codex_jobs: 0,
      active_workflow_runs: 0,
      budget_used_percent: 0,
      queued_workflow_runs: 0,
      support_queued_workflow_runs: 0,
      support_workflow_runs: 0,
      worker_budget: 128,
      worker_detail_fallbacks: 0,
    },
    workers: [],
    automatic_work: [],
    pipeline: [],
    diagnostics: { errors: [] },
    recent: {
      apply_health: {
        attention_count: 1,
        items: [
          {
            attention_reasons: ["cursor_required_but_missing_after_full_window"],
            closed: 0,
            comment_synced: 0,
            cursor: null,
            cursor_required: true,
            cycle: null,
            lanes: {
              closure: {
                closed: 0,
                comment_synced: 0,
                processed: 2,
                skip_reasons: { skipped_changed_since_review: 2 },
                skipped: 2,
              },
              comment_sync: {
                closed: 0,
                comment_synced: 0,
                processed: 0,
                skip_reasons: {},
                skipped: 0,
              },
            },
            mode: "close",
            next_action_buckets: { review_refresh: 2 },
            next_actions: [
              {
                bucket: "review_refresh",
                count: 2,
                label: "Refresh review",
                next_step: "Queue a fresh ClawSweeper review before any close retry.",
                owner: "clawsweeper",
                reason: "skipped_changed_since_review",
                retryable: true,
                summary: "The item changed after review.",
              },
            ],
            processed: 2,
            run_url: "https://github.com/openclaw/clawsweeper/actions/runs/99",
            skip_reasons: { skipped_changed_since_review: 2 },
            skipped: 2,
            status: "needs_attention",
            target_repo: "openclaw/openclaw",
            updated_at: "2026-07-05T11:22:03.748Z",
          },
        ],
      },
      automerge: [],
      closed_items: [],
      closed_stats: { issues: 0, prs: 0, total: 0, window_hours: 24 },
      cluster_repair: null,
      events: [],
      operation_counts: {},
    },
  };

  const context = createContext({
    console,
    document: {
      addEventListener: () => undefined,
      body: { classList: { add: () => undefined, remove: () => undefined } },
      documentElement: { dataset: {} },
      getElementById: elementFor,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    fetch: async () => ({
      headers: { get: () => "fresh" },
      json: async () => status,
      ok: true,
      status: 200,
    }),
    history: { replaceState: () => undefined },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    location: { hash: "", pathname: "/", search: "" },
    navigator: { clipboard: { writeText: async () => undefined } },
    setInterval: () => 1,
    setTimeout: () => 1,
    window: { addEventListener: () => undefined },
  });
  new Script(script).runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(elementFor("hero-dot").className, "hero-dot amber");
  assert.match(elementFor("hero-headline").textContent, /^Needs attention/);
  assert.match(elementFor("apply-health").innerHTML, /Pruning sweep blocked/);
});

test("dashboard HTML emits early persistent theme controls", async () => {
  for (const path of ["/", "/triage", "/pr-proof-triage"]) {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai" + path));
    const html = await response.text();
    const themeInit = html.indexOf('const themeKey = "clawsweeper-theme";');
    const styles = html.indexOf("<style>");

    assert.notEqual(themeInit, -1, path + " should initialize theme preference");
    assert.notEqual(styles, -1, path + " should include CSS");
    assert.ok(themeInit < styles, path + " should apply saved theme before styles");
    assert.match(html, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
    assert.match(html, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
    assert.match(html, /data-theme-choice="system"/);
    assert.match(html, /data-theme-choice="light"/);
    assert.match(html, /data-theme-choice="dark"/);
    assert.match(html, /window\.localStorage\?\.setItem\(themeKey, choice\)/);
    assert.match(html, /typeof themeQuery\?\.addEventListener === "function"/);
    assert.match(html, /themeQuery\.addEventListener\("change", updateSystemTheme\)/);
    assert.match(html, /themeQuery\?\.addListener\?\.\(updateSystemTheme\)/);
    assert.match(html, /setAttribute\("aria-pressed", selected \? "true" : "false"\)/);
  }
});

test("dashboard groups automatic issue lifecycle events with active workers", () => {
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_queued",
        repository: "steipete/example",
        source_item_number: 42,
        source_item_url: "https://github.com/steipete/example/issues/42",
        title: "Add compact export mode",
        stage: "queued",
        status: "queued",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/100",
        work_kind: "issue_to_pr",
        automatic: true,
        received_at: "2026-06-14T10:00:00Z",
      },
      {
        event_type: "clawsweeper.generated_pr_opened",
        repository: "steipete/example",
        source_item_number: 42,
        source_item_url: "https://github.com/steipete/example/issues/42",
        item_url: "https://github.com/steipete/example/pull/51",
        pr_url: "https://github.com/steipete/example/pull/51",
        title: "Add compact export mode",
        stage: "pr_opened",
        status: "completed",
        work_kind: "issue_to_pr",
        automatic: null,
        received_at: "2026-06-14T10:10:00Z",
      },
    ],
    [
      {
        id: 7001,
        repository: "steipete/example",
        item_number: 42,
        work_kind: "issue_to_pr",
        name: "Implement issue",
        status: "in_progress",
        current_step: "Run Codex",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/100",
        updated_at: "2026-06-14T10:05:00Z",
        target_items: [
          {
            number: 42,
            title: "Add compact export mode",
            url: "https://github.com/steipete/example/issues/42",
          },
        ],
      },
    ],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "steipete/example#42");
  assert.equal(rows[0].title, "Add compact export mode");
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].worker_id, "7001");
  assert.equal(rows[0].pr_url, "https://github.com/steipete/example/pull/51");
  assert.equal(rows[0].timeline.length, 3);
});

test("dashboard correlates issue implementation workers by run URL", () => {
  const workers = [
    {
      id: 7002,
      repository: null,
      item_number: null,
      item_numbers: [],
      work_kind: "issue_to_pr",
      name: "Execute and apply cluster actions",
      status: "in_progress",
      current_step: "Execute credited fix artifact",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/101",
      updated_at: "2026-06-14T10:05:00Z",
      target_items: [],
    },
  ];
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_started",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        title: "Install sudo when missing",
        stage: "building",
        status: "running",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/101",
        work_kind: "issue_to_pr",
        automatic: true,
        received_at: "2026-06-14T10:04:00Z",
      },
    ],
    workers,
  );

  assert.equal(rows[0].active, true);
  assert.equal(rows[0].worker_id, "7002");
  assert.equal(workers[0].repository, "openclaw/openclaw-ansible");
  assert.equal(workers[0].item_number, 20);
  assert.equal(workers[0].target_items[0].title, "Install sudo when missing");
});

test("dashboard preserves issue titles across generated PR repair events", () => {
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_started",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        title: "installation fails due to not sudo installed",
        stage: "building",
        status: "running",
        automatic: true,
        received_at: "2026-06-14T10:00:00Z",
      },
      {
        event_type: "clawsweeper.contributor_branch_repaired",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        item_url: "https://github.com/openclaw/openclaw-ansible/pull/49",
        pr_url: "https://github.com/openclaw/openclaw-ansible/pull/49",
        title: "openclaw/openclaw-ansible#49",
        stage: "repair_contributor_branch",
        status: "pushed",
        received_at: "2026-06-14T10:10:00Z",
      },
    ],
    [],
  );

  assert.equal(rows[0].title, "installation fails due to not sudo installed");
  assert.equal(rows[0].pr_url, "https://github.com/openclaw/openclaw-ansible/pull/49");
});

test("dashboard exposes active worker jobs and their current steps", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const run = {
    id: 42,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#92521",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
    created_at: isoAgo(120_000),
    updated_at: isoAgo(10_000),
  };
  const queuedRun = {
    id: 43,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#92523",
    status: "queued",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/43",
    created_at: isoAgo(30_000),
    updated_at: isoAgo(5_000),
  };
  let graphqlRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status
          ? [run, queuedRun]
          : status === "in_progress"
            ? [run]
            : status === "queued"
              ? [queuedRun]
              : [],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/42/jobs") {
      return jsonResponse({
        jobs: [
          {
            id: 4201,
            name: "Review shard 0 · openclaw/openclaw#92521,92522",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4201",
            started_at: isoAgo(90_000),
            steps: [
              {
                number: 1,
                name: "Set up job",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 3,
                name: "Review shard",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
          {
            id: 4202,
            name: "Publish review artifacts",
            status: "queued",
            conclusion: null,
            steps: [],
          },
        ],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/43/jobs") {
      return jsonResponse({ jobs: [] });
    }
    if (url.pathname === "/graphql") {
      graphqlRequests += 1;
      return jsonResponse({
        data: {
          repository: {
            target0: {
              __typename: "Issue",
              title: "Preserve terminal resize state",
              url: "https://github.com/openclaw/openclaw/issues/92521",
            },
            target1: {
              __typename: "PullRequest",
              title: "Repair terminal resize state",
              url: "https://github.com/openclaw/openclaw/pull/92522",
            },
            target2: {
              __typename: "Issue",
              title: "Queued terminal resize follow-up",
              url: "https://github.com/openclaw/openclaw/issues/92523",
            },
          },
        },
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 2);
    assert.equal(status.fleet.worker_detail_runs, 2);
    assert.equal(status.fleet.worker_detail_fallbacks, 1);
    assert.equal(status.workers.length, 2);
    assert.equal(status.workers[0].id, 4201);
    assert.equal(status.workers[0].name, "Review shard 0 · openclaw/openclaw#92521,92522");
    assert.equal(status.workers[0].repository, "openclaw/openclaw");
    assert.equal(status.workers[0].item_number, null);
    assert.deepEqual(status.workers[0].item_numbers, [92521, 92522]);
    assert.equal(status.workers[0].current_step, "Review shard");
    assert.deepEqual(status.workers[0].progress, { completed: 2, total: 3 });
    assert.equal(status.workers[0].steps[2].status, "in_progress");
    assert.deepEqual(status.workers[0].target_items, [
      {
        repository: "openclaw/openclaw",
        number: 92521,
        title: "Preserve terminal resize state",
        url: "https://github.com/openclaw/openclaw/issues/92521",
        type: "issue",
      },
      {
        repository: "openclaw/openclaw",
        number: 92522,
        title: "Repair terminal resize state",
        url: "https://github.com/openclaw/openclaw/pull/92522",
        type: "pull_request",
      },
    ]);
    assert.equal(status.workers[1].id, "run-43");
    assert.equal(status.workers[1].source, "workflow-fallback");
    assert.equal(status.workers[1].current_step, "reviewing");
    assert.equal(status.workers[1].target_items[0].title, "Queued terminal resize follow-up");

    const cachedResponse = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const cachedStatus = await cachedResponse.json();
    assert.equal(cachedStatus.workers[0].target_items[0].title, "Preserve terminal resize state");
    assert.equal(graphqlRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard bounds worker job detail request concurrency", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = Array.from({ length: 12 }, (_, index) => ({
    id: 1000 + index,
    name: "Review ClawSweeper items",
    display_title: `Review event item openclaw/openclaw#${9000 + index}`,
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${1000 + index}`,
    created_at: isoAgo((index + 1) * 1000),
    updated_at: isoAgo(1000),
  }));
  let activeJobRequests = 0;
  let maxActiveJobRequests = 0;
  let pipelineRequestsWhileJobsActive = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      const runId = Number(url.pathname.split("/").at(-2));
      activeJobRequests += 1;
      maxActiveJobRequests = Math.max(maxActiveJobRequests, activeJobRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeJobRequests -= 1;
      return jsonResponse({
        jobs: [
          {
            id: runId * 10,
            name: `Review shard ${runId}`,
            status: "in_progress",
            conclusion: null,
            html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}/job/${
              runId * 10
            }`,
            started_at: isoAgo(1000),
            steps: [
              {
                number: 1,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Review shard",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        ],
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/pulls\/\d+$/.test(url.pathname)) {
      if (activeJobRequests) pipelineRequestsWhileJobsActive += 1;
      return jsonResponse({ head: { sha: `head-${url.pathname.split("/").at(-1)}` } });
    }
    if (/^\/repos\/openclaw\/openclaw\/commits\/head-\d+\/check-runs$/.test(url.pathname)) {
      if (activeJobRequests) pipelineRequestsWhileJobsActive += 1;
      return jsonResponse({ check_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        WORKER_DETAIL_RUN_LIMIT: "12",
        WORKER_JOB_FETCH_CONCURRENCY: "3",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.workers.length, 12);
    assert.equal(status.fleet.active_codex_jobs, 12);
    assert.equal(maxActiveJobRequests, 3);
    assert.equal(pipelineRequestsWhileJobsActive, 0);
    assert.deepEqual(status.diagnostics.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard paginates worker jobs beyond GitHub's first page", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const run = {
    id: 500,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#500",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/500",
    created_at: isoAgo(60_000),
    updated_at: isoAgo(5_000),
  };
  const requestedPages = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status || status === "in_progress" ? [run] : [],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/500/jobs") {
      const page = Number(url.searchParams.get("page") || "1");
      requestedPages.push(page);
      const count = page === 1 ? 100 : 28;
      const offset = page === 1 ? 0 : 100;
      return jsonResponse({
        total_count: 128,
        jobs: Array.from({ length: count }, (_, index) => ({
          id: 500_000 + offset + index,
          name: `Review shard ${offset + index}`,
          status: "in_progress",
          conclusion: null,
          html_url: `https://github.com/openclaw/clawsweeper/actions/runs/500/job/${
            500_000 + offset + index
          }`,
          started_at: isoAgo(30_000),
          steps: [
            {
              number: 1,
              name: "Run ./clawsweeper/.github/actions/setup-codex",
              status: "completed",
              conclusion: "success",
            },
            {
              number: 2,
              name: "Review shard",
              status: "in_progress",
              conclusion: null,
            },
          ],
        })),
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 128);
    assert.equal(status.workers.length, 128);
    assert.deepEqual(requestedPages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reports worker error and recovery rates from completed job steps", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = [
    completedReviewRun(4, 300, "success", 60_000),
    completedReviewRun(3, 200, "success", 120_000),
    completedReviewRun(2, 100, "success", 180_000),
    completedReviewRun(1, 100, "success", 240_000),
  ];
  let jobRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({
        workflow_runs:
          url.searchParams.get("status") === "completed"
            ? runs
            : url.searchParams.has("status")
              ? []
              : runs,
      });
    }
    const jobMatch = url.pathname.match(
      /^\/repos\/openclaw\/clawsweeper\/actions\/runs\/(\d+)\/jobs$/,
    );
    if (jobMatch) {
      jobRequests += 1;
      const runId = Number(jobMatch[1]);
      const itemNumber = runId === 1 || runId === 2 ? 100 : runId === 3 ? 200 : 300;
      const failed = runId === 1 || runId === 3;
      return jsonResponse({
        jobs: [
          {
            id: runId * 10,
            name: `Review shard 0 · openclaw/openclaw#${itemNumber}`,
            status: "completed",
            conclusion: "success",
            html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}/job/${
              runId * 10
            }`,
            started_at: runs.find((run) => run.id === runId)?.created_at,
            steps: [
              {
                number: 1,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Review shard",
                status: "completed",
                conclusion: failed ? "failure" : "success",
              },
            ],
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
      STATUS_STORE: new MemoryKv(),
    };
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.health.attempts, 4);
    assert.equal(status.health.successful_attempts, 2);
    assert.equal(status.health.failed_attempts, 2);
    assert.equal(status.health.recovered_failures, 1);
    assert.equal(status.health.unresolved_failures, 1);
    assert.equal(status.health.error_rate_percent, 50);
    assert.equal(status.health.recovery_rate_percent, 50);
    assert.equal(status.health.failures[0].item_numbers[0], 200);
    assert.equal(status.health.failures[0].recovered, false);
    assert.equal(status.health.failures[0].failed_step, "Review shard");
    assert.equal(status.health.failures[1].item_numbers[0], 100);
    assert.equal(status.health.failures[1].recovered, true);
    assert.equal(jobRequests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes scheduled cluster intake markers and runs", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const marker = {
    target_repo: "openclaw/openclaw",
    last_processed_store_sha256: "abc123def4567890",
    last_processed_store_exported_at: "2026-05-25T12:00:00Z",
    generated_count: 1,
    generated_jobs: ["jobs/openclaw/inbox/gitcrawl-42-login-fix.md"],
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
    updated_at: "2026-05-25T12:08:00Z",
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 42,
            name: "repair cluster intake",
            display_title: "repair cluster intake",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
            created_at: "2026-05-25T12:08:00Z",
            updated_at: "2026-05-25T12:09:00Z",
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper-state/contents/results/cluster-repair-intake/openclaw-openclaw.json"
    ) {
      assert.equal(url.searchParams.get("ref"), "state");
      return jsonResponse({
        content: Buffer.from(JSON.stringify(marker)).toString("base64"),
      });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.recent.cluster_repair.workflow, "repair-cluster-intake.yml");
    assert.equal("schedule" in status.recent.cluster_repair, false);
    assert.equal(status.recent.cluster_repair.markers[0].status, "imported");
    assert.equal(status.recent.cluster_repair.markers[0].generated_count, 1);
    assert.equal(
      status.recent.cluster_repair.markers[0].last_processed_store_short_sha,
      "abc123def4",
    );
    assert.equal(status.recent.cluster_repair.latest_runs[0].url, marker.run_url);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes apply health from sweep status without broad scans", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const sweepStatus = {
    target_repo: "openclaw/openclaw",
    state: "Apply finished",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/99",
    updated_at: "2026-07-03T10:15:00Z",
    apply_health: {
      mode: "close",
      status: "needs_attention",
      summary:
        "4 examined; 2/2 action records; 0 closed, 0 comments synced, 2 skipped; no cursor recorded.",
      examined: 4,
      action_records: 2,
      processed: 2,
      processed_limit: 2,
      close_limit: 5,
      closed: 0,
      comment_synced: 0,
      skipped: 2,
      cursor_required: true,
      skip_reasons: {
        skipped_changed_since_review: 2,
      },
      lanes: {
        closure: {
          processed: 2,
          closed: 0,
          comment_synced: 0,
          skipped: 2,
          skip_reasons: {
            skipped_changed_since_review: 2,
          },
        },
        comment_sync: {
          processed: 0,
          closed: 0,
          comment_synced: 0,
          skipped: 0,
          skip_reasons: {},
        },
      },
      next_actions: [
        {
          reason: "skipped_changed_since_review",
          count: 2,
          bucket: "review_refresh",
          owner: "clawsweeper",
          retryable: true,
          label: "Refresh review",
          summary: "The item changed after the review that proposed closing it.",
          next_step: "Queue a fresh ClawSweeper review before any close retry.",
        },
      ],
      next_action_buckets: {
        review_refresh: 2,
      },
      cycle: {
        basis: "scheduled_close_cursor",
        apply_ready_count: 1200,
        window_size: 300,
        estimated_full_cycle_windows: 4,
        estimated_full_cycle_minutes: null,
        scheduled_interval_minutes: null,
        label:
          "1200 close candidates (confirmed proposals plus live promotion probes) at 300 records per latest cursor advance: about 4 windows.",
      },
      attention_reasons: ["cursor_required_but_missing_after_full_window"],
      cursor: null,
    },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper-state/contents/results/sweep-status/openclaw-openclaw.json"
    ) {
      assert.equal(url.searchParams.get("ref"), "state");
      return jsonResponse({
        content: Buffer.from(JSON.stringify(sweepStatus)).toString("base64"),
      });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.recent.apply_health.attention_count, 1);
    assert.equal(status.recent.apply_health.items[0].status, "needs_attention");
    assert.equal(status.recent.apply_health.items[0].examined, 4);
    assert.equal(status.recent.apply_health.items[0].action_records, 2);
    assert.equal(status.recent.apply_health.items[0].processed, 2);
    assert.equal(status.recent.apply_health.items[0].cursor_required, true);
    assert.deepEqual(status.recent.apply_health.items[0].skip_reasons, {
      skipped_changed_since_review: 2,
    });
    assert.deepEqual(status.recent.apply_health.items[0].lanes.closure, {
      processed: 2,
      closed: 0,
      comment_synced: 0,
      skipped: 2,
      skip_reasons: {
        skipped_changed_since_review: 2,
      },
    });
    assert.equal(status.recent.apply_health.items[0].lanes.comment_sync.processed, 0);
    assert.deepEqual(status.recent.apply_health.items[0].next_action_buckets, {
      review_refresh: 2,
    });
    assert.equal(
      status.recent.apply_health.items[0].next_actions[0].next_step,
      "Queue a fresh ClawSweeper review before any close retry.",
    );
    assert.equal(status.recent.apply_health.items[0].cycle.estimated_full_cycle_minutes, null);
    assert.equal(status.recent.apply_health.items[0].cycle.apply_ready_count, 1200);
    assert.equal(status.recent.apply_health.items[0].cursor, null);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reads stored CI status for active PR rows", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            name: "ClawSweeper",
            display_title: "Review event item openclaw/openclaw#80609",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.includes("/search/issues")) return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "ci.status",
          repository: "openclaw/openclaw",
          item_number: 80609,
          status: "green",
          ci: {
            repository: "openclaw/openclaw",
            item_number: 80609,
            state: "green",
            source: "github-checks",
            total: 12,
            failing: 0,
            pending: 0,
          },
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].repository, "openclaw/openclaw");
    assert.equal(status.pipeline[0].item_number, 80609);
    assert.equal(status.pipeline[0].ci.state, "green");
    assert.equal(status.pipeline[0].ci.source, "github-checks");
    assert.equal(status.pipeline[0].ci.total, 12);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard falls back to edge cache storage when KV is not bound", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "ci.status",
          repository: "openclaw/openclaw",
          item_number: 80609,
          ci: {
            repository: "openclaw/openclaw",
            item_number: 80609,
            state: "pending",
            source: "github-checks",
            total: 12,
            failing: 0,
            pending: 2,
          },
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].ci.state, "pending");
    assert.equal(status.pipeline[0].ci.source, "github-checks");
    assert.equal(status.pipeline[0].ci.pending, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard serves stale status while coalescing one background refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: cache },
  });
  await cache.put(
    new Request("https://clawsweeper.openclaw.ai/api/status-cache/stale"),
    jsonResponse({
      schema_version: 1,
      generated_at: "2026-06-13T18:00:00Z",
      source: {
        clawsweeper_repo: "openclaw/clawsweeper",
        target_repositories: ["openclaw/openclaw"],
      },
      fleet: { active_workflow_runs: 1 },
      workers: [],
      pipeline: [{ id: "stale-row" }],
      diagnostics: { errors: [] },
    }),
  );

  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let unfilteredRunRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    await fetchGate;
    if (url.pathname.includes("/actions/")) {
      if (url.pathname.endsWith("/actions/runs") && !url.searchParams.has("status")) {
        unfilteredRunRequests += 1;
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const waitUntilPromises: Promise<unknown>[] = [];
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "20",
    };
    const context = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
    };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const [first, second] = await Promise.all([
      worker.fetch(request, env, context),
      worker.fetch(request, env, context),
    ]);

    assert.equal(first.headers.get("x-clawsweeper-cache"), "stale");
    assert.equal(second.headers.get("x-clawsweeper-cache"), "stale");
    assert.equal((await first.json()).pipeline[0].id, "stale-row");
    assert.equal(waitUntilPromises.length, 2);

    releaseFetch();
    await Promise.all(waitUntilPromises);
    assert.equal(unfilteredRunRequests, 1);

    const refreshed = await worker.fetch(request, env);
    assert.equal(refreshed.headers.get("x-clawsweeper-cache"), "fresh");
    assert.deepEqual((await refreshed.json()).pipeline, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard status survives cache persistence failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async (request: Request) => {
          if (
            request.url.includes("/api/status-cache/") ||
            request.url.includes("recent-automerge") ||
            request.url.includes("recent-closed")
          ) {
            throw new Error("cache unavailable");
          }
        },
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-clawsweeper-cache"), "miss");
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 1);
    assert.deepEqual(status.diagnostics.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard parallelizes and caches historical GitHub telemetry", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let closedRequests = 0;
  let activeDetails = 0;
  let maxActiveDetails = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        items: [101, 102, 103, 104].map((number) => ({
          number,
          title: `Merged PR ${number}`,
          html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
        })),
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/(?:pulls\/\d+|issues\/\d+\/comments)$/.test(url.pathname)) {
      activeDetails += 1;
      maxActiveDetails = Math.max(maxActiveDetails, activeDetails);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDetails -= 1;
      if (url.pathname.includes("/comments")) {
        return jsonResponse([
          {
            body: "@clawsweeper automerge",
            created_at: "2026-06-13T18:00:00Z",
          },
        ]);
      }
      return jsonResponse({
        merged_at: "2026-06-13T18:01:00Z",
        merge_commit_sha: "abc123",
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      closedRequests += 1;
      return jsonResponse([]);
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const env = {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "-1",
    };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const first = await worker.fetch(request, env);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).averages.automerge_samples, 4);
    assert.ok(maxActiveDetails >= 4);
    assert.equal(searchRequests, 1);
    assert.equal(closedRequests, 1);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await worker.fetch(request, env);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).averages.automerge_samples, 4);
    assert.equal(searchRequests, 1);
    assert.equal(closedRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard batches recent automerge hydration with GraphQL when authenticated", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let graphqlRequests = 0;
  let restDetailRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        items: [101, 102].map((number) => ({
          number,
          title: `Merged PR ${number}`,
          html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
        })),
      });
    }
    if (url.pathname === "/graphql") {
      graphqlRequests += 1;
      return jsonResponse({
        data: {
          repository: {
            pr0: {
              mergedAt: "2026-06-13T18:01:00Z",
              mergeCommit: { oid: "abc101" },
              comments: {
                nodes: [
                  {
                    body: "@clawsweeper automerge",
                    createdAt: "2026-06-13T18:00:30Z",
                  },
                  {
                    body: "/clawsweeper automerge",
                    createdAt: "2026-06-13T18:00:00Z",
                  },
                ],
              },
            },
            pr1: {
              mergedAt: "2026-06-13T18:04:00Z",
              mergeCommit: { oid: "abc102" },
              comments: {
                nodes: [
                  {
                    body: "/clawsweeper automerge",
                    createdAt: "2026-06-13T18:02:00Z",
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/(?:pulls\/\d+|issues\/\d+\/comments)$/.test(url.pathname)) {
      restDetailRequests += 1;
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "-1",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.averages.automerge_samples, 2);
    assert.equal(status.averages.automerge_command_to_merge_ms, 90_000);
    assert.equal(searchRequests, 1);
    assert.equal(graphqlRequests, 1);
    assert.equal(restDetailRequests, 0);
    assert.deepEqual(
      status.recent.automerge.map((item: { number: number; merge_commit_sha: string }) => [
        item.number,
        item.merge_commit_sha,
      ]),
      [
        [101, "abc101"],
        [102, "abc102"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard preserves repeated untargeted activity events", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    for (const title of ["Probe one", "Probe two"]) {
      const ingest = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            event_type: "status.test",
            mode: "test",
            stage: "probe",
            status: "ok",
            title,
          }),
        }),
        env,
      );
      assert.equal(ingest.status, 200);
    }

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      status.recent.events
        .filter((event: { event_type: string }) => event.event_type === "status.test")
        .map((event: { title: string }) => event.title)
        .sort(),
      ["Probe one", "Probe two"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard counts cluster-fixer operation events", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const events = [
      { event_type: "clawsweeper.replacement_label_cleanup", stage: "executed" },
      { event_type: "clawsweeper.clawsweeper_self_rebase", stage: "dispatched" },
      { event_type: "clawsweeper.dispatched_failed_review_retry", stage: "dispatched" },
      { event_type: "clawsweeper.marked_failed_review_retry_exhausted", stage: "exhausted" },
      { event_type: "clawsweeper.bot_proof_decision_posted", stage: "posted" },
      { event_type: "clawsweeper.bot_proof_mantis_request_posted", stage: "posted" },
    ];
    for (const event of events) {
      const ingest = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mode: "operation",
            status: "ok",
            ...event,
          }),
        }),
        env,
      );
      assert.equal(ingest.status, 200);
    }

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(status.recent.operation_counts, {
      inherited_label_cleanups: 1,
      self_heal_conflict_repairs: 1,
      failed_review_retries: 1,
      failed_review_retry_exhaustions: 1,
      bot_owned_proof_decisions_requested: 1,
      bot_owned_proof_dispatches: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard keeps workflow CI status when live PR checks fail", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            name: "ClawSweeper",
            display_title: "Review event item openclaw/openclaw#80609",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.includes("/repos/openclaw/openclaw/pulls/80609")) {
      return new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
    }
    if (url.includes("/search/issues")) return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].ci.state, "pending");
    assert.equal(status.pipeline[0].ci.source, "workflow");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reuses live PR CI hydration within one status snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = [
    {
      id: 8060901,
      name: "ClawSweeper",
      display_title: "Review event item openclaw/openclaw#80609",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/8060901",
      created_at: isoAgo(120_000),
      updated_at: isoAgo(10_000),
    },
    {
      id: 8060902,
      name: "ClawSweeper",
      display_title: "Review event item openclaw/openclaw#80609",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/8060902",
      created_at: isoAgo(90_000),
      updated_at: isoAgo(5_000),
    },
  ];
  let pullRequests = 0;
  let checkRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      return jsonResponse({ jobs: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/pulls/80609") {
      pullRequests += 1;
      return jsonResponse({ head: { sha: "head-80609" } });
    }
    if (url.pathname === "/repos/openclaw/openclaw/commits/head-80609/check-runs") {
      checkRequests += 1;
      return jsonResponse({
        check_runs: [
          {
            name: "test",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(pullRequests, 1);
    assert.equal(checkRequests, 1);
    assert.deepEqual(
      status.pipeline.map((row: { ci: { source: string; state: string } }) => row.ci),
      [
        {
          state: "green",
          head_sha: "head-80609",
          total: 1,
          failing: 0,
          pending: 0,
          source: "live",
        },
        {
          state: "green",
          head_sha: "head-80609",
          total: 1,
          failing: 0,
          pending: 0,
          source: "live",
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard counts active runs that are older than the latest unfiltered page", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (!status) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "recent completed run",
              display_title: "recent completed run",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
              created_at: "2026-05-14T06:40:00Z",
              updated_at: "2026-05-14T06:41:00Z",
            },
          ],
        });
      }
      if (status === "in_progress") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 2,
              name: "Review event item openclaw/openclaw#81001",
              display_title: "Review event item openclaw/openclaw#81001",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/2",
              created_at: isoAgo(25 * 60_000),
              updated_at: isoAgo(20 * 60_000),
            },
            {
              id: 3,
              name: "Commit review openclaw/openclaw@abc123",
              display_title: "Commit review openclaw/openclaw@abc123",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/3",
              created_at: isoAgo(20 * 60_000),
              updated_at: isoAgo(15 * 60_000),
            },
            {
              id: 5,
              name: "spam comment intake",
              display_title: "github_activity",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/5",
              created_at: isoAgo(18 * 60_000),
              updated_at: isoAgo(16 * 60_000),
            },
            {
              id: 6,
              name: "ClawSweeper Live Dashboard CI Status",
              display_title: "ClawSweeper Live Dashboard CI Status",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/6",
              created_at: isoAgo(17 * 60_000),
              updated_at: isoAgo(15 * 60_000),
            },
          ],
        });
      }
      if (status === "queued") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 4,
              name: "Review event item openclaw/openclaw#81002",
              display_title: "Review event item openclaw/openclaw#81002",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/4",
              created_at: isoAgo(30 * 60_000),
              updated_at: isoAgo(29 * 60_000),
            },
            {
              id: 7,
              name: "github activity to openclaw",
              display_title: "github_activity",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/7",
              created_at: isoAgo(31 * 60_000),
              updated_at: isoAgo(30 * 60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 3);
    assert.equal(status.fleet.queued_workflow_runs, 1);
    assert.equal(status.fleet.support_workflow_runs, 3);
    assert.equal(status.fleet.support_queued_workflow_runs, 1);
    assert.equal(status.fleet.worker_budget, 128);
    assert.deepEqual(
      status.pipeline.map((row: { id: number }) => row.id),
      [2, 4, 3],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard ignores stale queued workflow ghosts", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (!status) return jsonResponse({ workflow_runs: [] });
      if (status === "queued") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "ClawSweeper Commit Review",
              display_title: "clawsweeper_commit_review",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
              created_at: isoAgo(7 * 24 * 60 * 60_000),
              updated_at: isoAgo(7 * 24 * 60 * 60_000),
            },
            {
              id: 2,
              name: "Review event item openclaw/openclaw#81002",
              display_title: "Review event item openclaw/openclaw#81002",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/2",
              created_at: isoAgo(10 * 60_000),
              updated_at: isoAgo(9 * 60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 1);
    assert.equal(status.fleet.queued_workflow_runs, 1);
    assert.deepEqual(
      status.pipeline.map((row: { id: number }) => row.id),
      [2],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes ClawSweeper-owned recent closes and 24h stats", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const issuePages: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    const olderClosedAt = new Date(Date.now() - 120_000).toISOString();
    const oldestClosedAt = new Date(Date.now() - 180_000).toISOString();
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname === "/repos/openclaw/openclaw/issues" &&
      url.searchParams.get("page") === "1"
    ) {
      issuePages.push(url.searchParams.get("page") || "");
      return jsonResponse([
        {
          number: 81,
          title: "Fix stale terminal resize state",
          html_url: "https://github.com/openclaw/openclaw/pull/81",
          closed_at: olderClosedAt,
          closed_by: { login: "clawsweeper[bot]" },
          pull_request: {},
        },
        {
          number: 82,
          title: "Alternate app closed issue",
          html_url: "https://github.com/openclaw/openclaw/issues/82",
          closed_at: oldestClosedAt,
          closed_by: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          number: 80,
          title: "Remove old session warning",
          html_url: "https://github.com/openclaw/openclaw/issues/80",
          closed_at: closedAt,
          closed_by: { login: "clawsweeper[bot]" },
        },
        {
          number: 79,
          title: "Human closed issue",
          html_url: "https://github.com/openclaw/openclaw/issues/79",
          closed_at: closedAt,
          closed_by: { login: "steipete" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      issuePages.push(url.searchParams.get("page") || "");
      return jsonResponse([]);
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.item_closed",
          mode: "item_closed",
          stage: "close_duplicate",
          status: "executed",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/80",
          title: "Real close event",
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);
    const prClose = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.item_closed",
          mode: "item_closed",
          stage: "close_fixed_by_candidate",
          status: "executed",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/81",
          title: "Explicit PR close event",
        }),
      }),
      env,
    );
    assert.equal(prClose.status, 200);
    const blocked = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.close_blocked",
          mode: "close_blocked",
          stage: "close_duplicate",
          status: "blocked",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/82",
          title: "Blocked close event",
        }),
      }),
      env,
    );
    assert.equal(blocked.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      status.recent.closed_items.map(
        (item: { type: string; number: number; closed_by: string }) => ({
          type: item.type,
          number: item.number,
          closed_by: item.closed_by,
        }),
      ),
      [
        { type: "Issue", number: 80, closed_by: "clawsweeper[bot]" },
        { type: "PR", number: 81, closed_by: "clawsweeper[bot]" },
        { type: "Issue", number: 82, closed_by: "openclaw-clawsweeper[bot]" },
      ],
    );
    assert.deepEqual(
      status.recent.events.map(
        (event: {
          mode: string;
          stage: string;
          status: string;
          item_number: number;
          source: string;
          title: string;
        }) => ({
          mode: event.mode,
          stage: event.stage,
          status: event.status,
          item_number: event.item_number,
          source: event.source,
          title: event.title,
        }),
      ),
      [
        {
          mode: "close_blocked",
          stage: "close_duplicate",
          status: "blocked",
          item_number: undefined,
          source: undefined,
          title: "Blocked close event",
        },
        {
          mode: "item_closed",
          stage: "close_fixed_by_candidate",
          status: "executed",
          item_number: undefined,
          source: undefined,
          title: "Explicit PR close event",
        },
        {
          mode: "item_closed",
          stage: "close_duplicate",
          status: "executed",
          item_number: undefined,
          source: undefined,
          title: "Real close event",
        },
        {
          mode: "closed",
          stage: "Issue",
          status: "closed",
          item_number: 82,
          source: "closed_items",
          title: "Alternate app closed issue",
        },
      ],
    );
    assert.deepEqual(status.recent.closed_stats, {
      window_hours: 24,
      since: status.recent.closed_stats.since,
      total: 3,
      issues: 2,
      prs: 1,
      by_repository: {
        "openclaw/openclaw": {
          total: 3,
          issues: 2,
          prs: 1,
        },
      },
    });
    assert.ok(new Date(status.recent.closed_stats.since).getTime() <= Date.now());
    assert.deepEqual(issuePages, ["1"]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard fetches additional closed pages only when the first page is full", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const issuePages: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      const page = url.searchParams.get("page") || "";
      issuePages.push(page);
      if (page === "1") {
        return jsonResponse(
          Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            title: `Human closed issue ${index + 1}`,
            html_url: `https://github.com/openclaw/openclaw/issues/${index + 1}`,
            closed_at: closedAt,
            closed_by: { login: "steipete" },
          })),
        );
      }
      if (page === "2") {
        return jsonResponse([
          {
            number: 101,
            title: "ClawSweeper closed overflow page issue",
            html_url: "https://github.com/openclaw/openclaw/issues/101",
            closed_at: closedAt,
            closed_by: { login: "clawsweeper[bot]" },
          },
        ]);
      }
      return jsonResponse([]);
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      issuePages.sort((left, right) => Number(left) - Number(right)),
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    );
    assert.deepEqual(status.recent.closed_stats, {
      window_hours: 24,
      since: status.recent.closed_stats.since,
      total: 1,
      issues: 1,
      prs: 0,
      by_repository: {
        "openclaw/openclaw": {
          total: 1,
          issues: 1,
          prs: 0,
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused views use direct search when broad snapshot is capped", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let readyPerPage = "";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/openclaw/labels") {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        readyPerPage = url.searchParams.get("per_page") || "";
        return jsonResponse({
          total_count: 2,
          items: [
            triageIssue(102, ["clawsweeper:queueable-fix", "impact:message-loss"]),
            triageIssue(100, ["clawsweeper:queueable-fix"]),
          ],
        });
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 501,
          items:
            page === "1"
              ? [
                  triageIssue(102, ["clawsweeper:queueable-fix"]),
                  triageIssue(101, ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"]),
                ]
              : [],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    const root = snapshot.views.find((view: { id: string }) => view.id === "clawsweeper");
    const ready = snapshot.views.find((view: { id: string }) => view.id === "ready-candidates");
    assert.equal(root.item_limit, 500);
    assert.equal(ready.total_count, 2);
    assert.equal(ready.item_limit, 100);
    assert.equal(readyPerPage, "100");
    assert.deepEqual(
      ready.items.map((item: { number: number }) => item.number),
      [102, 100],
    );
    assert.deepEqual(
      ready.items[0].routing_groups.map((group: { id: string }) => group.id),
      ["message-delivery"],
    );
    assert.deepEqual(
      ready.items[1].routing_groups.map((group: { id: string }) => group.id),
      ["unclassified"],
    );
    assert.equal(ready.loaded_routing_group_counts["message-delivery"], 1);
    assert.equal(ready.loaded_routing_group_counts.unclassified, 1);
    assert.ok(snapshot.routing_groups.some((group: { id: string }) => group.id === "state-data"));
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused fallbacks reserve search budget for later repos", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let sawSecondRepoLastRootPage = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      const repo = query.includes("repo:openclaw/other") ? "openclaw/other" : "openclaw/openclaw";
      if (repo === "openclaw/other" && page === "4") {
        sawSecondRepoLastRootPage = true;
      }
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        return jsonResponse({
          total_count: 1,
          items: [triageIssue(repo, 200, ["clawsweeper:queueable-fix"])],
        });
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 401,
          items: [triageIssue(repo, Number(page), ["clawsweeper:queueable-fix"])],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: "openclaw/openclaw,openclaw/other",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.equal(sawSecondRepoLastRootPage, true);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused search errors fall back to loaded broad rows", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        throw new Error("focused search failed");
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 501,
          items:
            page === "1"
              ? [
                  triageIssue(102, ["clawsweeper:queueable-fix"]),
                  triageIssue(101, ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"]),
                ]
              : [],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    const ready = snapshot.views.find((view: { id: string }) => view.id === "ready-candidates");
    assert.equal(ready.total_count, 1);
    assert.deepEqual(
      ready.items.map((item: { number: number }) => item.number),
      [102],
    );
    assert.match(snapshot.diagnostics.errors.join("\n"), /focused search failed/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage skips repos after root search budget is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        total_count: 1,
        items: [triageIssue(searchRequests, ["clawsweeper:queueable-fix"])],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const repos = Array.from({ length: 10 }, (_, index) => `openclaw/repo-${index}`).join(",");
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: repos,
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.match(snapshot.diagnostics.errors.join("\n"), /repo-9 triage skipped/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage debits failed root searches from the search budget", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      throw new Error("root search failed");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const repos = Array.from({ length: 10 }, (_, index) => `openclaw/repo-${index}`).join(",");
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: repos,
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.match(snapshot.diagnostics.errors.join("\n"), /repo-9 triage skipped/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage uses ClawSweeper GitHub App credentials when no static token is configured", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let sawAppJwt = false;
  let sawInstallationToken = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = String(new Headers(init?.headers).get("authorization") || "");
    if (url.pathname === "/repos/openclaw/openclaw/installation") {
      sawAppJwt = authorization.startsWith("Bearer ");
      return jsonResponse({ id: 12345 });
    }
    if (url.pathname === "/app/installations/12345/access_tokens") {
      sawAppJwt = authorization.startsWith("Bearer ");
      return jsonResponse({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/labels") {
      sawInstallationToken = authorization === "Bearer installation-token";
      return jsonResponse([{ name: "clawsweeper:queueable-fix", color: "0E8A16" }]);
    }
    if (url.pathname === "/search/issues") {
      sawInstallationToken = authorization === "Bearer installation-token";
      return jsonResponse({
        total_count: 1,
        items: [triageIssue(101, ["clawsweeper:queueable-fix"])],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: String(privateKey),
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(response.status, 200);
    assert.equal(snapshot.source.search_request_budget_remaining, 27);
    assert.equal(sawAppJwt, true);
    assert.equal(sawInstallationToken, true);
    assert.doesNotMatch(snapshot.diagnostics.errors.join("\n"), /GITHUB_TOKEN/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("hosted webhook accepts author read-only mention commands", async () => {
  for (const body of [
    "@clawsweeper Re-run",
    "@clawsweeper\nre-review based on latest comments",
    "The issue may already be fixed.\n@clawsweeper re-review based on latest comments\nThanks.",
  ]) {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/openclaw",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 76991, user: { login: "contributor" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body,
            author_association: "CONTRIBUTOR",
            user: { login: "contributor" },
          },
        },
      }),
      { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
    );
    assert.equal(response.status, 503, `${body} should pass classification before app config`);
    assert.deepEqual(await response.json(), { error: "github_app_not_configured" });
  }
});

test("hosted webhook ignores inline ClawSweeper mentions before fast ack", async () => {
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "created",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 87801, user: { login: "issue-author" } },
        installation: { id: 123 },
        comment: {
          id: 456,
          body: "the closed PR 87835 was closed as already implemented by PR 87890 @clawsweeper re-review and if necessary close this issue",
          author_association: "MEMBER",
          user: { login: "brokemac79" },
        },
      },
    }),
    { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "no routable ClawSweeper command",
  });
});

test("hosted webhook returns invalid_json for signed malformed bodies", async () => {
  const response = await worker.fetch(
    signedGithubWebhookBodyRequest({
      event: "issue_comment",
      secret: "test-secret",
      body: "{",
    }),
    { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

test("hosted webhook rejects all label mutations before exact-review intake", async () => {
  for (const sender of ["openclaw-clawsweeper[bot]", "openclaw-barnacle[bot]", "steipete"]) {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issues",
        secret: "test-secret",
        payload: {
          action: "labeled",
          repository: {
            full_name: "openclaw/openclaw",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 76991 },
          installation: { id: 123 },
          label: { name: "status: ready for maintainer look" },
          sender: { login: sender },
        },
      }),
      { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: false,
      reason: "unsupported action",
    });
  }
});

test("hosted webhook enqueues item events with the repository default branch", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issues",
      secret: "test-secret",
      payload: {
        action: "opened",
        repository: {
          full_name: "openclaw/gogcli",
          default_branch: "trunk",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 597 },
        installation: { id: 123 },
      },
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/gogcli#597",
  });
});

test("hosted webhook reuses existing fast ack comments on redelivery", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchBody: unknown = null;
  let postedAck = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      assert.equal(authorization, "Bearer target-token");
      assert.equal(url.searchParams.get("per_page"), "100");
      return jsonResponse([
        {
          id: 777,
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "POST") {
      postedAck = true;
      return jsonResponse({ id: 888 });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      assert.equal(authorization, "Bearer target-token");
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      assert.equal(authorization, "Bearer dispatch-token");
      dispatchBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 597, user: { login: "steipete" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body: "@clawsweeper status",
            author_association: "OWNER",
            user: { login: "steipete" },
          },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(postedAck, false);
    assert.deepEqual(dispatchBody, {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: "openclaw/gogcli",
        target_branch: "trunk",
        item_number: 597,
        comment_id: 456,
        status_comment_id: 777,
        source_event: "issue_comment",
        source_action: "created",
        max_comments: "1",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook coalesces concurrent duplicate fast ack comments", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const comments: Array<{ id: number; body: string; created_at: string; user: { login: string } }> =
    [];
  const dispatchBodies: unknown[] = [];
  let fastAckPosts = 0;
  let reactions = 0;
  let releaseAckPost: (() => void) | undefined;
  let markAckPostStarted: (() => void) | undefined;
  const ackPostRelease = new Promise<void>((resolve) => {
    releaseAckPost = resolve;
  });
  const ackPostStarted = new Promise<void>((resolve) => {
    markAckPostStarted = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      assert.equal(authorization, "Bearer target-token");
      return jsonResponse([...comments]);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "POST") {
      assert.equal(authorization, "Bearer target-token");
      fastAckPosts += 1;
      markAckPostStarted?.();
      await ackPostRelease;
      const body = JSON.parse(String(init.body || "{}"));
      const comment = {
        id: 777,
        body: String(body.body || ""),
        created_at: "2026-05-28T13:00:00Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      };
      comments.push(comment);
      return jsonResponse(comment);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      assert.equal(authorization, "Bearer target-token");
      reactions += 1;
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      assert.equal(authorization, "Bearer dispatch-token");
      dispatchBodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const payload = {
    action: "created",
    repository: {
      full_name: "openclaw/gogcli",
      default_branch: "trunk",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    issue: { number: 597, user: { login: "steipete" } },
    installation: { id: 123 },
    comment: {
      id: 456,
      body: "@clawsweeper build",
      author_association: "OWNER",
      user: { login: "steipete" },
    },
  };
  const env = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
  };

  try {
    const left = worker.fetch(
      signedGithubWebhookRequest({ event: "issue_comment", secret: "test-secret", payload }),
      env,
    );
    const right = worker.fetch(
      signedGithubWebhookRequest({ event: "issue_comment", secret: "test-secret", payload }),
      env,
    );
    await ackPostStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseAckPost?.();
    const [leftResponse, rightResponse] = await Promise.all([left, right]);

    assert.equal(leftResponse.status, 202);
    assert.equal(rightResponse.status, 202);
    assert.deepEqual(await leftResponse.json(), { ok: true, status_comment_id: 777 });
    assert.deepEqual(await rightResponse.json(), { ok: true, status_comment_id: 777 });
    assert.equal(fastAckPosts, 1);
    assert.equal(reactions, 2);
    assert.equal(comments.length, 1);
    assert.match(comments[0]?.body || "", /clawsweeper-command-ack:456/);
    assert.equal(dispatchBodies.length, 2);
    assert.deepEqual(
      dispatchBodies.map(
        (body) =>
          (body as { client_payload?: { status_comment_id?: unknown } }).client_payload
            ?.status_comment_id,
      ),
      [777, 777],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook removes duplicate fast ack comments after concurrent redelivery", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let commentLookups = 0;
  let deletedAck = 0;
  let dispatchBody: unknown = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      commentLookups += 1;
      if (commentLookups === 1) return jsonResponse([]);
      return jsonResponse([
        {
          id: 777,
          created_at: "2026-05-24T00:00:00Z",
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          id: 888,
          created_at: "2026-05-24T00:00:01Z",
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "POST") {
      return jsonResponse({ id: 888 });
    }
    if (
      url.pathname === "/repos/openclaw/gogcli/issues/comments/888" &&
      init?.method === "DELETE"
    ) {
      deletedAck = 888;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatchBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 597, user: { login: "steipete" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body: "@clawsweeper build",
            author_association: "OWNER",
            user: { login: "steipete" },
          },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(deletedAck, 888);
    assert.equal(commentLookups, 2);
    assert.deepEqual(dispatchBody, {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: "openclaw/gogcli",
        target_branch: "trunk",
        item_number: 597,
        comment_id: 456,
        status_comment_id: 777,
        source_event: "issue_comment",
        source_action: "created",
        max_comments: "1",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook schedules post-dispatch fast ack cleanup", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let commentLookups = 0;
  let deletedAck = 0;
  const waitUntilPromises: Promise<unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      commentLookups += 1;
      if (commentLookups <= 2) {
        return jsonResponse([
          {
            id: 777,
            created_at: "2026-05-28T13:00:00Z",
            body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
            user: { login: "openclaw-clawsweeper[bot]" },
          },
        ]);
      }
      return jsonResponse([
        {
          id: 777,
          created_at: "2026-05-28T13:00:00Z",
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          id: 888,
          created_at: "2026-05-28T13:00:01Z",
          updated_at: "2026-05-28T13:00:02Z",
          body: [
            "<!-- clawsweeper-command-status:597:implement_issue:abc123 -->",
            "<!-- clawsweeper-command-ack:456 -->",
            "ClawSweeper issue implementation requested.",
            "<!-- clawsweeper-command-progress:start -->",
            "Implementation progress:",
            "- State: In progress",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    }
    if (
      url.pathname === "/repos/openclaw/gogcli/issues/comments/777" &&
      init?.method === "DELETE"
    ) {
      deletedAck = 777;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 597, user: { login: "steipete" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body: "@clawsweeper build",
            author_association: "OWNER",
            user: { login: "steipete" },
          },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0,0,0",
      },
      {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
    assert.equal(deletedAck, 777);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard shares in-flight GitHub App installation token across parallel requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let tokenRequests = 0;
  let badBearer = "";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = String(new Headers(init?.headers).get("authorization") || "");
    if (url.pathname === "/repos/openclaw/openclaw/installation") {
      return jsonResponse({ id: 12345 });
    }
    if (url.pathname === "/app/installations/12345/access_tokens") {
      tokenRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.hostname === "api.github.com") {
      if (authorization !== "Bearer installation-token") badBearer = authorization;
      if (url.pathname.endsWith("/actions/runs")) return jsonResponse({ workflow_runs: [] });
      if (url.pathname === "/search/issues") return jsonResponse({ total_count: 0, items: [] });
      if (url.pathname.endsWith("/issues")) return jsonResponse([]);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23parallel",
        CLAWSWEEPER_APP_PRIVATE_KEY: String(privateKey),
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    assert.equal(response.status, 200);
    assert.equal(tokenRequests, 1);
    assert.equal(badBearer, "");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard html preserves client compactText regex escapes", async () => {
  const response = await worker.fetch(new Request("https://example.test/"));
  const body = await response.text();
  const match = body.match(/function compactText\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, "compactText function should render in dashboard html");
  const compactText = new Function(`${match[0]}; return compactText;`)() as (
    value: unknown,
  ) => string;

  assert.equal(
    compactText("1234567890abcdef1234567890abcdef\n\t repeated   spaces"),
    "1234567890 repeated spaces",
  );
});

async function activePrFetch(input: RequestInfo | URL) {
  const url = String(input);
  if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
    return jsonResponse({
      workflow_runs: [
        {
          id: 1,
          name: "ClawSweeper",
          display_title: "Review event item openclaw/openclaw#80609",
          status: "in_progress",
          conclusion: null,
          html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
          created_at: new Date(Date.now() - 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
  }
  if (url.includes("/repos/openclaw/openclaw/issues")) return jsonResponse([]);
  if (url.includes("/search/issues")) return jsonResponse({ items: [] });
  throw new Error(`unexpected fetch ${url}`);
}

function triageIssue(number: number, labelNames: string[]): Record<string, unknown>;
function triageIssue(repo: string, number: number, labelNames: string[]): Record<string, unknown>;
function triageIssue(
  repoOrNumber: string | number,
  numberOrLabels: number | string[],
  maybeLabels?: string[],
) {
  const repo = typeof repoOrNumber === "string" ? repoOrNumber : "openclaw/openclaw";
  const number = typeof repoOrNumber === "string" ? Number(numberOrLabels) : repoOrNumber;
  const labelNames = typeof repoOrNumber === "string" ? maybeLabels || [] : numberOrLabels;
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/${repo}/issues/${number}`,
    created_at: `2026-05-01T00:${String(number % 60).padStart(2, "0")}:00Z`,
    updated_at: `2026-05-02T00:${String(number % 60).padStart(2, "0")}:00Z`,
    comments: 0,
    user: { login: "reporter" },
    assignees: [],
    labels: labelNames.map((name) => ({ name, color: "0E8A16" })),
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
    },
  });
}

function signedGithubWebhookRequest({
  event,
  secret,
  payload,
}: {
  event: string;
  secret: string;
  payload: unknown;
}) {
  const body = JSON.stringify(payload);
  return signedGithubWebhookBodyRequest({ event, secret, body });
}

function signedGithubWebhookBodyRequest({
  event,
  secret,
  body,
}: {
  event: string;
  secret: string;
  body: string;
}) {
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Request("https://clawsweeper.openclaw.ai/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "test-delivery",
      "x-hub-signature-256": signature,
    },
    body,
  });
}

function buildExactReviewQueueRequest(
  deliveryId: string,
  itemNumber: number,
  sourceAction: string,
  itemKind: "issue" | "pull_request" = "issue",
  targetRepo = "openclaw/gogcli",
  decisionOverrides: Record<string, unknown> = {},
) {
  const sourceEvent = itemKind === "issue" ? "issues" : "pull_request";
  return new Request("https://clawsweeper-exact-review-queue/enqueue", {
    method: "POST",
    body: JSON.stringify({
      delivery_id: deliveryId,
      decision: {
        targetRepo,
        targetBranch: "main",
        itemNumber,
        itemKind,
        sourceEvent,
        sourceAction,
        supersedesInProgress: sourceAction === "edited" || sourceAction === "synchronize",
        ...decisionOverrides,
      },
    }),
  });
}
