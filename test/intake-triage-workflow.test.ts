import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  runIntakeWorkflow,
  type IntakeSnapshot,
  type IntakeWorkflowOptions,
} from "../dist/intake-triage-workflow.js";
import { getMutationReceiptRunner } from "../dist/clawsweeper-github-execution.js";
import { readAllSpooledActionEvents } from "../dist/action-ledger.js";
import {
  flushWorkflowActionEvents,
  interruptOpenWorkflowActionEvents,
  recordWorkflowActionEvent,
  startWorkflowMutationAttempt,
} from "../dist/action-ledger-runtime.js";
import { INTAKE_POLICY, intakeRequest } from "../dist/intake-triage-contract.js";
import { githubTest, installGhFixture } from "./github-runtime-fixture.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "intake-workflow-"));
  const values = {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-10-15",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "intake",
    GITHUB_ACTION: "intake",
    GITHUB_JOB: "exact",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_WORKFLOW_REF: "openclaw/clawsweeper/.github/workflows/sweep.yml@refs/heads/main",
    GITHUB_RUN_ID: "4242",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
    EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#42",
    EXACT_REVIEW_SOURCE_HEAD_SHA: "c".repeat(40),
    EXACT_REVIEW_LEASE_ID: "fixture",
    EXACT_REVIEW_LEASE_REVISION: "1",
    EXACT_REVIEW_CLAIM_GENERATION: "1",
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  let live: IntakeSnapshot = {
    repository: "openclaw/openclaw",
    number: 42,
    kind: "issue",
    title: "Crash",
    body: "Run the launch command",
    state: "open",
    locked: false,
    updatedAt: "2026-10-15T00:00:00Z",
    labels: ["human-label"],
    headSha: "",
  };
  const writes: string[] = [];
  const phases: string[] = [];
  let afterDefinition: (() => void) | undefined;
  let unknownWrite = false;
  const options: IntakeWorkflowOptions = {
    repository: live.repository,
    number: live.number,
    kind: live.kind,
    apiKey: "synthetic-key",
    backend: "responses",
    root,
    readSnapshot: () => structuredClone(live),
    fence: (phase) => {
      phases.push(phase);
      return true;
    },
    infer: async (options) => {
      await options.recordAttempt({ digest: options.request.digest, backend: "responses" });
      return {
        policy: INTAKE_POLICY,
        digest: options.request.digest,
        backend: "responses",
        outcome: "classified",
        answers: { category: "bug", reproduction: "present", environment: "present" },
        usage: { inputTokens: 100, outputTokens: 20 },
        durationMs: 1,
      };
    },
    gh: {
      readLabelCatalogPages: () => [[]],
      ghObservedMutationCommand: (mutation) => {
        const runner = getMutationReceiptRunner();
        assert.ok(runner, "every dispatch must have the canonical receipt runner");
        return runner({
          identity: mutation.identity,
          idempotencyIdentity: mutation.identity,
          operation: () => {
            writes.push(mutation.args.join(" "));
            if (mutation.args[0] === "label") afterDefinition?.();
            else {
              live.labels.push("clawsweeper:intake:bug");
              live.updatedAt = "2026-10-15T00:00:01Z";
              if (unknownWrite) throw Error("transport failed after dispatch");
            }
            return "";
          },
          ...(mutation.knownNoMutation ? { knownNoMutation: mutation.knownNoMutation } : {}),
        });
      },
    },
  };
  return {
    root,
    options,
    writes,
    phases,
    get live() {
      return live;
    },
    set live(value) {
      live = value;
    },
    afterDefinition: (callback: () => void) => {
      afterDefinition = callback;
    },
    unknownWrite: () => {
      unknownWrite = true;
    },
  };
}

for (const [name, apiKey, model] of [
  ["missing key", "", undefined],
  ["blank key", "  ", undefined],
  ["model off", "synthetic-key", "off"],
] as const) {
  test("disabled intake (" + name + ") has no model, GitHub or queue dependency", async () => {
    const outcomes: boolean[] = [];
    const result = await runIntakeWorkflow({
      repository: "openclaw/openclaw",
      number: 42,
      kind: "issue",
      backend: "responses",
      apiKey,
      model,
      admissionUnchanged: (value) => outcomes.push(value),
      readSnapshot: () => {
        throw Error("must not read");
      },
      infer: async () => {
        throw Error("must not infer");
      },
      fence: () => {
        throw Error("must not fence");
      },
    });
    assert.equal(result.outcome, "disabled");
    assert.deepEqual(outcomes, [true]);
  });
}

test("preliminary publication records intent and usage without completing a review", async (t) => {
  const f = fixture(t);
  const admission: boolean[] = [];
  const result = await runIntakeWorkflow({
    ...f.options,
    admissionUnchanged: (value) => admission.push(value),
  });
  assert.equal(result.outcome, "published");
  assert.deepEqual(admission, [false]);
  assert.deepEqual(f.live.labels, ["human-label", "clawsweeper:intake:bug"]);
  assert.equal(f.phases.at(-1), "review");
  const events = readAllSpooledActionEvents(f.root);
  assert.ok(events.length >= 6);
  assert.ok(events.every((event) => event.event_type === "workflow.attempt"));
  assert.ok(events.some((event) => event.attributes?.input_tokens === 100));
  assert.ok(events.some((event) => event.attributes?.completion_reason === "mutation_accepted"));
  assert.ok(!JSON.stringify(events).includes(f.live.body));
});

githubTest("intake reads REST catalog pages from its explicit target repository", async (t) => {
  const f = fixture(t);
  f.options.repository = "example/other";
  f.live = { ...f.live, repository: "example/other" };
  process.env.EXACT_REVIEW_ITEM_KEY = "example/other#42";
  const gh = installGhFixture(
    t,
    `
if (args[0] === "api") {
  require("node:assert/strict").deepEqual(args, ["api", "repos/example/other/labels?per_page=100", "--paginate", "--slurp"]);
  console.log("[[]]");
} else {
  require("node:assert/strict").deepEqual(args.slice(-2), ["--repo", "example/other"]);
}
`,
  );
  const result = await runIntakeWorkflow({ ...f.options, gh: undefined });
  assert.equal(result.outcome, "published");
  const requests = gh.requests();
  assert.equal(requests.filter(({ args }) => args[0] === "api").length, 1);
  assert.equal(requests.length, 3);
});

for (const backend of ["decisions", "responses"] as const) {
  for (const override of [undefined, "  ", "  fixture-decision-model  "]) {
    test(
      backend +
        " intake records and forwards its resolved model (" +
        (override === undefined ? "unset" : override.trim() || "blank") +
        ")",
      async (t) => {
        const f = fixture(t);
        const infer = f.options.infer!;
        const expected = override?.trim() || "gpt-6-luna";
        const result = await runIntakeWorkflow({
          ...f.options,
          backend,
          model: override,
          infer: async (options) => {
            assert.equal(options.model, expected);
            return { ...(await infer(options)), backend };
          },
        });
        assert.equal(result.outcome, "published");
        const intent = readAllSpooledActionEvents(f.root).find((event) => event.attributes?.model);
        assert.equal(intent?.attributes?.model, expected);
      },
    );
  }
}

for (const edit of ["body", "labels", "head", "locked"] as const) {
  test(`intake rejects ${edit} drift while inference is running`, async (t) => {
    const f = fixture(t);
    if (edit === "head") {
      f.live.kind = "pull_request";
      f.options.kind = "pull_request";
      f.live.headSha = "c".repeat(40);
    }
    const infer = f.options.infer!;
    f.options.infer = async (options) => {
      const result = await infer(options);
      if (edit === "body") f.live.body += " edited";
      else if (edit === "labels") f.live.labels = ["replacement-human-label"];
      else if (edit === "head") f.live.headSha = "d".repeat(40);
      else f.live.locked = true;
      return result;
    };
    await assert.rejects(runIntakeWorkflow(f.options), /source or queue ownership changed/);
    assert.deepEqual(f.writes, []);
  });
}

test("definition writes cannot hide a human edit before the item write", async (t) => {
  const f = fixture(t);
  f.afterDefinition(() => {
    f.live.body += " edited";
  });
  await assert.rejects(runIntakeWorkflow(f.options), /source or queue ownership changed/);
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0]!, /^label create/);
  assert.equal(f.phases.at(-1), "review");
});

test("newer queue ownership prevents publication after inference", async (t) => {
  const f = fixture(t);
  f.options.fence = (phase) => phase === "review";
  await assert.rejects(runIntakeWorkflow(f.options), /source or queue ownership changed/);
  assert.deepEqual(f.writes, []);
});

test("an uncertain item write still invalidates admission and records uncertainty", async (t) => {
  const f = fixture(t);
  f.unknownWrite();
  const admission: boolean[] = [];
  await assert.rejects(
    runIntakeWorkflow({ ...f.options, admissionUnchanged: (value) => admission.push(value) }),
    /transport failed/,
  );
  assert.deepEqual(admission, [false]);
  assert.ok(f.live.labels.includes("clawsweeper:intake:bug"));
  assert.ok(
    readAllSpooledActionEvents(f.root).some(
      (event) => event.attributes?.completion_reason === "mutation_outcome_unknown",
    ),
  );
});

test("a foreign result identity cannot remove or add preliminary labels", async (t) => {
  const f = fixture(t);
  const infer = f.options.infer!;
  f.options.infer = async (options) => ({
    ...(await infer(options)),
    digest: intakeRequest({ ...f.live, body: "different" }).digest,
  });
  await assert.rejects(runIntakeWorkflow(f.options), /source or queue ownership changed/);
  assert.deepEqual(f.writes, []);
});

for (const drift of ["source", "queue"] as const) {
  test(`paid inference is fenced again after scanning for ${drift} drift`, async (t) => {
    const f = fixture(t);
    let dispatched = false;
    const infer = f.options.infer!;
    f.options.infer = async (options) => {
      if (drift === "source") f.live.body += " edited during scan";
      // The production scanner finishes before it invokes this callback.
      await options.recordAttempt();
      dispatched = true;
      return infer(options);
    };
    if (drift === "queue") {
      let checks = 0;
      f.options.fence = () => ++checks === 1;
    }
    await assert.rejects(runIntakeWorkflow(f.options), /source or queue ownership changed/);
    assert.equal(dispatched, false);
    assert.deepEqual(f.writes, []);
    assert.ok(!readAllSpooledActionEvents(f.root).some((event) => event.attributes?.model));
  });
}

test("interrupted intake mutation recovers before a later review seals the producer", async (t) => {
  const f = fixture(t);
  const state = {
    index: 0,
    mutationAttemptCount: 0,
    startEventId: null,
    lastEventId: null,
    uncertainMutationObserved: false,
  };
  const attempt = startWorkflowMutationAttempt(f.root, state, "intake-label-write", {
    phase: "workflow.attempt",
    operation: "intake-triage",
    operationIdentity: { item: "openclaw/openclaw#42", generation: 1 },
    component: "intake-triage",
    subject: { repository: "openclaw/openclaw", kind: "issue", number: 42 },
    slot: "label-intent",
    phaseSeq: 1,
    idempotencyIdentity: "intake-label-write",
  });
  assert.ok(attempt.eventId);
  assert.equal(interruptOpenWorkflowActionEvents(f.root, { reasonCode: "cancelled" }), 1);
  const events = readAllSpooledActionEvents(f.root);
  const terminal = events.find((event) => event.parent_event_id === attempt.eventId);
  assert.ok(terminal);
  assert.equal(terminal.event_type, "workflow.attempt");
  assert.equal(terminal.action.mutation, true);
  assert.equal(terminal.action.retryable, false);
  assert.equal(terminal.action.status, "cancelled");
  assert.equal(terminal.attributes?.completion_reason, "mutation_outcome_unknown");
  const outputRoot = join(f.root, "shards");
  mkdirSync(outputRoot);
  await flushWorkflowActionEvents(f.root, { outputRoot, projectionFlushTimeoutMs: 1 });
  assert.equal(interruptOpenWorkflowActionEvents(f.root), 0);
});

test("unrecovered intake writes remain recoverable after a successful review flush", async (t) => {
  const f = fixture(t);
  const attempt = startWorkflowMutationAttempt(
    f.root,
    {
      index: 0,
      mutationAttemptCount: 0,
      startEventId: null,
      lastEventId: null,
      uncertainMutationObserved: false,
    },
    "intake-label-write",
    {
      phase: "workflow.attempt",
      operation: "intake-triage",
      operationIdentity: { item: "openclaw/openclaw#42", generation: 1 },
      component: "intake-triage",
      subject: { repository: "openclaw/openclaw", kind: "issue", number: 42 },
      slot: "label-intent",
      phaseSeq: 1,
      idempotencyIdentity: "intake-label-write",
    },
  );
  assert.ok(attempt.eventId);
  // Failed early recovery leaves the intent open. A completed later review must
  // not seal it before the always-run finalizer gets another recovery attempt.
  recordWorkflowActionEvent(f.root, {
    scope: "review",
    identity: "finished-review",
    type: "review.item",
    component: "review",
    subject: { repository: "openclaw/openclaw", kind: "issue", number: 42 },
    action: { name: "review.item", status: "completed", retryable: false, mutation: false },
  });
  const outputRoot = join(f.root, "shards");
  mkdirSync(outputRoot);
  await assert.rejects(
    flushWorkflowActionEvents(f.root, { outputRoot, projectionFlushTimeoutMs: 1 }),
    /unresolved mutation attempt/,
  );
  assert.equal(interruptOpenWorkflowActionEvents(f.root, { reasonCode: "workflow_failed" }), 1);
  const terminal = readAllSpooledActionEvents(f.root).find(
    (event) => event.parent_event_id === attempt.eventId,
  );
  assert.ok(terminal);
  assert.equal(terminal.action.retryable, false);
  assert.equal(terminal.action.mutation, true);
  assert.equal(terminal.attributes?.completion_reason, "mutation_outcome_unknown");
  assert.ok(
    (await flushWorkflowActionEvents(f.root, { outputRoot, projectionFlushTimeoutMs: 1 })).length >
      0,
  );
});

test("interruption finalization preserves completed intake and accepted write receipts", async (t) => {
  const f = fixture(t);
  await runIntakeWorkflow(f.options);
  assert.equal(interruptOpenWorkflowActionEvents(f.root), 0);
});

test("publication and release failures retain both causes and the unknown receipt", async (t) => {
  const f = fixture(t);
  f.unknownWrite();
  f.options.fence = (phase) =>
    phase !== "review" || !f.live.labels.includes("clawsweeper:intake:bug");
  await assert.rejects(runIntakeWorkflow(f.options), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some((cause) => cause.message === "transport failed after dispatch"));
    assert.ok(
      error.errors.some((cause) => /source or queue ownership changed/.test(cause.message)),
    );
    return true;
  });
  assert.ok(
    readAllSpooledActionEvents(f.root).some(
      (event) => event.attributes?.completion_reason === "mutation_outcome_unknown",
    ),
  );
});

test("release ownership loss is surfaced after an accepted publication", async (t) => {
  const f = fixture(t);
  f.options.fence = (phase) =>
    phase !== "review" || !f.live.labels.includes("clawsweeper:intake:bug");
  await assert.rejects(runIntakeWorkflow(f.options), /source or queue ownership changed/);
  assert.ok(f.live.labels.includes("clawsweeper:intake:bug"));
  assert.ok(
    readAllSpooledActionEvents(f.root).some(
      (event) => event.attributes?.completion_reason === "mutation_accepted",
    ),
  );
});
