import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { CENSUS } from "../../src/review-coverage-census.ts";
import { ExactReviewQueue } from "../../dashboard/worker.ts";
import {
  censusHttpControl,
  runReviewCoverageCensus,
  censusQuery,
  censusQueryPages,
} from "../../dist/repair/review-coverage-census.js";
import { withReplayClock } from "../../docs/proof/ui-live-coverage/replay-clock.mjs";
import { coverageCliFixture } from "./review-coverage-cli.ts";
const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
export async function pendingCopyDriftScenario(
  options: { lifecycle?: boolean; recover?: boolean } = {},
) {
  const f = await coverageCliFixture([
      { name: "core", issues: 5, pulls: 5 },
      { name: "peer", issues: 1750, pulls: 1750 },
    ]),
    write = process.stdout.write,
    query = f.model.query,
    labels = Array.from({ length: 80 }, (_, i) => String(i).padStart(3, "0") + "x".repeat(97));
  let stdout = "",
    coreQueries = 0,
    peerQueries = 0,
    attempt = "",
    phase = "seed";
  const trace: Record<string, unknown>[] = [],
    passes = new Map<number, Set<string>>();
  for (const m of f.model.members.values()) m.labels = labels;
  const state = (repo = "core") => f.states().find((s) => s.repo === "openclaw/" + repo)?.state,
    sql = (q: string, ...args: unknown[]) => Array.from(f.authority.storage.sql.exec(q, ...args)),
    payload = (generation: string) =>
      digest(
        sql(
          "SELECT kind,number,payload FROM coverage_census_items WHERE repo=? AND generation=? ORDER BY kind,number",
          "openclaw/core",
          generation,
        ),
      ),
    repos = (extra = 0) =>
      f.states().map((s) => ({
        ...s.state.repository,
        issues: s.repo === "openclaw/core" ? 500 + extra : 1,
        pulls: s.repo === "openclaw/core" ? 500 : 0,
        countsAt: new Date(f.time).toISOString(),
      }));
  f.model.query = (q) => {
    if (q.includes('"core"')) coreQueries++;
    if (q.includes('"peer"')) peerQueries++;
    return query(q);
  };
  const snap = async (name: string) => {
    const s = state(),
      peer = state("peer"),
      api = (await (await f.anonymous()).json()) as Record<string, any>;
    return {
      name,
      metadata: s.repository.issues + s.repository.pulls,
      active: !!s.active,
      compatible: s.active?.compatible ?? null,
      revision: s.active?.revision ?? null,
      pass: s.active?.pass ?? null,
      promoting: !!s.active?.promoting,
      promotingCount: s.active?.promoting
        ? s.active.promoting.issues + s.active.promoting.pulls
        : null,
      previousStable: s.active?.previous?.stable ?? null,
      completeCount: s.complete.issues + s.complete.pulls,
      completeHash: digest(s.complete),
      payloadHash: payload(s.complete.generation),
      reason: s.reason,
      peerComplete: peer.complete.issues + peer.complete.pulls,
      completeBytes: Number(
        sql(
          "SELECT COALESCE(SUM(bytes),0) AS n FROM coverage_census_items WHERE slot='complete'",
        )[0]!.n,
      ),
      percent: (api.totals as Record<string, unknown>).coverage_percent,
      census: api.census_status,
    };
  };
  const signed = censusHttpControl({
      baseUrl: "https://census-cli.invalid",
      secret: f.authority.secret,
      fetchImpl: globalThis.fetch,
    }),
    call = (suffix: string, body: Record<string, unknown> = {}) =>
      withReplayClock(f.time, () =>
        signed("/internal/review-coverage/census/" + suffix, {
          version: CENSUS.version,
          attempt,
          ...body,
        }),
      );
  const start = async (extra: number, advance = CENSUS.refreshMs) => {
    f.advance(advance);
    attempt = randomUUID();
    return call("start", {
      repositories: repos(extra),
      observedAt: new Date(f.time).toISOString(),
    });
  };
  const collect = async (exclude: string, extra: number) => {
    attempt = randomUUID();
    const excluded = ["issue", "pull_request"].map((kind) => "openclaw/" + exclude + ":" + kind);
    return withReplayClock(f.time, () =>
      runReviewCoverageCensus({
        attempt,
        repositories: repos(extra),
        control: (path: string, body: Record<string, any>) =>
          signed(
            path,
            path.endsWith("/next") && !body.observe
              ? { ...body, excluded: [...new Set([...(body.excluded ?? []), ...excluded])] }
              : body,
          ),
        query: (q: string) => f.model.query(q),
        now: () => f.time,
      }),
    );
  };
  try {
    process.stdout.write = ((chunk: unknown, encoding?: unknown, callback?: () => void) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const done = typeof encoding === "function" ? (encoding as () => void) : callback;
      done?.();
      return true;
    }) as typeof process.stdout.write;
    const canonical = digest(f.authority.canonicalState()),
      admission = digest(
        sql("SELECT item_key,item_json FROM exact_review_queue_items ORDER BY item_key"),
      );
    f.observe((e) => {
      const s = state();
      trace.push({
        phase,
        path: e.path,
        requestSha256: digest(e.body ?? null),
        responseSha256: digest(f.responses.at(-1)?.body ?? null),
        promoting: !!s?.active?.promoting,
        revision: s?.active?.revision ?? null,
      });
      if (phase === "recover" && e.path.endsWith("/census/accept")) {
        for (const p of (e.body?.pages ?? []) as { repo: string; pass: number }[])
          if (p.repo === "openclaw/core") {
            const set = passes.get(p.pass) ?? new Set<string>();
            set.add(String(e.body!.requestId));
            passes.set(p.pass, set);
          }
      }
    });
    for (let n = 0; n < 12 && !state("peer")?.complete; n++) {
      if (n) f.advance(CENSUS.refreshMs);
      await f.run("coverage");
    }
    assert.equal(state("peer").complete.issues + state("peer").complete.pulls, 3500);
    const oldWindow = await snap("retained prior complete10");
    const core = f.model.members.get("core")!,
      peer = f.model.members.get("peer")!;
    core.issues = Array.from({ length: 500 }, (_, i) => i + 1);
    core.pulls = Array.from({ length: 500 }, (_, i) => 100001 + i);
    peer.issues = [1];
    peer.pulls = [];
    f.advance(CENSUS.refreshMs);
    phase = "pending-copy";
    await collect("peer", 0);
    const pending = await snap("verified1000 waits for shared complete-copy capacity");
    assert.equal(pending.promoting, true);
    assert.equal(pending.promotingCount, 1000);
    const oldAcceptance = f.calls.findLast(
        (c) =>
          c.path.endsWith("/census/accept") &&
          Array.isArray(c.body?.pages) &&
          (c.body!.pages as { repo: string }[]).some((p) => p.repo === "openclaw/core"),
      )!.body!,
      q0 = coreQueries;
    phase = "drift";
    await start(1);
    const contradicted = await snap("ordinary1001 observation");
    f.advance(CENSUS.leaseMs + 1);
    phase = "free-peer-copy";
    await collect("core", 1);
    await start(1, CENSUS.leaseMs + 1);
    await call("next", { excluded: [] });
    const finalized = await snap("capacity free and existing retry expired");
    await start(0);
    const returned = await snap("counts return1000 without new core query");
    const coreQueriesOnCountDrift = coreQueries - q0;
    assert.equal(coreQueriesOnCountDrift, 0);
    const lifecycle: Awaited<ReturnType<typeof snap>>[] = [];
    if (options.lifecycle) {
      assert.equal(returned.percent, null);
      f.authority.queue = new ExactReviewQueue({ storage: f.authority.storage }, f.authority.env);
      lifecycle.push(await snap("DO reconstructed"));
      let oldReplayRejected = false;
      try {
        await withReplayClock(f.time, () =>
          signed("/internal/review-coverage/census/accept", oldAcceptance),
        );
      } catch {
        oldReplayRejected = true;
      }
      lifecycle.push(
        await snap(
          oldReplayRejected
            ? "old acceptance rejected"
            : "old acceptance idempotent without qualification",
        ),
      );
      let staleRejected = false;
      try {
        await call("accept", { ...oldAcceptance, attempt, requestId: randomUUID() });
      } catch {
        staleRejected = true;
      }
      assert.equal(staleRejected, true);
      lifecycle.push(await snap("stale page CAS rejected"));
      const next = (await call("next", { excluded: [] })) as { work: Record<string, unknown>[] },
        work = next.work.filter((w) => w.repo === "openclaw/core");
      if (work.length) await call("fail", { work });
      lifecycle.push(await snap("work cancelled"));
      await start(0, CENSUS.leaseMs + 1);
      lifecycle.push(await snap("lease expiry and matching metadata"));
      let legacyRejected = false;
      try {
        await f.run("coverage", "v1");
      } catch {
        legacyRejected = true;
      }
      lifecycle.push(
        await snap(
          legacyRejected
            ? "legacy rejected without restoring qualification"
            : "legacy write cannot restore qualification",
        ),
      );
      for (const s of lifecycle) {
        assert.equal(s.percent, null);
        assert.equal(s.completeHash, oldWindow.completeHash);
        assert.equal(s.payloadHash, oldWindow.payloadHash);
      }
    }
    let recovered: Awaited<ReturnType<typeof snap>> | null = null;
    if (options.recover) {
      assert.equal(returned.percent, null);
      phase = "recover";
      const retained = state().complete.generation;
      for (let n = 0; n < 8 && state().complete.generation === retained; n++) {
        const before = state().complete.generation;
        f.advance(CENSUS.refreshMs);
        await collect("peer", 0);
        if (state().complete.generation !== before) break;
      }
      recovered = await snap("actual fresh matching witness promotion");
      assert.equal(recovered.completeCount, 1000);
      assert.equal(typeof recovered.percent, "number");
      assert.notEqual(recovered.completeHash, oldWindow.completeHash);
      assert.ok(passes.size >= 2);
    }
    assert.equal(digest(f.authority.canonicalState()), canonical);
    assert.equal(
      digest(sql("SELECT item_key,item_json FROM exact_review_queue_items ORDER BY item_key")),
      admission,
    );
    return {
      oldWindow,
      pending,
      contradicted,
      finalized,
      returned,
      lifecycle,
      recovered,
      coreQueriesOnCountDrift,
      totalPeerQueryCalls: peerQueries,
      witnessPasses: [...passes].map(([pass, ids]) => ({ pass, requests: ids.size })),
      trace,
      manualStateInsertion: false,
      actualSignedProducer: true,
      canonicalAdmissionUnchanged: true,
      stdout,
    };
  } finally {
    process.stdout.write = write;
    f.model.query = query;
    f.observe(() => {});
    f.close();
  }
}

export async function pendingWitnessDriftScenario() {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 2 }]),
    transport = globalThis.fetch,
    write = process.stdout.write;
  let paused = false,
    stdout = "",
    attempt = "",
    recover = false;
  const stop = new Error("controlled pause after first stable witness"),
    passes = new Set<number>(),
    state = () => f.states()[0]?.state,
    trace: Record<string, unknown>[] = [];
  const snap = async (name: string) => {
    const s = state(),
      api = (await (await f.anonymous()).json()) as Record<string, any>;
    return {
      name,
      pass: s.active?.pass ?? null,
      revision: s.active?.revision ?? null,
      compatible: s.active?.compatible ?? null,
      previousStable: s.active?.previous?.stable ?? null,
      promoting: !!s.active?.promoting,
      completeHash: digest(s.complete),
      percent: (api.totals as Record<string, unknown>).coverage_percent,
      census: api.census_status,
    };
  };
  try {
    process.stdout.write = ((chunk: unknown, encoding?: unknown, callback?: () => void) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const done = typeof encoding === "function" ? (encoding as () => void) : callback;
      done?.();
      return true;
    }) as typeof process.stdout.write;
    await f.run("coverage");
    const oldWindow = await snap("prior complete4");
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (paused && new URL(request.url).pathname.includes("/review-coverage/census/")) throw stop;
      return transport(input, init);
    };
    f.observe((e) => {
      const s = state();
      if (s?.active?.pass === 2 && s.active.previous?.stable) paused = true;
      trace.push({
        path: e.path,
        requestSha256: digest(e.body ?? null),
        pass: s?.active?.pass ?? null,
        previousStable: s?.active?.previous?.stable ?? null,
      });
    });
    f.advance(CENSUS.refreshMs);
    try {
      await f.run("coverage");
    } catch (e) {
      assert.equal(e, stop);
    }
    assert.equal(paused, true);
    const pending = await snap("first witness persisted before second sweep");
    paused = false;
    f.observe(() => {});
    const signed = censusHttpControl({
        baseUrl: "https://census-cli.invalid",
        secret: f.authority.secret,
        fetchImpl: globalThis.fetch,
      }),
      call = (suffix: string, body: Record<string, unknown> = {}) =>
        withReplayClock(f.time, () =>
          signed("/internal/review-coverage/census/" + suffix, {
            version: CENSUS.version,
            attempt,
            ...body,
          }),
        );
    const start = async (issues: number) => {
      f.advance(CENSUS.refreshMs);
      attempt = randomUUID();
      return call("start", {
        repositories: [{ ...state().repository, issues, countsAt: new Date(f.time).toISOString() }],
        observedAt: new Date(f.time).toISOString(),
      });
    };
    await start(3);
    const drifted = await snap("observed5");
    await start(2);
    f.authority.queue = new ExactReviewQueue({ storage: f.authority.storage }, f.authority.env);
    const returned = await snap("observed4 after reconstruction"),
      oldPass = state().active.pass;
    let calls = 0;
    while (state().active?.pass === oldPass && calls++ < 20) {
      const next = (await call("next", { excluded: [] })) as { work: any[] };
      if (!next.work.length) break;
      const raw = f.model.query(censusQuery(next.work)),
        pages = censusQueryPages(raw, next.work, new Date(f.time).toISOString());
      await call("accept", { requestId: randomUUID(), pages });
    }
    const oneSweep = await snap("one post-drift sweep cannot pair with old first witness");
    f.observe((e) => {
      if (recover && e.path.endsWith("/census/accept"))
        for (const p of (e.body?.pages ?? []) as { pass: number }[]) passes.add(p.pass);
    });
    recover = true;
    for (
      let n = 0;
      n < 4 && state().complete && digest(state().complete) === oldWindow.completeHash;
      n++
    ) {
      f.advance(CENSUS.refreshMs);
      await f.run("coverage");
    }
    const recovered = await snap("fresh stable independent witnesses promoted");
    return {
      oldWindow,
      pending,
      drifted,
      returned,
      oneSweep,
      recovered,
      freshWitnessPasses: [...passes],
      trace,
      stdout,
      manualStateInsertion: false,
      actualSignedOwner: true,
    };
  } finally {
    globalThis.fetch = transport;
    process.stdout.write = write;
    f.observe(() => {});
    f.close();
  }
}
