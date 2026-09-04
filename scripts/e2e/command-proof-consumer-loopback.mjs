#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  worker,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
} from "../../test/dashboard-worker-harness.ts";
import { proofFixture, replaceReceipt, digest } from "../../test/helpers/command-proof-fixtures.ts";
import { foldCommandProofAssessment } from "../../dist/command-proof-assessment.js";
import { createRecordMetadata } from "../../dist/clawsweeper-record-metadata.js";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
fs.mkdirSync(path.join(source, ".openclaw/tmp"), { recursive: true });
const temporary = fs.mkdtempSync(path.join(source, ".openclaw/tmp/command-proof-runtime-"));
const runtime = path.join(temporary, "runtime");
fs.mkdirSync(runtime);
fs.cpSync(path.join(source, "dist"), path.join(runtime, "dist"), { recursive: true });
fs.cpSync(path.join(source, "config"), path.join(runtime, "config"), { recursive: true });
const fetchShim = path.join(temporary, "fixture-fetch.mjs"),
  gh = path.join(temporary, "gh-fixture.mjs");
fs.writeFileSync(fetchShim, "(" + fixtureFetch.toString() + ")();\n");
fs.writeFileSync(gh, "#!/usr/bin/env node\n(" + fixtureGh.toString() + ")();\n", { mode: 0o755 });
const secret = randomBytes(32).toString("hex"); // Ephemeral loopback auth only; never printed.
let f, storage, queue, database, comments, dispatches, apiWrites, queueEnqueues;
let scenario = "";
let exceptionResponseSafety;
const enqueueRejections = {
  "queue-shed": { ok: true, shed: true, reason: "backpressure" },
  "queue-rejected": { ok: true, accepted: false, reason: "target not enabled" },
  "queue-stale-dedupe": {
    ok: true,
    deduped: true,
    stale_source: true,
    item_key: "openclaw/openclaw#42",
  },
  "queue-unscoped-dedupe": { ok: true, deduped: true },
};
const observations = [];
const opened = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1024 * 1024) throw new Error("fixture request too large");
    }
    if (url.pathname.startsWith("/internal/")) {
      if (url.pathname === "/internal/exact-review/enqueue") {
        queueEnqueues++;
        if (enqueueRejections[scenario]) return json(res, enqueueRejections[scenario]);
      }
      const result = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai" + url.pathname, {
          method: req.method,
          headers: req.headers,
          body: raw || undefined,
        }),
        {
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
        },
      );
      if (
        url.pathname === "/internal/exact-review/enqueue" &&
        scenario === "enqueue-response-lost" &&
        queueEnqueues === 1
      ) {
        const accepted = await result.json();
        assert.equal(accepted.queued, true);
        res.destroy();
        return;
      }
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    if (req.method !== "GET") apiWrites.push(req.method + " " + url.pathname);
    const p = "/repos/openclaw/openclaw";
    if (url.pathname === p) return json(res, f.live.repository);
    if (url.pathname === p + "/pulls/42") return json(res, f.live.pull);
    if (url.pathname === p + "/issues/comments/200") return json(res, f.live.comment);
    if (url.pathname === p + "/collaborators/maintainer/permission")
      return json(res, f.live.permission);
    if (url.pathname === p + "/commits/" + f.claim.workflowRef) {
      if (scenario === "ref-lookup-failure") {
        res.writeHead(503);
        res.end("fixture lookup unavailable");
        return;
      }
      return json(res, { sha: f.claim.workflowSha });
    }
    if (
      url.pathname === p + "/actions/workflows/mantis-web-ui-chat-proof.yml/dispatches" &&
      req.method === "POST"
    ) {
      const payload = JSON.parse(raw);
      assert.equal(payload.ref, f.claim.workflowRef);
      assert.deepEqual(Object.keys(payload.inputs).sort(), [
        "candidate_ref",
        "pr_number",
        "request_id",
      ]);
      assert.equal(req.headers["x-github-api-version"], "2026-03-10");
      dispatches++;
      const bound = proofFixture(payload.inputs.request_id);
      f = {
        ...f,
        receipt: bound.receipt,
        receiptArchive: bound.receiptArchive,
        receiptArtifact: bound.receiptArtifact,
        evidenceArchive: bound.evidenceArchive,
        evidenceArtifact: bound.evidenceArtifact,
      };
      f.run.display_title = "Mantis [" + payload.inputs.request_id + "]";
      return json(res, {
        workflow_run_id: 300,
        run_url: "https://api.github.com" + p + "/actions/runs/300",
        html_url: "https://github.com/openclaw/openclaw/actions/runs/300",
      });
    }
    if (url.pathname === p + "/actions/runs/300") return json(res, f.run);
    if (url.pathname === p + "/actions/runs/300/attempts/1/jobs") return json(res, f.jobs);
    if (url.pathname === p + "/actions/runs/300/artifacts")
      return json(res, { total_count: 2, artifacts: [f.receiptArtifact, f.evidenceArtifact] });
    if (url.pathname === p + "/actions/artifacts/401/zip") {
      res.writeHead(200);
      res.end(f.receiptArchive);
      return;
    }
    if (url.pathname === p + "/actions/artifacts/400/zip") {
      res.writeHead(200);
      res.end(f.evidenceArchive);
      return;
    }
    if (url.pathname === "/user") return json(res, { login: "clawsweeper[bot]" });
    if (url.pathname === p + "/issues/42/comments") return json(res, comments);
    if (url.pathname === p + "/issues/comments/500") {
      if (req.method === "PATCH") comments[0].body = JSON.parse(raw).body;
      return json(res, comments[0]);
    }
    res.writeHead(422);
    res.end(
      JSON.stringify({ message: "unexpected fixture request " + req.method + " " + url.pathname }),
    );
  } catch (error) {
    // Keep diagnostics out of the HTTP body; never log exception text, payloads,
    // headers or stacks that might contain signed URLs or ephemeral credentials.
    const category =
      error instanceof SyntaxError
        ? "invalid_json"
        : error?.code === "ERR_ASSERTION"
          ? "fixture_assertion"
          : "request_failure";
    console.error("fixture_handler_error scenario=" + scenario + " category=" + category);
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify({ message: "fixture_request_failed" }));
  }
});

function startQueue(file) {
  const next = new MemoryDurableStorage(file);
  opened.push(next);
  return { storage: next, queue: new ExactReviewQueue({ storage: next }, {}) };
}
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  for (scenario of [
    "pass",
    "fail",
    "candidate-only",
    "stale-head",
    "cross-pr",
    "bad-digest",
    "missing-observation",
    "infra",
    "rerun-attempt",
    "queue-shed",
    "queue-rejected",
    "queue-stale-dedupe",
    "queue-unscoped-dedupe",
    "enqueue-response-lost",
    "ref-lookup-failure",
  ]) {
    f = proofFixture();
    comments = [];
    dispatches = 0;
    apiWrites = [];
    queueEnqueues = 0;
    database = path.join(temporary, scenario + ".sqlite");
    ({ storage, queue } = startQueue(database));
    if (scenario === "pass") {
      // Exercise the real JSON.parse -> catch response path before any dispatch.
      const attackerHtml = "<script>alert('fixture-xss')</script>";
      const response = await fetch(
        base + "/repos/openclaw/openclaw/actions/workflows/mantis-web-ui-chat-proof.yml/dispatches",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: attackerHtml,
        },
      );
      const body = await response.text();
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(body, JSON.stringify({ message: "fixture_request_failed" }));
      assert.equal(body.includes(attackerHtml), false);
      assert.doesNotMatch(body, /[<>]/);
      assert.equal(dispatches, 0);
      assert.equal(queueEnqueues, 0);
      exceptionResponseSafety = {
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentTypeOptions: response.headers.get("x-content-type-options"),
        body: JSON.parse(body),
      };
    }
    const input = path.join(temporary, "request.json");
    fs.writeFileSync(
      input,
      JSON.stringify({ repository: "openclaw/openclaw", pullRequest: 42, commentId: "200" }),
    );
    const unauthorized = await fetch(base + "/internal/command-proof/claim", {
      method: "POST",
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    const requested = JSON.parse(await runCli(["request", input], base));
    const lookupFailed = scenario === "ref-lookup-failure";
    const queueRejected = Boolean(enqueueRejections[scenario]);
    assert.equal(requested.status, lookupFailed ? "inconclusive" : "queued");
    assert.equal(dispatches, lookupFailed ? 0 : 1);
    const id = requested.requestId;
    assert.match(id, /^[0-9a-f]{64}$/);
    // Reopen the real file-backed SQLite store in another DO instance.
    ({ storage, queue } = startQueue(database));
    const persisted = JSON.parse(
      [
        ...storage.sql.exec(
          "SELECT record_json FROM command_proof_requests_v1 WHERE request_id = ?",
          id,
        ),
      ][0].record_json,
    );
    assert.equal(persisted.runId, lookupFailed ? undefined : "300");
    if (lookupFailed) {
      assert.equal(persisted.state, "inconclusive");
      const active = [
        ...storage.sql.exec(
          "SELECT count(*) AS count FROM command_proof_requests_v1 WHERE json_extract(record_json, '$.state') IN ('dispatch_claimed', 'review_pending')",
        ),
      ][0].count;
      assert.equal(active, 0);
    }
    await runCli(["request", input], base);
    assert.equal(dispatches, lookupFailed ? 0 : 1);
    comments.push({
      id: 500,
      issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/42",
      created_at: new Date().toISOString(),
      user: { login: "clawsweeper[bot]" },
      body:
        "<!-- clawsweeper-command-status:42:request_proof:" +
        id +
        " -->\n<!-- clawsweeper-command:200:" +
        f.live.comment.updated_at +
        ":request_proof:" +
        f.claim.headSha +
        " -->\nProof requested; not sufficient or ready.",
    });
    if (scenario === "fail") f = replaceReceipt(f, { ...f.receipt, assertion_outcome: "fail" });
    if (scenario === "candidate-only")
      f = replaceReceipt(f, {
        ...f.receipt,
        observations: f.receipt.observations.map((o) => ({
          ...o,
          authority: "candidate_reported",
        })),
      });
    if (scenario === "stale-head") f.live.pull.head.sha = "e".repeat(40);
    if (scenario === "cross-pr") f = replaceReceipt(f, { ...f.receipt, pull_request: 43 });
    if (scenario === "bad-digest") f.evidenceArtifact.digest = "sha256:" + "f".repeat(64);
    if (scenario === "missing-observation")
      f = replaceReceipt(f, { ...f.receipt, observations: f.receipt.observations.slice(1) });
    if (scenario === "infra")
      f = replaceReceipt(f, {
        ...f.receipt,
        evidence: null,
        observations: [],
        execution_outcome: "timed_out",
        assertion_outcome: "inconclusive",
        reason: "fixture infrastructure timeout",
      });
    if (scenario === "rerun-attempt") f.run.run_attempt = 2;
    await runCli(["reconcile"], base);
    let record = JSON.parse(
      [
        ...storage.sql.exec(
          "SELECT record_json FROM command_proof_requests_v1 WHERE request_id = ?",
          id,
        ),
      ][0].record_json,
    );
    const successfulEvidence =
      scenario === "pass" || scenario === "fail" || scenario === "enqueue-response-lost";
    assert.equal(
      record.state,
      queueRejected || scenario === "enqueue-response-lost"
        ? "review_pending"
        : successfulEvidence
          ? "completed"
          : "inconclusive",
      JSON.stringify(record),
    );
    assert.equal(queueEnqueues, successfulEvidence || queueRejected ? 1 : 0);
    if (successfulEvidence) {
      const item = JSON.parse(
        [...storage.sql.exec("SELECT item_json FROM exact_review_queue_items")][0].item_json,
      );
      assert.equal(item.decision.sourceAction, "command_proof_result");
      assert.equal(item.decision.sourceHeadSha, f.claim.headSha);
      assert.match(item.decision.additionalPrompt, /independent assessment still required/);
      assert.match(item.decision.additionalPrompt, /mocked Gateway ONLY/);
      assert.equal(
        item.decision.commandStatusMarker,
        "<!-- clawsweeper-command-status:42:request_proof:" + id + " -->",
      );
    }
    const second = await runCli(["reconcile"], base);
    const third = await runCli(["reconcile"], base);
    if (queueRejected) {
      assert.doesNotMatch(second + third, /independent_review_queued/);
    }
    assert.equal(dispatches, lookupFailed ? 0 : 1);
    assert.equal(
      queueEnqueues,
      scenario === "enqueue-response-lost" ? 2 : queueRejected ? 3 : successfulEvidence ? 1 : 0,
    );
    record = JSON.parse(
      [
        ...storage.sql.exec(
          "SELECT record_json FROM command_proof_requests_v1 WHERE request_id = ?",
          id,
        ),
      ][0].record_json,
    );
    assert.equal(
      record.state,
      queueRejected ? "review_pending" : successfulEvidence ? "completed" : "inconclusive",
    );
    assert.match(
      comments[0].body,
      successfulEvidence || queueRejected
        ? /Proof requested; not sufficient or ready/
        : /inconclusive/,
    );
    assert.ok(
      apiWrites.every(
        (write) =>
          write.endsWith("/dispatches") ||
          write === "PATCH /repos/openclaw/openclaw/issues/comments/500",
      ),
    );
    observations.push({
      scenario,
      state: record.state,
      producerDispatches: dispatches,
      independentReviews: [
        ...storage.sql.exec("SELECT count(*) AS count FROM exact_review_queue_items"),
      ][0].count,
      reviewEnqueueAttempts: queueEnqueues,
      reopenedSqliteClaim: true,
      statusOwnerUpdated: !successfulEvidence && !queueRejected,
      reviewStatusOwnerDelegated: successfulEvidence,
      reviewAdmissionBlocked: queueRejected,
    });
  }
  const bodySha256 = f.claim.bodySha256;
  const baseRefSha256 = digest(f.claim.targetBranch);
  const baseSha = f.claim.baseSha;
  let before =
    "---\nrepository: openclaw/openclaw\nnumber: 42\ntype: pull_request\npull_head_sha: " +
    "a".repeat(40) +
    "\nreviewed_body_sha256: " +
    bodySha256 +
    "\nreviewed_base_ref_sha256: " +
    baseRefSha256 +
    "\nreviewed_base_sha: " +
    baseSha +
    "\nreview_status: complete\nreviewed_at: 2026-09-01T00:00:00Z\nlast_full_review_at: 2026-09-01T00:00:00Z\nreal_behavior_proof_status: missing\nreal_behavior_proof_evidence_kind: none\nreal_behavior_proof_needs_contributor_action: true\nsecurity_status: blocked\nci_status: failure\n---\n## Real Behavior Proof\nStatus: missing\n\n## Findings\nCode blocker remains.\n";
  const metadata = createRecordMetadata({
    reviewLeaseRevisionFromReport: (markdown) =>
      metadata.frontMatterValue(markdown, "pull_head_sha") ?? null,
  });
  const fullReviewFreshness = {
    reviewed_at: "2026-09-01T00:00:00Z",
    item_updated_at: "2026-09-01T00:00:00Z",
    item_snapshot_hash: digest("full-review snapshot"),
    item_source_revision: digest("full-review source"),
    review_timeline_revision: digest("full-review timeline"),
    review_activity_cursor: "full-review-activity",
    review_content_digest: digest("full-review content"),
    reviewed_pull_state_digest: digest("full-review pull state"),
    review_structural_fingerprint: digest("full-review structural input"),
    review_structural_activity_updated_at: "2026-09-01T00:00:00Z",
  };
  for (const [key, value] of Object.entries(fullReviewFreshness)) {
    before = metadata.replaceFrontMatterValue(before, key, value);
  }
  before = metadata.replaceFrontMatterValue(before, "review_lease_owner", "prior-full-review");
  before = metadata.replaceFrontMatterValue(before, "review_lease_comment_id", "500");
  let assessed = before
    .replaceAll("missing", "sufficient")
    .replace("Code blocker remains.", "None")
    .replace("security_status: blocked", "security_status: none");
  for (const key of Object.keys(fullReviewFreshness)) {
    assessed = metadata.replaceFrontMatterValue(
      assessed,
      key,
      key.endsWith("_at") ? "2026-09-04T00:00:00Z" : "proof-only-" + key,
    );
  }
  assessed = metadata.replaceFrontMatterValue(
    assessed,
    "review_lease_owner",
    "current-proof-publication",
  );
  assessed = metadata.replaceFrontMatterValue(assessed, "review_lease_comment_id", "900");
  const folded = foldCommandProofAssessment(
    before,
    assessed,
    "d".repeat(64),
    bodySha256,
    baseRefSha256,
    baseSha,
  );
  for (const [key, value] of Object.entries(fullReviewFreshness)) {
    assert.equal(metadata.frontMatterValue(folded, key), value, key);
  }
  assert.equal(
    metadata.frontMatterValue(folded, "command_proof_assessed_at"),
    "2026-09-04T00:00:00Z",
  );
  assert.equal(
    metadata.frontMatterValue(folded, "review_lease_owner"),
    "current-proof-publication",
  );
  assert.equal(metadata.frontMatterValue(folded, "review_lease_comment_id"), "900");
  assert.deepEqual(metadata.exactEventReviewLeaseDisposition(folded, f.claim.headSha), {
    status: "current",
  });
  const changedBody = digest("same-head changed body");
  assert.throws(
    () =>
      foldCommandProofAssessment(
        before,
        assessed.replace(bodySha256, changedBody),
        "d".repeat(64),
        changedBody,
        baseRefSha256,
        baseSha,
      ),
    /full review bound to the claimed PR body/,
  );
  assert.throws(
    () =>
      foldCommandProofAssessment(
        before.replace("reviewed_body_sha256: " + bodySha256 + "\n", ""),
        assessed,
        "d".repeat(64),
        bodySha256,
        baseRefSha256,
        baseSha,
      ),
    /full review bound to the claimed PR body/,
  );
  assert.throws(
    () =>
      foldCommandProofAssessment(
        before.replace(baseRefSha256, digest("release")),
        assessed,
        "d".repeat(64),
        bodySha256,
        baseRefSha256,
        baseSha,
      ),
    /full review bound to the claimed PR base/,
  );
  assert.ok(folded.includes("reviewed_base_ref_sha256: " + baseRefSha256));
  assert.match(folded, /real_behavior_proof_status: sufficient/);
  assert.match(folded, /Code blocker remains/);
  assert.match(folded, /security_status: blocked/);
  assert.match(folded, /ci_status: failure/);
  console.log(
    JSON.stringify(
      {
        ok: true,
        runtime: "compiled CLI + real Worker HTTP routing + file-backed SQLite ExactReviewQueue",
        observations,
        codeSecurityCiPreserved: true,
        exceptionResponseSafety,
        limits:
          "GitHub metadata/artifact delivery and the independent model response are controlled fixtures. No live GitHub dispatch, Mantis UI run, semantic model accuracy, public-provider or channel claim. The production verifier, ZIP parser, durable store, queue enqueue, status owner, proof-only fold and exact-event lease tuple check are exercised. This is not end-to-end canonical publication, apply-time GitHub mutation or hosted-deployment proof.",
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  for (const item of opened) item.sql.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
function json(res, value) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
function runCli(args, base) {
  const child = spawn(
    process.execPath,
    [path.join(runtime, "dist/repair/command-proof-cli.js"), ...args],
    {
      cwd: runtime,
      timeout: 60000,
      env: {
        PATH: process.env.PATH,
        HOME: temporary,
        GH_BIN: gh,
        GH_TOKEN: "synthetic-loopback-only",
        QUEUE_URL: base,
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        NODE_OPTIONS: "--import=" + fetchShim,
        PROOF_FIXTURE_ENDPOINT: base,
        CLAWSWEEPER_PROOF_WORKFLOW_PATH: f.claim.workflowPath,
        CLAWSWEEPER_PROOF_WORKFLOW_REF: f.claim.workflowRef,
        CLAWSWEEPER_PROOF_WORKFLOW_SHA: f.claim.workflowSha,
        CLAWSWEEPER_PROOF_HARNESS_SHA: f.claim.harnessSha,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(scenario + ": " + stderr));
      else resolve(stdout);
    });
  });
}
function fixtureFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin === "https://api.github.com")
      return original(new URL(url.pathname + url.search, process.env.PROOF_FIXTURE_ENDPOINT), init);
    if (url.origin === new URL(process.env.PROOF_FIXTURE_ENDPOINT).origin)
      return original(input, init);
    throw new Error("external fixture request blocked");
  };
}
async function fixtureGh() {
  const fs = await import("node:fs");
  const args = process.argv.slice(2);
  if (args[0] !== "api") throw new Error("unsupported fixture gh command");
  const base = new URL(process.env.PROOF_FIXTURE_ENDPOINT),
    url = new URL(args[1], base);
  if (url.origin !== base.origin) throw new Error("external fixture request blocked");
  const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
  const body = args.includes("--input")
    ? fs.readFileSync(args[args.indexOf("--input") + 1], "utf8")
    : undefined;
  const res = await fetch(url, { method, body, redirect: "error" }),
    value = await res.json();
  if (!res.ok) {
    console.error("fixture gh HTTP " + res.status);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(args.includes("--slurp") ? [value] : value));
}
