import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import MarkdownIt from "markdown-it";

import {
  canPatchReviewComment,
  itemSourceRevisionSha256ForTest,
  isCodexReviewCommentBody,
  newReviewStartLeaseOwnerForTest,
  parseDecision,
  renderReviewCommentFromReport,
  renderReviewStartStatusComment,
  reviewAutomationMarkersFromReport,
  reviewStartLeaseWinnerCommentIdForTest,
  shouldPreserveReviewStartLease,
  withReviewStartStatusLease,
} from "../dist/clawsweeper.js";
import { issueSourceRevisionSha256 } from "../dist/repair/issue-source-guard.js";
import {
  closeDecision,
  detailsBody,
  item,
  prRatingReportSection,
  realBehaviorProofReportSection,
  reviewReportFrontMatter as reportFrontMatter,
} from "./helpers.ts";
import { nextStepFromReport } from "../dist/clawsweeper-next-step.js";
import { createRepositoryLinks } from "../dist/clawsweeper-links.js";
import { createReportDocumentRendering } from "../dist/clawsweeper-report-document.js";
import { createReportContextRendering } from "../dist/clawsweeper-report-context.js";
import { createDashboardPresentation } from "../dist/clawsweeper-dashboard.js";
import { createReportParser } from "../dist/clawsweeper-report-parser.js";
import { createRecordMetadata } from "../dist/clawsweeper-record-metadata.js";
import { createReportHelpers } from "../dist/clawsweeper-report-helpers.js";
import { normalizeRepo, repositoryProfileFor } from "../dist/repository-profiles.js";
import type { DecisionKind, Evidence, NextStepAssessment } from "../dist/clawsweeper-types.js";

function markdownLinkDestinations(markdown: string): Set<string> {
  const destinations = new Set<string>();
  const parser = new MarkdownIt({ html: true });
  for (const token of parser.parse(markdown, {})) {
    if (token.type !== "inline") continue;
    for (const child of token.children ?? []) {
      if (child.type !== "link_open") continue;
      const href = child.attrGet("href");
      if (typeof href === "string") destinations.add(href);
    }
  }
  return destinations;
}

test("Markdown destination assertions reject prose and lookalike links inside details", () => {
  const expected = "https://docs.openclaw.ai/tools";
  const lookalike = "https://docs.openclaw.ai.invalid/tools";
  const misleading = `<details>\n<summary>Evidence</summary>\n\n${expected}\n\n[${expected}](${lookalike})\n\n</details>`;
  const destinations = markdownLinkDestinations(misleading);
  assert.deepEqual(destinations, new Set([lookalike]));
  assert.equal(destinations.has(expected), false);
  assert.equal(
    markdownLinkDestinations(misleading.replace(lookalike, expected)).has(expected),
    true,
  );
});

const evidenceLinks = createRepositoryLinks({
  reportRepo: "openclaw/clawsweeper-state",
  normalizeRepo,
  targetRepo: () => "openclaw/openclaw",
  targetProfile: () => repositoryProfileFor("openclaw/openclaw"),
});
const evidenceParser = createReportParser({
  ...evidenceLinks,
  ...createRecordMetadata({} as never),
  ...createReportHelpers({
    OWNED_REVIEW_SECTION_HEADINGS: new Set(),
    parseBacktickLocation: () => null,
  }),
  markdownRepository: () => "openclaw/openclaw",
  evidenceEntry: (entry) => ({
    repo: null,
    file: null,
    line: null,
    command: null,
    sha: null,
    ...entry,
  }),
} as Parameters<typeof createReportParser>[0]);

function evidenceReport(
  evidence: Evidence[],
  decisionKind: DecisionKind = "close",
  nextStep?: NextStepAssessment,
) {
  const document = createReportDocumentRendering({
    ...evidenceLinks,
    ...createReportContextRendering({} as never),
    ...createDashboardPresentation({} as never),
    prSurfaceFilesFromContext: () => [],
    compactPullFilePaths: () => [],
    confidenceText: String,
    fixedInText: () => "unknown",
    formatTimestamp: String,
    labelJustificationsMarkdown: () => "- none",
    publicLikelyOwnerRole: String,
    pullHeadShaFromContext: () => "c".repeat(40),
    reviewStructuralPullStateFromContext: () => null,
    sentence: String,
    sha256: () => "synthetic-digest",
  } as Parameters<typeof createReportDocumentRendering>[0]);
  return document.markdownFor({
    item: item({ kind: "pull_request", url: "https://github.com/openclaw/openclaw/pull/123" }),
    decision: {
      ...parseDecision(
        closeDecision({
          evidence,
          decision: decisionKind,
          closeReason: decisionKind === "close" ? "implemented_on_main" : "none",
          ...(nextStep === undefined ? {} : { nextStep }),
        }),
      ),
      // The host stamps checkout access after parsing model output.
      localCheckoutAccess: "verified",
    },
    context: { issue: {}, comments: [], timeline: [] },
    git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
    action: { actionTaken: decisionKind === "close" ? "proposed_close" : "kept_open" },
    reviewMode: "propose",
    snapshotHash: "synthetic-snapshot",
    contentDigest: "synthetic-content",
    reviewPolicy: "synthetic-policy",
    runtime: { model: "Codex", reasoningEffort: "high" },
  } as Parameters<typeof document.markdownFor>[0]);
}

function nextStepReport(
  metadata: Record<string, string> = {},
  sections = "",
  reason = "No concrete repair remains after this review.",
) {
  return `${reportFrontMatter({
    type: "pull_request",
    number: "123",
    review_status: "complete",
    local_checkout_access: "verified",
    author_association: "MEMBER",
    work_candidate: "none",
    pull_head_sha: "c".repeat(40),
    ...metadata,
  })}
## Summary

The retry guard is ready for review.

## What This Changes

Keeps retry ownership bounded.

${prRatingReportSection()}

${realBehaviorProofReportSection()}

## Work Candidate

Candidate: none

Reason: ${reason}

${sections.includes("## Review Findings") ? "" : "## Review Findings\n\nOverall correctness: patch is correct\n\nFull review comments:\n\n- none"}

${sections}`;
}

function publicSection(comment: string, title: string): string {
  return (
    comment
      .split(`## ${title}\n\n`)[1]
      ?.split(/\n## |\n<details>/)[0]
      ?.trim() ?? ""
  );
}

test("explicit next-step none removes the false repair checkbox and updates readiness", () => {
  const legacy = nextStepReport();
  const report = nextStepReport({ next_step: JSON.stringify({ kind: "none", text: "" }) });
  const before = renderReviewCommentFromReport(legacy, "none");
  const after = renderReviewCommentFromReport(report, "none");
  assert.match(before, /Complete next step.*No concrete repair remains after this review\./);
  assert.match(before, /1 item remains/);
  assert.equal(publicSection(after, "Before merge"), "None.");
  assert.doesNotMatch(after, /Complete next step|1 item remains/);
  assert.equal(publicSection(after, "Review scores"), publicSection(before, "Review scores"));
  assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-review-state:ready/);
  assert.match(reviewAutomationMarkersFromReport(legacy), /clawsweeper-review-state:needs-changes/);
  for (const comment of [before, after]) {
    assert.match(comment, /clawsweeper-verdict:needs-human/);
    assert.doesNotMatch(comment, /clawsweeper-verdict:pass/);
  }
});

test("explicit required actions bypass prose heuristics even for human-owned workCandidate none", () => {
  for (const text of [
    "No schema change is needed, but repair the retry guard before merge.",
    "Do not merge until the owner approves the compatibility contract.",
    "Owner approval.",
    "Wait for CI and ordinary maintainer review.",
    "A decision on ownership is still outstanding.",
  ]) {
    const report = nextStepReport({ next_step: JSON.stringify({ kind: "required", text }) });
    const comment = renderReviewCommentFromReport(report, "none");
    assert.ok(publicSection(comment, "Before merge").includes(text), text);
    assert.equal(
      (publicSection(comment, "Before merge").match(/^- \[ \]/gm) ?? []).length,
      1,
      text,
    );
    assert.match(comment, /1 item remains/);
    assert.equal(
      reviewAutomationMarkersFromReport(report),
      reviewAutomationMarkersFromReport(nextStepReport()),
    );
  }
});

test("canonical next-step report round-trip preserves explicit intent and legacy absence", () => {
  for (const nextStep of [
    undefined,
    { kind: "none", text: "" },
    { kind: "required", text: "Owner approval." },
  ] as const) {
    const report = evidenceReport([], "keep_open", nextStep);
    assert.deepEqual(nextStepFromReport(report), nextStep);
    if (nextStep === undefined) assert.doesNotMatch(report, /^next_step:/m);
    else assert.ok(report.split("\n---")[0]!.includes(`next_step: ${JSON.stringify(nextStep)}`));
    const comment = renderReviewCommentFromReport(report, "none");
    if (nextStep?.kind === "none")
      assert.doesNotMatch(publicSection(comment, "Before merge"), /Complete next step/);
    if (nextStep?.kind === "required")
      assert.match(publicSection(comment, "Before merge"), /Owner approval\./);
  }
});

test("absent, malformed, duplicate and spoofed next-step metadata cannot suppress legacy action", () => {
  const none = 'next_step: {"kind":"none","text":""}';
  const legacy = nextStepReport({}, "", "Repair the retry guard before merge.");
  const reports = [
    legacy,
    ...[
      "none",
      "null",
      "{}",
      '{"kind":"required","text":""}',
      '{"kind":"none","text":"Repair it."}',
      '{"kind":"none","text":"","extra":true}',
      '{"kind":"required","kind":"none","text":""}',
      '{"kind":"none","text":"Repair it.","text":""}',
      "{broken",
    ].map((value) => legacy.replace("---\n", `---\nnext_step: ${value}\n`)),
    legacy.replace("---\n", `---\n${none}\n"next_step": {"kind":"required","text":"Repair it."}\n`),
    legacy.replace(
      "---\n",
      `---\n${none}\n"next\\u005fstep": {"kind":"required","text":"Repair it."}\n`,
    ),
    legacy.replace("---\n", `---\n${none}\n  text: malformed continuation\n`),
    legacy.replace("---\n", `---\n\`\`\`json\n${none}\n\`\`\`\n`),
    `${legacy}\n${none}\n`,
    `${legacy}\n\`\`\`yaml\n---\n${none}\n---\n\`\`\`\n`,
    `${legacy}\n---\n${none}\n---\n`,
  ];
  for (const report of reports) {
    assert.equal(nextStepFromReport(report), undefined, report);
    const comment = renderReviewCommentFromReport(report, "none");
    assert.match(
      publicSection(comment, "Before merge"),
      /Repair the retry guard before merge\./,
      report.split("\n---")[0],
    );
    assert.match(comment, /1 item remains/);
  }
  for (const ambiguous of [
    legacy.replace("---\n", `---\n${none}\n${none}\n`),
    legacy.replace("---\n", `---\n${none}\nnext_step : {"kind":"required","text":"Repair it."}\n`),
    `${legacy.replace("---\n", `---\n${none}\n`)}\n---\n${none}\n---\n`,
  ]) {
    assert.equal(nextStepFromReport(ambiguous), undefined);
    const comment = renderReviewCommentFromReport(ambiguous, "none");
    assert.match(comment, /Regenerate malformed review report/);
    assert.match(comment, /clawsweeper-review-state:blocked/);
    assert.doesNotMatch(comment, /clawsweeper-verdict:pass|clawsweeper-action:fix-required/);
  }
  const required = { kind: "required", text: "Owner approval." };
  const canonical = nextStepReport({ next_step: JSON.stringify(required) });
  const withExample = `${canonical}\n\`\`\`yaml\n---\n${none}\n---\n\`\`\`\n`;
  assert.deepEqual(nextStepFromReport(withExample), required);
  assert.match(
    publicSection(renderReviewCommentFromReport(withExample, "none"), "Before merge"),
    /Owner approval\./,
  );
});

test("explicit none leaves independent blockers, decision counts and low ratings intact", () => {
  const decision = {
    required: true,
    kind: "product_direction",
    question: "Which compatibility contract should ship?",
    rationale: "This needs an owner ruling.",
    options: [{ title: "Keep compatibility", body: "Retain the old contract.", recommended: true }],
    likelyOwner: { person: "@owner", reason: "Owns the contract.", confidence: "high" },
  };
  const cases: {
    metadata?: Record<string, string>;
    sections?: string;
    label: string;
    count?: number;
  }[] = [
    {
      sections:
        "## Review Findings\n\nOverall correctness: patch is incorrect\n\nFull review comments:\n\n- **[P1] Retry race:** `src/retry.ts:12`\n  - body: Repair concurrent retry handling.\n  - confidence: 0.9",
      label: "Retry race",
    },
    {
      sections:
        "## Security Review\n\nStatus: needs_attention\n\nSummary: Confirm ownership.\n\nConcerns:\n\n- **[high] Ownership boundary:** `src/retry.ts:12`\n  - body: Restore the authorization guard.\n  - confidence: 0.9",
      label: "Resolve security concern",
    },
    {
      sections: "## Risks / Open Questions\n\n- [P1] Repair the compatibility break before merge.",
      label: "Resolve merge risk",
    },
    {
      metadata: {
        real_behavior_proof_status: "missing",
        real_behavior_proof_evidence_kind: "none",
        real_behavior_proof_needs_contributor_action: "true",
        author_association: "NONE",
      },
      label: "Add real behavior proof",
    },
    {
      sections: "## Live Proof\n\n<!-- clawsweeper-live-verification -->\nResult: invalid",
      label: "Resolve historical verification",
    },
    { metadata: { maintainer_decision: JSON.stringify(decision) }, label: "Decision needed" },
    {
      metadata: { pr_rating_patch: "D", pr_rating_proof: "A", pr_rating_overall: "D" },
      label: "Improve patch quality",
    },
    { metadata: { review_status: "failed" }, label: "Retry ClawSweeper review", count: 0 },
  ];
  for (const scenario of cases) {
    const legacy = nextStepReport(scenario.metadata, scenario.sections, "None.");
    const report = legacy.replace("---\n", '---\nnext_step: {"kind":"none","text":""}\n');
    const before = renderReviewCommentFromReport(legacy, "none");
    const after = renderReviewCommentFromReport(report, "none");
    assert.ok(after.includes(scenario.label), scenario.label);
    assert.doesNotMatch(publicSection(after, "Before merge"), /Complete next step/);
    if (scenario.count !== 0) assert.match(after, /1 item remains/, scenario.label);
    assert.equal(
      publicSection(after, "Before merge"),
      publicSection(before, "Before merge"),
      scenario.label,
    );
    assert.equal(
      publicSection(after, "Review scores"),
      publicSection(before, "Review scores"),
      scenario.label,
    );
    assert.equal(
      reviewAutomationMarkersFromReport(report),
      reviewAutomationMarkersFromReport(legacy),
      scenario.label,
    );
  }
  const withDecision = nextStepReport({
    maintainer_decision: JSON.stringify(decision),
    next_step: JSON.stringify({
      kind: "required",
      text: "Record the owner decision in the PR body.",
    }),
  });
  const comment = renderReviewCommentFromReport(withDecision, "none");
  assert.match(publicSection(comment, "Before merge"), /Record the owner decision/);
  assert.match(comment, /2 items remain/);
});

const dependencyEvidence = {
  repo: "openai/codex",
  label: "dependency source",
  detail: "`codex-rs/core/config.schema.json:5668` declares developer_instructions.",
  file: "codex-rs/core/config.schema.json",
  line: 5668,
  sha: "78c290807ce710180111df227df3b7a4fe845452",
  command: "git show 78c290807ce7:codex-rs/core/config.schema.json",
};

test("repository evidence survives structured decision, report, parse and both comment paths", () => {
  const source = `https://github.com/openai/codex/blob/${dependencyEvidence.sha}/${dependencyEvidence.file}#L5668`;
  const commit = `https://github.com/openai/codex/commit/${dependencyEvidence.sha}`;
  const entries = [
    dependencyEvidence,
    {
      ...dependencyEvidence,
      file: "docs/config.md",
      line: null,
      detail: `See \`docs/config.md\` and [\`source.json\`](${source}).`,
    },
    {
      ...dependencyEvidence,
      repo: "openclaw/openclaw",
      file: "src/config.ts",
      line: 12,
      sha: "b".repeat(40),
      detail: "See `src/config.ts:12`.",
    },
    {
      ...dependencyEvidence,
      repo: "openclaw/openclaw",
      file: "docs/tools/index.md",
      line: null,
      detail: "See `docs/tools/index.md`.",
    },
    {
      ...dependencyEvidence,
      repo: "openclaw/openclaw",
      file: "VISION.md",
      line: null,
      detail: "The project vision defines the scope.",
    },
  ];
  for (const kind of ["close", "keep_open"] as const) {
    for (const detail of [
      "The project vision is in `VISION.md`.",
      "The project vision defines the scope.",
    ]) {
      const visionUrl = `https://github.com/openai/codex/blob/${"a".repeat(40)}/VISION.md`;
      const withDependencyVision = [
        ...entries,
        {
          ...dependencyEvidence,
          label: "dependency vision",
          file: "VISION.md",
          line: null,
          sha: "a".repeat(40),
          detail,
        },
      ];
      const report = evidenceReport(withDependencyVision, kind);
      assert.deepEqual(evidenceParser.reportEvidence(report), withDependencyVision);
      const comment = renderReviewCommentFromReport(
        report,
        kind === "close" ? "implemented_on_main" : "none",
      );
      assert.doesNotMatch(comment, /did not complete|infrastructure failure/);
      for (const output of [report, comment]) {
        const destinations = markdownLinkDestinations(output);
        assert.ok(destinations.has(source), output);
        assert.ok(destinations.has(commit), output);
        assert.ok(
          destinations.has(
            `https://github.com/openclaw/openclaw/blob/${"b".repeat(40)}/src/config.ts#L12`,
          ),
        );
        assert.ok(
          destinations.has(
            `https://github.com/openai/codex/blob/${dependencyEvidence.sha}/docs/config.md`,
          ),
        );
        assert.ok(destinations.has(visionUrl), output);
        assert.equal(destinations.has("https://docs.openclaw.ai/config"), false);
      }
      const commentDestinations = markdownLinkDestinations(comment);
      assert.ok(commentDestinations.has("https://docs.openclaw.ai/tools"));
      assert.ok(
        commentDestinations.has("https://github.com/openclaw/openclaw/blob/main/VISION.md"),
      );
      assert.ok(comment.includes(`[\`source.json\`](${source})`));
      const visionReference = `[\`VISION.md\`](${visionUrl})`;
      const linkedDetail = detail.includes("`VISION.md`")
        ? detail.replace("`VISION.md`", visionReference)
        : detail.replace("The project vision", visionReference);
      assert.ok(
        comment.includes(`- **dependency vision:** ${linkedDetail}`),
        `${kind}: ${detail}\n${comment}`,
      );
      assert.equal(
        commentDestinations.has("https://github.com/openai/codex/blob/main/VISION.md"),
        false,
      );
    }
  }
});

test("explicit GitHub destinations preserve full identity and historical same-repo reports stay readable", () => {
  const source = `https://github.com/openai/codex/blob/${dependencyEvidence.sha}/${dependencyEvidence.file}#L5668`;
  const commit = `https://github.com/openai/codex/commit/${dependencyEvidence.sha}`;
  const report = `${reportFrontMatter()}\n## Evidence\n\n- **dependency:** Verified source.\n  - file: [${dependencyEvidence.file}:5668](${source})\n  - sha: [78c290807ce7](${commit})\n`;
  assert.deepEqual(evidenceParser.reportEvidence(report)[0], {
    ...dependencyEvidence,
    label: "dependency",
    detail: "Verified source.",
    command: null,
  });
  const legacy = `${reportFrontMatter()}\n## Evidence\n\n- **target:** Historical location.\n  - file: [src/config.ts:12](https://github.com/openclaw/openclaw/blob/${"a".repeat(40)}/src/config.ts#L12)\n  - sha: [aaaaaaaaaaaa](https://github.com/openclaw/openclaw/commit/${"a".repeat(40)})\n`;
  assert.equal(evidenceParser.reportEvidence(legacy)[0].repo, "openclaw/openclaw");
  const bareLegacy = `${reportFrontMatter()}\n## Evidence\n\n- **target:** Historical path without a destination.\n  - file: \`src/config.ts:12\`\n  - sha: \`${"a".repeat(40)}\`\n`;
  assert.equal(evidenceParser.reportEvidence(bareLegacy)[0].repo, "openclaw/openclaw");
  for (const kind of ["close", "keep_open"] as const) {
    const explicit = evidenceReport(
      [{ ...dependencyEvidence, repo: null, file: source, line: null, sha: commit }],
      kind,
    );
    const comment = renderReviewCommentFromReport(
      explicit,
      kind === "close" ? "implemented_on_main" : "none",
    );
    const destinations = markdownLinkDestinations(comment);
    assert.ok(destinations.has(source));
    assert.ok(destinations.has(commit));
    assert.ok(markdownLinkDestinations(renderReviewCommentFromReport(report, "none")).has(source));
    assert.ok(
      markdownLinkDestinations(renderReviewCommentFromReport(legacy, "none")).has(
        `https://github.com/openclaw/openclaw/commit/${"a".repeat(40)}`,
      ),
    );
  }
});

test("unresolved evidence and conflicting destinations never acquire target links", () => {
  const source = `https://github.com/openai/codex/blob/${dependencyEvidence.sha}/${dependencyEvidence.file}#L5668`;
  const cases = [
    { repo: null },
    { file: "../codex/codex-rs/core/config.schema.json" },
    { file: "/checkout/codex-rs/core/config.schema.json" },
    { file: "codex-rs/../core/config.schema.json" },
    { file: "C:\\checkout\\config.schema.json" },
    { file: `https://github.com/openai/codex/blob/${dependencyEvidence.sha}/%2e%2e/config.json` },
    { repo: "openclaw/openclaw", file: source },
    { file: source, sha: "f".repeat(40) },
    { file: `[wrong/path.json](${source})` },
    { file: source, line: 100 },
    { file: source, sha: `https://github.com/other/repo/commit/${dependencyEvidence.sha}` },
  ];
  for (const entry of cases) {
    for (const kind of ["close", "keep_open"] as const) {
      const report = evidenceReport([{ ...dependencyEvidence, ...entry }], kind);
      const parsed = evidenceParser.reportEvidence(report)[0];
      assert.equal(parsed.repo, null, JSON.stringify(entry));
      const comment = renderReviewCommentFromReport(
        report,
        kind === "close" ? "implemented_on_main" : "none",
      );
      const evidence = comment
        .split("\n")
        .find((line) => line.startsWith("- **dependency source:**"));
      assert.ok(evidence, comment);
      assert.equal(markdownLinkDestinations(evidence).size, 0, JSON.stringify(entry));
    }
  }
  const missingSha = evidenceReport([
    { ...dependencyEvidence, sha: null, file: "docs/config.md", line: null },
  ]);
  for (const output of [
    missingSha,
    renderReviewCommentFromReport(missingSha, "implemented_on_main"),
  ]) {
    const destinations = markdownLinkDestinations(output);
    assert.equal(
      destinations.has(`https://github.com/openai/codex/blob/${"a".repeat(40)}/docs/config.md`),
      false,
    );
    assert.equal(destinations.has("https://docs.openclaw.ai/config"), false);
  }
  const target = evidenceReport([
    {
      ...dependencyEvidence,
      repo: "openclaw/openclaw",
      sha: null,
      file: "src/config.ts",
      line: 12,
    },
  ]);
  assert.ok(
    markdownLinkDestinations(renderReviewCommentFromReport(target, "implemented_on_main")).has(
      `https://github.com/openclaw/openclaw/blob/${"a".repeat(40)}/src/config.ts#L12`,
    ),
  );
});

function implementedCloseReport(overrides = {}) {
  const frontmatter = {
    repository: "openclaw/clawsweeper",
    number: 321,
    type: "issue",
    title: "Render work plans",
    reviewed_at: new Date().toISOString(),
    review_lease_owner: "fixture",
    review_lease_comment_id: "1059",
    review_status: "complete",
    local_checkout_access: "verified",
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "implemented_on_main",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_source_revision: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    item_created_at: "2026-05-01T00:00:00Z",
    item_updated_at: "2026-05-01T00:00:00Z",
    reproduction_status: "reproduced",
    reproduction_confidence: "high",
    fixed_sha: "1234567890abcdef1234567890abcdef12345678",
    fixed_at: "2026-05-01T02:00:00Z",
    ...overrides,
  };
  return [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => key + ": " + value),
    "---",
    "",
    "## Evidence",
    "",
    "- **main fix:** git show confirms current main has the replacement implementation and it is not in the latest release yet",
    "  - file: [src/clawsweeper.ts](https://github.com/openclaw/clawsweeper/blob/1234567890abcdef1234567890abcdef12345678/src/clawsweeper.ts)",
    "  - sha: [1234567890ab](https://github.com/openclaw/clawsweeper/commit/1234567890abcdef1234567890abcdef12345678)",
    "",
    "## Close Comment",
    "",
    "Closing this because the requested behavior is already on main.",
    "",
  ].join("\n");
}

test("GitHub workflow review leases use a recoverable run identity", () => {
  assert.equal(
    newReviewStartLeaseOwnerForTest(
      { GITHUB_RUN_ID: "29083888985", GITHUB_RUN_ATTEMPT: "2" },
      () => "random-owner",
    ),
    "github-run-29083888985-2",
  );
  assert.equal(
    newReviewStartLeaseOwnerForTest(
      { GITHUB_RUN_ID: "29083888985", GITHUB_RUN_ATTEMPT: "invalid" },
      () => "random-owner",
    ),
    "random-owner",
  );
});

test("comment matcher recognizes old and new Codex review comments", () => {
  assert.equal(
    isCodexReviewCommentBody(
      "Closing this as implemented after Codex review.\n\nCodex Review notes: reviewed against abc.",
    ),
    true,
  );
  assert.equal(
    isCodexReviewCommentBody(
      "Codex automated review: keeping this open.\n\nBest possible solution:\n\nShip it.",
    ),
    true,
  );
  assert.equal(
    isCodexReviewCommentBody(
      "Codex review: keeping this open for maintainer follow-up; there is still a little grit to resolve.\n\nBest possible solution:\n\nShip it.",
    ),
    true,
  );
  assert.equal(
    isCodexReviewCommentBody(
      "Codex review: needs maintainer review before merge.\n\nMaintainer follow-up before merge:\n\nShip it.",
    ),
    true,
  );
  assert.equal(isCodexReviewCommentBody("Thanks for the report, I can reproduce this."), false);
});

test("structural cache probes before hydration but acquires a lease before carrying a hit", () => {
  const source = [
    readFileSync("src/clawsweeper-review-command-workflow.ts", "utf8"),
    readFileSync("src/clawsweeper-review-preparation.ts", "utf8"),
    readFileSync("src/clawsweeper-runtime.ts", "utf8"),
    readFileSync("src/clawsweeper-item-context.ts", "utf8"),
  ].join("\n");
  const reviewLoop = source.slice(
    source.indexOf("for (const item of candidates)"),
    source.indexOf("let decision: Decision", source.indexOf("for (const item of candidates)")),
  );
  const structuralEligibility = reviewLoop.indexOf("reviewStructuralCacheProbeDecision({");
  const structuralProbe = reviewLoop.indexOf(
    "structuralRecord = fetchReviewStructuralRecord({",
    structuralEligibility,
  );
  const structuralCache = reviewLoop.indexOf("reviewStructuralCacheDecision({", structuralProbe);
  const structuralHit = reviewLoop.indexOf("if (structuralDecision.hit)");
  const structuralLease = reviewLoop.indexOf("postReviewStartStatusComment({", structuralHit);
  const structuralRevalidation = reviewLoop.indexOf(
    "structuralCacheRevalidations += 1",
    structuralLease,
  );
  const structuralWrite = reviewLoop.indexOf("writeFileSync(reportPath, carried", structuralLease);
  const contentCache = reviewLoop.indexOf("reviewContentCacheHit({");
  const structuralPreflight = reviewLoop.indexOf("cachePreflightPasses(", structuralRevalidation);
  const contentWrite = reviewLoop.indexOf("writeFileSync(reportPath, carried", contentCache);
  const contentPreflight = reviewLoop.indexOf("cachePreflightPasses(", contentCache);
  const provenancePromotions = [
    ...reviewLoop.matchAll(
      /carried = withRunnerPreflightProvenance\(carried, replaceFrontMatterValue\)/g,
    ),
  ];
  const hydration = reviewLoop.indexOf("collectItemContext(item");
  const mediaPrep = reviewLoop.indexOf("prepareMediaProofArtifacts(context", contentCache);

  assert.ok(structuralEligibility >= 0);
  assert.ok(structuralProbe > structuralEligibility);
  assert.ok(structuralCache >= 0);
  assert.ok(structuralCache < hydration);
  assert.ok(structuralHit > structuralCache);
  assert.ok(structuralLease > structuralHit);
  assert.ok(structuralRevalidation > structuralLease);
  assert.ok(structuralWrite > structuralRevalidation);
  assert.ok(structuralPreflight > structuralRevalidation);
  assert.ok(structuralPreflight < structuralWrite);
  assert.ok(structuralWrite < hydration);
  assert.ok(contentCache > structuralLease);
  assert.ok(contentPreflight > contentCache);
  assert.ok(contentPreflight < contentWrite);
  assert.equal(provenancePromotions.length, 2);
  assert.ok(provenancePromotions[0]!.index > structuralPreflight);
  assert.ok(provenancePromotions[0]!.index < structuralWrite);
  assert.ok(provenancePromotions[1]!.index > contentPreflight);
  assert.ok(provenancePromotions[1]!.index < contentWrite);
  assert.ok(mediaPrep > contentCache);
  assert.match(
    reviewLoop.slice(structuralHit, structuralWrite),
    /review_lease_owner[\s\S]*acquiredReviewLease\.owner/,
  );
  assert.match(
    reviewLoop.slice(structuralHit, structuralWrite),
    /review_lease_comment_id[\s\S]*acquiredReviewLease\.commentId/,
  );
  const hydratedAnchor = reviewLoop.indexOf(
    "reviewStructuralRecordsDescribeSameVerdictInput(",
    hydration,
  );
  assert.ok(hydratedAnchor > hydration);
  assert.match(reviewLoop.slice(hydration, hydratedAnchor + 160), /preHydrationStructuralRecord/);
  assert.match(
    reviewLoop.slice(structuralRevalidation, structuralWrite),
    /git = loadReviewGitInfo\(\)[\s\S]*fetchReviewStructuralRecord\(\{/,
  );
  assert.match(
    reviewLoop.slice(structuralRevalidation, structuralWrite),
    /liveClawSweeperReviewDigest\(item\.number\)[\s\S]*previousReviewIdentityMatches/,
  );
  const structuralProbeSource = source.slice(
    source.indexOf("function fetchReviewStructuralRecord"),
    source.indexOf("function collectItemContext"),
  );
  assert.match(structuralProbeSource, /pullChecksContext\(options\.item\.number, headSha\)/);
  assert.match(
    structuralProbeSource,
    /pullChecksDigest = sha256\(stableJson\(reviewPullChecksDigestParts\(pullChecks\)\)\)/,
  );
  assert.match(structuralProbeSource, /if \(!options\.git\.releaseStateComplete\) return null/);
  const reviewRuntime = readFileSync("src/clawsweeper-review-runtime.ts", "utf8");
  const gitInfoBlock = reviewRuntime.slice(
    reviewRuntime.indexOf("function gitInfo("),
    reviewRuntime.indexOf("function reviewTargetBranch"),
  );
  assert.match(gitInfoBlock, /releaseStateComplete = false/);
  assert.match(gitInfoBlock, /"release",\s+"list"/);
  assert.match(gitInfoBlock, /"tagName,name,publishedAt,isLatest"/);
  assert.match(gitInfoBlock, /release\.isLatest === true/);
  assert.doesNotMatch(gitInfoBlock, /releases\[0\]/);
  assert.match(
    gitInfoBlock,
    /return \{ mainSha, targetBranch, releaseStateComplete, latestRelease \}/,
  );
  assert.match(source, /coordination-held\.json/);
  assert.match(source, /coordinationHeldRetryAt = startComment\.retryAt/);
  assert.match(source, /review-cache-metrics\.json/);
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  assert.match(
    workflow,
    /review-artifacts\/shard-\$\{\{ matrix\.shard \}\}\/review-cache-metrics\.json/,
  );
});

test("review comment patching only targets ClawSweeper-owned comments", () => {
  assert.equal(canPatchReviewComment({ user: { login: "clawsweeper" } }), true);
  assert.equal(canPatchReviewComment({ user: { login: "clawsweeper[bot]" } }), true);
  assert.equal(canPatchReviewComment({ user: { login: "openclaw-clawsweeper[bot]" } }), true);
  assert.equal(canPatchReviewComment({ user: { login: "steipete" } }), false);
  assert.equal(canPatchReviewComment(undefined), false);
});

test("spoofed durable markers cannot suppress a bot-owned start lease", () => {
  const spoofedComment = {
    user: { login: "contributor" },
    body: "<!-- clawsweeper-review item=74453 -->",
  };
  assert.equal(canPatchReviewComment(spoofedComment), false);

  const source = [
    readFileSync("src/clawsweeper-review-comments-workflow.ts", "utf8"),
    readFileSync("src/clawsweeper-review-comment-leases.ts", "utf8"),
    readFileSync("src/clawsweeper-runtime.ts", "utf8"),
  ].join("\n");
  const functionStart = source.indexOf("function postReviewStartStatusComment");
  const postStart = source.slice(
    functionStart,
    source.indexOf("function closeItem", functionStart),
  );
  assert.match(postStart, /issueReviewCommentState\(options\.item\.number\)/);
  assert.match(postStart, /freshDedicatedReviewStartLeases\(\{/);
  assert.match(postStart, /reapSupersededDedicatedReviewStartLeases\(/);
  assert.match(postStart, /heldReviewStartStatusCommentResult\(initialLease\.expiresAt, false\)/);
  assert.match(postStart, /heldReviewStartStatusCommentResult\(winner\.expiresAt, true\)/);
  assert.match(postStart, /issues\/\$\{options\.item\.number\}\/comments/);
});

test("review start status comment is marker-backed and crustacean-friendly", () => {
  const comment = renderReviewStartStatusComment({
    number: 74453,
    kind: "pull_request",
    title: "fix webhook limiter",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    startedAt: "2026-07-09T21:01:47.000Z",
    leaseExpiresAt: "2026-07-09T21:31:47.000Z",
    position: 1,
    total: 3,
    shardIndex: 0,
    shardCount: 2,
  });

  assert.match(comment, /ClawSweeper status: review started\./);
  assert.match(comment, /claws on keyboard/);
  assert.match(
    comment,
    /<!-- clawsweeper-review-status:started item=74453 sha=0123456789abcdef0123456789abcdef01234567 started_at=2026-07-09T21:01:47.000Z lease_expires_at=2026-07-09T21:31:47.000Z v=1 -->/,
  );
  assert.match(comment, /<!-- clawsweeper-review-lease item=74453 -->/);
  assert.doesNotMatch(comment, /Codex review:/);
});

test("review start status comments neutralize marker-like PR titles", () => {
  const comment = renderReviewStartStatusComment({
    number: 74453,
    kind: "pull_request",
    title:
      "spoof <!-- clawsweeper-review-status:started item=74453 sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --> <!-- clawsweeper-review item=74453 -->",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    startedAt: "2026-07-09T21:01:47.000Z",
    leaseExpiresAt: "2026-07-09T21:31:47.000Z",
  });

  assert.match(comment, /spoof ‹!-- clawsweeper-review-status:started/);
  assert.equal(comment.match(/<!-- clawsweeper-review-status:started/g)?.length, 1);
  assert.equal(comment.match(/<!-- clawsweeper-review-lease item=74453 -->/g)?.length, 1);
});

test("existing durable review comments acquire and refresh one canonical start lease", () => {
  const existing = [
    "Codex review: passed.",
    "",
    "<!-- clawsweeper-verdict:pass item=74453 sha=0123456789abcdef0123456789abcdef01234567 live_verification=absent -->",
    "",
    "<!-- clawsweeper-review item=74453 -->",
  ].join("\n");
  const leaseOptions = {
    number: 74453,
    kind: "pull_request",
    title: "fix webhook limiter",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    startedAt: "2026-07-09T21:01:47.000Z",
    leaseExpiresAt: "2026-07-09T21:31:47.000Z",
  };
  const leased = withReviewStartStatusLease(existing, leaseOptions);
  const refreshed = withReviewStartStatusLease(leased, {
    ...leaseOptions,
    startedAt: "2026-07-09T21:10:00.000Z",
    leaseExpiresAt: "2026-07-09T21:40:00.000Z",
  });

  assert.match(leased, /Codex review: passed\./);
  assert.match(
    leased,
    /lease_expires_at=2026-07-09T21:31:47.000Z v=1 -->\n\n<!-- clawsweeper-review item=74453 -->$/,
  );
  assert.equal(refreshed.match(/<!-- clawsweeper-review-status:started/g)?.length, 1);
  assert.doesNotMatch(refreshed, /21:31:47\.000Z/);
  assert.match(refreshed, /lease_expires_at=2026-07-09T21:40:00.000Z/);
});

test("legacy durable review comments without an identity acquire a canonical start lease", () => {
  const leased = withReviewStartStatusLease("Codex review: passed.", {
    number: 74453,
    kind: "pull_request",
    title: "fix webhook limiter",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    startedAt: "2026-07-09T21:01:47.000Z",
    leaseExpiresAt: "2026-07-09T21:31:47.000Z",
  });

  assert.match(leased, /^Codex review: passed\./);
  assert.match(
    leased,
    /<!-- clawsweeper-review-status:started [^>]+ -->\n\n<!-- clawsweeper-review item=74453 -->$/,
  );
});

test("only the exact lease owner and comment can clear an active lease", () => {
  const currentHeadSha = "0123456789abcdef0123456789abcdef01234567";
  const base = {
    currentHeadSha,
    reportHeadSha: currentHeadSha,
    reportLeaseOwner: "worker-a",
    reportLeaseCommentId: "100",
    leaseOwner: "worker-a",
    leaseCommentId: 100,
  };

  assert.equal(shouldPreserveReviewStartLease(base), false);
  assert.equal(shouldPreserveReviewStartLease({ ...base, reportLeaseOwner: undefined }), true);
  assert.equal(
    shouldPreserveReviewStartLease({
      ...base,
      reportHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    true,
  );
  assert.equal(
    shouldPreserveReviewStartLease({
      ...base,
      reportLeaseOwner: "worker-b",
    }),
    true,
  );
  assert.equal(
    shouldPreserveReviewStartLease({
      ...base,
      reportLeaseCommentId: "101",
    }),
    true,
  );
  assert.equal(shouldPreserveReviewStartLease({ ...base, leaseOwner: null }), true);
});

test("concurrent review lease election uses server comment order, not client timestamps", () => {
  const itemNumber = 74453;
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const leaseComment = (id: number, owner: string, startedAt: string) => ({
    id,
    user: { login: "clawsweeper[bot]" },
    body: [
      `<!-- clawsweeper-review-status:started item=${itemNumber} sha=${headSha} started_at=${startedAt} lease_expires_at=2026-07-09T22:31:47.000Z owner=${owner} v=1 -->`,
      "",
      `<!-- clawsweeper-review-lease item=${itemNumber} -->`,
    ].join("\n"),
  });

  assert.equal(
    reviewStartLeaseWinnerCommentIdForTest({
      comments: [
        leaseComment(200, "delayed-worker", "2026-07-09T21:00:00.000Z"),
        leaseComment(100, "confirmed-worker", "2026-07-09T21:01:00.000Z"),
      ],
      itemNumber,
      headSha,
      nowMs: Date.parse("2026-07-09T21:02:00.000Z"),
    }),
    100,
  );
});

test("apply retains its mutation lease until the item action is complete", () => {
  const source = readFileSync("src/clawsweeper-apply-decision-workflow.ts", "utf8");
  const acquire = source.indexOf("const mutationLeaseBlockReason = acquireApplyMutationLease");
  const commentSync = source.indexOf("syncedComment = upsertReviewComment(", acquire);
  const close = source.indexOf("const closeFlow = executeApplyClose(", commentSync);
  const release = source.indexOf("releaseActiveApplyMutationLease();", close);
  assert.ok(acquire >= 0);
  assert.ok(commentSync > acquire);
  assert.ok(close > commentSync);
  assert.ok(release > close);
  assert.match(
    readFileSync("src/clawsweeper-apply-close-execution.ts", "utf8"),
    /currentApplyMutationLeaseBlockReason\(\)[\s\S]*closeItem\(\{ number, kind: item\.kind/,
  );
  assert.doesNotMatch(source, /deleteSupersededDedicatedReviewStartLeases/);
});

test("review item source revision ignores advisory labels but tracks protected labels", () => {
  const item = {
    title: "Close duplicate PR",
    body: "This was superseded by the canonical fix.",
    labels: [{ name: "bug" }],
  };
  const revision = itemSourceRevisionSha256ForTest(item, []);

  assert.equal(
    itemSourceRevisionSha256ForTest(
      {
        ...item,
        labels: [
          ...item.labels,
          { name: "status: ⏳ waiting on author" },
          { name: "rating: 🧂 unranked krab" },
          { name: "proof: sufficient" },
          { name: "merge-risk: 🚨 automation" },
          { name: "impact:message-loss" },
          { name: "issue-rating: 🦪 silver shellfish" },
          { name: "P1" },
          { name: "maturity:stable" },
          { name: "feature: ✨ showcase" },
          { name: "good first issue" },
          { name: "mantis: telegram-visible-proof" },
          { name: "proof: telegram-e2e" },
          { name: "triage: needs-real-behavior-proof" },
          { name: "clawsweeper:reviewed" },
          { name: "clawsweeper-recovery-stuck" },
          { name: "no-stale" },
          { name: "stale" },
        ],
      },
      [],
    ),
    revision,
  );
  assert.notEqual(
    itemSourceRevisionSha256ForTest(
      { ...item, labels: [...item.labels, { name: "needs-design" }] },
      [],
    ),
    revision,
  );
  assert.notEqual(
    itemSourceRevisionSha256ForTest(
      { ...item, labels: [...item.labels, { name: "release-blocker" }] },
      [],
    ),
    revision,
  );
  const bulkFiled = { ...item, labels: [...item.labels, { name: "clawsweeper:bulk-filed" }] };
  assert.notEqual(itemSourceRevisionSha256ForTest(bulkFiled, []), revision);
  assert.equal(
    itemSourceRevisionSha256ForTest(bulkFiled, []),
    issueSourceRevisionSha256(bulkFiled, []),
  );
  assert.notEqual(
    itemSourceRevisionSha256ForTest(
      { ...item, labels: [...item.labels, { name: "proof: override" }] },
      [],
    ),
    revision,
  );
});

test("pull request keep-open review comments label the change summary", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74265",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      work_candidate: "none",
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
      reviewed_at: "2026-05-22T04:43:12.000Z",
    })}

## Summary

Keep this test-only PR open for maintainer review.

## What This Changes

Adds regression coverage for session-scoped model overrides.

## System Context

OpenClaw resolves a session's model override before sending the next agent request.

## Architecture Diagram

flowchart LR
    session["Session settings"] --> resolver["Model resolver"]
    resolver --> request["Agent request"]

## Real Behavior Proof

Status: sufficient

Evidence kind: terminal

Needs contributor action: false

Summary: A live session confirmed the override reaches the next request.

## Best Possible Solution

Merge after required checks are green.

## Reproduction Assessment

Not applicable. This is a test-only PR and the validation path is the targeted test lane.

## Solution Assessment

Yes. Landing the focused regression test after the targeted lane is green is the narrowest useful path.

## AGENTS.md Policy Status

Status: found_applied

Found: true

Read fully: true

Applied: true

Summary: Found AGENTS.md and applied relevant repository review guidance.

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Status: none

Reason: No ClawSweeper repair lane is needed; ordinary CI and maintainer review remain.

## Evidence

- **targeted lane:** The PR is test-only and should run the matching changed-test lane.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
	`,
    "none",
  );

  assert.match(
    comment,
    /Codex review: needs maintainer review before merge\. _Reviewed May 22, 2026, 12:43 AM ET \/ 04:43 UTC\._/,
  );
  assert.doesNotMatch(comment, /\*\*Latest ClawSweeper review:\*\*/);
  assert.match(
    comment,
    /## What this changes\n\nAdds regression coverage for session-scoped model overrides\./,
  );
  assert.ok(comment.indexOf("## What this changes") < comment.indexOf("## Merge readiness"));
  assert.match(comment, /## Merge readiness\n\n✅ \*\*Ready for maintainer review\*\*/);
  assert.doesNotMatch(comment, /\| \| \|\n\|---\|---\|/);
  assert.match(comment, /## Review scores\n\n\| Measure \| Result \| What it means \|/);
  assert.match(comment, /\| \*\*Overall readiness\*\* \| .* \*\*\(5\/6\)\*\* \|/);
  assert.match(comment, /## Verification\n\n\| Check \| Result \| Evidence \|/);
  assert.match(comment, /\| \*\*Real behavior\*\* \| Verified \| Sufficient \(terminal\):/);
  assert.match(comment, /\| \*\*Evidence reviewed\*\* \| 1 item \| targeted lane:/);
  assert.match(
    comment,
    /## How this fits together\n\nOpenClaw resolves a session's model override before sending the next agent request\.\n\n```mermaid\nflowchart LR/,
  );
  assert.ok(comment.indexOf("## Verification") < comment.indexOf("## How this fits together"));
  assert.doesNotMatch(comment, /## Proof/);
  assert.match(comment, /\*\*Reviewed head:\*\* `abc123def456abc123def456abc123def456abcd`/);
  assert.doesNotMatch(comment, /\*\*Workflow note:\*\*/);
  assert.match(comment, /### Workflow/);
  assert.match(
    comment,
    /- Re-runs edit this comment so the latest verdict, findings, and automation markers stay together instead of adding duplicate bot comments\./,
  );
  assert.match(
    comment,
    /- A fresh review can be triggered by eligible `@clawsweeper re-review` comments, exact-item GitHub events, scheduled\/background review runs, or manual workflow dispatch\./,
  );
  assert.match(
    comment,
    /- PR\/issue authors and users with repository write access can comment `@clawsweeper re-review` or `@clawsweeper re-run` on an open PR or issue to request a fresh review only\./,
  );
  assert.match(
    comment,
    /- Maintainers can also comment `@clawsweeper review` to request a fresh review only\./,
  );
  assert.match(
    comment,
    /- Fresh-review commands do not start repair, autofix, rebase, CI repair, or automerge\./,
  );
  assert.match(
    comment,
    /- Maintainer-only repair and merge flows require explicit commands such as `@clawsweeper autofix`, `@clawsweeper automerge`, `@clawsweeper fix ci`, or `@clawsweeper address review`\./,
  );
  assert.match(
    comment,
    /- Maintainers can comment `@clawsweeper explain` to ask for more context, or `@clawsweeper stop` to stop active automation\./,
  );
  // Ordinary maintainer review guidance collapses out of the checklist.
  assert.match(comment, /## Before merge\n\nNone\./);
  assert.match(comment, /<summary><strong>Agent review details<\/strong><\/summary>/);
  assert.match(comment, /Best possible solution:\n\nMerge after required checks are green\./);
  assert.match(
    comment,
    /Do we have a high-confidence way to reproduce the issue\?\n\nNot applicable\. This is a test-only PR/,
  );
  assert.match(
    comment,
    /Is this the best way to solve the issue\?\n\nYes\. Landing the focused regression test/,
  );
  assert.match(
    detailsBody(comment, "Agent review details"),
    /AGENTS\.md: found and applied where relevant\./,
  );
  assert.ok(
    comment.indexOf("Is this the best way to solve the issue?") < comment.indexOf("### Evidence"),
  );
  assert.match(detailsBody(comment, "Agent review details"), /What I checked:/);
  assert.ok(comment.indexOf("### Technical review") < comment.indexOf("### Evidence"));
  assert.ok(comment.indexOf("### Evidence") < comment.indexOf("### Rating scale"));
  assert.ok(comment.indexOf("### Rating scale") < comment.indexOf("### Workflow"));
  assert.match(
    comment,
    /<!-- clawsweeper-verdict:needs-human item=74265 sha=abc123def456abc123def456abc123def456abcd/,
  );
});

test("review comments include the UTC date when ET and UTC calendar dates differ", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74266",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      work_candidate: "none",
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
      reviewed_at: "2026-07-09T03:00:00.000Z",
    })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Updates review timestamp formatting.

## Best Possible Solution

Merge after required checks are green.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
    "none",
  );

  assert.match(
    comment,
    /Codex review: needs maintainer review before merge\. _Reviewed July 8, 2026, 11:00 PM ET \/ July 9, 2026, 03:00 UTC\._/,
  );
});

test("issue keep-open review comments surface reproducibility in the summary", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "issue",
      number: "75877",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      work_candidate: "queue_fix_pr",
    })}

## Summary

Keep open. Slack typing callbacks are disabled in message-tool-only group replies.

## Reproduction Assessment

Yes. A source-level reproduction is clear: set a Slack group turn to message-tool-only and inspect the dispatch typing callbacks.

## Work Candidate

Candidate: queue_fix_pr

Confidence: high

Priority: medium

Status: queued

Reason: The bug is narrow and source-reproducible.
`,
    "none",
  );

  assert.match(
    comment,
    /\*\*Summary\*\*\nKeep open\. Slack typing callbacks are disabled in message-tool-only group replies\.\n\nReproducibility: yes\. A source-level reproduction is clear/,
  );
  assert.ok(comment.indexOf("Reproducibility: yes.") < comment.indexOf("**Next step**"));
  assert.doesNotMatch(comment, /\*\*Ways to help us reproduce this\*\*/);
  assert.doesNotMatch(comment, /\*\*Security\*\*/);
  assert.doesNotMatch(comment, /Not applicable:/);
  assert.match(
    comment,
    /Do we have a high-confidence way to reproduce the issue\?\n\nYes\. A source-level reproduction is clear/,
  );
});

test("high-confidence root-cause clusters appear in keep-open review comments", () => {
  const rootCauseCluster = {
    confidence: "high",
    canonicalRef: "https://github.com/openclaw/openclaw/pull/75880",
    currentItemRelationship: "same_root_cause",
    summary: "The issue and candidate PR cover the same reproduced callback failure.",
    members: [
      {
        ref: "https://github.com/openclaw/openclaw/pull/75880",
        relationship: "canonical",
        reason: "This PR contains the focused fix and regression coverage.",
      },
    ],
  };
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "issue",
      number: "75877",
      root_cause_cluster: JSON.stringify(rootCauseCluster),
    })}

## Summary

Keep open while maintainers evaluate the candidate fix.

## Best Possible Solution

Review the linked candidate PR.
`,
    "none",
  );

  assert.match(comment, /\*\*Root-cause cluster\*\*/);
  assert.match(comment, /Relationship: `same_root_cause`/);
  assert.match(comment, /Canonical: https:\/\/github\.com\/openclaw\/openclaw\/pull\/75880/);
  assert.match(comment, /- `canonical`: https:\/\/github\.com\/openclaw\/openclaw\/pull\/75880/);
  assert.match(comment, /Proposal only: this assessment does not dispatch repair/);
});

test("low-confidence root-cause clusters stay out of public comments", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "issue",
      number: "75877",
      root_cause_cluster: JSON.stringify({
        confidence: "low",
        canonicalRef: null,
        currentItemRelationship: "independent",
        summary: "No evidence-backed root-cause cluster was established.",
        members: [],
      }),
    })}

## Summary

Keep open for more evidence.
`,
    "none",
  );

  assert.doesNotMatch(comment, /\*\*Root-cause cluster\*\*/);
  assert.doesNotMatch(comment, /Proposal only: this assessment/);
});

test("high-confidence root-cause clusters appear in close comments", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      root_cause_cluster: JSON.stringify({
        confidence: "high",
        canonicalRef: "https://github.com/openclaw/clawsweeper/issues/400",
        currentItemRelationship: "duplicate",
        summary: "The canonical issue tracks the remaining work.",
        members: [
          {
            ref: "https://github.com/openclaw/clawsweeper/issues/400",
            relationship: "canonical",
            reason: "This issue has the broader accepted scope.",
          },
        ],
      }),
    }),
    "implemented_on_main",
  );

  assert.match(comment, /\*\*Root-cause cluster\*\*/);
  assert.match(comment, /Relationship: `duplicate`/);
  assert.match(comment, /Canonical: https:\/\/github\.com\/openclaw\/clawsweeper\/issues\/400/);
});

test("verified regression provenance renders the predecessor PR without local source details", () => {
  const mergeSha = "a".repeat(40);
  const closeComment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_provenance_repo: "openclaw/clawsweeper",
      regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
      regression_provenance_pr_number: "936",
      regression_provenance_merge_sha: mergeSha,
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_evidence_type: "blame_to_merge_commit",
      regression_provenance_verification_source: "raw_parent_line_v1",
      regression_provenance_merged_at: "2026-07-31T12:00:00Z",
      regression_provenance_reviewed_sha: "b".repeat(40),
      regression_provenance_source_commit_sha: mergeSha,
      regression_provenance_source_author: "Source Author",
    }),
    "implemented_on_main",
  );
  assert.match(
    closeComment,
    /Regression provenance — verified: source commit `aaaaaaaaaaaa` by Source Author; canonical PR \[#936\]\(https:\/\/github\.com\/openclaw\/clawsweeper\/pull\/936\)/,
  );
  assert.match(closeComment, /\(blame-to-merge-commit\)/);
  assert.doesNotMatch(closeComment, /src\/clawsweeper-review-runtime\.ts/);
  assert.doesNotMatch(closeComment, new RegExp(mergeSha));

  const keepOpenComment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "issue",
      number: "946",
      regression_provenance_repo: "openclaw/clawsweeper",
      regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
      regression_provenance_pr_number: "936",
      regression_provenance_merge_sha: mergeSha,
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_evidence_type: "blame_to_merge_commit",
      regression_provenance_verification_source: "raw_parent_line_v1",
      regression_provenance_merged_at: "2026-07-31T12:00:00Z",
      regression_provenance_reviewed_sha: "b".repeat(40),
      regression_provenance_source_commit_sha: mergeSha,
      regression_provenance_source_author: "Source Author",
    })}

## Summary

Keep open while the regression is fixed.
`,
    "none",
  );
  assert.match(keepOpenComment, /\*\*Regression provenance\*\*/);
  assert.match(
    keepOpenComment,
    /\[#936\]\(https:\/\/github\.com\/openclaw\/clawsweeper\/pull\/936\)/,
  );
});

test("legacy structured provenance without raw-parent proof cannot name a predecessor", () => {
  for (const evidenceType of ["blame_to_merge_commit", "source_line", "rewrite_equivalent"]) {
    const comment = renderReviewCommentFromReport(
      implementedCloseReport({
        regression_assessment_confidence: "suspected",
        regression_assessment_evidence: "reviewed_change",
        regression_provenance_repo: "openclaw/clawsweeper",
        regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
        regression_provenance_pr_number: "936",
        regression_provenance_merge_sha: "a".repeat(40),
        regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
        regression_provenance_source_line: "42",
        regression_provenance_evidence_type: evidenceType,
        regression_provenance_merged_at: "2026-07-31T12:00:00Z",
        regression_provenance_reviewed_sha: "b".repeat(40),
        regression_provenance_source_commit_sha: "a".repeat(40),
        regression_provenance_source_author: "Unverified Source Author",
        regression_provenance_related_repo: "openclaw/clawsweeper",
        regression_provenance_related_pr_number: "936",
        regression_provenance_related_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
      }),
      "implemented_on_main",
    );
    assert.match(comment, /Possible regression — suspected/);
    assert.doesNotMatch(comment, /source commit `aaaaaaaaaaaa`|Unverified Source Author|pull\/936/);
  }
});

test("unverified regression-provenance front matter cannot render a predecessor", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_provenance_repo: "openclaw/clawsweeper",
      regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
      regression_provenance_pr_number: "936",
      regression_provenance_merge_sha: "a".repeat(40),
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_evidence_type: "model_claim",
      regression_provenance_merged_at: "2026-07-31T12:00:00Z",
      regression_provenance_reviewed_sha: "b".repeat(40),
    }),
    "implemented_on_main",
  );

  assert.doesNotMatch(comment, /Verified regression provenance/);
  assert.doesNotMatch(comment, /pull\/936/);
});

test("verified provenance rejects a source commit that differs from the merge commit", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_provenance_repo: "openclaw/clawsweeper",
      regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
      regression_provenance_pr_number: "936",
      regression_provenance_merge_sha: "a".repeat(40),
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_evidence_type: "blame_to_merge_commit",
      regression_provenance_verification_source: "raw_parent_line_v1",
      regression_provenance_merged_at: "2026-07-31T12:00:00Z",
      regression_provenance_reviewed_sha: "b".repeat(40),
      regression_provenance_source_commit_sha: "c".repeat(40),
      regression_provenance_source_author: "Source Author",
    }),
    "implemented_on_main",
  );

  assert.doesNotMatch(comment, /Regression provenance.*verified|canonical PR \[#936\]/);
});

test("verified provenance accepts equivalent normalized source commit text", () => {
  const sha = "a".repeat(40);
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_provenance_repo: "openclaw/clawsweeper",
      regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
      regression_provenance_pr_number: "936",
      regression_provenance_merge_sha: sha,
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_evidence_type: "blame_to_merge_commit",
      regression_provenance_verification_source: "raw_parent_line_v1",
      regression_provenance_merged_at: "2026-07-31T12:00:00Z",
      regression_provenance_reviewed_sha: "b".repeat(40),
      regression_provenance_source_commit_sha: ` ${sha.toUpperCase()} `,
      regression_provenance_source_author: "Source Author",
    }),
    "implemented_on_main",
  );

  assert.match(comment, /Regression provenance.*verified/);
  assert.match(comment, /source commit `aaaaaaaaaaaa`/);
});

test("verified provenance rejects Unicode direction controls in author names", () => {
  const sha = "a".repeat(40);
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_provenance_repo: "openclaw/clawsweeper",
      regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
      regression_provenance_pr_number: "936",
      regression_provenance_merge_sha: sha,
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_evidence_type: "blame_to_merge_commit",
      regression_provenance_verification_source: "raw_parent_line_v1",
      regression_provenance_merged_at: "2026-07-31T12:00:00Z",
      regression_provenance_reviewed_sha: "b".repeat(40),
      regression_provenance_source_commit_sha: sha,
      regression_provenance_source_author: "safe\u202eevil",
    }),
    "implemented_on_main",
  );

  assert.doesNotMatch(comment, /Regression provenance.*verified|safe/);
});

test("verified provenance rejects email-shaped author names", () => {
  const sha = "a".repeat(40);
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_provenance_repo: "openclaw/clawsweeper",
      regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
      regression_provenance_pr_number: "936",
      regression_provenance_merge_sha: sha,
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_evidence_type: "blame_to_merge_commit",
      regression_provenance_verification_source: "raw_parent_line_v1",
      regression_provenance_merged_at: "2026-07-31T12:00:00Z",
      regression_provenance_reviewed_sha: "b".repeat(40),
      regression_provenance_source_commit_sha: sha,
      regression_provenance_source_author: "Private Author <private@localhost>",
    }),
    "implemented_on_main",
  );

  assert.doesNotMatch(comment, /Regression provenance.*verified|private@/);
});

test("suspected provenance renders commit, author, status, and only a verified related PR", () => {
  const base = {
    regression_assessment_confidence: "suspected",
    regression_assessment_evidence: "reviewed_change",
    regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
    regression_provenance_source_line: "42",
    regression_provenance_source_commit_sha: "c".repeat(40),
    regression_provenance_source_author: "Source Author",
    regression_provenance_evidence_type: "source_line",
    regression_provenance_verification_source: "raw_parent_line_v1",
  };
  const unlinked = renderReviewCommentFromReport(
    implementedCloseReport(base),
    "implemented_on_main",
  );
  assert.match(unlinked, /suspected predecessor, not a causality claim/);
  assert.match(unlinked, /source commit `cccccccccccc` by Source Author; no PR verified/);

  const linked = renderReviewCommentFromReport(
    implementedCloseReport({
      ...base,
      regression_provenance_evidence_type: "rewrite_equivalent",
      regression_provenance_verification_source: "raw_parent_line_v1",
      regression_provenance_related_pr_number: "1023",
      regression_provenance_related_pr_url: "https://github.com/openclaw/clawsweeper/pull/1023",
      regression_provenance_related_repo: "openclaw/clawsweeper",
    }),
    "implemented_on_main",
  );
  assert.match(linked, /safely related PR \[#1023\]/);

  const spoofed = renderReviewCommentFromReport(
    implementedCloseReport({
      ...base,
      regression_provenance_evidence_type: "rewrite_equivalent",
      regression_provenance_verification_source: "raw_parent_line_v1",
      regression_provenance_related_pr_number: "1023",
      regression_provenance_related_pr_url: "https://example.test/not-a-pr",
      regression_provenance_related_repo: "openclaw/clawsweeper",
    }),
    "implemented_on_main",
  );
  assert.doesNotMatch(spoofed, /example\.test|safely related PR/);

  const impossibleLine = renderReviewCommentFromReport(
    implementedCloseReport({
      ...base,
      regression_provenance_source_line: "0",
    }),
    "implemented_on_main",
  );
  assert.doesNotMatch(impossibleLine, /suspected predecessor|source commit `cccccccccccc`/);
});

test("suspected provenance supplements rather than suppresses regression assessment", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_assessment_confidence: "probable",
      regression_assessment_evidence: "reproduction,reviewed_change",
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_source_commit_sha: "c".repeat(40),
      regression_provenance_source_author: "Source Author",
      regression_provenance_evidence_type: "source_line",
      regression_provenance_verification_source: "raw_parent_line_v1",
    }),
    "implemented_on_main",
  );

  assert.match(comment, /suspected predecessor, not a causality claim/);
  assert.match(comment, /Possible regression \u2014 probable \(reproduction; reviewed change\)/);
});

test("rewrite-equivalent provenance and assessment do not contradict each other", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_assessment_confidence: "probable",
      regression_assessment_evidence: "reproduction,reviewed_change",
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_source_commit_sha: "c".repeat(40),
      regression_provenance_source_author: "Source Author",
      regression_provenance_evidence_type: "rewrite_equivalent",
      regression_provenance_verification_source: "raw_parent_line_v1",
      regression_provenance_related_pr_number: "1023",
      regression_provenance_related_pr_url: "https://github.com/openclaw/clawsweeper/pull/1023",
      regression_provenance_related_repo: "openclaw/clawsweeper",
    }),
    "implemented_on_main",
  );

  assert.match(comment, /safely related PR \[#1023\]/);
  assert.match(comment, /Possible regression \u2014 probable \(reproduction; reviewed change\)\./);
  assert.doesNotMatch(comment, /No predecessor PR is attributed/);
});

test("provenance author names cannot trigger GitHub mentions", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_assessment_confidence: "suspected",
      regression_assessment_evidence: "reviewed_change",
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_source_commit_sha: "c".repeat(40),
      regression_provenance_source_author: "@openclaw/maintainers",
      regression_provenance_evidence_type: "source_line",
      regression_provenance_verification_source: "raw_parent_line_v1",
    }),
    "implemented_on_main",
  );

  assert.doesNotMatch(comment, /@openclaw\/maintainers/);
  assert.match(comment, /@\u200bopenclaw\/maintainers/);
});

test("a provenance author literally named unknown remains visible", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_assessment_confidence: "suspected",
      regression_assessment_evidence: "reviewed_change",
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_source_commit_sha: "c".repeat(40),
      regression_provenance_source_author: "unknown",
      regression_provenance_evidence_type: "source_line",
      regression_provenance_verification_source: "raw_parent_line_v1",
    }),
    "implemented_on_main",
  );

  assert.match(comment, /source commit `cccccccccccc` by unknown; no PR verified/);
});

test("suspected provenance rejects Unicode direction controls in author names", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_assessment_confidence: "suspected",
      regression_assessment_evidence: "reviewed_change",
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_source_commit_sha: "c".repeat(40),
      regression_provenance_source_author: "safe\u202eevil",
      regression_provenance_evidence_type: "source_line",
      regression_provenance_verification_source: "raw_parent_line_v1",
    }),
    "implemented_on_main",
  );

  assert.doesNotMatch(comment, /suspected predecessor|safe/);
  assert.match(comment, /Possible regression \u2014 suspected/);
});

test("suspected provenance rejects email-shaped author names", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_assessment_confidence: "suspected",
      regression_assessment_evidence: "reviewed_change",
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "42",
      regression_provenance_source_commit_sha: "c".repeat(40),
      regression_provenance_source_author: "Private Author <private@localhost>",
      regression_provenance_evidence_type: "source_line",
      regression_provenance_verification_source: "raw_parent_line_v1",
    }),
    "implemented_on_main",
  );

  assert.doesNotMatch(comment, /suspected predecessor|private@/);
  assert.match(comment, /Possible regression \u2014 suspected/);
});

test("probable regression assessments render evidence without attributing a predecessor", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_assessment_confidence: "probable",
      regression_assessment_evidence: "reproduction,reviewed_change",
      regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
    }),
    "implemented_on_main",
  );

  assert.match(
    comment,
    /Possible regression — probable \(reproduction; reviewed change\)\. No predecessor PR is attributed\./,
  );
  assert.doesNotMatch(comment, /pull\/936/);
  assert.doesNotMatch(comment, /Verified regression provenance/);
});

test("suspected regression assessments retain their lower confidence", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      regression_assessment_confidence: "suspected",
      regression_assessment_evidence: "failure_trace",
    }),
    "implemented_on_main",
  );

  assert.match(
    comment,
    /Possible regression — suspected \(failure trace\)\. No predecessor PR is attributed\./,
  );
  assert.doesNotMatch(comment, /https:\/\/github\.com\/openclaw\/clawsweeper\/pull\//);
});

test("pull request close comments emit close-required automation markers", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: 74270,
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    }),
    "implemented_on_main",
  );

  assert.match(
    comment,
    /<!-- clawsweeper-verdict:close item=74270 sha=abc123def456abc123def456abc123def456abcd confidence=high updated_at=2026-05-01T00:00:00Z reviewed_at=[^ ]+ lease_owner=fixture lease_comment_id=1059 source_revision=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef live_verification=absent action_taken=proposed_close reason=implemented_on_main -->/,
  );
  assert.match(
    comment,
    /<!-- clawsweeper-action:close-required item=74270 sha=abc123def456abc123def456abc123def456abcd confidence=high updated_at=2026-05-01T00:00:00Z reviewed_at=[^ ]+ lease_owner=fixture lease_comment_id=1059 source_revision=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef live_verification=absent action_taken=proposed_close reason=implemented_on_main -->/,
  );
  assert.doesNotMatch(comment, /clawsweeper-verdict:needs-human/);
});

test("issue keep-open review comments suggest concrete reproduction help", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "issue",
      number: "75878",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "manual_review",
      reproduction_status: "unclear",
      reproduction_confidence: "low",
    })}

## Summary

Keep open. The app sometimes does the wrong thing.

## Reproduction Assessment

Unclear. The report describes an intermittent visible failure but does not include enough information to reproduce it.

## Best Possible Solution

Ask for enough details to reproduce the issue before planning a fix.
`,
    "none",
  );

  assert.match(comment, /\*\*Ways to help us reproduce this\*\*/);
  assert.match(comment, /- Add a screenshot or short recording showing the behavior\./);
  assert.match(comment, /- Include the exact command, prompt, or workflow that triggered it\./);
  assert.match(comment, /- Add expected vs actual behavior\./);
  assert.ok(
    comment.indexOf("**Ways to help us reproduce this**") < comment.indexOf("**Next step**"),
  );
});

test("pull request review comments include dedicated security review", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74265",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      work_candidate: "none",
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Updates a workflow permission for review comments.

## Best Possible Solution

Land the workflow permission change after normal CI.

## Security Review

Status: needs_attention

Summary: The workflow now asks for issue write permission, so the permission scope needs maintainer confirmation.

Concerns:

- **[medium] Confirm issue write scope:** \`.github/workflows/sweep.yml:652\`
  - body: The review shard now writes comments during review, so maintainers should confirm the app permission is intended.
  - confidence: 0.82

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.85

Full review comments:

- none

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Reason: Normal maintainer review is sufficient.

## Evidence

- **workflow:** Review shard requests issue write permission.

## Likely Related People

- **@alice:** recent workflow maintainer
  - reason: touched the workflow recently
  - commits: abc123
  - files: .github/workflows/sweep.yml
  - confidence: high

## Risks / Open Questions

- none
`,
    "none",
  );

  assert.match(comment, /\| \*\*Security\*\* \| Needs attention \|/);
  assert.match(comment, /### Security/);
  assert.match(comment, /Needs attention:/);
  assert.match(comment, /Confirm issue write scope/);
  assert.match(comment, /Agent review details/);
  assert.doesNotMatch(comment, /recent workflow maintainer/);
  assert.match(comment, /unverified routing candidate/);
  assert.doesNotMatch(comment, /touched the workflow recently/);
  assert.match(
    comment,
    /<!-- clawsweeper-security:security-sensitive item=74265 sha=abc123def456abc123def456abc123def456abcd/,
  );
  assert.match(
    comment,
    /<!-- clawsweeper-verdict:needs-human item=74265 sha=abc123def456abc123def456abc123def456abcd/,
  );
});

test("pull request keep-open review comments surface Codex-style findings", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74268",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      work_candidate: "queue_fix_pr",
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    })}

## Summary

This PR needs one correctness fix before merge.

## What This Changes

Adds a config patch command for scripted config edits.

## Best Possible Solution

Reject misspelled replacement paths before writing the updated config.

## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.86

Full review comments:

- **[P1] Validate replace paths:** \`src/config/apply.ts:42-44\`
  - body: A misspelled replace path is currently ignored, so the command can report success while leaving the intended setting unchanged.
  - confidence: 0.9

## Work Candidate

Candidate: queue_fix_pr

Confidence: high

Priority: high

Status: candidate

Reason: The fix is narrow and can be made on the PR branch.
`,
    "none",
  );

  assert.match(comment, /Codex review: needs changes before merge\./);
  assert.doesNotMatch(comment, /\*\*Workflow note:\*\*/);
  assert.match(comment, /### Workflow/);
  assert.match(
    comment,
    /## Findings\n\n- \[P1\] Validate replace paths — `src\/config\/apply\.ts:42-44`/,
  );
  assert.doesNotMatch(comment, /\*\*\[P[0-2]\]\*\*/);
  assert.match(comment, /Full review comments:/);
  assert.match(comment, /A misspelled replace path is currently ignored/);
  assert.match(comment, /Overall correctness: patch is incorrect/);
  assert.match(comment, /<!-- clawsweeper-action:fix-required/);
});

test("pull request keep-open review comments suppress duplicate best solution text", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74266",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      work_candidate: "none",
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    })}

## Summary

Keep this docs-only PR open for maintainer review.

## What This Changes

Documents ClawSweeper self-review smoke coverage.

## Best Possible Solution

Land this docs-only PR after maintainer review.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
    "none",
  );

  // Ordinary maintainer review is routine, so it collapses out of Before merge.
  assert.match(comment, /## Before merge\n\nNone\./);
  assert.doesNotMatch(comment, /\[P2\] Land this docs-only PR/);
  assert.doesNotMatch(comment, /Best possible solution:/);
});

test("pull request review comments do not priority-prefix routine no-op guidance", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74269",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      work_candidate: "none",
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    })}

## Summary

Keep this narrow PR open for maintainer review.

## PR Rating

Overall tier: B
Proof tier: B
Patch tier: B
Summary: Ready for review.
Next rank-up steps:
- none

## Best Possible Solution

No ClawSweeper repair lane is needed; the submitted PR is narrow and the remaining action is normal maintainer review and CI.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
    "none",
  );

  assert.match(comment, /## Before merge\n\nNone\./);
  assert.doesNotMatch(comment, /No ClawSweeper repair lane is needed/);
  assert.doesNotMatch(comment, /\[P2\] none/);
  assert.doesNotMatch(comment, /\[P2\] No ClawSweeper repair lane is needed/);
});

test("pull request next-step priority prefixes classify fail-closed work as P1", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74268",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    })}

## Summary

Keep this compatibility PR open for maintainer review.

## What This Changes

Changes relay restart handling.

## Best Possible Solution

Prove the fail-closed compatibility break is handled before merge.
`,
    "none",
  );

  assert.match(
    comment,
    /- \[ \] \*\*Complete next step \(P1\)\*\* - Prove the fail-closed compatibility break is handled before merge\./,
  );
  assert.doesNotMatch(comment, /\*\*\[P1\]\*\*/);
});

test("pull request automerge review comments can emit pass verdicts", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74453",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      labels: JSON.stringify(["clawsweeper:automerge"]),
      work_candidate: "none",
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    })}

## Summary

Keep this focused PR open for automerge.

## What This Changes

Closes the voice-call webhook limiter fail-open path.

## Best Possible Solution

Merge after required checks are green.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
    "none",
  );

  assert.match(comment, /Codex review: passed\./);
  assert.match(comment, /## Before merge\n\nNone\./);
  assert.doesNotMatch(comment, /\[P2\] Merge after required checks are green/);
  assert.doesNotMatch(comment, /Automerge follow-up:/);
  assert.match(
    comment,
    /<!-- clawsweeper-verdict:pass item=74453 sha=abc123def456abc123def456abc123def456abcd/,
  );
  assert.doesNotMatch(comment, /clawsweeper-verdict:needs-human/);
});

test("coverage-proof blocked PR reports do not emit repair pass verdicts", () => {
  const markers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74456",
    decision: "keep_open",
    close_reason: "none",
    action_taken: "skipped_pr_close_coverage_proof",
    review_status: "complete",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
  })}

## Summary

Keep this superseded PR open until coverage proof passes.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`);

  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
});

test("recovery cleanup preserves durable-review ordering and exact publication batching", () => {
  const source = readFileSync("src/clawsweeper-apply-decision-workflow.ts", "utf8");
  const delayedBatch = source.indexOf("const delayIssueLabelBatchForRecoveryCleanup =");
  const publication = source.indexOf("syncedComment = upsertReviewComment(");
  const recoveryCleanup = source.indexOf("clearResolvedReviewRecoveryLabel({", publication);
  const delayedFlush = source.indexOf(
    "if (delayIssueLabelBatchForRecoveryCleanup)",
    recoveryCleanup,
  );
  const nextCatch = source.indexOf("} catch (error)", delayedFlush);

  assert.ok(delayedBatch >= 0);
  assert.ok(delayedBatch < publication);
  assert.ok(publication >= 0);
  assert.ok(recoveryCleanup > publication);
  assert.ok(delayedFlush > recoveryCleanup);
  assert.match(
    source.slice(delayedBatch, publication),
    /if \(!delayIssueLabelBatchForRecoveryCleanup\)/,
  );
  assert.match(source.slice(recoveryCleanup, delayedFlush), /if \(issueLabelBatchActive\)/);
  assert.match(source.slice(delayedFlush, nextCatch), /flushIssueLabelBatchForDurableComment\(\);/);
  assert.match(source.slice(recoveryCleanup, nextCatch), /removeLabel:\s*removeIssueLabel/);
});
