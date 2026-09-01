import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
const [baselineDir, candidateDir, output] = process.argv.slice(2);
const step = (dir) =>
  YAML.parse(readFileSync(`${dir}/.github/workflows/sweep.yml`, "utf8")).jobs[
    "event-review-apply"
  ].steps.find((s) => s.name === "Fail unsuccessful exact review generation");
const before = step(baselineDir),
  after = step(candidateDir);
assert.equal(after.if, before.if, "the failure gate must be byte-identical");
function evaluate(template, values) {
  const expression = template
    .replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "")
    .replace(/\balways\(\)/g, "true")
    .replace(/steps\.([a-z0-9-]+)\.(outputs\.([a-z0-9_]+)|outcome)/g, (_m, id, access, out) =>
      JSON.stringify(values[`${id}.${out ?? access}`] ?? ""),
    );
  return Function(`"use strict"; return (${expression});`)();
}
const assertions = [];
let truthTableCases = 0;
for (let mask = 0; mask < 256; mask++) {
  const [claimed, accepted, completed, superseded, held, itemSuperseded, generated, deferred] =
    Array.from({ length: 8 }, (_, bit) => Boolean(mask & (1 << bit)));
  if (superseded && held) continue;
  const values = {
    "claim-exact-review-queue.claimed": String(claimed),
    "direct-exact-review-publication.accepted": String(accepted),
    "complete-exact-review-queue.outcome": completed ? "success" : "failure",
    "reserve-exact-review-lease.status": superseded ? "superseded" : held ? "held" : "posted",
    "review-exact-event-item.superseded": String(itemSuperseded),
    "exact-review-generation-result.outcome": generated ? "success" : "failure",
    "exact-review-generation-result.retry_kind": deferred ? "throttle" : "",
  };
  const generationFailed = !generated && !deferred && !held && !superseded;
  const expected =
    claimed && ((!accepted && !completed && !superseded && !itemSuperseded) || generationFailed);
  for (const entry of [before, after]) {
    assert.equal(evaluate(entry.if, values), expected);
    assert.equal(
      evaluate(entry.env.CLASSIFICATION, values),
      generationFailed ? "codex_or_content_failure" : "queue_completion_failure",
    );
  }
  truthTableCases++;
}
for (const [name, process, generation, retry, reservation, completion, classification] of [
  ["completion-only", "success", "success", "", "posted", "failure", "queue_completion_failure"],
  [
    "held-deferral",
    "skipped",
    "failure",
    "coordination",
    "held",
    "failure",
    "queue_completion_failure",
  ],
  [
    "typed-throttle",
    "failure",
    "failure",
    "throttle",
    "posted",
    "failure",
    "queue_completion_failure",
  ],
  [
    "content-failure-exit-zero",
    "success",
    "failure",
    "",
    "posted",
    "success",
    "codex_or_content_failure",
  ],
  [
    "simultaneous-failures",
    "failure",
    "failure",
    "",
    "posted",
    "failure",
    "codex_or_content_failure",
  ],
  ["review-only", "failure", "failure", "", "posted", "success", "codex_or_content_failure"],
]) {
  const values = {
    "claim-exact-review-queue.claimed": "true",
    "direct-exact-review-publication.accepted": "false",
    "complete-exact-review-queue.outcome": completion,
    "reserve-exact-review-lease.status": reservation,
    "review-exact-event-item.outcome": process,
    "review-exact-event-item.exit_code": process === "failure" ? "1" : "0",
    "exact-review-generation-result.outcome": generation,
    "exact-review-generation-result.retry_kind": retry,
  };
  for (const [mode, entry] of [
    ["baseline", before],
    ["candidate", after],
  ]) {
    assert.equal(evaluate(entry.if, values), true);
    const env = Object.fromEntries(
      Object.entries(entry.env).map(([key, value]) => [
        key,
        String(evaluate(String(value), values)),
      ]),
    );
    const result = spawnSync("bash", ["-c", entry.run], { env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp(`classification=${classification} `));
    assert.match(result.stdout, new RegExp(`queue_completion=${completion}`));
    assertions.push({
      mode,
      name,
      exit: result.status,
      annotation: result.stdout.trim(),
      status: "PASS",
    });
  }
}
writeFileSync(
  output,
  JSON.stringify(
    { gate_unchanged: true, truth_table_cases: truthTableCases, assertions },
    null,
    2,
  ) + "\n",
);
console.log(
  `annotation proof: ${truthTableCases} gate cases and ${assertions.length} shell executions passed`,
);
