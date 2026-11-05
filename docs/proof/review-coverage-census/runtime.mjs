// Supporting host execution is permitted; --browser requires the separately
// approved clean committed Crabbox environment. No production endpoints/tokens.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import worker, { ExactReviewQueue } from "../../../dashboard/worker.ts";
import { authorityFixture } from "../ui-live-coverage/coverage-authority-fixture.mjs";
import { censusFixture } from "../../../test/fixtures/review-coverage-census.ts";
import {
  censusHttpControl,
  runReviewCoverageCensus,
} from "../../../dist/repair/review-coverage-census.js";
import {
  publicDashboardInputs,
  readCoverageForBuild,
} from "../../../dashboard-site/scripts/coverage.ts";
import { liveCoverage } from "../../../dashboard-site/src/lib/live-coverage.ts";

const root = process.cwd(),
  out = resolve(
    process.env.CENSUS_PROOF_OUTPUT ?? ".openclaw/tmp/census-completeness-design/runtime",
  );
mkdirSync(out, { recursive: true });
const git = (...args) => {
  const p = spawnSync("git", args, { encoding: "utf8" });
  if (p.status !== 0) throw new Error(p.stderr);
  return p.stdout.trim();
};
const proofSourceFiles = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "package.json",
  "pnpm-lock.yaml",
  "src/review-coverage.ts",
  "src/review-coverage-census.ts",
  "src/repair/review-coverage-census.ts",
  "src/repair/target-fanout.ts",
  "dashboard/review-coverage-census.ts",
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-direct-publication.ts",
  "dashboard/worker.ts",
  "dashboard/public-live-coverage.ts",
  "dashboard-site/src/lib/live-coverage.ts",
  "dashboard-site/src/pages/coverage.astro",
  "test/fixtures/review-coverage-census.ts",
  "docs/proof/review-coverage-census/runtime.mjs",
  "docs/live-dashboard.md",
];
const proofHashes = () =>
  Object.fromEntries(
    proofSourceFiles.map((file) => [
      file,
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );
const proofSourceBefore = proofHashes();
const browser = process.argv.includes("--browser");
if (browser) {
  assert.equal(
    process.env.CENSUS_CONTAINED_PROOF,
    "1",
    "browser proof is a separately authorized phase",
  );
  assert.equal(process.env.CRABBOX_PROVIDER, "local-container");
  assert.ok(process.env.CRABBOX_LEASE);
  assert.equal(
    process.env.CRABBOX_IMAGE,
    "sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a",
  );
  assert.equal(
    git("status", "--porcelain"),
    "",
    "final browser proof requires clean committed source",
  );
  assert.equal(git("rev-parse", "HEAD"), process.env.CENSUS_PROOF_HEAD);
}
const originalFetch = globalThis.fetch;
let forbidden = 0;
globalThis.fetch = async () => {
  forbidden++;
  throw new Error("live authority/network forbidden by census runtime fixture");
};
const f = await authorityFixture(),
  fixture = censusFixture([
    { name: "core", issues: 4865, pulls: 2881 },
    { name: "enterprise", issues: 107, pulls: 153 },
    ...Array.from({ length: 143 }, (_, i) => ({ name: "small" + i, issues: 1, pulls: 0 })),
  ]);
const boundedChurn = process.argv.includes("--bounded-churn"),
  twoIncomplete = process.argv.includes("--two-incomplete"),
  sustainedChurn = twoIncomplete || process.argv.includes("--sustained-churn");
let currentQuery = "";
let coreQueries = 0,
  changes = 0;
const closed = [];
fixture.setMutation((name) => {
  if (
    twoIncomplete &&
    name === "enterprise" &&
    currentQuery.includes('name:"enterprise") { id nameWithOwner issues(')
  ) {
    const r = fixture.members.get(name);
    const index = r.issues.indexOf(60000);
    if (index < 0) r.issues.push(60000);
    else r.issues.splice(index, 1);
  }
  if (name !== "core") return;
  coreQueries++;
  const r = fixture.members.get(name);
  if (sustainedChurn) {
    r.overrides.set(1, {
      updated: r.updated,
      labels: ["changing-" + coreQueries],
      head: r.head,
      reopened: r.reopened,
    });
    return;
  }
  if (!boundedChurn) return;
  if (coreQueries === 5) {
    r.issues.push(50000);
    changes++;
  }
  if (coreQueries === 17) {
    closed.push(...r.issues.splice(1, 2));
    changes++;
  }
  if (coreQueries === 31) {
    r.issues.shift();
    r.issues.push(50001);
    changes++;
  }
  if (coreQueries === 51) {
    r.issues.push(...closed);
    r.issues.sort((a, b) => a - b);
    const at = new Date(Date.now() - 1000).toISOString();
    r.overrides.set(100001, {
      updated: at,
      labels: ["changed-head"],
      head: "b".repeat(40),
      reopened: null,
    });
    r.overrides.set(closed[0], {
      updated: at,
      labels: ["reopened-change"],
      head: r.head,
      reopened: at,
    });
    changes++;
  }
});
let queue = f.queue,
  dropped = false,
  restarted = false;
const env = { ...f.env, EXACT_REVIEW_QUEUE: { idFromName: (v) => v, get: () => queue } };
const canonical = JSON.stringify(f.canonicalState()),
  receipts = [],
  runs = [];
const storageStats = [];
const rawPagination = [];
const maxima = {
  rows: 0,
  bytes: 0,
  stagingRows: 0,
  completeRows: 0,
  cursors: 0,
  receipts: 0,
  metadataRows: 0,
  metadataBytes: 0,
  generationsPerRepo: 0,
  requestBytes: 0,
  responseBytes: 0,
  queryBytes: 0,
};
const observeStorage = () => {
  const slots = Array.from(
    f.storage.sql.exec(
      "SELECT slot,COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM coverage_census_items GROUP BY slot",
    ),
  );
  const scalar = (sql) => Number(Array.from(f.storage.sql.exec(sql))[0]?.n ?? 0);
  const value = {
    rows: slots.reduce((n, r) => n + Number(r.n), 0),
    bytes: slots.reduce((n, r) => n + Number(r.bytes), 0),
    stagingRows: Number(slots.find((r) => r.slot === "staging")?.n ?? 0),
    completeRows: Number(slots.find((r) => r.slot === "complete")?.n ?? 0),
    cursors: scalar("SELECT COUNT(*) AS n FROM coverage_census_cursors"),
    receipts: scalar("SELECT COUNT(*) AS n FROM coverage_census_receipts"),
    metadataRows: scalar("SELECT COUNT(*) AS n FROM coverage_census_repositories"),
    metadataBytes: scalar(
      "SELECT COALESCE(SUM(length(CAST(state AS BLOB))),0) AS n FROM coverage_census_repositories",
    ),
    generationsPerRepo: scalar(
      "SELECT COALESCE(MAX(n),0) AS n FROM (SELECT COUNT(DISTINCT generation) AS n FROM coverage_census_items GROUP BY repo)",
    ),
  };
  assert.ok(
    value.rows <= 40000 &&
      value.stagingRows <= 20000 &&
      value.completeRows <= 20000 &&
      value.bytes <= 64 * 1024 * 1024 &&
      value.cursors <= 1024 &&
      value.receipts <= 1024 &&
      value.metadataRows <= 512 &&
      value.metadataBytes <= 8 * 1024 * 1024 &&
      value.generationsPerRepo <= 2,
  );
  for (const [key, number] of Object.entries(value)) maxima[key] = Math.max(maxima[key], number);
  storageStats.push(value);
};
const actualFetch = async (url, init) => {
  const request = new Request(url, init),
    response = await worker.fetch(request, env, {});
  const path = new URL(request.url).pathname;
  if (path.endsWith("/accept")) {
    for (const page of JSON.parse(String(init?.body)).pages) {
      rawPagination.push({
        repo: page.repo,
        kind: page.kind,
        pass: page.pass,
        input: page.cursor,
        internalNext: page.next,
        sourcePageInfo: page.sourcePageInfo,
      });
      if (!page.hasNext) {
        assert.equal(page.next, null);
        if (page.items.length) assert.ok(page.sourcePageInfo.endCursor);
      }
    }
  }
  if (path.includes("/census/")) {
    const text = await response.clone().text(),
      json = JSON.parse(text);
    maxima.requestBytes = Math.max(
      maxima.requestBytes,
      new TextEncoder().encode(String(init?.body ?? "")).byteLength,
    );
    maxima.responseBytes = Math.max(
      maxima.responseBytes,
      new TextEncoder().encode(text).byteLength,
    );
    assert.ok(maxima.requestBytes <= 1900000 && maxima.responseBytes <= 1900000);
    observeStorage();
    receipts.push({ path, status: response.status, ...json });
  }
  if (path.endsWith("/accept") && response.ok && !dropped) {
    dropped = true;
    throw new Error("simulated lost response AFTER actual durable acceptance");
  }
  return response;
};
const control = censusHttpControl({
  baseUrl: "https://local.invalid",
  secret: f.secret,
  fetchImpl: actualFetch,
});
let revokeCore = false;
const metadata = async (url) => {
  const parsed = new URL(String(url), "https://synthetic.invalid/");
  if (parsed.pathname.startsWith("/users/")) {
    const owner = parsed.pathname.split("/")[2],
      page = Number(parsed.searchParams.get("page") ?? 1);
    return Response.json(
      fixture
        .population()
        .filter((r) => r.repo.startsWith(owner + "/"))
        .slice((page - 1) * 100, page * 100)
        .map((r) => ({
          full_name: r.repo,
          visibility: revokeCore && r.repo === "fixture/core" ? "private" : "public",
          private: revokeCore && r.repo === "fixture/core",
          archived: false,
          fork: false,
        })),
    );
  }
  const repo = parsed.pathname.replace(/^\/repos\//, "").toLowerCase();
  if (!fixture.population().some((r) => r.repo === repo))
    return new Response(null, { status: 404 });
  return Response.json({
    full_name: repo,
    visibility: revokeCore && repo === "fixture/core" ? "private" : "public",
    private: revokeCore && repo === "fixture/core",
    archived: false,
    fork: false,
  });
};
try {
  for (let run = 0; run < 30; run++) {
    const result = await runReviewCoverageCensus({
      repositories: fixture.population().map((r) => ({ ...r, countsAt: new Date().toISOString() })),
      control,
      query: (text) => {
        currentQuery = text;
        const value = fixture.query(text);
        maxima.queryBytes = Math.max(
          maxima.queryBytes,
          new TextEncoder().encode(JSON.stringify(value)).byteLength,
        );
        assert.ok(maxima.queryBytes <= 1900000);
        return value;
      },
      attempt: "actual-production-sized-proof",
    });
    assert.ok(result.queries <= 25);
    const connectionPages = new Map();
    for (const work of result.trace) {
      const key = work.repo + ":" + work.kind;
      connectionPages.set(key, (connectionPages.get(key) ?? 0) + 1);
    }
    assert.ok([...connectionPages.values()].every((count) => count <= 10));
    assert.equal(result.failed, 0);
    runs.push(result);
    if (run === 1) {
      queue = new ExactReviewQueue(
        { storage: f.storage },
        { STATE_SNAPSHOTS: f.queue.env?.STATE_SNAPSHOTS },
      );
      restarted = true;
    }
    const states = Array.from(
      f.storage.sql.exec("SELECT state FROM coverage_census_repositories"),
    ).map((r) => JSON.parse(String(r.state)));
    if (!sustainedChurn && states.length === 145 && states.every((s) => s.complete && !s.active))
      break;
    if (sustainedChurn)
      assert.equal(states.find((s) => s.repository.repo === "fixture/core").complete, null);
  }
  const states = Array.from(
    f.storage.sql.exec("SELECT state FROM coverage_census_repositories"),
  ).map((r) => JSON.parse(String(r.state)));
  const expectedComplete = twoIncomplete ? 143 : sustainedChurn ? 144 : 145;
  assert.equal(states.filter((s) => s.complete && !s.active).length, expectedComplete);
  if (boundedChurn) assert.equal(changes, 4);
  assert.ok(dropped && restarted);
  assert.equal(JSON.stringify(f.canonicalState()), canonical);
  const raw = await queue.fetch(new Request("https://internal.invalid/review-coverage"));
  writeFileSync(join(out, "raw-private-source.json"), await raw.text());
  const candidates = await readCoverageForBuild(f.secret, actualFetch, "https://local.invalid");
  assert.ok(candidates);
  const selected = await publicDashboardInputs(f.cache, candidates, metadata);
  const live = liveCoverage(selected.coverage);
  writeFileSync(join(out, "live-model.json"), JSON.stringify(live, null, 2));
  writeFileSync(join(out, "public-build.json"), JSON.stringify(selected, null, 2));
  assert.equal(live.rows.filter((r) => r.censusComplete).length, expectedComplete);
  assert.equal(live.known, !sustainedChurn);
  const anonymous = await worker.fetch(
      new Request("https://local.invalid/api/review-coverage"),
      env,
      {},
    ),
    anonymousText = await anonymous.text();
  assert.equal(anonymous.status, 200);
  assert.ok(!anonymousText.includes("fixture/"));
  assert.equal(anonymous.headers.get("access-control-allow-origin"), "*");
  // Revoke one row independently of both staging and complete source bytes.
  revokeCore = true;
  const revoked = await publicDashboardInputs(f.cache, candidates, metadata);
  revokeCore = false;
  assert.ok(!JSON.stringify(revoked).includes("fixture/core"));
  writeFileSync(join(out, "raw-pagination.json"), JSON.stringify(rawPagination, null, 2));
  writeFileSync(join(out, "private-api.json"), JSON.stringify(candidates, null, 2));
  writeFileSync(join(out, "public-build.json"), JSON.stringify(selected, null, 2));
  writeFileSync(join(out, "anonymous-api.json"), anonymousText);
  writeFileSync(join(out, "progress-receipts.json"), JSON.stringify({ runs, receipts }, null, 2));
  writeFileSync(
    join(out, "storage-bounds.json"),
    JSON.stringify({ maxima, samples: storageStats }, null, 2),
  );
  const files = [
    "src/review-coverage-census.ts",
    "src/repair/review-coverage-census.ts",
    "src/repair/target-fanout.ts",
    "dashboard/review-coverage-census.ts",
    "dashboard/exact-review-queue.ts",
    "dashboard/worker.ts",
    "dashboard/public-live-coverage.ts",
    "dashboard-site/src/pages/coverage.astro",
  ];
  const provenance = {
    head: git("rev-parse", "HEAD"),
    base: "03e24309cf919bf866bb2ffe2551beca27fd9bb3",
    provider: process.env.CRABBOX_PROVIDER ?? "host-supporting-only",
    image: process.env.CRABBOX_IMAGE ?? null,
    lease: process.env.CRABBOX_LEASE ?? null,
    runs: runs.length,
    maxima,
    queries: runs.reduce((n, r) => n + r.queries, 0),
    complete: expectedComplete,
    boundedChurn,
    sustainedChurn,
    twoIncomplete,
    changes,
    coreQueries,
    total: 145,
    identities: fixture.population().reduce((n, r) => n + r.issues + r.pulls, 0),
    lostResponseRecovered: dropped,
    durableObjectRestarted: restarted,
    forbiddenNetworkCalls: forbidden,
    canonicalUnchanged: true,
    observational: true,
    sourceHashes: Object.fromEntries(
      files.map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]),
    ),
    limits:
      "Controlled GitHub metadata/pages and SQLite/R2 adapters, not live GitHub snapshots/deployed Cloudflare authority. Static fleet runtime is not the sustained-churn liveness claim; execute churn regressions too. Dependency egress is not zero total network.",
  };
  if (browser) {
    const site = join(root, "dashboard-site"),
      data = join(site, "src/data/dashboard.json"),
      prior = existsSync(data) ? readFileSync(data) : null;
    let server, chromium;
    try {
      const snapshot = {
        ...JSON.parse(readFileSync(join(site, "fixtures/dashboard.json"))),
        ...selected,
        generatedAt: new Date().toISOString(),
      };
      mkdirSync(join(site, "src/data"), { recursive: true });
      writeFileSync(data, JSON.stringify(snapshot));
      const built = spawnSync("pnpm", ["run", "build"], {
        cwd: site,
        encoding: "utf8",
        env: process.env,
      });
      writeFileSync(join(out, "astro-build.log"), (built.stdout ?? "") + (built.stderr ?? ""));
      assert.equal(built.status, 0);
      server = createServer((request, response) => {
        let file = join(
          site,
          "dist",
          decodeURIComponent(new URL(request.url, "http://localhost").pathname),
        );
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
        if (!existsSync(file)) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.setHeader(
          "content-type",
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          }[extname(file)] ?? "application/octet-stream",
        );
        response.end(readFileSync(file));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { chromium: engine } = await import("playwright-core");
      chromium = await engine.launch({
        executablePath: process.env.CHROMIUM_EXECUTABLE ?? "/usr/bin/chromium",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await chromium.newPage({ viewport: { width: 1440, height: 1100 } });
      const external = [];
      await page.route("**/*", (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1"
          ? route.continue()
          : (external.push(route.request().url()), route.abort()),
      );
      await page.goto("http://127.0.0.1:" + server.address().port + "/coverage/", {
        waitUntil: "networkidle",
      });
      const text = await page.locator("body").innerText();
      assert.ok(text.includes(expectedComplete + "/145 participating public repositories"));
      assert.match(text, /not a live point-in-time snapshot/);
      assert.match(text, /sustained churn may remain Unknown/);
      if (sustainedChurn) assert.match(text, /Coverage unknown:/);
      assert.equal(external.length, 0);
      writeFileSync(join(out, "coverage.html"), await page.content());
      await page.screenshot({ path: join(out, "coverage.png"), fullPage: true });
      provenance.browser = true;
    } finally {
      if (chromium) await chromium.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      if (prior) writeFileSync(data, prior);
      else rmSync(data, { force: true });
    }
  }
  assert.deepEqual(proofHashes(), proofSourceBefore, "source changed while proof was running");
  provenance.sourceHashes = proofSourceBefore;
  writeFileSync(join(out, "provenance.json"), JSON.stringify(provenance, null, 2));
  console.log(JSON.stringify(provenance, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  fixture.db.close();
}
