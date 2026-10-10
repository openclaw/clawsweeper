import fs from "node:fs";
import path from "node:path";

import { sha256 } from "../content-hash.js";
import { normalizeGitHubActor } from "./comment-router/admission.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { rollUpStatusChecks } from "./status-check-rollup.js";

const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const DEFAULT_IGNORED_CHECKS = [
  "auto-response",
  "ClawSweeper Dispatch",
  "dispatch",
  "Labeler",
  "notify",
  "Stale",
];
const TRANSIENT_CANCELLED_CHECKS = new Set(["real behavior proof", "pr context and evidence"]);

export function summarizeChecks(checks: LooseRecord[]) {
  const rolledUpChecks = rollUpStatusChecks(
    checks,
    process.env.CLAWSWEEPER_COMMENT_ROUTER_IGNORE_CHECKS ?? DEFAULT_IGNORED_CHECKS.join(","),
  );
  const counts: Record<string, number> = {};
  const blockers: LooseRecord[] = [];
  const pending: LooseRecord[] = [];
  const terminalBlockers: LooseRecord[] = [];
  const externalBlockers: LooseRecord[] = [];
  let gatingTotal = 0;
  for (const { check, ignored } of rolledUpChecks) {
    const name = String(check.name ?? check.context ?? "unknown check");
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    const externalActionRequired = isExternalActionRequiredCheck(check);
    const key = externalActionRequired ? "ACTION_REQUIRED" : conclusion || status || "UNKNOWN";
    counts[key] = (counts[key] ?? 0) + 1;
    if (ignored) continue;
    gatingTotal += 1;
    if (externalActionRequired) {
      const blocker = `${name}:ACTION_REQUIRED`;
      blockers.push(blocker);
      terminalBlockers.push(blocker);
      externalBlockers.push(blocker);
      continue;
    }
    if (status && !["COMPLETED", "SUCCESS"].includes(status)) {
      const blocker = `${name}:${status}`;
      blockers.push(blocker);
      pending.push(blocker);
    }
    if (conclusion === "CANCELLED" && TRANSIENT_CANCELLED_CHECKS.has(name.toLowerCase())) {
      const blocker = `${name}:${conclusion}`;
      blockers.push(blocker);
      pending.push(blocker);
      continue;
    }
    if (conclusion && !PASSING_CHECK_CONCLUSIONS.has(conclusion)) {
      const blocker = `${name}:${conclusion}`;
      blockers.push(blocker);
      terminalBlockers.push(blocker);
    }
  }
  return {
    total: rolledUpChecks.length,
    gatingTotal,
    counts,
    blockers,
    pending,
    terminalBlockers,
    externalBlockers,
  };
}

function isExternalActionRequiredCheck(check: LooseRecord) {
  const url = String(
    check.targetUrl ?? check.target_url ?? check.detailsUrl ?? check.details_url ?? "",
  );
  if (/^https:\/\/vercel\.com\/git\/authorize\b/i.test(url)) return true;
  return false;
}

export function shouldSuppressProcessedCommentVersion(entry: LooseRecord) {
  const status = String(entry.status ?? "").toLowerCase();
  if (!["executed", "skipped"].includes(status)) return false;
  const intent = String(entry.intent ?? "");
  if (
    status === "skipped" &&
    (intent === "clawsweeper_auto_merge" || intent === "maintainer_approve_automerge")
  ) {
    return false;
  }
  return true;
}

export function commentBodySha256(body: JsonValue) {
  return sha256(String(body ?? ""));
}

export function exactCommentVersionMatchesLive(command: LooseRecord, live: JsonValue) {
  if (!live || typeof live !== "object" || Array.isArray(live)) return false;
  const comment = live as LooseRecord;
  return (
    String(comment.id ?? "") === String(command.comment_id ?? "") &&
    String(comment.updated_at ?? "") === String(command.comment_updated_at ?? "") &&
    commentBodySha256(comment.body) === String(command.comment_body_sha256 ?? "")
  );
}

export function routedCommentSourceDeliveryId({
  comment,
  event,
  priorClaim,
  targetRepo,
}: {
  comment: JsonValue;
  event: {
    authenticated: boolean;
    commentId: JsonValue;
    commentUpdatedAt: JsonValue;
    commentBodySha256: JsonValue;
    sourceDeliveryId: JsonValue;
  };
  priorClaim: LooseRecord | null;
  targetRepo: string;
}): string | null {
  if (priorClaim?.source_delivery_conflict === true) return null;
  const eventDeliveryId = String(event.sourceDeliveryId ?? "").trim();
  if (
    event.authenticated &&
    /^[A-Za-z0-9_.:-]{1,200}$/.test(eventDeliveryId) &&
    exactCommentVersionMatchesLive(
      {
        comment_id: event.commentId,
        comment_updated_at: event.commentUpdatedAt,
        comment_body_sha256: event.commentBodySha256,
      },
      comment,
    )
  ) {
    return eventDeliveryId;
  }
  const claimedDeliveryId = String(priorClaim?.source_delivery_id ?? "").trim();
  return priorClaim?.repo === targetRepo &&
    /^[A-Za-z0-9_.:-]{1,200}$/.test(claimedDeliveryId) &&
    exactCommentVersionMatchesLive(priorClaim, comment)
    ? claimedDeliveryId
    : null;
}

export function exactCommentVersionFastPathDecision({
  authenticated,
  sourceAction,
  targetRepo,
  commentId,
  commentUpdatedAt,
  commentBodyDigest,
  forceReprocess,
  ledger,
  verificationLedgers,
}: {
  authenticated: boolean;
  sourceAction: JsonValue;
  targetRepo: JsonValue;
  commentId: JsonValue;
  commentUpdatedAt: JsonValue;
  commentBodyDigest: JsonValue;
  forceReprocess: boolean;
  ledger: LooseRecord;
  verificationLedgers: LooseRecord[];
}) {
  if (forceReprocess) return { suppress: false, reason: "force_reprocess" };
  if (!authenticated) return { suppress: false, reason: "auth_uncertain" };
  if (String(sourceAction ?? "") !== "created") {
    return { suppress: false, reason: "edited_or_unknown_action" };
  }

  const normalizedRepo = String(targetRepo ?? "")
    .trim()
    .toLowerCase();
  const normalizedCommentId = String(commentId ?? "").trim();
  const normalizedUpdatedAt = normalizeExactTimestamp(commentUpdatedAt);
  const normalizedBodyDigest = String(commentBodyDigest ?? "")
    .trim()
    .toLowerCase();
  if (
    !normalizedRepo ||
    !/^[1-9]\d*$/.test(normalizedCommentId) ||
    !normalizedUpdatedAt ||
    !/^[0-9a-f]{64}$/.test(normalizedBodyDigest)
  ) {
    return { suppress: false, reason: "incomplete_exact_version" };
  }

  if (
    verificationLedgers.length < 2 ||
    verificationLedgers.some(
      (verificationLedger) =>
        stableLedgerSnapshot(verificationLedger) !== stableLedgerSnapshot(ledger),
    )
  ) {
    return { suppress: false, reason: "state_drift" };
  }

  const matches = (Array.isArray(ledger.commands) ? ledger.commands : []).filter(
    (entry: JsonValue) =>
      String(entry?.repo ?? "")
        .trim()
        .toLowerCase() === normalizedRepo &&
      String(entry?.comment_id ?? "").trim() === normalizedCommentId &&
      normalizeExactTimestamp(entry?.comment_updated_at) === normalizedUpdatedAt,
  );
  if (matches.length !== 1) {
    return {
      suppress: false,
      reason: matches.length === 0 ? "version_not_terminal" : "ambiguous_ledger_version",
    };
  }

  const entry = matches[0] as LooseRecord;
  if (
    String(entry.comment_body_sha256 ?? "")
      .trim()
      .toLowerCase() !== normalizedBodyDigest
  ) {
    return { suppress: false, reason: "body_digest_mismatch" };
  }
  if (!shouldSuppressProcessedCommentVersion(entry)) {
    return { suppress: false, reason: "version_retryable" };
  }
  if (
    (Array.isArray(entry.actions) ? entry.actions : []).some((action: JsonValue) =>
      ["claimed", "failed", "pending", "waiting"].includes(
        String(action?.status ?? "").toLowerCase(),
      ),
    )
  ) {
    return { suppress: false, reason: "lease_uncertain" };
  }
  return {
    suppress: true,
    reason: "exact_terminal_comment_version",
    commentVersionKey: `${normalizedCommentId}:${String(entry.comment_updated_at)}`,
    status: String(entry.status ?? "").toLowerCase(),
  };
}

function normalizeExactTimestamp(value: JsonValue) {
  const text = String(value ?? "").trim();
  const parsed = Date.parse(text);
  return text && Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function stableLedgerSnapshot(ledger: LooseRecord) {
  return JSON.stringify({
    updated_at: ledger.updated_at ?? null,
    commands: Array.isArray(ledger.commands) ? ledger.commands : [],
  });
}

export function sortCommentsForRouting(comments: LooseRecord[]) {
  return [...comments].sort((left: LooseRecord, right: LooseRecord) => {
    const leftTime = commentRoutingTime(left);
    const rightTime = commentRoutingTime(right);
    if (rightTime !== leftTime) return rightTime - leftTime;
    return Number(right.id ?? 0) - Number(left.id ?? 0);
  });
}

export function selectCommentsForRouting({
  recentComments,
  durableComments,
  maxComments,
}: {
  recentComments: LooseRecord[];
  durableComments: LooseRecord[];
  maxComments: number;
}) {
  const cappedRecent = sortCommentsForRouting(recentComments).slice(0, Math.max(0, maxComments));
  return sortCommentsForRouting(uniqueCommentsById([...cappedRecent, ...durableComments]));
}

export const SUPERSEDED_RE_REVIEW_REASON = "newer re-review command supersedes this request";

export function supersededReReviewCommentVersions(commands: LooseRecord[]) {
  const latestByRequester = new Set<string>();
  const superseded = new Set<string>();
  const newestFirst = [...commands].sort((left, right) => {
    const leftTime = commandRoutingTime(left);
    const rightTime = commandRoutingTime(right);
    if (rightTime !== leftTime) return rightTime - leftTime;
    return Number(right.comment_id ?? 0) - Number(left.comment_id ?? 0);
  });

  for (const command of newestFirst) {
    if (command.intent !== "re_review") continue;
    const version = String(command.comment_version_key ?? "");
    const repo = String(command.repo ?? "").toLowerCase();
    const issueNumber = Number(command.issue_number);
    const requester = command.author_id
      ? `id:${command.author_id}`
      : `login:${normalizeGitHubActor(command.author)}`;
    if (!version || !repo || !issueNumber || requester === "login:") continue;
    const key = `${repo}:${issueNumber}:${requester}`;
    if (latestByRequester.has(key)) superseded.add(version);
    else latestByRequester.add(key);
  }

  return superseded;
}

function uniqueCommentsById(comments: LooseRecord[]) {
  const seen = new Set<string>();
  const unique: LooseRecord[] = [];
  for (const comment of comments) {
    const key = String(comment.id ?? comment.html_url ?? comment.url ?? "");
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    unique.push(comment);
  }
  return unique;
}

function commentRoutingTime(comment: LooseRecord) {
  const updated = Date.parse(String(comment.updated_at ?? ""));
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(String(comment.created_at ?? ""));
  return Number.isFinite(created) ? created : 0;
}

function commandRoutingTime(command: LooseRecord) {
  const updated = Date.parse(String(command.comment_updated_at ?? ""));
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(String(command.comment_created_at ?? ""));
  return Number.isFinite(created) ? created : 0;
}

export function writeReportFile(root: string, data: LooseRecord) {
  const file = path.join(root, "results", "comment-router-latest.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function writePayload(root: string, name: string, payload: LooseRecord) {
  const dir = path.join(root, ".clawsweeper-repair", "payloads");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(name)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload)}\n`);
  return file;
}

export function issueNumberFromUrl(value: JsonValue) {
  const match = String(value ?? "").match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

export function positiveInteger(value: JsonValue, name: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${name} must be a positive integer`);
  return number;
}

export function commaSet(value: JsonValue) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item: JsonValue) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function assertRepo(value: JsonValue, name: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
    throw new Error(`${name} must be owner/repo`);
}

function safeName(value: JsonValue) {
  return String(value)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .slice(0, 120);
}
