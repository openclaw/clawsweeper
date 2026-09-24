#!/usr/bin/env node
// Offline classifier -> saved report -> public readiness proof; no GitHub writes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const [repo, phase, output] = process.argv.slice(2);
assert.ok(["baseline", "candidate"].includes(phase));
const load = (file) => import(pathToFileURL(join(repo, file)).href);
const { parseDecision, renderReviewCommentFromReport, reviewAutomationMarkersFromReport } =
  await load("dist/clawsweeper.js");
const { createReportDocumentRendering } = await load("dist/clawsweeper-report-document.js");
const { createReportContextRendering } = await load("dist/clawsweeper-report-context.js");
const { createDashboardPresentation } = await load("dist/clawsweeper-dashboard.js");
const { closeDecision, item } = await load("test/helpers.ts");
const { hydratePrimaryBody } = await load("test/primary-body-fixture.ts");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fixtureBytes = readFileSync(
  new URL("../../test/fixtures/persistence-classifier-156686.json", import.meta.url),
);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const cases = [
  { name: "reporting-full", files: fixture.pullFiles, negative: true },
  {
    name: "reporting-normalized",
    files: hydratePrimaryBody("", "pull_request", { pullFiles: fixture.pullFiles }).context
      .pullFiles,
    negative: true,
  },
  ...[false, true].map((truncated) => ({
    name: "separate-hunks" + (truncated ? "-truncated" : ""),
    files: [
      {
        filename: "src/runtime/source-reader.ts",
        patch:
          "@@\n+const statePath = options.databasePath;\n@@\n+const source = readFileSync(sourcePath);" +
          (truncated ? "\n\n[truncated 90 chars]" : ""),
      },
    ],
    negative: true,
  })),
  {
    name: "file-state-codec",
    files: [
      {
        filename: "src/runtime/reader.ts",
        patch: "@@\n+const value = decodeBinary(readFileSync(statePath));",
      },
    ],
  },
  ...["options.statePath", "this.statePath", "await options.statePath", "(this.statePath)"].map(
    (input, index) => ({
      name: "member-state-codec-" + index,
      files: [
        {
          filename: "src/runtime/reader.ts",
          patch: "@@\n+const value = decodeBinary(readFile(" + input + "));",
        },
      ],
    }),
  ),
  ...[
    'options["statePath"]',
    "this['statePath']",
    'options?.["statePath"]',
    'paths[current]["statePath"]',
    'path.resolve(root, options["statePath"])',
    'resolvePath("),", options["statePath"])',
    'path.resolve(root.replace(/\\)/g, ""), statePath)',
  ].map((input, index) => ({
    name: "bracket-state-codec-" + index,
    files: [
      {
        filename: "src/runtime/reader.ts",
        patch: "@@\n+const value = decodeBinary(readFileSync(" + input + "));",
      },
    ],
  })),
  ...[
    "readFileSync(sourcePath, { statePath })",
    "readFileSync(sourcePath) || statePath",
    "readFileSync(sourcePath /* statePath is unrelated */)",
  ].map((expression, index) => ({
    name: "colocated-read-context-" + index,
    files: [
      {
        filename: "src/runtime/source-reader.ts",
        patch: "@@\n+const source = " + expression + ";",
      },
    ],
  })),
  {
    name: "computed-read-method",
    files: [
      {
        filename: "src/runtime/reader.ts",
        patch: '@@\n+const value = decodeBinary(fs["readFileSync"](options["statePath"]));',
      },
    ],
  },
  {
    name: "multiline-read-input",
    files: [
      {
        filename: "src/runtime/reader.ts",
        patch: "@@\n const value = decodeBinary(readFileSync(\n-  oldPath,\n+  statePath,\n ));",
      },
    ],
  },
  {
    name: "write-json",
    files: [
      {
        filename: "src/runtime/output.ts",
        patch: "@@\n+writeFileSync(target, JSON.stringify({revision:2}));",
      },
    ],
  },
  {
    name: "unchanged-state-path-io",
    files: [
      {
        filename: "src/runtime/records.ts",
        patch:
          "@@\n const statePath = options.databasePath;\n const fd = stateFds.get(statePath);\n+fs.readSync(fd, buffer, 0, buffer.length, 0);",
      },
    ],
    baselineReady: true,
  },
  ...[
    'fs.createReadStream(options["statePath"])',
    "createWriteStream(options.statePath)",
    'await fs.promises.open(statePath, "r")',
    'fs["openSync"](options["statePath"], "r")',
    "fs.readSync(stateFds.get(statePath), buffer, 0, buffer.length, 0)",
    "fs.readv(stateFds.get(statePath), buffers, 0, done)",
    "fs.writeSync(stateFds.get(statePath), payload)",
    "fs.writevSync(stateFds.get(statePath), buffers)",
    "fs.appendFileSync(statePath, payload)",
    "fs.truncateSync(statePath, 0)",
  ].map((expression, index) => ({
    name: "stream-descriptor-" + index,
    files: [{ filename: "src/runtime/records.ts", patch: "@@\n+" + expression + ";" }],
  })),
  {
    name: "browser-storage",
    files: [
      {
        filename: "ui/src/preferences.ts",
        patch: '@@\n+localStorage.setItem("prefs", JSON.stringify({revision:2}));',
      },
    ],
  },
  { name: "strong-owner-incomplete", files: [{ filename: "src/persistence/records.ts" }] },
  {
    name: "sqlite-schema",
    files: [
      {
        filename: "src/db/schema.ts",
        patch: '@@\n+db.exec("ALTER TABLE sessions ADD COLUMN detail TEXT");',
      },
    ],
  },
];
mkdirSync(output, { recursive: true });
const document = createReportDocumentRendering({
  ...createReportContextRendering({}),
  ...createDashboardPresentation({}),
  prSurfaceFilesFromContext: () => [],
  compactPullFilePaths: (file) => [file.filename],
  confidenceText: String,
  fixedInText: () => "unknown",
  formatTimestamp: String,
  labelJustificationsMarkdown: () => "- none",
  publicLikelyOwnerRole: String,
  pullHeadShaFromContext: () => fixture.headSha,
  reviewStructuralPullStateFromContext: () => null,
  sentence: String,
  sha256: sha,
  linkedSha: String,
  markdownLink: (label, url) => `[${label}](${url})`,
});
const records = [];
const failures = [];
for (const scenario of cases) {
  const report = document.markdownFor({
    item: item({
      kind: "pull_request",
      number: 156686,
      url: fixture.pr,
      labels: ["clawsweeper:automerge"],
    }),
    decision: {
      ...parseDecision(
        closeDecision({
          decision: "keep_open",
          closeReason: "none",
          summary: "Synthetic completed review for offline report replay.",
          changeSummary: "Read routing or storage control.",
          evidence: [],
          overallCorrectness: "patch is correct",
          workReason: "",
          nextStep: { kind: "none", text: "" },
          realBehaviorProof: {
            status: "sufficient",
            summary: "Offline report replay only; no database upgrade proof is supplied.",
            evidenceKind: "terminal",
            needsContributorAction: false,
            dataModelCompatibility: "not_applicable",
          },
        }),
      ),
      localCheckoutAccess: "verified",
    },
    context: {
      issue: {},
      comments: [],
      timeline: [],
      pullFiles: scenario.files,
      counts: { comments: 0, timeline: 0, pullFilesTruncated: false },
    },
    git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
    action: { actionTaken: "kept_open" },
    reviewMode: "propose",
    snapshotHash: "synthetic-snapshot",
    contentDigest: "synthetic-content",
    reviewPolicy: "synthetic-policy",
    reviewLeaseOwner: "synthetic-lease",
    reviewLeaseCommentId: 123,
    runtime: { model: "Codex", reasoningEffort: "high" },
  });
  const file = join(output, `${scenario.name}.report.md`);
  writeFileSync(file, report);
  const retained = readFileSync(file, "utf8");
  const comment = renderReviewCommentFromReport(retained, "none");
  const markers = reviewAutomationMarkersFromReport(retained);
  writeFileSync(join(output, `${scenario.name}.comment.md`), comment);
  const observed = {
    storedModel: /^data_model_change: true$/m.test(retained),
    compatibilityBlocker: comment.includes("Add data-model compatibility proof"),
    ready: comment.includes("clawsweeper-review-state:ready"),
    pass: markers.includes("clawsweeper-verdict:pass"),
  };
  const accepted =
    phase === "baseline" ? Boolean(scenario.baselineReady) : Boolean(scenario.negative);
  try {
    assert.deepEqual(
      observed,
      { storedModel: !accepted, compatibilityBlocker: !accepted, ready: accepted, pass: accepted },
      scenario.name,
    );
  } catch {
    failures.push(scenario.name);
  }
  records.push({
    name: scenario.name,
    observed,
    reportSha256: sha(report),
    commentSha256: sha(comment),
  });
}
const receipt = {
  phase,
  failures,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  sourceSha256: sha(readFileSync(join(repo, "src/clawsweeper-change-detection.ts"))),
  fixtureSha256: sha(fixtureBytes),
  replaySha256: sha(readFileSync(new URL(import.meta.url))),
  compiledDetectorSha256: sha(readFileSync(join(repo, "dist/clawsweeper-change-detection.js"))),
  records,
  limits:
    "Real compiled classifier -> report writer -> saved/reloaded report -> comment/readiness/automation owners. Review decision and metadata are synthetic; actual public patch is input data. No reviewer inference, live publication, database upgrade or whole Reporting performance proof.",
};
writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));

if (failures.length) process.exitCode = 1;
