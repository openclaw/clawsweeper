import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseDecision } from "../dist/clawsweeper.js";
import { closeDecision } from "../test/helpers.ts";
import {
  assertMatchesJsonSchema,
  runWithWithheldDiagnostics,
} from "./hosted-review-canary-proof.mjs";

const [baselinePath, candidatePath, outputPath] = process.argv.slice(2);
assert.ok(
  baselinePath && candidatePath && outputPath,
  "expected baseline, candidate and receipt paths",
);
const schemaText = readFileSync("schema/clawsweeper-decision.schema.json", "utf8");
const schema = JSON.parse(schemaText).properties.evidence.items;
runWithWithheldDiagnostics("Evidence schema proof failed; captured output withheld.", () => {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
  const parse = (evidence) => parseDecision(closeDecision({ evidence: [evidence] }));
  assert.match(baseline.command, /[\r\n\u2028\u2029]/);
  assert.throws(() => parse(baseline), /command must be a single-line string/);
  assertMatchesJsonSchema(candidate, schema);
  assert.equal(candidate.command, null);
  assert.ok(candidate.detail.includes(baseline.command));
  assert.equal(parse(candidate).evidence[0].command, null);
});
const receipt = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  working_tree_dirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  ),
  node: process.version,
  schema_sha256: createHash("sha256").update(schemaText).digest("hex"),
  baseline_parser: "rejected_multiline_command",
  candidate_parser: "accepted",
  exact_command_preserved_in_detail: true,
  limits:
    "Validates evidence captured from the live strict-schema API probe inside synthetic decisions. Does not review a real repository or mutate GitHub.",
};
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
