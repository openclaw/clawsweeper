import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

// Historical proof: run from any directory after building the selected module root.
// --expect baseline asserts the known false positives; it does not swallow failures.
const { values } = parseArgs({
  options: {
    module: { type: "string" },
    output: { type: "string" },
    expect: { type: "string" },
  },
});
assert(
  ["baseline", "candidate"].includes(values.expect) && values.module && values.output,
  "Usage: node replay.mjs --module COMPILED_ROOT --expect baseline|candidate --output RESULT.json",
);
const worktree = fileURLToPath(new URL("../../../", import.meta.url));
const moduleRoot = resolve(values.module);
const load = (name) => import(pathToFileURL(join(moduleRoot, "dist", name + ".js")));
const { renderReviewCommentFromReport, parseDecision, reviewAutomationMarkersFromReport } =
  await load("clawsweeper");
const { createReportDocumentRendering } = await load("clawsweeper-report-document");
const { createRepositoryLinks } = await load("clawsweeper-links");
const { createReportContextRendering } = await load("clawsweeper-report-context");
const { createDashboardPresentation } = await load("clawsweeper-dashboard");
const { normalizeRepo, repositoryProfileFor } = await load("repository-profiles");
const { item, closeDecision } = await import(pathToFileURL(join(worktree, "test/helpers.ts")));
const { hydratePrimaryBody } = await import(
  pathToFileURL(join(worktree, "test/primary-body-fixture.ts"))
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fixtureBytes = readFileSync(
  join(worktree, "test/fixtures/persistence-classifier-136772.json"),
);
const fixture = JSON.parse(fixtureBytes);
const head = fixture.headSha;
const captured = fixture.pullFiles;
const normalized = hydratePrimaryBody("", "pull_request", { pullFiles: captured }).context
  .pullFiles;
const file = (filename, patch) => ({ filename, ...(patch === undefined ? {} : { patch }) });
const cases = [
  { name: "captured-runtime-raw", files: captured, stored: false, baselineFalsePositive: true },
  {
    name: "captured-runtime-normalized",
    files: normalized,
    stored: false,
    baselineFalsePositive: true,
  },
  {
    name: "cache-path-runtime-shape",
    files: [
      file(
        "src/cache/requests.ts",
        "@@ -1,2 +1,3 @@\n type CacheEntry = {\n+ signal: AbortSignal;\n };",
      ),
    ],
    stored: false,
    baselineFalsePositive: true,
  },
  {
    name: "sqlite-column-with-memory-map",
    files: [
      file(
        "src/runtime/cache.ts",
        "@@ -1,4 +1,5 @@\n const cache = new Map();\n CREATE TABLE requests (\n+ revision INTEGER,\n );",
      ),
    ],
    stored: true,
    sqlite: true,
  },
  {
    name: "explicit-cache-schema",
    files: [file("src/cache/schema.ts", "@@ -1 +1 @@\n-version: number;\n+version: string;")],
    stored: true,
  },
  {
    name: "same-hunk-browser-storage",
    files: [
      file(
        "ui/src/components/preview.ts",
        "@@ -1,3 +1,4 @@\n localStorage.setItem(key, JSON.stringify({\n+ revision: 2,\n }));",
      ),
    ],
    stored: true,
  },
  {
    name: "same-hunk-indexed-db",
    files: [
      file(
        "ui/src/components/preview.ts",
        '@@ -1,3 +1,4 @@\n const store: IDBObjectStore = transaction.objectStore("previews");\n store.put({\n+ revision: 2,\n });',
      ),
    ],
    stored: true,
  },
  {
    name: "same-hunk-durable-storage",
    files: [
      file(
        "src/cache/requests.ts",
        "@@ -1,3 +1,4 @@\n await state.storage.put(key, {\n+ revision: 2,\n });",
      ),
    ],
    stored: true,
  },
  {
    name: "file-backed-cache",
    files: [
      file(
        "src/cache/requests.ts",
        "@@ -1 +1 @@\n+writeFile(cachePath, JSON.stringify({ revision: 2 }));",
      ),
    ],
    stored: true,
  },
  {
    name: "migration",
    files: [file("src/migrations/cache.ts", "@@ -1 +1 @@\n+backfill(existingRows);")],
    stored: true,
  },
  { name: "missing-explicit-cache-schema", files: [file("src/cache/schema.ts")], stored: true },
  {
    name: "missing-sqlite-cache-owner",
    files: [file("src/cache/sqlite-store.ts")],
    stored: true,
    sqlite: true,
  },
  {
    name: "config-compatibility",
    files: [file("src/config/types.ts", "@@ -1 +1 @@\n+cacheLifetime: number;")],
    stored: false,
    config: true,
  },
  {
    name: "protocol-schema-incomplete",
    files: [file("src/gateway/protocol/schema/session.ts")],
    stored: true,
  },
  {
    name: "protocol-risk-independent",
    files: [
      file(
        "packages/gateway-protocol/src/request.ts",
        "@@ -1 +1 @@\n-requestId: string;\n+requestId: number;",
      ),
    ],
    stored: false,
    risk: true,
  },
];
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
  compactPullFilePaths: (entry) => [entry.filename],
  confidenceText: String,
  fixedInText: () => "unknown",
  formatTimestamp: String,
  labelJustificationsMarkdown: () => "- none",
  publicLikelyOwnerRole: String,
  pullHeadShaFromContext: () => head,
  reviewStructuralPullStateFromContext: () => null,
  sentence: String,
  sha256: hash,
});
const failures = [];
const results = cases.map((scenario) => {
  const decision = parseDecision(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "high",
      summary: "Synthetic offline review replay; not a live review receipt.",
      changeSummary: "Classifier-to-report compatibility boundary replay.",
      evidence: [
        {
          repo: "openclaw/openclaw",
          label: "Offline fixture",
          detail: "Captured source patch replay.",
          file: null,
          line: null,
          command: null,
          sha: null,
        },
      ],
      likelyOwners: [
        {
          person: "synthetic-owner",
          role: "review fixture",
          reason: "Offline synthetic identity.",
          commits: [],
          files: [],
          confidence: "low",
        },
      ],
      risks: scenario.risk
        ? [
            "[P1] Changing the protocol request identifier breaks existing clients; retain wire compatibility before merge.",
          ]
        : [],
      bestSolution: "The owner-boundary change is correct.",
      reproductionAssessment: "Yes. The captured patch is the input.",
      solutionAssessment: "Yes. No correctness defect was found.",
      overallCorrectness: "patch is correct",
      nextStep: { kind: "none", text: "" },
      workReason: "",
      realBehaviorProof: {
        status: "not_applicable",
        summary: "Synthetic MEMBER review context.",
        evidenceKind: "not_applicable",
        needsContributorAction: false,
      },
      prRating: {
        proofTier: "NA",
        patchTier: "B",
        overallTier: "B",
        summary: "Synthetic clean review.",
        nextSteps: [],
      },
      securityReview: { status: "cleared", summary: "None.", concerns: [] },
    }),
  );
  decision.localCheckoutAccess = "verified";
  const report = document.markdownFor({
    item: item({
      number: 999999,
      kind: "pull_request",
      title: "Synthetic offline cache classification replay",
      url: "https://github.com/openclaw/openclaw/pull/999999",
      authorAssociation: "MEMBER",
      labels: ["clawsweeper:automerge"],
    }),
    decision,
    context: { issue: {}, comments: [], timeline: [], pullFiles: scenario.files },
    git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
    action: { actionTaken: "kept_open" },
    reviewMode: "propose",
    snapshotHash: "synthetic",
    contentDigest: "synthetic",
    reviewPolicy: "synthetic",
    runtime: { model: "Codex", reasoningEffort: "high" },
    reviewLeaseOwner: "synthetic-offline-replay",
    reviewLeaseCommentId: 1,
  });
  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);
  const observed = {
    name: scenario.name,
    dataModel: /^data_model_change: true$/m.test(report),
    surfaces: JSON.parse(report.match(/^data_model_surfaces: (.*)$/m)[1]),
    sqlite: /^sqlite_schema_change: true$/m.test(report),
    config: /^config_surface_change: true$/m.test(report),
    migrationCheckbox: /- \[ \] \*\*Add data-model compatibility proof\*\*/.test(comment),
    configCheckbox: /- \[ \] \*\*Review config compatibility\*\*/.test(comment),
    needsHuman: markers.includes("clawsweeper-verdict:needs-human"),
    passes: markers.includes("clawsweeper-verdict:pass"),
    blocked: comment.includes("clawsweeper-review-state:blocked"),
    ready: comment.includes("clawsweeper-review-state:ready"),
  };
  const expectedStored =
    scenario.stored || (values.expect === "baseline" && Boolean(scenario.baselineFalsePositive));
  const expectedBlocked = Boolean(expectedStored || scenario.config || scenario.risk);
  const expected = {
    dataModel: expectedStored,
    migrationCheckbox: expectedStored,
    config: Boolean(scenario.config),
    configCheckbox: Boolean(scenario.config),
    sqlite: Boolean(scenario.sqlite),
    needsHuman: expectedBlocked,
    passes: !expectedBlocked,
    blocked: expectedBlocked,
    ready: !expectedBlocked,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (observed[key] !== value)
      failures.push(`${scenario.name}: ${key} expected ${value}, got ${observed[key]}`);
  }
  return observed;
});
const receipt = {
  expectation: values.expect,
  provider: "local-process",
  image: null,
  lease: null,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  fixture: {
    path: "test/fixtures/persistence-classifier-136772.json",
    head,
    sha256: hash(fixtureBytes),
  },
  classifierSha256: hash(readFileSync(join(moduleRoot, "dist/clawsweeper-change-detection.js"))),
  results,
  failures,
  limits:
    "Offline compiled classifier -> canonical report producer -> comment/readiness/markers. Captured runtime patch only; 12 synthetic compatibility controls. Production normalization uses the unchanged test hydration fixture. Review and lease metadata are synthetic. No model inference, migration execution, GitHub publication, or live service mutation.",
};
writeFileSync(values.output, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ expectation: values.expect, scenarios: results.length, failures }));
process.exitCode = failures.length ? 1 : 0;
