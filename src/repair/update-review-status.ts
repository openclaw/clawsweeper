#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { ghJsonWithRetry, ghText } from "./github-cli.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { repoRoot } from "./paths.js";
import { DEFAULT_TRUSTED_BOTS } from "./config.js";
import {
  commaSet,
  isAllowedMutationActor,
  issueNumberFromUrl,
  writePayload,
} from "./comment-router-utils.js";

const REVIEW_PROGRESS_START = "<!-- clawsweeper-review-progress:start -->";
const REVIEW_PROGRESS_END = "<!-- clawsweeper-review-progress:end -->";

export type TerminalReviewFailureReason = "findings" | "incomplete_source" | "source_incompatible";

type Options = {
  repo: string;
  itemNumber: number;
  statusCommentId: number;
  trustedBots: Set<string>;
  state: "reviewing" | "complete" | "closed" | "blocked";
  failureReason: TerminalReviewFailureReason | null;
  runUrl: string;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await runReviewStatusUpdate(parseOptions(process.argv.slice(2)));
}

export function terminalReviewStatusCopy(reason: TerminalReviewFailureReason) {
  switch (reason) {
    case "findings":
      return {
        reason:
          "The input-safety check rejected material in this revision. No detected value, path, or scanner output is reproduced here.",
        next: "If this is a genuine credential, remove and rotate it. If it is an intentional test fixture, a maintainer must review and qualify it.",
      };
    case "source_incompatible":
      return {
        reason: "This revision does not contain a valid exact Codex version pin.",
        next: "Update or rebase the revision, then request a fresh review.",
      };
    case "incomplete_source":
      return {
        reason: "ClawSweeper could not verify the complete source for this revision.",
        next: "No contributor action is requested. Maintainers should inspect the linked workflow run.",
      };
  }
}

export function renderReviewProgressSection(
  options: Pick<Options, "state" | "failureReason" | "runUrl">,
) {
  if (options.state === "reviewing") {
    return [
      REVIEW_PROGRESS_START,
      "### ClawSweeper review in progress",
      "",
      "ClawSweeper is reviewing this revision. This supersedes any previous blocked status.",
      ...(options.runUrl ? ["", `[View the workflow run](${options.runUrl}).`] : []),
      REVIEW_PROGRESS_END,
    ].join("\n");
  }
  if (options.state === "complete") {
    return [
      REVIEW_PROGRESS_START,
      "### ClawSweeper review complete",
      "",
      "ClawSweeper finished reviewing this revision. The review result is being finalized.",
      ...(options.runUrl ? ["", `[View the workflow run](${options.runUrl}).`] : []),
      REVIEW_PROGRESS_END,
    ].join("\n");
  }
  if (options.state === "closed") {
    return [
      REVIEW_PROGRESS_START,
      "### ClawSweeper review ended",
      "",
      "ClawSweeper stopped reviewing this revision because the pull request closed.",
      ...(options.runUrl ? ["", `[View the workflow run](${options.runUrl}).`] : []),
      REVIEW_PROGRESS_END,
    ].join("\n");
  }
  if (!options.failureReason) throw new Error("blocked review status requires a failure reason");
  const copy = terminalReviewStatusCopy(options.failureReason);
  return [
    REVIEW_PROGRESS_START,
    "### ClawSweeper review blocked",
    "",
    "Automated review did not run, so no review verdict was produced.",
    "",
    `**Reason:** ${copy.reason}`,
    "",
    "ClawSweeper will not retry this unchanged revision.",
    "",
    `**Next step:** ${copy.next}`,
    ...(options.runUrl ? ["", `[View the workflow run](${options.runUrl}).`] : []),
    REVIEW_PROGRESS_END,
  ].join("\n");
}

export function mergeReviewProgressSection(
  body: string,
  options: Pick<Options, "state" | "failureReason" | "runUrl">,
) {
  const section = renderReviewProgressSection(options);
  const start = body.indexOf(REVIEW_PROGRESS_START);
  const end = body.indexOf(REVIEW_PROGRESS_END);
  if (start >= 0 && end > start) {
    return `${body.slice(0, start).trimEnd()}\n\n${section}\n${body
      .slice(end + REVIEW_PROGRESS_END.length)
      .trimStart()}`.trimEnd();
  }
  return `${body.trimEnd()}\n\n${section}`;
}

async function runReviewStatusUpdate(options: Options) {
  const comment = fetchReviewAcknowledgement(options);
  const body = mergeReviewProgressSection(String(comment.body), options);
  const updated =
    body === comment.body
      ? comment
      : JSON.parse(
          ghText([
            "api",
            `repos/${options.repo}/issues/comments/${options.statusCommentId}`,
            "--method",
            "PATCH",
            "--input",
            writePayload(repoRoot(), `review-status-${options.statusCommentId}`, { body }),
          ]),
        );
  const commentId = Number(updated.id);
  const completedAt = String(updated.updated_at || "").trim();
  if (!reviewStatusMutationReceiptIsValid(updated, options.statusCommentId, body)) {
    throw new Error("review status mutation could not be verified");
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        "review_status_verified=true",
        `review_status_comment_id=${commentId}`,
        `review_status_completed_at=${new Date(Date.parse(completedAt)).toISOString()}`,
        "",
      ].join("\n"),
    );
  }
}

export function reviewStatusMutationReceiptIsValid(
  updated: LooseRecord,
  expectedCommentId: number,
  expectedBody: string,
) {
  return (
    Number(updated.id) === expectedCommentId &&
    Number.isFinite(Date.parse(String(updated.updated_at || "").trim())) &&
    updated.body === expectedBody
  );
}

function fetchReviewAcknowledgement(options: Options): LooseRecord {
  const comment = ghJsonWithRetry<LooseRecord>([
    "api",
    `repos/${options.repo}/issues/comments/${options.statusCommentId}`,
  ]);
  if (
    !isAllowedMutationActor(comment.user?.login, options.trustedBots) ||
    issueNumberFromUrl(comment.issue_url) !== options.itemNumber ||
    typeof comment.body !== "string" ||
    !new RegExp(`<!--\\s*clawsweeper-pr-ack:[^>]+\\s+item=${options.itemNumber}\\s*-->`).test(
      comment.body,
    )
  ) {
    throw new Error("review acknowledgement comment is missing or untrusted");
  }
  return comment;
}

export function parseOptions(argv: string[]): Options {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[arg.slice(2)] = "true";
      continue;
    }
    args[arg.slice(2)] = next;
    index += 1;
  }
  const repo = args.repo ?? process.env.TARGET_REPO ?? "";
  const itemNumber = Number(args["item-number"] ?? process.env.ITEM_NUMBER);
  const statusCommentId = Number(args["status-comment-id"] ?? process.env.STATUS_COMMENT_ID);
  const state = args.state ?? process.env.REVIEW_STATUS_STATE ?? "";
  const rawFailureReason = args["failure-reason"] ?? process.env.REVIEW_FAILURE_REASON ?? "";
  const failureReason = terminalReviewFailureReason(rawFailureReason);
  const runUrl = args["run-url"] ?? process.env.RUN_URL ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("invalid repository");
  if (!Number.isSafeInteger(itemNumber) || itemNumber < 1) throw new Error("invalid item number");
  if (!Number.isSafeInteger(statusCommentId) || statusCommentId < 1) {
    throw new Error("invalid review acknowledgement comment id");
  }
  if (state !== "reviewing" && state !== "complete" && state !== "closed" && state !== "blocked") {
    throw new Error("invalid review status state");
  }
  if ((state === "blocked") !== Boolean(failureReason)) {
    throw new Error("review failure reason does not match status state");
  }
  if (
    runUrl &&
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/.test(
      runUrl,
    )
  ) {
    throw new Error("invalid workflow run URL");
  }
  return {
    repo,
    itemNumber,
    statusCommentId,
    trustedBots: commaSet(
      args["trusted-bots"] ??
        process.env.CLAWSWEEPER_TRUSTED_BOTS ??
        [...DEFAULT_TRUSTED_BOTS, "clawsweeper"].join(","),
    ),
    state,
    failureReason,
    runUrl,
  };
}

function terminalReviewFailureReason(value: JsonValue): TerminalReviewFailureReason | null {
  return value === "findings" || value === "incomplete_source" || value === "source_incompatible"
    ? value
    : null;
}
