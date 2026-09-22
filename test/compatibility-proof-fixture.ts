import { createHash } from "node:crypto";
import { parseDecision } from "../dist/clawsweeper.js";
import { createReportDocumentRendering } from "../dist/clawsweeper-report-document.js";
import { createReportContextRendering } from "../dist/clawsweeper-report-context.js";
import { createDashboardPresentation } from "../dist/clawsweeper-dashboard.js";
import { createRepositoryLinks } from "../dist/clawsweeper-links.js";
import { normalizeRepo, repositoryProfileFor } from "../dist/repository-profiles.js";
import type { DataModelCompatibility } from "../src/clawsweeper-types.ts";
import { closeDecision, item, reviewReportFrontMatter } from "./helpers.ts";

export const affirmativeCompatibility = "Existing database upgrade compatibility was verified.";
export const neutralCompatibility = "The evidence was assessed by the reviewer.";
export const compatibilityField = "real_behavior_proof_data_model_compatibility";

export function compatibilityReport({
  compatibility,
  summary = affirmativeCompatibility,
  metadata = {},
}: {
  compatibility?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
} = {}): string {
  return `${reviewReportFrontMatter({
    author_association: "CONTRIBUTOR",
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "145577",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    work_candidate: "none",
    pull_head_sha: "a".repeat(40),
    labels: JSON.stringify(["clawsweeper:automerge"]),
    data_model_change: "true",
    data_model_surfaces: '["database schema: src/db/schema.sql"]',
    real_behavior_proof_status: "sufficient",
    real_behavior_proof_evidence_kind: "terminal",
    real_behavior_proof_needs_contributor_action: "false",
    ...(compatibility === undefined ? {} : { [compatibilityField]: compatibility }),
    ...metadata,
  })}

## Summary

Synthetic stored-data compatibility assessment.

## Real Behavior Proof

Status: sufficient

Evidence kind: terminal

Needs contributor action: false

Summary: ${summary}

## Solution Assessment

${summary}

## Evidence

${summary}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;
}

// Use the real decision parser and report writer; only surrounding context/formatting is synthetic.
export function generatedCompatibilityReport(compatibility: DataModelCompatibility): string {
  const document = createReportDocumentRendering({
    ...createRepositoryLinks({
      reportRepo: "openclaw/clawsweeper-state",
      normalizeRepo,
      targetRepo: () => "openclaw/openclaw",
      targetProfile: () => repositoryProfileFor("openclaw/openclaw"),
    }),
    ...createReportContextRendering({} as never),
    ...createDashboardPresentation({} as never),
    prSurfaceFilesFromContext: () => [{ path: "src/db/schema.sql", additions: 1, deletions: 0 }],
    compactPullFilePaths: (file) => [file.filename],
    confidenceText: String,
    fixedInText: () => "unknown",
    formatTimestamp: String,
    labelJustificationsMarkdown: () => "- none",
    publicLikelyOwnerRole: String,
    pullHeadShaFromContext: () => "a".repeat(40),
    reviewStructuralPullStateFromContext: () => null,
    sentence: String,
    sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
  } as Parameters<typeof createReportDocumentRendering>[0]);
  const decision = parseDecision(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      summary: "Synthetic stored-data review.",
      changeSummary: "Adds a persisted column.",
      bestSolution: "Preserve stored state.",
      nextStep: { kind: "none", text: "" },
      workReason: "",
      risks: [],
      evidence: [],
      likelyOwners: [
        {
          person: "unknown",
          role: "source history unknown",
          reason: "Synthetic record.",
          commits: [],
          files: [],
          confidence: "low",
        },
      ],
      overallCorrectness: "patch is correct",
      realBehaviorProof: {
        status: "sufficient",
        evidenceKind: "terminal",
        needsContributorAction: false,
        summary: neutralCompatibility,
        dataModelCompatibility: compatibility,
      },
      prRating: {
        proofTier: "A",
        patchTier: "A",
        overallTier: "A",
        summary: "Synthetic readiness.",
        nextSteps: [],
      },
    }),
  );
  return document.markdownFor({
    item: item({
      kind: "pull_request",
      labels: ["clawsweeper:automerge"],
      authorAssociation: "MEMBER",
    }),
    decision: { ...decision, localCheckoutAccess: "verified" },
    context: {
      issue: {},
      comments: [],
      timeline: [],
      sourceRevision: "b".repeat(64),
      pullFiles: [
        {
          filename: "src/db/schema.sql",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+ALTER TABLE sessions ADD COLUMN synthetic TEXT;",
          patchComplete: true,
        },
      ],
    },
    git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
    action: { actionTaken: "kept_open" },
    reviewMode: "propose",
    snapshotHash: "c".repeat(64),
    contentDigest: "d".repeat(64),
    reviewPolicy: "e".repeat(64),
    reviewLeaseOwner: "fixture",
    reviewLeaseCommentId: 1059,
    runtime: { model: "Codex", reasoningEffort: "high" },
  } as Parameters<typeof document.markdownFor>[0]);
}
