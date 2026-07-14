import assert from "node:assert/strict";
import test from "node:test";
import { planRepairClosureResult } from "../../dist/repair/closure-result-plan.js";

function close(target: string, canonical: string, dependsOn?: string[]) {
  return {
    action: "close_duplicate",
    status: "planned",
    target,
    canonical,
    ...(dependsOn === undefined ? {} : { depends_on: dependsOn }),
  };
}

test("derives deterministic closure layers from reviewed actions", () => {
  const result = planRepairClosureResult({
    actions: [
      close("#103", "#100", ["#101", "#102"]),
      close("#102", "#100", ["#101"]),
      close("#101", "#100"),
      {
        action: "close_low_signal",
        status: "planned",
        target: "#200",
      },
    ],
  });

  assert.deepEqual(result, {
    status: "safe",
    canonicalRoot: "#100",
    closureLayers: [["#101"], ["#102"], ["#103"]],
    independentClosures: ["#200"],
    nodeCount: 4,
    edgeCount: 3,
  });
});

test("action permutation does not change the derived plan", () => {
  const actions = [
    close("#103", "#100", ["#101", "#102"]),
    close("#102", "#100", ["#101"]),
    close("#101", "#100"),
  ];
  const expected = planRepairClosureResult({ actions });
  assert.deepEqual(planRepairClosureResult({ actions: [...actions].reverse() }), expected);
});

test("mixed canonical roots require human review", () => {
  const result = planRepairClosureResult({
    actions: [close("#101", "#100"), close("#201", "#200")],
  });
  assert.equal(result.status, "needs_human");
  if (result.status !== "needs_human") return;
  assert.ok(result.diagnostics.some((entry) => entry.code === "multiple_canonical_roots"));
});

test("cycles and missing dependency targets fail closed", () => {
  const cycle = planRepairClosureResult({
    actions: [close("#101", "#100", ["#102"]), close("#102", "#100", ["#101"])],
  });
  assert.equal(cycle.status, "needs_human");
  if (cycle.status === "needs_human") {
    assert.ok(cycle.diagnostics.some((entry) => entry.code === "dependency_cycle"));
  }

  const missing = planRepairClosureResult({
    actions: [close("#101", "#100", ["#999"])],
  });
  assert.equal(missing.status, "needs_human");
  if (missing.status === "needs_human") {
    assert.ok(missing.diagnostics.some((entry) => entry.code === "missing_referenced_node"));
  }
});

test("self-root and low-signal closes stay outside the dependency graph", () => {
  assert.deepEqual(
    planRepairClosureResult({
      actions: [
        {
          action: "close_fixed_by_candidate",
          status: "planned",
          target: "#101",
          canonical: "#101",
        },
        {
          action: "close_low_signal",
          status: "planned",
          target: "#102",
        },
      ],
    }),
    {
      status: "not_applicable",
      independentClosures: ["#101", "#102"],
    },
  );
});
