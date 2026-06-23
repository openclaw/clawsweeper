#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { parseArgs, parseJob } from "./lib.js";

export type ActionWorkKind = "issue_to_pr" | "pr_repair" | "repair_cluster";

export function actionWorkKind(frontmatter: LooseRecord): ActionWorkKind {
  if (
    frontmatter.job_intent === "implement_issue" ||
    frontmatter.source === "issue_implementation"
  ) {
    return "issue_to_pr";
  }
  if (
    frontmatter.job_intent === "automerge_pr" ||
    frontmatter.job_intent === "pr_repair" ||
    frontmatter.source === "pr_automerge" ||
    String(frontmatter.cluster_id ?? "").startsWith("automerge-") ||
    String(frontmatter.cluster_id ?? "").startsWith("repair-pr-")
  ) {
    return "pr_repair";
  }
  return "repair_cluster";
}

export function actionSourceUrl(job: ReturnType<typeof parseJob>): string {
  const explicit = job.raw.match(
    /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+/,
  )?.[0];
  if (explicit) return explicit;
  const repo = String(job.frontmatter.repo ?? "");
  const ref = [...(job.frontmatter.canonical ?? []), ...(job.frontmatter.candidates ?? [])][0];
  const number = String(ref ?? "").replace(/^#/, "");
  return repo && /^\d+$/.test(number) ? `https://github.com/${repo}/issues/${number}` : "";
}

export function actionWorkKey(frontmatter: LooseRecord): string {
  return `${String(frontmatter.repo ?? "")}:${String(frontmatter.cluster_id ?? "")}`;
}

export function actionSessionOwner(env: NodeJS.ProcessEnv = process.env): string {
  const owner = String(env.CLAWSWEEPER_CRABFLEET_OWNER ?? "").trim();
  if (!owner) throw new Error("action session requires a configured CrabFleet owner");
  return owner;
}

export function actionRunUrl(env: NodeJS.ProcessEnv = process.env): string {
  const server = String(env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const repository = String(env.GITHUB_REPOSITORY ?? "");
  const runId = String(env.GITHUB_RUN_ID ?? "");
  return repository && runId ? `${server}/${repository}/actions/runs/${runId}` : "";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === "register") {
    await registerActionSession(String(args._[1] ?? ""));
    return;
  }
  if (command === "update") {
    await updateActionSession({
      state: String(args.state ?? ""),
      phase: String(args.phase ?? ""),
      summary: String(args.summary ?? ""),
      completionReason: String(args["completion-reason"] ?? ""),
    });
    return;
  }
  throw new Error(
    "usage: action-session register <job.md> | update --state <state> --phase <phase> --summary <summary>",
  );
}

async function registerActionSession(jobPath: string): Promise<void> {
  if (!jobPath) throw new Error("action-session register requires a job path");
  const serviceToken = requiredEnv("CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN");
  const baseUrl = String(
    process.env.CLAWSWEEPER_CRABFLEET_URL ?? "https://crabfleet.openclaw.ai",
  ).replace(/\/+$/, "");
  const job = parseJob(jobPath);
  const sourceUrl = actionSourceUrl(job);
  const response = await fetch(`${baseUrl}/api/openclaw/action-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workKey: actionWorkKey(job.frontmatter),
      workKind: actionWorkKind(job.frontmatter),
      owner: actionSessionOwner(),
      repo: String(job.frontmatter.repo ?? ""),
      branch: String(job.frontmatter.target_branch ?? process.env.GITHUB_REF_NAME ?? ""),
      sourceUrl,
      runUrl: actionRunUrl(),
      purpose:
        actionWorkKind(job.frontmatter) === "issue_to_pr"
          ? "Convert issue to pull request"
          : actionWorkKind(job.frontmatter) === "pr_repair"
            ? "Repair pull request"
            : "Review and repair related GitHub items",
      summary: `GitHub Actions work for ${String(job.frontmatter.cluster_id ?? job.relativePath)}`,
    }),
  });
  const body = (await response.json()) as LooseRecord;
  if (!response.ok) {
    throw new Error(
      `CrabFleet action session registration failed (${response.status}): ${String(body.error ?? "unknown error")}`,
    );
  }
  const session = body.session as LooseRecord;
  const sessionId = String(session?.id ?? "");
  const agentToken = String(body.agentToken ?? "");
  const runnerPtyUrl = String(body.runnerPtyUrl ?? "");
  if (!sessionId || !agentToken || !runnerPtyUrl) {
    throw new Error("CrabFleet action session response is missing session credentials");
  }
  const workStateUrl =
    String(body.workStateUrl ?? "") ||
    `${baseUrl}/api/agent/interactive-sessions/${encodeURIComponent(sessionId)}/work-state`;
  const browserUrl =
    String(body.browserUrl ?? "") || `${baseUrl}/?session=${encodeURIComponent(sessionId)}`;
  console.log(`::add-mask::${agentToken}`);
  console.log(`::add-mask::${runnerPtyUrl}`);
  writeGitHubEnv({
    CLAWSWEEPER_CRABFLEET_SESSION_ID: sessionId,
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: agentToken,
    CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL: runnerPtyUrl,
    CLAWSWEEPER_CRABFLEET_WORK_STATE_URL: workStateUrl,
    CLAWSWEEPER_CRABFLEET_BROWSER_URL: browserUrl,
  });
  const metadataPath =
    process.env.CLAWSWEEPER_ACTION_SESSION_METADATA?.trim() ||
    path.join(".clawsweeper-repair", "action-session.json");
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        sessionId,
        workKey: actionWorkKey(job.frontmatter),
        workKind: actionWorkKind(job.frontmatter),
        sourceUrl,
        runUrl: actionRunUrl(),
        browserUrl,
        registeredAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`CrabFleet action session: ${browserUrl}`);
}

async function updateActionSession({
  state,
  phase,
  summary,
  completionReason,
}: {
  state: string;
  phase: string;
  summary: string;
  completionReason: string;
}): Promise<void> {
  const url = requiredEnv("CLAWSWEEPER_CRABFLEET_WORK_STATE_URL");
  const token = requiredEnv("CLAWSWEEPER_CRABFLEET_AGENT_TOKEN");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      state,
      phase,
      summary,
      ...(completionReason ? { completionReason } : {}),
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `CrabFleet work-state update failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
}

function writeGitHubEnv(values: Record<string, string>): void {
  const envPath = requiredEnv("GITHUB_ENV");
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${key} contains a newline`);
    fs.appendFileSync(envPath, `${key}=${value}\n`, "utf8");
  }
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: JsonValue) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
