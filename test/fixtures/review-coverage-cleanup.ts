import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CENSUS } from "../../src/review-coverage-census.ts";
import { ExactReviewQueue } from "../../dashboard/worker.ts";
import { censusHttpControl } from "../../dist/repair/review-coverage-census.js";
import { readCoverageForBuild } from "../../dashboard-site/scripts/coverage.ts";
import { withReplayClock } from "../../docs/proof/ui-live-coverage/replay-clock.mjs";
import { coverageCliFixture } from "./review-coverage-cli.ts";

export async function cleanupProgressScenario(
  options: { count?: number; mixed?: boolean; interrupt?: boolean } = {},
) {
  const count = options.count ?? CENSUS.identities,
    mixed = options.mixed === true,
    coreCount = count - (mixed ? 2 : 0),
    issues = Math.ceil(coreCount / 2),
    pulls = Math.floor(coreCount / 2),
    epoch = Date.UTC(2026, 10, 5, 0),
    f = await coverageCliFixture(
      mixed
        ? [
            { name: "core", issues, pulls },
            { name: "peer", issues: 2, pulls: 0 },
            { name: "zero", issues: 0, pulls: 0 },
          ]
        : [{ name: "core", issues, pulls }],
      epoch,
    ),
    hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex"),
    sql = (q: string, ...args: unknown[]) => Array.from(f.authority.storage.sql.exec(q, ...args)),
    orphan = () =>
      Number(sql("SELECT COUNT(*) AS n FROM coverage_census_items WHERE slot='orphan'")[0]!.n),
    coreOrphans = () =>
      Number(
        sql(
          "SELECT COUNT(*) AS n FROM coverage_census_items WHERE repo='openclaw/core' AND slot='orphan'",
        )[0]!.n,
      ),
    state = () => f.states().find((r) => r.repo === "openclaw/core")?.state,
    latest = () => structuredClone(state().complete),
    payload = (generation: string) =>
      hash(
        sql(
          "SELECT * FROM coverage_census_items WHERE repo='openclaw/core' AND generation=? ORDER BY kind,number",
          generation,
        ),
      );
  const originalQuery = f.model.query,
    retiredStop = new Error("controlled lost promotion acknowledgement"),
    cleanupStop = new Error("controlled lost cleanup acknowledgement"),
    trace: Record<string, unknown>[] = [],
    opportunities: Record<string, unknown>[] = [],
    perConnection = new Map<string, number>();
  let retiredPayloadSha256: string | undefined;
  let phase = "seed-first",
    identityQueries = 0,
    g1 = "",
    retired = false,
    lastOrphans = 0,
    interrupted = false,
    firstPure: { queries: number; window: unknown; payload: string } | undefined;
  f.model.query = (query) => {
    identityQueries++;
    for (const m of query.matchAll(
      /name:"([^"]+)"\) \{ id nameWithOwner (issues|pullRequests)\(/g,
    )) {
      const key = m[1] + ":" + m[2];
      perConnection.set(key, (perConnection.get(key) ?? 0) + 1);
    }
    return originalQuery(query);
  };
  f.observe((event) => {
    const rows = orphan(),
      s = state(),
      response = f.responses.at(-1)?.body;
    if (
      phase === "seed-second" &&
      g1 &&
      s?.complete &&
      s.complete.generation !== g1 &&
      coreOrphans() === coreCount
    ) {
      retired = true;
      retiredPayloadSha256 = payload(s.complete.generation);
      lastOrphans = rows;
      trace.push({
        phase: "actual-retirement",
        path: event.path,
        orphans: rows,
        coreOrphans: coreOrphans(),
        window: latest(),
        response,
      });
      throw retiredStop;
    }
    if (phase === "cleanup" || phase === "cleanup-resumed") {
      const removed = Math.max(0, lastOrphans - rows);
      assert.ok(removed <= CENSUS.cleanupRows, "one control call respects row deletion cap");
      trace.push({
        phase,
        path: event.path,
        orphansBefore: lastOrphans,
        orphansAfter: rows,
        removed,
        identityQueries,
        response,
      });
      lastOrphans = rows;
      if (
        event.path.endsWith("/census/next") &&
        response?.pending === true &&
        Array.isArray(response.work) &&
        response.work.length === 0 &&
        !firstPure
      )
        firstPure = {
          queries: identityQueries,
          window: latest(),
          payload: payload(s.complete!.generation),
        };
      if (
        options.interrupt &&
        !interrupted &&
        event.path.endsWith("/census/next") &&
        removed > 0 &&
        response?.pending === true &&
        Array.isArray(response.work) &&
        response.work.length === 0
      ) {
        interrupted = true;
        f.kill();
        throw cleanupStop;
      }
    }
  });
  const invoke = async (label: string) => {
    const before = identityQueries,
      controls = f.calls.length;
    perConnection.clear();
    let run;
    try {
      run = await f.run("coverage");
    } catch (error) {
      if (error !== retiredStop && error !== cleanupStop) throw error;
      run = {
        inventory: identityQueries - before,
        counts: 1,
        legacy: 0,
        calls: f.calls.slice(controls),
      };
    }
    assert.ok(identityQueries - before <= CENSUS.queries);
    for (const n of perConnection.values()) assert.ok(n <= CENSUS.pagesPerConnection);
    const nexts = f.calls.slice(controls).filter((c) => c.path.endsWith("/census/next")).length;
    assert.ok(nexts <= CENSUS.controlSteps);
    opportunities.push({
      label,
      at: new Date(f.time).toISOString(),
      elapsedMs: f.time - epoch,
      identityQueries: identityQueries - before,
      nexts,
      perConnectionQueries: Object.fromEntries(perConnection),
      active: structuredClone(state()?.active ?? null),
      coreOrphans: coreOrphans(),
      window: latest(),
      run: { inventory: run.inventory, counts: run.counts, legacy: run.legacy },
    });
    return { run, nexts, queries: identityQueries - before };
  };
  try {
    for (let n = 0; n < 32 && !state()?.complete; n++) {
      if (n) f.advance(CENSUS.refreshMs);
      await invoke("seed-first");
    }
    assert.ok(state().complete, "two 10k connections must qualify within supported window");
    g1 = state().complete.generation;
    const firstWindow = latest();
    assert.ok(
      Date.parse(firstWindow.end) - Date.parse(firstWindow.start) <= CENSUS.observationMaxAgeMs,
    );
    phase = "seed-second";
    for (let n = 0; n < 32 && !retired; n++) {
      f.advance(CENSUS.refreshMs);
      await invoke("seed-second");
    }
    assert.equal(retired, true, "actual promotion must retire the full old generation");
    assert.equal(coreOrphans(), coreCount);
    const qualified = latest(),
      protectedPayload = payload(qualified.generation),
      canonical = JSON.stringify(f.authority.canonicalState()),
      admission = JSON.stringify(
        sql("SELECT item_key,item_json FROM exact_review_queue_items ORDER BY item_key"),
      );
    phase = "cleanup";
    f.advance(CENSUS.refreshMs);
    identityQueries = 0;
    const cleanup = await invoke("cleanup");
    if (options.interrupt) {
      assert.equal(interrupted, true);
      const start = f.calls.findLast((c) => c.path.endsWith("/census/start"))!.body!,
        remaining = orphan(),
        replayed = await f.replayStart(start);
      assert.equal(
        orphan(),
        remaining,
        "replayed accepted start cannot double-charge cleanup after a next ACK was lost",
      );
      assert.ok(replayed);
      f.authority.queue = new ExactReviewQueue({ storage: f.authority.storage }, f.authority.env);
      f.advance(CENSUS.refreshMs);
      f.kill(false);
      phase = "cleanup-resumed";
      await invoke("cleanup-resumed");
    }
    assert.equal(
      coreOrphans(),
      0,
      "bounded producer control loop must drain every removable retired identity",
    );
    assert.equal(orphan(), 0);
    assert.equal(
      JSON.stringify(latest()),
      JSON.stringify(qualified),
      "cleanup alone cannot restamp the qualified observation",
    );
    assert.equal(
      payload(qualified.generation),
      protectedPayload,
      "latest complete payload is protected",
    );
    assert.equal(JSON.stringify(f.authority.canonicalState()), canonical);
    assert.equal(
      JSON.stringify(
        sql("SELECT item_key,item_json FROM exact_review_queue_items ORDER BY item_key"),
      ),
      admission,
    );
    if (!mixed)
      assert.equal(identityQueries, 0, "pure orphan cleanup consumes no GitHub identity queries");
    if (mixed) {
      assert.ok(identityQueries > 0);
      assert.ok(
        trace.some(
          (r) =>
            Number(r.orphansAfter) > 0 &&
            Array.isArray((r.response as { work?: unknown[] })?.work) &&
            (r.response as { work: unknown[] }).work.length > 0,
        ),
        "normal work is returned while removable cleanup remains",
      );
      assert.equal(
        (await f.read()).fleets.find((r: { repo: string }) => r.repo === "openclaw/peer")
          .coverage_status,
        "complete",
      );
    }
    if (coreCount > CENSUS.cleanupRows * 2 && !options.interrupt) {
      assert.ok(firstPure);
      assert.equal(
        identityQueries,
        firstPure.queries,
        "empty pending cleanup suffix never queries GitHub",
      );
      assert.equal(JSON.stringify(firstPure.window), JSON.stringify(qualified));
      assert.equal(firstPure.payload, protectedPayload);
    }
    const removals = trace
      .filter((r) => typeof r.removed === "number" && r.removed > 0)
      .map((r) => Number(r.removed));
    assert.ok(removals.every((n) => n <= CENSUS.cleanupRows));
    assert.ok(
      removals.some((n) => n < CENSUS.cleanupRows),
      "last short batch is observed",
    );
    const control = censusHttpControl({
        baseUrl: "https://census-cli.invalid",
        secret: f.authority.secret,
        fetchImpl: globalThis.fetch,
      }),
      receiptCount = Number(sql("SELECT COUNT(*) AS n FROM coverage_census_receipts")[0]!.n);
    // The finished run released its lease, so the probe takes a fresh one like the next run would.
    const idle = await withReplayClock(f.time, async () => {
      await control("/internal/review-coverage/census/prepare", {
        version: 2,
        attempt: "idle-probe",
      });
      return control("/internal/review-coverage/census/next", {
        version: 2,
        attempt: "idle-probe",
        excluded: [],
      });
    });
    assert.deepEqual(idle.work, []);
    assert.equal(idle.pending, false, "nothing removable means no pending spin");
    assert.equal(
      Number(sql("SELECT COUNT(*) AS n FROM coverage_census_receipts")[0]!.n),
      receiptCount,
      "idle read cannot fabricate a progress receipt",
    );
    const anonymousResponse = await f.anonymous();
    assert.equal(anonymousResponse.status, 200);
    const anonymous = await anonymousResponse.json();
    assert.ok(!JSON.stringify(anonymous).includes(g1));
    assert.ok(!JSON.stringify(anonymous).includes("orphansBefore"));
    const readAt = (at: number) =>
      withReplayClock(at, () =>
        readCoverageForBuild(f.authority.secret, globalThis.fetch, "https://census-cli.invalid"),
      );
    phase = "eligible-next-start";
    f.advance(CENSUS.refreshMs);
    const resumed = await invoke("eligible-next-start");
    assert.ok(
      state().active,
      "the next ordinary opportunity can start fresh work, not 79 opportunities later",
    );
    assert.notEqual(state().active.id, qualified.generation);
    assert.ok(resumed.queries > 0);
    assert.equal(JSON.stringify(latest()), JSON.stringify(qualified));
    const six = await readAt(Date.parse(qualified.start) + 6 * 60 * 60_000);
    assert.equal(
      six.fleets.find((r: { repo: string }) => r.repo === "openclaw/core").coverage_status,
      "complete",
    );
    const thirteen = await readAt(Date.parse(qualified.start) + 13 * 60 * 60_000);
    assert.equal(
      thirteen.fleets.find((r: { repo: string }) => r.repo === "openclaw/core").coverage_status,
      "unknown",
    );
    assert.equal(JSON.stringify(latest()), JSON.stringify(qualified));
    return {
      count,
      coreCount,
      mixed,
      interrupted,
      coreOrphansAtRetirement: coreCount,
      coreOrphansAfter: 0,
      controlBudget: CENSUS.controlSteps,
      queryBudget: CENSUS.queries,
      cleanupRows: CENSUS.cleanupRows,
      cleanup,
      cleanupQueries: opportunities
        .filter((p) => String(p.label).startsWith("cleanup"))
        .map((p) => p.identityQueries),
      maxDeletedPerCall: Math.max(...removals),
      shortBatches: removals.filter((n) => n < CENSUS.cleanupRows),
      trace,
      opportunities,
      qualifiedWindow: qualified,
      latestPayloadSha256: protectedPayload,
      canonicalUnchanged: true,
      admissionUnchanged: true,
      sixHourStatus: "complete",
      thirteenHourStatus: "unknown",
      legacyProjectionLimits:
        "Two connections split <=20k identities; virtual20-minute cadence. This does not promise one20k connection qualification or live production latency.",
    };
  } finally {
    const output = process.env.CENSUS_CLEANUP_TRACE_OUTPUT;
    if (output) {
      mkdirSync(output, { recursive: true });
      writeFileSync(
        join(output, (mixed ? "mixed" : "full") + "-trace.json"),
        JSON.stringify(
          {
            count,
            coreCount,
            mixed,
            phase,
            identityQueries,
            coreOrphans: coreOrphans(),
            allOrphans: orphan(),
            latest: state()?.complete,
            retiredPayloadSha256,
            currentLatestPayloadSha256: state()?.complete
              ? payload(state()!.complete.generation)
              : null,
            trace,
            opportunities,
          },
          null,
          2,
        ),
      );
    }
    f.close();
  }
}

export async function noWorkProgressScenario() {
  let zeroQueries = 0,
    zeroNexts = 0,
    retryQueries = 0,
    retryNexts = 0;
  const empty = await coverageCliFixture([{ name: "empty", issues: 0, pulls: 0 }]);
  try {
    const run = await empty.run("coverage");
    zeroQueries = run.inventory;
    zeroNexts = empty.calls.filter((r) => r.path.endsWith("/census/next")).length;
    assert.ok(run.inventory <= 25);
    assert.equal(empty.inventory()!.repositories[0]!.items.length, 0);
    const response = empty.responses.filter((r) => r.path.endsWith("/census/next")).at(-1)!;
    assert.deepEqual(response.body.work, []);
    assert.equal(response.body.pending, false);
    assert.ok(empty.calls.filter((r) => r.path.endsWith("/census/next")).length < 200);
  } finally {
    empty.close();
  }
  const failed = await coverageCliFixture([{ name: "retry", issues: 1, pulls: 0 }]);
  try {
    failed.model.query = () => {
      throw new Error("controlled source read failure");
    };
    const run = await failed.run("coverage");
    retryQueries = run.inventory;
    retryNexts = failed.calls.filter((r) => r.path.endsWith("/census/next")).length;
    assert.ok(run.inventory <= 1);
    const response = failed.responses.filter((r) => r.path.endsWith("/census/next")).at(-1)!;
    assert.deepEqual(response.body.work, []);
    assert.equal(response.body.pending, false);
    assert.ok(failed.calls.filter((r) => r.path.endsWith("/census/next")).length < 200);
    assert.ok(failed.states().some((s) => s.state.retryAt > failed.time));
  } finally {
    failed.close();
  }
  return { zeroQueries, zeroNexts, retryQueries, retryNexts, pending: false };
}
