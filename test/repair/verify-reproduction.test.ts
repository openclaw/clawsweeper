import assert from "node:assert/strict";
import test from "node:test";

import { applyReproductionPatch } from "../../dist/repair/verify-reproduction.js";
import {
  parseReviewReport,
  reportOnlyDecision,
} from "../../dist/repair/issue-implementation-intake.js";

function report(overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    number: "13",
    repository: "valkyriweb/pi-mono",
    type: "issue",
    state_at_review: "open",
    review_status: "complete",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    work_candidate: "queue_fix_pr",
    work_confidence: "high",
    work_validation: JSON.stringify(["pnpm -F @pi-mono/ai check"]),
    work_likely_files: JSON.stringify(["packages/ai/src/models.generated.ts"]),
    work_cluster_refs: JSON.stringify(["#13"]),
    labels: JSON.stringify(["area:ci"]),
    item_category: "regression",
    reproduction_status: "source_reproducible",
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

test("verifiable lane accepts source_reproducible reports that are otherwise strict", () => {
  const markdown = report();
  const decision = reportOnlyDecision({
    targetRepo: "valkyriweb/pi-mono",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    lane: "verifiable",
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_verification");
});

test("verifiable lane rejects reports that already reproduce on main", () => {
  const markdown = report({ reproduction_status: "reproduced" });
  const decision = reportOnlyDecision({
    targetRepo: "valkyriweb/pi-mono",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    lane: "verifiable",
  });

  assert.equal(decision.shouldRepair, false);
  assert.match(decision.blockers.join("\n"), /reproduction status is reproduced/);
});

test("default reproduced lane still rejects source_reproducible reports", () => {
  const markdown = report();
  const decision = reportOnlyDecision({
    targetRepo: "valkyriweb/pi-mono",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, false);
  assert.match(decision.blockers.join("\n"), /reproduction status is source_reproducible/);
});

test("verifiable lane still enforces other intake invariants", () => {
  for (const overrides of [
    { item_category: "feature" },
    { requires_new_feature: "true" },
    { reproduction_confidence: "medium" },
    { work_candidate: "manual_review" },
  ]) {
    const markdown = report(overrides);
    const decision = reportOnlyDecision({
      targetRepo: "valkyriweb/pi-mono",
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
      lane: "verifiable",
    });

    assert.equal(decision.shouldRepair, false, `expected blocker for ${JSON.stringify(overrides)}`);
  }
});

test("applyReproductionPatch flips frontmatter and appends provenance", () => {
  const original = report();
  const verifiedAt = "2026-05-17T01:23:45.000Z";
  const patched = applyReproductionPatch(original, {
    verifiedAt,
    evidence: "validation command failed (pnpm -F @pi-mono/ai check): TS2345 grok-3 not assignable",
  });
  const parsed = parseReviewReport(patched);

  assert.equal(parsed.frontmatter.reproduction_status, "reproduced");
  assert.equal(parsed.frontmatter.reproduction_verified_at, verifiedAt);
  assert.match(
    parsed.frontmatter.reproduction_verified_evidence ?? "",
    /validation command failed.*pnpm -F @pi-mono\/ai check/,
  );
  // Body preserved.
  assert.match(patched, /## Repair Work Prompt/);
});

test("applyReproductionPatch collapses multi-line evidence to a single line", () => {
  const verifiedAt = "2026-05-17T01:23:45.000Z";
  const evidence = "first line\nsecond line\n\nthird line with trailing space   ";
  const patched = applyReproductionPatch(report(), { verifiedAt, evidence });
  const parsed = parseReviewReport(patched);

  assert.equal(
    parsed.frontmatter.reproduction_verified_evidence,
    "first line second line third line with trailing space",
  );
});

test("applyReproductionPatch leaves markdown without frontmatter untouched", () => {
  const plain = "No frontmatter here.\n";
  const patched = applyReproductionPatch(plain, {
    verifiedAt: "2026-05-17T01:23:45.000Z",
    evidence: "n/a",
  });
  assert.equal(patched, plain);
});
