#!/usr/bin/env node
// Controlled workflow execution only: every gh/curl call is intercepted locally.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  createExactReviewAdmissionHarness,
  ExactReviewQueue,
  jsonResponse,
  MemoryDurableStorage,
} from "../../test/dashboard-worker-harness.ts";
import { exactReviewDecisionFrom } from "../../dashboard/exact-review-decision.ts";
import { isExplicitReviewDispatch } from "../../dist/clawsweeper-review-preparation.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type Step = { name?: string; id?: string; run?: string; uses?: string; if?: string };
type Envelope = { delivery_id: string; decision: Record<string, unknown> };

export async function proveApplyDriftRefresh() {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-drift-refresh-"));
  const bin = path.join(artifacts, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(sourceRoot, "scripts"), path.join(artifacts, "scripts"));
  const workflow = YAML.parse(
    fs.readFileSync(path.join(sourceRoot, ".github/workflows/sweep.yml"), "utf8"),
  );
  const step = (job: string, name: string): Step => {
    const found = workflow.jobs[job].steps.find((entry: Step) => entry.name === name);
    assert.ok(found?.run, `${job}: ${name}`);
    return found;
  };
  const producer = step("apply-existing", "Requeue drift-blocked close reviews");
  const intake = step(
    "legacy-event-queue-intake",
    "Enqueue legacy event through the durable control plane",
  );
  const liveCheck = step("event-review-apply", "Check live target item state");
  const report = fs.readFileSync(
    path.join(sourceRoot, "test/fixtures/apply-drift-refresh-report.json"),
    "utf8",
  );
  fs.writeFileSync(path.join(artifacts, "apply-report.json"), report);
  const selected = [43367, 128515, 119583, 121477, 77508];
  assert.equal(
    JSON.parse(report).filter(
      (row: { action: string }) => row.action === "skipped_changed_since_review",
    ).length,
    15,
  );
  const requests = path.join(artifacts, "transport.jsonl");
  const dispatches = path.join(artifacts, "dispatches.jsonl");
  const enqueue = path.join(artifacts, "enqueue.jsonl");
  const proxy = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHmac} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE, JSON.stringify({tool,args: tool === 'curl' ? ['POST',args.at(-1)] : args})+'\\n');
if (tool === 'pnpm') {
  assert.deepEqual(args.slice(0,6), ['run','--silent','workflow','--','apply-requeue-review-item-numbers','--report']);
  const result = spawnSync(process.execPath, [process.env.WORKFLOW_UTILS,...args.slice(4)], {encoding:'utf8',env:process.env});
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
}
if (tool === 'curl') {
  assert.equal(args.at(-1), 'http://queue.invalid/internal/exact-review/enqueue');
  if (process.env.FAIL_INTAKE === 'true') { process.stderr.write('controlled queue HTTP 500\\n'); process.exit(22); }
  const body = args[args.indexOf('--data')+1];
  assert.ok(args.includes('x-clawsweeper-exact-review-signature: sha256='+createHmac('sha256',process.env.CLAWSWEEPER_WEBHOOK_SECRET).update(body).digest('hex')));
  fs.appendFileSync(process.env.ENQUEUE, body+'\\n'); process.stdout.write('{"ok":true,"queued":true}'); process.exit(0);
}
assert.equal(tool, 'gh'); assert.equal(args[0], 'api');
const endpoint = args.find(arg => arg.startsWith('repos/'));
if (args.includes('POST')) {
  assert.equal(endpoint, 'repos/openclaw/clawsweeper/dispatches');
  assert.ok(args.includes('--input'));
  if (process.env.FAIL_DISPATCH === 'true') { process.stderr.write('controlled dispatch HTTP 500\\n'); process.exit(1); }
  fs.appendFileSync(process.env.DISPATCHES, JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')))+'\\n'); process.exit(0);
}
if (endpoint === 'repos/openclaw/openclaw') {
  process.stdout.write(args.includes('--jq') ? 'release/proof-branch' : '{"default_branch":"release/proof-branch"}'); process.exit(0);
}
if (/^repos\\/openclaw\\/openclaw\\/issues\\/\\d+\\/comments/.test(endpoint)) { process.stdout.write('[[]]'); process.exit(0); }
if (/^repos\\/openclaw\\/openclaw\\/pulls\\/\\d+$/.test(endpoint)) { process.stdout.write('b'.repeat(40)); process.exit(0); }
assert.match(endpoint, /^repos\\/openclaw\\/openclaw\\/issues\\/\\d+$/);
if (process.env.LIVE_STATE === 'missing') { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
const number = Number(endpoint.split('/').at(-1));
// Synthetic kinds: the recorded apply report does not establish issue/PR kind.
const pr = [128515,121477].includes(number);
process.stdout.write(args.includes('--jq') ? (pr ? 'pull_request' : 'issue') : JSON.stringify({number,state:process.env.LIVE_STATE || 'open',locked:false,...(pr ? {pull_request:{}} : {})}));
`;
  for (const tool of ["gh", "curl", "pnpm"])
    fs.writeFileSync(path.join(bin, tool), proxy, { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TRACE: requests,
    DISPATCHES: dispatches,
    ENQUEUE: enqueue,
    WORKFLOW_UTILS: path.join(sourceRoot, "dist/repair/workflow-utils.js"),
    APPLY_TARGET_REPO: "openclaw/openclaw",
    APPLY_AUTO_SELECTED_BATCH: "true",
    DISPATCH_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ID: "fixture",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_OUTPUT: path.join(artifacts, "live-output.txt"),
    QUEUE_URL: "http://queue.invalid",
    CLAWSWEEPER_WEBHOOK_SECRET: "public-proof-fixture-only",
    GH_TOKEN: "public-proof-fixture-only",
  };
  let sequence = 0;
  function run(script: string, overrides: Record<string, string> = {}) {
    assert.doesNotMatch(script, /\$\{\{/);
    const result = spawnSync("bash", ["-c", script], {
      cwd: artifacts,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    fs.writeFileSync(
      path.join(artifacts, `step-${++sequence}.log`),
      `${result.stdout}\n${result.stderr}`,
    );
    return result;
  }
  function success(script: string, overrides: Record<string, string> = {}) {
    const result = run(script, overrides);
    assert.equal(result.status, 0, result.stderr);
    return result;
  }
  const rows = (file: string) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  success(producer.run!);
  const events = rows(dispatches);
  assert.deepEqual(
    events.map((event) => Number(event.client_payload.item_number)),
    selected,
  );
  assert.equal(
    rows(requests).filter((row) => row.tool === "gh" && !row.args.includes("POST")).length,
    6,
  );
  assert.ok(workflow.on.repository_dispatch.types.includes("clawsweeper_item"));
  // Evaluate the routing predicates themselves, with all unrelated schedule guards false.
  function route(expression: string, action: string) {
    const github = {
      event_name: "repository_dispatch",
      event: { action, client_payload: { target_repo: "openclaw/openclaw", queue_lease_id: "" } },
    };
    return Function(
      "github",
      "vars",
      "needs",
      "always",
      `return (${expression
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replaceAll("needs.hosted-target-admission", 'needs["hosted-target-admission"]')});`,
    )(github, {}, { "hosted-target-admission": { outputs: { outcome: "public" } } }, () => true);
  }
  for (const event of events) {
    assert.equal(event.event_type, "clawsweeper_item");
    assert.equal(route(workflow.jobs.plan.if, event.event_type), false);
    assert.equal(route(workflow.jobs["legacy-event-queue-intake"].if, event.event_type), true);
    assert.equal(route(workflow.jobs["event-review-apply"].if, event.event_type), false);
    success(intake.run!, {
      CLIENT_PAYLOAD: JSON.stringify(event.client_payload),
      GITHUB_RUN_ID: String(event.client_payload.item_number),
    });
  }
  assert.equal(route(workflow.jobs.plan.if, "clawsweeper_target_sweep"), true);
  assert.ok(
    workflow.jobs.plan.steps.some((entry: Step) =>
      entry.uses?.endsWith("/.github/actions/setup-state"),
    ),
  );
  assert.ok(workflow.jobs["legacy-event-queue-intake"].steps.every((entry: Step) => !entry.uses));
  const envelopes: Envelope[] = rows(enqueue);
  assert.equal(envelopes.length, 5);
  for (const [index, envelope] of envelopes.entries()) {
    const decision = exactReviewDecisionFrom(envelope.decision);
    assert.ok(decision);
    assert.equal(decision.targetRepo, "openclaw/openclaw");
    assert.equal(decision.targetBranch, "release/proof-branch");
    assert.equal(decision.itemNumber, selected[index]);
    assert.equal(decision.itemKind, events[index].client_payload.item_kind);
    assert.equal(
      decision.sourceEvent,
      decision.itemKind === "pull_request" ? "pull_request" : "issues",
    );
    assert.equal(decision.sourceAction, "source_drift_requeue");
    assert.equal(decision.supersedesInProgress, false);
    assert.equal(decision.codexTimeoutMs, 1_200_000);
    for (const field of [
      "sourceHeadSha",
      "sourceUpdatedAt",
      "sourceAuthoritySeq",
      "commandStatusMarker",
      "statusCommentId",
      "force",
    ])
      assert.equal(Object.hasOwn(decision, field), false);
    assert.equal(
      isExplicitReviewDispatch({ review_source_action: decision.sourceAction }, true),
      true,
    );
    assert.equal(Object.hasOwn(events[index].client_payload, "queue_lease_id"), false);
  }

  // Execute the real queue on its existing SQLite-backed local test storage.
  const harness = createExactReviewAdmissionHarness(
    (_repo, number) => {
      if (number === 119583) return jsonResponse({ state: "closed" });
      if (number === 121477) return new Response(null, { status: 404 });
      return jsonResponse({ state: "open", head: { sha: "b".repeat(40) } });
    },
    { maxConcurrent: "5" },
  );
  const queueResults: unknown[] = [];
  const offer = async (envelope: Envelope) => {
    const response = await harness.queue.fetch(
      new Request("https://queue.invalid/enqueue", {
        method: "POST",
        body: JSON.stringify(envelope),
      }),
    );
    assert.equal(response.status, 202);
    const result = (await response.json()) as { queued?: boolean; deduped?: boolean };
    queueResults.push(result);
    return result;
  };
  try {
    for (const envelope of envelopes) assert.equal((await offer(envelope)).queued, true);
    assert.equal((await offer(envelopes[0]!)).deduped, true);
    const before = JSON.stringify(await harness.storage.get("exact-review-queue"));
    await offer({ ...envelopes[0]!, delivery_id: "another-refresh" });
    const after = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.deepEqual(after.items, JSON.parse(before).items);
    await harness.queue.alarm();
    const queuedNumbers = harness.dispatched.map((event) =>
      Number((event.client_payload as Record<string, unknown>).item_number),
    );
    assert.deepEqual(
      queuedNumbers.sort((a, b) => a - b),
      [43367, 128515],
    );
    // A new refresh must not steal a real leased decision or its fence.
    const leasedBefore = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    // The existing four-item live probe bounds this alarm: the fifth stays pending.
    assert.equal(
      (leasedBefore.items["openclaw/openclaw#77508"] as { state: string }).state,
      "pending",
    );
    assert.equal(Object.hasOwn(leasedBefore.items, "openclaw/openclaw#119583"), false);
    assert.equal(Object.hasOwn(leasedBefore.items, "openclaw/openclaw#121477"), false);
    await offer({ ...envelopes[1]!, delivery_id: "leased-refresh" });
    const leasedAfter = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.deepEqual(leasedAfter.items, leasedBefore.items);
    fs.writeFileSync(
      path.join(artifacts, "queue-dispatches.json"),
      JSON.stringify(harness.dispatched, null, 2),
    );
  } finally {
    harness.restore();
  }

  const commandStorage = new MemoryDurableStorage();
  const commandQueue = new ExactReviewQueue(
    { storage: commandStorage },
    { EXACT_REVIEW_PENDING_SOFT_LIMIT: "1" },
  );
  const request = (body: Envelope) =>
    new Request("https://queue.invalid/enqueue", { method: "POST", body: JSON.stringify(body) });
  const command = {
    ...envelopes[1]!,
    delivery_id: "maintainer-command",
    decision: {
      ...envelopes[1]!.decision,
      sourceAction: "exact_review_command",
      commandStatusMarker: "<!-- clawsweeper-command-status:128515:re_review:fixture -->",
      statusCommentId: 9001,
      sourceHeadSha: "a".repeat(40),
      sourceHeadVerified: true,
      sourceAuthoritySeq: 7,
    },
  };
  assert.equal((await commandQueue.fetch(request(command))).status, 202);
  const commandBefore = (await commandStorage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  await commandQueue.fetch(request(envelopes[1]!));
  const commandAfter = (await commandStorage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.deepEqual(commandAfter.items, commandBefore.items);
  const shed = await commandQueue.fetch(request(envelopes[0]!));
  assert.deepEqual(await shed.json(), { ok: true, shed: true, reason: "backpressure" });
  const invalid = await commandQueue.fetch(
    request({ ...envelopes[0]!, decision: { ...envelopes[0]!.decision, itemNumber: 0 } }),
  );
  assert.equal(invalid.status, 400);

  // Execute the executor's live guards as well, including a target disappearing after enqueue.
  for (const state of ["open", "closed", "missing"]) {
    fs.writeFileSync(env.GITHUB_OUTPUT, "");
    success(liveCheck.run!, {
      LIVE_STATE: state,
      TARGET_REPO: env.APPLY_TARGET_REPO,
      ITEM_NUMBER: "43367",
      CLAIM_TARGET_BRANCH: "release/proof-branch",
      CLAIM_DECISION: JSON.stringify(envelopes[0]!.decision),
    });
    const output = fs.readFileSync(env.GITHUB_OUTPUT, "utf8");
    assert.match(output, new RegExp(`^proceed=${state === "open"}$`, "m"));
    if (state === "closed") assert.match(output, /^terminal_noop=true$/m);
    if (state === "missing") assert.match(output, /^terminal_missing=true$/m);
  }
  // The producer cannot silently invent an issue kind when its exact read fails.
  const missing = run(producer.run!, { LIVE_STATE: "missing" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /HTTP 404/);
  const failedDispatch = run(producer.run!, { FAIL_DISPATCH: "true" });
  assert.notEqual(failedDispatch.status, 0);
  assert.match(failedDispatch.stderr, /dispatch HTTP 500/);
  const failedIntake = run(intake.run!, {
    CLIENT_PAYLOAD: JSON.stringify(events[0].client_payload),
    FAIL_INTAKE: "true",
  });
  assert.notEqual(failedIntake.status, 0);
  assert.match(failedIntake.stderr, /queue HTTP 500/);
  const dispatchCount = rows(dispatches).length;
  for (const overrides of [
    { APPLY_NOOP: "true" },
    { APPLY_SYNC_COMMENTS_ONLY: "true" },
    { APPLY_AUTO_SELECTED_BATCH: "false" },
  ])
    success(producer.run!, overrides);
  fs.renameSync(
    path.join(artifacts, "apply-report.json"),
    path.join(artifacts, "recorded-report.json"),
  );
  success(producer.run!);
  assert.equal(rows(dispatches).length, dispatchCount);
  const summary = {
    provider: "local-controlled-subprocess",
    id: path.basename(artifacts),
    node: process.version,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
    workflowSha256: createHash("sha256")
      .update(fs.readFileSync(path.join(sourceRoot, ".github/workflows/sweep.yml")))
      .digest("hex"),
    reportSha256: createHash("sha256").update(report).digest("hex"),
    recordedRows: 27,
    driftRows: 15,
    selected,
    queueAccepted: 5,
    executorDispatches: 2,
    stillPending: 1,
    terminalBeforeDispatch: 2,
    assertions:
      "selection/order/cap; exact routing; normalized branch/kind/source/refresh semantics; duplicate, command authority and leased preservation; backpressure and invalid target; closed/missing live guards; read/dispatch/intake failures; default-apply guards",
    limits:
      "Controlled Bash/Node subprocesses and real queue code on local test SQLite storage; synthetic issue/PR kinds, GitHub responses and public fixture signing key. No hosted GitHub, real Cloudflare DO, production admission, Codex review, publication, or close executed. No container/image/lease.",
  };
  fs.writeFileSync(
    path.join(artifacts, "queue-results.json"),
    JSON.stringify(queueResults, null, 2),
  );
  fs.writeFileSync(path.join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));
  return { artifacts, ...summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await proveApplyDriftRefresh(), null, 2));
}
