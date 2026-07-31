#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const options = parseArgs(process.argv.slice(2));
const targetRepo = options.get("target-repo");
if (!targetRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
  fail("--target-repo must be a valid owner/repository");
}

const selectedItem = options.get("item-number");
if (selectedItem && !/^[1-9]\d*$/.test(selectedItem)) {
  fail("--item-number must be a positive integer");
}

const configuredLimit = options.get("max-dispatch") || process.env.MAX_DISPATCH || "";
const limit = Number(
  configuredLimit ||
    run("pnpm", [
      "run",
      "--silent",
      "workflow",
      "--",
      "limit",
      "issue_implementation.dispatches_per_sweep_default",
    ]),
);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
  fail("dispatch limit must be an integer between 1 and 100");
}

const candidateArgs = [
  "run",
  "--silent",
  "repair:issue-implementation-intake",
  "--",
  "candidates",
  "--enabled",
  "true",
  "--candidate-kind",
  "strict_bug",
  "--target-repo",
  targetRepo,
  "--report-repo",
  "openclaw/clawsweeper-state",
];
for (const name of ["artifact-dir", "report-dir"]) {
  const value = options.get(name);
  if (value) candidateArgs.push(`--${name}`, value);
}

let discovery;
try {
  discovery = JSON.parse(run("pnpm", candidateArgs));
} catch (error) {
  fail(`candidate discovery returned invalid JSON: ${error.message}`);
}
if (!Array.isArray(discovery.candidates)) fail("candidate discovery returned no candidate list");

const candidates = discovery.candidates
  .filter((candidate) => !selectedItem || String(candidate.item_number) === selectedItem)
  .slice(0, limit);
for (const candidate of candidates) {
  const itemNumber = String(candidate.item_number);
  if (!/^[1-9]\d*$/.test(itemNumber)) fail("candidate has an invalid issue number");
  if (typeof candidate.report_path !== "string" || typeof candidate.report_url !== "string") {
    fail(`candidate ${itemNumber} has an invalid report reference`);
  }
  process.stdout.write(
    `Dispatching high-confidence bug implementation for ${targetRepo}#${itemNumber}\n`,
  );
  const args = ["workflow", "run", "repair-issue-implementation-intake.yml"];
  if (process.env.GITHUB_REPOSITORY) args.push("--repo", process.env.GITHUB_REPOSITORY);
  args.push(
    "--ref",
    "main",
    "-f",
    "enabled=true",
    "-f",
    `target_repo=${targetRepo}`,
    "-f",
    `item_number=${itemNumber}`,
    "-f",
    "candidate_kind=strict_bug",
    "-f",
    `report_path=${candidate.report_path}`,
    "-f",
    `report_url=${candidate.report_url}`,
  );
  run("gh", args);
}
process.stdout.write(
  `${JSON.stringify({ discovered: discovery.candidates.length, dispatched: candidates.length })}\n`,
);

function parseArgs(argv) {
  const values = new Map();
  const names = new Set([
    "target-repo",
    "item-number",
    "artifact-dir",
    "report-dir",
    "max-dispatch",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !names.has(flag.slice(2)) || !value || value.startsWith("--")) {
      fail(`invalid dispatch argument ${flag || "(missing)"}`);
    }
    values.set(flag.slice(2), value);
  }
  return values;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`${command} exited ${result.status ?? "without a status"}`);
  }
  return result.stdout.trim();
}

function fail(message) {
  process.stderr.write(`[issue-implementation-dispatch] ${message}\n`);
  process.exit(1);
}
