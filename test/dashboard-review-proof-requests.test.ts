import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { executeReviewProof } from "../dashboard/review-proof-execution.ts";
import { proofFixture } from "./helpers/command-proof-fixtures.ts";
import { requestReviewProof } from "../dist/review-proof-client.js";
import { REVIEW_PROOF_PRODUCER_ENDPOINT } from "../dashboard/review-proof-producer-auth.ts";
import { stableJson } from "../src/stable-json.ts";
import {
  assert,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  leasedExactReviewQueueItem,
  worker,
} from "./dashboard-worker-harness.ts";
import { publicExactReviewQueueProjection } from "../dashboard/worker.ts";
import {
  exactReviewDecisionFrom,
  exactReviewEditedSemanticInput,
} from "../dashboard/exact-review-decision.ts";
import type { InlineProofScenario } from "../src/repair/direct-re-review-admission.ts";

async function fixture(allowed?: InlineProofScenario[]) {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(42, "123");
  Object.assign(item.decision, {
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceHeadSha: "a".repeat(40),
    ...(allowed === undefined ? {} : { proofAllowedScenarios: allowed }),
  });
  Object.assign(item.leaseDecision, item.decision);
  Object.assign(item, { leasePhase: "review" });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const lease = {
    itemKey: item.key,
    leaseId: item.leaseId,
    leaseRevision: item.leaseRevision,
    claimGeneration: item.claimGeneration,
    runId: item.claimedRunId,
    runAttempt: item.claimedRunAttempt,
    sourceHeadSha: "a".repeat(40),
  };
  const plan = (text = "test") => {
    const proofPlan = {
      claim: text,
      actions: [{ type: "send", atMs: 0, text }],
      modelReplies: ["reply"],
      settings: { streaming: "off", nativeCommands: false },
      maxDurationMs: 1000,
      expectations: ["reply"],
    };
    return {
      lease,
      operation: "request",
      scenario: "telegram-bot-e2e-proof",
      proofPlan,
      planSha256: createHash("sha256").update(stableJson(proofPlan)).digest("hex"),
    };
  };
  const post = async (body: unknown, route = "/review-proof", instance = queue) => {
    const response = await instance.fetch(
      new Request("https://queue" + route, { method: "POST", body: JSON.stringify(body) }),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  return { storage, queue, lease, plan, post };
}

test("producer HTTP authenticates before queue access and preserves durable pin and owner fences", async (t) => {
  const f = await fixture();
  const requestId = (await f.post(f.plan())).body.record.requestId;
  const producer = {
    repositoryId: "123",
    workflowPath: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    workflowSha: "c".repeat(40),
    harnessSha: "c".repeat(40),
    workflowRef: "main",
    bodySha256: "d".repeat(64),
    baseSha: "e".repeat(40),
    targetBranch: "main",
  };
  assert.equal(
    (
      await f.post(
        { lease: f.lease, requestId, operation: "prepared", producer },
        "/review-proof/update",
      )
    ).status,
    200,
  );
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const forgedKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: REVIEW_PROOF_PRODUCER_ENDPOINT,
    repository: "openclaw/openclaw",
    repository_id: "123",
    event_name: "workflow_dispatch",
    ref: "refs/heads/main",
    sha: producer.workflowSha,
    workflow_sha: producer.workflowSha,
    workflow_ref: `openclaw/openclaw/${producer.workflowPath}@refs/heads/main`,
    run_id: "300",
    run_attempt: "1",
    iat: now,
    nbf: now,
    exp: now + 300,
  };
  const token = (overrides = {}, key = keys.privateKey) => {
    const data = [
      { alg: "RS256", kid: "fixture" },
      { ...claims, ...overrides },
    ]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    return data + "." + sign("RSA-SHA256", Buffer.from(data), key).toString("base64url");
  };
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "https://token.actions.githubusercontent.com/.well-known/jwks")
      return Response.json({
        keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256" }],
      });
    return nativeFetch(input, init);
  });
  const calls: string[] = [];
  let revoke = false;
  const env = {
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
      fetch: async (request: Request) => {
        const route = new URL(request.url).pathname;
        calls.push(route);
        const response = await f.queue.fetch(request);
        if (revoke && route === "/review-proof/producer-record") {
          const state = (f.queue as any).readStateSync();
          state.items[f.lease.itemKey].state = "queued";
          await (f.queue as any).writeState(state);
        }
        return response;
      },
    } as any),
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const reply = await worker.fetch(
        new Request(REVIEW_PROOF_PRODUCER_ENDPOINT, {
          method: "POST",
          headers: request.headers as Record<string, string>,
          body: Buffer.concat(chunks),
        }),
        env,
        {},
      );
      response.writeHead(reply.status);
      response.end(await reply.text());
    } catch {
      response.writeHead(500);
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const send = async (bearer: string) =>
    nativeFetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
      method: "POST",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      body: JSON.stringify({
        requestId,
        runId: "300",
        runAttempt: 1,
        planSha256: f.plan().planSha256,
      }),
    });
  try {
    for (const bearer of [
      "",
      "malformed",
      token({}, forgedKey),
      token({ repository: "other/repo" }),
      token({ run_id: "301" }),
      token({ workflow_ref: "openclaw/openclaw/.github/workflows/other.yml@refs/heads/main" }),
    ]) {
      calls.length = 0;
      assert.equal((await send(bearer)).status, 403);
      assert.deepEqual(calls, []);
    }
    const accepted = await send(token());
    assert.equal(accepted.status, 200);
    assert.equal(((await accepted.json()) as any).ok, true);
    assert.deepEqual(calls, ["/review-proof/producer-record", "/review-proof/redeem"]);
    const state = (f.queue as any).readStateSync();
    state.items[f.lease.itemKey].reviewProofRequests[0].producer.workflowSha = "b".repeat(40);
    await (f.queue as any).writeState(state);
    calls.length = 0;
    assert.equal((await send(token())).status, 403);
    assert.deepEqual(calls, ["/review-proof/producer-record"]);
    state.items[f.lease.itemKey].reviewProofRequests[0].producer.workflowSha = producer.workflowSha;
    await (f.queue as any).writeState(state);
    revoke = true;
    calls.length = 0;
    assert.equal((await send(token())).status, 409);
    assert.deepEqual(calls, ["/review-proof/producer-record", "/review-proof/redeem"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const change of [
  "active",
  "revoked",
  "reassigned",
  "scope_revoked",
  "expired",
  "max_result",
] as const) {
  test(
    `cached proof HTTP delivery fences owner changed during verification (${change})`,
    { timeout: 10_000 },
    async () => {
      const f = await fixture();
      const admitted = await f.post(f.plan());
      const evidence = proofFixture(admitted.body.record.requestId, "telegram-bot-e2e-proof");
      const result = {
        observations: { private: "synthetic cached observation" },
        limits: [] as string[],
      };
      if (change === "max_result") {
        result.observations.private = "x".repeat(192 * 1024 - 100);
        result.limits = Array(16).fill("x");
        let remaining = 256 * 1024 - Buffer.byteLength(JSON.stringify(result));
        for (let index = 0; remaining > 0; index++) {
          assert.ok(index < 16);
          const bytes = Math.min(6138, remaining);
          result.limits[index] += "€".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
          assert.ok(result.limits[index]!.length <= 2048);
          remaining -= bytes;
        }
        assert.equal(Buffer.byteLength(JSON.stringify(result)), 256 * 1024);
      }
      const state = (f.queue as any).readStateSync();
      const stored = state.items[f.lease.itemKey].reviewProofRequests[0];
      Object.assign(stored, {
        state: "pending",
        runId: "300",
        result,
        producer: {
          workflowSha: evidence.claim.workflowSha,
          harnessSha: evidence.claim.harnessSha,
          workflowPath: evidence.claim.workflowPath,
          workflowRef: "main",
          repositoryId: "123",
          bodySha256: evidence.claim.bodySha256,
          baseSha: evidence.claim.baseSha,
          targetBranch: "main",
        },
      });
      await (f.queue as any).writeState(state);
      assert.equal(
        (
          await f.post(
            { lease: f.lease, requestId: stored.requestId, state: "completed", result },
            "/review-proof/update",
          )
        ).status,
        200,
      );
      let verificationReached!: () => void;
      let resumeVerification!: () => void;
      const reached = new Promise<void>((resolve) => {
        verificationReached = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        resumeVerification = resolve;
      });
      let confirmations = 0;
      const server = createServer(async (request, response) => {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          if (request.url === "/cached") {
            const admission = await f.post({ ...f.plan(), operation: "poll" });
            assert.equal(admission.status, 200);
            const output = await executeReviewProof({
              ...admission.body,
              github: async (path) =>
                (await fetch(`${origin}/github?path=${encodeURIComponent(path)}`)).json(),
              artifact: async () => {
                throw new Error("cached result must not download artifacts");
              },
              update: async (patch) =>
                (
                  await fetch(`${origin}/update`, {
                    method: "POST",
                    body: JSON.stringify({ lease: f.lease, requestId: stored.requestId, ...patch }),
                  })
                ).json(),
            });
            response.end(
              JSON.stringify({
                ...output,
                requestId: stored.requestId,
                planSha256: stored.planSha256,
                expiresAt: stored.expiresAt,
              }),
            );
          } else if (request.url === "/update") {
            confirmations++;
            const reply = await f.post(
              JSON.parse(Buffer.concat(chunks).toString()),
              "/review-proof/update",
            );
            response.writeHead(reply.status);
            response.end(JSON.stringify(reply.body));
          } else {
            const path = new URL(request.url!, origin).searchParams.get("path")!;
            if (path.endsWith("/actions/runs/300")) {
              verificationReached();
              await resumed;
              response.end(JSON.stringify(evidence.run));
            } else {
              response.end(
                JSON.stringify({
                  ...evidence.live.pull,
                  base: { ...evidence.live.pull.base, repo: evidence.live.repository },
                }),
              );
            }
          }
        } catch {
          response.writeHead(500);
          response.end("{}");
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        const delivery = (
          change === "max_result"
            ? requestReviewProof(
                { queueUrl: origin, lease: f.lease, allowedScenarios: ["telegram-bot-e2e-proof"] },
                f.plan().proofPlan,
                new AbortController().signal,
                async () => fetch(`${origin}/cached`),
              )
            : fetch(`${origin}/cached`).then((response) => response.json())
        ) as Promise<any>;
        await reached;
        const current = (f.queue as any).readStateSync();
        const item = current.items[f.lease.itemKey];
        if (change === "revoked") item.state = "queued";
        if (change === "reassigned") {
          item.leaseId = "replacement-owner";
          item.claimGeneration++;
        }
        if (change === "scope_revoked") item.leaseDecision.proofAllowedScenarios = [];
        if (change === "expired") item.reviewProofRequests[0].expiresAt = Date.now() - 1;
        await (f.queue as any).writeState(current);
        resumeVerification();
        const output = await delivery;
        const allowed = change === "active" || change === "max_result";
        assert.equal(output.state, allowed ? "completed" : "inconclusive");
        assert.deepEqual(output.result, allowed ? result : undefined);
        assert.equal(confirmations, 1);
        assert.deepEqual(
          (f.queue as any).readStateSync().items[f.lease.itemKey].reviewProofRequests[0].result,
          result,
        );
      } finally {
        resumeVerification();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
}

test("capabilities expose only the active lease allowlist without tokens or budget", async () => {
  for (const allowed of [undefined, [], ["web-ui-chat-proof"], ["telegram-bot-e2e-proof"]] as (
    | InlineProofScenario[]
    | undefined
  )[]) {
    const f = await fixture(allowed);
    const body = { operation: "capabilities", lease: f.lease };
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/proof", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(f.queue) },
      {},
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      allowedScenarios: allowed ?? ["web-ui-chat-proof", "telegram-bot-e2e-proof"],
    });
    assert.equal(
      (f.queue as any).readStateSync().items[f.lease.itemKey].reviewProofRequests,
      undefined,
    );
    for (const [key, value] of Object.entries({
      leaseId: "wrong",
      leaseRevision: 2,
      claimGeneration: 2,
      runId: "456",
      runAttempt: 2,
      sourceHeadSha: "b".repeat(40),
    }))
      assert.equal(
        (await f.post({ ...body, lease: { ...f.lease, [key]: value } })).status,
        409,
        key,
      );
    assert.equal((await f.post({ ...body, scenario: "web-ui-chat-proof" })).status, 400);
    if (allowed && !allowed.includes("telegram-bot-e2e-proof")) {
      assert.equal((await f.post(f.plan())).status, 403);
      assert.equal((await f.post({ ...f.plan(), operation: "poll" })).status, 403);
    }
  }
});

test("decision parsing preserves empty scope and rejects widening malformed scopes", async () => {
  const f = await fixture();
  await f.post({ operation: "capabilities", lease: f.lease });
  const decision = (f.queue as any).readStateSync().items[f.lease.itemKey].decision;
  assert.deepEqual(
    exactReviewDecisionFrom({ ...decision, proofAllowedScenarios: [] })?.proofAllowedScenarios,
    [],
  );
  for (const value of [
    null,
    "auto",
    ["unknown"],
    ["web-ui-chat-proof", "web-ui-chat-proof"],
    ["web-ui-chat-proof", "telegram-bot-e2e-proof", "unknown"],
  ])
    assert.equal(exactReviewDecisionFrom({ ...decision, proofAllowedScenarios: value }), null);
  const edited = {
    ...decision,
    sourceAction: "edited",
    sourceBaseSha: "b".repeat(40),
    sourceIsDraft: false,
    sourceContentRevision: "c".repeat(64),
  };
  const unrestricted = await exactReviewEditedSemanticInput(edited);
  const restricted = await exactReviewEditedSemanticInput({ ...edited, proofAllowedScenarios: [] });
  assert.ok(unrestricted && restricted);
  assert.notEqual(unrestricted.fingerprint, restricted.fingerprint);
});

test("scope restriction fences existing polls, updates and producer redemption", async () => {
  const f = await fixture();
  const admitted = await f.post(f.plan());
  const requestId = admitted.body.record.requestId;
  const state = (f.queue as any).readStateSync();
  const item = state.items[f.lease.itemKey];
  item.reviewProofRequests[0].producer = {
    workflowSha: "b".repeat(40),
    harnessSha: "b".repeat(40),
    workflowPath: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    workflowRef: "main",
    repositoryId: "123",
    bodySha256: "c".repeat(64),
    baseSha: "d".repeat(40),
    targetBranch: "main",
  };
  item.leaseDecision.proofAllowedScenarios = [];
  item.decision.proofAllowedScenarios = [];
  await (f.queue as any).writeState(state);
  assert.equal((await f.post({ ...f.plan(), operation: "poll" })).status, 403);
  assert.equal(
    (
      await f.post(
        { lease: f.lease, requestId, state: "inconclusive", reason: "test" },
        "/review-proof/update",
      )
    ).status,
    403,
  );
  for (const route of ["/review-proof/producer-record", "/review-proof/redeem"])
    assert.equal(
      (
        await f.post(
          { requestId, runId: "987", runAttempt: 1, planSha256: f.plan().planSha256 },
          route,
        )
      ).status,
      409,
    );
  item.leaseDecision.proofAllowedScenarios = ["telegram-bot-e2e-proof"];
  item.revision = f.lease.leaseRevision + 1;
  await (f.queue as any).writeState(state);
  assert.equal((await f.post({ operation: "capabilities", lease: f.lease })).status, 409);
});

test("review proof is durable, plan-bound, at-most-once and limited to three plans", async () => {
  const f = await fixture();
  const first = await f.post(f.plan());
  assert.equal(first.status, 200);
  assert.equal(first.body.dispatch, true);
  const restarted = new ExactReviewQueue({ storage: f.storage }, {});
  const second = await f.post(f.plan(), "/review-proof", restarted);
  assert.equal(second.body.dispatch, false);
  assert.equal(second.body.record.requestId, first.body.record.requestId);
  assert.equal((await f.post(f.plan("two"))).body.dispatch, true);
  assert.equal((await f.post(f.plan("three"))).body.dispatch, true);
  assert.equal((await f.post(f.plan("four"))).body.error, "review_proof_budget_exhausted");
});

test("all proof plans share twenty minutes and expired producer authority stays fenced", async (t) => {
  const started = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: started });
  const f = await fixture();
  const first = await f.post(f.plan());
  assert.equal(first.body.record.expiresAt, started + 20 * 60_000);
  const producer = {
    workflowSha: "b".repeat(40),
    harnessSha: "b".repeat(40),
    workflowPath: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    workflowRef: "main",
    repositoryId: "123",
    bodySha256: "c".repeat(64),
    baseSha: "d".repeat(40),
    targetBranch: "main",
  };
  assert.equal(
    (
      await f.post(
        { lease: f.lease, requestId: first.body.record.requestId, operation: "prepared", producer },
        "/review-proof/update",
      )
    ).status,
    200,
  );
  t.mock.timers.tick(16 * 60_000);
  const redemption = {
    requestId: first.body.record.requestId,
    runId: "300",
    runAttempt: 1,
    planSha256: f.plan().planSha256,
  };
  for (const route of ["/review-proof/producer-record", "/review-proof/redeem"])
    assert.equal((await f.post(redemption, route)).status, 200);
  const second = await f.post(f.plan("second"));
  assert.equal(second.status, 200);
  assert.equal(second.body.record.expiresAt, first.body.record.expiresAt);
  assert.equal(second.body.dispatch, true);
  const stillActive = await f.post({ ...f.plan(), operation: "poll" });
  assert.equal(stillActive.body.record.state, "dispatch_claimed");
  assert.equal(stillActive.body.record.runId, "300");
  t.mock.timers.tick(4 * 60_000);
  assert.equal((await f.post(f.plan("third"))).body.error, "review_proof_budget_expired");
  const expired = await f.post({ ...f.plan(), operation: "poll" });
  assert.equal(expired.body.record.state, "inconclusive");
  assert.equal(expired.body.record.reason, "proof_deadline_expired");
  for (const route of ["/review-proof/producer-record", "/review-proof/redeem"])
    assert.equal(
      (
        await f.post(
          {
            requestId: first.body.record.requestId,
            runId: "300",
            runAttempt: 1,
            planSha256: f.plan().planSha256,
          },
          route,
        )
      ).status,
      409,
    );
});

test("review proof rejects every stale owner field and forged plan digest", async () => {
  const f = await fixture();
  for (const [key, value] of Object.entries({
    leaseId: "wrong",
    leaseRevision: 2,
    claimGeneration: 2,
    runId: "456",
    runAttempt: 2,
    sourceHeadSha: "b".repeat(40),
  })) {
    const result = await f.post({ ...f.plan(), lease: { ...f.lease, [key]: value } });
    assert.equal(result.status, 409, key);
    assert.equal(result.body.error, "lease_not_active", key);
  }
  assert.equal((await f.post({ ...f.plan(), planSha256: "0".repeat(64) })).status, 400);
  assert.equal((await f.post({ ...f.plan(), operation: "update" })).status, 400);
});

test("review proof poll cannot dispatch and completion feeds original record only", async () => {
  const f = await fixture();
  assert.equal((await f.post({ ...f.plan(), operation: "poll" })).status, 404);
  const admitted = await f.post(f.plan());
  const requestId = admitted.body.record.requestId;
  assert.equal(
    (
      await f.post(
        { lease: f.lease, requestId, state: "pending", runId: "987" },
        "/review-proof/update",
      )
    ).body.record.state,
    "pending",
  );
  assert.equal(
    (
      await f.post(
        { lease: f.lease, requestId, state: "pending", runId: "988" },
        "/review-proof/update",
      )
    ).status,
    409,
  );
  const result = { observations: [{ actual: "reply", expected: "reply" }] };
  await f.post({ lease: f.lease, requestId, state: "completed", result }, "/review-proof/update");
  const polled = await f.post({ ...f.plan(), operation: "poll" });
  assert.equal(polled.body.dispatch, false);
  assert.equal(polled.body.record.state, "completed");
  assert.deepEqual(polled.body.record.result, result);
});

for (const operation of ["prepared", "completed"]) {
  test(`expired proof rejects ${operation} update and persists the deadline fence`, async () => {
    const f = await fixture();
    const admitted = await f.post(f.plan());
    const requestId = admitted.body.record.requestId;
    const state = (f.queue as any).readStateSync();
    state.items[f.lease.itemKey].reviewProofRequests[0].expiresAt = Date.now() - 1;
    await (f.queue as any).writeState(state);
    const response = await f.post(
      {
        lease: f.lease,
        requestId,
        ...(operation === "prepared"
          ? { operation, producer: {} }
          : {
              state: "completed",
              result: { observations: [] },
            }),
      },
      "/review-proof/update",
    );
    assert.equal(response.status, 409);
    assert.notEqual(response.body.ok, true);
    const restarted = new ExactReviewQueue({ storage: f.storage }, {});
    const polled = await f.post({ ...f.plan(), operation: "poll" }, "/review-proof", restarted);
    assert.equal(polled.body.record.state, "inconclusive");
    assert.equal(polled.body.record.reason, "proof_deadline_expired");
    assert.equal(polled.body.record.result, undefined);
  });
}

test("producer redemption is same-run idempotent and denies replays and owner loss", async () => {
  const f = await fixture();
  const first = await f.post(f.plan());
  const requestId = first.body.record.requestId;
  const producer = {
    workflowSha: "b".repeat(40),
    harnessSha: "b".repeat(40),
    workflowPath: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    workflowRef: "main",
    repositoryId: "123",
    bodySha256: "c".repeat(64),
    baseSha: "d".repeat(40),
    targetBranch: "main",
  };
  assert.equal(
    (
      await f.post(
        { lease: f.lease, requestId, operation: "prepared", producer },
        "/review-proof/update",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.post(
        {
          lease: f.lease,
          requestId,
          operation: "prepared",
          producer: { ...producer, workflowSha: "e".repeat(40), harnessSha: "e".repeat(40) },
        },
        "/review-proof/update",
      )
    ).status,
    409,
  );
  const redemption = { requestId, runId: "987", runAttempt: 1, planSha256: f.plan().planSha256 };
  assert.equal((await f.post(redemption, "/review-proof/redeem")).status, 200);
  assert.equal((await f.post(redemption, "/review-proof/redeem")).status, 200);
  assert.equal((await f.post({ ...redemption, runId: "988" }, "/review-proof/redeem")).status, 409);
  assert.equal(
    (await f.post({ ...redemption, runAttempt: 2 }, "/review-proof/redeem")).status,
    409,
  );
  const completed = await fixture();
  const completedId = (await completed.post(completed.plan())).body.record.requestId;
  await completed.post(
    { lease: completed.lease, requestId: completedId, operation: "prepared", producer },
    "/review-proof/update",
  );
  await completed.post({ ...redemption, requestId: completedId }, "/review-proof/redeem");
  await completed.post(
    {
      lease: completed.lease,
      requestId: completedId,
      state: "completed",
      result: { observations: [] },
    },
    "/review-proof/update",
  );
  assert.equal(
    (await completed.post({ ...redemption, requestId: completedId }, "/review-proof/redeem"))
      .status,
    409,
  );
  await f.post(
    {
      item_key: f.lease.itemKey,
      lease_id: f.lease.leaseId,
      lease_revision: f.lease.leaseRevision,
      claim_generation: f.lease.claimGeneration,
      run_id: f.lease.runId,
      run_attempt: f.lease.runAttempt,
      source_head_sha: f.lease.sourceHeadSha,
      phase: "finalizing",
    },
    "/heartbeat",
  );
  assert.equal((await f.post(redemption, "/review-proof/redeem")).status, 409);
});

test("public proof endpoint cannot accept a reviewer-forged completion", async () => {
  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/proof", {
      method: "POST",
      body: JSON.stringify({
        operation: "update",
        state: "completed",
        result: { outcome: "pass" },
      }),
    }),
    {},
    { waitUntil() {} },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_review_proof_request" });
});

test("manual proof head binding cannot be silently replaced by latest PR head", async () => {
  const f = await fixture();
  await f.post(f.plan()); // Initialize the existing queue tables.
  const body = "@clawsweeper proof";
  const updatedAt = new Date().toISOString();
  const intake = {
    commandVersionId: "test-bound-head",
    sourceCommentId: 42,
    sourceCommentUpdatedAt: updatedAt,
    commandBodyDigest: createHash("sha256").update(body).digest("hex"),
    decision: {
      targetRepo: "openclaw/openclaw",
      itemNumber: 42,
      itemKind: "pull_request",
      sourceHeadSha: "a".repeat(40),
      targetBranch: "main",
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    Response.json(
      String(url).includes("/comments/")
        ? {
            issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/42",
            updated_at: updatedAt,
            body,
          }
        : { state: "open", head: { sha: "b".repeat(40) }, updated_at: updatedAt },
    )) as typeof fetch;
  try {
    assert.equal(
      await (f.queue as any).verifyCommandIntake({ intake }, Promise.resolve("fixture-token")),
      null,
    );
    delete (intake.decision as any).sourceHeadSha;
    const ordinary = await (f.queue as any).verifyCommandIntake(
      { intake },
      Promise.resolve("fixture-token"),
    );
    assert.equal(ordinary.sourceHeadSha, "b".repeat(40));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue status and Bay projections do not expose review proof capabilities or content", async () => {
  const f = await fixture();
  const baseline = (await (await f.queue.fetch(new Request("https://queue/stats"))).json()) as any;
  const privateMarker = "private-proof-plan-content";
  const admitted = await f.post(f.plan(privateMarker));
  const requestId = admitted.body.record.requestId;
  const response = await f.queue.fetch(new Request("https://queue/stats"));
  const stats = await response.json();
  const publicStats = publicExactReviewQueueProjection(stats, new Set(["openclaw/openclaw"]));
  const env = { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(f.queue) };
  const publicResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/exact-review-queue"),
    env,
    {},
  );
  for (const text of [
    JSON.stringify(stats),
    JSON.stringify(publicStats),
    await publicResponse.text(),
  ]) {
    for (const forbidden of [
      f.lease.leaseId,
      privateMarker,
      requestId,
      "reviewProofRequests",
      "proofPlan",
      "producerRedemption",
    ])
      assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.equal(
    (stats as any).bay_projection.items[0].stage,
    baseline.bay_projection.items[0].stage,
  );
});
