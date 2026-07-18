import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  mergeAutomergeMetricLedger,
  percentile,
  summarizeAutomergeMetrics,
  type AutomergeMetricEvent,
} from "../dashboard/automerge-metrics.ts";
import {
  automergeSessionId,
  latestAutomergeActivationForCommand,
  postAutomergeMetricBestEffort,
} from "../src/repair/automerge-product-telemetry.ts";
import {
  automergeReconcileExitCode,
  reconcileAutomergeProductMetrics,
} from "../scripts/dashboard-reconcile-automerge.ts";

const now = "2026-07-17T12:00:00.000Z";

test("reconcile CLI documents JSON output and explicit exit codes", () => {
  const help = spawnSync(process.execPath, ["scripts/dashboard-reconcile-automerge.ts", "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--session-id <id>/);
  assert.match(help.stdout, /Exit codes: 0 completed\/skipped safely, 1 operational/);

  const invalid = spawnSync(
    process.execPath,
    [
      "scripts/dashboard-reconcile-automerge.ts",
      "--run-url",
      "https://github.com/openclaw/clawsweeper/actions/runs/1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 2);
  assert.deepEqual(JSON.parse(invalid.stderr), {
    ok: false,
    error: "--run-url requires --session-id",
  });
  assert.equal(automergeReconcileExitCode({ ok: true, failed: 0 }), 0);
  assert.equal(automergeReconcileExitCode({ ok: true, failed: 1 }), 1);
  assert.equal(automergeReconcileExitCode({ ok: false, failed: 0 }), 1);
});

function event(
  session: string,
  phase: AutomergeMetricEvent["phase"],
  at: string,
  extra: Partial<AutomergeMetricEvent> = {},
): AutomergeMetricEvent {
  return {
    event_id: `${session}:${phase}:${at}`,
    session_id: session,
    phase,
    occurred_at: at,
    repository: "openclaw/openclaw",
    item_number: Number(session.replace(/\D/g, "")) || 1,
    policy_version: "immediate-v1",
    ...extra,
  };
}

function ledger(events: AutomergeMetricEvent[]) {
  return events.reduce(
    (current, row) => mergeAutomergeMetricLedger(current, row, Date.parse(now)),
    null as unknown,
  );
}

test("success denominator includes only terminal sessions", () => {
  const data = summarizeAutomergeMetrics(
    ledger([
      event("s1", "activated", "2026-07-17T08:00:00Z"),
      event("s1", "terminal", "2026-07-17T09:00:00Z", { outcome: "merged" }),
      event("s2", "activated", "2026-07-17T09:00:00Z"),
      event("s2", "state_changed", "2026-07-17T10:00:00Z", { state: "waiting" }),
      event("s3", "activated", "2026-07-17T09:30:00Z"),
      event("s3", "state_changed", "2026-07-17T10:30:00Z", { state: "paused for human" }),
      event("s4", "terminal", "2026-07-17T11:00:00Z", { outcome: "repair_cap_exhausted" }),
      event("old-active", "activated", "2026-07-16T12:00:00Z"),
      event("future-active", "activated", "2026-07-17T13:00:00Z"),
    ]),
    { range: "6h", now },
  );
  assert.equal(data.summary.terminal_sessions, 2);
  assert.equal(data.summary.merged_sessions, 1);
  assert.equal(data.summary.merge_success_rate_percent, 50);
  assert.equal(data.summary.active_sessions, 2);
});

test("duplicate and out-of-order events remain idempotent", () => {
  const terminal = event("s5", "terminal", "2026-07-17T11:00:00Z", { outcome: "merged" });
  const activation = event("s5", "activated", "2026-07-17T10:00:00Z");
  let current = mergeAutomergeMetricLedger(null, terminal, Date.parse(now));
  current = mergeAutomergeMetricLedger(current, activation, Date.parse(now));
  current = mergeAutomergeMetricLedger(current, terminal, Date.parse(now));
  const data = summarizeAutomergeMetrics(current, { range: "6h", now });
  assert.equal(current.events.length, 2);
  assert.equal(data.summary.command_to_merge_p50_ms, 60 * 60 * 1000);
});

test("the first terminal outcome remains authoritative", () => {
  const data = summarizeAutomergeMetrics(
    ledger([
      event("stable", "activated", "2026-07-17T09:00:00Z"),
      event("stable", "terminal", "2026-07-17T10:00:00Z", { outcome: "merged" }),
      event("stable", "terminal", "2026-07-17T11:00:00Z", {
        event_id: "stable:later-pr-closed",
        outcome: "pr_closed",
      }),
    ]),
    { range: "6h", now },
  );
  assert.equal(data.summary.terminal_sessions, 1);
  assert.equal(data.summary.merged_sessions, 1);
  assert.equal(data.summary.command_to_merge_p50_ms, 60 * 60 * 1000);
  assert.equal(data.sessions[0]?.outcome, "merged");
  assert.equal(data.sessions[0]?.terminal_at, "2026-07-17T10:00:00.000Z");
});

test("empty buckets are gaps and populated buckets under five are low sample", () => {
  const data = summarizeAutomergeMetrics(
    ledger([
      event("s6", "activated", "2026-07-17T10:00:00Z"),
      event("s6", "terminal", "2026-07-17T10:31:00Z", { outcome: "merged" }),
    ]),
    { range: "6h", now },
  );
  assert.ok(data.buckets.some((bucket) => bucket.success_rate_percent === null));
  const populated = data.buckets.find((bucket) => bucket.terminal_count === 1);
  assert.equal(populated?.success_rate_percent, 100);
  assert.equal(populated?.low_sample, true);
  assert.equal(data.buckets.length, 12);
});

test("a terminal event exactly at the range end belongs to the final bucket", () => {
  const data = summarizeAutomergeMetrics(
    ledger([event("edge", "terminal", now, { outcome: "merged" })]),
    { range: "6h", now },
  );
  assert.equal(data.summary.terminal_sessions, 1);
  assert.equal(data.buckets.at(-1)?.terminal_count, 1);
});

test("range configuration and policy filters are applied", () => {
  const rows = [
    event("s7", "terminal", "2026-07-17T11:00:00Z", { outcome: "merged" }),
    event("s8", "terminal", "2026-07-17T10:00:00Z", {
      outcome: "maintainer_stopped",
      policy_version: "backoff-v1",
    }),
  ];
  assert.equal(summarizeAutomergeMetrics(ledger(rows), { range: "24h", now }).buckets.length, 12);
  assert.equal(summarizeAutomergeMetrics(ledger(rows), { range: "7d", now }).buckets.length, 14);
  const filtered = summarizeAutomergeMetrics(ledger(rows), {
    range: "6h",
    policyVersion: "backoff-v1",
    now,
  });
  assert.equal(filtered.summary.terminal_sessions, 1);
  assert.equal(filtered.summary.merge_success_rate_percent, 0);
  assert.equal(filtered.telemetry_since, "2026-07-17T10:00:00.000Z");
  assert.equal(filtered.coverage_percent, 33);
  const missing = summarizeAutomergeMetrics(ledger(rows), {
    range: "6h",
    policyVersion: "future-v1",
    now,
  });
  assert.equal(missing.telemetry_since, null);
  assert.equal(missing.coverage_percent, 0);
});

test("nearest-rank p90 preserves a long-tail latency", () => {
  assert.equal(percentile([1, 2, 3, 4, 100], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 100], 0.9), 100);
  assert.equal(percentile([], 0.9), null);
});

test("base sync distribution exposes repeated main chasing", () => {
  const rows: AutomergeMetricEvent[] = [];
  for (const [index, syncs] of [0, 1, 2].entries()) {
    const session = `sync${index + 1}`;
    rows.push(event(session, "activated", `2026-07-17T0${8 + index}:00:00Z`));
    for (let count = 0; count < syncs; count += 1) {
      rows.push(
        event(session, "repair_completed", `2026-07-17T${10 + count}:0${index}:00Z`, {
          event_id: `${session}:repair:${count}`,
          base_sync: true,
        }),
      );
    }
    rows.push(event(session, "terminal", `2026-07-17T11:${index}0:00Z`, { outcome: "merged" }));
  }
  const data = summarizeAutomergeMetrics(ledger(rows), { range: "6h", now });
  assert.equal(data.summary.base_sync_p50, 1);
  assert.equal(data.summary.base_sync_p90, 2);
  assert.equal(data.summary.multi_rebase_rate_percent, 33.3);
});

test("reactivation creates a new stable session and ingest failure is non-fatal", async () => {
  const first = automergeSessionId({
    repo: "openclaw/openclaw",
    issue_number: 42,
    comment_id: "100",
    comment_updated_at: "2026-07-17T10:00:00Z",
  });
  const second = automergeSessionId({
    repo: "openclaw/openclaw",
    issue_number: 42,
    comment_id: "200",
    comment_updated_at: "2026-07-17T11:00:00Z",
  });
  assert.notEqual(first, second);
  const delivered = await postAutomergeMetricBestEffort(
    {
      event_type: "clawsweeper.automerge_metric",
      event_id: "event",
      session_id: first!,
      phase: "activated",
      occurred_at: now,
      repository: "openclaw/openclaw",
      item_number: 42,
      policy_version: "immediate-v1",
      state: "active",
      outcome: null,
      reason: null,
      pr_url: "https://github.com/openclaw/openclaw/pull/42",
      run_url: null,
    },
    { CLAWSWEEPER_STATUS_INGEST_TOKEN: "token" },
    async () => {
      throw new Error("dashboard unavailable");
    },
  );
  assert.equal(delivered, false);
});

test("batched stop commands bind to the preceding activation, not a future reactivation", () => {
  const base = { repo: "openclaw/openclaw", issue_number: 42, status: "executed" };
  const first = {
    ...base,
    intent: "automerge",
    comment_id: "100",
    comment_updated_at: "2026-07-17T10:00:00Z",
  };
  const stop = {
    ...base,
    intent: "stop",
    comment_id: "150",
    comment_updated_at: "2026-07-17T10:30:00Z",
  };
  const second = {
    ...base,
    intent: "automerge",
    comment_id: "200",
    comment_updated_at: "2026-07-17T11:00:00Z",
  };
  assert.equal(latestAutomergeActivationForCommand(stop, [first, stop, second]), first);
  assert.equal(latestAutomergeActivationForCommand(second, [first, stop, second]), second);
  const afterStop = {
    ...base,
    intent: "clawsweeper_auto_merge",
    comment_id: "175",
    comment_updated_at: "2026-07-17T10:45:00Z",
  };
  assert.equal(
    latestAutomergeActivationForCommand(afterStop, [first, stop, afterStop, second]),
    undefined,
  );
});

test("best-effort ingest has a bounded deadline even when fetch never settles", async () => {
  const startedAt = Date.now();
  const delivered = await postAutomergeMetricBestEffort(
    {
      event_type: "clawsweeper.automerge_metric",
      event_id: "timeout-event",
      session_id: "openclaw/openclaw#42:100:2026-07-17T10:00:00Z",
      phase: "activated",
      occurred_at: now,
      repository: "openclaw/openclaw",
      item_number: 42,
      policy_version: "immediate-v1",
      state: "active",
      outcome: null,
      reason: null,
      pr_url: "https://github.com/openclaw/openclaw/pull/42",
      run_url: null,
    },
    {
      CLAWSWEEPER_STATUS_INGEST_TOKEN: "token",
      CLAWSWEEPER_AUTOMERGE_METRIC_TIMEOUT_MS: "5",
    },
    async () => new Promise<Response>(() => undefined),
  );
  assert.equal(delivered, false);
  assert.ok(Date.now() - startedAt < 500);
});

test("reconciliation retries a lost terminal delivery with a stable merged event", async () => {
  const posted = [];
  let ingestAttempts = 0;
  const fetcher = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/automerge-metrics")) {
      return Response.json({
        sessions: [
          {
            session_id: "openclaw/clawsweeper#648:5003787598:2026-07-17T13:30:27Z",
            repository: "openclaw/clawsweeper",
            item_number: 648,
            policy_version: "immediate-v1",
            last_event_at: "2026-07-17T13:30:27Z",
            terminal_at: null,
          },
        ],
      });
    }
    if (url.includes("api.github.com/repos/openclaw/clawsweeper/pulls/648")) {
      return Response.json({
        state: "closed",
        closed_at: "2026-07-17T13:39:18Z",
        merged_at: "2026-07-17T13:39:18Z",
      });
    }
    if (url.endsWith("/api/events")) {
      posted.push(JSON.parse(String(init?.body)));
      ingestAttempts += 1;
      return new Response("", { status: ingestAttempts === 1 ? 503 : 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const options = {
    env: {
      CLAWSWEEPER_STATUS_URL: "https://status.example.test",
      CLAWSWEEPER_STATUS_INGEST_TOKEN: "token",
    },
    fetcher,
    now: "2026-07-17T14:00:00Z",
  };

  const first = await reconcileAutomergeProductMetrics(options);
  const second = await reconcileAutomergeProductMetrics(options);

  assert.equal(first.delivered, 0);
  assert.equal(first.failed, 1);
  assert.equal(second.delivered, 1);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].event_id, posted[1].event_id);
  assert.equal(posted[0].outcome, "merged");
  assert.equal(posted[0].occurred_at, "2026-07-17T13:39:18.000Z");
});

test("reconciliation caps active-session and GitHub reads", async () => {
  const githubReads = [];
  let metricsUrl = "";
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    session_id: `openclaw/openclaw#${index + 1}:100:2026-07-17T13:00:00Z`,
    repository: "openclaw/openclaw",
    item_number: index + 1,
    last_event_at: "2026-07-17T13:00:00Z",
    terminal_at: null,
  }));
  const result = await reconcileAutomergeProductMetrics({
    env: {
      CLAWSWEEPER_STATUS_URL: "https://status.example.test",
      CLAWSWEEPER_STATUS_INGEST_TOKEN: "token",
      CLAWSWEEPER_AUTOMERGE_RECONCILE_LIMIT: "3",
      CLAWSWEEPER_AUTOMERGE_RECONCILE_TIMEOUT_MS: "1000",
    },
    now: "2026-07-17T14:00:00Z",
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes("/api/automerge-metrics")) {
        metricsUrl = url;
        return Response.json({ sessions });
      }
      githubReads.push(url);
      return Response.json({ state: "open", merged_at: null, closed_at: null });
    },
  });

  assert.equal(result.candidates, 3);
  assert.equal(result.github_reads, 3);
  assert.equal(githubReads.length, 3);
  assert.match(metricsUrl, /range=7d/);
  assert.match(metricsUrl, /active_only=true/);
  assert.match(metricsUrl, /session_limit=3/);
});

test("active-only metric sessions are bounded and oldest first", () => {
  const data = summarizeAutomergeMetrics(
    ledger([
      event("active-1", "activated", "2026-07-17T08:00:00Z"),
      event("active-2", "activated", "2026-07-17T09:00:00Z"),
      event("active-3", "activated", "2026-07-17T10:00:00Z"),
      event("terminal", "terminal", "2026-07-17T11:00:00Z", { outcome: "merged" }),
    ]),
    { range: "24h", now, activeOnly: true, sessionLimit: 2 },
  );

  assert.deepEqual(
    data.sessions.map((session) => session.session_id),
    ["active-1", "active-2"],
  );
});

for (const conclusion of ["failure", "timed_out", "action_required"]) {
  test(`open PR with ${conclusion} repair run becomes repair_failed`, async () => {
    const posted = [];
    const sessionId = "openclaw/openclaw#42:100:2026-07-17T10:00:00Z";
    const result = await reconcileAutomergeProductMetrics({
      env: reconcileEnv(),
      now,
      sessionId,
      fetcher: reconcileFetcher({
        session: activeSession(sessionId),
        pr: { state: "open", merged_at: null, closed_at: null },
        run: repairRun(conclusion),
        posted,
      }),
    });

    assert.equal(result.terminal, 1);
    assert.equal(result.delivered, 1);
    assert.equal(result.github_reads, 3);
    assert.equal(posted[0]?.outcome, "repair_failed");
    assert.equal(posted[0]?.event_id, `${sessionId}:terminal:reconcile:repair_failed`);
    assert.equal(posted[0]?.occurred_at, "2026-07-17T11:30:00.000Z");
  });
}

test("failed workflow reports immediately while its GitHub run is still finalizing", async () => {
  const posted = [];
  const result = await reconcileAutomergeProductMetrics({
    env: reconcileEnv(),
    now,
    sessionId: "openclaw/openclaw#42:100:2026-07-17T10:00:00Z",
    runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/9001",
    runConclusion: "failure",
    fetcher: reconcileFetcher({
      session: activeSession(),
      pr: { state: "open", merged_at: null, closed_at: null },
      run: repairRun(null, "in_progress"),
      posted,
    }),
  });

  assert.equal(result.delivered, 1);
  assert.equal(posted[0]?.outcome, "repair_failed");
  assert.equal(posted[0]?.occurred_at, now);
});

test("completed GitHub run conclusion overrides an early workflow failure report", async () => {
  const posted = [];
  const result = await reconcileAutomergeProductMetrics({
    env: reconcileEnv(),
    now,
    sessionId: "openclaw/openclaw#42:100:2026-07-17T10:00:00Z",
    runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/9001",
    runConclusion: "failure",
    fetcher: reconcileFetcher({
      session: activeSession(),
      pr: { state: "open", merged_at: null, closed_at: null },
      run: repairRun("success", "completed"),
      posted,
    }),
  });

  assert.equal(result.terminal, 0);
  assert.equal(posted.length, 0);
});

test("scheduled reconciliation preserves sessions whose failed run requeued successfully", async () => {
  const posted = [];
  const result = await reconcileAutomergeProductMetrics({
    env: reconcileEnv(),
    now,
    fetcher: reconcileFetcher({
      session: activeSession(),
      pr: { state: "open", merged_at: null, closed_at: null },
      run: repairRun("failure"),
      jobs: repairJobs("success"),
      posted,
    }),
  });

  assert.equal(result.terminal, 0);
  assert.equal(result.github_reads, 3);
  assert.equal(result.results[0]?.skipped, "repair_run_successfully_requeued");
  assert.equal(posted.length, 0);
});

test("competing terminal outcomes keep distinct event identities", async () => {
  const posted = [];
  const session = activeSession();
  for (const pr of [
    { state: "open", merged_at: null, closed_at: null },
    { state: "closed", merged_at: "2026-07-17T11:45:00Z", closed_at: "2026-07-17T11:45:00Z" },
  ]) {
    await reconcileAutomergeProductMetrics({
      env: reconcileEnv(),
      now,
      fetcher: reconcileFetcher({
        session,
        pr,
        run: repairRun("failure"),
        posted,
      }),
    });
  }

  assert.deepEqual(
    posted.map((row) => row.event_id),
    [
      `${session.session_id}:terminal:reconcile:repair_failed`,
      `${session.session_id}:terminal:reconcile:merged`,
    ],
  );
});

for (const [status, conclusion] of [
  ["in_progress", null],
  ["completed", "success"],
  ["completed", "cancelled"],
  ["completed", "neutral"],
  ["completed", "skipped"],
]) {
  test(`repair run ${status}/${conclusion ?? "none"} stays active`, async () => {
    const posted = [];
    const result = await reconcileAutomergeProductMetrics({
      env: reconcileEnv(),
      now,
      fetcher: reconcileFetcher({
        session: activeSession(),
        pr: { state: "open", merged_at: null, closed_at: null },
        run: repairRun(conclusion, status),
        posted,
      }),
    });

    assert.equal(result.terminal, 0);
    assert.equal(result.delivered, 0);
    assert.equal(posted.length, 0);
  });
}

test("merged and closed PR state takes priority without reading a failed run", async () => {
  for (const [pr, outcome] of [
    [
      {
        state: "closed",
        merged_at: "2026-07-17T11:20:00Z",
        closed_at: "2026-07-17T11:21:00Z",
      },
      "merged",
    ],
    [{ state: "closed", merged_at: null, closed_at: "2026-07-17T11:21:00Z" }, "pr_closed"],
  ]) {
    const posted = [];
    let runReads = 0;
    const result = await reconcileAutomergeProductMetrics({
      env: reconcileEnv(),
      now,
      fetcher: reconcileFetcher({
        session: activeSession(),
        pr,
        run: repairRun("failure"),
        posted,
        onRunRead: () => (runReads += 1),
      }),
    });

    assert.equal(result.github_reads, 1);
    assert.equal(runReads, 0);
    assert.equal(posted[0]?.outcome, outcome);
  }
});

test("invalid and external repair run URLs are conservative skips", async () => {
  for (const runUrl of ["not-a-url", "https://github.com/example/foreign/actions/runs/9001"]) {
    const posted = [];
    const result = await reconcileAutomergeProductMetrics({
      env: reconcileEnv(),
      now,
      fetcher: reconcileFetcher({
        session: activeSession(undefined, runUrl),
        pr: { state: "open", merged_at: null, closed_at: null },
        run: repairRun("failure"),
        posted,
      }),
    });

    assert.equal(result.terminal, 0);
    assert.equal(result.github_reads, 1);
    assert.equal(posted.length, 0);
  }
});

test("repair workflow repository and identity must match", async () => {
  for (const run of [
    repairRun("failure", "completed", "example/foreign"),
    { ...repairRun("failure"), path: ".github/workflows/other.yml@refs/heads/main" },
  ]) {
    const posted = [];
    const result = await reconcileAutomergeProductMetrics({
      env: reconcileEnv(),
      now,
      fetcher: reconcileFetcher({
        session: activeSession(),
        pr: { state: "open", merged_at: null, closed_at: null },
        run,
        posted,
      }),
    });
    assert.equal(result.terminal, 0);
    assert.equal(posted.length, 0);
  }
});

test("seven-day lookback includes legacy failed sessions and exact-session filtering", async () => {
  const sessionId = "openclaw/openclaw#42:100:2026-07-11T10:00:00Z";
  let metricsUrl = "";
  const posted = [];
  const result = await reconcileAutomergeProductMetrics({
    env: reconcileEnv(),
    now,
    sessionId,
    fetcher: reconcileFetcher({
      session: activeSession(sessionId, undefined, "2026-07-11T12:00:00Z"),
      pr: { state: "open", merged_at: null, closed_at: null },
      run: repairRun("failure"),
      posted,
      onMetricsRead: (url) => (metricsUrl = url),
    }),
  });

  assert.equal(result.delivered, 1);
  assert.match(metricsUrl, /range=7d/);
  assert.match(metricsUrl, /session_id=openclaw%2Fopenclaw%2342/);
  assert.match(metricsUrl, /session_limit=1/);
});

test("merged plus repair_failed produces a 50 percent terminal success rate", () => {
  const data = summarizeAutomergeMetrics(
    ledger([
      event("merged-session", "activated", "2026-07-17T08:00:00Z"),
      event("merged-session", "terminal", "2026-07-17T09:00:00Z", {
        outcome: "merged",
      }),
      event("failed-session", "activated", "2026-07-17T09:00:00Z"),
      event("failed-session", "terminal", "2026-07-17T10:00:00Z", {
        outcome: "repair_failed",
      }),
    ]),
    { range: "6h", now },
  );

  assert.equal(data.summary.terminal_sessions, 2);
  assert.equal(data.summary.merge_success_rate_percent, 50);
  assert.equal(data.terminal_outcomes.repair_failed, 1);
  assert.equal(
    data.sessions.find((row) => row.session_id === "failed-session")?.state,
    "repair_failed",
  );
});

function reconcileEnv() {
  return {
    CLAWSWEEPER_STATUS_URL: "https://status.example.test",
    CLAWSWEEPER_STATUS_INGEST_TOKEN: "token",
  };
}

function activeSession(
  sessionId = "openclaw/openclaw#42:100:2026-07-17T10:00:00Z",
  runUrl = "https://github.com/openclaw/clawsweeper/actions/runs/9001",
  lastEventAt = "2026-07-17T10:00:00Z",
) {
  return {
    session_id: sessionId,
    repository: "openclaw/openclaw",
    item_number: 42,
    policy_version: "immediate-v1",
    last_event_at: lastEventAt,
    terminal_at: null,
    run_url: runUrl,
  };
}

function repairRun(conclusion, status = "completed", repository = "openclaw/clawsweeper") {
  return {
    id: 9001,
    status,
    conclusion,
    updated_at: "2026-07-17T11:30:00Z",
    path: ".github/workflows/repair-cluster-worker.yml@refs/heads/main",
    repository: { full_name: repository },
  };
}

function repairJobs(requeueConclusion = "skipped") {
  return {
    total_count: 1,
    jobs: [
      {
        steps: [
          {
            name: "Requeue source-head repair races",
            conclusion: requeueConclusion,
          },
        ],
      },
    ],
  };
}

function reconcileFetcher({
  session,
  pr,
  run,
  jobs = repairJobs(),
  posted,
  onRunRead,
  onMetricsRead,
}) {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/api/automerge-metrics")) {
      onMetricsRead?.(url);
      return Response.json({ sessions: [session] });
    }
    if (url.includes("/pulls/42")) return Response.json(pr);
    if (url.includes("/actions/runs/9001")) {
      onRunRead?.();
      if (url.includes("/jobs?")) return Response.json(jobs);
      return Response.json(run);
    }
    if (url.endsWith("/api/events")) {
      posted.push(JSON.parse(String(init?.body)));
      return new Response("", { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };
}
