#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nodeBin = process.execPath;
const realGh = execFileSync("which", ["gh"], { encoding: "utf8" }).trim();
const { renderReviewCommentFromReport } = await import(
  new URL("../dist/clawsweeper.js", import.meta.url)
);

const scenarios = [
  {
    name: "85630-71465",
    source: 85630,
    covering: 71465,
    expectedAction: "skipped_pr_close_coverage_proof",
    relationship: "Superseded by https://github.com/openclaw/openclaw/pull/71465",
    reportSummary:
      "PR A proposes embedded-run restart drain behavior that the existing merged restart-drain PR does not prove for the remaining embedded-run path.",
    closeComment:
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/71465.",
  },
  {
    name: "85448-80751",
    source: 85448,
    covering: 80751,
    expectedAction: "skipped_pr_close_coverage_proof",
    relationship: "Superseded by https://github.com/openclaw/openclaw/pull/80751",
    reportSummary:
      "PR A covers the remaining Ollama managed-proxy loopback transport gap; PR B is the exact-origin SSRF trust fix and does not carry that transport bypass.",
    closeComment:
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/80751.",
  },
  {
    name: "85448-85707",
    source: 85448,
    covering: 85707,
    expectedAction: "closed",
    relationship:
      "Replacement for https://github.com/openclaw/openclaw/pull/85448 is https://github.com/openclaw/openclaw/pull/85707",
    reportSummary:
      "PR A covers the Ollama managed-proxy loopback transport gap, and PR B is the replacement PR carrying that same loopback embeddings bypass work.",
    closeComment:
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/85707.",
  },
];

const runRoot = mkdtempSync(join(tmpdir(), "clawsweeper-pr-close-coverage-proof."));
const wrapperPath = join(runRoot, "gh-wrapper.mjs");
const syntheticComments = {};

for (const scenario of scenarios) {
  const sourceIssue = ghJson(["api", `repos/openclaw/openclaw/issues/${scenario.source}`]);
  const scenarioDir = join(runRoot, scenario.name);
  const itemsDir = join(scenarioDir, "items");
  const closedDir = join(scenarioDir, "closed");
  const plansDir = join(scenarioDir, "plans");
  mkdirSync(itemsDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  mkdirSync(plansDir, { recursive: true });

  let report = reportMarkdown({
    scenario,
    title: sourceIssue.title,
    url: sourceIssue.html_url,
    createdAt: sourceIssue.created_at,
    updatedAt: sourceIssue.updated_at,
  });
  const reviewComment = markedReviewComment(
    scenario.source,
    renderReviewCommentFromReport(report, "duplicate_or_superseded"),
  );
  report = report.replace(
    /^---\n/,
    [
      "---",
      `review_comment_sha256: ${sha256(reviewComment)}`,
      `review_comment_id: ${9000 + scenario.source}`,
      `review_comment_url: https://github.com/openclaw/openclaw/pull/${scenario.source}#issuecomment-${9000 + scenario.source}`,
      "review_comment_synced_at: 2026-05-27T00:00:00Z",
      "",
    ].join("\n"),
  );
  syntheticComments[scenario.source] = reviewComment;
  writeFileSync(join(itemsDir, `${scenario.source}.md`), report, "utf8");
}

writeFileSync(
  wrapperPath,
  `#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const realGh = ${JSON.stringify(realGh)};
const syntheticComments = ${JSON.stringify(syntheticComments)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;

function passThrough() {
  process.stdout.write(execFileSync(realGh, rawArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
}

function realJson(callArgs) {
  return JSON.parse(execFileSync(realGh, callArgs, { encoding: "utf8" }));
}

if (args[0] === "api") {
  const apiPath = args[1] || "";
  const issueMatch = apiPath.match(/repos\\/openclaw\\/openclaw\\/issues\\/(\\d+)$/);
  if (issueMatch && syntheticComments[issueMatch[1]]) {
    const issue = realJson(["api", apiPath]);
    process.stdout.write(JSON.stringify({
      ...issue,
      state: "open",
      closed_at: null,
      labels: Array.isArray(issue.labels)
        ? issue.labels.map((label) => typeof label === "string" ? label : label?.name).filter(Boolean)
        : [],
      comments: Number(issue.comments || 0) + 1,
    }));
    process.exit(0);
  }
  const pullMatch = apiPath.match(/repos\\/openclaw\\/openclaw\\/pulls\\/(\\d+)$/);
  if (pullMatch && syntheticComments[pullMatch[1]]) {
    const pull = realJson(["api", apiPath]);
    process.stdout.write(JSON.stringify({
      ...pull,
      state: "open",
      merged_at: null,
      closed_at: null,
    }));
    process.exit(0);
  }
  const commentsMatch = apiPath.match(/repos\\/openclaw\\/openclaw\\/issues\\/(\\d+)\\/comments(?:\\?|$)/);
  if (commentsMatch && syntheticComments[commentsMatch[1]]) {
    const comments = realJson(["api", apiPath]);
    const nextComments = [
      {
        id: 9000 + Number(commentsMatch[1]),
        html_url: "https://github.com/openclaw/openclaw/pull/" + commentsMatch[1] + "#issuecomment-" + (9000 + Number(commentsMatch[1])),
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T00:00:00Z",
        user: { login: "clawsweeper[bot]" },
        body: syntheticComments[commentsMatch[1]],
      },
      ...comments,
    ];
    process.stdout.write(JSON.stringify(rawArgs.includes("--slurp") ? [nextComments] : nextComments));
    process.exit(0);
  }
}

if (args[0] === "pr" && args[1] === "close") {
  throw new Error("smoke wrapper blocked live pr close: " + JSON.stringify(rawArgs));
}

if (args[0] === "api") {
  const methodIndex = args.indexOf("--method");
  const shortMethodIndex = args.indexOf("-X");
  const method =
    (methodIndex >= 0 ? args[methodIndex + 1] : undefined) ??
    (shortMethodIndex >= 0 ? args[shortMethodIndex + 1] : undefined) ??
    "GET";
  if (method.toUpperCase() !== "GET" || args.includes("--input")) {
    throw new Error("smoke wrapper blocked live gh api mutation: " + JSON.stringify(rawArgs));
  }
}

passThrough();
`,
  { mode: 0o755 },
);

const results = [];
for (const scenario of scenarios) {
  const scenarioDir = join(runRoot, scenario.name);
  const reportPath = join(scenarioDir, "apply-report.json");
  const apply = spawnSync(
    nodeBin,
    [
      "dist/clawsweeper.js",
      "apply-decisions",
      "--target-repo",
      "openclaw/openclaw",
      "--items-dir",
      join(scenarioDir, "items"),
      "--closed-dir",
      join(scenarioDir, "closed"),
      "--plans-dir",
      join(scenarioDir, "plans"),
      "--report-path",
      reportPath,
      "--artifact-dir",
      join(scenarioDir, "artifacts"),
      "--dry-run",
      "--item-number",
      String(scenario.source),
      "--apply-kind",
      "all",
      "--apply-close-reasons",
      "duplicate_or_superseded",
      "--processed-limit",
      "3",
      "--limit",
      "1",
      "--close-delay-ms",
      "0",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_BIN: nodeBin,
        GH_BIN_ARGS: JSON.stringify([wrapperPath]),
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 900_000,
    },
  );
  if (apply.status !== 0) {
    throw new Error(
      `${scenario.name} apply failed with exit ${apply.status ?? "unknown"}\n${apply.stderr}\n${apply.stdout}`,
    );
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const action = report.find((entry) => entry.number === scenario.source)?.action ?? "missing";
  const proofPath = join(
    scenarioDir,
    "artifacts",
    "pr-close-coverage-proof",
    `${scenario.source}-${scenario.covering}.json`,
  );
  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  if (action !== scenario.expectedAction) {
    throw new Error(`${scenario.name} expected ${scenario.expectedAction}, got ${action}`);
  }
  results.push({
    scenario: scenario.name,
    action,
    proofDecision: proof.decision,
    proofReason: proof.reason,
    reportPath,
    proofPath,
    promptPath: proofPath.replace(/\.json$/, ".prompt.md"),
  });
}

console.log(JSON.stringify({ runRoot, results }, null, 2));

function ghJson(args) {
  return JSON.parse(execFileSync(realGh, args, { encoding: "utf8" }));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function markedReviewComment(number, body) {
  return `${body.trimEnd()}\n\n<!-- clawsweeper-review item=${number} -->`;
}

function reportMarkdown({ scenario, title, url, createdAt, updatedAt }) {
  return `---
number: ${scenario.source}
repository: openclaw/openclaw
type: pull_request
title: ${JSON.stringify(title)}
url: ${url}
state_at_review: open
item_created_at: ${createdAt}
item_updated_at: ${updatedAt}
author: contributor
author_association: CONTRIBUTOR
labels: []
decision: close
close_reason: duplicate_or_superseded
confidence: high
action_taken: proposed_close
work_candidate: none
work_status: none
local_checkout_access: verified
item_snapshot_hash: smoke-${scenario.name}
review_status: complete
reviewed_at: 2026-05-27T00:00:00Z
work_cluster_refs: ${JSON.stringify([scenario.relationship])}
---

## Summary

Smoke report for ${scenario.source} -> ${scenario.covering}.

## Best Possible Solution

${scenario.relationship}

## Evidence

- **source report:** ${scenario.reportSummary}
- **candidate signal:** ${scenario.relationship}

## Close Comment

${scenario.closeComment}
`;
}
