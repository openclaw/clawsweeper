import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./content-hash.js";
import { type ActionEvent, readActionEventShardAt } from "./action-ledger.js";
import {
  importActionEventShards,
  type ExpectedActionEventProducer,
} from "./action-ledger-runtime.js";
import {
  prepareSafeReadTarget,
  prepareSafeWriteTarget,
  readUtf8FileNoFollow,
  writeUtf8FileCreateOnlyNoFollow,
} from "./action-ledger-files.js";
import { readReportFrontMatterField } from "./report-front-matter.js";

type Disposition = "completed" | "terminal" | "retryable" | "held";
type RecoveryItem = {
  number: number;
  disposition: Disposition;
  reason: string;
  publication: "not_requested" | "staged" | "held";
};

export type ReviewRecoveryOptions = {
  ledgerDir: string;
  expectedProducer: Extract<ExpectedActionEventProducer, { runAttempt: number }>;
  targetRepo: string;
  shard: number;
  shardCount: number;
  itemNumbers: readonly number[];
  reportsDir?: string;
  stageDir?: string;
};

// These shapes belong to createReviewActionLedger, not the interruption finalizer.
// Unknown variants stay held; mutation receipts must never become item terminals.
function attributesAre(event: ActionEvent, required: string[], optional: string[] = []): boolean {
  const attributes = event.attributes ?? {};
  return (
    required.every((key) => key in attributes) &&
    Object.keys(attributes).every((key) => required.includes(key) || optional.includes(key))
  );
}

function nativeTerminal(event: ActionEvent): boolean {
  return (
    event.event_type === "review.item" &&
    ["completed", "cached", "failed", "blocked", "cancelled", "yielded"].includes(
      event.action.status,
    ) &&
    attributesAre(
      event,
      ["cached", "duration_ms", "review_mode"],
      ["finding_count", "completion_reason"],
    ) &&
    event.attributes?.cached === (event.action.status === "cached") &&
    typeof event.attributes.duration_ms === "number" &&
    event.attributes.duration_ms >= 0 &&
    event.attributes.review_mode === "propose"
  );
}

function itemDisposition(
  events: ActionEvent[],
  batch: ActionEvent,
): {
  disposition: Disposition;
  reason: string;
  terminal?: ActionEvent;
} {
  const held = (reason: string) => ({ disposition: "held" as const, reason });
  const start = events[0];
  if (!start) return held("unstarted_or_unselected");
  if (
    start.event_type !== "review.item" ||
    start.action.status !== "started" ||
    start.action.retryable ||
    start.action.mutation ||
    start.action.reason_code !== "selected" ||
    start.parent_event_id !== batch.event_id ||
    !attributesAre(start, ["batch_index", "review_mode"]) ||
    start.attributes?.review_mode !== "propose" ||
    !Number.isSafeInteger(start.attributes.batch_index) ||
    Number(start.attributes.batch_index) < 0 ||
    Number(start.attributes.batch_index) >= Number(batch.attributes?.candidate_count)
  )
    return held("unrecognized_item_start");
  let parent = start.event_id;
  let terminal: ActionEvent | undefined;
  let pending: ActionEvent | undefined;
  let mutationObserved = false;
  let uncertain = false;
  let mutationCount = 0;
  let logs = 0;
  for (const event of events.slice(1)) {
    if (event.parent_event_id !== parent || event.subject.kind !== start.subject.kind) {
      return held("ambiguous_item_chain");
    }
    parent = event.event_id;
    if (event.event_type === "review.log_publication") {
      if (
        ++logs !== 1 ||
        terminal ||
        pending ||
        event.action.mutation ||
        !attributesAre(event, ["cached", "log_count", "log_kind", "publication_kind"]) ||
        event.attributes?.log_kind !== "codex" ||
        event.attributes.publication_kind !== "local_artifact"
      )
        return held("unrecognized_log_phase");
    } else if (nativeTerminal(event)) {
      if (terminal || pending || logs !== 1 || event.action.mutation !== mutationObserved) {
        return held("ambiguous_item_terminal");
      }
      terminal = event;
    } else if (
      event.event_type === "review.item" &&
      attributesAre(event, [
        "batch_index",
        "attempt",
        "action_count",
        "partial",
        "completion_reason",
      ]) &&
      event.attributes?.batch_index === start.attributes.batch_index
    ) {
      const attrs = event.attributes!;
      if (attrs.completion_reason === "mutation_attempted") {
        if (
          pending ||
          event.action.status !== "started" ||
          !event.action.retryable ||
          event.action.mutation ||
          event.action.reason_code !== "selected" ||
          attrs.partial !== true ||
          attrs.action_count !== 1 ||
          attrs.attempt !== ++mutationCount
        )
          return held("unrecognized_mutation_attempt");
        pending = event;
      } else {
        if (
          !pending ||
          pending.event_id !== event.parent_event_id ||
          pending.idempotency_key_sha256 !== event.idempotency_key_sha256 ||
          attrs.attempt !== pending.attributes?.attempt
        )
          return held("unmatched_mutation_outcome");
        const accepted =
          attrs.completion_reason === "mutation_accepted" &&
          event.action.status === "executed" &&
          event.action.reason_code === "completed" &&
          !event.action.retryable &&
          event.action.mutation &&
          attrs.partial === false &&
          attrs.action_count === 1;
        const rejected =
          attrs.completion_reason === "mutation_rejected" &&
          event.action.status === "skipped" &&
          event.action.reason_code === "not_applicable" &&
          !event.action.retryable &&
          !event.action.mutation &&
          attrs.partial === false &&
          attrs.action_count === 0;
        const unknown =
          attrs.completion_reason === "mutation_outcome_unknown" &&
          event.action.status === "failed" &&
          event.action.reason_code === "unavailable" &&
          event.action.retryable &&
          event.action.mutation &&
          attrs.partial === true &&
          attrs.action_count === 1;
        if (!accepted && !rejected && !unknown) return held("unrecognized_mutation_outcome");
        mutationObserved ||= accepted || unknown;
        uncertain ||= unknown;
        pending = undefined;
      }
    } else return held("unsupported_item_event");
  }
  // Cleanup can append receipts after a terminal. Never stop the fold at completion.
  if (pending || uncertain) return held("unresolved_mutation");
  if (!terminal) return held("missing_item_terminal");
  const disposition = ["completed", "cached"].includes(terminal.action.status)
    ? "completed"
    : terminal.action.retryable
      ? "retryable"
      : "terminal";
  return { disposition, reason: terminal.action.reason_code ?? terminal.action.status, terminal };
}

function stageReport(options: ReviewRecoveryOptions, terminal: ActionEvent): void {
  const number = terminal.subject.number!;
  const filename = `${number}.md`;
  const markdown = readUtf8FileNoFollow(
    prepareSafeReadTarget(options.reportsDir!, filename, "completed review report"),
    2 * 1024 * 1024,
  );
  const evidence = terminal.evidence?.filter((entry) => entry.kind === "review_record") ?? [];
  const field = (key: string) => {
    const parsed = readReportFrontMatterField(markdown, key);
    if (parsed.status !== "value") return "";
    const value = parsed.value.trim();
    return value.startsWith('"') ? String(JSON.parse(value)) : value;
  };
  const revision = terminal.subject.source_revision;
  if (
    evidence.length !== 1 ||
    evidence[0]?.sha256 !== sha256(markdown) ||
    field("repository") !== options.targetRepo ||
    field("number") !== String(number) ||
    field("type") !== terminal.subject.kind ||
    field("review_status") !== "complete" ||
    field("local_checkout_access") !== "verified" ||
    field("local_checkout_access_source") !== "runner_preflight_v1" ||
    !revision ||
    (field("item_source_revision") !== revision &&
      !(
        terminal.action.status === "cached" &&
        terminal.subject.kind === "pull_request" &&
        field("pull_head_sha") === revision
      ))
  )
    throw new Error("completed report identity, digest, or completion evidence mismatch");
  const target = prepareSafeWriteTarget(options.stageDir!, filename, "completed review staging");
  if (
    writeUtf8FileCreateOnlyNoFollow(target, markdown) === "exists" &&
    readUtf8FileNoFollow(target, 2 * 1024 * 1024) !== markdown
  ) {
    throw new Error("completed review staging conflict");
  }
}

export function recoverReviewShard(options: ReviewRecoveryOptions) {
  if (
    !Number.isSafeInteger(options.shard) ||
    options.shard < 0 ||
    !Number.isSafeInteger(options.shardCount) ||
    options.shard >= options.shardCount ||
    options.itemNumbers.length > 10000 ||
    new Set(options.itemNumbers).size !== options.itemNumbers.length ||
    options.itemNumbers.some((number) => !Number.isSafeInteger(number) || number < 1) ||
    Boolean(options.reportsDir) !== Boolean(options.stageDir) ||
    !Number.isSafeInteger(options.expectedProducer.runAttempt) ||
    options.expectedProducer.runAttempt < 1 ||
    options.expectedProducer.maxRunAttempt !== undefined
  )
    throw new Error("invalid review recovery shard input");
  const items: RecoveryItem[] = options.itemNumbers.map((number) => ({
    number,
    disposition: "held",
    reason: "missing_or_invalid_ledger",
    publication: options.stageDir ? "held" : "not_requested",
  }));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "clawsweeper-recovery-import-")));
  let evidenceComplete = false;
  try {
    const imported = importActionEventShards(options.ledgerDir, scratch, {
      expectedProducer: options.expectedProducer,
    });
    const events = imported.eventPaths.flatMap((file) => readActionEventShardAt(scratch, file));
    const batches = events.filter((event) => event.event_type === "review.batch");
    const start = batches.find((event) => event.action.status === "started");
    const end = batches.find((event) => event.action.status !== "started");
    if (
      batches.length !== 2 ||
      !start ||
      !end ||
      start.phase_seq !== 1 ||
      start.parent_event_id !== null ||
      start.action.name !== "review.batch" ||
      start.action.reason_code !== "selected" ||
      start.action.retryable ||
      start.action.mutation ||
      start.subject.repository !== options.targetRepo ||
      start.subject.kind !== "workflow" ||
      !attributesAre(start, [
        "candidate_count",
        "batch_size",
        "shard_index",
        "shard_count",
        "review_mode",
      ]) ||
      start.attributes?.shard_index !== options.shard ||
      start.attributes.shard_count !== options.shardCount ||
      start.attributes.review_mode !== "propose" ||
      !Number.isSafeInteger(start.attributes.candidate_count) ||
      Number(start.attributes.candidate_count) < 0 ||
      Number(start.attributes.candidate_count) > options.itemNumbers.length ||
      end.phase_seq !== 1_000_000 ||
      end.parent_event_id !== start.event_id ||
      end.subject.repository !== options.targetRepo ||
      end.subject.kind !== "workflow" ||
      !["completed", "failed", "cancelled", "yielded"].includes(end.action.status) ||
      !attributesAre(end, [
        "candidate_count",
        "processed_count",
        "skipped_count",
        "failed_count",
        "duration_ms",
        "cached",
        "partial",
        "completion_reason",
        "review_mode",
      ]) ||
      end.attributes?.candidate_count !== start.attributes.candidate_count ||
      end.attributes?.review_mode !== "propose"
    )
      return summarize();
    const phases = events.filter(
      (event) =>
        event.operation_id === start.operation_id ||
        ["review.batch", "review.item", "review.log_publication"].includes(event.event_type),
    );
    if (
      phases.some(
        (event) =>
          event.operation_id !== start.operation_id ||
          event.attempt_id !== start.attempt_id ||
          JSON.stringify(event.producer) !== JSON.stringify(start.producer) ||
          event.subject.repository !== options.targetRepo ||
          event.action.name !== event.event_type ||
          event.phase_seq < 1 ||
          event.phase_seq > end.phase_seq ||
          !["review.batch", "review.item", "review.log_publication"].includes(event.event_type),
      ) ||
      new Set(phases.map((event) => event.phase_seq)).size !== phases.length
    )
      return summarize();
    const perItem = new Map<number, ActionEvent[]>();
    for (const event of phases.filter((event) => event.event_type !== "review.batch")) {
      if (
        !event.subject.number ||
        !options.itemNumbers.includes(event.subject.number) ||
        !["issue", "pull_request"].includes(event.subject.kind)
      )
        return summarize();
      const current = perItem.get(event.subject.number) ?? [];
      current.push(event);
      perItem.set(event.subject.number, current);
    }
    const indexes = [...perItem.values()].map(
      (events) => events.toSorted((a, b) => a.phase_seq - b.phase_seq)[0]?.attributes?.batch_index,
    );
    if (new Set(indexes).size !== indexes.length) return summarize();
    evidenceComplete = true;
    if (options.stageDir) mkdirSync(options.stageDir, { recursive: true });
    for (const item of items) {
      const result = itemDisposition(
        (perItem.get(item.number) ?? []).toSorted((a, b) => a.phase_seq - b.phase_seq),
        start,
      );
      item.disposition = result.disposition;
      item.reason = result.reason;
      if (options.stageDir && result.disposition === "completed" && result.terminal) {
        try {
          stageReport(options, result.terminal);
          item.publication = "staged";
        } catch {
          item.reason = "completed_report_held";
        }
      }
    }
  } catch {
    // Artifact loss/corruption is an intentional visible hold, never a retry fallback.
    evidenceComplete = false;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return summarize();

  function summarize() {
    return {
      shard: options.shard,
      evidence_complete: evidenceComplete,
      items,
      retryable: evidenceComplete
        ? items.filter((item) => item.disposition === "retryable").map((item) => item.number)
        : [],
      staged: evidenceComplete
        ? items.filter((item) => item.publication === "staged").map((item) => item.number)
        : [],
    };
  }
}
