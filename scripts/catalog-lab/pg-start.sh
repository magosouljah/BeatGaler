#!/bin/bash
# LAB navegador (V09/V10): clúster PostgreSQL 18 EFÍMERO y PROPIO en WSL. Uso: pg-start.sh [PUERTO] [DIRECTORIO]
# Defecto: puerto 54339, datos en /tmp/bg-catlab-browser. Se niega a usar 5432/54329 (clústeres de otros) o rutas fuera de /tmp/bg-catlab-*.
# Ejecutar como root desde WSL (initdb y pg_ctl se hacen con `su postgres`). Nunca toca el clúster 18/main.
# Idempotente y seguro: NUNCA borra un directorio con un servidor en marcha; si el puerto lo ocupa algo no identificado, se detiene sin modificarlo.
# Códigos: 0 listo (nuevo o ya en marcha) · 2 argumentos inválidos · 3 puerto ocupado por instancia no identificada · 4 servidor del directorio en marcha pero no responde/identidad distinta (no se toca)
set -e
PORT="${1:-54339}"
D="${2:-/tmp/bg-catlab-browser}"
BIN=/usr/lib/postgresql/18/bin
case "$PORT" in 5432|54329) echo "puerto $PORT reservado: no usar"; exit 2;; esac
case "$PORT" in ''|*[!0-9]*) echo "puerto inválido: $PORT"; exit 2;; esac
case "$D" in /tmp/bg-catlab-*) ;; *) echo "directorio fuera de /tmp/bg-catlab-*: $D"; exit 2;; esac
case "$D" in *..*|*' '*|*"'"*) echo "directorio no permitido: $D"; exit 2;; esac

PSQL="$BIN/psql -h 127.0.0.1 -p $PORT -U catalog_lab_admin"
# Estado del servidor del directorio, SIEMPRE como usuario postgres (pg_ctl rehúsa/engaña como root).
pg_running() { [ -f "$D/data/postmaster.pid" ] && su postgres -c "$BIN/pg_ctl -D $D/data status" >/dev/null 2>&1; }
port_busy() { "$BIN/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 || (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }
is_ours() { [ "$($PSQL -d catalog_lab_sentinel -Atc "SELECT instance_id FROM catalog_lab.lab_identity" 2>/dev/null)" = "gha-0-0-00000000000000000000000000000000" ]; }
wait_ready() { for i in $(seq 1 20); do "$BIN/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

if pg_running; then
  # Servidor propio en marcha: jamás se borra. Verifica que es el LAB (puerto + identidad) y sale.
  wait_ready || { echo "servidor de $D en marcha pero no responde en 127.0.0.1:$PORT: no se toca"; exit 4; }
  is_ours || { echo "servidor de $D responde en $PORT pero sin la identidad del LAB: no se toca"; exit 4; }
  echo "lab ya en marcha en 127.0.0.1:$PORT ($D)"; exit 0
fi
if port_busy; then
  echo "puerto $PORT ocupado por una instancia no identificada (no es el servidor de $D): no se modifica nada"; exit 3
fi
# Aquí: ningún servidor propio en marcha y el puerto libre. Un directorio sobrante es residuo y es seguro recrearlo.
if [ -f "$D/data/postmaster.pid" ]; then echo "postmaster.pid obsoleto en $D (servidor no activo): se recrea"; fi
rm -rf "$D"; mkdir -p "$D"; chown postgres:postgres "$D"
su postgres -c "$BIN/initdb -D $D/data -E UTF8 --locale=en_US.utf8 -U catalog_lab_admin --auth=trust" > "$D/initdb.log" 2>&1 \
  || { rm -rf "$D/data"; su postgres -c "$BIN/initdb -D $D/data -E UTF8 --locale=C.UTF-8 -U catalog_lab_admin --auth=trust" > "$D/initdb.log" 2>&1; }
su postgres -c "$BIN/pg_ctl -D $D/data -o '-p $PORT -k $D -c listen_addresses=127.0.0.1 -c fsync=off' -l $D/pg.log start" >/dev/null
wait_ready || { echo "el servidor no respondió en $PORT; ver $D/pg.log (no se borra nada)"; exit 4; }
$PSQL -d postgres -qc "CREATE DATABASE catalog_lab_sentinel"
$PSQL -d catalog_lab_sentinel -qc "CREATE SCHEMA catalog_lab" -qc "CREATE TABLE catalog_lab.lab_identity(instance_id text PRIMARY KEY)" -qc "INSERT INTO catalog_lab.lab_identity VALUES ('gha-0-0-00000000000000000000000000000000')"
$PSQL -d catalog_lab_sentinel -Atc "SELECT version()"
echo "lab PG listo en 127.0.0.1:$PORT ($D)"
