// Runs hydrate-child.mjs against a base and a candidate checkout under the same
// heap cap and writes a receipt.
// Usage: node run-proof.mjs <base-checkout> <candidate-checkout> <receipt.json>
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const [baseCheckout, candidateCheckout, receiptPath] = process.argv.slice(2);
const child = path.join(import.meta.dirname, "hydrate-child.mjs");
const heapMiB = 384;
const records = 2400;
const recordKiB = 512;
const perPage = 4;
const git = (checkout, ...args) =>
  spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).stdout.trim();

function run(label, checkout) {
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${heapMiB}`, child, checkout, records, recordKiB, perPage],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const stdout = result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  let summary = null;
  try {
    summary = JSON.parse(stdout);
  } catch {}
  return {
    label,
    commit: git(checkout, "rev-parse", "HEAD"),
    exitCode: result.status,
    signal: result.signal,
    heapOutOfMemory: /heap out of memory/i.test(result.stderr),
    summary,
    stderrTail: result.stderr.split("\n").filter(Boolean).slice(-3),
  };
}

const receipt = {
  claim:
    "materializeWorkerRecords hydrates a journal delta larger than the heap by writing each export page to disk",
  surface:
    "real scripts/worker-records.ts materializeWorkerRecords (stored snapshot download, journal export, staging, manifest) with a fixture Worker fetch",
  scenario: {
    heapCapMiB: heapMiB,
    deltaRecords: records,
    recordKiB,
    recordsPerPage: perPage,
    journalMiB: Math.round((records * recordKiB) / 1024),
  },
  node: process.version,
  runs: [run("base", baseCheckout), run("candidate", candidateCheckout)],
  limits:
    "synthetic records and fixture Worker responses; production pages are byte-bounded (~2 MiB) by the export route, approximated here by 4 x 512 KiB records per page",
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt.runs.map(({ label, commit, exitCode, heapOutOfMemory, summary }) => ({ label, commit: commit.slice(0, 10), exitCode, heapOutOfMemory, summary })), null, 2));
