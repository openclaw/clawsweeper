// Drives the real ExactReviewQueue Durable Object in workerd (Miniflare,
// SQLite-backed) for a baseline ref and the candidate HEAD, following the
// object's own alarm schedule on a controlled clock. GitHub is a loopback
// fixture; nothing live is called or mutated.
//
// Usage: node scripts/proof-active-item-debounce.mjs BASE TOOL_PREFIX FRESH_OUTPUT_DIR
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
const MINUTE = 60_000;
const REVIEW_MS = 7 * MINUTE;
const T0 = Date.parse("2030-01-01T12:00:00Z");
const files = [
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-read-model.ts",
  "dashboard/exact-review-decision.ts",
];
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// Loopback GitHub: open items, a mutable live PR head, and captured dispatches.
const liveHeads = new Map();
let dispatches = [];
let unexpected = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  let body = {};
  let code = 200;
  const pull = url.pathname.match(/^\/repos\/openclaw\/openclaw\/pulls\/(\d+)$/);
  if (url.pathname.endsWith("/installation")) body = { id: 999 };
  else if (url.pathname === "/app/installations/999/access_tokens") {
    body = { token: "synthetic-installation-token", expires_at: "2099-01-01T00:00:00Z" };
  } else if (url.pathname.endsWith("/actions/workflows/sweep.yml")) body = { state: "active" };
  else if (pull) body = { state: "open", head: { sha: liveHeads.get(Number(pull[1])) } };
  else if (/\/issues\/\d+$/.test(url.pathname)) body = { state: "open" };
  else if (url.pathname === "/repos/openclaw/clawsweeper/dispatches" && request.method === "POST") {
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

const proofWorker = `
import { ExactReviewQueue } from './dashboard/exact-review-queue.ts';
let clock = 0;
Date.now = () => clock;
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) {
    super(ctx, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => 'public' }, () => 0.5);
  }
  async fetch(request) {
    const body = await request.json();
    clock = body.now;
    await this.ensureReady();
    let status = null;
    let result = null;
    const post = async (route, payload) => {
      const response = await super.fetch(new Request('https://queue/' + route, { method: 'POST', body: JSON.stringify(payload) }));
      status = response.status;
      result = await response.json().catch(() => null);
    };
    if (body.op === 'enqueue') await post('enqueue', { delivery_id: body.delivery_id, decision: body.decision });
    else if (body.op === 'claim' || body.op === 'complete') await post(body.op, body.payload);
    else if (body.op === 'alarm') await super.alarm();
    else if (body.op === 'stats') result = await (await super.fetch(new Request('https://queue/stats'))).json();
    let history = null;
    try {
      history = Array.from(this.storage.sql.exec('SELECT COUNT(*) AS n FROM exact_review_queue_review_completions'))[0].n;
    } catch { history = 'table_absent'; }
    const items = Object.values(this.readStateSync().items).map((item) => ({
      key: item.key, state: item.state, revision: item.revision, next_attempt_at: item.nextAttemptAt,
      backoff_reason: item.backoffReason ?? null, head: item.decision.sourceHeadSha ?? null,
    }));
    return Response.json({ status, result, alarm: await this.storage.getAlarm(), items, history });
  }
}
export default { fetch(request, env) { return env.QUEUE.get(env.QUEUE.idFromName(new URL(request.url).pathname)).fetch(request); } };
`;

async function bundleVariant(variant) {
  const dir = path.join(out, variant);
  mkdirSync(dir);
  execFileSync("tar", ["-x", "-C", dir], {
    input: execFileSync("git", ["archive", variant === "baseline" ? baseRef : "HEAD"], {
      maxBuffer: 128 * 1024 * 1024,
    }),
  });
  // An uncommitted candidate is proven from the working tree it will commit.
  if (variant === "candidate")
    for (const file of files) cpSync(path.join(root, file), path.join(dir, file));
  const entry = path.join(dir, "proof-worker.ts");
  writeFileSync(entry, proofWorker);
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
  });
  return {
    script: bundle.outputFiles[0].text,
    sources: Object.fromEntries(
      files.map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(path.join(dir, file)))
          .digest("hex"),
      ]),
    ),
  };
}

function miniflare(script, persist) {
  return new Miniflare({
    name: "active-item-debounce-proof",
    modules: true,
    script,
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { QUEUE: { className: "ProofQueue", useSQLite: true } },
    ...(persist ? { durableObjectsPersist: persist } : {}),
    bindings: {
      GITHUB_API_URL: `http://${address}`,
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23fixture",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      // Production values from dashboard/wrangler.toml. The baseline ignores
      // the active-item variables it does not know.
      EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "80",
      EXACT_REVIEW_TARGET_MAX_CONCURRENT: "64",
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "90000",
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS: "180000",
      EXACT_REVIEW_ACTIVE_ITEM_REVIEW_THRESHOLD: "2",
      EXACT_REVIEW_ACTIVE_ITEM_WINDOW_MS: "3600000",
      EXACT_REVIEW_ACTIVE_ITEM_DEBOUNCE_MS: "600000",
      EXACT_REVIEW_ACTIVE_ITEM_DEBOUNCE_MAX_MS: "900000",
    },
    outboundService: { external: { address, http: {} } },
  });
}

function decision(itemNumber, itemKind, sourceAction, extra = {}) {
  return {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber,
    itemKind,
    sourceEvent: itemKind === "pull_request" ? "pull_request" : "issues",
    sourceAction,
    supersedesInProgress: ["edited", "synchronize"].includes(sourceAction),
    ...extra,
  };
}

function push(at, itemNumber, sequence) {
  const sha = String(sequence).repeat(40);
  return {
    at,
    head: [itemNumber, sha],
    delivery_id: `push-${itemNumber}-${sequence}`,
    decision: decision(itemNumber, "pull_request", "synchronize", {
      sourceHeadSha: sha,
      sourceHeadVerified: true,
      sourceAuthoritySeq: sequence,
      sourceUpdatedAt: new Date(at).toISOString(),
    }),
  };
}

function edit(at, itemNumber, sequence, extra = {}) {
  return {
    at,
    delivery_id: `edit-${itemNumber}-${sequence}`,
    decision: decision(itemNumber, "issue", "edited", {
      sourceUpdatedAt: new Date(at).toISOString(),
      ...extra,
    }),
  };
}

// Discrete-event driver: webhook events at fixed times, the DO's own alarm,
// and a 7-minute review that claims at dispatch and completes unless revoked.
let runId = 700_000;
async function runTimeline(mf, name, events, until) {
  const call = async (now, op, extra = {}) =>
    (
      await mf.dispatchFetch(`http://proof/${name}`, {
        method: "POST",
        body: JSON.stringify({ now, op, ...extra }),
      })
    ).json();
  const queue = [...events].sort((left, right) => left.at - right.at);
  const completions = [];
  const log = { events: [], wakes: [], dispatches: [], completions: [] };
  let now = queue[0].at;
  for (let step = 0; step < 500; step += 1) {
    const state = await call(now, "state");
    const next = [
      queue.length ? ["event", queue[0].at] : null,
      completions.length ? ["complete", Math.min(...completions.map((entry) => entry.at))] : null,
      state.alarm !== null && state.alarm <= until ? ["alarm", state.alarm] : null,
    ]
      .filter(Boolean)
      .sort((left, right) => left[1] - right[1])[0];
    if (!next) break;
    now = Math.max(now, next[1]);
    if (next[0] === "event") {
      const event = queue.shift();
      if (event.head) liveHeads.set(event.head[0], event.head[1]);
      const result = await call(now, "enqueue", event);
      const item = result.items.find(
        (entry) => entry.key === `openclaw/openclaw#${event.decision.itemNumber}`,
      );
      log.events.push({
        at_min: (now - T0) / MINUTE,
        delivery: event.delivery_id,
        status: result.status,
        item_state: item?.state ?? null,
        revision: item?.revision ?? null,
        wait_ms: item ? item.next_attempt_at - now : null,
        backoff_reason: item?.backoff_reason ?? null,
      });
    } else if (next[0] === "complete") {
      const index = completions.findIndex((entry) => entry.at === next[1]);
      const [entry] = completions.splice(index, 1);
      const result = await call(now, "complete", { payload: entry.payload });
      log.completions.push({
        at_min: (now - T0) / MINUTE,
        item: entry.payload.item_key,
        lease_revision: entry.payload.lease_revision,
        status: result.status,
        error: result.result?.error ?? null,
      });
    } else {
      const before = dispatches.length;
      const result = await call(now, "alarm");
      const started = dispatches.slice(before);
      log.wakes.push({ at_min: (now - T0) / MINUTE, dispatched: started.length });
      for (const payload of started) {
        runId += 1;
        const claim = {
          lease_id: payload.queue_lease_id,
          item_key: payload.queue_claim.item_key,
          lease_revision: payload.queue_claim.lease_revision,
          run_id: String(runId),
          run_attempt: 1,
        };
        const claimed = await call(now, "claim", { payload: claim });
        assert.equal(claimed.status, 200, `claim ${JSON.stringify(claimed.result)}`);
        const item = result.items.find((entry) => entry.key === claim.item_key);
        log.dispatches.push({
          at_min: (now - T0) / MINUTE,
          item: claim.item_key,
          lease_revision: claim.lease_revision,
          head: item?.head ?? null,
        });
        completions.push({
          at: now + REVIEW_MS,
          payload: {
            ...claim,
            claim_generation: claimed.result.claim_generation,
            outcome: "success",
          },
        });
      }
    }
  }
  const final = await call(now, "stats");
  log.review_totals = {
    enqueued: final.result.lanes.review.enqueued_total,
    completed: final.result.lanes.review.completed_total,
    superseded: final.result.lanes.review.superseded_total,
  };
  log.completion_history_rows = final.history;
  return log;
}

const T1 = T0 + 20 * MINUTE;
const scenarios = {
  // Two completed reviews, then three pushes over eight minutes.
  churn: [
    push(T0, 500, 1),
    push(T0 + 10 * MINUTE, 500, 2),
    push(T1, 500, 3),
    push(T1 + 4 * MINUTE, 500, 4),
    push(T1 + 8 * MINUTE, 500, 5),
  ],
  // Two completed reviews, then an explicit command.
  command: [
    edit(T0, 501, 1),
    edit(T0 + 10 * MINUTE, 501, 2),
    {
      at: T1,
      delivery_id: "command-501",
      decision: decision(501, "issue", "legacy_dispatch", {
        commandStatusMarker:
          "<!-- clawsweeper-command-status:501:re_review:0123456789abcdef0123456789abcdef01234567 -->",
      }),
    },
  ],
  // A first-time item.
  fresh: [push(T1, 502, 1)],
};

const receipt = {
  base: git("rev-parse", baseRef),
  head: git("rev-parse", "HEAD"),
  working_tree_dirty: Boolean(git("status", "--porcelain")),
  node: process.version,
  workerd: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  runtime: "workerd / SQLite Durable Object / native loopback HTTP",
  clock_origin: new Date(T0).toISOString(),
  review_duration_min: REVIEW_MS / MINUTE,
  sources: {},
  results: {},
};
try {
  const bundles = {};
  for (const variant of ["baseline", "candidate"]) {
    bundles[variant] = await bundleVariant(variant);
    receipt.sources[variant] = bundles[variant].sources;
    const mf = miniflare(bundles[variant].script);
    try {
      await mf.ready;
      dispatches = [];
      const results = {};
      for (const [name, events] of Object.entries(scenarios)) {
        results[name] = await runTimeline(mf, `${variant}-${name}`, events, T1 + 40 * MINUTE);
      }
      receipt.results[variant] = results;
    } finally {
      await mf.dispose();
    }
  }

  // Additive migration: the candidate opens a store the baseline wrote.
  const persist = path.join(out, "upgrade-store");
  const before = miniflare(bundles.baseline.script, persist);
  let pre;
  try {
    await before.ready;
    dispatches = [];
    pre = await runTimeline(before, "upgrade", [edit(T0, 510, 1)], T0 + 30 * MINUTE);
    const pending = await runTimeline(before, "upgrade", [edit(T1, 510, 2)], T1);
    pre.pending_before_upgrade = pending.events;
  } finally {
    await before.dispose();
  }
  const after = miniflare(bundles.candidate.script, persist);
  try {
    await after.ready;
    const upgraded = await runTimeline(
      after,
      "upgrade",
      [edit(T1 + 30_000, 510, 3)],
      T1 + 30 * MINUTE,
    );
    receipt.results.upgrade = { baseline_written: pre, candidate_resumed: upgraded };
  } finally {
    await after.dispose();
  }

  const churnDispatches = (variant) =>
    receipt.results[variant].churn.dispatches.filter((entry) => entry.at_min >= 20);
  const base = churnDispatches("baseline");
  const cand = churnDispatches("candidate");
  // Baseline: every push dispatches after 90 s and revokes the previous review.
  assert.deepEqual(
    base.map((entry) => entry.at_min),
    [21.5, 25.5, 29.5],
  );
  // Candidate: one dispatch of the latest head at the 15-minute cap.
  assert.deepEqual(
    cand.map((entry) => [entry.at_min, entry.head]),
    [[35, "5".repeat(40)]],
  );
  for (const variant of ["baseline", "candidate"]) {
    const early = receipt.results[variant].churn.dispatches.filter((entry) => entry.at_min < 20);
    assert.deepEqual(
      early.map((entry) => entry.at_min),
      [1.5, 11.5],
    );
    const command = receipt.results[variant].command.dispatches.at(-1);
    assert.ok(command.at_min - 20 <= 1 / 60 + 1e-9, "command dispatches on the next wake");
    assert.deepEqual(
      receipt.results[variant].fresh.dispatches.map((entry) => entry.at_min),
      [21.5],
    );
  }
  const candidateWakes = receipt.results.candidate.churn.wakes.filter(
    (wake) => wake.at_min >= 20 && wake.at_min <= 35,
  );
  assert.ok(candidateWakes.length <= 3, "held item must not poll");
  const resumed = receipt.results.upgrade.candidate_resumed;
  assert.equal(resumed.events[0].status, 202);
  assert.equal(resumed.events[0].wait_ms, 90_000);
  assert.equal(resumed.dispatches.length, 1);
  assert.equal(unexpected.length, 0, `unexpected fixture routes: ${unexpected.join(", ")}`);

  receipt.summary = {
    churn_phase_dispatches: { baseline: base.length, candidate: cand.length },
    churn_phase_superseded_reviews: {
      baseline: receipt.results.baseline.churn.review_totals.superseded,
      candidate: receipt.results.candidate.churn.review_totals.superseded,
    },
    churn_phase_wakes_20_to_35_min: {
      baseline: receipt.results.baseline.churn.wakes.filter(
        (wake) => wake.at_min >= 20 && wake.at_min <= 35,
      ).length,
      candidate: candidateWakes.length,
    },
    command_dispatch_delay_s: Object.fromEntries(
      ["baseline", "candidate"].map((variant) => [
        variant,
        Math.round((receipt.results[variant].command.dispatches.at(-1).at_min - 20) * 60),
      ]),
    ),
    fresh_item_dispatch_delay_s: Object.fromEntries(
      ["baseline", "candidate"].map((variant) => [
        variant,
        Math.round((receipt.results[variant].fresh.dispatches[0].at_min - 20) * 60),
      ]),
    ),
    upgrade_first_candidate_wait_ms: resumed.events[0].wait_ms,
  };
  receipt.limits =
    "Synthetic loopback GitHub, RSA credential, clock and queue state; real enqueue, alarm, dispatch, claim, complete and SQLite storage in workerd. Reviews are modeled as a 7-minute claim-to-complete lease; no workflow, inference, production state or GitHub mutation.";
  writeFileSync(path.join(out, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt.summary, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
