#!/usr/bin/env bash
set -euo pipefail

target_repo="${1:-}"
target_dir_input="${2:-}"
review_artifact_dir_input="${3:-}"
cache_dir_input="${4:-}"
source_url="${5:-https://github.com/openai/codex.git}"
pin_dir_input="${6:-$target_dir_input}"
setup_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"

target_repo="$(printf '%s' "$target_repo" | tr '[:upper:]' '[:lower:]')"
if [[ "$target_repo" != "openclaw/openclaw" ]]; then
  echo "Codex source checkout is not required for $target_repo."
  exit 0
fi

workspace_root="$(cd "${GITHUB_WORKSPACE:?}" && pwd -P)"
target_root="$(cd "$target_dir_input" && pwd -P)"
if [[ "$(dirname "$target_root")" != "$workspace_root" ]]; then
  echo "OpenClaw target checkout must be a direct child of GITHUB_WORKSPACE." >&2
  exit 1
fi

resolve_from_workspace() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const tail = [];
    let current = path.resolve(process.argv[1], process.argv[2]);
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) process.exit(1);
      tail.unshift(path.basename(current));
      current = parent;
    }
    process.stdout.write(path.resolve(fs.realpathSync(current), ...tail));
  ' "$workspace_root" "$1"
}

review_artifact_root="$(resolve_from_workspace "$review_artifact_dir_input")"
cache_dir="$(resolve_from_workspace "$cache_dir_input")"
for candidate in "$review_artifact_root" "$cache_dir"; do
  case "$candidate/" in
    "$workspace_root/"*) ;;
    *)
      echo "Codex source setup paths must stay inside GITHUB_WORKSPACE." >&2
      exit 1
      ;;
  esac
done

pin_root="$(cd "$pin_dir_input" && pwd -P)"
review_tree_root="$review_artifact_root/review-trees"
if [[ "$pin_root" != "$target_root" ]] &&
  { [[ "$(dirname "$pin_root")" != "$review_tree_root" ]] ||
    [[ "$(basename "$pin_root")" == *[!0-9]* ]]; }; then
  echo "Codex version pin must come from the target checkout or one of its PR review trees." >&2
  exit 1
fi

package_json_input="$pin_root/extensions/codex/package.json"
if [[ ! -f "$package_json_input" || -L "$package_json_input" ]]; then
  echo "OpenClaw Codex version pin must be a regular file." >&2
  exit 1
fi
package_json="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$package_json_input")"
case "$package_json/" in
  "$pin_root/"*) ;;
  *)
    echo "OpenClaw Codex version pin must stay inside its review checkout." >&2
    exit 1
    ;;
esac
version="$(node - "$package_json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const version = manifest.dependencies?.["@openai/codex"];
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("OpenClaw must pin @openai/codex to one exact version.");
  process.exit(1);
}
process.stdout.write(version);
NODE
)"
tag="rust-v$version"
source_dir="$workspace_root/codex"

refresh_cache() {
  if [[ -e "$cache_dir" ]]; then
    rm -rf -- "$cache_dir"
  fi
  git init --bare --quiet "$cache_dir"
  git -C "$cache_dir" remote add origin "$source_url"
}

fetch_tag() {
  git -C "$cache_dir" fetch --force --depth=1 origin \
    "refs/tags/$tag:refs/tags/$tag"
}

clear_partial_clone_config() {
  for key in extensions.partialclone remote.origin.promisor remote.origin.partialclonefilter; do
    git -C "$cache_dir" config --unset-all "$key" 2>/dev/null || true
  done
}

cache_tag_head() {
  git -C "$cache_dir" rev-parse --verify "refs/tags/$tag^{commit}" 2>/dev/null
}

cache_has_complete_tag() {
  local head
  head="$(cache_tag_head)" || return 1
  git -C "$cache_dir" fsck --connectivity-only --no-dangling "$head" >/dev/null 2>&1
}

cache_ready=false
if [[ -d "$cache_dir" ]] &&
  [[ "$(git -C "$cache_dir" rev-parse --is-bare-repository 2>/dev/null || true)" == "true" ]] &&
  [[ "$(git -C "$cache_dir" config --get-all remote.origin.url 2>/dev/null || true)" == "$source_url" ]]; then
  clear_partial_clone_config
  if cache_has_complete_tag; then
    cache_ready=true
  elif cache_tag_head >/dev/null; then
    echo "Cached Codex source is incomplete; rebuilding cache." >&2
    refresh_cache
  fi
else
  refresh_cache
fi
if [[ "$cache_ready" != "true" ]]; then
  if ! fetch_tag; then
    echo "Cached Codex source fetch failed." >&2
    exit 1
  fi
  clear_partial_clone_config
  if ! cache_has_complete_tag; then
    echo "Cached Codex source is incomplete after fetch." >&2
    exit 1
  fi
fi
expected_head="$(cache_tag_head)"

source_ready=false
if [[ -d "$source_dir" && ! -L "$source_dir" ]] &&
  [[ "$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)" == "$expected_head" ]] &&
  [[ -z "$(git -C "$source_dir" status --porcelain=v1 --untracked-files=all 2>/dev/null || true)" ]]; then
  source_ready=true
fi
if [[ "$source_ready" != "true" ]]; then
  if [[ -e "$source_dir" || -L "$source_dir" ]]; then
    rm -rf -- "$source_dir"
  fi
  git clone --single-branch --branch "$tag" --no-local "$cache_dir" "$source_dir"
fi
actual_head="$(git -C "$source_dir" rev-parse HEAD)"
if [[ "$actual_head" != "$expected_head" ]]; then
  echo "Codex source checkout does not match $tag." >&2
  exit 1
fi
if [[ -n "$(git -C "$source_dir" status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "Codex source checkout is not clean." >&2
  exit 1
fi

review_sibling="$review_tree_root/codex"
mkdir -p "$review_tree_root"
if [[ -L "$review_sibling" ]]; then
  rm -- "$review_sibling"
elif [[ -e "$review_sibling" ]]; then
  echo "PR review-tree Codex sibling already exists and is not a symbolic link." >&2
  exit 1
fi
ln -s "$source_dir" "$review_sibling"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT=$setup_script"
    echo "CLAWSWEEPER_OPENCLAW_CODEX_TARGET_DIR=$target_root"
    echo "CLAWSWEEPER_OPENCLAW_CODEX_ARTIFACT_DIR=$review_artifact_root"
    echo "CLAWSWEEPER_OPENCLAW_CODEX_CACHE_DIR=$cache_dir"
    echo "CLAWSWEEPER_OPENCLAW_CODEX_SOURCE_URL=$source_url"
  } >> "$GITHUB_ENV"
fi

echo "Prepared Codex $version source for OpenClaw review at $source_dir."
