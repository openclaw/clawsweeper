// Actual local Worker/DO/public API -> Astro/browser proof for a consumer that
// fetches exactly once each 15m+1 cycle. Synthetic clock/data, no live operations.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import worker, { ExactReviewQueue } from "../../../dashboard/worker.ts";
import {
  ExactReviewDirectPublicationStore,
  REVIEW_COVERAGE_SCAN_MAX_AGE_MS,
} from "../../../dashboard/exact-review-direct-publication.ts";
import { REVIEW_COVERAGE_READ_WAIT_MS } from "../../../dashboard/exact-review-queue.ts";
import { CANONICAL_BODY_PREFIX } from "../../../dashboard/canonical-bodies.ts";
import { TestStorage } from "../../../test/exact-review-test-storage.ts";
const root = resolve(import.meta.dirname, "../../.."),
  output = join(root, ".artifacts/ui-live-coverage/refresh-cadence");
mkdirSync(output, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const realDateNow = Date.now,
  interval = REVIEW_COVERAGE_SCAN_MAX_AGE_MS + 1,
  start = realDateNow() - 2 * interval;
let clock = start,
  revision = 7,
  fetches = 0,
  gets = 0,
  hook = null;
const storage = new TestStorage(),
  bodies = new Map(),
  secret = "synthetic-cadence-secret",
  calls = [],
  observations = [];
const bucket = {
  async get(key) {
    gets++;
    const pending = hook;
    hook = null;
    if (pending) await pending();
    const bytes = bodies.get(key);
    return bytes
      ? {
          size: bytes.length,
          body: new ReadableStream({
            start(c) {
              c.enqueue(bytes.slice());
              c.close();
            },
          }),
        }
      : null;
  },
  async put() {
    throw new Error("No body publication in cadence read proof");
  },
};
const queue = new ExactReviewQueue({ storage }, { STATE_SNAPSHOTS: bucket }),
  env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    STATE_SNAPSHOTS: bucket,
    EXACT_REVIEW_QUEUE: {
      idFromName: (n) => n,
      get: () => ({
        fetch: (request) => {
          calls.push({ method: request.method, path: new URL(request.url).pathname });
          return queue.fetch(request);
        },
      }),
    },
  };
const post = async (path, value) => {
  const body = JSON.stringify(value);
  return worker.fetch(
    new Request("https://local.invalid" + path, {
      method: "POST",
      body,
      headers: {
        "x-clawsweeper-exact-review-signature":
          "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      },
    }),
    env,
  );
};
const source = (status) => {
  const text = [
      "---",
      "repository: fixture/cadence",
      "type: issue",
      "review_status: " + status,
      "reviewed_at: " + new Date(start - 60000).toISOString(),
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "---",
      "Existing synthetic canonical state, not a model review.",
    ].join("\n"),
    digest = hash(text);
  bodies.set(CANONICAL_BODY_PREFIX + digest, Buffer.from(text));
  if (revision === 7)
    storage.sql.exec(
      "INSERT INTO exact_review_canonical_records_v2 (repo_slug,section,item_id,digest,byte_length,deleted,revision,item_key,claim_generation,updated_at,coverage_repo,coverage_status,coverage_reviewed_at,coverage_excluded) VALUES ('fixture-cadence','items',1,?,?,0,7,'fixture/cadence#1',1,?,'fixture/cadence','complete',?,0)",
      digest,
      Buffer.byteLength(text),
      clock,
      start - 60000,
    );
  else
    storage.sql.exec(
      "UPDATE exact_review_canonical_records_v2 SET digest=?,byte_length=?,revision=?,coverage_facts=NULL,updated_at=? WHERE item_id=1",
      digest,
      Buffer.byteLength(text),
      revision,
      clock,
    );
  return digest;
};
async function read(name) {
  fetches++;
  const response = await worker.fetch(
    new Request("https://local.invalid/api/review-coverage"),
    env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  writeFileSync(join(output, name + "-api.json"), JSON.stringify(result, null, 2));
  observations.push({
    name,
    clock: new Date(clock).toISOString(),
    fetches,
    recordScanAt: result.record_scan_observed_at,
    coverageStatus: result.coverage_status,
    totals: result.totals,
  });
  return result;
}
let browser, server;
const originalFetch = globalThis.fetch;
let outbound = 0;
globalThis.fetch = async () => {
  outbound++;
  throw new Error("No outbound/model calls in cadence proof");
};
try {
  Date.now = () => clock;
  const inv = {
    generated_at: new Date(start).toISOString(),
    repositories: [
      {
        repo: "fixture/cadence",
        repo_slug: "fixture-cadence",
        visibility: "public",
        observation_scope: "eligible",
        open_issues: 1,
        open_pull_requests: 0,
        counts_observed_at: new Date(start).toISOString(),
        complete: true,
        items: [
          {
            number: 1,
            kind: "issue",
            labels: [],
            reopened_at: null,
            updated_at: new Date(start - 60000).toISOString(),
          },
        ],
      },
    ],
  };
  assert.equal((await post("/internal/review-coverage/inventory", inv)).status, 202);
  new ExactReviewDirectPublicationStore(storage, bucket).ensureSchemaSync();
  source("complete");
  const warm = await read("warm");
  assert.equal(warm.totals.coverage_percent, 100);
  let success;
  for (const [index, status] of ["complete", "failed"].entries()) {
    clock += interval;
    revision++;
    source(status);
    const before = fetches;
    success = await read("cycle" + (index + 1));
    assert.equal(fetches, before + 1);
    assert.equal(success.coverage_status, "complete");
    assert.equal(success.totals.coverage_percent, status === "failed" ? 0 : 100);
    assert.equal(success.totals.failed, status === "failed" ? 1 : 0);
    assert.equal(Date.parse(success.record_scan_observed_at), clock);
    assert.notEqual(success.record_scan_observed_at, warm.record_scan_observed_at);
  }
  const successClock = clock;
  clock += interval;
  revision++;
  source("complete");
  storage.failNextSqlMatching(/SELECT MIN\(repo_slug\)/);
  const failed = await read("refresh-failed");
  assert.equal(failed.record_scan_observed_at, null);
  assert.equal(failed.totals.reviewed_recent, null);
  assert.equal(failed.totals.coverage_percent, null);
  assert.equal(failed.totals.open_records, 1);
  clock += interval;
  revision++;
  source("failed");
  let entered, release;
  const blocked = new Promise((r) => {
      release = r;
    }),
    started = new Promise((r) => {
      entered = r;
    });
  hook = async () => {
    entered();
    await blocked;
  };
  const timing = performance.now(),
    pending = read("refresh-timeout");
  await started;
  const timeout = await pending,
    elapsed = performance.now() - timing;
  assert.ok(
    elapsed >= REVIEW_COVERAGE_READ_WAIT_MS - 50 && elapsed < REVIEW_COVERAGE_READ_WAIT_MS + 2000,
  );
  assert.equal(timeout.record_scan_observed_at, null);
  assert.equal(timeout.totals.coverage_percent, null);
  assert.equal(timeout.totals.open_records, 1);
  const inFlight = queue.reviewCoverageScanInFlight;
  release();
  await inFlight;
  assert.equal(timeout.record_scan_observed_at, null);
  Date.now = realDateNow;
  assert.ok(
    realDateNow() - successClock < 15 * 60000,
    "Chosen past-clock fixture must remain usable by real Astro build clock",
  );
  const snapshot = JSON.parse(
    readFileSync(join(root, "dashboard-site/fixtures/dashboard.json"), "utf8"),
  );
  snapshot.generatedAt = new Date(successClock).toISOString();
  snapshot.corpus.generatedAt = snapshot.generatedAt;
  snapshot.coverage = success;
  snapshot.corpus.repos = [
    {
      repo: "fixture/cadence",
      slug: "fixture-cadence",
      records: 1,
      open: 1,
      staleOpen: 0,
      reviewed7d: 1,
      reviewed30d: 1,
      typed: 1,
      archived: 0,
      missingTyped: 0,
      decisions: {},
    },
  ];
  snapshot.corpus.totals = { ...snapshot.corpus.totals, records: 1, open: 1, repositories: 1 };
  snapshot.repositoryStates = {};
  const site = join(root, "dashboard-site"),
    data = join(site, "src/data/dashboard.json"),
    oldData = existsSync(data) ? readFileSync(data) : null,
    pkg = JSON.parse(readFileSync(join(site, "node_modules/astro/package.json"), "utf8")),
    bin = resolve(site, "node_modules/astro", pkg.bin.astro);
  mkdirSync(dirname(data), { recursive: true });
  try {
    writeFileSync(data, JSON.stringify(snapshot));
    const run = spawnSync(process.execPath, [bin, "build"], {
      cwd: site,
      encoding: "utf8",
      timeout: 120000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: "1",
        ASTRO_TELEMETRY_DISABLED: "1",
      },
    });
    writeFileSync(join(output, "build.log"), run.stdout + run.stderr);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    cpSync(join(site, "dist"), join(output, "site"), { recursive: true });
  } finally {
    if (oldData) writeFileSync(data, oldData);
  }
  server = createServer((req, res) => {
    let file = join(output, "site", new URL(req.url, "http://localhost").pathname);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      "content-type",
      {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".woff2": "font/woff2",
        ".png": "image/png",
      }[extname(file)] ?? "application/octet-stream",
    );
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port,
    cache = join(process.env.HOME, ".cache/ms-playwright"),
    executable =
      process.env.COVERAGE_PROOF_CHROMIUM ??
      readdirSync(cache)
        .filter((n) => n.startsWith("chromium-"))
        .sort()
        .reverse()
        .map((n) => join(cache, n, "chrome-linux64/chrome"))
        .find(existsSync);
  browser = await chromium.launch({ headless: true, executablePath: executable });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) && route.request().method() === "GET"
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin + "/coverage/", { waitUntil: "networkidle" });
  const row = page.locator('[data-coverage-repo="fixture/cadence"]');
  assert.equal(await row.locator("td").nth(4).innerText(), "0.0%");
  assert.equal(
    await page.locator('[role="status"]').filter({ hasText: "Coverage unknown" }).count(),
    0,
  );
  await page.screenshot({ path: join(output, "usable-after-refresh.png"), fullPage: true });
  writeFileSync(join(output, "visible.txt"), await page.locator("body").innerText());
  await context.tracing.stop({ path: join(output, "browser-trace.zip") });
  await context.close();
  assert.equal(outbound, 0);
  const files = [
    "dashboard/exact-review-queue.ts",
    "test/review-coverage-refresh.test.ts",
    "dashboard/exact-review-direct-publication.ts",
    "dashboard/public-live-coverage.ts",
    "dashboard-site/src/lib/live-coverage.ts",
    "dashboard-site/src/pages/coverage.astro",
  ];
  const receipt = {
    ok: true,
    qualification: "supporting host, synthetic controlled clock/state",
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceBinding: Object.fromEntries(
      files.map((file) => [file, hash(readFileSync(join(root, file)))]),
    ),
    procedureSourceSha256: hash(readFileSync(import.meta.filename)),
    intervalMs: interval,
    readWaitBudgetMs: REVIEW_COVERAGE_READ_WAIT_MS,
    actualTimeoutElapsedMs: elapsed,
    oneFetchPerCycle: true,
    changedCanonicalSourceObserved: true,
    noStaleDateRelabel: true,
    observations,
    calls,
    bodyGets: gets,
    forbiddenOutbound: outbound,
    renderedResult: {
      percent: success.totals.coverage_percent,
      failed: success.totals.failed,
      recordScanAt: success.record_scan_observed_at,
    },
    limits: [
      "Explicitly synthetic existing canonical state, not real fleet review results",
      "Real timers bound timeout; only Date.now is controlled and restored before Astro/browser",
      "No live GitHub/model calls or container qualification",
    ],
  };
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        cycles: observations.length,
        timeoutMs: elapsed,
        uiPercent: success.totals.coverage_percent,
        artifact: join(output, "receipt.json"),
      },
      null,
      2,
    ),
  );
} finally {
  Date.now = realDateNow;
  globalThis.fetch = originalFetch;
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
}
