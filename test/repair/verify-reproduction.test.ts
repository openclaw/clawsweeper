import assert from "node:assert/strict";
import test from "node:test";

import { applyReproductionPatch, detectEnvFailure } from "../../dist/repair/verify-reproduction.js";
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

test("detectEnvFailure flags Postgres Connection refused on port 5432", () => {
  // Real captured output from the CLIP-SA/core-ai #29 demo run (2026-05-17)
  // where verify-reproduction incorrectly promoted the item to `reproduced`
  // because the runner had no Postgres up. This is the regression case.
  const output = `QueryException SQLSTATE[08006] [7] connection to server at "127.0.0.1", port 5432 failed: Connection refused
Is the server running on that host and accepting TCP/IP connections?
Tests: 10 failed (0 assertions) Duration: 0.37s`;

  const result = detectEnvFailure(output);

  assert.ok(result, "expected env-failure detection on Postgres connection refused");
  assert.equal(result?.reason, "database_unreachable");
  assert.match(result?.evidence ?? "", /SQLSTATE\[08006\]|Connection refused.*5432/);
});

test("detectEnvFailure flags Redis ECONNREFUSED on port 6379", () => {
  const output = `Error: connect ECONNREFUSED 127.0.0.1:6379
    at TCPConnectWrap.afterConnect [as oncomplete]`;

  const result = detectEnvFailure(output);

  assert.equal(result?.reason, "database_unreachable");
});

test("detectEnvFailure flags missing Laravel artisan", () => {
  const output = "Could not open input file: artisan";

  const result = detectEnvFailure(output);

  assert.equal(result?.reason, "app_not_initialized");
});

test("detectEnvFailure flags Composer autoload misses", () => {
  const output = `PHP Fatal error: Uncaught Error: Class "App\\Services\\ProductSearchService" not found in /app/tests/Feature/McpServerTest.php`;

  const result = detectEnvFailure(output);

  assert.equal(result?.reason, "autoload_missing");
});

test("detectEnvFailure flags Node missing-module errors", () => {
  const output = `Error: Cannot find module '@scope/pkg'
    Require stack:
    - /workspace/src/index.js`;

  const result = detectEnvFailure(output);

  assert.equal(result?.reason, "node_deps_missing");
});

test("detectEnvFailure flags missing vendor/bin tooling", () => {
  const output = "sh: No such file or directory: vendor/bin/pest";

  const result = detectEnvFailure(output);

  assert.equal(result?.reason, "tooling_missing");
});

test("detectEnvFailure returns null for genuine test failures", () => {
  // The validation command actually exercised the bug — assertions failed,
  // tests ran, no infrastructure missing. This is the case where the lane
  // SHOULD promote to `reproduced: true`.
  const output = `FAIL  Tests\\Feature\\ProductSearchToolTest > it returns formatted product results
Expected: ["Wine Glass 350ml"]
Received: []
Tests: 1 failed, 9 passed (24 assertions)
Duration: 1.21s`;

  assert.equal(detectEnvFailure(output), null);
});

test("detectEnvFailure does not flag ECONNREFUSED on non-database ports", () => {
  // A real test that exercises an app endpoint and gets a legitimate
  // connection refused on, say, port 8080 (the app under test) is a real
  // failure, not an env failure. The regex is pinned to known DB/cache
  // ports specifically to avoid this misclassification.
  const output = `Error: connect ECONNREFUSED 127.0.0.1:8080`;

  assert.equal(detectEnvFailure(output), null);
});
