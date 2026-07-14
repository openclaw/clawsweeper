import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  planRepairClosureResult,
  resolveRepairClosureRelationship,
} from "../../dist/repair/closure-result-plan.js";

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

test("normalizes bare numeric refs throughout closure planning", () => {
  const result = planRepairClosureResult({
    actions: [
      close("103", "100", ["101", "102"]),
      close("102", "100", ["101"]),
      close("101", "100"),
    ],
  });

  assert.deepEqual(result, {
    status: "safe",
    canonicalRoot: "#100",
    closureLayers: [["#101"], ["#102"], ["#103"]],
    independentClosures: [],
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

test("independent closures cannot collide with canonical roots", () => {
  const result = planRepairClosureResult({
    actions: [
      {
        action: "close_low_signal",
        status: "planned",
        target: "#100",
      },
      close("#101", "#100"),
    ],
  });

  assert.deepEqual(result, {
    status: "needs_human",
    diagnostics: [
      {
        code: "duplicate_node_declaration",
        message: "#100 is declared as both an independent closure and canonical root",
        nodes: ["#100"],
      },
    ],
    independentClosures: ["#100"],
  });
});

test("independent closures cannot collide with grouped candidates", () => {
  const result = planRepairClosureResult({
    actions: [
      close("#101", "#100"),
      {
        action: "close_low_signal",
        status: "planned",
        target: "#101",
      },
    ],
  });

  assert.deepEqual(result, {
    status: "needs_human",
    diagnostics: [
      {
        code: "duplicate_node_declaration",
        message: "#101 is declared as both an independent closure and grouped closure candidate",
        nodes: ["#101"],
      },
    ],
    independentClosures: ["#101"],
  });
});

test("resolves the surviving root with apply action semantics", () => {
  assert.equal(
    resolveRepairClosureRelationship({
      action: "close_duplicate",
      classification: "duplicate",
      duplicate_of: "#100",
    }).root,
    "#100",
  );
  assert.equal(
    resolveRepairClosureRelationship({
      action: "close_superseded",
      classification: "superseded",
      candidate_fix: "#200",
    }).root,
    "#200",
  );
  assert.equal(
    resolveRepairClosureRelationship({
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      canonical: "#100",
    }).root,
    "",
  );
});

test("conflicting relationship roots require human review", () => {
  const result = planRepairClosureResult({
    actions: [
      {
        ...close("#101", "#100"),
        duplicate_of: "#100",
        candidate_fix: "#200",
      },
    ],
  });

  assert.deepEqual(result, {
    status: "needs_human",
    diagnostics: [
      {
        code: "conflicting_relationship_roots",
        message:
          "#101 declares conflicting relationship roots: canonical=#100, duplicate_of=#100, candidate_fix=#200",
        nodes: ["#100", "#101", "#200"],
      },
    ],
    independentClosures: [],
  });
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

test("canonical roots cannot satisfy closure dependencies", () => {
  const result = planRepairClosureResult({
    actions: [close("#101", "#100", ["#100"])],
  });

  assert.deepEqual(result, {
    status: "needs_human",
    diagnostics: [
      {
        code: "missing_referenced_node",
        message:
          "#101 depends_on #100, which is not another planned closure candidate in canonical group #100",
        nodes: ["#100", "#101"],
      },
    ],
    independentClosures: [],
  });
});

test("independent and self-root closes cannot declare dependencies", () => {
  const independent = planRepairClosureResult({
    actions: [
      {
        action: "close_low_signal",
        status: "planned",
        target: "#200",
        depends_on: [],
      },
    ],
  });
  assert.equal(independent.status, "needs_human");
  if (independent.status === "needs_human") {
    assert.equal(independent.diagnostics[0]?.code, "missing_referenced_node");
    assert.match(independent.diagnostics[0]?.message ?? "", /not a planned closure candidate/);
  }

  const selfRoot = planRepairClosureResult({
    actions: [
      close("#101", "#100"),
      {
        action: "close_fixed_by_candidate",
        status: "planned",
        target: "#102",
        canonical: "#102",
        depends_on: ["#101"],
      },
    ],
  });
  assert.equal(selfRoot.status, "needs_human");
  if (selfRoot.status === "needs_human") {
    assert.equal(selfRoot.diagnostics[0]?.code, "missing_referenced_node");
    assert.match(selfRoot.diagnostics[0]?.message ?? "", /not a planned closure candidate/);
  }
});

test("review-results rejects a cyclic dependency artifact", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-closure-result-"));
  const updatedAt = "2026-07-14T12:00:00Z";
  const action = (target: string, dependsOn: string[]) => ({
    target,
    action: "close_duplicate",
    status: "planned",
    idempotency_key: `closure:${target}`,
    classification: "duplicate",
    target_kind: "issue",
    target_updated_at: updatedAt,
    canonical: "#100",
    duplicate_of: null,
    candidate_fix: null,
    depends_on: dependsOn,
    comment: `Closing ${target} in favor of #100.`,
    evidence: ["Hydrated duplicate evidence."],
    reason: "Duplicate of the canonical issue.",
  });

  fs.writeFileSync(
    path.join(directory, "cluster-plan.json"),
    `${JSON.stringify({
      item_matrix: [
        { ref: "#100", kind: "issue", state: "open", updated_at: updatedAt },
        { ref: "#101", kind: "issue", state: "open", updated_at: updatedAt },
        { ref: "#102", kind: "issue", state: "open", updated_at: updatedAt },
      ],
    })}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "result.json"),
    `${JSON.stringify({
      status: "planned",
      repo: "openclaw/openclaw",
      cluster_id: "closure-cycle",
      mode: "plan",
      summary: "Cyclic closure proposal.",
      actions: [action("#101", ["#102"]), action("#102", ["#101"])],
      needs_human: [],
      canonical: "#100",
      canonical_issue: "#100",
      canonical_pr: null,
      merge_preflight: [],
      fix_artifact: null,
    })}\n`,
  );

  try {
    const result = spawnSync(process.execPath, ["dist/repair/review-results.js", directory], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "failed");
    assert.ok(
      output.reports[0].failures.some((failure: string) =>
        failure.includes("closure dependency plan dependency_cycle"),
      ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("review-results rejects conflicting closure relationship roots", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-closure-result-"));
  const updatedAt = "2026-07-14T12:00:00Z";
  fs.writeFileSync(
    path.join(directory, "cluster-plan.json"),
    `${JSON.stringify({
      item_matrix: [
        { ref: "#100", kind: "issue", state: "open", updated_at: updatedAt },
        { ref: "#101", kind: "issue", state: "open", updated_at: updatedAt },
        { ref: "#200", kind: "pull_request", state: "open", updated_at: updatedAt },
      ],
    })}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "result.json"),
    `${JSON.stringify({
      status: "planned",
      repo: "openclaw/openclaw",
      cluster_id: "closure-conflict",
      mode: "plan",
      summary: "Conflicting closure proposal.",
      actions: [
        {
          target: "#101",
          action: "close_duplicate",
          status: "planned",
          idempotency_key: "closure:#101",
          classification: "duplicate",
          target_kind: "issue",
          target_updated_at: updatedAt,
          canonical: "#100",
          duplicate_of: "#100",
          candidate_fix: "#200",
          depends_on: null,
          comment: "Closing #101 in favor of #100.",
          evidence: ["Hydrated duplicate evidence."],
          reason: "Duplicate of the canonical issue.",
        },
      ],
      needs_human: [],
      canonical: "#100",
      canonical_issue: "#100",
      canonical_pr: null,
      merge_preflight: [],
      fix_artifact: null,
    })}\n`,
  );

  try {
    const result = spawnSync(process.execPath, ["dist/repair/review-results.js", directory], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(
      output.reports[0].failures.some((failure: string) =>
        failure.includes("closure dependency plan conflicting_relationship_roots"),
      ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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
