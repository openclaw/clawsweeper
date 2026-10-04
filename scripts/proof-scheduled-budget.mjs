// Simulated-hour proof for scheduled admission with bounded organic debt.
// Usage: node scripts/proof-scheduled-budget.mjs BASE_REF TOOL_PREFIX FRESH_OUTPUT_DIR
// TOOL_PREFIX must contain miniflare and esbuild (for example wrangler@4.107.0).
// FRESH_OUTPUT_DIR must not already exist; the harness never removes caller data.
// Drives the real ExactReviewQueue Durable Object (workerd + SQLite) with a fake
// clock: organic new items (some closed before dispatch), superseding revisions
// of dispatching or leased owners, requeue_latest completions, scheduled
// hot/normal offers at each revision's cron cadence, dispatch, claim,
// completion, and a GitHub throttle signal. Executions are counted at claim.
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
// Exclusive creation refuses existing directories, files and symlinks.
mkdirSync(out);
const require = createRequire(path.resolve(toolPrefix, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const T0 = Date.parse("2030-01-01T00:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Planner latency between a cron tick and its first queue offer, in minutes.
const DIRECT_PLANNER_LATENCY = 3;
const FANOUT_PLANNER_LATENCY = 6;
// Candidates one offer sequence may carry (planner fallback batch sizes).
const DIRECT_OFFER_CANDIDATES = 50;
const HOT_FANOUT_OFFER_CANDIDATES = 20;
const NORMAL_FANOUT_OFFER_CANDIDATES = 50;
const CLAIM_LATENCY = MINUTE;
const THROTTLE_COOLDOWN = 15 * MINUTE;
// Organic admissions/hour split into new keys, superseding revisions of an
// active owner, and completion requeues (requeue_latest). The requeue share is
// realized as a per-completion probability, so measured counts are reported.
const mix = (name, hours, newPerHour, supersedePerHour, requeuePerHour, extra = {}) => ({
  name,
  hours,
  newPerHour,
  supersedePerHour,
  requeueProbability: requeuePerHour ? requeuePerHour / (newPerHour + requeuePerHour) : 0,
  target: { new: newPerHour, supersede: supersedePerHour, requeue: requeuePerHour },
  ...extra,
});
const ALL_SCENARIOS = [
  mix("organic_130_new_keys", 3, 130, 0, 0),
  mix("organic_180_new_keys", 3, 180, 0, 0),
  mix("organic_130_with_30pct_supersede_requeue", 3, 91, 19.5, 19.5),
  // Calibrated to 24 h production telemetry: ~180 organic executions/hour of
  // which only ~45 are new keys (the rest supersede or requeue), reproducing
  // today's ~24 scheduled reviews/hour under the origin/main accounting.
  mix("production_like_today", 3, 45, 67.5, 67.5),
  // The same new-key load once lane A removes ~65/hour of source-drift requeues.
  mix("production_like_after_lane_a", 3, 45, 35, 35),
  mix("throttle_organic_130", 2, 130, 0, 0, { throttleAtMinute: 75 }),
  // Organic above the budget for one hour: organic stays admitted, scheduled
  // admission stops while the global balance sits at the -burst floor, and
  // resumes once organic falls back below the rate.
  mix("organic_spike_300_for_one_hour", 3, 130, 0, 0, {
    newPerHourByHour: [130, 300, 130],
    target: { new: [130, 300, 130], supersede: 0, requeue: 0 },
  }),
  mix("organic_400_above_target", 3, 400, 0, 0),
  mix("organic_spike_then_recovery", 3, 0, 0, 0, { spikeAtMinute: 20, spikeCount: 400 }),
  // Calibrated to production after #1710 (2026-10-01): ~215 new organic
  // queue items/hour, of which only ~110/hour start a review. The rest is
  // closed before its dispatch-time live check (deleted without a run) or
  // superseded while its workflow is still dispatching (the revoked lease
  // never claims). A small requeue_latest share models source drift.
  mix("production_2026_10_01", 3, 215, 12, 0, {
    closedBeforeDispatchFraction: 0.52,
    supersedeOwner: "dispatching",
    requeueProbability: 0.055,
    target: { new: 215, supersede: 12, requeue: 6, closed_before_dispatch: "52%" },
  }),
];
// Optional comma-separated scenario filter for quick local iteration.
const SCENARIOS = process.env.PROOF_SCENARIOS
  ? ALL_SCENARIOS.filter((scenario) =>
      process.env.PROOF_SCENARIOS.split(",").includes(scenario.name),
    )
  : ALL_SCENARIOS;
assert.ok(SCENARIOS.length > 0, "no proof scenarios selected");
const FILES = [
  "dashboard/exact-review-queue.ts",
  "dashboard/wrangler.toml",
  ".github/workflows/sweep.yml",
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wranglerVars(text) {
  const start = text.indexOf("\n[vars]\n");
  assert.ok(start >= 0, "wrangler.toml has no [vars] section");
  const vars = {};
  for (const line of text.slice(start + "\n[vars]\n".length).split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = /^([A-Z0-9_]+) = "([^"]*)"$/.exec(line.trim());
    if (match && match[1].startsWith("EXACT_REVIEW_")) vars[match[1]] = match[2];
  }
  assert.ok(vars.EXACT_REVIEW_TARGET_RATE_PER_HOUR && vars.EXACT_REVIEW_TARGET_BURST);
  return vars;
}

function sweepCadence(text) {
  const schedules = [...text.matchAll(/^\s+- cron: "([^"]+)"$/gm)].map((match) => match[1]);
  const quoted = (cron) => text.includes(`'${cron}'`) || text.includes(`"${cron}"|`);
  const normalFanout =
    /FANOUT_MODE: \$\{\{ github\.event\.schedule == '([^']+)' && 'normal-review'/.exec(text)?.[1];
  const auditFanout = /\(github\.event\.schedule == '([^']+)' && 'audit' \|\| 'hot-intake'\)/.exec(
    text,
  )?.[1];
  const fanoutIf = /\n  target-fanout:\n[\s\S]*?\n    if: \$\{\{([^\n]*)\}\}/.exec(text)?.[1] ?? "";
  const hotFanout = [...fanoutIf.matchAll(/github\.event\.schedule == '([^']+)'/g)]
    .map((match) => match[1])
    .filter((cron) => cron !== normalFanout && cron !== auditFanout);
  assert.equal(hotFanout.length, 1, "expected one hot fanout cron");
  // The direct openclaw/openclaw normal planner is the only schedule that no
  // routing expression names: it falls through to the default plan job.
  const fallthrough = schedules.filter((cron) => !quoted(cron));
  assert.equal(fallthrough.length, 1, `expected one fallthrough schedule: ${fallthrough}`);
  const cadence = {
    hotDirect: "*/5 * * * *",
    normalDirect: fallthrough[0],
    hotFanout: hotFanout[0],
    normalFanout,
  };
  for (const cron of Object.values(cadence)) assert.ok(schedules.includes(cron), cron);
  return cadence;
}

function cronMinutes(expression) {
  const [minute, ...rest] = expression.split(" ");
  assert.deepEqual(rest, ["*", "*", "*", "*"], `hourly cron expected: ${expression}`);
  if (minute.includes(",")) return minute.split(",").map(Number);
  const step = /^(\*|\d+)\/(\d+)$/.exec(minute);
  if (step) {
    const minutes = [];
    for (let value = step[1] === "*" ? 0 : Number(step[1]); value < 60; value += Number(step[2]))
      minutes.push(value);
    return minutes;
  }
  assert.match(minute, /^\d+$/);
  return [Number(minute)];
}

function poisson(events, kind, perHour, horizon, seed) {
  if (!perHour) return;
  const random = mulberry32(seed);
  for (let at = T0; ;) {
    at += Math.max(1, Math.round((-Math.log(1 - random()) * HOUR) / perHour));
    if (at >= horizon) break;
    events.push({ at, kind });
  }
}

// Piecewise Poisson arrivals with one rate per simulated hour.
function hourlyPoisson(events, kind, ratesByHour, seed) {
  const random = mulberry32(seed);
  ratesByHour.forEach((perHour, hour) => {
    const end = T0 + (hour + 1) * HOUR;
    for (let at = T0 + hour * HOUR; ;) {
      at += Math.max(1, Math.round((-Math.log(1 - random()) * HOUR) / perHour));
      if (at >= end) break;
      events.push({ at, kind });
    }
  });
}

function plannedEvents(cadence, scenario) {
  const horizon = T0 + scenario.hours * HOUR;
  const events = [];
  if (scenario.newPerHourByHour) {
    assert.equal(scenario.newPerHourByHour.length, scenario.hours);
    hourlyPoisson(events, "organic", scenario.newPerHourByHour, 0xc1a55e + scenario.newPerHour);
  } else poisson(events, "organic", scenario.newPerHour, horizon, 0xc1a55e + scenario.newPerHour);
  for (let index = 0; index < (scenario.spikeCount ?? 0); index++) {
    events.push({ at: T0 + scenario.spikeAtMinute * MINUTE, kind: "organic" });
  }
  poisson(events, "supersede", scenario.supersedePerHour, horizon, 0x5e7e + scenario.newPerHour);
  const offers = [
    [cadence.hotDirect, "hot_intake", "direct", DIRECT_PLANNER_LATENCY, DIRECT_OFFER_CANDIDATES],
    [
      cadence.hotFanout,
      "hot_intake",
      "fanout",
      FANOUT_PLANNER_LATENCY,
      HOT_FANOUT_OFFER_CANDIDATES,
    ],
    [
      cadence.normalDirect,
      "normal_backfill",
      "direct",
      DIRECT_PLANNER_LATENCY,
      DIRECT_OFFER_CANDIDATES,
    ],
    [
      cadence.normalFanout,
      "normal_backfill",
      "fanout",
      FANOUT_PLANNER_LATENCY,
      NORMAL_FANOUT_OFFER_CANDIDATES,
    ],
  ];
  for (let hour = 0; hour < scenario.hours; hour++) {
    for (const [cron, lane, source, latency, limit] of offers) {
      for (const minute of cronMinutes(cron)) {
        const at = T0 + hour * HOUR + (minute + latency) * MINUTE + 30_000;
        if (at < horizon) events.push({ at, kind: "offer", lane, source, limit });
      }
    }
  }
  for (let minute = 0; minute < scenario.hours * 60; minute++)
    events.push({ at: T0 + minute * MINUTE + 59_000, kind: "sample" });
  return events;
}

function reviewDuration(itemNumber, attempt) {
  return Math.round((4 + mulberry32(itemNumber * 31 + attempt)() * 6) * MINUTE);
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
let dispatches = [];
let unexpected = [];
// Items the live dispatch-time check reports closed: the queue completes them
// without dispatching a review, as it does for production items closed early.
let closedItems = new Set();
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  let body = {};
  let code = 200;
  if (url.pathname.endsWith("/installation")) body = { id: 999 };
  else if (url.pathname === "/app/installations/999/access_tokens") {
    body = { token: "synthetic-installation-token", expires_at: "2100-01-01T00:00:00Z" };
  } else if (url.pathname.endsWith("/actions/workflows/sweep.yml")) body = { state: "active" };
  else if (/\/issues\/\d+$/.test(url.pathname)) {
    const itemNumber = Number(url.pathname.split("/").pop());
    body = { state: closedItems.has(itemNumber) ? "closed" : "open" };
  } else if (
    url.pathname === "/repos/openclaw/clawsweeper/dispatches" &&
    request.method === "POST"
  ) {
    let text = "";
    for await (const chunk of request) text += chunk;
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
    "Scheduled admission with bounded organic debt: per-hour organic admissions, claimed review executions, scheduled admissions and sheds, rolling execution totals, organic overload, and throttle pause for origin/main versus this branch.",
  base: git("rev-parse", baseRef),
  head: git("rev-parse", "HEAD"),
  working_tree_dirty: Boolean(git("status", "--porcelain", "--", ...FILES)),
  node: process.version,
  workerd: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  runtime: "workerd / SQLite Durable Object / native loopback GitHub fixture / fake clock",
  model: {
    organic_new:
      "new-item webhook enqueues (issues/opened), seeded Poisson arrivals; always a new key",
    organic_supersede:
      "issues/edited with supersedesInProgress for a random dispatching or leased organic item (production_2026_10_01: dispatching only, before its run claims); revokes the owner",
    organic_requeue:
      "an organic completion reports requeue_latest with the scenario's probability, as source-drift completions do",
    organic_closed_before_dispatch:
      "production_2026_10_01 only: a seeded share of new organic items reads closed at the queue's dispatch-time live check and is completed without a run",
    execution: "a successful /claim of a dispatched review lease (one workflow run attempt)",
    offers:
      "each offer follows scheduled-review-enqueue: fresh candidates until the first shed; direct planners +3 min, fanout planners +6 min after cron",
    candidates_per_offer: {
      direct: DIRECT_OFFER_CANDIDATES,
      hot_fanout: HOT_FANOUT_OFFER_CANDIDATES,
      normal_fanout: NORMAL_FANOUT_OFFER_CANDIDATES,
    },
    claim_latency_minutes: CLAIM_LATENCY / MINUTE,
    review_minutes: "uniform 4-10 (mean 7) per execution",
    alarms:
      "delivered at the queue's own requested wake time (min 1 s apart); stats sampled each simulated minute",
    admission:
      "organic new key admitted, supersede admitted, requeue_latest completion requeued, or scheduled item admitted",
  },
  variants: {},
};
const runtimeFactories = {};

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
    const cadence = sweepCadence(read(".github/workflows/sweep.yml"));
    const entry = path.join(out, `${variant}-proof-worker.ts`);
    writeFileSync(
      entry,
      `
import { ExactReviewQueue } from ${JSON.stringify(path.join(dir, "dashboard/exact-review-queue.ts"))};
let proofNow = ${T0};
Date.now = () => proofNow;
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) { super(ctx, {...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => 'public'}, () => 0.5); }
  // Real workerd alarms would fire at wall-clock time; the proof drives the
  // alarm handler only through explicit fake-clock ticks.
  async alarm() {}
  async fetch(request) {
    proofNow = Number(request.headers.get('x-proof-now'));
    const op = new URL(request.url).pathname.split('/').slice(2).join('/');
    let response;
    if (op === '__tick') { await super.alarm(); response = Response.json({ ok: true }); }
    else if (op === '__persisted-budget') {
      response = Response.json({
        buckets: Object.fromEntries(['global', 'hot_intake', 'normal_backfill'].map(lane =>
          [lane, this.storage.kv.get('exact-review-scheduled-feed:v1:' + lane)])),
        items: Array.from(this.storage.sql.exec('SELECT * FROM exact_review_queue_items ORDER BY item_key')),
        deliveries: Array.from(this.storage.sql.exec('SELECT * FROM exact_review_queue_deliveries ORDER BY delivery_id')),
      });
    }
    else response = await super.fetch(new Request('https://queue/' + op, { method: request.method, body: request.method === 'POST' ? await request.text() : undefined }));
    // Report the queue's own next wake so the harness delivers alarms when the
    // queue asks for them, as workerd would in production.
    const headers = new Headers(response.headers);
    headers.set('x-proof-alarm', String((await this.storage.getAlarm()) ?? ''));
    return new Response(response.body, { status: response.status, headers });
  }
}
export default { fetch(request, env) { return env.QUEUE.get(env.QUEUE.idFromName(new URL(request.url).pathname.split('/')[1])).fetch(request); } };
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
    const startMiniflare = (persist, overrides = {}) =>
      new Miniflare({
        name: "scheduled-budget-proof",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-07-08",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { QUEUE: { className: "ProofQueue", useSQLite: true } },
        ...(persist ? { durableObjectsPersist: persist } : {}),
        bindings: {
          ...vars,
          ...overrides,
          GITHUB_API_URL: `http://${address}`,
          CLAWSWEEPER_APP_CLIENT_ID: "Iv23fixture",
          CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        },
        outboundService: { external: { address, http: {} } },
      });
    runtimeFactories[variant] = startMiniflare;
    const result = {
      source_sha256: Object.fromEntries(
        FILES.map((file) => [file, createHash("sha256").update(read(file)).digest("hex")]),
      ),
      config: Object.fromEntries(
        [
          "EXACT_REVIEW_TARGET_RATE_PER_HOUR",
          "EXACT_REVIEW_TARGET_BURST",
          "EXACT_REVIEW_HOT_INTAKE_RATE_PER_HOUR",
          "EXACT_REVIEW_SCHEDULED_MAX_CONCURRENT",
          "EXACT_REVIEW_QUEUE_MAX_CONCURRENT",
          "EXACT_REVIEW_PENDING_SOFT_LIMIT",
        ].map((name) => [name, vars[name] ?? null]),
      ),
      cadence,
      scenarios: {},
    };
    // One isolated workerd instance per scenario keeps queue state and
    // dispatch receipts from leaking between scenarios.
    for (const scenario of SCENARIOS) {
      const mf = startMiniflare();
      try {
        await mf.ready;
        result.scenarios[scenario.name] = await runScenario(mf, scenario, cadence, vars);
      } finally {
        await mf.dispose();
      }
    }
    const reconciliation = startMiniflare();
    try {
      await reconciliation.ready;
      result.reconciliation = await proveReconciliationDebit(reconciliation);
    } finally {
      await reconciliation.dispose();
    }
    receipt.variants[variant] = result;
  }
  receipt.upgrade_rollback = await provePersistedBudgetCompatibility(runtimeFactories);
  assert.deepEqual(unexpected, [], "unexpected external fixture route");
  receipt.limits =
    "Synthetic GitHub fixture, RSA credential, organic arrival process and mix, closed-before-dispatch share, planner latency and review durations. Real queue admission, token buckets, supersession, requeue, dispatch-time live checks, dispatch, claim, completion, reconciliation, throttle feedback, alarms and SQLite storage. An execution is a successful claim; a run that claims and then exits early is still counted. No live inference, production state or GitHub mutations. clawhub/other-target supply, stale-head pull request deletes and GitHub Actions scheduling jitter are not modeled. Candidate supply is unlimited, the pessimistic case for the budget and for normal-backfill share.";
  writeFileSync(path.join(out, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(summary(receipt), null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// Upgrade from the base revision to the candidate and roll back again,
// reopening the same SQLite Durable Object each time. Work the base admitted
// (and charged at admission) is still in flight across the upgrade.
async function provePersistedBudgetCompatibility(factories) {
  const results = [];
  for (const profile of [
    {
      name: "rate_60_burst_6",
      burst: 6,
      overrides: {
        EXACT_REVIEW_TARGET_RATE_PER_HOUR: "60",
        EXACT_REVIEW_TARGET_BURST: "6",
        EXACT_REVIEW_HOT_INTAKE_RATE_PER_HOUR: "",
      },
    },
    { name: "production_220_24", burst: 24, overrides: {} },
  ]) {
    for (const seed of [
      { name: "positive", organic: 2, scheduled: 0 },
      { name: "exhausted", organic: profile.burst, scheduled: 0 },
      { name: "persisted_lanes", organic: 1, scheduled: 2 },
    ]) {
      const persist = path.join(out, "persisted-budget", `${profile.name}-${seed.name}`);
      let mf;
      let now = T0;
      dispatches = [];
      closedItems = new Set();
      const call = async (op, body) => {
        const response = await mf.dispatchFetch(`http://proof/persisted-budget/${op}`, {
          method: body ? "POST" : "GET",
          headers: { "x-proof-now": String(now), "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const value = await response.json();
        assert.ok(response.ok, `${op}: ${JSON.stringify(value)}`);
        return value;
      };
      const open = async (variant) => {
        mf = factories[variant](persist, profile.overrides);
        await mf.ready;
        return (await call("stats")).scheduled_feed;
      };
      const balance = async () => (await call("stats")).scheduled_feed.token_balance;
      const claim = (dispatch) =>
        call("claim", {
          item_key: dispatch.queue_claim.item_key,
          lease_id: dispatch.queue_lease_id,
          lease_revision: dispatch.queue_claim.lease_revision,
          run_id: String(1_700_000 + Number(dispatch.item_number) - 700_000),
          run_attempt: 1,
        });
      const itemRow = (rows, itemNumber) =>
        JSON.parse(
          rows.items.find((row) => row.item_key === `openclaw/openclaw#${itemNumber}`).item_json,
        );
      const close = async () => {
        await mf.dispose();
        mf = undefined;
      };
      const offer = (number, action = "opened") =>
        call("enqueue", {
          delivery_id: `persisted-${number}`,
          decision: {
            targetRepo: "openclaw/openclaw",
            targetBranch: "main",
            itemNumber: number,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction: action,
            sourceUpdatedAt: new Date(T0 - HOUR).toISOString(),
            supersedesInProgress: false,
          },
        });
      const rowsDigest = (value) =>
        createHash("sha256")
          .update(
            JSON.stringify({
              items: value.items,
              deliveries: value.deliveries,
            }),
          )
          .digest("hex");
      try {
        // 1. The base admits the seed work.
        await open("baseline");
        for (let index = 0; index < seed.organic; index++) {
          assert.equal((await offer(700_000 + index)).queued, true);
        }
        for (let index = 0; index < seed.scheduled; index++) {
          const action = index === 0 ? "scheduled_hot_intake" : "scheduled_normal_backfill";
          assert.equal((await offer(705_000 + index, action)).queued, true);
        }
        const baseBalance = await balance();
        const stored = await call("__persisted-budget");
        assert.equal(stored.items.length, seed.organic + seed.scheduled);
        await close();

        // 2. Upgrade at the same instant: identical records, no fresh burst.
        const upgraded = await open("candidate");
        assert.deepEqual(
          await call("__persisted-budget"),
          stored,
          "upgrade preserves bucket, item and delivery records",
        );
        assert.equal(upgraded.token_balance, baseBalance, "upgrade does not mint a fresh burst");

        // 3. Candidate admissions: organic is free until it runs; a scheduled
        // admission debits once and marks its item prepaid.
        assert.equal((await offer(710_000)).queued, true);
        assert.equal(await balance(), baseBalance, "candidate organic admission is free");
        const prepaid = (await offer(715_000, "scheduled_normal_backfill")).queued === true;
        const afterAdmissions = await balance();
        assert.equal(baseBalance - afterAdmissions, prepaid ? 1 : 0);
        if (prepaid) {
          assert.equal(
            itemRow(await call("__persisted-budget"), 715_000).reviewBudgetPrepaid,
            true,
          );
        }

        // 4. Dispatch everything, then claim all but the prepaid scheduled
        // lease at one frozen instant. Base-admitted work is charged again.
        const expectedDispatches = seed.organic + seed.scheduled + 1 + (prepaid ? 1 : 0);
        for (let tick = 0; tick < 60 && dispatches.length < expectedDispatches; tick++) {
          now += 30_000;
          await call("__tick");
        }
        assert.equal(dispatches.length, expectedDispatches, "every admitted item dispatches");
        const prepaidDispatch = dispatches.find(
          (payload) => Number(payload.item_number) === 715_000,
        );
        const claimed = dispatches.filter((payload) => payload !== prepaidDispatch);
        const beforeClaims = await balance();
        for (const payload of claimed) assert.equal((await claim(payload)).claimed, true);
        const afterClaims = await balance();
        const expectedDebits = Math.min(claimed.length, beforeClaims + profile.burst);
        assert.equal(
          beforeClaims - afterClaims,
          expectedDebits,
          "one debit per claim to the floor",
        );
        assert.ok(afterClaims >= -profile.burst);
        const upgradedRows = await call("__persisted-budget");
        await close();

        // 5. Roll back at the same instant: the base reads the same records and
        // the same carried debt, ignores the prepaid marker, and charges its own
        // new admissions again.
        const rolledBack = await open("baseline");
        assert.deepEqual(
          await call("__persisted-budget"),
          upgradedRows,
          "rollback reads the same persisted records",
        );
        assert.equal(rolledBack.token_balance, afterClaims, "rollback keeps the carried balance");
        if (prepaidDispatch) {
          assert.equal((await claim(prepaidDispatch)).claimed, true);
          assert.equal(await balance(), afterClaims, "the base does not charge claims");
          assert.equal(
            itemRow(await call("__persisted-budget"), 715_000).reviewBudgetPrepaid,
            true,
            "the base preserves the unknown marker",
          );
        }
        const beforeBaseAdmission = await balance();
        assert.equal((await offer(720_000)).queued, true);
        const baseAdmissionDebit = beforeBaseAdmission - (await balance());
        results.push({
          profile: profile.name,
          seed: seed.name,
          base_admitted: { organic: seed.organic, scheduled: seed.scheduled },
          base_balance: baseBalance,
          upgraded_balance: upgraded.token_balance,
          candidate_organic_admission_debit: 0,
          candidate_scheduled_admitted_prepaid: prepaid,
          claims_after_upgrade: claimed.length,
          balance_before_claims: beforeClaims,
          balance_after_claims: afterClaims,
          base_admitted_work_charged_again_at_claim: seed.organic + seed.scheduled,
          rollback_balance: rolledBack.token_balance,
          rollback_prepaid_claim_debit: prepaidDispatch ? 0 : null,
          rollback_organic_admission_debit: baseAdmissionDebit,
          upgrade_rows_sha256: rowsDigest(stored),
          rollback_rows_sha256: rowsDigest(upgradedRows),
          item_records_preserved: true,
          delivery_records_preserved: true,
          lane_buckets_preserved: seed.scheduled > 0,
        });
      } finally {
        if (mf) await mf.dispose();
      }
    }
  }
  return results;
}

// Two executions of one item (the original and a reconciled changed-input
// successor) must cost exactly two tokens whichever step charges them, and
// replays must cost nothing. Each step is measured at a frozen clock.
async function proveReconciliationDebit(mf) {
  dispatches = [];
  closedItems = new Set();
  let now = T0;
  const call = async (op, body) => {
    const response = await mf.dispatchFetch(`http://proof/reconciliation/${op}`, {
      method: body ? "POST" : "GET",
      headers: { "x-proof-now": String(now), "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    assert.ok(response.ok, `${op}: ${JSON.stringify(value)}`);
    return value;
  };
  const balance = async () => (await call("stats")).scheduled_feed.token_balance;
  const debits = {};
  const step = async (name, action) => {
    const before = await balance();
    const value = await action();
    debits[name] = before - (await balance());
    return value;
  };
  const dispatchNext = async (count) => {
    for (let attempt = 0; attempt < 20 && dispatches.length < count; attempt++) {
      now += 30_000;
      await step(`dispatch_${count}_tick_${attempt}`, () => call("__tick"));
    }
    assert.equal(dispatches.length, count);
    return dispatches[count - 1];
  };
  const claim = (dispatch, runId) =>
    call("claim", {
      item_key: dispatch.queue_claim.item_key,
      lease_id: dispatch.queue_lease_id,
      lease_revision: dispatch.queue_claim.lease_revision,
      run_id: runId,
      run_attempt: 1,
    });
  const decision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 991013,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  };
  const admitted = await step("admission", () =>
    call("enqueue", { delivery_id: "reconcile-open", decision }),
  );
  assert.equal(admitted.queued, true);
  const first = await dispatchNext(1);
  const claimed = await step("claim", () => claim(first, "1999913"));
  assert.equal(claimed.claimed, true);
  const edited = await step("changed_input_follow_up", () =>
    call("enqueue", {
      delivery_id: "reconcile-edit",
      decision: { ...decision, sourceAction: "edited" },
    }),
  );
  assert.equal(edited.queued, true);
  const runs = [
    {
      run_id: "1999913",
      run_attempt: 1,
      claimed_run_attempt: 1,
      claim_generation: claimed.claim_generation,
      outcome: "success",
    },
  ];
  assert.equal((await step("reconcile_requeue", () => call("reconcile", { runs }))).requeued, 1);
  assert.equal((await step("reconcile_replay", () => call("reconcile", { runs }))).reconciled, 0);
  const successor = await dispatchNext(2);
  assert.equal((await step("successor_claim", () => claim(successor, "1999914"))).claimed, true);
  assert.equal(
    (await step("successor_claim_retry", () => claim(successor, "1999914"))).claimed,
    true,
  );
  const total = Object.values(debits).reduce((sum, value) => sum + value, 0);
  assert.equal(total, 2, `two executions cost two tokens: ${JSON.stringify(debits)}`);
  assert.equal(debits.reconcile_replay, 0);
  assert.equal(debits.successor_claim_retry, 0);
  const charged = Object.fromEntries(Object.entries(debits).filter(([, value]) => value !== 0));
  return { executions: 2, total_debits: total, charged_steps: charged, replay_debits: 0 };
}

async function runScenario(mf, scenario, cadence, vars) {
  dispatches = [];
  closedItems = new Set();
  const rate = Number(vars.EXACT_REVIEW_TARGET_RATE_PER_HOUR);
  const burst = Number(vars.EXACT_REVIEW_TARGET_BURST);
  const queue = plannedEvents(cadence, scenario);
  const order = { complete: 0, claim: 1, organic: 2, supersede: 2, offer: 3, tick: 4, sample: 5 };
  const hours = Array.from({ length: scenario.hours }, () => ({
    organic: { new: 0, supersede: 0, requeue: 0 },
    organic_attempted: { new: 0, supersede: 0 },
    organic_closed_before_dispatch: 0,
    scheduled: { hot_intake: 0, normal_backfill: 0 },
    scheduled_offers: { hot_intake: 0, normal_backfill: 0 },
    offer_sequences_fully_shed: 0,
    shed: { scheduled_rate: 0, backpressure: 0 },
    dispatched: { organic: 0, scheduled: 0 },
    executed: { organic: 0, scheduled: 0 },
    completed: 0,
    min_token_balance: null,
  }));
  const admissions = [];
  const executions = [];
  const admittedAt = new Map();
  const dispatchDelay = { organic: [], scheduled: [] };
  const active = new Map(); // organic item number -> current lease id
  const unclaimed = new Map(); // organic item number -> dispatched lease not yet claimed
  const revokedLeases = new Set();
  const executionAttempts = new Map();
  const requeueRandom = mulberry32(0x7e9 + scenario.newPerHour);
  const supersedeRandom = mulberry32(0x5b + scenario.newPerHour);
  const closedRandom = mulberry32(0xc105ed + scenario.newPerHour);
  let staleClaims = 0;
  let staleCompletions = 0;
  let supersedeSkipped = 0;
  let maxScheduledActive = 0;
  let maxReviewActive = 0;
  let minTokenBalance = Infinity;
  let organicNumber = 100_000;
  let scheduledNumber = 500_000;
  let runId = 1_000_000;
  let seenDispatches = 0;
  let throttle = null;
  let alarmTick = null;
  let lastTickAt = 0;
  let ticks = 0;
  const hourOf = (at) => Math.min(scenario.hours - 1, Math.floor((at - T0) / HOUR));
  const kindOf = (itemNumber) => (itemNumber >= 500_000 ? "scheduled" : "organic");
  const inThrottle = (at) => throttle && at >= throttle.at && at < throttle.until;
  const drainDispatches = (at) => {
    for (const payload of dispatches.slice(seenDispatches)) {
      const itemNumber = Number(payload.item_number);
      const kind = kindOf(itemNumber);
      assert.ok(!closedItems.has(itemNumber), "an item closed before dispatch never dispatches");
      hours[hourOf(at)].dispatched[kind]++;
      if (admittedAt.has(itemNumber)) {
        dispatchDelay[kind].push(at - admittedAt.get(itemNumber));
        admittedAt.delete(itemNumber);
      }
      if (kind === "organic") {
        active.set(itemNumber, payload.queue_lease_id);
        unclaimed.set(itemNumber, payload.queue_lease_id);
      }
      queue.push({ at: at + CLAIM_LATENCY, kind: "claim", payload, itemNumber });
    }
    seenDispatches = dispatches.length;
  };
  const call = async (op, at, body) => {
    const response = await mf.dispatchFetch(`http://proof/${scenario.name}/${op}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-proof-now": String(at) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = { status: response.status, body: await response.json() };
    const alarm = Number(response.headers.get("x-proof-alarm") || NaN);
    if (Number.isFinite(alarm)) {
      const tickAt = Math.max(alarm, at, lastTickAt + 1_000);
      if (!alarmTick || alarmTick.at !== tickAt) {
        if (alarmTick) alarmTick.cancelled = true;
        alarmTick = { at: tickAt, kind: "tick" };
        queue.push(alarmTick);
      }
    } else if (alarmTick) {
      alarmTick.cancelled = true;
      alarmTick = null;
    }
    drainDispatches(at);
    return result;
  };
  const organicDecision = (itemNumber, sourceAction, supersedesInProgress) => ({
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction,
    supersedesInProgress,
  });
  while (queue.length) {
    queue.sort((left, right) => left.at - right.at || order[left.kind] - order[right.kind]);
    const event = queue.shift();
    if (event.cancelled || event.at >= T0 + scenario.hours * HOUR) continue;
    const bucket = hours[hourOf(event.at)];
    if (event.kind === "organic") {
      const itemNumber = organicNumber++;
      bucket.organic_attempted.new++;
      if (closedRandom() < (scenario.closedBeforeDispatchFraction ?? 0)) {
        closedItems.add(itemNumber);
        bucket.organic_closed_before_dispatch++;
      }
      const { body } = await call("enqueue", event.at, {
        delivery_id: `organic-${itemNumber}`,
        decision: organicDecision(itemNumber, "opened", false),
      });
      assert.equal(body.queued, true, `organic new item was not admitted: ${JSON.stringify(body)}`);
      bucket.organic.new++;
      admissions.push({ at: event.at, kind: "organic" });
      admittedAt.set(itemNumber, event.at);
      if (inThrottle(event.at)) throttle.organic_admitted_while_paused++;
    } else if (event.kind === "supersede") {
      const owners = scenario.supersedeOwner === "dispatching" ? unclaimed : active;
      const candidates = [...owners.keys()];
      if (!candidates.length) {
        supersedeSkipped++;
        continue;
      }
      const itemNumber = candidates[Math.floor(supersedeRandom() * candidates.length)];
      bucket.organic_attempted.supersede++;
      const { body } = await call("enqueue", event.at, {
        delivery_id: `supersede-${itemNumber}-${event.at}`,
        decision: organicDecision(itemNumber, "edited", true),
      });
      assert.equal(body.queued, true, `supersede was not admitted: ${JSON.stringify(body)}`);
      revokedLeases.add(owners.get(itemNumber));
      active.delete(itemNumber);
      unclaimed.delete(itemNumber);
      bucket.organic.supersede++;
      admissions.push({ at: event.at, kind: "organic" });
      admittedAt.set(itemNumber, event.at);
      if (inThrottle(event.at)) throttle.organic_admitted_while_paused++;
    } else if (event.kind === "offer") {
      bucket.scheduled_offers[event.lane]++;
      for (let index = 0; index < event.limit; index++) {
        const itemNumber = scheduledNumber++;
        const { body } = await call("enqueue", event.at, {
          delivery_id: `scheduled-${event.lane}-${event.source}-${itemNumber}`,
          decision: {
            targetRepo: "openclaw/openclaw",
            targetBranch: "main",
            itemNumber,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction:
              event.lane === "hot_intake" ? "scheduled_hot_intake" : "scheduled_normal_backfill",
            supersedesInProgress: false,
            sourceUpdatedAt: new Date(event.at - HOUR).toISOString(),
          },
        });
        if (body.queued === true) {
          bucket.scheduled[event.lane]++;
          admissions.push({ at: event.at, kind: "scheduled" });
          admittedAt.set(itemNumber, event.at);
          if (inThrottle(event.at)) throttle.scheduled_admitted_while_paused++;
          if (throttle && event.at >= throttle.until && event.at < throttle.until + 30 * MINUTE)
            throttle.scheduled_admitted_30_minutes_after_recovery++;
        } else if (body.shed === true) {
          bucket.shed[body.reason] = (bucket.shed[body.reason] ?? 0) + 1;
          if (index === 0) bucket.offer_sequences_fully_shed++;
          if (inThrottle(event.at)) throttle.scheduled_shed_while_paused++;
          break;
        } else throw new Error(`unexpected scheduled disposition ${JSON.stringify(body)}`);
      }
    } else if (event.kind === "tick") {
      if (event === alarmTick) alarmTick = null;
      lastTickAt = event.at;
      assert.ok(++ticks < 400_000, "alarm loop did not settle");
      await call("__tick", event.at, {});
    } else if (event.kind === "sample") {
      const { body: stats } = await call("stats", event.at);
      maxScheduledActive = Math.max(maxScheduledActive, Number(stats.scheduled_feed?.active ?? 0));
      const balance = Number(stats.scheduled_feed?.token_balance ?? 0);
      minTokenBalance = Math.min(minTokenBalance, balance);
      bucket.min_token_balance = Math.min(bucket.min_token_balance ?? Infinity, balance);
      maxReviewActive = Math.max(
        maxReviewActive,
        Number(stats.lanes?.review?.leased ?? 0) + Number(stats.lanes?.review?.dispatching ?? 0),
      );
    } else if (event.kind === "claim") {
      const leaseId = event.payload.queue_lease_id;
      const claimBody = {
        lease_id: leaseId,
        item_key: event.payload.queue_claim.item_key,
        lease_revision: event.payload.queue_claim.lease_revision,
        run_id: String(runId++),
        run_attempt: 1,
      };
      const { status, body } = await call("claim", event.at, claimBody);
      if (unclaimed.get(event.itemNumber) === leaseId) unclaimed.delete(event.itemNumber);
      if (status !== 200 && revokedLeases.has(leaseId)) {
        staleClaims++;
        continue;
      }
      assert.equal(status, 200, `claim failed: ${JSON.stringify(body)}`);
      const kind = kindOf(event.itemNumber);
      bucket.executed[kind]++;
      executions.push({ at: event.at, kind });
      const attempt = (executionAttempts.get(event.itemNumber) ?? 0) + 1;
      executionAttempts.set(event.itemNumber, attempt);
      queue.push({
        at: event.at + reviewDuration(event.itemNumber, attempt),
        kind: "complete",
        itemNumber: event.itemNumber,
        leaseId,
        completion: { ...claimBody, claim_generation: body.claim_generation },
      });
    } else if (event.kind === "complete") {
      const organic = kindOf(event.itemNumber) === "organic";
      const throttleNow =
        scenario.throttleAtMinute !== undefined &&
        !throttle &&
        event.at >= T0 + scenario.throttleAtMinute * MINUTE;
      const requeue = !throttleNow && organic && requeueRandom() < scenario.requeueProbability;
      const { status, body } = await call("complete", event.at, {
        ...event.completion,
        ...(throttleNow
          ? {
              outcome: "failure",
              retry_kind: "throttle",
              retry_at: new Date(event.at + 5 * MINUTE).toISOString(),
            }
          : { outcome: "success", ...(requeue ? { requeue_latest: true } : {}) }),
      });
      if (status !== 200 && revokedLeases.has(event.leaseId)) {
        staleCompletions++;
        continue;
      }
      assert.equal(status, 200, `completion failed: ${JSON.stringify(body)}`);
      bucket.completed++;
      if (organic && active.get(event.itemNumber) === event.leaseId)
        active.delete(event.itemNumber);
      if (requeue && body.requeued === true) {
        bucket.organic.requeue++;
        admissions.push({ at: event.at, kind: "organic" });
        admittedAt.set(event.itemNumber, event.at);
      }
      if (throttleNow) {
        const { body: stats } = await call("stats", event.at);
        throttle = {
          at: event.at,
          until: event.at + THROTTLE_COOLDOWN,
          signalled_minute: (event.at - T0) / MINUTE,
          stats_throttle_source: stats.scheduled_feed?.throttle_source ?? null,
          stats_throttle_recovery_at: stats.scheduled_feed?.throttle_recovery_at ?? null,
          scheduled_admitted_while_paused: 0,
          scheduled_shed_while_paused: 0,
          organic_admitted_while_paused: 0,
          scheduled_admitted_30_minutes_after_recovery: 0,
        };
      }
    }
  }
  const maxRollingHour = (entries) => {
    entries.sort((left, right) => left.at - right.at);
    let max = 0;
    let window = null;
    for (let start = 0, end = 0; end < entries.length; end++) {
      while (entries[end].at - entries[start].at >= HOUR) start++;
      if (end - start + 1 > max) {
        max = end - start + 1;
        const slice = entries.slice(start, end + 1);
        window = {
          start_minute: (entries[start].at - T0) / MINUTE,
          end_minute: (entries[end].at - T0) / MINUTE,
          organic: slice.filter((entry) => entry.kind === "organic").length,
          scheduled: slice.filter((entry) => entry.kind === "scheduled").length,
        };
      }
    }
    return { max, window };
  };
  const rollingAdmissions = maxRollingHour(admissions);
  const rollingExecutions = maxRollingHour(executions);
  const perHour = hours.map((hour) => {
    const organic = hour.organic.new + hour.organic.supersede + hour.organic.requeue;
    const scheduled = hour.scheduled.hot_intake + hour.scheduled.normal_backfill;
    return {
      ...hour,
      organic_total: organic,
      total_admissions: organic + scheduled,
      total_executions: hour.executed.organic + hour.executed.scheduled,
    };
  });
  const report = {
    target_organic_per_hour: scenario.target,
    requeue_probability: Number(scenario.requeueProbability.toFixed(4)),
    ...(scenario.closedBeforeDispatchFraction
      ? { closed_before_dispatch_fraction: scenario.closedBeforeDispatchFraction }
      : {}),
    ...(scenario.supersedeOwner ? { supersede_owner: scenario.supersedeOwner } : {}),
    hours: perHour,
    max_rolling_hour_admissions: rollingAdmissions.max,
    max_rolling_hour_window: rollingAdmissions.window,
    max_rolling_hour_executions: rollingExecutions.max,
    max_rolling_hour_execution_window: rollingExecutions.window,
    scheduled_allowance_rate_plus_burst: rate + burst,
    min_global_token_balance: minTokenBalance,
    max_scheduled_active: maxScheduledActive,
    scheduled_cap: Number(vars.EXACT_REVIEW_SCHEDULED_MAX_CONCURRENT),
    max_review_active: maxReviewActive,
    stale_claims_after_supersede: staleClaims,
    stale_completions_after_supersede: staleCompletions,
    supersede_skipped_no_active_owner: supersedeSkipped,
    dispatch_delay_minutes: Object.fromEntries(
      Object.entries(dispatchDelay).map(([kind, values]) => [
        kind,
        {
          p50: values.length ? percentile(values, 0.5) / MINUTE : null,
          p95: values.length ? percentile(values, 0.95) / MINUTE : null,
          max: values.length ? Math.max(...values) / MINUTE : null,
        },
      ]),
    ),
    ...(throttle
      ? {
          throttle: {
            ...throttle,
            at: new Date(throttle.at).toISOString(),
            until: new Date(throttle.until).toISOString(),
          },
        }
      : {}),
  };
  assert.ok(minTokenBalance >= -burst, "global balance never drops below the -burst floor");
  for (const hour of hours) {
    assert.equal(hour.organic.new, hour.organic_attempted.new, "organic new items always admitted");
    assert.equal(hour.organic.supersede, hour.organic_attempted.supersede);
  }
  if (scenario.newPerHour > rate) {
    assert.ok(
      perHour.reduce((sum, hour) => sum + hour.total_admissions, 0) > rate * scenario.hours + burst,
      "unconditional organic admission is not a total-work cap",
    );
  }
  if (scenario.spikeCount) {
    const spikeAt = T0 + scenario.spikeAtMinute * MINUTE;
    const recovery = admissions.find((entry) => entry.kind === "scheduled" && entry.at > spikeAt);
    assert.ok(rollingAdmissions.max > rate + burst, "organic spike exceeds the allowance");
    assert.ok(recovery && recovery.at < spikeAt + HOUR, "bounded debt permits same-hour recovery");
    report.spike_recovery = {
      organic_admissions: scenario.spikeCount,
      first_scheduled_admission_minute: (recovery.at - T0) / MINUTE,
    };
  }
  if (scenario.throttleAtMinute !== undefined) {
    assert.ok(throttle, "throttle completion was not observed");
    assert.equal(
      throttle.scheduled_admitted_while_paused,
      0,
      "throttle must pause scheduled admission",
    );
    assert.ok(
      throttle.scheduled_shed_while_paused > 0,
      "paused window must receive scheduled offers",
    );
  }
  return report;
}

function summary(receiptValue) {
  const rows = {};
  for (const [variant, value] of Object.entries(receiptValue.variants)) {
    for (const [name, scenario] of Object.entries(value.scenarios)) {
      rows[`${variant}/${name}`] = {
        hours: scenario.hours.map(
          (hour) =>
            `organic ${hour.organic_total} (new ${hour.organic.new}, supersede ${hour.organic.supersede}, requeue ${hour.organic.requeue}; closed before dispatch ${hour.organic_closed_before_dispatch}) + hot ${hour.scheduled.hot_intake} + normal ${hour.scheduled.normal_backfill} = ${hour.total_admissions} admissions; executed organic ${hour.executed.organic} + scheduled ${hour.executed.scheduled} = ${hour.total_executions}; shed ${hour.shed.scheduled_rate} (offer sequences fully shed ${hour.offer_sequences_fully_shed}/${hour.scheduled_offers.hot_intake + hour.scheduled_offers.normal_backfill}); min balance ${hour.min_token_balance}`,
        ),
        max_rolling_hour_admissions: scenario.max_rolling_hour_admissions,
        max_rolling_hour_executions: scenario.max_rolling_hour_executions,
        scheduled_allowance: scenario.scheduled_allowance_rate_plus_burst,
        ...(scenario.spike_recovery ? { spike_recovery: scenario.spike_recovery } : {}),
        max_scheduled_active: scenario.max_scheduled_active,
        ...(scenario.throttle
          ? {
              throttle: {
                scheduled_admitted_while_paused: scenario.throttle.scheduled_admitted_while_paused,
                scheduled_shed_while_paused: scenario.throttle.scheduled_shed_while_paused,
                organic_admitted_while_paused: scenario.throttle.organic_admitted_while_paused,
                scheduled_admitted_30_minutes_after_recovery:
                  scenario.throttle.scheduled_admitted_30_minutes_after_recovery,
              },
            }
          : {}),
      };
    }
  }
  return {
    base: receiptValue.base,
    head: receiptValue.head,
    rows,
    upgrade_rollback: receiptValue.upgrade_rollback,
  };
}
