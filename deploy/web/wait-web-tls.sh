#!/usr/bin/env bash

web_tls_served_fingerprint() {
  local host="$1"
  printf '\n' | timeout 0.5s openssl s_client -connect 127.0.0.1:443 -servername "$host" 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null \
    | awk -F= '/[Ff]ingerprint=/ {print $2}' | tr -d '\r\n'
}

wait_web_tls_fingerprint() {
  local host="$1" expected="$2" timeout_ms="$3" interval="$4"
  local deadline_ms now_ms served

  [ -n "$expected" ] || { echo 'WEB_TLS_NOT_READY: expected certificate fingerprint is empty' >&2; return 1; }
  deadline_ms="$(($(date +%s%3N) + timeout_ms))"
  while :; do
    served="$(web_tls_served_fingerprint "$host" || true)"
    now_ms="$(date +%s%3N)"
    if [ "$served" = "$expected" ] && [ "$now_ms" -le "$deadline_ms" ]; then
      return 0
    fi
    if [ "$now_ms" -ge "$deadline_ms" ]; then
      echo "WEB_TLS_NOT_READY: $host did not begin serving expected certificate after nginx reload" >&2
      return 1
    fi
    sleep "$interval"
  done
}
