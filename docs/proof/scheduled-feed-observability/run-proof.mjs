// Real-runtime proof that /api/exact-review-queue exposes the scheduled review budget.
// Usage: node docs/proof/scheduled-feed-observability/run-proof.mjs BASE_REF TOOL_PREFIX FRESH_OUTPUT_DIR
// TOOL_PREFIX must contain miniflare and esbuild (for example a wrangler@4 install).
// FRESH_OUTPUT_DIR must not exist; the harness never removes caller data.
//
// For BASE_REF (baseline) and the checked-out branch (candidate), this bundles the
// real dashboard Worker plus the real ExactReviewQueue SQLite Durable Object, runs
// them in workerd with a fake clock and a loopback GitHub fixture, then:
//   1. reads the public route at rest;
//   2. admits and claims ORGANIC_REVIEWS organic reviews in the same minute, so the
//      claim-time charges drive the global scheduled balance into organic debt;
//   3. offers one scheduled normal-backfill item, which the budget sheds;
//   4. reads the public /api/exact-review-queue route again.
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
const ORGANIC_REVIEWS = 40;
const FILES = [
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-read-model.ts",
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
let dispatches = [];
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
    "With the same queue accounting on both builds, the candidate's public /api/exact-review-queue additionally reports the scheduled admission budget (signed global and per-lane token balances, burst, lane rates) and review shed counts by reason, so a scheduled backfill shed caused by organic debt is visible publicly; the baseline route omits them.",
  base: git("rev-parse", baseRef),
  head: git("rev-parse", "HEAD"),
  working_tree_dirty: Boolean(git("status", "--porcelain", "--", ...FILES)),
  node: process.version,
  workerd: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  runtime:
    "workerd / real dashboard Worker + ExactReviewQueue SQLite Durable Object / loopback GitHub fixture / fake clock",
  scenario: `${ORGANIC_REVIEWS} organic issue reviews admitted and claimed within one minute, then one scheduled_normal_backfill offer for a new item, then GET /api/exact-review-queue`,
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
    const mf = new Miniflare({
      name: "scheduled-feed-observability-proof",
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
    try {
      await mf.ready;
      dispatches = [];
      receipt.variants[variant] = {
        source_sha256: Object.fromEntries(
          FILES.map((file) => [file, createHash("sha256").update(read(file)).digest("hex")]),
        ),
        config: {
          EXACT_REVIEW_TARGET_RATE_PER_HOUR: vars.EXACT_REVIEW_TARGET_RATE_PER_HOUR ?? null,
          EXACT_REVIEW_TARGET_BURST: vars.EXACT_REVIEW_TARGET_BURST ?? null,
          EXACT_REVIEW_HOT_INTAKE_RATE_PER_HOUR: vars.EXACT_REVIEW_HOT_INTAKE_RATE_PER_HOUR ?? null,
        },
        ...(await scenario(mf)),
      };
    } finally {
      await mf.dispose();
    }
  }
  assert.deepEqual(unexpected, [], "unexpected external fixture route");
  receipt.limits =
    "Synthetic GitHub fixture and RSA credential; issue items only; reviews are modeled as claims (the budget charges at claim); no live inference, production state, or GitHub mutation. Throttle timestamps are covered by unit tests, not this run.";
  // Write the observations before asserting so a failing run still leaves evidence.
  writeFileSync(path.join(out, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
  receipt.assertions = verify(receipt.variants);
  writeFileSync(path.join(out, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt.assertions, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function scenario(mf) {
  let now = T0;
  let runId = 7_000_000;
  const call = async (pathname, body) => {
    const response = await mf.dispatchFetch(`http://proof${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-proof-now": String(now), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const publicView = async () => {
    const { status, body } = await call("/api/exact-review-queue");
    assert.equal(status, 200, JSON.stringify(body));
    return {
      scheduled_feed: body.scheduled_feed ?? null,
      review_shed_since_reset: body.lanes?.review?.shed_since_reset ?? null,
      review_shed_reasons_since_reset: body.lanes?.review?.shed_reasons_since_reset ?? null,
    };
  };

  const atRest = await publicView();
  for (let index = 0; index < ORGANIC_REVIEWS; index += 1) {
    const number = 300_000 + index;
    const { status, body } = await call("/q/enqueue", {
      delivery_id: `organic-opened-${number}`,
      decision: {
        targetRepo: REPO,
        targetBranch: "main",
        itemNumber: number,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: "opened",
        supersedesInProgress: false,
      },
    });
    assert.equal(status, 202, JSON.stringify(body));
  }
  now += 2 * MINUTE;
  // The queue paces dispatch over time, so alternate short clock steps, alarm ticks
  // and claims. Each 15-second step refills under one token while several organic
  // claims are charged, so the global balance falls into organic debt.
  let claimed = 0;
  let seen = 0;
  for (let round = 0; round < 60 && seen < ORGANIC_REVIEWS; round += 1) {
    if (round > 0) now += 15_000;
    await call("/q/__tick", {});
    const fresh = dispatches.slice(seen);
    seen = dispatches.length;
    for (const payload of fresh) {
      const claim = await call("/q/claim", {
        item_key: payload.queue_claim.item_key,
        lease_id: payload.queue_lease_id,
        lease_revision: payload.queue_claim.lease_revision,
        run_id: String(runId++),
        run_attempt: 1,
      });
      if (claim.status === 200) claimed += 1;
    }
  }
  const offer = await call("/q/enqueue", {
    delivery_id: "scheduled-normal-offer",
    decision: {
      targetRepo: REPO,
      targetBranch: "main",
      itemNumber: 399_999,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "scheduled_normal_backfill",
      supersedesInProgress: false,
      sourceUpdatedAt: new Date(now).toISOString(),
    },
  });
  return {
    organic_dispatched: dispatches.length,
    organic_claimed: claimed,
    scheduled_offer: {
      status: offer.status,
      shed: offer.body?.shed === true,
      reason: offer.body?.reason ?? null,
    },
    public_at_rest: atRest,
    public_after_debt: await publicView(),
  };
}

function verify(variants) {
  const base = variants.baseline;
  const head = variants.candidate;
  const checks = {};
  checks.same_accounting =
    base.organic_claimed === head.organic_claimed &&
    base.scheduled_offer.shed === head.scheduled_offer.shed &&
    base.scheduled_offer.reason === head.scheduled_offer.reason;
  checks.scheduled_offer_shed_by_rate =
    head.scheduled_offer.shed === true && head.scheduled_offer.reason === "scheduled_rate";
  checks.baseline_omits_budget =
    base.public_after_debt.scheduled_feed?.token_balance === undefined &&
    base.public_after_debt.scheduled_feed?.lanes === undefined &&
    base.public_after_debt.review_shed_reasons_since_reset === null;
  const feed = head.public_after_debt.scheduled_feed ?? {};
  const burst = Number(feed.burst);
  checks.candidate_at_rest_full_burst =
    head.public_at_rest.scheduled_feed?.token_balance === head.public_at_rest.scheduled_feed?.burst;
  checks.candidate_reports_organic_debt =
    Number.isSafeInteger(feed.token_balance) &&
    feed.token_balance < 1 &&
    feed.token_balance >= -burst;
  checks.candidate_reports_lanes =
    Number.isSafeInteger(feed.lanes?.hot_intake?.token_balance) &&
    Number.isSafeInteger(feed.lanes?.normal_backfill?.token_balance);
  checks.candidate_attributes_shed =
    Number(head.public_after_debt.review_shed_reasons_since_reset?.scheduled_rate) >= 1;
  for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `assertion failed: ${name}`);
  return checks;
}
