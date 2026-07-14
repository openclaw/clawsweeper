import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { guardedOpenApplyProofFields } from "../dist/clawsweeper.js";
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

test("apply-decisions rejects recorded PR review activity drift before mutations", () => {
  const reviewedCursor = createReviewedPrActivityCursor({
    reviews: [],
    inlineComments: [],
    reviewThreads: [],
  });
  assert.ok(reviewedCursor);

  for (const scenario of [
    {
      name: "review",
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
      reviews: [],
      inlineComments: [],
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

test("apply-decisions fails closed without a reviewed PR activity cursor", () => {
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
        title: "Legacy reviewed PR",
        url: "https://github.com/openclaw/openclaw/pull/321",
        author: "reporter",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify([]),
        pull_head_sha: "head-sha",
        review_activity_cursor: "unknown",
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 321,
        title: "Legacy reviewed PR",
        labels: [],
        comment: synced.comment,
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
        action: "kept_open",
        reason: "stored pull request review activity cursor is missing; fresh review required",
      },
    ]);
    assert.equal(existsSync(mutationLogPath), false);
    assert.match(readText(join(itemsDir, "321.md")), /^action_taken: proposed_close$/m);
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

test("event apply emits proof only while a captured protected-label guard remains live", () => {
  for (const labels of [["security"], []]) {
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
const path = args[1] || "";
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
          extraArgs: ["--event-apply-proof"],
        });
      });

      assert.deepEqual(
        JSON.parse(readText(reportPath)),
        labels.length > 0
          ? [
              {
                number: 321,
                action: "skipped_protected_label",
                reason: "protected label: security",
                guardedOpenStateVerified: true,
              },
            ]
          : [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
          extraArgs: ["--event-apply-proof"],
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
          : [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
