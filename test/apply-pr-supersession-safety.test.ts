import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { linkedPullRequestSupersession } from "../dist/clawsweeper-promotion-facts.js";
import { createPullRequestClosePromotion } from "../dist/clawsweeper-close-promotion.js";
import { createApplyGuards } from "../dist/clawsweeper-apply-guards.js";
import { LiveReadGeneration } from "../dist/live-read-generation.js";
import { ghJson } from "../dist/clawsweeper-github-execution.js";
import { ghPaged } from "../dist/clawsweeper-github-context.js";
import {
  repositoryProfileFor,
  targetRepo,
  withTargetProfile,
} from "../dist/repository-profiles.js";
import { githubTest, installGhFixture } from "./github-runtime-fixture.ts";
import { reportFileName } from "../dist/clawsweeper-repository-paths.js";

import {
  canonicalPullRequestClusterForTest,
  item,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  runOpenClawApplyDecisionsForTest,
  stalePullRequestReport,
  stripProofAndRatingFrontMatter,
  tmpPrefix,
  withApplyTestWorkspace,
  withMockCodexProof,
  withMockGh,
  withReviewRecord,
} from "./helpers.ts";
for (const repo of ["openclaw/openclaw", "openclaw/clawhub"]) {
  githubTest(
    `head activity reads preserve source matching and timeline ownership for ${repo}`,
    (t) => {
      const fixture = installGhFixture(
        t,
        `
const path = args[1];
if (path.split("?")[0].endsWith("/issues/333/timeline")) {
  const events = [
    { event: "head_ref_force_pushed", commit_id: "head333", created_at: "2026-02-03T00:00:00Z" },
    { event: "head_ref_force_pushed", commit_id: "other", created_at: "2026-03-01T00:00:00Z" }
  ];
  console.log(JSON.stringify(args.includes("--slurp") ? [events] : events));
} else if (path.includes("/actions/runs?head_sha=head333&event=pull_request&per_page=100")) {
  console.log(JSON.stringify({ workflow_runs: [
    { event: "pull_request", pull_requests: [{ number: 333 }], created_at: "2026-02-01T00:00:00Z" },
    { event: "pull_request", head_branch: "feature", head_repository: { id: 500 }, created_at: "2026-02-02T00:00:00Z" },
    { event: "pull_request", head_branch: "feature", head_repository: { id: 501 }, created_at: "2026-02-10T00:00:00Z" },
    { event: "pull_request", head_branch: "feature", head_repository: { id: 500 }, created_at: "2025-12-31T00:00:00Z" },
    { event: "push", pull_requests: [{ number: 333 }], created_at: "2026-03-05T00:00:00Z" }
  ] }));
} else if (path.endsWith("/pulls/333")) {
  console.log(JSON.stringify({
    created_at: "2026-01-01T00:00:00Z",
    mergeable: false,
    mergeable_state: "dirty",
    user: { login: "reporter" },
    head: { sha: "head333", ref: "feature", repo: { id: 500 } }
  }));
} else if (path.endsWith("/issues/333")) {
  console.log(JSON.stringify({ assignees: [] }));
} else if (path.split("?")[0].endsWith("/comments") || path.split("?")[0].endsWith("/reviews")) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
} else throw new Error("unexpected read " + args.join(" "));
`,
      );
      withTargetProfile(repositoryProfileFor(repo), () => {
        const guards = createApplyGuards({ ghJson, ghPaged, targetRepo });
        const { pullRequestHeadActivity } = guards;
        const pull = {
          created_at: "2026-01-01T00:00:00Z",
          head: { sha: "head333", ref: "feature", repo: { id: 500 } },
        };
        assert.deepEqual(pullRequestHeadActivity(333, pull), {
          headSha: "head333",
          headActivityAtMs: Date.parse("2026-02-03T00:00:00Z"),
        });
        assert.deepEqual(pullRequestHeadActivity(333, pull, []), {
          headSha: "head333",
          headActivityAtMs: Date.parse("2026-02-02T00:00:00Z"),
        });
        const count = fixture.requests().length;
        assert.deepEqual(pullRequestHeadActivity(333, {}, []), {
          headSha: "",
          headActivityAtMs: null,
        });
        assert.equal(fixture.requests().length, count, "empty heads make no workflow read");
        const paths = fixture.requests().map(({ args }) => args[1]);
        assert.ok(paths.includes(`repos/${repo}/issues/333/timeline?per_page=100`));
        assert.ok(
          paths.includes(
            `repos/${repo}/actions/runs?head_sha=head333&event=pull_request&per_page=100`,
          ),
        );
        assert.ok(paths.every((path) => path.startsWith(`repos/${repo}/`)));
        const { pullRequestClosePromotion } = createPullRequestClosePromotion(
          guards.pullRequestHeadActivity,
        );
        const sourceItem = item({
          repo,
          kind: "pull_request",
          number: 333,
          author: "reporter",
          createdAt: "2026-01-01T00:00:00Z",
        });
        const report = stalePullRequestReport({ repository: repo, number: 333 });
        const context = { issue: {}, comments: [], timeline: [], pullReviewComments: [] };
        const workflowReadCount = () =>
          fixture.requests().filter(({ args }) => args[1]?.includes("/actions/runs?")).length;
        for (const generation of [new LiveReadGeneration(), new LiveReadGeneration()]) {
          guards.setGuardReadGeneration(generation);
          const beforePromotion = workflowReadCount();
          assert.equal(
            pullRequestClosePromotion(report, sourceItem, context, 30)?.closeReason,
            "low_signal_unmergeable_pr",
          );
          assert.equal(
            workflowReadCount(),
            beforePromotion + 1,
            "a new generation reads head activity",
          );
          assert.equal(guards.lowSignalUnmergeablePrApplyBlockReasonSafe(333, 30), null);
          assert.equal(
            workflowReadCount(),
            beforePromotion + 1,
            "promotion and the final low-signal guard share the generation's head activity read",
          );
        }
      });
    },
  );
}

githubTest(
  "an unreadable canonical review blocks the stale low-signal promotion alternative",
  (t) => {
    installGhFixture(
      t,
      `
const path = args[1];
if (path.endsWith("/pulls/333")) {
  console.log(JSON.stringify({ created_at: "2026-01-01T00:00:00Z", mergeable: false, mergeable_state: "dirty", user: { login: "reporter" }, head: { sha: "head333" } }));
} else if (path.endsWith("/pulls/400")) {
  console.log(JSON.stringify({ number: 400, state: "open", mergeable_state: "clean", labels: ["proof: sufficient"] }));
} else if (path.includes("/actions/runs?")) {
  console.log(JSON.stringify({ workflow_runs: [{ event: "pull_request", pull_requests: [{number:333}], created_at:"2026-01-01T00:00:00Z" }] }));
} else if (path.split("?")[0].endsWith("/reviews")) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
} else {
  throw new Error("unexpected read " + args.join(" "));
}
`,
    );
    const guards = createApplyGuards({ ghJson, ghPaged, targetRepo });
    const { pullRequestClosePromotion } = createPullRequestClosePromotion(
      guards.pullRequestHeadActivity,
    );
    withApplyTestWorkspace(tmpPrefix, ({ itemsDir }) => {
      const source = stalePullRequestReport({
        number: 333,
        root_cause_cluster: canonicalPullRequestClusterForTest(
          "https://github.com/openclaw/openclaw/pull/400",
        ),
      });
      writeFileSync(
        join(itemsDir, reportFileName("openclaw/openclaw", 400)),
        withReviewRecord(stalePullRequestReport({ number: 400 })).replace(
          /^review_record: \{/m,
          "review_record: {broken",
        ),
        "utf8",
      );
      const sourceItem = item({
        kind: "pull_request",
        number: 333,
        author: "reporter",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const context = { issue: {}, comments: [], timeline: [], pullReviewComments: [] };
      assert.equal(
        pullRequestClosePromotion(stalePullRequestReport({ number: 333 }), sourceItem, context, 30)
          ?.closeReason,
        "low_signal_unmergeable_pr",
      );
      assert.deepEqual(
        linkedPullRequestSupersession(source, sourceItem, { reportDirs: [itemsDir] }),
        {
          candidate: null,
          unsafeReason:
            "linked canonical PR #400 has an unreadable review record; fresh review required",
        },
      );
      assert.equal(
        pullRequestClosePromotion(source, sourceItem, context, 30, {
          reportDirs: [itemsDir],
        }),
        null,
      );
    });
  },
);

for (const syncCommentsOnly of [false, true]) {
  for (const [name, mergedAt, reference, mergeableState] of [
    ["open replacement", null, "[replacement PR]", "clean"],
    ["behind replacement", null, "[replacement PR]", "behind"],
    ["merged replacement", "2026-05-02T00:00:00Z", "[replacement PR]", "clean"],
    ["related canonical work", "2026-05-02T00:00:00Z", "[Related canonical record work]", "clean"],
  ] as const) {
    test(`apply-decisions preserves keep-open review with ${name} (comments-only=${syncCommentsOnly})`, () => {
      const root = mkdtempSync(tmpPrefix);
      try {
        const itemsDir = join(root, "items");
        const closedDir = join(root, "closed");
        const plansDir = join(root, "plans");
        const reportPath = join(root, "apply-report.json");
        const proofLogPath = join(root, "proof.log");
        const closeLogPath = join(root, "close.log");
        mkdirSync(itemsDir, { recursive: true });
        const synced = reportWithSyncedReviewComment(
          stalePullRequestReport({
            number: 333,
            title: "Keep this distinct change open",
            pr_rating_overall: "D",
            pr_rating_proof: "D",
            pr_rating_patch: "D",
            work_cluster_refs: JSON.stringify([
              `${reference}(https://github.com/openclaw/openclaw/pull/400)`,
            ]),
          }).replaceAll("tier: F", "tier: D"),
          333,
          "none",
        );
        const itemPath = join(itemsDir, "333.md");
        writeFileSync(itemPath, synced.report, "utf8");
        withMockGh(
          root,
          promotionGhMock({
            number: 333,
            title: "Keep this distinct change open",
            comment: synced.comment,
            closeCommandLogPath: closeLogPath,
            linkedPulls: {
              400: {
                number: 400,
                title: "Related work",
                html_url: "https://github.com/openclaw/openclaw/pull/400",
                state: mergedAt ? "closed" : "open",
                merged_at: mergedAt,
                mergeable_state: mergeableState,
                labels: mergedAt ? [] : ["proof: sufficient"],
              },
            },
          }),
          () =>
            withMockCodexProof(
              root,
              {
                type: "failure",
                message: "keep-open must not start close coverage proof",
                invocationLogPath: proofLogPath,
              },
              () =>
                runApplyDecisionsForTest({
                  itemsDir,
                  closedDir,
                  plansDir,
                  reportPath,
                  extraArgs: [
                    "--target-repo",
                    "openclaw/openclaw",
                    "--skip-dashboard",
                    "--item-number",
                    "333",
                    "--apply-kind",
                    "all",
                    ...(syncCommentsOnly
                      ? ["--sync-comments-only", "--comment-sync-min-age-days", "0"]
                      : []),
                  ],
                }),
            ),
        );
        const persisted = readFileSync(itemPath, "utf8");
        assert.match(persisted, /^decision: keep_open$/m);
        assert.match(persisted, /^action_taken: kept_open$/m);
        assert.match(persisted, /^close_reason: none$/m);
        assert.doesNotMatch(
          persisted,
          /Close this PR as superseded|I’m closing this PR as superseded/,
        );
        const commentPath = join(root, "comment-state-333.json");
        const comment = existsSync(commentPath)
          ? JSON.parse(readFileSync(commentPath, "utf8")).body
          : synced.comment;
        assert.doesNotMatch(
          comment,
          /Close this PR as superseded|I’m closing this PR as superseded/,
        );
        assert.equal(existsSync(proofLogPath), false);
        assert.equal(existsSync(closeLogPath), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("apply-decisions does not promote PRs superseded by no-proof linked pull requests", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const proofLogPath = join(root, "proof.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(
      stalePullRequestReport({
        number: 334,
        title: "Old activity PR",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      334,
      "none",
    );
    writeFileSync(join(itemsDir, "334.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 334,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical activity PR without proof",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "failure",
            message: "proof should not run",
            invocationLogPath: proofLogPath,
          },
          () => {
            runApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath,
              extraArgs: [
                "--target-repo",
                "openclaw/openclaw",
                "--dry-run",
                "--apply-kind",
                "all",
                "--apply-close-reasons",
                "low_signal_unmergeable_pr",
                "--processed-limit",
                "3",
              ],
            });
          },
        );
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
    }>;
    assert.equal(report.length, 1);
    assert.equal(report[0]?.number, 334);
    // Refreshing review presentation does not promote the keep-open decision.
    assert.ok(
      ["kept_open", "review_comment_synced"].includes(report[0]?.action ?? ""),
      JSON.stringify(report),
    );
    const persisted = readFileSync(join(itemsDir, "334.md"), "utf8");
    assert.match(persisted, /^decision: keep_open$/m);
    assert.match(persisted, /^action_taken: kept_open$/m);
    assert.match(persisted, /^close_reason: none$/m);
    assert.equal(existsSync(proofLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote PRs superseded by unsafe linked pull requests", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const synced = reportWithSyncedReviewComment(
      stalePullRequestReport({
        number: 335,
        title: "Old activity PR",
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      335,
      "none",
    );
    writeFileSync(join(itemsDir, "335.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 335,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Unsafe canonical PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: ["triage: needs-real-behavior-proof", "status: 📣 needs proof"],
          },
        },
      }),
      () => {
        withMockCodexProof(root, { type: "failure", message: "proof should not run" }, () => {
          runOpenClawApplyDecisionsForTest({
            itemsDir,
            closedDir,
            plansDir,
            reportPath,
            dryRun: true,
          });
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(report), /proof should not run/);
  });
});

test("apply-decisions does not promote PRs superseded by F-rated linked pull requests", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const sourceReport = stalePullRequestReport({
      number: 338,
      title: "Old activity PR",
      labels: JSON.stringify([]),
      pr_rating_overall: "D",
      pr_rating_proof: "D",
      pr_rating_patch: "D",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    })
      .replace("Status: missing", "Status: sufficient")
      .replace(
        "Overall tier: F\nProof tier: F\nPatch tier: F",
        "Overall tier: D\nProof tier: D\nPatch tier: D",
      );
    const synced = reportWithSyncedReviewComment(sourceReport, 338, "none");
    writeFileSync(join(itemsDir, "338.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 338,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "F-rated canonical PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: ["proof: sufficient", "rating: unranked krab"],
          },
        },
      }),
      () => {
        withMockCodexProof(root, { type: "failure", message: "proof should not run" }, () => {
          runOpenClawApplyDecisionsForTest({
            itemsDir,
            closedDir,
            plansDir,
            reportPath,
            dryRun: true,
          });
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(report), /proof should not run/);
  });
});

test("apply-decisions does not promote PRs superseded by section-only unsafe linked reports", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = stalePullRequestReport({
      number: 340,
      title: "Old activity PR",
      labels: JSON.stringify([]),
      pr_rating_overall: "D",
      pr_rating_proof: "D",
      pr_rating_patch: "D",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    })
      .replace("Status: missing", "Status: sufficient")
      .replace(
        "Overall tier: F\nProof tier: F\nPatch tier: F",
        "Overall tier: D\nProof tier: D\nPatch tier: D",
      );
    const synced = reportWithSyncedReviewComment(sourceReport, 340, "none");
    writeFileSync(join(itemsDir, "340.md"), synced.report, "utf8");
    writeFileSync(
      join(itemsDir, "400.md"),
      stripProofAndRatingFrontMatter(
        stalePullRequestReport({
          number: 400,
          title: "Canonical PR with old section-only blockers",
          labels: JSON.stringify([]),
        }),
      ),
      "utf8",
    );

    withMockGh(
      root,
      promotionGhMock({
        number: 340,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical PR with old section-only blockers",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(root, { type: "failure", message: "proof should not run" }, () => {
          runApplyDecisionsForTest({
            itemsDir,
            closedDir,
            plansDir,
            reportPath,
            extraArgs: [
              "--target-repo",
              "openclaw/openclaw",
              "--dry-run",
              "--apply-kind",
              "all",
              "--item-numbers",
              "340",
              "--processed-limit",
              "3",
            ],
          });
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(report), /proof should not run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote PRs when live labels supersede stale proof reports", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = stalePullRequestReport({
      number: 344,
      title: "Old activity PR",
      labels: JSON.stringify([]),
      pr_rating_overall: "D",
      pr_rating_proof: "D",
      pr_rating_patch: "D",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    })
      .replace("Status: missing", "Status: sufficient")
      .replace(
        "Overall tier: F\nProof tier: F\nPatch tier: F",
        "Overall tier: D\nProof tier: D\nPatch tier: D",
      );
    const synced = reportWithSyncedReviewComment(sourceReport, 344, "none");
    writeFileSync(join(itemsDir, "344.md"), synced.report, "utf8");
    writeFileSync(
      join(itemsDir, "400.md"),
      stalePullRequestReport({
        number: 400,
        title: "Canonical PR with stale sufficient proof report",
        labels: JSON.stringify(["proof: sufficient"]),
        pr_rating_overall: "D",
        pr_rating_proof: "D",
        pr_rating_patch: "D",
      })
        .replace("Status: missing", "Status: sufficient")
        .replace(
          "Overall tier: F\nProof tier: F\nPatch tier: F",
          "Overall tier: D\nProof tier: D\nPatch tier: D",
        ),
      "utf8",
    );

    withMockGh(
      root,
      promotionGhMock({
        number: 344,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical PR with current needs-proof labels",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "clean",
            labels: ["triage: needs-real-behavior-proof", "status: needs proof"],
          },
        },
      }),
      () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--dry-run",
            "--apply-kind",
            "all",
            "--item-numbers",
            "344",
            "--processed-limit",
            "3",
          ],
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not promote PRs superseded by unknown-mergeability PRs", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const sourceReport = stalePullRequestReport({
      number: 343,
      title: "Old activity PR",
      labels: JSON.stringify([]),
      pr_rating_overall: "D",
      pr_rating_proof: "D",
      pr_rating_patch: "D",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    })
      .replace("Status: missing", "Status: sufficient")
      .replace(
        "Overall tier: F\nProof tier: F\nPatch tier: F",
        "Overall tier: D\nProof tier: D\nPatch tier: D",
      );
    const synced = reportWithSyncedReviewComment(sourceReport, 343, "none");
    writeFileSync(join(itemsDir, "343.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 343,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Canonical PR still computing mergeability",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: null,
            labels: ["proof: sufficient"],
          },
        },
      }),
      () => {
        runOpenClawApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          dryRun: true,
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  });
});

test("apply-decisions does not promote PRs superseded by non-clean linked pull requests", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const sourceReport = stalePullRequestReport({
      number: 345,
      title: "Old activity PR",
      labels: JSON.stringify([]),
      pr_rating_overall: "D",
      pr_rating_proof: "D",
      pr_rating_patch: "D",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    })
      .replace("Status: missing", "Status: sufficient")
      .replace(
        "Overall tier: F\nProof tier: F\nPatch tier: F",
        "Overall tier: D\nProof tier: D\nPatch tier: D",
      );
    const synced = reportWithSyncedReviewComment(sourceReport, 345, "none");
    writeFileSync(join(itemsDir, "345.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 345,
        title: "Old activity PR",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Blocked canonical PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "open",
            merged_at: null,
            mergeable_state: "blocked",
            labels: ["proof: sufficient"],
          },
        },
      }),
      () => {
        runOpenClawApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          dryRun: true,
        });
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{ action: string }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  });
});
