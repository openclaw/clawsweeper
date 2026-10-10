import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { renderAutomergeJob } from "../../dist/repair/comment-router/dispatch.js";
import { readText } from "../helpers.ts";

type WorkflowStep = { name?: string; id?: string; uses?: string; if?: string; run?: string };
type Workflow = {
  jobs: Record<string, { permissions?: Record<string, string>; steps: WorkflowStep[] }>;
};

test("direct repair requeues forward one stable dispatch key and record it after dispatch", (t) => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-requeue-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "runtime");
  fs.cpSync("dist", path.join(root, "dist"), { recursive: true });
  fs.cpSync("config", path.join(root, "config"), { recursive: true });
  const jobPath = "jobs/openclaw/inbox/automerge-openclaw-openclaw-42.md";
  fs.mkdirSync(path.dirname(path.join(root, jobPath)), { recursive: true });
  fs.writeFileSync(
    path.join(root, jobPath),
    renderAutomergeJob({ repo: "openclaw/openclaw", issueNumber: 42 }),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
  );
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const head = git("rev-parse", "HEAD");

  // GitHub: no active workers, record each dispatch, and list the dispatched run as started.
  const bin = path.join(temporary, "bin");
  const dispatches = path.join(temporary, "dispatches.jsonl");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "api") process.stdout.write("[]");
else if (args[0] === "workflow") fs.appendFileSync(${JSON.stringify(dispatches)}, JSON.stringify(args) + "\\n");
else if (args[0] === "run") process.stdout.write(JSON.stringify([{ databaseId: 7, workflowName: "repair cluster worker", headSha: ${JSON.stringify(head)}, status: "in_progress", createdAt: new Date().toISOString(), url: "https://example.invalid/7" }]));
else process.exit(1);
`,
    { mode: 0o755 },
  );

  const requeue = (invocation: string) => {
    const outputRoot = path.join(temporary, invocation);
    fs.mkdirSync(outputRoot);
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "dist/repair/requeue-job.js"),
        jobPath,
        "--repo",
        "openclaw/clawsweeper",
        "--mode",
        "plan",
        "--execute",
        "--source-job-path",
        jobPath,
        "--requeue-depth",
        "0",
        "--max-requeue-depth",
        "1",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          HOME: temporary,
          CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
          CLAWSWEEPER_ACTION_LEDGER_ROOT: outputRoot,
          CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
          CLAWSWEEPER_ACTION_LEDGER_INVOCATION: invocation,
          GITHUB_REPOSITORY: "openclaw/clawsweeper",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_WORKFLOW: "repair cluster worker",
          GITHUB_WORKFLOW_REF: "",
          GITHUB_JOB: "execute",
          GITHUB_RUN_ID: "42",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_ACTION: "requeue",
          GITHUB_RUN_STARTED_AT: "2026-09-05T00:00:00Z",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return {
      dispatchKey: String(JSON.parse(result.stdout).dispatch_key),
      events: readLedgerEvents(outputRoot).map((event) => [
        event.event_type,
        event.action.status,
        event.operation_id,
      ]),
    };
  };

  const first = requeue("first");
  const second = requeue("second");
  const key = first.dispatchKey;
  assert.equal(second.dispatchKey, key);
  const dispatched = fs.readFileSync(dispatches, "utf8").trim().split("\n");
  assert.equal(dispatched.length, 2);
  for (const line of dispatched) {
    const args = JSON.parse(line) as string[];
    assert.ok(args.includes(`dispatch_key=${key}`), line);
    assert.ok(args.includes("requeue_depth=1"), line);
    assert.ok(args.includes(`job=${jobPath}`), line);
  }
  // Both runs record the same operation after the dispatch was accepted.
  const operation = first.events[0]?.[2];
  assert.match(String(operation), /\S/);
  for (const run of [first, second]) {
    assert.deepEqual(run.events, [
      ["command.mutation", "started", operation],
      ["command.mutation", "executed", operation],
      ["command.requeue", "requeued", operation],
    ]);
  }
});

test("repair requeue receipts are finalized and published only after a requeue request", (t) => {
  const workflow = parseYaml(readText(".github/workflows/repair-cluster-worker.yml")) as Workflow;
  const job = workflow.jobs.execute!;
  assert.equal(job.permissions?.actions, "read");
  const index = (name: string) =>
    job.steps.findIndex((step) => step.name === name || step.id === name);
  const order = [
    "Execute credited fix artifact",
    "repair-requeue-ledger",
    "Requeue source-head repair races",
    "Finalize repair requeue action ledger",
    "Publish immutable repair requeue action ledger",
  ].map(index);
  assert.ok(order[0]! >= 0);
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  );
  const [, , requeue, finalize, publish] = order.map((position) => job.steps[position]!);
  const requested =
    "steps.repair-requeue-ledger.outcome == 'success' && steps.repair_requeue.outputs.count != '' && steps.repair_requeue.outputs.count != '0'";
  assert.equal(
    finalize!.if,
    `\${{ always() && steps.execute-setup-pnpm.outcome == 'success' && ${requested} }}`,
  );
  assert.equal(publish!.if, finalize!.if);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-requeue-ledger-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Run a step with recording pnpm and node stubs; return the exit status and the recorded calls.
  const runStep = (run: string, env: Record<string, string>, importResult = "") => {
    const calls = path.join(directory, "calls.log");
    fs.rmSync(calls, { force: true });
    const result = spawnSync(
      "bash",
      [
        "-c",
        `pnpm() {
  printf 'pnpm %s\\n' "$*" >> "$CALLS"
  case "$*" in *finalize*) printf '{"event_paths":["a.json"]}' ;; *publish*) printf '%s' "$IMPORT_RESULT" ;; esac
}
node() { printf 'node %s\\n' "$*" >> "$CALLS"; }
${run}`,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: { PATH: process.env.PATH, CALLS: calls, IMPORT_RESULT: importResult, ...env },
      },
    );
    return {
      status: result.status,
      stderr: result.stderr,
      calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [],
    };
  };

  const requeued = runStep(requeue!.run!, {
    CLUSTER_JOB_PATH: "jobs/openclaw/inbox/a.md",
    CLUSTER_REQUEUE_DEPTH: "0",
    CLUSTER_WORKER_MODE: "execute",
    CLUSTER_WORKER_RUNNER: "runner",
    CLUSTER_EXECUTION_RUNNER: "execution-runner",
    CLUSTER_WORKER_MODEL: "model",
    REQUEUE_COUNT: "1",
  });
  assert.equal(requeued.status, 0, requeued.stderr);
  assert.match(
    requeued.calls[0]!,
    /repair:requeue -- jobs\/openclaw\/inbox\/a\.md .*--source-job-path jobs\/openclaw\/inbox\/a\.md --requeue-depth 0 --max-requeue-depth 1 /,
  );

  assert.notEqual(runStep(finalize!.run!, {}).status, 0);
  const finalized = runStep(finalize!.run!, { CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: directory });
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.deepEqual(finalized.calls, [
    "pnpm run --silent repair:action-ledger -- finalize --lane repair-requeue",
  ]);

  const ledgerEnv = { CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: directory };
  const published = runStep(
    publish!.run!,
    ledgerEnv,
    JSON.stringify({ eventPaths: ["a.json"], paths: ["ledger/a.json"] }),
  );
  assert.equal(published.status, 0, published.stderr);
  assert.match(
    published.calls[0]!,
    /^pnpm run --silent repair:action-ledger -- publish --lane repair-requeue /,
  );
  assert.match(published.calls[1]!, /^node dist\/clawsweeper\.js publish-action-event-paths /);
  for (const importResult of [
    { eventPaths: ["other.json"], paths: ["ledger/a.json"] },
    { eventPaths: ["a.json"], paths: [] },
  ]) {
    const refused = runStep(publish!.run!, ledgerEnv, JSON.stringify(importResult));
    assert.notEqual(refused.status, 0, JSON.stringify(importResult));
    assert.equal(refused.calls.length, 1, JSON.stringify(importResult));
  }
});

function readLedgerEvents(root: string): Record<string, any>[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .flatMap((entry) =>
      fs
        .readFileSync(path.join(entry.parentPath, entry.name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    )
    .sort((left, right) => left.phase_seq - right.phase_seq);
}

test("exact review publisher bypasses the legacy action ledger and finalizes through the fenced acknowledgement", () => {
  const workflow = parseYaml(readText(".github/workflows/sweep.yml")) as Workflow;
  const publisher = workflow.jobs["event-review-publish"]!.steps.map((step) => step.name);
  assert.ok(!publisher.includes("Mark re-review complete"));
  assert.ok(!publisher.includes("Publish exact review action ledger"));
  const finalizer = workflow.jobs["event-review-terminal-finalization"]!.steps;
  const acknowledgement = finalizer.findIndex(
    (step) => step.name === "Begin fenced terminal acknowledgement",
  );
  const statusMutation = finalizer.findIndex(
    (step) => step.name === "Update final command status once",
  );
  assert.ok(acknowledgement >= 0);
  assert.ok(statusMutation > acknowledgement);
  assert.equal(
    finalizer[statusMutation]!.if,
    "${{ steps.terminal-acknowledgement.outputs.allowed == 'true' && steps.target-write-token.outcome == 'success' }}",
  );
});
