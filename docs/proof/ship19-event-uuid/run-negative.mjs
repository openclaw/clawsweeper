import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanAgentInput } from "../../../dist/agent-input-scan.js";

const [target, baseSha, headSha, output] = process.argv.slice(2);
if (!target || !baseSha || !headSha || !output) throw new Error("Pass target, base, head, output");
// A fresh synthetic candidate cannot be covered by the exact host policy.
// Never print or retain scanner matches, even for this negative control.
const extra = Buffer.from(`privacy ${randomUUID()}\n`);
const notices = [];
const previous = console.error;
const report = { base: baseSha, targetHead: headSha, result: "unexpected_admission", reason: null, notices };
try {
  console.error = (value) => notices.push(JSON.parse(String(value)));
  scanAgentInput({ cwd: resolve(target), prompt: "Read-only scan negative control.", source: { kind: "committed", baseSha, headSha }, additionalBytes: [extra], timeoutMs: 180_000 });
  process.exitCode = 1;
} catch (error) {
  report.reason = error.reason;
  report.result = error.reason === "findings" ? "refused_unknown_candidate" : "unexpected_failure";
  if (error.reason !== "findings") process.exitCode = 1;
} finally {
  console.error = previous;
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ result: report.result, output }));
