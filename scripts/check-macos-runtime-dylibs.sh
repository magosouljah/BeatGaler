#!/bin/bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <Mach-O executable> [...]" >&2
  exit 2
fi

for binary in "$@"; do
  test -x "$binary"
  bad=0
  while IFS= read -r line; do
    dep="$(printf '%s\n' "$line" | awk '{print $1}')"
    [ -z "$dep" ] && continue
    case "$dep" in
      /usr/lib/*|/System/Library/*)
        ;;
      *)
        echo "::error file=${binary}::Non-portable dylib dependency: ${dep}" >&2
        bad=1
        ;;
    esac
  done < <(otool -L "$binary" | tail -n +2)

  if [ "$bad" -ne 0 ]; then
    otool -L "$binary" >&2
    exit 1
  fi
  echo "portable dylibs: $binary"
done
