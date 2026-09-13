import { readFileSync } from "node:fs";
import { reviewReportFrontMatter } from "./helpers.ts";

export const compatibilityFixture = JSON.parse(
  readFileSync(new URL("./fixtures/compatibility-proof-145577.json", import.meta.url), "utf8"),
) as { structuralNegation: string; proof: string; evidence: string };

export const verifiedCompatibility =
  "Existing state preservation was verified by the supplied published-updater transcript.";

// Synthetic stored report, not a copy of the unavailable canonical record.
export function compatibilityReport(assessment: string, evidence = ""): string {
  return `${reviewReportFrontMatter({ repository: "openclaw/openclaw", type: "pull_request", number: "145577", decision: "keep_open", close_reason: "none", review_status: "complete", confidence: "high", work_candidate: "none", pull_head_sha: "5e002cd8f3590bfc8d475beb5fc75597737b0bb6", data_model_change: "true", data_model_surfaces: JSON.stringify(["migration/backfill/repair: src/commands/doctor-lint.ts"]), real_behavior_proof_status: "sufficient", real_behavior_proof_needs_contributor_action: "false" })}

## Summary

Synthetic compatibility-proof rendering replay.

## Real Behavior Proof

Status: sufficient

Evidence kind: terminal

Needs contributor action: false

Summary: ${compatibilityFixture.proof}

## Solution Assessment

${assessment}

## Evidence

${evidence}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;
}
