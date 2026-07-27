#!/usr/bin/env bash
set -euo pipefail

workflow="${1:?workflow file is required}"
expected_title="${2:?expected run title is required}"
current_run_id="${3:?current run id is required}"
required_job_name="${4:?required worker job name is required}"

runs_json="$(gh api --method GET \
  "repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}/actions/workflows/${workflow}/runs?per_page=100")"

active_owner_id="$(
  jq -r --arg title "$expected_title" --arg current "$current_run_id" '
    first(
      .workflow_runs[]
      | select(.display_title == $title and .id < ($current | tonumber))
      | select(.status == "queued" or .status == "in_progress" or .status == "waiting" or .status == "pending" or .status == "requested")
      | .id
    ) // empty
  ' <<<"$runs_json"
)"
if [ -n "$active_owner_id" ]; then
  printf 'owner\n'
  exit 0
fi

# Mirror the TypeScript dispatch observer (dispatchClaimDecision): a prior run
# owns the receipt when its required worker job succeeded, even if a later job
# in the same run failed and the aggregate run conclusion is not "success".
# Selecting only conclusion=success runs here would let a duplicate planning
# pass slip through behind a mixed-outcome owner.
completed_run_ids="$(
  jq -r --arg title "$expected_title" --arg current "$current_run_id" '
    .workflow_runs[]
    | select(.display_title == $title and .id < ($current | tonumber) and .status == "completed")
    | .id
  ' <<<"$runs_json"
)"
while IFS= read -r run_id; do
  if [ -z "$run_id" ]; then
    continue
  fi
  jobs_json="$(gh api --method GET \
    "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?per_page=100")"
  if jq -e --arg required "$required_job_name" \
    'any(.jobs[]; .name == $required and .conclusion == "success")' \
    <<<"$jobs_json" >/dev/null; then
    printf 'owner\n'
    exit 0
  fi
done <<<"$completed_run_ids"

printf 'none\n'
