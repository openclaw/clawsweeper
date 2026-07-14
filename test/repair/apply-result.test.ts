import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mockGhBinEnv } from "../helpers.ts";

const repoRoot = process.cwd();

test("repair apply blocks PR duplicate close when coverage proof keeps the source open", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B only rewrites parser setup.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "keep_open" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "PR close coverage proof kept the source pull request open: PR B does not carry forward the legacy behavior.",
    );
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply blocks stale covering PR refs instead of crashing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.match(
      report.actions[0].reason,
      /PR close coverage proof failed: .*issue not found: #202/s,
    );
    assert.equal(report.actions[0].requeue_required, undefined);
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply requeues transient coverage proof setup failures", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      prViewFailure: { number: 202, message: "HTTP 502 Bad Gateway" },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].requeue_required, true);
    assert.match(report.actions[0].reason, /HTTP 502 Bad Gateway/);
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply blocks proof subprocess failures after hydrating valid covering PRs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, {
      proofDecision: "covered",
      proofFailureMessage: "model subprocess crashed after valid hydration",
    });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].requeue_required, true);
    assert.match(
      report.actions[0].reason,
      /PR close coverage proof failed: .*model subprocess crashed after valid hydration/s,
    );
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply blocks F-rated covering PRs before coverage proof", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient", "rating: 🧂 unranked krab"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "linked canonical PR #202 is F-rated");
    assert.equal(report.actions[0].requeue_required, undefined);
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply compacts PR bodies in coverage proof prompts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    const unboundedTail = "UNBOUNDED_BODY_TAIL_SHOULD_NOT_REACH_PROMPT";
    const longBody = `${"legacy config ".repeat(30)}${unboundedTail}`;
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: { ...pull({ number: 101, title: "Add config validation" }), body: longBody },
        202: { ...pull({ number: 202, title: "Rewrite config validation" }), body: longBody },
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, {
      proofDecision: "covered",
      unexpectedPromptIncludes: unboundedTail,
    });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(hasPrCloseCall(paths.ghLogPath), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply filters automation comments from coverage proof prompts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [
          comment(
            "clawsweeper[bot]",
            [
              "AUTOMATION_SHOULD_NOT_REACH_REPAIR_PROOF",
              "",
              "<!-- clawsweeper-repair:close:repair-pr-close-proof:#101:proof-gated-close -->",
            ].join("\n"),
          ),
          comment("alice", "HUMAN_SOURCE_CONTEXT_REACHES_REPAIR_PROOF"),
        ],
        202: [
          comment(
            "clawsweeper[bot]",
            [
              "AUTOMATION_SHOULD_NOT_REACH_REPAIR_PROOF",
              "",
              "<!-- clawsweeper-review item=202 -->",
            ].join("\n"),
          ),
          comment("bob", "HUMAN_COVERING_CONTEXT_REACHES_REPAIR_PROOF"),
        ],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, {
      proofDecision: "covered",
      expectedPromptIncludes: "HUMAN_COVERING_CONTEXT_REACHES_REPAIR_PROOF",
      unexpectedPromptIncludes: "AUTOMATION_SHOULD_NOT_REACH_REPAIR_PROOF",
    });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(hasPrCloseCall(paths.ghLogPath), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "superseded",
    action: {
      action: "close_superseded",
      classification: "superseded",
      canonical: "#202",
    },
  },
  {
    name: "generic-duplicate",
    action: {
      action: "close",
      classification: "duplicate",
      canonical: "#202",
    },
  },
  {
    name: "generic-superseded",
    action: {
      action: "close",
      classification: "superseded",
      canonical: "#202",
    },
  },
  {
    name: "generic-fixed-by-candidate",
    action: {
      action: "close",
      classification: "fixed_by_candidate",
      candidate_fix: "#202",
    },
  },
  {
    name: "superseded-candidate",
    action: {
      action: "close_superseded",
      classification: "superseded",
      candidate_fix: "#202",
    },
    mergedCandidate: true,
  },
  {
    name: "fixed-by-candidate",
    action: {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      candidate_fix: "#202",
    },
  },
  {
    name: "post-merge",
    action: {
      action: "post_merge_close",
      classification: "fixed_by_candidate",
      candidate_fix: "#202",
    },
    mergedCandidate: true,
  },
]) {
  test(`repair apply blocks PR ${scenario.name} close when coverage proof keeps the source open`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
    try {
      const paths = writeApplyFixture(tmp, scenario.action);
      writeFakeGh(paths.binDir, {
        issues: {
          101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
          202: issue({
            number: 202,
            title: "Rewrite config validation",
            pullRequest: true,
            labels: ["proof: sufficient"],
          }),
        },
        pulls: {
          101: pull({ number: 101, title: "Add config validation" }),
          202: pull({
            number: 202,
            title: "Rewrite config validation",
            mergedAt: scenario.mergedCandidate ? "2026-05-26T00:00:00Z" : undefined,
          }),
        },
        comments: {
          101: [comment("alice", "PR A keeps legacy config behavior intact.")],
          202: [comment("bob", "PR B only rewrites parser setup.")],
        },
        logPath: paths.ghLogPath,
      });
      writeFakeCodex(paths.binDir);

      runApplyResult(paths, { proofDecision: "keep_open" });

      const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
      assert.equal(report.actions[0].status, "blocked");
      assert.equal(
        report.actions[0].reason,
        "PR close coverage proof kept the source pull request open: PR B does not carry forward the legacy behavior.",
      );
      assert.equal(hasPrCloseCall(paths.ghLogPath), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("repair apply rejects conflicting relationship roots before GitHub reads", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_superseded",
      classification: "superseded",
      canonical: "#303",
      candidate_fix: "#202",
    });

    assert.throws(
      () => runApplyResult(paths, { proofDecision: "keep_open" }),
      /conflicting_relationship_roots/,
    );
    assert.equal(fs.existsSync(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply bounds covering PR comments when issue comment count is absent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: Array.from({ length: 160 }, (_, index) =>
          comment(
            "bob",
            index === 159
              ? "Recent discussion: PR B carries forward the legacy behavior."
              : `Older discussion ${index}`,
          ),
        ),
      },
      omitIssueCommentCounts: [202],
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, {
      proofDecision: "covered",
      expectedPromptIncludes: "Recent discussion: PR B carries forward the legacy behavior.",
    });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(hasPrCloseCall(paths.ghLogPath), true);
    const coveringCommentFetches = ghCalls(paths.ghLogPath).filter(
      (call) =>
        call.args[0] === "api" &&
        call.args.some((arg) => arg.includes("/issues/202/comments")) &&
        !call.args.includes("--method"),
    );
    assert.equal(
      coveringCommentFetches.some((call) => call.args.includes("--slurp")),
      false,
    );
    assert.equal(coveringCommentFetches.length, 2);
    assert.ok(coveringCommentFetches.every((call) => call.args.includes("-i")));
    assert.ok(
      coveringCommentFetches.every((call) =>
        call.args.some((arg) => /[?&]per_page=100(?:&|$)/.test(arg)),
      ),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply blocks PR close when open covering PR lacks positive proof", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["triage: needs-real-behavior-proof"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "linked canonical PR #202 is still waiting for real behavior proof",
    );
    assert.equal(
      ghCalls(paths.ghLogPath).some((call) => call.args[0] === "pr" && call.args[1] === "close"),
      false,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply executes PR duplicate close when coverage proof says covered", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(hasPrCloseCall(paths.ghLogPath), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "superseded",
    action: {
      action: "close_superseded",
      classification: "superseded",
      canonical: "#202",
    },
  },
  {
    name: "superseded-candidate",
    action: {
      action: "close_superseded",
      classification: "superseded",
      candidate_fix: "#202",
    },
    mergedCandidate: true,
  },
  {
    name: "duplicate-of alias",
    action: {
      action: "close_duplicate",
      classification: "duplicate",
      duplicate_of: "#202",
    },
  },
  {
    name: "fixed-by-candidate",
    action: {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      candidate_fix: "#202",
    },
  },
  {
    name: "fixed-by alias",
    action: {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      fixed_by: "#202",
    },
  },
  {
    name: "fix-candidate alias",
    action: {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      fix_candidate: "#202",
    },
  },
  {
    name: "post-merge",
    action: {
      action: "post_merge_close",
      classification: "fixed_by_candidate",
      candidate_fix: "#202",
    },
    mergedCandidate: true,
  },
]) {
  test(`repair apply executes PR ${scenario.name} close when coverage proof says covered`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
    try {
      const paths = writeApplyFixture(tmp, scenario.action);
      writeFakeGh(paths.binDir, {
        issues: {
          101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
          202: issue({
            number: 202,
            title: "Rewrite config validation",
            pullRequest: true,
            labels: ["proof: sufficient"],
          }),
        },
        pulls: {
          101: pull({ number: 101, title: "Add config validation" }),
          202: pull({
            number: 202,
            title: "Rewrite config validation",
            mergedAt: scenario.mergedCandidate ? "2026-05-26T00:00:00Z" : undefined,
          }),
        },
        comments: {
          101: [comment("alice", "PR A keeps legacy config behavior intact.")],
          202: [comment("bob", "PR B carries forward the legacy config behavior.")],
        },
        logPath: paths.ghLogPath,
      });
      writeFakeCodex(paths.binDir);

      runApplyResult(paths, { proofDecision: "covered" });

      const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
      assert.equal(report.actions[0].status, "executed");
      assert.equal(hasPrCloseCall(paths.ghLogPath), true);
      assert.equal(
        report.actions[0].pr_close_coverage_proof.reason,
        "PR B carries forward the legacy behavior.",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("repair apply rechecks target freshness after coverage proof passes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    const afterProofPath = path.join(tmp, "proof-ran");
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      afterProofPath,
      postProofIssueUpdates: {
        101: "2026-05-25T00:05:00Z",
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", afterProofPath });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "target changed since worker review");
    assert.equal(report.actions[0].expected_updated_at, "2026-05-25T00:00:00Z");
    assert.equal(report.actions[0].live_updated_at, "2026-05-25T00:05:00Z");
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply rechecks covering PR safety after coverage proof passes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    const afterProofPath = path.join(tmp, "proof-ran");
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      afterProofPath,
      postProofIssues: {
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["triage: needs-real-behavior-proof"],
        }),
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", afterProofPath });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "linked canonical PR #202 is still waiting for real behavior proof",
    );
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply rechecks covering PR freshness after coverage proof passes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    const afterProofPath = path.join(tmp, "proof-ran");
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      afterProofPath,
      postProofPulls: {
        202: {
          updated_at: "2026-05-25T00:05:00Z",
          body: "Changed after proof ran.",
        },
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", afterProofPath });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "linked canonical PR #202 changed after coverage proof");
    assert.equal(report.actions[0].requeue_required, true);
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply requeues transient post-proof covering PR safety failures", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    const afterProofPath = path.join(tmp, "proof-ran");
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      afterProofPath,
      postProofPrViewFailure: { number: 202, message: "HTTP 502 Bad Gateway" },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", afterProofPath });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].requeue_required, true);
    assert.match(report.actions[0].reason, /HTTP 502 Bad Gateway/);
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply skips target closed after proof when updated_at is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
      omitTargetUpdatedAt: true,
    });
    const afterProofPath = path.join(tmp, "proof-ran");
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      afterProofPath,
      postProofIssues: {
        101: issue({
          number: 101,
          title: "Add config validation",
          pullRequest: true,
          state: "closed",
          updatedAt: "2026-05-25T00:05:00Z",
        }),
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, {
      proofDecision: "covered",
      afterProofPath,
      allowMissingUpdatedAt: true,
    });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "skipped");
    assert.equal(report.actions[0].reason, "already closed");
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply treats already-closed PR duplicate close as idempotent before coverage proof", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({
          number: 101,
          title: "Add config validation",
          pullRequest: true,
          state: "closed",
          updatedAt: "2026-05-25T00:05:00Z",
        }),
        202: issue({ number: 202, title: "Rewrite config validation", pullRequest: true }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [
          comment(
            "clawsweeper[bot]",
            [
              "Thanks for the work here. PR B is the canonical repair path.",
              "",
              "<!-- clawsweeper-repair:close:repair-pr-close-proof:#101:proof-gated-close -->",
            ].join("\n"),
          ),
        ],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "keep_open", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(
      report.actions[0].reason,
      "already closed with matching clawsweeper-repair comment",
    );
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply does not trust a human-authored close marker", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({
          number: 101,
          title: "Add config validation",
          pullRequest: true,
          state: "closed",
          updatedAt: "2026-05-25T00:05:00Z",
        }),
        202: issue({ number: 202, title: "Rewrite config validation", pullRequest: true }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [
          comment(
            "alice",
            "<!-- clawsweeper-repair:close:repair-pr-close-proof:#101:proof-gated-close -->",
          ),
        ],
        202: [],
      },
      logPath: paths.ghLogPath,
    });

    runApplyResult(paths, { proofDecision: "keep_open", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "skipped");
    assert.equal(report.actions[0].reason, "already closed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply leaves issue duplicate close behavior unchanged", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: false }),
        202: issue({ number: 202, title: "Rewrite config validation", pullRequest: true }),
      },
      pulls: {
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "Issue A is duplicated by PR B.")],
        202: [comment("bob", "PR B carries the fix.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "keep_open" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(
      ghCalls(paths.ghLogPath).some((call) => call.args[0] === "comment-body"),
      true,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply leaves current-main fixed closeout outside coverage proof", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      reason: "Already fixed on current main.",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
      },
      comments: {
        101: [comment("alice", "Current main already has the config validation fix.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "closure requires candidate_fix");
    assert.equal(fs.existsSync(paths.ghLogPath) && hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply executes dependent-first input in reviewed dependency order", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, [
      dependencyClose("#102", ["#101"]),
      dependencyClose("#101"),
    ]);
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Prerequisite", pullRequest: false }),
        102: issue({ number: 102, title: "Dependent", pullRequest: false }),
      },
      pulls: {},
      comments: { 101: [], 102: [] },
      logPath: paths.ghLogPath,
    });

    runApplyResult(paths, { proofDecision: "covered" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.deepEqual(
      report.actions.map((action: Record<string, unknown>) => [action.target, action.status]),
      [
        ["#101", "executed"],
        ["#102", "executed"],
      ],
    );
    assert.deepEqual(issueCloseTargets(paths.ghLogPath), ["101", "102"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair second apply reuses a trusted first-pass close for dependent closure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, [
      dependencyClose("#102", ["#101"]),
      dependencyClose("#101"),
    ]);
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({
          number: 101,
          title: "Prerequisite",
          pullRequest: false,
          state: "closed",
          updatedAt: "2026-05-25T00:05:00Z",
        }),
        102: issue({ number: 102, title: "Dependent", pullRequest: false }),
      },
      pulls: {},
      comments: {
        101: [
          comment(
            "clawsweeper[bot]",
            "<!-- clawsweeper-repair:close:repair-pr-close-proof:#101:proof-gated-close -->",
          ),
        ],
        102: [],
      },
      logPath: paths.ghLogPath,
    });

    runApplyResult(paths, { proofDecision: "covered" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.deepEqual(
      report.actions.map((action: Record<string, unknown>) => [action.target, action.status]),
      [
        ["#101", "executed"],
        ["#102", "executed"],
      ],
    );
    assert.deepEqual(issueCloseTargets(paths.ghLogPath), ["102"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair second apply promotes a fix-first close after post-flight merge authorization", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      target_kind: "issue",
      status: "blocked",
      blocked_by: "fix_first",
      candidate_fix: "#202",
      reason: "blocked-by-fix-first until the canonical fix PR lands",
    });
    fs.writeFileSync(
      path.join(path.dirname(paths.resultPath), "post-flight-report.json"),
      JSON.stringify(
        {
          repo: "openclaw/openclaw",
          cluster_id: "repair-pr-close-proof",
          closure_authorization: {
            version: 1,
            status: "authorized",
            merged_fixes: [
              {
                fix_ref: "#202",
                merge_commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Fixed issue", pullRequest: false }),
      },
      pulls: {},
      comments: { 101: [] },
      logPath: paths.ghLogPath,
    });

    runApplyResult(paths, { proofDecision: "covered" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.deepEqual(report.closure_promotions, [
      {
        target: "#101",
        action: "close_fixed_by_candidate",
        source_status: "blocked",
        effective_status: "planned",
        candidate_fix: "#202",
        reason: "authorized by merged ClawSweeper Repair fix",
      },
    ]);
    assert.equal(report.actions[0].status, "executed");
    assert.deepEqual(issueCloseTargets(paths.ghLogPath), ["101"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair second apply does not infer fix-first authorization from prose", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      target_kind: "issue",
      status: "blocked",
      candidate_fix: "#202",
      reason: "blocked pending maintainer approval after fix PR #202 lands",
    });
    fs.writeFileSync(
      path.join(path.dirname(paths.resultPath), "post-flight-report.json"),
      JSON.stringify(
        {
          repo: "openclaw/openclaw",
          cluster_id: "repair-pr-close-proof",
          closure_authorization: {
            version: 1,
            status: "authorized",
            merged_fixes: [
              {
                fix_ref: "#202",
                merge_commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Approval-gated issue", pullRequest: false }),
      },
      pulls: {},
      comments: { 101: [] },
      logPath: paths.ghLogPath,
    });

    runApplyResult(paths, { proofDecision: "covered" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.closure_promotions, undefined);
    assert.equal(report.actions[0].status, "skipped");
    assert.equal(report.actions[0].source_status, "blocked");
    assert.equal(fs.existsSync(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const prerequisite of [
  { name: "blocked", omitTargetUpdatedAt: true, state: "open", expectedStatus: "blocked" },
  { name: "skipped", omitTargetUpdatedAt: false, state: "closed", expectedStatus: "skipped" },
]) {
  test(`repair apply blocks dependents when a prerequisite is ${prerequisite.name}`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
    try {
      const paths = writeApplyFixture(tmp, [
        dependencyClose("#102", ["#101"]),
        dependencyClose("#101", undefined, prerequisite.omitTargetUpdatedAt),
      ]);
      writeFakeGh(paths.binDir, {
        issues: {
          101: issue({
            number: 101,
            title: "Prerequisite",
            pullRequest: false,
            state: prerequisite.state,
          }),
          102: issue({ number: 102, title: "Dependent", pullRequest: false }),
        },
        pulls: {},
        comments: { 101: [], 102: [] },
        logPath: paths.ghLogPath,
      });

      runApplyResult(paths, { proofDecision: "covered" });

      const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
      assert.equal(report.actions[0].target, "#101");
      assert.equal(report.actions[0].status, prerequisite.expectedStatus);
      assert.equal(report.actions[1].target, "#102");
      assert.equal(report.actions[1].status, "blocked");
      assert.equal(
        report.actions[1].reason,
        `closure prerequisites did not close successfully: #101 (${prerequisite.expectedStatus})`,
      );
      assert.deepEqual(report.actions[1].dependency_outcomes, [
        { target: "#101", status: prerequisite.expectedStatus },
      ]);
      assert.deepEqual(issueCloseTargets(paths.ghLogPath), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

type ApplyFixturePaths = {
  binDir: string;
  jobPath: string;
  resultPath: string;
  reportPath: string;
  ghLogPath: string;
};

type ApplyFixtureAction = {
  action: string;
  classification: string;
  target?: string;
  target_kind?: "issue" | "pull_request";
  status?: string;
  blocked_by?: "fix_first";
  canonical?: string;
  duplicate_of?: string;
  candidate_fix?: string;
  fixed_by?: string;
  fix_candidate?: string;
  depends_on?: string[] | null;
  idempotency_key?: string;
  reason?: string;
  omitTargetUpdatedAt?: boolean;
};

type FakeGhData = {
  issues: Record<number, Record<string, unknown>>;
  pulls: Record<number, Record<string, unknown>>;
  comments: Record<number, Record<string, unknown>[]>;
  omitIssueCommentCounts?: number[];
  prViewFailure?: { number: number; message: string };
  afterProofPath?: string;
  postProofIssues?: Record<number, Record<string, unknown>>;
  postProofIssueUpdates?: Record<number, string>;
  postProofPulls?: Record<number, Record<string, unknown>>;
  postProofPrViewFailure?: { number: number; message: string };
  logPath: string;
};

function writeApplyFixture(
  tmp: string,
  actionInput: ApplyFixtureAction | ApplyFixtureAction[],
): ApplyFixturePaths {
  const binDir = path.join(tmp, "bin");
  const runDir = path.join(tmp, "run");
  const jobPath = path.join(tmp, "job.md");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "apply-report.json");
  const ghLogPath = path.join(tmp, "gh.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const actions = Array.isArray(actionInput) ? actionInput : [actionInput];
  const candidateRefs = [...new Set(["#101", ...actions.map((action) => action.target ?? "#101")])];
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: repair-pr-close-proof",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - close",
      "canonical:",
      "  - '#100'",
      "  - '#202'",
      "  - '#303'",
      "candidates:",
      ...candidateRefs.map((ref) => `  - '${ref}'`),
      "maintainer_close_refs:",
      ...candidateRefs.map((ref) => `  - '${ref}'`),
      "cluster_refs:",
      ...candidateRefs.map((ref) => `  - '${ref}'`),
      "  - '#100'",
      "  - '#202'",
      "  - '#303'",
      "allow_instant_close: true",
      "allow_post_merge_close: true",
      "allow_unmerged_fix_close: true",
      "require_fix_before_close: false",
      "---",
      "Repair job.",
      "",
    ].join("\n"),
  );
  const resultActions = actions.map((action) => {
    const resultAction = { ...action };
    const omitTargetUpdatedAt = resultAction.omitTargetUpdatedAt === true;
    delete resultAction.omitTargetUpdatedAt;
    return {
      ...resultAction,
      target: resultAction.target ?? "#101",
      target_kind: resultAction.target_kind ?? "pull_request",
      ...(omitTargetUpdatedAt ? {} : { target_updated_at: "2026-05-25T00:00:00Z" }),
      status: resultAction.status ?? "planned",
      evidence: ["PR B is referenced as the canonical replacement for PR A."],
      idempotency_key:
        resultAction.idempotency_key ??
        ((resultAction.target ?? "#101") === "#101"
          ? "proof-gated-close"
          : `proof-gated-close:${resultAction.target}`),
      comment: "Thanks for the work here. PR B is the canonical repair path.",
    };
  });
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "repair-pr-close-proof",
        mode: "autonomous",
        actions: resultActions,
      },
      null,
      2,
    ),
  );
  return { binDir, jobPath, resultPath, reportPath, ghLogPath };
}

function dependencyClose(
  target: string,
  dependsOn?: string[],
  omitTargetUpdatedAt = false,
): ApplyFixtureAction {
  return {
    action: "close_duplicate",
    classification: "duplicate",
    target,
    target_kind: "issue",
    canonical: "#100",
    depends_on: dependsOn ?? null,
    omitTargetUpdatedAt,
  };
}

function runApplyResult(
  paths: ApplyFixturePaths,
  options: {
    proofDecision: "covered" | "keep_open";
    expectedPromptIncludes?: string;
    unexpectedPromptIncludes?: string;
    failIfProofRuns?: boolean;
    proofFailureMessage?: string;
    afterProofPath?: string;
    allowMissingUpdatedAt?: boolean;
  },
) {
  const args = ["dist/repair/apply-result.js", paths.jobPath, paths.resultPath];
  if (options.allowMissingUpdatedAt) args.push("--allow-missing-updated-at");
  execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAWSWEEPER_ALLOW_EXECUTE: "1",
      CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
      CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
      CLAWSWEEPER_MODEL: "model-test",
      // Coverage instrumentation plus the parallel repair suite can delay this child process.
      // Keep the bound short for a fake binary without making CI depend on a 10-second scheduler window.
      CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_TIMEOUT_MS: "30000",
      GH_TOKEN: "write-token",
      ...mockGhBinEnv(path.join(paths.binDir, "gh.js")),
      PATH: `${paths.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PR_CLOSE_COVERAGE_PROOF_DECISION: options.proofDecision,
      PR_CLOSE_COVERAGE_PROOF_EXPECT_PROMPT: options.expectedPromptIncludes ?? "",
      PR_CLOSE_COVERAGE_PROOF_UNEXPECTED_PROMPT: options.unexpectedPromptIncludes ?? "",
      PR_CLOSE_COVERAGE_PROOF_FAIL_IF_INVOKED: options.failIfProofRuns ? "1" : "",
      PR_CLOSE_COVERAGE_PROOF_FAILURE_MESSAGE: options.proofFailureMessage ?? "",
      PR_CLOSE_COVERAGE_PROOF_AFTER_PROOF_PATH: options.afterProofPath ?? "",
    },
    stdio: "pipe",
  });
}

function writeFakeGh(binDir: string, data: FakeGhData) {
  fs.writeFileSync(
    path.join(binDir, "gh.js"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const data = ${JSON.stringify(data)};
fs.appendFileSync(data.logPath, JSON.stringify({ args }) + "\\n");
const includeHeaders = args[0] === "api" && args[1] === "-i";

function write(value) {
  process.stdout.write(JSON.stringify(value));
}

function writeWithHeaders(value, headers = []) {
  process.stdout.write(["HTTP/2 200", ...headers, "", JSON.stringify(value)].join("\\r\\n"));
}

if (args[0] === "api") {
  const apiPath = includeHeaders ? args[2] || "" : args[1] || "";
  const url = new URL(apiPath, "https://api.github.test/");
  let match = url.pathname.match(/\\/issues\\/(\\d+)\\/comments$/);
  if (match) {
    const number = Number(match[1]);
    if (args.includes("--method") && args.includes("POST")) {
      const input = args[args.indexOf("--input") + 1];
      const body = JSON.parse(fs.readFileSync(input, "utf8")).body;
      fs.appendFileSync(data.logPath, JSON.stringify({ args: ["comment-body", String(body)] }) + "\\n");
      write({ id: 9000 + number, body });
    } else if (args.includes("--slurp")) {
      write([data.comments[number] || []]);
    } else {
      const comments = data.comments[number] || [];
      const perPage = Number(url.searchParams.get("per_page") || comments.length || 100);
      const page = Number(url.searchParams.get("page") || "1");
      const start = Math.max(0, page - 1) * perPage;
      const pageComments = comments.slice(start, start + perPage);
      if (includeHeaders) {
        const lastPage = Math.max(1, Math.ceil(comments.length / Math.max(1, perPage)));
        const links = [];
        if (page < lastPage) {
          const next = new URL(url.toString());
          next.searchParams.set("page", String(page + 1));
          links.push("<" + next.toString() + ">; rel=\\"next\\"");
        }
        if (lastPage > 1) {
          const last = new URL(url.toString());
          last.searchParams.set("page", String(lastPage));
          links.push("<" + last.toString() + ">; rel=\\"last\\"");
        }
        writeWithHeaders(pageComments, links.length ? ["link: " + links.join(", ")] : []);
      } else {
        write(pageComments);
      }
    }
    process.exit(0);
  }
  match = url.pathname.match(/\\/issues\\/(\\d+)$/);
	if (match) {
	  const number = Number(match[1]);
	  const issue = data.issues[number];
	  if (!issue) {
	    process.stderr.write("issue not found: #" + match[1] + "\\n");
	    process.exit(1);
	  }
		  const postProofUpdatedAt =
		    data.afterProofPath &&
		    fs.existsSync(data.afterProofPath) &&
		    data.postProofIssueUpdates &&
		    data.postProofIssueUpdates[number];
		  const postProofIssue =
		    data.afterProofPath &&
		    fs.existsSync(data.afterProofPath) &&
		    data.postProofIssues &&
		    data.postProofIssues[number];
		  write({
		    ...issue,
		    ...(postProofIssue ? postProofIssue : {}),
		    ...(postProofUpdatedAt ? { updated_at: postProofUpdatedAt } : {}),
		    ...((data.omitIssueCommentCounts || []).includes(number)
		      ? {}
		      : { comments: data.comments[number]?.length || 0 }),
		  });
	  process.exit(0);
	}
  match = url.pathname.match(/\\/pulls\\/(\\d+)$/);
  if (match) {
    const number = Number(match[1]);
    const pull = data.pulls[number];
    if (!pull) {
      process.stderr.write("pull not found: #" + match[1] + "\\n");
      process.exit(1);
    }
    const postProofPull =
      data.afterProofPath &&
      fs.existsSync(data.afterProofPath) &&
      data.postProofPulls &&
      data.postProofPulls[number];
    write({
      ...pull,
      ...(postProofPull ? postProofPull : {}),
    });
    process.exit(0);
  }
  if (args[1] === "graphql") {
    write({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
    process.exit(0);
  }
}

if (args[0] === "pr" && args[1] === "close") {
  write({ closed: Number(args[2]) });
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const number = Number(args[2]);
  const postProofPrViewFailure =
    data.afterProofPath &&
    fs.existsSync(data.afterProofPath) &&
    data.postProofPrViewFailure &&
    data.postProofPrViewFailure.number === number;
  const prViewFailure =
    postProofPrViewFailure ? data.postProofPrViewFailure : data.prViewFailure;
  if (prViewFailure && prViewFailure.number === number) {
    process.stderr.write(prViewFailure.message + "\\n");
    process.exit(1);
  }
  const pull = data.pulls[number];
  write({
    baseRefName: "main",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeCommit: { oid: "abc123" },
    mergeStateStatus: "CLEAN",
    mergedAt: pull.merged_at || null,
    reviewDecision: null,
    state: String(pull.state || "open").toUpperCase(),
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    title: pull.title,
    updatedAt: pull.updated_at,
    url: pull.html_url,
  });
  process.exit(0);
}

process.stderr.write("unexpected gh args: " + JSON.stringify(args) + "\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );
}

function writeFakeCodex(binDir: string) {
  fs.writeFileSync(
    path.join(binDir, "codex"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex === -1) process.exit(2);
if (process.env.PR_CLOSE_COVERAGE_PROOF_FAIL_IF_INVOKED === "1") {
  process.stderr.write("coverage proof should not run");
  process.exit(1);
}
const prompt = fs.readFileSync(0, "utf8");
if (!prompt.includes("PR A repair close action report")) {
  process.stderr.write("missing target-specific repair source report");
  process.exit(1);
}
if (prompt.includes("Repair job.")) {
  process.stderr.write("repair job text leaked into source report");
  process.exit(1);
}
const decision = process.env.PR_CLOSE_COVERAGE_PROOF_DECISION;
const expectedPrompt = process.env.PR_CLOSE_COVERAGE_PROOF_EXPECT_PROMPT || "";
if (expectedPrompt && !prompt.includes(expectedPrompt)) {
  process.stderr.write("missing expected proof prompt text: " + expectedPrompt);
  process.exit(1);
}
const unexpectedPrompt = process.env.PR_CLOSE_COVERAGE_PROOF_UNEXPECTED_PROMPT || "";
if (unexpectedPrompt && prompt.includes(unexpectedPrompt)) {
  process.stderr.write("unexpected proof prompt text: " + unexpectedPrompt);
  process.exit(1);
}
if (process.env.GH_TOKEN === "write-token") {
  process.stderr.write("write token leaked into proof subprocess");
  process.exit(1);
}
	const failureMessage = process.env.PR_CLOSE_COVERAGE_PROOF_FAILURE_MESSAGE || "";
	if (failureMessage) {
	  process.stderr.write(failureMessage);
	  process.exit(1);
	}
	const afterProofPath = process.env.PR_CLOSE_COVERAGE_PROOF_AFTER_PROOF_PATH || "";
	if (afterProofPath) fs.writeFileSync(afterProofPath, "proof ran");
	const covered = decision === "covered";
fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({
  sourceSummary: "PR A preserves legacy config behavior.",
  coveringSummary: "PR B rewrites parser setup.",
  coveredWork: covered ? ["Legacy config validation behavior"] : [],
  uniqueSourceWork: covered ? [] : ["Legacy config validation behavior"],
  decision,
  reason: covered
    ? "PR B carries forward the legacy behavior."
    : "PR B does not carry forward the legacy behavior."
}));
`,
    { mode: 0o755 },
  );
}

function issue(options: {
  number: number;
  title: string;
  pullRequest: boolean;
  state?: string;
  updatedAt?: string;
  labels?: string[];
}) {
  return {
    number: options.number,
    title: options.title,
    html_url: `https://github.com/openclaw/openclaw/pull/${options.number}`,
    state: options.state ?? "open",
    updated_at: options.updatedAt ?? "2026-05-25T00:00:00Z",
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: (options.labels ?? []).map((name) => ({ name })),
    pull_request: options.pullRequest ? {} : null,
  };
}

function pull(options: { number: number; title: string; mergedAt?: string }) {
  return {
    number: options.number,
    title: options.title,
    html_url: `https://github.com/openclaw/openclaw/pull/${options.number}`,
    url: `https://github.com/openclaw/openclaw/pull/${options.number}`,
    state: options.mergedAt ? "closed" : "open",
    merged_at: options.mergedAt ?? null,
    body: `${options.title} body.`,
    updated_at: "2026-05-25T00:00:00Z",
  };
}

function comment(author: string, body: string) {
  return {
    user: { login: author },
    author_association: "CONTRIBUTOR",
    created_at: "2026-05-24T00:00:00Z",
    updated_at: "2026-05-24T00:00:00Z",
    body,
  };
}

function ghCalls(logPath: string): { args: string[] }[] {
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[] });
}

function hasPrCloseCall(logPath: string): boolean {
  return ghCalls(logPath).some((call) => call.args[0] === "pr" && call.args[1] === "close");
}

function issueCloseTargets(logPath: string): string[] {
  return ghCalls(logPath)
    .filter(
      (call) =>
        call.args[0] === "api" &&
        call.args.includes("PATCH") &&
        /\/issues\/\d+$/.test(call.args[1] ?? ""),
    )
    .map((call) => call.args[1]?.match(/\/issues\/(\d+)$/)?.[1] ?? "");
}
