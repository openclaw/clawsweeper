import assert from "node:assert/strict";
import test from "node:test";
import { censusFixture } from "./fixtures/review-coverage-census.ts";
import { CENSUS, censusPage, censusSignatureInput } from "../src/review-coverage-census.ts";

test("production-sized 145-repo census completes bounded sweeps across restarts", async () => {
  const f = censusFixture([
    { name: "core", issues: 4865, pulls: 2881 },
    { name: "enterprise", issues: 107, pulls: 153 },
    ...Array.from({ length: 143 }, (_, i) => ({ name: "small" + i, issues: 1, pulls: 0 })),
  ]);
  const traces = [];
  let completed = false;
  for (let run = 0; run < 40; run++) {
    const result = await f.run();
    assert.ok(result.queries <= 25);
    assert.equal(result.failed, 0);
    traces.push(result);
    const state = f.states().find((x) => x.repo === "fixture/core")!.state;
    if (state.complete) {
      completed = true;
      assert.equal(state.complete.issues + state.complete.pulls, 7746);
      if (f.states().every((x) => x.state.complete)) break;
    }
    f.restart();
  }
  assert.ok(completed, "core must finish, not repeat its first 1,000 forever");
  assert.ok(
    traces.some((t) => t.trace.some((w) => w.repo === "fixture/core" && w.cursor === "c1000")),
  );
  assert.ok(
    f.states().filter((x) => x.repo.startsWith("fixture/small") && x.state.complete).length === 143,
  );
  const size = f.db.prepare("SELECT COUNT(*) n,SUM(bytes) bytes FROM coverage_census_items").get()!;
  assert.ok(Number(size.n) <= 2 * CENSUS.identities);
  assert.ok(Number(size.bytes) <= 2 * CENSUS.copyBytes);
  f.db.close();
});
test("950 x 3 shares the fleet allowance fairly and finishes", async () => {
  const f = censusFixture(["one", "two", "three"].map((name) => ({ name, issues: 950, pulls: 0 })));
  for (let i = 0; i < 12 && (i === 0 || !f.states().every((x) => x.state.complete)); i++) {
    const r = await f.run();
    assert.ok(r.queries <= 25);
    assert.equal(r.failed, 0);
    f.restart();
  }
  assert.equal(f.states().filter((x) => x.state.complete).length, 3);
  f.db.close();
});
test("accepted pages survive lost HTTP response and a 12-hour process interruption", async () => {
  const f = censusFixture([{ name: "core", issues: 1501, pulls: 1101 }]);
  f.loseResponse();
  f.interrupt(4);
  await assert.rejects(f.run(), /simulated process interruption/);
  const before = f.states()[0]!.state.active;
  assert.ok(before.revision >= 4);
  const cursor = before.connections.issue.cursor;
  f.restart(12 * 60 * 60_000);
  const r = await f.run();
  assert.equal(r.failed, 0);
  assert.equal(r.trace[0]!.cursor, before.connections[r.trace[0]!.kind].cursor);
  assert.ok(cursor !== null);
  f.db.close();
});
test("bounded membership/field churn finishes its pass then converges without ordinary-run prefix resets", async () => {
  const f = censusFixture([
    { name: "core", issues: 1205, pulls: 1105 },
    { name: "small", issues: 1, pulls: 0 },
  ]);
  let changes = 0;
  f.setMutation((name, q) => {
    if (name !== "core" || q % 7 !== 0 || changes >= 4) return;
    changes++;
    const r = f.members.get(name)!;
    if (changes === 1) r.issues.push(50000);
    if (changes === 2) {
      r.issues.shift();
      r.issues.push(50001);
    }
    if (changes === 3) {
      r.head = "b".repeat(40);
      r.labels = ["changed"];
      r.reopened = new Date(f.time).toISOString();
    }
    if (changes === 4) {
      r.issues.push(50002);
      r.updated = new Date(f.time).toISOString();
    }
  });
  let lastPass = 1,
    previousCursor: string | null = null,
    done = false;
  for (let i = 0; i < 30; i++) {
    const r = await f.run();
    assert.equal(r.failed, 0);
    const state = f.states().find((x) => x.repo === "fixture/core")!.state;
    if (state.complete) {
      done = true;
      break;
    }
    const active = state.active;
    if (active.pass === lastPass && previousCursor) {
      const own = r.trace.find((w) => w.repo === "fixture/core" && w.kind === "issue");
      if (own) assert.notEqual(own.cursor, null);
    }
    lastPass = active.pass;
    previousCursor = active.connections.issue.cursor;
    f.restart();
  }
  assert.equal(changes, 4);
  assert.ok(done);
  assert.ok(f.states().find((x) => x.repo === "fixture/small")!.state.complete);
  f.db.close();
});
test("sustained changing fields remain Unknown while small repositories keep completing", async () => {
  const f = censusFixture([
    { name: "core", issues: 1001, pulls: 1001 },
    { name: "small", issues: 1, pulls: 0 },
  ]);
  f.setMutation((name) => {
    if (name === "core")
      f.members.get(name)!.updated = new Date(f.time - 60_000 + f.queryCount).toISOString();
  });
  for (let i = 0; i < 15; i++) {
    const r = await f.run();
    assert.ok(r.queries <= 25);
    assert.equal(r.failed, 0);
    f.restart();
  }
  const states = f.states();
  assert.equal(states.find((x) => x.repo === "fixture/core")!.state.complete, null);
  assert.ok(states.find((x) => x.repo === "fixture/core")!.state.active.pass > 2);
  assert.ok(states.find((x) => x.repo === "fixture/small")!.state.complete);
  f.db.close();
});
test("exact page replay, stale CAS and malformed chunks cannot advance twice", async () => {
  const f = censusFixture([{ name: "small", issues: 1, pulls: 0 }]),
    attempt = "attempt-a";
  await f.store.start({ version: 2, attempt, repositories: f.population() }, f.time);
  const work = (f.store.next({ version: 2, attempt }, f.time) as { work: unknown[] })
    .work[0] as Record<string, unknown>;
  const page = {
    ...work,
    items: [
      {
        number: 1,
        kind: work.kind,
        updated_at: new Date(f.time).toISOString(),
        reopened_at: null,
        labels: [],
      },
    ],
    total: 1,
    next: null,
    hasNext: false,
    observedAt: new Date(f.time).toISOString(),
  };
  const value = { version: 2, attempt, requestId: "page-a", pages: [page] };
  await f.store.accept(value, f.time);
  const before = f.states()[0]!.state.active.revision;
  assert.equal((await f.store.accept(value, f.time)).replayed, true);
  assert.equal(f.states()[0]!.state.active.revision, before);
  await assert.rejects(
    f.store.accept({ ...value, requestId: "page-b" }, f.time),
    /checkpoint conflict/,
  );
  await assert.rejects(
    f.store.accept(
      {
        ...value,
        requestId: "page-c",
        pages: [{ ...page, items: [{ ...page.items[0], labels: ["x".repeat(101)] }] }],
      },
      f.time,
    ),
    /label/,
  );
  assert.equal(f.states()[0]!.state.active.revision, before);
  f.db.close();
});
test("page bounds and fixed path/method signature domain are explicit", () => {
  assert.throws(() => censusSignatureInput("/internal/review-coverage/build", "{}"), /path/);
  assert.match(
    censusSignatureInput("/internal/review-coverage/census/accept", "{}"),
    /^clawsweeper-coverage-checkpoint-v2\nPOST/,
  );
  assert.throws(
    () =>
      censusPage({
        kind: "issue",
        items: [],
        hasNext: true,
        next: "c1",
        cursor: null,
        observedAt: "2026-11-04T12:00:00Z",
      }),
    /pagination/,
  );
});

test("historical 7,743 cohort and isolated stable 260 both complete verified generations", async () => {
  for (const [issues, pulls, total] of [
    [4862, 2881, 7743],
    [107, 153, 260],
  ]) {
    const f = censusFixture([{ name: "core", issues: issues!, pulls: pulls! }]);
    for (let run = 0; run < 20; run++) {
      const r = await f.run();
      assert.ok(r.queries <= 25);
      assert.equal(r.failed, 0);
      if (f.states()[0]!.state.complete) break;
      f.restart();
    }
    assert.equal(f.states()[0]!.state.complete.issues + f.states()[0]!.state.complete.pulls, total);
    f.db.close();
  }
});
test("qualification revocation, missing chunks and oversized cohorts fail closed", async () => {
  const f = censusFixture([{ name: "small", issues: 1, pulls: 0 }]);
  await f.run();
  assert.equal(f.store.inventory(f.time)!.repositories[0]!.complete, true);
  f.db.exec("DELETE FROM coverage_census_items WHERE slot='complete'");
  assert.throws(() => [...f.store.inventory(f.time)!.repositories[0]!.items!], /chunk missing/);
  f.restart();
  const population = f
    .population()
    .map((r) => ({ ...r, revision: "revoked", visibility: "unknown" as const }));
  await f.store.start({ version: 2, attempt: "revoked", repositories: population }, f.time);
  assert.equal(f.store.inventory(f.time)!.repositories[0]!.complete, false);
  assert.equal(f.store.inventory(f.time)!.repositories[0]!.visibility, "unknown");
  f.restart();
  const unsupported = population.map((r) => ({ ...r, issues: 20000, pulls: 1 }));
  const result = await f.store.start(
    { version: 2, attempt: "capacity", repositories: unsupported },
    f.time,
  );
  assert.equal(result.ok, true);
  assert.equal(result.capacityBlocked, true);
  assert.equal(f.store.inventory(f.time)!.capacity_blocked, true);
  assert.ok(f.store.inventory(f.time)!.repositories.every((r) => r.complete === false));
  f.db.close();
});

test("a permanently failed repository is isolated after a batch error and cannot starve its peers", async () => {
  const f = censusFixture([
    { name: "bad", issues: 1, pulls: 0 },
    ...Array.from({ length: 12 }, (_, i) => ({ name: "good" + i, issues: 1, pulls: 0 })),
  ]);
  f.setMutation((name) => {
    if (name === "bad") throw new Error("controlled permanent upstream failure");
  });
  for (let run = 0; run < 8; run++) {
    const r = await f.run();
    assert.ok(r.queries <= 25);
    f.restart();
  }
  assert.equal(f.states().find((r) => r.repo === "fixture/bad")!.state.complete, null);
  assert.equal(
    f.states().filter((r) => r.repo.startsWith("fixture/good") && r.state.complete).length,
    12,
  );
  f.db.close();
});

test("cross-page re-observation marks a sweep unstable but cannot trap a stable suffix forever", async () => {
  const f = censusFixture([{ name: "core", issues: 201, pulls: 0 }]),
    attempt = "shifted-cursor";
  await f.store.start({ version: 2, attempt, repositories: f.population() }, f.time);
  const first = (
    f.store.next({ version: 2, attempt }, f.time) as { work: Record<string, unknown>[] }
  ).work[0]!;
  const items = (start: number) =>
    Array.from({ length: 100 }, (_, i) => ({
      number: start + i,
      kind: "issue",
      updated_at: new Date(f.time).toISOString(),
      reopened_at: null,
      labels: [],
    }));
  await f.store.accept(
    {
      version: 2,
      attempt,
      requestId: "prefix",
      pages: [
        {
          ...first,
          items: items(1),
          total: 201,
          next: "c100",
          hasNext: true,
          observedAt: new Date(f.time).toISOString(),
        },
      ],
    },
    f.time,
  );
  await f.store.accept(
    {
      version: 2,
      attempt,
      requestId: "shifted",
      pages: [
        {
          ...first,
          revisionNumber: 1,
          cursor: "c100",
          items: items(100),
          total: 201,
          next: "c200",
          hasNext: true,
          observedAt: new Date(f.time).toISOString(),
        },
      ],
    },
    f.time,
  );
  const active = f.states()[0]!.state.active;
  assert.equal(active.connections.issue.cursor, "c200");
  assert.equal(active.connections.issue.stable, false);
  assert.equal(f.states()[0]!.state.complete, null);
  f.restart();
  const result = await f.run();
  assert.equal(result.failed, 0);
  assert.equal(f.states()[0]!.state.complete.issues, 201);
  f.db.close();
});

test("corrupt retained prefixes cannot promote and only their generation is recollected", async () => {
  const f = censusFixture([{ name: "core", issues: 1501, pulls: 1101 }]);
  await f.run();
  f.restart();
  await f.run();
  assert.equal(f.states()[0]!.state.active.pass, 2);
  const row = f.db
    .prepare("SELECT rowid,payload FROM coverage_census_items WHERE seen=2 ORDER BY rowid LIMIT 1")
    .get()!;
  const payload = JSON.parse(String(row.payload));
  payload.labels = ["corrupted-after-accept"];
  const serialized = JSON.stringify(payload);
  f.db
    .prepare("UPDATE coverage_census_items SET payload=?,bytes=? WHERE rowid=?")
    .run(serialized, Buffer.byteLength(serialized), Number(row.rowid));
  // The ten-pages/connection/invocation bound can leave this second sweep
  // unfinished for another run. Reach its actual terminal acceptance, retaining
  // the assertion that corruption must be rejected rather than promoted.
  let failed = 0;
  for (let run = 0; run < 4 && failed === 0 && !f.states()[0]!.state.complete; run++) {
    f.restart();
    failed += (await f.run()).failed;
  }
  assert.ok(failed >= 1);
  assert.equal(f.states()[0]!.state.complete, null);
  assert.equal(f.states()[0]!.state.reason, "corrupt_census");
  for (let run = 0; run < 40 && !f.states()[0]!.state.complete; run++) {
    f.restart();
    await f.run();
  }
  assert.equal(f.states()[0]!.state.complete.issues, 1501);
  f.db.close();
});
test("post-promotion payload corruption fails the bounded projection read closed", async () => {
  const f = censusFixture([{ name: "small", issues: 1, pulls: 0 }]);
  await f.run();
  const row = f.db
    .prepare("SELECT rowid,payload FROM coverage_census_items WHERE slot='complete' LIMIT 1")
    .get()!;
  const payload = JSON.parse(String(row.payload));
  payload.labels = ["tampered"];
  const serialized = JSON.stringify(payload);
  f.db
    .prepare("UPDATE coverage_census_items SET payload=?,bytes=? WHERE rowid=?")
    .run(serialized, Buffer.byteLength(serialized), Number(row.rowid));
  assert.throws(() => [...f.store.inventory(f.time)!.repositories[0]!.items!], /stored integrity/);
  f.db.close();
});

test("a verified as-of generation remains valid through a six-hour refresh opportunity without retimestamping", async () => {
  const f = censusFixture([{ name: "stable", issues: 2, pulls: 0 }]);
  await f.run();
  const original = f.store.inventory(f.time)!.repositories[0]!;
  assert.equal(original.complete, true);
  f.restart(6 * 60 * 60_000);
  await f.store.start(
    { version: 2, attempt: "six-hour-refresh", repositories: f.population() },
    f.time,
  );
  const refreshing = f.store.inventory(f.time)!.repositories[0]!;
  assert.equal(refreshing.complete, true);
  assert.deepEqual(refreshing.collection_window, original.collection_window);
  const active = f.states()[0]!.state.active.id;
  f.restart(7 * 60 * 60_000);
  const stale = f.store.inventory(f.time)!.repositories[0]!;
  assert.equal(stale.complete, false);
  assert.equal(f.states()[0]!.state.active.id, active);
  assert.equal(stale.counts_observed_at, refreshing.counts_observed_at);
  f.db.close();
});

test("known capacity drift cannot silently revive an old complete generation", async () => {
  const f = censusFixture([{ name: "small", issues: 2, pulls: 0 }]);
  await f.run();
  f.restart(20 * 60_000);
  assert.equal(
    (
      await f.store.start(
        {
          version: 2,
          attempt: "capacity-drift",
          repositories: f.population().map((r) => ({ ...r, issues: 20000, pulls: 1 })),
        },
        f.time,
      )
    ).capacityBlocked,
    true,
  );
  f.restart();
  await f.store.start(
    { version: 2, attempt: "capacity-recovered", repositories: f.population() },
    f.time,
  );
  assert.equal(f.store.inventory(f.time)!.repositories[0]!.complete, false);
  f.db.close();
});
