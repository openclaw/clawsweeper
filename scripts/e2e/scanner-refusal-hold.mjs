import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import YAML from "yaml";

const root = path.resolve(process.argv[2] || ".");
const before = process.argv.includes("--before");
fs.mkdirSync(".artifacts", { recursive: true });
const dir = fs.mkdtempSync(path.resolve(".artifacts/scanner-hold-"));
const origin = "http://127.0.0.1:8798";
const secret = "synthetic-scanner-hold-proof";
const certificate = path.join(dir, "loopback.crt");
const certificateKey = path.join(dir, "loopback.key");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    certificateKey,
    "-out",
    certificate,
  ],
  { stdio: "ignore" },
);
const tlsProxy = createHttpsServer(
  { key: fs.readFileSync(certificateKey), cert: fs.readFileSync(certificate) },
  async (req, res) => {
    try {
      const target =
        req.url === "/internal/exact-review/enqueue"
          ? "http://127.0.0.1:8798/internal/exact-review/enqueue"
          : req.url === "/internal/exact-review/admission-capabilities"
            ? "http://127.0.0.1:8798/internal/exact-review/admission-capabilities"
            : null;
      if (req.method !== "POST" || !target) {
        res.writeHead(400);
        res.end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const reply = await fetch(target, {
        method: "POST",
        redirect: "error",
        headers: req.headers,
        ...(body ? { body } : {}),
      });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(await reply.text());
    } catch {
      res.writeHead(502);
      res.end();
    }
  },
);
await new Promise((resolve) => tlsProxy.listen(8799, "127.0.0.1", resolve));
const nonce = String(Date.now());
const trace = [],
  results = [],
  dispatches = [];
let child,
  epoch = "1",
  targetState = "open";
const head = "a".repeat(40);
const decision = (n, extra = {}) => ({
  targetRepo: "openclaw/gogcli",
  targetBranch: "main",
  itemNumber: n,
  itemKind: "pull_request",
  sourceEvent: "pull_request",
  sourceAction: "opened",
  supersedesInProgress: false,
  sourceHeadSha: head,
  sourceUpdatedAt: "2026-09-01T00:00:00Z",
  ...extra,
});
const fixture = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const u = new URL(req.url, "http://127.0.0.1:8898");
  const reply = (body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  trace.push({ method: req.method, path: u.pathname });
  if (u.pathname.endsWith("/installation")) return reply({ id: 999 });
  if (u.pathname === "/app/installations/999/access_tokens")
    return reply({ token: "synthetic-token", expires_at: "2099-01-01T00:00:00Z" });
  if (u.pathname.endsWith("/actions/workflows/sweep.yml")) return reply({ state: "active" });
  if (u.pathname.endsWith("/dispatches")) {
    dispatches.push(JSON.parse(raw));
    return reply({}, 204);
  }
  if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname))
    return reply({
      full_name: u.pathname.slice(7),
      private: false,
      visibility: "public",
      archived: false,
      disabled: false,
      default_branch: "main",
    });
  if (/\/(pulls|issues)\/\d+$/.test(u.pathname))
    return reply({
      number: Number(u.pathname.split("/").at(-1)),
      state: targetState,
      head: { sha: "b".repeat(40) },
      base: { sha: "c".repeat(40) },
      body: "changed source",
      title: "Synthetic fixture",
      draft: false,
      updated_at: "2026-09-27T00:00:00Z",
    });
  return reply({ message: "unexpected fixture request" }, 404);
});
await new Promise((r) => fixture.listen(8898, "127.0.0.1", r));
const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
fs.writeFileSync(
  path.join(dir, ".dev.vars"),
  `CLAWSWEEPER_APP_PRIVATE_KEY=${JSON.stringify(privateKey)}\n`,
);
fs.writeFileSync(
  path.join(dir, "worker.ts"),
  `
import application, { StatusStore } from ${JSON.stringify(path.join(root, "dashboard/worker.ts"))};
import { ExactReviewQueue as ProductionQueue } from ${JSON.stringify(path.join(root, "dashboard/exact-review-queue.ts"))};
export { StatusStore };
export class ExactReviewQueue extends ProductionQueue {
  async fetch(request, ...args) {
    const route = new URL(request.url).pathname;
    if (!route.startsWith('/__proof/')) return super.fetch(request, ...args);
    await super.fetch(new Request('https://queue/stats'));
    if (route === '/__proof/identity') return Response.json({ nonce: ${JSON.stringify(nonce)} });
    if (route === '/__proof/state') return Response.json(this['readStateSync']());
    if (route === '/__proof/lifecycle') {
      const {key, revision = 1} = await request.json();
      return Response.json(this['lifecycleProjectionStore'].read(key, key, revision));
    }
    if (route === '/__proof/alarm') { await request.text(); await super.alarm(); return Response.json({ok:true}); }
    if (route === '/__proof/seed') {
      const {decision, successor} = await request.json();
      const now = Date.now(), key = decision.targetRepo + '#' + decision.itemNumber;
      const state = this['readStateSync']();
      const item = { key, decision, leaseDecision: {...decision}, state:'leased', revision:1,
        createdAt:now-60000, updatedAt:now-60000, nextAttemptAt:now, attempts:0,
        reviewRetryPolicyEpoch:this['env'].EXACT_REVIEW_RETRY_POLICY_EPOCH,
        leaseId:'lease-'+decision.itemNumber, leaseRevision:1, leaseExpiresAt:now+3600000,
        claimedAt:now-60000, claimedRunId:'1000', claimedRunAttempt:1, claimGeneration:1, claimProtocolVersion:2 };
      this['recordLifecycleAdmission'](item, decision, now, undefined, true);
      if (successor) { item.revision=2; item.decision=successor; }
      state.items[key]=item;
      this['writeStateSync'](state);
      return Response.json({key});
    }
    return Response.json({error:'unknown fixture route'}, {status:404});
  }
}
export default { fetch(request, env, ctx) {
  if (new URL(request.url).pathname.startsWith('/__proof/')) return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName('global')).fetch(request);
  return application.fetch(request, env, ctx);
}};
`,
);
const config = () =>
  fs.writeFileSync(
    path.join(dir, "wrangler.toml"),
    `
name = "scanner-hold-local-proof"
main = "worker.ts"
compatibility_date = "2026-05-11"
[[durable_objects.bindings]]
name = "EXACT_REVIEW_QUEUE"
class_name = "ExactReviewQueue"
[[durable_objects.bindings]]
name = "STATUS_STORE"
class_name = "StatusStore"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["ExactReviewQueue", "StatusStore"]
[vars]
GITHUB_API_URL = "http://127.0.0.1:8898"
CLAWSWEEPER_APP_CLIENT_ID = "synthetic-scanner-proof"
CLAWSWEEPER_WEBHOOK_SECRET = "${secret}"
EXACT_REVIEW_OPERATOR_SECRET = "${secret}"
PUBLIC_BAY_REPOS = "openclaw/gogcli,openclaw/clawsweeper"
TARGET_REPOS = "openclaw/gogcli,openclaw/clawsweeper"
EXACT_REVIEW_RETRY_POLICY_EPOCH = "${epoch}"
EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED = "1"
EXACT_REVIEW_TARGET_RATE_PER_HOUR = "60"
EXACT_REVIEW_DISPATCH_DEBOUNCE_MS = "300000"
EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS = "300000"
`,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function start() {
  config();
  const log = fs.openSync(path.join(dir, "worker.log"), "a");
  child = spawn(
    "npx",
    [
      "--yes",
      "wrangler@4.131.1",
      "dev",
      "--config",
      path.join(dir, "wrangler.toml"),
      "--local",
      "--persist-to",
      path.join(dir, "state"),
      "--ip",
      "127.0.0.1",
      "--port",
      "8798",
    ],
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  fs.closeSync(log);
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("Worker exited: " + dir);
    try {
      const r = await fetch(origin + "/__proof/identity");
      if (r.ok && (await r.json()).nonce === nonce) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("Worker readiness timeout: " + dir);
}
async function stop() {
  if (!child) return;
  const c = child;
  child = null;
  process.kill(-c.pid, "SIGTERM");
  await Promise.race([once(c, "exit"), sleep(5000)]);
}
async function call(route, body, expected = 200) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(origin + route, {
    method: raw ? "POST" : "GET",
    body: raw,
    signal: AbortSignal.timeout(15000),
    headers: raw
      ? {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature":
            "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"),
        }
      : {},
  });
  const json = await res.json();
  assert.equal(res.status, expected, JSON.stringify({ route, json }));
  return json;
}
const state = () => call("/__proof/state");
const item = async (n) => (await state()).items["openclaw/gogcli#" + n];
const seed = (n, extra = {}, successor) =>
  call("/__proof/seed", { decision: decision(n, extra), successor });
const complete = (n, reason = "findings") =>
  call("/internal/exact-review/complete", {
    lease_id: "lease-" + n,
    item_key: "openclaw/gogcli#" + n,
    lease_revision: 1,
    claim_generation: 1,
    run_id: "1000",
    run_attempt: 1,
    outcome: "failure",
    ...(reason ? { review_failure_reason: reason } : {}),
  });
const enqueue = (n, id, extra = {}) =>
  call("/internal/exact-review/enqueue", { delivery_id: id, decision: decision(n, extra) }, 202);
try {
  await start();
  for (const target of [
    "@example.invalid/path",
    "https://example.invalid/",
    "//example.invalid/",
    "/__proof/state",
    "/internal/exact-review/enqueue?redirect=1",
  ]) {
    await new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: 8799,
          path: target,
          method: "POST",
          ca: fs.readFileSync(certificate),
        },
        (response) => {
          response.resume();
          try {
            assert.equal(response.statusCode, 400, target);
            resolve();
          } catch (error) {
            reject(error);
          }
        },
      );
      request.on("error", reject);
      request.end();
    });
  }
  results.push(
    "HTTPS relay rejects malformed and non-allowlisted request targets; destinations are fixed and redirects disabled",
  );
  await seed(145500);
  assert.equal((await complete(145500)).requeued, false);
  const cross = await enqueue(145500, "schedule-first", {
    sourceAction: "scheduled_normal_backfill",
  });
  if (before) {
    assert.equal(cross.queued, true);
    results.push("base reproduces cross-producer readmission after terminal refusal");
  } else {
    assert.equal(cross.dedupe_reason, "scanner_refused");
    await stop();
    await start();
    const held = await item(145500);
    for (const sourceAction of [
      "scheduled_hot_intake",
      "scheduled_normal_backfill",
      "failed_review_shard_recovery",
      "reopened",
      "synchronize",
      "branch_repaired",
    ]) {
      const r = await enqueue(145500, "producer-" + sourceAction, {
        sourceAction,
        sourceHeadSha: "b".repeat(40),
        sourceUpdatedAt: new Date().toISOString(),
      });
      assert.notEqual(r.queued, true);
    }
    assert.deepEqual(await item(145500), held);
    for (targetState of ["closed", "open"]) await call("/__proof/alarm", {});
    assert.deepEqual(await item(145500), held);
    assert.equal(dispatches.length, 0);
    results.push(
      "persistent hold survives Worker restart, cross-producer source drift, close/reopen and real alarm",
    );
    const projection = await call("/__proof/lifecycle", { key: held.key });
    assert.equal(projection.terminalDisposition.kind, "failure");
    const stats = await call("/api/exact-review-queue");
    assert.equal(stats.lanes.review.parked_reasons.scanner_refused, 1);
    assert.equal(stats.lanes.review.active, 0);
    assert.equal(stats.bay_projection.total, 0);
    results.push(
      "public parked reason retained, no active queue/Bay review, terminal lifecycle failure",
    );
    const expected = { item_key: held.key, revision: held.revision, updated_at_ms: held.updatedAt };
    for (const [route, body] of [
      ["resolve", { items: [expected], note: "closed" }],
      [
        "recover-fresh",
        {
          items: [{ ...expected, source_head_sha: "b".repeat(40) }],
          idempotency_key: "source-change",
          override_retry_budget: true,
        },
      ],
    ]) {
      const r = await call("/internal/exact-review/parked-reviews/" + route, body);
      assert.equal(r.skipped, 1);
    }
    results.push("operator closed/source recovery cannot discard the hold");
    const stale = {
      sourceAction: "re_review",
      sourceCommentId: 8000,
      sourceCommentUpdatedAt: new Date(held.scannerRefusal.observedAt - 1000).toISOString(),
      commandBodyDigest: "d".repeat(64),
      commandOrigin: "hosted_webhook",
      sourceCommentVerified: true,
      commandStatusMarker: "<!-- clawsweeper-command-status:145500:re_review:new -->",
    };
    assert.equal((await enqueue(145500, "stale-command", stale)).reason, "scanner_refused");
    assert.equal(
      (
        await enqueue(145500, "fresh-command", {
          ...stale,
          sourceCommentUpdatedAt: new Date(
            Math.floor(held.scannerRefusal.observedAt / 1000) * 1000,
          ).toISOString(),
        })
      ).queued,
      true,
    );
    assert.equal((await item(145500)).decision.additionalPrompt, undefined);
    assert.ok((await item(145500)).revision > held.revision);
    results.push(
      "stale verified command blocked; fresh verified command releases once without inherited prompt",
    );
    await seed(145501, {
      sourceAction: "re_review",
      commandStatusMarker: "<!-- clawsweeper-command-status:145501:re_review:old -->",
      additionalPrompt: "failed instructions",
    });
    await complete(145501);
    const manual = {
      sourceAction: "manual_explicit_review",
      publicationPolicy: "record_comment_only",
    };
    assert.equal((await enqueue(145501, "manual:1000:145501", manual)).reason, "scanner_refused");
    assert.equal((await enqueue(145501, "manual:1001:145501", manual)).queued, true);
    assert.equal((await item(145501)).decision.commandStatusMarker, undefined);
    assert.equal((await enqueue(145501, "manual:1001:145501", manual)).queued, true);
    results.push(
      "new explicit manual request releases; old workflow rerun does not; delivery replay is idempotent",
    );
    const opaqueId = "manual:incident.1455:retry-1:145507";
    await seed(145507, { ...manual, sourceDeliveryId: opaqueId });
    await complete(145507);
    assert.equal((await enqueue(145507, opaqueId, manual)).reason, "scanner_refused");
    const nextOpaqueId = "manual:incident.1455:retry-2:145507";
    assert.equal((await enqueue(145507, nextOpaqueId, manual)).queued, true);
    assert.equal((await item(145507)).decision.sourceDeliveryId, nextOpaqueId);
    results.push(
      "opaque manual request IDs release a hold, while replay of the failed identity remains blocked without a delivery receipt",
    );
    await seed(
      145502,
      {},
      decision(145502, { sourceAction: "synchronize", sourceHeadSha: "b".repeat(40) }),
    );
    assert.equal((await complete(145502)).requeued, false);
    await seed(145503, { itemKind: "issue", sourceEvent: "issues" });
    await complete(145503);
    assert.equal(
      (
        await enqueue(145503, "issue-comment", {
          itemKind: "issue",
          sourceEvent: "issues",
          sourceAction: "edited",
        })
      ).reason,
      "scanner_refused",
    );
    await seed(145504);
    assert.equal((await complete(145504, null)).requeued, true);
    await seed(145505);
    assert.equal((await complete(145505, "source_incompatible")).requeued, false);
    assert.equal((await item(145505)).parkedReason, "source_incompatible");
    results.push(
      "newer automatic completion and issue drift hold; retryable and source-incompatible behavior preserved",
    );
    await stop();
    epoch = "2";
    await start();
    assert.equal(
      (await enqueue(145502, "epoch-release", { sourceAction: "scheduled_normal_backfill" }))
        .queued,
      true,
    );
    assert.equal((await item(145502)).decision.commandStatusMarker, undefined);
    assert.equal((await item(145502)).revision, 3);
    results.push("intentional epoch change allows a fresh automatic admission");
    // Execute the owning workflow gate and production scheduled-enqueue CLI.
    const workflow = YAML.parse(
      fs.readFileSync(path.join(root, ".github/workflows/sweep.yml"), "utf8"),
    );
    const mode = workflow.jobs.plan.steps.find((s) => s.id === "mode").run;
    for (const id of [
      "review",
      "publish",
      "recover-review-failures",
      "requeue-source-revision-drift",
      "publish-review-action-ledger",
    ])
      assert.equal(Object.hasOwn(workflow.jobs, id), false);
    for (const input of ["batch_size", "shard_count", "apply_after_review"])
      assert.equal(Object.hasOwn(workflow.on.workflow_dispatch.inputs, input), false);
    assert.ok(workflow.jobs["apply-existing"]);
    for (const manual of ["false", "true"]) {
      const output = path.join(dir, `mode-${manual}.out`);
      const stub = `pnpm() { case "$*" in *queue-pressure*) echo '{"availableCandidateCapacity":7}' ;; *"limit review_shards.hard_cap"*) echo 128 ;; *) return 2 ;; esac; }`;
      execFileSync("bash", ["-euo", "pipefail", "-c", stub + "\n" + mode], {
        env: {
          ...process.env,
          QUEUE_URL: origin,
          GITHUB_OUTPUT: output,
          HOT_INTAKE: "false",
          MANUAL_EXPLICIT: manual,
          CODEX_TIMEOUT_MS: "1200000",
          ALLOCATED_CANDIDATES: "",
        },
      });
      const values = Object.fromEntries(
        fs
          .readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      assert.equal(values.manual_explicit, manual);
      assert.equal(values.batch_size, manual === "true" ? "1" : "7");
    }
    await seed(145506);
    await complete(145506);
    const plan = path.join(dir, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        candidates: [
          {
            repo: "openclaw/gogcli",
            number: 145506,
            kind: "pull_request",
            updatedAt: new Date().toISOString(),
          },
          {
            repo: "openclaw/gogcli",
            number: 145507,
            kind: "issue",
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const cli = spawn(
      process.execPath,
      [
        path.join(root, "dist/repair/scheduled-review-enqueue.js"),
        "--plan",
        plan,
        "--lane",
        "normal_backfill",
        "--target-repo",
        "openclaw/gogcli",
        "--target-branch",
        "release/fixture",
        "--codex-timeout-ms",
        "1200000",
        "--queue-url",
        "https://127.0.0.1:8799",
        "--delivery-prefix",
        "continuation:proof",
      ],
      {
        env: {
          ...process.env,
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
          ADDITIONAL_PROMPT: "synthetic continuation instructions",
          NODE_EXTRA_CA_CERTS: certificate,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    cli.stdout.on("data", (b) => (stdout += b));
    cli.stderr.on("data", (b) => (stderr += b));
    const [code] = await once(cli, "exit");
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).deduped, 1);
    assert.equal(JSON.parse(stdout).queued, 1);
    assert.equal((await item(145506)).parkedReason, "scanner_refused");
    const admitted = await item(145507);
    assert.equal(admitted.decision.targetBranch, "release/fixture");
    assert.equal(admitted.decision.codexTimeoutMs, 1200000);
    assert.equal(admitted.decision.additionalPrompt, "synthetic continuation instructions");
    results.push(
      "actual workflow planning uses shared capacity; retired controls/jobs absent; production enqueue CLI respects hold",
    );
  }
  const summary = {
    before,
    head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runtime_sha256: createHash("sha256")
      .update(fs.readFileSync(path.join(root, "dashboard/exact-review-queue.ts")))
      .digest("hex"),
    runtime: "real workerd / SQLite / signed production HTTP / compiled enqueue CLI",
    source_sha256: Object.fromEntries(
      [
        ".github/workflows/sweep.yml",
        "dashboard/exact-review-decision.ts",
        "src/repair/exact-review-admission.ts",
        "src/clawsweeper-failed-review-retry.ts",
      ].map((file) => [
        file,
        createHash("sha256")
          .update(fs.readFileSync(path.join(root, file)))
          .digest("hex"),
      ]),
    ),
    results,
    limits:
      "Seeded leases and synthetic loopback GitHub; no live scanner, hosted full workflow or contributor mutation.",
  };
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(summary, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "trace.json"), JSON.stringify(trace, null, 2) + "\n");
  console.log(JSON.stringify({ ...summary, artifact: dir }, null, 2));
} finally {
  await stop();
  await new Promise((r) => tlsProxy.close(r));
  await new Promise((r) => fixture.close(r));
}
