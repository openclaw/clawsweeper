import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import MarkdownIt from "markdown-it";
import { renderReviewCommentFromReport as render } from "../../../dist/clawsweeper.js";
import { parseReviewHistory, renderReviewHistorySection } from "../../../dist/review-history.js";
import { reviewReportFrontMatter, realBehaviorProofReportSection } from "../../../test/helpers.ts";

const root = process.cwd();
const out = path.join(root, ".artifacts/review-revision");
fs.mkdirSync(out, { recursive: true });
const baseline = fs.mkdtempSync(path.join(out, "baseline-"));
const head = "9".repeat(40);
function report(overrides = {}) {
  return `${reviewReportFrontMatter({ type: "pull_request", number: "101", decision: "keep_open", close_reason: "none", review_status: "complete", confidence: "high", author: "contributor", author_association: "CONTRIBUTOR", labels: "[]", work_candidate: "none", pull_head_sha: head, reviewed_at: "2026-06-24T12:00:00.000Z", ...overrides })}

## Summary

Synthetic cache rebuild review.

## What This Changes

Repairs a synthetic cache invalidation defect.

${realBehaviorProofReportSection({ summary: "Synthetic fixture for renderer verification." })}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;
}
const prior = [
  "Codex review: needs changes before merge.",
  "<!-- clawsweeper-verdict:needs-changes item=101 sha=abc1234def confidence=high updated_at=2026-06-20T09:00:00Z reviewed_at=2026-06-20T10:00:00.000Z source_revision=feedbead -->",
  "<!-- clawsweeper-review item=101 -->",
].join("\n");
const options = { prStatusKind: "ready_for_maintainer_look", previousReviewCommentBody: prior };
let before;
try {
  fs.cpSync(path.join(root, "dist"), path.join(baseline, "dist"), {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });
  for (const name of ["package.json", "node_modules", "config", "schema", "docs", "prompts"])
    if (fs.existsSync(path.join(root, name)))
      fs.symlinkSync(path.join(root, name), path.join(baseline, name));
  for (const name of [
    "clawsweeper-report-comment-helpers",
    "clawsweeper-report-comment-presentation",
  ]) {
    const source = execFileSync("git", ["show", `origin/main:src/${name}.ts`], {
      encoding: "utf8",
    });
    fs.writeFileSync(path.join(baseline, "dist", name + ".js"), stripTypeScriptTypes(source));
  }
  const baselineModule = await import(
    pathToFileURL(path.join(baseline, "dist/clawsweeper.js")).href
  );
  before = baselineModule.renderReviewCommentFromReport(report(), "none", options);
} finally {
  fs.rmSync(baseline, { recursive: true, force: true });
}
const after = render(report(), "none", options);
const first = render(report(), "none");
const resynced = render(report(), "none", { previousReviewCommentBody: after });
const third = render(
  report({ reviewed_at: "2026-06-26T12:00:00.000Z", pull_head_sha: "7".repeat(40) }),
  "none",
  { previousReviewCommentBody: after },
);
const issue = render(report({ type: "issue", number: "55" }), "none", options);
const capped = render(report(), "none", {
  previousReviewCommentBody:
    prior +
    "\n" +
    renderReviewHistorySection({
      cycles: [
        {
          reviewedAt: "2026-06-18T08:00:00.000Z",
          sha: "aaaaaaa",
          verdict: "needs changes before merge.",
          findings: [],
        },
      ],
      totalCompletedCycles: 50,
    }),
});
assert.doesNotMatch(before.split("\n")[0], /Revision/);
assert.match(after.split("\n")[0], /Revision 2/);
assert.doesNotMatch(first.split("\n")[0], /Revision/);
assert.match(resynced.split("\n")[0], /Revision 2/);
assert.match(third.split("\n")[0], /Revision 3/);
assert.doesNotMatch(issue.split("\n")[0], /Revision/);
assert.match(capped.split("\n")[0], /Revision 52/);
assert.deepEqual(parseReviewHistory(before), parseReviewHistory(after));
const observations = Object.fromEntries(
  Object.entries({ before, after, first, resynced, third, issue, capped }).map(([name, text]) => [
    name,
    text.split("\n")[0],
  ]),
);
fs.writeFileSync(path.join(out, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
const md = new MarkdownIt({ html: true });
for (const [name, text] of Object.entries({ before, after })) {
  fs.writeFileSync(path.join(out, name + ".md"), text);
  fs.writeFileSync(
    path.join(out, name + ".html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Review revision — ${name}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2328;background:#f6f8fa;margin:0;padding:40px}main{max-width:960px;margin:auto}header{color:#59636e;margin-bottom:20px}article{background:white;border:1px solid #d1d9e0;border-radius:8px;padding:24px}h1,h2{line-height:1.25}h1{font-size:24px}h2{font-size:20px;border-bottom:1px solid #d1d9e0;padding-bottom:8px}table{border-collapse:collapse}td,th{border:1px solid #d1d9e0;padding:6px}details{margin:16px 0}p:first-child{margin-top:0}a{color:#0969da}</style><main><header><strong>Synthetic ClawSweeper review · ${name}</strong></header><article>${md.render(text)}</article></main></html>`,
  );
}
console.log(JSON.stringify(observations, null, 2));
if (process.argv.includes("--serve")) {
  const server = createServer((req, res) => {
    const names = { "/before.html": "before.html", "/after.html": "after.html" };
    const name = names[req.url];
    if (!name) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fs.readFileSync(path.join(out, name)));
  });
  server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(out, "url.txt"), url);
    console.log(url);
  });
}
