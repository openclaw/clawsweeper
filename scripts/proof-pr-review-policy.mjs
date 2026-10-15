// Runs the production queue in workerd + SQLite. GitHub is a local HTTP fixture;
// the clock advances explicitly, so no real reviews, writes or ten-minute sleeps.
// Usage: node scripts/proof-pr-review-policy.mjs TOOL_PREFIX FRESH_OUTPUT_DIR LEGACY_PUBLICATION_SOURCE
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const [toolPrefix, output, legacySource] = process.argv.slice(2);
assert.ok(
  toolPrefix && output && legacySource,
  "expected TOOL_PREFIX FRESH_OUTPUT_DIR LEGACY_PUBLICATION_SOURCE",
);
const legacyPublication = readFileSync(legacySource, "utf8");
const out = path.resolve(output);
mkdirSync(out);
const require = createRequire(path.resolve(toolPrefix, "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const root = process.cwd();
const minute = 60_000;
const t0 = Date.parse("2030-01-01T00:00:00Z");
const key = "openclaw/gogcli#42";
const live = {
  state: "open",
  title: "Fixture PR",
  body: "Original body",
  locked: false,
  labels: [],
  head: { sha: "a".repeat(40) },
  base: { sha: "b".repeat(40) },
  draft: false,
  updated_at: new Date(t0).toISOString(),
};
const dispatches = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = req.url;
  let result;
  if (url.endsWith("/installation")) result = { id: 999 };
  else if (url === "/app/installations/999/access_tokens") result = { token: "fixture-token" };
  else if (url.endsWith("/actions/workflows/sweep.yml")) result = { state: "active" };
  else if (url.endsWith("/pulls/42") || url.endsWith("/issues/42")) result = live;
  else if (url.endsWith("/dispatches")) {
    dispatches.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(204).end();
    return;
  } else {
    res.writeHead(404).end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(result));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const address = `127.0.0.1:${server.address().port}`;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const entry = path.join(out, "worker.ts");
writeFileSync(
  entry,
  `
import { ExactReviewQueue } from ${JSON.stringify(path.join(root, "dashboard/exact-review-queue.ts"))};
import { validateDirectPublicationPlan, validateCanonicalRecordTupleMutation } from ${JSON.stringify(path.join(root, "dashboard/exact-review-direct-publication.ts"))};
import { ExactReviewDirectPublicationStore as LegacyPublicationStore } from 'proof:legacy-publication';
let now = ${t0}; Date.now = () => now;
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) { super(ctx, {...env, hostedTargetPredicate: () => true,
    hostedPublicTargetProbe: async () => 'public'}, () => 0.5); }
  async alarm() {}
  async fetch(request) {
    const input = await request.json(); now = input.now;
    await this.ensureReady();
    let response = Response.json({ok:true});
    if (input.op === 'tick') await super.alarm();
    else if (input.op === 'publish') this.directPublicationStore.accept(
      await validateDirectPublicationPlan(input.data), now);
    else if (input.op === 'reconcile') this.directPublicationStore.acceptCanonicalTupleMutation(
      await validateCanonicalRecordTupleMutation({
        deliveryId: 'reconcile-' + input.data.section,
        key: 'openclaw-gogcli/42',
        operations: ['items', 'closed', 'plans', 'decision-packets'].map(section => ({
          path: 'records/openclaw-gogcli/' + section + '/42.' + (section === 'decision-packets' ? 'json' : 'md'),
          expectedDigest: this.directPublicationStore.readCanonical('openclaw-gogcli', section, 42)?.digest ?? null,
          ...(section === input.data.section ? {contentBase64: input.data.contentBase64} : {}),
        })),
      }), now);
    else if (input.op === 'prune') this.directPublicationStore.pruneTerminalSync(now);
    else if (input.op === 'legacy-publish') {
      this.storage.sql.exec('DROP TABLE exact_review_pull_request_answers');
      const legacy = new LegacyPublicationStore(this.storage);
      legacy.ensureSchemaSync();
      legacy.accept(await validateDirectPublicationPlan(input.data.plan), now);
      if (input.data.prune) legacy.pruneTerminalSync(now + 8 * 24 * 60 * 60_000);
    }
    else if (input.op !== 'inspect') response = await super.fetch(new Request(
      'https://queue/' + input.op, {method:'POST',body:JSON.stringify(input.data)}));
    return Response.json({status:response.status, body:await response.json(),
      items:this.readStateSync().items, alarm:await this.storage.getAlarm()});
  }
}
export default {fetch(request, env) { return env.QUEUE.get(
  env.QUEUE.idFromName(new URL(request.url).pathname.slice(1))).fetch(request); }};
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
  plugins: [
    {
      name: "legacy-publication-fixture",
      setup(build) {
        build.onResolve({ filter: /^proof:legacy-publication$/ }, () => ({
          path: "legacy-publication",
          namespace: "proof",
        }));
        build.onLoad({ filter: /.*/, namespace: "proof" }, () => ({
          contents: legacyPublication,
          loader: "ts",
          resolveDir: path.join(root, "dashboard"),
        }));
      },
    },
  ],
});
const start = () =>
  new Miniflare({
    ...convertV4MiniflareOptions({
      name: "pr-review-policy-proof",
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-07-08",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { QUEUE: { className: "ProofQueue", useSQLite: true } },
      bindings: {
        GITHUB_API_URL: `http://${address}`,
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23fixture",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1",
        EXACT_REVIEW_INITIAL_PR_QUIET_MS: String(10 * minute),
        EXACT_REVIEW_ACTIVE_ITEM_WINDOW_MS: "0",
      },
      outboundService: async (request) =>
        fetch(`http://${address}${new URL(request.url).pathname}`, {
          method: request.method,
          headers: request.headers,
          ...(request.body ? { body: await request.arrayBuffer() } : {}),
        }),
    }),
    resourcePersistencePath: path.join(out, "sqlite"),
  });
let mf = start();
const trace = [];
const call = async (name, op, now, data) => {
  const response = await mf.dispatchFetch(`https://proof/${name}`, {
    method: "POST",
    body: JSON.stringify({ op, now, data }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  trace.push({
    name,
    op,
    minute: (now - t0) / minute,
    status: result.status,
    dispatches: dispatches.length,
    state: result.items[key]?.state,
    nextAttemptAt: result.items[key]?.nextAttemptAt,
    reason: result.body.dedupe_reason,
  });
  return result;
};
const enqueue = (delivery, action = "opened", overrides = {}) => ({
  delivery_id: delivery,
  decision: {
    targetRepo: "openclaw/gogcli",
    targetBranch: "main",
    itemNumber: 42,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: action,
    supersedesInProgress: action === "synchronize",
    sourceHeadSha: live.head.sha,
    sourceHeadVerified: true,
    sourceUpdatedAt: live.updated_at,
    ...overrides,
  },
});
const publication = (status, lifecycle = "router", revision = 1) => {
  const content = `---\ntype: pull_request\nreview_status: ${status}\nreviewed_at: 2030-01-01T00:00:00Z\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\n---\nFixture review.\n`;
  return {
    canonicalTargetKey: key,
    fenceKey: key,
    revision,
    identity: { canonicalTargetKey: key, fenceKey: key, revision, claimGeneration: 1 },
    operations: [
      {
        path: "records/openclaw-gogcli/items/42.md",
        deleted: false,
        mode: "100644",
        bytes: Buffer.byteLength(content),
        contentBase64: Buffer.from(content).toString("base64"),
      },
    ],
    totalBytes: Buffer.byteLength(content),
    lifecycle: { kind: lifecycle },
  };
};
try {
  await call("quiet", "enqueue", t0, enqueue("open"));
  let result = await call("quiet", "tick", t0);
  assert.equal(dispatches.length, 0);
  assert.equal(result.items[key].nextAttemptAt, t0 + 10 * minute);
  live.body = "Cleanup bot changed the body";
  live.updated_at = new Date(t0 + 9 * minute).toISOString();
  result = await call("quiet", "tick", t0 + 10 * minute);
  assert.equal(dispatches.length, 0);
  assert.equal(result.items[key].nextAttemptAt, t0 + 20 * minute);
  result = await call("quiet", "tick", t0 + 20 * minute);
  assert.equal(dispatches.length, 1);
  assert.equal(result.items[key].state, "dispatching");
  await call("quiet", "publish", t0 + 20 * minute + 1000, publication("complete"));
  // Already dispatched work cannot claim after an answer commits.
  const item = result.items[key];
  result = await call("quiet", "claim", t0 + 20 * minute + 1000, {
    item_key: key,
    lease_id: item.leaseId,
    lease_revision: item.leaseRevision,
    run_id: "420",
    run_attempt: 1,
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.reason, "review_request_required");
  assert.equal(result.items[key], undefined);
  await mf.dispose();
  mf = start();
  for (const action of ["synchronize", "scheduled_hot_intake", "scheduled_normal_backfill"]) {
    result = await call("quiet", "enqueue", t0 + 60 * minute, enqueue(action, action));
    assert.equal(result.body.dedupe_reason, "review_request_required", JSON.stringify(result));
    assert.equal(result.items[key], undefined);
  }
  for (const [name, status, lifecycle] of [
    ["failed", "failed", "router"],
    ["stale", "complete", "requeue"],
  ]) {
    await call(name, "publish", t0, publication(status, lifecycle));
    result = await call(name, "enqueue", t0, enqueue(name));
    assert.equal(result.body.queued, true);
  }
  for (const lifecycle of ["router", "requeue"]) {
    const name = "reconcile-" + lifecycle;
    const plan = publication("complete", lifecycle);
    await call(name, "publish", t0, plan);
    for (const section of ["closed", "items"]) {
      let content = Buffer.from(plan.operations[0].contentBase64, "base64").toString();
      if (section === "items") content = content.replace("complete", "stale_reopened");
      await call(name, "reconcile", t0 + minute, {
        section,
        contentBase64: Buffer.from(content).toString("base64"),
      });
    }
    result = await call(name, "enqueue", t0 + minute, enqueue(name, "reopened"));
    if (lifecycle === "requeue") assert.equal(result.body.queued, true);
    else assert.equal(result.body.dedupe_reason, "review_request_required");
  }
  for (const name of [
    "legacy-stale",
    "legacy-valid",
    "legacy-pruned-valid",
    "legacy-unverified",
    "legacy-prune-on-upgrade",
  ]) {
    const plan = publication("complete", name === "legacy-stale" ? "requeue" : "router");
    if (name === "legacy-unverified") {
      const operation = plan.operations[0];
      const content = Buffer.from(operation.contentBase64, "base64")
        .toString()
        .replace("runner_preflight_v1", "unknown");
      operation.contentBase64 = Buffer.from(content).toString("base64");
      operation.bytes = plan.totalBytes = Buffer.byteLength(content);
    }
    await call(name, "legacy-publish", t0, {
      plan,
      prune: name === "legacy-stale" || name === "legacy-pruned-valid",
    });
  }
  await mf.dispose();
  mf = start();
  await call("legacy-prune-on-upgrade", "prune", t0 + 8 * 24 * 60 * minute);
  for (const name of [
    "legacy-stale",
    "legacy-valid",
    "legacy-pruned-valid",
    "legacy-unverified",
    "legacy-prune-on-upgrade",
  ]) {
    result = await call(name, "enqueue", t0 + 8 * 24 * 60 * minute, enqueue(name));
    if (name === "legacy-valid" || name === "legacy-prune-on-upgrade")
      assert.equal(result.body.dedupe_reason, "review_request_required");
    else assert.equal(result.body.queued, true, name);
  }
  result = await call(
    "quiet",
    "enqueue",
    t0 + 61 * minute,
    enqueue("explicit", "manual_explicit_review", { publicationPolicy: "record_comment_only" }),
  );
  assert.equal(result.body.queued, true);
  await call("quiet", "tick", t0 + 61 * minute);
  assert.equal(dispatches.length, 2);
  // The retired automation labels do not reopen a completed PR to automatic review.
  live.labels = ["clawsweeper:autofix"];
  await call("optin", "publish", t0, publication("complete"));
  result = await call("optin", "enqueue", t0, enqueue("optin"));
  assert.equal(result.body.dedupe_reason, "review_request_required");
  await call("optin", "tick", t0);
  assert.equal(dispatches.length, 2);
  live.labels = [];
  const sources = [
    "dashboard/exact-review-queue.ts",
    "dashboard/exact-review-decision.ts",
    "dashboard/exact-review-direct-publication.ts",
    "src/pr-review-policy.ts",
    "src/review-completion.ts",
    "src/clawsweeper-record-metadata.ts",
    "src/maintainer-review-policy.ts",
    "src/clawsweeper-review-planning-inventory.ts",
    "src/clawsweeper-review-presentation.ts",
  ];
  const summary = {
    verdict: "PASS",
    runtime: "workerd + SQLite",
    legacy_publication_sha256: createHash("sha256").update(legacyPublication).digest("hex"),
    trace,
    source_sha256: Object.fromEntries(
      sources.map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]),
    ),
    limits: "GitHub HTTP fixture; no live GitHub/model calls or production mutations.",
  };
  writeFileSync(path.join(out, "result.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
} finally {
  await mf.dispose();
  await new Promise((resolve) => server.close(resolve));
}
