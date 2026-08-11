import {
  assert,
  createHash,
  generateKeyPairSync,
  test,
  worker,
  ExactReviewQueue,
  MemoryKv,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  jsonResponse,
  signedGithubWebhookRequest,
  signedGithubWebhookBodyRequest,
  createExactReviewAdmissionHarness,
  buildExactReviewQueueRequest,
  leasedExactReviewQueueItem,
} from "./dashboard-worker-harness.ts";

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

test("hosted webhook rejects label additions before exact-review intake", async () => {
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

test("hosted issue webhook enqueues without completing pull request authority", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  let authorityCompletionCalls = 0;
  const queueStub = {
    fetch(request: Request) {
      if (new URL(request.url).pathname === "/source-authority/complete") {
        authorityCompletionCalls += 1;
      }
      return queue.fetch(request);
    },
  };
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
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queueStub),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/gogcli#597",
    superseded_publications: 0,
  });
  assert.equal(authorityCompletionCalls, 0);
});

test("hosted edited webhook binds and enqueues only the live pull request head", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const now = 3_000_000;
  Date.now = () => now;
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const staleHeadSha = "a".repeat(40);
  const sourceHeadSha = "b".repeat(40);
  const sourceContentRevision = createHash("sha256")
    .update(
      JSON.stringify({ version: 1, title: "Document the edit", body: "Fresh review context." }),
    )
    .digest("hex");
  let verificationCalls = 0;
  globalThis.fetch = async (input) => {
    verificationCalls += 1;
    assert.equal(String(input), "https://api.github.com/repos/openclaw/gogcli/pulls/596");
    return new Response(JSON.stringify({ head: { sha: sourceHeadSha } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const send = (headSha: string, updatedAt: string, deliveryId: string) =>
    worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId,
        payload: {
          action: "edited",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          pull_request: {
            number: 596,
            head: { sha: headSha },
            base: { sha: "c".repeat(40) },
            draft: false,
            title: "Document the edit",
            body: "Fresh review context.",
            updated_at: updatedAt,
          },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        GITHUB_TOKEN: "test-token",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );

  try {
    const response = await send(sourceHeadSha, "2026-07-23T13:00:02Z", "edited-current-596");
    assert.equal(response.status, 202);
    const duplicateResponse = await send(
      sourceHeadSha,
      "2026-07-23T13:00:02Z",
      "synchronize-current-596",
    );
    assert.deepEqual(await duplicateResponse.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#596",
      dedupe_scope: "semantic_edited",
      dedupe_reason: "unchanged_pull_request_edit",
    });
    assert.equal(verificationCalls, 2);
    const staleResponse = await send(staleHeadSha, "2026-07-23T13:00:01Z", "synchronize-stale-596");
    assert.equal(staleResponse.status, 202);
    assert.deepEqual(await staleResponse.json(), {
      ok: true,
      accepted: false,
      reason: "stale pull request head",
    });
    assert.equal(verificationCalls, 3);
    const staleDuplicateResponse = await send(
      staleHeadSha,
      "2026-07-23T13:00:01Z",
      "synchronize-stale-596",
    );
    assert.deepEqual(await staleDuplicateResponse.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#596",
    });
    assert.equal(verificationCalls, 3);
    assert.equal(storage.rawGet("exact-review-source-authority-sequence:v1"), 3);
    const stored = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          decision: {
            sourceHeadSha?: string;
            sourceHeadVerified?: boolean;
            sourceAuthoritySeq?: number;
            sourceUpdatedAt?: string;
          };
        }
      >;
    };
    assert.deepEqual(stored.items["openclaw/gogcli#596"].decision, {
      targetRepo: "openclaw/gogcli",
      targetBranch: "trunk",
      itemNumber: 596,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "edited",
      supersedesInProgress: true,
      sourceHeadSha,
      sourceBaseSha: "c".repeat(40),
      sourceIsDraft: false,
      sourceContentRevision,
      sourceHeadVerified: true,
      sourceAuthoritySeq: 1,
      sourceUpdatedAt: "2026-07-23T13:00:02Z",
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("hosted pull request verification preserves ingress through a transient failure and queue restart", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 3_500_000;
  Date.now = () => now;
  const storage = new MemoryDurableStorage();
  const sourceHeadSha = "c".repeat(40);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const queueEnv = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
  };
  const queue = new ExactReviewQueue({ storage }, queueEnv);
  let verificationFailures = 2;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/gogcli/pulls/595") {
      if (verificationFailures > 0) {
        verificationFailures -= 1;
        throw new Error("transient GitHub failure");
      }
      return jsonResponse({ head: { sha: sourceHeadSha } });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        payload: {
          action: "synchronize",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          pull_request: {
            number: 595,
            head: { sha: sourceHeadSha },
            updated_at: "2026-07-23T13:00:02Z",
          },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        GITHUB_TOKEN: "test-token",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: true,
      deferred: true,
      reason: "pull request head verification deferred",
    });
    assert.equal(
      storage.rawHas("exact-review-source-authority-reservation:v1:test-delivery"),
      true,
    );
    const fallbackFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/gogcli",
          item_number: 595,
          action: "synchronize",
          head_sha: sourceHeadSha,
          updated_at: "2026-07-23T13:00:02Z",
          body: "",
          label: "",
        }),
      )
      .digest("hex");
    const fallback = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-after-deferred-direct",
        595,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: fallbackFingerprint } },
      ),
    );
    assert.equal((await fallback.json()).queued, true);

    const restarted = new ExactReviewQueue({ storage }, queueEnv);
    await restarted.alarm();
    const deferred = storage.rawGet(
      "exact-review-source-authority-reservation:v1:test-delivery",
    ) as {
      attempts: number;
      nextAttemptAt: number;
      sourceAuthoritySeq: number;
    };
    assert.equal(deferred.attempts, 1);
    assert.equal(deferred.sourceAuthoritySeq, 1);
    assert.equal(deferred.nextAttemptAt, now + 15_000);
    assert.equal(await storage.getAlarm(), deferred.nextAttemptAt);

    now = deferred.nextAttemptAt;
    await restarted.alarm();
    const stored = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          revision: number;
          decision: {
            sourceHeadSha?: string;
            sourceHeadVerified?: boolean;
            sourceAuthoritySeq?: number;
          };
        }
      >;
    };
    assert.equal(stored.items["openclaw/gogcli#595"].revision, 2);
    assert.equal(stored.items["openclaw/gogcli#595"].decision.sourceHeadSha, sourceHeadSha);
    assert.equal(stored.items["openclaw/gogcli#595"].decision.sourceHeadVerified, true);
    assert.equal(stored.items["openclaw/gogcli#595"].decision.sourceAuthoritySeq, 1);
    assert.equal(
      storage.rawHas("exact-review-source-authority-reservation:v1:test-delivery"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("hosted reopened webhook advances to its verified current head", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const previousHeadSha = "d".repeat(40);
  const sourceHeadSha = "e".repeat(40);
  const existing = leasedExactReviewQueueItem(594, "5940");
  existing.decision.itemKind = "pull_request";
  existing.decision.sourceEvent = "pull_request";
  existing.decision.sourceHeadSha = previousHeadSha;
  existing.leaseDecision.itemKind = "pull_request";
  existing.leaseDecision.sourceEvent = "pull_request";
  existing.leaseDecision.sourceHeadSha = previousHeadSha;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/gogcli#594": existing },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://api.github.com/repos/openclaw/gogcli/pulls/594");
    return jsonResponse({ head: { sha: sourceHeadSha } });
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        payload: {
          action: "reopened",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          pull_request: {
            number: 594,
            head: { sha: sourceHeadSha },
            updated_at: "2026-07-23T13:00:03Z",
          },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        GITHUB_TOKEN: "test-token",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );
    assert.equal(response.status, 202);
    const stored = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string; sourceHeadSha?: string } }>;
    };
    assert.equal(stored.items["openclaw/gogcli#594"].decision.sourceAction, "reopened");
    assert.equal(stored.items["openclaw/gogcli#594"].decision.sourceHeadSha, sourceHeadSha);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue drops a delayed matching ingress after the first review completes", async () => {
  const sourceHeadSha = "f".repeat(40);
  const fingerprint = "e".repeat(64);
  const harness = createExactReviewAdmissionHarness(() =>
    jsonResponse({ state: "open", head: { sha: sourceHeadSha } }),
  );

  try {
    const direct = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "completed-direct-ingress",
        601,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 1,
          sourceUpdatedAt: "2026-07-23T13:00:02Z",
        },
        { ingress: { route: "direct_webhook", fingerprint } },
      ),
    );
    assert.equal((await direct.json()).queued, true);

    await harness.queue.alarm();
    const dispatched = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const item = dispatched.items["openclaw/gogcli#601"];
    assert.ok(item);
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#601",
          lease_revision: item.leaseRevision,
          run_id: "6010",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(claim.status, 200);
    const claimed = (await claim.json()) as { claim_generation: number };
    const completed = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#601",
          lease_revision: item.leaseRevision,
          claim_generation: claimed.claim_generation,
          run_id: "6010",
          run_attempt: 1,
          outcome: "success",
        }),
      }),
    );
    assert.deepEqual(await completed.json(), { ok: true, requeued: false });

    const fallback = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "delayed-fallback-ingress",
        601,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint } },
      ),
    );
    assert.deepEqual(await fallback.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#601",
      dedupe_scope: "cross_route",
    });
    const afterFallback = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(afterFallback.items["openclaw/gogcli#601"], undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review queue upgrades ingress receipts with admission tracking", async () => {
  const storage = new MemoryDurableStorage();
  const receivedAt = Date.now();
  storage.sql.exec(`CREATE TABLE exact_review_queue_ingress (
    fingerprint TEXT NOT NULL,
    route TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (fingerprint, route)
  ) STRICT`);
  storage.sql.exec(
    `INSERT INTO exact_review_queue_ingress (fingerprint, route, target_branch, received_at)
     VALUES (?, ?, ?, ?)`,
    "f".repeat(64),
    "direct_webhook",
    "trunk",
    receivedAt,
  );
  const queue = new ExactReviewQueue({ storage }, {});

  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const columns = Array.from(
    storage.sql.exec(`SELECT name FROM pragma_table_info('exact_review_queue_ingress')`),
  ) as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "admitted_at"));
  const migrated = Array.from(
    storage.sql.exec(
      `SELECT admitted_at FROM exact_review_queue_ingress
        WHERE fingerprint = ? AND route = 'direct_webhook'`,
      "f".repeat(64),
    ),
  )[0] as { admitted_at: number };
  assert.equal(migrated.admitted_at, receivedAt);
  const delayedFallback = await queue.fetch(
    buildExactReviewQueueRequest(
      "legacy-after-upgrade",
      601,
      "synchronize",
      "pull_request",
      "openclaw/gogcli",
      { targetBranch: "trunk" },
      { ingress: { route: "target_dispatcher", fingerprint: "f".repeat(64) } },
    ),
  );
  assert.deepEqual(await delayedFallback.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#601",
    dedupe_scope: "cross_route",
  });
});

test("exact-review queue re-upgrade admits a direct receipt written by a rollback", async () => {
  const storage = new MemoryDurableStorage();
  const firstUpgrade = new ExactReviewQueue({ storage }, {});
  await firstUpgrade.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const receivedAt = Date.now();
  storage.sql.exec(
    `INSERT INTO exact_review_queue_ingress
     (fingerprint, route, target_branch, received_at, admitted_at)
     VALUES (?, ?, ?, ?, NULL)`,
    "9".repeat(64),
    "direct_webhook",
    "trunk",
    receivedAt,
  );

  const reupgraded = new ExactReviewQueue({ storage }, {});
  const migrated = Array.from(
    storage.sql.exec(
      `SELECT admitted_at FROM exact_review_queue_ingress
        WHERE fingerprint = ? AND route = 'direct_webhook'`,
      "9".repeat(64),
    ),
  )[0] as { admitted_at: number };
  assert.equal(migrated.admitted_at, receivedAt);
  const delayedFallback = await reupgraded.fetch(
    buildExactReviewQueueRequest(
      "fallback-after-reupgrade",
      605,
      "synchronize",
      "pull_request",
      "openclaw/gogcli",
      { targetBranch: "trunk" },
      { ingress: { route: "target_dispatcher", fingerprint: "9".repeat(64) } },
    ),
  );
  assert.deepEqual(await delayedFallback.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#605",
    dedupe_scope: "cross_route",
  });
});

test("unadmitted fallback receipts do not suppress a later verified direct event", async () => {
  const firstHeadSha = "a".repeat(40);
  const secondHeadSha = "b".repeat(40);
  const firstFingerprint = "a".repeat(64);
  const secondFingerprint = "b".repeat(64);
  const harness = createExactReviewAdmissionHarness(() =>
    jsonResponse({ state: "open", head: { sha: firstHeadSha } }),
  );

  try {
    await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "verified-first",
        602,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha: firstHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 1,
          sourceUpdatedAt: "2026-07-23T13:00:02Z",
        },
        { ingress: { route: "direct_webhook", fingerprint: firstFingerprint } },
      ),
    );
    const staleFallback = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "stale-fallback-second",
        602,
        "edited",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: secondFingerprint } },
      ),
    );
    assert.deepEqual(await staleFallback.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#602",
      stale_source: true,
    });

    await harness.queue.alarm();
    const dispatched = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const item = dispatched.items["openclaw/gogcli#602"];
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#602",
          lease_revision: item.leaseRevision,
          run_id: "6020",
          run_attempt: 1,
        }),
      }),
    );
    const claimed = (await claim.json()) as { claim_generation: number };
    const completed = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#602",
          lease_revision: item.leaseRevision,
          claim_generation: claimed.claim_generation,
          run_id: "6020",
          run_attempt: 1,
          outcome: "success",
        }),
      }),
    );
    assert.deepEqual(await completed.json(), { ok: true, requeued: false });

    const verifiedSecond = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "verified-second",
        602,
        "edited",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha: secondHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 2,
          sourceUpdatedAt: "2026-07-23T13:01:02Z",
        },
        { ingress: { route: "direct_webhook", fingerprint: secondFingerprint } },
      ),
    );
    assert.equal((await verifiedSecond.json()).queued, true);
    const afterDirect = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string; sourceHeadSha?: string } }>;
    };
    assert.equal(afterDirect.items["openclaw/gogcli#602"].decision.sourceAction, "edited");
    assert.equal(afterDirect.items["openclaw/gogcli#602"].decision.sourceHeadSha, secondHeadSha);
  } finally {
    harness.restore();
  }
});

test("a delayed counterpart cannot replace a newer admitted fallback", async () => {
  const firstFingerprint = "c".repeat(64);
  const secondFingerprint = "d".repeat(64);
  const firstHeadSha = "c".repeat(40);
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }));

  try {
    await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "fallback-first-complete",
        603,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: firstFingerprint } },
      ),
    );
    await harness.queue.alarm();
    const dispatched = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const item = dispatched.items["openclaw/gogcli#603"];
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#603",
          lease_revision: item.leaseRevision,
          run_id: "6030",
          run_attempt: 1,
        }),
      }),
    );
    const claimed = (await claim.json()) as { claim_generation: number };
    await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/gogcli#603",
          lease_revision: item.leaseRevision,
          claim_generation: claimed.claim_generation,
          run_id: "6030",
          run_attempt: 1,
          outcome: "success",
        }),
      }),
    );
    const newerFallback = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "fallback-second-pending",
        603,
        "edited",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: secondFingerprint } },
      ),
    );
    assert.equal((await newerFallback.json()).queued, true);

    const delayedDirect = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "delayed-direct-first",
        603,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha: firstHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 1,
          sourceUpdatedAt: "2026-07-23T13:00:02Z",
        },
        { ingress: { route: "direct_webhook", fingerprint: firstFingerprint } },
      ),
    );
    assert.deepEqual(await delayedDirect.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#603",
      dedupe_scope: "cross_route",
    });
    const afterDelayed = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string } }>;
    };
    assert.equal(afterDelayed.items["openclaw/gogcli#603"].decision.sourceAction, "edited");
  } finally {
    harness.restore();
  }
});

test("a delayed direct ingress cannot promote across a newer legacy-only update", async () => {
  const firstFingerprint = "e".repeat(64);
  const firstHeadSha = "e".repeat(40);
  const secondHeadSha = "f".repeat(40);
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }));

  try {
    const fallback = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "fallback-before-legacy-update",
        604,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: firstFingerprint } },
      ),
    );
    assert.equal((await fallback.json()).queued, true);

    const legacyUpdate = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-only-newer-update",
        604,
        "edited",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha: secondHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 2,
        },
      ),
    );
    assert.equal((await legacyUpdate.json()).queued, true);

    const delayedDirect = await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "delayed-direct-before-legacy-update",
        604,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        {
          targetBranch: "trunk",
          sourceHeadSha: firstHeadSha,
          sourceHeadVerified: true,
          sourceAuthoritySeq: 3,
        },
        { ingress: { route: "direct_webhook", fingerprint: firstFingerprint } },
      ),
    );
    assert.deepEqual(await delayedDirect.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#604",
      dedupe_scope: "cross_route",
    });
    const afterDelayed = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string }; ingressFingerprint?: string }>;
    };
    assert.equal(afterDelayed.items["openclaw/gogcli#604"].decision.sourceAction, "edited");
    assert.equal(afterDelayed.items["openclaw/gogcli#604"].ingressFingerprint, undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review queue coalesces matching ingress and promotes verified direct authority", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    GITHUB_TOKEN: "test-token",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const repository = {
    full_name: "openclaw/gogcli",
    default_branch: "trunk",
    private: false,
    archived: false,
    fork: false,
    has_issues: true,
  };
  const pullRequest = {
    number: 597,
    head: { sha: "a".repeat(40) },
    updated_at: "2026-07-19T10:19:00Z",
    body: "Add durable proof.",
  };
  const originalFetch = globalThis.fetch;
  const liveHeads = new Map([
    [597, "a".repeat(40)],
    [599, "c".repeat(40)],
    [600, "d".repeat(40)],
  ]);
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const match = url.pathname.match(/^\/repos\/openclaw\/gogcli\/pulls\/(\d+)$/);
    assert.ok(match);
    const head = liveHeads.get(Number(match[1]));
    assert.ok(head);
    return jsonResponse({ head: { sha: head } });
  };

  try {
    const direct = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId: "direct-pr-delivery",
        payload: {
          action: "synchronize",
          repository,
          pull_request: pullRequest,
          installation: { id: 123 },
        },
      }),
      env,
    );
    assert.deepEqual(await direct.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#597",
      superseded_publications: 0,
    });
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/gogcli",
          item_number: 597,
          action: "synchronize",
          head_sha: "a".repeat(40),
          updated_at: "2026-07-19T10:19:00Z",
          body: "Add durable proof.",
          label: "",
        }),
      )
      .digest("hex");
    const fallback = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-pr-delivery",
        597,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint } },
      ),
    );
    assert.deepEqual(await fallback.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#597",
      dedupe_scope: "cross_route",
    });

    const fallbackFirstFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/gogcli",
          item_number: 599,
          action: "synchronize",
          head_sha: "c".repeat(40),
          updated_at: "2026-07-19T10:21:00Z",
          body: "Fallback arrived first.",
          label: "",
        }),
      )
      .digest("hex");
    const fallbackFirst = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-first-delivery",
        599,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: fallbackFirstFingerprint } },
      ),
    );
    assert.deepEqual(await fallbackFirst.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#599",
      superseded_publications: 0,
    });
    const directSecond = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId: "direct-after-legacy-delivery",
        payload: {
          action: "synchronize",
          repository,
          pull_request: {
            number: 599,
            head: { sha: "c".repeat(40) },
            updated_at: "2026-07-19T10:21:00Z",
            body: "Fallback arrived first.",
          },
          installation: { id: 123 },
        },
      }),
      env,
    );
    assert.deepEqual(await directSecond.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#599",
      superseded_publications: 0,
    });

    const branchChangeFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/gogcli",
          item_number: 600,
          action: "synchronize",
          head_sha: "d".repeat(40),
          updated_at: "2026-07-19T10:22:00Z",
          body: "The default branch changed.",
          label: "",
        }),
      )
      .digest("hex");
    const directBeforeBranchChange = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId: "direct-old-default-branch-delivery",
        payload: {
          action: "synchronize",
          repository: { ...repository, default_branch: "old-default" },
          pull_request: {
            number: 600,
            head: { sha: "d".repeat(40) },
            updated_at: "2026-07-19T10:22:00Z",
            body: "The default branch changed.",
          },
          installation: { id: 123 },
        },
      }),
      env,
    );
    assert.deepEqual(await directBeforeBranchChange.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#600",
      superseded_publications: 0,
    });
    const fallbackAfterBranchChange = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-new-default-branch-delivery",
        600,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "new-default" },
        { ingress: { route: "target_dispatcher", fingerprint: branchChangeFingerprint } },
      ),
    );
    assert.deepEqual(await fallbackAfterBranchChange.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/gogcli#600",
      stale_source: true,
    });

    const legacyOnly = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-only-delivery",
        598,
        "synchronize",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: "b".repeat(64) } },
      ),
    );
    assert.deepEqual(await legacyOnly.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#598",
      superseded_publications: 0,
    });

    const bodyUpdate = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId: "direct-pr-body-update",
        payload: {
          action: "edited",
          repository,
          pull_request: {
            ...pullRequest,
            updated_at: "2026-07-19T10:20:00Z",
            body: "Add revised durable proof.",
          },
          installation: { id: 123 },
        },
      }),
      env,
    );
    assert.deepEqual(await bodyUpdate.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/gogcli#597",
      superseded_publications: 0,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          revision: number;
          decision: {
            sourceAction: string;
            targetBranch: string;
            sourceHeadSha?: string;
            sourceHeadVerified?: boolean;
            sourceAuthoritySeq?: number;
          };
        }
      >;
    };
    assert.equal(state.items["openclaw/gogcli#597"].revision, 2);
    assert.equal(state.items["openclaw/gogcli#597"].decision.sourceAction, "edited");
    assert.equal(state.items["openclaw/gogcli#599"].revision, 2);
    assert.equal(state.items["openclaw/gogcli#599"].decision.sourceHeadSha, "c".repeat(40));
    assert.equal(state.items["openclaw/gogcli#599"].decision.sourceHeadVerified, true);
    assert.ok(state.items["openclaw/gogcli#599"].decision.sourceAuthoritySeq);
    // A compatibility fallback may be legacy-only, but it cannot replace a
    // source-head-verified direct decision merely because its branch resolves differently.
    assert.equal(state.items["openclaw/gogcli#600"].revision, 1);
    assert.equal(state.items["openclaw/gogcli#600"].decision.targetBranch, "old-default");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook requeues unlocked and close-guard removal events", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ head: { sha: "e".repeat(40) } });
  const closeGuardLabels = [
    "security",
    "beta-blocker",
    "release-blocker",
    "maintainer",
    "clawsweeper:human-review",
    "clawsweeper:manual-only",
    "clawsweeper:automerge",
    "clawsweeper:autofix",
  ];
  const cases = [
    { event: "issues", action: "unlocked" },
    { event: "pull_request", action: "unlocked" },
    ...closeGuardLabels.flatMap((name) => [
      { event: "issues", action: "unlabeled", label: { name } },
      { event: "pull_request", action: "unlabeled", label: { name } },
    ]),
  ];
  try {
    for (const [index, { event, action, label }] of cases.entries()) {
      const number = 598 + index;
      const storage = new MemoryDurableStorage();
      const queue = new ExactReviewQueue({ storage }, {});
      const response = await worker.fetch(
        signedGithubWebhookRequest({
          event,
          secret: "test-secret",
          payload: {
            action,
            repository: {
              full_name: "openclaw/gogcli",
              default_branch: "trunk",
              private: false,
              archived: false,
              fork: false,
              has_issues: true,
            },
            ...(event === "issues"
              ? { issue: { number } }
              : { pull_request: { number, head: { sha: "e".repeat(40) } } }),
            ...(label ? { label } : {}),
            installation: { id: 123 },
          },
        }),
        {
          CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
          GITHUB_TOKEN: "test-token",
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
        },
      );

      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), {
        ok: true,
        queued: true,
        item_key: `openclaw/gogcli#${number}`,
        superseded_publications: 0,
      });
      const stored = (await storage.get("exact-review-queue")) as {
        items: Record<
          string,
          {
            decision: {
              sourceAction: string;
              supersedesInProgress: boolean;
              sourceHeadSha?: string;
            };
          }
        >;
      };
      assert.equal(stored.items[`openclaw/gogcli#${number}`].decision.sourceAction, action);
      assert.equal(stored.items[`openclaw/gogcli#${number}`].decision.supersedesInProgress, true);
      if (event === "pull_request") {
        assert.equal(
          stored.items[`openclaw/gogcli#${number}`].decision.sourceHeadSha,
          "e".repeat(40),
        );
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook ignores removal of non-close-guard labels", async () => {
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issues",
      secret: "test-secret",
      payload: {
        action: "unlabeled",
        repository: {
          full_name: "openclaw/gogcli",
          default_branch: "trunk",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 602 },
        label: { name: "clawsweeper:queueable-fix" },
        installation: { id: 123 },
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
});

test("hosted pull request receipt fast acks precede verification and stay idempotent", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  type AckComment = {
    id: number;
    body: string;
    created_at: string;
    user: { login: string };
  };
  const comments = new Map<number, AckComment[]>();
  const waitUntilPromises: Promise<unknown>[] = [];
  const fastAckPostAttempts = new Map<number, number>();
  const repository = {
    full_name: "openclaw/gogcli",
    default_branch: "trunk",
    private: false,
    archived: false,
    fork: false,
    has_issues: true,
  };
  const openedPullRequest = {
    number: 597,
    head: { sha: "a".repeat(40) },
    updated_at: "2026-08-08T12:00:00Z",
    body: "Ready for review.",
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        target_repo: "openclaw/gogcli",
        item_number: 597,
        action: "opened",
        head_sha: "a".repeat(40),
        updated_at: "2026-08-08T12:00:00Z",
        body: "Ready for review.",
        label: "",
      }),
    )
    .digest("hex");

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations/123/access_tokens") {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        repositories: ["gogcli"],
        permissions: { issues: "write", pull_requests: "write" },
      });
      return jsonResponse({ token: "target-token" });
    }
    const pullMatch = /^\/repos\/openclaw\/gogcli\/pulls\/(\d+)$/.exec(url.pathname);
    if (pullMatch) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer verification-token");
      const itemNumber = Number(pullMatch[1]);
      if (itemNumber === 599) throw new Error("transient GitHub verification failure");
      return jsonResponse({
        head: {
          sha:
            itemNumber === 597
              ? "a".repeat(40)
              : itemNumber === 598
                ? "b".repeat(40)
                : itemNumber === 600
                  ? "e".repeat(40)
                  : "f".repeat(40),
        },
      });
    }
    const commentMatch = /^\/repos\/openclaw\/gogcli\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentMatch && init?.method === "GET") {
      return jsonResponse([...(comments.get(Number(commentMatch[1])) || [])]);
    }
    if (commentMatch && init?.method === "POST") {
      const itemNumber = Number(commentMatch[1]);
      fastAckPostAttempts.set(itemNumber, (fastAckPostAttempts.get(itemNumber) || 0) + 1);
      if (itemNumber === 601) {
        return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(init.body || "{}"));
      const comment = {
        id: 9000 + itemNumber,
        body: String(body.body || ""),
        created_at: "2026-08-08T12:00:01Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      };
      comments.set(itemNumber, [...(comments.get(itemNumber) || []), comment]);
      return jsonResponse(comment);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const env = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
    GITHUB_TOKEN: "verification-token",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const context = {
    waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
  };
  const send = (deliveryId: string, action: string, pullRequest = openedPullRequest) =>
    worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId,
        payload: {
          action,
          repository,
          pull_request: pullRequest,
          installation: { id: 123 },
        },
      }),
      env,
      context,
    );

  try {
    const fallback = await queue.fetch(
      buildExactReviewQueueRequest(
        "dispatcher-opened",
        597,
        "opened",
        "pull_request",
        "openclaw/gogcli",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint } },
      ),
    );
    assert.equal((await fallback.json()).queued, true);

    assert.equal((await send("app-opened-1", "opened")).status, 202);
    assert.equal((await send("app-opened-2", "opened")).status, 202);
    assert.equal(fastAckPostAttempts.get(597), 1);
    assert.equal(comments.get(597)?.length, 1);
    assert.equal(
      comments.get(597)?.[0]?.body,
      [
        "<!-- clawsweeper-pr-ack:opened item=597 -->",
        "🦞👀",
        "ClawSweeper picked this up.",
        "",
        "Pull request received. I will update this pull request when review starts.",
      ].join("\n"),
    );
    assert.doesNotMatch(comments.get(597)?.[0]?.body || "", /clawsweeper-command-ack:/);
    assert.doesNotMatch(comments.get(597)?.[0]?.body || "", /clawsweeper-review-status:started/);
    assert.doesNotMatch(
      comments.get(597)?.[0]?.body || "",
      /^ClawSweeper status: review started\./,
    );

    assert.equal(
      (
        await send("app-synchronize", "synchronize", {
          number: 598,
          head: { sha: "b".repeat(40) },
          updated_at: "2026-08-08T12:01:00Z",
          body: "Follow-up push.",
        })
      ).status,
      202,
    );
    assert.equal(fastAckPostAttempts.has(598), false);
    assert.equal(comments.has(598), false);

    const deferred = await send("app-opened-deferred", "opened", {
      number: 599,
      head: { sha: "c".repeat(40) },
      updated_at: "2026-08-08T12:02:00Z",
      body: "Verification will be retried.",
    });
    assert.deepEqual(await deferred.json(), {
      ok: true,
      accepted: true,
      deferred: true,
      reason: "pull request head verification deferred",
    });
    assert.equal(fastAckPostAttempts.get(599), 1);
    assert.equal(comments.get(599)?.length, 1);

    const stale = await send("app-ready-stale", "ready_for_review", {
      number: 600,
      head: { sha: "d".repeat(40) },
      updated_at: "2026-08-08T12:03:00Z",
      body: "The webhook head is already stale.",
    });
    assert.deepEqual(await stale.json(), {
      ok: true,
      accepted: false,
      reason: "stale pull request head",
    });
    assert.equal(fastAckPostAttempts.get(600), 1);
    assert.equal(comments.get(600)?.length, 1);
    assert.match(comments.get(600)?.[0]?.body || "", /clawsweeper-pr-ack:ready_for_review/);

    const ackFailure = await send("app-opened-ack-failure", "opened", {
      number: 601,
      head: { sha: "f".repeat(40) },
      updated_at: "2026-08-08T12:04:00Z",
      body: "The ack write fails, but enqueue continues.",
    });
    assert.equal(ackFailure.status, 202);
    assert.equal((await ackFailure.json()).queued, true);
    assert.equal(fastAckPostAttempts.get(601), 1);
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted pull request receipts dedupe across opened and ready_for_review", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  type AckComment = {
    id: number;
    body: string;
    created_at: string;
    user: { login: string };
  };
  const comments = new Map<number, AckComment[]>();
  const waitUntilPromises: Promise<unknown>[] = [];
  const fastAckPostAttempts = new Map<number, number>();
  const deletedCommentIds: number[] = [];
  const repository = {
    full_name: "openclaw/gogcli",
    default_branch: "trunk",
    private: false,
    archived: false,
    fork: false,
    has_issues: true,
  };
  const pullRequestFastAckBody = (itemNumber: number, sourceAction: string) =>
    [
      `<!-- clawsweeper-pr-ack:${sourceAction} item=${itemNumber} -->`,
      "🦞👀",
      "ClawSweeper picked this up.",
      "",
      "Pull request received. I will update this pull request when review starts.",
    ].join("\n");

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    const pullMatch = /^\/repos\/openclaw\/gogcli\/pulls\/(\d+)$/.exec(url.pathname);
    if (pullMatch) {
      return jsonResponse({
        head: { sha: Number(pullMatch[1]) === 640 ? "9".repeat(40) : "8".repeat(40) },
      });
    }
    const commentsMatch = /^\/repos\/openclaw\/gogcli\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentsMatch && init?.method === "GET") {
      return jsonResponse([...(comments.get(Number(commentsMatch[1])) || [])]);
    }
    if (commentsMatch && init?.method === "POST") {
      const itemNumber = Number(commentsMatch[1]);
      fastAckPostAttempts.set(itemNumber, (fastAckPostAttempts.get(itemNumber) || 0) + 1);
      const body = JSON.parse(String(init.body || "{}"));
      const comment = {
        id: 9000 + itemNumber + (comments.get(itemNumber)?.length || 0),
        body: String(body.body || ""),
        created_at: "2026-08-09T12:00:01Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      };
      comments.set(itemNumber, [...(comments.get(itemNumber) || []), comment]);
      return jsonResponse(comment);
    }
    const deleteMatch = /^\/repos\/openclaw\/gogcli\/issues\/comments\/(\d+)$/.exec(url.pathname);
    if (deleteMatch && init?.method === "DELETE") {
      const commentId = Number(deleteMatch[1]);
      deletedCommentIds.push(commentId);
      for (const [itemNumber, list] of comments) {
        comments.set(
          itemNumber,
          list.filter((comment) => comment.id !== commentId),
        );
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const env = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
    GITHUB_TOKEN: "verification-token",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const context = {
    waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
  };
  const send = (
    deliveryId: string,
    action: string,
    pullRequest: { number: number; head: { sha: string }; updated_at: string; body: string },
  ) =>
    worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId,
        payload: {
          action,
          repository,
          pull_request: pullRequest,
          installation: { id: 123 },
        },
      }),
      env,
      context,
    );

  try {
    // A ready_for_review arriving seconds after opened must reuse the opened
    // receipt instead of posting a second, action-suffixed duplicate.
    const opened = {
      number: 640,
      head: { sha: "9".repeat(40) },
      updated_at: "2026-08-09T12:00:00Z",
      body: "Opened, then marked ready seconds later.",
    };
    assert.equal((await send("pr-ack-dual-opened", "opened", opened)).status, 202);
    assert.equal(fastAckPostAttempts.get(640), 1);
    assert.equal(
      (
        await send("pr-ack-dual-ready", "ready_for_review", {
          ...opened,
          updated_at: "2026-08-09T12:00:05Z",
        })
      ).status,
      202,
    );
    assert.equal(fastAckPostAttempts.get(640), 1);
    assert.equal(comments.get(640)?.length, 1);
    assert.match(comments.get(640)?.[0]?.body || "", /clawsweeper-pr-ack:opened item=640/);

    // A pair that already slipped through settles down to the earliest receipt.
    comments.set(641, [
      {
        id: 9100,
        body: pullRequestFastAckBody(641, "opened"),
        created_at: "2026-08-09T12:01:01Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      },
      {
        id: 9101,
        body: pullRequestFastAckBody(641, "ready_for_review"),
        created_at: "2026-08-09T12:01:03Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      },
    ]);
    assert.equal(
      (
        await send("pr-ack-settle-ready", "ready_for_review", {
          number: 641,
          head: { sha: "8".repeat(40) },
          updated_at: "2026-08-09T12:01:10Z",
          body: "Duplicate receipts already exist.",
        })
      ).status,
      202,
    );
    assert.equal(fastAckPostAttempts.has(641), false);
    assert.deepEqual(deletedCommentIds, [9101]);
    assert.equal(comments.get(641)?.length, 1);
    assert.equal(comments.get(641)?.[0]?.id, 9100);
    assert.match(comments.get(641)?.[0]?.body || "", /clawsweeper-pr-ack:opened item=641/);
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
            body: "@clawsweeper review",
            updated_at: "2026-07-12T20:00:00Z",
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
        STATUS_STORE: new MemoryKv(),
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
        source_action: "created",
        source_delivery_id: "test-delivery",
        comment_event_auth: "github_webhook_v1",
        comment_updated_at: "2026-07-12T20:00:00Z",
        comment_body_sha256: createHash("sha256").update("@clawsweeper review").digest("hex"),
      },
    });
    assert.ok(
      Object.keys((dispatchBody as { client_payload: Record<string, unknown> }).client_payload)
        .length <= 10,
    );
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
    assert.equal(
      comments[0]?.body,
      [
        "<!-- clawsweeper-command-ack:456 -->",
        "🦞👀",
        "ClawSweeper picked this up.",
        "",
        "Command router queued. I will update this comment with the next step.",
      ].join("\n"),
    );
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
      },
    });
    assert.ok(
      Object.keys((dispatchBody as { client_payload: Record<string, unknown> }).client_payload)
        .length <= 10,
    );
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
