#!/usr/bin/env bash

# Shared by the apply workflow step. The caller supplies the current apply
# settings as shell variables before sourcing this file.
# shellcheck disable=SC2034,SC2154

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
