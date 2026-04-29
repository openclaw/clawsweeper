#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  hasSecuritySignalText,
  makeRunDir,
  parseArgs,
  parseJob,
  repoRoot,
  validateJob,
} from "./lib.js";
import { ghText } from "./github-cli.js";
import { readJsonFileIfExists as readJsonIfExists } from "./json-file.js";
import { commitFindingPrTitle } from "./pr-title.js";
import { escapeRegExp, slug } from "./text-utils.js";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "prepare";

if (command === "prepare") prepare();
else if (command === "finalize") finalize();
else die(`unknown command: ${command}`);

function prepare() {
  const enabled = stringArg("enabled", "true");
  const targetRepo = stringArg("target-repo", stringArg("target_repo", "openclaw/openclaw"));
  const reportRepo = stringArg("report-repo", stringArg("report_repo", "openclaw/clawsweeper"));
  const sha = assertSha(stringArg("commit-sha", stringArg("commit_sha", "")));
  const reportPath = stringArg(
    "report-path",
    stringArg("report_path", `records/${repoSlug(targetRepo)}/commits/${sha}.md`),
  );
  const reportUrl =
    stringArg("report-url", stringArg("report_url", "")) ||
    `https://github.com/${reportRepo}/blob/main/${reportPath}`;
  const active = truthy(enabled);
  const reportMarkdown = active ? readReport({ reportRepo, reportPath }) : "";
  const report = parseCommitReport(reportMarkdown);
  const clusterId = slug(`clawsweeper-commit-${repoSlug(targetRepo)}-${sha.slice(0, 12)}`);
  const owner = targetRepo.split("/")[0];
  const jobPath = path.join(repoRoot(), "jobs", owner, "inbox", `${clusterId}.md`);
  const auditPath = path.join(
    repoRoot(),
    "results",
    "commit-findings",
    repoSlug(targetRepo),
    `${sha}.md`,
  );
  const branch = `clawsweeper/${clusterId}`;
  const latestMain = fetchLatestMain(targetRepo);
  const decision = intakeDecision({ enabled, report, reportMarkdown });
  const preparedAt = new Date().toISOString();
  const runDir = decision.shouldRepair
    ? makeRunDir({ path: jobPath, frontmatter: { mode: "autonomous" } }, "commit-finding")
    : "";

  const context = {
    targetRepo,
    reportRepo,
    sha,
    reportPath,
    reportUrl,
    report,
    decision,
    clusterId,
    branch,
    jobPath,
    auditPath,
    latestMain,
    preparedAt,
    runDir,
  };

  if (decision.shouldRepair) {
    writeJob(context, reportMarkdown);
    writeSyntheticRun(context);
  }
  writeAudit(context, { phase: "prepared" });

  const out = {
    status: decision.status,
    should_repair: decision.shouldRepair,
    reason: decision.reason,
    target_repo: targetRepo,
    commit_sha: sha,
    report_path: reportPath,
    report_url: reportUrl,
    audit_path: relative(auditPath),
    job_path: decision.shouldRepair ? relative(jobPath) : "",
    run_dir: decision.shouldRepair ? relative(runDir) : "",
    result_path: decision.shouldRepair ? relative(path.join(runDir, "result.json")) : "",
  };
  writeStepOutputs(out);
  console.log(JSON.stringify(out, null, 2));
}

function finalize() {
  const auditPath = path.resolve(stringArg("audit-path", stringArg("audit_path", "")));
  const runDir = path.resolve(stringArg("run-dir", stringArg("run_dir", "")));
  if (!auditPath || !fs.existsSync(auditPath)) die("--audit-path is required");

  const fixReport = readJsonIfExists(path.join(runDir, "fix-execution-report.json"));
  const postFlight = readJsonIfExists(path.join(runDir, "post-flight-report.json"));
  const result = readJsonIfExists(path.join(runDir, "result.json"));
  const prUrl = firstPrUrl(fixReport) || firstPostFlightTarget(postFlight) || "";
  const status = String(
    args.status ??
      (fixReport?.status === "completed" || prUrl
        ? "pr_created_or_updated"
        : fixReport?.status
          ? `repair_${fixReport.status}`
          : "repair_not_run"),
  );

  const existing = fs.readFileSync(auditPath, "utf8");
  const addition = [
    "",
    "## Finalize",
    "",
    `- Status: \`${status}\``,
    `- Finalized at: ${new Date().toISOString()}`,
    prUrl ? `- PR: ${prUrl}` : "- PR: none",
    fixReport?.reason ? `- Reason: ${fixReport.reason}` : "",
    result?.summary ? `- Worker summary: ${result.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  fs.writeFileSync(auditPath, `${existing.replace(/\s+$/, "")}\n${addition}\n`, "utf8");
  console.log(JSON.stringify({ status, audit_path: relative(auditPath), pr_url: prUrl }, null, 2));
}

function intakeDecision({ enabled, report, reportMarkdown }: LooseRecord) {
  if (!truthy(enabled)) {
    return { status: "disabled", shouldRepair: false, reason: "commit finding intake disabled" };
  }
  if (report.result !== "findings") {
    return {
      status: "non_findings",
      shouldRepair: false,
      reason: `report result is ${report.result || "unknown"}`,
    };
  }
  const kinds = findingKinds(reportMarkdown);
  if (
    kinds.some((kind: string) => ["security", "privacy", "supply_chain"].includes(kind)) ||
    hasSecuritySignalText(reportMarkdown)
  ) {
    return {
      status: "security_route_only",
      shouldRepair: false,
      reason:
        "security/privacy/supply-chain signal is routed outside automatic ClawSweeper PR creation",
    };
  }
  const likelyFiles = likelyFilesFromReport(reportMarkdown);
  if (likelyFiles.length > 8) {
    return {
      status: "too_broad",
      shouldRepair: false,
      reason: `finding references ${likelyFiles.length} likely files; autonomous PR limit is 8`,
    };
  }
  return {
    status: "queued_for_repair",
    shouldRepair: true,
    reason: "finding is eligible for ClawSweeper repair",
  };
}

function writeJob(context: LooseRecord, reportMarkdown: JsonValue) {
  const sanitizedReport = sanitizeReportMarkdown(reportMarkdown);
  const body = `---
repo: ${context.targetRepo}
cluster_id: ${context.clusterId}
mode: autonomous
allowed_actions:
  - comment
  - label
  - fix
  - raise_pr
blocked_actions:
  - close
  - merge
require_human_for:
  - close
  - merge
canonical: []
candidates: []
cluster_refs: []
allow_instant_close: false
allow_fix_pr: true
allow_merge: false
allow_unmerged_fix_close: false
allow_post_merge_close: false
require_fix_before_close: false
security_policy: central_security_only
security_sensitive: false
target_branch: ${context.branch}
source: clawsweeper_commit
commit_sha: ${context.sha}
clawsweeper_report_repo: ${context.reportRepo}
clawsweeper_report_path: ${context.reportPath}
---

# ClawSweeper commit finding repair

ClawSweeper Repair should create or update one implementation PR from \`${context.branch}\`
if the finding is still valid on latest \`${context.targetRepo}@main\`.

## Operator Prompt

Use the ClawSweeper commit report below as the source finding. Do not redo a
broad audit of the commit. Check latest \`main\`, verify the reported problem is
still present, and make the narrowest safe fix. If latest \`main\` already fixed
it, make no code changes and report that outcome.

Do not merge. Do not close issues. Do not handle security-sensitive findings in
this lane.

## Commit Finding

- Commit: https://github.com/${context.targetRepo}/commit/${context.sha}
- Report: ${context.reportUrl}
- Latest main at intake: ${context.latestMain || "unknown"}

## ClawSweeper Report

\`\`\`md
${sanitizedReport.trim().slice(0, 80_000)}
\`\`\`
`;
  fs.mkdirSync(path.dirname(context.jobPath), { recursive: true });
  fs.writeFileSync(context.jobPath, body, "utf8");
  const errors = validateJob(parseJob(context.jobPath));
  if (errors.length) die(errors.join("\n"));
}

function writeSyntheticRun(context: LooseRecord) {
  fs.mkdirSync(context.runDir, { recursive: true });
  const likelyFiles = likelyFilesFromReport(context.report.body);
  const validation = validationCommands(context.targetRepo);
  const summary = summaryFromReport(context.report.body);
  const linkedRefs = [
    `https://github.com/${context.targetRepo}/commit/${context.sha}`,
    context.reportUrl,
  ];
  const clusterPlan = {
    repo: context.targetRepo,
    cluster_id: context.clusterId,
    mode: "autonomous",
    source_job: relative(context.jobPath),
    generated_at: context.preparedAt,
    offline: false,
    main: { branch: "main", oid: context.latestMain || null },
    security_boundary: {
      policy: "central_security_only",
      security_sensitive_items: [],
      action: "No security-sensitive signal detected by commit finding intake.",
    },
    scope: {
      seed_refs: [],
      linked_refs: [],
      context_refs: [],
      external_refs: [],
      expansion_policy: "Commit finding job; no issue/PR refs are hydrated.",
      hydrate_cluster_refs: false,
      max_linked_refs: 0,
      hydrate_comments: false,
      max_comments_per_item: 0,
      max_review_comments_per_pr: 0,
    },
    items: [],
    item_matrix: [],
    canonical_candidates: [],
    safety_gates: [
      "verify the ClawSweeper finding against latest main before changing code",
      "do not create a public PR for security-sensitive findings",
      "make the narrowest fix and run changed-surface validation",
    ],
  };
  const result = {
    status: "planned",
    repo: context.targetRepo,
    cluster_id: context.clusterId,
    mode: "autonomous",
    summary,
    actions: [
      {
        target: `cluster:${context.clusterId}`,
        action: "build_fix_artifact",
        status: "planned",
        idempotency_key: `clawsweeper-commit-finding:${context.targetRepo}:${context.sha}`,
        classification: null,
        target_kind: null,
        target_updated_at: null,
        canonical: null,
        duplicate_of: null,
        candidate_fix: null,
        comment: null,
        evidence: [
          `ClawSweeper report: ${context.reportUrl}`,
          `Commit: https://github.com/${context.targetRepo}/commit/${context.sha}`,
        ],
        reason: "ClawSweeper found an actionable commit-level bug/regression candidate.",
      },
    ],
    needs_human: [],
    canonical: null,
    canonical_issue: null,
    canonical_pr: null,
    merge_preflight: [],
    fix_artifact: {
      summary,
      affected_surfaces: affectedSurfaces(likelyFiles, context.report.body),
      likely_files: likelyFiles.length ? likelyFiles : ["unknown"],
      linked_refs: linkedRefs,
      validation_commands: validation,
      changelog_required: false,
      credit_notes: [
        `Detected by ClawSweeper commit review for ${context.sha}.`,
        context.report.author
          ? `Original commit author: ${stripEmailIdentity(context.report.author)}.`
          : "Original commit author unknown.",
      ],
      pr_title: commitFindingPrTitle(summary, context.report.body),
      pr_body: prBody({ ...context, summary, likelyFiles, validation }),
      source_prs: [],
      repair_strategy: "new_fix_pr",
      allow_no_pr: true,
      branch_update_blockers: [],
    },
  };
  fs.writeFileSync(
    path.join(context.runDir, "cluster-plan.json"),
    `${JSON.stringify(clusterPlan, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(context.runDir, "fix-artifact.json"),
    `${JSON.stringify(result.fix_artifact, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(context.runDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}

function writeAudit(context: LooseRecord, { phase }: LooseRecord) {
  fs.mkdirSync(path.dirname(context.auditPath), { recursive: true });
  const jobLine = context.decision.shouldRepair
    ? `- Job: \`${relative(context.jobPath)}\``
    : "- Job: none";
  const runLine = context.decision.shouldRepair
    ? `- Run dir: \`${relative(context.runDir)}\``
    : "- Run dir: none";
  const body = `---
repo: ${context.targetRepo}
sha: ${context.sha}
report_repo: ${context.reportRepo}
report_path: ${context.reportPath}
decision: ${context.decision.status}
prepared_at: ${context.preparedAt}
---

# Commit Finding ${context.sha.slice(0, 12)}

- Decision: \`${context.decision.status}\`
- Reason: ${context.decision.reason}
- Phase: ${phase}
- Commit: https://github.com/${context.targetRepo}/commit/${context.sha}
- Report: ${context.reportUrl}
- Latest main at intake: ${context.latestMain || "unknown"}
${jobLine}
${runLine}

## Finding Summary

${context.report.body ? summaryFromReport(context.report.body) : "Report was not fetched because commit finding intake is disabled."}
`;
  fs.writeFileSync(context.auditPath, body, "utf8");
}

function readReport({ reportRepo, reportPath }: LooseRecord) {
  const local = args["report-file"] ?? args.report_file;
  if (typeof local === "string") return fs.readFileSync(path.resolve(local), "utf8");
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${reportRepo}/contents/${reportPath}`,
      "--method",
      "GET",
      "-f",
      "ref=main",
      "--jq",
      ".content",
    ],
    {
      cwd: repoRoot(),
      encoding: "utf8",
      stdio: "pipe",
      env: process.env,
    },
  );
  if (result.status !== 0)
    die(result.stderr || result.stdout || `failed to fetch ${reportRepo}:${reportPath}`);
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString("utf8");
}

function parseCommitReport(markdown: string) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter: Record<string, unknown> = {};
  if (match) {
    for (const line of (match[1] ?? "").split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;
      frontmatter[kv[1] ?? ""] = stripQuotes(kv[2] ?? "");
    }
  }
  return {
    ...frontmatter,
    body: match ? markdown.slice(match[0].length) : markdown,
  };
}

function findingKinds(markdown: string) {
  return [
    ...new Set(
      [...markdown.matchAll(/^- Kind:\s*([A-Za-z0-9_| -]+)/gim)]
        .flatMap((match: JsonValue) => String(match[1] ?? "").split(/[|,]/))
        .map((kind: string) => kind.trim().toLowerCase().replaceAll("-", "_"))
        .filter(Boolean),
    ),
  ];
}

function likelyFilesFromReport(markdown: string) {
  const out: JsonValue[] = [];
  for (const match of markdown.matchAll(/^- File:\s*`?([^`\n]+?)`?\s*$/gim))
    out.push(match[1].trim());
  const changed = markdown.match(/^- Changed files:\s*(.+)$/im)?.[1] ?? "";
  for (const match of changed.matchAll(/`([^`]+)`/g)) out.push(match[1].trim());
  return unique(
    out.filter(
      (file: JsonValue) =>
        file && file !== "unknown" && !/^https?:/.test(file) && isExecutableRepairPath(file),
    ),
  ).slice(0, 20);
}

function affectedSurfaces(files: LooseRecord[], markdown: string) {
  const surfaces = new Set();
  for (const file of files) {
    const first = file.split("/")[0] || file;
    surfaces.add(first);
  }
  if (surfaces.size === 0) {
    for (const kind of findingKinds(markdown)) surfaces.add(kind);
  }
  return [...surfaces].filter(Boolean).slice(0, 8).length
    ? [...surfaces].filter(Boolean).slice(0, 8)
    : ["commit finding"];
}

function isExecutableRepairPath(file: JsonValue) {
  const value = String(file ?? "").trim();
  if (!value || value === "unknown" || /^https?:/i.test(value)) return false;
  if (/^(?:docs|examples|\.github\/ISSUE_TEMPLATE|\.agents\/skills)\//.test(value)) return false;
  if (
    /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|SUPPORT|LICENSE)(?:\.[A-Za-z0-9]+)?$/i.test(
      value,
    )
  ) {
    return false;
  }
  return true;
}

function summaryFromReport(markdown: string) {
  const summary = section(markdown, "Summary");
  if (summary) return compact(summary, 900);
  const heading = markdown.match(/^###\s+(?:Critical|High|Medium|Low):\s*(.+)$/im)?.[1];
  if (heading) return compact(heading, 900);
  const paragraph = markdown
    .replace(/^# .+$/m, "")
    .split(/\n{2,}/)
    .map((part: JsonValue) => part.trim())
    .find((part: JsonValue) => part && !part.startsWith("## "));
  return compact(paragraph || "Address ClawSweeper commit finding.", 900);
}

function section(markdown: string, heading: string) {
  const match = markdown.match(
    new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\n\\n([\\s\\S]*?)(?=\\n## |\\n?$)`, "i"),
  );
  return match?.[1]?.trim() ?? "";
}

function validationCommands(repo: string) {
  return repo === "openclaw/openclaw" ? ["pnpm check:changed"] : ["git diff --check"];
}

function prBody(context: LooseRecord) {
  const findings = findingsFromReport(context.report.body);
  const reviewed = sectionBullets(context.report.body, "Reviewed").slice(0, 6);
  const tests = sectionBullets(context.report.body, "Tests / Live Checks").slice(0, 6);
  const limitations = sectionBullets(context.report.body, "Limitations").slice(0, 4);
  const likelyFiles = context.likelyFiles.length
    ? context.likelyFiles
    : likelyFilesFromReport(context.report.body);
  const sourceLines = [
    `- ClawSweeper report: ${context.reportUrl}`,
    `- Commit under review: https://github.com/${context.targetRepo}/commit/${context.sha}`,
    `- Latest main at intake: ${context.latestMain || "unknown"}`,
    context.report.author
      ? `- Original commit author: ${stripEmailIdentity(context.report.author)}`
      : "",
    context.report.github_author ? `- GitHub author: @${context.report.github_author}` : "",
    context.report.highest_severity ? `- Highest severity: ${context.report.highest_severity}` : "",
    context.report.confidence ? `- Review confidence: ${context.report.confidence}` : "",
  ].filter(Boolean);

  return [
    "## Summary",
    "",
    context.summary,
    "",
    "## What ClawSweeper Is Fixing",
    "",
    ...renderFindingsForPr(findings),
    "",
    "## Expected Repair Surface",
    "",
    ...(likelyFiles.length
      ? likelyFiles.map((file: JsonValue) => `- \`${file}\``)
      : [
          "- ClawSweeper could not infer exact files from the report; keep the fix scoped to the verified finding.",
        ]),
    "",
    "## Source And Review Context",
    "",
    ...sourceLines,
    ...(reviewed.length > 0 ? ["", ...reviewed] : []),
    "",
    "## Expected validation",
    "",
    ...context.validation.map((command: JsonValue) => `- \`${command}\``),
    ...(tests.length > 0 ? ["", "ClawSweeper already ran:", ...tests] : []),
    ...(limitations.length > 0 ? ["", "Known review limits:", ...limitations] : []),
    "",
    "## ClawSweeper Guardrails",
    "",
    "- Re-check the finding against latest `main` before changing code.",
    "- Keep the patch to the narrowest behavior change and matching regression coverage.",
    "- Do not merge automatically; this PR stays for maintainer review.",
  ].join("\n");
}

function findingsFromReport(markdown: string) {
  const findingsSection = section(markdown, "Findings");
  if (!findingsSection) return [];
  const out: JsonValue[] = [];
  const findingPattern = /(?:^|\n)###\s+(.+?)\n([\s\S]*?)(?=\n###\s+|\n?$)/g;
  for (const match of findingsSection.matchAll(findingPattern)) {
    const body = match[2] ?? "";
    out.push({
      title: compact(match[1] ?? "Finding", 180),
      kind: lineField(body, "Kind"),
      file: lineField(body, "File"),
      line: lineField(body, "Line"),
      evidence: lineField(body, "Evidence"),
      impact: lineField(body, "Impact"),
      suggestedFix: lineField(body, "Suggested fix"),
      confidence: lineField(body, "Confidence"),
    });
  }
  return out.slice(0, 4);
}

function renderFindingsForPr(findings: LooseRecord[]) {
  if (findings.length === 0) {
    return ["- ClawSweeper found an actionable commit-level bug/regression candidate."];
  }
  const lines: JsonValue[] = [];
  for (const finding of findings) {
    lines.push(`- **${finding.title}**${finding.kind ? ` (${finding.kind})` : ""}`);
    if (finding.file)
      lines.push(
        `  - File: ${finding.line ? `\`${stripInlineCode(finding.file)}:${finding.line}\`` : `\`${stripInlineCode(finding.file)}\``}`,
      );
    if (finding.evidence) lines.push(`  - Evidence: ${compact(finding.evidence, 900)}`);
    if (finding.impact) lines.push(`  - Impact: ${compact(finding.impact, 700)}`);
    if (finding.suggestedFix)
      lines.push(`  - Suggested fix: ${compact(finding.suggestedFix, 700)}`);
    if (finding.confidence) lines.push(`  - Confidence: ${finding.confidence}`);
  }
  return lines;
}

function sectionBullets(markdown: string, heading: string) {
  return section(markdown, heading)
    .split(/\r?\n/)
    .map((line: JsonValue) => line.trim())
    .filter((line: JsonValue) => line.startsWith("- "))
    .map((line: JsonValue) => compact(line, 900));
}

function lineField(markdown: string, name: string) {
  const match = markdown.match(new RegExp(`^- ${escapeRegExp(name)}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function stripInlineCode(value: JsonValue) {
  return String(value ?? "")
    .replace(/^`|`$/g, "")
    .trim();
}

function fetchLatestMain(repo: string) {
  try {
    return ghText(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]);
  } catch {
    return "";
  }
}

function firstPrUrl(report: LooseRecord) {
  for (const action of report?.actions ?? []) {
    if (typeof action.pr_url === "string" && action.pr_url) return action.pr_url;
    if (typeof action.pr === "string" && action.pr.startsWith("http")) return action.pr;
  }
  return "";
}

function firstPostFlightTarget(report: LooseRecord) {
  for (const action of report?.actions ?? []) {
    if (typeof action.target === "string" && action.target.startsWith("http")) return action.target;
  }
  return "";
}

function writeStepOutputs(values: LooseRecord) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(
    output,
    Object.entries(values)
      .map(([key, value]: JsonValue[]) => `${key}=${value}\n`)
      .join(""),
  );
}

function stringArg(name: string, fallback: JsonValue) {
  const value = args[name];
  return typeof value === "string" && value.length ? value : fallback;
}

function assertSha(value: JsonValue) {
  if (!/^[0-9a-f]{40}$/i.test(value)) die(`invalid commit sha: ${value}`);
  return value.toLowerCase();
}

function repoSlug(repo: string) {
  return repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truthy(value: JsonValue) {
  return /^(?:true|1|yes|on)$/i.test(String(value ?? "").trim());
}

function stripQuotes(value: JsonValue) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function sanitizeReportMarkdown(markdown: string) {
  return String(markdown ?? "")
    .replace(/\s*<[^>\n]*@[^>\n]*>\s*/g, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/[ \t]+$/gm, "");
}

function stripEmailIdentity(value: JsonValue) {
  return String(value ?? "")
    .replace(/\s*<[^>\n]*@[^>\n]*>\s*/g, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: JsonValue, max: JsonValue) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function unique(values: LooseRecord[]) {
  return [...new Set(values)];
}

function relative(file: JsonValue) {
  return path.relative(repoRoot(), file).replaceAll("\\", "/");
}

function die(message: string) {
  console.error(`commit-finding-intake: ${message}`);
  process.exit(2);
}
