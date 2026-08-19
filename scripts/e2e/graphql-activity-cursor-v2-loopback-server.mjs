#!/usr/bin/env node
import { createServer } from "node:http";

let v2Mode = "complete";
let v2Read = 0;

const server = createServer(async (request, response) => {
  const body = await requestBody(request);
  const url = new URL(request.url || "/", "http://loopback.invalid");
  if (url.pathname === "/graphql") {
    const payload = body ? JSON.parse(body) : {};
    const query = String(payload.query || "");
    if (query.includes("ReviewedPrActivityCursorV2")) {
      v2Read += 1;
      return json(response, 200, v2GraphqlResponse(query, v2Mode, v2Read));
    }
    const number = Number(payload.variables?.number || 0);
    return json(response, 200, {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: `thread-${number}`, isResolved: false }],
            },
          },
        },
      },
    });
  }
  const rest = url.pathname.match(
    /^\/repos\/openclaw\/clawsweeper\/pulls\/(\d+)\/(reviews|comments)$/,
  );
  if (rest) {
    const number = Number(rest[1]);
    return json(response, 200, [rest[2] === "reviews" ? restReview(number) : restComment(number)]);
  }
  return json(response, 404, { message: `unexpected loopback path ${url.pathname}` });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback listener has no port");
  process.send?.({ kind: "ready", port: address.port });
});

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.kind === "mode") {
    v2Mode = String(message.mode || "complete");
    v2Read = 0;
    process.send?.({ kind: "mode", id: message.id });
  } else if (message.kind === "close") {
    server.close(() => process.exit(0));
  }
});

function restReview(number) {
  return {
    id: 10_000 + number,
    user: { login: "reviewer" },
    state: "APPROVED",
    body: `review ${number}`,
    submitted_at: "2026-08-13T10:00:00Z",
    commit_id: "a".repeat(40),
  };
}

function restComment(number) {
  return {
    id: 20_000 + number,
    pull_request_review_id: 10_000 + number,
    in_reply_to_id: null,
    user: { login: "reviewer" },
    body: `comment ${number}`,
    created_at: "2026-08-13T10:01:00Z",
    updated_at: "2026-08-13T10:01:00Z",
    path: "src/example.ts",
    line: number,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    original_line: number,
    original_commit_id: "a".repeat(40),
    commit_id: "a".repeat(40),
  };
}

function v2GraphqlResponse(query, mode, read) {
  const repository = {};
  for (const match of query.matchAll(/pr_(\d+): pullRequest/g)) {
    const number = Number(match[1]);
    const state = mode === "concurrent" && read > 1 ? "DISMISSED" : "APPROVED";
    const commentNodes = [
      {
        fullDatabaseId: String(20_000 + number),
        pullRequestReview: { fullDatabaseId: String(10_000 + number) },
        replyTo: null,
        author: { login: "reviewer" },
        body: `comment ${number}`,
        createdAt: "2026-08-13T10:01:00Z",
        updatedAt: "2026-08-13T10:01:00Z",
        path: "src/example.ts",
        line: number,
        startLine: null,
        originalLine: number,
        originalCommit: { oid: "a".repeat(40) },
        commit: { oid: "a".repeat(40) },
      },
    ];
    repository[`pr_${number}`] = {
      reviews: {
        totalCount: 1,
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            fullDatabaseId: String(10_000 + number),
            author: { login: "reviewer" },
            state,
            body: `review ${number}`,
            submittedAt: "2026-08-13T10:00:00Z",
            commit: { oid: "a".repeat(40) },
          },
        ],
      },
      reviewThreads: {
        totalCount: 1,
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            id: `thread-${number}`,
            isResolved: false,
            comments: {
              totalCount: mode === "partial" ? 2 : 1,
              pageInfo: { hasNextPage: false },
              nodes: commentNodes,
            },
          },
        ],
      },
    };
  }
  return { data: { repository } };
}

function requestBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
