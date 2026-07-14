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
  satisfiedBotProofLabelMutationIdentitiesForTest,
} from "../dist/clawsweeper.js";
import { item, tmpPrefix, withMockGh } from "./helpers.ts";

function proofNudgeReport(overrides = {}) {
  const values = {
    number: 42,
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
number: ${values.number}
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

function proofMutationGhMockScript(options: {
  statePath: string;
  mutationLogPath: string;
  bot?: boolean;
  driftHeadAtPullRead?: number;
  driftReviewAtRead?: number;
  driftConversationAtRead?: number;
  driftLabelAtIssueRead?: number;
  driftLabel?: string;
  lockAtIssueRead?: number;
  closeAtIssueRead?: number;
  draftAtPullRead?: number;
  postUnknown?: boolean;
  patchUnknown?: boolean;
  unknownMutation?: string;
  initialComments?: unknown[];
  initialLabels?: string[];
  deleteCommentsAtConversationRead?: number;
  revealCommentsAtConversationRead?: number;
  hideUnknownPostComment?: boolean;
  failConversationReadsAfterUnknownPost?: boolean;
  itemNumbers?: number[];
}): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const config = ${JSON.stringify(options)};
const handledNumbers = new Set(config.itemNumbers || [42]);
const oldHead = "${"a".repeat(40)}";
const newHead = "${"b".repeat(40)}";
const initialLabels = config.initialLabels || (config.bot
  ? ["triage: needs-real-behavior-proof", "stale"]
  : ["triage: needs-real-behavior-proof"]);
const state = fs.existsSync(config.statePath)
  ? JSON.parse(fs.readFileSync(config.statePath, "utf8"))
  : {
      pullReads: 0,
      issueReads: 0,
      reviewReads: 0,
      conversationReads: 0,
      labels: initialLabels,
      createdLabels: [],
      comments: config.initialComments || []
    };
const save = () => fs.writeFileSync(config.statePath, JSON.stringify(state));
const logMutation = (value) => fs.appendFileSync(config.mutationLogPath, value + "\\n");
const output = (value) => {
  save();
  console.log(JSON.stringify(value));
  process.exit(0);
};
const args = process.argv.slice(2);
const commandArgs = args[0] === "--repo" ? args.slice(2) : args;
const path = commandArgs[1] || "";
const methodIndex = commandArgs.indexOf("--method");
const method = methodIndex >= 0 ? commandArgs[methodIndex + 1] : "GET";
const currentHead = () => {
  state.pullReads += 1;
  return config.driftHeadAtPullRead && state.pullReads >= config.driftHeadAtPullRead
    ? newHead
    : oldHead;
};
const unknownAfterMutation = (identity) => {
  if (config.unknownMutation !== identity) return;
  save();
  console.error("HTTP 502: write acknowledgement unavailable");
  process.exit(1);
};
const currentReviews = () => {
  state.reviewReads += 1;
  return config.driftReviewAtRead && state.reviewReads >= config.driftReviewAtRead
    ? [{
        id: 9,
        user: { login: "reviewer" },
        state: "COMMENTED",
        body: "new review activity",
        submitted_at: "2026-07-14T12:00:00Z",
        commit_id: oldHead
      }]
    : [];
};
const currentComments = () => {
  state.conversationReads += 1;
  if (config.failConversationReadsAfterUnknownPost && state.unknownPostAccepted) {
    save();
    console.error("fatal: simulated reconciliation read failure");
    process.exit(1);
  }
  if (
    config.deleteCommentsAtConversationRead &&
    state.conversationReads >= config.deleteCommentsAtConversationRead
  ) {
    state.comments = [];
  }
  const injected = config.driftConversationAtRead &&
      state.conversationReads >= config.driftConversationAtRead
    ? [{
        id: 8,
        user: { login: "contributor" },
        author_association: "CONTRIBUTOR",
        body: "new proof conversation activity",
        created_at: "2026-07-14T12:00:00Z",
        updated_at: "2026-07-14T12:00:00Z",
        html_url: "https://github.com/openclaw/openclaw/pull/42#issuecomment-8"
      }]
    : [];
  const visibleComments = config.hideUnknownPostComment && state.unknownPostAccepted
    ? state.comments.filter((comment) => comment.id !== 99)
    : state.comments;
  if (
    config.revealCommentsAtConversationRead &&
    state.conversationReads < config.revealCommentsAtConversationRead
  ) {
    return injected;
  }
  return [...visibleComments, ...injected];
};
if (commandArgs[0] === "label" && commandArgs[1] === "create") {
  const label = commandArgs[2];
  state.createdLabels = state.createdLabels || [];
  logMutation("label_create:" + label);
  if (state.createdLabels.includes(label)) {
    save();
    console.error("label already exists");
    process.exit(1);
  }
  state.createdLabels.push(label);
  unknownAfterMutation("label_create:" + label);
  output({ name: label });
}
if (commandArgs[0] === "issue" && commandArgs[1] === "edit") {
  const addIndex = commandArgs.indexOf("--add-label");
  const removeIndex = commandArgs.indexOf("--remove-label");
  if (addIndex >= 0) {
    const label = commandArgs[addIndex + 1];
    logMutation("label_add:" + label);
    if (!state.labels.includes(label)) state.labels.push(label);
    unknownAfterMutation("label_add:" + label);
  }
  if (removeIndex >= 0) {
    const label = commandArgs[removeIndex + 1];
    logMutation("label_remove:" + label);
    state.labels = state.labels.filter((entry) => entry !== label);
    unknownAfterMutation("label_remove:" + label);
  }
  output({ labels: state.labels });
}
const issueMatch = path.match(/^repos\\/openclaw\\/openclaw\\/issues\\/(\\d+)$/);
if (issueMatch && handledNumbers.has(Number(issueMatch[1]))) {
  const number = Number(issueMatch[1]);
  state.issueReads = (state.issueReads || 0) + 1;
  if (
    config.driftLabelAtIssueRead &&
    state.issueReads >= config.driftLabelAtIssueRead &&
    config.driftLabel &&
    !state.driftLabelInjected
  ) {
    if (!state.labels.includes(config.driftLabel)) state.labels.push(config.driftLabel);
    state.driftLabelInjected = true;
  }
  output({
    number,
    title: "Proof nudge sample",
    html_url: "https://github.com/openclaw/openclaw/pull/" + number,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    state: config.closeAtIssueRead && state.issueReads >= config.closeAtIssueRead ? "closed" : "open",
    locked: Boolean(config.lockAtIssueRead && state.issueReads >= config.lockAtIssueRead),
    active_lock_reason: null,
    author_association: config.bot ? "NONE" : "CONTRIBUTOR",
    user: { login: config.bot ? "app/clawsweeper" : "contributor" },
    labels: state.labels,
    pull_request: {}
  });
}
const pullMatch = path.match(/^repos\\/openclaw\\/openclaw\\/pulls\\/(\\d+)$/);
if (pullMatch && handledNumbers.has(Number(pullMatch[1]))) {
  const head = currentHead();
  output({
    draft: Boolean(config.draftAtPullRead && state.pullReads >= config.draftAtPullRead),
    head: { sha: head, repo: { full_name: "openclaw/openclaw" } }
  });
}
if (path === "repos/openclaw/openclaw/commits/" + oldHead ||
    path === "repos/openclaw/openclaw/commits/" + newHead) {
  output({
    commit: {
      author: { date: "2026-01-01T00:00:00Z" },
      committer: { date: "2026-01-01T00:00:00Z" }
    },
    authorDate: "2026-01-01T00:00:00Z",
    committerDate: "2026-01-01T00:00:00Z"
  });
}
const reviewMatch = path.match(/^repos\\/openclaw\\/openclaw\\/pulls\\/(\\d+)\\/reviews/);
if (reviewMatch && handledNumbers.has(Number(reviewMatch[1]))) {
  output(currentReviews());
}
const reviewCommentMatch = path.match(
  /^repos\\/openclaw\\/openclaw\\/pulls\\/(\\d+)\\/comments/,
);
if (reviewCommentMatch && handledNumbers.has(Number(reviewCommentMatch[1]))) {
  output([]);
}
const timelineMatch = path.match(/^repos\\/openclaw\\/openclaw\\/issues\\/(\\d+)\\/timeline/);
if (timelineMatch && handledNumbers.has(Number(timelineMatch[1]))) {
  output([]);
}
const issueCommentMatch = path.match(/^repos\\/openclaw\\/openclaw\\/issues\\/(\\d+)\\/comments/);
const issueCommentPatchMatch = path.match(
  /^repos\\/openclaw\\/openclaw\\/issues\\/comments\\/(\\d+)$/,
);
if (issueCommentPatchMatch && method === "PATCH") {
  const commentId = Number(issueCommentPatchMatch[1]);
  const inputIndex = commandArgs.indexOf("--input");
  const payload = JSON.parse(fs.readFileSync(commandArgs[inputIndex + 1], "utf8"));
  const comment = state.comments.find((entry) => entry.id === commentId);
  if (!comment) {
    save();
    console.error("Not Found");
    process.exit(1);
  }
  logMutation("comment_patch");
  if (config.patchUnknown) {
    save();
    console.error("HTTP 502: write acknowledgement unavailable");
    process.exit(1);
  }
  comment.body = payload.body;
  comment.updated_at = "2026-07-14T12:00:00Z";
  output({ id: comment.id, html_url: comment.html_url });
}
if (issueCommentMatch && handledNumbers.has(Number(issueCommentMatch[1])) && method === "POST") {
  const number = Number(issueCommentMatch[1]);
  const inputIndex = commandArgs.indexOf("--input");
  const payload = JSON.parse(fs.readFileSync(commandArgs[inputIndex + 1], "utf8"));
  const comment = {
    id: 99,
    user: { login: "clawsweeper[bot]" },
    author_association: "NONE",
    body: payload.body,
    created_at: "2026-07-14T12:00:00Z",
    updated_at: "2026-07-14T12:00:00Z",
    html_url: "https://github.com/openclaw/openclaw/pull/" + number + "#issuecomment-99"
  };
  state.comments = state.comments.filter((entry) => entry.id !== 99);
  state.comments.push(comment);
  logMutation("comment_post");
  state.unknownPostAccepted = config.postUnknown === true;
  save();
  if (config.postUnknown) {
    console.error("HTTP 502: write acknowledgement unavailable");
    process.exit(1);
  }
  output({ id: comment.id, html_url: comment.html_url });
}
if (issueCommentMatch && handledNumbers.has(Number(issueCommentMatch[1]))) {
  output(currentComments());
}
if (path === "graphql") {
  output({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      }
    }
  });
}
save();
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
      item: proofNudgeItem({
        author: "app/clawsweeper",
        labels: ["triage: needs-real-behavior-proof", "security"],
      }),
      markdown: proofNudgeReport({ author: "app/clawsweeper" }),
      headSha: "abc123def456",
    }).action,
    "skipped_protected_label",
  );
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

test("proof nudges block a comment when conversation activity changes at the request boundary", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "proof-nudge-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ headSha: "a".repeat(40) }));

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        driftConversationAtRead: 6,
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "proof-nudges",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--min-age-days",
          "0",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "skipped_changed_before_mutation");
    assert.match(report[0].reason, /conversation activity changed/);
    assert.equal(existsSync(mutationLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof nudges use author activity hydrated into the mutation baseline", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "proof-nudge-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ headSha: "a".repeat(40) }));

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        driftConversationAtRead: 2,
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "proof-nudges",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--min-age-days",
          "5",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "skipped_changed_before_mutation");
    assert.match(report[0].reason, /author comment.*newer/);
    assert.equal(existsSync(mutationLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof nudges block when the head changes after request-boundary activity hydration", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "proof-nudge-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ headSha: "a".repeat(40) }));

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        driftHeadAtPullRead: 7,
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "proof-nudges",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--min-age-days",
          "0",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "skipped_changed_before_mutation");
    assert.match(report[0].reason, /head changed while hydrating/);
    assert.equal(existsSync(mutationLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof nudges block final eligibility drift after activity hydration", () => {
  const scenarios = [
    {
      name: "protected label",
      config: { driftLabelAtIssueRead: 3, driftLabel: "security" },
    },
    {
      name: "locked conversation",
      config: { lockAtIssueRead: 3 },
    },
    {
      name: "closed pull request",
      config: { closeAtIssueRead: 3 },
    },
    {
      name: "proof override",
      config: { driftLabelAtIssueRead: 3, driftLabel: "proof: override" },
    },
  ];
  for (const scenario of scenarios) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const reportPath = join(root, "proof-nudge-report.json");
      const statePath = join(root, "gh-state.json");
      const mutationLogPath = join(root, "mutations.log");
      mkdirSync(itemsDir, { recursive: true });
      writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ headSha: "a".repeat(40) }));

      withMockGh(
        root,
        proofMutationGhMockScript({
          statePath,
          mutationLogPath,
          ...scenario.config,
        }),
        () => {
          execFileSync(process.execPath, [
            "dist/clawsweeper.js",
            "proof-nudges",
            "--target-repo",
            "openclaw/openclaw",
            "--items-dir",
            itemsDir,
            "--item-numbers",
            "42",
            "--limit",
            "1",
            "--processed-limit",
            "1",
            "--min-age-days",
            "0",
            "--report-path",
            reportPath,
            "--execute",
          ]);
        },
      );

      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(
        report[0].action,
        "skipped_changed_before_mutation",
        `${scenario.name}: ${JSON.stringify(report)}`,
      );
      assert.match(report[0].reason, /live PR eligibility changed while hydrating/);
      assert.equal(existsSync(mutationLogPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("proof nudges reconcile a marker when GitHub accepts the comment before losing the response", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "proof-nudge-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ headSha: "a".repeat(40) }));

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        postUnknown: true,
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "proof-nudges",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--min-age-days",
          "0",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "proof_nudge_reconciled");
    assert.match(report[0].reason, /confirmed after an inconclusive response/);
    assert.equal(readFileSync(mutationLogPath, "utf8").trim(), "comment_post");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciled proof nudges do not consume the delivery limit", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "proof-nudge-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    const headSha = "a".repeat(40);
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "42.md"),
      proofNudgeReport({ number: 42, headSha, reviewedAt: "2026-01-01T00:00:00Z" }),
    );
    writeFileSync(
      join(itemsDir, "43.md"),
      proofNudgeReport({ number: 43, headSha, reviewedAt: "2026-01-02T00:00:00Z" }),
    );

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        itemNumbers: [42, 43],
        initialComments: [
          {
            id: 98,
            user: { login: "clawsweeper[bot]" },
            author_association: "NONE",
            body: `<!-- clawsweeper-proof-nudge item="42" sha="${headSha}" at="2026-07-14T12:00:00.000Z" v="1" -->`,
            created_at: "2026-07-14T12:00:00.000Z",
            updated_at: "2026-07-14T12:00:00.000Z",
            html_url: "https://github.com/openclaw/openclaw/pull/42#issuecomment-98",
          },
        ],
      }),
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
          "1",
          "--processed-limit",
          "2",
          "--min-age-days",
          "0",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(
      report.map((entry: { number: number; action: string }) => [entry.number, entry.action]),
      [
        [42, "proof_nudge_reconciled"],
        [43, "proof_nudge_posted"],
      ],
    );
    assert.equal(readFileSync(mutationLogPath, "utf8").trim(), "comment_post");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof nudges apply hydrated same-head markers to cooldown eligibility", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "proof-nudge-report.json");
    const mutationStateDir = join(root, "proof-nudge-mutations");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    const headSha = "a".repeat(40);
    const markerTimestamp = "2026-07-14T12:00:00.000Z";
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(mutationStateDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ headSha }));
    writeFileSync(
      join(mutationStateDir, "42.json"),
      JSON.stringify({
        schema_version: 1,
        repository: "openclaw/openclaw",
        number: 42,
        head_sha: headSha,
        marker_timestamp: markerTimestamp,
        created_at: markerTimestamp,
      }),
    );

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        revealCommentsAtConversationRead: 2,
        initialComments: [
          {
            id: 98,
            user: { login: "clawsweeper[bot]" },
            author_association: "NONE",
            body: renderProofNudgeCommentForTest({
              number: 42,
              author: "contributor",
              headSha,
              timestamp: markerTimestamp,
            }),
            created_at: markerTimestamp,
            updated_at: markerTimestamp,
            html_url: "https://github.com/openclaw/openclaw/pull/42#issuecomment-98",
          },
        ],
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "proof-nudges",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--min-age-days",
          "0",
          "--cooldown-days",
          "36500",
          "--report-path",
          reportPath,
          "--mutation-state-dir",
          mutationStateDir,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "proof_nudge_reconciled");
    assert.match(report[0].reason, /same-head proof nudge marker already exists/);
    assert.equal(existsSync(mutationLogPath), false);
    assert.equal(existsSync(join(mutationStateDir, "42.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof nudges do not reconcile a marker deleted during mutation hydration", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "proof-nudge-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    const headSha = "a".repeat(40);
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ headSha }));

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        deleteCommentsAtConversationRead: 2,
        initialComments: [
          {
            id: 98,
            user: { login: "clawsweeper[bot]" },
            author_association: "NONE",
            body: renderProofNudgeCommentForTest({
              number: 42,
              author: "contributor",
              headSha,
              timestamp: "2026-01-01T00:00:00.000Z",
            }),
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            html_url: "https://github.com/openclaw/openclaw/pull/42#issuecomment-98",
          },
        ],
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "proof-nudges",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--min-age-days",
          "0",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "proof_nudge_posted");
    assert.equal(readFileSync(mutationLogPath, "utf8").trim(), "comment_post");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof nudges preserve unknown outcomes when marker reconciliation cannot be read", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "proof-nudge-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ headSha: "a".repeat(40) }));

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        postUnknown: true,
        failConversationReadsAfterUnknownPost: true,
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "proof-nudges",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--min-age-days",
          "0",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "proof_nudge_outcome_unknown");
    assert.equal(readFileSync(mutationLogPath, "utf8").trim(), "comment_post");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof nudges keep an unknown mutation cycle stable across workflow runs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const firstReportPath = join(root, "proof-nudge-first.json");
    const secondReportPath = join(root, "proof-nudge-second.json");
    const mutationStateDir = join(root, "proof-nudge-mutations");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ headSha: "a".repeat(40) }));

    const run = (reportPath: string) => {
      execFileSync(process.execPath, [
        "dist/clawsweeper.js",
        "proof-nudges",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--item-numbers",
        "42",
        "--limit",
        "1",
        "--processed-limit",
        "1",
        "--min-age-days",
        "0",
        "--report-path",
        reportPath,
        "--mutation-state-dir",
        mutationStateDir,
        "--execute",
      ]);
    };

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        postUnknown: true,
        hideUnknownPostComment: true,
      }),
      () => {
        run(firstReportPath);
        run(secondReportPath);
      },
    );

    const firstReport = JSON.parse(readFileSync(firstReportPath, "utf8"));
    const secondReport = JSON.parse(readFileSync(secondReportPath, "utf8"));
    assert.equal(firstReport[0].action, "proof_nudge_outcome_unknown");
    assert.equal(secondReport[0].action, "proof_nudge_reconciliation_pending");
    assert.match(secondReport[0].reason, /waiting for its exact marker/);
    assert.equal(readFileSync(mutationLogPath, "utf8").trim(), "comment_post");
    const cycle = JSON.parse(readFileSync(join(mutationStateDir, "42.json"), "utf8"));
    assert.equal(cycle.repository, "openclaw/openclaw");
    assert.equal(cycle.number, 42);
    assert.equal(cycle.head_sha, "a".repeat(40));
    assert.match(cycle.marker_timestamp, /^20\d{2}-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof nudges reconcile an expired same-head marker before posting the next nudge", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "proof-nudge-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    const headSha = "a".repeat(40);
    const priorBody = renderProofNudgeCommentForTest({
      number: 42,
      author: "contributor",
      headSha,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), proofNudgeReport({ headSha }));

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        initialComments: [
          {
            id: 71,
            user: { login: "clawsweeper[bot]" },
            author_association: "NONE",
            body: priorBody,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/openclaw/openclaw/pull/42#issuecomment-71",
          },
        ],
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "proof-nudges",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--min-age-days",
          "0",
          "--cooldown-days",
          "0",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "proof_nudge_posted");
    assert.match(report[0].reason, /prior same-head proof nudge receipt reconciled/);
    assert.equal(readFileSync(mutationLogPath, "utf8").trim(), "comment_post");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof revalidates before each label request and stops after head drift", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "bot-proof-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "42.md"),
      proofNudgeReport({
        author: "app/clawsweeper",
        authorAssociation: "NONE",
        headSha: "a".repeat(40),
      }),
    );

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        bot: true,
        driftHeadAtPullRead: 10,
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "bot-proof",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(
      report[0].action,
      "skipped_changed_before_mutation",
      JSON.stringify({
        report,
        mutations: existsSync(mutationLogPath) ? readFileSync(mutationLogPath, "utf8") : "",
        state: JSON.parse(readFileSync(statePath, "utf8")),
      }),
    );
    assert.match(report[0].reason, /head changed/);
    assert.match(readFileSync(mutationLogPath, "utf8"), /^label_create:/);
    assert.doesNotMatch(
      readFileSync(mutationLogPath, "utf8"),
      /label_add|label_remove|comment_post/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof preserves head drift detected during mutation baseline hydration", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "bot-proof-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "42.md"),
      proofNudgeReport({
        author: "app/clawsweeper",
        authorAssociation: "NONE",
        headSha: "a".repeat(40),
      }),
    );

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        bot: true,
        driftHeadAtPullRead: 2,
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "bot-proof",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "skipped_changed_before_mutation");
    assert.match(report[0].reason, /head changed while preparing/);
    assert.equal(existsSync(mutationLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof revalidates draft state before its first mutation", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "bot-proof-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "42.md"),
      proofNudgeReport({
        author: "app/clawsweeper",
        authorAssociation: "NONE",
        headSha: "a".repeat(40),
      }),
    );

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        bot: true,
        draftAtPullRead: 6,
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "bot-proof",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "skipped_changed_before_mutation");
    assert.match(report[0].reason, /pull request is draft/);
    assert.equal(existsSync(mutationLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof plans label synchronization from its fresh mutation baseline", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "bot-proof-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "42.md"),
      proofNudgeReport({
        author: "app/clawsweeper",
        authorAssociation: "NONE",
        headSha: "a".repeat(40),
      }),
    );

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        bot: true,
        driftLabelAtIssueRead: 2,
        driftLabel: "status: 📣 needs proof",
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "bot-proof",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "bot_proof_decision_posted");
    assert.deepEqual(readFileSync(mutationLogPath, "utf8").trim().split("\n"), [
      "label_create:status: needs maintainer proof decision",
      "label_remove:status: 📣 needs proof",
      "label_add:status: needs maintainer proof decision",
      "label_remove:stale",
      "comment_post",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof stops when labels change between its own requests", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "bot-proof-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "42.md"),
      proofNudgeReport({
        author: "app/clawsweeper",
        authorAssociation: "NONE",
        headSha: "a".repeat(40),
      }),
    );

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        bot: true,
        driftLabelAtIssueRead: 10,
        driftLabel: "status: 📣 needs proof",
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "bot-proof",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "skipped_changed_before_mutation");
    assert.match(report[0].reason, /live labels changed/);
    assert.equal(
      readFileSync(mutationLogPath, "utf8").trim(),
      "label_create:status: needs maintainer proof decision",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof ignores unowned markers before selecting its upsert target", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "bot-proof-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    const headSha = "a".repeat(40);
    const markdown = proofNudgeReport({
      author: "app/clawsweeper",
      authorAssociation: "NONE",
      headSha,
    });
    const body = renderBotProofDecisionCommentForTest({
      number: 42,
      title: "Proof nudge sample",
      headSha,
      timestamp: "2026-01-01T00:00:00Z",
      markdown,
    });
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), markdown);

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        bot: true,
        initialLabels: [
          "triage: needs-real-behavior-proof",
          "status: needs maintainer proof decision",
        ],
        initialComments: [
          {
            id: 70,
            user: { login: "contributor" },
            author_association: "CONTRIBUTOR",
            body,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/openclaw/openclaw/pull/42#issuecomment-70",
          },
          {
            id: 71,
            user: { login: "clawsweeper[bot]" },
            author_association: "NONE",
            body,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/openclaw/openclaw/pull/42#issuecomment-71",
          },
        ],
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "bot-proof",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "bot_proof_decision_reconciled");
    assert.equal(report[0].url, "https://github.com/openclaw/openclaw/pull/42#issuecomment-71");
    assert.equal(existsSync(mutationLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof revalidates a matching comment before no-op reconciliation", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "bot-proof-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    const headSha = "a".repeat(40);
    const markdown = proofNudgeReport({
      author: "app/clawsweeper",
      authorAssociation: "NONE",
      headSha,
    });
    const body = renderBotProofDecisionCommentForTest({
      number: 42,
      title: "Proof nudge sample",
      headSha,
      timestamp: "2026-01-01T00:00:00Z",
      markdown,
    });
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), markdown);

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        bot: true,
        driftHeadAtPullRead: 6,
        initialLabels: [
          "triage: needs-real-behavior-proof",
          "status: needs maintainer proof decision",
        ],
        initialComments: [
          {
            id: 71,
            user: { login: "clawsweeper[bot]" },
            author_association: "NONE",
            body,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/openclaw/openclaw/pull/42#issuecomment-71",
          },
        ],
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "bot-proof",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "skipped_changed_before_mutation");
    assert.match(report[0].reason, /head changed/);
    assert.equal(existsSync(mutationLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof reconciles an applied label removal under its concrete mutation identity", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "bot-proof-report.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    const headSha = "a".repeat(40);
    const body = renderBotProofDecisionCommentForTest({
      number: 42,
      title: "Proof nudge sample",
      headSha,
      timestamp: "2026-01-01T00:00:00Z",
      markdown: proofNudgeReport({
        author: "app/clawsweeper",
        authorAssociation: "NONE",
        headSha,
      }),
    });
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "42.md"),
      proofNudgeReport({
        author: "app/clawsweeper",
        authorAssociation: "NONE",
        headSha,
      }),
    );

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        bot: true,
        unknownMutation: "label_remove:stale",
        initialComments: [
          {
            id: 77,
            user: { login: "clawsweeper[bot]" },
            author_association: "NONE",
            body,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/openclaw/openclaw/pull/42#issuecomment-77",
          },
        ],
      }),
      () => {
        execFileSync(process.execPath, [
          "dist/clawsweeper.js",
          "bot-proof",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--item-numbers",
          "42",
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--report-path",
          reportPath,
          "--execute",
        ]);
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report[0].action, "bot_proof_decision_reconciled");
    assert.deepEqual(readFileSync(mutationLogPath, "utf8").trim().split("\n"), [
      "label_create:status: needs maintainer proof decision",
      "label_add:status: needs maintainer proof decision",
      "label_remove:stale",
    ]);
    const identities = satisfiedBotProofLabelMutationIdentitiesForTest(42, [
      "triage: needs-real-behavior-proof",
      "status: needs maintainer proof decision",
    ]);
    assert.ok(identities.includes("issue_label_remove:42:stale"));
    assert.ok(identities.includes("issue_label_add:42:status: needs maintainer proof decision"));
    assert.doesNotMatch(identities.join("\n"), /bot_proof_label_state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof reconciles an unknown label create when the retry proves it already exists", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const firstReportPath = join(root, "bot-proof-first.json");
    const secondReportPath = join(root, "bot-proof-second.json");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "42.md"),
      proofNudgeReport({
        author: "app/clawsweeper",
        authorAssociation: "NONE",
        headSha: "a".repeat(40),
      }),
    );
    const script = proofMutationGhMockScript({
      statePath,
      mutationLogPath,
      bot: true,
      unknownMutation: "label_create:status: needs maintainer proof decision",
    });
    const run = (reportPath: string) => {
      execFileSync(process.execPath, [
        "dist/clawsweeper.js",
        "bot-proof",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--item-numbers",
        "42",
        "--limit",
        "1",
        "--processed-limit",
        "1",
        "--report-path",
        reportPath,
        "--execute",
      ]);
    };

    withMockGh(root, script, () => {
      run(firstReportPath);
      run(secondReportPath);
    });

    const firstReport = JSON.parse(readFileSync(firstReportPath, "utf8"));
    const secondReport = JSON.parse(readFileSync(secondReportPath, "utf8"));
    assert.equal(firstReport[0].action, "bot_proof_mutation_outcome_unknown");
    assert.equal(secondReport[0].action, "bot_proof_decision_posted");
    assert.match(secondReport[0].reason, /reconciled 1 completed label operation receipt/);
    assert.deepEqual(readFileSync(mutationLogPath, "utf8").trim().split("\n"), [
      "label_create:status: needs maintainer proof decision",
      "label_create:status: needs maintainer proof decision",
      "label_add:status: needs maintainer proof decision",
      "label_remove:stale",
      "comment_post",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof does not replay an unknown comment POST across workflow runs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const firstReportPath = join(root, "bot-proof-first.json");
    const secondReportPath = join(root, "bot-proof-second.json");
    const mutationStateDir = join(root, "bot-proof-mutations");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "42.md"),
      proofNudgeReport({
        author: "app/clawsweeper",
        authorAssociation: "NONE",
        headSha: "a".repeat(40),
      }),
    );
    const run = (reportPath: string) => {
      execFileSync(process.execPath, [
        "dist/clawsweeper.js",
        "bot-proof",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--item-numbers",
        "42",
        "--limit",
        "1",
        "--processed-limit",
        "1",
        "--report-path",
        reportPath,
        "--mutation-state-dir",
        mutationStateDir,
        "--execute",
      ]);
    };

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        bot: true,
        postUnknown: true,
        hideUnknownPostComment: true,
        initialLabels: [
          "triage: needs-real-behavior-proof",
          "status: needs maintainer proof decision",
        ],
      }),
      () => {
        run(firstReportPath);
        run(secondReportPath);
      },
    );

    const firstReport = JSON.parse(readFileSync(firstReportPath, "utf8"));
    const secondReport = JSON.parse(readFileSync(secondReportPath, "utf8"));
    assert.equal(firstReport[0].action, "bot_proof_mutation_outcome_unknown");
    assert.equal(secondReport[0].action, "bot_proof_reconciliation_pending");
    assert.match(secondReport[0].reason, /waiting for its exact body/);
    assert.equal(readFileSync(mutationLogPath, "utf8").trim(), "comment_post");
    const cycle = JSON.parse(readFileSync(join(mutationStateDir, "42.json"), "utf8"));
    assert.equal(cycle.repository, "openclaw/openclaw");
    assert.equal(cycle.number, 42);
    assert.equal(cycle.head_sha, "a".repeat(40));
    assert.match(cycle.comment_body_sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot proof does not replay an unknown comment PATCH across workflow runs", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const firstReportPath = join(root, "bot-proof-first.json");
    const secondReportPath = join(root, "bot-proof-second.json");
    const mutationStateDir = join(root, "bot-proof-mutations");
    const statePath = join(root, "gh-state.json");
    const mutationLogPath = join(root, "mutations.log");
    const headSha = "a".repeat(40);
    const markdown = proofNudgeReport({
      author: "app/clawsweeper",
      authorAssociation: "NONE",
      headSha,
    });
    const priorBody = `${renderBotProofDecisionCommentForTest({
      number: 42,
      title: "Proof nudge sample",
      headSha,
      timestamp: "2026-01-01T00:00:00Z",
      markdown,
    })}\n\nLegacy decision detail.`;
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "42.md"), markdown);
    const run = (reportPath: string) => {
      execFileSync(process.execPath, [
        "dist/clawsweeper.js",
        "bot-proof",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--item-numbers",
        "42",
        "--limit",
        "1",
        "--processed-limit",
        "1",
        "--report-path",
        reportPath,
        "--mutation-state-dir",
        mutationStateDir,
        "--execute",
      ]);
    };

    withMockGh(
      root,
      proofMutationGhMockScript({
        statePath,
        mutationLogPath,
        bot: true,
        patchUnknown: true,
        initialLabels: [
          "triage: needs-real-behavior-proof",
          "status: needs maintainer proof decision",
        ],
        initialComments: [
          {
            id: 77,
            user: { login: "clawsweeper[bot]" },
            author_association: "NONE",
            body: priorBody,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/openclaw/openclaw/pull/42#issuecomment-77",
          },
        ],
      }),
      () => {
        run(firstReportPath);
        run(secondReportPath);
      },
    );

    const firstReport = JSON.parse(readFileSync(firstReportPath, "utf8"));
    const secondReport = JSON.parse(readFileSync(secondReportPath, "utf8"));
    assert.equal(firstReport[0].action, "bot_proof_mutation_outcome_unknown");
    assert.equal(secondReport[0].action, "bot_proof_reconciliation_pending");
    assert.match(secondReport[0].reason, /waiting for its exact body/);
    assert.equal(readFileSync(mutationLogPath, "utf8").trim(), "comment_patch");
    assert.match(
      JSON.parse(readFileSync(join(mutationStateDir, "42.json"), "utf8")).comment_body_sha256,
      /^[0-9a-f]{64}$/,
    );
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
