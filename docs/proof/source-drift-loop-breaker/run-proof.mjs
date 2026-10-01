// Real-runtime proof for the source-drift loop breaker and runaway alert.
// Usage: node docs/proof/source-drift-loop-breaker/run-proof.mjs BASE_REF TOOL_PREFIX FRESH_OUTPUT_DIR
// TOOL_PREFIX must contain miniflare and esbuild (for example a wrangler@4 install).
// FRESH_OUTPUT_DIR must not exist; the harness never removes caller data.
//
// For origin/main (baseline) and the checked-out branch (candidate), this builds
// the real dashboard Worker plus the real ExactReviewQueue Durable Object,
// runs them in workerd with SQLite storage and a fake clock, and drives the
// same signed-route payloads the workflows send:
//   self_requeue  organic review, then the publisher's remote-newer
//                 `source_drift_requeue` after every successful generation
//   release       an organic `edited` webhook decision after the loop
//   scheduled     a newer scheduled offer after the park releases one review,
//                 and that review's drift requeue re-parks without a reset
//   command       an explicit `re_review` command on a looping item
//   runaway       25 claimed reviews of one item inside 24 hours, read through
//                 the real public `/api/exact-review-queue` route
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
const FILES = [
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-read-model.ts",
  "dashboard/worker.ts",
  "dashboard/dashboard-health.ts",
  "dashboard/wrangler.toml",
];
const SOURCE_DRIFT_CYCLES = 6;
const RUNAWAY_REVIEWS = 25;

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
let dispatches = [];
let unexpected = [];
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
    "origin/main admits a source-drift requeue after every successful review generation forever; the branch parks the item as source_drift_loop after three consecutive automatic generations, an organic event or explicit command admits it normally, a newer scheduled offer releases one review whose next drift requeue re-parks immediately, and /api/exact-review-queue reports review_runaway_health degraded for an item past 24 claimed reviews per day.",
  base: git("rev-parse", baseRef),
  head: git("rev-parse", "HEAD"),
  working_tree_dirty: Boolean(git("status", "--porcelain", "--", ...FILES)),
  node: process.version,
  workerd: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  runtime:
    "workerd / real dashboard Worker + ExactReviewQueue SQLite Durable Object / loopback GitHub fixture / fake clock",
  model: {
    review_generation:
      "queue alarm dispatches the item, the fixture claims it with a fresh run id, then completes it with outcome=success (the item leaves the queue)",
    source_drift_requeue:
      "after each generation the harness sends the payload of sweep.yml 'Queue fresh review after source drift': the claimed decision with sourceAction=source_drift_requeue, supersedesInProgress=true, delivery publisher-source-drift:<run>:1",
    organic_release: "issues/edited webhook decision for the same item",
    scheduled_release:
      "scheduled_normal_backfill offer whose sourceUpdatedAt is one minute after the park, then the publisher's drift requeue after that review",
    command_release:
      "re_review decision with a clawsweeper-command-status marker and status comment id",
    runaway: `${RUNAWAY_REVIEWS} organic edits, each claimed and completed, within 4 simulated hours`,
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
import { summarizeDashboardHealth } from ${JSON.stringify(path.join(dir, "dashboard/dashboard-health.ts"))};
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
    if (url.pathname === '/__dashboard-health') {
      const stub = env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName('global'));
      const stats = await (await stub.fetch(new Request('https://clawsweeper-exact-review-queue/stats', { headers: { 'x-proof-now': String(proofNow) } }))).json();
      return Response.json(summarizeDashboardHealth({ exact_review_queue: stats }));
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
        name: "source-drift-loop-proof",
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
        EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_LIMIT:
          vars.EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_LIMIT ?? null,
        EXACT_REVIEW_RUNAWAY_REVIEWS_PER_DAY: vars.EXACT_REVIEW_RUNAWAY_REVIEWS_PER_DAY ?? null,
        PUBLIC_BAY_REPOS: vars.PUBLIC_BAY_REPOS ?? null,
      },
      scenarios: {},
    };
    for (const [name, scenario] of Object.entries({
      self_requeue_then_release: selfRequeueThenRelease,
      scheduled_release: scheduledRelease,
      command: commandPath,
      runaway: runawayAlert,
    })) {
      const mf = startMiniflare();
      try {
        await mf.ready;
        dispatches = [];
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
    "Synthetic GitHub fixture and RSA credential; issue items only (the breaker has no item-kind branch; PR release is covered by unit tests); the publisher workflow step is reproduced by sending its exact payload, not by running GitHub Actions; review execution is replaced by claim+complete; no live inference, production state, or GitHub mutation.";
  writeFileSync(path.join(out, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt.assertions, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function createDriver(mf) {
  const driver = {
    now: T0,
    runId: 4_000_000,
    seenDispatches: 0,
    async call(pathname, body) {
      const response = await mf.dispatchFetch(`http://proof${pathname}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-proof-now": String(driver.now), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      return { status: response.status, body: value };
    },
    async enqueue(deliveryId, decision) {
      const { status, body } = await driver.call("/q/enqueue", {
        delivery_id: deliveryId,
        decision,
      });
      assert.equal(status, 202, JSON.stringify(body));
      return body;
    },
    /** Advance past the debounce, tick, and claim+complete any newly dispatched review. */
    async runDispatchedReview(itemNumber) {
      driver.now += 2 * MINUTE;
      await driver.call("/q/__tick", {});
      const fresh = dispatches.slice(driver.seenDispatches);
      driver.seenDispatches = dispatches.length;
      const payload = fresh.find((entry) => Number(entry.item_number) === itemNumber);
      if (!payload) return null;
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
      driver.now += 5 * MINUTE;
      const complete = await driver.call("/q/complete", {
        ...tuple,
        claim_generation: claim.body.claim_generation,
        outcome: "success",
      });
      assert.equal(complete.status, 200, JSON.stringify(complete.body));
      return { runId: tuple.run_id, decision: claim.body.decision };
    },
    async item(itemNumber) {
      const stats = (await driver.call("/q/stats")).body;
      const review = stats.lanes.review;
      const key = `${REPO}#${itemNumber}`;
      const bay = (stats.bay_projection?.items ?? []).find((entry) => entry.item_key === key);
      return {
        review_lane_parked: review.parked,
        review_lane_parked_reasons: Object.fromEntries(
          Object.entries(review.parked_reasons ?? {}).filter(([, count]) => count > 0),
        ),
        queue_state: bay?.queue_state ?? null,
        bay_stage: bay?.stage ?? null,
      };
    },
  };
  return driver;
}

function issue(itemNumber, sourceAction, extra = {}) {
  return {
    targetRepo: REPO,
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction,
    supersedesInProgress: sourceAction === "edited",
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

async function selfRequeue(driver, itemNumber, cycles) {
  const steps = [];
  let reviewed = await driver.runDispatchedReview(itemNumber);
  assert.ok(reviewed, "organic review generation dispatched");
  let reviews = 1;
  let last = reviewed;
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    // sweep.yml: Queue fresh review after source drift (remote-newer publication).
    const requeue = await driver.enqueue(`publisher-source-drift:${last.runId}:${cycle}`, {
      ...last.decision,
      sourceAction: "source_drift_requeue",
      supersedesInProgress: true,
    });
    const state = await driver.item(itemNumber);
    reviewed = await driver.runDispatchedReview(itemNumber);
    if (reviewed) {
      reviews += 1;
      last = reviewed;
    }
    steps.push({
      cycle,
      requeue: disposition(requeue),
      queue_state_after_requeue: state.queue_state,
      parked_reasons: state.review_lane_parked_reasons,
      review_dispatched: Boolean(reviewed),
    });
  }
  return { steps, reviews, last };
}

async function selfRequeueThenRelease(driver) {
  const itemNumber = 97616;
  assert.equal(
    disposition(await driver.enqueue("organic-opened", issue(itemNumber, "opened"))),
    "queued",
  );
  const loop = await selfRequeue(driver, itemNumber, SOURCE_DRIFT_CYCLES);
  const beforeRelease = await driver.item(itemNumber);
  driver.now += MINUTE;
  const organic = await driver.enqueue("organic-edited", issue(itemNumber, "edited"));
  const afterRelease = await driver.item(itemNumber);
  const releasedReview = await driver.runDispatchedReview(itemNumber);
  const nextRequeue = releasedReview
    ? await driver.enqueue(`publisher-source-drift:${releasedReview.runId}:after-release`, {
        ...releasedReview.decision,
        sourceAction: "source_drift_requeue",
        supersedesInProgress: true,
      })
    : null;
  return {
    item: `${REPO}#${itemNumber}`,
    source_drift_cycles: loop.steps,
    review_generations_spent: loop.reviews,
    before_release: beforeRelease,
    organic_edited: disposition(organic),
    after_release: afterRelease,
    released_review_dispatched: Boolean(releasedReview),
    next_source_drift_after_release: nextRequeue ? disposition(nextRequeue) : null,
  };
}

async function scheduledRelease(driver) {
  const itemNumber = 97618;
  assert.equal(
    disposition(await driver.enqueue("organic-opened", issue(itemNumber, "opened"))),
    "queued",
  );
  const loop = await selfRequeue(driver, itemNumber, 4);
  // A scheduled backfill offer whose source update is later than the park, as
  // hot intake would send after ClawSweeper's own post-review writes.
  driver.now += MINUTE;
  const offer = await driver.enqueue(
    "scheduled-newer",
    issue(itemNumber, "scheduled_normal_backfill", {
      sourceUpdatedAt: new Date(driver.now).toISOString(),
    }),
  );
  const afterOffer = await driver.item(itemNumber);
  const reviewed = await driver.runDispatchedReview(itemNumber);
  const requeue = reviewed
    ? await driver.enqueue(`publisher-source-drift:${reviewed.runId}:after-scheduled`, {
        ...reviewed.decision,
        sourceAction: "source_drift_requeue",
        supersedesInProgress: true,
      })
    : null;
  const afterRequeue = await driver.item(itemNumber);
  const further = await driver.runDispatchedReview(itemNumber);
  return {
    item: `${REPO}#${itemNumber}`,
    source_drift_cycles: loop.steps.map((step) => step.requeue),
    scheduled_offer: disposition(offer),
    after_offer: afterOffer,
    scheduled_review_dispatched: Boolean(reviewed),
    drift_after_scheduled_review: requeue ? disposition(requeue) : null,
    after_drift: afterRequeue,
    further_review_dispatched: Boolean(further),
    review_generations_spent: loop.reviews + (reviewed ? 1 : 0) + (further ? 1 : 0),
  };
}

async function commandPath(driver) {
  const itemNumber = 123774;
  assert.equal(
    disposition(await driver.enqueue("organic-opened", issue(itemNumber, "opened"))),
    "queued",
  );
  const loop = await selfRequeue(driver, itemNumber, 4);
  driver.now += MINUTE;
  const command = await driver.enqueue(
    "command-re-review",
    issue(itemNumber, "re_review", {
      commandStatusMarker: `<!-- clawsweeper-command-status:${itemNumber}:re_review:proof -->`,
      statusCommentId: 9001,
    }),
  );
  const afterCommand = await driver.item(itemNumber);
  driver.now += 2 * MINUTE;
  await driver.call("/q/__tick", {});
  const commandDispatch = dispatches
    .slice(driver.seenDispatches)
    .find((entry) => Number(entry.item_number) === itemNumber);
  return {
    item: `${REPO}#${itemNumber}`,
    source_drift_cycles: loop.steps.map((step) => step.requeue),
    command: disposition(command),
    after_command: afterCommand,
    command_review_dispatched: Boolean(commandDispatch),
    dispatched_command_marker_present: Boolean(
      commandDispatch &&
      JSON.stringify(commandDispatch).includes(`clawsweeper-command-status:${itemNumber}`),
    ),
  };
}

async function runawayAlert(driver) {
  const itemNumber = 200001;
  const start = driver.now;
  assert.equal(
    disposition(await driver.enqueue("runaway-opened", issue(itemNumber, "opened"))),
    "queued",
  );
  let reviews = 0;
  if (await driver.runDispatchedReview(itemNumber)) reviews += 1;
  for (let edit = 1; reviews < RUNAWAY_REVIEWS; edit += 1) {
    assert.ok(edit < 100, "runaway scenario did not converge");
    await driver.enqueue(`runaway-edit-${edit}`, issue(itemNumber, "edited"));
    if (await driver.runDispatchedReview(itemNumber)) reviews += 1;
  }
  const elapsedHours = (driver.now - start) / (60 * MINUTE);
  const publicQueue = await driver.call("/api/exact-review-queue");
  const health = (await driver.call("/__dashboard-health")).body;
  // The window is trailing: after 25 more hours the same history ages out.
  driver.now += 25 * 60 * MINUTE;
  const aged = await driver.call("/api/exact-review-queue");
  return {
    item: `${REPO}#${itemNumber}`,
    claimed_reviews: reviews,
    elapsed_hours: Math.round(elapsedHours * 10) / 10,
    public_status: publicQueue.status,
    public_collection: publicQueue.body.collection ?? null,
    public_review_runaway_health: publicQueue.body.review_runaway_health ?? "absent",
    dashboard_health: health,
    after_25_hours: aged.body.review_runaway_health ?? "absent",
  };
}

function verify(variants) {
  const base = variants.baseline.scenarios;
  const cand = variants.candidate.scenarios;
  const checks = {
    baseline_requeues_every_cycle: base.self_requeue_then_release.source_drift_cycles.every(
      (step) => step.requeue === "queued" && step.review_dispatched,
    ),
    baseline_review_generations: base.self_requeue_then_release.review_generations_spent,
    candidate_first_three_requeues_admitted: cand.self_requeue_then_release.source_drift_cycles
      .slice(0, 3)
      .every((step) => step.requeue === "queued" && step.review_dispatched),
    candidate_fourth_requeue_parks:
      cand.self_requeue_then_release.source_drift_cycles[3].requeue ===
        "deduped:source_drift_loop:requeue_limit_reached" &&
      cand.self_requeue_then_release.source_drift_cycles[3].queue_state_after_requeue ===
        "parked" &&
      cand.self_requeue_then_release.source_drift_cycles[3].parked_reasons.source_drift_loop === 1,
    candidate_later_requeues_deduped: cand.self_requeue_then_release.source_drift_cycles
      .slice(4)
      .every(
        (step) =>
          step.requeue === "deduped:source_drift_loop:item_parked" && !step.review_dispatched,
      ),
    candidate_review_generations: cand.self_requeue_then_release.review_generations_spent,
    candidate_organic_release:
      cand.self_requeue_then_release.organic_edited === "queued" &&
      cand.self_requeue_then_release.after_release.queue_state === "pending" &&
      cand.self_requeue_then_release.released_review_dispatched &&
      cand.self_requeue_then_release.next_source_drift_after_release === "queued",
    baseline_scheduled_then_requeues:
      base.scheduled_release.scheduled_offer === "queued" &&
      base.scheduled_release.drift_after_scheduled_review === "queued" &&
      base.scheduled_release.further_review_dispatched,
    candidate_scheduled_releases_one_review_then_reparks:
      cand.scheduled_release.source_drift_cycles[3] ===
        "deduped:source_drift_loop:requeue_limit_reached" &&
      cand.scheduled_release.scheduled_offer === "queued" &&
      cand.scheduled_release.after_offer.queue_state === "pending" &&
      cand.scheduled_release.scheduled_review_dispatched &&
      cand.scheduled_release.drift_after_scheduled_review ===
        "deduped:source_drift_loop:requeue_limit_reached" &&
      cand.scheduled_release.after_drift.queue_state === "parked" &&
      !cand.scheduled_release.further_review_dispatched,
    candidate_command_release:
      cand.command.command === "queued" &&
      cand.command.after_command.queue_state === "pending" &&
      cand.command.command_review_dispatched &&
      cand.command.dispatched_command_marker_present,
    baseline_command_admitted:
      base.command.command === "queued" && base.command.command_review_dispatched,
    baseline_runaway_field: base.runaway.public_review_runaway_health,
    candidate_runaway_degraded:
      cand.runaway.public_status === 200 &&
      cand.runaway.public_collection?.state === "complete" &&
      cand.runaway.public_review_runaway_health?.status === "degraded" &&
      cand.runaway.public_review_runaway_health?.reason === "review_runaway" &&
      cand.runaway.public_review_runaway_health?.runaway_items === 1 &&
      cand.runaway.public_review_runaway_health?.sample_item_keys?.[0] === `${REPO}#200001` &&
      cand.runaway.dashboard_health.reasons.includes("review_runaway"),
    candidate_runaway_ages_out: cand.runaway.after_25_hours?.status === "healthy",
  };
  assert.equal(checks.baseline_requeues_every_cycle, true, "baseline must requeue forever");
  assert.equal(checks.baseline_scheduled_then_requeues, true, "baseline keeps requeueing");
  for (const [name, value] of Object.entries(checks)) {
    if (name.startsWith("candidate_") && typeof value === "boolean")
      assert.equal(value, true, name);
  }
  assert.equal(checks.baseline_review_generations, SOURCE_DRIFT_CYCLES + 1);
  assert.equal(checks.candidate_review_generations, 4);
  return checks;
}
