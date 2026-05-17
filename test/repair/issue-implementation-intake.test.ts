import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  attachedPrText,
  issueReferenceTextMatches,
  parseReviewReport,
  reportOnlyDecision,
} from "../../dist/repair/issue-implementation-intake.js";
import {
  renderIssueImplementationJob,
  REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
} from "../../dist/repair/comment-router-core.js";

function report(overrides = {}) {
  const fields = {
    number: "123",
    repository: "openclaw/openclaw",
    type: "issue",
    state_at_review: "open",
    review_status: "complete",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    work_candidate: "queue_fix_pr",
    work_confidence: "high",
    work_validation: JSON.stringify(["pnpm test src/example.test.ts"]),
    work_likely_files: JSON.stringify(["src/example.ts", "src/example.test.ts"]),
    work_cluster_refs: JSON.stringify(["#123"]),
    labels: JSON.stringify(["bug"]),
    item_category: "bug",
    reproduction_status: "reproduced",
    reproduction_confidence: "high",
    requires_new_feature: "false",
    requires_new_config_option: "false",
    requires_product_decision: "false",
    security_review_status: "not_applicable",
    ...overrides,
  };
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n## Repair Work Prompt\n\nFix the reproduced existing-behavior bug and add a regression test.\n`;
}

test("strict reproducible bug reports are eligible for implementation intake", () => {
  const markdown = report();
  const parsed = parseReviewReport(markdown);
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parsed,
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("security review verdict 'cleared' is eligible for issue implementation intake", () => {
  const markdown = report({ security_review_status: "cleared" });
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("security review verdict 'not_applicable' is eligible for issue implementation intake", () => {
  const markdown = report({ security_review_status: "not_applicable" });
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, true);
});

test("security review verdict 'needs_attention' blocks issue implementation intake", () => {
  const markdown = report({ security_review_status: "needs_attention" });
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, false);
  assert.match(decision.blockers.join("\n"), /security review verdict is needs_attention/);
});

test("missing security review verdict fails closed", () => {
  // Simulate a legacy report that pre-dates the renderer change: every
  // frontmatter field except `security_review_status` is present.
  const markdown = report().replace(/\nsecurity_review_status: [^\n]*\n/, "\n");
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, false);
  assert.match(decision.blockers.join("\n"), /missing security review verdict/);
});

test("narrative prose mentioning 'security' no longer blocks intake", () => {
  // Regression: pre-verdict-gate, the reviewer's boilerplate sentence
  // 'Non-PR issue; no diff to review for security concerns.' false-positive
  // the regex scan. The verdict gate trusts the schema-validated status.
  const markdown = `${report()}\n## Security Review\n\nStatus: not_applicable\n\nSummary: Non-PR issue; no diff to review for security concerns.\n\nConcerns:\n\n- none\n`;
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, true);
});

test("strict docs reports are eligible for implementation intake", () => {
  const markdown = report({
    item_category: "docs",
    labels: JSON.stringify(["area:docs"]),
    work_validation: JSON.stringify(["pnpm --filter @multica/docs typecheck"]),
    work_likely_files: JSON.stringify(["apps/docs/content/docs/example.zh.mdx"]),
  });
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("strict regression reports are eligible for implementation intake", () => {
  const markdown = report({
    repository: "valkyriweb/pi-mono",
    item_category: "regression",
    labels: JSON.stringify(["area:ci"]),
    work_validation: JSON.stringify(["pnpm -F @pi-mono/ai check"]),
    work_likely_files: JSON.stringify(["packages/ai/src/models.generated.ts"]),
  });
  const decision = reportOnlyDecision({
    targetRepo: "valkyriweb/pi-mono",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("implementation intake issue reference matching ignores unrelated version numbers", () => {
  assert.equal(
    issueReferenceTextMatches(
      "bermont-digital/multica",
      11,
      "Bumps mermaid from 11.14.0 to 11.15.0. <summary>Changelog</summary>",
    ),
    false,
  );
  assert.equal(issueReferenceTextMatches("bermont-digital/multica", 11, "Fixes #11"), true);
  assert.equal(
    issueReferenceTextMatches(
      "bermont-digital/multica",
      11,
      "Fixes https://github.com/bermont-digital/multica/issues/11",
    ),
    true,
  );
});

test("implementation intake rejects feature and config-option work", () => {
  for (const overrides of [
    { item_category: "feature" },
    { requires_new_feature: "true" },
    { requires_new_config_option: "true" },
    { requires_product_decision: "true" },
    { reproduction_status: "source_reproducible" },
  ]) {
    const markdown = report(overrides);
    const decision = reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
    });

    assert.equal(decision.shouldRepair, false);
  }
});

test("review-triggered issue implementation jobs require autogenerated PR labels", () => {
  const job = renderIssueImplementationJob({
    repo: "openclaw/openclaw",
    issueNumber: 123,
    title: "Crash on existing command",
    triggerSource: REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
    reviewReportPath: "records/openclaw-openclaw/items/123.md",
    strictBugOnly: true,
  });

  assert.match(job, /trigger_source: review_reproducible_bug/);
  assert.match(job, /required_pr_labels:\n  - clawsweeper:autogenerated/);
  assert.match(job, /Treat it as bug-only/);
  assert.match(job, /new config\s+option/);
});

test("issue implementation PR executor applies autogenerated label", () => {
  const source = readFileSync("src/repair/execute-fix-artifact.ts", "utf8");

  assert.match(source, /AUTOGENERATED_LABEL/);
  assert.match(source, /job\.frontmatter\.source === "issue_implementation"/);
});

test("repair executor uses retryable blobless target checkout", () => {
  const source = readFileSync("src/repair/execute-fix-artifact.ts", "utf8");

  assert.match(source, /cloneTargetCheckout/);
  assert.match(source, /--filter=blob:none/);
  assert.match(source, /CLAWSWEEPER_CHECKOUT_CLONE_ATTEMPTS/);
  assert.match(source, /CLAWSWEEPER_CHECKOUT_CLONE_TIMEOUT_MS/);
});

test("comment router default allows one same-head infrastructure retry", () => {
  const source = readFileSync("src/repair/config.ts", "utf8");

  assert.match(source, /CLAWSWEEPER_MAX_REPAIRS_PER_HEAD \?\? 2/);
});

test("eligibility matches report repository against target repo case-insensitively", () => {
  // Reviewer/renderer lowercases the `repository` frontmatter field, but the
  // workflow input typically keeps GitHub's canonical mixed-case slug.
  const markdown = report({ repository: "clip-sa/core-ai", number: "29" });
  const decision = reportOnlyDecision({
    targetRepo: "CLIP-SA/core-ai",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("attachedPrText ignores bot-authored comments", () => {
  // The reviewer's own evidence narrative routinely cites past PRs as
  // historical context. Those mentions live in `*-clawsweeper[bot]`
  // comments and must not self-disqualify the issue at intake time.
  const live = {
    issue: { body: "No PR yet, just an issue body." },
    comments: [
      {
        user: { login: "valkyriweb-clawsweeper[bot]" },
        body: "Codex review: PR #14 introduced the hardcode; see /pull/19 for context.",
      },
    ],
  };

  assert.equal(attachedPrText(live), false);
});

test("attachedPrText still flags human PR references", () => {
  const live = {
    issue: { body: "See PR #42 for the workaround." },
    comments: [],
  };

  assert.equal(attachedPrText(live), true);
});

test("attachedPrText flags human comment PR mentions", () => {
  const live = {
    issue: { body: "" },
    comments: [
      {
        user: { login: "valkyriweb" },
        body: "This is being fixed in /pull/77.",
      },
    ],
  };

  assert.equal(attachedPrText(live), true);
});
