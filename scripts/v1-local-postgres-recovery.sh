#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--run-disposable" || "${2:-}" != "" ]]; then
  echo 'usage: bash scripts/v1-local-postgres-recovery.sh --run-disposable' >&2
  exit 64
fi
if [[ "$(id -u)" != 0 ]]; then
  echo 'This local peer-auth drill requires root to invoke runuser -u postgres.' >&2
  exit 65
fi
for cmd in runuser createdb dropdb pg_dump pg_restore psql openssl sha256sum git mktemp; do
  command -v "$cmd" >/dev/null || { echo "missing local drill command: $cmd" >&2; exit 66; }
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
nonce="$(openssl rand -hex 5)"
source_db="beatgaler_v1_source_${nonce}"
restore_db="beatgaler_v1_restore_${nonce}"
[[ "$source_db" =~ ^beatgaler_v1_source_[0-9a-f]{10}$ && "$restore_db" =~ ^beatgaler_v1_restore_[0-9a-f]{10}$ ]]
scratch="$(mktemp -d /tmp/beatgaler-v1-recovery.XXXXXXXX)"
source_created=0
restore_created=0
cleanup() {
  if [[ "$restore_created" == 1 ]]; then runuser -u postgres -- dropdb --if-exists "$restore_db" >/dev/null 2>&1 || true; fi
  if [[ "$source_created" == 1 ]]; then runuser -u postgres -- dropdb --if-exists "$source_db" >/dev/null 2>&1 || true; fi
  case "$(realpath -m -- "$scratch")" in
    /tmp/beatgaler-v1-recovery.*) rm -rf -- "$scratch" ;;
    *) echo 'Refusing to remove unexpected scratch path.' >&2 ;;
  esac
}
trap cleanup EXIT

runuser -u postgres -- pg_isready -h /var/run/postgresql -q
runuser -u postgres -- createdb --encoding=UTF8 --template=template0 "$source_db"
source_created=1
runuser -u postgres -- createdb --encoding=UTF8 --template=template0 "$restore_db"
restore_created=1

for migration in "$repo_root"/cloud-server/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "$source_db" -f "$migration" >/dev/null
  version="$(basename "$migration" | cut -c1-4)"
  checksum="$(sha256sum "$migration" | cut -d' ' -f1)"
  [[ "$version" =~ ^[0-9]{4}$ && "$checksum" =~ ^[0-9a-f]{64}$ ]]
  runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "$source_db" \
    -c "INSERT INTO schema_migrations(version,checksum_sha256) VALUES ('$version','$checksum')" >/dev/null
done
runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "$source_db" \
  -c "INSERT INTO users(id,username,created_at,updated_at) VALUES ('v1-restore-synthetic','v1-restore-synthetic',now(),now())" >/dev/null

started="$(date +%s)"
runuser -u postgres -- pg_dump --no-owner --no-privileges --format=custom -d "$source_db" > "$scratch/control-plane.dump"
plaintext_sha="$(sha256sum "$scratch/control-plane.dump" | cut -d' ' -f1)"
backup_key="$(openssl rand -hex 32)"
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$scratch/control-plane.dump" -out "$scratch/control-plane.dump.enc" -pass "pass:$backup_key"
rm -- "$scratch/control-plane.dump"
test ! -e "$scratch/control-plane.dump"
openssl enc -d -aes-256-cbc -pbkdf2 -in "$scratch/control-plane.dump.enc" -out "$scratch/restore.dump" -pass "pass:$backup_key"
unset backup_key
test "$(sha256sum "$scratch/restore.dump" | cut -d' ' -f1)" = "$plaintext_sha"
runuser -u postgres -- pg_restore --no-owner --no-privileges --exit-on-error -d "$restore_db" < "$scratch/restore.dump"
restore_seconds="$(( $(date +%s) - started ))"

source_counts="$(runuser -u postgres -- psql -X -At -d "$source_db" -c "SELECT (SELECT count(*) FROM schema_migrations),(SELECT count(*) FROM users),(SELECT count(*) FROM auth_sessions)")"
restore_counts="$(runuser -u postgres -- psql -X -At -d "$restore_db" -c "SELECT (SELECT count(*) FROM schema_migrations),(SELECT count(*) FROM users),(SELECT count(*) FROM auth_sessions)")"
test "$source_counts" = "$restore_counts"
test "$restore_counts" = "18|1|0"
test "$(runuser -u postgres -- psql -X -At -d "$restore_db" -c "SELECT count(*) FROM users WHERE id='v1-restore-synthetic'")" = 1
if runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "$restore_db" \
  -c "INSERT INTO auth_sessions(session_key_hash,user_id,created_at,expires_at) VALUES ('short','v1-restore-synthetic',now(),now()+interval '1 hour')" >/dev/null 2>&1; then
  echo 'Restored database failed to enforce auth session hash constraint.' >&2
  exit 1
fi

source_kind=sha
source_ref="${V1_TEST_SOURCE_SHA:-}"
if [[ -z "$source_ref" && -n "${V1_TEST_SOURCE_TREE:-}" ]]; then
  source_kind=tree
  source_ref="$V1_TEST_SOURCE_TREE"
fi
if [[ -z "$source_ref" ]]; then source_ref="$(git -C "$repo_root" rev-parse HEAD)"; fi
[[ "$source_ref" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid test source reference.' >&2; exit 2; }
printf '{"kind":"V1_LOCAL_POSTGRES_RECOVERY","result":"PASS","sourceKind":"%s","sourceRef":"%s","sourceDatabase":"disposable","restoreDatabase":"independent-disposable","migrationCount":18,"syntheticUsers":1,"encryptedBackup":true,"backupSha256":"%s","measuredRestoreSeconds":%s,"localSnapshotRpoSeconds":0,"productionPitrProven":false,"productionRpoRtoProven":false}\n' \
  "$source_kind" "$source_ref" "$plaintext_sha" "$restore_seconds"
