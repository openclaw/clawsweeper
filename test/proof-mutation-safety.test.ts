import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import test from "node:test";

import { readAllSpooledActionEvents } from "../dist/action-ledger.js";
import {
  createProofConversationActivityCursor,
  finishProofMutationReceipt,
  proofMutationBusinessIdentityForTest,
  proofMutationFreshnessBlock,
  recordProofMutationReconciliation,
  startProofMutationReceipt,
  type ProofMutationReceiptContext,
} from "../dist/proof-mutation-safety.js";
import { tmpPrefix } from "./helpers.ts";

function ledgerEnv(runId: string): NodeJS.ProcessEnv {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-14",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "proof-mutation-test",
    GITHUB_ACTION: "proof-mutation-test",
    GITHUB_JOB: "proof-nudges",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: runId,
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "ClawSweeper Proof Nudges",
  };
}

function receiptContext(root: string, runId = "4200"): ProofMutationReceiptContext {
  return {
    root,
    lane: "proof_nudges",
    repository: "openclaw/openclaw",
    number: 42,
    headSha: "b".repeat(40),
    component: "proof_nudges",
    evidence: [],
    privacy: {
      classification: "internal",
      redactionVersion: "v1",
      fieldsDropped: ["body", "comments", "logs", "prompt"],
    },
    env: ledgerEnv(runId),
  };
}

test("proof conversation cursors are bounded, deterministic, and content-sensitive", () => {
  const comments = [
    {
      id: 2,
      user: { login: "reviewer" },
      author_association: "MEMBER",
      body: "second body",
      created_at: "2026-07-14T10:00:00Z",
      updated_at: "2026-07-14T10:01:00Z",
    },
    {
      id: 1,
      user: { login: "author" },
      author_association: "CONTRIBUTOR",
      body: "first body",
      created_at: "2026-07-14T09:00:00Z",
      updated_at: "2026-07-14T09:00:00Z",
    },
  ];
  const cursor = createProofConversationActivityCursor(comments);

  assert.match(cursor ?? "", /^v1:2:[0-9a-f]{64}$/);
  assert.equal(createProofConversationActivityCursor([...comments].reverse()), cursor);
  assert.notEqual(
    createProofConversationActivityCursor([comments[0], { ...comments[1], body: "edited body" }]),
    cursor,
  );
  assert.equal(createProofConversationActivityCursor(Array.from({ length: 1_001 })), null);
  assert.doesNotMatch(cursor ?? "", /first body|second body/);
});

test("proof freshness distinguishes head, review, and conversation drift", () => {
  const expected = {
    headSha: "a".repeat(40),
    reviewActivityCursor: `v2:0:${"b".repeat(64)}`,
    conversationActivityCursor: `v1:0:${"c".repeat(64)}`,
  };

  assert.equal(proofMutationFreshnessBlock(expected, expected), null);
  assert.equal(
    proofMutationFreshnessBlock(expected, {
      ...expected,
      headSha: "d".repeat(40),
    })?.reason,
    "head_changed",
  );
  assert.equal(
    proofMutationFreshnessBlock(expected, {
      ...expected,
      reviewActivityCursor: `v2:1:${"e".repeat(64)}`,
    })?.reason,
    "review_activity_changed",
  );
  assert.equal(
    proofMutationFreshnessBlock(expected, {
      ...expected,
      conversationActivityCursor: `v1:1:${"f".repeat(64)}`,
    })?.reason,
    "conversation_activity_changed",
  );
});

test("proof mutation receipts pair attempts with stable privacy-bounded idempotency", () => {
  const root = realpathSync(mkdtempSync(tmpPrefix));
  try {
    const context = receiptContext(root);
    const mutationIdentity = `proof_nudge_comment:42:${"b".repeat(40)}:2026-07-14T12:00:00Z`;
    const first = startProofMutationReceipt({
      context,
      receiptIdentity: `${mutationIdentity}:request_attempt:1`,
      mutationIdentity,
      requestAttempt: 1,
    });
    finishProofMutationReceipt({ attempt: first, outcome: "accepted" });
    const second = startProofMutationReceipt({
      context,
      receiptIdentity: `${mutationIdentity}:request_attempt:2`,
      mutationIdentity,
      requestAttempt: 2,
    });
    finishProofMutationReceipt({ attempt: second, outcome: "unknown" });

    const events = readAllSpooledActionEvents(root).sort(
      (left, right) => left.phase_seq - right.phase_seq,
    );
    assert.deepEqual(
      events.map((event) => [
        event.phase_seq,
        event.action.status,
        event.action.mutation,
        event.action.retryable,
        event.attributes?.completion_reason,
      ]),
      [
        [1, "started", false, true, "mutation_attempted"],
        [2, "executed", true, false, "mutation_accepted"],
        [3, "started", false, true, "mutation_attempted"],
        [4, "failed", true, false, "mutation_outcome_unknown"],
      ],
    );
    assert.equal(events[0]?.idempotency_key_sha256, events[1]?.idempotency_key_sha256);
    assert.equal(events[0]?.idempotency_key_sha256, events[2]?.idempotency_key_sha256);
    assert.equal(events[2]?.idempotency_key_sha256, events[3]?.idempotency_key_sha256);
    assert.equal(events[1]?.parent_event_id, events[0]?.event_id);
    assert.equal(events[3]?.parent_event_id, events[2]?.event_id);
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /proof_nudge_comment|2026-07-14T12:00:00Z/);
    assert.deepEqual(events[0]?.privacy.fields_dropped, ["body", "comments", "logs", "prompt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof reconciliation reuses the business idempotency identity without claiming a write", () => {
  const root = realpathSync(mkdtempSync(tmpPrefix));
  try {
    const context = receiptContext(root, "4201");
    const mutationIdentity = `bot_proof_comment:42:${"b".repeat(40)}:${"c".repeat(64)}`;
    const event = recordProofMutationReconciliation({ context, mutationIdentity });
    const expectedIdentity = proofMutationBusinessIdentityForTest({
      lane: context.lane,
      repository: context.repository,
      number: context.number,
      headSha: context.headSha,
      mutationIdentity,
    });

    assert.equal(event?.action.status, "recovered");
    assert.equal(event?.action.reason_code, "already_complete");
    assert.equal(event?.action.mutation, false);
    assert.equal(event?.attributes?.completion_reason, "mutation_reconciled");
    assert.match(expectedIdentity.mutationIdentitySha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(event), /bot_proof_comment/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-run proof reconciliation follows and parents the unknown outcome", () => {
  const root = realpathSync(mkdtempSync(tmpPrefix));
  try {
    const context = receiptContext(root, "4202");
    const mutationIdentity = `bot_proof_comment:42:${"b".repeat(40)}:${"c".repeat(64)}`;
    const attempt = startProofMutationReceipt({
      context,
      receiptIdentity: `${mutationIdentity}:request_attempt:1`,
      mutationIdentity,
      requestAttempt: 1,
    });
    const outcome = finishProofMutationReceipt({ attempt, outcome: "unknown" });
    const reconciliation = recordProofMutationReconciliation({
      context,
      mutationIdentity,
      parentEventId: outcome?.event_id,
      phaseSeq: 3,
    });

    assert.equal(outcome?.phase_seq, 2);
    assert.equal(reconciliation?.phase_seq, 3);
    assert.equal(reconciliation?.parent_event_id, outcome?.event_id);
    assert.equal(outcome?.idempotency_key_sha256, reconciliation?.idempotency_key_sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crash-open proof attempt reconciles under the same business idempotency key", () => {
  const root = realpathSync(mkdtempSync(tmpPrefix));
  try {
    const attemptContext = receiptContext(root, "4203");
    const reconciliationContext = receiptContext(root, "4204");
    const mutationIdentity = `proof_nudge_comment:42:${"b".repeat(40)}:2026-07-14T12:00:00Z`;
    startProofMutationReceipt({
      context: attemptContext,
      receiptIdentity: `${mutationIdentity}:request_attempt:1`,
      mutationIdentity,
      requestAttempt: 1,
    });
    recordProofMutationReconciliation({
      context: reconciliationContext,
      mutationIdentity,
    });

    const events = readAllSpooledActionEvents(root);
    const attempt = events.find(
      (event) => event.attributes?.completion_reason === "mutation_attempted",
    );
    const reconciliation = events.find(
      (event) => event.attributes?.completion_reason === "mutation_reconciled",
    );

    assert.equal(attempt?.action.status, "started");
    assert.equal(reconciliation?.action.status, "recovered");
    assert.equal(reconciliation?.action.mutation, false);
    assert.equal(attempt?.idempotency_key_sha256, reconciliation?.idempotency_key_sha256);
    assert.notEqual(attempt?.attempt_id, reconciliation?.attempt_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
