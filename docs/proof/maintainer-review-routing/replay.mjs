// Local compiled production-path replay. No GitHub, model, or apply calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const out = resolve(root, ".artifacts/maintainer-review-routing");
const baseline = resolve(root, process.argv[2] ?? ".artifacts/maintainer-routing-baseline/dist");
const from = (dir, name) => import(pathToFileURL(resolve(dir, name + ".js")));
const dist = resolve(root, "dist");
const [parser, records, comments, readiness, labels, beforeLabels] = await Promise.all([
  from(dist, "clawsweeper"),
  from(dist, "review-record"),
  from(dist, "clawsweeper-report-comment-presentation"),
  from(dist, "clawsweeper-report-comment-helpers"),
  from(dist, "clawsweeper-label-policy"),
  from(baseline, "clawsweeper-label-policy"),
]);
const input = readFileSync(resolve(import.meta.dirname, "input.report.md"), "utf8");
const subject = { repo: "openclaw/openclaw", number: 123, kind: "pull_request" };
const original = records.requireReviewRecord(input).decision;
const activity = { comments: [], timeline: [] };
const priorLabels = ["security-review-required", "status: ⏳ waiting on author"];
assert.equal(
  beforeLabels.prStatusLabelKindFromReport(input, activity, priorLabels),
  "waiting_on_author",
);
assert.equal(labels.prStatusLabelKindFromReport(input, activity, priorLabels), "waiting_on_author");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "before.md"), comments.renderReviewCommentFromReport(input, "none"));
const observations = [];
const scenarios = [
  { name: "security-approval", expected: "waiting_on_maintainer" },
  {
    name: "security-and-product",
    expected: "waiting_on_maintainer",
    decision: {
      likelyOwners: [
        {
          person: "@fixture-maintainer",
          role: "maintainer",
          reason: "Synthetic owner for local replay.",
          commits: [],
          files: [],
          confidence: "low",
        },
      ],
      maintainerDecision: {
        required: true,
        kind: "product_direction",
        question: "Should isolated account removal extend the existing capability?",
        rationale: "The extension needs maintainer acceptance.",
        options: [
          {
            title: "Accept",
            body: "Extend the capability with isolated teardown.",
            recommended: true,
          },
          {
            title: "Retain",
            body: "Keep the current whole-channel removal contract.",
            recommended: false,
          },
        ],
        likelyOwner: {
          person: "@fixture-maintainer",
          reason: "Synthetic owner for local replay.",
          confidence: "low",
        },
      },
    },
  },
  {
    name: "author-finding",
    expected: "waiting_on_author",
    decision: {
      overallCorrectness: "patch is incorrect",
      reviewFindings: [
        {
          title: "Preserve the credential owner",
          body: "Restore the publication ownership guard.",
          priority: 1,
          confidenceScore: 0.99,
          file: "src/runtime.ts",
          lineStart: 1,
          lineEnd: 1,
        },
      ],
    },
  },
  {
    name: "missing-proof",
    expected: "needs_proof",
    decision: {
      realBehaviorProof: {
        status: "missing",
        evidenceKind: "none",
        summary: "Show a real runtime trace.",
        needsContributorAction: true,
        dataModelCompatibility: "not_applicable",
      },
    },
  },
  {
    name: "unknown-risk",
    expected: null,
    decision: { risks: ["Confirm unresolved upgrade behavior."] },
  },
];
for (const scenario of scenarios) {
  const decision = {
    ...original,
    nextStep: { ...original.nextStep, kind: "maintainer" },
    ...scenario.decision,
  };
  const line = records.reviewRecordFrontMatterLine({ decision }, subject);
  assert.ok(line);
  const report = input
    .replace(/^review_record:.*$/m, () => line)
    .replace(/^next_step:.*$/m, () => "next_step: " + JSON.stringify(decision.nextStep));
  assert.deepEqual(records.requireReviewRecord(report).decision.nextStep, decision.nextStep);
  const state = readiness.pullRequestReviewReadinessFromReport(report);
  const status = labels.prStatusLabelKindFromReport(report, activity, priorLabels);
  const nextLabels = labels.nextPrStatusLabels(priorLabels, status);
  const markers = parser.reviewAutomationMarkersFromReport(report);
  assert.equal(status, scenario.expected);
  assert.equal(state.state, "blocked");
  assert.ok(nextLabels.includes("security-review-required"));
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass|clawsweeper-action:fix-required/);
  const comment = comments.renderReviewCommentFromReport(report, "none");
  assert.match(comment, /Await maintainer action/);
  writeFileSync(resolve(out, scenario.name + ".report.md"), report);
  writeFileSync(resolve(out, scenario.name + ".comment.md"), comment);
  observations.push({
    scenario: scenario.name,
    status,
    nextLabels,
    readiness: state.state,
    items: state.items,
    markers,
  });
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const files = [
  "clawsweeper-next-step.js",
  "clawsweeper-report-comment-helpers.js",
  "clawsweeper-label-policy.js",
];
const receipt = {
  sourceHead: git("rev-parse", "HEAD"),
  dirty: Boolean(git("status", "--porcelain", "--untracked-files=no")),
  runtime: process.version,
  platform: process.platform + "/" + process.arch,
  provider: "local-node-in-managed-linux-sandbox",
  image: "not exposed",
  lease: null,
  baselineSource: "b79b76cc0cc46f266104fb1a8f95cdd2a74c8292",
  inputSha256: hash(input),
  compiledSha256: Object.fromEntries(
    files.map((file) => [file, hash(readFileSync(resolve(dist, file)))]),
  ),
  baselineCompiledSha256: Object.fromEntries(
    files.map((file) => [file, hash(readFileSync(resolve(baseline, file)))]),
  ),
  before: "waiting_on_author",
  legacyAfter: "waiting_on_author",
  observations,
  limits:
    "Synthetic persisted reviewer input, not recovered live records or a model judgement. Ownership is supplied explicitly in the new producer input; legacy prose is deliberately not migrated. No hosted queue, GitHub label write, approval, or merge was executed.",
};
writeFileSync(resolve(out, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));
