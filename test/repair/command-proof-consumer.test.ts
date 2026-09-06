import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHmac, randomBytes } from "node:crypto";
import { CommandProofHttpTransport } from "../../dist/repair/command-proof-http.js";
import { GitHubRateLimitError } from "../../dist/github-retry.js";
import {
  compactPrimaryBody,
  primaryBodySourceSha256,
} from "../../dist/clawsweeper-primary-body.js";
import {
  proofFixture,
  replaceReceipt,
  replaceProofEvidence,
  zip,
  digest,
} from "../helpers/command-proof-fixtures.ts";
import {
  parseCommandProofClaim,
  COMMAND_PROOF_PROFILES,
  type CommandProofScenario,
  commandProofProducersFromEnv,
  parseMantisProofReceipt,
  proofText,
} from "../../dist/command-proof-contract.js";
import {
  commandProofTargetIsCurrent,
  verifyCommandProof,
} from "../../dist/repair/proof-receipt-verification.js";
import { CommandProofConsumer } from "../../dist/repair/command-proof-consumer.js";
import { readProofZip } from "../../dist/repair/proof-zip.js";
import {
  commandProofBinding,
  commandProofBaseRefSha256,
  assertCommandProofSubject,
} from "../../dist/command-proof-assessment.js";
import { CommandProofRequestStore } from "../../dashboard/command-proof-requests.ts";
import {
  MemoryDurableStorage,
  MemoryDurableNamespace,
  ExactReviewQueue,
  leasedExactReviewQueueItem,
  type ExactReviewQueueItem,
  worker,
} from "../dashboard-worker-harness.ts";

test("producer run paths accept the pinned ref but reject substituted qualifiers", () => {
  for (const scenario of Object.keys(COMMAND_PROOF_PROFILES) as CommandProofScenario[]) {
    const fixture = proofFixture(undefined, scenario);
    const path = fixture.claim.workflowPath;
    for (const runPath of [path, path + "@" + fixture.claim.workflowRef]) {
      assert.equal(
        verifyCommandProof({ ...fixture, run: { ...fixture.run, path: runPath } }).outcome,
        "pass",
        runPath,
      );
    }
    for (const runPath of [path + "@other-ref", path + "@", path + "@" + fixture.claim.headSha]) {
      assert.deepEqual(
        verifyCommandProof({ ...fixture, run: { ...fixture.run, path: runPath } }),
        { outcome: "inconclusive", reason: "untrusted_or_incomplete_producer_run" },
        runPath,
      );
    }
  }
});

test("Web UI evidence rejects authenticated but undeclared archive files", () => {
  const fixture = proofFixture(undefined, "web-ui-chat-proof");
  const files = readProofZip(fixture.evidenceArchive);
  files.set("unexpected.txt", Buffer.from("undeclared payload"));
  assert.deepEqual(verifyCommandProof(replaceProofEvidence(fixture, files)), {
    outcome: "inconclusive",
    reason: "invalid_evidence_inventory",
  });
});

test("Web UI accepts its producer manifest but rejects missing or substituted inventory paths", () => {
  const fixture = proofFixture(undefined, "web-ui-chat-proof");
  assert.equal(verifyCommandProof(fixture).outcome, "pass");
  for (const missing of [
    "observer.json",
    "chat-send.json",
    "final-reply.json",
    "final-reply.png",
  ]) {
    for (const replacement of [false, true]) {
      const files = readProofZip(fixture.evidenceArchive);
      files.delete(missing);
      if (replacement) files.set("unexpected.txt", Buffer.from("replacement"));
      assert.deepEqual(verifyCommandProof(replaceProofEvidence(fixture, files)), {
        outcome: "inconclusive",
        reason: "invalid_evidence_inventory",
      });
    }
  }
});

async function commandProofRetryHarness(
  options: {
    pages?: unknown[];
    knownRun?: boolean;
    loseEnqueueResponse?: boolean;
    scenario?: CommandProofScenario;
    outcome?: "pass" | "fail";
    producer?: ConstructorParameters<typeof CommandProofConsumer>[1];
  } = {},
) {
  const fixture = proofFixture(undefined, options.scenario, options.outcome);
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = randomBytes(32).toString("hex");
  const post = async (path: string, value: unknown) => {
    const body = JSON.stringify(value);
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/" + path, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature":
            "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
        },
      }),
      { CLAWSWEEPER_WEBHOOK_SECRET: secret, EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    );
    assert.equal(response.ok, true, "Worker response " + response.status);
    return response.json();
  };
  const admitted = await post("command-proof/claim", { claim: fixture.claim });
  assert.equal(admitted.accepted, true);
  if (options.knownRun !== false)
    await post("command-proof/update", {
      operation: "dispatched",
      requestId: fixture.claim.requestId,
      runId: "300",
    });
  const store = new CommandProofRequestStore(storage);
  const pageRequests: URL[] = [];
  const githubRequests: string[] = [];
  const enqueueBodies: unknown[] = [];
  const enqueueResponses: Record<string, unknown>[] = [];
  const counts = { dispatches: 0, artifactReads: 0 };
  let lostResponse = false;
  const consumer = new CommandProofConsumer(
    {
      github: async (path, body) => {
        githubRequests.push(path);
        if (body !== undefined) {
          counts.dispatches++;
          throw new Error("unexpected dispatch");
        }
        const url = new URL("https://api.github.com/" + path);
        const repo = "/repos/" + fixture.claim.repository;
        if (url.pathname === repo) return fixture.live.repository;
        if (url.pathname === repo + "/pulls/42") return fixture.live.pull;
        if (url.pathname === repo + "/issues/comments/200") return fixture.live.comment;
        if (url.pathname === repo + "/collaborators/maintainer/permission")
          return fixture.live.permission;
        if (
          url.pathname ===
          repo + "/actions/workflows/" + fixture.claim.workflowPath.split("/").at(-1) + "/runs"
        ) {
          pageRequests.push(url);
          return options.pages?.[Number(url.searchParams.get("page")) - 1];
        }
        if (url.pathname === repo + "/actions/runs/300") return fixture.run;
        if (url.pathname === repo + "/actions/runs/300/artifacts")
          return {
            total_count: 2,
            artifacts: [fixture.receiptArtifact, fixture.evidenceArtifact],
          };
        if (url.pathname === repo + "/actions/runs/300/attempts/1/jobs") return fixture.jobs;
        throw new Error("unexpected GitHub path: " + path);
      },
      artifact: async (id) => {
        counts.artifactReads++;
        if (id === "401") return fixture.receiptArchive;
        if (id === "400") return fixture.evidenceArchive;
        throw new Error("unexpected artifact");
      },
      queue: (operation, body) => post("command-proof/" + operation, body),
      enqueue: async (body) => {
        enqueueBodies.push(body);
        const response = await post("exact-review/enqueue", body);
        enqueueResponses.push(response);
        if (options.loseEnqueueResponse && !lostResponse && response.queued === true) {
          lostResponse = true;
          throw new Error("synthetic lost enqueue response");
        }
        return response;
      },
      status: async () => {},
    },
    options.producer ?? {
      workflowPath: fixture.claim.workflowPath,
      workflowRef: fixture.claim.workflowRef,
      workflowSha: fixture.claim.workflowSha,
      harnessSha: fixture.claim.harnessSha,
    },
  );
  const state = async () =>
    (await storage.get("exact-review-queue")) as {
      items: Record<string, ExactReviewQueueItem>;
      deliveries: Record<string, number>;
    };
  return {
    fixture,
    storage,
    queue,
    post,
    store,
    consumer,
    state,
    pageRequests,
    githubRequests,
    enqueueBodies,
    enqueueResponses,
    counts,
  };
}

test("compiled consumer CLI reopens SQL claims and completes only verified independent-review handoffs", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["scripts/e2e/command-proof-consumer-loopback.mjs"],
    { timeout: 120000 },
  );
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.observations.length, 15);
  assert.deepEqual(receipt.exceptionResponseSafety, {
    status: 500,
    contentType: "application/json; charset=utf-8",
    contentTypeOptions: "nosniff",
    body: { message: "fixture_request_failed" },
  });
  assert.deepEqual(
    receipt.observations,
    [
      ["pass", "completed", 1, 1, 1, false, true, false],
      ["fail", "completed", 1, 1, 1, false, true, false],
      ["candidate-only", "inconclusive", 1, 0, 0, true, false, false],
      ["stale-head", "inconclusive", 1, 0, 0, true, false, false],
      ["cross-pr", "inconclusive", 1, 0, 0, true, false, false],
      ["bad-digest", "inconclusive", 1, 0, 0, true, false, false],
      ["missing-observation", "inconclusive", 1, 0, 0, true, false, false],
      ["infra", "inconclusive", 1, 0, 0, true, false, false],
      ["rerun-attempt", "inconclusive", 1, 0, 0, true, false, false],
      ["queue-shed", "review_pending", 1, 0, 3, false, false, true],
      ["queue-rejected", "review_pending", 1, 0, 3, false, false, true],
      ["queue-stale-dedupe", "review_pending", 1, 0, 3, false, false, true],
      ["queue-unscoped-dedupe", "review_pending", 1, 0, 3, false, false, true],
      ["enqueue-response-lost", "completed", 1, 1, 1, false, true, false],
      ["ref-lookup-failure", "inconclusive", 0, 0, 0, true, false, false],
    ].map(
      ([
        scenario,
        state,
        producerDispatches,
        independentReviews,
        reviewEnqueueAttempts,
        statusOwnerUpdated,
        reviewStatusOwnerDelegated,
        reviewAdmissionBlocked,
      ]) => ({
        scenario,
        state,
        assertionOutcome: state === "inconclusive" ? null : scenario === "fail" ? "fail" : "pass",
        evidenceSource: producerDispatches === 0 ? "not-produced" : "controlled-consumer-fixture",
        producerDispatches,
        independentReviews,
        reviewEnqueueAttempts,
        reopenedSqliteClaim: true,
        statusOwnerUpdated,
        reviewStatusOwnerDelegated,
        reviewAdmissionBlocked,
      }),
    ),
  );
});

test("compiled Telegram consumer preserves exact runtime outcomes across replay, stale and cross-evidence cases", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["scripts/e2e/command-proof-consumer-loopback.mjs", "--scenario", "telegram-bot-e2e-proof"],
    { timeout: 180000 },
  );
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.scenarioProfile, "telegram-bot-e2e-proof");
  const ids = [
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
    "cross-scenario",
    "cross-workflow",
    "cross-observer-job",
    "cross-evidence-artifact",
    "cross-evidence-files",
    "malformed-observation",
    "uncorrelated-reply",
    "outcome-mismatch",
  ];
  assert.equal(receipt.observations.length, 23);
  assert.deepEqual(
    receipt.observations,
    ids.map((scenario) => {
      const admitted = ["pass", "fail", "enqueue-response-lost"].includes(scenario);
      const blocked = [
        "queue-shed",
        "queue-rejected",
        "queue-stale-dedupe",
        "queue-unscoped-dedupe",
      ].includes(scenario);
      return {
        scenario,
        state: admitted ? "completed" : blocked ? "review_pending" : "inconclusive",
        assertionOutcome: admitted || blocked ? (scenario === "fail" ? "fail" : "pass") : null,
        evidenceSource:
          scenario === "ref-lookup-failure" ? "not-produced" : "controlled-consumer-fixture",
        producerDispatches: scenario === "ref-lookup-failure" ? 0 : 1,
        independentReviews: admitted ? 1 : 0,
        reviewEnqueueAttempts: blocked ? 3 : admitted ? 1 : 0,
        reopenedSqliteClaim: true,
        statusOwnerUpdated: !admitted && !blocked,
        reviewStatusOwnerDelegated: admitted,
        reviewAdmissionBlocked: blocked,
      };
    }),
  );
  assert.deepEqual(receipt.exceptionResponseSafety, {
    status: 500,
    contentType: "application/json; charset=utf-8",
    contentTypeOptions: "nosniff",
    body: { message: "fixture_request_failed" },
  });
});

test("all proof scenarios admit pass or fail evidence once through the actual Worker queue without cross-transport replay", async (t) => {
  for (const scenario of [
    "web-ui-chat-proof",
    "telegram-bot-e2e-proof",
    "telegram-markdown-parser-fidelity",
  ] as const) {
    for (const outcome of ["pass", "fail"] as const) {
      const h = await commandProofRetryHarness({ scenario, outcome });
      t.after(() => h.storage.sql.close());
      const claim = h.fixture.claim;
      assert.deepEqual(await h.consumer.reconcile(), [
        { requestId: claim.requestId, status: "independent_review_queued", outcome },
      ]);
      assert.equal(h.store.get(claim.requestId)?.state, "completed");
      const item = (await h.state()).items[claim.repository + "#42"]!;
      assert.equal(item.decision.sourceAction, "command_proof_result");
      assert.ok(
        item.decision.additionalPrompt!.includes(COMMAND_PROOF_PROFILES[scenario].scopeNotice),
      );
      assert.deepEqual(commandProofBinding(item.decision.additionalPrompt!), {
        headSha: claim.headSha,
        bodySha256: claim.bodySha256,
        baseRefSha256: digest(claim.targetBranch),
        baseSha: claim.baseSha,
        requestId: claim.requestId,
        scenario,
      });
      assert.deepEqual(await h.consumer.reconcile(), []);
      assert.equal(h.enqueueBodies.length, 1);
      assert.equal(h.counts.dispatches, 0);
      const other =
        scenario === "web-ui-chat-proof" ? "telegram-bot-e2e-proof" : "web-ui-chat-proof";
      const switched = {
        ...claim,
        requestId: digest("switched transport"),
        scenario: other,
        workflowPath: COMMAND_PROOF_PROFILES[other].workflowPath,
      };
      const replay = await h.post("command-proof/claim", { claim: switched });
      assert.equal(replay.accepted, false);
      assert.equal(replay.reason, "proof_target_binding_changed");
    }
  }
});

test("reconciliation rejects revoked authority in both active states before artifact reads or enqueue", async (t) => {
  for (const activeState of ["dispatch_claimed", "review_pending"]) {
    for (const producer of [
      undefined,
      {
        "web-ui-chat-proof": {
          workflowPath: COMMAND_PROOF_PROFILES["web-ui-chat-proof"].workflowPath,
          workflowRef: "approved-web-ui",
          workflowSha: "9".repeat(40),
          harnessSha: "9".repeat(40),
        },
      },
      {
        "telegram-bot-e2e-proof": {
          workflowPath: COMMAND_PROOF_PROFILES["telegram-bot-e2e-proof"].workflowPath,
          workflowRef: "replacement-telegram",
          workflowSha: "8".repeat(40),
          harnessSha: "8".repeat(40),
        },
      },
    ]) {
      const h = await commandProofRetryHarness({
        scenario: "telegram-bot-e2e-proof",
        producer,
      });
      t.after(() => h.storage.sql.close());
      if (activeState === "review_pending") {
        const verified = verifyCommandProof(h.fixture);
        assert.ok(verified.outcome !== "inconclusive");
        h.store.update(
          {
            requestId: h.fixture.claim.requestId,
            operation: "verified",
            result: {
              outcome: verified.outcome,
              digest: verified.evidenceDigest,
              reviewContext: verified.reviewContext,
              runId: "300",
              runAttempt: 1,
            },
          },
          Date.now(),
        );
      }
      assert.equal(h.store.get(h.fixture.claim.requestId)?.state, activeState);
      if (!producer) h.fixture.live.permission.permission = "read";
      assert.deepEqual(await h.consumer.reconcile(), [
        {
          requestId: h.fixture.claim.requestId,
          status: "inconclusive",
          reason: producer
            ? "producer_approval_revoked_or_changed"
            : "stale_or_unauthorized_target",
        },
      ]);
      assert.equal(h.counts.artifactReads, 0);
      assert.equal(h.enqueueBodies.length, 0);
      assert.equal(h.counts.dispatches, 0);
      if (producer) assert.equal(h.githubRequests.length, 0);
      else
        assert.equal(
          h.githubRequests.some((path) => path.includes("/actions/")),
          false,
        );
    }
  }
});

test("adding the proof schema preserves populated existing queue tables and delivery receipts", async (t) => {
  const h = await commandProofRetryHarness();
  t.after(() => h.storage.sql.close());
  const claim = h.fixture.claim;
  assert.equal(
    (
      await h.post("exact-review/enqueue", {
        delivery_id: "pre-proof-delivery",
        decision: {
          targetRepo: claim.repository,
          targetBranch: claim.targetBranch,
          itemNumber: 43,
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceAction: "opened",
          supersedesInProgress: false,
          sourceHeadSha: claim.headSha,
          sourceAuthoritySeq: 1,
          sourceUpdatedAt: claim.sourceCommentUpdatedAt,
        },
      })
    ).queued,
    true,
  );
  // Model the existing SQL store before this additive table existed, not an
  // old binary upgrade: all canonical queue schemas and populated rows remain.
  h.storage.sql.exec("DROP TABLE command_proof_requests_v1");
  const tables = [
    ...h.storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ),
  ].map((row) => String(row.name));
  const snapshot = () =>
    Object.fromEntries(
      tables.map((name) => [
        name,
        [...h.storage.sql.exec('SELECT * FROM "' + name.replaceAll('"', '""') + '"')],
      ]),
    );
  const before = snapshot();
  assert.ok(before.exact_review_queue_items.length > 0);
  assert.ok(
    before.exact_review_queue_deliveries.some((row) => row.delivery_id === "pre-proof-delivery"),
  );
  const store = new CommandProofRequestStore(h.storage);
  store.ensureSchemaSync();
  store.ensureSchemaSync();
  assert.equal(store.claim(claim, Date.now()).dispatch, true);
  assert.deepEqual(snapshot(), before);
  assert.equal((await h.state()).items[claim.repository + "#43"].decision.itemNumber, 43);
});

test("all proof consumers reject stale, incomplete and cross-transport artifacts without reassessment", async (t) => {
  for (const scenario of [
    "web-ui-chat-proof",
    "telegram-bot-e2e-proof",
    "telegram-markdown-parser-fidelity",
  ] as const) {
    for (const failure of [
      "scenario",
      "workflow",
      "job",
      "artifact",
      "files",
      "candidate",
      "missing",
      "infra",
      "head",
      "receipt-outcome",
    ]) {
      if (failure === "receipt-outcome" && scenario === "web-ui-chat-proof") continue;
      const h = await commandProofRetryHarness({ scenario });
      t.after(() => h.storage.sql.close());
      const fixture = h.fixture;
      const other =
        scenario === "web-ui-chat-proof" ? "telegram-bot-e2e-proof" : "web-ui-chat-proof";
      if (failure === "scenario")
        Object.assign(fixture, replaceReceipt(fixture, { ...fixture.receipt, scenario: other }));
      if (failure === "workflow") fixture.run.path = COMMAND_PROOF_PROFILES[other].workflowPath;
      if (failure === "job") fixture.jobs.jobs[0]!.name = COMMAND_PROOF_PROFILES[other].observerJob;
      if (failure === "artifact")
        fixture.evidenceArtifact.name =
          COMMAND_PROOF_PROFILES[other].evidenceArtifactPrefix + "-300-1";
      if (failure === "files")
        Object.assign(
          fixture,
          replaceProofEvidence(
            fixture,
            readProofZip(proofFixture(fixture.claim.requestId, other).evidenceArchive),
          ),
        );
      if (failure === "candidate")
        Object.assign(
          fixture,
          replaceReceipt(fixture, {
            ...fixture.receipt,
            observations: fixture.receipt.observations.map((o) => ({
              ...o,
              authority: "candidate_reported",
            })),
          }),
        );
      if (failure === "missing")
        Object.assign(
          fixture,
          replaceReceipt(fixture, {
            ...fixture.receipt,
            observations: fixture.receipt.observations.slice(1),
          }),
        );
      if (failure === "infra") fixture.run.conclusion = "timed_out";
      if (failure === "head") fixture.live.pull.head.sha = "f".repeat(40);
      if (failure === "receipt-outcome")
        Object.assign(
          fixture,
          replaceReceipt(fixture, { ...fixture.receipt, assertion_outcome: "fail" }),
        );
      const result = (await h.consumer.reconcile()) as Array<{ status: string }>;
      assert.equal(result[0]?.status, "inconclusive", scenario + ": " + failure);
      assert.equal(h.store.get(fixture.claim.requestId)?.state, "inconclusive");
      assert.equal(h.enqueueBodies.length, 0);
      assert.equal(h.counts.dispatches, 0);
    }
  }
});

test("each proof scenario selects only its independently pinned producer and dispatches one immutable request", async (t) => {
  for (const scenario of [
    "web-ui-chat-proof",
    "telegram-bot-e2e-proof",
    "telegram-markdown-parser-fidelity",
  ] as const) {
    const fixture = proofFixture();
    fixture.live.comment.body = "/clawsweeper proof " + scenario + " " + fixture.claim.headSha;
    const storage = new MemoryDurableStorage();
    t.after(() => storage.sql.close());
    const store = new CommandProofRequestStore(storage);
    store.ensureSchemaSync();
    const environment: Record<string, string> = {};
    for (const profile of Object.values(COMMAND_PROOF_PROFILES)) {
      environment[profile.configPrefix + "_WORKFLOW_PATH"] = profile.workflowPath;
      environment[profile.configPrefix + "_WORKFLOW_REF"] = profile.scenario + "-pinned";
      environment[profile.configPrefix + "_WORKFLOW_SHA"] = (
        profile.scenario === "web-ui-chat-proof" ? "b" : "e"
      ).repeat(40);
      environment[profile.configPrefix + "_HARNESS_SHA"] =
        environment[profile.configPrefix + "_WORKFLOW_SHA"]!;
    }
    const producers = commandProofProducersFromEnv(environment);
    const producer = producers[scenario]!;
    const dispatches: Array<{ path: string; body: unknown }> = [];
    const transport = {
      github: async (path: string, body?: unknown) => {
        const repo = "repos/openclaw/openclaw";
        if (body !== undefined) {
          dispatches.push({ path, body });
          assert.equal(
            path,
            repo + "/actions/workflows/" + producer.workflowPath.split("/").at(-1) + "/dispatches",
          );
          return { workflow_run_id: 300 };
        }
        if (path === repo) return fixture.live.repository;
        if (path === repo + "/pulls/42") return fixture.live.pull;
        if (path === repo + "/issues/comments/200") return fixture.live.comment;
        if (path === repo + "/collaborators/maintainer/permission") return fixture.live.permission;
        if (path === repo + "/commits/" + producer.workflowRef)
          return { sha: producer.workflowSha };
        throw new Error("unexpected fixture request " + path);
      },
      queue: async (operation: string, body: unknown) => {
        const value = body as { claim?: unknown };
        return operation === "claim"
          ? store.claim(value.claim, Date.now())
          : { record: store.update(body, Date.now()) };
      },
      artifact: async () => {
        throw new Error("request must not read artifacts");
      },
      enqueue: async () => {
        throw new Error("request must not enqueue reassessment");
      },
      status: async () => {},
    };
    const other = scenario === "web-ui-chat-proof" ? "telegram-bot-e2e-proof" : "web-ui-chat-proof";
    const input = { repository: "openclaw/openclaw", pullRequest: 42, commentId: "200" };
    assert.deepEqual(
      await new CommandProofConsumer(transport, { [other]: producers[other] }).request(input),
      { status: "inconclusive", reason: "proof_producer_not_configured" },
    );
    assert.equal(dispatches.length, 0);
    const consumer = new CommandProofConsumer(transport, producers);
    const result = await consumer.request(input);
    assert.equal(result.status, "queued");
    const record = store.pending(Date.now())[0]!;
    assert.equal(record.claim.scenario, scenario);
    assert.equal(record.claim.workflowPath, producer.workflowPath);
    assert.equal(record.claim.workflowSha, producer.workflowSha);
    assert.equal(record.claim.harnessSha, producer.harnessSha);
    assert.equal(record.runId, "300");
    assert.deepEqual(dispatches, [
      {
        path:
          "repos/openclaw/openclaw/actions/workflows/" +
          producer.workflowPath.split("/").at(-1) +
          "/dispatches",
        body: {
          ref: producer.workflowRef,
          inputs: {
            request_id: record.claim.requestId,
            pr_number: "42",
            candidate_ref: fixture.claim.headSha,
            ...(scenario !== "web-ui-chat-proof" ? { scenario } : {}),
          },
        },
      },
    ]);
    await consumer.request(input);
    assert.equal(dispatches.length, 1);
  }
});

test("proof retry waits for queued or leased full reviews and admits one authenticated delivery", async (t) => {
  for (const existingState of ["pending", "leased"]) {
    const h = await commandProofRetryHarness({ loseEnqueueResponse: true });
    t.after(() => h.storage.sql.close());
    const claim = h.fixture.claim;
    const key = claim.repository + "#42";
    const fullReview = {
      targetRepo: claim.repository,
      targetBranch: claim.targetBranch,
      itemNumber: 42,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "opened",
      supersedesInProgress: false,
      sourceHeadSha: claim.headSha,
      sourceAuthoritySeq: 1,
      sourceUpdatedAt: claim.sourceCommentUpdatedAt,
    };
    assert.equal(
      (await h.post("exact-review/enqueue", { delivery_id: "full-review", decision: fullReview }))
        .queued,
      true,
    );
    assert.equal(
      (
        await h.post("exact-review/enqueue", {
          delivery_id: "unrelated",
          decision: { ...fullReview, itemNumber: 43 },
        })
      ).queued,
      true,
    );
    const leaseReview = async () => {
      const state = await h.state();
      const current = state.items[key]!;
      state.items[key] = {
        ...leasedExactReviewQueueItem(42, "900"),
        ...current,
        state: "leased",
        leaseDecision: current.decision,
        claimProtocolVersion: 2,
      };
      await h.storage.put("exact-review-queue", state);
    };
    if (existingState === "leased") await leaseReview();
    const before = (await h.state()).items[key];
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await h.consumer.reconcile(), [
        { requestId: claim.requestId, status: "pending", reason: "infrastructure_unavailable" },
      ]);
      assert.equal(h.store.get(claim.requestId)?.state, "review_pending");
      assert.equal(h.enqueueResponses[attempt]?.stale_source, true);
      assert.deepEqual((await h.state()).items[key], before);
      assert.equal(
        [
          ...h.storage.sql.exec(
            "SELECT count(*) AS count FROM exact_review_queue_deliveries WHERE delivery_id LIKE 'command-proof-%'",
          ),
        ][0]!.count,
        0,
      );
      assert.ok((await h.state()).deliveries.unrelated);
    }
    const sent = h.enqueueBodies[0] as { delivery_id: string; decision: Record<string, unknown> };
    assert.equal(sent.decision.sourceHeadSha, claim.headSha);
    assert.equal(sent.decision.sourceCommentId, 200);
    assert.equal(sent.decision.sourceCommentUpdatedAt, claim.sourceCommentUpdatedAt);
    assert.equal(sent.decision.commandBodyDigest, claim.sourceCommentBodySha256);
    assert.equal(sent.decision.commandOrigin, "comment_router");
    assert.equal(sent.decision.sourceCommentVerified, true);
    assert.equal(sent.decision.supersedesInProgress, false);
    // Advance only the fixture lease; the real completion owner removes the full review.
    if (existingState === "pending") await leaseReview();
    const completion = await h.queue.fetch(
      new Request("https://queue/complete", {
        method: "POST",
        body: JSON.stringify({
          item_key: key,
          lease_id: "lease-42",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "900",
          run_attempt: 1,
          outcome: "success",
        }),
      }),
    );
    assert.equal(completion.status, 200);
    assert.equal((await h.state()).items[key], undefined);
    await h.consumer.reconcile(); // Queue admits, but the caller loses the response.
    assert.equal(h.store.get(claim.requestId)?.state, "completed");
    const admitted = (await h.state()).items[key]!;
    assert.equal(admitted.decision.sourceAction, "command_proof_result");
    assert.deepEqual(await h.consumer.reconcile(), []);
    assert.equal(h.store.get(claim.requestId)?.state, "completed");
    assert.deepEqual((await h.state()).items[key], admitted);
    assert.equal(h.enqueueBodies.length, 3);
    for (const body of h.enqueueBodies) assert.deepEqual(body, sent);
    assert.equal(
      [
        ...h.storage.sql.exec(
          "SELECT count(*) AS count FROM exact_review_queue_deliveries WHERE delivery_id LIKE 'command-proof-%'",
        ),
      ][0]!.count,
      1,
    );
    assert.ok((await h.state()).deliveries.unrelated);
    assert.deepEqual(await h.consumer.reconcile(), []);
    assert.equal(h.enqueueBodies.length, 3);
    assert.equal(h.counts.dispatches, 0);
  }
});

test("proof retry rejects stale command versions without completing or consuming their retry receipt", async (t) => {
  const h = await commandProofRetryHarness();
  t.after(() => h.storage.sql.close());
  const claim = h.fixture.claim;
  const newerAt = new Date(Date.parse(claim.sourceCommentUpdatedAt) + 1000).toISOString();
  const key = claim.repository + "#42";
  assert.equal(
    (
      await h.post("exact-review/enqueue", {
        delivery_id: "newer-command",
        decision: {
          targetRepo: claim.repository,
          targetBranch: claim.targetBranch,
          itemNumber: 42,
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceAction: "re_review",
          supersedesInProgress: false,
          sourceHeadSha: claim.headSha,
          sourceAuthoritySeq: 1,
          sourceCommentId: 200,
          sourceCommentUpdatedAt: newerAt,
          commandBodyDigest: "e".repeat(64),
          commandOrigin: "comment_router",
          sourceCommentVerified: true,
          commandStatusMarker: `<!-- clawsweeper-command-status:42:re_review:command-200-${Date.parse(newerAt).toString(36)}-${"e".repeat(64)} -->`,
        },
      })
    ).queued,
    true,
  );
  const before = (await h.state()).items[key];
  for (let attempt = 0; attempt < 2; attempt++) {
    await h.consumer.reconcile();
    assert.equal(h.enqueueResponses[attempt]?.stale_command, true);
    assert.equal(h.store.get(claim.requestId)?.state, "review_pending");
    assert.deepEqual((await h.state()).items[key], before);
    assert.equal(
      [
        ...h.storage.sql.exec(
          "SELECT count(*) AS count FROM exact_review_queue_deliveries WHERE delivery_id LIKE 'command-proof-%'",
        ),
      ][0]!.count,
      0,
    );
  }
  assert.deepEqual(h.enqueueBodies[0], h.enqueueBodies[1]);
  h.fixture.live.comment.updated_at = newerAt;
  assert.deepEqual(await h.consumer.reconcile(), [
    { requestId: claim.requestId, status: "inconclusive", reason: "stale_or_unauthorized_target" },
  ]);
  assert.equal(h.store.get(claim.requestId)?.state, "inconclusive");
  assert.equal(h.enqueueBodies.length, 2);
  assert.equal(h.counts.dispatches, 0);
});

test("unknown proof dispatch recovers request-ID matches beyond page one within a fixed bounded inventory", async (t) => {
  for (const total of [101, 500]) {
    const runs = Array.from({ length: total - 1 }, (_, index) => ({
      id: 1000 + index,
      display_title: "other request",
    }));
    runs.push({
      id: 300,
      display_title:
        COMMAND_PROOF_PROFILES["web-ui-chat-proof"].runName + " [" + "d".repeat(64) + "]",
    });
    const pages = Array.from({ length: Math.ceil(total / 100) }, (_, index) => ({
      total_count: total,
      workflow_runs: runs.slice(index * 100, (index + 1) * 100),
    }));
    const h = await commandProofRetryHarness({ knownRun: false, pages });
    t.after(() => h.storage.sql.close());
    assert.deepEqual(await h.consumer.reconcile(), [
      {
        requestId: h.fixture.claim.requestId,
        status: "independent_review_queued",
        outcome: "pass",
      },
    ]);
    assert.equal(h.store.get(h.fixture.claim.requestId)?.state, "completed");
    assert.equal(h.store.get(h.fixture.claim.requestId)?.result?.runId, "300");
    assert.deepEqual(
      h.pageRequests.map((url) => Number(url.searchParams.get("page"))),
      pages.map((_, index) => index + 1),
    );
    const created = h.pageRequests[0]!.searchParams.get("created")!;
    const [from, to] = created.split("..");
    assert.equal(Date.parse(from!), Date.parse(h.fixture.claim.sourceCommentUpdatedAt) - 60_000);
    assert.ok(Number.isFinite(Date.parse(to!)) && Date.parse(to!) >= Date.parse(from!));
    for (const url of h.pageRequests) {
      assert.equal(url.searchParams.get("created"), created);
      assert.equal(url.searchParams.get("event"), "workflow_dispatch");
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.deepEqual([...url.searchParams.keys()].sort(), [
        "created",
        "event",
        "page",
        "per_page",
      ]);
    }
    assert.equal(h.enqueueBodies.length, 1);
    assert.equal(h.counts.dispatches, 0);
    assert.equal(h.counts.artifactReads, 2);
  }
});

test("unknown proof dispatch rejects ambiguity and leaves incomplete or over-budget inventories pending", async (t) => {
  const match = {
    id: 300,
    display_title:
      COMMAND_PROOF_PROFILES["web-ui-chat-proof"].runName + " [" + "d".repeat(64) + "]",
  };
  const filler = Array.from({ length: 100 }, (_, index) => ({
    id: 1000 + index,
    display_title: "other request",
  }));
  const firstWithMatch = [match, ...filler.slice(1)];
  const cases = [
    {
      name: "ambiguous",
      pages: [
        { total_count: 101, workflow_runs: firstWithMatch },
        { total_count: 101, workflow_runs: [{ ...match, id: 301 }] },
      ],
      status: "inconclusive",
      reason: "ambiguous_producer_run_inventory",
    },
    {
      name: "short-page",
      pages: [
        { total_count: 101, workflow_runs: filler },
        { total_count: 101, workflow_runs: [] },
      ],
      status: "pending",
      reason: "partial_producer_run_inventory",
    },
    {
      name: "changed-total",
      pages: [
        { total_count: 101, workflow_runs: filler },
        { total_count: 102, workflow_runs: [match] },
      ],
      status: "pending",
      reason: "partial_producer_run_inventory",
    },
    {
      name: "duplicate-run-id",
      pages: [
        { total_count: 101, workflow_runs: firstWithMatch },
        { total_count: 101, workflow_runs: [match] },
      ],
      status: "pending",
      reason: "partial_producer_run_inventory",
    },
    {
      name: "conflicting-run-id",
      pages: [
        { total_count: 101, workflow_runs: firstWithMatch },
        { total_count: 101, workflow_runs: [{ ...match, display_title: "changed" }] },
      ],
      status: "pending",
      reason: "partial_producer_run_inventory",
    },
    {
      name: "budget",
      pages: [{ total_count: 501, workflow_runs: firstWithMatch }],
      status: "pending",
      reason: "producer_run_inventory_budget_exceeded",
    },
    {
      name: "API-ceiling",
      pages: [{ total_count: 1000, workflow_runs: firstWithMatch }],
      status: "pending",
      reason: "producer_run_inventory_budget_exceeded",
    },
    {
      name: "missing-total",
      pages: [{ workflow_runs: [match] }],
      status: "pending",
      reason: "partial_producer_run_inventory",
    },
    {
      name: "invalid-id",
      pages: [{ total_count: 1, workflow_runs: [{ ...match, id: 0 }] }],
      status: "pending",
      reason: "partial_producer_run_inventory",
    },
    {
      name: "not-observed",
      pages: [{ total_count: 1, workflow_runs: filler.slice(0, 1) }],
      status: "pending",
      reason: "producer_run_not_observed",
    },
  ];
  for (const scenario of cases) {
    const h = await commandProofRetryHarness({ knownRun: false, pages: scenario.pages });
    t.after(() => h.storage.sql.close());
    assert.deepEqual(
      await h.consumer.reconcile(),
      [{ requestId: h.fixture.claim.requestId, status: scenario.status, reason: scenario.reason }],
      scenario.name,
    );
    assert.equal(
      h.store.get(h.fixture.claim.requestId)?.state,
      scenario.status === "inconclusive" ? "inconclusive" : "dispatch_claimed",
      scenario.name,
    );
    assert.equal(h.pageRequests.length, scenario.pages.length, scenario.name);
    assert.ok(h.pageRequests.length <= 5);
    assert.equal(h.githubRequests.filter((path) => path.includes("/actions/runs/")).length, 0);
    assert.equal(h.enqueueBodies.length, 0);
    assert.equal(h.counts.artifactReads, 0);
    assert.equal(h.counts.dispatches, 0);
  }
});

test("known proof dispatch run ID bypasses inventory pagination", async (t) => {
  const h = await commandProofRetryHarness({ pages: [{ total_count: 1000, workflow_runs: [] }] });
  t.after(() => h.storage.sql.close());
  assert.deepEqual(await h.consumer.reconcile(), [
    { requestId: h.fixture.claim.requestId, status: "independent_review_queued", outcome: "pass" },
  ]);
  assert.equal(h.store.get(h.fixture.claim.requestId)?.state, "completed");
  assert.equal(h.pageRequests.length, 0);
  assert.equal(h.enqueueBodies.length, 1);
  assert.equal(h.counts.dispatches, 0);
});

test("proof text allows only tab, LF and CR among C0 controls and preserves text bounds", () => {
  for (let code = 0; code < 32; code++) {
    const character = String.fromCharCode(code);
    const allowed = code === 9 || code === 10 || code === 13;
    assert.equal(proofText(character, 1), allowed, "C0 code " + code);
    assert.equal(
      proofText("before" + character + "after", 12),
      allowed,
      "embedded C0 code " + code,
    );
  }
  const unicode = "Café 日本語 🦞";
  assert.equal(proofText(unicode, unicode.length), true);
  assert.equal(proofText(unicode, unicode.length - 1), false);
  assert.equal(proofText("", 100), false);
  assert.equal(proofText("a".repeat(101), 100), false);
  assert.equal(proofText(null, 100), false);
  assert.equal(proofText(123, 100), false);
});

test("proof ingress bounds chunked bodies before authentication or persistence", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(100000));
      controller.enqueue(new Uint8Array(40000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://clawsweeper.openclaw.ai/internal/command-proof/claim", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
});

test("HTTP adapter persists rate hints and never forwards API credentials to artifact blobs", async () => {
  const status = async () => {};
  const limited = new CommandProofHttpTransport({
    githubToken: "synthetic",
    queueUrl: "https://queue.invalid",
    queueSecret: "synthetic",
    status,
    fetchImpl: async () =>
      new Response("rate limited", { status: 429, headers: { "retry-after": "900" } }),
  });
  await assert.rejects(
    limited.github("repos/openclaw/openclaw"),
    (error) =>
      error instanceof GitHubRateLimitError && Date.parse(error.retryAt) >= Date.now() + 899000,
  );
  const seen: Array<RequestInit | undefined> = [];
  const redirect = new CommandProofHttpTransport({
    githubToken: "synthetic",
    queueUrl: "https://queue.invalid",
    queueSecret: "synthetic",
    status,
    fetchImpl: async (_url, options) => {
      seen.push(options);
      return seen.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://fixture.blob.core.windows.net/artifact" },
          })
        : new Response("bytes");
    },
  });
  assert.equal((await redirect.artifact("123")).toString(), "bytes");
  assert.equal(seen[1]?.headers, undefined);
  const badRedirect = new CommandProofHttpTransport({
    githubToken: "synthetic",
    queueUrl: "https://queue.invalid",
    queueSecret: "synthetic",
    status,
    fetchImpl: async () =>
      new Response(null, { status: 302, headers: { location: "https://example.com/artifact" } }),
  });
  await assert.rejects(badRedirect.artifact("123"), /untrusted_proof_artifact_redirect/);
});

test("complete pinned observer evidence yields observations for independent review, never readiness", () => {
  const fixture = proofFixture();
  const result = verifyCommandProof(fixture);
  assert.equal(result.outcome, "pass");
  if (result.outcome === "inconclusive") throw new Error(result.reason);
  assert.match(result.reviewContext, /independent assessment still required/);
  assert.match(result.reviewContext, /mocked Gateway ONLY/);
  assert.equal(Object.hasOwn(result, "ready"), false);
  assert.equal(Object.hasOwn(result, "sufficient"), false);
  const binding = commandProofBinding(result.reviewContext)!;
  assert.equal(binding.baseRefSha256, digest(fixture.claim.targetBranch));
  assertCommandProofSubject(
    binding,
    fixture.claim.headSha,
    fixture.live.pull.body,
    fixture.live.pull.base.ref,
    "c".repeat(40),
  );
  assert.throws(() =>
    assertCommandProofSubject(
      binding,
      "f".repeat(40),
      fixture.live.pull.body,
      fixture.live.pull.base.ref,
      "c".repeat(40),
    ),
  );
  assert.throws(() =>
    assertCommandProofSubject(
      binding,
      fixture.claim.headSha,
      "changed body",
      fixture.live.pull.base.ref,
      "c".repeat(40),
    ),
  );
  const failed = replaceReceipt(fixture, { ...fixture.receipt, assertion_outcome: "fail" });
  assert.equal(verifyCommandProof(failed).outcome, "fail");
});

test("base retargeting blocks proof dispatch and reassessment with unchanged head, body and comment", async () => {
  for (const drift of ["ref"] as const) {
    for (const phase of ["request", "reconcile"]) {
      const fixture = proofFixture();
      let claim = fixture.claim;
      assert.equal(commandProofTargetIsCurrent(claim, fixture.live), true);
      assert.equal(verifyCommandProof(fixture).outcome, "pass");
      const originalPull = structuredClone(fixture.live.pull);
      const originalComment = structuredClone(fixture.live.comment);
      const calls: Array<{ path: string; body: unknown }> = [];
      const updates: unknown[] = [];
      let artifactReads = 0;
      let reviewEnqueues = 0;
      if (phase === "reconcile")
        fixture.live.pull.base[drift] = drift === "ref" ? "release" : "e".repeat(40);
      const consumer = new CommandProofConsumer(
        {
          github: async (path, body) => {
            calls.push({ path, body });
            const repo = "repos/" + claim.repository;
            if (path === repo) return fixture.live.repository;
            if (path === repo + "/pulls/42") return fixture.live.pull;
            if (path === repo + "/issues/comments/200") return fixture.live.comment;
            if (path === repo + "/collaborators/maintainer/permission")
              return fixture.live.permission;
            throw new Error("unexpected GitHub call: " + path);
          },
          artifact: async () => {
            artifactReads++;
            throw new Error("base drift must not read proof artifacts");
          },
          queue: async (operation, body) => {
            if (operation === "claim") {
              claim = (body as { claim: typeof fixture.claim }).claim;
              fixture.live.pull.base[drift] = drift === "ref" ? "release" : "e".repeat(40);
              return { accepted: true, dispatch: true, record: { claim } };
            }
            if (operation === "pending") {
              return { records: [{ claim, state: "dispatch_claimed", runId: "300" }] };
            }
            updates.push(body);
            return { ok: true };
          },
          enqueue: async () => {
            reviewEnqueues++;
            throw new Error("base drift must not enqueue reassessment");
          },
          status: async () => {},
        },
        {
          workflowPath: claim.workflowPath,
          workflowRef: claim.workflowRef,
          workflowSha: claim.workflowSha,
          harnessSha: claim.harnessSha,
        },
      );
      const result =
        phase === "request"
          ? await consumer.request({
              repository: claim.repository,
              pullRequest: 42,
              commentId: "200",
            })
          : (await consumer.reconcile())[0];
      const reason =
        phase === "request" ? "target_changed_before_dispatch" : "stale_or_unauthorized_target";
      assert.deepEqual(result, { requestId: claim.requestId, status: "inconclusive", reason });
      assert.deepEqual(updates, [
        { operation: "inconclusive", requestId: claim.requestId, reason },
      ]);
      assert.equal(commandProofTargetIsCurrent(claim, fixture.live), false);
      assert.deepEqual(verifyCommandProof(fixture), {
        outcome: "inconclusive",
        reason: "stale_or_unauthorized_target",
      });
      assert.deepEqual(fixture.live.pull, {
        ...originalPull,
        base: { ...originalPull.base, [drift]: drift === "ref" ? "release" : "e".repeat(40) },
      });
      assert.deepEqual(fixture.live.comment, originalComment);
      assert.equal(calls.length, phase === "request" ? 8 : 4);
      assert.equal(
        calls.filter((call) => call.body !== undefined || call.path.includes("/actions/")).length,
        0,
      );
      assert.equal(artifactReads, 0);
      assert.equal(reviewEnqueues, 0);
    }
  }
});

test("metadata, authority, freshness and artifact failures stay inconclusive", () => {
  const changes: Array<(f: ReturnType<typeof proofFixture>) => void> = [
    (f) => {
      f.live.pull.head.sha = "f".repeat(40);
    },
    (f) => {
      f.live.pull.body += "edited";
    },
    (f) => {
      f.live.repository.private = true;
    },
    (f) => {
      f.live.repository.id = 456;
    },
    (f) => {
      f.live.pull.number = 43;
    },
    (f) => {
      f.live.pull.state = "closed";
    },
    (f) => {
      f.live.pull.head.repo.id = 456;
    },
    (f) => {
      f.live.comment.body += "edited";
    },
    (f) => {
      f.live.comment.user.type = "Bot";
    },
    (f) => {
      f.live.permission.permission = "read";
    },
    (f) => {
      f.run.head_sha = "f".repeat(40);
    },
    (f) => {
      f.run.run_attempt = 2;
    },
    (f) => {
      f.run.display_title = "Mantis request [" + "f".repeat(64) + "]";
    },
    (f) => {
      f.run.path = ".github/workflows/untrusted.yml";
    },
    (f) => {
      f.run.event = "pull_request";
    },
    (f) => {
      f.run.conclusion = "timed_out";
    },
    (f) => {
      f.run.status = "in_progress";
    },
    (f) => {
      f.receiptArtifact.expired = true;
    },
    (f) => {
      f.receiptArtifact.workflow_run.id = 301;
    },
    (f) => {
      f.evidenceArtifact.workflow_run.head_sha = "f".repeat(40);
    },
    (f) => {
      f.evidenceArtifact.digest = "sha256:" + "f".repeat(64);
    },
    (f) => {
      f.evidenceArtifact.size_in_bytes += 1;
    },
    (f) => {
      f.evidenceArtifact.name = "another-attempt";
    },
    (f) => {
      f.evidenceArchive[40] = f.evidenceArchive[40]! ^ 1;
    },
  ];
  for (const mutate of changes) {
    const fixture = proofFixture();
    mutate(fixture);
    assert.equal(verifyCommandProof(fixture).outcome, "inconclusive", mutate.toString());
  }
  for (const patch of [
    { request_id: "f".repeat(64) },
    { pull_request: 43 },
    { candidate_sha: "f".repeat(40) },
    { evidence: null, assertion_outcome: "inconclusive", reason: "runner unavailable" },
    { execution_outcome: "failed" },
    { observations: [] },
    {
      observations: [
        { ...proofFixture().receipt.observations[0], authority: "candidate_reported" },
      ],
    },
    { observations: [{ ...proofFixture().receipt.observations[0], availability: "partial" }] },
    { observations: [{ ...proofFixture().receipt.observations[0], source_path: "missing.json" }] },
    { observations: [{ ...proofFixture().receipt.observations[0], sha256: "f".repeat(64) }] },
  ]) {
    const fixture = proofFixture();
    assert.equal(
      verifyCommandProof(replaceReceipt(fixture, { ...fixture.receipt, ...patch })).outcome,
      "inconclusive",
    );
  }
});

test("closed receipt and claim metadata reject unknown fields, duplicate observations and unsafe paths", () => {
  const f = proofFixture();
  assert.ok(parseCommandProofClaim(f.claim));
  assert.ok(parseMantisProofReceipt(f.receipt));
  for (const scenario of [
    "web-ui-chat-proof",
    "telegram-bot-e2e-proof",
    "telegram-markdown-parser-fidelity",
  ] as const) {
    const rerun = proofFixture(undefined, scenario);
    assert.equal(
      parseMantisProofReceipt({ ...rerun.receipt, run: { ...rerun.receipt.run, attempt: 2 } }),
      null,
    );
  }
  assert.equal(parseCommandProofClaim({ ...f.claim, trusted: true }), null);
  assert.equal(parseCommandProofClaim({ ...f.claim, workflowRef: f.claim.workflowSha }), null);
  for (const patch of [
    { unknown: true },
    { repository: { ...f.receipt.repository, trusted: true } },
    { evidence: null },
    { observations: [f.receipt.observations[0], f.receipt.observations[0]] },
    { observations: [{ ...f.receipt.observations[0], source_path: "../candidate.json" }] },
    { observations: [{ ...f.receipt.observations[0], source_path: "https://example.com" }] },
    { observations: [{ ...f.receipt.observations[0], extra: "field" }] },
    { reason: "a".repeat(2049) },
  ])
    assert.equal(parseMantisProofReceipt({ ...f.receipt, ...patch }), null);
});

test("ZIP reader rejects paths, aliases, symlinks, corrupt data and inconsistent headers", () => {
  assert.equal(
    readProofZip(
      zip([{ name: "observation.json", content: Buffer.from("valid"), compressed: true }]),
    )
      .get("observation.json")
      ?.toString(),
    "valid",
  );
  for (const name of ["../outside", "/absolute", "a/../b", "a//b", "a\\b", "a:b", "./file"])
    assert.throws(() => readProofZip(zip([{ name, content: Buffer.from("x") }])));
  assert.throws(() =>
    readProofZip(zip([{ name: "link", content: Buffer.from("target"), mode: 0xa1ff }])),
  );
  assert.throws(() =>
    readProofZip(
      zip([
        { name: "A", content: Buffer.from("x") },
        { name: "a", content: Buffer.from("x") },
      ]),
    ),
  );
  const corrupt = zip([{ name: "a", content: Buffer.from("x") }]);
  corrupt[31] = 0;
  assert.throws(() => readProofZip(corrupt));
  const encrypted = zip([{ name: "a", content: Buffer.from("x") }]);
  encrypted.writeUInt16LE(1, 6);
  assert.throws(() => readProofZip(encrypted));
  assert.throws(() => readProofZip(Buffer.alloc(16 * 1024 * 1024 + 1)));
  assert.throws(() =>
    readProofZip(
      zip(Array.from({ length: 65 }, (_, i) => ({ name: String(i), content: Buffer.alloc(0) }))),
    ),
  );
});

test("transactional store dispatches once, fences edits/replays and expires unknown outcomes", () => {
  const storage = new MemoryDurableStorage(),
    store = new CommandProofRequestStore(storage);
  store.ensureSchemaSync();
  const { claim } = proofFixture(),
    now = Date.now();
  const first = store.claim(claim, now);
  assert.equal(first.accepted, true);
  assert.equal(first.dispatch, true);
  assert.equal(store.claim(claim, now).dispatch, false);
  assert.equal(store.claim({ ...claim, headSha: "e".repeat(40) }, now).accepted, false);
  assert.equal(store.claim({ ...claim, requestId: "e".repeat(64) }, now).dispatch, false);
  assert.equal(
    store.claim({ ...claim, requestId: "e".repeat(64), pullRequest: 43 }, now).accepted,
    false,
  );
  store.update({ requestId: claim.requestId, operation: "dispatched", runId: "300" }, now);
  assert.equal(
    store.update({ requestId: claim.requestId, operation: "dispatched", runId: "301" }, now),
    null,
  );
  assert.equal(store.pending(now)[0]?.runId, "300");
  store.update({ requestId: claim.requestId, operation: "defer", retryAt: now + 900000 }, now);
  assert.equal(store.pending(now + 1000).length, 0);
  assert.equal(store.pending(now + 900001).length, 1);
  assert.equal(store.pending(now + 3600001)[0]?.state, "inconclusive");
  assert.equal(store.claim(claim, now + 3600001).dispatch, false);
  store.update({ requestId: claim.requestId, operation: "notified" }, now + 3600001);
  assert.equal(store.pending(now + 3600001).length, 0);
});

test("expired proof clears reconciliation backoff once and honors new terminal notification deferral", () => {
  for (const activeState of ["dispatch_claimed", "review_pending"]) {
    const storage = new MemoryDurableStorage();
    try {
      const store = new CommandProofRequestStore(storage);
      store.ensureSchemaSync();
      const { claim } = proofFixture();
      const now = Date.now();
      const claimed = store.claim(claim, now);
      assert.equal(claimed.dispatch, true);
      const deadline = store.get(claim.requestId)!.expiresAt;
      if (activeState === "review_pending") {
        store.update(
          {
            requestId: claim.requestId,
            operation: "verified",
            result: {
              outcome: "pass",
              digest: digest("evidence"),
              reviewContext: "independent review context",
              runId: "300",
              runAttempt: 1,
            },
          },
          now,
        );
      }
      const oldRetryAt = deadline + 300_000;
      store.update({ requestId: claim.requestId, operation: "defer", retryAt: oldRetryAt }, now);
      assert.equal(store.get(claim.requestId)?.state, activeState);
      assert.deepEqual(store.pending(deadline - 1), []);
      assert.equal(store.claim(claim, deadline - 1).dispatch, false);
      const expired = store.pending(deadline);
      assert.equal(expired.length, 1);
      assert.equal(expired[0]?.claim.requestId, claim.requestId);
      assert.equal(expired[0]?.state, "inconclusive");
      assert.equal(expired[0]?.reason, "proof_deadline_expired");
      assert.notEqual(expired[0]?.notified, true);
      assert.equal(Object.hasOwn(expired[0]!, "nextAttemptAt"), false);
      assert.equal(store.claim(claim, deadline).dispatch, false);
      const notificationRetryAt = deadline + 60_000;
      store.update(
        { requestId: claim.requestId, operation: "defer", retryAt: notificationRetryAt },
        deadline + 1,
      );
      assert.deepEqual(store.pending(deadline + 2), []);
      assert.deepEqual(store.pending(notificationRetryAt - 1), []);
      assert.equal(store.get(claim.requestId)?.nextAttemptAt, notificationRetryAt);
      assert.equal(store.claim(claim, notificationRetryAt - 1).dispatch, false);
      const due = store.pending(notificationRetryAt);
      assert.equal(due.length, 1);
      assert.equal(due[0]?.state, "inconclusive");
      assert.notEqual(due[0]?.notified, true);
      store.update({ requestId: claim.requestId, operation: "notified" }, notificationRetryAt);
      assert.equal(store.get(claim.requestId)?.notified, true);
      assert.deepEqual(store.pending(notificationRetryAt), []);
      assert.deepEqual(store.pending(oldRetryAt + 1), []);
      assert.equal(store.claim(claim, oldRetryAt + 1).dispatch, false);
    } finally {
      storage.sql.close();
    }
  }
});

test("immutable proof claims require a base commit and cannot redispatch the same command after base advance", () => {
  const { claim } = proofFixture();
  const unbound = { ...claim } as Record<string, unknown>;
  delete unbound.baseSha;
  assert.equal(parseCommandProofClaim(unbound), null);
  for (const baseSha of ["unknown", "C".repeat(40), "c".repeat(39)])
    assert.equal(parseCommandProofClaim({ ...claim, baseSha }), null);
  const storage = new MemoryDurableStorage();
  try {
    const store = new CommandProofRequestStore(storage);
    store.ensureSchemaSync();
    const now = Date.now();
    assert.equal(store.claim(claim, now).dispatch, true);
    const advanced = {
      ...claim,
      requestId: digest("advanced base request"),
      baseSha: "e".repeat(40),
    };
    assert.deepEqual(store.claim(advanced, now), {
      accepted: false,
      reason: "proof_target_binding_changed",
    });
    store.update(
      { requestId: claim.requestId, operation: "inconclusive", reason: "base moved" },
      now,
    );
    assert.deepEqual(store.claim(advanced, now), {
      accepted: false,
      reason: "proof_target_binding_changed",
    });
    assert.equal(store.get(claim.requestId)?.claim.baseSha, claim.baseSha);
    assert.equal(store.get(advanced.requestId), null);
  } finally {
    storage.sql.close();
  }
});

test("immutable human command replay rejects mutable target and producer drift after terminal claims", () => {
  for (const terminal of ["completed", "inconclusive"]) {
    for (const legacyKey of [false, true]) {
      const { claim } = proofFixture();
      const storage = new MemoryDurableStorage();
      try {
        const store = new CommandProofRequestStore(storage);
        store.ensureSchemaSync();
        const now = Date.now();
        assert.equal(store.claim(claim, now).dispatch, true);
        const storedKey = [
          ...storage.sql.exec(
            "SELECT target_key FROM command_proof_requests_v1 WHERE request_id = ?",
            claim.requestId,
          ),
        ][0]!.target_key;
        assert.equal(
          storedKey,
          JSON.stringify([
            claim.repositoryId,
            claim.pullRequest,
            claim.sourceCommentId,
            Date.parse(claim.sourceCommentUpdatedAt),
            claim.sourceCommentBodySha256,
          ]),
        );
        if (terminal === "completed") {
          store.update(
            {
              requestId: claim.requestId,
              operation: "verified",
              result: {
                outcome: "pass",
                digest: digest("evidence"),
                reviewContext: "independent review context",
                runId: "300",
                runAttempt: 1,
              },
            },
            now,
          );
          store.update(
            { requestId: claim.requestId, operation: "enqueued", digest: digest("evidence") },
            now,
          );
        } else {
          store.update(
            { requestId: claim.requestId, operation: "inconclusive", reason: "terminal fixture" },
            now,
          );
        }
        assert.equal(store.get(claim.requestId)?.state, terminal);
        if (legacyKey)
          storage.sql.exec(
            "UPDATE command_proof_requests_v1 SET target_key = ? WHERE request_id = ?",
            "legacy-mutable-target-key",
            claim.requestId,
          );
        const changes = [
          { bodySha256: digest("edited PR body") },
          { headSha: "e".repeat(40) },
          { baseSha: "e".repeat(40) },
          { targetBranch: "release" },
          { workflowSha: "f".repeat(40), harnessSha: "f".repeat(40) },
          { workflowRef: "new-producer-ref" },
        ];
        for (const [index, patch] of changes.entries()) {
          const retried = { ...claim, ...patch, requestId: digest("drift-" + index) };
          assert.deepEqual(store.claim(retried, now), {
            accepted: false,
            reason: "proof_target_binding_changed",
          });
          assert.equal(store.get(retried.requestId), null);
        }
        assert.equal(
          store.claim({ ...claim, requestId: digest("same binding retry") }, now).dispatch,
          false,
        );
        assert.equal(
          [...storage.sql.exec("SELECT count(*) AS count FROM command_proof_requests_v1")][0]!
            .count,
          1,
        );
        const newCommand = {
          ...claim,
          requestId: digest("new explicit command version"),
          sourceCommentUpdatedAt: new Date(
            Date.parse(claim.sourceCommentUpdatedAt) + 1000,
          ).toISOString(),
          sourceCommentBodySha256: digest("new human command version"),
        };
        assert.equal(store.claim(newCommand, now + 1000).dispatch, true);
        assert.equal(store.claim(newCommand, now + 1000).dispatch, false);
      } finally {
        storage.sql.close();
      }
    }
  }
});

test("queued proof assessment binds the hydrated base even when head and body stay unchanged", () => {
  const fixture = proofFixture();
  const verified = verifyCommandProof(fixture);
  if (verified.outcome === "inconclusive") throw new Error(verified.reason);
  const binding = commandProofBinding(verified.reviewContext)!;
  assert.equal(binding.baseRefSha256, digest("main"));
  assert.equal(binding.baseSha, fixture.claim.baseSha);
  assert.doesNotThrow(() =>
    assertCommandProofSubject(
      binding,
      fixture.claim.headSha,
      fixture.live.pull,
      "main",
      "e".repeat(40),
    ),
  );
  assert.equal(
    commandProofBinding(verified.reviewContext.replace(" base_sha=" + fixture.claim.baseSha, "")),
    null,
  );
  assertCommandProofSubject(
    binding,
    fixture.claim.headSha,
    fixture.live.pull,
    "main",
    "c".repeat(40),
  );
  for (const base of ["release", undefined, "", "x".repeat(201)]) {
    assert.throws(
      () =>
        assertCommandProofSubject(
          binding,
          fixture.claim.headSha,
          fixture.live.pull,
          base,
          "c".repeat(40),
        ),
      /subject changed/,
    );
  }
  assert.equal(commandProofBaseRefSha256("release/日本語"), digest("release/日本語"));
  assert.equal(commandProofBaseRefSha256("x".repeat(200)), digest("x".repeat(200)));
  for (const base of [undefined, null, 123, "", "x".repeat(201), "bad" + String.fromCharCode(0)]) {
    assert.equal(commandProofBaseRefSha256(base), null);
  }
  assert.equal(
    commandProofBinding(verified.reviewContext.replace(" base=" + binding.baseRefSha256, "")),
    null,
  );
  assert.equal(
    commandProofBinding(verified.reviewContext.replace(binding.baseRefSha256, "f".repeat(65))),
    null,
  );
});

test("reviewed primary-body provenance retains the full captured source hash", () => {
  const source = "x".repeat(20000);
  const compact = compactPrimaryBody(source);
  assert.equal(primaryBodySourceSha256({ body: "short body" }), digest("short body"));
  assert.equal(primaryBodySourceSha256({ body: null }), digest(""));
  assert.equal(primaryBodySourceSha256(compact), digest(source));
  assert.notEqual(digest(compact.body), digest(source));
  assert.equal(primaryBodySourceSha256({}), null);
  assert.equal(
    primaryBodySourceSha256({ body: "prefix", bodyCoverage: { sourceBodySha256: "unknown" } }),
    null,
  );
  assertCommandProofSubject(
    {
      headSha: "a".repeat(40),
      bodySha256: digest(source),
      baseRefSha256: digest("main"),
      baseSha: "c".repeat(40),
      requestId: digest("proof request"),
      scenario: "web-ui-chat-proof",
    },
    "a".repeat(40),
    compact,
    "main",
    "c".repeat(40),
  );
});
