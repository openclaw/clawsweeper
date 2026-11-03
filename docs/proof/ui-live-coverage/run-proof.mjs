// Adapted from Vincent Koc's identity proof at 09924e (PR 2018), qualified
// for current canonical v2 metadata and extended through built Astro/browser UI.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import worker, { ExactReviewQueue } from "../../../dashboard/worker.ts";
import { ExactReviewDirectPublicationStore } from "../../../dashboard/exact-review-direct-publication.ts";
import { TestStorage } from "../../../test/exact-review-test-storage.ts";
import { loadReviewCoverageInventory } from "../../../dist/repair/target-fanout.js";
import { chromium } from "playwright-core";
import { verifiedCoverageBuildRead, syntheticPublicMetadata } from "./coverage-build-read.mjs";
import { captureProofSource, proofEnvironment } from "./proof-provenance.mjs";

const root = resolve(import.meta.dirname, "../../..");
const output = join(root, ".artifacts/ui-live-coverage");
mkdirSync(output, { recursive: true });
const environment = proofEnvironment();
const timestamp = new Date().toISOString();
const now = Date.parse(timestamp);
const old = new Date(now - 10 * 86400000).toISOString();
const secret = "synthetic-local-coverage-proof-secret";
const calls = [];
const cases = [];
const savedFetch = globalThis.fetch;
let forbiddenNetwork = 0;
globalThis.fetch = async () => {
  forbiddenNetwork++;
  throw new Error("No remote network/model calls in coverage proof");
};
function item(number, extra = {}) {
  return { number, kind: "issue", labels: [], updated_at: old, reopened_at: null, ...extra };
}
function census(repo, items, mode = "complete") {
  return loadReviewCoverageInventory(
    [{ targetRepo: repo, defaultBranch: "main", visibility: "PUBLIC" }],
    new Map([
      [
        repo,
        {
          issues: items.filter((row) => row.kind === "issue").length,
          pullRequests: items.filter((row) => row.kind === "pull_request").length,
        },
      ],
    ]),
    now,
    (query) => {
      assert.match(query, /^query FleetCoverageItems/);
      assert.doesNotMatch(query, /mutation|createComment|addComment|requestReview/);
      calls.push({ boundary: "github-fixture", method: "query", mode });
      if (mode === "error" || mode === "rate_limit") throw new Error(mode);
      const after = query.match(/after:"([^"]+)"/)?.[1];
      const start = after ? Number(after) : 0;
      const repository = Object.fromEntries(
        ["issues", "pullRequests"]
          .filter((connection) => query.includes(connection + "(states"))
          .map((connection) => {
            const kind = connection === "issues" ? "issue" : "pull_request";
            const rows = items.filter((row) => row.kind === kind);
            const nodes = rows.slice(start, start + 100).map((row) => ({
              number: row.number,
              updatedAt: row.updated_at,
              timelineItems: { nodes: row.reopened_at ? [{ createdAt: row.reopened_at }] : [] },
              ...(kind === "pull_request" ? { headRefOid: row.head_sha } : {}),
              labels: {
                nodes: row.labels.map((name) => ({ name })),
                pageInfo: { hasNextPage: mode === "labels_incomplete" },
              },
            }));
            return [
              connection,
              {
                totalCount: rows.length + (mode === "count_drift" ? 1 : 0),
                nodes,
                pageInfo: {
                  hasNextPage: start + nodes.length < rows.length,
                  endCursor: String(start + nodes.length),
                },
              },
            ];
          }),
      );
      return { data: query.includes("r0:repository") ? { r0: repository } : { repository } };
    },
  );
}
function fixture(
  repo,
  name,
  runtime = { worker, Queue: ExactReviewQueue, Store: ExactReviewDirectPublicationStore },
) {
  const slug = repo.replace("/", "-");
  const storage = new TestStorage();
  const bucketDir = join(output, name, "canonical-bodies");
  mkdirSync(bucketDir, { recursive: true });
  const bucket = {
    async put(key, value) {
      const path = join(bucketDir, key.split("/").at(-1));
      if (!existsSync(path)) writeFileSync(path, value);
    },
    async get(key) {
      const path = join(bucketDir, key.split("/").at(-1));
      if (!existsSync(path)) return null;
      const value = readFileSync(path);
      return {
        size: value.length,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(value);
            controller.close();
          },
        }),
      };
    },
  };
  const queue = new runtime.Queue({ storage }, { STATE_SNAPSHOTS: bucket });
  const env = {
    STATE_SNAPSHOTS: bucket,
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (request) => {
          calls.push({
            boundary: "local-do",
            method: request.method,
            path: new URL(request.url).pathname,
          });
          return queue.fetch(request);
        },
      }),
    },
  };
  async function post(path, payload, signed = true) {
    const body = JSON.stringify(payload);
    return runtime.worker.fetch(
      new Request("https://local.invalid" + path, {
        method: "POST",
        body,
        headers: signed
          ? {
              "x-clawsweeper-exact-review-signature":
                "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
            }
          : {},
      }),
      env,
    );
  }
  async function inventory(value) {
    const response = await post("/internal/review-coverage/inventory", value);
    assert.equal(response.status, 202, await response.clone().text());
    // Qualify only this newly-created local fixture for the native v2 writer.
    // These synthetic local lifecycle gates do not attest production policy.
    const store = new runtime.Store(storage, bucket);
    const sha = "96869eede468afe433994130d62edd50884ef43a";
    const preview = await store.tieringPreview(sha, {
      operator: "synthetic-local-proof",
      rollbackFloor: {
        sha,
        supportsFormats: [1, 2],
        proof: "Synthetic local fixture exercises both read formats",
      },
      bucketLifecycle: {
        bucketIdentity: "clawsweeper-state-snapshots",
        observedAt: timestamp,
        rulesJson: '{"rules":[]}',
        canonicalBodiesDoNotExpire: true,
      },
    });
    store.activateTieringSync(preview, now);
  }
  async function record(number, extra = {}) {
    const {
      kind = "issue",
      headSha = "",
      status = "complete",
      date = timestamp,
      labels = [],
      longHeader = false,
    } = extra;
    const content = [
      "---",
      "repository: " + repo,
      "number: " + number,
      "type: " + kind,
      "reviewed_at: " + date,
      "pull_head_sha: " + headSha,
      "review_status: " + status,
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "labels: " + JSON.stringify(labels),
      "title: " +
        (longHeader ? "Synthetic fixture ".repeat(500) : "Synthetic fixture; not a model review"),
      "---",
      "Synthetic local fixture only.",
    ].join("\n");
    const response = await post("/internal/state/records/tuples", {
      deliveryId: "record-tuple:ui-proof:" + number,
      key: slug + "/" + number,
      operations: [
        {
          path: "records/" + slug + "/items/" + number + ".md",
          expectedDigest: null,
          contentBase64: Buffer.from(content).toString("base64"),
        },
        ...["closed", "plans", "decision-packets"].map((section) => ({
          path:
            "records/" +
            slug +
            "/" +
            section +
            "/" +
            number +
            (section === "decision-packets" ? ".json" : ".md"),
          expectedDigest: null,
        })),
      ],
    });
    assert.equal(response.status, 202, await response.clone().text());
  }
  function seedLegacyRecord(number, { status = "complete", date = timestamp } = {}) {
    const content = [
      "---",
      "repository: " + repo,
      "number: " + number,
      "type: issue",
      "reviewed_at: " + date,
      "review_status: " + status,
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "---",
      "Existing synthetic pre-upgrade canonical body; no new review or tuple publication.",
    ].join("\n");
    const digest = createHash("sha256").update(content).digest("hex");
    writeFileSync(join(bucketDir, digest), content);
    storage.sql.exec(
      "INSERT INTO exact_review_canonical_records_v2 (repo_slug,section,item_id,digest,byte_length,deleted,revision,item_key,claim_generation,updated_at,coverage_repo,coverage_status,coverage_reviewed_at,coverage_excluded) VALUES (?,'items',?,?,?,0,7,?,3,?,?,?, ?,0)",
      slug,
      number,
      digest,
      Buffer.byteLength(content),
      repo + "#" + number,
      now - 120000,
      repo,
      status,
      Date.parse(date),
    );
    return Array.from(
      storage.sql.exec(
        "SELECT * FROM exact_review_canonical_records_v2 WHERE repo_slug=? AND item_id=?",
        slug,
        number,
      ),
    )[0];
  }
  async function coverage() {
    const response = await runtime.worker.fetch(
      new Request("https://local.invalid/api/review-coverage"),
      env,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const anonymous = await response.json();
    const body =
      runtime.worker === worker
        ? await verifiedCoverageBuildRead(
            (url, init) => runtime.worker.fetch(new Request(String(url), init), env),
            secret,
            syntheticPublicMetadata("fixture/ocm"),
          )
        : anonymous;
    if (runtime.worker === worker) {
      assert.ok(!JSON.stringify(anonymous).includes(repo));
      assert.equal(Object.hasOwn(anonymous, "fleets"), false);
      writeFileSync(join(output, name + "-anonymous-api.json"), JSON.stringify(anonymous, null, 2));
    }
    writeFileSync(join(output, name + "-worker.json"), JSON.stringify(body, null, 2));
    const rows = Array.from(
      storage.sql.exec("SELECT COUNT(*) AS count FROM exact_review_canonical_records_v2"),
    );
    cases.push({ name, canonical_v2_records: rows[0].count, coverage: body });
    return body;
  }
  return { post, inventory, record, coverage, storage, seedLegacyRecord };
}
const views = [];
try {
  const repo = "fixture/ocm";
  const baselineSource = join(root, ".openclaw/tmp/ui-live-coverage/baseline-runtime");
  mkdirSync(baselineSource, { recursive: true });
  const sourceArchive = execFileSync(
    "git",
    [
      "archive",
      "96869eede468afe433994130d62edd50884ef43a",
      "dashboard",
      "src",
      "config",
      "package.json",
    ],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );
  execFileSync("tar", ["-x", "-C", baselineSource], { input: sourceArchive });
  const baselineWorker = await import(
    pathToFileURL(join(baselineSource, "dashboard/worker.ts")).href
  );
  const baselineStore = await import(
    pathToFileURL(join(baselineSource, "dashboard/exact-review-direct-publication.ts")).href
  );
  const baselineRuntime = {
    worker: baselineWorker.default,
    Queue: baselineWorker.ExactReviewQueue,
    Store: baselineStore.ExactReviewDirectPublicationStore,
  };
  const joined = fixture(repo, "one-of-three");
  const measured = census(repo, [item(1), item(2), item(3)]);
  assert.equal(
    (await joined.post("/internal/review-coverage/inventory", measured, false)).status,
    401,
  );
  await joined.inventory(measured);
  for (const number of [1, 99, 100]) await joined.record(number, { longHeader: number === 1 });
  const result = await joined.coverage();
  const baseJoined = fixture(repo, "baseline-one-of-three", baselineRuntime);
  await baseJoined.inventory(measured);
  for (const number of [1, 99, 100]) await baseJoined.record(number, { longHeader: number === 1 });
  const baseJoinedResult = await baseJoined.coverage();
  assert.equal(baseJoinedResult.totals.coverage_percent, 100);
  assert.equal(cases.find((value) => value.name === "one-of-three").canonical_v2_records, 12);
  assert.equal(result.totals.coverage_percent, 33.3);
  assert.equal(result.totals.untracked_open, 2);
  assert.equal(result.totals.record_drift, 2);
  views.push({ name: "one-of-three", coverage: result, expectedOpen: 3, expectedPercent: "33.3%" });
  const legacyFacts = fixture(repo, "legacy-facts-materialized");
  await legacyFacts.inventory(census(repo, [item(1), item(2), item(3)]));
  const beforeLegacy = [
    legacyFacts.seedLegacyRecord(1),
    legacyFacts.seedLegacyRecord(2, { status: "failed" }),
    legacyFacts.seedLegacyRecord(3, { date: old }),
  ];
  assert.ok(beforeLegacy.every((row) => row.coverage_facts === null));
  const legacyResult = await legacyFacts.coverage();
  assert.equal(legacyResult.totals.open_records, 3);
  assert.equal(legacyResult.totals.reviewed_recent, 1);
  assert.equal(legacyResult.totals.failed, 1);
  assert.equal(legacyResult.totals.expired, 1);
  assert.equal(legacyResult.totals.coverage_percent, 33.3);
  const afterLegacy = Array.from(
    legacyFacts.storage.sql.exec(
      "SELECT * FROM exact_review_canonical_records_v2 ORDER BY item_id",
    ),
  );
  const sourceOnly = (row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== "coverage_facts"));
  assert.deepEqual(afterLegacy.map(sourceOnly), beforeLegacy.map(sourceOnly));
  assert.ok(
    afterLegacy.every(
      (row) =>
        JSON.parse(row.coverage_facts).sourceDigest === row.digest &&
        JSON.parse(row.coverage_facts).sourceRevision === row.revision,
    ),
  );
  assert.equal(
    Array.from(
      legacyFacts.storage.sql.exec("SELECT COUNT(*) AS count FROM canonical_record_tuple_receipts"),
    )[0].count,
    0,
  );
  cases.at(-1).legacy_materialization = {
    before: beforeLegacy,
    after: afterLegacy,
    new_tuple_receipts: 0,
  };
  views.push({
    name: "legacy-facts-materialized",
    coverage: legacyResult,
    expectedOpen: 3,
    expectedPercent: "33.3%",
  });
  const disjoint = fixture(repo, "disjoint");
  await disjoint.inventory(census(repo, [item(4), item(5), item(6)]));
  for (const number of [1, 2, 3]) await disjoint.record(number);
  assert.equal((await disjoint.coverage()).totals.coverage_percent, 0);
  const ocm = fixture(repo, "ocm721");
  await ocm.inventory(
    census(repo, [item(1), ...Array.from({ length: 6 }, (_, i) => item(1002 + i))]),
  );
  for (let number = 1; number <= 721; number++)
    await ocm.record(number, { date: number >= 269 ? old : timestamp });
  const ocmResult = await ocm.coverage();
  const baseOcm = fixture(repo, "baseline-ocm721", baselineRuntime);
  await baseOcm.inventory(
    census(repo, [item(1), ...Array.from({ length: 6 }, (_, i) => item(1002 + i))]),
  );
  for (let number = 1; number <= 721; number++)
    await baseOcm.record(number, { date: number >= 269 ? old : timestamp });
  const baseOcmResult = await baseOcm.coverage();
  assert.equal(baseOcmResult.totals.coverage_percent, 100);
  assert.equal(ocmResult.totals.open_records, 7);
  assert.equal(ocmResult.totals.reviewed_recent, 1);
  assert.equal(ocmResult.totals.record_drift, 720);
  views.push({ name: "ocm721", coverage: ocmResult, expectedOpen: 7, expectedPercent: "14.3%" });
  const changed = fixture(repo, "categories");
  await changed.inventory(
    census(repo, [
      item(1, { kind: "pull_request", head_sha: "a".repeat(40) }),
      item(2, { updated_at: timestamp, reopened_at: timestamp }),
      item(3),
      item(4),
      item(5),
      item(6),
      item(7, { labels: ["security"] }),
    ]),
  );
  await changed.record(1, { kind: "pull_request", headSha: "b".repeat(40) });
  await changed.record(2, { date: old });
  await changed.record(3, { date: old });
  await changed.record(4, { date: "invalid" });
  await changed.record(5, { date: new Date(now + 3600000).toISOString() });
  await changed.record(6, { status: "failed" });
  await changed.record(7);
  const categoryResult = await changed.coverage();
  assert.equal(categoryResult.totals.stale, 2);
  assert.equal(categoryResult.totals.expired, 1);
  assert.equal(categoryResult.totals.excluded, 1);
  assert.equal(categoryResult.totals.reviewed_recent, 0);
  assert.equal(categoryResult.totals.unreviewed_records, 2);
  views.push({
    name: "categories",
    coverage: categoryResult,
    expectedOpen: 7,
    expectedPercent: "0.0%",
  });
  for (const mode of ["error", "rate_limit", "count_drift", "labels_incomplete"]) {
    const measured = census(repo, [item(1)], mode);
    assert.equal(measured.repositories[0].complete, false);
    const target = fixture(repo, mode);
    await target.inventory(measured);
    const body = await target.coverage();
    assert.equal(body.totals.open_records, 1);
    assert.equal(body.totals.reviewable_records, null);
    assert.equal(body.totals.coverage_percent, null);
    if (mode === "count_drift") views.push({ name: "unknown", coverage: body });
  }
  // Bounded max-page producer terminates with UNKNOWN, never a partial denominator.
  const bounded = census(
    repo,
    Array.from({ length: 1001 }, (_, i) => item(i + 1)),
  );
  assert.equal(bounded.repositories[0].complete, false);
  for (const [name, value] of [
    ["missing", null],
    [
      "stale",
      {
        ...census(repo, [item(1, { updated_at: old })]),
        generated_at: new Date(now - 13 * 3600000).toISOString(),
      },
    ],
    ["future", { ...census(repo, [item(1)]), generated_at: new Date(now + 3600000).toISOString() }],
  ]) {
    const target = fixture(repo, name);
    if (value) await target.inventory(value);
    const body = await target.coverage();
    assert.equal(body.totals.coverage_percent, null);
    assert.equal(body.totals.open_records, value ? 1 : null);
  }
  assert.equal(forbiddenNetwork, 0);
  writeFileSync(join(output, "boundary-calls.json"), JSON.stringify(calls, null, 2));
  // The real site data module consumes the public Worker receipt, with an
  // explicitly synthetic corpus containing the historical 721/453 arithmetic.
  const baseSnapshot = JSON.parse(
    readFileSync(join(root, "dashboard-site/fixtures/dashboard.json"), "utf8"),
  );
  const example = baseSnapshot.corpus.repos[0];
  baseSnapshot.corpus.repos = [
    {
      ...example,
      repo,
      slug: "fixture-ocm",
      records: 721,
      open: 721,
      staleOpen: 453,
      reviewed7d: 268,
      reviewed30d: 721,
    },
    {
      ...example,
      repo: "fixture/archived",
      slug: "fixture-archived",
      records: 5,
      open: 5,
      staleOpen: 5,
    },
    { ...example, repo: "fixture/alias", slug: "fixture-alias", records: 4, open: 4, staleOpen: 4 },
    { ...example, repo: "fixture/fork", slug: "fixture-fork", records: 3, open: 3, staleOpen: 3 },
  ];
  baseSnapshot.repositoryStates = {
    "fixture/archived": "Archived public repository; historical only",
    "fixture/alias": "Historical alias → fixture/ocm; not a distinct live repository",
    "fixture/fork": "Public fork; eligibility not inferred",
  };
  const dataPath = join(root, "dashboard-site/src/data/dashboard.json");
  mkdirSync(dirname(dataPath), { recursive: true });
  const oldData = existsSync(dataPath) ? readFileSync(dataPath) : null;
  const site = join(root, "dashboard-site");
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CI: "1",
    ASTRO_TELEMETRY_DISABLED: "1",
  };
  const astroPackage = JSON.parse(
    readFileSync(join(site, "node_modules/astro/package.json"), "utf8"),
  );
  const astroBin = resolve(site, "node_modules/astro", astroPackage.bin.astro);
  const builds = [];
  function build(name, coverage, siteRoot = site) {
    writeFileSync(
      join(siteRoot, "src/data/dashboard.json"),
      JSON.stringify({ ...baseSnapshot, coverage }),
    );
    const result = spawnSync(process.execPath, [astroBin, "build"], {
      cwd: siteRoot,
      env,
      encoding: "utf8",
      timeout: 120000,
    });
    writeFileSync(join(output, name + "-build.log"), result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const destination = join(output, name + "-site");
    cpSync(join(siteRoot, "dist"), destination, { recursive: true });
    builds.push({ name, root: destination });
  }
  try {
    for (const view of views) build(view.name, view.coverage);
    // Build the pinned baseline page in a scratch copy, never checkout/reset root.
    const baseline = join(root, ".openclaw/tmp/ui-live-coverage/baseline-site");
    cpSync(site, baseline, {
      recursive: true,
      filter: (path) => !/[\/](node_modules|dist|[.]astro)([\/]|$)/.test(path),
    });
    if (!existsSync(join(baseline, "node_modules")))
      symlinkSync(join(site, "node_modules"), join(baseline, "node_modules"), "dir");
    writeFileSync(
      join(baseline, "src/pages/coverage.astro"),
      execFileSync(
        "git",
        [
          "show",
          "96869eede468afe433994130d62edd50884ef43a:dashboard-site/src/pages/coverage.astro",
        ],
        { cwd: root },
      ),
    );
    writeFileSync(
      join(baseline, "src/lib/data.ts"),
      execFileSync(
        "git",
        ["show", "96869eede468afe433994130d62edd50884ef43a:dashboard-site/src/lib/data.ts"],
        { cwd: root },
      ),
    );
    build("baseline", baseOcmResult, baseline);
  } finally {
    if (oldData) writeFileSync(dataPath, oldData);
  }
  let activeRoot = builds[0].root;
  const server = createServer((request, response) => {
    const path = join(
      activeRoot,
      decodeURIComponent(new URL(request.url, "http://localhost").pathname),
    );
    const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "index.html") : path;
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
        ".woff2": "font/woff2",
      }[extname(file)] ?? "application/octet-stream",
    );
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browserRoot = join(process.env.HOME, ".cache/ms-playwright");
  const binaries = existsSync(browserRoot)
    ? readdirSync(browserRoot)
        .filter((name) => name.startsWith("chromium-"))
        .sort()
        .reverse()
        .map((name) => join(browserRoot, name, "chrome-linux64/chrome"))
    : [];
  const executable = process.env.COVERAGE_PROOF_CHROMIUM ?? binaries.find(existsSync);
  const browser = await chromium.launch({
    headless: true,
    ...(executable ? { executablePath: executable } : {}),
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const requests = [];
    await page.route("**/*", (route) => {
      const request = route.request();
      requests.push({ url: request.url(), method: request.method() });
      if (!request.url().startsWith(origin) || request.method() !== "GET") return route.abort();
      return route.continue();
    });
    for (const buildResult of builds) {
      activeRoot = buildResult.root;
      await page.goto(origin + "/coverage/", { waitUntil: "networkidle" });
      const text = await page.locator("body").innerText();
      writeFileSync(join(output, buildResult.name + "-browser.txt"), text);
      await page.screenshot({ path: join(output, buildResult.name + ".png"), fullPage: true });
      if (buildResult.name === "baseline") {
        const row = page
          .locator("tr")
          .filter({ has: page.locator('a[href="/repos/fixture-ocm"]') });
        assert.equal(await row.locator("td").nth(1).innerText(), "721");
        assert.equal(await row.locator("td").nth(2).innerText(), "453");
      } else {
        const view = views.find((row) => row.name === buildResult.name);
        if (view.expectedOpen !== undefined) {
          const row = page.locator('[data-coverage-repo="fixture/ocm"]');
          assert.equal(await row.locator("td").nth(1).innerText(), String(view.expectedOpen));
          assert.equal(await row.locator("td").nth(4).innerText(), view.expectedPercent);
          assert.ok(text.includes(view.expectedPercent));
        } else {
          assert.match(text, /Coverage unknown/);
          assert.match(text, /Unknown — no partial denominator/);
        }
        assert.match(text, /Stored review history — not current-open coverage/);
        assert.match(text, /Archived public repository/);
        assert.match(text, /Historical alias/);
        assert.match(text, /Public fork/);
        assert.equal(await page.locator("form").count(), 0);
      }
    }
    assert.ok(
      requests.every((request) => request.method === "GET" && request.url.startsWith(origin)),
    );
    writeFileSync(join(output, "browser-requests.json"), JSON.stringify(requests, null, 2));
    await context.tracing.stop({ path: join(output, "browser-trace.zip") });
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  const receipt = {
    ok: true,
    ...environment,
    ...captureProofSource(root),
    procedureSourceSha256: createHash("sha256")
      .update(readFileSync(import.meta.filename))
      .digest("hex"),
    node: process.version,
    pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
    forbidden_network_calls: forbiddenNetwork,
    cases,
    builds: builds.map(({ name }) => name),
    limits: [
      "Synthetic review contents and GitHub census boundary; no model or live GitHub authority exercised",
      "Node SQLite and local immutable-file R2 adapter, not deployed Cloudflare services",
      "Host-supporting run is not a substitute for required admitted local-container proof",
      "Static UI is explicitly as-of; no browser GitHub calls or mutation controls",
    ],
  };
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        qualification: receipt.qualification,
        artifact: join(output, "receipt.json"),
        cases: cases.length,
        builds: builds.length,
      },
      null,
      2,
    ),
  );
} finally {
  globalThis.fetch = savedFetch;
}
