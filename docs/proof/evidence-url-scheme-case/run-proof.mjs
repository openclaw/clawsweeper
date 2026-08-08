#!/usr/bin/env node
/**
 * Real-behavior proof for the evidence external-URL scheme-case fix.
 *
 * Exercises the two shipped surfaces end to end against the built dist/:
 *
 *   1. Sanitizer  - dist/repair/url-safety.js sanitizeResultEvidence(), the
 *                   pre-publication mutation applied to a worker result.json.
 *   2. Validator  - dist/repair/review-results.js, run as the real CLI
 *                   subprocess exactly as dist/repair/run-worker.js invokes it.
 *
 * Both are driven with one fixture whose evidence carries an uppercase-scheme
 * external URL. Run against a pre-fix build it reports LEAKED/ACCEPTED; against
 * a post-fix build it reports REDACTED/REJECTED.
 *
 * Usage: node docs/proof/evidence-url-scheme-case/run-proof.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distUrlSafety = path.join(repoRoot, "dist", "repair", "url-safety.js");
const distReviewResults = path.join(repoRoot, "dist", "repair", "review-results.js");

for (const required of [distUrlSafety, distReviewResults]) {
  if (!fs.existsSync(required)) {
    console.error(`missing build artifact: ${required}\nrun: pnpm run build:repair`);
    process.exit(2);
  }
}

const EXTERNAL_HOST = "attacker.example";
const UPPERCASE_URL = `HTTPS://${EXTERNAL_HOST}/exfil?data=secret`;
const LOWERCASE_URL = `https://${EXTERNAL_HOST}/exfil?data=secret`;

/* -- Surface 1: the sanitizer -------------------------------------------- */

const { sanitizeResultEvidence, EVIDENCE_URL_PLACEHOLDER } = await import(
  `file://${distUrlSafety}`
);

const sanitizerCase = (label, url) => {
  const result = { actions: [{ evidence: [`proof: ${url}`] }] };
  sanitizeResultEvidence(result);
  const out = result.actions[0].evidence[0];
  return { label, url, out, redacted: !out.includes(EXTERNAL_HOST) };
};

const sanitizerResults = [
  sanitizerCase("lowercase scheme (control)", LOWERCASE_URL),
  sanitizerCase("uppercase scheme", UPPERCASE_URL),
];

/* -- Surface 2: the validator CLI ---------------------------------------- */

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csw-url-proof-"));

const writeFixture = (name, url) => {
  const runDir = path.join(fixtureRoot, name);
  fs.mkdirSync(runDir, { recursive: true });
  const updatedAt = "2026-01-01T00:00:00Z";
  fs.writeFileSync(
    path.join(runDir, "cluster-plan.json"),
    JSON.stringify({ item_matrix: [{ ref: "#1", updated_at: updatedAt }] }, null, 2),
  );
  fs.writeFileSync(
    path.join(runDir, "result.json"),
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "proof-evidence-url-scheme",
        mode: "plan",
        actions: [
          {
            action: "comment",
            target: "#1",
            target_kind: "issue",
            target_updated_at: updatedAt,
            idempotency_key: "proof-evidence-url-scheme-1",
            status: "planned",
            evidence: [`deploy preview: ${url}`],
          },
        ],
        needs_human: [],
        merge_preflight: [],
      },
      null,
      2,
    ),
  );
  return runDir;
};

const runValidator = (label, url) => {
  const runDir = writeFixture(label.replace(/\W+/g, "-"), url);
  const proc = spawnSync(process.execPath, [distReviewResults, runDir], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const report = JSON.parse(proc.stdout || "{}");
  const failures = (report.reports ?? []).flatMap((entry) => entry.failures ?? []);
  const externalUrlFailure = failures.filter((failure) =>
    failure.includes("evidence contains non-GitHub external URL"),
  );
  return { label, url, exitCode: proc.status, status: report.status, failures, externalUrlFailure };
};

const validatorResults = [
  runValidator("lowercase scheme (control)", LOWERCASE_URL),
  runValidator("uppercase scheme", UPPERCASE_URL),
];

fs.rmSync(fixtureRoot, { recursive: true, force: true });

/* -- Report --------------------------------------------------------------- */

console.log("== Surface 1: sanitizeResultEvidence (dist/repair/url-safety.js) ==\n");
for (const entry of sanitizerResults) {
  console.log(`  ${entry.label}`);
  console.log(`    input   : proof: ${entry.url}`);
  console.log(`    output  : ${entry.out}`);
  console.log(`    verdict : ${entry.redacted ? "REDACTED (correct)" : "LEAKED (bug)"}\n`);
}

console.log("== Surface 2: review-results.js CLI (real subprocess) ==\n");
for (const entry of validatorResults) {
  console.log(`  ${entry.label}`);
  console.log(`    evidence: deploy preview: ${entry.url}`);
  console.log(`    exit    : ${entry.exitCode}  status: ${entry.status}`);
  console.log(`    failures: ${JSON.stringify(entry.failures)}`);
  console.log(
    `    verdict : ${
      entry.externalUrlFailure.length > 0 ? "REJECTED (correct)" : "ACCEPTED (bug)"
    }\n`,
  );
}

const allRedacted = sanitizerResults.every((entry) => entry.redacted);
const allRejected = validatorResults.every((entry) => entry.externalUrlFailure.length > 0);
const passed = allRedacted && allRejected;

console.log(`RESULT: ${passed ? "PASS" : "FAIL"}`);
console.log(
  passed
    ? "  Both schemes are redacted by the sanitizer and rejected by the validator."
    : "  At least one scheme escaped redaction or validation (pre-fix behavior).",
);
process.exit(passed ? 0 : 1);
