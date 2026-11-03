import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../dashboard/worker.ts";
import test from "node:test";
import { authorityFixture } from "../docs/proof/ui-live-coverage/coverage-authority-fixture.mjs";
import {
  publicDashboardInputs,
  readCoverageForBuild,
  verifyPublicRepositories,
} from "../dashboard-site/scripts/coverage.ts";
import { withReplayClock } from "../docs/proof/ui-live-coverage/replay-clock.mjs";

const purpose = '{"purpose":"dashboard-site-coverage-v1"}';
const absent = (value: unknown) =>
  assert.doesNotMatch(
    JSON.stringify(value),
    /privacy[/-]revocable|revoked-title-needle|"repo_slug"|"needs_refresh"/,
  );

test("anonymous actual Worker coverage is aggregate-only even before/after visibility revocation,with no GitHub fanout", async () => {
  const f = await authorityFixture();
  const original = JSON.stringify(f.persisted());
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
    f.setMode(mode);
    const response = await f.anonymous();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = (await response.json()) as any;
    absent(payload);
    assert.equal(Object.hasOwn(payload, "fleets"), false);
    assert.equal(payload.scope, "aggregate-only");
    assert.equal(payload.count_scope, "fleet-inventory-aggregate");
  }
  for (const offset of [13 * 3600000, -3600000]) {
    await withReplayClock(Date.now() + offset, async () =>
      absent(await (await f.anonymous()).json()),
    );
  }
  assert.equal(f.metadataCalls.length, 0, "anonymous reads must not spend GitHub/App quota");
  assert.equal(JSON.stringify(f.persisted()), original);
});

test("legacy/malformed/unavailable actual anonymous routes never echo identities or identifying query", async () => {
  const fields = [
    "open_records",
    "reviewable_records",
    "tracked_records",
    "reviewed_recent",
    "stale",
    "failed",
    "expired",
    "unreviewed_records",
    "untracked_open",
    "pending",
    "excluded",
    "unschedulable_records",
    "record_drift",
  ];
  const legacy = {
    ok: true,
    generated_at: new Date().toISOString(),
    inventory_generated_at: null,
    inventory_status: "missing",
    window_days: 7,
    coverage_status: "unknown",
    totals: { ...Object.fromEntries(fields.map((key) => [key, 0])), coverage_percent: null },
    fleets: [
      {
        repo: "privacy/revocable",
        repo_slug: "privacy-revocable",
        needs_refresh: [{ number: 102 }],
      },
    ],
    marker: "revoked-title-needle",
  };
  for (const source of [legacy, { ...legacy, totals: {} }, null]) {
    const env = {
      EXACT_REVIEW_QUEUE: {
        idFromName: (v: string) => v,
        get: () => ({ fetch: async () => Response.json(source) }),
      },
    };
    const response = await worker.fetch(
      new Request("https://local.invalid/api/review-coverage?repo=privacy/revocable"),
      env,
    );
    const value = await response.json();
    absent(value);
    assert.equal(Object.hasOwn(value, "fleets"), false);
  }
  absent(
    await (
      await worker.fetch(
        new Request("https://local.invalid/api/review-coverage?repo=privacy/revocable"),
        {},
      )
    ).json(),
  );
});
test("private coverage read requires configured secret,exact signed purpose and fixed method/path,and forwards only GET", async () => {
  const f = await authorityFixture(),
    before = f.calls.length;
  assert.equal((await f.signed(purpose, "POST", undefined, false)).status, 401);
  assert.equal((await f.signed(purpose, "POST", undefined, true, false)).status, 503);
  for (const body of [
    "{}",
    '{"purpose":"other"}',
    '{"purpose":"dashboard-site-coverage-v1","path":"/enqueue"}',
  ])
    assert.equal((await f.signed(body)).status, 400);
  assert.equal((await f.signed("x".repeat(129))).status, 413);
  assert.equal((await f.signed(purpose, "GET")).status, 404);
  assert.equal(
    (await f.signed(purpose, "POST", "/internal/review-coverage/build?repo=privacy/revocable"))
      .status,
    400,
  );
  assert.equal(
    (await f.signed(purpose, "POST", "/internal/review-coverage/inventory")).status,
    401,
    "read signature cannot be replayed at a mutation route",
  );
  const bodyOnly = "sha256=" + createHmac("sha256", f.secret).update(purpose).digest("hex");
  assert.equal(
    (
      await worker.fetch(
        new Request("https://local.invalid/internal/review-coverage/build", {
          method: "POST",
          body: purpose,
          headers: { "x-clawsweeper-exact-review-signature": bodyOnly },
        }),
        f.env,
      )
    ).status,
    401,
    "generic body-only HMAC is not read-purpose authority",
  );
  assert.equal(f.calls.length, before, "failed admission may not reach the DO");
  const response = await f.signed(purpose);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const data = (await response.json()) as any;
  assert.equal(data.scope, "authenticated-coverage-candidates");
  assert.ok(data.fleets.some((r: any) => r.repo === "privacy/revocable"));
  assert.deepEqual(f.calls.slice(before), [{ method: "GET", path: "/review-coverage" }]);
  await assert.rejects(readCoverageForBuild(undefined), /coverage_build_secret_required/);
  await assert.rejects(
    readCoverageForBuild("wrong", (url, init) =>
      import("../dashboard/worker.ts").then((m) =>
        m.default.fetch(new Request(String(url), init), f.env),
      ),
    ),
    /coverage_build_read_failed/,
  );
});

test("current visibility controls ALL built corpus/coverage/state/items/totals while persisted public census and bodies remain unchanged", async () => {
  const f = await authorityFixture(),
    census = JSON.stringify(f.persisted()),
    cache = JSON.stringify(f.cache);
  const publicBuild = await f.build();
  assert.equal(publicBuild.coverage.totals.open_records, 12);
  assert.equal(
    publicBuild.coverage.fleets.find((r: any) => r.repo === "privacy/revocable").open_records,
    7,
  );
  assert.ok(JSON.stringify(publicBuild).includes("revoked-title-needle"));
  assert.ok(publicBuild.coverage.fleets.some((r: any) => r.repo === "privacy/coverage-only"));
  assert.ok(publicBuild.corpus.repos.some((r: any) => r.repo === "privacy/history-only"));
  const canonical = f.canonicalState(),
    callsBefore = f.calls.length;
  for (const mode of ["private", "404", "renamed"]) {
    f.setMode(mode);
    const privateCandidates = await f.candidates();
    assert.ok(
      privateCandidates.fleets.some((r: any) => r.repo === "privacy/revocable"),
      "private read is NOT public disclosure authority",
    );
    const snapshot = await f.build(),
      serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /privacy[/-]revocable|revoked-title-needle|privacy\/renamed/);
    assert.equal(
      snapshot.coverage.totals.open_records,
      5,
      "retain other currently public counts,not allUnknown or old private total",
    );
    assert.equal(snapshot.coverage.totals.coverage_percent, 0);
    assert.equal(snapshot.corpus.totals.records, 6);
    assert.equal(snapshot.repositoryStates["privacy/revocable"], undefined);
    assert.equal(
      snapshot.coverage.fleets
        .flatMap((r: any) => r.needs_refresh)
        .some((i: any) => i.number >= 101 && i.number <= 107),
      false,
    );
  }
  assert.deepEqual(f.canonicalState(), canonical);
  assert.equal(JSON.stringify(f.persisted()), census);
  assert.equal(JSON.stringify(f.cache), cache);
  assert.ok(
    f.calls
      .slice(callsBefore)
      .every((r: any) => r.method === "GET" && r.path === "/review-coverage"),
  );
  assert.equal(
    f.storage.scalar("SELECT COUNT(*) AS value FROM canonical_record_tuple_receipts"),
    0,
  );
  f.setMode("public");
  assert.equal(
    (await f.build()).coverage.totals.open_records,
    12,
    "no stale denial or visibility permit cache",
  );
});

test("coverage-only and corpus-only revocation use the same fresh publication boundary", async () => {
  const f = await authorityFixture(),
    candidates = await f.candidates();
  for (const revoked of ["privacy/coverage-only", "privacy/history-only"]) {
    const selected = await publicDashboardInputs(f.cache, candidates, async (path) =>
      path.startsWith("users/")
        ? Response.json(
            ["privacy/revocable", "privacy/steady", "privacy/coverage-only", "privacy/history-only"]
              .filter((name) => name !== revoked)
              .map((full_name) => ({ full_name, visibility: "public" })),
          )
        : Response.json({ full_name: revoked, visibility: "private" }),
    );
    assert.ok(!JSON.stringify(selected).includes(revoked));
    assert.ok(!JSON.stringify(selected).includes(revoked.replace("/", "-")));
    assert.equal(selected.coverage.totals.open_records, revoked.endsWith("coverage-only") ? 9 : 12);
    assert.equal(selected.corpus.totals.records, revoked.endsWith("history-only") ? 9 : 13);
  }
});

test("403/429/network/invalid/partial current verification aborts before any publication and does not expose private diagnostics", async () => {
  const f = await authorityFixture(),
    original = JSON.stringify(f.persisted());
  await f.build();
  for (const mode of ["403", "429", "network", "invalid", "partial"]) {
    f.setMode(mode);
    let published = false;
    await assert.rejects(
      (async () => {
        await f.build();
        published = true;
      })(),
      (error: any) => error.message === "coverage_visibility_unverified",
    );
    assert.equal(published, false);
    absent(await (await f.anonymous()).json());
    assert.equal(JSON.stringify(f.persisted()), original);
  }
});

test("metadata inconsistency,invalid listing and repeated partial pages fail closed; unrelated public owner names do not enter output", async () => {
  for (const value of [
    {},
    [{ visibility: "public" }],
    [{ full_name: "privacy/revocable", visibility: "public", private: true }],
    [{ full_name: "privacy/..", visibility: "public" }],
  ])
    await assert.rejects(
      verifyPublicRepositories(["privacy/revocable"], async () => Response.json(value)),
      /coverage_visibility_unverified/,
    );
  const result = await verifyPublicRepositories(["privacy/steady"], async () =>
    Response.json([
      { full_name: "privacy/steady", visibility: "public" },
      { full_name: "privacy/unrelated", visibility: "public" },
    ]),
  );
  assert.deepEqual(Object.keys(result.states), ["privacy/steady"]);
  assert.deepEqual([...result.names], ["privacy/steady"]);
});

test("build entrypoint requires private read and validates corpus PLUS coverage-only names before writing;workflow wires existing secret", () => {
  const build = readFileSync("dashboard-site/scripts/build-data.ts", "utf8"),
    workflow = readFileSync(".github/workflows/dashboard-site.yml", "utf8");
  assert.match(build, /readCoverageForBuild\(coverageSecret\)/);
  assert.ok(
    build.includes('if (!coverageSecret) throw new Error("coverage_build_secret_required")'),
  );
  assert.doesNotMatch(build, /publicApi\("\/api\/review-coverage"\)/);
  assert.ok(
    build.indexOf("publicDashboardInputs(cache, coverage, github)") <
      build.indexOf('writeFile(join(site, "src/data/dashboard.json")'),
  );
  const step = workflow.slice(
    workflow.indexOf("- name: Build dashboard data"),
    workflow.indexOf("- name: Save dashboard state"),
  );
  assert.match(step, /CLAWSWEEPER_WEBHOOK_SECRET:.*secrets.CLAWSWEEPER_WEBHOOK_SECRET/);
});
