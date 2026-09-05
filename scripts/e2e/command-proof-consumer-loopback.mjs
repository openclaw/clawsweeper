#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  worker,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
} from "../../test/dashboard-worker-harness.ts";
import {
  proofFixture,
  replaceReceipt,
  replaceProofEvidence,
  artifactMetadata,
} from "../../test/helpers/command-proof-fixtures.ts";
import {
  commandProofProfile,
  COMMAND_PROOF_SCENARIO,
  TELEGRAM_PROOF_SCENARIO,
} from "../../dist/command-proof-contract.js";
import { readProofZip } from "../../dist/repair/proof-zip.js";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: COMMAND_PROOF_SCENARIO },
    "producer-root": { type: "string" },
    "web-ui-observations": { type: "string" },
    "qa-observations": { type: "string" },
    "candidate-sha": { type: "string", default: "a".repeat(40) },
  },
});
const requestedScenario = values.scenario;
const candidateSha = values["candidate-sha"];
if (!/^[a-f0-9]{40}$/.test(candidateSha)) throw new Error("invalid_fixture_candidate_sha");
const producer = values["producer-root"]
  ? await import(
      pathToFileURL(
        path.resolve(values["producer-root"], "test/fixtures/mantis-request-producer.mts"),
      ).href
    )
  : null;
const proofProfile = commandProofProfile(requestedScenario);
if (!proofProfile) throw new Error("unsupported_loopback_profile");
const workflowFile = proofProfile.workflowPath.split("/").at(-1);

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
      url.pathname === p + "/actions/workflows/" + workflowFile + "/dispatches" &&
      req.method === "POST"
    ) {
      const payload = JSON.parse(raw);
      assert.equal(payload.ref, f.claim.workflowRef);
      assert.deepEqual(Object.keys(payload.inputs).sort(), [
        "candidate_ref",
        "pr_number",
        "request_id",
        ...(proofProfile.scenario !== COMMAND_PROOF_SCENARIO ? ["scenario"] : []),
      ]);
      if (proofProfile.scenario !== COMMAND_PROOF_SCENARIO)
        assert.equal(payload.inputs.scenario, proofProfile.scenario);
      assert.equal(req.headers["x-github-api-version"], "2026-03-10");
      dispatches++;
      const bound = proofFixture(
        payload.inputs.request_id,
        proofProfile.scenario,
        "pass",
        candidateSha,
      );
      f = {
        ...f,
        receipt: bound.receipt,
        receiptArchive: bound.receiptArchive,
        receiptArtifact: bound.receiptArtifact,
        evidenceArchive: bound.evidenceArchive,
        evidenceArtifact: bound.evidenceArtifact,
      };
      f.run.display_title = proofProfile.runName + " [" + payload.inputs.request_id + "]";
      // The negative QA result remains a declared consumer fixture when only
      // real passing observations are retained; never fabricate a producer run.
      if (
        producer &&
        !(proofProfile.scenario === "telegram-markdown-parser-fidelity" && scenario === "fail")
      ) {
        const identity = Object.fromEntries(
          [
            "request_id",
            "repository",
            "pull_request",
            "candidate_sha",
            "scenario",
            "workflow",
            "harness",
            "run",
          ].map((key) => [key, bound.receipt[key]]),
        );
        const generated = await producer.produceRequestFixture(
          identity,
          scenario === "fail" ? "fail" : "pass",
          proofProfile.scenario === "telegram-markdown-parser-fidelity"
            ? values["qa-observations"]
            : values["web-ui-observations"],
        );
        f = {
          ...f,
          receipt: generated.receipt,
          evidenceArchive: generated.evidenceArchive,
          evidenceArtifact: artifactMetadata(
            400,
            generated.receipt.evidence.artifact_name,
            generated.evidenceArchive,
            f.claim.workflowSha,
          ),
        };
        f = replaceReceipt(f, generated.receipt);
      }
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
    ...(proofProfile.scenario === TELEGRAM_PROOF_SCENARIO
      ? [
          "cross-scenario",
          "cross-workflow",
          "cross-observer-job",
          "cross-evidence-artifact",
          "cross-evidence-files",
          "malformed-observation",
          "uncorrelated-reply",
          "outcome-mismatch",
        ]
      : []),
  ]) {
    f = proofFixture(undefined, proofProfile.scenario, "pass", candidateSha);
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
        base + "/repos/openclaw/openclaw/actions/workflows/" + workflowFile + "/dispatches",
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
    if (
      scenario === "fail" &&
      (!producer || proofProfile.scenario === "telegram-markdown-parser-fidelity")
    ) {
      const failure = proofFixture(id, proofProfile.scenario, "fail", candidateSha);
      f = replaceProofEvidence(f, readProofZip(failure.evidenceArchive), "fail");
    }
    if (scenario === "cross-scenario")
      f = replaceReceipt(f, { ...f.receipt, scenario: COMMAND_PROOF_SCENARIO });
    if (scenario === "cross-workflow")
      f.run.path = commandProofProfile(COMMAND_PROOF_SCENARIO).workflowPath;
    if (scenario === "cross-observer-job")
      f.jobs.jobs[0].name = commandProofProfile(COMMAND_PROOF_SCENARIO).observerJob;
    if (scenario === "cross-evidence-artifact")
      f.evidenceArtifact.name = "mantis-request-web-ui-300-1";
    if (scenario === "cross-evidence-files") {
      const browser = [...readProofZip(proofFixture(id).evidenceArchive).values()];
      // Negative test: renaming browser bytes to Telegram filenames must not pass.
      f = replaceProofEvidence(
        f,
        new Map(proofProfile.observations.map(([, file], index) => [file, browser[index]])),
      );
    }
    if (scenario === "malformed-observation" || scenario === "uncorrelated-reply") {
      const files = readProofZip(f.evidenceArchive);
      const reply = JSON.parse(files.get("telegram-reply.json").toString("utf8"));
      if (scenario === "malformed-observation") reply.private_chat_id = "not-allowed";
      else reply.conversation_digest = "f".repeat(64);
      files.set("telegram-reply.json", Buffer.from(JSON.stringify(reply)));
      f = replaceProofEvidence(f, files);
    }
    if (scenario === "outcome-mismatch")
      f = replaceReceipt(f, { ...f.receipt, assertion_outcome: "fail" });
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
      queueRejected ? "review_pending" : successfulEvidence ? "completed" : "inconclusive",
      JSON.stringify(record),
    );
    assert.equal(queueEnqueues, successfulEvidence || queueRejected ? 1 : 0);
    if (successfulEvidence) {
      const expectedOutcome = scenario === "fail" ? "fail" : "pass";
      assert.equal(record.result.outcome, expectedOutcome, "persisted proof outcome");
      const item = JSON.parse(
        [...storage.sql.exec("SELECT item_json FROM exact_review_queue_items")][0].item_json,
      );
      assert.equal(item.decision.sourceAction, "command_proof_result");
      assert.equal(item.decision.sourceHeadSha, f.claim.headSha);
      const submittedEvidence = JSON.parse(item.decision.additionalPrompt.split("\n").at(-1));
      assert.equal(submittedEvidence.assertion_outcome, expectedOutcome, "submitted proof outcome");
      assert.match(item.decision.additionalPrompt, /independent assessment still required/);
      assert.ok(item.decision.additionalPrompt.includes(proofProfile.scopeNotice));
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
    assert.equal(queueEnqueues, queueRejected ? 3 : successfulEvidence ? 1 : 0);
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
      assertionOutcome: record.result?.outcome ?? null,
      evidenceSource:
        dispatches === 0
          ? "not-produced"
          : producer &&
              !(
                proofProfile.scenario === "telegram-markdown-parser-fidelity" && scenario === "fail"
              )
            ? "producer-finalizer"
            : "controlled-consumer-fixture",
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
  console.log(
    JSON.stringify(
      {
        ok: true,
        runtime: "compiled CLI + real Worker HTTP routing + file-backed SQLite ExactReviewQueue",
        scenarioProfile: proofProfile.scenario,
        producerContractExercised: Boolean(producer),
        observations,
        exceptionResponseSafety,
        limits:
          "GitHub metadata/artifact delivery and the independent model response are controlled fixtures. No live GitHub dispatch, Mantis UI run, semantic model accuracy, public-provider or channel claim. The production verifier, ZIP parser, durable store, queue enqueue, status owner and evidence-triggered full-review enqueue are exercised. This is not end-to-end canonical publication, apply-time GitHub mutation or hosted-deployment proof.",
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
        GH_BIN: process.execPath,
        GH_BIN_ARGS: JSON.stringify([gh]),
        GH_TOKEN: "synthetic-loopback-only",
        QUEUE_URL: base,
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        NODE_OPTIONS: "--import=" + pathToFileURL(fetchShim).href,
        PROOF_FIXTURE_ENDPOINT: base,
        [proofProfile.configPrefix + "_WORKFLOW_PATH"]: f.claim.workflowPath,
        [proofProfile.configPrefix + "_WORKFLOW_REF"]: f.claim.workflowRef,
        [proofProfile.configPrefix + "_WORKFLOW_SHA"]: f.claim.workflowSha,
        [proofProfile.configPrefix + "_HARNESS_SHA"]: f.claim.harnessSha,
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
