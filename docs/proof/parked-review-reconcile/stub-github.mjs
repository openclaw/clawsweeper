#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const port = Number(process.argv[2]);
const tracePath = process.argv[3];
if (!Number.isInteger(port) || !tracePath) {
  throw new Error("usage: stub-github.mjs <port> <trace-path>");
}

await mkdir(path.dirname(tracePath), { recursive: true });
await writeFile(tracePath, "");

const issueStates = new Map([
  [114100, "open"],
  [114101, "open"],
  [114102, "open"],
]);
let rejectDispatch = true;
let dispatches = 0;

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  const body = await requestBody(request);
  await appendFile(
    tracePath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      method: request.method,
      pathname: url.pathname,
      reject_dispatch: rejectDispatch,
    })}\n`,
  );

  if (url.pathname === "/__proof/status") {
    return json(response, 200, {
      ok: true,
      reject_dispatch: rejectDispatch,
      dispatches,
      issues: Object.fromEntries(issueStates),
    });
  }
  if (url.pathname === "/__proof/control" && request.method === "POST") {
    const command = JSON.parse(body || "{}");
    if (command.reject_dispatch !== undefined) rejectDispatch = command.reject_dispatch === true;
    if (command.issue_114101_state) {
      issueStates.set(114101, String(command.issue_114101_state));
    }
    if (command.issue_114102_state) {
      issueStates.set(114102, String(command.issue_114102_state));
    }
    return json(response, 200, { ok: true });
  }
  if (/^\/repos\/openclaw\/(?:openclaw|clawsweeper)\/installation$/.test(url.pathname)) {
    return json(response, 200, { id: 999 });
  }
  if (url.pathname === "/app/installations/999/access_tokens" && request.method === "POST") {
    return json(response, 201, { token: "parked-proof-installation-token" });
  }
  if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
    return json(response, 200, { state: "active" });
  }
  const issueMatch = /^\/repos\/openclaw\/openclaw\/issues\/(11410[0-2])$/.exec(url.pathname);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    return json(response, 200, {
      node_id: `ISSUE_${number}`,
      number,
      state: issueStates.get(number),
      repository_url: "https://api.github.com/repos/openclaw/openclaw",
    });
  }
  if (url.pathname === "/repos/openclaw/clawsweeper/dispatches" && request.method === "POST") {
    dispatches += 1;
    if (!rejectDispatch) {
      response.writeHead(204);
      response.end();
      return;
    }
    return json(response, 422, {
      message: "Validation Failed",
      errors: [{ resource: "RepositoryDispatch", field: "client_payload", code: "invalid" }],
    });
  }
  return json(response, 404, { message: "Not Found" });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`stub-ready port=${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}
