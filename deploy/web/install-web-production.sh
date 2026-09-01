#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:-/tmp/beatgaler-web.tgz}"
BOOTSTRAP_CONF="${2:-/tmp/beatgaler.com.bootstrap.conf}"
PRODUCTION_CONF="${3:-/tmp/beatgaler.com.conf}"

WEB_HOST="beatgaler.com"
WWW_HOST="www.beatgaler.com"
STATUS_HOST="status.beatgaler.com"
API_HOST="api.beatgaler.com"
WEB_ROOT="/var/www/beatgaler-web"
NGINX_CONF="/etc/nginx/conf.d/beatgaler-web.conf"
CERT_DIR="/etc/letsencrypt/live/beatgaler.com"
CERT_EMAIL="support@beatgaler.com"

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 2; }
}

for command_name in nginx certbot getent tar curl grep awk sort date install ln openssl mktemp; do
  require_command "$command_name"
done

for file_path in "$ARCHIVE" "$BOOTSTRAP_CONF" "$PRODUCTION_CONF"; do
  [ -f "$file_path" ] || { echo "Missing deployment input: $file_path" >&2; exit 3; }
done

dns_ips() {
  getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u || true
}

shares_ip_with_api() {
  local host="$1"
  local host_ips api_ips ip
  host_ips="$(dns_ips "$host")"
  api_ips="$(dns_ips "$API_HOST")"
  [ -n "$host_ips" ] && [ -n "$api_ips" ] || return 1
  for ip in $host_ips; do
    if printf '%s\n' "$api_ips" | grep -Fxq "$ip"; then
      return 0
    fi
  done
  return 1
}

if ! shares_ip_with_api "$WEB_HOST"; then
  echo "DNS_NOT_READY: $WEB_HOST must resolve to the same EC2 public address as $API_HOST before deployment." >&2
  echo "$WEB_HOST -> $(dns_ips "$WEB_HOST" | tr '\n' ' ')" >&2
  echo "$API_HOST -> $(dns_ips "$API_HOST" | tr '\n' ' ')" >&2
  exit 20
fi

if ! shares_ip_with_api "$WWW_HOST"; then
  echo "DNS_NOT_READY: $WWW_HOST must resolve to the same EC2 public address as $API_HOST so HTTPS redirect coverage can be issued." >&2
  echo "$WWW_HOST -> $(dns_ips "$WWW_HOST" | tr '\n' ' ')" >&2
  echo "$API_HOST -> $(dns_ips "$API_HOST" | tr '\n' ' ')" >&2
  exit 21
fi

STATUS_DNS_READY=0
if shares_ip_with_api "$STATUS_HOST"; then
  STATUS_DNS_READY=1
else
  echo "STATUS_DNS_PENDING: $STATUS_HOST is not on the Web/API origin yet; status TLS issuance will be skipped on this deploy." >&2
fi

if tar -tzf "$ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Refusing archive with absolute or parent-traversal paths." >&2
  exit 22
fi

RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$WEB_ROOT/releases/$RELEASE_ID"
install -d -m 0755 "$WEB_ROOT/releases" "$RELEASE_DIR"
tar -xzf "$ARCHIVE" -C "$RELEASE_DIR"
[ -f "$RELEASE_DIR/index.html" ] || { echo "Built Web archive is missing index.html" >&2; rm -rf "$RELEASE_DIR"; exit 23; }
[ -f "$RELEASE_DIR/.well-known/security.txt" ] || { echo "Built Web archive is missing .well-known/security.txt" >&2; rm -rf "$RELEASE_DIR"; exit 24; }
[ -f "$RELEASE_DIR/status/index.html" ] || { echo "Built Web archive is missing status/index.html" >&2; rm -rf "$RELEASE_DIR"; exit 25; }

# Switch static files atomically. If later TLS/nginx validation fails, the files are
# still complete and the previous release remains available under releases/.
ln -sfn "$RELEASE_DIR" "$WEB_ROOT/current"

# Bootstrap HTTP first so Certbot can satisfy ACME without touching api.beatgaler.com.
install -m 0644 "$BOOTSTRAP_CONF" "$NGINX_CONF"
nginx -t
systemctl reload nginx

CERTBOT_ARGS=(
  certonly --nginx --non-interactive --agree-tos
  --email "$CERT_EMAIL"
  --cert-name beatgaler.com
  -d "$WEB_HOST" -d "$WWW_HOST"
)
if [ "$STATUS_DNS_READY" -eq 1 ]; then
  CERTBOT_ARGS+=(-d "$STATUS_HOST")
fi

if [ -f "$CERT_DIR/fullchain.pem" ]; then
  CERT_HAS_WWW=0
  CERT_HAS_STATUS=0
  openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -text | grep -Fq "DNS:$WWW_HOST" && CERT_HAS_WWW=1
  openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -text | grep -Fq "DNS:$STATUS_HOST" && CERT_HAS_STATUS=1

  if [ "$CERT_HAS_WWW" -eq 1 ] && { [ "$STATUS_DNS_READY" -eq 0 ] || [ "$CERT_HAS_STATUS" -eq 1 ]; }; then
    CERTBOT_ARGS+=(--keep-until-expiring)
  else
    CERTBOT_ARGS+=(--expand)
  fi
fi

certbot "${CERTBOT_ARGS[@]}"

if [ "$STATUS_DNS_READY" -eq 1 ]; then
  openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -text | grep -Fq "DNS:$STATUS_HOST" \
    || { echo "TLS certificate is missing DNS:$STATUS_HOST after Certbot." >&2; exit 26; }
fi

install -m 0644 "$PRODUCTION_CONF" "$NGINX_CONF"
nginx -t
systemctl reload nginx

curl --noproxy '*' --fail --silent --show-error --resolve "$WEB_HOST:443:127.0.0.1" "https://$WEB_HOST/web-health" | grep -Fxq "ok"
curl --noproxy '*' --fail --silent --show-error --resolve "$WEB_HOST:443:127.0.0.1" "https://$WEB_HOST/beatgaler-api/auth/health" \
  | grep -Eq '"account_auth"[[:space:]]*:[[:space:]]*true'

SECURITY_HEADERS="$(mktemp)"
SECURITY_BODY="$(mktemp)"
trap 'rm -f "$SECURITY_HEADERS" "$SECURITY_BODY"' EXIT
curl --noproxy '*' --fail --silent --show-error --resolve "$WEB_HOST:443:127.0.0.1" \
  -D "$SECURITY_HEADERS" -o "$SECURITY_BODY" "https://$WEB_HOST/.well-known/security.txt"
grep -Eiq '^content-type:[[:space:]]*text/plain;[[:space:]]*charset=utf-8([[:space:]]|$)' "$SECURITY_HEADERS"
grep -Fxq 'Canonical: https://beatgaler.com/.well-known/security.txt' "$SECURITY_BODY"
if grep -Eiq '<!doctype html|<html[[:space:]>]' "$SECURITY_BODY"; then
  echo "security.txt unexpectedly resolved to HTML/SPA content." >&2
  exit 27
fi

if [ "$STATUS_DNS_READY" -eq 1 ]; then
  curl --noproxy '*' --fail --silent --show-error --resolve "$STATUS_HOST:443:127.0.0.1" "https://$STATUS_HOST/" \
    | grep -Fq 'BeatGaler Web'
  echo "STATUS_LOCAL_HTTPS_OK host=$STATUS_HOST"
else
  echo "STATUS_RUNTIME_UNVERIFIED host=$STATUS_HOST reason=DNS_NOT_READY"
fi

# Keep rollback material without growing the tiny EC2 disk indefinitely.
mapfile -t OLD_RELEASES < <(find "$WEB_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR>5 {$1=""; sub(/^ /, ""); print}')
for old_release in "${OLD_RELEASES[@]:-}"; do
  [ -n "$old_release" ] && rm -rf -- "$old_release"
done

echo "WEB_DEPLOY_OK release=$RELEASE_ID url=https://$WEB_HOST api_proxy=https://$WEB_HOST/beatgaler-api"
