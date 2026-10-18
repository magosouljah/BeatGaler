#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/deploy/web/release-switch.sh"

scratch="$(mktemp -d /tmp/beatgaler-v1-web-switch.XXXXXXXX)"
cleanup() {
  case "$(realpath -m -- "$scratch")" in
    /tmp/beatgaler-v1-web-switch.*) rm -rf -- "$scratch" ;;
    *) echo 'Refusing unexpected test cleanup path.' >&2; exit 1 ;;
  esac
}
trap cleanup EXIT

mkdir -p "$scratch/web/releases/old" "$scratch/web/releases/new" "$scratch/outside" "$scratch/nginx"
printf 'old\n' > "$scratch/web/releases/old/index.html"
printf 'new\n' > "$scratch/web/releases/new/index.html"
printf 'old-conf\n' > "$scratch/nginx/active.conf"
cp "$scratch/nginx/active.conf" "$scratch/nginx/previous.conf"
ln -s "$scratch/web/releases/old" "$scratch/web/current"

release_switch_init "$scratch/web"
release_switch_activate "$scratch/web/releases/new"
test "$(readlink -f "$scratch/web/current")" = "$scratch/web/releases/new"
printf 'bad-conf\n' > "$scratch/nginx/active.conf"
release_switch_restore_with_config "$scratch/nginx/previous.conf" "$scratch/nginx/active.conf" 1
test "$(readlink -f "$scratch/web/current")" = "$scratch/web/releases/old"
test "$(cat "$scratch/nginx/active.conf")" = old-conf

release_switch_init "$scratch/web"
if release_switch_activate "$scratch/outside" 2>/dev/null; then
  echo 'Switch accepted a target outside the releases directory.' >&2
  exit 1
fi
ln -s "$scratch/outside" "$scratch/web/releases/escaped"
if release_switch_activate "$scratch/web/releases/escaped" 2>/dev/null; then
  echo 'Switch accepted a symlink escaping the releases directory.' >&2
  exit 1
fi
test "$(readlink -f "$scratch/web/current")" = "$scratch/web/releases/old"
release_switch_activate "$scratch/web/releases/new"
release_switch_commit
release_switch_rollback
test "$(readlink -f "$scratch/web/current")" = "$scratch/web/releases/new"

mkdir -p "$scratch/first/releases/new"
release_switch_init "$scratch/first"
release_switch_activate "$scratch/first/releases/new"
printf 'first-conf\n' > "$scratch/nginx/first.conf"
release_switch_restore_with_config "$scratch/nginx/previous.conf" "$scratch/nginx/first.conf" 0
test ! -e "$scratch/first/current"
test ! -e "$scratch/nginx/first.conf"

echo 'PASS V1 local Web release and config rollback: atomic switch, failed-smoke restore, outside/symlink-target rejection, first-deploy rollback, commit retention'
