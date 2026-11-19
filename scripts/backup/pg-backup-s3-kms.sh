#!/usr/bin/env bash
# Complete PostgreSQL backup to private SSE-KMS S3. Includes PRE-native and native
# databases. Credentials supplied ONLY by pg-runtime-env.py via process env.
set -euo pipefail
umask 077
DB="${BACKUP_DB:?BACKUP_DB required}"
TARGET="${BACKUP_TARGET:?BACKUP_TARGET required}"
KMS="${S3_SSE_KMS_KEY_ID:?S3_SSE_KMS_KEY_ID required}"
[[ "$TARGET" == s3://* ]] || { echo "STOP: S3 destination required" >&2; exit 2; }
ID="bk-$(date -u +%Y%m%dT%H%M%S)-$RANDOM"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
coproc SNAPSHOT_KEEPER { psql -X -qAt -v ON_ERROR_STOP=1 -d "$DB" 2>"$WORK/snapshot.log"; }
KEEP_PID="$SNAPSHOT_KEEPER_PID"
printf 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&"${SNAPSHOT_KEEPER[1]}"
IFS= read -r SNAP <&"${SNAPSHOT_KEEPER[0]}" || { echo "STOP: failed to export snapshot" >&2; exit 3; }
[[ "$SNAP" =~ ^[A-Za-z0-9-]+$ ]] || { echo "STOP: invalid snapshot" >&2; exit 3; }
pg_dump --snapshot="$SNAP" -Fc -Z 6 --no-owner --no-acl -d "$DB" -f "$WORK/$ID.dump"
pg_restore --list "$WORK/$ID.dump" >/dev/null
SHA="$(sha256sum "$WORK/$ID.dump" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$WORK/$ID.dump")"
psql -X -qAt -v ON_ERROR_STOP=1 -v snap="$SNAP" -v id="$ID" -v sha="$SHA" -v size="$SIZE" -d "$DB" -o "$WORK/$ID.manifest.json" <<'SQL'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snap';
SELECT json_build_object(
 'schema','beatgaler.s3-kms-backup/1',
 'backup_id', :'id', 'database',current_database(),
 'taken_at',to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
 'server_version',current_setting('server_version'),
 'dump',json_build_object('sha256', :'sha', 'bytes', (:'size')::bigint, 'format','pg_dump custom'),
 'encryption','SSE-KMS (AWS-managed at rest); TLS in transit',
 'coverage','PostgreSQL ONLY; NO Telegram media',
 'counts',json_build_object(
    'users',(SELECT count(*) FROM public.users),
    'vaults',(SELECT count(*) FROM public.vaults),
    'legacy_beats',(SELECT count(*) FROM public.library_beats),
    'schema_migrations',(SELECT count(*) FROM public.schema_migrations)
 ),
 'public_base_tables',(SELECT count(*) FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE')
);
COMMIT;
SQL
printf 'COMMIT;\n\\q\n' >&"${SNAPSHOT_KEEPER[1]}"
wait "$KEEP_PID"
(cd "$WORK"; sha256sum "$ID.manifest.json" > "$ID.manifest.json.sha256")
# Commit marker uploaded LAST. Never claim a backup without all 3 objects.
aws s3 cp --only-show-errors --sse aws:kms --sse-kms-key-id "$KMS" "$WORK/$ID.dump" "${TARGET%/}/$ID.dump"
aws s3 cp --only-show-errors --sse aws:kms --sse-kms-key-id "$KMS" "$WORK/$ID.manifest.json" "${TARGET%/}/$ID.manifest.json"
aws s3 cp --only-show-errors --sse aws:kms --sse-kms-key-id "$KMS" "$WORK/$ID.manifest.json.sha256" "${TARGET%/}/$ID.manifest.json.sha256"
echo "BACKUP_UPLOADED id=$ID sha256=$SHA bytes=$SIZE"
