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

curl --fail --show-error --silent --location \
  "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.1/trufflehog_3.97.1_linux_amd64.tar.gz" \
  --output "$review_tools_root/archive.tar.gz"
printf '%s  %s\n' \
  "f863ea3a8d786f7d097870496c977944cce7372a2fe1e56707d965016e543ece" \
  "$review_tools_root/archive.tar.gz" | sha256sum --check -
tar -xzf "$review_tools_root/archive.tar.gz" -C "$review_tools_root/bin" trufflehog
chmod 700 "$review_tools_root/bin/trufflehog"
export PATH="$review_tools_root/bin:$PATH"
version="$(env -i HOME="$review_tools_root" "$review_tools_root/bin/trufflehog" --version 2>&1)"
[[ "$version" == "trufflehog 3.97.1" ]]
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
echo "$review_tools_root/bin" >> "$GITHUB_PATH"
review_tools_ready=1
echo "Trusted TruffleHog 3.97.1 scanner installed and benign scan passed."
