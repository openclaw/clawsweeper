import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { actionLedgerJson } from "../../dist/action-ledger.js";
import {
  GitShallowHistoryExhaustionError,
  SHALLOW_MERGE_BASE_EXHAUSTION_DISPOSITION,
} from "../../dist/repair/git-publish.js";
import {
  DEFAULT_STATE_MATERIALIZER_MAX_BYTES,
  DEFAULT_STATE_MATERIALIZER_MAX_ROWS,
  planStateMaterialization,
  runStateMaterializer,
  stateMaterializerDeferralMessage,
  type StateAppendRecord,
} from "../../dist/repair/state-materializer.js";

const webhookSecret = "state-materializer-test-secret";
const producedAt = "2026-07-20T12:00:00.000Z";
const proofPath = `ledger/v1/import-bindings/events/${"a".repeat(64)}.json`;

test("materializer preserves canonical apply-proof content supplied as a string", () => {
  const content = `${actionLedgerJson({
    event_id: "proof-event-string",
    schema: "clawsweeper.action-ledger-import-event-binding",
    schema_version: 1,
  })}\n`;

  const plan = planStateMaterialization([record(1, "apply_proof", proofPath, content)]);

  assert.deepEqual(plan, {
    deletes: [],
    publishPaths: [proofPath],
    writes: [{ path: proofPath, content }],
    selected: 1,
    skipped: 0,
  });
});

test("materializer applies every record kind in sequence and keeps the last value per key", async () => {
  const fixture = createStateFixture();
  const records = [
    record(1, "sweep_status", "openclaw-openclaw", sweepStatus("old", "12:00:00.000")),
    record(2, "comment_router", "router-a", routerLedger("router-a", "12:00:01.000")),
    record(3, "apply_proof", proofPath, {
      event_id: "proof-event",
      schema: "clawsweeper.action-ledger-import-event-binding",
      schema_version: 1,
    }),
    record(4, "sweep_status", "openclaw-openclaw", sweepStatus("new", "12:00:04.000")),
    record(5, "comment_router", "router-b", routerLedger("router-b", "12:00:05.000")),
  ];
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let drainCalls = 0;
  let ackCalls = 0;
  const fetchImpl = signedQueueFetch(async (url, body) => {
    requests.push({ path: url.pathname, body });
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "drain-1", records })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    assert.equal(url.pathname, "/internal/state/ack");
    ackCalls += 1;
    assert.deepEqual(body, { drain_token: "drain-1" });
    return Response.json({ ok: true, acked: records.length });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 5, committed: 4, acked: 5, skipped: 1, errors: 0 });
  assert.equal(ackCalls, 1);
  assert.deepEqual(requests[0]?.body, {
    max_rows: DEFAULT_STATE_MATERIALIZER_MAX_ROWS,
    max_bytes: DEFAULT_STATE_MATERIALIZER_MAX_BYTES,
  });
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "rev-list", "--count", "state"], fixture.root),
    "2\n",
  );

  const status = JSON.parse(showState(fixture, "results/sweep-status/openclaw-openclaw.json"));
  assert.equal(status.detail, "new");
  assert.equal(status.updated_at, "2026-07-20T12:00:04.000Z");

  const router = JSON.parse(showState(fixture, "results/comment-router.json"));
  assert.deepEqual(
    router.commands.map((command: { comment_version_key: string }) => command.comment_version_key),
    ["base", "router-a", "router-b"],
  );
  assert.equal(
    showState(fixture, proofPath),
    `${actionLedgerJson({
      event_id: "proof-event",
      schema: "clawsweeper.action-ledger-import-event-binding",
      schema_version: 1,
    })}\n`,
  );
  assert.equal(statePathExists(fixture, "results/comment-router-latest.json"), false);
  assert.match(
    run("git", ["--git-dir", fixture.origin, "log", "-1", "--format=%B", "state"], fixture.root),
    /chore: materialize queued state[\s\S]*\[skip ci\]/,
  );
});

test("materializer commits one canonical record tuple atomically", async () => {
  const fixture = createStateFixture();
  const tuple = canonicalTuplePayload(42, "incoming", "2026-07-20T12:10:00.000Z");
  const records = [record(1, "record_tuple", "openclaw-openclaw/42", tuple)];
  let drainCalls = 0;
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "tuple-inline", records })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    assert.equal(url.pathname, "/internal/state/ack");
    return Response.json({ ok: true, acked: 1 });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 1, acked: 1, skipped: 0, errors: 0 });
  assert.match(showState(fixture, "records/openclaw-openclaw/items/42.md"), /# incoming/);
  assert.match(showState(fixture, "records/openclaw-openclaw/plans/42.md"), /Plan incoming/);
  assert.match(
    showState(fixture, "records/openclaw-openclaw/decision-packets/42.json"),
    /"marker": "incoming"/,
  );
  const commitPaths = run(
    "git",
    ["--git-dir", fixture.origin, "diff-tree", "--no-commit-id", "--name-only", "-r", "state"],
    fixture.root,
  )
    .trim()
    .split("\n")
    .filter((value) => value.startsWith("records/openclaw-openclaw/"));
  assert.deepEqual(commitPaths.sort(), tuple.operations.map((operation) => operation.path).sort());
});

test("materializer projects an items-to-closed move by deleting an explicitly retained plan", () => {
  const open = canonicalTuplePayload(45, "open", "2026-07-20T12:00:00.000Z");
  const closed = canonicalTuplePayload(45, "closed", "2026-07-20T12:10:00.000Z", {
    section: "closed",
    revision: 2,
    includePlan: true,
  });
  const currentFiles = new Map(
    open.operations.map((operation) => [operation.path, operation.content!]),
  );

  const plan = planStateMaterialization(
    [record(1, "record_tuple", "openclaw-openclaw/45", closed)],
    currentFiles,
  );

  assert.deepEqual(plan.deletes, [
    "records/openclaw-openclaw/items/45.md",
    "records/openclaw-openclaw/plans/45.md",
  ]);
  assert.equal(
    plan.writes.some((write) => write.path === "records/openclaw-openclaw/closed/45.md"),
    true,
  );
  assert.equal(plan.publishPaths.includes("records/openclaw-openclaw/items/45.md"), true);
  assert.equal(
    plan.writes.some((write) => write.path === "records/openclaw-openclaw/plans/45.md"),
    false,
  );
});

test("materializer deletes a retained packet when the authoritative primary clears its pointer", () => {
  const base = canonicalTuplePayload(48, "packet-base", "2026-07-20T12:00:00.000Z");
  const cleared = clearDecisionPacketReference(
    canonicalTuplePayload(48, "packet-cleared", "2026-07-20T12:10:00.000Z", { revision: 2 }),
  );
  const currentFiles = new Map(
    base.operations.map((operation) => [operation.path, operation.content!]),
  );

  const plan = planStateMaterialization(
    [record(1, "record_tuple", "openclaw-openclaw/48", cleared)],
    currentFiles,
  );

  assert.equal(
    cleared.operations.some((operation) => operation.section === "decision-packets"),
    true,
  );
  assert.equal(plan.deletes.includes("records/openclaw-openclaw/decision-packets/48.json"), true);
  assert.equal(
    plan.writes.some(
      (write) => write.path === "records/openclaw-openclaw/decision-packets/48.json",
    ),
    false,
  );
});

test("materializer coalesces section-changing tuple records by highest revision", () => {
  const closed = canonicalTuplePayload(46, "closed-newer", "2026-07-20T12:20:00.000Z", {
    section: "closed",
    revision: 2,
    includePlan: false,
  });
  const open = canonicalTuplePayload(46, "open-older", "2026-07-20T12:10:00.000Z", {
    revision: 1,
  });

  const plan = planStateMaterialization([
    record(1, "record_tuple", "openclaw-openclaw/46", closed),
    record(2, "record_tuple", "openclaw-openclaw/46", open),
  ]);

  assert.equal(plan.selected, 1);
  assert.equal(plan.skipped, 1);
  assert.equal(
    plan.writes.some(
      (write) =>
        write.path === "records/openclaw-openclaw/closed/46.md" &&
        write.content.includes("closed-newer"),
    ),
    true,
  );
  assert.equal(
    plan.writes.some((write) => write.path === "records/openclaw-openclaw/items/46.md"),
    false,
  );
});

test("materializer isolates a corrupt tuple, commits ordinary state, and records its dead letter", async () => {
  const fixture = createStateFixture();
  const invalid = canonicalTuplePayload(47, "invalid-open", "2026-07-20T12:10:00.000Z");
  const closed = canonicalTuplePayload(47, "invalid-closed", "2026-07-20T12:10:00.000Z", {
    section: "closed",
    includePlan: false,
  });
  invalid.operations.push(closed.operations.find((operation) => operation.section === "closed")!);
  const records = [
    record(1, "record_tuple", "openclaw-openclaw/47", invalid),
    record(2, "sweep_status", "openclaw-openclaw", sweepStatus("continued", "12:10:01.000")),
  ];
  let drainCalls = 0;
  let disposition: Record<string, unknown> | null = null;
  const fetchImpl = signedQueueFetch(async (url, body) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "mixed-cycle", records })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    assert.equal(url.pathname, "/internal/state/dispose");
    disposition = body;
    return Response.json({ ok: true, acked: 2, retried: 0, dead_lettered: 1 });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 2, committed: 1, acked: 2, skipped: 0, errors: 1 });
  assert.equal(
    JSON.parse(showState(fixture, "results/sweep-status/openclaw-openclaw.json")).detail,
    "continued",
  );
  assert.deepEqual(disposition, {
    drain_token: "mixed-cycle",
    failures: [
      {
        seq: 1,
        reason: "record tuple projection openclaw-openclaw/47 writes both primary sections",
        retryable: false,
      },
    ],
  });
});

test("materializer re-drains an already-published backlog without duplicating its commit", async () => {
  const fixture = createStateFixture();
  const records = [
    record(1, "sweep_status", "openclaw-openclaw", sweepStatus("backlog", "12:11:00.000")),
  ];
  let drainCalls = 0;
  let ackCalls = 0;
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      if (drainCalls <= 2) {
        return Response.json({ ok: true, drain_token: "redrain", records });
      }
      return Response.json({ ok: true, drain_token: null, records: [] });
    }
    assert.equal(url.pathname, "/internal/state/ack");
    ackCalls += 1;
    return Response.json({ ok: true, acked: ackCalls === 1 ? 0 : 1 });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 2, committed: 2, acked: 1, skipped: 0, errors: 0 });
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "rev-list", "--count", "state"], fixture.root),
    "2\n",
  );
});

test("materializer fetches oversize canonical tuple content before projection", async () => {
  const fixture = createStateFixture();
  const tuple = canonicalTuplePayload(43, "oversize", "2026-07-20T12:11:00.000Z");
  const primary = tuple.operations.find((operation) => operation.section === "items")!;
  delete primary.content;
  primary.oversize = true;
  const records = [record(1, "record_tuple", "openclaw-openclaw/43", tuple)];
  let drainCalls = 0;
  let fetchCalls = 0;
  const expectedContent = canonicalTuplePayload(
    43,
    "oversize",
    "2026-07-20T12:11:00.000Z",
  ).operations.find((operation) => operation.section === "items")!.content!;
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "tuple-oversize", records })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    if (url.pathname === "/internal/state/records/openclaw-openclaw/items/43") {
      fetchCalls += 1;
      return Response.json({
        content: expectedContent,
        digest: primary.digest,
        revision: 1,
        updatedAt: producedAt,
      });
    }
    assert.equal(url.pathname, "/internal/state/ack");
    return Response.json({ ok: true, acked: 1 });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 1, acked: 1, skipped: 0, errors: 0 });
  assert.equal(fetchCalls, 1);
  assert.equal(showState(fixture, primary.path), expectedContent);
});

test("materializer preserves a fresher concurrent git tuple through winner semantics", async () => {
  const fixture = createStateFixture();
  writeTupleFiles(fixture.state, canonicalTuplePayload(44, "base", "2026-07-20T12:00:00.000Z"));
  run("git", ["add", "records/openclaw-openclaw"], fixture.state);
  run("git", ["commit", "-m", "base tuple"], fixture.state);
  run("git", ["push", "origin", "HEAD:state"], fixture.state);
  fs.cpSync(path.join(fixture.state, "records"), path.join(fixture.source, "records"), {
    recursive: true,
  });

  const other = path.join(fixture.root, "concurrent");
  run("git", ["clone", fixture.origin, other], fixture.root);
  configureUser(other);
  run("git", ["checkout", "-B", "state", "origin/state"], other);
  writeTupleFiles(other, canonicalTuplePayload(44, "remote-newer", "2026-07-20T12:20:00.000Z"));
  run("git", ["add", "records/openclaw-openclaw"], other);
  run("git", ["commit", "-m", "concurrent newer tuple"], other);
  const hook = path.join(fixture.state, ".git/hooks/pre-push");
  const marker = path.join(fixture.state, ".git/hooks/materializer-race-fired");
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nif [ ! -f '${marker}' ]; then\n  touch '${marker}'\n  git -C '${other}' push origin HEAD:state\nfi\n`,
  );
  fs.chmodSync(hook, 0o755);

  const incoming = canonicalTuplePayload(44, "incoming-older", "2026-07-20T12:10:00.000Z");
  const records = [record(1, "record_tuple", "openclaw-openclaw/44", incoming)];
  let drainCalls = 0;
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "tuple-race", records })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    return Response.json({ ok: true, acked: 1 });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 1, acked: 1, skipped: 0, errors: 0 });
  assert.match(showState(fixture, "records/openclaw-openclaw/items/44.md"), /# remote-newer/);
  assert.doesNotMatch(
    showState(fixture, "records/openclaw-openclaw/items/44.md"),
    /incoming-older/,
  );
});

test("materializer dead-letters a normalize-phase filename alias and commits ordinary state", async () => {
  const fixture = createStateFixture();
  const alias = canonicalTuplePayload(49, "legacy alias", "2026-07-20T12:00:00.000Z");
  writeTupleFiles(fixture.state, alias);
  const recordsRoot = path.join(fixture.state, "records/openclaw-openclaw");
  fs.renameSync(
    path.join(recordsRoot, "items/49.md"),
    path.join(recordsRoot, "items/openclaw-openclaw-49.md"),
  );
  fs.rmSync(path.join(recordsRoot, "plans/49.md"));
  run("git", ["add", "records/openclaw-openclaw"], fixture.state);
  run("git", ["commit", "-m", "legacy alias tuple"], fixture.state);
  run("git", ["push", "origin", "HEAD:state"], fixture.state);
  fs.cpSync(path.join(fixture.state, "records"), path.join(fixture.source, "records"), {
    recursive: true,
  });

  const records = [
    record(
      1,
      "record_tuple",
      "openclaw-openclaw/49",
      canonicalTuplePayload(49, "canonical incoming", "2026-07-20T12:10:00.000Z", {
        revision: 2,
      }),
    ),
    record(2, "sweep_status", "openclaw-openclaw", sweepStatus("continued", "12:10:01.000")),
  ];
  let drainCalls = 0;
  let disposition: Record<string, unknown> | null = null;
  const fetchImpl = signedQueueFetch(async (url, body) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "normalize-alias", records })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    assert.equal(url.pathname, "/internal/state/dispose");
    disposition = body;
    return Response.json({ ok: true, acked: 2, retried: 0, dead_lettered: 1 });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 2, committed: 1, acked: 2, skipped: 0, errors: 1 });
  assert.equal(
    JSON.parse(showState(fixture, "results/sweep-status/openclaw-openclaw.json")).detail,
    "continued",
  );
  assert.deepEqual(disposition, {
    drain_token: "normalize-alias",
    failures: [
      {
        seq: 1,
        reason:
          "Invalid record tuple openclaw-openclaw/49: ambiguous items filenames 49.md, openclaw-openclaw-49.md",
        retryable: false,
      },
    ],
  });
  assert.equal(
    statePathExists(fixture, "records/openclaw-openclaw/items/openclaw-openclaw-49.md"),
    true,
  );
  assert.equal(statePathExists(fixture, "records/openclaw-openclaw/items/49.md"), false);
});

test("materializer does not ack a drain when the state push fails", async () => {
  const fixture = createStateFixture();
  run(
    "git",
    ["remote", "set-url", "origin", path.join(fixture.root, "unreachable-state.git")],
    fixture.state,
  );
  let ackCalls = 0;
  let drainCalls = 0;
  const records = [
    record(1, "sweep_status", "openclaw-openclaw", sweepStatus("blocked", "12:00:01.000")),
  ];
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      assert.equal(drainCalls, 1);
      return Response.json({ ok: true, drain_token: "drain-failed", records });
    }
    ackCalls += 1;
    return Response.json({ ok: true, acked: records.length });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({
      env: materializerEnv({
        CLAWSWEEPER_STATE_MATERIALIZER_PUBLISH_MAX_ATTEMPTS: "1",
        CLAWSWEEPER_STATE_MATERIALIZER_PUSH_ATTEMPTS: "1",
      }),
      fetchImpl,
    }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 0, acked: 0, skipped: 0, errors: 1 });
  assert.equal(ackCalls, 0);
  assert.equal(
    JSON.parse(showState(fixture, "results/sweep-status/openclaw-openclaw.json")).detail,
    "initial",
  );
});

test("materializer deferral failure distinguishes progress from a stalled cycle", () => {
  const progress = stateMaterializerDeferralMessage(
    { drained: 1_400, committed: 720, acked: 720, skipped: 0, errors: 1 },
    "Model-guided Git recovery deferred to the next run: merge_shallow_history",
  );
  const stalled = stateMaterializerDeferralMessage(
    { drained: 1_400, committed: 0, acked: 0, skipped: 0, errors: 1 },
    "Model-guided Git recovery deferred to the next run: merge_shallow_history",
  );

  assert.match(progress, /progress with deferral: drained=1400 committed=720/);
  assert.match(stalled, /stalled cycle with deferral: drained=1400 committed=0/);
});

test("materializer persists the first shallow-history exhaustion as a retryable disposition", async () => {
  const fixture = createStateFixture();
  const records = [
    record(
      1,
      "record_tuple",
      "openclaw-openclaw/50",
      canonicalTuplePayload(50, "first shallow exhaustion", "2026-07-20T12:20:00.000Z"),
    ),
  ];
  let disposition: Record<string, unknown> | null = null;
  const fetchImpl = signedQueueFetch(async (url, body) => {
    if (url.pathname === "/internal/state/drain") {
      return Response.json({ ok: true, drain_token: "shallow-first", records });
    }
    assert.equal(url.pathname, "/internal/state/dispose");
    disposition = body;
    return Response.json({ ok: true, acked: 0, retried: 1, dead_lettered: 0 });
  });

  await assert.rejects(
    withMaterializerFixture(fixture, () =>
      runStateMaterializer({
        env: materializerEnv(),
        fetchImpl,
        publishCommit: (options) => {
          assert.equal(options.shallowHistoryExhaustionStrategy, "defer");
          throw new GitShallowHistoryExhaustionError(1_024);
        },
      }),
    ),
    /state-materializer stalled cycle with deferral.*deepening by 1024 commits/,
  );
  assert.deepEqual(disposition, {
    drain_token: "shallow-first",
    failures: [
      {
        seq: 1,
        reason: SHALLOW_MERGE_BASE_EXHAUSTION_DISPOSITION,
        retryable: true,
      },
    ],
  });
});

test("materializer escalates a repeated shallow-history phase to remote-head rebuild", async () => {
  const fixture = createStateFixture();
  const retriedRecord = record(
    1,
    "record_tuple",
    "openclaw-openclaw/51",
    canonicalTuplePayload(51, "persistent shallow exhaustion", "2026-07-20T12:21:00.000Z"),
  );
  retriedRecord.materialization_attempts = 1;
  retriedRecord.materialization_last_error = SHALLOW_MERGE_BASE_EXHAUSTION_DISPOSITION;
  let drainCalls = 0;
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "shallow-retry", records: [retriedRecord] })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    assert.equal(url.pathname, "/internal/state/ack");
    return Response.json({ ok: true, acked: 1 });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({
      env: materializerEnv(),
      fetchImpl,
      publishCommit: (options) => {
        assert.equal(options.shallowHistoryExhaustionStrategy, "rebuild-on-remote-head");
        return "committed";
      },
    }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 1, acked: 1, skipped: 0, errors: 0 });
});

test("materializer no-ops when the drain is empty", async () => {
  let calls = 0;
  const fetchImpl = signedQueueFetch(async (url) => {
    calls += 1;
    assert.equal(url.pathname, "/internal/state/drain");
    return Response.json({ ok: true, drain_token: null, records: [] });
  });

  const summary = await runStateMaterializer({ env: materializerEnv(), fetchImpl });

  assert.deepEqual(summary, { drained: 0, committed: 0, acked: 0, skipped: 0, errors: 0 });
  assert.equal(calls, 1);
});

test("materializer stops before another drain when its runtime budget is exhausted", async () => {
  const fixture = createStateFixture();
  const records = [
    record(1, "sweep_status", "openclaw-openclaw", sweepStatus("budget", "12:00:01.000")),
  ];
  let drainCalls = 0;
  let ackCalls = 0;
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return Response.json({ ok: true, drain_token: "drain-budget", records });
    }
    ackCalls += 1;
    return Response.json({ ok: true, acked: 1 });
  });
  const instants = [0, 0, 1_001];
  const now = () => new Date(instants.shift() ?? 1_001);

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({
      env: materializerEnv({ CLAWSWEEPER_STATE_MATERIALIZER_MAX_RUNTIME_MS: "1000" }),
      fetchImpl,
      now,
    }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 1, acked: 1, skipped: 0, errors: 0 });
  assert.equal(drainCalls, 1);
  assert.equal(ackCalls, 1);
});

function record(
  seq: number,
  kind: StateAppendRecord["kind"],
  key: string,
  payload: unknown,
): StateAppendRecord {
  return {
    seq,
    kind,
    key,
    payload,
    produced_at: producedAt,
    delivery_id: `delivery-${seq}`,
  };
}

type TupleTestOperation = {
  path: string;
  repoSlug: string;
  section: "items" | "closed" | "plans" | "decision-packets";
  itemId: number;
  digest: string | null;
  revision: number;
  bytes: number;
  deleted: boolean;
  content?: string;
  oversize?: boolean;
};

type TupleTestPayload = {
  itemKey: string;
  revision: number;
  claimGeneration: number;
  operations: TupleTestOperation[];
};

function canonicalTuplePayload(
  number: number,
  marker: string,
  timestamp: string,
  options: { section?: "items" | "closed"; revision?: number; includePlan?: boolean } = {},
): TupleTestPayload {
  const section = options.section ?? "items";
  const revision = options.revision ?? 1;
  const includePlan = options.includePlan ?? section === "items";
  const packet = `${JSON.stringify(
    {
      version: 1,
      generatedAt: timestamp,
      updatedAt: timestamp,
      subject: { repo: "openclaw/openclaw", number },
      source: {
        reportPath: `records/openclaw-openclaw/${section}/${number}.md`,
        reviewedAt: timestamp,
      },
      marker,
    },
    null,
    2,
  )}\n`;
  const packetDigest = createHash("sha256").update(packet).digest("hex");
  const primary = [
    "---",
    `decision_packet_sha256: ${packetDigest}`,
    `decision_packet_path: records/openclaw-openclaw/decision-packets/${number}.json`,
    `number: ${number}`,
    "repository: openclaw/openclaw",
    `item_updated_at: ${timestamp}`,
    `reviewed_at: ${timestamp}`,
    "---",
    "",
    `# ${marker}`,
    "",
  ].join("\n");
  const plan = [
    "---",
    `number: ${number}`,
    "repository: openclaw/openclaw",
    `reviewed_at: ${timestamp}`,
    "---",
    "",
    `# Plan ${marker}`,
    "",
  ].join("\n");
  const values = [
    { section, extension: "md", content: primary },
    ...(includePlan ? [{ section: "plans" as const, extension: "md", content: plan }] : []),
    { section: "decision-packets" as const, extension: "json", content: packet },
  ];
  return {
    itemKey: `openclaw/openclaw#${number}`,
    revision,
    claimGeneration: 1,
    operations: values.map(({ section, extension, content }) => ({
      path: `records/openclaw-openclaw/${section}/${number}.${extension}`,
      repoSlug: "openclaw-openclaw",
      section,
      itemId: number,
      digest: createHash("sha256").update(content).digest("hex"),
      revision,
      bytes: Buffer.byteLength(content),
      deleted: false,
      content,
      oversize: false,
    })),
  };
}

function clearDecisionPacketReference(tuple: TupleTestPayload): TupleTestPayload {
  const primary = tuple.operations.find(
    (operation) => operation.section === "items" || operation.section === "closed",
  );
  if (!primary?.content) throw new Error("tuple primary is missing");
  primary.content = primary.content
    .replace(/^decision_packet_sha256: .*$/m, "decision_packet_sha256: none")
    .replace(/^decision_packet_path: .*$/m, "decision_packet_path: none");
  primary.digest = createHash("sha256").update(primary.content).digest("hex");
  primary.bytes = Buffer.byteLength(primary.content);
  return tuple;
}

function writeTupleFiles(root: string, tuple: TupleTestPayload): void {
  for (const operation of tuple.operations) {
    if (operation.content === undefined)
      throw new Error(`missing tuple content: ${operation.path}`);
    const target = path.join(root, operation.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, operation.content);
  }
}

function sweepStatus(detail: string, time: string): Record<string, unknown> {
  return {
    schema_version: 1,
    slug: "openclaw-openclaw",
    display_name: "OpenClaw",
    target_repo: "openclaw/openclaw",
    state: "running",
    detail,
    updated_at: `2026-07-20T${time}Z`,
  };
}

function routerLedger(key: string, time: string): Record<string, unknown> {
  const timestamp = `2026-07-20T${time}Z`;
  return {
    updated_at: timestamp,
    commands: [
      {
        comment_version_key: key,
        comment_id: key,
        comment_updated_at: timestamp,
        status: "executed",
        processed_at: timestamp,
      },
    ],
  };
}

function signedQueueFetch(
  handler: (url: URL, body: Record<string, unknown>) => Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const bodyText = String(init?.body ?? "");
    const expected = `sha256=${createHmac("sha256", webhookSecret).update(bodyText).digest("hex")}`;
    assert.equal(init?.method === "POST" || init?.method === "GET", true);
    assert.equal(new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"), expected);
    return handler(url, bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {});
  }) as typeof fetch;
}

function materializerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    QUEUE_URL: "https://queue.test/",
    CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret,
    CLAWSWEEPER_PUBLISH_BRANCH: "state",
    ...overrides,
  };
}

function createStateFixture(): {
  root: string;
  origin: string;
  source: string;
  state: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-state-materializer-"));
  const origin = path.join(root, "origin.git");
  const source = path.join(root, "source");
  const state = path.join(root, "state");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  writeJson(
    path.join(state, "results/sweep-status/openclaw-openclaw.json"),
    sweepStatus("initial", "11:59:00.000"),
  );
  writeJson(path.join(state, "results/comment-router.json"), {
    updated_at: "2026-07-20T11:59:00.000Z",
    commands: [
      {
        comment_version_key: "base",
        comment_id: "base",
        comment_updated_at: "2026-07-20T11:59:00.000Z",
        status: "executed",
        processed_at: "2026-07-20T11:59:00.000Z",
      },
    ],
  });
  writeJson(path.join(state, "results/comment-router-latest.json"), {
    generated_at: "2026-07-20T11:59:00.000Z",
    commands_seen: 1,
  });
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);
  fs.cpSync(path.join(state, "results"), path.join(source, "results"), { recursive: true });
  return { root, origin, source, state };
}

async function withMaterializerFixture<T>(
  fixture: ReturnType<typeof createStateFixture>,
  operation: () => Promise<T>,
): Promise<T> {
  const previousCwd = process.cwd();
  const previousStateDir = process.env.CLAWSWEEPER_STATE_DIR;
  const previousPriority = process.env.CLAWSWEEPER_STATE_LEASE_PRIORITY;
  process.chdir(fixture.source);
  process.env.CLAWSWEEPER_STATE_DIR = fixture.state;
  process.env.CLAWSWEEPER_STATE_LEASE_PRIORITY = "1";
  try {
    return await operation();
  } finally {
    process.chdir(previousCwd);
    if (previousStateDir === undefined) delete process.env.CLAWSWEEPER_STATE_DIR;
    else process.env.CLAWSWEEPER_STATE_DIR = previousStateDir;
    if (previousPriority === undefined) delete process.env.CLAWSWEEPER_STATE_LEASE_PRIORITY;
    else process.env.CLAWSWEEPER_STATE_LEASE_PRIORITY = previousPriority;
  }
}

function showState(fixture: ReturnType<typeof createStateFixture>, file: string): string {
  return run("git", ["--git-dir", fixture.origin, "show", `state:${file}`], fixture.root);
}

function statePathExists(fixture: ReturnType<typeof createStateFixture>, file: string): boolean {
  try {
    run("git", ["--git-dir", fixture.origin, "cat-file", "-e", `state:${file}`], fixture.root);
    return true;
  } catch {
    return false;
  }
}

function configureUser(cwd: string): void {
  run("git", ["config", "user.name", "Tester"], cwd);
  run("git", ["config", "user.email", "tester@example.com"], cwd);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
