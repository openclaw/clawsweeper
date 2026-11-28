# Scripted gh and curl stand-ins. Keep argv and stdin separate just as the real tools do.
set -eu
cd "$1"
tool=$2
shift 2
if [ "$tool" = record-gh ]; then
  jq -cn --argjson pid "$$" --args '{args:$ARGS.positional,token:(env.GH_TOKEN // env.GITHUB_TOKEN),pool:env.CLAWSWEEPER_GITHUB_POOL_CLASS,at:(now*1000),pid:$pid}' -- "$@" >> requests.jsonl
  cat static-response
  exit 0
fi
if [ "$tool" = gh ]; then
  if [ "$1" != auth ]; then
    printf '%s\n' '{"resources":{"core":{"remaining":0,"reset":1900000000}}}'
    exit 0
  fi
  : > keyring-requested
  case "$4" in
    github.com) echo synthetic-config-token ;;
    a.example) echo synthetic-a-token ;;
    broken.example) echo 'keyring unavailable' >&2; exit 2 ;;
    *) echo "no oauth token found for $4" >&2; exit 1 ;;
  esac
  exit 0
fi
read -r i < request-count
printf '%s\0' "$@" > "$i.args"
cat > "$i.headers"
echo "$((i + 1))" > request-count
if [ ! -f "$i.response" ]; then read -r i < last-response; fi
cat "$i.response"
read -r code < "$i.exit"
exit "$code"
