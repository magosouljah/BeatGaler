#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
  MINGW*|MSYS*) echo 'WEB_DEPLOY_ROLLBACK_FIXTURE_SKIPPED: POSIX symlinks unavailable in Git Bash'; exit 0 ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/web/releases/previous" "$fixture/etc" "$fixture/content/.well-known" "$fixture/content/status"
printf 'old' > "$fixture/web/releases/previous/index.html"
ln -s "$fixture/web/releases/previous" "$fixture/web/current"
printf 'previous nginx configuration\n' > "$fixture/etc/nginx.conf"
printf 'new nginx configuration\n' > "$fixture/bootstrap.conf"
printf 'new production configuration\n' > "$fixture/production.conf"
printf 'new' > "$fixture/content/index.html"
printf 'security' > "$fixture/content/.well-known/security.txt"
printf 'status' > "$fixture/content/status/index.html"
sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
printf '%s\n' "$sha" > "$fixture/content/.well-known/source-sha.txt"
tar -czf "$fixture/web.tgz" -C "$fixture/content" .

cat > "$fixture/bin/getent" <<'EOF'
#!/usr/bin/env bash
printf '203.0.113.10 STREAM %s\n' "$2"
EOF
cat > "$fixture/bin/certbot" <<'EOF'
#!/usr/bin/env bash
exit 55
EOF
for command_name in nginx systemctl; do
  cat > "$fixture/bin/$command_name" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
done
chmod +x "$fixture/bin/"*

sed \
  -e "s|^WEB_ROOT=.*|WEB_ROOT=\"$fixture/web\"|" \
  -e "s|^NGINX_CONF=.*|NGINX_CONF=\"$fixture/etc/nginx.conf\"|" \
  -e "s|^CERT_DIR=.*|CERT_DIR=\"$fixture/cert\"|" \
  "$repo_root/deploy/web/install-web-production.sh" > "$fixture/install.sh"

set +e
PATH="$fixture/bin:$PATH" bash "$fixture/install.sh" "$fixture/web.tgz" \
  "$fixture/bootstrap.conf" "$fixture/production.conf" "$sha" > "$fixture/stdout" 2> "$fixture/stderr"
status=$?
set -e
[ "$status" -eq 55 ] || { cat "$fixture/stderr"; echo "Unexpected installer exit: $status" >&2; exit 1; }
[ "$(readlink "$fixture/web/current")" = "$fixture/web/releases/previous" ]
grep -Fxq 'previous nginx configuration' "$fixture/etc/nginx.conf"
grep -q 'WEB_DEPLOY_ROLLED_BACK' "$fixture/stderr"
echo 'WEB_DEPLOY_ROLLBACK_FIXTURE_OK'
