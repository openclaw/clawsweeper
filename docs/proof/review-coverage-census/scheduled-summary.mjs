// Actual coverage CLI -> signed Worker/DO -> anonymous aggregate GET -> stdout.
// Controlled GitHub/storage adapters only; no production authority or browser call.
import assert from "node:assert/strict";
import { Console } from "node:console";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  ExactReviewDirectPublicationStore,
  validateDirectPublicationPlan,
} from "../../../dashboard/exact-review-direct-publication.ts";
import { coverageCliFixture } from "../../../test/fixtures/review-coverage-cli.ts";
const root = resolve(import.meta.dirname, "../../.."),
  output = resolve(
    process.env.CENSUS_SUMMARY_OUTPUT ?? ".openclaw/tmp/census-scheduled-summary-proof",
  ),
  realStarted = new Date().toISOString(),
  git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(),
  head = git("rev-parse", "HEAD"),
  tree = git("rev-parse", "HEAD^{tree}"),
  workingTreeCandidate = git("status", "--porcelain").length > 0;
mkdirSync(output, { recursive: true });
const paths = [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "src/repair/target-fanout.ts",
    "src/repair/coverage-summary.ts",
    "src/repair/review-coverage-census.ts",
    "dashboard/worker.ts",
    "dashboard/review-coverage-census.ts",
    "dashboard/public-observability.ts",
    "dashboard/exact-review-queue.ts",
    "dashboard/exact-review-direct-publication.ts",
    "test/fixtures/review-coverage-cli.ts",
    "test/fixtures/coverage-summary-failure.ts",
    "test/fixtures/coverage-summary-failure-child.mjs",
    "test/fixtures/fleet-coverage-query.ts",
    "docs/proof/review-coverage-census/scheduled-summary.mjs",
    "dist/repair/target-fanout.js",
    "dist/repair/coverage-summary.js",
  ],
  hashes = () =>
    Object.fromEntries(
      paths.map((p) => [
        p,
        createHash("sha256")
          .update(readFileSync(join(root, p)))
          .digest("hex"),
      ]),
    ),
  sourceHashes = hashes();
const consoleOwner = new Console(process.stdout, process.stderr);
async function capture(work) {
  const out = process.stdout.write,
    err = process.stderr.write,
    error = console.error;
  let stdout = "",
    stderr = "";
  const take = (append) => (chunk, encoding, callback) => {
    append(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  process.stdout.write = take((v) => (stdout += v));
  process.stderr.write = take((v) => (stderr += v));
  console.error = consoleOwner.error.bind(consoleOwner);
  try {
    await work();
    return { stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    console.error = error;
  }
}
async function seed(f) {
  const content =
      "---\nrepository: openclaw/core\nnumber: 1\ntype: issue\nreview_status: complete\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\nreviewed_at: " +
      new Date(f.time).toISOString() +
      "\n---\nControlled report seed, not a production review.\n",
    plan = await validateDirectPublicationPlan({
      canonicalTargetKey: "openclaw/core#1",
      fenceKey: "openclaw/core#1:scheduled-report-proof",
      revision: 1,
      identity: {
        canonicalTargetKey: "openclaw/core#1",
        fenceKey: "openclaw/core#1:scheduled-report-proof",
        revision: 1,
        claimGeneration: 1,
      },
      lifecycle: { kind: "guarded_open" },
      operations: [
        {
          path: "records/openclaw-core/items/1.md",
          deleted: false,
          mode: "100644",
          bytes: Buffer.byteLength(content),
          contentBase64: Buffer.from(content).toString("base64"),
        },
      ],
      totalBytes: Buffer.byteLength(content),
    }),
    store = new ExactReviewDirectPublicationStore(f.authority.storage);
  store.ensureSchemaSync();
  store.accept(plan, f.time, await store.prepareCanonicalWrites(plan.operations));
}
const cases = [];
for (const name of [
  "known7",
  "window14",
  "facts-unavailable",
  "public-read-failed",
  "explicit-v1",
  "no-publish",
]) {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
  let publicPayload = null;
  try {
    if (name === "known7" || name === "window14") await seed(f);
    if (name === "facts-unavailable")
      f.authority.storage.failNextSqlMatching(/FROM\s+exact_review_canonical_records(?:_v2)?\b/i);
    if (name === "public-read-failed")
      f.setPublicCoverageResponse(
        () => new Response("private/never-echo ID_secret ghp_private", { status: 503 }),
      );
    else
      f.setPublicCoverageResponse(async () => {
        const response = await f.anonymous();
        publicPayload = await response.clone().json();
        return response;
      });
    const report = await capture(() =>
      f.run("coverage", name === "explicit-v1" ? "v1" : "v2", {
        windowDays: name === "window14" ? 14 : 7,
        publish: name !== "no-publish",
      }),
    );
    assert.match(report.stdout, /## (?:Weekly review coverage|Review coverage)/);
    assert.ok(
      !/openclaw\/core|ID_core|ID_secret|ghp_private|private\/never-echo|checkpoint|generation/.test(
        report.stdout,
      ),
    );
    if (name === "known7") {
      assert.match(report.stdout, /Current observed open items \| 3/);
      assert.match(report.stdout, /Fresh in trailing 7 days \| 1/);
      assert.match(report.stdout, /Trailing coverage \| 33\.3%/);
    }
    if (name === "window14") {
      assert.match(report.stdout, /Fresh in trailing 14 days \| Unknown/);
      assert.match(report.stdout, /Source review window \| 7 days/);
    }
    if (name === "facts-unavailable") {
      assert.equal(publicPayload.scan_status, "unknown");
      assert.match(report.stdout, /Current observed open items \| 3/);
      assert.match(report.stdout, /Canonical review facts \| Unknown/);
    }
    if (name === "public-read-failed") {
      assert.match(report.stdout, /Trailing coverage \| Unknown/);
      assert.ok(!report.stderr.includes("ghp_private"));
    }
    const starts = f.calls.filter((c) => c.path.endsWith("/census/start")),
      v1 = f.calls.filter(
        (c) => c.path.endsWith("/review-coverage/inventory") && c.method === "POST",
      );
    assert.equal(f.publicCoverageReads.length, name === "no-publish" ? 0 : 1);
    if (name !== "no-publish" && name !== "explicit-v1") {
      assert.equal(starts.length, 1);
      assert.equal(v1.length, 0);
      assert.ok(!report.stdout.includes("coverage_collection"));
      assert.match(report.stderr, /coverage_collection/);
    }
    for (const read of f.publicCoverageReads)
      assert.deepEqual(read, {
        path: "/api/review-coverage",
        method: "GET",
        query: "",
        authorization: false,
        signature: false,
        redirect: "error",
      });
    assert.ok(f.queries.every((r) => r.inventory <= 25));
    cases.push({
      name,
      ...report,
      publicPayload,
      wire: f.publicCoverageReads,
      queries: f.queries,
      countExchanges: f.countExchanges,
      starts: starts.map((s) => s.body),
      v1Publications: v1.length,
    });
    writeFileSync(join(output, name + ".md"), report.stdout);
    writeFileSync(join(output, name + ".stderr.txt"), report.stderr);
  } finally {
    f.close();
  }
}
const f = await coverageCliFixture([
    { name: "core", issues: 1200, pulls: 0 },
    { name: "ent", issues: 260, pulls: 0 },
    ...Array.from({ length: 143 }, (_, i) => ({ name: "small" + i, issues: 1, pulls: 0 })),
  ]),
  query = f.model.query;
let tick = 0,
  last,
  qualified = 0;
try {
  f.model.query = (q) => {
    tick++;
    for (const name of ["core", "ent"]) f.model.members.get(name).labels = ["changed-" + tick];
    return query(q);
  };
  for (let i = 0; i < 36; i++) {
    if (i) f.advance(20 * 60_000);
    last = await capture(() => f.run("coverage"));
    qualified = f.states().filter((s) => s.state.complete).length;
    if (qualified === 143) break;
  }
  assert.equal(qualified, 143);
  assert.match(last.stdout, /Current observed open items \| 1603/);
  assert.match(last.stdout, /Trailing coverage \| Unknown/);
  assert.ok(!/openclaw\/(?:core|ent|small)|ID_|checkpoint|generation/.test(last.stdout));
  assert.ok(f.queries.every((q) => q.inventory <= 25));
  cases.push({
    name: "partial143of145",
    ...last,
    qualified,
    total: 145,
    queries: f.queries,
    wire: f.publicCoverageReads,
    completeTotalPubliclyExposed: false,
  });
  writeFileSync(join(output, "partial143of145.md"), last.stdout);
  writeFileSync(join(output, "partial143of145.stderr.txt"), last.stderr);
} finally {
  f.close();
}
// Actual compiled main guard, not merely renderer or exported-function proof.
for (const stage of ["start", "discovery"]) {
  const prefix = stage === "start" ? "publication-failure" : "discovery-failure";
  const failureTrace = join(output, prefix + "-child.trace.json"),
    failure = spawnSync(
      process.execPath,
      [join(root, "test/fixtures/coverage-summary-failure-child.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          CENSUS_SUMMARY_FAILURE_STAGE: stage,
          CENSUS_SUMMARY_FAILURE_KIND: stage === "discovery" ? "network" : "http503",
          CENSUS_SUMMARY_FAILURE_TRACE: failureTrace,
        },
      },
    );
  writeFileSync(join(output, prefix + ".stdout.md"), failure.stdout);
  writeFileSync(join(output, prefix + ".stderr.txt"), failure.stderr);
  writeFileSync(join(output, prefix + ".exit.txt"), String(failure.status));
  assert.equal(failure.status, 1);
  assert.equal(failure.signal, null);
  assert.equal(failure.error, undefined);
  assert.match(failure.stdout, /## Weekly review coverage/);
  assert.ok(failure.stdout.includes("collection/publication unavailable"));
  assert.match(failure.stderr, /coverage_command_failed/);
  assert.ok(
    !/ID_secret|ghp_never_echo|SYNTHETIC_PRIVATE_ERROR|private\/secret-repo/.test(
      failure.stdout + failure.stderr,
    ),
  );
  const failedTrace = JSON.parse(readFileSync(failureTrace));
  assert.equal(failedTrace.actualCliExit, 1);
  assert.equal(failedTrace.entryByteIdentical, true);
  assert.equal(failedTrace.compiledCanonicalSha256, failedTrace.compiledEntrySha256);
  assert.equal(failedTrace.countQueries, stage === "discovery" ? 0 : 1);
  assert.equal(failedTrace.discoveryQueries, 1);
  assert.equal(failedTrace.identityQueries, 0);
  assert.equal(failedTrace.publicReads.length, 1);
  assert.equal(failedTrace.controlRequests.length, stage === "discovery" ? 0 : 1);
  assert.equal(failedTrace.v1Publications, 0);
  assert.equal(failedTrace.fixtureClosed, true);
  cases.push({
    name: stage === "start" ? "publication-failure-start503" : "discovery-failure",
    stdout: failure.stdout,
    stderr: failure.stderr,
    actualExit: failure.status,
    wire: failedTrace.publicReads,
    trace: failedTrace,
    limits:
      "Real child exit1 is the required negative outcome; parent proof assertion exits0. Canonical compiled entry bytes copied at same generated directory to exercise actual main guard under existing controlled providers, hash-identical, then removed. No altered source or success swallowing.",
  });
}
assert.deepEqual(hashes(), sourceHashes);
const result = {
  head,
  tree,
  workingTreeCandidate,
  provider: process.env.CRABBOX_PROVIDER ?? "host-supporting-only",
  image: process.env.CRABBOX_IMAGE ?? null,
  lease: process.env.CRABBOX_LEASE ?? null,
  node: process.version,
  realStarted,
  realEnded: new Date().toISOString(),
  sourceHashes,
  cases,
  limits:
    "Actual CLI/public Worker aggregate projection with controlled metadata/storage. No per-repository identifying report, public endpoint does not expose Complete/Total cardinalities; source/private fields never rendered. Virtual observation cadence is not real production latency. No deployed Cloudflare/live write authority; explicit-v1 is an existing client mode, not automatic fallback.",
};
writeFileSync(join(output, "provenance.json"), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    head,
    provider: result.provider,
    cases: cases.map((c) => c.name),
    sourceUnchanged: true,
    read: "GET /api/review-coverage",
    privateRead: false,
    additionalIdentityScan: false,
  }),
);
