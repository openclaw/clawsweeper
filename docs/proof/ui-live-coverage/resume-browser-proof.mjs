// Resume only the unfinished browser phase after a Gateway restart. This never
// reruns completed Worker cases, builds, model calls or any external operation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
const root = resolve(import.meta.dirname, "../../..");
const output = join(root, ".artifacts/ui-live-coverage");
const log = readFileSync(
  join(root, ".openclaw/tmp/ui-live-coverage/correction-runtime.log"),
  "utf8",
);
assert.match(log, /page.goto: Target page, context or browser has been closed/);
assert.doesNotMatch(log, /AssertionError/);
const names = [
  "one-of-three",
  "baseline-one-of-three",
  "legacy-facts-materialized",
  "disjoint",
  "ocm721",
  "baseline-ocm721",
  "categories",
  "error",
  "rate_limit",
  "count_drift",
  "labels_incomplete",
  "missing",
  "stale",
  "future",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cases = names.map((name) => ({
  name,
  coverage: JSON.parse(readFileSync(join(output, name + "-worker.json"), "utf8")),
  artifactSha256: hash(readFileSync(join(output, name + "-worker.json"))),
}));
const caseByName = new Map(cases.map((row) => [row.name, row]));
const frozenTime = Date.parse(caseByName.get("one-of-three").coverage.inventory_generated_at);
assert.ok(
  frozenTime > Date.parse("2026-11-02T22:50:00Z"),
  "Do not qualify the old pre-correction receipt",
);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const allFiles = [
  ...new Set(
    (git("diff", "--name-only", "HEAD") + "\n" + git("ls-files", "--others", "--exclude-standard"))
      .split("\n")
      .filter(Boolean),
  ),
].sort();
const production = allFiles.filter(
  (file) =>
    (file.startsWith("src/") ||
      file.startsWith("dashboard/") ||
      file.startsWith("dashboard-site/")) &&
    !file.includes("fixtures/"),
);
const changedAfterPhase = production.filter(
  (file) => statSync(join(root, file)).mtimeMs > frozenTime,
);
assert.deepEqual(
  changedAfterPhase,
  [],
  "Production source changed since retained Worker/build phases; cannot resume their proof",
);
const sourceBinding = Object.fromEntries(
  allFiles.map((file) => [file, hash(readFileSync(join(root, file)))]),
);
assert.equal(caseByName.get("one-of-three").coverage.totals.coverage_percent, 33.3);
assert.equal(caseByName.get("baseline-one-of-three").coverage.totals.coverage_percent, 100);
assert.equal(caseByName.get("ocm721").coverage.totals.open_records, 7);
assert.equal(caseByName.get("ocm721").coverage.totals.coverage_percent, 14.3);
assert.equal(caseByName.get("legacy-facts-materialized").coverage.totals.coverage_percent, 33.3);
const builds = [
  { name: "one-of-three", open: "3", fresh: "33.3%" },
  { name: "legacy-facts-materialized", open: "3", fresh: "33.3%" },
  { name: "ocm721", open: "7", fresh: "14.3%" },
  { name: "categories", open: "7", fresh: "0.0%" },
  { name: "unknown", open: "1", fresh: "Unknown" },
  { name: "baseline" },
];
for (const build of builds) {
  const page = join(output, build.name + "-site/coverage/index.html");
  assert.ok(existsSync(page));
  assert.ok(statSync(page).mtimeMs >= frozenTime);
  build.htmlSha256 = hash(readFileSync(page));
}
let active = join(output, builds[0].name + "-site");
const server = createServer((request, response) => {
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
      ".css": "text/css",
      ".js": "application/javascript",
      ".png": "image/png",
      ".woff2": "font/woff2",
    }[extname(file)] ?? "application/octet-stream",
  );
  response.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const cache = join(process.env.HOME, ".cache/ms-playwright");
const executable =
  process.env.COVERAGE_PROOF_CHROMIUM ??
  readdirSync(cache)
    .filter((name) => name.startsWith("chromium-"))
    .sort()
    .reverse()
    .map((name) => join(cache, name, "chrome-linux64/chrome"))
    .find(existsSync);
let browser, context;
try {
  browser = await chromium.launch({ headless: true, executablePath: executable });
  context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage(),
    requests = [];
  await page.route("**/*", (route) => {
    const r = route.request();
    requests.push({ url: r.url(), method: r.method() });
    return r.url().startsWith(origin) && r.method() === "GET" ? route.continue() : route.abort();
  });
  for (const build of builds) {
    active = join(output, build.name + "-site");
    await page.goto(origin + "/coverage/", { waitUntil: "networkidle" });
    const text = await page.locator("body").innerText();
    writeFileSync(join(output, build.name + "-browser.txt"), text);
    await page.screenshot({ path: join(output, build.name + ".png"), fullPage: true });
    if (build.name === "baseline") {
      const row = page.locator("tr").filter({ has: page.locator('a[href="/repos/fixture-ocm"]') });
      assert.equal(await row.locator("td").nth(1).innerText(), "721");
      assert.equal(await row.locator("td").nth(2).innerText(), "453");
    } else {
      const row = page.locator('[data-coverage-repo="fixture/ocm"]');
      assert.equal(await row.locator("td").nth(1).innerText(), build.open);
      assert.equal(await row.locator("td").nth(4).innerText(), build.fresh);
      assert.match(text, /Stored review history — not current-open coverage/);
      assert.equal(await page.locator("form").count(), 0);
    }
  }
  assert.ok(requests.every((row) => row.url.startsWith(origin) && row.method === "GET"));
  await context.tracing.stop({ path: join(output, "correction-browser-trace.zip") });
  const old = join(output, "receipt.json");
  if (existsSync(old) && !existsSync(join(output, "pre-correction-receipt-22-16.json")))
    copyFileSync(old, join(output, "pre-correction-receipt-22-16.json"));
  const receipt = {
    ok: true,
    procedureSourceSha256: hash(readFileSync(import.meta.filename)),
    production_source_sha256: Object.fromEntries(
      production.map((file) => [file, sourceBinding[file]]),
    ),
    qualification: "supporting-host continuation only; not a container receipt",
    provider: "host",
    image: null,
    lease: null,
    node: process.version,
    base: git("rev-parse", "HEAD"),
    head: git("rev-parse", "HEAD"),
    generated_at: new Date().toISOString(),
    source_sha256: sourceBinding,
    source_tree_digest: hash(JSON.stringify(sourceBinding)),
    files: sourceBinding,
    cases,
    builds,
    browserRequests: requests,
    continuation: {
      cause: "Gateway restart closed browser at first navigation",
      retainedWorkerAndBuildObservationAt: new Date(frozenTime).toISOString(),
      noProductionSourceChangesSincePhase: true,
      noWorkerOrBuildRerun: true,
      originalFailureLogSha256: hash(log),
      lostInMemoryFields:
        "Original SQL row-count/legacy before-after arrays were not checkpointed; do not invent them. The completed current 71-test log separately proves those assertions.",
    },
    limits: [
      "Retained actual production Worker outputs and built pages, then resumed real browser phase",
      "Worker/body and build assertions had reached navigation before the restart; stdout and source stability are retained, not a qualified container receipt",
      "Current frozen fleet comparison is a separate post-producer replay, never these synthetic fixture freshness values",
    ],
  };
  writeFileSync(
    join(output, "correction-runtime-continuation.json"),
    JSON.stringify(receipt, null, 2),
  );
  writeFileSync(old, JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: cases.length,
        builds: builds.length,
        artifact: old,
        sourceTreeDigest: receipt.source_tree_digest,
        limits: receipt.qualification,
      },
      null,
      2,
    ),
  );
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
