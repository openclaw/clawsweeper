import { renderReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { reviewAutomationMarkersFromReport } from "../dist/clawsweeper.js";
import {
  prStatusLabelKindFromReport,
  nextPrStatusLabels,
} from "../dist/clawsweeper-label-policy.js";
import { firstBeforeMergeAction, previousReviewStatus } from "../dist/clawsweeper-markdown.js";
import { durableReviewCausalIdentityFromBody } from "../dist/clawsweeper-review-comment-state.js";
interface FindingFixture {
  markdown: string;
  record: Record<string, unknown>;
}
import {
  markedReviewCommentForTest,
  prRatingReportSection,
  realBehaviorProofReportSection,
  reportFrontMatter,
  reviewFinding,
  withReviewRecord,
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
  findings: string | FindingFixture = cleanFindings,
  decision: Record<string, unknown> = {},
): string {
  const report = `${reportFrontMatter({
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

${typeof findings === "string" ? findings : findings.markdown}

${prRatingReportSection({ overallTier: "A", proofTier: "NA", patchTier: "A", summary: "Focused repair." })}
`;
  return withReviewRecord(report, {
    decision: "keep_open",
    closeReason: "none",
    summary: "Review the focused publication repair.",
    changeSummary: "Keeps durable review state bound to the reviewed item.",
    bestSolution: "Merge after required checks are green.",
    overallCorrectness: typeof findings === "string" ? "patch is correct" : "patch is incorrect",
    reviewFindings: typeof findings === "string" ? [] : [findings.record],
    workCandidate: frontMatter.work_candidate ?? "none",
    nextStep: JSON.parse(frontMatter.next_step ?? '{"kind":"none","text":""}'),
    ...(frontMatter.maintainer_decision
      ? { maintainerDecision: JSON.parse(frontMatter.maintainer_decision) }
      : {}),
    realBehaviorProof: {
      status: "not_applicable",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
      summary: "No general proof required.",
      dataModelCompatibility:
        frontMatter.real_behavior_proof_data_model_compatibility ?? "not_applicable",
    },
    prRating: {
      overallTier: frontMatter.pr_rating_overall ?? "A",
      proofTier: "NA",
      patchTier: frontMatter.pr_rating_patch ?? "A",
      summary: "Focused repair.",
      nextSteps: [],
    },
    ...decision,
  });
}

function finding(body = "Preserve the active review lease before cleanup.") {
  return {
    record: reviewFinding({
      title: "Preserve cleanup ownership",
      body,
      priority: 1,
      confidenceScore: 0.99,
      file: "src/clawsweeper-review-comment-state.ts",
      lineStart: 42,
      lineEnd: 42,
    }),
    markdown: `## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.99

Full review comments:

- **[P1] Preserve cleanup ownership:** \`src/clawsweeper-review-comment-state.ts:42\`
  - body: ${body}
  - confidence: 0.99`,
  };
}

// An outstanding owner decision with nothing else left for the author.
const maintainer_decision = JSON.stringify({
  required: true,
  kind: "product_direction",
  question: "Which compatibility contract should ship?",
  rationale: "This needs an owner ruling.",
  options: [
    { title: "Keep compatibility", body: "Retain the old contract.", recommended: true },
    { title: "Adopt the new contract", body: "Document the break.", recommended: false },
  ],
  likelyOwner: { person: "@owner", reason: "Owns the contract.", confidence: "high" },
});

function assertReadiness(
  report: string,
  state: "ready" | "awaiting-maintainer" | "blocked" | "needs-changes",
): string {
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
  } else if (state === "awaiting-maintainer") {
    // Nothing is wrong with the PR: no checkbox, no ⛔, no remaining-item count.
    assert.match(comment, /## Before merge\n\nNone\./);
    assert.match(comment, /## Merge readiness\n\n⏳ \*\*Ready, awaiting maintainer decision\*\*\n/);
    assert.match(comment, /## Decision needed\n\n- \*\*Question:\*\* /);
    assert.doesNotMatch(comment, /- \[ \]|⛔|items? remains?|Ready for maintainer review/);
    assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
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
    "awaiting-maintainer": reviewReport({ maintainer_decision }),
    blocked: reviewReport({
      real_behavior_proof_data_model_compatibility: "insufficient",
    }),
    "needs-changes": reviewReport({ work_candidate: "queue_fix_pr" }, "", finding()),
  } as const;
  for (const state of ["ready", "awaiting-maintainer", "blocked", "needs-changes"] as const) {
    const comment = assertReadiness(reports[state], state);
    assert.deepEqual(comment.match(/<!-- clawsweeper-review-version[^>]+-->/g), [
      fixture.identityMarker,
    ]);
  }
  // Review markers carry typed outcomes without requesting repair actions.
  assert.match(
    reviewAutomationMarkersFromReport(reports.ready),
    /clawsweeper-verdict:needs-human [^>]* hold=not_opted_in findings=0 -->/,
  );
  assert.match(
    reviewAutomationMarkersFromReport(reports["awaiting-maintainer"]),
    /clawsweeper-verdict:needs-human [^>]* hold=maintainer_decision findings=0 -->/,
  );
  assert.match(
    reviewAutomationMarkersFromReport(reports.blocked),
    /clawsweeper-verdict:needs-human [^>]* hold=blocked findings=0 -->/,
  );
  assert.doesNotMatch(
    reviewAutomationMarkersFromReport(reports["needs-changes"]),
    /clawsweeper-action:fix-required/,
  );
});

test("an outstanding maintainer decision alone is awaiting the maintainer, not a defect", () => {
  const report = reviewReport({ maintainer_decision });
  const comment = assertReadiness(report, "awaiting-maintainer");
  assert.match(comment, /^Codex review: ready, awaiting a maintainer decision\./m);
  assert.equal(previousReviewStatus(comment), "ready, awaiting a maintainer decision.");
  assert.match(
    comment,
    /\*\*Owner decision:\*\* Required\. See \[Decision needed\]\(#decision-needed\)\./,
  );
  assert.match(comment, /- \*\*Question:\*\* Which compatibility contract should ship\?/);
  assert.match(
    comment,
    /- \*\*Recommendation:\*\* \*\*Keep compatibility:\*\* Retain the old contract\./,
  );
  assert.doesNotMatch(comment, /Resolve maintainer decision|Blocked before merge/);
  // The decision is the one remaining action for the comment router.
  assert.match(firstBeforeMergeAction(comment), /Which compatibility contract should ship\?/);
  // The recorded rating stands: the host neither lowers it nor asks for patch work.
  assert.match(comment, /\| \*\*Overall readiness\*\* \| 🦞 diamond lobster \*\*\(5\/6\)\*\* \|/);
  assert.doesNotMatch(comment, /Improve patch quality/);
  // Only the owner is waited on; the author has nothing to do.
  const status = prStatusLabelKindFromReport(report, { comments: [], timeline: [] }, []);
  assert.equal(status, "waiting_on_maintainer");
  assert.deepEqual(nextPrStatusLabels(["status: 👀 ready for maintainer look"], status), [
    "status: ⏳ waiting on maintainer",
  ]);
  const markers = reviewAutomationMarkersFromReport(report);
  assert.match(
    markers,
    /clawsweeper-verdict:needs-human [^>]* hold=maintainer_decision findings=0 -->/,
  );
  assert.doesNotMatch(markers, /clawsweeper-verdict:(?:pass|needs-changes)/);
  // The durable identity reader accepts the state beside the version marker.
  const identity = durableReviewCausalIdentityFromBody(
    markedReviewCommentForTest(fixture.item, comment),
    fixture.item,
  );
  assert.equal(identity?.state, "awaiting-maintainer");
  assert.equal(identity?.headSha, reviewedHead);
});

test("a maintainer decision beside remaining work keeps the PR blocked, as before", () => {
  const withFinding = reviewReport({ maintainer_decision }, "", finding());
  const comment = assertReadiness(withFinding, "blocked");
  assert.match(comment, /^Codex review: blocked before merge\./m);
  // The finding is the one remaining item; the decision renders under its own heading.
  assert.match(comment, /⛔ \*\*Blocked before merge - 1 item remains\*\*/);
  assert.match(comment, /- \[ \] \*\*Preserve cleanup ownership \(P1\)\*\* - /);
  assert.match(comment, /## Decision needed\n\n- \*\*Question:\*\* /);
  assert.match(comment, /\*\*Owner decision:\*\* Required\./);
  assert.doesNotMatch(comment, /Resolve maintainer decision|awaiting/i);
  assert.match(
    reviewAutomationMarkersFromReport(withFinding),
    /clawsweeper-verdict:needs-human [^>]* hold=blocked findings=1 -->/,
  );
  assert.equal(
    prStatusLabelKindFromReport(withFinding, { comments: [], timeline: [] }, []),
    "waiting_on_author",
  );
  // An enforced maintainer-only approval beside the decision is still a blocker.
  const withApproval = reviewReport({ maintainer_decision }, "", cleanFindings, {
    nextStep: {
      kind: "maintainer",
      text: "A maintainer must approve the current-head security change.",
    },
  });
  assert.match(assertReadiness(withApproval, "blocked"), /Await maintainer action/);
  assert.equal(
    prStatusLabelKindFromReport(withApproval, { comments: [], timeline: [] }, []),
    "waiting_on_maintainer",
  );
  assert.match(
    reviewAutomationMarkersFromReport(withApproval),
    /clawsweeper-verdict:needs-human [^>]* hold=blocked findings=0 -->/,
  );
});

test("a re-review raises the outstanding decision once, in place", () => {
  const first = reviewReport({ maintainer_decision });
  const firstComment = markedReviewCommentForTest(
    fixture.item,
    renderReviewCommentFromReport(first, "none"),
  );
  const reReview = reviewReport({ maintainer_decision, reviewed_at: "2026-08-09T18:00:00.000Z" });
  const comment = renderReviewCommentFromReport(reReview, "none", {
    previousReviewCommentBody: firstComment,
  });
  const count = (pattern: RegExp) => (comment.match(pattern) ?? []).length;
  assert.equal(count(/^## Decision needed$/gm), 1);
  assert.equal(count(/\*\*Question:\*\*/g), 1);
  assert.equal(count(/Which compatibility contract should ship\?/g), 1);
  assert.deepEqual(comment.match(/<!-- clawsweeper-review-state:[^>]+-->/g), [
    fixture.stateMarkers["awaiting-maintainer"],
  ]);
  assert.match(comment, /## Before merge\n\nNone\./);
  assert.doesNotMatch(comment, /- \[ \]|⛔|items? remains?/);
});

test("a maintainer decision is a waivable hold only when it is the one blocker", () => {
  assert.match(
    reviewAutomationMarkersFromReport(reviewReport({ maintainer_decision })),
    /clawsweeper-verdict:needs-human [^>]* hold=maintainer_decision findings=0 -->/,
  );
  assert.match(
    reviewAutomationMarkersFromReport(
      reviewReport({
        maintainer_decision,
        real_behavior_proof_data_model_compatibility: "insufficient",
      }),
    ),
    /clawsweeper-verdict:needs-human [^>]* hold=blocked findings=0 -->/,
  );
  assert.match(
    reviewAutomationMarkersFromReport(
      reviewReport(
        { maintainer_decision },
        "## Security Review\n\nStatus: needs_attention\n\nSummary: Confirm the token boundary.\n\nConcerns:\n\n- none",
        cleanFindings,
        {
          securityReview: {
            status: "needs_attention",
            summary: "Confirm the token boundary.",
            concerns: [],
          },
        },
      ),
    ),
    /clawsweeper-verdict:needs-human [^>]* hold=security findings=0 -->/,
  );
});

test("structured next-step intent controls readiness independently of advice wording", () => {
  const optedIn = { labels: '["clawsweeper:automerge"]' };
  const ready = reviewReport(optedIn, "", cleanFindings, {
    bestSolution: "A future cleanup could replace the reporting module.",
  });
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

test("maintainer-only approval waits stay blocked without blaming the author", () => {
  for (const productDecision of [false, true]) {
    const report = reviewReport({}, "", cleanFindings, {
      nextStep: {
        kind: "maintainer",
        text: "A maintainer must approve the current-head security change.",
      },
      ...(productDecision
        ? {
            productReview: {
              kind: "feature",
              userProblem: "Removing one account reconnects siblings.",
              fixScope: "complete",
              worthIt: "needs_maintainer",
              reason: "Accept the capability extension.",
            },
          }
        : {}),
    });
    const comment = assertReadiness(report, "blocked");
    assert.match(comment, /Await maintainer action/);
    assert.match(comment, /current-head security change/);
    const status = prStatusLabelKindFromReport(report, { comments: [], timeline: [] }, []);
    assert.equal(status, "waiting_on_maintainer");
    const authorActivity = {
      comments: [
        {
          author: "vincentkoc",
          body: "The security gate still needs a maintainer.",
          createdAt: "2026-08-09T00:00:00.000Z",
        },
      ],
      timeline: [],
    };
    assert.equal(prStatusLabelKindFromReport(report, authorActivity, []), "waiting_on_maintainer");
    assert.equal(
      prStatusLabelKindFromReport(
        report,
        {
          comments: [{ ...authorActivity.comments[0], body: "@clawsweeper re-review" }],
          timeline: [],
        },
        [],
      ),
      "re_review_loop",
    );
    assert.equal(
      prStatusLabelKindFromReport(report, authorActivity, ["clawsweeper:human-review"]),
      null,
    );
    assert.deepEqual(
      nextPrStatusLabels(["security-review-required", "status: ⏳ waiting on author"], status),
      ["security-review-required", "status: ⏳ waiting on maintainer"],
    );
    assert.doesNotMatch(
      reviewAutomationMarkersFromReport(report),
      /clawsweeper-verdict:pass|clawsweeper-action:fix-required/,
    );
  }
});

test("maintainer routing does not hide author findings, proof, or unknown blockers", () => {
  const nextStep = {
    kind: "maintainer",
    text: "A maintainer must approve the current-head security change.",
  };
  const scenarios = [
    { decision: { nextStep }, findings: finding(), expected: "waiting_on_author" },
    {
      decision: { nextStep, risks: ["Confirm the unresolved upgrade behavior."] },
      findings: cleanFindings,
      expected: null,
    },
    {
      decision: {
        nextStep,
        realBehaviorProof: {
          status: "missing",
          evidenceKind: "none",
          needsContributorAction: true,
          summary: "Show a real runtime trace.",
          dataModelCompatibility: "not_applicable",
        },
      },
      findings: cleanFindings,
      expected: "needs_proof",
    },
    {
      decision: { nextStep: { ...nextStep, kind: "required" } },
      findings: cleanFindings,
      expected: "waiting_on_author",
    },
  ];
  for (const scenario of scenarios) {
    const report = reviewReport(
      { author_association: "CONTRIBUTOR" },
      "",
      scenario.findings,
      scenario.decision,
    );
    assert.equal(
      prStatusLabelKindFromReport(report, { comments: [], timeline: [] }, []),
      scenario.expected,
    );
    assert.doesNotMatch(reviewAutomationMarkersFromReport(report), /clawsweeper-verdict:pass/);
  }
});

test("historical reports without a typed record reject advice prose", () => {
  const report = reviewReport()
    .replace(/^review_record:.*\n/m, "")
    .replace(
      "Merge after required checks are green.",
      "Fix the durable publication path before merge.",
    );
  assert.throws(() => renderReviewCommentFromReport(report, "none"), /missing record/);
  assert.throws(() => reviewAutomationMarkersFromReport(report), /missing record/);
});

test("queued repairs stay actionable without classifying their explanation", () => {
  const report = reviewReport({ work_candidate: "queue_fix_pr" });
  assert.match(assertReadiness(report, "needs-changes"), /Complete the queued repair/);
  assert.doesNotMatch(reviewAutomationMarkersFromReport(report), /clawsweeper-action:fix-required/);
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
      cleanFindings,
      {
        realBehaviorProof: {
          status: "missing",
          evidenceKind: "none",
          needsContributorAction: true,
          summary:
            "The PR includes a terminal transcript from a real OpenClaw setup showing the fixed behavior after the patch.",
        },
      },
    ),
    reviewReport(
      { work_candidate: "queue_fix_pr" },
      "## Risks / Open Questions\n\n[P1] A maintainer must approve the changed trust boundary.",
      cleanFindings,
      { risks: ["[P1] A maintainer must approve the changed trust boundary."] },
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
      assertReadiness(
        reviewReport({}, security, cleanFindings, {
          securityReview: {
            status: "needs_attention",
            summary: "Confirm credential scope.",
            concerns: [
              {
                title: "Check credential scope",
                body,
                severity: "high",
                confidenceScore: 0.99,
                file: "src/config.ts",
                line: 42,
              },
            ],
          },
        }),
        "blocked",
      ),
      /Resolve security concern: Check credential scope/,
    );
  }
  for (const summary of ["", "None."]) {
    assertReadiness(
      reviewReport(
        {},
        `## Security Review\n\nStatus: needs_attention\n\nSummary: ${summary}\n\nConcerns:\n\n- none`,
        cleanFindings,
        { securityReview: { status: "needs_attention", summary, concerns: [] } },
      ),
      "blocked",
    );
  }
});

test("historical repair labels cannot bypass a security blocker", () => {
  const report = reviewReport(
    { labels: '["clawsweeper:autofix"]' },
    "## Security Review\n\nStatus: needs_attention\n\nSummary: Repair the credential exposure.\n\nConcerns:\n\n- none",
    cleanFindings,
    {
      securityReview: {
        status: "needs_attention",
        summary: "Repair the credential exposure.",
        concerns: [],
      },
    },
  );
  assertReadiness(report, "blocked");
  assert.doesNotMatch(reviewAutomationMarkersFromReport(report), /clawsweeper-action:fix-required/);
});

test("a duplicate human blocker promotes the visible finding to blocked", () => {
  const detail = "Preserve the active review lease before cleanup.";
  const report = reviewReport(
    { work_candidate: "queue_fix_pr" },
    `## Risks / Open Questions\n\n[P1] ${detail}`,
    finding(detail),
    { risks: [`[P1] ${detail}`] },
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
    cleanFindings,
    { risks: [fixture.stateMarkers.ready] },
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
        number: String(fixture.item),
        labels: '["clawsweeper:automerge"]',
      }).replace(`number: ${fixture.item}\n`, `number: ${fields.number ?? fixture.item}\n`);
      if (fields.number === "unknown") {
        assert.throws(() => renderReviewCommentFromReport(report, "none"), /review_record/);
        assert.throws(() => reviewAutomationMarkersFromReport(report), /review_record/);
        continue;
      }
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

test("malformed typed records reject rather than reconstructing decision metadata", () => {
  const report = reviewReport().replace(/^review_record:.*$/m, "review_record: {");
  assert.throws(() => renderReviewCommentFromReport(report, "none"), /review_record/);
  assert.throws(() => reviewAutomationMarkersFromReport(report), /review_record/);
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
      reviewReport(
        {},
        "## Risks / Open Questions\n\n- Existing session rows lose their owner.",
        cleanFindings,
        {
          risks: ["Existing session rows lose their owner."],
        },
      ),
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
  const report = reviewReport({ pr_rating_patch: "D", pr_rating_overall: "D" }, "", cleanFindings, {
    prRating: {
      overallTier: "D",
      proofTier: "NA",
      patchTier: "D",
      summary: "Focused repair.",
      nextSteps: steps,
    },
  });
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
    { overallCorrectness: "patch is incorrect" },
  );
  assert.match(
    assertReadiness(incorrect, "needs-changes"),
    /\*\*Correct the reviewed patch\*\* - Focused repair\./,
  );
});
