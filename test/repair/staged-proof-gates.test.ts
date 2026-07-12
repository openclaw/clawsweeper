import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStagedProofPlan,
  executeStagedProofPlan,
  isBroadOrLiveStagedProofCommand,
  isPassedStagedProofBundle,
  stagedProofBundle,
  stagedProofPlanArtifact,
  stagedProofPlanFromArtifact,
  stagedProofTraceFromError,
} from "../../dist/repair/staged-proof-gates.js";

const VALIDATED_HEAD_SHA = "1".repeat(40);
const VALIDATED_BASE_SHA = "2".repeat(40);

function command(parts, originalIndex, overrides = {}) {
  return {
    parts,
    source: "artifact",
    canonical: false,
    required: true,
    originalIndex,
    ...overrides,
  };
}

test("narrow proof plans run integrity and focused tests before broader gates", () => {
  const plan = buildStagedProofPlan({
    commands: [
      command(["pnpm", "check:changed"], 0, {
        source: "changed_gate",
        canonical: true,
      }),
      command(["pnpm", "lint"], 1),
      command(["pnpm", "test:serial", "test/repair/foo.test.ts"], 2),
      command(["git", "diff", "--check", "origin/main...HEAD"], 3),
      command(["pnpm", "test:all"], 4),
    ],
    changedFiles: ["src/repair/foo.ts", "test/repair/foo.test.ts"],
  });

  assert.deepEqual(
    plan.commands.map((entry) => entry.stage),
    [
      "repository_integrity",
      "focused_tests",
      "static",
      "canonical_changed_surface",
      "broad_live_or_e2e",
    ],
  );
  assert.equal(plan.risk.level, "narrow");
});

test("risky surfaces retain static proof before focused tests", () => {
  const plan = buildStagedProofPlan({
    commands: [
      command(["pnpm", "test:serial", "test/repair/foo.test.ts"], 0),
      command(["pnpm", "lint"], 1),
      command(["pnpm", "check:changed"], 2, {
        source: "changed_gate",
        canonical: true,
      }),
    ],
    changedFiles: [".github/workflows/repair.yml", "src/repair/foo.ts"],
  });

  assert.deepEqual(plan.risk, {
    level: "elevated",
    signals: ["workflow"],
    changed_file_count: 2,
  });
  assert.deepEqual(
    plan.commands.map((entry) => entry.stage),
    ["static", "focused_tests", "canonical_changed_surface"],
  );
});

test("broad proof classification covers every supported required suite form", () => {
  for (const parts of [
    ["pnpm", "test:serial"],
    ["pnpm", "android:test:integration"],
    ["pnpm", "openclaw", "qa", "suite"],
    ["python", "-m", "pytest"],
    ["node", "--test"],
  ]) {
    assert.equal(isBroadOrLiveStagedProofCommand(parts), true, parts.join(" "));
  }
  assert.equal(
    isBroadOrLiveStagedProofCommand(["node", "--test", "test/repair/foo.test.ts"]),
    false,
  );
  assert.equal(
    isBroadOrLiveStagedProofCommand(["python", "-m", "pytest", "test/repair/foo_test.py"]),
    false,
  );
});

test("proof plans deduplicate exact argv while retaining mandatory provenance", () => {
  const plan = buildStagedProofPlan({
    commands: [
      command(["pnpm", "check:changed"], 0),
      command(["pnpm", "check:changed"], 1, {
        source: "changed_gate",
        canonical: true,
      }),
    ],
    changedFiles: ["src/repair/foo.ts"],
  });

  assert.equal(plan.commands.length, 1);
  assert.equal(plan.deduplicated_commands, 1);
  assert.equal(plan.commands[0].source, "changed_gate");
  assert.equal(plan.commands[0].stage, "canonical_changed_surface");
});

test("proof execution fails fast and records skipped prerequisites", () => {
  const plan = buildStagedProofPlan({
    commands: [
      command(["git", "diff", "--check"], 0),
      command(["pnpm", "lint"], 1),
      command(["pnpm", "check:changed"], 2, {
        source: "changed_gate",
        canonical: true,
      }),
    ],
    changedFiles: ["src/repair/foo.ts"],
  });
  const invoked = [];
  let failedTrace;

  assert.throws(
    () =>
      executeStagedProofPlan(plan, {
        commandTimeoutMs: 1000,
        budgetMs: 5000,
        validatedHeadSha: VALIDATED_HEAD_SHA,
        validatedBaseSha: VALIDATED_BASE_SHA,
        nowMs: () => 100,
        runCommand: (entry) => {
          invoked.push(entry.command_kind);
          throw new Error("fixture failure with noisy output");
        },
      }),
    (error) => {
      const trace = stagedProofTraceFromError(error);
      assert.ok(trace);
      failedTrace = trace;
      assert.equal(trace.status, "failed");
      assert.deepEqual(
        trace.commands.map((entry) => entry.status),
        ["failed", "skipped_prerequisite", "skipped_prerequisite"],
      );
      assert.deepEqual(
        trace.commands.map((entry) => entry.prerequisite),
        plan.commands.map((entry) => entry.prerequisite),
      );
      assert.equal(JSON.stringify(trace).includes("noisy output"), false);
      return true;
    },
  );
  assert.deepEqual(invoked, ["git:diff-check"]);
  const passedTrace = executeStagedProofPlan(plan, {
    commandTimeoutMs: 1000,
    budgetMs: 5000,
    validatedHeadSha: VALIDATED_HEAD_SHA,
    validatedBaseSha: VALIDATED_BASE_SHA,
    nowMs: () => 100,
    runCommand: (entry) => ({
      executedCommands: [entry.parts.join(" ")],
      reason: "passed",
    }),
  }).trace;
  assert.equal(
    isPassedStagedProofBundle(
      stagedProofBundle([failedTrace, passedTrace]),
      stagedProofPlanArtifact(plan),
    ),
    true,
  );
});

test("only explicit toolchain contracts skip a later proof command", () => {
  const integrity = ["git", "diff", "--check"];
  const lint = ["pnpm", "lint"];
  const plan = buildStagedProofPlan({
    commands: [command(integrity, 0, { source: "configured" }), command(lint, 1)],
    changedFiles: ["src/repair/foo.ts"],
    subsumptionContracts: [{ command: integrity, subsumes: [lint] }],
  });
  const invoked = [];
  const result = executeStagedProofPlan(plan, {
    commandTimeoutMs: 1000,
    budgetMs: 5000,
    validatedHeadSha: VALIDATED_HEAD_SHA,
    validatedBaseSha: VALIDATED_BASE_SHA,
    nowMs: () => 100,
    runCommand: (entry) => {
      invoked.push(entry.command_kind);
      return { executedCommands: [entry.parts.join(" ")], reason: "passed" };
    },
  });

  assert.deepEqual(invoked, ["git:diff-check"]);
  assert.deepEqual(
    result.trace.commands.map((entry) => entry.status),
    ["passed", "skipped_subsumed"],
  );
  assert.match(result.trace.commands[1].command_id, /^proof-2-/);
  assert.equal(result.trace.commands[1].subsumed_by, result.trace.commands[0].command_id);
  assert.match(result.trace.commands[1].subsumption_contract_digest, /^[a-f0-9]{64}$/);
  const planArtifact = stagedProofPlanArtifact(plan);
  assert.equal(isPassedStagedProofBundle(stagedProofBundle([result.trace]), planArtifact), true);
  const malformed = {
    ...result.trace,
    commands: [
      result.trace.commands[0],
      {
        ...result.trace.commands[1],
        subsumed_by: "proof-99-000000000000",
      },
    ],
  };
  assert.equal(isPassedStagedProofBundle(stagedProofBundle([malformed]), planArtifact), false);
  const malformedContract = {
    ...result.trace,
    commands: [
      result.trace.commands[0],
      {
        ...result.trace.commands[1],
        subsumption_contract_digest: "0".repeat(64),
      },
    ],
  };
  assert.equal(
    isPassedStagedProofBundle(stagedProofBundle([malformedContract]), planArtifact),
    false,
  );
});

test("arbitrary test commands are not inferred to be redundant", () => {
  const plan = buildStagedProofPlan({
    commands: [
      command(["pnpm", "check:changed"], 0, {
        source: "changed_gate",
        canonical: true,
      }),
      command(["pnpm", "test:serial", "test/repair/foo.test.ts"], 1),
    ],
    changedFiles: ["src/repair/foo.ts"],
  });

  assert.equal(
    plan.commands.every((entry) => entry.subsumed_by === null),
    true,
  );
});

test("subsumption never skips canonical, elevated-risk, or live proof", () => {
  const integrity = ["git", "diff", "--check"];
  const canonical = ["pnpm", "check:changed"];
  const live = ["pnpm", "test:live"];
  const plan = buildStagedProofPlan({
    commands: [
      command(integrity, 0, { source: "configured" }),
      command(canonical, 1, { source: "changed_gate", canonical: true }),
      command(live, 2),
    ],
    changedFiles: [".github/workflows/repair.yml"],
    subsumptionContracts: [{ command: integrity, subsumes: [canonical, live] }],
  });

  assert.equal(
    plan.commands.every((entry) => entry.subsumed_by === null),
    true,
  );
});

test("direct QA and live runners remain non-subsumable on narrow surfaces", () => {
  const integrity = ["git", "diff", "--check"];
  for (const liveCommand of [
    ["pnpm", "openclaw", "qa", "suite", "--provider-mode", "mock-openai"],
    ["pnpm", "run", "openclaw", "--", "qa", "suite"],
    ["pnpm", "exec", "playwright", "test"],
  ]) {
    const plan = buildStagedProofPlan({
      commands: [command(integrity, 0, { source: "configured" }), command(liveCommand, 1)],
      changedFiles: ["src/repair/foo.ts"],
      subsumptionContracts: [{ command: integrity, subsumes: [liveCommand] }],
    });

    assert.equal(plan.risk.level, "narrow");
    assert.equal(plan.commands[1].stage, "broad_live_or_e2e");
    assert.equal(plan.commands[1].subsumed_by, null);
  }
});

test("path-scoped integration runners remain late and non-subsumable", () => {
  const integrity = ["git", "diff", "--check"];
  for (const integrationCommand of [
    ["python", "-m", "pytest", "tests/integration/test_provider.py"],
    ["pytest", "-m", "integration and not slow"],
    ["go", "test", "./integration/..."],
    ["node", "--test", "test/e2e/provider.test.js"],
    ["pnpm", "exec", "vitest", "run", "test/integration/provider.test.ts"],
    ["cargo", "test", "--test", "provider_integration"],
    ["bash", "scripts/run-tests.sh", "test/e2e/provider.test.sh"],
    ["sh", "scripts/run-tests.sh", "tests/integration/provider.test.sh"],
  ]) {
    const plan = buildStagedProofPlan({
      commands: [command(integrity, 0, { source: "configured" }), command(integrationCommand, 1)],
      changedFiles: ["src/repair/foo.ts"],
      subsumptionContracts: [{ command: integrity, subsumes: [integrationCommand] }],
    });

    assert.equal(plan.risk.level, "narrow");
    assert.equal(plan.commands[1].stage, "broad_live_or_e2e", integrationCommand.join(" "));
    assert.equal(plan.commands[1].subsumed_by, null, integrationCommand.join(" "));
  }
});

test("runtime budget exhaustion is fail-closed and auditable", () => {
  const plan = buildStagedProofPlan({
    commands: [
      command(["pnpm", "lint"], 0),
      command(["pnpm", "check:changed"], 1, {
        source: "changed_gate",
        canonical: true,
      }),
    ],
    changedFiles: ["src/repair/foo.ts"],
  });
  let now = 0;

  assert.throws(
    () =>
      executeStagedProofPlan(plan, {
        commandTimeoutMs: 1000,
        budgetMs: 50,
        validatedHeadSha: VALIDATED_HEAD_SHA,
        validatedBaseSha: VALIDATED_BASE_SHA,
        nowMs: () => now,
        runCommand: (entry, timeoutMs) => {
          assert.equal(timeoutMs, 50);
          now += 60;
          return { executedCommands: [entry.parts.join(" ")], reason: "passed" };
        },
      }),
    (error) => {
      const trace = stagedProofTraceFromError(error);
      assert.ok(trace);
      assert.deepEqual(
        trace.commands.map((entry) => [entry.status, entry.reason]),
        [
          ["failed", "runtime_budget_exhausted_after_command"],
          [
            "skipped_prerequisite",
            `prerequisite ${plan.commands[0].id} did not pass after ${plan.commands[0].id} failed`,
          ],
        ],
      );
      return true;
    },
  );
});

test("plan artifacts and traces are deterministic with a deterministic clock", () => {
  const input = {
    commands: [command(["pnpm", "lint"], 1), command(["git", "diff", "--check"], 0)],
    changedFiles: ["src/repair/foo.ts"],
  };
  const planA = buildStagedProofPlan(input);
  const planB = buildStagedProofPlan(input);
  const run = (plan) =>
    executeStagedProofPlan(plan, {
      commandTimeoutMs: 1000,
      budgetMs: 5000,
      validatedHeadSha: VALIDATED_HEAD_SHA,
      validatedBaseSha: VALIDATED_BASE_SHA,
      nowMs: () => 10,
      runCommand: (entry) => ({
        executedCommands: [entry.parts.join(" ")],
        reason: "passed",
      }),
    });

  assert.deepEqual(stagedProofPlanArtifact(planA), stagedProofPlanArtifact(planB));
  assert.deepEqual(run(planA).trace, run(planB).trace);
});

test("plan artifact replay preserves normalized provenance and topology exactly", () => {
  const integrity = ["git", "diff", "--check"];
  const lint = ["pnpm", "lint"];
  const changedGate = ["pnpm", "check:changed"];
  const plan = buildStagedProofPlan({
    commands: [
      command(changedGate, 4, {
        source: "changed_gate",
        canonical: true,
        required: false,
      }),
      command(lint, 2, {
        source: "artifact",
        displayParts: ["pnpm", "run", "lint"],
      }),
      command(integrity, 1, { source: "configured" }),
      command(lint, 3, { source: "repository_profile" }),
    ],
    changedFiles: ["docs/security.md"],
    subsumptionContracts: [{ command: integrity, subsumes: [lint] }],
  });
  const artifact = stagedProofPlanArtifact(plan);
  const replayed = stagedProofPlanFromArtifact(artifact);

  assert.deepEqual(stagedProofPlanArtifact(replayed), artifact);
  assert.deepEqual(replayed.commands, plan.commands);
});

test("proof plans reject malformed or unbounded command vectors", () => {
  assert.throws(
    () => buildStagedProofPlan({ commands: [command([], 0)], changedFiles: [] }),
    /cannot be empty/,
  );
  assert.throws(
    () =>
      buildStagedProofPlan({
        commands: Array.from({ length: 33 }, (_, index) =>
          command(["git", "diff", "--check", `ref-${index}`], index),
        ),
        changedFiles: [],
      }),
    /exceeds 32 commands/,
  );
});

test("merge proof bundle validation fails closed", () => {
  const plan = buildStagedProofPlan({
    commands: [command(["git", "diff", "--check"], 0), command(["pnpm", "lint"], 1)],
    changedFiles: [],
  });
  const passed = executeStagedProofPlan(plan, {
    commandTimeoutMs: 1000,
    budgetMs: 5000,
    validatedHeadSha: VALIDATED_HEAD_SHA,
    validatedBaseSha: VALIDATED_BASE_SHA,
    nowMs: () => 10,
    runCommand: (entry) => ({
      executedCommands: [entry.parts.join(" ")],
      reason: "passed",
    }),
  }).trace;
  const bundle = stagedProofBundle([passed]);
  const planArtifact = stagedProofPlanArtifact(plan);

  assert.equal(isPassedStagedProofBundle(bundle, planArtifact), true);
  assert.equal(isPassedStagedProofBundle(bundle, null), false);
  assert.equal(bundle.validated_head_sha, VALIDATED_HEAD_SHA);
  assert.equal(bundle.validated_base_sha, VALIDATED_BASE_SHA);
  assert.equal(isPassedStagedProofBundle({ ...bundle, status: "failed" }, planArtifact), false);
  assert.equal(
    isPassedStagedProofBundle({ ...bundle, validated_head_sha: "3".repeat(40) }, planArtifact),
    false,
  );
  assert.equal(
    isPassedStagedProofBundle(
      {
        ...bundle,
        runs: [{ ...passed, status: "failed" }],
      },
      planArtifact,
    ),
    false,
  );
  assert.equal(isPassedStagedProofBundle({ ...bundle, runs: [] }, planArtifact), false);
  assert.equal(isPassedStagedProofBundle({ ...bundle, summary: null }, planArtifact), false);
  assert.equal(
    isPassedStagedProofBundle(
      stagedProofBundle([
        {
          ...passed,
          commands: [
            passed.commands[0],
            {
              ...passed.commands[1],
              status: "skipped_prerequisite",
              duration_ms: 0,
              reason: "prerequisite failed",
            },
          ],
          summary: {
            ...passed.summary,
            passed: 1,
            skipped: 1,
          },
        },
      ]),
      planArtifact,
    ),
    false,
  );
  assert.equal(
    isPassedStagedProofBundle(
      stagedProofBundle([
        {
          ...passed,
          commands: [
            {
              ...passed.commands[0],
              command_digest: "f".repeat(64),
            },
            passed.commands[1],
          ],
        },
      ]),
      planArtifact,
    ),
    false,
  );
  assert.equal(
    isPassedStagedProofBundle(
      stagedProofBundle([
        {
          ...passed,
          commands: [{ ...passed.commands[0], stage: "unknown" }, passed.commands[1]],
        },
      ]),
      planArtifact,
    ),
    false,
  );
  assert.equal(
    isPassedStagedProofBundle(
      stagedProofBundle([
        {
          ...passed,
          commands: [{ ...passed.commands[0], duration_ms: -1 }, passed.commands[1]],
        },
      ]),
      planArtifact,
    ),
    false,
  );
  assert.equal(
    isPassedStagedProofBundle(
      stagedProofBundle([
        {
          ...passed,
          summary: { ...passed.summary, passed: 99 },
        },
      ]),
      planArtifact,
    ),
    false,
  );
  assert.equal(
    isPassedStagedProofBundle(
      {
        ...bundle,
        summary: { ...bundle.summary, passed: 99 },
      },
      planArtifact,
    ),
    false,
  );

  const forgedPlan = buildStagedProofPlan({
    commands: [command(["pnpm", "test:serial", "test/repair/forged.test.ts"], 0)],
    changedFiles: [],
  });
  const forgedTrace = executeStagedProofPlan(forgedPlan, {
    commandTimeoutMs: 1000,
    budgetMs: 5000,
    validatedHeadSha: VALIDATED_HEAD_SHA,
    validatedBaseSha: VALIDATED_BASE_SHA,
    nowMs: () => 10,
    runCommand: (entry) => ({
      executedCommands: [entry.parts.join(" ")],
      reason: "passed",
    }),
  }).trace;
  assert.equal(isPassedStagedProofBundle(stagedProofBundle([forgedTrace]), planArtifact), false);
});
