import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const outputDir = path.resolve(requiredEnv("CSW_1089_PROOF_OUTPUT"));
const workerOrigin = requiredLoopbackOrigin("CSW_1089_WORKER_ORIGIN", "http:");
const transportPort = positivePort(requiredEnv("CSW_1089_TRANSPORT_PORT"));
const tlsKeyPath = requiredEnv("CSW_1089_TLS_KEY");
const tlsCertPath = requiredEnv("CSW_1089_TLS_CERT");
const proofSecret = requiredEnv("CSW_1089_PROOF_SECRET");
const sourceSha = requiredEnv("SOURCE_SHA");
const sourceTreeSha = requiredEnv("SOURCE_TREE_SHA");
const transportOrigin = `https://127.0.0.1:${transportPort}`;
const cliPath = path.resolve("dist/repair/exact-review-batch-cli.js");

await mkdir(outputDir, { recursive: true });

const assertions = [];
const transportRequests = [];
const cliRuns = [];
const workerResponses = [];
let activeFixture = null;

function assertProof(name, condition, details = {}) {
  if (!condition) throw new Error(`proof failed: ${name}; ${JSON.stringify(details)}`);
  assertions.push({ name, ...details });
}

function jsonResponse(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const transportServer = createServer(
  {
    key: await readFile(tlsKeyPath),
    cert: await readFile(tlsCertPath),
  },
  async (request, response) => {
    try {
      if (!activeFixture) return jsonResponse(response, 503, { error: "fixture_not_ready" });
      const body = await requestBody(request);
      const signature = String(request.headers["x-clawsweeper-exact-review-signature"] || "");
      const expected = `sha256=${createHmac("sha256", proofSecret).update(body).digest("hex")}`;
      const signatureValid = signature === expected;
      const pathname = new URL(request.url || "/", transportOrigin).pathname;
      const event = {
        scenario: activeFixture.scenario,
        method: request.method,
        pathname,
        signature_valid: signatureValid,
        local_address: request.socket.localAddress,
        remote_address: request.socket.remoteAddress,
      };
      transportRequests.push(event);
      if (!signatureValid) return jsonResponse(response, 401, { error: "invalid_signature" });

      if (pathname.endsWith("/publication-batches/fetch")) {
        event.response_status = 200;
        return jsonResponse(response, 200, activeFixture.fetchResponse);
      }
      if (pathname.endsWith("/publication-batches/heartbeat")) {
        event.response_status = 200;
        return jsonResponse(response, 200, { batch: activeFixture.batch });
      }
      if (pathname.endsWith("/publication-batches/complete")) {
        activeFixture.completion = JSON.parse(body);
        event.response_status = 200;
        return jsonResponse(response, 200, {
          ok: true,
          accepted: 1,
          skipped: 0,
          batch: { ...activeFixture.batch, items: [] },
        });
      }
      if (pathname.endsWith("/publication-batch-results")) {
        activeFixture.publicationRequests += 1;
        if (activeFixture.scenario === "no-status") {
          event.connection_reset = true;
          request.socket.destroy();
          return;
        }
        const status = activeFixture.scenario === "429" ? 429 : 503;
        event.response_status = status;
        return jsonResponse(response, status, { error: `proof_http_${status}` });
      }
      event.response_status = 404;
      return jsonResponse(response, 404, { error: "not_found" });
    } catch (error) {
      if (!response.headersSent) {
        jsonResponse(response, 500, { error: "proof_listener_failure" });
      } else {
        response.destroy();
      }
      transportRequests.push({
        scenario: activeFixture?.scenario || "unknown",
        listener_error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

await new Promise((resolve, reject) => {
  transportServer.once("error", reject);
  transportServer.listen(transportPort, "127.0.0.1", resolve);
});

const transportResults = {};
try {
  for (const scenario of ["no-status", "429", "503"]) {
    transportResults[scenario] = await runTransportScenario(scenario);
  }
} finally {
  await new Promise((resolve) => transportServer.close(resolve));
}

const stateContentionMember = transportResults["429"].member;
const stateContentionCompletion = transportResults["429"].completion;
const stateContentionDecision = publicationDecision(
  stateContentionMember.decision.itemNumber,
  "1089010",
);

const stateEnqueue = await signedWorkerPost("/internal/exact-review/enqueue", {
  delivery_id: "csw-1089-state-contention-enqueue",
  decision: stateContentionDecision,
});
workerResponses.push({ operation: "state_contention_enqueue", ...stateEnqueue });
assertProof(
  "real Worker accepts the state-contention publication item",
  stateEnqueue.status === 202 && stateEnqueue.body.queued === true,
);

const stateClaim = await signedWorkerPost("/internal/exact-review/publication-batches/claim", {
  claim_id: stateContentionCompletion.batch_id,
  lease_owner: stateContentionCompletion.lease_owner,
  max_items: 1,
});
workerResponses.push({ operation: "state_contention_claim", ...stateClaim });
assertProof(
  "real Worker and DO claim the state-contention publication item",
  stateClaim.status === 200 && stateClaim.body.claimed === true,
  { response: stateClaim },
);
assertClaimMatchesCompletion(stateClaim.body, stateContentionCompletion);

const stateBefore = await queueItemStatus(stateContentionMember.decision.itemNumber);
await writeJson("queue-state-state-contention-before.json", stateBefore);
const stateComplete = await signedWorkerPost(
  "/internal/exact-review/publication-batches/complete",
  stateContentionCompletion,
);
workerResponses.push({ operation: "state_contention_complete", ...stateComplete });
assertProof(
  "real Worker and DO accept the captured state-contention tuple",
  stateComplete.status === 200 && stateComplete.body.accepted === 1,
);
const stateAfter = await queueItemStatus(stateContentionMember.decision.itemNumber);
await writeJson("queue-state-state-contention-after.json", stateAfter);
assertPendingRetry("state_contention", stateAfter);

const unknownItemNumber = 108904;
const unknownRunId = "1089040";
const unknownMember = memberFor(unknownItemNumber, unknownRunId);
const unknownBatchId = "csw-1089-unknown-attempt-1";
const unknownCompletion = {
  batch_id: unknownBatchId,
  lease_owner: "csw-1089-proof-worker",
  items: [
    {
      ...stateContentionCompletion.items[0],
      item_key: unknownMember.itemKey,
      revision: 1,
      claim_generation: 1,
      reason_code: "unknown_failure",
    },
  ],
};
await writeJson("completion-unknown-control.json", unknownCompletion);

const unknownEnqueue = await signedWorkerPost("/internal/exact-review/enqueue", {
  delivery_id: "csw-1089-unknown-enqueue",
  decision: publicationDecision(unknownItemNumber, unknownRunId),
});
workerResponses.push({ operation: "unknown_enqueue", ...unknownEnqueue });
assertProof(
  "real Worker accepts the unknown-failure control item",
  unknownEnqueue.status === 202 && unknownEnqueue.body.queued === true,
);
const unknownClaim = await signedWorkerPost("/internal/exact-review/publication-batches/claim", {
  claim_id: unknownBatchId,
  lease_owner: unknownCompletion.lease_owner,
  max_items: 1,
});
workerResponses.push({ operation: "unknown_claim", ...unknownClaim });
assertProof(
  "real Worker and DO claim the unknown-failure control item",
  unknownClaim.status === 200 && unknownClaim.body.claimed === true,
  { response: unknownClaim },
);
assertClaimMatchesCompletion(unknownClaim.body, unknownCompletion);
const unknownBefore = await queueItemStatus(unknownItemNumber);
await writeJson("queue-state-unknown-before.json", unknownBefore);
const unknownComplete = await signedWorkerPost(
  "/internal/exact-review/publication-batches/complete",
  unknownCompletion,
);
workerResponses.push({ operation: "unknown_complete", ...unknownComplete });
assertProof(
  "real Worker and DO accept the unknown-failure control tuple",
  unknownComplete.status === 200 && unknownComplete.body.accepted === 1,
);
const unknownAfter = await queueItemStatus(unknownItemNumber);
await writeJson("queue-state-unknown-after-attempt-1.json", unknownAfter);
assertPendingRetry("unknown_failure", unknownAfter);

const finalStats = await workerGet("/api/exact-review-queue");
assertProof("real queue status remains available", finalStats.status === 200);
await writeJson("queue-stats-final.json", finalStats.body);
await writeJson("worker-responses.json", workerResponses);
await writeJson("transport-requests.json", transportRequests);
await writeJson("cli-runs.json", cliRuns);

const summary = {
  proof: "PR 1089 real-boundary batch publication retry proof",
  source_sha: sourceSha,
  source_tree_sha256: sourceTreeSha,
  transport: {
    origin: `https://127.0.0.1:${transportPort}`,
    scenarios: Object.fromEntries(
      Object.entries(transportResults).map(([scenario, result]) => [
        scenario,
        {
          publication_requests: result.publicationRequests,
          terminal_outcome: result.completion.items[0].terminal_outcome,
          reason_code: result.completion.items[0].reason_code,
          completion_artifact: `completion-${scenario}.json`,
        },
      ]),
    ),
    signed_requests: transportRequests.length,
    invalid_signatures: transportRequests.filter((request) => request.signature_valid === false)
      .length,
  },
  worker_do: {
    origin: workerOrigin,
    state_contention_after: stateAfter,
    unknown_failure_attempt_1_after: unknownAfter,
    final_dead_letters_open: finalStats.body?.lanes?.publication?.dead_letters?.open ?? null,
  },
  assertions,
  limits: {
    attempted_old_budget_terminal: false,
    reason:
      "Authentic backoff requires roughly 51 minutes before attempt 14; no clock, retry constant, or Durable Object storage was altered.",
  },
  generated_at: new Date().toISOString(),
};
await writeJson("proof-summary.json", summary);

await writeFile(
  path.join(outputDir, "runtime-transcript.md"),
  `# PR 1089 real-boundary runtime transcript

- Source commit: \`${sourceSha}\`
- Source-tree SHA-256: \`${sourceTreeSha}\`
- CLI transport: built \`exact-review-batch-cli\` over a self-signed TLS listener bound only to \`127.0.0.1:${transportPort}\`.
- CLI observations: reset, HTTP 429, and HTTP 503 each produced \`retryable_failure\` / \`state_contention\` after ${transportResults["429"].publicationRequests} actual publication requests per scenario.
- Worker/DO: pinned Wrangler Worker on \`${workerOrigin}\`, disposable local persistence, signed enqueue/claim/complete requests, and public status reads.
- Secrets: one disposable local proof secret; request traces retain only \`signature_valid\`, never a signature or secret value.

## State contention after one real completion

\`\`\`json
${JSON.stringify(stateAfter, null, 2)}
\`\`\`

## Unknown failure after one real completion

\`\`\`json
${JSON.stringify(unknownAfter, null, 2)}
\`\`\`

## Limit

The real unknown-failure item is pending after attempt 1, as expected. Reaching attempt 14 requires roughly 51 minutes of authentic backoff. This run did not fake time, edit Durable Object state, or change retry constants, so it does not claim the final \`retry_exhausted\` dead letter or the same-attempt terminal contrast.
`,
  "utf8",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      assertions: assertions.length,
      output_dir: outputDir,
      state_contention: stateAfter,
      unknown_failure_attempt_1: unknownAfter,
    },
    null,
    2,
  ),
);

async function runTransportScenario(scenario) {
  const itemNumber = scenario === "429" ? 108901 : scenario === "503" ? 108903 : 108902;
  const runId = `${itemNumber}0`;
  const member = memberFor(itemNumber, runId);
  const batchId = `csw-1089-${scenario}`;
  const leaseOwner = "csw-1089-proof-worker";
  const root = await mkdtemp(path.join(tmpdir(), `csw-1089-${scenario}-`));
  try {
    const outcomePath = path.join(root, "eligible.json");
    const manifestPath = path.join(root, "manifest.json");
    const receiptPath = path.join(root, "receipt.json");
    await writeFile(
      outcomePath,
      `${JSON.stringify({
        kind: "eligible",
        plan: mutationPlan(member),
        postEffectsComplete: true,
      })}\n`,
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          batchId,
          leaseOwner,
          configuredBatchSize: 1,
          batchWaitMs: 0,
          items: [{ ...member, outcomePath }],
        },
        null,
        2,
      )}\n`,
    );
    const wireItem = {
      item_key: member.itemKey,
      revision: member.revision,
      claim_generation: member.claimGeneration,
      decision: member.decision,
    };
    const batch = {
      batch_id: batchId,
      lease_owner: leaseOwner,
      lease_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      items: [wireItem],
    };
    activeFixture = {
      scenario,
      batch,
      fetchResponse: { ok: true, batch, items: [wireItem], superseded: 0 },
      publicationRequests: 0,
      completion: null,
    };
    const childEnv = {
      ...process.env,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NODE_NO_WARNINGS: "1",
      CLAWSWEEPER_WEBHOOK_SECRET: proofSecret,
      EXACT_REVIEW_QUEUE_URL: transportOrigin,
      EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
      EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
    };
    cliRuns.push(await runCli(scenario, "commit", childEnv));
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    cliRuns.push(await runCli(scenario, "complete", childEnv));
    const completion = activeFixture.completion;
    assertProof(
      `${scenario} CLI completion is state contention`,
      completion?.items?.length === 1 &&
        completion.items[0].terminal_outcome === "retryable_failure" &&
        completion.items[0].reason_code === "state_contention",
      { publication_requests: activeFixture.publicationRequests },
    );
    assertProof(
      `${scenario} traverses the built-in three-attempt transport path`,
      activeFixture.publicationRequests === 3,
    );
    await writeJson(`publication-receipt-${scenario}.json`, receipt);
    await writeJson(`completion-${scenario}.json`, completion);
    return {
      member,
      receipt,
      completion,
      publicationRequests: activeFixture.publicationRequests,
    };
  } finally {
    activeFixture = null;
    await rm(root, { recursive: true, force: true });
  }
}

function runCli(scenario, command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, command], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = {
        scenario,
        command,
        exit_code: code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
      if (code !== 0) {
        reject(new Error(`CLI ${scenario}/${command} failed: ${JSON.stringify(result)}`));
        return;
      }
      resolve(result);
    });
  });
}

function memberFor(itemNumber, runId) {
  return {
    itemKey: `openclaw/openclaw#${itemNumber}@publish:${runId}:1`,
    revision: 1,
    claimGeneration: 1,
    decision: { targetRepo: "openclaw/openclaw", itemNumber },
  };
}

function mutationPlan(member) {
  return {
    identity: {
      itemKey: member.itemKey,
      revision: member.revision,
      claimGeneration: member.claimGeneration,
    },
    publication: {
      canonicalTargetKey: `openclaw/openclaw#${member.decision.itemNumber}`,
      fenceKey: member.itemKey,
    },
    operations: [
      {
        path: `records/openclaw-openclaw/items/${member.decision.itemNumber}.md`,
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
  };
}

function publicationDecision(itemNumber, producerRunId) {
  const producerDecision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  };
  return {
    ...producerDecision,
    sourceAction: "exact_review_artifact_publish",
    publication: {
      artifactName: `exact-review-${producerRunId}-1`,
      producerRunId,
      producerRunAttempt: 1,
      sourceSha: "a".repeat(40),
      itemKey: `openclaw/openclaw#${itemNumber}`,
      protocolVersion: 2,
      leaseRevision: 1,
      claimGeneration: 1,
      liveProceeded: true,
      liveTerminalNoop: false,
      liveTerminalMissing: false,
      liveGuardedOpen: false,
      producerDecision,
    },
  };
}

async function signedWorkerPost(pathname, payload) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", proofSecret).update(body).digest("hex")}`;
  const response = await fetch(`${workerOrigin}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({ error: "invalid_json" })),
  };
}

async function workerGet(pathname) {
  const response = await fetch(`${workerOrigin}${pathname}`);
  return {
    status: response.status,
    body: await response.json().catch(() => ({ error: "invalid_json" })),
  };
}

async function queueItemStatus(itemNumber) {
  const result = await workerGet(
    `/api/exact-review-queue/item?target_repo=openclaw%2Fopenclaw&item_number=${itemNumber}`,
  );
  assertProof(`queue item status ${itemNumber} is available`, result.status === 200);
  return result.body;
}

function assertClaimMatchesCompletion(claimBody, completion) {
  const claimed = claimBody?.batch?.items?.[0];
  const tuple = completion?.items?.[0];
  assertProof(
    `claimed tuple matches ${tuple?.item_key || "completion"}`,
    claimed?.item_key === tuple?.item_key &&
      claimed?.revision === tuple?.revision &&
      claimed?.claim_generation === tuple?.claim_generation,
  );
}

function assertPendingRetry(reason, status) {
  const item = status?.items?.[0];
  const nextAttemptAt = Date.parse(String(item?.next_attempt_at || ""));
  assertProof(
    `${reason} is pending with one scheduled retry and no dead letter`,
    status?.items?.length === 1 &&
      item?.state === "pending" &&
      item?.attempts === 1 &&
      Number.isFinite(nextAttemptAt) &&
      nextAttemptAt > Date.now() &&
      Array.isArray(status?.dead_letters) &&
      status.dead_letters.length === 0,
    { next_attempt_at: item?.next_attempt_at ?? null },
  );
}

async function writeJson(filename, value) {
  await writeFile(path.join(outputDir, filename), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredLoopbackOrigin(name, protocol) {
  const value = requiredEnv(name);
  const url = new URL(value);
  if (url.protocol !== protocol || url.hostname !== "127.0.0.1") {
    throw new Error(`${name} must use ${protocol}//127.0.0.1`);
  }
  return url.origin;
}

function positivePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("CSW_1089_TRANSPORT_PORT is invalid");
  }
  return port;
}
