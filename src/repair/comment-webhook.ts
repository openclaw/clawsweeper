#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";

import { repositoryProfileFor } from "../repository-profiles.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  isProofNudgeCommentBody,
  parseCommand,
  staleClosedItemCommandReason,
} from "./comment-router-core.js";

const DEFAULT_PORT = 8787;
const REVIEW_REPO = "openclaw/clawsweeper";
const COMMAND_PATTERN =
  /(^|[ \t\r\n])@(?:clawsweeper|openclaw-clawsweeper)\b(?:\[bot\])?|(^|[ \t\r\n])\/(?:clawsweeper|review|re-review|rerun[ -]?review|status|explain|fix|build|implement|create[ -]?pr|fix[ -]?issue|autofix|auto[ -]?fix|automerge|auto[ -]?merge|approve|stop|autoclose)\b/i;
const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ISSUE_ITEM_ACTIONS = new Set(["opened", "reopened", "edited", "labeled", "unlabeled"]);
const PULL_ITEM_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "edited",
  "labeled",
  "unlabeled",
]);
const DEFAULT_FAST_ACK_SETTLE_DELAYS_MS = [250, 1500, 10_000];
const DEFAULT_CODEX_TIMEOUT_MS = 600_000;
const MAX_ADAPTIVE_CODEX_TIMEOUT_MS = 1_800_000;
const PR_SIZE_BASELINE_FILES = 20;
const PR_SIZE_FILE_STEP_MS = 10_000;
const PR_SIZE_BASELINE_LINES = 1_000;
const PR_SIZE_LINE_STEP_MS = 50;
const MAX_PR_FILE_TIMEOUT_BONUS_MS = 600_000;
const MAX_PR_LINE_TIMEOUT_BONUS_MS = 300_000;
const MEDIA_PROOF_TIMEOUT_BONUS_MS = 120_000;
const MAX_MEDIA_PROOF_URLS = 4;
const VIDEO_PROOF_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".webm", ".avi", ".mkv"]);
const inFlightFastAcks = new Map<string, Promise<number>>();

type AcceptedIssueCommentWebhook = {
  accepted: true;
  type: "issue_comment";
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  commentId: number;
  installationId: number;
  sourceAction: string;
};

type AcceptedItemWebhook = {
  accepted: true;
  type: "item";
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  installationId: number;
  sourceEvent: "issues" | "pull_request";
  sourceAction: string;
  supersedesInProgress: boolean;
  codexTimeoutMs?: number;
};

type AcceptedWebhook = AcceptedIssueCommentWebhook | AcceptedItemWebhook;

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

export function startServer() {
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10) || DEFAULT_PORT;
  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(port, () => {
    console.log(`[clawsweeper webhook] listening on :${port}`);
  });
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  if (request.method !== "POST" || request.url !== "/github/webhook") {
    response.writeHead(404).end("not found\n");
    return;
  }
  try {
    const body = await readBody(request);
    verifyGitHubSignature({
      secret: process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "",
      signature: String(request.headers["x-hub-signature-256"] ?? ""),
      body,
    });
    const event = String(request.headers["x-github-event"] ?? "");
    const payload = JSON.parse(body) as LooseRecord;
    const result = await handleGitHubWebhook({ event, payload });
    response.writeHead(result.statusCode, { "content-type": "application/json" });
    response.end(`${JSON.stringify(result.body)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[clawsweeper webhook] ${message}`);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(`${JSON.stringify({ ok: false, error: message })}\n`);
  }
}

export async function handleGitHubWebhook({
  event,
  payload,
}: {
  event: string;
  payload: LooseRecord;
}) {
  const decision = classifyWebhook({ event, payload });
  if (!decision.accepted) return { statusCode: 202, body: decision };
  const accepted = decision as AcceptedWebhook;

  const appJwt = createAppJwt();
  const dispatchToken = await createReviewRepoDispatchToken({ appJwt });

  if (accepted.type === "item") {
    await dispatchItemReview({ token: dispatchToken, accepted });
    return { statusCode: 202, body: { ok: true, dispatched: "clawsweeper_item" } };
  }

  const targetToken = await createInstallationToken({
    appJwt,
    installationId: accepted.installationId,
    label: accepted.targetRepo,
    repositories: [repoName(accepted.targetRepo)],
    permissions: {
      issues: "write",
      pull_requests: "write",
    },
  });
  const statusCommentId = await createFastAckCommentOnce({
    token: targetToken,
    repo: accepted.targetRepo,
    itemNumber: accepted.itemNumber,
    sourceCommentId: accepted.commentId,
  });
  await addReaction({
    token: targetToken,
    repo: accepted.targetRepo,
    commentId: accepted.commentId,
    content: "eyes",
  });
  await dispatchCommentRouter({
    token: dispatchToken,
    targetRepo: accepted.targetRepo,
    targetBranch: accepted.targetBranch,
    itemNumber: accepted.itemNumber,
    commentId: accepted.commentId,
    statusCommentId,
    sourceAction: accepted.sourceAction,
  });
  settleFastAckComments({
    token: targetToken,
    repo: accepted.targetRepo,
    itemNumber: accepted.itemNumber,
    sourceCommentId: accepted.commentId,
    delaysMs: fastAckSettleDelaysMs(process.env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS),
  });
  return { statusCode: 202, body: { ok: true, status_comment_id: statusCommentId } };
}

export function classifyWebhook({ event, payload }: { event: string; payload: LooseRecord }) {
  const comment = classifyIssueCommentWebhook({ event, payload });
  if (comment.accepted || comment.reason !== "not issue_comment") return comment;
  return classifyItemWebhook({ event, payload });
}

export function classifyIssueCommentWebhook({
  event,
  payload,
}: {
  event: string;
  payload: LooseRecord;
}) {
  if (event !== "issue_comment") return { accepted: false, reason: "not issue_comment" };
  if (!["created", "edited"].includes(String(payload.action ?? ""))) {
    return { accepted: false, reason: "unsupported action" };
  }
  const comment = asRecord(payload.comment);
  const issue = asRecord(payload.issue);
  const repo = asRecord(payload.repository);
  const association = String(comment.author_association ?? "").toUpperCase();
  if (isProofNudgeCommentBody(String(comment.body ?? ""))) {
    return { accepted: false, reason: "proof nudge comment" };
  }
  if (!COMMAND_PATTERN.test(String(comment.body ?? ""))) {
    return { accepted: false, reason: "no ClawSweeper command" };
  }
  const parsedCommand = parseCommand(String(comment.body ?? ""));
  if (!parsedCommand) return { accepted: false, reason: "no routable ClawSweeper command" };
  if (
    !ALLOWED_ASSOCIATIONS.has(association) &&
    !isAuthorReadOnlyWebhookCommand({ comment, issue })
  ) {
    return {
      accepted: false,
      reason: `author association ${association || "unknown"} is not allowed`,
    };
  }
  const targetRepo = String(repo.full_name ?? "");
  const targetBranch = targetDefaultBranch(repo);
  if (!isEligibleRepositoryPayload(repo)) {
    return { accepted: false, reason: "repository not eligible" };
  }
  const staleReason = staleClosedItemCommandReason({
    command: {
      intent: parsedCommand?.intent,
      comment_created_at: comment.created_at,
      comment_updated_at: comment.updated_at,
    },
    issue,
    pull: issue.pull_request,
  });
  if (staleReason) return { accepted: false, reason: staleReason };
  const itemNumber = Number(issue.number);
  const commentId = Number(comment.id);
  const installationId = Number(asRecord(payload.installation).id);
  if (!Number.isInteger(itemNumber) || itemNumber <= 0) {
    return { accepted: false, reason: "missing issue number" };
  }
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return { accepted: false, reason: "missing comment id" };
  }
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return { accepted: false, reason: "missing installation id" };
  }
  return {
    accepted: true,
    type: "issue_comment",
    targetRepo,
    targetBranch,
    itemNumber,
    commentId,
    installationId,
    sourceAction: String(payload.action ?? "created"),
  };
}

export function classifyItemWebhook({ event, payload }: { event: string; payload: LooseRecord }) {
  const action = String(payload.action ?? "");
  const repo = asRecord(payload.repository);
  if (!isEligibleRepositoryPayload(repo))
    return { accepted: false, reason: "repository not eligible" };
  if (isIgnoredLabelMutation({ action, payload })) {
    return { accepted: false, reason: "routine ClawSweeper label mutation" };
  }
  const targetRepo = String(repo.full_name ?? "");
  const targetBranch = targetDefaultBranch(repo);
  const installationId = Number(asRecord(payload.installation).id);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return { accepted: false, reason: "missing installation id" };
  }

  if (event === "issues") {
    if (!ISSUE_ITEM_ACTIONS.has(action)) return { accepted: false, reason: "unsupported action" };
    const issue = asRecord(payload.issue);
    const itemNumber = Number(issue.number);
    if (!Number.isInteger(itemNumber) || itemNumber <= 0) {
      return { accepted: false, reason: "missing issue number" };
    }
    return {
      accepted: true,
      type: "item",
      targetRepo,
      targetBranch,
      itemNumber,
      itemKind: "issue",
      installationId,
      sourceEvent: "issues",
      sourceAction: action,
      supersedesInProgress: action === "edited",
    };
  }

  if (event === "pull_request") {
    if (!PULL_ITEM_ACTIONS.has(action)) return { accepted: false, reason: "unsupported action" };
    const pull = asRecord(payload.pull_request);
    const itemNumber = Number(pull.number);
    if (!Number.isInteger(itemNumber) || itemNumber <= 0) {
      return { accepted: false, reason: "missing pull request number" };
    }
    return {
      accepted: true,
      type: "item",
      targetRepo,
      targetBranch,
      itemNumber,
      itemKind: "pull_request",
      installationId,
      sourceEvent: "pull_request",
      sourceAction: action,
      supersedesInProgress: ["edited", "synchronize", "ready_for_review"].includes(action),
      codexTimeoutMs: adaptiveCodexTimeoutMsForPullRequest(pull),
    };
  }

  return { accepted: false, reason: "unsupported event" };
}

export function adaptiveCodexTimeoutMsForTest(pull: LooseRecord) {
  return adaptiveCodexTimeoutMsForPullRequest(pull);
}

function adaptiveCodexTimeoutMsForPullRequest(pull: LooseRecord) {
  const changedFiles = nonNegativeInteger(pull.changed_files);
  const changedLines = nonNegativeInteger(pull.additions) + nonNegativeInteger(pull.deletions);
  const mediaProofUrls = videoProofUrlsFromText(
    [String(pull.title ?? ""), String(pull.body ?? "")].join("\n"),
  );
  const fileBonusMs = clamp(
    (changedFiles - PR_SIZE_BASELINE_FILES) * PR_SIZE_FILE_STEP_MS,
    0,
    MAX_PR_FILE_TIMEOUT_BONUS_MS,
  );
  const lineBonusMs = clamp(
    (changedLines - PR_SIZE_BASELINE_LINES) * PR_SIZE_LINE_STEP_MS,
    0,
    MAX_PR_LINE_TIMEOUT_BONUS_MS,
  );
  const mediaBonusMs = mediaProofUrls.length * MEDIA_PROOF_TIMEOUT_BONUS_MS;
  return clamp(
    DEFAULT_CODEX_TIMEOUT_MS + fileBonusMs + lineBonusMs + mediaBonusMs,
    DEFAULT_CODEX_TIMEOUT_MS,
    MAX_ADAPTIVE_CODEX_TIMEOUT_MS,
  );
}

function videoProofUrlsFromText(text: string) {
  const matches = text.match(/https?:\/\/[^\s<>"'\\)]+/g) ?? [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const cleaned = trimTrailingUrlPunctuation(raw);
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    const pathname = parsed.pathname.toLowerCase();
    const isVideo = [...VIDEO_PROOF_EXTENSIONS].some((extension) => pathname.endsWith(extension));
    if (!isVideo || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    urls.push(parsed.href);
    if (urls.length >= MAX_MEDIA_PROOF_URLS) break;
  }
  return urls;
}

function trimTrailingUrlPunctuation(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const char = raw.charCodeAt(end - 1);
    if (char !== 44 && char !== 46 && char !== 58 && char !== 59) break;
    end -= 1;
  }
  return raw.slice(0, end);
}

function nonNegativeInteger(value: JsonValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isEligibleRepositoryPayload(repo: LooseRecord) {
  const targetRepo = String(repo.full_name ?? "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) return false;
  if (Boolean(repo.private) || Boolean(repo.archived) || Boolean(repo.fork)) return false;
  if (repo.has_issues === false) return false;
  try {
    repositoryProfileFor(targetRepo);
    return true;
  } catch {
    return false;
  }
}

function targetDefaultBranch(repo: LooseRecord) {
  const branch = String(repo.default_branch ?? "main").trim() || "main";
  return /^[A-Za-z0-9_./-]+$/.test(branch) ? branch : "main";
}

function isIgnoredLabelMutation({ action, payload }: { action: string; payload: LooseRecord }) {
  if (action !== "labeled" && action !== "unlabeled") return false;
  return isClawsweeperWebhookSender(asRecord(payload.sender));
}

function isClawsweeperWebhookSender(sender: LooseRecord) {
  const login = normalizedLogin(sender.login);
  return login === "clawsweeper[bot]" || login === "openclaw-clawsweeper[bot]";
}

function isAuthorReadOnlyWebhookCommand({
  comment,
  issue,
}: {
  comment: LooseRecord;
  issue: LooseRecord;
}) {
  const parsed = parseCommand(String(comment.body ?? ""));
  if (parsed?.intent !== "re_review") return false;
  const commentAuthor = normalizedLogin(asRecord(comment.user).login);
  const issueAuthor = normalizedLogin(asRecord(issue.user).login);
  return Boolean(commentAuthor && issueAuthor && commentAuthor === issueAuthor);
}

function normalizedLogin(value: JsonValue) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function renderFastAckComment(sourceCommentId: number) {
  return [
    fastAckMarker(sourceCommentId),
    "🦞👀",
    "ClawSweeper picked this up.",
    "",
    "Command router queued. I will update this comment with the next step.",
  ].join("\n");
}

function fastAckMarker(sourceCommentId: number) {
  return `<!-- clawsweeper-command-ack:${sourceCommentId} -->`;
}

export function verifyGitHubSignature({
  secret,
  signature,
  body,
}: {
  secret: string;
  signature: string;
  body: string;
}) {
  if (!secret) throw new Error("CLAWSWEEPER_WEBHOOK_SECRET is required");
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  const actual = String(signature ?? "");
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  ) {
    throw new Error("invalid GitHub webhook signature");
  }
}

async function createInstallationToken({
  appJwt,
  installationId,
  label,
  repositories,
  permissions,
}: {
  appJwt: string;
  installationId: number;
  label: string;
  repositories: string[];
  permissions: LooseRecord;
}) {
  const response = await githubFetch({
    token: appJwt,
    path: `/app/installations/${installationId}/access_tokens`,
    method: "POST",
    body: {
      repository_names: repositories.filter(Boolean),
      permissions,
    },
    authScheme: "Bearer",
  });
  const token = String(response.token ?? "");
  if (!token) throw new Error(`installation token response missing token for ${label}`);
  return token;
}

async function createReviewRepoDispatchToken({ appJwt }: { appJwt: string }) {
  const installation = await githubFetch({
    token: appJwt,
    path: `/repos/${REVIEW_REPO}/installation`,
    method: "GET",
    authScheme: "Bearer",
  });
  const installationId = Number(installation.id);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(`review repo installation response missing id for ${REVIEW_REPO}`);
  }
  return createInstallationToken({
    appJwt,
    installationId,
    label: REVIEW_REPO,
    repositories: [repoName(REVIEW_REPO)],
    permissions: {
      contents: "write",
    },
  });
}

function createAppJwt() {
  const appIssuer = process.env.CLAWSWEEPER_APP_ID || process.env.CLAWSWEEPER_APP_CLIENT_ID;
  const privateKey = normalizePrivateKey(process.env.CLAWSWEEPER_APP_PRIVATE_KEY ?? "");
  if (!appIssuer || !privateKey)
    throw new Error("GitHub App id/client id and private key are required");
  return signAppJwt({ issuer: appIssuer, privateKey });
}

function signAppJwt({ issuer, privateKey }: { issuer: string; privateKey: string }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: issuer }));
  const input = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(privateKey);
  return `${input}.${base64Url(signature)}`;
}

async function createFastAckComment({
  token,
  repo,
  itemNumber,
  sourceCommentId,
}: {
  token: string;
  repo: string;
  itemNumber: number;
  sourceCommentId: number;
}) {
  const existingId = await pruneFastAckComments({ token, repo, itemNumber, sourceCommentId });
  if (existingId) return existingId;
  const response = await githubFetch({
    token,
    path: `/repos/${repo}/issues/${itemNumber}/comments`,
    method: "POST",
    body: { body: renderFastAckComment(sourceCommentId) },
  });
  const id = Number(response.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error("fast ack comment response missing id");
  return (await pruneFastAckComments({ token, repo, itemNumber, sourceCommentId })) ?? id;
}

function settleFastAckComments({
  token,
  repo,
  itemNumber,
  sourceCommentId,
  delaysMs = DEFAULT_FAST_ACK_SETTLE_DELAYS_MS,
}: {
  token: string;
  repo: string;
  itemNumber: number;
  sourceCommentId: number;
  delaysMs?: number[];
}) {
  const cleanup = async () => {
    for (const delayMs of delaysMs) {
      await sleep(delayMs);
      await pruneFastAckComments({ token, repo, itemNumber, sourceCommentId });
    }
  };
  void cleanup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[clawsweeper webhook] fast ack cleanup failed: ${message}`);
  });
}

function fastAckSettleDelaysMs(value: string | undefined) {
  const delays = String(value ?? "")
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((delay) => Number.isFinite(delay) && delay >= 0);
  return delays.length > 0 ? delays : DEFAULT_FAST_ACK_SETTLE_DELAYS_MS;
}

async function createFastAckCommentOnce({
  token,
  repo,
  itemNumber,
  sourceCommentId,
}: {
  token: string;
  repo: string;
  itemNumber: number;
  sourceCommentId: number;
}) {
  const key = fastAckKey({ repo, itemNumber, sourceCommentId });
  const pending = inFlightFastAcks.get(key);
  if (pending) return pending;
  const next = createFastAckComment({ token, repo, itemNumber, sourceCommentId }).finally(() => {
    inFlightFastAcks.delete(key);
  });
  inFlightFastAcks.set(key, next);
  return next;
}

function fastAckKey({
  repo,
  itemNumber,
  sourceCommentId,
}: {
  repo: string;
  itemNumber: number;
  sourceCommentId: number;
}) {
  return `${repo.toLowerCase()}:${itemNumber}:${sourceCommentId}`;
}

function sleep(delayMs: number) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function pruneFastAckComments({
  token,
  repo,
  itemNumber,
  sourceCommentId,
}: {
  token: string;
  repo: string;
  itemNumber: number;
  sourceCommentId: number;
}) {
  const comments = await listFastAckComments({ token, repo, itemNumber, sourceCommentId });
  if (comments.length === 0) return null;
  const hasStatusComment = comments.some(isStatusBearingFastAckComment);
  comments.sort(compareFastAckKeepPriority);
  const keepId = Number(comments[0]?.id) || null;
  for (const comment of comments) {
    const id = Number(comment.id) || 0;
    if (id <= 0 || id === keepId) continue;
    if (hasStatusComment && isStatusBearingFastAckComment(comment)) continue;
    await githubFetch({
      token,
      path: `/repos/${repo}/issues/comments/${id}`,
      method: "DELETE",
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("404")) throw error;
    });
  }
  return keepId;
}

function compareFastAckKeepPriority(left: LooseRecord, right: LooseRecord) {
  const leftStatus = isStatusBearingFastAckComment(left) ? 1 : 0;
  const rightStatus = isStatusBearingFastAckComment(right) ? 1 : 0;
  if (leftStatus !== rightStatus) return rightStatus - leftStatus;
  if (leftStatus > 0) return compareCommentsByUpdatedAtDesc(left, right);
  return compareCommentsByCreatedAt(left, right);
}

function isStatusBearingFastAckComment(comment: LooseRecord) {
  const body = String(comment.body ?? "");
  return (
    body.includes("clawsweeper-command-status:") ||
    body.includes("<!-- clawsweeper-command-progress:start -->")
  );
}

function compareCommentsByUpdatedAtDesc(left: LooseRecord, right: LooseRecord) {
  const leftUpdated = String(left.updated_at ?? left.created_at ?? "");
  const rightUpdated = String(right.updated_at ?? right.created_at ?? "");
  return (
    rightUpdated.localeCompare(leftUpdated) || (Number(right.id) || 0) - (Number(left.id) || 0)
  );
}

function compareCommentsByCreatedAt(left: LooseRecord, right: LooseRecord) {
  const leftCreated = String(left.created_at ?? "");
  const rightCreated = String(right.created_at ?? "");
  return (
    leftCreated.localeCompare(rightCreated) || (Number(left.id) || 0) - (Number(right.id) || 0)
  );
}

async function listFastAckComments({
  token,
  repo,
  itemNumber,
  sourceCommentId,
}: {
  token: string;
  repo: string;
  itemNumber: number;
  sourceCommentId: number;
}) {
  const comments: LooseRecord[] = [];
  const marker = fastAckMarker(sourceCommentId);
  const since = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  for (let page = 1; page <= 5; page += 1) {
    const response = await githubFetch({
      token,
      path: `/repos/${repo}/issues/${itemNumber}/comments?per_page=100&page=${page}&since=${since}`,
      method: "GET",
    });
    if (!Array.isArray(response)) return comments;
    for (const comment of response) {
      const record = asRecord(comment);
      if (
        String(record.body ?? "").includes(marker) &&
        isClawsweeperWebhookSender(asRecord(record.user))
      ) {
        comments.push(record);
      }
    }
    if (response.length < 100) return comments;
  }
  return comments;
}

async function addReaction({
  token,
  repo,
  commentId,
  content,
}: {
  token: string;
  repo: string;
  commentId: number;
  content: string;
}) {
  try {
    await githubFetch({
      token,
      path: `/repos/${repo}/issues/comments/${commentId}/reactions`,
      method: "POST",
      body: { content },
    });
  } catch (error) {
    if (!/\b422\b|already exists/i.test(String(error))) throw error;
  }
}

async function dispatchItemReview({
  token,
  accepted,
}: {
  token: string;
  accepted: AcceptedItemWebhook;
}) {
  await githubFetch({
    token,
    path: `/repos/${REVIEW_REPO}/dispatches`,
    method: "POST",
    body: {
      event_type: "clawsweeper_item",
      client_payload: {
        target_repo: accepted.targetRepo,
        target_branch: accepted.targetBranch,
        item_number: accepted.itemNumber,
        item_kind: accepted.itemKind,
        source_event: accepted.sourceEvent,
        source_action: accepted.sourceAction,
        supersedes_in_progress: accepted.supersedesInProgress,
        ...(accepted.codexTimeoutMs ? { codex_timeout_ms: accepted.codexTimeoutMs } : {}),
      },
    },
  });
}

async function dispatchCommentRouter({
  token,
  targetRepo,
  targetBranch,
  itemNumber,
  commentId,
  statusCommentId,
  sourceAction,
}: {
  token: string;
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  commentId: number;
  statusCommentId: number;
  sourceAction: string;
}) {
  await githubFetch({
    token,
    path: `/repos/${REVIEW_REPO}/dispatches`,
    method: "POST",
    body: {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: targetRepo,
        target_branch: targetBranch,
        item_number: itemNumber,
        comment_id: commentId,
        status_comment_id: statusCommentId,
        source_event: "issue_comment",
        source_action: sourceAction,
        max_comments: "1",
      },
    },
  });
}

async function githubFetch({
  token,
  path,
  method,
  body,
  authScheme = "token",
}: {
  token: string;
  path: string;
  method: string;
  body?: JsonValue;
  authScheme?: "token" | "Bearer";
}) {
  const init: RequestInit = {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `${authScheme} ${token}`,
      "content-type": "application/json",
      "user-agent": "clawsweeper-comment-webhook",
      "x-github-api-version": "2022-11-28",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`https://api.github.com${path}`, init);
  const text = await response.text();
  if (!response.ok)
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${text}`);
  return text ? (JSON.parse(text) as LooseRecord) : {};
}

async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function normalizePrivateKey(value: string) {
  return value.trim().replace(/\\n/g, "\n");
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function repoName(targetRepo: string) {
  return targetRepo.split("/")[1] ?? "";
}

function asRecord(value: JsonValue): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
