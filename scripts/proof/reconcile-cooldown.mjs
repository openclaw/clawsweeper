#!/usr/bin/env node
// Execute workflow shell clients against a loopback service and synthetic Actions history.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "reconcile-proof-"));
const secret = "synthetic-proof-secret";
const requests = [];
const results = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (request.method === "POST") {
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    if (request.headers["x-clawsweeper-exact-review-signature"] !== signature) {
      response.writeHead(401).end();
      return;
    }
  }
  requests.push({
    path: request.url,
    method: request.method,
    body: body ? JSON.parse(body) : null,
  });
  response.setHeader("content-type", "application/json");
  if (request.url === "/internal/exact-review/claimed-runs") {
    response.end(
      JSON.stringify({ runs: [{ run_id: "123", run_attempt: 2, claim_generation: 7 }] }),
    );
  } else if (request.url === "/repos/synthetic/reviews/actions/runs/123/attempts/2") {
    response.end(
      JSON.stringify({ id: 123, run_attempt: 2, status: "completed", conclusion: "cancelled" }),
    );
  } else if (request.url === "/internal/exact-review/reconcile") {
    response.end(JSON.stringify({ reconciled: 1 }));
  } else response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const bin = join(root, "bin");
  mkdirSync(bin);
  const fixture = join(root, "history.json");
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const fixture = JSON.parse(fs.readFileSync(process.env.PROOF_HISTORY, "utf8"));
if (fixture.fail) process.exit(1);
if (process.argv[3] === "list") process.stdout.write(JSON.stringify(fixture.runs));
else if (process.argv[3] === "view") process.stdout.write(JSON.stringify({ jobs: fixture.jobs }));
else process.exit(2);
`,
    { mode: 0o755 },
  );
  const eventWorkflow = parse(
    readFileSync(".github/workflows/exact-review-reconcile-run.yml", "utf8"),
  );
  const scheduledWorkflow = parse(
    readFileSync(".github/workflows/exact-review-reconcile.yml", "utf8"),
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PROOF_HISTORY: fixture,
    GITHUB_REPOSITORY: "synthetic/reviews",
    GITHUB_RUN_ID: "99",
    GH_TOKEN: "synthetic",
    GITHUB_TOKEN: "synthetic",
    GITHUB_API_URL: endpoint,
    QUEUE_URL: endpoint,
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    SOURCE_RUN_ID: "123",
    SOURCE_RUN_ATTEMPT: "2",
  };
  for (const scenario of ["recent", "expired", "observer-only", "history-unavailable"]) {
    const time = new Date(Date.now() - (scenario === "expired" ? 360_000 : 60_000)).toISOString();
    writeFileSync(
      fixture,
      JSON.stringify({
        fail: scenario === "history-unavailable",
        runs: [{ databaseId: 42, updatedAt: time }],
        jobs: [
          {
            name:
              scenario === "observer-only"
                ? "Observe terminal review run"
                : "Reconcile leases / Reconcile terminal run",
            status: "completed",
            conclusion: "success",
            completedAt: time,
          },
        ],
      }),
    );
    const output = join(root, `${scenario}.out`);
    execFileSync(process.execPath, ["scripts/exact-review-reconcile-guard.mjs"], {
      env: { ...env, GITHUB_OUTPUT: output },
      stdio: "pipe",
    });
    const admitted = readFileSync(output, "utf8").trim() === "reconcile=true";
    assert.equal(admitted, scenario !== "recent");
    const before = requests.length;
    if (admitted)
      await run("bash", ["-e", "-c", eventWorkflow.jobs.reconcile.steps[0].run], { env });
    assert.equal(requests.length - before, admitted ? 1 : 0);
    results.push({ scenario, admitted, queueWrites: requests.length - before });
  }
  await run("bash", ["-e", "-c", scheduledWorkflow.jobs.sweep.steps[0].run], { env });
  assert.deepEqual(requests.at(-1).body.terminal_runs, [
    {
      run_id: "123",
      run_attempt: 2,
      claimed_run_attempt: 2,
      claim_generation: 7,
      outcome: "cancelled",
    },
  ]);
  mkdirSync(".artifacts", { recursive: true });
  writeFileSync(
    ".artifacts/reconcile-cooldown-proof.json",
    `${JSON.stringify(
      {
        results,
        requests,
        limits:
          "Actual guard and workflow shell clients; synthetic history and loopback API. Does not emulate GitHub concurrency scheduling or measure production latency.",
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify({
      results,
      scheduledTerminalAttempt: "123/2",
      signedRequests: requests.filter((request) => request.method === "POST").length,
    }),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
