// Persisted-state upgrade and rollback proof for deterministic review holds.
// Usage: node docs/proof/review-noop-holds/upgrade-and-rollback.mjs BASE_REF TOOL_PREFIX FRESH_OUTPUT_DIR
// TOOL_PREFIX must contain miniflare and esbuild (for example a wrangler@4 install).
// FRESH_OUTPUT_DIR must not exist; the harness never removes caller data.
//
// One SQLite-backed ExactReviewQueue Durable Object is persisted on disk and
// reopened three times with the real dashboard Worker:
//   1. BASE_REF (origin/main) creates pending, leased, and scanner-parked work;
//   2. the checked-out branch reopens it byte-for-byte, finishes the baseline
//      work, holds two locked issues and two oversized PRs, dedupes their
//      scheduled offers, lists them as parked reviews, and leaves new pending
//      and leased work;
//   3. BASE_REF reopens it again, reads every record, finishes branch work,
//      keeps deduping scheduled offers against the retained holds, and
//      releases them through an organic unlock, a push, and a command.
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
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const FILES = [
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-read-model.ts",
  "dashboard/exact-review-review-loop.ts",
  "dashboard/worker.ts",
  "dashboard/wrangler.toml",
];
const ITEM = {
  organicPending: 400001,
  baselineLeased: 400002,
  scannerParked: 400003,
  lockedUnlock: 56312,
  lockedCommand: 38283,
  lockedScheduled: 40088,
  oversizedPush: 119055,
  oversizedScheduled: 119056,
  candidateLeased: 400007,
  candidatePending: 400008,
};
const PULLS = new Set([ITEM.oversizedPush, ITEM.oversizedScheduled]);
const LOCKED = [ITEM.lockedUnlock, ITEM.lockedCommand, ITEM.lockedScheduled];
const HELD = [...LOCKED, ...PULLS];

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
// Mutable live GitHub state behind the loopback fixture.
const live = {
  locked: new Set(LOCKED),
  heads: new Map([...PULLS].map((number) => [number, HEAD_A])),
};
const dispatches = [];
const unexpected = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  let text = "";
  for await (const chunk of request) text += chunk;
  let body = {};
  let code = 200;
  const item = /^\/repos\/openclaw\/openclaw\/(issues|pulls)\/(\d+)$/.exec(url.pathname);
  if (url.pathname.endsWith("/installation")) body = { id: 999 };
  else if (url.pathname === "/app/installations/999/access_tokens") {
    body = { token: "synthetic-installation-token", expires_at: "2100-01-01T00:00:00Z" };
  } else if (url.pathname.endsWith("/actions/workflows/sweep.yml")) body = { state: "active" };
  else if (item) {
    const number = Number(item[2]);
    body = PULLS.has(number)
      ? {
          state: "open",
          locked: false,
          title: `Oversized ${number}`,
          body: "",
          labels: [],
          draft: true,
          head: { sha: live.heads.get(number) },
          base: { sha: "c".repeat(40) },
          updated_at: "2029-12-31T00:00:00Z",
        }
      : {
          state: "open",
          locked: live.locked.has(number),
          updated_at: "2029-12-31T00:00:00Z",
        };
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
    "Pending, leased, and parked SQLite queue records survive origin/main -> branch -> origin/main byte-for-byte; the branch finishes baseline work and holds locked and oversized no-ops as locked_conversation / oversized_pull_request; origin/main reopened afterwards reads every record, finishes branch work, still dedupes scheduled offers against the retained holds, and releases them through an organic unlock, a pushed head, and a command.",
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
        name: "review-noop-hold-upgrade-proof",
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

  const clock = { now: T0, runId: 7_000_000, seen: 0 };
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
    const enqueueRaw = async (deliveryId, decision) =>
      call("/q/enqueue", { delivery_id: deliveryId, decision });
    const enqueue = async (deliveryId, decision) => {
      const { status, body } = await enqueueRaw(deliveryId, decision);
      assert.equal(status, 202, JSON.stringify(body));
      return body;
    };
    // One alarm pass live-checks a bounded set, so drain a few passes until no
    // further dispatch happens.
    const tick = async () => {
      const ready = new Map();
      for (let pass = 0; pass < 6; pass += 1) {
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
      return { ...tuple, claim_generation: claimed.body.claim_generation };
    };
    const complete = async (lease, extra = {}) => {
      const done = await call("/q/complete", { ...lease, outcome: "success", ...extra });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      return done.body;
    };
    const rowsOf = async () => (await call("/q/__rows")).body;
    const reviewLane = async () => {
      const lane = (await call("/q/stats")).body.lanes.review;
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
        source_head_sha: item.decision?.sourceHeadSha ?? null,
      };
    };
    const states = async (numbers) =>
      Object.fromEntries(
        await Promise.all(numbers.map(async (number) => [number, await itemState(number)])),
      );
    return {
      call,
      enqueueRaw,
      enqueue,
      tick,
      claim,
      complete,
      rowsOf,
      reviewLane,
      itemState,
      states,
    };
  };
  const decision = (number, sourceAction, extra = {}) => {
    const pull = PULLS.has(number);
    return {
      targetRepo: REPO,
      targetBranch: "main",
      itemNumber: number,
      itemKind: pull ? "pull_request" : "issue",
      sourceEvent: pull ? "pull_request" : "issues",
      sourceAction,
      supersedesInProgress: false,
      ...extra,
    };
  };
  const scheduled = (number, lane = "scheduled_normal_backfill") =>
    decision(number, lane, { sourceUpdatedAt: "2029-12-31T00:00:00Z" });
  const disposition = (body) =>
    body.queued === true
      ? "queued"
      : body.deduped === true
        ? body.dedupe_scope
          ? `deduped:${body.dedupe_scope}:${body.dedupe_reason}`
          : "deduped"
        : JSON.stringify(body);

  // Phase 1: origin/main creates the deployed state.
  {
    const mf = await open("baseline");
    try {
      const s = session(mf);
      for (const number of [ITEM.baselineLeased, ITEM.scannerParked]) {
        assert.equal((await s.enqueue(`b1-opened-${number}`, decision(number, "opened"))).queued, true);
      }
      const ready = await s.tick();
      for (const number of [ITEM.baselineLeased, ITEM.scannerParked]) {
        leases[number] = await s.claim(ready.get(number));
      }
      await s.complete(leases[ITEM.scannerParked], {
        outcome: "failure",
        review_failure_reason: "findings",
      });
      assert.equal(
        (await s.enqueue("b1-opened-pending", decision(ITEM.organicPending, "opened"))).queued,
        true,
      );
      const snapshot = await s.rowsOf();
      receipt.phases.baseline_create = {
        review_lane: await s.reviewLane(),
        item_states: await s.states([ITEM.organicPending, ITEM.baselineLeased, ITEM.scannerParked]),
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
      const before = receipt.phases.baseline_create.snapshot;
      const raw = await s.rowsOf();
      const rawPreserved =
        digest(raw.items) === digest(before.items) &&
        digest(raw.deliveries) === digest(before.deliveries);
      const firstLane = await s.reviewLane();
      const afterRead = await s.rowsOf();
      const readPreserved =
        digest(afterRead.items) === digest(before.items) &&
        digest(afterRead.deliveries) === digest(before.deliveries);
      const baselineLeaseCompleted = await s.complete(leases[ITEM.baselineLeased]);
      // Scheduled offers of the five no-op items, then their held completions.
      for (const number of HELD) {
        const lane = PULLS.has(number) ? "scheduled_hot_intake" : "scheduled_normal_backfill";
        assert.equal((await s.enqueue(`c-offer-${number}`, scheduled(number, lane))).queued, true);
      }
      const ready = await s.tick();
      const baselinePendingDispatched = ready.has(ITEM.organicPending);
      if (baselinePendingDispatched) await s.complete(await s.claim(ready.get(ITEM.organicPending)));
      const holdResponses = {};
      for (const number of HELD) {
        assert.ok(ready.has(number), `held item ${number} dispatched`);
        const reason = PULLS.has(number) ? "oversized_pull_request" : "locked_conversation";
        holdResponses[number] = (await s.complete(await s.claim(ready.get(number)), {
          review_hold: reason,
        })).review_hold;
      }
      // A repeat scheduled offer dedupes against each hold; one delivery id is
      // kept so the rollback can replay its stored disposition byte-for-byte.
      const repeatOffers = {};
      for (const number of HELD) {
        repeatOffers[number] = disposition(
          await s.enqueue(`c-repeat-${number}`, scheduled(number)),
        );
      }
      const heldLane = await s.reviewLane();
      const listed = (await s.call("/q/parked-reviews/list", { limit: 50 })).body.parked_reviews;
      const listedHolds = listed
        .filter((row) => ["locked_conversation", "oversized_pull_request"].includes(row.parked_reason))
        .map((row) => `${row.item_key}:${row.parked_reason}`)
        .sort();
      // Leave fresh branch-era leased and pending work for the rollback.
      assert.equal(
        (await s.enqueue("c-opened-leased", decision(ITEM.candidateLeased, "opened"))).queued,
        true,
      );
      const leasedReady = await s.tick();
      leases[ITEM.candidateLeased] = await s.claim(leasedReady.get(ITEM.candidateLeased));
      assert.equal(
        (await s.enqueue("c-opened-pending", decision(ITEM.candidatePending, "opened"))).queued,
        true,
      );
      const snapshot = await s.rowsOf();
      receipt.phases.candidate_upgrade = {
        raw_rows_preserved_on_open: rawPreserved,
        rows_preserved_after_first_read: readPreserved,
        review_lane_on_open: firstLane,
        baseline_lease_completed: baselineLeaseCompleted.ok === true,
        baseline_pending_dispatched: baselinePendingDispatched,
        hold_responses: holdResponses,
        repeat_scheduled_offers: repeatOffers,
        review_lane_with_holds: heldLane,
        listed_holds: listedHolds,
        item_states_at_close: await s.states([
          ITEM.scannerParked,
          ...HELD,
          ITEM.candidateLeased,
          ITEM.candidatePending,
        ]),
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
        digest(raw.deliveries) === digest(before.deliveries);
      const lane = await s.reviewLane();
      const publicQueue = await s.call("/api/exact-review-queue");
      const afterRead = await s.rowsOf();
      const readPreserved =
        digest(afterRead.items) === digest(before.items) &&
        digest(afterRead.deliveries) === digest(before.deliveries);
      const candidateLeaseCompleted = await s.complete(leases[ITEM.candidateLeased]);
      // Scheduled offers still dedupe against every retained hold row.
      const scheduledOffers = {};
      for (const number of HELD) {
        scheduledOffers[number] = disposition(
          await s.enqueue(`r-offer-${number}`, scheduled(number)),
        );
      }
      // A byte-identical retry of a branch-era deduped offer: origin/main cannot
      // parse the stored hold reason, so it answers with an unscoped dedupe.
      const replay = await s.enqueueRaw(
        `c-repeat-${ITEM.lockedScheduled}`,
        scheduled(ITEM.lockedScheduled),
      );
      // An automatic recovery on origin/main.
      const recovery = disposition(
        await s.enqueue(
          "r-shard-recovery",
          decision(ITEM.lockedScheduled, "failed_review_shard_recovery"),
        ),
      );
      const afterRecovery = await s.itemState(ITEM.lockedScheduled);
      // Releases: an organic unlock, a pushed head, and a command.
      live.locked.delete(ITEM.lockedUnlock);
      const unlocked = disposition(
        await s.enqueue(
          "r-unlocked",
          decision(ITEM.lockedUnlock, "unlocked", {
            sourceUpdatedAt: "2030-01-02T00:00:00Z",
          }),
        ),
      );
      live.heads.set(ITEM.oversizedPush, HEAD_B);
      const synchronize = disposition(
        await s.enqueue(
          "r-synchronize",
          decision(ITEM.oversizedPush, "synchronize", {
            supersedesInProgress: true,
            sourceHeadSha: HEAD_B,
            sourceHeadVerified: true,
            sourceAuthoritySeq: 2,
            sourceUpdatedAt: "2030-01-02T00:00:00Z",
          }),
        ),
      );
      const command = disposition(
        await s.enqueue(
          "r-command",
          decision(ITEM.lockedCommand, "re_review", {
            commandStatusMarker: `<!-- clawsweeper-command-status:${ITEM.lockedCommand}:re_review:rollback -->`,
            statusCommentId: 9201,
          }),
        ),
      );
      const releasedStates = await s.states([
        ITEM.lockedUnlock,
        ITEM.oversizedPush,
        ITEM.lockedCommand,
      ]);
      const ready = await s.tick();
      const dispatchedAfterRollback = [...ready.keys()].sort((a, b) => a - b);
      for (const number of [ITEM.lockedUnlock, ITEM.oversizedPush, ITEM.candidatePending]) {
        if (ready.has(number)) await s.complete(await s.claim(ready.get(number)));
      }
      const finalRows = await s.rowsOf();
      receipt.phases.baseline_rollback = {
        raw_rows_preserved_on_open: rawPreserved,
        rows_preserved_after_first_read: readPreserved,
        stats_review_lane: lane,
        public_route: {
          status: publicQueue.status,
          collection: publicQueue.body.collection?.state ?? null,
          review_parked_reasons: Object.fromEntries(
            Object.entries(publicQueue.body.lanes?.review?.parked_reasons ?? {}).filter(
              ([, count]) => count > 0,
            ),
          ),
        },
        candidate_lease_completed: candidateLeaseCompleted.ok === true,
        scheduled_offers_on_retained_holds: scheduledOffers,
        replayed_branch_disposition: { status: replay.status, body: replay.body },
        automatic_recovery: { response: recovery, state_after: afterRecovery },
        releases: {
          unlocked,
          synchronize,
          command,
          states_after: releasedStates,
        },
        dispatched_after_rollback: dispatchedAfterRollback,
        dispatched_pushed_head:
          ready.get(ITEM.oversizedPush)?.queue_claim?.source_head_sha ?? null,
        remaining_item_states: Object.fromEntries(
          (finalRows.items ?? []).map((row) => {
            const item = JSON.parse(row.item_json);
            return [row.item_key, `${item.state}${item.parkedReason ? `:${item.parkedReason}` : ""}`];
          }),
        ),
      };
    } finally {
      await mf.dispose();
    }
  }

  assert.deepEqual(unexpected, [], "unexpected external fixture route");
  for (const phase of Object.values(receipt.phases)) delete phase.snapshot;
  receipt.assertions = verify(receipt.phases);
  receipt.limits =
    "Synthetic GitHub fixture and RSA credential; completions carry the updated sweep.yml payload instead of running GitHub Actions; review execution is replaced by claim plus completion; alarms are delivered only by explicit fake-clock ticks; one Durable Object instance persisted by Miniflare on local disk, not a production Cloudflare deployment. No live inference, production state, or GitHub mutation.";
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
  const reason = (number) =>
    PULLS.has(number) ? "oversized_pull_request" : "locked_conversation";
  const checks = {
    baseline_state_has_pending_leased_parked:
      create.item_states[ITEM.organicPending]?.state === "pending" &&
      create.item_states[ITEM.baselineLeased]?.state === "leased" &&
      create.item_states[ITEM.scannerParked]?.parked_reason === "scanner_refused",
    upgrade_rows_byte_identical:
      upgrade.raw_rows_preserved_on_open && upgrade.rows_preserved_after_first_read,
    upgrade_finishes_baseline_work:
      upgrade.baseline_lease_completed && upgrade.baseline_pending_dispatched,
    upgrade_holds_all_five: HELD.every(
      (number) =>
        upgrade.hold_responses[number] === reason(number) &&
        upgrade.item_states_at_close[number]?.state === "parked" &&
        upgrade.item_states_at_close[number]?.parked_reason === reason(number),
    ),
    upgrade_dedupes_scheduled_offers: HELD.every(
      (number) =>
        upgrade.repeat_scheduled_offers[number] ===
        `deduped:scheduled_queue_item:${reason(number)}`,
    ),
    upgrade_lists_holds:
      upgrade.listed_holds.join(",") ===
      HELD.map((number) => `${key(number)}:${reason(number)}`)
        .sort()
        .join(","),
    upgrade_keeps_scanner_hold:
      upgrade.item_states_at_close[ITEM.scannerParked]?.parked_reason === "scanner_refused",
    rollback_rows_byte_identical:
      rollback.raw_rows_preserved_on_open && rollback.rows_preserved_after_first_read,
    rollback_reads_holds:
      rollback.public_route.status === 200 &&
      rollback.public_route.collection === "complete" &&
      rollback.stats_review_lane.parked_reasons.locked_conversation === 3 &&
      rollback.stats_review_lane.parked_reasons.oversized_pull_request === 2 &&
      rollback.public_route.review_parked_reasons.unknown === 5,
    rollback_finishes_branch_work: rollback.candidate_lease_completed,
    rollback_still_dedupes_scheduled: HELD.every(
      (number) =>
        rollback.scheduled_offers_on_retained_holds[number] ===
        "deduped:scheduled_queue_item:item_already_pending_or_active",
    ),
    rollback_replay_is_unscoped_dedupe:
      rollback.replayed_branch_disposition.status === 202 &&
      rollback.replayed_branch_disposition.body.deduped === true &&
      rollback.replayed_branch_disposition.body.dedupe_scope === undefined,
    rollback_unlock_releases:
      rollback.releases.unlocked === "queued" &&
      rollback.releases.states_after[ITEM.lockedUnlock]?.state === "pending",
    rollback_push_releases:
      rollback.releases.synchronize === "queued" &&
      rollback.releases.states_after[ITEM.oversizedPush]?.state === "pending" &&
      rollback.dispatched_pushed_head === HEAD_B,
    rollback_command_releases:
      rollback.releases.command === "queued" &&
      rollback.releases.states_after[ITEM.lockedCommand]?.state === "pending",
    rollback_dispatches_released_and_pending: [
      ITEM.lockedUnlock,
      ITEM.oversizedPush,
      ITEM.lockedCommand,
      ITEM.candidatePending,
    ].every((number) => rollback.dispatched_after_rollback.includes(number)),
  };
  for (const [name, value] of Object.entries(checks)) assert.equal(value, true, name);
  return checks;
}
