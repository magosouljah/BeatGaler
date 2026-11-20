#!/bin/bash
# Activa en el host de producción una release Web + Cloud construida desde UN SHA de git (scripts/aws/deploy.sh la invoca por SSM).
# Entradas (entorno): SHA (40 hex), CLOUD_URL, CLOUD_SHA256, WEB_URL, WEB_SHA256 (URLs S3 prefirmadas de solo lectura).
# Garantías: nunca borra releases, estado ni configuración; respaldo previo de lo que reemplaza; rollback automático si la salud falla.
set -euo pipefail
umask 022
: "${SHA:?}" "${CLOUD_URL:?}" "${CLOUD_SHA256:?}" "${WEB_URL:?}" "${WEB_SHA256:?}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: bad SHA" >&2; exit 2; }
ID="${SHA:0:12}"
CR=/home/ec2-user/BeatGaler-releases
WR=/var/www/beatgaler-web
STATE=/var/lib/beatgaler/state
TS=$(date -u +%Y%m%dT%H%M%SZ)
BK=/home/ec2-user/beatgaler-backups/activate-$ID-$TS
mkdir -p "$BK"; chmod 700 "$BK"
log() { echo "[activate $ID] $*"; }

# 1) Descarga y verificación de artefactos.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsS -o "$TMP/cloud.tgz" "$CLOUD_URL"; curl -fsS -o "$TMP/web.tgz" "$WEB_URL"
echo "$CLOUD_SHA256  $TMP/cloud.tgz" | sha256sum -c --quiet; echo "$WEB_SHA256  $TMP/web.tgz" | sha256sum -c --quiet
log "artefactos verificados"

# 2) Release Cloud inmutable (si ya existe con el mismo SHA se reutiliza).
NEW="$CR/$ID"
PREV_CLOUD="$(readlink -f "$CR/current" 2>/dev/null || true)"
if [ -z "$PREV_CLOUD" ]; then PREV_CLOUD="$(sed -n 's#^cd \(/home/ec2-user/BeatGaler-releases/[^ ]*\)$#\1#p' /usr/local/bin/beatgaler-cloud-start | head -1)"; fi
[ -d "$PREV_CLOUD/cloud-server" ] || { echo "STOP: previous Cloud release not found" >&2; exit 3; }
if [ ! -f "$NEW/RELEASE_SHA" ]; then
  mkdir -p "$NEW.partial"; tar -xzf "$TMP/cloud.tgz" -C "$NEW.partial"
  if cmp -s "$NEW.partial/cloud-server/package-lock.json" "$PREV_CLOUD/cloud-server/package-lock.json" && [ -d "$PREV_CLOUD/cloud-server/node_modules" ]; then
    cp -a "$PREV_CLOUD/cloud-server/node_modules" "$NEW.partial/cloud-server/node_modules"; log "node_modules reutilizado (lock idéntico)"
  else
    (cd "$NEW.partial/cloud-server" && npm ci --omit=dev --no-audit --no-fund); log "npm ci completado"
  fi
  echo "$SHA" > "$NEW.partial/RELEASE_SHA"
  chown -R ec2-user:ec2-user "$NEW.partial"; mv "$NEW.partial" "$NEW"
fi
[ "$(cat "$NEW/RELEASE_SHA")" = "$SHA" ] || { echo "STOP: release dir SHA mismatch" >&2; exit 4; }

# 3) Release Web inmutable.
WNEW="$WR/releases/$ID"
PREV_WEB="$(readlink -f "$WR/current")"
if [ ! -f "$WNEW/.well-known/source-sha.txt" ]; then
  mkdir -p "$WNEW.partial"; tar -xzf "$TMP/web.tgz" -C "$WNEW.partial"; chown -R ec2-user:ec2-user "$WNEW.partial"; mv "$WNEW.partial" "$WNEW"
fi
[ "$(tr -d '[:space:]' < "$WNEW/.well-known/source-sha.txt")" = "$SHA" ] || { echo "STOP: web source-sha mismatch" >&2; exit 5; }

# 4) Respaldo de lo que se va a reemplazar.
cp -a /usr/local/bin/beatgaler-cloud-start /usr/local/bin/beatgaler-catalog-worker-start "$BK/" 2>/dev/null || true
[ -f /usr/local/bin/beatgaler-start ] && cp -a /usr/local/bin/beatgaler-start "$BK/"
cp -a /etc/systemd/system/beatgaler-cloud.service /etc/systemd/system/beatgaler-catalog-worker.service "$BK/"
echo "$PREV_CLOUD" > "$BK/prev-cloud.txt"; echo "$PREV_WEB" > "$BK/prev-web.txt"

# 5) Migración ÚNICA de configuración y estado fuera de las releases (los servicios se detienen para no perder escrituras).
NEED_STATE=0; [ -f "$STATE/.migrated" ] || NEED_STATE=1
if [ ! -f /etc/beatgaler-oauth.env ]; then
  # X OAuth y ruta de la sesión MASTER estaban incrustados en el script manual; se mueven a un archivo 0640 sin imprimirlos.
  grep -E '^(export )?(X_CLIENT_ID|X_CLIENT_SECRET|BEATGALER_MASTER_SESSION_FILE)=' /usr/local/bin/beatgaler-cloud-start | sed -E 's/^export //' > /etc/beatgaler-oauth.env.new
  [ "$(grep -c . /etc/beatgaler-oauth.env.new)" = 3 ] || { rm -f /etc/beatgaler-oauth.env.new; echo "STOP: could not extract OAuth/MASTER settings" >&2; exit 6; }
  chown root:ec2-user /etc/beatgaler-oauth.env.new; chmod 0640 /etc/beatgaler-oauth.env.new; mv /etc/beatgaler-oauth.env.new /etc/beatgaler-oauth.env
  log "oauth env creado"
fi

rollback() {
  log "ROLLBACK: $1"
  ln -sfn "$PREV_CLOUD" "$CR/current.tmp" && mv -T "$CR/current.tmp" "$CR/current"
  ln -sfn "$PREV_WEB" "$WR/current.tmp" && mv -T "$WR/current.tmp" "$WR/current"
  cp -a "$BK/beatgaler-cloud.service" "$BK/beatgaler-catalog-worker.service" /etc/systemd/system/
  systemctl daemon-reload; systemctl restart beatgaler-cloud beatgaler-catalog-worker || true
  exit 9
}

systemctl stop beatgaler-catalog-worker beatgaler-cloud
if [ "$NEED_STATE" = 1 ]; then
  install -d -o ec2-user -g ec2-user -m 0750 "$STATE" "$STATE/diagnostics"
  for f in cloud-data.json accounts-data.json account-lifecycle-state.json session-security-state.json authz-session-bindings.json; do
    if [ -f "$PREV_CLOUD/cloud-server/$f" ] && [ ! -f "$STATE/$f" ]; then cp -a "$PREV_CLOUD/cloud-server/$f" "$STATE/$f"; fi
  done
  [ -f "$PREV_CLOUD/cloud-server/diagnostics/telegram-direct-control.txt" ] && [ ! -f "$STATE/diagnostics/telegram-direct-control.txt" ] && cp -a "$PREV_CLOUD/cloud-server/diagnostics/telegram-direct-control.txt" "$STATE/diagnostics/"
  for f in cloud-data.json accounts-data.json session-security-state.json authz-session-bindings.json; do [ -s "$STATE/$f" ] || { systemctl start beatgaler-cloud beatgaler-catalog-worker; echo "STOP: state $f missing after migration" >&2; exit 7; }; done
  chown -R ec2-user:ec2-user "$STATE"; echo "from=$PREV_CLOUD at=$TS" > "$STATE/.migrated"
  log "estado migrado a $STATE"
fi

# 6) Arranque versionado + unidades apuntando a él; symlinks atómicos.
install -m 0755 -o root -g root "$NEW/deploy/aws/beatgaler-start.sh" /usr/local/bin/beatgaler-start
sed -i 's#^ExecStart=.*#ExecStart=/usr/local/bin/beatgaler-start cloud#' /etc/systemd/system/beatgaler-cloud.service
sed -i 's#^ExecStart=.*#ExecStart=/usr/local/bin/beatgaler-start worker#' /etc/systemd/system/beatgaler-catalog-worker.service
systemctl daemon-reload
ln -sfn "$NEW" "$CR/current.tmp" && mv -T "$CR/current.tmp" "$CR/current"
ln -sfn "$WNEW" "$WR/current.tmp" && mv -T "$WR/current.tmp" "$WR/current"
systemctl start beatgaler-cloud
for i in $(seq 1 45); do
  R=$(curl -fsS -m 3 http://127.0.0.1:4000/readyz 2>/dev/null || true)
  if echo "$R" | grep -q "\"sourceSha\":\"$SHA\"" && echo "$R" | grep -q '"status":"ready"'; then break; fi
  sleep 2; [ "$i" = 45 ] && { journalctl -u beatgaler-cloud -n 40 --no-pager -o cat | sed -E 's/[0-9]{6,12}:[A-Za-z0-9_-]{30,}/<tok>/g'; rollback "cloud not ready"; }
done
systemctl start beatgaler-catalog-worker
sleep 5; systemctl is-active --quiet beatgaler-catalog-worker || rollback "worker not active"
WS=$(curl -fsS -m 5 --resolve beatgaler.com:443:127.0.0.1 https://beatgaler.com/.well-known/source-sha.txt | tr -d '[:space:]')
[ "$WS" = "$SHA" ] || rollback "web source-sha mismatch ($WS)"
log "ACTIVE cloud=$NEW web=$WNEW backup=$BK"
