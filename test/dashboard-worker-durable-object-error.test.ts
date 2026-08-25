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

test("exact-review Worker sanitizes rejected Durable Object calls", async () => {
  const storage = new MemoryDurableStorage();
  const queue = newQueue(storage);
  assert.equal((await queue.fetch(publicationsListRequest(100))).status, 200);

  storage.failNextSql(
    /SELECT item_key, item_json/,
    new Error(
      "injected sqlite read failure exposing GH_TOKEN=ghp_examplesecrettoken0123456789abcd",
    ),
  );
  const secret = "test-webhook-secret";
  const requestBody = JSON.stringify({ limit: 100 });
  const response = await worker.fetch(signedPublicationsListRequest(requestBody, secret), {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const responseBody = (await response.json()) as { error?: unknown };
  assert.equal(typeof responseBody.error, "string");
  assert.equal(JSON.stringify(responseBody).includes("ghp_examplesecrettoken"), false);
});

test("exact-review Worker normalizes malformed Durable Object 5xx responses", async () => {
  const plantedToken = "ghp_examplesecrettoken0123456789abcd";
  const secret = "test-webhook-secret";
  const body = JSON.stringify({ limit: 100 });
  const response = await worker.fetch(signedPublicationsListRequest(body, secret), {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
      async fetch() {
        return new Response(`upstream failure GH_TOKEN=${plantedToken}`, {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const responseBody = (await response.json()) as { error?: unknown };
  assert.equal(typeof responseBody.error, "string");
  assert.equal(JSON.stringify(responseBody).includes(plantedToken), false);
  assert.match(String(responseBody.error), /\[REDACTED\]/);
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
