#!/usr/bin/env bash
# Materialize an exact-review target checkout from a reusable blobless bare cache.
#
# Usage: review-target-checkout.sh <repository-url> <cache-dir> <checkout-dir> <branch>
#
# The cache holds the branch's full commit/tree history, its tags, and every blob
# of the branch tip. A restored cache fetches only the delta, then the checkout is
# cloned locally (hardlinked objects) and configured like a direct
# `git clone --filter=blob:none --single-branch` of the branch. Any cache problem
# falls back to rebuilding the cache or to a clean clone. The script appends
# `cache_ready=true` to GITHUB_OUTPUT only when the checkout came from a cache
# that holds every tip blob and is therefore worth saving.
set -euo pipefail

url="${1:?repository URL is required}"
cache_dir="${2:?cache directory is required}"
checkout_dir="${3:?checkout directory is required}"
branch="${4:?target branch is required}"

if ! [[ "$branch" =~ ^[A-Za-z0-9_./-]+$ ]] || [[ "$branch" == -* || "$branch" == *..* ]]; then
  echo "Unsafe target branch: $branch" >&2
  exit 1
fi

# Automatic gc would repack the whole cache inside a review job.
cache_git() {
  git -C "$cache_dir" -c core.hooksPath=/dev/null -c gc.auto=0 -c maintenance.auto=false "$@"
}

record_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_OUTPUT"
  fi
}

# Restored caches carry only objects and refs forward; hooks and local config are
# rebuilt so every run fetches with the same settings.
reset_cache_config() {
  rm -rf "$cache_dir/hooks"
  printf '[core]\n\trepositoryformatversion = 1\n\tbare = true\n' > "$cache_dir/config" || return 1
  cache_git config remote.origin.url "$url" &&
    cache_git config remote.origin.promisor true &&
    cache_git config remote.origin.partialclonefilter blob:none
}

build_cache() {
  rm -rf "$cache_dir"
  git -c gc.auto=0 clone --bare --filter=blob:none --single-branch --branch "$branch" "$url" "$cache_dir" &&
    reset_cache_config
}

refresh_cache() {
  local previous_head
  previous_head="$(cache_git rev-parse "refs/heads/$branch")" || return 1
  # Auto-follow only fills absent tags. Drop cached names so moved/deleted tags
  # are refreshed too, without --tags fetching unrelated branch histories.
  cache_git for-each-ref --format='delete %(refname)' refs/tags/ |
    cache_git update-ref --no-deref --stdin || return 1
  cache_git fetch --quiet --filter=blob:none origin "+refs/heads/$branch:refs/heads/$branch" &&
    # After a rewind, old cached objects can make auto-follow include tags no
    # longer on this branch. A cold rebuild restores single-branch tag scope.
    cache_git merge-base --is-ancestor "$previous_head" "refs/heads/$branch"
}

missing_tip_blobs() {
  cache_git rev-list --objects --missing=print "refs/heads/$branch^{tree}" |
    sed -n 's/^?\([0-9a-f]*\).*/\1/p'
}

# Fetch only the tip blobs the cache lacks, so the checkout below is fully local.
fill_tip_blobs() {
  local missing
  missing="$(missing_tip_blobs)" || return 1
  [ -n "$missing" ] || return 0
  missing_blob_count="$(printf '%s\n' "$missing" | wc -l | tr -d ' ')"
  printf '%s\n' "$missing" |
    cache_git -c fetch.negotiationAlgorithm=noop fetch --quiet --no-tags --no-write-fetch-head \
      --recurse-submodules=no --filter=blob:none --stdin origin || return 1
  missing="$(missing_tip_blobs)" || return 1
  [ -z "$missing" ]
}

materialize_checkout() {
  rm -rf "$checkout_dir"
  git -c gc.auto=0 clone --quiet --no-checkout --single-branch --branch "$branch" -- "$cache_dir" "$checkout_dir" &&
    git -C "$checkout_dir" config core.repositoryformatversion 1 &&
    git -C "$checkout_dir" config remote.origin.url "$url" &&
    git -C "$checkout_dir" config remote.origin.promisor true &&
    git -C "$checkout_dir" config remote.origin.partialclonefilter blob:none &&
    git -C "$checkout_dir" checkout --quiet --force "$branch" &&
    [ "$(git -C "$checkout_dir" rev-parse HEAD)" = "$(cache_git rev-parse "refs/heads/$branch")" ] &&
    [ "$(git -C "$checkout_dir" rev-parse --abbrev-ref HEAD)" = "$branch" ]
}

started=$SECONDS
mode=warm
if [ -f "$cache_dir/HEAD" ] && [ -d "$cache_dir/objects" ] && reset_cache_config &&
  [ "$(cache_git rev-parse --is-bare-repository 2>/dev/null || true)" = "true" ]; then
  if ! refresh_cache; then
    echo "::warning::Cached target repository cannot be refreshed incrementally; rebuilding cache."
    mode=rebuilt
    build_cache
  fi
else
  mode=cold
  build_cache
fi

cache_ready=true
missing_blob_count=0
if ! fill_tip_blobs; then
  echo "::warning::Cached target repository is missing branch-tip blobs; the checkout will fetch them."
  cache_ready=false
fi
if ! materialize_checkout; then
  echo "::warning::Cached target checkout failed; retrying without cache reference."
  rm -rf "$checkout_dir" "$cache_dir"
  cache_ready=false
  mode=fallback
  git clone --filter=blob:none --branch "$branch" --single-branch "$url" "$checkout_dir"
fi

record_output "cache_ready=$cache_ready"
echo "Target checkout mode=$mode missing_tip_blobs=$missing_blob_count cache_ready=$cache_ready elapsed_s=$((SECONDS - started))"
git -C "$checkout_dir" rev-parse --short HEAD
