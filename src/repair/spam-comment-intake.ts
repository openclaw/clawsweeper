#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonObject, JsonValue } from "./json-types.js";
import { asJsonObject } from "./json-types.js";
import {
  dispatchHttpError,
  flushDispatchActionEvents,
  runDispatchWithReceipt,
} from "./dispatch-action-receipts.js";
import { parseArgs, repoRoot } from "./lib.js";
import {
  deterministicSpamSignals,
  shouldSendToCheapModel,
  type SpamScanComment,
} from "./spam-scanner-core.js";
import { boolEnv, errorText, stringArg, stringOrNull } from "./openclaw-hook.js";

export type SpamCommentIntakeDecision =
  | {
      accepted: false;
      reason: string;
      comment: SpamScanComment | null;
      target_repo: string | null;
    }
  | {
      accepted: true;
      reason: string;
      target_repo: string;
      comment: SpamScanComment;
      dispatch_payload: SpamScannerDispatchPayload;
    };

export type SpamScannerDispatchPayload = {
  event_type: "clawsweeper_spam_comment";
  client_payload: {
    target_repo: string;
    comment_id?: string;
    review_comment_id?: string;
    max_comments: "1";
  };
};

export type SpamCommentIntakeSummary = {
  status: "ok" | "skipped" | "failed";
  dispatched: number;
  reason: string | null;
  decision: SpamCommentIntakeDecision | null;
};

const DEFAULT_REPORT_PATH = "notifications/spam-comment-intake-report.json";
const DEFAULT_DISPATCH_REPO = "openclaw/clawsweeper";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSpamCommentIntake(process.argv.slice(2))
    .then((summary) => {
      process.exitCode = summary.status === "failed" ? 1 : 0;
    })
    .catch((error) => {
      console.error(errorText(error));
      process.exitCode = 1;
    });
}

export async function runSpamCommentIntake(
  argv: string[],
  runtime: {
    root?: string;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    log?: (message: string) => void;
    now?: () => Date;
  } = {},
): Promise<SpamCommentIntakeSummary> {
  const args = parseArgs(argv);
  const root = runtime.root ?? repoRoot();
  const env = runtime.env ?? process.env;
  const log = runtime.log ?? console.log;
  const fetcher = runtime.fetch ?? fetch;
  const now = runtime.now ?? (() => new Date());
  const eventPath = stringArg(args.input) ?? env.GITHUB_EVENT_PATH;
  const eventName = stringArg(args.event) ?? env.GITHUB_EVENT_NAME;
  const reportPath = path.resolve(root, stringArg(args.report) ?? DEFAULT_REPORT_PATH);
  const writeReport = Boolean(args["write-report"]);
  const dryRun = Boolean(args["dry-run"] || boolEnv(env.CLAWSWEEPER_SPAM_INTAKE_DRY_RUN, false));
  const dispatchRepo = stringArg(args["dispatch-repo"]) ?? DEFAULT_DISPATCH_REPO;
  const token = stringArg(env.GH_TOKEN) ?? stringArg(env.GITHUB_TOKEN);

  if (!eventPath || !eventName || !fs.existsSync(eventPath)) {
    return finish({
      summary: {
        status: "skipped",
        dispatched: 0,
        reason: "GitHub event payload missing",
        decision: null,
      },
      writeReport,
      reportPath,
      now,
      log,
    });
  }

  const decision = classifySpamCommentActivity({
    eventName,
    payload: JSON.parse(fs.readFileSync(eventPath, "utf8")),
  });
  if (!decision.accepted) {
    return finish({
      summary: {
        status: "skipped",
        dispatched: 0,
        reason: decision.reason,
        decision,
      },
      writeReport,
      reportPath,
      now,
      log,
    });
  }
  if (dryRun) {
    return finish({
      summary: {
        status: "ok",
        dispatched: 0,
        reason: "dry run",
        decision,
      },
      writeReport,
      reportPath,
      now,
      log,
    });
  }
  if (!token) {
    return finish({
      summary: {
        status: "failed",
        dispatched: 0,
        reason: "GH_TOKEN or GITHUB_TOKEN is required",
        decision,
      },
      writeReport,
      reportPath,
      now,
      log,
    });
  }

  let dispatchError: unknown = null;
  try {
    await dispatchSpamScanner({
      fetcher,
      token,
      dispatchRepo,
      payload: decision.dispatch_payload,
      root,
      env,
    });
  } catch (error) {
    dispatchError = error;
  }
  try {
    await flushDispatchActionEvents(root, { env });
  } catch (error) {
    if (!dispatchError) dispatchError = error;
    else
      log(
        `[action-ledger] failed to finalize spam dispatch receipts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
  }
  if (dispatchError) throw dispatchError;
  return finish({
    summary: {
      status: "ok",
      dispatched: 1,
      reason: decision.reason,
      decision,
    },
    writeReport,
    reportPath,
    now,
    log,
  });
}

export function classifySpamCommentActivity({
  eventName,
  payload,
}: {
  eventName: string;
  payload: JsonValue;
}): SpamCommentIntakeDecision {
  const root = asJsonObject(payload);
  const clientPayload = asJsonObject(root.client_payload);
  const activity = activityPayload(root);
  const type =
    stringOrNull(activity.type) ??
    stringOrNull(clientPayload.event_name) ??
    (eventName === "repository_dispatch" ? null : eventName);
  const action =
    stringOrNull(activity.action) ??
    stringOrNull(clientPayload.action) ??
    stringOrNull(root.action);
  if (type !== "issue_comment" && type !== "pull_request_review_comment") {
    return {
      accepted: false,
      reason: `unsupported activity type: ${type}`,
      comment: null,
      target_repo: null,
    };
  }
  if (!["created", "edited"].includes(action ?? "")) {
    return {
      accepted: false,
      reason: `unsupported issue_comment action: ${action ?? "unknown"}`,
      comment: null,
      target_repo: null,
    };
  }

  const targetRepo = targetRepository(root, activity);
  const comment = spamCommentFromActivity(activity, targetRepo, type);
  if (!targetRepo) {
    return { accepted: false, reason: "missing target repository", comment, target_repo: null };
  }
  if (!comment.id) {
    return {
      accepted: false,
      reason: "missing issue comment id",
      comment,
      target_repo: targetRepo,
    };
  }
  if (!comment.body.trim()) {
    return {
      accepted: false,
      reason: "missing issue comment body",
      comment,
      target_repo: targetRepo,
    };
  }
  const deterministic = deterministicSpamSignals(comment);
  if (!shouldSendToCheapModel(comment)) {
    return {
      accepted: false,
      reason: deterministic.signals.length
        ? `protected or low-value candidate: ${deterministic.signals.join(", ")}`
        : "no deterministic spam signal",
      comment,
      target_repo: targetRepo,
    };
  }
  return {
    accepted: true,
    reason: `spam candidate: ${deterministic.signals.join(", ")}`,
    target_repo: targetRepo,
    comment,
    dispatch_payload: {
      event_type: "clawsweeper_spam_comment",
      client_payload: {
        target_repo: targetRepo,
        ...(comment.kind === "pull_request_review_comment"
          ? { review_comment_id: comment.id }
          : { comment_id: comment.id }),
        max_comments: "1",
      },
    },
  };
}

async function dispatchSpamScanner({
  fetcher,
  token,
  dispatchRepo,
  payload,
  root,
  env,
}: {
  fetcher: typeof fetch;
  token: string;
  dispatchRepo: string;
  payload: SpamScannerDispatchPayload;
  root: string;
  env: NodeJS.ProcessEnv;
}) {
  const commentId =
    payload.client_payload.comment_id ?? payload.client_payload.review_comment_id ?? "";
  await runDispatchWithReceipt({
    component: "spam_comment_intake",
    operationKey: `spam-comment:${payload.client_payload.target_repo}:${commentId}`,
    dispatchKind: "repository",
    repository: dispatchRepo,
    dispatchTarget: payload.event_type,
    dispatchInput: {
      event_type: payload.event_type,
      target_repo: payload.client_payload.target_repo,
      comment_kind: payload.client_payload.review_comment_id ? "review_comment" : "issue_comment",
      comment_id: commentId,
      max_comments: Number(payload.client_payload.max_comments),
    },
    root,
    env,
    operation: async () => {
      const response = await fetcher(`https://api.github.com/repos/${dispatchRepo}/dispatches`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "clawsweeper-spam-comment-intake",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw dispatchHttpError(
          response.status,
          `spam scanner dispatch failed with status ${response.status}`,
        );
      }
    },
  });
}

function activityPayload(root: JsonObject) {
  const clientPayload = asJsonObject(root.client_payload);
  const activity = asJsonObject(clientPayload.activity ?? clientPayload);
  if (Object.keys(activity).length > 0) return activity;
  return root;
}

function targetRepository(root: JsonObject, activity: JsonObject) {
  const clientPayload = asJsonObject(root.client_payload);
  const repo = asJsonObject(root.repository);
  return (
    stringOrNull(activity.target_repo) ??
    stringOrNull(activity.repo) ??
    stringOrNull(activity.repository) ??
    stringOrNull(asJsonObject(activity.repository).full_name) ??
    stringOrNull(clientPayload.target_repo) ??
    stringOrNull(clientPayload.repo) ??
    stringOrNull(clientPayload.repository) ??
    stringOrNull(asJsonObject(clientPayload.repository).full_name) ??
    stringOrNull(repo.full_name)
  );
}

function spamCommentFromActivity(
  activity: JsonObject,
  targetRepo: string | null,
  type: "issue_comment" | "pull_request_review_comment",
): SpamScanComment {
  const comment = asJsonObject(activity.comment);
  const issue = asJsonObject(activity.issue);
  const user = asJsonObject(comment.user);
  return {
    kind: type,
    id: stringValue(comment.id ?? activity.comment_id ?? activity.id),
    node_id: stringOrNull(comment.node_id ?? activity.comment_node_id),
    html_url: stringOrNull(comment.html_url ?? comment.url ?? activity.comment_url ?? activity.url),
    issue_url:
      type === "issue_comment"
        ? (stringOrNull(issue.url ?? activity.issue_url) ?? issueApiUrl(targetRepo, activity))
        : null,
    pull_request_url:
      type === "pull_request_review_comment"
        ? (stringOrNull(activity.pull_request_url) ?? subjectUrl(activity, "pull_request"))
        : null,
    body: String(
      comment.body ?? comment.body_excerpt ?? activity.body ?? activity.body_excerpt ?? "",
    ),
    author:
      stringOrNull(user.login) ??
      stringOrNull(comment.author) ??
      stringOrNull(activity.author) ??
      stringOrNull(activity.actor),
    author_association: String(
      comment.author_association ?? activity.author_association ?? "NONE",
    ).toUpperCase(),
    created_at: stringOrNull(comment.created_at ?? activity.created_at),
    updated_at: stringOrNull(comment.updated_at ?? activity.updated_at),
  };
}

function issueApiUrl(targetRepo: string | null, activity: JsonObject) {
  const number = Number(
    asJsonObject(activity.subject).number ?? asJsonObject(activity.issue).number ?? activity.number,
  );
  if (!targetRepo || !Number.isInteger(number) || number <= 0) return null;
  return `https://api.github.com/repos/${targetRepo}/issues/${number}`;
}

function subjectUrl(activity: JsonObject, kind: string) {
  const subject = asJsonObject(activity.subject);
  if (stringOrNull(subject.kind) !== kind) return null;
  return stringOrNull(subject.url);
}

function stringValue(value: JsonValue) {
  const text = String(value ?? "").trim();
  return text;
}

function finish({
  summary,
  writeReport,
  reportPath,
  now,
  log,
}: {
  summary: SpamCommentIntakeSummary;
  writeReport: boolean;
  reportPath: string;
  now: () => Date;
  log: (message: string) => void;
}) {
  if (writeReport) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify({ ...summary, generated_at: now().toISOString() }, null, 2)}\n`,
    );
  }
  log(JSON.stringify(summary));
  return summary;
}
