#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  REVIEW_PLACEHOLDER_MARKER,
  reviewPlaceholderCursorMode,
  runReviewPlaceholderRecovery,
} from "../../../dist/review-placeholder-recovery.js";

const workerOrigin = process.env.PROOF_WORKER_ORIGIN;
const outputDir = path.resolve(
  process.env.PROOF_OUTPUT || ".artifacts/review-placeholder-cursor-rotation",
);
const secret = "placeholder-cursor-proof-secret";
const rotationRepo = "openclaw/openclaw";
const conflictRepo = "openclaw/cursor-proof";
const apiOrigin = "https://api.github.test";

if (!workerOrigin || !workerOrigin.startsWith("http://127.0.0.1:")) {
  throw new Error("PROOF_WORKER_ORIGIN must name the disposable local Wrangler HTTP listener");
}
await mkdir(outputDir, { recursive: true });

const bot = { login: "clawsweeper[bot]", type: "Bot" };
const openNumbers = Array.from({ length: 180 }, (_, index) => 1_001 + index);
const closedNumbers = Array.from({ length: 180 }, (_, index) => 2_001 + index);
const rotationChecks = Array.from({ length: 4 }, () => ({ open: [], closed: [] }));
const conflictChecks = [];
const cleanedComments = [];
const queueAcknowledgements = [];
const cursorTraffic = [];
let activeScenario = "rotation";
let runIndex = 0;
let activeNow = new Date("2026-07-17T12:00:00.000Z");
let conflictInjectionEnabled = false;
let conflictInjected = false;

const signature = (body) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const signedWorkerRequest = async (pathname, method = "GET", payload) => {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  return fetch(new URL(pathname, workerOrigin), {
    method,
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature(body),
    },
    ...(method === "PUT" || method === "POST" ? { body } : {}),
  });
};

const cursorSnapshot = async (repo, state) => {
  const mode = reviewPlaceholderCursorMode(repo, state);
  const response = await signedWorkerRequest(`/internal/state/cursors/${mode}`);
  assert.equal(response.status, 200);
  return response.json();
};

const candidate = (number, index) => ({
  number,
  updated_at: new Date(Date.parse("2026-07-15T12:00:00.000Z") + index * 1_000).toISOString(),
});

const placeholder = (number, commentId, createdAt) => ({
  id: commentId,
  body: `${REVIEW_PLACEHOLDER_MARKER}\n\n<!-- clawsweeper-review-status:started item=${number} sha=abc v=1 -->`,
  created_at: createdAt,
  updated_at: createdAt,
  user: bot,
});

const ordinaryComment = {
  body: "ClawSweeper review: keep open.",
  created_at: "2026-07-17T06:00:00.000Z",
  user: bot,
};

const proofFetch = async (input, init = {}) => {
  const sourceUrl = new URL(input instanceof Request ? input.url : input.toString());
  const method = String(init.method || (input instanceof Request ? input.method : "GET"));

  if (sourceUrl.host === new URL(workerOrigin).host) {
    const localUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, workerOrigin);
    if (
      conflictInjectionEnabled &&
      !conflictInjected &&
      method === "PUT" &&
      sourceUrl.pathname.endsWith(`/${reviewPlaceholderCursorMode(conflictRepo, "open")}`)
    ) {
      const attempted = JSON.parse(String(init.body));
      const competing = await signedWorkerRequest(sourceUrl.pathname, "PUT", {
        next_cursor: 0,
        expected_revision: attempted.expected_revision,
      });
      assert.equal(competing.status, 202, "the competing no-op cursor CAS must win");
      conflictInjected = true;
    }
    const response = await fetch(localUrl, init);
    if (sourceUrl.pathname.includes("/internal/state/cursors/")) {
      cursorTraffic.push({
        scenario: activeScenario,
        method,
        path: sourceUrl.pathname,
        status: response.status,
        body: await response
          .clone()
          .json()
          .catch(() => null),
      });
    }
    if (sourceUrl.pathname === "/internal/exact-review/enqueue") {
      queueAcknowledgements.push({
        scenario: activeScenario,
        status: response.status,
        body: await response
          .clone()
          .json()
          .catch(() => null),
      });
    }
    return response;
  }

  assert.equal(sourceUrl.origin, apiOrigin, `unexpected external origin: ${sourceUrl.origin}`);
  if (sourceUrl.pathname === "/search/issues") {
    const query = sourceUrl.searchParams.get("q") ?? "";
    const state = query.includes("is:closed") ? "closed" : "open";
    const numbers =
      activeScenario === "rotation"
        ? state === "closed"
          ? closedNumbers
          : openNumbers
        : state === "open"
          ? [8_001, 8_002]
          : [];
    const page = Number(sourceUrl.searchParams.get("page"));
    const pageStart = (page - 1) * 100;
    return Response.json({
      total_count: numbers.length,
      incomplete_results: false,
      items: numbers.slice(pageStart, pageStart + 100).map(candidate),
    });
  }

  const commentsMatch = sourceUrl.pathname.match(/\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/);
  if (commentsMatch) {
    const number = Number(commentsMatch[1]);
    if (activeScenario === "rotation") {
      const state = number >= 2_000 ? "closed" : "open";
      rotationChecks[runIndex][state].push(number);
      if (number === 1_001) {
        return Response.json([placeholder(number, 91_001, "2026-07-17T11:00:00.000Z")]);
      }
      if (number === 2_144 && !cleanedComments.includes(92_144)) {
        return Response.json([placeholder(number, 92_144, "2026-07-17T06:00:00.000Z")]);
      }
      return Response.json([ordinaryComment]);
    }
    conflictChecks.push(number);
    return Response.json(
      number === 8_001
        ? [placeholder(number, 98_001, "2026-07-17T06:00:00.000Z")]
        : [ordinaryComment],
    );
  }

  if (sourceUrl.pathname === "/repos/openclaw/openclaw/issues/2144") {
    return Response.json({ state: "closed", locked: false });
  }
  if (sourceUrl.pathname === "/repos/openclaw/openclaw/issues/comments/92144") {
    if (method === "DELETE") {
      cleanedComments.push(92_144);
      return new Response(null, { status: 204 });
    }
    return Response.json(placeholder(2_144, 92_144, "2026-07-17T06:00:00.000Z"));
  }
  throw new Error(`unexpected request: ${method} ${sourceUrl}`);
};

const runRecovery = async ({ repo, now, id, maximumChecks }) =>
  runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "synthetic-read-token",
      TARGET_WRITE_TOKEN: "synthetic-write-token",
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      GITHUB_API_URL: apiOrigin,
      QUEUE_URL: `https://${new URL(workerOrigin).host}`,
      REVIEW_PLACEHOLDER_CURSOR_STORE_URL: `https://${new URL(workerOrigin).host}`,
      REVIEW_PLACEHOLDER_MAX_CHECKS: String(maximumChecks),
      REVIEW_PLACEHOLDER_MAX_RECOVERIES: "5",
      REVIEW_PLACEHOLDER_MIN_AGE_HOURS: "2",
      TARGET_REPO: repo,
      GITHUB_RUN_ID: id,
    },
    fetchImpl: proofFetch,
    now,
  });

const invalidMode = reviewPlaceholderCursorMode(rotationRepo, "open");
const invalidSignatureResponse = await fetch(
  new URL(`/internal/state/cursors/${invalidMode}`, workerOrigin),
  { headers: { "x-clawsweeper-exact-review-signature": "sha256=invalid" } },
);
assert.equal(invalidSignatureResponse.status, 401);

const rotationSummaries = [];
const rotationCursors = [];
for (const [index, now] of [
  new Date("2026-07-17T12:00:00.000Z"),
  new Date("2026-07-17T12:00:00.000Z"),
  new Date("2026-07-17T12:00:00.000Z"),
  new Date("2026-07-17T14:00:00.000Z"),
].entries()) {
  runIndex = index;
  activeNow = now;
  rotationSummaries.push(
    await runRecovery({ repo: rotationRepo, now: activeNow, id: `rotation-${index + 1}`, maximumChecks: 60 }),
  );
  rotationCursors.push({
    open: await cursorSnapshot(rotationRepo, "open"),
    closed: await cursorSnapshot(rotationRepo, "closed"),
  });
}

const expectedRanges = [
  [0, 60],
  [60, 120],
  [120, 180],
  [0, 60],
];
for (const [index, range] of expectedRanges.entries()) {
  assert.deepEqual(rotationChecks[index].open, openNumbers.slice(...range));
  assert.deepEqual(rotationChecks[index].closed, closedNumbers.slice(...range));
}
assert.deepEqual(
  rotationCursors.map((snapshot) => snapshot.open.next_cursor),
  [60, 120, 0, 60],
);
assert.deepEqual(
  rotationCursors.map((snapshot) => snapshot.closed.next_cursor),
  [60, 120, 0, 60],
);
assert.equal(rotationSummaries[2].cleaned, 1);
assert.equal(rotationSummaries[3].enqueued, 1);
assert.deepEqual(cleanedComments, [92_144]);

activeScenario = "conflict";
conflictInjectionEnabled = true;
const conflictFirst = await runRecovery({
  repo: conflictRepo,
  now: activeNow,
  id: "conflict-1",
  maximumChecks: 1,
});
const cursorAfterConflict = await cursorSnapshot(conflictRepo, "open");
assert.equal(conflictInjected, true);
assert.equal(conflictFirst.errors, 1);
assert.equal(cursorAfterConflict.next_cursor, 0);
assert.equal(cursorAfterConflict.revision, 1);

conflictInjectionEnabled = false;
const conflictSecond = await runRecovery({
  repo: conflictRepo,
  now: activeNow,
  id: "conflict-2",
  maximumChecks: 1,
});
const cursorAfterRetry = await cursorSnapshot(conflictRepo, "open");
assert.equal(conflictSecond.errors, 0);
assert.deepEqual(conflictChecks, [8_001, 8_001]);
assert.equal(cursorAfterRetry.next_cursor, 1);
assert.equal(cursorAfterRetry.revision, 2);

const conflictWrites = cursorTraffic.filter(
  (request) =>
    request.scenario === "conflict" &&
    request.method === "PUT" &&
    request.path.endsWith(`/${reviewPlaceholderCursorMode(conflictRepo, "open")}`),
);
assert.deepEqual(
  conflictWrites.map((request) => request.status),
  [409, 202],
);
assert.equal(queueAcknowledgements.every((ack) => ack.status === 202), true);
assert.equal(
  queueAcknowledgements.every(
    (ack) => ack.body?.queued === true || ack.body?.deduped === true,
  ),
  true,
);

const summary = {
  schema_version: 1,
  source_sha: process.env.SOURCE_SHA || "unknown",
  source_tree_sha256: process.env.SOURCE_TREE_SHA || "unknown",
  runtime: {
    worker: "local Wrangler",
    durable_object: "persisted SQLite ExactReviewQueue",
    worker_origin: workerOrigin,
    invalid_signature_status: invalidSignatureResponse.status,
  },
  rotation: {
    window_first_numbers: rotationChecks.map((entry) => entry.open[0]),
    window_last_numbers: rotationChecks.map((entry) => entry.open.at(-1)),
    open_offsets: rotationCursors.map((snapshot) => snapshot.open.next_cursor),
    closed_offsets: rotationCursors.map((snapshot) => snapshot.closed.next_cursor),
    cleaned_comment_ids: cleanedComments,
    fourth_run_enqueued: rotationSummaries[3].enqueued,
  },
  cas_retry: {
    checked_numbers: conflictChecks,
    stale_write_status: conflictWrites[0].status,
    offset_after_conflict: cursorAfterConflict.next_cursor,
    revision_after_conflict: cursorAfterConflict.revision,
    retry_write_status: conflictWrites[1].status,
    offset_after_retry: cursorAfterRetry.next_cursor,
    revision_after_retry: cursorAfterRetry.revision,
  },
  queue_acknowledgements: queueAcknowledgements,
  result: "PASS",
};
await writeFile(path.join(outputDir, "proof-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(
  path.join(outputDir, "runtime-transcript.md"),
  [
    "# Review-placeholder cursor rotation runtime transcript",
    "",
    `- Auth boundary: invalid signature returned HTTP ${invalidSignatureResponse.status}.`,
    `- Rotation windows: ${rotationChecks.map((entry) => `${entry.open[0]}..${entry.open.at(-1)}`).join(" | ")}.`,
    `- Open cursor offsets: ${summary.rotation.open_offsets.join(" -> ")}.`,
    `- Closed cursor offsets: ${summary.rotation.closed_offsets.join(" -> ")}.`,
    `- Closed cleanup: comment ${cleanedComments[0]} at search rank 144.`,
    `- Age guard: first-window open placeholder enqueued only after wrap (${rotationSummaries[3].enqueued} enqueue).`,
    `- CAS retry: HTTP ${conflictWrites[0].status} left offset ${cursorAfterConflict.next_cursor}; next run checked ${conflictChecks.join(", ")} and persisted offset ${cursorAfterRetry.next_cursor}.`,
    `- Queue boundary: ${queueAcknowledgements.length} signed enqueue requests returned HTTP 202.`,
    "",
    "RESULT: PASS",
    "",
  ].join("\n"),
);

console.log(
  `rotation windows: ${rotationChecks.map((entry) => `${entry.open[0]}..${entry.open.at(-1)}`).join(" | ")}`,
);
console.log(`cursor offsets: ${summary.rotation.open_offsets.join(" -> ")}`);
console.log(`closed cleanup: rank 144 (comment ${cleanedComments[0]})`);
console.log(`age guard: first-window open placeholder enqueued only after wrap`);
console.log(
  `CAS retry: checked ${conflictChecks[0]} twice; offset ${cursorAfterConflict.next_cursor} after ${conflictWrites[0].status}, then ${cursorAfterRetry.next_cursor}`,
);
console.log("RESULT: PASS");
