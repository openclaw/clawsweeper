import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compatibilityFixture,
  compatibilityReport,
  verifiedCompatibility,
} from "../../../test/compatibility-proof-fixture.ts";

const root = process.cwd();
const baseline = process.argv.includes("--baseline");
assert.ok(process.argv.slice(2).every((arg) => arg === "--baseline"));
const base = "8e008cbc0b4c9153f46a1b90167b215dea9ccdad";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const artifactRoot = resolve(root, ".artifacts/compatibility-proof");
mkdirSync(artifactRoot, { recursive: true });
const artifact = mkdtempSync(join(artifactRoot, baseline ? "base-" : "candidate-"));
// Use the built production module graph unchanged. For the baseline only,
// substitute the pinned historical owner (TypeScript stripping, not a mock).
// The surrounding rendering code is the same on this branch and its base.
const graph = join(artifact, "dist");
cpSync(join(root, "dist"), graph, { recursive: true });
cpSync(join(root, "config"), join(artifact, "config"), { recursive: true });
const owner = "src/clawsweeper-change-detection.ts";
if (baseline) {
  writeFileSync(
    join(graph, "clawsweeper-change-detection.js"),
    stripTypeScriptTypes(git("show", base + ":" + owner)),
  );
}
const { hasDataModelUpgradeProof } = await import(
  pathToFileURL(join(graph, "clawsweeper-change-detection.js")).href
);
const { renderReviewCommentFromReport, reviewAutomationMarkersFromReport } = await import(
  pathToFileURL(join(graph, "clawsweeper.js")).href
);
const text = compatibilityFixture.structuralNegation + " " + verifiedCompatibility;
const report = compatibilityReport(
  verifiedCompatibility,
  compatibilityFixture.structuralNegation + " " + compatibilityFixture.evidence,
);
const comment = renderReviewCommentFromReport(report, "none");
const observed = {
  assessmentAccepted: hasDataModelUpgradeProof(text),
  compatibilityChecklist: comment.includes("**Add data-model compatibility proof**"),
  compatibilityRecorded: comment.includes("Migration or upgrade compatibility proof is recorded"),
  blockedMarker: reviewAutomationMarkersFromReport(report).includes(
    "clawsweeper-review-state:blocked",
  ),
  priorCandidateLimitRetained: comment.includes(
    "earlier-candidate evidence, not a current-head Docker rerun",
  ),
  doctorClassificationRetained: comment.includes(
    "migration/backfill/repair: src/commands/doctor-lint.ts",
  ),
};
assert.equal(observed.assessmentAccepted, !baseline);
assert.equal(observed.compatibilityChecklist, baseline);
assert.equal(observed.compatibilityRecorded, !baseline);
assert.equal(observed.blockedMarker, baseline);
assert.equal(observed.priorCandidateLimitRetained, true);
assert.equal(observed.doctorClassificationRetained, true);
const negative = compatibilityReport(text + " Upgrade compatibility was not tested.");
assert.match(renderReviewCommentFromReport(negative, "none"), /Add data-model compatibility proof/);
writeFileSync(join(artifact, "input-report.md"), report);
writeFileSync(join(artifact, "rendered-comment.md"), comment);
const result = {
  mode: baseline ? "baseline" : "candidate",
  base,
  head: git("rev-parse", "HEAD"),
  node: process.version,
  platform: process.platform,
  sourceSha256: createHash("sha256")
    .update(readFileSync(join(graph, "clawsweeper-change-detection.js")))
    .digest("hex"),
  observed,
  negativeProofStillBlocked: true,
  limits:
    "Offline production report-rendering replay with synthetic metadata/affirmative assessment and captured public prose. Not a canonical-record replay, external publication, actual upgrade, or current-head Doctor proof.",
};
writeFileSync(join(artifact, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, artifact }, null, 2));
