#!/usr/bin/env bash
# Simulacro G4 REAL de pg_dump/pg_restore sobre el clúster EFÍMERO del LAB (127.0.0.1:54339; NUNCA 5432/54329/producción/AWS).
# Backup cifrado → restore verificado en base nueva → fallos esperados (corrupción, frase errónea, destino existente, nombre inválido) → retención.
#   uso (WSL, root o postgres): LAB_DB=<base> bash scripts/backup/pg-drill.sh
set -uo pipefail
PORT="${LAB_PORT:-54339}"; [ "$PORT" != 5432 ] && [ "$PORT" != 54329 ] || { echo "puerto reservado" >&2; exit 2; }
export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=catalog_lab_admin
DB="${LAB_DB:?LAB_DB requerido}"; HERE="$(cd "$(dirname "$0")" && pwd)"
[ "$(psql -X -q -At -d catalog_lab_sentinel -c 'SELECT count(*) FROM catalog_lab.lab_identity' 2>/dev/null)" = 1 ] || { echo "STOP-ENV: no es el clúster del LAB (sin centinela)"; exit 4; }
D=/tmp/bg-catlab-backups-drill; rm -rf "$D"; mkdir -p "$D/store"; export BACKUP_TARGET="file://$D/store" BACKUP_SOURCE="file://$D/store"
head -c 48 /dev/urandom | base64 > "$D/pass"; chmod 600 "$D/pass"; export BACKUP_PASSPHRASE_FILE="$D/pass"
head -c 48 /dev/urandom | base64 > "$D/wrong"; chmod 600 "$D/wrong"
RES="${DB}_restore"; fail=0
ok() { echo "PASS $1"; }; ko() { echo "FAIL $1"; fail=1; }
t0=$(date +%s); BACKUP_DB="$DB" BACKUP_ID=bk-drill1 bash "$HERE/pg-backup.sh" && ok backup || ko backup; t1=$(date +%s)
ls -l "$D/store" | tail -3
BACKUP_PASSPHRASE_FILE="$D/pass" bash "$HERE/pg-restore.sh" bk-drill1 "$RES" && ok restore-verificado || ko restore-verificado; t2=$(date +%s)
echo "tiempos: backup=$((t1-t0))s restore=$((t2-t1))s"
echo "--- integridad extra: recuento de TODAS las tablas del catálogo origen vs restaurada"
for t in $(psql -X -q -At -d "$DB" -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1"); do
  a=$(psql -X -q -At -d "$DB" -c "SELECT count(*) FROM \"$t\""); b=$(psql -X -q -At -d "$RES" -c "SELECT count(*) FROM \"$t\""); [ "$a" = "$b" ] || { echo "tabla $t: origen=$a restaurada=$b"; fail=1; }; done; [ "$fail" = 0 ] && ok recuentos-todas-las-tablas
echo "--- fallos esperados"
cp "$D/store/bk-drill1.dump.enc" "$D/store/bk-drill1.dump.enc.good"; printf '\x00' | dd of="$D/store/bk-drill1.dump.enc" bs=1 seek=2000 conv=notrunc 2>/dev/null
bash "$HERE/pg-restore.sh" bk-drill1 "${DB}_restore_x1" >/dev/null 2>&1; [ $? = 3 ] && ok corrupcion-detectada-exit3 || ko corrupcion-detectada
mv "$D/store/bk-drill1.dump.enc.good" "$D/store/bk-drill1.dump.enc"
BACKUP_PASSPHRASE_FILE="$D/wrong" bash "$HERE/pg-restore.sh" bk-drill1 "${DB}_restore_x2" >/dev/null 2>&1; [ $? = 3 ] && ok frase-erronea-exit3 || ko frase-erronea
bash "$HERE/pg-restore.sh" bk-drill1 "$RES" >/dev/null 2>&1; [ $? = 4 ] && ok destino-existente-no-se-sobrescribe || ko destino-existente
bash "$HERE/pg-restore.sh" bk-drill1 "$DB" >/dev/null 2>&1; [ $? = 2 ] && ok nombre-sin-restore-rechazado || ko nombre-guardia
[ -z "$(psql -X -q -At -d postgres -c "SELECT datname FROM pg_database WHERE datname IN ('${DB}_restore_x1','${DB}_restore_x2')")" ] && ok sin-bases-parciales || ko bases-parciales
echo "--- retención (file://): KEEP_MIN=2, KEEP_DAYS=1"
for i in 1 2 3 4; do BACKUP_DB="$DB" BACKUP_ID="bk-20200101T00000${i}Z" bash "$HERE/pg-backup.sh" >/dev/null; touch -d '10 days ago' "$D/store/bk-20200101T00000${i}Z".*; done
BACKUP_DB="$DB" BACKUP_ID=bk-drill2 BACKUP_KEEP_MIN=2 BACKUP_KEEP_DAYS=1 bash "$HERE/pg-backup.sh" | grep -c retención
n=$(ls "$D/store"/*.manifest.json | wc -l); echo "manifiestos restantes: $n"; [ -f "$D/store/bk-drill2.manifest.json" ] && [ -f "$D/store/bk-drill1.manifest.json" -o "$n" -le 5 ] && ok retencion-conserva-recientes || ko retencion
echo "RESULT fail=$fail"; echo "BASE_RESTAURADA=$RES"; exit $fail
