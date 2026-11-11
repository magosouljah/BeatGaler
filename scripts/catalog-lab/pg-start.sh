#!/bin/bash
# LAB navegador (V09/V10): clúster PostgreSQL 18 EFÍMERO y PROPIO en WSL. Uso: pg-start.sh [PUERTO] [DIRECTORIO]
# Defecto: puerto 54339, datos en /tmp/bg-catlab-browser. Se niega a usar 5432/54329 (clústeres de otros) o rutas fuera de /tmp/bg-catlab-*.
# Ejecutar como root desde WSL (initdb se hace con `su postgres`). Nunca toca el clúster 18/main.
set -e
PORT="${1:-54339}"
D="${2:-/tmp/bg-catlab-browser}"
BIN=/usr/lib/postgresql/18/bin
case "$PORT" in 5432|54329) echo "puerto $PORT reservado: no usar"; exit 2;; esac
case "$D" in /tmp/bg-catlab-*) ;; *) echo "directorio fuera de /tmp/bg-catlab-*: $D"; exit 2;; esac
if [ -f "$D/data/postmaster.pid" ] && $BIN/pg_ctl -D "$D/data" status >/dev/null 2>&1; then echo "lab ya en marcha en $PORT"; exit 0; fi
rm -rf "$D"; mkdir -p "$D"; chown postgres:postgres "$D"
su postgres -c "$BIN/initdb -D $D/data -E UTF8 --locale=en_US.utf8 -U catalog_lab_admin --auth=trust" > "$D/initdb.log" 2>&1 \
  || su postgres -c "$BIN/initdb -D $D/data -E UTF8 --locale=C.UTF-8 -U catalog_lab_admin --auth=trust" > "$D/initdb.log" 2>&1
su postgres -c "$BIN/pg_ctl -D $D/data -o '-p $PORT -k $D -c listen_addresses=127.0.0.1 -c fsync=off' -l $D/pg.log start" >/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do
  if "$BIN/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; then break; fi
  sleep 1
done
PSQL="$BIN/psql -h 127.0.0.1 -p $PORT -U catalog_lab_admin"
$PSQL -d postgres -qc "CREATE DATABASE catalog_lab_sentinel"
$PSQL -d catalog_lab_sentinel -qc "CREATE SCHEMA catalog_lab" -qc "CREATE TABLE catalog_lab.lab_identity(instance_id text PRIMARY KEY)" -qc "INSERT INTO catalog_lab.lab_identity VALUES ('gha-0-0-00000000000000000000000000000000')"
$PSQL -d catalog_lab_sentinel -Atc "SELECT version()"
echo "lab PG listo en 127.0.0.1:$PORT ($D)"
