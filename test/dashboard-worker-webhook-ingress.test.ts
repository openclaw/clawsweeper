import {
  assert,
  createHash,
  generateKeyPairSync,
  test,
  worker,
  ExactReviewQueue,
  ExactReviewLifecycleProjectionStore,
  MemoryKv,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  lifecycleState,
  jsonResponse,
  signedGithubWebhookRequest,
  signedGithubWebhookBodyRequest,
  createExactReviewAdmissionHarness,
  buildExactReviewQueueRequest,
  leasedExactReviewQueueItem,
} from "./dashboard-worker-harness.ts";

const publicHostedTargetProbe = async () => "public" as const;

function sqlRowCount(storage: MemoryDurableStorage, table: string) {
  return Number(Array.from(storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`))[0]?.count);
}

test("hosted webhook rejects an outside-owner public target before probe, queue, token, or ack", async () => {
  let visibilityProbes = 0;
  let queueCalls = 0;
  let waits = 0;
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "created",
        repository: {
          full_name: "outside/public-repo",
          default_branch: "main",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 42, state: "open", user: { login: "maintainer" } },
        installation: { id: 123 },
        comment: {
          id: 456,
          body: "@clawsweeper re-review",
          author_association: "MEMBER",
          user: { login: "maintainer" },
          updated_at: "2026-08-29T00:00:00Z",
        },
      },
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      hostedTargetPredicate: () => false,
      hostedPublicTargetProbe: async () => {
        visibilityProbes += 1;
        return "public";
      },
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
        fetch() {
          queueCalls += 1;
          return Response.json({ ok: true });
        },
      }),
    },
    {
      waitUntil() {
        waits += 1;
      },
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "target not eligible",
  });
  assert.equal(visibilityProbes, 0);
  assert.equal(queueCalls, 0);
  assert.equal(waits, 0);
});

test("configured external-owner webhook reaches exact-review intake", async () => {
  const queueRequests: Array<{ path: string; body: unknown }> = [];
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issues",
      secret: "test-secret",
      payload: {
        action: "opened",
        repository: {
          full_name: "partner/configured-repo",
          default_branch: "main",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 43 },
        installation: { id: 123 },
      },
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      hostedTargetPredicate: undefined,
      hostedTargetConfiguredRepositories: ["partner/configured-repo"],
      hostedPublicTargetProbe: publicHostedTargetProbe,
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
        async fetch(request: Request) {
          queueRequests.push({
            path: new URL(request.url).pathname,
            body: await request.json(),
          });
          return Response.json({
            ok: true,
            queued: true,
            item_key: "partner/configured-repo#43",
            superseded_publications: 0,
          });
        },
      }),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    item_key: "partner/configured-repo#43",
    superseded_publications: 0,
  });
  const enqueue = queueRequests.find((request) => request.path === "/enqueue");
  assert.ok(enqueue);
  assert.equal(
    (enqueue.body as { decision?: { targetRepo?: string } }).decision?.targetRepo ?? "",
    "partner/configured-repo",
  );
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
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        hostedPublicTargetProbe: publicHostedTargetProbe,
      },
    );
    assert.equal(response.status, 503, `${body} should pass classification before app config`);
    assert.deepEqual(await response.json(), { error: "github_app_not_configured" });
  }
});

test("hosted webhook materializes inline mentions without routing a command", async () => {
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
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      hostedPublicTargetProbe: publicHostedTargetProbe,
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: true,
    materialized: false,
    event: "issue_comment",
    action: "created",
  });
});

test("hosted webhook returns invalid_json for signed malformed bodies", async () => {
  const response = await worker.fetch(
    signedGithubWebhookBodyRequest({
      event: "issue_comment",
      secret: "test-secret",
      body: "{",
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      hostedPublicTargetProbe: publicHostedTargetProbe,
    },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

test("hosted webhook materializes label additions without exact-review intake", async () => {
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
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        hostedPublicTargetProbe: publicHostedTargetProbe,
      },
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: true,
      materialized: false,
      event: "issues",
      action: "labeled",
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
          full_name: "openclaw/fs-safe",
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
      hostedPublicTargetProbe: publicHostedTargetProbe,
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queueStub),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/fs-safe#597",
    superseded_publications: 0,
  });
  assert.equal(authorityCompletionCalls, 0);
});

test("hosted pull request private transition stops before queue and target credentials", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalError = console.error;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const metadataToken = "worker-central-metadata-token";
  const consoleCalls: unknown[][] = [];
  let queueCalls = 0;
  let statusCalls = 0;
  let metadataMints = 0;
  let targetMints = 0;
  let metadataRequest: RequestInit | undefined;
  console.warn = (...args) => consoleCalls.push(args);
  console.error = (...args) => consoleCalls.push(args);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      metadataMints += 1;
      const body = JSON.parse(String(init?.body)) as {
        repositories?: string[];
        permissions?: Record<string, string>;
      };
      assert.deepEqual(body.repositories, ["clawsweeper"]);
      assert.deepEqual(body.permissions, { metadata: "read" });
      return jsonResponse({ token: metadataToken });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      targetMints += 1;
      return jsonResponse({ token: "forbidden-target-token" });
    }
    if (url.pathname === "/repos/openclaw/fs-safe") {
      metadataRequest = init;
      return Response.json({}, { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "test-secret",
        deliveryId: "private-transition-zero-persistence",
        payload: {
          action: "opened",
          repository: {
            full_name: "openclaw/fs-safe",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          pull_request: {
            number: 598,
            head: { sha: "a".repeat(40) },
            updated_at: "2026-08-27T12:00:00Z",
          },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        GITHUB_TOKEN: "must-not-drive-hosted-target-admission",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
          fetch: async () => {
            queueCalls += 1;
            return jsonResponse({ ok: true });
          },
        }),
        STATUS_STORE: new MemoryDurableNamespace({
          fetch: async () => {
            statusCalls += 1;
            return jsonResponse({ ok: true });
          },
        }),
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: false,
      reason: "private target unsupported",
    });
    assert.equal(metadataMints, 1);
    assert.equal(targetMints, 0);
    assert.equal(queueCalls, 0);
    assert.equal(statusCalls, 0);
    assert.equal(metadataRequest?.cache, "no-store");
    assert.equal(metadataRequest?.redirect, "manual");
    const headers = new Headers(metadataRequest?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${metadataToken}`);
    assert.equal(headers.get("cache-control"), "no-store");
    assert.doesNotMatch(JSON.stringify(consoleCalls), new RegExp(metadataToken));
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test("hosted pull request reservation rechecks visibility before durable authority", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const admission of ["terminal", "retryable"] as const) {
      const storage = new MemoryDurableStorage();
      let visibilityProbes = 0;
      let sourceAuthorityCalls = 0;
      let targetCredentialCalls = 0;
      const hostedPublicTargetProbe = async () => {
        visibilityProbes += 1;
        return visibilityProbes === 1 ? ("public" as const) : admission;
      };
      const queue = new ExactReviewQueue(
        { storage },
        {
          hostedPublicTargetProbe,
        },
      );
      globalThis.fetch = async () => {
        targetCredentialCalls += 1;
        throw new Error("target credential request must not occur");
      };

      const deliveryId = `reservation-transition-${admission}`;
      const response = await worker.fetch(
        signedGithubWebhookRequest({
          event: "pull_request",
          secret: "test-secret",
          deliveryId,
          payload: {
            action: "opened",
            repository: {
              full_name: "openclaw/fs-safe",
              default_branch: "trunk",
              private: false,
              archived: false,
              fork: false,
              has_issues: true,
            },
            pull_request: {
              number: admission === "terminal" ? 599 : 600,
              head: { sha: "a".repeat(40) },
              updated_at: "2026-08-29T12:00:00Z",
            },
            installation: { id: 123 },
          },
        }),
        {
          CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
          hostedPublicTargetProbe,
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
            fetch: (request: Request) => {
              if (new URL(request.url).pathname === "/source-authority") {
                sourceAuthorityCalls += 1;
              }
              return queue.fetch(request);
            },
          }),
        },
      );

      assert.equal(response.status, admission === "terminal" ? 202 : 503);
      assert.deepEqual(
        await response.json(),
        admission === "terminal"
          ? { ok: true, accepted: false, reason: "private target unsupported" }
          : { error: "target_visibility_unverified", retryable: true },
      );
      assert.equal(visibilityProbes, 2);
      assert.equal(sourceAuthorityCalls, 1);
      assert.equal(targetCredentialCalls, 0);
      assert.equal(
        storage.rawHas(
          `exact-review-source-authority-reservation:v1:${encodeURIComponent(deliveryId)}`,
        ),
        false,
      );
      assert.equal(storage.rawHas("exact-review-source-authority-sequence:v1"), false);
      assert.equal(await storage.getAlarm(), null);
      assert.equal(sqlRowCount(storage, "exact_review_queue_deliveries"), 0);
      assert.equal(sqlRowCount(storage, "exact_review_queue_items"), 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook preserves central metadata mint backoff without persistence", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  try {
    for (const failure of ["retry-after", "reset"] as const) {
      let queueCalls = 0;
      const resetAt = Date.now() + 90_000;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
          return jsonResponse({ id: 999 });
        }
        if (url.pathname === "/app/installations/999/access_tokens") {
          assert.deepEqual(JSON.parse(String(init?.body)), {
            repositories: ["clawsweeper"],
            permissions: { metadata: "read" },
          });
          return failure === "retry-after"
            ? Response.json(
                {},
                {
                  status: 429,
                  headers: { "retry-after": "120" },
                },
              )
            : Response.json(
                {},
                {
                  status: 403,
                  headers: {
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset": String(Math.ceil(resetAt / 1_000)),
                  },
                },
              );
        }
        throw new Error(`unexpected GitHub request: ${url.pathname}`);
      };

      const response = await worker.fetch(
        signedGithubWebhookRequest({
          event: "workflow_run",
          secret: "test-secret",
          deliveryId: `central-mint-${failure}`,
          payload: {
            action: "completed",
            repository: {
              full_name: "openclaw/fs-safe",
              default_branch: "trunk",
              private: false,
              archived: false,
              fork: false,
              has_issues: true,
            },
            workflow_run: {
              id: 8090,
              updated_at: "2026-08-27T12:00:00Z",
            },
          },
        }),
        {
          CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
          CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
          CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
            fetch: async () => {
              queueCalls += 1;
              return jsonResponse({ ok: true });
            },
          }),
        },
      );

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "target_visibility_unverified",
        retryable: true,
      });
      const retryAfter = Number(response.headers.get("retry-after"));
      if (failure === "retry-after") {
        assert.ok(retryAfter >= 119 && retryAfter <= 120);
      } else {
        assert.ok(retryAfter >= 89 && retryAfter <= 91);
      }
      assert.equal(queueCalls, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("matching bot lifecycle receipts persist only after hosted admission", async () => {
  const cases = [
    {
      name: "allowed review",
      intent: "re_review",
      itemNumber: 610,
      admissions: ["public", "public"],
      status: 202,
      response: {
        ok: true,
        accepted: false,
        reason: "recorded Bay journey completion",
      },
      lifecycle: "completed",
      bayPersisted: true,
      finalizerRetained: false,
    },
    {
      name: "allowed automerge",
      intent: "automerge",
      itemNumber: 611,
      admissions: ["public", "public"],
      status: 202,
      response: {
        ok: true,
        accepted: false,
        reason: "recorded lifecycle acknowledgement",
      },
      lifecycle: "completed",
      bayPersisted: false,
      finalizerRetained: false,
    },
    {
      name: "allowed mixed-generation legacy review",
      intent: "re_review",
      itemNumber: 614,
      commandCommentId: 5_290_152_372,
      commandUpdatedAt: "2026-08-14T06:17:22Z",
      admissions: ["public", "public"],
      status: 202,
      response: {
        ok: true,
        accepted: false,
        reason: "recorded Bay journey completion",
      },
      lifecycle: "completed",
      bayPersisted: true,
      finalizerRetained: false,
    },
    {
      name: "terminal private",
      intent: "re_review",
      itemNumber: 612,
      admissions: ["public", "terminal"],
      status: 202,
      response: {
        ok: true,
        accepted: false,
        reason: "private target unsupported",
      },
      lifecycle: "acknowledgement_pending",
      bayPersisted: false,
      finalizerRetained: false,
    },
    {
      name: "retryable visibility",
      intent: "re_review",
      itemNumber: 613,
      admissions: ["public", "retryable"],
      status: 503,
      response: {
        error: "target_visibility_unverified",
        retryable: true,
      },
      lifecycle: "acknowledgement_pending",
      bayPersisted: false,
      finalizerRetained: true,
    },
  ] as const;

  for (const entry of cases) {
    const { intent, itemNumber } = entry;
    const storage = new MemoryDurableStorage();
    let visibilityProbes = 0;
    const hostedPublicTargetProbe = async () => {
      const outcome = entry.admissions[Math.min(visibilityProbes, entry.admissions.length - 1)]!;
      visibilityProbes += 1;
      return outcome;
    };
    const queue = new ExactReviewQueue(
      { storage },
      {
        hostedTargetPredicate: () => true,
        hostedPublicTargetProbe,
      },
    );
    const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
    const commandCommentId =
      "commandCommentId" in entry ? entry.commandCommentId : itemNumber + 2_000;
    const marker =
      "commandUpdatedAt" in entry
        ? `<!-- clawsweeper-command-status:${itemNumber}:${intent}:command-${commandCommentId}-${Date.parse(entry.commandUpdatedAt).toString(36)}-${"1".repeat(64)} -->`
        : `<!-- clawsweeper-command-status:${itemNumber}:${intent}:head -->`;
    const identity = {
      canonicalTargetKey: `openclaw/openclaw#${itemNumber}`,
      fenceKey: `openclaw/openclaw#${itemNumber}@exact`,
      revision: 1,
    };
    lifecycle.recordAdmission({
      ...identity,
      deliveryId: `lifecycle-outage:${intent}`,
      sourceAction: intent,
      commandOriginated: true,
      statusMarker: marker,
      statusCommentId: itemNumber + 1_000,
      observedAt: Date.now(),
    });
    lifecycle.recordCanonicalReceipt({
      ...identity,
      outcome: "accepted",
      receiptId: `lifecycle-outage:${intent}:canonical`,
      observedAt: Date.now() + 1,
    });
    const routerReceipt = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/lifecycle/router-receipt", {
        method: "POST",
        body: JSON.stringify({
          canonical_target_key: identity.canonicalTargetKey,
          fence_key: identity.fenceKey,
          revision: identity.revision,
          outcome: "durable",
          receipt_id: `lifecycle-outage:${intent}:router`,
        }),
      }),
    );
    assert.equal(routerReceipt.status, 200);
    lifecycle.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: marker,
      statusCommentId: itemNumber + 1_000,
      observedAt: Date.now() + 4,
    });
    assert.equal(
      lifecycleState(lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, 1)!),
      "acknowledgement_pending",
    );
    let acknowledgementRequests = 0;
    const statusStore = new MemoryKv();
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "lifecycle-outage-secret",
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
            id: itemNumber + 1_000,
            body: [
              marker,
              ...("commandUpdatedAt" in entry
                ? [
                    `<!-- clawsweeper-command:${commandCommentId}:${entry.commandUpdatedAt}:${intent}:${"8".repeat(40)} -->`,
                  ]
                : [`<!-- clawsweeper-command-ack:${commandCommentId} -->`]),
              "<!-- clawsweeper-command-progress:start -->",
              "- State: Complete",
              "<!-- clawsweeper-command-progress:end -->",
            ].join("\n"),
            created_at: "2026-08-29T00:00:00.000Z",
            updated_at: "2026-08-29T00:01:00.000Z",
            user: { login: "clawsweeper[bot]" },
          },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "lifecycle-outage-secret",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
          async fetch(request: Request) {
            if (new URL(request.url).pathname === "/lifecycle/command-ack/observed") {
              acknowledgementRequests += 1;
            }
            return queue.fetch(request);
          },
        }),
        STATUS_STORE: statusStore,
        hostedTargetPredicate: () => true,
        hostedPublicTargetProbe,
      },
    );

    const responseBody = await response.json();
    const resultingLifecycle = lifecycleState(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, 1)!,
    );
    const bayPersisted = (await statusStore.get("openclaw-bay:journey-state:v1")) !== null;
    const finalizerKey = `terminal-finalization:${identity.fenceKey}:${identity.revision}`;
    const queueState = storage.sql.readNormalizedQueue() as {
      items: Record<string, unknown>;
    };
    const finalizerRetained = queueState.items[finalizerKey] !== undefined;
    const finalAdmission = entry.admissions.at(-1)!;
    console.log(
      JSON.stringify({
        event: "hosted_ack_authority_trace",
        path: entry.name,
        eligibility: "accepted",
        visibility: finalAdmission === "terminal" ? "private" : finalAdmission,
        admission_outcome: finalAdmission,
        visibility_probes: visibilityProbes,
        acknowledgement_requests: acknowledgementRequests,
        acknowledgement_persisted: resultingLifecycle === "completed",
        bay_persisted: bayPersisted,
        finalizer_retained: finalizerRetained,
        lifecycle_state: resultingLifecycle,
      }),
    );
    assert.equal(response.status, entry.status, entry.name);
    assert.deepEqual(responseBody, entry.response, entry.name);
    assert.equal(visibilityProbes, 2, entry.name);
    assert.equal(acknowledgementRequests, 1, entry.name);
    assert.equal(resultingLifecycle, entry.lifecycle, entry.name);
    assert.equal(bayPersisted, entry.bayPersisted, entry.name);
    assert.equal(finalizerRetained, entry.finalizerRetained, entry.name);
  }
});

test("untrusted or unmatched webhook activity remains behind hosted admission", async () => {
  const completionBody = [
    "<!-- clawsweeper-command-ack:900 -->",
    "<!-- clawsweeper-command-status:612:re_review:head -->",
    "<!-- clawsweeper-command-progress:start -->",
    "- State: Complete",
    "<!-- clawsweeper-command-progress:end -->",
  ].join("\n");
  const cases = [
    {
      name: "human command",
      event: "issue_comment",
      payload: {
        action: "created",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 612 },
        installation: { id: 123 },
        comment: {
          id: 900,
          body: "@clawsweeper review",
          author_association: "MEMBER",
          user: { login: "maintainer" },
        },
      },
      expectedQueueCalls: 0,
    },
    {
      name: "non-bot receipt spoof",
      event: "issue_comment",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 612 },
        comment: {
          id: 901,
          body: completionBody,
          created_at: "2026-08-29T00:00:00.000Z",
          updated_at: "2026-08-29T00:01:00.000Z",
          user: { login: "contributor" },
        },
      },
      expectedQueueCalls: 0,
    },
    {
      name: "unmatched bot receipt",
      event: "issue_comment",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 612 },
        comment: {
          id: 902,
          body: completionBody,
          created_at: "2026-08-29T00:00:00.000Z",
          updated_at: "2026-08-29T00:01:00.000Z",
          user: { login: "clawsweeper[bot]" },
        },
      },
      expectedQueueCalls: 0,
    },
    {
      name: "new activity",
      event: "workflow_run",
      payload: {
        action: "completed",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
      },
      expectedQueueCalls: 0,
    },
  ] as const;

  for (const entry of cases) {
    let admissionCalls = 0;
    let queueCalls = 0;
    let statusCalls = 0;
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: entry.event,
        secret: "gated-receipt-secret",
        payload: entry.payload,
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "gated-receipt-secret",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
          fetch: async () => {
            queueCalls += 1;
            return jsonResponse({ accepted: false });
          },
        }),
        STATUS_STORE: {
          get: async () => {
            statusCalls += 1;
            return null;
          },
          put: async () => {
            statusCalls += 1;
          },
        },
        hostedPublicTargetProbe: async () => {
          admissionCalls += 1;
          return "retryable" as const;
        },
      },
    );

    assert.equal(response.status, 503, entry.name);
    assert.deepEqual(
      await response.json(),
      { error: "target_visibility_unverified", retryable: true },
      entry.name,
    );
    assert.equal(admissionCalls, 1, entry.name);
    assert.equal(queueCalls, entry.expectedQueueCalls, entry.name);
    assert.equal(statusCalls, 0, entry.name);
  }
});

test("invalid webhook signatures cannot use the lifecycle receipt bypass", async () => {
  let admissionCalls = 0;
  let queueCalls = 0;
  const signed = signedGithubWebhookRequest({
    event: "issue_comment",
    secret: "real-secret",
    payload: {
      action: "edited",
      repository: {
        full_name: "openclaw/openclaw",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 613 },
      comment: {
        id: 901,
        body: [
          "<!-- clawsweeper-command-ack:900 -->",
          "<!-- clawsweeper-command-status:613:re_review:head -->",
          "<!-- clawsweeper-command-progress:start -->",
          "- State: Complete",
          "<!-- clawsweeper-command-progress:end -->",
        ].join("\n"),
        created_at: "2026-08-29T00:00:00.000Z",
        updated_at: "2026-08-29T00:01:00.000Z",
        user: { login: "clawsweeper[bot]" },
      },
    },
  });
  const response = await worker.fetch(
    new Request(signed, {
      headers: { ...Object.fromEntries(signed.headers), "x-hub-signature-256": "sha256=invalid" },
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "real-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
        fetch: async () => {
          queueCalls += 1;
          return jsonResponse({ accepted: true });
        },
      }),
      hostedPublicTargetProbe: async () => {
        admissionCalls += 1;
        return "public" as const;
      },
    },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_signature" });
  assert.equal(queueCalls, 0);
  assert.equal(admissionCalls, 0);
});

test("hosted edited webhook binds and enqueues only the live pull request head", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const now = 3_000_000;
  Date.now = () => now;
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    { hostedPublicTargetProbe: publicHostedTargetProbe },
  );
  const staleHeadSha = "a".repeat(40);
  const sourceHeadSha = "b".repeat(40);
  const sourceContentRevision = createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        title: "Document the edit",
        body: "Fresh review context.",
        locked: false,
        close_guard_labels: [],
      }),
    )
    .digest("hex");
  let verificationCalls = 0;
  globalThis.fetch = async (input) => {
    verificationCalls += 1;
    assert.equal(String(input), "https://api.github.com/repos/openclaw/fs-safe/pulls/596");
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
            full_name: "openclaw/fs-safe",
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
            locked: false,
            labels: [],
            updated_at: updatedAt,
          },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        GITHUB_TOKEN: "test-token",
        hostedPublicTargetProbe: publicHostedTargetProbe,
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
      item_key: "openclaw/fs-safe#596",
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
      item_key: "openclaw/fs-safe#596",
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
    assert.deepEqual(stored.items["openclaw/fs-safe#596"].decision, {
      targetRepo: "openclaw/fs-safe",
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

test("hosted issue webhook preserves the source update discriminator", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    { hostedPublicTargetProbe: publicHostedTargetProbe },
  );
  const send = (updatedAt: string, deliveryId: string) =>
    worker.fetch(
      signedGithubWebhookRequest({
        event: "issues",
        secret: "test-secret",
        deliveryId,
        payload: {
          action: "edited",
          repository: {
            full_name: "openclaw/fs-safe",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: {
            number: 597,
            title: "Retry fence",
            body: `Body at ${updatedAt}`,
            locked: false,
            labels: [],
            updated_at: updatedAt,
          },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        hostedPublicTargetProbe: publicHostedTargetProbe,
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );

  const first = await send("2026-09-02T19:00:00Z", "issue-edited-597-1");
  assert.equal(first.status, 202);
  let state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { decision: { sourceUpdatedAt?: string; sourceContentRevision?: string } }
    >;
  };
  assert.equal(
    state.items["openclaw/fs-safe#597"].decision.sourceUpdatedAt,
    "2026-09-02T19:00:00Z",
  );
  assert.equal(
    state.items["openclaw/fs-safe#597"].decision.sourceContentRevision,
    createHash("sha256")
      .update(
        JSON.stringify({
          version: 2,
          title: "Retry fence",
          body: "Body at 2026-09-02T19:00:00Z",
          locked: false,
          close_guard_labels: [],
        }),
      )
      .digest("hex"),
  );

  const second = await send("2026-09-02T19:05:00Z", "issue-edited-597-2");
  assert.equal(second.status, 202);
  state = (await storage.get("exact-review-queue")) as typeof state;
  assert.equal(
    state.items["openclaw/fs-safe#597"].decision.sourceUpdatedAt,
    "2026-09-02T19:05:00Z",
  );
});

test("hosted lifecycle webhooks distinguish close-guard state with unchanged content", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    { hostedPublicTargetProbe: publicHostedTargetProbe },
  );
  const send = (deliveryId: string, removedLabel: string, labels: string[], updatedAt: string) =>
    worker.fetch(
      signedGithubWebhookRequest({
        event: "issues",
        secret: "test-secret",
        deliveryId,
        payload: {
          action: "unlabeled",
          repository: {
            full_name: "openclaw/fs-safe",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: {
            number: 598,
            title: "Retry fence",
            body: "Unchanged body",
            locked: false,
            labels: labels.map((name) => ({ name })),
            updated_at: updatedAt,
          },
          label: { name: removedLabel },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        hostedPublicTargetProbe: publicHostedTargetProbe,
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );

  assert.equal(
    (await send("issue-unlabeled-598-1", "beta-blocker", ["security"], "2026-09-02T19:00:00Z"))
      .status,
    202,
  );
  let state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceContentRevision?: string } }>;
  };
  const firstRevision = state.items["openclaw/fs-safe#598"].decision.sourceContentRevision;
  assert.match(firstRevision || "", /^[0-9a-f]{64}$/);

  assert.equal(
    (await send("issue-unlabeled-598-2", "security", [], "2026-09-02T19:05:00Z")).status,
    202,
  );
  state = (await storage.get("exact-review-queue")) as typeof state;
  assert.notEqual(
    state.items["openclaw/fs-safe#598"].decision.sourceContentRevision,
    firstRevision,
  );
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
    hostedPublicTargetProbe: publicHostedTargetProbe,
  };
  const queue = new ExactReviewQueue({ storage }, queueEnv);
  let verificationFailures = 2;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/fs-safe/pulls/595") {
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
            full_name: "openclaw/fs-safe",
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
        hostedPublicTargetProbe: publicHostedTargetProbe,
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
          target_repo: "openclaw/fs-safe",
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
        "openclaw/fs-safe",
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
    assert.equal(stored.items["openclaw/fs-safe#595"].revision, 2);
    assert.equal(stored.items["openclaw/fs-safe#595"].decision.sourceHeadSha, sourceHeadSha);
    assert.equal(stored.items["openclaw/fs-safe#595"].decision.sourceHeadVerified, true);
    assert.equal(stored.items["openclaw/fs-safe#595"].decision.sourceAuthoritySeq, 1);
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
    items: { "openclaw/fs-safe#594": existing },
  });
  const queue = new ExactReviewQueue(
    { storage },
    { hostedPublicTargetProbe: publicHostedTargetProbe },
  );
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://api.github.com/repos/openclaw/fs-safe/pulls/594");
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
            full_name: "openclaw/fs-safe",
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
        hostedPublicTargetProbe: publicHostedTargetProbe,
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );
    assert.equal(response.status, 202);
    const stored = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string; sourceHeadSha?: string } }>;
    };
    assert.equal(stored.items["openclaw/fs-safe#594"].decision.sourceAction, "reopened");
    assert.equal(stored.items["openclaw/fs-safe#594"].decision.sourceHeadSha, sourceHeadSha);
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
        "openclaw/fs-safe",
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
    const item = dispatched.items["openclaw/fs-safe#601"];
    assert.ok(item);
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/fs-safe#601",
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
          item_key: "openclaw/fs-safe#601",
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
        "openclaw/fs-safe",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint } },
      ),
    );
    assert.deepEqual(await fallback.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/fs-safe#601",
      dedupe_scope: "cross_route",
    });
    const afterFallback = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(afterFallback.items["openclaw/fs-safe#601"], undefined);
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
  const queue = new ExactReviewQueue(
    { storage },
    { hostedPublicTargetProbe: publicHostedTargetProbe },
  );

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
      "openclaw/fs-safe",
      { targetBranch: "trunk" },
      { ingress: { route: "target_dispatcher", fingerprint: "f".repeat(64) } },
    ),
  );
  assert.deepEqual(await delayedFallback.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/fs-safe#601",
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
      "openclaw/fs-safe",
      { targetBranch: "trunk" },
      { ingress: { route: "target_dispatcher", fingerprint: "9".repeat(64) } },
    ),
  );
  assert.deepEqual(await delayedFallback.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/fs-safe#605",
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
        "openclaw/fs-safe",
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
        "openclaw/fs-safe",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: secondFingerprint } },
      ),
    );
    assert.deepEqual(await staleFallback.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/fs-safe#602",
      stale_source: true,
    });

    await harness.queue.alarm();
    const dispatched = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const item = dispatched.items["openclaw/fs-safe#602"];
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/fs-safe#602",
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
          item_key: "openclaw/fs-safe#602",
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
        "openclaw/fs-safe",
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
    assert.equal(afterDirect.items["openclaw/fs-safe#602"].decision.sourceAction, "edited");
    assert.equal(afterDirect.items["openclaw/fs-safe#602"].decision.sourceHeadSha, secondHeadSha);
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
        "openclaw/fs-safe",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: firstFingerprint } },
      ),
    );
    await harness.queue.alarm();
    const dispatched = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const item = dispatched.items["openclaw/fs-safe#603"];
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: "openclaw/fs-safe#603",
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
          item_key: "openclaw/fs-safe#603",
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
        "openclaw/fs-safe",
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
        "openclaw/fs-safe",
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
      item_key: "openclaw/fs-safe#603",
      dedupe_scope: "cross_route",
    });
    const afterDelayed = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string } }>;
    };
    assert.equal(afterDelayed.items["openclaw/fs-safe#603"].decision.sourceAction, "edited");
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
        "openclaw/fs-safe",
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
        "openclaw/fs-safe",
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
        "openclaw/fs-safe",
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
      item_key: "openclaw/fs-safe#604",
      dedupe_scope: "cross_route",
    });
    const afterDelayed = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string }; ingressFingerprint?: string }>;
    };
    assert.equal(afterDelayed.items["openclaw/fs-safe#604"].decision.sourceAction, "edited");
    assert.equal(afterDelayed.items["openclaw/fs-safe#604"].ingressFingerprint, undefined);
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
    hostedPublicTargetProbe: publicHostedTargetProbe,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const repository = {
    full_name: "openclaw/fs-safe",
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
    const match = url.pathname.match(/^\/repos\/openclaw\/fs-safe\/pulls\/(\d+)$/);
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
      item_key: "openclaw/fs-safe#597",
      superseded_publications: 0,
    });
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/fs-safe",
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
        "openclaw/fs-safe",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint } },
      ),
    );
    assert.deepEqual(await fallback.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/fs-safe#597",
      dedupe_scope: "cross_route",
    });

    const fallbackFirstFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/fs-safe",
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
        "openclaw/fs-safe",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: fallbackFirstFingerprint } },
      ),
    );
    assert.deepEqual(await fallbackFirst.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/fs-safe#599",
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
      item_key: "openclaw/fs-safe#599",
      superseded_publications: 0,
    });

    const branchChangeFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/fs-safe",
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
      item_key: "openclaw/fs-safe#600",
      superseded_publications: 0,
    });
    const fallbackAfterBranchChange = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-new-default-branch-delivery",
        600,
        "synchronize",
        "pull_request",
        "openclaw/fs-safe",
        { targetBranch: "new-default" },
        { ingress: { route: "target_dispatcher", fingerprint: branchChangeFingerprint } },
      ),
    );
    assert.deepEqual(await fallbackAfterBranchChange.json(), {
      ok: true,
      deduped: true,
      item_key: "openclaw/fs-safe#600",
      stale_source: true,
    });

    const legacyOnly = await queue.fetch(
      buildExactReviewQueueRequest(
        "legacy-only-delivery",
        598,
        "synchronize",
        "pull_request",
        "openclaw/fs-safe",
        { targetBranch: "trunk" },
        { ingress: { route: "target_dispatcher", fingerprint: "b".repeat(64) } },
      ),
    );
    assert.deepEqual(await legacyOnly.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/fs-safe#598",
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
      item_key: "openclaw/fs-safe#597",
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
    assert.equal(state.items["openclaw/fs-safe#597"].revision, 2);
    assert.equal(state.items["openclaw/fs-safe#597"].decision.sourceAction, "edited");
    assert.equal(state.items["openclaw/fs-safe#599"].revision, 2);
    assert.equal(state.items["openclaw/fs-safe#599"].decision.sourceHeadSha, "c".repeat(40));
    assert.equal(state.items["openclaw/fs-safe#599"].decision.sourceHeadVerified, true);
    assert.ok(state.items["openclaw/fs-safe#599"].decision.sourceAuthoritySeq);
    // A compatibility fallback may be legacy-only, but it cannot replace a
    // source-head-verified direct decision merely because its branch resolves differently.
    assert.equal(state.items["openclaw/fs-safe#600"].revision, 1);
    assert.equal(state.items["openclaw/fs-safe#600"].decision.targetBranch, "old-default");
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
      const queue = new ExactReviewQueue(
        { storage },
        { hostedPublicTargetProbe: publicHostedTargetProbe },
      );
      const response = await worker.fetch(
        signedGithubWebhookRequest({
          event,
          secret: "test-secret",
          payload: {
            action,
            repository: {
              full_name: "openclaw/fs-safe",
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
          hostedPublicTargetProbe: publicHostedTargetProbe,
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
        },
      );

      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), {
        ok: true,
        queued: true,
        item_key: `openclaw/fs-safe#${number}`,
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
      assert.equal(stored.items[`openclaw/fs-safe#${number}`].decision.sourceAction, action);
      assert.equal(stored.items[`openclaw/fs-safe#${number}`].decision.supersedesInProgress, true);
      if (event === "pull_request") {
        assert.equal(
          stored.items[`openclaw/fs-safe#${number}`].decision.sourceHeadSha,
          "e".repeat(40),
        );
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook materializes removal of non-close-guard labels", async () => {
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issues",
      secret: "test-secret",
      payload: {
        action: "unlabeled",
        repository: {
          full_name: "openclaw/fs-safe",
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
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      hostedPublicTargetProbe: publicHostedTargetProbe,
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: true,
    materialized: false,
    event: "issues",
    action: "unlabeled",
  });
});

test("hosted webhook read-model failures log only a closed category", async () => {
  const originalConsoleWarn = console.warn;
  const marker = "synthetic-read-model-log-marker";
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "workflow_run",
        secret: "test-secret",
        deliveryId: marker,
        payload: {
          action: "completed",
          repository: {
            full_name: "openclaw/fs-safe",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          workflow_run: {
            id: 602,
            updated_at: "2026-08-15T12:00:00Z",
          },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        hostedPublicTargetProbe: publicHostedTargetProbe,
        EXACT_REVIEW_QUEUE: {
          idFromName: () => "global",
          get: () => ({
            fetch: async () => {
              throw new Error(`${marker} https://invalid.example/private?item=1`);
            },
          }),
        },
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: true,
      materialized: false,
      event: "workflow_run",
      action: "completed",
    });
    assert.deepEqual(warnings, [
      [JSON.stringify({ event: "github_read_model_ingest_failed", failure: "queue_unavailable" })],
    ]);
    assert.doesNotMatch(JSON.stringify(warnings), new RegExp(marker));
    assert.doesNotMatch(JSON.stringify(warnings), /invalid\.example|private|item=/);
  } finally {
    console.warn = originalConsoleWarn;
  }
});

test("hosted pull request receipt fast acks precede verification and stay idempotent", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logMarker = "synthetic-log-identity-marker";
  const errorLogs: unknown[][] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      hostedPublicTargetProbe: publicHostedTargetProbe,
    },
  );
  type AckComment = {
    id: number;
    body: string;
    created_at: string;
    user: { login: string };
  };
  const comments = new Map<number, AckComment[]>();
  const waitUntilPromises: Promise<unknown>[] = [];
  const acknowledgementLookupUsesSince: boolean[] = [];
  const acknowledgementLookupPages = new Map<number, number[]>();
  const fastAckPostAttempts = new Map<number, number>();
  let failOpenedAcknowledgement = true;
  const repository = {
    full_name: "openclaw/fs-safe",
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
        target_repo: "openclaw/fs-safe",
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
      const tokenRequest = JSON.parse(String(init?.body));
      assert.deepEqual(tokenRequest.repositories, ["fs-safe"]);
      assert.ok(
        JSON.stringify(tokenRequest.permissions) ===
          JSON.stringify({ issues: "write", pull_requests: "write" }) ||
          JSON.stringify(tokenRequest.permissions) === JSON.stringify({ pull_requests: "read" }),
      );
      return jsonResponse({ token: "target-token" });
    }
    const pullMatch = /^\/repos\/openclaw\/fs-safe\/pulls\/(\d+)$/.exec(url.pathname);
    if (pullMatch) {
      assert.ok(
        ["Bearer verification-token", "Bearer target-token"].includes(
          new Headers(init?.headers).get("authorization") || "",
        ),
      );
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
    const commentMatch = /^\/repos\/openclaw\/fs-safe\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentMatch && init?.method === "GET") {
      if (Number(commentMatch[1]) === 604) {
        throw new Error("transient acknowledgement lookup failure");
      }
      acknowledgementLookupUsesSince.push(url.searchParams.has("since"));
      const page = Number(url.searchParams.get("page") || "1");
      const itemNumber = Number(commentMatch[1]);
      acknowledgementLookupPages.set(itemNumber, [
        ...(acknowledgementLookupPages.get(itemNumber) || []),
        page,
      ]);
      const pageSize = Number(url.searchParams.get("per_page") || "100");
      const allComments = comments.get(Number(commentMatch[1])) || [];
      return jsonResponse(allComments.slice((page - 1) * pageSize, page * pageSize));
    }
    if (commentMatch && init?.method === "POST") {
      const itemNumber = Number(commentMatch[1]);
      fastAckPostAttempts.set(itemNumber, (fastAckPostAttempts.get(itemNumber) || 0) + 1);
      if (itemNumber === 601 && failOpenedAcknowledgement) {
        return new Response(JSON.stringify({ message: logMarker }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(init.body || "{}"));
      const comment = {
        id: 9000 + itemNumber,
        body: String(body.body || ""),
        created_at: "2026-08-08T12:00:01Z",
        user: { login: "clawsweeper" },
      };
      comments.set(itemNumber, [...(comments.get(itemNumber) || []), comment]);
      return jsonResponse(comment);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  console.error = (...args: unknown[]) => {
    errorLogs.push(args);
  };

  const env = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
    GITHUB_TOKEN: "verification-token",
    hostedPublicTargetProbe: publicHostedTargetProbe,
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
        "openclaw/fs-safe",
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
    const acknowledgedState = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { reviewAcknowledgementCommentId?: number } }>;
    };
    assert.equal(
      acknowledgedState.items["openclaw/fs-safe#597"]?.decision.reviewAcknowledgementCommentId,
      9597,
    );

    comments.set(602, [
      {
        id: 9602,
        body: "<!-- clawsweeper-pr-ack:opened item=602 -->\n🦞👀\nClawSweeper picked this up.",
        created_at: "2026-08-08T11:59:00Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      },
    ]);
    const pendingSettleCount = waitUntilPromises.length;
    assert.equal(
      (
        await send("app-synchronize-existing-ack", "synchronize", {
          number: 602,
          head: { sha: "f".repeat(40) },
          updated_at: "2026-08-08T12:00:30Z",
          body: "A later action must recover the existing receipt.",
        })
      ).status,
      202,
    );
    assert.equal(fastAckPostAttempts.has(602), false);
    assert.equal(waitUntilPromises.length, pendingSettleCount);
    const laterActionState = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { reviewAcknowledgementCommentId?: number } }>;
    };
    assert.equal(
      laterActionState.items["openclaw/fs-safe#602"]?.decision.reviewAcknowledgementCommentId,
      9602,
    );

    comments.set(603, [
      ...Array.from({ length: 500 }, (_, index) => ({
        id: 10_000 + index,
        body: `unrelated comment ${index}`,
        created_at: "2026-08-08T11:58:00Z",
        user: { login: `contributor-${index}` },
      })),
      {
        id: 9603,
        body: "<!-- clawsweeper-pr-ack:opened item=603 -->\n🦞👀\nClawSweeper picked this up.",
        created_at: "2026-08-08T11:59:00Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      },
    ]);
    assert.equal(
      (
        await send("app-synchronize-paginated-ack", "synchronize", {
          number: 603,
          head: { sha: "f".repeat(40) },
          updated_at: "2026-08-08T12:00:40Z",
          body: "Recover a receipt after more than five comment pages.",
        })
      ).status,
      202,
    );
    assert.equal(fastAckPostAttempts.has(603), false);
    const paginatedState = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { reviewAcknowledgementCommentId?: number } }>;
    };
    assert.equal(
      paginatedState.items["openclaw/fs-safe#603"]?.decision.reviewAcknowledgementCommentId,
      9603,
    );

    comments.set(605, [
      {
        id: 9605,
        body: "<!-- clawsweeper-pr-ack:opened item=605 -->\nClawSweeper picked this up.",
        created_at: "2026-08-08T11:57:00Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      },
      ...Array.from({ length: 999 }, (_, index) => ({
        id: 20_000 + index,
        body: `unrelated comment ${index}`,
        created_at: "2026-08-08T11:58:00Z",
        user: { login: `contributor-${index}` },
      })),
    ]);
    const cappedAcknowledgement = await send("app-opened-ack-page-limit", "opened", {
      number: 605,
      head: { sha: "f".repeat(40) },
      updated_at: "2026-08-08T12:00:45Z",
      body: "Bound receipt lookup without deferring the actual review.",
    });
    assert.equal(cappedAcknowledgement.status, 202);
    assert.deepEqual(acknowledgementLookupPages.get(605), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(fastAckPostAttempts.has(605), false);
    assert.equal(comments.get(605)?.length, 1000);
    const cappedState = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { reviewAcknowledgementCommentId?: number } }>;
    };
    assert.ok(cappedState.items["openclaw/fs-safe#605"]);
    assert.equal(
      cappedState.items["openclaw/fs-safe#605"].decision.reviewAcknowledgementCommentId,
      undefined,
    );

    const deferredAcknowledgement = await send("app-synchronize-ack-deferred", "synchronize", {
      number: 604,
      head: { sha: "f".repeat(40) },
      updated_at: "2026-08-08T12:00:50Z",
      body: "Retry a transient acknowledgement lookup.",
    });
    assert.deepEqual(await deferredAcknowledgement.json(), {
      ok: true,
      accepted: true,
      deferred: true,
      reason: "pull request acknowledgement deferred",
    });
    assert.equal(
      (
        storage.rawGet(
          `exact-review-source-authority-reservation:v1:${encodeURIComponent("app-synchronize-ack-deferred")}`,
        ) as { reviewAcknowledgementPending?: boolean }
      )?.reviewAcknowledgementPending,
      true,
    );
    const deferredState = (await storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(deferredState.items["openclaw/fs-safe#604"], undefined);

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
    assert.equal(
      (
        storage.rawGet(
          `exact-review-source-authority-reservation:v1:${encodeURIComponent("app-opened-deferred")}`,
        ) as { decision?: { reviewAcknowledgementCommentId?: number } }
      )?.decision?.reviewAcknowledgementCommentId,
      9599,
    );
    assert.equal(
      (
        storage.rawGet(
          `exact-review-source-authority-reservation:v1:${encodeURIComponent("app-opened-deferred")}`,
        ) as { reviewAcknowledgementPending?: boolean }
      )?.reviewAcknowledgementPending,
      false,
    );

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
      body: "The acknowledgement write fails and intake defers safely.",
    });
    assert.equal(ackFailure.status, 202);
    assert.deepEqual(await ackFailure.json(), {
      ok: true,
      accepted: true,
      deferred: true,
      reason: "pull request acknowledgement deferred",
    });
    assert.equal(fastAckPostAttempts.get(601), 1);
    assert.equal(
      (
        storage.rawGet(
          `exact-review-source-authority-reservation:v1:${encodeURIComponent("app-opened-ack-failure")}`,
        ) as { reviewAcknowledgementPending?: boolean }
      )?.reviewAcknowledgementPending,
      true,
    );
    const ackFailureState = (await storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(ackFailureState.items["openclaw/fs-safe#601"], undefined);
    failOpenedAcknowledgement = false;
    const ackFailureReservationKey =
      "exact-review-source-authority-reservation:v1:app-opened-ack-failure";
    const ackFailureReservation = storage.rawGet(ackFailureReservationKey) as Record<
      string,
      unknown
    >;
    storage.rawPut(ackFailureReservationKey, {
      ...ackFailureReservation,
      nextAttemptAt: 0,
    });
    await queue.alarm();
    const recoveredState = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { reviewAcknowledgementCommentId?: number } }>;
    };
    assert.equal(
      recoveredState.items["openclaw/fs-safe#601"]?.decision.reviewAcknowledgementCommentId,
      9601,
    );
    assert.equal(comments.get(601)?.length, 1);
    assert.equal(fastAckPostAttempts.get(601), 2);
    assert.equal(storage.rawHas(ackFailureReservationKey), false);
    await Promise.all(waitUntilPromises);
    assert.ok(acknowledgementLookupUsesSince.includes(false));
    assert.ok(acknowledgementLookupUsesSince.includes(true));
    assert.deepEqual(errorLogs, [
      ["ClawSweeper pull request fast ack failed"],
      ["ClawSweeper pull request fast ack failed"],
    ]);
    assert.doesNotMatch(JSON.stringify(errorLogs), new RegExp(logMarker));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
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
  const queue = new ExactReviewQueue(
    { storage },
    { hostedPublicTargetProbe: publicHostedTargetProbe },
  );
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
    full_name: "openclaw/fs-safe",
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
    const pullMatch = /^\/repos\/openclaw\/fs-safe\/pulls\/(\d+)$/.exec(url.pathname);
    if (pullMatch) {
      return jsonResponse({
        head: { sha: Number(pullMatch[1]) === 640 ? "9".repeat(40) : "8".repeat(40) },
      });
    }
    const commentsMatch = /^\/repos\/openclaw\/fs-safe\/issues\/(\d+)\/comments$/.exec(
      url.pathname,
    );
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
    const deleteMatch = /^\/repos\/openclaw\/fs-safe\/issues\/comments\/(\d+)$/.exec(url.pathname);
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
    hostedPublicTargetProbe: publicHostedTargetProbe,
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

    comments.set(642, [
      {
        id: 9200,
        body: pullRequestFastAckBody(642, "opened"),
        created_at: "2026-08-09T12:02:01Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      },
      {
        id: 9201,
        body: `${pullRequestFastAckBody(642, "ready_for_review")}\n\n<!-- clawsweeper-review-progress:start -->\n### ClawSweeper review blocked\n<!-- clawsweeper-review-progress:end -->`,
        created_at: "2026-08-09T12:02:03Z",
        user: { login: "clawsweeper" },
      },
    ]);
    assert.equal(
      (
        await send("pr-ack-preserve-status", "synchronize", {
          number: 642,
          head: { sha: "8".repeat(40) },
          updated_at: "2026-08-09T12:02:10Z",
          body: "Preserve the explanation-bearing duplicate.",
        })
      ).status,
      202,
    );
    assert.deepEqual(deletedCommentIds, [9101, 9200]);
    assert.deepEqual(
      comments.get(642)?.map((comment) => comment.id),
      [9201],
    );
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
    if (url.pathname === "/repos/openclaw/fs-safe/issues/597/comments" && init?.method === "GET") {
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
    if (url.pathname === "/repos/openclaw/fs-safe/issues/597/comments" && init?.method === "POST") {
      postedAck = true;
      return jsonResponse({ id: 888 });
    }
    if (url.pathname === "/repos/openclaw/fs-safe/issues/comments/456/reactions") {
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
            full_name: "openclaw/fs-safe",
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
        hostedPublicTargetProbe: publicHostedTargetProbe,
        STATUS_STORE: new MemoryKv(),
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(postedAck, false);
    assert.deepEqual(dispatchBody, {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: "openclaw/fs-safe",
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
    if (url.pathname === "/repos/openclaw/fs-safe/issues/597/comments" && init?.method === "GET") {
      assert.equal(authorization, "Bearer target-token");
      return jsonResponse([...comments]);
    }
    if (url.pathname === "/repos/openclaw/fs-safe/issues/597/comments" && init?.method === "POST") {
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
    if (url.pathname === "/repos/openclaw/fs-safe/issues/comments/456/reactions") {
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
      full_name: "openclaw/fs-safe",
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
    hostedPublicTargetProbe: publicHostedTargetProbe,
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
    if (url.pathname === "/repos/openclaw/fs-safe/issues/597/comments" && init?.method === "GET") {
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
    if (url.pathname === "/repos/openclaw/fs-safe/issues/597/comments" && init?.method === "POST") {
      return jsonResponse({ id: 888 });
    }
    if (
      url.pathname === "/repos/openclaw/fs-safe/issues/comments/888" &&
      init?.method === "DELETE"
    ) {
      deletedAck = 888;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/fs-safe/issues/comments/456/reactions") {
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
            full_name: "openclaw/fs-safe",
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
        hostedPublicTargetProbe: publicHostedTargetProbe,
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(deletedAck, 888);
    assert.equal(commentLookups, 2);
    assert.deepEqual(dispatchBody, {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: "openclaw/fs-safe",
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
    if (url.pathname === "/repos/openclaw/fs-safe/issues/597/comments" && init?.method === "GET") {
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
      url.pathname === "/repos/openclaw/fs-safe/issues/comments/777" &&
      init?.method === "DELETE"
    ) {
      deletedAck = 777;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/fs-safe/issues/comments/456/reactions") {
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
            full_name: "openclaw/fs-safe",
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
        hostedPublicTargetProbe: publicHostedTargetProbe,
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
