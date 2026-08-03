import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { guardedOpenApplyProofFields, shouldSyncReviewComment } from "../dist/clawsweeper.js";
import { capturedCanonicalRecordBaselineKeys } from "../dist/repair/canonical-record-baseline.js";
import { createReviewedPrActivityCursor } from "../dist/review-activity-cursor.js";
import {
  implementedCloseReport,
  promotionGhMock,
  readText,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
} from "./helpers.ts";

test("event apply proof marks only live deterministic remain-open guards", () => {
  const guardedActions = [
    "skipped_same_author_pair",
    "skipped_open_closing_pr",
    "skipped_protected_label",
    "skipped_close_exempt_label",
    "skipped_maintainer_authored",
    "skipped_locked_conversation",
    "skipped_low_signal_live_guard",
  ];

  for (const action of guardedActions) {
    assert.deepEqual(
      guardedOpenApplyProofFields(action, {
        emitEventApplyProof: true,
        liveGuardVerified: true,
      }),
      { guardedOpenStateVerified: true },
      action,
    );
    assert.deepEqual(
      guardedOpenApplyProofFields(action, {
        emitEventApplyProof: false,
        liveGuardVerified: true,
      }),
      {},
      `${action} outside exact-event proof`,
    );
    assert.deepEqual(
      guardedOpenApplyProofFields(action, {
        emitEventApplyProof: true,
        liveGuardVerified: false,
      }),
      {},
      `${action} without live verification`,
    );
  }

  for (const action of ["kept_open", "skipped_changed_since_review", "closed"]) {
    assert.deepEqual(
      guardedOpenApplyProofFields(action, {
        emitEventApplyProof: true,
        liveGuardVerified: true,
      }),
      {},
      action,
    );
  }
});

test("apply-decisions defers canonical reconciliation conflicts before live mutation", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "321.md"),
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Reconciled PR",
        url: "https://github.com/openclaw/openclaw/pull/321",
        author: "reporter",
        pull_head_sha: "head-sha",
      }),
      "utf8",
    );

    runApplyDecisionsForTest({
      targetRepo: "openclaw/openclaw",
      itemsDir,
      closedDir,
      plansDir,
      reportPath,
      extraArgs: ["--deferred-item-numbers", "321"],
    });

    assert.deepEqual(JSON.parse(readText(reportPath)), [
      {
        number: 321,
        action: "skipped_changed_since_review",
        reason: "canonical record changed during reconciliation; fresh review required",
      },
    ]);
    assert.match(
      readText(join(itemsDir, "321.md")),
      /^action_taken: skipped_changed_since_review$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions rejects recorded PR review activity drift before mutations", () => {
  const reviewThreadComment = {
    id: 7003,
    pull_request_review_id: 7001,
    user: { login: "maintainer" },
    body: "thread state must remain reviewed",
    created_at: "2026-05-01T00:30:00Z",
    updated_at: "2026-05-01T00:30:00Z",
    path: "src/example.ts",
    line: 14,
    side: "RIGHT",
    commit_id: "head-sha",
  };

  for (const scenario of [
    {
      name: "review",
      reviewedInlineComments: [],
      reviewedThreads: [],
      reviews: [
        {
          id: 7001,
          user: { login: "maintainer" },
          state: "COMMENTED",
          body: "please recheck this",
          submitted_at: "2026-05-01T00:30:00Z",
          commit_id: "head-sha",
        },
      ],
      inlineComments: [],
    },
    {
      name: "inline comment",
      reviewedInlineComments: [],
      reviewedThreads: [],
      reviews: [],
      inlineComments: [
        {
          id: 7002,
          pull_request_review_id: 7001,
          user: { login: "maintainer" },
          body: "this line still needs work",
          created_at: "2026-05-01T00:30:00Z",
          updated_at: "2026-05-01T00:30:00Z",
          path: "src/example.ts",
          line: 12,
          side: "RIGHT",
          commit_id: "head-sha",
        },
      ],
      reviewThreads: [],
    },
    {
      name: "review thread resolution",
      reviewedInlineComments: [reviewThreadComment],
      reviewedThreads: [{ id: "thread-1", isResolved: false }],
      reviews: [],
      inlineComments: [reviewThreadComment],
      reviewThreads: [{ id: "thread-1", isResolved: true }],
    },
  ]) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      const mutationLogPath = join(root, "mutations.log");
      mkdirSync(itemsDir, { recursive: true });
      mkdirSync(plansDir, { recursive: true });
      const reviewedCursor = createReviewedPrActivityCursor({
        reviews: [],
        inlineComments: scenario.reviewedInlineComments,
        reviewThreads: scenario.reviewedThreads,
      });
      assert.ok(reviewedCursor);

      const synced = reportWithSyncedReviewComment(
        implementedCloseReport({
          repository: "openclaw/openclaw",
          number: 321,
          type: "pull_request",
          title: "Reviewed PR",
          url: "https://github.com/openclaw/openclaw/pull/321",
          author: "reporter",
          author_association: "CONTRIBUTOR",
          labels: JSON.stringify([]),
          pull_head_sha: "head-sha",
          review_activity_cursor: reviewedCursor,
        }),
        321,
        "implemented_on_main",
      );
      writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");

      withMockGh(
        root,
        promotionGhMock({
          number: 321,
          title: "Reviewed PR",
          labels: [],
          comment: synced.comment,
          reviews: scenario.reviews,
          pullReviewComments: scenario.inlineComments,
          reviewThreads: scenario.reviewThreads,
          itemUpdatedAtAfterLabelSyncLogPath: mutationLogPath,
        }),
        () => {
          runApplyDecisionsForTest({
            targetRepo: "openclaw/openclaw",
            itemsDir,
            closedDir,
            plansDir,
            reportPath,
          });
        },
      );

      assert.deepEqual(
        JSON.parse(readText(reportPath)),
        [
          {
            number: 321,
            action: "skipped_changed_since_review",
            reason: "pull request review activity changed since review",
          },
        ],
        scenario.name,
      );
      assert.equal(existsSync(mutationLogPath), false, scenario.name);
      assert.match(
        readText(join(itemsDir, "321.md")),
        /^action_taken: skipped_changed_since_review$/m,
        scenario.name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("apply-decisions records review activity that changes after lease acquisition", () => {
  const reviewedCursor = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [],
    reviewThreads: [],
  });
  assert.ok(reviewedCursor);
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const synced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Reviewed PR",
        url: "https://github.com/openclaw/openclaw/pull/321",
        author: "reporter",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify([]),
        pull_head_sha: "head-sha",
        review_activity_cursor: reviewedCursor,
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 321,
        title: "Reviewed PR",
        labels: [],
        comment: synced.comment,
        reviews: [],
        reviewsAfterFirstRead: [
          {
            id: 7001,
            user: { login: "maintainer" },
            state: "COMMENTED",
            body: "please recheck this",
            submitted_at: "2026-05-01T00:30:00Z",
            commit_id: "head-sha",
          },
        ],
        pullReviewComments: [],
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
        });
      },
    );

    assert.deepEqual(JSON.parse(readText(reportPath)), [
      {
        number: 321,
        action: "skipped_changed_since_review",
        reason: "pull request review activity changed since review",
      },
    ]);
    assert.match(
      readText(join(itemsDir, "321.md")),
      /^action_taken: skipped_changed_since_review$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions revalidates review activity before each mutation request", () => {
  const reviewedCursor = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [],
    reviewThreads: [],
  });
  assert.ok(reviewedCursor);
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const synced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Reviewed PR",
        url: "https://github.com/openclaw/openclaw/pull/321",
        author: "reporter",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify([]),
        pull_head_sha: "head-sha",
        review_activity_cursor: reviewedCursor,
        triage_priority: "P1",
        merge_risk_labels: JSON.stringify(["merge-risk: automation"]),
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 321,
        title: "Reviewed PR",
        labels: [],
        comment: synced.comment,
        reviews: [],
        reviewsAfterFirstMutation: [
          {
            id: 7001,
            user: { login: "maintainer" },
            state: "COMMENTED",
            body: "stop before the next mutation",
            submitted_at: "2026-05-01T00:30:00Z",
            commit_id: "head-sha",
          },
        ],
        pullReviewComments: [],
        itemUpdatedAtAfterLabelSyncLogPath: mutationLogPath,
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
        });
      },
    );

    assert.deepEqual(JSON.parse(readText(reportPath)), [
      {
        number: 321,
        action: "skipped_changed_since_review",
        reason: "pull request review activity changed since review",
      },
    ]);
    assert.equal(readText(mutationLogPath).trim().split("\n").length, 1);
    assert.match(
      readText(join(itemsDir, "321.md")),
      /^action_taken: skipped_changed_since_review$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions archives records deleted after review instead of failing the run", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "321.md"),
      implementedCloseReport({ action_taken: "proposed_close" }),
      "utf8",
    );

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (args[0] === "api" && path === "repos/openclaw/clawsweeper") {
  console.log(JSON.stringify({ full_name: "openclaw/clawsweeper" }));
  process.exit(0);
}
console.error("unexpected gh args", JSON.stringify(args));
process.exit(1);
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--event-apply-proof"],
      });
    });

    assert.equal(existsSync(join(itemsDir, "321.md")), false);
    assert.ok(existsSync(join(closedDir, "321.md")));
    assert.match(readText(join(closedDir, "321.md")), /^action_taken: skipped_already_closed$/m);
    assert.deepEqual(JSON.parse(readText(reportPath)), [
      {
        number: 321,
        action: "skipped_already_closed",
        reason: "item not found on GitHub",
        terminalMissingVerified: true,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps missing records queued during comment-only sync", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(itemsDir, "321.md"), implementedCloseReport(), "utf8");

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (args[0] === "api" && path === "repos/openclaw/clawsweeper") {
  console.log(JSON.stringify({ full_name: "openclaw/clawsweeper" }));
  process.exit(0);
}
console.error("unexpected gh args", JSON.stringify(args));
process.exit(1);
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only"],
      });
    });

    assert.ok(existsSync(join(itemsDir, "321.md")));
    assert.equal(existsSync(join(closedDir, "321.md")), false);
    assert.match(readText(join(itemsDir, "321.md")), /^action_taken: proposed_close$/m);
    assert.deepEqual(JSON.parse(readText(reportPath)), [
      {
        number: 321,
        action: "skipped_already_closed",
        reason: "item not found on GitHub",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions fails safely when a missing repository also returns 404", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(itemsDir, "321.md"), implementedCloseReport(), "utf8");

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && (/\\/issues\\/321$/.test(path) || path === "repos/openclaw/clawsweeper")) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
}
console.error("unexpected gh args", JSON.stringify(args));
process.exit(1);
`;
    assert.throws(
      () =>
        withMockGh(root, ghMock, () => {
          runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
        }),
      /Not Found/,
    );

    assert.ok(existsSync(join(itemsDir, "321.md")));
    assert.equal(existsSync(join(closedDir, "321.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply rejects a repo-policy-forbidden close class before comment sync", () => {
  const root = mkdtempSync(tmpPrefix);
  const previousBaselineDir = process.env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR;
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const baselineDir = join(root, "canonical-baseline");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const original = implementedCloseReport({
      action_taken: "proposed_close",
      close_reason: "duplicate_or_superseded",
    });
    writeFileSync(join(itemsDir, "321.md"), original, "utf8");
    process.env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR = baselineDir;

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Policy-forbidden duplicate",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    body: "",
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
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only"],
      });
    });

    assert.deepEqual(JSON.parse(readText(reportPath)), [
      {
        number: 321,
        action: "skipped_invalid_decision",
        reason:
          "duplicate_or_superseded is not allowed for openclaw/clawsweeper issue apply policy",
      },
    ]);
    assert.match(readText(join(itemsDir, "321.md")), /^action_taken: skipped_invalid_decision$/m);
    assert.equal(
      readText(join(baselineDir, "records/openclaw-clawsweeper/items/321.md")),
      original,
    );
    assert.deepEqual(
      [...capturedCanonicalRecordBaselineKeys(baselineDir)],
      ["openclaw-clawsweeper/321"],
    );
  } finally {
    if (previousBaselineDir === undefined) {
      delete process.env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR;
    } else {
      process.env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR = previousBaselineDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("event apply emits proof only while a captured protected-label guard remains live", () => {
  for (const labels of [
    ["security"],
    ["clawsweeper:needs-security-review"],
    ["clawsweeper:needs-maintainer-review"],
    ["clawsweeper:needs-product-decision"],
    [],
  ]) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      mkdirSync(itemsDir, { recursive: true });
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(
        join(itemsDir, "321.md"),
        implementedCloseReport({
          action_taken: "skipped_protected_label",
          labels: JSON.stringify(["security"]),
        }),
        "utf8",
      );

      const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Protected issue",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    body: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: ${JSON.stringify(labels)},
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
      withMockGh(root, ghMock, () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--event-apply-proof",
            "--dry-run",
            "--processed-limit",
            "2",
            "--apply-kind",
            "all",
          ],
        });
      });

      assert.deepEqual(
        JSON.parse(readText(reportPath)),
        labels.length > 0
          ? [
              {
                number: 321,
                action: "skipped_protected_label",
                reason: `protected label: ${labels[0]}`,
                guardedOpenStateVerified: true,
              },
            ]
          : [
              {
                number: 321,
                action: "review_comment_synced",
                reason: "would create durable Codex review comment",
                durableReviewSynced: true,
              },
              {
                number: 321,
                action: "closed",
                reason: "dry-run: would close as already implemented on main",
              },
            ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("event apply retries a captured locked-conversation guard after unlock", () => {
  for (const locked of [true, false]) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      mkdirSync(itemsDir, { recursive: true });
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(
        join(itemsDir, "321.md"),
        implementedCloseReport({ action_taken: "skipped_locked_conversation" }),
        "utf8",
      );

      const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Locked issue",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    body: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: ${locked},
    active_lock_reason: ${locked ? JSON.stringify("resolved") : "null"},
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
      withMockGh(root, ghMock, () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: ["--event-apply-proof", "--dry-run", "--processed-limit", "2"],
        });
      });

      assert.deepEqual(
        JSON.parse(readText(reportPath)),
        locked
          ? [
              {
                number: 321,
                action: "skipped_locked_conversation",
                reason: "conversation is locked (resolved)",
                guardedOpenStateVerified: true,
              },
            ]
          : [
              {
                number: 321,
                action: "review_comment_synced",
                reason: "would create durable Codex review comment",
                durableReviewSynced: true,
              },
              {
                number: 321,
                action: "closed",
                reason: "dry-run: would close as already implemented on main",
              },
            ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("comment-only apply synchronizes guarded reviews without promoting their close actions", () => {
  for (const guard of [
    { action: "skipped_protected_label", labels: ["security"], association: "CONTRIBUTOR" },
    { action: "skipped_maintainer_authored", labels: [], association: "MEMBER" },
    {
      action: "skipped_close_exempt_label",
      labels: ["clawsweeper:human-review"],
      association: "CONTRIBUTOR",
    },
    { action: "skipped_invalid_decision", labels: [], association: "CONTRIBUTOR" },
  ]) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      mkdirSync(itemsDir, { recursive: true });
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(
        join(itemsDir, "321.md"),
        implementedCloseReport({
          repository: "openclaw/openclaw",
          action_taken: guard.action,
          author_association: guard.association,
          labels: JSON.stringify(guard.labels),
          confidence: guard.action === "skipped_invalid_decision" ? "low" : "high",
        }),
        "utf8",
      );

      const ghMock = `
const fs = require("node:fs");
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
const commentPath = ${JSON.stringify(join(root, "comment.json"))};
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) {
    const payload = JSON.parse(fs.readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    const comment = {
      id: 9321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
      created_at: "2026-08-02T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: payload.body,
    };
    fs.writeFileSync(commentPath, JSON.stringify(comment));
    console.log(JSON.stringify(comment));
  } else {
    console.log(JSON.stringify([fs.existsSync(commentPath)
      ? [JSON.parse(fs.readFileSync(commentPath, "utf8"))]
      : []]));
  }
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Guarded issue",
    html_url: "https://github.com/openclaw/openclaw/issues/321",
    body: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: ${JSON.stringify(guard.association)},
    user: { login: "reporter" },
    labels: ${JSON.stringify(guard.labels)},
    comments: fs.existsSync(commentPath) ? 1 : 0,
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "edit")) {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
      withMockGh(root, ghMock, () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--sync-comments-only",
            "--item-number",
            "321",
            "--processed-limit",
            "1",
            "--comment-sync-min-age-days",
            "0",
          ],
        });
      });

      const [result] = JSON.parse(readText(reportPath));
      assert.equal(result.number, 321);
      assert.equal(result.action, "review_comment_synced");
      assert.match(result.reason, /^(?:created|updated) durable Codex review comment$/);
      assert.match(
        readText(join(itemsDir, "321.md")),
        new RegExp(`^action_taken: ${guard.action}$`, "m"),
      );
      assert.equal(existsSync(join(root, "comment.json")), true);
      assert.doesNotMatch(
        JSON.parse(readText(join(root, "comment.json"))).body,
        /action_taken[=:] proposed_close/i,
      );
      assert.equal(existsSync(join(closedDir, "321.md")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("matching durable comments repair stale, missing, and refreshed sync timestamps", () => {
  const now = Date.parse("2026-08-02T12:00:00Z");
  const base = {
    syncCommentsOnly: true,
    isCloseProposal: false,
    commentSyncMinAgeDays: 7,
    reviewCommentSyncedAt: "2026-08-01T12:00:00Z",
    hasExistingReviewComment: true,
    needsReviewCommentBodySync: false,
    needsReviewCommentHashSync: false,
    needsReviewCommentReferenceSync: false,
    now,
  };

  assert.equal(shouldSyncReviewComment(base), false);
  for (const metadata of [
    { reviewCommentSyncedAt: undefined },
    { reviewCommentSyncedAt: "not-a-timestamp" },
    { reviewCommentSyncedAt: "2026-07-26T12:00:00Z" },
    { reviewedAt: "2026-08-02T11:00:00Z" },
    { lastFullReviewAt: "2026-08-02T11:00:00Z" },
    { guardedReviewedAt: "2026-08-02T11:00:00Z" },
  ]) {
    assert.equal(shouldSyncReviewComment({ ...base, ...metadata }), true);
  }
});

test("comment-only apply repairs timestamps and references without editing GitHub", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const reviewed = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        decision: "keep_open",
        close_reason: "none",
        action_taken: "kept_open",
        reviewed_at: "2026-08-02T10:00:00Z",
      }),
      321,
      "none",
    );
    const canonicalReport = reviewed.report.replaceAll(
      "https://github.com/openclaw/clawsweeper/issues/321",
      "https://github.com/openclaw/openclaw/issues/321",
    );
    const existing = {
      id: 9_321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
      created_at: "2026-08-01T01:00:00Z",
      updated_at: "2026-08-01T01:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: reviewed.comment,
    };
    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (/\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") || args.includes("-X")) {
    console.error("unchanged durable review comment must not be edited");
    process.exit(1);
  }
  console.log(JSON.stringify([[${JSON.stringify(existing)}]]));
} else if (/\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (/\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/openclaw/issues/321",
    body: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "edit")) {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;

    const freshSyncedAt = new Date().toISOString();
    const currentReport = canonicalReport.replace(
      /^review_comment_synced_at:.*$/m,
      `review_comment_synced_at: ${freshSyncedAt}`,
    );
    for (const report of [
      canonicalReport.replace(/^review_comment_synced_at:.*\n/m, ""),
      currentReport.replace(/^review_comment_id:.*$/m, "review_comment_id: none"),
      currentReport.replace(/^review_comment_id:.*\n/m, ""),
      currentReport.replace(/^review_comment_url:.*$/m, "review_comment_url: none"),
    ]) {
      writeFileSync(join(itemsDir, "321.md"), report, "utf8");
      withMockGh(root, ghMock, () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--sync-comments-only",
            "--item-number",
            "321",
            "--comment-sync-min-age-days",
            "7",
          ],
        });
      });

      assert.deepEqual(JSON.parse(readText(reportPath)), [
        {
          number: 321,
          action: "review_comment_synced",
          reason: "recorded existing durable comment metadata",
        },
      ]);
      const repaired = readText(join(itemsDir, "321.md"));
      assert.match(repaired, /^review_comment_synced_at: /m);
      assert.match(repaired, /^review_comment_id: 9321$/m);
      assert.match(
        repaired,
        /^review_comment_url: https:\/\/github\.com\/openclaw\/openclaw\/issues\/321#issuecomment-9321$/m,
      );
      assert.match(repaired, /^action_taken: kept_open$/m);
      assert.equal(existsSync(join(closedDir, "321.md")), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("event apply emits proof only while a captured PR close-exemption guard remains live", () => {
  for (const labels of [["clawsweeper:human-review"], []]) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      mkdirSync(itemsDir, { recursive: true });
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(
        join(itemsDir, "321.md"),
        implementedCloseReport({
          type: "pull_request",
          action_taken: "skipped_close_exempt_label",
          close_reason: "stalled_unproven_pr",
          item_updated_at: "2026-01-01T00:00:00Z",
          labels: JSON.stringify(["clawsweeper:human-review"]),
        }),
        "utf8",
      );

      const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Exempt PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: ${JSON.stringify(labels)},
    comments: 0,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Exempt PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    draft: false,
    created_at: "2026-01-01T00:00:00Z",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    requested_reviewers: [],
    requested_teams: [],
    body: "",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
      withMockGh(root, ghMock, () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--event-apply-proof",
            "--dry-run",
            "--processed-limit",
            "2",
            "--apply-kind",
            "all",
          ],
        });
      });

      assert.deepEqual(
        JSON.parse(readText(reportPath)),
        labels.length > 0
          ? [
              {
                number: 321,
                action: "skipped_close_exempt_label",
                reason: "clawsweeper:human-review exempts this PR from stalled-unproven auto-close",
                guardedOpenStateVerified: true,
              },
            ]
          : [
              {
                number: 321,
                action: "skipped_invalid_decision",
                reason:
                  "stalled_unproven_pr is not allowed for openclaw/clawsweeper pull_request apply policy",
              },
            ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
