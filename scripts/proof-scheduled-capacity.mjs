import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const [baseRef, toolPrefix, output] = process.argv.slice(2);
assert.ok(baseRef && toolPrefix && output, "expected BASE TOOL_PREFIX FRESH_OUTPUT_DIR");
const require = createRequire(path.resolve(toolPrefix, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const root = process.cwd();
const out = path.resolve(output);
mkdirSync(out, { recursive: true });
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const now = Date.parse("2030-01-01T12:00:00Z");
const files = [
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-read-model.ts",
  "dashboard/worker.ts",
  "dashboard/dashboard-pages.ts",
];
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
let dispatches = [];
let unexpected = 0;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  let body = {};
  let code = 200;
  if (url.pathname.endsWith("/installation")) body = { id: 999 };
  else if (url.pathname === "/app/installations/999/access_tokens") {
    body = {
      token: "synthetic-installation-token",
      expires_at: new Date(now + 3_600_000).toISOString(),
    };
  } else if (url.pathname.endsWith("/actions/workflows/sweep.yml")) body = { state: "active" };
  else if (/\/issues\/\d+$/.test(url.pathname)) body = { state: "open" };
  else if (url.pathname === "/repos/openclaw/clawsweeper/dispatches" && request.method === "POST") {
    let text = "";
    for await (const chunk of request) text += chunk;
    const payload = JSON.parse(text).client_payload;
    dispatches.push(Number(payload.item_number));
    code = 204;
  } else {
    unexpected++;
    code = 501;
  }
  response.writeHead(code, { "content-type": "application/json" });
  response.end(code === 204 ? undefined : JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = `127.0.0.1:${server.address().port}`;
const receipt = {
  base: git("rev-parse", baseRef),
  head: git("rev-parse", "HEAD"),
  working_tree_dirty: Boolean(git("status", "--porcelain")),
  node: process.version,
  workerd: require("workerd/package.json").version,
  runtime: "workerd / SQLite Durable Object / native loopback HTTP",
  sources: {},
  results: {},
};
try {
  for (const variant of ["baseline", "candidate"]) {
    const dir = path.join(out, variant);
    mkdirSync(dir);
    execFileSync("tar", ["-x", "-C", dir], {
      input: execFileSync("git", ["archive", variant === "baseline" ? baseRef : "HEAD"], {
        maxBuffer: 128 * 1024 * 1024,
      }),
    });
    if (variant === "candidate")
      for (const file of files) cpSync(path.join(root, file), path.join(dir, file));
    receipt.sources[variant] = Object.fromEntries(
      files.map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(path.join(dir, file)))
          .digest("hex"),
      ]),
    );
    const entry = path.join(dir, "proof-worker.ts");
    writeFileSync(
      entry,
      `
import { ExactReviewQueue } from './dashboard/exact-review-queue.ts';
Date.now = () => ${now};
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) { super(ctx, {...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => 'public'}, () => 0.5); }
  async fetch(request) {
    const body = await request.json();
    if (body.seed) {
      await super.fetch(new Request('https://queue/stats'));
      const state = this.readStateSync();
      state.items = {};
      for (let n = 1; n <= body.owners; n++) {
        const decision = { targetRepo: 'openclaw/openclaw', targetBranch: 'main', itemNumber: n, itemKind: 'issue', sourceEvent: 'issues', sourceAction: n % 2 ? 'scheduled_hot_intake' : 'scheduled_normal_backfill', supersedesInProgress: false };
        const key = 'openclaw/openclaw#' + n;
        state.items[key] = { key, decision: n === 1 ? {...decision, sourceAction: 'opened'} : decision, leaseDecision: decision, state: n % 2 ? 'leased' : 'dispatching', revision: 1, attempts: 0,
          createdAt: Date.now()-60000, updatedAt: Date.now()-60000, nextAttemptAt: Date.now()-60000,
          leaseId: 'lease-'+n, leaseRevision: 1, leaseExpiresAt: Date.now()+3600000, claimedRunId: String(10000+n), claimedRunAttempt: 1, claimGeneration: 1, claimProtocolVersion: 2 };
        this.lifecycleProjectionStore.recordAdmission({canonicalTargetKey: key, fenceKey: key, revision: 1, deliveryId: 'fixture-'+n, sourceAction: decision.sourceAction, commandOriginated: false, statusMarker: null, statusCommentId: null, observedAt: Date.now()-60000});
      }
      for (const [n, sourceAction] of [[101,'scheduled_hot_intake'],[102,'scheduled_normal_backfill'],...(body.organic ? [[200,'opened']] : [])]) {
        const key = 'openclaw/openclaw#'+n;
        state.items[key] = {key, decision: {targetRepo:'openclaw/openclaw',targetBranch:'main',itemNumber:n,itemKind:'issue',sourceEvent:'issues',sourceAction,supersedesInProgress:false},state:'pending',revision:1,attempts:0,createdAt:Date.now()-120000,updatedAt:Date.now()-120000,nextAttemptAt:Date.now()-1000};
      }
      this.writeStateSync(state);
    }
    if (body.complete) {
      const response = await super.fetch(new Request('https://queue/complete', {method:'POST',body:JSON.stringify({item_key:'openclaw/openclaw#1',lease_id:'lease-1',lease_revision:1,claim_generation:1,run_id:'10001',run_attempt:1,outcome:'success'})}));
      if (!response.ok) return Response.json({completion_status:response.status});
    }
    if (body.tick) await super.alarm();
    const stats = await (await super.fetch(new Request('https://queue/stats'))).json();
    return Response.json({stats,items:Object.values(this.readStateSync().items).map(item => ({number:item.decision.itemNumber,state:item.state,lease_id:item.leaseId})),alarm:await this.storage.getAlarm()});
  }
}
export default {fetch(request,env) {return env.QUEUE.get(env.QUEUE.idFromName(new URL(request.url).pathname)).fetch(request);}};
`,
    );
    const bundle = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["node:*", "cloudflare:*"],
    });
    const mf = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-07-08",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { QUEUE: { className: "ProofQueue", useSQLite: true } },
      bindings: {
        GITHUB_API_URL: `http://${address}`,
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23fixture",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "32",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "24",
        EXACT_REVIEW_SCHEDULED_MAX_CONCURRENT: "8",
        EXACT_REVIEW_TARGET_RATE_PER_HOUR: "60",
        EXACT_REVIEW_TARGET_BURST: "6",
        EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT: "8",
        EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT: "32",
        EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "32",
      },
      outboundService: { external: { address, http: {} } },
    });
    try {
      await mf.ready;
      const call = async (name, body) =>
        (
          await mf.dispatchFetch(`http://proof/${name}`, {
            method: "POST",
            body: JSON.stringify(body),
          })
        ).json();
      dispatches = [];
      await call("mixed", { seed: true, owners: 8, organic: true });
      const mixed = await call("mixed", { tick: true });
      assert.ok(dispatches.includes(200), "organic review must dispatch");
      const firstDispatches = [...dispatches];
      if (variant === "candidate") {
        assert.deepEqual(dispatches, [200]);
        assert.deepEqual(mixed.stats.scheduled_feed.max_concurrent, 8);
        assert.deepEqual(mixed.stats.scheduled_feed.active, 8);
        assert.equal(mixed.stats.lanes.publication.capacity_control.maximum, 32);
        await call("mixed", { complete: true });
        await call("mixed", { tick: true });
        assert.equal(dispatches.filter((n) => n === 101 || n === 102).length, 1);
      } else assert.equal(dispatches.filter((n) => n === 101 || n === 102).length, 2);
      const afterCompletion = [...dispatches];
      dispatches = [];
      const held = await call("lowered", { seed: true, owners: 12 });
      const lowered = await call("lowered", { tick: true });
      if (variant === "candidate") {
        assert.equal(dispatches.length, 0);
        assert.equal(lowered.items.filter((item) => item.number <= 12 && item.lease_id).length, 12);
        assert.ok(Date.parse(lowered.stats.next_wake_at) > now + 1_000);
      }
      receipt.results[variant] = {
        first_dispatches: firstDispatches,
        after_completion_dispatches: afterCompletion,
        lowered_cap_dispatches: [...dispatches],
        active_owners_retained: lowered.items.filter((item) => item.number <= 12 && item.lease_id)
          .length,
        full_cap_next_wake_delay_ms: Date.parse(held.stats.next_wake_at) - now,
      };
    } finally {
      await mf.dispose();
    }
  }
  assert.equal(unexpected, 0, "unexpected external fixture route");
  receipt.limits =
    "Synthetic GitHub service, RSA credential and queue state; actual admission, dispatch, completion, alarm and SQLite owners. No live inference, production state or GitHub mutations. Baseline uses identical configured bounds but has no scheduled-cap implementation.";
  writeFileSync(path.join(out, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
