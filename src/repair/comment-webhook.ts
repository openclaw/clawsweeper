#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";

import type { JsonValue, LooseRecord } from "./json-types.js";
import { parseCommand } from "./comment-router-core.js";

const DEFAULT_PORT = 8787;
const COMMAND_PATTERN =
  /(^|[ \t\r\n])@(?:clawsweeper|openclaw-clawsweeper)\b(?:\[bot\])?|(^|[ \t\r\n])\/(?:clawsweeper|review|re-review|rerun[ -]?review|status|explain|visual|viz|visualize|fix|build|implement|create[ -]?pr|fix[ -]?issue|autofix|auto[ -]?fix|automerge|auto[ -]?merge|approve|stop|autoclose)\b/i;
const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

type AcceptedIssueCommentWebhook = {
  accepted: true;
  targetRepo: string;
  itemNumber: number;
  commentId: number;
  installationId: number;
  sourceAction: string;
};

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
  const decision = classifyIssueCommentWebhook({ event, payload });
  if (!decision.accepted) return { statusCode: 202, body: decision };
  const accepted = decision as AcceptedIssueCommentWebhook;

  const token = await createInstallationToken({
    installationId: accepted.installationId,
    owner: "openclaw",
    repositories: [accepted.targetRepo.split("/")[1] ?? "", "clawsweeper"],
  });
  const statusCommentId = await createFastAckComment({
    token,
    repo: accepted.targetRepo,
    itemNumber: accepted.itemNumber,
    sourceCommentId: accepted.commentId,
  });
  await addReaction({
    token,
    repo: accepted.targetRepo,
    commentId: accepted.commentId,
    content: "eyes",
  });
  await dispatchCommentRouter({
    token,
    targetRepo: accepted.targetRepo,
    itemNumber: accepted.itemNumber,
    commentId: accepted.commentId,
    statusCommentId,
    sourceAction: accepted.sourceAction,
  });
  return { statusCode: 202, body: { ok: true, status_comment_id: statusCommentId } };
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
  if (!COMMAND_PATTERN.test(String(comment.body ?? ""))) {
    return { accepted: false, reason: "no ClawSweeper command" };
  }
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
  const itemNumber = Number(issue.number);
  const commentId = Number(comment.id);
  const installationId = Number(asRecord(payload.installation).id);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
    return { accepted: false, reason: "missing repository full_name" };
  }
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
    targetRepo,
    itemNumber,
    commentId,
    installationId,
    sourceAction: String(payload.action ?? "created"),
  };
}

function isAuthorReadOnlyWebhookCommand({
  comment,
  issue,
}: {
  comment: LooseRecord;
  issue: LooseRecord;
}) {
  const parsed = parseCommand(String(comment.body ?? ""));
  if (parsed?.intent !== "re_review" && parsed?.intent !== "hatch") return false;
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
    `<!-- clawsweeper-command-ack:${sourceCommentId} -->`,
    "🦞👀",
    "ClawSweeper picked this up.",
    "",
    "Command router queued. I will update this comment with the next step.",
  ].join("\n");
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
  installationId,
  owner,
  repositories,
}: {
  installationId: number;
  owner: string;
  repositories: string[];
}) {
  const appIssuer = process.env.CLAWSWEEPER_APP_ID || process.env.CLAWSWEEPER_APP_CLIENT_ID;
  const privateKey = normalizePrivateKey(process.env.CLAWSWEEPER_APP_PRIVATE_KEY ?? "");
  if (!appIssuer || !privateKey)
    throw new Error("GitHub App id/client id and private key are required");
  const jwt = signAppJwt({ issuer: appIssuer, privateKey });
  const response = await githubFetch({
    token: jwt,
    path: `/app/installations/${installationId}/access_tokens`,
    method: "POST",
    body: {
      repository_names: repositories.filter(Boolean),
      permissions: {
        actions: "write",
        contents: "write",
        issues: "write",
        pull_requests: "write",
      },
    },
    authScheme: "Bearer",
  });
  const token = String(response.token ?? "");
  if (!token) throw new Error(`installation token response missing token for ${owner}`);
  return token;
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
  const response = await githubFetch({
    token,
    path: `/repos/${repo}/issues/${itemNumber}/comments`,
    method: "POST",
    body: { body: renderFastAckComment(sourceCommentId) },
  });
  const id = Number(response.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error("fast ack comment response missing id");
  return id;
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

async function dispatchCommentRouter({
  token,
  targetRepo,
  itemNumber,
  commentId,
  statusCommentId,
  sourceAction,
}: {
  token: string;
  targetRepo: string;
  itemNumber: number;
  commentId: number;
  statusCommentId: number;
  sourceAction: string;
}) {
  await githubFetch({
    token,
    path: "/repos/openclaw/clawsweeper/dispatches",
    method: "POST",
    body: {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: targetRepo,
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

function asRecord(value: JsonValue): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
