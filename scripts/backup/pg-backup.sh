#!/usr/bin/env bash
# Backup físico del CATÁLOGO PostgreSQL de BeatGaler: pg_dump -Fc + SHA-256 + manifiesto + cifrado AES-256 (openssl, PBKDF2) + subida.
# Respalda SOLO la base PostgreSQL (metadatos, estado, índices del catálogo). NO respalda los bytes de audio/portadas/proyectos: esos viven en Telegram
# y necesitan su propia estrategia de copia (ver deploy/backup/README.md).
# Destino: file:///ruta (pruebas/laboratorio) o s3://bucket/prefijo (producción; requiere `aws` y credenciales del ENTORNO, nunca en este archivo).
# Conexión: variables libpq estándar (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSFILE). Nada de contraseñas en argumentos ni en logs.
#   BACKUP_DB               base a respaldar (por defecto $PGDATABASE)
#   BACKUP_TARGET           file:///dir | s3://bucket/prefix
#   BACKUP_PASSPHRASE_FILE  archivo con la frase de cifrado (permisos 600; la custodia de la clave es del propietario, aparte del bucket)
#   BACKUP_ID               por defecto bk-<UTC>
#   BACKUP_KEEP_DAYS / BACKUP_KEEP_MIN   retención SOLO para file:// (en S3 la retención la hace el lifecycle del bucket)
#   S3_SSE_KMS_KEY_ID       (S3) clave KMS para SSE-KMS; sin ella usa la clave KMS gestionada por AWS
set -euo pipefail
umask 077
DB="${BACKUP_DB:-${PGDATABASE:-}}"; [ -n "$DB" ] || { echo "BACKUP_DB/PGDATABASE requerido" >&2; exit 2; }
TARGET="${BACKUP_TARGET:-}"; [ -n "$TARGET" ] || { echo "BACKUP_TARGET requerido" >&2; exit 2; }
PASSFILE="${BACKUP_PASSPHRASE_FILE:-}"; [ -r "$PASSFILE" ] || { echo "BACKUP_PASSPHRASE_FILE ilegible" >&2; exit 2; }
[ "$(stat -c %a "$PASSFILE" 2>/dev/null || echo 600)" -le 600 ] || { echo "BACKUP_PASSPHRASE_FILE debe tener permisos 600" >&2; exit 2; }
ID="${BACKUP_ID:-bk-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$ID" =~ ^bk-[A-Za-z0-9_-]{1,60}$ ]] || { echo "BACKUP_ID inválido" >&2; exit 2; }
KEEP_DAYS="${BACKUP_KEEP_DAYS:-35}"; KEEP_MIN="${BACKUP_KEEP_MIN:-3}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
psqlq() { psql -X -q -At -d "$DB" "$@"; }
# Pre-activation databases still have the legacy control plane. Back up every table
# via pg_dump, but never query catalog_* tables that do not yet exist.
HAS_NATIVE="$(psqlq -c "SELECT to_regclass('public.catalog_libraries') IS NOT NULL")"

put() { # put <archivo local> <nombre remoto>
  case "$TARGET" in
    file://*) mkdir -p "${TARGET#file://}"; cp "$1" "${TARGET#file://}/$2" ;;
    s3://*) local args=(--only-show-errors --sse aws:kms); [ -n "${S3_SSE_KMS_KEY_ID:-}" ] && args+=(--sse-kms-key-id "$S3_SSE_KMS_KEY_ID")
            aws s3 cp "${args[@]}" "$1" "${TARGET%/}/$2" ;;
    *) echo "BACKUP_TARGET no soportado: $TARGET" >&2; exit 2 ;;
  esac
}

# 1) Un mismo snapshot MVCC para pg_dump y el manifiesto.
# Sin esto, una escritura concurrente entre pg_dump y el SELECT de recuentos
# provocaría un manifiesto válido para otro estado (restore falsamente corrupto).
# Mantener abierta la transacción exportadora hasta terminar ambas lecturas.
coproc SNAPSHOT_KEEPER { psql -X -qAt -v ON_ERROR_STOP=1 -d "$DB" 2>"$WORK/snapshot-keeper.log"; }
SNAPSHOT_KEEPER_PID_SAVED="$SNAPSHOT_KEEPER_PID"
printf 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&"${SNAPSHOT_KEEPER[1]}"
IFS= read -r SNAPSHOT_ID <&"${SNAPSHOT_KEEPER[0]}" || { echo "No se pudo obtener snapshot MVCC" >&2; exit 3; }
[[ "$SNAPSHOT_ID" =~ ^[A-Za-z0-9-]+$ ]] || { echo "Snapshot MVCC inválido" >&2; exit 3; }
pg_dump --snapshot="$SNAPSHOT_ID" -Fc -Z 6 --no-owner --no-acl -d "$DB" -f "$WORK/$ID.dump"
PLAIN_SHA="$(sha256sum "$WORK/$ID.dump" | cut -d' ' -f1)"; PLAIN_BYTES="$(stat -c %s "$WORK/$ID.dump")"
pg_restore --list "$WORK/$ID.dump" > /dev/null   # el volcado debe ser legible

# 2) cifrado (AES-256-CBC, PBKDF2 600k, sal aleatoria) + hash del cifrado
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$PASSFILE" -in "$WORK/$ID.dump" -out "$WORK/$ID.dump.enc"
ENC_SHA="$(sha256sum "$WORK/$ID.dump.enc" | cut -d' ' -f1)"; ENC_BYTES="$(stat -c %s "$WORK/$ID.dump.enc")"

# 3) manifiesto (sin datos personales: versiones, hashes y recuentos del catálogo para verificar el restore)
if [[ "$HAS_NATIVE" == "t" ]]; then
psqlq -v ON_ERROR_STOP=1 -v snap="$SNAPSHOT_ID" -v id="$ID" -v psha="$PLAIN_SHA" -v pbytes="$PLAIN_BYTES" -v esha="$ENC_SHA" -v ebytes="$ENC_BYTES" -o "$WORK/$ID.manifest.json" <<'SQL'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snap';
SELECT json_build_object(
  'schema', 'beatgaler.pg-backup/1', 'backup_id', :'id', 'taken_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'server_version', current_setting('server_version'), 'database', current_database(),
  'coverage', 'POSTGRES_ONLY: Telegram media bytes are NOT in this backup',
  'dump', json_build_object('format', 'custom', 'sha256', :'psha', 'bytes', (:'pbytes')::bigint),
  'encrypted', json_build_object('cipher', 'aes-256-cbc/pbkdf2-600000', 'sha256', :'esha', 'bytes', (:'ebytes')::bigint),
  'migrations', (SELECT json_build_object('count', count(*), 'last', max(version), 'checksum_sha256', encode(sha256(convert_to(string_agg(version || ':' || checksum_sha256, ',' ORDER BY version), 'UTF8')), 'hex')) FROM schema_migrations),
  'native_activation', EXISTS (SELECT 1 FROM catalog_native_activation),
  'counts', json_build_object(
    'catalog_libraries', (SELECT count(*) FROM catalog_libraries),
    'beats_active', (SELECT count(*) FROM catalog_beats WHERE state = 'ACTIVE'),
    'beats_trash', (SELECT count(*) FROM catalog_beats WHERE state = 'TRASH'),
    'beats_total', (SELECT count(*) FROM catalog_beats),
    'file_versions', (SELECT count(*) FROM catalog_file_versions),
    'tombstones', (SELECT count(*) FROM catalog_tombstones),
    'row_checksum', (SELECT md5(string_agg(beat_id || ':' || version::text || ':' || coalesce(name_search, ''), ',' ORDER BY beat_id COLLATE "C")) FROM catalog_beats))
);
COMMIT;
SQL
else
  # Pre-native manifest: source counts from the EXACT pg_dump snapshot.
  psqlq -v ON_ERROR_STOP=1 -v snap="$SNAPSHOT_ID" -v id="$ID" -v psha="$PLAIN_SHA" -v pbytes="$PLAIN_BYTES" -v esha="$ENC_SHA" -v ebytes="$ENC_BYTES" -o "$WORK/$ID.manifest.json" <<'SQL'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snap';
SELECT json_build_object(
  'schema', 'beatgaler.pg-backup/1', 'backup_id', :'id',
  'taken_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'server_version', current_setting('server_version'), 'database', current_database(),
  'coverage', 'POSTGRES_ONLY: Telegram media bytes are NOT in this backup',
  'dump', json_build_object('format', 'custom', 'sha256', :'psha', 'bytes', (:'pbytes')::bigint),
  'encrypted', json_build_object('cipher', 'aes-256-cbc/pbkdf2-600000', 'sha256', :'esha', 'bytes', (:'ebytes')::bigint),
  'migrations', json_build_object('count', (SELECT count(*) FROM schema_migrations),
                                   'last', (SELECT max(version) FROM schema_migrations)),
  'native_activation', false,
  'counts', json_build_object(
     'users', (SELECT count(*) FROM users),
     'vaults', (SELECT count(*) FROM vaults),
     'legacy_beats', (SELECT count(*) FROM library_beats))
);
COMMIT;
SQL
fi
# Liberar el snapshot solo después de completar el manifiesto sobre el MISMO estado.
printf 'COMMIT;\n\\q\n' >&"${SNAPSHOT_KEEPER[1]}"
wait "$SNAPSHOT_KEEPER_PID_SAVED"
MSHA="$(sha256sum "$WORK/$ID.manifest.json" | cut -d' ' -f1)"; echo "$MSHA  $ID.manifest.json" > "$WORK/$ID.manifest.json.sha256"

# 4) subida: primero el cifrado, después el manifiesto (marca de commit: sin manifiesto el backup no existe)
put "$WORK/$ID.dump.enc" "$ID.dump.enc"; put "$WORK/$ID.manifest.json" "$ID.manifest.json"; put "$WORK/$ID.manifest.json.sha256" "$ID.manifest.json.sha256"

# 5) retención local (solo file://): borra backups completos con más de KEEP_DAYS conservando siempre los KEEP_MIN más recientes
if [[ "$TARGET" == file://* ]]; then
  dir="${TARGET#file://}"; mapfile -t ids < <(ls -1 "$dir" | sed -n 's/^\(bk-[A-Za-z0-9_-]*\)\.manifest\.json$/\1/p' | sort -r)
  i=0; for old in "${ids[@]}"; do i=$((i+1)); [ "$i" -le "$KEEP_MIN" ] && continue
    if [ -n "$(find "$dir/$old.manifest.json" -mtime +"$KEEP_DAYS" 2>/dev/null)" ]; then rm -f "$dir/$old.dump.enc" "$dir/$old.manifest.json" "$dir/$old.manifest.json.sha256"; echo "retención: eliminado $old"; fi; done
fi
echo "backup OK id=$ID bytes=$ENC_BYTES sha256=$ENC_SHA mode=$([[ "$HAS_NATIVE" == "t" ]] && echo native || echo pre-native)"
