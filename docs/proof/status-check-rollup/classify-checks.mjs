#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [subjectPath, historicalSourcePath, currentModulePath, artifactDir] = process.argv.slice(2);
assert(subjectPath && historicalSourcePath && currentModulePath && artifactDir, "missing arguments");

const oldCommit = "e13791786799f6a51a39806938847bbc48948e5e";
const expectedHead = "1aa53a6a09e543e4a6e4906f7e3cc0bf34a4bd65";
const subject = JSON.parse(fs.readFileSync(subjectPath, "utf8"));
const checks = subject.statusCheckRollup;

assert.equal(subject.number, 1099);
assert.equal(subject.headRefOid, expectedHead);
assert.equal(checks.length, 26, "expected the recorded 26-entry real GitHub payload");

const historicalSource = fs.readFileSync(historicalSourcePath, "utf8");
const historicalSummarizeChecks = loadHistoricalSummarizer(historicalSource);
const { rollUpStatusChecks } = await import(pathToFileURL(path.resolve(currentModulePath)).href);

const oldClassification = withNeedsChecks(historicalSummarizeChecks(checks));
const newClassification = withNeedsChecks(summarizeCurrentChecks(checks, rollUpStatusChecks));

assert(oldClassification.blockers.length > 0, "historical classifier must retain blockers");
assert.equal(oldClassification.blockers.length, 2, "expected two stale historical blockers");
assert.deepEqual(oldClassification.blockers, [
  "ClawSweeper Dispatch / dispatch:CANCELLED",
  "ClawSweeper Dispatch / dispatch:CANCELLED",
]);
assert.deepEqual(newClassification.blockers, [], "current classifier must clear stale blockers");

const repeatedDispatch = checks.filter(
  (check) =>
    String(check.workflowName ?? "").toLowerCase() === "clawsweeper dispatch" &&
    String(check.name ?? check.context ?? "").toLowerCase() === "dispatch",
);
assert(repeatedDispatch.some((check) => check.conclusion === "CANCELLED"));
assert(repeatedDispatch.some((check) => check.conclusion === "SUCCESS"));

fs.mkdirSync(artifactDir, { recursive: true });
const redactedChecks = checks.map(redactCheckRun);
writeJson(path.join(artifactDir, "check-runs.redacted.json"), redactedChecks);

const pair = {
  oldPreChangeCommit: oldCommit,
  old: oldClassification,
  newHeadCommit: process.env.PROOF_HEAD,
  new: newClassification,
};
writeJson(path.join(artifactDir, "classification-pair.json"), pair);

const runIds = uniqueSorted(redactedChecks.map((check) => check.actionsRunId).filter(Boolean));
const jobIds = uniqueSorted(redactedChecks.map((check) => check.jobId).filter(Boolean));
writeJson(path.join(artifactDir, "provenance.json"), {
  schema: "clawsweeper-status-check-rollup-proof/v1",
  generated_at: new Date().toISOString(),
  proof_head: process.env.PROOF_HEAD,
  historical_source: {
    commit: oldCommit,
    path: "src/repair/finalize-open-prs.ts",
    extraction: "git show <commit>:<path> into an isolated temporary file",
  },
  current_source: "src/repair/status-check-rollup.ts from the working tree",
  subject: {
    repository: "openclaw/clawsweeper",
    pull_request: 1099,
    url: "https://github.com/openclaw/clawsweeper/pull/1099",
    head_sha: subject.headRefOid,
    check_count: checks.length,
    repeated_identity: "ClawSweeper Dispatch / dispatch",
    actions_run_ids: runIds,
    job_ids: jobIds,
  },
  acquisition: {
    command: "gh pr view 1099 --repo openclaw/clawsweeper --json number,url,headRefOid,statusCheckRollup",
    mode: "read-only",
  },
  result: {
    historical_blockers: oldClassification.blockers.length,
    current_blockers: newClassification.blockers.length,
  },
  redaction_note:
    "GitHub detailsUrl values are replaced with [redacted]; Actions run and job IDs are retained for reproducibility.",
});

console.log(`subject_head=${subject.headRefOid}`);
console.log(`payload_checks=${checks.length}`);
console.log(`old_blockers=${oldClassification.blockers.length}`);
console.log(`new_blockers=${newClassification.blockers.length}`);

function loadHistoricalSummarizer(source) {
  const summarize = extractBetween(
    source,
    "function summarizeChecks(",
    "\n\nfunction hasDeterministicPullSecuritySignal(",
  );
  const display = extractBetween(
    source,
    "function displayCheckName(",
    "\n\nfunction hasUnknownMergeability(",
  );
  const ignored = extractBetween(
    source,
    "function ignoredCheckNames(",
    "\n\nfunction writeReports(",
  );
  const executableSource = stripKnownTypeAnnotations(`${summarize}\n\n${display}\n\n${ignored}`);
  return new Function(
    "PASSING_CHECK_CONCLUSIONS",
    "DEFAULT_IGNORED_CHECKS",
    `${executableSource}\nreturn summarizeChecks;`,
  )(new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]), ["auto-response", "Labeler", "notify", "Stale"]);
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `could not extract historical source at ${startMarker}`);
  return source.slice(start, end);
}

function stripKnownTypeAnnotations(source) {
  return source
    .replaceAll(": LooseRecord[]", "")
    .replaceAll(": LooseRecord", "")
    .replaceAll(": JsonValue", "")
    .replaceAll(": Record<string, number>", "");
}

function summarizeCurrentChecks(inputChecks, currentRollup) {
  const rolledUpChecks = currentRollup(
    inputChecks,
    process.env.CLAWSWEEPER_FINALIZER_IGNORE_CHECKS ?? "auto-response,Labeler,notify,Stale",
  );
  const counts = {};
  const blockers = [];
  const passingConclusions = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  for (const { check, ignored } of rolledUpChecks) {
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    const key = conclusion || status || "UNKNOWN";
    counts[key] = (counts[key] ?? 0) + 1;
    if (ignored) continue;
    if (status && !["COMPLETED", "SUCCESS"].includes(status)) {
      blockers.push(`${displayCheckName(check)}:${status}`);
      continue;
    }
    if (conclusion && !passingConclusions.has(conclusion)) {
      blockers.push(`${displayCheckName(check)}:${conclusion}`);
    }
  }
  return { total: rolledUpChecks.length, counts, blockers };
}

function displayCheckName(check) {
  const workflow = String(check.workflowName ?? "");
  const name = String(check.name ?? check.context ?? "unknown check");
  return workflow && workflow !== name ? `${workflow} / ${name}` : name;
}

function withNeedsChecks(classification) {
  return {
    ...classification,
    needs_checks:
      classification.blockers.length > 0
        ? `needs_checks:${classification.blockers.slice(0, 3).join("; ")}`
        : null,
  };
}

function redactCheckRun(check) {
  const detailsUrl = String(check.detailsUrl ?? "");
  const match = detailsUrl.match(/\/actions\/runs\/(\d+)\/job\/(\d+)/);
  return {
    ...check,
    detailsUrl: detailsUrl ? "[redacted]" : "",
    actionsRunId: match?.[1] ?? null,
    jobId: match?.[2] ?? null,
  };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
