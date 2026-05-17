#!/usr/bin/env node
import type { JsonValue } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, repoRoot } from "./lib.js";
import {
  parseReviewReport,
  reportOnlyDecision,
  type IntakeLane,
} from "./issue-implementation-intake.js";
import {
  prepareTargetToolchain,
  runAllowedValidationCommands,
  type TargetValidationOptions,
} from "./target-validation.js";
import { setupComposeStack, teardownComposeStack, type ComposeContext } from "./compose-stack.js";
import { compactText } from "./text-utils.js";

/**
 * verify-reproduction: pre-intake lane that runs the reviewer's
 * `work_validation` commands against a clean checkout of the target repo to
 * upgrade `reproduction_status: source_reproducible` → `reproduced`.
 *
 * Run from the verify-reproduction.yml workflow once per source-reproducible
 * candidate. On a confirmed reproduction the worker patches the report
 * frontmatter so the next intake pass treats it as strictly reproducible.
 * On a clean validation pass the worker leaves the report untouched and
 * writes evidence into the audit ledger plus a comment on the source issue.
 *
 * Eligibility reuses `reportOnlyDecision({ lane: "verifiable" })` so the
 * intake invariants stay in one place — only the accepted reproduction
 * status differs.
 */

const VERIFIABLE_LANE: IntakeLane = "verifiable";

const args = parseArgs(process.argv.slice(2));

type VerificationStatus =
  | "not_eligible"
  | "reproduced"
  | "not_reproduced"
  | "blocked"
  | "verification_error";

export type EnvFailureReason =
  | "database_unreachable"
  | "app_not_initialized"
  | "autoload_missing"
  | "node_deps_missing"
  | "tooling_missing";

const ENV_FAILURE_PATTERNS: Array<{ regex: RegExp; reason: EnvFailureReason }> = [
  // Postgres / MySQL / Redis unreachable on the standard ports, plus the
  // generic Node/Bun ECONNREFUSED signature. Pinned to known DB/cache ports
  // so a real test that happens to hit "connection refused" against an
  // application endpoint isn't misclassified.
  {
    regex:
      /SQLSTATE\[08006\]|Connection refused.*\b(5432|3306|6379)\b|ECONNREFUSED.*\b(5432|3306|6379)\b/i,
    reason: "database_unreachable",
  },
  // Laravel was never bootstrapped (no `artisan`, no working directory).
  { regex: /Could not open input file:\s*artisan/i, reason: "app_not_initialized" },
  // Composer autoload didn't run before the test command fired.
  {
    regex: /Class "[^"]+" not found|require\(\): Failed opening required/i,
    reason: "autoload_missing",
  },
  // Node deps missing (lane should have installed them via prepare step).
  { regex: /Cannot find module|npm ERR! code ENOENT/i, reason: "node_deps_missing" },
  // Common "binary not on PATH" shapes that aren't a real test failure.
  {
    regex: /command not found|No such file or directory.*vendor\/bin/i,
    reason: "tooling_missing",
  },
];

/**
 * Scan a validation command's captured output for unambiguous
 * environment-failure signatures. Returns the first match or null if the
 * failure looks like a real test/assertion failure.
 *
 * The verify-reproduction lane uses this to distinguish "bug reproduced"
 * (the reviewer's command surfaced the real bug) from "missing service"
 * (the command never exercised the bug because the runner lacks Postgres /
 * Redis / vendor autoload / etc). Only the former is allowed to promote
 * `reproduction_status: source_reproducible` → `reproduced`. Env failures
 * are surfaced explicitly via `status: blocked` so the operator can fix
 * the runner rather than letting a false positive cascade into a fix-PR
 * attempt with no real bug to fix.
 *
 * Exported for unit tests.
 */
export function detectEnvFailure(
  output: string,
): { reason: EnvFailureReason; evidence: string } | null {
  for (const { regex, reason } of ENV_FAILURE_PATTERNS) {
    const match = output.match(regex);
    if (match) return { reason, evidence: match[0].slice(0, 200) };
  }
  return null;
}

type VerificationOutcome = {
  status: VerificationStatus;
  verified: boolean;
  reason: string;
  evidence: string;
  executedCommands: string[];
};

function main() {
  const command = String(args._[0] ?? "run");
  if (command === "run") run();
  else die(`unknown command: ${command}`);
}

function run() {
  const targetRepo = stringArg("target-repo", stringArg("target_repo", ""));
  if (!targetRepo) die("missing --target-repo");
  const itemNumber = positiveInteger(
    stringArg("item-number", stringArg("item_number", "")),
    "item number",
  );
  const reportRepo = stringArg(
    "report-repo",
    stringArg("report_repo", "valkyriweb/clawsweeper-state"),
  );
  const reportPath = stringArg(
    "report-path",
    stringArg("report_path", `records/${repoSlug(targetRepo)}/items/${itemNumber}.md`),
  );
  const reportUrl =
    stringArg("report-url", stringArg("report_url", "")) ||
    `https://github.com/${reportRepo}/blob/main/${reportPath}`;
  const reportFile = stringArg("report-file", stringArg("report_file", ""));
  if (!reportFile) die("missing --report-file (path to report in state checkout)");
  if (!fs.existsSync(reportFile)) die(`report file not found: ${reportFile}`);
  const targetCheckout = stringArg("target-checkout", stringArg("target_checkout", ""));
  if (!targetCheckout) die("missing --target-checkout");
  if (!fs.existsSync(targetCheckout)) die(`target checkout not found: ${targetCheckout}`);
  const baseBranch = stringArg("base-branch", stringArg("base_branch", "main"));

  const reportMarkdown = fs.readFileSync(reportFile, "utf8");
  const report = parseReviewReport(reportMarkdown);
  const eligibility = reportOnlyDecision({
    targetRepo,
    report,
    reportMarkdown,
    lane: VERIFIABLE_LANE,
  });

  const auditPath = path.join(
    repoRoot(),
    "results",
    "verify-reproduction",
    repoSlug(targetRepo),
    `${itemNumber}.md`,
  );
  const preparedAt = new Date().toISOString();

  if (!eligibility.shouldRepair) {
    const outcome: VerificationOutcome = {
      status: "not_eligible",
      verified: false,
      reason: eligibility.reason,
      evidence: `Ineligible for verify-reproduction lane: ${eligibility.blockers.join("; ")}`,
      executedCommands: [],
    };
    writeAudit({
      auditPath,
      targetRepo,
      itemNumber,
      reportRepo,
      reportPath,
      reportUrl,
      preparedAt,
      outcome,
    });
    emitOutputs({ outcome, reportPath, reportUrl, auditPath, itemNumber, targetRepo });
    console.log(JSON.stringify({ status: outcome.status, verified: false }));
    return;
  }

  const validationCommands = frontMatterStringArray(report.frontmatter.work_validation);
  if (validationCommands.length === 0) {
    const outcome: VerificationOutcome = {
      status: "verification_error",
      verified: false,
      reason: "no validation commands declared in report",
      evidence: "report frontmatter `work_validation` was empty after eligibility passed",
      executedCommands: [],
    };
    writeAudit({
      auditPath,
      targetRepo,
      itemNumber,
      reportRepo,
      reportPath,
      reportUrl,
      preparedAt,
      outcome,
    });
    emitOutputs({ outcome, reportPath, reportUrl, auditPath, itemNumber, targetRepo });
    console.log(JSON.stringify({ status: outcome.status, verified: false }));
    return;
  }

  const validationOptions: TargetValidationOptions = {
    allowExpensiveValidation: true,
    installTargetDeps: true,
    skipOpenClawChangedGate: true,
    strictTargetValidation: false,
    targetRepo,
  };

  let outcome: VerificationOutcome;
  try {
    prepareTargetToolchain(targetCheckout, validationOptions);
  } catch (error) {
    outcome = {
      status: "verification_error",
      verified: false,
      reason: "target toolchain bootstrap failed",
      evidence: compactText(String((error as Error)?.message ?? error), 4000),
      executedCommands: [],
    };
    writeAudit({
      auditPath,
      targetRepo,
      itemNumber,
      reportRepo,
      reportPath,
      reportUrl,
      preparedAt,
      outcome,
    });
    emitOutputs({ outcome, reportPath, reportUrl, auditPath, itemNumber, targetRepo });
    console.log(JSON.stringify({ status: outcome.status, verified: false }));
    return;
  }

  // Bring up the target repo's declared test stack (Postgres, Redis, etc.)
  // BEFORE running validation. If the repo ships no `docker-compose.test.yml`,
  // `composeContext` stays null and the lane behaves exactly as before.
  // Boot failure is fatal to verification — we cannot run the reviewer's
  // commands without their declared services.
  let composeContext: ComposeContext | null = null;
  try {
    composeContext = setupComposeStack(targetCheckout);
  } catch (error) {
    outcome = {
      status: "verification_error",
      verified: false,
      reason: "compose stack failed to start",
      evidence: compactText(String((error as Error)?.message ?? error), 4000),
      executedCommands: [],
    };
    writeAudit({
      auditPath,
      targetRepo,
      itemNumber,
      reportRepo,
      reportPath,
      reportUrl,
      preparedAt,
      outcome,
    });
    emitOutputs({ outcome, reportPath, reportUrl, auditPath, itemNumber, targetRepo });
    console.log(JSON.stringify({ status: outcome.status, verified: false }));
    return;
  }

  // The reviewer asserts these commands FAIL on `main` (that is the bug).
  // A successful run = the bug did NOT reproduce. A thrown error from the
  // runner = reproduction confirmed. We deliberately invert the usual
  // success/failure semantics that target-validation uses for fix flows.
  let executedCommands: string[] = [];
  try {
    try {
      executedCommands = runAllowedValidationCommands(
        validationCommands,
        targetCheckout,
        validationOptions,
        baseBranch,
      );
      outcome = {
        status: "not_reproduced",
        verified: false,
        reason: "validation commands all passed on a clean main checkout",
        evidence: executedCommands.length
          ? `Passed: ${executedCommands.map((cmd) => `\`${cmd}\``).join(", ")}`
          : "no commands executed",
        executedCommands,
      };
    } catch (error) {
      const message = compactText(String((error as Error)?.message ?? error), 4000);
      const envFailure = detectEnvFailure(message);
      if (envFailure) {
        outcome = {
          status: "blocked",
          verified: false,
          reason: `environment failure: ${envFailure.reason}`,
          evidence: `Detected env-failure signature \`${envFailure.evidence}\` — the validation command never exercised the bug. Operator must provision the missing service on the runner before reproduction can be verified.\n\nFull output:\n${message}`,
          executedCommands,
        };
      } else {
        outcome = {
          status: "reproduced",
          verified: true,
          reason: "validation command failed on a clean main checkout",
          evidence: message,
          executedCommands,
        };
      }
    }
  } finally {
    teardownComposeStack(composeContext);
  }

  if (outcome.verified) {
    const patched = applyReproductionPatch(reportMarkdown, {
      verifiedAt: preparedAt,
      evidence: outcome.evidence,
    });
    fs.writeFileSync(reportFile, patched, "utf8");
  }

  writeAudit({
    auditPath,
    targetRepo,
    itemNumber,
    reportRepo,
    reportPath,
    reportUrl,
    preparedAt,
    outcome,
  });
  emitOutputs({ outcome, reportPath, reportUrl, auditPath, itemNumber, targetRepo });
  console.log(JSON.stringify({ status: outcome.status, verified: outcome.verified }));
}

/**
 * Patch the report frontmatter so `reproduction_status` becomes `reproduced`
 * and append verification provenance lines (`reproduction_verified_at`,
 * `reproduction_verified_evidence`). Leaves the body untouched.
 *
 * Pure function — exported for unit tests.
 */
export function applyReproductionPatch(
  markdown: string,
  { verifiedAt, evidence }: { verifiedAt: string; evidence: string },
): string {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) return markdown;
  const original = fmMatch[1] ?? "";
  const lines = original.split(/\r?\n/);
  let foundStatus = false;
  const patchedLines = lines.map((line) => {
    if (/^reproduction_status:/i.test(line)) {
      foundStatus = true;
      return "reproduction_status: reproduced";
    }
    return line;
  });
  if (!foundStatus) patchedLines.push("reproduction_status: reproduced");
  patchedLines.push(`reproduction_verified_at: ${verifiedAt}`);
  patchedLines.push(`reproduction_verified_evidence: ${oneLineEvidence(evidence)}`);
  const newFrontmatter = `---\n${patchedLines.join("\n")}\n---`;
  return markdown.replace(fmMatch[0], `${newFrontmatter}\n`);
}

function oneLineEvidence(evidence: string): string {
  return evidence.replace(/\s+/g, " ").trim().slice(0, 400);
}

function writeAudit(context: {
  auditPath: string;
  targetRepo: string;
  itemNumber: number;
  reportRepo: string;
  reportPath: string;
  reportUrl: string;
  preparedAt: string;
  outcome: VerificationOutcome;
}) {
  fs.mkdirSync(path.dirname(context.auditPath), { recursive: true });
  const { outcome } = context;
  const body = `---
repo: ${context.targetRepo}
number: ${context.itemNumber}
report_repo: ${context.reportRepo}
report_path: ${context.reportPath}
status: ${outcome.status}
verified: ${outcome.verified}
prepared_at: ${context.preparedAt}
---

# Verify Reproduction ${context.itemNumber}

- Status: \`${outcome.status}\`
- Verified: \`${outcome.verified}\`
- Reason: ${outcome.reason}
- Report: ${context.reportUrl}

## Evidence

\`\`\`
${outcome.evidence}
\`\`\`

## Executed commands

${outcome.executedCommands.length ? outcome.executedCommands.map((cmd) => `- \`${cmd}\``).join("\n") : "- none"}
`;
  fs.writeFileSync(context.auditPath, body, "utf8");
}

function emitOutputs(context: {
  outcome: VerificationOutcome;
  reportPath: string;
  reportUrl: string;
  auditPath: string;
  itemNumber: number;
  targetRepo: string;
}) {
  writeStepOutputs({
    status: context.outcome.status,
    verified: context.outcome.verified ? "true" : "false",
    reason: context.outcome.reason,
    evidence: oneLineEvidence(context.outcome.evidence),
    report_path: context.reportPath,
    report_url: context.reportUrl,
    audit_path: relative(context.auditPath),
    item_number: context.itemNumber,
    target_repo: context.targetRepo,
  });
}

function frontMatterStringArray(value: string | undefined): string[] {
  if (!value || value === "none") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed))
      return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // Legacy comma-separated reports.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function relative(target: string) {
  return path.relative(repoRoot(), target);
}

function writeStepOutputs(values: Record<string, JsonValue>) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(`${key}=${text}`);
  }
  fs.appendFileSync(output, `${lines.join("\n")}\n`);
}

function stringArg(key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function positiveInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) die(`invalid ${label}: ${value}`);
  return number;
}

function repoSlug(repo: string) {
  return repo
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
