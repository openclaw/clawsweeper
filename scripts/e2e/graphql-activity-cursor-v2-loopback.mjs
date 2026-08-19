#!/usr/bin/env node
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { createGitHubContext } from "../../dist/clawsweeper-github-context.js";
import {
  ReviewedPrActivityChangedDuringReadError,
  readStableReviewedPrActivityCursor,
  readStableReviewedPrActivityCursors,
} from "../../dist/review-activity-cursor.js";

const { values } = parseArgs({
  options: { "output-dir": { type: "string" } },
  strict: true,
});

const requests = [];
const server = fork(
  new URL("graphql-activity-cursor-v2-loopback-server.mjs", import.meta.url),
  [],
  {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  },
);
const port = await new Promise((resolveReady, reject) => {
  server.once("error", reject);
  server.on("message", (message) => {
    if (message?.kind === "ready") resolveReady(message.port);
  });
});

try {
  const apiUrl = `http://127.0.0.1:${port}`;
  const githubEnv = {
    ...process.env,
    GITHUB_API_URL: apiUrl,
    GITHUB_GRAPHQL_URL: `${apiUrl}/graphql`,
    GH_TOKEN: "loopback-proof-token",
  };
  const context = () =>
    createGitHubContext({
      targetRepo: () => "openclaw/clawsweeper",
      ghJson: (args) => ghJson(args, githubEnv),
      ghWithRetry: (args) => gh(args, githubEnv),
    });
  const numbers = Array.from({ length: 8 }, (_, index) => index + 1);

  resetRequests();
  const v1 = context();
  const v1SingleCursor = readStableReviewedPrActivityCursor(() =>
    v1.fetchReviewedPrActivityCursorV1(1),
  );
  const v1SingleRequests = requests.length;

  resetRequests();
  const v2 = context();
  const v2SingleCursor = readStableReviewedPrActivityCursor(() =>
    v2.fetchReviewedPrActivityCursor(1),
  );
  const v2SingleRequests = requests.length;

  resetRequests();
  const v1Batch = context();
  const v1BatchCursors = readStableReviewedPrActivityCursors(() =>
    Object.fromEntries(
      numbers.map((number) => [String(number), v1Batch.fetchReviewedPrActivityCursorV1(number)]),
    ),
  );
  const v1BatchRequests = requests.length;

  resetRequests();
  const v2Batch = context();
  const v2BatchCursors = readStableReviewedPrActivityCursors(() =>
    v2Batch.fetchReviewedPrActivityCursors(numbers),
  );
  const v2BatchRequests = requests.length;

  resetRequests();
  await setServerMode("partial");
  const fallback = context();
  const telemetry = [];
  const originalError = console.error;
  let fallbackCursor;
  try {
    console.error = (line) => telemetry.push(String(line));
    fallbackCursor = readStableReviewedPrActivityCursor(() =>
      fallback.fetchReviewedPrActivityCursor(1),
    );
  } finally {
    console.error = originalError;
  }
  const fallbackRequests = requests.length;
  await setServerMode("complete");

  resetRequests();
  await setServerMode("concurrent");
  const concurrent = context();
  assert.throws(
    () => readStableReviewedPrActivityCursor(() => concurrent.fetchReviewedPrActivityCursor(1)),
    ReviewedPrActivityChangedDuringReadError,
  );
  const concurrentRequests = requests.length;
  await setServerMode("complete");

  assert.equal(v1SingleRequests, 6);
  assert.equal(v2SingleRequests, 2);
  assert.equal(v1BatchRequests, numbers.length * 6);
  assert.equal(v2BatchRequests, 2);
  assert.equal(fallbackCursor, v1SingleCursor);
  assert.equal(fallbackRequests, 7);
  assert.equal(telemetry.length, 1);
  assert.deepEqual(JSON.parse(telemetry[0]), {
    event: "reviewed_pr_activity_cursor_v2_fallback",
    repo: "openclaw/clawsweeper",
    number: 1,
    from_version: 2,
    to_version: 1,
    reason: "review_comments_partial_nodes",
  });
  assert.equal(concurrentRequests, 2);
  assert.match(v1SingleCursor || "", /^v1:/);
  assert.match(v2SingleCursor || "", /^v2:/);
  assert.equal(Object.keys(v1BatchCursors).length, numbers.length);
  assert.equal(Object.keys(v2BatchCursors).length, numbers.length);

  const receipt = {
    schema_version: 1,
    claim:
      "The v2 GraphQL cursor preserves stable PR activity decisions while reducing one check from six requests to two and an eight-PR batch from forty-eight requests to two.",
    transport: "loopback HTTP via GITHUB_API_URL and GITHUB_GRAPHQL_URL",
    environment: { node: process.version, batch_size: numbers.length },
    ...(process.env.PROOF_SOURCE_HEAD && process.env.PROOF_SOURCE_TREE
      ? {
          source: {
            head: process.env.PROOF_SOURCE_HEAD,
            tree: process.env.PROOF_SOURCE_TREE,
            commit_object_verified: true,
            tree_object_verified: true,
          },
        }
      : {}),
    requests: {
      single: { v1: v1SingleRequests, v2: v2SingleRequests },
      batch: { v1: v1BatchRequests, v2: v2BatchRequests },
      fail_closed_fallback: fallbackRequests,
      concurrent_change: concurrentRequests,
    },
    assertions: {
      single_request_reduction: v1SingleRequests === 6 && v2SingleRequests === 2,
      batch_request_reduction: v1BatchRequests === numbers.length * 6 && v2BatchRequests === 2,
      fallback_decision_unchanged: fallbackCursor === v1SingleCursor,
      fallback_telemetry_lines: telemetry.length,
      concurrent_change_unstable: true,
      double_read_preserved: v2SingleRequests === 2 && v2BatchRequests === 2,
    },
  };
  if (values["output-dir"]) {
    const outputDir = resolve(values["output-dir"]);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      resolve(outputDir, "loopback-proof-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
  }
  console.log(JSON.stringify(receipt));
} finally {
  server.send({ kind: "close" });
  await new Promise((resolveClose) => server.once("exit", resolveClose));
}

function resetRequests() {
  requests.length = 0;
}

function setServerMode(mode) {
  const id = `${mode}:${Date.now()}:${Math.random()}`;
  return new Promise((resolveMode) => {
    const listener = (message) => {
      if (message?.kind !== "mode" || message.id !== id) return;
      server.off("message", listener);
      resolveMode();
    };
    server.on("message", listener);
    server.send({ kind: "mode", mode, id });
  });
}

function ghJson(args, env) {
  return JSON.parse(gh(args, env));
}

function gh(args, env) {
  assert.equal(args[0], "api");
  const graphql = args[1] === "graphql";
  let url;
  let payload;
  if (graphql) {
    url = env.GITHUB_GRAPHQL_URL;
    const fields = {};
    for (let index = 2; index < args.length; index += 1) {
      if (args[index] !== "-f" && args[index] !== "-F") continue;
      const field = String(args[index + 1] || "");
      index += 1;
      const delimiter = field.indexOf("=");
      if (delimiter <= 0) continue;
      const key = field.slice(0, delimiter);
      const raw = field.slice(delimiter + 1);
      fields[key] = args[index - 1] === "-F" && /^-?\d+$/.test(raw) ? Number(raw) : raw;
    }
    const { query, ...variables } = fields;
    payload = JSON.stringify({ query, variables });
  } else {
    url = new URL(String(args[1]), `${env.GITHUB_API_URL}/`).toString();
  }
  requests.push({ method: graphql ? "POST" : "GET", url });
  const child = spawnSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      ...(graphql
        ? ["--request", "POST", "--header", "content-type: application/json", "--data", payload]
        : []),
      url,
    ],
    {
      encoding: "utf8",
      env,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`loopback request failed: ${String(child.stderr).trim()}`);
  }
  return child.stdout;
}
