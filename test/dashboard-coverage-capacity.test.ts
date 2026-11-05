import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import worker from "../dashboard/worker.ts";
import { authorityFixture } from "../docs/proof/ui-live-coverage/coverage-authority-fixture.mjs";
import { censusFixture } from "./fixtures/review-coverage-census.ts";
import {
  censusHttpControl,
  runReviewCoverageCensus,
} from "../dist/repair/review-coverage-census.js";
import {
  censusSignatureInput,
  censusRepository,
  censusPage,
} from "../src/review-coverage-census.ts";
import { readCoverageForBuild } from "../dashboard-site/scripts/coverage.ts";

async function capacityFixture() {
  const a = await authorityFixture(),
    model = censusFixture([
      { name: "affected", issues: 2, pulls: 1 },
      { name: "good", issues: 1, pulls: 0 },
    ]);
  const env = {
      ...a.env,
      EXACT_REVIEW_QUEUE: { idFromName: (id: string) => id, get: () => a.queue },
    },
    attempt = "capacity-owner";
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit) =>
    worker.fetch(new Request(url, init), env, {});
  const repositories = model
    .population()
    .map((r) => ({ ...r, countsAt: new Date().toISOString() }));
  const run = await runReviewCoverageCensus({
    repositories,
    query: model.query,
    control: censusHttpControl({ baseUrl: "https://local.invalid", secret: a.secret, fetchImpl }),
    attempt,
  });
  assert.equal(run.failed, 0);
  const canonical = JSON.stringify(a.canonicalState()),
    admission = JSON.stringify(a.storage.kv.get("exact-review-queue"));
  const states = () =>
    Array.from(
      a.storage.sql.exec("SELECT repo,state FROM coverage_census_repositories ORDER BY repo"),
    ).map((r) => ({ repo: String(r.repo), state: JSON.parse(String(r.state)) }));
  const identities = () =>
    Array.from(
      a.storage.sql.exec(
        "SELECT repo,generation,kind,number,payload,bytes,slot FROM coverage_census_items ORDER BY repo,generation,kind,number",
      ),
    );
  const before = JSON.stringify(identities()),
    windows = states().map((s) => ({ repo: s.repo, complete: s.state.complete }));
  return {
    a,
    model,
    env,
    attempt,
    repositories,
    states,
    identities,
    before,
    windows,
    async start(population: unknown[], observedAt = new Date().toISOString()) {
      const path = "/internal/review-coverage/census/start",
        body = JSON.stringify({ version: 2, attempt, repositories: population, observedAt });
      const response = await fetchImpl("https://local.invalid" + path, {
        method: "POST",
        body,
        headers: {
          "x-clawsweeper-exact-review-signature":
            "sha256=" +
            createHmac("sha256", a.secret).update(censusSignatureInput(path, body)).digest("hex"),
        },
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
        observedAt,
      };
    },
    read() {
      return readCoverageForBuild(a.secret, fetchImpl, "https://local.invalid");
    },
    async anonymous() {
      return worker.fetch(new Request("https://local.invalid/api/review-coverage"), env, {});
    },
    unchanged() {
      assert.equal(JSON.stringify(a.canonicalState()), canonical);
      assert.equal(JSON.stringify(a.storage.kv.get("exact-review-queue")), admission);
      assert.equal(JSON.stringify(identities()), before);
    },
    close() {
      model.db.close();
    },
  };
}

test("signed valid count metadata above 20,000 invalidates an old complete denominator without allocating identities", async () => {
  for (const field of ["issues", "pulls"] as const) {
    const f = await capacityFixture();
    try {
      const at = new Date().toISOString(),
        population = f.repositories.map((r) => ({
          ...r,
          countsAt: at,
          ...(r.repo === "fixture/affected" ? { [field]: 20001 } : {}),
        }));
      const result = await f.start(population, at);
      const after = await f.read();
      assert.equal(after.coverage_status, "unknown");
      assert.equal(after.totals.coverage_percent, null);
      const affected = after.fleets.find((r) => r.repo === "fixture/affected"),
        good = after.fleets.find((r) => r.repo === "fixture/good");
      assert.equal(affected.coverage_status, "unknown");
      assert.equal(affected.census_status, "unknown");
      assert.equal(good.coverage_status, "complete");
      assert.equal(result.status, 200);
      assert.equal(result.body.capacityBlocked, true);
      assert.equal(result.body.metadataAccepted, true);
      const state = f.states().find((r) => r.repo === "fixture/affected")!.state;
      assert.equal(state.repository[field], 20001);
      assert.equal(state.repository.countsAt, at);
      assert.equal(state.active, null);
      assert.deepEqual(
        state.complete,
        f.windows.find((r) => r.repo === "fixture/affected")!.complete,
      );
      const replay = await f.start(population, at);
      assert.equal(replay.body.capacityBlocked, true);
      assert.deepEqual(
        f.states().map((r) => r.state.complete),
        f.windows.map((r) => r.complete),
      );
      f.unchanged();
      const anonymous = await f.anonymous();
      assert.equal(anonymous.status, 200);
      const text = await anonymous.text();
      assert.ok(!text.includes("fixture/"));
    } finally {
      f.close();
    }
  }
});
test("a new oversized repository joins the represented population instead of retaining the old complete fleet", async () => {
  const f = await capacityFixture();
  try {
    const at = new Date().toISOString(),
      population = [
        ...f.repositories.map((r) => ({ ...r, countsAt: at })),
        {
          repo: "fixture/new-large",
          id: "ID_new-large",
          revision: "policy-v1",
          visibility: "public",
          scope: "eligible",
          issues: 20001,
          pulls: 0,
          countsAt: at,
        },
      ];
    await f.start(population, at);
    const after = await f.read();
    assert.equal(after.coverage_status, "unknown");
    assert.equal(after.totals.coverage_percent, null);
    assert.ok(
      after.fleets.some((r) => r.repo === "fixture/new-large" && r.census_status === "unknown"),
    );
    assert.equal(after.fleets.find((r) => r.repo === "fixture/good").coverage_status, "complete");
    assert.equal(f.states().length, 3);
    f.unchanged();
  } finally {
    f.close();
  }
});

test("count metadata widens safely without widening page/storage admission", async () => {
  const f = await capacityFixture();
  try {
    const base = f.repositories[0]!;
    assert.equal(
      censusRepository({ ...base, issues: 20001, pulls: Number.MAX_SAFE_INTEGER }).issues,
      20001,
    );
    const page = {
      repo: base.repo,
      id: base.id,
      revision: base.revision,
      generation: "test",
      revisionNumber: 0,
      pass: 1,
      kind: "issue",
      cursor: null,
      items: [],
      next: null,
      hasNext: false,
      observedAt: new Date().toISOString(),
    };
    assert.equal(censusPage({ ...page, total: 20000 }).total, 20000);
    assert.throws(() => censusPage({ ...page, total: 20001 }), /integer bound/);
    const at = new Date().toISOString();
    const edge = await f.start([{ ...base, issues: 20000, pulls: 0, countsAt: at }], at);
    assert.equal(edge.body.capacityBlocked, false);
    assert.equal(edge.body.metadataAccepted, true);
  } finally {
    f.close();
  }
});
test("a safe 20,001 aggregate across two repositories becomes Unknown with exact count witnesses", async () => {
  const f = await capacityFixture();
  try {
    const at = new Date().toISOString(),
      pop = f.repositories.map((r, i) => ({
        ...r,
        issues: i ? 10001 : 10000,
        pulls: 0,
        countsAt: at,
      }));
    const result = await f.start(pop, at);
    assert.equal(result.body.capacityBlocked, true);
    assert.equal(result.body.observedTotal, 20001);
    assert.equal(result.body.sumOverflow, false);
    const read = await f.read();
    assert.equal(read.coverage_status, "unknown");
    assert.equal(read.totals.coverage_percent, null);
    assert.ok(
      read.fleets
        .filter((r) => r.repo.startsWith("fixture/"))
        .every((r) => r.census_status === "unknown"),
    );
    f.unchanged();
  } finally {
    f.close();
  }
});
test("safe individual witnesses cannot overflow an authoritative aggregate", async () => {
  const f = await capacityFixture();
  try {
    const at = new Date().toISOString(),
      pop = f.repositories.map((r) => ({
        ...r,
        issues: Number.MAX_SAFE_INTEGER,
        pulls: 1,
        countsAt: at,
      }));
    const result = await f.start(pop, at);
    assert.equal(result.status, 200);
    assert.equal(result.body.capacityBlocked, true);
    assert.equal(result.body.sumOverflow, true);
    assert.equal(result.body.observedTotal, null);
    assert.equal(result.body.metadataAccepted, true);
    await assert.rejects(f.read(), /coverage_build_read_failed/);
    const anonymous = await f.anonymous();
    assert.equal(anonymous.status, 503);
    assert.ok(!(await anonymous.text()).includes("fixture/"));
    assert.ok(f.states().every((r) => r.state.repository.issues === Number.MAX_SAFE_INTEGER));
    f.unchanged();
  } finally {
    f.close();
  }
});
test("malformed count metadata is rejected without becoming a new population authority", async () => {
  const f = await capacityFixture();
  try {
    const before = JSON.stringify(f.states());
    for (const invalid of [
      undefined,
      null,
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "20001",
    ]) {
      const at = new Date().toISOString(),
        pop = f.repositories.map((r, i) => ({
          ...r,
          countsAt: at,
          ...(i === 0 ? { issues: invalid } : {}),
        }));
      const result = await f.start(pop, at);
      assert.equal(result.status, 409);
      assert.equal(JSON.stringify(f.states()), before);
      f.unchanged();
    }
    const at = new Date().toISOString(),
      wide = [
        ...f.repositories.map((r) => ({ ...r, countsAt: at })),
        ...Array.from({ length: 511 }, (_, i) => ({
          repo: "fixture/bad-meta-" + i,
          id: "ID_bad-meta-" + i,
          revision: "policy-v1",
          scope: "eligible",
          visibility: "public",
          issues: 0 as number | undefined,
          pulls: 0,
          countsAt: at,
        })),
      ];
    wide[wide.length - 1]!.issues = undefined;
    assert.equal((await f.start(wide, at)).status, 409);
    assert.equal(JSON.stringify(f.states()), before);
    f.unchanged();
    assert.equal((await f.read()).coverage_status, "complete");
  } finally {
    f.close();
  }
});
test("valid metadata above the repository bound is unavailable, never truncated into an old complete cohort", async () => {
  const f = await capacityFixture();
  try {
    const at = new Date().toISOString(),
      pop = [
        ...f.repositories.map((r) => ({ ...r, countsAt: at })),
        ...Array.from({ length: 511 }, (_, i) => ({
          repo: "fixture/meta-" + i,
          id: "ID_meta-" + i,
          revision: "policy-v1",
          scope: "eligible",
          visibility: "public",
          issues: 0,
          pulls: 0,
          countsAt: at,
        })),
      ];
    const result = await f.start(pop, at);
    assert.equal(result.body.capacityBlocked, true);
    assert.equal(result.body.population, 513);
    assert.equal(result.body.capacityReason, "repository_metadata_capacity");
    assert.equal(f.states().length, 2);
    await assert.rejects(f.read(), /coverage_build_read_failed/);
    f.unchanged();
    const truncated = await f.start(pop.slice(0, 512), at);
    assert.equal(truncated.body.metadataAccepted, false);
    assert.equal(truncated.body.capacityBlocked, true);
    await assert.rejects(f.read(), /coverage_build_read_failed/);
  } finally {
    f.close();
  }
});
test("an older supported-scope replay cannot resurrect the previous complete denominator", async () => {
  const f = await capacityFixture();
  try {
    const old = JSON.parse(
      String(
        Array.from(
          f.a.storage.sql.exec("SELECT value FROM coverage_census_meta WHERE key='population'"),
        )[0]!.value,
      ),
    );
    const at = new Date().toISOString(),
      pop = f.repositories.map((r, i) => ({
        ...r,
        countsAt: at,
        ...(i === 0 ? { issues: 20001 } : {}),
      }));
    await f.start(pop, at);
    const replay = await f.start(f.repositories, old.countWitnessAt);
    assert.equal(replay.body.metadataAccepted, false);
    assert.equal(replay.body.stale, true);
    assert.equal(replay.body.capacityBlocked, true);
    assert.equal((await f.read()).coverage_status, "unknown");
    assert.equal(f.states()[0]!.state.repository.issues, 20001);
    f.unchanged();
  } finally {
    f.close();
  }
});
