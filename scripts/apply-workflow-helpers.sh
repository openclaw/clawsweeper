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

normalize_comment_sync_mode() {
  if [ "${sync_open_pr_batch:-false}" != "true" ]; then
    return 0
  fi
  sync_comments_only=true
  if [ "${scheduled_comment_sync:-false}" = "true" ]; then
    apply_kind="pull_request"
    comment_sync_min_age_days=0
  fi
}

prepare_comment_sync_batch() {
  comment_sync_pending_items=""
  comment_sync_cursor_advance_count=0
  comment_sync_initial_cursor=0
  comment_sync_cycle_start=0
  comment_sync_cycle_wrapped=false
  if [ "${sync_comments_only:-false}" != "true" ]; then
    return 0
  fi
  if [ -z "${item_numbers:-}" ] &&
    [ "${scheduled_comment_sync:-false}" != "true" ] &&
    { [ "${apply_kind:-all}" != "pull_request" ] ||
      [ "${comment_sync_min_age_days:-0}" != "0" ]; }; then
    cursor_path="results/comment-sync-cursors/${target_slug}-${apply_kind:-all}-age${comment_sync_min_age_days:-0}.json"
  fi
  if [ -f "${cursor_path:-}" ]; then
    comment_sync_initial_cursor="$(jq -er '
      if (.next_after_number | type) == "number" and .next_after_number >= 0 and
         (.next_after_number | floor) == .next_after_number
      then .next_after_number
      else error("comment sync cursor is invalid")
      end
    ' "$cursor_path")"
    comment_sync_cycle_start="$(jq -er --argjson cursor "$comment_sync_initial_cursor" '
      .cycle_start_after_number // $cursor
      | if type == "number" and . >= 0 and floor == . then .
        else error("comment sync cycle start is invalid") end
    ' "$cursor_path")"
    comment_sync_cycle_wrapped="$(jq -r '
      .cycle_wrapped // false
      | if type == "boolean" then . else error("comment sync cycle state is invalid") end
    ' "$cursor_path")"
  fi
  if [ "$sync_batch_size" -le 0 ]; then
    sync_batch_size="$comment_sync_processed_limit"
  fi
  if [ "$sync_batch_size" -gt "$comment_sync_processed_limit" ]; then
    echo "Capping comment sync batch at $comment_sync_processed_limit items."
    sync_batch_size="$comment_sync_processed_limit"
  fi
  if [ -z "${item_numbers:-}" ] && [ "${sync_open_pr_batch:-false}" != "true" ]; then
    mkdir -p .artifacts
    local batch_env
    batch_env="$(mktemp .artifacts/comment-sync-all.XXXXXX)"
    cursor_path="${cursor_path:-results/comment-sync-cursors/${target_slug}.json}"
    pnpm run --silent workflow -- comment-sync-batch \
      --target-repo "$TARGET_REPO" \
      --apply-kind "$apply_kind" \
      --batch-size "$comment_sync_processed_limit" \
      --cursor-path "$cursor_path" > "$batch_env"
    item_numbers="$(awk -F= '$1 == "item_numbers" { print $2 }' "$batch_env")"
    next_cursor="$(awk -F= '$1 == "next_cursor" { print $2 }' "$batch_env")"
    sync_open_pr_batch=true
    sync_batch_size="$comment_sync_processed_limit"
  fi
  if [ -n "${item_numbers:-}" ]; then
    local requested_item_numbers="$item_numbers"
    item_numbers="$(jq -nr --arg selected "$item_numbers" '
      reduce (
        $selected | split(",")[] | gsub("^\\s+|\\s+$"; "")
        | select(length > 0) | tonumber?
        | select(. > 0 and . == floor)
      ) as $item ([]; if index($item) == null then . + [$item] else . end)
      | sort | map(tostring) | join(",")
    ')"
    if [ -z "$item_numbers" ]; then
      echo "Comment sync request contains no valid positive item numbers: $requested_item_numbers" >&2
      return 1
    fi
    local requested_items
    IFS=, read -r -a requested_items <<<"$item_numbers"
    if [ "${#requested_items[@]}" -gt "$comment_sync_processed_limit" ]; then
      comment_sync_pending_items="$(IFS=,; printf '%s' "${requested_items[*]:comment_sync_processed_limit}")"
      item_numbers="$(IFS=,; printf '%s' "${requested_items[*]:0:comment_sync_processed_limit}")"
      echo "Splitting comment sync into $comment_sync_processed_limit-item checkpoints."
    fi
  fi
}

complete_comment_sync_batch() {
  local report_path="$1"
  local trace_path="$2"
  local completed_csv
  if ! completed_csv="$(jq -er --arg selected "${item_numbers:-}" '
    .examined_item_numbers as $examined
    | ($selected | if . == "" then [] else split(",") | map(tonumber) end) as $selected
    | if .schema_version == 1 and
        ($examined | type) == "array" and
        (($selected | length) == 0 or
          (all($examined[]; . as $number | $selected | index($number) != null) and
            ($examined | unique | length) == ($examined | length)))
      then $examined | join(",")
      else error("comment sync trace contains invalid or unselected items")
      end
  ' "$trace_path")"; then
    echo "::warning::Comment sync trace could not be trusted; preserving the canonical checkpoint without cursor advancement."
    completed_csv=""
  fi
  local selected_items=()
  if [ -n "${item_numbers:-}" ]; then
    IFS=, read -r -a selected_items <<<"$item_numbers"
  fi
  local completed_count=0
  local cursor_count=0
  local safe_cursor=""
  local blocked_prefix=false
  local unfinished_items=()
  local selected_item
  for selected_item in "${selected_items[@]}"; do
    case ",$completed_csv," in
      *",$selected_item,"*)
        completed_count=$((completed_count + 1))
        if [ "$blocked_prefix" != "true" ]; then
          safe_cursor="$selected_item"
          cursor_count=$((cursor_count + 1))
        fi
        ;;
      *)
        blocked_prefix=true
        unfinished_items+=("$selected_item")
        ;;
    esac
  done
  if [ "${#selected_items[@]}" -eq 0 ] && [ -n "$completed_csv" ]; then
    completed_count="$(awk -F, '{ print NF }' <<<"$completed_csv")"
  fi
  comment_sync_cursor_advance_count="$cursor_count"

  if [ "$sync_open_pr_batch" = "true" ]; then
    if [ "$cursor_count" -eq 0 ]; then
      echo "Comment sync made no cursor progress; the next scheduled batch retries it."
      next_cursor=""
      return 0
    fi
    next_cursor="$safe_cursor"
    pnpm run workflow -- write-comment-sync-cursor \
      --cursor-path "$cursor_path" \
      --next-cursor "$next_cursor" \
      --target-repo "$TARGET_REPO"
    if [ "$TARGET_REPO" != "openclaw/openclaw" ] ||
      [ "${apply_kind:-pull_request}" != "pull_request" ] ||
      [ "${comment_sync_min_age_days:-0}" != "0" ]; then
      local initial_cursor="${comment_sync_initial_cursor:-0}"
      local cycle_start="${comment_sync_cycle_start:-0}"
      local cycle_wrapped="${comment_sync_cycle_wrapped:-false}"
      if [ "${#selected_items[@]}" -gt 0 ] &&
        [ "${selected_items[0]}" -le "$initial_cursor" ] &&
        [ "$initial_cursor" -gt 0 ]; then
        cycle_wrapped=true
      fi
      local lookahead_env
      lookahead_env="$(mktemp .artifacts/comment-sync-lookahead.XXXXXX)"
      pnpm run --silent workflow -- comment-sync-batch \
        --target-repo "$TARGET_REPO" \
        --apply-kind "$apply_kind" \
        --batch-size "$sync_batch_size" \
        --cursor-path "$cursor_path" > "$lookahead_env"
      local lookahead_wrapped
      lookahead_wrapped="$(awk -F= '$1 == "wrapped" { print $2 }' "$lookahead_env")"
      local lookahead_count
      lookahead_count="$(awk -F= '$1 == "count" { print $2 }' "$lookahead_env")"
      if [ "$lookahead_wrapped" = "true" ]; then
        if [ "$cycle_start" -gt 0 ] && [ "$cycle_wrapped" != "true" ]; then
          cycle_wrapped=true
        else
          lookahead_count=0
        fi
      fi
      if [ "$cycle_wrapped" = "true" ] &&
        [ "${#selected_items[@]}" -gt 0 ] &&
        [ "${selected_items[0]}" -le "$cycle_start" ] &&
        [ "$safe_cursor" -ge "$cycle_start" ]; then
        lookahead_count=0
      fi
      if [ "$lookahead_count" -gt 0 ]; then
        local cycle_cursor_path
        cycle_cursor_path="$(mktemp "${cursor_path}.cycle.XXXXXX")"
        jq --argjson start "$cycle_start" \
          --argjson wrapped "$cycle_wrapped" \
          '. + {cycle_start_after_number: $start, cycle_wrapped: $wrapped}' \
          "$cursor_path" > "$cycle_cursor_path"
        mv "$cycle_cursor_path" "$cursor_path"
        item_numbers="__cursor__"
        continue_apply=true
        echo "Queued the next bounded comment-sync window outside scheduled maintenance coverage."
        return 0
      fi
    fi
    echo "Comment synchronization yielded its bounded cursor window to scheduled maintenance."
    return 0
  fi

  if [ "${#unfinished_items[@]}" -gt 0 ]; then
    local unfinished
    unfinished="$(IFS=,; printf '%s' "${unfinished_items[*]}")"
    comment_sync_pending_items="${unfinished}${comment_sync_pending_items:+,$comment_sync_pending_items}"
  fi
  if [ -n "$comment_sync_pending_items" ] && [ "$completed_count" -gt 0 ]; then
    item_numbers="$comment_sync_pending_items"
    continue_apply=true
    echo "Queued the unfinished durable comment-sync checkpoint for continuation."
  elif [ -n "$comment_sync_pending_items" ]; then
    echo "Comment sync made no progress; stopping instead of occupying the apply lane with an endless retry."
  elif jq -e 'any(.[]; .action == "skipped_runtime_budget")' "$report_path" >/dev/null; then
    echo "Comment sync reached its runtime budget after its selected records completed."
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
  local publish_args=(--message "$message" --rebase-strategy "$rebase_strategy")
  local path
  for path in "$@"; do
    publish_args+=(--path "$path")
  done
  pnpm run repair:publish-main -- "${publish_args[@]}"
}

publish_changes() {
  local message="$1"
  shift
  local target_slug
  target_slug="$(printf '%s' "$TARGET_REPO" | tr '[:upper:]' '[:lower:]')"
  target_slug="${target_slug//\//-}"
  local record_paths=()
  local other_paths=()
  local publishes_comment_sync_cursor=false
  local path
  for path in "$@"; do
    if [ "$path" = "records" ]; then
      record_paths+=("records/${target_slug}")
    elif [[ "$path" = records/* ]]; then
      record_paths+=("$path")
    else
      other_paths+=("$path")
      if [ "$path" = "results/comment-sync-cursors" ] ||
        [[ "$path" = results/comment-sync-cursors/* ]]; then
        publishes_comment_sync_cursor=true
      fi
    fi
  done
  if [ "${#record_paths[@]}" -gt 0 ]; then
    publish_changes_with_strategy normal "$message" "${record_paths[@]}" || return 1
  fi
  if [ "${#other_paths[@]}" -gt 0 ]; then
    if ! publish_changes_with_strategy theirs "$message" "${other_paths[@]}"; then
      echo "::warning title=Operational state publish failed::Canonical work remains valid; continuing after best-effort Git bookkeeping failed: $message" >&2
      if [ "$publishes_comment_sync_cursor" = "true" ] &&
        [ "${sync_open_pr_batch:-false}" = "true" ] &&
        [ "${continue_apply:-false}" = "true" ]; then
        continue_apply=false
        echo "Stopping comment-sync continuation because its cursor was not published."
      fi
    fi
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

write_comment_sync_health() {
  write_apply_health "$1" "$2" "comment_sync" \
    "$comment_sync_health_processed_limit" \
    "$comment_sync_health_cursor_path" \
    "$comment_sync_health_cursor_required" "" "" \
    "$comment_sync_cursor_advance_count"
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
