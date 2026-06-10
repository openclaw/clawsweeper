import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";

const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const DEFAULT_IGNORED_CHECKS = [
  "auto-response",
  "ClawSweeper Dispatch",
  "dispatch",
  "Labeler",
  "notify",
  "Stale",
];

export function summarizeChecks(checks: LooseRecord[]) {
  const ignored = ignoredCheckNames();
  const latestChecks = latestCheckRuns(checks);
  const counts: Record<string, number> = {};
  const blockers: LooseRecord[] = [];
  const pending: LooseRecord[] = [];
  const terminalBlockers: LooseRecord[] = [];
  const externalBlockers: LooseRecord[] = [];
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
    if (conclusion && !PASSING_CHECK_CONCLUSIONS.has(conclusion)) {
      const blocker = `${name}:${conclusion}`;
      blockers.push(blocker);
      terminalBlockers.push(blocker);
    }
  }
  return {
    total: latestChecks.length,
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

function ignoredCheckNames() {
  return commaSet(
    process.env.CLAWSWEEPER_COMMENT_ROUTER_IGNORE_CHECKS ?? DEFAULT_IGNORED_CHECKS.join(","),
  );
}

export function readLedger(file: JsonValue) {
  if (!fs.existsSync(file)) return { updated_at: null, commands: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      updated_at: data.updated_at ?? null,
      commands: Array.isArray(data.commands) ? data.commands : [],
    };
  } catch {
    return { updated_at: null, commands: [] };
  }
}

export function appendLedger(current: LooseRecord, entries: LooseRecord[]) {
  const compact = entries
    .filter((entry: JsonValue) => ["executed", "skipped"].includes(entry.status))
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
        expected_head_sha: entry.expected_head_sha ?? null,
        finding_id: entry.finding_id ?? null,
        status: entry.status,
        processed_at: new Date().toISOString(),
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
    byCommentVersion.set(key, entry);
    changed = true;
  }
  if (!changed) return false;
  current.updated_at = new Date().toISOString();
  current.commands = [...byCommentVersion.values()].slice(-1000);
  return true;
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
  return JSON.stringify({ ...entry, processed_at: null });
}

function ledgerEntryKey(entry: LooseRecord) {
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
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
