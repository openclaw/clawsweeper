import type { JsonValue, LooseRecord } from "./json-types.js";
import { DEFAULT_ALLOWED_REPOSITORY_PERMISSIONS } from "./comment-router/admission.js";
import { currentProjectRepo } from "./project-repo.js";
import { assertRepo, commaSet, positiveInteger } from "./comment-router-utils.js";
import { CLAWSWEEPER_APP_BOT_LOGINS } from "../clawsweeper-bot-identity.js";
import { DEFAULT_TARGET_REPO, SWEEP_WORKFLOW } from "./constants.js";
export { DEFAULT_TARGET_REPO } from "./constants.js";

const DEFAULT_ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
// Command trust admits only the GitHub App bot logins, not the plain "clawsweeper" login.
export const DEFAULT_TRUSTED_BOTS = [...CLAWSWEEPER_APP_BOT_LOGINS];

export type CommentRouterConfig = {
  targetRepo: string;
  targetBranch: string;
  reviewRepo: string;
  reviewWorkflow: string;
  execute: boolean;
  forceReprocess: boolean;
  attemptId: string | null;
  writeReport: boolean;
  maxComments: number;
  lookupConcurrency: number;
  lookbackMinutes: number;
  since: string;
  sinceCommentIds: Set<number>;
  itemNumbers: Set<number>;
  commentIds: Set<number>;
  statusCommentId: number | null;
  allowedAssociations: Set<string>;
  allowedRepositoryPermissions: Set<string>;
  trustedBots: Set<string>;
};

export function readCommentRouterConfig(args: LooseRecord): CommentRouterConfig {
  const targetRepo = stringSetting(
    args.repo ?? process.env.CLAWSWEEPER_TARGET_REPO,
    DEFAULT_TARGET_REPO,
  );
  const targetBranch = stringSetting(
    args["target-branch"] ?? args.target_branch ?? process.env.CLAWSWEEPER_TARGET_BRANCH,
    "",
  );
  const reviewRepo = stringSetting(
    args["review-repo"] ?? process.env.CLAWSWEEPER_REVIEW_REPO,
    currentProjectRepo(),
  );
  const reviewWorkflow = stringSetting(
    args["review-workflow"] ?? process.env.CLAWSWEEPER_REVIEW_WORKFLOW,
    SWEEP_WORKFLOW,
  );
  const lookbackMinutes = positiveInteger(
    args["lookback-minutes"] ?? process.env.CLAWSWEEPER_COMMENT_LOOKBACK_MINUTES ?? 180,
    "lookback-minutes",
  );

  assertRepo(targetRepo, "repo");
  assertRepo(reviewRepo, "review-repo");

  const forceReprocess = Boolean(
    args["force-reprocess"] ||
    args.force_reprocess ||
    process.env.CLAWSWEEPER_COMMENT_FORCE_REPROCESS === "1",
  );
  const requestedAttemptId =
    args["attempt-id"] ??
    args.attempt_id ??
    process.env.CLAWSWEEPER_COMMENT_ATTEMPT_ID ??
    (forceReprocess && process.env.GITHUB_RUN_ID
      ? `forced-replay-${process.env.GITHUB_RUN_ID}`
      : null);
  const attemptId = optionalAttemptId(requestedAttemptId);
  if (attemptId && !forceReprocess) {
    throw new Error("--attempt-id requires --force-reprocess");
  }
  if (forceReprocess && !attemptId) {
    throw new Error("--force-reprocess requires --attempt-id or GITHUB_RUN_ID");
  }

  return {
    targetRepo,
    targetBranch,
    reviewRepo,
    reviewWorkflow,
    execute: Boolean(args.execute),
    forceReprocess,
    attemptId,
    writeReport: Boolean(args["write-report"] || args.execute),
    maxComments: positiveInteger(
      args["max-comments"] ?? process.env.CLAWSWEEPER_COMMENT_MAX_COMMENTS ?? 100,
      "max-comments",
    ),
    lookupConcurrency: positiveInteger(
      args["lookup-concurrency"] ?? process.env.CLAWSWEEPER_COMMENT_LOOKUP_CONCURRENCY ?? 8,
      "lookup-concurrency",
    ),
    lookbackMinutes,
    since: stringSetting(
      args.since,
      new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString(),
    ),
    sinceCommentIds: numberSet(args["since-comment-ids"], "since-comment-ids"),
    itemNumbers: numberSet(
      [args["item-number"], args["item-numbers"], process.env.CLAWSWEEPER_COMMENT_ITEM_NUMBERS]
        .filter((value) => value !== undefined && value !== null)
        .join(","),
      "item-numbers",
    ),
    commentIds: numberSet(
      [args["comment-id"], args["comment-ids"], process.env.CLAWSWEEPER_COMMENT_IDS]
        .filter((value) => value !== undefined && value !== null)
        .join(","),
      "comment-ids",
    ),
    statusCommentId: optionalNumber(
      args["status-comment-id"] ?? process.env.CLAWSWEEPER_STATUS_COMMENT_ID,
      "status-comment-id",
    ),
    allowedAssociations: upperCaseSet(
      process.env.CLAWSWEEPER_COMMENT_ALLOWED_ASSOCIATIONS ??
        DEFAULT_ALLOWED_ASSOCIATIONS.join(","),
    ),
    allowedRepositoryPermissions: lowerCaseSet(
      args["allowed-repository-permissions"] ??
        process.env.CLAWSWEEPER_COMMENT_ALLOWED_REPOSITORY_PERMISSIONS ??
        DEFAULT_ALLOWED_REPOSITORY_PERMISSIONS.join(","),
    ),
    trustedBots: commaSet(
      args["trusted-bots"] ??
        process.env.CLAWSWEEPER_TRUSTED_BOTS ??
        DEFAULT_TRUSTED_BOTS.join(","),
    ),
  };
}

export function forcedReplayCommandFields(
  config: Pick<CommentRouterConfig, "forceReprocess" | "attemptId">,
): LooseRecord {
  if (!config.forceReprocess || !config.attemptId) return {};
  return { forced_replay: true, attempt_id: config.attemptId };
}

function stringSetting(value: JsonValue, fallback: string): string {
  const text = String(value ?? fallback).trim();
  return text || fallback;
}

function lowerCaseSet(value: JsonValue): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function upperCaseSet(value: JsonValue): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  );
}

function optionalNumber(value: JsonValue, label: string): number | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function optionalAttemptId(value: JsonValue): string | null {
  const attemptId = String(value ?? "").trim();
  if (!attemptId) return null;
  if (
    attemptId.length > 128 ||
    /\s/.test(attemptId) ||
    attemptId.includes(String.fromCharCode(0))
  ) {
    throw new Error("--attempt-id must be a non-empty token of at most 128 characters");
  }
  return attemptId;
}

function numberSet(value: JsonValue, name: string): Set<number> {
  const numbers = new Set<number>();
  for (const item of String(value ?? "").split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const number = Number(trimmed);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`invalid ${name}: expected positive integer, got ${trimmed}`);
    }
    numbers.add(number);
  }
  return numbers;
}
