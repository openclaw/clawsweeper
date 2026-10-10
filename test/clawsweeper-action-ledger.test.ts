import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import test, { after, type TestContext } from "node:test";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import {
  actionLedgerFailureDisposition,
  applyActionEventDisposition,
  applyRuntimeBudgetYieldResultsForTest,
  codexReviewFailureRetryableForTest,
  heldReviewStartStatusCommentResultForTest,
  main,
  renderReviewStartStatusComment,
  reviewCommentPublicationEventDisposition,
  reviewRetryActionDisposition,
  reviewRetryBatchEventDisposition,
  reviewRetryBusinessIdempotencyIdentityForTest,
} from "../dist/clawsweeper.js";
import {
  ghObservedMutationCommand,
  ghRawOnceWithCheckpoint,
  GitHubDispatchError,
  withMutationReceiptRunner,
} from "../dist/clawsweeper-github-execution.js";
import {
  untrustedCodexEnv,
  withGitHubRun,
  withGitHubRuntimeBudget,
} from "../dist/clawsweeper-github-runtime.js";
import { githubTest, installGhFixture } from "./github-runtime-fixture.ts";
import { itemSourceRevisionSha256 } from "../dist/clawsweeper-source-revision.js";
import { labelAlreadyExistsError } from "../dist/clawsweeper-label-mutations.js";
import {
  ACTION_EVENT_TYPES,
  actionIdempotencyKey,
  readAllSpooledActionEvents,
  type ActionEvent,
} from "../dist/action-ledger.js";
import { createApplyActionLedger } from "../dist/clawsweeper-apply-ledger.js";
import { createApplyLeaseGuards } from "../dist/clawsweeper-apply-lease-guards.js";
import { createReviewActionLedger } from "../dist/clawsweeper-review-ledger.js";
import type { Item } from "../dist/clawsweeper-types.js";
import { GitHubRateLimitError } from "../dist/github-retry.js";
import {
  item,
  mockGhBinEnv,
  readText,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withApplyTestWorkspace,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

test("primary command success survives best-effort action ledger flush failure", async (t) => {
  const errors: string[] = [];
  let flushCalls = 0;
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });

  await main(["check"], {
    flushWorkflowActionEvents: async () => {
      flushCalls += 1;
      throw new Error("simulated flush failure");
    },
  });

  assert.equal(flushCalls, 1);
  assert.match(
    errors.join("\n"),
    /\[action-ledger\] best-effort finalization failed after successful check: simulated flush failure/,
  );
});

test("primary command failure is not masked by action ledger flush failure", async (t) => {
  const errors: string[] = [];
  let flushCalls = 0;
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });

  await assert.rejects(
    main(["unknown-primary-command"], {
      flushWorkflowActionEvents: async () => {
        flushCalls += 1;
        throw new Error("simulated flush failure");
      },
    }),
    (error: unknown) => {
      assert.equal(
        error instanceof Error ? error.message : String(error),
        "Unknown command: unknown-primary-command",
      );
      return true;
    },
  );

  assert.equal(flushCalls, 1);
  assert.match(
    errors.join("\n"),
    /\[action-ledger\] best-effort finalization failed after command failure: simulated flush failure/,
  );
});

test("explicit action ledger finalization keeps flush failure strict", async () => {
  await assert.rejects(
    main(["finalize-action-events"], {
      flushWorkflowActionEvents: async () => {
        throw new Error("simulated flush failure");
      },
    }),
    /simulated flush failure/,
  );
});

test("action event import rejects an invalid expected producer run ID", async () => {
  await assert.rejects(
    main([
      "publish-action-events",
      "--expected-producer-job",
      "event-review-apply",
      "--expected-producer-run-id",
      "not-a-run",
    ]),
    /expected-producer-run-id must be a numeric workflow run ID/,
  );
});

test("action event import rejects an invalid maximum producer run attempt", async () => {
  await assert.rejects(
    main([
      "publish-action-events",
      "--expected-producer-job",
      "review",
      "--expected-producer-max-run-attempt",
      "0",
    ]),
    /expected-producer-max-run-attempt must be a positive integer/,
  );
});

test("action event import keeps exact and maximum producer attempts mutually exclusive", async () => {
  await assert.rejects(
    main([
      "publish-action-events",
      "--expected-producer-job",
      "review",
      "--expected-producer-run-attempt",
      "1",
      "--expected-producer-max-run-attempt",
      "2",
    ]),
    /expected-producer-run-attempt and --expected-producer-max-run-attempt are mutually exclusive/,
  );
});

test("action event import rejects an invalid expected producer SHA", async () => {
  await assert.rejects(
    main([
      "publish-action-events",
      "--expected-producer-job",
      "event-review-apply",
      "--expected-producer-sha",
      "not-a-sha",
    ]),
    /expected-producer-sha must be a lowercase commit SHA/,
  );
});

test("review and apply outcome classifiers cover terminal and resumable states", () => {
  assert.deepEqual(actionLedgerFailureDisposition(new Error("worker timed out after 30s")), {
    status: "failed",
    reasonCode: "timeout",
    completionReason: "timeout",
  });
  assert.deepEqual(actionLedgerFailureDisposition(new Error("process interrupted by SIGINT")), {
    status: "cancelled",
    reasonCode: "cancelled",
    completionReason: "interrupted",
  });
  assert.deepEqual(actionLedgerFailureDisposition(new Error("unexpected failure")), {
    status: "failed",
    reasonCode: "exception",
    completionReason: "failed",
  });

  assert.deepEqual(applyActionEventDisposition("closed", true, false), {
    status: "completed",
    reasonCode: "completed",
    retryable: false,
    mutation: true,
    completionReason: "closed",
  });
  assert.deepEqual(applyActionEventDisposition("closed", false, true), {
    status: "planned",
    reasonCode: "dry_run",
    retryable: false,
    mutation: false,
    completionReason: "dry_run",
  });
  assert.deepEqual(applyActionEventDisposition("skipped_runtime_budget", false, false), {
    status: "yielded",
    reasonCode: "runtime_budget",
    retryable: true,
    mutation: false,
    completionReason: "runtime_budget",
  });
  assert.deepEqual(applyActionEventDisposition("skipped_runtime_budget", true, false), {
    status: "yielded",
    reasonCode: "runtime_budget",
    retryable: true,
    mutation: true,
    completionReason: "runtime_budget",
  });
  assert.deepEqual(applyActionEventDisposition("skipped_changed_since_review", false, false), {
    status: "blocked",
    reasonCode: "source_changed",
    retryable: true,
    mutation: false,
    completionReason: "source_changed",
  });
  assert.deepEqual(applyActionEventDisposition("kept_open", true, false), {
    status: "skipped",
    reasonCode: "not_applicable",
    retryable: false,
    mutation: true,
    completionReason: "kept_open",
  });
  assert.deepEqual(applyActionEventDisposition("skipped_protected_label", true, false), {
    status: "skipped",
    reasonCode: "not_applicable",
    retryable: false,
    mutation: true,
    completionReason: "skipped_protected_label",
  });
  assert.deepEqual(reviewCommentPublicationEventDisposition("review_comment_synced", true, false), {
    status: "published",
    reasonCode: "published",
    retryable: false,
    mutation: true,
    completionReason: "comment_published",
  });
  assert.deepEqual(
    reviewCommentPublicationEventDisposition("review_comment_synced", false, false),
    {
      status: "unchanged",
      reasonCode: "content_unchanged",
      retryable: false,
      mutation: false,
      completionReason: "comment_unchanged",
    },
  );
  assert.deepEqual(applyActionEventDisposition("review_comment_synced", true, false, false), {
    status: "unchanged",
    reasonCode: "content_unchanged",
    retryable: false,
    mutation: true,
    completionReason: "comment_unchanged",
  });
  assert.deepEqual(reviewCommentPublicationEventDisposition("skipped_comment_auth", true, false), {
    status: "blocked",
    reasonCode: "authorization_failed",
    retryable: true,
    mutation: false,
    completionReason: "authorization_failed",
  });
  assert.deepEqual(
    reviewCommentPublicationEventDisposition("retry_stale_canonical_comment_sync", false, false),
    {
      status: "waiting",
      reasonCode: "dependency_pending",
      retryable: true,
      mutation: false,
      completionReason: "retry_pending",
    },
  );
});

test("failed-review retry events distinguish dispatch, exhaustion, and backpressure", () => {
  assert.deepEqual(reviewRetryActionDisposition("dispatched_failed_review_retry"), {
    status: "dispatched",
    reasonCode: "retry_scheduled",
    retryable: true,
    mutation: true,
  });
  assert.deepEqual(reviewRetryActionDisposition("marked_failed_review_retry_exhausted"), {
    status: "blocked",
    reasonCode: "retry_exhausted",
    retryable: false,
    mutation: true,
  });
  assert.deepEqual(reviewRetryActionDisposition("skipped_runtime_budget"), {
    status: "yielded",
    reasonCode: "runtime_budget",
    retryable: true,
    mutation: false,
  });
  assert.deepEqual(reviewRetryActionDisposition("skipped_stale_revision"), {
    status: "blocked",
    reasonCode: "source_changed",
    retryable: false,
    mutation: false,
  });
  assert.deepEqual(reviewRetryActionDisposition("skipped_retry_dispatch_uncertain"), {
    status: "failed",
    reasonCode: "unavailable",
    retryable: false,
    mutation: true,
  });
  assert.deepEqual(
    reviewRetryBatchEventDisposition([
      "skipped_dispatch_failed",
      "skipped_retry_dispatch_uncertain",
    ]),
    {
      status: "failed",
      reasonCode: "unavailable",
      retryable: false,
      completionReason: "dispatch_outcome_unknown",
      failedCount: 1,
      partial: true,
    },
  );
});

test("action event publication validates manifests before sending canonical files to the Worker", async (t) => {
  const root = realpathSync(mkdtempSync(tmpPrefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync("dist", join(root, "dist"), { recursive: true });
  for (const entry of CLI_INPUTS.filter((input) => input !== "dist")) {
    symlinkSync(resolve(entry), join(root, entry));
  }
  const paths = [
    "ledger/v1/events/2026/07/12/openclaw-clawsweeper/review/run-part-1-of-1.jsonl",
    `ledger/v1/import-bindings/completed-shard-sets/${"a".repeat(64)}.json`,
    `ledger/v1/import-bindings/events/${"b".repeat(64)}.json`,
    `ledger/v1/import-bindings/producer-runs/${"c".repeat(64)}.json`,
    `ledger/v1/import-bindings/shard-sets/${"d".repeat(64)}.json`,
  ].sort();
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify({ path }));
  }
  const received: Array<{ path: string; contentBase64: string; digest: string }> = [];
  const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ unchanged: received.length === 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const manifest = join(root, "publish-paths.txt");
  const command = [
    join(root, "dist", "clawsweeper.js"),
    "publish-action-event-paths",
    "--paths-file",
    manifest,
  ];
  const options = {
    cwd: root,
    env: {
      ...process.env,
      QUEUE_URL: `http://127.0.0.1:${address.port}`,
      CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-publication-test",
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: join(root, "ledger-output"),
    },
  };
  for (const [content, error] of [
    ["", /manifest is empty/],
    [`${paths[1]}\n${paths[0]}\n`, /sorted and unique/],
    [`${paths[0]}\n${paths[0]}\n`, /sorted and unique/],
    ["ledger/v1/import-bindings/private/raw.json\n", /invalid action event publish path/],
  ] as const) {
    writeFileSync(manifest, content);
    await assert.rejects(promisify(execFile)(process.execPath, command, options), error);
    assert.deepEqual(received, []);
  }
  writeFileSync(manifest, `${paths.join("\n")}\n`);
  const { stdout } = await promisify(execFile)(process.execPath, command, options);
  assert.deepEqual(JSON.parse(stdout), {
    result: "published",
    path_count: paths.length,
    uploaded: paths.length - 1,
    unchanged: 1,
  });
  assert.deepEqual(
    received.map(({ path }) => path),
    paths,
  );
  for (const [index, payload] of received.entries()) {
    const content = readFileSync(join(root, paths[index]!));
    assert.equal(payload.contentBase64, content.toString("base64"));
    assert.equal(payload.digest, createHash("sha256").update(content).digest("hex"));
    assert.deepEqual(requests[index], { method: "POST", url: "/internal/state/blobs/put" });
  }
});

test("retry business idempotency binds source revision and review content", () => {
  const retryIdentity = {
    repository: "openclaw/openclaw",
    number: 512,
    revisionKind: "pull_head_sha" as const,
    sourceRevision: "e".repeat(40),
    reviewContentDigest: "f".repeat(64),
    decisionPacketSha256: "1".repeat(64),
    slot: "retry_dispatch" as const,
  };
  const retryKey = actionIdempotencyKey(
    reviewRetryBusinessIdempotencyIdentityForTest(retryIdentity),
  );
  assert.equal(
    actionIdempotencyKey(
      reviewRetryBusinessIdempotencyIdentityForTest({
        ...retryIdentity,
      }),
    ),
    retryKey,
  );
  assert.notEqual(
    actionIdempotencyKey(
      reviewRetryBusinessIdempotencyIdentityForTest({
        ...retryIdentity,
        sourceRevision: "2".repeat(40),
      }),
    ),
    retryKey,
  );
  assert.notEqual(
    actionIdempotencyKey(
      reviewRetryBusinessIdempotencyIdentityForTest({
        ...retryIdentity,
        reviewContentDigest: "3".repeat(64),
      }),
    ),
    retryKey,
  );
  assert.notEqual(
    actionIdempotencyKey(
      reviewRetryBusinessIdempotencyIdentityForTest({
        ...retryIdentity,
        decisionPacketSha256: "4".repeat(64),
      }),
    ),
    retryKey,
  );
});

const LEDGER_ENV = {
  CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
  CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
  CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
  CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
  GITHUB_REPOSITORY: "openclaw/clawsweeper",
  GITHUB_RUN_ID: "100",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_WORKFLOW: "fixture",
  GITHUB_WORKFLOW_REF: "",
  GITHUB_JOB: "apply",
  GITHUB_SHA: "abc123",
};

// Real review and apply ledgers that write events to a private spool root.
function ledgerFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(tmpPrefix));
  const previousEnv = process.env;
  process.env = { ...previousEnv, ...LEDGER_ENV };
  t.after(() => {
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  });
  const repoRelativePath = (filePath: string) => relative(root, filePath).replaceAll("\\", "/");
  const reviewLedger = createReviewActionLedger({
    root,
    targetRepo: () => "openclaw/openclaw",
    repoRelativePath,
    isRuntimeBudgetError: () => false,
  });
  const applyLedger = createApplyActionLedger({
    root,
    targetRepo: () => "openclaw/openclaw",
    repoRelativePath,
    reviewLedger,
  });
  const entry = (number: number) => {
    const path = join(root, "records", `${number}.md`);
    const markdown = `---\ntype: issue\nitem_source_revision: revision-${number}\n---\n`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, markdown);
    return { name: `${number}.md`, number, path, repo: "openclaw/openclaw", markdown };
  };
  const events = () => readAllSpooledActionEvents(root).sort((a, b) => a.phase_seq - b.phase_seq);
  return { root, reviewLedger, applyLedger, entry, events };
}

function eventSummary(events: readonly ActionEvent[]) {
  return events.map((event) => [
    event.event_type,
    event.action.status,
    event.attributes?.completion_reason,
  ]);
}

test("apply ledger starts items lazily and chains every receipt in phase order", (t) => {
  const { root, applyLedger, entry, events } = ledgerFixture(t);
  const first = entry(41);
  const unprocessed = entry(42);
  const reportPath = join(root, "apply-report.json");
  const batch = {
    applyKind: "all" as const,
    closeReasons: null,
    dryRun: false,
    syncCommentsOnly: false,
    requestedItemNumbers: [],
    reportPath,
  };
  const ledger = applyLedger.startApplyActionLedger({
    ...batch,
    candidates: [first, unprocessed],
  });
  assert.deepEqual(eventSummary(events()), [[ACTION_EVENT_TYPES.applyBatch, "started", undefined]]);

  for (const [attempt, outcome] of [
    [1, "unknown"],
    [2, "accepted"],
  ] as const) {
    const receipt = applyLedger.startApplyMutationAttempt(
      ledger,
      first,
      `label_create:P1:request_attempt:${attempt}`,
      "label_create:P1",
    );
    assert.ok(receipt);
    applyLedger.finishApplyMutationAttempt({ ledger, entry: first, attempt: receipt, outcome });
  }
  const results = [
    {
      number: 41,
      action: "review_comment_synced" as const,
      reason: "updated durable Codex review comment",
      commentMutationOccurred: true,
    },
  ];
  const state = ledger.items.get("openclaw/openclaw#41");
  assert.ok(state);
  applyLedger.recordApplyActionLedgerItemResults({
    ledger,
    state,
    results,
    entry: first,
    mutationOccurred: true,
    dryRun: false,
  });
  writeFileSync(reportPath, JSON.stringify(results));
  applyLedger.recordApplyActionEvents({
    ledger,
    results,
    entries: new Map(),
    mutationByItem: new Map([["openclaw/openclaw#41", true]]),
    dryRun: false,
    reportPath,
  });

  const recorded = events();
  assert.deepEqual(eventSummary(recorded), [
    [ACTION_EVENT_TYPES.applyBatch, "started", undefined],
    [ACTION_EVENT_TYPES.applyAction, "started", "started"],
    [ACTION_EVENT_TYPES.applyAction, "started", "mutation_attempted"],
    [ACTION_EVENT_TYPES.applyAction, "failed", "mutation_outcome_unknown"],
    [ACTION_EVENT_TYPES.applyAction, "started", "mutation_attempted"],
    [ACTION_EVENT_TYPES.applyAction, "executed", "mutation_accepted"],
    [ACTION_EVENT_TYPES.applyAction, "completed", "comment_published"],
    [ACTION_EVENT_TYPES.reviewCommentPublication, "published", "comment_published"],
    [ACTION_EVENT_TYPES.applyBatch, "completed", "completed"],
    [ACTION_EVENT_TYPES.applyPublish, "completed", undefined],
  ]);
  assert.deepEqual(
    recorded.map((event) => event.phase_seq),
    recorded.map((_, index) => index + 1),
  );
  assert.deepEqual(
    recorded.map((event) =>
      recorded.findIndex(({ event_id }) => event_id === event.parent_event_id),
    ),
    [-1, 0, 1, 2, 3, 4, 5, 6, 0, 8],
  );
  const [, itemStart, firstAttempt, , secondAttempt, accepted, result, comment, batchEnd] =
    recorded;
  // Each request attempt has its own receipt, but retries share one business identity.
  assert.notEqual(firstAttempt?.event_id, secondAttempt?.event_id);
  assert.equal(firstAttempt?.idempotency_key_sha256, secondAttempt?.idempotency_key_sha256);
  assert.equal(accepted?.idempotency_key_sha256, secondAttempt?.idempotency_key_sha256);
  // The item identity does not change with the item status.
  assert.equal(result?.idempotency_key_sha256, itemStart?.idempotency_key_sha256);
  assert.deepEqual(
    [result, comment, batchEnd].map((event) => event?.action.mutation),
    [true, true, true],
  );
  // Batch position and checkpoint do not change the business identity of an item;
  // a new source revision does.
  process.env.CLAWSWEEPER_APPLY_CHECKPOINT = "7";
  const revised = { ...first, markdown: first.markdown.replace("revision-41", "revision-41b") };
  for (const candidates of [[unprocessed, first], [revised]]) {
    const ledger = applyLedger.startApplyActionLedger({ ...batch, candidates });
    applyLedger.startApplyActionLedgerItem(ledger, candidates.at(-1) ?? revised);
  }
  assert.deepEqual(
    events()
      .filter((event) => event.attributes?.completion_reason === "started")
      .map((event) => [
        event.subject.source_revision,
        event.idempotency_key_sha256 === itemStart?.idempotency_key_sha256,
      ])
      .sort(),
    [
      ["revision-41", true],
      ["revision-41", true],
      ["revision-41b", false],
    ],
  );
});

test("review ledger starts items lazily and closes every started item", (t) => {
  const { reviewLedger, events } = ledgerFixture(t);
  const active = item({ number: 51 }) as Item;
  const deferred = item({ number: 52 }) as Item;
  const ledger = reviewLedger.startReviewActionLedger({
    candidates: [active, deferred],
    reviewPolicy: "fixture",
    shardIndex: 0,
    shardCount: 1,
    batchSize: 2,
  });
  assert.deepEqual(eventSummary(events()), [
    [ACTION_EVENT_TYPES.reviewBatch, "started", undefined],
  ]);

  reviewLedger.startReviewActionLedgerItem(ledger, active);
  const runMutation = reviewLedger.reviewMutationRunner(ledger, active);
  const request = (attempt: number) => ({
    identity: `review_lease_post:51:request_attempt:${attempt}`,
    idempotencyIdentity: "review_lease_post:51",
  });
  runMutation({ ...request(1), operation: () => true });
  runMutation({ ...request(2), operation: () => false, didMutate: (posted) => posted });
  assert.throws(
    () =>
      runMutation({
        ...request(3),
        operation: () => {
          throw new Error("socket closed");
        },
      }),
    /socket closed/,
  );
  // The run ends while item 51 is still active; the ledger must not leave it open.
  reviewLedger.finishReviewActionLedger({ ledger, completedCount: 0, cacheHits: 0 });

  const recorded = events();
  assert.deepEqual(eventSummary(recorded), [
    [ACTION_EVENT_TYPES.reviewBatch, "started", undefined],
    [ACTION_EVENT_TYPES.reviewItem, "started", undefined],
    [ACTION_EVENT_TYPES.reviewItem, "started", "mutation_attempted"],
    [ACTION_EVENT_TYPES.reviewItem, "executed", "mutation_accepted"],
    [ACTION_EVENT_TYPES.reviewItem, "started", "mutation_attempted"],
    [ACTION_EVENT_TYPES.reviewItem, "skipped", "mutation_rejected"],
    [ACTION_EVENT_TYPES.reviewItem, "started", "mutation_attempted"],
    [ACTION_EVENT_TYPES.reviewItem, "failed", "mutation_outcome_unknown"],
    [ACTION_EVENT_TYPES.reviewLogPublication, "blocked", undefined],
    [ACTION_EVENT_TYPES.reviewItem, "blocked", "coordination_blocked"],
    [ACTION_EVENT_TYPES.reviewBatch, "yielded", "partial"],
  ]);
  assert.deepEqual(
    recorded.map((event) =>
      recorded.findIndex(({ event_id }) => event_id === event.parent_event_id),
    ),
    [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0],
  );
  const attempts = recorded.filter(
    (event) => event.attributes?.completion_reason === "mutation_attempted",
  );
  assert.equal(new Set(attempts.map((event) => event.event_id)).size, 3);
  assert.equal(new Set(attempts.map((event) => event.idempotency_key_sha256)).size, 1);
  const itemEnd = recorded.at(-2);
  const batchEnd = recorded.at(-1);
  // An unknown mutation outcome stays visible and blocks a blind retry.
  assert.deepEqual(
    [itemEnd, batchEnd].map((event) => [event?.action.mutation, event?.action.retryable]),
    [
      [true, false],
      [true, false],
    ],
  );
});

const CLI_INPUTS = ["config", "dist", "node_modules", "package.json", "prompts"];
let cliRoot: string | undefined;
after(() => {
  if (cliRoot) rmSync(cliRoot, { recursive: true, force: true });
});

// Run the built CLI from a private copy, so its ledger spool stays in the fixture root.
// The CLI finds its root from its own path, so dist is a real copy. Each run clears
// the data that the previous run left.
function runCliWithLedger(ghMock: string, args: (root: string) => string[]) {
  if (!cliRoot) {
    cliRoot = realpathSync(mkdtempSync(tmpPrefix));
    cpSync("dist", join(cliRoot, "dist"), { recursive: true });
    for (const entry of CLI_INPUTS.filter((input) => input !== "dist")) {
      symlinkSync(resolve(entry), join(cliRoot, entry));
    }
  }
  const root = cliRoot;
  for (const entry of readdirSync(root).filter((name) => !CLI_INPUTS.includes(name))) {
    rmSync(join(root, entry), { recursive: true, force: true });
  }
  const outputRoot = join(root, "ledger-output");
  mkdirSync(outputRoot);
  const ghPath = join(root, "gh.cjs");
  writeFileSync(ghPath, ghMock);
  const result = spawnSync(
    process.execPath,
    [join(root, "dist", "clawsweeper.js"), ...args(root)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...LEDGER_ENV,
        ...mockGhBinEnv(ghPath),
        CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
      },
    },
  );
  const events = readAllSpooledActionEvents(root).sort((a, b) => a.phase_seq - b.phase_seq);
  return { root, result, events };
}

function syncedIssueReport(number: number, labels: string[]) {
  return reportWithSyncedReviewComment(
    workPlanCandidateReport({
      number,
      reviewed_at: "2026-05-01T00:00:00Z",
      item_snapshot_hash: `reviewed-snapshot-${number}`,
      item_updated_at: "2026-05-01T00:00:00Z",
      labels: JSON.stringify(labels),
    }),
    number,
  );
}

test("apply-decisions records per-request receipts before it finalizes the item", () => {
  const first = syncedIssueReport(321, ["stale"]);
  const second = syncedIssueReport(322, []);
  const ghMock = `
const { readFileSync } = require("fs");
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] === "-i" ? args[2] || "" : args[1] || "";
if (args[0] === "api" && /\\/issues\\/comments\\/9321$/.test(path)) {
  const body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8")).body;
  console.log(JSON.stringify({ id: 9321, html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321", updated_at: "2026-05-01T01:02:00Z", user: { login: "clawsweeper[bot]" }, body }));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{ id: 9321, html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321", created_at: "2026-05-01T01:00:00Z", updated_at: "2026-05-01T01:00:00Z", user: { login: "clawsweeper[bot]" }, body: ${JSON.stringify(first.comment)} }]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({ number: 321, title: "Render work plans", html_url: "https://github.com/openclaw/clawsweeper/issues/321", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z", closed_at: null, state: "open", locked: false, active_lock_reason: null, author_association: "CONTRIBUTOR", user: { login: "reporter" }, labels: ["stale"], pull_request: null }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" && args[1] === "create") {
  console.error('HTTP 422: Validation Failed (label "' + args[2] + '" already exists)');
  process.exit(1);
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
  const { root, result, events } = runCliWithLedger(ghMock, (root) => {
    const itemsDir = join(root, "records", "openclaw-clawsweeper", "items");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "321.md"), first.report);
    writeFileSync(join(itemsDir, "322.md"), second.report);
    return [
      "apply-decisions",
      "--target-repo",
      "openclaw/clawsweeper",
      "--items-dir",
      itemsDir,
      "--closed-dir",
      join(root, "records", "openclaw-clawsweeper", "closed"),
      "--plans-dir",
      join(root, "plans"),
      "--report-path",
      join(root, "apply-report.json"),
      "--processed-limit",
      "1",
      "--close-delay-ms",
      "0",
    ];
  });
  assert.equal(result.status, 0, result.stderr);
  // Item 322 was a candidate but the processed limit stopped the run first.
  assert.deepEqual([...new Set(events.flatMap((event) => event.subject.number ?? []))], [321]);
  // One chain: batch start, item 321 in phase order, batch end, report publication.
  const last = events.length - 1;
  assert.deepEqual(
    events.map((event) => events.findIndex(({ event_id }) => event_id === event.parent_event_id)),
    events.map((_, index) =>
      index === 0 ? -1 : index === last - 1 ? 0 : index === last ? last - 1 : index - 1,
    ),
  );
  // Each GitHub request gets its own receipt, closed by the next event in the chain.
  // A label that already exists is a known no-op, not a mutation. Different requests
  // have different business identities.
  const receipts = events.flatMap((event, index) => {
    if (event.attributes?.completion_reason !== "mutation_attempted") return [];
    const outcome = events[index + 1];
    assert.equal(outcome?.idempotency_key_sha256, event.idempotency_key_sha256);
    return [
      [
        event.idempotency_key_sha256,
        outcome?.attributes?.completion_reason,
        outcome?.action.mutation,
      ],
    ];
  });
  assert.deepEqual(
    [...new Set(receipts.map(([, reason, mutation]) => `${reason}:${mutation}`))].sort(),
    ["mutation_accepted:true", "mutation_rejected:false"],
  );
  assert.ok(new Set(receipts.map(([key]) => key)).size > 1);
  assert.deepEqual(eventSummary(events.slice(-3)), [
    [ACTION_EVENT_TYPES.applyAction, "skipped", "kept_open"],
    [ACTION_EVENT_TYPES.applyBatch, "completed", "completed"],
    [ACTION_EVENT_TYPES.applyPublish, "completed", undefined],
  ]);
  // The item result and the batch keep the mutation that the receipts observed.
  assert.deepEqual(
    events.slice(-3).map((event) => event.action.mutation),
    [true, true, false],
  );
  // The local apply report is digest evidence, not a durable record path.
  assert.deepEqual(events.at(-1)?.subject, {
    repository: "openclaw/clawsweeper",
    kind: "publication",
  });
  assert.deepEqual(events.at(-1)?.evidence?.[0], {
    kind: "apply_report",
    sha256: createHash("sha256")
      .update(readFileSync(join(root, "apply-report.json")))
      .digest("hex"),
  });
});

githubTest("apply mutation receipts bind retry, rejection and admission outcomes", (t) => {
  const fixture = installGhFixture(
    t,
    `
state.calls = (state.calls || 0) + 1;
switch (state.calls) {
  case 1: throw new Error("HTTP 502: transient upstream failure");
  case 3: throw new Error('HTTP 422: Validation Failed (label "priority: high" already exists)');
  case 4: throw new Error("HTTP 429: Too Many Requests");
}
process.stdout.write("ok");
`,
  );
  const receipts: string[] = [];
  const run = () =>
    ghObservedMutationCommand({
      args: ["api", "repos/test/item", "--method", "PATCH"],
      identity: "test_mutation",
      attempts: 2,
      knownNoMutation: labelAlreadyExistsError,
    });
  withMutationReceiptRunner(
    (options) => {
      assert.equal(options.idempotencyIdentity, "test_mutation");
      let outcome = "unknown";
      try {
        const result = options.operation();
        outcome = "accepted";
        return result;
      } catch (error) {
        if (options.knownNoMutation?.(error)) outcome = "rejected";
        throw error;
      } finally {
        receipts.push(`${options.identity}:${outcome}`);
      }
    },
    () => {
      assert.equal(run(), "ok");
      assert.throws(run, /already exists/);
      assert.throws(run, /HTTP 429/);
      assert.throws(
        () =>
          withGitHubRuntimeBudget({ startedAtMs: Date.now() - 2_000, maxRuntimeMs: 1_000 }, run),
        { name: "GitHubRuntimeBudgetError" },
      );
    },
  );
  assert.deepEqual(receipts, [
    "test_mutation:request_attempt:1:unknown",
    "test_mutation:request_attempt:2:accepted",
    "test_mutation:request_attempt:1:rejected",
    "test_mutation:request_attempt:1:unknown",
  ]);
  assert.equal(fixture.requests().filter(({ args }) => args[1] !== "rate_limit").length, 4);
  for (const didMutate of [false, true]) {
    assert.deepEqual(heldReviewStartStatusCommentResultForTest("2026-07-12T12:00:00Z", didMutate), {
      status: "held",
      lease: null,
      retryAt: "2026-07-12T12:00:00Z",
      didMutate,
    });
  }
});

githubTest(
  "overlapping async commands keep executable GitHub writes in their own receipt scopes",
  async (t) => {
    const fixture = installGhFixture(t, "process.stdout.write(args[1]);");
    const receipts: string[][] = [[], []];
    await Promise.all(
      receipts.map((recorded, index) =>
        withGitHubRun(() =>
          withMutationReceiptRunner(
            (options) => {
              recorded.push(options.identity);
              return options.operation();
            },
            async () => {
              await Promise.resolve();
              assert.equal(
                ghObservedMutationCommand({
                  args: ["api", `repos/test/issues/${index + 1}`, "--method", "PATCH"],
                  identity: `command_${index + 1}`,
                }),
                `repos/test/issues/${index + 1}`,
              );
            },
          ),
        ),
      ),
    );
    assert.deepEqual(receipts, [["command_1:request_attempt:1"], ["command_2:request_attempt:1"]]);
    assert.deepEqual(
      fixture.requests().map(({ args }) => args),
      [1, 2].map((number) => ["api", `repos/test/issues/${number}`, "--method", "PATCH"]),
    );
  },
);

test("GitHub throttles abort apply lease checks and preserve durable lease ownership", () => {
  const rateLimit = new GitHubRateLimitError(new Error("HTTP 403: API rate limit exceeded"));
  let requests = 0;
  const lease = { owner: "review-owner", commentId: 7, headSha: "abc123" };
  const guards = createApplyLeaseGuards({
    canonicalBoundStaleReviewReason: () => null,
    closeDelayMs: 0,
    currentReviewActivityBlock: () => null,
    dryRun: false,
    getActiveApplyMutationLease: () => ({ itemNumber: 42, lease }),
    ghJson: () => {
      requests += 1;
      throw rateLimit;
    },
    GitHubRuntimeBudgetError: class extends Error {},
    initialReviewHeadSha: "abc123",
    issueReviewCommentState: () => ({ comments: [], leaseComments: [] }),
    item: { kind: "pull_request" },
    liveIssueSourceRevision: () => "abc123",
    markdownBeforeApplyDecisionMutations: "",
    number: 42,
    PATCHABLE_REVIEW_COMMENT_AUTHORS: new Set(["clawsweeper[bot]"]),
    postReviewStartStatusComment: () => ({ status: "posted", lease }),
    reportReviewRevision: null,
    requiresApplyMutationLease: true,
    setActiveApplyMutationLease: () => undefined,
    shouldPreserveReviewStartLease: () => false,
    targetRepo: () => "openclaw/openclaw",
  } as unknown as Parameters<typeof createApplyLeaseGuards>[0]);

  assert.throws(
    () => guards.refreshReviewStartLeaseState(),
    (error) => error === rateLimit,
  );
  assert.throws(
    () => guards.currentApplyMutationLeaseBlockReason(),
    (error) => error === rateLimit,
  );
  assert.equal(requests, 2);

  // Through the CLI: a throttled mutation keeps the durable lease until it expires,
  // and a throttled lease release is not hidden as a logged warning.
  for (const throttled of ["issue edit", "lease delete"] as const) {
    withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
      const callsPath = join(root, "gh-calls.jsonl");
      const reviewedAt = new Date(Date.now() - 180_000).toISOString();
      const startedAt = new Date(Date.now() - 120_000).toISOString();
      const issue = {
        number: 321,
        title: "Keep the lease under GitHub throttling",
        created_at: "2026-05-01T00:00:00Z",
        updated_at: reviewedAt,
        state: "open",
        author_association: "CONTRIBUTOR",
        user: { login: "reporter" },
        labels: [],
      };
      const sourceRevision = itemSourceRevisionSha256(issue, []);
      const synced = reportWithSyncedReviewComment(
        workPlanCandidateReport({
          number: 321,
          repository: "openclaw/clawsweeper",
          type: "issue",
          title: issue.title,
          reviewed_at: reviewedAt,
          item_snapshot_hash: "reviewed-snapshot-321",
          item_updated_at: reviewedAt,
          item_source_revision: sourceRevision,
          review_lease_owner: "report-owned-review",
          review_lease_comment_id: "700321",
          labels: JSON.stringify([]),
          triage_priority: "P2",
        }),
        321,
      );
      writeFileSync(join(itemsDir, "321.md"), synced.report);
      const comments = [
        {
          id: 9321,
          html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321",
          created_at: reviewedAt,
          updated_at: reviewedAt,
          user: { login: "clawsweeper[bot]" },
          body: synced.comment,
        },
        {
          id: 700321,
          html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-700321",
          created_at: startedAt,
          updated_at: startedAt,
          user: { login: "clawsweeper[bot]" },
          body: renderReviewStartStatusComment({
            number: 321,
            kind: "issue",
            title: issue.title,
            headSha: sourceRevision,
            startedAt,
            leaseExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
            leaseOwner: "report-owned-review",
          }),
        },
      ];
      const ghMock = `
const { appendFileSync } = require("fs");
const args = process.argv.slice(2);
const actual = args[0] === "--repo" ? args.slice(2) : args;
const path = actual.includes("-i") ? actual[actual.indexOf("-i") + 1] : actual[1] || "";
const call = /\\/issues\\/comments\\/700321$/.test(path) && actual.includes("DELETE") ? "lease delete" : actual.slice(0, 2).join(" ");
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(call) + "\\n");
if (call === ${JSON.stringify(throttled)}) {
  console.error("gh: API rate limit exceeded for installation. (HTTP 403)");
  process.exit(1);
}
if (actual[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path) && !actual.includes("--method")) {
  const comments = ${JSON.stringify(comments)};
  console.log(JSON.stringify(actual.includes("--slurp") ? [comments] : comments));
} else if (actual[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify(actual.includes("--slurp") ? [[]] : []));
} else if (actual[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify(${JSON.stringify(issue)}));
} else if (actual[0] === "issue" && actual[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (path.startsWith("search/issues")) {
  console.log(JSON.stringify({ items: [] }));
} else {
  console.log("");
}`;
      withMockGh(root, ghMock, () =>
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: ["--skip-dashboard", "--item-number", "321"],
        }),
      );
      const calls = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const actions = JSON.parse(readFileSync(reportPath, "utf8")).map(
        (result: { number: number; action: string }) => [result.number, result.action],
      );
      if (throttled === "issue edit") {
        assert.ok(calls.includes("issue edit"));
        assert.equal(calls.includes("lease delete"), false);
        assert.deepEqual(actions, [
          [321, "skipped_runtime_budget"],
          [0, "skipped_runtime_budget"],
        ]);
      } else {
        assert.ok(calls.includes("lease delete"));
        assert.deepEqual(actions.slice(-2), [
          [321, "skipped_runtime_budget"],
          [0, "skipped_runtime_budget"],
        ]);
      }
    });
  }
});

test("runtime yields bind the active item and terminal Codex failures preserve retryability", () => {
  assert.deepEqual(
    applyRuntimeBudgetYieldResultsForTest(512, "max runtime reached during coverage proof"),
    [
      {
        number: 512,
        action: "skipped_runtime_budget",
        reason: "max runtime reached during coverage proof",
      },
      {
        number: 0,
        action: "skipped_runtime_budget",
        reason: "max runtime reached during coverage proof",
      },
    ],
  );
  assert.equal(codexReviewFailureRetryableForTest(false), false);
  assert.equal(codexReviewFailureRetryableForTest(true), true);
});

githubTest(
  "retry dispatch outcomes distinguish definite rejection, ambiguity, and acceptance",
  (t) => {
    const fixture = installGhFixture(
      t,
      `
if (args[1] === "rejected") throw new Error("HTTP 422: validation failed");
else if (args[1] === "upstream") throw new Error("HTTP 502: bad gateway");
else if (args[1] === "signal") process.kill(process.pid, "SIGTERM");
else if (args[1] === "timeout") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
else process.stdout.write("ok");
`,
    );
    let checkpoints = 0;
    for (const [scenario, outcome] of [
      ["rejected", "definitely_not_dispatched"],
      ["upstream", "ambiguous_transport"],
      ["signal", "ambiguous_transport"],
      ["timeout", "ambiguous_transport"],
    ]) {
      const run = () =>
        ghRawOnceWithCheckpoint(["api", scenario!], () => {
          checkpoints += 1;
        });
      assert.throws(
        () =>
          scenario === "timeout"
            ? withGitHubRuntimeBudget({ startedAtMs: Date.now(), maxRuntimeMs: 1_500 }, run)
            : run(),
        (error: unknown) => error instanceof GitHubDispatchError && error.outcome === outcome,
      );
    }
    assert.deepEqual(
      ghRawOnceWithCheckpoint(["api", "accepted"], () => {}),
      {
        outcome: "accepted",
        output: "ok",
      },
    );
    assert.equal(checkpoints, 4);
    assert.equal(fixture.requests().filter(({ args }) => args[1] !== "timeout").length, 4);
  },
);

test("untrusted Codex processes cannot inherit action-ledger producer authority", (t) => {
  const previousEnv = process.env;
  t.after(() => {
    process.env = previousEnv;
  });
  process.env = {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: "/tmp/privileged-ledger",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "review-0",
    GH_TOKEN: "ambient",
    EXACT_REVIEW_LEASE_ID: "private-review-capability",
    EXACT_REVIEW_CLAIM_GENERATION: "2",
    EXACT_REVIEW_SOURCE_HEAD_SHA: "a".repeat(40),
  };
  const env = untrustedCodexEnv();
  assert.equal(env.CLAWSWEEPER_ACTION_LEDGER_FORCE, undefined);
  assert.equal(env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT, undefined);
  assert.equal(env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.EXACT_REVIEW_LEASE_ID, undefined);
  assert.equal(env.EXACT_REVIEW_CLAIM_GENERATION, undefined);
  assert.equal(env.EXACT_REVIEW_SOURCE_HEAD_SHA, undefined);
});

test("apply failure finalization survives report publication errors", () => {
  const ghMock = `console.error("gh: Validation Failed (HTTP 422)"); process.exit(1);\n`;
  const { result, events } = runCliWithLedger(ghMock, (root) => {
    const itemsDir = join(root, "records", "openclaw-clawsweeper", "items");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(itemsDir, "321.md"), syncedIssueReport(321, []).report);
    // A regular file where the report directory must be makes the report write fail.
    writeFileSync(join(root, "blocked"), "");
    return [
      "apply-decisions",
      "--target-repo",
      "openclaw/clawsweeper",
      "--items-dir",
      itemsDir,
      "--closed-dir",
      join(root, "records", "openclaw-clawsweeper", "closed"),
      "--plans-dir",
      join(root, "plans"),
      "--report-path",
      join(root, "blocked", "apply-report.json"),
    ];
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(eventSummary(events), [
    [ACTION_EVENT_TYPES.applyBatch, "started", undefined],
    [ACTION_EVENT_TYPES.applyAction, "started", "started"],
    [ACTION_EVENT_TYPES.applyAction, "failed", "failed"],
    [ACTION_EVENT_TYPES.applyBatch, "failed", "failed"],
    [ACTION_EVENT_TYPES.applyPublish, "skipped", undefined],
  ]);
  assert.equal(events.at(-1)?.action.reason_code, "not_found");
});

test("failed-review retry finalizes its ledger when the command fails", () => {
  const { result, events } = runCliWithLedger(`console.log("main");\n`, (root) => {
    mkdirSync(join(root, "records", "openclaw-openclaw", "items"), { recursive: true });
    // A regular file where the report directory must be makes the report write fail.
    writeFileSync(join(root, "blocked"), "");
    return [
      "retry-failed-reviews",
      "--target-repo",
      "openclaw/openclaw",
      "--items-dir",
      join(root, "records", "openclaw-openclaw", "items"),
      "--workflow-ref",
      "main",
      "--report-path",
      join(root, "blocked", "failed-review-retry-report.json"),
    ];
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(eventSummary(events), [
    [ACTION_EVENT_TYPES.reviewRetry, "started", undefined],
    [ACTION_EVENT_TYPES.reviewRetry, "failed", "failed"],
  ]);
});

type WorkflowStep = { name?: string; if?: string; run?: string; env?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps?: WorkflowStep[] }> };

function workflowStep(workflow: Workflow, name: string): WorkflowStep {
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((candidate) => candidate.name === name);
  assert.ok(step, `missing workflow step ${name}`);
  return step;
}

test("sweep finalizes open ledger attempts and publishes shards through the signed queue", () => {
  const sweep: Workflow = parseYaml(readText(".github/workflows/sweep.yml"));
  const retry: Workflow = parseYaml(readText(".github/workflows/failed-review-retry.yml"));
  // A failed or cancelled producer must not leave open attempts in its shard.
  for (const [workflow, name, reasons] of [
    [sweep, "Finalize apply proof action ledger", ["cancelled", "workflow_failed"]],
    [sweep, "Finalize apply action ledger", ["cancelled", "workflow_failed"]],
    [
      retry,
      "Finalize failed-review retry action ledger",
      ["cancelled", "timeout", "workflow_failed"],
    ],
  ] as const) {
    const finalizer = workflowStep(workflow, name);
    assert.match(finalizer.if ?? "", /always\(\)/, name);
    for (const reason of reasons) {
      assert.ok(finalizer.run?.includes(`--interrupt-open-attempts --reason ${reason}`), name);
    }
  }
  for (const [workflow, name] of [
    [sweep, "Publish apply proof action events"],
    [sweep, "Publish apply action events"],
    [retry, "Publish failed-review retry action ledger"],
  ] as const) {
    const publisher = workflowStep(workflow, name);
    assert.ok(publisher.env?.QUEUE_URL && publisher.env.CLAWSWEEPER_WEBHOOK_SECRET, name);
    assert.doesNotMatch(publisher.run ?? "", /repair:publish-main/, name);
  }
});

test("comment router publishes command receipts per invocation through the signed queue", () => {
  const workflow: Workflow = parseYaml(readText(".github/workflows/repair-comment-router.yml"));
  // Initial and retry runs write separate shards.
  assert.deepEqual(
    ["Route ClawSweeper comments", "Retry waiting repair dispatches"].map(
      (name) => workflowStep(workflow, name).env?.CLAWSWEEPER_ACTION_LEDGER_INVOCATION,
    ),
    ["initial", "retry"],
  );
  // An empty manifest is valid only when the router saw no command.
  assert.match(
    workflowStep(workflow, "Finalize command action ledger").run ?? "",
    /\.commands_seen == 0[\s\S]*--allow-empty/,
  );
  const publisher = workflowStep(workflow, "Publish immutable command action ledger");
  assert.match(
    publisher.if ?? "",
    /steps\.finalize-command-action-ledger\.outputs\.publish == 'true'/,
  );
  assert.ok(publisher.env?.QUEUE_URL && publisher.env.CLAWSWEEPER_WEBHOOK_SECRET);
  assert.doesNotMatch(publisher.run ?? "", /repair:publish-main/);
});

test("the ledger distinguishes a blocked fallback from ordinary kept-open comment work", () => {
  assert.deepEqual(reviewCommentPublicationEventDisposition("kept_open", true, false, true), {
    status: "blocked",
    reasonCode: "policy_blocked",
    retryable: false,
    mutation: true,
    completionReason: "publication_size_limit",
  });
  assert.equal(reviewCommentPublicationEventDisposition("kept_open", true, false), null);
  assert.equal(reviewCommentPublicationEventDisposition("kept_open", false, false, true), null);
  assert.equal(reviewCommentPublicationEventDisposition("kept_open", true, true, true), null);
});
