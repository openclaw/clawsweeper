// Controlled workerd proof; tooling is the repository-pinned Wrangler installed
// outside the checkout. No deployment, credentials, or external calls are used.
// node scripts/proof-queue-completion.mjs BASE TOOL_PREFIX FRESH_OUTPUT_DIR
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [baseRef, toolPrefix, output] = process.argv.slice(2);
assert.ok(baseRef && toolPrefix && output, "expected BASE TOOL_PREFIX FRESH_OUTPUT_DIR");
const require = createRequire(path.resolve(toolPrefix, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const root = process.cwd();
const out = path.resolve(output);
mkdirSync(out);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const base = git("rev-parse", `${baseRef}^{commit}`);
const head = git("rev-parse", "HEAD");
const now = Date.parse("2030-01-01T12:00:00Z");
const changed = [
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-lifecycle.ts",
  "dashboard/exact-review-lifecycle-telemetry.ts",
];
const results = {};
const manifest = {
  base,
  head,
  runtime: "workerd / SQLite Durable Object",
  fixture: { pending_publications: 300, leased_reviews: 50, pending_reviews: 15 },
  sources: {},
};
for (const variant of ["baseline", "patched"]) {
  const dir = path.join(out, variant);
  mkdirSync(dir);
  execFileSync("tar", ["-x", "-C", dir], {
    input: execFileSync("git", ["archive", base], { maxBuffer: 128 * 1024 * 1024 }),
  });
  if (variant === "patched")
    for (const file of changed) cpSync(path.join(root, file), path.join(dir, file));
  manifest.sources[variant] = Object.fromEntries(
    changed.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(dir, file)))
        .digest("hex"),
    ]),
  );
  const entry = `
import { ExactReviewQueue } from './dashboard/exact-review-queue.ts';
Date.now = () => ${now};
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) {
    const counts = { sql: 0 };
    const storage = new Proxy(ctx.storage, { get(target, key) {
      if (key === 'sql') return { exec: (...args) => { counts.sql++; return target.sql.exec(...args); } };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    super({storage, blockConcurrencyWhile: ctx.blockConcurrencyWhile.bind(ctx)}, {...env, EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: '1', hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => 'public'}, () => 0.5);
    this.counts = counts;
  }
  async fetch(request) {
    const body = await request.json();
    if (body.seed) {
      await super.fetch(new Request('https://queue/stats'));
      for (let n = 1; n <= 365; n++) {
        const key = 'openclaw/openclaw#' + n;
        const producerDecision = {targetRepo: 'openclaw/openclaw', targetBranch: 'main', itemNumber: n, itemKind: 'issue', sourceEvent: 'issues', sourceAction: 'opened', supersedesInProgress: false, ...(n % 5 === 0 ? {additionalPrompt: 'Synthetic source evidence. '.repeat(160)} : {})};
        const publication = {artifactName: 'exact-review-' + (10000+n) + '-1', producerRunId: String(10000+n), producerRunAttempt: 1, sourceSha: 'a'.repeat(40), itemKey: key, protocolVersion: 2, leaseRevision: 1, claimGeneration: 1, liveProceeded: true, liveTerminalNoop: false, liveTerminalMissing: false, liveGuardedOpen: false, producerDecision};
        const decision = n <= 300 ? {...producerDecision, sourceAction: 'exact_review_artifact_publish', publication} : producerDecision;
        const item = {key: n <= 300 ? key + '@publish:' + (10000+n) + ':1' : key, decision, state: n <= 300 || n > 350 ? 'pending' : 'leased', revision: 1, attempts: 0, createdAt: Date.now()-60000-n, updatedAt: Date.now()-60000, nextAttemptAt: Date.now()+60000,
          ...(n > 300 && n <= 350 ? {leaseDecision: decision, leaseId: 'lease-'+n, leaseRevision: 1, leaseExpiresAt: Date.now()+3600000, claimedRunId: String(10000+n), claimedRunAttempt: 1, claimGeneration: 1, claimProtocolVersion: 2} : {})};
        if (body.legacy && n === 301) {
          delete item.claimGeneration;
          item.claimProtocolVersion = 1;
        }
        this.storage.sql.exec('INSERT INTO exact_review_queue_items (item_key,item_json) VALUES (?,?)', item.key, JSON.stringify(item));
        this.storage.sql.exec('INSERT INTO exact_review_publication_heads (target_key,source_revision,updated_at) VALUES (?,1,?)', key, Date.now());
        if (!body.legacy || n !== 301) this.lifecycleProjectionStore.recordAdmission({canonicalTargetKey: key, fenceKey: item.key, revision: 1, deliveryId: 'fixture-'+n, sourceAction: 'opened', commandOriginated: n === 41, statusMarker: null, statusCommentId: n === 41 ? 41 : null, observedAt: Date.now()-60000});
        if (body.terminal && n === 301) {
          const driver = {...item, key: item.key+'@finalizer', decision: {...decision, sourceAction: 'exact_review_artifact_publish', publication, statusCommentId: 41}, terminalFinalization: {disposition: 'policy_noop', statusState: 'Complete', statusDetail: 'No action required.', projection: {canonicalTargetKey: 'openclaw/openclaw#41', fenceKey: 'openclaw/openclaw#41@publish:10041:1', revision: 1}}};
          this.storage.sql.exec('INSERT INTO exact_review_queue_items (item_key,item_json) VALUES (?,?)', driver.key, JSON.stringify(driver));
        }
      }
      this.storage.sql.exec('UPDATE exact_review_queue_meta SET migrated_at = ?', Date.now()-172800000);
      this.migratedAt = Date.now()-172800000;
      this.storage.kv.delete('exact-review-queue');
      await super.fetch(new Request('https://queue/stats'));
      if (body.legacy) await this.storage.setAlarm(Date.now()+3600000);
      return Response.json({seeded: true});
    }
    if (body.snapshot) {
      const tables = ['exact_review_queue_items', 'exact_review_queue_metrics', 'exact_review_queue_metric_buckets', 'exact_review_lifecycle_projection_v1'];
      return Response.json({tables: Object.fromEntries(tables.map(table => [table, [...this.storage.sql.exec('SELECT * FROM '+table+' ORDER BY rowid')]])), alarm: await this.storage.getAlarm(), stats: await (await super.fetch(new Request('https://queue/stats'))).json()});
    }
    this.counts.sql = 0;
    const response = await super.fetch(new Request('https://queue'+body.path, {method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body.payload)}));
    return Response.json({status: response.status, body: await response.json(), sql: this.counts.sql});
  }
}
export default { fetch(request, env) { return env.QUEUE.get(env.QUEUE.idFromName(new URL(request.url).pathname)).fetch(request); } };
`;
  writeFileSync(path.join(dir, "proof-worker.ts"), entry);
  const bundle = await build({
    entryPoints: [path.join(dir, "proof-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
  });
  let externalCalls = 0;
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-08",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { QUEUE: { className: "ProofQueue", useSQLite: true } },
    outboundService: () => {
      externalCalls++;
      throw new Error("proof forbids external requests");
    },
  });
  try {
    results[variant] = {};
    for (const route of [
      "complete-success",
      "complete-failure",
      "complete-legacy-success",
      "complete-legacy-failure",
      "lifecycle/router-receipt",
      "terminal-finalization/attempt",
      "heartbeat",
    ]) {
      const call = async (body) =>
        (
          await mf.dispatchFetch("http://proof/" + route, {
            method: "POST",
            body: JSON.stringify(body),
          })
        ).json();
      assert.deepEqual(
        await call({
          seed: true,
          terminal: route === "terminal-finalization/attempt",
          legacy: route.startsWith("complete-legacy-"),
        }),
        { seeded: true },
      );
      const tuple = {
        item_key:
          "openclaw/openclaw#301" + (route === "terminal-finalization/attempt" ? "@finalizer" : ""),
        lease_id: "lease-301",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "10301",
        run_attempt: 1,
      };
      const payload = route.startsWith("complete-legacy-")
        ? {
            lease_id: tuple.lease_id,
            run_id: tuple.run_id,
            run_attempt: tuple.run_attempt,
            outcome: route.endsWith("success") ? "success" : "failure",
            ...(route.endsWith("failure")
              ? { retry_at: new Date(now + 30_000).toISOString() }
              : {}),
          }
        : route.startsWith("complete-")
          ? { ...tuple, outcome: route === "complete-success" ? "success" : "failure" }
          : route === "lifecycle/router-receipt"
            ? {
                canonical_target_key: "openclaw/openclaw#1",
                fence_key: "openclaw/openclaw#1@publish:10001:1",
                revision: 1,
                receipt_id: "proof-receipt",
              }
            : {
                ...tuple,
                ...(route === "terminal-finalization/attempt" ? { status_comment_id: 41 } : {}),
              };
      const result = await call({
        path: route.startsWith("complete-") ? "/complete" : "/" + route,
        payload,
      });
      assert.equal(result.status, 200, JSON.stringify(result));
      const snapshot = await call({ snapshot: true });
      if (route.startsWith("complete-legacy-")) {
        const failed = route.endsWith("failure");
        assert.deepEqual(result.body, { ok: true, requeued: failed });
        assert.equal(snapshot.alarm, now + (failed ? 30_000 : 60_000));
        const completed = snapshot.tables.exact_review_queue_items.find(
          (row) => row.item_key === tuple.item_key,
        );
        if (failed) {
          const item = JSON.parse(completed.item_json);
          assert.equal(item.state, "pending");
          assert.equal(item.nextAttemptAt, now + 30_000);
        } else assert.equal(completed, undefined);
        assert.equal(
          snapshot.tables.exact_review_lifecycle_projection_v1.some(
            (row) => row.fence_key === tuple.item_key,
          ),
          false,
        );
      }
      // No trace ids, credentials, or production data enter the artifacts.
      writeFileSync(
        path.join(out, variant + "-" + route.replaceAll("/", "-") + ".json"),
        JSON.stringify({ result, snapshot }, null, 2) + "\n",
      );
      results[variant][route] = { result, snapshot };
    }
    assert.equal(externalCalls, 0);
  } finally {
    await mf.dispose();
  }
}
for (const route of Object.keys(results.baseline)) {
  assert.deepEqual(
    results.patched[route].result.body,
    results.baseline[route].result.body,
    route + " response",
  );
  assert.deepEqual(
    results.patched[route].snapshot,
    results.baseline[route].snapshot,
    route + " durable state / admission / alarm",
  );
}
manifest.results = Object.fromEntries(
  Object.keys(results.baseline).map((route) => [
    route,
    {
      equivalent: true,
      before_sql: results.baseline[route].result.sql,
      after_sql: results.patched[route].result.sql,
    },
  ]),
);
manifest.limits =
  "Synthetic local workerd, no network effects or production CPU prediction; one extra publication driver for terminal-finalization.";
writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
