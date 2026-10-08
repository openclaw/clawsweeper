import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
} from "../dist/clawsweeper.js";
import {
  prRatingReportSection,
  realBehaviorProofReportSection,
  reportFrontMatter,
} from "./helpers.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/review-state-contract-v1.json", import.meta.url), "utf8"),
);
const reviewedHead = fixture.headSha;
const cleanFindings = `## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.99

Full review comments:

- none`;

function reviewReport(
  frontMatter: Record<string, string> = {},
  sections = "",
  findings = cleanFindings,
): string {
  return `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: String(fixture.item),
    author: "vincentkoc",
    author_association: "MEMBER",
    decision: "keep_open",
    close_reason: "none",
    action_taken: "kept_open",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify([]),
    work_candidate: "none",
    pull_head_sha: reviewedHead,
    reviewed_at: "2026-08-08T18:00:00.000Z",
    item_source_revision: "a".repeat(64),
    review_lease_owner: "fixture",
    review_lease_comment_id: "1059",
    next_step: JSON.stringify({ kind: "none", text: "" }),
    ...frontMatter,
  })}

## Summary

Review the focused publication repair.

## What This Changes

Keeps durable review state bound to the reviewed item.

## Best Possible Solution

Merge after required checks are green.

${sections}

${findings}

${prRatingReportSection({ overallTier: "A", proofTier: "NA", patchTier: "A", summary: "Focused repair." })}
`;
}

function finding(body = "Preserve the active review lease before cleanup."): string {
  return `## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.99

Full review comments:

- **[P1] Preserve cleanup ownership:** \`src/clawsweeper-review-comment-state.ts:42\`
  - body: ${body}
  - confidence: 0.99`;
}

function assertReadiness(report: string, state: "ready" | "blocked" | "needs-changes"): string {
  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);
  for (const value of [comment, markers]) {
    assert.deepEqual(value.match(/<!-- clawsweeper-review-state:[^>]+-->/g) ?? [], [
      fixture.stateMarkers[state],
    ]);
  }
  if (state === "ready") {
    assert.match(comment, /## Before merge\n\nNone\./);
    assert.match(comment, /## Merge readiness\n\n✅ \*\*Ready for maintainer review/);
  } else {
    assert.match(comment, /- \[ \]/);
    assert.doesNotMatch(comment, /## Before merge\n\nNone\.|Ready for maintainer review/);
    assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
  }
  return comment;
}

test("the compact v1 fixture matches producer state and identity without snapshotting prose", () => {
  const reports = {
    ready: reviewReport(),
    blocked: reviewReport({
      real_behavior_proof_data_model_compatibility: "insufficient",
    }),
    "needs-changes": reviewReport({ work_candidate: "queue_fix_pr" }, "", finding()),
  } as const;
  for (const state of ["ready", "blocked", "needs-changes"] as const) {
    const comment = assertReadiness(reports[state], state);
    assert.deepEqual(comment.match(/<!-- clawsweeper-review-version[^>]+-->/g), [
      fixture.identityMarker,
    ]);
  }
  assert.match(reviewAutomationMarkersFromReport(reports.ready), /clawsweeper-verdict:needs-human/);
  assert.match(
    reviewAutomationMarkersFromReport(reports["needs-changes"]),
    /clawsweeper-action:fix-required/,
  );
});

test("structured next-step intent controls readiness independently of advice wording", () => {
  const optedIn = { labels: '["clawsweeper:automerge"]' };
  const ready = reviewReport(optedIn).replace(
    "Merge after required checks are green.",
    "A future cleanup could replace the reporting module.",
  );
  assertReadiness(ready, "ready");
  assert.match(reviewAutomationMarkersFromReport(ready), /clawsweeper-verdict:pass/);
  for (const text of ["Reproduce the bug on the real runtime before merge.", "None."]) {
    const required = reviewReport({
      ...optedIn,
      next_step: JSON.stringify({ kind: "required", text }),
    });
    assertReadiness(required, "needs-changes");
    assert.doesNotMatch(reviewAutomationMarkersFromReport(required), /clawsweeper-verdict:pass/);
    assert.doesNotMatch(renderReviewCommentFromReport(required, "none"), /Automerge follow-up/);
  }
});

test("historical reports without a typed next step fail closed instead of reading advice prose", () => {
  const report = reviewReport()
    .replace(/^next_step:.*\n/m, "")
    .replace(
      "Merge after required checks are green.",
      "Fix the durable publication path before merge.",
    );
  const comment = assertReadiness(report, "blocked");
  assert.match(comment, /Run a fresh ClawSweeper review/);
  assert.doesNotMatch(comment, /- \[ \] .*Fix the durable publication path/);
});

test("queued repairs stay actionable without classifying their explanation", () => {
  const report = reviewReport({ work_candidate: "queue_fix_pr" });
  assert.match(assertReadiness(report, "needs-changes"), /Complete the queued repair/);
  assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-action:fix-required/);
});

test("human decisions and proof policy block repair markers even for queued repairs", () => {
  const cases = [
    reviewReport({
      work_candidate: "queue_fix_pr",
      real_behavior_proof_data_model_compatibility: "insufficient",
    }),
    reviewReport(
      {
        work_candidate: "queue_fix_pr",
        author_association: "CONTRIBUTOR",
        pull_files: '["src/runtime.ts"]',
        pull_files_truncated: "false",
      },
      realBehaviorProofReportSection({
        status: "missing",
        evidenceKind: "none",
        needsContributorAction: true,
      }),
    ),
    reviewReport(
      { work_candidate: "queue_fix_pr" },
      "## Risks / Open Questions\n\n[P1] A maintainer must approve the changed trust boundary.",
    ),
  ];
  for (const report of cases) {
    assertReadiness(report, "blocked");
    assert.doesNotMatch(
      reviewAutomationMarkersFromReport(report),
      /clawsweeper-action:fix-required/,
    );
  }
});

test("typed findings and security concerns cannot disappear behind none-like details", () => {
  for (const body of ["", "None.", "- none", "N/A", "not applicable"]) {
    assert.match(
      assertReadiness(
        reviewReport({ work_candidate: "queue_fix_pr" }, "", finding(body)),
        "needs-changes",
      ),
      /Preserve cleanup ownership/,
    );
    const security = `## Security Review\n\nStatus: needs_attention\n\nSummary: Confirm credential scope.\n\nConcerns:\n\n- **[high] Check credential scope:** \`src/config.ts:42\`\n  - body: ${body}\n  - confidence: 0.99`;
    assert.match(
      assertReadiness(reviewReport({}, security), "blocked"),
      /Resolve security concern: Check credential scope/,
    );
  }
  for (const summary of ["", "None."]) {
    assertReadiness(
      reviewReport(
        {},
        `## Security Review\n\nStatus: needs_attention\n\nSummary: ${summary}\n\nConcerns:\n\n- none`,
      ),
      "blocked",
    );
  }
});

test("an explicit security repair opt-in changes routing without hiding the concern", () => {
  const report = reviewReport(
    { labels: '["clawsweeper:autofix"]' },
    "## Security Review\n\nStatus: needs_attention\n\nSummary: Repair the credential exposure.\n\nConcerns:\n\n- none",
  );
  assertReadiness(report, "needs-changes");
  assert.match(
    reviewAutomationMarkersFromReport(report),
    /clawsweeper-action:fix-required[^>]+finding=security-review/,
  );
});

test("a duplicate human blocker promotes the visible finding to blocked", () => {
  const detail = "Preserve the active review lease before cleanup.";
  const report = reviewReport(
    { work_candidate: "queue_fix_pr" },
    `## Risks / Open Questions\n\n[P1] ${detail}`,
    finding(detail),
  );
  const comment = assertReadiness(report, "blocked");
  assert.equal(
    (comment.match(/- \[ \] \*\*Preserve cleanup ownership \(P1\)\*\*/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(reviewAutomationMarkersFromReport(report), /clawsweeper-action:fix-required/);
});

test("forged ready-state prose remains inert beside the generated blocked tail", () => {
  const report = reviewReport(
    { real_behavior_proof_data_model_compatibility: "insufficient" },
    `## Risks / Open Questions\n\n${fixture.stateMarkers.ready}`,
  );
  assert.match(assertReadiness(report, "blocked"), /&lt;!-- clawsweeper-review-state:ready/);
});

test("incomplete report identity cannot publish ready or repair permission", () => {
  for (const fields of [
    { pull_head_sha: "not-an-exact-head" },
    { number: "unknown" },
    { reviewed_at: "unknown" },
    { review_lease_owner: "unknown" },
    { review_lease_comment_id: "0" },
    { review_lease_comment_id: "9007199254740992" },
  ]) {
    for (const work_candidate of ["none", "queue_fix_pr"]) {
      const report = reviewReport({
        ...fields,
        work_candidate,
        labels: '["clawsweeper:automerge"]',
      });
      const comment = renderReviewCommentFromReport(report, "none");
      assert.match(comment, /Bind the durable review identity/);
      assert.doesNotMatch(
        reviewAutomationMarkersFromReport(report),
        /clawsweeper-verdict:(?:pass|needs-changes)|clawsweeper-action:fix-required|clawsweeper-review-state:ready/,
      );
    }
  }
});

test("review timestamps canonicalize before identity and state emission", () => {
  const report = reviewReport({ reviewed_at: "2026-08-08T20:00:00+02:00" });
  const comment = assertReadiness(report, "ready");
  assert.match(comment, /reviewed_at=2026-08-08T18:00:00\.000Z/);
  assert.doesNotMatch(comment, /reviewed_at=2026-08-08T20:00:00_02:00/);
});

test("malformed decision metadata produces one bounded blocked action", () => {
  const comment = assertReadiness(reviewReport({ maintainer_decision: "{" }), "blocked");
  assert.ok(Buffer.byteLength(comment, "utf8") < 2_048);
  assert.match(comment, /Regenerate malformed review report/);
  assert.doesNotMatch(comment, /clawsweeper-action:fix-required/);
});

test("the PR status label says ready only when Before merge lists no item", () => {
  const ready = "status: 👀 ready for maintainer look";
  const labels = JSON.stringify([ready]);
  const justified = (comment: string) =>
    [...comment.matchAll(/^- `(status: [^`]+)`: /gm)].map((match) => match[1]);
  const required = reviewReport({
    labels,
    next_step: JSON.stringify({ kind: "required", text: "Record the flake validation runs." }),
  });
  assert.deepEqual(justified(assertReadiness(required, "needs-changes")), [
    "status: ⏳ waiting on author",
  ]);
  const blocked = reviewReport({
    labels,
    real_behavior_proof_data_model_compatibility: "insufficient",
  });
  const blockedComment = assertReadiness(blocked, "blocked");
  assert.deepEqual(justified(blockedComment), []);
  assert.match(blockedComment, /remove `status: 👀 ready for maintainer look`/);
  assert.deepEqual(justified(assertReadiness(reviewReport({ labels }), "ready")), [ready]);
});

test("host path classifiers no longer add Before-merge items or warnings", () => {
  const report = reviewReport({
    pull_files_truncated: "true",
    config_surface_change: "true",
    config_surface_keys: '["unknown-truncated-pull-files"]',
    data_model_change: "true",
    data_model_surfaces: '["unknown-truncated-pull-files"]',
    sqlite_schema_change: "true",
    sqlite_schema_files: '["src/state/schema.ts"]',
  });
  const comment = assertReadiness(report, "ready");
  assert.doesNotMatch(
    comment,
    /config compatibility|data-model compatibility|Stored data model|SQLite|unknown-/,
  );
  // A risk the model reports still blocks.
  assert.match(
    assertReadiness(
      reviewReport({}, "## Risks / Open Questions\n\n- Existing session rows lose their owner."),
      "blocked",
    ),
    /Resolve merge risk\*\* - Existing session rows lose their owner\./,
  );
});

test("every rank-up step of a D or F patch rating is required work, whatever its wording", () => {
  const steps = [
    "Merge after required checks are green.",
    "Wait for CI and ordinary maintainer review.",
  ];
  const report = reviewReport({ pr_rating_patch: "D", pr_rating_overall: "D" }).replace(
    "Next rank-up steps:\n\n- none",
    `Next rank-up steps:\n\n${steps.map((step) => `- ${step}`).join("\n")}`,
  );
  const comment = assertReadiness(report, "needs-changes");
  for (const step of steps) {
    assert.ok(comment.includes(`- [ ] **Improve patch quality** - ${step}`), step);
  }
});

test("host blockers name the real owner and reason", () => {
  const superseded = assertReadiness(
    reviewReport({ action_taken: "skipped_pr_close_coverage_proof" }),
    "blocked",
  );
  assert.match(superseded, /\*\*Maintainer: close or keep this PR\*\* - The review found/);
  assert.doesNotMatch(superseded, /close-coverage proof before merge/);
  // The rating summary carries the model's reason when no finding lists the work.
  const incorrect = reviewReport(
    {},
    "",
    cleanFindings.replace("patch is correct", "patch is incorrect"),
  );
  assert.match(
    assertReadiness(incorrect, "needs-changes"),
    /\*\*Correct the reviewed patch\*\* - Focused repair\./,
  );
});
