#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${GITHUB_EGRESS_PROOF_OUTPUT:-.artifacts/github-egress-telemetry-proof}"
scratch="$(mktemp -d /tmp/clawsweeper-github-egress-proof.XXXXXX)"
tls_dir="$scratch/tls"
mkdir -p "$output_dir" "$tls_dir"

cleanup() {
  rm -rf -- "$scratch"
}
trap cleanup EXIT

if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p "$scratch/bin"
  corepack enable --install-directory "$scratch/bin"
  export PATH="$scratch/bin:$PATH"
fi

pnpm install --frozen-lockfile >"$output_dir/dependencies-install.log" 2>&1
pnpm run build:all >"$output_dir/build.log" 2>&1

real_gh="$(command -v gh || true)"
if test -z "$real_gh"; then
  gh_version="2.88.1"
  gh_archive="$scratch/gh.tar.gz"
  curl --fail --silent --show-error --location \
    "https://github.com/cli/cli/releases/download/v${gh_version}/gh_${gh_version}_linux_amd64.tar.gz" \
    --output "$gh_archive"
  tar -xzf "$gh_archive" -C "$scratch"
  real_gh="$scratch/gh_${gh_version}_linux_amd64/bin/gh"
fi
test -x "$real_gh"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=127.0.0.1' \
  -addext 'subjectAltName=IP:127.0.0.1' \
  -keyout "$tls_dir/key.pem" \
  -out "$tls_dir/cert.pem" \
  >/dev/null 2>&1

export GITHUB_EGRESS_PROOF_OUTPUT="$output_dir"
export GITHUB_EGRESS_PROOF_SCRATCH="$scratch"
export GITHUB_EGRESS_PROOF_TLS_KEY="$tls_dir/key.pem"
export GITHUB_EGRESS_PROOF_TLS_CERT="$tls_dir/cert.pem"
export GITHUB_EGRESS_PROOF_REAL_GH="$real_gh"
node docs/proof/github-egress-telemetry/run-proof.mjs

test -s "$output_dir/proof-summary.json"
test -s "$output_dir/public-observability.json"
test -s "$output_dir/wrangler.log"
