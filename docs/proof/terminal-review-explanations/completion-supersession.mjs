import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import {
  ExactReviewQueue,
  MemoryDurableStorage,
  leasedExactReviewQueueItem,
  buildExactReviewQueueRequest,
} from "../../../test/dashboard-worker-harness.ts";

const root = resolve(import.meta.dirname, "../../..");
const evaluate = (template, values) =>
  Function(
    "return (" +
      template
        .replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "")
        .replace(/\balways\(\)/g, "true")
        .replace(/\bcancelled\(\)/g, "false")
        .replace(/\bvars\.([A-Z0-9_]+)/g, (_match, key) =>
          JSON.stringify(values["vars." + key] ?? ""),
        )
        .replace(
          /steps\.([a-z0-9-]+)\.(outputs\.([a-z0-9_]+)|outcome)/g,
          (_match, id, access, output) =>
            JSON.stringify(values[id + "." + (output ?? access)] ?? ""),
        ) +
      ");",
  )();
const readOutputs = (path) =>
  Object.fromEntries(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );

async function shell(source, env) {
  const child = spawn("bash", ["-c", source], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-8192);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function proveCompletionSupersession(
  workflowSource = readFileSync(join(root, ".github/workflows/sweep.yml"), "utf8"),
) {
  const steps = parse(workflowSource).jobs["event-review-apply"].steps;
  const find = (name) => {
    const step = steps.find((candidate) => candidate.name === name);
    assert.ok(step, name);
    return step;
  };
  const fence = find("Fence automatic review completion");
  const release = find("Release automatic review completion fence");
  const generation = find("Export exact review generation result");
  const failure = find("Fail unsuccessful exact review generation");
  const artifact = find("Create exact review artifact bundle");
  const item = leasedExactReviewQueueItem(846, "9846");
  Object.assign(item.decision, {
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
    sourceHeadSha: "a".repeat(40),
    sourceHeadVerified: true,
    sourceAuthoritySeq: 1,
    sourceUpdatedAt: "2026-09-04T00:00:00.000Z",
  });
  item.leaseDecision = { ...item.decision };
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const calls = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/internal/exact-review/heartbeat");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length < 16_384);
      }
      const payload = JSON.parse(body);
      const reply = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/heartbeat", { method: "POST", body }),
      );
      const text = await reply.text();
      calls.push({ phase: payload.phase, status: reply.status, body: JSON.parse(text) });
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(text);
    } catch {
      response.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify({ error: "proof_bridge_failed" }));
    }
  });
  const artifacts = join(root, ".artifacts/terminal-review-explanations");
  mkdirSync(artifacts, { recursive: true });
  const scratch = mkdtempSync(join(artifacts, "completion-handoff-"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const rejected = await new Promise((resolve, reject) => {
      const request = httpRequest(
        "http://127.0.0.1:" + server.address().port + "/internal/exact-review/heartbeat",
        { method: "POST", agent: false, headers: { "content-type": "application/json" } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.once("error", reject);
          response.once("aborted", () => reject(new Error("proof rejection probe aborted")));
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, headers: response.headers, body }),
          );
        },
      );
      request.on("error", reject);
      request.setTimeout(5000, () => request.destroy(new Error("proof rejection probe timed out")));
      request.end("<proof-bridge-input>");
    });
    assert.equal(rejected.status, 500);
    assert.equal(rejected.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(rejected.headers["x-content-type-options"], "nosniff");
    assert.equal(rejected.body, JSON.stringify({ error: "proof_bridge_failed" }));
    const output = join(scratch, "github-output");
    const env = {
      PATH: dirname(process.execPath) + ":/usr/local/bin:/usr/bin:/bin",
      HOME: scratch,
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: item.claimedRunId,
      GITHUB_RUN_ATTEMPT: "1",
      QUEUE_URL: "http://127.0.0.1:" + server.address().port,
      EXACT_REVIEW_ITEM_KEY: item.key,
      EXACT_REVIEW_LEASE_ID: item.leaseId,
      EXACT_REVIEW_LEASE_REVISION: "1",
      EXACT_REVIEW_CLAIM_GENERATION: "1",
      EXACT_REVIEW_SOURCE_HEAD_SHA: "a".repeat(40),
      REVIEW_ACKNOWLEDGEMENT_COMMENT_ID: "8846",
    };
    writeFileSync(output, "");
    const held = await shell(fence.run, env);
    assert.equal(held.code, 0, held.stderr);
    assert.equal(readOutputs(output).authorized, "true");
    const newer = await queue.fetch(
      buildExactReviewQueueRequest(
        "completion-proof-newer",
        846,
        "synchronize",
        "pull_request",
        "openclaw/openclaw",
        {
          sourceHeadSha: "b".repeat(40),
          sourceHeadVerified: true,
          sourceAuthoritySeq: 2,
          sourceUpdatedAt: "2026-09-04T00:01:00.000Z",
        },
      ),
    );
    assert.equal(newer.status, 202);
    const beforeRelease = (await storage.get("exact-review-queue")).items[item.key];
    assert.equal(beforeRelease.leasePhase, "status");
    assert.equal(beforeRelease.leaseId, item.leaseId);
    writeFileSync(output, "");
    const released = await shell(release.run, env);
    assert.equal(
      released.code,
      0,
      "expected a successful superseded no-op: " +
        released.stderr +
        "; queue=" +
        JSON.stringify(calls),
    );
    const releasedOutputs = readOutputs(output);
    assert.equal(releasedOutputs.superseded, "true");
    assert.deepEqual(
      calls.map((call) => [call.phase, call.status]),
      [
        ["status", 200],
        ["finalizing", 409],
      ],
    );
    assert.equal(calls[1].body.error, "lease_superseded");
    const current = (await storage.get("exact-review-queue")).items[item.key];
    assert.equal(current.state, "pending");
    assert.equal(current.revision, 2);
    assert.equal(current.decision.sourceHeadSha, "b".repeat(40));
    assert.equal(current.leaseId, undefined);
    const values = {
      "claim-exact-review-queue.claimed": "true",
      "target.target_enabled": "true",
      "target.target_repo": "openclaw/openclaw",
      "live-item.outcome": "success",
      "live-item.proceed": "true",
      "setup-pnpm.outcome": "success",
      "reserve-exact-review-lease.status": "posted",
      "review-exact-event-item.outcome": "success",
      "review-exact-event-item.exit_code": "0",
      "review-exact-event-item.superseded": "false",
      "complete-exact-review-queue.outcome": "failure",
      [release.id + ".superseded"]: "true",
    };
    assert.equal(
      evaluate(artifact.if, { ...values, [release.id + ".superseded"]: "false" }),
      true,
      "an unsuperseded successful review remains eligible for artifact creation",
    );
    const blocked = [];
    for (const id of [
      artifact.id,
      "direct-setup-state",
      "direct-github-egress-observer",
      "prepare-direct-exact-review-publication",
      "direct-exact-review-publication",
      "finalize-direct-exact-review-lifecycle",
      "upload-exact-review-bundle",
      "queue-exact-review-publication",
    ]) {
      const step = steps.find((candidate) => candidate.id === id);
      assert.ok(step, id);
      assert.equal(
        evaluate(step.if, values),
        false,
        id + " must not run after completion supersession",
      );
      values[id + ".outcome"] = "skipped";
      blocked.push(id);
    }
    writeFileSync(output, "");
    const generated = spawnSync("bash", ["-c", generation.run], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...env,
        ...Object.fromEntries(
          Object.entries(generation.env).map(([key, value]) => [
            key,
            String(evaluate(value, values)),
          ]),
        ),
      },
    });
    assert.equal(generated.status, 0, generated.stderr);
    const generationOutputs = readOutputs(output);
    assert.equal(generationOutputs.outcome, "success");
    assert.equal(generationOutputs.requeue_latest, "false");
    values["exact-review-generation-result.outcome"] = generationOutputs.outcome;
    assert.equal(evaluate(failure.if, values), false);
    return {
      error_response_sanitized: true,
      status_fence: 200,
      newer_source_accepted: 202,
      release_status: 409,
      release_reason: calls[1].body.error,
      superseded: true,
      blocked_steps: blocked,
      generation_outcome: generationOutputs.outcome,
      requeue_latest: false,
      new_revision: current.revision,
      new_revision_state: current.state,
      transport: "actual workflow Bash/curl over loopback HTTP to production ExactReviewQueue",
    };
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(
    JSON.stringify(
      await proveCompletionSupersession(
        process.argv[2] ? readFileSync(process.argv[2], "utf8") : undefined,
      ),
    ),
  );
}
