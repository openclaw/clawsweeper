#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, parseJob, repoRoot, validateJob } from "./lib.js";
import { ghErrorText, ghJsonWithRetry } from "./github-cli.js";
import {
  issueImplementationJobBranch,
  issueImplementationJobPath,
  renderIssueImplementationJob,
  REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
} from "./comment-router-core.js";
import { requireTargetRepo } from "../repository-profiles.js";

type IntakeDecision = {
  status: string;
  shouldRepair: boolean;
  reason: string;
  blockers: string[];
};

type ReviewReport = {
  frontmatter: Record<string, string>;
  body: string;
};

const args = parseArgs(process.argv.slice(2));

function main() {
  const command = String(args._[0] ?? "prepare");
  if (command === "prepare") prepare();
  else if (command === "candidates") candidates();
  else die(`unknown command: ${command}`);
}

function prepare() {
  const enabled = stringArg("enabled", "true");
  const targetRepo = requireTargetRepo(stringArg("target-repo", stringArg("target_repo", "")));
  const reportRepo = stringArg("report-repo", stringArg("report_repo", "openclaw/clawsweeper"));
  const itemNumber = positiveInteger(
    stringArg("item-number", stringArg("item_number", "")),
    "item number",
  );
  const reportPath = stringArg(
    "report-path",
    stringArg("report_path", `records/${repoSlug(targetRepo)}/items/${itemNumber}.md`),
  );
  const reportUrl =
    stringArg("report-url", stringArg("report_url", "")) ||
    `https://github.com/${reportRepo}/blob/main/${reportPath}`;
  const reportMarkdown = readReport({ reportRepo, reportPath });
  const report = parseReviewReport(reportMarkdown);
  const live = truthy(enabled)
    ? liveIssueContext({ repo: targetRepo, number: itemNumber })
    : { issue: null, comments: [], existingPrs: [], existingBranchPrs: [] };
  // Read the verify-reproduction audit (if any) so eligibility can honor
  // a verified reproduction even when the patched source report did not
  // make it back to the state branch before this intake checkout was made.
  const audit = readVerifyReproductionAudit(targetRepo, itemNumber);
  const decision = intakeDecision({
    enabled,
    targetRepo,
    itemNumber,
    report,
    reportMarkdown,
    live,
    audit,
  });
  const jobPath = path.join(repoRoot(), issueImplementationJobPath(targetRepo, itemNumber));
  const auditPath = path.join(
    repoRoot(),
    "results",
    "issue-implementation-intake",
    repoSlug(targetRepo),
    `${itemNumber}.md`,
  );
  const preparedAt = new Date().toISOString();
  const context = {
    targetRepo,
    reportRepo,
    itemNumber,
    reportPath,
    reportUrl,
    report,
    reportMarkdown,
    live,
    decision,
    jobPath,
    auditPath,
    preparedAt,
  };

  if (decision.shouldRepair) writeJob(context);
  writeAudit(context);

  const out = {
    status: decision.status,
    should_repair: decision.shouldRepair,
    reason: decision.reason,
    blockers: decision.blockers.join("; "),
    target_repo: targetRepo,
    item_number: itemNumber,
    report_path: reportPath,
    report_url: reportUrl,
    audit_path: relative(auditPath),
    job_path: decision.shouldRepair ? relative(jobPath) : "",
  };
  writeStepOutputs(out);
  console.log(JSON.stringify(out, null, 2));
}

function candidates() {
  const enabled = stringArg("enabled", "true");
  const artifactDir = path.resolve(
    stringArg("artifact-dir", stringArg("artifact_dir", "artifacts")),
  );
  const targetRepo = requireTargetRepo(stringArg("target-repo", stringArg("target_repo", "")));
  const reportRepo = stringArg("report-repo", stringArg("report_repo", "openclaw/clawsweeper"));
  const lane = parseLaneArg(stringArg("lane", "reproduced"));
  const out: LooseRecord[] = [];
  if (truthy(enabled) && fs.existsSync(artifactDir)) {
    for (const file of findMarkdownFiles(artifactDir)) {
      const markdown = fs.readFileSync(file, "utf8");
      const report = parseReviewReport(markdown);
      const number = Number(report.frontmatter.number);
      const repository = report.frontmatter.repository || targetRepo;
      const reportPath = `records/${repoSlug(repository)}/items/${number}.md`;
      const reportUrl = `https://github.com/${reportRepo}/blob/main/${reportPath}`;
      const decision = reportOnlyDecision({
        targetRepo,
        report,
        reportMarkdown: markdown,
        lane,
      });
      if (!decision.shouldRepair) continue;
      out.push({ item_number: number, report_path: reportPath, report_url: reportUrl });
    }
  }
  const itemNumbers = out.map((entry: LooseRecord) => String(entry.item_number)).join(",");
  writeStepOutputs({
    count: out.length,
    item_numbers: itemNumbers,
    candidates_json: JSON.stringify(out),
  });
  console.log(JSON.stringify({ count: out.length, item_numbers: itemNumbers, candidates: out }));
}

export function parseReviewReport(markdown: string): ReviewReport {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter: Record<string, string> = {};
  if (match) {
    for (const line of (match[1] ?? "").split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;
      frontmatter[kv[1] ?? ""] = stripQuotes(kv[2] ?? "");
    }
  }
  return { frontmatter, body: match ? markdown.slice(match[0].length) : markdown };
}

/**
 * Implementation-intake eligibility lane.
 *
 * - `reproduced`: strict reproducible-bug lane. Used by the default issue
 *   implementation intake. The reviewer must have already executed the
 *   reproduction (frontmatter `reproduction_status: reproduced`).
 * - `verifiable`: pre-intake verify-reproduction lane. Accepts reviews that
 *   are source-reproducible at high confidence (`reproduction_status:
 *   source_reproducible`). A separate worker runs the reviewer's
 *   `work_validation` commands against a live target checkout and, on a
 *   reproduced failure, patches the report to `reproduced` so it can
 *   re-enter the strict lane. Every other eligibility check still applies
 *   identically — only the accepted reproduction status differs.
 */
export type IntakeLane = "reproduced" | "verifiable";

/**
 * Shape of a verify-reproduction audit record on disk, restricted to the
 * frontmatter fields intake reads when overlaying the audit on top of the
 * source report's `reproduction_status`.
 */
export type VerifyReproductionAudit = {
  status: "not_eligible" | "reproduced" | "not_reproduced" | "blocked" | "verification_error";
  verified: boolean;
  reason: string;
};

/**
 * Read the verify-reproduction audit for a target item if it exists.
 *
 * The audit is written by `src/repair/verify-reproduction.ts` after the
 * lane runs the reviewer's `work_validation` commands against a clean
 * target checkout. Intake reads it to overlay any verification result on
 * top of the source report's `reproduction_status` (belt-and-suspenders
 * for the report-mutation path that verify-reproduction also takes).
 *
 * Returns null when no audit has been recorded yet, the file is unreadable,
 * or the frontmatter cannot be parsed. Exported for unit tests.
 */
export function readVerifyReproductionAudit(
  targetRepo: string,
  itemNumber: number,
  resultsRoot?: string,
): VerifyReproductionAudit | null {
  const root = resultsRoot ?? path.join(repoRoot(), "results", "verify-reproduction");
  const auditPath = path.join(root, repoSlug(targetRepo), `${itemNumber}.md`);
  if (!fs.existsSync(auditPath)) return null;
  let markdown: string;
  try {
    markdown = fs.readFileSync(auditPath, "utf8");
  } catch {
    return null;
  }
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) return null;
  const frontmatter: Record<string, string> = {};
  for (const line of (fmMatch[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    frontmatter[kv[1] ?? ""] = stripQuotes(kv[2] ?? "");
  }
  const rawStatus = frontmatter.status ?? "verification_error";
  const status: VerifyReproductionAudit["status"] =
    rawStatus === "not_eligible" ||
    rawStatus === "reproduced" ||
    rawStatus === "not_reproduced" ||
    rawStatus === "blocked" ||
    rawStatus === "verification_error"
      ? rawStatus
      : "verification_error";
  return {
    status,
    verified: frontmatter.verified === "true",
    reason: frontmatter.reason ?? "",
  };
}

/**
 * Determine the effective `reproduction_status` for an item by overlaying
 * any verify-reproduction audit on top of the source report.
 *
 * Source report is the original review verdict (`reproduced`,
 * `source_reproducible`, etc). The verify-reproduction lane may later run
 * the reviewer's commands against a clean checkout and (a) confirm the
 * bug, promoting `source_reproducible` → `reproduced`, (b) fail to
 * reproduce, leaving the source value alone (the source mutation path also
 * doesn't write back in this case), or (c) hit an environment failure
 * (missing service on the runner), explicitly downgrading to `blocked`.
 *
 * Intake trusts verified audit results when present. This handles the
 * race where verify-reproduction patched the report locally but the
 * patched copy did not make it back to the state branch before intake
 * checked out a fresh copy — the audit (a separately-tracked file in
 * `results/verify-reproduction/`) is the surviving source of truth.
 *
 * Exported for unit tests.
 */
export function effectiveReproductionStatus(
  report: ReviewReport,
  audit: VerifyReproductionAudit | null,
): string {
  const source = report.frontmatter.reproduction_status ?? "unknown";
  // Source already says reproduced — nothing to overlay. (Audit downgrades
  // of an already-reproduced item are out of scope; the reviewer's verdict
  // wins because they had richer context than the validation runner does.)
  if (source === "reproduced") return "reproduced";
  if (audit) {
    if (audit.status === "reproduced" && audit.verified) return "reproduced";
    if (audit.status === "blocked") return "blocked";
    if (audit.status === "not_reproduced") return "not_reproduced";
  }
  return source;
}

export function reportOnlyDecision({
  targetRepo,
  report,
  reportMarkdown,
  lane = "reproduced",
  audit = null,
}: {
  targetRepo: string;
  report: ReviewReport;
  reportMarkdown: string;
  lane?: IntakeLane;
  audit?: VerifyReproductionAudit | null;
}): IntakeDecision {
  // `reportMarkdown` is preserved on the public type for backward compat
  // with callers (CLI, tests, other repos) that still pass the rendered
  // markdown; intake no longer needs it now that the security verdict and
  // every other gate read structured frontmatter fields instead.
  void reportMarkdown;
  return eligibilityDecision({
    targetRepo,
    report,
    live: null,
    enabled: "true",
    lane,
    audit,
  });
}

function intakeDecision({
  enabled,
  targetRepo,
  report,
  reportMarkdown,
  live,
  lane = "reproduced",
  audit = null,
}: {
  enabled: string;
  targetRepo: string;
  itemNumber: number;
  report: ReviewReport;
  reportMarkdown: string;
  live: LooseRecord;
  lane?: IntakeLane;
  audit?: VerifyReproductionAudit | null;
}): IntakeDecision {
  void reportMarkdown;
  return eligibilityDecision({ enabled, targetRepo, report, live, lane, audit });
}

function eligibilityDecision({
  enabled,
  targetRepo,
  report,
  live,
  lane = "reproduced",
  audit = null,
}: {
  enabled: string;
  targetRepo: string;
  report: ReviewReport;
  live: LooseRecord | null;
  lane?: IntakeLane;
  audit?: VerifyReproductionAudit | null;
}): IntakeDecision {
  if (!truthy(enabled)) {
    return decision("disabled", false, "issue implementation intake disabled");
  }
  const fm = report.frontmatter;
  const blockers: string[] = [];
  // Case-insensitive repo comparison: reviewers/renderers normalize the
  // `repository` frontmatter field to lowercase (`clip-sa/core-ai`) but the
  // workflow input may carry the canonical mixed-case form (`CLIP-SA/core-ai`).
  if ((fm.repository ?? "").toLowerCase() !== targetRepo.toLowerCase())
    blockers.push(`report repository is ${fm.repository || "unknown"}`);
  if (fm.type !== "issue") blockers.push(`report type is ${fm.type || "unknown"}`);
  if (fm.state_at_review !== "open") blockers.push("item was not open at review");
  if (fm.review_status !== "complete")
    blockers.push(`review status is ${fm.review_status || "unknown"}`);
  if (fm.decision !== "keep_open") blockers.push(`decision is ${fm.decision || "unknown"}`);
  if (fm.close_reason !== "none") blockers.push(`close reason is ${fm.close_reason || "unknown"}`);
  if (fm.confidence !== "high") blockers.push(`review confidence is ${fm.confidence || "unknown"}`);
  if (fm.work_candidate !== "queue_fix_pr")
    blockers.push(`work candidate is ${fm.work_candidate || "unknown"}`);
  if (fm.work_confidence !== "high")
    blockers.push(`work confidence is ${fm.work_confidence || "unknown"}`);
  if (!isEligibleIssueImplementationCategory(fm.item_category))
    blockers.push(`item category is ${fm.item_category || "unknown"}`);
  const acceptedReproStatus = lane === "verifiable" ? "source_reproducible" : "reproduced";
  const effectiveStatus = effectiveReproductionStatus(report, audit);
  if (effectiveStatus === "blocked") {
    blockers.push(
      `verify-reproduction marked the item environment-blocked${
        audit?.reason ? `: ${audit.reason}` : ""
      }`,
    );
  } else if (effectiveStatus !== acceptedReproStatus) {
    blockers.push(`reproduction status is ${effectiveStatus || "unknown"}`);
  }
  if (fm.reproduction_confidence !== "high")
    blockers.push(`reproduction confidence is ${fm.reproduction_confidence || "unknown"}`);
  if (fm.requires_new_feature === "true") blockers.push("requires a new feature");
  if (fm.requires_new_config_option === "true") blockers.push("requires a new config option");
  if (fm.requires_product_decision === "true") blockers.push("requires a product decision");
  if (frontMatterStringArray(fm.labels).some(isProtectedLabel))
    blockers.push("protected label present");
  // Trust the reviewer's schema-validated `securityReview.status` verdict
  // (promoted to `security_review_status` frontmatter by the renderer) over
  // a regex scan of the narrative prose. Fail-closed when the field is
  // missing or unknown so legacy reports must be re-reviewed before they
  // re-enter intake.
  const securityVerdict = fm.security_review_status;
  if (securityVerdict !== "cleared" && securityVerdict !== "not_applicable") {
    blockers.push(
      securityVerdict
        ? `security review verdict is ${securityVerdict}`
        : "missing security review verdict",
    );
  }
  if (!section(report.body, "Repair Work Prompt").trim())
    blockers.push("missing repair work prompt");
  if (frontMatterStringArray(fm.work_validation).length === 0)
    blockers.push("missing validation commands");
  if (
    frontMatterStringArray(fm.work_cluster_refs).some((ref) =>
      blocksIssueImplementationPr(ref, targetRepo),
    )
  )
    blockers.push("work cluster references a PR");

  if (live) {
    const issue = asRecord(live.issue);
    const labels = (issue.labels ?? []).map((label: JsonValue) => String(label?.name ?? label));
    if (issue.state !== "open") blockers.push(`live issue state is ${issue.state || "unknown"}`);
    if (issue.locked === true) blockers.push("live issue is locked");
    if (labels.some(isProtectedLabel)) blockers.push("live issue has protected label");
    if (securitySensitiveText([issue.title, issue.body, labels.join("\n")].join("\n"))) {
      blockers.push("live issue has security-sensitive signal");
    }
    if (attachedPrText(live)) blockers.push("issue already has a PR reference attached");
    if (Array.isArray(live.existingPrs) && live.existingPrs.length > 0) {
      blockers.push("open PR already mentions this issue");
    }
    if (Array.isArray(live.existingBranchPrs) && live.existingBranchPrs.length > 0) {
      blockers.push("existing ClawSweeper issue implementation PR is open");
    }
  }

  if (blockers.length) {
    return {
      status: "not_eligible",
      shouldRepair: false,
      reason: blockers[0] ?? "not eligible",
      blockers,
    };
  }
  if (lane === "verifiable") {
    return decision(
      "queued_for_verification",
      true,
      "source-reproducible bug is eligible for live reproduction verification",
    );
  }
  return decision(
    "queued_for_repair",
    true,
    "strict reproducible bug is eligible for ClawSweeper implementation",
  );
}

function writeJob(context: LooseRecord) {
  const fm = context.report.frontmatter as Record<string, string>;
  const issue = asRecord(context.live.issue);
  const body = renderIssueImplementationJob({
    repo: context.targetRepo,
    issueNumber: context.itemNumber,
    title: issue.title || displayTitle(fm.title ?? "") || `Issue #${context.itemNumber}`,
    implementationPrompt: strictImplementationPrompt(context),
    triggerSource: REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
    reviewReportUrl: context.reportUrl,
    reviewReportPath: context.reportPath,
    strictBugOnly: true,
    allowAutomerge: process.env.CLAWSWEEPER_ALLOW_AUTOMERGE === "1",
  });
  fs.mkdirSync(path.dirname(context.jobPath), { recursive: true });
  fs.writeFileSync(context.jobPath, body, "utf8");
  const errors = validateJob(parseJob(context.jobPath));
  if (errors.length) die(errors.join("\n"));
}

function strictImplementationPrompt(context: LooseRecord) {
  const fm = context.report.frontmatter as Record<string, string>;
  const validation = frontMatterStringArray(fm.work_validation);
  const likelyFiles = frontMatterStringArray(fm.work_likely_files);
  const workPrompt = section(context.report.body, "Repair Work Prompt");
  return [
    "This was selected by ClawSweeper's strict reproducible-bug lane.",
    "",
    `Review report: ${context.reportUrl}`,
    `Category: ${fm.item_category}`,
    `Reproduction: ${fm.reproduction_status} (${fm.reproduction_confidence})`,
    "Feature/config/product blockers: false.",
    "",
    "Bug-fix boundary:",
    "",
    "- fix broken existing behavior only",
    "- do not add config options, feature modes, providers, broad UX changes, or product policy",
    "- reproduce first; if reproduction fails on latest main, stop and report that blocker",
    "",
    "Review work prompt:",
    "",
    workPrompt.trim() || fm.work_reason_sha256 || "Fix the narrow reproduced bug.",
    "",
    "Likely files:",
    "",
    ...(likelyFiles.length ? likelyFiles.map((file) => `- ${file}`) : ["- unknown"]),
    "",
    "Validation:",
    "",
    ...(validation.length ? validation.map((command) => `- ${command}`) : ["- pnpm check:changed"]),
  ].join("\n");
}

function writeAudit(context: LooseRecord) {
  fs.mkdirSync(path.dirname(context.auditPath), { recursive: true });
  const jobLine = context.decision.shouldRepair
    ? `- Job: \`${relative(context.jobPath)}\``
    : "- Job: none";
  const body = `---
repo: ${context.targetRepo}
number: ${context.itemNumber}
report_repo: ${context.reportRepo}
report_path: ${context.reportPath}
decision: ${context.decision.status}
prepared_at: ${context.preparedAt}
---

# Issue Implementation Intake ${context.itemNumber}

- Decision: \`${context.decision.status}\`
- Reason: ${context.decision.reason}
- Report: ${context.reportUrl}
- Branch: \`${issueImplementationJobBranch(context.targetRepo, context.itemNumber)}\`
${jobLine}

## Blockers

${context.decision.blockers.length ? context.decision.blockers.map((blocker: string) => `- ${blocker}`).join("\n") : "- none"}
`;
  fs.writeFileSync(context.auditPath, body, "utf8");
}

function liveIssueContext({ repo, number }: { repo: string; number: number }) {
  const [owner, name] = repo.split("/");
  const issue = ghJsonWithRetry([
    "api",
    `repos/${owner}/${name}/issues/${number}`,
    "--method",
    "GET",
  ]);
  const comments = ghJsonWithRetry([
    "api",
    `repos/${owner}/${name}/issues/${number}/comments?per_page=100`,
  ]);
  const branch = issueImplementationJobBranch(repo, number);
  const existingBranchPrs = ghJsonWithRetry(
    ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url"],
    { attempts: 3 },
  );
  const existingPrs = searchOpenPullRequestsMentioningIssue(repo, number);
  return { issue, comments, existingPrs, existingBranchPrs };
}

function searchOpenPullRequestsMentioningIssue(repo: string, number: number): LooseRecord[] {
  try {
    const result = ghJsonWithRetry(
      [
        "api",
        "search/issues",
        "--method",
        "GET",
        "-f",
        `q=repo:${repo} is:pr is:open "#${number}"`,
        "--jq",
        ".items",
      ],
      { attempts: 3 },
    );
    return Array.isArray(result)
      ? result.filter((item) => issueReferenceTextMatches(repo, number, item.body))
      : [];
  } catch (error) {
    throw new Error(`failed to search open PRs mentioning issue: ${ghErrorText(error)}`);
  }
}

function isEligibleIssueImplementationCategory(category: string | undefined) {
  // `regression` is included alongside `bug` so reviewer-tagged regressions
  // (e.g. CI-break/generated-file-drift issues) can flow through the strict
  // implementation lane. Fork divergence from upstream openclaw/clawsweeper,
  // which restricts this lane to `bug` only.
  return new Set(["bug", "regression", "docs"]).has(
    String(category ?? "")
      .trim()
      .toLowerCase(),
  );
}

export function issueReferenceTextMatches(repo: string, number: number, value: JsonValue) {
  const text = String(value ?? "");
  if (!text) return false;
  const escapedRepo = escapeRegExp(repo);
  return new RegExp(
    `(?:^|[^A-Za-z0-9_])(?:#${number}\\b|${escapedRepo}/issues/${number}\\b|https://github\\.com/${escapedRepo}/issues/${number}\\b)`,
    "i",
  ).test(text);
}

export function attachedPrText(live: LooseRecord): boolean {
  const issue = asRecord(live.issue);
  const comments = Array.isArray(live.comments) ? live.comments : [];
  // Filter out bot-authored comments. Codex review evidence routinely cites
  // past PRs (`PR #14`, `pull request 19`, etc.) as historical forensic
  // context, but those mentions are the reviewer's own narrative, not an
  // attached PR. Scanning only the issue body + human comments stops the
  // gate from self-disqualifying any issue with a rich review attached.
  const humanComments = comments.filter((comment: JsonValue) => {
    const login = String(asRecord(asRecord(comment).user).login ?? "");
    return !login.endsWith("[bot]");
  });
  const text = [issue.body, ...humanComments.map((comment: JsonValue) => asRecord(comment).body)]
    .map((part) => String(part ?? ""))
    .join("\n");
  return /\/pull\/\d+\b|\b(?:PR|pull request)\s+#?\d+\b/i.test(text);
}

function readReport({ reportRepo, reportPath }: { reportRepo: string; reportPath: string }) {
  const local = args["report-file"] ?? args.report_file;
  if (typeof local === "string") return fs.readFileSync(path.resolve(local), "utf8");
  const content = ghJsonWithRetry<{ content?: string }>([
    "api",
    `repos/${reportRepo}/contents/${reportPath}`,
    "--method",
    "GET",
    "-f",
    "ref=main",
  ]);
  return Buffer.from(String(content.content ?? "").replace(/\s+/g, ""), "base64").toString("utf8");
}

function findMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function section(markdown: string, heading: string) {
  const match = markdown.match(
    new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\n\\n([\\s\\S]*?)(?=\\n## |\\n?$)`, "i"),
  );
  return match?.[1]?.trim() ?? "";
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

function decision(status: string, shouldRepair: boolean, reason: string): IntakeDecision {
  return { status, shouldRepair, reason, blockers: shouldRepair ? [] : [reason] };
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

function isProtectedLabel(label: string): boolean {
  return ["security", "beta-blocker", "release-blocker", "maintainer"].includes(
    label.trim().toLowerCase(),
  );
}

export function blocksIssueImplementationPr(ref: string, targetRepo: string): boolean {
  const text = ref.trim();
  if (/^pr[#:\s-]*\d+$/i.test(text)) return true;
  const pullUrl = text.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/i);
  if (!pullUrl) return false;
  return pullUrl[1]?.toLowerCase() === targetRepo.toLowerCase();
}

export function securitySensitiveText(text: string): boolean {
  const normalized = text.replace(/\bnot\b[^\n.]{0,80}\bsecurity-sensitive\b/gi, "not-sensitive");
  if (
    /\b(?:security|vulnerability|cve|ghsa|secret|credential|exploit|xss|csrf|ssrf|rce)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return /\b(?:bearer|access|refresh|auth|api|personal access|github|otel|signoz)\s+token\b|\b[A-Z0-9_]*TOKEN\s*[:=]\s*\S{8,}|\btoken\s*[:=]\s*\S{8,}/i.test(
    normalized,
  );
}

function asRecord(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
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

function truthy(value: JsonValue) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function parseLaneArg(value: string): IntakeLane {
  const normalized = value.trim().toLowerCase();
  if (normalized === "verifiable") return "verifiable";
  if (normalized === "" || normalized === "reproduced") return "reproduced";
  die(`unknown intake lane: ${value} (expected reproduced or verifiable)`);
}

function repoSlug(repo: string) {
  return repo
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function displayTitle(value: string) {
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

function stripQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relative(filePath: string) {
  return path.relative(repoRoot(), filePath);
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
