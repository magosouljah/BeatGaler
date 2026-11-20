#!/usr/bin/env bash
# Validates a complete SSE-KMS S3 PostgreSQL backup by restoring into a NEW
# isolated database. NEVER replaces the active database or opens to traffic.
set -euo pipefail
umask 077
ID="${1:-}"; RESTORE_DB="${2:-}"
[[ "$ID" =~ ^bk-[A-Za-z0-9_-]+$ ]] || exit 2
[[ "$RESTORE_DB" =~ ^beatgaler_restore_[a-z0-9_]+$ ]] || { echo "STOP: restore-only database name required"; exit 2; }
[[ "$RESTORE_DB" != "${BACKUP_DB:-}" ]] || exit 2
TARGET="${BACKUP_SOURCE:-${BACKUP_TARGET:?BACKUP_TARGET required}}"
[[ "$TARGET" == s3://* ]] || exit 2
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
for suffix in manifest.json manifest.json.sha256 dump; do
 aws s3 cp --only-show-errors "${TARGET%/}/$ID.$suffix" "$WORK/$ID.$suffix"
done
(cd "$WORK"; sha256sum -c "$ID.manifest.json.sha256" >/dev/null)
read -r EXPECT_SHA EXPECT_USERS EXPECT_VAULTS EXPECT_BEATS EXPECT_MIGRATIONS EXPECT_TABLES < <(
 python3 - "$WORK/$ID.manifest.json" <<'PY'
import json,sys
j=json.load(open(sys.argv[1]))
if j.get('schema')!='beatgaler.s3-kms-backup/1':
 raise SystemExit('unsupported manifest')
c=j['counts']
print(j['dump']['sha256'], c['users'], c['vaults'],
      c['legacy_beats'], c['schema_migrations'], j['public_base_tables'])
PY
)
[[ "$(sha256sum "$WORK/$ID.dump" | cut -d' ' -f1)" == "$EXPECT_SHA" ]] || { echo "STOP: backup hash mismatch"; exit 3; }
pg_restore --list "$WORK/$ID.dump" >/dev/null
if psql -X -qAt -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$RESTORE_DB'" | grep -qx 1; then
 echo "STOP: restore database already exists" >&2
 exit 4
fi
createdb --maintenance-db=postgres "$RESTORE_DB"
pg_restore --no-owner --no-acl --exit-on-error -d "$RESTORE_DB" "$WORK/$ID.dump" ||
 { echo "RESTORE FAILED: isolated database left for review" >&2; exit 5; }
read -r USERS VAULTS BEATS MIGRATIONS TABLES < <(
 psql -X -qAt -F ' ' -d "$RESTORE_DB" -c "SELECT
 (SELECT count(*) FROM public.users),
 (SELECT count(*) FROM public.vaults),
 (SELECT count(*) FROM public.library_beats),
 (SELECT count(*) FROM public.schema_migrations),
 (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE');"
)
[[ "$USERS" == "$EXPECT_USERS" && "$VAULTS" == "$EXPECT_VAULTS" &&
   "$BEATS" == "$EXPECT_BEATS" && "$MIGRATIONS" == "$EXPECT_MIGRATIONS" &&
   "$TABLES" == "$EXPECT_TABLES" ]] ||
 { echo "RESTORE COUNTS MISMATCH; isolated database left for review" >&2; exit 6; }
# Native-catalog backups must prove catalog recovery too, not just the legacy
# control plane. Absence of catalog_counts is supported for pre-native backups.
EXPECTED_NATIVE="$(python3 - "$WORK/$ID.manifest.json" <<'PY'
import json,sys
counts=json.load(open(sys.argv[1])).get('catalog_counts')
if counts is not None:
    keys=('catalog_libraries','catalog_beats','catalog_beats_active','catalog_file_versions','catalog_media_objects')
    print(' '.join(str(int(counts[k])) for k in keys))
PY
)"
if [[ -n "$EXPECTED_NATIVE" ]]; then
  read -r E_LIBS E_CBEATS E_ACTIVE E_FILES E_MEDIA <<< "$EXPECTED_NATIVE"
  ACTUAL_NATIVE="$(psql -X -qAt -F ' ' -d "$RESTORE_DB" -c "SELECT
   (SELECT count(*) FROM public.catalog_libraries),
   (SELECT count(*) FROM public.catalog_beats),
   (SELECT count(*) FROM public.catalog_beats WHERE state='ACTIVE'),
   (SELECT count(*) FROM public.catalog_file_versions),
   (SELECT count(*) FROM public.catalog_media_objects);")"
  read -r A_LIBS A_CBEATS A_ACTIVE A_FILES A_MEDIA <<< "$ACTUAL_NATIVE"
  [[ "$E_LIBS" == "$A_LIBS" && "$E_CBEATS" == "$A_CBEATS" &&
     "$E_ACTIVE" == "$A_ACTIVE" && "$E_FILES" == "$A_FILES" &&
     "$E_MEDIA" == "$A_MEDIA" ]] ||
    { echo "RESTORE NATIVE CATALOG COUNTS MISMATCH; isolated database retained" >&2; exit 7; }
  echo "RESTORE_NATIVE_CATALOG_VERIFIED libraries=$A_LIBS beats=$A_CBEATS active=$A_ACTIVE files=$A_FILES media=$A_MEDIA"
fi
echo "RESTORE_VERIFIED id=$ID database=$RESTORE_DB users=$USERS vaults=$VAULTS legacy_beats=$BEATS migrations=$MIGRATIONS tables=$TABLES"
echo "ISOLATED_ONLY: do not point production to this database"
