import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import {
  normalizeApplyObservabilityEvent,
  summarizeApplyObservability,
} from "../dashboard/apply-observability.ts";

const NOW = Date.parse("2026-07-21T12:00:00Z");
const run = promisify(execFile);

function event(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    repo: "openclaw/openclaw",
    run_id: "12345",
    run_attempt: 1,
    occurred_at: "2026-07-21T11:55:00Z",
    started_at: "2026-07-21T11:40:00Z",
    outcome: "success",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/12345",
    queue: {
      active: 1,
      capacity: 1,
      ready: 12,
      backoff: null,
      dispatching: 0,
      leased: null,
      oldest_ready_age_seconds: 900,
      oldest_backoff_age_seconds: null,
      oldest_lease_age_seconds: null,
    },
    arrivals: 5,
    results: { applied: 8, closed: 3, superseded: 1, retried: 2, dead_lettered: 0 },
    lease: { wait_ms: null, hold_ms: null },
    observed_failure_kinds: [
      "action_ledger_failure",
      "state_publication_failure",
      "safe_close_blocked",
      "workflow_failure",
    ],
    failures: [],
    ...overrides,
  };
}

test("apply observability preserves unknown values instead of making them healthy zeros", () => {
  const normalized = normalizeApplyObservabilityEvent(event({ arrivals: null }), NOW);
  assert.ok(normalized);
  const summary = summarizeApplyObservability({
    events: [normalized],
    range: "24h",
    repo: null,
    now: NOW,
  });
  assert.equal(summary.last_15_minutes.arrivals, null);
  assert.equal(summary.queue.leased, null);
  assert.equal(summary.lease.wait_ms, null);
  assert.equal(summary.failures.state_lease_timeout, null);
  const zero = normalizeApplyObservabilityEvent(
    event({
      run_id: "12349",
      arrivals: 0,
      results: { applied: 0, closed: 0, superseded: 0, retried: 0, dead_lettered: 0 },
    }),
    NOW,
  )!;
  const mixed = summarizeApplyObservability({
    events: [normalized, zero],
    range: "24h",
    repo: null,
    now: NOW,
  });
  assert.equal(mixed.totals.arrivals, null);
});

test("apply observability reports disjoint result and failure accounting in selected windows", () => {
  const first = normalizeApplyObservabilityEvent(event(), NOW)!;
  const second = normalizeApplyObservabilityEvent(
    event({
      run_id: "12346",
      occurred_at: "2026-07-21T11:20:00Z",
      started_at: "2026-07-21T11:00:00Z",
      results: { applied: 2, closed: 1, superseded: 0, retried: 1, dead_lettered: 1 },
      observed_failure_kinds: ["state_lease_contention"],
      failures: [{ kind: "state_lease_contention", at: "2026-07-21T11:20:00Z" }],
    }),
    NOW,
  )!;
  const summary = summarizeApplyObservability({
    events: [first, second],
    range: "24h",
    repo: null,
    now: NOW,
  });
  assert.equal(summary.last_60_minutes.applied, 10);
  assert.equal(summary.last_60_minutes.closed, 4);
  assert.equal(summary.totals.superseded, 1);
  assert.equal(summary.totals.dead_lettered, 1);
  assert.equal(summary.failures.state_lease_contention, 1);
  assert.equal(summary.retry_amplification, 0.3);
});

test("apply observability rejects malformed producer payloads", () => {
  assert.equal(normalizeApplyObservabilityEvent(event({ repo: "not-a-repo" }), NOW), null);
  assert.equal(
    normalizeApplyObservabilityEvent(
      event({ failures: [{ kind: "secret", at: "2026-07-21T11:55:00Z" }] }),
      NOW,
    ),
    null,
  );
});

test("all-repository queue health stays unknown until every configured target reports", () => {
  const first = normalizeApplyObservabilityEvent(event(), NOW)!;
  const missing = summarizeApplyObservability({
    events: [first],
    range: "24h",
    repo: null,
    repositories: ["openclaw/openclaw", "openclaw/other"],
    now: NOW,
  });
  assert.equal(missing.telemetry_complete, false);
  assert.equal(missing.queue.ready, null);

  const second = normalizeApplyObservabilityEvent(
    event({
      repo: "openclaw/other",
      run_id: "12347",
      queue: {
        active: 2,
        capacity: 3,
        ready: 4,
        backoff: 1,
        dispatching: 1,
        leased: 0,
        oldest_ready_age_seconds: 1_200,
        oldest_backoff_age_seconds: 300,
        oldest_lease_age_seconds: 0,
      },
    }),
    NOW,
  )!;
  const excluded = normalizeApplyObservabilityEvent(
    event({
      repo: "openclaw/excluded",
      run_id: "12348",
      arrivals: 99,
      results: { applied: 99, closed: 99, superseded: 0, retried: 0, dead_lettered: 0 },
    }),
    NOW,
  )!;
  const complete = summarizeApplyObservability({
    events: [first, second, excluded],
    range: "24h",
    repo: null,
    repositories: ["openclaw/openclaw", "openclaw/other"],
    now: NOW,
  });
  assert.equal(complete.telemetry_complete, true);
  assert.equal(complete.queue.active, 3);
  assert.equal(complete.queue.ready, 16);
  assert.equal(complete.queue.oldest_ready_age_seconds, 1_200);
  assert.equal(complete.lease.wait_ms, null);
  assert.equal(complete.last_60_minutes.applied, 16);
});

test("apply observability becomes unavailable after the expected producer cadence", () => {
  const stale = normalizeApplyObservabilityEvent(
    event({
      occurred_at: "2026-07-21T11:10:00Z",
      started_at: "2026-07-21T11:00:00Z",
    }),
    NOW,
  )!;
  const summary = summarizeApplyObservability({
    events: [stale],
    range: "24h",
    repo: null,
    repositories: ["openclaw/openclaw"],
    now: NOW,
  });
  assert.equal(summary.telemetry_complete, false);
  assert.equal(summary.queue.ready, null);
});

test("apply telemetry producer keeps successful terminal steps distinct from ledger failures", async (t) => {
  const payloads: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const script = fileURLToPath(
    new URL("../scripts/publish-apply-observability.mjs", import.meta.url),
  );
  const cwd = mkdtempSync(join(tmpdir(), "clawsweeper-apply-observability-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".artifacts"));
  writeFileSync(
    join(cwd, ".artifacts", "apply-observability-context.json"),
    JSON.stringify({ noop: true }),
  );
  await run(process.execPath, [script], {
    cwd,
    env: {
      ...process.env,
      ACTION_LEDGER_OUTCOME: "success",
      APPLY_OUTCOME: "success",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "12345",
      QUEUE_URL: "http://127.0.0.1:" + address.port,
      STATE_PUBLICATION_OUTCOME: "success",
      STATE_STATUS_OUTCOME: "success",
      TARGET_REPO: "openclaw/openclaw",
    },
  });
  const successfulPayload = payloads[0];
  assert.ok(successfulPayload);
  assert.deepEqual(
    (successfulPayload.event as { observed_failure_kinds?: unknown }).observed_failure_kinds,
    [],
  );
  assert.deepEqual((successfulPayload.event as { failures?: unknown }).failures, []);
  assert.deepEqual((successfulPayload.event as { results?: unknown }).results, {
    applied: 0,
    closed: 0,
    superseded: null,
    retried: null,
    dead_lettered: null,
  });

  await run(process.execPath, [script], {
    cwd,
    env: {
      ...process.env,
      ACTION_LEDGER_OUTCOME: "failure",
      APPLY_OUTCOME: "success",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "12346",
      QUEUE_URL: "http://127.0.0.1:" + address.port,
      STATE_PUBLICATION_OUTCOME: "success",
      STATE_STATUS_OUTCOME: "success",
      TARGET_REPO: "openclaw/openclaw",
    },
  });
  const ledgerFailurePayload = payloads[1];
  assert.ok(ledgerFailurePayload);
  assert.deepEqual(
    (ledgerFailurePayload.event as { observed_failure_kinds?: unknown }).observed_failure_kinds,
    ["action_ledger_failure"],
  );
  assert.deepEqual((ledgerFailurePayload.event as { failures?: unknown }).failures, [
    { kind: "action_ledger_failure", at: (ledgerFailurePayload.event as { occurred_at: string }).occurred_at },
  ]);
});

test("apply telemetry producer preserves the newest checkpoint health after a failed apply", async (t) => {
  const payloads: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const script = fileURLToPath(
    new URL("../scripts/publish-apply-observability.mjs", import.meta.url),
  );
  const cwd = mkdtempSync(join(tmpdir(), "clawsweeper-apply-observability-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".artifacts"));
  writeFileSync(
    join(cwd, ".artifacts", "apply-health-3.json"),
    JSON.stringify({
      closed: 2,
      comment_synced: 3,
      cycle: { apply_ready_count: 7 },
      next_actions: [{ bucket: "maintainer_review" }],
    }),
  );
  await run(process.execPath, [script, "--health-file", ".artifacts/apply-health-final.json"], {
    cwd,
    env: {
      ...process.env,
      ACTION_LEDGER_OUTCOME: "success",
      APPLY_OUTCOME: "failure",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "12347",
      QUEUE_URL: "http://127.0.0.1:" + address.port,
      STATE_PUBLICATION_OUTCOME: "success",
      STATE_STATUS_OUTCOME: "success",
      TARGET_REPO: "openclaw/openclaw",
    },
  });
  const payload = payloads[0];
  assert.ok(payload);
  assert.deepEqual((payload.event as { queue?: unknown }).queue, {
    active: 0,
    capacity: 1,
    ready: 7,
    backoff: null,
    dispatching: 0,
    leased: null,
    oldest_ready_age_seconds: null,
    oldest_backoff_age_seconds: null,
    oldest_lease_age_seconds: null,
  });
  assert.deepEqual((payload.event as { results?: unknown }).results, {
    applied: 5,
    closed: 2,
    superseded: null,
    retried: null,
    dead_lettered: null,
  });
  assert.deepEqual((payload.event as { observed_failure_kinds?: unknown }).observed_failure_kinds, [
    "safe_close_blocked",
    "workflow_failure",
  ]);
});
