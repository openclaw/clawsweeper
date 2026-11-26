import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSafeReadRoot } from "./action-ledger-files.js";
import { readImportedActionEventShards } from "./action-ledger-import.js";
import { actionLedgerJson, type ActionEvent } from "./action-ledger.js";
import { isNativeReviewTerminal } from "./review-recovery.js";

/** Inspect canonical retained shards without importing them or creating state. */
export function readReviewUsageReport(sourceRoot: string, relativePaths: readonly string[]) {
  if (relativePaths.length === 0) throw new Error("At least one action-event shard is required.");
  const shards = readImportedActionEventShards(
    prepareSafeReadRoot(sourceRoot, "review usage report"),
    relativePaths,
  );
  const events = new Map(
    shards.flatMap((shard) => shard.events.map((event) => [event.event_id, event] as const)),
  );
  const seen = new Set<string>();
  const itemIdentity = (event: ActionEvent) =>
    actionLedgerJson([
      event.operation_id,
      event.attempt_id,
      event.subject.repository,
      event.subject.kind,
      event.subject.number,
    ]);
  const starts = new Set(
    [...events.values()]
      .filter(
        (event) =>
          event.event_type === "review.item" &&
          event.action.status === "started" &&
          event.attributes?.review_mode === "propose",
      )
      .map(itemIdentity),
  );
  const rows = [];
  let unrecognizedReviewEvents = 0;
  for (const event of events.values()) {
    if (!isNativeReviewTerminal(event)) {
      if (event.event_type === "review.item") unrecognizedReviewEvents += 1;
      continue;
    }
    const identity = itemIdentity(event);
    if (seen.has(identity)) throw new Error("Multiple review terminals for the same item attempt.");
    seen.add(identity);
    const attributes = event.attributes!;
    rows.push({
      operation_id: event.operation_id,
      attempt_id: event.attempt_id,
      producer: event.producer,
      subject: event.subject,
      outcome: event.action.status,
      cached: attributes.cached === true,
      usage:
        attributes.work_kind === "full-review" && typeof attributes.input_tokens === "number"
          ? {
              input_tokens: attributes.input_tokens,
              output_tokens: attributes.output_tokens as number,
            }
          : null,
    });
  }
  rows.sort((left, right) => actionLedgerJson(left).localeCompare(actionLedgerJson(right), "en"));
  return {
    coverage: {
      selection: "provided-shards-only",
      items: rows.length,
      started_items: starts.size,
      missing_terminal_items: [...starts].filter((identity) => !seen.has(identity)).length,
      measured_items: rows.filter((row) => row.usage !== null).length,
      cached_items: rows.filter((row) => row.cached).length,
      unknown_usage_items: rows.filter((row) => row.usage === null && !row.cached).length,
      other_review_events: unrecognizedReviewEvents,
      queue_committed_starts: "unavailable",
      loaded_configuration: "unavailable",
      actual_billing: "unavailable",
    },
    rows,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, ...paths] = process.argv.slice(2);
    if (!root)
      throw new Error("usage: review-usage-report <source-root> <relative-shard-path> [...]");
    console.log(JSON.stringify(readReviewUsageReport(root, paths), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
