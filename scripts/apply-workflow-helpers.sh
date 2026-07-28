#!/usr/bin/env bash

# Shared by the apply workflow step. The caller supplies the current apply
# settings as shell variables before sourcing this file.
# shellcheck disable=SC2034,SC2154

max_close_processed_limit=1800
coverage_proof_limit=2
apply_token_budget_ms=3300000

initialize_apply_token_budget() {
  local minted_at_ms="${CLAWSWEEPER_APPLY_TOKEN_MINTED_AT_MS:-}"
  if ! [[ "$minted_at_ms" =~ ^[0-9]+$ ]]; then
    echo "Target write token mint time is missing or invalid." >&2
    return 1
  fi
  CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS=$((minted_at_ms + apply_token_budget_ms))
  export CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS
  echo "Apply token deadline is ${CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS}ms since epoch (55 minutes after mint)."
}

apply_token_budget_reached() {
  local report_path="$1"
  jq -e '
    any(.[];
      .action == "skipped_runtime_budget" and
      ((.reason // "") | startswith("apply token budget reached"))
    )
  ' "$report_path" >/dev/null
}

apply_token_budget_stop_summary() {
  local processed="$1"
  local remaining="$2"
  echo "apply stopped at token budget: processed=$processed remaining=~$remaining; next run continues"
}

report_apply_token_budget_stop() {
  local report_path="$1"
  local processed="$2"
  local remaining="$3"
  if apply_token_budget_reached "$report_path"; then
    apply_token_budget_stop_summary "$processed" "$remaining"
  fi
}

validate_coverage_proof_tree() {
  local proof_dir="$1"
  local max_files="${2:-2}"
  local max_file_bytes="${3:-262144}"
  local max_total_bytes="${4:-524288}"
  mkdir -p "$proof_dir"
  local unexpected
  unexpected="$(find "$proof_dir" -mindepth 1 -maxdepth 1 ! -type f -print -quit)"
  if [ -n "$unexpected" ]; then
    echo "Unexpected non-file coverage proof artifact: $unexpected" >&2
    return 1
  fi
  local proof_files=()
  local manifest_path="$proof_dir/manifest.json"
  if [ ! -f "$manifest_path" ]; then
    echo "Coverage proof artifact is missing manifest.json" >&2
    return 1
  fi
  if ! jq -e '
    type == "object" and
    .schemaVersion == 1 and
    (.targetRepo | type == "string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) and
    (.selectedItems | type == "array" and all(.[]; type == "number" and . >= 1 and floor == .)) and
    (.proofCount | type == "number" and . >= 0 and floor == .)
  ' "$manifest_path" >/dev/null; then
    echo "Coverage proof artifact manifest is invalid" >&2
    return 1
  fi
  local proof_file
  while IFS= read -r -d '' proof_file; do
    if [ "$proof_file" = "$manifest_path" ]; then
      continue
    fi
    proof_files+=("$proof_file")
  done < <(find "$proof_dir" -mindepth 1 -maxdepth 1 -type f -print0)
  if [ "${#proof_files[@]}" -gt "$max_files" ]; then
    echo "Coverage proof artifact contains ${#proof_files[@]} files; maximum is $max_files." >&2
    return 1
  fi
  local total_bytes=0
  local proof_name proof_bytes
  for proof_file in "${proof_files[@]}"; do
    proof_name="$(basename "$proof_file")"
    if ! [[ "$proof_name" =~ ^[1-9][0-9]*-[1-9][0-9]*\.proof\.json$ ]]; then
      echo "Unexpected coverage proof filename: $proof_name" >&2
      return 1
    fi
    proof_bytes="$(wc -c < "$proof_file" | tr -d ' ')"
    if [ "$proof_bytes" -gt "$max_file_bytes" ]; then
      echo "Coverage proof artifact exceeds $max_file_bytes bytes: $proof_name" >&2
      return 1
    fi
    total_bytes=$((total_bytes + proof_bytes))
  done
  if [ "$(jq -r '.proofCount' "$manifest_path")" -ne "${#proof_files[@]}" ]; then
    echo "Coverage proof artifact manifest count does not match proof files" >&2
    return 1
  fi
  if [ "$total_bytes" -gt "$max_total_bytes" ]; then
    echo "Coverage proof artifacts exceed the $max_total_bytes-byte total limit." >&2
    return 1
  fi
}

write_coverage_proof_manifest() {
  local proof_dir="$1"
  local target_repo="$2"
  local selected_items_csv="${3:-}"
  mkdir -p "$proof_dir"
  local proof_count
  proof_count="$(find "$proof_dir" -mindepth 1 -maxdepth 1 -type f -name '*.proof.json' | wc -l | tr -d ' ')"
  jq -n \
    --arg target_repo "$target_repo" \
    --arg selected_items "$selected_items_csv" \
    --argjson proof_count "$proof_count" \
    '{
      schemaVersion: 1,
      targetRepo: $target_repo,
      selectedItems: ($selected_items | split(",") | map(select(length > 0) | tonumber)),
      proofCount: $proof_count
    }' > "$proof_dir/manifest.json"
}
progress_every=10

publish_changes_with_strategy() {
  local rebase_strategy="$1"
  local message="$2"
  shift 2
  # Reconciliation publishes four paths per changed record, so a flag per path
  # outgrows the kernel's single-argument limit and pnpm spawns with E2BIG.
  # The manifest keeps the command a fixed size no matter how many records move.
  local paths_file
  paths_file="$(mktemp)"
  printf '%s\n' "$@" >"$paths_file"
  local status=0
  pnpm run repair:publish-main -- \
    --message "$message" \
    --rebase-strategy "$rebase_strategy" \
    --paths-file "$paths_file" || status=$?
  rm -f "$paths_file"
  return "$status"
}

publish_changes() {
  local message="$1"
  shift
  local target_slug
  target_slug="$(printf '%s' "$TARGET_REPO" | tr '[:upper:]' '[:lower:]')"
  target_slug="${target_slug//\//-}"
  local record_paths=()
  local other_paths=()
  local path
  for path in "$@"; do
    if [ "$path" = "records" ]; then
      record_paths+=("records/${target_slug}")
    elif [[ "$path" = records/* ]]; then
      record_paths+=("$path")
    else
      other_paths+=("$path")
    fi
  done
  if [ "${#record_paths[@]}" -gt 0 ]; then
    publish_changes_with_strategy normal "$message" "${record_paths[@]}" || return 1
  fi
  if [ "${#other_paths[@]}" -gt 0 ]; then
    publish_changes_with_strategy theirs "$message" "${other_paths[@]}" || return 1
  fi
}

publish_status() {
  local message="$1"
  local target_slug
  local status_path
  target_slug="$(printf '%s' "$TARGET_REPO" | tr '[:upper:]' '[:lower:]')"
  target_slug="${target_slug//\//-}"
  status_path="results/sweep-status/${target_slug}.json"
  if ! publish_changes "$message" "$status_path"; then
    echo "Best-effort status update failed: $message"
    if git ls-files --error-unmatch -- "$status_path" >/dev/null 2>&1; then
      git restore -- "$status_path"
    fi
  fi
}

begin_canonical_record_mutation() {
  mkdir -p .artifacts
  CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR="$(mktemp -d .artifacts/canonical-record-baseline.XXXXXX)"
  export CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR
}

publish_reconciled_records() {
  local message="$1"
  local reconcile_json="$2"
  local target_slug
  target_slug="$(printf '%s' "$TARGET_REPO" | tr '[:upper:]' '[:lower:]')"
  target_slug="${target_slug//\//-}"
  local publish_paths=()
  local tuple_count=0
  local record_file
  local number

  if ! jq -e '
    .changedRecordFiles
    | type == "array"
      and all(.[]; type == "string" and test("^[a-z0-9][a-z0-9-]*-[0-9]+\\.md$|^[0-9]+\\.md$"))
  ' >/dev/null <<<"$reconcile_json"; then
    echo "Reconcile output has invalid changedRecordFiles" >&2
    return 1
  fi

  while IFS= read -r record_file; do
    [ -n "$record_file" ] || continue
    number="${record_file%.md}"
    number="${number##*-}"
    publish_paths+=(
      "records/${target_slug}/items/${record_file}"
      "records/${target_slug}/closed/${record_file}"
      "records/${target_slug}/plans/${record_file}"
      "records/${target_slug}/decision-packets/${number}.json"
    )
    tuple_count=$((tuple_count + 1))
    if [ "$tuple_count" -ge 50 ]; then
      CLAWSWEEPER_CANONICAL_PUBLICATION_KIND=reconcile \
        CLAWSWEEPER_RECONCILE_DEFERRED_PATH=.artifacts/apply-reconcile-deferred.jsonl \
        publish_changes_with_strategy normal "$message" "${publish_paths[@]}" || return 1
      publish_paths=()
      tuple_count=0
    fi
  done < <(jq -r '.changedRecordFiles[]' <<<"$reconcile_json")

  if [ "${#publish_paths[@]}" -eq 0 ] && [ "$tuple_count" -eq 0 ]; then
    if [ "$(jq '.changedRecordFiles | length' <<<"$reconcile_json")" -gt 0 ]; then
      return 0
    fi
    echo "Reconcile changed no durable record tuples."
    return 0
  fi
  # Reconciliation can move records in either direction. Preserve the newer
  # remote tuple when another publisher changes the same item, while applying
  # non-conflicting tuples independently.
  CLAWSWEEPER_CANONICAL_PUBLICATION_KIND=reconcile \
    CLAWSWEEPER_RECONCILE_DEFERRED_PATH=.artifacts/apply-reconcile-deferred.jsonl \
    publish_changes_with_strategy normal "$message" "${publish_paths[@]}" || return 1
}

persist_reconciliation() {
  local reconcile_json
  local canonical_baseline_dir
  mkdir -p .artifacts
  canonical_baseline_dir="$(mktemp -d .artifacts/apply-reconcile-baseline.XXXXXX)"
  if ! reconcile_json="$(pnpm run --silent reconcile -- "$@" --canonical-record-baseline-dir "$canonical_baseline_dir")"; then
    rm -rf -- "$canonical_baseline_dir"
    return 1
  fi
  echo "$reconcile_json"
  if ! CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR="$canonical_baseline_dir" \
    publish_reconciled_records "chore: persist sweep reconciliation" "$reconcile_json"; then
    rm -rf -- "$canonical_baseline_dir"
    return 1
  fi
  rm -rf -- "$canonical_baseline_dir"
  load_reconciliation_deferred_items
}

load_reconciliation_deferred_items() {
  deferred_item_numbers=""
  if [ -s .artifacts/apply-reconcile-deferred.jsonl ]; then
    deferred_item_numbers="$(jq -rs 'map(.itemNumber) | unique | join(",")' .artifacts/apply-reconcile-deferred.jsonl)"
    echo "Deferring canonical conflict items to re-review: $deferred_item_numbers"
  fi
  CLAWSWEEPER_RECONCILIATION_DEFERRED_ITEM_NUMBERS="$deferred_item_numbers"
  export CLAWSWEEPER_RECONCILIATION_DEFERRED_ITEM_NUMBERS
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
  local health_candidate_counts_json="${10:-}"
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
  if [ -n "$health_candidate_counts_json" ]; then
    health_args+=(--candidate-counts-json "$health_candidate_counts_json")
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
    max_runtime_arg=(--max-runtime-ms 1200000)
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
    echo "Apply checkpoint reached its runtime budget before cursor progress; cursor is unchanged and scheduled apply will retry without queueing an immediate continuation."
    return 0
  fi
  echo "Apply checkpoint reached its runtime budget; cursor is persisted and a fresh-token continuation will resume the lane."
  continue_apply=true
  return 0
}

apply_checkpoint_runtime_reached() {
  local report_path="$1"
  local processed="$2"
  local remaining="$3"
  if ! automatic_apply_runtime_reached "$report_path"; then
    return 1
  fi
  if [ "${auto_selected_apply_batch:-false}" = "true" ] && [ -n "${apply_ready_count:-}" ]; then
    remaining="$apply_ready_count"
  fi
  report_apply_token_budget_stop "$report_path" "$processed" "$remaining"
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

select_apply_candidate_inventory() {
  local update_item_numbers="${1:-true}"
  local candidate_inventory_env=".artifacts/apply-candidate-inventory.env"
  pnpm run --silent workflow -- proposed-item-inventory \
    --target-repo "$TARGET_REPO" \
    --apply-kind "$apply_kind" \
    --apply-close-reasons "$apply_close_reasons" \
    --stale-min-age-days "$stale_min_age_days" \
    --min-age-days "$min_age_days" \
    --min-age-minutes "$min_age_minutes" \
    --batch-size "$close_processed_limit" \
    --close-limit "$((limit < checkpoint_size ? limit : checkpoint_size))" \
    --coverage-proof-limit "$coverage_proof_limit" \
    --cursor-path "$apply_cursor_path" > "$candidate_inventory_env"
  cat "$candidate_inventory_env"
  if [ "$update_item_numbers" = "true" ]; then
    item_numbers="$(awk -F= '$1 == "item_numbers" { print $2 }' "$candidate_inventory_env")"
  fi
  apply_ready_count="$(awk -F= '$1 == "apply_ready_count" { print $2 }' "$candidate_inventory_env")"
  candidate_counts_json="$(awk -F= '$1 == "candidate_counts_json" { sub(/^[^=]*=/, ""); print }' "$candidate_inventory_env")"
}

publish_automatic_apply_idle() {
  echo "No unchanged high-confidence close proposals are awaiting apply. Scheduled apply wakes every 15 minutes and exits without scanning unrelated keep-open records when there is no close work."
  printf '[]\n' > .artifacts/apply-reports/apply-report-idle.json
  write_apply_health ".artifacts/apply-reports/apply-report-idle.json" ".artifacts/apply-health-idle.json" "close" "$close_processed_limit" "$apply_cursor_path" "true" "$apply_ready_count" "15" "0" "$candidate_counts_json"
  pnpm run status -- \
    --target-repo "$TARGET_REPO" \
    --state "Apply idle" \
    --detail "No unchanged high-confidence close proposals are awaiting apply.$candidate_quality_detail Scheduled apply wakes every 15 minutes and exits without scanning unrelated keep-open records when there is no close work." \
    --run-url "https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
    --apply-health-file ".artifacts/apply-health-idle.json"
  publish_status "chore: update idle sweep apply status"
  {
    echo "APPLY_CLOSED_TOTAL=0"
    echo "APPLY_LIMIT=1"
    echo "APPLY_MIN_AGE_DAYS=$min_age_days"
    echo "APPLY_MIN_AGE_MINUTES=$min_age_minutes"
    echo "APPLY_KIND=$apply_kind"
    echo "APPLY_CLOSE_REASONS=$apply_close_reasons"
    echo "APPLY_STALE_MIN_AGE_DAYS=$stale_min_age_days"
    echo "APPLY_CLOSE_DELAY_MS=$close_delay_ms"
    echo "APPLY_PROGRESS_EVERY=$progress_every"
    echo "APPLY_CHECKPOINT_SIZE=$checkpoint_size"
    echo "APPLY_ITEM_NUMBERS="
    echo "APPLY_SYNC_COMMENTS_ONLY=false"
    echo "APPLY_COMMENT_SYNC_MIN_AGE_DAYS=$comment_sync_min_age_days"
    echo "APPLY_NOOP=true"
  } >> "$GITHUB_ENV"
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
