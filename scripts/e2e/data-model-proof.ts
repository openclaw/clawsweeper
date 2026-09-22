#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
} from "../../dist/clawsweeper.js";
import {
  compatibilityField,
  compatibilityReport,
  generatedCompatibilityReport,
  neutralCompatibility,
} from "../../test/compatibility-proof-fixture.ts";

const baseline = process.argv.includes("--baseline");
assert.ok(process.argv.slice(2).every((arg) => arg === "--baseline"));
const directory = join(
  ".artifacts",
  "typed-compatibility-proof",
  baseline ? "baseline" : "candidate",
);
mkdirSync(directory, { recursive: true });
const receipts: unknown[] = [];
function observe(name: string, report: string, accepted: boolean) {
  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);
  const result = {
    compatibilityBlocker: comment.includes("Add data-model compatibility proof"),
    compatibilityRecorded: comment.includes("Migration or upgrade compatibility proof is recorded"),
    pass: markers.includes("clawsweeper-verdict:pass"),
  };
  assert.deepEqual(
    result,
    { compatibilityBlocker: !accepted, compatibilityRecorded: accepted, pass: accepted },
    name,
  );
  writeFileSync(join(directory, `${name}.report.md`), report);
  writeFileSync(join(directory, `${name}.comment.md`), comment);
  receipts.push({ name, ...result });
}
observe(
  "sufficient-neutral-prose",
  compatibilityReport({ compatibility: "sufficient", summary: neutralCompatibility }),
  !baseline,
);
observe(
  "insufficient-affirmative-prose",
  compatibilityReport({ compatibility: "insufficient" }),
  baseline,
);
observe("legacy-affirmative-prose", compatibilityReport(), baseline);
if (!baseline) {
  for (const compatibility of ["sufficient", "insufficient", "not_applicable"] as const) {
    const report = generatedCompatibilityReport(compatibility);
    assert.match(report, new RegExp(`^${compatibilityField}: ${compatibility}$`, "m"));
    assert.match(report, /^data_model_change: true$/m);
    observe(`producer-roundtrip-${compatibility}`, report, compatibility === "sufficient");
  }
  for (const [name, metadata] of [
    ["override", { labels: '["clawsweeper:automerge","proof: override"]' }],
    ["maintainer", { author_association: "MEMBER" }],
    ["docs-only", { pull_files: '["docs/example.md"]', pull_files_truncated: "false" }],
  ] as const) {
    for (const compatibility of [undefined, "insufficient", "sufficient"]) {
      observe(
        `${name}-${compatibility ?? "missing"}`,
        compatibilityReport({
          compatibility,
          summary: neutralCompatibility,
          metadata: {
            ...metadata,
            real_behavior_proof_status: "missing",
            real_behavior_proof_needs_contributor_action: "true",
          },
        }),
        compatibility === "sufficient",
      );
    }
  }
}
const receipt = {
  mode: baseline ? "baseline" : "candidate",
  node: process.version,
  owners: Object.fromEntries(
    [
      "clawsweeper-orchestration-foundation",
      "clawsweeper-report-parser",
      "clawsweeper-decision-parser",
      "clawsweeper-report-document",
    ].map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(new URL(`../../dist/${name}.js`, import.meta.url)))
        .digest("hex"),
    ]),
  ),
  receipts,
  limits:
    "Compiled decision/report/renderer boundary with synthetic assessments and reports. No model judgment, live GitHub publication, canonical report rewrite, or actual database upgrade is exercised.",
};
writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));
