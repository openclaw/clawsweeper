import assert from "node:assert/strict";
import worker from "../../dashboard/worker.ts";
import { ReviewCoverageCensusStore } from "../../dashboard/review-coverage-census.ts";
import { authorityFixture } from "../../docs/proof/ui-live-coverage/coverage-authority-fixture.mjs";
import { withReplayClock } from "../../docs/proof/ui-live-coverage/replay-clock.mjs";
import { censusFixture } from "./review-coverage-census.ts";
import {
  censusHttpControl,
  runReviewCoverageCensus,
} from "../../dist/repair/review-coverage-census.js";
import { CENSUS } from "../../src/review-coverage-census.ts";
import { readCoverageForBuild } from "../../dashboard-site/scripts/coverage.ts";

// Actual producer -> signed Worker -> DO/SQLite at production quotas. Only GH,
// storage adapters and observation clock are controlled. No live API is used.
export async function runBytePressureScenario(
  options: {
    fault?: boolean;
    overcap?: boolean;
    growthOnExisting?: boolean;
    tinyPrefix?: boolean;
  } = {},
) {
  const logicalCount = options.tinyPrefix ? 4000 : 3000;
  const a = await authorityFixture(),
    model = censusFixture([
      { name: "core", issues: logicalCount, pulls: 0 },
      { name: "other", issues: 1, pulls: 0 },
    ]);
  const core = model.members.get("core")!,
    ascii = Array.from({ length: 100 }, (_, i) => String(i).padStart(3, "0") + "x".repeat(97)),
    wide = Array.from({ length: 100 }, (_, i) => String(i).padStart(3, "0") + "漢".repeat(97));
  core.labels = ascii;
  if (options.tinyPrefix)
    for (let i = 1; i <= 1000; i++) core.overrides.set(i, { ...core, labels: [] });
  const env = {
      ...a.env,
      EXACT_REVIEW_QUEUE: { idFromName: (id: string) => id, get: () => a.queue },
    },
    originalExec = a.storage.sql.exec.bind(a.storage.sql);
  let pendingReclaimedRows = 0;
  let time = Date.now() - 6 * 60 * 60_000,
    armed = options.fault !== false,
    throwAfterDelete = false,
    faultInjected = false,
    recovered = false,
    rollbackExact = false,
    replayExact = false,
    casExact = false;
  const epoch = time,
    realStarted = new Date().toISOString(),
    canonical = JSON.stringify(a.canonicalState()),
    admission = JSON.stringify(a.storage.kv.get("exact-review-queue"));
  const rows = (query: string, ...args: unknown[]) => Array.from(originalExec(query, ...args));
  const states = () =>
    rows("SELECT repo,state FROM coverage_census_repositories ORDER BY repo").map((r) => ({
      repo: String(r.repo),
      state: JSON.parse(String(r.state)),
    }));
  const coreState = () => states().find((r) => r.repo === "fixture/core")!.state;
  const snapshot = () =>
    JSON.stringify({
      states: rows("SELECT * FROM coverage_census_repositories ORDER BY repo"),
      items: rows(
        "SELECT repo,generation,kind,number,bytes,checksum,seen,slot FROM coverage_census_items ORDER BY repo,generation,kind,number",
      ),
      cursors: rows("SELECT * FROM coverage_census_cursors ORDER BY repo,generation,kind,cursor"),
      receipts: rows("SELECT * FROM coverage_census_receipts ORDER BY id"),
    });
  const stats = () =>
    rows(
      "SELECT slot,COUNT(*) AS rows,COALESCE(SUM(bytes),0) AS bytes FROM coverage_census_items GROUP BY slot",
    ).map((r) => ({ slot: String(r.slot), rows: Number(r.rows), bytes: Number(r.bytes) }));
  const metrics = {
    maxStagingBytes: 0,
    maxResidentBytes: 0,
    maxTransactionalStagingBytes: 0,
    maxTransactionalResidentBytes: 0,
    maxResidentIdentities: 0,
    maxReclaimedRowsPerInsert: 0,
    maxAcceptWireBytes: 0,
    reclaims: [] as {
      rows: number;
      bytes: number;
      repo: string;
      generation: string;
      pass: number;
      faultAttempt: boolean;
    }[],
    failedAccepts: 0,
    failedStatuses: [] as number[],
    frames: [] as Record<string, unknown>[],
  };
  const measure = () => {
    const s = stats(),
      stage = s.find((r) => r.slot === "staging");
    metrics.maxStagingBytes = Math.max(metrics.maxStagingBytes, stage?.bytes ?? 0);
    metrics.maxResidentBytes = Math.max(
      metrics.maxResidentBytes,
      s.reduce((n, r) => n + r.bytes, 0),
    );
    metrics.maxResidentIdentities = Math.max(
      metrics.maxResidentIdentities,
      s.reduce((n, r) => n + r.rows, 0),
    );
    assert.ok((stage?.bytes ?? 0) <= CENSUS.copyBytes);
    assert.ok(metrics.maxResidentBytes <= 2 * CENSUS.copyBytes);
  };
  a.storage.sql.exec = (query: string, ...args: unknown[]) => {
    if (query.startsWith("INSERT OR REPLACE INTO coverage_census_items") && throwAfterDelete) {
      throwAfterDelete = false;
      faultInjected = true;
      throw new Error("controlled post-reclaim insertion failure");
    }
    if (
      query.startsWith("DELETE FROM coverage_census_items WHERE rowid IN") &&
      query.includes("seen<?")
    ) {
      const victims = rows(
        query.replace(
          "DELETE FROM coverage_census_items",
          "SELECT repo,generation,seen,slot,bytes FROM coverage_census_items",
        ),
        ...args,
      );
      const state = coreState(),
        g = state.active;
      assert.ok(victims.length <= CENSUS.pageNodes);
      for (const v of victims) {
        assert.equal(v.repo, "fixture/core");
        assert.equal(v.generation, g.id);
        assert.equal(v.slot, "staging");
        assert.ok(Number(v.seen) < g.pass);
      }
      pendingReclaimedRows += victims.length;
      metrics.reclaims.push({
        rows: victims.length,
        bytes: victims.reduce((n, r) => n + Number(r.bytes), 0),
        repo: "fixture/core",
        generation: g.id,
        pass: g.pass,
        faultAttempt: armed,
      });
      const result = originalExec(query, ...args);
      if (armed) {
        armed = false;
        throwAfterDelete = true;
      }
      return result;
    }
    const result = originalExec(query, ...args);
    if (query.startsWith("INSERT OR REPLACE INTO coverage_census_items")) {
      metrics.maxReclaimedRowsPerInsert = Math.max(
        metrics.maxReclaimedRowsPerInsert,
        pendingReclaimedRows,
      );
      pendingReclaimedRows = 0;
      const s = stats();
      metrics.maxTransactionalStagingBytes = Math.max(
        metrics.maxTransactionalStagingBytes,
        s.find((r) => r.slot === "staging")?.bytes ?? 0,
      );
      metrics.maxTransactionalResidentBytes = Math.max(
        metrics.maxTransactionalResidentBytes,
        s.reduce((n, r) => n + r.bytes, 0),
      );
    }
    return result;
  };
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init),
      url = new URL(request.url),
      accept = url.pathname.endsWith("/accept");
    let before = "",
      body: Record<string, unknown> | undefined;
    if (accept) {
      before = snapshot();
      body = JSON.parse(await request.clone().text());
      metrics.maxAcceptWireBytes = Math.max(
        metrics.maxAcceptWireBytes,
        new TextEncoder().encode(JSON.stringify(body)).length,
      );
      assert.ok(metrics.maxAcceptWireBytes <= CENSUS.wireBytes);
    }
    let response = await worker.fetch(request, env, {});
    if (accept && !response.ok) {
      metrics.failedAccepts++;
      metrics.failedStatuses.push(response.status);
      if (faultInjected && !recovered) {
        assert.equal(response.status, 409);
        assert.equal(snapshot(), before);
        rollbackExact = true;
        pendingReclaimedRows = 0;
        response = await worker.fetch(new Request(input, init), env, {});
        assert.equal(response.status, 200);
        const accepted = snapshot();
        const replay = await worker.fetch(new Request(input, init), env, {});
        assert.equal(replay.status, 200);
        assert.equal(snapshot(), accepted);
        replayExact = true;
        const stale = { ...body, requestId: "stale-" + crypto.randomUUID() };
        const signed = censusHttpControl({
          baseUrl: "https://byte-pressure.invalid",
          secret: a.secret,
          fetchImpl: (u, i) => worker.fetch(new Request(u, i), env, {}),
        });
        await assert.rejects(signed("/internal/review-coverage/census/accept", stale));
        assert.equal(snapshot(), accepted);
        casExact = true;
        recovered = true;
      }
    }
    measure();
    return response;
  };
  const control = censusHttpControl({
    baseUrl: "https://byte-pressure.invalid",
    secret: a.secret,
    fetchImpl,
  });
  const run = async () => {
    const result = await withReplayClock(time, () =>
      runReviewCoverageCensus({
        attempt: "byte-pressure-owner",
        repositories: model
          .population()
          .map((r) => ({ ...r, countsAt: new Date(time).toISOString() })),
        query: model.query,
        control,
        now: () => time,
      }),
    );
    assert.ok(result.queries <= CENSUS.queries);
    const s = coreState();
    metrics.frames.push({
      at: new Date(time).toISOString(),
      queries: result.queries,
      failed: result.failed,
      generation: s.active?.id ?? s.complete?.generation,
      pass: s.active?.pass,
      cursor: s.active?.connections.issue.cursor,
      count: s.active?.connections.issue.count,
      storedCompletePointer: !!s.complete,
      compatibleRefresh: s.active?.compatible ?? null,
      stats: stats(),
    });
    return result;
  };
  try {
    for (let n = 0; n < 5; n++) {
      await run();
      const s = coreState();
      if (s.active?.pass === 2 && s.active.connections.issue.count === 0) break;
      time += 20 * 60_000;
    }
    const initial = coreState();
    assert.equal(initial.active.pass, 2);
    assert.equal(initial.active.connections.issue.count, 0);
    assert.equal(initial.complete, null);
    const generation = initial.active.id,
      firstPassBytes = stats().find((r) => r.slot === "staging")!.bytes;
    assert.ok(firstPassBytes > 29 * 1024 * 1024 && firstPassBytes < CENSUS.copyBytes);
    const remaining = options.tinyPrefix
        ? core.issues.filter((n) => n <= 1000 || n > 1500)
        : core.issues.slice(500),
      added = Array.from({ length: 500 }, (_, i) => logicalCount + 1 + i);
    core.issues = options.growthOnExisting ? added.concat(remaining) : remaining.concat(added);
    if (options.growthOnExisting) {
      const large = options.tinyPrefix ? remaining.filter((n) => n > 1000) : remaining;
      for (let i = 0; i < large.length; i += 50)
        core.overrides.set(large[i]!, { ...core, labels: wide });
    } else
      for (let i = 0; i < 500; i += 10)
        core.overrides.set(logicalCount + 1 + i, { ...core, labels: wide });
    let complete = false;
    for (let n = 0; n < 12; n++) {
      time += 20 * 60_000;
      await run();
      const s = coreState();
      assert.equal(
        s.active?.id ?? s.complete?.generation,
        generation,
        "must not reset generation/prefix under old-pass byte pressure",
      );
      if (s.complete) {
        complete = true;
        break;
      }
    }
    assert.ok(
      complete,
      "supported ~32MiB current population stalled at an unchanged byte-pressure page " +
        JSON.stringify({
          firstPassBytes,
          generation,
          failedStatuses: metrics.failedStatuses,
          frames: metrics.frames,
          stats: stats(),
        }),
    );
    const final = coreState(),
      finalStats = stats(),
      completeBytes = finalStats.find((r) => r.slot === "complete")!.bytes;
    assert.ok(completeBytes <= CENSUS.copyBytes);
    assert.equal(final.complete.issues, logicalCount);
    if (options.tinyPrefix)
      assert.ok(
        metrics.maxReclaimedRowsPerInsert > CENSUS.pageNodes,
        "one large current row must reclaim across bounded metadata batches",
      );
    assert.ok(metrics.reclaims.some((r) => !r.faultAttempt && r.rows === 1));
    assert.ok(
      metrics.reclaims.some((r) => !r.faultAttempt && r.rows >= 2),
      "larger replacements must reclaim multiple smaller obsolete rows",
    );
    if (options.fault !== false) {
      assert.equal(rollbackExact, true);
      assert.equal(replayExact, true);
      assert.equal(casExact, true);
    }
    const completeApi = await withReplayClock(time, () =>
      readCoverageForBuild(a.secret, fetchImpl, "https://byte-pressure.invalid"),
    );
    assert.equal(completeApi.coverage_status, "complete");
    const unsupported: Record<string, unknown> = {};
    if (options.overcap !== false) {
      const verified = JSON.stringify(final.complete);
      for (let i = 0; i < core.issues.length; i++)
        core.overrides.set(core.issues[i]!, { ...core, labels: i % 4 === 0 ? wide : ascii });
      let failed = false;
      for (let n = 0; n < 8; n++) {
        time += 20 * 60_000;
        const r = await run();
        if (r.failed) {
          failed = true;
          break;
        }
      }
      assert.equal(failed, true, "genuinely over-capacity current pass must reject");
      const stalled = coreState();
      assert.ok(stalled.active);
      assert.equal(stalled.active.compatible, false);
      assert.equal(JSON.stringify(stalled.complete), verified);
      const cursor = stalled.active.connections.issue.cursor,
        revision = stalled.active.revision,
        id = stalled.active.id;
      time += 20 * 60_000;
      await run();
      const retry = coreState();
      assert.equal(retry.active.id, id);
      assert.equal(retry.active.connections.issue.cursor, cursor);
      assert.equal(retry.active.revision, revision);
      assert.equal(JSON.stringify(retry.complete), verified);
      const inv = new ReviewCoverageCensusStore(a.storage).inventory(time)!;
      assert.equal(inv.repositories.find((r) => r.repo === "fixture/core")!.complete, false);
      const unknownApi = await withReplayClock(time, () =>
        readCoverageForBuild(a.secret, fetchImpl, "https://byte-pressure.invalid"),
      );
      assert.equal(unknownApi.coverage_status, "unknown");
      assert.equal(unknownApi.totals.coverage_percent, null);
      unsupported.apiStatus = unknownApi.coverage_status;
      unsupported.rejected = true;
      unsupported.cursor = cursor;
      unsupported.generation = id;
      unsupported.completeWindowUnchanged = true;
    }
    assert.equal(JSON.stringify(a.canonicalState()), canonical);
    assert.equal(JSON.stringify(a.storage.kv.get("exact-review-queue")), admission);
    measure();
    assert.ok(metrics.maxTransactionalStagingBytes <= CENSUS.copyBytes);
    assert.ok(metrics.maxTransactionalResidentBytes <= 2 * CENSUS.copyBytes);
    return {
      head: null,
      clock: {
        kind: "CONTROLLED VIRTUAL OBSERVATION CLOCK, NOT LIVE GH",
        epoch: new Date(epoch).toISOString(),
        evaluation: new Date(time).toISOString(),
        realStarted,
        realEnded: new Date().toISOString(),
      },
      completeApiStatus: completeApi.coverage_status,
      firstPassBytes,
      completeBytes,
      logicalCount,
      tinyPrefix: options.tinyPrefix === true,
      replacements: 500,
      largerPayloadUpdates: 50,
      growthOnExisting: options.growthOnExisting === true,
      generation,
      rollbackExact,
      replayExact,
      casExact,
      unsupported,
      metrics,
      canonicalUnchanged: true,
      admissionUnchanged: true,
      limits:
        "Actual production quotas and signed producer/Worker/DO; controlled GH/SQLite/R2/clock. Committed logical SQL bytes, not peak physical disk/WAL or production throughput.",
    };
  } finally {
    a.storage.sql.exec = originalExec;
    model.db.close();
  }
}
