import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStagedProofPlan,
  executeStagedProofPlan,
  isPassedStagedProofBundle,
  stagedProofBundle,
  stagedProofPlanArtifact,
  stagedProofTraceFromError,
} from "../../dist/repair/staged-proof-gates.js";

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

  assert.throws(
    () =>
      executeStagedProofPlan(plan, {
        commandTimeoutMs: 1000,
        budgetMs: 5000,
        nowMs: () => 100,
        runCommand: (entry) => {
          invoked.push(entry.command_kind);
          throw new Error("fixture failure with noisy output");
        },
      }),
    (error) => {
      const trace = stagedProofTraceFromError(error);
      assert.ok(trace);
      assert.equal(trace.status, "failed");
      assert.deepEqual(
        trace.commands.map((entry) => entry.status),
        ["failed", "skipped_prerequisite", "skipped_prerequisite"],
      );
      assert.equal(JSON.stringify(trace).includes("noisy output"), false);
      return true;
    },
  );
  assert.deepEqual(invoked, ["git:diff-check"]);
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
          ["passed", "passed"],
          ["failed", "runtime_budget_exhausted"],
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
      nowMs: () => 10,
      runCommand: (entry) => ({
        executedCommands: [entry.parts.join(" ")],
        reason: "passed",
      }),
    });

  assert.deepEqual(stagedProofPlanArtifact(planA), stagedProofPlanArtifact(planB));
  assert.deepEqual(run(planA).trace, run(planB).trace);
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
    commands: [command(["git", "diff", "--check"], 0)],
    changedFiles: [],
  });
  const passed = executeStagedProofPlan(plan, {
    commandTimeoutMs: 1000,
    budgetMs: 5000,
    nowMs: () => 10,
    runCommand: (entry) => ({
      executedCommands: [entry.parts.join(" ")],
      reason: "passed",
    }),
  }).trace;
  const bundle = stagedProofBundle([passed]);

  assert.equal(isPassedStagedProofBundle(bundle), true);
  assert.equal(isPassedStagedProofBundle({ ...bundle, status: "failed" }), false);
  assert.equal(
    isPassedStagedProofBundle({
      ...bundle,
      runs: [{ ...passed, status: "failed" }],
    }),
    false,
  );
  assert.equal(isPassedStagedProofBundle({ ...bundle, runs: [] }), false);
  assert.equal(isPassedStagedProofBundle({ ...bundle, summary: null }), false);
});
