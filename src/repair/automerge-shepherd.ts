import type { JsonValue, LooseRecord } from "./json-types.js";
import { isAutomergeMergeStateReady, parseTrustedAutomation } from "./comment-router-core.js";

const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 1000;
const TRUSTED_REVIEW_AUTHORS = new Set([
  "clawsweeper",
  "clawsweeper[bot]",
  "openclaw-clawsweeper[bot]",
]);

export function automergeShepherdWaitConfig(env: LooseRecord = process.env) {
  const maxWaitMs = positiveInt(env.CLAWSWEEPER_AUTOMERGE_SHEPHERD_WAIT_MS, DEFAULT_WAIT_MS);
  const intervalMs = Math.min(
    Math.max(positiveInt(env.CLAWSWEEPER_AUTOMERGE_SHEPHERD_POLL_MS, DEFAULT_POLL_MS), 1000),
    Math.max(maxWaitMs, 1000),
  );
  return { maxWaitMs, intervalMs };
}

export function canUseAutomergeFastRebase({
  isAutomergeRepair,
  repairStrategy,
  fixArtifact = null,
  env = process.env,
}: LooseRecord) {
  if (env.CLAWSWEEPER_AUTOMERGE_FAST_REBASE === "0") return false;
  if (isAutomergeRepair !== true || repairStrategy !== "repair_contributor_branch") return false;
  return fixArtifact?.deterministic_rebase_only === true;
}

export function automergeShepherdReadiness({
  view,
  comments,
  headSha,
}: {
  view: LooseRecord;
  comments: JsonValue[];
  headSha: string;
}) {
  if (view.state === "MERGED" || view.mergedAt) {
    return { status: "merged", reason: "pull request already merged" };
  }
  if (view.state && view.state !== "OPEN") {
    return { status: "stopped", reason: `pull request is ${String(view.state).toLowerCase()}` };
  }
  if (view.headRefOid && view.headRefOid !== headSha) {
    return {
      status: "stopped",
      reason: `head changed from ${headSha} to ${view.headRefOid}`,
    };
  }
  if (hasTrustedHumanReviewForHead(comments, headSha)) {
    return {
      status: "human",
      reason: "exact-head ClawSweeper review requires human handling",
    };
  }
  if (hasTrustedRepairRequestForHead(comments, headSha)) {
    return {
      status: "blocked",
      reason: "exact-head ClawSweeper review requires another repair",
    };
  }
  const checkBlock = checkBlockReason(view.statusCheckRollup ?? []);
  if (checkBlock.status === "blocked") return checkBlock;
  if (!hasTrustedPassForHead(comments, headSha)) {
    return { status: "waiting", reason: "waiting for exact-head ClawSweeper review pass" };
  }
  if (checkBlock.status === "waiting") return checkBlock;
  if (view.mergeable && view.mergeable !== "MERGEABLE") {
    return { status: "waiting", reason: `mergeable state is ${view.mergeable}` };
  }
  const mergeStateStatus = String(view.mergeStateStatus ?? "");
  if (
    mergeStateStatus &&
    !isAutomergeMergeStateReady(mergeStateStatus) &&
    mergeStateStatus !== "UNSTABLE"
  ) {
    return { status: "waiting", reason: `merge state status is ${mergeStateStatus}` };
  }
  return { status: "ready", reason: "checks and exact-head review are ready" };
}

export function hasTrustedPassForHead(comments: JsonValue[], headSha: string) {
  return trustedReviewDecisionForHead(comments, headSha) === "pass";
}

export function hasTrustedRepairRequestForHead(comments: JsonValue[], headSha: string) {
  return trustedReviewDecisionForHead(comments, headSha) === "repair";
}

export function hasTrustedHumanReviewForHead(comments: JsonValue[], headSha: string) {
  return trustedReviewDecisionForHead(comments, headSha) === "human";
}

function trustedReviewDecisionForHead(comments: JsonValue[], headSha: string) {
  let latest: "human" | "pass" | "repair" | null = null;
  for (const comment of comments) {
    const command = parseTrustedAutomation(comment, {
      trustedAuthors: TRUSTED_REVIEW_AUTHORS,
    });
    if (String(command?.expected_head_sha ?? "") !== headSha) continue;
    if (command?.intent === "clawsweeper_auto_merge") latest = "pass";
    if (command?.intent === "clawsweeper_auto_repair") latest = "repair";
    if (command?.intent === "clawsweeper_needs_human") latest = "human";
  }
  return latest;
}

function checkBlockReason(checks: JsonValue[]) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return { status: "waiting", reason: "waiting for GitHub checks" };
  }
  const pending: string[] = [];
  const failed: string[] = [];
  for (const check of checks) {
    const status = String(check?.status ?? "").toUpperCase();
    const conclusion = String(check?.conclusion ?? "").toUpperCase();
    const name = String(check?.name ?? check?.workflowName ?? "check");
    if (status && status !== "COMPLETED") {
      pending.push(`${name}:${status}`);
      continue;
    }
    if (
      ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)
    ) {
      failed.push(`${name}:${conclusion}`);
    }
  }
  if (failed.length > 0) {
    return { status: "blocked", reason: `GitHub checks failed: ${failed.slice(0, 5).join(", ")}` };
  }
  if (pending.length > 0) {
    return {
      status: "waiting",
      reason: `waiting for GitHub checks: ${pending.slice(0, 5).join(", ")}`,
    };
  }
  return { status: "ready", reason: "" };
}

function positiveInt(value: JsonValue, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}
