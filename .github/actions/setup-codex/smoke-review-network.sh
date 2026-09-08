#!/usr/bin/env bash
set -euo pipefail
: "${CODEX_HOME:?}"
: "${GITHUB_WORKSPACE:?}"
# Use an empty environment so setup-step credentials cannot reach the sandbox.
env -i PATH="$PATH" HOME="$HOME" CODEX_HOME="$CODEX_HOME" \
  codex sandbox --permission-profile clawsweeper-review -C "$GITHUB_WORKSPACE" -- /bin/sh -eu -c '
    curl -sS --max-time 20 https://api.github.com/zen
    echo
    echo "allowed HTTPS: passed"
    set +e
    blocked_output=$(curl -sS --max-time 20 https://example.com/ 2>&1)
    blocked_exit=$?
    set -e
    printf "%s\n" "$blocked_output"
    test "$blocked_exit" -ne 0
    # A timeout or DNS failure does not prove proxy enforcement.
    case "$blocked_output" in *"CONNECT tunnel failed, response 403"*) ;; *) exit 1 ;; esac
    echo "unlisted HTTPS: blocked by proxy"
    probe="$PWD/.clawsweeper-sandbox-probe.$$"
    test ! -e "$probe"
    if (set -C; : > "$probe"); then
      rm -f "$probe"
      echo "review sandbox allowed a checkout write" >&2
      exit 1
    fi
    echo "checkout write: blocked"
  '
