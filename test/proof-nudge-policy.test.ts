import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  botProofCandidateRecordsForTest,
  botProofEligibilityForTest,
  main,
  proofNudgeCandidateRecordsForTest,
  proofNudgeEligibilityForTest,
  renderBotProofDecisionCommentForTest,
  renderProofNudgeCommentForTest,
  rotateProofLaneCandidatesForTest,
} from "../dist/clawsweeper.js";
import { item, tmpPrefix, withMockGh } from "./helpers.ts";

function proofNudgeReport(overrides = {}) {
  const values = {
    labels: JSON.stringify(["triage: needs-real-behavior-proof"]),
    authorAssociation: "CONTRIBUTOR",
    author: "contributor",
    reviewStatus: "complete",
    headSha: "abc123def456",
    reviewedAt: "2026-01-01T00:00:00Z",
    itemCategory: "feature",
    pullFiles: JSON.stringify(["src/app.ts"]),
    proofStatus: "missing",
    evidenceKind: "none",
    needsContributorAction: "true",
    proofSummary: "The PR needs after-fix proof from a real setup.",
    securityReviewStatus: "cleared",
    securityReviewSummary: "No security-sensitive review is needed for this proof nudge.",
    mantisStatus: "not_recommended",
    mantisScenario: "none",
    mantisReason: "Mantis proof is not useful for this sample.",
    mantisComment: "",
    ...overrides,
  };
  return `---
repository: openclaw/openclaw
number: 42
type: pull_request
title: Proof nudge sample
author: ${values.author}
author_association: ${values.authorAssociation}
labels: ${values.labels}
item_category: ${values.itemCategory}
review_status: ${values.reviewStatus}
pull_files: ${values.pullFiles}
pull_files_truncated: false
pull_head_sha: ${values.headSha}
reviewed_at: ${values.reviewedAt}
---

## Real Behavior Proof

Status: ${values.proofStatus}

Evidence kind: ${values.evidenceKind}

Needs contributor action: ${values.needsContributorAction}

Summary: ${values.proofSummary}

## Security Review

Status: ${values.securityReviewStatus}

Summary: ${values.securityReviewSummary}

## Mantis Recommendation

Status: ${values.mantisStatus}

Scenario: ${values.mantisScenario}

Reason: ${values.mantisReason}

Maintainer comment: ${values.mantisComment}
`;
}

function proofNudgeItem(overrides = {}) {
  return item({
    kind: "pull_request",
    number: 42,
    title: "Proof nudge sample",
    author: "contributor",
    authorAssociation: "CONTRIBUTOR",
    labels: ["triage: needs-real-behavior-proof"],
    locked: false,
    activeLockReason: null,
    ...overrides,
  });
}

function closedProofLaneGhMockScript(numbers: readonly number[]): string {
  return `#!/usr/bin/env node
const handled = new Set(${JSON.stringify(numbers)});
const args = process.argv.slice(2);
const path = args[1] || "";
const issueMatch = path.match(/\\/issues\\/(\\d+)$/);
if (issueMatch && handled.has(Number(issueMatch[1]))) {
  const number = Number(issueMatch[1]);
  const bot = number >= 50;
  console.log(JSON.stringify({
    number,
    title: bot ? "Closed bot proof sample" : "Closed proof nudge sample",
    html_url: "https://github.com/openclaw/openclaw/pull/" + number,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: "2026-01-03T00:00:00Z",
    state: "closed",
    locked: false,
    active_lock_reason: null,
    author_association: bot ? "NONE" : "CONTRIBUTOR",
    user: { login: bot ? "app/clawsweeper" : "contributor" },
    labels: ["triage: needs-real-behavior-proof"],
    pull_request: {}
  }));
  process.exit(0);
}
const pullMatch = path.match(/\\/pulls\\/(\\d+)$/);
if (pullMatch && handled.has(Number(pullMatch[1]))) {
  console.log(JSON.stringify({ draft: false, head: { sha: null, repo: { full_name: null } } }));
  process.exit(0);
}
console.error("unexpected gh args: " + args.join(" "));
process.exit(1);
`;
}

test("bot proof candidate scan prioritizes ClawSweeper proof blockers", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    writeFileSync(
      join(root, "41.md"),
      proofNudgeReport({
        number: 41,
        author: "contributor",
        reviewedAt: "2026-01-05T00:00:00Z",
      }),
    );
    writeFileSync(
      join(root, "42.md"),
      proofNudgeReport({
        author: "app/clawsweeper",
        reviewedAt: "2026-01-01T00:00:00Z",
      }),
    );

    assert.deepEqual(
      botProofCandidateRecordsForTest(root).map((candidate) => candidate.number),
      [42, 41],
    );
    assert.deepEqual(
      botProofCandidateRecordsForTest(root, [41]).map((candidate) => candidate.number),
      [41],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof handling selects maintainer or Mantis proof path for ClawSweeper PRs", () => {
  const baseOptions = {
    item: proofNudgeItem({
      author: "app/clawsweeper",
      labels: ["triage: needs-real-behavior-proof", "status: 📣 needs proof", "stale"],
    }),
    headSha: "abc123def456",
  };
  const decision = botProofEligibilityForTest({
    ...baseOptions,
    markdown: proofNudgeReport({ author: "app/clawsweeper" }),
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.action, "bot_proof_decision_planned");

  const mantis = botProofEligibilityForTest({
    ...baseOptions,
    markdown: proofNudgeReport({
      author: "app/clawsweeper",
      mantisStatus: "recommended",
      mantisScenario: "telegram_desktop_proof",
      mantisReason: "Native Telegram Desktop proof would show the visible topic behavior.",
      mantisComment: "@openclaw-mantis telegram desktop proof: verify the topic behavior",
    }),
  });
  assert.equal(mantis.eligible, true);
  assert.equal(mantis.action, "bot_proof_mantis_request_planned");

  const webUiChat = botProofEligibilityForTest({
    ...baseOptions,
    markdown: proofNudgeReport({
      author: "app/clawsweeper",
      mantisStatus: "recommended",
      mantisScenario: "web_ui_chat_proof",
      mantisReason: "A web UI chat proof would show the changed transcript behavior.",
      mantisComment:
        "@openclaw-mantis web UI chat proof: verify the active chat transcript behavior",
    }),
  });
  assert.equal(webUiChat.eligible, true);
  assert.equal(webUiChat.action, "bot_proof_mantis_request_planned");

  const webUiChatCodeBlock = botProofEligibilityForTest({
    ...baseOptions,
    markdown: proofNudgeReport({
      author: "app/clawsweeper",
      mantisStatus: "recommended",
      mantisScenario: "web_ui_chat_proof",
      mantisReason: "A web UI chat proof would show the changed transcript behavior.",
      mantisComment:
        "@openclaw-mantis web UI chat proof: verify the assistant can post a code block in the chat transcript",
    }),
  });
  assert.equal(webUiChatCodeBlock.eligible, true);
  assert.equal(webUiChatCodeBlock.action, "bot_proof_mantis_request_planned");

  const manualVisual = botProofEligibilityForTest({
    ...baseOptions,
    markdown: proofNudgeReport({
      author: "app/clawsweeper",
      mantisStatus: "recommended",
      mantisScenario: "visual_task",
      mantisReason: "A visual proof task would show the fixed Control UI behavior.",
      mantisComment: "@openclaw-mantis capture Control UI proof for this PR",
    }),
  });
  assert.equal(manualVisual.eligible, true);
  assert.equal(manualVisual.action, "bot_proof_decision_planned");

  const invalidMantisCommand = botProofEligibilityForTest({
    ...baseOptions,
    markdown: proofNudgeReport({
      author: "app/clawsweeper",
      mantisStatus: "recommended",
      mantisScenario: "telegram_desktop_proof",
      mantisReason: "Native Telegram Desktop proof would show the visible topic behavior.",
      mantisComment: "@mantis telegram desktop proof: verify the topic behavior",
    }),
  });
  assert.equal(invalidMantisCommand.eligible, true);
  assert.equal(invalidMantisCommand.action, "bot_proof_decision_planned");

  const mutationMantisCommand = botProofEligibilityForTest({
    ...baseOptions,
    markdown: proofNudgeReport({
      author: "app/clawsweeper",
      mantisStatus: "recommended",
      mantisScenario: "telegram_desktop_proof",
      mantisReason: "The Telegram behavior still needs live proof and a branch repair.",
      mantisComment: "@openclaw-mantis fix this PR and push the repaired branch",
    }),
  });
  assert.equal(mutationMantisCommand.eligible, true);
  assert.equal(mutationMantisCommand.action, "bot_proof_decision_planned");

  for (const maintainerComment of [
    "@openclaw-mantis verify the Telegram behavior and mark this PR ready for review",
    "@openclaw-mantis verify the Telegram behavior and enable automerge",
    "@openclaw-mantis verify the Telegram behavior and request a review from maintainers",
  ]) {
    const prStateMutation = botProofEligibilityForTest({
      ...baseOptions,
      markdown: proofNudgeReport({
        author: "app/clawsweeper",
        mantisStatus: "recommended",
        mantisScenario: "telegram_desktop_proof",
        mantisReason: "The Telegram behavior needs live proof.",
        mantisComment: maintainerComment,
      }),
    });
    assert.equal(prStateMutation.eligible, true);
    assert.equal(prStateMutation.action, "bot_proof_decision_planned");
  }

  assert.equal(
    botProofEligibilityForTest({
      item: proofNudgeItem({
        author: "clawsweeper[bot]",
        labels: ["status: 📣 needs proof"],
      }),
      markdown: proofNudgeReport({ author: "app/clawsweeper" }),
      headSha: "abc123def456",
    }).action,
    "bot_proof_decision_planned",
  );
});

test("bot proof handling skips overrides, stale heads, drafts, and non-ClawSweeper PRs", () => {
  const baseItem = proofNudgeItem({
    author: "app/clawsweeper",
    labels: ["triage: needs-real-behavior-proof"],
  });
  assert.equal(
    botProofEligibilityForTest({
      item: proofNudgeItem({ author: "contributor" }),
      markdown: proofNudgeReport(),
      headSha: "abc123def456",
    }).action,
    "skipped_not_bot_authored",
  );
  assert.equal(
    botProofEligibilityForTest({
      item: baseItem,
      markdown: proofNudgeReport({ author: "app/clawsweeper" }),
      headSha: "abc123def456",
      draft: true,
    }).action,
    "skipped_draft",
  );
  for (const label of ["proof: override", "proof: sufficient"] as const) {
    assert.equal(
      botProofEligibilityForTest({
        item: proofNudgeItem({
          author: "app/clawsweeper",
          labels: ["triage: needs-real-behavior-proof", label],
        }),
        markdown: proofNudgeReport({ author: "app/clawsweeper" }),
        headSha: "abc123def456",
      }).action,
      "skipped_policy_exempt",
    );
  }
  assert.equal(
    botProofEligibilityForTest({
      item: baseItem,
      markdown: proofNudgeReport({ author: "app/clawsweeper", headSha: "oldhead" }),
      headSha: "newhead",
    }).action,
    "skipped_stale_report_head",
  );
});

test("bot proof status comment asks maintainers without contributor nudge copy", () => {
  const markdown = proofNudgeReport({
    author: "app/clawsweeper",
    mantisStatus: "recommended",
    mantisScenario: "visual_task",
    mantisReason: "A visual proof task would show the fixed Control UI behavior.",
    mantisComment: "@openclaw-mantis capture Control UI proof for this PR",
  });
  const comment = renderBotProofDecisionCommentForTest({
    number: 42,
    headSha: "abc123def456",
    markdown,
  });

  assert.match(comment, /ClawSweeper-authored replacement PR is blocked on real behavior proof/);
  assert.match(comment, /proof: override/);
  assert.match(comment, /Proof path suggestion/);
  assert.match(comment, /Mantis is currently scoped to Telegram, Discord, and web UI chat proof/);
  assert.match(comment, /browser or Playwright proof/);
  assert.doesNotMatch(comment, /Possible manual Mantis\/desktop proof suggestion/);
  assert.doesNotMatch(comment, /@openclaw-mantis capture Control UI proof/);
  assert.match(comment, /<!-- clawsweeper-bot-proof-decision item="42" sha="abc123def456"/);
  assert.doesNotMatch(comment, /thanks for the PR/);
  assert.doesNotMatch(comment, /Once proof is added/);
});

test("bot proof status routes mutation-oriented Mantis commands to ClawSweeper", () => {
  const markdown = proofNudgeReport({
    author: "app/clawsweeper",
    mantisStatus: "recommended",
    mantisScenario: "telegram_desktop_proof",
    mantisReason: "The Telegram behavior still needs live proof and a branch repair.",
    mantisComment: "@openclaw-mantis fix this PR and push the repaired branch",
  });
  const comment = renderBotProofDecisionCommentForTest({
    number: 42,
    headSha: "abc123def456",
    markdown,
  });

  assert.match(comment, /Proof path suggestion/);
  assert.match(comment, /Mantis is proof-only/);
  assert.match(comment, /ClawSweeper's repair, apply, or automerge lanes/);
  assert.doesNotMatch(comment, /@openclaw-mantis fix this PR/);
});

test("proof nudge candidate scan defers proof-label checks to live PR state", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    writeFileSync(join(root, "41.md"), proofNudgeReport({ reviewedAt: "2026-01-05T00:00:00Z" }));
    writeFileSync(
      join(root, "42.md"),
      `---
repository: openclaw/openclaw
number: 42
type: pull_request
labels: []
review_status: complete
reviewed_at: 2026-01-01T00:00:00Z
---

## Summary

Stored report label snapshots can be older than the live PR labels.
`,
    );

    const requestedCandidates = proofNudgeCandidateRecordsForTest(root, [42]);
    const allCandidates = proofNudgeCandidateRecordsForTest(root);

    assert.deepEqual(
      requestedCandidates.map((candidate) => candidate.number),
      [42],
    );
    assert.deepEqual(
      allCandidates.map((candidate) => candidate.number),
      [41, 42],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof nudge candidate rotation resumes after the cursor", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    writeFileSync(join(root, "41.md"), proofNudgeReport({ reviewedAt: "2026-01-01T00:00:00Z" }));
    writeFileSync(join(root, "42.md"), proofNudgeReport({ reviewedAt: "2026-01-02T00:00:00Z" }));
    writeFileSync(join(root, "43.md"), proofNudgeReport({ reviewedAt: "2026-01-03T00:00:00Z" }));

    const candidates = proofNudgeCandidateRecordsForTest(root);
    assert.deepEqual(
      rotateProofLaneCandidatesForTest(candidates, {
        likely: true,
        number: 42,
        sortAt: Date.parse("2026-01-02T00:00:00Z"),
      }).map((candidate) => candidate.number),
      [43, 41, 42],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof lane execute scans advance cursors to the last processed candidate", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const cases = [
      { command: "proof-nudges", lane: "proof_nudges", numbers: [41, 42], bot: false },
      { command: "bot-proof", lane: "bot_proof", numbers: [51, 52], bot: true },
    ] as const;
    withMockGh(root, closedProofLaneGhMockScript(cases.flatMap(({ numbers }) => numbers)), () => {
      for (const { command, lane, numbers, bot } of cases) {
        const itemsDir = join(root, command);
        const cursorPath = join(root, "results", `${command}-cursors`, "openclaw-openclaw.json");
        mkdirSync(itemsDir, { recursive: true });
        numbers.forEach((number, index) =>
          writeFileSync(
            join(itemsDir, `${number}.md`),
            proofNudgeReport({
              author: bot ? "app/clawsweeper" : "contributor",
              authorAssociation: bot ? "NONE" : "CONTRIBUTOR",
              reviewedAt: `2026-01-0${index + 1}T00:00:00Z`,
            }),
          ),
        );
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          command,
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--processed-limit",
          "2",
          "--report-path",
          join(root, `${command}.json`),
          "--cursor-path",
          cursorPath,
          "--execute",
        ]);
        const cursor = JSON.parse(readFileSync(cursorPath, "utf8"));
        assert.deepEqual(
          {
            repository: cursor.repository,
            lane: cursor.lane,
            number: cursor.next_cursor_number,
            likely: cursor.next_cursor_likely,
            sortAt: cursor.next_cursor_sort_at_ms,
            reviewedAt: cursor.reviewed_at,
          },
          {
            repository: "openclaw/openclaw",
            lane,
            number: numbers[1],
            likely: true,
            sortAt: Date.parse("2026-01-02T00:00:00Z"),
            reviewedAt: "2026-01-02T00:00:00Z",
          },
        );
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("targeted proof lane execute scans ignore cursor paths", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const cases = [
      { command: "proof-nudges", number: 42, bot: false },
      { command: "bot-proof", number: 52, bot: true },
    ] as const;
    withMockGh(root, closedProofLaneGhMockScript([42, 52]), () => {
      for (const { command, number, bot } of cases) {
        const itemsDir = join(root, command);
        const cursorPath = join(root, `${command}-cursor.json`);
        mkdirSync(itemsDir, { recursive: true });
        writeFileSync(
          join(itemsDir, `${number}.md`),
          proofNudgeReport({
            author: bot ? "app/clawsweeper" : "contributor",
            authorAssociation: bot ? "NONE" : "CONTRIBUTOR",
          }),
        );
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          command,
          "--items-dir",
          itemsDir,
          "--item-numbers",
          String(number),
          "--report-path",
          join(root, `${command}.json`),
          "--cursor-path",
          cursorPath,
          "--execute",
        ]);
        assert.equal(existsSync(cursorPath), false);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof lanes reject non-positive processed limits", async () => {
  for (const command of ["proof-nudges", "bot-proof"]) {
    await assert.rejects(main([command, "--processed-limit", "0"]), /positive integer/);
  }
});

test("proof nudges skip stale targeted PRs when live GitHub state cannot be fetched", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "proof-nudge-report.json");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ number: 42 }));
    writeFileSync(join(itemsDir, "43.md"), proofNudgeReport({ number: 43 }));
    withMockGh(
      root,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const path = args[1] || "";
if (path.endsWith("/issues/42")) {
  console.error("Not Found");
  process.exit(1);
}
if (path.endsWith("/issues/43")) {
  console.log(JSON.stringify({
    number: 43,
    title: "Closed proof nudge sample",
    html_url: "https://github.com/openclaw/openclaw/pull/43",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: "2026-01-03T00:00:00Z",
    state: "closed",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: ["triage: needs-real-behavior-proof"],
    pull_request: {}
  }));
  process.exit(0);
}
console.error("unexpected gh args: " + args.join(" "));
process.exit(1);
`,
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "proof-nudges",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42,43",
          "--limit",
          "10",
          "--processed-limit",
          "10",
          "--report-path",
          reportPath,
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(
      report.map((entry: { number: number; action: string }) => [entry.number, entry.action]),
      [
        [42, "skipped_live_fetch_failed"],
        [43, "skipped_not_open"],
      ],
    );
    assert.match(report[0].reason, /live GitHub state could not be fetched/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof nudges become eligible only after proof policy and age gates pass", () => {
  const result = proofNudgeEligibilityForTest({
    item: proofNudgeItem(),
    markdown: proofNudgeReport(),
    headSha: "abc123def456",
    headCommittedAt: "2026-01-01T00:00:00Z",
    now: Date.parse("2026-01-10T00:00:00Z"),
    minAgeDays: 5,
    cooldownDays: 7,
  });

  assert.equal(result.eligible, true);
  assert.equal(result.action, "proof_nudge_planned");
});

test("proof nudges skip recent reviews and recent author activity", () => {
  assert.equal(
    proofNudgeEligibilityForTest({
      item: proofNudgeItem(),
      markdown: proofNudgeReport({ reviewedAt: "2026-01-08T00:00:00Z" }),
      headSha: "abc123def456",
      headCommittedAt: "2026-01-01T00:00:00Z",
      now: Date.parse("2026-01-10T00:00:00Z"),
      minAgeDays: 5,
      cooldownDays: 7,
    }).action,
    "skipped_recent_review",
  );
  assert.equal(
    proofNudgeEligibilityForTest({
      item: proofNudgeItem(),
      markdown: proofNudgeReport(),
      comments: [
        {
          author: "contributor",
          body: "I'll add proof later.",
          updatedAt: "2026-01-09T00:00:00Z",
        },
      ],
      headSha: "abc123def456",
      headCommittedAt: "2026-01-01T00:00:00Z",
      now: Date.parse("2026-01-10T00:00:00Z"),
      minAgeDays: 5,
      cooldownDays: 7,
    }).action,
    "skipped_recent_author_activity",
  );
  assert.equal(
    proofNudgeEligibilityForTest({
      item: proofNudgeItem(),
      markdown: proofNudgeReport(),
      headSha: "abc123def456",
      headCommittedAt: "2026-01-01T00:00:00Z",
      authorEditedAt: "2026-01-09T00:00:00Z",
      now: Date.parse("2026-01-10T00:00:00Z"),
      minAgeDays: 5,
      cooldownDays: 7,
    }).action,
    "skipped_recent_author_activity",
  );
  assert.equal(
    proofNudgeEligibilityForTest({
      item: proofNudgeItem(),
      markdown: proofNudgeReport(),
      headSha: "abc123def456",
      headCommittedAt: "2026-01-01T00:00:00Z",
      authorReviewActivityAt: "2026-01-09T00:00:00Z",
      now: Date.parse("2026-01-10T00:00:00Z"),
      minAgeDays: 5,
      cooldownDays: 7,
    }).action,
    "skipped_recent_author_activity",
  );
  const maintainerActivity = proofNudgeEligibilityForTest({
    item: proofNudgeItem({ updatedAt: "2026-01-09T00:00:00Z" }),
    markdown: proofNudgeReport(),
    comments: [
      { author: "maintainer", body: "Queued for review.", updatedAt: "2026-01-09T00:00:00Z" },
    ],
    headSha: "abc123def456",
    headCommittedAt: "2026-01-01T00:00:00Z",
    now: Date.parse("2026-01-10T00:00:00Z"),
    minAgeDays: 5,
    cooldownDays: 7,
  });

  assert.equal(maintainerActivity.eligible, true);
  assert.equal(maintainerActivity.action, "proof_nudge_planned");
});

test("proof nudges use same-head cooldown markers instead of label churn", () => {
  const comment = renderProofNudgeCommentForTest({
    number: 42,
    author: "contributor",
    headSha: "abc123def456",
    timestamp: "2026-01-08T00:00:00.000Z",
  });
  const result = proofNudgeEligibilityForTest({
    item: proofNudgeItem(),
    markdown: proofNudgeReport(),
    comments: [{ author: "clawsweeper[bot]", body: comment, updatedAt: "2026-01-08T00:00:00Z" }],
    headSha: "abc123def456",
    headCommittedAt: "2026-01-01T00:00:00Z",
    now: Date.parse("2026-01-10T00:00:00Z"),
    minAgeDays: 5,
    cooldownDays: 7,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.action, "skipped_recent_nudge");
  assert.match(comment, /<!-- clawsweeper-proof-nudge item="42" sha="abc123def456"/);

  const spoofedMarker = proofNudgeEligibilityForTest({
    item: proofNudgeItem(),
    markdown: proofNudgeReport(),
    comments: [{ author: "someoneelse", body: comment, updatedAt: "2026-01-08T00:00:00Z" }],
    headSha: "abc123def456",
    headCommittedAt: "2026-01-01T00:00:00Z",
    now: Date.parse("2026-01-10T00:00:00Z"),
    minAgeDays: 5,
    cooldownDays: 7,
  });

  assert.equal(spoofedMarker.eligible, true);
  assert.equal(spoofedMarker.action, "proof_nudge_planned");

  const malformedMarker = proofNudgeEligibilityForTest({
    item: proofNudgeItem(),
    markdown: proofNudgeReport(),
    comments: [
      {
        author: "clawsweeper[bot]",
        body: `<!-- clawsweeper-proof-nudge ${"a".repeat(5000)} -->`,
        updatedAt: "2026-01-08T00:00:00Z",
      },
    ],
    headSha: "abc123def456",
    headCommittedAt: "2026-01-01T00:00:00Z",
    now: Date.parse("2026-01-10T00:00:00Z"),
    minAgeDays: 5,
    cooldownDays: 7,
  });

  assert.equal(malformedMarker.eligible, true);
  assert.equal(malformedMarker.action, "proof_nudge_planned");
});

test("proof nudges skip stale report heads and proof-policy exemptions", () => {
  assert.equal(
    proofNudgeEligibilityForTest({
      item: proofNudgeItem(),
      markdown: proofNudgeReport({ headSha: "oldhead" }),
      headSha: "newhead",
      headCommittedAt: "2026-01-01T00:00:00Z",
      now: Date.parse("2026-01-10T00:00:00Z"),
    }).action,
    "skipped_stale_report_head",
  );
  assert.equal(
    proofNudgeEligibilityForTest({
      item: proofNudgeItem(),
      markdown: proofNudgeReport({ headSha: "unknown" }),
      headSha: "abc123def456",
      headCommittedAt: "2026-01-01T00:00:00Z",
      now: Date.parse("2026-01-10T00:00:00Z"),
    }).action,
    "skipped_stale_report_head",
  );
  assert.equal(
    proofNudgeEligibilityForTest({
      item: proofNudgeItem({ labels: ["triage: needs-real-behavior-proof", "proof: override"] }),
      markdown: proofNudgeReport({
        labels: JSON.stringify(["triage: needs-real-behavior-proof", "proof: override"]),
      }),
      headSha: "abc123def456",
      headCommittedAt: "2026-01-01T00:00:00Z",
      now: Date.parse("2026-01-10T00:00:00Z"),
    }).action,
    "skipped_policy_exempt",
  );
  assert.equal(
    proofNudgeEligibilityForTest({
      item: proofNudgeItem(),
      markdown: proofNudgeReport({
        proofStatus: "not_applicable",
        needsContributorAction: "false",
        reviewStatus: "failed",
      }),
      headSha: "abc123def456",
      headCommittedAt: "2026-01-01T00:00:00Z",
      now: Date.parse("2026-01-10T00:00:00Z"),
    }).action,
    "skipped_policy_exempt",
  );
  assert.equal(
    proofNudgeEligibilityForTest({
      item: proofNudgeItem({ labels: ["proof: supplied"] }),
      markdown: proofNudgeReport(),
      headSha: "abc123def456",
      headCommittedAt: "2026-01-01T00:00:00Z",
      now: Date.parse("2026-01-10T00:00:00Z"),
    }).action,
    "proof_nudge_planned",
  );
});

test("proof nudges skip maintainer, bot, security, and release PRs", () => {
  for (const [input, expected] of [
    [proofNudgeItem({ authorAssociation: "MEMBER" }), "skipped_maintainer_authored"],
    [proofNudgeItem({ author: "dependabot[bot]" }), "skipped_bot_authored"],
    [
      proofNudgeItem({
        labels: ["triage: needs-real-behavior-proof", "clawsweeper:needs-security-review"],
      }),
      "skipped_protected_label",
    ],
    [proofNudgeItem({ title: "Release 1.2.3" }), "skipped_protected_label"],
    [proofNudgeItem({ title: "chore(release): 1.2.3" }), "skipped_protected_label"],
  ] as const) {
    assert.equal(
      proofNudgeEligibilityForTest({
        item: input,
        markdown: proofNudgeReport({
          author: input.author,
          authorAssociation: input.authorAssociation,
          labels: JSON.stringify(input.labels),
        }),
        headSha: "abc123def456",
        headCommittedAt: "2026-01-01T00:00:00Z",
        now: Date.parse("2026-01-10T00:00:00Z"),
      }).action,
      expected,
    );
  }

  for (const [markdown, expectedReason] of [
    [
      proofNudgeReport({
        itemCategory: "security",
      }),
      "latest report item category is security",
    ],
    [
      proofNudgeReport({
        securityReviewStatus: "needs_attention",
        securityReviewSummary: "The patch changes token handling and needs maintainer review.",
      }),
      "latest report security review needs attention",
    ],
  ] as const) {
    const result = proofNudgeEligibilityForTest({
      item: proofNudgeItem(),
      markdown,
      headSha: "abc123def456",
      headCommittedAt: "2026-01-01T00:00:00Z",
      now: Date.parse("2026-01-10T00:00:00Z"),
    });
    assert.equal(result.action, "skipped_protected_label");
    assert.equal(result.reason, expectedReason);
  }
});

test("proof nudges skip locked PR conversations before posting", () => {
  const result = proofNudgeEligibilityForTest({
    item: proofNudgeItem({ locked: true, activeLockReason: "resolved" }),
    markdown: proofNudgeReport(),
    headSha: "abc123def456",
    headCommittedAt: "2026-01-01T00:00:00Z",
    now: Date.parse("2026-01-10T00:00:00Z"),
  });

  assert.equal(result.eligible, false);
  assert.equal(result.action, "skipped_locked_conversation");
  assert.match(result.reason, /conversation is locked \(resolved\)/);
});

test("proof nudge copy asks for evidence without promising author-only re-review access", () => {
  const comment = renderProofNudgeCommentForTest({
    number: 42,
    author: "contributor",
    headSha: "abc123def456",
  });

  assert.match(comment, /^@contributor thanks for the PR\./);
  assert.match(comment, /screenshot, short video, terminal output/);
  assert.match(comment, /ClawSweeper or a maintainer can re-check it/);
  assert.doesNotMatch(comment, /@clawsweeper re-review/);
});
