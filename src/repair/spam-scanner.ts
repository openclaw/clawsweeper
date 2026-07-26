#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs, repoRoot } from "./lib.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  ghJsonWithRetry as ghJson,
  ghPagedLimitWithRetry as ghPagedLimit,
  ghStdoutFromError,
} from "./github-cli.js";
import { assertRepo, commaSet, positiveInteger } from "./comment-router-utils.js";
import {
  buildSpamModelInput,
  commentVersionKey,
  graphqlNodesToleratingNotFound,
  normalizeModelResults,
  normalizeSpamComment,
  prioritizeSpamScanComments,
  renderSpamAuditRecord,
  shouldSendToCheapModel,
  spamAuditKey,
  SPAM_MODEL_SYSTEM_PROMPT,
  type SpamModelResult,
  type SpamScanComment,
} from "./spam-scanner-core.js";
import { internalCodexModel, PUBLIC_CODEX_MODEL } from "../codex-env.js";
import { compactText } from "./text-utils.js";

const args = parseArgs(process.argv.slice(2));
const targetRepo = stringSetting(
  args.repo ?? process.env.CLAWSWEEPER_TARGET_REPO,
  "openclaw/openclaw",
);
const model = stringSetting(args.model ?? process.env.CLAWSWEEPER_SPAM_MODEL, "internal");
const lookbackMinutes = positiveInteger(
  args["lookback-minutes"] ?? process.env.CLAWSWEEPER_SPAM_LOOKBACK_MINUTES ?? 180,
  "lookback-minutes",
);
const maxComments = positiveInteger(
  args["max-comments"] ?? process.env.CLAWSWEEPER_SPAM_MAX_COMMENTS ?? 100,
  "max-comments",
);
const forceReprocess = Boolean(args["force-reprocess"] || args.force_reprocess);
const writeReport = Boolean(args["write-report"] || args.write_report);
const since = stringSetting(
  args.since,
  new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString(),
);
const commentIds = numberSet(args["comment-ids"] ?? args["comment-id"], "comment-ids");
const reviewCommentIds = numberSet(
  args["review-comment-ids"] ?? args["review-comment-id"],
  "review-comment-ids",
);
const trustedBots = commaSet(
  args["trusted-bots"] ??
    process.env.CLAWSWEEPER_SPAM_TRUSTED_BOTS ??
    "clawsweeper[bot],openclaw-clawsweeper[bot]",
);

assertRepo(targetRepo, "repo");

const ledger = readLedger();
const processed = new Set<string>(
  forceReprocess
    ? []
    : (ledger.entries ?? [])
        .map((entry: JsonValue) => String((entry as LooseRecord).comment_version_key ?? ""))
        .filter(Boolean),
);

const comments = await listCandidateComments();
const scanComments = comments.filter((comment) => !processed.has(commentVersionKey(comment)));
const candidates = scanComments.filter((comment) => shouldSendToCheapModel(comment, trustedBots));
let modelError: string | null = null;
let modelResults = new Map<string, SpamModelResult>();
if (candidates.length > 0) {
  try {
    modelResults = await scanWithModel(candidates, model);
  } catch (error) {
    modelError = compactText(error instanceof Error ? error.message : String(error), 500);
    console.warn(
      `[spam-scanner] cheap model scan failed; writing deterministic audit only: ${modelError}`,
    );
  }
}
const audited = candidates.map((comment) => ({
  comment,
  result: modelResults.get(comment.id) ?? null,
}));
const auditedKeys = new Set(audited.map((audit) => spamAuditKey(audit.comment)));

for (const audit of audited) {
  writeAuditRecord(audit.comment, audit.result, modelError);
}
if (writeReport) {
  for (const comment of scanComments) {
    if (!auditedKeys.has(spamAuditKey(comment))) removeAuditRecord(comment);
  }
}

const report = {
  status: "audit_only",
  generated_at: new Date().toISOString(),
  repo: targetRepo,
  model: PUBLIC_CODEX_MODEL,
  since,
  max_comments: maxComments,
  scanned_comments: comments.length,
  new_comments: scanComments.length,
  model_candidates: candidates.length,
  audited: audited.length,
  model_error: modelError,
  high_signal: audited.filter((audit) => audit.result?.spam_signal === "high").length,
  medium_signal: audited.filter((audit) => audit.result?.spam_signal === "medium").length,
  action: "none",
  entries: audited.map((audit) => auditSummary(audit.comment, audit.result, modelError)),
};

appendLedger(
  audited.map((audit) => ({
    ...auditSummary(audit.comment, audit.result, modelError),
    comment_version_key: commentVersionKey(audit.comment),
    processed_at: report.generated_at,
  })),
);

if (writeReport) writeReports(report);
console.log(JSON.stringify(report, null, 2));

async function listCandidateComments() {
  const comments: SpamScanComment[] = [];
  const exactScan = commentIds.size > 0 || reviewCommentIds.size > 0;
  const fetchLimit = exactScan ? maxComments : broadFetchLimit(maxComments);
  if (commentIds.size > 0) {
    for (const id of commentIds) comments.push(fetchIssueComment(id));
  } else {
    comments.push(
      ...ghPagedLimit<LooseRecord>(
        `repos/${targetRepo}/issues/comments?since=${encodeURIComponent(since)}&sort=updated&direction=desc`,
        fetchLimit,
      ).map((comment) => normalizeSpamComment(comment, "issue_comment")),
    );
  }

  if (reviewCommentIds.size > 0) {
    for (const id of reviewCommentIds) comments.push(fetchReviewComment(id));
  } else if (commentIds.size === 0) {
    comments.push(
      ...ghPagedLimit<LooseRecord>(
        `repos/${targetRepo}/pulls/comments?since=${encodeURIComponent(since)}&sort=updated&direction=desc`,
        fetchLimit,
      ).map((comment) => normalizeSpamComment(comment, "pull_request_review_comment")),
    );
  }

  const unique = uniqueComments(comments);
  hydrateMinimization(unique);
  if (exactScan) return unique.slice(0, maxComments);
  return prioritizeSpamScanComments({
    comments: unique,
    maxComments,
    processedCommentVersionKeys: processed,
    trustedBots,
  });
}

function broadFetchLimit(limit: number) {
  return Math.min(Math.max(limit * 25, limit), 2500);
}

function fetchIssueComment(id: number) {
  return normalizeSpamComment(
    ghJson<LooseRecord>(["api", `repos/${targetRepo}/issues/comments/${id}`]),
    "issue_comment",
  );
}

function fetchReviewComment(id: number) {
  return normalizeSpamComment(
    ghJson<LooseRecord>(["api", `repos/${targetRepo}/pulls/comments/${id}`]),
    "pull_request_review_comment",
  );
}

function hydrateMinimization(comments: SpamScanComment[]) {
  const nodeIds = comments
    .map((comment) => comment.node_id)
    .filter((id): id is string => Boolean(id));
  if (nodeIds.length === 0) return;
  for (let index = 0; index < nodeIds.length; index += 50) {
    const batch = nodeIds.slice(index, index + 50);
    const query = `query($ids:[ID!]!) {
      nodes(ids:$ids) {
        ... on IssueComment { id isMinimized minimizedReason }
        ... on PullRequestReviewComment { id isMinimized minimizedReason }
      }
    }`;
    const response = fetchMinimizationBatch(query, batch);
    const byId = new Map(
      graphqlNodesToleratingNotFound(response).map((node) => [String(node.id ?? ""), node]),
    );
    for (const comment of comments) {
      const node = comment.node_id ? byId.get(comment.node_id) : null;
      if (!node) continue;
      if (node.isMinimized) comment.minimized_reason = String(node.minimizedReason ?? "minimized");
    }
  }
}

// gh exits non-zero on partial GraphQL errors (e.g. NOT_FOUND for comments deleted between
// listing and this batch query) even though stdout still carries the full data payload.
// Recover that payload; graphqlNodesToleratingNotFound decides whether the errors are fatal.
function fetchMinimizationBatch(query: string, ids: string[]): LooseRecord {
  const ghArgs = [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    ...ids.flatMap((id) => ["-F", `ids[]=${id}`]),
  ];
  try {
    return ghJson<LooseRecord>(ghArgs);
  } catch (error) {
    const stdout = ghStdoutFromError(error);
    if (!stdout) throw error;
    try {
      return JSON.parse(stdout) as LooseRecord;
    } catch {
      throw error;
    }
  }
}

async function scanWithModel(comments: SpamScanComment[], scanModel: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[spam-scanner] OPENAI_API_KEY missing; writing deterministic audit only.");
    return new Map<string, SpamModelResult>();
  }
  const payload = {
    model: internalCodexModel(scanModel),
    reasoning: { effort: "high" },
    input: [
      {
        role: "system",
        content: SPAM_MODEL_SYSTEM_PROMPT,
      },
      { role: "user", content: JSON.stringify(buildSpamModelInput(comments)) },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "spam_scan",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  comment_id: { type: "string" },
                  spam_signal: { type: "string", enum: ["none", "low", "medium", "high"] },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  reasons: { type: "array", items: { type: "string" } },
                  should_investigate: { type: "boolean" },
                },
                required: [
                  "comment_id",
                  "spam_signal",
                  "confidence",
                  "reasons",
                  "should_investigate",
                ],
              },
            },
          },
          required: ["results"],
        },
      },
    },
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`OpenAI spam scan failed: HTTP ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as LooseRecord;
  const text = outputText(data);
  const parsed = JSON.parse(text || "{}") as JsonValue;
  return new Map(normalizeModelResults(parsed).map((result) => [result.comment_id, result]));
}

function outputText(data: LooseRecord) {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  return output
    .flatMap((item: JsonValue) =>
      Array.isArray((item as LooseRecord).content)
        ? ((item as LooseRecord).content as JsonValue[])
        : [],
    )
    .map((content: JsonValue) => String((content as LooseRecord).text ?? ""))
    .join("")
    .trim();
}

function auditSummary(
  comment: SpamScanComment,
  result: SpamModelResult | null,
  scanModelError: string | null = null,
) {
  return {
    comment_key: spamAuditKey(comment),
    comment_id: comment.id,
    comment_kind: comment.kind,
    comment_url: comment.html_url,
    author: comment.author,
    author_association: comment.author_association,
    updated_at: comment.updated_at,
    spam_signal: result?.spam_signal ?? "deterministic_candidate",
    confidence: result?.confidence ?? 0,
    should_investigate: result?.should_investigate ?? false,
    reasons: result?.reasons ?? (scanModelError ? [`model_error: ${scanModelError}`] : []),
    model_error: scanModelError,
  };
}

function readLedger() {
  const file = ledgerPath();
  if (!fs.existsSync(file)) return { updated_at: null, entries: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as LooseRecord;
    return {
      updated_at: data.updated_at ?? null,
      entries: Array.isArray(data.entries) ? data.entries : [],
    };
  } catch {
    return { updated_at: null, entries: [] };
  }
}

function appendLedger(entries: LooseRecord[]) {
  if (entries.length === 0) return;
  const current = readLedger();
  const byKey = new Map(
    (current.entries ?? []).map((entry: JsonValue) => [
      String((entry as LooseRecord).comment_version_key ?? ""),
      entry,
    ]),
  );
  for (const entry of entries) byKey.set(String(entry.comment_version_key ?? ""), entry);
  const next = {
    updated_at: new Date().toISOString(),
    entries: [...byKey.values()].slice(-5000),
  };
  fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
  fs.writeFileSync(ledgerPath(), `${JSON.stringify(next, null, 2)}\n`);
}

function writeAuditRecord(
  comment: SpamScanComment,
  result: SpamModelResult | null,
  scanModelError: string | null,
) {
  const file = auditRecordPath(comment);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record: LooseRecord = renderSpamAuditRecord({
    comment,
    model: PUBLIC_CODEX_MODEL,
    result,
  });
  record.model_error = scanModelError;
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

function removeAuditRecord(comment: SpamScanComment) {
  fs.rmSync(auditRecordPath(comment), { force: true });
}

function auditRecordPath(comment: SpamScanComment) {
  return path.join(
    repoRoot(),
    "results",
    "spam-audit",
    targetRepo.replace("/", "-"),
    `${spamAuditKey(comment)}.json`,
  );
}

function writeReports(report: LooseRecord) {
  for (const name of ["spam-scanner-latest.json"]) {
    const file = path.join(repoRoot(), "results", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  }
}

function ledgerPath() {
  return path.join(repoRoot(), "results", "spam-scanner.json");
}

function uniqueComments(comments: SpamScanComment[]) {
  const byKey = new Map<string, SpamScanComment>();
  for (const comment of comments) {
    const key = `${comment.kind}:${comment.id}`;
    if (!comment.id || byKey.has(key)) continue;
    byKey.set(key, comment);
  }
  return [...byKey.values()].sort((left, right) => commentTime(right) - commentTime(left));
}

function commentTime(comment: SpamScanComment) {
  const updated = Date.parse(String(comment.updated_at ?? ""));
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(String(comment.created_at ?? ""));
  return Number.isFinite(created) ? created : 0;
}

function stringSetting(value: JsonValue, fallback: string) {
  const text = String(value ?? fallback).trim();
  return text || fallback;
}

function numberSet(value: JsonValue, name: string) {
  const out = new Set<number>();
  for (const part of String(value ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const number = Number(trimmed);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`invalid ${name}: ${trimmed}`);
    out.add(number);
  }
  return out;
}
