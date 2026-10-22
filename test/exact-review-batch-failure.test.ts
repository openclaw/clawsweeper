import { enqueueManualReviews } from "../dist/repair/manual-review-enqueue.js";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExactReviewQueueState } from "../dashboard/exact-review-queue.ts";
import {
  exactReviewParkedOperatorEligible,
  exactReviewParkedRecoveryAt,
} from "../dashboard/exact-review-read-model.ts";
import { publicExactReviewQueueProjection } from "../dashboard/worker.ts";
import { renderReviewProgressSection } from "../dist/repair/update-review-status.js";
import {
  NonretryableReviewBatchError,
  nonretryableReviewBatchExitCode,
} from "../dist/exact-review-failure-reason.js";
import {
  ValidationRecoveryRequiredError,
  validationRecoveryRequired,
} from "../dist/validation-recovery.js";
import {
  createExactReviewAdmissionHarness,
  jsonResponse,
  withExactReviewAdmissionHarness,
} from "./dashboard-worker-harness.ts";

const repo = "openclaw/openclaw";
const key = `${repo}#42`;
const head = "a".repeat(40);
type Harness = ReturnType<typeof createExactReviewAdmissionHarness>;
async function post(h: Harness, path: string, body: unknown) {
  const response = await h.queue.fetch(
    new Request(`https://queue${path}`, { method: "POST", body: JSON.stringify(body) }),
  );
  const result = (await response.json()) as Record<string, any>;
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
async function state(h: Harness) {
  return (await h.storage.get("exact-review-queue")) as ExactReviewQueueState;
}
function decision(action = "opened", overrides: Record<string, unknown> = {}) {
  return {
    targetRepo: repo,
    targetBranch: "main",
    itemNumber: 42,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: action,
    supersedesInProgress: false,
    sourceHeadSha: head,
    sourceBaseSha: "b".repeat(40),
    ...overrides,
  };
}

/** Execute the real workflow terminal-exit bridge, then its compiled completion producer. */
function completion(tuple: Record<string, unknown>, retryable = false) {
  const root = mkdtempSync(join(tmpdir(), "batch-completion-"));
  try {
    const output = join(root, "outputs");
    const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
    const start = workflow.indexOf(
      '          echo "exit_code=$review_exit_code"'.replaceAll("\\", ""),
    );
    assert.notEqual(start, -1);
    const end = workflow.indexOf("          coordination_held_path=", start);
    assert.ok(end > start);
    const bridge = spawnSync("bash", ["-c", workflow.slice(start, end)], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        review_exit_code: retryable ? "1" : "82",
      },
    });
    assert.equal(bridge.status, retryable ? 1 : 82, bridge.stderr);
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    if (!retryable) assert.equal(outputs.failure_reason, "batch_nonretryable");
    const result = spawnSync(
      process.execPath,
      ["dist/repair/exact-review-queue-request.js", "complete", "body"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          QUEUE_LEASE_ID: String(tuple.lease_id),
          ITEM_KEY: String(tuple.item_key),
          QUEUE_LEASE_REVISION: String(tuple.lease_revision),
          CLAIM_GENERATION: String(tuple.claim_generation),
          PROTOCOL_VERSION: "2",
          GITHUB_RUN_ID: String(tuple.run_id),
          GITHUB_RUN_ATTEMPT: "1",
          PRIMARY_OUTCOME: "failure",
          REVIEW_FAILURE_REASON: outputs.failure_reason ?? "",
          REVIEW_FAILURE_STAGE: outputs.failure_stage ?? "transport_network",
          REVIEW_FAILURE_REASON_CODE: outputs.failure_reason_code ?? "transport_network",
          REVIEW_FAILURE_RETRYABLE: outputs.failure_retryable ?? "true",
          REVIEW_ITEM_KIND: "pull_request",
          HAS_COMMAND_CONTEXT: "false",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
async function claim(h: Harness) {
  await h.queue.alarm();
  const item = (await state(h)).items[key]!;
  assert.ok(item.leaseId);
  const tuple = {
    item_key: key,
    lease_id: item.leaseId,
    lease_revision: item.leaseRevision,
    run_id: "4242",
    run_attempt: 1,
  };
  const result = await post(h, "/claim", tuple);
  return { ...tuple, claim_generation: result.claim_generation };
}
function harness(manual = false, live?: { head: string }) {
  return createExactReviewAdmissionHarness(
    () =>
      jsonResponse({
        state: "open",
        title: "Batch fixture",
        body: "",
        locked: false,
        labels: [],
        head: { sha: live?.head ?? head },
        base: { sha: "b".repeat(40) },
        draft: false,
        updated_at: "2026-10-20T00:00:00Z",
      }),
    { env: manual ? { EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1" } : {} },
  );
}

test("nonretryable batch exit survives workflow completion and parks unchanged paid input", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    await post(h, "/enqueue", { delivery_id: "first", decision: decision() });
    const tuple = await claim(h);
    const body = completion(tuple);
    assert.equal(body.review_failure.retryable, false);
    const result = await post(h, "/complete", body);
    assert.equal(result.requeued, false, JSON.stringify(result));
    const item = (await state(h)).items[key]!;
    assert.equal(item.state, "parked");
    assert.equal(item.parkedReason, "batch_nonretryable");
    assert.equal(exactReviewParkedOperatorEligible(item), true);
    assert.equal(exactReviewParkedRecoveryAt(item), null);
    const stats = await (await h.queue.fetch(new Request("https://queue/stats"))).json();
    const projection = publicExactReviewQueueProjection(stats, new Set([repo]));
    assert.equal(projection.lanes.review.parked_reasons.batch_nonretryable, 1);
    assert.equal(projection.lanes.review.parked_reasons.unknown, 0);
    for (const [index, action] of [
      "scheduled_hot_intake",
      "scheduled_normal_backfill",
      "failed_review_shard_recovery",
    ].entries()) {
      await post(h, "/enqueue", { delivery_id: `repeat-${index}`, decision: decision(action) });
      await h.queue.alarm();
      assert.equal((await state(h)).items[key]!.state, "parked");
    }
    assert.equal(h.dispatched.length, 1);
    const copy = renderReviewProgressSection({
      state: "blocked",
      failureReason: "batch_nonretryable",
      runUrl: "",
    });
    assert.match(copy, /No consolidated review verdict was accepted/);
    assert.doesNotMatch(copy, /did not run/);
  });
});

test("bounded transient batch completion still authorizes queue retry", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    await post(h, "/enqueue", { delivery_id: "first", decision: decision() });
    const result = await post(h, "/complete", completion(await claim(h), true));
    assert.equal(result.requeued, true, JSON.stringify(result));
    assert.equal((await state(h)).items[key]!.state, "pending");
  });
});

test("batch terminal wrapper preserves recovery ownership through causes", () => {
  const recovery = new ValidationRecoveryRequiredError("fixture", new Error("private"), [
    "/owned/fixture",
  ]);
  const error = new NonretryableReviewBatchError(recovery);
  assert.equal(nonretryableReviewBatchExitCode(error), 82);
  assert.equal(validationRecoveryRequired(error), recovery);
  assert.equal(nonretryableReviewBatchExitCode(new Error("ordinary")), undefined);
});

test("parked batch input accepts fresh verified source and an explicit request, not an event rename", async () => {
  for (const change of [
    { source_head_sha: "c".repeat(40) },
    { source_base_sha: "d".repeat(40) },
    { source_content_revision: "e".repeat(64) },
    { source_is_draft: true },
    "command",
  ]) {
    const h = harness();
    await withExactReviewAdmissionHarness(h, async () => {
      await post(h, "/enqueue", { delivery_id: "first", decision: decision() });
      await post(h, "/complete", completion(await claim(h)));
      await post(h, "/enqueue", { delivery_id: "renamed-event", decision: decision("edited") });
      assert.equal((await state(h)).items[key]!.state, "parked");
      if (change === "command") {
        const fresh = decision("re_review_command", {
          sourceHeadSha: undefined,
          commandStatusMarker: "<!-- clawsweeper-command-status:42:re_review:fixture -->",
          statusCommentId: 4200,
          additionalPrompt: "Review this revision again.",
        });
        await post(h, "/enqueue", { delivery_id: "fresh-request", decision: fresh });
      } else {
        const inventory = await post(h, "/parked-reviews/list", { limit: 10 });
        const item = inventory.parked_reviews[0];
        assert.ok(item);
        const unchanged = await post(h, "/parked-reviews/recover-fresh", {
          idempotency_key: "same",
          items: [item],
        });
        assert.equal(unchanged.unchanged, 1);
        const changed = await post(h, "/parked-reviews/recover-fresh", {
          idempotency_key: "different",
          items: [{ ...item, ...change }],
        });
        assert.equal(changed.recovered, 1);
      }
      assert.equal((await state(h)).items[key]!.state, "pending");
    });
  }
});

function manualRequest(h: Harness, requestId: string) {
  return enqueueManualReviews({
    targetRepo: repo,
    targetBranch: "main",
    codexTimeoutMs: 10000,
    itemNumbers: [42],
    requestId,
    queueUrl: "https://queue",
    secret: "fixture-signing-key",
    additionalPrompt: "A deliberately fresh operator request",
    itemKind: async () => "pull_request",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname.replace("/internal/exact-review", "");
      return h.queue.fetch(new Request("https://queue" + path, init));
    },
  });
}

test("real explicit-manual producer releases a batch park and replays cannot spend another batch", async () => {
  const h = harness(true);
  await withExactReviewAdmissionHarness(h, async () => {
    await post(h, "/enqueue", { delivery_id: "first", decision: decision() });
    await post(h, "/complete", completion(await claim(h)));
    const request = (requestId: string) => manualRequest(h, requestId);
    assert.equal((await request("manual-first")).accepted, 1);
    assert.equal(
      (await state(h)).items[key]!.state,
      "pending",
      JSON.stringify(
        Object.values((await state(h)).items).map((item) => ({
          key: item.key,
          state: item.state,
          action: item.decision.sourceAction,
          delivery: item.admissionDeliveryId,
        })),
      ),
    );
    const revision = (await state(h)).items[key]!.revision;
    await request("manual-first");
    assert.equal((await state(h)).items[key]!.revision, revision);
    await post(h, "/complete", completion(await claim(h)));
    assert.equal((await state(h)).items[key]!.state, "parked");
    await request("manual-first");
    assert.equal(
      (await state(h)).items[key]!.state,
      "parked",
      "replaying the original request does not revive paid work",
    );
    assert.equal((await request("manual-second")).accepted, 1);
    assert.equal((await state(h)).items[key]!.state, "pending");
  });
});

test("retry-policy epoch changes cannot release a terminal batch park", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    await post(h, "/enqueue", { delivery_id: "first", decision: decision() });
    await post(h, "/complete", completion(await claim(h)));
    const before = (await post(h, "/parked-reviews/list", { limit: 10 })).parked_reviews[0];
    Reflect.set(h.queue, "env", {
      ...Reflect.get(h.queue, "env"),
      EXACT_REVIEW_RETRY_POLICY_EPOCH: "batch-epoch-next",
    });
    const after = (await post(h, "/parked-reviews/list", { limit: 10 })).parked_reviews[0];
    assert.equal(
      after.retry_policy_changed,
      true,
      "epoch drift remains an honest fact, not authorization to retry a batch",
    );
    const unchanged = await post(h, "/parked-reviews/recover-fresh", {
      idempotency_key: "epoch-only",
      items: [before],
    });
    assert.equal(unchanged.unchanged, 1);
    await h.queue.alarm();
    assert.equal((await state(h)).items[key]!.state, "parked");
    assert.equal(h.dispatched.length, 1);
    const fresh = await post(h, "/parked-reviews/recover-fresh", {
      idempotency_key: "actual-source",
      items: [{ ...after, source_head_sha: "f".repeat(40) }],
    });
    assert.equal(fresh.recovered, 1);
    assert.equal((await state(h)).items[key]!.state, "pending");
  });
});

for (const legacyUnknown of [false, true])
  test(
    "first manual batch binds source and cannot recover by initial hydration: " + legacyUnknown,
    async () => {
      const h = harness(true);
      await withExactReviewAdmissionHarness(h, async () => {
        assert.equal((await manualRequest(h, "first-on-empty")).accepted, 1);
        const tuple = await claim(h);
        const claimed = (await state(h)).items[key]!;
        assert.equal(claimed.leaseDecision!.sourceHeadSha, head);
        assert.equal(claimed.leaseDecision!.sourceBaseSha, "b".repeat(40));
        assert.match(claimed.leaseDecision!.sourceContentRevision ?? "", /^[a-f0-9]{64}$/);
        await post(h, "/complete", completion(tuple));
        const parked = (await post(h, "/parked-reviews/list", { limit: 10 })).parked_reviews[0];
        if (legacyUnknown) {
          const stored = await state(h),
            item = stored.items[key]!;
          for (const name of [
            "sourceHeadSha",
            "sourceHeadVerified",
            "sourceBaseSha",
            "sourceContentRevision",
            "sourceIsDraft",
            "sourceUpdatedAt",
          ])
            delete (item.decision as unknown as Record<string, unknown>)[name];
          Reflect.get(h.queue, "writeStateSync").call(h.queue, stored);
        }
        const inventory = (await post(h, "/parked-reviews/list", { limit: 10 })).parked_reviews[0];
        const filled = {
          ...inventory,
          source_head_sha: head,
          source_base_sha: "b".repeat(40),
          source_content_revision: parked.source_content_revision,
          source_is_draft: false,
          source_updated_at: "2026-10-20T00:00:00Z",
        };
        const result = await post(h, "/parked-reviews/recover-fresh", {
          idempotency_key: "same-source-hydration",
          items: [filled],
        });
        assert.equal(result.recovered, 0);
        assert.equal(result.unchanged, 1);
        assert.equal((await state(h)).items[key]!.state, "parked");
        assert.equal((await manualRequest(h, "fresh-explicit")).accepted, 1);
        assert.equal((await state(h)).items[key]!.state, "pending");
      });
    },
  );

test("a fresh manual request binds live source instead of dropping a retained stale head", async () => {
  const live = { head },
    h = harness(true, live);
  await withExactReviewAdmissionHarness(h, async () => {
    await post(h, "/enqueue", { delivery_id: "first", decision: decision() });
    await post(h, "/complete", completion(await claim(h)));
    live.head = "c".repeat(40);
    assert.equal((await manualRequest(h, "new-live-input")).accepted, 1);
    const tuple = await claim(h),
      item = (await state(h)).items[key]!;
    assert.equal(item.leaseDecision!.sourceHeadSha, live.head);
    assert.equal(item.leaseDecision!.sourceHeadVerified, true);
    assert.equal(item.leaseDecision!.publicationPolicy, "record_comment_only");
    await post(h, "/complete", completion(tuple));
    const parked = (await post(h, "/parked-reviews/list", { limit: 10 })).parked_reviews[0];
    assert.equal(parked.source_head_sha, live.head);
    assert.equal(
      (
        await post(h, "/parked-reviews/recover-fresh", {
          idempotency_key: "same-live-input",
          items: [parked],
        })
      ).unchanged,
      1,
    );
  });
});
