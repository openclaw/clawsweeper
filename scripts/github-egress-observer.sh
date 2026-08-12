#!/usr/bin/env bash
set -u

real_gh="${CLAWSWEEPER_REAL_GH_BIN:-}"
if [[ -z "$real_gh" || ! -x "$real_gh" ]]; then
  echo "ClawSweeper GitHub observer: CLAWSWEEPER_REAL_GH_BIN is unavailable" >&2
  exit 127
fi

metrics_path="${CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH:-}"
observer_root="${CLAWSWEEPER_GITHUB_OBSERVER_ROOT:-${GITHUB_WORKSPACE:-.}}"
if [[ -z "$metrics_path" ]]; then
  exec "$real_gh" "$@"
fi

descriptor=true
previous=""
for argument in "$@"; do
  if [[ "$previous" == "run" && "$argument" == "download" ]]; then
    descriptor=false
    break
  fi
  previous="$argument"
done

stderr_file="$(mktemp "${RUNNER_TEMP:-/tmp}/clawsweeper-gh-stderr.XXXXXX")"
clean_stderr_file="$(mktemp "${RUNNER_TEMP:-/tmp}/clawsweeper-gh-clean-stderr.XXXXXX")"
gh_pid=""
cleanup() {
  rm -f "$stderr_file" "$clean_stderr_file"
}
forward_signal() {
  local signal="$1"
  local status="$2"
  if [[ -n "$gh_pid" ]]; then
    kill -s "$signal" "$gh_pid" 2>/dev/null || true
    wait "$gh_pid" 2>/dev/null || true
  fi
  exit "$status"
}
sanitize_debug_fallback() {
  # Preserve ordinary gh stderr while suppressing complete or partial GH_DEBUG
  # frames if the richer observer is unavailable. Latin-1 is a byte-preserving
  # mapping, including an ordinary final record without a newline.
  node -e '
    const fs = require("node:fs");
    const input = fs.readFileSync(0);
    const text = input.toString("latin1");
    const clean = [];
    let cursor = 0;
    const startPattern = /^\* Request at [^\r\n]*(?:\r?\n|$)/gm;
    for (;;) {
      startPattern.lastIndex = cursor;
      const start = startPattern.exec(text);
      if (!start) {
        clean.push(text.slice(cursor));
        break;
      }
      clean.push(text.slice(cursor, start.index));
      const endPattern = /^\* Request (?:took|failed after) [^\r\n]*(?:\r?\n|$)/gm;
      endPattern.lastIndex = start.index + start[0].length;
      const end = endPattern.exec(text);
      if (!end) break;
      cursor = end.index + end[0].length;
    }
    process.stdout.write(Buffer.from(clean.join(""), "latin1"));
  ' <"$stderr_file"
}
trap cleanup EXIT
trap 'forward_signal TERM 143' TERM
trap 'forward_signal INT 130' INT
trap 'forward_signal HUP 129' HUP

if [[ "$descriptor" == "true" ]]; then
  CLAWSWEEPER_GITHUB_DEBUG_ENABLED=true GH_DEBUG=api "$real_gh" "$@" 2>"$stderr_file" &
else
  CLAWSWEEPER_GITHUB_DEBUG_ENABLED=false env -u GH_DEBUG "$real_gh" "$@" 2>"$stderr_file" &
fi
gh_pid=$!
set +e
wait "$gh_pid"
status=$?
set -e
gh_pid=""

if ! CLAWSWEEPER_GITHUB_DEBUG_ENABLED="$descriptor" \
  node "$observer_root/dist/github-egress-observer-cli.js" -- "$@" \
  <"$stderr_file" >"$clean_stderr_file" 2>/dev/null; then
  # Never leak a raw GH_DEBUG frame or suppress the original gh error text when
  # observation itself fails. Conservation detects the missing upload.
  sanitize_debug_fallback >"$clean_stderr_file"
fi
cat "$clean_stderr_file" >&2
exit "$status"
