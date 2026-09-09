import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createReviewActionLedger } from "../../../dist/clawsweeper-review-ledger.js";
import { createReviewPlanningSelection } from "../../../dist/clawsweeper-review-planning-selection.js";
import { issueSourceRevisionSha256 } from "../../../dist/repair/issue-source-guard.js";
import {
  AgentInputScanError,
  agentInputScanFailureExitCode,
} from "../../../dist/agent-input-scan.js";
import { flushWorkflowActionEvents } from "../../../dist/action-ledger-runtime.js";
import {
  actionEventKey,
  actionOperationId,
  actionAttemptId,
  createActionEvent,
  readActionEventShard,
  writeActionEventShard,
} from "../../../dist/action-ledger.js";

export const baselineSha = "7f29952363878ca3b5d1f25be8d40a9f6ced784c";
export const targetRepo = "openclaw/clawsweeper";
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const producerEnv = {
  GITHUB_REPOSITORY: targetRepo,
  GITHUB_SHA: baselineSha,
  GITHUB_WORKFLOW_REF: `${targetRepo}/.github/workflows/sweep.yml@refs/heads/main`,
  GITHUB_WORKFLOW: "ClawSweeper",
  GITHUB_JOB: "review",
  GITHUB_ACTION: "review-shard",
  GITHUB_RUN_ID: "123456",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_STARTED_AT: "2026-09-08T08:00:00Z",
  CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
};

export function fixtureIssue(number) {
  return {
    number: Number(number),
    title: "Synthetic recovery fixture",
    body: "Synthetic issue",
    html_url: `https://github.com/${targetRepo}/issues/${number}`,
    created_at: producerEnv.GITHUB_RUN_STARTED_AT,
    updated_at: producerEnv.GITHUB_RUN_STARTED_AT,
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 0,
    pull_request: null,
  };
}

export async function fixture(root, kind = "mixed") {
  mkdirSync(root, { recursive: true });
  const reports = join(root, "artifacts");
  const ledgerDir = join(root, "ledger");
  mkdirSync(reports, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  const planned = kind === "filtered" ? [1, 2, 3] : [1, 2, 3, 4, 5, 6, 7, 8];
  const items = planned.map((number) => ({
    repo: targetRepo,
    number,
    kind: "issue",
    title: "Synthetic recovery fixture",
    updatedAt: producerEnv.GITHUB_RUN_STARTED_AT,
  }));
  const { selectCandidates } = createReviewPlanningSelection({
    fetchItem: (number) => ({
      item: items.find((item) => item.number === number),
      state: kind === "filtered" && number === 2 ? "closed" : "open",
    }),
  });
  const { candidates } = selectCandidates({
    itemNumbers: planned,
    batchSize: planned.length,
    maxPages: 1,
    shardIndex: 0,
    shardCount: 1,
    itemsDir: reports,
  });
  const originalEnv = process.env;
  process.env = { ...producerEnv };
  try {
    const owner = createReviewActionLedger({
      root,
      targetRepo: () => targetRepo,
      repoRelativePath: (file) => relative(root, file),
      sha256: digest,
      isRuntimeBudgetError: () => false,
    });
    const ledger = owner.startReviewActionLedger({
      candidates,
      reviewPolicy: "synthetic",
      shardIndex: 0,
      shardCount: 1,
      batchSize: planned.length,
    });
    const start = (number) => {
      const item = candidates.find((item) => item.number === number);
      owner.startReviewActionLedgerItem(ledger, item);
      return item;
    };
    const finish = (item, status, retryable, extra = {}) =>
      owner.finishReviewActionLedgerItem({
        ledger,
        item,
        status,
        reasonCode: status === "completed" ? "completed" : "exception",
        retryable,
        cached: status === "cached",
        startedAtMs: ledger.startedAtMs,
        ...extra,
      });
    const mutation = (item, outcome) => {
      try {
        owner.reviewMutationRunner(
          ledger,
          item,
        )({
          identity: `synthetic-${outcome}`,
          idempotencyIdentity: `synthetic-${outcome}`,
          operation: () => {
            if (outcome === "unknown") throw new Error("synthetic uncertain cleanup");
            return outcome === "accepted";
          },
          didMutate: (result) => result,
        });
      } catch (error) {
        if (error.message !== "synthetic uncertain cleanup") throw error;
      }
    };
    if (kind === "filtered") {
      start(1);
    } else {
      for (const number of [1, 2]) {
        const item = start(number);
        const revision = issueSourceRevisionSha256(fixtureIssue(number));
        const report = `---
repository: ${kind === "report-identity" && number === 1 ? "example/other" : targetRepo}
number: ${number}
type: issue
title: Synthetic recovery fixture
url: https://github.com/${targetRepo}/issues/${number}
author: reporter
author_association: CONTRIBUTOR
reviewed_at: ${producerEnv.GITHUB_RUN_STARTED_AT}
item_updated_at: ${producerEnv.GITHUB_RUN_STARTED_AT}
item_source_revision: ${revision}
item_snapshot_hash: synthetic-proof-snapshot
labels: []
review_status: complete
local_checkout_access: verified
local_checkout_access_source: runner_preflight_v1
decision: keep_open
action_taken: kept_open
close_reason: none
confidence: high
work_candidate: none
work_status: none
---

# Synthetic recovery fixture

## Summary

Complete retained review.
`;
        const reportPath = join(reports, `${number}.md`);
        writeFileSync(reportPath, report);
        finish(item, number === 1 ? "completed" : "cached", false, {
          reportPath,
          sourceRevision: revision,
        });
      }
      const retryable = start(3);
      if (kind === "accepted-mutation") mutation(retryable, "accepted");
      finish(retryable, "failed", true);
      const deferred = start(4);
      mutation(deferred, "rejected");
      finish(deferred, "blocked", true, { completionReason: "coordination_deferred" });
      const uncertain = start(5);
      mutation(uncertain, "unknown");
      finish(uncertain, "failed", true);
      const late = start(6);
      finish(late, "failed", true);
      // Match producer cleanup order: another item fails before earlier-item cleanup.
      start(7);
      mutation(late, "unknown");
      if (kind === "late-completed") mutation(candidates[0], "unknown");
    }
    const activeItem = candidates.find((item) => item.number === (kind === "filtered" ? 1 : 7));
    const error = new AgentInputScanError("findings");
    owner.finishReviewActionLedger({
      ledger,
      error,
      activeItem,
      completedCount: kind === "filtered" ? 0 : 2,
      cacheHits: kind === "filtered" ? 0 : 1,
    });
    await flushWorkflowActionEvents(root, { outputRoot: ledgerDir });
    return {
      planned,
      selected: candidates.map((item) => item.number),
      ledgerDir,
      reports,
      originalReviewExit: agentInputScanFailureExitCode(error),
    };
  } finally {
    process.env = originalEnv;
  }
}

export function rewriteLedger(ledgerDir, transform, partCount = 1) {
  const files = readdirSync(ledgerDir, { recursive: true }).filter((name) =>
    name.endsWith(".jsonl"),
  );
  const events = files.flatMap((name) => readActionEventShard(join(ledgerDir, name)));
  const modified = transform(events).map((event) =>
    createActionEvent({
      eventKey: event.event_key,
      operationId: event.operation_id,
      attemptId: event.attempt_id,
      parentEventId: event.parent_event_id,
      phaseSeq: event.phase_seq,
      idempotencyKeySha256: event.idempotency_key_sha256,
      type: event.event_type,
      producer: {
        component: event.producer.component,
        repository: event.producer.repository,
        sha: event.producer.sha,
        workflow: event.producer.workflow,
        job: event.producer.job,
        runId: event.producer.run_id,
        runAttempt: event.producer.run_attempt,
      },
      subject: {
        repository: event.subject.repository,
        kind: event.subject.kind,
        ...(event.subject.number ? { number: event.subject.number } : {}),
        ...(event.subject.source_revision ? { sourceRevision: event.subject.source_revision } : {}),
      },
      action: {
        name: event.action.name,
        status: event.action.status,
        retryable: event.action.retryable,
        mutation: event.action.mutation,
        reasonCode: event.action.reason_code,
      },
      attributes: event.attributes,
      evidence: event.evidence?.map((entry) => ({
        kind: entry.kind,
        ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
        ...(entry.run_url ? { runUrl: entry.run_url } : {}),
      })),
      privacy: {
        classification: event.privacy.classification,
        redactionVersion: event.privacy.redaction_version,
        fieldsDropped: event.privacy.fields_dropped,
      },
    }),
  );
  const producer = modified[0].producer;
  const identity = {
    repository: producer.repository,
    sha: producer.sha,
    workflow: producer.workflow,
    job: producer.job,
    runId: producer.run_id,
    runAttempt: producer.run_attempt,
    producer: producer.component,
    partitionDate: "2026-09-08",
  };
  rmSync(ledgerDir, { recursive: true });
  mkdirSync(ledgerDir);
  writeActionEventShard(ledgerDir, identity, modified, 1, partCount);
}

export function perturbFixture(seeded, kind) {
  if (kind === "missing") {
    rmSync(seeded.ledgerDir, { recursive: true });
    mkdirSync(seeded.ledgerDir);
  } else if (kind === "incomplete") {
    rewriteLedger(seeded.ledgerDir, (events) => events, 2);
  } else if (kind === "report-digest") {
    appendFileSync(join(seeded.reports, "1.md"), "\nChanged after the recorded terminal.\n");
  } else if (kind === "foreign-batch") {
    rewriteLedger(seeded.ledgerDir, (events) =>
      events.map((event) => {
        if (event.event_type !== "review.batch" || event.phase_seq !== 1_000_000) return event;
        const operationId = actionOperationId(targetRepo, "review", { fixture: "foreign-batch" });
        return {
          ...event,
          operation_id: operationId,
          attempt_id: actionAttemptId(operationId, { fixture: "foreign-batch" }),
        };
      }),
    );
  } else if (kind === "ambiguous") {
    rewriteLedger(seeded.ledgerDir, (events) => {
      const terminal = events.find(
        (event) => event.subject.number === 3 && event.attributes?.duration_ms !== undefined,
      );
      const phase =
        Math.max(
          ...events.filter((event) => event.phase_seq < 1_000_000).map((event) => event.phase_seq),
        ) + 1;
      return [
        ...events,
        {
          ...terminal,
          event_key: actionEventKey("synthetic.duplicate-terminal", { number: 3 }),
          phase_seq: phase,
          parent_event_id: terminal.event_id,
        },
      ];
    });
  } else if (
    [
      "unmatched",
      "mutation-only",
      "unsupported",
      "missing-terminal",
      "wrong-shard",
      "receipt-reason",
    ].includes(kind)
  ) {
    rewriteLedger(seeded.ledgerDir, (events) =>
      events.flatMap((event) => {
        if (
          kind === "unmatched" &&
          event.subject.number === 6 &&
          event.attributes?.completion_reason === "mutation_outcome_unknown"
        )
          return [];
        if (
          kind === "missing-terminal" &&
          event.event_type === "review.batch" &&
          event.phase_seq === 1_000_000
        )
          return [];
        if (
          kind === "mutation-only" &&
          event.subject.number === 3 &&
          event.attributes?.review_mode === "propose" &&
          event.action.status === "failed"
        )
          return [];
        if (
          kind === "unsupported" &&
          event.subject.number === 3 &&
          event.attributes?.duration_ms !== undefined
        ) {
          const { duration_ms, ...attributes } = event.attributes;
          return [{ ...event, attributes }];
        }
        if (kind === "wrong-shard" && event.attributes?.shard_index === 0) {
          return [{ ...event, attributes: { ...event.attributes, shard_index: 1 } }];
        }
        if (
          kind === "receipt-reason" &&
          event.subject.number === 4 &&
          event.action.status === "skipped"
        ) {
          return [{ ...event, action: { ...event.action, reason_code: "completed" } }];
        }
        return [event];
      }),
    );
  }
}

if (process.argv[2] === "--produce-failure") {
  const result = await fixture(process.argv[3], process.argv[4]);
  perturbFixture(result, process.argv[4]);
  console.log(JSON.stringify(result));
  process.exitCode = result.originalReviewExit;
}
