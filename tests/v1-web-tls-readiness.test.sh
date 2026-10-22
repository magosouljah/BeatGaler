#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$repo_root/deploy/web/wait-web-tls.sh"

scratch="$(mktemp -d /tmp/beatgaler-web-tls-test.XXXXXXXX)"
cleanup() {
  case "$(realpath -m -- "$scratch")" in
    /tmp/beatgaler-web-tls-test.*) rm -rf -- "$scratch" ;;
    *) echo 'Refusing unexpected test cleanup path.' >&2; exit 1 ;;
  esac
}
trap cleanup EXIT

counter="$scratch/probes"
web_tls_served_fingerprint() {
  local count
  count="$(cat "$counter")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$counter"
  if [ "${mode}" = eventually_correct ] && [ "$count" -ge 3 ]; then
    printf 'EXPECTED\n'
  else
    printf 'WRONG\n'
  fi
}

mode=eventually_correct
printf '0\n' > "$counter"
wait_web_tls_fingerprint beatgaler.com EXPECTED 1000 0.02
test "$(cat "$counter")" -eq 3

mode=always_wrong
printf '0\n' > "$counter"
if wait_web_tls_fingerprint beatgaler.com EXPECTED 200 0.02 2> "$scratch/error"; then
  echo 'TLS wait accepted a certificate with the wrong fingerprint.' >&2
  exit 1
fi
test "$(cat "$counter")" -ge 2
grep -Fq 'WEB_TLS_NOT_READY: beatgaler.com did not begin serving expected certificate after nginx reload' "$scratch/error"

installer="$repo_root/deploy/web/install-web-production.sh"
reload_line="$(grep -n '^systemctl reload nginx$' "$installer" | tail -1 | cut -d: -f1)"
wait_line="$(grep -n '^wait_web_tls_fingerprint ' "$installer" | cut -d: -f1)"
smoke_line="$(grep -n 'https://\$WEB_HOST/web-health' "$installer" | cut -d: -f1)"
test "$reload_line" -lt "$wait_line"
test "$wait_line" -lt "$smoke_line"
grep -Fq 'source "$(dirname "${BASH_SOURCE[0]}")/wait-web-tls.sh"' "$installer"
grep -Fq 'wait-web-tls.sh' "$repo_root/scripts/deploy-web-production.ps1"

echo 'PASS Web TLS readiness: wrong certificate retries, correct certificate proceeds, timeout fails, HTTPS smoke follows readiness'
