import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({
  options: {
    "baseline-dist": { type: "string" },
    "baseline-sha": { type: "string" },
    "output-dir": { type: "string", default: ".artifacts/next-step-intent/proof" },
  },
});
assert.ok(
  values["baseline-dist"],
  "Pass --baseline-dist (see README.md for the pinned build recipe)",
);
assert.match(values["baseline-sha"] ?? "", /^[a-f0-9]{40}$/, "Pass the full --baseline-sha");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or newer is required");
const baselineDist = resolve(values["baseline-dist"]);
const candidateDist = join(root, "dist");
assert.notEqual(baselineDist, candidateDist, "Baseline and candidate must be separate builds");
const proofDir = resolve(root, values["output-dir"]);
mkdirSync(proofDir, { recursive: true });
const from = (path) => import(pathToFileURL(path).href);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const baselineSha = git("rev-parse", "--verify", `${values["baseline-sha"]}^{commit}`);
const before = await from(join(baselineDist, "clawsweeper.js"));
const after = await from(join(candidateDist, "clawsweeper.js"));
const { nextStepFromReport } = await from(join(candidateDist, "clawsweeper-next-step.js"));
const {
  reportFrontMatter,
  prRatingReportSection,
  realBehaviorProofReportSection,
  closeDecision,
  item,
} = await from(join(root, "test/helpers.ts"));

const none = { kind: "none", text: "" };
const reportedText = "No concrete repair remains after this review.";
const section = (comment, title) =>
  comment
    .split(`## ${title}\n\n`)[1]
    ?.split(/\n## |\n<details>/)[0]
    ?.trim() ?? "";
const observation = (comment) => ({
  checklist: section(comment, "Before merge"),
  checkboxCount: (section(comment, "Before merge").match(/^- \[ \]/gm) ?? []).length,
  remainingCount: Number(
    section(comment, "Merge readiness").match(/(\d+) items? remain/)?.[1] ?? 0,
  ),
  scores: section(comment, "Review scores"),
  markers: comment.match(/<!-- clawsweeper-[^\n]+/g) ?? [],
});
const rating = { proofTier: "A", patchTier: "A", overallTier: "A" };
const proofSummary = "Synthetic local renderer fixture; no historical proof record is asserted.";
function serializedReport(reason, nextStep, extra = "") {
  return `${reportFrontMatter({
    type: "pull_request",
    number: "123",
    review_status: "complete",
    local_checkout_access: "verified",
    author_association: "MEMBER",
    work_candidate: "none",
    pull_head_sha: "c".repeat(40),
    ...(nextStep === undefined ? {} : { next_step: JSON.stringify(nextStep) }),
  })}\n## Summary\n\nThe retry guard is ready for review.\n\n## What This Changes\n\nKeeps retry ownership bounded.\n\n${prRatingReportSection(
    {
      ...rating,
      overallLabel: "🦞 diamond lobster",
      patchLabel: "🦞 diamond lobster",
      summary: "Synthetic 5/6 readiness assessment.",
    },
  )}\n${realBehaviorProofReportSection({ summary: proofSummary })}\n## Work Candidate\n\nCandidate: none\n\nReason: ${reason}\n\n${extra}`;
}
const finding =
  "## Review Findings\n\nOverall correctness: patch is incorrect\n\nFull review comments:\n\n- **[P1] Retry race:** `src/retry.ts:12`\n  - body: Repair concurrent retry handling.\n  - confidence: 0.9\n";
const security =
  "## Security Review\n\nStatus: needs_attention\n\nSummary: Confirm ownership.\n\nConcerns:\n\n- **[high] Ownership boundary:** `src/retry.ts:12`\n  - body: Restore the authorization guard.\n  - confidence: 0.9\n";
const contrast = "No schema change is needed, but repair the retry guard before merge.";
const negation = "Do not merge until the owner approves the compatibility contract.";
const scenarios = [
  {
    name: "reported-text-explicit-none",
    report: serializedReport(reportedText, none),
    beforeCount: 1,
    afterCount: 0,
  },
  {
    name: "legacy-required-action",
    report: serializedReport("Repair the retry guard before merge.", undefined),
    beforeCount: 1,
    afterCount: 1,
    retained: "Repair the retry guard before merge.",
  },
  {
    name: "required-contrast",
    report: serializedReport(contrast, { kind: "required", text: contrast }),
    beforeCount: 1,
    afterCount: 1,
    retained: contrast,
  },
  {
    name: "required-human-action-without-keywords",
    report: serializedReport("None.", { kind: "required", text: "Owner approval." }),
    beforeCount: 0,
    afterCount: 1,
    retained: "Owner approval.",
  },
  {
    name: "independent-finding-with-none",
    report: serializedReport("None.", none, finding),
    beforeCount: 1,
    afterCount: 1,
    retained: "Repair concurrent retry handling.",
  },
  {
    name: "legacy-none-sentinel",
    report: serializedReport("None.", undefined),
    beforeCount: 0,
    afterCount: 0,
  },
  {
    name: "required-negation",
    report: serializedReport("None.", { kind: "required", text: negation }),
    beforeCount: 0,
    afterCount: 1,
    retained: negation,
  },
  {
    name: "legacy-reported-text",
    report: serializedReport(reportedText, undefined),
    beforeCount: 1,
    afterCount: 1,
    retained: reportedText,
  },
  {
    name: "malformed-none-fallback",
    report: serializedReport(reportedText, { kind: "none", text: "ambiguous" }),
    beforeCount: 1,
    afterCount: 1,
    retained: reportedText,
  },
  {
    name: "independent-security-with-none",
    report: serializedReport("None.", none, security),
    beforeCount: 1,
    afterCount: 1,
    retained: "Restore the authorization guard.",
  },
];
const results = [];
for (const fixture of scenarios) {
  // Identical serialized bytes enter both real renderers, bypassing producer-schema validation.
  const baselineMarkdown = before.renderReviewCommentFromReport(fixture.report, "none");
  const candidateMarkdown = after.renderReviewCommentFromReport(fixture.report, "none");
  const baseline = observation(baselineMarkdown);
  const candidate = observation(candidateMarkdown);
  assert.equal(baseline.checkboxCount, fixture.beforeCount, `${fixture.name}: baseline checklist`);
  assert.equal(candidate.checkboxCount, fixture.afterCount, `${fixture.name}: candidate checklist`);
  assert.equal(baseline.remainingCount, fixture.beforeCount, `${fixture.name}: baseline count`);
  assert.equal(candidate.remainingCount, fixture.afterCount, `${fixture.name}: candidate count`);
  assert.equal(
    (baseline.scores.match(/\(5\/6\)/g) ?? []).length,
    3,
    `${fixture.name}: all three scores`,
  );
  assert.equal(candidate.scores, baseline.scores, `${fixture.name}: scores unchanged`);
  assert.ok(baseline.markers.length > 0, `${fixture.name}: automation markers present`);
  assert.deepEqual(candidate.markers, baseline.markers, `${fixture.name}: markers unchanged`);
  if (fixture.retained) assert.ok(candidate.checklist.includes(fixture.retained), fixture.name);
  if (fixture.afterCount === 0) assert.equal(candidate.checklist, "None.", fixture.name);
  writeFileSync(join(proofDir, `${fixture.name}.report.md`), fixture.report);
  writeFileSync(join(proofDir, `${fixture.name}.before.md`), baselineMarkdown);
  writeFileSync(join(proofDir, `${fixture.name}.after.md`), candidateMarkdown);
  if (fixture.name === "reported-text-explicit-none") {
    assert.ok(baseline.checklist.includes(reportedText));
    assert.doesNotMatch(candidateMarkdown, /Complete next step|1 item remains/);
    writeFileSync(join(proofDir, "before.md"), baselineMarkdown);
    writeFileSync(join(proofDir, "after.md"), candidateMarkdown);
  }
  results.push({
    name: fixture.name,
    fixtureSha256: hash(fixture.report),
    baseline,
    candidate,
    passed: true,
  });
}

// Separately exercise the real producer -> canonical report -> reader -> renderer path.
const { createReportDocumentRendering } = await from(
  join(candidateDist, "clawsweeper-report-document.js"),
);
const { createReportContextRendering } = await from(
  join(candidateDist, "clawsweeper-report-context.js"),
);
const { createDashboardPresentation } = await from(join(candidateDist, "clawsweeper-dashboard.js"));
const { createRepositoryLinks } = await from(join(candidateDist, "clawsweeper-links.js"));
const { normalizeRepo, repositoryProfileFor } = await from(
  join(candidateDist, "repository-profiles.js"),
);
const document = createReportDocumentRendering({
  ...createRepositoryLinks({
    reportRepo: "openclaw/clawsweeper-state",
    normalizeRepo,
    targetRepo: () => "openclaw/openclaw",
    targetProfile: () => repositoryProfileFor("openclaw/openclaw"),
  }),
  ...createReportContextRendering({}),
  ...createDashboardPresentation({}),
  prSurfaceFilesFromContext: () => [],
  compactPullFilePaths: () => [],
  confidenceText: String,
  fixedInText: () => "unknown",
  formatTimestamp: String,
  labelJustificationsMarkdown: () => "- none",
  publicLikelyOwnerRole: String,
  pullHeadShaFromContext: () => "c".repeat(40),
  reviewStructuralPullStateFromContext: () => null,
  sentence: String,
  sha256: hash,
});
const producerInput = closeDecision({
  decision: "keep_open",
  closeReason: "none",
  nextStep: none,
  workReason: reportedText,
  summary: "Synthetic retry guard assessment.",
  changeSummary: "Keeps retry ownership bounded.",
  bestSolution: "None.",
  risks: [],
  overallCorrectness: "patch is correct",
  evidence: [],
  likelyOwners: [
    {
      person: "@synthetic-owner",
      role: "introduced behavior",
      reason: "Synthetic owner for this local fixture.",
      commits: ["c".repeat(40)],
      files: ["src/retry.ts"],
      confidence: "low",
    },
  ],
  realBehaviorProof: {
    status: "sufficient",
    evidenceKind: "terminal",
    needsContributorAction: false,
    summary: proofSummary,
  },
  prRating: { ...rating, summary: "Synthetic 5/6 readiness assessment.", nextSteps: [] },
});
const producer = after.parseDecision(producerInput);
const durable = document.markdownFor({
  item: item({
    kind: "pull_request",
    authorAssociation: "MEMBER",
    url: "https://github.com/openclaw/openclaw/pull/123",
  }),
  decision: { ...producer, localCheckoutAccess: "verified" },
  context: { issue: {}, comments: [], timeline: [] },
  git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
  action: { actionTaken: "kept_open" },
  reviewMode: "propose",
  snapshotHash: "synthetic-snapshot",
  contentDigest: "synthetic-content",
  reviewPolicy: "synthetic-policy",
  runtime: { model: "Codex", reasoningEffort: "high" },
});
assert.deepEqual(nextStepFromReport(durable), none);
const roundTripComment = after.renderReviewCommentFromReport(durable, "none");
const roundTrip = observation(roundTripComment);
assert.equal(roundTrip.checklist, "None.");
assert.equal(roundTrip.remainingCount, 0);
assert.equal((roundTrip.scores.match(/\(5\/6\)/g) ?? []).length, 3);
writeFileSync(join(proofDir, "producer-input.json"), JSON.stringify(producerInput, null, 2) + "\n");
writeFileSync(join(proofDir, "producer-roundtrip.report.md"), durable);
writeFileSync(join(proofDir, "producer-roundtrip.after.md"), roundTripComment);

const owners = [
  "clawsweeper",
  "clawsweeper-decision-parser",
  "clawsweeper-policy",
  "clawsweeper-next-step",
  "clawsweeper-report-comment-helpers",
  "clawsweeper-report-comment-presentation",
  "clawsweeper-report-document",
  "clawsweeper-report-context",
  "clawsweeper-dashboard",
  "clawsweeper-links",
  "report-front-matter",
  "repository-profiles",
];
const compiledHashes = (dir) =>
  Object.fromEntries(
    owners.map((owner) => {
      const path = join(dir, `${owner}.js`);
      if (owner === "clawsweeper-next-step" && !existsSync(path)) return [`${owner}.js`, null];
      return [`${owner}.js`, hash(readFileSync(path))];
    }),
  );
const sourcePaths = [
  ...owners.map((owner) => `src/${owner}.ts`),
  "src/clawsweeper-types.ts",
  "schema/clawsweeper-decision.schema.json",
  "prompts/review-item.md",
  "test/helpers.ts",
  "pnpm-lock.yaml",
  "docs/proof/review-next-step-intent/replay.mjs",
];
const result = {
  passed: true,
  provider: "local-node",
  image: null,
  lease: null,
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    packageManager: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager,
  },
  candidate: {
    head: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--untracked-files=normal").length > 0,
    build: "pnpm run build:node",
    compiledOwnerSha256: compiledHashes(candidateDist),
    sourceSha256: Object.fromEntries(
      sourcePaths.map((path) => [path, hash(readFileSync(join(root, path)))]),
    ),
  },
  baseline: {
    sha: baselineSha,
    compiledOwnerSha256: compiledHashes(baselineDist),
    provenance:
      "Caller-supplied compiled dist. SHA names the declared source revision, not a verified build attestation; use the pinned git-archive build recipe in README.md.",
  },
  command:
    "node docs/proof/review-next-step-intent/replay.mjs --baseline-dist <baseline-dist> --baseline-sha <full-sha> [--output-dir <output-dir>]",
  scenarios: results,
  producerRoundTrip: {
    passed: true,
    inputSha256: hash(JSON.stringify(producerInput)),
    fixtureSha256: hash(durable),
    observation: roundTrip,
  },
  limits:
    "Synthetic local replay only; the historical raw structured record was not recovered. No model execution, network, publication, deploy, apply, repair, or merge. Scores and markers match in every paired replay; live eligibility is not exercised. Old records without valid next-step intent retain conservative inference. Rebuild and rerun after source or HEAD changes before citing committed proof.",
};
writeFileSync(join(proofDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({ passed: true, scenarios: results.length, producerRoundTrip: true, proofDir }),
);
