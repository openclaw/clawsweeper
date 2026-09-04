import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "yaml";
import {
  recentReconciliation,
  main,
  HISTORY_READ_DEADLINE_MS,
  RECONCILE_COOLDOWN_MS,
} from "../../scripts/exact-review-reconcile-guard.mjs";

const now = Date.parse("2026-09-04T01:00:00Z");
const updatedAt = new Date(now - 60_000).toISOString();
const runs = [{ databaseId: 42, updatedAt }];
const job = {
  name: "Reconcile leases / Reconcile terminal run",
  status: "completed",
  conclusion: "success",
  completedAt: updatedAt,
};

test("event reconciliation coalesces the complete reusable job while preserving observations", () => {
  const workflow = parse(readFileSync(".github/workflows/exact-review-reconcile.yml", "utf8"));
  const child = parse(readFileSync(".github/workflows/exact-review-reconcile-run.yml", "utf8"));
  assert.deepEqual(workflow.jobs.reconcile.concurrency, {
    group: "exact-review-reconcile-workflow-run",
    "cancel-in-progress": false,
  });
  assert.equal(workflow.jobs.reconcile.uses, "./.github/workflows/exact-review-reconcile-run.yml");
  assert.match(workflow.jobs.reconcile.if, /github.event_name == 'workflow_run'/);
  assert.equal(child.jobs.reconcile.needs, "cooldown");
  assert.equal(child.jobs.reconcile.if, "${{ needs.cooldown.outputs.reconcile == 'true' }}");
  assert.equal(child.jobs.cooldown.outputs.reconcile, "${{ steps.history.outputs.reconcile }}");
  assert.equal(child.jobs.cooldown.steps[1].run, "node scripts/exact-review-reconcile-guard.mjs");
  assert.deepEqual(workflow.on.schedule, [{ cron: "*/15 * * * *" }]);
  assert.equal(workflow.jobs.sweep.needs, undefined);
  assert.equal(workflow.jobs.sweep.concurrency.group, "exact-review-reconcile-sweep");
  assert.equal(workflow.jobs.observe.needs, undefined);
  assert.match(workflow.jobs.observe.concurrency.group, /workflow_run.id/);
  assert.ok(
    workflow.jobs.observe.steps.some((step: any) =>
      String(step.run).includes("review-run-observer.mjs"),
    ),
  );
});

test("cooldown requires a real successful reconciliation within five minutes", () => {
  assert.equal(RECONCILE_COOLDOWN_MS, 300_000);
  assert.equal(
    recentReconciliation(runs, () => [job], { now }),
    "42",
  );
  assert.equal(
    recentReconciliation(runs, () => [{ ...job, name: "Sweep terminal exact-review runs" }], {
      now,
    }),
    "42",
  );
  for (const changed of [
    { conclusion: "skipped" },
    { conclusion: "failure" },
    { status: "in_progress" },
    { name: "Check recent lease reconciliation" },
    { name: "Observe terminal review run" },
    { completedAt: new Date(now - 300_000).toISOString() },
    { completedAt: "invalid" },
    { completedAt: new Date(now + 1).toISOString() },
  ])
    assert.equal(
      recentReconciliation(runs, () => [{ ...job, ...changed }], { now }),
      null,
    );
});

test("observer-only runs do not hide older successful repairs or extend their completion time", () => {
  const candidates = [{ databaseId: 99, updatedAt }, ...runs];
  assert.equal(
    recentReconciliation(candidates, (id: string) => (id === "99" ? [] : [job]), { now }),
    "42",
  );
  let lookups = 0;
  assert.equal(
    recentReconciliation(
      runs,
      () => {
        lookups++;
        return [job];
      },
      { now, currentRunId: "42" },
    ),
    null,
  );
  for (const timestamp of [
    "invalid",
    new Date(now - 300_000).toISOString(),
    new Date(now + 1).toISOString(),
  ]) {
    assert.equal(
      recentReconciliation(
        [{ databaseId: 42, updatedAt: timestamp }],
        () => {
          lookups++;
          return [job];
        },
        { now },
      ),
      null,
    );
  }
  assert.equal(lookups, 0);
});

test("guard CLI and workflow clients preserve cooldown and the scheduled terminal backstop", async () => {
  const run = promisify(execFile);
  const root = mkdtempSync(join(tmpdir(), "reconcile-proof-"));
  const secret = "synthetic-proof-secret";
  const requests: Array<{ path: string | undefined; method: string | undefined; body: any }> = [];
  const results: Array<{ scenario: string; admitted: boolean; queueWrites: number }> = [];
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
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
    assert.deepEqual(requests.at(-1)!.body.terminal_runs, [
      {
        run_id: "123",
        run_attempt: 2,
        claimed_run_attempt: 2,
        claim_generation: 7,
        outcome: "cancelled",
      },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard main fails open on the aggregate deadline and both API error paths", () => {
  assert.equal(HISTORY_READ_DEADLINE_MS, 60_000);
  for (const scenario of ["deadline", "list-error", "jobs-error", "fresh", "aged-during-read"]) {
    const root = mkdtempSync(join(tmpdir(), "reconcile-deadline-"));
    const output = join(root, "output");
    let elapsed = 0;
    let calls = 0;
    const timeouts: number[] = [];
    try {
      main({
        env: { GITHUB_REPOSITORY: "synthetic/reviews", GITHUB_OUTPUT: output },
        clock: () => elapsed,
        now: () => now + elapsed,
        exec: ((_command: string, args: string[], options: { timeout: number }) => {
          calls++;
          timeouts.push(options.timeout);
          if (scenario === "list-error" || (scenario === "jobs-error" && args[1] === "view"))
            throw new Error("API unavailable");
          elapsed += scenario === "deadline" ? 7_000 : scenario === "aged-during-read" ? 10_000 : 1;
          return JSON.stringify(
            args[1] === "list"
              ? Array.from({ length: 30 }, (_, index) => ({ databaseId: index + 1, updatedAt }))
              : {
                  jobs:
                    scenario === "deadline"
                      ? []
                      : [
                          {
                            ...job,
                            completedAt:
                              scenario === "aged-during-read"
                                ? new Date(now - 290_000).toISOString()
                                : updatedAt,
                          },
                        ],
                },
          );
        }) as typeof execFileSync,
      });
      assert.equal(readFileSync(output, "utf8"), `reconcile=${scenario !== "fresh"}\n`, scenario);
      if (scenario === "deadline") {
        assert.equal(calls, 9);
        assert.equal(timeouts.at(-1), 4_000);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("audit coverage refreshes inventory tokens after dispatching the waves", () => {
  const workflow = parse(readFileSync(".github/workflows/sweep.yml", "utf8"));
  const steps = workflow.jobs["target-fanout"].steps;
  const dispatch = steps.findIndex((step: any) => step.name === "Dispatch selected targets");
  const coverage = steps.findIndex(
    (step: any) => step.name === "Summarize trailing weekly review coverage",
  );
  for (const owner of ["openclaw", "steipete"]) {
    const refresh = steps.findIndex((step: any) => step.id === `${owner}-coverage-token`);
    assert.ok(refresh > dispatch && refresh < coverage);
    assert.equal(
      steps[refresh].uses,
      steps.find((step: any) => step.id === `${owner}-inventory-token`).uses,
    );
    assert.equal(steps[refresh].with.owner, owner);
    assert.equal(steps[refresh].with["permission-metadata"], "read");
    assert.equal(
      steps[coverage].env[`CLAWSWEEPER_INVENTORY_TOKEN_${owner.toUpperCase()}`],
      `\${{ steps.${owner}-coverage-token.outputs.token || '__public__' }}`,
    );
  }
});
