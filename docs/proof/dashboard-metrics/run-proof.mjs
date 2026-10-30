import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run on a qualified checkout with dashboard-site dependencies already installed.
// Both builds reuse that exact install; this command never installs or publishes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [baseRef, outputArg] = process.argv.slice(2);
const output = outputArg && resolve(outputArg);
const files = [
  "dashboard-site/src/lib/data.ts",
  "dashboard-site/src/lib/run-window.ts",
  "dashboard-site/src/pages/throughput.astro",
  "dashboard-site/src/pages/coverage.astro",
  "dashboard-site/src/pages/operations.astro",
  "dashboard-site/src/pages/index.astro",
];
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

try {
  assert.ok(baseRef && output, "usage: run-proof.mjs BASE_REF FRESH_OUTPUT_DIR");
  const dependencies = realpathSync(join(root, "dashboard-site/node_modules"));
  mkdirSync(output);
  const fixture = JSON.parse(readFileSync(join(root, "dashboard-site/fixtures/dashboard.json"), "utf8"));
  fixture.generatedAt = "2026-10-15T12:00:00.000Z";
  fixture.corpus.generatedAt = fixture.generatedAt;
  fixture.coverage.inventory_status = "current";
  fixture.coverage.inventory_generated_at = fixture.generatedAt;
  fixture.coverage.coverage_status = "complete";
  Object.assign(fixture.coverage.totals, { record_drift: 7, excluded: 3, unschedulable_records: 2 });
  const conclusions = { success: 3, skipped: 2, cancelled: 1, failure: 1, startup_failure: 1, timed_out: 1, neutral: 1, action_required: 1 };
  fixture.actions.windowEnd = fixture.generatedAt;
  fixture.actions.workflows = [
    { id: "sweep", file: "sweep.yml", totalRuns: 12, conclusionCounts: conclusions, durationSeconds: { p50: 60, p90: 120 }, days: [{ date: "2026-10-14", count: 12, conclusions, durationSeconds: { p50: 60, p90: 120 }, reviewSeconds: { p50: 60, p90: 120, samples: 12 } }] },
    { id: "mismatch", file: "mismatch.yml", totalRuns: 1, conclusionCounts: { success: 2 }, durationSeconds: { p50: 60, p90: 120 }, days: [] },
  ];
  fixture.operations.generatedAt = fixture.generatedAt;
  const hour = fixture.operations.hours[0];
  fixture.operations.hours = [
    { ...hour, hour: "2026-10-15T11:00:00.000Z", completed: 17 },
    { ...hour, hour: "2026-10-15T12:00:00.000Z", completed: 99 },
  ];
  const results = {};
  for (const variant of ["baseline", "candidate"]) {
    const source = join(output, variant);
    mkdirSync(source);
    if (variant === "baseline") {
      execFileSync("tar", ["-x", "-C", source], {
        input: execFileSync("git", ["archive", baseRef, "dashboard-site"], { cwd: root, maxBuffer: 16 * 1024 * 1024 }),
      });
    } else {
      cpSync(join(root, "dashboard-site"), join(source, "dashboard-site"), {
        recursive: true,
        filter: (path) => !["node_modules", "dist", ".astro", "src/data"].some((part) => path === join(root, "dashboard-site", part) || path.startsWith(`${join(root, "dashboard-site", part)}/`)),
      });
    }
    const site = join(source, "dashboard-site");
    for (const name of ["package.json", "pnpm-lock.yaml"]) {
      assert.equal(sha256(readFileSync(join(site, name))), sha256(readFileSync(join(root, "dashboard-site", name))), `${name} differs: qualify a separate dependency install`);
    }
    symlinkSync(dependencies, join(site, "node_modules"), "dir");
    results[variant] = build(site, fixture, variant);
    if (variant === "candidate") {
      const unknown = structuredClone(fixture);
      unknown.coverage.coverage_status = "unknown";
      unknown.coverage.inventory_status = "missing";
      unknown.coverage.inventory_generated_at = null;
      unknown.coverage.totals.open_records = 0;
      unknown.coverage.totals.coverage_percent = null;
      results.unknown = build(site, unknown, "missing-inventory");
      const legacy = structuredClone(fixture);
      delete legacy.coverage.coverage_status;
      results.legacy = build(site, legacy, "legacy-counts");
      const empty = structuredClone(fixture);
      empty.coverage.totals = Object.fromEntries(Object.keys(empty.coverage.totals).map((key) => [key, 0]));
      empty.coverage.totals.coverage_percent = null;
      results.empty = build(site, empty, "empty-complete-inventory");
    }
  }

  const base = results.baseline;
  const candidate = results.candidate;
  const row = candidate.rows.find((cells) => cells[0] === "sweep sweep.yml");
  assert.ok(row, "rendered sweep row missing");
  assert.equal(row[1], "12");
  for (const [status, count] of Object.entries(conclusions)) assert.ok(row[2].includes(`${status} ${count}`), `missing ${status} count`);
  assert.equal(row[3], "1", "one run has no recorded conclusion");
  assert.match(candidate.throughput, /Count mismatch: 1 excess conclusions/);
  assert.doesNotMatch(base.throughput, /Recorded conclusions/);
  assert.deepEqual(candidate.failureTooltips, ["Oct 14\n25.00%"]);
  assert.deepEqual(base.failureTooltips, ["Oct 14\n16.67%"]);
  assert.match(candidate.coverage, /Invalidated/);
  assert.match(candidate.coverage, /7 records outside the open inventory/);
  assert.match(candidate.coverage, /3 excluded/);
  assert.match(candidate.coverage, /2 unschedulable records/);
  assert.doesNotMatch(candidate.coverageHtml, /<th[^>]*>Fresh<\/th>/);
  assert.match(candidate.coverage, /Coverage 65\.2% 5,156 of 7,909/);
  assert.match(results.unknown.coverage, /Inventory: Missing/);
  assert.match(results.unknown.coverage, /timestamp unavailable/);
  assert.match(results.unknown.coverage, /Open item count unavailable/);
  assert.doesNotMatch(results.unknown.coverage, /0 reported open items/);
  assert.match(candidate.coverage, /Oldest reviews in stored open records/);
  for (const result of [results.unknown, results.legacy]) {
    assert.match(result.coverage, /Coverage Unknown Complete, current open-item census required/);
    assert.match(result.coverage, /Pending review Unknown/);
    assert.match(result.coverage, /Invalidated Unknown/);
    assert.match(result.coverage, /Reviewable backlog unavailable/);
    assert.match(result.overview, /reviewable inventory unknown/);
    assert.match(result.overview, /Coverage Unknown Complete, current open-item census required/);
    assert.match(result.overview, /Reviewable backlog unavailable/);
    assert.doesNotMatch(result.coverage, /65\.2%/);
  }
  assert.match(results.empty.coverage, /Coverage – 0 of 0/);
  assert.match(results.empty.coverage, /Pending review 0/);
  assert.match(results.empty.coverage, /0 reported open items/);
  assert.doesNotMatch(results.empty.coverage, /Coverage Unknown/);
  assert.match(base.operations, /Reviews per hour[\s\S]*?17/);
  assert.match(candidate.operations, /Queue resolutions per hour[\s\S]*?17/);
  assert.match(candidate.operations, /7-day median 17/);
  assert.match(candidate.operations, /Resolved/);
  assert.doesNotMatch(candidate.operations, /Reviews per hour/);
  const receipt = {
    verdict: "pass",
    base: git("rev-parse", baseRef),
    head: git("rev-parse", "HEAD"),
    node: process.version,
    runtime: "real Astro static builds with identical installed dependencies and controlled dashboard snapshots",
    source_sha256: Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(root, file)))])),
    assertions: ["raw conclusion counts and missing conclusion reconcile", "excess conclusion mismatch remains visible", "timeouts count as sweep failures", "complete inventory coverage and diagnostics render", "missing and legacy inventories stay unknown on Coverage and Overview", "empty complete inventory is distinct from unknown", "inferred Fresh column removed", "queue-resolution labels retain the observed value 17"],
    limits: "Controlled stored snapshots; does not establish live inventory identity accuracy, independent review quality or production deployment.",
  };
  writeFileSync(join(output, "result.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[dashboard-metrics-proof] FAILED (exit 1)");
  process.exitCode = 1;
}

function build(site, fixture, variant) {
  mkdirSync(join(site, "src/data"), { recursive: true });
  writeFileSync(join(site, "src/data/dashboard.json"), JSON.stringify(fixture));
  execFileSync("pnpm", ["run", "build"], { cwd: site, stdio: "pipe", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  const rendered = join(output, "rendered", variant);
  mkdirSync(rendered, { recursive: true });
  const read = (page) => {
    const html = readFileSync(join(site, "dist", page === "overview" ? "" : page, "index.html"), "utf8");
    writeFileSync(join(rendered, `${page}.html`), html);
    return html;
  };
  const throughput = read("throughput");
  const coverage = read("coverage");
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const failureChart = [...throughput.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)]
    .map((match) => match[0])
    .find((html) => /<h2\b[^>]*>\s*Sweep failure rate(?:\s|<)/.test(html));
  assert.ok(failureChart, "rendered sweep failure-rate chart missing");
  const failureTooltips = [...failureChart.matchAll(/<div\b[^>]*\bclass="hit"[^>]*\bdata-tip="([^"]*)"[^>]*>/g)]
    .map((match) => match[1].replace(/&#(?:x0*a|0*10);/gi, "\n"));
  return {
    throughput: text(throughput),
    failureTooltips,
    rows: [...throughput.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => text(cell[1]))),
    coverage: text(coverage),
    coverageHtml: coverage,
    overview: text(read("overview")),
    operations: text(read("operations")),
  };
}
