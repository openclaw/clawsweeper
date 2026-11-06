import assert from "node:assert/strict";
import test from "node:test";
import { coverageCliFixture } from "../fixtures/review-coverage-cli.ts";

const twentyMinutes = 20 * 60_000,
  sixHours = 6 * 60 * 60_000;

for (const mode of ["normal-review", "hot-intake", "audit"]) {
  test(`${mode} keeps raw control failures private while remaining nonblocking`, async () => {
    const sentinel = "SENTINEL_PRIVATE_ERROR_TOKEN_repository_cursor";
    const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
    const fixtureFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...values) => warnings.push(values.join(" "));
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/census/start"))
        return Response.json(
          { error: sentinel, diagnostic: { phase: "start", category: "unclassified" } },
          { status: 409 },
        );
      return fixtureFetch(input, init);
    };
    try {
      await f.run(mode);
      const operational = [...f.logs, ...warnings].join("\n");
      assert.ok(!operational.includes(sentinel));
      assert.match(operational, /census_failed phase=start category=unclassified/);
      assert.match(operational, /queries=0 accepted=0 failed=0/);
      assert.match(operational, /continuing without blocking scheduled fanout work/);
    } finally {
      console.warn = originalWarn;
      f.close();
    }
  });
}

test("coverage, normal, hot and audit CLI modes share one v2 collector without v1 writes or cursor mutation", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
  try {
    for (const mode of ["normal-review", "hot-intake", "audit", "coverage"]) {
      const r = await f.run(mode);
      assert.ok(r.inventory > 0 && r.inventory <= 25);
      assert.equal(r.legacy, 0);
      assert.equal(r.calls.filter((c) => c.path.endsWith("/census/start")).length, 1);
      assert.equal(
        r.calls.filter((c) => c.path === "/internal/review-coverage/inventory").length,
        0,
      );
      assert.ok(
        r.calls
          .filter((c) => !c.path.startsWith("/internal/review-coverage/"))
          .every((c) => c.method === "GET"),
      );
      assert.equal(f.inventory()!.repositories[0]!.complete, true);
      f.advance(twentyMinutes);
    }
  } finally {
    f.close();
  }
});
test("ordinary twenty-minute CLI opportunities complete a production-sized cohort using one retained generation", async () => {
  const f = await coverageCliFixture([
    { name: "core", issues: 4865, pulls: 2881 },
    { name: "enterprise", issues: 107, pulls: 153 },
    ...Array.from({ length: 143 }, (_, i) => ({ name: "small" + i, issues: 1, pulls: 0 })),
  ]);
  try {
    const ids = new Set<string>();
    let complete = false;
    for (let run = 0; run < 28; run++) {
      const result = await f.run(["normal-review", "hot-intake", "audit"][run % 3]!);
      assert.ok(result.inventory <= 25);
      assert.equal(result.legacy, 0);
      const core = f.states().find((r) => r.repo === "openclaw/core")!.state;
      if (core.active && !core.complete) ids.add(core.active.id);
      if (f.inventory()!.repositories.every((r) => r.complete)) {
        complete = true;
        break;
      }
      f.advance(twentyMinutes);
    }
    assert.ok(complete);
    assert.equal(ids.size, 1);
    assert.equal(f.inventory()!.repositories.length, 145);
    assert.ok(
      f.calls.some(
        (c) =>
          c.path.endsWith("/accept") &&
          ((c.body?.pages ?? []) as { repo: string; cursor: string | null }[]).some(
            (p) => p.repo === "openclaw/core" && p.cursor === "c1000",
          ),
      ),
    );
    const read = await f.read();
    assert.equal(read.coverage_status, "complete");
    assert.equal(read.fleets.filter((r) => r.observation_scope === "eligible").length, 145);
  } finally {
    f.close();
  }
});
test("six-hour coverage cadence retains original evidence and a thirteen-hour gap expires it", async () => {
  const f = await coverageCliFixture([{ name: "small", issues: 2, pulls: 0 }]);
  try {
    await f.run("coverage");
    const original = f.inventory()!.repositories[0]!.collection_window!;
    f.advance(sixHours);
    const before = f.inventory()!.repositories[0]!;
    assert.equal(before.complete, true);
    assert.deepEqual(before.collection_window, original);
    await f.run("coverage");
    const next = f.inventory()!.repositories[0]!.collection_window!;
    assert.notEqual(next.published_at, original.published_at);
    const countsAt = f.inventory()!.repositories[0]!.counts_observed_at;
    f.advance(13 * 60 * 60_000);
    assert.equal(f.inventory()!.repositories[0]!.complete, false);
    assert.equal(f.inventory()!.repositories[0]!.counts_observed_at, countsAt);
  } finally {
    f.close();
  }
});
test("explicit legacy collection remains separate and cannot replace the v2 read authority", async () => {
  const f = await coverageCliFixture([{ name: "small", issues: 2, pulls: 0 }]);
  try {
    await f.run("coverage");
    const before = JSON.stringify(f.states());
    f.advance(twentyMinutes);
    const legacy = await f.run("normal-review", "v1");
    assert.equal(legacy.inventory, 0);
    assert.ok(legacy.legacy > 0);
    assert.ok(legacy.calls.some((c) => c.path === "/internal/review-coverage/inventory"));
    assert.equal(JSON.stringify(f.states()), before);
    assert.equal(Date.parse(f.authority.persisted().generated_at), f.time);
    assert.equal((await f.read()).coverage_status, "complete");
    const modern = await f.run("hot-intake");
    assert.ok(modern.inventory > 0);
    assert.equal(modern.legacy, 0);
    assert.equal(f.inventory()!.repositories[0]!.complete, true);
  } finally {
    f.close();
  }
});

test("unchanged refresh serving stops immediately on observed equal-count field or membership drift", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
  try {
    await f.run("coverage");
    const original = f.inventory()!.repositories[0]!.collection_window!;
    f.advance(twentyMinutes);
    const r = f.model.members.get("core")!;
    r.issues.shift();
    r.issues.push(50000);
    r.head = "b".repeat(40);
    r.labels = ["changed"];
    r.updated = new Date(f.time).toISOString();
    r.reopened = r.updated;
    const observations: { path: string; complete: boolean; published: string | null }[] = [];
    f.observe((event) => {
      const current = f.inventory()!.repositories[0]!;
      observations.push({
        path: event.path,
        complete: current.complete === true,
        published: current.collection_window?.published_at ?? null,
      });
    });
    await f.run("hot-intake");
    assert.equal(observations.find((e) => e.path.endsWith("/start"))!.complete, true);
    assert.equal(
      observations.find((e) => e.path.endsWith("/start"))!.published,
      original.published_at,
    );
    assert.ok(observations.some((e) => e.path.endsWith("/accept") && !e.complete));
    assert.equal(f.inventory()!.repositories[0]!.complete, true);
    assert.notEqual(
      f.inventory()!.repositories[0]!.collection_window!.published_at,
      original.published_at,
    );
  } finally {
    f.close();
  }
});
test("a twelve-hour interruption preserves the active generation but cannot promote an over-age collection window", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 4865, pulls: 2881 }]);
  try {
    await f.run("normal-review");
    const id = f.states()[0]!.state.active.id;
    f.advance(12 * 60 * 60_000);
    let complete = false;
    for (let run = 0; run < 30; run++) {
      await f.run(run % 2 ? "hot-intake" : "normal-review");
      const state = f.states()[0]!.state;
      if (state.complete) {
        complete = true;
        assert.equal(state.complete.generation, id);
        assert.ok(
          Date.parse(state.complete.end) - Date.parse(state.complete.started) <= 12 * 60 * 60_000,
        );
        assert.ok(Date.parse(state.complete.started) > Date.parse(state.complete.attemptStarted));
        break;
      }
      assert.equal(state.active.id, id);
      f.advance(twentyMinutes);
    }
    assert.ok(complete);
  } finally {
    f.close();
  }
});

test("a v2 control error never falls back to a second legacy query budget", async () => {
  const f = await coverageCliFixture([{ name: "small", issues: 2, pulls: 0 }]);
  try {
    await f.run("coverage");
    const before = JSON.stringify(f.states());
    f.advance(twentyMinutes);
    f.failControls(true);
    const result = await f.run("normal-review");
    assert.equal(result.inventory, 0);
    assert.equal(result.legacy, 0);
    assert.equal(
      result.calls.filter((c) => c.path === "/internal/review-coverage/inventory").length,
      0,
    );
    assert.equal(JSON.stringify(f.states()), before);
  } finally {
    f.close();
  }
});

test("actual CLI count growth transitions metadata to bounded Unknown with zero identity queries", async () => {
  for (const kind of ["issues", "pulls"]) {
    const f = await coverageCliFixture([
      { name: "core", issues: 2, pulls: 1 },
      { name: "good", issues: 1, pulls: 0 },
    ]);
    try {
      await f.run("coverage");
      const original = f.states().map((r) => ({ repo: r.repo, complete: r.state.complete }));
      const rows = JSON.stringify(
        Array.from(
          f.authority.storage.sql.exec(
            "SELECT * FROM coverage_census_items ORDER BY repo,generation,kind,number",
          ),
        ),
      );
      f.advance(twentyMinutes);
      f.setCountWitness("core", kind === "issues" ? 20001 : 2, kind === "pulls" ? 20001 : 1);
      const result = await f.run("normal-review");
      assert.equal(result.inventory, 0);
      assert.equal(result.legacy, 0);
      const response = f.responses.filter((r) => r.path.endsWith("/start")).at(-1)!;
      assert.equal(response.status, 200);
      assert.equal(response.body.metadataAccepted, true);
      assert.equal(response.body.capacityBlocked, true);
      const read = await f.read();
      assert.equal(read.coverage_status, "unknown");
      assert.equal(read.fleets.find((r) => r.repo === "openclaw/core").coverage_status, "unknown");
      assert.equal(read.fleets.find((r) => r.repo === "openclaw/good").coverage_status, "complete");
      assert.equal(read.totals.coverage_percent, null);
      assert.deepEqual(
        f.states().map((r) => ({ repo: r.repo, complete: r.state.complete })),
        original,
      );
      assert.equal(
        JSON.stringify(
          Array.from(
            f.authority.storage.sql.exec(
              "SELECT * FROM coverage_census_items ORDER BY repo,generation,kind,number",
            ),
          ),
        ),
        rows,
      );
    } finally {
      f.close();
    }
  }
});
test("a new over-capacity CLI repository cannot leave the old fleet percentage authoritative", async () => {
  const f = await coverageCliFixture([{ name: "good", issues: 2, pulls: 0 }]);
  try {
    await f.run("coverage");
    f.advance(twentyMinutes);
    f.addCountedRepository("new-large", 20001, 0);
    const result = await f.run("hot-intake");
    assert.equal(result.inventory, 0);
    const read = await f.read();
    assert.equal(read.coverage_status, "unknown");
    assert.equal(read.totals.coverage_percent, null);
    assert.ok(
      read.fleets.some((r) => r.repo === "openclaw/new-large" && r.census_status === "unknown"),
    );
    assert.equal(read.fleets.find((r) => r.repo === "openclaw/good").coverage_status, "complete");
  } finally {
    f.close();
  }
});
