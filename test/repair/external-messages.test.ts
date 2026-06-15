import assert from "node:assert/strict";
import test from "node:test";

import {
  automergeRepairOutcomeComment,
  closingReferencesFromMarkdown,
  externalMessageProvenance,
  issueImplementationResultStatusComment,
  repairContributorBranchComment,
  replacementPrBody,
  replacementSourceCloseComment,
  replacementSourceLinkComment,
} from "../../dist/repair/external-messages.js";

test("automergeRepairOutcomeComment explains no-op repair runs", () => {
  const body = automergeRepairOutcomeComment({
    marker: "<!-- marker -->",
    target: 74156,
    report: { reason: "no planned fix actions" },
    result: {
      summary:
        "Worker found no executable fix artifact for PR #74156 at https://github.com/openclaw/openclaw/pull/74156#issuecomment-123.",
      actions: [
        {
          target: "https://github.com/openclaw/openclaw/pull/74156#issuecomment-456",
          action: "route_security",
          status: "planned",
          reason: "central handling required for #74156",
        },
      ],
    },
    provenance: { model: "gpt-test", reasoning: "medium", reviewedSha: "0123456789abcdef" },
  });

  assert.match(body, /^<!-- marker -->/);
  assert.match(body, /(without changing|no-op|No new branch changes|no safe branch change)/i);
  assert.doesNotMatch(body, /Target: #74156/);
  assert.doesNotMatch(body, /#74156/);
  assert.doesNotMatch(body, /issuecomment-/);
  assert.match(body, /Executor outcome: no planned fix actions\./);
  assert.match(body, /`route_security` on `this PR`: planned - central handling required/);
  assert.match(
    body,
    /(No branch push|No push|left the PR as-is|Nothing moved downstream|observational only)/i,
  );
  assert.match(body, /reasoning medium; reviewed against 0123456789ab/);
  assert.doesNotMatch(body, /model gpt-test/);
});

test("repairContributorBranchComment avoids self PR references", () => {
  const body = repairContributorBranchComment({
    sourcePrUrl: "https://github.com/openclaw/openclaw/pull/75183",
    validationCommands: ["pnpm check:changed"],
    provenance: { model: "gpt-test", reasoning: "medium", reviewedSha: "abcdef1234567890" },
  });

  assert.match(body, /reef update/);
  assert.match(body, /Validation: pnpm check:changed/);
  assert.doesNotMatch(body, /Source PR:/);
  assert.doesNotMatch(body, /75183/);
});

test("replacement comments explain no push rights and keep co-author credit visible", () => {
  const contributorCredits = [
    {
      login: "octocat",
      co_authored_by: "Co-authored-by: Mona Octocat <1+octocat@users.noreply.github.com>",
    },
  ];
  const provenance = { model: "gpt-test", reasoning: "medium", reviewedSha: "abcdef1234567890" };

  const linkBody = replacementSourceLinkComment({
    replacementPrUrl: "https://github.com/openclaw/openclaw/pull/67890",
    contributorCredits,
    provenance,
  });
  assert.match(linkBody, /Why replacement: .*push rights/i);
  assert.match(linkBody, /Source PR status: left open/i);
  assert.match(
    linkBody,
    /@octocat: Co-authored-by: Mona Octocat <1\+octocat@users\.noreply\.github\.com>/,
  );

  const closeBody = replacementSourceCloseComment({
    replacementPrUrl: "https://github.com/openclaw/openclaw/pull/67890",
    contributorCredits,
    provenance,
  });
  assert.match(closeBody, /Why replacement: .*push rights/i);
  assert.match(closeBody, /Why close: .*credited replacement PR is open/i);
  assert.match(
    closeBody,
    /@octocat: Co-authored-by: Mona Octocat <1\+octocat@users\.noreply\.github\.com>/,
  );
});

test("replacement PR body keeps public context without internal worker notes", () => {
  const body = replacementPrBody({
    clusterId: "ghcrawl-123",
    fixArtifact: {
      pr_body: "Fix the focused regression.",
      source_prs: ["https://github.com/openclaw/openclaw/pull/12345"],
      credit_notes: ["Thanks @octocat for the original PR."],
      validation_commands: ["pnpm check"],
    },
    fallbackReason: "source PR #12345 has maintainer_can_modify=false",
    contributorCredits: [
      {
        login: "octocat",
        co_authored_by: "Co-authored-by: Mona Octocat <1+octocat@users.noreply.github.com>",
      },
    ],
    maintainerAttribution: {
      author: "maintainer-user",
      author_id: 123456,
    },
    sourceClosingReferences: ["Closes #74124", "closes #74124", "Fixes openclaw/openclaw#81234"],
    provenance: { model: "gpt-test", reasoning: "medium", reviewedSha: "abcdef1234567890" },
  });

  assert.match(
    body,
    /Replacement for https:\/\/github\.com\/openclaw\/openclaw\/pull\/12345 because the source branch could not be updated\./,
  );
  assert.match(body, /Original contributor: @octocat\./);
  assert.match(
    body,
    /Inherited issue-closing references from the source PR:\nCloses #74124\nFixes openclaw\/openclaw#81234/,
  );
  assert.match(
    body,
    /<!-- clawsweeper-automerge-requested-by login="maintainer-user" id="123456" -->/,
  );
  assert.doesNotMatch(body, /replacement reef notes|fish notes|Cluster:|Repair fallback:/);
  assert.equal(body.match(/pnpm check/g)?.length ?? 0, 0);
});

test("issue-generated PR body does not claim to replace a source PR", () => {
  const body = replacementPrBody({
    clusterId: "issue-openclaw-gogcli-814",
    fixArtifact: {
      pr_body: "## Summary\n\nDocument the existing alias.\n\nFixes #814",
      source_prs: [],
      credit_notes: ["Thanks @reporter."],
      validation_commands: ["pnpm check"],
    },
    fallbackReason: "",
    contributorCredits: [],
    provenance: { reasoning: "high", reviewedSha: "abcdef1234567890" },
  });

  assert.equal(body, "## Summary\n\nDocument the existing alias.\n\nFixes #814\n");
});

test("closingReferencesFromMarkdown extracts GitHub closing syntax", () => {
  assert.deepEqual(
    closingReferencesFromMarkdown(
      "Context.\n\nCloses #74124, openclaw/openclaw#81234\nFixes https://github.com/openclaw/openclaw/issues/81235\ncloses #74124",
    ),
    [
      "Closes #74124",
      "Closes openclaw/openclaw#81234",
      "Fixes https://github.com/openclaw/openclaw/issues/81235",
    ],
  );
});

test("issueImplementationResultStatusComment appends and updates PR link section", () => {
  const existing = [
    "<!-- clawsweeper-command-status:76734:implement_issue:na -->",
    "ClawSweeper issue implementation requested.",
    "",
    "Action: repair worker queued.",
  ].join("\n");
  const first = issueImplementationResultStatusComment({
    existingBody: existing,
    prUrl: "https://github.com/openclaw/openclaw/pull/76744",
    branch: "clawsweeper/issue-openclaw-openclaw-76734",
    runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/25282203827",
    completedAt: "2026-05-03T14:52:08Z",
  });

  assert.match(first, /clawsweeper-command-status:76734:implement_issue:na/);
  assert.match(first, /Result: implementation PR opened/);
  assert.match(first, /https:\/\/github\.com\/openclaw\/openclaw\/pull\/76744/);
  assert.match(first, /clawsweeper\/issue-openclaw-openclaw-76734/);

  const second = issueImplementationResultStatusComment({
    existingBody: first,
    prUrl: "https://github.com/openclaw/openclaw/pull/76745",
    branch: "clawsweeper/issue-openclaw-openclaw-76734",
  });

  assert.match(second, /https:\/\/github\.com\/openclaw\/openclaw\/pull\/76745/);
  assert.doesNotMatch(second, /pull\/76744/);
  assert.equal(second.match(/clawsweeper-issue-implementation-result/g)?.length, 1);
});

test("issueImplementationResultStatusComment reports blocked terminal outcomes", () => {
  const existing = [
    "<!-- clawsweeper-command-status:85831:implement_issue:na -->",
    "ClawSweeper issue implementation requested.",
    "",
    "Action: repair worker queued.",
  ].join("\n");
  const body = issueImplementationResultStatusComment({
    existingBody: existing,
    status: "blocked",
    reason: "fix artifact is too broad for autonomous execution",
    runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/26346180012",
    completedAt: "2026-05-23T23:22:29Z",
  });

  assert.match(body, /Result: implementation blocked/);
  assert.match(body, /fix artifact is too broad for autonomous execution/);
  assert.match(body, /https:\/\/github\.com\/openclaw\/clawsweeper\/actions\/runs\/26346180012/);
  assert.doesNotMatch(body, /- PR:/);
});

test("external message provenance normalizes accidental xhigh reasoning", () => {
  const provenance = externalMessageProvenance({ model: "gpt-test", reasoning: "xhigh" });
  const body = automergeRepairOutcomeComment({
    marker: "<!-- marker -->",
    target: 74156,
    report: { reason: "no planned fix actions" },
    result: { summary: "No executable fix.", actions: [] },
    provenance,
  });

  assert.equal(provenance.reasoning, "high");
  assert.match(body, /reasoning high/);
  assert.doesNotMatch(body, /model gpt-test/);
  assert.doesNotMatch(body, /reasoning xhigh/);
});
