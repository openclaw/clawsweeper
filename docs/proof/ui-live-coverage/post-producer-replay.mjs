// Same frozen bundle, actual baseline/candidate producer stages and signed local
// Worker intake. No labels, reopen events, or canonical statuses are invented.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { chromium } from "playwright-core";
import candidateWorker, { ExactReviewQueue } from "../../../dashboard/worker.ts";
import { TestStorage } from "../../../test/exact-review-test-storage.ts";
import * as candidateProducer from "../../../dist/repair/target-fanout.js";
const root = resolve(import.meta.dirname, "../../..");
const base = "96869eede468afe433994130d62edd50884ef43a";
const scratch = join(root, ".openclaw/tmp/ui-live-coverage/post-producer-replay");
const output = join(root, ".artifacts/ui-live-coverage/post-producer-comparison");
mkdirSync(scratch, { recursive: true });
mkdirSync(output, { recursive: true });
const previous = join(root, ".artifacts/ui-live-coverage/current-comparison");
const original = join(root, ".artifacts/ui-live-coverage/legacy-only-preview");
if (!existsSync(original)) cpSync(previous, original, { recursive: true });
const referenceBytes = readFileSync(join(previous, "github-reference.json"));
const reference = JSON.parse(referenceBytes);
const frozenDir = join(root, ".openclaw/tmp/ui-live-coverage/current-snapshot");
const htmlBytes = readFileSync(join(frozenDir, "coverage-.html")),
  repoBytes = readFileSync(join(frozenDir, "repos-.html")),
  apiBytes = readFileSync(join(frozenDir, "api-review-coverage.json"));
const legacyCoverage = JSON.parse(apiBytes);
const sourceNow = Date.parse(reference.completedAt);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const boundary = [];
let forbidden = 0;
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => {
  forbidden++;
  throw new Error("Post-producer replay forbids network/model calls");
};
const referenceByName = new Map(reference.repositories.map((row) => [row.repo.toLowerCase(), row]));
const countRows = JSON.parse(readFileSync(join(previous, "baseline-table.json"), "utf8"));
const repositories = countRows.map((row) => {
  const observation = referenceByName.get(row.repo.toLowerCase());
  const canonical = observation?.canonical?.toLowerCase();
  const scope =
    !observation || observation.visibility !== "PUBLIC"
      ? "historical"
      : canonical && canonical !== row.repo.toLowerCase()
        ? "alias"
        : observation.archived
          ? "archived"
          : observation.fork
            ? "fork"
            : "observed";
  return {
    targetRepo: row.repo,
    visibility: observation?.visibility ?? "UNKNOWN",
    defaultBranch: "unknown-not-captured-unused-by-coverage",
    coverageScope: scope,
  };
});
function responseFor(query) {
  assert.match(query, /^query (FleetCoverageItems|ReplayCountWitness)/);
  assert.doesNotMatch(query, /mutation|createComment|requestReview/);
  const aliases = [
    ...query.matchAll(
      /(r[0-9]+):repository\(owner:("(?:[^"\\]|\\.)*"),name:("(?:[^"\\]|\\.)*")\)/g,
    ),
  ];
  const data = {};
  for (const match of aliases) {
    const repo = JSON.parse(match[2]) + "/" + JSON.parse(match[3]);
    const captured = referenceByName.get(repo.toLowerCase());
    if (!captured) {
      data[match[1]] = null;
      continue;
    }
    const value = {
      nameWithOwner: captured.canonical,
      visibility: captured.visibility,
      isArchived: captured.archived,
      isFork: captured.fork,
    };
    for (const connection of ["issues", "pullRequests"]) {
      const observed = captured[connection];
      value[connection] = observed
        ? {
            totalCount: observed.totalCount,
            nodes: structuredClone(observed.nodes.slice(0, 100)),
            pageInfo: structuredClone(observed.pageInfo),
          }
        : null;
      // Node fields remain exactly what was captured: number/updatedAt and,
      // for PRs, headRefOid. Missing labels/timelineItems are NOT synthesized.
    }
    data[match[1]] = value;
  }
  const body = { data };
  boundary.push({
    query,
    querySha256: hash(query),
    responseSha256: hash(JSON.stringify(body)),
    sourceSha256: hash(referenceBytes),
  });
  return body;
}
function countWitnesses() {
  const counts = new Map();
  for (let start = 0; start < repositories.length; start += 25) {
    const batch = repositories.slice(start, start + 25);
    const query =
      "query ReplayCountWitness { " +
      batch
        .map((repo, index) => {
          const [owner, name] = repo.targetRepo.split("/");
          return (
            "r" +
            index +
            ":repository(owner:" +
            JSON.stringify(owner) +
            ",name:" +
            JSON.stringify(name) +
            "){issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount}}"
          );
        })
        .join(" ") +
      " }";
    const response = responseFor(query);
    batch.forEach((repo, index) => {
      const node = response.data["r" + index],
        captured = referenceByName.get(repo.targetRepo.toLowerCase());
      if (!node?.issues || !node?.pullRequests) return;
      counts.set(repo.targetRepo, {
        issues: node.issues.totalCount,
        pullRequests: node.pullRequests.totalCount,
        observedAt: captured.metadataObservedAt,
        ...(captured.reason === "count_or_identity_drift"
          ? { qualification: "identity_scan_drifted" }
          : {}),
      });
    });
  }
  return counts;
}
const baseSource = join(scratch, "base");
mkdirSync(baseSource, { recursive: true });
const reuseBaseline = process.argv.includes("--reuse-baseline-build");
if (reuseBaseline) {
  const prior = JSON.parse(readFileSync(join(output, "receipt.json"), "utf8"));
  assert.equal(prior.sourceBase, base);
  assert.equal(
    hash(readFileSync(join(baseSource, "dist/repair/target-fanout.js"))),
    prior.compiledBaselineProducer,
  );
  assert.equal(
    hash(readFileSync(join(baseSource, "src/repair/target-fanout.ts"))),
    hash(execFileSync("git", ["show", base + ":src/repair/target-fanout.ts"], { cwd: root })),
  );
} else {
  execFileSync("tar", ["-x", "-C", baseSource], {
    input: execFileSync(
      "git",
      [
        "archive",
        base,
        "src",
        "dashboard",
        "config",
        "package.json",
        "tsconfig.repair.json",
        "dashboard-site",
      ],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    ),
  });
  execFileSync(
    join(root, "node_modules/.bin/tsc"),
    ["-p", join(baseSource, "tsconfig.repair.json")],
    { cwd: baseSource, stdio: "pipe", timeout: 120000 },
  );
}
const baseProducer = await import(
  pathToFileURL(join(baseSource, "dist/repair/target-fanout.js")).href
);
const baseWorker = await import(pathToFileURL(join(baseSource, "dashboard/worker.ts")).href);
const secret = "synthetic-same-input-local-replay";
function localRuntime(module, Queue, unavailableCanonical = false) {
  const storage = new TestStorage();
  const queue = new Queue({ storage }, {});
  const requests = [];
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (request) => {
          requests.push({ method: request.method, path: new URL(request.url).pathname });
          return queue.fetch(request);
        },
      }),
    },
  };
  const fetchImpl = (url, init) => module.fetch(new Request(String(url), init), env);
  return { storage, queue, requests, fetchImpl, unavailableCanonical };
}
let browser, context, server;
try {
  const baselineCounts = countWitnesses(),
    candidateCounts = countWitnesses();
  assert.deepEqual(candidateCounts, baselineCounts);
  const baselineInventory = baseProducer.reviewCoverageInventorySnapshot(
    repositories,
    baselineCounts,
    sourceNow,
  );
  const candidateInventory = candidateProducer.loadReviewCoverageInventory(
    repositories,
    candidateCounts,
    sourceNow,
    responseFor,
  );
  const baseline = localRuntime(baseWorker.default, baseWorker.ExactReviewQueue);
  const candidate = localRuntime(candidateWorker, ExactReviewQueue, true);
  await baseProducer.publishReviewCoverageInventory({
    baseUrl: "https://local.invalid",
    webhookSecret: secret,
    snapshot: baselineInventory,
    fetchImpl: baseline.fetchImpl,
    attempts: 1,
  });
  await candidateProducer.publishReviewCoverageInventory({
    baseUrl: "https://local.invalid",
    webhookSecret: secret,
    snapshot: candidateInventory,
    fetchImpl: candidate.fetchImpl,
    attempts: 1,
  });
  // Canonical rows/bodies were NOT captured. Refuse that dependency rather than
  // misrepresent an empty fixture DB as proof every real live item is unreviewed.
  candidate.storage.failNextSqlMatching(/SELECT MIN\(repo_slug\)/);
  const response = await candidate.fetchImpl("https://local.invalid/api/review-coverage");
  assert.equal(response.status, 200, await response.clone().text());
  const candidateCoverage = await response.json();
  assert.equal(candidateCoverage.fleets.find((row) => row.repo === "openclaw/ocm").open_records, 7);
  assert.equal(
    candidateCoverage.fleets.find((row) => row.repo === "steipete/codexbar").open_records,
    98,
  );
  assert.equal(
    candidateCoverage.fleets.find((row) => row.repo === "openclaw/openclaw").open_records,
    7738,
  );
  assert.equal(candidateCoverage.totals.coverage_percent, null);
  assert.equal(
    candidateCoverage.totals.untracked_open,
    null,
    "missing canonical evidence is not observed absence",
  );
  assert.equal(candidateCoverage.record_scan_observed_at, null);
  for (const row of candidateCoverage.fleets.filter(
    (row) => row.open_records > 0 && ["eligible", "observed"].includes(row.observation_scope),
  ))
    assert.ok(
      row.missing_fields.includes("labels") && row.missing_fields.includes("latest_reopen"),
    );
  writeFileSync(
    join(output, "baseline-producer-inventory.json"),
    JSON.stringify(baselineInventory, null, 2),
  );
  writeFileSync(
    join(output, "candidate-producer-inventory.json"),
    JSON.stringify(candidateInventory, null, 2),
  );
  writeFileSync(
    join(output, "candidate-public-api.json"),
    JSON.stringify(candidateCoverage, null, 2),
  );
  writeFileSync(join(output, "replayed-github-boundary.json"), JSON.stringify(boundary, null, 2));
  const cache = join(process.env.HOME, ".cache/ms-playwright");
  const executable =
    process.env.COVERAGE_PROOF_CHROMIUM ??
    readdirSync(cache)
      .filter((name) => name.startsWith("chromium-"))
      .sort()
      .reverse()
      .map((name) => join(cache, name, "chrome-linux64/chrome"))
      .find(existsSync);
  browser = await chromium.launch({ headless: true, executablePath: executable });
  context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent(repoBytes.toString());
  const history = await page
    .locator("table")
    .first()
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        repo: row.querySelector("a")?.textContent.trim(),
        slug: row.querySelector("a")?.getAttribute("href")?.split("/").filter(Boolean).at(-1),
        cells: [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim()),
      })),
    );
  await page.setContent(htmlBytes.toString());
  const stale = await page
    .locator("table")
    .nth(1)
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        url: row.querySelector("a")?.getAttribute("href"),
        title: row.querySelector(".item-title")?.textContent.trim(),
        reviewedAt: row.querySelector("time")?.getAttribute("datetime") ?? null,
      })),
    );
  const number = (value) => Number(String(value).replaceAll(",", ""));
  const common = JSON.parse(
    readFileSync(join(root, "dashboard-site/fixtures/dashboard.json"), "utf8"),
  );
  const oldReceipt = JSON.parse(readFileSync(join(previous, "comparison-receipt.json"), "utf8"));
  common.generatedAt = oldReceipt.builtAt;
  common.corpus.generatedAt = oldReceipt.corpusAt;
  const queueAt = oldReceipt.sourceTimes?.find((row) => row.label.startsWith("Queue:"))?.iso;
  if (queueAt) common.queue.generated_at = queueAt;
  const actionsAt = oldReceipt.sourceTimes?.find((row) =>
    row.label.startsWith("Workflow runs through:"),
  )?.iso;
  if (actionsAt) common.actions.windowEnd = actionsAt;
  common.corpus.repos = history.map((row) => ({
    repo: row.repo,
    slug: row.slug,
    records: number(row.cells[1]),
    open: number(row.cells[2]),
    staleOpen: number(row.cells[3]),
    reviewed7d: number(row.cells[4]),
    reviewed30d: number(row.cells[5]),
    typed: null,
    archived: null,
    missingTyped: null,
    decisions: {},
  }));
  common.corpus.totals = {
    ...common.corpus.totals,
    repositories: history.length,
    records: common.corpus.repos.reduce((sum, row) => sum + row.records, 0),
    open: common.corpus.repos.reduce((sum, row) => sum + row.open, 0),
  };
  common.corpus.lists.stale = stale.map((row) => {
    const match = row.url?.match(/^https:\/\/github.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)/);
    assert.ok(match);
    return {
      ...row,
      repo: match[1],
      number: Number(match[3]),
      kind: match[2] === "pull" ? "pull_request" : "issue",
      createdAt: null,
      decision: null,
      closeReason: null,
      proof: null,
      security: null,
      maintainerKind: null,
    };
  });
  common.repositoryStates = Object.fromEntries(
    repositories
      .filter((repo) => !["observed", "eligible"].includes(repo.coverageScope))
      .map((repo) => [
        repo.targetRepo.toLowerCase(),
        repo.coverageScope + " — captured metadata, outside qualified review scope",
      ]),
  );
  const site = join(root, "dashboard-site"),
    baseSite = join(baseSource, "dashboard-site"),
    deps = join(site, "node_modules");
  if (!existsSync(join(baseSite, "node_modules")))
    symlinkSync(deps, join(baseSite, "node_modules"), "dir");
  const astroPackage = JSON.parse(readFileSync(join(deps, "astro/package.json"), "utf8")),
    astroBin = resolve(deps, "astro", astroPackage.bin.astro);
  const originalData = existsSync(join(site, "src/data/dashboard.json"))
    ? readFileSync(join(site, "src/data/dashboard.json"))
    : null;
  function build(name, directory, coverage) {
    mkdirSync(join(directory, "src/data"), { recursive: true });
    const snapshot = { ...common, coverage };
    writeFileSync(join(directory, "src/data/dashboard.json"), JSON.stringify(snapshot));
    const run = spawnSync(process.execPath, [astroBin, "build"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 120000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ASTRO_TELEMETRY_DISABLED: "1" },
    });
    writeFileSync(join(output, name + "-build.log"), run.stdout + run.stderr);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    cpSync(join(directory, "dist"), join(output, name + "-site"), { recursive: true });
    return hash(JSON.stringify(snapshot));
  }
  let baselineInput, candidateInput;
  try {
    baselineInput = build("baseline", baseSite, legacyCoverage);
    candidateInput = build("candidate", site, candidateCoverage);
  } finally {
    if (originalData) writeFileSync(join(site, "src/data/dashboard.json"), originalData);
  }
  let active = join(output, "baseline-site");
  server = createServer((request, res) => {
    let path = join(active, new URL(request.url, "http://localhost").pathname);
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) {
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
        ".png": "image/png",
        ".woff2": "font/woff2",
      }[extname(path)] ?? "application/octet-stream",
    );
    res.end(readFileSync(path));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  await page.unroute("**/*");
  const browserRequests = [];
  await page.route("**/*", (route) => {
    browserRequests.push({ url: route.request().url(), method: route.request().method() });
    return route.request().url().startsWith(origin) && route.request().method() === "GET"
      ? route.continue()
      : route.abort();
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const visible = {};
  for (const name of ["baseline", "candidate"]) {
    active = join(output, name + "-site");
    await page.goto(origin + "/coverage/", { waitUntil: "networkidle" });
    visible[name] = {
      text: await page.locator("body").innerText(),
      kpis: await page
        .locator("main .card")
        .evaluateAll((cards) => cards.slice(0, 4).map((card) => card.innerText)),
    };
    writeFileSync(join(output, name + "-visible.txt"), visible[name].text);
    await page.screenshot({ path: join(output, name + ".png"), fullPage: true });
    if (name === "candidate") {
      assert.equal(await page.locator("[data-coverage-repo]").count(), 137);
      assert.equal(
        await page.locator('[data-coverage-repo="openclaw/ocm"] td').nth(1).innerText(),
        "7",
      );
      assert.equal(
        await page.locator('[data-coverage-repo="steipete/codexbar"] td').nth(1).innerText(),
        "98",
      );
      assert.match(visible[name].text, /Missing fields: labels, latest_reopen/);
      assert.match(visible[name].text, /Identity reference drifted/);
    }
    await page.locator('[class*="max-h-"]').evaluateAll((nodes) =>
      nodes.forEach((node) => {
        node.style.maxHeight = "none";
        node.style.overflow = "visible";
      }),
    );
    await page.screenshot({ path: join(output, name + "-all-rows.png"), fullPage: true });
  }
  await context.tracing.stop({ path: join(output, "browser-trace.zip") });
  const matrix = countRows.map((row) => {
    const observed = candidateCoverage.fleets.find(
      (value) => value.repo === row.repo.toLowerCase(),
    );
    return {
      repo: row.repo,
      beforeStoredOpen: number(row.cells[1]),
      beforeStoredStale: number(row.cells[2]),
      beforeStoredFresh: row.cells[3],
      afterObservedOpen: observed?.open_records ?? null,
      countObservedAt: observed?.counts_observed_at ?? null,
      countQualification: observed?.counts_qualification ?? null,
      scope: observed?.observation_scope ?? "withheld",
      identityStatus: observed?.census_status ?? "unknown",
      missingFields: observed?.missing_fields ?? [],
      reviewedRecent: observed?.reviewed_recent ?? null,
      markedStale: observed?.stale ?? null,
      expired: observed?.expired ?? null,
      fresh: observed?.coverage_percent ?? null,
    };
  });
  writeFileSync(join(output, "all-137.json"), JSON.stringify(matrix, null, 2));
  const keys = Object.keys(matrix[0]);
  writeFileSync(
    join(output, "all-137.csv"),
    [
      keys,
      ...matrix.map((row) =>
        keys.map((key) =>
          row[key] === null ? "Unknown" : Array.isArray(row[key]) ? row[key].join(";") : row[key],
        ),
      ),
    ]
      .map((row) => row.map((value) => '"' + String(value).replaceAll('"', '""') + '"').join(","))
      .join("\n") + "\n",
  );
  const packageSources = [
    "src/repair/target-fanout.ts",
    "dashboard/exact-review-direct-publication.ts",
    "dashboard/exact-review-queue.ts",
    "dashboard/public-live-coverage.ts",
    "dashboard-site/src/lib/live-coverage.ts",
    "dashboard-site/src/pages/coverage.astro",
  ];
  const receipt = {
    ok: true,
    procedureSourceSha256: hash(readFileSync(import.meta.filename)),
    sourceBase: base,
    qualification: "supporting host; provider approval/runtime receipt separate",
    frozenBundle: {
      html: hash(htmlBytes),
      repositoryHtml: hash(repoBytes),
      legacyApi: hash(apiBytes),
      githubResponses: hash(referenceBytes),
      observedFrom: reference.startedAt,
      observedThrough: reference.completedAt,
    },
    sameBundleForBothVariants: true,
    baselineBuildReused: reuseBaseline,
    producerStages: {
      baseline: [
        "reviewCoverageInventorySnapshot",
        "publishReviewCoverageInventory (signed local Worker/DO intake)",
      ],
      candidate: [
        "loadReviewCoverageInventory (captured GitHub service)",
        "publishReviewCoverageInventory (signed local Worker/DO intake)",
        "public API projection",
        "actual Astro build and served browser",
      ],
    },
    sourceBinding: Object.fromEntries(
      packageSources.map((file) => [file, hash(readFileSync(join(root, file)))]),
    ),
    sharedFrozenCommonInputSha256: hash(JSON.stringify(common)),
    compiledBaselineProducer: hash(readFileSync(join(baseSource, "dist/repair/target-fanout.js"))),
    compiledCandidateProducer: hash(readFileSync(join(root, "dist/repair/target-fanout.js"))),
    baselineInput,
    candidateInput,
    requests: {
      baseline: baseline.requests,
      candidate: candidate.requests,
      browser: browserRequests,
    },
    allRows: matrix.length,
    fleetKpis: { baseline: legacyCoverage.totals, candidate: candidateCoverage.totals },
    visibleKpis: { baseline: visible.baseline.kpis, candidate: visible.candidate.kpis },
    missingEvidence: [
      "Frozen node responses omit labels and latest-reopen timeline fields",
      "Canonical individual rows/bodies were not captured; dependency refuses rather than fabricating absence/status",
      "Owner inventory admission, default branches, hasIssuesEnabled and App installation not captured; normal rows are observations, not qualified active repositories",
    ],
    baselineCategoryLimit:
      "Baseline UI uses the genuinely captured legacy public aggregate; canonical statuses are not reconstructed. Baseline signed count-producer intake is separately verified. Original deployed43.1% capture remains in legacy-only-preview; this rebuilt baseline uses captured API43.0% with its own timestamp.",
    forbiddenNetwork: forbidden,
  };
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  const lines = [
    "# Same-bundle post-producer UI comparison",
    "",
    "Both actual producer stages consume the SAME frozen public corpus, legacy aggregate and GitHub responses. No later live reads occur. The original legacy-only preview is preserved separately.",
    "",
    "Candidate observed Open is " +
      candidateCoverage.totals.open_records +
      "; Fresh/categories remain Unknown because labels/latest reopen and individual canonical evidence were not captured. Those absent fields are displayed, never synthesized. Explicit inactive/alias scopes stay outside fleet totals.",
    "",
    "| Repository | Baseline stored Open | Baseline stored Stale | Baseline Fresh | Candidate witnessed Open | Count as of | Scope | Review evidence |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- | --- |",
    ...matrix.map(
      (row) =>
        "| " +
        row.repo +
        " | " +
        row.beforeStoredOpen +
        " | " +
        row.beforeStoredStale +
        " | " +
        row.beforeStoredFresh +
        " | " +
        (row.afterObservedOpen ?? "Unknown") +
        " | " +
        row.countObservedAt +
        " | " +
        row.scope +
        (row.countQualification ? "; identity drifted" : "") +
        " | Unknown; missing " +
        row.missingFields.join(", ") +
        " |",
    ),
    "",
    receipt.baselineCategoryLimit,
    "",
    ...receipt.missingEvidence.map((reason) => "- " + reason),
  ];
  writeFileSync(join(output, "comparison.md"), lines.join("\n") + "\n");
  console.log(
    JSON.stringify(
      {
        ok: true,
        rows: matrix.length,
        observedOpen: candidateCoverage.totals.open_records,
        ocm: matrix.find((row) => row.repo === "openclaw/ocm"),
        codexbar: matrix.find((row) => row.repo === "steipete/codexbar"),
        artifact: join(output, "receipt.json"),
      },
      null,
      2,
    ),
  );
} finally {
  globalThis.fetch = savedFetch;
  if (context) await context.close();
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
