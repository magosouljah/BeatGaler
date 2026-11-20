#!/usr/bin/env bash
# Restore verificado de un backup de pg-backup.sh en una base AISLADA NUEVA (nunca sobre una base existente ni sobre producción).
# Pasos: descarga → verificación de hash del cifrado → descifrado → verificación del hash del volcado → pg_restore --list → createdb → pg_restore →
# verificación contra el manifiesto (migraciones, recuentos, checksum de filas) → (opcional) postura de restore HELD vía adopt-restored.cjs.
#   uso: pg-restore.sh <BACKUP_ID> <BASE_DESTINO>      (BASE_DESTINO debe contener «restore» y NO existir)
#   BACKUP_SOURCE (file:///dir | s3://bucket/prefix), BACKUP_PASSPHRASE_FILE, libpq env (PGHOST…), DATABASE_URL_ADOPT (opcional: URL de la base destino para adoptar)
# El restore de PostgreSQL NO restaura medios: los bytes siguen en Telegram. Tras abrir la base hay que reconciliar contra el journal externo y el proveedor.
set -euo pipefail
umask 077
ID="${1:-}"; TARGET_DB="${2:-}"
[[ "$ID" =~ ^bk-[A-Za-z0-9_-]{1,60}$ ]] || { echo "uso: $0 <BACKUP_ID> <BASE_DESTINO>" >&2; exit 2; }
[[ "$TARGET_DB" =~ ^[a-z0-9_]*restore[a-z0-9_]*$ ]] || { echo "BASE_DESTINO debe ser minúsculas/dígitos/_ y contener 'restore' (guardia contra sobrescribir bases reales)" >&2; exit 2; }
SRC="${BACKUP_SOURCE:-}"; [ -n "$SRC" ] || { echo "BACKUP_SOURCE requerido" >&2; exit 2; }
PASSFILE="${BACKUP_PASSPHRASE_FILE:-}"; [ -r "$PASSFILE" ] || { echo "BACKUP_PASSPHRASE_FILE ilegible" >&2; exit 2; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
get() { case "$SRC" in
  file://*) cp "${SRC#file://}/$1" "$WORK/$1" ;;
  s3://*) aws s3 cp --only-show-errors "${SRC%/}/$1" "$WORK/$1" ;;
  *) echo "BACKUP_SOURCE no soportado" >&2; exit 2 ;; esac; }
jget() { sed -n "s/.*\"$1\" *: *\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -1; }

get "$ID.manifest.json"; get "$ID.manifest.json.sha256"; get "$ID.dump.enc"
(cd "$WORK" && sha256sum -c "$ID.manifest.json.sha256" >/dev/null) || { echo "MANIFIESTO CORRUPTO" >&2; exit 3; }
EXP_ENC="$(tr -d ' \n' < "$WORK/$ID.manifest.json" | grep -o '"encrypted":{[^}]*}' | jget sha256)"
EXP_PLAIN="$(tr -d ' \n' < "$WORK/$ID.manifest.json" | grep -o '"dump":{[^}]*}' | jget sha256)"
[ "$(sha256sum "$WORK/$ID.dump.enc" | cut -d' ' -f1)" = "$EXP_ENC" ] || { echo "BACKUP_CORRUPT: hash del archivo cifrado no coincide" >&2; exit 3; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$PASSFILE" -in "$WORK/$ID.dump.enc" -out "$WORK/$ID.dump" || { echo "DESCIFRADO FALLIDO (frase incorrecta o archivo dañado)" >&2; exit 3; }
[ "$(sha256sum "$WORK/$ID.dump" | cut -d' ' -f1)" = "$EXP_PLAIN" ] || { echo "BACKUP_CORRUPT: hash del volcado no coincide" >&2; exit 3; }
pg_restore --list "$WORK/$ID.dump" > /dev/null

if psql -X -q -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'" | grep -q 1; then echo "la base destino ya existe: no se sobrescribe" >&2; exit 4; fi
createdb "$TARGET_DB"
if ! pg_restore --no-owner --no-acl --exit-on-error -d "$TARGET_DB" "$WORK/$ID.dump"; then echo "pg_restore falló; se elimina la base parcial $TARGET_DB" >&2; dropdb --if-exists "$TARGET_DB"; exit 5; fi

# verificación contra el manifiesto
M="$(tr -d ' \n' < "$WORK/$ID.manifest.json")"
exp() { echo "$M" | grep -o "\"$1\":[^,}]*" | head -1 | sed 's/.*://; s/"//g'; }
got() { psql -X -q -At -d "$TARGET_DB" -c "$1"; }
fail=0; chk() { if [ "$2" != "$3" ]; then echo "VERIFICACIÓN FALLIDA $1: esperado=$2 obtenido=$3" >&2; fail=1; else echo "ok $1=$3"; fi; }
chk migrations_last "$(exp last)" "$(got 'SELECT max(version) FROM schema_migrations')"
if [ -n "$(exp beats_total)" ]; then
  chk beats_total "$(exp beats_total)" "$(got 'SELECT count(*) FROM catalog_beats')"
  chk beats_active "$(exp beats_active)" "$(got "SELECT count(*) FROM catalog_beats WHERE state='ACTIVE'")"
  chk file_versions "$(exp file_versions)" "$(got 'SELECT count(*) FROM catalog_file_versions')"
  chk row_checksum "$(exp row_checksum)" "$(got "SELECT md5(string_agg(beat_id || ':' || version::text || ':' || coalesce(name_search, ''), ',' ORDER BY beat_id COLLATE \"C\")) FROM catalog_beats")"
else
  # Backups taken before native catalog activation contain users/vaults/legacy
  # tables, not catalog_beats. Never fabricate an empty native catalog.
  chk users "$(exp users)" "$(got 'SELECT count(*) FROM users')"
  chk vaults "$(exp vaults)" "$(got 'SELECT count(*) FROM vaults')"
  chk legacy_beats "$(exp legacy_beats)" "$(got 'SELECT count(*) FROM library_beats')"
fi
[ "$fail" = 0 ] || { echo "restore NO verificado: la base $TARGET_DB queda aislada para inspección; no la uses" >&2; exit 6; }
psql -X -q -At -d "$TARGET_DB" -c "ANALYZE" >/dev/null
echo "restore verificado id=$ID base=$TARGET_DB"
if [ -n "${DATABASE_URL_ADOPT:-}" ]; then
  node "$(dirname "$0")/adopt-restored.cjs" "$ID" "$(sha256sum "$WORK/$ID.manifest.json" | cut -d' ' -f1)" && echo "postura HELD aplicada (adopt-restored)"
else echo "SIGUIENTE PASO OBLIGATORIO: node scripts/backup/adopt-restored.cjs $ID <manifest_sha256> con DATABASE_URL_ADOPT apuntando a $TARGET_DB (postura HELD, época+1) antes de abrirla al tráfico"; fi
