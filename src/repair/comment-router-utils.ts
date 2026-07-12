import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonValue, LooseRecord } from "./json-types.js";

const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const DEFAULT_IGNORED_CHECKS = [
  "auto-response",
  "ClawSweeper Dispatch",
  "dispatch",
  "Labeler",
  "notify",
  "Stale",
];
const TRANSIENT_CANCELLED_CHECKS = new Set(["real behavior proof"]);

export function dispatchClaimLookupKeys(entry: LooseRecord) {
  const keys: string[] = [];
  const attemptId = forcedReplayAttemptId(entry);
  const commentId = String(entry.comment_id ?? "").trim();
  const commentUpdatedAt = String(entry.comment_updated_at ?? "").trim();
  if (commentId && commentUpdatedAt) {
    keys.push(scopedDispatchLookupKey(`comment:${commentId}:${commentUpdatedAt}`, attemptId));
  }
  const idempotencyKey = String(entry.idempotency_key ?? "").trim();
  if (idempotencyKey) {
    keys.push(scopedDispatchLookupKey(`idempotency:${idempotencyKey}`, attemptId));
  }
  return keys;
}

export function dispatchReceiptKeyMaterial(entry: LooseRecord, claim: LooseRecord | null) {
  const idempotencyKey = String(entry.idempotency_key ?? entry.comment_version_key ?? "unknown");
  const attemptId = forcedReplayAttemptId(entry);
  if (attemptId) {
    return JSON.stringify({
      idempotency_key: idempotencyKey,
      forced_replay_attempt_id: attemptId,
    });
  }
  if (entry.automation_source !== "repair_loop_label_sweep") return idempotencyKey;
  const attempt = String(
    claim?.processed_at ?? entry.processed_at ?? entry.comment_updated_at ?? "unknown-attempt",
  );
  return `${idempotencyKey}:${attempt}`;
}

export function routerDispatchReceiptKey(entry: LooseRecord, claim: LooseRecord | null) {
  return `router-${createHash("sha256")
    .update(dispatchReceiptKeyMaterial(entry, claim))
    .digest("hex")
    .slice(0, 16)}`;
}

function forcedReplayAttemptId(entry: LooseRecord): string | null {
  const identity = forcedReplayIdentityFields(entry);
  return identity.attempt_id ? String(identity.attempt_id) : null;
}

function scopedDispatchLookupKey(key: string, attemptId: string | null): string {
  return attemptId ? `forced-replay:${JSON.stringify([key, attemptId])}` : key;
}

export function hasSuccessfulDispatchExecutionJob(jobs: LooseRecord[], requiredJobName: string) {
  return jobs.some(
    (job) =>
      String(job.name ?? "") === requiredJobName &&
      String(job.conclusion ?? "").toLowerCase() === "success",
  );
}

export function summarizeChecks(checks: LooseRecord[]) {
  const ignored = ignoredCheckNames();
  const latestChecks = latestCheckRuns(checks);
  const counts: Record<string, number> = {};
  const blockers: LooseRecord[] = [];
  const pending: LooseRecord[] = [];
  const terminalBlockers: LooseRecord[] = [];
  const externalBlockers: LooseRecord[] = [];
  let gatingTotal = 0;
  for (const check of latestChecks) {
    const name = String(check.name ?? check.context ?? "unknown check");
    const workflow = String(check.workflowName ?? "");
    const ignoredCheck = ignored.has(name.toLowerCase()) || ignored.has(workflow.toLowerCase());
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    const externalActionRequired = isExternalActionRequiredCheck(check);
    const key = externalActionRequired ? "ACTION_REQUIRED" : conclusion || status || "UNKNOWN";
    counts[key] = (counts[key] ?? 0) + 1;
    if (ignoredCheck) continue;
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
    total: latestChecks.length,
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

function latestCheckRuns(checks: LooseRecord[]) {
  const byKey = new Map<string, LooseRecord>();
  for (const check of checks) {
    const key = checkIdentity(check);
    const previous = byKey.get(key);
    if (!previous || checkTimestamp(check) >= checkTimestamp(previous)) {
      byKey.set(key, check);
    }
  }
  return [...byKey.values()];
}

function checkIdentity(check: LooseRecord) {
  const name = String(check.name ?? check.context ?? "unknown check").toLowerCase();
  const workflow = String(check.workflowName ?? "").toLowerCase();
  return `${workflow}\n${name}`;
}

function checkTimestamp(check: LooseRecord) {
  for (const field of ["completedAt", "completed_at", "startedAt", "started_at"]) {
    const parsed = Date.parse(String(check[field] ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
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
  return createHash("sha256")
    .update(String(body ?? ""), "utf8")
    .digest("hex");
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

export function dispatchClaimDecision({
  claim,
  runs,
  expectedTitle,
  nowMs = Date.now(),
  graceMs = 300_000,
}: {
  claim: LooseRecord | null;
  runs: LooseRecord[];
  expectedTitle: string;
  nowMs?: number;
  graceMs?: number;
}) {
  if (!claim) return { action: "dispatch", run: null };
  const normalizedGraceMs = Number.isFinite(graceMs) ? Math.max(0, graceMs) : 300_000;
  const claimedAtMs = Date.parse(String(claim.processed_at ?? ""));
  const matchingRuns = runs.filter((run) => {
    if (String(run.display_title ?? run.displayTitle ?? "") !== expectedTitle) return false;
    const createdAtMs = Date.parse(String(run.created_at ?? run.createdAt ?? ""));
    return (
      Number.isFinite(claimedAtMs) &&
      Number.isFinite(createdAtMs) &&
      createdAtMs >= claimedAtMs - 5_000
    );
  });
  const successfulRun = matchingRuns.find(
    (run) =>
      String(run.conclusion ?? "").toLowerCase() === "success" &&
      run.dispatch_execution_verified !== false,
  );
  if (successfulRun) return { action: "recover", run: successfulRun };
  const activeRun = matchingRuns.find((run) =>
    ["queued", "in_progress", "waiting", "pending", "requested"].includes(
      String(run.status ?? "").toLowerCase(),
    ),
  );
  if (activeRun) return { action: "wait", run: null };
  if (Number.isFinite(claimedAtMs) && nowMs - claimedAtMs >= normalizedGraceMs) {
    return { action: "dispatch", run: null };
  }
  return { action: "wait", run: null };
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

export function isAllowedMutationActor(login: JsonValue, trustedBots: Iterable<string>) {
  const actor = String(login ?? "")
    .trim()
    .toLowerCase();
  if (!actor) return false;
  for (const trustedBot of trustedBots) {
    if (
      String(trustedBot ?? "")
        .trim()
        .toLowerCase() === actor
    )
      return true;
  }
  return false;
}

export function normalizeGitHubActor(login: JsonValue) {
  return String(login ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/i, "");
}

export function isGitHubAppIntegrationAuthError(message: JsonValue) {
  const text = String(message ?? "").toLowerCase();
  return (
    text.includes("resource not accessible by integration") &&
    (text.includes("http 403") || /"status"\s*:\s*"403"/.test(text) || text.includes("status: 403"))
  );
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

function ignoredCheckNames() {
  return commaSet(
    process.env.CLAWSWEEPER_COMMENT_ROUTER_IGNORE_CHECKS ?? DEFAULT_IGNORED_CHECKS.join(","),
  );
}

export function readLedger(file: JsonValue) {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { updated_at: null, commands: [] };
    }
    throw error;
  }
  let data: LooseRecord;
  try {
    data = JSON.parse(contents);
  } catch (error) {
    throw new Error(`failed to parse comment router ledger: ${String(file)}`, { cause: error });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("comment router ledger must be an object");
  }
  if (!Array.isArray(data.commands)) {
    throw new Error("comment router ledger commands must be an array");
  }
  return {
    updated_at: data.updated_at ?? null,
    commands: data.commands.map((entry: JsonValue) => validatedLedgerCommand(entry)),
  };
}

export function appendLedger(current: LooseRecord, entries: LooseRecord[]) {
  const compact = entries
    .filter((entry: JsonValue) =>
      ["claimed", "executed", "skipped", "waiting"].includes(entry.status),
    )
    .filter((entry: JsonValue) => !isNoopSkip(entry))
    .map((entry: JsonValue) => {
      const actions = compactLedgerActions(entry.actions);
      return {
        idempotency_key: entry.idempotency_key,
        comment_id: entry.comment_id,
        comment_version_key: entry.comment_version_key ?? null,
        comment_url: entry.comment_url,
        comment_created_at: entry.comment_created_at ?? null,
        comment_updated_at: entry.comment_updated_at ?? null,
        ...(entry.comment_body_sha256 ? { comment_body_sha256: entry.comment_body_sha256 } : {}),
        repo: entry.repo,
        issue_number: entry.issue_number,
        author: entry.author,
        author_id: entry.author_id ?? null,
        author_name: entry.author_name ?? null,
        author_association: entry.author_association,
        trigger: entry.trigger,
        command: entry.command,
        intent: entry.intent,
        trusted_bot: Boolean(entry.trusted_bot),
        trusted_bot_author: entry.trusted_bot_author ?? null,
        automation_source: entry.automation_source ?? null,
        repair_reason: entry.repair_reason ?? null,
        ...forcedReplayIdentityFields(entry),
        expected_head_sha: entry.expected_head_sha ?? null,
        finding_id: entry.finding_id ?? null,
        status: entry.status,
        processed_at: entry.processed_at ?? new Date().toISOString(),
        target: entry.target
          ? {
              kind: entry.target.kind,
              branch: entry.target.branch,
              head_sha: entry.target.head_sha,
              cluster_id: entry.target.cluster_id,
              job_path: entry.target.job_path,
            }
          : null,
        ...(actions.length > 0 ? { actions } : {}),
      };
    });
  if (compact.length === 0) return false;
  const byCommentVersion = new Map(
    (current.commands ?? []).map((entry: JsonValue) => [ledgerEntryKey(entry), entry]),
  );
  let changed = false;
  for (const entry of compact) {
    const key = ledgerEntryKey(entry);
    const previous = byCommentVersion.get(key);
    if (previous && stableLedgerEntry(previous) === stableLedgerEntry(entry)) continue;
    if (previous) byCommentVersion.delete(key);
    byCommentVersion.set(key, entry);
    changed = true;
  }
  if (!changed) return false;
  current.updated_at = new Date().toISOString();
  current.commands = [...byCommentVersion.values()].slice(-1000);
  return true;
}

function validatedLedgerCommand(entry: JsonValue): LooseRecord {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("comment router ledger commands must be objects");
  }
  return { ...entry, ...forcedReplayIdentityFields(entry) };
}

function forcedReplayIdentityFields(entry: LooseRecord): LooseRecord {
  const forcedReplay = entry.forced_replay;
  const hasAttemptId = entry.attempt_id !== undefined && entry.attempt_id !== null;
  const attemptId = String(entry.attempt_id ?? "").trim();
  if (
    (forcedReplay === undefined || forcedReplay === null || forcedReplay === false) &&
    !hasAttemptId
  ) {
    return {};
  }
  if (forcedReplay !== true) {
    throw new Error("forced replay dispatch identity requires forced_replay=true");
  }
  if (
    !attemptId ||
    attemptId.length > 128 ||
    /\s/.test(attemptId) ||
    attemptId.includes(String.fromCharCode(0))
  ) {
    throw new Error(
      "forced replay dispatch attempt_id must be a non-empty token of at most 128 characters",
    );
  }
  return { forced_replay: true, attempt_id: attemptId };
}

function isNoopSkip(entry: LooseRecord) {
  if (String(entry.status ?? "") !== "skipped") return false;
  const reason = String(entry.reason ?? "");
  return (
    reason === "comment version already processed in ledger" ||
    reason === "matching ClawSweeper response comment already exists" ||
    /already enabled for this PR/i.test(reason)
  );
}

function stableLedgerEntry(entry: LooseRecord) {
  return JSON.stringify({
    ...entry,
    processed_at: entry.status === "claimed" ? entry.processed_at : null,
  });
}

function ledgerEntryKey(entry: LooseRecord) {
  if (
    !entry.comment_version_key &&
    entry.automation_source === "repair_loop_label_sweep" &&
    entry.idempotency_key
  ) {
    return `idempotency:${entry.idempotency_key}`;
  }
  return (
    entry.comment_version_key ??
    `${entry.comment_id ?? "unknown"}:${entry.comment_updated_at ?? "unknown"}`
  );
}

function compactLedgerActions(actions: JsonValue) {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((action: JsonValue) => ({
      action: action?.action ?? null,
      status: action?.status ?? null,
      label: action?.label ?? null,
      job_path: action?.job_path ?? null,
    }))
    .filter((action: LooseRecord) => action.action || action.status);
}

export function writeLedger(file: JsonValue, current: LooseRecord) {
  const ledgerPath = String(file);
  const directory = path.dirname(ledgerPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(ledgerPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const contents = `${JSON.stringify(current, null, 2)}\n`;
  fs.mkdirSync(directory, { recursive: true });
  try {
    const descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, contents, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, ledgerPath);
    fsyncDirectory(directory);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function fsyncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
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

export function stripAnsi(text: string) {
  return String(text ?? "").replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"),
    "",
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
