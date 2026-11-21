#!/bin/bash
# BeatGaler Cloud / catalog worker — arranque de PRODUCCIÓN versionado (instalado en /usr/local/bin/beatgaler-start).
# Uso (systemd ExecStart): beatgaler-start cloud | beatgaler-start worker
# NO contiene secretos: los lee de archivos del host (root/ec2-user, 0600/0640) y de AWS Secrets Manager.
#   /etc/beatgaler-direct.env       Telegram API (app de producción) + token MANAGER + flags Direct legacy
#   /etc/beatgaler-production.env   entorno de producción (rutas runtime, billing, alertas, SES, registro)
#   /etc/beatgaler-oauth.env        X_CLIENT_ID / X_CLIENT_SECRET / BEATGALER_MASTER_SESSION_FILE
#   $CREDENTIALS_DIRECTORY/catalog-runtime-db.env   credencial del rol SQL del catálogo (systemd LoadCredential)
# El código se ejecuta SIEMPRE desde la release activa (symlink) y el estado vive en BEATGALER_STATE_DIR.
ROLE="${1:-cloud}"
RELEASES=/home/ec2-user/BeatGaler-releases
RELEASE="$(readlink -f "$RELEASES/current")"
[ -d "$RELEASE/cloud-server" ] || { echo "STOP: no active release at $RELEASES/current" >&2; exit 2; }

# Los archivos de entorno se cargan antes de `set -u` (pueden referenciar variables opcionales).
set -a
source /etc/beatgaler-direct.env
source /etc/beatgaler-production.env
source /etc/beatgaler-oauth.env
set +a
set -euo pipefail

[ -n "${BEATGALER_MASTER_SESSION_FILE:-}" ] && [ -s "$BEATGALER_MASTER_SESSION_FILE" ] || { echo "Missing persistent BeatGaler MASTER session" >&2; exit 1; }
export BEATGALER_MASTER_SESSION="$(<"$BEATGALER_MASTER_SESSION_FILE")"

# Trazabilidad: el SHA lo fija la release (archivo generado por el despliegue), nunca un valor manual en /etc.
export BEATGALER_SOURCE_SHA="$(cat "$RELEASE/RELEASE_SHA")"
export BEATGALER_STATE_DIR=/var/lib/beatgaler/state
export DIRECT_DIAGNOSTICS_DIR=/var/lib/beatgaler/state/diagnostics
export BEATGALER_OAUTH_PUBLIC_BASE=https://api.beatgaler.com
export BEATGALER_ALLOWED_ORIGINS=https://beatgaler.com

SECRET_JSON="$(aws secretsmanager get-secret-value --secret-id 'beatgaler/prod/postgres' --region us-east-2 --query SecretString --output text)"
export SECRET_JSON
export DATABASE_URL="$(node -e '
const s = JSON.parse(process.env.SECRET_JSON);
const u = new URL(`postgresql://${s.username}@${s.host}:${s.port}/postgres`);
u.password = s.password;
process.stdout.write(u.href);
')"
unset SECRET_JSON

export AWS_REGION="us-east-2"
export BEATGALER_AWS_SECRET_ENVELOPE_ID="arn:aws:secretsmanager:us-east-2:403659231201:secret:beatgaler/prod/control-plane-envelope-sIZ5d5"
export BEATGALER_SECRET_ENVELOPE_PROVIDER="aws-secrets-manager"
export BEATGALER_POSTGRES_ENABLED="true"
export BEATGALER_CONTROL_PLANE_AUTHORITY="postgres"
export BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256="ab85c48b7904d86f5ce772e0c8984695823e233a8cbd7b4a618f04c3d9f7cb6a"
export BEATGALER_POSTGRES_SSL_MODE="require"
export NODE_EXTRA_CA_CERTS="/home/ec2-user/rds-global-bundle.pem"

[ -f "${CREDENTIALS_DIRECTORY:-}/catalog-runtime-db.env" ] || { echo "STOP: catalog runtime credential absent" >&2; exit 2; }
set -a; source "$CREDENTIALS_DIRECTORY/catalog-runtime-db.env"; set +a

# Catálogo nativo PostgreSQL (mismos flags funcionales que LOCAL; ver docs/operations/DEPLOY-AWS.md).
export BEATGALER_CATALOG_NATIVE_ENABLED=true
export BEATGALER_CATALOG_GATEWAY_ENABLED=true
export BEATGALER_CATALOG_DIRECT_ENABLED=true
export BEATGALER_CATALOG_PREFIX_PACKS_ENABLED=true
# Bots reutilizados sin rotar: excepción aceptada por el propietario (NO es G2 PASS); el arranque la verifica contra SQL.
export BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED=true
# Un login permanente de bot al arrancar evita el primer Direct frío (~4-5 s); acotado a 1 para no insistir contra Telegram.
export BEATGALER_CATALOG_DIRECT_PREWARM_BOTS=1
# Eliminación física: SIN journal configurado ningún delete puede ejecutarse (C9). No se habilita aquí.

cd "$RELEASE"
case "$ROLE" in
  cloud)  exec node cloud-server/server.js ;;
  worker)
    export BEATGALER_CATALOG_WORKER_ENABLED=true
    export BEATGALER_CATALOG_WORKER_POLL_MS=1000
    exec node cloud-server/catalog-worker.js ;;
  *) echo "usage: beatgaler-start cloud|worker" >&2; exit 64 ;;
esac
