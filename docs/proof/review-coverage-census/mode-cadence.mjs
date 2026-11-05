// Actual CLI modes with explicit virtual opportunity spacing. This is a
// controlled cadence simulation, never a current/live GitHub observation.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { coverageCliFixture } from "../../../test/fixtures/review-coverage-cli.ts";
import { publicDashboardInputs } from "../../../dashboard-site/scripts/coverage.ts";
import { liveCoverage } from "../../../dashboard-site/src/lib/live-coverage.ts";
const output = resolve(
  process.env.CENSUS_CADENCE_OUTPUT ??
    ".openclaw/tmp/census-completeness-design/review-r1/runtime-mode-cadence",
);
mkdirSync(output, { recursive: true });
const sourceFiles = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "package.json",
  "pnpm-lock.yaml",
  "src/review-coverage-census.ts",
  "src/repair/target-fanout.ts",
  "src/repair/review-coverage-census.ts",
  "dashboard/review-coverage-census.ts",
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-direct-publication.ts",
  "dashboard/worker.ts",
  "dashboard/public-live-coverage.ts",
  "dashboard-site/src/lib/live-coverage.ts",
  "dashboard-site/src/pages/coverage.astro",
  "test/fixtures/review-coverage-census.ts",
  "test/fixtures/review-coverage-cli.ts",
  "test/fixtures/fleet-coverage-query.ts",
  "docs/proof/review-coverage-census/mode-cadence.mjs",
  "dist/repair/target-fanout.js",
  "dist/repair/review-coverage-census.js",
  "dist/review-coverage-census.js",
];
const hashes = () =>
  Object.fromEntries(
    sourceFiles.map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  );
const sourceBefore = hashes(),
  head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
  realStarted = Date.now(),
  epoch = realStarted - 18 * 60 * 60_000;
const browserRequested = process.argv.includes("--browser");
if (browserRequested) {
  assert.equal(process.env.CENSUS_CONTAINED_PROOF, "1");
  assert.equal(process.env.CRABBOX_PROVIDER, "local-container");
  assert.ok(process.env.CRABBOX_LEASE);
  assert.equal(
    process.env.CRABBOX_IMAGE,
    "sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a",
  );
  assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "");
  assert.equal(head, process.env.CENSUS_PROOF_HEAD);
}
const bounded = process.argv.includes("--bounded-churn"),
  sustained = process.argv.includes("--two-incomplete");
const f = await coverageCliFixture(
  [
    { name: "core", issues: 4865, pulls: 2881 },
    { name: "enterprise", issues: 107, pulls: 153 },
    ...Array.from({ length: 143 }, (_, i) => ({ name: "small" + i, issues: 1, pulls: 0 })),
  ],
  epoch,
);
const canonicalBefore = JSON.stringify(f.authority.canonicalState()),
  admissionBefore = JSON.stringify(f.authority.storage.kv.get("exact-review-queue")),
  frames = [],
  rawPages = [];
let coreReads = 0,
  changes = 0,
  firstComplete = null;
const closed = [],
  generationIds = new Set();
const maxima = { rows: 0, bytes: 0, cursors: 0, receipts: 0, generationsPerRepo: 0 };
f.model.setMutation((name) => {
  if (
    sustained &&
    name === "enterprise" &&
    f.lastQuery.includes('name:"enterprise") { id nameWithOwner issues(')
  ) {
    const r = f.model.members.get(name),
      index = r.issues.indexOf(60000);
    if (index < 0) r.issues.push(60000);
    else r.issues.splice(index, 1);
  }
  if (name !== "core") return;
  coreReads++;
  const r = f.model.members.get(name);
  if (sustained) {
    r.overrides.set(1, {
      updated: r.updated,
      labels: ["changing-" + coreReads],
      head: r.head,
      reopened: null,
    });
    return;
  }
  if (!bounded) return;
  if (coreReads === 5) {
    r.issues.push(50000);
    changes++;
  }
  if (coreReads === 17) {
    closed.push(...r.issues.splice(1, 2));
    changes++;
  }
  if (coreReads === 31) {
    r.issues.shift();
    r.issues.push(50001);
    changes++;
  }
  if (coreReads === 51) {
    r.issues.push(...closed);
    r.issues.sort((a, b) => a - b);
    const at = new Date(f.time).toISOString();
    r.overrides.set(100001, {
      updated: at,
      labels: ["head-changed"],
      head: "b".repeat(40),
      reopened: null,
    });
    r.overrides.set(closed[0], { updated: at, labels: ["reopened"], head: r.head, reopened: at });
    changes++;
  }
});
f.observe((event) => {
  if (event.path.endsWith("/accept"))
    for (const page of event.body.pages) {
      rawPages.push({
        repo: page.repo,
        pass: page.pass,
        kind: page.kind,
        input: page.cursor,
        internalNext: page.next,
        sourcePageInfo: page.sourcePageInfo,
      });
      if (!page.hasNext) {
        assert.equal(page.next, null);
        if (page.items.length) assert.ok(page.sourcePageInfo.endCursor);
      }
    }
  const scalar = (sql) => Number(Array.from(f.authority.storage.sql.exec(sql))[0]?.n ?? 0);
  const rows = scalar("SELECT COUNT(*) AS n FROM coverage_census_items"),
    bytes = scalar("SELECT COALESCE(SUM(bytes),0) AS n FROM coverage_census_items"),
    cursors = scalar("SELECT COUNT(*) AS n FROM coverage_census_cursors"),
    receipts = scalar("SELECT COUNT(*) AS n FROM coverage_census_receipts"),
    generations = scalar(
      "SELECT COALESCE(MAX(n),0) AS n FROM (SELECT COUNT(DISTINCT generation) AS n FROM coverage_census_items GROUP BY repo)",
    );
  assert.ok(
    rows <= 40000 &&
      bytes <= 64 * 1024 * 1024 &&
      cursors <= 1024 &&
      receipts <= 1024 &&
      generations <= 2,
  );
  for (const [k, v] of Object.entries({
    rows,
    bytes,
    cursors,
    receipts,
    generationsPerRepo: generations,
  }))
    maxima[k] = Math.max(maxima[k], v);
});
let result, selectedForBrowser;
try {
  for (let tick = 0; tick < 36; tick++) {
    const mode = tick % 18 === 0 ? "coverage" : ["normal-review", "hot-intake", "audit"][tick % 3];
    const run = await f.run(mode);
    assert.ok(run.inventory <= 25);
    assert.equal(run.legacy, 0);
    assert.equal(run.calls.filter((c) => c.path.endsWith("/census/start")).length, 1);
    const inv = f.inventory(),
      core = f.states().find((s) => s.repo === "openclaw/core").state;
    if (core.active && !core.complete) generationIds.add(core.active.id);
    frames.push({
      tick,
      mode,
      observedAt: new Date(f.time).toISOString(),
      inventoryQueries: run.inventory,
      countQueries: run.counts,
      complete: inv.repositories.filter((r) => r.complete).length,
      total: inv.repositories.length,
      core: {
        generation: core.active?.id ?? core.complete?.generation,
        pass: core.active?.pass ?? null,
        revision: core.active?.revision ?? null,
        issueCursor: core.active?.connections.issue.cursor ?? null,
        prCursor: core.active?.connections.pull_request.cursor ?? null,
        window: inv.repositories.find((r) => r.repo === "openclaw/core").collection_window ?? null,
      },
    });
    if (sustained) assert.equal(core.complete, null);
    if (!sustained && inv.repositories.every((r) => r.complete)) {
      firstComplete = { invocations: tick + 1, elapsedMs: f.time - epoch };
      break;
    }
    f.advance(20 * 60_000);
  }
  assert.equal(generationIds.size, 1);
  if (!sustained) assert.ok(firstComplete);
  if (bounded) assert.equal(changes, 4);
  if (!sustained) {
    const original = f
      .inventory()
      .repositories.find((r) => r.repo === "openclaw/core").collection_window;
    for (let i = 0; i < 3; i++) {
      f.advance(20 * 60_000);
      const run = await f.run(i % 2 ? "normal-review" : "hot-intake");
      assert.ok(run.inventory <= 25);
      const core = f.inventory().repositories.find((r) => r.repo === "openclaw/core");
      assert.equal(core.complete, true);
      assert.deepEqual(core.collection_window, original);
      frames.push({
        refreshCheck: i,
        mode: i % 2 ? "normal-review" : "hot-intake",
        observedAt: new Date(f.time).toISOString(),
        inventoryQueries: run.inventory,
        complete: f.inventory().repositories.filter((r) => r.complete).length,
        total: 145,
        unchangedWindow: core.collection_window,
      });
    }
  }
  const candidates = await f.read();
  const metadata = async (path) => {
    const url = new URL(String(path), "https://synthetic.invalid"),
      owner = url.pathname.split("/")[2],
      page = Number(url.searchParams.get("page") ?? 1);
    const names = f.model.population().map((r) => r.repo);
    const row = (name) => ({
      full_name: name,
      visibility: "public",
      private: false,
      archived: false,
      fork: false,
    });
    if (url.pathname.startsWith("/users/"))
      return Response.json(
        names
          .filter((name) => name.startsWith(owner + "/"))
          .slice((page - 1) * 100, page * 100)
          .map(row),
      );
    const name = url.pathname.replace(/^\/repos\//, "");
    return names.includes(name) ? Response.json(row(name)) : new Response(null, { status: 404 });
  };
  const selected = await publicDashboardInputs(f.authority.cache, candidates, metadata),
    live = liveCoverage(selected.coverage, f.time),
    expected = sustained ? 143 : 145;
  selectedForBrowser = selected;
  assert.equal(live.rows.filter((r) => r.known).length, expected);
  assert.equal(live.known, !sustained);
  assert.equal(JSON.stringify(f.authority.canonicalState()), canonicalBefore);
  assert.equal(JSON.stringify(f.authority.storage.kv.get("exact-review-queue")), admissionBefore);
  writeFileSync(join(output, "private-api.json"), JSON.stringify(candidates, null, 2));
  writeFileSync(join(output, "public-build.json"), JSON.stringify(selected, null, 2));
  writeFileSync(join(output, "live-model.json"), JSON.stringify(live, null, 2));
  writeFileSync(join(output, "frames.json"), JSON.stringify(frames, null, 2));
  writeFileSync(join(output, "raw-pagination.json"), JSON.stringify(rawPages, null, 2));
  writeFileSync(
    join(output, "count-query-contract.json"),
    JSON.stringify(f.countExchanges, null, 2),
  );
  result = {
    head,
    headTree,
    base: "03e24309cf919bf866bb2ffe2551beca27fd9bb3",
    provider: process.env.CRABBOX_PROVIDER ?? "host-supporting-only",
    image: process.env.CRABBOX_IMAGE ?? null,
    lease: process.env.CRABBOX_LEASE ?? null,
    node: process.version,
    bounded,
    sustained,
    firstComplete,
    opportunities: frames.length,
    queries: f.queries.reduce((n, r) => n + r.inventory, 0),
    changes,
    coreReads,
    complete: expected,
    total: 145,
    maxima,
    canonicalUnchanged: true,
    admissionUnchanged: true,
    clock: {
      kind: "CONTROLLED VIRTUAL CADENCE SIMULATION, NOT CURRENT LIVE OBSERVATIONS",
      epoch: new Date(epoch).toISOString(),
      evaluation: new Date(f.time).toISOString(),
      realExecutionStarted: new Date(realStarted).toISOString(),
      ordinarySpacingMs: 20 * 60_000,
      coverageSpacingMs: 6 * 60 * 60_000,
    },
    limits:
      "Actual CLI mode, subprocess GH adapter, signed Worker/DO and private build code; no live GH/Cloudflare authority, no workflow/cadence/concurrency change, Host invocations do not run browser proof. --browser is a separately granted contained replay; its visible caption and original snapshot timestamp prohibit treating virtual cadence evidence as current live observations.",
  };
} finally {
  f.close();
}
if (browserRequested) {
  const site = join(process.cwd(), "dashboard-site"),
    data = join(site, "src/data/dashboard.json"),
    prior = existsSync(data) ? readFileSync(data) : null;
  let server, browser;
  try {
    const snapshot = {
      ...JSON.parse(readFileSync(join(site, "fixtures/dashboard.json"))),
      ...selectedForBrowser,
      generatedAt: result.clock.evaluation,
    };
    mkdirSync(join(site, "src/data"), { recursive: true });
    writeFileSync(data, JSON.stringify(snapshot));
    const preload = pathToFileURL(
      join(process.cwd(), "docs/proof/ui-live-coverage/replay-clock-preload.mjs"),
    ).href;
    const build = spawnSync("pnpm", ["run", "build"], {
      cwd: site,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "") + " --import=" + preload,
        CLAWSWEEPER_PROOF_EVALUATION_AT: result.clock.evaluation,
      },
    });
    writeFileSync(join(output, "astro-build.log"), (build.stdout ?? "") + (build.stderr ?? ""));
    assert.equal(build.status, 0);
    const html = join(site, "dist/coverage/index.html"),
      caption =
        "CONTROLLED CLI CADENCE REPLAY — evaluated as of " +
        result.clock.evaluation +
        ". Actual execution began " +
        result.clock.realExecutionStarted +
        ". Counts are controlled as-of evidence, NOT current live observations. Browser wall time remains real.";
    writeFileSync(
      html,
      readFileSync(html, "utf8").replace(
        /<body([^>]*)>/,
        '<body$1><aside role="note" style="padding:1rem;background:#fff0b0;color:#161616">' +
          caption +
          "</aside>",
      ),
    );
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
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE ?? "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }),
      external = [];
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : (external.push(route.request().url()), route.abort()),
    );
    await page.goto("http://127.0.0.1:" + server.address().port + "/coverage/", {
      waitUntil: "networkidle",
    });
    await page.getByText("Verified collection windows", { exact: true }).click();
    const text = await page.locator("body").innerText();
    assert.ok(text.includes(result.complete + "/145 participating public repositories"));
    assert.ok(text.includes("CONTROLLED CLI CADENCE REPLAY"));
    assert.ok(text.includes("NOT current live observations"));
    assert.ok(text.includes("12 hours"));
    assert.ok(text.includes("witness"));
    assert.ok(text.includes("published"));
    if (sustained) assert.match(text, /Coverage unknown:/);
    assert.ok((await page.evaluate(() => Date.now())) >= realStarted);
    assert.equal(external.length, 0);
    writeFileSync(join(output, "coverage.html"), await page.content());
    await page.screenshot({ path: join(output, "coverage.png"), fullPage: true });
    result.browser = {
      passed: true,
      replayLabel: caption,
      browserClock: "real",
      buildClock: result.clock.evaluation,
      externalRequests: external.length,
      provider: process.env.CRABBOX_PROVIDER,
      image: process.env.CRABBOX_IMAGE,
      lease: process.env.CRABBOX_LEASE,
    };
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (prior) writeFileSync(data, prior);
    else rmSync(data, { force: true });
    writeFileSync(
      join(output, "cleanup.json"),
      JSON.stringify({ browserClosed: true, serverClosed: true, dataRestored: true }),
    );
  }
}
assert.deepEqual(hashes(), sourceBefore, "source changed during cadence proof");
result.sourceHashes = sourceBefore;
writeFileSync(join(output, "provenance.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
