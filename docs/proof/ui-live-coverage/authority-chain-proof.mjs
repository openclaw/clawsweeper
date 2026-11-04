// Real producer/Worker/DO + production build-selection + actual Astro/browser.
// Synthetic current GitHub authority revokes independently of unchanged source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  cpSync,
  statSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { authorityFixture } from "./coverage-authority-fixture.mjs";
import { captureProofSource, proofEnvironment } from "./proof-provenance.mjs";
const root = resolve(import.meta.dirname, "../../.."),
  environment = proofEnvironment(),
  executionStartedAt = new Date().toISOString(),
  output = join(root, ".artifacts/ui-live-coverage/authority-chain");
mkdirSync(output, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex"),
  fixture = await authorityFixture();
const census = JSON.stringify(fixture.persisted()),
  cases = [],
  requests = [],
  savedFetch = globalThis.fetch;
let forbidden = 0,
  browser,
  context,
  server;
globalThis.fetch = async () => {
  forbidden++;
  throw new Error("Authority proof forbids live network/model calls");
};
const site = join(root, "dashboard-site"),
  data = join(site, "src/data/dashboard.json"),
  original = existsSync(data) ? readFileSync(data) : null;
try {
  const initial = await fixture.build(),
    canonical = fixture.canonicalState();
  assert.equal(initial.coverage.totals.open_records, 12);
  let active;
  server = createServer((request, response) => {
    let file = join(active, new URL(request.url, "http://localhost").pathname);
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
        ".js": "application/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".png": "image/png",
      }[extname(file)] ?? "application/octet-stream",
    );
    response.end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.COVERAGE_PROOF_CHROMIUM,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  await page.route("**/*", (route) => {
    const request = route.request();
    requests.push({ method: request.method(), url: request.url() });
    if (request.method() === "GET" && new URL(request.url()).origin === origin)
      return route.continue();
    forbidden++;
    return route.abort();
  });
  const astroPackage = JSON.parse(readFileSync(join(site, "node_modules/astro/package.json"))),
    astroBin = resolve(site, "node_modules/astro", astroPackage.bin.astro);
  for (const mode of [
    "public",
    "private",
    "404",
    "renamed",
    "403",
    "429",
    "network",
    "invalid",
    "partial",
  ]) {
    fixture.setMode(mode);
    const anonResponse = await fixture.anonymous(),
      anonymous = await anonResponse.json();
    assert.equal(anonResponse.status, 200);
    assert.equal(Object.hasOwn(anonymous, "fleets"), false);
    assert.doesNotMatch(
      JSON.stringify(anonymous),
      /privacy[/\-]revocable|revoked-title-needle|"repo_slug"|"needs_refresh"/,
    );
    writeFileSync(join(output, mode + "-anonymous.json"), JSON.stringify(anonymous, null, 2));
    if (["403", "429", "network", "invalid", "partial"].includes(mode)) {
      await assert.rejects(
        fixture.build(),
        (error) => error.message === "coverage_visibility_unverified",
      );
      assert.equal(existsSync(join(output, mode + "-site")), false);
      cases.push({ mode, anonymousIdentities: 0, publication: "withheld-verification-failed" });
      continue;
    }
    const selected = await fixture.build(),
      snapshot = {
        ...JSON.parse(readFileSync(join(site, "fixtures/dashboard.json"))),
        ...selected,
        generatedAt: new Date().toISOString(),
      },
      serialized = JSON.stringify(snapshot);
    if (mode !== "public") {
      assert.doesNotMatch(
        serialized,
        /privacy[/\-]revocable|revoked-title-needle|"number":10[1-7]/,
      );
      assert.equal(selected.coverage.totals.open_records, 5);
      assert.equal(selected.corpus.totals.records, 6);
    }
    writeFileSync(join(output, mode + "-dashboard.json"), JSON.stringify(snapshot, null, 2));
    mkdirSync(join(site, "src/data"), { recursive: true });
    writeFileSync(data, serialized);
    const build = spawnSync(process.execPath, [astroBin, "build"], {
      cwd: site,
      encoding: "utf8",
      timeout: 120000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ASTRO_TELEMETRY_DISABLED: "1" },
    });
    writeFileSync(join(output, mode + "-build.log"), build.stdout + build.stderr);
    assert.equal(build.status, 0, build.stdout + build.stderr);
    active = join(output, mode + "-site");
    cpSync(join(site, "dist"), active, { recursive: true });
    if (mode !== "public") {
      for (const entry of readdirSync(active, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(?:html|json|js|css)$/.test(entry.name)) continue;
        assert.doesNotMatch(
          readFileSync(join(entry.parentPath, entry.name), "utf8"),
          /privacy[/-]revocable|revoked-title-needle|privacy[/-]renamed/,
          "no identifying value in ANY generated public text artifact",
        );
      }
    }
    await page.goto(origin + "/coverage/", { waitUntil: "networkidle" });
    const text = await page.locator("body").innerText(),
      html = await page.content();
    if (mode === "public") {
      assert.match(text, /privacy\/revocable/);
      assert.equal(
        await page.locator('[data-coverage-repo="privacy/revocable"] td').nth(1).innerText(),
        "7",
      );
    } else {
      assert.doesNotMatch(html, /privacy[/\-]revocable|revoked-title-needle|issues\/10[1-7]/);
      assert.equal(await page.locator('[data-coverage-repo="privacy/revocable"]').count(), 0);
      assert.equal(
        await page.locator('[data-coverage-repo="privacy/steady"] td').nth(1).innerText(),
        "2",
      );
    }
    writeFileSync(join(output, mode + "-rendered.html"), html);
    writeFileSync(join(output, mode + "-visible.txt"), text);
    await page.screenshot({ path: join(output, mode + ".png"), fullPage: true });
    cases.push({
      mode,
      anonymousIdentities: 0,
      builtOpen: selected.coverage.totals.open_records,
      corpusRecords: selected.corpus.totals.records,
      htmlSha256: hash(html),
      publication: "verified-current-public-only",
    });
  }
  assert.equal(JSON.stringify(fixture.persisted()), census);
  assert.deepEqual(fixture.canonicalState(), canonical);
  assert.equal(
    fixture.storage.scalar("SELECT COUNT(*) AS value FROM canonical_record_tuple_receipts"),
    0,
  );
  const purpose = '{"purpose":"dashboard-site-coverage-v1"}',
    readCallsBefore = fixture.calls.length,
    admission = [];
  for (const [name, args, expected] of [
    ["missing-signature", [purpose, "POST", undefined, false], 401],
    ["unconfigured-secret", [purpose, "POST", undefined, true, false], 503],
    ["wrong-purpose", ['{"purpose":"wrong"}'], 400],
    ["oversize", ["x".repeat(129)], 413],
    ["wrong-method", [purpose, "GET"], 404],
    ["query", [purpose, "POST", "/internal/review-coverage/build?repo=privacy/revocable"], 400],
    ["mutation-replay", [purpose, "POST", "/internal/review-coverage/inventory"], 401],
  ]) {
    const response = await fixture.signed(...args);
    assert.equal(response.status, expected);
    admission.push({ name, status: response.status });
  }
  assert.equal(fixture.calls.length, readCallsBefore, "rejected reads never reach DO");
  assert.ok(
    fixture.calls
      .filter((call) => call.path !== "/review-coverage/inventory")
      .every((call) => call.method === "GET" && call.path === "/review-coverage"),
  );
  assert.equal(forbidden, 0);
  await context.tracing.stop({ path: join(output, "browser-trace.zip") });
  const receipt = {
    ok: true,
    ...environment,
    ...captureProofSource(root),
    procedureSourceSha256: hash(readFileSync(import.meta.filename)),
    cases,
    admission,
    executionStartedAt,
    executionFinishedAt: new Date().toISOString(),
    requests,
    metadataCalls: fixture.metadataCalls,
    queueCalls: fixture.calls,
    censusSha256: hash(census),
    canonicalStateUnchanged: true,
    newTuples: 0,
    forbiddenNetwork: forbidden,
    anonymousContract: "aggregate-only; NEVER an identifying public-positive path",
    positiveAuthority:
      "fixed-purpose signed private read PLUS current GitHub metadata at build publication",
    limits: [
      "Explicit synthetic authority service,no live GitHub/model/production reads",
      "Current-build publication gate,not retroactive deletion of already-published historical snapshots",
      "Node SQLite/local immutable body adapter,not deployed Cloudflare",
    ],
  };
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: cases.length,
        publicOpen: 12,
        afterPrivateOpen: 5,
        anonymousIdentities: 0,
        forbiddenNetwork: forbidden,
      },
      null,
      2,
    ),
  );
} finally {
  globalThis.fetch = savedFetch;
  if (original) writeFileSync(data, original);
  else rmSync(data, { force: true });
  if (context) await context.close();
  if (browser) await browser.close();
  if (server) await new Promise((done) => server.close(done));
}
