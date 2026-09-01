export const EXACT_REVIEW_QUEUE_TRACE_HEADER = "x-clawsweeper-exact-review-trace";

const TRACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const EXACT_REVIEW_QUEUE_ENDPOINTS = new Map<string, string>([
  ["/artifact-cache/receipt/lookup", "artifact_cache_receipt_lookup"],
  ["/artifact-cache/receipt/store", "artifact_cache_receipt_store"],
  ["/bay-lifecycle-metrics", "bay_lifecycle_metrics"],
  ["/branch-authority", "branch_authority"],
  ["/claim", "claim"],
  ["/claimed-runs", "claimed_runs"],
  ["/command-intake", "command_intake"],
  ["/complete", "complete"],
  ["/dead-letters/list", "dead_letters_list"],
  ["/dead-letters/recover-fresh", "dead_letters_recover_fresh"],
  ["/dead-letters/replay", "dead_letters_replay"],
  ["/dead-letters/resolve", "dead_letters_resolve"],
  ["/enqueue", "enqueue"],
  ["/github-egress-observability", "github_egress_observability"],
  ["/github-egress-telemetry", "github_egress_telemetry"],
  ["/github-etag-cache/confirm", "github_etag_cache_confirm"],
  ["/github-etag-cache/lookup", "github_etag_cache_lookup"],
  ["/github-etag-cache/store", "github_etag_cache_store"],
  ["/github-read-model/activity", "github_read_model_activity"],
  ["/github-read-model/comments", "github_read_model_comments"],
  ["/github-read-model/ingest", "github_read_model_ingest"],
  ["/github-read-model/item", "github_read_model_item"],
  ["/github-read-model/lease-item", "github_read_model_lease_item"],
  ["/github-read-model/placeholders", "github_read_model_placeholders"],
  ["/github-read-model/repair", "github_read_model_repair"],
  ["/github-read-model/workflows", "github_read_model_workflows"],
  ["/heartbeat", "heartbeat"],
  ["/item-status", "item_status"],
  ["/lifecycle-audit/inventory", "lifecycle_audit_inventory"],
  ["/lifecycle-bay", "lifecycle_bay"],
  ["/lifecycle/canonical-receipt", "lifecycle_canonical_receipt"],
  ["/lifecycle/command-ack/attempt", "lifecycle_command_ack_attempt"],
  ["/lifecycle/command-ack/failed", "lifecycle_command_ack_failed"],
  ["/lifecycle/command-ack/observed", "lifecycle_command_ack_observed"],
  ["/lifecycle/router-receipt", "lifecycle_router_receipt"],
  ["/lifecycle/terminal-disposition", "lifecycle_terminal_disposition"],
  ["/parked-reviews/list", "parked_reviews_list"],
  ["/parked-reviews/recover-fresh", "parked_reviews_recover_fresh"],
  ["/parked-reviews/resolve", "parked_reviews_resolve"],
  ["/publication-batch-results", "publication_batch_results"],
  ["/publication-batches/claim", "publication_batches_claim"],
  ["/publication-batches/complete", "publication_batches_complete"],
  ["/publication-batches/fetch", "publication_batches_fetch"],
  ["/publication-batches/heartbeat", "publication_batches_heartbeat"],
  ["/publication-results", "publication_results"],
  ["/publications/list", "publications_list"],
  ["/publications/reconcile", "publications_reconcile"],
  ["/publications/supersede", "publications_supersede"],
  ["/recent-durable-publication-events", "recent_durable_publication_events"],
  ["/reconcile", "reconcile"],
  ["/records/commits", "records_commits"],
  ["/records/export", "records_export"],
  ["/records/list", "records_list"],
  ["/records/slugs", "records_slugs"],
  ["/records/snapshots/chunk", "records_snapshots_chunk"],
  ["/records/snapshots/latest", "records_snapshots_latest"],
  ["/records/snapshots/trigger", "records_snapshots_trigger"],
  ["/records/tuples", "records_tuples"],
  ["/review-coverage", "review_coverage"],
  ["/review-coverage/inventory", "review_coverage_inventory"],
  ["/review-observability", "review_observability"],
  ["/review-run-telemetry", "review_run_telemetry"],
  ["/source-authority", "source_authority"],
  ["/source-authority/complete", "source_authority_complete"],
  ["/state-writer-progress", "state_writer_progress"],
  ["/state-writer/acquire", "state_writer_acquire"],
  ["/state-writer/heartbeat", "state_writer_heartbeat"],
  ["/state-writer/release", "state_writer_release"],
  ["/stats", "stats"],
  ["/telemetry-reconciliation", "telemetry_reconciliation"],
  ["/terminal-finalization/attempt", "terminal_finalization_attempt"],
  ["/terminal-finalization/retry", "terminal_finalization_retry"],
  ["/terminal-finalization/skip", "terminal_finalization_skip"],
]);

export function newExactReviewQueueTraceId(): string {
  return crypto.randomUUID();
}

export function exactReviewQueueTraceId(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.toLowerCase() : "";
  return TRACE_ID_PATTERN.test(candidate) ? candidate : null;
}

export function exactReviewQueueEndpointTemplate(path: string): string {
  const pathname = path.split("?", 1)[0] || "";
  const exact = EXACT_REVIEW_QUEUE_ENDPOINTS.get(pathname);
  if (exact) return exact;
  if (/^\/records\/[^/]+\/(?:items|closed|plans|decision-packets)\/[1-9]\d*$/.test(pathname)) {
    return "records_item";
  }
  if (
    /^\/cursors\/(?:hot-intake|normal-review|audit|review-placeholder-[a-f0-9]{16}-(?:open|closed))$/.test(
      pathname,
    )
  ) {
    return "cursor";
  }
  return "other";
}
