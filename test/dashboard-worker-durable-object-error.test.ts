import {
  assert,
  createHmac,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  worker,
} from "./dashboard-worker-harness.ts";

function publicationsListRequest(limit: number) {
  return new Request("https://clawsweeper-exact-review-queue/publications/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit }),
  });
}

function newQueue(storage: MemoryDurableStorage) {
  return new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "1" },
  );
}

function signedPublicationsListRequest(body: string, secret: string) {
  return new Request("https://clawsweeper.openclaw.ai/internal/exact-review/publications/list", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret)
        .update(body)
        .digest("hex")}`,
    },
    body,
  });
}

test("exact-review Durable Object rejects storage failures directly", async () => {
  const storage = new MemoryDurableStorage();
  const queue = newQueue(storage);
  assert.equal((await queue.fetch(publicationsListRequest(100))).status, 200);

  storage.failNextSql(/SELECT item_key, item_json/);
  await assert.rejects(queue.fetch(publicationsListRequest(100)), /injected SQL failure/);
  assert.equal((await queue.fetch(publicationsListRequest(100))).status, 200);
});

test("exact-review Worker retains only platform flags from rejected Durable Object calls", async () => {
  const internalStack = [
    "Error: database pool internals",
    "at readQueue (file:///srv/clawsweeper-private/exact-review-queue.ts:91:4)",
  ].join("\n");
  const secret = "test-webhook-secret";
  const requestBody = JSON.stringify({ limit: 100 });
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...values: unknown[]) => errors.push(values);
  try {
    for (const [failure, flags] of [
      [internalStack, { remote: false, retryable: false, overloaded: false }],
      [
        Object.assign(new Error(internalStack), { remote: true }),
        { remote: true, retryable: false, overloaded: false },
      ],
      [
        Object.assign(new Error(internalStack), { retryable: true }),
        { remote: false, retryable: true, overloaded: false },
      ],
      [
        Object.assign(new Error(internalStack), { retryable: true, overloaded: true }),
        { remote: false, retryable: true, overloaded: true },
      ],
      [
        { message: internalStack, remote: "true", retryable: 1, overloaded: internalStack },
        { remote: false, retryable: false, overloaded: false },
      ],
    ] as const) {
      errors.length = 0;
      const response = await worker.fetch(signedPublicationsListRequest(requestBody, secret), {
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
          async fetch() {
            throw failure;
          },
        }),
      });

      assert.equal(response.status, 500);
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
      assert.deepEqual(await response.json(), { error: "exact_review_queue_unavailable" });
      assert.deepEqual(errors, [["exact_review_queue_request_failed", flags]]);
    }
  } finally {
    console.error = originalError;
  }
});

test("exact-review Worker projects malformed Durable Object 5xx responses to a fixed public error", async () => {
  const plantedMarker = "private-marker-0123456789abcdef";
  const secret = "test-webhook-secret";
  const body = JSON.stringify({ limit: 100 });
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...values: unknown[]) => errors.push(values);
  try {
    const response = await worker.fetch(signedPublicationsListRequest(body, secret), {
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
        async fetch() {
          return new Response(`upstream failure marker=${plantedMarker}`, {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    });

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await response.json(), { error: "exact_review_queue_unavailable" });
    assert.deepEqual(errors, [["exact_review_queue_malformed_server_response"]]);
  } finally {
    console.error = originalError;
  }
});

test("exact-review Worker preserves structured Durable Object 5xx responses", async () => {
  const secret = "test-webhook-secret";
  const body = JSON.stringify({ limit: 100 });
  const responseBody = { error: "lease_decision_unavailable", retryable: true };
  const response = await worker.fetch(signedPublicationsListRequest(body, secret), {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
      async fetch() {
        return new Response(JSON.stringify(responseBody), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), responseBody);
});

test("exact-review Worker preserves intentional non-JSON 4xx responses", async () => {
  const secret = "test-webhook-secret";
  const body = JSON.stringify({ limit: 0 });
  const response = await worker.fetch(signedPublicationsListRequest(body, secret), {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
      async fetch() {
        return new Response("intentional conflict", {
          status: 409,
          headers: { "content-type": "text/plain" },
        });
      },
    }),
  });

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(await response.text(), "intentional conflict");
});
