import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

// Install the pinned Wrangler proof toolchain outside the repository, then pass its prefix.
const require = createRequire(path.resolve(process.argv[2], "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const persist = mkdtempSync(path.join(tmpdir(), "etag-split-"));
const secret = "synthetic-etag-split-hmac";
const sourceFiles = [
  "dashboard/worker.ts",
  "dashboard/github-etag-cache.ts",
  "dashboard/exact-review-queue.ts",
  "dashboard/wrangler.toml",
];
const observations = [];
let runtime;
const bundle = await build({
  entryPoints: ["dashboard/worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2024",
});
const options = {
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-05-11",
  bindings: { CLAWSWEEPER_WEBHOOK_SECRET: secret },
  // Deliberately omit EXACT_REVIEW_QUEUE: all etag requests must remain independent.
  durableObjects: { GITHUB_ETAG_CACHE: { className: "GithubEtagCache", useSQLite: true } },
  durableObjectsPersist: persist,
  outboundService: () => {
    throw new Error("Proof must not access an external service");
  },
};
const key = { credential_pool: "target_app", route: "/repos/openclaw/openclaw/issues/7" };
async function request(operation, body, signatureSecret = secret) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const response = await runtime.dispatchFetch(
    `https://proof/internal/exact-review/github-etag-cache/${operation}`,
    {
      method: "POST",
      headers: {
        "x-clawsweeper-exact-review-signature":
          "sha256=" + createHmac("sha256", signatureSecret).update(text).digest("hex"),
      },
      body: text,
    },
  );
  const value = await response.json();
  observations.push({ operation, status: response.status, ...value });
  return { status: response.status, value };
}
try {
  runtime = new Miniflare(options);
  assert.equal((await request("store", key, "wrong-synthetic-secret")).status, 401);
  assert.deepEqual((await request("lookup", key)).value, { ok: true, hit: false, entry: null });
  const stored = await request("store", { ...key, etag: '"v1"', body: '{"number":7}' });
  assert.equal(stored.status, 201);
  assert.equal(
    stored.value.entry.bodyDigest,
    createHash("sha256").update('{"number":7}').digest("hex"),
  );
  const entry = stored.value.entry;
  assert.deepEqual((await request("lookup", key)).value.entry, entry);
  const other = { ...key, route: "/repos/openclaw/clawsweeper/issues/7" };
  assert.equal((await request("lookup", other)).value.hit, false);
  const confirmation = { ...key, etag: entry.etag, body_digest: entry.bodyDigest };
  assert.equal((await request("confirm", confirmation)).value.body, '{"number":7}');
  for (const operation of ["lookup", "store", "confirm"]) {
    assert.equal((await request(operation, "invalid-json")).status, 400);
  }
  assert.deepEqual(
    (await request("confirm", { ...confirmation, body_digest: "a".repeat(64) })).value,
    { ok: true, confirmed: false, reason: "entry_changed_or_expired" },
  );
  const namespace = await runtime.getDurableObjectNamespace("GITHUB_ETAG_CACHE");
  async function telemetry(shard) {
    return (
      await (await namespace.get(namespace.idFromName(shard)).fetch("https://cache/stats")).json()
    ).telemetry;
  }
  assert.deepEqual(await telemetry("openclaw/openclaw"), {
    cache_miss: 1,
    cache_hit: 1,
    cache_200_stored: 1,
    cache_304_served: 1,
    cache_skip: 1,
  });
  assert.deepEqual(await telemetry("openclaw/clawsweeper"), { cache_miss: 1 });
  assert.deepEqual(await telemetry("fallback"), {});
  await runtime.dispose();
  runtime = new Miniflare(options);
  assert.equal((await request("lookup", key)).value.hit, true);
  assert.equal((await request("confirm", confirmation)).value.body, '{"number":7}');
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  console.log(
    JSON.stringify(
      {
        head,
        source_sha256: Object.fromEntries(
          sourceFiles.map((file) => [
            file,
            createHash("sha256").update(readFileSync(file)).digest("hex"),
          ]),
        ),
        runtime: "workerd / SQLite Durable Objects",
        queue_binding: "absent",
        shard_stats: "verified independent counters for two repositories and fallback",
        restart_persistence: "verified",
        external_requests: 0,
        observations,
        limits:
          "Synthetic HMAC and bodies; no production deploy, GitHub requests, migration application, or load-reduction claim.",
      },
      null,
      2,
    ),
  );
} finally {
  await runtime?.dispose();
  rmSync(persist, { recursive: true, force: true });
}
