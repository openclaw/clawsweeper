import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanAgentInput } from "../../../dist/agent-input-scan.js";
import { TRUFFLEHOG_VERSION } from "../../../dist/review-tool-bootstrap.js";

const [target, baseSha, headSha, output] = process.argv.slice(2);
if (!target || !baseSha || !headSha || !output) {
  throw new Error("Pass target checkout, base SHA, head SHA, and output JSON path.");
}
const report = {
  baseSha,
  headSha,
  scanner: TRUFFLEHOG_VERSION,
  node: process.version,
  platform: process.platform,
  result: "pending",
  notices: [],
  limits:
    "Complete committed source range with a controlled prompt; no model execution. Hosted review must scan its own prompt, schema and source.",
};
const previous = console.error;
try {
  console.error = (value) => {
    const notice = JSON.parse(String(value));
    if (notice.event !== "agent_input_scan_classified") throw new Error("Unexpected scan notice.");
    report.notices.push(notice);
  };
  scanAgentInput({
    cwd: resolve(target),
    prompt: "Read-only CLI version-label review.",
    source: { kind: "committed", baseSha, headSha },
    timeoutMs: 180_000,
  });
  report.result = "admitted";
} catch (error) {
  report.result = "refused";
  report.failure = { reason: error.reason, diagnostic: error.scanDiagnostic };
  process.exitCode = 1;
} finally {
  console.error = previous;
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ result: report.result, notices: report.notices.length }));
