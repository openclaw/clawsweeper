import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  applyRuntimeBudgetForTest,
  main,
  referencingMergedPullRequestsForIssueForTest,
} from "../dist/clawsweeper.js";
import {
  implementedCloseReport,
  lowSignalCloseReport,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockCodexProof,
  withMockGh,
} from "./helpers.ts";

function runtimeBudgetFixture(number: number) {
  const root = mkdtempSync(tmpPrefix);
  const itemsDir = join(root, "items");
  const closedDir = join(root, "closed");
  const plansDir = join(root, "plans");
  const reportPath = join(root, "apply-report.json");
  const cursorTracePath = join(root, "apply-cursor-trace.json");
  mkdirSync(itemsDir, { recursive: true });
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(itemsDir, `${number}.md`), implementedCloseReport({ number }), "utf8");
  return { root, itemsDir, closedDir, plansDir, reportPath, cursorTracePath };
}

function assertRuntimeYield(
  fixture: ReturnType<typeof runtimeBudgetFixture>,
  maxRuntimeMs: number,
) {
  const report = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
  const cursorTrace = JSON.parse(readFileSync(fixture.cursorTracePath, "utf8"));
  assert.deepEqual(report, [
    {
      number: 0,
      action: "skipped_runtime_budget",
      reason: report[0]?.reason,
    },
  ]);
  assert.match(report[0]?.reason ?? "", new RegExp(`max runtime ${maxRuntimeMs}ms reached`));
  assert.deepEqual(cursorTrace, { schema_version: 1, examined_item_numbers: [] });
}

test("apply runtime budget uses the token deadline as an absolute wall clock", () => {
  const nowMs = 1_000_000;
  assert.deepEqual(
    applyRuntimeBudgetForTest({
      configuredMaxRuntimeMs: 0,
      tokenDeadlineMs: nowMs + 55_000,
      nowMs,
    }),
    {
      startedAtMs: nowMs,
      maxRuntimeMs: 55_000,
      limitReason: `apply token budget reached at ${nowMs + 55_000}ms since epoch`,
    },
  );
  assert.deepEqual(
    applyRuntimeBudgetForTest({
      configuredMaxRuntimeMs: 10_000,
      tokenDeadlineMs: nowMs + 55_000,
      nowMs,
    }),
    { startedAtMs: nowMs, maxRuntimeMs: 10_000 },
  );
  assert.deepEqual(
    applyRuntimeBudgetForTest({
      configuredMaxRuntimeMs: 10_000,
      tokenDeadlineMs: nowMs - 1,
      nowMs,
    }),
    {
      startedAtMs: nowMs - 1,
      maxRuntimeMs: 1,
      limitReason: `apply token budget reached at ${nowMs - 1}ms since epoch`,
    },
  );
});

test("apply-decisions exits cleanly at an expired token deadline and retries the same item", () => {
  const fixture = runtimeBudgetFixture(728);
  const invocationLog = join(fixture.root, "gh-invocations.log");
  const originalDeadline = process.env.CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS;
  try {
    withMockGh(
      fixture.root,
      `
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(invocationLog)}, "attempted\\n");
setTimeout(() => {}, 10_000);
`,
      () => {
        process.env.CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS = String(Date.now() - 1);
        runApplyDecisionsForTest({
          ...fixture,
          extraArgs: ["--cursor-trace", fixture.cursorTracePath],
        });
        const stoppedReport = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
        assert.deepEqual(
          stoppedReport.map((entry: { number: number; action: string }) => [
            entry.number,
            entry.action,
          ]),
          [[0, "skipped_runtime_budget"]],
        );
        assert.match(stoppedReport[0]?.reason ?? "", /^apply token budget reached/);
        assert.deepEqual(JSON.parse(readFileSync(fixture.cursorTracePath, "utf8")), {
          schema_version: 1,
          examined_item_numbers: [],
        });
        assert.equal(existsSync(invocationLog), false, "expired token attempted a GitHub call");
        assert.equal(existsSync(join(fixture.itemsDir, "728.md")), true);

        process.env.CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS = String(Date.now() + 30_000);
        runApplyDecisionsForTest({
          ...fixture,
          extraArgs: ["--max-runtime-ms", "2200", "--cursor-trace", fixture.cursorTracePath],
        });
        assert.match(readFileSync(invocationLog, "utf8"), /attempted/);
        assertRuntimeYield(fixture, 2_200);
        assert.equal(existsSync(join(fixture.itemsDir, "728.md")), true);
      },
    );
  } finally {
    if (originalDeadline === undefined) delete process.env.CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS;
    else process.env.CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS = originalDeadline;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("apply-decisions bounds a hung GitHub command and writes a resumable runtime yield", () => {
  const fixture = runtimeBudgetFixture(721);
  const maxRuntimeMs = 2_200;
  try {
    const startedAt = Date.now();
    withMockGh(fixture.root, "setTimeout(() => {}, 10_000);", () => {
      runApplyDecisionsForTest({
        ...fixture,
        extraArgs: [
          "--max-runtime-ms",
          String(maxRuntimeMs),
          "--cursor-trace",
          fixture.cursorTracePath,
        ],
      });
    });

    assert.ok(Date.now() - startedAt < 4_000, "hung gh command exceeded the apply runtime bound");
    assertRuntimeYield(fixture, maxRuntimeMs);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent apply invocations do not leak a runtime budget", async () => {
  const root = mkdtempSync(tmpPrefix);
  const binDir = join(root, "bin");
  const ghMock = join(binDir, "gh.js");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(ghMock, "process.stdout.write(JSON.stringify({ items: [] }));\n", "utf8");
  const originalGhBin = process.env.GH_BIN;
  const originalGhBinArgs = process.env.GH_BIN_ARGS;
  const originalSearch = process.env.CLAWSWEEPER_REFERENCING_PR_SEARCH;
  process.env.GH_BIN = process.execPath;
  process.env.GH_BIN_ARGS = JSON.stringify([ghMock]);
  process.env.CLAWSWEEPER_REFERENCING_PR_SEARCH = "true";
  try {
    const base = [
      "apply-decisions",
      "--target-repo",
      "openclaw/openclaw",
      "--max-runtime-ms",
      "1",
      "--limit",
      "1",
    ];
    await Promise.all([
      main([
        ...base,
        "--items-dir",
        join(root, "missing-a"),
        "--report-path",
        join(root, "a.json"),
      ]),
      main([
        ...base,
        "--items-dir",
        join(root, "missing-b"),
        "--report-path",
        join(root, "b.json"),
      ]),
    ]);
    assert.deepEqual(referencingMergedPullRequestsForIssueForTest(1), []);
  } finally {
    if (originalGhBin === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = originalGhBin;
    if (originalGhBinArgs === undefined) delete process.env.GH_BIN_ARGS;
    else process.env.GH_BIN_ARGS = originalGhBinArgs;
    if (originalSearch === undefined) delete process.env.CLAWSWEEPER_REFERENCING_PR_SEARCH;
    else process.env.CLAWSWEEPER_REFERENCING_PR_SEARCH = originalSearch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions yields instead of starting a GitHub retry that cannot fit", () => {
  const fixture = runtimeBudgetFixture(722);
  const maxRuntimeMs = 2_500;
  try {
    const startedAt = Date.now();
    withMockGh(fixture.root, 'console.error("service unavailable"); process.exit(1);', () => {
      runApplyDecisionsForTest({
        ...fixture,
        extraArgs: [
          "--max-runtime-ms",
          String(maxRuntimeMs),
          "--cursor-trace",
          fixture.cursorTracePath,
        ],
      });
    });

    assert.ok(
      Date.now() - startedAt < maxRuntimeMs + 500,
      "GitHub retry sleep ignored the remaining runtime",
    );
    assertRuntimeYield(fixture, maxRuntimeMs);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("apply-decisions yields instead of retrying malformed GitHub JSON past the deadline", () => {
  const fixture = runtimeBudgetFixture(726);
  const maxRuntimeMs = 2_500;
  try {
    const startedAt = Date.now();
    withMockGh(fixture.root, 'process.stdout.write("{");', () => {
      runApplyDecisionsForTest({
        ...fixture,
        extraArgs: [
          "--max-runtime-ms",
          String(maxRuntimeMs),
          "--cursor-trace",
          fixture.cursorTracePath,
        ],
      });
    });

    assert.ok(
      Date.now() - startedAt < maxRuntimeMs + 500,
      "malformed JSON retry ignored the runtime bound",
    );
    assertRuntimeYield(fixture, maxRuntimeMs);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("apply-decisions preserves a runtime yield through post-proof freshness handling", () => {
  const fixture = runtimeBudgetFixture(723);
  const maxRuntimeMs = 3_000;
  const proofLogPath = join(fixture.root, "proof.log");
  const synced = reportWithSyncedReviewComment(
    lowSignalCloseReport({
      number: 723,
      title: "Provider route fallback",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
    ),
    723,
    "duplicate_or_superseded",
  );
  writeFileSync(join(fixture.itemsDir, "723.md"), synced.report, "utf8");
  try {
    withMockGh(
      fixture.root,
      promotionGhMock({
        number: 723,
        title: "Provider route fallback",
        comment: synced.comment,
        itemUpdatedAtAfterProofLogPath: proofLogPath,
        linkedPullHangAfterProof: true,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
            body: "Includes the fallback route behavior from PR 723.",
            comments: [],
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          fixture.root,
          {
            type: "decision",
            decision: "covered",
            reason: "PR B carries forward PR A's fallback route behavior.",
            invocationLogPath: proofLogPath,
          },
          () => {
            runApplyDecisionsForTest({
              ...fixture,
              targetRepo: "openclaw/openclaw",
              extraArgs: [
                "--apply-kind",
                "all",
                "--max-runtime-ms",
                String(maxRuntimeMs),
                "--cursor-trace",
                fixture.cursorTracePath,
              ],
            });
          },
        );
      },
    );

    assertRuntimeYield(fixture, maxRuntimeMs);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("apply-decisions preserves a runtime yield from a bounded one-shot GitHub search", () => {
  const fixture = runtimeBudgetFixture(724);
  const maxRuntimeMs = 3_000;
  const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] === "-i" ? args[2] || "" : args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/724\\/timeline(?:\\?|$)/.test(path)) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/724\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/724$/.test(path)) {
  console.log(JSON.stringify({
    number: 724,
    title: "Bound one-shot search",
    html_url: "https://github.com/openclaw/clawsweeper/issues/724",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  setTimeout(() => {}, 60_000);
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
  try {
    withMockGh(fixture.root, ghMock, () => {
      runApplyDecisionsForTest({
        ...fixture,
        extraArgs: [
          "--max-runtime-ms",
          String(maxRuntimeMs),
          "--cursor-trace",
          fixture.cursorTracePath,
        ],
      });
    });

    assertRuntimeYield(fixture, maxRuntimeMs);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("apply-decisions yields instead of starting a post-close delay that cannot fit", () => {
  const fixture = runtimeBudgetFixture(725);
  const maxRuntimeMs = 15_000;
  const proofLogPath = join(fixture.root, "proof.log");
  const clockHookPath = join(fixture.root, "runtime-clock.cjs");
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const synced = reportWithSyncedReviewComment(
    lowSignalCloseReport({
      number: 725,
      title: "Provider route fallback",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
    ),
    725,
    "duplicate_or_superseded",
  );
  writeFileSync(join(fixture.itemsDir, "725.md"), synced.report, "utf8");
  writeFileSync(clockHookPath, `Date.now = () => ${Date.now()};\n`, "utf8");
  process.env.NODE_OPTIONS = [originalNodeOptions, `--require=${JSON.stringify(clockHookPath)}`]
    .filter(Boolean)
    .join(" ");
  try {
    const startedAt = Date.now();
    withMockGh(
      fixture.root,
      promotionGhMock({
        number: 725,
        title: "Provider route fallback",
        comment: synced.comment,
        itemUpdatedAtAfterProofLogPath: proofLogPath,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
            body: "Includes the fallback route behavior from PR 725.",
            comments: [],
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          fixture.root,
          {
            type: "decision",
            decision: "covered",
            reason: "PR B carries forward PR A's fallback route behavior.",
            invocationLogPath: proofLogPath,
          },
          () => {
            runApplyDecisionsForTest({
              ...fixture,
              targetRepo: "openclaw/openclaw",
              extraArgs: [
                "--apply-kind",
                "all",
                "--max-runtime-ms",
                String(maxRuntimeMs),
                "--close-delay-ms",
                "30000",
                "--cursor-trace",
                fixture.cursorTracePath,
              ],
            });
          },
        );
      },
    );

    assert.ok(
      Date.now() - startedAt < maxRuntimeMs + 2_000,
      "post-close delay ignored the remaining runtime",
    );
    assertRuntimeYield(fixture, maxRuntimeMs);
    const report = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
    assert.match(report[0]?.reason ?? "", /before close$/);
  } finally {
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("apply-decisions records a successful close before yielding after it", () => {
  const fixture = runtimeBudgetFixture(727);
  const maxRuntimeMs = 25_000;
  const closeDelayMs = 8_000;
  const proofLogPath = join(fixture.root, "proof.log");
  const closeCommandLogPath = join(fixture.root, "close-command.log");
  const clockHookPath = join(fixture.root, "runtime-clock.cjs");
  const startedAtMs = Date.now();
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const synced = reportWithSyncedReviewComment(
    lowSignalCloseReport({
      number: 727,
      title: "Provider route fallback",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
    ),
    727,
    "duplicate_or_superseded",
  );
  writeFileSync(join(fixture.itemsDir, "727.md"), synced.report, "utf8");
  writeFileSync(
    clockHookPath,
    `const { existsSync } = require("node:fs");
Date.now = () => existsSync(${JSON.stringify(closeCommandLogPath)})
  ? ${startedAtMs + maxRuntimeMs - closeDelayMs}
  : ${startedAtMs};
`,
    "utf8",
  );
  process.env.NODE_OPTIONS = [originalNodeOptions, `--require=${JSON.stringify(clockHookPath)}`]
    .filter(Boolean)
    .join(" ");
  try {
    withMockGh(
      fixture.root,
      promotionGhMock({
        number: 727,
        title: "Provider route fallback",
        comment: synced.comment,
        closeCommandLogPath,
        itemUpdatedAtAfterProofLogPath: proofLogPath,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
            body: "Includes the fallback route behavior from PR 727.",
            comments: [],
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          fixture.root,
          {
            type: "decision",
            decision: "covered",
            reason: "PR B carries forward PR A's fallback route behavior.",
            invocationLogPath: proofLogPath,
          },
          () => {
            runApplyDecisionsForTest({
              ...fixture,
              targetRepo: "openclaw/openclaw",
              extraArgs: [
                "--apply-kind",
                "all",
                "--max-runtime-ms",
                String(maxRuntimeMs),
                "--close-delay-ms",
                String(closeDelayMs),
                "--cursor-trace",
                fixture.cursorTracePath,
              ],
            });
          },
        );
      },
    );

    assert.match(readFileSync(closeCommandLogPath, "utf8"), /pr close 727/);
    const report = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
    const cursorTrace = JSON.parse(readFileSync(fixture.cursorTracePath, "utf8"));
    assert.deepEqual(
      report.map((entry: { number: number; action: string }) => [entry.number, entry.action]),
      [
        [727, "closed"],
        [0, "skipped_runtime_budget"],
      ],
    );
    assert.deepEqual(cursorTrace, { schema_version: 1, examined_item_numbers: [727] });
    assert.equal(existsSync(join(fixture.closedDir, "727.md")), true);
  } finally {
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
