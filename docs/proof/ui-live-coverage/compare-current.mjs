// Read-only, frozen-input live-surface comparison. This is NOT synthetic bucket
// proof and does not claim production is fixed before the new producer runs.
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
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
const root = resolve(import.meta.dirname, "../../..");
const source = join(root, ".openclaw/tmp/ui-live-coverage/current-snapshot");
const output = join(root, ".artifacts/ui-live-coverage/current-comparison");
mkdirSync(output, { recursive: true });
const publicOrigin = "https://clawsweeper.openclaw.ai";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cache = join(process.env.HOME, ".cache/ms-playwright");
const executable =
  process.env.COVERAGE_PROOF_CHROMIUM ??
  readdirSync(cache)
    .filter((name) => name.startsWith("chromium-"))
    .sort()
    .reverse()
    .map((name) => join(cache, name, "chrome-linux64/chrome"))
    .find(existsSync);
const browser = await chromium.launch({ headless: true, executablePath: executable });
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await context.newPage();
let server;
try {
  const html = readFileSync(join(source, "coverage-.html"), "utf8");
  const repoHtml = readFileSync(join(source, "repos-.html"), "utf8");
  const coverage = JSON.parse(readFileSync(join(source, "api-review-coverage.json"), "utf8"));
  // Parse the frozen DOM without allowing any requests or scripts.
  await page.route("**/*", (route) => route.abort());
  await page.setContent(repoHtml);
  const histories = await page
    .locator("table")
    .first()
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        repo: row.querySelector("a")?.textContent?.trim(),
        slug: row.querySelector("a")?.getAttribute("href")?.split("/").filter(Boolean).at(-1),
        cells: [...row.querySelectorAll("td")].map((td) => td.textContent.trim()),
      })),
    );
  await page.setContent(html);
  const baseline = await page
    .locator("table")
    .first()
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        repo: row.querySelector("a")?.textContent?.trim(),
        cells: [...row.querySelectorAll("td")].map((td) => td.textContent.trim()),
      })),
    );
  assert.equal(baseline.length, 137);
  const baselineKpis = await page.locator("main .card").evaluateAll((cards) =>
    cards.slice(0, 4).map((card) => ({
      label: card.children[0]?.textContent.trim(),
      value: card.querySelector("span.num")?.textContent.trim(),
      text: card.innerText,
    })),
  );
  const baselineSegments = await page
    .locator(".card")
    .filter({ hasText: "Reviewable backlog" })
    .locator("li")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        label: [...(row.querySelector("span.text-fg-muted")?.childNodes ?? [])]
          .filter((node) => node.nodeType === 3)
          .map((node) => node.textContent)
          .join("")
          .trim(),
        value: row.querySelector("span.num.font-medium")?.textContent.trim(),
        text: row.innerText,
      })),
    );
  const baselineText = await page.locator("body").innerText();
  const sourceTimes = await page.locator(".snapshot-freshness time").evaluateAll((nodes) =>
    nodes.map((node) => ({
      label: node.parentElement.textContent.trim(),
      iso: node.getAttribute("datetime"),
    })),
  );
  const builtAt = await page.locator("#stale").getAttribute("data-built");
  const corpusAt = await page.locator("#stale").getAttribute("data-corpus");
  const canonicalScanLabel = html.match(/data-tip="Coverage snapshot ([^"]+)"/)?.[1] ?? "Unknown";
  writeFileSync(join(output, "baseline-visible.txt"), baselineText);
  writeFileSync(join(output, "baseline-table.json"), JSON.stringify(baseline, null, 2));
  let reference;
  const referencePath = join(output, "github-reference.json");
  if (existsSync(referencePath)) reference = JSON.parse(readFileSync(referencePath, "utf8"));
  else {
    const startedAt = new Date().toISOString();
    const repositories = [];
    const queries = [];
    let requests = 0;
    const query = (fields) => {
      assert.ok(++requests <= 120, "Read-only reference request budget exhausted");
      const q = "query UiCoverageReference { " + fields + " }";
      assert.doesNotMatch(q, /mutation|createComment|requestReview/);
      const started = new Date().toISOString();
      const result = JSON.parse(
        execFileSync("gh", ["api", "graphql", "-f", "query=" + q], {
          cwd: root,
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 16 * 1024 * 1024,
        }),
      );
      queries.push({
        startedAt: started,
        completedAt: new Date().toISOString(),
        querySha256: hash(q),
        errors: result.errors ?? null,
      });
      return result;
    };
    const connection = (name, cursor = null) =>
      name +
      "(states:OPEN,first:100,after:" +
      JSON.stringify(cursor) +
      "){totalCount nodes{number updatedAt " +
      (name === "pullRequests" ? "headRefOid " : "") +
      "} pageInfo{hasNextPage endCursor}}";
    const names = baseline.map((row) => row.repo);
    for (let start = 0; start < names.length; start += 25) {
      const batch = names.slice(start, start + 25);
      const result = query(
        batch
          .map((repo, i) => {
            const [owner, name] = repo.split("/");
            return (
              "r" +
              i +
              ":repository(owner:" +
              JSON.stringify(owner) +
              ",name:" +
              JSON.stringify(name) +
              "){nameWithOwner visibility isArchived isFork " +
              connection("issues") +
              " " +
              connection("pullRequests") +
              "}"
            );
          })
          .join(" "),
      );
      batch.forEach((repo, i) => {
        const row = result.data?.["r" + i];
        repositories.push({
          repo,
          metadataObservedAt: queries.at(-1).completedAt,
          canonical: row?.nameWithOwner ?? null,
          visibility: row?.visibility ?? null,
          archived: row?.isArchived ?? null,
          fork: row?.isFork ?? null,
          reason: row ? null : "missing_or_inaccessible",
          issues: row?.issues ?? null,
          pullRequests: row?.pullRequests ?? null,
        });
      });
    }
    // Complete each connection serially; no concurrency/rate setting is changed.
    for (const repo of repositories)
      for (const name of ["issues", "pullRequests"]) {
        const first = repo[name];
        if (!first) continue;
        const seen = new Set(first.nodes.map((row) => row.number));
        let cursor = first.pageInfo.endCursor;
        let more = first.pageInfo.hasNextPage;
        let pages = 1;
        let complete = true;
        while (more) {
          if (pages >= 100 || requests >= 120) {
            repo.reason = "bounded_identity_reference";
            complete = false;
            break;
          }
          const [owner, project] = repo.repo.split("/");
          const result = query(
            "repository(owner:" +
              JSON.stringify(owner) +
              ",name:" +
              JSON.stringify(project) +
              "){" +
              connection(name, cursor) +
              "}",
          );
          const next = result.data?.repository?.[name];
          if (
            !next ||
            next.totalCount !== first.totalCount ||
            !Array.isArray(next.nodes) ||
            next.nodes.some((row) => seen.has(row.number)) ||
            (next.pageInfo.hasNextPage &&
              (!next.pageInfo.endCursor || next.pageInfo.endCursor === cursor))
          ) {
            repo.reason = "count_or_identity_drift";
            complete = false;
            break;
          }
          next.nodes.forEach((row) => seen.add(row.number));
          first.nodes.push(...next.nodes);
          pages++;
          cursor = next.pageInfo.endCursor;
          more = next.pageInfo.hasNextPage;
        }
        first.complete = complete && !more && first.nodes.length === first.totalCount;
        first.pages = pages;
        first.observedThrough = queries.at(-1).completedAt;
        if (!first.complete && !repo.reason) repo.reason = "incomplete_identity_reference";
      }
    reference = {
      startedAt,
      completedAt: new Date().toISOString(),
      transport: "managed gh GraphQL read route; backend delegation recorded in execution log",
      requestLimit: 120,
      requests,
      queries,
      repositories,
    };
    writeFileSync(referencePath, JSON.stringify(reference, null, 2));
  }
  const number = (text) => Number(String(text).replaceAll(",", ""));
  const snapshot = JSON.parse(
    readFileSync(join(root, "dashboard-site/fixtures/dashboard.json"), "utf8"),
  );
  // The later public API receipt is an independent observation, NOT the
  // baseline page input. Freeze exact visible DOM category values for replay.
  const visibleCategory = (label) => {
    const row = baselineSegments.find((row) => row.label === label);
    return row ? Number(row.value.replaceAll(",", "")) : null;
  };
  const visibleCoverage = baselineKpis.find((row) => row.label === "Coverage");
  const denominator = visibleCoverage?.text.match(/([0-9,]+) of ([0-9,]+)/);
  assert.ok(denominator, "Frozen baseline KPI denominator must be extracted, not guessed");
  for (const label of ["Reviewed recently", "Stale", "Expired", "Failed", "Never reviewed"])
    assert.notEqual(visibleCategory(label), null, "Missing frozen category: " + label);
  const frozenCoverage = {
    ok: true,
    generated_at: null,
    inventory_generated_at: null,
    inventory_status: "missing",
    window_days: 7,
    totals: {
      reviewable_records: denominator ? Number(denominator[2].replaceAll(",", "")) : null,
      reviewed_recent: visibleCategory("Reviewed recently"),
      stale: visibleCategory("Stale"),
      expired: visibleCategory("Expired"),
      failed: visibleCategory("Failed"),
      never_reviewed_combined: visibleCategory("Never reviewed"),
      coverage_percent: visibleCoverage ? Number(visibleCoverage.value.replace("%", "")) : null,
    },
  };
  snapshot.coverage = frozenCoverage;
  snapshot.generatedAt = builtAt;
  snapshot.corpus.generatedAt = corpusAt;
  const queueAt = sourceTimes.find((row) => row.label.startsWith("Queue:"))?.iso;
  if (queueAt) snapshot.queue.generated_at = queueAt;
  const actionsAt = sourceTimes.find((row) => row.label.startsWith("Workflow runs through:"))?.iso;
  if (actionsAt) snapshot.actions.windowEnd = actionsAt;
  reference.transport =
    "managed gh read; wrapper reported personal-token GraphQL delegation (no token exposed)";
  writeFileSync(referencePath, JSON.stringify(reference, null, 2));
  writeFileSync(join(output, "frozen-visible-input.json"), JSON.stringify(frozenCoverage, null, 2));
  // Later independent metadata is reference evidence only, not replay input.
  snapshot.repositoryStates = {};
  snapshot.corpus.totals = {
    ...snapshot.corpus.totals,
    repositories: histories.length,
    records: histories.reduce((sum, row) => sum + number(row.cells[1]), 0),
    open: histories.reduce((sum, row) => sum + number(row.cells[2]), 0),
  };
  // No canonical review evidence is invented: these are exact stored-history
  // cells from the frozen current /repos page, not inferred live categories.
  const visibleHistories = histories; // All were public in the frozen built /repos snapshot.
  snapshot.corpus.repos = visibleHistories.map((row) => ({
    repo: row.repo,
    slug: row.slug,
    records: number(row.cells[1]),
    typed: null,
    open: number(row.cells[2]),
    archived: null,
    staleOpen: number(row.cells[3]),
    reviewed7d: number(row.cells[4]),
    reviewed30d: number(row.cells[5]),
    missingTyped: null,
    decisions: {},
  }));
  const corpusStamp = baselineText.match(/Reviews ([^\n]+)/)?.[1] ?? null;
  const snapshotStamp = baselineText.match(/Snapshot ([^\n]+)/)?.[1] ?? null;
  const table = baseline.map((row) => {
    const repo = reference.repositories.find((entry) => entry.repo === row.repo);
    const complete = !!repo?.issues?.complete && !!repo?.pullRequests?.complete;
    return {
      repo: row.repo,
      baselineStoredOpen: number(row.cells[1]),
      baselineStoredStale: number(row.cells[2]),
      baselineStoredFresh: row.cells[3],
      reviewed7d: number(row.cells[4]),
      reviewed30d: number(row.cells[5]),
      candidateLiveOpen: null,
      candidateFresh: null,
      candidateMarkedStale: null,
      candidateExpired: null,
      candidateReason:
        "Frozen current producer is legacy aggregate-only; matching canonical review identities unavailable. New producer has not run.",
      githubReportedOpen:
        repo?.issues && repo?.pullRequests
          ? repo.issues.totalCount + repo.pullRequests.totalCount
          : null,
      githubEnumeratedIdentities:
        (repo?.issues?.nodes.length ?? 0) + (repo?.pullRequests?.nodes.length ?? 0),
      githubIdentityCensusComplete: complete,
      githubReferenceReason: repo?.reason ?? null,
      archived: repo?.archived ?? null,
      fork: repo?.fork ?? null,
      canonical: repo?.canonical ?? null,
    };
  });
  writeFileSync(join(output, "all-repositories.json"), JSON.stringify(table, null, 2));
  const keys = Object.keys(table[0]);
  writeFileSync(
    join(output, "all-repositories.csv"),
    [keys, ...table.map((row) => keys.map((key) => row[key] ?? "Unknown"))]
      .map((row) => row.map((value) => '"' + String(value).replaceAll('"', '""') + '"').join(","))
      .join("\n") + "\n",
  );
  // Preserve every displayed KPI/category from the frozen Worker aggregate.
  const categories = {
    baselineVisibleCategories: baselineSegments,
    baselineVisibleInput: frozenCoverage.totals,
    independentlyFetchedApi: coverage.totals,
    candidate: Object.fromEntries(
      [
        "open_records",
        "reviewable_records",
        "reviewed_recent",
        "stale",
        "failed",
        "expired",
        "unreviewed_records",
        "untracked_open",
        "pending",
        "excluded",
        "coverage_percent",
      ].map((key) => [key, null]),
    ),
    reason:
      "No current canonical identity join is publicly available; numeric categories would be fabricated. Controlled fixture proof is separate.",
  };
  writeFileSync(
    join(output, "page-wide-kpis-categories.json"),
    JSON.stringify(
      {
        baselineVisibleKpis: baselineKpis,
        sourceTimes,
        builtAt,
        corpusAt,
        corpusStamp,
        snapshotStamp,
        baselineCanonicalScanAt: canonicalScanLabel,
        baselineCanonicalScanPrecision: "Visible minute precision; full ISO not published",
        baselineCensusAt: "Not shown by baseline UI; unknown",
        independentApiScanAt: coverage.generated_at,
        independentApiCensusAt: coverage.inventory_generated_at,
        ...categories,
      },
      null,
      2,
    ),
  );
  // Serve captured baseline HTML and downloaded public static assets locally.
  const baselineSite = join(output, "baseline-site");
  mkdirSync(join(baselineSite, "coverage"), { recursive: true });
  writeFileSync(join(baselineSite, "coverage/index.html"), html);
  for (const path of [
    ...new Set(
      [...html.matchAll(/(?:href|src)="(\/[^"?#]+)"/g)]
        .map((match) => match[1])
        .filter((path) => path.startsWith("/_astro/") || /\.(png|ico|svg|woff2)$/.test(path)),
    ),
  ]) {
    const target = join(baselineSite, path);
    if (existsSync(target)) continue;
    const response = await fetch(publicOrigin + path);
    assert.equal(response.status, 200);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, new Uint8Array(await response.arrayBuffer()));
  }
  const site = join(root, "dashboard-site");
  const data = join(site, "src/data/dashboard.json");
  const oldData = existsSync(data) ? readFileSync(data) : null;
  mkdirSync(dirname(data), { recursive: true });
  try {
    writeFileSync(data, JSON.stringify(snapshot));
    const result = spawnSync("pnpm", ["--ignore-workspace", "run", "build"], {
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
    writeFileSync(join(output, "candidate-build.log"), result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    cpSync(join(site, "dist"), join(output, "candidate-site"), { recursive: true });
  } finally {
    if (oldData) writeFileSync(data, oldData);
  }
  let active = baselineSite;
  server = createServer((req, res) => {
    let path = join(active, new URL(req.url, "http://localhost").pathname);
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
  const local = "http://127.0.0.1:" + server.address().port;
  await page.unroute("**/*");
  const requests = [];
  await page.route("**/*", (route) => {
    requests.push({ url: route.request().url(), method: route.request().method() });
    return route.request().url().startsWith(local) && route.request().method() === "GET"
      ? route.continue()
      : route.abort();
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  for (const name of ["baseline", "candidate"]) {
    active = join(output, name + "-site");
    await page.goto(local + "/coverage/", { waitUntil: "networkidle" });
    await page.screenshot({ path: join(output, name + "-current-frozen.png"), fullPage: true });
    writeFileSync(join(output, name + "-visible.txt"), await page.locator("body").innerText());
    if (name === "baseline")
      assert.equal(await page.locator("table").first().locator("tbody tr").count(), 137);
    else {
      assert.match(await page.locator("body").innerText(), /Coverage unknown/);
      assert.equal(
        await page.locator("table").last().locator("tbody tr").count(),
        visibleHistories.length,
      );
    }
    // Expand only view-only scroll containers for an additional all-row capture.
    // Numeric DOM values are never changed. Standard viewport capture stays above.
    await page.locator('[class*="max-h-"]').evaluateAll((nodes) =>
      nodes.forEach((node) => {
        node.style.maxHeight = "none";
        node.style.overflow = "visible";
      }),
    );
    await page
      .locator(".snapshot-freshness")
      .evaluateAll((nodes) => nodes.forEach((node) => (node.open = true)));
    await page.screenshot({ path: join(output, name + "-all-rows.png"), fullPage: true });
  }
  await context.tracing.stop({ path: join(output, "current-comparison-browser-trace.zip") });
  const receipt = {
    capturedAt: new Date().toISOString(),
    inputFrozenAt: readFileSync(
      join(root, ".openclaw/tmp/ui-live-coverage/current-fetch.log"),
      "utf8",
    ),
    baselineHtmlSha256: hash(html),
    repoHtmlSha256: hash(repoHtml),
    legacyCoverageSha256: hash(JSON.stringify(coverage)),
    referenceSha256: hash(JSON.stringify(reference)),
    allDisplayedRepositories: table.length,
    frozenHistoryRepositories: histories.length,
    replayUsesIndependentGithubReference: false,
    canonicalScanLabel,
    identityReferencesComplete: table.filter((row) => row.githubIdentityCensusComplete).length,
    identityReferenceIssues: table.filter((row) => !row.githubIdentityCensusComplete),
    pageWide: categories,
    baselineVisibleKpis: baselineKpis,
    sourceTimes,
    builtAt,
    corpusAt,
    corpusStamp,
    snapshotStamp,
    referenceStartedAt: reference.startedAt,
    referenceCompletedAt: reference.completedAt,
    actualCandidateMeaning:
      "Data-availability preview on identical frozen legacy inputs, NOT proof production counts are corrected. Exact numeric live buckets require the new census producer plus canonical identity evidence; no production mutation was authorized.",
    controlledFixtureProof: "../receipt.json",
    containment: "supporting host only; required local-container proof blocked",
    browserRequests: requests,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  };
  writeFileSync(join(output, "comparison-receipt.json"), JSON.stringify(receipt, null, 2));
  const lines = [
    "# Frozen current Coverage comparison",
    "",
    "Frozen public UI fetched 2026-11-02 21:52 UTC. Build: " +
      builtAt +
      "; corpus: " +
      corpusAt +
      "; visible canonical scan: " +
      canonicalScanLabel +
      ". Baseline census timestamp is not displayed and remains unknown.",
    "",
    "Independent GitHub identity reads: " +
      reference.startedAt +
      " through " +
      reference.completedAt +
      ". " +
      receipt.identityReferencesComplete +
      "/137 complete identity references; OpenClaw and Enterprise drifted during pagination. Those counts are explicitly reported observations, not complete censuses.",
    "",
    "Candidate is an actual built UI data-availability preview on the SAME frozen inputs, not proof that production is corrected. Later API/GitHub observations do not feed candidate numbers. Matching canonical identity evidence is unavailable from the legacy producer, so live categories remain Unknown. Controlled numeric bucket proof is separate in ../receipt.json.",
    "",
    "## Page-wide visible KPIs",
    "",
    "| Baseline label | Baseline displayed | Candidate meaning |",
    "| --- | ---: | --- |",
    ...baselineKpis.map(
      (row) =>
        "| " +
        row.label +
        " | " +
        row.value +
        " | Unknown live evidence; stored history separate |",
    ),
    "",
    "## Visible category totals",
    "",
    "| Category | Baseline | Candidate |",
    "| --- | ---: | --- |",
    ...baselineSegments.map((row) => "| " + row.label + " | " + row.value + " | Unknown |"),
    "",
    "## All 137 displayed repository rows",
    "",
    "Independent identity counts are references, never invented review buckets. The candidate also displays all " +
      histories.length +
      " stored-history repository rows separately from live evidence.",
    "",
    "| Repository | Before stored Open | Before stored Stale | Before Fresh | Candidate live categories | GitHub reported Open | Enumerated IDs | Identity census |",
    "| --- | ---: | ---: | ---: | --- | ---: | ---: | --- |",
    ...table.map(
      (row) =>
        "| " +
        row.repo +
        " | " +
        row.baselineStoredOpen +
        " | " +
        row.baselineStoredStale +
        " | " +
        row.baselineStoredFresh +
        " | Unknown: legacy producer lacks canonical join | " +
        (row.githubReportedOpen ?? "Unknown") +
        " | " +
        row.githubEnumeratedIdentities +
        " | " +
        (row.githubIdentityCensusComplete ? "Complete" : (row.githubReferenceReason ?? "Unknown")) +
        " |",
    ),
    "",
    "Captures: baseline-current-frozen.png and candidate-current-frozen.png; additional *-all-rows.png captures expand only view-only scrolling containers (no numeric DOM changes). Current-comparison-browser-trace.zip retains the actual rendered path.",
    "",
  ];
  writeFileSync(join(output, "comparison.md"), lines.join("\n"));
  console.log(
    JSON.stringify(
      {
        ok: true,
        allDisplayedRepositories: table.length,
        completeIdentityReferences: receipt.identityReferencesComplete,
        requests: reference.requests,
        artifact: join(output, "comparison-receipt.json"),
        limits: receipt.actualCandidateMeaning,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
