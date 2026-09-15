import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanAgentInput } from "../../../dist/agent-input-scan.js";

const [target, baseSha, headSha, output] = process.argv.slice(2);
if (!target || !baseSha || !headSha || !output) {
  throw new Error("Pass target checkout, base SHA, head SHA, and output JSON path");
}
const notices = [];
const stderr = console.error;
const started = Date.now();
const report = {
  targetHead: headSha,
  base: baseSha,
  source: "complete committed range, controlled prompt, canonical pinned native scanner",
  limits:
    "No model execution; hosted review must rescan its own prompt, schema, and source inputs.",
  verification: "canonical enabled",
  result: "pending",
  elapsedMs: 0,
  notices,
};
try {
  console.error = (value) => {
    const notice = JSON.parse(String(value));
    if (notice.event !== "agent_input_scan_classified") throw new Error("unexpected scan notice");
    notices.push(notice);
  };
  scanAgentInput({
    cwd: resolve(target),
    prompt: "Read-only browser lifecycle code review. No additional source excerpts.",
    source: { kind: "committed", baseSha, headSha },
    timeoutMs: 180_000,
  });
  report.result = "admitted";
} catch (error) {
  report.result = "refused";
  report.failure = { reason: error.reason, diagnostic: error.scanDiagnostic };
  process.exitCode = 1;
} finally {
  console.error = stderr;
  report.elapsedMs = Date.now() - started;
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(
  JSON.stringify({
    result: report.result,
    elapsedMs: report.elapsedMs,
    notices: notices.length,
    output,
  }),
);
