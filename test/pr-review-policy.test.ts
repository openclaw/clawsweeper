import assert from "node:assert/strict";
import test from "node:test";
import { isCompletedPullRequestReview } from "../src/pr-review-policy.ts";
import {
  ExactReviewDirectPublicationStore,
  validateCanonicalRecordTupleMutation,
  validateDirectPublicationPlan,
  type DirectPublicationLifecycleKind,
} from "../dashboard/exact-review-direct-publication.ts";
import {
  buildExactReviewQueueRequest,
  createExactReviewAdmissionHarness,
  jsonResponse,
  MemoryDurableStorage,
  withExactReviewAdmissionHarness,
} from "./dashboard-worker-harness.ts";
import {
  EXACT_REVIEW_AUTHENTICATED_BODY_FINGERPRINT_HEADER,
  type ExactReviewQueueState,
} from "../dashboard/exact-review-queue.ts";
import { createReviewPlanningInventory } from "../dist/clawsweeper-review-planning-inventory.js";
import type { ExistingReview, Item } from "../src/clawsweeper-types.ts";

const repo = "openclaw/gogcli";
const key = `${repo}#42`;
const start = Date.parse("2030-01-01T00:00:00Z");
const minute = 60_000;
const report = (status = "complete", kind = "pull_request") =>
  `---\ntype: ${kind}\nreview_status: ${status}\nreviewed_at: 2030-01-01T00:00:00Z\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\n---\nReview.\n`;

async function publish(
  storage: MemoryDurableStorage,
  revision: number,
  content: string | null,
  lifecycle: DirectPublicationLifecycleKind = "router",
) {
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  const plan = await validateDirectPublicationPlan({
    canonicalTargetKey: key,
    fenceKey: key,
    revision,
    identity: { canonicalTargetKey: key, fenceKey: key, revision, claimGeneration: 1 },
    operations: [
      {
        path: "records/openclaw-gogcli/items/42.md",
        mode: "100644",
        deleted: content === null,
        bytes: content === null ? 0 : Buffer.byteLength(content),
        ...(content === null ? {} : { contentBase64: Buffer.from(content).toString("base64") }),
      },
    ],
    totalBytes: content === null ? 0 : Buffer.byteLength(content),
    lifecycle: { kind: lifecycle },
  });
  assert.equal(store.accept(plan, Date.now()).outcome, "accepted");
  return store;
}

test("only a verified completed PR answer consumes the automatic review", () => {
  assert.equal(isCompletedPullRequestReview(report()), true);
  assert.equal(isCompletedPullRequestReview(report("failed")), false);
  assert.equal(isCompletedPullRequestReview(report("complete", "issue")), false);
  assert.equal(
    isCompletedPullRequestReview(report().replace("runner_preflight_v1", "unknown")),
    false,
  );
  assert.equal(
    isCompletedPullRequestReview(report().replace("2030-01-01T00:00:00Z", "unknown")),
    false,
  );
});

test("scheduler offers changed complete-looking reports so the durable queue can decide eligibility", () => {
  const inventory = createReviewPlanningInventory({ targetRepo: () => repo } as never);
  const item = {
    repo,
    number: 42,
    kind: "pull_request",
    labels: [],
    updatedAt: new Date(start).toISOString(),
  } as unknown as Item;
  const review = {
    reviewStatus: "complete",
    reviewedAt: "2026-01-01T00:00:00Z",
    reviewPolicy: "old-policy",
  } as ExistingReview;
  const index = { byKey: new Map([[key, review]]) };
  assert.equal(
    inventory.dueCandidate(item, "/nonexistent", start, "new-policy", index)?.item.number,
    42,
  );
  assert.equal(
    inventory.reviewBackfillCandidate(item, "/nonexistent", start, "new-policy", 0, index),
    null,
  );
});

test("completed answer survives failed replacement, deletion, restart and legacy seeding", async () => {
  const storage = new MemoryDurableStorage();
  await publish(storage, 1, report());
  // Simulate an upgrade from canonical reports without the additive latch.
  storage.sql.exec("DELETE FROM exact_review_pull_request_answers");
  await publish(storage, 2, report("failed"));
  await publish(storage, 3, null);
  const restarted = new ExactReviewDirectPublicationStore(storage);
  restarted.ensureSchemaSync();
  assert.equal(restarted.hasCompletedPullRequestReview("openclaw-gogcli", 42), true);
});

test("stale-source completion and failed attempts leave the first answer available", async () => {
  const storage = new MemoryDurableStorage();
  let store = await publish(storage, 1, report(), "requeue");
  assert.equal(store.hasCompletedPullRequestReview("openclaw-gogcli", 42), false);
  store = await publish(storage, 2, report("failed"));
  assert.equal(store.hasCompletedPullRequestReview("openclaw-gogcli", 42), false);
  store = await publish(storage, 3, report());
  assert.equal(store.hasCompletedPullRequestReview("openclaw-gogcli", 42), true);
});

test("archive and reopen preserve completion provenance, including legacy records", async () => {
  for (const lifecycle of ["router", "requeue"] as const) {
    for (const legacy of [false, true]) {
      const storage = new MemoryDurableStorage();
      const store = await publish(storage, 1, report(), lifecycle);
      if (legacy) storage.sql.exec("DELETE FROM exact_review_pull_request_answers");
      for (const section of ["closed", "items"] as const) {
        const content =
          section === "closed" ? report() : report().replace("complete", "stale_reopened");
        const mutation = await validateCanonicalRecordTupleMutation({
          deliveryId: `reconcile-${section}`,
          key: "openclaw-gogcli/42",
          operations: (["items", "closed", "plans", "decision-packets"] as const).map((part) => ({
            path: `records/openclaw-gogcli/${part}/42.${part === "decision-packets" ? "json" : "md"}`,
            expectedDigest: store.readCanonical("openclaw-gogcli", part, 42)?.digest ?? null,
            ...(part === section ? { contentBase64: Buffer.from(content).toString("base64") } : {}),
          })),
        });
        store.acceptCanonicalTupleMutation(mutation, Date.now());
        assert.equal(
          store.hasCompletedPullRequestReview("openclaw-gogcli", 42),
          lifecycle === "router",
        );
      }
      await publish(storage, 4, report());
      assert.equal(store.hasCompletedPullRequestReview("openclaw-gogcli", 42), true);
    }
  }
});

test("legacy stale-source reports stay unanswered when their publication receipt is pruned", async () => {
  for (const pruneFirst of [false, true]) {
    const storage = new MemoryDurableStorage();
    const store = await publish(storage, 1, report(), "requeue");
    storage.sql.exec("DELETE FROM exact_review_pull_request_answers");
    if (pruneFirst) store.pruneTerminalSync(Date.now() + 8 * 24 * 60 * minute);
    assert.equal(store.hasCompletedPullRequestReview("openclaw-gogcli", 42), false);
    store.pruneTerminalSync(Date.now() + 8 * 24 * 60 * minute);
    assert.equal(store.hasCompletedPullRequestReview("openclaw-gogcli", 42), false);
    await publish(storage, 2, report());
    assert.equal(store.hasCompletedPullRequestReview("openclaw-gogcli", 42), true);
  }
});

test("pre-upgrade missing provenance and unverified reports do not consume the first answer", async () => {
  for (const lifecycle of ["router", "requeue"] as const) {
    const storage = new MemoryDurableStorage();
    await publish(storage, 1, report(), lifecycle);
    // State left by the old seven-day pruning implementation, before the
    // completion table existed. Do not run the candidate's preserving hook.
    storage.sql.exec("DELETE FROM exact_review_pull_request_answers");
    storage.sql.exec("DELETE FROM exact_review_direct_publication_plans");
    const restarted = new ExactReviewDirectPublicationStore(storage);
    restarted.ensureSchemaSync();
    assert.equal(restarted.hasCompletedPullRequestReview("openclaw-gogcli", 42), false);
  }
  const storage = new MemoryDurableStorage();
  const store = await publish(storage, 1, report().replace("runner_preflight_v1", "unknown"));
  storage.sql.exec("DELETE FROM exact_review_pull_request_answers");
  assert.equal(store.hasCompletedPullRequestReview("openclaw-gogcli", 42), false);
  await publish(storage, 2, report());
  assert.equal(store.hasCompletedPullRequestReview("openclaw-gogcli", 42), true);
});

test("first post-upgrade pruning records a valid legacy answer before deleting its receipt", async () => {
  const storage = new MemoryDurableStorage();
  await publish(storage, 1, report());
  storage.sql.exec("DELETE FROM exact_review_pull_request_answers");
  const upgraded = new ExactReviewDirectPublicationStore(storage);
  upgraded.ensureSchemaSync();
  upgraded.pruneTerminalSync(Date.now() + 8 * 24 * 60 * minute);
  assert.equal(upgraded.list().length, 0);
  assert.equal(upgraded.hasCompletedPullRequestReview("openclaw-gogcli", 42), true);
  await publish(storage, 2, report("failed"));
  assert.equal(upgraded.hasCompletedPullRequestReview("openclaw-gogcli", 42), true);
});

function pull() {
  return {
    state: "open",
    title: "A PR",
    body: "Original body",
    locked: false,
    labels: [] as string[],
    head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40) },
    draft: false,
    updated_at: new Date(start).toISOString(),
  };
}

test("initial PR waits ten quiet minutes, coalesces pushes and lost-webhook drift, ignores comments", async () => {
  const live = pull();
  const h = createExactReviewAdmissionHarness(() => jsonResponse(live), {
    env: { EXACT_REVIEW_INITIAL_PR_QUIET_MS: String(10 * minute) },
  });
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  await withExactReviewAdmissionHarness(h, async () => {
    try {
      const state = async () =>
        (await h.storage.get("exact-review-queue")) as ExactReviewQueueState;
      const enqueue = async (id: string, head = live.head.sha) => {
        const response = await h.queue.fetch(
          buildExactReviewQueueRequest(
            id,
            42,
            id === "open" ? "opened" : "synchronize",
            "pull_request",
            repo,
            {
              sourceHeadSha: head,
              sourceHeadVerified: true,
              sourceAuthoritySeq: now - start + 1,
              sourceUpdatedAt: new Date(now).toISOString(),
            },
          ),
        );
        assert.equal(response.status, 202);
      };
      await enqueue("open");
      await h.queue.alarm();
      assert.equal(h.dispatched.length, 0);
      assert.equal((await state()).items[key].nextAttemptAt, start + 10 * minute);
      now += 8 * minute;
      await enqueue("push-b", "c".repeat(40));
      now += minute;
      await enqueue("revert-a");
      await h.queue.alarm();
      assert.equal(h.dispatched.length, 0);
      assert.equal((await state()).items[key].nextAttemptAt, now + 10 * minute);
      now += 10 * minute;
      live.body = "Changed without a webhook";
      live.updated_at = new Date(now).toISOString();
      await h.queue.alarm();
      assert.equal(h.dispatched.length, 0);
      assert.equal((await state()).items[key].nextAttemptAt, now + 10 * minute);
      // A comment updates GitHub's broad timestamp but must not restart quiet.
      now += 10 * minute;
      live.updated_at = new Date(now).toISOString();
      await h.queue.alarm();
      assert.equal(h.dispatched.length, 1);
      assert.equal((await state()).items[key].leaseDecision?.sourceHeadSha, live.head.sha);
    } finally {
      Date.now = realNow;
    }
  });
});

test("completed PR rejects webhook and scheduled repeats durably but allows explicit and opted-in work", async () => {
  for (const action of [
    "synchronize",
    "scheduled_hot_intake",
    "scheduled_normal_backfill",
    "manual_explicit_review",
    "opt-in",
  ]) {
    const live = pull();
    if (action === "opt-in") live.labels = ["clawsweeper:autofix"];
    const h = createExactReviewAdmissionHarness(() => jsonResponse(live), {
      env: { EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1" },
    });
    await withExactReviewAdmissionHarness(h, async () => {
      await publish(h.storage, 1, report());
      // Signed scheduled intake stores its disposition on the delivery receipt
      // so a lost response replays the same answer.
      const request = () => {
        const queued = buildExactReviewQueueRequest(
          `repeat-${action}`,
          42,
          action === "opt-in" ? "synchronize" : action,
          "pull_request",
          repo,
          action === "manual_explicit_review" ? { publicationPolicy: "record_comment_only" } : {},
        );
        queued.headers.set(EXACT_REVIEW_AUTHENTICATED_BODY_FINGERPRINT_HEADER, "f".repeat(64));
        return queued;
      };
      const response = await h.queue.fetch(request());
      assert.equal(response.status, 202);
      const body = (await response.json()) as { dedupe_reason?: string };
      if (action === "manual_explicit_review" || action === "opt-in") {
        assert.equal(body.dedupe_reason, undefined);
      } else {
        assert.equal(body.dedupe_reason, "review_request_required");
        const replay = (await (await h.queue.fetch(request())).json()) as {
          deduped?: boolean;
          dedupe_reason?: string;
        };
        assert.equal(replay.deduped, true);
        if (action.startsWith("scheduled_")) {
          assert.equal(replay.dedupe_reason, "review_request_required");
        }
        assert.equal(h.dispatched.length, 0);
      }
    });
  }
});

test("queued automatic PR is suppressed if its first answer arrives before dispatch", async () => {
  const h = createExactReviewAdmissionHarness(() => jsonResponse(pull()));
  await withExactReviewAdmissionHarness(h, async () => {
    await h.queue.fetch(
      buildExactReviewQueueRequest("before-answer", 42, "opened", "pull_request", repo),
    );
    await publish(h.storage, 1, report());
    await h.queue.alarm();
    assert.equal(h.dispatched.length, 0);
    assert.equal(
      ((await h.storage.get("exact-review-queue")) as ExactReviewQueueState).items[key],
      undefined,
    );
  });
});

test("rejecting an answered automatic lease preserves a newer explicit request", async () => {
  const h = createExactReviewAdmissionHarness(() => jsonResponse(pull()));
  await withExactReviewAdmissionHarness(h, async () => {
    await h.queue.fetch(buildExactReviewQueueRequest("auto", 42, "opened", "pull_request", repo));
    await h.queue.alarm();
    const state = async () => (await h.storage.get("exact-review-queue")) as ExactReviewQueueState;
    const old = (await state()).items[key];
    assert.equal(old.state, "dispatching");
    const commandStatusMarker = "<!-- clawsweeper-command-status:42:re_review:requested -->";
    assert.equal(
      (
        await h.queue.fetch(
          buildExactReviewQueueRequest("requested", 42, "re_review", "pull_request", repo, {
            commandStatusMarker,
            statusCommentId: 9001,
          }),
        )
      ).status,
      202,
    );
    assert.ok((await state()).items[key].revision > old.revision);
    await publish(h.storage, 1, report());
    const claim = await h.queue.fetch(
      new Request("https://queue/claim", {
        method: "POST",
        body: JSON.stringify({
          item_key: key,
          lease_id: old.leaseId,
          lease_revision: old.leaseRevision,
          run_id: "100",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(claim.status, 409);
    assert.equal((await state()).items[key].state, "pending");
    assert.equal((await state()).items[key].decision.commandStatusMarker, commandStatusMarker);
    await h.queue.alarm();
    const next = (await state()).items[key];
    assert.equal(next.state, "dispatching");
    assert.notEqual(next.leaseId, old.leaseId);
    assert.equal(
      (
        await h.queue.fetch(
          new Request("https://queue/claim", {
            method: "POST",
            body: JSON.stringify({
              item_key: key,
              lease_id: next.leaseId,
              lease_revision: next.leaseRevision,
              run_id: "101",
              run_attempt: 1,
            }),
          }),
        )
      ).status,
      200,
    );
  });
});

test("answered claims require a live automation opt-in and preserve commands during the read", async () => {
  for (const scenario of [
    "enabled",
    "removed",
    "webhook",
    "command",
    "unavailable",
    "expired",
  ] as const) {
    const live = pull();
    live.labels = ["clawsweeper:autofix"];
    let claimRead = false;
    let readStarted!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const h = createExactReviewAdmissionHarness(async () => {
      if (claimRead) {
        readStarted();
        if (scenario === "command" || scenario === "expired") await released;
        if (scenario === "unavailable") return new Response("Unavailable", { status: 503 });
      }
      return jsonResponse(live);
    });
    await withExactReviewAdmissionHarness(h, async () => {
      await publish(h.storage, 1, report());
      await h.queue.fetch(
        buildExactReviewQueueRequest(`opt-${scenario}`, 42, "opened", "pull_request", repo),
      );
      await h.queue.alarm();
      const state = async () =>
        (await h.storage.get("exact-review-queue")) as ExactReviewQueueState;
      const old = (await state()).items[key];
      assert.equal(old.state, "dispatching");
      if (scenario !== "enabled") live.labels = [];
      if (scenario === "webhook") {
        const response = await h.queue.fetch(
          buildExactReviewQueueRequest("removed-label", 42, "labeled", "pull_request", repo),
        );
        assert.equal((await response.json()).dedupe_reason, "review_request_required");
      }
      claimRead = true;
      const pending = h.queue.fetch(
        new Request("https://queue/claim", {
          method: "POST",
          body: JSON.stringify({
            item_key: key,
            lease_id: old.leaseId,
            lease_revision: old.leaseRevision,
            run_id: "200",
            run_attempt: 1,
          }),
        }),
      );
      if (scenario === "command") {
        await started;
        await h.queue.fetch(
          buildExactReviewQueueRequest("during-read", 42, "re_review", "pull_request", repo, {
            commandStatusMarker: "<!-- clawsweeper-command-status:42:re_review:during-read -->",
            statusCommentId: 9002,
          }),
        );
        releaseRead();
      }
      const realNow = Date.now;
      if (scenario === "expired") {
        await started;
        const expiredAt = realNow() + 2 * 60 * minute;
        Date.now = () => expiredAt;
        releaseRead();
      }
      let response: Response;
      try {
        response = await pending;
      } finally {
        Date.now = realNow;
      }
      assert.equal(
        response.status,
        scenario === "enabled" ? 200 : scenario === "unavailable" ? 503 : 409,
        scenario,
      );
      const item = (await state()).items[key];
      if (scenario === "enabled") assert.equal(item.state, "leased");
      else if (scenario === "unavailable" || scenario === "expired") {
        assert.equal(item.state, "dispatching");
        assert.equal(item.leaseId, old.leaseId);
      } else if (scenario === "command") {
        assert.equal(item.state, "pending");
        assert.equal(item.decision.statusCommentId, 9002);
      } else assert.equal(item, undefined);
    });
  }
});
