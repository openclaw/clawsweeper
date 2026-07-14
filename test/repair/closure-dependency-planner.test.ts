import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOSURE_DEPENDENCY_PLANNER_LIMITS,
  planClosureDependencies,
} from "../../dist/repair/closure-dependency-planner.js";

function canonical(id = "root") {
  return { id, kind: "canonical_root", canonicalCandidates: [] };
}

function closure(id: string, canonicalCandidates = ["root"]) {
  return { id, kind: "closure_candidate", canonicalCandidates };
}

function edge(prerequisite: string, dependent: string) {
  return { prerequisite, dependent };
}

function diagnosticCodes(result: ReturnType<typeof planClosureDependencies>) {
  assert.equal(result.status, "needs_human");
  return result.diagnostics.map((entry) => entry.code);
}

test("plans deterministic dependency-first closure layers with ASCII ordering", () => {
  const result = planClosureDependencies({
    nodes: [closure("a"), closure("Z"), canonical(), closure("A"), closure("final")],
    edges: [
      edge("Z", "final"),
      edge("root", "a"),
      edge("A", "final"),
      edge("root", "Z"),
      edge("root", "A"),
      edge("a", "final"),
      edge("root", "A"),
    ],
  });

  assert.deepEqual(result, {
    status: "safe",
    canonicalRoot: "root",
    closureLayers: [["A", "Z", "a"], ["final"]],
    nodeCount: 5,
    edgeCount: 6,
  });
});

test("treats the canonical root as already satisfied", () => {
  const result = planClosureDependencies({
    nodes: [canonical(), closure("depends-on-root"), closure("independent")],
    edges: [edge("root", "depends-on-root")],
  });

  assert.equal(result.status, "safe");
  assert.deepEqual(result.closureLayers, [["depends-on-root", "independent"]]);
});

test("safe plans are invariant across node and edge permutations", () => {
  const nodes = [canonical(), closure("alpha"), closure("beta"), closure("final")];
  const edges = [
    edge("root", "alpha"),
    edge("root", "beta"),
    edge("alpha", "final"),
    edge("beta", "final"),
  ];
  const expected = planClosureDependencies({ nodes, edges });
  assert.equal(expected.status, "safe");

  for (const nodeOrder of permutations(nodes)) {
    for (const edgeOrder of permutations(edges)) {
      assert.deepEqual(planClosureDependencies({ nodes: nodeOrder, edges: edgeOrder }), expected);
    }
  }
});

test("needs-human cycle diagnostics are invariant across input permutations", () => {
  const nodes = [closure("b"), canonical(), closure("a")];
  const edges = [edge("a", "b"), edge("b", "a")];
  const expected = planClosureDependencies({ nodes, edges });

  for (const nodeOrder of permutations(nodes)) {
    for (const edgeOrder of permutations(edges)) {
      assert.deepEqual(planClosureDependencies({ nodes: nodeOrder, edges: edgeOrder }), expected);
    }
  }
  assert.deepEqual(expected, {
    status: "needs_human",
    diagnostics: [
      {
        code: "dependency_cycle",
        message: "dependency cycle contains a, b",
        nodes: ["a", "b"],
      },
    ],
  });
});

test("fails closed on self-cycles", () => {
  const result = planClosureDependencies({
    nodes: [canonical(), closure("a")],
    edges: [edge("a", "a")],
  });

  assert.deepEqual(result, {
    status: "needs_human",
    diagnostics: [
      {
        code: "self_cycle",
        message: "a depends on itself",
        nodes: ["a"],
      },
    ],
  });
});

test("fails closed when dependencies or canonical selections reference missing nodes", () => {
  const result = planClosureDependencies({
    nodes: [canonical(), closure("a", ["missing"])],
    edges: [edge("a", "also-missing")],
  });

  assert.equal(result.status, "needs_human");
  assert.deepEqual(
    result.diagnostics.filter((entry) => entry.code === "missing_referenced_node"),
    [
      {
        code: "missing_referenced_node",
        message: "dependency edge references missing node also-missing",
        nodes: ["a", "also-missing"],
      },
      {
        code: "missing_referenced_node",
        message: "a references missing canonical candidate missing",
        nodes: ["a", "missing"],
      },
    ],
  );
  assert.ok(result.diagnostics.some((entry) => entry.code === "ambiguous_canonical_selection"));
});

test("fails closed on multiple canonical roots", () => {
  const result = planClosureDependencies({
    nodes: [canonical("root-b"), closure("a", ["root-a"]), canonical("root-a")],
    edges: [],
  });

  assert.ok(diagnosticCodes(result).includes("multiple_canonical_roots"));
});

test("fails closed on absent, multiple, or non-root canonical selections", () => {
  const cases = [
    {
      nodes: [closure("a", [])],
      edges: [],
    },
    {
      nodes: [canonical(), closure("other"), closure("a", ["root", "other"])],
      edges: [],
    },
    {
      nodes: [canonical(), closure("other"), closure("a", ["other"])],
      edges: [],
    },
    {
      nodes: [{ ...canonical(), canonicalCandidates: ["a"] }, closure("a")],
      edges: [],
    },
  ];

  for (const input of cases) {
    assert.ok(
      diagnosticCodes(planClosureDependencies(input)).includes("ambiguous_canonical_selection"),
    );
  }
});

test("fails closed on duplicate and conflicting node declarations", () => {
  const duplicate = planClosureDependencies({
    nodes: [canonical(), closure("a"), closure("a")],
    edges: [],
  });
  const conflicting = planClosureDependencies({
    nodes: [canonical(), closure("a"), canonical("a")],
    edges: [],
  });

  assert.deepEqual(diagnosticCodes(duplicate), ["duplicate_node_declaration"]);
  assert.deepEqual(diagnosticCodes(conflicting), ["conflicting_node_declaration"]);
});

test("fails closed when the canonical root has a prerequisite", () => {
  const result = planClosureDependencies({
    nodes: [canonical(), closure("a")],
    edges: [edge("a", "root")],
  });

  assert.deepEqual(diagnosticCodes(result), ["canonical_root_has_dependency"]);
});

test("fails closed on unsafe collection, candidate, and identifier bounds", () => {
  const tooManyNodes = Array.from(
    { length: CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxNodes + 1 },
    (_, index) => closure(`node-${index}`),
  );
  const tooManyEdges = Array.from({ length: CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxEdges + 1 }, () =>
    edge("root", "a"),
  );
  const tooManyCandidates = Array.from(
    { length: CLOSURE_DEPENDENCY_PLANNER_LIMITS.maxCanonicalCandidatesPerNode + 1 },
    (_, index) => `root-${index}`,
  );

  assert.deepEqual(diagnosticCodes(planClosureDependencies({ nodes: tooManyNodes, edges: [] })), [
    "unsafe_bounds",
  ]);
  assert.deepEqual(
    diagnosticCodes(
      planClosureDependencies({
        nodes: [canonical(), closure("a")],
        edges: tooManyEdges,
      }),
    ),
    ["unsafe_bounds"],
  );
  assert.deepEqual(
    diagnosticCodes(
      planClosureDependencies({
        nodes: [canonical(), closure("a", tooManyCandidates)],
        edges: [],
      }),
    ),
    ["unsafe_bounds"],
  );
  assert.deepEqual(
    diagnosticCodes(
      planClosureDependencies({
        nodes: [canonical(), closure("not ascii: \u00e9")],
        edges: [],
      }),
    ),
    ["invalid_node_id"],
  );
});

test("does not mutate caller-owned nodes, candidates, or edges", () => {
  const canonicalCandidates = Object.freeze(["root"]);
  const nodes = Object.freeze([
    Object.freeze(canonical()),
    Object.freeze({ ...closure("b"), canonicalCandidates }),
    Object.freeze({ ...closure("a"), canonicalCandidates }),
  ]);
  const edges = Object.freeze([Object.freeze(edge("root", "b")), Object.freeze(edge("root", "a"))]);
  const before = JSON.stringify({ nodes, edges });

  const result = planClosureDependencies({ nodes, edges });

  assert.equal(result.status, "safe");
  assert.equal(JSON.stringify({ nodes, edges }), before);
});

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  const results: T[][] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permutations(rest)) results.push([value, ...tail]);
  }
  return results;
}
