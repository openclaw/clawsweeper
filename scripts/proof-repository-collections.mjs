// Controlled real-path proof: external APIs are fixtures, producer/build/page code is real.
// node scripts/proof-repository-collections.mjs <new-output-directory>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { chromium } from "playwright-core";

const root = process.cwd();
const base = "2e3e8fdebb537bb0580772afe23cbeb1c1cf39ac";
const out = resolve(process.argv[2] ?? ".artifacts/cs1/proof");
assert(!existsSync(out), "Use a fresh output directory; retained proof is never overwritten");
mkdirSync(out, { recursive: true });
const run = (command, args, cwd = root, extra = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extra },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  writeFileSync(
    join(out, `command-${run.sequence++}.log`),
    `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  assert.equal(
    result.status,
    0,
    `${command} failed: ${(result.stderr ?? result.error ?? result.stdout).toString().slice(-3000)}`,
  );
  return result.stdout.trim();
};
run.sequence = 0;
const records = join(out, "records");
const fixtureHashes = [];
for (const [repo, count] of [
  ["openclaw/openclaw", 600],
  ["openclaw/clawsweeper", 10],
  ["openclaw/clawhub", 1],
  ["fixture-private/not-published", 1],
  ["fixture-withdrawn/not-published", 1],
]) {
  for (const area of ["items", "closed"]) {
    if (repo === "openclaw/clawhub" && area === "closed") continue;
    const dir = join(records, repo.replace("/", "-"), area);
    mkdirSync(dir, { recursive: true });
    for (let n = 1; n <= count; n++) {
      const number = n + (area === "closed" ? 1000 : 0);
      const fresh = repo === "openclaw/clawhub";
      const reviewed = fresh
        ? "2026-10-29"
        : repo === "openclaw/openclaw"
          ? "2026-01-01"
          : "2026-02-01";
      const decision = {
        decision: area === "closed" ? "close" : "keep_open",
        closeReason: "inactive",
        triagePriority: "P1",
        maintainerDecision: { required: !fresh, kind: "manual_review" },
        securityReview: { status: fresh ? "clear" : "needs_attention" },
      };
      const text = [
        "---",
        `repository: ${repo}`,
        `number: ${number}`,
        "type: issue",
        `title: ${JSON.stringify(`${area === "items" ? "Review" : "Archived"} stored-corpus fixture ${n}${repo === "openclaw/clawsweeper" && n === 1 ? " — preserve the entire long repository item title alongside identity, historical assessment metadata and last-review freshness on a narrow screen without clipping" : ""}`)}`,
        `reviewed_at: ${reviewed}T00:00:00Z`,
        ...(area === "closed"
          ? [
              "action_taken: closed",
              `applied_at: ${repo === "openclaw/openclaw" ? "2026-10-29" : "2026-10-28"}T00:00:00Z`,
            ]
          : []),
        `review_record: ${JSON.stringify({ version: 1, decision })}`,
        "---",
        "",
      ].join("\n");
      writeFileSync(join(dir, `${number}.md`), text);
      fixtureHashes.push([
        `${repo}/${area}/${number}`,
        createHash("sha256").update(text).digest("hex"),
      ]);
    }
  }
}
writeFileSync(join(out, "fixture-hashes.json"), JSON.stringify(fixtureHashes));
const baseline = join(out, "baseline");
mkdirSync(baseline);
const archive = join(out, "baseline.tar");
run("git", [
  "archive",
  "--format=tar",
  `--output=${archive}`,
  base,
  "dashboard-site",
  "src/maintainer-review-policy.ts",
]);
run("tar", ["xf", archive, "-C", baseline]);
symlinkSync(
  join(root, "dashboard-site/node_modules"),
  join(baseline, "dashboard-site/node_modules"),
  "dir",
);
const preload = join(root, "scripts/proof-repository-collections-network.mjs");
const env = {
  GITHUB_TOKEN: "synthetic-fixture-only",
  BOOTSTRAP_GITHUB_TOKEN: "synthetic-fixture-only",
  CS1_PROOF_ROOT: root,
};
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};
const results = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const stage of [
    "before",
    "after",
    "legacy",
    "legacy-snapshot",
    "incomplete",
    "contradictory",
  ]) {
    const source = stage === "before" ? baseline : root;
    const state = join(out, `state-${stage}`);
    mkdirSync(state);
    run(
      process.execPath,
      [
        "--import",
        preload,
        "dashboard-site/scripts/build-corpus.ts",
        "--records",
        records,
        "--out",
        state,
      ],
      source,
      { ...env, CS1_PROOF_PHASE: "corpus" },
    );
    const cachePath = join(state, "corpus.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    assert(!JSON.stringify(cache).includes("fixture-private"));
    assert(JSON.stringify(cache).includes("fixture-withdrawn"));
    if (stage === "legacy") {
      delete cache.attentionOrder;
      for (const part of cache.repositories) delete part.collectionTotals;
    }
    if (stage === "incomplete" || stage === "contradictory") {
      const part = cache.repositories.find((part) => part.stats.repo === "openclaw/clawsweeper");
      part.lists = { stale: [], maintainer: [], security: [] };
      part.closes.recent = [];
      if (stage === "contradictory") part.collectionTotals.stale = 0;
    }
    // A future row extension stays opaque transport, not assessment classification.
    for (const part of cache.repositories)
      for (const rows of [...Object.values(part.lists), part.closes.recent])
        for (const row of rows)
          row.fixtureExtension = { version: 1, marker: "forwarded unchanged" };
    writeFileSync(cachePath, JSON.stringify(cache));
    run(
      process.execPath,
      ["--import", preload, "dashboard-site/scripts/build-data.ts", "--state", state],
      source,
      { ...env, CS1_PROOF_PHASE: "site" },
    );
    const dashboard = JSON.parse(
      readFileSync(join(source, "dashboard-site/src/data/dashboard.json"), "utf8"),
    );
    assert(!JSON.stringify(dashboard).includes("fixture-private"));
    assert(!JSON.stringify(dashboard).includes("fixture-withdrawn"));
    if (stage === "legacy-snapshot") {
      delete dashboard.corpus.repositoryCollections;
      writeFileSync(
        join(source, "dashboard-site/src/data/dashboard.json"),
        JSON.stringify(dashboard),
      );
    }
    const collections = dashboard.corpus.repositoryCollections?.["openclaw-clawsweeper"];
    for (const name of ["stale", "maintainer", "security", "closes"]) {
      const list =
        name === "closes" ? dashboard.corpus.recordedCloses.recent : dashboard.corpus.lists[name];
      assert.equal(list.length, 500);
      // Legacy caches deliberately retain the old newest-first attention order.
      if (stage !== "legacy") assert(list.every((row) => row.repo === "openclaw/openclaw"));
      if (stage === "after") {
        assert.equal(collections[name].total, 10);
        assert.equal(collections[name].items.length, 10);
        assert(
          collections[name].items.every(
            (row) => row.fixtureExtension?.marker === "forwarded unchanged",
          ),
        );
      }
    }
    run("pnpm", ["run", "build"], join(source, "dashboard-site"));
    const dist = join(source, "dashboard-site/dist");
    assert(!existsSync(join(dist, "repos/fixture-withdrawn-not-published/index.html")));
    const server = createServer((request, response) => {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const file = resolve(dist, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
      if (!file.startsWith(`${dist}/`) || !existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
      response.end(readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const viewport of [
      { width: 1440, height: 1100 },
      { width: 390, height: 1000 },
      { width: 320, height: 1000 },
    ]) {
      const context = await browser.newContext({
        viewport,
        hasTouch: viewport.width < 768,
        colorScheme: "dark",
        timezoneId: "UTC",
        locale: "en-US",
        reducedMotion: "reduce",
      });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage();
      const requests = [];
      const errors = [];
      page.on("request", (request) => requests.push(request.url()));
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      await page.clock.setFixedTime(new Date("2026-10-30T12:00:00Z"));
      try {
        await page.goto(`${origin}/repos/openclaw-clawsweeper/`);
        await page.evaluate(() => document.fonts.ready);
        const cards = page.locator("section.card").filter({ has: page.locator("h2") });
        const counts = {};
        for (const title of [
          "Stalest open items",
          "Needs a maintainer",
          "Security attention",
          "Recent closes",
        ]) {
          const card = cards.filter({
            has: page.getByRole("heading", { name: title, exact: true }),
          });
          counts[title] = await card.locator("tbody tr").count();
          assert.equal(counts[title], stage === "after" || stage === "legacy" ? 10 : 0);
          const text = await card.innerText();
          if (stage === "after") assert.match(text, /Showing 10 of 10 stored-corpus matches/);
          if (stage === "legacy" || stage === "legacy-snapshot") {
            assert.match(text, /Selection coverage is unknown/);
            assert(
              !/No stale open items|No maintainer flags|No security flags|No recorded closes/.test(
                text,
              ),
            );
          }
          if (stage === "incomplete" || stage === "contradictory") {
            assert.match(text, /10 stored-corpus matches recorded; rows are unavailable/);
            assert(
              !/No stale open items|No maintainer flags|No security flags|No recorded closes/.test(
                text,
              ),
            );
          }
        }
        if (stage === "before")
          assert.match(await page.locator("body").innerText(), /No stale open items/);
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          "no page-wide overflow",
        );
        const rowGeometry = [];
        if (stage === "after" || stage === "legacy") {
          for (const title of [
            "Stalest open items",
            "Needs a maintainer",
            "Security attention",
            "Recent closes",
          ]) {
            const card = cards.filter({
              has: page.getByRole("heading", { name: title, exact: true }),
            });
            const row = card.locator("tbody tr").first();
            await row.scrollIntoViewIfNeeded();
            const geometry = await row.evaluate((node) => {
              const title = node.querySelector(".item-title");
              const identity = node.querySelector(".item-identity");
              const assessment = node.querySelector(".item-assessment");
              const review = node.querySelector(".item-review");
              const box = title.getBoundingClientRect();
              return {
                titleWidth: box.width,
                titleFits: title.scrollWidth <= title.clientWidth + 1,
                identityFits: identity.scrollWidth <= identity.clientWidth + 1,
                assessment: assessment?.textContent ?? null,
                review: review?.textContent ?? null,
              };
            });
            assert(
              geometry.titleWidth >= 100 && geometry.titleFits && geometry.identityFits,
              JSON.stringify(geometry),
            );
            assert.match(geometry.review, /ago|Unknown/);
            if (title !== "Stalest open items") {
              assert(await row.locator(".item-assessment").isVisible());
              assert.match(geometry.assessment, /Manual review|Needs attention|Inactive/);
            }
            rowGeometry.push({ collection: title, ...geometry });
          }
        }
        await page.evaluate(() => scrollTo(0, 0));
        const freshness = page.locator(".snapshot-freshness summary");
        assert(await freshness.isVisible());
        assert.match(await freshness.innerText(), /Snapshot.*Reviews/);
        await freshness.click();
        assert(
          await page.locator(".snapshot-freshness").getByText("Workflow runs through:").isVisible(),
        );
        await freshness.click();
        if (stage === "before" || stage === "after")
          await page.screenshot({
            path: join(out, `${stage}-${viewport.width}.png`),
            animations: "disabled",
          });
        if ((stage === "before" || stage === "after") && viewport.width === 390) {
          const detail = cards.filter({
            has: page.getByRole("heading", { name: "Needs a maintainer", exact: true }),
          });
          await detail.evaluate((node) =>
            scrollTo(0, scrollY + node.getBoundingClientRect().top - 160),
          );
          await page.screenshot({
            path: join(out, `${stage}-390-detail.png`),
            animations: "disabled",
          });
        }
        const links = await page
          .locator("table a")
          .evaluateAll((elements) => elements.map((element) => element.href));
        assert(
          links.every((url) =>
            /^https:\/\/github\.com\/openclaw\/clawsweeper\/issues\/\d+$/.test(url),
          ),
        );
        if (stage === "after") {
          await page.goto(`${origin}/repos/openclaw-clawhub/`);
          assert.equal(await page.locator("tbody tr").count(), 0);
          assert.equal(await page.getByText(/No .* in the stored corpus\./).count(), 4);
          if (viewport.width === 1440)
            await page.screenshot({ path: join(out, "zero.png"), animations: "disabled" });
          await page.goto(`${origin}/repos/openclaw-clawsweeper/`);
          const search = page.locator("[data-cmd]:visible").first();
          await search.click();
          await page.locator("#cmd[open]").waitFor();
          await page.locator("#cmd-q").fill("clawsweeper");
          assert.equal(await page.locator("#cmd-list a").count(), 1);
          await page.keyboard.press("Escape");
          assert(await search.evaluate((node) => node === document.activeElement));
          if (viewport.width < 768) {
            await page.locator(".mobile-sections summary").click();
            const active = page.locator(".mobile-sections [aria-current=page]");
            assert(await active.isVisible());
            const box = await active.boundingBox();
            assert(box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.height >= 44);
            await page.locator(".mobile-sections a[href='/coverage/']").click();
            assert.match(await page.locator(".mobile-sections summary").innerText(), /Coverage/);
          }
          // Preserve the landed Coverage help flow and shared ordinary tooltip handling.
          await page.goto(`${origin}/coverage/`);
          assert.equal(await page.locator("[data-info-tip]").count(), 5);
          const help = page.getByRole("button", { name: "About Reviewed recently", exact: true });
          await help.focus();
          await page.locator("#tip.on").waitFor();
          assert.match(
            await page.locator("#tip").innerText(),
            /Reviewable items with a completed review/,
          );
          await page.keyboard.press("Escape");
          assert.equal(await page.locator("#tip.on").count(), 0);
          if (viewport.width < 768) await help.tap();
          else await help.click();
          await page.locator("#tip.on").waitFor();
          if (viewport.width < 768) await help.tap();
          else await help.click();
          assert.equal(await page.locator("#tip.on").count(), 0);
          await page.goto(`${origin}/repos/openclaw-clawsweeper/`);
          const ordinary = page.locator("section.card [data-tip]").first();
          if (viewport.width < 768) await ordinary.tap();
          else await ordinary.hover();
          await page.locator("#tip.on").waitFor();
          assert.match(await page.locator("#tip").innerText(), /Latest review decision/);
          // The landed operational evidence projection must survive data.ts composition.
          await page.goto(`${origin}/queue/`);
          const warning = page.locator("#warning-scanner_refused");
          await warning.locator("summary").click();
          assert.match(await warning.innerText(), /Showing 1 of 1 records/);
          assert.equal(
            await warning.locator("a").getAttribute("href"),
            "https://github.com/openclaw/clawsweeper/issues/1",
          );
          await page.goto(`${origin}/agent/`);
          assert.match(
            await page.locator("[data-claim-evidence]").innerText(),
            /No targets over the claim threshold/,
          );
        }
        assert(
          requests.every((url) => url.startsWith(origin)),
          "browser must not call GitHub or mutation endpoints",
        );
        assert.equal(errors.length, 0, errors.join("; "));
        results.push({
          stage,
          viewport,
          rowGeometry,
          tooltipCompatibility:
            stage === "after" ? "focus-escape-click-toggle-and-ordinary-hover passed" : null,
          counts,
          requests: requests.length,
          browserErrors: errors,
          collections: collections
            ? Object.fromEntries(
                Object.entries(collections).map(([key, value]) => [
                  key,
                  { total: value.total, rows: value.items.length, selection: value.selection },
                ]),
              )
            : null,
        });
      } finally {
        await context.tracing.stop({ path: join(out, `${stage}-${viewport.width}-trace.zip`) });
        await context.close();
      }
    }
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  await browser.close();
}
const sourceFiles = run("git", ["ls-files", "--cached", "--others", "--exclude-standard"])
  .split("\n")
  .filter((path) => existsSync(join(root, path)))
  .sort()
  .map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex"),
  ]);
writeFileSync(join(out, "source-hashes.json"), JSON.stringify(sourceFiles));
const report = {
  base,
  sourceSha256: createHash("sha256").update(JSON.stringify(sourceFiles)).digest("hex"),
  head: run("git", ["rev-parse", "HEAD"]),
  candidateDiffSha256: createHash("sha256")
    .update(run("git", ["diff", "HEAD", "--", "dashboard-site", "scripts", "test"]))
    .digest("hex"),
  node: process.version,
  chromium: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  fixtureSha256: createHash("sha256").update(JSON.stringify(fixtureHashes)).digest("hex"),
  viewports: [
    { width: 1440, height: 1100 },
    { width: 390, height: 1000 },
    { width: 320, height: 1000 },
  ],
  theme: "dark",
  results,
  limits:
    "Controlled external responses; real corpus/data/production site/browser path. Stored corpus only, no live coverage or deploy claim.",
};
writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
