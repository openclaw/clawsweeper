import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDecision,
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
} from "../dist/clawsweeper.js";
import { normalizeRealBehaviorProof } from "../dist/clawsweeper-rating.js";
import {
  compatibilityField,
  compatibilityReport,
  generatedCompatibilityReport,
  neutralCompatibility,
} from "./compatibility-proof-fixture.ts";
import { closeDecision } from "./helpers.ts";

function assertHold(report: string, held: boolean) {
  const comment = renderReviewCommentFromReport(report, "none");
  assert.equal(comment.includes("Add data-model compatibility proof"), held);
  assert.equal(comment.includes("Migration or upgrade compatibility proof is recorded"), !held);
  assert.equal(
    reviewAutomationMarkersFromReport(report).includes("clawsweeper-verdict:pass"),
    !held,
  );
}

for (const compatibility of [undefined, "insufficient", "not_applicable", "invalid"]) {
  test(`affirmative prose cannot clear ${compatibility ?? "legacy missing"} compatibility`, () => {
    assertHold(compatibilityReport({ compatibility }), true);
  });
}

test("explicit sufficient assessment works without compatibility keywords", () => {
  assertHold(
    compatibilityReport({ compatibility: "sufficient", summary: neutralCompatibility }),
    false,
  );
});

for (const metadata of [
  { labels: '["clawsweeper:automerge","proof: override"]' },
  { author_association: "MEMBER" },
  { author_association: "NONE", author: "synthetic[bot]" },
  { pull_files: '["docs/example.md"]', pull_files_truncated: "false" },
]) {
  test(`general proof exemption cannot grant compatibility: ${JSON.stringify(metadata)}`, () => {
    const exempt = {
      ...metadata,
      real_behavior_proof_status: "missing",
      real_behavior_proof_needs_contributor_action: "true",
    };
    assertHold(compatibilityReport({ metadata: exempt }), true);
    assertHold(compatibilityReport({ compatibility: "insufficient", metadata: exempt }), true);
    assertHold(
      compatibilityReport({
        compatibility: "sufficient",
        summary: neutralCompatibility,
        metadata: exempt,
      }),
      false,
    );
  });
}

test("duplicate and body-only compatibility metadata cannot grant a pass", () => {
  const report = compatibilityReport({ compatibility: "sufficient" });
  const duplicate = report.replace(
    `\n${compatibilityField}: sufficient`,
    `\n${compatibilityField}: insufficient\n${compatibilityField}: sufficient`,
  );
  for (const input of [
    duplicate,
    compatibilityReport() + `\n${compatibilityField}: sufficient\n`,
    compatibilityReport() + `\n\`\`\`yaml\n---\n${compatibilityField}: sufficient\n---\n\`\`\`\n`,
  ]) {
    const comment = renderReviewCommentFromReport(input, "none");
    assert.doesNotMatch(comment, /Migration or upgrade compatibility proof is recorded/);
    assert.doesNotMatch(reviewAutomationMarkersFromReport(input), /clawsweeper-verdict:pass/);
  }
});

test("ordinary reports need no compatibility assessment when no data model changes", () => {
  const report = compatibilityReport({
    metadata: { data_model_change: "false", data_model_surfaces: "[]" },
  });
  assert.doesNotMatch(
    renderReviewCommentFromReport(report, "none"),
    /Add data-model compatibility proof/,
  );
  assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-verdict:pass/);
});

test("sufficient compatibility cannot clear unrelated findings", () => {
  const report = compatibilityReport({ compatibility: "sufficient" }).replace(
    "- none",
    "- **[P2] Separate defect:** `src/runtime.ts:1-1`\n  - body: A distinct actionable defect remains.\n  - confidence: 0.9",
  );
  assert.doesNotMatch(
    renderReviewCommentFromReport(report, "none"),
    /Add data-model compatibility proof/,
  );
  assert.doesNotMatch(reviewAutomationMarkersFromReport(report), /clawsweeper-verdict:pass/);
});

test("sufficient compatibility cannot clear required general proof", () => {
  const report = compatibilityReport({
    compatibility: "sufficient",
    metadata: {
      real_behavior_proof_status: "missing",
      real_behavior_proof_needs_contributor_action: "true",
    },
  });
  assert.doesNotMatch(
    renderReviewCommentFromReport(report, "none"),
    /Add data-model compatibility proof/,
  );
  assert.doesNotMatch(reviewAutomationMarkersFromReport(report), /clawsweeper-verdict:pass/);
});

test("decision parser and canonical report writer preserve the dedicated assessment", () => {
  for (const compatibility of ["sufficient", "insufficient", "not_applicable"] as const) {
    const report = generatedCompatibilityReport(compatibility);
    assert.match(report, new RegExp(`^${compatibilityField}: ${compatibility}$`, "m"));
    assert.match(report, /^data_model_change: true$/m);
    assertHold(report, compatibility !== "sufficient");
  }
  assert.throws(
    () =>
      parseDecision(
        closeDecision({
          realBehaviorProof: {
            status: "sufficient",
            summary: "Synthetic proof.",
            evidenceKind: "terminal",
            needsContributorAction: false,
            dataModelCompatibility: "unknown",
          },
        }),
      ),
    /dataModelCompatibility/,
  );
});

test("unrelated proof normalization retains compatibility without clearing its own blocker", () => {
  const proof = normalizeRealBehaviorProof({
    status: "sufficient",
    summary: "No CSP violation is visible in the screenshot.",
    evidenceKind: "screenshot",
    needsContributorAction: false,
    dataModelCompatibility: "sufficient",
  });
  assert.equal(proof.dataModelCompatibility, "sufficient");
  assert.equal(proof.status, "insufficient");
  assert.equal(proof.needsContributorAction, true);
});
