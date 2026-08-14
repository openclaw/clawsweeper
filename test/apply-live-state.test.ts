import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  guardedOpenApplyProofFields,
  itemSourceRevisionSha256ForTest,
  renderReviewCommentFromReport,
  renderReviewStartStatusComment,
  shouldSyncReviewComment,
} from "../dist/clawsweeper.js";
import { capturedCanonicalRecordBaselineKeys } from "../dist/repair/canonical-record-baseline.js";
import { createReviewedPrActivityCursor } from "../dist/review-activity-cursor.js";
import { shouldReviewItem } from "../dist/scheduler-policy.js";
import {
  implementedCloseReport,
  markedReviewCommentForTest,
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
      name: "locked review",
      locked: true,
      reviewedInlineComments: [],
      reviewedThreads: [],
      reviews: [
        {
          id: 7004,
          user: { login: "maintainer" },
          state: "COMMENTED",
          body: "this locked PR still changed after review",
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
        }).replace("locked: false,", `locked: ${scenario.locked === true},`),
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

test("comment-only apply skips a locked issue before acquiring its mutation lease", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    for (const directory of [itemsDir, closedDir, plansDir]) {
      mkdirSync(directory, { recursive: true });
    }
    const issue = {
      number: 321,
      title: "Locked reopened issue",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      body: "",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      closed_at: null,
      state: "open",
      locked: true,
      active_lock_reason: "resolved",
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 0,
      pull_request: null,
    };
    writeFileSync(
      join(itemsDir, "321.md"),
      implementedCloseReport({
        repository: "openclaw/openclaw",
        decision: "keep_open",
        close_reason: "none",
        action_taken: "kept_open",
        author_association: "CONTRIBUTOR",
        labels: "[]",
        item_source_revision: itemSourceRevisionSha256ForTest(issue, []),
        review_lease_owner: "review-owner",
        review_lease_comment_id: "77",
      }),
    );

    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) {
    console.error("mutation lease must not be posted on a locked issue");
    process.exit(1);
  }
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
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
          "--comment-sync-min-age-days",
          "0",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readText(reportPath)), [
      {
        number: 321,
        action: "skipped_locked_conversation",
        reason: "conversation is locked (resolved)",
      },
    ]);
    assert.match(
      readText(join(itemsDir, "321.md")),
      /^action_taken: skipped_locked_conversation$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact-event source drift wins over a locked conversation guard", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    for (const directory of [itemsDir, closedDir, plansDir]) {
      mkdirSync(directory, { recursive: true });
    }
    const issue = {
      number: 321,
      title: "Locked reopened issue",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      body: "updated issue body",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      closed_at: null,
      state: "open",
      locked: true,
      active_lock_reason: "resolved",
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 0,
      pull_request: null,
    };
    const reviewedIssue = { ...issue, body: "reviewed issue body" };
    writeFileSync(
      join(itemsDir, "321.md"),
      implementedCloseReport({
        repository: "openclaw/openclaw",
        action_taken: "skipped_locked_conversation",
        labels: "[]",
        item_source_revision: itemSourceRevisionSha256ForTest(reviewedIssue, []),
        review_lease_owner: "review-owner",
        review_lease_comment_id: "77",
      }),
    );
    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/(comments|timeline)(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) {
    console.error("locked issue source drift must not attempt mutation");
    process.exit(1);
  }
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
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
          "--dry-run",
          "--item-number",
          "321",
          "--event-apply-proof",
          "--exact-event-publication",
        ],
      });
    });

    const [result] = JSON.parse(readText(reportPath));
    assert.equal(result.action, "skipped_changed_since_review");
    assert.equal(result.sourceDriftVerified, true);
    assert.doesNotMatch(JSON.stringify(result), /guardedOpenStateVerified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locked exact-event PRs classify timestamp drift before their conversation lock", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    const number = 337;
    const head = "abcdef1234567890abcdef1234567890abcdef12";
    const reviewed = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number,
        type: "pull_request",
        title: "Locked PR with updated-at drift",
        url: `https://github.com/openclaw/openclaw/pull/${number}`,
        author: "reporter",
        author_association: "CONTRIBUTOR",
        labels: "[]",
        pull_head_sha: head,
        review_lease_owner: "review-owner",
        review_lease_comment_id: "77",
      }),
      number,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, `${number}.md`), reviewed.report);
    withMockGh(
      root,
      promotionGhMock({
        number,
        title: "Locked PR with updated-at drift",
        labels: [],
        headSha: head,
        itemUpdatedAt: "2026-05-02T00:00:00Z",
        comment: reviewed.comment,
      }).replace("locked: false,", "locked: true,"),
      () =>
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--sync-comments-only",
            "--apply-kind",
            "all",
            "--item-number",
            String(number),
            "--dry-run",
            "--event-apply-proof",
            "--exact-event-publication",
          ],
        }),
    );
    const [result] = JSON.parse(readText(reportPath));
    assert.equal(result.action, "skipped_changed_since_review");
    assert.equal(result.sourceDriftVerified, true);
    assert.equal(result.guardedOpenStateVerified, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locked issue timestamp drift persists the observed current revision evidence", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    const issue = {
      number: 321,
      title: "Locked issue with timestamp drift",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      body: "Reviewed source.",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
      closed_at: null,
      state: "open",
      locked: true,
      active_lock_reason: "resolved",
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 0,
      pull_request: null,
    };
    writeFileSync(
      join(itemsDir, "321.md"),
      implementedCloseReport({
        repository: "openclaw/openclaw",
        item_updated_at: "2026-05-01T00:00:00Z",
        item_source_revision: itemSourceRevisionSha256ForTest(issue, []),
        review_lease_owner: "review-owner",
        review_lease_comment_id: "77",
        labels: "[]",
      }),
    );
    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/(comments|timeline)(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) throw new Error("drift must not mutate a locked issue");
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else {
  throw new Error("unexpected gh args " + JSON.stringify(args));
}`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only", "--item-number", "321", "--event-apply-proof"],
      });
    });
    const [result] = JSON.parse(readText(reportPath));
    assert.equal(result.action, "skipped_changed_since_review");
    assert.equal(result.sourceDriftVerified, true);
    assert.match(
      readText(join(itemsDir, "321.md")),
      /^current_item_updated_at: 2026-05-02T00:00:00Z$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locked issue snapshot drift wins over its lock when updated_at is absent", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    const issue = {
      number: 321,
      title: "Locked issue with snapshot drift",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      body: "Reviewed source.",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      closed_at: null,
      state: "open",
      locked: true,
      active_lock_reason: "resolved",
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 0,
      pull_request: null,
    };
    writeFileSync(
      join(itemsDir, "321.md"),
      implementedCloseReport({
        repository: "openclaw/openclaw",
        item_source_revision: itemSourceRevisionSha256ForTest(issue, []),
        review_lease_owner: "review-owner",
        review_lease_comment_id: "77",
        labels: "[]",
      }).replace(/^item_updated_at:.*\n/m, ""),
    );
    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/(comments|timeline)(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) throw new Error("drift must not mutate a locked issue");
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else {
  throw new Error("unexpected gh args " + JSON.stringify(args));
}`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only", "--item-number", "321", "--event-apply-proof"],
      });
    });
    const [result] = JSON.parse(readText(reportPath));
    assert.equal(result.action, "skipped_changed_since_review");
    assert.equal(result.reason, "snapshot changed");
    assert.equal(result.sourceDriftVerified, true);
    assert.match(readText(join(itemsDir, "321.md")), /^current_item_snapshot_hash: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guarded reports reject changed snapshots even with a zero publication cooldown", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const commentWrites = join(root, "comment-writes.json");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    const reviewedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const syncedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const issue = {
      number: 321,
      title: "Changed issue body after review",
      body: "Human edited after review.",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: new Date().toISOString(),
      closed_at: null,
      state: "open",
      locked: false,
      active_lock_reason: null,
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 1,
      pull_request: null,
    };
    const reviewed = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        title: "Old reviewed issue body",
        action_taken: "skipped_invalid_decision",
        confidence: "low",
        reviewed_at: reviewedAt,
        labels: "[]",
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(
      join(itemsDir, "321.md"),
      reviewed.report
        .replace(/^review_comment_synced_at:.*$/m, `review_comment_synced_at: ${syncedAt}`)
        .replace(/^item_updated_at:.*\n/m, "")
        .replaceAll(
          "https://github.com/openclaw/clawsweeper/issues/321",
          "https://github.com/openclaw/openclaw/issues/321",
        ),
    );
    const durable = {
      id: 9321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
      created_at: syncedAt,
      updated_at: syncedAt,
      user: { login: "clawsweeper[bot]" },
      body: `${reviewed.comment}\n\nprevious current verdict`,
    };
    const ghMock = `
const fs = require("node:fs");
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) throw new Error("unexpected posting");
  console.log(JSON.stringify([[${JSON.stringify(durable)}]]));
} else if (args[0] === "api" && /\\/issues\\/comments\\/9321$/.test(path) && args.includes("PATCH")) {
  fs.writeFileSync(${JSON.stringify(commentWrites)}, "written");
  console.log(JSON.stringify(${JSON.stringify(durable)}));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "edit")) {
  console.log("");
} else {
  throw new Error("unexpected gh args " + JSON.stringify(args));
}`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--skip-dashboard",
          "--sync-comments-only",
          "--item-number",
          "321",
          "--comment-sync-min-age-days",
          "0",
        ],
      });
    });
    assert.deepEqual(JSON.parse(readText(reportPath)), [
      { number: 321, action: "skipped_changed_since_review", reason: "snapshot changed" },
    ]);
    assert.equal(existsSync(commentWrites), false);
    assert.match(readText(join(itemsDir, "321.md")), /^action_taken: skipped_invalid_decision$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guarded PR source drift is rejected before any label mutation", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const mutationLog = join(root, "mutations.log");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    const reviewed = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Protected PR changed after review",
        url: "https://github.com/openclaw/openclaw/pull/321",
        action_taken: "skipped_protected_label",
        author: "reporter",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify(["security"]),
        pull_head_sha: "reviewed-head",
        item_updated_at: "2026-05-01T00:00:00Z",
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "321.md"), reviewed.report);
    withMockGh(
      root,
      promotionGhMock({
        number: 321,
        title: "Protected PR changed after review",
        labels: ["security"],
        headSha: "reviewed-head",
        itemUpdatedAt: "2026-05-02T00:00:00Z",
        itemUpdatedAtAfterLabelSyncLogPath: mutationLog,
        comment: reviewed.comment,
      }),
      () =>
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: ["--sync-comments-only", "--apply-kind", "all", "--item-number", "321"],
        }),
    );
    assert.deepEqual(JSON.parse(readText(reportPath)), [
      { number: 321, action: "skipped_changed_since_review", reason: "updated_at changed" },
    ]);
    assert.equal(existsSync(mutationLog), false);
    assert.match(readText(join(itemsDir, "321.md")), /^action_taken: skipped_protected_label$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected stale-head proposals clear obsolete readiness labels before exiting", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const mutationLog = join(root, "mutations.log");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    const labels = ["security", "proof: sufficient", "status: 👀 ready for maintainer look"];
    const reviewed = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Protected stale-head proposal",
        url: "https://github.com/openclaw/openclaw/pull/321",
        action_taken: "proposed_close",
        author: "reporter",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify(labels),
        pull_head_sha: "reviewed-head",
        item_updated_at: "2026-05-01T00:00:00Z",
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "321.md"), reviewed.report);
    withMockGh(
      root,
      promotionGhMock({
        number: 321,
        title: "Protected stale-head proposal",
        labels,
        headSha: "new-head",
        itemUpdatedAtAfterLabelSyncLogPath: mutationLog,
        comment: reviewed.comment,
      }),
      () =>
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: ["--sync-comments-only", "--apply-kind", "all", "--item-number", "321"],
        }),
    );
    assert.deepEqual(JSON.parse(readText(reportPath)), [
      { number: 321, action: "skipped_protected_label", reason: "protected label: security" },
    ]);
    const stored = readText(join(itemsDir, "321.md"));
    assert.equal(existsSync(mutationLog), true);
    assert.match(stored, /^current_pull_head_sha: new-head$/m);
    assert.match(stored, /^labels: \["security"\]$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected source drift preserves its original guard after lock or label removal", () => {
  for (const scenario of [
    { locked: true, labels: ["security", "good first issue"], syncOnly: true },
    { locked: false, labels: [], syncOnly: false },
  ]) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const targetRepo = scenario.locked ? "openclaw/openclaw" : "openclaw/clawsweeper";
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      for (const directory of [itemsDir, closedDir, plansDir])
        mkdirSync(directory, { recursive: true });
      const issue = {
        number: 321,
        title: "Protected locked issue",
        html_url: `https://github.com/${targetRepo}/issues/321`,
        body: "Reviewed source.",
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-02T00:00:00Z",
        closed_at: null,
        state: "open",
        locked: scenario.locked,
        active_lock_reason: scenario.locked ? "resolved" : null,
        author_association: "CONTRIBUTOR",
        user: { login: "reporter" },
        labels: scenario.labels,
        comments: 0,
        pull_request: null,
      };
      writeFileSync(
        join(itemsDir, "321.md"),
        implementedCloseReport({
          repository: targetRepo,
          title: issue.title,
          action_taken: "skipped_protected_label",
          labels: JSON.stringify(["security"]),
          item_updated_at: "2026-05-01T00:00:00Z",
          item_source_revision: itemSourceRevisionSha256ForTest(issue, []),
          ...(scenario.locked
            ? { review_lease_owner: "review-owner", review_lease_comment_id: "77" }
            : {}),
        }),
      );
      const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/(comments|timeline)(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) throw new Error("protected locked source must not be mutated");
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else {
  throw new Error("unexpected gh args " + JSON.stringify(args));
}`;
      withMockGh(root, ghMock, () =>
        runApplyDecisionsForTest({
          targetRepo,
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            ...(scenario.syncOnly ? ["--sync-comments-only"] : []),
            "--item-number",
            "321",
            "--event-apply-proof",
          ],
        }),
      );
      const [result] = JSON.parse(readText(reportPath));
      assert.equal(result.action, "skipped_changed_since_review");
      assert.equal(result.sourceDriftVerified, true);
      const stored = readText(join(itemsDir, "321.md"));
      assert.match(stored, /^action_taken: skipped_protected_label$/m);
      assert.match(stored, /^current_item_updated_at: 2026-05-02T00:00:00Z$/m);
      assert.ok(stored.includes(`\nlabels: ${JSON.stringify(scenario.labels)}\n`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("live protected labels and maintainer ownership take precedence over source drift", () => {
  for (const scenario of [
    {
      targetRepo: "openclaw/clawsweeper",
      labels: ["security"],
      association: "CONTRIBUTOR",
      closeReason: "implemented_on_main",
      action: "skipped_protected_label",
      reason: "protected label: security",
    },
    {
      targetRepo: "openclaw/openclaw",
      labels: ["triage"],
      association: "MEMBER",
      closeReason: "cannot_reproduce",
      action: "skipped_maintainer_authored",
      reason: "author association is MEMBER",
    },
  ]) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      for (const directory of [itemsDir, closedDir, plansDir])
        mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(itemsDir, "321.md"),
        implementedCloseReport({
          repository: scenario.targetRepo,
          labels: "[]",
          author_association: "CONTRIBUTOR",
          close_reason: scenario.closeReason,
        }),
      );
      const issue = {
        number: 321,
        title: "Live protected or maintainer issue",
        html_url: `https://github.com/${scenario.targetRepo}/issues/321`,
        body: "",
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-02T00:00:00Z",
        closed_at: null,
        state: "open",
        locked: false,
        active_lock_reason: null,
        author_association: scenario.association,
        user: { login: "reporter" },
        labels: scenario.labels,
        comments: 0,
        pull_request: null,
      };
      const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/(comments|timeline)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else {
  throw new Error("live protected source must not be mutated: " + JSON.stringify(args));
}`;
      withMockGh(root, ghMock, () =>
        runApplyDecisionsForTest({
          targetRepo: scenario.targetRepo,
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: ["--skip-dashboard", "--item-number", "321", "--event-apply-proof"],
        }),
      );
      assert.deepEqual(JSON.parse(readText(reportPath)), [
        {
          number: 321,
          action: scenario.action,
          reason: scenario.reason,
          guardedOpenStateVerified: true,
        },
      ]);
      const stored = readText(join(itemsDir, "321.md"));
      assert.ok(stored.includes(`\nlabels: ${JSON.stringify(scenario.labels)}\n`));
      assert.match(stored, new RegExp(`^author_association: ${scenario.association}$`, "m"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("locked failed reviews honor the comment-sync cooldown and release their lease", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const leaseDeleted = join(root, "lease-deleted");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    const reviewedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const syncedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const issue = {
      number: 321,
      title: "Locked failed review within cooldown",
      body: "Reviewed source.",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: reviewedAt,
      closed_at: null,
      state: "open",
      locked: true,
      active_lock_reason: "resolved",
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 2,
      pull_request: null,
    };
    const revision = itemSourceRevisionSha256ForTest(issue, []);
    const reviewed = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        title: issue.title,
        decision: "keep_open",
        close_reason: "none",
        action_taken: "kept_open",
        review_status: "failed",
        reviewed_at: reviewedAt,
        item_updated_at: reviewedAt,
        item_source_revision: revision,
        review_lease_owner: "completed-review",
        review_lease_comment_id: "700321",
        labels: "[]",
      }),
      321,
      "none",
    );
    writeFileSync(
      join(itemsDir, "321.md"),
      reviewed.report
        .replace(/^review_comment_synced_at:.*$/m, `review_comment_synced_at: ${syncedAt}`)
        .replaceAll(
          "https://github.com/openclaw/clawsweeper/issues/321",
          "https://github.com/openclaw/openclaw/issues/321",
        ),
    );
    const durable = {
      id: 9321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
      created_at: syncedAt,
      updated_at: syncedAt,
      user: { login: "clawsweeper[bot]" },
      body: `${reviewed.comment}\n\nlegacy comment suffix`,
    };
    const startedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const lease = {
      id: 700321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-700321",
      created_at: startedAt,
      updated_at: startedAt,
      user: { login: "clawsweeper[bot]" },
      body: renderReviewStartStatusComment({
        number: 321,
        kind: "issue",
        title: issue.title,
        headSha: revision,
        startedAt,
        leaseExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        leaseOwner: "completed-review",
      }),
    };
    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) throw new Error("unexpected posting");
  console.log(JSON.stringify([[${JSON.stringify(durable)}, ${JSON.stringify(lease)}]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (args[0] === "api" && /\\/issues\\/comments\\/700321$/.test(path) && args.includes("DELETE")) {
  require("node:fs").writeFileSync(${JSON.stringify(leaseDeleted)}, "deleted");
  console.log("");
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "edit")) {
  console.log("");
} else {
  throw new Error("unexpected gh args " + JSON.stringify(args));
}`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--skip-dashboard",
          "--sync-comments-only",
          "--item-number",
          "321",
          "--comment-sync-min-age-days",
          "7",
        ],
      });
    });
    assert.deepEqual(JSON.parse(readText(reportPath)), []);
    assert.match(readText(join(itemsDir, "321.md")), /^action_taken: kept_open$/m);
    assert.equal(existsSync(leaseDeleted), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed legacy reports archive without hydrating their irrelevant source snapshot", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(itemsDir, "321.md"),
      implementedCloseReport({
        action_taken: "skipped_open_closing_pr",
        close_reason: "duplicate_or_superseded",
      })
        .replace(/^local_checkout_access: verified\n/m, "")
        .replace(/^item_updated_at:.*\n/m, ""),
    );
    const closedIssue = {
      number: 321,
      title: "Render work plans",
      html_url: "https://github.com/openclaw/clawsweeper/issues/321",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      closed_at: "2026-05-02T00:00:00Z",
      state: "closed",
      locked: false,
      active_lock_reason: null,
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 0,
      pull_request: null,
    };
    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(closedIssue)}));
} else {
  throw new Error("closed records must not hydrate source context: " + JSON.stringify(args));
}`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--skip-dashboard", "--item-number", "321"],
      });
    });
    const [result] = JSON.parse(readText(reportPath));
    assert.equal(result.action, "skipped_already_closed");
    assert.equal(existsSync(join(closedDir, "321.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locked issues preserve already-synchronized linked-PR review comments", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const leaseDeleted = join(root, "lease-deleted");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    const reviewedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const syncedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const labels = [
      "issue-rating: 🦀 challenger crab",
      "clawsweeper:current-main-repro",
      "clawsweeper:linked-pr-open",
      "clawsweeper:no-new-fix-pr",
    ];
    const issue = {
      number: 321,
      title: "Locked issue with linked PR",
      body: "Reviewed source.",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: reviewedAt,
      closed_at: null,
      state: "open",
      locked: true,
      active_lock_reason: "resolved",
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels,
      comments: 2,
      pull_request: null,
    };
    const revision = itemSourceRevisionSha256ForTest(issue, []);
    let report = implementedCloseReport({
      repository: "openclaw/openclaw",
      title: issue.title,
      decision: "keep_open",
      close_reason: "none",
      action_taken: "kept_open",
      work_candidate: "none",
      work_status: "none",
      reviewed_at: reviewedAt,
      item_updated_at: reviewedAt,
      labels: JSON.stringify(labels),
      item_source_revision: revision,
      review_lease_owner: "completed-review",
      review_lease_comment_id: "700321",
    });
    const body = markedReviewCommentForTest(
      321,
      renderReviewCommentFromReport(report, "none", {
        previousLabels: labels,
        hasOpenLinkedPullRequest: true,
      }),
    );
    report = report.replace(
      /^---\n/,
      [
        "---",
        `review_comment_sha256: ${createHash("sha256").update(body.trim()).digest("hex")}`,
        "review_comment_id: 9321",
        "review_comment_url: https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
        `review_comment_synced_at: ${syncedAt}`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(itemsDir, "321.md"), report);
    const durable = {
      id: 9321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
      created_at: syncedAt,
      updated_at: syncedAt,
      user: { login: "clawsweeper[bot]" },
      body,
    };
    const startedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const lease = {
      id: 700321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-700321",
      created_at: startedAt,
      updated_at: startedAt,
      user: { login: "clawsweeper[bot]" },
      body: renderReviewStartStatusComment({
        number: 321,
        kind: "issue",
        title: issue.title,
        headSha: revision,
        startedAt,
        leaseExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        leaseOwner: "completed-review",
      }),
    };
    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) throw new Error("must not mutate a locked comment");
  console.log(JSON.stringify([[${JSON.stringify(durable)}, ${JSON.stringify(lease)}]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (args[0] === "api" && /\\/pulls\\/400$/.test(path)) {
  console.log(JSON.stringify({
    number: 400,
    title: "Existing fix",
    state: "open",
    html_url: "https://github.com/openclaw/openclaw/pull/400",
    user: { login: "contributor" },
    head: { sha: "head" },
    base: { sha: "base" },
  }));
} else if (args[0] === "api" && /\\/issues\\/comments\\/700321$/.test(path) && args.includes("DELETE")) {
  require("node:fs").writeFileSync(${JSON.stringify(leaseDeleted)}, "deleted");
  console.log("");
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [{ number: 400 }] }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "edit")) {
  console.log("");
} else {
  throw new Error("unexpected gh args " + JSON.stringify(args));
}`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--skip-dashboard",
          "--sync-comments-only",
          "--item-number",
          "321",
          "--comment-sync-min-age-days",
          "0",
        ],
      });
    });
    const [result] = JSON.parse(readText(reportPath));
    assert.equal(result.action, "review_comment_synced");
    assert.match(readText(join(itemsDir, "321.md")), /^action_taken: kept_open$/m);
    assert.equal(existsSync(leaseDeleted), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locked conversations preserve pending stale canonical comment repairs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "records", "openclaw-openclaw", "items");
    const closedDir = join(root, "records", "openclaw-openclaw", "closed");
    const plansDir = join(root, "records", "openclaw-openclaw", "plans");
    const reportPath = join(root, "apply-report.json");
    for (const directory of [itemsDir, closedDir, plansDir]) {
      mkdirSync(directory, { recursive: true });
    }
    const issue = {
      number: 321,
      title: "Pending locked review correction",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      body: "",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      closed_at: null,
      state: "open",
      locked: true,
      active_lock_reason: "resolved",
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 0,
      pull_request: null,
    };
    writeFileSync(
      join(itemsDir, "321.md"),
      implementedCloseReport({
        repository: "openclaw/openclaw",
        decision: "keep_open",
        close_reason: "none",
        confidence: "low",
        action_taken: "retry_stale_canonical_comment_sync",
        stale_canonical_pull_request_number: "400",
        labels: "[]",
      }),
    );
    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/(comments|timeline)(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) {
    console.error("locked stale-canonical repair must not attempt mutation");
    process.exit(1);
  }
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
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
        extraArgs: ["--sync-comments-only", "--item-number", "321", "--apply-kind", "all"],
      });
    });

    const [result] = JSON.parse(readText(reportPath));
    assert.equal(result.number, 321);
    assert.equal(result.action, "retry_stale_canonical_comment_sync");
    assert.match(result.reason, /stale comment correction/);
    assert.match(
      readText(join(itemsDir, "321.md")),
      /^action_taken: retry_stale_canonical_comment_sync$/m,
    );
    assert.match(readText(join(itemsDir, "321.md")), /^stale_canonical_pull_request_number: 400$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("metadata-only comment verification never hides newer human source activity", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    const now = Date.now();
    const reviewedAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const humanUpdatedAt = new Date(now - 60 * 60 * 1000).toISOString();
    const commentUpdatedAt = new Date(now - 90 * 60 * 1000).toISOString();
    const reviewed = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        decision: "keep_open",
        close_reason: "none",
        action_taken: "kept_open",
        reviewed_at: reviewedAt,
        item_updated_at: reviewedAt,
        labels: "[]",
      }),
      321,
      "none",
    );
    writeFileSync(
      join(itemsDir, "321.md"),
      reviewed.report
        .replace(/^review_comment_synced_at:.*\n/m, "")
        .replaceAll(
          "https://github.com/openclaw/clawsweeper/issues/321",
          "https://github.com/openclaw/openclaw/issues/321",
        ),
    );
    const durable = {
      id: 9321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
      created_at: commentUpdatedAt,
      updated_at: commentUpdatedAt,
      user: { login: "clawsweeper[bot]" },
      body: reviewed.comment,
    };
    const issue = {
      number: 321,
      title: "Render work plans",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      body: "Human updated after review.",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: humanUpdatedAt,
      closed_at: null,
      state: "open",
      locked: false,
      active_lock_reason: null,
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 1,
      pull_request: null,
    };
    const schedulerItem = {
      repo: "openclaw/openclaw",
      number: 321,
      kind: "issue" as const,
      createdAt: issue.created_at,
      updatedAt: humanUpdatedAt,
    };
    const review = { reviewedAt, itemUpdatedAt: reviewedAt, reviewStatus: "complete" as const };
    assert.equal(shouldReviewItem(schedulerItem, review, now), true);
    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (/\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) throw new Error("metadata-only must not mutate GitHub");
  console.log(JSON.stringify([[${JSON.stringify(durable)}]]));
} else if (/\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (/\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "edit")) {
  console.log("");
} else {
  throw new Error("unexpected gh args " + JSON.stringify(args));
}`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--skip-dashboard",
          "--sync-comments-only",
          "--item-number",
          "321",
          "--comment-sync-min-age-days",
          "0",
        ],
      });
    });
    const updated = readText(join(itemsDir, "321.md"));
    const syncedAt = updated.match(/^review_comment_synced_at:\s*(.+)$/m)?.[1];
    assert.equal(syncedAt, commentUpdatedAt);
    assert.match(updated, /^review_comment_checked_at: /m);
    assert.equal(
      shouldReviewItem(schedulerItem, { ...review, reviewCommentSyncedAt: syncedAt }, Date.now()),
      true,
    );
    assert.deepEqual(JSON.parse(readText(reportPath)), [
      {
        number: 321,
        action: "review_comment_synced",
        reason: "recorded existing durable comment metadata",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locked, already-synchronized maintainer and invalid reports refresh local metadata", () => {
  for (const action of ["skipped_maintainer_authored", "skipped_invalid_decision"]) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "records", "openclaw-openclaw", "items");
      const closedDir = join(root, "records", "openclaw-openclaw", "closed");
      const plansDir = join(root, "records", "openclaw-openclaw", "plans");
      const reportPath = join(root, "apply-report.json");
      for (const directory of [itemsDir, closedDir, plansDir]) {
        mkdirSync(directory, { recursive: true });
      }
      const reviewedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const syncedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const association = action === "skipped_maintainer_authored" ? "MEMBER" : "CONTRIBUTOR";
      const issue = {
        number: 321,
        title: "Guarded issue",
        html_url: "https://github.com/openclaw/openclaw/issues/321",
        body: "",
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-01T00:00:00Z",
        closed_at: null,
        state: "open",
        locked: true,
        active_lock_reason: "resolved",
        author_association: association,
        user: { login: "reporter" },
        labels: [],
        comments: 1,
        pull_request: null,
      };
      const reviewed = reportWithSyncedReviewComment(
        implementedCloseReport({
          repository: "openclaw/openclaw",
          action_taken: action,
          author_association: association,
          confidence: action === "skipped_invalid_decision" ? "low" : "high",
          labels: "[]",
          reviewed_at: reviewedAt,
          item_source_revision: itemSourceRevisionSha256ForTest(issue, []),
          review_lease_owner: "review-owner",
          review_lease_comment_id: "77",
        }),
        321,
        "implemented_on_main",
      );
      const report = reviewed.report
        .replace(/^review_comment_synced_at:.*$/m, `review_comment_synced_at: ${syncedAt}`)
        .replaceAll(
          "https://github.com/openclaw/clawsweeper/issues/321",
          "https://github.com/openclaw/openclaw/issues/321",
        )
        .replace(/^---\n/, `---\napply_checked_at: ${new Date().toISOString()}\n`);
      writeFileSync(join(itemsDir, "321.md"), report);
      const existing = {
        id: 9321,
        html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
        created_at: syncedAt,
        updated_at: syncedAt,
        user: { login: "clawsweeper[bot]" },
        body: reviewed.comment,
      };
      const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) {
    console.error("matching durable review comment must not be edited");
    process.exit(1);
  }
  console.log(JSON.stringify([[${JSON.stringify(existing)}]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
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
            "--comment-sync-min-age-days",
            "0",
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
      const updatedReport = readText(join(itemsDir, "321.md"));
      assert.match(updatedReport, new RegExp(`^action_taken: ${action}$`, "m"));
      const refreshedSyncTime = updatedReport.match(/^review_comment_synced_at:\s*(.*)$/m)?.[1];
      const checkedTime = updatedReport.match(/^apply_checked_at:\s*(.*)$/m)?.[1];
      const verifiedTime = updatedReport.match(/^review_comment_checked_at:\s*(.*)$/m)?.[1];
      assert.equal(refreshedSyncTime, syncedAt);
      assert.ok(verifiedTime && checkedTime);
      assert.ok(Date.parse(verifiedTime) >= Date.parse(checkedTime), action);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("locked metadata synchronization adopts and releases its existing review lease", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const deletedLeasePath = join(root, "deleted-lease");
    for (const directory of [itemsDir, closedDir, plansDir])
      mkdirSync(directory, { recursive: true });
    const reviewedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const syncedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const issue = {
      number: 321,
      title: "Locked metadata with matching lease",
      body: "Reviewed source.",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: reviewedAt,
      closed_at: null,
      state: "open",
      locked: true,
      active_lock_reason: "resolved",
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 2,
      pull_request: null,
    };
    const sourceRevision = itemSourceRevisionSha256ForTest(issue, []);
    const reviewed = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        title: issue.title,
        decision: "keep_open",
        close_reason: "none",
        action_taken: "kept_open",
        reviewed_at: reviewedAt,
        item_updated_at: reviewedAt,
        labels: "[]",
        item_source_revision: sourceRevision,
        review_lease_owner: "completed-review",
        review_lease_comment_id: "700321",
      }),
      321,
      "none",
    );
    writeFileSync(
      join(itemsDir, "321.md"),
      reviewed.report
        .replace(/^review_comment_synced_at:.*$/m, `review_comment_synced_at: ${syncedAt}`)
        .replaceAll(
          "https://github.com/openclaw/clawsweeper/issues/321",
          "https://github.com/openclaw/openclaw/issues/321",
        ),
    );
    const durable = {
      id: 9321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
      created_at: syncedAt,
      updated_at: syncedAt,
      user: { login: "clawsweeper[bot]" },
      body: reviewed.comment,
    };
    const leaseStartedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const lease = {
      id: 700321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-700321",
      created_at: leaseStartedAt,
      updated_at: leaseStartedAt,
      user: { login: "clawsweeper[bot]" },
      body: renderReviewStartStatusComment({
        number: 321,
        kind: "issue",
        title: issue.title,
        headSha: sourceRevision,
        startedAt: leaseStartedAt,
        leaseExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        leaseOwner: "completed-review",
      }),
    };
    const ghMock = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method")) throw new Error("locked issue must not post a new lease");
  console.log(JSON.stringify([[${JSON.stringify(durable)}, ${JSON.stringify(lease)}]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (args[0] === "api" && /\\/issues\\/comments\\/700321$/.test(path) && args.includes("DELETE")) {
  require("node:fs").writeFileSync(${JSON.stringify(deletedLeasePath)}, "deleted");
  console.log("");
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "edit")) {
  console.log("");
} else {
  throw new Error("unexpected gh args " + JSON.stringify(args));
}`;
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
    assert.equal(JSON.parse(readText(reportPath))[0].action, "review_comment_synced");
    assert.equal(existsSync(deletedLeasePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("comment-only sync defers the remaining batch when GitHub is rate limited", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const originalReport = implementedCloseReport();
    writeFileSync(join(itemsDir, "321.md"), originalReport, "utf8");

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.error("gh: API rate limit exceeded for installation. (HTTP 403)");
  process.exit(1);
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

    const report = JSON.parse(readText(reportPath));
    assert.deepEqual(
      report.map((result) => ({ number: result.number, action: result.action })),
      [
        { number: 321, action: "skipped_runtime_budget" },
        { number: 0, action: "skipped_runtime_budget" },
      ],
    );
    for (const result of report) {
      assert.match(result.reason, /rate limited until .*apply resumes next cycle/);
    }
    assert.equal(readText(join(itemsDir, "321.md")), originalReport);
    assert.equal(existsSync(join(closedDir, "321.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close-mode apply defers the remaining scan window when GitHub is rate limited", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const originalReport = implementedCloseReport();
    writeFileSync(join(itemsDir, "321.md"), originalReport, "utf8");

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.error("gh: API rate limit exceeded for installation. (HTTP 403)");
  process.exit(1);
}
console.error("unexpected gh args", JSON.stringify(args));
process.exit(1);
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    const report = JSON.parse(readText(reportPath));
    assert.deepEqual(
      report.map((result) => ({ number: result.number, action: result.action })),
      [
        { number: 321, action: "skipped_runtime_budget" },
        { number: 0, action: "skipped_runtime_budget" },
      ],
    );
    for (const result of report) {
      assert.match(result.reason, /rate limited until .*apply resumes next cycle/);
    }
    assert.equal(readText(join(itemsDir, "321.md")), originalReport);
    assert.equal(existsSync(join(closedDir, "321.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
