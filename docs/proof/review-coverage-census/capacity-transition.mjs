// Count-only growth witnesses exercise the actual CLI and signed Worker/DO.
// No large identity arrays, live GH, production endpoints or browser are used.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { coverageCliFixture } from "../../../test/fixtures/review-coverage-cli.ts";
import { publicDashboardInputs } from "../../../dashboard-site/scripts/coverage.ts";
import { liveCoverage } from "../../../dashboard-site/src/lib/live-coverage.ts";
const out = resolve(
  process.env.CENSUS_CAPACITY_OUTPUT ??
    ".openclaw/tmp/census-completeness-design/review-r2/runtime-capacity",
);
mkdirSync(out, { recursive: true });
const files = [
  "src/review-coverage-census.ts",
  "src/review-coverage.ts",
  "src/repair/review-coverage-census.ts",
  "src/repair/target-fanout.ts",
  "src/repair/coverage-summary.ts",
  "dashboard/review-coverage-census.ts",
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-direct-publication.ts",
  "test/fixtures/review-coverage-cli.ts",
  "test/fixtures/fleet-coverage-query.ts",
  "docs/proof/review-coverage-census/capacity-transition.mjs",
  "dist/repair/target-fanout.js",
  "dist/repair/coverage-summary.js",
  "dist/repair/review-coverage-census.js",
  "dist/review-coverage-census.js",
];
const hashes = () =>
  Object.fromEntries(
    files.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
  );
const beforeHashes = hashes(),
  head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  records = [];
for (const name of [
  "issues-20001",
  "pulls-20001",
  "new-repository",
  "sum-20001",
  "sum-overflow",
  "repository-bound",
]) {
  const realStarted = Date.now(),
    f = await coverageCliFixture([
      { name: "core", issues: 2, pulls: 1 },
      { name: "good", issues: 1, pulls: 0 },
    ]);
  const epoch = f.time;
  try {
    await f.run("coverage");
    const canonical = JSON.stringify(f.authority.canonicalState()),
      admission = JSON.stringify(f.authority.storage.kv.get("exact-review-queue"));
    const items = () =>
      JSON.stringify(
        Array.from(
          f.authority.storage.sql.exec(
            "SELECT * FROM coverage_census_items ORDER BY repo,generation,kind,number",
          ),
        ),
      );
    const retained = items(),
      windows = f.states().map((r) => ({ repo: r.repo, complete: r.state.complete }));
    const originalStart = f.calls.find((c) => c.path.endsWith("/start")).body;
    f.advance(20 * 60_000);
    if (name === "issues-20001") f.setCountWitness("core", 20001, 1);
    if (name === "pulls-20001") f.setCountWitness("core", 2, 20001);
    if (name === "new-repository") f.addCountedRepository("new-large", 20001, 0);
    if (name === "sum-20001") {
      f.setCountWitness("core", 10000, 0);
      f.setCountWitness("good", 10001, 0);
    }
    if (name === "sum-overflow")
      f.setCountWitness("core", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (name === "repository-bound")
      for (let i = 0; i < 511; i++) f.addCountedRepository("meta-" + i, 0, 0);
    const run = await f.run("coverage");
    assert.equal(run.inventory, 0);
    assert.equal(run.legacy, 0);
    const receipt = f.responses.filter((r) => r.path.endsWith("/start")).at(-1);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.capacityBlocked, true);
    assert.equal(receipt.body.metadataAccepted, true);
    const start = f.calls.filter((c) => c.path.endsWith("/start")).at(-1).body,
      replay = await f.replayStart(start);
    assert.equal(replay.capacityBlocked, true);
    assert.equal(replay.replayed, true);
    assert.equal(items(), retained);
    for (const prior of windows)
      assert.deepEqual(
        f.states().find((r) => r.repo === prior.repo).state.complete,
        prior.complete,
      );
    let api, publicModel;
    if (["sum-overflow", "repository-bound"].includes(name)) {
      await assert.rejects(f.read(), /coverage_build_read_failed/);
    } else {
      api = await f.read();
      assert.equal(api.coverage_status, "unknown");
      assert.equal(api.totals.coverage_percent, null);
      const names = f.states().map((r) => r.repo),
        metadata = async (path) => {
          const url = new URL(String(path), "https://synthetic.invalid"),
            owner = url.pathname.split("/")[2],
            page = Number(url.searchParams.get("page") ?? 1),
            row = (repo) => ({
              full_name: repo,
              visibility: "public",
              private: false,
              archived: false,
              fork: false,
            });
          if (url.pathname.startsWith("/users/"))
            return Response.json(
              names
                .filter((n) => n.startsWith(owner + "/"))
                .slice((page - 1) * 100, page * 100)
                .map(row),
            );
          const repo = url.pathname.replace(/^\/repos\//, "");
          return names.includes(repo)
            ? Response.json(row(repo))
            : new Response(null, { status: 404 });
        };
      const selected = await publicDashboardInputs(f.authority.cache, api, metadata);
      publicModel = liveCoverage(selected.coverage, f.time);
      assert.equal(publicModel.known, false);
      if (name !== "sum-20001")
        assert.ok(publicModel.rows.find((r) => r.repo === "openclaw/good").known);
      writeFileSync(join(out, name + "-public-build.json"), JSON.stringify(selected, null, 2));
    }
    const anonymous = await f.anonymous(),
      anonymousText = await anonymous.text();
    assert.ok(!anonymousText.includes("openclaw/"));
    assert.equal(anonymous.status, ["sum-overflow", "repository-bound"].includes(name) ? 503 : 200);
    const inventory = Array.from(
        f.authority.storage.sql.exec(
          "SELECT COUNT(*) AS rows,COALESCE(SUM(bytes),0) AS bytes FROM coverage_census_items",
        ),
      )[0],
      metadataRows = Number(
        Array.from(
          f.authority.storage.sql.exec("SELECT COUNT(*) AS n FROM coverage_census_repositories"),
        )[0].n,
      );
    assert.equal(Number(inventory.rows), 4);
    assert.ok(metadataRows <= 512);
    assert.equal(JSON.stringify(f.authority.canonicalState()), canonical);
    assert.equal(JSON.stringify(f.authority.storage.kv.get("exact-review-queue")), admission);
    f.advance(6 * 60_000);
    const stale = await f.replayStart(originalStart);
    assert.equal(stale.metadataAccepted, false);
    assert.equal(stale.stale, true);
    assert.equal(stale.capacityBlocked, true);
    assert.equal(items(), retained);
    const record = {
      name,
      clock: {
        kind: "CONTROLLED VIRTUAL OBSERVATION CLOCK, NOT CURRENT LIVE DATA",
        epoch: new Date(epoch).toISOString(),
        evaluation: new Date(f.time).toISOString(),
        realExecutionStarted: new Date(realStarted).toISOString(),
      },
      receipt,
      replay,
      stale,
      identityQueries: run.inventory,
      identities: Number(inventory.rows),
      retainedBytes: Number(inventory.bytes),
      metadataRows,
      apiStatus: api?.coverage_status ?? "unavailable",
      numericPeers: publicModel?.rows.filter((r) => r.known).length ?? null,
      anonymousStatus: anonymous.status,
      canonicalUnchanged: true,
      admissionUnchanged: true,
      observations: f.states().map((r) => ({
        repo: r.repo,
        issues: r.state.repository.issues,
        pulls: r.state.repository.pulls,
        countsAt: r.state.repository.countsAt,
        reason: r.state.reason,
        generation: r.state.complete?.generation ?? null,
        publishedAt: r.state.complete?.published ?? null,
      })),
    };
    record.countExchanges = f.countExchanges;
    records.push(record);
    writeFileSync(join(out, name + ".json"), JSON.stringify(record, null, 2));
  } finally {
    f.close();
  }
}
assert.deepEqual(hashes(), beforeHashes);
const result = {
  head,
  base: "03e24309cf919bf866bb2ffe2551beca27fd9bb3",
  provider: process.env.CRABBOX_PROVIDER ?? "host-supporting-only",
  image: process.env.CRABBOX_IMAGE ?? null,
  lease: process.env.CRABBOX_LEASE ?? null,
  node: process.version,
  records,
  sourceHashes: beforeHashes,
  limits:
    "Actual CLI count/discovery and signed Worker/DO/private-build code with controlled GH/SQLite/R2 adapters; no production write, live GH authority, container allocation or browser pass. Count metadata never allocates identities; storage bounds remain unchanged.",
};
writeFileSync(join(out, "provenance.json"), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    records.map(
      ({
        name,
        identities,
        identityQueries,
        metadataRows,
        apiStatus,
        numericPeers,
        anonymousStatus,
      }) => ({
        name,
        identities,
        identityQueries,
        metadataRows,
        apiStatus,
        numericPeers,
        anonymousStatus,
      }),
    ),
    null,
    2,
  ),
);
