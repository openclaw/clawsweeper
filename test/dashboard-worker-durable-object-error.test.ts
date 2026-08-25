import {
  assert,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
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

test("exact-review Durable Object returns a sanitized JSON error when a route throws", async () => {
  const storage = new MemoryDurableStorage();
  const queue = newQueue(storage);
  assert.equal((await queue.fetch(publicationsListRequest(100))).status, 200);

  storage.failNextSql(
    /SELECT item_key, item_json/,
    new Error(
      "injected sqlite read failure exposing GH_TOKEN=ghp_examplesecrettoken0123456789abcd",
    ),
  );
  const response = await queue.fetch(publicationsListRequest(100));

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const body = (await response.json()) as { error?: unknown };
  assert.equal(typeof body.error, "string");
  assert.equal(JSON.stringify(body).includes("ghp_examplesecrettoken"), false);
});

test("exact-review Durable Object preserves intentional non-200 responses", async () => {
  const storage = new MemoryDurableStorage();
  const queue = newQueue(storage);

  const response = await queue.fetch(publicationsListRequest(0));

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error?: unknown };
  assert.equal(body.error, "invalid_limit");
});
