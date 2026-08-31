import {
  assert,
  createHmac,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  worker,
} from "./dashboard-worker-harness.ts";
import { exactReviewQueueEndpointTemplate } from "../dashboard/exact-review-queue-observability.ts";

const TRACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

test("exact-review Durable Object logs only source coordinates and rethrows storage failures", async (t) => {
  const storage = new MemoryDurableStorage();
  const queue = newQueue(storage);
  assert.equal((await queue.fetch(publicationsListRequest(100))).status, 200);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => errors.push(values));
  for (const [stack, location] of [
    ["Error: private marker\n    at query (worker.js:91:4)", [91, 4]],
    [
      "Error: private marker\r\n    at query (file:///private-path/worker.js:123:7)\r\n    at caller (worker.js:234:8)",
      [123, 7],
    ],
    ["Error: private marker worker.js:91:4", null],
    ["Error: private marker\n    at query (private-worker.js:91:4)", null],
    ["Error: private marker\n    at query (worker.js:0:4)", null],
    ["Error: private marker\n    at query (worker.js:1234567:4)", null],
    [undefined, null],
  ] as const) {
    const failure = new Error("private marker");
    failure.stack = stack;
    errors.length = 0;
    storage.failNextSql(/SELECT item_key, item_json/, failure);
    await assert.rejects(queue.fetch(publicationsListRequest(100)), (error) => error === failure);
    assert.deepEqual(errors, [
      [
        "exact_review_queue_handler_failed",
        {
          phase: "fetch",
          trace_id: null,
          endpoint: "publications_list",
          failure_category: "handler_exception",
          location,
        },
      ],
    ]);
    assert.equal((await queue.fetch(publicationsListRequest(100))).status, 200);
  }
});

test("exact-review schema barrier logs source coordinates before rejecting initialization", async (t) => {
  const storage = new MemoryDurableStorage();
  const failure = new Error("private schema marker");
  failure.stack = "Error: private schema marker\n    at schema (worker.js:456:9)";
  storage.failNextSql(/CREATE TABLE/, failure);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => errors.push(values));
  let initialized: Promise<void> | undefined;
  new ExactReviewQueue(
    {
      storage,
      blockConcurrencyWhile: (callback: () => Promise<void>) => {
        initialized = callback();
        return initialized;
      },
    },
    {},
  );
  assert.ok(initialized);
  await assert.rejects(initialized, (error) => error === failure);
  assert.deepEqual(errors, [
    [
      "exact_review_queue_handler_failed",
      {
        phase: "initialize",
        trace_id: null,
        endpoint: "initialization",
        failure_category: "handler_exception",
        location: [456, 9],
      },
    ],
  ]);
});

test("exact-review endpoint templates never retain dynamic record coordinates", () => {
  assert.equal(
    exactReviewQueueEndpointTemplate("/records/private-repository/items/12345"),
    "records_item",
  );
  assert.equal(
    exactReviewQueueEndpointTemplate("/records/private-repository/unknown/private-marker"),
    "other",
  );
  assert.equal(
    exactReviewQueueEndpointTemplate("/records/export?cursor=private-marker"),
    "records_export",
  );
  assert.equal(
    exactReviewQueueEndpointTemplate("/lifecycle/command-ack/observed"),
    "lifecycle_command_ack_observed",
  );
  assert.equal(
    exactReviewQueueEndpointTemplate("/publication-batches/heartbeat"),
    "publication_batches_heartbeat",
  );
  assert.equal(
    exactReviewQueueEndpointTemplate("/telemetry-reconciliation?public_repo=openclaw%2Fopenclaw"),
    "telemetry_reconciliation",
  );
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
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.[0], "exact_review_queue_request_failed");
      const metadata = errors[0]?.[1] as Record<string, unknown>;
      assert.match(String(metadata.trace_id), TRACE_ID_PATTERN);
      assert.deepEqual(
        { ...metadata, trace_id: "<trace>" },
        {
          trace_id: "<trace>",
          endpoint: "publications_list",
          phase: "request",
          transport: "throw",
          upstream_status: null,
          ...flags,
          failure_category: flags.overloaded
            ? "platform_overloaded"
            : flags.retryable
              ? "platform_retryable"
              : flags.remote
                ? "remote_exception"
                : "request_exception",
        },
      );
      assert.equal(JSON.stringify(errors).includes(internalStack), false);
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
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.[0], "exact_review_queue_malformed_server_response");
    const metadata = errors[0]?.[1] as Record<string, unknown>;
    assert.match(String(metadata.trace_id), TRACE_ID_PATTERN);
    assert.deepEqual(
      { ...metadata, trace_id: "<trace>" },
      {
        trace_id: "<trace>",
        endpoint: "publications_list",
        phase: "request",
        transport: "non_json_5xx",
        upstream_status: 503,
        failure_category: "malformed_server_response",
      },
    );
    assert.equal(JSON.stringify(errors).includes(plantedMarker), false);
  } finally {
    console.error = originalError;
  }
});

test("exact-review Worker preserves structured Durable Object 5xx responses", async () => {
  const secret = "test-webhook-secret";
  const body = JSON.stringify({ limit: 100 });
  const responseBody = { error: "lease_decision_unavailable", retryable: true };
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...values: unknown[]) => errors.push(values);
  try {
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
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.[0], "exact_review_queue_structured_server_response");
    const metadata = errors[0]?.[1] as Record<string, unknown>;
    assert.match(String(metadata.trace_id), TRACE_ID_PATTERN);
    assert.deepEqual(
      { ...metadata, trace_id: "<trace>" },
      {
        trace_id: "<trace>",
        endpoint: "publications_list",
        phase: "request",
        transport: "structured_5xx",
        upstream_status: 503,
        failure_category: "structured_server_response",
      },
    );
    assert.equal(JSON.stringify(errors).includes(responseBody.error), false);
  } finally {
    console.error = originalError;
  }
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
