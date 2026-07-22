import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readAllSpooledActionEvents } from "../../dist/action-ledger.js";
import {
  buildRecoveryFailureContext,
  executeRecoveryActions,
  parseRecoveryPlan,
  publicDiagnosisSummary,
  recordRecoveryOutcome,
  redactRecoverySecrets,
  requestRecoveryAdvice,
  type RecoveryActionHandlers,
} from "../../dist/repair/recovery-advisor.js";

const objectId = "a".repeat(40);

function context() {
  return buildRecoveryFailureContext({
    phase: "push_commit",
    gitError: `remote rejected object ${objectId} is unavailable`,
    shallow: true,
    remote: "origin",
    branch: "state",
    recentAttempts: ["push status=1"],
    availableActions: [
      "fetch_object",
      "refetch_depth1",
      "deepen",
      "unshallow",
      "rebuild_on_remote_head",
      "retry_push",
      "defer_to_next_run",
      "give_up",
    ],
  });
}

test("recovery advisor rejects unknown actions instead of partially accepting a plan", () => {
  assert.throws(
    () =>
      parseRecoveryPlan(
        JSON.stringify({
          diagnosis: "The shallow checkout is missing an object.",
          actions: [`fetch_object ${objectId}`, "run_shell git fetch --all"],
          confidence: 0.9,
        }),
        context(),
      ),
    /unknown recovery action/,
  );
  assert.throws(
    () =>
      parseRecoveryPlan(
        JSON.stringify({
          diagnosis: "The shallow checkout needs too much history.",
          actions: ["deepen 65"],
          confidence: 0.5,
        }),
        context(),
      ),
    /between 1 and 64/,
  );
  for (const action of ["fetch_object", "deepen"]) {
    assert.throws(
      () =>
        parseRecoveryPlan(
          JSON.stringify({
            diagnosis: "The parameterized action is incomplete.",
            actions: [action],
            confidence: 0.5,
          }),
          context(),
        ),
      /requires an argument/,
    );
  }
  assert.throws(
    () =>
      parseRecoveryPlan(
        JSON.stringify({
          diagnosis: "The plan contradicts its own shallow-state transition.",
          actions: ["unshallow", "deepen 1", "retry_push"],
          confidence: 0.5,
        }),
        context(),
      ),
    /unshallow must be the last history-changing recovery action/,
  );
});

test("terminal recovery actions map to explicit trust-boundary handlers", () => {
  const calls: string[] = [];
  const handlers: RecoveryActionHandlers = {
    rebuildOnRemoteHead: () => calls.push("rebuild"),
    resetToRemote: () => calls.push("reset"),
    retryPush: () => calls.push("retry"),
    deferToNextRun: () => calls.push("defer"),
    giveUp: () => calls.push("give_up"),
  };
  const cases = [
    ["rebuild_on_remote_head", "rebuild"],
    ["reset_to_remote", "reset"],
    ["retry_push", "retry"],
    ["defer_to_next_run", "defer"],
    ["give_up", "give_up"],
  ] as const;
  for (const [name, expectedCall] of cases) {
    calls.length = 0;
    const execution = executeRecoveryActions([{ name }], handlers);
    assert.deepEqual(calls, [expectedCall]);
    assert.equal(execution.directive, name);
  }
});

test("malformed model JSON is discarded for deterministic fallback", () => {
  let calls = 0;
  const advice = requestRecoveryAdvice(context(), {
    env: {
      CLAWSWEEPER_MODEL_RECOVERY_ENABLED: "1",
      OPENAI_API_KEY: "sk-test-placeholder-value",
    },
    modelRunner: () => {
      calls += 1;
      return "not json";
    },
  });

  assert.equal(calls, 1);
  assert.equal(advice, null);
});

test("disabled model recovery never invokes the model runner", () => {
  let calls = 0;
  const advice = requestRecoveryAdvice(context(), {
    env: { OPENAI_API_KEY: "sk-test-placeholder-value" },
    modelRunner: () => {
      calls += 1;
      return "{}";
    },
  });

  assert.equal(advice, null);
  assert.equal(calls, 0);
});

test("missing model credentials use deterministic fallback without invoking the model", () => {
  let calls = 0;
  const advice = requestRecoveryAdvice(context(), {
    env: { CLAWSWEEPER_MODEL_RECOVERY_ENABLED: "1" },
    modelRunner: () => {
      calls += 1;
      return "{}";
    },
  });

  assert.equal(advice, null);
  assert.equal(calls, 0);
});

test("allowlisted recovery actions map only to typed execution handlers", () => {
  const calls: string[] = [];
  const handlers: RecoveryActionHandlers = {
    fetchObject: (sha) => calls.push(`fetch:${sha}`),
    refetchDepth1: () => calls.push("refetch"),
    deepen: (depth) => calls.push(`deepen:${depth}`),
    unshallow: () => calls.push("unshallow"),
    retryPush: () => calls.push("retry"),
  };
  const plan = parseRecoveryPlan(
    JSON.stringify({
      diagnosis: "Hydrate the missing history and retry.",
      actions: [
        `fetch_object ${objectId}`,
        "refetch_depth1",
        "deepen 32",
        "unshallow",
        "retry_push",
      ],
      confidence: 0.8,
    }),
    context(),
  );

  const execution = executeRecoveryActions(plan.actions, handlers);

  assert.deepEqual(calls, [`fetch:${objectId}`, "refetch", "deepen:32", "unshallow", "retry"]);
  assert.equal(execution.directive, "retry_push");
  assert.deepEqual(execution.actions, [
    `fetch_object ${objectId}`,
    "refetch_depth1",
    "deepen 32",
    "unshallow",
    "retry_push",
  ]);
});

test("recovery context redacts credentials before hashing or model invocation", () => {
  const openAiKey = "sk-proj-super-secret-recovery-key";
  const githubToken = "ghp_supersecretrecoverytoken123456";
  const value = [
    `fatal: OPENAI_API_KEY=${openAiKey}`,
    `Authorization: Bearer ${githubToken}`,
    `https://x-access-token:${githubToken}@github.com/openclaw/clawsweeper-state.git`,
    "https://opaque-access-token@git.example/private.git?access_token=another-secret&depth=1",
    "(https://punctuation-token@git.example/private.git).",
    "https://account.blob.core.windows.net/container/blob?sv=1&sig=azure-secret",
    "https://proxy.test/?target=https%3A%2F%2Fapi.test%2F%3Faccess_token%3Dnested-secret",
    "https://safe.example,https://adjacent-token@git.example/private.git",
    "https://user:abc'def@git.example/repo.git",
  ].join("\n");
  const redacted = redactRecoverySecrets(value, {
    OPENAI_API_KEY: openAiKey,
    GITHUB_TOKEN: githubToken,
  });

  assert.doesNotMatch(redacted, /super-secret|supersecret/);
  assert.match(redacted, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /\[REDACTED_URL\]/);
  assert.doesNotMatch(
    redacted,
    /opaque-access-token|another-secret|access_token|punctuation-token|azure-secret|nested-secret|adjacent-token|abc'def/,
  );
  assert.doesNotMatch(redacted, /depth=1|sig=|sv=1/);
  assert.equal(
    redactRecoverySecrets("https://git.example?email=owner@example.org"),
    "[REDACTED_URL]",
  );
  assert.equal(
    redactRecoverySecrets("opaque-token@git.example:private/repo.git"),
    "[REDACTED_GIT_REMOTE]",
  );
  assert.equal(
    redactRecoverySecrets("opaque-token@git_internal:private/repo.git"),
    "[REDACTED_GIT_REMOTE]",
  );
  assert.equal(
    redactRecoverySecrets("opaque-token@[2001:db8::1]:private/repo.git"),
    "[REDACTED_GIT_REMOTE]",
  );

  const failureContext = buildRecoveryFailureContext({
    phase: "push_commit",
    gitError: value,
    shallow: false,
    remote: `https://x-access-token:${githubToken}@github.com/openclaw/state.git`,
    branch: "state",
    env: { OPENAI_API_KEY: openAiKey, GITHUB_TOKEN: githubToken },
  });
  assert.doesNotMatch(JSON.stringify(failureContext), /super-secret|supersecret/);
  assert.equal(
    publicDiagnosisSummary("Customer Acme path /private/repo has a shallow missing object"),
    "shallow_missing_object",
  );
});

test("validated recovery advice records its context hash, diagnosis, plan, and outcome", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-recovery-ledger-")),
  );
  const advice = requestRecoveryAdvice(context(), {
    env: {
      CLAWSWEEPER_MODEL_RECOVERY_ENABLED: "1",
      OPENAI_API_KEY: "sk-test-placeholder-value",
    },
    modelRunner: () =>
      JSON.stringify({
        diagnosis: "The shallow checkout needs one bounded deepen before retry.",
        actions: ["deepen 16", "retry_push"],
        confidence: 0.75,
      }),
  });
  assert.ok(advice);
  recordRecoveryOutcome(advice, "retry_push_selected", {
    root,
    env: {
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "recovery-0",
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-22",
      GITHUB_ACTION: "materialize",
      GITHUB_JOB: "materialize",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: "abc123",
      GITHUB_WORKFLOW: "State materializer",
    },
  });

  const events = readAllSpooledActionEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.subject.source_revision, advice.contextHash);
  assert.equal(events[0]?.learning?.signal, "shallow_deepen_retry");
  assert.equal(events[0]?.learning?.rule_id, "deepen_16+retry_push");
  assert.equal(events[0]?.attributes?.state, "retry_push_selected");
  assert.equal(events[0]?.action.status, "planned");
});
