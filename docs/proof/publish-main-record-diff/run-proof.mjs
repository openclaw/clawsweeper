// Runs publish-child.mjs against a base and a candidate checkout (both built:
// `pnpm run build:repair`) under the same heap cap and writes a receipt.
// Usage: node run-proof.mjs <base-checkout> <candidate-checkout> <receipt.json>
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const [baseCheckout, candidateCheckout, receiptPath] = process.argv.slice(2);
const child = path.join(import.meta.dirname, "publish-child.mjs");
const heapMiB = 384;
const items = 1600;
const itemKiB = 512;
const git = (checkout, ...args) =>
  spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).stdout.trim();

function run(label, checkout) {
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${heapMiB}`, child, checkout, items, itemKiB],
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
  };
}

const receipt = {
  claim:
    "publish-main finds changed record tuples in a whole records/<repo> request without holding both trees in memory",
  surface:
    "real dist/repair/publish-main.js publishMainWithStateAppend (canonical tuple planning and posting) with a fixture queue fetch",
  scenario: {
    heapCapMiB: heapMiB,
    itemsPerTree: items,
    itemKiB,
    treeMiB: Math.round((items * itemKiB) / 1024),
    changedTuples: "items 1 and 2 updated, item 3 moved to closed/",
  },
  node: process.version,
  runs: [run("base", baseCheckout), run("candidate", candidateCheckout)],
  limits:
    "synthetic records and fixture queue responses; no production records, secrets or GitHub writes",
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    receipt.runs.map(({ label, commit, exitCode, heapOutOfMemory, summary }) => ({
      label,
      commit: commit.slice(0, 10),
      exitCode,
      heapOutOfMemory,
      summary,
    })),
    null,
    2,
  ),
);
