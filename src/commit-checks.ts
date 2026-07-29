import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runText } from "./command.js";

type CheckConclusion = "success" | "failure" | "neutral" | "timed_out";

export interface CommitReviewFrontMatter {
  [key: string]: string | string[] | undefined;
  sha?: string;
  repository?: string;
  author?: string;
  commit_authored_at?: string;
  commit_committed_at?: string;
  result?: string;
  confidence?: string;
  highest_severity?: string;
  check_conclusion?: string;
  reviewed_at?: string;
}

interface PublishCheckOptions {
  targetRepo: string;
  reportRepo: string;
  reportPath: string;
  reportRelativePath: string;
  sha: string;
  checkName: string;
}

function run(command: string, commandArgs: string[]): string {
  return runText(command, commandArgs);
}

export function splitFrontMatter(markdown: string): {
  frontMatter: CommitReviewFrontMatter;
  body: string;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontMatter: {}, body: markdown };
  const frontMatter: CommitReviewFrontMatter = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1] ?? "";
    let value = keyMatch[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    frontMatter[key] = value;
  }
  return { frontMatter, body: markdown.slice(match[0].length) };
}

export function checkConclusionForFrontMatter(
  frontMatter: CommitReviewFrontMatter,
): CheckConclusion {
  if (frontMatter.check_conclusion) {
    const conclusion = frontMatter.check_conclusion;
    if (
      conclusion === "success" ||
      conclusion === "failure" ||
      conclusion === "neutral" ||
      conclusion === "timed_out"
    ) {
      return conclusion;
    }
  }
  if (frontMatter.result === "nothing_found") return "success";
  if (frontMatter.result === "skipped_non_code") return "success";
  if (frontMatter.result === "findings") {
    return frontMatter.highest_severity === "critical" || frontMatter.highest_severity === "high"
      ? "failure"
      : "neutral";
  }
  return "neutral";
}

function reportTitle(frontMatter: CommitReviewFrontMatter): string {
  const result = frontMatter.result ?? "inconclusive";
  if (result === "nothing_found") return "Commit review: nothing found";
  if (result === "findings") return "Commit review: findings";
  if (result === "failed") return "Commit review failed";
  return "Commit review inconclusive";
}

function reportSummary(markdown: string, frontMatter: CommitReviewFrontMatter): string {
  const { body } = splitFrontMatter(markdown);
  const summary = body
    .replace(/^# .+$/m, "")
    .trim()
    .slice(0, 6000);
  return summary || reportTitle(frontMatter);
}

function checkRunsForCommit(targetRepo: string, sha: string, name: string): { id?: number }[] {
  const encodedName = encodeURIComponent(name);
  try {
    const raw = run("gh", [
      "api",
      `repos/${targetRepo}/commits/${sha}/check-runs?check_name=${encodedName}`,
      "--jq",
      ".check_runs",
    ]);
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as { id?: number }[]) : [];
  } catch {
    return [];
  }
}

export function publishCheckFromReport(options: PublishCheckOptions): void {
  const markdown = readFileSync(options.reportPath, "utf8");
  const { frontMatter } = splitFrontMatter(markdown);
  const conclusion = checkConclusionForFrontMatter(frontMatter);
  const reportUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY || "openclaw/clawsweeper"}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "https://clawsweeper.openclaw.ai/";
  const payload = {
    name: options.checkName,
    head_sha: options.sha,
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    details_url: reportUrl,
    output: {
      title: reportTitle(frontMatter),
      summary: reportSummary(markdown, frontMatter),
      text: `Canonical report: ${reportUrl}`,
    },
  };
  const payloadPath = join(
    dirname(options.reportPath),
    `${basename(options.reportPath, ".md")}.check-run.json`,
  );
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2), "utf8");
  const existing = checkRunsForCommit(options.targetRepo, options.sha, options.checkName).find(
    (checkRun) => checkRun.id,
  );
  if (existing?.id) {
    run("gh", [
      "api",
      `repos/${options.targetRepo}/check-runs/${existing.id}`,
      "--method",
      "PATCH",
      "--input",
      payloadPath,
    ]);
  } else {
    run("gh", [
      "api",
      `repos/${options.targetRepo}/check-runs`,
      "--method",
      "POST",
      "--input",
      payloadPath,
    ]);
  }
}
