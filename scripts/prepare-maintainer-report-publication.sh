#!/usr/bin/env bash
set -euo pipefail

generated_dir="${1:?generated report directory is required}"
maintainers_dir="${2:?maintainers checkout directory is required}"
expected_sha="${3:?expected maintainer base SHA is required}"

if [ ! -d "$generated_dir" ] || [ ! -d "$maintainers_dir/.git" ]; then
  echo "Generated reports and a maintainer Git checkout are required." >&2
  exit 1
fi

actual_sha="$(git -C "$maintainers_dir" rev-parse HEAD)"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "Maintainer checkout does not match the generation base." >&2
  exit 1
fi

if find "$generated_dir" \( -name .git -o -name .gitattributes -o -name .gitignore -o -name .gitmodules \) -print -quit | grep -q .; then
  echo "Generated reports must not contain Git control files." >&2
  exit 1
fi
if find "$generated_dir" ! -type f ! -type d -print -quit | grep -q .; then
  echo "Generated reports must contain only regular files and directories." >&2
  exit 1
fi

file_count="$(find "$generated_dir" -type f | wc -l | tr -d ' ')"
size_kib="$(du -sk "$generated_dir" | cut -f1)"
if [ "$file_count" -lt 1 ] || [ "$file_count" -gt 2000 ] || [ "$size_kib" -gt 262144 ]; then
  echo "Generated report artifact is empty or exceeds its bounded file-count or size limit." >&2
  exit 1
fi

mkdir -p "$maintainers_dir/reports"
rsync --archive --delete "$generated_dir/" "$maintainers_dir/reports/"
git -C "$maintainers_dir" add -A -- reports

changed=true
if git -C "$maintainers_dir" diff --cached --quiet -- reports; then
  changed=false
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'changed=%s\n' "$changed" >> "$GITHUB_OUTPUT"
fi
printf 'changed=%s\n' "$changed"
