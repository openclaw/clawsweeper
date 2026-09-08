#!/usr/bin/env bash

# Preserve curl's stdout, output file, and exit code; only the last attempt escapes.
# A subshell keeps scratch cleanup separate from the caller's traps and shell options.
control_plane_curl() (
  local scratch attempt curl_exit http_status retryable delay
  scratch="$(mktemp -d)" || return 1
  trap 'rm -rf "$scratch"' EXIT
  for attempt in 1 2 3 4; do
    : > "$scratch/headers"
    curl_exit=0
    curl --dump-header "$scratch/headers" "$@" > "$scratch/stdout" || curl_exit=$?
    http_status="$(awk '/^HTTP\// { code=$2 } END { print code }' "$scratch/headers")"
    echo "::notice::Control-plane request attempt $attempt/4: HTTP ${http_status:-000}, curl exit $curl_exit" >&2
    retryable=false
    if [[ "$http_status" == 5[0-9][0-9] ]]; then
      retryable=true
    elif [[ -z "$http_status" || "$http_status" != 4[0-9][0-9] ]]; then
      case "$curl_exit" in
        5|6|7|16|18|28|35|52|55|56|92) retryable=true ;;
      esac
    fi
    if [[ "$retryable" != true || "$attempt" == 4 ]]; then
      cat "$scratch/stdout"
      return "$curl_exit"
    fi
    delay="$(node - "$scratch/headers" "$attempt" <<'NODE'
const fs = require("node:fs");
const blocks = fs.readFileSync(process.argv[2], "utf8").split(/(?=^HTTP\/)/m);
const value = blocks.at(-1)?.match(/^retry-after:\s*([^\r\n]*)/im)?.[1]?.trim();
const seconds = value && /^\d+$/.test(value)
  ? Number(value)
  : value ? Math.ceil((Date.parse(value) - Date.now()) / 1000) : NaN;
process.stdout.write(String(Number.isFinite(seconds)
  ? Math.min(60, Math.max(0, seconds))
  : 2 ** Number(process.argv[3])));
NODE
    )" || return 1
    echo "::notice::Control-plane request retry in ${delay}s" >&2
    sleep "$delay"
  done
)
