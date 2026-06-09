import type { JsonValue, LooseRecord } from "./json-types.js";
import { DEFAULT_ALLOWED_REPOSITORY_PERMISSIONS } from "./comment-router-core.js";
import { currentProjectRepo, readMaxLiveWorkers } from "./lib.js";
import { assertRepo, commaSet, positiveInteger } from "./comment-router-utils.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import {
  DEFAULT_HEAD_PREFIX,
  DEFAULT_TARGET_REPO,
  REPAIR_CLUSTER_WORKFLOW,
  SWEEP_WORKFLOW,
} from "./constants.js";
export { DEFAULT_HEAD_PREFIX, DEFAULT_TARGET_REPO } from "./constants.js";

const DEFAULT_ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
export const DEFAULT_TRUSTED_BOTS = ["clawsweeper[bot]", "openclaw-clawsweeper[bot]"];

export type CommentRouterConfig = {
  targetRepo: string;
  targetBranch: string;
  repairRepo: string;
  workflow: string;
  reviewRepo: string;
  reviewWorkflow: string;
  runner: string;
  executionRunner: string;
  model: string;
  headPrefix: string;
  execute: boolean;
  forceReprocess: boolean;
  writeReport: boolean;
  waitForCapacity: boolean;
  maxLiveWorkers: number;
  automergeMaxLiveWorkers: number;
  automergeRunNamePrefix: string;
  maxComments: number;
  maxAutocloseTargets: number;
  maxAutoRepairsPerHead: number;
  maxAutoRepairsPerPr: number;
  lookupConcurrency: number;
  lookbackMinutes: number;
  since: string;
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
  const repairRepo = stringSetting(
    args["repair-repo"] ?? process.env.CLAWSWEEPER_REPO,
    currentProjectRepo(),
  );
  const workflow = stringSetting(
    args.workflow ?? process.env.CLAWSWEEPER_COMMENT_WORKFLOW,
    REPAIR_CLUSTER_WORKFLOW,
  );
  const reviewRepo = stringSetting(
    args["review-repo"] ?? process.env.CLAWSWEEPER_REVIEW_REPO,
    currentProjectRepo(),
  );
  const reviewWorkflow = stringSetting(
    args["review-workflow"] ?? process.env.CLAWSWEEPER_REVIEW_WORKFLOW,
    SWEEP_WORKFLOW,
  );
  const runner = stringSetting(
    args.runner ?? process.env.CLAWSWEEPER_WORKER_RUNNER,
    "blacksmith-4vcpu-ubuntu-2404",
  );
  const executionRunner = stringSetting(
    args["execution-runner"] ?? args.execution_runner ?? process.env.CLAWSWEEPER_EXECUTION_RUNNER,
    "blacksmith-16vcpu-ubuntu-2404",
  );
  const model = stringSetting(args.model ?? process.env.CLAWSWEEPER_MODEL, "internal");
  const headPrefix = stringSetting(
    args["head-prefix"] ?? process.env.CLAWSWEEPER_HEAD_PREFIX,
    DEFAULT_HEAD_PREFIX,
  );
  const lookbackMinutes = positiveInteger(
    args["lookback-minutes"] ?? process.env.CLAWSWEEPER_COMMENT_LOOKBACK_MINUTES ?? 180,
    "lookback-minutes",
  );

  assertRepo(targetRepo, "repo");
  assertRepo(repairRepo, "repair-repo");
  assertRepo(reviewRepo, "review-repo");

  return {
    targetRepo,
    targetBranch,
    repairRepo,
    workflow,
    reviewRepo,
    reviewWorkflow,
    runner,
    executionRunner,
    model,
    headPrefix,
    execute: Boolean(args.execute),
    forceReprocess: Boolean(
      args["force-reprocess"] ||
      args.force_reprocess ||
      process.env.CLAWSWEEPER_COMMENT_FORCE_REPROCESS === "1",
    ),
    writeReport: Boolean(args["write-report"] || args.execute),
    waitForCapacity: Boolean(args["wait-for-capacity"]),
    maxLiveWorkers: readMaxLiveWorkers(args),
    automergeMaxLiveWorkers: readMaxLiveWorkers({
      "max-live-workers":
        args["automerge-max-live-workers"] ??
        process.env.CLAWSWEEPER_AUTOMERGE_MAX_LIVE_WORKERS ??
        AUTOMATION_LIMITS.repair_live_runs.automerge_default,
    }),
    automergeRunNamePrefix: stringSetting(
      args["automerge-run-name-prefix"] ?? process.env.CLAWSWEEPER_AUTOMERGE_RUN_NAME_PREFIX,
      "automerge repair ",
    ),
    maxComments: positiveInteger(
      args["max-comments"] ?? process.env.CLAWSWEEPER_COMMENT_MAX_COMMENTS ?? 100,
      "max-comments",
    ),
    maxAutocloseTargets: positiveInteger(
      args["max-autoclose-targets"] ?? process.env.CLAWSWEEPER_AUTOCLOSE_MAX_TARGETS ?? 8,
      "max-autoclose-targets",
    ),
    maxAutoRepairsPerHead: positiveInteger(
      args["max-auto-repairs-per-head"] ?? process.env.CLAWSWEEPER_MAX_REPAIRS_PER_HEAD ?? 2,
      "max-auto-repairs-per-head",
    ),
    maxAutoRepairsPerPr: positiveInteger(
      args["max-auto-repairs-per-pr"] ?? process.env.CLAWSWEEPER_MAX_REPAIRS_PER_PR ?? 10,
      "max-auto-repairs-per-pr",
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
