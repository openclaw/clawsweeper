import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";
import { codexFailureDecisionForTest, parseDecision } from "../dist/clawsweeper.js";
import * as document from "../dist/clawsweeper-report-document.js";
import { oversizedPullRequestDecision } from "../dist/clawsweeper-oversized-pr-policy.js";
import { readReviewRecord } from "../dist/review-record.js";
import {
  createReviewRecordBackfill,
  writeReviewRecordBackfills,
} from "../dist/review-record-backfill.js";
import { sha256 } from "../dist/content-hash.js";
import { defaultAgentsPolicyStatus } from "../dist/clawsweeper-report-parser.js";
import type { Decision } from "../src/clawsweeper-types.ts";
import {
  closeDecision,
  item,
  lowSignalCloseReport,
  tmpPrefix,
  withReviewRecord,
} from "./helpers.ts";

const pullRequest = item({ kind: "pull_request", number: 42 });
const { backfillReviewRecord } = createReviewRecordBackfill(document);

// A report from before review_record existed: the current writer without the record line.
function legacyReport(decision: Decision, subject = pullRequest): string {
  const markdown = document.markdownFor({
    item: subject,
    decision,
    context: { issue: {}, comments: [], timeline: [] },
    git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
    action: { actionTaken: "kept_open" },
    reviewMode: "propose",
    snapshotHash: "synthetic-snapshot",
    contentDigest: "synthetic-content",
    reviewPolicy: "synthetic-policy",
    runtime: { model: "Codex", reasoningEffort: "high" },
  } as Parameters<typeof document.markdownFor>[0]);
  return markdown.replace(/^review_record: .*\n/m, "");
}

// The report cannot tell an absent optional field from its empty value.
const OPTIONAL_FIELDS = [
  "fixedRelease",
  "fixedSha",
  "fixedAt",
  "fixedPullRequest",
  "regressionAssessment",
  "regressionProvenance",
  "checkoutInspectionFailed",
  "codexTerminalFailure",
];
function withoutEmptyOptionalFields(decision: Decision): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(JSON.parse(JSON.stringify(decision)) as Record<string, unknown>).filter(
      ([key, value]) => !OPTIONAL_FIELDS.includes(key) || (value !== null && value !== false),
    ),
  );
}

test("the backfill makes the same typed decision from a report the review wrote", () => {
  const model = parseDecision(
    closeDecision({ decision: "keep_open", closeReason: "none", risks: ["One open risk."] }),
    pullRequest,
  );
  const size = {
    threshold: 5000,
    additions: 9000,
    deletions: 10,
    changedFiles: 40,
    head: "d".repeat(40),
  };
  for (const [name, decision] of [
    ["model review", { ...model, localCheckoutAccess: "verified" } as Decision],
    ["failed review", codexFailureDecisionForTest(1, "Codex failed <stdin>", "## out", "err")],
    ["oversized pull request", oversizedPullRequestDecision(size)],
  ] as const) {
    const result = backfillReviewRecord(legacyReport(decision));
    assert.equal(result.status, "lossless", `${name}: ${JSON.stringify(result)}`);
    assert.ok("markdown" in result);
    const record = readReviewRecord(result.markdown);
    assert.equal(record?.origin, "backfill", name);
    assert.deepEqual(
      withoutEmptyOptionalFields(record!.decision),
      withoutEmptyOptionalFields({
        ...decision,
        // The report shows owners as the runner publishes them, and its Close Comment
        // section holds the comment that apply posts: none for a kept-open report.
        likelyOwners: record!.decision.likelyOwners,
        closeComment: "",
      } as Decision),
      name,
    );
  }
});

test("the backfill names the decision fields that the report lost", () => {
  const legacy = legacyReport(
    parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), pullRequest),
  );
  // The evidence reader keeps no "note" line.
  const report = legacy.replace(
    "\n  - repo: openclaw/openclaw\n",
    "\n  - repo: openclaw/openclaw\n  - note: kept by an older writer\n",
  );
  assert.notEqual(report, legacy);
  const result = backfillReviewRecord(report);
  assert.equal(result.status, "lossy");
  assert.ok("differences" in result);
  assert.deepEqual(
    result.differences.map(({ field, kind }) => [field, kind]),
    [["## Evidence", "changed"]],
  );
});

test("a report that predates a decision field is filled, not lossy", () => {
  const legacy = legacyReport(
    parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), pullRequest),
  );
  const report = legacy.replace(/^product_kind: .*\n/m, "");
  assert.notEqual(report, legacy);
  const result = backfillReviewRecord(report);
  assert.equal(result.status, "filled", JSON.stringify(result));
  assert.ok("differences" in result);
  assert.deepEqual(
    result.differences.map(({ field, kind }) => [field, kind]),
    [["product_kind", "filled"]],
  );
});

function differenceKinds(report: string): string[][] {
  const result = backfillReviewRecord(report);
  assert.ok("differences" in result, JSON.stringify(result));
  return result.differences.map(({ field, kind }) => [field, kind]);
}

function recordDecision(report: string): Decision {
  const result = backfillReviewRecord(report);
  assert.ok("markdown" in result, JSON.stringify(result));
  return readReviewRecord(result.markdown)!.decision;
}

test("review_status is host lifecycle state, not a compared decision field", () => {
  const legacy = legacyReport(
    parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), pullRequest),
  );
  const report = legacy.replace(/^review_status: .*$/m, "review_status: stale_reopened");
  assert.notEqual(report, legacy);
  assert.deepEqual(differenceKinds(report), []);
  assert.equal(backfillReviewRecord(report).status, "lossless");
});

test("differences that only the current renderer makes keep a report lossless", () => {
  const legacy = legacyReport(
    parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), pullRequest),
  );
  const owners = legacy.match(/\n## Likely Related People\n\n([\s\S]*?)\n\n## /)![1]!;
  const report = legacy
    // Older evidence entries have no repo line.
    .replaceAll("\n  - repo: openclaw/openclaw", "")
    // Older testing reviews counted the added test files.
    .replace("\n\nMissing E2E:", "\n\nAdded test files: 3\n\nMissing E2E:")
    // Older reports showed the model-named owner before the public attribution policy.
    .replace(
      owners,
      [
        "- **alice:** introduced behavior",
        "  - reason: git blame points the relevant implementation line at abcdef1234567890.",
        "  - confidence: high",
        "  - commits: abcdef1234567890",
        "  - files: src/example.ts",
      ].join("\n"),
    );
  assert.deepEqual(differenceKinds(report), [
    ["## Testing Review", "rendered"],
    ["## Evidence", "rendered"],
    ["## Likely Related People", "rendered"],
  ]);
  assert.equal(backfillReviewRecord(report).status, "lossless");
  const decision = recordDecision(report);
  assert.ok(decision.evidence.every((entry) => entry.repo === "openclaw/openclaw"));
  assert.equal(decision.likelyOwners[0]?.person, "alice");
  assert.equal(decision.likelyOwners[0]?.role, "unverified routing candidate");

  // An owner line that the reader does not keep is lost, not rendered.
  const lost = report.replace(
    "  - files: src/example.ts",
    "  - files: src/example.ts\n  - note: x",
  );
  assert.deepEqual(differenceKinds(lost).at(-1), ["## Likely Related People", "changed"]);
});

test("a section older than the front matter that it restates is not lossy", () => {
  const legacy = legacyReport(
    parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), pullRequest),
  );
  // A host promotion rewrote decision and work_candidate but not the sections.
  const report = legacy
    .replace(
      /\n## Decision\n\nKeep open: [^\n]*/,
      "\n## Decision\n\nClose: duplicate or superseded",
    )
    .replace("Candidate: none", "Candidate: manual_review")
    .replace("Priority: low\n\nStatus: none", "Priority: low\n\nStatus: manual_review");
  assert.deepEqual(differenceKinds(report), [
    ["## Decision", "rendered"],
    ["## Work Candidate", "rendered"],
  ]);
  assert.equal(recordDecision(report).workCandidate, "none");
});

test("stored JSON text keeps the report lossless once the review parser makes it safe", () => {
  const legacy = legacyReport(
    parseDecision(
      closeDecision({
        decision: "keep_open",
        closeReason: "none",
        impactLabels: ["impact:ux-friction"],
        labelJustifications: [
          { label: "P2", reason: "Normal priority for `agent:<id>` routing." },
          { label: "impact:ux-friction", reason: "Users retry the command." },
        ],
      }),
      pullRequest,
    ),
  );
  const line = legacy.match(/^label_justifications: .*$/m)![0];
  assert.ok(line.includes("agent:&lt;id>"));
  // An older review stored the text before the parser escaped it, in another order.
  const [p2, impact] = JSON.parse(line.slice("label_justifications: ".length));
  const older = (entries: unknown[]) =>
    `label_justifications: ${JSON.stringify(entries).replace("&lt;", "<")}`;
  assert.deepEqual(differenceKinds(legacy.replace(line, older([impact, p2]))), [
    ["label_justifications", "rendered"],
  ]);
  // A selected label without a stored justification gets the default reason.
  assert.deepEqual(differenceKinds(legacy.replace(line, older([p2]))), [
    ["label_justifications", "filled"],
    ["## Label Justifications", "rendered"],
  ]);
});

test("a security concern without a line keeps its file", () => {
  const concern = {
    title: "Shared lockout enables remote denial of service",
    body: "Any remote client could consume the shared failure budget.",
    severity: "medium",
    confidenceScore: 0.8,
    file: "src/gateway/auth-rate-limit.ts",
    line: null,
  };
  const report = legacyReport(
    parseDecision(
      closeDecision({
        decision: "keep_open",
        closeReason: "none",
        securityReview: {
          status: "needs_attention",
          summary: "The lockout needs explicit operator intent.",
          concerns: [concern],
        },
      }),
      pullRequest,
    ),
  );
  assert.ok(report.includes(":** `src/gateway/auth-rate-limit.ts`\n"));
  assert.equal(backfillReviewRecord(report).status, "lossless");
  assert.deepEqual(recordDecision(report).securityReview.concerns, [concern]);
});

test("the record keeps the proof assessment of a maintainer-authored pull request", () => {
  const member = item({
    kind: "pull_request",
    number: 43,
    url: "https://github.com/openclaw/openclaw/pull/43",
    author: "steipete",
    authorAssociation: "MEMBER",
    // A label is host state: readers apply proof: override, the record does not.
    labels: ["proof: override"],
  });
  const proof = {
    status: "insufficient",
    summary: "Unit tests only; no observed Telegram draft after enabling the setting.",
    evidenceKind: "none",
    needsContributorAction: true,
  } as const;
  const report = legacyReport(
    parseDecision(
      closeDecision({ decision: "keep_open", closeReason: "none", realBehaviorProof: proof }),
      member,
    ),
    member,
  );
  assert.equal(backfillReviewRecord(report).status, "lossless");
  assert.deepEqual(recordDecision(report).realBehaviorProof, proof);
});

test("the record keeps a verified or suspected regression provenance", () => {
  const sha = (digit: string) => digit.repeat(40);
  const verified = {
    repo: "openclaw/openclaw",
    pullRequestNumber: 118866,
    pullRequestUrl: "https://github.com/openclaw/openclaw/pull/118866",
    mergeCommitSha: sha("1"),
    sourcePath: "ui/src/e2e/control-ui-auth-transports.e2e.test.ts",
    sourceLine: 531,
    verificationSource: "raw_parent_line_v1",
    evidenceType: "blame_to_merge_commit",
    mergedAt: "2026-08-04T00:16:22Z",
    reviewedCommitSha: sha("2"),
    sourceCommitSha: sha("1"),
    sourceAuthor: "Sarah Fortune",
  };
  const suspected = {
    verificationSource: "raw_parent_line_v1",
    evidenceType: "source_line",
    sourceCommitSha: sha("3"),
    sourceAuthor: "Josh Avant",
    sourcePath: "src/auto-reply/reply/reply-admission-ticket.ts",
    sourceLine: 19,
    relatedPullRequestNumber: null,
    relatedPullRequestUrl: null,
    relatedRepo: null,
  };
  const model = parseDecision(
    closeDecision({ decision: "keep_open", closeReason: "none" }),
    pullRequest,
  );
  for (const regressionProvenance of [verified, suspected]) {
    const report = legacyReport({ ...model, regressionProvenance } as Decision);
    assert.equal(
      backfillReviewRecord(report).status,
      "lossless",
      regressionProvenance.evidenceType,
    );
    assert.deepEqual(recordDecision(report).regressionProvenance, regressionProvenance);
  }
});

test("a report without an AGENTS.md policy status gets the default status", () => {
  const legacy = legacyReport(
    parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), pullRequest),
  );
  const report = legacy
    .replace(/^agents_policy_status: .*\n/m, "")
    .replace(/\n## AGENTS\.md Policy Status\n\n[\s\S]*?\n\n(?=## )/, "\n");
  assert.deepEqual(differenceKinds(report), [
    ["agents_policy_status", "filled"],
    ["## AGENTS.md Policy Status", "filled"],
  ]);
  assert.deepEqual(recordDecision(report).agentsPolicyStatus, defaultAgentsPolicyStatus());
});

test("an empty risk item reads back", () => {
  const legacy = legacyReport(
    parseDecision(
      closeDecision({ decision: "keep_open", closeReason: "none", risks: ["One open risk."] }),
      pullRequest,
    ),
  );
  const report = legacy.replace("- One open risk.\n", "- One open risk.\n-\n");
  assert.notEqual(report, legacy);
  assert.equal(backfillReviewRecord(report).status, "lossless");
  assert.deepEqual(recordDecision(report).risks, ["One open risk.", ""]);
});

test("the backfill leaves typed reports and reports it cannot read", () => {
  const typed = withReviewRecord(lowSignalCloseReport({ number: 7 }));
  assert.deepEqual(backfillReviewRecord(typed), { status: "typed" });
  const invalid = typed.replace(/^review_record: \{/m, "review_record: [");
  assert.equal(backfillReviewRecord(invalid).status, "invalid_record");
  const unparseable = backfillReviewRecord(
    lowSignalCloseReport({ number: 8 }).replace(/^decision: .*\n/m, ""),
  );
  assert.deepEqual(unparseable, { status: "unparseable", reason: "front matter has no decision" });
});

test("backfill-review-records reports counts for a records directory and writes nothing", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const recordsDir = join(root, "records", "openclaw-openclaw");
    for (const section of ["items", "closed"])
      mkdirSync(join(recordsDir, section), { recursive: true });
    const typed = withReviewRecord(lowSignalCloseReport({ number: 7 }));
    const unparseable = lowSignalCloseReport({ number: 8 }).replace(/^decision: .*\n/m, "");
    writeFileSync(join(recordsDir, "items", "7.md"), typed);
    writeFileSync(join(recordsDir, "closed", "8.md"), unparseable);
    const output = join(root, "backfill.json");
    execFileSync(process.execPath, [
      "dist/clawsweeper.js",
      "backfill-review-records",
      "--records-dir",
      recordsDir,
      "--output",
      output,
    ]);
    const summary = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.counts, {
      typed: 1,
      invalid_record: 0,
      unparseable: 1,
      lossless: 0,
      filled: 0,
      lossy: 0,
    });
    assert.deepEqual(summary.reasons, { "front matter has no decision": 1 });
    assert.deepEqual(summary.examples, { typed: ["items/7.md"], unparseable: ["closed/8.md"] });
    assert.equal(readFileSync(join(recordsDir, "items", "7.md"), "utf8"), typed);
    assert.equal(readFileSync(join(recordsDir, "closed", "8.md"), "utf8"), unparseable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runBackfill(recordsDir: string, output: string, extra: string[]) {
  execFileSync(process.execPath, [
    "dist/clawsweeper.js",
    "backfill-review-records",
    "--records-dir",
    recordsDir,
    "--output",
    output,
    ...extra,
  ]);
  return JSON.parse(readFileSync(output, "utf8"));
}

test("backfill-review-records --write adds the record to lossless and filled reports only, once", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const recordsDir = join(root, "records", "openclaw-openclaw");
    for (const section of ["items", "closed"])
      mkdirSync(join(recordsDir, section), { recursive: true });
    const reportFor = (number: number) => {
      const subject = item({ kind: "pull_request", number });
      return legacyReport(
        parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), subject),
        subject,
      );
    };
    const reports: Record<string, string> = {
      "items/11.md": reportFor(11),
      "closed/12.md": reportFor(12).replace(/^product_kind: .*\n/m, ""),
      "items/13.md": reportFor(13).replace(
        "\n  - repo: openclaw/openclaw\n",
        "\n  - repo: openclaw/openclaw\n  - note: kept by an older writer\n",
      ),
      "items/7.md": withReviewRecord(lowSignalCloseReport({ number: 7 })),
      "closed/8.md": lowSignalCloseReport({ number: 8 }).replace(/^decision: .*\n/m, ""),
      "items/9.md": withReviewRecord(lowSignalCloseReport({ number: 9 })).replace(
        /^review_record: \{/m,
        "review_record: [",
      ),
    };
    for (const [path, markdown] of Object.entries(reports)) {
      writeFileSync(join(recordsDir, path), markdown);
    }
    const statuses = Object.fromEntries(
      Object.entries(reports).map(([path, markdown]) => [
        path,
        backfillReviewRecord(markdown).status,
      ]),
    );
    assert.deepEqual(statuses, {
      "items/11.md": "lossless",
      "closed/12.md": "filled",
      "items/13.md": "lossy",
      "items/7.md": "typed",
      "closed/8.md": "unparseable",
      "items/9.md": "invalid_record",
    });

    // A limited run writes part of the reports; the next run writes the rest.
    const first = runBackfill(recordsDir, join(root, "first.json"), [
      "--write",
      "--limit",
      "1",
      "--canonical-record-baseline-dir",
      join(root, "baseline-1"),
    ]);
    assert.equal(first.written, 1);
    assert.deepEqual(first.changedRecordFiles, ["11.md"]);
    const second = runBackfill(recordsDir, join(root, "second.json"), [
      "--write",
      "--canonical-record-baseline-dir",
      join(root, "baseline-2"),
    ]);
    assert.equal(second.counts.typed, 2);
    assert.equal(second.written, 1);
    assert.equal(second.changedSinceClassification, 0);
    assert.deepEqual(second.changedRecordFiles, ["12.md"]);
    // The baseline holds the tuple as it was before the write, for the publication's
    // compare-and-swap.
    assert.equal(
      readFileSync(
        join(root, "baseline-2", "records", "openclaw-openclaw", "closed", "12.md"),
        "utf8",
      ),
      reports["closed/12.md"],
    );

    for (const [path, original] of Object.entries(reports)) {
      const stored = readFileSync(join(recordsDir, path), "utf8");
      if (statuses[path] !== "lossless" && statuses[path] !== "filled") {
        assert.equal(stored, original, path);
        continue;
      }
      const lines = stored.split("\n");
      const added = lines.filter((line) => !original.split("\n").includes(line));
      assert.equal(added.length, 1, path);
      assert.match(added[0]!, /^review_record: \{.*"origin":"backfill"/, path);
      assert.equal(lines.filter((line) => line !== added[0]).join("\n"), original, path);
      const record = readReviewRecord(stored);
      assert.equal(record?.origin, "backfill", path);
      assert.deepEqual(record!.decision, recordDecision(original), path);
      assert.equal(record!.decision.decision, "keep_open", path);
    }

    const after = Object.fromEntries(
      Object.keys(reports).map((path) => [path, readFileSync(join(recordsDir, path), "utf8")]),
    );
    const third = runBackfill(recordsDir, join(root, "third.json"), [
      "--write",
      "--canonical-record-baseline-dir",
      join(root, "baseline-3"),
    ]);
    assert.equal(third.written, 0);
    assert.deepEqual(third.changedRecordFiles, []);
    assert.deepEqual(third.counts, {
      typed: 3,
      invalid_record: 1,
      unparseable: 1,
      lossless: 0,
      filled: 0,
      lossy: 1,
    });
    for (const [path, markdown] of Object.entries(after)) {
      assert.equal(readFileSync(join(recordsDir, path), "utf8"), markdown, path);
    }
    assert.equal(existsSync(join(root, "baseline-3", "records")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the backfill does not write a report that changed after classification", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const recordsDir = join(root, "records", "openclaw-openclaw");
    mkdirSync(join(recordsDir, "items"), { recursive: true });
    const classified = legacyReport(
      parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), pullRequest),
    );
    writeFileSync(join(recordsDir, "items", "42.md"), classified);
    const result = backfillReviewRecord(classified);
    assert.ok("markdown" in result);
    const write = {
      path: "items/42.md",
      classifiedSha256: sha256(classified),
      markdown: result.markdown,
    };
    // A fresh review rewrites the report between classification and the write.
    const reviewed = withReviewRecord(lowSignalCloseReport({ number: 42 }));
    writeFileSync(join(recordsDir, "items", "42.md"), reviewed);

    const baselineDir = join(root, "baseline");
    assert.deepEqual(writeReviewRecordBackfills({ recordsDir, baselineDir, writes: [write] }), {
      changedRecordFiles: [],
      changedSinceClassification: ["items/42.md"],
    });
    assert.equal(readFileSync(join(recordsDir, "items", "42.md"), "utf8"), reviewed);
    assert.equal(existsSync(baselineDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backfill-review-records --write needs a canonical baseline directory", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            "dist/clawsweeper.js",
            "backfill-review-records",
            "--records-dir",
            root,
            "--output",
            join(root, "out.json"),
            "--write",
          ],
          { stdio: "pipe", env: { ...process.env, CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: "" } },
        ),
      /canonical record baseline directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the write job publishes the written tuples with compare-and-swap and keeps a newer review", async () => {
  const workflow = parse(readFileSync(".github/workflows/review-record-backfill.yml", "utf8"));
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, "dry-run");
  assert.equal(workflow.jobs["dry-run"].if, "${{ inputs.mode == 'dry-run' }}");
  assert.equal(workflow.jobs.write.if, "${{ inputs.mode == 'write' }}");
  type Step = { uses?: string; name?: string; run?: string };
  const steps: Step[] = workflow.jobs.write.steps;
  const setupState = steps.findIndex((step) => step.uses === "./.github/actions/setup-state");
  const writeStep = steps.findIndex((step) => step.name === "Write and publish review records");
  assert.ok(setupState >= 0 && setupState < writeStep);
  assert.equal(
    (workflow.jobs["dry-run"].steps as Step[]).some((step) => step.uses?.includes("setup-state")),
    false,
  );

  const root = mkdtempSync(tmpPrefix);
  const recordsDir = join(root, "records", "openclaw-openclaw");
  const reportFor = (number: number) => {
    const subject = item({ kind: "pull_request", number });
    return legacyReport(
      parseDecision(closeDecision({ decision: "keep_open", closeReason: "none" }), subject),
      subject,
    );
  };
  const lossless = reportFor(11);
  // A fresh review rewrites 12 after hydration, so the Worker rejects its tuple.
  const reviewed = withReviewRecord(lowSignalCloseReport({ number: 12 }));
  const lossy = reportFor(13).replace(
    "\n  - repo: openclaw/openclaw\n",
    "\n  - repo: openclaw/openclaw\n  - note: kept by an older writer\n",
  );
  const requests: Array<Record<string, any>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const mutation = JSON.parse(body);
      requests.push({ url: request.url, ...mutation });
      if (mutation.key === "openclaw-openclaw/12") {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error: "canonical_record_tuple_conflict",
            current: {
              key: mutation.key,
              revision: 7,
              deliveryId: null,
              operations: mutation.operations.map((operation: { path: string }) =>
                operation.path.endsWith("/items/12.md")
                  ? {
                      path: operation.path,
                      expectedDigest: sha256(reviewed),
                      contentBase64: Buffer.from(reviewed).toString("base64"),
                    }
                  : { path: operation.path, expectedDigest: null },
              ),
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, revision: requests.length }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    mkdirSync(join(recordsDir, "items"), { recursive: true });
    writeFileSync(join(recordsDir, "items", "11.md"), lossless);
    writeFileSync(join(recordsDir, "items", "12.md"), reportFor(12));
    writeFileSync(join(recordsDir, "items", "13.md"), lossy);
    symlinkSync(resolve("scripts"), join(root, "scripts"));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const { stdout } = await promisify(execFile)(
      "bash",
      [
        "-c",
        [
          // The job runs from the checkout; here the records are in a temporary
          // directory, so node runs the built entry points of this checkout.
          'node() { local script="$1"; shift; command node "$CHECKOUT/$script" "$@"; }',
          'pnpm() { shift 3; node dist/repair/publish-main.js "$@"; }',
          steps[writeStep]!.run!,
        ].join("\n"),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          CLAWSWEEPER_WEBHOOK_SECRET: "secret",
          QUEUE_URL: `http://127.0.0.1:${address.port}`,
          TARGET_REPO: "openclaw/openclaw",
          TARGET_SLUG: "openclaw-openclaw",
          WRITE_LIMIT: "",
          CHECKOUT: process.cwd(),
        },
      },
    );

    const written = readFileSync(join(recordsDir, "items", "11.md"), "utf8");
    assert.equal(readReviewRecord(written)?.origin, "backfill");
    assert.equal(readFileSync(join(recordsDir, "items", "12.md"), "utf8"), reviewed);
    assert.equal(readFileSync(join(recordsDir, "items", "13.md"), "utf8"), lossy);
    assert.match(
      stdout,
      /^written=2 changedSinceClassification=0 skippedByCanonicalCompareAndSwap=1 /m,
    );
    assert.deepEqual(
      requests.map((request) => request.key),
      ["openclaw-openclaw/11", "openclaw-openclaw/12"],
    );
    const [tuple] = requests;
    assert.equal(tuple!.url, "/internal/state/records/tuples");
    assert.match(tuple!.deliveryId, /^record-reconcile:openclaw-openclaw:11:/);
    const operations = Object.fromEntries(
      tuple!.operations.map((operation: Record<string, string | null>) => [
        operation.path,
        operation,
      ]),
    );
    const item11 = operations["records/openclaw-openclaw/items/11.md"];
    assert.equal(item11.expectedDigest, sha256(lossless));
    assert.equal(Buffer.from(item11.contentBase64, "base64").toString("utf8"), written);
    for (const path of [
      "records/openclaw-openclaw/closed/11.md",
      "records/openclaw-openclaw/plans/11.md",
      "records/openclaw-openclaw/decision-packets/11.json",
    ]) {
      assert.deepEqual(operations[path], { path, expectedDigest: null });
    }
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
