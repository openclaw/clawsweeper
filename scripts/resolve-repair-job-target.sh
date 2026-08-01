#!/usr/bin/env bash
set -euo pipefail

job_path="${JOB_PATH:?JOB_PATH is required}"
output_path="${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

if ! [[ "$job_path" =~ ^jobs/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.+-]+)+\.md$ ]] ||
  [[ "$job_path" == */../* || "$job_path" == */./* ]]; then
  echo "Invalid job path: $job_path" >&2
  exit 1
fi

owner="${job_path#jobs/}"
owner="${owner%%/*}"
if ! [[ "$owner" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "Invalid target owner: $owner" >&2
  exit 1
fi

job_file="${job_path##*/}"
owner_slug="$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')"
job_kind=""
case "$job_file" in
  "issue-${owner_slug}-"*.md) job_kind="issue" ;;
  "automerge-${owner_slug}-"*.md) job_kind="automerge" ;;
  "self-heal-${owner_slug}-"*.md) job_kind="self-heal" ;;
  issue-* | automerge-* | self-heal-*)
    echo "Invalid scoped repair target: $job_file" >&2
    exit 1
    ;;
esac

{
  echo "target_owner=$owner"
  if [[ -n "$job_kind" ]]; then
    scoped_target="${job_file#${job_kind}-${owner_slug}-}"
    scoped_target="${scoped_target%.md}"
    item_number="${scoped_target##*-}"
    repository="${scoped_target%-${item_number}}"
    if ! [[ "$item_number" =~ ^[1-9][0-9]*$ ]] ||
      [[ ${#item_number} -gt 16 ||
      ( ${#item_number} -eq 16 && "$item_number" > "9007199254740991" ) ]] ||
      ! [[ "$repository" =~ ^[A-Za-z0-9_.-]+$ ]]; then
      echo "Invalid $job_kind repair target: $job_file" >&2
      exit 1
    fi
    echo "target_slug=${owner_slug}-${repository}"
    echo "records_item_number=$item_number"
  fi
} >> "$output_path"
