#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CLAWSWEEPER_APP_BOT_LOGINS } from "../clawsweeper-bot-identity.ts";
import { boolEnv, stringOrNull } from "../value-coerce.ts";
import type { JsonObject, JsonValue } from "./json-types.ts";
import { asJsonObject } from "./json-types.ts";
import { writeJsonFile } from "./json-file.ts";
import { repoRoot } from "./paths.ts";

export type GithubActivity = {
  type: string;
  action: string | null;
  repo: string;
  actor: string | null;
  url: string | null;
  subject: {
    kind: string;
    number: number | null;
    title: string | null;
    url: string | null;
    state: string | null;
  };
  summary: string;
  idempotencyKey: string;
  payload: JsonObject;
};

export type GithubActivityNotifierSummary = {
  status: "ok" | "skipped";
  sent: number;
  failed: number;
  exitCode: number;
  reason: string | null;
};

export const DEFAULT_REPORT_PATH = "notifications/github-activity-report.json";
const BODY_EXCERPT_LIMIT = 1200;
const CLAWSWEEPER_COMMAND_RE =
  /(^|\s)(@(clawsweeper|openclaw-clawsweeper)(\[bot\])?\b|\/(clawsweeper|review|re-review|re-run|rerun|automerge|autoclose)\b)/i;

export function normalizeGithubActivity({
  eventName,
  payload,
  env = process.env,
}: {
  eventName: string;
  payload: JsonValue;
  env?: NodeJS.ProcessEnv;
}): GithubActivity | null {
  const root = asJsonObject(payload);
  if (eventName === "repository_dispatch") {
    return normalizeRepositoryDispatch(root, env);
  }

  const repo = repositoryName(root, env);
  const actor = actorName(root, env);
  const action = stringOrNull(root.action);
  switch (eventName) {
    case "issues":
      return buildActivity({
        eventName,
        action,
        repo,
        actor,
        subject: issueSubject(asJsonObject(root.issue)),
        payload: compactPayload({
          issue: root.issue,
          label: root.label,
          assignee: root.assignee,
        }),
        seed: timestampSeed(root.issue, env),
      });
    case "issue_comment": {
      const issue = asJsonObject(root.issue);
      const comment = asJsonObject(root.comment);
      return buildActivity({
        eventName,
        action,
        repo,
        actor,
        subject: issueSubject(issue, issue.pull_request ? "pull_request" : "issue"),
        payload: compactPayload({
          issue,
          comment: compactComment(comment),
        }),
        seed: stringOrNull(comment.id) ?? timestampSeed(comment, env),
      });
    }
    case "pull_request":
    case "pull_request_target": {
      const pr = asJsonObject(root.pull_request);
      return buildActivity({
        eventName,
        action,
        repo,
        actor,
        subject: pullRequestSubject(pr),
        payload: compactPayload({
          pull_request: compactPullRequest(pr),
          changes: root.changes,
          label: root.label,
        }),
        seed: stringOrNull(pr.head?.sha) ?? timestampSeed(pr, env),
      });
    }
    case "pull_request_review": {
      const pr = asJsonObject(root.pull_request);
      const review = asJsonObject(root.review);
      return buildActivity({
        eventName,
        action,
        repo,
        actor,
        subject: pullRequestSubject(pr),
        payload: compactPayload({
          pull_request: compactPullRequest(pr),
          review: {
            id: review.id ?? null,
            author: review.user?.login ?? null,
            state: review.state ?? null,
            url: review.html_url ?? null,
            body_excerpt: excerpt(review.body),
          },
        }),
        seed: stringOrNull(review.id) ?? timestampSeed(review, env),
      });
    }
    case "pull_request_review_comment": {
      const pr = asJsonObject(root.pull_request);
      const comment = asJsonObject(root.comment);
      return buildActivity({
        eventName,
        action,
        repo,
        actor,
        subject: pullRequestSubject(pr),
        payload: compactPayload({
          pull_request: compactPullRequest(pr),
          comment: {
            id: comment.id ?? null,
            author: comment.user?.login ?? null,
            path: comment.path ?? null,
            line: comment.line ?? comment.original_line ?? null,
            url: comment.html_url ?? null,
            body_excerpt: excerpt(comment.body),
          },
        }),
        seed: stringOrNull(comment.id) ?? timestampSeed(comment, env),
      });
    }
    case "check_suite": {
      const suite = asJsonObject(root.check_suite);
      return buildActivity({
        eventName,
        action,
        repo,
        actor,
        subject: {
          kind: "check_suite",
          number: null,
          title: stringOrNull(suite.app?.name) ?? "check suite",
          url: stringOrNull(suite.check_runs_url) ?? null,
          state: stringOrNull(suite.conclusion) ?? stringOrNull(suite.status),
        },
        payload: compactPayload({
          check_suite: {
            id: suite.id ?? null,
            status: suite.status ?? null,
            conclusion: suite.conclusion ?? null,
            head_sha: suite.head_sha ?? null,
            app: suite.app?.name ?? null,
          },
        }),
        seed: stringOrNull(suite.id) ?? stringOrNull(suite.head_sha) ?? env.GITHUB_RUN_ID,
      });
    }
    case "check_run": {
      const check = asJsonObject(root.check_run);
      return buildActivity({
        eventName,
        action,
        repo,
        actor,
        subject: {
          kind: "check_run",
          number: null,
          title: stringOrNull(check.name) ?? "check run",
          url: stringOrNull(check.html_url),
          state: stringOrNull(check.conclusion) ?? stringOrNull(check.status),
        },
        payload: compactPayload({
          check_run: {
            id: check.id ?? null,
            name: check.name ?? null,
            status: check.status ?? null,
            conclusion: check.conclusion ?? null,
            head_sha: check.head_sha ?? null,
            url: check.html_url ?? null,
          },
        }),
        seed: stringOrNull(check.id) ?? stringOrNull(check.head_sha) ?? env.GITHUB_RUN_ID,
      });
    }
    case "workflow_run": {
      const run = asJsonObject(root.workflow_run);
      return buildActivity({
        eventName,
        action,
        repo,
        actor,
        subject: {
          kind: "workflow_run",
          number: numberOrNull(run.run_number),
          title: stringOrNull(run.name) ?? "workflow run",
          url: stringOrNull(run.html_url),
          state: stringOrNull(run.conclusion) ?? stringOrNull(run.status),
        },
        payload: compactPayload({
          workflow_run: {
            id: run.id ?? null,
            name: run.name ?? null,
            event: run.event ?? null,
            status: run.status ?? null,
            conclusion: run.conclusion ?? null,
            head_sha: run.head_sha ?? null,
            url: run.html_url ?? null,
          },
        }),
        seed: stringOrNull(run.id) ?? stringOrNull(run.head_sha) ?? env.GITHUB_RUN_ID,
      });
    }
    default:
      return null;
  }
}

export function routineGithubActivityReason(activity: GithubActivity): string | null {
  const typeAction = `${activity.type}.${activity.action ?? "none"}`;
  if (
    ["issue_comment", "pull_request_review_comment", "pull_request_review"].includes(
      activity.type,
    ) &&
    isTrustedClawSweeperAuthoredActivity(activity)
  ) {
    return "routine GitHub activity filtered: ClawSweeper-authored comment or review";
  }
  const commandLike = activityContainsClawSweeperCommand(activity);
  if (typeAction === "issue_comment.edited" && !commandLike) {
    return "routine GitHub activity filtered: issue comment edit";
  }
  if (activity.type === "issue_comment" && isBotActor(activity.actor) && !commandLike) {
    return "routine GitHub activity filtered: bot issue comment";
  }
  if (
    (activity.action === "labeled" ||
      activity.action === "unlabeled" ||
      activity.action === "assigned" ||
      activity.action === "unassigned") &&
    isBotActor(activity.actor)
  ) {
    return `routine GitHub activity filtered: bot ${activity.action}`;
  }
  if (
    (activity.type === "pull_request" || activity.type === "pull_request_target") &&
    activity.action === "synchronize"
  ) {
    return "routine GitHub activity filtered: pull request synchronize";
  }
  if (
    (activity.type === "issues" ||
      activity.type === "pull_request" ||
      activity.type === "pull_request_target") &&
    activity.action === "edited" &&
    !commandLike
  ) {
    return "routine GitHub activity filtered: metadata edit";
  }
  if (
    (activity.type === "check_run" ||
      activity.type === "check_suite" ||
      activity.type === "workflow_run") &&
    successfulState(activity.subject.state)
  ) {
    return "routine GitHub activity filtered: successful automation event";
  }
  return null;
}

function isBotActor(actor: string | null): boolean {
  return typeof actor === "string" && (actor.endsWith("[bot]") || actor === "github-actions");
}

function successfulState(state: string | null): boolean {
  return /^(success|successful|neutral|skipped)$/i.test(state ?? "");
}

function activityContainsClawSweeperCommand(activity: GithubActivity): boolean {
  return CLAWSWEEPER_COMMAND_RE.test(activityText(activity));
}

function isTrustedClawSweeperAuthoredActivity(activity: GithubActivity): boolean {
  const authored =
    activity.type === "pull_request_review" ? activity.payload.review : activity.payload.comment;
  const author = stringOrNull(asJsonObject(authored).author);
  return (
    isTrustedClawSweeperBot(activity.actor) &&
    isTrustedClawSweeperBot(author) &&
    activity.actor?.toLowerCase() === author?.toLowerCase()
  );
}

function isTrustedClawSweeperBot(login: string | null): boolean {
  return typeof login === "string" && CLAWSWEEPER_APP_BOT_LOGINS.has(login.toLowerCase());
}

function activityText(activity: GithubActivity): string {
  return [
    activity.subject.title,
    stringOrNull(activity.payload.body_excerpt),
    stringOrNull(asJsonObject(activity.payload.comment).body_excerpt),
    stringOrNull(asJsonObject(activity.payload.review).body_excerpt),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function normalizeRepositoryDispatch(
  root: JsonObject,
  env: NodeJS.ProcessEnv,
): GithubActivity | null {
  const clientPayload = asJsonObject(root.client_payload);
  const activityPayload = asJsonObject(clientPayload.activity ?? clientPayload);
  const explicitEvent =
    stringOrNull(clientPayload.event_name) ?? stringOrNull(activityPayload.type);
  const eventName = explicitEvent ?? "github_activity";
  const repo =
    stringOrNull(activityPayload.repo) ??
    stringOrNull(activityPayload.repository) ??
    stringOrNull(clientPayload.repository) ??
    repositoryName(root, env);
  const actor =
    stringOrNull(activityPayload.actor) ??
    stringOrNull(clientPayload.actor) ??
    actorName(root, env);
  const subjectRaw = asJsonObject(activityPayload.subject);
  const subject = {
    kind:
      stringOrNull(subjectRaw.kind) ?? stringOrNull(activityPayload.subject_kind) ?? "repository",
    number: numberOrNull(subjectRaw.number ?? activityPayload.number),
    title: stringOrNull(subjectRaw.title) ?? stringOrNull(activityPayload.title),
    url: stringOrNull(subjectRaw.url) ?? stringOrNull(activityPayload.url),
    state: stringOrNull(subjectRaw.state) ?? stringOrNull(activityPayload.state),
  };
  return buildActivity({
    eventName,
    action: stringOrNull(activityPayload.action) ?? stringOrNull(clientPayload.action),
    repo,
    actor,
    subject,
    payload: compactPayload(activityPayload),
    seed:
      stringOrNull(activityPayload.idempotency_key) ??
      stringOrNull(activityPayload.delivery_id) ??
      stringOrNull(activityPayload.updated_at) ??
      env.GITHUB_RUN_ID,
  });
}

function buildActivity(params: {
  eventName: string;
  action: string | null;
  repo: string;
  actor: string | null;
  subject: GithubActivity["subject"];
  payload: JsonObject;
  seed?: string | null | undefined;
}): GithubActivity {
  const action = params.action;
  const subjectId =
    params.subject.number !== null
      ? `${params.subject.kind}-${params.subject.number}`
      : (params.subject.url ?? params.subject.title ?? params.subject.kind);
  const seed = params.seed ?? params.payload.id ?? params.payload.updated_at ?? "unknown";
  const idempotencyKey = [
    "github-activity",
    params.repo,
    params.eventName,
    action ?? "none",
    subjectId,
    String(seed),
  ].join(":");
  return {
    type: params.eventName,
    action,
    repo: params.repo,
    actor: params.actor,
    url: params.subject.url,
    subject: params.subject,
    summary: renderSummary(params.eventName, action, params.repo, params.subject),
    idempotencyKey,
    payload: params.payload,
  };
}

function renderSummary(
  eventName: string,
  action: string | null,
  repo: string,
  subject: GithubActivity["subject"],
): string {
  const number = subject.number ? ` #${subject.number}` : "";
  const title = subject.title ? ` ${subject.title}` : "";
  return `${repo}: ${eventName}${action ? `.${action}` : ""} ${subject.kind}${number}${title}`.trim();
}

function repositoryName(root: JsonObject, env: NodeJS.ProcessEnv): string {
  const repository = asJsonObject(root.repository);
  return (
    stringOrNull(repository.full_name) ??
    stringOrNull(root.repository) ??
    stringOrNull(env.GITHUB_REPOSITORY) ??
    "unknown/unknown"
  );
}

function actorName(root: JsonObject, env: NodeJS.ProcessEnv): string | null {
  const sender = asJsonObject(root.sender);
  return stringOrNull(sender.login) ?? stringOrNull(root.actor) ?? stringOrNull(env.GITHUB_ACTOR);
}

function issueSubject(
  issue: JsonObject,
  kind: "issue" | "pull_request" = "issue",
): GithubActivity["subject"] {
  return {
    kind,
    number: numberOrNull(issue.number),
    title: stringOrNull(issue.title),
    url: stringOrNull(issue.html_url),
    state: stringOrNull(issue.state),
  };
}

function pullRequestSubject(pr: JsonObject): GithubActivity["subject"] {
  return {
    kind: "pull_request",
    number: numberOrNull(pr.number),
    title: stringOrNull(pr.title),
    url: stringOrNull(pr.html_url),
    state:
      pr.merged === true
        ? "merged"
        : (stringOrNull(pr.state) ?? (pr.draft === true ? "draft" : null)),
  };
}

function compactPullRequest(pr: JsonObject): JsonObject {
  return compactPayload({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: pr.merged,
    draft: pr.draft,
    url: pr.html_url,
    base: pr.base?.ref,
    head: pr.head?.ref,
    head_repo: pr.head?.repo?.full_name,
    head_sha: pr.head?.sha,
    labels: labels(pr.labels),
    body_excerpt: excerpt(pr.body),
  });
}

function compactComment(comment: JsonObject): JsonObject {
  return compactPayload({
    id: comment.id,
    url: comment.html_url,
    author: comment.user?.login,
    body_excerpt: excerpt(comment.body),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  });
}

function compactPayload(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: JsonObject = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    if (typeof raw === "string" && raw.length > BODY_EXCERPT_LIMIT) {
      out[key] = excerpt(raw);
    } else {
      out[key] = raw as JsonValue;
    }
  }
  return out;
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => stringOrNull(asJsonObject(label).name) ?? stringOrNull(label))
    .filter((label): label is string => Boolean(label));
}

function excerpt(value: unknown): string | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= BODY_EXCERPT_LIMIT) return normalized;
  return `${normalized.slice(0, BODY_EXCERPT_LIMIT - 1)}...`;
}

function timestampSeed(value: unknown, env: NodeJS.ProcessEnv): string | null {
  const object = asJsonObject(value);
  return (
    stringOrNull(object.updated_at) ??
    stringOrNull(object.created_at) ??
    stringOrNull(object.id) ??
    stringOrNull(env.GITHUB_RUN_ID)
  );
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function githubActivitySummary(
  status: "ok" | "skipped",
  sent: number,
  failed: number,
  reason: string | null,
): GithubActivityNotifierSummary {
  return { status, sent, failed, exitCode: 0, reason };
}

export type GithubActivityAdmission =
  | {
      admitted: true;
      activity: GithubActivity;
      observedAt: string;
      eventName: string;
      eventPath: string;
    }
  | { admitted: false; summary: GithubActivityNotifierSummary };

export function prepareGithubActivity({
  root = repoRoot(),
  env = process.env,
  eventPath = env.GITHUB_EVENT_PATH,
  eventName = env.GITHUB_EVENT_NAME,
  reportPath = path.resolve(root, DEFAULT_REPORT_PATH),
  dryRun = env.CLAWSWEEPER_GITHUB_ACTIVITY_DRY_RUN === "1",
  deliver = boolEnv(env.CLAWSWEEPER_GITHUB_ACTIVITY_DELIVER, false),
  writeReport = false,
  now = () => new Date(),
}: {
  root?: string;
  env?: NodeJS.ProcessEnv;
  eventPath?: string | undefined;
  eventName?: string | undefined;
  reportPath?: string;
  dryRun?: boolean;
  deliver?: boolean;
  writeReport?: boolean;
  now?: () => Date;
} = {}): GithubActivityAdmission {
  if (!eventPath || !eventName || !fs.existsSync(eventPath)) {
    return {
      admitted: false,
      summary: githubActivitySummary("skipped", 0, 0, "GitHub event payload missing"),
    };
  }
  const activity = normalizeGithubActivity({
    eventName,
    payload: JSON.parse(fs.readFileSync(eventPath, "utf8")),
    env,
  });
  if (!activity) {
    return {
      admitted: false,
      summary: githubActivitySummary("skipped", 0, 0, `unsupported GitHub event: ${eventName}`),
    };
  }
  const observedAt = now().toISOString();
  const reason = routineGithubActivityReason(activity);
  if (!reason) return { admitted: true, activity, observedAt, eventName, eventPath };
  if (writeReport) {
    writeJsonFile(reportPath, {
      version: 1,
      generated_at: observedAt,
      event_name: eventName,
      event_path: path.relative(root, eventPath),
      dry_run: dryRun,
      deliver,
      hook_run_id: null,
      failed: 0,
      reason,
      activity,
    });
  }
  return { admitted: false, summary: githubActivitySummary("skipped", 0, 0, reason) };
}

// Keep the workflow's cheap admission and the notifier on one policy owner.
// Routine events must finish before loading hook configuration or package-backed code.
export function runGithubActivityPreflight(
  env: NodeJS.ProcessEnv = process.env,
  root = repoRoot(),
): GithubActivityAdmission {
  const admission = prepareGithubActivity({ env, root, writeReport: true });
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `admitted=${admission.admitted}\n`);
  }
  if (!admission.admitted) console.log(JSON.stringify(admission.summary));
  return admission;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runGithubActivityPreflight();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
