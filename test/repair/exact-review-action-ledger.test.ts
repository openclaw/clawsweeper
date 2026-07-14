import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readSpooledActionEvents } from "../../dist/action-ledger.js";
import {
  exactReviewQueueHttpOutcome,
  runExactReviewQueueCommand,
} from "../../dist/repair/exact-review-action-ledger.js";
import { finalizeRepairActionLedgerManifest } from "../../dist/repair/repair-action-ledger-manifest.js";
import { readText } from "../helpers.ts";

test("exact-review enqueue retries preserve business identity and redact request data", async () => {
  await withLedgerEnvironment(async (root) => {
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    const secret = "webhook-secret-do-not-persist";
    const privateUrl = "https://queue.private.example";
    const prompt = "private operator prompt";
    let call = 0;

    await runExactReviewQueueCommand(
      "enqueue",
      {
        ...process.env,
        CLIENT_PAYLOAD: JSON.stringify({
          target_repo: "openclaw/openclaw",
          item_number: 42,
          item_kind: "issue",
          source_event: "issues",
          source_action: "opened",
          dispatch_key: "delivery-private-42",
          source_comment_id: 456,
          additional_prompt: prompt,
        }),
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        QUEUE_URL: privateUrl,
      },
      {
        attempts: 2,
        sleep: async () => undefined,
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          call += 1;
          return call === 1
            ? new Response("", { status: 503 })
            : Response.json({ ok: true, queued: true }, { status: 202 });
        },
      },
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, `${privateUrl}/internal/exact-review/enqueue`);
    const payload = JSON.parse(requests[0]?.body ?? "{}");
    assert.deepEqual(payload, {
      delivery_id: "router:delivery-private-42",
      decision: {
        targetRepo: "openclaw/openclaw",
        targetBranch: "main",
        itemNumber: 42,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: "opened",
        supersedesInProgress: false,
        sourceCommentId: 456,
        additionalPrompt: prompt,
      },
    });
    const expectedSignature = `sha256=${createHmac("sha256", secret)
      .update(requests[0]?.body ?? "")
      .digest("hex")}`;
    assert.equal(
      requests[0]?.headers.get("x-clawsweeper-exact-review-signature"),
      expectedSignature,
    );

    const events = readSpooledActionEvents(root, "openclaw/openclaw")
      .filter((event) => event.producer.component.startsWith("exact_review_queue_enqueue."))
      .sort((left, right) => left.phase_seq - right.phase_seq);
    assert.deepEqual(
      events.map((event) => event.attributes?.completion_reason),
      ["mutation_attempted", "mutation_outcome_unknown", "mutation_attempted", "mutation_accepted"],
    );
    assert.equal(new Set(events.map((event) => event.idempotency_key_sha256)).size, 1);
    assert.equal(events[1]?.action.retryable, true);
    assert.equal(events[3]?.action.retryable, false);
    const serialized = JSON.stringify(events);
    for (const confidential of [secret, privateUrl, prompt, "delivery-private-42"]) {
      assert.doesNotMatch(serialized, new RegExp(escapeRegExp(confidential)));
    }
  });
});

test("exact-review enqueue rejects unacknowledged success responses", async () => {
  await withLedgerEnvironment(async () => {
    await assert.rejects(
      runExactReviewQueueCommand(
        "enqueue",
        {
          ...process.env,
          CLIENT_PAYLOAD: JSON.stringify({
            target_repo: "openclaw/openclaw",
            item_number: 42,
            item_kind: "issue",
            source_event: "issues",
            source_action: "failed_review_shard_recovery",
            dispatch_key: "recovery-42",
          }),
          CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
          QUEUE_URL: "https://queue.private.example",
        },
        {
          attempts: 1,
          fetch: async () => Response.json({ ok: true }, { status: 202 }),
        },
      ),
      /request failed after 1 attempts/,
    );
  });
});

test("exact-review enqueue accepts an explicit disabled-target acknowledgement", async () => {
  await withLedgerEnvironment(async () => {
    await runExactReviewQueueCommand(
      "enqueue",
      {
        ...process.env,
        CLIENT_PAYLOAD: JSON.stringify({
          target_repo: "openclaw/openclaw",
          item_number: 42,
          item_kind: "issue",
          source_event: "issues",
          source_action: "failed_review_shard_recovery",
          dispatch_key: "recovery-disabled-42",
        }),
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        QUEUE_URL: "https://queue.private.example",
      },
      {
        attempts: 1,
        fetch: async () => Response.json({ ok: true, accepted: false }, { status: 202 }),
      },
    );
  });
});

test("exact-review claim preserves the protocol-v2 request and response contract", async () => {
  await withLedgerEnvironment(async (root) => {
    let capturedBody = "";
    const decision = {
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      itemNumber: 77,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "synchronize",
      supersedesInProgress: true,
      additionalPrompt: "private queue context",
    };
    const outputs = await runExactReviewQueueCommand(
      "claim",
      {
        ...process.env,
        DISPATCH_PAYLOAD: JSON.stringify({}),
        ITEM_KEY: "openclaw/openclaw#77",
        QUEUE_LEASE_ID: "lease-private-77",
        QUEUE_LEASE_REVISION: "9",
        QUEUE_URL: "https://queue.private.example",
        RUN_ATTEMPT: "3",
      },
      {
        attempts: 1,
        fetch: async (_input, init) => {
          capturedBody = String(init?.body);
          return Response.json({
            claimed: true,
            protocol_version: 2,
            item_key: "openclaw/openclaw#77",
            lease_revision: 9,
            claim_generation: 4,
            decision,
          });
        },
      },
    );

    assert.deepEqual(JSON.parse(capturedBody), {
      lease_id: "lease-private-77",
      item_key: "openclaw/openclaw#77",
      lease_revision: 9,
      run_id: "4242",
      run_attempt: 3,
    });
    assert.deepEqual(outputs, {
      lease_id: "lease-private-77",
      item_key: "openclaw/openclaw#77",
      lease_revision: "9",
      claim_generation: "4",
      protocol_version: "2",
      decision: JSON.stringify(decision),
    });

    const events = readSpooledActionEvents(root, "openclaw/openclaw")
      .filter((event) => event.producer.component.startsWith("exact_review_queue_claim."))
      .sort((left, right) => left.phase_seq - right.phase_seq);
    assert.deepEqual(
      events.map((event) => event.attributes?.completion_reason),
      ["mutation_attempted", "mutation_accepted"],
    );
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /lease-private-77/);
    assert.doesNotMatch(serialized, /private queue context/);
    assert.doesNotMatch(serialized, /queue\.private\.example/);
  });
});

test("exact-review claim stops streaming once the response limit is exceeded", async () => {
  await withLedgerEnvironment(async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(600 * 1024).fill(0x61);
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    await assert.rejects(
      runExactReviewQueueCommand(
        "claim",
        {
          ...process.env,
          DISPATCH_PAYLOAD: JSON.stringify({}),
          ITEM_KEY: "openclaw/openclaw#77",
          QUEUE_LEASE_ID: "lease-private-77",
          QUEUE_LEASE_REVISION: "9",
          QUEUE_URL: "https://queue.private.example",
          RUN_ATTEMPT: "3",
        },
        {
          attempts: 1,
          fetch: async () => new Response(body, { status: 200 }),
        },
      ),
      /request failed after 1 attempts/,
    );

    assert.equal(pulls, 2);
    assert.equal(cancelled, true);
  });
});

test("exact-review claim and completion share one isolated durable manifest", async () => {
  await withLedgerEnvironment(async (root) => {
    const genericOutputRoot = process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT!;
    const queueSpoolRoot = path.join(root, "exact-review-queue-spool");
    const queueOutputRoot = path.join(root, "exact-review-queue-output");
    Object.assign(process.env, {
      CLAWSWEEPER_ACTION_LEDGER_ROOT: queueSpoolRoot,
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: queueOutputRoot,
    });
    const decision = {
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      itemNumber: 77,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "edited",
      supersedesInProgress: false,
    };
    const claimOutputs = await runExactReviewQueueCommand(
      "claim",
      {
        ...process.env,
        DISPATCH_PAYLOAD: JSON.stringify({}),
        ITEM_KEY: "openclaw/openclaw#77",
        QUEUE_LEASE_ID: "lease-private-77",
        QUEUE_LEASE_REVISION: "9",
        QUEUE_URL: "https://queue.private.example",
        RUN_ATTEMPT: "3",
      },
      {
        attempts: 1,
        fetch: async () =>
          Response.json({
            claimed: true,
            protocol_version: 2,
            item_key: "openclaw/openclaw#77",
            lease_revision: 9,
            claim_generation: 4,
            decision,
          }),
      },
    );
    await runExactReviewQueueCommand(
      "complete",
      {
        ...process.env,
        CLAIM_GENERATION: claimOutputs.claim_generation,
        ITEM_KEY: claimOutputs.item_key,
        PRIMARY_OUTCOME: "success",
        PROTOCOL_VERSION: claimOutputs.protocol_version,
        QUEUE_LEASE_ID: claimOutputs.lease_id,
        QUEUE_LEASE_REVISION: claimOutputs.lease_revision,
        QUEUE_URL: "https://queue.private.example",
        REQUEUE_LATEST: "false",
        RUN_ATTEMPT: "3",
      },
      {
        attempts: 1,
        fetch: async () => Response.json({ ok: true }),
      },
    );

    const manifest = await finalizeRepairActionLedgerManifest("exact-review-queue");
    assert.ok(manifest.event_paths.length > 0);
    const events = manifest.event_paths.flatMap((relativePath) =>
      fs
        .readFileSync(path.join(queueOutputRoot, relativePath), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    const queueComponents = events
      .map((event) => String(event.producer.component))
      .filter((component) => component.startsWith("exact_review_queue_"));
    assert.equal(queueComponents.filter((component) => component.includes("_claim.")).length, 2);
    assert.equal(queueComponents.filter((component) => component.includes("_complete.")).length, 2);
    assert.equal(
      readSpooledActionEvents(root, "openclaw/openclaw").filter((event) =>
        event.producer.component.startsWith("exact_review_queue_"),
      ).length,
      0,
    );
    assert.equal(fs.existsSync(path.join(genericOutputRoot, "ledger")), false);
  });
});

test("exact-review unknown failures remain finalizable and retryable", async () => {
  await withLedgerEnvironment(async (root) => {
    await assert.rejects(
      runExactReviewQueueCommand(
        "claim",
        {
          ...process.env,
          DISPATCH_PAYLOAD: JSON.stringify({
            target_repo: "openclaw/openclaw",
            item_number: 91,
          }),
          ITEM_KEY: "openclaw/openclaw#91",
          QUEUE_LEASE_ID: "lease-private-91",
          QUEUE_LEASE_REVISION: "2",
          QUEUE_URL: "https://queue.private.example",
          RUN_ATTEMPT: "3",
        },
        {
          attempts: 1,
          fetch: async () => new Response("", { status: 503 }),
        },
      ),
      /request failed after 1 attempts/,
    );
    const manifest = await finalizeRepairActionLedgerManifest("exact-review-queue");
    const events = manifest.event_paths.flatMap((relativePath) =>
      fs
        .readFileSync(path.join(process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT!, relativePath))
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    assert.deepEqual(
      events.map((event) => event.attributes?.completion_reason),
      ["mutation_attempted", "mutation_outcome_unknown"],
    );
    assert.equal(events[1]?.action.retryable, true);
    assert.equal(fs.existsSync(root), true);
  });
});

test("exact-review completion and reconciliation emit accepted mutation boundaries", async () => {
  await withLedgerEnvironment(async (root) => {
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    const secret = "reconcile-secret-do-not-persist";
    const privateUrl = "https://queue.private.example";
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return Response.json({ ok: true });
    };

    await runExactReviewQueueCommand(
      "complete",
      {
        ...process.env,
        CLAIM_GENERATION: "5",
        ITEM_KEY: "openclaw/openclaw#88",
        PRIMARY_OUTCOME: "cancelled",
        PROTOCOL_VERSION: "2",
        QUEUE_LEASE_ID: "lease-private-88",
        QUEUE_LEASE_REVISION: "11",
        QUEUE_URL: privateUrl,
        REQUEUE_LATEST: "false",
        RETRY_AT: "2026-07-13T21:00:00Z",
        RUN_ATTEMPT: "3",
      },
      { attempts: 1, fetch },
    );
    await runExactReviewQueueCommand(
      "reconcile",
      {
        ...process.env,
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        QUEUE_URL: privateUrl,
        SOURCE_RUN_ATTEMPT: "3",
        SOURCE_RUN_ID: "4242",
      },
      { attempts: 1, fetch },
    );

    assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
      lease_id: "lease-private-88",
      item_key: "openclaw/openclaw#88",
      lease_revision: 11,
      claim_generation: 5,
      run_id: "4242",
      run_attempt: 3,
      outcome: "cancelled",
      retry_at: "2026-07-13T21:00:00Z",
    });
    assert.deepEqual(JSON.parse(requests[1]?.body ?? "{}"), {
      runs: [{ run_id: "4242", run_attempt: 3 }],
      include_all_claimed: true,
    });
    assert.equal(
      requests[1]?.headers.get("x-clawsweeper-exact-review-signature"),
      `sha256=${createHmac("sha256", secret)
        .update(requests[1]?.body ?? "")
        .digest("hex")}`,
    );

    const events = [
      ...readSpooledActionEvents(root, "openclaw/openclaw"),
      ...readSpooledActionEvents(root, "openclaw/clawsweeper"),
    ].filter((event) => event.producer.component.startsWith("exact_review_queue_"));
    for (const component of ["complete", "reconcile"]) {
      const componentEvents = events
        .filter((event) => event.producer.component.startsWith(`exact_review_queue_${component}.`))
        .sort((left, right) => left.phase_seq - right.phase_seq);
      assert.deepEqual(
        componentEvents.map((event) => event.attributes?.completion_reason),
        ["mutation_attempted", "mutation_accepted"],
      );
    }
    const serialized = JSON.stringify(events);
    for (const confidential of [secret, privateUrl, "lease-private-88"]) {
      assert.doesNotMatch(serialized, new RegExp(escapeRegExp(confidential)));
    }
  });
});

test("exact-review HTTP outcomes preserve retryable uncertainty", () => {
  assert.equal(exactReviewQueueHttpOutcome({ ok: true, status: 202 }), "accepted");
  assert.equal(exactReviewQueueHttpOutcome({ ok: false, status: 409 }), "rejected");
  assert.equal(exactReviewQueueHttpOutcome({ ok: false, status: 429 }), "unknown");
  assert.equal(exactReviewQueueHttpOutcome({ ok: false, status: 503 }), "unknown");
});

test("exact-review workflows isolate state credentials and publish exact manifests", () => {
  const sweep = readText(".github/workflows/sweep.yml");
  const reconcile = readText(".github/workflows/exact-review-reconcile.yml");
  const legacy = workflowJob(sweep, "legacy-event-queue-intake", "event-review-apply");
  const event = workflowJob(sweep, "event-review-apply", "publish-exact-review-action-ledger");
  const publisher = workflowJob(sweep, "publish-exact-review-action-ledger", "target-fanout");
  const reconcileProducer = workflowJob(reconcile, "reconcile", "publish-ledger");
  const reconcilePublisher = reconcile.slice(reconcile.indexOf("\n  publish-ledger:"));

  assert.match(legacy, /exact-review-action-ledger-cli\.js enqueue/);
  assert.match(event, /exact-review-action-ledger-cli\.js claim/);
  assert.match(event, /exact-review-action-ledger-cli\.js complete/);
  for (const [producer, setupPnpmId, mutationName] of [
    [legacy, "exact-review-pnpm", "Enqueue legacy event through the durable control plane"],
    [event, "setup-pnpm", "Claim exact-review queue lease"],
  ] as const) {
    assert.doesNotMatch(
      producer,
      /uses: \.\/\.github\/actions\/setup-action-ledger\s+id: exact-review-action-ledger\s+continue-on-error: true/,
    );
    assert.match(
      producer,
      new RegExp(
        `${escapeRegExp(mutationName)}[\\s\\S]*?if: \\$\\{\\{ steps\\.exact-review-action-ledger\\.outcome == 'success' && steps\\.${setupPnpmId}\\.outcome == 'success' \\}\\}`,
      ),
    );
  }
  assert.match(reconcileProducer, /exact-review-action-ledger-cli\.js reconcile/);
  assert.match(reconcileProducer, /actions\/checkout@v7\s+with:\s+ref: \$\{\{ github\.sha \}\}/);
  assert.match(
    reconcileProducer,
    /Verify reconciler source revision[\s\S]*test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/,
  );
  for (const producer of [legacy, event, reconcileProducer]) {
    assert.match(producer, /--repair-lane exact-review-queue/);
    assert.match(producer, /actions\/upload-artifact@v7/);
  }
  assert.doesNotMatch(legacy, /create-state-token|setup-state/);
  assert.doesNotMatch(reconcileProducer, /create-state-token|setup-state/);
  assert.ok(event.indexOf("Claim exact-review queue lease") < event.indexOf("Create state token"));
  assert.ok(
    event.indexOf("Publish exact event action ledger") <
      event.indexOf("Complete exact-review queue lease"),
  );
  assert.match(
    event,
    /Complete exact-review queue lease[\s\S]*steps\.finalize-exact-event-action-ledger\.outcome == 'success'/,
  );
  const completion = event.slice(
    event.indexOf("- name: Complete exact-review queue lease"),
    event.indexOf("- name: Finalize exact-review queue action ledger"),
  );
  for (const terminalNoop of [
    "steps.target.outputs.target_enabled == 'false'",
    "steps.live-item.outputs.terminal_noop == 'true'",
    "steps.live-item.outputs.terminal_missing == 'true'",
    "steps.live-item.outputs.guarded_open == 'true'",
  ]) {
    assert.match(completion, new RegExp(escapeRegExp(terminalNoop)));
  }
  assert.match(completion, /steps\.publish-exact-event-action-ledger\.outcome == 'success'/);
  assert.ok(
    event.indexOf("Complete exact-review queue lease") <
      event.indexOf("Finalize exact-review queue action ledger"),
  );
  for (const queueProducer of [legacy, event, reconcileProducer]) {
    assert.match(
      queueProducer,
      /CLAWSWEEPER_ACTION_LEDGER_ROOT: \$\{\{ steps\.exact-review-action-ledger\.outputs\.output-root \|\| runner\.temp \}\}\/exact-review-queue-spool/,
    );
    assert.match(
      queueProducer,
      /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: \$\{\{ steps\.exact-review-action-ledger\.outputs\.output-root \|\| runner\.temp \}\}\/exact-review-queue-output/,
    );
    assert.match(
      queueProducer,
      /if: \$\{\{ always\(\).*steps\.(?:setup-pnpm|exact-review-pnpm)\.outcome == 'success'/,
    );
    assert.match(queueProducer, /exact-review-queue-output\/\*\*/);
  }
  assert.match(
    event,
    /Publish exact event action ledger[\s\S]*--source-root "\$CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT"/,
  );

  for (const [trustedPublisher, expectedRunAttempt] of [
    [publisher, "GITHUB_RUN_ATTEMPT"],
    [reconcilePublisher, "PRODUCER_RUN_ATTEMPT"],
  ] as const) {
    assert.match(trustedPublisher, /create-state-token/);
    assert.match(trustedPublisher, /repair:action-ledger -- publish/);
    assert.match(trustedPublisher, /--expected-repository "\$GITHUB_REPOSITORY"/);
    assert.match(trustedPublisher, /--expected-sha "\$GITHUB_SHA"/);
    assert.match(trustedPublisher, /--expected-run-id "\$GITHUB_RUN_ID"/);
    assert.match(trustedPublisher, new RegExp(`--expected-run-attempt "\\$${expectedRunAttempt}"`));
    assert.match(trustedPublisher, /publish-action-event-paths/);
    assert.doesNotMatch(trustedPublisher, /github\.event\.client_payload/);
  }
  assert.match(reconcilePublisher, /actions\/checkout@v7\s+with:\s+ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(sweep, /internal\/exact-review\/(?:enqueue|claim|complete)/);
  assert.doesNotMatch(reconcile, /internal\/exact-review\/reconcile/);
});

async function withLedgerEnvironment(run: (root: string) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exact-review-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    GITHUB_ACTION: "exact_review",
    GITHUB_JOB: "event-review-apply",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "3",
    GITHUB_RUN_ID: "4242",
    GITHUB_RUN_STARTED_AT: "2026-07-13T20:00:00Z",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "ClawSweeper",
    GITHUB_WORKFLOW_REF: "openclaw/clawsweeper/.github/workflows/sweep.yml@refs/heads/main",
  });
  try {
    await run(root);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
}

function workflowJob(source: string, job: string, nextJob: string): string {
  const start = source.indexOf(`\n  ${job}:`);
  const end = source.indexOf(`\n  ${nextJob}:`, start + 1);
  assert.ok(start >= 0, `missing workflow job ${job}`);
  assert.ok(end > start, `missing workflow job after ${job}`);
  return source.slice(start, end);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
