import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  exactReviewWarningEvidence,
  publicWarningEvidence,
  WARNING_SOURCE_LIMIT,
} from "../dashboard/exact-review-warning-evidence.ts";
import { publicExactReviewQueueProjection, publicStatusProjection } from "../dashboard/worker.ts";
import { ExactReviewReviewLoopStore } from "../dashboard/exact-review-review-loop.ts";
import { reviewFailureDecisionFingerprint } from "../dashboard/exact-review-observed-failure.ts";
import type { ExactReviewQueueItem } from "../dashboard/exact-review-queue.ts";

const now = Date.parse("2026-10-30T22:00:00Z");
const repo = "openclaw/clawsweeper";
export function heldItem(
  number: number,
  reason = "scanner_refused",
  repository = repo,
): ExactReviewQueueItem {
  const item = {
    key: repository + "#" + number,
    decision: {
      targetRepo: repository,
      targetBranch: "main",
      itemNumber: number,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "opened",
      supersedesInProgress: false,
    },
    state: "parked",
    parkedReason: reason,
    revision: 3,
    createdAt: now - 60_000,
    updatedAt: now,
    nextAttemptAt: now + 15_000,
    attempts: 2,
    scannerRefusal: { observedAt: now - 10_000, runId: "123" },
    reviewFailureAttempts: 4,
    reviewFailure: { stage: "agent_input_scan", reason: "findings" },
  } as ExactReviewQueueItem;
  item.reviewFailureDecisionFingerprint = reviewFailureDecisionFingerprint(item.decision);
  return item;
}

test("warning producer retains reasons, observed fields and superseded classification only", () => {
  const scan = heldItem(1),
    retry = heldItem(2, "review_retry_exhausted");
  retry.parkedRecoveryAt = now + 60_000;
  const retained = heldItem(3);
  retained.state = "pending";
  delete retained.parkedReason;
  retained.decision.publication = { producerRunId: "123" } as never;
  retained.decision.sourceAction = "exact_review_artifact_publish";
  const state = { items: { scan, retry, retained } };
  const evidence = exactReviewWarningEvidence(state, new Set([retained.key]), null);
  assert.deepEqual(
    evidence.groups.map((group) => group.total),
    [1, 1, 1],
  );
  assert.equal(evidence.groups[0].items[0].observed_at, new Date(now - 10_000).toISOString());
  assert.equal(evidence.groups[1].items[0].next_retry_at, new Date(now + 60_000).toISOString());
  assert.equal(evidence.groups[2].items[0].next_retry_at, null);
  delete retry.parkedRecoveryAt;
  assert.equal(
    exactReviewWarningEvidence(state, new Set(), null).groups[1].items[0].next_retry_at,
    null,
    "legacy computed fallback is not an observed retry",
  );
  retry.parkedRecoveryAttempts = 3;
  retry.parkedRecoveryAt = now + 60_000;
  assert.equal(
    exactReviewWarningEvidence(state, new Set(), null).groups[1].items[0].next_retry_at,
    null,
  );
  scan.reviewFailureDecisionFingerprint = "stale";
  assert.equal(exactReviewWarningEvidence(state, new Set(), null).groups[0].items[0].failure, null);
});

test("public warning projection bounds, drops private/malformed fields and reprojects cached shapes", () => {
  const items = Array.from({ length: 25 }, (_, i) => heldItem(i + 1));
  items.push(heldItem(99, "scanner_refused", "private-owner/secret"));
  const source = exactReviewWarningEvidence(
    { items: Object.fromEntries(items.map((item) => [item.key, item])) },
    new Set(),
    { total: 0, items: [] },
  );
  assert.equal(source.groups[0].items.length, WARNING_SOURCE_LIMIT);
  const raw = structuredClone(source) as any;
  raw.groups[0].items[0].url = "https://evil.invalid/action";
  raw.groups[0].items[0].scanner_input = "secret-input";
  const projected = publicExactReviewQueueProjection({ warning_evidence: raw }, new Set([repo]));
  assert.equal(projected.warning_evidence.groups[0].total, 26);
  assert.equal(projected.warning_evidence.groups[0].items.length, 10);
  assert.doesNotMatch(JSON.stringify(projected), /private-owner|secret-input|evil/);
  assert.deepEqual(
    publicExactReviewQueueProjection(projected, new Set([repo])).warning_evidence,
    projected.warning_evidence,
  );
  assert.deepEqual(
    publicStatusProjection(
      {
        schema_version: 1,
        generated_at: new Date(now).toISOString(),
        fleet: {},
        workers: [],
        pipeline: [],
        diagnostics: { errors: [] },
        exact_review_queue: projected,
      },
      new Set([repo]),
    ).exact_review_queue.warning_evidence,
    projected.warning_evidence,
  );
  assert.equal(
    publicExactReviewQueueProjection(projected).warning_evidence.groups[0].items.length,
    0,
  );
  assert.equal(publicWarningEvidence({ ...raw, sample_limit: 999 }, new Set([repo])), null);
  assert.equal(publicWarningEvidence(undefined, new Set([repo])), null);
  const bad = structuredClone(raw);
  bad.groups[0].items[0].item_number = -1;
  bad.groups[0].items[1].observed_at = "not a timestamp";
  bad.groups[0].items[2].revision = "3";
  assert.doesNotThrow(() => publicWarningEvidence(bad, new Set([repo])));
  assert.equal(publicWarningEvidence({ ...raw, groups: [] }, new Set([repo])), null);
});

test("SQLite claim history counts actual run attempts, prunes window and never invents revisions/triggers", () => {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec(query: string, ...args: any[]) {
        const statement = db.prepare(query);
        return /^\s*(SELECT|WITH|PRAGMA)/i.test(query)
          ? statement.all(...args)
          : (statement.run(...args), []);
      },
    },
    transactionSync<T>(callback: () => T) {
      return callback();
    },
  };
  try {
    const store = new ExactReviewReviewLoopStore(storage);
    for (let i = 0; i < 8; i++)
      store.recordReviewGenerationSafely(repo + "#1", "123", i + 1, now - 8_000 + i * 1000);
    store.recordReviewGenerationSafely(repo + "#1", "123", 1, now); // duplicate identity does not increment
    store.recordReviewGenerationSafely("private-owner/secret#9", "456", 1, now - 1000);
    store.recordReviewGenerationSafely("private-owner/secret#9", "457", 1, now);
    const claims = store.warningClaimEvidenceSync(now, 1)!;
    assert.equal(claims.total, 2);
    const evidence = publicWarningEvidence(
      exactReviewWarningEvidence({ items: {} }, new Set(), claims),
      new Set([repo]),
    )!;
    assert.equal(evidence.repeated_claims!.items.length, 1);
    const item = evidence.repeated_claims!.items[0];
    assert.equal(item.claims, 8);
    assert.equal(item.recent_claims.length, 5);
    assert.equal(item.recent_claims[0].run_attempt, 8);
    assert.equal(item.last_claim_at, new Date(now - 1000).toISOString());
    assert.doesNotMatch(JSON.stringify(evidence), /private-owner|run_id|"revision"|"trigger"/);
    assert.deepEqual(publicWarningEvidence(evidence, new Set([repo])), evidence);
    assert.equal(store.warningClaimEvidenceSync(now + 25 * 60 * 60_000, 1)!.total, 0);
  } finally {
    db.close();
  }
});
