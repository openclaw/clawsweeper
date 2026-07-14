import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DispatchOutcomeUnknownError,
  DispatchRejectedError,
  dispatchHttpError,
  dispatchInputSha256,
  dispatchProcessOutcome,
  flushDispatchActionEvents,
  runDispatchWithReceipt,
  runDispatchWithReceiptSync,
  unknownDispatch,
} from "../../dist/repair/dispatch-action-receipts.js";

test("dispatch receipts bind attempt and outcome to the exact bounded input digest", async () => {
  const fixture = actionLedgerFixture("accepted");
  let calls = 0;
  try {
    const dispatchInput = {
      event_type: "clawsweeper_target_sweep",
      target_repo: "openclaw/openclaw",
      target_branch: "main",
      batch_size: 1,
    };
    const result = runDispatchWithReceiptSync({
      root: fixture.root,
      env: fixture.env,
      component: "target_fanout",
      operationKey: "target-fanout:openclaw/openclaw",
      dispatchKind: "repository",
      repository: "openclaw/clawsweeper",
      dispatchTarget: "clawsweeper_target_sweep",
      dispatchInput,
      operation: () => {
        calls += 1;
        return "ok";
      },
    });
    assert.equal(result, "ok");
    assert.equal(calls, 1);

    await flushDispatchActionEvents(fixture.root, {
      env: fixture.env,
      outputRoot: fixture.outputRoot,
    });
    const events = readEvents(fixture.outputRoot);
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => [
        event.action.status,
        event.action.mutation,
        event.attributes.completion_reason,
      ]),
      [
        ["started", false, "dispatch_attempted"],
        ["dispatched", true, "dispatch_accepted"],
      ],
    );
    assert.equal(events[1]?.parent_event_id, events[0]?.event_id);
    assert.equal(events[0]?.operation_id, events[1]?.operation_id);
    assert.equal(events[0]?.attempt_id, events[1]?.attempt_id);
    assert.equal(events[0]?.idempotency_key_sha256, events[1]?.idempotency_key_sha256);
    assert.equal(events[0]?.evidence[0]?.sha256, dispatchInputSha256(dispatchInput));
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /openclaw\/openclaw/);
    assert.doesNotMatch(serialized, /target_branch/);
    assert.doesNotMatch(serialized, /credential-value/);
  } finally {
    fixture.cleanup();
  }
});

test("dispatch receipts classify rejected, timed out, and returned unknown outcomes", async () => {
  const fixture = actionLedgerFixture("failure-classes");
  try {
    assert.throws(
      () =>
        runDispatchWithReceiptSync({
          ...baseOptions(fixture),
          operationKey: "dispatch:rejected",
          dispatchInput: { event_type: "rejected" },
          operation: () => {
            throw new DispatchRejectedError("request rejected", { status: 422 });
          },
        }),
      /request rejected/,
    );
    await assert.rejects(
      runDispatchWithReceipt({
        ...baseOptions(fixture),
        operationKey: "dispatch:timeout",
        dispatchInput: { event_type: "timeout" },
        operation: async () => {
          throw new DispatchOutcomeUnknownError("request timed out", { timeout: true });
        },
      }),
      /timed out/,
    );
    runDispatchWithReceiptSync({
      ...baseOptions(fixture),
      operationKey: "dispatch:unknown",
      dispatchInput: { event_type: "unknown" },
      operation: () => ({ status: 1 }),
      outcome: () => unknownDispatch("error"),
    });

    await flushDispatchActionEvents(fixture.root, {
      env: fixture.env,
      outputRoot: fixture.outputRoot,
    });
    const outcomes = readEvents(fixture.outputRoot).filter(
      (event) => event.attributes.completion_reason !== "dispatch_attempted",
    );
    const dispositions = outcomes
      .map((event) => [
        event.action.status,
        event.action.reason_code,
        event.action.mutation,
        event.action.retryable,
        event.attributes.status_kind,
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const expected = [
      ["failed", "timeout", true, false, "timeout"],
      ["failed", "unavailable", true, false, "error"],
      ["skipped", "not_applicable", false, false, "error"],
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.deepEqual(dispositions, expected);
  } finally {
    fixture.cleanup();
  }
});

test("dispatch receipt inputs reject raw payload, body, token, nested, and oversized data", () => {
  assert.throws(
    () => dispatchInputSha256({ payload: "raw" }),
    /field is not receipt-safe: payload/,
  );
  assert.throws(() => dispatchInputSha256({ body: "secret" }), /field is not receipt-safe: body/);
  assert.throws(
    () => dispatchInputSha256({ token: "credential" }),
    /field is not receipt-safe: token/,
  );
  assert.throws(
    () =>
      dispatchInputSha256({
        nested: { target_repo: "openclaw/openclaw" },
      } as never),
    /must be scalar/,
  );
  assert.throws(
    () => dispatchInputSha256({ target_repo: "x".repeat(513) }),
    /exceeds its byte limit/,
  );
});

test("HTTP dispatch failures separate known rejection from ambiguous acceptance", () => {
  assert.ok(dispatchHttpError(403, "forbidden") instanceof DispatchRejectedError);
  assert.ok(dispatchHttpError(422, "invalid") instanceof DispatchRejectedError);
  assert.ok(dispatchHttpError(429, "rate limited") instanceof DispatchOutcomeUnknownError);
  assert.ok(dispatchHttpError(503, "unavailable") instanceof DispatchOutcomeUnknownError);
});

test("process dispatch outcomes treat every non-success exit as ambiguous", () => {
  assert.deepEqual(dispatchProcessOutcome({ status: 0 }), {
    outcome: "accepted",
    statusKind: "accepted",
  });
  assert.deepEqual(dispatchProcessOutcome({ status: 1 }), {
    outcome: "unknown",
    statusKind: "error",
  });
  assert.deepEqual(
    dispatchProcessOutcome({
      status: null,
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    }),
    {
      outcome: "unknown",
      statusKind: "timeout",
    },
  );
});

function baseOptions(fixture: ReturnType<typeof actionLedgerFixture>) {
  return {
    root: fixture.root,
    env: fixture.env,
    component: "dispatch_test",
    dispatchKind: "repository" as const,
    repository: "openclaw/clawsweeper",
    dispatchTarget: "test_dispatch",
  };
}

function actionLedgerFixture(invocation: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-receipts-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const env = {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: invocation,
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "dispatch receipt test",
    GITHUB_WORKFLOW_REF: "openclaw/clawsweeper/.github/workflows/dispatch-test.yml@refs/heads/main",
    GITHUB_JOB: "dispatch",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_STARTED_AT: "2026-07-14T12:00:00Z",
    GITHUB_ACTION: "dispatch",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
  };
  return {
    root,
    outputRoot,
    env,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function readEvents(root: string): Array<Record<string, any>> {
  const paths = fs
    .readdirSync(root, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".jsonl"));
  return paths
    .flatMap((entry) => fs.readFileSync(path.join(root, entry), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
