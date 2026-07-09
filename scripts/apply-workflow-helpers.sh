#!/usr/bin/env bash

# Shared by the apply workflow step. The caller supplies the current apply
# settings as shell variables before sourcing this file.
# shellcheck disable=SC2034,SC2154

max_close_processed_limit=900
coverage_proof_limit=1
progress_every=10

publish_changes() {
  local message="$1"
  shift
  local publish_args=(--message "$message" --rebase-strategy apply-records)
  local path
  for path in "$@"; do
    publish_args+=(--path "$path")
  done
  pnpm run repair:publish-main -- "${publish_args[@]}"
}

publish_status() {
  local message="$1"
  if ! publish_changes "$message" results/sweep-status; then
    echo "Best-effort status update failed: $message"
    git restore results/sweep-status || true
  fi
}

write_apply_health() {
  local report_path="$1"
  local output_path="$2"
  local health_mode="$3"
  local health_processed_limit="$4"
  local health_cursor_path="${5:-}"
  local health_cursor_required="${6:-false}"
  local health_candidate_count="${7:-}"
  local health_scheduled_interval_minutes="${8:-}"
  local health_cursor_advance_count="${9:-}"
  local health_args=(
    --target-repo "$TARGET_REPO"
    --report "$report_path"
    --mode "$health_mode"
    --processed-limit "$health_processed_limit"
    --close-limit "$limit"
  )
  if [ -n "$health_cursor_path" ]; then
    health_args+=(--cursor-path "$health_cursor_path")
  fi
  if [ "$health_cursor_required" = "true" ]; then
    health_args+=(--cursor-required true)
  fi
  if [ -n "$health_candidate_count" ]; then
    health_args+=(--candidate-count "$health_candidate_count")
  fi
  if [ -n "$health_scheduled_interval_minutes" ]; then
    health_args+=(--scheduled-interval-minutes "$health_scheduled_interval_minutes")
  fi
  if [ -n "$health_cursor_advance_count" ]; then
    health_args+=(--cursor-advance-count "$health_cursor_advance_count")
  fi
  pnpm run --silent workflow -- summarize-apply-report "${health_args[@]}" > "$output_path"
}

apply_checkpoint_examined_count() {
  if [ "$auto_selected_apply_batch" = "true" ] && [ -n "$cursor_advance_count" ]; then
    printf '%s\n' "$cursor_advance_count"
  else
    printf '%s\n' "unavailable"
  fi
}

select_automatic_apply_runtime() {
  max_runtime_arg=()
  if [ "$auto_selected_apply_batch" = "true" ]; then
    max_runtime_arg=(--max-runtime-ms 600000)
  fi
}

automatic_apply_runtime_reached() {
  local report_path="$1"
  local runtime_cursor_advance_count="${2:-${cursor_advance_count:-}}"
  local runtime_auto_selected_apply_batch="${3:-${auto_selected_apply_batch:-false}}"
  local runtime_budget_count
  runtime_budget_count="$(pnpm run --silent workflow -- count-actions --report "$report_path" --action skipped_runtime_budget)"
  if [ "$runtime_budget_count" -eq 0 ]; then
    return 1
  fi
  if [ "$runtime_auto_selected_apply_batch" = "true" ] &&
    { [ -z "$runtime_cursor_advance_count" ] || [ "$runtime_cursor_advance_count" -eq 0 ]; }; then
    echo "Automatic close checkpoint reached its 600000ms runtime budget before cursor progress; cursor is unchanged and scheduled apply will retry without queueing an immediate continuation."
    return 0
  fi
  echo "Automatic close checkpoint reached its 600000ms runtime budget; cursor is persisted and a fresh-token continuation will resume the lane."
  continue_apply=true
  return 0
}

select_adaptive_apply_batch() {
  if [ "$sync_comments_only" = "true" ] || [ -n "$item_numbers" ]; then
    return
  fi
  mkdir -p .artifacts
  local adaptive_batch_env=".artifacts/apply-adaptive-batch.env"
  pnpm run --silent workflow -- adaptive-apply-batch-size \
    --status-path "results/sweep-status/${target_slug}.json" \
    --base-size "$base_close_processed_limit" \
    --max-size "$max_close_processed_limit" > "$adaptive_batch_env"
  cat "$adaptive_batch_env"
  close_processed_limit="$(awk -F= '$1 == "close_processed_limit" { print $2 }' "$adaptive_batch_env")"
  adaptive_apply_scan_reason="$(awk -F= '$1 == "adaptive_apply_scan_reason" { print $2 }' "$adaptive_batch_env")"
}

select_bounded_coverage_proof_tail() {
  local proof_args=(
    --target-repo "$TARGET_REPO"
    --apply-kind "$apply_kind"
    --apply-close-reasons "$apply_close_reasons"
    --stale-min-age-days "$stale_min_age_days"
    --min-age-days "$min_age_days"
    --min-age-minutes "$min_age_minutes"
    --item-numbers "$item_numbers"
  )
  coverage_proof_item_numbers="$(pnpm run --silent workflow -- proposed-pr-close-coverage-item-numbers "${proof_args[@]}")"
  coverage_proof_count="$(pnpm run --silent workflow -- count-csv --items "$coverage_proof_item_numbers")"
}

drop_bounded_coverage_proof_tail() {
  if [ "$auto_selected_apply_batch" != "true" ] || [ -z "$coverage_proof_item_numbers" ]; then
    return
  fi
  local cursor_trace_path="$1"
  local examined_item_numbers
  examined_item_numbers="$(pnpm run --silent workflow -- apply-cursor-trace-item-numbers --cursor-trace "$cursor_trace_path")"
  if [ -z "$examined_item_numbers" ]; then
    return
  fi
  local remaining=",${item_numbers},"
  local remaining_proof=",${coverage_proof_item_numbers},"
  local number
  for number in ${coverage_proof_item_numbers//,/ }; do
    if [[ ",${examined_item_numbers}," == *",${number},"* ]]; then
      remaining="${remaining//,${number},/,}"
      remaining_proof="${remaining_proof//,${number},/,}"
    fi
  done
  item_numbers="${remaining#,}"
  item_numbers="${item_numbers%,}"
  item_numbers_arg=()
  if [ -n "$item_numbers" ]; then
    item_numbers_arg=(--item-numbers "$item_numbers")
  fi
  coverage_proof_item_numbers="${remaining_proof#,}"
  coverage_proof_item_numbers="${coverage_proof_item_numbers%,}"
}

summarize_apply_candidate_quality() {
  candidate_quality_summary="not evaluated"
  candidate_quality_detail=""
  if [ "$sync_comments_only" = "true" ]; then
    return
  fi
  local quality_args=(
    --target-repo "$TARGET_REPO"
    --apply-kind "$apply_kind"
    --apply-close-reasons "$apply_close_reasons"
    --stale-min-age-days "$stale_min_age_days"
    --min-age-days "$min_age_days"
    --min-age-minutes "$min_age_minutes"
  )
  if [ -n "$item_numbers" ]; then
    quality_args+=(--item-numbers "$item_numbers")
  else
    quality_args+=(--batch-size "$close_processed_limit" --cursor-path "$apply_cursor_path")
  fi
  local candidate_quality_env=".artifacts/apply-candidate-quality.env"
  pnpm run --silent workflow -- proposed-item-quality-summary "${quality_args[@]}" > "$candidate_quality_env"
  cat "$candidate_quality_env"
  candidate_quality_summary="$(awk -F= '$1 == "candidate_quality_summary" { print $2 }' "$candidate_quality_env")"
  candidate_quality_detail=" Close candidate mix: $candidate_quality_summary."
}
