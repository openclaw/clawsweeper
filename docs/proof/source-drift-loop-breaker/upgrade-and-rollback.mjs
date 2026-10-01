// Persisted-state upgrade and rollback proof for the source-drift loop breaker.
// Usage: node docs/proof/source-drift-loop-breaker/upgrade-and-rollback.mjs BASE_REF TOOL_PREFIX FRESH_OUTPUT_DIR
// TOOL_PREFIX must contain miniflare and esbuild (for example a wrangler@4 install).
// FRESH_OUTPUT_DIR must not exist; the harness never removes caller data.
//
// One SQLite-backed ExactReviewQueue Durable Object is persisted on disk and
// reopened three times with the real dashboard Worker:
//   1. BASE_REF (origin/main) creates pending, leased, scanner-parked, and
//      pending source-drift work;
//   2. the checked-out branch reopens it, finishes baseline work, parks three
//      source-drift loops, lists and recovers one, and leaves new pending and
//      leased work;
//   3. BASE_REF reopens it again, reads every record, ignores the new tables,
//      finishes candidate work, and releases still-parked loop rows through an
//      ordinary organic event and an explicit command.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const [baseRef, toolPrefix, output] = process.argv.slice(2);
assert.ok(baseRef && toolPrefix && output, "expected BASE_REF TOOL_PREFIX FRESH_OUTPUT_DIR");
const root = process.cwd();
const out = path.resolve(output);
mkdirSync(path.dirname(out), { recursive: true });
mkdirSync(out);
const require = createRequire(path.resolve(toolPrefix, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const T0 = Date.parse("2030-01-01T00:00:00Z");
const MINUTE = 60_000;
const REPO = "openclaw/openclaw";
const NEW_TABLES = [
  "exact_review_queue_review_generations",
  "exact_review_queue_source_drift_loops",
];
const FILES = [
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-read-model.ts",
  "dashboard/worker.ts",
  "dashboard/wrangler.toml",
];
const ITEM = {
  organicPending: 300001,
  baselineLeased: 300002,
  scannerParked: 300003,
  baselineDriftPending: 300004,
  loopRecovered: 300005,
  loopOrganic: 300006,
  candidateLeased: 300007,
  candidatePending: 300008,
  loopCommand: 300010,
};

function wranglerVars(text) {
  const start = text.indexOf("\n[vars]\n");
  assert.ok(start >= 0, "wrangler.toml has no [vars] section");
  const vars = {};
  for (const line of text.slice(start + "\n[vars]\n".length).split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = /^([A-Z0-9_]+) = "([^"]*)"$/.exec(line.trim());
    if (match && (match[1].startsWith("EXACT_REVIEW_") || match[1] === "PUBLIC_BAY_REPOS")) {
      vars[match[1]] = match[2];
    }
  }
  return vars;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => sha256(JSON.stringify(value));

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const dispatches = [];
const unexpected = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  let text = "";
  for await (const chunk of request) text += chunk;
  let body = {};
  let code = 200;
  if (url.pathname.endsWith("/installation")) body = { id: 999 };
  else if (url.pathname === "/app/installations/999/access_tokens") {
    body = { token: "synthetic-installation-token", expires_at: "2100-01-01T00:00:00Z" };
  } else if (url.pathname.endsWith("/actions/workflows/sweep.yml")) body = { state: "active" };
  else if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname)) {
    body = { state: "open", updated_at: "2029-12-31T00:00:00Z" };
  } else if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(url.pathname)) body = [];
  else if (url.pathname === "/repos/openclaw/clawsweeper/dispatches" && request.method === "POST") {
    dispatches.push(JSON.parse(text).client_payload);
    code = 204;
  } else {
    unexpected.push(`${request.method} ${url.pathname}`);
    code = 501;
  }
  response.writeHead(code, { "content-type": "application/json" });
  response.end(code === 204 ? undefined : JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = `127.0.0.1:${server.address().port}`;

const receipt = {
  claim:
    "Pending, leased, and parked SQLite queue records survive origin/main -> branch -> origin/main byte-for-byte; the branch finishes baseline work and parks, lists, and recovers source_drift_loop rows; origin/main reopened afterwards reads every record, ignores the two new tables, finishes branch work, and releases still-parked loop rows through an ordinary organic event or command.",
  base: git("rev-parse", baseRef),
  head: git("rev-parse", "HEAD"),
  working_tree_dirty: Boolean(git("status", "--porcelain", "--", ...FILES)),
  node: process.version,
  workerd: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  runtime:
    "workerd / real dashboard Worker + ExactReviewQueue SQLite Durable Object persisted on disk / loopback GitHub fixture / fake clock",
  source_sha256: {},
  phases: {},
};

const factories = {};
const persist = path.join(out, "durable-objects");
try {
  for (const variant of ["baseline", "candidate"]) {
    const dir = variant === "baseline" ? path.join(out, "baseline-src") : root;
    if (variant === "baseline") {
      mkdirSync(dir);
      execFileSync("tar", ["-x", "-C", dir], {
        input: execFileSync("git", ["archive", baseRef], { maxBuffer: 256 * 1024 * 1024 }),
      });
    }
    const read = (file) => readFileSync(path.join(dir, file), "utf8");
    receipt.source_sha256[variant] = Object.fromEntries(
      FILES.map((file) => [file, sha256(read(file))]),
    );
    const vars = wranglerVars(read("dashboard/wrangler.toml"));
    const entry = path.join(out, `${variant}-upgrade-worker.ts`);
    writeFileSync(
      entry,
      `
import worker from ${JSON.stringify(path.join(dir, "dashboard/worker.ts"))};
import { ExactReviewQueue } from ${JSON.stringify(path.join(dir, "dashboard/exact-review-queue.ts"))};
let proofNow = ${T0};
Date.now = () => proofNow;
const stamp = (request) => {
  const header = request.headers.get('x-proof-now');
  if (header) proofNow = Number(header);
};
const rows = (sql, query) => Array.from(sql.exec(query));
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) {
    super(ctx, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => 'public' }, () => 0.5);
    this.proofSql = ctx.storage.sql;
  }
  async alarm() {}
  async fetch(request) {
    stamp(request);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/__tick') {
      await super.alarm();
      return Response.json({ ok: true });
    }
    if (pathname === '/__rows') {
      // Raw persisted rows, read without routing through queue initialization.
      const tables = rows(this.proofSql, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
      const optional = (table, order) => tables.includes(table) ? rows(this.proofSql, 'SELECT * FROM ' + table + ' ORDER BY ' + order) : null;
      return Response.json({
        tables,
        items: optional('exact_review_queue_items', 'item_key'),
        deliveries: optional('exact_review_queue_deliveries', 'delivery_id'),
        source_drift_loops: optional('exact_review_queue_source_drift_loops', 'item_key'),
        review_generations: optional('exact_review_queue_review_generations', 'item_key, run_id, run_attempt'),
      });
    }
    return super.fetch(request);
  }
}
export default {
  async fetch(request, env, ctx) {
    stamp(request);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/q/')) {
      const stub = env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName('global'));
      return stub.fetch(new Request('https://clawsweeper-exact-review-queue/' + url.pathname.slice(3), {
        method: request.method,
        headers: { 'x-proof-now': String(proofNow) },
        body: request.method === 'POST' ? await request.text() : undefined,
      }));
    }
    return worker.fetch(request, env, ctx);
  },
};
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
      logLevel: "silent",
    });
    factories[variant] = () =>
      new Miniflare({
        name: "source-drift-loop-upgrade-proof",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-07-08",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { EXACT_REVIEW_QUEUE: { className: "ProofQueue", useSQLite: true } },
        durableObjectsPersist: persist,
        bindings: {
          ...vars,
          GITHUB_API_URL: `http://${address}`,
          CLAWSWEEPER_APP_CLIENT_ID: "Iv23fixture",
          CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        },
        outboundService: { external: { address, http: {} } },
      });
  }

  const clock = { now: T0, runId: 6_000_000, seen: 0 };
  const leases = {};
  const open = async (variant) => {
    const mf = factories[variant]();
    await mf.ready;
    return mf;
  };
  const session = (mf) => {
    const call = async (pathname, body) => {
      const response = await mf.dispatchFetch(`http://proof${pathname}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-proof-now": String(clock.now), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.ok(response.status < 500, `${pathname}: ${response.status} ${JSON.stringify(value)}`);
      return { status: response.status, body: value };
    };
    const enqueue = async (deliveryId, decision) => {
      const { status, body } = await call("/q/enqueue", { delivery_id: deliveryId, decision });
      assert.equal(status, 202, JSON.stringify(body));
      return body;
    };
    // One alarm pass live-checks at most four items, so drain up to five passes
    // until no further dispatch happens.
    const tick = async () => {
      const ready = new Map();
      for (let pass = 0; pass < 5; pass += 1) {
        clock.now += pass === 0 ? 2 * MINUTE : 5_000;
        await call("/q/__tick", {});
        const fresh = dispatches.slice(clock.seen);
        clock.seen = dispatches.length;
        for (const payload of fresh) ready.set(Number(payload.item_number), payload);
        if (pass > 0 && fresh.length === 0) break;
      }
      return ready;
    };
    const claim = async (payload) => {
      const tuple = {
        item_key: payload.queue_claim.item_key,
        lease_id: payload.queue_lease_id,
        lease_revision: payload.queue_claim.lease_revision,
        run_id: String(clock.runId++),
        run_attempt: 1,
      };
      const claimed = await call("/q/claim", tuple);
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      return {
        ...tuple,
        claim_generation: claimed.body.claim_generation,
        decision: claimed.body.decision,
      };
    };
    const complete = async (lease, extra = {}) => {
      const { decision: _decision, ...tuple } = lease;
      const done = await call("/q/complete", { ...tuple, outcome: "success", ...extra });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      return done.body;
    };
    const rowsOf = async () => (await call("/q/__rows")).body;
    const stats = async () => (await call("/q/stats")).body;
    const reviewLane = async () => {
      const lane = (await stats()).lanes.review;
      return {
        pending: lane.pending,
        leased: lane.leased,
        parked: lane.parked,
        parked_reasons: Object.fromEntries(
          Object.entries(lane.parked_reasons ?? {}).filter(([, count]) => count > 0),
        ),
      };
    };
    const itemState = async (number) => {
      const items = (await rowsOf()).items ?? [];
      const row = items.find((entry) => entry.item_key === `${REPO}#${number}`);
      if (!row) return null;
      const item = JSON.parse(row.item_json);
      return {
        state: item.state,
        parked_reason: item.parkedReason ?? null,
        source_action: item.decision?.sourceAction,
      };
    };
    return { call, enqueue, tick, claim, complete, rowsOf, stats, reviewLane, itemState };
  };
  const issue = (number, sourceAction, extra = {}) => ({
    targetRepo: REPO,
    targetBranch: "main",
    itemNumber: number,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction,
    supersedesInProgress: sourceAction === "edited",
    ...extra,
  });
  const drift = (lease) => ({
    ...lease.decision,
    sourceAction: "source_drift_requeue",
    supersedesInProgress: true,
  });
  const tableSet = (snapshot) => snapshot.tables.filter((name) => NEW_TABLES.includes(name));

  // Phase 1: origin/main creates the deployed state.
  {
    const mf = await open("baseline");
    try {
      const s = session(mf);
      for (const number of [ITEM.baselineLeased, ITEM.scannerParked, ITEM.baselineDriftPending]) {
        assert.equal(
          (await s.enqueue(`b1-opened-${number}`, issue(number, "opened"))).queued,
          true,
        );
      }
      const ready = await s.tick();
      for (const number of [ITEM.baselineLeased, ITEM.scannerParked, ITEM.baselineDriftPending]) {
        leases[number] = await s.claim(ready.get(number));
      }
      await s.complete(leases[ITEM.scannerParked], {
        outcome: "failure",
        review_failure_reason: "findings",
      });
      await s.complete(leases[ITEM.baselineDriftPending]);
      assert.equal(
        (
          await s.enqueue(
            `publisher-source-drift:${leases[ITEM.baselineDriftPending].run_id}:1`,
            drift(leases[ITEM.baselineDriftPending]),
          )
        ).queued,
        true,
      );
      assert.equal(
        (await s.enqueue("b1-opened-pending", issue(ITEM.organicPending, "opened"))).queued,
        true,
      );
      const snapshot = await s.rowsOf();
      receipt.phases.baseline_create = {
        review_lane: await s.reviewLane(),
        item_states: Object.fromEntries(
          await Promise.all(
            [
              ITEM.organicPending,
              ITEM.baselineLeased,
              ITEM.scannerParked,
              ITEM.baselineDriftPending,
            ].map(async (number) => [number, await s.itemState(number)]),
          ),
        ),
        new_tables_present: tableSet(snapshot),
        items_sha256: digest(snapshot.items),
        deliveries_sha256: digest(snapshot.deliveries),
      };
      receipt.phases.baseline_create.snapshot = snapshot;
    } finally {
      await mf.dispose();
    }
  }

  // Phase 2: the branch reopens the same Durable Object.
  {
    const mf = await open("candidate");
    try {
      const s = session(mf);
      clock.now += MINUTE;
      const raw = await s.rowsOf();
      const before = receipt.phases.baseline_create.snapshot;
      const rawPreserved =
        digest(raw.items) === digest(before.items) &&
        digest(raw.deliveries) === digest(before.deliveries);
      const firstLane = await s.reviewLane();
      const afterRead = await s.rowsOf();
      const readPreserved =
        digest(afterRead.items) === digest(before.items) &&
        digest(afterRead.deliveries) === digest(before.deliveries);
      // Baseline-era leased work completes on the branch.
      const baselineLeaseCompleted = await s.complete(leases[ITEM.baselineLeased]);
      // Loop parking from scratch for three items, interleaved.
      const loopItems = [ITEM.loopRecovered, ITEM.loopOrganic, ITEM.loopCommand];
      for (const number of loopItems) {
        assert.equal((await s.enqueue(`c-opened-${number}`, issue(number, "opened"))).queued, true);
      }
      const dispositions = Object.fromEntries(loopItems.map((number) => [number, []]));
      let reviewsSpent = 0;
      let baselineDriftDispatched = false;
      let organicPendingDispatched = false;
      for (let generation = 0; generation <= 3; generation += 1) {
        const ready = await s.tick();
        if (ready.has(ITEM.baselineDriftPending)) {
          baselineDriftDispatched = true;
          await s.complete(await s.claim(ready.get(ITEM.baselineDriftPending)));
        }
        if (ready.has(ITEM.organicPending)) {
          organicPendingDispatched = true;
          await s.complete(await s.claim(ready.get(ITEM.organicPending)));
        }
        for (const number of loopItems) {
          const payload = ready.get(number);
          assert.ok(payload, `loop item ${number} generation ${generation} dispatched`);
          reviewsSpent += 1;
          const lease = await s.claim(payload);
          await s.complete(lease);
          const requeue = await s.enqueue(
            `publisher-source-drift:${lease.run_id}:${generation + 1}`,
            drift(lease),
          );
          dispositions[number].push(
            requeue.queued ? "queued" : `${requeue.dedupe_scope}:${requeue.dedupe_reason}`,
          );
        }
      }
      const parkedLane = await s.reviewLane();
      const listed = (await s.call("/q/parked-reviews/list", { limit: 50 })).body.parked_reviews;
      const listedLoops = listed
        .filter((row) => row.parked_reason === "source_drift_loop")
        .map((row) => row.item_key)
        .sort();
      const recoverRow = listed.find((row) => row.item_key === `${REPO}#${ITEM.loopRecovered}`);
      const recovered = (
        await s.call("/q/parked-reviews/recover-fresh", {
          idempotency_key: "upgrade-proof-recovery",
          override_retry_budget: true,
          items: [recoverRow],
        })
      ).body;
      const recoveredState = await s.itemState(ITEM.loopRecovered);
      // Leave fresh branch-era leased and pending work for the rollback.
      assert.equal(
        (await s.enqueue("c-opened-leased", issue(ITEM.candidateLeased, "opened"))).queued,
        true,
      );
      const ready = await s.tick();
      leases[ITEM.candidateLeased] = await s.claim(ready.get(ITEM.candidateLeased));
      if (ready.has(ITEM.loopRecovered)) {
        // The recovered row dispatches like any pending review; leave it leased.
        leases[ITEM.loopRecovered] = await s.claim(ready.get(ITEM.loopRecovered));
      }
      assert.equal(
        (await s.enqueue("c-opened-pending", issue(ITEM.candidatePending, "opened"))).queued,
        true,
      );
      const snapshot = await s.rowsOf();
      receipt.phases.candidate_upgrade = {
        raw_rows_preserved_on_open: rawPreserved,
        rows_preserved_after_first_read: readPreserved,
        review_lane_on_open: firstLane,
        baseline_lease_completed: baselineLeaseCompleted.ok === true,
        baseline_pending_items_dispatched: {
          organic: organicPendingDispatched,
          source_drift: baselineDriftDispatched,
        },
        loop_dispositions: dispositions,
        loop_reviews_spent: reviewsSpent,
        review_lane_with_parked_loops: parkedLane,
        listed_source_drift_loops: listedLoops,
        recover_fresh: { recovered: recovered.recovered, skipped: recovered.skipped },
        recovered_item_state: recoveredState,
        item_states_at_close: Object.fromEntries(
          await Promise.all(
            [
              ITEM.scannerParked,
              ITEM.loopRecovered,
              ITEM.loopOrganic,
              ITEM.loopCommand,
              ITEM.candidateLeased,
              ITEM.candidatePending,
            ].map(async (number) => [number, await s.itemState(number)]),
          ),
        ),
        new_tables_present: tableSet(snapshot),
        source_drift_loops: snapshot.source_drift_loops,
        review_generation_rows: snapshot.review_generations?.length ?? 0,
        items_sha256: digest(snapshot.items),
        deliveries_sha256: digest(snapshot.deliveries),
      };
      receipt.phases.candidate_upgrade.snapshot = snapshot;
    } finally {
      await mf.dispose();
    }
  }

  // Phase 3: roll back to origin/main on the same Durable Object.
  {
    const mf = await open("baseline");
    try {
      const s = session(mf);
      clock.now += MINUTE;
      const before = receipt.phases.candidate_upgrade.snapshot;
      const raw = await s.rowsOf();
      const rawPreserved =
        digest(raw.items) === digest(before.items) &&
        digest(raw.deliveries) === digest(before.deliveries) &&
        digest(raw.source_drift_loops) === digest(before.source_drift_loops) &&
        digest(raw.review_generations) === digest(before.review_generations);
      const statsBody = await s.stats();
      const lane = statsBody.lanes.review;
      const publicQueue = await s.call("/api/exact-review-queue");
      const afterRead = await s.rowsOf();
      const readPreserved =
        digest(afterRead.items) === digest(before.items) &&
        digest(afterRead.deliveries) === digest(before.deliveries);
      // Finish branch-era leased work on the rolled-back code.
      const candidateLeaseCompleted = await s.complete(leases[ITEM.candidateLeased]);
      const recoveredLeaseCompleted = leases[ITEM.loopRecovered]
        ? (await s.complete(leases[ITEM.loopRecovered])).ok === true
        : null;
      // A still-parked loop row is an ordinary parked item on origin/main.
      const automatic = await s.enqueue(
        "rollback-source-drift",
        issue(ITEM.loopOrganic, "source_drift_requeue", { supersedesInProgress: true }),
      );
      const afterAutomatic = await s.itemState(ITEM.loopOrganic);
      const organic = await s.enqueue("rollback-organic", issue(ITEM.loopOrganic, "edited"));
      const afterOrganic = await s.itemState(ITEM.loopOrganic);
      const command = await s.enqueue(
        "rollback-command",
        issue(ITEM.loopCommand, "re_review", {
          commandStatusMarker: `<!-- clawsweeper-command-status:${ITEM.loopCommand}:re_review:rollback -->`,
          statusCommentId: 9101,
        }),
      );
      const afterCommand = await s.itemState(ITEM.loopCommand);
      const ready = await s.tick();
      const dispatchedAfterRollback = [...ready.keys()].sort();
      for (const number of [ITEM.loopOrganic, ITEM.candidatePending]) {
        if (ready.has(number)) await s.complete(await s.claim(ready.get(number)));
      }
      const finalRows = await s.rowsOf();
      const finalKeys = (finalRows.items ?? []).map((row) => row.item_key).sort();
      receipt.phases.baseline_rollback = {
        raw_rows_preserved_on_open: rawPreserved,
        rows_preserved_after_first_read: readPreserved,
        new_tables_still_present_and_ignored: tableSet(raw),
        stats_review_lane: {
          pending: lane.pending,
          leased: lane.leased,
          parked: lane.parked,
          parked_reasons: Object.fromEntries(
            Object.entries(lane.parked_reasons ?? {}).filter(([, count]) => count > 0),
          ),
        },
        public_route: {
          status: publicQueue.status,
          collection: publicQueue.body.collection ?? null,
          review_parked_reasons: Object.fromEntries(
            Object.entries(publicQueue.body.lanes?.review?.parked_reasons ?? {}).filter(
              ([, count]) => count > 0,
            ),
          ),
          review_runaway_health: publicQueue.body.review_runaway_health ?? "absent",
        },
        candidate_lease_completed: candidateLeaseCompleted.ok === true,
        recovered_loop_lease_completed: recoveredLeaseCompleted,
        parked_loop_automatic_requeue: {
          response: automatic.queued ? "queued" : JSON.stringify(automatic),
          state_after: afterAutomatic,
        },
        parked_loop_organic_release: {
          response: organic.queued ? "queued" : JSON.stringify(organic),
          state_after: afterOrganic,
        },
        parked_loop_command_release: {
          response: command.queued ? "queued" : JSON.stringify(command),
          state_after: afterCommand,
        },
        dispatched_after_rollback: dispatchedAfterRollback,
        remaining_item_keys: finalKeys,
        final_items_sha256: digest(finalRows.items),
      };
    } finally {
      await mf.dispose();
    }
  }

  assert.deepEqual(unexpected, [], "unexpected external fixture route");
  for (const phase of Object.values(receipt.phases)) delete phase.snapshot;
  receipt.assertions = verify(receipt.phases);
  receipt.limits =
    "Synthetic GitHub fixture and RSA credential; issue items only; review execution is replaced by claim plus completion; alarms are delivered only by explicit fake-clock ticks; one Durable Object instance persisted by Miniflare on local disk, not a production Cloudflare deployment. No live inference, production state, or GitHub mutation.";
  writeFileSync(
    path.join(out, "upgrade-and-rollback.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt.assertions, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function verify(phases) {
  const create = phases.baseline_create;
  const upgrade = phases.candidate_upgrade;
  const rollback = phases.baseline_rollback;
  const key = (number) => `${REPO}#${number}`;
  const checks = {
    baseline_state_has_pending_leased_parked:
      create.item_states[ITEM.organicPending]?.state === "pending" &&
      create.item_states[ITEM.baselineLeased]?.state === "leased" &&
      create.item_states[ITEM.scannerParked]?.parked_reason === "scanner_refused" &&
      create.item_states[ITEM.baselineDriftPending]?.source_action === "source_drift_requeue" &&
      create.new_tables_present.length === 0,
    upgrade_rows_byte_identical:
      upgrade.raw_rows_preserved_on_open && upgrade.rows_preserved_after_first_read,
    upgrade_finishes_baseline_work:
      upgrade.baseline_lease_completed &&
      upgrade.baseline_pending_items_dispatched.organic &&
      upgrade.baseline_pending_items_dispatched.source_drift,
    upgrade_parks_loops_after_three: Object.values(upgrade.loop_dispositions).every(
      (steps) =>
        JSON.stringify(steps) ===
        JSON.stringify(["queued", "queued", "queued", "source_drift_loop:requeue_limit_reached"]),
    ),
    upgrade_lists_and_recovers_loop:
      upgrade.listed_source_drift_loops.join(",") ===
        [key(ITEM.loopRecovered), key(ITEM.loopOrganic), key(ITEM.loopCommand)].sort().join(",") &&
      upgrade.recover_fresh.recovered === 1 &&
      upgrade.recovered_item_state?.state === "pending",
    upgrade_creates_new_tables: upgrade.new_tables_present.length === NEW_TABLES.length,
    rollback_rows_byte_identical:
      rollback.raw_rows_preserved_on_open && rollback.rows_preserved_after_first_read,
    rollback_ignores_new_tables:
      rollback.new_tables_still_present_and_ignored.length === NEW_TABLES.length &&
      rollback.public_route.review_runaway_health === "absent",
    rollback_reads_parked_loops:
      rollback.public_route.status === 200 &&
      rollback.public_route.collection?.state === "complete" &&
      rollback.stats_review_lane.parked_reasons.source_drift_loop === 2 &&
      rollback.public_route.review_parked_reasons.unknown === 2,
    rollback_finishes_branch_work:
      rollback.candidate_lease_completed && rollback.recovered_loop_lease_completed === true,
    rollback_automatic_requeue_keeps_park:
      rollback.parked_loop_automatic_requeue.state_after?.state === "parked",
    rollback_organic_releases_parked_loop:
      rollback.parked_loop_organic_release.response === "queued" &&
      rollback.parked_loop_organic_release.state_after?.state === "pending",
    rollback_command_releases_parked_loop:
      rollback.parked_loop_command_release.response === "queued" &&
      rollback.parked_loop_command_release.state_after?.state === "pending",
    rollback_dispatches_released_and_pending: [
      ITEM.loopOrganic,
      ITEM.loopCommand,
      ITEM.candidatePending,
    ].every((number) => rollback.dispatched_after_rollback.includes(number)),
  };
  for (const [name, value] of Object.entries(checks)) assert.equal(value, true, name);
  return checks;
}
