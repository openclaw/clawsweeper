#!/usr/bin/env bash
set -euo pipefail

# Only this official platform archive has been pinned and verified.
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "Trusted review scanner bootstrap supports Linux amd64 only." >&2
  exit 1
fi

review_tools_root="$(mktemp -d "${RUNNER_TEMP:?}/clawsweeper-review-tools.XXXXXX")"
case "$review_tools_root/" in
  "${GITHUB_WORKSPACE:?}/"*) echo "Review tools must be outside the checkout." >&2; exit 1 ;;
esac
chmod 700 "$review_tools_root"
mkdir -m 700 "$review_tools_root/bin" "$review_tools_root/smoke"
review_tools_ready=0
cleanup() {
  rm -rf "$review_tools_root/smoke" "$review_tools_root/archive.tar.gz" "$review_tools_root/stdout" "$review_tools_root/stderr"
  if [[ "$review_tools_ready" != 1 ]]; then rm -rf "$review_tools_root"; fi
}
trap cleanup EXIT

archive_transport="${CLAWSWEEPER_REVIEW_ARCHIVE_PATH:-}"
archive_sha256="5ae9b313342d1bfa96404064c0f59e77a2cbd1824d797ca7b11e6655aa8fd9d1"
verify_archive() {
  printf '%s  %s\n' "$archive_sha256" "$review_tools_root/archive.tar.gz" | sha256sum --check "$@" -
}
if [[ -n "$archive_transport" ]]; then
  node "${WORKFLOW_ACTION_PATH:?}/archive-cache.mjs" --validate "$archive_transport"
  if [[ -f "$archive_transport" ]]; then
    cp "$archive_transport" "$review_tools_root/archive.tar.gz"
    if ! verify_archive --status; then rm "$review_tools_root/archive.tar.gz"; fi
  fi
fi
if [[ ! -f "$review_tools_root/archive.tar.gz" ]]; then
  curl --fail --show-error --silent --location \
    --connect-timeout 15 --max-time 60 --retry 2 --retry-all-errors --retry-delay 2 --retry-max-time 120 \
    "https://github.com/trufflesecurity/trufflehog/releases/download/v3.99.4/trufflehog_3.99.4_linux_amd64.tar.gz" \
    --output "$review_tools_root/archive.tar.gz"
  verify_archive
fi
tar -xzf "$review_tools_root/archive.tar.gz" -C "$review_tools_root/bin" trufflehog
chmod 700 "$review_tools_root/bin/trufflehog"
export PATH="$review_tools_root/bin:$PATH"
version="$(env -i HOME="$review_tools_root" "$review_tools_root/bin/trufflehog" --version 2>&1)"
[[ "$version" == "trufflehog 3.99.4" ]]
printf 'A harmless review scanner installation check.\n' > "$review_tools_root/smoke/clean.txt"
chmod 600 "$review_tools_root/smoke/clean.txt"
if ! env -i HOME="$review_tools_root" TMPDIR="$review_tools_root" \
  "$review_tools_root/bin/trufflehog" filesystem "$review_tools_root/smoke" \
  --results=verified,unknown --fail --fail-on-scan-errors --no-update --json --no-color \
  > "$review_tools_root/stdout" 2> "$review_tools_root/stderr"; then
  echo "Trusted review scanner smoke failed; diagnostics withheld." >&2
  exit 1
fi
if [[ -s "$review_tools_root/stdout" ]]; then
  echo "Trusted review scanner smoke emitted unexpected output; diagnostics withheld." >&2
  exit 1
fi
if [[ -n "$archive_transport" ]]; then
  node "${WORKFLOW_ACTION_PATH:?}/archive-cache.mjs" --validate "$archive_transport"
  cp "$review_tools_root/archive.tar.gz" "$archive_transport"
  chmod 600 "$archive_transport"
fi
echo "$review_tools_root/bin" >> "$GITHUB_PATH"
review_tools_ready=1
echo "Trusted TruffleHog 3.99.4 scanner installed and benign scan passed."
