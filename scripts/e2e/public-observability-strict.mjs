import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Pass an external prefix containing the repository's pinned Wrangler toolchain.
const require = createRequire(resolve(process.argv[2], "package.json"));
const { build } = require("esbuild");
const { Miniflare } = require("miniflare");
const base = process.argv[3];
assert.match(base ?? "", /^[a-f0-9]{40}$/);
const sourcePath = "dashboard/public-observability.ts";
const source = readFileSync(sourcePath, "utf8");
const baseline = execFileSync("git", ["show", `${base}:${sourcePath}`], { encoding: "utf8" });
const observations = [];
const entry = `
import worker from './dashboard/worker.ts';
import { ExactReviewQueue, EXACT_REVIEW_QUEUE_NAME } from './dashboard/exact-review-queue.ts';
import { ExactReviewLifecycleTelemetryStore } from './dashboard/exact-review-lifecycle-telemetry.ts';
Date.now = () => Date.parse('2026-09-12T12:00:00Z');
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) { super(ctx, env); this.proofStorage = ctx.storage; }
  async fetch(request) {
    if (new URL(request.url).pathname !== '/seed') return super.fetch(request);
    const store = new ExactReviewLifecycleTelemetryStore(this.proofStorage);
    store.ensureSchemaSync();
    this.proofStorage.sql.exec("INSERT INTO exact_review_lifecycle_telemetry_direct_v1 VALUES (?, ?, ?, ?, ?, ?, ?)",
      'synthetic-direct', 'synthetic/private#1', 'synthetic-fence', 1, 1, 'accepted', Date.now() - 60000);
    this.proofStorage.sql.exec("INSERT INTO exact_review_lifecycle_telemetry_batch_v1 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      'synthetic-batch', 'synthetic-batch-id', 'synthetic/private#2', 'synthetic-fence', 1, 1, 'retryable', Date.now() - 60000);
    return Response.json({ seeded: 2 });
  }
  async alarm() {} // Fixture has no queued work or external dispatch.
}
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/seed')
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName(EXACT_REVIEW_QUEUE_NAME)).fetch(request);
    return worker.fetch(request, env, ctx);
  }
};`;

for (const [variant, contents] of [
  ["base", baseline],
  ["candidate", source],
]) {
  const persist = mkdtempSync(join(tmpdir(), "public-observability-proof-"));
  const bundle = await build({
    stdin: { contents: entry, sourcefile: "proof.ts", resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2024",
    plugins: [
      {
        name: "projection-source",
        setup(builder) {
          builder.onLoad({ filter: /\/dashboard\/public-observability\.ts$/ }, () => ({
            contents,
            loader: "ts",
          }));
        },
      },
    ],
  });
  const options = {
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-05-11",
    durableObjects: { EXACT_REVIEW_QUEUE: { className: "ProofQueue", useSQLite: true } },
    durableObjectsPersist: persist,
    outboundService: () => {
      throw new Error("External request forbidden");
    },
  };
  let runtime = new Miniflare(options);
  try {
    const responseBodies = [];
    const read = async (window) => {
      const response = await runtime.dispatchFetch(
        `https://proof/api/recent-durable-publication-events?window=${window}`,
      );
      assert.equal(response.status, 200);
      const body = await response.text();
      responseBodies.push(body);
      const result = JSON.parse(body).recent_durable_publication_events;
      assert.ok(result);
      assert.equal(JSON.stringify(result).includes("synthetic"), false);
      return result;
    };
    const idle = await read("24h");
    assert.equal(idle.activity.state, "idle");
    assert.equal((await runtime.dispatchFetch("https://proof/seed")).status, 200);
    // Drop the intentional short-lived aggregate cache without advancing the fixture clock.
    await runtime.dispose();
    runtime = new Miniflare(options);
    const populated = [];
    for (const window of ["6h", "24h", "7d"]) {
      const result = await read(window);
      assert.equal(result.direct.counts.accepted, 1);
      assert.equal(result.batch.counts.retryable, 1);
      assert.equal(result.activity.state, "observed");
      populated.push(result);
    }
    await runtime.dispose();
    runtime = new Miniflare(options);
    assert.deepEqual(await read("24h"), populated[1]);
    observations.push({ variant, idle, populated, responseBodies });
  } finally {
    await runtime.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
}
assert.deepEqual(observations[0].idle, observations[1].idle);
assert.deepEqual(observations[0].populated, observations[1].populated);
assert.deepEqual(observations[0].responseBodies, observations[1].responseBodies);
console.log(
  JSON.stringify(
    {
      base,
      head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      source_sha256: createHash("sha256").update(source).digest("hex"),
      runtime: "built Worker in workerd with persistent SQLite Durable Objects",
      cases: ["idle", "6h", "24h", "7d", "restart"],
      response_sha256: createHash("sha256")
        .update(JSON.stringify(observations[1].responseBodies))
        .digest("hex"),
      byte_identical: true,
      private_fixture_identifiers_disclosed: false,
      production_mutations: 0,
      limits:
        "Synthetic persisted publication events; no GitHub transport or production deployment. Other projection edge cases use the existing unit suite.",
    },
    null,
    2,
  ),
);
