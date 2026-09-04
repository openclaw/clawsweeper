import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import {
  GITHUB_ETAG_CACHE_MAX_BODY_BYTES,
  GITHUB_ETAG_CACHE_MAX_ENTRIES,
  GITHUB_ETAG_CACHE_RETENTION_MS,
  GITHUB_ETAG_CACHE_TABLE,
  GithubEtagResponseStore,
} from "../dashboard/github-etag-cache.ts";
import worker, { ExactReviewQueue, githubJsonForTest } from "../dashboard/worker.ts";
import { createGitHubRuntime } from "../dist/clawsweeper-github-runtime.js";
import {
  githubEtagCacheKey,
  githubEtagCacheRequestBody,
  type GithubEtagCacheKey,
} from "../dist/github-etag-cache-contract.js";
import {
  durableGithubEtagReadSync,
  type GithubEtagBrokerEvent,
} from "../dist/github-etag-read-broker.js";
import { MemoryDurableNamespace, MemoryDurableStorage } from "./dashboard-worker-harness.ts";

const webhookSecret = "etag-cache-webhook-placeholder";
const operatorSecret = "etag-cache-operator-placeholder";

test("ETag keys fence credential pool, media type, query, and page", () => {
  const page1 = requiredKey(
    "repository_actions",
    "/repos/openclaw/openclaw/issues/42/comments?per_page=100&page=1",
  );
  const page2 = requiredKey(
    "repository_actions",
    "/repos/openclaw/openclaw/issues/42/comments?page=2&per_page=100",
  );
  const targetPool = requiredKey(
    "target_app",
    "/repos/openclaw/openclaw/issues/42/comments?per_page=100&page=1",
  );
  const media = githubEtagCacheKey({
    credentialPool: "repository_actions",
    route: "/repos/openclaw/openclaw/issues/42/comments?per_page=100&page=1",
    mediaType: "application/vnd.github.raw+json",
    surface: "apply",
  })!;

  assert.notEqual(page1.cacheKey, page2.cacheKey);
  assert.notEqual(page1.cacheKey, targetPool.cacheKey);
  assert.notEqual(page1.cacheKey, media.cacheKey);
  assert.equal(page1.page, 1);
  assert.equal(page2.page, 2);
  assert.equal(page2.route, "/repos/openclaw/openclaw/issues/42/comments?page=2&per_page=100");
});

test("projected GitHub reads bypass the durable ETag broker", () => {
  const keys = ["EXACT_EVENT_PUBLICATION", "EXACT_REVIEW_QUEUE_URL", "CLAWSWEEPER_WEBHOOK_SECRET"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    EXACT_EVENT_PUBLICATION: "true",
    EXACT_REVIEW_QUEUE_URL: "http://127.0.0.1:9",
    CLAWSWEEPER_WEBHOOK_SECRET: "etag-broker-secret-placeholder",
  });
  const invocations: string[][] = [];
  const runtime = createGitHubRuntime({
    ROOT: process.cwd(),
    targetRepo: () => "openclaw/openclaw",
    run: (_command, args) => {
      invocations.push(args);
      return JSON.stringify({ projected: true });
    },
  });
  const route = "/repos/openclaw/openclaw/pulls/1234";
  const projections = [
    ["--jq", "{body}"],
    ["-q", "{requested_reviewers,requested_teams}"],
    ["--template", "{{.head.sha}}"],
    ["-t", "{{.state}}"],
    ["--jq={body}"],
    ["--template={{.head.sha}}"],
    ["-q={body}"],
    ["-q{body}"],
    ["-t={{.state}}"],
    ["-t{{.state}}"],
    ["-iq", "{body}"],
    ["-it", "{{.state}}"],
  ];

  try {
    for (const projection of projections) {
      assert.equal(
        runtime.ghWithPreparedTimeout(["api", route, ...projection], 1_000),
        JSON.stringify({ projected: true }),
      );
    }
    assert.deepEqual(
      invocations,
      projections.map((projection) => ["api", route, ...projection]),
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("durable broker revalidates every read and keeps wire calls while avoiding quota charges", () => {
  const entries = new Map<string, { etag: string; body: string; bodyDigest: string }>();
  const events: GithubEtagBrokerEvent[] = [];
  const conditionals: Array<string | undefined> = [];
  let resource = { etag: '"resource-v1"', body: JSON.stringify({ version: 1, title: "first" }) };
  const page1 = requiredKey(
    "repository_actions",
    "/repos/openclaw/openclaw/issues/42/comments?per_page=100&page=1",
  );
  const page2 = requiredKey(
    "repository_actions",
    "/repos/openclaw/openclaw/issues/42/comments?per_page=100&page=2",
  );
  const read = (key: GithubEtagCacheKey) =>
    durableGithubEtagReadSync({
      key,
      lookup: () => {
        const entry = entries.get(key.cacheKey);
        return entry
          ? { hit: true, entry: { etag: entry.etag, bodyDigest: entry.bodyDigest } }
          : { hit: false };
      },
      store200: (_key, response) => {
        entries.set(key.cacheKey, {
          ...response,
          bodyDigest: sha256(response.body),
        });
        return { stored: true };
      },
      confirm304: (_key, expected) => {
        const entry = entries.get(key.cacheKey);
        return entry && entry.etag === expected.etag && entry.bodyDigest === expected.bodyDigest
          ? {
              confirmed: true,
              body: entry.body,
              entry: { etag: entry.etag, bodyDigest: entry.bodyDigest },
            }
          : { confirmed: false };
      },
      githubRequest: (ifNoneMatch) => {
        conditionals.push(ifNoneMatch);
        return ifNoneMatch === resource.etag
          ? { status: 304, body: "", etag: resource.etag }
          : { status: 200, body: resource.body, etag: resource.etag };
      },
      record: (event) => events.push(event),
    });

  const first = read(page1);
  const unchanged = read(page1);
  assert.equal(unchanged, first);
  assert.equal(sha256(unchanged), sha256(first));

  resource = { etag: '"resource-v2"', body: JSON.stringify({ version: 2, title: "changed" }) };
  assert.equal(read(page1), resource.body);

  resource = { etag: '"page-2"', body: JSON.stringify([{ id: 101 }]) };
  assert.equal(read(page2), resource.body);
  assert.equal(conditionals.at(-1), undefined, "page 2 must not carry page 1's ETag");

  const callsBeforeFinalGuard = conditionals.length;
  assert.equal(read(page2), resource.body);
  assert.equal(
    conditionals.length,
    callsBeforeFinalGuard + 1,
    "final guards still make a wire call",
  );
  assert.equal(conditionals.at(-1), '"page-2"');
  assert.equal(conditionals.length, 5, "the broker reduces quota charges, not wire requests");

  assert.equal(events.filter((event) => event.outcome === "cache_200_stored").length, 3);
  assert.equal(events.filter((event) => event.outcome === "cache_304_served").length, 2);
  assert.equal(events.filter((event) => event.outcome === "cache_miss").length, 2);
  assert.equal(events.filter((event) => event.outcome === "cache_hit").length, 3);
});

test("durable store confirms 304 bodies by ETag and digest and enforces bounds", async () => {
  const now = Date.parse("2026-08-14T00:00:00Z");
  const storage = new MemoryDurableStorage();
  const store = new GithubEtagResponseStore(storage);
  store.ensureSchemaSync();
  const key = requiredKey("target_app", "/repos/openclaw/openclaw/pulls/99");
  const request = githubEtagCacheRequestBody(key, "apply");
  const body = JSON.stringify({ number: 99, head: { sha: "a".repeat(40) } });
  const stored = await store.store200({ ...request, etag: 'W/"pull-v1"', body }, now);
  assert.equal(stored.ok && stored.stored, true);
  const lookup = store.lookup(request, now + 1);
  assert.equal(lookup?.bodyDigest, sha256(body));
  const confirmed = store.confirm304(
    { ...request, etag: lookup!.etag, body_digest: lookup!.bodyDigest },
    now + 2,
  );
  assert.equal(confirmed.ok && confirmed.confirmed && confirmed.body, body);
  const mismatched = store.confirm304(
    { ...request, etag: lookup!.etag, body_digest: "f".repeat(64) },
    now + 3,
  );
  assert.equal(mismatched.ok && mismatched.confirmed, false);

  const oversized = await store.store200(
    {
      ...request,
      etag: '"large"',
      body: JSON.stringify({ body: "x".repeat(GITHUB_ETAG_CACHE_MAX_BODY_BYTES) }),
    },
    now + 4,
  );
  assert.deepEqual(oversized, { ok: true, stored: false, reason: "body_size_bound" });
  assert.deepEqual(store.telemetry(now + 4), {
    cache_200_stored: 1,
    cache_304_served: 1,
    cache_hit: 1,
    cache_skip: 2,
  });
  assert.equal(store.lookup(request, now + GITHUB_ETAG_CACHE_RETENTION_MS + 3), null);
});

test("durable store accepts 100 KiB and skips 200 KiB UTF-8 bodies", async () => {
  const storage = new MemoryDurableStorage();
  const store = new GithubEtagResponseStore(storage);
  store.ensureSchemaSync();
  const request = githubEtagCacheRequestBody(
    requiredKey("target_app", "/repos/openclaw/openclaw/pulls/99"),
    "apply",
  );
  for (const character of ["x", "é"]) {
    const accepted = jsonBodyBytes(100 * 1_024, character);
    const result = await store.store200({ ...request, etag: '"accepted"', body: accepted }, 1);
    assert.equal(result.ok && result.stored, true);
    assert.equal(store.lookup(request, 2)?.bodyDigest, sha256(accepted));
    assert.deepEqual(
      await store.store200(
        { ...request, etag: '"oversized"', body: jsonBodyBytes(200 * 1_024, character) },
        3,
      ),
      { ok: true, stored: false, reason: "body_size_bound" },
    );
    assert.equal(store.lookup(request, 4)?.etag, '"accepted"');
  }
  assert.equal(store.telemetry(4).cache_skip, 2);
});

test("durable store caps entries immediately and reconciles counts every 64 stores", async () => {
  const storage = new MemoryDurableStorage();
  let store = new GithubEtagResponseStore(storage);
  store.ensureSchemaSync();
  const request = (number: number) =>
    githubEtagCacheRequestBody(
      requiredKey("target_app", `/repos/openclaw/openclaw/pulls/${number}`),
      "apply",
    );
  const put = (number: number, now: number) =>
    store.store200({ ...request(number), etag: '"v1"', body: "{}" }, now);
  storage.sql.resetQueryHistory();
  for (let index = 0; index < GITHUB_ETAG_CACHE_MAX_ENTRIES; index += 1) {
    await put(index, index);
  }
  const oldest = store.lookup(request(0), 3_000)!;
  store.confirm304({ ...request(0), etag: oldest.etag, body_digest: oldest.bodyDigest }, 3_000);
  for (let index = 0; index < 64; index += 1) {
    await put(0, 3_001 + index);
    await put(GITHUB_ETAG_CACHE_MAX_ENTRIES + index, 4_000 + index);
    assert.equal(
      Array.from(storage.sql.exec(`SELECT cache_key FROM ${GITHUB_ETAG_CACHE_TABLE}`)).length,
      GITHUB_ETAG_CACHE_MAX_ENTRIES,
    );
  }
  assert.ok(store.lookup(request(0), 5_000), "recently validated oldest entry survives");
  for (let index = 1; index <= 64; index += 1) {
    assert.equal(store.lookup(request(index), 5_000), null);
  }
  assert.ok(store.lookup(request(65), 5_000));
  assert.equal(
    storage.sql.queriesMatching(/SELECT COUNT\(\*\) AS count FROM github_etag_response_cache_v1/)
      .length,
    34,
    "full counts must be amortized across at least 64 stores",
  );
  store = new GithubEtagResponseStore(storage);
  await put(10_000, 6_000);
  assert.equal(store.lookup(request(65), 6_001), null, "cold instances count persisted entries");
  assert.ok(store.lookup(request(0), 6_001));
  storage.sql.failNext(/INSERT INTO github_etag_response_cache_metrics_v1/);
  await assert.rejects(put(10_001, 6_002), /injected SQL failure/);
  assert.ok(store.lookup(request(66), 6_003), "failed stores roll back eviction");
  await put(10_002, 6_004);
  assert.equal(store.lookup(request(66), 6_005), null);
  assert.ok(store.lookup(request(67), 6_005), "rollback must not drift the cached count");
  assert.equal(
    Array.from(storage.sql.exec(`SELECT cache_key FROM ${GITHUB_ETAG_CACHE_TABLE}`)).length,
    GITHUB_ETAG_CACHE_MAX_ENTRIES,
  );
});

test("expiry housekeeping runs at most once per minute without serving expired bodies", async () => {
  const storage = new MemoryDurableStorage();
  const store = new GithubEtagResponseStore(storage);
  store.ensureSchemaSync();
  const request = githubEtagCacheRequestBody(
    requiredKey("target_app", "/repos/openclaw/openclaw/pulls/99"),
    "apply",
  );
  await store.store200({ ...request, etag: '"v1"', body: "{}" }, 0);
  const entry = store.lookup(request, 1)!;
  const nearExpiry = GITHUB_ETAG_CACHE_RETENTION_MS - 1;
  storage.sql.resetQueryHistory();
  store.lookup(request, nearExpiry);
  for (let index = 1; index <= 64; index += 1) {
    await store.store200(
      {
        ...githubEtagCacheRequestBody(
          requiredKey("target_app", `/repos/openclaw/openclaw/pulls/${100 + index}`),
          "apply",
        ),
        etag: '"fresh"',
        body: "{}",
      },
      nearExpiry + index,
    );
    assert.equal(store.lookup(request, nearExpiry + index), null);
  }
  assert.deepEqual(
    store.confirm304(
      { ...request, etag: entry.etag, body_digest: entry.bodyDigest },
      nearExpiry + 65,
    ),
    { ok: true, confirmed: false, reason: "entry_changed_or_expired" },
  );
  store.lookup(request, nearExpiry + 59_999);
  const cleanupCount = () =>
    storage.sql.queriesMatching(/DELETE FROM github_etag_response_cache_v1[\s\S]*expires_at <=/)
      .length;
  assert.equal(cleanupCount(), 1);
  assert.equal(
    storage.sql.queriesMatching(/DELETE FROM github_etag_response_cache_metrics_v1/).length,
    1,
  );
  store.lookup(request, nearExpiry + 60_000);
  assert.equal(cleanupCount(), 2);
  assert.equal(
    storage.sql.queriesMatching(/DELETE FROM github_etag_response_cache_metrics_v1/).length,
    2,
  );
});

test("publication client skips oversized UTF-8 bodies before issuing a store request", () => {
  for (const size of [100, 128, 200]) {
    for (const character of ["x", "é"]) {
      const body = jsonBodyBytes(size * 1_024, character);
      const events: GithubEtagBrokerEvent[] = [];
      let stores = 0;
      assert.equal(
        durableGithubEtagReadSync({
          key: requiredKey("target_app", "/repos/openclaw/openclaw/pulls/99"),
          lookup: () => ({ hit: false }),
          store200: () => {
            stores += 1;
            return { stored: true };
          },
          confirm304: () => {
            throw new Error("unexpected confirmation");
          },
          githubRequest: () => ({ status: 200, body, etag: '"v1"' }),
          record: (event) => events.push(event),
        }),
        body,
      );
      assert.equal(stores, size <= 128 ? 1 : 0);
      assert.equal(events.at(-1)?.outcome, size <= 128 ? "cache_200_stored" : "cache_skip");
    }
  }
});

test("dashboard health client skips oversized bodies before requesting the queue store", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const paths: string[] = [];
  const originalQueueFetch = queue.fetch.bind(queue);
  queue.fetch = (request) => {
    paths.push(new URL(request.url).pathname);
    return originalQueueFetch(request);
  };
  const env = {
    GITHUB_TOKEN: "dashboard-token",
    CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const originalFetch = globalThis.fetch;
  const body = jsonBodyBytes(200 * 1_024, "é");
  globalThis.fetch = async () => new Response(body, { headers: { etag: '"large"' } });
  try {
    assert.deepEqual(
      await githubJsonForTest(env, "/repos/openclaw/clawsweeper/actions/runs"),
      JSON.parse(body),
    );
    assert.deepEqual(paths, ["/github-etag-cache/lookup"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publisher HMAC endpoints persist and confirm bodies while operator scope is rejected", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret,
    EXACT_REVIEW_OPERATOR_SECRET: operatorSecret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const key = requiredKey("repository_actions", "/repos/openclaw/openclaw/issues/7");
  const request = githubEtagCacheRequestBody(key, "apply");
  const body = JSON.stringify({ number: 7, state: "open" });
  const storeBody = JSON.stringify({ ...request, etag: '"issue-v1"', body });
  const storeUrl = "https://clawsweeper.openclaw.ai/internal/exact-review/github-etag-cache/store";

  assert.equal(
    (await worker.fetch(signedRequest(storeUrl, storeBody, operatorSecret), env)).status,
    401,
  );
  assert.equal(
    (await worker.fetch(signedRequest(storeUrl, storeBody, webhookSecret), env)).status,
    201,
  );

  const lookupBody = JSON.stringify(request);
  const lookup = await worker.fetch(
    signedRequest(
      "https://clawsweeper.openclaw.ai/internal/exact-review/github-etag-cache/lookup",
      lookupBody,
      webhookSecret,
    ),
    env,
  );
  const lookupJson = await lookup.json();
  assert.equal(lookupJson.hit, true);
  assert.equal("body" in lookupJson.entry, false, "lookup never serves a body");

  const confirmBody = JSON.stringify({
    ...request,
    etag: lookupJson.entry.etag,
    body_digest: lookupJson.entry.bodyDigest,
  });
  const confirmed = await worker.fetch(
    signedRequest(
      "https://clawsweeper.openclaw.ai/internal/exact-review/github-etag-cache/confirm",
      confirmBody,
      webhookSecret,
    ),
    env,
  );
  assert.equal((await confirmed.json()).body, body);
});

test("dashboard health reads send If-None-Match and replay only after durable confirmation", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    GITHUB_TOKEN: "dashboard-token",
    CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  let resource = {
    etag: '"health-v1"',
    body: JSON.stringify({ workflow_runs: [{ id: 1, status: "queued" }] }),
  };
  const observed: Array<string | null> = [];
  globalThis.fetch = async (_input, init) => {
    const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
    observed.push(ifNoneMatch);
    return ifNoneMatch === resource.etag
      ? new Response(null, { status: 304, headers: { etag: resource.etag } })
      : new Response(resource.body, {
          status: 200,
          headers: { "content-type": "application/json", etag: resource.etag },
        });
  };
  try {
    const path = "/repos/openclaw/clawsweeper/actions/runs?per_page=100";
    const first = await githubJsonForTest(env, path);
    const second = await githubJsonForTest(env, path);
    assert.deepEqual(second, first);
    assert.deepEqual(observed, [null, '"health-v1"']);

    resource = {
      etag: '"health-v2"',
      body: JSON.stringify({ workflow_runs: [{ id: 2, status: "in_progress" }] }),
    };
    assert.equal((await githubJsonForTest(env, path)).workflow_runs[0].id, 2);
    assert.deepEqual(observed, [null, '"health-v1"', '"health-v1"']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function requiredKey(
  credentialPool: "repository_actions" | "target_app",
  route: string,
): GithubEtagCacheKey {
  const key = githubEtagCacheKey({ credentialPool, route, surface: "apply" });
  assert.ok(key);
  return key;
}

function signedRequest(url: string, body: string, secret: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBodyBytes(bytes: number, character: string): string {
  const empty = JSON.stringify({ body: "" });
  const padding = bytes - Buffer.byteLength(empty);
  const width = Buffer.byteLength(character);
  const body = JSON.stringify({
    body: character.repeat(Math.floor(padding / width)) + "x".repeat(padding % width),
  });
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}
