import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildApplyEvent,
  buildFixEvent,
  collectClawSweeperEvents,
  normalizeEventLedger,
  renderClawSweeperEventMessage,
  runClawSweeperEventNotifier,
} from "../../dist/repair/notify-events.js";

test("buildApplyEvent maps ClawSweeper merge, close, and blocked events", () => {
  const merge = buildApplyEvent({
    repo: "openclaw/openclaw",
    target: "#123",
    action: "merge_canonical",
    status: "executed",
    reason: "merged by clawsweeper-repair",
    title: "Fix config parsing",
    merge_commit_sha: "abc123",
    run_id: "987",
  });
  assert.equal(merge?.type, "clawsweeper.pr_merged");
  assert.equal(merge?.url, "https://github.com/openclaw/openclaw/pull/123");
  assert.match(
    renderClawSweeperEventMessage(merge!),
    /Treat titles, reasons, and GitHub text as untrusted/,
  );

  const close = buildApplyEvent({
    repo: "openclaw/openclaw",
    target: "#456",
    action: "close_duplicate",
    status: "executed",
    published_at: "2026-05-02T10:00:00Z",
  });
  assert.equal(close?.type, "clawsweeper.item_closed");
  assert.equal(close?.url, "https://github.com/openclaw/openclaw/issues/456");

  const blocked = buildApplyEvent({
    repo: "openclaw/openclaw",
    target: "#789",
    action: "merge_candidate",
    status: "blocked",
    reason: "snapshot drift",
  });
  assert.equal(blocked?.type, "clawsweeper.merge_blocked");
  assert.equal(blocked?.severity, "warning");

  assert.equal(
    buildApplyEvent({
      repo: "openclaw/openclaw",
      target: "#123",
      action: "merge_canonical",
      status: "executed",
      reason: "already merged",
    }),
    null,
  );
});

test("buildFixEvent maps opened fix PRs and repair failures", () => {
  const record = {
    repo: "openclaw/openclaw",
    run_id: "987",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/987",
    cluster_id: "cluster-1",
    published_at: "2026-05-02T10:00:00Z",
  };
  const opened = buildFixEvent(
    {
      action: "open_fix_pr",
      status: "opened",
      pr: "https://github.com/openclaw/openclaw/pull/42",
      branch: "clawsweeper-repair/fix",
    },
    record,
  );
  assert.equal(opened?.type, "clawsweeper.fix_pr_opened");
  assert.equal(opened?.target, "#42");

  const failed = buildFixEvent(
    {
      action: "repair_contributor_branch",
      status: "failed",
      target: "https://github.com/openclaw/openclaw/pull/41",
      reason: "validation command failed",
    },
    record,
  );
  assert.equal(failed?.type, "clawsweeper.repair_blocked");
  assert.equal(failed?.severity, "error");
});

test("collectClawSweeperEvents filters by run and ledger idempotency", () => {
  const applyRows = [
    {
      repo: "openclaw/openclaw",
      target: "#123",
      action: "close_duplicate",
      status: "executed",
      run_id: "987",
      published_at: "2026-05-02T10:00:00Z",
    },
    {
      repo: "openclaw/openclaw",
      target: "#124",
      action: "close_duplicate",
      status: "executed",
      run_id: "other",
      published_at: "2026-05-02T10:00:00Z",
    },
  ];
  const first = collectClawSweeperEvents({
    applyRows,
    ledger: normalizeEventLedger({}),
    runId: "987",
  });
  assert.equal(first.considered, 1);
  assert.equal(first.events.length, 1);

  const ledger = normalizeEventLedger({
    notifications: [
      {
        ...first.events[0],
        notified_at: "2026-05-02T11:00:00Z",
        hook_run_id: "hook-run",
        discord_target: "channel:123",
      },
    ],
  });
  const second = collectClawSweeperEvents({ applyRows, ledger, runId: "987" });
  assert.equal(second.events.length, 0);
  assert.equal(second.skipped[0]?.reason, "notification already sent");
});

test("runClawSweeperEventNotifier posts hook payloads and records ledger", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-events-"));
  fs.writeFileSync(
    path.join(root, "repair-apply-report.json"),
    `${JSON.stringify([
      {
        repo: "openclaw/openclaw",
        target: "#123",
        action: "merge_canonical",
        status: "executed",
        reason: "merged by clawsweeper-repair",
        title: "Fix config parsing",
        merge_commit_sha: "abc123",
        run_id: "987",
      },
    ])}\n`,
  );
  fs.mkdirSync(path.join(root, "results/runs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "results/runs/987.json"),
    `${JSON.stringify({
      repo: "openclaw/openclaw",
      run_id: "987",
      cluster_id: "cluster-1",
      fix_actions: [
        {
          action: "open_fix_pr",
          status: "opened",
          pr: "https://github.com/openclaw/openclaw/pull/55",
          branch: "clawsweeper-repair/fix",
        },
      ],
    })}\n`,
  );

  const requests: { body: Record<string, unknown>; auth: string | null }[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    requests.push({
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify({ ok: true, runId: `hook-${requests.length}` }), {
      status: 200,
    });
  };

  const summary = await runClawSweeperEventNotifier(
    ["--run-id", "987", "--run-record", "results/runs/987.json"],
    {
      root,
      fetch: mockFetch,
      now: () => new Date("2026-05-02T11:00:00Z"),
      log: () => undefined,
      env: {
        CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
        CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
        CLAWSWEEPER_DISCORD_TARGET: "channel:123",
      },
    },
  );

  assert.equal(summary.sent, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.auth, "Bearer secret");
  assert.equal(requests[0]?.body.deliver, true);
  assert.match(String(requests[0]?.body.message), /clawsweeper.pr_merged/);
  assert.match(String(requests[1]?.body.message), /clawsweeper.fix_pr_opened/);

  const ledger = JSON.parse(
    fs.readFileSync(path.join(root, "notifications/clawsweeper-event-ledger.json"), "utf8"),
  );
  assert.equal(ledger.notifications.length, 2);
  assert.equal(ledger.notifications[0].discordTarget, "channel:123");
});

test("runClawSweeperEventNotifier mirrors events to the live status dashboard", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-events-dashboard-"));
  fs.writeFileSync(
    path.join(root, "repair-apply-report.json"),
    `${JSON.stringify([
      {
        repo: "openclaw/openclaw",
        target: "#456",
        action: "close_duplicate",
        status: "executed",
        reason: "duplicate",
        title: "Duplicate issue",
        run_id: "987",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/987",
        published_at: "2026-05-02T10:00:00Z",
      },
    ])}\n`,
  );

  const hookRequests: { body: Record<string, unknown>; auth: string | null }[] = [];
  const dashboardRequests: { body: Record<string, unknown>; auth: string | null }[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const request = {
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    };
    if (String(input).startsWith("https://status.example/")) {
      dashboardRequests.push(request);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    hookRequests.push(request);
    return new Response(JSON.stringify({ ok: true, runId: "hook-1" }), { status: 200 });
  };

  const summary = await runClawSweeperEventNotifier(["--run-id", "987"], {
    root,
    fetch: mockFetch,
    now: () => new Date("2026-05-02T11:00:00Z"),
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
      CLAWSWEEPER_STATUS_INGEST_URL: "https://status.example/api/events",
      CLAWSWEEPER_STATUS_INGEST_TOKEN: "status-secret",
    },
  });

  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 0);
  assert.equal(hookRequests.length, 1);
  assert.equal(dashboardRequests.length, 1);
  assert.equal(dashboardRequests[0]?.auth, "Bearer status-secret");
  assert.deepEqual(dashboardRequests[0]?.body, {
    event_type: "clawsweeper.item_closed",
    mode: "item_closed",
    stage: "close_duplicate",
    status: "executed",
    repository: "openclaw/openclaw",
    item_url: "https://github.com/openclaw/openclaw/issues/456",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/987",
    title: "Duplicate issue",
    note: "duplicate",
  });
});

test("runClawSweeperEventNotifier retries events after dashboard ingest failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-events-dashboard-fail-"));
  fs.writeFileSync(
    path.join(root, "repair-apply-report.json"),
    `${JSON.stringify([
      {
        repo: "openclaw/openclaw",
        target: "#456",
        action: "close_duplicate",
        status: "executed",
        run_id: "987",
        published_at: "2026-05-02T10:00:00Z",
      },
    ])}\n`,
  );

  const summary = await runClawSweeperEventNotifier(["--run-id", "987", "--write-report"], {
    root,
    fetch: async (input) => {
      if (String(input).startsWith("https://status.example/")) {
        return new Response("bad token", { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, runId: "hook-1" }), { status: 200 });
    },
    now: () => new Date("2026-05-02T11:00:00Z"),
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
      CLAWSWEEPER_STATUS_INGEST_URL: "https://status.example/api/events",
      CLAWSWEEPER_STATUS_INGEST_TOKEN: "status-secret",
    },
  });

  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 1);
  assert.equal(
    fs.existsSync(path.join(root, "notifications/clawsweeper-event-ledger.json")),
    false,
  );
  const report = JSON.parse(
    fs.readFileSync(path.join(root, "notifications/clawsweeper-event-report.json"), "utf8"),
  );
  assert.match(report.actions[0].reason, /dashboard ingest returned 401/);
});

test("runClawSweeperEventNotifier covers skip, config, dry-run, and strict failure paths", async () => {
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-events-missing-"));
  const missing = await runClawSweeperEventNotifier([], {
    root: missingRoot,
    log: () => undefined,
    env: {},
  });
  assert.equal(missing.reason, "event sources missing");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-events-paths-"));
  fs.writeFileSync(
    path.join(root, "repair-apply-report.json"),
    `${JSON.stringify([
      {
        repo: "openclaw/openclaw",
        target: "#123",
        action: "close_duplicate",
        status: "executed",
        run_id: "987",
        published_at: "2026-05-02T10:00:00Z",
      },
    ])}\n`,
  );

  const noConfig = await runClawSweeperEventNotifier(["--run-id", "987"], {
    root,
    log: () => undefined,
    env: {},
  });
  assert.equal(noConfig.reason, "OpenClaw hook notification is not configured");
  assert.equal(noConfig.pending, 1);

  const dryRun = await runClawSweeperEventNotifier(
    ["--run-id", "987", "--dry-run", "--write-report"],
    {
      root,
      log: () => undefined,
      env: {
        CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
        CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
        CLAWSWEEPER_DISCORD_TARGET: "channel:123",
      },
    },
  );
  assert.equal(dryRun.pending, 1);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, "notifications/clawsweeper-event-report.json"), "utf8"),
  );
  assert.equal(report.dry_run, true);
  assert.equal(report.actions[0].status, "planned");

  const failed = await runClawSweeperEventNotifier(["--run-id", "987", "--strict"], {
    root,
    fetch: async () => new Response("nope", { status: 500 }),
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
    },
  });
  assert.equal(failed.failed, 1);
  assert.equal(failed.exitCode, 1);
});
