// Real-runtime proof for deterministic review no-op holds.
// Usage: node docs/proof/review-noop-holds/run-proof.mjs BASE_REF TOOL_PREFIX FRESH_OUTPUT_DIR
// TOOL_PREFIX must contain miniflare and esbuild (for example a wrangler@4 install).
// FRESH_OUTPUT_DIR must not exist; the harness never removes caller data.
//
// For origin/main (baseline) and the checked-out branch (candidate), this builds
// the real dashboard Worker plus the real ExactReviewQueue Durable Object, runs
// them in workerd with SQLite storage and a fake clock, and replays the two
// production loop shapes observed on 2026-10-04 for 24 simulated hours:
//   locked    openclaw/openclaw#56312 is open but locked; scheduled normal
//             backfill offers it every 10 minutes and every run completes as a
//             guarded no-op (sweep.yml "Check live target item state")
//   oversized openclaw/openclaw#119055 is an oversized PR on an unchanged head;
//             hot intake and normal backfill alternate offers, each run takes
//             the metadata-only size path, and its own lease-comment writes
//             move updated_at
// Every completion carries the payload the updated sweep.yml sends, including
// `review_hold`. The baseline Worker ignores that unknown field, so the
// baseline run is also the new-workflow/old-Worker deploy-skew check. After
// the 24 hours the harness reads the real public /api/exact-review-queue route,
// then exercises the releases: an organic `unlocked` webhook decision, and a
// pushed head discovered by the queue's parked terminal check without any
// webhook. A legacy-producer scenario runs the candidate Worker with the old
// completion payload (no `review_hold`).
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
const HOUR = 60 * MINUTE;
const REPO = "openclaw/openclaw";
const LOCKED = 56312;
const OVERSIZED = 119055;
const HEAD_A = "8837ca59748e195b0517b791c576924a089d9f3b";
const HEAD_B = "b".repeat(40);
// The review_hold each live-check path makes sweep.yml send at completion.
const HOLD = { [LOCKED]: "locked_conversation", [OVERSIZED]: "oversized_pull_request" };
const LOOP_HOURS = 24;
const LEGACY_HOURS = 2;
const STEP = 10 * MINUTE;
const FILES = [
  ".github/workflows/sweep.yml",
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-read-model.ts",
  "dashboard/exact-review-review-loop.ts",
  "dashboard/worker.ts",
  "dashboard/wrangler.toml",
];

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

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
// Mutable live GitHub state behind the loopback fixture.
let live;
let dispatches = [];
let unexpected = [];
let targetReads = [];
function resetLive() {
  live = {
    issue: { locked: true, updated_at: "2026-09-09T02:17:31Z" },
    pull: { head: HEAD_A, updated_at: "2026-10-04T22:10:32Z" },
  };
}
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
    targetReads.push(`${item[1]}/${item[2]}`);
    body =
      Number(item[2]) === OVERSIZED
        ? {
            state: "open",
            locked: false,
            title: "Oversized maintainer draft",
            body: "",
            labels: [{ name: "maintainer" }, { name: "size: XL" }],
            draft: true,
            head: { sha: live.pull.head },
            base: { sha: "c".repeat(40) },
            updated_at: live.pull.updated_at,
          }
        : { state: "open", locked: live.issue.locked, updated_at: live.issue.updated_at };
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
    "origin/main claims a new review run for every scheduled offer of an open-but-locked issue and of an oversized PR on an unchanged head, so both exceed the 24/day runaway threshold; the branch keeps each completed no-op parked as locked_conversation or oversized_pull_request, dedupes every later scheduled offer and automatic recovery without a run, and releases the hold on an organic unlock or a pushed head.",
  base: git("rev-parse", baseRef),
  head: git("rev-parse", "HEAD"),
  working_tree_dirty: Boolean(git("status", "--porcelain", "--", ...FILES)),
  node: process.version,
  workerd: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  runtime:
    "workerd / real dashboard Worker + ExactReviewQueue SQLite Durable Object / loopback GitHub fixture / fake clock",
  model: {
    cadence: `${LOOP_HOURS} simulated hours in ${STEP / MINUTE}-minute steps; #${LOCKED} gets a scheduled_normal_backfill offer every step; #${OVERSIZED} alternates scheduled_hot_intake and scheduled_normal_backfill every step with sourceUpdatedAt set to its previous completion (the lease comment create/delete)`,
    review_generation:
      "queue alarm dispatches the item, the fixture claims it with a fresh run id, then completes it with the sweep.yml payload: outcome=success plus review_hold (locked_conversation for the guarded locked path, oversized_pull_request for the size path)",
    recovery: `a failed_review_shard_recovery decision for #${LOCKED} after the loop`,
    unlock_release: `the issue is unlocked in the fixture and an issues/unlocked webhook decision arrives`,
    push_release: `the fixture head of #${OVERSIZED} moves to a new SHA with no webhook; the next parked terminal check runs on the alarm, then hot intake offers the PR again`,
    legacy_producer: `candidate Worker, ${LEGACY_HOURS} hours of #${LOCKED} offers completed without review_hold`,
  },
  variants: {},
};

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
    const vars = wranglerVars(read("dashboard/wrangler.toml"));
    const entry = path.join(out, `${variant}-proof-worker.ts`);
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
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) {
    super(ctx, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => 'public' }, () => 0.5);
  }
  // workerd alarms would fire on wall-clock time; the harness drives them only
  // through explicit fake-clock ticks.
  async alarm() {}
  async fetch(request) {
    stamp(request);
    if (new URL(request.url).pathname === '/__tick') {
      await super.alarm();
      return Response.json({ ok: true });
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
    // Everything else is the real dashboard Worker, including the public
    // /api/exact-review-queue projection.
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
    const startMiniflare = () =>
      new Miniflare({
        name: "review-noop-hold-proof",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-07-08",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { EXACT_REVIEW_QUEUE: { className: "ProofQueue", useSQLite: true } },
        bindings: {
          ...vars,
          GITHUB_API_URL: `http://${address}`,
          CLAWSWEEPER_APP_CLIENT_ID: "Iv23fixture",
          CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        },
        outboundService: { external: { address, http: {} } },
      });
    const result = {
      source_sha256: Object.fromEntries(
        FILES.map((file) => [file, createHash("sha256").update(read(file)).digest("hex")]),
      ),
      config: {
        EXACT_REVIEW_RUNAWAY_REVIEWS_PER_DAY: vars.EXACT_REVIEW_RUNAWAY_REVIEWS_PER_DAY ?? null,
        EXACT_REVIEW_TARGET_RATE_PER_HOUR: vars.EXACT_REVIEW_TARGET_RATE_PER_HOUR ?? null,
        EXACT_REVIEW_HOT_INTAKE_RATE_PER_HOUR: vars.EXACT_REVIEW_HOT_INTAKE_RATE_PER_HOUR ?? null,
        PUBLIC_BAY_REPOS: vars.PUBLIC_BAY_REPOS ?? null,
      },
      scenarios: {},
    };
    const scenarios = { scheduled_loops: scheduledLoops };
    if (variant === "candidate") scenarios.legacy_producer = legacyProducer;
    for (const [name, scenario] of Object.entries(scenarios)) {
      const mf = startMiniflare();
      try {
        await mf.ready;
        resetLive();
        dispatches = [];
        targetReads = [];
        result.scenarios[name] = await scenario(createDriver(mf));
      } finally {
        await mf.dispose();
      }
    }
    receipt.variants[variant] = result;
  }
  assert.deepEqual(unexpected, [], "unexpected external fixture route");
  receipt.assertions = verify(receipt.variants);
  receipt.limits =
    "Synthetic GitHub fixture and RSA credential; the sweep.yml live-check, review, and completion steps are reproduced by sending the completion payload they produce, not by running GitHub Actions; review execution is replaced by claim+complete; scheduled planners are reproduced by their enqueue payloads at a fixed 10-minute cadence (the planner-side locked skip is covered by test/review-planning-locked.test.ts); the 5-minute reconcile-parked workflow is not run; no live inference, production state, or GitHub mutation.";
  writeFileSync(path.join(out, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt.assertions, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function createDriver(mf) {
  const driver = {
    now: T0,
    runId: 5_000_000,
    seenDispatches: 0,
    async call(pathname, body) {
      const response = await mf.dispatchFetch(`http://proof${pathname}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-proof-now": String(driver.now), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    async enqueue(deliveryId, decision) {
      const { status, body } = await driver.call("/q/enqueue", {
        delivery_id: deliveryId,
        decision,
      });
      assert.equal(status, 202, JSON.stringify(body));
      return body;
    },
    async tick() {
      await driver.call("/q/__tick", {});
      const fresh = dispatches.slice(driver.seenDispatches);
      driver.seenDispatches = dispatches.length;
      return fresh;
    },
    /** Claim and complete a dispatched review with the given completion fields. */
    async runReview(payload, completion) {
      driver.now += MINUTE;
      const tuple = {
        item_key: payload.queue_claim.item_key,
        lease_id: payload.queue_lease_id,
        lease_revision: payload.queue_claim.lease_revision,
        run_id: String(driver.runId++),
        run_attempt: 1,
      };
      const claim = await driver.call("/q/claim", tuple);
      assert.equal(claim.status, 200, JSON.stringify(claim.body));
      driver.now += MINUTE;
      const complete = await driver.call("/q/complete", {
        ...tuple,
        claim_generation: claim.body.claim_generation,
        outcome: "success",
        ...completion,
      });
      assert.equal(complete.status, 200, JSON.stringify(complete.body));
      return complete.body;
    },
    async lane() {
      const stats = (await driver.call("/q/stats")).body;
      const review = stats.lanes.review;
      const keys = [`${REPO}#${LOCKED}`, `${REPO}#${OVERSIZED}`];
      return {
        parked: review.parked,
        parked_reasons: Object.fromEntries(
          Object.entries(review.parked_reasons ?? {}).filter(([, count]) => count > 0),
        ),
        bay_projection_complete: stats.bay_projection?.complete ?? null,
        bay_cards: (stats.bay_projection?.items ?? [])
          .filter((entry) => keys.includes(entry.item_key))
          .map((entry) => ({ item_key: entry.item_key, stage: entry.stage })),
      };
    },
  };
  return driver;
}

function decision(itemNumber, sourceAction, extra = {}) {
  const pull = itemNumber === OVERSIZED;
  return {
    targetRepo: REPO,
    targetBranch: "main",
    itemNumber,
    itemKind: pull ? "pull_request" : "issue",
    sourceEvent: pull ? "pull_request" : "issues",
    sourceAction,
    supersedesInProgress: false,
    ...extra,
  };
}

function disposition(body) {
  if (body.queued === true) return "queued";
  if (body.deduped === true) {
    return body.dedupe_scope ? `deduped:${body.dedupe_scope}:${body.dedupe_reason}` : "deduped";
  }
  if (body.shed === true) return `shed:${body.reason}`;
  return JSON.stringify(body);
}

function count(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** One scheduled step: offer both items, dispatch, and run whatever was dispatched. */
async function scheduledStep(driver, step, log, completionFor) {
  const lane = step % 2 === 0 ? "scheduled_hot_intake" : "scheduled_normal_backfill";
  const offers = [
    [LOCKED, "scheduled_normal_backfill", live.issue.updated_at],
    [OVERSIZED, lane, live.pull.updated_at],
  ];
  for (const [itemNumber, sourceAction, sourceUpdatedAt] of offers) {
    const offer = await driver.enqueue(
      `${sourceAction}:${itemNumber}:${step}`,
      decision(itemNumber, sourceAction, { sourceUpdatedAt }),
    );
    log[itemNumber].offers.push(disposition(offer));
  }
  driver.now += MINUTE;
  for (const payload of await driver.tick()) {
    const itemNumber = Number(payload.item_number);
    const completion = await driver.runReview(payload, completionFor(itemNumber));
    log[itemNumber].claims += 1;
    if (completion.review_hold) log[itemNumber].holds.push(completion.review_hold);
    // The oversized run's own lease comment create/delete moves updated_at.
    if (itemNumber === OVERSIZED) live.pull.updated_at = new Date(driver.now).toISOString();
  }
}

async function scheduledLoops(driver) {
  const log = {
    [LOCKED]: { offers: [], claims: 0, holds: [] },
    [OVERSIZED]: { offers: [], claims: 0, holds: [] },
  };
  const completionFor = (itemNumber) => ({ review_hold: HOLD[itemNumber] });
  const steps = (LOOP_HOURS * HOUR) / STEP;
  for (let step = 0; step < steps; step += 1) {
    driver.now = T0 + step * STEP;
    await scheduledStep(driver, step, log, completionFor);
  }
  driver.now = T0 + LOOP_HOURS * HOUR;
  const afterLoop = await driver.lane();
  const publicQueue = await driver.call("/api/exact-review-queue");

  // An automatic recovery for the held issue would repeat the same no-op.
  const recovery = disposition(
    await driver.enqueue("shard-recovery", decision(LOCKED, "failed_review_shard_recovery")),
  );
  driver.now += 2 * MINUTE;
  const recoveryDispatched = (await driver.tick()).length;

  // Release 1: the issue is unlocked and the webhook arrives.
  live.issue = { locked: false, updated_at: new Date(driver.now).toISOString() };
  const unlocked = disposition(
    await driver.enqueue(
      "issues-unlocked",
      decision(LOCKED, "unlocked", { sourceUpdatedAt: live.issue.updated_at }),
    ),
  );
  driver.now += 2 * MINUTE;
  const unlockDispatch = (await driver.tick()).filter(
    (payload) => Number(payload.item_number) === LOCKED,
  );
  if (unlockDispatch[0]) await driver.runReview(unlockDispatch[0], {});

  // Release 2: a push to the oversized PR with no webhook. The parked
  // terminal check notices the advanced head on its next alarm pass.
  live.pull = { head: HEAD_B, updated_at: new Date(driver.now).toISOString() };
  const readsBeforePush = targetReads.length;
  let pushRelease = { ticks: 0, released: false };
  for (let tick = 1; tick <= 4 && !pushRelease.released; tick += 1) {
    driver.now += 6 * MINUTE;
    await driver.tick();
    const lane = await driver.lane();
    pushRelease = { ticks: tick, released: !lane.parked_reasons.oversized_pull_request };
  }
  const pushReads = targetReads.slice(readsBeforePush);
  const afterPushOffer = disposition(
    await driver.enqueue(
      "hot-after-push",
      decision(OVERSIZED, "scheduled_hot_intake", { sourceUpdatedAt: live.pull.updated_at }),
    ),
  );
  driver.now += MINUTE;
  const afterPushDispatch = (await driver.tick()).find(
    (payload) => Number(payload.item_number) === OVERSIZED,
  );

  const summary = (itemNumber) => ({
    item: `${REPO}#${itemNumber}`,
    scheduled_offers: log[itemNumber].offers.length,
    offer_dispositions: count(log[itemNumber].offers),
    claimed_reviews: log[itemNumber].claims,
    holds_reported: count(log[itemNumber].holds),
  });
  return {
    locked: summary(LOCKED),
    oversized: summary(OVERSIZED),
    after_24h_review_lane: afterLoop,
    public_status: publicQueue.status,
    public_collection: publicQueue.body.collection?.state ?? null,
    public_review_parked_reasons: Object.fromEntries(
      Object.entries(publicQueue.body.lanes?.review?.parked_reasons ?? {}).filter(
        ([, value]) => value > 0,
      ),
    ),
    public_review_runaway_health: publicQueue.body.review_runaway_health ?? "absent",
    recovery_while_held: recovery,
    recovery_dispatched: recoveryDispatched,
    unlocked_webhook: unlocked,
    unlocked_review_dispatched: unlockDispatch.length,
    push_without_webhook: {
      ...pushRelease,
      target_reads: count(pushReads),
      next_hot_offer: afterPushOffer,
      next_hot_offer_dispatched_head: afterPushDispatch?.queue_claim?.source_head_sha ?? null,
    },
  };
}

async function legacyProducer(driver) {
  // The pre-change sweep.yml completion: no review_hold field.
  const log = {
    [LOCKED]: { offers: [], claims: 0, holds: [] },
    [OVERSIZED]: { offers: [], claims: 0, holds: [] },
  };
  const steps = (LEGACY_HOURS * HOUR) / STEP;
  for (let step = 0; step < steps; step += 1) {
    driver.now = T0 + step * STEP;
    await scheduledStep(driver, step, log, () => ({}));
  }
  return {
    hours: LEGACY_HOURS,
    locked_claims: log[LOCKED].claims,
    oversized_claims: log[OVERSIZED].claims,
    review_lane: await driver.lane(),
  };
}

function verify(variants) {
  const base = variants.baseline.scenarios.scheduled_loops;
  const cand = variants.candidate.scenarios.scheduled_loops;
  const legacy = variants.candidate.scenarios.legacy_producer;
  const steps = (LOOP_HOURS * HOUR) / STEP;
  const runaway = base.public_review_runaway_health;
  const checks = {
    baseline_locked_claims_every_offer: base.locked.claimed_reviews === steps,
    baseline_oversized_claims_every_offer: base.oversized.claimed_reviews === steps,
    baseline_accepts_new_completion_payload:
      base.locked.claimed_reviews > 0 && Object.keys(base.locked.holds_reported).length === 0,
    baseline_runaway_degraded:
      runaway?.status === "degraded" &&
      runaway?.runaway_items === 2 &&
      [`${REPO}#${LOCKED}`, `${REPO}#${OVERSIZED}`].every((key) =>
        runaway?.sample_item_keys?.includes(key),
      ),
    candidate_locked_one_claim: cand.locked.claimed_reviews === 1,
    candidate_oversized_one_claim: cand.oversized.claimed_reviews === 1,
    candidate_locked_offers_deduped:
      cand.locked.offer_dispositions.queued === 1 &&
      cand.locked.offer_dispositions["deduped:scheduled_queue_item:locked_conversation"] ===
        steps - 1,
    candidate_oversized_offers_deduped:
      cand.oversized.offer_dispositions.queued === 1 &&
      cand.oversized.offer_dispositions["deduped:scheduled_queue_item:oversized_pull_request"] ===
        steps - 1,
    candidate_parked_reasons:
      cand.after_24h_review_lane.parked === 2 &&
      cand.after_24h_review_lane.parked_reasons.locked_conversation === 1 &&
      cand.after_24h_review_lane.parked_reasons.oversized_pull_request === 1,
    candidate_bay_keeps_lifecycle_cards:
      cand.after_24h_review_lane.bay_projection_complete === true &&
      cand.after_24h_review_lane.bay_cards.length === 0,
    candidate_public_projection:
      cand.public_status === 200 &&
      cand.public_collection === "complete" &&
      cand.public_review_parked_reasons.locked_conversation === 1 &&
      cand.public_review_parked_reasons.oversized_pull_request === 1 &&
      cand.public_review_parked_reasons.unknown === undefined,
    candidate_runaway_healthy:
      cand.public_review_runaway_health?.status === "healthy" &&
      cand.public_review_runaway_health?.runaway_items === 0,
    candidate_recovery_deduped:
      cand.recovery_while_held === "deduped:review_hold:locked_conversation" &&
      cand.recovery_dispatched === 0,
    candidate_unlock_releases:
      cand.unlocked_webhook === "queued" && cand.unlocked_review_dispatched === 1,
    candidate_push_releases_without_webhook:
      cand.push_without_webhook.released &&
      cand.push_without_webhook.target_reads[`pulls/${OVERSIZED}`] === 1 &&
      cand.push_without_webhook.next_hot_offer === "queued" &&
      cand.push_without_webhook.next_hot_offer_dispatched_head === HEAD_B,
    candidate_legacy_producer_unchanged:
      legacy.locked_claims === (LEGACY_HOURS * HOUR) / STEP &&
      legacy.oversized_claims === (LEGACY_HOURS * HOUR) / STEP &&
      legacy.review_lane.parked === 0,
  };
  for (const [name, value] of Object.entries(checks)) assert.equal(value, true, name);
  return checks;
}
