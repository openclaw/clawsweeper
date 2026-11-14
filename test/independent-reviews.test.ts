import { prStatusLabelKindFromReport } from "../dist/clawsweeper-label-policy.js";
import {
  parseReviewHistory,
  renderReviewHistorySection,
  reviewHistoryCycleFromCommentBody,
} from "../dist/review-history.js";
import { reviewPolicyHash } from "../dist/clawsweeper-review-policy-hash.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  independentReviewModels,
  independentReviewConflicts,
  reduceIndependentReviews,
} from "../dist/independent-reviews.js";
import { reviewDecisionParser } from "../dist/clawsweeper-decision-parser.js";
import { codexFailureDecisionForTest } from "../dist/clawsweeper.js";
import { markdownFor } from "../dist/clawsweeper-report-document.js";
import { readReviewRecord, reviewRecordProblem } from "../dist/review-record.js";
import { pullRequestReviewReadinessFromReport } from "../dist/clawsweeper-report-comment-helpers.js";
import { renderReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import { reviewStatusForDecision } from "../dist/clawsweeper-report-document.js";
import { replaceFrontMatterValue } from "../dist/report-front-matter.js";
import { changelogReviewDecision, item, reviewFinding, git } from "./helpers.ts";
import type { Decision } from "../src/clawsweeper-types.ts";
import type { IndependentReview } from "../src/independent-reviews.ts";

const snapshot = "a".repeat(64);
const neutral = () => codexFailureDecisionForTest(1, "Independent review projection");
const decision = (overrides = {}): Decision => ({
  ...reviewDecisionParser.parseDecision(
    changelogReviewDecision({
      reviewFindings: [],
      risks: [],
      overallCorrectness: "patch is correct",
      nextStep: { kind: "none", text: "" },
      workCandidate: "none",
      ...overrides,
    }),
  ),
  localCheckoutAccess: "verified",
});
const review = (reviewer: 1 | 2, d = decision()): IndependentReview => ({
  reviewer,
  requestedModel: "fixture",
  executionModel: "unverified",
  snapshotHash: snapshot,
  status: "complete",
  decision: d,
});
function report(d: Decision): string {
  return markdownFor({
    item: item({ kind: "pull_request", number: 42 }),
    context: {
      issue: {},
      comments: [],
      timeline: [],
      pullRequest: { head: { sha: "b".repeat(40) } },
    },
    decision: d,
    git,
    action: { actionTaken: "kept_open", closeComment: "" },
    reviewMode: "propose",
    snapshotHash: snapshot,
    contentDigest: "digest",
    reviewPolicy: "policy",
    runtime: { model: "fixture", reasoningEffort: "medium" },
    reviewLeaseOwner: "fixture",
    reviewLeaseCommentId: 1059,
  });
}

test("independent review opt-in requires two identifiers and rejects coordinator JSON", () => {
  assert.equal(independentReviewModels({ _: [] }), undefined);
  assert.deepEqual(independentReviewModels({ _: [], review_models: "a,b" }), ["a", "b"]);
  for (const value of [true, "a", "a,b,c", '{"reviewers":[],"coordinator":{}}', "a, b"]) {
    assert.throws(() => independentReviewModels({ _: [], review_models: value }), /exactly two/);
  }
  assert.throws(
    () => independentReviewModels({ _: [], multi_review_config: "legacy.json" }),
    /unsupported/,
  );
});

test("reducer is deterministic by reviewer identity and never synthesizes prose or close/work authority", () => {
  const first = review(
    1,
    decision({
      summary: "First  opinion.\nKeep this spacing.",
      decision: "close",
      closeReason: "cannot_reproduce",
    }),
  );
  const second = review(2, decision({ summary: "Different recommendation; not a consensus." }));
  const original = JSON.stringify([first, second]);
  const aggregate = reduceIndependentReviews([first, second], snapshot, neutral());
  assert.deepEqual(aggregate, reduceIndependentReviews([second, first], snapshot, neutral()));
  assert.equal(JSON.stringify([first, second]), original);
  assert.equal(aggregate.decision, "keep_open");
  assert.equal(aggregate.closeReason, "none");
  assert.equal(aggregate.workCandidate, "none");
  assert.equal(aggregate.autoImplementationCandidate, "none");
  assert.equal(aggregate.independentReviews[0].decision.summary, first.decision.summary);
  assert.ok(independentReviewConflicts([first, second]).includes("decision"));
  assert.equal(aggregate.nextStep.kind, "required");
  const stored = readReviewRecord(report(aggregate)).decision;
  assert.deepEqual(stored, aggregate);
  const comment = renderReviewCommentFromReport(report(aggregate), "none");
  assert.match(comment, /## Reviewer 1/);
  assert.match(comment, /## Reviewer 2/);
  assert.match(comment, /decision: Reviewer 1 = "close"; Reviewer 2 = "keep_open"/);
  assert.match(comment, /Executed model: unverified/);
});

test("all independent blockers, holds and duplicate findings survive record and ordinary policies", () => {
  const finding = reviewFinding({ priority: 1, title: "Distinct defect", body: "Fix the defect." });
  const first = review(
    1,
    decision({
      reviewFindings: [finding],
      risks: ["First risk"],
      nextStep: { kind: "maintainer", text: "Owner must decide direction." },
    }),
  );
  const second = review(
    2,
    decision({
      reviewFindings: [finding],
      risks: ["Second risk"],
      productReview: {
        kind: "feature",
        userProblem: "Optional feature",
        fixScope: "not_applicable",
        worthIt: "no",
        reason: "Do not land this scope.",
      },
    }),
  );
  const aggregate = reduceIndependentReviews([first, second], snapshot, neutral());
  assert.equal(aggregate.reviewFindings.length, 2);
  assert.deepEqual(aggregate.reviewFindings, [finding, finding]);
  assert.deepEqual(aggregate.risks, ["First risk", "Second risk"]);
  const readiness = pullRequestReviewReadinessFromReport(report(aggregate));
  assert.notEqual(readiness.state, "ready");
  for (const reviewer of [1, 2])
    assert.ok(
      readiness.items.some((item) =>
        item.label.startsWith(`Reviewer ${reviewer}: Distinct defect`),
      ),
    );
  assert.ok(readiness.items.some((item) => item.detail.includes("Owner must decide")));
  assert.ok(readiness.items.some((item) => item.detail.includes("Do not land")));
});

test("missing, failed, stale, duplicate or unverified required reviews cannot complete", () => {
  const first = review(1),
    second = review(2);
  for (const reviews of [
    [],
    [first],
    [first, first],
    [first, { ...second, status: "failed" }],
    [first, { ...second, snapshotHash: "b".repeat(64) }],
    [first, { ...second, decision: { ...second.decision, localCheckoutAccess: "unverified" } }],
  ]) {
    const aggregate = reduceIndependentReviews(reviews, snapshot, neutral());
    assert.equal(reviewStatusForDecision(aggregate), "failed");
    assert.equal(aggregate.confidence, "low");
    assert.equal(aggregate.realBehaviorProof.status, "insufficient");
    assert.equal(aggregate.nextStep.kind, "required");
  }
  const valid = reduceIndependentReviews([first, second], snapshot, neutral());
  const corrupt = {
    ...valid,
    independentReviews: [
      { ...first, decision: { ...first.decision, surprise: "invalid" } },
      second,
    ],
  };
  assert.match(
    reviewRecordProblem(corrupt, { repo: "openclaw/openclaw", number: 42, kind: "pull_request" }),
    /unexpected/,
  );
  assert.throws(
    () =>
      readReviewRecord(
        replaceFrontMatterValue(
          report(valid),
          "review_record",
          JSON.stringify({ version: 1, decision: corrupt }),
        ),
      ),
    /unexpected/,
  );
});

test("typed labels, proof and ratings use conservative policies without widening schema limits", () => {
  const first = review(
    1,
    decision({
      triagePriority: "P1",
      labelJustifications: [{ label: "P1", reason: "Urgent" }],
      realBehaviorProof: {
        status: "missing",
        summary: "Missing a live run.",
        evidenceKind: "none",
        needsContributorAction: true,
        dataModelCompatibility: "insufficient",
      },
      prRating: {
        proofTier: "F",
        patchTier: "D",
        overallTier: "F",
        summary: "Blocked",
        nextSteps: ["Demonstrate runtime"],
      },
    }),
  );
  const second = review(2);
  const aggregate = reduceIndependentReviews([first, second], snapshot, neutral());
  assert.equal(aggregate.triagePriority, "P1");
  assert.equal(aggregate.realBehaviorProof.status, "missing");
  assert.equal(aggregate.realBehaviorProof.needsContributorAction, true);
  assert.equal(aggregate.realBehaviorProof.dataModelCompatibility, "insufficient");
  assert.equal(aggregate.prRating.overallTier, "NA"); // Unknown is never upgraded to an invented rating.
  assert.equal(
    reviewRecordProblem(aggregate, { repo: "openclaw/openclaw", number: 42, kind: "pull_request" }),
    null,
  );
});

test("label union overflow is held without weakening the three-label schema", () => {
  const a = review(1),
    b = review(2);
  a.decision.impactLabels = ["impact:data-loss", "impact:security", "impact:crash-loop"];
  b.decision.impactLabels = ["impact:message-loss"];
  a.decision.maturityLabels = ["maturity:stable"];
  for (const r of [a, b])
    r.decision.labelJustifications = [
      { label: "P2", reason: "Normal priority" },
      ...r.decision.impactLabels.map((label) => ({ label, reason: "Independent assessment" })),
      ...r.decision.maturityLabels.map((label) => ({ label, reason: "Stable" })),
    ];
  const aggregate = reduceIndependentReviews([a, b], snapshot, neutral());
  assert.deepEqual(aggregate.impactLabels, []);
  assert.deepEqual(aggregate.maturityLabels, []);
  assert.match(aggregate.nextStep.text, /label schema capacity/);
  assert.equal(aggregate.independentReviews[0].decision.impactLabels.length, 3);
  assert.equal(aggregate.independentReviews[1].decision.impactLabels.length, 1);
  assert.equal(
    reviewRecordProblem(aggregate, { repo: "openclaw/openclaw", number: 42, kind: "pull_request" }),
    null,
  );
});

test("single-review policy hash is stable while opt-in pairs are distinct", () => {
  const dependencies = {
    reviewPromptTemplates: () => ({
      core: "core",
      issue: "issue",
      pull_request: "pull",
      closeReasons: "close",
    }),
    reviewDecisionSchemaText: () => "schema",
  };
  const single = reviewPolicyHash({}, dependencies);
  assert.equal(single, reviewPolicyHash({ model: "other" }, dependencies));
  const pair = reviewPolicyHash({ reviewModels: ["a", "b"] }, dependencies);
  assert.notEqual(single, pair);
  assert.equal(pair, reviewPolicyHash({ reviewModels: ["a", "b"], runner: "codex" }, dependencies));
  assert.notEqual(
    pair,
    reviewPolicyHash({ reviewModels: ["a", "b"], runner: "openclaw" }, dependencies),
  );
  assert.notEqual(pair, reviewPolicyHash({ reviewModels: ["b", "a"] }, dependencies));
});

test("distinct maintainer decisions stay intact and both hold readiness", () => {
  const a = review(1),
    b = review(2);
  for (const r of [a, b])
    r.decision.maintainerDecision = {
      required: true,
      kind: "product_direction",
      question: `Question from ${r.reviewer}?`,
      rationale: `Original rationale ${r.reviewer}`,
      options: [
        { title: "Keep", body: "Keep this direction", recommended: true },
        { title: "Decline", body: "Decline this direction", recommended: false },
      ],
      likelyOwner: { person: "@maintainer", reason: "Product owner", confidence: "high" },
    };
  const aggregate = reduceIndependentReviews([a, b], snapshot, neutral());
  const markdown = report(aggregate);
  assert.equal(pullRequestReviewReadinessFromReport(markdown).state, "awaiting-maintainer");
  const stored = readReviewRecord(markdown).decision;
  assert.deepEqual(
    stored.independentReviews.map((r) => r.decision.maintainerDecision),
    [a.decision.maintainerDecision, b.decision.maintainerDecision],
  );
  const comment = renderReviewCommentFromReport(markdown, "none");
  assert.match(comment, /Question from 1/);
  assert.match(comment, /Question from 2/);
});

test("typed reconciliation keeps contributor status routing", () => {
  const first = review(
    1,
    decision({ triagePriority: "P1", labelJustifications: [{ label: "P1", reason: "Urgent" }] }),
  );
  const markdown = report(reduceIndependentReviews([first, review(2)], snapshot, neutral()));
  const readiness = pullRequestReviewReadinessFromReport(markdown);
  assert.equal(readiness.state, "needs-changes");
  assert.equal(
    prStatusLabelKindFromReport(markdown, { comments: [], timeline: [] }, []),
    "waiting_on_author",
  );
});

test("paired re-reviews retain one history ledger and one completed cycle per pair", () => {
  const previous =
    renderReviewCommentFromReport(
      replaceFrontMatterValue(report(decision()), "reviewed_at", "2026-11-01T00:00:00Z"),
      "none",
    ) +
    "\n\n" +
    renderReviewHistorySection({
      cycles: [
        {
          reviewedAt: "2026-10-01T00:00:00Z",
          sha: "c".repeat(40),
          verdict: "prior verdict",
          findings: ["Prior finding"],
        },
      ],
      totalCompletedCycles: 1,
    });
  const aggregate = reduceIndependentReviews([review(1), review(2)], snapshot, neutral());
  const current = renderReviewCommentFromReport(
    replaceFrontMatterValue(report(aggregate), "reviewed_at", "2026-11-02T00:00:00Z"),
    "none",
    { previousReviewCommentBody: previous },
  );
  assert.equal(parseReviewHistory(current).totalCompletedCycles, 2);
  assert.equal((current.match(/<!-- clawsweeper-review-history /g) ?? []).length, 1);
  assert.match(
    reviewHistoryCycleFromCommentBody(current).verdict,
    /two independent reviews complete/,
  );
  const next = renderReviewCommentFromReport(
    replaceFrontMatterValue(report(aggregate), "reviewed_at", "2026-11-03T00:00:00Z"),
    "none",
    { previousReviewCommentBody: current },
  );
  assert.equal(parseReviewHistory(next).totalCompletedCycles, 3);
  assert.equal((next.match(/<!-- clawsweeper-review-history /g) ?? []).length, 1);
});
