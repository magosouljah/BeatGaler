#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == --run-disposable && $# == 1 ]] || {
  echo 'usage: bash scripts/v1-local-pg-integration.sh --run-disposable' >&2
  exit 64
}
for command_name in runuser psql pg_isready openssl node; do
  command -v "$command_name" >/dev/null || { echo "Missing $command_name" >&2; exit 2; }
done
pg_isready -h 127.0.0.1 -p 5432 >/dev/null || { echo 'Local PostgreSQL is unavailable.' >&2; exit 2; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
suffix="$(openssl rand -hex 6)"
role="beatgaler_v1test_${suffix}"
base="beatgaler_v1_test_${suffix}"
password="$(openssl rand -hex 24)"
created_role=0
cleanup() {
  local result=$?
  if [[ "$created_role" == 1 ]]; then
    # A random role created by this process owns only its disposable databases.
    mapfile -t owned < <(runuser -u postgres -- psql -At -d postgres -c "SELECT datname FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='$role')")
    for database in "${owned[@]:-}"; do
      [[ -n "$database" ]] || continue
      printf 'DROP DATABASE :"db" WITH (FORCE);\n' | runuser -u postgres -- psql -v ON_ERROR_STOP=1 -v db="$database" -d postgres >/dev/null
    done
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d postgres -c "DROP ROLE \"$role\"" >/dev/null
  fi
  echo "V1_LOCAL_PG_INTEGRATION_CLEANUP result=$result roleRemoved=$created_role" >&2
}
trap cleanup EXIT

printf 'CREATE ROLE "%s" WITH LOGIN CREATEDB PASSWORD '\''%s'\'';\n' "$role" "$password" | runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d postgres >/dev/null
created_role=1
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE \"$base\" OWNER \"$role\"" >/dev/null
export DATABASE_URL="postgresql://$role:$password@127.0.0.1:5432/$base"
admin_url="postgresql://$role:$password@127.0.0.1:5432/postgres"
export BEATGALER_STEP1_TEST_ADMIN_URL="$admin_url"
export BEATGALER_STEP2_TEST_ADMIN_URL="$admin_url"
export BEATGALER_STEP3_TEST_ADMIN_URL="$admin_url"
export BILLING_CHECKOUT_TEST_ADMIN_URL="$admin_url"
export BILLING_LIFECYCLE_TEST_ADMIN_URL="$admin_url"
export BILLING_E2E_TEST_ADMIN_URL="$admin_url"
export BILLING_RECONCILIATION_TEST_ADMIN_URL="$admin_url"
export BILLING_MIGRATION_TEST_ADMIN_URL="$admin_url"
export BILLING_WEBHOOK_TEST_ADMIN_URL="$admin_url"

files=(
  cloud-server/tests/postgres-live.integration.cjs
  cloud-server/tests/postgres-cutover.integration.cjs
  cloud-server/tests/direct-capability-postgres.integration.cjs
  cloud-server/tests/direct-persistent-legacy-lazy.postgres.integration.cjs
  cloud-server/tests/direct-vault-assignment.postgres.integration.cjs
  cloud-server/tests/postgres-installation-claim-cross-process.integration.cjs
  cloud-server/tests/access-grant-ownership.integration.cjs
  cloud-server/tests/access-runtime-postgres.integration.cjs
  cloud-server/tests/library-beat-quota.integration.cjs
  cloud-server/tests/library-index-publication.integration.cjs
  cloud-server/tests/library-trash-purge.integration.cjs
  cloud-server/tests/project-access.integration.cjs
  cloud-server/tests/billing-v1-migrations.integration.cjs
  cloud-server/tests/billing-checkout-persistent.integration.cjs
  cloud-server/tests/billing-webhook-durable.integration.cjs
  cloud-server/tests/billing-lifecycle.integration.cjs
  cloud-server/tests/billing-reconciliation.integration.cjs
  cloud-server/tests/billing-polar-daily.integration.cjs
)
for file in "${files[@]}"; do
  echo "V1_LOCAL_PG_INTEGRATION_START file=$file"
  node --test "$file"
  echo "V1_LOCAL_PG_INTEGRATION_PASS file=$file"
done
source_kind=sha
source_ref="${V1_TEST_SOURCE_SHA:-}"
if [[ -z "$source_ref" && -n "${V1_TEST_SOURCE_TREE:-}" ]]; then
  source_kind=tree
  source_ref="$V1_TEST_SOURCE_TREE"
fi
if [[ -z "$source_ref" ]]; then source_ref="$(git rev-parse HEAD)"; fi
[[ "$source_ref" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid test source reference.' >&2; exit 2; }
echo "V1_LOCAL_PG_INTEGRATION_PASS files=${#files[@]} sourceKind=$source_kind sourceRef=$source_ref disposableRole=true"
