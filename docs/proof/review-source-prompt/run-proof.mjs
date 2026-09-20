import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { reviewPromptForTest } from "../../../dist/clawsweeper.js";
import { scanAgentInput } from "../../../dist/agent-input-scan.js";
const [targetArg, head, mode, output] = process.argv.slice(2);
const target = path.resolve(targetArg);
const base = "d1a550d938cba934d5cf2cd7bd0dc8a06c5da073";
const file = "extensions/github/src/detail-checks.test.ts";
const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
const lines = execFileSync("git", ["show", head + ":" + file], {
  cwd: target,
  encoding: "utf8",
}).split(String.fromCharCode(10));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fixtureLine = lines.find(
  (line) => digest(line) === "9b986f89b4bc448cd97566a1512992e765197fe5be1333cbb79681b1c25d95e4",
);
const literal = fixtureLine ? JSON.parse(fixtureLine.trim().replace(/,$/, "")) : "";
const item = {
  repo: "openclaw/openclaw",
  number: 153274,
  kind: "pull_request",
  title: "Native PR reader and ordinary login links",
  url: "https://github.com/openclaw/openclaw/pull/153274",
  author: "roboclaw-bot",
  authorAssociation: "MEMBER",
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-20T15:58:56Z",
  labels: [],
};
const context = {
  issue: { body: mode === "discussion" ? literal : "Controlled native source-prompt proof." },
  comments: [],
  timeline: [],
  pullRequest: { state: "open", merged: false, base: { sha: base }, head: { sha: head } },
  pullFiles: [
    {
      filename: file,
      status: "added",
      additions: lines.length,
      deletions: 0,
      changes: lines.length,
      patch: git("diff", "--no-ext-diff", "--no-textconv", base, head, "--", file),
    },
  ],
};
const beforeContext = JSON.stringify(context);
const prompt = reviewPromptForTest(
  item,
  context,
  { mainSha: base, latestRelease: null },
  mode === "maintainer" ? literal : "",
  { targetDir: target },
);
const report = {
  head,
  base,
  mode,
  promptSha256: digest(prompt),
  promptChars: prompt.length,
  contextPreserved: JSON.stringify(context) === beforeContext,
  verification: "canonical enabled",
  producer: "production buildReviewPrompt through its exported test entrypoint",
  result: "pending",
  notices: [],
  limits:
    "Controlled captured-source context, no model execution or hosted publication; complete committed source remains independently scanned.",
};
const stderr = console.error;
try {
  console.error = (value) => {
    report.notices.push(JSON.parse(String(value)));
  };
  scanAgentInput({
    cwd: target,
    prompt,
    source: { kind: "committed", baseSha: base, headSha: head },
    timeoutMs: 180000,
  });
  report.result = "admitted";
} catch (error) {
  report.result = "refused";
  report.failure = { reason: error.reason, diagnostic: error.scanDiagnostic };
  process.exitCode = 1;
} finally {
  console.error = stderr;
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + String.fromCharCode(10));
}
console.log(
  JSON.stringify({
    mode,
    result: report.result,
    contextPreserved: report.contextPreserved,
    reason: report.failure?.reason,
    material: report.failure?.diagnostic?.material?.kind,
    output,
  }),
);
