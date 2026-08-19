#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const mode = process.argv[2];
const port = Number(process.argv[3]);
const tracePath = process.argv[4];
if (!new Set(["zombie-only", "fresh-backlog"]).has(mode) || !Number.isInteger(port)) {
  throw new Error("usage: stub-github.mjs <zombie-only|fresh-backlog> <port> <trace-path>");
}

await mkdir(path.dirname(tracePath), { recursive: true });

const now = Date.now();
const workflowRuns = [workflowRun(7001, "queued", now - 25 * 60 * 60 * 1000)];
if (mode === "fresh-backlog") {
  workflowRuns.push(workflowRun(7002, "queued", now - 31 * 60 * 1000));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  await appendFile(
    tracePath,
    `${JSON.stringify({ at: new Date().toISOString(), method: request.method, url: url.href })}\n`,
  );

  let payload;
  if (/\/repos\/openclaw\/clawsweeper\/actions\/runs$/.test(url.pathname)) {
    const status = url.searchParams.get("status");
    payload = {
      total_count: status === "queued" || status === null ? workflowRuns.length : 0,
      workflow_runs: status === "queued" || status === null ? workflowRuns : [],
    };
  } else if (/\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
    payload = { total_count: 0, jobs: [] };
  } else if (/\/actions\/workflows\/[^/]+\/runs$/.test(url.pathname)) {
    payload = { total_count: 0, workflow_runs: [] };
  } else if (/\/actions\/workflows$/.test(url.pathname)) {
    payload = { total_count: 0, workflows: [] };
  } else if (/\/commits\/[^/]+\/check-runs$/.test(url.pathname)) {
    payload = { total_count: 0, check_runs: [] };
  } else if (/\/(issues|pulls)$/.test(url.pathname)) {
    payload = [];
  } else if (url.pathname === "/rate_limit") {
    payload = {
      resources: { core: { limit: 5_000, remaining: 5_000, reset: Math.floor(now / 1000) + 3600 } },
    };
  } else {
    payload = {};
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`stub-ready mode=${mode} port=${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function workflowRun(id, status, createdAtMs) {
  return {
    id,
    name: "ClawSweeper",
    display_title: `proof run ${id}`,
    status,
    conclusion: null,
    event: "workflow_dispatch",
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: new Date(createdAtMs).toISOString(),
    updated_at: new Date(createdAtMs).toISOString(),
  };
}
