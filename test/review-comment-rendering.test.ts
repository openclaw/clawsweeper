import { renderReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import MarkdownIt from "markdown-it";

import {
  canPatchReviewComment,
  isCodexReviewCommentBody,
  parseDecision,
  renderReviewStartStatusComment,
  reviewAutomationMarkersFromReport,
  shouldPreserveReviewStartLease,
  withReviewStartStatusLease,
} from "../dist/clawsweeper.js";
import { itemSourceRevisionSha256 } from "../dist/clawsweeper-source-revision.js";
import { postReviewStartStatusComment } from "../dist/clawsweeper-review-comment-leases.js";
import { issueSourceRevisionSha256 } from "../dist/repair/issue-source-guard.js";
import {
  closeDecision,
  detailsBody,
  item,
  prRatingReportSection,
  realBehaviorProofReportSection,
  reviewReportFrontMatter as reportFrontMatter,
  withMockGh,
  withReviewRecord,
} from "./helpers.ts";
import { readReviewRecord } from "../dist/review-record.js";
import * as document from "../dist/clawsweeper-report-document.js";
import { withGitHubRun } from "../dist/clawsweeper-github-runtime.js";
import type {
  Decision,
  DecisionKind,
  Evidence,
  NextStepAssessment,
  ReviewStartStatusCommentResult,
} from "../dist/clawsweeper-types.js";

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

function evidenceReport(
  evidence: Evidence[],
  decisionKind: DecisionKind = "close",
  nextStep?: NextStepAssessment,
  overrides: Partial<Decision> = {},
) {
  const { regressionProvenance, ...modelOverrides } = overrides;
  return document.markdownFor({
    item: item({ kind: "pull_request", url: "https://github.com/openclaw/openclaw/pull/123" }),
    decision: {
      ...parseDecision(
        closeDecision({
          evidence,
          decision: decisionKind,
          closeReason: decisionKind === "close" ? "implemented_on_main" : "none",
          ...(nextStep === undefined ? {} : { nextStep }),
          ...modelOverrides,
        }),
      ),
      // The host stamps checkout access after parsing model output.
      localCheckoutAccess: "verified",
      ...(regressionProvenance === undefined ? {} : { regressionProvenance }),
    },
    context: {
      issue: {},
      comments: [],
      timeline: [],
      pullRequest: { head: { sha: "c".repeat(40) } },
    },
    git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
    action: { actionTaken: decisionKind === "close" ? "proposed_close" : "kept_open" },
    reviewMode: "propose",
    snapshotHash: "synthetic-snapshot",
    contentDigest: "synthetic-content",
    reviewPolicy: "synthetic-policy",
    runtime: { model: "Codex", reasoningEffort: "high" },
    reviewLeaseOwner: "github-run-123456-1",
    reviewLeaseCommentId: 123456,
  } as Parameters<typeof document.markdownFor>[0]);
}

function nextStepReport(
  overrides: Partial<Decision> = {},
  metadata: Record<string, string | undefined> = {},
  sections = "",
) {
  return withReviewRecord(
    `${reportFrontMatter({
      type: "pull_request",
      number: "123",
      review_status: "complete",
      local_checkout_access: "verified",
      author_association: "MEMBER",
      work_candidate: "none",
      pull_head_sha: "c".repeat(40),
      ...metadata,
    })}\n${sections}`,
    {
      decision: "keep_open",
      closeReason: "none",
      summary: "The retry guard is ready for review.",
      changeSummary: "Keeps retry ownership bounded.",
      overallCorrectness: "patch is correct",
      nextStep: { kind: "none", text: "" },
      prRating: {
        proofTier: "B",
        patchTier: "B",
        overallTier: "B",
        summary: "Ready for review.",
        nextSteps: [],
      },
      realBehaviorProof: {
        status: "sufficient",
        evidenceKind: "terminal",
        needsContributorAction: false,
        summary: "The retry guard was exercised directly.",
      },
      ...overrides,
    },
  );
}

function publicSection(comment: string, title: string): string {
  return (
    comment
      .split(`## ${title}\n\n`)[1]
      ?.split(/\n## |\n<details>/)[0]
      ?.trim() ?? ""
  );
}

function readyNextStepReport(nextStep?: NextStepAssessment): string {
  return evidenceReport([], "keep_open", nextStep, {
    overallCorrectness: "patch is correct",
    prRating: {
      proofTier: "B",
      patchTier: "B",
      overallTier: "B",
      summary: "The retry guard is ready for review.",
      nextSteps: [],
    },
    realBehaviorProof: {
      status: "sufficient",
      evidenceKind: "terminal",
      needsContributorAction: false,
      summary: "The retry guard was exercised directly.",
    },
  });
}

test("a report without a typed next step fails closed; explicit none is ready", () => {
  const legacy = readyNextStepReport();
  const report = readyNextStepReport({ kind: "none", text: "" });
  const before = renderReviewCommentFromReport(legacy, "none");
  const after = renderReviewCommentFromReport(report, "none");
  assert.match(
    publicSection(before, "Before merge"),
    /^- \[ \] \*\*Run a fresh ClawSweeper review\*\* - This review report has no valid next-step record\./,
  );
  assert.doesNotMatch(before, /Complete next step|No concrete repair remains/);
  assert.match(before, /1 item remains/);
  assert.match(reviewAutomationMarkersFromReport(legacy), /clawsweeper-review-state:blocked/);
  assert.equal(publicSection(after, "Before merge"), "None.");
  assert.doesNotMatch(after, /Run a fresh ClawSweeper review|1 item remains/);
  assert.equal(publicSection(after, "Review scores"), publicSection(before, "Review scores"));
  assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-review-state:ready/);
  for (const comment of [before, after]) {
    assert.doesNotMatch(comment, /clawsweeper-verdict:pass/);
  }
});

test("a required next step is one Before-merge item without a priority, whatever its wording", () => {
  for (const text of [
    "No schema change is needed, but repair the retry guard before merge.",
    "Do not merge until the owner approves the compatibility contract.",
    "Owner approval.",
    "Wait for CI and ordinary maintainer review.",
    "A decision on ownership is still outstanding.",
    "A data loss outage is possible.",
  ]) {
    const report = readyNextStepReport({ kind: "required", text });
    const comment = renderReviewCommentFromReport(report, "none");
    const beforeMerge = publicSection(comment, "Before merge");
    assert.ok(beforeMerge.includes(`- [ ] **Complete next step** - ${text}`), text);
    assert.equal((beforeMerge.match(/^- \[ \]/gm) ?? []).length, 1, text);
    assert.match(comment, /1 item remains/);
    assert.match(
      reviewAutomationMarkersFromReport(report),
      /clawsweeper-review-state:needs-changes/,
      text,
    );
  }
});

test("canonical next-step report round-trip preserves explicit intent and absent intent", () => {
  for (const nextStep of [
    undefined,
    { kind: "none", text: "" },
    { kind: "required", text: "Owner approval." },
  ] as const) {
    const report = evidenceReport([], "keep_open", nextStep);
    assert.deepEqual(readReviewRecord(report)?.decision.nextStep, nextStep);
    if (nextStep === undefined) assert.doesNotMatch(report, /^next_step:/m);
    else assert.ok(report.split("\n---")[0]!.includes(`next_step: ${JSON.stringify(nextStep)}`));
    const comment = renderReviewCommentFromReport(report, "none");
    if (nextStep === undefined)
      assert.match(publicSection(comment, "Before merge"), /Run a fresh ClawSweeper review/);
    if (nextStep?.kind === "none")
      assert.doesNotMatch(
        publicSection(comment, "Before merge"),
        /Complete next step|Run a fresh ClawSweeper review/,
      );
    if (nextStep?.kind === "required")
      assert.match(publicSection(comment, "Before merge"), /Owner approval\./);
  }
});

test("accepted labeled risk survives decision and report parsing without reopening a blocker", () => {
  const accepted = "The maintainer accepted the documented fresh-ref requirement for this change.";
  const decision: Partial<Decision> = {
    mergeRiskLabels: ["merge-risk: 🚨 compatibility"],
    mergeRiskOptions: [],
    risks: [],
    labelJustifications: [
      { label: "P2", reason: "Bounded compatibility correction." },
      { label: "merge-risk: 🚨 compatibility", reason: accepted },
    ],
    overallCorrectness: "patch is correct",
    realBehaviorProof: {
      status: "sufficient",
      evidenceKind: "terminal",
      needsContributorAction: false,
      summary: "The actual browser path rejected stale refs and accepted newly captured refs.",
    },
    prRating: {
      proofTier: "B",
      patchTier: "B",
      overallTier: "B",
      summary: "The corrected behavior has direct runtime proof.",
      nextSteps: [],
    },
  };
  const evidence: Evidence[] = [
    {
      repo: "openclaw/openclaw",
      label: "Accepted compatibility tradeoff",
      detail: accepted,
      file: null,
      line: null,
      command: null,
      sha: "c".repeat(40),
    },
  ];
  const report = evidenceReport(evidence, "keep_open", { kind: "none", text: "" }, decision);
  const comment = renderReviewCommentFromReport(report, "none");
  assert.match(report, /^merge_risk_labels: .*compatibility/m);
  assert.match(report, /^merge_risk_options: \[\]$/m);
  assert.ok(comment.includes(accepted));
  assert.equal(publicSection(comment, "Before merge"), "None.");
  assert.match(comment, /clawsweeper-review-state:ready/);
  assert.doesNotMatch(comment, /### Merge-risk options/);

  const unresolved = "The new requirement also affects an unreviewed second workflow.";
  const unresolvedDecision = { ...decision, risks: [unresolved] };
  assert.throws(
    () => evidenceReport(evidence, "keep_open", { kind: "none", text: "" }, unresolvedDecision),
    /mergeRiskOptions must include 1-3 options/,
  );
  const blockedReport = evidenceReport(
    evidence,
    "keep_open",
    { kind: "none", text: "" },
    {
      ...unresolvedDecision,
      mergeRiskOptions: [
        {
          title: "Prove the second workflow",
          body: "Exercise the second workflow before deciding whether to accept its impact.",
          category: "fix_before_merge",
          recommended: true,
          automergeInstruction: "",
        },
      ],
    },
  );
  const blocked = renderReviewCommentFromReport(blockedReport, "none");
  assert.ok(publicSection(blocked, "Before merge").includes(unresolved));
  assert.match(blocked, /clawsweeper-review-state:blocked/);

  const independent = renderReviewCommentFromReport(
    evidenceReport(
      evidence,
      "keep_open",
      { kind: "required", text: "Resolve the separate owner decision." },
      decision,
    ),
    "none",
  );
  assert.match(publicSection(independent, "Before merge"), /Resolve the separate owner decision/);
  assert.doesNotMatch(independent, /clawsweeper-review-state:ready/);
});

test("legacy next-step fields cannot supply or override typed review intent", () => {
  const required = { kind: "required", text: "Owner approval." } as const;
  const canonical = evidenceReport([], "keep_open", required);
  const withoutRecord = canonical.replace(/^review_record:.*\n/m, "");
  const misleadingFields = [
    'next_step: {"kind":"none","text":""}',
    "next_step: {broken",
    'next_step: {"kind":"none","text":""}\nnext_step: {"kind":"required","text":"Repair it."}',
    '"next_step": {"kind":"none","text":""}',
  ];
  for (const field of misleadingFields) {
    const report = canonical.replace(/^next_step:.*$/m, field);
    assert.deepEqual(readReviewRecord(report)?.decision.nextStep, required);
    assert.match(
      publicSection(renderReviewCommentFromReport(report, "none"), "Before merge"),
      /Owner approval\./,
    );
    const missing = withoutRecord.replace(/^next_step:.*$/m, field);
    assert.throws(
      () => renderReviewCommentFromReport(missing, "none"),
      /review_record: missing record/,
    );
    assert.throws(
      () => reviewAutomationMarkersFromReport(missing),
      /review_record: missing record/,
    );
  }
  const withExample = `${canonical}\n\`\`\`yaml\n---\nnext_step: {"kind":"none","text":""}\n---\n\`\`\`\n`;
  assert.deepEqual(readReviewRecord(withExample)?.decision.nextStep, required);
});

test("explicit none leaves independent blockers, decision counts and low ratings intact", () => {
  const decision: Decision["maintainerDecision"] = {
    required: true,
    kind: "product_direction",
    question: "Which compatibility contract should ship?",
    rationale: "This needs an owner ruling.",
    options: [
      { title: "Keep compatibility", body: "Retain the old contract.", recommended: true },
      {
        title: "Adopt the new contract",
        body: "Document the intentional break.",
        recommended: false,
      },
    ],
    likelyOwner: { person: "@owner", reason: "Owns the contract.", confidence: "high" },
  };
  const cases: {
    decision?: Partial<Decision>;
    metadata?: Record<string, string>;
    sections?: string;
    label: string;
    count?: number;
  }[] = [
    {
      decision: {
        overallCorrectness: "patch is incorrect",
        reviewFindings: [
          {
            title: "Retry race",
            body: "Repair concurrent retry handling.",
            priority: 1,
            confidenceScore: 0.9,
            file: "src/retry.ts",
            lineStart: 12,
            lineEnd: 12,
          },
        ],
      },
      label: "Retry race",
    },
    {
      decision: {
        securityReview: {
          status: "needs_attention",
          summary: "Confirm ownership.",
          concerns: [
            {
              title: "Ownership boundary",
              body: "Restore the authorization guard.",
              severity: "high",
              confidenceScore: 0.9,
              file: "src/retry.ts",
              line: 12,
            },
          ],
        },
      },
      label: "Resolve security concern",
    },
    {
      decision: { risks: ["Repair the compatibility break before merge."] },
      label: "Resolve merge risk",
    },
    {
      decision: {
        realBehaviorProof: {
          status: "missing",
          evidenceKind: "none",
          needsContributorAction: true,
          summary: "No real behavior proof.",
        },
      },
      metadata: { author_association: "NONE" },
      label: "Add real behavior proof",
    },
    { decision: { maintainerDecision: decision }, label: "Decision needed" },
    {
      decision: {
        prRating: {
          patchTier: "D",
          proofTier: "A",
          overallTier: "D",
          summary: "Patch needs work.",
          nextSteps: [],
        },
      },
      label: "Improve patch quality",
    },
    { metadata: { review_status: "failed" }, label: "Retry ClawSweeper review", count: 0 },
  ];
  for (const scenario of cases) {
    const report = nextStepReport(scenario.decision, scenario.metadata, scenario.sections);
    assert.deepEqual(readReviewRecord(report)?.decision.nextStep, { kind: "none", text: "" });
    const comment = renderReviewCommentFromReport(report, "none");
    assert.ok(comment.includes(scenario.label), scenario.label);
    assert.doesNotMatch(
      publicSection(comment, "Before merge"),
      /Complete next step|Run a fresh ClawSweeper review/,
    );
    if (scenario.count !== 0) assert.match(comment, /1 item remains/, scenario.label);
  }
  const report = nextStepReport({
    maintainerDecision: decision,
    nextStep: { kind: "required", text: "Record the owner decision in the PR body." },
  });
  const comment = renderReviewCommentFromReport(report, "none");
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

test("repository evidence survives structured decisions, records and both comment paths", () => {
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
      assert.deepEqual(readReviewRecord(report)?.decision.evidence, withDependencyVision);
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

test("explicit GitHub destinations preserve full identity", () => {
  const source = `https://github.com/openai/codex/blob/${dependencyEvidence.sha}/${dependencyEvidence.file}#L5668`;
  const commit = `https://github.com/openai/codex/commit/${dependencyEvidence.sha}`;
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

function typedRendererReport(report: string, overrides: Partial<Decision> = {}): string {
  const { regressionProvenance, ...model } = overrides;
  const typed = withReviewRecord(report, {
    decision: "keep_open",
    closeReason: "none",
    nextStep: { kind: "none", text: "" },
    overallCorrectness: "patch is correct",
    prRating: {
      proofTier: "B",
      patchTier: "B",
      overallTier: "B",
      summary: "Ready for review.",
      nextSteps: [],
    },
    realBehaviorProof: {
      status: "sufficient",
      evidenceKind: "terminal",
      needsContributorAction: false,
      summary: "The behavior was exercised directly.",
    },
    ...model,
  });
  if (regressionProvenance === undefined) return typed;
  const record = readReviewRecord(typed)!;
  record.decision.regressionProvenance = regressionProvenance;
  return typed.replace(
    /^review_record:.*$/m,
    () => `review_record: ${JSON.stringify({ version: 1, ...record })}`,
  );
}

function implementedCloseReport(overrides = {}, decision: Partial<Decision> = {}) {
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
  return typedRendererReport(
    [
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
    ].join("\n"),
    {
      decision: "close",
      closeReason: "implemented_on_main",
      closeComment: "Closing this because the requested behavior is already on main.",
      fixedSha: "1234567890abcdef1234567890abcdef12345678",
      fixedAt: "2026-05-01T02:00:00Z",
      evidence: [
        {
          repo: "openclaw/clawsweeper",
          label: "main fix",
          detail:
            "git show confirms current main has the replacement implementation and it is not in the latest release yet",
          file: "src/clawsweeper.ts",
          line: null,
          sha: "1234567890abcdef1234567890abcdef12345678",
          command: null,
        },
      ],
      ...decision,
    },
  );
}

test("lease acquisition ignores spoofed contenders and records a recoverable run identity", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-lease-owner-"));
  const previousRunId = process.env.GITHUB_RUN_ID;
  const previousRunAttempt = process.env.GITHUB_RUN_ATTEMPT;
  try {
    process.env.GITHUB_RUN_ID = "29083888985";
    for (const attempt of ["2", "invalid"]) {
      process.env.GITHUB_RUN_ATTEMPT = attempt;
      const result = acquireFixtureLease(root, false);
      assert.equal(result.status, "posted");
      assert.ok(result.lease);
      if (attempt === "2") assert.equal(result.lease.owner, "github-run-29083888985-2");
      else assert.match(result.lease.owner, /^[0-9a-f-]{36}$/);
      assert.equal(result.lease.commentId, 200);
      assert.match(
        String(result.lease.comment?.body),
        new RegExp(`owner=${result.lease.owner}\\b`),
      );
    }
  } finally {
    if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = previousRunId;
    if (previousRunAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousRunAttempt;
    rmSync(root, { recursive: true, force: true });
  }
});

function acquireFixtureLease(root: string, racing: boolean) {
  const number = 74453;
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const statePath = join(root, "lease-state.json");
  const now = Date.now();
  const leaseBody = (owner: string, startedAt: number) =>
    `<!-- clawsweeper-review-status:started item=${number} sha=${headSha} started_at=${new Date(startedAt).toISOString()} lease_expires_at=${new Date(now + 3_600_000).toISOString()} owner=${owner} v=1 -->\n\n<!-- clawsweeper-review-lease item=${number} -->`;
  writeFileSync(
    statePath,
    JSON.stringify({
      comments: [
        { id: 10, user: { login: "contributor" }, body: leaseBody("spoof", now - 120_000) },
      ],
      contender: racing
        ? {
            id: 100,
            user: { login: "clawsweeper[bot]" },
            body: leaseBody("confirmed-worker", now - 60_000),
          }
        : null,
      payloads: [],
    }),
  );
  const script = `
const { readFileSync, writeFileSync } = require("node:fs");
const file = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const method = args[args.indexOf("--method") + 1];
if (args.includes("--input")) {
  const payload = args[args.indexOf("--input") + 1];
  state.payloads.push(payload);
  const comment = { id: 200, user: { login: "clawsweeper[bot]" }, body: JSON.parse(readFileSync(payload, "utf8")).body };
  if (state.contender) comment.body = comment.body.replace(/started_at=[^ ]+/, ${JSON.stringify(`started_at=${new Date(now - 120_000).toISOString()}`)});
  state.comments.push(comment);
  if (state.contender) state.comments.push(state.contender);
  console.log(JSON.stringify(comment));
} else if (method === "DELETE") {
  state.comments = state.comments.filter(comment => comment.id !== 200);
  console.log("");
} else {
  console.log(JSON.stringify([state.comments]));
}
writeFileSync(file, JSON.stringify(state));
`;
  try {
    let result: ReviewStartStatusCommentResult | undefined;
    withGitHubRun(() =>
      withMockGh(root, script, () => {
        result = postReviewStartStatusComment({
          item: { ...item({ number }), kind: "pull_request" },
          headSha,
          reviewTimeoutMs: 60_000,
          position: 1,
          total: 1,
          shardIndex: 0,
          shardCount: 1,
        });
      }),
    );
    assert.ok(result);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (racing)
      assert.deepEqual(
        state.comments.map((comment: { id: number }) => comment.id),
        [10, 100],
      );
    return result;
  } finally {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    for (const payload of state.payloads) {
      rmSync(payload, { force: true });
      rmSync(payload.replace(/\.json$/, ".md"), { force: true });
    }
  }
}

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

test("review comment patching only targets ClawSweeper-owned comments", () => {
  assert.equal(canPatchReviewComment({ user: { login: "clawsweeper" } }), true);
  assert.equal(canPatchReviewComment({ user: { login: "clawsweeper[bot]" } }), true);
  assert.equal(canPatchReviewComment({ user: { login: "openclaw-clawsweeper[bot]" } }), true);
  assert.equal(canPatchReviewComment({ user: { login: "steipete" } }), false);
  assert.equal(canPatchReviewComment(undefined), false);
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

test("concurrent lease acquisition preserves the lowest server id despite client timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-lease-race-"));
  try {
    const result = acquireFixtureLease(root, true);
    assert.equal(result.status, "held");
    assert.equal(result.didMutate, true);
    assert.equal(result.lease, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review item source revision ignores advisory labels but tracks protected labels", () => {
  const item = {
    title: "Close duplicate PR",
    body: "This was superseded by the canonical fix.",
    labels: [{ name: "bug" }],
  };
  const revision = itemSourceRevisionSha256(item, []);

  assert.equal(
    itemSourceRevisionSha256(
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
          { name: "clawsweeper:automerge" },
          { name: "clawsweeper:autofix" },
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
    itemSourceRevisionSha256({ ...item, labels: [...item.labels, { name: "needs-design" }] }, []),
    revision,
  );
  assert.notEqual(
    itemSourceRevisionSha256(
      { ...item, labels: [...item.labels, { name: "release-blocker" }] },
      [],
    ),
    revision,
  );
  const bulkFiled = { ...item, labels: [...item.labels, { name: "clawsweeper:bulk-filed" }] };
  assert.notEqual(itemSourceRevisionSha256(bulkFiled, []), revision);
  assert.equal(itemSourceRevisionSha256(bulkFiled, []), issueSourceRevisionSha256(bulkFiled, []));
  assert.notEqual(
    itemSourceRevisionSha256(
      { ...item, labels: [...item.labels, { name: "proof: override" }] },
      [],
    ),
    revision,
  );
});

test("pull request keep-open review comments label the change summary", () => {
  const comment = renderReviewCommentFromReport(
    typedRendererReport(
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

## PR Rating

Overall tier: A

Proof tier: A

Patch tier: A

Summary: The focused test change is ready for maintainer review.

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
      {
        summary: "Keep this test-only PR open for maintainer review.",
        changeSummary: "Adds regression coverage for session-scoped model overrides.",
        systemContext:
          "OpenClaw resolves a session's model override before sending the next agent request.",
        architectureDiagram:
          'flowchart LR\n    session["Session settings"] --> resolver["Model resolver"]\n    resolver --> request["Agent request"]',
        realBehaviorProof: {
          status: "sufficient",
          evidenceKind: "terminal",
          needsContributorAction: false,
          summary: "A live session confirmed the override reaches the next request.",
        },
        prRating: {
          proofTier: "A",
          patchTier: "A",
          overallTier: "A",
          summary: "The focused test change is ready for maintainer review.",
          nextSteps: [],
        },
        bestSolution: "Merge after required checks are green.",
        reproductionAssessment:
          "Not applicable. This is a test-only PR and the validation path is the targeted test lane.",
        solutionAssessment:
          "Yes. Landing the focused regression test after the targeted lane is green is the narrowest useful path.",
        evidence: [
          {
            repo: null,
            label: "targeted lane",
            detail: "The PR is test-only and should run the matching changed-test lane.",
            file: null,
            line: null,
            sha: null,
            command: null,
          },
        ],
      },
    ),
    "none",
  );

  // The verdict leads; the review time closes the visible comment, after the details.
  assert.match(
    comment,
    /^Codex review: needs maintainer review before merge\.\n\n## What this changes\n/,
  );
  assert.doesNotMatch(comment, /^# ClawSweeper review$/m);
  const reviewedAt = comment.indexOf("_Reviewed May 22, 2026, 12:43 AM ET / 04:43 UTC._");
  assert.ok(reviewedAt > comment.lastIndexOf("</details>"), comment);
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
  assert.doesNotMatch(comment, /## Verification/);
  assert.match(comment, /\| \*\*Proof confidence\*\* \| [^|]+ \| Sufficient \(terminal\):/);
  assert.match(detailsBody(comment, "Agent review details"), /- \*\*targeted lane:\*\*/);
  assert.match(
    detailsBody(comment, "Agent review details"),
    /### How this fits together\n\nOpenClaw resolves a session's model override before sending the next agent request\.\n\n```mermaid\nflowchart LR/,
  );
  assert.doesNotMatch(comment, /^## How this fits together/m);
  assert.doesNotMatch(comment, /## Proof/);
  assert.match(comment, /\*\*Reviewed head:\*\* `abc123def456abc123def456abc123def456abcd`/);
  assert.doesNotMatch(comment, /\*\*Workflow note:\*\*/);
  assert.match(
    comment,
    /### Workflow\n\nClawSweeper edits this one comment on every review\. Comment `@clawsweeper re-review` for a fresh review only\. Repair and merge execution lanes are retired\./,
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

test("ready zero-finding PR comments show verdict, product, readiness, findings and scores before details", () => {
  const proof =
    "A terminal transcript from a real gateway shows the Telegram reply keeps its final attachment.";
  const report = typedRendererReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74270",
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      work_candidate: "none",
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
      reviewed_at: "2026-05-22T04:43:12.000Z",
      labels: JSON.stringify(["P2"]),
    })}

## Summary

The fix is narrow and proven on a real gateway.

## What This Changes

Telegram replies with several attachments now send every attachment.

## Change Example

Scenario: An agent replies in Telegram with three attachments

Before: Telegram shows only the first two attachments.

After: Telegram shows all three attachments.

## System Context

The Telegram channel batches outbound attachments before the gateway sends the reply.

## Architecture Diagram

flowchart LR
    agent["Agent reply"] --> telegram["Telegram sendMediaGroup"]

${realBehaviorProofReportSection({ summary: proof })}
${prRatingReportSection({ nextSteps: "- Add a channel e2e scenario for three-attachment replies." })}
## Product Review

Kind: bug_fix

Worth it: yes

Fix scope: complete

User problem: Telegram users lose the last attachment of a multi-file reply.

Reason: Restores the documented media-group behavior with a narrow change.

## Provenance

- Area: src/telegram/media-group.ts
  - Introduced by: https://github.com/openclaw/openclaw/pull/70001
  - Original reason: Batch attachments to stay under the Telegram rate limit.
  - Verdict: respects

## Testing Review

Proof path: shipped_entry_point

Missing E2E:

Low-value tests:

- none

## Best Possible Solution

Merge after required checks are green.

## Evidence

- **real behavior proof:** ${proof}
- **diff:** The batcher flushes the pending attachment before sending.

## Security Review

Status: cleared

Summary: The change only reorders attachment flushing.

Concerns:

- none

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
    {
      summary: "The fix is narrow and proven on a real gateway.",
      changeSummary: "Telegram replies with several attachments now send every attachment.",
      changeExample: {
        scenario: "An agent replies in Telegram with three attachments",
        before: "Telegram shows only the first two attachments.",
        after: "Telegram shows all three attachments.",
      },
      systemContext:
        "The Telegram channel batches outbound attachments before the gateway sends the reply.",
      architectureDiagram:
        'flowchart LR\n    agent["Agent reply"] --> telegram["Telegram sendMediaGroup"]',
      realBehaviorProof: {
        status: "sufficient",
        evidenceKind: "terminal",
        needsContributorAction: false,
        summary: proof,
      },
      prRating: {
        proofTier: "B",
        patchTier: "B",
        overallTier: "B",
        summary: "Ready for review.",
        nextSteps: ["Add a channel e2e scenario for three-attachment replies."],
      },
      productReview: {
        kind: "bug_fix",
        worthIt: "yes",
        fixScope: "complete",
        userProblem: "Telegram users lose the last attachment of a multi-file reply.",
        reason: "Restores the documented media-group behavior with a narrow change.",
      },
      provenance: [
        {
          area: "src/telegram/media-group.ts",
          introducedBy: "https://github.com/openclaw/openclaw/pull/70001",
          originalReason: "Batch attachments to stay under the Telegram rate limit.",
          verdict: "respects",
        },
      ],
      testingReview: { proofPath: "shipped_entry_point", missingE2e: "", lowValueTests: [] },
      securityReview: {
        status: "cleared",
        summary: "The change only reorders attachment flushing.",
        concerns: [],
      },
      bestSolution: "Merge after required checks are green.",
      evidence: [
        {
          repo: null,
          label: "real behavior proof",
          detail: proof,
          file: null,
          line: null,
          sha: null,
          command: null,
        },
        {
          repo: null,
          label: "diff",
          detail: "The batcher flushes the pending attachment before sending.",
          file: null,
          line: null,
          sha: null,
          command: null,
        },
      ],
    },
  );
  const comment = renderReviewCommentFromReport(report, "none", {
    prStatusKind: "ready_for_maintainer_look",
  });

  const visible = comment.slice(0, comment.indexOf("\n<details>"));
  assert.match(visible, /^Codex review: needs maintainer review before merge\./);
  assert.deepEqual(
    [...visible.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    [
      "What this changes",
      "Review scores",
      "Product",
      "Merge readiness",
      "Before merge",
      "Findings",
    ],
  );
  assert.equal(comment.match(/^<details>$/gm)?.length, 1);
  assert.match(
    comment.slice(visible.length),
    /^\n<details>\n<summary><strong>Agent review details<\/strong><\/summary>/,
  );
  assert.match(
    visible,
    /## Product\n\n\*\*Kind:\*\* Bug fix · \*\*Worth it:\*\* Yes · \*\*Fix scope:\*\* Complete\n\*\*User problem:\*\* Telegram users lose the last attachment of a multi-file reply\.\n\*\*Reason:\*\* Restores the documented media-group behavior with a narrow change\./,
  );
  assert.match(
    visible,
    /## What this changes\n\nTelegram replies with several attachments now send every attachment\.\n\n\*\*Example:\*\* An agent replies in Telegram with three attachments\n- \*\*Before:\*\* Telegram shows only the first two attachments\.\n- \*\*After:\*\* Telegram shows all three attachments\.\n\n## Review scores/,
  );
  assert.match(visible, /## Before merge\n\nNone\.\n\n## Findings\n\nNone\.\n/);
  assert.equal(comment.split(proof).length - 1, 1);
  assert.match(visible, /\| \*\*Proof confidence\*\* \| [^|]+ \| Sufficient \(terminal\): /);

  // An evidence entry that repeats the proof but carries its supporting link stays.
  const linked = renderReviewCommentFromReport(
    typedRendererReport(report.replace(/^review_record:.*\n/m, ""), {
      ...readReviewRecord(report)!.decision,
      evidence: [
        ...readReviewRecord(report)!.decision.evidence,
        {
          repo: null,
          label: "proof run",
          detail: `${proof} https://example.com/runs/1`,
          file: null,
          line: null,
          sha: null,
          command: null,
        },
      ],
    }),
    "none",
    { prStatusKind: "ready_for_maintainer_look" },
  );
  assert.match(linked, /https:\/\/example\.com\/runs\/1/);
});

test("review comments include the UTC date when ET and UTC calendar dates differ", () => {
  const comment = renderReviewCommentFromReport(
    typedRendererReport(`${reportFrontMatter({
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
`),
    "none",
  );

  assert.match(comment, /_Reviewed July 8, 2026, 11:00 PM ET \/ July 9, 2026, 03:00 UTC\._/);
});

test("issue keep-open review comments surface reproducibility in the summary", () => {
  const comment = renderReviewCommentFromReport(
    typedRendererReport(
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
      {
        summary:
          "Keep open. Slack typing callbacks are disabled in message-tool-only group replies.",
        reproductionAssessment:
          "Yes. A source-level reproduction is clear: set a Slack group turn to message-tool-only and inspect the dispatch typing callbacks.",
        workCandidate: "queue_fix_pr",
        workConfidence: "high",
        workPriority: "medium",
        workReason: "The bug is narrow and source-reproducible.",
      },
    ),
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
  const rootCauseCluster: Decision["rootCauseCluster"] = {
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
    typedRendererReport(
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
      {
        rootCauseCluster,
        summary: "Keep open while maintainers evaluate the candidate fix.",
        bestSolution: "Review the linked candidate PR.",
      },
    ),
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
    typedRendererReport(
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
      { summary: "Keep open for more evidence." },
    ),
    "none",
  );

  assert.doesNotMatch(comment, /\*\*Root-cause cluster\*\*/);
  assert.doesNotMatch(comment, /Proposal only: this assessment/);
});

test("high-confidence root-cause clusters appear in close comments", () => {
  const comment = renderReviewCommentFromReport(
    implementedCloseReport(
      {},
      {
        rootCauseCluster: {
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
        },
      },
    ),
    "implemented_on_main",
  );

  assert.match(comment, /\*\*Root-cause cluster\*\*/);
  assert.match(comment, /Relationship: `duplicate`/);
  assert.match(comment, /Canonical: https:\/\/github\.com\/openclaw\/clawsweeper\/issues\/400/);
});

const verifiedPredecessor = {
  repo: "openclaw/clawsweeper",
  pullRequestNumber: 936,
  pullRequestUrl: "https://github.com/openclaw/clawsweeper/pull/936",
  mergeCommitSha: "a".repeat(40),
  sourcePath: "src/clawsweeper-review-runtime.ts",
  sourceLine: 42,
  evidenceType: "blame_to_merge_commit",
  verificationSource: "raw_parent_line_v1",
  mergedAt: "2026-07-31T12:00:00Z",
  reviewedCommitSha: "b".repeat(40),
  sourceCommitSha: "a".repeat(40),
  sourceAuthor: "Source Author",
} satisfies NonNullable<Decision["regressionProvenance"]>;

const suspectedPredecessor = {
  sourcePath: "src/clawsweeper-review-runtime.ts",
  sourceLine: 42,
  sourceCommitSha: "c".repeat(40),
  sourceAuthor: "Source Author",
  evidenceType: "source_line",
  verificationSource: "raw_parent_line_v1",
  relatedPullRequestNumber: null,
  relatedPullRequestUrl: null,
  relatedRepo: null,
} satisfies NonNullable<Decision["regressionProvenance"]>;

test("verified regression provenance renders the predecessor PR without local source details", () => {
  for (const decision of ["close", "keep_open"] as const) {
    const report = implementedCloseReport(
      {},
      {
        decision,
        closeReason: decision === "close" ? "implemented_on_main" : "none",
        regressionProvenance: verifiedPredecessor,
      },
    );
    const comment = renderReviewCommentFromReport(
      report,
      decision === "close" ? "implemented_on_main" : "none",
    );
    assert.match(comment, /source commit `aaaaaaaaaaaa` by Source Author/);
    assert.match(
      comment,
      /canonical PR \[#936\]\(https:\/\/github\.com\/openclaw\/clawsweeper\/pull\/936\)/,
    );
    assert.match(comment, /\(blame-to-merge-commit\)/);
    assert.doesNotMatch(comment, /src\/clawsweeper-review-runtime\.ts/);
    assert.doesNotMatch(comment, new RegExp("a".repeat(40)));
    if (decision === "keep_open") assert.match(comment, /\*\*Regression provenance\*\*/);
  }
});

test("verified provenance renders equivalent normalized source commit text", () => {
  const report = implementedCloseReport(
    {},
    {
      regressionProvenance: { ...verifiedPredecessor, sourceCommitSha: ` ${"A".repeat(40)} ` },
    },
  );
  const comment = renderReviewCommentFromReport(report, "implemented_on_main");
  assert.match(comment, /source commit `aaaaaaaaaaaa`/);
  assert.match(comment, /canonical PR \[#936\]/);
});

test("legacy provenance fields cannot supply or override typed provenance", () => {
  for (const evidenceType of [
    "blame_to_merge_commit",
    "source_line",
    "rewrite_equivalent",
    "model_claim",
  ]) {
    const metadata = {
      regression_provenance_repo: "openclaw/clawsweeper",
      regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/1023",
      regression_provenance_pr_number: "1023",
      regression_provenance_merge_sha: "c".repeat(40),
      regression_provenance_source_path: "src/clawsweeper-review-runtime.ts",
      regression_provenance_source_line: "0",
      regression_provenance_evidence_type: evidenceType,
      regression_provenance_source_author: "Private Author <private@localhost>",
    };
    const absent = implementedCloseReport(metadata, {
      regressionProvenance: null,
      regressionAssessment: { confidence: "suspected", supportingEvidence: ["reviewed_change"] },
    });
    const comment = renderReviewCommentFromReport(absent, "implemented_on_main");
    assert.match(comment, /Possible regression — suspected/);
    assert.doesNotMatch(comment, /source commit|private@|pull\/1023/);
    const authoritative = implementedCloseReport(metadata, {
      regressionProvenance: verifiedPredecessor,
    });
    assert.match(
      renderReviewCommentFromReport(authoritative, "implemented_on_main"),
      /canonical PR \[#936\]/,
    );
    const raw = absent.replace(/^review_record:.*\n/m, "");
    assert.throws(
      () => renderReviewCommentFromReport(raw, "implemented_on_main"),
      /review_record: missing record/,
    );
  }
});

test("malformed typed provenance fails closed rather than falling back to legacy fields", () => {
  for (const regressionProvenance of [verifiedPredecessor, suspectedPredecessor]) {
    const report = implementedCloseReport(
      {},
      {
        regressionProvenance,
        regressionAssessment: { confidence: "suspected", supportingEvidence: ["reviewed_change"] },
      },
    );
    const invalidValues = [
      { sourceLine: 0 },
      { sourceAuthor: "safe\u202eevil" },
      { sourceAuthor: "Private Author <private@localhost>" },
      ...(regressionProvenance === verifiedPredecessor
        ? [{ sourceCommitSha: "c".repeat(40) }]
        : [
            {
              evidenceType: "rewrite_equivalent",
              relatedPullRequestNumber: 1023,
              relatedPullRequestUrl: "https://example.test/not-a-pr",
              relatedRepo: "openclaw/clawsweeper",
            },
          ]),
    ];
    for (const invalid of invalidValues) {
      const record = readReviewRecord(report)!;
      record.decision.regressionProvenance = {
        ...regressionProvenance,
        ...invalid,
      } as Decision["regressionProvenance"];
      const malformed = report.replace(
        /^review_record:.*$/m,
        () => `review_record: ${JSON.stringify({ version: 1, ...record })}`,
      );
      assert.throws(
        () => renderReviewCommentFromReport(malformed, "implemented_on_main"),
        /review_record:/,
      );
    }
  }
});

test("suspected and rewrite-equivalent provenance supplement regression assessment", () => {
  for (const evidenceType of ["source_line", "rewrite_equivalent"] as const) {
    const comment = renderReviewCommentFromReport(
      implementedCloseReport(
        {},
        {
          regressionAssessment: {
            confidence: "probable",
            supportingEvidence: ["reproduction", "reviewed_change"],
          },
          regressionProvenance: {
            ...suspectedPredecessor,
            evidenceType,
            ...(evidenceType === "rewrite_equivalent"
              ? {
                  relatedPullRequestNumber: 1023,
                  relatedPullRequestUrl: "https://github.com/openclaw/clawsweeper/pull/1023",
                  relatedRepo: "openclaw/clawsweeper",
                }
              : {}),
          },
        },
      ),
      "implemented_on_main",
    );
    assert.match(comment, /suspected predecessor, not a causality claim/);
    assert.match(comment, /source commit `cccccccccccc` by Source Author/);
    assert.match(comment, /Possible regression — probable \(reproduction; reviewed change\)\./);
    if (evidenceType === "rewrite_equivalent") {
      assert.match(comment, /safely related PR \[#1023\]/);
      assert.doesNotMatch(comment, /No predecessor PR is attributed/);
    } else {
      assert.match(comment, /no PR verified/);
    }
  }
});

test("provenance author names cannot trigger mentions and literal unknown remains visible", () => {
  for (const sourceAuthor of ["@openclaw/maintainers", "unknown"]) {
    const comment = renderReviewCommentFromReport(
      implementedCloseReport(
        {},
        {
          regressionAssessment: {
            confidence: "suspected",
            supportingEvidence: ["reviewed_change"],
          },
          regressionProvenance: { ...suspectedPredecessor, sourceAuthor },
        },
      ),
      "implemented_on_main",
    );
    if (sourceAuthor === "unknown") {
      assert.match(comment, /source commit `cccccccccccc` by unknown; no PR verified/);
    } else {
      assert.doesNotMatch(comment, /@openclaw\/maintainers/);
      assert.match(comment, /@\u200bopenclaw\/maintainers/);
    }
  }
});

test("regression assessments retain confidence and evidence without attributing a predecessor", () => {
  for (const regressionAssessment of [
    { confidence: "probable", supportingEvidence: ["reproduction", "reviewed_change"] },
    { confidence: "suspected", supportingEvidence: ["failure_trace"] },
  ] satisfies NonNullable<Decision["regressionAssessment"]>[]) {
    const comment = renderReviewCommentFromReport(
      implementedCloseReport(
        {
          regression_provenance_pr_url: "https://github.com/openclaw/clawsweeper/pull/936",
        },
        { regressionAssessment, regressionProvenance: null },
      ),
      "implemented_on_main",
    );
    assert.match(
      comment,
      regressionAssessment.confidence === "probable"
        ? /Possible regression — probable \(reproduction; reviewed change\)\. No predecessor PR is attributed\./
        : /Possible regression — suspected \(failure trace\)\. No predecessor PR is attributed\./,
    );
    assert.doesNotMatch(comment, /pull\/936|Verified regression provenance/);
  }
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
    /<!-- clawsweeper-verdict:close item=74270 sha=abc123def456abc123def456abc123def456abcd confidence=high updated_at=2026-05-01T00:00:00Z reviewed_at=[^ ]+ lease_owner=fixture lease_comment_id=1059 source_revision=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef action_taken=proposed_close reason=implemented_on_main -->/,
  );
  assert.match(
    comment,
    /<!-- clawsweeper-action:close-required item=74270 sha=abc123def456abc123def456abc123def456abcd confidence=high updated_at=2026-05-01T00:00:00Z reviewed_at=[^ ]+ lease_owner=fixture lease_comment_id=1059 source_revision=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef action_taken=proposed_close reason=implemented_on_main -->/,
  );
  assert.doesNotMatch(comment, /clawsweeper-verdict:needs-human/);
});

test("design issue reviews preserve the model's decision without inventing reproduction requests", () => {
  const comment = renderReviewCommentFromReport(
    typedRendererReport(
      `${reportFrontMatter({
        type: "issue",
        number: "1624",
        decision: "keep_open",
        close_reason: "none",
        work_candidate: "manual_review",
        reproduction_status: "not_applicable",
        reproduction_confidence: "high",
      })}

## Summary

The external artifact contract needs a maintainer design decision.

## Reproduction Assessment

Not applicable. This proposes a new integration contract and reports no broken existing behavior.

## Work Candidate

Candidate: manual_review

Reason: Decide whether to support the external artifact contract.
`,
      {
        summary: "The external artifact contract needs a maintainer design decision.",
        reproductionStatus: "not_applicable",
        reproductionConfidence: "high",
        reproductionAssessment:
          "Not applicable. This proposes a new integration contract and reports no broken existing behavior.",
        workCandidate: "manual_review",
        workReason: "Decide whether to support the external artifact contract.",
      },
    ),
    "none",
  );

  assert.match(comment, /The external artifact contract needs a maintainer design decision\./);
  assert.match(comment, /Not applicable\. This proposes a new integration contract/);
  assert.match(
    comment,
    /\*\*Next step\*\*\nDecide whether to support the external artifact contract\./,
  );
  assert.doesNotMatch(comment, /Ways to help us reproduce|screenshot|expected vs actual/);
});

test("issue reviews retain specific model-authored reproduction requests", () => {
  const comment = renderReviewCommentFromReport(
    typedRendererReport(
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

## Work Candidate

Candidate: manual_review

Reason: Provide the failing command and redacted error output.
`,
      {
        summary: "Keep open. The app sometimes does the wrong thing.",
        reproductionStatus: "unclear",
        reproductionConfidence: "low",
        reproductionAssessment:
          "Unclear. The report describes an intermittent visible failure but does not include enough information to reproduce it.",
        workCandidate: "manual_review",
        workReason: "Provide the failing command and redacted error output.",
      },
    ),
    "none",
  );

  assert.match(
    comment,
    /\*\*Next step\*\*\nProvide the failing command and redacted error output\./,
  );
  assert.match(comment, /does not include enough information to reproduce it/);
  assert.doesNotMatch(comment, /Ways to help us reproduce|screenshot|expected vs actual/);
});

test("pull request review comments include dedicated security review", () => {
  const comment = renderReviewCommentFromReport(
    typedRendererReport(
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
      {
        summary: "Keep this PR open for maintainer review.",
        changeSummary: "Updates a workflow permission for review comments.",
        bestSolution: "Land the workflow permission change after normal CI.",
        securityReview: {
          status: "needs_attention",
          summary:
            "The workflow now asks for issue write permission, so the permission scope needs maintainer confirmation.",
          concerns: [
            {
              title: "Confirm issue write scope",
              body: "The review shard now writes comments during review, so maintainers should confirm the app permission is intended.",
              severity: "medium",
              confidenceScore: 0.82,
              file: ".github/workflows/sweep.yml",
              line: 652,
            },
          ],
        },
        evidence: [
          {
            repo: null,
            label: "workflow",
            detail: "Review shard requests issue write permission.",
            file: null,
            line: null,
            sha: null,
            command: null,
          },
        ],
        likelyOwners: [
          {
            person: "@alice",
            role: "recent workflow maintainer",
            reason: "touched the workflow recently",
            commits: ["abc123"],
            files: [".github/workflows/sweep.yml"],
            confidence: "high",
          },
        ],
      },
    ),
    "none",
  );

  assert.match(
    comment,
    /## Findings\n\n- \[medium\] Confirm issue write scope — `\.github\/workflows\/sweep\.yml:652`/,
  );
  assert.match(comment, /### Security/);
  assert.match(comment, /Needs attention:/);
  assert.match(comment, /Confirm issue write scope/);
  assert.match(comment, /Agent review details/);
  assert.doesNotMatch(
    comment,
    /recent workflow maintainer|alice|routing candidate|touched the workflow recently/,
  );
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
    typedRendererReport(
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
      {
        summary: "This PR needs one correctness fix before merge.",
        changeSummary: "Adds a config patch command for scripted config edits.",
        bestSolution: "Reject misspelled replacement paths before writing the updated config.",
        overallCorrectness: "patch is incorrect",
        overallConfidenceScore: 0.86,
        reviewFindings: [
          {
            title: "Validate replace paths",
            body: "A misspelled replace path is currently ignored, so the command can report success while leaving the intended setting unchanged.",
            priority: 1,
            confidenceScore: 0.9,
            file: "src/config/apply.ts",
            lineStart: 42,
            lineEnd: 44,
          },
        ],
        workCandidate: "queue_fix_pr",
        workConfidence: "high",
        workPriority: "high",
        workReason: "The fix is narrow and can be made on the PR branch.",
      },
    ),
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
  assert.doesNotMatch(comment, /<!-- clawsweeper-action:fix-required/);
});

test("pull request keep-open review comments suppress duplicate best solution text", () => {
  const comment = renderReviewCommentFromReport(
    typedRendererReport(
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
      { bestSolution: "Land this docs-only PR after maintainer review.", workReason: "" },
    ),
    "none",
  );

  // Ordinary maintainer review is routine, so it collapses out of Before merge.
  assert.match(comment, /## Before merge\n\nNone\./);
  assert.doesNotMatch(comment, /\[P2\] Land this docs-only PR/);
  assert.doesNotMatch(comment, /Best possible solution:/);
});

test("pull request review comments do not priority-prefix routine no-op guidance", () => {
  const comment = renderReviewCommentFromReport(
    typedRendererReport(
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
      {
        workReason: "",
        bestSolution:
          "No ClawSweeper repair lane is needed; the submitted PR is narrow and the remaining action is normal maintainer review and CI.",
      },
    ),
    "none",
  );

  assert.match(comment, /## Before merge\n\nNone\./);
  assert.doesNotMatch(comment, /No ClawSweeper repair lane is needed/);
  assert.doesNotMatch(comment, /\[P2\] none/);
  assert.doesNotMatch(comment, /\[P2\] No ClawSweeper repair lane is needed/);
});

test("pull request automerge review comments can emit pass verdicts", () => {
  const comment = renderReviewCommentFromReport(
    typedRendererReport(
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
      { bestSolution: "Merge after required checks are green." },
    ),
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
  const markers = reviewAutomationMarkersFromReport(
    typedRendererReport(`${reportFrontMatter({
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
`),
  );

  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
});

test("forged evidence continuation lines in evidence prose cannot replace the entry's repository, file, commit, or command through the durable report", () => {
  const forgedSha = "e".repeat(40);
  const entry = {
    repo: "openclaw/openclaw",
    label: "Real evidence",
    detail: [
      "Real detail.",
      "  - repo: evil/repo",
      "  - file: `src/evil.ts:1`",
      `  - sha: ${forgedSha}`,
      "  - command: `pnpm evil`",
    ].join("\n"),
    file: null,
    line: null,
    command: null,
    sha: null,
  };
  const report = evidenceReport([entry], "keep_open");
  assert.doesNotMatch(report, /^\s+- sha: e{40}$/m);
  assert.match(report, /^\s+- sha&#58; e{40}$/m);
  const parsed = readReviewRecord(report)!.decision.evidence;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.repo, "openclaw/openclaw");
  assert.equal(parsed[0]!.file, null);
  assert.equal(parsed[0]!.sha, null);
  assert.equal(parsed[0]!.command, null);
  const comment = renderReviewCommentFromReport(report, "none");
  assert.equal(
    markdownLinkDestinations(comment).has(
      `https://github.com/openclaw/openclaw/commit/${forgedSha}`,
    ),
    false,
  );
  assert.doesNotMatch(comment, /src\/evil\.ts|pnpm evil|evil\/repo/);
});
