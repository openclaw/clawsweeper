import assert from "node:assert/strict";
import YAML from "yaml";
import fs from "node:fs";
import { createServer } from "node:http";
import { createHmac, generateKeyPairSync, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { bayHtml } from "../../../dashboard/bay-page.ts";
import { publicStatusProjection } from "../../../dashboard/worker.ts";
const dir = ".artifacts/parked-command-finalization";
fs.mkdirSync(dir, { recursive: true });
for (const file of ["result.json", "bay.png", "bay-mobile.png", "worker.log"])
  fs.rmSync(dir + "/" + file, { force: true });
fs.rmSync(dir + "/state", { recursive: true, force: true });
const nonce = String(Date.now());
const config = "docs/proof/parked-command-finalization";
const secret = "synthetic-parked-proof";
const origin = "http://127.0.0.1:8797";
const targets = new Map(),
  dispatches = [],
  trace = [],
  results = [];
const statusComments = new Map();
let takeoverOnLookup = null;
let statusWrites = 0;
let fixtureRepositoryPrivate = false;
const head = "a".repeat(40);
let child, browser;
const stub = createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1:8897");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  trace.push({ method: req.method, path: u.pathname });
  const reply = (body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (u.pathname.endsWith("/installation")) return reply({ id: 999 });
  if (u.pathname === "/app/installations/999/access_tokens")
    return reply({ token: "synthetic-token", expires_at: "2099-01-01T00:00:00Z" });
  if (u.pathname.endsWith("/actions/workflows/sweep.yml")) return reply({ state: "active" });
  if (u.pathname === "/repos/openclaw/clawsweeper/dispatches") {
    dispatches.push(JSON.parse(raw));
    return reply({}, 204);
  }
  const exactComment = new RegExp("^/repos/openclaw/gogcli/issues/comments/([0-9]+)$").exec(
    u.pathname,
  );
  const commentList = new RegExp("^/repos/openclaw/gogcli/issues/([0-9]+)/comments$").exec(
    u.pathname,
  );
  if (exactComment || commentList) {
    if (takeoverOnLookup && req.method === "GET") {
      const key = takeoverOnLookup;
      takeoverOnLookup = null;
      await call("/__proof/park", { key, takeover: true });
    }
    if (exactComment) {
      const id = Number(exactComment[1]),
        comment = statusComments.get(id);
      if (!comment) return reply({ message: "missing fixture comment" }, 404);
      if (req.method === "PATCH") {
        statusWrites++;
        comment.body = JSON.parse(raw).body;
        comment.updated_at = new Date().toISOString();
      }
      return reply(comment);
    }
    return reply(
      [...statusComments.values()].filter((c) => c.issue_url.endsWith("/" + commentList[1])),
    );
  }
  const match = u.pathname.match(/^\/repos\/openclaw\/gogcli\/(pulls|issues)\/(\d+)$/);
  if (match) {
    const n = Number(match[2]);
    return reply(targets.get(n) || { message: "fixture missing" }, targets.has(n) ? 200 : 404);
  }
  if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname))
    return reply({
      full_name: u.pathname.slice(7),
      private: fixtureRepositoryPrivate && u.pathname === "/repos/openclaw/gogcli",
      visibility:
        fixtureRepositoryPrivate && u.pathname === "/repos/openclaw/gogcli" ? "private" : "public",
      archived: false,
      disabled: false,
      default_branch: "main",
    });
  if (u.pathname.includes("/actions/runs/"))
    return reply({ id: 990003, run_attempt: 1, status: "in_progress" });
  return reply({ message: "unhandled fixture route" }, 404);
});
await new Promise((resolve) => stub.listen(8897, "127.0.0.1", resolve));
const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
fs.writeFileSync(
  config + "/.dev.vars",
  "CLAWSWEEPER_APP_PRIVATE_KEY=" + JSON.stringify(privateKey) + "\nPROOF_NONCE=" + nonce + "\n",
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function stop() {
  if (!child) return;
  const c = child;
  child = null;
  try {
    process.kill(-c.pid, "SIGTERM");
  } catch {}
  await Promise.race([once(c, "exit"), sleep(5000)]);
}
async function start() {
  const log = fs.openSync(dir + "/worker.log", "a");
  child = spawn(
    "npx",
    [
      "--yes",
      "wrangler@4.107.0",
      "dev",
      "--config",
      config + "/wrangler.toml",
      "--local",
      "--persist-to",
      dir + "/state",
      "--ip",
      "127.0.0.1",
      "--port",
      "8797",
    ],
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  fs.closeSync(log);
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("local Worker exited");
    try {
      const r = await fetch(origin + "/__proof/identity", { signal: AbortSignal.timeout(2000) });
      if (r.ok && (await r.json()).nonce === nonce) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("local Worker readiness timeout");
}
async function call(path, body, expected = 200) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers = text
    ? {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature":
          "sha256=" + createHmac("sha256", secret).update(text).digest("hex"),
      }
    : {};
  const r = await fetch(origin + path, {
    signal: AbortSignal.timeout(15000),
    method: text ? "POST" : "GET",
    headers,
    body: text,
  });
  const out = await r.json();
  assert.equal(r.status, expected, JSON.stringify({ path, out }));
  return out;
}
const state = () => call("/__proof/state");
async function workflowAdmission(tuple, address, label) {
  const workflow = YAML.parse(fs.readFileSync(".github/workflows/sweep.yml", "utf8"));
  const steps = workflow.jobs["event-review-terminal-finalization"].steps;
  const admissionIndex = steps.findIndex((step) => step.id === "terminal-acknowledgement");
  const tokenIndex = steps.findIndex((step) => step.id === "target-write-token");
  assert.ok(admissionIndex >= 0 && admissionIndex < tokenIndex);
  assert.match(steps[tokenIndex].if, /terminal-acknowledgement.outputs.allowed == .true./);
  const output = dir + "/" + label + ".outputs";
  fs.writeFileSync(output, "");
  const runner = spawn("bash", ["-euo", "pipefail", "-c", steps[admissionIndex].run], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      ITEM_KEY: tuple.item_key,
      QUEUE_LEASE_ID: tuple.lease_id,
      LEASE_REVISION: String(tuple.lease_revision),
      CLAIM_GENERATION: String(tuple.claim_generation),
      RUN_ATTEMPT: String(tuple.run_attempt),
      GITHUB_RUN_ID: String(tuple.run_id),
      STATUS_MARKER: address.status_marker || "",
      STATUS_COMMENT_ID: String(address.status_comment_id || ""),
      QUEUE_URL: origin,
      GITHUB_OUTPUT: output,
    },
  });
  let stderr = "";
  runner.stdout.resume();
  runner.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [exit] = await once(runner, "exit");
  assert.equal(exit, 0, stderr);
  const values = Object.fromEntries(
    fs
      .readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const n = line.indexOf("=");
        return [line.slice(0, n), line.slice(n + 1)];
      }),
  );
  return { ...values, allowed: values.allowed === "true" };
}

async function seed(n, variant = "marker", targetState = "closed") {
  const key = "openclaw/gogcli#" + n;
  const marker = "<!-- clawsweeper-command-status:" + n + ":re_review:synthetic -->";
  targets.set(n, {
    number: n,
    node_id: "PR_synthetic_" + n,
    state: targetState,
    closed_at: targetState === "closed" ? "2026-09-01T00:00:00Z" : null,
    head: { sha: head },
    merged: variant === "comment",
  });
  await call(
    "/internal/exact-review/enqueue",
    {
      delivery_id: "synthetic-" + n,
      decision: {
        targetRepo: "openclaw/gogcli",
        targetBranch: "main",
        itemNumber: n,
        itemKind: "pull_request",
        sourceEvent: "pull_request",
        sourceAction: "legacy_dispatch",
        sourceHeadSha: head,
        supersedesInProgress: false,
        ...(variant === "marker" ? { commandStatusMarker: marker } : { statusCommentId: n + 100 }),
      },
    },
    202,
  );
  await call("/__proof/park", { key });
  return {
    key,
    n,
    address: variant === "marker" ? { status_marker: marker } : { status_comment_id: n + 100 },
  };
}
async function drive(f) {
  await call("/__proof/alarm", {});
  let driver;
  for (let i = 0; i < 10; i++) {
    driver = Object.values((await state()).items).find(
      (x) => x.terminalFinalization?.parkedCommand?.itemKey === f.key,
    );
    if (driver?.state === "dispatching") break;
    await call("/__proof/alarm", {});
    await sleep(100);
  }
  assert.ok(driver);
  assert.equal(driver.state, "dispatching");
  const claim = await call("/internal/exact-review/claim", {
    item_key: driver.key,
    lease_id: driver.leaseId,
    lease_revision: driver.leaseRevision,
    run_id: "990003",
    run_attempt: 1,
  });
  const item = (await state()).items[driver.key];
  assert.ok(claim.claimed);
  return {
    item_key: item.key,
    lease_id: item.leaseId,
    lease_revision: item.leaseRevision,
    claim_generation: item.claimGeneration,
    run_id: item.claimedRunId,
    run_attempt: item.claimedRunAttempt,
  };
}
async function statusCli(f, tuple, attemptId, takeover) {
  const bin = dir + "/bin";
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(config + "/gh-fixture.mjs", bin + "/gh");
  fs.chmodSync(bin + "/gh", 0o755);
  const id = f.n + 100,
    sourceId = f.n + 1000;
  statusComments.set(id, {
    id,
    body: [
      "<!-- clawsweeper-command-ack:" + sourceId + " -->",
      f.address.status_marker,
      "Waiting for review.",
    ].join(String.fromCharCode(10)),
    user: { login: "clawsweeper[bot]" },
    issue_url: "https://api.github.com/repos/openclaw/gogcli/issues/" + f.n,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (takeover) takeoverOnLookup = f.key;
  const output = dir + "/cli-" + f.n + ".txt";
  fs.rmSync(output, { force: true });
  const proc = spawn(
    process.execPath,
    [
      "dist/repair/update-command-status.js",
      "--repo",
      "openclaw/gogcli",
      "--item-number",
      String(f.n),
      "--marker",
      f.address.status_marker,
      "--state",
      "Failed",
      "--detail",
      "The review exhausted its retry budget and the item is now closed. No review or repair was restarted.",
      "--require-mutation",
      "--verify-terminal-status-receipt",
      "--require-terminal-finalization-fence",
    ],
    {
      env: {
        PATH: process.cwd() + "/" + bin + ":" + process.env.PATH,
        HOME: process.env.HOME,
        CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
        GITHUB_OUTPUT: process.cwd() + "/" + output,
        QUEUE_URL: origin,
        GITHUB_RUN_ID: tuple.run_id,
        GITHUB_RUN_ATTEMPT: String(tuple.run_attempt),
        TERMINAL_FINALIZATION_ITEM_KEY: tuple.item_key,
        TERMINAL_FINALIZATION_LEASE_ID: tuple.lease_id,
        TERMINAL_FINALIZATION_LEASE_REVISION: String(tuple.lease_revision),
        TERMINAL_FINALIZATION_CLAIM_GENERATION: String(tuple.claim_generation),
        ATTEMPT_ID: attemptId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  proc.stdout.on("data", (x) => (logs += x));
  proc.stderr.on("data", (x) => (logs += x));
  const [code] = await once(proc, "exit");
  assert.equal(code, 0, logs);
  return fs.existsSync(output)
    ? Object.fromEntries(
        fs
          .readFileSync(output, "utf8")
          .trim()
          .split(String.fromCharCode(10))
          .filter(Boolean)
          .map((line) => {
            const i = line.indexOf("=");
            return [line.slice(0, i), line.slice(i + 1)];
          }),
      )
    : {};
}

try {
  await start();
  for (const [n, variant, skip] of [
    [990001, "marker", "missing_status_comment"],
    [990002, "comment", "locked_conversation"],
  ]) {
    const f = await seed(n, variant),
      tuple = await drive(f);
    if (n === 990001) {
      await stop();
      await start();
      assert.equal(
        (await state()).items[tuple.item_key].terminalFinalization.parkedCommand.itemKey,
        f.key,
      );
      results.push({
        scenario: "claimed finalizer survives Worker restart",
        owner_and_producer_retained: true,
      });
    }
    const first = await call("/internal/exact-review/terminal-finalization/attempt", {
      ...tuple,
      ...f.address,
    });
    assert.equal(first.allowed, true);
    assert.equal(first.status_state, "Failed");
    assert.equal((await state()).items[f.key].state, "parked");
    const wrong = await call(
      "/internal/exact-review/terminal-finalization/skip",
      { ...tuple, ...f.address, attempt_id: "ack:999", reason: skip },
      409,
    );
    assert.ok(wrong.error);
    assert.ok((await state()).items[f.key]);
    await call("/internal/exact-review/terminal-finalization/skip", {
      ...tuple,
      ...f.address,
      attempt_id: first.attempt_id,
      reason: skip,
    });
    assert.equal((await state()).items[f.key], undefined);
    results.push({
      scenario: variant + " " + skip,
      retired_after_receipt: true,
      no_review_restart: true,
    });
  }
  const acknowledged = await seed(990008);
  const acknowledgedTuple = await drive(acknowledged);
  const firstAttempt = await call("/internal/exact-review/terminal-finalization/attempt", {
    ...acknowledgedTuple,
    ...acknowledged.address,
  });
  const receiptIdentity = {
    canonical_target_key: acknowledged.key,
    fence_key: acknowledged.key,
    revision: 1,
  };
  await call("/internal/exact-review/lifecycle/command-ack/failed", {
    ...receiptIdentity,
    ...acknowledged.address,
    attempt_id: firstAttempt.attempt_id,
  });
  assert.equal((await state()).items[acknowledged.key].state, "parked");
  const secondAttempt = await call("/internal/exact-review/terminal-finalization/attempt", {
    ...acknowledgedTuple,
    ...acknowledged.address,
  });
  assert.equal(secondAttempt.allowed, true);
  const receipt = {
    ...receiptIdentity,
    ...acknowledged.address,
    command_comment_id: 991008,
    completion_comment_id: 992008,
    completed_at: new Date().toISOString(),
    completion_outcome: "failure",
    observed_at: Date.now(),
  };
  assert.equal(
    (await call("/internal/exact-review/lifecycle/command-ack/observed", receipt)).accepted,
    true,
  );
  assert.equal((await state()).items[acknowledged.key], undefined);
  await call("/internal/exact-review/lifecycle/command-ack/observed", receipt);
  assert.equal((await state()).items[acknowledged.key], undefined);
  results.push({
    scenario: "failed then observed receipt and replay",
    retired_after_receipt: true,
    idempotent: true,
  });
  for (const [n, takeover] of [
    [990009, true],
    [990010, false],
  ]) {
    const f = await seed(n),
      tuple = await drive(f);
    const begun = await call("/internal/exact-review/terminal-finalization/attempt", {
      ...tuple,
      ...f.address,
    });
    const before = statusWrites;
    const outcome = await statusCli(f, tuple, begun.attempt_id, takeover);
    assert.equal(statusWrites - before, takeover ? 0 : 1);
    if (!takeover) {
      assert.equal(outcome.terminal_status_verified, "true");
      assert.equal((await state()).items[f.key].state, "parked");
      await call("/internal/exact-review/lifecycle/command-ack/observed", {
        canonical_target_key: f.key,
        fence_key: f.key,
        revision: 1,
        ...f.address,
        command_comment_id: Number(outcome.command_comment_id),
        completion_comment_id: Number(outcome.completion_comment_id),
        completed_at: outcome.completion_completed_at,
        completion_outcome: "failure",
        observed_at: Date.now(),
      });
      assert.equal((await state()).items[f.key], undefined);
    }
    results.push({
      scenario: takeover
        ? "CLI lookup takeover fenced before PATCH"
        : "CLI fenced PATCH and verified receipt",
      writes: statusWrites - before,
    });
  }
  const open = await seed(990003, "marker", "open");
  await call("/__proof/alarm", {});
  assert.equal((await state()).items[open.key].state, "parked");
  await stop();
  await start();
  assert.equal((await state()).items[open.key].parkedRecoveryAttempts, 3);
  results.push({ scenario: "open/restart", retained_exhausted: true });
  const reopened = await seed(990004);
  const tuple = await drive(reopened);
  targets.get(990004).state = "open";
  await call(
    "/internal/exact-review/terminal-finalization/attempt",
    { ...tuple, ...reopened.address },
    409,
  );
  assert.equal((await state()).items[reopened.key].state, "parked");
  results.push({ scenario: "reopen-before-ack", producer_preserved: true });
  const cancelledPlan = await seed(990012);
  const cancelledTuple = await drive(cancelledPlan);
  const authorised = await call("/internal/exact-review/terminal-finalization/attempt", {
    ...cancelledTuple,
    ...cancelledPlan.address,
  });
  assert.equal(authorised.allowed, true);
  targets.get(990012).state = "open";
  await call(
    "/internal/exact-review/terminal-finalization/attempt",
    {
      ...cancelledTuple,
      ...cancelledPlan.address,
      verify_only: true,
      attempt_id: authorised.attempt_id,
    },
    409,
  );
  await stop();
  await start();
  const lateReceipt = await call("/internal/exact-review/lifecycle/command-ack/observed", {
    canonical_target_key: cancelledPlan.key,
    fence_key: cancelledPlan.key,
    revision: cancelledTuple.lease_revision,
    ...cancelledPlan.address,
    command_comment_id: 991012,
    completion_comment_id: 992012,
    completed_at: new Date().toISOString(),
    completion_outcome: "failure",
    observed_at: Date.now(),
  });
  assert.equal(lateReceipt.accepted, false);
  assert.equal((await state()).items[cancelledPlan.key].state, "parked");
  assert.equal((await state()).items[cancelledTuple.item_key], undefined);
  const lifecycleBay = await call("/api/durable-lifecycle-bay");
  const cancelledCard = lifecycleBay.durable_lifecycle_bay.sample.cards.find(
    (card) => card.item_number === cancelledPlan.n,
  );
  assert.ok(cancelledCard);
  assert.equal(cancelledCard.state, "failed");
  assert.equal(cancelledCard.lane, "terminal_attention");
  results.push({
    scenario: "reopen-after-authorization invalidates durable closure",
    late_receipt_refused_after_restart: true,
    producer_preserved: true,
    lifecycle_retains_failure_not_requeue: true,
  });
  // A fresh closure without another webhook gets new lifecycle ownership,
  // while the cancelled receipt remains permanently unusable.
  targets.get(cancelledPlan.n).state = "closed";
  targets.get(cancelledPlan.n).closed_at = "2026-09-02T00:00:00Z";
  await call("/__proof/park", { key: cancelledPlan.key });
  const reclosedTuple = await drive(cancelledPlan);
  assert.ok(reclosedTuple.lease_revision > cancelledTuple.lease_revision);
  const reclosedProducer = (await state()).items[cancelledPlan.key];
  assert.equal(reclosedProducer.state, "parked");
  assert.equal(reclosedProducer.parkedRecoveryAttempts, 3);
  assert.equal(reclosedProducer.attempts, 8);
  const reclosedAttempt = await call("/internal/exact-review/terminal-finalization/attempt", {
    ...reclosedTuple,
    ...cancelledPlan.address,
  });
  assert.equal(reclosedAttempt.allowed, true);
  const cancelledReceipt = await call("/internal/exact-review/lifecycle/command-ack/observed", {
    canonical_target_key: cancelledPlan.key,
    fence_key: cancelledPlan.key,
    revision: cancelledTuple.lease_revision,
    ...cancelledPlan.address,
    command_comment_id: 991012,
    completion_comment_id: 992012,
    observed_at: Date.now(),
  });
  assert.equal(cancelledReceipt.accepted, false);
  await call("/internal/exact-review/terminal-finalization/skip", {
    ...reclosedTuple,
    ...cancelledPlan.address,
    attempt_id: reclosedAttempt.attempt_id,
    reason: "missing_status_comment",
  });
  assert.equal((await state()).items[cancelledPlan.key], undefined);
  results.push({
    scenario: "reclose without webhook after cancelled closure",
    fresh_lifecycle_revision: true,
    old_receipt_rejected: true,
    exhausted_budget_preserved: true,
  });
  const takeover = await seed(990005);
  const old = await drive(takeover);
  await call("/__proof/park", { key: takeover.key, takeover: true });
  await call(
    "/internal/exact-review/terminal-finalization/attempt",
    { ...old, ...takeover.address },
    409,
  );
  results.push({ scenario: "new-revision", old_ack_refused: true });
  const ineligible = await seed(990014);
  const beforeIneligible = dispatches.length;
  fixtureRepositoryPrivate = true;
  await call("/__proof/alarm", {});
  const retainedIneligible = (await state()).items[ineligible.key];
  assert.equal(retainedIneligible.state, "parked");
  assert.equal(retainedIneligible.parkedRecoveryAttempts, 3);
  assert.equal(dispatches.length, beforeIneligible);
  assert.equal(
    Object.values((await state()).items).some(
      (item) => item.terminalFinalization?.parkedCommand?.itemKey === ineligible.key,
    ),
    false,
  );
  fixtureRepositoryPrivate = false;
  results.push({
    scenario: "repository eligibility lost",
    obligation_retained: true,
    no_dispatch: true,
  });
  const deferred = await seed(990015);
  await call("/__proof/alarm", {});
  const planned = Object.values((await state()).items).find(
    (item) => item.terminalFinalization?.parkedCommand?.itemKey === deferred.key,
  );
  assert.ok(planned);
  assert.equal(planned.state, "pending");
  const plannedQueue = await call("/api/exact-review-queue");
  const producerCard = plannedQueue.bay_projection.items.find(
    (item) => item.item_number === 990015,
  );
  assert.equal(producerCard.stage, "repairing");
  assert.equal(producerCard.queue_disposition, "parked_exhausted");
  const beforeDeferral = dispatches.length;
  fixtureRepositoryPrivate = true;
  await call("/__proof/alarm", {});
  const held = (await state()).items[planned.key];
  assert.equal(held.state, "pending");
  assert.deepEqual(
    held.terminalFinalization.parkedCommand,
    planned.terminalFinalization.parkedCommand,
  );
  assert.equal(dispatches.length, beforeDeferral);
  fixtureRepositoryPrivate = false;
  await call("/__proof/ready-driver", { key: planned.key });
  const revoked = await drive(deferred);
  fixtureRepositoryPrivate = true;
  const revokedAdmission = await workflowAdmission(revoked, deferred.address, "revoked-admission");
  assert.equal(revokedAdmission.allowed, false);
  results.push({
    scenario: "workflow eligibility before target write credentials",
    target_write_credentials: false,
    denied_before_token_step: true,
  });
  assert.equal((await state()).items[planned.key].state, "pending");
  fixtureRepositoryPrivate = false;
  await call("/__proof/ready-driver", { key: planned.key });
  const resumed = await drive(deferred);
  const resumedAck = await workflowAdmission(resumed, deferred.address, "resumed-admission");
  assert.equal(resumedAck.allowed, true);
  await call("/internal/exact-review/terminal-finalization/skip", {
    ...resumed,
    ...deferred.address,
    attempt_id: resumedAck.attempt_id,
    reason: "missing_status_comment",
  });
  assert.equal((await state()).items[deferred.key], undefined);
  results.push({
    scenario: "pending driver survives eligibility loss and retains exhausted Bay card",
    resumed_fenced: true,
    producer_retired_after_skip: true,
  });
  const failedWriter = await seed(990017);
  const writerTuple = await drive(failedWriter);
  const writerAdmission = await call("/internal/exact-review/terminal-finalization/attempt", {
    ...writerTuple,
    ...failedWriter.address,
  });
  assert.equal(writerAdmission.allowed, true);
  const nextHead = "b".repeat(40);
  targets.get(failedWriter.n).state = "open";
  targets.get(failedWriter.n).head = { sha: nextHead };
  const originalDecision = (await state()).items[failedWriter.key].decision;
  await call(
    "/internal/exact-review/enqueue",
    {
      delivery_id: "synthetic-failed-writer-successor",
      decision: {
        ...originalDecision,
        sourceAction: "synchronize",
        sourceHeadSha: nextHead,
        sourceHeadVerified: true,
        sourceUpdatedAt: new Date().toISOString(),
        supersedesInProgress: true,
      },
    },
    202,
  );
  await call("/__proof/alarm", {});
  const deferredSuccessor = (await state()).items[failedWriter.key];
  assert.equal(deferredSuccessor.backoffReason, "coordination_retry");
  const releaseRetry = await call(
    "/internal/exact-review/terminal-finalization/retry",
    writerTuple,
  );
  assert.equal(releaseRetry.requeued, true);
  const releasedState = await state();
  assert.equal(
    releasedState.items[writerTuple.item_key].terminalFinalization.parkedCommand
      .coordinationDeferral,
    undefined,
  );
  assert.notEqual(releasedState.items[failedWriter.key].backoffReason, "coordination_retry");
  assert.ok(releasedState.items[failedWriter.key].nextAttemptAt < deferredSuccessor.nextAttemptAt);
  results.push({
    scenario: "failed writer retry releases a new-source successor",
    owned_deferral_released: true,
    new_source_head: nextHead,
  });
  assert.ok(dispatches.length > 0);
  assert.ok(
    dispatches.every(
      (d) =>
        d.client_payload.source_action === "exact_review_command_acknowledgement" ||
        (d.client_payload.item_number === 990017 && d.client_payload.source_head_sha === nextHead),
    ),
  );
  const queue = await call("/api/exact-review-queue");
  assert.ok(queue.bay_projection.items.some((i) => i.queue_disposition === "parked_exhausted"));
  // Real renderer consumes a production-sanitized mixed sample over HTTP.
  const stages = {
    arriving: 0,
    "setting-up": 0,
    reviewing: 1,
    publishing: 0,
    applying: 0,
    repairing: 2,
  };
  const zero = Object.fromEntries(Object.keys(stages).map((k) => [k, 0]));
  const now = new Date().toISOString();
  const rows = [
    {
      repository: "openclaw/gogcli",
      item_number: 990003,
      stage: "repairing",
      source: "queue",
      queue_disposition: "parked_exhausted",
      legacy_batch_path: false,
      timing: { kind: "queue", started_at: "2026-08-01T00:00:00Z" },
    },
    {
      repository: "openclaw/gogcli",
      item_number: 990006,
      stage: "repairing",
      source: "queue",
      queue_disposition: "retry_scheduled",
      legacy_batch_path: false,
    },
    {
      repository: "openclaw/gogcli",
      item_number: 990007,
      stage: "reviewing",
      source: "live",
      legacy_batch_path: false,
      timing: { kind: "run", started_at: now },
    },
  ];
  const snapshot = publicStatusProjection(
    {
      schema_version: 1,
      fleet: {},
      automatic_work: [],
      bay: {
        metrics_state: "complete",
        timing_coverage_complete: true,
        active_census_complete: true,
        active_stages: { ...zero, reviewing: 1 },
        tide_generation: 0,
        tide_threshold: 20,
        terminal_count: 0,
        terminal_buffer: [],
        recently_washed: [],
        last_tide_at: null,
        washed_at: null,
        timings: {
          window_minutes: 60,
          window_ended_at: now,
          overall: { samples: 0, average_ms: null, median_ms: null },
          history: { bucket_minutes: 5, points: [] },
          including_legacy_batch: {
            overall: { samples: 0, average_ms: null, median_ms: null },
            history: { bucket_minutes: 5, points: [] },
          },
        },
      },
      diagnostics: { errors: [], error_count: 0 },
      health: { sampled_runs: 0 },
      generated_at: now,
      public_projection_complete: true,
      workers: [],
      pipeline: [],
      freshness: {
        state: "fresh",
        generated_at: now,
        age_ms: 0,
        maximum_age_ms: 60000,
        cache_state: "fresh",
      },
      exact_review_queue: {
        ...queue,
        bay_projection: {
          complete: true,
          sample_limit: 24,
          total: 3,
          stages,
          legacy_batch_stages: zero,
          items: rows,
          activity: {
            complete: true,
            total: 3,
            queue_stages: { ...zero, repairing: 2 },
            live_stages: { ...zero, reviewing: 1 },
            queue_legacy_batch_stages: zero,
            live_legacy_batch_stages: zero,
            items: rows,
          },
        },
      },
    },
    new Set(["openclaw/gogcli", "openclaw/clawsweeper"]),
  );
  assert.equal(snapshot.exact_review_queue.collection.state, "complete");
  fs.writeFileSync(dir + "/browser-snapshot.json", JSON.stringify(snapshot, null, 2));
  const pageServer = createServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (
      /^\/bay-assets\/[A-Za-z0-9._-]+\.(webp|png)$/.test(path) &&
      fs.existsSync("dashboard/public" + path)
    ) {
      res.setHeader("content-type", path.endsWith(".png") ? "image/png" : "image/webp");
      res.end(fs.readFileSync("dashboard/public" + path));
      return;
    }
    res.setHeader("content-type", path === "/bay" ? "text/html" : "application/json");
    res.end(path === "/bay" ? bayHtml() : path === "/api/status" ? JSON.stringify(snapshot) : "{}");
  });
  await new Promise((r) => pageServer.listen(8796, "127.0.0.1", r));
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const external = [];
    page.on("request", (r) => {
      if (!r.url().startsWith("http://127.0.0.1:8796")) external.push(r.url());
    });
    await page.goto("http://127.0.0.1:8796/bay");
    await page.waitForSelector('[data-number="990003"]');
    assert.match(
      await page.locator("#active-count").innerText(),
      /1 live.*2 queue.attention records/,
    );
    assert.match(await page.locator('[data-number="990003"]').innerText(), /Retry exhausted/);
    assert.doesNotMatch(await page.locator('[data-number="990003"]').innerText(), /Queued/);
    assert.match(await page.locator('[data-number="990006"]').innerText(), /Retry scheduled/);
    assert.equal(external.length, 0);
    await page.locator('[data-number="990003"]').click();
    assert.match(
      await page.locator("#drawer-body").innerText(),
      /Retry exhausted · operator attention/,
    );
    await page.keyboard.press("Escape");
    await page.screenshot({ path: dir + "/bay.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.match(await page.locator('[data-number="990003"]').innerText(), /Retry exhausted/);
    await page.screenshot({ path: dir + "/bay-mobile.png", fullPage: true });
    snapshot.generated_at = new Date(Date.now() - 120000).toISOString();
    snapshot.freshness = {
      ...snapshot.freshness,
      state: "stale",
      generated_at: snapshot.generated_at,
      age_ms: 120000,
    };
    await page.reload();
    await page.waitForFunction(() =>
      document.getElementById("active-count").textContent.includes("stale snapshot"),
    );
    snapshot.exact_review_queue.bay_projection.total = 2;
    snapshot.exact_review_queue.bay_projection.stages = { ...zero, repairing: 2 };
    snapshot.exact_review_queue.bay_projection.items = rows.filter((row) => row.source === "queue");
    snapshot.exact_review_queue.bay_projection.activity = {
      complete: false,
      queue_stages: null,
      live_stages: null,
      queue_legacy_batch_stages: null,
      live_legacy_batch_stages: null,
      total: null,
    };
    await page.reload();
    await page.waitForFunction(() =>
      document.getElementById("active-count").textContent.includes("Live activity unavailable"),
    );
    assert.match(await page.locator('[data-number="990003"]').innerText(), /Retry exhausted/);
    assert.match(await page.locator('[data-number="990006"]').innerText(), /Retry scheduled/);
    snapshot.public_projection_complete = false;
    await page.reload();
    await page.waitForFunction(() =>
      document.getElementById("active-count").textContent.includes("Live activity unavailable"),
    );
    assert.equal(await page.locator(".critter[data-number]").count(), 0);
    assert.equal(external.length, 0);
    results.push({
      scenario: "real-browser-mixed-sample",
      truthful_labels: true,
      drawer_and_mobile: true,
      stale_and_unavailable: true,
      no_browser_github: true,
    });
    await browser.close();
    browser = null;
  } finally {
    pageServer.close();
  }
  fs.writeFileSync(
    dir + "/result.json",
    JSON.stringify(
      {
        source_head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        source_diff_sha256: createHash("sha256")
          .update(execFileSync("git", ["diff", "HEAD"]))
          .digest("hex"),
        node: process.version,
        verified_at: new Date().toISOString(),
        runtime: "real local workerd Durable Object SQLite / production HTTP routes / Chromium",
        results,
        dispatches: dispatches.length,
        limits:
          "Synthetic fixture seeding and external GitHub responses; not a deployed Worker or hosted Actions job",
      },
      null,
      2,
    ),
  );
  console.log("PARKED_COMMAND_PROOF_PASS " + results.length);
} finally {
  if (browser) await browser.close();
  await stop();
  stub.close();
  fs.rmSync(config + "/.dev.vars", { force: true });
  fs.writeFileSync(dir + "/http-trace.json", JSON.stringify(trace, null, 2));
}
