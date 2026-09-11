import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addLedgerEntry,
  buildMergeNotification,
  collectMergeNotifications,
  normalizeLedger,
  renderNotificationMessage,
  resolveHookAgentUrl,
  runMergeNotifier,
} from "../../dist/repair/notify-merge.js";

test("buildMergeNotification accepts executed ClawSweeper merge actions", () => {
  const notification = buildMergeNotification({
    repo: "openclaw/openclaw",
    target: "#123",
    action: "merge_canonical",
    status: "executed",
    reason: "merged by clawsweeper-repair",
    title: "Fix config parsing",
    merged_at: "2026-05-02T10:00:00Z",
    merge_commit_sha: "abc123",
    run_id: "987",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/987",
    cluster_id: "cluster-1",
  });

  assert.equal(notification?.key, "merge:openclaw/openclaw#123:merge_canonical:abc123");
  assert.equal(notification?.prUrl, "https://github.com/openclaw/openclaw/pull/123");
  assert.match(renderNotificationMessage(notification!), /ClawSweeper merged a pull request/);
});

test("buildMergeNotification skips already-merged catch-up rows", () => {
  assert.equal(
    buildMergeNotification({
      repo: "openclaw/openclaw",
      target: "#123",
      action: "merge_canonical",
      status: "executed",
      reason: "already merged",
      merge_commit_sha: "abc123",
    }),
    null,
  );
});

test("buildMergeNotification falls back when merge metadata is partial", () => {
  const withMergedAt = buildMergeNotification({
    repo: "openclaw/openclaw",
    target: "123",
    action: "merge_candidate",
    status: "executed",
    merged_at: "2026-05-02T10:00:00Z",
  });
  assert.equal(
    withMergedAt?.key,
    "merge:openclaw/openclaw#123:merge_candidate:2026-05-02T10:00:00Z",
  );

  const withUnknown = buildMergeNotification({
    repo: "openclaw/openclaw",
    target: "123",
    action: "merge_candidate",
    status: "executed",
  });
  assert.equal(withUnknown?.key, "merge:openclaw/openclaw#123:merge_candidate:unknown");
  assert.match(renderNotificationMessage(withUnknown!), /Merge commit: unknown/);
  assert.equal(buildMergeNotification({ action: "close", status: "executed" }), null);
  assert.equal(
    buildMergeNotification({ action: "merge_candidate", status: "planned", repo: "x/y" }),
    null,
  );
  assert.equal(
    buildMergeNotification({ action: "merge_candidate", status: "executed", repo: "x/y" }),
    null,
  );
});

test("collectMergeNotifications filters by run and ledger idempotency", () => {
  const rows = [
    {
      repo: "openclaw/openclaw",
      target: "#123",
      action: "merge_canonical",
      status: "executed",
      reason: "merged by clawsweeper-repair",
      merge_commit_sha: "abc123",
      run_id: "987",
    },
    {
      repo: "openclaw/openclaw",
      target: "#124",
      action: "merge_candidate",
      status: "executed",
      reason: "merged by clawsweeper-repair",
      merge_commit_sha: "def456",
      run_id: "other",
    },
  ];
  const first = collectMergeNotifications(rows, normalizeLedger({}), { runId: "987" });
  assert.equal(first.considered, 1);
  assert.equal(first.notifications.length, 1);

  const ledger = addLedgerEntry(normalizeLedger({}), first.notifications[0]!, {
    notifiedAt: "2026-05-02T10:00:00Z",
    hookRunId: "hook-run",
    discordTarget: "channel:123",
  });
  const second = collectMergeNotifications(rows, ledger, { runId: "987" });
  assert.equal(second.notifications.length, 0);
  assert.equal(second.skipped[0]?.reason, "notification already sent");
});

test("normalizeLedger accepts persisted camelCase and snake_case rows", () => {
  const ledger = normalizeLedger({
    updated_at: "2026-05-02T11:00:00Z",
    notifications: [
      {
        key: "merge:openclaw/openclaw#123:merge_canonical:abc123",
        idempotency_key: "custom",
        repo: "openclaw/openclaw",
        number: 123,
        action: "merge_canonical",
        notified_at: "2026-05-02T11:00:00Z",
        pr_url: "https://github.com/openclaw/openclaw/pull/123",
        merge_commit_sha: "abc123",
        run_id: "987",
        discord_target: "channel:123",
      },
      {
        key: "missing-required-fields",
      },
    ],
  });

  assert.equal(ledger.notifications.length, 1);
  assert.equal(ledger.notifications[0]?.idempotencyKey, "custom");
  assert.equal(ledger.notifications[0]?.mergeCommitSha, "abc123");
  assert.equal(ledger.notifications[0]?.runId, "987");
  assert.equal(ledger.notifications[0]?.discordTarget, "channel:123");
});

test("resolveHookAgentUrl accepts hook base or agent endpoint", () => {
  assert.equal(
    resolveHookAgentUrl("https://claw.example/hooks"),
    "https://claw.example/hooks/agent",
  );
  assert.equal(
    resolveHookAgentUrl("https://claw.example/hooks/agent"),
    "https://claw.example/hooks/agent",
  );
});

test("runMergeNotifier skips missing input and missing hook config", async () => {
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-notify-missing-"));
  const missing = await runMergeNotifier([], {
    root: missingRoot,
    log: () => undefined,
    env: {},
  });
  assert.equal(missing.status, "skipped");
  assert.equal(missing.reason, "input report missing");

  const unconfiguredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-notify-unset-"));
  fs.writeFileSync(
    path.join(unconfiguredRoot, "repair-apply-report.json"),
    `${JSON.stringify([
      {
        repo: "openclaw/openclaw",
        target: "#123",
        action: "merge_candidate",
        status: "executed",
        reason: "merged by clawsweeper-repair",
        merge_commit_sha: "abc123",
      },
    ])}\n`,
  );
  const unconfigured = await runMergeNotifier([], {
    root: unconfiguredRoot,
    log: () => undefined,
    env: {},
  });
  assert.equal(unconfigured.status, "skipped");
  assert.equal(unconfigured.pending, 1);
});

test("runMergeNotifier posts hook payloads and records sent ledger", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-notify-"));
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
        merged_at: "2026-05-02T10:00:00Z",
        merge_commit_sha: "abc123",
        run_id: "987",
      },
    ])}\n`,
  );

  const requests: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({
      ok: true,
      runId: "hook-run-1",
      completion: {
        status: "ok",
        replyDisposition: "visible",
        delivered: true,
        deliveryAttempted: true,
      },
    });
  };

  const summary = await runMergeNotifier(["--run-id", "987"], {
    root,
    fetch: mockFetch,
    now: () => new Date("2026-05-02T11:00:00Z"),
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
    },
  });

  assert.equal(summary.sent, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://claw.example/hooks/agent");
  assert.equal(requests[0]?.auth, "Bearer secret");
  assert.equal(requests[0]?.body.agentId, "clawsweeper");
  assert.equal(requests[0]?.body.to, "channel:123");
  assert.equal(requests[0]?.body.waitForCompletion, true);
  assert.match(String(requests[0]?.body.message), /Fix config parsing/);

  const ledger = JSON.parse(
    fs.readFileSync(path.join(root, "notifications/clawsweeper-merge-ledger.json"), "utf8"),
  );
  assert.equal(ledger.notifications[0].hookRunId, "hook-run-1");
  assert.equal(ledger.notifications[0].discordTarget, "channel:123");
  const report = JSON.parse(
    fs.readFileSync(path.join(root, "notifications/clawsweeper-merge-report.json"), "utf8"),
  );
  assert.deepEqual(report.actions[0].delivery, {
    status: "delivered",
    suppression_reason: null,
    error: null,
  });

  const rerun = await runMergeNotifier(["--run-id", "987"], {
    root,
    fetch: mockFetch,
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
    },
  });
  assert.equal(rerun.sent, 0);
  assert.equal(rerun.skipped, 1);
  assert.equal(requests.length, 1);
});

test("runMergeNotifier keeps unknown completion retryable and out of the ledger", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-notify-unknown-"));
  fs.writeFileSync(
    path.join(root, "repair-apply-report.json"),
    `${JSON.stringify([
      {
        repo: "openclaw/openclaw",
        target: "#123",
        action: "merge_candidate",
        status: "executed",
        merge_commit_sha: "abc123",
        run_id: "987",
      },
    ])}\n`,
  );

  const summary = await runMergeNotifier(["--run-id", "987", "--write-report"], {
    root,
    fetch: async () =>
      Response.json({ ok: true, runId: "hook-run-1", completion: { status: "skipped" } }),
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
    },
  });

  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 1);
  assert.equal(
    fs.existsSync(path.join(root, "notifications/clawsweeper-merge-ledger.json")),
    false,
  );
  const report = JSON.parse(
    fs.readFileSync(path.join(root, "notifications/clawsweeper-merge-report.json"), "utf8"),
  );
  assert.equal(report.actions[0].delivery.status, "unknown");
});

test("runMergeNotifier ledgers legacy admission to preserve at-most-once delivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-notify-admitted-"));
  fs.writeFileSync(
    path.join(root, "repair-apply-report.json"),
    `${JSON.stringify([
      {
        repo: "openclaw/openclaw",
        target: "#123",
        action: "merge_candidate",
        status: "executed",
        merge_commit_sha: "abc123",
        run_id: "987",
      },
    ])}\n`,
  );

  let calls = 0;
  const summary = await runMergeNotifier(["--run-id", "987", "--write-report"], {
    root,
    fetch: async () => {
      calls += 1;
      return Response.json({ ok: true, runId: "legacy-run" });
    },
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
    },
  });

  assert.equal(summary.sent, 1);
  assert.equal(calls, 1);
  const ledger = JSON.parse(
    fs.readFileSync(path.join(root, "notifications/clawsweeper-merge-ledger.json"), "utf8"),
  );
  assert.equal(ledger.notifications[0].hookRunId, "legacy-run");
  const report = JSON.parse(
    fs.readFileSync(path.join(root, "notifications/clawsweeper-merge-report.json"), "utf8"),
  );
  assert.equal(report.actions[0].delivery.status, "admitted");
  assert.match(report.actions[0].reason, /observability unavailable/);
});

test("runMergeNotifier returns a strict failure when the hook rejects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-notify-fail-"));
  fs.writeFileSync(
    path.join(root, "repair-apply-report.json"),
    `${JSON.stringify([
      {
        repo: "openclaw/openclaw",
        target: "#123",
        action: "merge_candidate",
        status: "executed",
        reason: "merged by clawsweeper-repair",
        merge_commit_sha: "abc123",
        run_id: "987",
      },
    ])}\n`,
  );

  const summary = await runMergeNotifier(["--run-id", "987", "--strict"], {
    root,
    fetch: (async () => new Response("denied", { status: 401 })) as typeof fetch,
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks/agent",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
    },
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.exitCode, 1);
  assert.equal(
    fs.existsSync(path.join(root, "notifications/clawsweeper-merge-ledger.json")),
    false,
  );
});
