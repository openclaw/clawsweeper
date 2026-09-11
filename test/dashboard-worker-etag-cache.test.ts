import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import worker, { GithubEtagCache } from "../dashboard/worker.ts";
import {
  GITHUB_ETAG_CACHE_FALLBACK_SHARD,
  githubEtagCacheShard,
} from "../dashboard/github-etag-cache.ts";
import {
  EXACT_REVIEW_QUEUE_TRACE_HEADER,
  exactReviewQueueTraceId,
} from "../dashboard/exact-review-queue-observability.ts";
import { MemoryDurableStorage } from "./dashboard-worker-harness.ts";

const secret = "synthetic-etag-hmac";
const key = { credential_pool: "target_app", route: "/repos/OpenClaw/OpenClaw/issues/7" };
function signed(operation: string, body: unknown, signingSecret = secret): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`https://worker/internal/exact-review/github-etag-cache/${operation}`, {
    method: "POST",
    headers: {
      "x-clawsweeper-exact-review-signature":
        "sha256=" + createHmac("sha256", signingSecret).update(text).digest("hex"),
      [EXACT_REVIEW_QUEUE_TRACE_HEADER]: "untrusted-client-value",
    },
    body: text,
  });
}

function harness() {
  const shards = new Map<string, GithubEtagCache>();
  const calls: Array<{ shard: string; path: string; trace: string | null }> = [];
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: {
      idFromName() {
        throw new Error("etag traffic must not touch queue");
      },
    },
    GITHUB_ETAG_CACHE: {
      idFromName(name: string) {
        return name;
      },
      get(shard: string) {
        let cache = shards.get(shard);
        if (!cache) {
          cache = new GithubEtagCache({ storage: new MemoryDurableStorage() });
          shards.set(shard, cache);
        }
        return {
          fetch: (request: Request) => {
            calls.push({
              shard,
              path: new URL(request.url).pathname,
              trace: request.headers.get(EXACT_REVIEW_QUEUE_TRACE_HEADER),
            });
            return cache.fetch(request);
          },
        };
      },
    },
  };
  return { env, shards, calls };
}

test("cache shard comes from the validated canonical route with a fixed fallback", () => {
  assert.equal(githubEtagCacheShard(key), "openclaw/openclaw");
  assert.equal(
    githubEtagCacheShard({
      ...key,
      route: "/api/v3/repos/openclaw/clawsweeper/actions/runs?page=2",
      surface: "dashboard",
    }),
    "openclaw/clawsweeper",
  );
  for (const value of [null, {}, { ...key, route: "/user" }, { ...key, cache_key: "forged" }]) {
    assert.equal(githubEtagCacheShard(value), GITHUB_ETAG_CACHE_FALLBACK_SHARD);
  }
});

test("authenticated cache traffic bypasses the queue, isolates repos and preserves traces and stats", async () => {
  const { env, shards, calls } = harness();
  const other = { ...key, route: "/repos/openclaw/clawsweeper/issues/7" };
  assert.equal((await worker.fetch(signed("store", key, "operator-placeholder"), env)).status, 401);
  assert.equal(calls.length, 0);
  assert.deepEqual(await (await worker.fetch(signed("lookup", key), env)).json(), {
    ok: true,
    hit: false,
    entry: null,
  });
  const stored = await worker.fetch(
    signed("store", { ...key, etag: '"v1"', body: '{"number":7}' }),
    env,
  );
  assert.equal(stored.status, 201);
  const { entry } = await stored.json();
  assert.equal((await (await worker.fetch(signed("lookup", other), env)).json()).hit, false);
  const hit = await (await worker.fetch(signed("lookup", key), env)).json();
  assert.equal(hit.hit, true);
  assert.deepEqual(hit.entry, entry);
  const confirmed = await worker.fetch(
    signed("confirm", { ...key, etag: entry.etag, body_digest: entry.bodyDigest }),
    env,
  );
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).body, '{"number":7}');
  assert.deepEqual([...shards.keys()], ["openclaw/openclaw", "openclaw/clawsweeper"]);
  assert.ok(calls.every((call) => exactReviewQueueTraceId(call.trace)));
  assert.equal(new Set(calls.map((call) => call.trace)).size, calls.length);
  assert.deepEqual(
    await (await shards.get("openclaw/openclaw")!.fetch(new Request("https://cache/stats"))).json(),
    {
      ok: true,
      telemetry: { cache_miss: 1, cache_hit: 1, cache_200_stored: 1, cache_304_served: 1 },
    },
  );
});

test("cache keeps validation/skip responses and never falls back to an absent or failed queue", async () => {
  const { env, calls } = harness();
  for (const operation of ["lookup", "store", "confirm"]) {
    const response = await worker.fetch(signed(operation, "not-json"), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error:
        operation === "confirm"
          ? "invalid_github_etag_confirmation"
          : "invalid_github_etag_cache_key",
    });
  }
  assert.ok(calls.every((call) => call.shard === GITHUB_ETAG_CACHE_FALLBACK_SHARD));
  assert.deepEqual(await (await worker.fetch(signed("store", key), env)).json(), {
    ok: true,
    stored: false,
    reason: "missing_or_invalid_etag",
  });
  assert.deepEqual(
    await (
      await worker.fetch(
        signed("confirm", { ...key, etag: '"old"', body_digest: "a".repeat(64) }),
        env,
      )
    ).json(),
    { ok: true, confirmed: false, reason: "entry_changed_or_expired" },
  );
  const missing = await worker.fetch(signed("lookup", key), {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: env.EXACT_REVIEW_QUEUE,
  });
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: "github_etag_cache_not_configured" });
});

test("cache transport keeps trace-labelled structured and malformed failures independent of queue", async () => {
  const originalError = console.error;
  const logs: Array<[string, Record<string, unknown>]> = [];
  console.error = (message: string, detail: Record<string, unknown>) => {
    logs.push([message, detail]);
  };
  try {
    for (const scenario of ["structured", "bare", "overloaded"] as const) {
      const { env } = harness();
      const diagnostic = "private-upstream-detail";
      env.GITHUB_ETAG_CACHE.get = () => ({
        fetch: async () => {
          if (scenario === "overloaded")
            throw Object.assign(new Error(diagnostic), { overloaded: true });
          return scenario === "structured"
            ? Response.json(
                { error: "github_etag_cache_unavailable" },
                { status: 503, headers: { "retry-after": "5" } },
              )
            : new Response(diagnostic, { status: 500 });
        },
      });
      const response = await worker.fetch(signed("lookup", key), env);
      assert.equal(response.status, scenario === "bare" ? 500 : 503);
      assert.deepEqual(await response.json(), { error: "github_etag_cache_unavailable" });
      if (scenario === "structured") assert.equal(response.headers.get("retry-after"), "5");
      const [message, detail] = logs.at(-1)!;
      assert.ok(message.startsWith("github_etag_cache_"));
      assert.equal(detail.endpoint, "github_etag_cache_lookup");
      assert.ok(exactReviewQueueTraceId(detail.trace_id));
      assert.equal(JSON.stringify(logs).includes(diagnostic), false);
    }
  } finally {
    console.error = originalError;
  }
});
