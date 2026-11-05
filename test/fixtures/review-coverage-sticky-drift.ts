import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { CENSUS } from "../../src/review-coverage-census.ts";
import { ExactReviewQueue } from "../../dashboard/worker.ts";
import { censusHttpControl } from "../../dist/repair/review-coverage-census.js";
import { withReplayClock } from "../../docs/proof/ui-live-coverage/replay-clock.mjs";
import { coverageCliFixture } from "./review-coverage-cli.ts";
// All mutations below are normal producer/signed Worker/DO calls. SQL only reads.
export async function stickyDriftScenario(
  options: { count?: number; mixed?: boolean; lifecycle?: boolean; recover?: boolean } = {},
) {
  const count = options.count ?? 256,
    mixed = options.mixed ?? false,
    coreCount = count - (mixed ? 2 : 0),
    issues = coreCount > 1000 ? Math.ceil(coreCount / 2) : coreCount,
    pulls = coreCount - issues,
    f = await coverageCliFixture([
      { name: "core", issues, pulls },
      ...(mixed
        ? [
            { name: "peer", issues: 2, pulls: 0 },
            { name: "zero", issues: 0, pulls: 0 },
          ]
        : []),
    ]),
    write = process.stdout.write,
    query = f.model.query,
    hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
  let stdout = "",
    queries = 0,
    retired = false,
    attempt = "",
    phase = "seed",
    sawSecondWitness = false;
  const stop = new Error("controlled post-promotion ACK loss"),
    lost = new Error("controlled lost next ACK"),
    opportunities: { phase: string; queries: number; controls: number }[] = [],
    witnessRequests = { 1: new Set<string>(), 2: new Set<string>() };
  const sql = (q: string, ...args: unknown[]) =>
      Array.from(f.authority.storage.sql.exec(q, ...args)),
    state = () => f.states().find((s) => s.repo === "openclaw/core")?.state,
    orphans = () =>
      Number(
        sql(
          "SELECT COUNT(*) AS n FROM coverage_census_items WHERE repo=? AND slot='orphan'",
          "openclaw/core",
        )[0]!.n,
      ),
    payload = (generation: string) =>
      hash(
        sql(
          "SELECT kind,number,payload FROM coverage_census_items WHERE repo=? AND generation=? ORDER BY kind,number",
          "openclaw/core",
          generation,
        ),
      );
  const controlTrace: Record<string, unknown>[] = [];
  const witnessCertificates: Record<string, unknown>[] = [];
  const observe = (hook: (event: { path: string; body?: Record<string, unknown> }) => void) =>
    f.observe((event) => {
      const response = f.responses.at(-1)?.body as Record<string, any> | undefined;
      const pages = Array.isArray(event.body?.pages)
        ? (event.body!.pages as Record<string, any>[])
        : null;
      controlTrace.push({
        phase,
        path: event.path,
        repositories: Array.isArray(event.body?.repositories)
          ? (event.body!.repositories as Record<string, unknown>[]).map((r) => ({
              repo: r.repo,
              issues: r.issues,
              pulls: r.pulls,
              countsAt: r.countsAt,
              idSha256: hash(r.id),
            }))
          : null,
        requestSha256: hash(event.body ?? null),
        responseSha256: hash(response ?? null),
        pending: typeof response?.pending === "boolean" ? response.pending : null,
        work: Array.isArray(response?.work)
          ? response.work.map((w: Record<string, unknown>) => ({
              repo: w.repo,
              kind: w.kind,
              pass: w.pass,
              revision: w.revisionNumber,
            }))
          : null,
        pages:
          pages?.map((p) => ({
            repo: p.repo,
            kind: p.kind,
            pass: p.pass,
            totalCount: p.totalCount,
            hasNext: p.hasNext,
            items: Array.isArray(p.items) ? p.items.length : null,
          })) ?? null,
      });
      hook(event);
    });
  f.model.query = (q) => {
    queries++;
    return query(q);
  };
  const snap = async (name: string) => {
    const s = state(),
      api = (await (await f.anonymous()).json()) as Record<string, any>,
      inventory = f.inventory();
    return {
      name,
      orphans: orphans(),
      active: !!s.active,
      compatible: s.active?.compatible ?? null,
      pass: s.active?.pass ?? null,
      reason: s.reason,
      completeHash: hash(s.complete),
      completeGeneration: s.complete?.generation,
      latestPayloadSha256: s.complete ? payload(s.complete.generation) : null,
      coreComplete: inventory.repositories.find((r) => r.repo === "openclaw/core")?.complete,
      peers: inventory.repositories
        .filter((r) => r.repo !== "openclaw/core")
        .map((r) => ({
          repo: r.repo,
          complete: r.complete,
          open: r.open_issues + r.open_pull_requests,
          items: r.items.length,
        })),
      census: api.census_status,
      percent: (api.totals as Record<string, unknown>).coverage_percent,
      open: (api.totals as Record<string, unknown>).open_records,
    };
  };
  const invoke = async (label: string, protocol = "v2") => {
    const before = queries,
      controls = f.calls.length;
    try {
      await f.run("coverage", protocol);
    } catch (e) {
      if (e !== stop) throw e;
    } finally {
      const used = queries - before;
      assert.ok(used <= CENSUS.queries);
      opportunities.push({ phase: label, queries: used, controls: f.calls.length - controls });
    }
  };
  const control = censusHttpControl({
      baseUrl: "https://census-cli.invalid",
      secret: f.authority.secret,
      fetchImpl: globalThis.fetch,
    }),
    call = (suffix: string, body: Record<string, unknown> = {}) =>
      withReplayClock(f.time, () =>
        control("/internal/review-coverage/census/" + suffix, {
          version: CENSUS.version,
          attempt,
          ...body,
        }),
      );
  const observeCounts = async (coreIssues: number, advance = CENSUS.refreshMs) => {
    f.advance(advance);
    attempt = randomUUID();
    const at = new Date(f.time).toISOString(),
      repositories = f.states().map((s) => ({
        ...s.state.repository,
        issues: s.repo === "openclaw/core" ? coreIssues : s.state.repository.issues,
        countsAt: at,
      }));
    return call("start", { repositories, observedAt: at });
  };
  try {
    process.stdout.write = ((chunk: unknown, encoding?: unknown, callback?: () => void) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const done = typeof encoding === "function" ? (encoding as () => void) : callback;
      done?.();
      return true;
    }) as typeof process.stdout.write;
    observe(() => {});
    const canonical = hash(f.authority.canonicalState()),
      admission = hash(
        sql("SELECT item_key,item_json FROM exact_review_queue_items ORDER BY item_key"),
      );
    for (let n = 0; n < 32 && !state()?.complete; n++) {
      if (n) f.advance(CENSUS.refreshMs);
      await invoke("seed-first");
    }
    assert.ok(state().complete);
    const first = state().complete.generation;
    observe(() => {
      const s = state();
      if (retired) throw stop;
      if (s.complete?.generation !== first && orphans() === coreCount) {
        retired = true;
        throw stop;
      }
    });
    phase = "seed-second";
    for (let n = 0; n < 32 && !retired; n++) {
      f.advance(CENSUS.refreshMs);
      await invoke(phase);
    }
    assert.equal(retired, true);
    assert.equal(orphans(), coreCount);
    assert.equal(state().active, null);
    observe(() => {});
    const oldStart = f.calls.find((c) => c.path.endsWith("/census/start"))!.body,
      before = await snap("actual promotion retired old identities"),
      q0 = queries;
    phase = "count-drift";
    await observeCounts(count >= CENSUS.identities ? issues - 1 : issues + 1);
    const drifted = await snap("observed count drift during cleanup");
    phase = "count-reversion";
    await observeCounts(issues);
    const returned = await snap("count returned before identity verification"),
      noQueryDuringCountDrift = queries - q0;
    assert.equal(noQueryDuringCountDrift, 0);
    assert.equal(returned.completeHash, before.completeHash);
    assert.equal(returned.latestPayloadSha256, before.latestPayloadSha256);
    const cleanupBatches = [before.orphans - drifted.orphans, drifted.orphans - returned.orphans];
    const lifecycle: Awaited<ReturnType<typeof snap>>[] = [];
    let maxDeleted = 0,
      cleanupCalls = 0,
      last = orphans();
    phase = "pure-cleanup";
    while (orphans() > 0) {
      assert.ok(cleanupCalls++ < CENSUS.controlSteps);
      await call("next", { excluded: [] });
      const now = orphans();
      cleanupBatches.push(last - now);
      maxDeleted = Math.max(maxDeleted, last - now);
      assert.ok(last - now <= CENSUS.cleanupRows);
      last = now;
    }
    await observeCounts(issues);
    const afterCleanup = await snap("cleanup drained and new active starts");
    if (options.lifecycle) {
      phase = "durable-control-lifecycle";
      assert.equal(returned.percent, null);
      assert.equal(afterCleanup.percent, null);
      f.authority.queue = new ExactReviewQueue({ storage: f.authority.storage }, f.authority.env);
      lifecycle.push(await snap("DO reconstructed with hold"));
      let lostOnce = true;
      observe((e) => {
        if (e.path.endsWith("/census/next") && lostOnce) {
          lostOnce = false;
          throw lost;
        }
      });
      try {
        await call("next", { excluded: [] });
      } catch (e) {
        assert.equal(e, lost);
      }
      const lostReply = f.responses.at(-1)!.body as { work: Record<string, unknown>[] };
      observe(() => {});
      f.authority.queue = new ExactReviewQueue({ storage: f.authority.storage }, f.authority.env);
      const replay = (await call("next", { excluded: [] })) as { work: Record<string, unknown>[] };
      assert.deepEqual(replay.work, lostReply.work);
      lifecycle.push(await snap("lost-next ACK replay after reconstruction"));
      const coreWork = replay.work.filter((w) => w.repo === "openclaw/core");
      assert.ok(coreWork.length);
      await call("fail", { work: coreWork });
      lifecycle.push(await snap("work cancelled through existing fail owner"));
      f.advance(CENSUS.leaseMs + 1);
      let expired = false;
      try {
        await call("next", { excluded: [] });
      } catch {
        expired = true;
      }
      assert.equal(expired, true);
      lifecycle.push(await snap("control lease expired"));
      await observeCounts(issues);
      lifecycle.push(await snap("fresh lease and matching metadata still held"));
      try {
        await f.replayStart(oldStart!);
      } catch {}
      lifecycle.push(await snap("old start receipt replay cannot clear hold"));
      await invoke("legacy-client-current-server", "v1");
      lifecycle.push(await snap("legacy v1 cannot clear v2 hold"));
      for (const s of lifecycle) {
        assert.equal(s.percent, null);
        assert.equal(s.coreComplete, false);
        assert.equal(s.completeHash, before.completeHash);
        assert.equal(s.latestPayloadSha256, before.latestPayloadSha256);
        if (mixed) assert.ok(s.peers.every((p) => p.complete));
      }
    }
    let recovered: Awaited<ReturnType<typeof snap>> | null = null;
    if (options.recover) {
      assert.equal(afterCleanup.percent, null);
      const held = state().complete.generation;
      phase = "recover";
      observe((e) => {
        const s = state();
        if (s.active?.pass === 2 && s.active.previous?.stable) {
          sawSecondWitness = true;
          const generationSha256 = hash(s.active.id);
          if (!witnessCertificates.some((c) => c.generationSha256 === generationSha256))
            witnessCertificates.push({ generationSha256, previous: s.active.previous });
        }
        if (e.path.endsWith("/census/accept")) {
          const pages = e.body?.pages as { repo: string; pass: 1 | 2 }[] | undefined;
          for (const p of pages ?? [])
            if (p.repo === "openclaw/core") witnessRequests[p.pass].add(String(e.body!.requestId));
        }
        if (s.complete?.generation === held) assert.equal(hash(s.complete), before.completeHash);
      });
      for (let n = 0; n < 32 && state().complete.generation === held; n++) {
        f.advance(CENSUS.refreshMs);
        await invoke("actual-two-pass-recovery");
      }
      recovered = await snap("actual two-pass promotion recovered");
      assert.notEqual(recovered.completeGeneration, held);
      assert.equal(recovered.coreComplete, true);
      assert.equal(typeof recovered.percent, "number");
      assert.equal(sawSecondWitness, true);
      assert.ok(witnessRequests[1].size > 0 && witnessRequests[2].size > 0);
      assert.ok([...witnessRequests[1]].every((x) => !witnessRequests[2].has(x)));
    }
    assert.equal(hash(f.authority.canonicalState()), canonical);
    assert.equal(
      hash(sql("SELECT item_key,item_json FROM exact_review_queue_items ORDER BY item_key")),
      admission,
    );
    return {
      count: coreCount,
      fleetCount: count,
      mixed,
      before,
      drifted,
      returned,
      afterCleanup,
      lifecycle,
      recovered,
      noQueryDuringCountDrift,
      cleanupCalls,
      cleanupBatches,
      maxDeleted,
      queryBudget: CENSUS.queries,
      controlBudget: CENSUS.controlSteps,
      opportunities,
      sawSecondWitness,
      witnessRequestCounts: { pass1: witnessRequests[1].size, pass2: witnessRequests[2].size },
      controlTrace,
      witnessCertificates,
      countExchanges: f.countExchanges,
      canonicalAdmissionUnchanged: true,
      actualSignedOwnerCalls: true,
      manualStateInsertion: false,
      stdout,
    };
  } finally {
    process.stdout.write = write;
    f.model.query = query;
    observe(() => {});
    f.close();
  }
}
