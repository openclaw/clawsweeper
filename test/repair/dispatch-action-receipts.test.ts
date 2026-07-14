import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ACTION_EVENT_TYPES } from "../../dist/action-ledger.js";
import {
  parseDispatchActionLedgerManifest,
  serializeDispatchActionLedgerManifest,
} from "../../dist/repair/dispatch-action-ledger-manifest.js";
import {
  DispatchOutcomeUnknownError,
  DispatchRejectedError,
  dispatchChainActiveAttemptsForTest,
  dispatchChainCacheSizeForTest,
  dispatchErrorDisposition,
  dispatchHttpError,
  dispatchInputSha256,
  dispatchProcessOutcome,
  flushDispatchActionEvents,
  prepareDispatchActionReceiptContext,
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

test("accepted outcome persistence failures preserve sync and async transport results", async (t) => {
  const fixture = actionLedgerFixture("accepted-outcome-failure");
  const errors: string[] = [];
  failAcceptedOutcomeWrites(t, 2);
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    const syncResult = runDispatchWithReceiptSync({
      ...baseOptions(fixture),
      operationKey: "dispatch:accepted-sync",
      dispatchInput: { event_type: "accepted_sync" },
      operation: () => "sync-result",
    });
    const asyncResult = await runDispatchWithReceipt({
      ...baseOptions(fixture),
      operationKey: "dispatch:accepted-async",
      dispatchInput: { event_type: "accepted_async" },
      operation: async () => "async-result",
    });

    assert.equal(syncResult, "sync-result");
    assert.equal(asyncResult, "async-result");
    assert.equal(dispatchChainActiveAttemptsForTest(), 0);
    assert.equal(
      errors.filter((line) =>
        line.includes("[action-ledger] dispatch accepted but failed to record outcome"),
      ).length,
      2,
    );

    await flushDispatchActionEvents(fixture.root, {
      env: fixture.env,
      outputRoot: fixture.outputRoot,
    });
    assert.deepEqual(
      readEvents(fixture.outputRoot).map((event) => event.attributes.completion_reason),
      ["dispatch_attempted", "dispatch_attempted"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("dispatch attempt persistence remains fail closed before sync or async transport", async (t) => {
  const fixture = actionLedgerFixture("attempt-failure");
  const originalWriteFileSync = fs.writeFileSync;
  let failuresRemaining = 2;
  let calls = 0;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (
      failuresRemaining > 0 &&
      String(args[1]).includes('"completion_reason":"dispatch_attempted"')
    ) {
      failuresRemaining -= 1;
      throw new Error("injected dispatch attempt persistence failure");
    }
    Reflect.apply(originalWriteFileSync, fs, args);
  });
  try {
    assert.throws(
      () =>
        runDispatchWithReceiptSync({
          ...baseOptions(fixture),
          operationKey: "dispatch:attempt-sync",
          dispatchInput: { event_type: "attempt_sync" },
          operation: () => {
            calls += 1;
          },
        }),
      /injected dispatch attempt persistence failure/,
    );
    await assert.rejects(
      runDispatchWithReceipt({
        ...baseOptions(fixture),
        operationKey: "dispatch:attempt-async",
        dispatchInput: { event_type: "attempt_async" },
        operation: async () => {
          calls += 1;
        },
      }),
      /injected dispatch attempt persistence failure/,
    );
    assert.equal(calls, 0);
    assert.equal(failuresRemaining, 0);
    assert.equal(dispatchChainActiveAttemptsForTest(), 0);
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
  for (const key of ["api_key", "access_token", "client_secret", "password"]) {
    assert.throws(
      () => dispatchInputSha256({ [key]: "credential" }),
      /identity contains a high-risk credential field/,
    );
  }
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

test("dispatches fail before the request when receipts are not configured", () => {
  let calls = 0;
  assert.throws(
    () =>
      runDispatchWithReceiptSync({
        component: "missing_receipts",
        operationKey: "missing-receipts",
        dispatchKind: "repository",
        repository: "openclaw/clawsweeper",
        dispatchTarget: "test_dispatch",
        dispatchInput: { event_type: "test_dispatch" },
        env: {},
        operation: () => {
          calls += 1;
        },
      }),
    /without authoritative action receipts/,
  );
  assert.equal(calls, 0);
  assert.throws(
    () =>
      runDispatchWithReceiptSync({
        component: "incomplete_receipts",
        operationKey: "incomplete-receipts",
        dispatchKind: "repository",
        repository: "openclaw/clawsweeper",
        dispatchTarget: "test_dispatch",
        dispatchInput: { event_type: "test_dispatch" },
        env: { CLAWSWEEPER_ACTION_LEDGER_FORCE: "1" },
        operation: () => {
          calls += 1;
        },
      }),
    /without an authoritative action receipt output root/,
  );
  assert.equal(calls, 0);
});

test("documented local dispatches receive a persistent authoritative producer context", async () => {
  const localRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-receipts-")));
  try {
    const context = prepareDispatchActionReceiptContext({
      component: "local_dispatch_test",
      env: {
        CLAWSWEEPER_ACTION_LEDGER_LOCAL_ROOT: localRoot,
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        GITHUB_SHA: "b".repeat(40),
      },
    });
    runDispatchWithReceiptSync({
      root: context.root,
      env: context.env,
      component: "local_dispatch_test",
      operationKey: "local-dispatch",
      dispatchKind: "repository",
      repository: "openclaw/clawsweeper",
      dispatchTarget: "local_dispatch",
      dispatchInput: { event_type: "local_dispatch" },
      operation: () => undefined,
    });
    await flushDispatchActionEvents(context.root, {
      env: context.env,
      outputRoot: context.outputRoot,
    });

    const events = readEvents(context.outputRoot);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.producer.workflow, "local-dispatch");
    assert.equal(events[0]?.producer.job, "local_dispatch_test");
    assert.match(events[0]?.producer.run_id, /^local-\d+-\d+$/);
    assert.ok(context.root.startsWith(localRoot));
    assert.ok(context.outputRoot.startsWith(localRoot));
  } finally {
    fs.rmSync(localRoot, { recursive: true, force: true });
  }
});

test("dispatch receipt chains remain bounded in long-lived processes", () => {
  const fixture = actionLedgerFixture("bounded-cache");
  try {
    for (let index = 0; index < 80; index += 1) {
      runDispatchWithReceiptSync({
        ...baseOptions(fixture),
        operationKey: `dispatch:bounded-cache:${index}`,
        dispatchInput: { event_type: `bounded_cache_${index}` },
        operation: () => undefined,
      });
    }
    assert.ok(dispatchChainCacheSizeForTest() <= 64);
  } finally {
    fixture.cleanup();
  }
});

test("concurrent receipt attempts keep distinct causal phase sequences", async () => {
  const fixture = actionLedgerFixture("concurrent-attempts");
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  try {
    const options = {
      ...baseOptions(fixture),
      operationKey: "dispatch:concurrent",
      dispatchInput: { event_type: "concurrent" },
    };
    const first = runDispatchWithReceipt({
      ...options,
      operation: async () => firstGate,
    });
    const second = runDispatchWithReceipt({
      ...options,
      operation: async () => secondGate,
    });
    releaseFirst?.();
    await first;
    releaseSecond?.();
    await second;

    await flushDispatchActionEvents(fixture.root, {
      env: fixture.env,
      outputRoot: fixture.outputRoot,
    });
    const events = readEvents(fixture.outputRoot);
    const eventsByPhase = [...events].sort(
      (left, right) => Number(left.phase_seq) - Number(right.phase_seq),
    );
    assert.deepEqual(
      eventsByPhase.map((event) => event.phase_seq),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      eventsByPhase.map((event) => event.attributes.attempt),
      [1, 1, 2, 2],
    );
  } finally {
    fixture.cleanup();
  }
});

test("error classifiers that throw remain an unknown dispatch outcome", () => {
  assert.deepEqual(
    dispatchErrorDisposition(new Error("request failed"), () => {
      throw new Error("classifier failed");
    }),
    {
      outcome: "unknown",
      statusKind: "unknown",
    },
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

test("dispatch action ledger CLI finalizes and publishes dispatch lifecycle shards", () => {
  const fixture = actionLedgerFixture("dispatch-manifest");
  const stateRoot = path.join(fixture.root, "state");
  const manifestPath = path.join(fixture.root, "dispatch-manifest.json");
  fs.mkdirSync(stateRoot);
  try {
    runDispatchWithReceiptSync({
      ...baseOptions(fixture),
      operationKey: "dispatch:manifest",
      dispatchInput: { event_type: "manifest_test" },
      operation: () => undefined,
    });

    const finalize = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/dispatch-action-ledger-cli.js"),
        "finalize",
        "--lane",
        "dispatch-test",
      ],
      { encoding: "utf8", env: fixture.env },
    );
    assert.equal(finalize.status, 0, finalize.stderr);
    const manifest = parseDispatchActionLedgerManifest(
      finalize.stdout,
      "dispatch-test",
      fixture.env,
    );
    assert.ok(manifest.event_paths.length > 0);
    fs.writeFileSync(manifestPath, serializeDispatchActionLedgerManifest(manifest));

    const publish = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/dispatch-action-ledger-cli.js"),
        "publish",
        "--lane",
        "dispatch-test",
        "--manifest",
        manifestPath,
        "--source-root",
        fixture.outputRoot,
        "--state-root",
        stateRoot,
      ],
      { encoding: "utf8", env: fixture.env },
    );
    assert.equal(publish.status, 0, publish.stderr);
    assert.deepEqual(JSON.parse(publish.stdout).eventPaths, manifest.event_paths);
    assert.deepEqual(
      readEvents(stateRoot).map((event) => event.event_type),
      [ACTION_EVENT_TYPES.dispatchLifecycle, ACTION_EVENT_TYPES.dispatchLifecycle],
    );
  } finally {
    fixture.cleanup();
  }
});

test("every workflow-backed dispatch producer publishes finalized receipt shards", () => {
  const workflows = [
    [".github/workflows/sweep.yml", "target-fanout-dispatch"],
    [".github/workflows/repair-self-heal.yml", "self-heal-dispatch"],
    [".github/workflows/github-activity.yml", "github-activity-dispatch"],
    [".github/workflows/spam-comment-intake.yml", "spam-intake-dispatch"],
  ] as const;
  for (const [workflowPath, lane] of workflows) {
    const workflow = fs.readFileSync(workflowPath, "utf8");
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
    assert.match(workflow, new RegExp(`--lane ${lane}`));
    assert.match(workflow, /dist\/repair\/dispatch-action-ledger-cli\.js finalize/);
    assert.match(workflow, /dist\/repair\/dispatch-action-ledger-cli\.js publish/);
    assert.match(workflow, /repair:publish-main/);
  }
});

test("activity intake receipt publishers keep checkout credentials ephemeral", () => {
  for (const workflowPath of [
    ".github/workflows/github-activity.yml",
    ".github/workflows/spam-comment-intake.yml",
  ]) {
    const workflow = fs.readFileSync(workflowPath, "utf8");
    assert.match(
      workflow,
      /uses: actions\/checkout@v7[\s\S]{0,400}?fetch-depth: 0[\s\S]{0,400}?persist-credentials: false/,
    );
    assert.doesNotMatch(
      workflow,
      /uses: actions\/checkout@v7[\s\S]{0,300}?token: \$\{\{ steps\.app_token\.outputs\.token \}\}/,
    );
    assert.match(workflow, /auth_header="\$\(printf 'x-access-token:%s'/);
    assert.match(workflow, /export GIT_CONFIG_COUNT=1/);
    assert.match(workflow, /export GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader/);
    assert.match(workflow, /export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic \$auth_header"/);
  }
  const spamWorkflow = fs.readFileSync(".github/workflows/spam-comment-intake.yml", "utf8");
  assert.match(spamWorkflow, /id: app_token[\s\S]*?repositories: clawsweeper/);
  assert.match(spamWorkflow, /id: app_token[\s\S]*?permission-contents: write/);
  const activityWorkflow = fs.readFileSync(".github/workflows/github-activity.yml", "utf8");
  assert.doesNotMatch(activityWorkflow, /id: app_token/);
  assert.match(
    activityWorkflow,
    /PUBLISH_TOKEN: \$\{\{ steps\.activity-state-token\.outputs\.token \}\}/,
  );
  assert.match(spamWorkflow, /PUBLISH_TOKEN: \$\{\{ steps\.state-token\.outputs\.token \}\}/);
});

test("activity feed runs independently of durable ledger publication and reports failures", () => {
  const workflow = fs.readFileSync(".github/workflows/github-activity.yml", "utf8");
  assert.match(workflow, /id: finalize-activity-dispatch-ledger[\s\S]*?continue-on-error: true/);
  assert.match(workflow, /id: publish-activity-dispatch-ledger[\s\S]*?continue-on-error: true/);
  assert.match(
    workflow,
    /- name: Feed activity to OpenClaw\n\s+if: \$\{\{ always\(\)[^\n]+dispatch-spam-scan-candidate\.outcome == 'success'/,
  );
  assert.match(
    workflow,
    /- name: Report GitHub activity dispatch ledger failure[\s\S]*?finalize-activity-dispatch-ledger\.outcome == 'failure'[\s\S]*?publish-activity-dispatch-ledger\.outcome == 'failure'/,
  );
});

test("fanout cursor publication survives dispatch ledger finalization failures", () => {
  const workflow = fs.readFileSync(".github/workflows/sweep.yml", "utf8");
  assert.match(
    workflow,
    /- name: Publish fanout cursor\n\s+if: \$\{\{ always\(\) && steps\.setup-target-fanout-state\.outcome == 'success' && steps\.setup-target-fanout-pnpm\.outcome == 'success' \}\}/,
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

function failAcceptedOutcomeWrites(t: TestContext, failures: number): void {
  const originalWriteFileSync = fs.writeFileSync;
  let failuresRemaining = failures;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (
      failuresRemaining > 0 &&
      String(args[1]).includes('"completion_reason":"dispatch_accepted"')
    ) {
      failuresRemaining -= 1;
      throw new Error("injected accepted outcome persistence failure");
    }
    Reflect.apply(originalWriteFileSync, fs, args);
  });
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
